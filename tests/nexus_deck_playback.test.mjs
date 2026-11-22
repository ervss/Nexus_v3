import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createApi} from '../extensions/Nexus_Deck/lib/api.js';

function setup(resolvePlayback) {
  const nodes = new Map();
  class Node extends EventTarget {
    constructor() {super();this.style={};this.classList={toggle(){},contains(){return false;},add(){},remove(){}};this.attributes={};this.currentTime=0;this.duration=100;this.readyState=0;this.paused=true;this.options=[];}
    setAttribute(k,v){this.attributes[k]=v;}
    removeAttribute(k){delete this.attributes[k];if(k==='src')this.src='';}
    getAttribute(k){return k==='src'?this.src:this.attributes[k];}
    replaceChildren(...v){this.options=v;}
    append(){} add(v){this.options.push(v);} matches(){return false;}
    pause(){this.paused=true;} load(){this.currentTime=0;this.readyState=0;} async play(){this.paused=false;}
  }
  const get=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
  const statuses=[], hlsInstances=[];
  class Hls {
    static Events={MANIFEST_PARSED:'manifest',LEVEL_SWITCHED:'level',ERROR:'error'};
    static ErrorTypes={MEDIA_ERROR:'media',NETWORK_ERROR:'network'};
    static isSupported(){return true;}
    constructor(){this.events={};hlsInstances.push(this);} on(e,f){this.events[e]=f;}
    loadSource(s){this.source=s;} attachMedia(){} destroy(){this.destroyed=true;} recoverMediaError(){this.recovered=true;}
  }
  const context=vm.createContext({document:{getElementById:get,querySelectorAll:()=>[],createElement:()=>new Node(),addEventListener(){}},window:{addEventListener(){}},localStorage:{getItem:()=>null,setItem(){}},Option:class{constructor(t,v){this.text=t;this.value=v;}},setTimeout:()=>1,clearTimeout(){},cancelAnimationFrame(){},Hls});
  vm.runInContext(readFileSync(new URL('../extensions/Nexus_Deck/lib/player.js',import.meta.url),'utf8').replace('export function','function'),context);
  const player=context.createDeckPlayer({resolvePlayback,onStep(){},onHistorySelect(){},onStatus:m=>statuses.push(m)});
  return {player,video:get('player-video'),statuses,hlsInstances};
}
const flush=()=>new Promise(r=>setImmediate(r));
const item={id:'1',title:'Test',url:'https://bunkr.cr/f/test',playUrl:'http://localhost/old.mp4',isHls:false};

test('failed MP4 resolves once, switches to HLS and restores position',async()=>{
  let calls=0;
  const s=setup(async old=>{calls++;return {...old,isHls:true,playUrl:'http://localhost/hls_proxy?url=fresh'};});
  await s.player.load(item);s.video.currentTime=31;s.video.dispatchEvent(new Event('error'));await flush();
  assert.equal(calls,1);assert.equal(s.hlsInstances.length,1);
  s.video.duration=100;s.video.dispatchEvent(new Event('loadedmetadata'));assert.equal(s.video.currentTime,31);
  s.hlsInstances[0].events.error(null,{fatal:true,type:'network'});await flush();
  assert.equal(calls,1);assert.match(s.statuses.at(-1),/zlyhalo/);
});
test('late resolver cannot replace next video or restart after stop',async()=>{
  let finish;const s=setup(()=>new Promise(r=>finish=r));
  await s.player.load(item);s.video.dispatchEvent(new Event('error'));
  await s.player.load({...item,id:'2',playUrl:'http://localhost/next.mp4'});
  finish({...item,playUrl:'http://localhost/stale.mp4'});await flush();assert.equal(s.player.current.id,'2');
  s.video.dispatchEvent(new Event('error'));s.player.stop();finish(item);await flush();assert.equal(s.player.current,null);assert.equal(s.video.src,'');
});
test('duplicate errors do not duplicate resolution; direct retry is bounded',async()=>{
  let calls=0;const s=setup(async old=>{calls++;return {...old,directFallback:'https://cdn.test/fresh.mp4'};});
  await s.player.load(item);s.video.dispatchEvent(new Event('error'));s.video.dispatchEvent(new Event('error'));await flush();
  s.video.dispatchEvent(new Event('error'));await flush();assert.equal(s.video.src,'https://cdn.test/fresh.mp4');assert.equal(s.video.getAttribute('crossorigin'),undefined);
  s.video.dispatchEvent(new Event('error'));await flush();assert.equal(calls,1);assert.match(s.statuses.at(-1),/zlyhalo/);
});
test('resolver error is visible and healthy media clears loading status',async()=>{
  const s=setup(async()=>{throw new Error('HTTP 503');});await s.player.load(item);s.video.dispatchEvent(new Event('error'));await flush();
  assert.match(s.statuses.at(-1),/HTTP 503/);await s.player.load(item);s.video.dispatchEvent(new Event('canplay'));assert.equal(s.statuses.at(-1),'');
});

test('multiple providers share resolver; HLS and cookie sessions use correct proxy',async()=>{
  const original=globalThis.fetch;
  try {
    const api=createApi(async()=>({apiBase:'http://127.0.0.1:8000',token:'test'}));
    for (const [provider,hls,session] of [['bunkr',false,''],['filester',false,''],['pixeldrain',false,''],['gofile',false,''],['pornhub',true,'cookie-session'],['xvideos',true,''],['eporner',false,'']]) {
      globalThis.fetch=async(url,options)=>{assert.match(url,/stream\/resolve\/1$/);assert.equal(options.headers['X-Nexus-Token'],'test');return {ok:true,json:async()=>({supported:true,stream_url:'https://cdn.test/media',is_hls:hls,proxy_session:session})};};
      const result=await api.resolvePlayback({...item,url:`https://${provider}.test/watch`});
      assert.equal(result.isHls,hls);assert.match(result.playUrl,hls||session?/hls_proxy/:/stream_proxy/);
      assert.equal(new URL(result.playUrl).searchParams.get('url'),'https://cdn.test/media');
      if(session)assert.equal(new URL(result.playUrl).searchParams.get('session'),session);
    }
  } finally {globalThis.fetch=original;}
});
test('Lite and local media skip extraction; MEGA uses decrypted stream',async()=>{
  const api=createApi(async()=>({apiBase:'http://localhost:8000'}));
  assert.equal(await api.resolvePlayback({...item,apiMode:'lite'}).then(r=>r.playUrl),item.playUrl);
  assert.equal(await api.resolvePlayback({...item,storageType:'local_direct'}).then(r=>r.playUrl),item.playUrl);
  assert.match((await api.resolvePlayback({...item,storageType:'mega'})).playUrl,/mega\/stream\/1$/);
});
