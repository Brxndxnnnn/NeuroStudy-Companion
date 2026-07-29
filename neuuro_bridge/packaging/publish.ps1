# Publishes the Velopack release set to the droplet's update feed.
#
#   powershell -ExecutionPolicy Bypass -File neuuro_bridge\packaging\publish.ps1
#
# Uploads packaging\releases\* to /var/bridge-updates on the droplet (outside the
# repo tree - deploys never touch it), which nginx serves as
# https://clinics.axonview.sg/bridge-updates/ (see nginx/nginx.conf + compose.prod.yaml).
# Requires an authorised SSH key for the droplet (same access as deploying).
#
# Typical release flow:
#   1. bump <Version> in NeuuroBridge.Wpf.csproj
#   2. pack.ps1        (into packaging\releases so deltas build against prior versions)
#   3. publish.ps1

param(
    [string]$Target = "root@139.59.126.77",
    [string]$ReleasesDir,
    [string]$RemoteDir = "/var/bridge-updates",
    # CI passes an explicit private key written from the DROPLET_SSH_KEY secret. Left
    # empty for a manual run, where ssh finds the developer's own key as it always has.
    [string]$IdentityFile
)

$ErrorActionPreference = "Stop"

if (-not $ReleasesDir) { $ReleasesDir = Join-Path $PSScriptRoot "releases" }
if (-not (Test-Path (Join-Path $ReleasesDir "releases.win.json"))) {
    throw "No release set in $ReleasesDir (releases.win.json missing) - run pack.ps1 first"
}

# IdentitiesOnly stops ssh trying an agent key first and hitting MaxAuthTries on a
# runner that has other identities loaded.
$sshOpts = @()
if ($IdentityFile) {
    if (-not (Test-Path $IdentityFile)) { throw "IdentityFile not found: $IdentityFile" }
    $sshOpts = @("-i", $IdentityFile, "-o", "IdentitiesOnly=yes")
}

Write-Host "== Publishing $ReleasesDir -> ${Target}:$RemoteDir =="
ssh @sshOpts $Target "mkdir -p $RemoteDir"
if ($LASTEXITCODE -ne 0) { throw "ssh mkdir failed (exit $LASTEXITCODE)" }
scp -r @sshOpts "$ReleasesDir\*" "${Target}:$RemoteDir/"
if ($LASTEXITCODE -ne 0) { throw "scp failed (exit $LASTEXITCODE)" }

Write-Host "Published. Feed: https://clinics.axonview.sg/bridge-updates/"
Write-Host "Sanity check:   curl https://clinics.axonview.sg/bridge-updates/releases.win.json"
