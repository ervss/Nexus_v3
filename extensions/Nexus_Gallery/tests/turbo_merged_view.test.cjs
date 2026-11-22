const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const path = require('node:path');

test('merged view combines selected albums, deduplicates, filters and sorts', async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    await page.route('https://turbo.cr/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/library') return route.fulfill({contentType:'text/html', body:'<div id="grid"><a class="alb" href="/a/one"><div class="strip"></div><span class="truncate">Alpha</span></a><a class="alb" href="/a/two"><div class="strip"></div><span class="truncate">Beta</span></a></div>'});
      const files = url.pathname.endsWith('/one') ? `{id:'shared',name:'Zulu-1080p',size:200000000,dur:400},{id:'first',name:'Apple',size:1,dur:1}` : `{id:'shared',name:'Zulu-1080p',size:200000000,dur:400},{id:'second',name:'Banana',size:10,dur:10}`;
      return route.fulfill({contentType:'text/html',body:`<script>const FILES = [${files}];</script>`});
    });
    await page.goto('https://turbo.cr/library');
    await page.addInitScript(() => {});
    await page.evaluate(() => { window.chrome = {runtime:{sendMessage: (_msg, cb) => cb && cb({})}}; });
    await page.addStyleTag({path:path.join(__dirname,'../turbo_grid_importer.css')});
    await page.addScriptTag({path:path.join(__dirname,'../turbo_grid_importer.js')});
    await page.locator('.nexus-turbo-album-chk-wrap').nth(0).click();
    await page.locator('.nexus-turbo-album-chk-wrap').nth(1).click();
    await page.locator('#nexus-turbo-btn-merged').click();
    const modal=page.locator('#nexus-turbo-peek-modal');
    await modal.waitFor();
    assert.equal(await modal.locator('.nexus-turbo-peek-card').count(),3);
    assert.match(await modal.innerText(), /Alpha, Beta/);
    await modal.locator('#nexus-turbo-peek-album').selectOption('two');
    assert.equal(await modal.locator('.nexus-turbo-peek-card').count(),2);
    await modal.locator('#nexus-turbo-peek-album').selectOption('');
    await modal.locator('#nexus-turbo-peek-sort').selectOption('name');
    assert.equal(await modal.locator('.nexus-turbo-peek-card-title').first().innerText(),'Apple');
    await modal.locator('#nexus-turbo-peek-min-duration').fill('5');
    assert.equal(await modal.locator('.nexus-turbo-peek-card').count(),1);
    await modal.locator('#nexus-turbo-peek-min-size').fill('100');
    await modal.locator('#nexus-turbo-peek-min-quality').selectOption('1080');
    assert.equal(await modal.locator('.nexus-turbo-peek-card').count(),1);
    await modal.locator('#nexus-turbo-peek-min-quality').selectOption('2160');
    assert.equal(await modal.locator('.nexus-turbo-peek-card').count(),0);
    await modal.locator('#nexus-turbo-peek-min-quality').selectOption('1080');
    const card = await modal.locator('.nexus-turbo-peek-card').first().boundingBox();
    const actions = await modal.locator('.nexus-turbo-peek-card-actions').first().boundingBox();
    assert.ok(actions.y + actions.height <= card.y + card.height + 1, 'action buttons fit within card');
    await modal.locator('#nexus-turbo-peek-select-all').uncheck();
    assert.match(await modal.locator('#nexus-turbo-peek-count').innerText(), /^2 \/ 3/);
  } finally { await browser.close(); }
});
