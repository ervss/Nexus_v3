const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const importer = fs.readFileSync(path.join(root, 'drtuber_grid_importer.js'), 'utf8');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const popup = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const utilitiesStart = importer.indexOf('    function canonicalVideoUrl(');
const utilitiesEnd = importer.indexOf('    function qualityFromCard(', utilitiesStart);
const probeStart = background.indexOf('async function nexusDrtuberProbeSize(');
const probeEnd = background.indexOf('\nasync function nexusDrtuberImportBulk(', probeStart);
const importStart = probeEnd + 1;
const importEnd = background.indexOf('\n// The grid importer', importStart);

assert.notEqual(utilitiesStart, -1, 'DrTuber importer URL utilities exist');
assert.notEqual(utilitiesEnd, -1, 'DrTuber importer utility boundary exists');
assert.notEqual(probeStart, -1, 'DrTuber size probe exists');
assert.notEqual(probeEnd, -1, 'DrTuber size probe boundary exists');
assert.notEqual(importEnd, -1, 'DrTuber bulk importer boundary exists');

test('DrTuber Gallery is registered only for DrTuber pages', () => {
  const registration = manifest.content_scripts.find(entry => entry.js?.includes('drtuber_grid_importer.js'));
  assert.ok(registration);
  assert.ok(registration.matches.includes('https://www.drtuber.com/*'));
  assert.ok(registration.css.includes('drtuber_grid_importer.css'));
  assert.ok(fs.existsSync(path.join(root, registration.js[0])));
  assert.ok(fs.existsSync(path.join(root, registration.css[0])));
  assert.match(importer, /\.thumbs_box \.thumbs/);
  assert.match(background, /msg\.action === "DRTUBER_IMPORT_BULK"/);
  assert.match(background, /msg\.action === "DRTUBER_PROBE_SIZE"/);
});

test('DrTuber watch URLs normalize safely and retain a video slug', () => {
  const context = {
    URL,
    location: { href: 'https://www.drtuber.com/tags/bimbo' },
  };
  vm.createContext(context);
  vm.runInContext(importer.slice(utilitiesStart, utilitiesEnd), context);

  assert.equal(
    context.canonicalVideoUrl('/video/123456/example-video'),
    'https://www.drtuber.com/video/123456/example-video',
  );
  assert.equal(context.canonicalVideoUrl('/video/123456'), 'https://www.drtuber.com/video/123456');
  assert.equal(context.canonicalVideoUrl('https://example.com/video/123456'), '');
  assert.equal(context.parseDuration('1:02:03'), 3723);
  assert.equal(context.formatSize(125829120), '120 MB');
});

