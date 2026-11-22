const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const directory = path.resolve('extensions/hotcontainer-profile-handoff');

test('pairs profile date and duration, renders badges, and preserves them through sorting and status changes', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
      <main id="tabRed">
        <div class="thumb-block" data-eid="source1" data-is-premium="1"><p class="title"><a title="Test video one">Short title…</a></p><p class="metadata"><span class="duration">30 min</span><span>Studio - <span>11 months ago</span></span></p></div>
        <div class="thumb-block" data-eid="source2" data-is-premium="1"><p class="title">Test video two</p><p class="metadata"><span class="duration">1:02:03</span><time datetime="2024-10-09T23:00:00Z">2 years ago</time></p></div>
        <div class="thumb-block" data-eid="source3" data-is-premium="1"><p class="title">Test video three</p></div>
      </main>` }));
    await page.goto('http://localhost/profile#_tabRed');
    await page.evaluate(() => {
      window.fixture = { listeners: [] };
      window.chrome = { runtime: { onMessage: { addListener(fn) { fixture.listeners.push(fn); } }, async sendMessage() { return { ok: true, jobId: 'gallery' }; } }, storage: { local: { async get() { return {}; }, async set() {} } } };
    });
    await page.addScriptTag({ path: path.join(directory, 'premium.js') });
    await page.addScriptTag({ path: path.join(directory, 'xvideos.js') });
    await page.locator('#hc-profile-handoff').click();
    await page.evaluate(() => {
      const catalog = HotContainerPremium.collectCurrent();
      const thumbnail = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="#23465e"/><text x="240" y="140" text-anchor="middle" fill="#add8ed" font-size="24">Testovacie video</text></svg>');
      const items = ['one', 'two', 'three'].map((name, i) => ({ id: `hc${i + 1}`, videoId: `other${i}`, title: `Test video ${name}`, thumbnail }));
      fixture.items = HotContainerPremium.filter(items, catalog);
      fixture.listeners.forEach(fn => fn({ type: 'hotcontainer-gallery', jobId: 'gallery', items: fixture.items }));
    });
    const first = page.locator('[data-item-id="hc1"]');
    assert.equal(await page.evaluate(() => fixture.items.length), 3, await page.locator('[data-hc-content]').innerText());
    assert.deepEqual(errors, []);
    await first.waitFor();
    assert.equal(await first.locator('[data-hc-added-date]').innerText(), 'Pridané: 11 months ago');
    assert.equal(await first.locator('[data-hc-duration]').innerText(), '30 min');
    assert.equal(await page.locator('[data-item-id="hc2"] [data-hc-added-date]').innerText(), 'Pridané: 9. 10. 2024');
    assert.equal(await page.locator('[data-item-id="hc2"] [data-hc-duration]').innerText(), '1:02:03');
    assert.equal(await page.locator('[data-item-id="hc3"] [data-hc-duration]').innerText(), '—');
    await page.locator('#hc-gallery-sort').selectOption('oldest');
    assert.equal(await page.locator('[data-hc-grid] > button').first().getAttribute('data-item-id'), 'hc3');
    assert.equal(await first.locator('[data-hc-duration]').innerText(), '30 min');
    await first.click();
    assert.equal(await first.locator('[data-hc-title]').innerText(), 'Pracujem…');
    assert.equal(await first.locator('[data-hc-added-date]').innerText(), 'Pridané: 11 months ago');
    await page.evaluate(() => fixture.listeners.forEach(fn => fn({ type: 'hotcontainer-status', jobId: 'gallery', itemId: 'hc1', state: 'accepted', text: 'Prijaté' })));
    assert.equal(await first.locator('[data-hc-duration]').innerText(), '30 min');
    await page.locator('#hc-gallery-sort').selectOption('newest');
    await page.screenshot({ path: path.resolve('artifacts/hotcontainer-date-duration-test.png') });
  } finally { await browser.close(); }
});
