const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const url = 'https://hls-cdn77.xvideos-cdn.com/signed/video/hls-4k.m3u8';
function setup(result, status = 200, downloads) {
  let handler;
  const calls = [];
  const context = vm.createContext({ URL, AbortSignal, btoa,
    importScripts() {},
    HotContainerQualities: { isAllowedUrl: u => u === url, load: async () => [] },
    chrome: { downloads, storage: { local: { get: async () => ({}) } }, runtime: { onMessage: { addListener(fn) { handler = fn; } } } },
    fetch: async (u, options) => {
      calls.push({u, options});
      if (u.includes('/config/')) return {ok:true};
      return {ok:status === 200, status, json:async()=>result};
    },
  });
  vm.runInContext(fs.readFileSync('extensions/hotcontainer-profile-handoff/background.js','utf8'),context);
  return {calls, request: (payload = {}, host = 'https://www.xvideos.com/models/me') => new Promise(resolve => {
    assert.equal(handler({type:'hotcontainer-download',url,title:'My video',...payload},{tab:{url:host}},resolve),true);
  })};
}
test('Download sends selected signed HLS to local IDM bridge as MP4 with immediate start', async () => {
  const app = setup({queued:1});
  assert.equal((await app.request()).ok,true);
  const call = app.calls.find(c => c.u.endsWith('/api/tester/idm'));
  assert.deepEqual(JSON.parse(call.options.body),{start:true,items:[{url,filename:'My video.mp4'}]});
});
test('Download reports IDM failures and empty queues', async () => {
  assert.match((await setup({detail:'IDM missing'},503).request()).error,/IDM missing/);
  assert.equal((await setup({queued:0,skipped:[{reason:'bad source'}]}).request()).error,'bad source');
});
test('Download rejects unsupported source and sender before local requests', async () => {
  const app = setup({queued:1});
  assert.equal((await app.request({url:'https://evil.example/a.m3u8'})).ok,false);
  assert.equal((await app.request({},'https://evil.example')).ok,false);
  assert.equal(app.calls.length,0);
});

test('IDM timeout falls back to a real Chrome MP4 download through the HLS bridge', async () => {
  let options;
  const app = setup({queued:0,skipped:[{reason:'IDM timeout'}]},200,{download:async value => {options=value;return 7;}});
  assert.equal((await app.request()).method,'chrome');
  assert.equal(options.filename,'My_video.mp4');
  const token = new URL(options.url).pathname.split('/')[4];
  assert.equal(Buffer.from(token,'base64url').toString(),url);
  assert.match(options.url,/\/api\/tester\/hls-download\/.+\/My_video.mp4$/);
});
