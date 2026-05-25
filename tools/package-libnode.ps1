# Package a built libnode tree into a tarball ready for upload to the
# `libnode-prebuilts` GitHub release.
#
# Inputs: a built Node source tree (the dir you ran `vcbuild.bat` in on
# Windows / `./configure && make` on POSIX). Must contain:
#   <root>/src/node.h
#   <root>/deps/v8/include/v8.h
#   <root>/deps/uv/include/uv.h
#   <root>/out/Release/libnode.{lib,dll}   (Windows)
#                      libnode.so          (Linux)
#                      libnode.dylib       (macOS)
#
# Output: ./libnode-<platform>.tar.gz that, when extracted, has the
# above layout at its top level. Rune's tools/fetch-libnode.mjs downloads
# this tarball and untars it into tools/libnode-cache/v<ver>/<platform>/.
#
# Usage:
#   .\package-libnode.ps1 -NodeRoot C:\Users\you\node
#   .\package-libnode.ps1 -NodeRoot C:\node -Out C:\releases\

param(
    [Parameter(Mandatory=$true)][string]$NodeRoot,
    [string]$Out      = ".",
    [string]$Platform = "auto"
)

$ErrorActionPreference = "Stop"

function Info($m) { Write-Host "[package-libnode] $m" -ForegroundColor Cyan }
function Err($m)  { Write-Host "[package-libnode] $m" -ForegroundColor Red }

if (-not (Test-Path $NodeRoot)) { Err "NodeRoot not found: $NodeRoot"; exit 1 }
$NodeRoot = (Resolve-Path $NodeRoot).Path

if ($Platform -eq "auto") {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
    $Platform = "windows-$arch"
}

# Sanity-check the source tree.
$required = @(
    "src/node.h",
    "deps/v8/include/v8.h",
    "deps/uv/include/uv.h",
    "out/Release/libnode.dll",
    "out/Release/libnode.lib"
)
foreach ($r in $required) {
    $p = Join-Path $NodeRoot $r
    if (-not (Test-Path $p)) { Err "missing: $p"; exit 1 }
}
Info "Node source tree looks complete."

# Stage into a temp dir. We tar from there so the archive's top level is
# {src, deps, out} -- NOT prefixed with the host's full path.
$stage = Join-Path ([System.IO.Path]::GetTempPath()) "libnode-pkg-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $stage -Force | Out-Null

Info "Staging headers + binaries -> $stage"
# Only headers from src/ -- the .cc/.c implementation files are huge and
# unused by downstream consumers (we just need the include surface).
robocopy "$NodeRoot/src" "$stage/src" /MIR /XF *.cc *.c *.cpp /NJH /NJS /NDL /NC /NS /NP | Out-Null
robocopy "$NodeRoot/deps/v8/include" "$stage/deps/v8/include" /MIR /NJH /NJS /NDL /NC /NS /NP | Out-Null
robocopy "$NodeRoot/deps/uv/include" "$stage/deps/uv/include" /MIR /NJH /NJS /NDL /NC /NS /NP | Out-Null

New-Item -ItemType Directory -Path "$stage/out/Release" -Force | Out-Null
Copy-Item "$NodeRoot/out/Release/libnode.dll" "$stage/out/Release/"
Copy-Item "$NodeRoot/out/Release/libnode.lib" "$stage/out/Release/"

# Tar (tar.exe ships with Windows 10+).
$tarball = Join-Path (Resolve-Path $Out) "libnode-$Platform.tar.gz"
Info "Creating $tarball"
Push-Location $stage
try {
    & tar -czf $tarball *
    if ($LASTEXITCODE -ne 0) { Err "tar failed"; exit $LASTEXITCODE }
} finally {
    Pop-Location
}

# Cleanup.
Remove-Item -Recurse -Force $stage

# SHA256 for the checksums.json on the Releases page.
$hash = (Get-FileHash $tarball -Algorithm SHA256).Hash.ToLower()
$sizeMb = [math]::Round((Get-Item $tarball).Length / 1MB, 1)
Info "Done."
Write-Host ""
Write-Host "  File:   $tarball"
Write-Host "  Size:   $sizeMb MB"
Write-Host "  SHA256: $hash"
Write-Host ""
Write-Host "  Upload to:  https://github.com/<your-org>/libnode-prebuilts/releases"
Write-Host "  Asset name: libnode-$Platform.tar.gz"
Write-Host "  Tag:        v<node-version> (e.g. v22.22.4-pre)"
Write-Host ""
Write-Host "  checksums.json entry:"
Write-Host "    `"libnode-$Platform.tar.gz`": `"$hash`""
