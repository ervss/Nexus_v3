const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const popupSource = readFileSync(join(__dirname, '../popup.js'), 'utf8');

function popupMediaExtractor() {
  const start = popupSource.indexOf('function extractMediaUrlFromHtml(');
  const end = popupSource.indexOf('async function resolveFullpornerDirectUrl(', start);
  assert.notEqual(start, -1, 'Gallery media extractor must exist');
  assert.notEqual(end, -1, 'Gallery media extractor end marker must exist');

  const context = vm.createContext({
    URL,
    console,
    DOMParser: class {
      parseFromString() {
        return { querySelectorAll: () => [] };
      }
    },
    inferVariantHeight(value) {
      const match = String(value || '').match(/[\/_-](2160|1440|1080|720|480|360|240)p?(?:[\/_.?#]|$)/i);
      return match ? Number(match[1]) : 0;
    },
  });
  vm.runInContext(popupSource.slice(start, end), context);
  return context.extractMediaUrlFromHtml;
}

test('Gallery preserves PimpBunny acctoken and chooses the highest rendition', () => {
  const extract = popupMediaExtractor();
  const low = 'https://pimpbunny.com/get_file/48/aaa/602000/602839/602839_720p.mp4/?v-acctoken=LOW';
  const high = 'https://pimpbunny.com/get_file/48/bbb/602000/602839/602839_1440p.mp4/?v-acctoken=HIGH';
  const preview = 'https://pimpbunny.com/get_file/48/ccc/602000/602839/602839_preview.mp4/?v-acctoken=PREVIEW';
  const html = `<script>const video_url='${low}'; const video_alt_url='${high}'; const trailer='${preview}';</script>`;

  assert.equal(extract(html, 'https://pimpbunny.com/videos/example/'), high);
  assert.match(extract(html, 'https://pimpbunny.com/videos/example/'), /\/\?v-acctoken=HIGH$/);
});

test('Gallery generic MP4 fallback keeps slash-before-query signatures intact', () => {
  const extract = popupMediaExtractor();
  const signed = 'https://cdn.example/video.mp4/?token=abc123&expires=999';
  assert.equal(extract(`<script>window.file='${signed}'</script>`, 'https://example.test/watch/1'), signed);
});

test('FNXTube opaque signed KVS URLs use their paired quality labels', () => {
  const low = 'https://fnxtube.com/get_file/0/opaque.mp4/?v-acctoken=LOW';
  const high = 'https://fnxtube.com/get_file/0/other.mp4/?v-acctoken=HIGH';
  const html = `video_url: '${low}', video_url_text: '720p', video_alt_url: '${high}', video_alt_url_text: '1080p'`;
  assert.equal(popupMediaExtractor()(html, 'https://fnxtube.com/videos/example/'), high);
});

test('Video Selector does not suppress PimpBunny metadata queueing', () => {
  const selector = readFileSync(join(__dirname, '../../nexus-video-selector/content.js'), 'utf8');
  const start = selector.indexOf('function enqueue(card, url, force = false)');
  const end = selector.indexOf('function processQueue()', start);
  assert.notEqual(start, -1, 'selector enqueue must exist');
  const enqueueBody = selector.slice(start, end);
  assert.doesNotMatch(enqueueBody, /pimpbunny.*return/i);
  assert.match(enqueueBody, /state\.queue\.push\(\{ card, url, force:/);
});

test('Video Selector asks the originating tab to measure signed PimpBunny media', async () => {
  const selectorBackground = readFileSync(join(__dirname, '../../nexus-video-selector/background.js'), 'utf8');
  const start = selectorBackground.indexOf('async function fetchPimpBunnySizeViaTab(');
  const end = selectorBackground.indexOf('// ── HTML Fetcher', start);
  assert.notEqual(start, -1, 'tab-context size helper must exist');
  assert.notEqual(end, -1, 'tab-context size helper end marker must exist');

  let sentTabId = null;
  let sentMessage = null;
  const context = vm.createContext({
    chrome: {
      runtime: { lastError: null },
      tabs: {
        sendMessage(tabId, message, callback) {
          sentTabId = tabId;
          sentMessage = message;
          callback({ sizeMb: 321 });
        },
      },
    },
  });
  vm.runInContext(selectorBackground.slice(start, end), context);

  const mediaUrl = 'https://pimpbunny.com/get_file/48/aaa/602000/602839/602839_1080p.mp4/?v-acctoken=SIGNED';
  const sizeMb = await context.fetchPimpBunnySizeViaTab(mediaUrl, 77);
  assert.equal(sizeMb, 321);
  assert.equal(sentTabId, 77);
  assert.equal(sentMessage.action, 'nvsProbeMediaSize');
  assert.equal(sentMessage.url, mediaUrl);
});

test('Video Selector retries cached PimpBunny metadata when size is missing', () => {
  const selectorBackground = readFileSync(join(__dirname, '../../nexus-video-selector/background.js'), 'utf8');
  const start = selectorBackground.indexOf('async function fetchVideoMeta(');
  const end = selectorBackground.indexOf('// ── Import to Nexus', start);
  assert.notEqual(start, -1, 'fetchVideoMeta must exist');
  const fetchBody = selectorBackground.slice(start, end);
  assert.match(fetchBody, /cached\s*&&\s*\(!isPimpBunnyUrl\(url\)\s*\|\|\s*Number\(cached\.sizeMb\s*\|\|\s*0\)\s*>\s*0\)/);
});

test('Gallery measures signed media in tab context and retries zero-size records', () => {
  assert.match(popupSource, /const probeMediaSize = async \(mediaUrl\) =>/);
  assert.match(popupSource, /size = await probeMediaSize\(directMediaUrl\)/);
  assert.match(popupSource, /isPimpBunnyUrl\(v\.source_url \|\| v\.url\)[\s\S]{0,180}getVideoSizeBytes\(v\) <= 0/);
});
