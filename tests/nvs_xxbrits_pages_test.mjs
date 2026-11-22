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
    setTimeout() { return 0; },
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
        sendMessage(message, callback) { window.pendingRequests.push({ message, callback }); },
      },
    },
  });

  vm.runInContext(source, context, { filename: 'content.js' });
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

const ctx = createHarness('https://www.xxbrits.com/latest/');
const hooks = ctx.window.__nvsTestHooks;

assert.equal(hooks.isXxbritsPage(), true);
assert.equal(hooks.isVideoUrl('https://www.xxbrits.com/videos/30796/example-clip/'), true);
assert.equal(hooks.isVideoUrl('https://www.xxbrits.com/latest/'), false);

const parsed = hooks.parseKvsParameters('sort_by:post_date;from10:3');
assert.equal(parsed.sort_by, 'post_date');
assert.equal(parsed.from10, '3');
assert.equal(hooks.xxbritsFromKey({ from: '2', from10: '2' }), 'from10');
assert.equal(hooks.isXxbritsFromParam('from_videos'), true);
assert.equal(hooks.isXxbritsFromParam('from_videos24'), true);
assert.equal(hooks.xxbritsFromKey({ from_videos: '2', sort_by: 'relevance' }), 'from_videos');

const pageCases = [
  ['https://www.xxbrits.com/latest/', 1],
  ['https://www.xxbrits.com/latest/4/', 4],
  ['https://www.xxbrits.com/search/bbc/?from=3', 3],
  ['https://www.xxbrits.com/search/deepthroat-bbc-47L187/?from_videos=2', 2],
  ['https://www.xxbrits.com/playlists/8233/123455/', 1],
  ['https://www.xxbrits.com/videos/30796/example-clip/', 1],
  ['https://www.xxbrits.com/ct/milf/2/', 2],
];

for (const [url, current] of pageCases) {
  setLocation(ctx, url);
  assert.equal(hooks.getCurrentPageNumber(), current, url);
  assert.equal(hooks.getXxbritsCurrentPageFromUrl(url), current, url);
}

setLocation(ctx, 'https://www.xxbrits.com/latest/');
assert.equal(hooks.buildXxbritsPathUrl(5), 'https://www.xxbrits.com/latest/5/');

setLocation(ctx, 'https://www.xxbrits.com/latest/3/?sort_by=rating');
assert.equal(hooks.buildXxbritsPathUrl(7), 'https://www.xxbrits.com/latest/7/?sort_by=rating');

setLocation(ctx, 'https://www.xxbrits.com/playlists/8233/123455/');
assert.equal(
  hooks.buildXxbritsPathUrl(2),
  'https://www.xxbrits.com/playlists/8233/123455/2/'
);

setLocation(ctx, 'https://www.xxbrits.com/search/deepthroat-bbc-47L187/');
assert.equal(hooks.xxbritsFromKey({}), 'from_videos');
assert.equal(
  hooks.buildXxbritsPathUrl(2),
  'https://www.xxbrits.com/search/deepthroat-bbc-47L187/?from_videos=2'
);

const searchAjax = hooks.buildXxbritsAjaxUrl(3, {
  blockId: 'list_videos_videos_list_search_result',
  fromKey: 'from_videos',
  extraParams: { from_videos: '9' },
}, 'https://www.xxbrits.com/search/deepthroat-bbc-47L187/');
const searchAjaxUrl = new URL(searchAjax);
assert.equal(searchAjaxUrl.searchParams.get('from_videos'), '3');
assert.equal(searchAjaxUrl.pathname, '/search/deepthroat-bbc-47L187/');

const ajax = hooks.buildXxbritsAjaxUrl(4, {
  blockId: 'list_videos_most_recent_videos',
  fromKey: 'from10',
  sortBy: 'post_date',
  extraParams: {},
}, 'https://www.xxbrits.com/latest/');
const ajaxUrl = new URL(ajax);
assert.equal(ajaxUrl.searchParams.get('mode'), 'async');
assert.equal(ajaxUrl.searchParams.get('function'), 'get_block');
assert.equal(ajaxUrl.searchParams.get('block_id'), 'list_videos_most_recent_videos');
assert.equal(ajaxUrl.searchParams.get('from10'), '4');
assert.equal(ajaxUrl.searchParams.get('sort_by'), 'post_date');

assert.equal(
  hooks.buildXxbritsPageUrl(6, { blockId: 'playlist_view_playlist_view', fromKey: 'from' }),
  hooks.buildXxbritsAjaxUrl(6, { blockId: 'playlist_view_playlist_view', fromKey: 'from' })
);
assert.equal(
  hooks.buildXxbritsPageUrl(6, {}),
  hooks.buildXxbritsPathUrl(6)
);

console.log('nvs xxbrits pages tests passed');
