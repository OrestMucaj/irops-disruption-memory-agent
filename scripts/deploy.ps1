<#
.SYNOPSIS
    Deploys the agent to AWS Lambda (Function URL) and the frontend to S3.

.DESCRIPTION
    Committed per SPEC.md §7, which wants setup instructions that actually work
    from zero rather than a description of what someone once clicked.

    ARCHITECTURE, and why (SPEC §3, NOTES.md §6.5):

      Lambda **Function URL**, not API Gateway and not an ALB. A Function URL
      has no hourly charge and costs nothing while idle. The demo has to stay
      live from Aug 19 to Sep 15 on no budget; an ALB alone would be $30-50 for
      that window.

      S3 static website hosting for the frontend. Cents.

      No VPC. CockroachDB Cloud is reachable over the public internet, and
      putting the Lambda in a VPC would require a NAT gateway to reach Bedrock
      -- about $32/month, for no benefit here.

    SECRETS (SPEC §1.3): DATABASE_URL and the Bedrock model IDs are passed as
    Lambda environment variables, read from .env at deploy time. They are never
    echoed to the console and never committed. AWS Secrets Manager would be the
    stronger choice for a production system and is the documented upgrade path
    in the README; for a single-function demo, Lambda environment variables
    encrypted at rest with the default AWS-managed key are proportionate.

    The Lambda's AWS credentials come from its **execution role**, never from
    static keys. AWS_ACCESS_KEY_ID is deliberately not sent.

.PARAMETER RoleArn
    ARN of the Lambda execution role. Create it once in the console -- see
    README "Deploying". Deliberately not created here so that the deploying IAM
    user never needs iam:CreateRole.

.PARAMETER BucketName
    S3 bucket for the frontend. Must be globally unique across all of AWS.

.PARAMETER CodeOnly
    Skip bucket/function creation and only push new code. Fast redeploys.

.NOTES
    Windows blocks unsigned scripts by default. If you see "running scripts is
    disabled on this system", invoke it as:

        powershell -ExecutionPolicy Bypass -File ".\scripts\deploy.ps1" -RoleArn ... -BucketName ...
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RoleArn,
    [Parameter(Mandatory = $true)][string]$BucketName,
    [string]$FunctionName = 'irops-memory-agent',
    [string]$Region = 'us-east-1',
    [switch]$CodeOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

function Require-Command($name, $hint) {
    if ($null -eq (Get-Command $name -ErrorAction SilentlyContinue)) {
        throw "$name not found. $hint"
    }
}

Require-Command 'aws' 'Install it with: winget install Amazon.AWSCLI (then open a new terminal).'
Require-Command 'npm' 'Install Node.js 20+.'

# --- Read .env without printing anything ------------------------------------
$envPath = Join-Path $repoRoot '.env'
if (-not (Test-Path $envPath)) { throw ".env not found. Copy .env.example and fill it in." }

$settings = @{}
foreach ($line in Get-Content $envPath) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $parts = $line -split '=', 2
    $settings[$parts[0].Trim()] = $parts[1].Trim()
}

foreach ($required in @('DATABASE_URL', 'BEDROCK_EMBEDDING_MODEL_ID', 'BEDROCK_LLM_MODEL_ID')) {
    if ([string]::IsNullOrWhiteSpace($settings[$required])) {
        throw "$required is not set in .env"
    }
}
if ($settings['DATABASE_URL'] -like '*PASTE_PASSWORD_HERE*') {
    throw 'DATABASE_URL still contains the placeholder password.'
}

Write-Host "function : $FunctionName"
Write-Host "bucket   : $BucketName"
Write-Host "region   : $Region"
Write-Host "role     : $RoleArn"

# --- Build and package -------------------------------------------------------
Write-Host "`n== building =="
Push-Location $repoRoot
try { & npm run build } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'build failed' }

$stage = Join-Path ([System.IO.Path]::GetTempPath()) "irops-deploy-$(Get-Random)"
$zipPath = "$stage.zip"
New-Item -ItemType Directory -Force $stage | Out-Null

