const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const bgPath = path.resolve(__dirname, '../background.js');
const contentPath = path.resolve(__dirname, '../content.js');

function loadBackgroundContext(extra = {}) {
  const src = fs.readFileSync(bgPath, 'utf8');
  const headStart = src.indexOf('async function fetchHeadSize(');
  const headEnd = src.indexOf('function isFapFolderUrl(', headStart);
  const tapeStart = src.indexOf('function isStreamtapeGetVideoUrl(');
  const tapeEnd = src.indexOf('function internetChicksMediaUrls(', tapeStart);
  assert.ok(headStart >= 0 && headEnd > headStart, 'background.js head/extract slice found');
  assert.ok(tapeStart >= 0 && tapeEnd > tapeStart, 'background.js streamtape slice found');

  const slice = `${src.slice(headStart, headEnd)}\n${src.slice(tapeStart, tapeEnd)}`;
  const context = {
    URL,
    Headers,
    AbortController,
    AbortSignal,
    Number,
    String,
    Boolean,
    Promise,
    Math,
    Set,
    parseInt,
    parseFloat,
    isNaN,
    setTimeout,
    clearTimeout,
    chrome: {
      tabs: { sendMessage: (_tabId, _msg, cb) => cb(null) },
      runtime: { lastError: null },
    },
    extractPornhubMediaMeta: async () => null,
    normalizeQualityLabel: (q) => String(q || '').toUpperCase(),
    isReasonableSizeEstimate: (mb) => Number(mb) > 0,
    calculateQualityFromBitrate: () => null,
    extractLuluHlsUrl: () => '',
    normalizeDate: (raw) => {
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    },
    fetchHtml: async () => '',
    ...extra,
  };
  vm.createContext(context);
  vm.runInContext(slice, context);
  return context;
}

test('PornHat get_file/*.mp4/ redirecting to HLS playlist resolves quality and size', async () => {
  const ctx = loadBackgroundContext({
    fetch: async (url, opts = {}) => {
      const u = String(url);
      if (u === 'https://www.pornhat.com/get_file/13/hash/811000/811113/811113_720p.mp4/') {
        if (opts.method === 'HEAD') {
          return {
            ok: true,
            url: 'https://nvms3.cdn.privatehost.com/hls/811113.m3u8',
            headers: new Headers({ 'content-type': 'application/vnd.apple.mpegurl' }),
          };
        }
        return {
          ok: true,
          url: 'https://nvms3.cdn.privatehost.com/hls/811113.m3u8',
          headers: new Headers({ 'content-type': 'application/vnd.apple.mpegurl' }),
          text: async () => [
            '#EXTM3U',
            '#EXT-X-STREAM-INF:BANDWIDTH=1539319,RESOLUTION=1280x720',
            'https://nvms3.cdn.privatehost.com/media/811113_720p.mp4/index-v1-a1.m3u8',
          ].join('\n'),
        };
      }
      if (u === 'https://nvms3.cdn.privatehost.com/hls/811113.m3u8') {
        return {
          ok: true,
          headers: new Headers({ 'content-type': 'application/vnd.apple.mpegurl' }),
          text: async () => [
            '#EXTM3U',
            '#EXT-X-STREAM-INF:BANDWIDTH=1539319,RESOLUTION=1280x720',
            'https://nvms3.cdn.privatehost.com/media/811113_720p.mp4/index-v1-a1.m3u8',
          ].join('\n'),
        };
      }
      if (u === 'https://nvms3.cdn.privatehost.com/media/811113_720p.mp4/index-v1-a1.m3u8') {
        return {
          ok: true,
          headers: new Headers(),
          text: async () => [
            '#EXTM3U',
            '#EXTINF:6.0,',
            'seg-1.ts',
            '#EXTINF:6.0,',
            'seg-2.ts',
          ].join('\n'),
        };
      }
      if (/seg-\d\.ts$/.test(u) && opts.method === 'HEAD') {
        return {
          ok: true,
          headers: new Headers({ 'content-length': String(10 * 1024 * 1024) }),
        };
      }
      return { ok: false, headers: new Headers(), text: async () => '' };
    },
  });

  const html = `
    <video>
      <source src="https://www.pornhat.com/get_file/13/hash/811000/811113/811113_720p.mp4/" type="video/mp4" label="720p">
    </video>
    <a data-preview-custom="https://www.pornhat.com/get_file/13/other/811000/811113/811113_preview360p.mp4/"></a>
  `;
  const result = await ctx.extractQualityAndSizeAsync(html, '16:55', 1, 'https://www.pornhat.com/video/sample/');
  assert.equal(result.quality, '720P');
  assert.equal(result.sizeMb, 20);
  assert.equal(result.sizeText, '~20 MB');
  assert.equal(result.sizeEstimated, true);
});

