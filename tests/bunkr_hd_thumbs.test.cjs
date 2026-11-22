const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('userscripts/bunkr-suite.user.js','utf8').replace(/\r\n/g,'\n');
const storyboardStart=source.indexOf('    async function fetchStoryboardUrl(');
const storyboardEnd=source.indexOf('    // Hover Preview',storyboardStart);
assert.ok(storyboardStart>=0 && storyboardEnd>storyboardStart,'storyboard helper section should be present');
const storyboard=source.slice(storyboardStart,storyboardEnd);
const queue=source.slice(source.indexOf('    const hdUpgradeQueue = []'),source.indexOf('    // Missing Bunkr contact sheets'));
(async()=>{
let requests=0;const cached={video:null};
const c=vm.createContext({normalizeCacheKey:()=> 'video',storyboardCache:cached,STORYBOARD_TTL:600000,Date,saveStoryboardCache:()=>{},bridgeFetch:async()=>{requests++;return {ok:true,text:async()=>`<script>var videoCoverUrl = "https:\\/\\/cdn.example\\/sheet.png";</script>`};}});
vm.runInContext(storyboard,c);assert.equal(await vm.runInContext("fetchStoryboardUrl('video')",c),'https://cdn.example/sheet.png');assert.equal(requests,1,'a cached failure must not suppress a new fetch');await vm.runInContext("fetchStoryboardUrl('video',true)",c);assert.equal(requests,2,'manual action must invalidate prior storyboard result');
const makeCard=()=>{const classes=new Set();return {isConnected:true,dataset:{},classList:{contains:x=>classes.has(x),add:x=>classes.add(x)}};};
const card=makeCard();let notice='';const q=vm.createContext({document:{querySelector:()=>({textContent:''})},state:{hdMode:'2x2'},normalizeCacheKey:x=>x,storyboardCache:{},fetchStoryboardUrl:async()=> 'missing.png',applyHdThumb:async()=>false,captureHdFrames:async()=>false,toast:msg=>notice=msg,console,card});vm.runInContext(queue,q);await vm.runInContext("hdProgress={total:1,done:0,ok:0,failed:0};hdQueued.add(card);hdUpgradeQueue.push({el:card,url:'video',manual:true});runHdUpgradeQueue();",q);assert.equal(card.dataset.bahHdDone,undefined);assert.equal(card.dataset.bahHdState,'failed');assert.match(notice,/0 načítaných · 1 nedostupných/);
q.captureHdFrames=async el=>{el.classList.add('bah-hd-done');return true;};await vm.runInContext("hdProgress={total:1,done:0,ok:0,failed:0};hdQueued.add(card);hdUpgradeQueue.push({el:card,url:'video',manual:true});runHdUpgradeQueue();",q);assert.equal(card.dataset.bahHdDone,'1');assert.equal(card.dataset.bahHdState,'ready');assert.match(notice,/1 načítaných · 0 nedostupných/);
console.log('PASS: failed cache retries, manual refresh, image failure, fallback success, accurate progress and success-only completion');
})().catch(e=>{console.error(e);process.exitCode=1;});
