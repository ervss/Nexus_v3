const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const rootDir = path.resolve(__dirname, '..');
const selectorDir = path.join(rootDir, 'extensions/nexus-video-selector');
const galleryDir = path.join(rootDir, 'extensions/Nexus_Gallery');
const splitscreenSource = fs.readFileSync(
  path.join(rootDir, 'userscripts/nexus-universal-splitscreen.user.js'),
  'utf8',
);

function extractSplitscreenSlice() {
  const fn = (name) => {
    const start = splitscreenSource.indexOf(name);
    assert.ok(start >= 0, `Missing block: ${name}`);
    return start;
  };
  const sharedStart = fn('  function sharedCard(item)');
  const harvestStart = fn('  function harvestGenericVideoCards()');
  const harvestEnd = splitscreenSource.indexOf('\n  // ---------------------------------------------------------------------------', harvestStart);
  assert.ok(harvestEnd > harvestStart);

  const turboStart = fn('  function turboVideoInfo(');
  const turboEnd = fn('  function isPixeldrain(', turboStart);

  const durationStart = fn('  function formatDuration(sec)');
  const durationEnd = splitscreenSource.indexOf('\n  function ', durationStart + 5);

  const detectStart = fn('  function detectFormat(');
  const detectEnd = splitscreenSource.indexOf('\n  //', detectStart);

  const extractStart = fn('  function extractVideoPageSource(html, baseUrl)');
  const extractEnd = fn('  function bunkrKey(url)', extractStart);
  const helpersStart = fn('  function parseCustomEventDetail(detail)');
  const helpersEnd = fn('  function extractPimpbunnyStream(html, pageUrl)');
  const resolverStart = fn('  async function resolveStreamUrl(item)');
  const resolverEnd = splitscreenSource.indexOf('\n  function mergeSelectedPageCards(results)', resolverStart);
  assert.ok(resolverEnd > resolverStart);

  return [
    'const CONFIG = { NEXUS_ORIGIN: "http://127.0.0.1:8000" };',
    'const STREAM_META_CACHE = new Map();',
    'const metadataCache = new Map();',
    'function applyMetadataFromCache() {}',
    'function updateCardInDom() {}',
    'function saveCachedMeta() {}',
    'function isTurboHost() { return false; }',
    'function isBunkrHost() { return false; }',
    'function isBunkrOrTurbo() { return false; }',
    'function isWhoreshubHost() { return false; }',
    'function isXhamsterHost() { return false; }',
    'function isXvideosHost() { return false; }',
    'function isSpankbangHost() { return false; }',
    'function isPimpbunnyHost() { return false; }',
    'function isEromeHost() { return false; }',
    'function isHotcontainerHost() { return false; }',
    'function isFindr() { return false; }',
    'function isMegaUrl() { return false; }',
    'function isPixeldrain() { return false; }',
    'function getPixeldrainId() { return null; }',
    'function isXHamster() { return false; }',
    'function isPornhubHost() { return false; }',
    'function isCamwhores() { return false; }',
    'function isEpornerUrl() { return false; }',
    'function isBeegHost() { return false; }',
    'function isNoodleMagazineHost() { return false; }',
    'let __fallbackNetwork = {};',
    'function gmFetch(url, opts = {}) {',
    '  const wrap = (entry) => ({',
    '    ok: entry && entry.ok !== undefined ? entry.ok : true,',
    '    status: (entry && entry.status) || 200,',
    '    url: (entry && (entry.finalUrl || entry.url)) || url,',
    '    text: async () => (entry && entry.responseText) || "",',
    '    json: async () => JSON.parse((entry && entry.responseText) || "{}"),',
    '  });',
    '  if (typeof __fallbackNetwork[url] === "function") return Promise.resolve(wrap(__fallbackNetwork[url](url, opts)));',
    '  if (url in __fallbackNetwork) return Promise.resolve(wrap(__fallbackNetwork[url]));',
    '  return Promise.reject(new Error("Unexpected fetch: " + url));',
    '}',
    'async function resolveThroughSelector(item) {',
    '  if (typeof globalThis.__mockSelectorResolve === "function") return globalThis.__mockSelectorResolve(item);',
    '  return null;',
    '}',
    splitscreenSource.slice(turboStart, turboEnd),
    splitscreenSource.slice(durationStart, durationEnd),
    splitscreenSource.slice(detectStart, detectEnd),
    splitscreenSource.slice(sharedStart, harvestEnd),
    splitscreenSource.slice(extractStart, extractEnd),
    splitscreenSource.slice(helpersStart, helpersEnd),
    splitscreenSource.slice(resolverStart, resolverEnd),
  ].join('\n');
}