test('FreeusePorn var video_duration = "608.108" parses to 10:08', () => {
  const ctx = loadBackgroundContext();
  const html = '<script>var video_duration = "608.108";</script>';
  assert.equal(ctx.extractDuration(html), '10:08');
});

test('FreeusePorn ignores Tailwind max-w-[1800px] mt-16 mb false match and probes real MP4', async () => {
  const ctx = loadBackgroundContext({
    fetch: async (url, opts = {}) => {
      if (String(url).includes('10629_1080p.mp4') && opts.method === 'HEAD') {
        return {
          ok: true,
          headers: new Headers({
            'content-type': 'video/mp4',
            'content-length': String(149 * 1024 * 1024),
            'last-modified': 'Tue, 17 Nov 2026 16:20:22 GMT',
          }),
        };
      }
      return { ok: false, headers: new Headers(), text: async () => '' };
    },
  });

  const html = `
    <div class="max-w-[1800px] mx-auto px-4 lg:px-8 mt-10 md:mt-16 mb-12"></div>
    <video><source src="https://www.freeuseporn.com/media/videos/h264/10629_1080p.mp4" type="video/mp4"></video>
  `;
  const res = await ctx.extractQualityAndSizeAsync(html, '10:08', 1, 'https://www.freeuseporn.com/video/10629/sample');
  assert.equal(res.quality, '1080P');
  assert.equal(res.sizeMb, 149);
  assert.equal(res.sizeText, '149 MB');
  assert.equal(res.lastModifiedDate, 'Nov 17, 2026');
  assert.equal(res.streamUrl, 'https://www.freeuseporn.com/media/videos/h264/10629_1080p.mp4');
});

test('CyberLeaks strtape.cloud iframe resolves stream URL, size and Last-Modified date', async () => {
  const strtapeEmbedHtml = `
    <span id="botlink" style="display:none;">/strtape.cloud/get_video?id=old</span>
    <script>
      document.getElementById('botlink').innerHTML = '//strtape.cloud/get_video?'+ ('xyzaid=plJolOOYl4srv9Z&expires=1795337989&ip=123&token=abc').substring(4);
    </script>
  `;
  const ctx = loadBackgroundContext({
    fetchHtml: async (url) => (String(url).includes('strtape.cloud/e/') ? strtapeEmbedHtml : ''),
    fetch: async (url, opts = {}) => {
      if (String(url).includes('strtape.cloud/get_video?') && opts.method === 'HEAD') {
        return {
          ok: true,
          headers: new Headers({
            'content-type': 'video/mp4',
            'content-length': String(260 * 1024 * 1024),
            'last-modified': 'Thu, 19 Nov 2026 07:57:39 GMT',
          }),
        };
      }
      return { ok: false, headers: new Headers(), text: async () => '' };
    },
  });

  const postHtml = '<iframe title="player" src="https://strtape.cloud/e/plJolOOYl4srv9Z"></iframe>';
  const result = await ctx.extractQualityAndSizeAsync(postHtml, null, 1, 'https://cyberleaks.top/post/sample');
  assert.equal(result.sizeMb, 260);
  assert.equal(result.sizeText, '260 MB');
  assert.equal(result.lastModifiedDate, 'Nov 19, 2026');
  assert.equal(result.streamUrl, 'https://strtape.cloud/get_video?id=plJolOOYl4srv9Z&expires=1795337989&ip=123&token=abc&stream=1');
});

test('content.js contracts match FreeusePorn /video/<id> and CyberLeaks /post/<slug> cards', () => {
  const src = fs.readFileSync(contentPath, 'utf8');
  assert.match(src, /isFreeusePornPage\(/);
  assert.match(src, /isCyberLeaksPage\(/);
  assert.match(src, /\(\^\|\\\.\)freeuseporn\\\.com\$/);
  assert.match(src, /\(\^\|\\\.\)cyberleaks\\\.\(\?:top\|net\|com\|org\)\$/);
  assert.match(src, /if \(isFreeusePornPage\(\) && link\?\.matches\?\.\('a\[href\*="\/video\/"\]'\)\)\s*\{\s*return link;/);
  assert.match(src, /if \(isCyberLeaksPage\(\) && link\?\.matches\?\.\('a\[href\*="\/post\/"\]'\)\)\s*\{\s*return link;/);
});
