const vm=require("node:vm"),fs=require("node:fs"),assert=require("node:assert/strict");
const listeners={},data={},tabs=[],groups=[],permits=[];
function event(name){return {addListener(fn){listeners[name]=fn;}};}
const lockState=new Map();
const locks={
 async request(name,options,callback){
  if(typeof options==="function"){callback=options;options={};}
  if(options.ifAvailable&&lockState.has(name))return callback(null);
  while(lockState.has(name))await lockState.get(name).promise;
  let release;const promise=new Promise(resolve=>release=resolve);lockState.set(name,{promise});
  try{return await callback({name});}finally{lockState.delete(name);release();}
 },
 async idle(){for(const name of [...lockState.keys()]){if(lockState.has(name))await lockState.get(name).promise;}}
};
const chrome={
 runtime:{onInstalled:event("installed"),onStartup:event("startup"),onMessage:event("message"),getURL:p=>"chrome-extension://test/"+p},
 storage:{local:{async set(v){Object.assign(data,JSON.parse(JSON.stringify(v)));},async get(){return JSON.parse(JSON.stringify(data));}}},
 alarms:{async create(name,options){data.alarm={name,options};},onAlarm:event("alarm")},
 contextMenus:{async removeAll(){},create(){},onClicked:event("context")},
 action:{async setBadgeText(v){data.badge=v.text;},async setBadgeBackgroundColor(){}},
 tabs:{async query(){return [];},async create(v){const t={...v,id:tabs.length+1};tabs.push(t);return t;},async group(v){groups.push(v);return 1;}},
 tabGroups:{async update(id,v){data.group=v;}},windows:{async update(){}}
};
const snapshot={items:[{url:"https://example.com"}],jobs:[{status:"running"}]};
let fail=false,deny=false;
async function fetch(url,options){
 if(fail)throw new Error("offline");
 if(url.endsWith("/open-slot")){
  permits.push(JSON.parse(options.body).url);
  if(deny)return {ok:false,text:async()=>"cooldown"};
 }
 return {ok:true,json:async()=>snapshot};
}
function worker(){
 const context=vm.createContext({chrome,URL,AbortSignal,navigator:{locks},fetch});
 vm.runInContext(fs.readFileSync("extension/background.js","utf8"),context);
 return context;
}
async function send(message){return new Promise(resolve=>listeners.message(message,{},resolve));}
(async()=>{
 worker();
 await listeners.installed();assert.equal(data.badge,"RUN");assert.equal(data.alarm.options.periodInMinutes,.5);
 fail=true;await listeners.alarm({name:"filester-sync"});assert.equal(data.online,false);assert.equal(data.snapshot.items.length,1);
 fail=false;
 const urls=Array.from({length:24},(_,i)=>"https://example.com/"+i);
 const response=await send({type:"openResults",urls:[...urls,urls[0],"javascript:alert(1)"]});
 assert.equal(response.ok,true);assert.equal(response.queued,true);assert.equal(response.count,24);
 await locks.idle();
 assert.equal(tabs.length,20);assert.equal(data.openQueue.index,20);assert.equal(data.openQueue.status,"queued");
 assert.equal(tabs[0].active,false);assert.equal(data.group.collapsed,true);
 // Resume the saved queue in a new worker; no in-memory progress is reused.
 worker();
 await listeners.alarm({name:"filester-sync"});
 assert.equal(tabs.length,24);assert.equal(data.openQueue.status,"completed");
 assert.equal(new Set(tabs.map(t=>t.url)).size,24);assert.equal(permits.length,24);
 deny=true;
 await send({type:"openResults",urls:["https://example.org/blocked"]});await locks.idle();
 assert.equal(data.openQueue.status,"paused");assert.equal(tabs.length,24);
 await send({type:"cancelOpen"});
 deny=false;
 await listeners.alarm({name:"filester-sync"});
 assert.equal(tabs.length,24);assert.equal(data.openQueue.status,"cancelled");
 console.log("PASS: offline cache, URL validation, deduplication, bounded batches, persistent queue after worker restart, permits, grouped tabs, cooldown pause and cancellation");
})().catch(e=>{console.error(e);process.exitCode=1;});

