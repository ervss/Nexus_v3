/* xHamster listing chrome: full-width grid, no left filters, no ads/shorts,
   no "Page 2" bands. The import panel owns column count and autoload. */
(function () {
  'use strict';

  function onXhamster() {
    return /(^|\.)xhamster(?:-fr)?\.com$|(^|\.)xhamster\.desi$/i.test(location.hostname);
  }

  function listingPage() {
    return onXhamster() && !/\/videos\/[^/]+$/i.test(location.pathname);
  }

  function textOf(el) {
    return (el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function hasThumbs(el) {
    return !!el?.querySelector?.('.thumb-list__item, [data-role="thumb-list-block"]');
  }

  function hide(el) {
    if (!el || el.closest?.('#nvs-sort-panel, #nvs-workbench-launch, #nvs-xh-filters-launch, .nvs-xh-filters')) return;
    el.classList.add('nvs-xh-hide');
  }

  function primaryGrid() {
    const lists = [...document.querySelectorAll('[data-role="thumb-list-block"], .thumb-list')]
      .filter((el) => !el.closest('#nvs-sort-panel'));
    let best = null;
    let bestCount = 0;
    for (const el of lists) {
      const direct = [...el.children].filter(isVideoCard).length;
      if (direct > bestCount) {
        best = el;
        bestCount = direct;
      }
    }
    return best;
  }

  function isVideoCard(node) {
    return !!node?.matches?.('.thumb-list__item, .video-thumb') && !!node.querySelector('a[href*="/videos/"]');
  }

  function flatten() {
    if (!listingPage()) return;
    const primary = primaryGrid();
    if (!primary) return;
    primary.classList.add('nvs-xh-grid');
    const lists = [...document.querySelectorAll('[data-role="thumb-list-block"], .thumb-list')]
      .filter((el) => el !== primary && !primary.contains(el) && !el.contains(primary));
    for (const list of lists) {
      for (const card of [...list.children]) {
        if (isVideoCard(card)) primary.appendChild(card);
      }
      if (!list.querySelector('.thumb-list__item')) hide(list);
    }
    widen(primary);
  }

  function panelWidth() {
    const root = document.documentElement;
    const right = root.classList.contains('nvs-xh-panel-open') ? 360 : 0;
    const left = root.classList.contains('nvs-xh-filters-open') ? 320 : 0;
    return right + left;
  }

  function widen(grid) {
    const available = Math.max(640, window.innerWidth - panelWidth() - 28);
    let node = grid;
    while (node && node !== document.body) {
      node.classList.add('nvs-xh-stretch');
      const parent = node.parentElement;
      if (parent && [...parent.children].some((child) => child !== node && (child.classList.contains('nvs-xh-hide') || child.classList.contains('nvs-xh-filters')))) {
        const display = getComputedStyle(parent).display;
        if (display === 'grid' || display === 'flex') parent.style.setProperty('display', 'block', 'important');
      }
      node = node.parentElement;
    }
    grid.style.setProperty('width', '100%', 'important');
    grid.style.setProperty('max-width', `${available}px`, 'important');
  }

  function pathKey(href) {
    try {
      const page = new URL(href, location.href);
      return page.pathname.replace(/\/+$/, '').toLowerCase();
    } catch {
      return '';
    }
  }

  function dateRank(text) {
    if (/\b\d{1,2}\s+\w+\s+\d{4}\b|\b\w+\s+\d{1,2},?\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/.test(text)) return 2;
    return /\d/.test(text) ? 1 : 0;
  }

  function usableDate(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim().replace(/\s*[›>]\s*$/, '');
    if (!clean || /^(page|stránka|stranka)\s+\d+$/i.test(clean)) return '';
    return dateRank(clean) ? clean : '';
  }

  function paintDate(card, label) {
    const text = usableDate(label);
    if (!card || !text) return false;
    let slot = card.querySelector('.nvs-xh-date');
    if (!slot) {
      slot = document.createElement('div');
      slot.className = 'nvs-xh-date';
      const views = card.querySelector('.video-thumb-views');
      if (views) views.before(slot);
      else (card.querySelector('.video-thumb-info') || card).appendChild(slot);
    }
    if (dateRank(text) < dateRank(slot.textContent || '')) return true;
    slot.textContent = text;
    return true;
  }

  function dateFromDom(card) {
    const el = card.querySelector('.video-thumb__date-added, .entity-info-container__date');
    return usableDate(textOf(el)) || usableDate(el?.getAttribute('data-tooltip') || el?.getAttribute('title') || '');
  }

  function stampDates() {
    const api = window.NVSXhamsterListing;
    const videos = api?.videosFromData?.(window.initials) || [];
    const byPath = new Map();
    const byId = new Map();
    for (const video of videos) {
      const path = pathKey(video.pageURL);
      if (path && !byPath.has(path)) byPath.set(path, video);
      if (video.id) byId.set(String(video.id), video);
    }
    for (const card of document.querySelectorAll('.thumb-list__item, .video-thumb')) {
      if (card.closest('#nvs-sort-panel')) continue;
      const link = [...card.querySelectorAll('a[href]')].find((anchor) => /\/videos\//i.test(anchor.getAttribute('href') || ''));
      const id = card.getAttribute('data-video-id') || card.querySelector('[data-video-id]')?.getAttribute('data-video-id') || '';
      const video = byPath.get(pathKey(link?.href || '')) || byId.get(id);
      const label = video?.created && api.formatDate ? api.formatDate(video.created) : dateFromDom(card);
      paintDate(card, label);
    }
  }

  function findFilterSidebar() {
    const docked = document.querySelector('.nvs-xh-filters');
    if (docked?.isConnected) return docked;
    const grid = primaryGrid();
    if (!grid) return null;
    let node = grid;
    for (let depth = 0; depth < 8 && node.parentElement && node.parentElement !== document.body; depth++) {
      const parent = node.parentElement;
      for (const sibling of parent.children) {
        if (sibling === node || sibling.contains(grid) || hasThumbs(sibling)) continue;
        if (sibling.closest?.('#nvs-sort-panel, #nvs-xh-filters-launch')) continue;
        const sample = textOf(sibling).slice(0, 900);
        const narrow = sibling.classList.contains('nvs-xh-filters') || sibling.getBoundingClientRect().width < 460 || sibling.getBoundingClientRect().width === 0;
        if (narrow && /search in orientations|hľadať v orient|minimum quality|minimálna kvalita|filter by categor|filtrovať podľa kateg|exclude categor|vylúčiť kateg|sort by/i.test(sample)) return sibling;
      }
      node = parent;
    }
    return null;
  }

  function setFiltersOpen(open) {
    document.documentElement.classList.toggle('nvs-xh-filters-open', open);
    localStorage.setItem('nvs-xh-filters', open ? '1' : '0');
    const launch = document.getElementById('nvs-xh-filters-launch');
    if (launch) launch.hidden = open;
    const grid = primaryGrid();
    if (grid) widen(grid);
  }

  function dockFilters() {
    const sidebar = findFilterSidebar();
    const launch = document.getElementById('nvs-xh-filters-launch');
    if (!sidebar) {
      document.documentElement.classList.remove('nvs-xh-filters-open');
      if (launch) launch.hidden = true;
      return;
    }
    sidebar.classList.remove('nvs-xh-hide');
    sidebar.classList.add('nvs-xh-filters');
    if (!sidebar.querySelector(':scope > .nvs-xh-filters-bar')) {
      const bar = document.createElement('div');
      bar.className = 'nvs-xh-filters-bar';
      const title = document.createElement('strong');
      title.textContent = 'Filtre';
      const close = document.createElement('button');
      close.type = 'button';
      close.dataset.action = 'hide-filters';
      close.textContent = '− Skryť';
      close.addEventListener('click', () => setFiltersOpen(false));
      bar.append(title, close);
      sidebar.prepend(bar);
    }
    let button = launch;
    if (!button) {
      button = document.createElement('button');
      button.id = 'nvs-xh-filters-launch';
      button.type = 'button';
      button.textContent = 'Filtre';
      button.addEventListener('click', () => setFiltersOpen(true));
      document.body.appendChild(button);
    }
    const open = localStorage.getItem('nvs-xh-filters') === '1';
    document.documentElement.classList.toggle('nvs-xh-filters-open', open);
    button.hidden = open;
  }

  function hideShorts(root) {
    const headings = root.querySelectorAll('a, h2, h3, h4, div, span, p');
    let seen = 0;
    for (const heading of headings) {
      if (++seen > 2000) break;
      if (heading.closest('#nvs-sort-panel, .nvs-xh-filters, .thumb-list__item')) continue;
      const text = textOf(heading);
      if (text.length > 60 || !/relevant short|short videos|moments/i.test(text)) continue;
      let section = heading;
      for (let i = 0; i < 5 && section.parentElement; i++) {
        const parent = section.parentElement;
        if (hasThumbs(parent) && parent.querySelectorAll('.thumb-list__item').length > 6) break;
        section = parent;
      }
      if (!hasThumbs(section) || section.querySelectorAll('.thumb-list__item').length < 8) hide(section);
    }
    root.querySelectorAll('a[href*="/moments/"], a[href*="/shorts/"]').forEach((link) => {
      const card = link.closest('.thumb-list__item, article, li') || link.parentElement;
      if (card && !card.querySelector('a[href*="/videos/"]')) hide(card);
    });
  }

  function hideAds(root) {
    root.querySelectorAll('iframe, [id*="google_ads"], .adsbygoogle, [class*="adsbygoogle"], [data-role*="promo"], [class*="cam-widget"]').forEach((el) => {
      if (!hasThumbs(el)) hide(el);
    });
    const nodes = root.querySelectorAll('a, div, section, aside');
    let seen = 0;
    for (const el of nodes) {
      if (++seen > 1500) break;
      if (el.closest('#nvs-sort-panel, .nvs-xh-filters, .thumb-list__item') || hasThumbs(el)) continue;
      const text = textOf(el).slice(0, 180);
      if (/join faphouse|awards\s+.{0,16}sale|prices drop/i.test(text) && el.getBoundingClientRect().height < 140) hide(el);
    }
  }

  function hidePageBreaks(root) {
    root.querySelectorAll('.desktop-pagination, [class*="pagination"], [class*="pager"], [data-role="pagination"]').forEach((el) => {
      if (!el.closest('#nvs-sort-panel, .thumb-list__item') && !hasThumbs(el)) hide(el);
    });
    const nodes = root.querySelectorAll('h1, h2, h3, h4, p, div, span, li');
    let seen = 0;
    for (const el of nodes) {
      if (++seen > 2500) break;
      if (el.closest('#nvs-sort-panel, .nvs-xh-filters, .thumb-list__item') || el.childElementCount > 3 || hasThumbs(el)) continue;
      const text = textOf(el);
      if (text.length < 20 && /^(page|stránka|stranka)\s+\d+$/i.test(text)) hide(el);
    }
  }

  function dropPaid() {
    const isPaid = window.NVSXhamsterListing?.isPaidCard;
    if (!isPaid) return;
    for (const card of [...document.querySelectorAll('.thumb-list__item, .video-thumb')]) {
      if (card.closest('#nvs-sort-panel, .nvs-xh-filters')) continue;
      if (isPaid(card)) card.remove();
    }
  }

  function clean() {
    if (!onXhamster()) return;
    dropPaid();
    document.documentElement.classList.add('nvs-xh-wide');
    const cols = localStorage.getItem('nvs-xh-cols') || '5';
    document.documentElement.style.setProperty('--nvs-xh-cols', cols);
    const root = document.body;
    if (!root) return;
    if (listingPage()) dockFilters();
    hideAds(root);
    hideShorts(root);
    hidePageBreaks(root);
    if (listingPage()) {
      flatten();
      hidePageBreaks(root);
      stampDates();
    }
  }

  function maybeAutoload() {
    if (!listingPage() || localStorage.getItem('nvs-xh-autoload') === '0') return;
    const remain = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
    if (remain > 1400) return;
    const button = document.querySelector('#nvs-sort-panel [data-action="load"]');
    if (!button || button.disabled || button.hidden) return;
    if (!document.querySelector('a[rel="next"], .prev-next-list-link--next')) return;
    button.click();
  }

  function boot() {
    if (!onXhamster()) return;
    clean();
    let timer;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(clean, 180);
    };
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('scroll', () => {
      clearTimeout(timer);
      timer = setTimeout(maybeAutoload, 220);
    }, { passive: true });
    window.addEventListener('resize', () => {
      const grid = primaryGrid();
      if (grid) widen(grid);
    });
  }

  window.NVSXhamsterLayout = { clean, listingPage, paintDate };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
