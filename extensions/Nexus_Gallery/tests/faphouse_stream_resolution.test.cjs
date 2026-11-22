const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../faphouse_grid_importer.js'), 'utf8');

function resolver() {
  const bootMarker = "    if (document.readyState === 'loading') {";
  const bootIndex = source.lastIndexOf(bootMarker);
  assert.notEqual(bootIndex, -1, 'Faphouse boot marker must exist');

  // The production script is an IIFE. Stop just before boot and expose only
  // its pure parsing helpers; this keeps the test independent of live DOM UI.
  const instrumented = `${source.slice(0, bootIndex)}
    window.__faphouseTest = { findBestDirectStream, parseWatchPage, streamHeight, streamSizeLabel, fetchedStreamLine, faphouseJDownloaderProxyUrl };
})();`;
  const window = {};
  window.top = window;
  const context = vm.createContext({
    window,
    globalThis: window,
    location: { hostname: 'faphouse.com' },
    localStorage: { getItem: () => null, setItem() {} },
    document: {},
    chrome: { runtime: { onMessage: { addListener() {} } } },
    console,
    Map,
    Set,
    URL,
  });
  vm.runInContext(instrumented, context);
  return context.window.__faphouseTest;
}

test('current main-player URL beats a larger related-video manifest', () => {
  const { parseWatchPage } = resolver();
  const mainUrl = 'https://video-nss.flixcdn.com/signed/AB/AB1234/video/2160.mp4';
  const html = `
    <script id="view-state-data">{"video":{"videoViewAllowed":true,"duration":3600}}</script>
    <video id="video-AB1234"><source src="${mainUrl}"></video>
    <script>const related = 'https://video-nss.flixcdn.com/other/media=hls4/multi=3840x2160:2160/CD/CD5678/format/_TPL_.mp4.m3u8';</script>
  `;

  const resolved = parseWatchPage(html);
  assert.equal(resolved.locked, false);
  assert.equal(resolved.streamUrl, mainUrl);
  assert.equal(resolved.quality, '2160p');
  assert.equal(resolved.duration, 3600);
});

test('current-video view state beats unrelated page-wide HLS fallback', () => {
  const { parseWatchPage } = resolver();
  const directUrl = 'https://video-nss.flixcdn.com/signed/EF/EF9012/video/1080.mp4';
  const html = `
    <script id="view-state-data">{"video":{"videoViewAllowed":true,"downloadUrl":"${directUrl}"}}</script>
    <script>const related = 'https://video-nss.flixcdn.com/other/media=hls4/multi=3840x2160:2160/GH/GH3456/format/_TPL_.mp4.m3u8';</script>
  `;

  const resolved = parseWatchPage(html);
  assert.equal(resolved.locked, false);
  assert.equal(resolved.streamUrl, directUrl);
});

const watchUrl = 'https://faphouse.com/videos/selected-video-AB1234';
const lowHls = 'https://video-nss.flixcdn.com/sig,4102444800/media=hls4/multi=426x240:240,1280x720:720,3840x2160:2160/AB/AB1234/format/240.mp4.m3u8';

test('selected 240p filename is not mislabeled by its available 2160p rendition', () => {
  const { streamHeight, parseWatchPage } = resolver();
  assert.equal(streamHeight(lowHls), 240);
  const result = parseWatchPage(`<video id="video-AB1234"><source src="${lowHls}"></video>`, watchUrl);
  assert.equal(result.streamUrl, lowHls.replace('/format/240.', '/format/2160.'));
  assert.equal(result.height, 2160);
});

test('rejects another asset even when it is the only available playlist', () => {
  const { parseWatchPage } = resolver();
  const other = lowHls.replaceAll('AB1234', 'CD5678');
  assert.equal(parseWatchPage(`<video id="video-CD5678"><source src="${other}"></video>`, watchUrl).locked, true);
});

