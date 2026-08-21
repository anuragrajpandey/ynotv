#!/usr/bin/env pwsh
# Run from packages/app/src-tauri directory:
#   pwsh ./setup-libmpv.ps1
# or:
#   powershell -ExecutionPolicy Bypass -File .\setup-libmpv.ps1

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$libDir = Join-Path $root "libmpv"
$expectedSha256 = "E9C87D19055BC5A82771B2B48E9FBAE047BD5180603F5A1AAAE10C90CA690467"

$dllUrls = @(
    $env:YNOTV_LIBMPV_URL,
    "https://github.com/tbeezy/ynotv/releases/download/v-assets/libmpv-2.dll",
    "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20260505/mpv-dev-x86_64-v3-20260505-git-cfd818b.7z",
    "https://github.com/harborstremio/harbor/releases/download/mpvdll/libmpv-2.dll"
) | Where-Object { $_ -and $_.Trim() -ne "" }

$dllPath = Join-Path $libDir "libmpv-2.dll"

Write-Host "[setup-libmpv] target dir: $libDir"

if (-not (Test-Path $libDir)) {
    New-Item -ItemType Directory -Force -Path $libDir | Out-Null
}

$downloadNeeded = $true
if (Test-Path $dllPath) {
    $currentHash = (Get-FileHash $dllPath -Algorithm SHA256).Hash
    if ($currentHash -eq $expectedSha256) {
        Write-Host "[setup-libmpv] libmpv-2.dll already present and verified ($currentHash)." -ForegroundColor Green
        $downloadNeeded = $false
    }
}

if ($downloadNeeded) {
    $downloaded = $false
    foreach ($url in $dllUrls) {
        try {
            Write-Host "[setup-libmpv] attempting download from $url..."
            if ($url.EndsWith(".7z")) {
                $temp7z = Join-Path $libDir "temp_mpv.7z"
                Invoke-WebRequest -Uri $url -OutFile $temp7z
                7z e $temp7z -o"$libDir" "libmpv-2.dll" "libmpv.def" -y | Out-Null
                Remove-Item $temp7z -Force -ErrorAction SilentlyContinue
            } else {
                Invoke-WebRequest -Uri $url -OutFile $dllPath
            }
            if (Test-Path $dllPath) {
                $hash = (Get-FileHash $dllPath -Algorithm SHA256).Hash
                if ($hash -eq $expectedSha256) {
                    Write-Host "[setup-libmpv] downloaded and verified SHA256 checksum." -ForegroundColor Green
                    $downloaded = $true
                    break
                }
            }
        } catch {
            Write-Host "[setup-libmpv] download from $url failed: $_" -ForegroundColor Yellow
        }
    }
    if (-not $downloaded -and -not (Test-Path $dllPath)) {
        throw "Failed to download verified libmpv-2.dll from configured endpoints."
    }
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
