const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('extensions/nexus-video-selector/whoreshub-listing.js', 'utf8');

// Minimal DOM harness exercises pagination and buffered batches without network.
class Element {
  constructor(text = '') { this.textContent = text; this.children = []; this.listeners = {}; this.isConnected = true; }
  append(...nodes) { for (const n of nodes) this.children.push(...(n.fragment ? n.children : [n])); }
  after() {}
  setAttribute() {}
  getAttribute(k) { return this[k] || null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  async click() { for (const fn of this.listeners.click || []) fn({ stopImmediatePropagation() {} }); await flush(); }
  remove() { this.isConnected = false; }
  querySelector(selector) {
    if (selector.includes('a[href')) return this.anchor || null;
    if (selector.includes('.active')) return this.active || null;
    return this.controls?.[selector] || null;
  }
  querySelectorAll(selector) { return selector === '.thumb' || selector === 'a[data-parameters]' ? this.children : []; }
}
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
function harness({ total = 137, block = 'playlist_view_playlist_view', from = 'from', failingPage, duplicate = false } = {}) {
  const timers = [];
  const calls = [];
  const notices = [];
  const blockGrid = new Element(); blockGrid.id = block + '_items';
  const panel = new Element();
  panel.controls = Object.fromEntries(['#nvs-load-pages', '#nvs-load-until', '#nvs-load-label', '#nvs-panel-disable'].map(k => [k, new Element()]));
  const created = [];
  const makeCard = i => { const c = new Element(); c.anchor = new Element(); c.anchor.href = `/videos/${i}/video/`; return c; };
  function documentFor(page) {
    const grid = page === 1 ? blockGrid : new Element();
    for (let i = (page - 1) * 8 + 1; i <= Math.min(page * 8, total); i++) grid.append(makeCard(i));
    if (duplicate && page > 1) grid.append(makeCard(1));
    const nav = new Element(); nav.active = new Element(String(page));
    if (page * 8 < total) {
      const a = new Element('Next'); a['data-parameters'] = `sort_by:added2fav_date;fav_type:1;${from}:${page + 1}`; nav.append(a);
    }
    return { getElementById: id => id === block + '_items' ? grid : id === block + '_pagination' ? nav : null };
  }
  const doc = documentFor(1);
  Object.assign(doc, {
    querySelectorAll: () => [blockGrid],
    createElement: () => { const el = new Element(); created.push(el); return el; },
    createDocumentFragment: () => Object.assign(new Element(), { fragment: true }),
    importNode: n => n,
  });
  const context = {
    window: {}, document: doc, location: new URL('https://www.whoreshub.com/playlists/31597/sample/?q=keep'),
    URL, AbortController, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    requestAnimationFrame: fn => fn(),
    DOMParser: class { parseFromString(html) { return documentFor(Number(html)); } },
    async fetch(url, options) {
      const u = new URL(url); const page = Number(u.searchParams.get(from)); calls.push({ u, options });
      if (page === failingPage) return { ok: false, status: 503 };
      return { ok: true, text: async () => String(page) };
    },
  };
  vm.runInNewContext(source, context);
  context.window.NVSWhoreshubListing.attach(panel, { scan() {}, hydrateLazyImages() {}, showToast: text => notices.push(text) });
  return { context, calls, notices, grid: blockGrid, panel, created, async initial() { timers[0](); await flush(); }, more: panel.controls['#nvs-load-pages'], all: created.find(e => e.id === 'nvs-wh-all') };
}

test('first 50 then next 50 preserve a partially consumed page and deduplicate', async () => {
  const h = harness({ duplicate: true }); await h.initial();
  assert.equal(h.grid.children.length, 50);
  assert.equal(h.calls.length, 6);
  await h.more.click();
  assert.equal(h.grid.children.length, 100);
  await h.all.click();
  assert.equal(h.grid.children.length, 137);
  assert.equal(new Set(h.grid.children.map(c => c.anchor.href)).size, 137);
  assert.equal(h.more.disabled, true);
  assert.equal(h.all.disabled, true);
});
test('short playlist stops at its real end', async () => {
  const h = harness({ total: 42 }); await h.initial();
  assert.equal(h.grid.children.length, 42);
  assert.equal(h.calls.length, 5);
  assert.equal(h.more.disabled, true);
});
test('favorites and uploaded use their own block and cursor parameters', async () => {
  for (const [block, from] of [['list_videos_member_favourites', 'from_fav_videos'], ['list_videos_member_uploaded', 'from_videos']]) {
    const h = harness({ block, from }); await h.initial();
    assert.equal(h.grid.children.length, 50);
    const { u, options } = h.calls[0];
    assert.equal(u.searchParams.get('block_id'), block);
    assert.equal(u.searchParams.get(from), '2');
    assert.equal(u.searchParams.get('sort_by'), 'added2fav_date');
    assert.equal(u.searchParams.get('fav_type'), '1');
    assert.equal(u.searchParams.get('q'), 'keep');
    assert.equal(options.credentials, 'include');
  }
});
test('failure keeps appended videos and retries the failed page', async () => {
  const h = harness({ failingPage: 4 }); await h.initial();
  assert.equal(h.grid.children.length, 24);
  assert.match(h.notices[0], /503/);
  assert.equal(h.more.disabled, false);
  await h.more.click();
  assert.equal(h.calls.at(-1).u.searchParams.get('from'), '4');
  assert.equal(h.grid.children.length, 24);
});
test('login or unrelated HTML cannot be mistaken for the end of the requested list', async () => {
  const h = harness();
  h.context.DOMParser = class { parseFromString() { return { getElementById: () => null }; } };
  await h.initial();
  assert.equal(h.grid.children.length, 8);
  assert.match(h.notices[0], /požadovaný zoznam/);
  assert.equal(h.more.disabled, false);
});
test('busy all button stops without dropping the buffered batch', async () => {
  const h = harness(); await h.initial();
  h.all.listeners.click[0]();
  h.all.listeners.click[0]();
  await flush();
  const count = h.grid.children.length;
  assert.ok(count >= 50 && count < 137);
  await h.more.click();
  assert.equal(h.grid.children.length, Math.min(count + 50, 137));
});

test('Whoreshub .UTC dates parse and cached metadata missing date is refreshed', async () => {
  const cache = {};
  const url = 'https://www.whoreshub.com/videos/336996/sample/';
  cache['nvs_meta_v10:' + url] = { sizeMb: 100, date: null, ts: Date.now() };
  let requests = 0;
  const ctx = vm.createContext({ URL, AbortController, setTimeout, clearTimeout,
    chrome: { runtime: { onMessage: { addListener() {} } }, storage: { local: {
      async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, cache[k]])); },
      async set(values) { Object.assign(cache, values); }, remove() {},
    } } },
    async fetch() { requests++; return { ok: true, text: async () => '<script type="application/ld+json">{"@type":"VideoObject","uploadDate":"2024-09-17T12:07:09.UTC"}</script>' }; },
  });
  vm.runInContext(fs.readFileSync('extensions/nexus-video-selector/background.js', 'utf8'), ctx);
  ctx.url = url;
  const meta = await vm.runInContext('fetchVideoMeta(url, 1)', ctx);
  assert.equal(meta.date, 'Sep 17, 2024');
  assert.equal(requests, 1);
  await vm.runInContext('fetchVideoMeta(url, 1)', ctx);
  assert.equal(requests, 1);
  assert.equal(vm.runInContext("normalizeDate('garbage.UTC')", ctx), null);
});
