/* xHamster listing pages server-render only the first row. The rest of the HTML
   is a skeleton: a gray box, a date and a chevron, with the real thumb still in
   window.initials. Import that data instead of cloning the placeholders. */
(function () {
  'use strict';

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function formatDate(unix) {
    const n = Number(unix);
    if (!Number.isFinite(n) || n <= 0) return '';
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(n * 1000));
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    if (!total) return '';
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
  }

  function formatViews(views) {
    const n = Number(views) || 0;
    if (n <= 0) return 'just added';
    if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M views`;
    if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K views`;
    return `${n} views`;
  }

  function paidWord(value) {
    return /^(?:paid|premium|gold)$/i.test(String(value ?? '').trim());
  }

  function isPaidThumb(item) {
    if (!item || typeof item !== 'object') return false;
    const href = [item.pageURL, item.url, item.originalUrl].filter((value) => typeof value === 'string').join(' ');
    if (/faphouse\.com|\/fh\/out\b/i.test(href)) return true;
    if (item.isPaid === true || item.paid === true || item.isPremium === true) return true;
    if (paidWord(item.accessType) || paidWord(item.icon) || paidWord(item.type) || paidWord(item.badge)) return true;
    return paidWord(item.badgeProps?.text);
  }

  function isPaidCard(node) {
    if (!node?.querySelectorAll || node.closest?.('#nvs-sort-panel, #nvs-workbench-launch, .nvs-xh-filters')) return false;
    for (const link of node.querySelectorAll('a[href]')) {
      if (/faphouse\.com|\/fh\/out\b/i.test(link.getAttribute('href') || '')) return true;
    }
    for (const el of node.querySelectorAll('span, div, i, b, em, strong')) {
      if (el.childElementCount > 2) continue;
      if (/^(?:paid|premium)$/i.test((el.textContent || '').replace(/\s+/g, ' ').trim())) return true;
    }
    return false;
  }

  function isVideoThumb(item) {
    return !!item && typeof item === 'object' && typeof item.pageURL === 'string'
      && !isPaidThumb(item)
      && /\/videos\//i.test(item.pageURL) && /^(?:https?:|data:image\/)/i.test(item.thumbURL || item.imageURL || '');
  }

  function createdUnix(item) {
    const raw = [item?.created, item?.published, item?.publishDate, item?.dateAdded].find((value) => value != null && value !== '' && value !== 0);
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? Math.floor(numeric / 1000) : numeric;
    const parsed = Date.parse(String(raw || ''));
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : 0;
  }

  function normalize(item) {
    const page = new URL(item.pageURL, 'https://xhamster.com');
    page.search = '';
    page.hash = '';
    return {
      id: item.id || '',
      pageURL: page.href,
      thumbURL: item.thumbURL || item.imageURL,
      title: String(item.title || ''),
      duration: Number(item.duration) || 0,
      created: createdUnix(item),
      views: Number(item.views) || 0,
    };
  }

  function collect(node, out) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      if (node.some(isVideoThumb)) {
        for (const item of node) if (isVideoThumb(item)) out.push(normalize(item));
        return;
      }
      for (const item of node) collect(item, out);
      return;
    }
    for (const value of Object.values(node)) collect(value, out);
  }

  function videosFromData(data) {
    const out = [];
    collect(data, out);
    const seen = new Set();
    return out.filter((video) => {
      if (seen.has(video.pageURL)) return false;
      seen.add(video.pageURL);
      return true;
    });
  }

  function videosFromHtml(html) {
    const match = String(html || '').match(/<script[^>]*id=(['"])initials-script\1[^>]*>([\s\S]*?)<\/script>/i);
    if (!match) return [];
    const body = match[2].trim().replace(/^window\.initials\s*=\s*/, '').replace(/;\s*$/, '');
    let data;
    try { data = JSON.parse(body); } catch { return []; }
    return videosFromData(data);
  }

  function nextPageHref(html) {
    const tags = String(html || '').match(/<a\b[^>]*>/gi) || [];
    for (const tag of tags) {
      if (!/\brel=(['"])next\1/i.test(tag)) continue;
      const href = tag.match(/\bhref=(['"])([^'"]+)\1/i);
      if (href) return href[2].replace(/&amp;/g, '&');
    }
    return '';
  }

  function isSkeletonCard(node) {
    if (!node?.querySelector) return true;
    if (node.querySelector('[class*="placeholderSkeleton"], [class*="placeholderBottom"]')) return true;
    const img = [...node.querySelectorAll('img')].find((el) => !el.closest('noscript'));
    return !/^https?:/i.test(img?.getAttribute('src') || '');
  }

  function cardHtml(video) {
    const date = formatDate(video.created);
    const duration = formatDuration(video.duration);
    const page = escapeHtml(video.pageURL);
    const title = escapeHtml(video.title);
    const thumb = escapeHtml(video.thumbURL);
    return `<div class="thumb-list__item video-thumb video-thumb--type-video video-thumb--dated video-thumb--with-date" data-video-id="${escapeHtml(video.id)}"><div class="video-thumb__date-added">${escapeHtml(date)}</div><a class="video-thumb__image-container thumb-image-container" data-role="thumb-link" href="${page}"><img class="thumb-image-container__image" src="${thumb}" alt=""><div class="thumb-image-container__duration" data-role="video-duration"><div class="tiny-fda7e">${escapeHtml(duration)}</div></div></a><div class="video-thumb-info"><a class="video-thumb-info__name" data-role="thumb-link" href="${page}">${title}</a><div class="video-thumb-views">${escapeHtml(formatViews(video.views))}</div></div></div>`;
  }

  function stripExtensionChrome(card) {
    card.removeAttribute('data-nvs-processed');
    card.classList.remove('nvs-card-selected', 'nvs-hidden', 'nvs-wb-unmatched', 'nvs-thumbnail-selector');
    delete card.dataset.nvsSortIndex;
    delete card.dataset.nvsUrl;
    card.querySelectorAll('.nvs-selector-wrap, .nvs-badge, .nvs-badge-quality, .nvs-duration-badge').forEach((el) => el.remove());
    card.querySelectorAll('.nvs-thumbnail-selector').forEach((el) => el.classList.remove('nvs-thumbnail-selector'));
  }

  function applyVideo(card, video) {
    stripExtensionChrome(card);
    const page = video.pageURL;
    card.setAttribute('data-video-id', String(video.id || ''));
    if (card.hasAttribute('data-ecommerce-list-item')) card.setAttribute('data-ecommerce-list-item', String(video.id || ''));
    card.removeAttribute('data-stats');
    for (const link of card.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href') || '';
      if (/\/videos\//i.test(href) || link.matches('.video-thumb-info__name, .video-thumb__image-container, [data-role="thumb-link"]')) link.href = page;
    }
    card.querySelectorAll('[class*="placeholderSkeleton"], [class*="placeholderBottom"]').forEach((el) => el.remove());
    const imageLink = card.querySelector('a.video-thumb__image-container, a[data-role="thumb-link"]');
    let img = [...card.querySelectorAll('img')].find((el) => !el.closest('noscript'));
    if (!img && imageLink) {
      img = document.createElement('img');
      img.className = 'thumb-image-container__image';
      imageLink.prepend(img);
    }
    if (img) {
      img.src = video.thumbURL;
      img.removeAttribute('srcset');
      img.alt = '';
      img.loading = 'eager';
    }
    const title = card.querySelector('.video-thumb-info__name');
    if (title) title.textContent = video.title || '';
    if (imageLink) imageLink.setAttribute('aria-label', video.title || '');
    const dateEl = card.querySelector('.video-thumb__date-added');
    const date = formatDate(video.created);
    if (dateEl && date) {
      const text = [...dateEl.childNodes].find((node) => node.nodeType === 3);
      if (text) text.textContent = `${date} `;
      else dateEl.insertBefore(document.createTextNode(`${date} `), dateEl.firstChild);
    }
    const duration = formatDuration(video.duration);
    const slot = card.querySelector('.thumb-image-container__duration .tiny-fda7e, .tiny-fda7e');
    if (slot && duration) slot.textContent = duration;
    const views = card.querySelector('.video-thumb-views');
    if (views) views.textContent = formatViews(video.views);
    const uploader = card.querySelector('.video-uploader__name');
    if (uploader) uploader.textContent = '';
    card.querySelector('.video-uploader-logo')?.remove();
    return card;
  }

  function elementFromCardHtml(video) {
    const wrap = document.createElement('div');
    wrap.innerHTML = cardHtml(video);
    return wrap.firstElementChild;
  }

  function normalizeTag(value) {
    return String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
  }

  function watchUrl(raw, base) {
    try {
      const url = new URL(raw, base || 'https://xhamster.com');
      if (!/(^|\.)xhamster(?:-fr)?\.com$|(^|\.)xhamster\.desi$/i.test(url.hostname)) return '';
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
      if (!/\/videos\/[^/?#]+/i.test(url.pathname)) return '';
      url.search = '';
      url.hash = '';
      return url.href;
    } catch { return ''; }
  }

  function initialsObject(html) {
    const source = String(html || '');
    const script = source.match(/<script[^>]*id=(['"])initials-script\1[^>]*>([\s\S]*?)<\/script>/i);
    const raw = script ? script[2] : (source.match(/window\.initials\s*=\s*(\{[\s\S]*?\});\s*<\/script>/i)?.[1] || '');
    const body = raw.trim().replace(/^window\.initials\s*=\s*/, '').replace(/;\s*$/, '');
    if (!body) return null;
    try {
      const data = JSON.parse(body);
      return data && typeof data === 'object' ? data : null;
    } catch { return null; }
  }

  function tagsFromHtml(html) {
    const data = initialsObject(html);
    if (!data?.videoModel) throw new Error('Sekcia tagov videa sa nenašla.');
    const tags = new Set();
    for (const list of [data.videoTagsComponent?.tags, data.videoModel.categories, data.videoModel.tags]) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const name = typeof item === 'string' ? item : item?.name || item?.slug;
        const tag = normalizeTag(name);
        if (tag && !tag.includes(',')) tags.add(tag);
      }
    }
    return [...tags].slice(0, 80);
  }

  function createTagLoader(options = {}) {
    const cache = new Map(), controllers = new Set();
    const storageKey = 'nvs-xh-tags-v1';
    let status = { active: false, done: 0, total: 0, errors: 0, stopped: false };
    try {
      for (const [url, entry] of JSON.parse(sessionStorage.getItem(storageKey) || '[]')) {
        if (watchUrl(url, url) === url && entry.ts > Date.now() - 86400000 && Array.isArray(entry.tags)) {
          cache.set(url, { tags: entry.tags.filter((tag) => typeof tag === 'string').map(normalizeTag).filter(Boolean).slice(0, 80), ts: entry.ts });
        }
      }
    } catch { }
    const changed = () => options.changed?.();
    function save() {
      try { sessionStorage.setItem(storageKey, JSON.stringify([...cache].slice(-500))); } catch { }
    }
    async function load(rawUrls) {
      if (status.active) return { ...status, busy: true };
      const urls = [...new Set(rawUrls.map((url) => watchUrl(url, url)).filter(Boolean))].filter((url) => !cache.has(url));
      status = { active: true, done: 0, total: urls.length, errors: 0, stopped: false }; changed();
      let index = 0;
      async function worker() {
        while (index < urls.length && !status.stopped) {
          const url = urls[index++], controller = new AbortController(); controllers.add(controller);
          const timer = setTimeout(() => controller.abort(), 20000);
          try {
            const response = await (options.fetch || fetch)(url, { credentials: 'include', signal: controller.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            if (response.url && watchUrl(response.url, url) !== url) throw new Error('Detail bol presmerovaný.');
            const html = await response.text();
            if (status.stopped) break;
            cache.set(url, { tags: tagsFromHtml(html), ts: Date.now() }); save();
          } catch { if (!status.stopped) status.errors++; }
          finally { clearTimeout(timer); controllers.delete(controller); if (!status.stopped) status.done++; changed(); }
        }
      }
      try { await Promise.all(Array.from({ length: Math.min(3, urls.length) }, worker)); }
      finally { status.active = false; changed(); }
      return { ...status };
    }
    return {
      get(url) { const entry = cache.get(watchUrl(url, url)); return entry ? { tags: [...entry.tags], fetched: true } : { tags: [], fetched: false }; },
      status: () => ({ ...status }), load,
      stop() { status.stopped = true; for (const controller of controllers) controller.abort(); changed(); },
    };
  }

  function reorderManagedNodes(parent, nodes) {
    if (!parent || nodes.length < 2) return;
    const managed = new Set(nodes);
    const first = [...parent.children].find((child) => managed.has(child));
    if (!first) return;
    const marker = document.createComment('nvs-order');
    parent.insertBefore(marker, first);
    for (const node of nodes) parent.insertBefore(node, marker);
    marker.remove();
  }

  window.NVSXhamsterListing = {
    formatDate, formatDuration, videosFromData, videosFromHtml, nextPageHref, isSkeletonCard, isPaidThumb, isPaidCard, cardHtml, applyVideo, elementFromCardHtml, reorderManagedNodes,
    normalizeTag, watchUrl, tagsFromHtml, createTagLoader,
  };
})();
