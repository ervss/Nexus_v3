const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const split=fs.readFileSync('userscripts/nexus-universal-splitscreen.user.js','utf8');const suite=fs.readFileSync('userscripts/bunkr-suite.user.js','utf8');
const service= suite.slice(suite.indexOf('    const videoSrcCache = {};'),suite.indexOf('    const warmQueue = new Set()'));
const resolver=split.slice(split.indexOf('  const bunkrPending = new Map()'),split.indexOf('  async function resolveStreamUrl(item)'));
const doc=new EventTarget();doc.documentElement={dataset:{}};doc.head={querySelector:()=>true};doc.createElement=()=>({});
const common={URL,Map,Promise,Math,Date,Event,CustomEvent,setTimeout,clearTimeout,document:doc,location:{href:'https://bunkr.cr/a/album',origin:'https://bunkr.cr'},atob};
(async()=>{let calls=0;const helper=vm.createContext({...common,getVideoSrcUncached:async url=>{calls++;await new Promise(r=>setTimeout(r,20));return 'https://cdn.example/test.mp4?ex='+Math.floor(Date.now()/1000+600);}});vm.runInContext(service,helper);
const player=vm.createContext({...common,gmFetch:()=>{throw Error('Should reuse Helper, not call API again');}});vm.runInContext(resolver,player);
const [a,b,c]=await Promise.all([vm.runInContext("resolveBunkrDirect('https://bunkr.cr/f/abc')",player),vm.runInContext("resolveBunkrDirect('https://bunkr.cr/v/abc')",player),vm.runInContext("getVideoSrc('https://bunkr.cr/v/abc')",helper)]);assert.equal(calls,1);assert.equal(a,b);assert.equal(a,c);await vm.runInContext("resolveBunkrDirect('https://bunkr.cr/f/abc')",player);assert.equal(calls,1);
// Four resolver slots, even when many different files are requested at once.
let active=0,maxActive=0;helper.getVideoSrcUncached=async()=>{active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,10));active--;return 'https://cdn.example/bounded.mp4';};
await Promise.all(Array.from({length:12},(_,i)=>vm.runInContext(`getVideoSrc('https://bunkr.cr/f/bounded${i}')`,helper)));assert.equal(maxActive,4);
// Drift correction must leave independent/custom-speed video untouched.
let tick;const independent=[{syncLocked:false,video:{paused:false,readyState:4,currentTime:1,playbackRate:1.5}},{syncLocked:false,video:{paused:false,readyState:4,currentTime:2,playbackRate:2}}];
const drift=split.slice(split.indexOf('  function startDriftSyncEngine()'),split.indexOf('  // ---------------------------------------------------------------------------',split.indexOf('  function startDriftSyncEngine()')));
const driftCtx=vm.createContext({activeCells:independent,driftSyncTimer:null,clearInterval:()=>{},setInterval:fn=>{tick=fn;}});vm.runInContext(drift+';startDriftSyncEngine();',driftCtx);tick();assert.equal(independent[0].video.playbackRate,1.5);assert.equal(independent[1].video.playbackRate,2);
// Standalone canonical API and hourly XOR decode; no legacy /api/sign request.
const soloDoc={...doc,documentElement:{dataset:{}}};let apiCalls=0;const target='https://cdn.example/standalone.mp4?token=test';const ts=1792742400,key='SECRET_KEY_'+Math.floor(ts/3600);const encrypted=Buffer.from([...target].map((c,i)=>c.charCodeAt(0)^key.charCodeAt(i%key.length))).toString('base64');
const solo=vm.createContext({...common,document:soloDoc,gmFetch:async(url,opt)=>{apiCalls++;assert.equal(url,'https://bunkr.cr/api/vs');assert.deepEqual(JSON.parse(opt.body),{slug:'standalone'});return {ok:true,json:async()=>({url:encrypted,encrypted:true,timestamp:ts})};}});vm.runInContext(resolver,solo);assert.equal(await vm.runInContext("resolveBunkrDirect('https://bunkr.cr/f/standalone.mp4')",solo),target);assert.equal(apiCalls,1);
// Closing the player while resolution is pending cannot restart background video.
assert.match(split,/if \(!cellObj.element.isConnected \|\| !activeCells.includes\(cellObj\)\) return;/);
assert.ok(!split.includes('setInterval(updateFabCounter, 3000)'));
console.log('PASS: shared in-flight requests, /f-/v coalescing, resolved cache, canonical encrypted API, closed-player guard, no polling scan');
})().catch(e=>{console.error(e);process.exitCode=1;});
