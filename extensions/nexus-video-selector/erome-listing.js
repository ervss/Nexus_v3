/* Erome listing policy: album cards (/a/<id>), native ?page=N pagination and "only videos" hint. */
(function () {
  'use strict';
  const cardSelector = '#albums .album, .album[id^="album-"]';
  const isEromeHost = host => /(^|\.)erome\.com$/i.test(host || '');

  // Canonical album URL: https://www.erome.com/a/<id>. Query and hash are dropped.
  function watchUrl(raw, base) {
    try {
      const url = new URL(raw, base);
      if (!isEromeHost(url.hostname) || !/^https?:$/.test(url.protocol)) return '';
      const match = url.pathname.match(/^\/a\/([A-Za-z0-9_-]+)\/?$/);
      return match ? `https://www.erome.com/a/${match[1]}` : '';
    } catch { return ''; }
  }

  // "122" -> 122, "2,5K" -> 2500, "1.2M" -> 1200000.
  function parseCount(text) {
    const match = String(text || '').replace(/\s+/g, '').match(/^(\d+(?:[.,]\d+)?)([KkMm]?)$/);
    if (!match) return 0;
    const value = parseFloat(match[1].replace(',', '.'));
    const scale = /k/i.test(match[2]) ? 1e3 : /m/i.test(match[2]) ? 1e6 : 1;
    return Number.isFinite(value) ? Math.round(value * scale) : 0;
  }

  function counts(card) {
    const read = selector => {
      const node = card.querySelector(selector);
      return node ? parseCount(node.textContent) : 0;
    };
    return { videos: read('.album-videos'), images: read('.album-images'), views: read('.album-bottom-views') };
  }

  function cards(doc, base) {
    const seen = new Set(), items = [];
    for (const card of doc.querySelectorAll(cardSelector)) {
      const link = card.querySelector('a.album-link[href], a.album-title[href]');
      const url = watchUrl(link?.getAttribute('href'), base);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      items.push({ card, url, ...counts(card) });
    }
    return items;
  }

  // The visible address stays on the first page while later pages accumulate,
  // so the next link always comes from the most recently parsed document.
  function nextUrl(doc, base) {
    const pager = doc.querySelector('ul.pagination');
    if (!pager) return '';
    const current = new URL(base);
    let link = pager.querySelector('a[rel="next"][href]');
    if (!link) {
      const active = pager.querySelector('.page-item.active');
      for (let item = active?.nextElementSibling; item && !link; item = item.nextElementSibling) {
        link = item.querySelector('a[href]');
      }
    }
    if (!link) return '';
    try {
      const url = new URL(link.getAttribute('href'), base);
      if (url.origin !== current.origin) return '';
      url.hash = '';
      const page = Number(url.searchParams.get('page') || 1), currentPage = Number(current.searchParams.get('page') || 1);
      // Never walk backwards (e.g. the "..." gap links), otherwise paging could loop.
      return page > currentPage ? url.href : '';
    } catch { return ''; }
  }

  // erome.com profile/search/explore pages render albums in #albums; an album page itself does not.
  function isListing(doc, loc) {
    if (!isEromeHost(loc.hostname) || /^\/a\//i.test(loc.pathname)) return false;
    return !!doc.querySelector(cardSelector);
  }

  // `#onlyvideos=1` is the site's own client-side filter flag.
  function onlyVideosRequested(hash) {
    return /(?:^#|[&#])onlyvideos=1(?:&|$)/i.test(String(hash || ''));
  }

  window.NVSEromeListing = { cardSelector, watchUrl, parseCount, counts, cards, nextUrl, isListing, onlyVideosRequested };
})();
