const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { chromium } = require('playwright');

const importerPath = path.resolve(__dirname, '../extensions/Nexus_Gallery/universal_importer.js');
const backgroundPath = path.resolve(__dirname, '../extensions/Nexus_Gallery/background.js');

async function installIframeChromeMock(page, initialStreamUrl = '') {
    await page.addInitScript((defaultStream) => {
        const listeners = [];
        globalThis.__capturedStream = defaultStream;
        globalThis.__emitRuntimeMessage = (msg) => {
            for (const fn of listeners) fn(msg);
        };
        globalThis.chrome = {
            runtime: {
                lastError: null,
                onMessage: {
                    addListener(fn) {
                        listeners.push(fn);
                    },
                },
                sendMessage(message, callback) {
                    let response = { ok: true };
                    if (message?.action === 'GET_CAPTURED_STREAM') {
                        response = globalThis.__capturedStream
                            ? { ok: true, streamUrl: globalThis.__capturedStream }
                            : { ok: false, streamUrl: '' };
                    } else if (message?.action === 'FETCH_TEXT_WITH_REFERER') {
                        response = { ok: false, text: '' };
                    } else if (message?.action === 'FETCH_HEAD_INFO') {
                        response = { ok: true, contentType: 'application/vnd.apple.mpegurl', contentLength: 0 };
                    } else if (message?.action === 'QUALITY_FIND_HIGHEST') {
                        response = { ok: false };
                    }
                    queueMicrotask(() => callback?.(response));
                },
            },
        };
    }, initialStreamUrl);
}

test('cross-origin iframe pre-play <video> relays stream to top frame once DIRECT_STREAM_OBSERVED fires', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await installIframeChromeMock(page, '');

        const topUrl = 'https://onlypornv.com/video/shaved-pussy-licked-before-a-doggystyle-hair-pull-fuck';
        const embedUrl = 'https://vidara.example/e/kI8JryBz5cOqq';
        await page.route(topUrl, (route) => route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: `<main><div class="player-wrapper"><iframe id="embed-player-frame" src="${embedUrl}" style="width:960px;height:540px;border:0"></iframe></div></main>`,
        }));
        await page.route(embedUrl, (route) => route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: `<div id="jwplayer" class="jwplayer jw-reset jw-keep-thumbnail"><div class="jw-wrapper"><div class="jw-media"><video class="jw-video jw-reset" style="width:960px;height:540px"></video></div></div></div>`,
        }));

        await page.goto(topUrl);
        await page.addScriptTag({ path: importerPath });

        const embedFrame = page.frames().find((f) => f.url() === embedUrl);
        assert.ok(embedFrame, 'embed iframe should be present');
        await embedFrame.addScriptTag({ path: importerPath });

        // Wait for initial pre-play scan (no stream yet)
        await page.waitForTimeout(150);
        assert.equal(await page.locator('.nexus-import-overlay').count(), 0);

        // Simulate playback starting and direct-stream-network observing master.m3u8
        const streamUrl = 'https://cdn.example.test/hls/master.m3u8?token=test123';
        await embedFrame.evaluate((url) => {
            globalThis.__emitRuntimeMessage({ action: 'DIRECT_STREAM_OBSERVED', url });
        }, streamUrl);

        const panel = page.locator('.nexus-import-overlay');
        await panel.waitFor({ state: 'visible', timeout: 5000 });
        assert.equal(await panel.count(), 1);
        assert.equal(await embedFrame.locator('.nexus-import-overlay').count(), 0);
    } finally {
        await browser.close();
    }
});

test('cross-origin iframe pre-play <video> relays stream on playing event via GET_CAPTURED_STREAM', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await installIframeChromeMock(page, '');

        const topUrl = 'https://onlypornv.com/video/sample-scene';
        const embedUrl = 'https://mxzhxco8dft.example/e/abc123';
        await page.route(topUrl, (route) => route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: `<main><iframe id="embed-player-frame" src="${embedUrl}" style="width:960px;height:540px;border:0"></iframe></main>`,
        }));
        await page.route(embedUrl, (route) => route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: `<div id="jwplayer"><video class="jw-video" style="width:960px;height:540px"></video></div>`,
        }));

        await page.goto(topUrl);
        await page.addScriptTag({ path: importerPath });

        const embedFrame = page.frames().find((f) => f.url() === embedUrl);
        assert.ok(embedFrame);
        await embedFrame.addScriptTag({ path: importerPath });

        await page.waitForTimeout(150);
        assert.equal(await page.locator('.nexus-import-overlay').count(), 0);

        const streamUrl = 'https://cdn.example.test/hls/master.m3u8?token=play789';
        await embedFrame.evaluate((url) => {
            globalThis.__capturedStream = url;
            const video = document.querySelector('video');
            video.dispatchEvent(new Event('playing'));
        }, streamUrl);

        const panel = page.locator('.nexus-import-overlay');
        await panel.waitFor({ state: 'visible', timeout: 5000 });
        assert.equal(await panel.count(), 1);
    } finally {
        await browser.close();
    }
});

test('GET_CAPTURED_STREAM falls back to chrome.storage.session nexus_direct_response entries', async () => {
    const src = fs.readFileSync(backgroundPath, 'utf8');
    const start = src.indexOf('if (msg.action === "GET_CAPTURED_STREAM")');
    const end = src.indexOf('if (msg.action === "MEGA_NATIVE_ADD")', start);
    assert.ok(start >= 0 && end > start);
    const snippet = src.slice(start, end);

    const sessionData = {
        nexus_direct_response_42_111: {
            tabId: 42,
            pageUrl: 'https://onlypornv.com/video/sample-scene',
            url: 'https://cdn.example.test/hls/720p/index.m3u8?token=1',
            ts: Date.now() - 1000,
        },
        nexus_direct_response_42_222: {
            tabId: 42,
            pageUrl: 'https://onlypornv.com/video/sample-scene',
            url: 'https://cdn.example.test/hls/master.m3u8?token=1',
            ts: Date.now() - 2000,
        },
    };

    const response = await new Promise((resolve) => {
        const context = {
            URL,
            Date,
            Number,
            String,
            Object,
            capturedStreams: new Map(),
            normalizeCaptureWatchPageUrl: (u) => String(u || '').replace(/\/+$/, ''),
            capturedStreamStorageKey: () => 'captured_key',
            looksLikeHls: (u) => /\.m3u8(\?|$)/i.test(String(u || '')),
            pickImportableStream: async ({ streamUrl }) => (streamUrl ? { streamUrl, sizeBytes: 0, duration: 0, source: 'captured' } : null),
            chrome: {
                storage: {
                    local: { get: async () => ({}) },
                    session: { get: async () => sessionData },
                },
            },
            msg: { action: 'GET_CAPTURED_STREAM', pageUrl: 'https://mxzhxco8dft.example/e/abc123', duration: 143 },
            sender: { tab: { id: 42, url: 'https://onlypornv.com/video/sample-scene' } },
            sendResponse: resolve,
        };
        vm.createContext(context);
        vm.runInContext(`(function(){ ${snippet} })()`, context);
    });

    assert.equal(response.ok, true);
    assert.equal(response.streamUrl, 'https://cdn.example.test/hls/master.m3u8?token=1');
});
