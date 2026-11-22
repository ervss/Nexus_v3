/* Small CORS-capable transport used by both extension packages. */
(() => {
  'use strict';
  const site = host => /(^|\.)(?:pimpbunny\.com|eporner\.com|xvideos\.(?:com|red)|xhamster(?:-fr)?\.com|xhamster\.desi|spankbang\.(?:com|party))$/i.test(host);
  function allowed(raw, senderUrl) {
    try {
      const u=new URL(raw), sender=new URL(senderUrl);
      if (!site(sender.hostname) || u.protocol !== 'https:' || u.username || u.password) return false;
      if (/^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[|0\.)/i.test(u.hostname) || u.hostname.endsWith('.local')) return false;
      return u.origin === sender.origin || /\.(?:mp4|m3u8|webm)(?:\/|$)/i.test(u.pathname) || /\/(?:get_file|dload)\//.test(u.pathname);
    } catch { return false; }
  }
  async function request(url, method, range = false) {
    return await fetch(url,{method,credentials:'include',redirect:'follow',signal:AbortSignal.timeout(12000),headers:range ? {Range:'bytes=0-0'} : {}});
  }
  async function size(url) {
    for (const method of ['HEAD','GET']) {
      try {
        const res = await request(url,method,method==='GET');
        try {
          if (!res.ok || /text\/html|json|mpegurl|vnd\.apple/i.test(res.headers.get('content-type') || '')) continue;
          const total = res.status===206 ? res.headers.get('content-range')?.match(/\/(\d+)$/)?.[1] : res.headers.get('content-length');
          const bytes = Number(total); if (Number.isSafeInteger(bytes) && bytes>0) return {sizeBytes:bytes};
        } finally { if (res.body) await res.body.cancel(); }
      } catch { }
    }
    return {sizeBytes:null};
  }
  async function text(url) {
    const res = await request(url,'GET');
    if (!res.ok) { await res.body?.cancel(); return {ok:false}; }
    const reader=res.body.getReader(), chunks=[]; let count=0;
    try {
      while (true) { const item=await reader.read(); if (item.done) break; count+=item.value.length; if (count>8*1024*1024) throw new Error('Response too large'); chunks.push(item.value); }
    } finally { await reader.cancel(); }
    const bytes=new Uint8Array(count);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return {ok:true,text:new TextDecoder().decode(bytes),url:res.url || url};
  }
  globalThis.NVSPlayerNetwork = {allowed,size,text};
  chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
    if (!['NVS_PLAYER_FETCH','NVS_PLAYER_SIZE'].includes(msg.type)) return;
    if (!allowed(msg.url,sender.url || sender.tab?.url)) {sendResponse({ok:false});return;}
    void (async()=>{try{sendResponse(await (msg.type==='NVS_PLAYER_SIZE' ? size(msg.url) : text(msg.url)));}catch{sendResponse({ok:false,sizeBytes:null});}})();
    return true;
  });
})();
