const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function harness(pages, extra = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../fapfolder_grid_importer.js'), 'utf8');
  const marker = source.lastIndexOf("    if (document.readyState === 'loading') {");
  const calls = [];
  const window = {}; window.top = window;
  const more = {classList:{contains:()=>false}, hasAttribute:key=>['data-id','data-type'].includes(key),getAttribute:key=>({'data-id':'2528','data-type':'group'}[key]||null)};
  const ctx = {window,document:{querySelector:()=>null,querySelectorAll:()=>[]},localStorage:{getItem:()=>null},URL,URLSearchParams,Map,Set,AbortSignal,DOMException,
    setTimeout: fn=>setTimeout(fn,0), location:{origin:'https://fapfolder.club',hostname:'fapfolder.club',href:'https://fapfolder.club/ervssik/groups'},
    fetch:async(url,opts)=>{calls.push({url,...opts}); const value=pages.shift(); if(value instanceof Error) throw value; return {ok:true,url,json:async()=>value,text:async()=>JSON.stringify(value)};},
  };
  vm.runInNewContext(source.slice(0,marker)+`requestMetadata = item => auditMetadata(item); probeVideoMetadata = url => auditProbe(url); parseVideoPage = html => { const p=JSON.parse(html); return {items:(p.ids||[]).map(id=>({id:'posts:'+id})),more:p.more?fakeMore:null,doc:{title:'Thread test',querySelector:()=>({getAttribute:()=>null})}} }; window.helpers={normalizeSource,collectSource,state,auditSource,sourceAuditSummary}; })();`, {...ctx,fakeMore:more,auditMetadata:extra.metadata||(()=>({})),auditProbe:extra.probe||(()=>{throw new Error('No probe expected');})});
  return {...window.helpers,calls};
}
test('sources normalize tracking URLs and reject foreign hosts, invalid paths and schemes',()=>{
 const {normalizeSource}=harness([]);
 assert.equal(normalizeSource('/groups/Kitana/videos?ref=qs'),'https://fapfolder.club/groups/Kitana/videos');
 assert.equal(normalizeSource('/groups/Kitana'),'https://fapfolder.club/groups/Kitana/videos');
 assert.equal(normalizeSource('/ervssik/videos'),'https://fapfolder.club/ervssik/videos');
 assert.equal(normalizeSource('/posts/123?ref=x'),'https://fapfolder.club/posts/123');
 for(const url of ['https://evil.test/groups/a/videos','javascript:alert(1)','/ervssik/groups','/groups/a/unknown','http://fapfolder.club/groups/a']) assert.equal(normalizeSource(url),null);
});
test('full fetch follows every offset, deduplicates overlap, and only finishes on empty data',async()=>{
 const h=harness([{ids:[1,2],more:true},{data:JSON.stringify({ids:[2,3]})},{data:JSON.stringify({ids:[4]})},{data:false}]);
 const source={url:'https://fapfolder.club/groups/a/videos',name:'A'}; const ids=[];
 await h.collectSource(source,new AbortController().signal,async rows=>ids.push(...rows.map(r=>r.id)));
 assert.deepEqual(ids,['posts:1','posts:2','posts:3','posts:4']);
 assert.deepEqual(h.calls.slice(1).map(c=>new URLSearchParams(c.body).get('offset')),['1','2','3']);
 assert.ok(h.calls.every(c=>c.credentials==='include'));
 assert.ok(h.calls.slice(1).every(c=>new URLSearchParams(c.body).get('time')==='-1'));
 assert.match(source.status,/4.*kompletné/);
});
test('repeated page is incomplete instead of looping forever or claiming completion',async()=>{
 const h=harness([{ids:[1],more:true},{data:JSON.stringify({ids:[1]})}]);
 await assert.rejects(h.collectSource({url:'https://fapfolder.club/groups/a/videos'},new AbortController().signal,async()=>{}),/neúplný/);
 assert.equal(h.calls.length,2);
});
test('login callback is rejected and never executed',async()=>{
 const h=harness([{ids:[1],more:true},{callback:'throw new Error("EXECUTED")'}]);
 await assert.rejects(h.collectSource({url:'https://fapfolder.club/groups/a/videos'},new AbortController().signal,async()=>{}),/prihlásenie/);
});
test('cancellation stops before requesting another page',async()=>{
 const h=harness([{ids:[1],more:true}]); const controller=new AbortController();
 await assert.rejects(h.collectSource({url:'https://fapfolder.club/groups/a/videos'},controller.signal,async()=>controller.abort()),{name:'AbortError'});
 assert.equal(h.calls.length,1);
});
test('malformed pagination response cannot be reported as complete',async()=>{
 const h=harness([{ids:[1],more:true},{unexpected:true}]);
 await assert.rejects(h.collectSource({url:'https://fapfolder.club/groups/a/videos'},new AbortController().signal,async()=>{}),/Neočakávaná/);
});

test('a selected video thread resolves one canonical post without paging unrelated cards',async()=>{
 const h=harness([{ids:[999]}]); const rows=[]; const source={url:'https://fapfolder.club/posts/123',name:'Thread'};
 await h.collectSource(source,new AbortController().signal,async items=>rows.push(...items));
 assert.equal(rows.length,1); assert.equal(rows[0].id,'posts:123'); assert.equal(h.calls.length,1);
});

function auditJob() { return {url:'https://fapfolder.club/groups/a/videos',name:'A',controller:new AbortController(),items:new Map(),metrics:new Map(),listComplete:false,error:''}; }
test('card audit counts all pages, sums sizes and averages durations without probing known durations',async()=>{
 let probes=0;
 const h=harness([{ids:[1,2],more:true},{data:JSON.stringify({ids:[2,3]})},{data:false}],{metadata:async()=>({sizeMb:1024,duration:90,streamUrl:'https://cdn.test/video'}),probe:()=>{probes++;throw Error('unnecessary');}});
 const job=auditJob(); await h.auditSource(job);
 assert.equal(job.items.size,3); assert.equal(job.metrics.size,3); assert.equal(job.listComplete,true); assert.equal(probes,0);
 assert.match(h.sourceAuditSummary(job),/3 videí · 3 GB · priemer 1:30/);
});
test('unknown sizes and durations are excluded with explicit coverage; missing duration uses metadata-only probe',async()=>{
 const h=harness([{ids:[1,2,3]}],{metadata:async item=>item.id==='posts:1'?{sizeMb:1024,duration:60}:item.id==='posts:2'?{streamUrl:'media'}:{error:'unavailable'},probe:async()=>({duration:120})});
 const job=auditJob(); await h.auditSource(job);
 assert.match(h.sourceAuditSummary(job),/1 GB \(1\/3\).*priemer 1:30 \(2\/3\)/);
});
test('partial pagination never produces a falsely complete card count',async()=>{
 const h=harness([{ids:[1],more:true},{callback:'login()'}],{metadata:async()=>({sizeMb:1,duration:30})});
 const job=auditJob(); await h.auditSource(job);
 assert.equal(job.listComplete,false); assert.match(job.error,/prihlásenie/); assert.match(h.sourceAuditSummary(job),/^≥ 1 videí/);
});
test('stopped card audit does not start network requests',async()=>{
 const h=harness([]); const job=auditJob(); job.controller.abort(); await h.auditSource(job);
 assert.equal(job.phase,'stopped'); assert.equal(h.calls.length,0);
});