test('manifest registers document_start nvs-ui-guard and keeps whoreshub-player synced', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(selectorDir, 'manifest.json'), 'utf8'));
  const guardEntry = manifest.content_scripts.find(
    (entry) => Array.isArray(entry.js) && entry.js.includes('nvs-ui-guard.js'),
  );
  assert.ok(guardEntry, 'nvs-ui-guard.js must be registered in manifest content_scripts');
  assert.equal(guardEntry.run_at, 'document_start');

  const selectorPlayer = fs.readFileSync(path.join(selectorDir, 'whoreshub-player.js'));
  const galleryPlayer = fs.readFileSync(path.join(galleryDir, 'whoreshub-player.js'));
  assert.ok(selectorPlayer.equals(galleryPlayer), 'whoreshub-player.js must match Nexus_Gallery byte-for-byte');
});

test('nvs-ui-guard blocks capture-phase document popunders while activating card player and splitscreen play button', async () => {
  const guardCode = fs.readFileSync(path.join(selectorDir, 'nvs-ui-guard.js'), 'utf8');
  const playerCode = fs.readFileSync(path.join(selectorDir, 'whoreshub-player.js'), 'utf8');

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://cdn.example/**', (route) => {
      setTimeout(() => { route.abort().catch(() => {}); }, 2500);
    });
    await page.route('https://listing.example/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><body>
          <article class="video-card" data-nvs-processed="1" data-nvs-url="https://listing.example/video/alpha">
            <a class="thumb-wrap" href="/video/alpha">
              <div class="thumb-img"><img src="/thumb.jpg" alt="Alpha Video"></div>
            </a>
          </article>
          <div id="nuss-quick-selection" style="position:fixed;bottom:20px;left:20px;z-index:99999">
            <button type="button" data-quick="play">▶ Prehrať vybrané (1)</button>
          </div>
          <script>
            window.__popunderTriggered = 0;
            window.__anchorNavigated = 0;
            // Capture listener registered at page load (simulates ExoClick popunder1000.js)
            for (const evt of ['mousedown', 'pointerdown', 'click']) {
              document.addEventListener(evt, (e) => {
                if (!e.isTrusted) return;
                window.__popunderTriggered++;
                e.preventDefault();
                e.stopImmediatePropagation();
              }, true);
            }
            document.querySelector('a.thumb-wrap').addEventListener('click', (e) => {
              e.preventDefault();
              window.__anchorNavigated++;
            });
          </script>
        </body></html>`,
      });
    });

    await page.addInitScript(guardCode);
    await page.goto('https://listing.example/videos', { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: playerCode });

    const setupResult = await page.evaluate(() => {
      window.__quickPlayTriggered = 0;
      document
        .querySelector('#nuss-quick-selection [data-quick="play"]')
        .addEventListener('click', () => { window.__quickPlayTriggered++; });

      const panel = document.createElement('div');
      panel.innerHTML = '<div class="nvs-actions"></div>';
      document.body.appendChild(panel);
      const player = window.NVSListingPlayer.attach(document.body, panel, {
        label: 'LISTING',
        cardSelector: '.video-card',
        playHost: (card) => card.querySelector('.thumb-img'),
        collect: (root) => Array.from(root.querySelectorAll('.video-card')).map((card) => ({
          url: card.getAttribute('data-nvs-url'),
          title: 'Alpha Video',
          card,
        })),
        embedUrl: (entry) => entry.url,
        probeSize: async () => ({ bytes: 1048576 }),
        resolve: async () => ([
          { url: 'https://cdn.example/video.mp4', quality: '1080p', height: 1080, type: 'mp4' },
        ]),
      });
      player.refresh();
    });

    await page.waitForSelector('.nvs-wh-play', { timeout: 5000 });
    const buttonCount = await page.locator('.nvs-wh-play').count();
    assert.equal(buttonCount, 1);

    await page.locator('.nvs-wh-play').first().click();
    await page.waitForSelector('#nvs-wh-player video[src*="cdn.example"]', { state: 'attached', timeout: 5000 });

    const afterPlayClick = await page.evaluate(() => ({
      popunder: window.__popunderTriggered,
      anchor: window.__anchorNavigated,
      modalOpen: Boolean(document.querySelector('#nvs-wh-player')),
      videoSrc: document.querySelector('#nvs-wh-player video')?.getAttribute('src')
        || document.querySelector('#nvs-wh-player video')?.currentSrc || '',
    }));

    assert.equal(afterPlayClick.popunder, 0, 'capture popunder must not see click on .nvs-wh-play');
    assert.equal(afterPlayClick.anchor, 0, 'parent anchor must not see click on .nvs-wh-play');
    assert.equal(afterPlayClick.modalOpen, true, '#nvs-wh-player modal must open in same window');
    assert.match(afterPlayClick.videoSrc, /https:\/\/cdn\.example\/video\.mp4/);

    // Close modal so quick-selection bar is clickable, then verify splitscreen quick-play guard
    await page.keyboard.press('Escape');
    await page.locator('#nuss-quick-selection [data-quick="play"]').click();

    const afterQuickPlay = await page.evaluate(() => ({
      popunder: window.__popunderTriggered,
      quickPlay: window.__quickPlayTriggered,
    }));
    assert.equal(afterQuickPlay.popunder, 0, 'capture popunder must not intercept #nuss-quick-selection button');
    assert.equal(afterQuickPlay.quickPlay, 1, 'splitscreen Play Selected handler must run');
  } finally {
    await browser.close();
  }
});

test('splitscreen harvests selected unusual-route selector cards and resolves cached & nested embed streams', async () => {
  const slice = extractSplitscreenSlice();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://listing.example/**', (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html><body>
        <div class="box nvs-card-selected" data-nvs-processed="1" data-nvs-url="https://listing.example/video/one">
          <a href="/428191-odd-route.html"><img src="/thumb1.jpg" alt="One"></a>
        </div>
        <article class="video-card nvs-card-selected" data-nvs-processed="1" data-nvs-url="https://listing.example/video/two">
          <a href="/256241-embed-route.html"><img src="/thumb2.jpg" alt="Two"></a>
        </article>
      </body></html>`,
    }));

    await page.goto('https://listing.example/', { waitUntil: 'domcontentloaded' });

    const outcome = await page.evaluate(async (code) => {
      const cards = document.querySelectorAll('[data-nvs-processed="1"]');
      cards[0].dataset.nexusVideoMeta = JSON.stringify({
        version: 1,
        playUrl: 'https://cdn.example/hls/master.m3u8?token=abc',
        playFormat: 'hls',
        durationSec: 125,
      });

      const factory = new Function(`
        ${code}
        return {
          setNetwork(map) { __fallbackNetwork = map; },
          harvest() { return harvestGenericVideoCards(); },
          resolve(item) { return resolveStreamUrl(item); }
        };
      `);
      const api = factory();
      api.setNetwork({
        'https://listing.example/video/two': {
          status: 200,
          finalUrl: 'https://listing.example/video/two',
          responseText: '<html><iframe src="https://embed-hop1.example/e/abc"></iframe></html>',
        },
        'https://embed-hop1.example/e/abc': {
          status: 200,
          finalUrl: 'https://embed-hop1.example/e/abc',
          responseText: '<script>var file="https:\\/\\/tops.mydaddy.cc\\/pubs\\/xyz\\/1080.mp4\\";</script>',
        },
      });

      const items = api.harvest();
      const urlOne = await api.resolve(items[0]);
      const urlTwo = await api.resolve(items[1]);
      return {
        count: items.length,
        selectedFlags: items.map((i) => i.isSelectedOnPage),
        urls: items.map((i) => i.url),
        resolvedOne: { directUrl: urlOne, format: items[0].type },
        resolvedTwo: { directUrl: urlTwo, format: items[1].type },
      };
    }, slice);

    assert.equal(outcome.count, 2);
    assert.deepEqual(outcome.selectedFlags, [true, true]);
    assert.deepEqual(outcome.urls, [
      'https://listing.example/video/one',
      'https://listing.example/video/two',
    ]);
    assert.equal(outcome.resolvedOne.directUrl, 'https://cdn.example/hls/master.m3u8?token=abc');
    assert.equal(outcome.resolvedOne.format, 'hls');
    assert.equal(outcome.resolvedTwo.directUrl, 'https://tops.mydaddy.cc/pubs/xyz/1080.mp4');
    assert.equal(outcome.resolvedTwo.format, 'mp4');
  } finally {
    await browser.close();
  }
});
