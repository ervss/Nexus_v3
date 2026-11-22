const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = { window: {}, URL, location: new URL('https://www.whoreshub.com/playlists/31597/sample/') };
vm.runInNewContext(fs.readFileSync('extensions/nexus-video-selector/whoreshub-player.js', 'utf8'), context);
const api = context.window.NVSWhoreshubPlayer;
const url = id => `https://www.whoreshub.com/videos/${id}/sample/`;

test('HLS quality uses runtime level identity instead of original manifest index', () => {
  const levels = [
    { height: 480, bitrate: 400000, url: ['https://cdn.test/480.m3u8'] },
    { height: 720, bitrate: 1500000, url: ['https://cdn.test/720.m3u8'] },
    { height: 1080, bitrate: 5000000, url: ['https://cdn.test/1080.m3u8'] },
  ];
  // The master advertised 1080p first, while HLS.js sorted 480p first.
  assert.equal(api.selectHlsLevel(levels, { height: 1080, level: 0, variantUrl: 'https://cdn.test/1080.m3u8' }), 2);
  assert.equal(api.selectHlsLevel(levels, { height: 480, level: 2, variantUrl: 'https://cdn.test/480.m3u8' }), 0);
  assert.equal(api.selectHlsLevel(levels, {}), 2);
  assert.equal(api.selectHlsLevel(levels.slice(0,2), { height: 1080, level: 0 }), 1);
  assert.equal(api.selectHlsLevel([], { height: 1080 }), -1);
  const sameHeight = [{ height: 1080, bitrate: 2000000 }, { height: 1080, bitrate: 5000000 }];
  assert.equal(api.selectHlsLevel(sameHeight, { height: 1080, bandwidth: 4900000 }), 1);
});

test('native HLS player waits for parsed levels, then locks 1080p before loading fragments', () => {
  const events = {}, calls = [], controls = new Map();
  const node = () => ({ textContent: '', append() {}, replaceChildren() {}, addEventListener() {}, removeEventListener() {}, setAttribute() {} });
  const video = { ...node(), dataset: {}, currentTime: 0, paused: true };
  let instance;
  class Hls {
    static Events = { MANIFEST_PARSED: 'parsed', ERROR: 'error' };
    static isSupported() { return true; }
    constructor(config) { instance = this; this.config = config; this.levels = [{ height: 480, bitrate: 400000 }, { height: 1080, bitrate: 5000000 }]; }
    on(event, callback) { events[event] = callback; }
    loadSource() { calls.push('manifest'); }
    attachMedia() { calls.push('attach'); }
    startLoad() { calls.push(['fragments', this.startLevel, this.currentLevel, this.loadLevel]); }
    destroy() {}
  }
  const ctx = { window: { Hls }, generation: 1, media: null, selectHlsLevel: api.selectHlsLevel, startHlsAtQuality: api.startHlsAtQuality,
    dialog: { querySelector(selector) { if (!controls.has(selector)) controls.set(selector, { ...node(), append() {} }); return controls.get(selector); } },
    document: { createElement(tag) { return tag === 'video' ? video : node(); } }, updatePlayback() {}, playlist: {}, formatSize: api.formatSize };
  const source = fs.readFileSync('extensions/nexus-video-selector/whoreshub-player.js', 'utf8');
  vm.runInNewContext(source.slice(source.indexOf('    function nativePlayer('), source.indexOf('    function render(')), ctx);
  ctx.nativePlayer({ title: 'Example' }, [{ type: 'hls', url: 'https://cdn.test/master.m3u8', height: 1080, quality: '1080P · HLS', level: 0 }], 1);
  assert.equal(instance.config.autoStartLoad, false);
  assert.deepEqual(calls, ['manifest', 'attach']);
  events.parsed();
  assert.deepEqual(calls[2], ['fragments', 1, 1, 1]);
  ctx.generation = 2; events.parsed(); assert.equal(calls.length, 3);
});

