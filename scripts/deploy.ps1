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
$envVars | ConvertTo-Json -Depth 4 -Compress | Set-Content -Path $envFile -Encoding utf8

try {
    if (-not $exists) {
        if ($CodeOnly) { throw "Function $FunctionName does not exist; run without -CodeOnly first." }
        Write-Host "   creating function"
        aws lambda create-function `
            --function-name $FunctionName `
            --runtime nodejs22.x `
            --role $RoleArn `
            --handler dist/api/lambda.handler `
            --zip-file "fileb://$zipPath" `
            --timeout 60 `
            --memory-size 512 `
            --environment "file://$envFile" `
            --region $Region | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'create-function failed' }

        Write-Host "   waiting for it to become active"
        aws lambda wait function-active-v2 --function-name $FunctionName --region $Region
    }
    else {
        Write-Host "   updating code"
        aws lambda update-function-code `
            --function-name $FunctionName `
            --zip-file "fileb://$zipPath" `
            --region $Region | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'update-function-code failed' }
        aws lambda wait function-updated-v2 --function-name $FunctionName --region $Region

        if (-not $CodeOnly) {
            Write-Host "   updating configuration"
            aws lambda update-function-configuration `
                --function-name $FunctionName `
                --handler dist/api/lambda.handler `
                --timeout 60 `
                --memory-size 512 `
                --environment "file://$envFile" `
                --region $Region | Out-Null
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
    $functionUrl = (aws lambda create-function-url-config `
        --function-name $FunctionName `
        --auth-type NONE `
        --cors 'AllowOrigins=*,AllowMethods=GET,POST,OPTIONS,AllowHeaders=content-type' `
        --region $Region --query FunctionUrl --output text)

    aws lambda add-permission `
        --function-name $FunctionName `
        --statement-id FunctionURLAllowPublicAccess `
        --action lambda:InvokeFunctionUrl `
        --principal '*' `
        --function-url-auth-type NONE `
        --region $Region | Out-Null
}
$functionUrl = $functionUrl.TrimEnd('/')
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
        $policy | Set-Content -Path $policyFile -Encoding utf8
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
"window.API_BASE = '$functionUrl';" | Set-Content -Path $configPath -Encoding utf8

Write-Host "   uploading frontend"
aws s3 sync (Join-Path $repoRoot 'web') "s3://$BucketName/" --delete --cache-control 'no-cache' | Out-Null

$siteUrl = "http://$BucketName.s3-website-$Region.amazonaws.com"

Write-Host "`n== done =="
Write-Host "   API  : $functionUrl/api/health"
Write-Host "   DEMO : $siteUrl"
Write-Host ""
Write-Host "   Verify with:  curl $functionUrl/api/health"
