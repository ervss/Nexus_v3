const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { chromium } = require('playwright');
const directory = path.resolve('extensions/hotcontainer-profile-handoff');

test('uses PREMIUM attributes, rejects membership and direct, and collects all catalog pages', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: `
      <div id="cards">
        <div class="thumb-block" data-eid="omdlllv3465" data-is-premium="1" data-is-ppv="1" data-is-channel="1"><p class="title">Premium</p><p class="metadata"><span class="duration">30 min</span><span>Studio - 11 months ago</span></p></div>
        <div class="thumb-block" data-eid="okcdmhh4654" data-is-membership="1" data-is-ppv="1" data-is-channel="1"><span class="is-premium">Membership</span></div>
        <div class="thumb-block" data-eid="direct" data-is-ppv="1">Direct</div>
        <div class="thumb-block" data-eid="hybrid" data-is-membership="1" data-is-ppv="1" data-is-premium="1"><p class="title">Also sold as membership</p></div>
      </div>
      <nav class="pagination"><a href="#page2" id="next">Next</a></nav>` }));
    await page.goto('http://localhost/');
    await page.evaluate(() => {
      document.querySelector('#next').onclick = event => {
        event.preventDefault();
        document.querySelector('#cards').innerHTML = '';
        setTimeout(() => {
          document.querySelector('#cards').innerHTML = '<div class="thumb-block" data-eid="page2premium" data-is-premium="1"><img src="http://localhost/3e585d93-5ebd-4c6f-929f-f2705132df51/6/xv_19_t.avif">Second premium</div>';
          document.querySelector('.pagination').remove();
        }, 100);
      };
    });
    await page.addScriptTag({ path: path.join(directory, 'premium.js') });
    const result = await page.evaluate(async () => {
      const catalog = await HotContainerPremium.collect();
      const items = [
        { id: 'premium', sourceVideoUrl: 'https://example.test/video.omdlllv3465/title' },
        { id: 'membership', videoId: 'okcdmhh4654' },
        { id: 'direct', videoId: 'direct' },
        { id: 'hybrid', videoId: 'hybrid' },
        { id: 'second-page', videoId: 'page2premium' },
        { id: 'unknown', videoId: 'unverified' },
        { id: 'thumbnail-only', thumbnail: 'https://example.test/3e585d93-5ebd-4c6f-929f-f2705132df51/6/xv_2_t.jpg' },
        { id: 'id-overrides-thumbnail', videoId: 'direct', thumbnail: 'https://example.test/3e585d93-5ebd-4c6f-929f-f2705132df51/6/xv_2_t.jpg' },
        { id: 'title-match', title: 'Premium' },
        { id: 'same-title-other-id', videoId: 'not-in-catalog', title: 'Also sold as membership' },
        { id: 'similar-words', videoId: 'nope', title: 'Also sold as something else' }
      ];
      return { catalog, filtered: HotContainerPremium.filter(items, catalog) };
    });
    assert.deepEqual(result.catalog.ids, ['omdlllv3465', 'hybrid', 'page2premium']);
    assert.deepEqual(result.filtered.map(item => item.id), ['premium', 'hybrid', 'second-page', 'thumbnail-only', 'id-overrides-thumbnail', 'title-match', 'same-title-other-id']);
    assert.ok(result.filtered.every(item => item.accessType === 'premium'));
    assert.equal(result.filtered[0].duration, '30 min');
    assert.equal(result.filtered[0].addedDate, '11 months ago');
  } finally { await browser.close(); }
});

