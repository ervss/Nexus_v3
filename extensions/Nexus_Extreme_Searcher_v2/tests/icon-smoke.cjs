const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'artifacts', 'icon-installed.png');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const context = await chromium.launchPersistentContext(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-extreme-icon-')),
    {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
    }
  );
  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.setViewportSize({ width: 1000, height: 720 });
    await page.goto(`chrome://extensions/?id=${id}`);
    await page.getByText('Nexus Extreme Searcher v2', { exact: true }).last().waitFor({ timeout: 15000 });
    await page.screenshot({ path: output, fullPage: true });
    console.log(JSON.stringify({ extensionId: id, screenshot: output }));
  } finally {
    await context.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
