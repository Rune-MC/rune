function createRuneDashboard({ rune, telemetry, configs, panels, register }) {
  const contributions = new Map();
  let react;
  let data;
  const waiting = new Set();
  let monitoring = false;
  let installed = false;
  const id = (value) => {
    if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
      throw new TypeError('Dashboard IDs must be lowercase kebab-case and at most 64 characters');
    }
    return value;
  };
  const title = (value) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 120) throw new TypeError('Expected a dashboard title');
    return value.trim();
  };
  function callback(fn) {
    if (typeof fn !== 'function') throw new TypeError('Expected a dashboard callback');
    return telemetry.track('dashboard', fn);
  }
  function fields(schema = {}) {
    const entries = Object.entries(schema);
    if (entries.length > 24) throw new RangeError('Use at most 24 dashboard action fields');
    return Object.fromEntries(entries.map(([key, field]) => {
      id(key);
      if (key === 'csrf' || key === 'confirm') throw new TypeError('Reserved dashboard field: ' + key);
      if (!field || !['boolean', 'number', 'string'].includes(field.type)) throw new TypeError('Invalid dashboard field: ' + key);
      if (field.maxLength !== undefined && (!Number.isInteger(field.maxLength) || field.maxLength < 1 || field.maxLength > 8192)) {
        throw new RangeError('Invalid dashboard field length: ' + key);
      }
      for (const bound of ['min', 'max']) {
        if (field[bound] !== undefined && (field.type !== 'number' || !Number.isFinite(field[bound]))) {
          throw new TypeError('Invalid numeric bound: ' + key);
        }
      }
      if (field.min > field.max) throw new RangeError('Invalid dashboard field range: ' + key);
      if (field.choices && (field.type !== 'string' || Object.entries(field.choices).some(([value, label]) => !value || typeof label !== 'string'))) {
        throw new TypeError('Invalid dashboard field choices: ' + key);
      }
      return [key, Object.freeze({ ...field, choices: field.choices && Object.freeze({ ...field.choices }) })];
    }));
  }
  function items(values, parse) {
    const entries = Object.entries(values ?? {});
    if (entries.length > 50) throw new RangeError('Use at most 50 dashboard pages or actions in one contribution');
    return new Map(entries.map(([key, item]) => [id(key), Object.freeze(parse(item))]));
  }

  return {
    isInstalled: () => installed,
    whenInstalled(fn) {
      if (typeof fn !== 'function') throw new TypeError('Expected a dashboard installation callback');
      const scoped = telemetry.scope(fn);
      let disposed = false;
      let cleanup;
      const activate = () => {
        waiting.delete(activate);
        void Promise.resolve().then(() => {
          if (!disposed) return scoped();
        }).then((result) => {
          if (typeof result !== 'function') return;
          if (disposed) result();
          else cleanup = result;
        }).catch((error) => console.error('Rune dashboard integration failed:', error));
      };
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        waiting.delete(activate);
        cleanup?.();
      };
      telemetry.cleanup(dispose);
      if (installed) activate();
      else waiting.add(activate);
      return dispose;
    },
    register(spec) {
      if (telemetry.current()?.status === 'failed') throw new Error('This Rune failed to load');
      const key = id(spec.id);
      const label = title(spec.title);
      const parsePage = (page) => ({ title: title(page.title), render: callback(page.render) });
      const pages = items(spec.pages, parsePage);
      const navigation = spec.navigation ?? [{}];
      if (!Array.isArray(navigation) || navigation.length > 50) throw new TypeError('Use at most 50 dashboard navigation links');
      const links = new Map(navigation.map((link) => {
        const page = link.page === undefined ? undefined : id(link.page);
        if (page && !pages.has(page)) throw new Error('Dashboard navigation targets an unknown page: ' + page);
        return [page, Object.freeze({ page, label: link.label === undefined ? pages.get(page)?.title ?? label : title(link.label) })];
      }));
      const contribution = Object.freeze({
        id: key, title: label, description: spec.description, owner: telemetry.current()?.path,
        metrics: spec.metrics === undefined ? undefined : callback(spec.metrics),
        pages, navigation: Object.freeze([...links.values()]),
        overview: spec.overview === undefined ? undefined : Object.freeze(parsePage(spec.overview)),
        actions: items(spec.actions, (action) => ({
          title: title(action.title), description: action.description, confirm: action.confirm,
          fields: Object.freeze(fields(action.fields)), run: callback(action.run),
        })),
      });
      return register(contributions, key, contribution);
    },
    /** The launcher's view of the live registries, including older panel registrations. */
    monitor(runtime) {
      if (!runtime || typeof runtime.jsx !== 'function' || typeof runtime.jsxs !== 'function' || !runtime.react) {
        throw new TypeError('The dashboard monitor requires a React JSX runtime');
      }
      if (monitoring) throw new Error('A Rune dashboard monitor is already running');
      react = runtime;
      data ??= createDashboardData(rune, telemetry);
      monitoring = true;
      const collect = () => void data.collect().catch((error) => console.warn('Dashboard sample failed:', error));
      const sampleTimer = setInterval(collect, 5000);
      sampleTimer.unref();
      collect();
      let closed = false;
      function close() {
        if (closed) return;
        closed = true;
        clearInterval(sampleTimer);
        installed = false;
        monitoring = false;
      }
      telemetry.cleanup(close);
      return Object.freeze({
        snapshot: data.current, samples: () => data.samples.slice(), runes: data.runes,
        contributions: () => new Map(contributions), configs: () => new Map(configs), panels: () => new Map(panels),
        logs: () => telemetry.logs.slice(),
        reload: () => __rune_request_reload(),
        ready() {
          if (closed) throw new Error('The Rune dashboard monitor is closed');
          installed = true;
          for (const activate of [...waiting]) activate();
        },
        close,
      });
    },
    reactRuntime() {
      if (!react) throw new Error('Start @rune/dashboard before rendering dashboard JSX');
      return react;
    },
  };
}
