# libnode-prebuilts

Pre-built [libnode](https://nodejs.org/) shared libraries + headers for [Rune](https://github.com/Rune-MC/rune).

Rune embeds libnode as its JS runtime. Building libnode from source is multi-hour and ~100 GB on disk, so contributors (and CI) pull a stripped-down tarball from this repo instead.

## What's in a release

Each release tag (e.g. `v22.11.0`) contains one tarball per platform plus a checksum manifest:

```
libnode-windows-x64.tar.gz
libnode-linux-x64.tar.gz
libnode-macos-arm64.tar.gz
checksums.json              # { "<file>": "<sha256>", ... }
```

Tarball layout (extracted):

```
src/                  # headers only (.h)
deps/v8/include/
deps/uv/include/
out/Release/
  libnode.dll         # windows
  libnode.lib         # windows (import lib)
  libnode.so          # linux
  libnode.dylib       # macos
```

## Cutting a release

CI (`.github/workflows/build-and-release.yml`) does everything. Two ways to trigger:

### A. Tag push (recommended)

```bash
git tag v22.11.0
git push origin v22.11.0
```

The tag MUST match a Node.js git ref ([list of Node tags](https://github.com/nodejs/node/tags)). CI:

1. Clones `nodejs/node` at the ref on each runner.
2. Builds libnode (Windows: `vcbuild.bat dll release x64`; POSIX: `./configure --shared && make node`).
3. Strips to headers + binary, packages as `libnode-<platform>.tar.gz`, writes SHA256.
4. Creates a GitHub Release named `libnode v22.11.0` with all tarballs + `checksums.json`.

End-to-end runtime: ~60-90 minutes (three platforms build in parallel).

### B. Manual dispatch (for testing or non-tag refs)

GitHub UI → Actions → **build-and-release** → **Run workflow** → enter a Node ref (`v22.11.0`, `main`, or a commit SHA). The resulting release uses that ref as its tag.

## Adding a new platform

Add a row to the matrix in `build-and-release.yml`:

```yaml
- target: linux-arm64
  runner: ubuntu-latest-arm     # if/when GitHub adds this runner
```

Then add a `case` branch in the **Stage tarball** step picking the right `libnode.*` filename.

## Consuming from Rune

Rune's `tools/fetch-libnode.mjs` defaults to:

```
https://github.com/Rune-MC/libnode-prebuilts/releases/download/v<RUNE_NODE_VERSION>/libnode-<platform>.tar.gz
```

`RUNE_NODE_VERSION` is set in Rune's `.github/workflows/{ci,release}.yml`. Bumping the libnode version is a one-line PR in Rune that flips that env to a new tag in THIS repo.

## License

Tarballs contain Node.js source headers + binaries — see [Node's license](https://github.com/nodejs/node/blob/main/LICENSE). This repo's CI scripts are MIT.