Write-Host "== packaging =="
Copy-Item -Recurse (Join-Path $repoRoot 'dist') (Join-Path $stage 'dist')
Copy-Item (Join-Path $repoRoot 'package.json') $stage

# Dependencies are bundled rather than relying on the runtime's built-in SDK.
# The Node.js runtime ships some AWS SDK v3 clients, but not necessarily
# bedrock-runtime, and discovering that at invocation time would be a bad way to
# find out. pg and zod are not in the runtime at all.
Copy-Item -Recurse (Join-Path $repoRoot 'node_modules') (Join-Path $stage 'node_modules')

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipPath -CompressionLevel Optimal
$zipMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
Write-Host "   package: $zipMb MB"
if ($zipMb -gt 50) {
    throw "Package is ${zipMb}MB, over Lambda's 50MB direct-upload limit. Upload via S3 instead."
}

# --- Lambda ------------------------------------------------------------------
Write-Host "`n== lambda =="
$exists = $true
try { aws lambda get-function --function-name $FunctionName --region $Region 2>$null | Out-Null }
catch { $exists = $false }
if ($LASTEXITCODE -ne 0) { $exists = $false }

# Assembled as an object and converted, so no secret is ever interpolated into
# a command line (where it would land in shell history and process listings).
$envVars = @{
    Variables = @{
        DATABASE_URL               = $settings['DATABASE_URL']
        EMBEDDING_PROVIDER         = 'bedrock'
        LLM_PROVIDER               = 'bedrock'
        AWS_REGION_OVERRIDE        = $Region
        BEDROCK_EMBEDDING_MODEL_ID = $settings['BEDROCK_EMBEDDING_MODEL_ID']
        BEDROCK_LLM_MODEL_ID       = $settings['BEDROCK_LLM_MODEL_ID']
        EMBEDDING_DIMENSIONS       = if ($settings['EMBEDDING_DIMENSIONS']) { $settings['EMBEDDING_DIMENSIONS'] } else { '1024' }
        RETRIEVAL_TOP_K            = if ($settings['RETRIEVAL_TOP_K']) { $settings['RETRIEVAL_TOP_K'] } else { '5' }
        MAX_MODEL_CALLS_PER_CASE   = if ($settings['MAX_MODEL_CALLS_PER_CASE']) { $settings['MAX_MODEL_CALLS_PER_CASE'] } else { '3' }
        DB_TIMEOUT_MS              = if ($settings['DB_TIMEOUT_MS']) { $settings['DB_TIMEOUT_MS'] } else { '5000' }
        MODEL_TIMEOUT_MS           = if ($settings['MODEL_TIMEOUT_MS']) { $settings['MODEL_TIMEOUT_MS'] } else { '30000' }
        LOG_LEVEL                  = 'info'
    }
}
$envFile = Join-Path ([System.IO.Path]::GetTempPath()) "irops-env-$(Get-Random).json"
# WriteAllText, NOT Set-Content -Encoding utf8. In Windows PowerShell 5.1 the
# latter emits a UTF-8 BOM, and the AWS CLI cannot parse JSON that starts with
# one -- it fails with "Expected: '=', received: '<BOM>'". .NET's WriteAllText
# defaults to UTF-8 without a BOM.
[System.IO.File]::WriteAllText($envFile, ($envVars | ConvertTo-Json -Depth 4 -Compress))

# The AWS CLI echoes the offending payload when it cannot parse a --cli-input
# or file:// argument. That payload contains DATABASE_URL. Everything below
# routes aws output through this, so a malformed request can never leak the
# connection string to a console, a CI log, or a terminal scrollback.
function Invoke-AwsRedacted {
    param([string[]]$Arguments, [string]$What)
    # EAP must be Continue across the call. Windows PowerShell 5.1 wraps every
    # stderr line from a native executable in an ErrorRecord when redirected,
    # and under ErrorActionPreference=Stop that throws before $LASTEXITCODE can
    # be inspected -- turning a clean, redacted error into a NativeCommandError.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & aws @Arguments 2>&1 | Out-String
        $exit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
    }
    if ($exit -ne 0) {
        $safe = $output -replace 'postgresql://[^"\s]*', 'postgresql://<redacted>'
        throw "$What failed (exit $exit):`n$safe"
    }
    return $output
}

