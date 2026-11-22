// ==UserScript==
// @name         Fileditch Album Workspace for Nexus
// @namespace    nexus.fileditch.album.workspace
// @version      1.2.0
// @description  Prehľadný album: filtre, čitateľné karty, trvalý výber, prezreté, export a kontrolovaný Nexus import.
// @match        https://fileditchalbums.st/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  'use strict';
  const VIDEO = /\.(mp4|m4v|webm|mkv|mov|avi|wmv|ts)$/i;
  const IMAGE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;
  function mediaUrl(raw, base) {
    try {
      const u = new URL(raw, base);
      return u.protocol === 'https:' && /(^|\.)(fileditchvids|fileditchfiles)\.st$/i.test(u.hostname) ? u.href : '';
    } catch { return ''; }
  }
  function identity(raw) { const u = new URL(raw); return u.origin + u.pathname; }
  function typeOf(raw) {
    const path = new URL(raw).pathname;
    return VIDEO.test(path) ? 'video' : IMAGE.test(path) ? 'image' : 'other';
  }
  function sizeBytes(text) {
    const m = String(text).replace(/\s/g, '').match(/([\d.,]+)([KMGT]?i?B)/i);
    if (!m) return 0;
    const n = Number(m[1].replace(',', '.'));
    const power = ['B','KB','MB','GB','TB'].indexOf(m[2].toUpperCase().replace('I',''));
    return Number.isFinite(n) && power >= 0 ? n * (m[2].toLowerCase().includes('i') ? 1024 : 1000) ** power : 0;
  }
  function visibleItems(items, state, selected, reviewed) {
    const query = state.query.trim().toLocaleLowerCase();
    const result = items.filter(i => (!query || i.title.toLocaleLowerCase().includes(query)) &&
      (state.type === 'all' || state.type === i.type) &&
      (state.scope !== 'selected' || selected.has(i.id)) &&
      (state.scope !== 'unreviewed' || !reviewed.has(i.id)) &&
      (state.scope !== 'reviewed' || reviewed.has(i.id)));
    const compare = { name:(a,b) => a.title.localeCompare(b.title, undefined, {numeric:true}),
      size:(a,b) => b.bytes-a.bytes, date:(a,b) => b.date-a.date, native:(a,b) => a.index-b.index };
    return result.sort(compare[state.sort] || compare.native);
  }
  // Pure helpers are also used by the Node regression tests; no browser globals needed.
  if (typeof module !== 'undefined' && module.exports && typeof document === 'undefined') {
    module.exports = {mediaUrl, identity, typeOf, sizeBytes, visibleItems}; return;
  }
  if (!/^\/[a-z0-9]{10}\/?$/i.test(location.pathname) || document.getElementById('fdw-toolbar')) return;
  const grid = document.querySelector('.grid');
  if (!grid || !grid.querySelector('article.card a.name')) return;

  const KEY = 'nexus-fileditch:v1';
  const album = location.origin + location.pathname.replace(/\/$/, '');
  const albumKey = `${KEY}:${album}`;
  function read(key) { try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; } }
  const saved = read(albumKey), prefs = read(`${KEY}:prefs`);
  const metadata = read(`${albumKey}:metadata`);
  const selected = new Set(Array.isArray(saved.selected) ? saved.selected.filter(x=>typeof x==='string') : []);
  const reviewed = new Set(Array.isArray(saved.reviewed) ? saved.reviewed.filter(x=>typeof x==='string') : []);
  const state = {query:'', type:'all', scope:'all', sort:'native', layout:['compact','comfort','list'].includes(prefs.layout) ? prefs.layout : 'comfort', quiet:prefs.quiet !== false};
  let items = [], lastId = '', noticeTimer, renderToken = 0, storageWarning = false, importing = false;
  const gm = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function' ? GM.xmlHttpRequest.bind(GM) : null;
  const el = (tag, attrs = {}, text = '') => {
    const node = document.createElement(tag);
    for (const [k,v] of Object.entries(attrs)) node.setAttribute(k, v);
    node.textContent = text; return node;
  };
  function persist() {
    try {
      localStorage.setItem(albumKey, JSON.stringify({selected:[...selected], reviewed:[...reviewed]}));
      localStorage.setItem(`${KEY}:prefs`, JSON.stringify({...read(`${KEY}:prefs`),layout:state.layout, quiet:state.quiet}));
    } catch { if (!storageWarning) { storageWarning = true; notice('Úložisko nie je dostupné. Výber zostane len do obnovenia stránky.'); } }
  }
  const style = el('style', {id:'fdw-style'});
  style.textContent = `
    body.fdw-active{padding:20px 18px 100px!important;font-family:system-ui,sans-serif!important}
    .fdw-active .wrap{max-width:none!important;width:100%!important;padding:18px!important}
    .fdw-active .title{font:700 26px/1.3 system-ui,sans-serif!important;margin-bottom:8px}
    .fdw-active .meta{margin-bottom:18px}.fdw-active form.find,.fdw-active #fda-copy{display:none!important}
    body.fdw-active.fdw-quiet #nvs-sort-panel,body.fdw-active.fdw-quiet #nvs-thread-tools,body.fdw-active.fdw-quiet #nvs-import-bar,body.fdw-active.fdw-quiet #nvs-scan-hud-pill,body.fdw-active.fdw-quiet #nvs-scan-hud-panel,body.fdw-active.fdw-quiet #nvs-overview-launch{display:none!important}
    #fdw-toolbar,#fdw-toolbar *,#fdw-actions,#fdw-actions *,#fdw-dialog,#fdw-dialog *{font-family:system-ui,sans-serif!important}
    #fdw-toolbar,#fdw-actions,#fdw-dialog{font-size:14px;line-height:1.5;color:#e8edf5}
    #fdw-toolbar{background:#151e2d;border:1px solid #34445b;border-radius:12px;padding:16px;margin-bottom:20px}
    .fdw-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.fdw-row+.fdw-row{margin-top:12px}
    #fdw-toolbar input[type=search]{flex:1;min-width:180px}
    #fdw-options{margin-top:10px}#fdw-options>summary{cursor:pointer;color:#bcddf0;padding:5px 0;font-weight:600}#fdw-options>p{margin-top:10px;color:#afbed1;font-size:12px}
    #fdw-toolbar input,#fdw-toolbar select,#fdw-toolbar button,#fdw-actions button,#fdw-dialog input,#fdw-dialog button,#fdw-dialog select{font:inherit;background:#202d40;color:#eef3fb;border:1px solid #50617a;border-radius:7px;padding:8px 11px;min-height:38px}
    #fdw-toolbar label,#fdw-dialog label{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
    #fdw-toolbar button,#fdw-actions button,#fdw-dialog button{cursor:pointer}
    #fdw-toolbar button:disabled,#fdw-actions button:disabled,#fdw-dialog button:disabled{opacity:.45;cursor:default}
    #fdw-toolbar :focus-visible,#fdw-actions :focus-visible,#fdw-dialog :focus-visible,.fdw-card :focus-visible{outline:3px solid #65d9c0;outline-offset:3px}
    #fdw-status{color:#b7c6da;font-variant-numeric:tabular-nums}#fdw-status strong{color:#80e2cc}
    .fdw-active .grid{display:grid!important;grid-template-columns:repeat(auto-fill,minmax(min(100%,310px),1fr))!important;gap:18px!important}
    .fdw-active .grid[data-fdw-layout=compact]{grid-template-columns:repeat(auto-fill,minmax(min(100%,210px),1fr))!important;gap:12px!important}
    .fdw-active .fdw-card{position:relative;border:1px solid #354157!important;border-radius:10px!important;overflow:hidden;background:#171f2c!important;min-width:0}
    .fdw-active .fdw-card[data-fdw-selected=true]{border-color:#69d9bc!important;box-shadow:0 0 0 2px #69d9bc}
    .fdw-active .fdw-card[hidden]{display:none!important}
    .fdw-active .fdw-card .thumb{aspect-ratio:16/9!important;min-height:0!important}
    .fdw-active .fdw-card .name{display:block!important;white-space:normal!important;overflow:visible!important;min-height:0!important;font:600 14px/1.45 system-ui,sans-serif!important;overflow-wrap:anywhere;color:#ecf2fc!important}
    .fdw-active .fdw-card .cbody{padding:9px 10px 4px!important;min-height:0!important}.fdw-active .fdw-card .cmeta{font:12px/1.4 system-ui,sans-serif!important;color:#b8c4d5!important;display:flex!important;gap:8px;flex-wrap:wrap;margin:5px 0 0!important}
    .fdw-active .fdw-card .cmeta .date{display:inline!important}.fdw-duration{position:absolute;right:8px;bottom:8px;background:#101827e8;color:#fff;padding:3px 7px;border-radius:5px;font:600 12px system-ui,sans-serif}
    .fdw-active .fdw-card .cbody{display:block!important;padding:8px 10px 9px!important;flex:0 0 auto!important}
    .fdw-active .fdw-card .cmeta{min-height:0!important;gap:4px 8px!important;margin:4px 0 0!important}
    .fdw-active .fdw-card .cmeta .date{flex:0 0 auto!important;margin:0!important}
    .fdw-active .fdw-card .fdw-foot{position:absolute!important;top:8px!important;right:8px!important;z-index:4!important;padding:0!important}
    .fdw-active .fdw-card .fdw-review{background:#101827e8!important;color:#fff!important;padding:4px 7px!important;font-size:0!important;line-height:1!important}
    .fdw-active .fdw-card .fdw-review::before{content:'○';font-size:18px}
    .fdw-active .fdw-card .fdw-review[aria-pressed=true]::before{content:'✓';color:#68e3c2}
    .fdw-check{position:absolute;z-index:3;top:8px;left:8px;display:flex;gap:6px;align-items:center;background:#101827ed;color:#fff;border:1px solid #64748b;border-radius:7px;padding:5px 8px;font:13px system-ui,sans-serif;cursor:pointer}
    .fdw-check input{width:18px;height:18px;accent-color:#55cdb0}.fdw-foot{display:flex;justify-content:flex-end;align-items:center;padding:0 10px 8px;gap:8px}.fdw-type{display:none}
    .fdw-review{background:none;color:#bfd0e6;border:1px solid #4d607a;border-radius:6px;padding:5px 8px;cursor:pointer;font:12px system-ui,sans-serif}
    .fdw-type{color:#a5b6cd;font:12px system-ui,sans-serif}
    .fdw-active .grid[data-fdw-layout=list]{grid-template-columns:1fr!important}
    .fdw-active .grid[data-fdw-layout=list] .fdw-card{display:grid;grid-template-columns:200px 1fr;align-items:center}
    .fdw-active .grid[data-fdw-layout=list] .fdw-foot{grid-column:2}
    #fdw-actions{position:fixed;z-index:2147483000;bottom:14px;left:50%;transform:translateX(-50%);width:max-content;max-width:calc(100% - 24px);background:#152339f5;border:1px solid #5b799c;box-shadow:0 6px 35px #0009;border-radius:12px;padding:10px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    #fdw-actions[hidden],#fdw-empty[hidden]{display:none}#fdw-actions .fdw-primary,#fdw-dialog .fdw-primary{background:#246855;border-color:#65d9b8}
    #fdw-notice{position:fixed;z-index:2147483647;top:16px;right:16px;max-width:min(480px,90vw);background:#1b3340;border:1px solid #78d6c5;color:white;padding:12px 18px;border-radius:10px;font:14px/1.5 system-ui,sans-serif}
    #fdw-notice:empty{display:none}#fdw-empty{padding:36px;text-align:center;color:#bcc9db}
    #fdw-dialog{background:#172234;border:1px solid #647b9e;border-radius:14px;padding:24px;max-width:min(640px,94vw);max-height:90vh;margin:auto}
    #fdw-dialog::backdrop{background:#000a}#fdw-dialog h2{font-size:22px;margin-bottom:12px}#fdw-dialog p{margin:12px 0}#fdw-dialog ul{margin:12px 0;padding-left:22px;max-height:180px;overflow:auto;overflow-wrap:anywhere}#fdw-dialog label{margin:12px 0}
    @media(max-width:600px){.fdw-active .wrap{padding:12px!important}body.fdw-active{padding:8px 6px 160px!important}#fdw-toolbar{padding:12px}.fdw-active .grid[data-fdw-layout=list] .fdw-card{grid-template-columns:110px 1fr}#fdw-actions{bottom:6px;gap:6px}#fdw-actions button{padding:6px 8px}}
  `;
  document.head.append(style);
  document.body.classList.add('fdw-active');
  grid.dataset.fdwLayout = state.layout;
  const toolbar = el('section',{id:'fdw-toolbar','aria-label':'Fileditch Album Workspace'});
  const row = el('div',{class:'fdw-row'});
  row.append(el('strong',{},'Album Workspace'), el('span',{id:'fdw-status','aria-live':'polite'}));
  toolbar.append(row);
  const controls = el('div',{class:'fdw-row',id:'fdw-filters'});
  const search = el('input',{type:'search',placeholder:'Hľadať v načítaných súboroch…','aria-label':'Hľadať v načítaných súboroch'});
  search.addEventListener('input',()=>{state.query=search.value;render();});
  const searchRow=el('div',{class:'fdw-row'});searchRow.append(search);toolbar.append(searchRow);
  const options=el('details',{id:'fdw-options'});options.open=!window.matchMedia('(max-width:600px)').matches;
  options.append(el('summary',{},'Filtre, rozloženie a výber'));
  function selectControl(label, key, choices) {
    const wrapper = el('label',{},label), select = el('select',{'aria-label':label});
    for (const [value,name] of choices) select.append(el('option',{value},name));
    select.value = state[key];
    select.addEventListener('change',()=>{state[key]=select.value;persist();render();});
    wrapper.append(select);controls.append(wrapper);return select;
  }
  selectControl('Typ','type',[['all','Všetky'],['video','Videá'],['image','Obrázky'],['other','Ostatné']]);
  selectControl('Zobraziť','scope',[['all','Všetko'],['selected','Vybrané'],['unreviewed','Neprezreté'],['reviewed','Prezreté']]);
  selectControl('Zoradiť','sort',[['native','Pôvodne'],['name','Názov A–Z'],['size','Najväčšie'],['date','Najnovšie']]);
  selectControl('Rozloženie','layout',[['comfort','Pohodlné'],['compact','Kompaktné'],['list','Zoznam']]);
  options.append(controls);
  const selectionRow=el('div',{class:'fdw-row'});
  function button(parent,text,fn,attrs={}) {
    const b=el('button',{type:'button',...attrs},text);
    b.addEventListener('click',fn);parent.append(b);return b;
  }
  button(selectionRow,'Vybrať zobrazené',()=>{for(const i of current()) selected.add(i.id);changed();});
  button(selectionRow,'Zrušiť zobrazené',()=>{for(const i of current()) selected.delete(i.id);changed();});
  button(selectionRow,'Reset filtrov',()=>{state.query='';search.value='';state.type='all';state.scope='all';state.sort='native';for(const s of controls.querySelectorAll('select')){const key={'Typ':'type','Zobraziť':'scope','Zoradiť':'sort','Rozloženie':'layout'}[s.getAttribute('aria-label')];s.value=state[key];}render();});
  const metaPort=el('select',{'aria-label':'Port Nexus pre metadáta'});for(const p of [8000,8001,8002,8003])metaPort.append(el('option',{value:String(p)},`Nexus :${p}`));metaPort.value=['8000','8001','8002','8003'].includes(String(prefs.port))?String(prefs.port):'8000';selectionRow.append(metaPort);
  const metaButton=button(selectionRow,'Načítať dĺžku',fetchDurations,{title:'Načítať dĺžku vybraných videí, alebo zobrazených, ak nie je nič vybrané'});
  const metaStatus=el('span',{role:'status','aria-live':'polite'});selectionRow.append(metaStatus);
  const quietLabel = el('label'), quiet = el('input',{type:'checkbox'});
  quiet.checked=state.quiet;quietLabel.append(quiet,document.createTextNode('Skryť panely NVS'));
  quiet.addEventListener('change',()=>{state.quiet=quiet.checked;persist();render();});selectionRow.append(quietLabel);
  options.append(selectionRow,el('p',{},'Výber sa pamätá pre tento album. Shift + zaškrtnutie vyberie rozsah v aktuálnom poradí. Názov otvorí pôvodný súbor.'));
  toolbar.append(options);
  grid.before(toolbar);
  const empty=el('p',{id:'fdw-empty',hidden:''},'Žiadne načítané súbory nezodpovedajú filtru. Skús Reset filtrov.');grid.after(empty);
  const actions=el('section',{id:'fdw-actions',hidden:'','aria-label':'Akcie pre všetky vybrané súbory'});
  const summary=el('span');actions.append(summary);
  button(actions,'Kopírovať URL',async()=>{
    try { await navigator.clipboard.writeText(targets().map(i=>i.url).join('\n'));notice('URL všetkých vybraných súborov sú skopírované.'); }
    catch { showLinks(); }
  });
  button(actions,'Export JSON',()=>{
    const blob=new Blob([JSON.stringify({album_url:album,exported_at:new Date().toISOString(),items:targets().map(i=>({url:i.url,title:i.title,type:i.type,size_bytes:i.bytes,reviewed:reviewed.has(i.id)}))},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob), a=el('a',{href:url,download:`fileditch-${location.pathname.split('/')[1]}.json`});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);notice('Export JSON bol pripravený.');
  });
  const importButton=button(actions,'Import do Nexus…',reviewImport,{class:'fdw-primary'});
  button(actions,'Označiť prezreté',()=>{for(const i of targets())reviewed.add(i.id);changed();});
  button(actions,'Zrušiť celý výber',()=>{selected.clear();changed();});
  document.body.append(actions);
  const toast=el('div',{id:'fdw-notice',role:'status','aria-live':'polite'});document.body.append(toast);
  function notice(text){toast.textContent=text;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>{toast.textContent='';},7000);}
  function current(){return visibleItems(items,state,selected,reviewed);}
  function targets(){return items.filter(i=>selected.has(i.id));}
  function changed(){persist();render();}
  function formatDuration(seconds){const s=Math.floor(seconds);return s>=3600?`${Math.floor(s/3600)}:${String(Math.floor(s%3600/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`:`${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;}
  async function fetchDurations(){
    const pool=(targets().length?targets():current()).filter(i=>i.type==='video');
    if(!pool.length){metaStatus.textContent='Žiadne videá na načítanie.';return;}
    metaButton.disabled=true;let done=0,found=0;
    try{
      metaStatus.textContent='Hľadám Nexus…';
      const endpoint=await findNexus(metaPort.value);
      metaPort.value=endpoint.port;
      for(let n=0;n<pool.length;n+=6){
        const chunk=pool.slice(n,n+6);metaStatus.textContent=`Načítavam ${done}/${pool.length}…`;
        const data=await request(`${endpoint.origin}/api/tester/batch-meta`,{urls:chunk.map(i=>i.url)},120000);
        for(const result of data.results||[]){const item=chunk.find(i=>i.url===result.url);const duration=Number(result.duration);if(item&&Number.isFinite(duration)&&duration>0){metadata[item.id]={duration};found++;}}
        done+=chunk.length;try{localStorage.setItem(`${albumKey}:metadata`,JSON.stringify(metadata));}catch{}render();
      }
      metaStatus.textContent=`Dĺžka: ${found}/${pool.length}. Ostatné sa nepodarilo zistiť.`;
    }catch(e){metaStatus.textContent=`Načítanie zlyhalo: ${e.message}`;}finally{metaButton.disabled=false;}
  }
  async function findNexus(preferred){
    if(!gm)throw new Error('Táto funkcia vyžaduje Tampermonkey alebo Violentmonkey.');
    const ports=[...new Set([String(preferred),'8000','8001','8002','8003'])];
    for(const port of ports)for(const host of ['127.0.0.1','localhost']){
      const origin=`http://${host}:${port}`;
      const ok=await new Promise(resolve=>{try{gm({method:'GET',url:`${origin}/health`,timeout:1500,onload:r=>{try{const d=JSON.parse(r.responseText);resolve(r.status===200 && /nexus/i.test(String(d.service||'')));}catch{resolve(false);}},onerror:()=>resolve(false),ontimeout:()=>resolve(false)});}catch{resolve(false);}});
      if(ok)return {origin,port};
    }
    throw new Error('Nexus sa nenašiel na portoch 8000–8003. Skontroluj povolenie localhost v správcovi skriptov.');
  }
  async function render(){
    const token=++renderToken, visible=current(), ids=new Set(visible.map(i=>i.id)), chosen=targets();
    grid.dataset.fdwLayout=state.layout;document.body.classList.toggle('fdw-quiet',state.quiet);
    document.getElementById('fdw-status').textContent=`${visible.length} / ${items.length} načítaných · ${chosen.length} vybraných`;
    summary.textContent=`${chosen.length} vybraných · ${chosen.filter(i=>!ids.has(i.id)).length} mimo filtra`;
    actions.hidden=!chosen.length;empty.hidden=visible.length!==0;importButton.disabled=importing || !chosen.some(i=>i.type==='video');
    // CSS order preserves native nodes, canvas previews and their event handlers.
    const orders=new Map(visible.map((i,n)=>[i.id,n]));
    for(let start=0;start<items.length;start+=40){
      if(token!==renderToken)return;
      for(const i of items.slice(start,start+40)){
        i.node.hidden=!ids.has(i.id);i.node.style.order=String(orders.get(i.id)??items.length);
        i.node.dataset.fdwSelected=String(selected.has(i.id));i.check.checked=selected.has(i.id);
        i.review.textContent=reviewed.has(i.id)?'✓ Prezreté':'Označiť prezreté';i.review.setAttribute('aria-pressed',String(reviewed.has(i.id)));
        const duration=Number(metadata[i.id]?.duration)||0;i.duration.hidden=!duration;i.duration.textContent=duration?formatDuration(duration):'';
      }
      if(start+40<items.length)await new Promise(r=>requestAnimationFrame(r));
    }
  }
  function scan(){
    const existing=new Map(items.map(i=>[i.node,i])), seen=new Set(), next=[];
    for(const node of grid.querySelectorAll('article.card')){
      const link=node.querySelector('a.name[href]'), url=mediaUrl(link?.getAttribute('href'),location.href);
      if(!url)continue;
      const id=identity(url);if(seen.has(id))continue;seen.add(id);
      let item=existing.get(node);
      if(!item){
        const title=link.textContent.trim() || link.title;
        item={node,id,url,title,type:typeOf(url),bytes:sizeBytes(node.querySelector('.size')?.textContent),date:Date.parse((node.querySelector('.date')?.getAttribute('title')||'').replace(/^uploaded\s+/i,''))||0,index:next.length};
        node.classList.add('fdw-card');
        item.duration=el('span',{class:'fdw-duration',hidden:'','aria-label':'Dĺžka videa'});node.querySelector('.thumb')?.append(item.duration);
        const label=el('label',{class:'fdw-check'}), check=el('input',{type:'checkbox','aria-label':`Vybrať ${title}`});
        label.append(check,document.createTextNode('Vybrať'));node.prepend(label);item.check=check;
        check.addEventListener('click',event=>{
          event.stopPropagation();
          const list=current(), from=list.findIndex(i=>i.id===lastId), to=list.findIndex(i=>i.id===id);
          const range=event.shiftKey&&from>=0&&to>=0?list.slice(Math.min(from,to),Math.max(from,to)+1):[item];
          for(const i of range){if(check.checked)selected.add(i.id);else selected.delete(i.id);}lastId=id;changed();
        });
        const foot=el('div',{class:'fdw-foot'});foot.append(el('span',{class:'fdw-type'},{video:'Video',image:'Obrázok',other:'Súbor'}[item.type]));
        item.review=button(foot,'Označiť prezreté',()=>{if(reviewed.has(id))reviewed.delete(id);else reviewed.add(id);changed();},{class:'fdw-review','aria-label':`Prezreté: ${title}`});node.append(foot);
      }
      item.url=url;item.index=next.length;next.push(item);
    }
    items=next;render();
  }
  function dialog(title){
    document.getElementById('fdw-dialog')?.close();document.getElementById('fdw-dialog')?.remove();
    const d=el('dialog',{id:'fdw-dialog','aria-label':title});d.append(el('h2',{},title));
    const focus=document.activeElement;
    d.addEventListener('close',()=>{d.remove();if(focus?.isConnected)focus.focus();},{once:true});
    document.body.append(d);return d;
  }
  function showLinks(){
    const d=dialog('Vybrané URL'), text=el('textarea',{'aria-label':'Vybrané URL',rows:'8',readonly:'',style:'width:100%'});
    text.value=targets().map(i=>i.url).join('\n');d.append(el('p',{},'Automatické kopírovanie nie je dostupné. Použi Ctrl+C.'),text);button(d,'Zavrieť',()=>d.close());d.showModal();text.focus();text.select();
  }
  function request(url,body,timeout=30000){
    return new Promise((resolve,reject)=>{
      if(!gm){reject(new Error('Táto funkcia vyžaduje Tampermonkey alebo Violentmonkey.'));return;}
      gm({method:'POST',url,headers:{'Content-Type':'application/json'},data:JSON.stringify(body),timeout,
        onload:r=>{let data;try{data=JSON.parse(r.responseText);}catch{reject(new Error(`Neplatná odpoveď Nexus (HTTP ${r.status}).`));return;}if(r.status<200||r.status>=300)reject(new Error(typeof data.detail==='string'?data.detail:`HTTP ${r.status}`));else resolve(data);},
        onerror:()=>reject(new Error('Nexus nie je dostupný. Skontroluj spustený server a port.')),
        ontimeout:()=>reject(new Error('Odpoveď neprišla včas. Pri importe pred opakovaním skontroluj Import Desk; job už mohol vzniknúť.'))});
    });
  }
  function reviewImport(){
    if(importing)return;
    // Freeze the exact selection now. Filters and later checkbox changes cannot expand it.
    const chosen=targets().filter(i=>i.type==='video').map(i=>({...i}));if(!chosen.length)return;
    const all=targets(), visible=new Set(current().map(i=>i.id)), d=dialog('Skontrolovať import do Nexus');
    d.append(el('p',{},`${chosen.length} videí · ${chosen.filter(i=>!visible.has(i.id)).length} mimo filtra. ${all.length-chosen.length} ostatných súborov sa neimportuje.`));
    d.append(el('p',{},'Odošlú sa všetky videá uvedené nižšie. Výber a označenie prezretých zostanú zachované.'));
    const list=el('ul');for(const i of chosen)list.append(el('li',{},i.title));d.append(list);
    const portLabel=el('label',{},'Nexus port'),port=el('select',{'aria-label':'Nexus port'});
    for(const p of [8001,8000,8002,8003])port.append(el('option',{value:String(p)},String(p)));port.value=['8000','8001','8002','8003'].includes(String(prefs.port))?String(prefs.port):'8001';portLabel.append(port);d.append(portLabel);
    const batchLabel=el('label',{},'Názov batchu'),batch=el('input',{'aria-label':'Názov batchu',maxlength:'160'});
    batch.value=`Fileditch · ${document.querySelector('h1')?.textContent.trim() || 'Album'} · ${location.pathname.split('/')[1]}`;batchLabel.append(batch);d.append(batchLabel);
    const status=el('p',{role:'status','aria-live':'polite'});d.append(status);
    button(d,'Zrušiť',()=>d.close());
    const send=button(d,`Importovať ${chosen.length} videí`,async()=>{
      if(importing)return;importing=true;send.disabled=true;port.disabled=true;batch.disabled=true;render();
      status.textContent='Odosielam výber…';
      const candidates=chosen.map(i=>({url:i.url,source_url:i.url,title:i.title,file_size_mb:i.bytes/1024**2,source:'fileditch',tags:['fileditch','album-workspace'],confidence:0.98}));
      try{
        const result=await request(`http://localhost:${port.value}/api/v1/intake/import`,{batch_name:batch.value.trim()||`Fileditch · ${location.pathname.split('/')[1]}`,candidates,source_mode:'fileditch',auto_metadata:true,playwright_fallback:true});
        if(!result.job?.id)throw new Error('Server nepotvrdil ID import jobu. Skontroluj Import Desk pred opakovaním.');
        status.textContent=`Nexus prijal job #${result.job.id} · ${result.job.total_items ?? chosen.length} položiek. Priebeh nájdeš v Import Desk.`;
        send.textContent='Odoslané';notice(status.textContent);
        try{const p=read(`${KEY}:prefs`);localStorage.setItem(`${KEY}:prefs`,JSON.stringify({...p,port:port.value}));}catch{}
      }catch(error){status.textContent=error.message;send.disabled=false;port.disabled=false;batch.disabled=false;}
      finally{importing=false;render();}
    },{class:'fdw-primary'});
    d.showModal();
  }
  scan();
  // Observe only card insertion/removal. Native thumbnail animation and our controls do not rescan the album.
  let scanTimer;
  new MutationObserver(records=>{
    if(records.some(r=>[...r.addedNodes,...r.removedNodes].some(n=>n.nodeType===1&&(n.matches?.('article.card')||n.querySelector?.('article.card'))))){clearTimeout(scanTimer);scanTimer=setTimeout(scan,100);}
  }).observe(grid,{childList:true,subtree:true});
})();

