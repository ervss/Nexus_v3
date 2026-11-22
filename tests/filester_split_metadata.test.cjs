const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('userscripts/nexus-universal-splitscreen.user.js', 'utf8');
const start = source.indexOf('  async function fetchSingleCardMeta(item)');
const end = source.indexOf('\n  function probeVideoMetadata(', start);
assert.ok(start > 0 && end > start);
const listeners = new Map();
const document = {
  addEventListener(name, fn) { listeners.set(name, fn); },
  removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
  dispatchEvent(event) {
    assert.equal(event.type, 'nexus-filester-meta');
    const request = JSON.parse(event.detail);
    assert.equal(request.url, 'https://filester.me/d/abc');
    listeners.get('nexus-filester-meta-result')({ detail: JSON.stringify({ id: request.id, meta: {
      duration: 123, width: 1920, height: 1080, sizeBytes: 5000000, thumbnail: 'https://img.test/poster.jpg'
    } }) });
  }
};
const context = vm.createContext({ document, setTimeout, clearTimeout,
  saveItemMetadataToCache() {},
  CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
vm.runInContext(source.slice(start, end) + '\nthis.fetchMeta = fetchSingleCardMeta;', context);
(async () => {
  const item = { type: 'nexus_filester', url: 'https://filester.me/d/abc', title: 'Video' };
  await context.fetchMeta(item);
  assert.equal(item.duration, 123);
  assert.equal(item.quality, '1080p');
  assert.equal(item.resolution, '1920x1080');
  assert.equal(item.size, 5000000);
  assert.equal(item.poster, 'https://img.test/poster.jpg');
  assert.equal(item.hasFullMeta, true);
  assert.equal(listeners.size, 0);
  console.log('Filester metadata bridge updates picker data and cleans up its listener.');
})().catch(error => { console.error(error); process.exitCode = 1; });
