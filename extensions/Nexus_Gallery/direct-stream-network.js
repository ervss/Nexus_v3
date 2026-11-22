// Successful network responses are scoped to a tab and its exact watch page.
// Records survive background worker restarts; signed URL queries are never stripped.
(() => {
    const prefix = 'nexus_direct_response_';
    const pageKey = raw => { try { const u = new URL(raw); u.hash = ''; return u.href; } catch { return ''; } };
    const httpUrl = raw => { try { const u = new URL(raw); return /^https?:$/.test(u.protocol) && !u.username && !u.password; } catch { return false; } };
    const hlsUrl = raw => /\.m3u8(?:[?#]|$)/i.test(raw);
    const segment = raw => /\.(?:ts|m4s|aac|mp3)(?:[?#]|$)|\/segment\//i.test(raw);
    function mediaUrl(raw) {
        return httpUrl(raw) && !segment(raw) && !/(?:preview|trailer|thumb|telemetry|\/ads?\/)/i.test(raw)
            && (/\.(?:mp4|m3u8|webm|mkv|mov|m4v|ogv)(?:[?#]|$)/i.test(raw) || /\/(?:get_file|stream|playlist|manifest)\b/i.test(raw));
    }
    const recordKey = (tabId, url) => {
        let hash = 2166136261;
        for (const ch of url) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
        return `${prefix}${tabId}_${hash}`;
    };
    async function capture(details) {
        if (details.tabId < 0 || ![200, 206].includes(details.statusCode) || segment(details.url)) return;
        const type = (details.responseHeaders || []).find(h => h.name.toLowerCase() === 'content-type')?.value || '';
        if (/html|json/i.test(type)) return;
        if (!mediaUrl(details.url) && !/^(?:video\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl))/i.test(type)) return;
        const tab = await chrome.tabs.get(details.tabId);
        if (!httpUrl(tab.url)) return;
        const key = recordKey(details.tabId, details.url);
        await chrome.storage.session.set({[key]: {tabId: details.tabId, pageUrl: pageKey(tab.url), url: details.url, type, ts: Date.now(), frameId: details.frameId}});
        const all = await chrome.storage.session.get(null);
        const rows = Object.entries(all).filter(([k,v]) => k.startsWith(prefix) && v.tabId === details.tabId).sort((a,b)=>b[1].ts-a[1].ts);
        const old = rows.filter(([,v],i)=>i >= 40 || Date.now()-v.ts > 30*60*1000).map(([k])=>k);
        if (old.length) await chrome.storage.session.remove(old);
        await chrome.tabs.sendMessage(details.tabId, {action:'DIRECT_STREAM_OBSERVED', url:details.url}).catch(()=>{});
    }
    chrome.webRequest.onHeadersReceived.addListener(details => { void capture(details).catch(console.warn); }, {urls:['<all_urls>']}, ['responseHeaders']);
    chrome.tabs.onRemoved.addListener(tabId => {
        void (async()=>{
            const all=await chrome.storage.session.get(null);
            const keys=Object.keys(all).filter(k=>k.startsWith(`${prefix}${tabId}_`));
            if(keys.length) await chrome.storage.session.remove(keys);
            await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[600000+tabId]});
        })().catch(console.warn);
    });
    async function sample(url, limit = 1024 * 1024) {
        if (!httpUrl(url)) throw new Error('Neplatná video URL.');
        const res=await fetch(url,{credentials:'include',redirect:'follow',signal:AbortSignal.timeout(7000),headers: hlsUrl(url) ? {} : {Range:'bytes=0-65535'}});
        if(!res.ok){await res.body?.cancel();throw new Error(`HTTP ${res.status}`);}
        if(/html|json/i.test(res.headers.get('content-type') || '')){await res.body?.cancel();throw new Error('Server vrátil stránku namiesto videa.');}
        const reader=res.body.getReader();const chunks=[];let size=0;
        try {while(size<limit){const {done,value}=await reader.read();if(done)break;const part=value.subarray(0,limit-size);chunks.push(part);size+=part.length;}}
        finally {await reader.cancel();}
        const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
        return {url:res.url || url,type:res.headers.get('content-type') || '',bytes};
    }
    function variants(text, base) {
        const lines=text.split(/\r?\n/);const rows=[];
        for(let i=0;i<lines.length;i++){
            if(!lines[i].startsWith('#EXT-X-STREAM-INF:'))continue;
            const height=Number(lines[i].match(/RESOLUTION=\d+x(\d+)/i)?.[1] || 0);
            const bandwidth=Number(lines[i].match(/(?:^|,)BANDWIDTH=(\d+)/i)?.[1] || 0);
            let next=i+1;while(next<lines.length && (!lines[next].trim() || lines[next].startsWith('#')))next++;
            if(lines[next])rows.push({url:new URL(lines[next].trim(),base).href,height,bandwidth});
        }
        return rows.sort((a,b)=>b.height-a.height || b.bandwidth-a.bandwidth);
    }
    async function validate(url, depth=0) {
        const expires=Number(new URL(url).searchParams.get('expires'));
        if(expires>0 && expires*1000<Date.now())throw new Error('Podpis odkazu expiroval.');
        const response=await sample(url);const text=new TextDecoder().decode(response.bytes).trimStart();
        if(hlsUrl(url) || /mpegurl/i.test(response.type) || text.startsWith('#EXTM3U')){
            if(!text.startsWith('#EXTM3U'))throw new Error('Odpoveď nie je HLS playlist.');
            const options=variants(text,response.url);
            if(options.length){
                if(depth>=2)throw new Error('Príliš veľa vnorených playlistov.');
                for(const candidate of options.slice(0,4)){
                    try {const checked=await validate(candidate.url,depth+1);return {...checked,masterUrl:response.url,height:candidate.height || checked.height};} catch { }
                }
                throw new Error('Žiadna kvalita playlistu nie je dostupná.');
            }
            const mediaLine=text.split(/\r?\n/).find(line=>line.trim() && !line.startsWith('#'));
            if(!mediaLine)throw new Error('Playlist neobsahuje video segment.');
            const segmentUrl=new URL(mediaLine.trim(),response.url).href;
            const first=await sample(segmentUrl,1024);
            if(!first.bytes.length)throw new Error('Video segment je prázdny.');
            return {streamUrl:response.url,isHls:true,verified:true,height:0};
        }
        if(!response.bytes.length)throw new Error('Prázdna video odpoveď.');
        if(!/^video\//i.test(response.type) && !/octet-stream/i.test(response.type) && !mediaUrl(response.url))throw new Error('Odpoveď nie je video.');
        return {streamUrl:response.url,isHls:false,verified:true,height:0};
    }
    async function resolve(msg,sender) {
        const tabId=sender.tab?.id;if(!Number.isInteger(tabId))throw new Error('Chýba zdrojová karta.');
        const tab=await chrome.tabs.get(tabId);const page=pageKey(tab.url);
        if(msg.pageUrl && pageKey(msg.pageUrl)!==page && pageKey(sender.url)!==pageKey(msg.pageUrl))throw new Error('Stránka sa počas overenia zmenila.');
        const all=await chrome.storage.session.get(null);
        const observed=Object.entries(all).filter(([k,v])=>k.startsWith(prefix) && v.tabId===tabId && v.pageUrl===page && Date.now()-v.ts<15*60*1000)
            .map(([,v])=>v).sort((a,b)=>Number(/master/i.test(b.url))-Number(/master/i.test(a.url)) || b.ts-a.ts);
        const requested=(msg.candidates || []).filter(mediaUrl);
        let candidates=msg.selectedOnly ? requested : [...observed.map(v=>v.url),...requested];
        candidates=[...new Set(candidates)].slice(0,12);
        let lastError='Prehrávač zatiaľ nevydal dostupný stream.';
        const deadline=Date.now()+12000;
        for(const url of candidates){
            try {
                const checked=await validate(url);
                const current=await chrome.tabs.get(tabId);
                if(pageKey(current.url)!==page)throw new Error('Zdrojová stránka sa zmenila.');
                return {ok:true,...checked,sourcePage:current.url};
            }catch(e){lastError=e.message;}
            if(Date.now()>deadline)break;
        }
        return {ok:false,error:`${lastError} Spusti alebo obnov prehrávanie na stránke a skús znova.`};
    }
    chrome.runtime.onMessage.addListener((msg,sender,respond)=>{
        if(!['START_DIRECT_CAPTURE','RESOLVE_DIRECT_STREAM','OPEN_DIRECT_PLAYER','GET_DIRECT_PLAYER'].includes(msg.action))return;
        if(sender.id!==chrome.runtime.id)return;
        void (async()=>{
            try{
                if(msg.action==='START_DIRECT_CAPTURE'){
                    if(!Number.isInteger(sender.tab?.id))throw new Error('Chýba zdrojová karta.');
                    const execution=await chrome.scripting.executeScript({target:{tabId:sender.tab.id,frameIds:[sender.frameId || 0]},world:'MAIN',func:async index=>{
                        const video=document.querySelectorAll('video')[index];
                        if(!video || video.closest('.nexus-import-overlay'))return {started:false};
                        video.muted=true;
                        await Promise.race([Promise.resolve(video.play()).catch(()=>{}),new Promise(resolve=>setTimeout(resolve,1500))]);
                        return {started:true};
                    },args:[Number(msg.videoIndex)]});
                    respond({ok:true,...execution?.[0]?.result});return;
                }
                if(msg.action==='GET_DIRECT_PLAYER'){
                    if(!sender.url?.startsWith(chrome.runtime.getURL('direct-player.html')))throw new Error('Neplatný prehrávač.');
                    const key='nexus_direct_player_'+String(msg.session || '');
                    const data=(await chrome.storage.session.get(key))[key];
                    if(!data)throw new Error('Odkaz už nie je uložený. Otvor video znova z panelu.');
                    if(data.sourcePage && httpUrl(data.sourcePage))await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[600000+sender.tab.id],addRules:[{
                        id:600000+sender.tab.id,priority:100,action:{type:'modifyHeaders',requestHeaders:[{header:'referer',operation:'set',value:data.sourcePage}]},
                        condition:{tabIds:[sender.tab.id],urlFilter:'|http',resourceTypes:['xmlhttprequest','media']}
                    }]});
                    respond({ok:true,...data});return;
                }
                const result=await resolve(msg,sender);
                if(result.ok && msg.action==='OPEN_DIRECT_PLAYER'){
                    const session=crypto.randomUUID();const key='nexus_direct_player_'+session;
                    await chrome.storage.session.set({[key]:{...result,createdAt:Date.now()}});
                    const opened=await chrome.tabs.create({url:chrome.runtime.getURL('direct-player.html')+'?session='+session});
                    result.playerTabId=opened.id;
                }
                respond(result);
            }catch(e){respond({ok:false,error:e.message});}
        })();
        return true;
    });
})();
