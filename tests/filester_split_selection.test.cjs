const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('userscripts/filester-album-workspace.user.js', 'utf8');
const start = source.indexOf('  async function openInSplitScreen(');
const end = source.indexOf('  async function openPlayer(', start);
assert.ok(start > 0 && end > start);
const events = [], messages = [];
const context = vm.createContext({
  document: { documentElement: { dataset: { nexusSplitReady: '1' } }, dispatchEvent: event => events.push(event), getElementById: () => ({}) },
  getComputedStyle: () => ({ display: 'flex' }),
  CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  metadata: { 'https://filester.me/d/a': { thumbnail: 'https://img.test/a.jpg', duration: 42 } },
  resolvePlayerStream: async item => item.url.endsWith('/bad') ? Promise.reject(new Error('unavailable')) : `https://cdn.test/${item.url.split('/').pop()}.mp4`,
  mapWithLimit: async (items, _limit, fn) => Promise.all(items.map(fn)),
  toast: message => messages.push(message), console: { warn() {} }
});
vm.runInContext(source.slice(start, end) + '\nthis.open = openSelectedInSplitScreen;', context);
(async () => {
  const button = { disabled: false, textContent: 'Split-Screen' };
  const items = [
    { url: 'https://filester.me/d/a', title: 'A', type: 'videos' },
    { url: 'https://filester.me/d/b', title: 'B', type: 'videos', thumb: 'https://img.test/b.jpg' },
    { url: 'https://filester.me/d/bad', title: 'Broken', type: 'videos' }
  ];
  await context.open(items, button);
  assert.equal(events.length, 1);
  const payload = JSON.parse(events[0].detail);
  assert.deepEqual(payload.map(item => item.watchUrl), items.slice(0, 2).map(item => item.url));
  assert.equal(payload[0].poster, 'https://img.test/a.jpg');
  assert.equal(payload[1].poster, 'https://img.test/b.jpg');
  assert.match(messages[0], /2\/3/);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Split-Screen');
  await context.open(Array(13).fill(items[0]), button);
  assert.equal(events.length, 1);
  assert.match(messages.at(-1), /12/);
  console.log('Filester selection, previews, partial failure and 12-video limit passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
