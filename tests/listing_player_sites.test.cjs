const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ctx={window:{},URL,URLSearchParams,location:new URL('https://pimpbunny.com/'),getComputedStyle:()=>({display:'block'})};
vm.runInNewContext(fs.readFileSync('extensions/nexus-video-selector/whoreshub-player.js','utf8'),ctx);
vm.runInNewContext(fs.readFileSync('extensions/nexus-video-selector/listing-player-sites.js','utf8'),ctx);
const api=ctx.window.NVSMultiSitePlayer;
const suppliedProfileUrl='https://www.xvideos.com/prof-video-click/upload-straight/nashidni_661/opfkkuu0fc8/the_security_guard_fucked_me_hard_for_a_cherry_and_my_sneaky_-_thrusts_-_sex_on_the_street';
const suppliedWatchUrl=suppliedProfileUrl.replace('/prof-video-click/upload-straight/nashidni_661/','/video.');
test('watch URLs accept each supported listing without accepting ads, media or foreign sites',()=>{
  for(const [base,path] of [['https://pimpbunny.com/','/videos/example/'],['https://xhamster.com/','/videos/title-xhabc'],['https://www.eporner.com/','/video-abc123/title/'],['https://www.xvideos.com/','/video.abc123/title'],['https://www.xvideos.com/','/video123456/title']]) {
    assert.equal(api.watchUrl(path,base),new URL(path,base).href);
    for(const url of ['https://evil.test'+path,'javascript:alert(1)','/categories/test/','/embed/abc']) assert.equal(api.watchUrl(url,base),'');
  }
  assert.equal(api.watchUrl('/prof-video-click/1?url=%2Fvideo.abc%2Ftitle','https://www.xvideos.com/'),'https://www.xvideos.com/video.abc/title');
});
test('XVideos profile tracking paths resolve numeric and modern IDs without accepting unrelated targets',()=>{
  const base='https://www.xvideos.com/romulo_pontess_official#_tabVideos';
  for(const [path,expected] of [
    ['/prof-video-click/upload/romulo_pontess_official/okdpmlhed5e/example?track=1','/video.okdpmlhed5e/example'],
    ['/prof-video-click/upload/romulo_pontess_official/123456/example','/video123456/example'],
    ['/model-click/models/creator/abc123/example','/video.abc123/example'],
    ['/prof-video-click/upload/creator/abc123/','/video.abc123/'],
    ['/prof-video-click/upload-straight/creator/abc123/example','/video.abc123/example'],
    ['/prof-video-click/upload-gay/creator/123456/example','/video123456/example'],
    ['/prof-video-click/upload-shemale/creator/abc123/example','/video.abc123/example'],
  ]) assert.equal(api.watchUrl(path,base),new URL(expected,base).href);
  assert.equal(api.watchUrl(suppliedProfileUrl,base),suppliedWatchUrl);
  assert.equal(api.watchUrl('/prof-video-click/upload-advert/creator/abc123/example',base),'');
  for(const path of ['/prof-video-click/upload/creator/not-an-id/example','/prof-video-click/upload/creator/abc/extra/path','/model-click/ads/creator/abc/example','/prof-video-click/1?url=https://evil.test/video.abc/example']) assert.equal(api.watchUrl(path,base),'');
  let target='/video.abc/title';
  for(let i=0;i<6;i++) target='/prof-video-click/1?url='+encodeURIComponent(target);
  assert.equal(api.watchUrl(target,base),'');
});

test('XVideos profile cards enter both the player collection and the metadata scan with canonical detail URLs',()=>{
  ctx.location=new URL('https://www.xvideos.com/nashidni_661#_tabVideos');
  const link={href:suppliedProfileUrl,title:'Example'};
  const attrs=new Map(), card={dataset:{},style:{},hidden:false,classList:{contains:()=>false},closest:()=>null,matches:()=>false,
    querySelectorAll:()=>[link],querySelector:s=>s.startsWith('img')?{alt:'Example'}:null,
    getAttribute:k=>attrs.get(k),setAttribute:(k,v)=>attrs.set(k,v),getBoundingClientRect:()=>({top:100,bottom:300})};
  const root={querySelectorAll:()=>[card]}, entries=api.collect(root,'xvideos');
  assert.equal(entries.length,1);assert.equal(entries[0].url,suppliedWatchUrl);
  const queued=[], badges=[];
  const scanContext={window:{innerHeight:800,getComputedStyle:()=>({position:'static'})},state:{nextSortIndex:0,selected:new Set(),filterDuration:'all'},
    CFG:{processedAttr:'data-nvs-processed'},findVideoCards:()=>entries.map(e=>e.card),getSessionSelection:()=>new Set(),
    isEromePage:()=>false,isRedgifsPage:()=>false,isSxyprnPage:()=>false,isInternetChicksPage:()=>false,isSpankBangPage:()=>false,isCamwhoresPage:()=>false,isArchvePage:()=>false,genericListingPlayer:null,discardPaidCard:()=>false,injectSelector(){},injectBadge:c=>badges.push(c),
    getVideoUrlFromCard:()=>entries[0].url,enqueue:(c,url)=>queued.push(url),updateImportBar(){},setTimeout(){},reinspectLoadingBadges(){}};
  const source=fs.readFileSync('extensions/nexus-video-selector/content.js','utf8');
  vm.runInNewContext(source.slice(source.indexOf('  function scan()'),source.indexOf('  /**',source.indexOf('  function scan()'))),scanContext);
  assert.equal(scanContext.scan(),1);assert.equal(badges.length,1);assert.deepEqual(queued,[suppliedWatchUrl]);
});

