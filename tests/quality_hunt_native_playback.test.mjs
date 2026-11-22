import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../extensions/Nexus_Gallery/universal_importer.js',import.meta.url),'utf8');
function setup(resolver=async()=>({ok:false})) {
 const owner={}, frame={style:{}}, modal={hidden:false,_huntContainer:owner,_activeCard:{},querySelector:()=>frame}, status={};
 const urls=[], messages=[];
 const video={style:{},readyState:0,pause(){},removeAttribute(){},load(){},play:async()=>{}};
 Object.defineProperty(video,'src',{set:url=>urls.push(url)});
 const context=vm.createContext({setTimeout:()=>1,clearTimeout(){},isHls:u=>u.includes('.m3u8'),
  huntMessage:async m=>{messages.push(m);return resolver(m);},huntPlaybackUrl:(_o,u)=>'http://localhost/proxy?'+u,
  isPlayableFile:u=>/\.(mp4|webm|m3u8)([/?#]|$)/i.test(u),ensureHuntFrame:()=>frame,
  renderHuntModalList(){}, renderHuntWorkbenchState(){}, reportHuntPlayback(){}});
 context.URL=URL;
 vm.runInContext(source.slice(source.indexOf('    function renderHuntComparisonSizes('),source.indexOf('    async function playHuntOriginal(')),context);
 context.formatSize=bytes=>bytes>0?`${(bytes/1048576).toFixed(1)} MB`:null;
 return {owner,modal,status,video,frame,urls,messages,context};
}
test('embed fallback uses the source player instead of feeding HTML to a video',async()=>{
 const s=setup();
 await s.context.loadHuntMedia(s.owner,s.modal,s.video,s.status,'https://player.test/e/abc','https://site.test/watch',false);
 assert.equal(s.frame.src,'https://player.test/e/abc');
 assert.equal(s.video.style.display,'none');
 assert.equal(s.urls.length,0);
 assert.match(s.status.textContent,/nie sú overené/);
});
test('refresh can switch failed media to an embed without a media proxy',async()=>{
 const s=setup(async()=>({ok:true,streamUrl:'https://player.test/embed/abc'}));
 await s.context.loadHuntMedia(s.owner,s.modal,s.video,s.status,'https://cdn.test/old.mp4','https://site.test/watch',false);
 s.video.onerror(); await new Promise(r=>setImmediate(r));
 assert.equal(s.frame.src,'https://player.test/embed/abc');
 assert.equal(s.urls.length,1);
 assert.equal(s.context.huntEmbedStream('https://cdn.test/e/video.mp4','https://site.test/watch',false),false);
 assert.equal(s.context.huntEmbedStream('https://cdn.test/e/manifest','https://site.test/watch',true),false);
});
test('comparison starts native media; resolver URLs need no file suffix',async()=>{
 const s=setup(); await s.context.loadHuntMedia(s.owner,s.modal,s.video,s.status,'https://cdn.test/stream/123','https://site.test/watch',false);
 assert.deepEqual(s.urls,['https://cdn.test/stream/123']);
 assert.equal(s.messages[0].action,'QUALITY_HUNT_ARM');
});
test('an expired stream is refreshed before trying the proxy',async()=>{
 const s=setup(async m=>({ok:true,streamUrl:m.refresh?'https://cdn.test/fresh.mp4':undefined}));
 await s.context.loadHuntMedia(s.owner,s.modal,s.video,s.status,'https://cdn.test/old.mp4','https://site.test/watch',false);
 s.video.onerror(); await new Promise(r=>setImmediate(r));
 assert.deepEqual(s.urls,['https://cdn.test/old.mp4','https://cdn.test/fresh.mp4']);
 assert.equal(s.messages[1].refresh,true);
 s.video.onerror(); await new Promise(r=>setImmediate(r));
 assert.equal(s.urls[2],'http://localhost/proxy?https://cdn.test/fresh.mp4');
});
test('closing or selecting another candidate invalidates pending refresh',async()=>{
 let finish;const s=setup(m=>m.refresh?new Promise(r=>finish=r):Promise.resolve({ok:true}));
 await s.context.loadHuntMedia(s.owner,s.modal,s.video,s.status,'https://cdn.test/old.mp4','https://site.test/watch',false);
 s.video.onerror();s.video._huntToken++;finish({ok:true,streamUrl:'https://cdn.test/stale.mp4'});
 await new Promise(r=>setImmediate(r));assert.equal(s.urls.length,1);
});
test('a failed highest rendition tries another quality from the same page',async()=>{
 const s=setup(async()=>({ok:true,streamUrl:'https://cdn.test/high.mp4',alternatives:['https://cdn.test/low.mp4']}));
 await s.context.loadHuntMedia(s.owner,s.modal,s.video,s.status,'https://cdn.test/high.mp4','https://site.test/watch',false);
 s.video.onerror();await new Promise(r=>setImmediate(r));
 assert.equal(s.urls[1],'https://cdn.test/low.mp4');
});
test('original stream does not replace candidate request headers',async()=>{
 const s=setup();await s.context.loadHuntMedia(s.owner,s.modal,s.video,s.status,'https://cdn.test/original.mp4','https://site.test/watch',false,true);
 assert.equal(s.messages.length,0);assert.equal(s.urls.length,1);
});

test('CamWhores error MP4 is refreshed without reporting playback or corrupting metadata',async()=>{
 const s=setup(async()=>({ok:true,streamUrl:'https://www.camwhores.tv/get_file/fresh.mp4'}));
 const reports=[];s.context.reportHuntPlayback=(_modal,outcome)=>reports.push(outcome);
 s.modal._activeCard={height:1080,duration_sec:957,size_bytes:9000000};
 await s.context.loadHuntMedia(s.owner,s.modal,s.video,s.status,'https://www.camwhores.tv/get_file/old.mp4','https://www.camwhores.tv/videos/123/clip/',false);
 Object.assign(s.video,{videoWidth:544,videoHeight:408,duration:19.966667});
 s.video.onloadedmetadata();s.video.onplaying();await new Promise(r=>setImmediate(r));
 assert.equal(s.messages.find(m=>m.action==='QUALITY_HUNT_RESOLVE').refresh,true);
 assert.equal(s.urls[1],'https://www.camwhores.tv/get_file/fresh.mp4');
 assert.deepEqual(reports,[]);
 assert.equal(s.modal._activeCard.height,1080);assert.equal(s.modal._activeCard.duration_sec,957);
 assert.equal(s.context.huntCamwhoresErrorVideo({...s.video,videoHeight:1080},'https://www.camwhores.tv/videos/123/'),false);
 assert.equal(s.context.huntCamwhoresErrorVideo(s.video,'https://other.test/video'),false);
});

test('comparison sizes display both files and clear an unknown selected size',()=>{
 const s=setup(), original={}, candidate={};
 s.modal.querySelector=selector=>selector.includes('original-size')?original:selector.includes('candidate-size')?candidate:null;
 s.owner._huntPayload={size_bytes:10485760};s.modal._activeCard={size_bytes:20971520};
 s.context.renderHuntComparisonSizes(s.owner,s.modal);
 assert.equal(original.textContent,'Veľkosť: 10.0 MB');assert.equal(candidate.textContent,'Veľkosť: 20.0 MB');
 s.modal._activeCard.size_bytes=0;s.context.renderHuntComparisonSizes(s.owner,s.modal);
 assert.equal(candidate.textContent,'Veľkosť neznáma');
});
test('library streams already wrapped in the local proxy try their upstream first',async()=>{
 const s=setup();await s.context.loadHuntMedia(s.owner,s.modal,s.video,s.status,'http://127.0.0.1:8000/media_proxy.mp4?url=https%3A%2F%2Fcdn.test%2Fmedia.mp4','https://site.test/watch',false);
 assert.equal(s.urls[0],'https://cdn.test/media.mp4');
 assert.equal(s.context.huntNativeStream(s.owner,'https://remote.test/media_proxy.mp4?url=https%3A%2F%2Fcdn.test%2Fmedia.mp4'),'https://remote.test/media_proxy.mp4?url=https%3A%2F%2Fcdn.test%2Fmedia.mp4');
});
test('scanner cannot replace the page reference with comparison players',()=>{
 const media=(own,area)=>({dataset:{},closest:selector=>own&&selector.includes('.nexus-hunt-modal')?{}:null,
   getBoundingClientRect:()=>({width:area,height:area}),videoWidth:area,videoHeight:area});
 const pageVideo=media(false,500),comparisonVideo=media(true,1000);
 const context=vm.createContext({_manualVideo:null,document:{querySelectorAll:()=>[comparisonVideo,pageVideo]},isLenientMediaPage:()=>false,
   isLikelyHoverPreviewVideo:()=>false,MIN_WIDTH_PX:100,MIN_HEIGHT_PX:100});
 const start=source.indexOf('    function getBestVideo(');
 vm.runInContext(source.slice(start,source.indexOf('    // Direct MP4',start)),context);
 assert.equal(context.getBestVideo(),pageVideo);
});
test('an old original-video resolution cannot revive playback after modal close',async()=>{
 let resolve;
 let plays=0;
 const video={_huntToken:0,readyState:0,error:null,_huntSource:'',currentSrc:'',src:''};
 const modal={hidden:false,_huntContainer:null,querySelector:selector=>selector.includes('status')?{textContent:''}:video};
 const container={_boundVideo:video,_huntRun:1,_huntPayload:{page_url:'https://site.test/watch'}};
 modal._huntContainer=container;
 const context=vm.createContext({isHls:()=>false,resolveDirectUrl:()=>new Promise(r=>resolve=r),
  huntMessage:async()=>({}),loadHuntMedia:async()=>{plays++;},location:{href:'https://site.test/watch'}});
 const start=source.indexOf('    async function playHuntOriginal(');
 vm.runInContext(source.slice(start,source.indexOf('    function reportHuntPlayback(',start)),context);
 const pending=context.playHuntOriginal(container,modal);
 modal.hidden=true;video._huntToken++;
 resolve('https://cdn.test/late.mp4');await pending;
 assert.equal(plays,0);
});
