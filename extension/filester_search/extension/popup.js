document.getElementById("dashboard").addEventListener("click",async()=>{
 try {const r=await chrome.runtime.sendMessage({type:"dashboard"});if(r.ok) window.close();else throw new Error(r.error);}
 catch(e){document.getElementById("status").textContent=e.message;}
});
async function refresh(){
 const {snapshot,online}=await chrome.storage.local.get(["snapshot","online"]);
 const active=(snapshot?.jobs||[]).filter(j=>["running","queued"].includes(j.status)).length;
 document.getElementById("status").textContent=(online?"● Online":"○ Offline · cache dostupná")+" · "+(snapshot?.items?.length||0)+" výsledkov · "+active+" úloh";
}
chrome.storage.onChanged.addListener(refresh);
refresh();
chrome.runtime.sendMessage({type:"sync"}).catch(e=>{document.getElementById("status").textContent=e.message;});
