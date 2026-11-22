/* PimpBunny listing policy: watch slugs, hashed card classes and native pagination. */
(function () {
  'use strict';
  const cardSelector = '.b6m-video, [class*="ui-card-root"][class*="ui-card-video"]';
  function watchUrl(raw, base) {
    try {
      const url = new URL(raw, base);
      if (!/(^|\.)(?:pimpbunny|fnxtube)\.com$/i.test(url.hostname) || url.protocol !== 'https:') return '';
      if (!/^\/videos\/(?!\d+\/?$)[^/]+\/?$/.test(url.pathname)) return '';
      const host = /(^|\.)fnxtube\.com$/i.test(url.hostname) ? 'fnxtube.com' : 'pimpbunny.com';
      return `https://${host}${url.pathname.replace(/\/+$/, '')}/`;
    } catch { return ''; }
  }
  function pagination(doc) {
    const paginations = [...doc.querySelectorAll('[id$="_pagination"], [class*="includes-pagination-list"]')];
    // Search renders separate video and album pagers. Never follow the album/model pager.
    return paginations.find(node => /videos/i.test(node.id || '')) ||
      paginations.find(node => !/albums|models/i.test(node.id || ''));
  }
  function nextUrl(doc, base) {
    const pager = pagination(doc);
    if (!pager) return '';
    const current = new URL(base);
    const links = [...pager.querySelectorAll('a[href]')];
    // Native AJAX navigation can change the visible page without changing the address.
    const visibleNumber = Number(pager.querySelector('li > span')?.textContent.trim());
    const currentNumber = visibleNumber || Number(current.searchParams.get('from_videos')) || Number(current.pathname.match(/\/(\d+)\/?$/)?.[1]) || 1;
    for (const link of links) {
      try {
        const parameters = new Map((link.getAttribute('data-parameters') || '').split(';').map(part => {
          const colon = part.indexOf(':');
          return colon < 0 ? ['', ''] : [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
        }));
        const ajaxNumber = Number(parameters.get('from_videos'));
        const url = new URL(ajaxNumber ? current.href : link.getAttribute('href'), current);
        if (url.origin !== current.origin || watchUrl(url.href, base)) continue;
        const number = ajaxNumber || Number(url.searchParams.get('from_videos')) || Number(url.pathname.match(/\/(\d+)\/?$/)?.[1]);
        if (number !== currentNumber + 1) continue;
        if (ajaxNumber) {
          // Fetch a full HTML page; mode=async would return only the site's AJAX fragment.
          url.hash = '';
          url.searchParams.set('from_videos', String(ajaxNumber));
          for (const key of ['ipp', 'items_per_page', 'videos_per_page']) {
            const value = parameters.get(key);
            if (/^[1-9]\d*$/.test(value || '')) url.searchParams.set(key, value);
          }
        }
        // Keep native duration/sort/search query parameters when the link omits them.
        for (const [key, value] of current.searchParams) if (key !== 'from_videos' && !url.searchParams.has(key)) url.searchParams.append(key, value);
        return url.href;
      } catch { }
    }
    return '';
  }
  function cards(doc, base) {
    const seen = new Set(), items = [];
    for (const root of doc.querySelectorAll(cardSelector)) {
      const link = root.querySelector('a[class*="ui-card-link"][href]');
      const url = watchUrl(link?.getAttribute('href'), base);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const card = root.parentElement?.classList.contains('col') ? root.parentElement : root;
      items.push({ card, url });
    }
    return items;
  }
  function normalizeTag(value) {
    return String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 100);
  }
  function tagsFromDocument(doc, base) {
    const groups = doc.querySelectorAll('[class*="pages-view-video-categories"]');
    if (!groups.length) throw new Error('Sekcia tagov videa sa nenašla.');
    const tags = new Set();
    for (const group of groups) for (const link of group.querySelectorAll('a[href]')) {
      try {
        const url = new URL(link.getAttribute('href'), base);
        if (url.origin !== new URL(base).origin) continue;
        const match = url.pathname.match(/^\/(?:tags?|categor(?:y|ies))\/([^/]+)\/?$/i);
        if (match) {
          const tag = normalizeTag(decodeURIComponent(match[1]));
          if (tag && !tag.includes(',')) tags.add(tag);
        }
      } catch { }
    }
    return [...tags].slice(0, 80);
  }
  function createTagLoader(options = {}) {
    const cache = new Map(), controllers = new Set();
    const storageKey = 'nvs-pimpbunny-tags-v1';
    let status = { active:false, done:0, total:0, errors:0, stopped:false };
    try {
      for (const [url, entry] of JSON.parse(sessionStorage.getItem(storageKey) || '[]')) {
        if (watchUrl(url, url) === url && entry.ts > Date.now() - 86400000 && Array.isArray(entry.tags)) {
          cache.set(url, { tags:entry.tags.filter(tag => typeof tag === 'string').map(normalizeTag).slice(0,80), ts:entry.ts });
        }
      }
    } catch { }
    const changed = () => options.changed?.();
    function save() {
      try { sessionStorage.setItem(storageKey, JSON.stringify([...cache].slice(-500))); } catch { }
    }
    async function load(rawUrls) {
      if (status.active) return { ...status, busy:true };
      const urls = [...new Set(rawUrls.map(url => watchUrl(url, url)).filter(Boolean))].filter(url => !cache.has(url));
      status = { active:true, done:0, total:urls.length, errors:0, stopped:false }; changed();
      let index = 0;
      async function worker() {
        while (index < urls.length && !status.stopped) {
          const url = urls[index++], controller = new AbortController(); controllers.add(controller);
          const timer = setTimeout(() => controller.abort(), 20000);
          try {
            const response = await (options.fetch || fetch)(url, { credentials:'include', signal:controller.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            if (response.url && watchUrl(response.url, url) !== url) throw new Error('Detail bol presmerovaný.');
            const html = await response.text();
            if (status.stopped) break;
            const doc = options.parse ? options.parse(html) : new DOMParser().parseFromString(html, 'text/html');
            cache.set(url, { tags:tagsFromDocument(doc,url), ts:Date.now() }); save();
          } catch { if (!status.stopped) status.errors++; }
          finally { clearTimeout(timer); controllers.delete(controller); if (!status.stopped) status.done++; changed(); }
        }
      }
      try { await Promise.all(Array.from({length:Math.min(3,urls.length)}, worker)); }
      finally { status.active = false; changed(); }
      return { ...status };
    }
    return {
      get(url) { const entry = cache.get(url); return entry ? { tags:[...entry.tags], fetched:true } : { tags:[], fetched:false }; },
      status: () => ({ ...status }), load,
      stop() { status.stopped = true; for (const controller of controllers) controller.abort(); changed(); },
    };
  }
  window.NVSPimpBunnyListing = { watchUrl, nextUrl, pagination, cards, cardSelector, normalizeTag, tagsFromDocument, createTagLoader };
})();
