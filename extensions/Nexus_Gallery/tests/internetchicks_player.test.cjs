const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const background = fs.readFileSync('extensions/Nexus_Gallery/background.js', 'utf8');
const start = background.indexOf('async function resolveInternetChicksPlayer(');
const end = background.indexOf('chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {', start);
assert.ok(start >= 0 && end > start);
const resolver = background.slice(start, end);

test('selected InternetChicks Streamtape player resolves a verified video, not its decoy link', async () => {
  const requested = [];
  const context = {
    URL, AbortSignal,
    fetch: async (url, options = {}) => {
      requested.push({ url, method: options.method || 'GET' });
      if (options.method === 'HEAD') {
        return { ok: true, headers: new Headers({ 'content-type': 'video/mp4', 'content-length': '94371840' }) };
      }
      return { ok: true, text: async () => `
        <div id="botlink">//streamtape.com/get_video?id=chosen&token=decoy</div>
        <script>document.getElementById('botlink').innerHTML = '//strea'+ ('xyzamtape.com/get_video?id=chosen&token=good').substring(4);</script>` };
    },
  };
  vm.createContext(context);
  vm.runInContext(resolver, context);
  const result = await context.resolveInternetChicksPlayer('https://streamtape.com/e/chosen');
  assert.equal(result.streamUrl, 'https://streamtape.com/get_video?id=chosen&token=good');
  assert.equal(result.sizeBytes, 94371840);
  assert.deepEqual(requested.map(item => item.method), ['GET', 'HEAD']);
  assert.equal(await context.resolveInternetChicksPlayer('https://untrusted.example/e/chosen'), null);
});
