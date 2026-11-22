const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../turbo_simpcity_content.js'), 'utf8');

function start(mode = 'healthy') {
  const calls = [];
  const pending = [];
  const intervals = new Map();
  let nextTimer = 0;
  let lastErrorReads = 0;
  const runtime = {
    id: 'test-extension',
    get lastError() {
      lastErrorReads++;
      return mode === 'disconnected' ? { message: 'Could not establish connection.' } : undefined;
    },
    sendMessage(message, callback) {
      calls.push(message);
      if (mode === 'throws') throw new Error('Extension context invalidated.');
      if (mode === 'pending') { pending.push(callback); return; }
      callback(message.action === 'NEXUS_TURBO_RESOLVE'
        ? { ok: true, streamUrl: 'https://cdn.example/video.mp4', duration: 120 }
        : { ok: true, contentLength: 1024 });
    },
  };
  const frame = { src: 'https://turbo.cr/embed/abc123', dataset: {} };
  const context = vm.createContext({
    chrome: mode === 'missing' ? undefined : { runtime },
    URL,
    location: { hostname: 'simpcity.cr', href: 'https://simpcity.cr/threads/example', pathname: '/threads/example' },
    localStorage: { getItem: () => null },
    sessionStorage: { getItem: () => null },
    document: {
      title: 'Forum', documentElement: { innerHTML: '' },
      querySelectorAll: (selector) => selector.startsWith('iframe[') ? [frame] : [],
    },
    performance: { getEntriesByType: () => [] },
    console: { log() {} },
    setInterval: (fn) => { intervals.set(++nextTimer, fn); return nextTimer; },
    clearInterval: (id) => intervals.delete(id),
  });
  context.window = context;
  context.top = context;
  vm.runInContext(source, context);
  return { context, calls, pending, intervals, errorReads: () => lastErrorReads };
}

test('forum embed still resolves metadata and caches the direct URL', () => {
  const app = start();
  assert.ok(app.calls.some((message) => message.action === 'FETCH_HEAD_INFO'));
  assert.ok(app.calls.some((message) => message.action === 'NEXUS_TURBO_CACHE_DIRECT'));
  assert.equal(app.intervals.size, 1);
  assert.equal(app.errorReads(), app.calls.length);
});

test('missing runtime at startup causes no messages or polling', () => {
  const app = start('missing');
  assert.equal(app.calls.length, 0);
  assert.equal(app.intervals.size, 0);
});

test('reload on an open forum tab retires its existing scan timer', () => {
  const app = start();
  const scan = [...app.intervals.values()][0];
  const count = app.calls.length;
  app.context.chrome.runtime = undefined;
  assert.doesNotThrow(scan);
  assert.equal(app.intervals.size, 0);
  assert.equal(app.calls.length, count);
});

test('synchronous invalidation stops further messages within the same scan', () => {
  const app = start('throws');
  assert.equal(app.calls.length, 1);
  assert.equal(app.intervals.size, 0);
});

test('a reply arriving after reload does not send nested HEAD/cache requests', () => {
  const app = start('pending');
  const count = app.calls.length;
  app.context.chrome.runtime = undefined;
  for (const callback of app.pending) {
    assert.doesNotThrow(() => callback({ ok: true, streamUrl: 'https://cdn.example/video.mp4' }));
  }
  assert.equal(app.calls.length, count);
  assert.equal(app.intervals.size, 0);
});

test('temporary receiver errors are consumed without retiring a valid runtime', () => {
  const app = start('disconnected');
  assert.equal(app.errorReads(), app.calls.length);
  assert.equal(app.intervals.size, 1);
  assert.ok(!app.calls.some((message) => message.action === 'NEXUS_TURBO_CACHE_DIRECT'));
});
