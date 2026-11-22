const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const bgPath = path.resolve(__dirname, '../background.js');
const contentPath = path.resolve(__dirname, '../content.js');

function loadBackgroundSlice(extra = {}) {
  const src = fs.readFileSync(bgPath, 'utf8');
  const start = src.indexOf('async function fetchHeadSize(');
  const end = src.indexOf('function isFapFolderUrl(', start);
  assert.ok(start >= 0 && end > start, 'background.js slice found');

  const slice = src.slice(start, end);
  const context = {
    URL,
    Headers,
    AbortController,
    AbortSignal,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    crypto: globalThis.crypto,
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
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
    calculateQualityFromBitrate: (mb, dur) => (mb > 0 && dur ? '720P' : null),
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

test('HDSex decodes &amp; in .m3u8 URLs and extracts HLS quality and size', async () => {
  const seenUrls = [];
  const ctx = loadBackgroundSlice({
    fetch: async (url, opts = {}) => {
      const u = String(url);
      seenUrls.push(u);
      if (u === 'https://nlv01.hdsex.org/7/7/4/abc/stream/1080p/index.m3u8?h=sig&e=123') {
        return {
          ok: true,
          headers: new Headers({ 'content-type': 'application/vnd.apple.mpegurl' }),
          text: async () => '#EXTM3U\n#EXTINF:6.0,\nseg0.ts\n#EXTINF:6.0,\nseg1.ts\n',
        };
      }
      if (/seg\d\.ts$/.test(u) && opts.method === 'HEAD') {
        return {
          ok: true,
          headers: new Headers({ 'content-length': String(12 * 1024 * 1024) }),
        };
      }
      return { ok: false, headers: new Headers(), text: async () => '' };
    },
  });

  const html = '<source src="https://nlv01.hdsex.org/7/7/4/abc/stream/1080p/index.m3u8?h=sig&amp;e=123" type="application/x-mpegURL"/>';
  const res = await ctx.extractQualityAndSizeAsync(html, '0:12', 1, 'https://hdsex.org/video/525673665');
  assert.ok(seenUrls.some((u) => u.includes('?h=sig&e=123')), 'should decode &amp; before fetching m3u8');
  assert.equal(res.sizeMb, 24);
  assert.equal(res.sizeText, '~24 MB');
  assert.equal(res.sizeEstimated, true);
});

test('01Tube decodes cyrillic base164 video_url and extracts API date, duration and size', async () => {
  const sampleEncoded = 'L2dldF9maWxlLz\u0415vODcz\u041cGRlYjIwZDIyZGIzYz\u0415z\u041czNkNWJi\u041cj\u0412hYzY5OWVmNDI2YTI5YzVmLzc3\u041cj\u0410w\u041c\u042183NzIzOTcvNzcy\u041czk3Lm1wN\u04218,ZD00OD\u0410mYnI9\u041cjQxJnRpPT\u04153OTUyNz\u0410xNTg~';
  const ctx = loadBackgroundSlice({
    fetch: async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/api/json/video/86400/0/772000/772397.json')) {
        return {
          ok: true,
          json: async () => ({
            video: { post_date: '2026-11-21 13:50:02', duration: '8:00' },
          }),
        };
      }
      if (u.includes('/api/videofile.php?video_id=772397')) {
        return {
          ok: true,
          json: async () => [{ video_url: sampleEncoded }],
        };
      }
      if (u.startsWith('https://01tube.com/get_file/') && opts.method === 'HEAD') {
        return {
          ok: true,
          headers: new Headers({
            'content-type': 'video/mp4',
            'content-length': String(45 * 1024 * 1024),
          }),
        };
      }
      return { ok: false, headers: new Headers(), text: async () => '' };
    },
  });

  const meta = await ctx.extract01TubeMeta('https://01tube.com/videos/772397/can-nat-chair-tied/');
  assert.equal(meta.date, 'Nov 21, 2026');
  assert.equal(meta.duration, '8:00');
  assert.equal(meta.sizeMb, 45);
  assert.equal(meta.sizeText, '45 MB');
  assert.equal(meta.quality, '360P');
});

test('PureGirl decrypts AES-GCM playback_source and extracts date and size', async () => {
  const ctx = loadBackgroundSlice({
    fetch: async (url, opts = {}) => {
      const u = String(url);
      if (u === 'https://puregirl.tv/api/post/sample-post') {
        return {
          ok: true,
          json: async () => ({
            data: {
              id: 'sample-post',
              create_time: 1795219195000,
              duration_string: '04:15',
              resolution_string: 'HD',
              playback_format_type: 'mp4',
              playback_source: [
                {
                  file: 'XSZgKXA2mIEZpc1W5KiEfwWtWM49pEO-O8lRl7O6Ryv8Iy1CvRb6mWgFB8bSUJlyKJZGZyvWYUaEbadr9tS6L4ZieDCMSkt1NnqY6yM3Q3RUvkMaYpynR4octka86BynxjApIWJ16K2BqiV8eSqcC7Erh8a8RAtrr3_3LkOYBBaeL7YI7A4rYgc82wChE56V',
                  label: '720',
                  secret: '3tRu3RF1BKHINAzt',
                },
              ],
            },
          }),
        };
      }
      if (u.startsWith('https://streamtape.com/get_video?') && opts.method === 'HEAD') {
        return {
          ok: true,
          headers: new Headers({
            'content-type': 'video/mp4',
            'content-length': String(88 * 1024 * 1024),
          }),
        };
      }
      return { ok: false, headers: new Headers(), text: async () => '' };
    },
  });

  const meta = await ctx.extractPureGirlMeta('https://puregirl.tv/post/sample-post', 1);
  assert.equal(meta.duration, '04:15');
  assert.equal(meta.quality, '720P');
  assert.equal(meta.sizeMb, 88);
  assert.equal(meta.sizeText, '88 MB');
  assert.ok(meta.streamUrl.startsWith('https://streamtape.com/get_video?'));
});

