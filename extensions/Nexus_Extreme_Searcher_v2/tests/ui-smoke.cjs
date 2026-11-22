const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  const root = path.resolve(__dirname, '..');
  const out = path.resolve(__dirname, '../artifacts');
  fs.mkdirSync(out, { recursive: true });
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-extreme-v2-')), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.setViewportSize({ width: 440, height: 600 });
    await page.goto(`chrome-extension://${id}/popup.html`);
    await page.evaluate(async () => chrome.storage.local.clear());
    const openedOptions = context.waitForEvent('page');
    await page.locator('#settings').click();
    const optionsPage = await openedOptions;
    await optionsPage.waitForLoadState('domcontentloaded');
    await optionsPage.locator('[name="cacheMinutes"]').fill('10');
    await optionsPage.locator('#options button[type="submit"]').click();
    await optionsPage.getByRole('status').getByText('Uložené.').waitFor();
    await optionsPage.screenshot({ path: path.join(out, 'options-saved.png'), fullPage: true });
    await optionsPage.close();
    await page.locator('#query').fill('Huge Tits Jordan Millicent Covered in Cum');
    await page.locator('#search-form button').click();
    await page.waitForFunction(() => !document.querySelector('#search-form button').disabled, undefined, { timeout: 90000 });
    await page.screenshot({ path: path.join(out, 'popup-search.png'), fullPage: true });
    await page.locator('[data-tab="metadata"]').click();
    await page.screenshot({ path: path.join(out, 'popup-diagnostics.png'), fullPage: true });
    const data = await page.evaluate(async () => {
      const { lastSearch } = await chrome.storage.local.get('lastSearch');
      return {
        status: document.querySelector('#status').textContent,
        counts: Object.fromEntries([...document.querySelectorAll('#tabs button')].map(b => [b.dataset.tab, b.querySelector('b').textContent])),
        diagnostics: lastSearch?.diagnostics || [],
        sample: (lastSearch?.results || []).slice(0, 12).map(({ title, source, category, url }) => ({ title, source, category, url }))
      };
    });
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(data, null, 2));
    console.log(JSON.stringify(data));
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
