const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');

const userscriptPath = path.join(__dirname, '../userscripts/nexus-universal-splitscreen.user.js');
const templatePath = path.join(__dirname, '../app/templates/sxyprn_discovery.html');
const source = fs.readFileSync(userscriptPath, 'utf8');
const templateHtml = fs.readFileSync(templatePath, 'utf8');

function extractSlice(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Could not find slice: ${startMarker} .. ${endMarker}`);
  return source.slice(start, end);
}

test('harvestGenericVideoCards scans /sxyprn .sxy-card items without picking up hover-vid previews', async () => {
  const turboSlice = extractSlice('  function turboVideoInfo(', '\n  function isPixeldrain(');
  const durationSlice = extractSlice('  function formatDuration(sec)', '\n  function detectFormat(');
  const sharedSlice = extractSlice('  function sharedCard(item)', '\n  function harvestGenericVideoCards()');
  const genericSlice = extractSlice('  function harvestGenericVideoCards()', '\n  // ---------------------------------------------------------------------------');
  const code = [
    'const applyMetadataFromCache = () => false;',
    turboSlice,
    durationSlice,
    sharedSlice,
    genericSlice,
    'return harvestGenericVideoCards();',
  ].join('\n');

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('http://127.0.0.1:8000/**', route => route.fulfill({ body: '', contentType: 'text/html' }));
    await page.goto('http://127.0.0.1:8000/sxyprn');
    await page.setContent(`
      <div class="sxy-grid">
        <div class="sxy-card selected"
             data-nexus-split-watch="https://sxyprn.com/post/6afe3817cfc9e.html"
             data-nexus-split-iframe="https://vidara.so/e/abc12345"
             data-nexus-video-meta='{"title":"Selected SxyPrn Clip","duration":2086,"sizeMb":578,"sizeEstimated":false,"quality":"720p","height":720,"mirrorUrl":"https://vidara.so/v/abc12345","embedUrl":"https://vidara.so/e/abc12345","extUrls":["https://vidara.so/v/abc12345"]}'>
          <div class="card-thumb">
            <img src="https://b1.trafficdeposit.com/pivi/small.jpg" />
            <video class="hover-vid" src="https://b1.trafficdeposit.com/pivi/vidthumb.mp4"></video>
            <div class="card-duration">34:46</div>
            <div class="card-size">578 MB</div>
            <div class="card-quality">720p</div>
          </div>
          <div class="card-info">
            <div class="card-title">Selected SxyPrn Clip</div>
            <a class="btn-open" href="https://sxyprn.com/post/6afe3817cfc9e.html">↗</a>
          </div>
        </div>
        <div class="sxy-card"
             data-nexus-split-watch="https://sxyprn.com/post/6afbf153e7f4f.html">
          <div class="card-thumb">
            <img src="https://b1.trafficdeposit.com/pivi/other.jpg" />
            <div class="card-duration">29:44</div>
            <div class="card-quality">HD</div>
          </div>
          <div class="card-info">
            <div class="card-title">Unselected Clip</div>
            <a class="btn-open" href="https://sxyprn.com/post/6afbf153e7f4f.html">↗</a>
          </div>
        </div>
      </div>
    `);

    const items = await page.evaluate(fnBody => new Function(fnBody)(), code);
    assert.equal(items.length, 2);
    assert.equal(items[0].watchUrl, 'https://sxyprn.com/post/6afe3817cfc9e.html');
    assert.equal(items[0].title, 'Selected SxyPrn Clip');
    assert.equal(items[0].duration, 2086);
    assert.equal(items[0].size, 578 * 1024 * 1024);
    assert.equal(items[0].quality, '720p');
    assert.equal(items[0].mirrorUrl, 'https://vidara.so/v/abc12345');
    assert.equal(items[0].embedUrl, 'https://vidara.so/e/abc12345');
    assert.equal(items[0].isSelectedOnPage, true);
    assert.equal(items[1].isSelectedOnPage, false);
    assert.equal(items[1].quality, 'HD');
  } finally {
    await browser.close();
  }
});

test('resolveStreamUrl handles SxyPrn direct streams and iframe fallbacks instead of returning null', async () => {
  const sxyKeySlice = extractSlice('  function sxyprnPostKey(', '\n  function sharedDuration(');
  const resolveSlice = extractSlice('  async function resolveStreamUrl(', '\n  function mergeSelectedPageCards(');

  function buildResolver(mockBackend) {
    const context = {
      URL,
      Set,
      Array,
      JSON,
      console,
      location: { href: 'http://127.0.0.1:8000/sxyprn', origin: 'http://127.0.0.1:8000', hostname: '127.0.0.1', protocol: 'http:' },
      sharedCard: () => null,
      isEpornerUrl: () => false,
      isBeegHost: () => false,
      isNoodleMagazineHost: () => false,
      isCamwhores: () => false,
      resolveThroughSelector: async () => null,
      turboVideoInfo: () => null,
      isBunkrOrTurbo: () => false,
      isPixeldrain: () => false,
      isXHamster: () => false,
      detectFormat: u => (/\.m3u8/i.test(u) ? 'hls' : 'mp4'),
      resolveViaNexusBackend: mockBackend,
    };
    vm.createContext(context);
    vm.runInContext(`${sxyKeySlice}\n${resolveSlice}`, context);
    return context.resolveStreamUrl;
  }

  // Case 1: Backend returns HLS stream
  const resolveDirect = buildResolver(async (result) => {
    result.directUrl = 'http://127.0.0.1:8000/hls_proxy?url=https%3A%2F%2Fcdn.example%2Fmaster.m3u8';
    result.type = 'hls';
    result.isIframe = false;
    result.isResolved = true;
    return result.directUrl;
  });
  const directItem = { watchUrl: 'https://sxyprn.com/post/6afe3817cfc9e.html', url: 'https://sxyprn.com/post/6afe3817cfc9e.html' };
  const directOut = await resolveDirect(directItem);
  assert.match(directOut, /hls_proxy/);
  assert.equal(directItem.isIframe, false);
  assert.equal(directItem.isResolved, true);

  // Case 2: Backend returns iframe embed (e.g. Vidara/Byse/Dood fallback)
  const resolveIframe = buildResolver(async (result) => {
    result.directUrl = 'http://127.0.0.1:8000/embed_proxy?url=https%3A%2F%2Fbysesukior.com%2Fe%2Fabc';
    result.type = 'iframe';
    result.isIframe = true;
    result.isResolved = true;
    return result.directUrl;
  });
  const iframeItem = { watchUrl: 'https://sxyprn.com/post/6afbf153e7f4f.html', url: 'https://sxyprn.com/post/6afbf153e7f4f.html' };
  const iframeOut = await resolveIframe(iframeItem);
  assert.match(iframeOut, /embed_proxy/);
  assert.equal(iframeItem.isIframe, true);
  assert.equal(iframeItem.isResolved, true);

  // Case 3: Backend returns nothing, falls back to card embedUrl
  const resolveFallbackEmbed = buildResolver(async () => null);
  const embedItem = {
    watchUrl: 'https://sxyprn.com/post/6afbf153e7f4f.html',
    url: 'https://sxyprn.com/post/6afbf153e7f4f.html',
    embedUrl: 'https://vidara.so/e/abc12345',
  };
  const embedOut = await resolveFallbackEmbed(embedItem);
  assert.equal(embedOut, 'https://vidara.so/e/abc12345');
  assert.equal(embedItem.isIframe, true);
  assert.equal(embedItem.type, 'iframe');
});

test('sxyprn_discovery.html and userscript share matching Split-Screen contract', () => {
  assert.match(templateHtml, /openSplitScreen\(/);
  assert.match(templateHtml, /nexus-sxyprn-split-open/);
  assert.match(templateHtml, /nexus-sxyprn-split-picker/);
  assert.match(templateHtml, /data-nexus-split-watch/);
  assert.match(templateHtml, /data-nexus-video-meta/);

  assert.match(source, /nexus-sxyprn-split-open/);
  assert.match(source, /nexus-sxyprn-split-picker/);
  assert.match(source, /nexusSxyprnSplitReady/);
});
