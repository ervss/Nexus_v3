/* ARCHVE metadata: stable watch URLs and public object metadata, never signed URLs. */
(function (root) {
  'use strict';
  function videoId(raw) {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:' || u.port || u.username || u.password) return '';
      if (/^hls\.archve\.xyz$/i.test(u.hostname)) {
        return u.pathname.match(/^\/([a-f0-9-]{8,64})(?:\/|$)/i)?.[1] || '';
      }
      if (!/(^|\.)archve\.xyz$/i.test(u.hostname)) return '';
      return u.pathname.match(/^\/(?:watch|e|d)\/([a-f0-9-]{8,64})\/?$/i)?.[1] || '';
    } catch { return ''; }
  }
  function canonicalVideoUrl(raw) {
    const id = videoId(raw);
    return id ? `https://archve.xyz/watch/${id}` : '';
  }
  function kind(raw) {
    if (videoId(raw)) return 'video';
    try { const u = new URL(raw); if (u.protocol !== 'https:' || !/(^|\.)archve\.xyz$/i.test(u.hostname)) return ''; return /^\/albums\/[a-z0-9_-]+\/?$/i.test(u.pathname) ? 'album' : ''; } catch { return ''; }
  }
  function seconds(raw) { return /^\d+:\d{2}(?::\d{2})?$/.test(raw || '') ? raw.split(':').reduce((a, n) => a * 60 + Number(n), 0) : 0; }
  function clock(n) { n = Math.round(n); const h = Math.floor(n / 3600); const m = Math.floor(n % 3600 / 60); const s = n % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`; }
  function parseVideo(html) {
    const field = name => {
      const m = String(html).match(new RegExp(`<span\\b[^>]*title=["']${name}["'][^>]*>([\\s\\S]*?)<\\/span>`, 'i'));
      return (m?.[1] || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    };
    const dims = field('Resolution').match(/(\d+)\s*[x×]\s*(\d+)/i);
    const sz = field('File size').match(/([\d.,]+)\s*(KB|MB|GB|TB)/i);
    const sizeMb = sz ? Number(sz[1].replace(',', '.')) * ({KB:1/1024, MB:1, GB:1024, TB:1024**2}[sz[2].toUpperCase()]) : 0;
    const dateMatch = String(html).match(/<(?:time\b[^>]*\bdatetime|meta\b[^>]*(?:itemprop|property)=["'](?:uploadDate|datePublished|article:published_time)["'][^>]*\bcontent)=["']([^"']+)["']/i)
      || String(html).match(/"(?:uploadDate|datePublished)"\s*:\s*"([^"]+)"/i);
    const stamp = dateMatch && Date.parse(dateMatch[1]);
    return {title: (String(html).match(/<div\b[^>]*class=["'][^"']*watch-meta[^"']*["'][^>]*>\s*<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '').replace(/<[^>]*>/g, '').trim(), duration: field('Duration') || null, sizeMb: sizeMb || null, width:Number(dims?.[1] || 0), height:Number(dims?.[2] || 0), date:stamp ? new Date(stamp).toISOString().slice(0,10) : null};
  }
  function parseAlbum(html, base) {
    const urls = new Set();
    for (const match of String(html).matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)) {
      try { const u = new URL(match[1].replace(/&amp;/g, '&'), base); if (kind(u.href) === 'video') { u.search=''; u.hash=''; urls.add(u.href); } } catch {}
    }
    const lead = String(html).match(/<p\b[^>]*class=["'][^"']*\blead\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] || '';
    const count = Number(lead.replace(/<[^>]*>/g, ' ').match(/(\d+)\s+videos?\b/i)?.[1] || 0);
    return {urls:[...urls], count: count || urls.size};
  }
  function createFetcher({fetchImpl, readCache, writeCache, formatSizeMb}) {
    const inflight = new Map(), waiting = []; let active = 0;
    async function request(url, options) {
      if (active >= 4) await new Promise(resolve => waiting.push(resolve));
      active++;
      try { return await fetchImpl(url, options); } finally { active--; waiting.shift()?.(); }
    }
    async function video(url, force = false) {
      const id = videoId(url);
      const watchUrl = id ? `https://archve.xyz/watch/${id}` : url;
      const directHls = /^https:\/\/hls\.archve\.xyz\//i.test(String(url || '')) ? url : '';
      if (inflight.has(watchUrl)) return inflight.get(watchUrl);
      const p = (async () => {
        if (!force) { const c = await readCache(watchUrl); if (c?.adapter === 'archve-video-v2' && c.sizeExact && c.date) return c; }
        let meta = { title: '', duration: null, sizeMb: null, width: 0, height: 0, date: null };
        try {
          const response = await request(watchUrl, {credentials:'include', signal:AbortSignal.timeout(15000)});
          if (response.ok) meta = parseVideo(await response.text());
          else if (!directHls) throw new Error(`HTTP ${response.status}`);
        } catch (err) {
          if (!directHls) throw err;
        }
        let dateEstimated = false, sizeEstimated = Boolean(meta.sizeMb);
        for (const probeUrl of [`https://archve.xyz/d/${id || new URL(watchUrl).pathname.split('/')[2]}`, ...(directHls ? [directHls] : [])]) {
          try {
            const media = await request(probeUrl, {method:'GET', headers:{Range:'bytes=0-0'}, credentials:'include', signal:AbortSignal.timeout(12000)});
            const total = media.status === 206 && media.headers.get('content-range')?.match(/\/(\d+)$/)?.[1];
            if (total) { meta.sizeMb = Number(total) / 1048576; sizeEstimated = false; }
            const modified = Date.parse(media.headers.get('last-modified') || '');
            if (!meta.date && Number.isFinite(modified)) { meta.date = new Date(modified).toISOString().slice(0,10); dateEstimated = true; }
            await media.body?.cancel().catch(() => {});
            if (total) break;
          } catch {}
        }
        Object.assign(meta, {quality:meta.height ? `${meta.height}P` : null, sizeText:meta.sizeMb ? `${sizeEstimated ? '≈' : ''}${formatSizeMb(meta.sizeMb) || `${(meta.sizeMb * 1024).toFixed(1)} KB`}` : null, sizeExact:!sizeEstimated && !!meta.sizeMb, sizeEstimated, dateEstimated, adapter:'archve-video-v2'});
        if (meta.duration || meta.sizeMb || meta.date) await writeCache(watchUrl, meta);
        return meta;
      })();
      inflight.set(watchUrl, p);
      try { return await p; } finally { inflight.delete(watchUrl); }
    }
    async function album(url, force = false) {
      if (!force) { const c = await readCache(url); if (c?.adapter === 'archve-album-v2' && c.complete && Date.now() - Number(c.ts || 0) < 30 * 60 * 1000) return c; }
      const response = await request(url, {credentials:'include', signal:AbortSignal.timeout(15000)});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const list = parseAlbum(await response.text(), url);
      const results = await Promise.allSettled(list.urls.map(u => video(u, force)));
      const items = results.filter(r => r.status === 'fulfilled').map(r => r.value);
      const sized = items.filter(x => x.sizeMb), durations = items.map(x => seconds(x.duration)).filter(Boolean), dated = items.filter(x => x.date).sort((a,b) => b.date.localeCompare(a.date));
      const complete = list.count === list.urls.length && items.length === list.urls.length;
      const allSizes = complete && sized.length === list.count;
      const sizeMb = sized.reduce((a,x) => a+x.sizeMb, 0);
      const estimated = !allSizes || sized.some(x => x.sizeEstimated);
      const meta = {adapter:'archve-album-v2', videoUrls:list.urls, complete, videoCount:list.count, loadedCount:items.length, sizeMb:sizeMb || null, sizeText:sizeMb ? `${estimated ? '≈' : ''}${formatSizeMb(sizeMb) || `${(sizeMb * 1024).toFixed(1)} KB`}${!allSizes ? ' (čiastočne)' : ''}` : null, sizeEstimated:estimated, sizeExact:allSizes && !estimated, duration:durations.length ? clock(durations.reduce((a,b) => a+b, 0)/durations.length) : null, durationPartial:durations.length !== list.count, date:dated[0]?.date || null, dateEstimated:!!dated[0]?.dateEstimated, datePartial:!complete || dated.length !== list.count};
      if (complete && allSizes && durations.length === list.count && dated.length === list.count) await writeCache(url,meta);
      return meta;
    }
    return {video, album};
  }
  const api = {videoId, canonicalVideoUrl, kind, seconds, clock, parseVideo, parseAlbum, createFetcher};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NVSArchve = api;
})(globalThis);
