/* Site adapters for the shared listing player. Never execute remote player JS. */
(() => {
  'use strict';
  const definitions = {
    pimpbunny: { host: /(^|\.)pimpbunny\.com$/i, path: /^\/videos\/[^/]+\/?$/, label: 'PIMPBUNNY', cards: '.b6m-video, [class*="ui-card-root"][class*="ui-card-video"]' },
    xhamster: { host: /(^|\.)xhamster(?:-fr)?\.com$|(^|\.)xhamster\.desi$/i, path: /^\/videos\/[^/]+\/?$/, label: 'XHAMSTER', cards: '.thumb-list__item, .video-thumb, [data-video-id]' },
    eporner: { host: /(^|\.)eporner\.com$/i, path: /^\/(?:video-[a-z0-9]+|hd-porn\/[a-z0-9]+)(?:\/[^/?#]*)?\/?$/i, label: 'EPORNER', cards: '.mb, .mbvid, .video-item' },
    xvideos: { host: /(^|\.)xvideos\.(?:com|red)$/i, path: /^\/video(?:\.[a-z0-9]+|\d+)(?:\/[^/?#]*)?\/?$/i, label: 'XVIDEOS', cards: '.thumb-block, .video-thumb, .video-snippet, [data-id]' },
    spankbang: { host: /(^|\.)spankbang\.(?:com|party)$/i, path: /^\/(?:[a-z0-9]+\/video\/[^/?#]+|[a-z0-9]+-[a-z0-9]+\/playlist\/[^/?#]+)\/?$/i, label: 'SPANGBANG', cards: 'div.js-media-list:not(.js-forced-layout) [data-testid="video-item"]' },
  };
  function site(raw) { try { const u = new URL(raw); return Object.keys(definitions).find(k => definitions[k].host.test(u.hostname)) || ''; } catch { return ''; } }
  function watchUrl(raw, base, depth = 0) {
    try {
      if (depth > 4) return '';
      const u = new URL(raw, base), b = new URL(base), key = site(b.href);
      if (!key || site(u.href) !== key || u.protocol !== 'https:' || u.username || u.password) return '';
      if (key === 'xvideos' && /^\/(?:prof-video-click|model-click)\//.test(u.pathname)) {
        const target = u.searchParams.get('url') || u.searchParams.get('video');
        if (target) return watchUrl(target, base, depth + 1);
        // Profile tabs use the tracking path itself, without a URL query.
        // Match the existing Nexus Gallery importer and preserve old numeric IDs.
        const match = u.pathname.match(/^\/(?:prof-video-click|model-click)\/(?:upload(?:-(?:straight|gay|shemale))?|pornstar(?:-(?:straight|gay|shemale))?|profiles?|models?|members?)\/[^/]+\/([a-z0-9]+)(?:\/([^/]*))?\/?$/i);
        if (!match) return '';
        const id = match[1], slug = match[2] || '';
        u.pathname = `/video${/^\d+$/.test(id) ? '' : '.'}${id}/${slug}`;
      }
      if (!definitions[key].path.test(u.pathname)) return '';
      u.hash = ''; u.search = ''; return u.href;
    } catch { return ''; }
  }
  const clean = value => String(value || '').replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
  function mediaUrl(raw, base) {
    try {
      const u = new URL(clean(raw), base);
      return u.protocol === 'https:' && !u.username && !u.password && !/preview|trailer|sample|\.jpg/i.test(u.pathname)
        && (/\.(?:mp4|m3u8|webm)(?:\/|$)/i.test(u.pathname) || /\/(?:get_file|dload)\//.test(u.pathname)) ? u.href : '';
    } catch { return ''; }
  }
  function parseSources(html, pageUrl) {
    const key = site(pageUrl), text = clean(html), out = [], seen = new Set();
    const add = (raw, height = 0, label = '') => {
      const url = mediaUrl(raw, pageUrl); if (!url || seen.has(url)) return;
      seen.add(url); height = Number(height) || Number(url.match(/(?:[_/-]|=)(\d{3,4})p(?:[._/]|$)/)?.[1]) || 0;
      out.push({ url, height, quality: height ? `${height}P` : label || 'ORIGINAL', type: /\.m3u8/i.test(new URL(url).pathname) ? 'hls' : 'file' });
    };
    if (key === 'pimpbunny') {
      const license = text.match(/\blicense_code\s*:\s*['"]([^'"]+)['"]/)?.[1] || '';
      for (const m of text.matchAll(/\b(video_(?:alt_)?url\d*)\s*:\s*['"]([^'"]+)['"]/g)) {
        const label = text.match(new RegExp(`\\b${m[1]}_text\\s*:\\s*['"]([^'"]+)['"]`))?.[1] || '';
        let raw = m[2];
        if (raw.startsWith('function/0/')) { try { raw = window.NVSListingPlayer.realUrl(raw, license); } catch { continue; } }
        add(raw, label.match(/(\d{3,4})\s*p/i)?.[1] || (/4k/i.test(label) ? 2160 : /2k/i.test(label) ? 1440 : 0));
      }
    } else if (key === 'xvideos') {
      for (const m of text.matchAll(/\bsetVideo(?:Url)?(Low|High|HLS|\d{3,4}p|4k|2k)\s*\(\s*['"]([^'"]+)['"]/gi)) {
        const height = /4k/i.test(m[1]) ? 2160 : /2k/i.test(m[1]) ? 1440 : parseInt(m[1]) || 0;
        // High/Low are site labels, not verified pixel dimensions.
        add(m[2], height, /high/i.test(m[1]) ? 'High' : /low/i.test(m[1]) ? 'Low' : 'HLS');
      }
    } else if (key === 'eporner') {
      for (const m of text.matchAll(/href\s*=\s*['"]([^'"]*\/dload\/[^'"]+)['"]/gi)) add(m[1], m[1].match(/\/dload\/[^/]+\/(\d+)/)?.[1]);
      for (const m of text.matchAll(/['"](\d{3,4})p?['"]\s*:\s*['"]([^'"]+)['"]/g)) add(m[2], m[1]);
      for (const m of text.matchAll(/"contentUrl"\s*:\s*"([^"\n]+)"/g)) add(m[1]);
    } else if (key === 'xhamster') {
      const raw = text.match(/<script[^>]*id=['"]initials-script['"][^>]*>([\s\S]*?)<\/script>/i)?.[1]
        || text.match(/window\.initials\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/i)?.[1] || '';
      let data;
      try { data = JSON.parse(raw.trim().replace(/^window\.initials\s*=\s*/, '').replace(/;\s*$/, '')); } catch { }
      const walk = (value, depth = 0) => {
        if (!value || depth > 12) return;
        if (typeof value === 'string') { add(value); return; }
        if (typeof value !== 'object') return;
        if (value.url || value.src) add(value.url || value.src, value.height || String(value.quality || '').match(/\d{3,4}/)?.[0]);
        for (const item of Object.values(value)) walk(item, depth + 1);
      };
      walk(data?.xplayerSettings?.sources || data?.xplayerSettings);
      if (!out.length) {
        // Preload belongs to the main player; related card URLs are excluded.
        for (const m of text.matchAll(/<link[^>]+(?:rel=['"]preload['"]|as=['"]fetch['"])[^>]*>/gi)) add(m[0].match(/href=['"]([^'"]+)/)?.[1]);
      }
    } else if (key === 'spankbang') {
      for (const source of (globalThis.NVSSpankBangListing?.sourcesFromHtml(text) || [])) add(source.url, source.height, source.quality);
    }
    if (key === 'eporner') for (const source of out) source.quality += /av1/i.test(source.url) ? ' · AV1' : ' · H.264';
    return out.sort((a, b) => b.height - a.height || Number(b.type === 'hls') - Number(a.type === 'hls')
      || Number(/High/i.test(b.quality)) - Number(/High/i.test(a.quality)) || Number(/av1/i.test(a.url)) - Number(/av1/i.test(b.url)));
  }
  function variants(text, masterUrl) {
    const lines = String(text).trim().split(/\r?\n/), out = []; let info = null, level = 0;
    if (lines[0]?.replace(/^\uFEFF/, '') !== '#EXTM3U') return [];
    for (const line of lines) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) info = line;
      else if (info && line.trim() && !line.startsWith('#')) {
        const height = Number(info.match(/RESOLUTION=\d+x(\d+)/i)?.[1]) || 0;
        const bandwidth = Number(info.match(/AVERAGE-BANDWIDTH=(\d+)/)?.[1] || info.match(/\bBANDWIDTH=(\d+)/)?.[1]) || 0;
        // Keep the master for audio groups, but identify the variant independently
        // of its original index: HLS.js sorts and filters levels before playback.
        out.push({url:masterUrl,variantUrl:new URL(line.trim(),masterUrl).href,type:'hls',height,quality:height ? `${height}P · HLS` : 'HLS',bandwidth,level:level++}); info = null;
      }
    }
    return out.sort((a,b)=>b.height-a.height || b.bandwidth-a.bandwidth);
  }
  function epornerRequest(html, pageUrl) {
    const id = String(html).match(/EP\.video\.player\.vid\s*=\s*['"]([a-z0-9]+)/i)?.[1];
    const hash = String(html).match(/EP\.video\.player\.hash\s*=\s*['"]([a-f0-9]{32})/i)?.[1];
    if (!id || !hash) return '';
    const u = new URL(`/xhr/video/${id}`, pageUrl);
    u.search = new URLSearchParams({hash:[0,8,16,24].map(i=>parseInt(hash.slice(i,i+8),16).toString(36)).join(''),
      domain:u.hostname,pixelRatio:'1',playerWidth:'1200',playerHeight:'675',fallback:'false',embed:'false',supportedFormats:'hls,mp4'}).toString();
    return u.href;
  }
  function epornerSources(data, pageUrl) {
    const id = new URL(pageUrl).pathname.match(/(?:video-|hd-porn\/)([a-z0-9]+)/i)?.[1];
    if (!data || data.available === false || String(data.vid) !== id) return [];
    const out=[];
    for (const [type, entries] of Object.entries(data.sources || {})) {
      if (!['hls','mp4'].includes(type)) continue;
      for (const [label, value] of Object.entries(entries || {})) {
        const url=mediaUrl(value?.src,pageUrl);if(!url)continue;
        const height=Number(label.match(/\d{3,4}/)?.[0]) || 0;
        out.push({url,type:type==='hls'?'hls':'file',height,quality:height?`${height}P · H.264`:'HLS'});
      }
    }
    return out;
  }
  async function fetchText(url, signal) {
    if (signal?.aborted) throw new DOMException('Aborted','AbortError');
    try {
      const result = await chrome.runtime.sendMessage({type:'NVS_PLAYER_FETCH',url});
      if (signal?.aborted) throw new DOMException('Aborted','AbortError');
      const challenged = /spankbang\./i.test(url) && /Just a moment\.\.\.|__cf_chl_opt/i.test(String(result?.text || '').slice(0, 6000));
      if (result?.ok && typeof result.text === 'string' && !challenged) return result;
    } catch (error) { if (signal?.aborted) throw error; }
    const res = await fetch(url,{credentials:'include',signal});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return {text:await res.text(),url:res.url || url};
  }
  function embedUrl(entry) {
    const key = site(entry.url), u = new URL(entry.url);
    if (key === 'pimpbunny') return entry.embedUrl || '';
    if (key === 'eporner') { const id = u.pathname.match(/(?:video-|hd-porn\/)([a-z0-9]+)/i)?.[1]; return id ? `${u.origin}/embed/${id}/` : ''; }
    if (key === 'xvideos') { const id = u.pathname.match(/^\/video\.?([a-z0-9]+)/i)?.[1]; return id ? `${u.origin}/embedframe/${id}` : ''; }
    return entry.embedUrl || '';
  }
  function collect(root, key, { includeHidden = false } = {}) {
    const seen = new Set(), out = [];
    for (const card of root.querySelectorAll(definitions[key].cards)) {
      if (key === 'xvideos' && !card.matches('.thumb-block, .video-thumb, .video-snippet')
        && card.querySelector('.thumb-block, .video-thumb, .video-snippet')) continue;
      if (!includeHidden && (card.hidden || card.classList.contains('nvs-hidden') || card.closest('[hidden], .nvs-hidden') || getComputedStyle(card).display === 'none')) continue;
      if (!includeHidden && card.getClientRects && !card.getClientRects().length) continue;
      const links = card.matches('a[href]') ? [card] : [...card.querySelectorAll('a[href]')];
      const link = links.find(a=>watchUrl(a.href,location.href));
      const url = link && watchUrl(link.href,location.href);
      if (!url || seen.has(url) || !card.querySelector('img,picture,video,[style*="background-image"]')) continue;
      seen.add(url);
      const title = (key === 'spankbang' && globalThis.NVSSpankBangListing?.titleFromCard(card))
        || card.querySelector('.title a, .title, .video-thumb__title, .mbtit a')?.textContent.trim()
        || link.title || card.querySelector('img')?.alt || 'Video';
      out.push({url,title,card});
    }
    return out;
  }
  function adapter(key) {
    return {
      label:definitions[key].label,cardSelector:definitions[key].cards,collect:root=>collect(root,key),embedUrl,
      playHost: card => key === 'spankbang'
        ? (card.querySelector('a[href*="/video/"], a[href*="/playlist/"]') || card)
        : (card.querySelector('.thumb, .thumb-image-container, .video-thumb__image-container, .mbcontent, [class*="ui-card-image"]') || card),
      async probeSize(url) {
        try { const result=await chrome.runtime.sendMessage({type:'NVS_PLAYER_SIZE',url});if(result && 'sizeBytes' in result)return result; } catch { }
        // Also supports a development preview before the background is reloaded.
        try { const res=await fetch(url,{method:'HEAD',credentials:'include',signal:AbortSignal.timeout(6000)});
          const sizeBytes=Number(res.headers.get('content-length'));
          if(res.ok && !/html|json|mpegurl/i.test(res.headers.get('content-type') || '') && sizeBytes>0)return {sizeBytes};
        } catch { }
        return {sizeBytes:null};
      },
      async resolve(entry, signal) {
        const result = await fetchText(entry.url, signal), html = result.text;
        if (key === 'pimpbunny') {
          const id = html.match(/\/embed\/(\d+)/)?.[1];
          entry.embedUrl = id ? `${new URL(entry.url).origin}/embed/${id}` : '';
        } else if (key === 'xhamster') {
          const id = html.match(/"xplayerSettings"\s*:\s*\{\s*"videoId"\s*:\s*(\d+)/)?.[1];
          entry.embedUrl = id ? `${new URL(entry.url).origin}/xembed.php?video=${id}` : '';
        }
        let sources = parseSources(html, entry.url);
        if (key === 'eporner') {
          const request=epornerRequest(html,entry.url);
          if (request) try {
            const response=await fetchText(request,signal);
            const playable=epornerSources(JSON.parse(response.text),entry.url);
            // Prefer actual player URLs over download redirects at equal height.
            sources=[...playable,...sources.filter(s=>!playable.some(p=>p.type==='file' && p.height===s.height))].sort((a,b)=>b.height-a.height);
          } catch { }
        }
        const expanded = [];
        for (const source of sources) {
          if (signal?.aborted) throw new DOMException('Aborted','AbortError');
          if (source.type !== 'hls') { expanded.push(source); continue; }
          try { const manifest = await fetchText(source.url, signal); expanded.push(...(variants(manifest.text,manifest.url).length ? variants(manifest.text,manifest.url) : [source])); }
          catch { expanded.push(source); }
        }
        return expanded.sort((a,b)=>b.height-a.height || Number(b.type === 'hls')-Number(a.type === 'hls')
          || Number(/High/i.test(b.quality))-Number(/High/i.test(a.quality)));
      },
    };
  }
  function start(panel) {
    const key = site(location.href); if (!key || !window.NVSListingPlayer) return;
    if (!panel) {
      panel = document.getElementById('nvs-listing-player-launch');
      if (!panel) { panel=document.createElement('div');panel.id='nvs-listing-player-launch';document.body.append(panel); }
    }
    return window.NVSListingPlayer.attach(document.body,panel,adapter(key));
  }
  window.NVSMultiSitePlayer = {start,site,watchUrl,mediaUrl,parseSources,variants,epornerRequest,epornerSources,collect,adapter,embedUrl};
})();
