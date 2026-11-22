const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

function worker(fetch) {
  const context = {
    console, URL, Headers, AbortController, AbortSignal, setTimeout, clearTimeout, atob, fetch,
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('extensions/nexus-video-selector/background.js', 'utf8'), context);
  return context;
}

const pageUrl = 'https://internetchicks.com/example-video/';
const article = `<button class="button_choice_server" onclick="playEmbed('https://streamtape.com/e/first'); hideVideoCover();">PLAYER 01</button>
<button class="button_choice_server" onclick="playEmbed('https://other.example/e/second'); hideVideoCover();">PLAYER 02</button>
<a href="https://ads.example/click">AD</a>`;

test('InternetChicks uses only player chooser URLs and parses the signed Streamtape media URL', () => {
  const bg = worker(async () => { throw new Error('unexpected fetch'); });
  assert.deepEqual(Array.from(bg.extractInternetChicksSources(article, pageUrl)), [
    'https://streamtape.com/e/first', 'https://other.example/e/second',
  ]);
  const embed = `document.getElementById('robotlink').innerHTML = '//streamtape.com'+ ('xcd/get_video?id=first&token=good').substring(2).substring(1);`;
  assert.equal(bg.internetChicksStreamtapeUrl(embed), 'https://streamtape.com/get_video?id=first&token=good&stream=1');
  assert.equal(bg.internetChicksStreamtapeUrl(`document.getElementById('botlink').innerHTML = '//strea'+ ('xyzamtape.com/get_video?id=first&token=good').substring(4);`), 'https://streamtape.com/get_video?id=first&token=good&stream=1');
  assert.equal(bg.internetChicksStreamtapeUrl(`document.getElementById('botlink').innerHTML = '//streamtape.com/ge'+ ('xyzat_video?id=first&token=good').substring(4);`), 'https://streamtape.com/get_video?id=first&token=good&stream=1');
});

test('InternetChicks selects the largest verified stream and rejects embed pages', async () => {
  const fetch = async (url, options = {}) => {
    if (url === 'https://streamtape.com/e/first') return { ok: true, text: async () => `document.getElementById('robotlink').innerHTML = '//streamtape.com'+ ('xcd/get_video?id=first&token=good').substring(2).substring(1);` };
    if (url === 'https://other.example/e/second') return { ok: true, text: async () => `<source src="https://cdn.example/video.mp4">` };
    if (url.includes('get_video') || url.endsWith('video.mp4')) {
      const bytes = url.endsWith('video.mp4') ? 80 * 1048576 : 40 * 1048576;
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'video/mp4', 'content-length': String(bytes) }), body: null };
    }
    throw new Error(`Unexpected URL ${url} ${options.method}`);
  };
  const bg = worker(fetch);
  const meta = await bg.extractInternetChicksMeta(article, pageUrl);
  assert.equal(meta.streamUrl, 'https://cdn.example/video.mp4');
  assert.equal(meta.sizeMb, 80);
  assert.equal(meta.adapter, 'internetchicks-source-v6');
  assert.equal(meta.selectedPlayer, 2);
  assert.equal(meta.selectedSourceHost, 'other.example');
  assert.equal(meta.verifiedSourceCount, 2);
  assert.equal(meta.totalSourceCount, 2);
  assert.equal(meta.bestOfAllVerified, true);
  assert.equal(meta.sourceResults[0].status, 'verified');
  assert.equal(meta.sourceResults[0].sizeMb, 40);
  assert.equal(meta.sourceResults[1].status, 'verified');
  assert.equal(meta.sourceResults[1].sizeMb, 80);
});

test('VOE real config replaces the 5 MB demo source', () => {
  const bg = worker(async () => { throw new Error('unexpected fetch'); });
  const real = 'https://cdn.example/master.m3u8';
  const inner = Buffer.from(JSON.stringify({ source: real })).toString('base64');
  const shifted = [...inner].reverse().map(c => String.fromCharCode(c.charCodeAt(0) + 3)).join('');
  const encoded = Buffer.from(shifted, 'latin1').toString('base64').replace(/[a-zA-Z]/g,
    c => String.fromCharCode(c.charCodeAt(0) + (c.toLowerCase() < 'n' ? 13 : -13)));
  const html = `<script>var source='https://test-videos.co.uk/vids/bigbuckbunny/mp4/av1/1080/Big_Buck_Bunny_1080_10s_5MB.mp4';</script>
    <script type="application/json">${JSON.stringify([encoded])}</script>`;
  assert.deepEqual(Array.from(bg.internetChicksMediaUrls(html, 'https://voe.sx/e/first')), [real]);
});
