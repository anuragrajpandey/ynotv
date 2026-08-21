#!/usr/bin/env pwsh
# Run from packages/app/src-tauri directory:
#   pwsh ./setup-libmpv.ps1
# or:
#   powershell -ExecutionPolicy Bypass -File .\setup-libmpv.ps1

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$libDir = Join-Path $root "libmpv"
$dllUrl = "https://github.com/harborstremio/harbor/releases/download/mpvdll/libmpv-2.dll"
$dllPath = Join-Path $libDir "libmpv-2.dll"

Write-Host "[setup-libmpv] target dir: $libDir"

if (-not (Test-Path $libDir)) {
    New-Item -ItemType Directory -Force -Path $libDir | Out-Null
}

if (-not (Test-Path $dllPath)) {
    Write-Host "[setup-libmpv] downloading libmpv-2.dll..."
    Invoke-WebRequest -Uri $dllUrl -OutFile $dllPath
}

# Locate the import lib
$mpvLib = Get-ChildItem -Path $libDir -Filter "mpv.lib" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
$libmpvDef = Get-ChildItem -Path $libDir -Filter "libmpv.def" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1

if (-not $mpvLib -and $libmpvDef) {
    Write-Host "[setup-libmpv] no mpv.lib found, generating from libmpv.def via lib.exe..."
    $libExe = Get-Command lib.exe -ErrorAction SilentlyContinue
    if ($libExe) {
        Push-Location $libmpvDef.DirectoryName
        & lib.exe /def:libmpv.def /out:mpv.lib /machine:x64
        Pop-Location
    }
}

# Copy DLL next to target output so it loads at runtime (debug + release)
$debugDir = Join-Path $root "target\debug"
$releaseDir = Join-Path $root "target\release"
foreach ($d in @($debugDir, $releaseDir)) {
    if (Test-Path $d) {
        Copy-Item -Path $dllPath -Destination $d -Force
        Write-Host "[setup-libmpv] copied libmpv-2.dll -> $d"
    }
}

Write-Host "[setup-libmpv] libmpv ready." -ForegroundColor Green
