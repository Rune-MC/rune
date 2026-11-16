function createDashboardData(rune, telemetry) {
  const { readFile, readdir } = require('node:fs/promises');
  const { join } = require('node:path');
  const os = require('node:os');
  const { performance } = require('node:perf_hooks');
  const samples = [];
  let latest;
  let collecting;
  let hostWarning = false;
  let previousCpu = process.cpuUsage();
  let previousTime = performance.now();
  let previousLoop = performance.eventLoopUtilization();
  let installCache;

  function collect() {
    if (collecting) return collecting;
    collecting = rune.runOnMain(() => rune.callStatic('app.rune.DashboardHost', 'snapshot')).catch((error) => {
      if (!hostWarning) console.warn('Could not read dashboard server statistics:', error);
      hostWarning = true;
      return null;
    }).then((host) => {
      if (host) hostWarning = false;
      const now = performance.now();
      const nextCpu = process.cpuUsage();
      const nextLoop = performance.eventLoopUtilization();
      const difference = nextCpu.user + nextCpu.system - previousCpu.user - previousCpu.system;
      const mem = process.memoryUsage();
      const sample = { at: Date.now(), rss: mem.rss, players: host?.server?.online ?? null,
        tps: host?.server?.tps?.[0] ?? null, mspt: host?.server?.mspt ?? null,
        cpu: now > previousTime ? Math.max(0, difference / ((now - previousTime) * 10)) : null };
      latest = { host, process: {
        ...mem, pid: process.pid, platform: process.platform + ' / ' + process.arch, node: process.version,
        uptimeMs: process.uptime() * 1000, cores: os.availableParallelism(),
        physicalMemory: os.totalmem(), freeMemory: os.freemem(),
        eventLoop: performance.eventLoopUtilization(nextLoop, previousLoop).utilization * 100,
      } };
      previousCpu = nextCpu;
      previousLoop = nextLoop;
      previousTime = now;
      samples.push(sample);
      while (samples.length > 181 || samples[0].at < sample.at - 15 * 60_000) samples.shift();
      return latest;
    }).finally(() => { collecting = undefined; });
    return collecting;
  }

  async function installed() {
    if (installCache && installCache.expiresAt > Date.now()) return installCache.entries;
    const entries = new Map();
    try {
      const root = process.cwd();
      const folders = await readdir(root, { withFileTypes: true });
      for (const folder of folders) {
        if (!folder.isDirectory() || folder.name.startsWith('.') || folder.name === 'node_modules') continue;
        try {
          const metadata = JSON.parse(await readFile(join(root, folder.name, '.rune-install.json'), 'utf8'));
          if (typeof metadata.name === 'string' && typeof metadata.version === 'string') entries.set(folder.name, metadata);
        } catch { /* A local script can have no Runebook metadata. */ }
      }
    } catch (error) {
      console.warn('Could not read dashboard package metadata:', error);
    }
    installCache = { expiresAt: Date.now() + 30_000, entries };
    return entries;
  }

  async function runes() {
    const packages = await installed();
    const native = latest?.host?.scripts ?? {};
    const key = (id) => process.platform === 'win32' ? id.toLowerCase() : id;
    const scripts = new Map(Object.entries(native).map(([id, status]) => [key(id), status]));
    const libraryIds = latest?.host?.libraries ?? [];
    const libraries = new Set(libraryIds.map(key));
    const owned = new Map([...telemetry.scripts.values()].map((script) => [key(script.folder), script]));
    const ids = new Map();
    for (const id of [...packages.keys(), ...Object.keys(native), ...libraryIds, ...[...owned.values()].map((script) => script.folder)]) {
      if (id && !ids.has(key(id))) ids.set(key(id), id);
    }
    return [...ids].map(([normalized, id]) => {
      const { name = id, version } = packages.get(id) ?? {};
      const script = owned.get(normalized);
      return { id, name, version, script,
        status: script?.status ?? scripts.get(normalized) ?? (libraries.has(normalized) ? 'Library' : 'Installed') };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  return { samples, runes, collect, current: () => latest };
}
