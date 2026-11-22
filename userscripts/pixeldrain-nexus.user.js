// ==UserScript==
// @name        Pixeldrain Nexus Gallery
// @namespace   Violentmonkey Scripts
// @match       https://pixeldrain.com/l/*
// @version     3.1.0
// @grant       GM_addStyle
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_xmlhttpRequest
// @connect     127.0.0.1
// @run-at      document-idle
// ==/UserScript==

(() => {
    'use strict';
    if (document.getElementById('pd-nexus-style')) return;
    let cfg;
    try { cfg = {...{thumb_size:280,port:8000}, ...JSON.parse(GM_getValue('pixeldrain_cfg','{}'))}; }
    catch { cfg = {thumb_size:280,port:8000}; }
    const save = () => GM_setValue('pixeldrain_cfg',JSON.stringify(cfg));
    const selected = new Set(), records = new Map();
    let files = [], panel, sort = 'index', dir = 1;
    const node = (tag,text,cls) => { const n=document.createElement(tag); if(text!=null)n.textContent=text; if(cls)n.className=cls; return n; };
    const direct = f => `https://pixeldrain.com/api/file/${encodeURIComponent(f.id)}`;
    const watch = f => `https://pixeldrain.com/u/${encodeURIComponent(f.id)}`;
    function thumbnail(icon, f) {
        // Keep Pixeldrain's native thumbnail; 512px requests are rejected.
        if (getComputedStyle(icon).backgroundImage !== 'none') return;
        const sizes = [256, 128];
        const load = () => {
            const size = sizes.shift(); if (!size || !icon.isConnected) return;
            const url = `${direct(f)}/thumbnail?width=${size}&height=${size}`;
            const image = new Image();
            image.onload = () => { if (icon.isConnected) icon.style.backgroundImage = `url("${url}")`; };
            image.onerror = load; image.src = url;
        };
        load();
    }
    const videoFile = f => /^video\//.test(f.mime_type||'') || /\.(mp4|m4v|webm|mkv|mov|avi)$/i.test(f.name);
    const time = n => Number.isFinite(n) ? `${Math.floor(n/3600)?Math.floor(n/3600)+':':''}${String(Math.floor(n/60)%60).padStart(2,'0')}:${String(Math.floor(n%60)).padStart(2,'0')}` : 'neznáma';
    const css=GM_addStyle(`
      .gallery>.file.pd-card{position:relative!important;width:var(--pd-size)!important;height:auto!important;min-height:0!important;display:flex!important;flex-direction:column!important;background:#202326!important;border:2px solid #414852!important;border-radius:10px!important;overflow:hidden!important;text-decoration:none!important}
      .gallery>.file.pd-card[hidden]{display:none!important}.gallery>.file.pd-selected{border-color:#61bcff!important;box-shadow:0 0 0 2px #61bcff66}
      .pd-card .icon_container{position:relative!important;height:calc(var(--pd-size)*.95)!important;width:100%!important;background-position:center!important;background-size:cover!important;isolation:isolate}.pd-card>.name,.pd-card .icon_container .name{display:none!important}
      .pd-card .icon_container:after{content:'';position:absolute;inset:0;z-index:0;pointer-events:none;background:linear-gradient(180deg,#000b,transparent 34%,transparent 52%,#000e)}
      .pd-overlay{position:absolute;inset:0;z-index:3;pointer-events:none;font-family:system-ui,sans-serif;color:#fff}
      .pd-badge{position:absolute;padding:5px 8px;border:1px solid currentColor;border-radius:7px;background:#101820e8;font-size:clamp(12px,calc(var(--pd-size)*.047),19px);font-weight:750;line-height:1.2;white-space:nowrap;box-shadow:0 2px 8px #0008}
      .pd-views{left:10px;top:53px;color:#7dd3fc}.pd-format{right:10px;top:10px;color:#d8b4fe}.pd-size{left:10px;bottom:58px;color:#6ee7b7}.pd-duration{right:10px;bottom:58px;color:#fcd34d}
      .pd-date{position:absolute;top:13px;left:50%;transform:translateX(-50%);font-size:clamp(12px,calc(var(--pd-size)*.043),17px);font-weight:650;text-shadow:0 2px 4px #000;background:#101820cc;border-radius:5px;padding:4px 6px;white-space:nowrap}
      .pd-title{position:absolute;bottom:12px;left:12px;right:12px;text-align:center;font-size:clamp(16px,calc(var(--pd-size)*.062),25px);line-height:1.2;font-weight:750;text-shadow:0 2px 5px #000;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
      .pd-actions{position:absolute;left:8px;right:8px;top:calc(50% + 40px);z-index:12;display:flex;gap:6px;padding:8px;border-radius:9px;background:#101820f2;opacity:0;visibility:hidden;transform:translateY(8px);transition:opacity .18s,transform .18s,visibility .18s}
      .pd-actions button{flex:1;min-width:0}.pd-card:hover .pd-actions,.pd-card:focus-within .pd-actions,.pd-card.pd-actions-open .pd-actions{opacity:1;visibility:visible;transform:translateY(0)}
      .pd-card .pd-more{position:absolute;right:10px;top:52px;z-index:13;font-size:22px;padding:0 9px;line-height:30px;background:#101820e8}
      .pd-card button:focus-visible{outline:3px solid #fff;outline-offset:2px}
      .pd-select{position:absolute!important;left:9px;top:9px;z-index:10;background:#101820e8;border-radius:7px;padding:6px;cursor:pointer}.pd-select input{width:23px;height:23px;margin:0;accent-color:#168bd3;cursor:pointer}
      .pd-play{position:absolute!important;top:50%;left:50%;transform:translate(-50%,-50%);width:62px;height:62px;border-radius:50%!important;background:#101820d9!important;font-size:28px!important;z-index:2}
      #pd-sidebar-controls{display:flex;flex-direction:column;gap:8px;padding:12px 5px;border-top:1px solid #777;color:#fff;font:13px system-ui}
      #pd-sidebar-controls label{display:flex;flex-direction:column;gap:4px}#pd-sidebar-controls input,#pd-sidebar-controls select{box-sizing:border-box;width:100%;min-width:0;background:#20242c;color:white;border:1px solid #697482;border-radius:5px;padding:7px}
      #pd-sidebar-controls button,.pd-card button,.pd-modal button{cursor:pointer;background:#245681;color:white;border:1px solid #7ba0bd;border-radius:5px;padding:8px;font:600 12px system-ui}button.pd-busy{opacity:.5}
      .pd-pair{display:grid;grid-template-columns:1fr 1fr;gap:4px}#pd-status{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.4}
      .pd-modal{position:fixed;inset:0;background:#000d;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:20px}.pd-player{background:#20242c;padding:15px;border-radius:10px;width:min(1100px,95vw);color:#fff;font:14px system-ui}.pd-player header{display:flex;gap:12px;justify-content:space-between;margin-bottom:10px;overflow-wrap:anywhere}.pd-player video{display:block;width:100%;max-height:75vh;background:black}.pd-player a{color:#82cfff}
    `);
    if(css)css.id='pd-nexus-style';
    document.documentElement.style.setProperty('--pd-size',`${Math.max(150,Math.min(500,Number(cfg.thumb_size)||280))}px`);
    const get = id => panel.querySelector('#pd-'+id);
    const status = text => { if(panel)get('status').textContent=text; else console.warn('[Pixeldrain]',text); };
    function button(text,action,parent) {
        const b=node('button',text); b.type='button';
        b.addEventListener('click',async e=>{e.preventDefault();e.stopPropagation();try{await action(b);}catch(error){status(error.message);}});
        parent.append(b);return b;
    }
    function apply() {
        if(!panel)return;
        const val=id=>get(id).value, num=id=>val(id)===''?null:Number(val(id));
        const min=num('size-min'),max=num('size-max'),dmin=num('duration-min'),dmax=num('duration-max');
        for(const [id,r] of records){
            const f=r.f, day=(f.date_upload||'').slice(0,10),mb=f.size/1e6;
            r.card.hidden=!(f.name.toLowerCase().includes(val('search').toLowerCase())&&(min===null||mb>=min)&&(max===null||mb<=max)&&(!val('date-min')||day>=val('date-min'))&&(!val('date-max')||(day&&day<=val('date-max')))&&((dmin===null&&dmax===null)||(Number.isFinite(f.duration)&&(dmin===null||f.duration>=dmin*60)&&(dmax===null||f.duration<=dmax*60))));
            r.check.checked=selected.has(id);r.card.classList.toggle('pd-selected',r.check.checked);
        }
        const ordered=[...records.values()].sort((a,b)=>{
            const value=f=>sort==='date_upload'?Date.parse(f[sort]):f[sort]; const x=value(a.f),y=value(b.f);
            if(!Number.isFinite(x))return Number.isFinite(y)?1:a.f.index-b.f.index;
            if(!Number.isFinite(y))return -1;
            return (x-y)*dir||a.f.index-b.f.index;
        });
        ordered.forEach((r,i)=>{r.card.style.order=String(i);});
        const visible=ordered.filter(r=>!r.card.hidden);
        get('count').textContent=`Viditeľné ${visible.length}/${files.length} · vybrané ${selected.size} · skryté vybrané ${files.filter(f=>selected.has(f.id)&&(!records.has(f.id)||records.get(f.id).card.hidden)).length}`;
    }
    function setDuration(f,n){if(!Number.isFinite(n)||n<=0)return;f.duration=n;GM_setValue('pd-duration-'+f.id,n);const r=records.get(f.id);if(r)r.duration.textContent='⏱ '+time(n);apply();}
    function probe(f){return new Promise(resolve=>{
        const v=node('video');let done=false;
        const finish=()=>{if(done)return;done=true;clearTimeout(timer);v.onloadedmetadata=v.onerror=null;v.removeAttribute('src');v.load();resolve();};
        const timer=setTimeout(finish,18000);v.preload='metadata';v.muted=true;
        v.onloadedmetadata=()=>{setDuration(f,v.duration);finish();};v.onerror=finish;v.src=direct(f);
    });}
    async function durations(b){
        b.disabled=true;const pending=files.filter(f=>videoFile(f)&&!Number.isFinite(f.duration));let next=0,complete=0;
        try{await Promise.all(Array.from({length:Math.min(2,pending.length)},async()=>{while(next<pending.length){await probe(pending[next++]);status(`Dĺžky: ${++complete}/${pending.length}. Neznáme možno skúsiť znova.`);}}));if(!pending.length)status('Dĺžky sú už načítané.');}finally{b.disabled=false;}
    }
    async function importFiles(list,b){
        if(!list.length)return status('Najprv vyber karty.');b.disabled=true;status(`Importujem ${list.length} súborov…`);
        try{
            const result=await new Promise((resolve,reject)=>GM_xmlhttpRequest({method:'POST',url:`http://127.0.0.1:${cfg.port}/api/v1/import/bulk`,headers:{'Content-Type':'application/json',...(cfg.token?{'X-Nexus-Token':cfg.token}:{})},timeout:60000,
                data:JSON.stringify({batch_name:`Pixeldrain ${location.pathname.split('/').pop()}`,videos:list.map(f=>({url:watch(f),source_url:watch(f),direct_url:direct(f),source_scope:'video',title:f.name,thumbnail:direct(f)+'/thumbnail?width=256&height=256',filesize:f.size,duration:f.duration||0,views:f.views||0,upload_date:f.date_upload||''}))}),
                onload:r=>{try{const data=JSON.parse(r.responseText);if(r.status<200||r.status>=300)throw new Error(`Nexus HTTP ${r.status}: ${JSON.stringify(data.detail||data)}`);resolve(data);}catch(e){reject(e);}},
                onerror:()=>reject(new Error('Nexus nie je dostupný. Skontroluj port a povolenie userscriptu pre 127.0.0.1.')),ontimeout:()=>reject(new Error('Nexus neodpovedal do 60 s. Pred opakovaním skontroluj import v Nexus.'))}));
            status(`Importované: ${result.imported ?? result.count ?? 0} · duplicity: ${result.duplicates ?? 0} · chyby: ${result.errors ?? 0}` + (result.errors ? '\n' + JSON.stringify(result.skipped || []) : ''));
        }finally{b.disabled=false;}
    }
    function download(f){const a=node('a');a.href=direct(f)+'?download';a.download=f.name;a.target='_blank';a.rel='noopener';document.body.append(a);a.click();a.remove();}
    function play(f){
        document.querySelector('.pd-modal')?.dispatchEvent(new Event('pd-close'));
        const previous=document.activeElement,overlay=node('div',null,'pd-modal'),box=node('section',null,'pd-player'),header=node('header'),v=node('video'),hint=node('p','Načítavam video…');
        box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-label',f.name);header.append(node('strong',f.name));
        const close=()=>{v.pause();v.removeAttribute('src');v.load();overlay.remove();document.removeEventListener('keydown',keys);previous?.focus();};
        const closeButton=button('Zavrieť ✕',close,header),link=node('a','Otvoriť priamu URL');link.href=direct(f);link.target='_blank';link.rel='noopener';
        const keys=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}if(e.key==='Tab'){if(e.shiftKey&&document.activeElement===closeButton){e.preventDefault();link.focus();}else if(!e.shiftKey&&document.activeElement===link){e.preventDefault();closeButton.focus();}}};
        v.controls=true;v.autoplay=true;v.playsInline=true;v.preload='metadata';v.src=direct(f);
        v.addEventListener('loadedmetadata',()=>setDuration(f,v.duration));v.addEventListener('playing',()=>{hint.textContent='';});v.addEventListener('error',()=>{hint.textContent='Video sa nedá prehrať (kodek, limit alebo prístup). Skús priamu URL alebo STIAHNUŤ.';});
        box.append(header,v,hint,link);overlay.append(box);document.body.append(overlay);overlay.addEventListener('click',e=>{if(e.target===overlay)close();});overlay.addEventListener('pd-close',close,{once:true});document.addEventListener('keydown',keys);closeButton.focus();
        (async()=>{try{await v.play();}catch{hint.textContent='Prehliadač pozastavil prehrávanie. Stlač Play v prehrávači.';}})();
    }
    function controls(){
        const toolbar=document.querySelector('.toolbar');if(!toolbar||panel)return;panel=node('section');panel.id='pd-sidebar-controls';
        panel.innerHTML=`<strong>Nexus · Pixeldrain</strong><input id="pd-search" aria-label="Hľadať názov" placeholder="Hľadať názov…"><div id="pd-count" role="status"></div><div id="pd-selection"></div>
        <label>Veľkosť kariet<input id="pd-thumb" type="range" min="150" max="500"></label>
        <label>Veľkosť súboru (MB)<div class="pd-pair"><input id="pd-size-min" type="number" min="0" placeholder="Od" aria-label="Veľkosť od MB"><input id="pd-size-max" type="number" min="0" placeholder="Do" aria-label="Veľkosť do MB"></div></label>
        <label>Dátum od<input id="pd-date-min" type="date"></label><label>Dátum do<input id="pd-date-max" type="date"></label>
        <label>Trvanie (minúty)<div class="pd-pair"><input id="pd-duration-min" type="number" min="0" step="any" placeholder="Od" aria-label="Trvanie od minút"><input id="pd-duration-max" type="number" min="0" step="any" placeholder="Do" aria-label="Trvanie do minút"></div></label>
        <small>Filter trvania skryje videá s neznámou dĺžkou.</small><div id="pd-duration-actions"></div>
        <label>Zoradiť<select id="pd-sort"><option value="index">Pôvodné poradie</option><option value="size">Veľkosť</option><option value="date_upload">Dátum</option><option value="duration">Trvanie</option></select></label><div id="pd-direction"></div>
        <label>Nexus port<input id="pd-port" type="number" min="1" max="65535"></label><label>Token (ak treba)<input id="pd-token" type="password" autocomplete="off"></label><div id="pd-batch"></div><div id="pd-status" role="status" aria-live="polite"></div>`;
        toolbar.append(panel);get('thumb').value=cfg.thumb_size;get('port').value=cfg.port;get('token').value=cfg.token||'';
        button('Vybrať všetky viditeľné',()=>{for(const [id,r]of records)if(!r.card.hidden)selected.add(id);apply();},get('selection'));
        button('Zrušiť celý výber',()=>{selected.clear();apply();},get('selection'));
        button('Načítať dĺžky videí',durations,get('duration-actions'));
        button('Zostupne ↓ / vzostupne ↑',b=>{dir*=-1;b.textContent=dir===1?'Vzostupne ↑':'Zostupne ↓';apply();},get('direction'));
        button('IMPORTUJ vybrané',b=>importFiles(files.filter(f=>selected.has(f.id)),b),get('batch'));
        button('Kopírovať linky',async()=>{const list=selected.size?files.filter(f=>selected.has(f.id)):[...records.values()].filter(r=>!r.card.hidden).map(r=>r.f);await navigator.clipboard.writeText(list.map(watch).join('\n'));status(`Skopírované: ${list.length} odkazov.`);},get('batch'));
        button('Zrušiť filtre',()=>{for(const id of ['search','size-min','size-max','date-min','date-max','duration-min','duration-max'])get(id).value='';apply();},get('batch'));
        panel.addEventListener('input',e=>{if(e.target.id==='pd-thumb'){cfg.thumb_size=Number(e.target.value);document.documentElement.style.setProperty('--pd-size',cfg.thumb_size+'px');save();}apply();});
        get('sort').addEventListener('change',e=>{sort=e.target.value;apply();});
        get('port').addEventListener('change',e=>{if(!e.target.checkValidity()||!e.target.value){e.target.value=cfg.port;return;}cfg.port=Number(e.target.value);save();});
        get('token').addEventListener('change',e=>{cfg.token=e.target.value.trim();save();});
    }
    function enhance(){
        controls();const gallery=document.querySelector('.gallery');if(!gallery)return;
        for(const card of gallery.querySelectorAll(':scope > .file')){
            if(card.dataset.pdEnhanced)continue;
            const href=card.getAttribute('href')||card.querySelector('a')?.getAttribute('href');let f;
            if(href){const u=new URL(href,location.href),id=u.pathname.match(/\/u\/([^/]+)/)?.[1],i=u.hash.match(/(?:^#|&)item=(\d+)/)?.[1];f=id?files.find(f=>f.id===id):i!==undefined?files[Number(i)]:null;}
            // Bind by stable file ID or Pixeldrain item index, never current DOM position.
            if(!f)continue;if(records.get(f.id)?.card.isConnected)continue;
            card.dataset.pdEnhanced='1';card.classList.add('pd-card');
            for(const child of [...card.childNodes])if(child.nodeType===Node.TEXT_NODE)child.remove();
            const label=node('label',null,'pd-select'),check=node('input');check.type='checkbox';check.setAttribute('aria-label','Vybrať '+f.name);label.append(check);card.append(label);
            label.addEventListener('click',e=>e.stopPropagation());check.addEventListener('change',()=>{check.checked?selected.add(f.id):selected.delete(f.id);apply();});
            const icon=card.querySelector('.icon_container');if(icon){thumbnail(icon,f);if(videoFile(f))button('▶',()=>play(f),icon).classList.add('pd-play');}
            const overlay=node('div',null,'pd-overlay'),duration=node('span','⏱ '+time(f.duration),'pd-badge pd-duration');
            const badge=(text,cls,title)=>{const el=node('span',text,'pd-badge '+cls);el.title=title;overlay.append(el);};
            badge(`👁 ${Number(f.views||0).toLocaleString('sk')}`,'pd-views','Počet zobrazení');
            badge((f.name.split('.').pop()||'SÚBOR').toUpperCase().slice(0,8),'pd-format','Formát súboru');
            badge(`💾 ${(f.size/1e6).toFixed(0)} MB`,'pd-size','Veľkosť súboru');
            overlay.append(node('span',f.date_upload?new Date(f.date_upload).toLocaleDateString('sk'):'Bez dátumu','pd-date'));
            if(videoFile(f))overlay.append(duration);
            const title=node('div',f.name,'pd-title');title.title=f.name;overlay.append(title);
            (icon||card).append(overlay);
            const actions=node('div',null,'pd-actions');button('Importovať',b=>importFiles([f],b),actions);button('Stiahnuť',()=>download(f),actions);
            const more=button('⋯',()=>{const open=card.classList.toggle('pd-actions-open');more.setAttribute('aria-expanded',String(open));},card);more.classList.add('pd-more');more.setAttribute('aria-label','Akcie pre '+f.name);more.setAttribute('aria-expanded','false');
            card.addEventListener('keydown',e=>{if(e.key==='Escape'){card.classList.remove('pd-actions-open');more.setAttribute('aria-expanded','false');more.blur();}});
            card.append(actions);records.set(f.id,{f,card,check,duration});
        }
        for(const [id,r]of records)if(!r.card.isConnected)records.delete(id);apply();
    }
    async function init(){
        const id=location.pathname.match(/^\/l\/([^/]+)/)?.[1];if(!id)return;
        try{const r=await fetch('/api/list/'+encodeURIComponent(id));if(!r.ok)throw new Error('Pixeldrain HTTP '+r.status);const data=await r.json();if(!Array.isArray(data.files))throw new Error(data.message||'Chýba zoznam súborov.');
            files=data.files.map((f,index)=>{const cached=Number(GM_getValue('pd-duration-'+f.id,0));return {...f,index,duration:cached>0?cached:undefined};});enhance();
            let scheduled=false;new MutationObserver(changes=>{if(scheduled||!changes.some(m=>[...m.addedNodes,...m.removedNodes].some(n=>n.nodeType===1&&(n.matches?.('.file,.gallery,.toolbar')||n.querySelector?.('.file,.gallery,.toolbar')))))return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;enhance();});}).observe(document.body,{childList:true,subtree:true});
        }catch(error){controls();status('Chyba: '+error.message);}
    }
    init();
})();

