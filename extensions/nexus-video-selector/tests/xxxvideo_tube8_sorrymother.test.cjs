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
  assert.ok(headStart >= 0 && headEnd > headStart, 'background.js head/extract slice found');

  const slice = src.slice(headStart, headEnd);
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

test('x-x-x.video ignores .mp4.jpg screenshots and falls back to flashvars quality when CDN HEAD fails', async () => {
  const probedUrls = [];
  const ctx = loadBackgroundContext({
    fetch: async (url) => {
      probedUrls.push(String(url));
      return { ok: false, headers: new Headers(), text: async () => '' };
    },
  });

  const html = `
    <script>
      var flashvars = {
        video_id: '676007',
        video_url: 'https://x-x-x.video/get_file/7/hash/676000/676007/676007_720p.mp4/?v-acctoken=abc',
        postfix: '_720p.mp4',
        preview_url1: 'https://x-x-x.video/contents/videos_screenshots/676000/676007/preview_720p.mp4.jpg',
        preview_height1: '720'
      };
    </script>
  `;
  const result = await ctx.extractQualityAndSizeAsync(html, '39:10', 1, 'https://x-x-x.video/videos/676007/test/');
  assert.ok(probedUrls.every((u) => !u.endsWith('.jpg')), 'should not probe .mp4.jpg screenshot URLs');
  assert.equal(result.quality, '720P');
});

test('SorryMother skips vip-preroll.mp4 and probes main med11.sorrymother.video MP4', async () => {
  const probedUrls = [];
  const ctx = loadBackgroundContext({
    fetch: async (url, opts = {}) => {
      probedUrls.push(String(url));
      if (String(url).includes('med11.sorrymother.video/videos/abc.mp4') && opts.method === 'HEAD') {
        return {
          ok: true,
          headers: new Headers({
            'content-type': 'video/mp4',
            'content-length': String(66 * 1024 * 1024),
            'last-modified': 'Mon, 16 Nov 2026 04:10:50 GMT',
          }),
        };
      }
      return { ok: false, headers: new Headers(), text: async () => '' };
    },
  });

  const html = `
    <script>var preroll = "https://sorrymother.to/wp-content/themes/sorrymother-videos/assets/media/vip-preroll.mp4";</script>
    <video><source src="https://med11.sorrymother.video/videos/abc.mp4?v=20260405" type="video/mp4"></video>
  `;
  const result = await ctx.extractQualityAndSizeAsync(html, null, 1, 'https://sorrymother.to/pornleaks/test/free-leaks');
  assert.ok(probedUrls.every((u) => !u.includes('vip-preroll.mp4')), 'should skip preroll MP4');
  assert.equal(result.sizeMb, 66);
  assert.equal(result.sizeText, '66 MB');
});

test('parseMp4MoovMeta extracts duration and quality from mvhd and tkhd atoms', () => {
  const ctx = loadBackgroundContext();
  const buf = Buffer.alloc(140);
  // mvhd v0 at offset 0: timescale=1000 (+16), duration=387000 (+20) => 6:27
  buf.write('mvhd', 0, 'ascii');
  buf.writeUInt8(0, 4);
  buf.writeUInt32BE(1000, 16);
  buf.writeUInt32BE(387000, 20);
  // tkhd v0 at offset 40: width=1280<<16 (+80 => 120), height=720<<16 (+84 => 124)
  buf.write('tkhd', 40, 'ascii');
  buf.writeUInt8(0, 44);
  buf.writeUInt32BE(1280 << 16, 120);
  buf.writeUInt32BE(720 << 16, 124);

  const meta = ctx.parseMp4MoovMeta(new Uint8Array(buf));
  assert.equal(meta.duration, '6:27');
  assert.equal(meta.quality, '720P');
});

test('probeMp4HeaderMeta falls back to tail range when moov atom is at end of MP4', async () => {
  const moovBuf = Buffer.alloc(140);
  moovBuf.write('mvhd', 0, 'ascii');
  moovBuf.writeUInt8(0, 4);
  moovBuf.writeUInt32BE(1000, 16);
  moovBuf.writeUInt32BE(600000, 20); // 10:00
  moovBuf.write('tkhd', 40, 'ascii');
  moovBuf.writeUInt8(0, 44);
  moovBuf.writeUInt32BE(1920 << 16, 120);
  moovBuf.writeUInt32BE(1080 << 16, 124);

  const rangesRequested = [];
  const ctx = loadBackgroundContext({
    Uint8Array,
    DataView,
    fetch: async (_url, opts = {}) => {
      const range = opts.headers?.Range || '';
      rangesRequested.push(range);
      if (range === 'bytes=0-65535') {
        return {
          ok: true,
          headers: new Headers({
            'content-type': 'video/mp4',
            'content-range': 'bytes 0-65535/500000',
          }),
          arrayBuffer: async () => new Uint8Array(64).buffer,
        };
      }
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'video/mp4' }),
        arrayBuffer: async () => moovBuf.buffer.slice(moovBuf.byteOffset, moovBuf.byteOffset + moovBuf.byteLength),
      };
    },
  });

  const meta = await ctx.probeMp4HeaderMeta('https://med11.sorrymother.video/videos/tail.mp4', 'https://sorrymother.to/');
  assert.equal(rangesRequested.length, 2);
  assert.equal(meta.duration, '10:00');
  assert.equal(meta.quality, '1080P');
});

test('scan-hud.js and content.js expose metadata field breakdown and missing-field retry', () => {
  const hudSrc = fs.readFileSync(path.resolve(__dirname, '../scan-hud.js'), 'utf8');
  const contentSrc = fs.readFileSync(contentPath, 'utf8');
  assert.match(hudSrc, /id="nvs-hud-f-size"/);
  assert.match(hudSrc, /id="nvs-hud-f-dur"/);
  assert.match(hudSrc, /id="nvs-hud-f-qual"/);
  assert.match(hudSrc, /id="nvs-hud-f-date"/);
  assert.match(hudSrc, /id="nvs-hud-cache-info"/);
  assert.match(contentSrc, /window\.__nvsGetCardCoverage\s*=\s*getCardCoverage/);
  assert.match(contentSrc, /if \(!cov\.complete\) return true;/);
});

test('content.js contracts match x-x-x.video, tube8.* and sorrymother.to cards', () => {
  const src = fs.readFileSync(contentPath, 'utf8');
  assert.match(src, /isXXXVideoPage\(/);
  assert.match(src, /isTube8Page\(/);
  assert.match(src, /isSorryMotherPage\(/);
  assert.match(src, /\(\^\|\\\.\)x-x-x\\\.video\$/);
  assert.match(src, /\(\^\|\\\.\)tube8\\\.\[a-z\]\+\$/);
  assert.match(src, /\(\^\|\\\.\)sorrymother\\\.to\$/);
  assert.match(src, /\\\/porn-video\\\/\\d\+/);
  assert.match(src, /\\\/pornleaks\\\/\[\^\/\?#\]\+/);
});