test('same asset highest variant beats its player startup rendition', () => {
  const { parseWatchPage } = resolver();
  const small = 'https://video-nss.flixcdn.com/signed/AB/AB1234/video/240.mp4';
  const full = 'https://video-nss.flixcdn.com/signed/AB/AB1234/video/2160.mp4';
  const html = `<video id="video-AB1234"><source src="${small}"></video>
    <script id="view-state-data">${JSON.stringify({video:{videoViewAllowed:true,sources:[full]}})}</script>`;
  assert.equal(parseWatchPage(html, watchUrl).streamUrl, full);
});

test('HTML-escaped rendition maps resolve to one clean selected MP4 URL', () => {
  const { parseWatchPage } = resolver();
  const low = 'https://video-nss.flixcdn.com/signed/AB/AB1234/format/240.mp4';
  const high = low.replace('/240.mp4', '/1080.mp4');
  const html = `${low}&quot;,&quot;1080&quot;:&quot;${high}`;
  const resolved = parseWatchPage(html, watchUrl);
  assert.equal(resolved.streamUrl, high);
  assert.equal(resolved.quality, '1080p');
  assert.doesNotMatch(resolved.streamUrl, /&quot;/);
});

test('locked current video cannot export a recommendation stream', () => {
  const { parseWatchPage } = resolver();
  const html = `<script id="view-state-data">{"video":{"videoViewAllowed":false}}</script>${lowHls}`;
  assert.equal(parseWatchPage(html, watchUrl).locked, true);
});

function backgroundProbe(fetch) {
  const bg = readFileSync(join(__dirname, '../background.js'), 'utf8');
  const start = bg.indexOf('async function probeFaphouseStream(');
  const end = bg.indexOf('async function fetchCorsText(', start);
  const context = vm.createContext({ fetch, URL, AbortSignal, nexusParseHlsBestVariant: () => null });
  vm.runInContext(bg.slice(start, end), context);
  return context.probeFaphouseStream;
}

test('HLS size uses segment bytes and is labeled as an estimate', async () => {
  const calls = [];
  const playlist = '#EXTM3U\n' + Array.from({length:12}, (_, i) => `#EXTINF:4,\nseg-${i}.ts\n`).join('') + '#EXT-X-ENDLIST';
  const probe = backgroundProbe(async (url, options) => {
    calls.push({url, options});
    return {ok:true, url, text:async()=>playlist, headers:new Headers({'content-length': String(options.method === 'HEAD' ? 1048576 : playlist.length)})};
  });
  const result = await probe(lowHls, watchUrl, 48);
  assert.equal(result.sizeBytes, 12 * 1048576);
  assert.equal(result.estimated, true);
  assert.equal(result.duration, 48);
  assert.equal(calls.filter(c=>c.options.method === 'HEAD').length, 9);
});

test('duration mismatch blocks export before probing media segments', async () => {
  let calls = 0;
  const probe = backgroundProbe(async url => {
    calls++;
    return {ok:true, url, text:async()=> '#EXTM3U\n#EXTINF:4,\nseg.ts\n#EXT-X-ENDLIST'};
  });
  const result = await probe(lowHls, watchUrl, 2500);
  assert.equal(result.durationMismatch, true);
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
});

function galleryResolver(reply) {
  const popup = readFileSync(join(__dirname, '../popup.js'), 'utf8');
  const context = vm.createContext({
    URL,
    chrome:{tabs:{sendMessage:async()=>reply}},
    isForumTurboVideo:()=>false,
    scheduleFaphouseCardCacheSave:()=>{},
  });
  const start = popup.indexOf('function isFaphouseVideo(');
  vm.runInContext(popup.slice(start, popup.indexOf('function isBeegVideo(', start)), context);
  const sizeStart = popup.indexOf('function getVideoSizeBytes(');
  vm.runInContext(popup.slice(sizeStart, popup.indexOf('function getVideoSizeMegabytes(', sizeStart)), context);
  const resolveStart = popup.indexOf('async function resolveVideoUrl(');
  vm.runInContext(popup.slice(resolveStart, popup.indexOf('function inferVariantHeight(', resolveStart)), context);
  return context;
}

