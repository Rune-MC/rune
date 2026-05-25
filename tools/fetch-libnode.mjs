#!/usr/bin/env node
// Fetch a pre-built libnode for the current platform (or one specified
// via --platform). Avoids the multi-hour libnode-from-source build.
//
// Storage convention:
//   tools/libnode-cache/<node-version>/<platform>/
//     ├── src/             (Node + V8 headers)
//     ├── deps/v8/include/ (V8 headers)
//     ├── deps/uv/include/ (libuv headers)
//     └── out/Release/
//         ├── libnode.lib   (Windows import lib, MSVC only)
//         └── libnode.dll | libnode.so | libnode.dylib
//
// build.rs of crates/rune-runtime-node looks for this layout when
// $RUNE_NODE_ROOT isn't set.
//
// Usage:
//   node tools/fetch-libnode.mjs                       # current platform
//   node tools/fetch-libnode.mjs --platform windows-x64
//   node tools/fetch-libnode.mjs --version 22.20.0
//   node tools/fetch-libnode.mjs --base-url https://github.com/your-org/libnode-prebuilts/releases/download

import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { argv, platform as nodePlatform, arch, exit } from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = resolve(__dirname, '..');
const CACHE_DIR  = join(REPO_ROOT, 'tools', 'libnode-cache');

const DEFAULTS = {
  version: '22.20.0',
  // Where the pre-built tarballs are published. PLACEHOLDER -- change to
  // wherever you host them (GitHub Releases, S3, etc.) once you have a
  // build pipeline. The tarball at
  //   <baseUrl>/v<version>/libnode-<platform>.tar.gz
  // should expand to the layout documented above.
  baseUrl: 'https://github.com/Rune-MC/libnode-prebuilts/releases/download',
  // Optional checksum manifest URL: maps "libnode-<platform>.tar.gz" -> sha256.
  // Layout: { "libnode-windows-x64.tar.gz": "abc123...", ... }
  checksumsPath: null, // e.g. `${baseUrl}/v${version}/checksums.json`
};

function detectPlatform() {
  const archMap = { x64: 'x64', arm64: 'arm64' };
  const platMap = { win32: 'windows', linux: 'linux', darwin: 'macos' };
  const p = platMap[nodePlatform];
  const a = archMap[arch];
  if (!p || !a) {
    throw new Error(`unsupported host: ${nodePlatform}/${arch}`);
  }
  return `${p}-${a}`;
}

function parseArgs() {
  const out = { ...DEFAULTS, platform: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--version':   out.version = v; i++; break;
      case '--platform':  out.platform = v; i++; break;
      case '--base-url':  out.baseUrl = v; i++; break;
      case '--checksums': out.checksumsPath = v; i++; break;
      case '-h': case '--help':
        console.log(`Usage: node tools/fetch-libnode.mjs [--version X.Y.Z] [--platform <p>] [--base-url URL]

Defaults: platform=<auto>, version=${DEFAULTS.version}`);
        exit(0);
      default:
        console.error(`unknown arg: ${k}`); exit(1);
    }
  }
  if (!out.platform) out.platform = detectPlatform();
  return out;
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function sha256(path) {
  const h = createHash('sha256');
  const body = await readFile(path);
  h.update(body);
  return h.digest('hex');
}

async function download(url, dest) {
  await mkdir(dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} -- ${url}`);
  await pipeline(res.body, createWriteStream(dest));
}

async function main() {
  const opts = parseArgs();
  const installDir = join(CACHE_DIR, `v${opts.version}`, opts.platform);
  const sentinelDir = join(installDir, 'out', 'Release');

  if (await exists(sentinelDir)) {
    console.log(`[fetch-libnode] cache hit: ${installDir}`);
    console.log(`[fetch-libnode] set RUNE_NODE_ROOT=${installDir} for cargo`);
    return;
  }

  const tarName = `libnode-${opts.platform}.tar.gz`;
  const tarUrl  = `${opts.baseUrl}/v${opts.version}/${tarName}`;
  const tarPath = join(CACHE_DIR, tarName);

  console.log(`[fetch-libnode] downloading ${tarUrl}`);
  try {
    await download(tarUrl, tarPath);
  } catch (e) {
    console.error(`
[fetch-libnode] DOWNLOAD FAILED -- ${e.message}

  Tried:        ${tarUrl}
  Cache target: ${installDir}

  Most likely cause: the v${opts.version} release in the prebuilts repo
  doesn't exist yet (or doesn't include libnode-${opts.platform}.tar.gz).

  Fix in order of preference:
    1. Cut the prebuilts release:
         cd <your libnode-prebuilts checkout>
         git tag v${opts.version}
         git push origin v${opts.version}
       Wait ~60-90 min for its CI to finish, then re-run this script.

    2. Drop a pre-built tarball into the cache by hand:
         ${tarPath}
       (this script skips the download if the file already exists)
       and re-run.

    3. Override --base-url to a mirror that hosts the prebuilts.

    4. Build libnode from source yourself (slow, multi-GB) and set
         $env:RUNE_NODE_ROOT = '<path to built node tree>'
       to skip this script entirely.
`);
    exit(1);
  }

  // Optional checksum verification.
  if (opts.checksumsPath) {
    try {
      const manifestUrl = opts.checksumsPath;
      const res = await fetch(manifestUrl);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const manifest = await res.json();
      const expected = manifest[tarName];
      if (expected) {
        const got = await sha256(tarPath);
        if (got !== expected) {
          console.error(`[fetch-libnode] checksum mismatch: expected ${expected}, got ${got}`);
          exit(1);
        }
        console.log(`[fetch-libnode] checksum OK (${expected.slice(0, 12)}...)`);
      } else {
        console.warn(`[fetch-libnode] no checksum entry for ${tarName}; skipping verify`);
      }
    } catch (e) {
      console.warn(`[fetch-libnode] checksum fetch failed (${e.message}); skipping verify`);
    }
  }

  // Extract.
  await mkdir(installDir, { recursive: true });
  console.log(`[fetch-libnode] extracting -> ${installDir}`);
  const tar = spawnSync('tar', ['-xzf', tarPath, '-C', installDir], { stdio: 'inherit' });
  if (tar.status !== 0) {
    console.error('[fetch-libnode] tar extract failed (is `tar` on PATH?)');
    exit(tar.status ?? 1);
  }
  console.log(`[fetch-libnode] done. set RUNE_NODE_ROOT=${installDir}`);
}

main().catch((e) => { console.error(e); exit(1); });
