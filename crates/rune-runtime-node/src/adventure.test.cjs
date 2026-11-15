const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const bootstrap = fs.readFileSync(path.join(__dirname, 'adventure.cjs'), 'utf8');

test('Adventure preserves literal interpolation, routes titles, and accepts Paper names', () => {
  const calls = [];
  const component = { __class: 'Component', text: 'styled' };
  const rune = {
    bukkit: {
      getOnlinePlayers: () => ['Alex', 'Sam'],
      getWorld: (name) => name === 'world' ? { name } : null,
    },
    callStatic(clazz, method, ...args) {
      assert.equal(clazz, 'app.rune.AdventurePrimitives');
      calls.push([method, ...args]);
      if (method === 'player') return args[0];
      if (method === 'literalTag' || method === 'componentTag') return args;
      return { __class: 'Component', text: method };
    },
  };
  const packages = new Proxy({}, { get: () => packages });
  vm.runInNewContext(bootstrap, {
    rune, kyori: packages, bukkit: packages,
    _looksLikeComponent: (value) => value?.__class === 'Component',
  });
  const a = rune.adventure;
  const recipient = {
    sendMessage: (message) => calls.push(['send', message.text]),
    showTitle: (title) => calls.push(['showTitle', title.text]),
  };
  a.send(recipient, '<red>literal');
  assert.deepEqual(calls.shift(), ['text', '<red>literal', null]);
  assert.deepEqual(calls.shift(), ['send', 'text']);
  a.format`<gold>${'<red>literal'} ${component}</gold>`;
  assert.deepEqual(calls.shift(), ['literalTag', 'rune_arg_0', '<red>literal']);
  assert.deepEqual(calls.shift(), ['componentTag', 'rune_arg_1', component]);
  const [method, template, tags] = calls.shift();
  assert.equal(method, 'deserialize');
  assert.equal(template, '<gold><rune_arg_0> <rune_arg_1></gold>');
  assert.equal(tags.length, 2);

  rune.title([recipient], '<gold>Match', component, { stayMs: 1200 });
  assert.equal(calls.shift()[1], '<gold>Match');
  const [titleMethod, title, subtitle, fadeIn, stay, fadeOut] = calls.shift();
  assert.equal(titleMethod, 'title');
  assert.equal(title.text, 'deserialize');
  assert.equal(subtitle, component);
  assert.deepEqual([fadeIn, stay, fadeOut], [500, 1200, 500]);
  assert.deepEqual(calls.shift(), ['showTitle', 'title']);
  assert.equal(rune.player('Alex'), 'Alex');
  assert.deepEqual(rune.players((name) => name.startsWith('A')), ['Alex']);
  assert.equal(rune.world('world').name, 'world');
});
