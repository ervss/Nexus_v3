const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const watchUrl = 'https://www.camwhores.tv/videos/123/example/';
const row = {
  url: watchUrl, ok: true, title: 'Example', duration: 3840,
  size_bytes: 664416961, width: 800, height: 600,
  quality: '600p', stream_url: 'https://cdn.example/video.mp4',
};

function sourceBetween(file, start, end) {
  const source = readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}

test('selector batches Camwhores URLs through the streaming Nexus resolver', async () => {
  const messages = [];
  const writes = [];
  const calls = [];
  const sse = [
    { type: 'start', total: 1 },
    { type: 'result', index: 0, result: { status: 'success', data: row } },
    { type: 'done' },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  const context = {
    isCamwhoresUrl: url => url.includes('camwhores.tv'),
    readCache: async () => null,
    writeCache: async (url, meta) => { writes.push([url, meta]); },
    fetchVideoMeta: async () => { throw new Error('fallback should not run'); },
    normalizeQualityLabel: value => value ? String(value).toUpperCase() : null,
    formatSizeMb: value => `${Math.round(value)} MB`,
    fetch: async (url, options) => {
      calls.push([url, JSON.parse(options.body)]);
      return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
    },
    chrome: { tabs: { sendMessage: async (...args) => { messages.push(args); } } },
    AbortSignal, TextDecoder, Uint8Array,
  };
  vm.runInNewContext(sourceBetween('nexus-video-selector/background.js',
    'function camwhoresMetaFromNexus(', 'function epawgDurationFromHtml('), context);
  const result = await context.fetchCamwhoresMetaBatch([{ url: watchUrl }], 7);

  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /\/api\/tester\/resolve\/stream$/);
  assert.deepEqual(calls[0][1].urls, [watchUrl]);
  assert.equal(calls[0][1].metadata_only, true);
  assert.equal(result[watchUrl].quality, '600P');
  assert.equal(result[watchUrl].duration, '1:04:00');
  assert.ok(result[watchUrl].sizeMb > 633);
  assert.equal(messages[0][1].type, 'CAMWHORES_META_PROGRESS');
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1].streamUrl, undefined);
});

test('Gallery primes Camwhores cards with one metadata batch', async () => {
  const cache = new Map();
  const calls = [];
  const context = {
    camwhoresMetadataCache: cache,
    DASHBOARD_REACHABLE: true,
    DASHBOARD_URL: 'http://localhost:8000',
    normalizeQualityLabel: value => value || '?',
    fetch: async (url, options) => {
      calls.push([url, JSON.parse(options.body)]);
      return { ok: true, json: async () => ({ results: [row] }) };
    },
    AbortSignal,
  };
  vm.runInNewContext(sourceBetween('Nexus_Gallery/popup.js',
    'async function primeCamwhoresMetadataBatch(', 'async function startCamwhoresVisibleMetadataPrimer('), context);
  const count = await context.primeCamwhoresMetadataBatch([{ source_url: watchUrl }]);

  assert.equal(count, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /\/api\/tester\/batch-meta$/);
  assert.equal(cache.get(watchUrl).quality, '600p');
  assert.equal(cache.get(watchUrl).size, 664416961);
});

test('Gallery displays measured Camwhores height instead of a lower quality bucket', () => {
  const context = {
    normalizeQualityLabel: value => value || '?',
    qualityLabelFromHeight: () => '480p',
    inferQualityLabelFromText: () => '',
  };
  vm.runInNewContext(sourceBetween('Nexus_Gallery/popup.js',
    'function getDisplayQualityLabel(', 'function getImportQualityLabel('), context);
  assert.equal(context.getDisplayQualityLabel({ source_url: watchUrl, quality: '600p', height: 600 }), '600p');
});
