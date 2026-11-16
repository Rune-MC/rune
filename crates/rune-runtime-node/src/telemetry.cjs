// Rust canonicalizes package entry points on Windows, which returns verbatim paths.
function runeScriptIdentity(file, root, path) {
  const ordinary = (value) => value
    .replace(/^\\\\\?\\UNC\\/i, '\\\\')
    .replace(/^\\\\\?\\(?=[a-z]:[\\/])/i, '');
  const entry = ordinary(file);
  const relative = path.relative(ordinary(root), entry);
  const name = !relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)
    ? path.basename(entry)
    : relative.replaceAll(path.sep, '/');
  return { path: name, folder: name.split('/')[0] };
}

const createRuneTelemetry = () => {
  const { AsyncLocalStorage } = require('node:async_hooks');
  const path = require('node:path');
  const { realpathSync } = require('node:fs');
  const { performance } = require('node:perf_hooks');
  const owners = new AsyncLocalStorage();
  const scripts = new Map();
  const logs = [];
  let sequence = 0;
  let root = process.cwd();
  try { root = realpathSync.native(root); } catch { /* The original cwd is still usable. */ }

  function track(kind, fn) {
    const owner = owners.getStore();
    if (!owner) return fn;
    const stats = owner.activity[kind] ??= { registered: 0, calls: 0, errors: 0, syncMs: 0, maxMs: 0 };
    stats.registered++;
    return function (...args) {
      if (owner.status === 'failed') return;
      return owners.run(owner, () => {
        const start = performance.now();
        stats.calls++;
        const fail = (error) => {
          stats.errors++;
          owner.lastError = String(error?.message ?? error).slice(0, 500);
          throw error;
        };
        try {
          const result = fn.apply(this, args);
          return result && typeof result.then === 'function' ? Promise.resolve(result).catch(fail) : result;
        } catch (error) {
          return fail(error);
        } finally {
          const elapsed = performance.now() - start;
          stats.syncMs += elapsed;
          stats.maxMs = Math.max(stats.maxMs, elapsed);
        }
      });
    };
  }

  function log(level, text) {
    const owner = owners.getStore();
    logs.push({ id: ++sequence, at: Date.now(), rune: owner?.path ?? null, level, text: text.slice(0, 2000) });
    if (logs.length > 400) logs.shift();
    if (owner) owner.logCount++;
  }

  return {
    started: Date.now(),
    current: () => owners.getStore(),
    track,
    scope(fn) {
      const owner = owners.getStore();
      return owner ? () => owner.status === 'failed' ? undefined : owners.run(owner, fn) : fn;
    },
    log,
    logs,
    scripts,
    cleanup(dispose) {
      const owner = owners.getStore();
      if (owner?.status === 'loading') owner.cleanup.push(dispose);
    },
    async load(file, execute) {
      const identity = runeScriptIdentity(file, root, path);
      const owner = { ...identity, status: 'loading', started: Date.now(), loadMs: 0,
        activity: Object.create(null), logCount: 0, lastError: null, cleanup: [] };
      scripts.set(owner.path, owner);
      const start = performance.now();
      try {
        const result = await owners.run(owner, execute);
        owner.status = 'loaded';
        owner.cleanup.length = 0;
        return result;
      } catch (error) {
        owner.status = 'failed';
        owner.lastError = String(error?.message ?? error).slice(0, 500);
        for (const dispose of owner.cleanup.reverse()) {
          try { dispose(); } catch (cleanupError) { console.error('Rune cleanup failed:', cleanupError); }
        }
        owner.cleanup.length = 0;
        throw error;
      } finally {
        owner.loadMs = performance.now() - start;
      }
    },
  };
};
