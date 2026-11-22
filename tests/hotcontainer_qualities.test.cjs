const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('extensions/hotcontainer-profile-handoff/qualities.js', 'utf8');
const base = 'https://hls-cdn77.xvideos-cdn.com/signature==,123/video/6/master.m3u8';
const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2"
hls-480p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080,NAME="Full HD"
hls-1080p.m3u8?token=abc
#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=3840x2160
hls-4k.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=10000,URI="iframe.m3u8"
`;
function api(fetch) {
  const context = vm.createContext({ URL, AbortSignal, fetch });
  vm.runInContext(source, context);
  return context.HotContainerQualities;
}

test('HLS variants are sorted by resolution and retain signed relative paths and queries', () => {
  const variants = api().parse(master, base);
  assert.deepEqual(Array.from(variants, v => v.label), ['2160p (4K)', '1080p', '480p']);
  assert.equal(variants[1].url, new URL('hls-1080p.m3u8?token=abc', base).href);
  assert.equal(variants[2].bandwidth, 800000);
});

test('invalid, off-domain and separately supplied audio do not become downloadable video choices', () => {
  const parser = api();
  assert.throws(() => parser.parse('<html>expired</html>', base), /HLS/);
  assert.throws(() => parser.parse('#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080\nhttps://evil.example/a.m3u8', base), /nenašli/);
  assert.throws(() => parser.parse('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio.m3u8"\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080,AUDIO="a"\nvideo.m3u8', base), /nenašli/);
  assert.equal(parser.isAllowedUrl('https://xvideos-cdn.com.evil.example/a'), false);
  assert.equal(parser.isAllowedUrl('http://hls-cdn77.xvideos-cdn.com/a'), false);
  assert.equal(parser.parse('#EXTM3U\n#EXTINF:3,\nsegment.ts', base)[0].label, 'HLS – jedna kvalita');
});

test('fetch rejects expired links and resolves relative variants after CDN redirects', async () => {
  await assert.rejects(api(async () => ({ok:false,status:403})).load(base), /vypršal/);
  const final = base.replace('/6/', '/7/');
  const variants = await api(async () => ({ok:true,url:final,text:async()=>master})).load(base);
  assert.equal(variants[0].url, new URL('hls-4k.m3u8', final).href);
});

test('background responds asynchronously and fetches only for supported sender pages', async () => {
  let handler;
  let fetched = 0;
  const context = vm.createContext({ URL, AbortSignal,
    fetch: async () => { fetched++; return {ok:true,url:base,text:async()=>master}; },
    chrome:{ runtime:{onMessage:{addListener(fn){handler=fn;}}} },
  });
  context.importScripts = () => vm.runInContext(source, context);
  vm.runInContext(fs.readFileSync('extensions/hotcontainer-profile-handoff/background.js', 'utf8'), context);
  const request = sender => new Promise(resolve => assert.equal(handler({type:'hotcontainer-qualities',url:base},sender,resolve),true));
  assert.equal((await request({tab:{url:'https://www.xvideos.com/models/test'}})).variants.length,3);
  assert.equal((await request({tab:{url:'https://evil.example'}})).ok,false);
  assert.equal(fetched,1);
});
