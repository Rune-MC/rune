// Node ESM loader hook: transforms .ts / .tsx files through esbuild-wasm
// so user scripts can use TypeScript syntax that Node's built-in amaro
// 1.1.8 strip/transform pipeline can't handle yet -- crucially: Stage 3
// class field/method decorators, full enums, namespaces, parameter
// properties.
//
// Registered by the Rune bootstrap via module.register() BEFORE any user
// script imports run, so even cross-file `.ts` imports go through here.
//
// Performance: esbuild WASM init costs ~50ms once; per-file transform is
// sub-millisecond. We init lazily on the first .ts load and reuse the
// service for everything after.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// esbuild-wasm in Node mode SPAWNS a child node process that drives the
// WASM (Go runtime); it doesn't use wasmURL / wasmModule (those are the
// browser-only APIs). The Node entry expects the canonical npm layout
//   <dir>/lib/main.js
//   <dir>/bin/esbuild
//   <dir>/esbuild.wasm
// which RuntimeAssetExtractor preserves. We just `require('./lib/main.js')`
// and call `esbuild.transform(...)` directly -- no initialize step.
const require = createRequire(import.meta.url);
const esbuildDir = process.env.RUNE_ESBUILD_DIR;
if (!esbuildDir) {
  throw new Error('ts-loader: RUNE_ESBUILD_DIR not set');
}
const esbuild = require(`${esbuildDir}/lib/main.js`);

// Node loader hook contract: https://nodejs.org/api/module.html#hooks
//
// We only override `load` -- resolve uses the default. The default
// resolver does see `.ts` / `.tsx` as valid suffixes since Node 22's
// strip-types is enabled, so paths resolve correctly; we only need to
// hijack the actual load step to run esbuild instead of amaro.
const isTs = (url) => url.endsWith('.ts') || url.endsWith('.tsx');

// Virtual module specifier. `import { mm, papi } from 'rune'` becomes a
// re-export-all module sourced from runtime/aliases.json. This lets
// scripts opt out of globals and instead pull their aliases explicitly
// (better for module isolation + tree-shaking awareness).
const RUNE_VIRTUAL_URL = 'rune:globals';

// For relative/absolute imports that omit a file extension (e.g.
// `import "./lib/foo"`), Node ESM strict resolution gives up with
// ERR_MODULE_NOT_FOUND. Bundlers add ".ts" / ".tsx" / "/index.ts"
// automatically; we replicate that here so user scripts can write
// the same import shape they'd use with esbuild, vite, or tsc with
// "moduleResolution":"bundler".
const TS_EXT_CANDIDATES = ['.ts', '.tsx', '/index.ts', '/index.tsx'];
const HAS_EXT = /\.[a-zA-Z0-9]+$/;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'rune') {
    return { url: RUNE_VIRTUAL_URL, shortCircuit: true, format: 'module' };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    // Only intercept the "no extension" case. Bare specifiers
    // (node_modules), absolute file:// URLs with an extension, etc.
    // bubble up unchanged.
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
    if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !isRelative || HAS_EXT.test(specifier)) {
      throw err;
    }
    for (const ext of TS_EXT_CANDIDATES) {
      try {
        return await nextResolve(specifier + ext, context);
      } catch (inner) {
        if (inner?.code !== 'ERR_MODULE_NOT_FOUND') throw inner;
      }
    }
    throw err;
  }
}

export async function load(url, context, nextLoad) {
  if (url === RUNE_VIRTUAL_URL) {
    // Read the alias config and emit a one-line-per-alias ESM module
    // that re-exports each from globalThis. The bootstrap binds those
    // globals at boot, so re-export is just a name-aliasing trick.
    let aliases = {};
    try {
      const raw = await readFile(`${esbuildDir}/aliases.json`, 'utf8');
      aliases = JSON.parse(raw);
    } catch (_) { /* no aliases configured */ }
    const lines = ['export {};'];
    for (const name of Object.keys(aliases)) {
      lines.push(`export const ${name} = globalThis.${name};`);
    }
    return {
      format: 'module',
      source: lines.join('\n'),
      shortCircuit: true,
    };
  }
  // Strip cache-busting `?t=...` query from our own __rune_load_script.
  const cleanUrl = url.replace(/\?[^#]*$/, '');
  if (!isTs(cleanUrl)) {
    return nextLoad(url, context);
  }
  const source = await readFile(fileURLToPath(cleanUrl), 'utf8');
  const result = await esbuild.transform(source, {
    loader: cleanUrl.endsWith('.tsx') ? 'tsx' : 'ts',
    target: 'es2022',
    format: 'esm',
    sourcefile: fileURLToPath(cleanUrl),
    sourcemap: 'inline',
    // Stage 3 (TC39) decorators -- matches the runtime our bootstrap's
    // @Command / @Arg / @Run implementations expect. Set
    // experimentalDecorators: true if you want the legacy TS form.
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: false,
        target: 'es2022',
        useDefineForClassFields: true,
      },
    },
  });
  return {
    format: 'module',
    source: result.code,
    shortCircuit: true,
  };
}