test('revealing a profile tab by changing its container CSS repaints card playback buttons', () => {
  let observer, collected=0; const frames=[];
  const ctx={window:{},URL,location:new URL('https://www.xvideos.com/profile#_tabVideos'),
    document:{createElement:()=>({addEventListener(){}})},requestAnimationFrame:callback=>frames.push(callback),
    MutationObserver:class {constructor(callback){observer=callback;}observe(){}disconnect(){}}};
  vm.runInNewContext(fs.readFileSync('extensions/nexus-video-selector/whoreshub-player.js','utf8'),ctx);
  const grid={},panel={querySelector:()=>null,append(){}};
  ctx.window.NVSListingPlayer.attach(grid,panel,{cardSelector:'.thumb-block',collect(){collected++;return [];}});
  frames.shift()(); assert.equal(collected,1);
  const tab={matches:()=>false,querySelector:()=>({}),classList:{contains:()=>false}};
  observer([{type:'attributes',target:tab,attributeName:'style',oldValue:'display:none'}]);
  assert.equal(frames.length,1);frames.shift()();assert.equal(collected,2);
});

test('embed accepts only videos on the current Whoreshub origin', () => {
  assert.equal(api.embedUrl(url(123)), 'https://www.whoreshub.com/embed/123');
  assert.equal(api.embedUrl('/videos/123/sample/?from=playlist'), 'https://www.whoreshub.com/embed/123');
  for (const value of ['https://other.test/videos/123/sample/', 'javascript:alert(1)', '/playlists/123/sample/', 'https://whoreshub.com/videos/123/sample/']) assert.equal(api.embedUrl(value), '');
});

test('renditions come only from the selected player, highest quality first', () => {
  const html = `<script>var flashvars = {
    video_id: '123', video_url: 'https://www.whoreshub.com/get_file/5/hash/123/123.mp4/?token=fresh', video_url_text: '480p',
    video_alt_url: 'https://www.whoreshub.com/get_file/5/hash/123/123_720p.mp4/?token=fresh', video_alt_url_text: '720p HD',
    video_alt_url2: 'https://www.whoreshub.com/videos/123/sample/', video_alt_url2_text: '1080p FHD', video_alt_url2_redirect: '1',
    video_alt_url3: 'https://www.whoreshub.com/get_file/5/hash/123/preview.mp4/', video_alt_url3_text: '2160p',
    video_alt_url4: 'javascript:alert(1)', video_alt_url4_text: '2160p',
  };</script><script>var other = {video_url:'https://cdn.example/recommendation_2160p.mp4'};</script>`;
  const sources = api.sourcesFromHtml(html, url(123));
  assert.deepEqual(Array.from(sources, s => s.quality), ['720P', '480P']);
  assert.match(sources[0].url, /123_720p\.mp4/);
  assert.match(sources[0].url, /token=fresh/);
  assert.equal(api.sourcesFromHtml(html, url(124)).length, 0);
  assert.equal(api.sourcesFromHtml('<script>var unrelated={video_url:"https://cdn.example/ad.mp4"};</script>', url(123)).length, 0);
});

test('scrambled KVS rendition is decoded identically to the existing metadata adapter', () => {
  const ctx = { URL, chrome: { runtime: { onMessage: { addListener() {} } } } };
  vm.runInNewContext(fs.readFileSync('extensions/nexus-video-selector/background.js', 'utf8'), ctx);
  const raw = 'function/0/https://www.whoreshub.com/get_file/5/0123456789abcdef0123456789abcdef/123/123_720p.mp4/?token=fresh';
  const license = '$571598518858033';
  const expected = ctx.kvsGetRealUrl(raw, license);
  const html = `<script>var flashvars={video_id:'123',license_code:'${license}',video_url:'${raw}',video_url_text:'720p'};</script>`;
  const [source] = api.sourcesFromHtml(html, url(123));
  assert.equal(source.url, expected);
  assert.notEqual(source.url, raw.slice('function/0/'.length));
  assert.equal(api.sourcesFromHtml(html.replace(license, ''), url(123)).length, 0);
});

test('next and previous preserve boundaries and use current sort order', () => {
  let entries = [1, 2, 3].map(id => ({ url: url(id), title: `Video ${id}` }));
  const played = [];
  const player = api.createPlaylist(() => entries, entry => played.push(entry.url));
  assert.equal(player.open(url(1)), true);
  assert.equal(player.move(-1), false);
  assert.equal(player.move(1), true);
  assert.equal(player.refresh().index, 1);
  entries = [entries[2], entries[1], entries[0]];
  assert.equal(player.move(1), true);
  assert.equal(played.at(-1), url(1));
  assert.equal(player.move(1), false);
  assert.equal(player.move(-1), true);
  assert.equal(played.at(-1), url(2));
});