<#
    Runs an aws command whose failure is acceptable (already-exists cases).
    Same stderr-wrapping caveat as above.
#>
function Invoke-AwsTolerant {
    param([string[]]$Arguments)
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & aws @Arguments 2>&1 | Out-Null } finally { $ErrorActionPreference = $prevEap }
}

try {
    if (-not $exists) {
        if ($CodeOnly) { throw "Function $FunctionName does not exist; run without -CodeOnly first." }
        Write-Host "   creating function"
        Invoke-AwsRedacted -What 'create-function' -Arguments @(
            'lambda', 'create-function',
            '--function-name', $FunctionName,
            '--runtime', 'nodejs22.x',
            '--role', $RoleArn,
            '--handler', 'dist/api/lambda.handler',
            '--zip-file', "fileb://$zipPath",
            '--timeout', '60',
            '--memory-size', '512',
            '--environment', "file://$envFile",
            '--region', $Region
        ) | Out-Null

        Write-Host "   waiting for it to become active"
        aws lambda wait function-active-v2 --function-name $FunctionName --region $Region
    }
    else {
        Write-Host "   updating code"
        Invoke-AwsRedacted -What 'update-function-code' -Arguments @(
            'lambda', 'update-function-code',
            '--function-name', $FunctionName,
            '--zip-file', "fileb://$zipPath",
            '--region', $Region
        ) | Out-Null
        aws lambda wait function-updated-v2 --function-name $FunctionName --region $Region

        if (-not $CodeOnly) {
            Write-Host "   updating configuration"
            Invoke-AwsRedacted -What 'update-function-configuration' -Arguments @(
                'lambda', 'update-function-configuration',
                '--function-name', $FunctionName,
                '--handler', 'dist/api/lambda.handler',
                '--timeout', '60',
                '--memory-size', '512',
                '--environment', "file://$envFile",
                '--region', $Region
            ) | Out-Null
            aws lambda wait function-updated-v2 --function-name $FunctionName --region $Region
        }
    }
}
finally {
    Remove-Item $envFile -Force -ErrorAction SilentlyContinue
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
}

# --- Function URL ------------------------------------------------------------
$functionUrl = $null
try { $functionUrl = (aws lambda get-function-url-config --function-name $FunctionName --region $Region --query FunctionUrl --output text 2>$null) } catch { }

if ([string]::IsNullOrWhiteSpace($functionUrl) -or $functionUrl -eq 'None') {
    Write-Host "   creating function URL"
    # AuthType NONE: judges must be able to use the demo without credentials
    # (SPEC §7). The URL is shared only in the judge-only 'Additional Info'
    # submission field, per the organisers' guidance (NOTES.md §6.1).
    #
    # AllowMethods deliberately omits OPTIONS. Function URLs answer preflight
    # themselves, and each member is capped at 6 characters -- "OPTIONS" is 7
    # and is rejected with a confusing length-constraint error.
    $functionUrl = (aws lambda create-function-url-config `
        --function-name $FunctionName `
        --auth-type NONE `
        --cors 'AllowOrigins=*,AllowMethods=GET,POST,AllowHeaders=content-type' `
        --region $Region --query FunctionUrl --output text)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($functionUrl)) {
        throw 'create-function-url-config failed'
    }

}

