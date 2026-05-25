#!/usr/bin/env bash
# Package a built libnode tree into a tarball ready for upload to the
# `libnode-prebuilts` GitHub release. POSIX counterpart to package-libnode.ps1.
#
# Inputs: a built Node source tree. Must contain:
#   <root>/src/node.h
#   <root>/deps/v8/include/v8.h
#   <root>/deps/uv/include/uv.h
#   <root>/out/Release/libnode.so       (Linux)
#                      libnode.dylib    (macOS)
#
# Output: ./libnode-<platform>.tar.gz that, when extracted, has the
# above layout at its top level.
#
# Usage:
#   ./package-libnode.sh --root ~/node
#   ./package-libnode.sh --root ~/node --out ~/releases --platform linux-x64

set -euo pipefail

NODE_ROOT=""
OUT="."
PLATFORM="auto"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --root)     NODE_ROOT="$2"; shift 2 ;;
        --out)      OUT="$2"; shift 2 ;;
        --platform) PLATFORM="$2"; shift 2 ;;
        -h|--help)  sed -n '2,16p' "$0"; exit 0 ;;
        *) echo "unknown flag: $1" >&2; exit 1 ;;
    esac
done

cyan='\033[0;36m'; red='\033[0;31m'; reset='\033[0m'
info() { printf "${cyan}[package-libnode]${reset} %s\n" "$*"; }
err()  { printf "${red}[package-libnode]${reset} %s\n" "$*" >&2; }

[[ -n "$NODE_ROOT" ]] || { err "--root is required"; exit 1; }
[[ -d "$NODE_ROOT" ]] || { err "NodeRoot not found: $NODE_ROOT"; exit 1; }
NODE_ROOT="$(cd "$NODE_ROOT" && pwd)"

if [[ "$PLATFORM" == "auto" ]]; then
    os=$(uname -s | tr '[:upper:]' '[:lower:]')
    case "$os" in
        linux*)  os=linux ;;
        darwin*) os=macos ;;
        *) err "unsupported OS: $os"; exit 1 ;;
    esac
    arch=$(uname -m)
    case "$arch" in
        x86_64) arch=x64 ;;
        arm64|aarch64) arch=arm64 ;;
        *) err "unsupported arch: $arch"; exit 1 ;;
    esac
    PLATFORM="$os-$arch"
fi

case "$PLATFORM" in
    linux-*)  libname="libnode.so" ;;
    macos-*)  libname="libnode.dylib" ;;
    *) err "unsupported platform: $PLATFORM (use package-libnode.ps1 for Windows)"; exit 1 ;;
esac

# Sanity-check the source tree.
required=(
    "src/node.h"
    "deps/v8/include/v8.h"
    "deps/uv/include/uv.h"
    "out/Release/$libname"
)
for r in "${required[@]}"; do
    [[ -f "$NODE_ROOT/$r" ]] || { err "missing: $NODE_ROOT/$r"; exit 1; }
done
info "Node source tree looks complete."

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

info "Staging headers + binary -> $stage"
# Headers only -- skip the .cc/.c implementation files (huge, unused).
mkdir -p "$stage/src" "$stage/deps/v8/include" "$stage/deps/uv/include" "$stage/out/Release"
find "$NODE_ROOT/src" -name "*.h" -exec cp --parents -t "$stage/src/" {} \; 2>/dev/null \
    || (cd "$NODE_ROOT/src" && find . -name "*.h" -print0 | xargs -0 -I{} cp --parents {} "$stage/src/")
cp -r "$NODE_ROOT/deps/v8/include/." "$stage/deps/v8/include/"
cp -r "$NODE_ROOT/deps/uv/include/." "$stage/deps/uv/include/"
cp "$NODE_ROOT/out/Release/$libname" "$stage/out/Release/"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
tarball="$OUT/libnode-$PLATFORM.tar.gz"
info "Creating $tarball"
tar -czf "$tarball" -C "$stage" .

# SHA256 for the checksums.json on the Releases page.
if command -v sha256sum >/dev/null 2>&1; then
    hash=$(sha256sum "$tarball" | awk '{print $1}')
else
    hash=$(shasum -a 256 "$tarball" | awk '{print $1}')
fi
size_mb=$(du -m "$tarball" | awk '{print $1}')

info "Done."
echo
echo "  File:   $tarball"
echo "  Size:   ${size_mb} MB"
echo "  SHA256: $hash"
echo
echo "  Upload to:  https://github.com/<your-org>/libnode-prebuilts/releases"
echo "  Asset name: libnode-$PLATFORM.tar.gz"
echo "  Tag:        v<node-version> (e.g. v22.22.4-pre)"
echo
echo "  checksums.json entry:"
echo "    \"libnode-$PLATFORM.tar.gz\": \"$hash\""
