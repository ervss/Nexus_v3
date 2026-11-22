import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { chromium } from 'playwright';

const testerHtml = fs.readFileSync('app/templates/tester.html', 'utf8');
const splitScript = fs.readFileSync('userscripts/nexus-universal-splitscreen.user.js', 'utf8').replace(/\r\n/g, '\n');

test('tester.html routes turbocdn.st and turbo.cr through video_proxy', () => {
    const start = testerHtml.indexOf('        function needsVideoProxy(url)');
    const end = testerHtml.indexOf('        function videoProxyUrl(url', start);
    assert.ok(start > 0 && end > start);
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(testerHtml.slice(start, end), ctx);

    assert.equal(ctx.needsVideoProxy('https://cdn1.turbocdn.st/turbo/data/abc.mp4?token=1'), true);
    assert.equal(ctx.needsVideoProxy('https://turbo.cr/v/abc123'), true);
});

test('nexus-universal-splitscreen harvests /tester Turbo cards for direct proxied playback instead of sandboxed iframe', async () => {
    const turboStart = splitScript.indexOf('  function turboVideoInfo(');
    const turboEnd = splitScript.indexOf('\n  function isPixeldrain(', turboStart);
    const sharedStart = splitScript.indexOf('  function sharedCard(item)');
    const harvestStart = splitScript.indexOf('  function harvestGenericVideoCards()');
    const harvestEnd = splitScript.indexOf('\n  // ---------------------------------------------------------------------------', harvestStart);
    const formatStart = splitScript.indexOf('  function detectFormat(');
    const formatEnd = splitScript.indexOf('\n  //', formatStart);
    assert.ok(turboStart > 0 && turboEnd > turboStart && sharedStart > 0 && harvestStart > sharedStart && harvestEnd > harvestStart);

    const code = [
        'function applyMetadataFromCache() { return false; }',
        splitScript.slice(turboStart, turboEnd),
        splitScript.slice(formatStart, formatEnd),
        splitScript.slice(sharedStart, harvestStart),
        splitScript.slice(harvestStart, harvestEnd),
    ].join('\n');

    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.route('http://localhost:8000/**', route => route.fulfill({ body: '<html><body></body></html>', contentType: 'text/html' }));
        await page.goto('http://localhost:8000/tester');
        await page.setContent(`
            <article class="card success"
                data-nexus-split-watch="https://turbo.cr/v/proxied1"
                data-nexus-split-stream="/api/v1/video_proxy?url=https%3A%2F%2Fcdn1.turbocdn.st%2Fa.mp4&amp;referer=https%3A%2F%2Fturbo.cr%2Fv%2Fproxied1"
                data-nexus-split-iframe=""
                data-nexus-split-format="mp4">
                <h3>Proxied Turbo</h3>
                <div class="thumb"><img src="/api/tester/frame?url=x"></div>
            </article>
            <article class="card success"
                data-nexus-split-watch="https://turbo.cr/v/rawcdn2"
                data-nexus-split-stream="https://cdn1.turbocdn.st/b.mp4?token=1"
                data-nexus-split-iframe=""
                data-nexus-split-format="mp4">
                <h3>Raw CDN Turbo</h3>
            </article>
            <article class="card success"
                data-nexus-split-watch="https://turbo.cr/v/embed3"
                data-nexus-split-stream=""
                data-nexus-split-iframe="https://turbo.cr/embed/embed3?autoplay=1&amp;muted=1"
                data-nexus-split-format="iframe">
                <h3>Iframe Fallback Turbo</h3>
            </article>
            <article class="card success"
                data-nexus-split-watch="https://turbo.cr/v/watchonly4"
                data-nexus-split-stream=""
                data-nexus-split-iframe=""
                data-nexus-split-format="">
                <h3>Watch Only Turbo</h3>
            </article>
        `);

        const items = await page.evaluate(src => {
            return new Function('isCamwhores', `${src}; return harvestGenericVideoCards();`)(() => false);
        }, code);

        assert.equal(items.length, 4);
        assert.equal(items[0].isResolved, true);
        assert.equal(items[0].isIframe, false);
        assert.match(items[0].directUrl, /^http:\/\/localhost:8000\/api\/v1\/video_proxy\?/);

        assert.equal(items[1].isResolved, true);
        assert.equal(items[1].isIframe, false);
        assert.equal(
            items[1].directUrl,
            'http://localhost:8000/api/v1/video_proxy?url=https%3A%2F%2Fcdn1.turbocdn.st%2Fb.mp4%3Ftoken%3D1&referer=https%3A%2F%2Fturbo.cr%2Fv%2Frawcdn2',
        );

        assert.equal(items[2].type, 'bunkr_turbo');
        assert.equal(items[2].isResolved, false);
        assert.equal(items[2].isIframe, false);
        assert.equal(items[2].watchUrl, 'https://turbo.cr/v/embed3');

        assert.equal(items[3].type, 'bunkr_turbo');
        assert.equal(items[3].isResolved, false);
        assert.equal(items[3].isIframe, false);
        assert.equal(items[3].watchUrl, 'https://turbo.cr/v/watchonly4');
    } finally {
        await browser.close();
    }
});