# Ensured on EVERY run, not only when the URL is created.
#
# A Function URL and permission to invoke it are two separate things: the URL
# can exist and still answer 403 because the resource policy is incomplete.
#
# TWO statements are required, and this is the part that is easy to get wrong.
# Per the AWS docs: "Starting in October 2025, new function URLs will require
# both lambda:InvokeFunctionUrl and lambda:InvokeFunction permissions", and
# "If a function's resource-based policy doesn't grant lambda:invokeFunctionUrl
# and lambda:InvokeFunction permissions, users get a 403 Forbidden error code
# ... This occurs even if the function URL uses the NONE auth type."
#
# Nearly every tutorial and older example shows only the first. A policy with
# just InvokeFunctionUrl looks completely correct -- Effect Allow, Principal *,
# right condition -- and still returns 403, with nothing anywhere saying which
# half is missing.
#
# The console and AWS SAM add both for you. The CLI does not.
#
# Tolerant: on a re-run the statements already exist, which is not an error.
Invoke-AwsTolerant @(
    'lambda', 'add-permission',
    '--function-name', $FunctionName,
    '--statement-id', 'FunctionURLAllowPublicAccess',
    '--action', 'lambda:InvokeFunctionUrl',
    '--principal', '*',
    '--function-url-auth-type', 'NONE',
    '--region', $Region
)
Invoke-AwsTolerant @(
    'lambda', 'add-permission',
    '--function-name', $FunctionName,
    '--statement-id', 'UrlPolicyInvokeFunction',
    '--action', 'lambda:InvokeFunction',
    '--principal', '*',
    '--invoked-via-function-url',
    '--region', $Region
)

if ([string]::IsNullOrWhiteSpace($functionUrl) -or $functionUrl -eq 'None') {
    throw 'could not determine the function URL'
}
$functionUrl = $functionUrl.Trim().TrimEnd('/')
Write-Host "   url: $functionUrl"

# --- S3 frontend -------------------------------------------------------------
Write-Host "`n== s3 =="
if (-not $CodeOnly) {
    $bucketExists = $true
    try { aws s3api head-bucket --bucket $BucketName 2>$null | Out-Null } catch { $bucketExists = $false }
    if ($LASTEXITCODE -ne 0) { $bucketExists = $false }

    if (-not $bucketExists) {
        Write-Host "   creating bucket"
        if ($Region -eq 'us-east-1') {
            aws s3api create-bucket --bucket $BucketName --region $Region | Out-Null
        } else {
            aws s3api create-bucket --bucket $BucketName --region $Region `
                --create-bucket-configuration "LocationConstraint=$Region" | Out-Null
        }

        # Public read is the point: this is a public static site with no secrets
        # in it. The API it talks to is separately public by design.
        aws s3api put-public-access-block --bucket $BucketName `
            --public-access-block-configuration 'BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false' | Out-Null

        $policy = @{
            Version   = '2012-10-17'
            Statement = @(@{
                Sid       = 'PublicReadForStaticSite'
                Effect    = 'Allow'
                Principal = '*'
                Action    = 's3:GetObject'
                Resource  = "arn:aws:s3:::$BucketName/*"
            })
        } | ConvertTo-Json -Depth 5 -Compress
        $policyFile = Join-Path ([System.IO.Path]::GetTempPath()) "irops-policy-$(Get-Random).json"
        # No BOM, for the same reason as the environment file above.
        [System.IO.File]::WriteAllText($policyFile, $policy)
        try {
            aws s3api put-bucket-policy --bucket $BucketName --policy "file://$policyFile" | Out-Null
        } finally { Remove-Item $policyFile -Force -ErrorAction SilentlyContinue }

        aws s3 website "s3://$BucketName/" --index-document index.html --error-document index.html | Out-Null
    }
}

# Points the static frontend at the Function URL. Generated at deploy time and
# gitignored: it contains a deployment-specific URL, not a secret, but it should
# not be committed as though it were source.
$configPath = Join-Path $repoRoot 'web\config.js'
[System.IO.File]::WriteAllText($configPath, "window.API_BASE = '$functionUrl';`n")

Write-Host "   uploading frontend"
aws s3 sync (Join-Path $repoRoot 'web') "s3://$BucketName/" --delete --cache-control 'no-cache' | Out-Null

$siteUrl = "http://$BucketName.s3-website-$Region.amazonaws.com"

Write-Host "`n== done =="
Write-Host "   API  : $functionUrl/api/health"
Write-Host "   DEMO : $siteUrl"
Write-Host ""
Write-Host "   Verify with:  curl $functionUrl/api/health"
