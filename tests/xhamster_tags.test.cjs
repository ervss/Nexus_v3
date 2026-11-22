const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const stored = new Map();
const context = { window: {}, URL, AbortController, Date, setTimeout, clearTimeout,
  sessionStorage: { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) } };
vm.runInNewContext(fs.readFileSync('extensions/nexus-video-selector/xhamster-listing.js', 'utf8'), context);
const api = context.window.NVSXhamsterListing;
const page = 'https://xhamster.com/videos/mature-brunette-milf-xhABC';
const watch = `<script>window.initials = {"videoModel":{"id":1,"title":"Clip","duration":10},
  "videoTagsComponent":{"tags":[
    {"name":"Big Tits","url":"https://xhamster.com/categories/big-tits"},
    {"name":"Anal","url":"https://xhamster.com/categories/anal"},
    {"name":"Anal"}]}};</script>`;

test('watch page tags and categories become filter slugs', () => {
  assert.equal(JSON.stringify(api.tagsFromHtml(watch)), JSON.stringify(['big-tits', 'anal']));
  assert.throws(() => api.tagsFromHtml('<html>gate</html>'), /nenašla/);
  assert.equal(api.tagsFromHtml('<script>window.initials = {"videoModel":{"id":1},"videoTagsComponent":{"tags":[]}};</script>').length, 0);
  assert.equal(api.watchUrl(page + '?utm=1#player', page), page);
});

test('loader keeps fetched tags, skips redirects and retries only failures', async () => {
  stored.clear();
  let fail = true;
  const loader = api.createTagLoader({ fetch: async (url) => ({
    ok: !(fail && url.endsWith('xh2')),
    url,
    text: async () => watch,
  }) });
  const urls = [page.replace('xhABC', 'xh1'), page.replace('xhABC', 'xh2')];
  const first = await loader.load([urls[0] + '?tracking=1', urls[1]]);
  assert.equal(first.errors, 1);
  assert.equal(loader.get(urls[0]).fetched, true);
  assert.equal(JSON.stringify(loader.get(urls[0]).tags), JSON.stringify(['big-tits', 'anal']));
  assert.equal(loader.get(urls[1]).fetched, false);
  fail = false;
  const retried = await loader.load(urls);
  assert.equal(retried.total, 1);
  assert.equal(retried.errors, 0);
  const restored = api.createTagLoader();
  assert.equal(restored.get(urls[1]).fetched, true);
});

test('xHamster import panel loads tags and the import carries them', () => {
  const workbench = fs.readFileSync('extensions/nexus-video-selector/import-workbench.js', 'utf8');
  const content = fs.readFileSync('extensions/nexus-video-selector/content.js', 'utf8');
  assert.match(workbench, /const showTags = pimpbunny \|\| api\.site === 'xhamster'/);
  assert.match(workbench, /if \(showTags\)/);
  assert.match(content, /state\.xhamsterTagLoader/);
  assert.match(content, /activeTagLoader\(\)\?\.get\(getVideoUrlFromCard\(card\)\)\.tags/);
});
