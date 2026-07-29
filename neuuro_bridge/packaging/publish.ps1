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
#
# BatchMode is the load-bearing one in CI. Without it, ANY prompt ssh decides to show -
# unknown host key, a passphrase, or a password fallback after it rejects the key file's
# permissions - blocks on stdin forever. A CI run then looks identical to a slow upload:
# the first attempt sat for 6.5 minutes with no output before being killed by hand.
# BatchMode turns every one of those into an immediate, readable failure instead.
#
# accept-new records an unknown host key on first connect without asking, but still
# REFUSES a host key that has changed - the protection that matters. It also removes the
# need to pre-seed known_hosts, which was itself a silent failure point.
$sshOpts = @()
if ($IdentityFile) {
    if (-not (Test-Path $IdentityFile)) { throw "IdentityFile not found: $IdentityFile" }
    $sshOpts = @(
        "-i", $IdentityFile,
        "-o", "IdentitiesOnly=yes",
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ConnectTimeout=15"
    )
}

Write-Host "== Publishing $ReleasesDir -> ${Target}:$RemoteDir =="

# Preflight: prove auth works before moving ~40 MB. A failure here reports the reason
# (bad key, refused permissions, unreachable host) in seconds rather than midway
# through an upload.
ssh @sshOpts $Target "true"
if ($LASTEXITCODE -ne 0) {
    throw ("SSH connection/auth to $Target failed (exit $LASTEXITCODE). With BatchMode " +
           "on, this means ssh could not authenticate non-interactively - check the key " +
           "contents, its file permissions, and that the host is reachable.")
}

ssh @sshOpts $Target "mkdir -p $RemoteDir"
if ($LASTEXITCODE -ne 0) { throw "ssh mkdir failed (exit $LASTEXITCODE)" }
scp -r @sshOpts "$ReleasesDir\*" "${Target}:$RemoteDir/"
if ($LASTEXITCODE -ne 0) { throw "scp failed (exit $LASTEXITCODE)" }

Write-Host "Published. Feed: https://clinics.axonview.sg/bridge-updates/"
Write-Host "Sanity check:   curl https://clinics.axonview.sg/bridge-updates/releases.win.json"
