import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('extensions/nexus-video-selector/background.js', 'utf8');
const pageUrl = 'https://www.camwhores.tv/videos/17472590/test/';
const streamUrl = 'https://www.camwhores.tv/get_file/141/hash/17472000/17472590/17472590.mp4/?token=test';
const html = `<script>var flashvars = {
  video_url: '${streamUrl}', video_url_fhd: '1',
  preview_url1: 'https://cdn.camwhores.tv/17472590/preview.mp4.jpg'
};</script>
<div id="tab_video_info" class="tab-content"><span>Duration: <em>3:16</em></span><span>Submitted: <em>1 month ago</em></span></div>
<div id="tab_screenshots"></div>
<a href="https://cdn.camwhores.tv/recommendation/other.mp4">Size: 2 GB <span class="duration">59:59</span></a>`;
const cache = {};
const requests = [];
let failHead = false;
const ctx = vm.createContext({
  URL, AbortController, setTimeout, clearTimeout, console,
  chrome: {
    runtime: { onMessage: { addListener() {} } },
    storage: { local: {
      async get(keys) {
        const requested = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(requested.filter(key => key in cache).map(key => [key, cache[key]]));
      },
      async set(values) { Object.assign(cache, values); },
      remove(key) { delete cache[key]; },
    } },
  },
  async fetch(url, options = {}) {
    requests.push({ url, method: options.method || 'GET' });
    if (url === pageUrl) return new Response(html);
    assert.equal(url, streamUrl, 'probe only the selected player, never preview JPGs or recommendations');
    if (options.method === 'HEAD' && failHead) return new Response('error', { status: 403, headers: { 'content-type': 'text/html' } });
    return new Response(null, { status: options.method === 'HEAD' ? 200 : 206, headers: {
      'content-type': 'video/mp4',
      'content-length': options.method === 'HEAD' ? String(89 * 1024 * 1024) : '1',
      ...(options.method === 'HEAD' ? {} : { 'content-range': `bytes 0-0/${89 * 1024 * 1024}` }),
    } });
  },
});
vm.runInContext(source, ctx);
const run = (expression) => vm.runInContext(expression, ctx);
ctx.pageUrl = pageUrl;
ctx.fixtureHtml = html;

const first = await run('fetchVideoMeta(pageUrl, 1)');
assert.equal(first.sizeMb, 89);
assert.equal(first.quality, '1080P');
assert.equal(first.duration, '3:16');
assert.equal(first.relDate, '1 month ago');
assert.equal(requests.length, 2, 'one HTML and one HEAD is the entire cold-fetch path');
await run('fetchVideoMeta(pageUrl, 1)');
assert.equal(requests.length, 2, 'warm page reload must issue zero network requests');
await run('fetchVideoMeta(pageUrl, 1, true)');
assert.equal(requests.length, 4, 'explicit refresh must bypass cache');

failHead = true;
const fallback = await run('fetchVideoMeta(pageUrl, 1, true)');
assert.equal(fallback.sizeMb, 89, 'range total must remain exact when HEAD is unsupported');
assert.equal(requests.at(-1).method, 'GET');

ctx.fixtureHtml = html.replace(/<script>[\s\S]*?<\/script>/, '');
const beforePrivate = requests.length;
const privateMeta = await run('extractCamwhoresMeta(fixtureHtml, pageUrl)');
assert.equal(privateMeta.sizeMb, null);
assert.equal(privateMeta.duration, '3:16');
assert.equal(requests.length, beforePrivate, 'private/unavailable player must not trigger irrelevant media probes');

cache[`nvs_meta_v6:${pageUrl}`] = { sizeMb: 9999, ts: Date.now() };
const migrated = await run('fetchVideoMeta(pageUrl, 1)');
assert.equal(migrated.sizeMb, 89, 'legacy page-wide scraper cache must not mask correct selected-video sizes');
console.log('nvs camwhores fast-fetch tests passed');

// Optional live check uses the exact production adapter and an actual public detail.
if (process.argv.includes('--live')) {
  const liveRequests = [];
  const liveCtx = vm.createContext({
    URL, AbortController, setTimeout, clearTimeout, console,
    chrome: ctx.chrome,
    async fetch(url, options) {
      const start = performance.now();
      const response = await fetch(url, options);
      liveRequests.push({ method: options?.method || 'GET', status: response.status, ms: Math.round(performance.now() - start) });
      return response;
    },
  });
  vm.runInContext(source, liveCtx);
  const start = performance.now();
  const meta = await vm.runInContext("fetchVideoMeta('https://www.camwhores.tv/videos/17472590/valentinamyriad-stunning-128150-beauty-sucks-rides-127904/', 1, true)", liveCtx);
  assert.equal(meta?.sizeMb, 89, 'live source matches the previously verified card size');
  console.log(JSON.stringify({ live: { ms: Math.round(performance.now() - start), meta, requests: liveRequests } }));
}
