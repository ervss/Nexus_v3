const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const ctx = { window: {}, document: {}, localStorage: {}, requestAnimationFrame: () => 0 };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('extensions/nexus-video-selector/import-workbench.js', 'utf8'), ctx);
const { defaults, matches, compare } = ctx.window.NVSWorkbenchModel;

test('only-videos filter drops photo-only albums and ignores rows without a video count', () => {
  const f = { ...defaults(), onlyVideos: true };
  assert.equal(matches({ title: 'a', videos: 0 }, f), false);
  assert.equal(matches({ title: 'a', videos: 2 }, f), true);
  assert.equal(matches({ title: 'a' }, f), true);
  assert.equal(matches({ title: 'a', videos: 0 }, defaults()), true);
});

test('erome sort keys views and videos order descending with unknown last', () => {
  const rows = [{ order: 1, views: 10, videos: 1 }, { order: 2, views: 500, videos: 3 }, { order: 3, views: 0, videos: 0 }];
  const f = { ...defaults(), sort: 'views', direction: 'desc' };
  assert.deepEqual([...rows].sort((a, b) => compare(a, b, f)).map(r => r.order), [2, 1, 3]);
});
