
const runeExtensions = (() => {
  const rune = globalThis.rune;
  const telemetry = createRuneTelemetry();
  const services = new Map();
  const topics = new Map();
  const configs = new Map();
  const panels = new Map();
  const { randomBytes, timingSafeEqual } = require('node:crypto');
  const { readFileSync, readdirSync } = require('node:fs');
  const { join } = require('node:path');
  const started = new Date(telemetry.started).toISOString();
  const scripts = telemetry.scripts;
  globalThis.__rune_track = telemetry.track;
  globalThis.__rune_cleanup = telemetry.cleanup;

  function identifier(id) {
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*(?:[./:][a-z][a-z0-9-]*)*$/.test(id)) {
      throw new TypeError('Expected a lowercase Rune identifier');
    }
    return id;
  }

  function register(registry, key, entry) {
    if (registry.has(key)) throw new Error(`Already registered: ${key}`);
    registry.set(key, entry);
    const dispose = () => {
      if (registry.get(key) === entry) registry.delete(key);
    };
    telemetry.cleanup(dispose);
    return dispose;
  }

  function serviceKey(id, major) {
    if (!Number.isSafeInteger(major) || major < 1) throw new TypeError('Expected a positive service major version');
    return `${identifier(id)}@${major}`;
  }

  rune.services = Object.freeze({
    provide(id, major, service) {
      if (!service || typeof service !== 'object') throw new TypeError('Expected a service object');
      return register(services, serviceKey(id, major), service);
    },
    get(id, major) {
      return services.get(serviceKey(id, major));
    },
  });

  rune.events = Object.freeze({
    on(topic, handler) {
      const key = identifier(topic);
      if (typeof handler !== 'function') throw new TypeError('Expected an event handler');
      const listeners = topics.get(key) ?? new Set();
      const registration = { handler: telemetry.track('signals', handler) };
      listeners.add(registration);
      topics.set(key, listeners);
      const dispose = () => {
        listeners.delete(registration);
        if (!listeners.size && topics.get(key) === listeners) topics.delete(key);
      };
      telemetry.cleanup(dispose);
      return dispose;
    },
    async emit(topic, payload) {
      const listeners = [...(topics.get(identifier(topic)) ?? [])];
      for (const { handler } of listeners) {
        try {
          await handler(structuredClone(payload));
        } catch (error) {
          console.error(`Rune event ${topic} failed:`, error);
        }
      }
    },
  });

  function checkField(key, field, value) {
    if (typeof value !== typeof field.default ||
        (typeof value === 'number' && (!Number.isFinite(value) ||
          value < (field.min ?? -Infinity) || value > (field.max ?? Infinity)))) {
      throw new TypeError(`Invalid value for ${key}`);
    }
    return value;
  }

  rune.config = function (id, fields) {
    const key = identifier(id);
    const schema = Object.fromEntries(Object.entries(fields).map(([name, field]) => {
      identifier(name);
      if (!['boolean', 'string', 'number'].includes(typeof field?.default)) {
        throw new TypeError(`Setting ${name} needs a boolean, string, or number default`);
      }
      checkField(name, field, field.default);
      return [name, Object.freeze({ ...field })];
    }));
    const store = rune.store(`config-${encodeURIComponent(key)}`);
    function read() {
      const values = store.get('settings') ?? {};
      return Object.fromEntries(Object.entries(schema).map(([name, field]) => {
        let value = field.default;
        if (Object.hasOwn(values, name)) {
          try { value = checkField(name, field, values[name]); } catch { /* use the current default */ }
        }
        return [name, value];
      }));
    }
    function update(patch) {
      const next = read();
      for (const [name, value] of Object.entries(patch)) {
        if (!Object.hasOwn(schema, name)) throw new TypeError(`Unknown setting: ${name}`);
        next[name] = checkField(name, schema[name], value);
      }
      store.set('settings', next);
      return next;
    }
    register(configs, key, { schema, read, update, owner: telemetry.current()?.path });
    if (!store.has('settings')) store.set('settings', read());
    return Object.freeze({ read, update });
  };



  const escape = (text) => String(text).replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const definitionList = (values) => '<dl>' + Object.entries(values).map(([label, value]) =>
    `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('') + '</dl>';

  function installedPackages() {
    const root = process.cwd();
    const packages = [];
    for (const folder of readdirSync(root, { withFileTypes: true })) {
      if (!folder.isDirectory() || folder.name.startsWith('.')) continue;
      let metadata;
      try {
        metadata = JSON.parse(readFileSync(join(root, folder.name, '.rune-install.json'), 'utf8'));
      } catch {
        continue;
      }
      if (typeof metadata?.name === 'string' && typeof metadata.version === 'string') {
        packages.push([metadata.name, metadata.version]);
      }
    }
    return Object.fromEntries(packages);
  }
  const pageStyle = `html{color-scheme:light dark;font:16px system-ui}body{max-width:56rem;margin:3rem auto;padding:0 1rem}
section{border-block-start:1px solid GrayText;margin-block:2rem;padding-block-start:1rem}
label{display:block}input,button{font:inherit;margin:.35rem 0 1rem;padding:.4rem;max-width:100%;min-height:2.5rem}
input[type=checkbox]{min-height:0}input[type=checkbox]+label{display:inline}
form{margin-block:1rem}dt{font-weight:600}dd{margin:0 0 .65rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}
small{display:block}fieldset{border:0;padding:0}legend{font-weight:600;font-size:1.15rem}`;

  function authorized(context, expected) {
    const headers = Object.entries(context.req.headers);
    const authorization = headers.find(([key]) => key.toLowerCase() === 'authorization')?.[1];
    if (typeof authorization !== 'string' || !authorization.startsWith('Basic ')) return false;
    const actual = Buffer.from(authorization.slice(6), 'base64');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  function fieldControl(formId, name, spec, value) {
    const id = `${formId}-${name}`;
    const help = spec.description ? `<small id="${id}-help">${escape(spec.description)}</small>` : '';
    const props = `id="${id}" name="${escape(name)}"` + (help ? ` aria-describedby="${id}-help"` : '');
    const label = `<label for="${id}">${escape(spec.label ?? name)}</label>`;
    if (typeof value === 'boolean') {
      return `<div><input ${props} type="checkbox" value="true"${value ? ' checked' : ''}> ${label}${help}</div>`;
    }
    const isNumber = typeof value === 'number';
    return `${label}${help}<input ${props} type="${isNumber ? 'number' : 'text'}" value="${escape(value)}"${isNumber ? ' required step="any"' : ''}${isNumber && Number.isFinite(spec.min) ? ` min="${spec.min}"` : ''}${isNumber && Number.isFinite(spec.max) ? ` max="${spec.max}"` : ''}>`;
  }

  const dashboard = createRuneDashboard({ rune, telemetry, configs, panels, register });
  rune.dashboard = Object.freeze({
    ...dashboard,
    panel(id, title, read) {
      if (typeof read !== 'function') throw new TypeError('Expected a function returning panel fields');
      return register(panels, identifier(id), { title, read: telemetry.track('dashboard', read), owner: telemetry.current()?.path });
    },
    start({ port = 8777, token }) {
      if (typeof token !== 'string' || token.length < 24) throw new Error('Use a dashboard password of at least 24 characters');
      const expected = Buffer.from(`rune:${token}`);
      const csrf = randomBytes(24).toString('hex');
      const hidden = `<input type="hidden" name="csrf" value="${csrf}">`;
      const headers = {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
      };
      const guard = (handler) => async (ctx) => {
        if (!authorized(ctx, expected)) {
          return ctx.text('Sign in to Rune', 401, { ...headers, 'WWW-Authenticate': 'Basic realm="Rune", charset="UTF-8"' });
        }
        if (ctx.req.method === 'GET') return handler(ctx);
        if (ctx.req.bytes().length > 16 * 1024) return ctx.text('Form is too large', 413, headers);
        const form = new URLSearchParams(await ctx.req.text());
        if (form.get('csrf') !== csrf) return ctx.text('Invalid form token. Refresh the dashboard.', 403, headers);
        return handler(ctx, form);
      };
      return rune.serve({ port, host: '127.0.0.1' }, (app) => {
        app.get('/', guard(async (ctx) => {
          const settings = [...configs].map(([id, { schema, read }], index) => {
            const values = read();
            const formId = `settings-${index}`;
            const controls = Object.entries(schema).map(([name, spec]) =>
              fieldControl(formId, name, spec, values[name])).join('');
            return `<form method="post" action="/settings/${encodeURIComponent(id)}" aria-labelledby="${formId}"><fieldset><legend id="${formId}">${escape(id)}</legend>${hidden}${controls}<br><button type="submit">Save settings</button></fieldset></form>`;
          }).join('');
          const output = await rune.runOnMain(() => [...panels.values()].map(({ title, read }) => {
            try { return `<section><h2>${escape(title)}</h2>${definitionList(read())}</section>`; }
            catch (error) { return `<section><h2>${escape(title)}</h2><p>${escape(error.message)}</p></section>`; }
          }).join(''));
          return ctx.html(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rune server</title><style>${pageStyle}</style><main>
<h1>Rune server</h1><section><h2>Runtime</h2><p>Started <time datetime="${started}">${started}</time></p>
${definitionList(Object.fromEntries([...scripts].map(([path, script]) => [path, script.status])))}
<form method="post" action="/reload" aria-label="Reload Runes">${hidden}<button type="submit">Reload Runes</button></form></section>
<section><h2>Installed packages</h2>${definitionList(installedPackages())}</section>
${settings ? `<section><h2>Settings</h2>${settings}</section>` : ''}${output}
<section><h2>Recent script logs</h2><pre>${escape(telemetry.logs.map((entry) => '[' + entry.level + '] ' + entry.text).join('\n'))}</pre></section></main></html>`, 200, headers);
        }));
        app.post('/settings/:id', guard((ctx, form) => {
          const config = configs.get(ctx.param('id'));
          if (!config) return ctx.text('Settings not found', 404, headers);
          const patch = {};
          for (const [name, field] of Object.entries(config.schema)) {
            const input = form.get(name);
            const type = typeof field.default;
            if (type === 'boolean') patch[name] = input !== null;
            else if (input !== null) patch[name] = type === 'number' && input.trim() ? Number(input) : input;
          }
          try { config.update(patch); }
          catch (error) { return ctx.text(error.message, 400, headers); }
          return ctx.redirect('/', 303);
        }));
        app.post('/reload', guard((ctx) => {
          __rune_request_reload();
          return ctx.html('<!doctype html><title>Reload requested</title><p>Reload requested. <a href="/">Return to the dashboard</a> after the server reloads.</p>', 202, headers);
        }));
      });
    },
  });

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level];
    console[level] = (...args) => {
      telemetry.log(level, _fmt(args));
      original(...args);
    };
  }

  return {
    configSuggestions(input) {
      const parts = input.split(/\s+/);
      if (parts.length === 1) return [...configs.keys()];
      const [id, key] = parts;
      const settings = configs.get(id);
      if (!settings) return [];
      const prefix = input.slice(0, input.length - parts.at(-1).length);
      if (parts.length === 2) return Object.keys(settings.schema).map((name) => prefix + name);
      const field = Object.hasOwn(settings.schema, key) ? settings.schema[key] : undefined;
      if (!field || parts.length > 3) return [];
      const values = typeof field.default === 'boolean' ? [true, false] :
        [settings.read()[key], field.default, field.min, field.max];
      return values.filter((value) => value !== undefined).map((value) => prefix + value);
    },
    configCommand({ input, sender }) {
      const [id, key, ...parts] = input.trim().split(/\s+/);
      if (!id) {
        sender.sendMessage(`Rune settings: ${[...configs.keys()].join(', ') || 'none'}`);
        return;
      }
      const settings = configs.get(id);
      if (!settings) {
        sender.sendMessage(`No settings registered for ${id}`);
        return;
      }
      try {
        if (!key) {
          sender.sendMessage(JSON.stringify(settings.read()));
          return;
        }
        if (!Object.hasOwn(settings.schema, key)) throw new Error(`Unknown setting: ${key}`);
        if (!parts.length) {
          sender.sendMessage(`${key} = ${JSON.stringify(settings.read()[key])}`);
          return;
        }
        const text = parts.join(' ');
        const value = typeof settings.schema[key].default === 'string' ? text : JSON.parse(text);
        settings.update({ [key]: value });
        sender.sendMessage(`Saved ${id}.${key}`);
      } catch (error) {
        sender.sendMessage(error.message);
      }
    },
    load: telemetry.load,
  };
})();