function faphouseCacheHelpers(storage = {}) {
  const popup = readFileSync(join(__dirname, '../popup.js'), 'utf8');
  const start = popup.indexOf("const FAPHOUSE_CARD_CACHE_KEY =");
  const end = popup.indexOf('async function saveToCache(', start);
  assert.notEqual(start, -1, 'FapHouse cache helpers must exist');
  const chrome = {
    storage: {
      local: {
        get: async key => key ? { [key]: storage[key] } : storage,
        set: async value => Object.assign(storage, value),
      },
    },
  };
  const context = vm.createContext({
    chrome, URL, Date, Object, Array, Number, String, setTimeout, clearTimeout,
    console, getCopyableDirectUrl: video => video?.directUrl || '',
  });
  vm.runInContext(popup.slice(start, end), context);
  return { ...context, storage };
}

test('FapHouse card cache keys are stable and never retain an unsigned stream', () => {
  const cache = faphouseCacheHelpers();
  assert.equal(
    cache.faphouseCacheKey('https://www.faphouse.com/videos/example-AB1234?from=search#player'),
    'https://www.faphouse.com/videos/example-AB1234',
  );
  assert.equal(cache.faphouseCacheKey('https://other.example/video'), '');
  const entry = cache.compactFaphouseCacheEntry({
    source_url: 'https://faphouse.com/videos/example-AB1234',
    directUrl: 'https://cdn.example/unsigned.mp4',
    faphouseResolverVersion: 2,
    title: 'Example',
  });
  assert.equal(entry.directUrl, undefined);
});

test('FapHouse card cache hydrates only a still-valid matching signed stream', async () => {
  const key = 'https://faphouse.com/videos/example-AB1234';
  const expires = Math.floor(Date.now() / 1000) + 600;
  const storage = {
    nexus_faphouse_card_cache_v1: {
      version: 1,
      entries: {
        [key]: {
          cachedAt: Date.now(), title: 'Cached title', duration: 120, quality: '1080p',
          directUrl: `https://video-nss.flixcdn.com/sig,${expires}/AB/AB1234/format/1080.mp4`,
          directExpiresAt: expires * 1000, resolverVersion: 2, size: 12345,
        },
      },
    },
  };
  const cache = faphouseCacheHelpers(storage);
  const video = { source_url: `${key}?from=category` };
  assert.equal(await cache.hydrateFaphouseCardsFromCache([video]), 1);
  assert.equal(video.title, 'Cached title');
  assert.equal(video.faphouseResolverVersion, 2);
  assert.match(video.directUrl, /AB1234/);
  assert.equal(video._faphouseCacheHit, true);
});

test('FapHouse Gallery hydrates signed card cache before rendering cards', () => {
  const popup = readFileSync(join(__dirname, '../popup.js'), 'utf8');
  const start = popup.indexOf('async function handleFaphouseScraping(tab) {');
  assert.notEqual(start, -1, 'FapHouse Gallery handler must exist');
  const handler = popup.slice(start);
  assert.match(handler, /const cacheHits = await hydrateFaphouseCardsFromCache\(result\);/);
  assert.match(handler, /renderGrid\(currentlyFilteredVideos\);/);
});

test('Gallery retires stale direct URLs and binds all displayed size to the new stream', async () => {
  const newUrl = lowHls.replace('/format/240.', '/format/2160.');
  const gallery = galleryResolver({ok:true,items:[{directUrl:newUrl, resolverVersion:2, quality:'2160p', duration:48, size:12582912, sizeStreamUrl:newUrl, sizeEstimated:true}]});
  const video = {source_url:watchUrl, directUrl:lowHls, size:3e9, file_size_mb:3000, size_bytes:3e9};
  assert.equal(gallery.getCopyableDirectUrl(video), '');
  assert.equal(gallery.getVideoSizeBytes(video), 0);
  await gallery.resolveFaphouseVideo(video, 1);
  assert.equal(gallery.getCopyableDirectUrl(video), newUrl);
  assert.equal(gallery.getVideoSizeBytes(video), 12582912);
  assert.equal(video.file_size_mb, 0);
  assert.equal(video.size_bytes, 0);
  video.directUrl = lowHls;
  assert.equal(gallery.getCopyableDirectUrl(video), '');
  assert.equal(gallery.getVideoSizeBytes(video), 0);
});

