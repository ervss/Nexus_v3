const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

function createBackgroundWorker(fetchImpl) {
  const context = {
    console, URL, Headers, AbortController, AbortSignal, setTimeout, clearTimeout, atob, btoa,
    fetch: fetchImpl || (async () => { throw new Error('unexpected fetch'); }),
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('extensions/nexus-video-selector/background.js', 'utf8'), context);
  return context;
}

test('Leakedzone URL matcher and token decoder', () => {
  const bg = createBackgroundWorker();

  // Test URL matching
  assert.equal(bg.isLeakedzoneUrl('https://leakedzone.com/kassiewallis/video/25595707'), true);
  assert.equal(bg.isLeakedzoneUrl('https://www.leakedzone.com/creator/short/123'), true);
  assert.equal(bg.isLeakedzoneUrl('https://leakedzone.com/creator/photo/456'), true);
  assert.equal(bg.isLeakedzoneUrl('https://evil.com/?leakedzone.com'), false);
  assert.equal(bg.isLeakedzoneUrl('https://leakedzone.com.evil.com/test'), false);

  // Test real Leakedzone token
  const realToken = '7fKtexSNqdeLLI2T==waO9mN0gXRZdFMzlGWhh2N9IzZpNnJ5MWO3YDOjNTNzMGZlFWY4cTMjJzMlhzM4'
    + 'ImMkRzY0gDMxI2Y0IWZlVWZhBjM0YWNjlTOyQDZilDMhBTNmljN00zZpNnJxETN4QDMykzNx0TZtlGd/'
    + 'gTdz0mL3AzN1kTN1IzL4U3Mt9SbvNmLl52b6RWZrFWZs9yL6MHc0RHayPiEaOEjoamelGk3';
  const expectedUrl = 'https://leakedzone.com/m3u8/25595707.m3u8?time=1792048511&'
    + 'sig=469f50a09bd4299c5f420aeeeeb4cb1084c4d2b838e32c178aaedc353c8679c9&sig2=7haXis0WYEx46oNk';
  assert.equal(bg.decodeLeakedzoneFile(realToken), expectedUrl);

  // Test synthetic token
  const target = 'https://leakedzone.com/m3u8/99999.m3u8';
  const b64 = Buffer.from(target).toString('base64');
  const wrapped = '1234567890123456' + [...b64].reverse().join('') + 'abcdefghijklmnop';
  assert.equal(bg.decodeLeakedzoneFile(wrapped), target);
});

test('Leakedzone extractLeakedzoneMeta extracts stream and metadata', async () => {
  const targetStream = 'https://leakedzone.com/m3u8/25595707.m3u8?token=xyz';
  const b64 = Buffer.from(targetStream).toString('base64');
  const wrapped = '1234567890123456' + [...b64].reverse().join('') + 'abcdefghijklmnop';

  const html = `
    <html>
      <head>
        <title>kassiewallis Leaked video #25595707 - Leakedzone</title>
      </head>
      <body>
        <div id="media-player">
          <img src="https://image-cdn.leakedzone.com/storage/images/219549/25595707/25595707_300.webp" alt="kassiewallis video">
        </div>
        <script>
          playerInstance.setup({
            file: f("${wrapped}")
          });
        </script>
      </body>
    </html>
  `;

  const m3u8Text = `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:4.004,
https://stream-cdn.example/seg1.ts
#EXTINF:4.004,
https://stream-cdn.example/seg2.ts
#EXT-X-ENDLIST`;

  const fetchMock = async (url) => {
    if (url.includes('.m3u8')) {
      return { ok: true, text: async () => m3u8Text, headers: new Headers({ 'content-type': 'application/x-mpegURL' }) };
    }
    if (url.includes('seg1.ts') || url.includes('seg2.ts')) {
      return { ok: true, status: 200, headers: new Headers({ 'content-length': '1048576' }), body: null };
    }
    throw new Error('Unexpected URL: ' + url);
  };

  const bg = createBackgroundWorker(fetchMock);
  const meta = await bg.extractLeakedzoneMeta(html, 'https://leakedzone.com/kassiewallis/video/25595707', 1);

  assert.equal(meta.streamUrl, targetStream);
  assert.equal(meta.title, 'kassiewallis Leaked video #25595707');
  assert.equal(meta.thumbnail, 'https://image-cdn.leakedzone.com/storage/images/219549/25595707/25595707_300.webp');
  assert.equal(meta.isHls, true);
  assert.equal(meta.adapter, 'leakedzone-source-v1');
});

test('Leakedzone content.js rules and pagination regex', () => {
  const contentCode = fs.readFileSync('extensions/nexus-video-selector/content.js', 'utf8');

  // 1. isLeakedzonePage() definícia
  assert.match(contentCode, /function isLeakedzonePage\(\)\s*\{/);

  // 2. siteVideoMatchers pravidlo
  assert.match(contentCode, /host:\s*\/\(\^\|\\\.\)leakedzone\\\.com\$\/i/);

  // 3. Selektory kariet a kontajnera
  assert.match(contentCode, /\.media-items a\[href\*="\/video\/"\]/);

  // 4. Parsovanie trvania a relatívneho dátumu
  assert.match(contentCode, /durSpan\.textContent\.trim\(\)/);
  assert.match(contentCode, /text-on-surface-faint/);

  // 5. Stránkovanie s ?page=
  assert.match(contentCode, /u\.searchParams\.get\(['"]page['"]\)/);
  assert.match(contentCode, /u\.searchParams\.set\(['"]page['"],\s*n\)/);
});
