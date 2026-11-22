const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync('extensions/nexus-video-selector/background.js', 'utf8');
const start = source.indexOf('async function extractQualityAndSizeAsync(');
const end = source.indexOf('\nfunction extractDuration(', start);
assert.notEqual(start, -1, 'XVideos metadata extractor exists');
assert.notEqual(end, -1, 'XVideos metadata extractor boundary exists');

test('XVideos rendition metadata probes include the watch-page referer', async () => {
  const requests = [];
  const context = {
    extractPornhubMediaMeta: async () => null,
    fetchHlsQualityAndSize: async () => null,
    fetchHeadSize: async (url, referer) => {
      requests.push({ url, referer });
      return 128;
    },
    formatSizeMb: mb => `${mb} MB`,
    isReasonableSizeEstimate: () => true,
    normalizeQualityLabel: value => String(value).toUpperCase(),
    calculateQualityFromBitrate: () => null,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  const pageUrl = 'https://www.xvideos.com/video.123/example';
  const streamUrl = 'https://cdn.example/video/opaque?token=abc';
  const metadata = await context.extractQualityAndSizeAsync(
    `html5player.setVideoUrlHigh('${streamUrl}');`,
    '1:00',
    7,
    pageUrl,
  );

  assert.deepEqual(requests, [{ url: streamUrl, referer: pageUrl }]);
  assert.equal(metadata.quality, '1080P');
  assert.equal(metadata.sizeMb, 128);
});
