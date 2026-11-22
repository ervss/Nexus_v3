const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const guardPath = path.join(root, 'extensions/Nexus_Gallery/bunkr_ad_guard.js');
const importerSource = fs.readFileSync(path.join(root, 'extensions/Nexus_Gallery/universal_importer.js'), 'utf8');

test('Bunkr guard removes injected image ads and blocks their redirects', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extensions/Nexus_Gallery/manifest.json'), 'utf8'));
    const guard = manifest.content_scripts.find(entry => entry.js.includes('bunkr_ad_guard.js'));
    assert.ok(guard, 'Bunkr ad guard must be registered in the extension manifest');
    assert.equal(guard.run_at, 'document_start');
    assert.ok(guard.matches.includes('https://bunkr.pk/*'));

    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.route('https://bunkr.pk/f/test-file', route => route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<html><body><main id="content"></main></body></html>',
        }));
        await page.goto('https://bunkr.pk/f/test-file');
        await page.addScriptTag({ path: guardPath });

        const outcome = await page.evaluate(() => {
            const content = document.querySelector('#content');
            const ad = document.createElement('a');
            ad.href = 'https://fh-dxy.com/click?campaign=test';
            ad.innerHTML = '<img src="https://images.example.test/ad.jpg" alt="ad">';
            content.append(ad);

            const redirect = document.createElement('a');
            redirect.href = 'https://sub.fh-dxy.com/click?campaign=test';
            redirect.textContent = 'ad redirect';
            content.append(redirect);

            let reachedTarget = false;
            redirect.addEventListener('click', () => { reachedTarget = true; });
            const event = new MouseEvent('click', { bubbles: true, cancelable: true });
            redirect.dispatchEvent(event);

            return { reachedTarget, defaultPrevented: event.defaultPrevented };
        });

        await page.waitForTimeout(50);
        assert.equal(outcome.reachedTarget, false);
        assert.equal(outcome.defaultPrevented, true);
        assert.equal(await page.locator('#content a:has(img)').count(), 0);
    } finally {
        await browser.close();
    }
});

test('import panel clicks do not bubble into Bunkr page handlers', async () => {
    const shield = importerSource.match(
        /for \(const eventType of \['click', 'auxclick', 'dblclick', 'contextmenu'\]\) \{\s*container\.addEventListener\(eventType, event => event\.stopPropagation\(\)\);\s*\}/
    );
    assert.ok(shield, 'Importer panel must stop page click handlers from receiving its events');

    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.route('https://bunkr.pk/f/test-panel', route => route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<html><body></body></html>',
        }));
        await page.goto('https://bunkr.pk/f/test-panel');
        const outcome = await page.evaluate(shieldCode => {
            let pageClicks = 0;
            let panelClicks = 0;
            document.addEventListener('click', () => { pageClicks += 1; });

            const container = document.createElement('div');
            container.className = 'nexus-import-overlay';
            new Function('container', shieldCode)(container);
            const button = document.createElement('button');
            button.addEventListener('click', () => { panelClicks += 1; });
            container.append(button);
            document.body.append(container);
            button.click();

            return { pageClicks, panelClicks };
        }, shield[0]);

        assert.deepEqual(outcome, { pageClicks: 0, panelClicks: 1 });
    } finally {
        await browser.close();
    }
});
