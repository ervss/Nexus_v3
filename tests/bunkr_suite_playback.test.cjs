const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../userscripts/bunkr-suite.user.js'), 'utf8');
const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const playback = slice('    let playerModal = null;', '    // port detect');
function harness(resolve = async () => 'https://cdn.example/clip.mp4') {
  const timers = [];
  const context = vm.createContext({ console, URL, Date, Symbol, AbortController,
    getVideoSrc: resolve, injectCdnPreconnect() {}, videoSrcCache: {},
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    setInterval() {}, clearInterval() {}, document: { hidden: false },
  });
  vm.runInContext(playback + '\n globalThis.api = { loadSplitCellStream, BunkrTurboStreamer };', context);
  const video = { style: {}, muted: false, currentTime: 0, listeners: {},
    plays: 0, loads: 0, src: '', onerror: null,
    play() { this.plays++; return Promise.resolve(); }, pause() {},
    load() { this.loads++; }, removeAttribute() { this.src = ''; },
    addEventListener(type, fn) { this.listeners[type] = fn; }, closest() { return cell; },
  };
  const iframe = { style: {}, src: '' }, loader = { style: {} };
  const nodes = { '.bah-split-video': video, '.bah-split-iframe': iframe, '.bah-split-loader': loader };
  const cell = { isConnected: true, querySelector: selector => nodes[selector] || null };
  return { ...context.api, video, iframe, loader, cell, timers, context };
}
test('starts native play immediately, installs recovery first, leaves speed alone', async () => {
  const h = harness();
  h.video.playbackRate = 1.25;
  h.video.play = function () { assert.equal(typeof this.onerror, 'function'); this.plays++; return Promise.resolve(); };
  await h.loadSplitCellStream(h.cell, 'https://bunkr.cr/f/demo', 9);
  assert.equal(h.video.plays, 1);
  assert.equal(h.video.src, 'https://cdn.example/clip.mp4');
  assert.equal(h.video.playbackRate, 1.25);
  assert.equal(h.timers.length, 0, 'no index stagger or metadata wait');
});
test('a buffering play promise does not block the next resolver worker', async () => {
  const h = harness();
  h.video.play = () => new Promise(() => {});
  await h.loadSplitCellStream(h.cell, 'https://bunkr.cr/f/demo', 0);
  assert.ok(h.cell._bahTurbo);
});
test('closed cell cannot start after a delayed resolution', async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  const pending = h.loadSplitCellStream(h.cell, 'https://bunkr.cr/f/demo', 0);
  h.cell.isConnected = false;
  finish('https://cdn.example/late.mp4');
  await pending;
  assert.equal(h.video.plays, 0);
  assert.equal(h.video.src, '');
});
test('media failure releases direct source and hands off once, without a blob download', async () => {
  const h = harness();
  await h.loadSplitCellStream(h.cell, 'https://bunkr.cr/f/demo', 0);
  const fail = h.video.onerror;
  fail(); fail();
  assert.equal(h.video.onerror, null);
  assert.equal(h.video.src, '');
  assert.equal(h.video.loads, 1);
  assert.equal(h.iframe.src, 'https://bunkr.cr/v/demo');
  assert.equal(h.cell._bahTurbo, null);
});
test('AbortError does not trigger muted retries', async () => {
  const h = harness();
  h.video.play = function () { this.plays++; return Promise.reject(Object.assign(new Error(), { name: 'AbortError' })); };
  await h.loadSplitCellStream(h.cell, 'https://bunkr.cr/f/demo', 0);
  await Promise.resolve();
  assert.equal(h.video.plays, 1);
  assert.equal(h.video.muted, false);
});
test('autoplay denial retries muted exactly once', async () => {
  const h = harness();
  h.video.play = function () { this.plays++; return this.plays === 1 ? Promise.reject(Object.assign(new Error(), { name: 'NotAllowedError' })) : Promise.resolve(); };
  await h.loadSplitCellStream(h.cell, 'https://bunkr.cr/f/demo', 0);
  await Promise.resolve();
  assert.equal(h.video.plays, 2);
  assert.equal(h.video.muted, true);
});
test('destroy during token renewal cannot schedule another renewal', async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  const streamer = new h.BunkrTurboStreamer(h.video, `https://cdn.example/clip.mp4?ex=${Math.floor(Date.now()/1000)+300}`, 'page');
  streamer.start();
  const pending = h.timers[0].fn();
  streamer.destroy();
  finish('https://cdn.example/renewed.mp4');
  await pending;
  assert.equal(h.timers.length, 1);
});
function resolverHarness(bridgeFetch) {
  const context = vm.createContext({ console, URL, Date, atob, location: new URL('https://bunkr.cr/a/test'), document: { documentElement: { dataset: {} }, addEventListener() {} }, bridgeFetch });
  vm.runInContext(slice('    const videoSrcCache = {};', '    let playerModal = null;') + '\n globalThis.api = { getVideoSrc };', context);
  return context.api;
}
test('album resolver uses its own /api/vs, decodes the URL and reuses valid cache', async () => {
  const calls = [];
  const timestamp = 1770000000;
  const url = 'https://media-files.example/clip.mp4?token=test&ex=9999999999';
  const key = `SECRET_KEY_${Math.floor(timestamp / 3600)}`;
  const encoded = Buffer.from([...url].map((ch, i) => ch.charCodeAt(0) ^ key.charCodeAt(i % key.length))).toString('base64');
  const h = resolverHarness(async (endpoint, options) => {
    calls.push({ endpoint, options });
    return { ok: true, json: async () => ({ url: encoded, encrypted: true, timestamp }) };
  });
  assert.equal(await h.getVideoSrc('https://bunkr.cr/f/demo.mp4'), url);
  assert.equal(await h.getVideoSrc('https://bunkr.cr/f/demo.mp4'), url);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, 'https://bunkr.cr/api/vs');
  assert.equal(JSON.parse(calls[0].options.body).slug, 'demo');
});
test('expired signed URLs are resolved again instead of replaying stale tokens', async () => {
  let count = 0;
  const h = resolverHarness(async () => ({ ok: true, json: async () => ({ url: `https://cdn.example/clip.mp4?ex=1&attempt=${++count}` }) }));
  await h.getVideoSrc('https://bunkr.cr/f/demo');
  const next = await h.getVideoSrc('https://bunkr.cr/f/demo');
  assert.equal(count, 2);
  assert.match(next, /attempt=2/);
});
test('archive autoplay promise cannot mute a newer request after close', async () => {
  let reject;
  const context = vm.createContext({});
  vm.runInContext(slice('    async function startVideoPlayback', '    // Helper function to parse Bunkr date') + '\n globalThis.play = startVideoPlayback;', context);
  let current = true;
  const video = { muted: false, play: () => new Promise((_, fail) => { reject = fail; }) };
  const pending = context.play(video, () => current);
  current = false;
  reject(Object.assign(new Error(), { name: 'NotAllowedError' }));
  await pending;
  assert.equal(video.muted, false);
});
test('replacing an archive compare slot suppresses the older resolver result', async () => {
  const pending = [];
  const context = vm.createContext({ resolveBunkrStreamUrl: () => new Promise(resolve => pending.push(resolve)) });
  const method = slice('      async setCompareSlot(', '      closeFloatingPlayers()');
  vm.runInContext('globalThis.api = {' + method + '};', context);
  const video = { src: '', removeAttribute() {}, load() {}, play: async () => {} };
  const card = { style: {} }, label = {};
  Object.assign(context.api, { compareSlots: {}, ensureFloatingPlayers() {}, qs: selector => selector === 'video' ? video : selector === '.bae-float-title' ? label : card });
  const older = context.api.setCompareSlot('A', 'old', 'Old');
  const newer = context.api.setCompareSlot('A', 'new', 'New');
  pending[1]('new.mp4'); await newer;
  pending[0]('old.mp4'); await older;
  assert.equal(video.src, 'new.mp4');
  assert.equal(label.textContent, 'A: New');
});
