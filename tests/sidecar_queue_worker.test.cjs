const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('extensions/vertical-video-sidecar/service-worker.js', 'utf8');
const listeners = {};
let failNextWrite = false;
let stored = { queue: [], activeId: null };

function clone(value) { return JSON.parse(JSON.stringify(value)); }
const chrome = {
  storage: {
    local: {
      async get(defaults) { return { ...clone(defaults), ...clone(stored) }; },
      async set(value) {
        if (failNextWrite) { failNextWrite = false; throw new Error('simulated storage failure'); }
        await new Promise(resolve => setTimeout(resolve, 2));
        stored = { ...stored, ...clone(value) };
      },
    },
  },
  runtime: {
    onInstalled: { addListener(listener) { listeners.installed = listener; } },
    onMessage: { addListener(listener) { listeners.message = listener; } },
    onMessageExternal: { addListener(listener) { listeners.external = listener; } },
  },
  contextMenus: { removeAll(callback) { callback(); }, create() {}, onClicked: { addListener() {} } },
  sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
  commands: { onCommand: { addListener() {} } },
  tabs: {
    TAB_ID_NONE: -1,
    query: async () => [], get: async () => ({ url: 'https://example.test/' }),
    sendMessage: async () => {},
  },
  declarativeNetRequest: { updateSessionRules: async () => {} },
};

const context = vm.createContext({
  chrome, console, URL, Set, Date, Promise, setTimeout, atob: () => '',
  crypto: { randomUUID: (() => { let number = 0; return () => `generated-${++number}`; })() },
});
vm.runInContext(source, context, { filename: 'service-worker.js' });

function change(operation) {
  return new Promise((resolve) => {
    const keepAlive = listeners.message({ type: 'CHANGE_QUEUE', operation }, {}, resolve);
    assert.equal(keepAlive, true);
  });
}

(async () => {
  const a = { url: 'https://cdn.test/a.mp4', title: 'A' };
  const b = { url: 'https://cdn.test/b.mp4', title: 'B' };
  const [first, second] = await Promise.all([
    change({ kind: 'restore', item: a }),
    change({ kind: 'restore', item: b }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(stored.queue.map(item => item.url).sort(), [a.url, b.url]);

  const aId = stored.queue.find(item => item.url === a.url).id;
  const c = { url: 'https://cdn.test/c.mp4', title: 'C' };
  await Promise.all([
    change({ kind: 'remove', ids: [aId] }),
    change({ kind: 'restore', item: c }),
  ]);
  assert.deepEqual(stored.queue.map(item => item.url).sort(), [b.url, c.url]);

  failNextWrite = true;
  const failed = await change({ kind: 'restore', item: { url: 'https://cdn.test/fail.mp4' } });
  assert.equal(failed.ok, false);
  const recovered = await change({ kind: 'restore', item: { url: 'https://cdn.test/recovered.mp4' } });
  assert.equal(recovered.ok, true);
  assert.ok(stored.queue.some(item => item.url.endsWith('/recovered.mp4')));

  stored = {
    queue: Array.from({ length: 500 }, (_, index) => ({ id: `full-${index}`, url: `https://cdn.test/full-${index}.mp4` })),
    activeId: 'full-0',
  };
  const full = await change({ kind: 'restore', item: { url: 'https://cdn.test/overflow.mp4' } });
  assert.equal(full.ok, false);
  assert.equal(stored.queue.length, 500);
  assert.equal(stored.activeId, 'full-0');

  console.log('sidecar queue worker tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