test('worker verifies the job sender and combines server and current-tab PREMIUM catalogs', async () => {
  let handler;
  let fail = false;
  let currentAvailable = false;
  const profileUrl = 'https://www.xvideos.com/models/test';
  const context = vm.createContext({ URL, AbortSignal, setTimeout, console,
    async fetch(url) {
      if (url === profileUrl) return {
        ok: true,
        text: async () => '<script>{"url":"\\/models\\/test","main_cat":"pornstars","main_cats":["a","b"]}</script>',
      };
      if (String(url).includes('/fan-club/best/pornstars/premium/0')) {
        return fail ? { ok: false, status: 503 } : {
          ok: true,
          json: async () => ({ posts: [{ eid: 'premium', tf: 'Premium', duration: '30 min', added_at: '2025-10-09' }], nb_posts: 1, nb_per_page: 1 }),
        };
      }
      if (String(url).includes('/fan-club/best/pornstars/membership/0')) {
        return { ok: true, json: async () => ({ posts: [{ eid: 'membership' }], nb_posts: 1, nb_per_page: 1 }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    chrome: {
      runtime: { onMessage: { addListener(fn) { handler = fn; } } },
      storage: { session: { async get(key) { return { [key]: { profileUrl, hotTabId: 42, sourceTabId: 7, createdAt: Date.now() } }; } } },
      tabs: {
        async sendMessage(id) {
          if (id === 7) return { ok: true, catalog: { ids: currentAvailable ? ['premium'] : [], thumbnails: [], records: currentAvailable ? [{ id: 'premium', addedDate: '11 months ago', duration: '30 min' }] : [] } };
          return fail ? { ok: false, error: 'Catalog failed' } : { ok: true, catalog: { ids: ['premium'], thumbnails: [], records: [{ id: 'premium', addedDate: '9. 10. 2025', duration: '30 min' }] } };
        }
      }
    }
  });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(directory, file), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(directory, 'background.js'), 'utf8'), context);
  const request = senderId => new Promise(resolve => {
    assert.equal(handler({ type: 'filter-hotcontainer-premium', jobId: 'test', items: [{ videoId: 'premium' }, { videoId: 'membership' }] }, { tab: { id: senderId } }, resolve), true);
  });
  assert.equal((await request(99)).ok, false);
  const success = await request(42);
  assert.equal(success.items.length, 1);
  assert.equal(success.items[0].videoId, 'premium');
  assert.equal(success.items[0].duration, '30 min');
  assert.equal(success.items[0].addedDate, '9. 10. 2025');
  fail = true;
  assert.match((await request(42)).error, /Profil nemá samostatný PREMIUM zoznam.*HotContainer=2.*zhody=0/);
  currentAvailable = true;
  const recovered = await request(42);
  assert.equal(recovered.items.length, 1);
  assert.equal(recovered.partial, true);
  assert.equal(recovered.items[0].duration, '30 min');
  assert.equal(recovered.diagnostics.currentPremium, 1);
});

test('150 overlapping PREMIUM cards survive collection, title matching and the actual popup renderer', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<main id="tabRed"></main>' }));
    await page.goto('http://localhost/profile#_tabRed');
    await page.evaluate(() => {
      const card = (i, premium) => `<div class="thumb-block" data-eid="source${i}" data-is-membership="1" data-is-ppv="1" ${premium ? 'data-is-premium="1"' : ''}><p class="title"><a title="Studio example number ${i}">Studio example number ${i}</a></p></div>`;
      document.querySelector('#tabRed').innerHTML = Array.from({ length: 170 }, (_, i) => card(i, i < 150)).join('');
      window.fixture = { listeners: [] };
      window.chrome = {
        runtime: { onMessage: { addListener(fn) { fixture.listeners.push(fn); } }, async sendMessage() { return { ok: true, jobId: 'gallery' }; } },
        storage: { local: { async get() { return {}; }, async set() {} } }
      };
    });
    await page.addScriptTag({ path: path.join(directory, 'premium.js') });
    await page.addScriptTag({ path: path.join(directory, 'xvideos.js') });
    await page.locator('#hc-profile-handoff').click();
    const count = await page.evaluate(() => {
      const catalog = HotContainerPremium.collectCurrent();
      const raw = Array.from({ length: 170 }, (_, i) => ({ id: `hc${i}`, videoId: `different${i}`, title: `Studio example number ${i}` }));
      const filtered = HotContainerPremium.filter(raw, catalog);
      fixture.listeners.forEach(fn => fn({ type: 'hotcontainer-gallery', jobId: 'gallery', items: filtered, pageCount: 5 }));
      return filtered.length;
    });
    assert.equal(count, 150);
    await page.locator('[data-hc-total-label]').waitFor();
    assert.equal(await page.locator('[data-hc-grid] > button').count(), 150);
    assert.match(await page.locator('[data-hc-total-label]').innerText(), /150 PREMIUM/);
    await page.screenshot({ path: path.resolve('artifacts/hotcontainer-premium-150-test.png') });
    await page.evaluate(() => fixture.listeners.forEach(fn => fn({ type: 'hotcontainer-gallery', jobId: 'gallery', items: [{ id: 'legacy', title: 'Untyped legacy card' }] })));
    await page.getByText(/Prišla správa zo staršej verzie/).waitFor();
    assert.equal(await page.getByText(/Galéria neobsahuje/).count(), 0);
  } finally { await browser.close(); }
});

test('thumbnail identity retains the asset UUID, ignores frame and format, and works despite different IDs', () => {
  const context = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync(path.join(directory, 'premium.js'), 'utf8'), context);
  const api = context.HotContainerPremium;
  const first = 'https://cdn.example/3e585d93-5ebd-4c6f-929f-f2705132df51/6/xv_19_t.avif';
  const second = 'https://cdn.example/8672f58f-6589-4981-8a12-4b4e323f0e9b/6/xv_19_t.avif';
  const changed = first.replace('/6/xv_19_t.avif', '/0/xv_2_t.jpg');
  const result = api.filter([
    { id: 'same-asset', videoId: 'different', thumbnail: changed },
    { id: 'unrelated', thumbnail: second }
  ], { ids: [], thumbnails: [], images: [api.imageKey(first)] });
  assert.deepEqual(Array.from(result, item => item.id), ['same-asset']);
  assert.notEqual(api.titleKey('Видео один'), api.titleKey('Видео два'));
});
