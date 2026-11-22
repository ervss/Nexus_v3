const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('userscripts/nexus-universal-splitscreen.user.js', 'utf8');
const start = source.indexOf('  async function fetchSingleCardMeta(item)');
const end = source.indexOf('\n  function probeVideoMetadata(', start);
assert.ok(start > 0 && end > start);
const calls = [];
const context = vm.createContext({
  CONFIG: { DEFAULT_NEXUS_PORT: 8000 },
  saveItemMetadataToCache() {},
  gmFetch: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ results: [{ url: 'https://bunkr.cr/v/abc', duration: 277,
      size_bytes: 302362713, width: 1080, height: 1920, quality: '1080p' }] }) };
  }
});
vm.runInContext(source.slice(start, end) + '\nthis.fetchMeta = fetchSingleCardMeta;', context);
(async () => {
  const item = { type: 'bunkr_turbo', url: 'https://bunkr.cr/v/abc', size: 683 };
  await context.fetchMeta(item);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/tester\/batch-meta$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { urls: ['https://bunkr.cr/v/abc'], metadata_only: true });
  assert.equal(item.duration, 277);
  assert.equal(item.size, 302362713);
  assert.equal(item.quality, '1080p');
  assert.equal(item.resolution, '1080x1920');
  assert.equal(item.hasFullMeta, true);
  console.log('Bunkr metadata uses the video resolver, replaces HTML size and preserves portrait quality.');
})().catch(error => { console.error(error); process.exitCode = 1; });
