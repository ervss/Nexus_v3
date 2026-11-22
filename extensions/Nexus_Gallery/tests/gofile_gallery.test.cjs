const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');

test('GoFile gallery sends a website token and displays API videos', async () => {
  const source = fs.readFileSync(require('node:path').join(__dirname, '../popup.js'), 'utf8');
  const start = source.indexOf('async function handleGofileScraping(');
  const end = source.indexOf('\nasync function handleEpornerScraping(', start);
  assert.ok(start >= 0 && end > start);
  let request;
  let error;
  const folder = {};
  const context = {
    console, crypto: webcrypto, TextEncoder, Uint8Array, URLSearchParams, AbortSignal,
    navigator: { userAgent: 'test-browser', language: 'sk-SK' },
    Date: class extends Date { static now() { return 144000000; } },
    getGofileToken: async () => 'account-token',
    fetch: async (url, options) => {
      request = { url: new URL(url), options };
      return { ok: true, status: 200, json: async () => ({ status: 'ok', data: {
        name: 'Folder', children: { one: { id: '1', type: 'file', name: 'clip.mp4', link: 'https://example.com/clip.mp4' } }
      } }) };
    },
    document: { getElementById: () => folder },
    allVideos: [], currentlyFilteredVideos: [], applyFilters() {}, updateStats() {},
    formatTime: String, showError: message => { error = message; }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  await context.handleGofileScraping({ id: 1, url: 'https://gofile.io/d/jRrKyN' });
  const expected = createHash('sha256').update('test-browser::sk-SK::account-token::10::12af056dacea0b').digest('hex');
  assert.equal(error, undefined);
  assert.equal(request.url.searchParams.get('wt'), expected);
  assert.equal(request.options.headers['X-Website-Token'], expected);
  assert.equal(request.options.headers.Authorization, 'Bearer account-token');
  assert.equal(context.allVideos.length, 1);
  assert.equal(folder.innerText, 'Folder');
});
