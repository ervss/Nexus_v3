import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('extensions/nexus-video-selector/content.js', 'utf8');

function createHarness(url) {
  const location = new URL(url);
  const storage = new Map();
  const window = {
    __NVS_ENABLE_TEST_HOOKS__: true,
    pendingRequests: [],
    pendingTimers: [],
    NVSPimpBunnyListing: { createTagLoader: () => null },
    addEventListener() {},
    CSS: { escape: (value) => String(value).replace(/"/g, '\\"') },
  };

  const document = {
    body: {},
    documentElement: { dataset: {} },
    activeElement: null,
    addEventListener() {},
    createElement() {
      return {
        appendChild() {},
        setAttribute() {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        style: {},
      };
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
  };
  document.activeElement = document.body;

  const context = vm.createContext({
    window,
    document,
    location,
    URL,
    Blob,
    setTimeout(callback, delay) { window.pendingTimers.push({ callback, delay }); return window.pendingTimers.length; },
    clearTimeout() {},
    setInterval() { return 0; },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    sessionStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
    chrome: {
      storage: {
        sync: { get(_defaults, _cb) {} },
      },
      runtime: {
        onMessage: { addListener() {} },
        sendMessage(message, callback) {
          return new Promise(resolve => {
            const complete = response => {
              callback?.(response);
              resolve(response);
            };
            window.pendingRequests.push({ message, callback: complete });
          });
        },
      },
    },
  });

  vm.runInContext(source.replace('window.__nvsState = state;', 'window.__nvsState = state; window.__queueTest = enqueue;'), context, { filename: 'content.js' });
  assert.ok(context.window.__nvsTestHooks, 'test hooks should be installed');
  return context;
}

function setLocation(context, url) {
  context.location.href = url;
  const parsed = new URL(url);
  context.location.protocol = parsed.protocol;
  context.location.hostname = parsed.hostname;
  context.location.host = parsed.host;
  context.location.pathname = parsed.pathname;
  context.location.search = parsed.search;
  context.location.hash = parsed.hash;
}

const ctx = createHarness('https://www.camwhores.tv/members/318493/');
const hooks = ctx.window.__nvsTestHooks;

assert.equal(hooks.isCamwhoresPage(), true);
assert.equal(hooks.isVideoUrl('https://www.camwhores.tv/videos/11424541/ashtens-empire-fishnets/'), true);
assert.equal(hooks.isVideoUrl('https://www.camwhores.tv/members/318493/'), false);

const pageCases = [
  ['https://www.camwhores.tv/members/318493/', 1, 'https://www.camwhores.tv/members/318493/2/'],
  ['https://www.camwhores.tv/members/318493/videos/', 1, 'https://www.camwhores.tv/members/318493/videos/2/'],
  ['https://www.camwhores.tv/members/318493/videos/3/', 3, 'https://www.camwhores.tv/members/318493/videos/2/'],
  ['https://www.camwhores.tv/playlists/335707/premium-hoes/', 1, 'https://www.camwhores.tv/playlists/335707/premium-hoes/2/'],
  ['https://www.camwhores.tv/most-popular/', 1, 'https://www.camwhores.tv/most-popular/2/'],
];

for (const [url, current, page2] of pageCases) {
  setLocation(ctx, url);
  assert.equal(hooks.getCurrentPageNumber(), current, url);
  assert.equal(hooks.buildPageUrl(2), page2, url);
}

setLocation(ctx, 'https://www.camwhores.tv/members/318493/');
const fakeCard = {
  matches: () => false,
  querySelectorAll: () => [
    { href: 'https://www.camwhores.tv/members/318493/', getAttribute: () => '/members/318493/' },
    { href: 'https://www.camwhores.tv/videos/11424541/ashtens-empire-fishnets/#comments', getAttribute: () => '/videos/11424541/ashtens-empire-fishnets/#comments' },
  ],
};
assert.equal(
  hooks.getCamwhoresVideoUrlFromNode(fakeCard),
  'https://www.camwhores.tv/videos/11424541/ashtens-empire-fishnets/'
);

const selected = [
  { streamUrl: 'https://cdn.example/a.mp4', url: 'https://page.example/a' },
  { streamUrl: 'https://cdn.example/b.mp4', url: 'https://page.example/b' },
  { streamUrl: 'https://cdn.example/c.mp4', url: 'https://page.example/c' },
];
const importSummary = hooks.summarizeImport(selected, {
  results: [
    { index: 0, url: selected[0].streamUrl, status: 'imported', video_id: 1 },
    { index: 1, url: selected[1].streamUrl, status: 'duplicate', video_id: 2 },
    { index: 2, url: selected[2].streamUrl, status: 'skipped', reason: 'too_short' },
  ],
});
assert.deepEqual([...importSummary.completedIndexes], [0, 1]);
assert.equal(importSummary.remaining, 1);
assert.match(importSummary.message, /Uložené: 1/);
assert.match(importSummary.message, /Už v knižnici: 1/);
assert.match(importSummary.message, /Krátke/);

for (const [url, limit] of [['https://www.camwhores.tv/', 16], ['https://pimpbunny.com/', 4]]) {
  const queueCtx = createHarness(url);
  const queueWindow = queueCtx.window;
  const queueCard = { querySelector() { return null; } };
  for (let i = 0; i < 20; i++) queueWindow.__queueTest(queueCard, `${url}videos/${i}/test/`);
  if (url.includes('camwhores')) {
    for (const timer of queueWindow.pendingTimers.filter(item => item.delay === 40)) timer.callback();
    assert.equal(queueWindow.pendingRequests.length, 1, 'CamWhores cards share a batched metadata request');
    assert.equal(queueWindow.pendingRequests[0].message.type, 'FETCH_CAMWHORES_META_BATCH');
    assert.equal(queueWindow.pendingRequests[0].message.items.length, 20);
    assert.equal(queueWindow.__nvsState.queue.length, 0);
    assert.ok(queueWindow.pendingRequests[0].message.items.every(item => item.force === false), 'normal scans must use persistent cache');
  } else {
    assert.equal(queueWindow.pendingRequests.length, limit, `${url}: site-specific concurrency`);
    assert.equal(queueWindow.__nvsState.queue.length, 20 - limit);
    assert.ok(queueWindow.pendingRequests.every(request => request.message.force === false), 'normal scans must use persistent cache');
    queueWindow.pendingRequests[0].callback({ meta: null });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(queueWindow.pendingRequests.length, limit + 1, 'next card starts as soon as one completes');
  }
  queueWindow.__nvsState.isRescanActive = true;
  queueWindow.__queueTest(queueCard, `${url}videos/99/test/`);
  assert.equal(queueWindow.__nvsState.queue.at(-1).force, true, 'explicit rescan must still refresh missing sizes');
}

console.log('nvs camwhores content tests passed');
