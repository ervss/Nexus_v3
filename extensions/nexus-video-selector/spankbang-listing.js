/* SpankBang listing adapter. The promoted js-forced-layout strip is not the result grid. */
(function () {
  'use strict';
  const HOST = /(^|\.)spankbang\.(?:com|party)$/i;
  const WATCH_PATH = /^\/([a-z0-9]+)\/video\/([^/?#]+)\/?$/i;
  // A playlist grid does not link to /id/video/slug. Each card links to
  // /{playlist}-{token}/playlist/{name}, and that page is the player.
  const PLAYLIST_ITEM = /^\/([a-z0-9]+)-([a-z0-9]+)\/playlist\/([^/?#]+)\/?$/i;
  const RENDITIONS = [['4k', 2160], ['1080p', 1080], ['720p', 720], ['480p', 480], ['320p', 320], ['240p', 240]];

  function pageBase() {
    try { if (typeof location !== 'undefined' && location.href) return location.href; } catch { }
    return 'https://spankbang.com/';
  }
  function onSite(url) {
    try { return HOST.test(new URL(url, pageBase()).hostname); } catch { return false; }
  }
  function isChallenge(html) {
    return /Just a moment\.\.\.|__cf_chl_opt/i.test(String(html || '').slice(0, 6000));
  }
  function watchUrl(raw, base = pageBase()) {
    try {
      const url = new URL(raw, base);
      if (!onSite(url.href) || url.username || url.password) return '';
      const video = url.pathname.match(WATCH_PATH);
      const playlist = url.pathname.match(PLAYLIST_ITEM);
      if (!video && !playlist) return '';
      url.protocol = 'https:';
      url.username = '';
      url.password = '';
      url.pathname = video
        ? `/${video[1]}/video/${video[2]}/`
        : `/${playlist[1]}-${playlist[2]}/playlist/${playlist[3]}/`;
      url.search = '';
      url.hash = '';
      return url.href;
    } catch { return ''; }
  }
  function isListing(raw) {
    try {
      const url = new URL(raw, pageBase());
      return onSite(url.href) && !watchUrl(url.href, url.href);
    } catch { return false; }
  }
  function pageOf(pathname) {
    const match = String(pathname || '').replace(/\/+$/, '').match(/\/(\d{1,5})$/);
    const page = match ? Number(match[1]) : 1;
    return page >= 1 ? page : 1;
  }
  function resultGrid(root) {
    if (!root?.querySelectorAll) return null;
    let best = null;
    let count = -1;
    for (const grid of root.querySelectorAll('div.js-media-list')) {
      if (grid.classList?.contains('js-forced-layout')) continue;
      const cards = grid.querySelectorAll('[data-testid="video-item"]').length;
      if (cards > count) { best = grid; count = cards; }
    }
    return best;
  }
  function fieldsFromCard(card, base = pageBase()) {
    if (!card?.querySelectorAll) return null;
    const link = [...card.querySelectorAll('a[href]')].find(anchor => watchUrl(anchor.getAttribute('href'), base));
    const url = watchUrl(link?.getAttribute('href'), base);
    if (!url) return null;
    let title = '';
    for (const anchor of card.querySelectorAll('a[href]')) {
      if (!watchUrl(anchor.getAttribute('href'), base)) continue;
      title = (anchor.getAttribute('title') || '').trim();
      if (title) break;
    }
    if (!title) title = (card.querySelector('img')?.getAttribute('alt') || '').trim();
    const duration = (card.querySelector('[data-testid="video-item-length"]')?.textContent || '').trim();
    const badge = (card.querySelector('[data-testid="video-item-resolution"]')?.textContent || '').trim().toUpperCase();
    const quality = badge.includes('4K') ? '4K' : badge.includes('HD') ? 'HD' : '';
    return { url, title, duration, quality };
  }
  function titleFromCard(card, base = pageBase()) {
    return fieldsFromCard(card, base)?.title || '';
  }
  const cardSelector = 'div.js-media-list:not(.js-forced-layout) [data-testid="video-item"]';
  function cards(root, base = pageBase()) {
    const grid = resultGrid(root);
    if (!grid) return [];
    const seen = new Set();
    const out = [];
    for (const card of grid.querySelectorAll('[data-testid="video-item"]')) {
      const fields = fieldsFromCard(card, base);
      if (!fields || seen.has(fields.url)) continue;
      seen.add(fields.url);
      out.push({ card, ...fields });
    }
    return out;
  }
  function nextUrl(root, base = pageBase()) {
    if (!isListing(base) || !root?.querySelector) return '';
    let current;
    try { current = pageOf(new URL(base).pathname); } catch { return ''; }
    const block = root.querySelector('div.pagination, nav.pagination, .pagination');
    if (!block?.querySelectorAll) return '';
    for (const anchor of block.querySelectorAll('a[href]')) {
      let href;
      try { href = new URL(anchor.getAttribute('href'), base); } catch { continue; }
      if (!onSite(href.href) || watchUrl(href.href, base)) continue;
      const label = Number((anchor.textContent || '').trim());
      const page = Number.isInteger(label) && label > 0 ? label : pageOf(href.pathname);
      if (page === current + 1) return href.href;
    }
    return '';
  }
  function cleanUrl(raw) {
    return String(raw || '').replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&').trim();
  }
  function listFor(block, key) {
    const match = String(block || '').match(new RegExp(`['"]${key}['"]\\s*:\\s*\\[([\\s\\S]*?)\\]`));
    if (!match) return [];
    return [...match[1].matchAll(/['"](https?:[^'"]+)['"]/g)].map(item => cleanUrl(item[1])).filter(url => /^https:\/\//i.test(url));
  }
  function formatClock(total) {
    const seconds = Number(total) || 0;
    if (seconds <= 0 || seconds >= 86400) return '';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remain = seconds % 60;
    if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(remain).padStart(2, '0')}`;
    return `${minutes}:${String(remain).padStart(2, '0')}`;
  }
  function tagsFromHtml(html) {
    const raw = String(html || '').match(/var\s+live_keywords\s*=\s*'([^']*)'/)?.[1] || '';
    const tags = [];
    const seen = new Set();
    for (const part of raw.split(',')) {
      const original = part.trim();
      if (!original || /^sb[_-]/i.test(original)) continue;
      const tag = original.toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      tags.push(tag);
      if (tags.length >= 80) break;
    }
    return tags;
  }
  function canonicalFromHtml(html) {
    const text = String(html || '');
    const tag = text.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i)?.[0] || '';
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1]
      || text.match(/<meta\b[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i)?.[1]
      || text.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:url["']/i)?.[1]
      || '';
    if (!href) return '';
    try {
      if (!WATCH_PATH.test(new URL(href, 'https://spankbang.com/').pathname)) return '';
    } catch { return ''; }
    return watchUrl(href, 'https://spankbang.com/');
  }
  function watchMeta(html) {
    const text = String(html || '');
    const datetime = text.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1] || '';
    const parsedDate = datetime ? new Date(datetime) : null;
    const date = parsedDate && !Number.isNaN(parsedDate.getTime())
      ? parsedDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      : '';
    const block = text.match(/var\s+stream_data\s*=\s*(\{[\s\S]*?\})\s*;/)?.[1] || '';
    const length = Number(block.match(/['"]length['"]\s*:\s*(\d+)/)?.[1] || 0);
    const seconds = length > 0 && length < 86400 ? length : 0;
    const sources = [];
    const seen = new Set();
    const push = (raw, height, type) => {
      const url = cleanUrl(raw);
      if (!url || seen.has(url) || !/^https:\/\//i.test(url)) return;
      const path = url.split('?')[0];
      if (!/\.(?:mp4|m3u8)$/i.test(path) && !/\/hls\//i.test(path)) return;
      seen.add(url);
      const kind = type || (/\.m3u8$/i.test(path) ? 'hls' : 'file');
      sources.push({ url, height: height || 0, type: kind, quality: height ? `${height}P` : (kind === 'hls' ? 'HLS' : 'ORIGINAL') });
    };
    for (const [key, height] of RENDITIONS) for (const url of listFor(block, key)) push(url, height, 'file');
    for (const url of listFor(block, 'main')) push(url, /-4k\.mp4/i.test(url) ? 2160 : (Number(url.match(/-(\d{3,4})p\.mp4/i)?.[1]) || 0), 'file');
    for (const url of listFor(block, 'm3u8')) push(url, 0, 'hls');
    sources.sort((a, b) => b.height - a.height || Number(a.type === 'hls') - Number(b.type === 'hls'));
    const best = sources.find(source => source.type === 'file' && source.height) || sources.find(source => source.type === 'file') || null;
    return {
      datetime, date, tags: tagsFromHtml(text), length: seconds, duration: formatClock(seconds),
      height: best?.height || 0, quality: best?.height ? `${best.height}P` : '', streamUrl: best?.url || '', sources,
      canonical: canonicalFromHtml(text),
    };
  }
  function sourcesFromHtml(html) {
    return watchMeta(html).sources;
  }
  function toMeta(parsed, sizeMb) {
    if (!parsed || (!parsed.date && !parsed.duration && !parsed.quality && !parsed.tags?.length)) return null;
    const mb = Number(sizeMb) > 0 ? Math.round(Number(sizeMb)) : null;
    return {
      date: parsed.date || null,
      quality: parsed.quality || null,
      duration: parsed.duration || null,
      height: parsed.height || 0,
      width: 0,
      sizeMb: mb,
      sizeText: mb ? (mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb} MB`) : null,
      tags: parsed.tags || [],
      canonical: parsed.canonical || null,
      adapter: 'spankbang-watch-v1',
    };
  }
  function createTagLoader(options = {}) {
    const cache = new Map();
    const controllers = new Set();
    const storageKey = 'nvs-sb-tags-v1';
    let status = { active: false, done: 0, total: 0, errors: 0, stopped: false };
    try {
      for (const [url, entry] of JSON.parse(sessionStorage.getItem(storageKey) || '[]')) {
        if (watchUrl(url, url) === url && entry?.ts > Date.now() - 86400000 && Array.isArray(entry.tags)) cache.set(url, entry);
      }
    } catch { }
    const changed = () => options.changed?.();
    const persist = () => { try { sessionStorage.setItem(storageKey, JSON.stringify([...cache].slice(-500))); } catch { } };
    function remember(url, meta) {
      const id = watchUrl(url, url);
      if (!id || !meta) return;
      cache.set(id, { tags: [...(meta.tags || [])], ts: Date.now() });
      persist();
      changed();
    }
    async function load(rawUrls) {
      if (status.active) return { ...status, busy: true };
      const urls = [...new Set((rawUrls || []).map(url => watchUrl(url, url)).filter(Boolean))].filter(url => !cache.has(url));
      status = { active: true, done: 0, total: urls.length, errors: 0, stopped: false };
      changed();
      let index = 0;
      async function worker() {
        while (index < urls.length && !status.stopped) {
          const url = urls[index++];
          const controller = new AbortController();
          controllers.add(controller);
          try {
            const response = await fetch(url, { credentials: 'include', signal: controller.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const html = await response.text();
            if (isChallenge(html)) throw new Error('challenge');
            const parsed = watchMeta(html);
            if (!parsed.date && !parsed.tags.length && !parsed.duration) throw new Error('empty');
            cache.set(url, { tags: parsed.tags, ts: Date.now() });
          } catch {
            if (!status.stopped) status.errors++;
          } finally {
            controllers.delete(controller);
            if (!status.stopped) status.done++;
            changed();
          }
        }
      }
      try { await Promise.all(Array.from({ length: Math.min(3, urls.length) }, worker)); }
      finally { status.active = false; persist(); changed(); }
      return { ...status };
    }
    return {
      get(url) {
        const value = cache.get(watchUrl(url, url));
        return value ? { tags: [...value.tags], fetched: true } : { tags: [], fetched: false };
      },
      status: () => ({ ...status }),
      load,
      remember,
      stop() { status.stopped = true; controllers.forEach(controller => controller.abort()); changed(); },
    };
  }

  globalThis.NVSSpankBangListing = {
    cardSelector, onSite, watchUrl, isListing, cards, fieldsFromCard, titleFromCard, nextUrl,
    watchMeta, sourcesFromHtml, toMeta, isChallenge, tagsFromHtml, createTagLoader,
  };
})();
