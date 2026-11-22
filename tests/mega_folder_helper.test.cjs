const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadHelper(prefs = { sort: 'sizeAsc' }) {
  const source = fs.readFileSync(path.join(__dirname, '../userscripts/mega-folder-enhancer.user.js'), 'utf8').replace(/\r\n/g, '\n')
    .replace('  injectStyles();\n  boot();',
      '  globalThis.helper = { syncNativeSort, formatAddedDate, applyDateBadge, qualityLabel, nativeVideoMetadata, state, buildFilterContext, passesFilters, compareItems, qualityBucket, onPanelClick, applyLayout, splitItems, folderSnapshotForHub };');
  const calls = [];
  const model = {
    currentdirid: 'folderA', v: [{ s: 10 }, { s: 90 }], d: {},
    sortmode: { n: 'name', d: 1 },
    doSort(n, d) {
      calls.push([n, d]);
      this.sortmode = { n, d };
      this.v.sort((a, b) => (a.s - b.s) * d);
    },
    renderMain() { calls.push('render'); }
  };
  const context = {
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    URL,
    window: {}, unsafeWindow: { M: model }, console,
    clearTimeout() {},
    location: { href: 'https://mega.nz/folder/root#key', origin: 'https://mega.nz', pathname: '/folder/root', hash: '#key/folder/folderA' },
    localStorage: { getItem: () => JSON.stringify({ folderUrl: 'https://mega.nz/folder/root#key', ...prefs }), setItem() {} },
    document: { getElementById: () => null, querySelectorAll: () => [], createElement: () => ({ textContent: '', remove() {} }) }
  };
  vm.runInNewContext(source, context);
  return { ...context, calls, model };
}

test('preserves chosen sort on entry and folder changes without repeated rendering', () => {
  const { helper, model, location, calls } = loadHelper();
  helper.syncNativeSort();
  assert.equal(helper.state.sort, 'sizeAsc');
  assert.deepEqual(model.v.map(n => n.s), [10, 90]);
  helper.syncNativeSort();
  assert.equal(calls.length, 2);
  helper.state.sort = 'sizeAsc';
  helper.syncNativeSort();
  assert.deepEqual(model.v.map(n => n.s), [10, 90]);
  model.currentdirid = 'folderB';
  location.hash = '#key/folder/folderB';
  helper.syncNativeSort();
  assert.deepEqual(model.v.map(n => n.s), [10, 90]);
});

test('stored filters from a different share are reset while the dashboard port stays set', () => {
  const { helper } = loadHelper({ folderUrl: 'https://mega.nz/folder/elsewhere#key', sort: 'sizeAsc', port: 8002 });
  assert.equal(helper.state.sort, 'sizeDesc');
  assert.equal(helper.state.port, 8002);
});

function video(itemHandle, height) {
  return { type: 'video', megaHandle: itemHandle, label: itemHandle, lower: itemHandle, durationSeconds: 60, sizeBytes: 100, el: { dataset: {} } };
}

test('multiple quality selections persist and filter by OR while other filters use AND', () => {
  const { helper, model, unsafeWindow } = loadHelper({ qualities: ['720', '1080', 'invalid', '720'], sort: 'qualityDesc' });
  unsafeWindow.MediaAttribute = function (node) { this.data = node.meta; };
  for (const [h, height] of [['a720', 720], ['a1080', 1080], ['a4k', 2160], ['odd', 900], ['unknown', 0]]) model.d[h] = { meta: { width: 1920, height } };
  assert.deepEqual(Array.from(helper.state.qualities), ['720', '1080']);
  assert.equal(helper.state.sort, 'qualityDesc');
  let ctx = helper.buildFilterContext();
  assert.equal(helper.passesFilters(video('a720'), ctx), true);
  assert.equal(helper.passesFilters(video('a1080'), ctx), true);
  assert.equal(helper.passesFilters(video('odd'), ctx), true);
  assert.equal(helper.passesFilters(video('a4k'), ctx), false);
  assert.equal(helper.passesFilters(video('unknown'), ctx), false);
  helper.state.q = '1080';
  ctx = helper.buildFilterContext();
  assert.equal(helper.passesFilters(video('a720'), ctx), false);
  assert.equal(helper.passesFilters(video('a1080'), ctx), true);
  helper.state.q = '';
  helper.state.qualities = ['unknown'];
  assert.equal(helper.passesFilters(video('unknown'), helper.buildFilterContext()), true);
  helper.state.qualities = [];
  assert.equal(helper.passesFilters(video('a4k'), helper.buildFilterContext()), true);
  assert.equal(helper.qualityBucket(360), 'sd');
  assert.equal(helper.qualityBucket(2160), '2160');
});

