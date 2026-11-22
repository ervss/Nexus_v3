/* XVideos listing adapter: normalize cards, tags and native pagination. */
(function () {
  'use strict';
  function onSite(url) { try { return /(^|\.)xvideos\.(?:com|red)$/i.test(new URL(url, location.href).hostname); } catch { return false; } }
  function watchUrl(raw, base = location.href) {
    try {
      const u = new URL(raw, base);
      if (!onSite(u.href)) return '';
      if (/^\/(?:prof-video-click|model-click)\//i.test(u.pathname)) {
        const target = u.searchParams.get('url') || u.searchParams.get('video');
        if (target) return watchUrl(target, base);
        const match = u.pathname.match(/^\/(?:prof-video-click|model-click)\/(?:upload(?:-(?:straight|gay|shemale))?|pornstar(?:-(?:straight|gay|shemale))?|profiles?|models?|members?)\/[^/]+\/([a-z0-9]+)(?:\/([^/]*))?\/?$/i);
        if (!match) return '';
        u.pathname = `/video${/^\d+$/.test(match[1]) ? '' : '.'}${match[1]}/${match[2] || ''}`;
      }
      if (!/^\/video(?:\.[^/]+|\d+)/i.test(u.pathname)) return '';
      u.hash = ''; u.search = ''; return u.href;
    } catch { return ''; }
  }
  const cardSelector = '.thumb-block, .mozaique .thumb-block, [class*="thumb-block"]';
  function cards(root = document, base = location.href) {
    const seen = new Set(), out = [];
    for (const card of root.querySelectorAll(cardSelector)) {
      const link = [...card.querySelectorAll('a[href]')].find(a => watchUrl(a.getAttribute('href'), base));
      const url = watchUrl(link?.getAttribute('href'), base);
      if (!url || seen.has(url)) continue;
      seen.add(url); out.push({ card, url });
    }
    return out;
  }
  function profileTab(root) {
    return root.querySelector?.('#tabVideos') || null;
  }
  function profilePageUrl(root, base, page) {
    try {
      const current = new URL(base);
      const profile = current.pathname.match(/^\/(pornstars|models)\/([^/]+)\/?$/i);
      if (!profile || !Number.isInteger(Number(page)) || Number(page) < 0) return '';
      const tab = profileTab(root);
      if (!tab) return '';
      const sort = tab.querySelector('[data-sort].is-selected')?.getAttribute('data-sort') || 'best';
      const link = tab.querySelector('a[href*="/prof-video-click/"], a[href*="/model-click/"]');
      const trackingPath = link ? new URL(link.getAttribute('href'), base).pathname : '';
      const content = trackingPath.match(/\/(?:prof-video-click|model-click)\/(?:pornstar-)?(straight|gay|shemale|trans)\//i)?.[1] || 'straight';
      current.pathname = `${current.pathname.replace(/\/$/, '')}/videos/${encodeURIComponent(sort)}/${encodeURIComponent(content)}/${Number(page)}`;
      current.search = '';
      current.hash = '';
      return current.href;
    } catch {
      return '';
    }
  }
  function nextProfileUrl(root = document, base = location.href) {
    const tab = profileTab(root);
    if (!tab) return '';
    const links = [...tab.querySelectorAll('.pagination [data-page]')];
    if (!links.length) return '';
    const active = links.find(link => /\bactive\b/.test(link.className || ''));
    const current = Number(active?.getAttribute('data-page')) || 0;
    const next = links.map(link => Number(link.getAttribute('data-page')))
      .filter(page => Number.isInteger(page) && page > current)
      .reduce((lowest, page) => Math.min(lowest, page), Infinity);
    return Number.isFinite(next) ? profilePageUrl(root, base, next) : '';
  }
  function cardsFromJson(data, base = location.href) {
    if (!Array.isArray(data?.videos)) return [];
    const seen = new Set(), out = [];
    for (const item of data.videos) {
      const url = watchUrl(item?.u, base);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const title = String(item.tf || item.t || '').trim();
      const card = document.createElement('div');
      card.className = 'thumb-block tb_full_init';
      if (item.eid) {
        card.id = `video_${item.eid}`;
        card.dataset.eid = String(item.eid);
      }
      if (item.id != null) card.dataset.id = String(item.id);
      const inside = document.createElement('div');
      inside.className = 'thumb-inside';
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      const link = document.createElement('a');
      link.setAttribute('href', item.u);
      if (title) link.setAttribute('title', title);
      const image = document.createElement('img');
      const imageUrl = [item.i, item.il, item.if].find(value => {
        try { const parsed = new URL(value, base); return parsed.protocol === 'https:' && /(^|\.)xvideos-cdn\.com$/i.test(parsed.hostname); } catch { return false; }
      });
      if (imageUrl) {
        image.src = imageUrl;
        image.alt = title;
        image.loading = 'lazy';
        link.appendChild(image);
      }
      thumb.appendChild(link);
      inside.appendChild(thumb);
      card.appendChild(inside);
      const under = document.createElement('div');
      under.className = 'thumb-under';
      const titleNode = document.createElement('p');
      titleNode.className = 'title';
      const titleLink = document.createElement('a');
      titleLink.setAttribute('href', item.u);
      if (title) titleLink.setAttribute('title', title);
      titleLink.textContent = title || url.split('/').pop().replace(/_/g, ' ');
      titleNode.appendChild(titleLink);
      under.appendChild(titleNode);
      if (item.d) {
        const duration = document.createElement('span');
        duration.className = 'duration';
        duration.textContent = String(item.d);
        under.appendChild(duration);
      }
      card.appendChild(under);
      out.push({ card, url });
    }
    return out;
  }
  function nextUrl(root = document, base = location.href) {
    if (/^\/(?:pornstars|models)\/[^/]+\/?$/i.test(new URL(base).pathname) && profileTab(root)) {
      return nextProfileUrl(root, base);
    }
    const next = [...root.querySelectorAll('a[href]')].find(a => {
      const label = `${a.getAttribute('rel') || ''} ${a.getAttribute('aria-label') || ''} ${a.textContent || ''} ${a.getAttribute('title') || ''}`.replace(/\s+/g, ' ').trim();
      return /(?:^|\s)(?:next|pagination-next)(?:\s|$)/i.test(a.className || '') || /^(?:›|»|>|next|next page|ďalšia|ďalšia stránka)$/i.test(label) || /pagination-next/i.test(a.parentElement?.className || '');
    });
    if (next) { try { const u = new URL(next.getAttribute('href'), base); return onSite(u.href) && !watchUrl(u.href, base) ? u.href : ''; } catch { } }
    const current = new URL(base), page = Number(current.searchParams.get('p')) || 0;
    const lastLink = [...root.querySelectorAll('a[href]')].map(a => { try { return Number(new URL(a.href, base).searchParams.get('p')) || 0; } catch { return 0; } }).reduce((a,b) => Math.max(a,b),0);
    const max = Number(root.querySelector('[data-num-pages]')?.getAttribute('data-num-pages')) || lastLink;
    if (max && page + 1 > max) return '';
    current.searchParams.set('p', String(page + 1)); return current.href;
  }
  function normalizeTag(v) { return String(v || '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 100); }
  function tagsFromDocument(doc, base) {
    const tags = new Set();
    for (const a of doc.querySelectorAll('a[href*="/tags/"], a[href*="/profiles/"]')) {
      const u = new URL(a.getAttribute('href'), base); if (!onSite(u.href)) continue;
      const m = u.pathname.match(/^\/tags\/([^/]+)/i); const tag = normalizeTag(m ? decodeURIComponent(m[1]) : a.textContent);
      if (m && tag && !tag.includes(',')) tags.add(tag);
    }
    if (!tags.size) throw new Error('Tagy sa nenašli.');
    return [...tags].slice(0, 80);
  }
  function createTagLoader(options = {}) {
    const cache = new Map(), controllers = new Set(), key = 'nvs-xv-tags-v1';
    let status = { active:false, done:0, total:0, errors:0, stopped:false };
    try { for (const [url, entry] of JSON.parse(sessionStorage.getItem(key) || '[]')) if (watchUrl(url, url) === url && entry.ts > Date.now()-86400000) cache.set(url, entry); } catch { }
    const changed = () => options.changed?.();
    async function load(rawUrls) {
      if (status.active) return { ...status, busy:true };
      const urls = [...new Set(rawUrls.map(u => watchUrl(u)).filter(Boolean))].filter(u => !cache.has(u));
      status = { active:true, done:0, total:urls.length, errors:0, stopped:false }; changed(); let index=0;
      async function worker() { while (index<urls.length && !status.stopped) { const url=urls[index++], c=new AbortController(); controllers.add(c); try { const r=await fetch(url,{credentials:'include',signal:c.signal}); if (!r.ok) throw Error(); cache.set(url,{tags:tagsFromDocument(new DOMParser().parseFromString(await r.text(),'text/html'),url),ts:Date.now()}); } catch { if (!status.stopped) status.errors++; } finally { controllers.delete(c); if (!status.stopped) status.done++; changed(); } } }
      try { await Promise.all(Array.from({length:Math.min(3,urls.length)},worker)); } finally { status.active=false; try { sessionStorage.setItem(key,JSON.stringify([...cache].slice(-500))); } catch {} changed(); }
      return { ...status };
    }
    return { get(url) { const v=cache.get(watchUrl(url)); return v ? {tags:[...v.tags],fetched:true}:{tags:[],fetched:false}; }, status:()=>({...status}), load, stop(){status.stopped=true;controllers.forEach(c=>c.abort());changed();} };
  }
  window.NVSXvideosListing = { cardSelector, cards, cardsFromJson, watchUrl, nextUrl, nextProfileUrl, profilePageUrl, tagsFromDocument, normalizeTag, createTagLoader };
})();