test('Gallery rejects a resolver response carrying the wrong video identity', async () => {
  const gallery = galleryResolver({ok:true,items:[{directUrl:lowHls.replaceAll('AB1234','CD5678'),resolverVersion:2}]});
  const video = {source_url:watchUrl};
  await assert.rejects(gallery.resolveFaphouseVideo(video, 1), /ID streamu/);
  assert.equal(gallery.getCopyableDirectUrl(video), '');
});

test('Gallery plays an already verified FapHouse stream without requiring the source-tab bridge', async () => {
  const gallery = galleryResolver({ok:false});
  const expires = Math.floor(Date.now() / 1000) + 600;
  const directUrl = `https://video-nss.flixcdn.com/sig,${expires}/AB/AB1234/format/1080.mp4`;
  const video = {
    source_url: watchUrl,
    directUrl,
    faphouseResolvedUrl: directUrl,
    faphouseResolverVersion: 2,
  };
  gallery.getSourceTab = async () => { throw new Error('bridge must not be needed'); };
  assert.equal(await gallery.resolveVideoUrl(video), directUrl);
});

test('actual Gallery message bridge refreshes the URL and waits for its matching size probe', async () => {
  let listener;
  const chrome = {runtime:{id:'test', onMessage:{addListener:fn=>{listener=fn;}}, sendMessage:(message, done)=>done({ok:true,sizeBytes:200000000,estimated:true})}};
  const window = {chrome}; window.top = window;
  const context = vm.createContext({window,globalThis:window,chrome,URL,
    location:{hostname:'faphouse.com'},localStorage:{getItem:()=>null},document:{},
    fetch:async()=>({ok:true,text:async()=>`<script id="view-state-data">{"video":{"videoViewAllowed":true,"duration":2400}}</script><video id="video-AB1234"><source src="${lowHls}"></video>`})});
  const end = source.lastIndexOf("    if (document.readyState === 'loading') {");
  vm.runInContext(source.slice(0,end) + `
    scanCards = () => {};
    refreshItemPresentation = () => {};
    isWatchPage = () => false;
    window.state = state;
  })();`,context);
  window.state.items.set('AB1234',{id:'AB1234',url:watchUrl,title:'Selected video',direct_url:lowHls,sizeBytes:3e9,card:{isConnected:true}});
  const reply = await new Promise(done=>listener({action:'FAPHOUSE_GALLERY_RESOLVE',url:watchUrl,force:true},{},done));
  assert.equal(reply.ok,true);
  assert.equal(reply.items[0].directUrl,lowHls.replace('/format/240.','/format/2160.'));
  assert.equal(reply.items[0].size,200000000);
  assert.equal(reply.items[0].sizeStreamUrl,reply.items[0].directUrl);
  assert.equal(reply.items[0].resolverVersion,2);
});

test('a rejected optional CDN size probe does not discard a resolved stream', async () => {
  let listener;
  const chrome = {runtime:{id:'test', onMessage:{addListener:fn=>{listener=fn;}}, sendMessage:(message, done)=>done({ok:false,error:'Playlist HTTP 403'})}};
  const window = {chrome}; window.top = window;
  const context = vm.createContext({window,globalThis:window,chrome,URL,
    location:{hostname:'faphouse.com'},localStorage:{getItem:()=>null},document:{},
    fetch:async()=>({ok:true,text:async()=>`<script id="view-state-data">{"video":{"videoViewAllowed":true,"duration":2400}}</script><video id="video-AB1234"><source src="${lowHls}"></video>`})});
  const end = source.lastIndexOf("    if (document.readyState === 'loading') {");
  vm.runInContext(source.slice(0,end) + `
    scanCards = () => {};
    refreshItemPresentation = () => {};
    isWatchPage = () => false;
    window.state = state;
  })();`,context);
  const reply = await new Promise(done=>listener({action:'FAPHOUSE_GALLERY_RESOLVE',url:watchUrl,force:true},{},done));
  assert.equal(reply.ok,true);
  assert.equal(reply.items[0].directUrl,lowHls.replace('/format/240.','/format/2160.'));
  assert.equal(reply.items[0].resolveError,'');
  assert.equal(reply.items[0].sizeStreamUrl, '');
});

