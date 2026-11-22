const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  const root = path.resolve(__dirname, '..');
  const out = path.join(root, 'artifacts');
  fs.mkdirSync(out, { recursive: true });
  const context = await chromium.launchPersistentContext(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-local-setup-')),
    { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] }
  );
  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.setViewportSize({ width: 900, height: 720 });
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await page.locator('#detect-local').click();
    await page.waitForFunction(() => document.querySelector('#local-status').textContent.includes('Nexus OK'), undefined, { timeout: 15000 });
    const localStatus = await page.locator('#local-status').textContent();
    await page.screenshot({ path: path.join(out, 'options-local-services.png'), fullPage: true });
    console.log(JSON.stringify({ localStatus }));
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