test('quality buttons toggle independently and All clears the selection', () => {
  const { helper, window } = loadHelper();
  window.setTimeout = () => 0;
  function click(attrs) {
    helper.onPanelClick({ target: { closest: () => ({ getAttribute: name => attrs[name] ?? null }) } });
  }
  click({ 'data-quality': '720' });
  click({ 'data-quality': '1080' });
  assert.deepEqual(Array.from(helper.state.qualities), ['720', '1080']);
  click({ 'data-quality': '720' });
  assert.deepEqual(Array.from(helper.state.qualities), ['1080']);
  click({ 'data-action': 'quality-all' });
  assert.equal(helper.state.qualities.length, 0);
});

test('quality selection hides nonmatching cards without requiring Hide non-matches and All restores them', () => {
  const { helper, model, unsafeWindow } = loadHelper({ qualities: ['1080'], onlyMatches: false });
  unsafeWindow.MediaAttribute = function (node) { this.data = node.meta; };
  model.d.fullhd = { meta: { width: 1920, height: 1080 } };
  model.d.hd = { meta: { width: 1280, height: 720 } };
  const items = [video('fullhd'), video('hd'), video('unknown')];
  const grid = { querySelectorAll: () => [] };
  helper.applyLayout(grid, items);
  assert.deepEqual(items.map(i => i.el.dataset.mfhHidden), ['0', '1', '1']);
  helper.state.qualities = [];
  helper.applyLayout(grid, items);
  assert.deepEqual(items.map(i => i.el.dataset.mfhHidden), ['0', '0', '0']);
});

test('quality sorting reorders actual MEGA nodes and keeps unknown quality last in both directions', () => {
  const { helper, model, unsafeWindow, calls } = loadHelper();
  helper.syncNativeSort();
  unsafeWindow.MediaAttribute = function (node) { this.data = node.meta; };
  model.v = [['unknown', 0], ['hd', 720], ['uhd', 2160], ['fullhd', 1080]].map(([h, height]) => ({ h, name: h, t: 0, meta: { width: 3840, height } }));
  for (const node of model.v) model.d[node.h] = node;
  helper.state.sort = 'qualityDesc';
  helper.syncNativeSort();
  assert.deepEqual(model.v.map(n => n.h), ['uhd', 'fullhd', 'hd', 'unknown']);
  const count = calls.length;
  helper.syncNativeSort();
  assert.equal(calls.length, count);
  helper.state.sort = 'qualityAsc';
  helper.syncNativeSort();
  assert.deepEqual(model.v.map(n => n.h), ['hd', 'fullhd', 'uhd', 'unknown']);
  assert.ok(helper.compareItems(video('unknown'), video('hd'), false) > 0);
  const sortsBefore = calls.filter(Array.isArray).length;
  helper.state.sort = 'sizeDesc';
  helper.syncNativeSort();
  assert.equal(calls.filter(Array.isArray).length, sortsBefore + 1);
});

test('quality uses actual short side for portrait videos and rejects unknown dimensions', () => {
  const { helper, unsafeWindow } = loadHelper();
  assert.equal(helper.qualityLabel({ width: 1920, height: 1080 }), '1080p');
  assert.equal(helper.qualityLabel({ width: 1080, height: 1920 }), '1080p');
  assert.equal(helper.qualityLabel({ width: 3840, height: 2160 }), '4K');
  assert.equal(helper.qualityLabel({ width: 640, height: 360 }), '360p');
  assert.equal(helper.qualityLabel({ width: 1920, height: 0 }), '');
  assert.equal(helper.qualityLabel({ width: Infinity, height: 1080 }), '');
  unsafeWindow.M.d.video123 = { fa: 'attributes' };
  unsafeWindow.MediaAttribute = function () { this.data = { width: 1280, height: 720 }; };
  assert.equal(helper.qualityLabel(helper.nativeVideoMetadata({ megaHandle: 'video123' })), '720p');
});

