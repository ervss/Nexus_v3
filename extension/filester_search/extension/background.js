const API = "http://127.0.0.1:8765";
async function sync() {
  try {
    await navigator.locks.request("filester-opened",async()=>{
      const {pendingOpened=[]}=await chrome.storage.local.get("pendingOpened");
      if(pendingOpened.length){
        const written=await fetch(API+"/opened",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({urls:pendingOpened}),signal:AbortSignal.timeout(10000)});
        if(written.ok) await chrome.storage.local.set({pendingOpened:[]});
      }
    });
    const r = await fetch(API+"/bridge", {signal: AbortSignal.timeout(10000)});
    if (!r.ok) throw new Error("HTTP "+r.status);
    const snapshot = await r.json();
    await chrome.storage.local.set({snapshot, online: true});
    const {openQueue}=await chrome.storage.local.get("openQueue");
    await chrome.action.setBadgeText({text: openQueue?.index<openQueue?.urls.length?"OPEN":snapshot.jobs.some(j=>["queued","running"].includes(j.status)) ? "RUN" : ""});
    await chrome.action.setBadgeBackgroundColor({color:"#19b9a5"});
  } catch(error) {
    await chrome.storage.local.set({online:false,lastError:error.message});
    await chrome.action.setBadgeText({text:"OFF"});
  }
}
async function enqueue(urls,windowId){
  return navigator.locks.request("filester-open-queue",async()=>{
    const {openQueue:old}=await chrome.storage.local.get("openQueue");
    const queue=old&&old.index<old.urls.length?old:{urls:[],index:0,windowId,status:"queued"};
    queue.urls=[...new Set([...queue.urls,...urls])];
    queue.status="queued";
    await chrome.storage.local.set({openQueue:queue,cancelOpenRequested:false});
    return queue.urls.length-queue.index;
  });
}
async function runOpenQueue(){
  await navigator.locks.request("filester-open-queue",{ifAvailable:true},async lock=>{
    if(!lock)return;
    let {openQueue:queue}=await chrome.storage.local.get("openQueue");
    if(!queue||queue.index>=queue.urls.length||queue.status==="cancelled")return;
    queue.status="opening";
    try{
      // Short batches; the durable alarm resumes the queue after worker suspension.
      for(let count=0;count<20&&queue.index<queue.urls.length;count++){
        if((await chrome.storage.local.get("cancelOpenRequested")).cancelOpenRequested){queue.status="cancelled";queue.urls=queue.urls.slice(0,queue.index);break;}
        const url=queue.urls[queue.index];
        const permit=await fetch(API+"/open-slot",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url}),signal:AbortSignal.timeout(12000)});
        if(!permit.ok)throw new Error((await permit.text()).slice(0,200));
        if((await chrome.storage.local.get("cancelOpenRequested")).cancelOpenRequested){queue.status="cancelled";queue.urls=queue.urls.slice(0,queue.index);break;}
        const tab=await chrome.tabs.create({url,active:false,...(queue.windowId?{windowId:queue.windowId}:{})});
        queue.index++;
        await navigator.locks.request("filester-opened",async()=>{
          const {pendingOpened=[]}=await chrome.storage.local.get("pendingOpened");
          await chrome.storage.local.set({openQueue:queue,pendingOpened:[...new Set([...pendingOpened,url])]});
        });
        try{
          if(queue.groupId!==undefined)await chrome.tabs.group({tabIds:[tab.id],groupId:queue.groupId});
          else queue.groupId=await chrome.tabs.group({tabIds:[tab.id]});
        }catch{queue.groupId=await chrome.tabs.group({tabIds:[tab.id]});}
        await chrome.tabGroups.update(queue.groupId,{title:"Filester · "+queue.index+"/"+queue.urls.length,color:"cyan",collapsed:true});
        await chrome.storage.local.set({openQueue:queue});
      }
      if(queue.status!=="cancelled")queue.status=queue.index>=queue.urls.length?"completed":"queued";
      queue.reason="";
    }catch(error){queue.status="paused";queue.reason=error.message;}
    await chrome.storage.local.set({openQueue:queue});
  });
  await sync();
}
async function dashboard() {
  const url=chrome.runtime.getURL("dashboard.html");
  const tabs=await chrome.tabs.query({url});
  if(tabs.length) {
    await chrome.tabs.update(tabs[0].id,{active:true});
    await chrome.windows.update(tabs[0].windowId,{focused:true});
  } else await chrome.tabs.create({url});
}
async function initialize() {
  await chrome.alarms.create("filester-sync",{periodInMinutes:0.5});
  await sync();
  await runOpenQueue();
}
chrome.runtime.onInstalled.addListener(async()=>{
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({id:"filester-selection",title:"Pridať do Filester dashboardu",contexts:["selection"]});
  await initialize();
});
chrome.runtime.onStartup.addListener(initialize);
chrome.alarms.onAlarm.addListener(async a=>{if(a.name==="filester-sync"){await sync();await runOpenQueue();}});
chrome.contextMenus.onClicked.addListener(async info=>{
  if(info.menuItemId!=="filester-selection") return;
  await chrome.storage.local.set({pendingKeyword:(info.selectionText||"").trim()});
  await dashboard();
});
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  (async()=>{
    if(m.type==="dashboard") await dashboard();
    else if(m.type==="sync") await sync();
    else if(m.type==="openResults"){
      const urls=[...new Set(m.urls||[])].filter(u=>{try{return ["http:","https:"].includes(new URL(u).protocol);}catch{return false;}});
      const count=await enqueue(urls,sender.tab?.windowId);
      reply({ok:true,queued:true,count});
      await runOpenQueue();
      return;
    } else if(m.type==="cancelOpen"){
      await chrome.storage.local.set({cancelOpenRequested:true});
      await navigator.locks.request("filester-open-queue",{ifAvailable:true},async lock=>{
        if(!lock)return;
        const {openQueue}=await chrome.storage.local.get("openQueue");
        if(openQueue){openQueue.status="cancelled";openQueue.urls=openQueue.urls.slice(0,openQueue.index);await chrome.storage.local.set({openQueue});}
      });
    }
    reply({ok:true});
  })().catch(e=>reply({ok:false,error:e.message}));
  return true;
});