test('new batches extend the open playlist without restarting current video', () => {
  const entries = [{ url: url(1) }];
  const played = [];
  const player = api.createPlaylist(() => entries, entry => played.push(entry.url));
  player.open(url(1));
  assert.equal(player.move(1), false);
  entries.push({ url: url(2) });
  assert.equal(player.refresh().entries.length, 2);
  assert.equal(played.length, 1);
  assert.equal(player.move(1), true);
  assert.equal(played.at(-1), url(2));
});

test('filtering out the current video still permits navigation to remaining entries', () => {
  let entries = [{ url: url(1) }, { url: url(2) }, { url: url(3) }];
  const player = api.createPlaylist(() => entries, () => {});
  player.open(url(2)); entries = [entries[0], entries[2]];
  assert.equal(player.refresh().index, -1);
  assert.equal(player.move(1), true);
  assert.equal(player.refresh().current.url, url(1));
  entries = [];
  assert.equal(player.move(1), false);
  assert.equal(player.open(url(10)), false);
});

test('collection excludes filtered cards, playlist thumbnails, cross-origin links and duplicates', () => {
  function card(id, { hidden = false, filtered = false, href = url(id) } = {}) {
    return {
      hidden, classList: { contains: name => name === 'nvs-hidden' && filtered },
      querySelector(selector) {
        if (selector === 'a[href*="/videos/"]') return { getAttribute: name => name === 'href' ? href : null };
        if (selector === 'img[alt]') return { alt: `Video ${id}` };
        return null;
      },
    };
  }
  const entries = api.collect({ querySelectorAll: () => [card(3), card(1), card(2, { filtered: true }), card(4, { hidden: true }), card(3), card(5, { href: 'https://example.test/videos/5/test/' }), card(6, { href: '/playlists/6/test/' }), card(7, { href: 'http://[invalid]' })] });
  assert.deepEqual(Array.from(entries, e => e.url), [url(3), url(1)]);
  assert.equal(entries[0].title, 'Video 3');
});

test('time labels show real playback progress including long videos', () => {
  assert.equal(api.formatTime(0), '0:00');
  assert.equal(api.formatTime(61.9), '1:01');
  assert.equal(api.formatTime(3665), '1:01:05');
  assert.equal(api.formatTime(NaN), '0:00');
});

test('file size labels use the selected rendition and handle unavailable headers', () => {
  assert.equal(api.formatSize(1024 ** 3), '1.00 GiB');
  assert.equal(api.formatSize(524288000), '500.0 MiB');
  for (const value of [null, undefined, 0, -1, NaN]) assert.equal(api.formatSize(value), 'Nedostupná');
});
test('media size probe returns exact bytes, preserves old MiB callers and rejects error pages', async () => {
  const ctx = { URL, AbortController, setTimeout, clearTimeout, chrome: { runtime: { onMessage: { addListener() {} } } } };
  vm.runInNewContext(fs.readFileSync('extensions/nexus-video-selector/background.js', 'utf8'), ctx);
  ctx.fetch = async () => ({ok:true,status:200,headers:new Map([['content-length','123456789'],['content-type','video/mp4']])});
  assert.equal(await ctx.fetchHeadSize('https://media.test/file.mp4','',true),123456789);
  assert.equal(await ctx.fetchHeadSize('https://media.test/file.mp4'),118);
  ctx.fetch = async () => ({ok:false,status:404,headers:new Map([['content-length','999'],['content-type','text/html']])});
  assert.equal(await ctx.fetchHeadSize('https://media.test/file.mp4','',true),null);
  ctx.fetch = async (url, init) => init.method === 'HEAD' ? {ok:true,status:200,headers:new Map()} : {ok:true,status:206,headers:new Map([['content-range','bytes 0-0/987654321'],['content-type','video/mp4']])};
  assert.equal(await ctx.fetchHeadSize('https://media.test/file.mp4','',true),987654321);
});
