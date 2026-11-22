const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const sandbox = {module:{exports:{}}, URL, AbortSignal, Response, Date};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../archve-meta.js'), 'utf8'), sandbox);
const {videoId, canonicalVideoUrl, kind, parseVideo, parseAlbum, createFetcher} = sandbox.module.exports;
const root = 'https://archve.xyz';
const ids = ['11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222'];
const page = n => `<div class="watch-meta"><h1>Video ${n}</h1><span class="watch-meta__chip" title="File size"><i></i> 2 GB</span><span title="Resolution">1920×1080</span><span title="Duration">${n ? '2:00' : '1:00'}</span></div>`;
test('watch metadata excludes unrelated years', () => {
  const p = parseVideo(page(0) + '<p>Filename 2020</p>');
  assert.equal(p.sizeMb, 2048); assert.equal(p.duration, '1:00'); assert.equal(p.height, 1080); assert.equal(p.date, null);
});
test('album parser accepts unique Archve watch URLs and count', () => {
 const html = `<p class="lead">person · 2 videos</p>${ids.map(i => `<a class="media-card" href="/watch/${i}">x</a>`).join('')}<a href="https://evil.test/watch/${ids[0]}">bad</a>`;
 const album = parseAlbum(html, root + '/albums/abc'); assert.equal(album.count, 2); assert.equal([...album.urls].join(','), ids.map(i => root + '/watch/' + i).join(','));
});
test('album aggregates exact byte counts and estimated file modification dates', async () => {
 const cache = new Map(); let current = 0, peak = 0;
 const fetchImpl = async url => {
   current++; peak = Math.max(peak,current); await new Promise(r => setTimeout(r, 2)); current--;
   if (url.includes('/albums/')) return new Response(`<p class="lead">2 videos</p>${ids.map(i => `<a href="/watch/${i}"></a>`).join('')}`);
   if (url.includes('/watch/')) return new Response(page(url.includes(ids[1]) ? 1 : 0));
   return new Response('x', {status:206,headers:{'content-range':'bytes 0-0/104857600','last-modified':url.includes(ids[1]) ? 'Sun, 15 Nov 2026 13:31:16 GMT' : 'Sat, 14 Nov 2026 13:31:16 GMT'}});
 };
 const f=createFetcher({fetchImpl, readCache:async u=>cache.get(u),writeCache:async (u,m)=>cache.set(u,m),formatSizeMb:mb=>`${mb} MB`});
 const m=await f.album(root+'/albums/abc'); assert.equal(m.sizeMb,200); assert.equal(m.duration,'1:30'); assert.equal(m.date,'2026-11-15'); assert.equal(m.dateEstimated,true); assert.equal(m.complete,true); assert.ok(peak<=4);
 assert.equal((await f.album(root+'/albums/abc')).sizeMb,200);
});
test('incomplete albums remain marked and are not cached', async () => {
 const cache=new Map();
 const f=createFetcher({fetchImpl:async url=>url.includes('/albums/') ? new Response(`<p class="lead">2 videos</p><a href="/watch/${ids[0]}"></a>`) : url.includes('/watch/') ? new Response(page(0)) : new Response('',{status:404}),readCache:async u=>cache.get(u),writeCache:async (u,m)=>cache.set(u,m),formatSizeMb:mb=>`${mb} MB`});
 const m=await f.album(root+'/albums/abc'); assert.equal(m.complete,false); assert.equal(m.durationPartial,true); assert.equal(cache.has(root+'/albums/abc'),false);
});

test('videoId and fetcher normalize archve /e/ embed and hls.archve.xyz video.mp4 URLs', async () => {
  const uuid = '0d295c3e-ec83-4a92-b5a2-d6afc3907fb3';
  const embedUrl = `https://archve.xyz/e/${uuid}`;
  const hlsUrl = `https://hls.archve.xyz/${uuid}/video.mp4?v=330264`;
  assert.equal(videoId(embedUrl), uuid);
  assert.equal(videoId(hlsUrl), uuid);
  assert.equal(kind(embedUrl), 'video');
  assert.equal(kind(hlsUrl), 'video');
  assert.equal(canonicalVideoUrl(hlsUrl), `https://archve.xyz/watch/${uuid}`);

  const cache = new Map();
  const seen = [];
  const f = createFetcher({
    fetchImpl: async url => {
      seen.push(url);
      if (url === `https://archve.xyz/watch/${uuid}`) return new Response(page(1));
      if (url === `https://archve.xyz/d/${uuid}`) return new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/52428800' } });
      return new Response('', { status: 404 });
    },
    readCache: async u => cache.get(u),
    writeCache: async (u, m) => cache.set(u, m),
    formatSizeMb: mb => `${mb} MB`,
  });
  const m = await f.video(hlsUrl);
  assert.equal(m.duration, '2:00');
  assert.equal(m.width, 1920);
  assert.equal(m.height, 1080);
  assert.equal(m.sizeMb, 50);
  assert.ok(seen.includes(`https://archve.xyz/watch/${uuid}`));
});
