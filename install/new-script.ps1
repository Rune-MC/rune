# Scaffold a new Rune script folder.
#
# Usage:
#   .\new-script.ps1 -Name myscript                     # TS, current server
#   .\new-script.ps1 -Name myscript -Lang ts -ServerPath C:\mc
#
# Languages currently supported: ts (Node + TypeScript)
# Future: py (Python), lua (Lua), rs (Rust/Wasm) -- the template tree under
# install/templates/ scales horizontally; add a new <lang>/ folder and a
# case below to support a new runtime.

param(
    [Parameter(Mandatory=$true)][string]$Name,
    [string]$Lang       = "ts",
    [string]$ServerPath = "."
)

$ErrorActionPreference = "Stop"

function Info($m) { Write-Host "[rune] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[rune] $m" -ForegroundColor Green }
function Err($m)  { Write-Host "[rune] $m" -ForegroundColor Red }

# Resolve template dir relative to this script.
$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$templateDir = Join-Path $scriptDir "templates\$Lang"
if (-not (Test-Path $templateDir)) {
    Err "No template for language '$Lang'."
    Err "Available: $((Get-ChildItem (Join-Path $scriptDir 'templates') -Directory).Name -join ', ')"
    exit 1
}

# Find scripts/ inside the server.
$scriptsDir = Join-Path $ServerPath "plugins\Rune\scripts"
if (-not (Test-Path $scriptsDir)) {
    Err "scripts dir not found: $scriptsDir"
    Err "Start the server once with the Rune plugin installed first."
    exit 1
}

$dest = Join-Path $scriptsDir $Name
if (Test-Path $dest) {
    Err "Script folder already exists: $dest"
    exit 1
}
New-Item -ItemType Directory -Path $dest | Out-Null

# Copy templates, substituting __SCRIPT_NAME__.
Get-ChildItem -Path $templateDir -File | ForEach-Object {
    $body = (Get-Content -Raw -Path $_.FullName).Replace("__SCRIPT_NAME__", $Name)
    Set-Content -Path (Join-Path $dest $_.Name) -Value $body -NoNewline
}

Ok "Created $dest"
Ok "Files:"
Get-ChildItem $dest | ForEach-Object { Write-Host "  $($_.FullName)" }
Write-Host ""
Ok "Run /rune reload in-game to load it (or restart the server)."
