# Builds the WPF bridge and packs a Velopack release (Setup.exe + full/delta packages).
#
#   powershell -ExecutionPolicy Bypass -File neuuro_bridge\packaging\pack.ps1
#   powershell ... -File pack.ps1 -Version 1.0.1          # override csproj version
#   powershell ... -File pack.ps1 -OutputDir D:\feed      # pack straight into a test feed
#
# Requires the Velopack CLI once per machine:  dotnet tool install -g vpk
#
# Output goes to neuuro_bridge\packaging\releases (gitignored). Publishing = copying
# that folder's contents to the nginx feed (https://<domain>/bridge-updates/). Packing
# into the SAME output dir across versions is what makes vpk emit delta packages.
#
# Supersedes the parked zip approach (package.ps1 on feature/bridge-packaging); keeps
# its guarantee: a real .env can NEVER ship — credentials come from first-run
# activation, never from the package.

param(
    [string]$Version,
    [string]$Configuration = "Release",
    [string]$OutputDir
)

$ErrorActionPreference = "Stop"

$packagingDir = $PSScriptRoot
$bridgeDir    = Split-Path $packagingDir -Parent
$sln          = Join-Path $bridgeDir "NeuuroBridge.sln"
$csproj       = Join-Path $bridgeDir "NeuuroBridge.Wpf\NeuuroBridge.Wpf.csproj"
$buildOut     = Join-Path $bridgeDir "NeuuroBridge.Wpf\bin\x64\$Configuration\net48"
if (-not $OutputDir) { $OutputDir = Join-Path $packagingDir "releases" }

if (-not (Get-Command vpk -ErrorAction SilentlyContinue)) {
    throw "Velopack CLI not found. Install once with: dotnet tool install -g vpk"
}

# Version comes from the csproj unless overridden — one source of truth.
if (-not $Version) {
    $m = Select-String -Path $csproj -Pattern "<Version>([^<]+)</Version>"
    if (-not $m) { throw "No <Version> in $csproj and no -Version given" }
    $Version = $m.Matches[0].Groups[1].Value
}

Write-Host "== Building $sln ($Configuration) =="
dotnet build $sln -c $Configuration --nologo -v q
if ($LASTEXITCODE -ne 0) { throw "dotnet build failed (exit $LASTEXITCODE)" }
if (-not (Test-Path (Join-Path $buildOut "NeuuroBridge.Wpf.exe"))) {
    throw "Build output not found at $buildOut"
}

# Hard guard: secrets must never ship. Credentials arrive via activation at first
# run; any .env in the build output is a dev artifact and aborts the pack.
$leaked = Get-ChildItem $buildOut -Recurse -Force -Include ".env" -ErrorAction SilentlyContinue
if ($leaked) { throw "ABORT: .env found in build output: $($leaked.FullName -join ', ')" }

Write-Host "== vpk pack $Version =="
vpk pack `
    --packId NeuuroBridge `
    --packVersion $Version `
    --packDir $buildOut `
    --mainExe "NeuuroBridge.Wpf.exe" `
    --packTitle "NeuuroBridge" `
    --packAuthors "QIROM Consulting" `
    --outputDir $OutputDir
if ($LASTEXITCODE -ne 0) { throw "vpk pack failed (exit $LASTEXITCODE)" }

Write-Host ""
Write-Host "Release $Version packed to: $OutputDir"
Get-ChildItem $OutputDir | ForEach-Object {
    Write-Host ("  {0}  {1:N1} MB" -f $_.Name, ($_.Length / 1MB))
}
