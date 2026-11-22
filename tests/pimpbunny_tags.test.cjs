const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const stored = new Map();
const context = { window:{}, URL, AbortController, Date, setTimeout, clearTimeout,
  sessionStorage:{getItem:key=>stored.get(key),setItem:(key,value)=>stored.set(key,value)} };
vm.runInNewContext(fs.readFileSync('extensions/nexus-video-selector/pimpbunny-listing.js','utf8'),context);
const api = context.window.NVSPimpBunnyListing;
const base = 'https://pimpbunny.com/videos/sample/';
const anchor = href => ({getAttribute:()=>href});
const doc = paths => ({querySelectorAll:()=>[{querySelectorAll:()=>paths.map(anchor)}]});
const detail = () => doc(['/tags/Deep-Throat/','/categories/blowjob/','/tags/deep-throat/','https://evil.test/tags/navigation/','/tags/']);

test('reads only the video tag containers and merges canonical category/tag slugs', () => {
  let selector;
  const scoped = {querySelectorAll(value){selector=value;return detail().querySelectorAll();}};
  assert.equal(JSON.stringify(api.tagsFromDocument(scoped,base)),JSON.stringify(['deep-throat','blowjob']));
  assert.equal(selector,'[class*="pages-view-video-categories"]');
  assert.throws(()=>api.tagsFromDocument({querySelectorAll:()=>[]},base),/nenašla/);
  assert.equal(api.tagsFromDocument(doc([]),base).length,0);
});

test('loader limits concurrency, deduplicates URL identity and retries only failures', async () => {
  stored.clear(); let active=0, peak=0, attempts=0, fail=true;
  const loader = api.createTagLoader({parse:detail,fetch:async url=>{
    attempts++;active++;peak=Math.max(peak,active); await new Promise(r=>setTimeout(r,5));active--;
    return {ok:!(fail && url.includes('clip-2')),url,text:async()=>'<detail>'};
  }});
  const urls = Array.from({length:7},(_,i)=>`https://pimpbunny.com/videos/clip-${i}/`);
  const outcome = await loader.load([...urls,urls[0]+'?tracking=1']);
  assert.equal(peak,3);assert.equal(attempts,7);assert.equal(outcome.errors,1);assert.equal(loader.get(urls[0]).fetched,true);
  assert.equal(loader.get(urls[2]).fetched,false);
  fail=false;const retried=await loader.load(urls);assert.equal(attempts,8);assert.equal(retried.total,1);assert.equal(retried.errors,0);
  const restored = api.createTagLoader();assert.equal(restored.get(urls[2]).fetched,true);
});

test('stop aborts in-flight work, retains loaded cache and permits a later retry', async () => {
  stored.clear(); let started=0;
  const loader = api.createTagLoader({parse:detail,fetch:async(url,options)=>{
    started++;return await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted'))));
  }});
  const urls=Array.from({length:6},(_,i)=>`https://pimpbunny.com/videos/stoppable-${i}/`);
  const pending=loader.load(urls);assert.equal(started,3);
  assert.equal((await loader.load(urls)).busy,true);
  loader.stop();const result=await pending;assert.equal(result.stopped,true);assert.equal(result.active,false);assert.equal(result.errors,0);assert.equal(started,3);
});

test('redirected/challenge pages are not cached as videos with zero tags', async () => {
  stored.clear();
  const loader=api.createTagLoader({parse:()=>({querySelectorAll:()=>[]}),fetch:async()=>({ok:true,url:'https://pimpbunny.com/login/',text:async()=>''})});
  assert.equal((await loader.load([base])).errors,1);assert.equal(loader.get(base).fetched,false);
});

test('comma-separated tag filters require all terms and never treat unloaded tags as matches', () => {
  const ctx={window:{},Date};vm.runInNewContext(fs.readFileSync('extensions/nexus-video-selector/import-workbench.js','utf8'),ctx);
  const model=ctx.window.NVSWorkbenchModel,f={...model.defaults(),tagFilter:'deep throat, blowjob',unknown:true};
  assert.equal(model.matches({title:'Sample',tags:['deep-throat','blowjob']},f),true);
  assert.equal(model.matches({title:'Sample',tags:['deep-throat']},f),false);
  assert.equal(model.matches({title:'Sample'},f),false);
});

test('background import strips extension markers and removes duplicate video tags', async () => {
  const bg=fs.readFileSync('extensions/nexus-video-selector/background.js','utf8');let body;
  const ctx={chrome:{storage:{local:{get:async()=>({})}}},AbortSignal,fetch:async(url,options)=>{if(options?.body)body=JSON.parse(options.body);return {ok:true,status:200,text:async()=>'{"results":[]}'};}};
  vm.createContext(ctx);vm.runInContext(bg.slice(bg.indexOf('async function importToNexus('),bg.indexOf('// ── Message handler',bg.indexOf('async function importToNexus('))),ctx);
  await ctx.importToNexus('8000',[{url:base,tags:['deep-throat','blowjob','deep-throat','extension',null]}],'Tags',true);
  assert.equal(body.videos[0].tags,'deep-throat,blowjob');
});
