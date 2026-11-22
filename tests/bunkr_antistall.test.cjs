const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('userscripts/nexus-universal-splitscreen.user.js', 'utf8');
const section = source.slice(source.indexOf('  function isBunkrPlayback('), source.indexOf('  async function startCellPlayback('));
function fixture() {
  class Video extends EventTarget {
    constructor() { super(); Object.assign(this, {currentTime: 12, volume: .4, muted: false, playbackRate: 1.5, paused: false, readyState: 2, buffered: {length: 0}, duration: 90}); }
    load() {}
    play() { this.paused = false; return Promise.resolve(); }
  }
  const video = new Video(), cell = {video, item: {url: 'https://bunkr.cr/f/test'}, element: {isConnected: true}, loader: {style: {}}};
  let time = 2000;
  const context = vm.createContext({ URL, URLSearchParams, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, console, activeCells: [cell], CONFIG: {DEFAULT_NEXUS_PORT: 8000}, Date: {now: () => time}, location: {href: 'https://bunkr.cr/a/test'} });
  vm.runInContext(section + ';globalThis.Controller=BunkrPlaybackController;globalThis.Engine=BunkrPrefetchEngine;', context);
  const controller = new context.Controller(cell);
  return { context, controller, cell, video, advance: ms => { time += ms; } };
}
test('watchdog recovers at 1.2s, ignores user pause, seek and end', () => {
  const {controller: c, video: v, advance} = fixture(); let calls = 0;
  c.recover = () => { calls++; };
  advance(1199); c.tick(); assert.equal(calls, 0);
  advance(1); c.tick(); assert.equal(calls, 1);
  c.wantPlay = false; c.tick(); assert.equal(calls, 1);
  c.wantPlay = true; v.seeking = true; c.tick(); assert.equal(calls, 1);
  v.seeking = false; v.ended = true; c.tick(); assert.equal(calls, 1);
  v.ended = false; v.currentTime++; c.tick(); assert.equal(calls, 1);
});
test('one recovery per cell preserves a live MSE buffer', async () => {
  const {controller: c} = fixture(); let finish, resolves = 0, wakes = 0;
  c.fresh = () => { resolves++; return new Promise(r => {finish = r;}); };
  c.engine = {ready: true, wake: () => {wakes++;}};
  c.nativeSwap = () => {throw Error('Must retain buffered bytes');};
  const attempts = [c.recover('503'), c.recover('stall'), c.recover('timeout')];
  assert.equal(resolves, 1); finish(); await Promise.all(attempts); assert.equal(wakes, 1);
});
test('native swap restores position, volume, rate and pause; closed cells ignore metadata', () => {
  const {controller: c, video: v} = fixture(); c.direct = 'https://cdn.example/v.mp4?token=1'; c.wantPlay = false;
  c.nativeSwap(); v.currentTime = 0; v.volume = 1; v.playbackRate = 1;
  v.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(v.currentTime, 12); assert.equal(v.volume, .4); assert.equal(v.playbackRate, 1.5); assert.equal(v.muted, false);
  assert.ok(v.src.includes('/api/v1/video_proxy?')); assert.ok(v.src.includes('referer='));
  c.nativeSwap(); c.destroy(); v.currentTime = 0; v.dispatchEvent(new Event('loadedmetadata')); assert.equal(v.currentTime, 0);
});
test('prefetch limits connections to 2 to avoid 503, feeds ordered bytes, isolates failed cell', async () => {
  const {controller: c, context} = fixture();
  const engine = new context.Engine(c); engine.total = 12 * 1024 * 1024; engine.duration = 90; engine.ready = true;
  let active = 0, max = 0, refreshes = 0; const offsets = [];
  c.range = async (start, end) => { active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 2)); active--; return {data: new ArrayBuffer(end-start+1), total: engine.total}; };
  engine.file = {appendBuffer: data => offsets.push(data.fileStart)};
  await engine.pump(); assert.equal(max, 2); assert.deepEqual(offsets, Array.from({length:2}, (_,i) => i*engine.chunkSize));
  c.range = async () => {throw Error('503');}; c.recover = async () => {refreshes++;};
  const saved = engine.offset; await engine.pump(); assert.equal(refreshes, 1); assert.equal(engine.offset, saved);
});
test('range rejects ignored Range and cancellation releases all inflight requests', async () => {
  const {controller: c, context} = fixture(); c.direct = 'https://cdn.example/v.mp4';
  context.fetch = async () => ({status: 200, body: {cancel: async () => {}}});
  await assert.rejects(c.range(0, 7), /HTTP 200/); assert.equal(c.requests.size, 0);
  context.fetch = async (_, {signal}) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('aborted'))));
  const request = c.range(0,7); c.abortRanges(); await assert.rejects(request, /aborted/); assert.equal(c.requests.size, 0);
});
test('forced resolve bypasses both caches, coalesces concurrent refresh and uses 2s deadline', async () => {
  const resolver = source.slice(source.indexOf('  const bunkrPending = new Map()'), source.indexOf('  async function resolveThroughSelector('));
  let calls = 0;
  const context = vm.createContext({ URL, Map, Promise, Date, Math, atob, AbortSignal, location: {href: 'https://bunkr.cr/a/test'}, document: {documentElement: {dataset: {}}, createElement: () => ({})}, gmFetch: async (_, options) => {
    calls++; if (calls > 1) { assert.equal(options.timeoutMs, 2000); assert.ok(options.signal); }
    await new Promise(r => setTimeout(r, 2)); return {ok:true, json:async()=>({url:`https://cdn.example/test.mp4?token=${calls}`})};
  }});
  vm.runInContext(resolver + ';globalThis.resolve=resolveBunkrDirect;', context);
  const old = await context.resolve('https://bunkr.cr/f/test');
  assert.equal(await context.resolve('https://bunkr.cr/v/test'), old); assert.equal(calls, 1);
  context.document.documentElement.dataset.nexusBunkrResolver = 'ready';
  const urls = await Promise.all([context.resolve('https://bunkr.cr/f/test',{force:true}),context.resolve('https://bunkr.cr/v/test',{force:true})]);
  assert.equal(calls, 2); assert.equal(urls[0], urls[1]); assert.notEqual(urls[0], old);
});
test('resolveBunkrDirect falls back to jsCDN + signUrl when /api/vs returns 404 on /f/ pages', async () => {
  const resolver = source.slice(source.indexOf('  const bunkrPending = new Map()'), source.indexOf('  async function resolveThroughSelector('));
  const seen = [];
  const context = vm.createContext({
    URL, Set, Array, Map, Promise, Date, Math, atob, decodeURIComponent, encodeURIComponent, AbortSignal,
    location: {href: 'https://bunkr.cr/a/cCNkPfSv'},
    document: {documentElement: {dataset: {}}, createElement: () => ({}), head: {querySelector: () => null, append: () => {}}},
    gmFetch: async (url) => {
      seen.push(url);
      if (url.endsWith('/api/vs')) return {ok: false, status: 404};
      if (url.includes('/f/9vmYyQSJpCwef')) {
        return {
          ok: true,
          text: async () => '<script>var jsCDN = "https:\\/\\/c2ck-b.cdn.cr\\/storage\\/media\\/eaa993cf-de86-4260-be25-414b4337c721.mp4"; var signUrl = "https://glb-apisign.cdn.cr/sign";</script>'
        };
      }
      if (url.startsWith('https://glb-apisign.cdn.cr/sign?path=')) {
        return {
          ok: true,
          json: async () => ({token: 'abc123token', ex: 1793973475})
        };
      }
      return {ok: false, status: 404};
    }
  });
  vm.runInContext(resolver + ';globalThis.resolve=resolveBunkrDirect;', context);
  const direct = await context.resolve('https://bunkr.cr/f/9vmYyQSJpCwef');
  assert.equal(direct, 'https://c2ck-b.cdn.cr/storage/media/eaa993cf-de86-4260-be25-414b4337c721.mp4?token=abc123token&ex=1793973475');
  assert.ok(seen.some(u => u.startsWith('https://glb-apisign.cdn.cr/sign?path=%2Fstorage%2Fmedia%2Feaa993cf-de86-4260-be25-414b4337c721.mp4')));
});
test('HTTPS Bunkr pages stream signed HTTPS CDN directly and gmFetch tolerates HTTP/2 pseudo-headers', () => {
  const {context, controller: c, video: v} = fixture();
  context.location.protocol = 'https:';
  c.direct = 'https://c6no3-b.cdn.cr/storage/media/test.mp4?token=signed123&ex=1900000000';
  c.nativeSwap();
  assert.equal(v.src, c.direct);
  const helperSection = source.slice(source.indexOf('  function parseSafeHeaders('), source.indexOf('  function formatBytes('));
  const hCtx = vm.createContext({ Headers, String });
  vm.runInContext(helperSection + ';globalThis.parseSafeHeaders=parseSafeHeaders;', hCtx);
  const parsed = hCtx.parseSafeHeaders(':status: 404\r\ncontent-type: application/json\r\ninvalid header line');
  assert.equal(parsed.get('content-type'), 'application/json');
});
