# Rune server installer (Windows).
#
# Bootstraps a Paper server with Rune in <ServerPath>:
#   1. Verifies Java 21+ is on PATH (Paper 1.21 requires it).
#   2. Downloads the latest Paper build for the requested version.
#   3. Creates eula.txt (eula=true).
#   4. Copies the bundled rune-*.jar into plugins/.
#   5. Optionally starts the server once to bootstrap dataFolder.
#
# Usage:
#   .\install-server.ps1                                  # current dir, latest 1.21
#   .\install-server.ps1 -ServerPath C:\mc -PaperVersion 1.21.4
#   .\install-server.ps1 -RuneJar C:\path\to\rune-0.1.0.jar
#   .\install-server.ps1 -Start                           # also start it once

param(
    [string]$ServerPath    = ".",
    [string]$PaperVersion  = "1.21.4",
    [string]$RuneJar       = "",
    [switch]$Start
)

$ErrorActionPreference = "Stop"

function Info($msg)  { Write-Host "[rune] $msg" -ForegroundColor Cyan }
function Ok($msg)    { Write-Host "[rune] $msg" -ForegroundColor Green }
function Err($msg)   { Write-Host "[rune] $msg" -ForegroundColor Red }

# --- 1. Java check --------------------------------------------------------
Info "Checking for Java..."
$javaVer = & java -version 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Err "Java not found. Install JDK 21 or newer."
    Err "Get it at: https://adoptium.net/"
    exit 1
}
$verMatch = [regex]::Match($javaVer, 'version "(\d+)')
if ($verMatch.Success -and [int]$verMatch.Groups[1].Value -lt 21) {
    Err "Java $($verMatch.Groups[1].Value) detected; Paper 1.21+ requires Java 21+."
    exit 1
}
Ok "Java OK."

# --- 2. Server dir --------------------------------------------------------
$ServerPath = (Resolve-Path -Path (New-Item -ItemType Directory -Path $ServerPath -Force)).Path
Info "Server folder: $ServerPath"

# --- 3. Paper download ----------------------------------------------------
$paperJar = Join-Path $ServerPath "paper.jar"
if (-not (Test-Path $paperJar)) {
    Info "Fetching latest Paper $PaperVersion build..."
    $buildsApi = "https://api.papermc.io/v2/projects/paper/versions/$PaperVersion/builds"
    try {
        $builds = Invoke-RestMethod -Uri $buildsApi
    } catch {
        Err "Failed to query PaperMC API: $_"
        exit 1
    }
    $latest = $builds.builds | Select-Object -Last 1
    $jarName = $latest.downloads.application.name
    $downloadUrl = "https://api.papermc.io/v2/projects/paper/versions/$PaperVersion/builds/$($latest.build)/downloads/$jarName"
    Info "Downloading $jarName (build $($latest.build))..."
    Invoke-WebRequest -Uri $downloadUrl -OutFile $paperJar -UseBasicParsing
    Ok "Paper saved to $paperJar"
} else {
    Info "paper.jar already present, skipping download."
}

# --- 4. EULA --------------------------------------------------------------
$eulaPath = Join-Path $ServerPath "eula.txt"
if (-not (Test-Path $eulaPath)) {
    "eula=true" | Set-Content -Encoding ASCII $eulaPath
    Ok "eula.txt written (eula=true)."
} else {
    Info "eula.txt already present, leaving as-is."
}

# --- 5. Locate Rune jar ---------------------------------------------------
if (-not $RuneJar) {
    # Look beside this script first, then in plugin/build/libs/ of the repo.
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $local = Get-ChildItem -Path $scriptDir -Filter "rune-*.jar" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $local) {
        $repo = Join-Path $scriptDir "..\plugin\build\libs"
        $local = Get-ChildItem -Path $repo -Filter "rune-*.jar" -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    if (-not $local) {
        Err "No rune-*.jar found. Either:"
        Err "  - drop the jar next to this script, or"
        Err "  - pass -RuneJar C:\path\to\rune-0.1.0.jar"
        exit 1
    }
    $RuneJar = $local.FullName
}
if (-not (Test-Path $RuneJar)) {
    Err "Rune jar not found at: $RuneJar"
    exit 1
}

# --- 6. Drop into plugins/ ------------------------------------------------
$pluginsDir = Join-Path $ServerPath "plugins"
New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null
Copy-Item -Path $RuneJar -Destination $pluginsDir -Force
Ok "Installed $(Split-Path -Leaf $RuneJar) -> $pluginsDir"

# --- 7. Optional: first-run --------------------------------------------------
if ($Start) {
    Info "Starting server (Ctrl+C to stop)..."
    Push-Location $ServerPath
    try {
        & java -Xms2G -Xmx2G -jar paper.jar nogui
    } finally {
        Pop-Location
    }
} else {
    Ok "Done. To start:"
    Write-Host "  cd `"$ServerPath`""
    Write-Host "  java -Xms2G -Xmx2G -jar paper.jar nogui"
    Write-Host ""
    Ok "First start will create plugins/Rune/scripts/. Drop .ts files there or run:"
    Write-Host "  .\install\new-script.ps1 -Name myscript -ServerPath `"$ServerPath`""
}