test('PimpBunny inline KVS options decode and rank only playable sources',()=>{
  const html="kt_player('player','swf',{license_code:'123456789',video_url:'https://cdn.test/123_480p.mp4',video_alt_url:'https://cdn.test/123_1080p.mp4',video_alt_url2:'https://cdn.test/preview.mp4'})";
  const sources=api.parseSources(html,'https://pimpbunny.com/videos/example/');
  assert.deepEqual(Array.from(sources,s=>s.height),[1080,480]);
});
test('Eporner keeps all advertised downloads with H264 preferred at the same resolution',()=>{
  const html='<a href="/dload/abc/2160/1-2160p-av1.mp4">AV1</a><a href="/dload/abc/2160/1-2160p.mp4">H264</a><a href="/dload/abc/720/1-720p.mp4">720</a>';
  const sources=api.parseSources(html,'https://www.eporner.com/video-abc/title/');
  assert.equal(sources[0].height,2160);assert.match(sources[0].quality,/H\.264/);assert.match(sources[1].quality,/AV1/);
  assert.equal(sources.length,3);
});
test('Eporner public player API request converts hash as the official player and validates video identity',()=>{
  const html="EP.video.player.vid = 'abc'; EP.video.player.hash = '0123456789abcdef0123456789abcdef';";
  const request=new URL(api.epornerRequest(html,'https://www.eporner.com/video-abc/title/'));
  assert.equal(request.pathname,'/xhr/video/abc');
  assert.equal(request.searchParams.get('hash'),[0,8,16,24].map(i=>parseInt('0123456789abcdef0123456789abcdef'.slice(i,i+8),16).toString(36)).join(''));
  assert.equal(request.searchParams.get('supportedFormats'),'hls,mp4');
  const data={vid:'abc',available:true,sources:{mp4:{'1080p HD':{src:'https://cdn.test/1-1080p.mp4'}},hls:{auto:{src:'https://cdn.test/master.m3u8'}}}};
  assert.equal(api.epornerSources(data,'https://www.eporner.com/video-abc/title/')[0].height,1080);
  assert.equal(api.epornerSources(data,'https://www.eporner.com/video-wrong/title/').length,0);
  assert.equal(api.epornerSources({...data,available:false},'https://www.eporner.com/video-abc/title/').length,0);
});
test('XVideos separates HLS, High and Low without inventing High dimensions',()=>{
  const sources=api.parseSources("html5player.setVideoUrlLow('https://cdn.test/low.mp4');html5player.setVideoUrlHigh('https://cdn.test/high.mp4');html5player.setVideoHLS('https://cdn.test/master.m3u8');",'https://www.xvideos.com/video.abc/title');
  assert.equal(sources[0].type,'hls');assert.equal(sources[1].quality,'High');assert.equal(sources[1].height,0);assert.equal(sources[2].quality,'Low');
});
test('xHamster sources come from current xplayerSettings, not related videos',()=>{
  const html=`<script id="initials-script">window.initials=${JSON.stringify({related:{url:'https://cdn.test/wrong_2160p.mp4'},xplayerSettings:{sources:{standard:{hls:[{url:'https://cdn.test/master.m3u8'}],mp4:[{url:'https://cdn.test/right_720p.mp4',quality:'720p'}]}}}})};</script>`;
  const sources=api.parseSources(html,'https://xhamster.com/videos/title-xhabc');
  assert.equal(sources.length,2);assert.equal(sources[0].height,720);assert.ok(sources.every(s=>!s.url.includes('wrong')));
});
test('HLS variants preserve original level indices and master/audio groups while ranking highest first',()=>{
  const sources=api.variants('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=854x480,AUDIO="audio"\n480.m3u8\n#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=9000000,BANDWIDTH=10000000,RESOLUTION=3840x2160,AUDIO="audio"\n2160.m3u8','https://cdn.test/signed/master.m3u8?token=x');
  assert.deepEqual(Array.from(sources,s=>s.height),[2160,480]);assert.equal(sources[0].level,1);assert.equal(sources[0].bandwidth,9000000);assert.equal(sources[0].url,sources[1].url);
  assert.equal(api.variants('<html>login</html>','https://cdn.test/master.m3u8').length,0);
});
test('collection follows visible DOM order, deduplicates nested roots and honors filtered cards',()=>{
  ctx.location=new URL('https://www.xvideos.com/');
  function card(path, hidden=false){const a={href:new URL(path,ctx.location).href,title:path};return {hidden,classList:{contains:()=>false},closest:()=>null,matches:()=>false,querySelectorAll:()=>[a],querySelector:s=>s.startsWith('img')?{alt:path}:null};}
  const first=card('/video.abc/first'),second=card('/video.def/second'),hidden=card('/video.ghi/hidden',true);
  const out=api.collect({querySelectorAll:()=>[second,first,first,hidden,card('/models/someone')]},'xvideos');
  assert.deepEqual(Array.from(out,e=>e.url),['https://www.xvideos.com/video.def/second','https://www.xvideos.com/video.abc/first']);
});
test('profile snippet cards are registered for import while their tab is hidden, but excluded from playback',()=>{
  ctx.location=new URL('https://www.xvideos.com/nashidni_661#_tabVideos');
  const link={href:'https://www.xvideos.com/video.abc123/example',title:'Example'};
  const card={hidden:false,classList:{contains:()=>false},closest:()=>null,matches:()=>false,
    getClientRects:()=>[],querySelectorAll:()=>[link],querySelector:s=>s.startsWith('img')?{alt:'Example'}:null};
  const root={querySelectorAll(selector){assert.ok(selector.includes('.video-snippet'));return [card];}};
  assert.equal(api.collect(root,'xvideos').length,0);
  assert.equal(api.collect(root,'xvideos',{includeHidden:true}).length,1);
  card.getClientRects=()=>[{}];
  assert.equal(api.collect(root,'xvideos').length,1);
});