test('waits for asynchronous folder nodes before applying automatic sort', () => {
  const { helper, model, calls } = loadHelper();
  model.v = [];
  helper.syncNativeSort();
  assert.equal(calls.length, 0);
  model.v = [{ s: 5 }];
  helper.syncNativeSort();
  assert.deepEqual(calls[0], ['size', 1]);
});

test('date badge uses Date added for videos, omits missing dates and never substitutes modified date', () => {
  const { helper, model } = loadHelper();
  let badge;
  const el = { dataset: {}, querySelector: () => badge, appendChild: node => { badge = node; } };
  model.d.video123 = { ts: Date.UTC(2026, 9, 9, 12) / 1000, mtime: 1 };
  const item = { type: 'video', megaHandle: 'video123', el };
  helper.applyDateBadge(item);
  assert.equal(badge.textContent, '09.10.2026');
  assert.equal(el.dataset.mfhDateLabel, '09.10.2026');
  delete model.d.video123.ts;
  helper.applyDateBadge(item);
  assert.equal(el.dataset.mfhDateLabel, undefined);
  assert.equal(helper.formatAddedDate(0), '');
  assert.equal(helper.formatAddedDate('invalid'), '');
});


test('splitscreen catalog uses keyed local streams, video metadata and quality ordering', () => {
  const { helper, model, unsafeWindow } = loadHelper({ sort: 'qualityDesc' });
  unsafeWindow.MediaAttribute = function (node) { this.data = node.meta; };
  const items = ['low', 'high'].map((handle, index) => {
    model.d[handle] = { t: 0, name: `${handle}.mp4`, k: [1,2,3,4,5,6,7,8], meta: { width: 1920, height: index ? 1080 : 720 } };
    const item = video(handle);
    item.el.querySelector = () => null;
    return item;
  });
  const result = helper.splitItems(items);
  assert.equal(result.length, 2);
  assert.equal(result[0].title, 'high');
  const url = new URL(result[0].url);
  assert.equal(url.pathname, '/api/v1/mega/stream-ref');
  assert.ok(url.searchParams.get('ref').startsWith('mega:n:root:high:'));
  assert.equal(result[0].isResolved, true);
  assert.equal(result[0].duration, 60);
  assert.equal(helper.splitItems([{ ...items[0], type: 'folder' }]).length, 0);
});

test('MEGA Hub snapshot includes videos and folders only under the current directory', () => {
  const { helper, model, location, unsafeWindow } = loadHelper();
  location.href = 'https://mega.nz/folder/ROOT0001#U1NTU1NTU1NTU1NTU1NTUw/folder/FOLDER02';
  model.currentdirid = 'FOLDER02';
  const fileKey = [1, 2, 3, 4, 5, 6, 7, 8];
  model.d.FOLDER02 = { h: 'FOLDER02', p: 'ROOT0001', t: 1, name: 'Current scope' };
  model.d.NESTED01 = { h: 'NESTED01', p: 'FOLDER02', t: 1, name: 'Nested' };
  model.d.VIDEO001 = { h: 'VIDEO001', p: 'NESTED01', t: 0, name: 'Clip.mp4', k: fileKey, ts: 100 };
  model.d.OUTSIDE1 = { h: 'OUTSIDE1', p: 'ROOT0001', t: 0, name: 'Outside.mp4', k: fileKey };
  unsafeWindow.MediaAttribute = function () { this.data = { width: 1280, height: 720, playtime: 20 }; };
  const { url, page } = helper.folderSnapshotForHub();
  assert.equal(url, location.href);
  assert.equal(page.scope, 'FOLDER02');
  assert.equal(page.folders[0].id, 'NESTED01');
  assert.equal(page.videos.length, 1);
  assert.match(page.videos[0].ref, /^mega:n:ROOT0001:VIDEO001:/);
  assert.equal(page.videos[0].parent, 'NESTED01');
  assert.equal(page.videos[0].duration, 20);
});
