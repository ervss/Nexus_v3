// ==UserScript==
// @name         Filester Workspace for Nexus
// @namespace    nexus.filester.album.workspace
// @version      1.4.3
// @description  Personal Filester file manager workspace with selection, subfolders info, folder merging, filters, metadata probing, review checkpoints, save-to-account, load page range and Nexus Import Desk integration.
// @author       Nexus
// @match        https://filester.me/f/*
// @match        https://*.filester.me/f/*
// @match        https://filester.gg/f/*
// @match        https://*.filester.gg/f/*
// @match        https://filester.me/manager
// @match        https://filester.me/manager?*
// @match        https://filester.me/manager/*
// @match        https://*.filester.me/manager
// @match        https://*.filester.me/manager?*
// @match        https://*.filester.me/manager/*
// @match        https://filester.gg/manager
// @match        https://filester.gg/manager?*
// @match        https://filester.gg/manager/*
// @match        https://*.filester.gg/manager
// @match        https://*.filester.gg/manager?*
// @match        https://*.filester.gg/manager/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @connect      filester.me
// @connect      filester.gg
// ==/UserScript==

(function () {

  // Universal Nexus i18n helper (supports Slovak and English)
  const _getLang = () => {
    try {
      if (typeof GM_getValue === 'function') {
        const g = GM_getValue('nexus_language');
        if (g === 'en' || g === 'sk') return g;
      }
      if (typeof localStorage !== 'undefined') {
        const l = localStorage.getItem('nexus_language');
        if (l === 'en' || l === 'sk') return l;
        const v = localStorage.getItem('vipSettings');
        if (v) {
          const p = JSON.parse(v);
          if (p.language === 'en' || p.tooltipLanguage === 'en') return 'en';
          if (p.language === 'sk' || p.tooltipLanguage === 'sk') return 'sk';
        }
      }
      if (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) {
        if (document.documentElement.lang.startsWith('sk')) return 'sk';
        if (document.documentElement.lang.startsWith('en')) return 'en';
      }
      if (typeof navigator !== 'undefined' && navigator.language && navigator.language.startsWith('sk')) return 'sk';
    } catch (_) {}
    return 'en';
  };
  const _t = (sk, en) => (_getLang() === 'sk' ? sk : en);

  'use strict';

  // Version logging
  console.log('%c[Filester Workspace v1.4.3]%c Načítaný - album + file manager + subfolders + detekcia dashboardu + načítanie rozsahu strán',
    'color: #35d07f; font-weight: bold', 'color: #aaa');

  // Global error handler
  try {
    window.addEventListener('error', (event) => {
      if (event.filename?.includes('8377760840f21e5f') || event.message?.includes('addEventListener')) {
        console.warn('[Filester Workspace] Caught error:', event.message, 'at', event.lineno);
        event.preventDefault();
      }
    });
  } catch (e) {
    console.warn('[Filester Workspace] Could not install global error handler:', e);
  }

  const PREFIX = 'nexus-filester-workspace';
  const TOOLBAR_ID = `${PREFIX}-toolbar`;
  const UTILITY_NAV_ID = `${PREFIX}-utility-nav`;
  const STYLE_ID = `${PREFIX}-styles`;
  const PREF_KEY = `${PREFIX}:prefs:v1`;
  const META_KEY = `${PREFIX}:meta:v1`;
  const DASHBOARD_CACHE_KEY = `${PREFIX}:dashboard:v1`;
  const FOLDER_META_KEY = `${PREFIX}:foldermeta:v2`;
  const FOLDER_DOCK_ID = `${PREFIX}-folder-dock`;
  const FOLDER_TOOLBAR_ID = `${PREFIX}-folder-toolbar`;
  const MERGED_BANNER_ID = `${PREFIX}-merged-banner`;
  const DEFAULT_PORT = 8001;
  const PORTS = [8001, 8000, 8002, 8003];
  const META_CHUNK = 30;
  const GRID_MODES = {
    mini: { label: 'Mini', min: 140, ratio: '16 / 9' },
    compact: { label: 'Kompakt', min: 185, ratio: '16 / 9' },
    cinema: { label: 'Kino', min: 460, ratio: '16 / 9' },
    large: { label: 'Veľké', min: 340, ratio: '16 / 9' },
    overview: { label: 'Prehľad', min: 220, ratio: '16 / 9' },
    poster: { label: 'Max', min: 560, ratio: '16 / 9' },
  };
  const GM_REQ = typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest
    : (typeof GM !== 'undefined' && GM.xmlHttpRequest) ? GM.xmlHttpRequest.bind(GM) : null;

  let grid = null;
  let items = [];
  let duplicateUrls = new Set();
  let duplicateWinnerMap = new Map();
  let duplicateDiscardedCountMap = new Map();
  let refreshTimer = null;
  let metadataRunning = false;
  let connection = 'checking';
  let toastTimer = null;
  let bootAttempts = 0;
  let managerLoading = false;
  let allPagesAbort = null;
  let playerModal = null;
  let albumModal = null;

  // Dashboard detection state
  const dashboardCache = loadObject(DASHBOARD_CACHE_KEY);
  const dashboardUrls = new Set();
  const dashboardSlugs = new Set();
  const dashboardData = new Map();
  let dashboardCheckRunning = false;
  let lastDashboardCheckTs = 0;
  let dashboardCheckTimer = null;

  for (const [key, entry] of Object.entries(dashboardCache)) {
    if (entry && (entry.inDashboard || entry.matched)) {
      dashboardUrls.add(key);
      const slugMatch = key.match(/\/d\/([A-Za-z0-9_-]+)/);
      if (slugMatch) dashboardSlugs.add(slugMatch[1]);
      dashboardData.set(key, entry);
    }
  }

  // Subfolders & Merged album state
  const folderMetadata = loadObject(FOLDER_META_KEY);
  const selectedFolders = new Set();
  let folderItems = [];
  let isMergedMode = false;
  let activeMergedFolderFilter = 'all';
  let mergedFoldersInfo = [];
  let originalFilesGridBackup = null;
  let originalSubfoldersSectionDisplay = '';
  let folderSearchTerm = '';
  let folderSortMode = 'native';
  let folderDock = null;
  let subfolderObserver = null;

  const metadata = loadObject(META_KEY);
  const DEFAULT_FILTERS = {
    query: '', quality: 'all', dashboardFilter: 'all', sort: 'native',
    minDuration: '', maxDuration: '', minSize: '', maxSize: '',
    hideMisses: true, onlyUnreviewed: false, showDuplicates: false,
  };
  const state = Object.assign({
    layout: 'large', port: DEFAULT_PORT,
    batchName: '', addToSourceBoards: false,
  }, loadObject(PREF_KEY), DEFAULT_FILTERS);
  const selected = new Set(loadArray(albumStorageKey('selected')));
  const reviewed = new Set(loadArray(albumStorageKey('reviewed')));

  // A page restored from the browser's back/forward cache does not rerun this script.
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    const hadCustomSort = state.sort !== 'native';
    Object.assign(state, DEFAULT_FILTERS);
    const toolbar = document.getElementById(TOOLBAR_ID);
    for (const name of Object.keys(DEFAULT_FILTERS)) {
      const field = toolbar?.querySelector(`[data-role="${name}"]`);
      if (field) field.value = state[name];
    }
    folderSearchTerm = '';
    folderSortMode = 'native';
    const folderToolbar = document.getElementById(FOLDER_TOOLBAR_ID);
    const folderSearch = folderToolbar?.querySelector('[data-role="folderSearch"]');
    if (folderSearch) folderSearch.value = '';
    const folderSort = folderToolbar?.querySelector('[data-role="folderSort"]');
    if (folderSort) folderSort.value = folderSortMode;
    if (hadCustomSort && grid) for (const item of sortedItems(items)) grid.appendChild(item.el);
    applySortAndFilters();
    syncToolbar();
    if (folderToolbar) applyFolderFiltersAndSort();
  });

  // Initialize
  try {
    injectStyles(); initAlbumStateMemory();
    if (document.readyState === 'loading') {
      if (document.addEventListener) {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
      } else {
        window.setTimeout(boot, 100);
      }
    } else {
      boot();
    }
  } catch (error) {
    console.error('[Filester Workspace] Fatal initialization error:', error);
  }

  function boot() {
    try {
      grid = findFileGrid();
      document.body.classList.toggle('nfw-manager-compact', isManagerPage());
      if (isManagerPage() && !grid) {
        if (!managerLoading) loadManagerGrid();
        return;
      }
      if (!grid) {
        bootAttempts += 1;
        if (bootAttempts >= 30) {
          console.warn('[Filester Workspace] File cards were not found; stopping initialization.');
          return;
        }
        if (bootAttempts === 1) console.log('[Filester Workspace] Waiting for Filester file cards...');
        window.setTimeout(boot, 1000);
        return;
      }
      bootAttempts = 0;

      console.log('[Filester Workspace] Grid found, initializing...');
      ensureToolbar();
      compactAlbumHeader();
      refresh();
      observeGrid();
      bindKeyboardShortcuts();
      bindSplitLauncher();
      detectPort();
      scheduleDashboardCheck(200);
      initSubfolders();
      checkMergedHashOnBoot();
      console.log('[Filester Workspace] Initialization complete');
    } catch (error) {
      console.error('[Filester Workspace] Error during boot:', error);
      // Skúsiť znova o 2 sekundy
      window.setTimeout(boot, 2000);
    }
  }

  // --- Pamäť stavu albumu: "Load all pages" + pozícia scrollu ---------------
  // Po otvorení videa a návrate späť stránka začne odznova. Zapamätáme si, že
  // album bolo načítané celé, a po návrate ho znova automaticky dočítame a
  // vrátime scroll na pôvodné miesto.
  function initAlbumStateMemory() {
    if (!/^\/f\//i.test(location.pathname)) return;
    const key = `${PREFIX}:albumstate:${location.origin}${location.pathname}${location.search}`;
    const TTL = 6 * 60 * 60 * 1000;
    const read = () => {
      try {
        const s = JSON.parse(sessionStorage.getItem(key) || localStorage.getItem(key) || 'null');
        return s && Date.now() - (s.ts || 0) < TTL ? s : null;
      } catch { return null; }
    };
    const write = (patch) => {
      const next = Object.assign({ loadedAll: false, scrollY: 0 }, read() || {}, patch, { ts: Date.now() });
      try { const raw = JSON.stringify(next); sessionStorage.setItem(key, raw); localStorage.setItem(key, raw); } catch { /* ignore */ }
    };
    const saved = read();
    const nav = performance.getEntriesByType?.('navigation')?.[0];
    const isBack = nav?.type === 'back_forward';
    const wantAll = !!saved?.loadedAll;
    let wantScroll = isBack && saved?.scrollY > 0 ? saved.scrollY : 0;
    let tracking = false;
    let clicked = 0;

    const loadedAllDone = () => /Loaded all\s+\d+\s+pages/i.test(document.body.innerText || '');
    const findLoadAllButton = () => [...document.querySelectorAll('button, a, [role="button"]')]
      .find((el) => /^\s*load all( pages)?\s*$/i.test(el.textContent || '') && !el.disabled);

    const finishRestore = () => {
      if (wantScroll) {
        const y = wantScroll; wantScroll = 0;
        window.scrollTo(0, y);
        window.setTimeout(() => window.scrollTo(0, y), 300);
      }
      tracking = true;
    };

    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const done = loadedAllDone();
      if (done) {
        write({ loadedAll: true });
        window.clearInterval(timer);
        finishRestore();
        return;
      }
      if (wantAll) {
        const btn = findLoadAllButton();
        if (btn && Date.now() - clicked > 4000) { clicked = Date.now(); btn.click(); }
      }
      if (Date.now() - startedAt > 90000) { window.clearInterval(timer); finishRestore(); }
    }, 400);
    if (!wantAll) window.setTimeout(() => { tracking = true; }, 1500);

    // Ak používateľ klikne "Load all pages" ručne, zapamätáme si to.
    document.addEventListener('click', (event) => {
      const el = event.target.closest?.('button, a, [role="button"]');
      if (el && /load all/i.test(el.textContent || '')) write({ loadedAll: true });
    }, true);

    const saveScroll = () => { if (tracking) write({ scrollY: window.scrollY }); };
    let scrollTimer = null;
    window.addEventListener('scroll', () => {
      clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(saveScroll, 150);
    }, { passive: true });
    window.addEventListener('pagehide', saveScroll);
    document.addEventListener('click', (event) => {
      if (event.target.closest?.('a[href*="/d/"]')) { tracking = true; saveScroll(); }
    }, true);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isManagerPage() {
    return /^\/manager\/?$/i.test(location.pathname);
  }

  function findFileGrid() {
    const nativeManagerGrid = isManagerPage() && document.querySelector('.files-grid');
    if (nativeManagerGrid) return nativeManagerGrid;
    const known = document.querySelector('#filesGrid, .files-list.grid-view, .files-list, .nfw-manager-grid');
    if (known) return known;
    const subGrid = document.querySelector('#subfoldersGrid, .subfolders-grid');
    if (subGrid) {
      let createdGrid = document.querySelector('#filesGrid');
      if (!createdGrid) {
        createdGrid = document.createElement('div');
        createdGrid.id = 'filesGrid';
        createdGrid.className = 'files-list';
        const section = subGrid.closest('section') || subGrid.parentElement;
        if (section?.nextElementSibling) {
          section.parentElement.insertBefore(createdGrid, section.nextElementSibling);
        } else if (section) {
          section.parentElement.appendChild(createdGrid);
        }
      }
      return createdGrid;
    }
    const card = document.querySelector('.file-item, .file-card, [data-file-id], a[href*="/d/"]');
    if (!card) return null;
    let candidate = card.closest('.file-list, .file-grid, .grid, section, main');
    for (let level = 0; level < 4 && card.parentElement; level += 1) {
      const parent = level === 0 ? card.parentElement : candidate?.parentElement;
      if (!parent) break;
      const links = parent.querySelectorAll('a[href*="/d/"]');
      if (links.length >= 2) candidate = parent;
    }
    return candidate || card.parentElement;
  }

  async function loadManagerGrid() {
    managerLoading = true;
    try {
      const params = new URLSearchParams({
        files_page: '1', folders_page: '1', with_hierarchy: '1',
        folder_sort: 'newest', _t: String(Date.now()),
      });
      const folder = new URLSearchParams(location.search).get('folder');
      if (folder) params.set('folder', folder);
      const response = await fetch(`/api/manager/data?${params}`, {
        credentials: 'include', headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!response.ok) throw new Error(`Manager API HTTP ${response.status}`);
      const data = await response.json();
      const files = Array.isArray(data.files) ? data.files : [];
      const host = document.querySelector('main, .main-content, #app') || document.body;
      const managerGrid = document.createElement('div');
      managerGrid.className = 'nfw-manager-grid';
      managerGrid.innerHTML = files.map((file) => {
        const slug = String(file.Slug || file.slug || '').trim();
        const title = String(file.OriginalName || file.name || file.Name || slug || 'Unnamed').trim();
        if (!slug) return '';
        const thumbnail = String(file.ThumbnailURL || file.thumbnail || '').trim();
        const size = Number(file.Size || file.size || 0) || 0;
        const fileUrl = `/d/${encodeURIComponent(slug)}`;
        const image = thumbnail ? `<img src="${escapeHtml(thumbnail)}" alt="" loading="lazy">` : '';
        const fileType = String(file.Type || file.type || file.MimeType || file.mime_type || '').toLowerCase();
        const isVideo = /video|\.(mp4|mkv|webm|mov|avi|m4v|ts)$/i.test(`${fileType} ${title}`);
        const uploadedAt = file.CreatedAt || file.created_at || file.UploadedAt || file.uploaded_at || file.UploadDate || file.upload_date || '';
        return `<article class="file-item nfw-manager-item" data-name="${escapeHtml(title)}" data-url="${fileUrl}" data-slug="${escapeHtml(slug)}" data-type="${isVideo ? 'videos' : ''}" data-size="${size}" data-date="${escapeHtml(uploadedAt)}"><a href="${fileUrl}"><div class="file-preview">${image}</div><span class="file-name">${escapeHtml(title)}</span></a></article>`;
      }).join('');
      host.appendChild(managerGrid);
      grid = managerGrid;
      managerLoading = false;
      boot();
    } catch (error) {
      managerLoading = false;
      console.warn('[Filester Workspace] Manager API unavailable:', error.message || error);
    }
  }

  function fileCards(container) {
    const direct = [...container.querySelectorAll(':scope > .file-item, :scope > .file-card, :scope > [data-file-id]')];
    if (direct.length) return direct;
    const unique = new Set();
    return [...container.querySelectorAll('a[href*="/d/"]')].map((anchor) => {
      return anchor.closest('.file-item, .file-card, [data-file-id], article') || anchor.parentElement;
    }).filter((card) => card && !unique.has(card) && unique.add(card));
  }

  function albumStorageKey(kind) {
    const folder = isManagerPage() ? new URLSearchParams(location.search).get('folder') : null;
    const suffix = folder ? `?folder=${encodeURIComponent(folder)}` : '';
    return `${PREFIX}:${kind}:${location.origin}${location.pathname}${suffix}`;
  }

  function loadObject(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; }
    catch { return {}; }
  }

  function loadArray(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(value) ? value : [];
    } catch { return []; }
  }

  function loadString(key) {
    try { return String(localStorage.getItem(key) || '').trim(); }
    catch { return ''; }
  }

  function persist() {
    try {
      const preferences = { ...state };
      for (const name of Object.keys(DEFAULT_FILTERS)) delete preferences[name];
      localStorage.setItem(PREF_KEY, JSON.stringify(preferences));
      localStorage.setItem(META_KEY, JSON.stringify(trimMetadata(metadata, 5000)));
      localStorage.setItem(albumStorageKey('selected'), JSON.stringify([...selected]));
      localStorage.setItem(albumStorageKey('reviewed'), JSON.stringify([...reviewed]));
      localStorage.setItem(FOLDER_META_KEY, JSON.stringify(trimMetadata(folderMetadata, 2000)));
    } catch (error) {
      console.warn('[Filester Workspace] Preferences could not be saved.', error);
    }
  }

  function trimMetadata(cache, limit) {
    const entries = Object.entries(cache);
    if (entries.length <= limit) return cache;
    entries.sort((a, b) => Number(b[1]?.ts || 0) - Number(a[1]?.ts || 0));
    return Object.fromEntries(entries.slice(0, limit));
  }

  function observeGrid() {
    if (!grid) {
      console.warn('[Filester Workspace] Grid element not found, skipping observer setup');
      return;
    }

    try {
      new MutationObserver((mutations) => {
        if (isManagerPage()) {
          const changedFiles = mutations.some(mutation => [...mutation.addedNodes, ...mutation.removedNodes].some(node =>
            node.nodeType === Node.ELEMENT_NODE && (
              node.matches('.files-grid') || node.querySelector('.files-grid') ||
              (node.matches('.file-card, [data-file-id]') && !node.classList.contains('nfw-card'))
            )
          ));
          if (changedFiles) scheduleRefresh();
          return;
        }
        // Custom sorting moves existing workspace cards.  Those moves must not
        // trigger another refresh: the host then restores its own order and the
        // non-matching cards visibly flash before the next pass hides them.
        const onlyWorkspaceMoves = mutations.length > 0 && mutations.every((mutation) => {
          const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
          return nodes.length > 0 && nodes.every((node) => (
            node.nodeType === Node.ELEMENT_NODE && node.classList.contains('nfw-card')
          ));
        });
        if (!onlyWorkspaceMoves) scheduleRefresh();
      }).observe(isManagerPage() ? (grid.closest('main') || grid.parentElement) : grid,
        { childList: true, subtree: isManagerPage() });
    } catch (error) {
      console.warn('[Filester Workspace] Failed to observe grid:', error);
    }

    const sortSelect = document.querySelector('#sortSelect');
    if (sortSelect) {
      sortSelect.addEventListener('change', () => {
        // The site's own sort has just established a new native order. Forget our
        // previous baseline so switching back from a custom sort restores it.
        for (const card of fileCards(grid)) delete card.dataset.nfwOriginalIndex;
        scheduleRefresh();
      });
    }

    const folderSearch = document.querySelector('#folderSearch');
    if (folderSearch) {
      folderSearch.addEventListener('input', scheduleRefresh);
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(refresh, 180);
  }

  function refresh() {
    try {
      grid = findFileGrid() || grid;
      if (!grid) {
        console.warn('[Filester Workspace] Grid not found during refresh');
        return;
      }
      if (isManagerPage() && grid.matches('.files-grid')) {
        // The manager renders asynchronously and replaces its grid on navigation.
        document.querySelectorAll('.nfw-manager-grid').forEach(el => el.remove());
        grid.classList.add('nfw-native-manager-grid');
        for (const preview of grid.querySelectorAll('.file-thumbnail')) preview.classList.add('file-preview');
        ensureToolbar();
        const toolbar = document.getElementById(TOOLBAR_ID);
        if (toolbar && toolbar.nextElementSibling !== grid) grid.parentElement.insertBefore(toolbar, grid);
      }
      items = fileCards(grid).map(readCard).filter(Boolean);
      updateDuplicates();
      injectCardTools();
      applyLayout();
      applySortAndFilters();
      syncToolbar();
      if (connection === 'online') scheduleDashboardCheck(350);
    } catch (error) {
      console.error('[Filester Workspace] Error during refresh:', error);
    }
  }

  function readCard(el, index) {
    const titleEl = el.querySelector?.('.file-name, .filename, [data-file-name]');
    const candidateTitles = [
      titleEl?.getAttribute?.('title'),
      titleEl?.getAttribute?.('data-original-title'),
      titleEl?.getAttribute?.('data-title'),
      el.getAttribute?.('title'),
      el.dataset?.name,
      el.dataset?.filename,
      el.querySelector?.('a')?.getAttribute?.('title'),
      titleEl?.textContent,
    ].map((s) => String(s || '').trim()).filter(Boolean);
    const title = candidateTitles.find((t) => !/(?:\.{2,}|…)(?:\.[a-z0-9]{2,4})?$/i.test(t)) || candidateTitles[0] || '';
    const onclick = el.getAttribute?.('onclick') || '';
    const rawUrl = el.dataset.url || el.dataset.fileUrl || el.dataset.href || el.querySelector('a[href*="/d/"]')?.href || '';
    const slug = onclick.match(/\/d\/([A-Za-z0-9_-]+)/)?.[1]
      || rawUrl.match(/\/d\/([A-Za-z0-9_-]+)/)?.[1]
      || el.dataset.fileSlug || el.dataset.slug || el.dataset.fileId;
    if (!title || !slug) return null;
    const url = rawUrl.includes('/d/') ? new URL(rawUrl, location.origin).href : new URL(`/d/${slug}`, location.origin).href;
    const thumb = el.querySelector('.file-preview img, img')?.src || '';
    const sizeBytes = parseSizeBytes(el.dataset.size || el.getAttribute('data-size') || el.querySelector('.file-size')?.textContent || 0);
    const dateTs = parseUploadTime(el.dataset.date || el.dataset.uploadedAt || el.dataset.createdAt || el.querySelector('time[datetime]')?.dateTime || '');
    const type = (el.dataset.type || el.dataset.fileType || (title.match(/\.(mp4|mkv|webm|mov|avi|m4v|ts)$/i) ? 'videos' : '')).toLowerCase();
    if (el.dataset.nfwOriginalIndex == null) el.dataset.nfwOriginalIndex = String(index);
    const originalIndex = Number(el.dataset.nfwOriginalIndex);
    const meta = metadata[url] || {};
    const guessedHeight = guessHeight(title);
    const folderSlug = el.dataset.folderSlug || '';
    const folderName = el.dataset.folderName || '';
    return { el, index: originalIndex, title, slug, url, thumb, sizeBytes, dateTs, type, meta, guessedHeight, folderSlug, folderName };
  }

  // --- Smart vyraďovanie duplicít v albumoch ---
  function duplicateName(title) {
    const cleaned = cleanDuplicateTitle(title);
    return cleaned.replace(/\s/g, '').length >= 5 ? cleaned : '';
  }

  function cleanDuplicateTitle(title) {
    let s = String(title || '').normalize('NFKC').toLowerCase();
    // 1. Odstránenie bežných video prípon
    s = s.replace(/\.(mp4|mkv|webm|mov|avi|m4v|ts|flv|wmv)$/i, '');
    // 2. Odstránenie trojbodky / orezania z konca
    s = s.replace(/(?:\.{2,}|…)+$/g, '');
    // 3. Odstránenie rozlíšení a kodekov (1080p, 4k, x264, h265, atď.)
    s = s.replace(/(?:^|[\s._\-\[\]()])(?:2160p?|1440p?|1080p?|720p?|480p?|360p?|4k|2k|uhd|qhd|fhd|hd|sd|x264|x265|h264|h265|hevc|avc|10bit|8bit|crf\d+)(?=$|[\s._\-\[\]()])/gi, ' ');
    // 4. Odstránenie označení kvality / kompresie / verzie (comp, compressed, orig, original, atď.)
    s = s.replace(/(?:^|[\s._\-\[\]()])(?:comp(?:ressed)?|reencode|re-encode|orig(?:inal)?|raw|source|master|webrip|web-rip|webdl|bluray|bdrip)(?=$|[\s._\-\[\]()])/gi, ' ');
    // 5. Normalizácia znakov na medzery
    s = s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
    return s;
  }

  function areDuplicates(aTitle, bTitle, aDate, bDate, aDur, bDur) {
    if (aDur && bDur && Math.abs(aDur - bDur) > Math.max(5, Math.max(aDur, bDur) * 0.03)) return false;
    const ca = cleanDuplicateTitle(aTitle);
    const cb = cleanDuplicateTitle(bTitle);
    if (!ca || !cb) return false;
    if (ca.length < 5 || cb.length < 5) return false;
    if (ca === cb) return true;

    // Kontrola pre orezané názvy s trojbodkou
    const aTrunc = /(?:\.{2,}|…)/.test(aTitle);
    const bTrunc = /(?:\.{2,}|…)/.test(bTitle);
    if (aTrunc || bTrunc) {
      const short = ca.length < cb.length ? ca : cb;
      const long = ca.length < cb.length ? cb : ca;
      const shortBase = short.replace(/\s+[a-z0-9]$/, '');
      if (short.length >= 15 && (long.startsWith(short) || long.startsWith(shortBase))) {
        if (aDate && bDate && Math.abs(aDate - bDate) > 86400 * 1000) return false;
        return true;
      }
    }
    return false;
  }

  function duplicateSize(item) {
    const meta = metadata[item.url] || {};
    return parseSizeBytes(meta.sizeBytes || meta.size_bytes || 0)
      || (Number(meta.file_size_mb) > 0 ? Number(meta.file_size_mb) * 1024 ** 2 : 0)
      || item.sizeBytes || 0;
  }

  function duplicatePreference(a, b) {
    const ma = metadata[a.url] || {}, mb = metadata[b.url] || {};
    const da = Number(ma.duration) || 0, db = Number(mb.duration) || 0;
    if (da && db && Math.abs(da - db) > Math.max(5, Math.max(da, db) * 0.03)) return 0;

    // 1. Vyššie rozlíšenie vyhráva
    const ha = Number(ma.height) || a.guessedHeight || 0;
    const hb = Number(mb.height) || b.guessedHeight || 0;
    if (ha && hb && ha !== hb) return ha > hb ? 1 : -1;

    // 2. Väčšia veľkosť súboru vyhráva (vyšší bitrate / originál namiesto komprimovaného)
    const sa = duplicateSize(a), sb = duplicateSize(b);
    if (sa && sb && sa !== sb) return sa > sb ? 1 : -1;

    // Ak nie je dostatok dôkazov (obe veľkosti aj rozlíšenia sú 0)
    if (!sa && !sb && !ha && !hb) return 0;

    // Známa veľkosť oproti neznámej
    if (sa && !sb) return 1;
    if (sb && !sa) return -1;

    // 3. Preferovať celý názov pred orezaným s trojbodkou
    const aEllipsis = /(?:\.{2,}|…)/.test(a.title);
    const bEllipsis = /(?:\.{2,}|…)/.test(b.title);
    if (aEllipsis !== bEllipsis) return aEllipsis ? -1 : 1;

    return a.index < b.index ? 1 : -1;
  }

  function updateDuplicates() {
    duplicateUrls = new Set();
    const winMap = typeof duplicateWinnerMap !== 'undefined' ? duplicateWinnerMap : new Map();
    const discMap = typeof duplicateDiscardedCountMap !== 'undefined' ? duplicateDiscardedCountMap : new Map();
    winMap.clear();
    discMap.clear();
    if (!/^\/f\//i.test(location.pathname)) return;

    const videoItems = items.filter((item) => item.type === 'videos');
    if (!videoItems.length) return;

    const groups = [];
    const assigned = new Set();
    for (let i = 0; i < videoItems.length; i++) {
      const a = videoItems[i];
      if (assigned.has(a.url)) continue;
      const group = [a];
      assigned.add(a.url);
      for (let j = i + 1; j < videoItems.length; j++) {
        const b = videoItems[j];
        if (assigned.has(b.url)) continue;
        const da = Number(metadata[a.url]?.duration) || 0;
        const db = Number(metadata[b.url]?.duration) || 0;
        if (areDuplicates(a.title, b.title, a.dateTs, b.dateTs, da, db)) {
          group.push(b);
          assigned.add(b.url);
        }
      }
      if (group.length > 1) groups.push(group);
    }

    let selectionChanged = false;
    for (const group of groups) {
      const winner = group.reduce((best, curr) => {
        if (!best) return curr;
        return duplicatePreference(curr, best) > 0 ? curr : best;
      }, null);
      if (!winner) continue;

      const losers = group.filter((item) => item !== winner && duplicatePreference(winner, item) > 0);
      if (!losers.length) continue;

      discMap.set(winner.url, losers.length);
      for (const loser of losers) {
        duplicateUrls.add(loser.url);
        winMap.set(loser.url, winner);
        if (selected.delete(loser.url)) {
          selected.add(winner.url);
          selectionChanged = true;
        }
      }
    }
    if (selectionChanged) persist();
  }

  // --- Detekcia videí v Nexus Dashboarde / Knižnici ---
  function isItemInDashboard(item) {
    if (!item) return false;
    if (item.url && dashboardUrls.has(item.url)) return true;
    if (item.slug && dashboardSlugs.has(item.slug)) return true;
    if (item.url) {
      const altUrl = item.url.includes('filester.me')
        ? item.url.replace('filester.me', 'filester.gg')
        : item.url.replace('filester.gg', 'filester.me');
      if (dashboardUrls.has(altUrl)) return true;
    }
    return false;
  }

  function getDashboardInfo(item) {
    if (!item) return null;
    if (item.url && dashboardData.has(item.url)) return dashboardData.get(item.url);
    if (item.url) {
      const altUrl = item.url.includes('filester.me')
        ? item.url.replace('filester.me', 'filester.gg')
        : item.url.replace('filester.gg', 'filester.me');
      if (dashboardData.has(altUrl)) return dashboardData.get(altUrl);
    }
    if (item.slug) {
      for (const [url, data] of dashboardData.entries()) {
        if (url.includes(`/d/${item.slug}`)) return data;
      }
    }
    return null;
  }

  function scheduleDashboardCheck(delay = 350) {
    clearTimeout(dashboardCheckTimer);
    dashboardCheckTimer = window.setTimeout(() => checkDashboardVideos(false), delay);
  }

  async function checkDashboardVideos(force = false) {
    if (dashboardCheckRunning) return;
    const videoItems = items.filter((item) => item.type === 'videos');
    if (!videoItems.length) return;

    const now = Date.now();
    if (!force && lastDashboardCheckTs && (now - lastDashboardCheckTs < 120000)) return;

    if (connection !== 'online' && !(await detectPort(false))) return;

    dashboardCheckRunning = true;
    if (force) toast('Overujem prítomnosť videí v Nexus knižnici…');

    try {
      const payloadItems = videoItems.map((item) => {
        const meta = metadata[item.url] || {};
        const sizeBytes = parseSizeBytes(meta.sizeBytes || meta.size_bytes || meta.file_size_mb || 0) || item.sizeBytes || 0;
        return {
          url: item.url,
          title: item.title,
          size_bytes: sizeBytes,
          duration: Number(meta.duration || 0),
          height: Number(meta.height || 0) || item.guessedHeight || 0,
          thumb: item.thumb || '',
        };
      });

      let matchedCount = 0;
      let usedCompare = false;

      // 1. Primárny pokus: porovnanie s databázou cez /api/v1/duplicates/compare-album
      try {
        const response = await bridgeFetch(`http://localhost:${state.port}/api/v1/duplicates/compare-album`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: payloadItems }),
          timeoutMs: 15000,
        });
        if (response.ok) {
          const data = await response.json().catch(() => ({}));
          if (Array.isArray(data.results)) {
            usedCompare = true;
            for (const r of data.results) {
              if (!r || !r.url) continue;
              const hasMatch = Boolean(r.matched_video);
              if (hasMatch) {
                dashboardUrls.add(r.url);
                const slugMatch = r.url.match(/\/d\/([A-Za-z0-9_-]+)/);
                if (slugMatch) dashboardSlugs.add(slugMatch[1]);
                const entry = {
                  inDashboard: true,
                  matched: r.matched_video,
                  status: r.status,
                  reason: r.reason,
                  ts: now,
                };
                dashboardData.set(r.url, entry);
                dashboardCache[r.url] = entry;
                matchedCount++;
              }
            }
          }
        }
      } catch (err) {
        console.warn('[Filester Workspace] compare-album check error:', err);
      }

      // 2. Fallback na /api/v1/videos/exists (ak compare-album nevrátil výsledky alebo zlyhal)
      if (!usedCompare) {
        try {
          const rawUrls = videoItems.map((it) => it.url);
          const allUrls = [...new Set([
            ...rawUrls,
            ...rawUrls.map((u) => u.includes('filester.me') ? u.replace('filester.me', 'filester.gg') : u.replace('filester.gg', 'filester.me')),
          ])];
          const response = await bridgeFetch(`http://localhost:${state.port}/api/v1/videos/exists`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: allUrls }),
            timeoutMs: 10000,
          });
          if (response.ok) {
            const data = await response.json().catch(() => ({}));
            if (Array.isArray(data.existing)) {
              for (const u of data.existing) {
                dashboardUrls.add(u);
                const slugMatch = u.match(/\/d\/([A-Za-z0-9_-]+)/);
                if (slugMatch) dashboardSlugs.add(slugMatch[1]);
                const entry = { inDashboard: true, ts: now };
                dashboardData.set(u, entry);
                dashboardCache[u] = entry;
                matchedCount++;
              }
            }
          }
        } catch (err) {
          console.warn('[Filester Workspace] videos/exists check error:', err);
        }
      }

      lastDashboardCheckTs = now;
      try {
        localStorage.setItem(DASHBOARD_CACHE_KEY, JSON.stringify(dashboardCache));
      } catch (_) {}

      // Prekreslenie kariet s aktualizovanými badges
      for (const item of items) {
        const inDb = isItemInDashboard(item);
        item.el.classList.toggle('nfw-in-dashboard', inDb);
        const badge = item.el.querySelector('.nfw-meta-badge');
        if (badge) paintBadge(item, badge);
      }

      applySortAndFilters();
      syncToolbar();

      if (force) {
        const totalInDb = items.filter((it) => it.type === 'videos' && isItemInDashboard(it)).length;
        toast(`Knižnica overená: ${totalInDb} videí sa nachádza v dashboarde.`);
      }
    } catch (error) {
      console.warn('[Filester Workspace] checkDashboardVideos failed:', error);
      if (force) toast(`Overenie knižnice zlyhalo: ${error.message || error}`, true);
    } finally {
      dashboardCheckRunning = false;
    }
  }

  function injectCardTools() {
    for (const item of items) {
      const { el, url } = item;
      el.classList.add('nfw-card');
      el.classList.toggle('nfw-in-dashboard', isItemInDashboard(item));
      let checkbox = el.querySelector('.nfw-check');
      if (!checkbox) {
        const label = document.createElement('label');
        label.className = 'nfw-check-wrap';
        label.title = 'Označiť pre hromadnú akciu';
        label.innerHTML = '<input class="nfw-check" type="checkbox"><span></span>';
        stopCardClick(label);
        el.appendChild(label);
        checkbox = label.querySelector('input');
        checkbox.addEventListener('change', () => {
          checkbox.checked ? selected.add(url) : selected.delete(url);
          el.classList.toggle('nfw-selected', checkbox.checked);
          persist();
          syncToolbar();
        });
      }
      checkbox.checked = selected.has(url);
      el.classList.toggle('nfw-selected', checkbox.checked);
      bindCtrlCardSelection(el, checkbox);

      let review = el.querySelector('.nfw-review');
      if (!review) {
        review = document.createElement('button');
        review.type = 'button';
        review.className = 'nfw-review';
        stopCardClick(review);
        review.addEventListener('click', () => {
          reviewed.has(url) ? reviewed.delete(url) : reviewed.add(url);
          persist();
          refresh();
        });
        el.appendChild(review);
      }
      const done = reviewed.has(url);
      review.textContent = done ? '✓' : '○';
      review.title = done ? 'Označené ako prezreté – kliknutím vrátiť' : 'Označiť ako prezreté';
      el.classList.toggle('nfw-reviewed', done);

      let badge = el.querySelector('.nfw-meta-badge');
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'nfw-meta-badge';
        el.appendChild(badge);
      }
      paintBadge(item, badge);

      const preview = el.querySelector('.file-preview');
      if (preview && !preview.dataset.nfwSelectBound) {
        preview.dataset.nfwSelectBound = '1';
        preview.classList.add('nfw-select-preview');
        preview.title = 'Kliknutím označíš video pre hromadnú akciu';
        preview.addEventListener('click', (event) => {
          if (event.target.closest('.nfw-play, .nfw-split-play')) return;
          // The preview may be inside Filester's native link. Capture the click
          // here so only the preview selects; the title and details keep opening /d/.
          event.preventDefault();
          event.stopPropagation();
          checkbox.checked = !checkbox.checked;
          checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        }, true);
      }

      let play = el.querySelector('.nfw-play');
      if (item.type === 'videos' && !play) {
        play = document.createElement('button');
        play.type = 'button';
        play.className = 'nfw-play';
        play.title = 'Prehrať video';
        play.setAttribute('aria-label', `Prehrať ${item.title}`);
        play.textContent = '▶';
        stopCardClick(play);
        play.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openPlayer(item);
        });
        (preview || el).appendChild(play);
      }
      if (play) {
        play.hidden = item.type !== 'videos';
      }

      let splitPlay = el.querySelector('.nfw-split-play');
      if (item.type === 'videos' && !splitPlay) {
        splitPlay = document.createElement('button');
        splitPlay.type = 'button';
        splitPlay.className = 'nfw-split-play';
        splitPlay.title = 'Prehrať v Nexus Split-Screen';
        splitPlay.setAttribute('aria-label', `Prehrať ${item.title} v Nexus Split-Screen`);
        splitPlay.textContent = '▦';
        stopCardClick(splitPlay);
        splitPlay.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openInSplitScreen(item, splitPlay);
        });
        (preview || el).appendChild(splitPlay);
      }
      if (splitPlay) splitPlay.hidden = item.type !== 'videos';
    }
  }

  function ensurePlayerModal() {
    if (playerModal) return playerModal;
    playerModal = document.createElement('div');
    playerModal.id = `${PREFIX}-player`;
    playerModal.className = 'nfw-player-modal';
    playerModal.hidden = true;
    playerModal.innerHTML = `
      <section class="nfw-player-dialog" role="dialog" aria-modal="true" aria-label="Prehrávač videa">
        <header><strong data-role="title"></strong><button type="button" data-action="close" aria-label="Zavrieť prehrávač">×</button></header>
        <div class="nfw-player-stage" data-role="stage"><p>Načítavam prehrávač…</p></div>
      </section>`;
    document.body.appendChild(playerModal);
    playerModal.querySelector('[data-action="close"]').addEventListener('click', closePlayer);
    playerModal.addEventListener('click', (event) => {
      if (event.target === playerModal) closePlayer();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !playerModal.hidden) closePlayer();
    });
    return playerModal;
  }

  function closePlayer() {
    if (!playerModal) return;
    const video = playerModal.querySelector('video');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    playerModal.hidden = true;
  }

  async function resolvePlayerStream(item) {
    const cached = metadata[item.url] || {};
    const direct = String(cached.stream_url || cached.direct_url || '').trim();
    if (direct) return direct;
    if (connection !== 'online' && !(await detectPort(true))) {
      throw new Error('Nexus nie je dostupný na načítanie priameho streamu.');
    }
    const response = await bridgeFetch(`http://localhost:${state.port}/api/tester/batch-meta`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [item.url] }), timeoutMs: 120000,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `Server ${response.status}`);
    const result = (data.results || []).find((entry) => entry?.url === item.url) || data.results?.[0];
    const stream = String(result?.stream_url || result?.direct_url || '').trim();
    if (!stream) throw new Error(result?.error || 'Priamy stream pre toto video nebol nájdený.');
    metadata[item.url] = Object.assign({}, cached, {
      ok: Boolean(result.ok), duration: Number(result.duration || 0),
      height: Number(result.height || 0), width: Number(result.width || 0),
      quality: result.quality || '', sizeBytes: parseSizeBytes(result.size_bytes || result.file_size_mb || result.filesize || result.size || 0),
      thumbnail: normalizeThumbnailUrl(result.thumbnail || result.thumbnail_url || cached.thumbnail || ''),
      stream_url: stream, direct_url: String(result.direct_url || stream),
      upload_date: result.upload_date || result.uploaded_at || cached.upload_date || '', ts: Date.now(),
    });
    persist();
    return stream;
  }

  function normalizeThumbnailUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(raw, `http://localhost:${state.port}`);
      return /^https?:$/.test(url.protocol) ? url.href : '';
    } catch {
      return '';
    }
  }

  async function openInSplitScreen(item, button) {
    return openSelectedInSplitScreen([item], button);
  }

  function bindSplitLauncher() {
    if (document.documentElement.dataset.nfwSplitLauncher === '1') return;
    document.documentElement.dataset.nfwSplitLauncher = '1';
    document.addEventListener('click', event => {
      if (!event.target?.closest?.('#nuss-fab')) return;
      const targets = items.filter(item => selected.has(item.url) && item.type === 'videos');
      if (!targets.length) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (document.documentElement.dataset.nexusFilesterPicker === '1') {
        const payload = targets.map(item => {
          const meta = metadata[item.url] || {};
          return { url: item.url, title: item.title, poster: meta.thumbnail || item.thumb || '',
            duration: Number(meta.duration) || 0, quality: meta.quality || (meta.height ? `${meta.height}p` : ''),
            size: Number(meta.sizeBytes || item.sizeBytes) || 0 };
        });
        document.dispatchEvent(new CustomEvent('nexus-filester-split-picker', { detail: JSON.stringify(payload) }));
      } else {
        const button = document.querySelector(`#${TOOLBAR_ID} [data-action="splitSelected"]`);
        if (button && !button.disabled) openSelectedInSplitScreen(targets, button);
      }
    }, true);
    document.addEventListener('nexus-filester-resolve', async event => {
      let request;
      try {
        request = JSON.parse(event.detail);
        const item = items.find(candidate => candidate.url === request.url && candidate.type === 'videos');
        if (!item) throw new Error('Video už nie je v otvorenom albume.');
        const url = await resolvePlayerStream(item);
        document.dispatchEvent(new CustomEvent('nexus-filester-resolved', { detail: JSON.stringify({ id: request.id, url }) }));
      } catch (error) {
        if (request?.id) document.dispatchEvent(new CustomEvent('nexus-filester-resolved', { detail: JSON.stringify({ id: request.id, error: error.message || String(error) }) }));
      }
    });
    document.addEventListener('nexus-filester-meta', async event => {
      let request;
      try {
        request = JSON.parse(event.detail);
        const item = items.find(candidate => candidate.url === request.url && candidate.type === 'videos');
        if (!item) throw new Error('Video už nie je v otvorenom albume.');
        const meta = await resolveSplitMetadata(item);
        document.dispatchEvent(new CustomEvent('nexus-filester-meta-result', { detail: JSON.stringify({ id: request.id, meta }) }));
      } catch (error) {
        if (request?.id) document.dispatchEvent(new CustomEvent('nexus-filester-meta-result', { detail: JSON.stringify({ id: request.id, error: error.message || String(error) }) }));
      }
    });
  }

  async function resolveSplitMetadata(item) {
    const cached = metadata[item.url] || {};
    if (Number(cached.duration) > 0 && (Number(cached.height) > 0 || cached.quality)) {
      return { ...cached, sizeBytes: Number(cached.sizeBytes || item.sizeBytes) || 0 };
    }
    if (connection !== 'online' && !(await detectPort(true))) throw new Error('Nexus nie je dostupný.');
    const response = await bridgeFetch(`http://localhost:${state.port}/api/tester/batch-meta`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [item.url] }), timeoutMs: 120000,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `Server ${response.status}`);
    const result = (data.results || []).find(entry => entry?.url === item.url) || data.results?.[0];
    if (!result || result.error) throw new Error(result?.error || 'Metadáta nie sú dostupné.');
    const stream = result.stream_url || result.direct_url || cached.stream_url || '';
    const probe = stream && (!Number(result.duration) || !Number(result.height))
      ? await probeVideoMetadata(stream) : {};
    const sizeBytes = parseSizeBytes(result.size_bytes || result.filesize || result.size || 0)
      || (Number(result.file_size_mb) > 0 ? Math.round(Number(result.file_size_mb) * 1024 ** 2) : 0)
      || Number(cached.sizeBytes || item.sizeBytes) || 0;
    const meta = metadata[item.url] = { ...cached, ok: Boolean(result.ok),
      duration: Number(result.duration || probe.duration || cached.duration) || 0,
      width: Number(result.width || probe.width || cached.width) || 0,
      height: Number(result.height || probe.height || cached.height) || 0,
      quality: result.quality || cached.quality || '', sizeBytes,
      thumbnail: normalizeThumbnailUrl(result.thumbnail || result.thumbnail_url || cached.thumbnail || item.thumb || ''),
      stream_url: stream, direct_url: result.direct_url || stream,
      upload_date: result.upload_date || result.uploaded_at || cached.upload_date || '', ts: Date.now() };
    persist();
    return meta;
  }

  async function openSelectedInSplitScreen(targets, button) {
    if (document.documentElement.dataset.nexusSplitReady !== '1') {
      toast('Nexus Universal Split-Screen nie je na tejto stránke načítaný.', true);
      return;
    }
    if (!targets.length) { toast('Najprv označ videá pre Split-Screen.', true); return; }
    if (targets.length > 12) { toast('Split-Screen podporuje najviac 12 videí. Uprav výber.', true); return; }
    button.disabled = true;
    const label = button.textContent;
    let finished = 0;
    try {
      const resolved = await mapWithLimit(targets, 3, async item => {
        try {
          const stream = await resolvePlayerStream(item);
          const meta = metadata[item.url] || {};
          return { url: stream, directUrl: stream, watchUrl: item.url, title: item.title,
            poster: meta.thumbnail || item.thumb || '', duration: Number(meta.duration) || 0,
            quality: meta.quality || (meta.height ? `${meta.height}p` : ''), size: Number(meta.sizeBytes || item.sizeBytes) || 0 };
        } catch (error) {
          console.warn('[Filester Workspace] Split-Screen:', item.url, error);
          return null;
        } finally {
          finished += 1;
          button.textContent = `Načítavam ${finished}/${targets.length}`;
        }
      });
      const playable = resolved.filter(Boolean);
      if (!playable.length) throw new Error(_t('Nepodarilo sa načítať žiadne vybrané video.', 'Failed to load any selected video.'));
      document.dispatchEvent(new CustomEvent('nexus-filester-split-open', {
        detail: JSON.stringify(playable),
      }));
      const overlay = document.getElementById('nuss-overlay');
      if (!overlay || getComputedStyle(overlay).display === 'none') {
        throw new Error('Nexus Split-Screen neprevzal videá. Aktualizuj aj skript Nexus Universal Split-Screen.');
      }
      if (playable.length < targets.length) toast(`Načítaných ${playable.length}/${targets.length} videí; niektoré zdroje zlyhali.`, true);
    } catch (error) {
      toast(`Split-Screen sa nepodarilo spustiť: ${error.message || error}`, true);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  async function openPlayer(item) {
    const modal = ensurePlayerModal();
    const title = modal.querySelector('[data-role="title"]');
    const stage = modal.querySelector('[data-role="stage"]');
    title.textContent = item.title;
    stage.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Načítavam video…' }));
    modal.hidden = false;
    try {
      const stream = await resolvePlayerStream(item);
      const video = document.createElement('video');
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.src = stream;
      video.addEventListener('error', () => {
        stage.querySelector('.nfw-player-error')?.remove();
        const message = document.createElement('p');
        message.className = 'nfw-player-error';
        message.textContent = 'Prehrávač nedokázal načítať tento stream.';
        stage.appendChild(message);
      });
      stage.replaceChildren(video);
      try {
        await video.play();
      } catch (_) {
        video.muted = true;
        await video.play().catch(() => {});
      }
    } catch (error) {
      const message = document.createElement('p');
      message.className = 'nfw-player-error';
      message.textContent = error.message || 'Prehrávač sa nepodarilo otvoriť.';
      stage.replaceChildren(message);
    }
  }

  function stopCardClick(element) {
    if (!element) {
      console.warn('[Filester Workspace] stopCardClick called with null element');
      return;
    }
    for (const name of ['pointerdown', 'mousedown', 'click', 'dblclick']) {
      element.addEventListener(name, (event) => event.stopPropagation());
    }
  }

  function bindCtrlCardSelection(card, checkbox) {
    if (card.dataset.nfwCtrlSelectBound) return;
    card.dataset.nfwCtrlSelectBound = '1';
    card.addEventListener('click', (event) => {
      if (!event.ctrlKey || event.button !== 0) return;
      if (event.target.closest('.nfw-play, .nfw-split-play, .nfw-review, .nfw-folder-open-btn')) return;
      event.preventDefault();
      event.stopPropagation();
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    }, true);
  }

  function paintBadge(item, badge) {
    const meta = metadata[item.url] || {};
    const height = Number(meta.height || 0) || item.guessedHeight;
    const duration = Number(meta.duration || 0);
    const size = parseSizeBytes(meta.sizeBytes || meta.size_bytes || meta.file_size_mb || 0) || item.sizeBytes;
    const bitrate = duration && size ? (size * 8) / duration : 0;
    const score = densityScore(height, bitrate);
    const isDuplicate = duplicateUrls.has(item.url);
    const discardedCount = duplicateDiscardedCountMap.get(item.url) || 0;
    const inDashboard = isItemInDashboard(item);
    const parts = [];

    if (inDashboard) {
      const dbInfo = getDashboardInfo(item);
      const batchPart = dbInfo?.matched?.batch_name ? ` (Batch: ${escapeHtml(dbInfo.matched.batch_name)})` : '';
      const qualityPart = dbInfo?.matched?.height ? ` · ${dbInfo.matched.height}p` : '';
      const titlePart = dbInfo?.matched?.title ? `\nNázov v DB: ${escapeHtml(dbInfo.matched.title)}` : '';
      parts.push(`<span class="nfw-dash-badge" title="Toto video sa už nachádza v Nexus dashboarde / knižnici${batchPart}${qualityPart}${titlePart}">🏠 V knižnici</span>`);
    }

    if (isDuplicate) {
      const winner = duplicateWinnerMap.get(item.url);
      const winnerTitle = winner?.title || 'kvalitnejšia verzia';
      parts.push(`<span class="nfw-dupe-tag is-low" title="Vyradený duplikát – ponechaný originál: ${escapeHtml(winnerTitle)}">✕ Duplikát</span>`);
    } else if (discardedCount > 0) {
      parts.push(`<span class="nfw-dupe-winner-tag is-hq" title="Ponechaná vyššia kvalita – automaticky vyradených ${discardedCount} menších verzií">✓ HQ (+${discardedCount})</span>`);
    }
    if (duration) parts.push(`<span>⏱ ${formatDuration(duration)}</span>`);
    if (height) parts.push(`<span>${qualityLabel(height)}${meta.height ? '' : '*'}</span>`);
    if (score.label) parts.push(`<span class="${score.cls}" title="${score.title}">${score.label} ${formatBitrate(bitrate)}</span>`);
    const uploadTs = parseUploadTime(meta.upload_date) || item.dateTs;
    if (uploadTs) {
      const full = new Intl.DateTimeFormat('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(uploadTs);
      parts.push(`<span class="nfw-upload-date" title="Nahrané: ${full}">📅 ${full}</span>`);
    }
    badge.innerHTML = parts.join('');
    badge.hidden = !parts.length;
  }

  function parseUploadTime(value) {
    if (value == null || value === '') return 0;
    const raw = String(value).trim();
    const numeric = /^\d{9,13}$/.test(raw) ? Number(raw) * (raw.length === 13 ? 1 : 1000) : 0;
    const ts = numeric || Date.parse(raw);
    return Number.isFinite(ts) && ts > 0 ? ts : 0;
  }

  function guessHeight(title) {
    const t = String(title || '').toUpperCase();
    if (/(?:^|[^0-9])(4K|2160P|UHD)(?![A-Z0-9])/.test(t)) return 2160;
    if (/(?:^|[^0-9])(1440P|2K|QHD)(?![A-Z0-9])/.test(t)) return 1440;
    if (/(?:^|[^0-9])(1080P?|FHD)(?![A-Z0-9])/.test(t)) return 1080;
    if (/(?:^|[^0-9])(720P?|HD)(?![A-Z0-9])/.test(t)) return 720;
    if (/(?:^|[^0-9])480P?(?![A-Z0-9])/.test(t)) return 480;
    if (/(?:^|[^0-9])360P?(?![A-Z0-9])/.test(t)) return 360;
    return 0;
  }

  function qualityLabel(height) {
    return height >= 2160 ? '4K' : height >= 1440 ? '1440p'
      : height >= 1080 ? '1080p' : height >= 720 ? '720p'
        : height >= 480 ? '480p' : height ? `${height}p` : 'Neznáma';
  }

  function qualityTier(item) {
    const h = Number(metadata[item.url]?.height || 0) || item.guessedHeight;
    return h >= 2160 ? '4k' : h >= 1440 ? '1440' : h >= 1080 ? '1080'
      : h >= 720 ? '720' : h > 0 ? 'sd' : 'unknown';
  }

  function matchesQuality(item, selectedTier) {
    return selectedTier === 'all' || qualityTier(item) === selectedTier;
  }

  function tokenizeQuery(value) {
    const tokens = [];
    String(value || '').match(/-?"[^"]+"|-?\S+/g)?.forEach((raw) => {
      const negative = raw.startsWith('-');
      const clean = raw.replace(/^-/, '').replace(/^"|"$/g, '').trim().toLowerCase();
      if (clean) tokens.push({ value: clean, negative });
    });
    return tokens;
  }

  function visibleItems() {
    const tokens = tokenizeQuery(state.query);
    const minDuration = positiveNumber(state.minDuration) * 60;
    const maxDuration = positiveNumber(state.maxDuration) * 60;
    const minSize = positiveNumber(state.minSize) * 1024 ** 2;
    const maxSize = positiveNumber(state.maxSize) * 1024 ** 2;
    return items.filter((item) => {
      if (!state.showDuplicates && duplicateUrls.has(item.url)) return false;
      if (isMergedMode && activeMergedFolderFilter !== 'all' && item.folderSlug !== activeMergedFolderFilter) return false;
      const haystack = item.title.toLowerCase();
      if (tokens.some((t) => t.negative ? haystack.includes(t.value) : !haystack.includes(t.value))) return false;
      if (!matchesQuality(item, state.quality)) return false;
      if (state.dashboardFilter === 'imported' && !isItemInDashboard(item)) return false;
      if (state.dashboardFilter === 'not_imported' && isItemInDashboard(item)) return false;
      if (state.onlyUnreviewed && reviewed.has(item.url)) return false;
      const duration = Number(metadata[item.url]?.duration || 0);
      const size = parseSizeBytes(metadata[item.url]?.sizeBytes || metadata[item.url]?.size_bytes || metadata[item.url]?.file_size_mb || 0) || item.sizeBytes;
      if ((minDuration || maxDuration) && !duration) return false;
      if (minDuration && duration < minDuration) return false;
      if (maxDuration && duration > maxDuration) return false;
      if (minSize && size < minSize) return false;
      if (maxSize && size > maxSize) return false;
      return true;
    });
  }

  function sortedItems(list) {
    const copy = [...list];
    const duration = (item) => Number(metadata[item.url]?.duration || 0);
    const height = (item) => Number(metadata[item.url]?.height || 0) || item.guessedHeight;
    const size = (item) => parseSizeBytes(metadata[item.url]?.sizeBytes || metadata[item.url]?.size_bytes || metadata[item.url]?.file_size_mb || 0) || item.sizeBytes;
    const inDb = (item) => (isItemInDashboard(item) ? 1 : 0);
    const sorters = {
      importedFirst: (a, b) => (inDb(b) - inDb(a)) || (a.index - b.index),
      notImportedFirst: (a, b) => (inDb(a) - inDb(b)) || (a.index - b.index),
      az: (a, b) => a.title.localeCompare(b.title),
      za: (a, b) => b.title.localeCompare(a.title),
      newest: (a, b) => (parseUploadTime(metadata[b.url]?.upload_date) || b.dateTs) - (parseUploadTime(metadata[a.url]?.upload_date) || a.dateTs),
      oldest: (a, b) => (parseUploadTime(metadata[a.url]?.upload_date) || a.dateTs) - (parseUploadTime(metadata[b.url]?.upload_date) || b.dateTs),
      sizeDesc: (a, b) => size(b) - size(a),
      sizeAsc: (a, b) => size(a) - size(b),
      durationDesc: (a, b) => duration(b) - duration(a),
      durationAsc: (a, b) => duration(a) - duration(b),
      qualityDesc: (a, b) => height(b) - height(a),
      qualityAsc: (a, b) => height(a) - height(b),
    };
    return sorters[state.sort] ? copy.sort(sorters[state.sort]) : copy.sort((a, b) => a.index - b.index);
  }

  function applySortAndFilters() {
    const matchingItems = visibleItems();
    const visible = new Set(matchingItems.map((item) => item.url));
    for (const item of items) {
      const isDuplicate = duplicateUrls.has(item.url);
      const matches = visible.has(item.url);
      const shouldHide = (!state.showDuplicates && isDuplicate) || (state.hideMisses && !matches);
      const shouldDim = (!state.hideMisses && !matches) || (state.showDuplicates && isDuplicate);
      item.el.classList.toggle('nfw-hidden', shouldHide);
      item.el.classList.toggle('nfw-dim', shouldDim);
      item.el.classList.toggle('nfw-duplicate-card', isDuplicate);
    }

    // CSS grid already compacts after ``display:none``. Moving cards just to
    // group hidden mismatches causes Filester to observe and restore the DOM,
    // which produces the visible blink. Only reorder when the user explicitly
    // selected a custom sort.
    if (state.sort === 'native') return;
    const orderedItems = sortedItems(items);
    const desired = orderedItems.map((item) => item.el);
    const current = fileCards(grid);
    if (desired.some((element, index) => current[index] !== element)) {
      for (const element of desired) grid.appendChild(element);
    }
  }

  function applyLayout() {
    const mode = GRID_MODES[state.layout] || GRID_MODES.large;
    document.body.classList.add('nfw-active');
    // Filester v0.12 removed the `main-content` class.  Keep the workspace
    // shell on the parent of either the old or new main element.
    const main = grid?.closest('main');
    if (main?.parentElement) main.parentElement.classList.add('nfw-shell');
    document.documentElement.style.setProperty('--nfw-card-min', `${mode.min}px`);
    document.documentElement.style.setProperty('--nfw-thumb-ratio', mode.ratio);
  }

  function compactAlbumHeader() {
    const header = document.querySelector('body > header');
    const section = grid?.closest('.files-section, .file-manager-section') || grid?.parentElement;
    if (!header || !section || document.getElementById(UTILITY_NAV_ID)) return;

    const nav = header.querySelector('nav');
    if (!nav) return;

    const utility = document.createElement('aside');
    utility.id = UTILITY_NAV_ID;
    utility.setAttribute('aria-label', 'Filester navigácia');
    nav.classList.remove('mb-3');
    utility.appendChild(nav);
    section.insertBefore(utility, document.getElementById(TOOLBAR_ID) || grid);
  }

  function ensureToolbar() {
    try {
      if (document.getElementById(TOOLBAR_ID)) return;
      if (!grid) {
        console.warn('[Filester Workspace] Cannot create toolbar - grid not found');
        return;
      }

      const toolbar = document.createElement('section');
      toolbar.id = TOOLBAR_ID;
      toolbar.innerHTML = `
        <div class="nfw-head">
          <div class="nfw-brand"><span class="nfw-logo">N</span><div><strong>Filester Workspace</strong><small>album review + Nexus import · v1.4.3</small></div></div>
          <div class="nfw-status"><i data-role="led"></i><span data-role="connection">Hľadám Nexus…</span></div>
          <button type="button" class="nfw-icon" data-action="collapse" title="Zbaliť panel">−</button>
        </div>
        <div class="nfw-body">
          <div class="nfw-row nfw-primary-row">
            <label class="nfw-search"><span>⌕</span><input data-role="query" placeholder='Hľadať: meno "presná fráza" -nechcené'></label>
            <select data-role="quality" title="Filter kvality">
              <option value="all">Všetky kvality</option><option value="4k">4K / 2160p</option>
              <option value="1440">1440p / 2K</option><option value="1080">1080p</option>
              <option value="720">720p</option><option value="sd">SD</option><option value="unknown">Neznáma</option>
            </select>
            <select data-role="dashboardFilter" title="Filter podľa prítomnosti v dashboarde">
              <option value="all">Všetky videá</option>
              <option value="imported">🏠 V dashboarde</option>
              <option value="not_imported">✨ Nové (mimo DB)</option>
            </select>
            <select data-role="sort" title="Zoradenie">
              <option value="native">Pôvodné poradie</option>
              <option value="importedFirst">🏠 Importované navrchu</option>
              <option value="notImportedFirst">✨ Neimportované navrchu</option>
              <option value="newest">Najnovšie</option><option value="oldest">Najstaršie</option>
              <option value="az">Názov A–Z</option><option value="za">Názov Z–A</option>
              <option value="sizeDesc">Veľkosť ↓</option><option value="sizeAsc">Veľkosť ↑</option>
              <option value="durationDesc">Dĺžka ↓</option><option value="durationAsc">Dĺžka ↑</option>
              <option value="qualityDesc">Kvalita ↓</option><option value="qualityAsc">Kvalita ↑</option>
            </select>
          </div>
          <div class="nfw-row nfw-controls">
            <div class="nfw-segment" aria-label="Veľkosť gridu">
              <button type="button" data-layout="mini">Mini</button><button type="button" data-layout="compact">Kompakt</button><button type="button" data-layout="overview">Prehľad</button><button type="button" data-layout="large">Veľké</button><button type="button" data-layout="cinema">Kino</button><button type="button" data-layout="poster">Max</button>
            </div>
            <label>min <input data-role="minDuration" inputmode="decimal" placeholder="min"> min</label>
            <label>max <input data-role="maxDuration" inputmode="decimal" placeholder="min"> min</label>
            <label>od <input data-role="minSize" inputmode="decimal" placeholder="MB"> MB</label>
            <label>do <input data-role="maxSize" inputmode="decimal" placeholder="MB"> MB</label>
            <button type="button" data-toggle="onlyUnreviewed">○ Neprezreté</button>
            <button type="button" data-toggle="hideMisses">Skryť nezhody</button>
            <button type="button" data-toggle="showDuplicates" title="Zobraziť alebo skryť vyradené duplikáty">Duplikáty: ${state.showDuplicates ? 'Zobrazené' : 'Skryté'}</button>
          </div>
          <div class="nfw-row nfw-actions">
            <span class="nfw-stats" data-role="stats">0 súborov</span>
            <button type="button" data-action="loadAllPages" title="Načítať všetky strany">Všetky strany</button>
            <div class="nfw-page-range" title="Zadaj rozsah strán na načítanie">
              <span>Strany</span>
              <input type="number" data-role="pageFrom" min="1" placeholder="od" value="1" title="Číslo začiatočnej strany">
              <span>–</span>
              <input type="number" data-role="pageTo" min="1" placeholder="do" title="Číslo konečnej strany">
              <button type="button" data-action="loadPageRange" title="Načítať iba vybraný rozsah strán">Rozsah</button>
            </div>
            <button type="button" class="nfw-stop-btn" data-action="stopAllPages" hidden title="Zastaviť načítavanie strán">Stop</button>
            <span data-role="pageProgress" aria-live="polite"></span>
            ${isManagerPage() ? '<button type="button" data-action="toggleNative">Filester menu</button>' : ''}
            <button type="button" data-action="selectVisible">Vybrať viditeľné</button>
            <button type="button" data-action="clearSelection">Zrušiť výber</button>
            <button type="button" data-action="splitSelected" title="Prehrať označené videá vedľa seba">▶▶ Split-Screen</button>
            <button type="button" data-action="fetchSelected">Meta vybrané</button>
            <button type="button" data-action="fetchVisible">Meta viditeľné</button>
            <button type="button" data-action="fetchHdPreview" title="Načítať HD náhľady vybraných videí">HD náhľady</button>
            <button type="button" data-action="checkDashboard" title="Znova overiť, ktoré videá sa nachádzajú v Nexus dashboarde">🏠 Overiť knižnicu</button>
            <button type="button" class="nfw-copy-direct" data-action="copySelected">COPY DIRECT URL</button>
            <button type="button" data-action="addToAlbum">Pridať do albumu</button>
            <button type="button" class="nfw-import" data-action="importSelected">Importovať vybrané</button>
            <select data-role="port" title="Port Nexus dashboardu">${PORTS.map((port) => `<option>${port}</option>`).join('')}</select>
          </div>
          <div class="nfw-row nfw-import-options">
            <label class="nfw-batch-name">Batch v dashboarde <input data-role="batchName" maxlength="160" placeholder="Filester · názov albumu"></label>
            <label class="nfw-board-toggle" title="Vytvorí alebo použije Source Board pre aktuálny album; import bude patriť do rovnakého batchu."><input type="checkbox" data-role="addToSourceBoards"> Pridať album aj do Source Boards</label>
          </div>
          <div class="nfw-progress" data-role="progress" hidden><i></i><span></span></div>
          <div class="nfw-help">Tip: klik na náhľad alebo <kbd>Ctrl+klik</kbd> na kartu označí súbor · klik na názov alebo info otvorí stránku · <kbd>/</kbd> hľadanie · <kbd>Shift+A</kbd> vybrať viditeľné</div>
        </div>`;

        const section = grid.closest('.files-section, .file-manager-section') || grid.parentElement;
      if (!section) {
        console.warn('[Filester Workspace] Cannot create toolbar - section not found');
        return;
      }

      section.insertBefore(toolbar, grid);
      bindToolbar(toolbar);
    } catch (error) {
      console.error('[Filester Workspace] Error creating toolbar:', error);
    }
  }

  function bindToolbar(toolbar) {
    if (!toolbar) {
      console.warn('[Filester Workspace] Toolbar element not found');
      return;
    }

    const fields = ['query', 'quality', 'dashboardFilter', 'sort', 'minDuration', 'maxDuration', 'minSize', 'maxSize'];
    for (const name of fields) {
      const element = toolbar.querySelector(`[data-role="${name}"]`);
      if (!element) {
        console.warn(`[Filester Workspace] Field element not found: ${name}`);
        continue;
      }
      element.value = state[name];
      element.addEventListener(name === 'query' || name.includes('Duration') || name.includes('Size') ? 'input' : 'change', () => {
        state[name] = element.value;
        persist();
        applySortAndFilters();
        syncToolbar();
      });
    }

    const port = toolbar.querySelector('[data-role="port"]');
    if (port) {
      port.value = String(state.port);
      port.addEventListener('change', () => { state.port = Number(port.value); persist(); detectPort(true); });
    }

    const batchName = toolbar.querySelector('[data-role="batchName"]');
    if (batchName) {
      const albumBatchKey = albumStorageKey('batch-name');
      const storedAlbumBatch = loadString(albumBatchKey);
      state.batchName = storedAlbumBatch || `Filester · ${albumTitle()}`;
      persist();
      batchName.value = state.batchName;
      batchName.addEventListener('input', () => {
        state.batchName = batchName.value;
        try { localStorage.setItem(albumBatchKey, state.batchName.trim()); } catch {}
        persist();
      });
    }

    const addToSourceBoards = toolbar.querySelector('[data-role="addToSourceBoards"]');
    if (addToSourceBoards) {
      addToSourceBoards.checked = Boolean(state.addToSourceBoards);
      addToSourceBoards.addEventListener('change', () => {
        state.addToSourceBoards = addToSourceBoards.checked;
        persist();
      });
    }

    const pageFromInput = toolbar.querySelector('[data-role="pageFrom"]');
    const pageToInput = toolbar.querySelector('[data-role="pageTo"]');
    const handleRangeKeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        loadPagesWorkflow(toolbar);
      }
    };
    pageFromInput?.addEventListener('keydown', handleRangeKeydown);
    pageToInput?.addEventListener('keydown', handleRangeKeydown);

    toolbar.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.action === 'loadAllPages') { loadPagesWorkflow(toolbar, { allPages: true, fromPage: 1 }); return; }
      if (button.dataset.action === 'loadPageRange') { loadPagesWorkflow(toolbar); return; }
      if (button.dataset.action === 'stopAllPages') { allPagesAbort?.abort(); return; }
      if (button.dataset.action === 'toggleNative') { document.body.classList.toggle('nfw-show-native'); return; }
      if (button.dataset.layout) {
        state.layout = button.dataset.layout; persist(); applyLayout(); syncToolbar(); return;
      }
      if (button.dataset.toggle === 'onlyUnreviewed') {
        state.onlyUnreviewed = !state.onlyUnreviewed; persist(); refresh(); return;
      }
      if (button.dataset.toggle === 'hideMisses') {
        state.hideMisses = !state.hideMisses; persist(); refresh(); return;
      }
      if (button.dataset.toggle === 'showDuplicates' || button.dataset.action === 'toggleDuplicates') {
        state.showDuplicates = !state.showDuplicates; persist(); applySortAndFilters(); syncToolbar(); return;
      }
      runAction(button.dataset.action);
    });
  }

  function findTotalPages() {
    try {
      const loadAllBtn = document.querySelector('#loadAllPagesBtn');
      const attrTotal = loadAllBtn?.getAttribute('data-total');
      if (attrTotal) {
        const parsed = parseInt(attrTotal, 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
      if (loadAllBtn?.textContent) {
        const textMatch = loadAllBtn.textContent.match(/(\d+)\s*pages?/i);
        if (textMatch) {
          const parsed = parseInt(textMatch[1], 10);
          if (Number.isFinite(parsed) && parsed > 0) return parsed;
        }
      }

      let maxPage = 1;
      const paginators = document.querySelectorAll('.pagination a, .pagination span, .file-pagination a, [class*="pagination"] a, a[href*="page="], a[href*="files_page="]');
      for (const el of paginators) {
        const textVal = parseInt(el.textContent?.trim(), 10);
        if (Number.isFinite(textVal) && textVal > maxPage) maxPage = textVal;
        const href = el.getAttribute('href');
        if (href) {
          try {
            const url = new URL(href, location.origin);
            const p = parseInt(url.searchParams.get('page') || url.searchParams.get('files_page'), 10);
            if (Number.isFinite(p) && p > maxPage) maxPage = p;
          } catch {}
        }
      }
      return maxPage;
    } catch {
      return 1;
    }
  }

  function extractCardSlug(el) {
    if (!el) return '';
    const onclick = el.getAttribute?.('onclick') || '';
    const rawUrl = el.dataset?.url || el.dataset?.fileUrl || el.dataset?.href || el.querySelector?.('a[href*="/d/"]')?.getAttribute('href') || '';
    return onclick.match(/\/d\/([A-Za-z0-9_-]+)/)?.[1]
      || rawUrl.match(/\/d\/([A-Za-z0-9_-]+)/)?.[1]
      || el.dataset?.fileSlug || el.dataset?.slug || el.dataset?.fileId || '';
  }

  async function loadPagesWorkflow(toolbar, options = {}) {
    if (allPagesAbort) return;

    const startBtn = toolbar.querySelector('[data-action="loadAllPages"]');
    const rangeBtn = toolbar.querySelector('[data-action="loadPageRange"]');
    const stopBtn = toolbar.querySelector('[data-action="stopAllPages"]');
    const progress = toolbar.querySelector('[data-role="pageProgress"]');
    const inputFrom = toolbar.querySelector('[data-role="pageFrom"]');
    const inputTo = toolbar.querySelector('[data-role="pageTo"]');

    const totalKnown = findTotalPages();
    let fromPage = 1;
    let toPage = options.allPages ? (totalKnown > 1 ? totalKnown : 9999) : null;

    if (!options.allPages) {
      if (typeof options.fromPage === 'number') {
        fromPage = options.fromPage;
      } else if (inputFrom?.value) {
        fromPage = parseInt(inputFrom.value, 10) || 1;
      }
      if (typeof options.toPage === 'number') {
        toPage = options.toPage;
      } else if (inputTo?.value) {
        toPage = parseInt(inputTo.value, 10) || fromPage;
      } else {
        toPage = totalKnown > fromPage ? totalKnown : fromPage;
      }
    }

    fromPage = Math.max(1, fromPage);
    if (toPage !== null) {
      toPage = Math.max(1, toPage);
      if (toPage < fromPage) {
        const tmp = fromPage;
        fromPage = toPage;
        toPage = tmp;
      }
      if (inputFrom) inputFrom.value = String(fromPage);
      if (inputTo && !options.allPages) inputTo.value = String(toPage);
    }

    const scope = location.href;
    const originalGrid = grid;
    if (!originalGrid) {
      toast('Grid so súbormi nebol nájdený.', true);
      return;
    }

    const controller = new AbortController();
    allPagesAbort = controller;
    if (startBtn) startBtn.disabled = true;
    if (rangeBtn) rangeBtn.disabled = true;
    if (stopBtn) stopBtn.hidden = false;

    const seen = new Set(items.map((item) => item.slug).filter(Boolean));
    let added = 0;

    try {
      if (isManagerPage()) {
        let total = totalKnown > 1 ? totalKnown : 1;
        const targetEnd = options.allPages ? total : (toPage || total);

        for (let page = fromPage; page <= (options.allPages ? total : targetEnd); page++) {
          if (location.href !== scope || grid !== originalGrid || !originalGrid.isConnected) {
            throw new Error('Priečinok sa zmenil; načítanie zastavené.');
          }

          const params = new URLSearchParams({
            files_page: String(page),
            folders_page: '1',
            with_hierarchy: '1',
            folder_sort: document.querySelector('#folderSortSelect')?.value || 'newest',
            file_sort: document.querySelector('#fileSortSelect')?.value || 'newest'
          });
          const folder = new URL(scope).searchParams.get('folder');
          if (folder) params.set('folder', folder);

          const maxDisplay = options.allPages ? total : targetEnd;
          if (progress) progress.textContent = `Strana ${page}/${maxDisplay} · +${added}`;

          const response = await fetch(`/api/manager/data?${params}`, {
            credentials: 'include',
            cache: 'no-store',
            signal: controller.signal,
            headers: { Accept: 'application/json' }
          });
          if (!response.ok) throw new Error(`Server HTTP ${response.status}`);
          const data = await response.json();

          if (location.href !== scope || grid !== originalGrid || !originalGrid.isConnected) {
            throw new Error('Priečinok sa zmenil; načítanie zastavené.');
          }
          if (!Array.isArray(data.files) || Number(data.filePage) !== page || !Number.isInteger(Number(data.filePages)) || Number(data.filePages) < page || (folder && data.currentFolder !== folder)) {
            throw new Error('Server vrátil neočakávanú stránku alebo priečinok.');
          }

          total = Number(data.filePages);
          if (inputTo && !inputTo.value && total > 1) {
            inputTo.placeholder = String(total);
          }

          for (const file of data.files) {
            const slug = String(file.Slug || file.slug || '').trim();
            if (!slug || seen.has(slug)) continue;
            seen.add(slug);
            const title = String(file.OriginalName || file.name || file.Name || slug).trim();
            const card = document.createElement('article');
            card.className = 'file-card nfw-loaded-card';
            card.dataset.name = title;
            card.dataset.fileSlug = slug;
            card.dataset.size = String(Number(file.Size || file.size || 0));
            card.dataset.date = file.CreatedAt || file.created_at || file.UploadedAt || file.uploaded_at || '';
            const link = document.createElement('a');
            link.href = `/d/${encodeURIComponent(slug)}`;
            const preview = document.createElement('div');
            preview.className = 'file-preview';
            const thumb = String(file.ThumbnailURL || file.thumbnail || '');
            if (thumb) {
              const img = document.createElement('img');
              img.src = thumb;
              img.alt = '';
              img.loading = 'lazy';
              preview.append(img);
            }
            const name = document.createElement('span');
            name.className = 'file-name';
            name.textContent = title;
            link.append(preview, name);
            card.append(link);
            originalGrid.append(card);
            added++;
          }
          refresh();
        }
      } else {
        // Album page (/f/<slug> or similar)
        const albumSlugMatch = location.pathname.match(/\/f\/([A-Za-z0-9_-]+)/);
        const albumSlug = albumSlugMatch ? albumSlugMatch[1] : '';
        let total = totalKnown > 1 ? totalKnown : 1;
        const targetEnd = options.allPages ? total : (toPage || total);

        for (let page = fromPage; page <= (options.allPages ? total : targetEnd); page++) {
          if (location.href !== scope || grid !== originalGrid || !originalGrid.isConnected) {
            throw new Error('Stránka sa zmenila; načítanie zastavené.');
          }

          const maxDisplay = options.allPages ? (total > 1 ? total : '?') : targetEnd;
          if (progress) progress.textContent = `Strana ${page}/${maxDisplay} · +${added}`;

          const pageUrl = albumSlug ? `/f/${albumSlug}?page=${page}` : `${location.pathname}?page=${page}`;
          const response = await fetch(pageUrl, {
            credentials: 'same-origin',
            signal: controller.signal
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const html = await response.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');

          const docTotalAttr = doc.querySelector('#loadAllPagesBtn')?.getAttribute('data-total');
          if (docTotalAttr) {
            const parsedTotal = parseInt(docTotalAttr, 10);
            if (Number.isFinite(parsedTotal) && parsedTotal > 0) {
              total = parsedTotal;
              if (inputTo && !inputTo.value) inputTo.placeholder = String(total);
            }
          }

          const fileItems = [...doc.querySelectorAll('#filesGrid .file-item, .files-list .file-item, .file-card')];
          if (!fileItems.length && page > 1) {
            break;
          }

          for (const item of fileItems) {
            const slug = extractCardSlug(item);
            if (slug && seen.has(slug)) continue;
            if (slug) seen.add(slug);

            item.classList.add('nfw-loaded-card');
            originalGrid.appendChild(item);
            added++;
          }
          refresh();
        }
      }

      if (progress) progress.textContent = `Hotovo · pridaných ${added} · spolu ${items.length}`;
    } catch (error) {
      if (progress) {
        progress.textContent = error.name === 'AbortError'
          ? `Zastavené · pridaných ${added}`
          : `Načítanie zastavené: ${error.message}`;
      }
    } finally {
      allPagesAbort = null;
      if (startBtn) startBtn.disabled = false;
      if (rangeBtn) rangeBtn.disabled = false;
      if (stopBtn) stopBtn.hidden = true;
      if (connection === 'online') scheduleDashboardCheck(150);
    }
  }

  async function loadAllManagerPages(toolbar) {
    return loadPagesWorkflow(toolbar, { allPages: true, fromPage: 1 });
  }

  function runAction(action) {
    if (action === 'collapse') {
      document.getElementById(TOOLBAR_ID)?.classList.toggle('nfw-collapsed'); return;
    }
    if (action === 'selectVisible') {
      for (const item of visibleItems()) selected.add(item.url);
      persist(); refresh(); return;
    }
    if (action === 'clearSelection') {
      selected.clear(); persist(); refresh(); return;
    }
    if (action === 'splitSelected') {
      const targets = items.filter(item => selected.has(item.url) && item.type === 'videos');
      const button = document.querySelector(`#${TOOLBAR_ID} [data-action="splitSelected"]`);
      if (button) openSelectedInSplitScreen(targets, button);
      return;
    }
    if (action === 'fetchSelected') {
      fetchMetadata(items.filter((item) => selected.has(item.url))); return;
    }
    if (action === 'fetchVisible') { fetchMetadata(visibleItems()); return; }
    if (action === 'fetchHdPreview') {
      fetchMetadata(items.filter((item) => selected.has(item.url)), { applyHdPreviews: true }); return;
    }
    if (action === 'copySelected') { copySelectedUrls(); return; }
    if (action === 'addToAlbum') { addSelectedToAlbum(); return; }
    if (action === 'checkDashboard') { checkDashboardVideos(true); return; }
    if (action === 'importSelected') { importSelected(); }
  }

  function bindKeyboardShortcuts() {
    try {
      if (!document || !document.addEventListener) {
        console.warn('[Filester Workspace] Cannot bind keyboard shortcuts - document not ready');
        return;
      }

      document.addEventListener('keydown', (event) => {
        try {
          const editable = event.target?.matches?.('input, textarea, select, [contenteditable="true"]');
          if (event.key === '/' && !editable) {
            event.preventDefault();
            const queryInput = document.querySelector(`#${TOOLBAR_ID} [data-role="query"]`);
            if (queryInput) queryInput.focus();
          }
          if (event.shiftKey && event.key.toLowerCase() === 'a' && !editable) {
            event.preventDefault();
            runAction('selectVisible');
          }
        } catch (error) {
          console.warn('[Filester Workspace] Error in keyboard shortcut handler:', error);
        }
      });
    } catch (error) {
      console.error('[Filester Workspace] Error binding keyboard shortcuts:', error);
    }
  }

  function syncToolbar() {
    const toolbar = document.getElementById(TOOLBAR_ID);
    if (!toolbar) return;

    toolbar.querySelectorAll('[data-layout]').forEach((button) => button.classList.toggle('is-on', button.dataset.layout === state.layout));
    toolbar.querySelector('[data-toggle="onlyUnreviewed"]')?.classList.toggle('is-on', state.onlyUnreviewed);
    toolbar.querySelector('[data-toggle="hideMisses"]')?.classList.toggle('is-on', state.hideMisses);
    toolbar.querySelector('[data-toggle="showDuplicates"]')?.classList.toggle('is-on', state.showDuplicates);
    const dupeBtn = toolbar.querySelector('[data-toggle="showDuplicates"]');
    if (dupeBtn) {
      dupeBtn.textContent = `Duplikáty: ${state.showDuplicates ? 'Zobrazené' : 'Skryté'}${duplicateUrls.size ? ` (${duplicateUrls.size})` : ''}`;
    }

    const visible = visibleItems();
    const timed = items.filter((item) => Number(metadata[item.url]?.duration || 0) > 0).length;
    const inDbCount = items.filter((item) => item.type === 'videos' && isItemInDashboard(item)).length;

    const dbFilterSelect = toolbar.querySelector('[data-role="dashboardFilter"]');
    if (dbFilterSelect && dbFilterSelect.value !== state.dashboardFilter) {
      dbFilterSelect.value = state.dashboardFilter;
    }

    const statsElement = toolbar.querySelector('[data-role="stats"]');
    if (statsElement) {
      const dupeNotice = duplicateUrls.size > 0
        ? ` · <button type="button" class="nfw-dupe-toggle-btn${state.showDuplicates ? ' is-active' : ''}" data-action="toggleDuplicates" title="Kliknutím prepneš zobrazenie vyradených duplicít">${duplicateUrls.size} duplicít vyradených (${state.showDuplicates ? 'zobrazené' : 'skryté'})</button>`
        : ' · 0 duplicít vyradených';
      statsElement.innerHTML = `<span>${visible.length}/${items.length - (state.showDuplicates ? 0 : duplicateUrls.size)} viditeľných</span>${dupeNotice} · <span>${selected.size} vybraných</span> · <span>${timed} s meta</span> · <span class="nfw-stat-dashboard" title="Počet videí z tohto albumu, ktoré sa už nachádzajú v Nexus dashboarde / knižnici">🏠 ${inDbCount} v knižnici</span> · <span>${reviewed.size} prezretých</span>`;
    }

    const addToAlbumButton = toolbar.querySelector('[data-action="addToAlbum"]');
    if (addToAlbumButton) {
      addToAlbumButton.textContent = `Pridať do albumu (${selected.size})`;
      addToAlbumButton.disabled = selected.size === 0;
    }

    const importButton = toolbar.querySelector('[data-action="importSelected"]');
    if (importButton) {
      importButton.textContent = `Importovať vybrané (${selected.size})`;
      importButton.disabled = selected.size === 0;
    }

    const hdButton = toolbar.querySelector('[data-action="fetchHdPreview"]');
    if (hdButton) hdButton.disabled = selected.size === 0;
    const splitButton = toolbar.querySelector('[data-action="splitSelected"]');
    if (splitButton) {
      const videoCount = items.filter(item => selected.has(item.url) && item.type === 'videos').length;
      splitButton.textContent = `▶▶ Split-Screen (${videoCount})`;
      splitButton.disabled = videoCount === 0;
    }

    const portElement = toolbar.querySelector('[data-role="port"]');
    if (portElement) {
      portElement.value = String(state.port);
    }

    const led = toolbar.querySelector('[data-role="led"]');
    if (led) {
      led.className = connection;
    }

    const connectionElement = toolbar.querySelector('[data-role="connection"]');
    if (connectionElement) {
      connectionElement.textContent = connection === 'online'
        ? `Nexus :${state.port}` : connection === 'checking' ? 'Hľadám Nexus…' : 'Nexus offline';
    }

    const totalPages = findTotalPages();
    const pageFromInput = toolbar.querySelector('[data-role="pageFrom"]');
    const pageToInput = toolbar.querySelector('[data-role="pageTo"]');
    if (totalPages > 1) {
      if (pageToInput) {
        pageToInput.placeholder = String(totalPages);
        pageToInput.max = String(totalPages);
      }
      if (pageFromInput) {
        pageFromInput.max = String(totalPages);
      }
    }
  }

  async function fetchMetadata(pool, { applyHdPreviews = false } = {}) {
    const targets = [...new Map(pool.filter((item) => item.type === 'videos').map((item) => [item.url, item])).values()];
    if (!targets.length) { toast(_t('Nie sú vybrané žiadne videá.', 'No videos selected.'), true); return; }
    if (metadataRunning) { toast('Načítavanie meta údajov už prebieha.'); return; }
    if (connection !== 'online' && !(await detectPort(true))) return;
    metadataRunning = true;
    setProgress(0, `Pripravujem ${targets.length} videí…`);
    try {
      let completed = 0;
      let hdPreviewsApplied = 0;
      for (let offset = 0; offset < targets.length; offset += META_CHUNK) {
        const chunk = targets.slice(offset, offset + META_CHUNK);
        const response = await bridgeFetch(`http://localhost:${state.port}/api/tester/batch-meta`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: chunk.map((item) => item.url) }), timeoutMs: 120000,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || `Server ${response.status}`);
        const enrichedResults = await mapWithLimit(data.results || [], 4, async (result) => {
          if (!result?.stream_url || (Number(result.duration || 0) > 0 && Number(result.height || 0) > 0)) return result;
          const browserMeta = await probeVideoMetadata(result.stream_url);
          return Object.assign({}, result, {
            duration: Number(result.duration || 0) || browserMeta.duration,
            height: Number(result.height || 0) || browserMeta.height,
            width: Number(result.width || 0) || browserMeta.width,
          });
        });
        for (const result of enrichedResults) {
          if (!result?.url) continue;
          metadata[result.url] = {
            ok: Boolean(result.ok), duration: Number(result.duration || 0),
            height: Number(result.height || 0), width: Number(result.width || 0),
            quality: result.quality || '', sizeBytes: parseSizeBytes(result.size_bytes || result.file_size_mb || result.filesize || result.size || 0),
            thumbnail: normalizeThumbnailUrl(result.thumbnail || result.thumbnail_url || metadata[result.url]?.thumbnail || ''),
            stream_url: result.stream_url || result.direct_url || '',
            direct_url: result.direct_url || result.stream_url || '',
            upload_date: result.upload_date || result.uploaded_at || metadata[result.url]?.upload_date || '', ts: Date.now(),
          };
        }
        if (applyHdPreviews) {
          const itemsByUrl = new Map(targets.map((item) => [item.url, item]));
          const loaded = await mapWithLimit(enrichedResults, 3, async (result) => {
            const item = itemsByUrl.get(result?.url);
            return item ? applyHdPreview(item) : false;
          });
          hdPreviewsApplied += loaded.filter(Boolean).length;
        }
        completed += chunk.length;
        persist();
        refresh();
        setProgress(Math.round(completed / targets.length * 100), `Meta ${completed}/${targets.length}`);
      }
      const resolved = targets.filter((item) => Number(metadata[item.url]?.duration || 0) > 0).length;
      if (applyHdPreviews) {
        toast(
          _t(`Video snímky v HD: ${hdPreviewsApplied}/${targets.length} úspešne načítaných.`, `HD video previews: ${hdPreviewsApplied}/${targets.length} successfully loaded.`),
          hdPreviewsApplied === 0,
        );
      } else {
        toast(`Meta hotová: ${resolved}/${targets.length} videí má zistenú dĺžku.`);
      }
    } catch (error) {
      toast(_t(`Meta zlyhala: ${error.message || error}`, `Metadata fetch failed: ${error.message || error}`), true);
    } finally {
      metadataRunning = false;
      window.setTimeout(() => setProgress(null), 1200);
      syncToolbar();
    }
  }

  function highResolutionFrameUrl(item) {
    const meta = metadata[item.url] || {};
    const stream = normalizeThumbnailUrl(meta.stream_url || meta.direct_url);
    if (!stream) return '';
    const frame = new URL(`http://localhost:${state.port}/api/tester/stream-frame`);
    frame.searchParams.set('stream_url', stream);
    const duration = Number(meta.duration || 0);
    frame.searchParams.set('at', String(duration
      ? Math.min(10, Math.max(2, Math.floor(duration / 10)))
      : 5));
    frame.searchParams.set('width', '3840');
    return frame.href;
  }

  function loadImageSource(image, src) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (loaded) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        image.removeEventListener('load', onLoad);
        image.removeEventListener('error', onError);
        resolve(loaded);
      };
      const onLoad = () => finish(image.naturalWidth > 0);
      const onError = () => finish(false);
      const timer = window.setTimeout(() => finish(false), 45000);
      image.addEventListener('load', onLoad);
      image.addEventListener('error', onError);
      image.src = src;
      if (image.complete) finish(image.naturalWidth > 0);
    });
  }

  async function applyHdPreview(item) {
    const meta = metadata[item.url] || {};
    const hdSrc = highResolutionFrameUrl(item);
    const fallbackSrc = normalizeThumbnailUrl(meta.thumbnail);
    const src = hdSrc || fallbackSrc;
    if (!src) return false;
    let image = item.el.querySelector('.file-preview img, img');
    const preview = item.el.querySelector('.file-preview');
    if (!image && preview) {
      image = document.createElement('img');
      image.alt = '';
      image.decoding = 'async';
      preview.appendChild(image);
    }
    if (!image) return false;
    if (!image.dataset.nfwOriginalSrc) image.dataset.nfwOriginalSrc = image.currentSrc || image.src || '';
    if (!image.dataset.nfwOriginalSrcset) image.dataset.nfwOriginalSrcset = image.getAttribute('srcset') || '';
    if (!image.dataset.nfwOriginalSizes) image.dataset.nfwOriginalSizes = image.getAttribute('sizes') || '';
    image.removeAttribute('srcset');
    image.removeAttribute('sizes');
    image.loading = 'eager';
    image.dataset.nfwHdSrc = src;
    if (await loadImageSource(image, src)) return true;
    if (fallbackSrc && fallbackSrc !== src && await loadImageSource(image, fallbackSrc)) return false;
    const original = image.dataset.nfwOriginalSrc;
    if (original && original !== src) image.src = original;
    if (image.dataset.nfwOriginalSrcset) image.setAttribute('srcset', image.dataset.nfwOriginalSrcset);
    if (image.dataset.nfwOriginalSizes) image.setAttribute('sizes', image.dataset.nfwOriginalSizes);
    console.warn('[Filester Workspace] Could not capture/load a video frame:', src);
    return false;
  }

  async function importSelected() {
    const targets = items.filter((item) => selected.has(item.url) && item.type === 'videos');
    if (!targets.length) { toast('Najprv označ videá na import.', true); return; }
    if (connection !== 'online' && !(await detectPort(true))) return;
    const batchName = dashboardBatchName();
    const candidates = targets.map((item) => {
      const meta = metadata[item.url] || {};
      const sizeBytes = Number(meta.sizeBytes || 0) || item.sizeBytes;
      return {
        url: item.url, source_url: location.origin + location.pathname,
        title: item.title, thumbnail: item.thumb, duration: Number(meta.duration || 0),
        height: Number(meta.height || 0) || item.guessedHeight, width: Number(meta.width || 0),
        file_size_mb: sizeBytes ? Number((sizeBytes / 1024 ** 2).toFixed(2)) : 0,
        upload_date: (parseUploadTime(meta.upload_date) || item.dateTs) ? new Date(parseUploadTime(meta.upload_date) || item.dateTs).toISOString() : null,
        source: 'filester', tags: ['filester', 'album-workspace'], confidence: 0.98,
      };
    });
    toast(`Zaraďujem ${candidates.length} položiek do Nexus Import Desk…`);
    try {
      if (state.addToSourceBoards) await ensureSourceBoard(batchName);
      const response = await bridgeFetch(`http://localhost:${state.port}/api/v1/intake/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batch_name: batchName, candidates, source_mode: 'filester',
          auto_metadata: true, playwright_fallback: true,
        }), timeoutMs: 30000,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || `Server ${response.status}`);
      toast(`Zaradené: ${data.job?.total_items ?? candidates.length} videí · Import job #${data.job?.id ?? '?'}.${state.addToSourceBoards ? ' Source Board je prepojený.' : ''}`);
      for (const it of targets) {
        dashboardUrls.add(it.url);
        if (it.slug) dashboardSlugs.add(it.slug);
        const entry = { inDashboard: true, ts: Date.now() };
        dashboardData.set(it.url, entry);
        dashboardCache[it.url] = entry;
      }
      try { localStorage.setItem(DASHBOARD_CACHE_KEY, JSON.stringify(dashboardCache)); } catch (_) {}
      for (const it of items) {
        if (isItemInDashboard(it)) {
          it.el.classList.add('nfw-in-dashboard');
          const badge = it.el.querySelector('.nfw-meta-badge');
          if (badge) paintBadge(it, badge);
        }
      }
      applySortAndFilters();
      syncToolbar();
    } catch (error) {
      toast(_t(`Import zlyhal: ${error.message || error}`, `Import failed: ${error.message || error}`), true);
    }
  }

  function dashboardBatchName() {
    return (state.batchName || '').trim() || `Filester · ${albumTitle()}`;
  }

  function currentAlbumUrl() {
    const url = new URL(location.href);
    url.hash = '';
    return url.href;
  }

  function normalizedAlbumUrl(value) {
    try {
      const url = new URL(value);
      url.hash = '';
      url.searchParams.delete('page');
      return url.href.replace(/\/$/, '');
    } catch { return String(value || '').replace(/\/$/, ''); }
  }

  async function ensureSourceBoard(batchName) {
    const sourceUrl = currentAlbumUrl();
    const response = await bridgeFetch(`http://localhost:${state.port}/api/v1/source-boards`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: batchName, batch_name: batchName, source_url: sourceUrl,
        source_type: 'filester', description: `Filester album · ${albumTitle()}`,
        icon: 'folder_special', color: '#a855f7', pinned: true,
      }), timeoutMs: 15000,
    });
    if (response.ok) return;

    const data = await response.json().catch(() => ({}));
    if (response.status !== 400) throw new Error(data.detail || `Source Board HTTP ${response.status}`);

    const boardsResponse = await bridgeFetch(`http://localhost:${state.port}/api/v1/source-boards`, { timeoutMs: 15000 });
    if (!boardsResponse.ok) throw new Error(data.detail || `Source Board HTTP ${response.status}`);
    const boardsData = await boardsResponse.json().catch(() => ({}));
    const existing = (boardsData.boards || []).find((board) => board.name === batchName);
    if (existing && normalizedAlbumUrl(existing.source_url) === normalizedAlbumUrl(sourceUrl)) {
      if (existing.batch_name !== batchName) await updateSourceBoardBatch(existing, batchName);
      return;
    }
    throw new Error(`Source Board „${batchName}“ už existuje pre iný zdroj. Zvoľ iný názov batchu.`);
  }

  async function updateSourceBoardBatch(board, batchName) {
    const response = await bridgeFetch(`http://localhost:${state.port}/api/v1/source-boards/${board.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: board.name, source_url: board.source_url, source_type: board.source_type || 'filester',
        batch_name: batchName, description: board.description || '', icon: board.icon || 'folder_special',
        color: board.color || '#a855f7', pinned: Boolean(board.pinned),
      }), timeoutMs: 15000,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `Source Board HTTP ${response.status}`);
  }

  async function loadUserAlbums() {
    try {
      const response = await fetch('/api/user/folders', { credentials: 'include' });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) return { unauthenticated: true, folders: [] };
        const mgrResp = await fetch('/api/manager/data?folders_page=1&all_folders=1&with_hierarchy=1&folder_sort=az', { credentials: 'include' });
        if (mgrResp.ok) {
          const mgrData = await mgrResp.json();
          const list = (mgrData.folders || mgrData.allFoldersHierarchical || []).map((f) => ({
            id: f.ID || f.id,
            identifier: f.Identifier || f.identifier,
            name: f.Name || f.name,
            path: f.Path || f.path || f.Name || f.name,
          }));
          return { unauthenticated: false, folders: list };
        }
        return { unauthenticated: false, folders: [] };
      }
      const data = await response.json();
      return { unauthenticated: false, folders: Array.isArray(data.folders) ? data.folders : [] };
    } catch (err) {
      console.warn('[Filester Workspace] Chyba pri načítaní zoznamu albumov:', err);
      return { unauthenticated: false, folders: [] };
    }
  }

  function ensureAlbumModal() {
    if (albumModal) return albumModal;
    albumModal = document.createElement('div');
    albumModal.id = `${PREFIX}-album-modal`;
    albumModal.className = 'nfw-album-modal';
    albumModal.hidden = true;
    albumModal.innerHTML = `
      <section class="nfw-album-dialog" role="dialog" aria-modal="true" aria-label="${_t('Pridať do albumu', 'Add to album')}">
        <header>
          <strong data-role="title">${_t('Pridať do albumu', 'Add to album')}</strong>
          <button type="button" data-action="close" aria-label="${_t('Zavrieť', 'Close')}">✕</button>
        </header>
        <div class="nfw-album-body">
          <p data-role="subtitle" class="nfw-album-subtitle"></p>
          <label>
            <span>${_t('Cieľový album:', 'Target album:')}</span>
            <select data-role="album-select"></select>
          </label>
          <div data-role="new-album-box" class="nfw-new-album-box" style="display:none;">
            <label>
              <span>${_t('Názov nového albumu:', 'New album name:')}</span>
              <input type="text" data-role="new-album-name" maxlength="100" placeholder="${_t('Môj nový album', 'My new album')}">
            </label>
            <label class="nfw-album-checkbox">
              <input type="checkbox" data-role="new-album-public">
              <span>${_t('Verejný album (Public)', 'Public album')}</span>
            </label>
          </div>
        </div>
        <footer class="nfw-album-footer">
          <button type="button" data-action="cancel">${_t('Zrušiť', 'Cancel')}</button>
          <button type="button" data-action="confirm" class="nfw-primary">${_t('Pridať do albumu', 'Add to album')}</button>
        </footer>
      </section>`;
    document.body.appendChild(albumModal);

    const closeBtn = albumModal.querySelector('[data-action="close"]');
    const cancelBtn = albumModal.querySelector('[data-action="cancel"]');
    const select = albumModal.querySelector('[data-role="album-select"]');
    const newBox = albumModal.querySelector('[data-role="new-album-box"]');
    const newNameInput = albumModal.querySelector('[data-role="new-album-name"]');

    select.addEventListener('change', () => {
      const isNew = select.value === '__new__';
      newBox.style.display = isNew ? 'grid' : 'none';
      if (isNew) newNameInput.focus();
    });

    const hide = () => { albumModal.hidden = true; };
    closeBtn.addEventListener('click', hide);
    cancelBtn.addEventListener('click', hide);
    albumModal.addEventListener('click', (event) => {
      if (event.target === albumModal) hide();
    });
    return albumModal;
  }

  function promptTargetAlbum(itemCount) {
    return new Promise(async (resolve) => {
      const modal = ensureAlbumModal();
      const title = modal.querySelector('[data-role="title"]');
      const subtitle = modal.querySelector('[data-role="subtitle"]');
      const select = modal.querySelector('[data-role="album-select"]');
      const newBox = modal.querySelector('[data-role="new-album-box"]');
      const newNameInput = modal.querySelector('[data-role="new-album-name"]');
      const newPublicCheckbox = modal.querySelector('[data-role="new-album-public"]');
      const confirmBtn = modal.querySelector('[data-action="confirm"]');
      const cancelBtn = modal.querySelector('[data-action="cancel"]');
      const closeBtn = modal.querySelector('[data-action="close"]');

      const isMgr = isManagerPage();
      const actionVerb = isMgr ? _t('Presunúť', 'Move') : _t('Pridať do albumu', 'Add to album');
      title.textContent = isMgr ? _t('Presunúť do albumu', 'Move to album') : _t('Pridať do albumu', 'Add to album');
      subtitle.textContent = _t(
        `Vyber album pre ${itemCount} vybraných položiek:`,
        `Choose album for ${itemCount} selected items:`
      );
      confirmBtn.textContent = actionVerb;
      confirmBtn.disabled = true;

      select.innerHTML = `<option value="">${_t('Načítavam albumy…', 'Loading albums…')}</option>`;
      newBox.style.display = 'none';
      newNameInput.value = '';
      newPublicCheckbox.checked = false;
      modal.hidden = false;

      const { unauthenticated, folders } = await loadUserAlbums();
      if (unauthenticated) {
        modal.hidden = true;
        toast(_t('Nie si prihlásený do Filester účtu. Prihlás sa a skús znova.', 'Not logged in to Filester. Please log in and try again.'), true);
        resolve(null);
        return;
      }

      const lastChoice = localStorage.getItem(`${PREFIX}:last-album-choice`) || '';
      let optionsHtml = `<option value="root">${_t('— Účet (Root / bez albumu) —', '— Account Root (no album) —')}</option>`;
      for (const folder of folders) {
        const id = folder.id != null ? String(folder.id) : '';
        const ident = folder.identifier || '';
        const name = folder.path || folder.name || 'Album';
        const val = escapeHtml(JSON.stringify({ id, identifier: ident, name }));
        const isSelected = (lastChoice && (lastChoice === ident || lastChoice === id)) ? 'selected' : '';
        optionsHtml += `<option value="${val}" ${isSelected}>📁 ${escapeHtml(name)}</option>`;
      }
      optionsHtml += `<option value="__new__">${_t('+ Vytvoriť nový album…', '+ Create new album…')}</option>`;
      select.innerHTML = optionsHtml;
      confirmBtn.disabled = false;

      if (select.value === '__new__') newBox.style.display = 'grid';

      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        modal.hidden = true;
        confirmBtn.removeEventListener('click', onConfirm);
        cancelBtn.removeEventListener('click', onCancel);
        closeBtn.removeEventListener('click', onCancel);
        modal.removeEventListener('keydown', onKey);
        resolve(result);
      };

      const onCancel = () => finish(null);
      const onKey = (event) => {
        if (event.key === 'Escape') { finish(null); event.stopPropagation(); }
        else if (event.key === 'Enter' && event.target?.tagName !== 'BUTTON') {
          event.preventDefault();
          onConfirm();
        }
      };

      const onConfirm = async () => {
        if (select.value === '__new__') {
          const newName = newNameInput.value.trim();
          if (!newName) {
            toast(_t('Zadaj názov nového albumu.', 'Enter a name for the new album.'), true);
            newNameInput.focus();
            return;
          }
          confirmBtn.disabled = true;
          confirmBtn.textContent = _t('Vytváram…', 'Creating…');
          try {
            const createResp = await fetch('/api/folder/create', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: newName,
                password: '',
                public: newPublicCheckbox.checked ? 1 : 0,
              }),
            });
            const createData = await createResp.json().catch(() => ({}));
            if (!createResp.ok || createData.success === false) {
              throw new Error(createData.message || createData.error || `HTTP ${createResp.status}`);
            }
            const created = createData.data || createData.folder || {};
            const createdIdent = created.identifier || '';
            let createdId = created.id ? Number(created.id) : null;
            if (!createdId && createdIdent) {
              const refreshed = await loadUserAlbums();
              const found = refreshed.folders.find((f) => f.identifier === createdIdent);
              if (found) createdId = found.id ? Number(found.id) : null;
            }
            try { localStorage.setItem(`${PREFIX}:last-album-choice`, createdIdent || String(createdId || '')); } catch {}
            finish({
              isRoot: false,
              identifier: createdIdent,
              numericId: createdId,
              name: newName,
            });
          } catch (err) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = actionVerb;
            toast(_t(`Vytvorenie albumu zlyhalo: ${err.message || err}`, `Failed to create album: ${err.message || err}`), true);
          }
          return;
        }

        if (select.value === 'root') {
          try { localStorage.setItem(`${PREFIX}:last-album-choice`, 'root'); } catch {}
          finish({
            isRoot: true,
            identifier: 'root',
            numericId: null,
            name: _t('Účet (Root)', 'Account (Root)'),
          });
          return;
        }

        try {
          const parsed = JSON.parse(select.value);
          try { localStorage.setItem(`${PREFIX}:last-album-choice`, parsed.identifier || String(parsed.id || '')); } catch {}
          finish({
            isRoot: false,
            identifier: parsed.identifier || '',
            numericId: parsed.id ? Number(parsed.id) : null,
            name: parsed.name || 'Album',
          });
        } catch {
          finish({ isRoot: true, identifier: 'root', numericId: null, name: 'Root' });
        }
      };

      confirmBtn.addEventListener('click', onConfirm);
      cancelBtn.addEventListener('click', onCancel);
      closeBtn.addEventListener('click', onCancel);
      modal.addEventListener('keydown', onKey);
    });
  }

  async function addSelectedToAlbum() {
    const targets = items.filter((item) => selected.has(item.url));
    if (!targets.length) {
      toast(_t('Najprv označ videá na pridanie do albumu.', 'Select videos to add to album first.'), true);
      return;
    }

    const choice = await promptTargetAlbum(targets.length);
    if (!choice) return;

    const destName = choice.name || _t('Album', 'Album');
    const isMgr = isManagerPage();

    if (isMgr) {
      setProgress(0, _t(`Presúvam ${targets.length} súborov…`, `Moving ${targets.length} files…`));
      try {
        const slugs = targets.map((t) => t.slug);
        const response = await fetch('/api/files/move', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileIds: slugs, folder: choice.identifier || 'root' }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || (data && data.success === false)) {
          throw new Error(data.message || data.detail || `Filester HTTP ${response.status}`);
        }
        const successful = data.successful != null ? data.successful : slugs.length;
        const failed = data.failed != null ? data.failed : 0;
        let message = _t(
          `Hotovo: ${successful} presunutých do "${destName}"`,
          `Done: ${successful} moved to "${destName}"`
        );
        if (failed > 0) message += _t(`, ${failed} zlyhalo`, `, ${failed} failed`);
        toast(message, failed === slugs.length);

        if (typeof window.loadManager === 'function') {
          window.loadManager(window.currentFolder || '', window.currentFilesPage || 1, 1);
        } else {
          scheduleRefresh();
        }
      } catch (error) {
        toast(_t(`Presun zlyhal: ${error.message || error}`, `Move failed: ${error.message || error}`), true);
      } finally {
        window.setTimeout(() => setProgress(null), 1500);
      }
      return;
    }

    setProgress(0, _t(`Ukladám ${targets.length} videí do "${destName}"…`, `Saving ${targets.length} videos to "${destName}"…`));
    let succeeded = 0;
    let failed = 0;

    try {
      for (let i = 0; i < targets.length; i++) {
        const item = targets[i];
        await new Promise((resolve) => window.setTimeout(resolve, 180));
        try {
          const body = { slug: item.slug };
          if (!choice.isRoot && choice.numericId) {
            body.folder_id = choice.numericId;
          }
          const response = await fetch('/api/file/save', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await response.json().catch(() => ({}));

          if (response.ok && data.success !== false) {
            succeeded++;
          } else if (data && /already have this file/i.test(data.message || '')) {
            const accountSlug = data.slug || item.slug;
            if (!choice.isRoot && choice.identifier && choice.identifier !== 'root') {
              try {
                const moveRes = await fetch('/api/files/move', {
                  method: 'POST',
                  credentials: 'include',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ fileIds: [accountSlug], folder: choice.identifier }),
                });
                const moveData = await moveRes.json().catch(() => ({}));
                if (moveRes.ok && moveData.success !== false) {
                  succeeded++;
                } else {
                  succeeded++;
                }
              } catch {
                succeeded++;
              }
            } else {
              succeeded++;
            }
          } else {
            throw new Error(data.message || data.detail || `Filester HTTP ${response.status}`);
          }
        } catch (error) {
          failed++;
          console.warn(`[Filester Workspace] Chyba pri pridávaní ${item.slug}:`, error);
        }
        setProgress(Math.round((i + 1) / targets.length * 100), `Spracované ${i + 1}/${targets.length}`);
      }

      let message = _t(
        `Hotovo: ${succeeded} pridaných do "${destName}"`,
        `Done: ${succeeded} added to "${destName}"`
      );
      if (failed > 0) message += _t(`, ${failed} zlyhalo`, `, ${failed} failed`);
      toast(message, failed === targets.length);
    } catch (error) {
      toast(_t(`Pridávanie zlyhalo: ${error.message || error}`, `Adding failed: ${error.message || error}`), true);
    } finally {
      window.setTimeout(() => setProgress(null), 1500);
    }
  }

  async function copySelectedUrls() {
    const selectedItems = items.filter((item) => selected.has(item.url));
    if (!selectedItems.length) { toast('Nie je čo kopírovať.', true); return; }

    const directUrls = [];
    const missing = [];
    for (const item of selectedItems) {
      const meta = metadata[item.url] || {};
      const direct = (meta.stream_url || meta.direct_url || '').trim();
      if (direct) {
        directUrls.push(direct);
      } else {
        missing.push(item.title || item.url);
      }
    }

    const unique = [...new Set(directUrls.filter(Boolean))];
    if (missing.length) {
      toast(`Direct URL chýba pri ${missing.length} videách. Spusť Meta znova.`, true);
      return;
    }
    if (!unique.length) { toast(_t('Nenašli sa žiadne direct videá pre výber.', 'No direct videos found for selection.'), true); return; }

    try {
      await navigator.clipboard.writeText(unique.join('\n'));
      toast(`Skopírovaných ${unique.length} direct URL.`);
    } catch {
      const area = document.createElement('textarea');
      area.value = unique.join('\n'); document.body.appendChild(area); area.select();
      document.execCommand('copy'); area.remove(); toast(`Skopírovaných ${unique.length} direct URL.`);
    }
  }

  function albumTitle() {
    if (isMergedMode && mergedFoldersInfo.length) {
      return `Zlúčené (${mergedFoldersInfo.map((f) => f.title).join(', ')})`;
    }
    const heading = document.querySelector('main h1, .folder-header h1, .manager-header h1')?.textContent;
    const fallback = isManagerPage() ? 'Moje súbory' : (document.title || 'Album');
    return (heading || fallback)
      .replace(/\s*[|·-]\s*filester.*$/i, '').trim();
  }

  function bridgeFetch(url, options = {}) {
    if (!GM_REQ) return fetch(url, options);
    return new Promise((resolve, reject) => {
      GM_REQ({
        method: options.method || 'GET', url, headers: options.headers || {}, data: options.body,
        timeout: options.timeoutMs || 10000,
        onload: (result) => {
          const text = result.responseText || '';
          resolve({
            ok: result.status >= 200 && result.status < 300, status: result.status,
            json: async () => { try { return JSON.parse(text); } catch { return {}; } },
            text: async () => text,
          });
        },
        onerror: () => reject(new Error('Spojenie zlyhalo')),
        ontimeout: () => reject(new Error('Čas spojenia vypršal')),
      });
    });
  }

  async function detectPort(showError = false) {
    connection = 'checking'; syncToolbar();
    const order = [Number(state.port), ...PORTS.filter((port) => port !== Number(state.port))];
    for (const port of order) {
      try {
        const response = await bridgeFetch(`http://localhost:${port}/health`, { timeoutMs: 1400 });
        if (response.ok) {
          state.port = port; connection = 'online'; persist(); syncToolbar();
          scheduleDashboardCheck(100);
          return true;
        }
      } catch { /* try next port */ }
    }
    connection = 'offline'; syncToolbar();
    if (showError) toast(`Nexus dashboard neodpovedá na portoch ${PORTS.join(', ')}.`, true);
    return false;
  }

  function setProgress(percent, text = '') {
    const row = document.querySelector(`#${TOOLBAR_ID} [data-role="progress"]`);
    if (!row) return;
    row.hidden = percent == null;
    if (percent != null) {
      row.querySelector('i').style.width = `${Math.max(2, percent)}%`;
      row.querySelector('span').textContent = text;
    }
  }

  function positiveNumber(value) {
    const number = Number.parseFloat(String(value || '').replace(',', '.'));
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function parseSizeBytes(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
    const raw = String(value || '').trim().replace(',', '.');
    if (!raw) return 0;
    const match = raw.match(/^([\d.]+)\s*(B|KB|MB|GB|TB)?$/i);
    if (!match) return 0;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const multiplier = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[(match[2] || 'B').toUpperCase()] || 1;
    return Math.round(amount * multiplier);
  }

  async function mapWithLimit(values, limit, worker) {
    const results = new Array(values.length);
    let cursor = 0;
    async function run() {
      while (cursor < values.length) {
        const index = cursor++;
        results[index] = await worker(values[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
    return results;
  }

  function probeVideoMetadata(streamUrl) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        video.removeAttribute('src');
        try { video.load(); } catch { /* detached media element */ }
        resolve(value);
      };
      const timer = window.setTimeout(() => finish({ duration: 0, height: 0, width: 0 }), 10000);
      video.preload = 'metadata';
      video.muted = true;
      video.onloadedmetadata = () => finish({
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        height: Number(video.videoHeight || 0), width: Number(video.videoWidth || 0),
      });
      video.onerror = () => finish({ duration: 0, height: 0, width: 0 });
      video.src = streamUrl;
      video.load();
    });
  }

  function formatDuration(seconds) {
    const total = Math.round(Number(seconds) || 0);
    const h = Math.floor(total / 3600);
    const m = Math.floor(total % 3600 / 60);
    const s = total % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }

  function formatBitrate(bps) {
    return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)}M` : bps ? `${Math.round(bps / 1000)}k` : '';
  }

  function densityScore(height, bps) {
    if (!height || !bps) return { label: '', cls: '', title: '' };
    const mbps = bps / 1e6;
    const thresholds = height >= 2160 ? [18, 8] : height >= 1440 ? [10, 4.5]
      : height >= 1080 ? [6, 2.5] : height >= 720 ? [3, 1.2] : [1.5, 0.6];
    if (mbps >= thresholds[0]) return { label: 'HQ', cls: 'is-hq', title: 'Vysoká dátová hustota pre toto rozlíšenie' };
    if (mbps >= thresholds[1]) return { label: 'OK', cls: 'is-ok', title: 'Bežná dátová hustota pre toto rozlíšenie' };
    return { label: 'LOW', cls: 'is-low', title: 'Nízka dátová hustota pre toto rozlíšenie' };
  }

  function toast(message, error = false) {
    let element = document.getElementById(`${PREFIX}-toast`);
    if (!element) {
      element = document.createElement('div'); element.id = `${PREFIX}-toast`; document.body.appendChild(element);
    }
    element.textContent = message;
    element.classList.toggle('is-error', error);
    element.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => element.classList.remove('is-visible'), 4600);
  }

  // =========================================================================
  // SUBFOLDERS & VIRTUAL MERGED ALBUM MODULE
  // =========================================================================

  function initSubfolders() {
    if (isManagerPage()) return;
    const subGrid = document.querySelector('#subfoldersGrid, .subfolders-grid');
    if (!subGrid) return;

    // Automatically reveal all folders (remove Filester's artificial 5-folder cap)
    subGrid.querySelectorAll('.subfolder-item').forEach((item) => {
      if (item.style.display === 'none') item.style.display = 'flex';
    });
    const showAllBtn = document.getElementById('showAllFoldersBtn');
    if (showAllBtn) showAllBtn.style.display = 'none';

    ensureSubfolderToolbar();
    refreshSubfolders();
    observeSubfolders();
  }

  function observeSubfolders() {
    const subGrid = document.querySelector('#subfoldersGrid, .subfolders-grid');
    if (!subGrid || subfolderObserver) return;
    try {
      subfolderObserver = new MutationObserver((mutations) => {
        const hasExternalChanges = mutations.some(m => 
          [...m.addedNodes, ...m.removedNodes].some(n => 
            n.nodeType === Node.ELEMENT_NODE && !n.classList?.contains('nfw-subfolder-card')
          )
        );
        if (hasExternalChanges) refreshSubfolders();
      });
      subfolderObserver.observe(subGrid, { childList: true });
    } catch (_) {}
  }

  function refreshSubfolders() {
    const subGrid = document.querySelector('#subfoldersGrid, .subfolders-grid');
    if (!subGrid) return;

    // Unhide items if native script tried to re-hide them
    subGrid.querySelectorAll('.subfolder-item').forEach((item) => {
      if (item.style.display === 'none' && !folderSearchTerm) item.style.display = 'flex';
    });

    const cards = [...subGrid.querySelectorAll('.subfolder-item')];
    folderItems = cards.map(readSubfolderCard).filter(Boolean);

    for (const folder of folderItems) {
      injectSubfolderCardTools(folder);
    }

    applyFolderFiltersAndSort();
    syncSubfolderToolbar();
    syncFolderDock();

    // Fetch missing metadata in background
    fetchSubfoldersMetadata(folderItems);
  }

  function readSubfolderCard(el, index) {
    const href = el.getAttribute('href') || '';
    const slug = href.match(/\/f\/([A-Za-z0-9_-]+)/)?.[1] || '';
    if (!slug) return null;
    const title = (el.querySelector('.subfolder-name')?.textContent || '').trim();
    const metaText = (el.querySelector('.subfolder-meta')?.textContent || '').trim();
    const nativeFilesMatch = metaText.match(/(\d+)\s*files?/i);
    const nativeFilesCount = nativeFilesMatch ? Number(nativeFilesMatch[1]) : 0;
    const thumb = el.querySelector('.subfolder-thumb img')?.src || '';
    const url = new URL(href, location.origin).href;
    if (el.dataset.nfwFolderOriginalIndex == null) el.dataset.nfwFolderOriginalIndex = String(index);
    const originalIndex = Number(el.dataset.nfwFolderOriginalIndex);
    return { el, slug, title, nativeFilesCount, thumb, url, index: originalIndex };
  }

  function injectSubfolderCardTools(folder) {
    const { el, slug, title, url } = folder;
    el.classList.add('nfw-subfolder-card');

    const thumbWrap = el.querySelector('.subfolder-thumb') || el;

    // Checkbox wrap
    let checkWrap = el.querySelector('.nfw-folder-check-wrap');
    if (!checkWrap) {
      checkWrap = document.createElement('label');
      checkWrap.className = 'nfw-check-wrap nfw-folder-check-wrap';
      checkWrap.title = 'Označiť priečinok pre zlúčenie / akcie';
      checkWrap.innerHTML = '<input class="nfw-check nfw-folder-check" type="checkbox"><span></span>';
      stopCardClick(checkWrap);
      thumbWrap.appendChild(checkWrap);

      const checkbox = checkWrap.querySelector('input');
      checkbox.addEventListener('change', () => {
        checkbox.checked ? selectedFolders.add(slug) : selectedFolders.delete(slug);
        el.classList.toggle('nfw-selected', checkbox.checked);
        syncFolderDock();
        syncSubfolderToolbar();
      });
    }
    const checkbox = checkWrap.querySelector('input');
    checkbox.checked = selectedFolders.has(slug);
    el.classList.toggle('nfw-selected', checkbox.checked);
    bindCtrlCardSelection(el, checkbox);

    // Clicking thumb toggles selection
    if (thumbWrap && !thumbWrap.dataset.nfwSelectBound) {
      thumbWrap.dataset.nfwSelectBound = '1';
      thumbWrap.classList.add('nfw-select-thumb');
      thumbWrap.title = 'Kliknutím na náhľad označíš priečinok (klik na názov otvorí priečinok)';
      thumbWrap.addEventListener('click', (event) => {
        if (event.target.closest('.nfw-folder-check-wrap, .nfw-folder-open-btn')) return;
        event.preventDefault();
        event.stopPropagation();
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      }, true);
    }

    // Direct open button overlay
    let openBtn = el.querySelector('.nfw-folder-open-btn');
    if (!openBtn) {
      openBtn = document.createElement('a');
      openBtn.href = url;
      openBtn.className = 'nfw-folder-open-btn';
      openBtn.title = `Otvoriť priečinok "${title}"`;
      openBtn.setAttribute('aria-label', `Otvoriť ${title}`);
      openBtn.innerHTML = '↗';
      stopCardClick(openBtn);
      thumbWrap.appendChild(openBtn);
    }

    // Remove any duplicate thumbnail badge if present
    el.querySelector('.nfw-folder-badge')?.remove();

    // Rich meta under thumb
    let metaEl = el.querySelector('.nfw-folder-meta');
    if (!metaEl) {
      const nativeMeta = el.querySelector('.subfolder-meta');
      metaEl = document.createElement('div');
      metaEl.className = 'subfolder-meta nfw-folder-meta';
      if (nativeMeta) {
        nativeMeta.replaceWith(metaEl);
      } else {
        el.querySelector('.subfolder-info')?.appendChild(metaEl);
      }
    }

    paintSubfolderCard(folder, metaEl);
  }

  function paintSubfolderCard(folder, metaEl) {
    const meta = folderMetadata[folder.slug] || {};
    const filesCount = Math.max(meta.filesCount || 0, folder.nativeFilesCount || 0);
    const totalPages = Number(meta.totalPages || (filesCount > 24 ? Math.ceil(filesCount / 24) : 1));

    // Meta row under thumbnail: clean, informative, no duplicate size
    const parts = [];
    const pagesInfo = totalPages > 1 ? ` <span class="nfw-fmeta-pages">(${totalPages} str.)</span>` : '';
    parts.push(`<span class="nfw-fmeta-item nfw-fmeta-files" title="${filesCount} súborov${totalPages > 1 ? ` na ${totalPages} stranách` : ''}">📄 <strong>${filesCount}</strong> súb.${pagesInfo}</span>`);

    if (meta.size) {
      parts.push(`<span class="nfw-fmeta-item nfw-fmeta-size" title="Celková veľkosť: ${meta.size}">💾 <strong>${escapeHtml(meta.size)}</strong></span>`);
    } else {
      parts.push(`<span class="nfw-fmeta-item nfw-fmeta-loading">💾 načítavam…</span>`);
    }

    if (meta.latestUpload) {
      const dateTs = parseUploadTime(meta.latestUpload);
      if (dateTs) {
        const formatted = new Intl.DateTimeFormat('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(dateTs);
        parts.push(`<span class="nfw-fmeta-item nfw-fmeta-date" title="Posledný upload súboru: ${formatted}">🕒 ${formatted}</span>`);
      }
    } else if (meta.created) {
      parts.push(`<span class="nfw-fmeta-item nfw-fmeta-created" title="Vytvorené: ${escapeHtml(meta.created)}">📅 ${escapeHtml(meta.created)}</span>`);
    }

    metaEl.innerHTML = parts.join('');
  }

  async function fetchSubfoldersMetadata(folders, force = false) {
    const queue = folders.filter((f) => force || !folderMetadata[f.slug]?.size || !folderMetadata[f.slug]?.totalPages);
    if (!queue.length) return;

    await mapWithLimit(queue, 3, async (folder) => {
      try {
        const resp = await fetch(folder.url, { credentials: 'same-origin' });
        if (!resp.ok) return;
        const html = await resp.text();

        const sizeMatch = html.match(/Total size<\/span>\s*<span[^>]*>([^<]+)<\/span>/i) ||
                          html.match(/<span class="tnum">([\d.]+\s*(?:B|KB|MB|GB|TB))<\/span>/i);
        const size = sizeMatch ? sizeMatch[1].trim() : '';

        const createdMatch = html.match(/Created\s+([A-Za-z]{3}\s+\d{1,2},\s+\d{4})/i) ||
                             html.match(/Created<\/span>\s*<span>([^<]+)<\/span>/i);
        const created = createdMatch ? createdMatch[1].trim() : '';

        const dates = Array.from(html.matchAll(/data-date="([^"]+)"/g), (m) => m[1]).filter(Boolean).sort().reverse();
        const latestUpload = dates[0] || '';

        const types = Array.from(html.matchAll(/data-type="([^"]+)"/g), (m) => m[1]);
        const filesMatch = html.match(/Files<\/span>\s*<span[^>]*class="tnum"[^>]*>(\d+)<\/span>/i) ||
                           html.match(/<span class="tnum">(\d+)\s*files?<\/span>/i) ||
                           html.match(/id="fileCountDisplay"[^>]*>\s*\((\d+)\)\s*<\/span>/i) ||
                           html.match(/(\d+)\s*files/i);

        const totalPagesMatch = html.match(/data-total="(\d+)"/i) ||
                                html.match(/Page\s+\d+\s*\/\s*(\d+)/i) ||
                                html.match(/(\d+)\s*pages?/i);

        const parsedFiles = filesMatch ? Number(filesMatch[1]) : 0;
        const filesCount = Math.max(parsedFiles, folder.nativeFilesCount || 0, types.length);
        const totalPages = totalPagesMatch ? Number(totalPagesMatch[1]) : (filesCount > 24 ? Math.ceil(filesCount / 24) : 1);
        const videoCount = types.filter((t) => t === 'videos').length;

        folderMetadata[folder.slug] = {
          size,
          sizeBytes: parseSizeBytes(size),
          created,
          latestUpload,
          filesCount,
          totalPages,
          videoCount,
          ts: Date.now(),
        };

        const metaEl = folder.el.querySelector('.nfw-folder-meta');
        if (metaEl) paintSubfolderCard(folder, metaEl);

        persistFolderMetadata();
        syncSubfolderToolbar();
        syncFolderDock();
      } catch (err) {
        console.warn('[Filester Workspace] Folder meta fetch error:', folder.slug, err);
      }
    });
  }

  function persistFolderMetadata() {
    try {
      localStorage.setItem(FOLDER_META_KEY, JSON.stringify(trimMetadata(folderMetadata, 2000)));
    } catch (_) {}
  }

  function ensureSubfolderToolbar() {
    if (document.getElementById(FOLDER_TOOLBAR_ID)) return;
    const subGrid = document.querySelector('#subfoldersGrid, .subfolders-grid');
    if (!subGrid) return;

    const toolbar = document.createElement('div');
    toolbar.id = FOLDER_TOOLBAR_ID;
    toolbar.className = 'nfw-folder-toolbar';
    toolbar.innerHTML = `
      <div class="nfw-ft-left">
        <span class="nfw-ft-title">📁 Priečinky</span>
        <label class="nfw-ft-search"><span>⌕</span><input type="text" data-role="folderSearch" placeholder="Filtrovať priečinky…"></label>
        <select data-role="folderSort" title="Zoradenie priečinkov">
          <option value="native">Pôvodné poradie</option>
          <option value="name_asc">Názov A–Z</option>
          <option value="name_desc">Názov Z–A</option>
          <option value="size_desc">Najväčšia veľkosť ↓</option>
          <option value="size_asc">Najmenšia veľkosť ↑</option>
          <option value="files_desc">Najviac súborov ↓</option>
          <option value="date_desc">Najnovší upload ↓</option>
        </select>
      </div>
      <div class="nfw-ft-right">
        <button type="button" data-action="selectAllFolders">Označiť všetky</button>
        <button type="button" data-action="clearAllFolders">Zrušiť výber</button>
        <button type="button" data-action="refreshFolderMeta" title="Znova overiť veľkosti a dátumy">↻ Obnoviť</button>
        <span class="nfw-ft-stats" data-role="folderStats"></span>
      </div>
    `;

    subGrid.parentElement.insertBefore(toolbar, subGrid);

    const searchInput = toolbar.querySelector('[data-role="folderSearch"]');
    searchInput.addEventListener('input', () => {
      folderSearchTerm = searchInput.value.trim().toLowerCase();
      applyFolderFiltersAndSort();
    });

    const sortSelect = toolbar.querySelector('[data-role="folderSort"]');
    sortSelect.addEventListener('change', () => {
      folderSortMode = sortSelect.value;
      applyFolderFiltersAndSort();
    });

    toolbar.addEventListener('click', (event) => {
      const btn = event.target.closest('button');
      if (!btn) return;
      const act = btn.dataset.action;
      if (act === 'selectAllFolders') {
        for (const f of folderItems) {
          if (f.el.style.display !== 'none') selectedFolders.add(f.slug);
        }
        refreshSubfolders();
      } else if (act === 'clearAllFolders') {
        selectedFolders.clear();
        refreshSubfolders();
      } else if (act === 'refreshFolderMeta') {
        fetchSubfoldersMetadata(folderItems, true);
        toast('Aktualizujem informácie o priečinkoch…');
      }
    });

    syncSubfolderToolbar();
  }

  function syncSubfolderToolbar() {
    const toolbar = document.getElementById(FOLDER_TOOLBAR_ID);
    if (!toolbar) return;
    const statsEl = toolbar.querySelector('[data-role="folderStats"]');
    if (statsEl) {
      let totalBytes = 0;
      let totalFiles = 0;
      for (const f of folderItems) {
        const meta = folderMetadata[f.slug] || {};
        totalBytes += Number(meta.sizeBytes || 0);
        totalFiles += Number(meta.filesCount || f.nativeFilesCount || 0);
      }
      const sizeStr = totalBytes > 0 ? ` · ${formatBytes(totalBytes)}` : '';
      statsEl.textContent = `${folderItems.length} priečinkov · ${totalFiles} súborov${sizeStr}`;
    }
  }

  function applyFolderFiltersAndSort() {
    const subGrid = document.querySelector('#subfoldersGrid, .subfolders-grid');
    if (!subGrid) return;

    for (const f of folderItems) {
      const matches = !folderSearchTerm || f.title.toLowerCase().includes(folderSearchTerm);
      f.el.style.display = matches ? 'flex' : 'none';
    }

    if (folderSortMode === 'native') return;

    const copy = [...folderItems];
    const getSizeBytes = (f) => Number(folderMetadata[f.slug]?.sizeBytes || 0);
    const getFilesCount = (f) => Number(folderMetadata[f.slug]?.filesCount || f.nativeFilesCount || 0);
    const getDateTs = (f) => parseUploadTime(folderMetadata[f.slug]?.latestUpload || folderMetadata[f.slug]?.created || 0);

    const sorters = {
      name_asc: (a, b) => a.title.localeCompare(b.title),
      name_desc: (a, b) => b.title.localeCompare(a.title),
      size_desc: (a, b) => getSizeBytes(b) - getSizeBytes(a),
      size_asc: (a, b) => getSizeBytes(a) - getSizeBytes(b),
      files_desc: (a, b) => getFilesCount(b) - getFilesCount(a),
      date_desc: (a, b) => getDateTs(b) - getDateTs(a),
    };

    if (sorters[folderSortMode]) {
      copy.sort(sorters[folderSortMode]);
      for (const item of copy) {
        subGrid.appendChild(item.el);
      }
    }
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  }

  function ensureFolderDock() {
    if (folderDock) return folderDock;
    folderDock = document.createElement('div');
    folderDock.id = FOLDER_DOCK_ID;
    folderDock.className = 'nfw-folder-dock';
    folderDock.hidden = true;
    folderDock.innerHTML = `
      <div class="nfw-fd-summary">
        <span class="nfw-fd-icon">🗂</span>
        <div class="nfw-fd-text">
          <strong data-role="fdCount">0 priečinkov</strong>
          <small data-role="fdMeta">0 súborov · 0 GB</small>
        </div>
      </div>
      <div class="nfw-fd-actions">
        <button type="button" class="nfw-fd-btn nfw-fd-merge" data-action="dockMerge" title="Spojiť označené priečinky do jedného zoznamu tu na stránke">🗂 Zlúčiť na tejto stránke</button>
        <button type="button" class="nfw-fd-btn" data-action="dockNewTab" title="Otvoriť zlúčené priečinky v novom okne">⧉ V novom tabe</button>
        <button type="button" class="nfw-fd-btn" data-action="dockZip" title="Stiahnuť vybrané priečinky ako ZIP">⬇ Stiahnuť ZIP</button>
        <button type="button" class="nfw-fd-btn" data-action="dockSave" title="Hromadne uložiť vybrané priečinky do tvojho Filester účtu">💾 Uložiť do účtu</button>
        <button type="button" class="nfw-fd-close" data-action="dockClear" title="Zrušiť výber">✕</button>
      </div>
    `;

    document.body.appendChild(folderDock);

    folderDock.addEventListener('click', (event) => {
      const btn = event.target.closest('button');
      if (!btn) return;
      const act = btn.dataset.action;
      const slugs = [...selectedFolders];
      if (act === 'dockMerge') {
        activateMergedFolderView(slugs, { inPlace: true });
      } else if (act === 'dockNewTab') {
        window.open(`${location.origin}${location.pathname}#merge=${slugs.join(',')}`, '_blank');
      } else if (act === 'dockZip') {
        downloadSelectedFoldersZip(slugs);
      } else if (act === 'dockSave') {
        saveSelectedFoldersToAccount(slugs);
      } else if (act === 'dockClear') {
        selectedFolders.clear();
        refreshSubfolders();
      }
    });

    return folderDock;
  }

  function syncFolderDock() {
    const dock = ensureFolderDock();
    if (!dock) return;

    if (selectedFolders.size === 0 || isMergedMode) {
      dock.hidden = true;
      return;
    }

    dock.hidden = false;
    const countEl = dock.querySelector('[data-role="fdCount"]');
    const metaEl = dock.querySelector('[data-role="fdMeta"]');

    let totalFiles = 0;
    let totalBytes = 0;
    for (const slug of selectedFolders) {
      const item = folderItems.find((f) => f.slug === slug);
      const meta = folderMetadata[slug] || {};
      totalFiles += Number(meta.filesCount || item?.nativeFilesCount || 0);
      totalBytes += Number(meta.sizeBytes || 0);
    }

    if (countEl) countEl.textContent = `${selectedFolders.size} vybraných priečinkov`;
    if (metaEl) {
      const sizeStr = totalBytes > 0 ? ` · ${formatBytes(totalBytes)}` : '';
      metaEl.textContent = `${totalFiles} súborov${sizeStr}`;
    }
  }

  async function activateMergedFolderView(slugs, { inPlace = true } = {}) {
    if (!slugs.length) return;
    grid = findFileGrid() || grid;
    if (!grid) {
      toast('Nepodarilo sa nájsť cieľovú mriežku pre zlúčený album.', true);
      return;
    }

    isMergedMode = true;
    activeMergedFolderFilter = 'all';
    syncFolderDock();

    // Backup original files and subfolders display
    if (originalFilesGridBackup == null) {
      originalFilesGridBackup = grid.innerHTML;
    }
    const subSection = document.querySelector('#subfoldersGrid, .subfolders-grid')?.closest('section');
    if (subSection && !originalSubfoldersSectionDisplay) {
      originalSubfoldersSectionDisplay = subSection.style.display || '';
      subSection.style.display = 'none';
    }
    document.querySelectorAll('.files-section .pagination, main .pagination').forEach((el) => {
      el.classList.add('nfw-orig-pagination-hidden');
    });

    // Update URL hash
    if (inPlace) {
      try {
        history.replaceState(null, '', `${location.pathname}${location.search}#merge=${slugs.join(',')}`);
      } catch (_) {}
    }

    // Prepare banner
    ensureMergedBanner(slugs);

    // Show loading state
    grid.innerHTML = `
      <div class="nfw-merged-loading">
        <div class="nfw-merged-spinner"></div>
        <p>Načítavam súbory zo ${slugs.length} vybraných priečinkov…</p>
      </div>
    `;

    setMergedProgress(10, `Pripravujem priečinky (0/${slugs.length})…`);

    mergedFoldersInfo = [];
    const loadedCards = [];
    let processed = 0;

    await mapWithLimit(slugs, 3, async (slug) => {
      const existingFolder = folderItems.find((f) => f.slug === slug);
      let folderTitle = existingFolder?.title || '';
      let totalPages = 1;

      try {
        const resp = await fetch(`/f/${slug}`, { credentials: 'same-origin' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const html = await resp.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');

        if (!folderTitle) {
          folderTitle = doc.querySelector('h1')?.textContent?.trim() || slug;
        }

        const totalPagesAttr = doc.querySelector('#loadAllPagesBtn')?.getAttribute('data-total');
        if (totalPagesAttr) totalPages = parseInt(totalPagesAttr, 10) || 1;

        const fileItems = [...doc.querySelectorAll('#filesGrid .file-item, .files-list .file-item')];

        for (const item of fileItems) {
          item.dataset.folderSlug = slug;
          item.dataset.folderName = folderTitle;

          // Inject origin badge into file-info
          const info = item.querySelector('.file-info');
          if (info && !item.querySelector('.nfw-origin-badge')) {
            const originBadge = document.createElement('span');
            originBadge.className = 'nfw-origin-badge';
            originBadge.title = `Zdrojový priečinok: ${folderTitle}`;
            originBadge.textContent = `📁 ${folderTitle}`;
            info.appendChild(originBadge);
          }

          loadedCards.push(item);
        }

        // If there are multiple pages, automatically load all pages for this folder
        if (totalPages > 1) {
          for (let p = 2; p <= totalPages; p++) {
            setMergedProgress(
              Math.min(95, Math.round(((processed + (p / totalPages)) / slugs.length) * 85)),
              `Načítavam ${folderTitle} (${p}/${totalPages} strán)…`
            );
            try {
              const pResp = await fetch(`/f/${slug}?page=${p}`, { credentials: 'same-origin' });
              if (pResp.ok) {
                const pHtml = await pResp.text();
                const pDoc = new DOMParser().parseFromString(pHtml, 'text/html');
                const pItems = [...pDoc.querySelectorAll('#filesGrid .file-item, .files-list .file-item')];
                for (const item of pItems) {
                  item.dataset.folderSlug = slug;
                  item.dataset.folderName = folderTitle;
                  const info = item.querySelector('.file-info');
                  if (info && !item.querySelector('.nfw-origin-badge')) {
                    const originBadge = document.createElement('span');
                    originBadge.className = 'nfw-origin-badge';
                    originBadge.title = `Zdrojový priečinok: ${folderTitle}`;
                    originBadge.textContent = `📁 ${folderTitle}`;
                    info.appendChild(originBadge);
                  }
                  loadedCards.push(item);
                }
              }
            } catch (pErr) {
              console.warn('[Filester Workspace] Error loading page', p, 'for folder', slug, pErr);
            }
          }
        }

        const totalLoadedForFolder = loadedCards.filter((c) => c.dataset.folderSlug === slug).length;
        mergedFoldersInfo.push({
          slug,
          title: folderTitle,
          count: totalLoadedForFolder,
          totalPages,
          loadedPages: totalPages,
        });
      } catch (err) {
        console.warn('[Filester Workspace] Merged view failed loading slug:', slug, err);
        mergedFoldersInfo.push({ slug, title: folderTitle || slug, count: 0, totalPages: 1, loadedPages: 1 });
      } finally {
        processed += 1;
        setMergedProgress(Math.round((processed / slugs.length) * 80), `Načítané ${processed}/${slugs.length} priečinkov`);
      }
    });

    grid.innerHTML = '';
    for (const card of loadedCards) {
      grid.appendChild(card);
    }

    setMergedProgress(null);
    refresh();
    updateMergedBannerChips();
    toast(`Zlúčených ${loadedCards.length} súborov zo ${slugs.length} priečinkov.`);
  }

  function ensureMergedBanner(slugs) {
    let banner = document.getElementById(MERGED_BANNER_ID);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = MERGED_BANNER_ID;
      banner.className = 'nfw-merged-banner';
      banner.innerHTML = `
        <div class="nfw-mb-top">
          <div class="nfw-mb-title-wrap">
            <span class="nfw-mb-icon">🗂</span>
            <strong>Zlúčený album</strong>
            <span class="nfw-mb-pill" data-role="mbPill">${slugs.length} priečinkov</span>
            <span class="nfw-mb-stats" data-role="mbStats">Pripravujem…</span>
          </div>
          <div class="nfw-mb-actions">
            <button type="button" class="nfw-mb-btn" data-action="mergedLoadAllPages" title="Načítať zostávajúce strany všetkých spojených priečinkov">Načítať všetky strany</button>
            <button type="button" class="nfw-mb-btn" data-action="mergedNewTab" title="Otvoriť toto zlúčenie v novom tabe">⧉ V novom tabe</button>
            <button type="button" class="nfw-mb-btn nfw-mb-close" data-action="mergedExit" title="Vrátiť sa k pôvodnému albumu">← Späť na priečinky</button>
          </div>
        </div>
        <div class="nfw-mb-chips" data-role="mbChips"></div>
        <div class="nfw-progress" data-role="mbProgress" hidden><i></i><span></span></div>
      `;

      grid.parentElement.insertBefore(banner, grid);

      banner.addEventListener('click', (event) => {
        const btn = event.target.closest('button');
        if (btn) {
          const act = btn.dataset.action;
          if (act === 'mergedExit') exitMergedFolderView();
          else if (act === 'mergedNewTab') {
            const currentSlugs = mergedFoldersInfo.map((f) => f.slug);
            window.open(`${location.origin}${location.pathname}#merge=${currentSlugs.join(',')}`, '_blank');
          } else if (act === 'mergedLoadAllPages') {
            loadAllMergedPages();
          }
          return;
        }

        const chip = event.target.closest('.nfw-folder-chip');
        if (chip) {
          const filterSlug = chip.dataset.filterSlug || 'all';
          activeMergedFolderFilter = filterSlug;
          updateMergedBannerChips();
          applySortAndFilters();
        }
      });
    }

    return banner;
  }

  function updateMergedBannerChips() {
    const banner = document.getElementById(MERGED_BANNER_ID);
    if (!banner) return;

    const pill = banner.querySelector('[data-role="mbPill"]');
    if (pill) pill.textContent = `${mergedFoldersInfo.length} priečinkov`;

    const stats = banner.querySelector('[data-role="mbStats"]');
    if (stats) {
      const totalFiles = items.length;
      let totalBytes = 0;
      for (const it of items) totalBytes += Number(it.sizeBytes || 0);
      stats.textContent = `${totalFiles} súborov · ${formatBytes(totalBytes)}`;
    }

    const chipsWrap = banner.querySelector('[data-role="mbChips"]');
    if (chipsWrap) {
      const totalCount = items.length;
      let html = `<span class="nfw-folder-chip ${activeMergedFolderFilter === 'all' ? 'is-active' : ''}" data-filter-slug="all">Všetky súbory (${totalCount})</span>`;
      for (const info of mergedFoldersInfo) {
        const count = items.filter((it) => it.folderSlug === info.slug).length;
        const isActive = activeMergedFolderFilter === info.slug ? 'is-active' : '';
        html += `<span class="nfw-folder-chip ${isActive}" data-filter-slug="${escapeHtml(info.slug)}">📁 ${escapeHtml(info.title)} (${count})</span>`;
      }
      chipsWrap.innerHTML = html;
    }
  }

  async function loadAllMergedPages() {
    const banner = document.getElementById(MERGED_BANNER_ID);
    const loadAllBtn = banner?.querySelector('[data-action="mergedLoadAllPages"]');
    if (loadAllBtn) loadAllBtn.disabled = true;

    const targets = mergedFoldersInfo.filter((f) => f.totalPages > f.loadedPages);
    if (!targets.length) {
      toast('Všetky strany vybraných priečinkov sú už načítané.');
      if (loadAllBtn) loadAllBtn.disabled = false;
      return;
    }

    toast(`Načítavam ďalšie strany pre ${targets.length} priečinkov…`);
    let addedFiles = 0;

    for (const folder of targets) {
      for (let p = folder.loadedPages + 1; p <= folder.totalPages; p++) {
        setMergedProgress(50, `Načítavam ${folder.title} (strana ${p}/${folder.totalPages})…`);
        try {
          const resp = await fetch(`/f/${folder.slug}?page=${p}`, { credentials: 'same-origin' });
          if (!resp.ok) continue;
          const html = await resp.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const fileItems = [...doc.querySelectorAll('#filesGrid .file-item, .files-list .file-item')];

          for (const item of fileItems) {
            item.dataset.folderSlug = folder.slug;
            item.dataset.folderName = folder.title;
            const info = item.querySelector('.file-info');
            if (info && !item.querySelector('.nfw-origin-badge')) {
              const originBadge = document.createElement('span');
              originBadge.className = 'nfw-origin-badge';
              originBadge.title = `Zdrojový priečinok: ${folder.title}`;
              originBadge.textContent = `📁 ${folder.title}`;
              info.appendChild(originBadge);
            }
            grid.appendChild(item);
            addedFiles += 1;
          }
          folder.loadedPages = p;
        } catch (err) {
          console.warn('[Filester Workspace] Error loading page', p, 'for folder', folder.slug, err);
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    setMergedProgress(null);
    if (loadAllBtn) loadAllBtn.disabled = false;
    refresh();
    updateMergedBannerChips();
    toast(`Načítanie dokončené: pridaných ${addedFiles} súborov.`);
  }

  function setMergedProgress(percent, text = '') {
    const banner = document.getElementById(MERGED_BANNER_ID);
    const row = banner?.querySelector('[data-role="mbProgress"]');
    if (!row) return;
    row.hidden = percent == null;
    if (percent != null) {
      row.querySelector('i').style.width = `${Math.max(2, percent)}%`;
      row.querySelector('span').textContent = text;
    }
  }

  function exitMergedFolderView() {
    isMergedMode = false;
    activeMergedFolderFilter = 'all';

    // Remove hash
    try {
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    } catch (_) {}

    // Remove banner
    document.getElementById(MERGED_BANNER_ID)?.remove();

    // Restore subfolders section
    const subSection = document.querySelector('#subfoldersGrid, .subfolders-grid')?.closest('section');
    if (subSection) {
      subSection.style.display = originalSubfoldersSectionDisplay || '';
    }

    // Restore pagination
    document.querySelectorAll('.nfw-orig-pagination-hidden').forEach((el) => {
      el.classList.remove('nfw-orig-pagination-hidden');
    });

    // Restore files grid
    if (originalFilesGridBackup != null && grid) {
      grid.innerHTML = originalFilesGridBackup;
    }

    refresh();
    syncFolderDock();
    toast('Zlúčený pohľad ukončený. Pôvodné zobrazenie obnovené.');
  }

  function checkMergedHashOnBoot() {
    if (isManagerPage()) return;
    const hash = location.hash || '';
    const match = hash.match(/#merge=([A-Za-z0-9_,-]+)/);
    if (match) {
      const slugs = match[1].split(',').filter(Boolean);
      if (slugs.length) {
        window.setTimeout(() => {
          activateMergedFolderView(slugs, { inPlace: true });
        }, 300);
      }
    }
  }

  async function downloadSelectedFoldersZip(slugs) {
    if (!slugs.length) return;
    toast(`Spúšťam sťahovanie ZIP pre ${slugs.length} priečinkov…`);

    for (let i = 0; i < slugs.length; i++) {
      const slug = slugs[i];
      const folder = folderItems.find((f) => f.slug === slug);
      const title = folder?.title || slug;
      toast(`Generujem ZIP pre "${title}" (${i + 1}/${slugs.length})…`);

      try {
        const resp = await fetch('/api/folder/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier: slug }),
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok && data.success && data.data?.download_url) {
          const link = document.createElement('a');
          link.href = data.data.download_url;
          link.download = `${title}.zip`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        } else {
          throw new Error(data.message || `Server ${resp.status}`);
        }
      } catch (err) {
        toast(`Chyba pri sťahovaní "${title}": ${err.message}`, true);
      }

      if (i < slugs.length - 1) {
        await new Promise((r) => setTimeout(r, 1800));
      }
    }

    toast('Sťahovanie ZIP dokončené.');
  }

  async function saveSelectedFoldersToAccount(slugs) {
    if (!slugs.length) return;
    const choice = await promptTargetAlbum(slugs.length);
    if (!choice) return;

    const destName = choice.name || 'Album';
    toast(`Zisťujem súbory zo ${slugs.length} priečinkov na uloženie do "${destName}"…`);

    const fileSlugs = [];
    for (const slug of slugs) {
      try {
        const resp = await fetch(`/f/${slug}`, { credentials: 'same-origin' });
        if (!resp.ok) continue;
        const html = await resp.text();
        const matches = Array.from(html.matchAll(/\/d\/([A-Za-z0-9_-]+)/g), (m) => m[1]);
        for (const s of matches) {
          if (!fileSlugs.includes(s)) fileSlugs.push(s);
        }
      } catch (e) {
        console.warn('[Filester Workspace] Save folders error fetching files:', slug, e);
      }
    }

    if (!fileSlugs.length) {
      toast('Nenašli sa žiadne súbory na uloženie.', true);
      return;
    }

    setProgress(0, `Ukladám ${fileSlugs.length} súborov do "${destName}"…`);
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < fileSlugs.length; i++) {
      const s = fileSlugs[i];
      await new Promise((r) => setTimeout(r, 150));
      try {
        const body = { slug: s };
        if (!choice.isRoot && choice.numericId) body.folder_id = choice.numericId;
        const resp = await fetch('/api/file/save', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok && data.success !== false) succeeded++;
        else failed++;
      } catch (_) {
        failed++;
      }
      setProgress(Math.round(((i + 1) / fileSlugs.length) * 100), `Uložené ${i + 1}/${fileSlugs.length}`);
    }

    setProgress(null);
    toast(`Hotovo: ${succeeded} súborov uložených do "${destName}"${failed > 0 ? `, ${failed} zlyhalo` : ''}.`, failed === fileSlugs.length);
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      :root{--nfw-bg:#101319;--nfw-surface:#171b23;--nfw-surface2:#202631;--nfw-border:#303846;--nfw-text:#edf2f7;--nfw-muted:#9aa6b5;--nfw-accent:#8b5cf6;--nfw-green:#35d07f;--nfw-card-min:290px;--nfw-thumb-ratio:16/9}
      body.nfw-active .nfw-native-manager-grid{display:grid!important;grid-template-columns:repeat(auto-fill,minmax(min(var(--nfw-card-min),100%),1fr))!important;gap:16px!important}
      body.nfw-active.nfw-manager-compact:not(.nfw-show-native) .nfw-shell>header,body.nfw-active.nfw-manager-compact:not(.nfw-show-native) #siteAnnouncements{display:none!important}
      body.nfw-active.nfw-manager-compact main.file-manager-container{padding-top:12px!important;max-width:none!important;display:flex;flex-direction:column;gap:10px!important}
      body.nfw-active.nfw-manager-compact main.file-manager-container> *{margin-top:0!important}
      body.nfw-active.nfw-manager-compact .content-header{gap:8px!important;min-height:0!important}
      body.nfw-active.nfw-manager-compact #foldersSection{padding:0!important}
      body.nfw-active.nfw-manager-compact #foldersSection:has(.empty-state):not(:has(.folder-card)){display:none!important}
      body.nfw-active.nfw-manager-compact .nfw-loaded-card>a{display:block;width:100%;color:inherit;text-decoration:none}
      body.nfw-active.nfw-manager-compact .nfw-loaded-card .file-name{display:block;padding:8px;overflow-wrap:anywhere}
      body.nfw-active.nfw-manager-compact #${TOOLBAR_ID} .nfw-head{padding:6px 10px!important}
      body.nfw-active.nfw-manager-compact #${TOOLBAR_ID} .nfw-body{padding:8px 10px!important}
      body.nfw-active .nfw-native-manager-grid>.file-card{min-width:0!important;width:100%!important;height:auto!important}
      body.nfw-active .nfw-native-manager-grid .file-preview{position:relative;width:100%!important;height:auto!important;aspect-ratio:var(--nfw-thumb-ratio)!important}
      body.nfw-active .nfw-native-manager-grid .file-preview img{width:100%!important;height:100%!important;object-fit:cover!important}
      body.nfw-active .nfw-native-manager-grid>.nfw-hidden{display:none!important}
      body.nfw-active{padding-top:14px!important;padding-bottom:20px!important}
      body.nfw-active>header{display:none!important}
      /* Filester's new centered/max-width wrapper can constrain the old 94vw
         width. Center the workspace against the viewport so it can break out. */
      body.nfw-active .nfw-shell{position:relative!important;left:50%!important;transform:translateX(-50%)!important;width:96vw!important;max-width:none!important;margin-inline:0!important;padding-inline:0!important;box-sizing:border-box!important}
      body.nfw-active .nfw-shell>main{width:100%!important;max-width:none!important;margin-inline:0!important;padding-inline:0!important}
      body.nfw-active .folder-header,body.nfw-active .filters-bar,body.nfw-active .folder-tools,body.nfw-active .files-section{width:100%!important;max-width:none!important}
      body.nfw-active .folder-header{margin-bottom:18px!important;padding-bottom:14px!important}body.nfw-active .filters-bar{margin-bottom:12px!important;padding:12px!important}body.nfw-active .folder-tools{margin:8px 0 10px!important}body.nfw-active .files-section{margin-top:14px!important}body.nfw-active .section-header{margin-bottom:8px!important;padding-bottom:8px!important}
      #${UTILITY_NAV_ID}{display:flex;align-items:center;justify-content:flex-end;min-height:32px;margin:0 0 6px;padding:5px 10px;border:1px solid rgba(255,255,255,.09);border-radius:9px;background:rgba(14,17,23,.72);font:11px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif}
      #${UTILITY_NAV_ID} nav{width:100%;margin:0!important}#${UTILITY_NAV_ID} nav>div{justify-content:flex-end!important;gap:11px!important}#${UTILITY_NAV_ID} a{color:#aeb8c6!important;text-decoration:none}#${UTILITY_NAV_ID} a:hover{color:#fff!important}#${UTILITY_NAV_ID} #notifBell{color:#aeb8c6}
      body.nfw-active #filesGrid.grid-view,body.nfw-active #filesGrid,body.nfw-active .files-list,body.nfw-active .nfw-manager-grid{display:grid!important;grid-template-columns:repeat(auto-fill,minmax(min(var(--nfw-card-min),100%),1fr))!important;gap:16px!important;width:100%!important;align-items:stretch!important}
      body.nfw-active #filesGrid>.file-item,body.nfw-active .files-list>.file-item,body.nfw-active .nfw-manager-grid>.file-item{width:100%!important;max-width:none!important;min-width:0!important;height:auto!important;margin:0!important;display:flex!important;box-sizing:border-box!important}
      body.nfw-active #filesGrid>.file-item .file-preview,body.nfw-active .files-list>.file-item .file-preview,body.nfw-active .nfw-manager-grid>.file-item .file-preview{width:100%!important;aspect-ratio:var(--nfw-thumb-ratio)!important;height:auto!important;min-height:0!important;overflow:hidden!important;background:#080a0e!important}
      body.nfw-active #filesGrid>.file-item .file-preview img,body.nfw-active .files-list>.file-item .file-preview img,body.nfw-active .nfw-manager-grid>.file-item .file-preview img{width:100%!important;height:100%!important;object-fit:cover!important;transition:transform .22s ease!important}
      body.nfw-active #filesGrid>.file-item:hover .file-preview img,body.nfw-active .files-list>.file-item:hover .file-preview img,body.nfw-active .nfw-manager-grid>.file-item:hover .file-preview img{transform:scale(1.035)}
      .nfw-card{position:relative!important;border-radius:12px!important;overflow:hidden!important;transition:border-color .15s,box-shadow .15s,opacity .15s,transform .15s!important}
      .nfw-card:hover{transform:translateY(-2px)!important;box-shadow:0 12px 28px rgba(0,0,0,.38)!important}
      .nfw-card.nfw-selected{outline:3px solid var(--nfw-green)!important;outline-offset:-3px!important;box-shadow:0 0 0 1px rgba(53,208,127,.35),0 12px 30px rgba(0,0,0,.4)!important}
      .nfw-card.nfw-reviewed:not(.nfw-selected){filter:saturate(.72)}
      .nfw-card.nfw-dim{opacity:.22!important;filter:grayscale(.55)!important}
      /* More specific than the grid's forced display:flex rule above. */
      body.nfw-active #filesGrid>.file-item.nfw-hidden,body.nfw-active .files-list>.file-item.nfw-hidden,body.nfw-active .nfw-manager-grid>.file-item.nfw-hidden{display:none!important}
      .nfw-check-wrap{position:absolute;top:9px;left:9px;z-index:30;width:27px;height:27px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.26);border-radius:8px;background:rgba(8,10,14,.78);backdrop-filter:blur(7px);cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.35)}
      .nfw-check-wrap input{position:absolute;opacity:0;pointer-events:none}.nfw-check-wrap span{width:13px;height:13px;border:2px solid #d7dee9;border-radius:4px;box-sizing:border-box}.nfw-check-wrap input:checked+span{border-color:var(--nfw-green);background:var(--nfw-green);box-shadow:inset 0 0 0 2px #14251c}
      .nfw-select-preview{position:relative!important;cursor:pointer}.nfw-select-preview:focus-visible{outline:3px solid var(--nfw-accent);outline-offset:-3px}.nfw-play{position:absolute!important;left:50%;top:50%;z-index:32;width:52px;height:52px;display:grid;place-items:center;transform:translate(-50%,-50%);border:1px solid rgba(255,255,255,.72);border-radius:50%;background:rgba(8,10,14,.78);color:#fff;font:700 22px/1 system-ui;cursor:pointer;box-shadow:0 5px 18px rgba(0,0,0,.48);backdrop-filter:blur(7px);transition:transform .14s,background .14s}.nfw-play:hover{transform:translate(-50%,-50%) scale(1.09);background:rgba(91,33,182,.96)}.nfw-play[hidden]{display:none!important}.nfw-split-play{position:absolute!important;left:8px;bottom:8px;z-index:33;width:34px;height:34px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.72);border-radius:9px;background:rgba(8,10,14,.82);color:#fff;font:700 18px/1 system-ui;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.4)}.nfw-split-play:hover{background:rgba(91,33,182,.96)}.nfw-split-play[hidden]{display:none!important}
      .nfw-review{position:absolute;right:8px;bottom:8px;z-index:31;width:27px;height:27px;border:1px solid rgba(255,255,255,.18);border-radius:50%;background:rgba(8,10,14,.8);color:#d8e0eb;font:700 15px/1 system-ui;cursor:pointer;backdrop-filter:blur(7px)}
      .nfw-reviewed .nfw-review{border-color:rgba(53,208,127,.7);background:rgba(21,128,61,.9);color:white}
      .nfw-meta-badge{position:absolute;top:9px;right:9px;z-index:28;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px;max-width:calc(100% - 52px);pointer-events:none}
      .nfw-meta-badge .nfw-upload-date{margin-left:auto}
      .nfw-meta-badge[hidden]{display:none}.nfw-meta-badge span{padding:4px 6px;border-radius:6px;background:rgba(6,8,12,.84);color:#fff;font:700 10px/1.1 system-ui;box-shadow:0 2px 8px rgba(0,0,0,.35)}
      .nfw-meta-badge .is-hq{background:rgba(21,128,61,.94)}.nfw-meta-badge .is-ok{background:rgba(161,98,7,.94)}.nfw-meta-badge .is-low{background:rgba(185,28,28,.94)}
      .nfw-card.nfw-duplicate-card{outline:2px dashed rgba(239,68,68,.65)!important;outline-offset:-2px!important}
      .nfw-dash-badge{background:linear-gradient(135deg,#065f46,#059669)!important;color:#fff!important;font-weight:700!important;border:1px solid rgba(52,211,153,.45)!important;box-shadow:0 2px 8px rgba(5,150,105,.35)!important;letter-spacing:.02em}
      .nfw-card.nfw-in-dashboard{border-color:rgba(16,185,129,.45)!important}
      .nfw-card.nfw-in-dashboard::before{content:'';position:absolute;top:0;right:0;width:0;height:0;border-top:14px solid #10b981;border-left:14px solid transparent;z-index:27;pointer-events:none}
      .nfw-stat-dashboard{color:#6ee7b7;font-weight:700}
      .nfw-dupe-tag{background:rgba(220,38,38,.92)!important;color:#fff!important;font-weight:700!important}
      .nfw-dupe-winner-tag{background:linear-gradient(135deg,#15803d,#16a34a)!important;color:#fff!important;font-weight:700!important;box-shadow:0 2px 8px rgba(22,163,74,.35)!important}
      .nfw-dupe-toggle-btn{background:transparent;border:1px dashed rgba(245,158,11,.45);color:#f59e0b;padding:2px 7px;border-radius:6px;font:inherit;cursor:pointer;margin:0 2px;transition:.15s}
      .nfw-dupe-toggle-btn:hover{background:rgba(245,158,11,.15);border-color:#f59e0b;color:#fde68a}
      .nfw-dupe-toggle-btn.is-active{background:rgba(239,68,68,.18);border-color:#ef4444;color:#fca5a5}
      #${TOOLBAR_ID}{position:sticky;top:8px;z-index:1000;margin:6px 0 10px;border:1px solid var(--nfw-border);border-radius:14px;background:rgba(16,19,25,.96);color:var(--nfw-text);box-shadow:0 12px 35px rgba(0,0,0,.4);backdrop-filter:blur(16px);font:12px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif}
      #${TOOLBAR_ID} *{box-sizing:border-box}#${TOOLBAR_ID} .nfw-head{display:flex;align-items:center;gap:12px;padding:9px 12px;border-bottom:1px solid var(--nfw-border)}
      #${TOOLBAR_ID} .nfw-brand{display:flex;align-items:center;gap:9px;min-width:205px}#${TOOLBAR_ID} .nfw-brand>div{display:grid}#${TOOLBAR_ID} .nfw-brand strong{font-size:13px}#${TOOLBAR_ID} .nfw-brand small{color:var(--nfw-muted);font-size:10px}
      #${TOOLBAR_ID} .nfw-logo{width:28px;height:28px;display:grid;place-items:center;border-radius:9px;background:linear-gradient(135deg,#7c3aed,#22c55e);font-weight:900;color:white}
      #${TOOLBAR_ID} .nfw-status{display:flex;align-items:center;gap:6px;margin-left:auto;color:var(--nfw-muted);font-size:10.5px}#${TOOLBAR_ID} .nfw-status i{width:8px;height:8px;border-radius:50%;background:#eab308}#${TOOLBAR_ID} .nfw-status i.online{background:#22c55e}#${TOOLBAR_ID} .nfw-status i.offline{background:#ef4444}
      #${TOOLBAR_ID} button,#${TOOLBAR_ID} select,#${TOOLBAR_ID} input{border:1px solid var(--nfw-border);border-radius:7px;background:#0d1016;color:var(--nfw-text);font:inherit;outline:none}#${TOOLBAR_ID} button{padding:6px 9px;cursor:pointer;transition:.12s}#${TOOLBAR_ID} button:hover{border-color:var(--nfw-accent);background:var(--nfw-surface2)}#${TOOLBAR_ID} button.is-on{border-color:#a78bfa;background:#5b21b6;color:#fff}#${TOOLBAR_ID} button:disabled{opacity:.45;cursor:default}
      #${TOOLBAR_ID} .nfw-icon{padding:2px 8px;font-size:18px;background:transparent}#${TOOLBAR_ID} .nfw-body{display:grid;gap:8px;padding:10px 12px}#${TOOLBAR_ID}.nfw-collapsed .nfw-body{display:none}
      #${TOOLBAR_ID} .nfw-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}#${TOOLBAR_ID} .nfw-primary-row>*{height:32px}#${TOOLBAR_ID} .nfw-search{position:relative;display:flex;align-items:center;flex:1;min-width:260px}#${TOOLBAR_ID} .nfw-search span{position:absolute;left:10px;color:var(--nfw-muted);font-size:18px}#${TOOLBAR_ID} .nfw-search input{width:100%;height:100%;padding:6px 10px 6px 32px}
      #${TOOLBAR_ID} select{height:32px;padding:5px 8px}#${TOOLBAR_ID} .nfw-controls{color:var(--nfw-muted)}#${TOOLBAR_ID} .nfw-controls label{display:flex;align-items:center;gap:4px}#${TOOLBAR_ID} .nfw-controls input{width:50px;padding:5px 6px}#${TOOLBAR_ID} .nfw-segment{display:flex}#${TOOLBAR_ID} .nfw-segment button{border-radius:0;margin-left:-1px}#${TOOLBAR_ID} .nfw-segment button:first-child{border-radius:7px 0 0 7px;margin-left:0}#${TOOLBAR_ID} .nfw-segment button:last-child{border-radius:0 7px 7px 0}
      #${TOOLBAR_ID} .nfw-actions{padding-top:8px;border-top:1px solid rgba(255,255,255,.06)}#${TOOLBAR_ID} .nfw-stats{margin-right:auto;color:#b9c5d4;font-variant-numeric:tabular-nums}
      #${TOOLBAR_ID} .nfw-page-range{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border:1px solid rgba(255,255,255,.1);border-radius:8px;background:rgba(255,255,255,.03);color:var(--nfw-muted);font-size:11px}
      #${TOOLBAR_ID} .nfw-page-range input{width:46px;height:24px;padding:2px 4px;text-align:center;font-size:11.5px;color:#fff}
      #${TOOLBAR_ID} .nfw-page-range button{height:24px;padding:2px 8px;font-size:11px;font-weight:600;border-color:rgba(139,92,246,.4);background:rgba(139,92,246,.2);color:#c4b5fd}
      #${TOOLBAR_ID} .nfw-page-range button:hover{background:var(--nfw-accent);color:#fff}
      #${TOOLBAR_ID} .nfw-stop-btn{border-color:rgba(239,68,68,.5)!important;background:rgba(239,68,68,.2)!important;color:#fca5a5!important;font-weight:700}
      #${TOOLBAR_ID} .nfw-stop-btn:hover{background:rgba(239,68,68,.35)!important;color:#fff!important}
      #${TOOLBAR_ID} [data-action="addToAlbum"]{border:0!important;background:linear-gradient(90deg,#7c3aed,#a78bfa)!important;color:#f5f3ff!important;font-weight:700!important}#${TOOLBAR_ID} [data-action="addToAlbum"]:hover{filter:brightness(1.15)}#${TOOLBAR_ID} [data-action="addToAlbum"]:disabled{opacity:.5;filter:none}#${TOOLBAR_ID} .nfw-import{border:0!important;background:linear-gradient(90deg,#168449,#35d07f)!important;color:#04180d!important;font-weight:800!important}#${TOOLBAR_ID} .nfw-import:hover{filter:brightness(1.1)}
      #${TOOLBAR_ID} .nfw-import-options{padding:2px 0 1px;color:var(--nfw-muted)}#${TOOLBAR_ID} .nfw-batch-name,#${TOOLBAR_ID} .nfw-board-toggle{display:flex;align-items:center;gap:6px}#${TOOLBAR_ID} .nfw-batch-name input{width:min(330px,54vw);height:30px;padding:5px 8px}#${TOOLBAR_ID} .nfw-board-toggle{min-height:30px;color:#c4b5fd;cursor:pointer}#${TOOLBAR_ID} .nfw-board-toggle input{accent-color:var(--nfw-accent)}
      #${TOOLBAR_ID} .nfw-progress{position:relative;height:20px;overflow:hidden;border-radius:6px;background:#090c11}#${TOOLBAR_ID} .nfw-progress i{position:absolute;inset:0 auto 0 0;background:linear-gradient(90deg,#6d28d9,#22c55e);transition:width .2s}#${TOOLBAR_ID} .nfw-progress span{position:relative;display:grid;place-items:center;height:100%;font-size:10px;font-weight:700;color:white}
      #${TOOLBAR_ID} .nfw-help{color:#737f8e;font-size:10px}#${TOOLBAR_ID} kbd{border:1px solid #394150;border-radius:4px;background:#0b0e13;padding:1px 4px;color:#b7c0cd}
      #${PREFIX}-toast{position:fixed;left:50%;bottom:22px;z-index:2147483640;max-width:min(680px,80vw);transform:translate(-50%,18px);opacity:0;pointer-events:none;padding:11px 16px;border:1px solid rgba(53,208,127,.6);border-radius:10px;background:#11161d;color:#eef5f1;box-shadow:0 12px 35px rgba(0,0,0,.5);font:600 12px system-ui;transition:.2s}#${PREFIX}-toast.is-visible{opacity:1;transform:translate(-50%,0)}#${PREFIX}-toast.is-error{border-color:rgba(239,68,68,.75)}
      .nfw-player-modal{position:fixed;inset:0;z-index:2147483645;display:grid;place-items:center;padding:4vh 3vw;background:rgba(0,0,0,.76);backdrop-filter:blur(6px)}.nfw-player-modal[hidden]{display:none!important}.nfw-player-dialog{width:min(1120px,94vw);max-height:92vh;overflow:hidden;border:1px solid #465163;border-radius:14px;background:#10141b;color:#eef2f7;box-shadow:0 24px 70px rgba(0,0,0,.7)}.nfw-player-dialog header{display:flex;align-items:center;gap:16px;min-height:48px;padding:9px 12px;border-bottom:1px solid rgba(255,255,255,.12)}.nfw-player-dialog header strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 13px/1.25 system-ui}.nfw-player-dialog header button{margin-left:auto;width:30px;height:30px;border:1px solid #4b5563;border-radius:7px;background:#171d27;color:#fff;font:700 22px/1 system-ui;cursor:pointer}.nfw-player-stage{position:relative;display:grid;place-items:center;min-height:min(52vw,630px);max-height:calc(92vh - 48px);background:#050608}.nfw-player-stage video{display:block;width:100%;max-height:calc(92vh - 48px);background:#000}.nfw-player-stage p{margin:18px;color:#c5cfdd;font:500 13px/1.4 system-ui;text-align:center}.nfw-player-stage .nfw-player-error{color:#fecaca}
      .nfw-album-modal{position:fixed;inset:0;z-index:2147483645;display:grid;place-items:center;padding:4vh 3vw;background:rgba(0,0,0,.76);backdrop-filter:blur(6px)}.nfw-album-modal[hidden]{display:none!important}.nfw-album-dialog{width:min(440px,94vw);overflow:hidden;border:1px solid #465163;border-radius:14px;background:#10141b;color:#eef2f7;box-shadow:0 24px 70px rgba(0,0,0,.7);font:13px system-ui,-apple-system,"Segoe UI",sans-serif}.nfw-album-dialog header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.1)}.nfw-album-dialog header strong{font-size:14px;font-weight:700}.nfw-album-dialog header button{border:none;background:transparent;color:#9aa6b5;font-size:18px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:4px}.nfw-album-dialog header button:hover{color:#fff;background:rgba(255,255,255,.1)}.nfw-album-body{padding:16px;display:grid;gap:12px}.nfw-album-subtitle{margin:0;font-size:12px;color:var(--nfw-muted)}.nfw-album-body label{display:grid;gap:5px;font-size:12px;color:#cbd5e1;font-weight:600}.nfw-album-body select,.nfw-album-body input[type="text"]{height:34px;padding:6px 10px;border-radius:7px;border:1px solid var(--nfw-border);background:#0d1016;color:var(--nfw-text);font:inherit;outline:none;box-sizing:border-box}.nfw-album-body select:focus,.nfw-album-body input[type="text"]:focus{border-color:var(--nfw-accent)}.nfw-new-album-box{display:grid;gap:10px;padding:10px;border:1px dashed var(--nfw-border);border-radius:8px;background:rgba(255,255,255,.02)}.nfw-album-checkbox{display:flex!important;align-items:center!important;gap:8px!important;cursor:pointer;font-weight:normal!important;color:#9aa6b5!important;font-size:12px}.nfw-album-checkbox input{accent-color:var(--nfw-accent);width:15px;height:15px;margin:0}.nfw-album-footer{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid rgba(255,255,255,.08);background:rgba(0,0,0,.15)}.nfw-album-footer button{padding:7px 14px;border-radius:7px;border:1px solid var(--nfw-border);background:#171d27;color:#fff;font:600 12px system-ui;cursor:pointer}.nfw-album-footer button:hover{border-color:var(--nfw-accent);background:var(--nfw-surface2)}.nfw-album-footer button.nfw-primary{border:none;background:linear-gradient(90deg,#7c3aed,#a78bfa);color:#f5f3ff}.nfw-album-footer button.nfw-primary:hover{filter:brightness(1.15)}.nfw-album-footer button:disabled{opacity:.5;cursor:default}
      @media(max-width:900px){body.nfw-active .nfw-shell{width:96vw!important;max-width:96vw!important}#${UTILITY_NAV_ID}{justify-content:center}#${UTILITY_NAV_ID} nav>div{justify-content:center!important;gap:8px!important}#${TOOLBAR_ID}{position:relative;top:auto}#${TOOLBAR_ID} .nfw-primary-row>*{flex:1;min-width:180px}#${TOOLBAR_ID} .nfw-help{display:none}}
      @media(max-width:600px){body.nfw-active #filesGrid.grid-view,body.nfw-active #filesGrid,body.nfw-active .files-list,body.nfw-active .nfw-manager-grid{grid-template-columns:repeat(auto-fill,minmax(min(var(--nfw-card-min),100%),1fr))!important;gap:8px!important}#${TOOLBAR_ID} .nfw-brand{min-width:0}.nfw-meta-badge span{font-size:9px;padding:3px 4px}}
      /* Subfolder card enhancements */
      .nfw-subfolder-card{position:relative!important;transition:transform .15s,box-shadow .15s,border-color .15s!important}
      .nfw-subfolder-card:hover{transform:translateY(-2px)!important;box-shadow:0 10px 24px rgba(0,0,0,.35)!important}
      .nfw-subfolder-card.nfw-selected{outline:3px solid var(--nfw-green)!important;outline-offset:-3px!important;box-shadow:0 0 0 1px rgba(53,208,127,.35),0 12px 30px rgba(0,0,0,.4)!important}
      .nfw-folder-check-wrap{position:absolute;top:8px;left:8px;z-index:25;width:28px;height:28px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.26);border-radius:8px;background:rgba(8,10,14,.78);backdrop-filter:blur(7px);cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.35)}
      .nfw-folder-check-wrap input{position:absolute;opacity:0;pointer-events:none}
      .nfw-folder-check-wrap span{width:14px;height:14px;border:2px solid #d7dee9;border-radius:4px;box-sizing:border-box}
      .nfw-folder-check-wrap input:checked+span{border-color:var(--nfw-green);background:var(--nfw-green);box-shadow:inset 0 0 0 2px #14251c}
      .nfw-select-thumb{position:relative!important;cursor:pointer!important}
      .nfw-folder-open-btn{position:absolute;top:8px;right:8px;z-index:24;width:26px;height:26px;display:grid;place-items:center;border-radius:7px;background:rgba(8,10,14,.75);border:1px solid rgba(255,255,255,.18);color:#e2e8f0;font-size:13px;text-decoration:none;opacity:0;transition:opacity .15s,background .15s,color .15s;backdrop-filter:blur(6px)}
      .nfw-subfolder-card:hover .nfw-folder-open-btn{opacity:1}
      .nfw-folder-open-btn:hover{background:var(--nfw-accent);color:#fff;border-color:var(--nfw-accent)}
      .nfw-folder-badge{position:absolute;bottom:8px;right:8px;z-index:22;padding:3px 7px;border-radius:6px;background:rgba(6,8,12,.86);color:#fff;font:700 11px/1.2 system-ui;box-shadow:0 2px 8px rgba(0,0,0,.4);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,.12);letter-spacing:.02em}
      .nfw-folder-badge.nfw-loading{opacity:.75}
      .nfw-folder-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin-top:6px;font-size:11.5px;color:#9aa6b5}
      .nfw-fmeta-item{display:inline-flex;align-items:center;gap:3px}
      .nfw-fmeta-size strong{color:#f3f4f6;font-weight:600}
      .nfw-fmeta-loading{color:#64748b;font-style:italic}
      /* Folder toolbar */
      .nfw-folder-toolbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;margin:12px 0 10px;padding:9px 13px;border:1px solid var(--nfw-border);border-radius:12px;background:rgba(16,19,25,.88);backdrop-filter:blur(12px);font:12px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--nfw-text)}
      .nfw-ft-left{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:1;min-width:280px}
      .nfw-ft-title{font-weight:700;color:#f1f5f9;font-size:13px}
      .nfw-ft-search{position:relative;display:flex;align-items:center;flex:1;min-width:180px;max-width:320px}
      .nfw-ft-search span{position:absolute;left:8px;color:var(--nfw-muted);font-size:15px}
      .nfw-ft-search input{width:100%;height:30px;padding:4px 8px 4px 26px;border:1px solid var(--nfw-border);border-radius:7px;background:#0d1016;color:var(--nfw-text);font:inherit;outline:none}
      .nfw-ft-search input:focus{border-color:var(--nfw-accent)}
      .nfw-folder-toolbar select{height:30px;padding:4px 8px;border:1px solid var(--nfw-border);border-radius:7px;background:#0d1016;color:var(--nfw-text);font:inherit;outline:none}
      .nfw-ft-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .nfw-folder-toolbar button{height:30px;padding:5px 10px;border:1px solid var(--nfw-border);border-radius:7px;background:#171d27;color:var(--nfw-text);font:inherit;cursor:pointer;transition:.14s}
      .nfw-folder-toolbar button:hover{border-color:var(--nfw-accent);background:var(--nfw-surface2)}
      .nfw-ft-stats{font-size:11px;color:var(--nfw-muted)}
      /* Folder action dock (floating) */
      .nfw-folder-dock{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483620;display:flex;align-items:center;gap:14px;padding:10px 18px;border:1px solid rgba(139,92,246,.5);border-radius:14px;background:rgba(14,17,24,.94);backdrop-filter:blur(16px);box-shadow:0 16px 45px rgba(0,0,0,.6),0 0 0 1px rgba(139,92,246,.25);color:#fff;font:12.5px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;animation:nfwSlideUp .2s ease-out}
      .nfw-folder-dock[hidden]{display:none!important}
      @keyframes nfwSlideUp{from{transform:translate(-50%,20px);opacity:0}to{transform:translate(-50%,0);opacity:1}}
      .nfw-fd-summary{display:flex;align-items:center;gap:10px;padding-right:12px;border-right:1px solid rgba(255,255,255,.14)}
      .nfw-fd-icon{font-size:22px;line-height:1}
      .nfw-fd-text{display:grid;line-height:1.25}
      .nfw-fd-text strong{font-size:13px;color:#fff}
      .nfw-fd-text small{color:#a5b4fc;font-size:11px}
      .nfw-fd-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .nfw-fd-btn{height:32px;padding:6px 12px;border:1px solid var(--nfw-border);border-radius:8px;background:#1a202c;color:#edf2f7;font:600 12px system-ui;cursor:pointer;transition:.15s}
      .nfw-fd-btn:hover{border-color:var(--nfw-accent);background:var(--nfw-surface2)}
      .nfw-fd-btn.nfw-fd-merge{border:none!important;background:linear-gradient(90deg,#7c3aed,#9333ea)!important;color:#fff!important;font-weight:700!important;box-shadow:0 4px 14px rgba(124,58,237,.4)}
      .nfw-fd-btn.nfw-fd-merge:hover{filter:brightness(1.15);transform:translateY(-1px)}
      .nfw-fd-close{width:28px;height:28px;border:1px solid #475569;border-radius:7px;background:#131720;color:#94a3b8;font-size:15px;cursor:pointer;display:grid;place-items:center;margin-left:4px}
      .nfw-fd-close:hover{color:#fff;background:#1e293b}
      /* Virtual Merged Album Banner & Origin Badges */
      .nfw-merged-banner{margin:10px 0 16px;padding:12px 16px;border:1px solid rgba(139,92,246,.45);border-radius:12px;background:linear-gradient(135deg,rgba(20,18,34,.96),rgba(15,23,42,.96));backdrop-filter:blur(14px);box-shadow:0 10px 30px rgba(0,0,0,.4);display:grid;gap:10px;color:#edf2f7;font:12px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif}
      .nfw-mb-top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
      .nfw-mb-title-wrap{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
      .nfw-mb-icon{font-size:20px;line-height:1}
      .nfw-mb-title-wrap strong{font-size:14px;color:#fff}
      .nfw-mb-pill{padding:3px 8px;border-radius:12px;background:rgba(139,92,246,.25);border:1px solid rgba(139,92,246,.4);color:#c4b5fd;font-weight:700;font-size:11px}
      .nfw-mb-stats{color:#94a3b8;font-size:11.5px}
      .nfw-mb-actions{display:flex;align-items:center;gap:8px}
      .nfw-mb-actions button{height:30px;padding:5px 11px;border:1px solid var(--nfw-border);border-radius:7px;background:#171d27;color:#fff;font:600 11.5px system-ui;cursor:pointer;transition:.14s}
      .nfw-mb-actions button:hover{border-color:var(--nfw-accent);background:var(--nfw-surface2)}
      .nfw-mb-close{border-color:rgba(239,68,68,.4)!important;color:#fca5a5!important;background:rgba(239,68,68,.1)!important}
      .nfw-mb-close:hover{background:rgba(239,68,68,.2)!important;border-color:#f87171!important;color:#fff!important}
      .nfw-mb-chips{display:flex;flex-wrap:wrap;gap:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.07)}
      .nfw-folder-chip{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:rgba(255,255,255,.04);color:#cbd5e1;font-size:11.5px;cursor:pointer;transition:.14s}
      .nfw-folder-chip:hover{border-color:#a78bfa;background:rgba(139,92,246,.15);color:#fff}
      .nfw-folder-chip.is-active{border-color:#8b5cf6;background:#6d28d9;color:#fff;font-weight:600;box-shadow:0 2px 8px rgba(109,40,217,.35)}
      .nfw-origin-badge{display:inline-block;margin-top:4px;padding:2px 6px;border-radius:4px;background:rgba(139,92,246,.2);border:1px solid rgba(139,92,246,.35);color:#c4b5fd;font:600 10px system-ui;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .nfw-merged-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:50px 20px;color:#94a3b8;font-size:13px}
      .nfw-merged-spinner{width:34px;height:34px;border:3px solid rgba(139,92,246,.2);border-top-color:#a855f7;border-radius:50%;animation:nfwSpin .8s linear infinite}
      @keyframes nfwSpin{to{transform:rotate(360deg)}}
      .nfw-orig-pagination-hidden{display:none!important}
    `;
    (document.head || document.documentElement).appendChild(style);
  }
})();