test('Faphouse CDN header rule targets the actual flixcdn host', () => {
  const rules = JSON.parse(readFileSync(join(__dirname, '../rules.json'), 'utf8'));
  const faphouseRule = rules.find(rule => rule.id === 10);
  assert.equal(faphouseRule.condition.urlFilter, '*://*.flixcdn.com/*');
});

test('fetched stream lines show a verified size, then the source-size fallback while estimating', () => {
  const { fetchedStreamLine } = resolver();
  assert.match(fetchedStreamLine({quality:'2160p', title:'Video', sizeBytes: 3 * 1024 ** 3, sizeEstimated:true}), /Odhad streamu ≈ 3\.00 GB/);
  assert.match(fetchedStreamLine({quality:'2160p', title:'Video', reportedSizeBytes: 2 * 1024 ** 3, sizePending:true}), /Zdroj 2\.00 GB/);
});

test('Fetch does not feed unnamed raw URLs to Clipboard Watcher and JD receives the FapHouse referer', () => {
  const fetchStart = source.indexOf('    async function fetchSelectedStreams() {');
  const fetchEnd = source.indexOf('    function enqueueInSidecar', fetchStart);
  assert.doesNotMatch(source.slice(fetchStart, fetchEnd), /clipboard\.writeText/);
  assert.doesNotMatch(source, /data-role="copy-urls"|data-role="download-crawljob"|navigator\.clipboard\.writeText/);
  assert.match(source, /params\.append\('referer', 'https:\/\/faphouse\.com\/'\)/);
});

test('JDownloader gets FapHouse streams through the local proxy', () => {
  const { faphouseJDownloaderProxyUrl } = resolver();
  const proxyUrl = faphouseJDownloaderProxyUrl('http://localhost:8001/', lowHls);
  assert.match(proxyUrl, /^http:\/\/localhost:8001\/hls_proxy\.m3u8\?url=/);
  assert.match(proxyUrl, /referer=https%3A%2F%2Ffaphouse\.com%2F/);
  const mp4ProxyUrl = faphouseJDownloaderProxyUrl('http://localhost:8001', 'https://cdn.example/video.mp4', 'Actual title [1080p].mp4');
  assert.match(mp4ProxyUrl, /^http:\/\/localhost:8001\/media_proxy\.mp4\?url=/);
  assert.match(mp4ProxyUrl, /filename=Actual%20title%20%5B1080p%5D\.mp4/);
});

test('crawljob preserves the selected title, exact verified URL and estimate provenance', async () => {
  const popup = readFileSync(join(__dirname,'../popup.js'),'utf8');
  const url = lowHls.replace('/format/240.','/format/2160.');
  const gallery = galleryResolver({ok:true,items:[{directUrl:url,resolverVersion:2,quality:'2160p',duration:2500,size:200000000,sizeStreamUrl:url,sizeEstimated:true}]});
  gallery.formatSizeCompact = bytes=>String(bytes);
  const start = popup.indexOf('    function jdCleanTitle(');
  const end = popup.indexOf('    function downloadJDownloaderCrawljob(',start);
  vm.runInContext(popup.slice(start,end),gallery);
  const video = {title:'Selected: title',source_url:watchUrl};
  await gallery.resolveFaphouseVideo(video,1);
  const [job] = gallery.buildJDownloaderCrawljobs([video],'Selected batch');
  assert.equal(job.text,url);
  assert.equal(job.filename,'Selected_ title [2160p].mp4');
  assert.match(job.comment,/Odhad streamu: 200000000/);
  assert.equal(job.autoStart,false);
});
