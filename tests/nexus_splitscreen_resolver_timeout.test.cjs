const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

for (const file of ['userscripts/nexus-universal-splitscreen.user.js', 'app/static/nexus-universal-splitscreen.js']) {
  const code = fs.readFileSync(file, 'utf8');
  const start = code.indexOf('  async function resolveThroughSelector(');
  const end = code.indexOf('  function isEpornerUrl(', start);

  function harness() {
    const document = new EventTarget();
    document.documentElement = { dataset: { nexusVideoResolver: 'ready' } };
    let timeout;
    const context = {
      document, Math, CustomEvent,
      setTimeout(fn, ms) { timeout = { fn, ms }; return 1; },
      clearTimeout() { timeout.cleared = true; }
    };
    vm.runInNewContext(code.slice(start, end) + ';this.resolve = resolveThroughSelector;', context);
    return { document, context, timeout: () => timeout };
  }

  test(`${file}: delayed adapter response survives the old 1.8s cutoff`, async () => {
    const h = harness();
    let request;
    h.document.addEventListener('nexus-video-resolve', e => { request = JSON.parse(e.detail); });
    const pending = h.context.resolve({ watchUrl: 'https://pimpbunny.com/videos/example/' });
    // Model a response arriving after 5 seconds, within the adapter's 12s budget.
    assert.ok(h.timeout().ms > 12000);
    if (h.timeout().ms <= 5000) h.timeout().fn();
    h.document.dispatchEvent(new CustomEvent('nexus-video-resolved', {
      detail: JSON.stringify({ requestId: request.requestId, url: 'https://cdn.example/video.mp4' })
    }));
    assert.equal((await pending).url, 'https://cdn.example/video.mp4');
    assert.equal(h.timeout().cleared, true);
  });

  test(`${file}: missing adapter response still times out`, async () => {
    const h = harness();
    const pending = h.context.resolve({ url: 'https://pimpbunny.com/videos/example/' });
    h.timeout().fn();
    assert.equal(await pending, null);
    assert.equal(h.timeout().cleared, true);
  });

  test(`${file}: MP4 fallback proxies the resolved stream with its watch referer`, async () => {
    let source;
    const cell = {
      item: { type: 'mp4', url: 'https://pimpbunny.com/videos/example/',
        directUrl: 'https://cdn.example/video.mp4?token=a&b=2' },
      video: { set src(value) { source = value; }, play: async () => {}, addEventListener() {} },
      loader: {}
    };
    const context = { CONFIG: { DEFAULT_NEXUS_PORT: 8000 }, console,
      AbortController, setTimeout, clearTimeout, turboVideoInfo: () => null,
      fetch: async () => ({ ok: true }), switchToIframe() { assert.fail('unexpected iframe'); }
    };
    const from = code.indexOf('  async function fallbackToProxyOrIframe(');
    const to = code.indexOf('  function switchToIframe(', from);
    vm.runInNewContext(code.slice(from, to) + ';this.fallback = fallbackToProxyOrIframe;', context);
    await context.fallback(cell);
    const proxy = new URL(source);
    assert.equal(proxy.pathname, '/api/v1/video_proxy');
    assert.equal(proxy.searchParams.get('url'), cell.item.directUrl);
    assert.equal(proxy.searchParams.get('referer'), cell.item.url);
  });

  test(`${file}: fallbackToProxyOrIframe does not double-proxy local /hls_proxy or /e/ embed URLs`, async () => {
    const from = code.indexOf('  async function fallbackToProxyOrIframe(');
    const to = code.indexOf('  function switchToIframe(', from);
    const context = {
      CONFIG: { DEFAULT_NEXUS_PORT: 8000 },
      console,
      AbortController,
      setTimeout,
      clearTimeout,
      turboVideoInfo: () => null,
      fetch: async () => { assert.fail('should not fetch health or double-proxy'); },
      switchToIframe() { assert.fail('should not switch to raw watch iframe'); }
    };
    vm.runInNewContext(code.slice(from, to) + ';this.fallback = fallbackToProxyOrIframe;', context);

    // 1. Local /hls_proxy stream shows error state without wrapping in /api/v1/tools/stream-proxy
    const hlsCell = {
      item: {
        type: 'hls',
        url: 'https://www.pornhub.com/view_video.php?viewkey=123',
        directUrl: 'http://localhost:8000/hls_proxy?url=https%3A%2F%2Fcdn.example%2Fmaster.m3u8'
      },
      video: { style: {} },
      iframe: { style: {} },
      loader: { style: {} }
    };
    await context.fallback(hlsCell);
    assert.equal(hlsCell.loader.style.display, 'flex');

    // 2. Local /e/<code> Byse embed switches cleanly to iframe with the proxy URL
    const byseCell = {
      item: {
        type: 'iframe',
        isIframe: true,
        url: 'https://hornysimp.com/videos/123/test',
        directUrl: '/e/AbC_123?upstream=https%3A%2F%2Fbysezoxexe.com%2Fe%2FAbC_123'
      },
      video: { style: {} },
      iframe: { style: {} },
      loader: { style: {} }
    };
    await context.fallback(byseCell);
    assert.equal(byseCell.iframe.style.display, 'block');
    assert.equal(byseCell.iframe.src, byseCell.item.directUrl);

    // 3. Local /hls_proxy stream with embedFallbacks switches to first embed fallback in iframe
    const leakCell = {
      item: {
        type: 'hls',
        url: 'https://tv.leakporner.com/anna-mukydza-kinky-bdsm-bondage-dungeon-sex/',
        directUrl: 'http://127.0.0.1:8000/hls_proxy?url=https%3A%2F%2Fbpszprjgeniq.tnmr.org%2Fmaster.m3u8',
        embedFallbacks: ['http://127.0.0.1:8000/embed_proxy?url=https%3A%2F%2Fluluvids.top%2Fe%2Fabc']
      },
      video: { style: {} },
      iframe: { style: {} },
      loader: { style: {} }
    };
    await context.fallback(leakCell);
    assert.equal(leakCell.iframe.style.display, 'block');
    assert.equal(leakCell.iframe.src, 'http://127.0.0.1:8000/embed_proxy?url=https%3A%2F%2Fluluvids.top%2Fe%2Fabc');
  });

  test(`${file}: loadHlsLib resolves Hls from unsafeWindow inside Tampermonkey sandbox`, async () => {
    const libStart = code.indexOf('  function loadExternalLibrary(');
    const libEnd = code.indexOf('  function warmPlaybackEngines(', libStart);
    const fakeHls = function FakeHls() {};
    const context = {
      CONFIG: { HLS_CDN: 'https://cdn.example/hls.js', DASH_CDN: '', MP4BOX_CDN: '' },
      libraryLoads: new Map(),
      window: {},
      unsafeWindow: { Hls: fakeHls },
      document: {
        createElement: () => ({}),
        head: { appendChild() {} }
      }
    };
    vm.runInNewContext(code.slice(libStart, libEnd) + ';this.loadHlsLib = loadHlsLib;', context);
    const resolved = await context.loadHlsLib();
    assert.equal(resolved, fakeHls);
  });

  test(`${file}: nexus_quantum preserves embedFallbacks and handles slow resolvers`, async () => {
    const qStart = code.indexOf('  async function resolveStreamUrl(');
    const qEndMatch = code.slice(qStart).match(/\r?\n    if \(item\.type === '(?:nexus_fusion|nexus_album)'\)/);
    assert.ok(qStart > -1 && qEndMatch, 'resolveStreamUrl nexus_quantum block found');
    const qEnd = qStart + qEndMatch.index;
    const snippet = code.slice(qStart, qEnd) + '\n  }\nthis.resolveStreamUrl = resolveStreamUrl;';
    const document = new EventTarget();
    let capturedTimeoutMs = 0;
    document.addEventListener('nexus-quantum-resolve', e => {
      const req = JSON.parse(e.detail);
      document.dispatchEvent(new CustomEvent('nexus-quantum-resolved', {
        detail: JSON.stringify({
          id: req.id,
          url: '/hls_proxy?url=https%3A%2F%2Fbpszprjgeniq.tnmr.org%2Fmaster.m3u8',
          format: 'hls',
          iframe: false,
          embedFallbacks: ['/embed_proxy?url=https%3A%2F%2Fluluvids.top%2Fe%2Fabc']
        })
      }));
    });
    const context = {
      CONFIG: { DEFAULT_NEXUS_PORT: 8000 },
      document,
      Math,
      CustomEvent,
      URL,
      location: { origin: 'http://127.0.0.1:8000', protocol: 'http:' },
      parseCustomEventDetail: detail => (typeof detail === 'string' ? JSON.parse(detail) : detail),
      detectFormat: () => 'hls',
      resolveViaNexusBackend: async () => { assert.fail('unexpected direct backend fallback'); },
      setTimeout(fn, ms) { capturedTimeoutMs = Math.max(capturedTimeoutMs, ms); return 1; },
      clearTimeout() {},
      console
    };
    vm.runInNewContext(snippet, context);
    const item = { type: 'nexus_quantum', url: 'https://tv.mypornerleak.com/anna-mukydza-kinky-bdsm-bondage-dungeon-sex/' };
    const resultUrl = await context.resolveStreamUrl(item);
    assert.equal(resultUrl, 'http://127.0.0.1:8000/hls_proxy?url=https%3A%2F%2Fbpszprjgeniq.tnmr.org%2Fmaster.m3u8');
    assert.equal(item.type, 'hls');
    assert.deepEqual(item.embedFallbacks, ['http://127.0.0.1:8000/embed_proxy?url=https%3A%2F%2Fluluvids.top%2Fe%2Fabc']);
    assert.ok(capturedTimeoutMs >= 30000);
  });
}
