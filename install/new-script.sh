#!/usr/bin/env bash
# Scaffold a new Rune script folder.
#
# Usage:
#   ./new-script.sh --name myscript                          # TS, current server
#   ./new-script.sh --name myscript --lang ts --server ~/mc
#
# Languages currently supported: ts (Node + TypeScript)
# Future: py (Python), lua (Lua), rs (Rust/Wasm) -- the template tree under
# install/templates/ scales horizontally; add a new <lang>/ folder and a
# case below to support a new runtime.

set -euo pipefail

NAME=""
LANG_="ts"
SERVER_DIR="."

while [[ $# -gt 0 ]]; do
    case "$1" in
        --name)   NAME="$2"; shift 2 ;;
        --lang)   LANG_="$2"; shift 2 ;;
        --server) SERVER_DIR="$2"; shift 2 ;;
        -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
        *) echo "unknown flag: $1" >&2; exit 1 ;;
    esac
done

cyan='\033[0;36m'; green='\033[0;32m'; red='\033[0;31m'; reset='\033[0m'
info() { printf "${cyan}[rune]${reset} %s\n" "$*"; }
ok()   { printf "${green}[rune]${reset} %s\n" "$*"; }
err()  { printf "${red}[rune]${reset} %s\n" "$*" >&2; }

if [[ -z "$NAME" ]]; then err "--name is required"; exit 1; fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
template_dir="$script_dir/templates/$LANG_"
if [[ ! -d "$template_dir" ]]; then
    err "no template for language '$LANG_'"
    err "available: $(ls "$script_dir/templates" 2>/dev/null | tr '\n' ' ')"
    exit 1
fi

scripts_dir="$SERVER_DIR/plugins/Rune/scripts"
if [[ ! -d "$scripts_dir" ]]; then
    err "scripts dir not found: $scripts_dir"
    err "Start the server once with the Rune plugin installed first."
    exit 1
fi

dest="$scripts_dir/$NAME"
if [[ -e "$dest" ]]; then
    err "script folder already exists: $dest"
    exit 1
fi
mkdir -p "$dest"

for src in "$template_dir"/*; do
    [[ -f "$src" ]] || continue
    sed "s/__SCRIPT_NAME__/$NAME/g" "$src" > "$dest/$(basename "$src")"
done

ok "Created $dest"
ok "Files:"
ls "$dest" | sed 's/^/  /'
echo
ok "Run /rune reload in-game to load it (or restart the server)."