test('both unpacked extensions bundle the same player and required HLS dependencies',()=>{
  for(const name of ['whoreshub-player.js','listing-player-sites.js','listing-player-network.js','listing-player.css']) assert.equal(fs.readFileSync('extensions/nexus-video-selector/'+name,'utf8'),fs.readFileSync('extensions/Nexus_Gallery/'+name,'utf8'));
  for(const directory of ['nexus-video-selector','Nexus_Gallery']) {const manifest=JSON.parse(fs.readFileSync(`extensions/${directory}/manifest.json`));for(const entry of manifest.content_scripts)for(const file of [...entry.js||[],...entry.css||[]])assert.ok(fs.existsSync(`extensions/${directory}/${file}`),file);}
});
test('transport rejects local network URLs and untrusted sender pages',async()=>{
  const net={URL,AbortSignal,TextDecoder,Uint8Array,chrome:{runtime:{onMessage:{addListener(){}}}}};vm.runInNewContext(fs.readFileSync('extensions/nexus-video-selector/listing-player-network.js','utf8'),net);
  assert.equal(net.NVSPlayerNetwork.allowed('https://cdn.test/video.mp4','https://pimpbunny.com/'),true);
  for(const url of ['https://127.0.0.1/file.mp4','https://192.168.1.4/master.m3u8','https://localhost/file.mp4','file:///private.mp4','https://evil.test/page'])assert.equal(net.NVSPlayerNetwork.allowed(url,'https://pimpbunny.com/'),false);
  assert.equal(net.NVSPlayerNetwork.allowed('https://cdn.test/video.mp4','https://evil.test/'),false);
  net.fetch=async()=>({ok:true,status:206,headers:new Map([['content-range','bytes 0-0/123456789'],['content-type','video/mp4']]),body:{cancel:async()=>{}}});
  assert.equal((await net.NVSPlayerNetwork.size('https://cdn.test/video.mp4')).sizeBytes,123456789);
  net.fetch=async()=>({ok:false,status:429,headers:new Map([['content-length','1000']]),body:{cancel:async()=>{}}});assert.equal((await net.NVSPlayerNetwork.size('https://cdn.test/video.mp4')).sizeBytes,null);
});
