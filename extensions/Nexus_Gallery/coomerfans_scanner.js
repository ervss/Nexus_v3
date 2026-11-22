
// ============================================================
// NEXUS COOMERFANS SCANNER v3.0
// Extrahuje thumbnaile + tituly PRIAMO z listing stránky,
// post stránku navštívi len pre získanie MP4 URL.
// ============================================================

(function () {
  'use strict';

  const isProfile  = /^\/u\//.test(location.pathname);
  const isSearch   = location.pathname.startsWith('/post-search') || location.search.includes('q=');
  const isPostList = location.pathname.startsWith('/posts');
  if (!isProfile && !isSearch && !isPostList) return;
  if (document.getElementById('nexus-cf-panel')) return;

  // ── Settings ──────────────────────────────────────────────
  const KEY = 'nexus_cf_settings_v3';
  const HISTORY_KEY = 'nexus_cf_history_v1';
  const MAX_HISTORY = 50;
  function loadSettings() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
  function saveSettings(s) { localStorage.setItem(KEY, JSON.stringify(s)); }

  function _hasStorage() { return !!(typeof chrome !== 'undefined' && chrome?.storage?.local); }

  async function saveToHistory(batchName, videos) {
    if (!videos.length || !_hasStorage()) return;
    const history = await loadHistory();
    // Strip base64 thumbnails — they bloat storage past the 10MB quota
    const slim = videos.map(v => ({
      ...v,
      thumbnail: (v.thumbnail && v.thumbnail.startsWith('data:')) ? '' : (v.thumbnail || '')
    }));
    history.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      timestamp: Date.now(),
      pageUrl: location.href,
      batchName,
      videoCount: slim.length,
      videos: slim
    });
    if (history.length > MAX_HISTORY) history.splice(MAX_HISTORY);
    await saveHistorySafely(history);
  }
  // chrome.storage.local has a ~10MB quota; a batch of many large scans can exceed it.
  // Drop the oldest entries and retry instead of letting the write silently fail.
  function saveHistorySafely(list) {
    return new Promise(resolve => {
      const attempt = (entries) => {
        if (!entries.length) { resolve(); return; }
        chrome.storage.local.set({[HISTORY_KEY]: entries}, () => {
          if (chrome.runtime.lastError) {
            attempt(entries.slice(0, Math.max(0, entries.length - 5)));
          } else resolve();
        });
      };
      attempt(list);
    });
  }
  function loadHistory() {
    if (!_hasStorage()) return Promise.resolve([]);
    return new Promise(r => chrome.storage.local.get([HISTORY_KEY], d => {
      const raw = d[HISTORY_KEY] || [];
      // Strip any leftover base64 thumbnails from old entries to free up quota
      let dirty = false;
      const cleaned = raw.map(entry => {
        const vids = (entry.videos || []).map(v => {
          if (v.thumbnail && v.thumbnail.startsWith('data:')) { dirty = true; return {...v, thumbnail: ''}; }
          return v;
        });
        return dirty ? {...entry, videos: vids} : entry;
      });
      if (dirty) chrome.storage.local.set({[HISTORY_KEY]: cleaned});
      r(cleaned);
    }));
  }
  async function deleteHistoryEntry(id) {
    if (!_hasStorage()) return;
    const history = await loadHistory();
    chrome.storage.local.set({[HISTORY_KEY]: history.filter(e => e.id !== id)});
  }

  // ── State ─────────────────────────────────────────────────
  let scanning = false;
  let stopFlag = false;
  let foundVideos = [];
  let filteredVideos = [];
  let selectedUrls = new Set();
  // Tracks poster URLs already assigned within the current scan, so a shared/reused
  // og:image doesn't get attached to more than one video (see getVideoFromPost)
  let usedThumbUrls = new Set();
  // Exposed so inline onloadedmetadata handlers can update stored duration after CDN loads
  window._ncfUpdateDur = (url, dur) => {
    const v = foundVideos.find(x => x.videoUrl === url);
    if(v && dur > 0) v.duration = dur;
  };

  const modeLabel = isProfile ? '👤 Profil' : isSearch ? '🔍 Vyhľadávanie' : '📄 Príspevky';

  // ── Panel ─────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'nexus-cf-panel';
  panel.innerHTML = `
    <div id="nexus-cf-header">
      <span id="nexus-cf-logo">⚡ NEXUS</span>
      <span id="nexus-cf-title">Coomer Scanner</span>
      <button id="nexus-cf-minimize">─</button>
    </div>
    <div id="nexus-cf-mode-badge">${modeLabel}</div>
    <div id="nexus-cf-body">
      <div class="nexus-cf-row">
        <label>Max strán</label>
        <input id="nexus-cf-pages" type="number" min="1" max="999" value="20" />
      </div>
      <div class="nexus-cf-row">
        <label>Max videí</label>
        <input id="nexus-cf-limit" type="number" min="1" max="9999" value="100" />
      </div>
      <div class="nexus-cf-row">
        <label>Min. dur.</label>
        <div class="ncf-dur-filter">
          <input id="nexus-cf-dur-min" type="number" min="0" value="0" placeholder="0" />
          <span class="ncf-dur-unit">sek</span>
          <button id="nexus-cf-dur-apply" class="ncf-btn-filter">Filter</button>
        </div>
      </div>
      <div class="nexus-cf-row">
        <label>Batch</label>
        <input id="nexus-cf-batch" type="text" placeholder="auto" />
      </div>
      <div id="nexus-cf-actions">
        <button id="nexus-cf-scan" class="nexus-cf-btn-primary">🔍 Skenovať</button>
        <button id="nexus-cf-view" class="nexus-cf-btn-info" disabled>🎬 Zobraziť</button>
        <button id="nexus-cf-stop" class="nexus-cf-btn-danger" style="display:none">⏹ Stop</button>
      </div>
      <div id="nexus-cf-panel-copy" style="display:none">
        <button id="nexus-cf-copy-all" class="ncf-btn-copy-all">📋 Kopírovať URL (<span id="nexus-cf-copy-count">0</span>)</button>
      </div>
      <button id="nexus-cf-history-btn" class="ncf-btn-history">📚 História skenov</button>
      <div id="nexus-cf-progress" style="display:none">
        <div id="nexus-cf-progress-bar-wrap"><div id="nexus-cf-progress-bar"></div></div>
        <div id="nexus-cf-status">Čakám...</div>
      </div>
    </div>
  `;
  document.documentElement.appendChild(panel);

  // ── Load settings ─────────────────────────────────────────
  const saved = loadSettings();
  if (saved.pages)  document.getElementById('nexus-cf-pages').value = saved.pages;
  if (saved.limit)  document.getElementById('nexus-cf-limit').value = saved.limit;
  if (saved.durMin) document.getElementById('nexus-cf-dur-min').value = saved.durMin;
  let autoBatch = 'Coomerfans Import';
  if (isProfile) autoBatch = document.querySelector('h1,h2')?.textContent?.trim() || autoBatch;
  else if (isSearch) { const q = new URLSearchParams(location.search).get('q') || ''; autoBatch = q ? `CF: ${q}` : 'CF Search'; }
  document.getElementById('nexus-cf-batch').value = saved.batch || autoBatch;

  // ── Minimize / Drag ───────────────────────────────────────
  let minimized = false;
  document.getElementById('nexus-cf-minimize').addEventListener('click', () => {
    minimized = !minimized;
    document.getElementById('nexus-cf-body').style.display = minimized ? 'none' : '';
    document.getElementById('nexus-cf-minimize').textContent = minimized ? '□' : '─';
  });
  let dx=0,dy=0,drag=false;
  const hdr=document.getElementById('nexus-cf-header');
  hdr.addEventListener('mousedown',e=>{if(e.target.tagName==='BUTTON')return;drag=true;dx=e.clientX-panel.getBoundingClientRect().left;dy=e.clientY-panel.getBoundingClientRect().top;});
  document.addEventListener('mousemove',e=>{if(!drag)return;panel.style.left=(e.clientX-dx)+'px';panel.style.top=(e.clientY-dy)+'px';panel.style.right='auto';panel.style.bottom='auto';});
  document.addEventListener('mouseup',()=>{drag=false;});

  // ── Helpers ───────────────────────────────────────────────
  function setStatus(msg){const el=document.getElementById('nexus-cf-status');if(el)el.textContent=msg;}
  function setProgress(p){const el=document.getElementById('nexus-cf-progress-bar');if(el)el.style.width=Math.min(100,p)+'%';}
  function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
  function fmtDuration(sec){
    if(!sec||sec<=0)return '';
    const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=Math.round(sec%60);
    if(h>0)return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
  }
  function formatBytes(bytes, decimals=2){
    if(!bytes||bytes===0)return'0 B';
    const k=1024,dm=decimals<0?0:decimals,sizes=['B','KB','MB','GB','TB'],i=Math.floor(Math.log(bytes)/Math.log(k));
    return parseFloat((bytes/Math.pow(k,i)).toFixed(dm))+' '+sizes[i];
  }
  function fmtSize(bytes){
    if(!bytes||bytes<=0)return '';
    if(bytes>=1073741824)return(bytes/1073741824).toFixed(1)+' GB';
    if(bytes>=1048576)return(bytes/1048576).toFixed(0)+' MB';
    if(bytes>=1024)return(bytes/1024).toFixed(0)+' KB';
    return bytes+' B';
  }

  async function fetchDoc(url){
    try{
      const controller = new AbortController();
      const t = setTimeout(()=>controller.abort(), 10000);
      try {
          const r=await fetch(url,{
              headers:{Accept:'text/html','Cache-Control':'no-cache',Referer:'https://coomerfans.com/'},
              signal: controller.signal
          });
          if(!r.ok)return null;
          const text = await r.text();
          return new DOMParser().parseFromString(text,'text/html');
      } finally {
          clearTimeout(t);
      }
    }catch{return null;}
  }

  // ── URL builder ───────────────────────────────────────────
  function getPageUrl(page){
    if(isProfile){const base=location.origin+location.pathname;return page===1?base:`${base}?page=${page}`;}
    const u=new URL(location.href);u.searchParams.set('page',page);return u.toString();
  }

  // ── PHASE 1: Extract post cards from listing page ─────────
  // Returns: [{postUrl, thumbnail, title, isVideo}]
  function extractCardsFromDoc(doc){
    const cards=[];

    // Universal: find all post links, walk up to find their card container
    const seenUrls = new Set();
    doc.querySelectorAll('a[href*="/p/"]').forEach(a=>{
      const href=a.getAttribute('href')||'';
      if(!href.includes('/p/'))return;
      const postUrl=href.startsWith('http')?href:'https://coomerfans.com'+href;
      if(seenUrls.has(postUrl))return;
      seenUrls.add(postUrl);

      // Walk up to find the card container (has an img or background-image)
      let container=a;
      for(let i=0;i<6;i++){
        if(!container.parentElement)break;
        container=container.parentElement;
        try{
          if(container.querySelector('img')||/url\s*\(/.test((container.style&&container.style.backgroundImage)||''))break;
        }catch(e){break;}
      }

      const thumb=_extractThumb(container);
      if(!thumb)console.warn('[NCF thumb] no thumb for',postUrl,'container:',container.tagName,container.className?.slice(0,60));
      const title=container.querySelector('[class*="title"],[class*="description"],[class*="text"],p')?.textContent?.trim()
                 ||a.getAttribute('title')||a.textContent?.trim()||'';
      const isVideo=!!(container.querySelector('[class*="video"],[class*="play"],video,.play-icon') ||
                       container.classList.toString().toLowerCase().includes('video'));
      cards.push({postUrl,thumbnail:thumb,title:title.slice(0,120),isVideo});
    });

    // Shared helper: extract best thumbnail URL from an element
    function _extractThumb(el){
      // 1. img tags — prefer resolved .src, fallback to data-src attrs
      const imgs=el.querySelectorAll('img');
      for(let i=0;i<imgs.length;i++){
        const resolved=imgs[i].src||'';
        const attr=imgs[i].getAttribute('data-src')||imgs[i].getAttribute('data-lazy-src')||imgs[i].getAttribute('data-original')||imgs[i].getAttribute('src')||'';
        const s=(resolved.startsWith('http')&&!resolved.includes('blank_post')&&!resolved.includes('data:')&&!resolved.includes('svg')?resolved:null)
               ||(attr.startsWith('http')&&!attr.includes('blank_post')?attr:null)||'';
        if(s&&!s.includes('svg')&&!s.includes('icon')&&!s.includes('logo'))return s;
      }
      // 2. CSS background-image on any child div
      const divs=el.querySelectorAll('div,span');
      for(let i=0;i<divs.length;i++){
        const bg=(divs[i].style&&divs[i].style.backgroundImage)||'';
        const m=bg.match(/url\(["']?(https?:[^"')]+)["']?\)/);
        if(m&&m[1]&&!m[1].includes('blank_post'))return m[1];
      }
      return '';
    }

    return cards;
  }

  // ── PHASE 1b: Also extract from CURRENT PAGE DOM (already rendered) ──
  function extractCardsFromCurrentPage(){
    return extractCardsFromDoc(document);
  }

  // ── Metadata helpers (duration / resolution / size) ───────
  function qualityLabel(w,h){
    const s=Math.min(w||0,h||0)||(h||0); // short side => correct for vertical videos too
    if(!s)return '';
    if(s>=2100)return '4K';
    if(s>=1400)return '1440p';
    if(s>=1000)return '1080p';
    if(s>=700)return '720p';
    if(s>=460)return '480p';
    if(s>=340)return '360p';
    return s+'p';
  }

  function fetchHeadSize(url){
    return new Promise(res=>{
      let done=false;
      const t=setTimeout(()=>{if(!done){done=true;res(0);}},8000);
      try{
        // Must send the coomerfans referer — background.js falls back to
        // erome.com's referer otherwise, which this CDN's hotlink-bypass rejects.
        chrome.runtime.sendMessage({action:"FETCH_HEAD_INFO",url,referer:'https://coomerfans.com/'},r=>{
          if(done)return;done=true;clearTimeout(t);
          if(chrome.runtime.lastError){res(0);return;}
          // Reject HTML responses (error pages, ~571 B) as invalid size
          const ct=(r&&r.contentType)||'';
          const sz=r&&r.ok&&r.contentLength?parseInt(r.contentLength,10):0;
          res(ct.includes('html')||sz<2000?0:sz);
        });
      }catch(e){if(!done){done=true;clearTimeout(t);res(0);}}
    });
  }

  function probeVideoElement(src,timeoutMs){
    return new Promise(res=>{
      const v=document.createElement('video');
      let done=false;
      const fin=r=>{if(done)return;done=true;clearTimeout(t);v.removeAttribute('src');try{v.load();}catch(e){}res(r);};
      const t=setTimeout(()=>fin({duration:0,width:0,height:0}),timeoutMs);
      v.preload='metadata';v.muted=true;
      v.onloadedmetadata=()=>fin({
        duration:v.duration&&isFinite(v.duration)?v.duration:0,
        width:v.videoWidth||0,height:v.videoHeight||0
      });
      v.onerror=()=>fin({duration:0,width:0,height:0});
      v.src=src;
    });
  }

  // Minimal MP4 parser: reads duration (mvhd) and resolution (tkhd of the video track)
  // from the first bytes of the file (works when moov atom is at the start / faststart).
  function parseMp4Head(bytes){
    const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const out={duration:0,width:0,height:0};
    const type=(o)=>String.fromCharCode(bytes[o],bytes[o+1],bytes[o+2],bytes[o+3]);
    function walk(start,end,depth){
      let o=start;
      while(o+8<=end){
        let size=dv.getUint32(o);const t=type(o+4);let hdr=8;
        if(size===1){if(o+16>end)return;size=dv.getUint32(o+8)*4294967296+dv.getUint32(o+12);hdr=16;}
        else if(size===0)size=end-o;
        if(size<hdr)return;
        const bodyStart=o+hdr,boxEnd=Math.min(o+size,end);
        if(t==='moov'||t==='trak'||t==='mdia'){walk(bodyStart,boxEnd,depth+1);}
        else if(t==='mvhd'&&bodyStart+20<=end){
          const ver=bytes[bodyStart];
          let ts,dur;
          if(ver===1){ts=dv.getUint32(bodyStart+20);dur=dv.getUint32(bodyStart+24)*4294967296+dv.getUint32(bodyStart+28);}
          else{ts=dv.getUint32(bodyStart+12);dur=dv.getUint32(bodyStart+16);}
          if(ts>0)out.duration=dur/ts;
        }else if(t==='tkhd'){
          const ver=bytes[bodyStart];
          const wOff=bodyStart+(ver===1?88:76);
          if(wOff+8<=end){
            const w=dv.getUint32(wOff)/65536,h=dv.getUint32(wOff+4)/65536;
            if(w>0&&h>0&&!out.width){out.width=Math.round(w);out.height=Math.round(h);}
          }
        }
        if(boxEnd<=o)return;
        o=boxEnd;
      }
    }
    try{walk(0,bytes.length,0);}catch(e){}
    return out;
  }

  function fetchChunkBytes(url){
    return new Promise(res=>{
      const t=setTimeout(()=>res(null),15000);
      try{
        chrome.runtime.sendMessage({action:"FETCH_VIDEO_CHUNK_BASE64",url},resp=>{
          clearTimeout(t);
          if(chrome.runtime.lastError||!resp||!resp.ok||!resp.dataUrl){res(null);return;}
          try{
            const b64=resp.dataUrl.split(',')[1]||'';
            const bin=atob(b64);const arr=new Uint8Array(bin.length);
            for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
            res(arr);
          }catch(e){res(null);}
        });
      }catch(e){clearTimeout(t);res(null);}
    });
  }

  // Resolves duration/width/height/filesize. Tries <video> metadata (2x), then MP4 header parsing.
  async function resolveVideoMeta(url,{needSize=true}={}){
    const sizeP=needSize?(async()=>{let s=await fetchHeadSize(url);if(!s){await sleep(400);s=await fetchHeadSize(url);}return s;})():Promise.resolve(0);
    let m=await probeVideoElement(url,9000);
    if(!m.duration||!m.height){
      const m2=await probeVideoElement(url,12000);
      if(m2.duration)m.duration=m2.duration;
      if(m2.height){m.width=m2.width;m.height=m2.height;}
    }
    if(!m.duration||!m.height){
      const bytes=await fetchChunkBytes(url);
      if(bytes){
        const p=parseMp4Head(bytes);
        if(!m.duration&&p.duration)m.duration=p.duration;
        if(!m.height&&p.height){m.width=p.width;m.height=p.height;}
      }
    }
    const filesize=await sizeP;
    return{duration:m.duration||0,width:m.width||0,height:m.height||0,filesize};
  }

  // ── PHASE 2: Get MP4 URL from post page ───────────────────
  // Returns: {videoUrl, duration, filesize, thumbnail} or null
  async function getVideoFromPost(postUrl){
    const doc=await fetchDoc(postUrl);
    if(!doc)return null;

    const videoUrls=[];
    doc.querySelectorAll('script').forEach(s=>{
      const matches=(s.textContent||'').matchAll(/["'](https?:\/\/[^"']+\.mp4[^"']*?)["']/g);
      for(const m of matches){if(!videoUrls.includes(m[1]))videoUrls.push(m[1]);}
    });
    doc.querySelectorAll('video').forEach(vid=>{
      [vid.getAttribute('src'),vid.getAttribute('data-src')].forEach(src=>{
        if(src&&(src.includes('.mp4')||src.includes('.webm'))&&!videoUrls.includes(src))videoUrls.push(src);
      });
      vid.querySelectorAll('source').forEach(s=>{
        const ss=s.getAttribute('src')||s.getAttribute('data-src')||'';
        if(ss&&!videoUrls.includes(ss))videoUrls.push(ss);
      });
    });
    doc.querySelectorAll('a[href*=".mp4"],a[href*=".webm"],a[download]').forEach(a=>{
      const h=a.getAttribute('href')||'';
      if((h.includes('.mp4')||h.includes('.webm'))&&!videoUrls.includes(h))videoUrls.push(h);
    });

    if(!videoUrls.length)return null;

    let duration=0;
    doc.querySelectorAll('script').forEach(s=>{
      const durMatch=(s.textContent||'').match(/"duration"\s*:\s*(\d+\.?\d*)/);
      if(durMatch&&!duration)duration=parseFloat(durMatch[1]);
    });
    if(!duration){
      const durAttr=doc.querySelector('video')?.getAttribute('duration')||'0';
      duration=parseFloat(durAttr)||0;
    }

    let filesize=0;
    const scriptText=Array.from(doc.querySelectorAll('script')).map(s=>s.textContent).join(' ');
    const sizeMatch=scriptText.match(/"size"\s*:\s*(\d+)/)||scriptText.match(/"filesize"\s*:\s*(\d+)/);
    if(sizeMatch)filesize=parseInt(sizeMatch[1])||0;

    let width=0,height=0;
    let quality='';
    if(videoUrls[0]){
      const meta=await resolveVideoMeta(videoUrls[0],{needSize:!filesize});
      if(meta.duration)duration=meta.duration;
      if(meta.filesize)filesize=filesize||meta.filesize;
      width=meta.width||0;height=meta.height||0;
      quality=qualityLabel(width,height);
    }

    // Get thumbnail from post page — prefer og:image (stable), then video poster, then img
    let poster = doc.querySelector('meta[property="og:image"]')?.getAttribute('content')
              || doc.querySelector('meta[name="og:image"]')?.getAttribute('content')
              || doc.querySelector('video')?.getAttribute('poster')
              || '';
    if(!poster || poster.includes('blank_post') || poster.includes('no-image')){
       const imgs = Array.from(doc.querySelectorAll('img'));
       const validImg = imgs.find(i => {
         const s = i.getAttribute('data-src')||i.getAttribute('data-lazy-src')||i.getAttribute('src')||i.src||'';
         return s && s.includes('storage') && !s.includes('istorage') && !s.includes('blank_post') && !s.includes('svg');
       });
       if(validImg) poster = validImg.getAttribute('data-src')||validImg.getAttribute('data-lazy-src')||validImg.getAttribute('src')||validImg.src||'';
    }

    // Some posts (e.g. multi-video/carousel entries under the same creator) share one
    // og:image across several distinct videos — that poster doesn't represent THIS
    // video, so treat a poster already used elsewhere in this scan as missing and
    // fall through to generating a real frame from the actual video below.
    if (poster && !poster.startsWith('data:')) {
      if (usedThumbUrls.has(poster)) poster = '';
      else usedThumbUrls.add(poster);
    }

    if (!poster || poster.includes('no-image') || poster.includes('blank_post')) {
       try {
           const base64Thumb = await new Promise((resolve) => {
               let timeout = setTimeout(() => resolve(null), 15000);
               chrome.runtime.sendMessage({ action: "FETCH_VIDEO_CHUNK_BASE64", url: videoUrls[0] }, (resp) => {
                   clearTimeout(timeout);
                   if (chrome.runtime.lastError || !resp || !resp.ok || !resp.dataUrl) {
                       resolve(null);
                   } else {
                       const parts = resp.dataUrl.split(',');
                       resolve(parts.length > 1 ? parts[1] : null);
                   }
               });
           });
           
           if (base64Thumb) {
               const generatedThumb = await new Promise((resolve) => {
                   const v = document.createElement('video');
                   v.muted = true;
                   v.playsInline = true;
                   v.src = 'data:video/mp4;base64,' + base64Thumb;
                   let done = false;
                   const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 4000);
                   
                   v.addEventListener('loadeddata', () => { v.currentTime = 1.0; });
                   
                   v.addEventListener('seeked', () => {
                       if (done) return;
                       done = true;
                       clearTimeout(t);
                       const canvas = document.createElement('canvas');
                       canvas.width = v.videoWidth || 640;
                       canvas.height = v.videoHeight || 360;
                       const ctx = canvas.getContext('2d');
                       ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
                       resolve(canvas.toDataURL('image/jpeg', 0.85));
                   });
                   
                   v.addEventListener('error', () => { if (!done) { done = true; clearTimeout(t); resolve(null); } });
                   v.load();
               });
               if (generatedThumb) {
                   poster = generatedThumb;
               }
           }
       } catch(e) {
           console.warn('Fallback thumbnail gen failed', e);
       }
    }

    return{videoUrl:videoUrls[0],duration,filesize,quality,width,height,thumbnail:poster};
  }

  // ── Filters + sort (duration, size, order) ────────────────
  let sortMode = 'default'; // default | size-desc | size-asc | dur-desc | dur-asc
  let filterSizeMinMB = 0;

  function sortVideos(){
    switch(sortMode){
      case 'size-desc': filteredVideos.sort((a,b)=>(b.filesize||0)-(a.filesize||0)); break;
      case 'size-asc':  filteredVideos.sort((a,b)=>(a.filesize||0)-(b.filesize||0)); break;
      case 'dur-desc':  filteredVideos.sort((a,b)=>(b.duration||0)-(a.duration||0)); break;
      case 'dur-asc':   filteredVideos.sort((a,b)=>(a.duration||0)-(b.duration||0)); break;
      default: break; // keep scan/original order
    }
  }

  function applyFilters(){
    const minSec=parseInt(document.getElementById('nexus-cf-dur-min').value)||0;
    const sizeInput=document.getElementById('ncf-modal-size-min');
    if(sizeInput) filterSizeMinMB=parseInt(sizeInput.value)||0;
    const minBytes=filterSizeMinMB*1024*1024;
    filteredVideos=foundVideos.filter(v=>(minSec<=0||v.duration>=minSec)&&(minBytes<=0||(v.filesize||0)>=minBytes));
    sortVideos();
    const modal=document.getElementById('nexus-cf-modal');
    if(modal&&modal.style.display!=='none'){
      currentGridPage = 1;
      renderGrid();
    }
    updateCopyCount();
    const sizeMsg=filterSizeMinMB>0?`, min. ${filterSizeMinMB}MB`:'';
    setStatus(`✅ Filtrovaných: ${filteredVideos.length} / ${foundVideos.length} videí (min. ${minSec}s${sizeMsg})`);
    saveSettings({pages:document.getElementById('nexus-cf-pages').value,limit:document.getElementById('nexus-cf-limit').value,durMin:minSec,batch:document.getElementById('nexus-cf-batch').value});
  }
  // Back-compat name used by the panel's own duration filter button
  const applyDurationFilter = applyFilters;
  function updateCopyCount(){const el=document.getElementById('nexus-cf-copy-count');if(el)el.textContent=filteredVideos.length;}

  // ── Copy URLs ─────────────────────────────────────────────
  function copyUrls(list){
    if(!list.length){setStatus('⚠️ Žiadne videá.');return;}
    const text=list.map(v=>v.videoUrl).join('\n');
    navigator.clipboard.writeText(text).then(()=>{
      setStatus(`✅ Skopírovaných ${list.length} URL!`);
      const btn=document.getElementById('ncf-modal-copy-all');
      if(btn){const o=btn.textContent;btn.textContent=`✅ ${list.length} skopírovaných!`;setTimeout(()=>{btn.textContent=o;},2000);}
    }).catch(()=>{
      const ta=Object.assign(document.createElement('textarea'),{value:text});
      Object.assign(ta.style,{position:'fixed',opacity:'0'});
      document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();
      setStatus(`✅ Skopírovaných ${list.length} URL!`);
    });
  }

  // ── MAIN SCAN ─────────────────────────────────────────────
  async function startScan(){
    if(scanning)return;
    scanning=true;stopFlag=false;foundVideos=[];filteredVideos=[];selectedUrls.clear();usedThumbUrls=new Set();
    document.getElementById('nexus-cf-panel-copy').style.display='none';

    const maxPages =parseInt(document.getElementById('nexus-cf-pages').value)||20;
    const maxVideos=parseInt(document.getElementById('nexus-cf-limit').value)||100;
    const minDur   =parseInt(document.getElementById('nexus-cf-dur-min').value)||0;
    saveSettings({pages:maxPages,limit:maxVideos,durMin:minDur,batch:document.getElementById('nexus-cf-batch').value});

    document.getElementById('nexus-cf-scan').disabled=true;
    document.getElementById('nexus-cf-view').disabled=true;
    document.getElementById('nexus-cf-stop').style.display='';
    document.getElementById('nexus-cf-progress').style.display='';
    setProgress(0);

    // ── PHASE 1: Collect post cards
    setStatus('📄 Zbieram príspevky zo stránok...');
    let allCards=[];
    let lastStr=null;

    for(let page=1;page<=maxPages&&!stopFlag;page++){
      setProgress(page/maxPages*25);
      let doc;
      if(page===1){
        doc=document;
        setStatus(`📄 Strana 1 (aktuálna strana)...`);
      }else{
        setStatus(`📄 Strana ${page}/${maxPages} — ${allCards.length} príspevkov`);
        doc=await fetchDoc(getPageUrl(page));
        if(!doc)break;
      }
      const cards=extractCardsFromDoc(doc);
      if(!cards.length)break;

      const str=cards.slice(0,4).map(c=>c.postUrl).join(',');
      if(str===lastStr){setStatus(`ℹ️ Koniec obsahu na strane ${page}.`);break;}
      lastStr=str;

      cards.forEach(c=>{if(!allCards.find(x=>x.postUrl===c.postUrl))allCards.push(c);});
      if(cards.length<6&&page>1)break;
      if(page>1)await sleep(250);
    }

    setStatus(`✅ ${allCards.length} príspevkov. Získavam video URL a náhľady...`);

    // ── PHASE 2: sliding window — 10 workers pick next post immediately when done
    const CONCURRENCY = 10;
    let checked = 0;
    let cardIdx = 0;

    const runWorker = async () => {
      while (!stopFlag && foundVideos.length < maxVideos) {
        const idx = cardIdx++;
        if (idx >= allCards.length) break;
        const card = allCards[idx];
        try {
          const videoData = await getVideoFromPost(card.postUrl);
          if (videoData) {
            let finalThumb = videoData.thumbnail || card.thumbnail;
            if (finalThumb && finalThumb.includes('blank_post')) finalThumb = '';
            console.log('[NCF]', card.postUrl.slice(-30), '| postThumb:', (videoData.thumbnail||'').slice(0,60), '| cardThumb:', (card.thumbnail||'').slice(0,60), '| final:', (finalThumb||'EMPTY'));
            const item = {
              postUrl: card.postUrl,
              videoUrl: videoData.videoUrl,
              thumbnail: finalThumb,
              title: card.title,
              duration: videoData.duration,
              filesize: videoData.filesize,
              quality: videoData.quality,
              width: videoData.width||0,
              height: videoData.height||0
            };
            if (!foundVideos.find(v => v.videoUrl === item.videoUrl)) foundVideos.push(item);
          }
        } catch(e) {}
        checked++;
        setProgress(25 + (checked / allCards.length) * 75);
        setStatus(`🔍 ${checked}/${allCards.length} | 🎬 ${foundVideos.length} videí`);
      }
    };

    await Promise.all(Array.from({length: Math.min(CONCURRENCY, allCards.length)}, runWorker));
    if (foundVideos.length > maxVideos) foundVideos = foundVideos.slice(0, maxVideos);

    // ── PHASE 3: backfill — retry items with missing duration / size / quality (lower concurrency = fewer CDN timeouts)
    const missing = foundVideos.filter(v => !v.duration || !v.filesize || !v.height);
    if (missing.length && !stopFlag) {
      let bi = 0, bdone = 0;
      const backfillWorker = async () => {
        while (!stopFlag) {
          const v = missing[bi++];
          if (!v) break;
          try {
            const m = await resolveVideoMeta(v.videoUrl, { needSize: !v.filesize });
            if (m.duration && !v.duration) v.duration = m.duration;
            if (m.filesize && !v.filesize) v.filesize = m.filesize;
            if (m.height && !v.height) { v.width = m.width; v.height = m.height; v.quality = qualityLabel(m.width, m.height); }
          } catch(e) {}
          bdone++;
          setStatus(`🔁 Dopĺňam metadáta ${bdone}/${missing.length}`);
        }
      };
      await Promise.all(Array.from({length: Math.min(4, missing.length)}, backfillWorker));
    }

    filteredVideos=minDur>0?foundVideos.filter(v=>v.duration>=minDur):[...foundVideos];
    sortVideos();

    setProgress(100);
    const skipped=foundVideos.length-filteredVideos.length;
    setStatus(`✅ ${filteredVideos.length} videí${skipped>0?` (${skipped} pod ${minDur}s)`:''}  z ${allCards.length} príspevkov.`);
    document.getElementById('nexus-cf-scan').disabled=false;
    document.getElementById('nexus-cf-stop').style.display='none';
    if(filteredVideos.length>0){
      document.getElementById('nexus-cf-view').disabled=false;
      document.getElementById('nexus-cf-panel-copy').style.display='';
      updateCopyCount();
    }
    scanning=false;
    if (foundVideos.length) {
      const bName = document.getElementById('nexus-cf-batch').value.trim() || 'Coomerfans Import';
      saveToHistory(bName, foundVideos);
    }
  }

  // ── GRID MODAL & PAGINATION ───────────────────────────────
  let currentGridPage = 1;
  const ITEMS_PER_PAGE = 30; // chunk size for infinite scroll (multiple of 5 columns)
  // Cache resolved CDN thumbnails so paging/sorting/filtering doesn't re-fetch the same image
  const thumbDataCache = new Map();

  function openGridModal(){
    let modal=document.getElementById('nexus-cf-modal');
    currentGridPage = 1;
    if(modal){modal.style.display='flex';renderGrid();return;}

    modal=document.createElement('div');
    modal.id='nexus-cf-modal';
    modal.innerHTML=`
      <div id="nexus-cf-modal-header">
        <div id="nexus-cf-modal-logo">⚡ NEXUS — Coomerfans Gallery</div>
        <div id="nexus-cf-modal-stats"></div>
        <div id="ncf-filter-bar">
          <span class="ncf-filter-label">Min. dur:</span>
          <input id="ncf-modal-dur-min" type="number" min="0" value="${parseInt(document.getElementById('nexus-cf-dur-min').value)||0}" />
          <span class="ncf-filter-label">sek</span>
          <span class="ncf-filter-label">Min. veľkosť:</span>
          <input id="ncf-modal-size-min" type="number" min="0" value="${filterSizeMinMB||0}" />
          <span class="ncf-filter-label">MB</span>
          <button id="ncf-modal-filter-btn" class="ncf-btn-filter">▶ Filter</button>
          <span class="ncf-filter-label">Zoradiť:</span>
          <select id="ncf-modal-sort">
            <option value="default">Predvolené</option>
            <option value="size-desc">Veľkosť ↓</option>
            <option value="size-asc">Veľkosť ↑</option>
            <option value="dur-desc">Dĺžka ↓</option>
            <option value="dur-asc">Dĺžka ↑</option>
          </select>
          <button id="ncf-modal-copy-all" class="ncf-btn-copy">📋 Kopírovať všetky URL</button>
          <button id="ncf-modal-copy-sel" class="ncf-btn-copy" disabled>📋 Kopírovať vybrané</button>
        </div>
        <div id="nexus-cf-modal-actions">
          <button id="nexus-cf-import-sel" class="ncf-btn-green" disabled>📥 Import vybrané</button>
          <button id="nexus-cf-import-all" class="ncf-btn-purple">📥 Import všetky</button>
          <button id="nexus-cf-modal-close" class="ncf-btn-close">✖</button>
        </div>
      </div>

      <!-- NEW: Pagination controls at top -->
      <div id="nexus-cf-pagination" style="display:flex; justify-content:center; align-items:center; gap:15px; padding:10px; background:#0d0a28; border-bottom:1px solid rgba(139,92,246,.2);">
         <label id="nexus-cf-select-all-label" style="margin-right:auto; margin-left:15px;"><input type="checkbox" id="nexus-cf-select-all" /> Vybrať všetky na strane</label>
         <button id="ncf-page-prev" class="ncf-btn-info" disabled>◀ Predošlá</button>
         <span id="ncf-page-info" style="font-weight:bold; color:#c4b5fd;">Strana 1 z 1</span>
         <button id="ncf-page-next" class="ncf-btn-info">Ďalšia ▶</button>
         <div style="margin-left:auto; width:150px;"></div>
      </div>

      <div id="nexus-cf-grid"></div>
      <div id="nexus-cf-import-bar">
        <span id="nexus-cf-bar-count">0 vybraných</span>
        <button id="ncf-bar-copy" class="ncf-btn-copy">📋 Kopírovať URL</button>
        <button id="nexus-cf-bar-import" class="ncf-btn-green">📥 Importovať do Nexus</button>
      </div>
    `;
    // Append to <html> to escape body transform/contain that breaks position:fixed on post-search
    document.documentElement.appendChild(modal);

    document.getElementById('nexus-cf-modal-close').addEventListener('click',()=>{modal.style.display='none';});
    modal.addEventListener('click',e=>{if(e.target===modal)modal.style.display='none';});
    
    document.getElementById('nexus-cf-select-all').addEventListener('change',e=>{
      document.querySelectorAll('.ncf-card-cb').forEach(cb=>{
        cb.checked=e.target.checked;
        if(e.target.checked)selectedUrls.add(cb.dataset.url);else selectedUrls.delete(cb.dataset.url);
      });updateBar();
    });

    // Infinite scroll: load next chunk when user scrolls near the bottom of the grid
    document.getElementById('ncf-page-prev').style.display='none';
    document.getElementById('ncf-page-next').style.display='none';
    document.getElementById('nexus-cf-grid').addEventListener('scroll', e=>{
      const g=e.target;
      if(renderedCount < filteredVideos.length && g.scrollTop + g.clientHeight >= g.scrollHeight - 400) renderMore();
    });

    document.getElementById('nexus-cf-import-sel').addEventListener('click',()=>importSelected([...selectedUrls]));
    document.getElementById('nexus-cf-import-all').addEventListener('click',()=>importSelected(filteredVideos.map(v=>v.videoUrl)));
    document.getElementById('nexus-cf-bar-import').addEventListener('click',()=>importSelected([...selectedUrls]));
    document.getElementById('ncf-modal-copy-all').addEventListener('click',()=>copyUrls(filteredVideos));
    document.getElementById('ncf-modal-copy-sel').addEventListener('click',()=>copyUrls(filteredVideos.filter(v=>selectedUrls.has(v.videoUrl))));
    document.getElementById('ncf-bar-copy').addEventListener('click',()=>copyUrls(filteredVideos.filter(v=>selectedUrls.has(v.videoUrl))));
    document.getElementById('ncf-modal-filter-btn').addEventListener('click',()=>{
      document.getElementById('nexus-cf-dur-min').value=document.getElementById('ncf-modal-dur-min').value;
      applyFilters();
    });
    document.getElementById('ncf-modal-dur-min').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('ncf-modal-filter-btn').click();});
    document.getElementById('ncf-modal-size-min').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('ncf-modal-filter-btn').click();});
    document.getElementById('ncf-modal-sort').value=sortMode;
    document.getElementById('ncf-modal-sort').addEventListener('change',e=>{
      sortMode=e.target.value;
      sortVideos();
      currentGridPage=1;
      renderGrid();
    });

    renderGrid();
  }

  // ── Lazy card hydration (thumbnail + missing metadata) ─────
  const HYDRATE_CONCURRENCY = 3;
  const hydrateQueue = [];
  let hydrateActive = 0;
  let _cardObserver = null;

  function cardObserver(){
    if(_cardObserver) return _cardObserver;
    _cardObserver = new IntersectionObserver(entries=>{
      entries.forEach(en=>{
        if(!en.isIntersecting) return;
        _cardObserver.unobserve(en.target);
        hydrateQueue.push(en.target);
      });
      pumpHydrate();
    },{root:document.getElementById('nexus-cf-grid'),rootMargin:'600px 0px'});
    return _cardObserver;
  }

  function pumpHydrate(){
    while(hydrateActive<HYDRATE_CONCURRENCY && hydrateQueue.length){
      const card=hydrateQueue.shift();
      if(!card.isConnected) continue;
      hydrateActive++;
      hydrateCard(card).catch(()=>{}).finally(()=>{hydrateActive--;pumpHydrate();});
    }
  }

  function fetchThumbDataUrl(src){
    return new Promise(res=>{
      const t=setTimeout(()=>res(null),15000);
      try{
        chrome.runtime.sendMessage({action:'FETCH_IMAGE_AS_DATAURL',url:src,referer:'https://coomerfans.com/'},resp=>{
          clearTimeout(t);
          if(chrome.runtime.lastError||!resp||!resp.ok||!resp.dataUrl){res(null);return;}
          res(resp.dataUrl);
        });
      }catch(e){clearTimeout(t);res(null);}
    });
  }

  // Grabs a real frame from the first bytes of the video (fallback when the poster is missing/broken)
  async function generateThumbFromVideo(url){
    const bytes=await fetchChunkBytes(url);
    if(!bytes) return null;
    const blobUrl=URL.createObjectURL(new Blob([bytes],{type:'video/mp4'}));
    try{
      return await new Promise(res=>{
        const v=document.createElement('video');
        v.muted=true;v.playsInline=true;v.preload='auto';
        let done=false;
        const fin=r=>{if(done)return;done=true;clearTimeout(t);res(r);};
        const t=setTimeout(()=>fin(null),8000);
        v.addEventListener('loadeddata',()=>{try{v.currentTime=Math.min(1,(v.duration||2)/2);}catch(e){fin(null);}});
        v.addEventListener('seeked',()=>{
          try{
            const c=document.createElement('canvas');
            const w=v.videoWidth||640,h=v.videoHeight||360;
            const sc=Math.min(1,480/Math.max(w,h));
            c.width=Math.round(w*sc);c.height=Math.round(h*sc);
            c.getContext('2d').drawImage(v,0,0,c.width,c.height);
            fin(c.toDataURL('image/jpeg',0.8));
          }catch(e){fin(null);}
        });
        v.addEventListener('error',()=>fin(null));
        v.src=blobUrl;
      });
    }finally{URL.revokeObjectURL(blobUrl);}
  }

  function setCardThumb(card,dataUrl){
    const img=card.querySelector('.ncf-card-thumb');
    const no=card.querySelector('.ncf-no-thumb');
    if(!img||!dataUrl) return false;
    img.src=dataUrl;img.style.display='';img.style.opacity='1';
    if(no) no.style.display='none';
    return true;
  }

  function refreshCardMeta(card,v){
    const q=(s)=>card.querySelector(s);
    if(v.duration){
      const d=q('.ncf-duration');if(d){d.textContent=fmtDuration(v.duration);d.style.display='';}
      const c=q('.ncf-meta-dur');if(c)c.textContent='⏱ '+fmtDuration(v.duration);
    }
    if(v.filesize){
      const s=q('.ncf-filesize');if(s){s.textContent=formatBytes(v.filesize);s.style.display='';}
      const c=q('.ncf-meta-size');if(c)c.textContent='💾 '+fmtSize(v.filesize);
    }
    if(v.quality){
      const ql=q('.ncf-quality');if(ql){ql.textContent=v.quality;ql.style.display='';}
      const c=q('.ncf-meta-quality');if(c)c.textContent='🎞 '+v.quality;
    }
  }

  async function hydrateCard(card){
    const v=card._ncfVideo;
    if(!v) return;

    // 1) Thumbnail: cached → fetch with retries → frame from video
    let ok=false;
    if(v.thumbnail){
      if(v.thumbnail.startsWith('data:')) ok=setCardThumb(card,v.thumbnail);
      else if(thumbDataCache.has(v.thumbnail)) ok=setCardThumb(card,thumbDataCache.get(v.thumbnail));
      else if(v.thumbnail.startsWith('http')){
        for(let i=0;i<3&&!ok;i++){
          const d=await fetchThumbDataUrl(v.thumbnail);
          if(d){thumbDataCache.set(v.thumbnail,d);ok=setCardThumb(card,d);}
          else await sleep(500*(i+1));
        }
      }
    }
    if(!ok){
      const d=await generateThumbFromVideo(v.videoUrl);
      if(d){v.thumbnail=d;setCardThumb(card,d);}
    }

    // 2) Missing metadata: size (HEAD with retries), duration / resolution
    if(!v.filesize){
      for(let i=0;i<3&&!v.filesize;i++){
        v.filesize=await fetchHeadSize(v.videoUrl);
        if(!v.filesize) await sleep(600*(i+1));
      }
    }
    if(!v.duration||!v.height){
      const m=await resolveVideoMeta(v.videoUrl,{needSize:false});
      if(m.duration&&!v.duration)v.duration=m.duration;
      if(m.height&&!v.height){v.width=m.width;v.height=m.height;v.quality=qualityLabel(m.width,m.height);}
    }
    refreshCardMeta(card,v);
  }

  // Infinite scroll: how many cards are currently rendered in the grid
  let renderedCount = 0;

  function renderGrid(){
    const grid=document.getElementById('nexus-cf-grid');
    const stats=document.getElementById('nexus-cf-modal-stats');
    const btnAll=document.getElementById('nexus-cf-import-all');
    if(stats)stats.textContent=`${filteredVideos.length}${filteredVideos.length!==foundVideos.length?' / '+foundVideos.length:''} videí`;
    if(btnAll)btnAll.textContent=`📥 Import všetky (${filteredVideos.length})`;
    if(!grid)return;

    grid.innerHTML='';
    grid.scrollTop=0;
    renderedCount=0;
    const selectAllCb = document.getElementById('nexus-cf-select-all');
    if(selectAllCb) selectAllCb.checked = false;
    renderMore();
  }

  // Appends the next chunk of cards (called on reset, on scroll near bottom, or via "Načítať viac")
  function renderMore(){
    const grid=document.getElementById('nexus-cf-grid');
    if(!grid)return;
    grid.querySelector('#ncf-load-more')?.remove();

    const startIndex = renderedCount;
    const paginatedVideos = filteredVideos.slice(startIndex, startIndex + ITEMS_PER_PAGE);
    renderedCount = startIndex + paginatedVideos.length;

    const info=document.getElementById('ncf-page-info');
    if(info) info.textContent = `Zobrazených ${renderedCount} z ${filteredVideos.length}`;

    paginatedVideos.forEach((v,idx)=>{
      const globalIdx = startIndex + idx;
      const dur=v.duration?fmtDuration(v.duration):'—';
      const sz=v.filesize?fmtSize(v.filesize):'—';
      const card=document.createElement('div');
      card.className='ncf-card';
      const isChecked = selectedUrls.has(v.videoUrl) ? 'checked' : '';

      card.innerHTML=`
        <div class="ncf-card-thumb-wrap">
          <label class="ncf-card-check" onclick="event.stopPropagation()">
            <input type="checkbox" class="ncf-card-cb" data-idx="${globalIdx}" data-url="${v.videoUrl}" ${isChecked} />
          </label>
          <img class="ncf-card-thumb" style="opacity:0;${v.thumbnail?'':'display:none;'}" />
          <div class="ncf-no-thumb" style="${v.thumbnail?'display:none':''}">🎬</div>
          <div class="ncf-duration" style="${v.duration?'':'display:none;'}">${v.duration?fmtDuration(v.duration):'—'}</div>
          <div class="ncf-quality" style="${v.quality?'':'display:none;'}position:absolute; bottom:8px; left:8px; background:rgba(0,0,0,0.7); color:#fff; padding:2px 6px; border-radius:4px; font-size:10px; font-weight:bold; z-index:5;">${v.quality||''}</div>
          <div class="ncf-filesize" style="${v.filesize?'':'display:none;'}position:absolute; top:8px; right:8px; background:rgba(0,0,0,0.7); color:#fff; padding:2px 6px; border-radius:4px; font-size:10px; font-weight:bold; z-index:5;">${v.filesize?formatBytes(v.filesize):''}</div>
        </div>
        <div class="ncf-card-info">
          <div class="ncf-card-title" title="${(v.title||'').replace(/"/g,'&quot;')}">${v.title||'Video'}</div>
          <div class="ncf-card-meta">
            <span class="ncf-meta-chip ncf-meta-type">🎬 VIDEO</span>
            <span class="ncf-meta-chip ncf-meta-dur">⏱ ${dur}</span>
            <span class="ncf-meta-chip ncf-meta-size">💾 ${sz}</span>
            <span class="ncf-meta-chip ncf-meta-quality">🎞 ${v.quality||'—'}</span>
          </div>
          <a class="ncf-card-link" href="${v.postUrl}" target="_blank" onclick="event.stopPropagation()">🔗 Post</a>
        </div>
      `;

      // Thumbnail + missing metadata are resolved lazily (only for visible cards), throttled, with retries
      card._ncfVideo = v;
      cardObserver().observe(card);

      card.querySelector('.ncf-card-cb').addEventListener('change',e=>{
        if(e.target.checked)selectedUrls.add(v.videoUrl);else selectedUrls.delete(v.videoUrl);
        updateBar();
      });
      card.addEventListener('click',e=>{if(e.target.tagName==='INPUT'||e.target.tagName==='A')return;window.open(v.postUrl,'_blank');});
      grid.appendChild(card);
    });

    if(renderedCount < filteredVideos.length){
      const more=document.createElement('button');
      more.id='ncf-load-more';
      more.className='ncf-btn-info';
      more.style.cssText='grid-column:1/-1;justify-self:center;padding:10px 28px;margin:8px 0;';
      more.textContent=`⬇ Načítať viac (${filteredVideos.length-renderedCount})`;
      more.addEventListener('click',renderMore);
      grid.appendChild(more);
    }
    updateBar();
  }

  function updateBar(){
    const importSel=document.getElementById('nexus-cf-import-sel');
    const cpySel=document.getElementById('ncf-modal-copy-sel');
    const bar=document.getElementById('nexus-cf-import-bar');
    const count=document.getElementById('nexus-cf-bar-count');
    
    if(importSel)importSel.disabled=selectedUrls.size===0;
    if(cpySel)cpySel.disabled=selectedUrls.size===0;
    if(bar)bar.style.display=selectedUrls.size>0?'flex':'none';
    if(count)count.textContent=`${selectedUrls.size} vybraných`;
  }

  async function importSelected(videoUrlList){
    if(!videoUrlList.length)return;
    const batchName=document.getElementById('nexus-cf-batch').value.trim()||'Coomerfans Import';
    const videos=videoUrlList.map(url=>{
      const v=foundVideos.find(x=>x.videoUrl===url)||{};
      const height = v.height || 0;
      const width = v.width || (height ? Math.round(height * 16 / 9) : 0);
      return{
        url, source_url:v.postUrl||'', title:v.title||'Queued...',
        thumbnail:v.thumbnail||null, duration:v.duration||0,
        quality:v.quality||'', height, width,
        filesize:v.filesize||0, tags:'coomerfans'
      };
    });
    setStatus(`📤 Importujem ${videos.length}...`);
    const btnSel=document.getElementById('nexus-cf-import-sel');
    const btnAll=document.getElementById('nexus-cf-import-all');
    if(btnSel){btnSel.disabled=true;btnSel.textContent=`📤 ${videos.length}...`;}
    if(btnAll)btnAll.disabled=true;
    try{
      const token=await getNexusToken();
      const result=await new Promise((resolve,reject)=>{
        let done=false;
        const t=setTimeout(()=>{if(!done){done=true;reject(new Error('Timeout'));}},15000);
        chrome.runtime.sendMessage({action:'NEXUS_CF_IMPORT',batchName,videos,token},r=>{
          if(!done){done=true;clearTimeout(t);resolve(r);}
        });
      });
      if(result&&result.ok){
        const d=result.data||{};
        setStatus(`✅ Import OK! ${d.count||videos.length} → "${batchName}". [${result.base||''}]`);
        if(btnSel)btnSel.textContent=`✅ ${d.count||videos.length}`;
        if(btnAll)btnAll.disabled=false;
        // Fetch thumbnails directly from content script (correct session/IP) and upload binary
        const thumbItems=d.thumb_uploads||[];
        if(thumbItems.length){
          setStatus(`✅ Importované. Nahrávam ${thumbItems.length} náhľadov...`);
          (async()=>{
            let uploaded=0;
            const uploadToken=await getNexusToken();
            for(const item of thumbItems){
              try{
                // Try CDN URL first; fall back to og:image from post page if it fails
                let blob=null;
                let ct='image/jpeg';
                const tryFetch=async(url,referer)=>{
                  try{
                    const r=await fetch(url,{credentials:'include',headers:{Referer:referer||'https://coomerfans.com/',Accept:'image/*'}});
                    if(!r.ok)return null;
                    const b=await r.blob();
                    return b.size>500?b:null;
                  }catch{return null;}
                };
                blob=await tryFetch(item.url,'https://coomerfans.com/');
                if(!blob && item.source_url && item.source_url.includes('coomerfans.com')){
                  // CDN URL failed — scrape og:image from post page
                  try{
                    const pageResp=await fetch(item.source_url,{credentials:'include',headers:{Referer:'https://coomerfans.com/'}});
                    if(pageResp.ok){
                      const html=await pageResp.text();
                      const m=html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                               ||html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
                      if(m&&m[1])blob=await tryFetch(m[1],'https://coomerfans.com/');
                    }
                  }catch(e){console.warn('[CF thumb] og:image fallback failed',e);}
                }
                if(!blob){console.warn('[CF thumb] all sources failed for video',item.id);continue;}
                ct=blob.type||'image/jpeg';
                const ab=await blob.arrayBuffer();
                await new Promise(resolve=>{
                  try{
                    chrome.runtime.sendMessage({action:'NEXUS_CF_UPLOAD_THUMB_BINARY',videoId:item.id,data:ab,contentType:ct,token:uploadToken},r=>{
                      if(r?.ok)uploaded++;
                      resolve();
                    });
                  }catch(e){resolve();}
                });
              }catch(e){console.warn('[CF thumb] error',e);}
            }
            setStatus(`✅ Hotovo! ${d.count||videos.length} videí, ${uploaded}/${thumbItems.length} náhľadov.`);
          })();
        }
      }else{
        const err=result?.data?.detail||result?.error||result?.status||'Chyba';
        setStatus(`❌ Import zlyhal: ${err}`);
        if(btnSel){btnSel.disabled=false;btnSel.textContent='📥 Import vybrané';}
        if(btnAll)btnAll.disabled=false;
      }
    }catch(e){
      setStatus(`❌ Nexus nedostupný: ${e.message}`);
      if(btnSel){btnSel.disabled=selectedUrls.size===0;btnSel.textContent='📥 Import vybrané';}
      if(btnAll)btnAll.disabled=false;
    }
  }

  async function getNexusToken(){
    if (!_hasStorage()) return '';
    return new Promise(r=>chrome.storage.local.get(['nexus_token','nexusBridgeToken'],d=>r(d.nexus_token||d.nexusBridgeToken||'')));
  }

  async function getNexusBase(){
    const preferred = _hasStorage()
      ? await new Promise(r=>chrome.storage.local.get(['selected_port'],d=>r(d.selected_port||8001)))
      : 8001;
    const ports = [preferred, 8001, 8000, 8002, 8003];
    for(const p of ports){
      try{
        const r = await fetch(`http://127.0.0.1:${p}/api/v1/health`, {signal:AbortSignal.timeout(600)});
        if(r.ok) return `http://127.0.0.1:${p}`;
      }catch{}
    }
    return `http://127.0.0.1:${preferred}`;
  }

  // ── HISTORY MODAL ─────────────────────────────────────────
  function fmtDate(ts){
    const d=new Date(ts);
    return d.toLocaleDateString('sk-SK')+' '+d.toLocaleTimeString('sk-SK',{hour:'2-digit',minute:'2-digit'});
  }

  async function openHistoryModal(){
    let modal=document.getElementById('ncf-history-modal');
    if(!modal){
      modal=document.createElement('div');
      modal.id='ncf-history-modal';
      modal.innerHTML=`
        <div id="ncf-hm-box">
          <div id="ncf-hm-header">
            <span id="ncf-hm-title">📚 História skenov</span>
            <input id="ncf-hm-search" type="text" placeholder="🔍 Hľadaj batch, URL, titul..." />
            <button id="ncf-hm-close" class="ncf-btn-close">✖</button>
          </div>
          <div id="ncf-hm-stats"></div>
          <div id="ncf-hm-list"></div>
        </div>
      `;
      document.documentElement.appendChild(modal);
      modal.addEventListener('click',e=>{if(e.target===modal)modal.style.display='none';});
      document.getElementById('ncf-hm-close').addEventListener('click',()=>{modal.style.display='none';});
      document.getElementById('ncf-hm-search').addEventListener('input',renderHistoryList);
    }
    modal.style.display='flex';
    await renderHistoryList();
  }

  async function renderHistoryList(){
    const history=await loadHistory();
    const query=(document.getElementById('ncf-hm-search')?.value||'').toLowerCase().trim();
    const stats=document.getElementById('ncf-hm-stats');
    const list=document.getElementById('ncf-hm-list');
    if(!list)return;

    const matches=query
      ?history.filter(e=>
          e.batchName.toLowerCase().includes(query)||
          e.pageUrl.toLowerCase().includes(query)||
          (e.videos||[]).some(v=>(v.title||'').toLowerCase().includes(query))
        )
      :history;

    if(stats)stats.textContent=`${matches.length} / ${history.length} záznamov`;

    if(!matches.length){
      list.innerHTML='<div class="ncf-hm-empty">'+(history.length?'🔍 Žiadne výsledky.':'📭 História je prázdna. Skenovanie uloží výsledky automaticky.')+'</div>';
      return;
    }

    list.innerHTML='';
    matches.forEach(entry=>{
      const firstThumb=entry.videos?.[0]?.thumbnail||'';
      const urlShort=entry.pageUrl.replace('https://coomerfans.com','').replace('https://www.coomerfans.com','').slice(0,60)||'/';
      const card=document.createElement('div');
      card.className='ncf-hm-card';
      card.innerHTML=`
        ${firstThumb
          ?`<img class="ncf-hm-thumb" src="${firstThumb}" onerror="this.style.display='none'" />`
          :`<div class="ncf-hm-thumb ncf-hm-no-thumb">🎬</div>`}
        <div class="ncf-hm-body">
          <div class="ncf-hm-name">${entry.batchName}</div>
          <div class="ncf-hm-meta">
            <span>📅 ${fmtDate(entry.timestamp)}</span>
            <span>🎬 ${entry.videoCount} videí</span>
          </div>
          <div class="ncf-hm-url" title="${entry.pageUrl}">${urlShort}</div>
        </div>
        <div class="ncf-hm-actions">
          <button class="ncf-hm-btn-load ncf-btn-green">▶ Načítať</button>
          <button class="ncf-hm-btn-del ncf-hm-btn-danger">🗑</button>
        </div>
      `;
      card.querySelector('.ncf-hm-btn-load').addEventListener('click',()=>{
        foundVideos=[...(entry.videos||[])];
        const minDur=parseInt(document.getElementById('nexus-cf-dur-min').value)||0;
        filteredVideos=minDur>0?foundVideos.filter(v=>v.duration>=minDur):[...foundVideos];
        sortVideos();
        selectedUrls.clear();
        document.getElementById('nexus-cf-view').disabled=false;
        document.getElementById('nexus-cf-panel-copy').style.display='';
        updateCopyCount();
        setStatus(`📂 Načítaných ${foundVideos.length} videí z "${entry.batchName}".`);
        document.getElementById('ncf-history-modal').style.display='none';
        openGridModal();
      });
      card.querySelector('.ncf-hm-btn-del').addEventListener('click',async()=>{
        await deleteHistoryEntry(entry.id);
        await renderHistoryList();
      });
      list.appendChild(card);
    });
  }

  // ── Events ────────────────────────────────────────────────
  document.getElementById('nexus-cf-scan').addEventListener('click',startScan);
  document.getElementById('nexus-cf-stop').addEventListener('click',()=>{stopFlag=true;setStatus('⏹ Zastavujem...');});
  document.getElementById('nexus-cf-view').addEventListener('click',openGridModal);
  document.getElementById('nexus-cf-dur-apply').addEventListener('click',applyDurationFilter);
  document.getElementById('nexus-cf-dur-min').addEventListener('keydown',e=>{if(e.key==='Enter')applyDurationFilter();});
  document.getElementById('nexus-cf-copy-all').addEventListener('click',()=>copyUrls(filteredVideos));
  document.getElementById('nexus-cf-history-btn').addEventListener('click',openHistoryModal);

})();
