const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
for (const file of ['userscripts/nexus-universal-splitscreen.user.js','app/static/nexus-universal-splitscreen.js']) {
 test(`${file}: failed direct source retries next direct source`,async()=>{
  const source=fs.readFileSync(file,'utf8');
  const start=source.indexOf('  async function fallbackToProxyOrIframe('),end=source.indexOf('  function switchToIframe(',start);
  let retries=0;
  const context={URL,encodeURIComponent,console,location:{protocol:'https:',hostname:'www.pornhub.com'},CONFIG:{DEFAULT_NEXUS_PORT:8000},turboVideoInfo:()=>null,startCellPlayback:async()=>{retries++},switchToIframe(){assert.fail('unexpected iframe')}};
  vm.runInNewContext(source.slice(start,end)+';this.fallback=fallbackToProxyOrIframe;',context);
  const cell={item:{url:'https://www.pornhub.com/view_video.php?viewkey=ph123',type:'hls',directUrl:'http://localhost:8000/hls_proxy?url=x',pornhubAlternatives:[{url:'http://localhost:8000/hls_proxy?url=y',type:'mp4'}]},video:{style:{}},iframe:{style:{}},loader:{style:{}}};
  await context.fallback(cell);
  assert.equal(retries,1);assert.equal(cell.item.directUrl,'http://localhost:8000/hls_proxy?url=y'); assert.equal(cell.item.type,'mp4'); assert.equal(cell.item.isIframe,false);
 });
}

test('nexus-universal-splitscreen.user.js: resolves pornhub.com mediaDefinitions + get_media directly on pornhub.com', async () => {
 const source = fs.readFileSync('userscripts/nexus-universal-splitscreen.user.js', 'utf8').replace(/\r\n/g, '\n');
 const start = source.indexOf('  async function resolveStreamUrl(');
 const end = source.indexOf('  // ---------------------------------------------------------------------------\n  // 7.', start);
 assert.ok(start > -1 && end > start, 'resolveStreamUrl block found');

 const watchHtml = `<html><script>
   var flashvars_123 = {"video_duration":"315","image_url":"https:\\/\\/ei.phncdn.com\\/thumb.jpg","mediaDefinitions":[{"format":"hls","videoUrl":"https:\\/\\/ev-h.phncdn.com\\/hls\\/master.m3u8?ttl=1","quality":["1080","720"]},{"format":"mp4","videoUrl":"https:\\/\\/www.pornhub.com\\/video\\/get_media?s=abc","quality":[]}]};
 </script></html>`;
 const getMediaJson = JSON.stringify([
   { format: 'mp4', quality: '720', videoUrl: 'https://ev-h.phncdn.com/720p.mp4?ttl=1' },
   { format: 'mp4', quality: '1080', videoUrl: 'https://ev-h.phncdn.com/1080p.mp4?ttl=1' }
 ]);

 let backendCalls = 0;
 const context = {
   URL,
   console,
   location: { protocol: 'https:', hostname: 'www.pornhub.com', href: 'https://www.pornhub.com/' },
   isEpornerUrl: () => false,
   sxyprnPostKey: () => '',
   isCamwhores: () => false,
   isBeegHost: () => false,
   isNoodleMagazineHost: () => false,
   turboVideoInfo: () => null,
   isBunkrOrTurbo: () => false,
   isPixeldrain: () => false,
   isXHamster: () => false,
   formatDuration: (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`,
   resolveViaNexusBackend: async () => { backendCalls++; return null; },
   gmFetch: async (url) => {
     if (url.includes('view_video.php')) return { ok: true, url, text: async () => watchHtml };
     if (url.includes('/video/get_media')) return { ok: true, url, text: async () => getMediaJson };
     return { ok: false, status: 404, text: async () => '' };
   }
 };
 vm.runInNewContext(source.slice(start, end) + ';this.resolveStreamUrl=resolveStreamUrl;', context);

 const item = { url: 'https://www.pornhub.com/view_video.php?viewkey=ph123', watchUrl: 'https://www.pornhub.com/view_video.php?viewkey=ph123', type: 'generic_watch', isResolved: false };
 const resolved = await context.resolveStreamUrl(item);

 assert.equal(backendCalls, 0);
 assert.equal(resolved, 'https://ev-h.phncdn.com/1080p.mp4?ttl=1');
 assert.equal(item.type, 'mp4');
 assert.equal(item.isResolved, true);
 assert.equal(item.isIframe, false);
 assert.equal(item.duration, 315);
 assert.equal(item.poster, 'https://ei.phncdn.com/thumb.jpg');
 assert.deepEqual(JSON.parse(JSON.stringify(item.pornhubAlternatives)), [
   { url: 'https://ev-h.phncdn.com/720p.mp4?ttl=1', type: 'mp4' },
   { url: 'https://ev-h.phncdn.com/hls/master.m3u8?ttl=1', type: 'hls' }
 ]);
});

test('nexus-universal-splitscreen.user.js: falls back to direct pornhub HLS when backend is offline on another origin', async () => {
 const source = fs.readFileSync('userscripts/nexus-universal-splitscreen.user.js', 'utf8').replace(/\r\n/g, '\n');
 const start = source.indexOf('  async function resolveStreamUrl(');
 const end = source.indexOf('  // ---------------------------------------------------------------------------\n  // 7.', start);
 const watchHtml = `<html><script>var flashvars_1={"mediaDefinitions":[{"format":"hls","videoUrl":"https:\\/\\/ev-h.phncdn.com\\/hls\\/720.m3u8","quality":"720"}]};</script></html>`;

 const context = {
   URL,
   console,
   location: { protocol: 'http:', hostname: 'localhost', href: 'http://localhost:8000/' },
   isEpornerUrl: () => false,
   sxyprnPostKey: () => '',
   isCamwhores: () => false,
   isBeegHost: () => false,
   isNoodleMagazineHost: () => false,
   turboVideoInfo: () => null,
   isBunkrOrTurbo: () => false,
   isPixeldrain: () => false,
   isXHamster: () => false,
   formatDuration: (s) => String(s),
   resolveViaNexusBackend: async () => { throw new Error('offline'); },
   gmFetch: async (url) => ({ ok: true, url, text: async () => watchHtml })
 };
 vm.runInNewContext(source.slice(start, end) + ';this.resolveStreamUrl=resolveStreamUrl;', context);

 const item = { url: 'https://www.pornhub.com/view_video.php?viewkey=ph999', watchUrl: 'https://www.pornhub.com/view_video.php?viewkey=ph999', type: 'generic_watch', isResolved: false };
 const resolved = await context.resolveStreamUrl(item);

 assert.equal(resolved, 'https://ev-h.phncdn.com/hls/720.m3u8');
 assert.equal(item.type, 'hls');
 assert.equal(item.isResolved, true);
});
