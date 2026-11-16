const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const bootstrap = ['telemetry.cjs', 'dashboard-data.cjs', 'dashboard.cjs', 'extensions.cjs']
  .map((file) => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n');

function setup() {
  const routes = new Map();
  const stores = new Map();
  let reloads = 0;
  const rune = {
    store(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      return stores.get(name);
    },
    runOnMain: async (fn) => fn(),
    callStatic: () => ({ server: { online: 3, tps: [20], mspt: 2 } }),
    serve(options, init) {
      assert.equal(options.host, '127.0.0.1');
      init({
        get: (url, handler) => routes.set(`GET ${url}`, handler),
        post: (url, handler) => routes.set(`POST ${url}`, handler),
      });
    },
  };
  const extensions = vm.runInNewContext(bootstrap + '\nruneExtensions;', {
    rune, require, structuredClone, Buffer, URLSearchParams, process, setInterval, clearInterval,
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    _fmt: (args) => args.join(' '),
    __rune_request_reload: () => reloads++,
  });
  return { rune, routes, extensions, reloads: () => reloads };
}

test('services, events, and recovery from a failed load', async () => {
  const { rune, extensions } = setup();
  const dispose = rune.services.provide('test.lookup', 1, { call: () => 99 });
  assert.equal(rune.services.get('test.lookup', 1).call(), 99);
  assert.equal(rune.services.get('test.lookup', 2), undefined);
  assert.throws(() => rune.services.provide('test.lookup', 1, {}), /Already registered/);
  dispose();
  assert.equal(rune.services.get('test.lookup', 1), undefined);

  await assert.rejects(extensions.load('broken.ts', () => {
    rune.services.provide('test.broken', 1, {});
    throw new Error('failed to initialize');
  }), /failed to initialize/);
  assert.equal(rune.services.get('test.broken', 1), undefined);

  rune.events.on('test.change', (data) => { data.count = 0; });
  let observed;
  const unsubscribe = rune.events.on('test.change', (data) => { observed = data.count; });
  await rune.events.emit('test.change', { count: 5 });
  assert.equal(observed, 5);
  unsubscribe();
  await rune.events.emit('test.change', { count: 9 });
  assert.equal(observed, 5);
});

test('dashboard integrations wait for readiness and retain Rune ownership', async () => {
  const { rune, extensions } = setup();
  let initialized = 0;
  await extensions.load('tool/index.ts', () => {
    rune.dashboard.whenInstalled(() => {
      initialized++;
      return rune.dashboard.register({
        id: 'tool', title: 'Tool', navigation: [{ page: 'settings', label: 'Tool settings' }],
        pages: { settings: { title: 'Settings', render: () => 'Page' } },
      });
    });
  });
  await assert.rejects(extensions.load('failed/index.ts', () => {
    rune.dashboard.whenInstalled(() => { initialized += 100; });
    throw new Error('test failed load');
  }));
  assert.equal(rune.dashboard.isInstalled(), false);
  assert.equal(initialized, 0);
  const monitor = rune.dashboard.monitor({ jsx() {}, jsxs() {}, react: {} });
  try {
    monitor.ready();
    await Promise.resolve();
    assert.equal(initialized, 1);
    assert.equal(rune.dashboard.isInstalled(), true);
    const tool = monitor.contributions().get('tool');
    assert.equal(tool.owner, 'tool/index.ts');
    assert.equal(tool.navigation[0].label, 'Tool settings');
    assert.equal(tool.pages.get('settings').render(), 'Page');
  } finally {
    monitor.close();
  }
  assert.equal(rune.dashboard.isInstalled(), false);
});

test('dashboard edits share the command schema and require credentials and CSRF', async () => {
  const { rune, routes, extensions, reloads } = setup();
  const config = rune.config('test.arena', {
    rounds: { default: 2, min: 1, max: 8 },
    active: { default: true, description: '<script>Injected</script>' },
  });
  rune.dashboard.panel('test.arena', 'Arena', () => ({ Active: config.read().active }));
  const token = 'local-test-password-123456789';
  rune.dashboard.start({ token });
  const authorization = 'Basic ' + Buffer.from(`rune:${token}`).toString('base64');

  function request(method, route, { body = '', headers = { authorization } } = {}) {
    const respond = (content, status = 200, extra = {}) => ({ content, status, headers: extra });
    return routes.get(`${method} ${route}`)({
      req: { method, headers, bytes: () => Buffer.from(body), text: async () => body },
      param: () => 'test.arena',
      text: respond,
      html: respond,
      redirect: respond,
    });
  }
  assert.equal((await request('GET', '/', { headers: {} })).status, 401);
  const { content } = await request('GET', '/');
  assert.match(content, /&lt;script&gt;Injected&lt;\/script&gt;/);
  const csrf = /name="csrf" value="([^"]+)"/.exec(content)[1];
  assert.equal((await request('POST', '/reload')).status, 403);
  assert.equal((await request('POST', '/reload', { body: `csrf=${csrf}` })).status, 202);
  assert.equal(reloads(), 1);

  const save = (body) => request('POST', '/settings/:id', { body: `csrf=${csrf}&${body}` });
  assert.equal((await save('rounds=50')).status, 400);
  assert.equal(config.read().rounds, 2);
  assert.equal((await save('rounds=4')).status, 303);
  assert.equal(config.read().active, false);
  assert.equal(config.read().rounds, 4);

  const messages = [];
  extensions.configCommand({ input: 'test.arena rounds 5', sender: { sendMessage: (m) => messages.push(m) } });
  assert.deepEqual(messages, ['Saved test.arena.rounds']);
  assert.equal(config.read().rounds, 5);
});
