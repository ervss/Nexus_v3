const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');

async function fixture(sources) {
  const parts = Array.from({length: 30}, () => Buffer.alloc(16, 7).toString('base64url'));
  const iv = Buffer.alloc(12, 2);
  const key = await webcrypto.subtle.importKey('raw', Buffer.alloc(32, 7), 'AES-GCM', false, ['encrypt']);
  const payload = await webcrypto.subtle.encrypt({name:'AES-GCM',iv}, key, Buffer.from(JSON.stringify({sources})));
  return {duration_seconds:1977,playback:{version:5,key_parts:parts,iv:iv.toString('base64url'),payload:Buffer.from(payload).toString('base64url')}};
}
function worker(data) {
  const storage = {'nvs_meta_v10:https://www.69tubed.com/video/26030/test/':{ts:Date.now(),quality:'HD',sizeMb:null}};
  let calls = 0;
  const ctx = {URL,AbortController,AbortSignal,Uint8Array,TextDecoder,crypto:webcrypto,atob,setTimeout,clearTimeout,console,
    fetch:async url=>{calls++;return new Response(url.includes('/api/videos/') ? JSON.stringify(data) : '<iframe src="https://embed.example/e/code/file.mp4"></iframe>');},
    chrome:{runtime:{onMessage:{addListener(){}}},storage:{local:{async get(){return storage;},async set(v){Object.assign(storage,v);}}}}};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('extensions/nexus-video-selector/background.js','utf8'),ctx);
  return {ctx,storage,calls:()=>calls};
}
test('Byse decrypt selects highest rendition and replaces incomplete legacy cache', async()=>{
  const {ctx,storage,calls}=worker(await fixture([{url:'https://cdn.example/720',height:720,size_bytes:100000000},
    {url:'https://cdn.example/master.m3u8?secret=expired',height:1080,size_bytes:2174158925}]));
  const meta=await vm.runInContext("fetchVideoMeta('https://www.69tubed.com/video/26030/test/',1)",ctx);
  assert.equal(meta.quality,'1080P'); assert.equal(meta.sizeMb,2174158925/1048576);
  assert.equal(meta.duration,'32:57'); assert.equal(meta.sizeExact,true); assert.equal(calls(),2);
  assert.ok(!JSON.stringify(storage).includes('secret'));
  await vm.runInContext("fetchVideoMeta('https://www.69tubed.com/video/26030/test/',1)",ctx);
  assert.equal(calls(),2);
});
test('missing byte size uses explicitly marked bitrate estimate',async()=>{
  const {ctx}=worker(await fixture([{url:'https://cdn.example/hls',height:1080,bitrate_kbps:8000}]));
  const meta=await vm.runInContext("fetchVideoMeta('https://www.69tubed.com/video/26030/test/',1)",ctx);
  assert.equal(meta.sizeEstimated,true); assert.match(meta.sizeText,/^~/); assert.equal(meta.sizeExact,false);
});
test('invalid encryption remains incomplete and is not cached as success',async()=>{
  const {ctx,calls}=worker({playback:{version:0}});
  await vm.runInContext("fetchVideoMeta('https://www.69tubed.com/video/26030/test/',1)",ctx);
  await vm.runInContext("fetchVideoMeta('https://www.69tubed.com/video/26030/test/',1)",ctx);
  assert.equal(calls(),4);
});
