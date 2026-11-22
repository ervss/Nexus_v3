const $=id=>document.getElementById(id);
const extension=location.protocol==="chrome-extension:";
const API="http://127.0.0.1:8765";
let state={items:[],jobs:[],history:[],collections:[]},view="current",selected=new Set(),shown=100,online=false,jobFilter=null,jobKeywords=null,collectionFilter=null,activeCollectionId=null,busy=false,lastStartedJob=null,activeJobId=null;
const metadataRequests=new Map();
let reviewVideos=[],reviewSelected=new Set(),reviewFolders=[],reviewLoading=false,reviewImporting=false,reviewAudits=[];
let metadataObserver;
let playerQueue=[],playerIndex=-1,playerSession=0,playerReturnFocus=null;
const message=text=>$("message").textContent=text;
async function api(path,body,method,timeout=15000){
 const r=await fetch(API+path,{method:method||(body?"POST":"GET"),headers:body?{"Content-Type":"application/json"}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(timeout)});
 if(!r.ok) throw new Error((await r.text()).slice(0,300));
 return r.json();
}
async function cacheRead(){
 if(extension) return (await chrome.storage.local.get("snapshot")).snapshot;
 try{return JSON.parse(localStorage.getItem("filesterSnapshot"));}catch{return null;}
}
async function cacheWrite(){
 if(extension) await chrome.storage.local.set({snapshot:state,online});
 else try{localStorage.setItem("filesterSnapshot",JSON.stringify(state));}catch{message("Cache prehliadača je plná. Dáta zostávajú na serveri.");}
}
async function refresh(){
 if(busy)return;
 busy=true;
 try{
  state=await api("/bridge");online=true;
  if(view==="current"||view==="job"){
   if(view==="current")activeJobId=state.jobs[0]?.job_id||null;
   const result=activeJobId?await api("/jobs/"+encodeURIComponent(activeJobId)+"/results?limit=100000"):null;
   jobFilter=new Set((result?.items||[]).map(item=>item.url));jobKeywords=[];
  }
  await cacheWrite();
 }
 catch(e){online=false;message("Server nedostupný. Zobrazujem uložené výsledky; spusti Filester Search na ploche.");}
 finally{if(extension)state.openQueue=(await chrome.storage.local.get("openQueue")).openQueue;busy=false;render();}
}
function element(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function button(text,action){const b=element("button",text);b.type="button";b.addEventListener("click",async()=>{try{await action();}catch(e){message(e.message);}});return b;}
function ensureReviewRefreshButton(){
 if($("refreshReviewMetadata"))return;
 const refresh=button("Obnoviť metadata a náhľady",()=>refreshReviewMetadata());
 refresh.id="refreshReviewMetadata";refresh.className="retry-missing";refresh.disabled=true;
 $("videoSelectAll").after(refresh);
}
function ensureRefreshButtons(){
 if($("refreshSelected"))return;
 const selected=button("Obnoviť vybrané (0)",()=>{
  const ids=selectedItems().map(item=>item.parentUrl||item.url).map(url=>state.items.find(folder=>folder.url===url)?.folder_id);
  return startFolderRefresh(ids,"vybraných priečinkov");
 });
 selected.id="refreshSelected";selected.disabled=true;
 const index=button("Obnoviť celý index",()=>startFolderRefresh(state.items.map(item=>item.folder_id),"celého indexu"));
 index.id="refreshIndex";index.title="Znova načíta všetky priečinky z lokálneho indexu";
 $("openAll").before(selected,index);
}
function safeUrl(url){try{return ["http:","https:"].includes(new URL(url).protocol);}catch{return false;}}
function formatBytes(bytes){
 const units=["B","KB","MB","GB","TB"];let value=bytes,index=0;
 while(value>=1024&&index<units.length-1){value/=1024;index++;}
 return new Intl.NumberFormat("sk-SK",{maximumFractionDigits:1}).format(value)+" "+units[index];
}
function folderSize(item){
 const metadata=listValue(item.file_meta);
 const sized=metadata.filter(file=>file&&Number.isFinite(Number(file.size))&&Number(file.size)>0);
 if(!sized.length)return "veľkosť neznáma";
 const bytes=sized.reduce((total,file)=>total+Number(file.size),0);
 const complete=Number(item.file_count)>0&&sized.length>=Number(item.file_count);
 return (complete?"veľkosť ":"známe aspoň ")+formatBytes(bytes)+(complete?"":" · "+sized.length+" z "+(item.file_count||"?")+" súborov");
}
function fileNames(item){
 return [...new Set([...listValue(item.filenames),...listValue(item.file_meta).map(file=>file?.name)].filter(Boolean).map(String))];
}
function normalized(value){return String(value||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLocaleLowerCase();}
function fileKind(name){
 const ext=(String(name).match(/\.([a-z0-9]{2,8})(?:$|[?#])/i)||[])[1]?.toLowerCase();
 if(["mp4","mkv","avi","mov","wmv","webm","m4v","mpeg","mpg","3gp","ts"].includes(ext))return "video";
 if(["jpg","jpeg","png","gif","webp","bmp","avif","heic"].includes(ext))return "image";
 if(["zip","rar","7z","tar","gz","bz2","iso"].includes(ext))return "archive";
 return "other";
}
function isVideoFile(file){return fileKind(file?.name)==="video"||/video/i.test(String(file?.type||""));}
function fileEntries(item){
 const metadata=listValue(item.file_meta),byName=new Map(metadata.filter(file=>file?.name).map(file=>[normalized(file.name),file]));
 return fileNames(item).map(name=>byName.get(normalized(name))||{name,size:0,type:"",date:"",slug:"",thumb_id:""});
}
function videoResult(parent,file){
 const videoUrl=file.slug?"https://filester.me/d/"+encodeURIComponent(file.slug):"";
 return {...parent,resultType:"video",fileName:file.name,parentUrl:parent.url,parentTitle:parent.title||parent.folder_id,
  videoUrl,url:videoUrl||parent.url,selectionKey:"video:"+parent.url+":"+(file.slug||normalized(file.name)),
  filenames:[file.name],file_meta:[file],thumb_ids:file.thumb_id?[file.thumb_id]:[],file_count:1,out_degree:0};
}
function knownBytes(item){return listValue(item.file_meta).reduce((sum,file)=>sum+(Number(file?.size)>0?Number(file.size):0),0);}
function numericBound(id){const value=$(id).value.trim();if(value==="")return null;const parsed=Number(value);return Number.isFinite(parsed)&&parsed>=0?parsed:null;}
function metadataCoverage(item){return Number(item.file_count)>0?Math.min(1,listValue(item.file_meta).filter(file=>file&&Number(file.size)>0).length/Number(item.file_count)):0;}
function qualityScore(item){
 const ageDays=Math.max(0,(Date.now()/1000-Number(item.last_seen||0))/86400);
 const files=Number(item.file_count)||0,subfolders=Number(item.out_degree)||0;
 const previewBonus=files?Math.min(listValue(item.thumb_ids).length,4)*6:0;
 return (Number(item.relevance)||0)*100+metadataCoverage(item)*45+previewBonus+
  (files?30:-30)+Math.min(files,100)*.2-Math.min(subfolders,100)*.5+Math.max(0,12-ageDays/30);
}
function duplicateKey(item){
 const thumbs=[...new Set(listValue(item.thumb_ids).filter(Boolean))].sort();
 if(thumbs.length>=4)return "thumbs:"+thumbs.join("|");
 const names=fileNames(item).map(normalized).filter(Boolean).sort();
 if(Number(item.file_count)>=4&&names.length>=Number(item.file_count))return "files:"+names.join("|");
 return "";
}
function loadFolderMetadata(item){
 const id=item.folder_id;
 if(!id||! /^[a-f\d]{8,64}$/i.test(id)||(metadataRequests.get(id)||0)>Date.now())return;
 metadataRequests.set(id,Date.now()+60000);
 api("/folder-metadata",{folder_id:id}).then(async metadata=>{
  item.file_meta=metadata.file_meta||[];item.thumb_ids=metadata.thumb_ids||[];
  if(metadata.file_count)item.file_count=metadata.file_count;
  await cacheWrite();renderResults();
 }).catch(()=>{});
}
function observeMetadata(item,card){
 let target=item;
 if(item.resultType==="video"){
  if(listValue(item.file_meta).some(file=>file?.thumb_id))return;
  target=state.items.find(parent=>parent.url===item.parentUrl);
  if(!target)return;
 }else if(listValue(item.file_meta).length||listValue(item.thumb_ids).length)return;
 if(!("IntersectionObserver" in window))return;
 if(!metadataObserver)metadataObserver=new IntersectionObserver(entries=>{
  for(const entry of entries)if(entry.isIntersecting){metadataObserver.unobserve(entry.target);loadFolderMetadata(entry.target.metadataItem);}
 },{rootMargin:"300px"});
 card.metadataItem=target;metadataObserver.observe(card);
}
function ensurePlayerDialog(){
 let dialog=$("playerDialog");if(dialog)return dialog;
 dialog=element("dialog",undefined,"player-dialog");dialog.id="playerDialog";dialog.setAttribute("aria-labelledby","playerTitle");dialog.setAttribute("aria-describedby","playerStatus");
 const shell=element("div",undefined,"player-shell"),header=element("header",undefined,"player-header"),heading=element("div",undefined,"player-heading");
 heading.append(element("span","FILSTER PLAYER","eyebrow"));
 const title=element("h2","Video");title.id="playerTitle";heading.append(title);
 const parentName=element("p",undefined,"muted");parentName.id="playerParentTitle";heading.append(parentName);
 const actions=element("div",undefined,"player-header-actions");
 const previous=button("Predchádzajúce",()=>loadPlayerAt(playerIndex-1));previous.id="playerPrevious";previous.disabled=true;previous.setAttribute("aria-label","Predchádzajúce video");
 const next=button("Ďalšie",()=>loadPlayerAt(playerIndex+1));next.id="playerNext";next.disabled=true;next.setAttribute("aria-label","Ďalšie video");
 const close=button("Zavrieť",()=>dialog.close());close.id="playerClose";close.setAttribute("aria-label","Zavrieť prehrávač");close.autofocus=true;
 actions.append(previous,next,close);header.append(heading,actions);
 const stage=element("div",undefined,"player-stage"),video=element("video");video.id="playerVideo";video.className="player-video";video.controls=true;video.playsInline=true;video.preload="none";video.setAttribute("aria-label","Video player");
 const status=element("p","Pripravujem stream…","player-status");status.id="playerStatus";status.setAttribute("role","status");status.setAttribute("aria-live","polite");
 video.addEventListener("playing",()=>{status.hidden=true;});
 video.addEventListener("waiting",()=>{status.textContent="Načítavam video…";status.hidden=false;});
 video.addEventListener("error",()=>{status.textContent="Stream sa prerušil. Skús obnoviť prehrávanie alebo otvoriť zdrojovú stránku.";status.hidden=false;});
 stage.append(video,status);
 const footer=element("footer",undefined,"player-footer"),info=element("span",undefined,"muted");info.id="playerFileInfo";
 const parentLink=element("a","Otvoriť priečinok ↗");parentLink.id="playerParentLink";parentLink.target="_blank";parentLink.rel="noopener noreferrer";
 const sourceLink=element("a","Zdrojová stránka ↗");sourceLink.id="playerSourceLink";sourceLink.target="_blank";sourceLink.rel="noopener noreferrer";
 footer.append(info,parentLink,sourceLink);shell.append(header,stage,footer);dialog.append(shell);document.body.append(dialog);
 dialog.addEventListener("click",event=>{if(event.target===dialog)dialog.close();});
 dialog.addEventListener("keydown",event=>{if(event.key==="Escape"){event.preventDefault();dialog.close();}});
 dialog.addEventListener("close",()=>{
  playerSession++;video.pause();video.removeAttribute("src");video.removeAttribute("poster");video.load();
  playerQueue=[];playerIndex=-1;status.hidden=true;
  if(playerReturnFocus?.isConnected)playerReturnFocus.focus();playerReturnFocus=null;
 });
 return dialog;
}
async function loadPlayerAt(index){
 if(index<0||index>=playerQueue.length)return;
 const dialog=ensurePlayerDialog(),item=playerQueue[index],video=$("playerVideo"),status=$("playerStatus"),slug=listValue(item.file_meta).find(file=>file?.slug)?.slug;
 if(!slug){status.textContent="Pre toto video nie je uložený prehrávací identifikátor.";status.hidden=false;return;}
 playerIndex=index;const session=++playerSession;
 video.pause();video.removeAttribute("src");video.load();
 const title=item.fileName||item.title||"Video";
 $("playerTitle").textContent=title;$("playerParentTitle").textContent="Z priečinka „"+(item.parentTitle||item.title||item.folder_id)+"“";
 $("playerFileInfo").textContent=folderSize(item);
 $("playerParentLink").href=item.parentUrl||item.url;$("playerParentLink").hidden=!safeUrl(item.parentUrl||item.url);
 $("playerSourceLink").href="https://filester.me/d/"+encodeURIComponent(slug);
 video.setAttribute("aria-label","Video player: "+title);
 const thumb=listValue(item.file_meta).find(file=>file?.thumb_id)?.thumb_id;
 if(thumb)video.poster="https://filester.me/t/"+encodeURIComponent(thumb);
 $("playerPrevious").disabled=index<=0;$("playerNext").disabled=index>=playerQueue.length-1;
 status.textContent="Pripravujem zabezpečený stream…";status.hidden=false;status.classList.remove("error");
 if(!dialog.open){playerReturnFocus=document.activeElement;dialog.showModal();}
 try{
  const stream=await api("/playback-token",{slug});
  if(session!==playerSession||!dialog.open)return;
  video.src=stream.url;video.load();
  try{await video.play();status.hidden=true;}
  catch{status.textContent="Stream je pripravený. Stlač prehrávanie v ovládači.";status.hidden=false;}
 }catch(error){
  if(session!==playerSession||!dialog.open)return;
  status.textContent=error.message||"Video sa nepodarilo načítať.";status.hidden=false;status.classList.add("error");
 }
}
async function openPlayer(item,queue){
 playerQueue=queue||filtered().filter(result=>result.resultType==="video");
 playerIndex=playerQueue.findIndex(result=>result.selectionKey===item.selectionKey);
 if(playerIndex<0){playerQueue=[item];playerIndex=0;}
 await loadPlayerAt(playerIndex);
}
function filtered(){
 const terms=normalized($("filter").value).split(/\s+/).filter(Boolean);
 const taskTerms=jobFilter?(jobKeywords||[]).map(normalized).filter(Boolean):[];
 const type=$("fileType").value,quality=$("qualityFilter").value;
 const minSize=numericBound("minSize"),maxSize=numericBound("maxSize"),minFiles=numericBound("minFiles"),maxFiles=numericBound("maxFiles");
 const items=[];
 for(const i of state.items){
  const scopeUrl=i.parentUrl||i.url;
  if(jobFilter&&!jobFilter.has(scopeUrl))continue;
  if(collectionFilter&&!collectionFilter.has(scopeUrl))continue;
  if(view==="favorites"&&!i.favorite)continue;
  if(view==="unopened"&&i.opened_at)continue;
  const bytes=knownBytes(i),files=Number(i.file_count)||0;
  if((minSize!==null||maxSize!==null)&&bytes<=0)continue;
  if(minSize!==null&&bytes<minSize*1024**3)continue;
  if(maxSize!==null&&bytes>maxSize*1024**3)continue;
  if(minFiles!==null&&files<minFiles)continue;
  if(maxFiles!==null&&files>maxFiles)continue;
  const entries=fileEntries(i),folderText=normalized([i.title,i.source,i.note,i.folder_id].join(" "));
  const folderMatch=terms.length?terms.every(term=>folderText.includes(term)):taskTerms.length?taskTerms.some(term=>folderText.includes(term)):true;
  const filenameMatches=entries.filter(file=>terms.every(term=>normalized(file.name).includes(term)));
  const taskVideos=taskTerms.length?entries.filter(file=>isVideoFile(file)&&taskTerms.some(term=>normalized(file.name).includes(term))).map(file=>videoResult(i,file)):[];
  const matchingVideos=filenameMatches.filter(isVideoFile).map(file=>videoResult(i,file));
  const addFolder=()=>{
   if(type!=="all"&&!entries.some(file=>fileKind(file.name)===type))return;
   if(quality==="preview"&&!listValue(i.thumb_ids).length)return;
   if(quality==="size"&&!knownBytes(i))return;
   if(quality==="complete"&&metadataCoverage(i)<.8)return;
   items.push(i);
  };
  const addVideos=videos=>{
   for(const video of videos){
    if(quality==="preview"&&!video.thumb_ids.length)continue;
    if(quality==="size"&&!knownBytes(video))continue;
    if(quality==="complete"&&metadataCoverage(video)<.8)continue;
    items.push(video);
   }
  };
  if(type==="video"){
    const videos=terms.length?matchingVideos:taskTerms.length?taskVideos:entries.filter(isVideoFile).map(file=>videoResult(i,file));
   addVideos(videos);
   continue;
  }
  if(folderMatch)addFolder();
    if(jobFilter&&!terms.length){
    addVideos(taskVideos);
    if(!folderMatch&&!taskVideos.length)addFolder();
    continue;
    }
  if(terms.length){
   addVideos(matchingVideos);
   if(!folderMatch&&!matchingVideos.length&&filenameMatches.length)addFolder();
  }
 }
 const sort=$("sort").value;
 items.sort((a,b)=>sort==="files"?(b.file_count||0)-(a.file_count||0):sort==="size"?knownBytes(b)-knownBytes(a):sort==="title"?(a.title||"").localeCompare(b.title||""):sort==="quality"?qualityScore(b)-qualityScore(a):(b.last_seen||0)-(a.last_seen||0));
 if($("duplicatesToggle").checked){
  const seen=new Set();
  items=items.filter(item=>{const key=duplicateKey(item);if(!key)return true;if(seen.has(key))return false;seen.add(key);return true;});
 }
 return items;
}
async function annotate(item,changes){
 const record=item.parentUrl?state.items.find(candidate=>candidate.url===item.parentUrl)||item:item;
 const next={...record,...changes};
 await api("/annotations",{url:record.url,favorite:!!next.favorite,note:next.note||"",opened:!!changes.opened_at,relevance:next.relevance??null});
 Object.assign(record,next);
 if(record!==item)Object.assign(item,changes);
 await cacheWrite();render();
}
function updateCount(items=filtered()){
 $("count").textContent=items.length+" výsledkov · "+selected.size+" vybraných"+(jobFilter?" · úloha":"")+(collectionFilter?" · kolekcia":"");
 const chosenFolders=new Set(items.filter(item=>selected.has(item.selectionKey||item.url)).map(item=>item.parentUrl||item.url));
 $("reviewGrid").disabled=!chosenFolders.size;
 $("reviewGrid").textContent="Prehliadať videá ("+chosenFolders.size+")";
 const selectedFolders=new Set(selectedItems(items).map(item=>item.parentUrl||item.url).map(url=>state.items.find(folder=>folder.url===url)?.folder_id).filter(Boolean));
 $("refreshSelected").disabled=!online||!selectedFolders.size;
 $("refreshSelected").textContent="Obnoviť vybrané ("+selectedFolders.size+")";
 $("refreshIndex").disabled=!online||!state.items.length;
}
function selectedItems(items=filtered()){return items.filter(item=>selected.has(item.selectionKey||item.url));}
function renderResults(){
 if(metadataObserver)metadataObserver.disconnect();
 const items=filtered();$("results").replaceChildren();
 updateCount(items);
 $("removeFromCollection").hidden=!activeCollectionId||!collectionFilter;
 const duplicateCounts=new Map();
 for(const item of items){const key=duplicateKey(item);if(key)duplicateCounts.set(key,(duplicateCounts.get(key)||0)+1);}
 $("results").classList.toggle("compact",$("compactToggle").checked);
 for(const item of items.slice(0,shown)){
  const title=item.resultType==="video"?item.fileName:item.title||item.folder_id||"Bez názvu";
  const keyForSelection=item.selectionKey||item.url;
  const card=element("article",undefined,"card"+(item.resultType==="video"?" video-card":""));card.tabIndex=0;card.resultItem=item;card.setAttribute("aria-label",title);
  const body=element("div",undefined,"card-body");
  const heading=element("div",undefined,"card-heading");
  const check=element("input");check.type="checkbox";check.checked=selected.has(keyForSelection);check.setAttribute("aria-label","Vybrať "+title);check.addEventListener("change",()=>{if(check.checked)selected.add(keyForSelection);else selected.delete(keyForSelection);updateCount(items);});
  heading.append(check,element("h3",title));
    const thumbIds=listValue(item.thumb_ids).filter(id=>typeof id==="string"&&/^[a-f\d-]{20,}$/i.test(id)).slice(0,4);
    if(thumbIds.length){
     const preview=element("div",undefined,"preview-mosaic count-"+thumbIds.length);preview.setAttribute("aria-label","Náhľady priečinka");
     for(const id of thumbIds){
        const image=element("img");image.src="https://filester.me/t/"+encodeURIComponent(id);image.alt=item.resultType==="video"?"Náhľad videa":"Náhľad súboru v priečinku";image.loading="lazy";image.decoding="async";image.referrerPolicy="no-referrer";
        image.addEventListener("error",()=>image.replaceWith(element("span","Náhľad nedostupný","preview-unavailable")));preview.append(image);
     }
    card.append(preview);
    }else if(item.resultType==="video")card.append(element("div","▶ VIDEO","video-placeholder"));
    else card.classList.add("no-preview");
    const metaText=item.resultType==="video"?"Video · "+folderSize(item)+" · "+(item.source||"index"):(item.file_count||0)+" súborov · "+(item.out_degree||0)+" podpriečinkov · "+folderSize(item)+" · "+(item.source||"index");
    body.append(heading,element("div",metaText,"meta"));
    const badges=element("div",undefined,"badges");
    const named=fileNames(item).length,metaCount=listValue(item.file_meta).length;
    if(item.resultType==="video")badges.append(element("span","Video zo súboru","badge"));
    if(!(Number(item.file_count)>0)&&Number(item.out_degree)>=8)badges.append(element("span","Rozcestník","badge"));
    if(metaCount)badges.append(element("span",metaCount+"/"+(item.file_count||"?")+" detailov","badge"));
    if(thumbIds.length)badges.append(element("span",thumbIds.length+" náhľady","badge"));
    if(item.relevance===1)badges.append(element("span","Užitočné","badge positive"));
    if(item.relevance===-1)badges.append(element("span","Vyradené","badge negative"));
    const key=duplicateKey(item),copies=key?duplicateCounts.get(key):0;
    if(copies>1)badges.append(element("span",(key.startsWith("thumbs:")?"Rovnaké náhľady":"Rovnaký zoznam súborov")+" · "+copies,"badge"));
    if(named&&!metaCount)badges.append(element("span",named+" názvov súborov","badge"));
    if(badges.childElementCount)body.append(badges);
  const actions=element("div",undefined,"actions");
  const sourceUrl=item.resultType==="video"?(item.videoUrl||item.parentUrl):item.url;
  if(safeUrl(sourceUrl)){
   const link=element("a",item.resultType==="video"?(item.videoUrl?"Otvoriť video ↗":"Otvoriť priečinok ↗"):"Otvoriť zdroj ↗");link.href=sourceUrl;link.target="_blank";link.rel="noopener noreferrer";
   link.addEventListener("click",()=>{annotate(item,{opened_at:Date.now()/1000}).catch(e=>message(e.message));});
   actions.append(link);
  }
  if(item.resultType==="video"&&listValue(item.file_meta).some(file=>file?.slug))actions.append(button("Prehrať",()=>openPlayer(item)));
  if(item.resultType==="video"&&safeUrl(item.parentUrl)){
   const parentLink=element("a","Priečinok: "+(item.parentTitle||"zdroj")+" ↗");parentLink.href=item.parentUrl;parentLink.target="_blank";parentLink.rel="noopener noreferrer";actions.append(parentLink);
  }
  actions.append(button(item.favorite?"★ Uložené":"☆ Uložiť",()=>annotate(item,{favorite:!item.favorite})));
  const useful=button("Užitočné",()=>annotate(item,{relevance:item.relevance===1?0:1}));useful.setAttribute("aria-pressed",String(item.relevance===1));
  const reject=button("Vyradiť",()=>annotate(item,{relevance:item.relevance===-1?0:-1}));reject.setAttribute("aria-pressed",String(item.relevance===-1));
  actions.append(useful,reject);body.append(actions);
  const notes=element("details",undefined,"notes");const summary=element("summary",item.note?"Poznámka uložená":"Poznámka");notes.append(summary);
  const note=element("textarea");note.placeholder="Poznámka k priečinku";note.value=item.note||"";note.setAttribute("aria-label","Poznámka k "+(item.title||item.folder_id));
  notes.append(note,button("Uložiť poznámku",async()=>{await annotate(item,{note:note.value});message("Poznámka uložená.");}));
  body.append(notes);card.append(body);$("results").append(card);observeMetadata(item,card);
 }
 if(!items.length)$("results").append(element("p","Žiadne výsledky pre tento filter.","muted"));
 $("more").hidden=items.length<=shown;
}
function listValue(v){if(Array.isArray(v))return v;try{return JSON.parse(v||"[]");}catch{return [];}}
function renderHistory(){
 $("jobs").replaceChildren();
 for(const job of state.jobs){
  const box=element("article",undefined,"job");
  const indexedLabel=job.indexed_results===undefined?"":" · už v indexe "+job.indexed_results;
  const title=job.refresh_only?"obnovenie indexu":job.backlog_only?"lokálny zásobník":listValue(job.keywords).join(", ");
  const discoveryLabel="externé "+(job.external_candidates||0)+" (nové "+(job.external_new_candidates||0)+", prekryv "+(job.external_existing_candidates||0)+")";
  const validationLabel="overené z úlohy "+(job.discovery_metrics?.preferred_validated||0)+" · zo zásobníka "+(job.discovery_metrics?.backlog_validated||0)+" · snowball "+(job.discovery_metrics?.snowball_candidates||0);
  const refreshLabel=job.refresh_only?" · aktualizované "+(job.updated||0)+" · chyby "+(job.errors||0):" · "+discoveryLabel+" · "+validationLabel+" · obsah "+(job.content||0)+indexedLabel;
  box.append(element("strong",job.status+" · "+title),element("p",new Date(job.created_at*1000).toLocaleString()+refreshLabel));
  if(job.message)box.append(element("p",job.message,"muted"));
  if(job.timings)box.append(element("p","Discovery "+(job.timings.discovery_seconds??"…")+" s · overovanie "+(job.timings.validation_seconds??"…")+" s · celkom "+(job.timings.total_seconds??"…")+" s","muted"));
  for(const [name,source] of Object.entries(job.source_progress||{}))box.append(element("p",name+": "+source.status+" · "+source.seconds+" s · "+source.hits+" zásahov · nové "+(source.new||0)+" · prekryv "+(source.existing_overlap||0),"muted"));
  if(["queued","running"].includes(job.status))box.append(button("Zastaviť",async()=>{await api("/jobs/"+job.job_id+"/cancel",{});await refresh();}));
  box.append(button("Znova použiť",()=>{$("keywords").value=listValue(job.keywords).join(", ");$("budget").value=job.max_queries;$("validate").value=job.max_validate;document.querySelectorAll('[name="source"]').forEach(e=>e.checked=listValue(job.sources).includes(e.value));$("keywords").focus();}));
  box.append(button("Výsledky tejto úlohy",async()=>{activeJobId=job.job_id;jobFilter=new Set();jobKeywords=[];setView("job",false);await refresh();message("Výsledky vybranej úlohy · "+job.job_id);}));
  $("jobs").append(box);
 }
 $("searchHistory").replaceChildren();
 for(const h of state.history)$("searchHistory").append(button(h.query+" · "+h.result_count+" · "+new Date(h.ts*1000).toLocaleString(),()=>{$("query").value=h.query;}));
}
function renderCollections(){
 const collections=state.collections||[];
 const choice=$("collectionChoice"),previous=choice.value;
 choice.replaceChildren(element("option","Kolekcia…"));choice.firstChild.value="";
 for(const collection of collections){const option=element("option",collection.name);option.value=collection.id;choice.append(option);}
 choice.value=collections.some(collection=>collection.id===previous)?previous:"";
 $("collectionList").replaceChildren();
 for(const collection of collections){
  const row=element("article",undefined,"collection-row");
  row.append(element("strong",collection.name),element("span",(collection.urls||[]).length+" priečinkov","muted"));
  row.append(button("Zobraziť",()=>{activeCollectionId=collection.id;collectionFilter=new Set(collection.urls||[]);jobFilter=null;setView("all",false);message(collection.name+" · "+collectionFilter.size+" priečinkov");}));
  row.append(button("Odstrániť",async()=>{
   if(!window.confirm("Odstrániť kolekciu „"+collection.name+"“? Priečinky v indexe zostanú."))return;
   await api("/collections/"+encodeURIComponent(collection.id),undefined,"DELETE");
   if(activeCollectionId===collection.id){activeCollectionId=null;collectionFilter=null;}
   await refresh();message("Kolekcia odstránená.");
  }));
  $("collectionList").append(row);
 }
 if(!collections.length)$("collectionList").append(element("p","Zatiaľ tu nie sú žiadne kolekcie.","muted"));
}
function render(){
 if(lastStartedJob){
  const finished=state.jobs.find(j=>j.job_id===lastStartedJob&&!['queued','running'].includes(j.status));
  if(finished){
   message(finished.refresh_only
    ? "Obnovenie "+finished.status+" · "+(finished.updated||0)+" aktualizovaných · "+(finished.errors||0)+" chýb · "+(finished.timings?.total_seconds??"—")+" s"
    : "Úloha "+finished.status+" · "+(finished.indexed_results||0)+" už v indexe · "+(finished.content||0)+" nových priečinkov s obsahom · "+(finished.timings?.total_seconds??"—")+" s");
   lastStartedJob=null;
  }
 }
 $("connection").textContent=online?"● Backend online":"○ Offline · cache";
 $("dataPath").textContent=state.data_dir||"";
 $("metrics").replaceChildren();
 const active=state.jobs.filter(j=>["running","queued"].includes(j.status)).length;
 for(const [n,label] of [[state.items.length,"priečinkov v indexe"],[state.items.filter(i=>i.favorite).length,"obľúbených"],[active,"aktívnych úloh"],[state.jobs.length,"úloh v histórii"]]){
  const e=element("div",undefined,"metric");e.append(element("b",String(n)),element("span",label));$("metrics").append(e);
 }
 $("start").disabled=!online||active>0;
 $("backlog").disabled=!online||active>0;
 $("backlog").textContent="Overiť lokálny zásobník ("+(state.pool?.unvalidated||0)+")";
 $("network").replaceChildren();
 const net=state.network;
 if(net){
  $("network").append(element("p",net.requests+" sieťových požiadaviek · "+net.cache_hits+" použití cache · "+net.errors+" chýb · p95 "+net.p95_ms+" ms"));
  for(const host of net.hosts){
   const pause=Math.max(0,Math.ceil(host.cooldown-Date.now()/1000));
   $("network").append(element("p",host.host+" · "+host.rps.toFixed(2)+" pož./s · "+(pause?"prestávka "+pause+" s ("+host.reason+")":"pripravený"),"muted"));
  }
 }else $("network").append(element("p","Diagnostika bude dostupná po aktualizácii backendu.","muted"));
 $("activeJob").replaceChildren();
 const queue=state.openQueue;
 if(queue&&queue.index<queue.urls.length){
  const card=element("div",undefined,"job");
  card.append(element("strong","Postupné otváranie · "+queue.index+"/"+queue.urls.length),element("p",queue.status==="paused"?"Pozastavené: "+queue.reason:"Karty otvárame postupne do skupiny. Front pokračuje aj pri prepnutí karty."));
  card.append(button("Zastaviť otváranie",async()=>{const r=await chrome.runtime.sendMessage({type:"cancelOpen"});if(!r.ok)throw new Error(r.error);await refresh();}));
  $("activeJob").append(card);
 }
 for(const job of state.jobs.filter(j=>["queued","running"].includes(j.status))){
  const card=element("div",undefined,"job");
  card.append(element("strong","Aktívna úloha · "+(job.stage||job.status)),element("p",job.message||"Spracúvam zdroje…"));
  card.append(element("p","Obsah: "+(job.content||0)+" · overené: "+(job.validated||0)+" · odložené chyby: "+(job.errors||0)));
  card.append(button("Zastaviť",async()=>{await api("/jobs/"+job.job_id+"/cancel",{});await refresh();}));
  $("activeJob").append(card);
 }
 renderCollections();
 if(!document.querySelector("#results textarea:focus"))renderResults();
 renderHistory();
}
function setView(next,reset=true){view=next;document.body.classList.toggle("video-mode",view==="videos");if(reset){jobFilter=next==="current"?new Set():null;jobKeywords=null;collectionFilter=null;activeCollectionId=null;activeJobId=null;}shown=100;$("library").hidden=view==="history"||view==="collections"||view==="videos";$("videoWorkspace").hidden=view!=="videos";$("history").hidden=view!=="history";$("collections").hidden=view!=="collections";document.querySelectorAll("[data-view]").forEach(e=>e.classList.toggle("active",e.dataset.view===view));render();if(next==="current")refresh();}
async function openItems(items){
 const urls=[...new Set(items.map(i=>i.videoUrl||i.url))].filter(safeUrl);
 if(!urls.length){message("Najprv vyber výsledky.");return;}
 if(!extension){message("Hromadné otvorenie do skupiny kariet je dostupné v Chrome rozšírení. Tu môžeš exportovať alebo kopírovať odkazy.");return;}
 $("openAll").disabled=$("openSelected").disabled=true;
 try{
  const r=await chrome.runtime.sendMessage({type:"openResults",urls});
  if(!r.ok)throw new Error(r.error);
  if(r.queued){message(r.count+" odkazov je vo fronte. Otvárame ich postupne s ochranou proti nárazu požiadaviek.");await refresh();return;}
  await api("/opened",{urls});
  for(const i of items)i.opened_at=Date.now()/1000;
  await cacheWrite();render();
  message("Otvorených "+urls.length+" odkazov v skupine Filester.");
 }finally{$("openAll").disabled=$("openSelected").disabled=false;}
}
document.querySelectorAll("[data-view]").forEach(e=>e.addEventListener("click",()=>setView(e.dataset.view)));
$("refresh").addEventListener("click",refresh);
$("filter").addEventListener("input",()=>{shown=100;renderResults();});
for(const id of ["minSize","maxSize","minFiles","maxFiles"])$(id).addEventListener("input",()=>{shown=100;renderResults();});
$("fileType").addEventListener("change",()=>{shown=100;renderResults();});
$("qualityFilter").addEventListener("change",()=>{shown=100;renderResults();});
$("sort").addEventListener("change",renderResults);
$("compactToggle").addEventListener("change",()=>{saveSettings().catch(e=>message(e.message));renderResults();});
$("duplicatesToggle").addEventListener("change",()=>{shown=100;renderResults();});
$("more").addEventListener("click",()=>{shown+=100;renderResults();});
$("selectAll").addEventListener("click",()=>{const items=filtered();const all=items.every(i=>selected.has(i.selectionKey||i.url));items.forEach(i=>all?selected.delete(i.selectionKey||i.url):selected.add(i.selectionKey||i.url));renderResults();});
$("addToCollection").addEventListener("click",async()=>{
 const collectionId=$("collectionChoice").value;
 const urls=[...new Set(selectedItems().map(item=>item.parentUrl||item.url))];
 if(!collectionId||!urls.length){message("Vyber kolekciu aj aspoň jeden priečinok.");return;}
 await api("/collections/"+encodeURIComponent(collectionId)+"/items",{urls});
 selected.clear();await refresh();message("Pridaných "+urls.length+" priečinkov do kolekcie.");
});
$("removeFromCollection").addEventListener("click",async()=>{
 if(!activeCollectionId||!collectionFilter)return;
 const urls=[...new Set(selectedItems().map(item=>item.parentUrl||item.url).filter(url=>collectionFilter.has(url)))];
 if(!urls.length){message("Označ priečinky, ktoré chceš odobrať.");return;}
 await Promise.all(urls.map(url=>api("/collections/"+encodeURIComponent(activeCollectionId)+"/items?url="+encodeURIComponent(url),undefined,"DELETE")));
 urls.forEach(url=>{collectionFilter.delete(url);selected.delete(url);});
 await refresh();message("Odobratých "+urls.length+" priečinkov z kolekcie.");
});
function visibleReviewVideos(){
 const term=normalized($("videoFilter").value.trim());
 const rows=reviewVideos.filter(item=>!term||normalized(item.fileName+" "+item.parentTitle).includes(term));
 const sort=$("videoSort").value;
 rows.sort((a,b)=>sort==="sizeDesc"?knownBytes(b)-knownBytes(a):sort==="size"?knownBytes(a)-knownBytes(b):sort==="dateDesc"?String(b.file_meta[0]?.date||"").localeCompare(String(a.file_meta[0]?.date||"")):sort==="folder"?String(a.parentTitle).localeCompare(String(b.parentTitle)):sort==="nameDesc"?String(b.fileName).localeCompare(String(a.fileName)):String(a.fileName).localeCompare(String(b.fileName)));
 return rows;
}
function selectedReviewItems(){return reviewVideos.filter(item=>reviewSelected.has(item.selectionKey));}
function updateReviewProgress(){
 const complete=reviewAudits.filter(entry=>entry.status==="complete").length;
 const incomplete=reviewAudits.filter(entry=>entry.status==="incomplete").length;
 const failed=reviewAudits.filter(entry=>entry.status==="failed").length;
 $("videoProgress").textContent=reviewFolders.length+" priečinkov · "+reviewVideos.length+" videí · "+complete+" úplné"+(incomplete?" · "+incomplete+" neúplných":"")+(failed?" · "+failed+" nedostupných":"");
 const refresh=$("refreshReviewMetadata");
 if(refresh){const missing=reviewAudits.reduce((sum,entry)=>sum+(Number(entry.missingThumbnails)||0),0);refresh.disabled=reviewLoading||!reviewFolders.length;refresh.textContent="Obnoviť metadata a náhľady"+(missing?" ("+missing+")":"");}
}
function mergeReviewFolderVideos(folder,files){
 const byKey=new Map(reviewVideos.filter(item=>item.parentUrl===folder.url).map(item=>[item.selectionKey,item]));
 for(const file of files||[])if(isVideoFile(file)){const item=videoResult(folder,file);byKey.set(item.selectionKey,item);}
 reviewVideos=reviewVideos.filter(item=>item.parentUrl!==folder.url).concat([...byKey.values()]);
 const available=new Set(reviewVideos.map(item=>item.selectionKey));reviewSelected=new Set([...reviewSelected].filter(key=>available.has(key)));
}
function updateReviewSummary(rows=visibleReviewVideos()){
 const selectedCount=reviewSelected.size;
 $("videoCount").textContent=rows.length+" videí · "+selectedCount+" vybraných na import"+(reviewImporting?" · odosielam…":"");
 const importButton=$("videoImport");
 importButton.disabled=reviewImporting||!selectedCount;
 importButton.textContent=reviewImporting?"Odosielam do Nexusu…":"Odoslať vybrané do Nexusu";
}
function renderReviewAudit(){
 const audit=$("videoAudit");audit.replaceChildren();
 for(const entry of reviewAudits){
  const row=element("div",undefined,"video-audit-row "+entry.status);
  const label=entry.title||entry.folder_id||"Bez názvu";
  let status="";
  if(entry.status==="complete")status="✓ "+entry.loaded+" / "+entry.expected+" súborov"+(entry.missingThumbnails?" · "+entry.missingThumbnails+" bez náhľadu":"");
  else if(entry.status==="incomplete")status="⚠ "+entry.loaded+" / "+(entry.expected||"?")+" súborov";
  else if(entry.status==="loading")status="↻ Načítavam…";
  else status="⚠ Nedostupné";
  const controls=element("div",undefined,"video-audit-controls");controls.append(element("span",status,"video-audit-status"));
  if(entry.status==="incomplete"||entry.status==="failed"||entry.missingThumbnails){
   const retry=button(entry.status==="incomplete"?"Načítať chýbajúce":entry.missingThumbnails?"Obnoviť náhľady":"Skúsiť znova",()=>retryReviewFolder(entry.folder_id,entry.missingThumbnails));
   retry.className="retry-missing";retry.disabled=!!entry.retrying;controls.append(retry);
  }
  row.append(element("strong",label),controls);audit.append(row);
 }
}
function renderReviewVideos(){
 const rows=visibleReviewVideos();$("videoResults").replaceChildren();
 updateReviewSummary(rows);renderReviewAudit();
 for(const item of rows){
  const card=element("article",undefined,"card video-card");
  const file=item.file_meta[0],check=element("input");check.type="checkbox";check.checked=reviewSelected.has(item.selectionKey);check.setAttribute("aria-label","Vybrať "+item.fileName);
  check.addEventListener("change",()=>{check.checked?reviewSelected.add(item.selectionKey):reviewSelected.delete(item.selectionKey);updateReviewSummary(rows);});
  const heading=element("div",undefined,"card-heading");heading.append(check,element("h3",item.fileName));card.append(heading);
  if(file.thumb_id){const image=element("img");image.src="https://filester.me/t/"+encodeURIComponent(file.thumb_id);image.alt="Náhľad videa";image.loading="lazy";image.referrerPolicy="no-referrer";image.className="review-thumb";image.addEventListener("error",()=>{if(image.isConnected)image.replaceWith(element("div","Náhľad nedostupný","video-placeholder"));});card.append(image);}else card.append(element("div","▶ VIDEO · bez náhľadu","video-placeholder"));
  card.append(element("div",item.parentTitle+" · "+(Number(file.size)>0?formatBytes(Number(file.size)):"veľkosť neznáma")+(file.date?" · "+file.date:""),"meta"));
  const actions=element("div",undefined,"actions");
  if(file.slug)actions.append(button("Prehrať",()=>openPlayer(item,visibleReviewVideos())));
  const link=element("a",file.slug?"Otvoriť video ↗":"Otvoriť priečinok ↗");link.href=item.videoUrl||item.parentUrl;link.target="_blank";link.rel="noopener noreferrer";actions.append(link);card.append(actions);$("videoResults").append(card);
 }
 if(!rows.length)$("videoResults").append(element("p",reviewLoading?"Načítavam videá…":"Žiadne videá pre tento filter.","muted"));
}
async function loadReviewGrid(){
 const chosen=[...new Set(selectedItems().map(item=>item.parentUrl||item.url))];
 reviewFolders=state.items.filter(item=>chosen.includes(item.url)&&/^[a-f0-9]{8,64}$/i.test(item.folder_id||""));
 if(!reviewFolders.length){message("Označ priečinky z aktuálneho zoznamu.");return;}
 reviewVideos=[];reviewSelected.clear();reviewAudits=[];reviewLoading=true;setView("videos",false);renderReviewVideos();
 let incomplete=0,failed=0;
 for(let n=0;n<reviewFolders.length;n++){
  const folder=reviewFolders[n];$("videoProgress").textContent="Načítavam "+(n+1)+" / "+reviewFolders.length+" priečinkov · "+reviewVideos.length+" videí";
  try{
   const result=await api("/folder-videos",{folder_id:folder.folder_id},undefined,120000);
   if(!result.complete)incomplete++;
   reviewAudits.push({...folder,loaded:(result.files||[]).length,expected:Number(result.expected)||0,missingThumbnails:(result.files||[]).filter(file=>isVideoFile(file)&&!file.thumb_id).length,status:result.complete?"complete":"incomplete"});
   mergeReviewFolderVideos(folder,result.files);
   renderReviewVideos();
  }catch(error){failed++;reviewAudits.push({...folder,status:"failed"});message("Priečinok "+folder.folder_id+": "+error.message);renderReviewVideos();}
 }
 reviewLoading=false;updateReviewProgress();renderReviewVideos();
}
async function retryReviewFolder(folderId,refreshMetadata=false){
 const entry=reviewAudits.find(a=>a.folder_id===folderId),folder=reviewFolders.find(item=>item.folder_id===folderId);
 if(!entry||!folder||entry.retrying)return;
 entry.retrying=true;entry.status="loading";renderReviewVideos();
 try{
  const result=await api("/folder-videos",{folder_id:folderId,refresh:refreshMetadata},undefined,120000);
  mergeReviewFolderVideos(folder,result.files);
  entry.loaded=(result.files||[]).length;
  entry.expected=Math.max(Number(entry.expected)||0,Number(result.expected)||0);
  entry.missingThumbnails=(result.files||[]).filter(file=>isVideoFile(file)&&!file.thumb_id).length;
  entry.status=result.complete?"complete":"incomplete";
  message(refreshMetadata?"Metadata a náhľady boli obnovené pre "+(folder.title||folderId)+".":result.complete?"Chýbajúce videá boli načítané pre priečinok "+(folder.title||folderId)+".":"Kontrola priečinka skončila; niektoré súbory stále chýbajú.");
 }catch(error){entry.status="failed";message("Priečinok "+folderId+": "+error.message);}
 finally{entry.retrying=false;updateReviewProgress();renderReviewVideos();}
}
async function refreshReviewMetadata(){
 if(reviewLoading||!reviewFolders.length)return;
 reviewLoading=true;renderReviewVideos();let refreshed=0,failed=0;
 for(const folder of reviewFolders){const entry=reviewAudits.find(item=>item.folder_id===folder.folder_id);await retryReviewFolder(folder.folder_id,true);if(entry?.status==="failed")failed++;else refreshed++;}
 reviewLoading=false;updateReviewProgress();renderReviewVideos();
 message("Obnovené metadata pre "+refreshed+" priečinkov"+(failed?" · "+failed+" chýb":"")+".");
}
$("reviewGrid").addEventListener("click",()=>loadReviewGrid().catch(error=>{reviewLoading=false;message(error.message);}));
$("videoBack").addEventListener("click",()=>setView("current",false));
$("videoFilter").addEventListener("input",renderReviewVideos);
$("videoSort").addEventListener("change",renderReviewVideos);
$("videoSelectAll").addEventListener("click",()=>{const rows=visibleReviewVideos();const all=rows.every(item=>reviewSelected.has(item.selectionKey));rows.forEach(item=>all?reviewSelected.delete(item.selectionKey):reviewSelected.add(item.selectionKey));renderReviewVideos();});
$("videoCopy").addEventListener("click",async()=>{const urls=selectedReviewItems().map(item=>item.videoUrl||item.parentUrl);if(!urls.length){message("Najprv vyber videá.");return;}await navigator.clipboard.writeText([...new Set(urls)].join("\n"));message("Skopírovaných "+urls.length+" odkazov na import.");});
$("videoExport").addEventListener("click",()=>{const items=selectedReviewItems();if(!items.length){message("Najprv vyber videá.");return;}const payload={exported_at:new Date().toISOString(),source:"Filester Search",videos:items.map(item=>({name:item.fileName,url:item.videoUrl||item.parentUrl,folder_url:item.parentUrl,folder_title:item.parentTitle,size:item.file_meta[0]?.size||0,date:item.file_meta[0]?.date||"",slug:item.file_meta[0]?.slug||""}))};const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}));const a=element("a");a.href=url;a.download="filester-import-selection-"+new Date().toISOString().slice(0,10)+".json";a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);message("Exportovaných "+items.length+" vybraných videí.");});
async function importReviewSelection(){
 const items=selectedReviewItems();if(!items.length){message("Najprv vyber videá.");return;}
 const videos=items.map(item=>{const file=item.file_meta[0]||{};return {url:item.videoUrl||item.parentUrl,title:item.fileName||item.parentTitle||"Filester video",source_url:item.videoUrl||item.parentUrl,source_scope:"file",thumbnail:file.thumb_id?"https://filester.me/t/"+encodeURIComponent(file.thumb_id):null,filesize:Number(file.size)||0,upload_date:file.date||"",tags:"filester,filester-search"};});
 const payload={batch_name:"Filester Search · "+new Date().toLocaleString("sv-SE").replace(" "," ").slice(0,16),videos};
 reviewImporting=true;renderReviewVideos();
 let lastError="Nexus nie je spustený na porte 8000.";
 try{
  for(const port of ["8000","8001","8002"]){
   try{
    const health=await fetch("http://127.0.0.1:"+port+"/health",{signal:AbortSignal.timeout(4000)});if(!health.ok)continue;
    const response=await fetch("http://127.0.0.1:"+port+"/api/v1/import/bulk",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(120000)});
    const raw=await response.text();let data={};try{data=raw?JSON.parse(raw):{};}catch{}
    if(!response.ok){lastError=String(data.detail||data.error||data.message||raw||("HTTP "+response.status));continue;}
    const queued=Number(data.count??data.imported??videos.length),duplicates=Number(data.duplicates||0),skipped=Number(data.errors||0),job=data.job_id||data.job?.id;
    message("Nexus prijal "+queued+" videí"+(job?" do úlohy #"+job:"")+(duplicates?" · "+duplicates+" už bolo v knižnici":"")+(skipped?" · "+skipped+" preskočených":"")+".");
    return;
   }catch(error){lastError=error.name==="TimeoutError"?"Nexus do 2 minút nepotvrdil prijatie. Skontroluj import monitor pred ďalším odoslaním.":error.message||lastError;}
  }
  message("Import nebol potvrdený: "+lastError+" Výber ostal zachovaný.");
 }finally{reviewImporting=false;renderReviewVideos();}
}
$("videoImport").addEventListener("click",()=>importReviewSelection().catch(error=>{reviewImporting=false;renderReviewVideos();message(error.message||"Import sa nepodarilo odoslať.");}));
$("openSelected").addEventListener("click",()=>openItems(selectedItems()).catch(e=>message(e.message)));
$("openAll").addEventListener("click",()=>openItems(filtered()).catch(e=>message(e.message)));
async function startFolderRefresh(folderIds,label){
 const unique=[...new Set(folderIds.filter(id=>/^[a-f\d]{8,64}$/i.test(id)))];
 if(!unique.length){message("Najprv vyber aspoň jeden priečinok.");return;}
 const r=await api("/refresh-folders",{folder_ids:unique},undefined,30000);
 lastStartedJob=r.job_id;selected.clear();setView("current");
 message("Obnovovanie "+label+" ("+r.requested+") beží na serveri. Môžeš pokračovať v práci.");
 await refresh();
}
$("export").addEventListener("click",()=>{
 const items=selected.size?selectedItems():filtered();
 const url=URL.createObjectURL(new Blob([JSON.stringify({exported_at:new Date().toISOString(),items},null,2)],{type:"application/json"}));
 const a=element("a");a.href=url;a.download="filester-results-"+new Date().toISOString().slice(0,10)+".json";a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);message("Exportovaných "+items.length+" výsledkov.");
});
$("copy").addEventListener("click",async()=>{try{const items=selected.size?selectedItems():filtered();await navigator.clipboard.writeText(items.map(i=>i.videoUrl||i.url).filter(safeUrl).join("\n"));message("Odkazy skopírované.");}catch(e){message(e.message);}});
$("createCollection").addEventListener("submit",async event=>{
 event.preventDefault();const name=$("collectionName").value.trim();if(!name)return;
 try{await api("/collections",{name});$("collectionName").value="";await refresh();message("Kolekcia vytvorená.");}catch(error){message(error.message);}
});
$("discover").addEventListener("submit",async e=>{
 e.preventDefault();$("start").disabled=true;
 try{
  const body={keywords:[...new Set($("keywords").value.split(",").map(s=>s.trim()).filter(Boolean))],sources:[...document.querySelectorAll('[name="source"]:checked')].map(e=>e.value),max_queries:Number($("budget").value),max_validate:Number($("validate").value),target_new:50};
  if(!body.keywords.length||!body.sources.length)throw new Error("Zadaj kľúčové slovo a vyber zdroj.");
  const r=await api("/discover",body);lastStartedJob=r.job_id;selected.clear();setView("current");message("Úloha "+r.job_id+" beží na serveri. Zobrazujem iba jej výsledky.");await refresh();
 }catch(error){message(error.message);$("start").disabled=false;}
});
$("backlog").addEventListener("click",async()=>{
 $("backlog").disabled=true;
 try{
  const body={keywords:[],sources:["local_frontier"],max_queries:1,max_validate:Number($("validate").value),target_new:1,backlog_only:true};
  const r=await api("/discover",body);lastStartedJob=r.job_id;selected.clear();setView("current");message("Overovanie lokálneho zásobníka "+r.job_id+" beží na serveri.");await refresh();
 }catch(error){message(error.message);$("backlog").disabled=false;}
});
$("indexSearch").addEventListener("submit",async e=>{
 e.preventDefault();try{const r=await api("/search?q="+encodeURIComponent($("query").value)+"&limit=1000");jobFilter=new Set(r.results.map(i=>i.url));await refresh();setView("all",false);message(r.results.length+" výsledkov v indexe.");}catch(error){message(error.message);}
});
async function init(){
 const cached=await cacheRead();if(cached)state=cached;
 let settings;
 if(extension)settings=(await chrome.storage.local.get("settings")).settings;
 else try{settings=JSON.parse(localStorage.getItem("filesterSettings"));}catch{}
 if(settings){
  $("keywords").value=settings.keywords||"";
  $("budget").value=settings.budget||30;
  $("validate").value=settings.validate??50;
  $("compactToggle").checked=!!settings.compact;
  for(const id of ["minSize","maxSize","minFiles","maxFiles"])$(id).value=settings[id]??"";
  document.querySelectorAll('[name="source"]').forEach(e=>e.checked=(settings.sources||[]).includes(e.value));
 }
 if(extension){const {pendingKeyword}=await chrome.storage.local.get("pendingKeyword");if(pendingKeyword){$("keywords").value=pendingKeyword;await chrome.storage.local.remove("pendingKeyword");}}
 ensureRefreshButtons();ensureReviewRefreshButton();jobFilter=new Set();render();await refresh();setInterval(refresh,5000);
}
async function saveSettings(){
 const settings={keywords:$("keywords").value,budget:Number($("budget").value),validate:Number($("validate").value),compact:$("compactToggle").checked,sources:[...document.querySelectorAll('[name="source"]:checked')].map(e=>e.value),minSize:$("minSize").value,maxSize:$("maxSize").value,minFiles:$("minFiles").value,maxFiles:$("maxFiles").value};
 if(extension)await chrome.storage.local.set({settings});
 else localStorage.setItem("filesterSettings",JSON.stringify(settings));
}
document.querySelectorAll('#discover input').forEach(e=>e.addEventListener("change",()=>saveSettings().catch(e=>message(e.message))));
for(const id of ["minSize","maxSize","minFiles","maxFiles"])$(id).addEventListener("change",()=>saveSettings().catch(e=>message(e.message)));
document.addEventListener("keydown",event=>{
 if(event.altKey||event.ctrlKey||event.metaKey||event.target.matches("input:not([type=checkbox]),textarea,select,button,a"))return;
 const cards=[...document.querySelectorAll("#results .card")];if(!cards.length)return;
 const current=event.target.closest("#results .card"),index=cards.indexOf(current);
 if(["j","ArrowDown","k","ArrowUp"].includes(event.key)){
  event.preventDefault();const direction=event.key==="j"||event.key==="ArrowDown"?1:-1;
  const next=cards[Math.max(0,Math.min(cards.length-1,index<0?(direction>0?0:cards.length-1):index+direction))];next.focus();next.scrollIntoView({block:"nearest"});
 }else if(current&&event.key.toLowerCase()==="x"){
  event.preventDefault();current.querySelector('input[type="checkbox"]')?.click();
 }else if(current&&event.key.toLowerCase()==="y"){
  event.preventDefault();annotate(current.resultItem,{relevance:current.resultItem.relevance===1?0:1}).catch(error=>message(error.message));
 }else if(current&&event.key.toLowerCase()==="n"){
  event.preventDefault();annotate(current.resultItem,{relevance:current.resultItem.relevance===-1?0:-1}).catch(error=>message(error.message));
 }
});
init().catch(e=>message(e.message));
