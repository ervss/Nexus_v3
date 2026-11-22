const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function fixture() {
 const text = fs.readFileSync('app/static/main.js','utf8');
 const context = {console, window:{}, URL, AbortSignal, AbortController, setTimeout, clearTimeout};
 vm.runInNewContext(text.slice(text.indexOf('function createPlayerModule() {'),text.indexOf('function createToastModule() {'))+';this.p=createPlayerModule()',context);
 const p=context.p;
 const media={_nexusGeneration:1,_nexusListeners:new AbortController(),currentTime:27,src:'',load(){this.loads=(this.loads||0)+1},addEventListener(){},play(){return Promise.resolve()}};
 const video={id:42,url:'https://cdn.example/movie.mp4?token=one',source_url:'https://bunkr.cr/f/abc'};
 Object.assign(p,{$refs:{videoPlayer1:media},activeVideo:video,showPlayer:true,settings:{autoplay:true},showToast(){}});
 return {p,media,video,context};
}
test('Bunkr error immediately selects bounded proxy once, next error selects mirror',async()=>{
 const {p,media,video}=fixture();let mirrors=0;
 p.tryNextVideoSource=async()=>{mirrors++;return true};
 assert.equal(await p.recoverMainPlayback(video,0,'503',1),true);
 assert.match(media.src,/video_proxy.*upstream_timeout=6/);assert.equal(mirrors,0);
 await p.recoverMainPlayback(video,0,'503',1);assert.equal(mirrors,1);assert.equal(media.loads,1);
 assert.equal(video._resumeAfterRecovery,27);
});
test('overlapping failures share one recovery; stale result cannot refresh closed player',async()=>{
 const {p,media,video}=fixture();video._proxyRecoveryUrl=video.url;
 let release;let count=0;let refresh=0;
 p.tryNextVideoSource=()=>{count++;return new Promise(r=>release=r)};
 p.refreshMainPlayerSource=async()=>{refresh++;return true};
 const a=p.recoverMainPlayback(video,0,'error',1);const b=p.recoverMainPlayback(video,0,'error',1);
 media._nexusGeneration=2;p.showPlayer=false;release(false);
 assert.equal(await a,false);assert.equal(await b,false);assert.equal(count,1);assert.equal(refresh,0);
});
test('failed mirror lookup falls through to one source refresh',async()=>{
 const {p,video}=fixture();video._proxyRecoveryUrl=video.url;let refresh=0;
 p.tryNextVideoSource=async()=>false;p.refreshMainPlayerSource=async()=>{refresh++;return true};
 assert.equal(await p.recoverMainPlayback(video,0,'error',1),true);assert.equal(refresh,1);
});
test('recovery resumes at the last known seek target after the media element resets',async()=>{
 const {p,media,video}=fixture();video._proxyRecoveryUrl=video.url;media.currentTime=0;media._nexusResumeTime=96;
 p.tryNextVideoSource=async()=>true;
 assert.equal(await p.recoverMainPlayback(video,0,'HLS seek error',1),true);
 assert.equal(video._resumeAfterRecovery,96);
});
test('recovery prefers the active seek target over a previously buffered position',async()=>{
 const {p,media,video}=fixture();video._proxyRecoveryUrl=video.url;media.currentTime=38;media.seeking=true;media._nexusResumeTime=96;
 p.tryNextVideoSource=async()=>true;
 assert.equal(await p.recoverMainPlayback(video,0,'HLS seek error',1),true);
 assert.equal(video._resumeAfterRecovery,38);
});
test('fatal HLS media and network errors get one in-place recovery before source refresh',()=>{
 const {p,media}=fixture();let mediaRecoveries=0;let startPositions=[];
 const Hls={ErrorTypes:{MEDIA_ERROR:'mediaError',NETWORK_ERROR:'networkError'}};
 const hls={recoverMediaError(){mediaRecoveries++},startLoad(position){startPositions.push(position)}};
 assert.equal(p.recoverTransientHlsError(hls,{type:'mediaError'},media,Hls),true);
 assert.equal(mediaRecoveries,1);
 assert.equal(p.recoverTransientHlsError(hls,{type:'mediaError'},media,Hls),false);
 media.currentTime=38;
 assert.equal(p.recoverTransientHlsError(hls,{type:'networkError'},media,Hls),true);
 assert.deepEqual(startPositions,[38]);
 assert.equal(p.recoverTransientHlsError(hls,{type:'networkError'},media,Hls),false);
});
test('mirror response arriving after a slot switch cannot initialize another video',async()=>{
 const {p,media,video,context}=fixture();let release;let initialized=0;
 context.fetch=async()=>({ok:true,json:()=>new Promise(r=>release=r)});
 p.initPlayer=async()=>initialized++;
 const pending=p.tryNextVideoSource(video,0,1);await new Promise(setImmediate);media._nexusGeneration++;
 release({sources:[{id:1,url:video.url},{id:2,url:'https://mirror.example/movie.mp4'}]});
 assert.equal(await pending,false);assert.equal(initialized,0);
});

test('native errors have one recovery owner',()=>{
 const text=fs.readFileSync('app/static/main.js','utf8');
 assert.doesNotMatch(text,/Prehrávač odmietol uložený stream/);
});

test('Bunkr uses an explicitly fresh signed CDN URL without waiting for resigning',()=>{
 const {p,video}=fixture();
 video.url='https://pc9.scdn.st/movie.mp4?token=abc&ex=2000';
 assert.equal(p.freshBunkrPlaybackUrl(video,1000),video.url);
 video.url='https://media.cdn.cr/movie.webm?token=abc&ex=2000000000000';
 assert.equal(p.freshBunkrPlaybackUrl(video,1000),video.url);
});

test('Bunkr refreshes missing, invalid, expired, near-expiry and previously rejected links',()=>{
 const {p,video}=fixture();
 for(const suffix of ['', '?ex=oops','?ex=999','?ex=1060']) {
  video.url=`https://pc9.scdn.st/movie.mp4${suffix}`;
  assert.equal(p.freshBunkrPlaybackUrl(video,1000),'');
 }
 video.url='https://pc9.scdn.st/movie.mp4?ex=2000';
 video._failedBunkrUrl=video.url;
 assert.equal(p.freshBunkrPlaybackUrl(video,1000),'');
});

test('Bunkr fast path does not mistake pages, other hosts or other providers for reusable media',()=>{
 const {p,video}=fixture();
 for(const url of ['https://bunkr.cr/f/abc?ex=2000','https://pc9.scdn.st/player.html?ex=2000','https://cdn.example/movie.mp4?ex=2000']) {
  video.url=url;assert.equal(p.freshBunkrPlaybackUrl(video,1000),'');
 }
 video.url='https://pc9.scdn.st/movie.mp4?ex=2000';video.source_url='https://other.example/f/abc';
 assert.equal(p.freshBunkrPlaybackUrl(video,1000),'');
});