test('resolveStreamUrl resolves Turbo on /tester via batch-meta and wraps turbocdn.st in video_proxy', async () => {
    const turboStart = splitScript.indexOf('  function turboVideoInfo(');
    const turboEnd = splitScript.indexOf('\n  function isPixeldrain(', turboStart);
    const formatStart = splitScript.indexOf('  function detectFormat(');
    const formatEnd = splitScript.indexOf('\n  //', formatStart);
    const localProxyStart = splitScript.indexOf('  function isLocalNexusProxyUrl(');
    const localProxyEnd = splitScript.indexOf('\n  function isFrameBlockedWatchUrl(', localProxyStart);
    const resolveStart = splitScript.indexOf('  async function resolveStreamUrl(item)');
    const resolveEnd = splitScript.indexOf('\n  // ---------------------------------------------------------------------------', resolveStart);

    const ctx = {
        URL,
        URLSearchParams,
        Promise,
        encodeURIComponent,
        JSON,
        CONFIG: { DEFAULT_NEXUS_PORT: 8000 },
        location: { protocol: 'http:', hostname: 'localhost', origin: 'http://localhost:8000', href: 'http://localhost:8000/tester' },
        isEpornerUrl: () => false,
        isBunkrOrTurbo: h => /turbo\.cr/i.test(h || ''),
        isPixeldrain: () => false,
        getPixeldrainId: () => null,
        isXHamster: () => false,
        isCamwhores: () => false,
        isBeegHost: () => false,
        isNoodleMagazineHost: () => false,
        sxyprnPostKey: () => null,
        resolveBunkrDirect: async () => null,
        fetch: async (url) => {
            assert.equal(url, 'http://localhost:8000/api/tester/batch-meta');
            return {
                ok: true,
                json: async () => ({
                    results: [{ ok: true, stream_url: 'https://cdn2.turbocdn.st/turbo/data/xyz.mp4?token=fresh' }],
                }),
            };
        },
        gmFetch: async () => { throw new Error('Should not need gmFetch when batch-meta succeeds'); },
    };
    vm.createContext(ctx);
    vm.runInContext([
        splitScript.slice(turboStart, turboEnd),
        splitScript.slice(formatStart, formatEnd),
        splitScript.slice(localProxyStart, localProxyEnd),
        splitScript.slice(resolveStart, resolveEnd),
    ].join('\n'), ctx);

    const item = { url: 'https://turbo.cr/v/embed3', watchUrl: 'https://turbo.cr/v/embed3', type: 'bunkr_turbo', isResolved: false };
    const result = await ctx.resolveStreamUrl(item);

    assert.equal(item.isResolved, true);
    assert.equal(item.isIframe, false);
    assert.equal(
        result,
        'http://localhost:8000/api/v1/video_proxy?url=https%3A%2F%2Fcdn2.turbocdn.st%2Fturbo%2Fdata%2Fxyz.mp4%3Ftoken%3Dfresh&referer=https%3A%2F%2Fturbo.cr%2Fv%2Fembed3',
    );
});
