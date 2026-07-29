<#
.SYNOPSIS
    Provisions the CockroachDB Cloud Basic cluster for the IROPS Disruption
    Memory Agent.

.DESCRIPTION
    Committed per SPEC.md §7, which asks for the ccloud CLI to be used and the
    provisioning scripted rather than clicked through a console.

    Syntax verified against `ccloud cluster create --help` on ccloud 0.8.23
    (SPEC §1.2 — never guess at CLI syntax). Re-check if you upgrade ccloud.

    Idempotent: if a cluster with the given name already exists, it reports and
    exits 0 rather than erroring or creating a duplicate.

    Contains no secrets and prints none. The connection string is fetched in a
    separate step so it never lands in a log or a terminal scrollback you might
    paste somewhere.

.PARAMETER ClusterName
    Name of the cluster. Must be unique within the organization.

.PARAMETER Cloud
    Cloud provider. Defaults to AWS deliberately: `ccloud` itself defaults to
    GCP, and this project runs its Lambda and Bedrock calls in AWS us-east-1.
    Cross-cloud would add a network hop on the hot retrieval path for no gain.

.PARAMETER Region
    Cloud region. Basic is documented as "available in select regions", so
    confirm with `ccloud cluster regions` before assuming any given region works.

.PARAMETER RequestUnitLimit
    Optional monthly RU cap. 0 (default) means do not pass the flag and inherit
    the account default.

    Think before setting this. Per NOTES.md §3.2, hitting an RU limit *disables
    the cluster* until the next billing cycle. The demo has to stay functional
    from Aug 19 to Sep 15, so a cap set too low is a self-inflicted outage during
    judging. A CockroachDB Basic org with no card on file cannot be billed
    anyway, which makes an artificial cap mostly redundant here.

.PARAMETER StorageGibLimit
    Optional storage cap in GiB. 0 (default) means inherit the account default.
    Same reasoning as above: hitting it blocks writes.

.NOTES
    Windows blocks unsigned scripts by default (execution policy 'Restricted').
    If you get "running scripts is disabled on this system", invoke it as:

        powershell -ExecutionPolicy Bypass -File ".\scripts\provision-cluster.ps1"

    That bypasses the policy for one invocation only and changes nothing on the
    machine. Prefer it over `Set-ExecutionPolicy`, which is a persistent
    security-setting change and is not needed to run this.

.EXAMPLE
    .\scripts\provision-cluster.ps1
    Creates 'irops-memory' as a Basic cluster on AWS us-east-1.

.EXAMPLE
    .\scripts\provision-cluster.ps1 -ClusterName irops-test -Region us-west-2
#>
[CmdletBinding()]
param(
    [string]$ClusterName = 'irops-memory',
    [ValidateSet('AWS', 'GCP', 'AZURE')]
    [string]$Cloud = 'AWS',
    [string]$Region = 'us-east-1',
    [int]$RequestUnitLimit = 0,
    [float]$StorageGibLimit = 0
)

$ErrorActionPreference = 'Stop'

function Get-CcloudPath {
    $onPath = Get-Command ccloud -ErrorAction SilentlyContinue
    if ($null -ne $onPath) { return $onPath.Source }

    # Where the documented Windows install puts it. Note that the published
    # Windows zip extracts a file named `ccloud` with NO .exe extension, so the
    # install snippet in the docs fails its final copy step; we rename on
    # install. See README.
    $fallback = Join-Path $env:APPDATA 'ccloud\ccloud.exe'
    if (Test-Path $fallback) { return $fallback }

    throw "ccloud not found. Install it, then re-run. See README 'Setup from zero'."
}

$ccloud = Get-CcloudPath
Write-Host "Using ccloud: $ccloud"
& $ccloud version

# --- Auth check -------------------------------------------------------------
# Any authenticated call will do; `cluster list` is read-only.
#
# Do NOT redirect native stderr with 2>&1 here. Windows PowerShell 5.1 wraps
# each stderr line from a native executable in an ErrorRecord
# (NativeCommandError); combined with $ErrorActionPreference='Stop' that becomes
# a *terminating* error even when the process exits 0. ccloud writes progress
# text ("Retrieving clusters: succeeded") to stderr, so redirecting made this
# blow up on the happy path. Let stderr go to the console and judge success by
# $LASTEXITCODE alone.
Write-Host "`nChecking authentication..."

$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$existingRaw = & $ccloud cluster list --output json
$listExit = $LASTEXITCODE
$ErrorActionPreference = $prevEap

if ($listExit -ne 0) {
    throw "'ccloud cluster list' failed (exit $listExit). If it reported 'not logged in', run 'ccloud auth login' and re-run this script."
}

# --- Idempotency ------------------------------------------------------------
# Parse defensively: tolerate both a bare array and a { clusters: [...] }
# envelope, and treat unparseable output as "unknown" rather than "none" -- a
# bad parse must not cause a duplicate cluster to be created.
$clusters = @()
$parsed = $null
try {
    $parsed = ($existingRaw | Out-String) | ConvertFrom-Json
} catch {
    throw "Could not parse 'ccloud cluster list --output json' output. Refusing to continue, because a failed parse here could create a duplicate cluster. Run the command by hand to see what it returned."
}

if ($null -ne $parsed) {
    if ($null -ne $parsed.clusters) { $clusters = @($parsed.clusters) }
    else { $clusters = @($parsed) }
}

$match = $clusters | Where-Object { $_.name -eq $ClusterName }

if ($null -ne $match) {
    Write-Host "`nCluster '$ClusterName' already exists. Nothing to do." -ForegroundColor Green
    & $ccloud cluster info $ClusterName
    exit 0
}

# --- Create -----------------------------------------------------------------
# Positional form, per `ccloud cluster create --help`:
#   ccloud cluster create [BASIC|STANDARD|ADVANCED] [<name>] [<region> ...]
$createArgs = @(
    'cluster', 'create', 'BASIC', $ClusterName, $Region,
    '--cloud', $Cloud,
    '--primary-region', $Region,
    '--wait'
)

if ($RequestUnitLimit -gt 0) {
    $createArgs += @('--request-unit-limit', $RequestUnitLimit)
}
if ($StorageGibLimit -gt 0) {
    $createArgs += @('--storage-gib-limit', $StorageGibLimit)
}

Write-Host "`nCreating Basic cluster '$ClusterName' on $Cloud $Region..."
Write-Host "  $ccloud $($createArgs -join ' ')`n"

& $ccloud @createArgs
if ($LASTEXITCODE -ne 0) {
    throw "Cluster creation failed with exit code $LASTEXITCODE."
}

Write-Host "`nCluster '$ClusterName' created." -ForegroundColor Green
Write-Host @"

Next steps (run manually - these touch credentials, so they are deliberately
not scripted and their output must never be pasted into a chat or a commit):

  1. Create a SQL user:
       ccloud cluster user create $ClusterName <username>

  2. Fetch the connection string:
       ccloud cluster connection-string $ClusterName

  3. Put it in .env as DATABASE_URL, keeping sslmode=verify-full.
     .env is gitignored. Never commit it.

  4. Confirm the CockroachDB version, which decides whether vector indexing
     is Preview or GA:
       ccloud cluster sql $ClusterName
       > SELECT version();
"@
