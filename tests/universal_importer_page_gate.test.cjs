const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');

const importerPath = path.resolve(__dirname, '../extensions/Nexus_Gallery/universal_importer.js');

async function installChromeMock(page) {
    await page.addInitScript(() => {
        globalThis.chrome = {
            runtime: {
                lastError: null,
                onMessage: { addListener() {} },
                sendMessage(message, callback) {
                    let response = { ok: true };
                    if (message?.action === 'GET_CAPTURED_STREAM') {
                        response = { streamUrl: 'https://cdn.example.test/main-video.mp4' };
                    } else if (message?.action === 'FETCH_HEAD_INFO') {
                        response = { ok: true, contentType: 'video/mp4', contentLength: 25 * 1024 * 1024 };
                    } else if (message?.action === 'FETCH_EMBED_CORS') {
                        response = { ok: true, html: '' };
                    }
                    queueMicrotask(() => callback?.(response));
                },
            },
        };
    });
}

async function openMockPage(page, url, html) {
    await page.route(url, route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    await page.goto(url);
    await page.addScriptTag({ path: importerPath });
}

test('channel grid rejects card and relayed streams without ever creating the import panel', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await installChromeMock(page);
        const cards = Array.from({ length: 12 }, (_, index) =>
            `<a class="thumb-block video-card" href="/video.${index + 100}/clip-${index}"><img alt="clip ${index}"></a>`
        ).join('');
        await openMockPage(page, 'https://www.xvideos.com/hookuphotshot', `<main class="grid">${cards}</main>`);

        await page.evaluate(() => {
            window.postMessage({ action: 'PH_PLAYER_STREAM', streamUrl: 'https://cdn.example.test/card-preview.m3u8' }, '*');
        });
        await page.waitForTimeout(100);

        assert.equal(await page.locator('.nexus-import-overlay').count(), 0);
    } finally {
        await browser.close();
    }
});

test('single-video detail route still opens one import panel after direct URL resolution', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await installChromeMock(page);
        await openMockPage(page, 'https://www.xvideos.com/video.k12345/main-scene',
            '<main><video src="https://cdn.example.test/main-video.mp4" style="display:block;width:960px;height:540px"></video></main>');

        const panel = page.locator('.nexus-import-overlay');
        await panel.waitFor({ state: 'visible', timeout: 5000 });
        assert.equal(await panel.count(), 1);
        assert.equal(await page.locator('.nexus-source-list').count(), 0);
    } finally {
        await browser.close();
    }
});
