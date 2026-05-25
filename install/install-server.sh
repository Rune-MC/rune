#!/usr/bin/env bash
# Rune server installer (Linux/macOS).
#
# Bootstraps a Paper server with Rune in <server-dir>:
#   1. Verifies Java 21+.
#   2. Downloads the latest Paper build for the requested version.
#   3. Creates eula.txt (eula=true).
#   4. Copies the bundled rune-*.jar into plugins/.
#   5. Optionally starts the server once to bootstrap dataFolder.
#
# Usage:
#   ./install-server.sh                                  # current dir, latest 1.21
#   ./install-server.sh --server ~/mc --paper 1.21.4
#   ./install-server.sh --rune /path/to/rune-0.1.0.jar
#   ./install-server.sh --start                          # also start it once

set -euo pipefail

SERVER_DIR="."
PAPER_VERSION="1.21.4"
RUNE_JAR=""
START=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --server)  SERVER_DIR="$2"; shift 2 ;;
        --paper)   PAPER_VERSION="$2"; shift 2 ;;
        --rune)    RUNE_JAR="$2"; shift 2 ;;
        --start)   START=1; shift ;;
        -h|--help)
            sed -n '2,18p' "$0"
            exit 0
            ;;
        *) echo "unknown flag: $1" >&2; exit 1 ;;
    esac
done

cyan='\033[0;36m'; green='\033[0;32m'; red='\033[0;31m'; reset='\033[0m'
info()  { printf "${cyan}[rune]${reset} %s\n" "$*"; }
ok()    { printf "${green}[rune]${reset} %s\n" "$*"; }
err()   { printf "${red}[rune]${reset} %s\n" "$*" >&2; }

# --- 1. Java check --------------------------------------------------------
info "Checking for Java..."
if ! command -v java >/dev/null 2>&1; then
    err "Java not found. Install JDK 21+ (https://adoptium.net/)."
    exit 1
fi
ver=$(java -version 2>&1 | head -1 | sed -E 's/.*version "([0-9]+).*/\1/')
if [[ "$ver" -lt 21 ]]; then
    err "Java $ver detected; Paper 1.21+ requires Java 21+."
    exit 1
fi
ok "Java OK ($ver)."

# --- 2. Server dir --------------------------------------------------------
mkdir -p "$SERVER_DIR"
SERVER_DIR="$(cd "$SERVER_DIR" && pwd)"
info "Server folder: $SERVER_DIR"

# --- 3. Paper download ----------------------------------------------------
paper_jar="$SERVER_DIR/paper.jar"
if [[ ! -f "$paper_jar" ]]; then
    info "Fetching latest Paper $PAPER_VERSION build..."
    builds_api="https://api.papermc.io/v2/projects/paper/versions/$PAPER_VERSION/builds"
    builds_json=$(curl -fsSL "$builds_api") || { err "PaperMC API failed"; exit 1; }
    # crude JSON parse to find last build number + jar name (avoids jq dep)
    latest_build=$(echo "$builds_json" | grep -oE '"build":[0-9]+' | tail -1 | grep -oE '[0-9]+')
    jar_name=$(echo "$builds_json" | grep -oE '"name":"paper-[^"]+\.jar"' | tail -1 | sed 's/.*"\(paper-[^"]*\)".*/\1/')
    if [[ -z "$latest_build" || -z "$jar_name" ]]; then
        err "couldn't parse PaperMC response"
        exit 1
    fi
    url="https://api.papermc.io/v2/projects/paper/versions/$PAPER_VERSION/builds/$latest_build/downloads/$jar_name"
    info "Downloading $jar_name (build $latest_build)..."
    curl -fL "$url" -o "$paper_jar"
    ok "Paper saved to $paper_jar"
else
    info "paper.jar already present, skipping download."
fi

# --- 4. EULA --------------------------------------------------------------
eula_path="$SERVER_DIR/eula.txt"
if [[ ! -f "$eula_path" ]]; then
    echo "eula=true" > "$eula_path"
    ok "eula.txt written (eula=true)."
else
    info "eula.txt already present, leaving as-is."
fi

# --- 5. Locate Rune jar ---------------------------------------------------
if [[ -z "$RUNE_JAR" ]]; then
    script_dir="$(cd "$(dirname "$0")" && pwd)"
    # Beside this script first, then plugin/build/libs/ of the repo.
    RUNE_JAR=$(ls "$script_dir"/rune-*.jar 2>/dev/null | head -1 || true)
    if [[ -z "$RUNE_JAR" ]]; then
        RUNE_JAR=$(ls "$script_dir"/../plugin/build/libs/rune-*.jar 2>/dev/null | head -1 || true)
    fi
    if [[ -z "$RUNE_JAR" ]]; then
        err "No rune-*.jar found. Either:"
        err "  - drop the jar next to this script, or"
        err "  - pass --rune /path/to/rune-0.1.0.jar"
        exit 1
    fi
fi
if [[ ! -f "$RUNE_JAR" ]]; then
    err "Rune jar not found: $RUNE_JAR"
    exit 1
fi

# --- 6. Drop into plugins/ ------------------------------------------------
mkdir -p "$SERVER_DIR/plugins"
cp -f "$RUNE_JAR" "$SERVER_DIR/plugins/"
ok "Installed $(basename "$RUNE_JAR") -> $SERVER_DIR/plugins/"

# --- 7. Optional: first-run -----------------------------------------------
if [[ "$START" -eq 1 ]]; then
    info "Starting server (Ctrl+C to stop)..."
    cd "$SERVER_DIR"
    exec java -Xms2G -Xmx2G -jar paper.jar nogui
else
    ok "Done. To start:"
    echo "  cd \"$SERVER_DIR\""
    echo "  java -Xms2G -Xmx2G -jar paper.jar nogui"
    echo
    ok "First start will create plugins/Rune/scripts/. Drop .ts files there or run:"
    echo "  ./install/new-script.sh --name myscript --server \"$SERVER_DIR\""
fi