test('DrTuber Gallery leaves quality badges to Video Card Selector and separates file size', () => {
  const renderStart = importer.indexOf('    function renderCard(');
  const renderEnd = importer.indexOf('\n    function matchesFilters(', renderStart);
  const renderSource = importer.slice(renderStart, renderEnd);
  const styles = fs.readFileSync(path.join(root, 'drtuber_grid_importer.css'), 'utf8');
  const sizeStyle = styles.match(/\.nexus-drt-size\s*\{([^}]*)\}/)?.[1] || '';

  assert.doesNotMatch(renderSource, /chips\.push\(\['quality'/);
  assert.doesNotMatch(styles, /\.nexus-drt-quality\b/);
  assert.match(sizeStyle, /right:\s*7px\s*!important/);
  assert.match(sizeStyle, /bottom:\s*7px\s*!important/);
});

test('Quick Panel scrapes DrTuber cards instead of falling back to Base64 scanning', () => {
  const routeIndex = popup.indexOf('await handleDrtuberScraping(tab)');
  const fallbackIndex = popup.indexOf('await handleBase64Scraping(tab)');
  const scraperStart = popup.indexOf('function scrapeDrtuberCardsFromPage()');
  const scraperEnd = popup.indexOf('\nasync function handleDrtuberScraping(', scraperStart);
  assert.ok(routeIndex >= 0 && fallbackIndex > routeIndex);
  assert.ok(scraperStart >= 0 && scraperEnd > scraperStart);

  const image = {
    currentSrc: 'https://g1.drtst.com/thumb.jpg',
    getAttribute: name => ({ alt: 'DrTuber sample', src: '/thumb.jpg' })[name] || '',
  };
  const quality = { textContent: '', className: 'quality _4k' };
  const card = {
    href: '/video/123456/sample',
    textContent: '14:55 DrTuber sample 126 MB',
    getAttribute: name => name === 'href' ? '/video/123456/sample' : '',
    querySelector: selector => ({
      img: image,
      '.quality': quality,
      '.time_thumb': { textContent: '14:55' },
    })[selector] || null,
    querySelectorAll: selector => selector.includes('.quality') ? [quality] : [],
  };
  const context = {
    URL,
    location: { href: 'https://www.drtuber.com/tags/bimbo' },
    document: {
      querySelector: selector => selector === '.thumbs_box .thumbs'
        ? { querySelectorAll: () => [card] }
        : null,
    },
  };
  vm.createContext(context);
  vm.runInContext(popup.slice(scraperStart, scraperEnd), context);

  const [video] = context.scrapeDrtuberCardsFromPage();
  assert.equal(video.id, '123456');
  assert.equal(video.url, 'https://www.drtuber.com/video/123456/sample');
  assert.equal(video.title, 'DrTuber sample');
  assert.equal(video.duration, 895);
  assert.equal(video.height, 2160);
  assert.equal(video.sizeBytes, 126 * 1024 ** 2);
  assert.equal(video.thumbnail, 'https://g1.drtst.com/thumb.jpg');
});

test('DrTuber size probing is limited to trusted DrTuber pages and CDN media', async () => {
  const requests = [];
  const context = {
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: {
          get: name => ({
            'content-type': 'video/mp4',
            'content-length': '125829120',
          })[name],
        },
      };
    },
  };
  vm.createContext(context);
  vm.runInContext(background.slice(probeStart, probeEnd), context);

  const referer = 'https://www.drtuber.com/video/123/example';
  const result = await context.nexusDrtuberProbeSize(
    { url: 'https://gcdn.drtuber.com/video.mp4?token=abc', referer },
    { url: 'https://www.drtuber.com/tags/bimbo' },
  );
  assert.equal(result.sizeBytes, 125829120);
  assert.equal(requests[0].options.referrer, referer);

  await assert.rejects(
    context.nexusDrtuberProbeSize(
      { url: 'https://example.com/video.mp4', referer },
      { url: 'https://www.drtuber.com/tags/bimbo' },
    ),
    /Untrusted DrTuber media host/,
  );
  await assert.rejects(
    context.nexusDrtuberProbeSize(
      { url: 'https://gcdn.drtuber.com/video.mp4', referer },
      { url: 'https://example.com/' },
    ),
    /DrTuber video page/,
  );
});

test('DrTuber bulk imports preserve measured sizes and reject other providers', async () => {
  let payload;
  const context = {
    URL,
    findDashboardUrl: async () => 'http://localhost:8000',
    buildLocalApiHeaders: async headers => headers,
    fetch: async (url, options) => {
      payload = JSON.parse(options.body);
      return { ok: true, json: async () => ({ imported: 1 }) };
    },
  };
  vm.createContext(context);
  vm.runInContext(background.slice(importStart, importEnd), context);

  const response = await context.nexusDrtuberImportBulk({
    batchName: 'DrTuber test',
    items: [
      {
        url: 'https://www.drtuber.com/video/123/example',
        sizeBytes: 125829120,
        duration: 60,
        height: 720,
        tags: ['bimbo'],
      },
      { url: 'https://example.com/video/321' },
    ],
  });

  assert.equal(response.imported, 1);
  assert.equal(payload.videos.length, 1);
  assert.equal(payload.videos[0].file_size_mb, 120);
  assert.equal(payload.videos[0].tags, 'drtuber,bimbo');
  assert.equal(payload.videos[0].upload_date, undefined);
  assert.equal(payload.batch_name, 'DrTuber test');
});
