const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function worker(fetch) {
  const storage = {};
  const ctx = { URL, AbortController, AbortSignal, DataView, Uint8Array, TextDecoder, setTimeout, clearTimeout, console,
    fetch, chrome: { runtime: {onMessage:{addListener(){}}}, storage:{local:{
      async get(keys) { return Object.fromEntries(keys.filter(k=>k in storage).map(k=>[k,storage[k]])); },
      async set(data) { Object.assign(storage,data); }
    }}} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('extensions/nexus-video-selector/background.js','utf8'),ctx);
  return {ctx,storage};
}

test('offline explicit target never POSTS or falls back to another Nexus', async () => {
  const calls=[];
  const {ctx}=worker(async(url)=>{calls.push(url);throw Error('offline');});
  const result=await vm.runInContext("importToNexus('8001',[{url:'https://turbo.cr/v/a'}],null,true)",ctx);
  assert.equal(result.success,false);
  assert.deepEqual(calls,['http://127.0.0.1:8001/health']);
});

test('direct MP4 fallback measures duration, rotated dimensions and actual Content-Range size', async () => {
  const media = Buffer.alloc(160);
  media.writeUInt32BE(28,0); media.write('mvhd',4); media.writeUInt32BE(1000,20); media.writeUInt32BE(299000,24);
  media.writeUInt32BE(92,28); media.write('tkhd',32);
  media.writeInt32BE(65536,80); media.writeInt32BE(-65536,88);
  media.writeUInt32BE(848*65536,112); media.writeUInt32BE(480*65536,116);
  const calls=[];
  const {ctx,storage}=worker(async(url,options)=>{
    calls.push(url);
    if(url.startsWith('http://127.')) throw Error('blocked local API');
    if(url.includes('/api/sign?')) return new Response(JSON.stringify({url:'https://dl100.turbocdn.st/clip.mp4?token=SECRET'}));
    assert.match(options.headers.Range,/^bytes=0-/);
    return new Response(media,{status:206,headers:{'Content-Type':'video/mp4','Content-Range':'bytes 0-159/230893804'}});
  });
  const result=await vm.runInContext("fetchTurboOverviewMeta({url:'https://turbo.cr/v/test',port:'8000',requestId:'live'},9)",ctx);
  assert.equal(result.meta.duration,299); assert.equal(result.meta.width,480); assert.equal(result.meta.height,848);
  assert.equal(result.meta.size_bytes,230893804); assert.equal(calls.length,3);
  assert.ok(!JSON.stringify(storage).includes('SECRET'));
});

test('direct reader rejects foreign hosts and stops consuming a server that ignores Range', async () => {
  let read=0,cancelled=false;
  const {ctx}=worker(async()=>new Response(new ReadableStream({pull(controller){read++;controller.enqueue(new Uint8Array(1024));},cancel(){cancelled=true;}}),{headers:{'Content-Length':'999999'}}));
  await assert.rejects(vm.runInContext("turboBoundedRead('https://evil.example/file',1024,AbortSignal.timeout(1000),0)",ctx));
  const result=await vm.runInContext("turboBoundedRead('https://dl100.turbocdn.st/file',1024,AbortSignal.timeout(1000),0)",ctx);
  assert.equal(result.bytes.length,1024); assert.equal(result.size,999999); assert.ok(read<=2); assert.equal(cancelled,true);
});
test('ambiguous POST failure never retries the batch and is marked uncertain', async () => {
  const calls=[];
  const {ctx}=worker(async(url,options)=>{calls.push({url,options});if(url.endsWith('/health'))return {ok:true};throw Error('response lost');});
  const result=await vm.runInContext("importToNexus('8002',[{url:'https://turbo.cr/v/a',width:1080,height:1920}],null,true)",ctx);
  assert.equal(result.uncertain,true);
  assert.equal(calls.length,2);
  const payload=JSON.parse(calls[1].options.body);
  assert.equal(payload.videos[0].width,1080);
  assert.equal(payload.videos[0].url,'https://turbo.cr/v/a');
});
test('metadata cache strips signed URLs and uses hosting ID plus chosen port', async () => {
  let calls=0;
  const {ctx,storage}=worker(async()=>{calls++;return {ok:true,json:async()=>({ok:true,title:'Clip',duration:60,width:1080,height:1920,size_bytes:12345,stream_url:'https://cdn1.turbocdn.st/file?token=SECRET'})};});
  await vm.runInContext("fetchTurboOverviewMeta({url:'https://turbo.cr/embed/Ab_C?sign=x',port:'8000',requestId:'r1'},9)",ctx);
  await vm.runInContext("fetchTurboOverviewMeta({url:'https://turbo.cr/d/Ab_C',port:'8000',requestId:'r2'},9)",ctx);
  assert.equal(calls,1);
  assert.ok(storage['nvs-turbo-meta-v1:8000:Ab_C']);
  assert.ok(!JSON.stringify(storage).includes('SECRET'));
  await vm.runInContext("fetchTurboOverviewMeta({url:'https://turbo.cr/v/Ab_C',port:'8001',requestId:'r3'},9)",ctx);
  assert.equal(calls,2);
});