test('content.js contracts match puregirl.tv, hdsex.org, fig.to, bravotube.tv and 01tube.com', () => {
  const src = fs.readFileSync(contentPath, 'utf8');
  assert.match(src, /isPureGirlPage\(/);
  assert.match(src, /isHdSexPage\(/);
  assert.match(src, /isFigToPage\(/);
  assert.match(src, /isBravoTubePage\(/);
  assert.match(src, /is01TubePage\(/);
  assert.match(src, /if \(isHdSexPage\(\)\)\s*\{\s*const card = link\.closest\('\.video'\);/);
  assert.match(src, /'\.video__preview'/);
  assert.match(src, /if \(isBravoTubePage\(\)\)\s*\{\s*const card = link\.closest\('span\.item, \.item'\);/);
});

test('BravoTube unwraps vp.privatez.link?u=... iframe and extracts target video size', async () => {
  const ctx = loadBackgroundSlice({
    fetchHtml: async (url) => {
      const u = String(url);
      if (u === 'https://bravotube.tv/embed/KMk7FMSfxFi/') {
        return '<iframe src="https://vp.privatez.link/?u=https%3A%2F%2Fxozilla.xxx%2Fvideos%2F846942%2Fsample%2F"></iframe>';
      }
      if (u === 'https://xozilla.xxx/videos/846942/sample/') {
        return '<video><source src="https://www.xozilla.xxx/get_file/5/hash/846000/846942/846942hd.mp4/?v-acctoken=1"></video>';
      }
      return '';
    },
    fetch: async (url, opts = {}) => {
      if (String(url).includes('846942hd.mp4') && opts.method === 'HEAD') {
        return {
          ok: true,
          headers: new Headers({
            'content-type': 'video/mp4',
            'content-length': String(120 * 1024 * 1024),
          }),
        };
      }
      return { ok: false, headers: new Headers(), text: async () => '' };
    },
  });

  const detailHtml = '<iframe src="https://bravotube.tv/embed/KMk7FMSfxFi/"></iframe>';
  const res = await ctx.extractQualityAndSizeAsync(detailHtml, '10:00', 1, 'https://bravotube.tv/video-KMk7FMSfxFi/sample/');
  assert.equal(res.sizeMb, 120);
  assert.equal(res.sizeText, '120 MB');
  assert.equal(res.quality, '720P');
});

test('PornHoarder resolves /player.php iframe via tab fallback and probes MP4', async () => {
  const ctx = loadBackgroundSlice({
    isPornHoarderUrl: (u) => /pornhoarder\./i.test(String(u)),
    fetchHtml: async () => '<title>Just a moment...</title>',
    chrome: {
      tabs: {
        sendMessage: (_tabId, msg, cb) => {
          if (msg.action === 'nvsFetchText' && String(msg.url).includes('pornhoarder.tv/player.php')) {
            cb('<script>var file = "https://cdn.example.test/video_720p.mp4";</script>');
          } else cb(null);
        },
      },
      runtime: { lastError: null },
    },
    fetch: async (url, opts = {}) => {
      if (String(url).includes('video_720p.mp4') && opts.method === 'HEAD') {
        return {
          ok: true,
          headers: new Headers({
            'content-type': 'video/mp4',
            'content-length': String(95 * 1024 * 1024),
          }),
        };
      }
      return { ok: false, headers: new Headers(), text: async () => '' };
    },
  });

  const watchHtml = '<iframe src="https://pornhoarder.tv/player.php?id=123"></iframe>';
  const res = await ctx.extractQualityAndSizeAsync(watchHtml, '12:00', 42, 'https://pornhoarder.tv/watch/sample');
  assert.equal(res.sizeMb, 95);
  assert.equal(res.sizeText, '95 MB');
  assert.equal(res.quality, '720P');
});

test('content.js contracts match pornhoarder.*', () => {
  const src = fs.readFileSync(contentPath, 'utf8');
  assert.match(src, /isPornHoarderPage\(/);
  assert.match(src, /pornhoarder\\\.\(\?:tv\|io\|net\|pictures\)/);
});

test('Porneec extracts contentUrl MP4 size, P0DT duration, and uploadDate', async () => {
  const ctx = loadBackgroundSlice({
    fetch: async (url, opts = {}) => {
      if (String(url) === 'https://pibsaonj.b-cdn.net/rfewrf.mp4' && opts.method === 'HEAD') {
        return {
          ok: true,
          status: 200,
          url: String(url),
          headers: new Headers({
            'content-type': 'video/mp4',
            'content-length': String(120 * 1024 * 1024),
          }),
        };
      }
      return { ok: false, status: 404, headers: new Headers(), text: async () => '' };
    },
  });

  const html = `
    <meta itemprop="duration" content="P0DT1H5M0S" />
    <meta itemprop="contentUrl" content="https://pibsaonj.b-cdn.net/rfewrf.mp4" />
    <meta itemprop="uploadDate" content="2026-11-21T19:04:45+00:00" />
  `;
  const res = await ctx.extractQualityAndSizeAsync(html, ctx.extractDuration(html), null, 'https://porneec.com/sample-video/');
  assert.equal(ctx.extractDuration(html), '1:05:00');
  assert.equal(res.sizeMb, 120);
  assert.equal(res.sizeText, '120 MB');
});

test('content.js contracts match porneec.com', () => {
  const src = fs.readFileSync(contentPath, 'utf8');
  assert.match(src, /isPorneecPage\(/);
  assert.match(src, /porneec\\\.com/);
  assert.match(src, /\.post-thumbnail/);
});
