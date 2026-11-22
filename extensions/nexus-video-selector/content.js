// ============================================================
// Nexus Video Card Selector — Content Script
// ============================================================
// Smart heuristická detekcia video thumbnail kariet na
// ľubovoľnej stránke. Pridáva selektory, fetchuje metadata
// a ponúka import do Nexus dashboardu.
// ============================================================

(function () {
  'use strict';

  const currentHost = location.hostname.replace(/^www\./i, '').toLowerCase();
  if (
    currentHost === 'youtube.com' || currentHost.endsWith('.youtube.com') || currentHost === 'youtu.be' ||
    currentHost === 'gofile.io' || currentHost.endsWith('.gofile.io')
  ) {
    return;
  }

  if (window.__nvsLoaded) return;
  window.__nvsLoaded = true;

  window.__nvsRescan = function () {
    if (state.scanRun.active || state.activeFetches > 0 || state.queue.length > 0) {
      pushScanLog('info', 'Úplný rescan počká; aktuálny scan ešte beží.');
      return { busy: true };
    }
    // Ponecháme v cache tie URL, ktoré majú platnú veľkosť
    const keepUrls = new Set();
    for (const [url, meta] of state.fetchCache.entries()) {
      if (meta && meta.sizeMb > 0) {
        keepUrls.add(url);
      }
    }

    state.queuedUrls = new Set(keepUrls);
    for (const url of state.fetchCache.keys()) {
      if (!keepUrls.has(url)) {
        state.fetchCache.delete(url);
      }
    }

    state.queue = [];
    state.isRescanActive = true;
    beginScanRun('Úplný rescan stránky');
    scan();
    setTimeout(finishScanRunIfIdle, 0);

    // Vypneme flag pre vynútený fetch, keďže scan() ihneď pridá karty na obrazovke
    setTimeout(() => { state.isRescanActive = false; }, 500);
  };

  window.__nvsFetchMissing = function (options = {}) {
    if (state.scanRun.active || state.activeFetches > 0 || state.queue.length > 0) {
      pushScanLog('info', 'Počkajte, aktuálny scan ešte beží.');
      return { queued: 0, skippedLocked: 0, busy: true };
    }
    const retryLocked = Boolean(options.retryLocked);
    const ignoreCache = options.ignoreCache !== false;
    const cards = [...document.querySelectorAll(`[${CFG.processedAttr}="1"]`)];
    const targets = new Map();
    let skippedLocked = 0;

    for (const card of cards) {
      const url = card.dataset.nvsUrl || getVideoUrlFromCard(card);
      if (!url || targets.has(url)) continue;
      const meta = state.fetchCache.get(url) || state.cardMeta.get(card) || {};
      const cov = getCardCoverage(card, meta);
      if (cov.complete) continue;
      if (meta.failureReason === 'exclusive_locked' && !retryLocked) {
        skippedLocked++;
        continue;
      }
      const force = ignoreCache || meta.failureReason === 'exclusive_locked' || cov.fetched;
      targets.set(url, { card, url, meta, force });
    }

    beginScanRun('Doplnenie chýbajúcich veľkostí');
    if (!targets.size) {
      const suffix = skippedLocked ? ` (${skippedLocked} zamknuté preskočené)` : '';
      pushScanLog('info', `Žiadne dostupné karty na opakovanie${suffix}.`);
      finishScanRunIfIdle();
      return { queued: 0, skippedLocked, fromCache: 0 };
    }

    let queued = 0;
    let fromCache = 0;
    for (const { card, url, force } of targets.values()) {
      state.queuedUrls.delete(url);
      if (force) state.fetchCache.delete(url);
      const badge = card.querySelector('.nvs-badge:not(.nvs-badge-quality)');
      if (badge && force) {
        badge.style.display = '';
        badge.classList.add('nvs-badge-loading');
        badge.classList.remove('nvs-badge-locked');
        const text = badge.querySelector('.nvs-badge-text');
        if (text) text.textContent = '⏳ retry';
      }
      if (enqueue(card, url, force) === 'cache') fromCache++;
      else queued++;
    }
    pushScanLog('info', `Sieť: ${queued}; cache: ${fromCache}; zamknuté preskočené: ${skippedLocked}.`);
    finishScanRunIfIdle();
    return { queued, skippedLocked, fromCache };
  };

  // ── Konfigurácia ──────────────────────────────────────────

  const CFG = {
    // Atribút na označenie spracovanej karty
    processedAttr: 'data-nvs-processed',
    // Max paralelných fetchov naraz
    // PimpBunny rate-limits signed get_file probes. Fusion Hub uses four
    // concurrent enrichments; matching that keeps the CDN from returning 429.
    maxConcurrent: 4,
    // CamWhores detail pages + one media-header probe do not share PimpBunny's limit.
    camwhoresMaxConcurrent: 16,
    // Debounce pre MutationObserver (ms)
    debounceMs: 150,
    // IntersectionObserver rootMargin
    intersectMargin: '300px',
    // Video URL patterns (musia byť veľmi benevolentné pre rôzne weby)
    videoUrlPatterns: [
      /\/video[s]?([^\w]|\d)/i,   // /video/, /videos/, /video123, /video.abc
      /\/prof-video-click\//i,    // XVideos profile tracking linky
      /\/model-click\//i,         // Alternatíva
      /\/watch\b/i,               // /watch?v=, /watch/
      /\/view_video\.php/i,       // Pornhub
      /[?&]viewkey=/i,            // Pornhub alternatíva
      /\/v\/[\w-]+/i,             // eporner, atď.
      /\/clip[s]?\b/i,
      /[?&]v=[\w-]+/i,
      /\/embed\b/i,
      /\/player\b/i,
      /[?&]id=\d+/i,
      /\/movie[s]?\b/i,
      /\/gallery\b/i,             // Niekedy sú to galérie, ale ak majú duration, sú to videá
      /\/play\b/i,
      /xvideos\.com\/.*?\d{5,}/i,  // Univerzálny XVideos fallback (linky s dlhým ID)
      /\/\d{4,}[\/\-][a-z]/i,      // /12345-title nebo /12345/title (tube aggregátory)
      /\/videos?\/\d{4,}/i,        // /video/12345 nebo /videos/12345/slug (xgroovy, tube sites)
    ],
    siteVideoMatchers: [
      {
        host: /(^|\.)fans-here\.com$/i,
        path: /^\/\d{3,}-[^/?#]+\.html$/i,
      },
      {
        host: /(^|\.)baddiehub\.com$/i,
        path: /^\/(?!category|page|tag|author|privacy-policy|terms|contact)[^/?#]+\/?$/i,
      },
      {
        host: /(^|\.)leakedzone\.com$/i,
        path: /^\/(?:[^/]+\/)?(?:video|videos|short|shorts|photo|photos)\/\d+\/?$/i,
      },
      {
        // InternetChicks publishes WordPress post pages at /<post-slug>/.
        host: /(^|\.)internetchicks\.com$/i,
        path: /^\/(?!wp-|category\/|tag\/|page\/|author\/|actress\/|categories?\/|search\b|trending\b|privacy-policy\b|terms\b|contact\b|about\b)[a-z0-9][^/?#]*\/?$/i,
      },
      {
        host: /(^|\.)sxyprn\.(?:net|com)$/i,
        path: /^\/post\/[a-z0-9]+(?:\.html)?$/i,
      },
      {
        host: /(^|\.)fapfolder\.club$/i,
        path: /^\/posts\/\d+\/?$/i,
      },
      {
        host: /(^|\.)beeg\.com$/i,
        path: /^\/-?\d{5,}\/?$/i,
      },
      {
        host: /(^|\.)xxxdbx\.com$/i,
        path: /^\/view\/\d+\/?$/i,
      },
      {
        host: /(^|\.)noodlemagazine\.com$/i,
        path: /^\/watch\/[^/?#]+\/?$/i,
      },
      {
        host: /(^|\.)hornybitches\.org$/i,
        path: /^\/(?!videos?\/|tags?\/|categories?\/|models?\/|search\b)[^/?#]+-\d{3,}\/?$/i,
      },
      {
        host: /(^|\.)redgifs\.com$/i,
        path: /^\/(?:watch|ifr|i)\/[A-Za-z0-9]+\/?$/i,
      },
      {
        host: /(^|\.)camwhores\.(?:tv|com|cc|net|org)$/i,
        path: /^\/videos\/\d+\/[^/?#]+\/?$/i,
      },
      {
        host: /(^|\.)xxbrits\.com$/i,
        path: /^\/videos\/\d+\/[^/?#]+\/?$/i,
      },
      {
        // EPAWG is a Kernel Video Sharing site. Its public video pages always
        // use /videos/<numeric-id>/<slug>/; the generic matcher also catches
        // them, but this keeps card detection deterministic on sparse grids.
        host: /(^|\.)epawg\.com$/i,
        path: /^\/videos\/\d+\/[^/?#]+\/?$/i,
      },
      {
        // erome.com albums (posts): /a/<id>
        host: /(^|\.)erome\.com$/i,
        path: /^\/a\/[A-Za-z0-9_-]+\/?$/i,
      },
      {
        // erome.vip video detail pages: /videos/<slug> (not /videos, /videos/popular, …)
        host: /(^|\.)erome\.vip$/i,
        path: /^\/videos\/(?!popular\/?$|random\/?$)[^/?#]+\/?$/i,
      },
      {
        // PornOne video pages: /<category>/<slug>/<id>/ (optionally localized /<lang>/<cat>/<slug>/<id>/)
        host: /(^|\.)pornone\.com$/i,
        path: /^\/(?:[a-z]{2}\/)?(?!search\/|categories\/|pornstars\/|channels\/|playlists\/|users\/)[^/?#]+\/[^/?#]+\/\d{5,}\/?$/i,
      },
      {
        // FreeusePorn video pages: /video/<id>/<slug> (do not match /videos or /videos/<category>)
        host: /(^|\.)freeuseporn\.com$/i,
        path: /^\/video\/\d+(?:\/[^/?#]+)?\/?$/i,
      },
      {
        // CyberLeaks post pages: /post/<slug>
        host: /(^|\.)cyberleaks\.(?:top|net|com|org)$/i,
        path: /^\/post\/[^/?#]+\/?$/i,
      },
      {
        // x-x-x.video pages: /videos/<id>/<slug>/
        host: /(^|\.)x-x-x\.video$/i,
        path: /^\/videos\/\d+\/[^/?#]+\/?$/i,
      },
      {
        // Tube8 pages: /porn-video/<id>/
        host: /(^|\.)tube8\.[a-z]+$/i,
        path: /^\/porn-video\/\d+\/?/i,
      },
      {
        // SorryMother pages: /pornleaks/<slug>/free-leaks
        host: /(^|\.)sorrymother\.to$/i,
        path: /^\/pornleaks\/[^/?#]+(?:\/free-leaks)?\/?$/i,
      },
      {
        // PureGirl.TV pages: /post/<id>
        host: /(^|\.)puregirl\.tv$/i,
        path: /^\/post\/[^/?#]+\/?$/i,
      },
      {
        // HDSex.org pages: /video/<id>
        host: /(^|\.)hdsex\.org$/i,
        path: /^\/video\/\d+\/?$/i,
      },
      {
        // Fig.to pages: /<category>/onlyfans-leaks/<slug>/
        host: /(^|\.)fig\.to$/i,
        path: /^\/[^/?#]+\/onlyfans-leaks\/[^/?#]+\/?$/i,
      },
      {
        // BravoTube.tv pages: /video-<id>/<slug>/
        host: /(^|\.)bravotube\.tv$/i,
        path: /^\/video-[a-z0-9]+\/[^/?#]+\/?$/i,
      },
      {
        // 01Tube.com pages: /videos/<id>/<slug>/
        host: /(^|\.)01tube\.com$/i,
        path: /^\/videos\/\d+(?:\/[^/?#]+)?\/?$/i,
      },
      {
        // PornHoarder pages: /watch/..., /pornvideo/..., /video/..., /videos/...
        host: /(^|\.)pornhoarder\.(?:tv|io|net|pictures)$/i,
        path: /^\/(?:watch|pornvideo|videos?)\/[^?#]+$/i,
      },
      {
        // cum.st (OnlyHaven) post pages: /creators/<service>/<creatorId>/post/<postId>
        host: /(^|\.)cum\.st$/i,
        path: /^\/creators\/[^/?#]+\/[^/?#]+\/post\/[^/?#]+\/?$/i,
      },
    ],
    // Selektory pre kontajner thumbnailového obrázka
    imgWrapSelectors: [
      '.item-image', '.thumb-wrap', '.thumbnail', '.thumb', '.thumbcont', '.video-thumb',
      '.video__preview', '.post-thumbnail',
      '.cover', '.preview', '.poster', '.card-img', '.card-thumbnail',
      '.video-preview', '.item-thumbnail', '.video-card-image',
      '.content-thumbnail', '.media-thumb', '.card-image-wrapper', '.img',
      '.video-auth-placeholder-thumb', '.video-auth-placeholder-thumb-square',
      '[data-testid="unit-media"]', '.vid_container', '.post_vid_thumb'
    ],
    // Selektory pre existujúce duration na kartách
    durationSelectors: [
      '.duration', '.time', '.video-duration', '.length',
      '[class*="duration"]', '[class*="time-"]', 'span.runtime',
      '.card-duration', '.thumb-duration', '[data-testid="unit-amount"]',
      '.duration_small', '.durlabel'
    ],
    // Minimálne skóre pre detekciu karty ako video karty
    minScore: 2,
  };

  // ── Stav ──────────────────────────────────────────────────

  const state = {
    activeFetches: 0,
    queue: [],
    queuedUrls: new Set(),
    selected: new Set(), // Set<cardElement>
    importBarVisible: false,
    observer: null,
    intersectObserver: null,
    spaTimer: null,
    sortTimer: null,
    nextSortIndex: 1,
    sortKey: localStorage.getItem('nvs-sort-key') || 'none',
    sortDir: localStorage.getItem('nvs-sort-dir') || 'desc',
    filterDuration: localStorage.getItem('nvs-filter-duration') || 'all',
    fetchCache: new Map(), // URL → meta (in-memory pre session)
    cardMeta: new WeakMap(),
    fapFolderProbeQueue: [],
    fapFolderProbeActive: 0,
    eromeSizeQueue: [],
    eromeSizeJobs: new Map(),
    eromeSizeCache: new Map(),
    eromeSizeActive: 0,
    isRescanActive: false,
    isLoadingPages: false,        // guard proti dvojkliku na "Načítať"
    loadedExtraPages: new Set(),  // čísla strán už pripojených pod aktuálnu
    xhamsterNextUrl: '',
    // Nexus dashboard detection: port string alebo false
    isDashboard: (location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? location.port : false,
    portHealth: { '8000': null, '8001': null, '8002': null }, // null=unchecked, true=live, false=dead
    scanRun: {
      active: false,
      label: 'Čakám na sken',
      startedAt: 0,
      finishedAt: 0,
      total: 0,
      done: 0,
      success: 0,
      noSize: 0,
      locked: 0,
      cacheHits: 0,
      network: 0,
      errors: 0,
      urls: new Set(),
      finishedUrls: new Set(),
    },
    statusLog: [],
    disabled: false,
    spaObserverInstalled: false,
  };

  window.__nvsState = state;

  let importWorkbench = null;
  const isXVideosPage = () => /(^|\.)xvideos\.(?:com|red)$/i.test(location.hostname);
  const isSpankBangPage = () => /(^|\.)spankbang\.(?:com|party)$/i.test(location.hostname);
  state.pimpbunnyTagLoader = isPimpBunnyPage()
    ? window.NVSPimpBunnyListing.createTagLoader({ changed: () => importWorkbench?.schedule() }) : null;
  state.xhamsterTagLoader = isXHamsterPage()
    ? window.NVSXhamsterListing.createTagLoader({ changed: () => importWorkbench?.schedule() }) : null;
  state.xvideosTagLoader = isXVideosPage() ? window.NVSXvideosListing.createTagLoader({ changed: () => importWorkbench?.schedule() }) : null;
  state.spankbangTagLoader = isSpankBangPage() ? window.NVSSpankBangListing.createTagLoader({ changed: () => importWorkbench?.schedule() }) : null;
  if (isXVideosPage()) {
    document.documentElement.classList.add('nvs-xv-wide');
    document.documentElement.style.setProperty('--nvs-xh-cols', localStorage.getItem('nvs-xh-cols') || '5');
  }
  if (isSpankBangPage()) document.documentElement.classList.add('nvs-sb-wide');
  const activeTagLoader = () => state.pimpbunnyTagLoader || state.xhamsterTagLoader || state.xvideosTagLoader || state.spankbangTagLoader;

  function createSiteImportWorkbench() {
    importWorkbench = window.createNVSImportWorkbench?.({
      site: isEromeAlbumListing() ? 'erome' : isPimpBunnyPage() ? (/fnxtube\.com$/i.test(location.hostname) ? 'fnxtube' : 'pimpbunny') : isXVideosPage() ? 'xvideos' : isSpankBangPage() ? 'spankbang' : 'xhamster',
      rows: () => [...document.querySelectorAll(`[${CFG.processedAttr}="1"]`)].filter((card) => !isXHamsterPage() || !window.NVSXhamsterListing?.isPaidCard?.(card)).map(card => ({
        card, url: getVideoUrlFromCard(card), title: getCardTitle(card), selected: state.selected.has(card),
        order: getOriginalIndex(card), quality: getSortValue(card, 'quality'), duration: getSortValue(card, 'duration'),
        size: getSortValue(card, 'size'), date: getSortValue(card, 'date'),
        ...(isEromeAlbumListing() ? (({ videos, views }) => ({ videos, views }))(window.NVSEromeListing.counts(card)) : {}),
        tags: activeTagLoader()?.get(getVideoUrlFromCard(card)).tags || [],
        tagsFetched: activeTagLoader()?.get(getVideoUrlFromCard(card)).fetched || false,
      })).filter(row => row.url),
      select(card, selected) {
        if (isPimpBunnyPage()) { setPimpBunnySelection(card, selected); return; }
        if (selected) state.selected.add(card); else state.selected.delete(card);
        card.classList.toggle('nvs-card-selected', selected);
        card.querySelector('.nvs-checkbox')?.setAttribute('aria-checked', String(selected));
        const url = getVideoUrlFromCard(card);
        if (selected) addToSessionSelection(url); else removeFromSessionSelection(url);
      },
      selectionChanged: updateImportBar, clear: doDeselectAll, copy: doCopyUrls,
      scan() { scan(); importWorkbench?.schedule(); },
      sort(cards) {
        // Keep related, recommended and profile grids in their own sections.
        // Reorder only the managed cards. appendChild() would move them behind
        // unhydrated skeleton siblings and those gray tiles would jump on top.
        const groups = new Map();
        for (const card of cards) {
          const node = getSortableNode(card), parent = node?.parentElement;
          if (!parent) continue;
          if (!groups.has(parent)) groups.set(parent, []);
          const list = groups.get(parent);
          if (!list.includes(node)) list.push(node);
        }
        for (const [parent, nodes] of groups) {
          if (isXVideosPage() || isSpankBangPage()) {
            const marker = document.createComment('nvs-xv-sort');
            const first = [...parent.children].find(child => nodes.includes(child));
            if (first) { parent.insertBefore(marker, first); for (const node of nodes) parent.insertBefore(node, marker); marker.remove(); }
          } else window.NVSXhamsterListing?.reorderManagedNodes(parent, nodes);
        }
      },
      fetch(cards, force) {
        if (state.scanRun.active || state.activeFetches || state.queue.length) return { busy: true };
        let queued = 0, locked = 0;
        beginScanRun(force ? 'Obnovujem vybrané metadáta' : 'Dopĺňam chýbajúce metadáta');
        for (const card of cards) {
          const url = getVideoUrlFromCard(card);
          if (!url) continue;
          if (state.fetchCache.get(url)?.failureReason === 'exclusive_locked') { locked++; continue; }
          state.queuedUrls.delete(url); state.fetchCache.delete(url);
          enqueue(card, url, true); queued++;
        }
        finishScanRunIfIdle(); importWorkbench?.schedule(); return { queued, locked };
      },
      onlyVideos: () => isEromeAlbumListing() && (window.NVSEromeListing.onlyVideosRequested(location.hash) || localStorage.getItem('nvs-erome-onlyvideos') === '1'),
      loadStatus() {
        if (isEromeAlbumListing()) return { exhausted: !(state.eromeNextUrl ?? window.NVSEromeListing.nextUrl(document, location.href)) };
        if (isXVideosPage()) return { exhausted: !(state.xvideosNextUrl || window.NVSXvideosListing.nextUrl(document, location.href)) };
        if (isSpankBangPage()) return { exhausted: !(state.spankbangNextUrl !== undefined ? state.spankbangNextUrl : window.NVSSpankBangListing.nextUrl(document, location.href)) };
        if (!isPimpBunnyPage()) return null;
        const next = state.pimpbunnyNextUrl ?? window.NVSPimpBunnyListing.nextUrl(document, location.href);
        return { exhausted: !next };
      },
      async load(count, stopped) {
        if (state.isLoadingPages) throw new Error('Načítanie už beží.');
        state.isLoadingPages = true;
        try {
        if (isEromeAlbumListing()) return await loadEromePages(count, stopped);
        if (isXVideosPage()) return await loadXVideosPages(count, stopped);
        if (isSpankBangPage()) return await loadSpankBangPages(count, stopped);
        if (isXHamsterPage()) {
            if (isXHamsterListingPage()) return await loadXHamsterListingPages(count, stopped);
            return await loadXHamsterRelated(count, null, stopped);
          }
          if (isPimpBunnyPage()) return await loadPimpBunnyPages(count, stopped);
          let loaded = 0;
          for (let i = 0; i < count && !stopped(); i++) {
            const next = findNextListingLink(document);
            if (!next) break;
            const url = new URL(next.href, location.href);
            if (url.origin !== location.origin || state.loadedExtraPages.has(url.href)) break;
            const response = await fetch(url.href, { credentials: 'include', signal: AbortSignal.timeout(20000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
            const base = doc.createElement('base'); base.href = url.href; doc.head.prepend(base);
            if (stopped()) break;
            const grid = findGridContainer(); if (!grid) throw new Error('Grid kariet sa nenašiel.');
            const existing = getListingVideoUrls();
            const items = extractPageItems(doc, grid).filter(node => {
              const links = [
                ...(node.matches?.('a[href]') ? [node] : []),
                ...node.querySelectorAll('a[href]'),
              ];
              for (const a of links) {
                if (!isVideoUrl(a.href)) continue;
                const key = new URL(a.href); key.search = ''; key.hash = '';
                if (existing.has(key.href)) continue;
                existing.add(key.href); return true;
              }
              return false;
            });
            if (!items.length) break;
            const fragment = document.createDocumentFragment();
            for (const item of items) { const node = document.importNode(item, true); hydrateLazyImages(node); fragment.appendChild(node); }
            grid.appendChild(fragment); state.loadedExtraPages.add(url.href);
            const following = findNextListingLink(doc);
            if (following) next.href = new URL(following.getAttribute('href'), url).href; else next.remove();
            loaded++; scan(); await new Promise(resolve => setTimeout(resolve, 60));
          }
          return loaded;
        } finally { state.isLoadingPages = false; importWorkbench?.schedule(); }
      },
      hasNext() {
        if (isEromeAlbumListing()) return !!(state.eromeNextUrl ?? window.NVSEromeListing.nextUrl(document, location.href));
        if (isSpankBangPage()) return !!(state.spankbangNextUrl !== undefined ? state.spankbangNextUrl : window.NVSSpankBangListing.nextUrl(document, location.href));
        return !isXVideosPage() || !!(state.xvideosNextUrl || window.NVSXvideosListing.nextUrl(document, location.href));
      },
      importing: () => importInProgress, status: publicScanStatus,
      tagStatus: () => activeTagLoader()?.status() || { active: false, done: 0, total: 0, errors: 0, stopped: false },
      loadTags: cards => activeTagLoader()?.load(cards.map(getVideoUrlFromCard)) || { done: 0, total: 0, errors: 0, stopped: false },
      stopTags: () => activeTagLoader()?.stop(),
      import: (cards, port) => doImport(port, null, cards),
      async sendDownloader(cards, kind) {
        const urls = [...new Set(cards.map(getVideoUrlFromCard).filter(Boolean))];
        await navigator.clipboard.writeText(urls.join('\n'));
        return urls.length;
      },
    });
    importWorkbench?.mount();
    const workbenchPanel = document.getElementById('nvs-sort-panel');
    if (workbenchPanel && window.NVSMultiSitePlayer) {
      const playbackControls = document.createElement('div');
      playbackControls.className = 'nvs-wb-actions';
      playbackControls.dataset.nvsPlaybackControls = '1';
      (workbenchPanel.querySelector('.nvs-wb-body') || workbenchPanel).prepend(playbackControls);
      window.NVSMultiSitePlayer.start(playbackControls);
      ensureGenericListingPlayer(playbackControls);
    }
  }

  const turboOverview = window.createNVSTurboOverview?.({
    isSelected: card => state.selected.has(card),
    register(card, url) {
      card.dataset.nvsUrl = url;
      card.setAttribute(CFG.processedAttr, '1');
      card.style.position = 'relative';
      injectSelector(card);
      if (getSessionSelection().has(url)) this.select(card, true);
    },
    select(card, value) {
      if (value) state.selected.add(card); else state.selected.delete(card);
      card.classList.toggle('nvs-card-selected', value);
      card.querySelector('.nvs-checkbox')?.setAttribute('aria-checked', String(value));
      if (value) addToSessionSelection(card.dataset.nvsUrl); else removeFromSessionSelection(card.dataset.nvsUrl);
    },
    selectionChanged: updateImportBar,
    metadata(url, meta) {
      state.fetchCache.set(url, { title: meta.title, duration: meta.duration,
        width: meta.width, height: meta.height, size_bytes: meta.size_bytes,
        sizeMb: meta.size_bytes ? meta.size_bytes / 1024 ** 2 : null });
    },
    importItems(port, items, batchName) {
      if (importInProgress) return Promise.resolve({ success: false, error: 'Iný import už beží.' });
      importInProgress = true;
      return new Promise(resolve => {
        const finish = response => {
          const failed = chrome.runtime.lastError;
          importInProgress = false;
          resolve(failed || !response ? { success: false, uncertain: true, error: 'Výsledok nebol potvrdený; skontroluj Nexus.' } : response);
        };
        try { chrome.runtime.sendMessage({ type: 'IMPORT_TO_NEXUS', port, items, batchName, strictPort: true }, finish); }
        catch { importInProgress = false; resolve({ success: false, error: 'Rozšírenie nie je dostupné.' }); }
      });
    },
    exportJson(payload) {
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `nexus-export-${Date.now()}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  });

  function beginScanRun(label) {
    if (state.scanRun.active && state.scanRun.label === label) return;
    state.scanRun = {
      active: true,
      label,
      startedAt: Date.now(),
      finishedAt: 0,
      total: 0,
      done: 0,
      success: 0,
      noSize: 0,
      locked: 0,
      cacheHits: 0,
      network: 0,
      errors: 0,
      urls: new Set(),
      finishedUrls: new Set(),
    };
    pushScanLog('start', label);
  }

  function recordScanOutcome(url, meta, fromCache, failed = false) {
    const run = state.scanRun;
    if (!run.active) return;
    if (!run.urls.has(url)) {
      run.urls.add(url);
      run.total++;
    }
    if (run.finishedUrls.has(url)) return;
    run.finishedUrls.add(url);
    run.done++;

    if (failed) {
      run.errors++;
      pushScanLog('error', 'Rozšírenie neodpovedalo; kartu bude možné zopakovať.', url);
      return;
    }

    if (fromCache) run.cacheHits++;
    else run.network++;

    if (Number(meta?.sizeMb || parseSizeMb(meta?.sizeText || '')) > 0) {
      run.success++;
      return;
    }
    if (meta?.failureReason === 'exclusive_locked') {
      run.locked++;
      if (!fromCache) pushScanLog('locked', 'LOCKED: PornFans neposkytol player ani download zdroj.', url);
      return;
    }
    run.noSize++;
    if (!fromCache) {
      pushScanLog('warning', meta?.failureMessage || 'Detail stránky nevrátil použiteľné metadáta.', url);
    }
  }

  function pushScanLog(type, message, url = '') {
    const entry = {
      ts: Date.now(),
      type,
      message,
      url: url || '',
    };
    state.statusLog.push(entry);
    if (state.statusLog.length > 30) state.statusLog.splice(0, state.statusLog.length - 30);
    window.__nvsUpdateHud?.();
  }

  function finishScanRunIfIdle() {
    importWorkbench?.schedule();
    if (!state.scanRun.active || state.activeFetches > 0 || state.queue.length > 0) return;
    state.scanRun.active = false;
    state.scanRun.finishedAt = Date.now();
    const run = state.scanRun;
    run.label = run.noSize ? `Bez veľkosti zostáva ${run.noSize}` : run.errors ? `Hotovo, chyby ${run.errors}` : 'Veľkosti načítané';
    pushScanLog('done', `Hotovo: ${run.success} s veľkosťou, ${run.locked} zamknuté, ${run.noSize} bez veľkosti, ${run.errors} chyby.`);
  }

  function publicScanStatus() {
    const run = state.scanRun;
    return {
      active: run.active,
      label: run.label,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      total: run.total,
      done: run.done,
      success: run.success,
      noSize: run.noSize,
      locked: run.locked,
      cacheHits: run.cacheHits,
      network: run.network,
      errors: run.errors,
      queueLength: state.queue.length,
      activeFetches: state.activeFetches,
      logs: state.statusLog.slice(-8),
    };
  }

  // ── Inicializácia ─────────────────────────────────────────

  function normalizeHost(value) {
    if (!value) return '';
    try {
      const raw = String(value).trim();
      const parsed = raw.includes('://') ? new URL(raw).hostname : raw;
      return parsed.replace(/^www\./i, '').toLowerCase();
    } catch {
      return String(value).replace(/^www\./i, '').toLowerCase().trim();
    }
  }

  // Asynchrónna init — najprv skontroluj disabledHosts pre tento web
  chrome.storage.sync.get({ disabledHosts: [] }, (data) => {
    const disabledList = (data.disabledHosts || []).map(normalizeHost);
    const isDisabled = disabledList.includes(currentHost);
    state.disabled = isDisabled;
    if (isDisabled) return;
    init();
  });

  function init() {
    if (state.disabled) return;
    turboOverview?.init();
    injectSortPanel();
    injectImportBar();
    checkPortHealth();
    scan();
    installSpaObserver();
  }

  function deactivateOnPage() {
    state.disabled = true;
    state.scanRun.active = false;
    clearTimeout(state.scanRun.idleTimer);
    clearTimeout(state.sortTimer);

    document.querySelectorAll('[data-nvs-processed]').forEach(el => {
      el.querySelector?.('.nvs-selector-wrap')?.remove();
      el.querySelector?.('.nvs-badge')?.remove();
      el.querySelector?.('.nvs-badge-quality')?.remove();
      el.querySelector?.('.nvs-duration-badge')?.remove();
      el.classList.remove('nvs-card-selected');
      el.removeAttribute('data-nvs-processed');
    });

    document.getElementById('nvs-sort-panel')?.remove();
    document.getElementById('nvs-import-bar')?.remove();
    document.getElementById('nvs-workbench-launch')?.remove();
    document.getElementById('nvs-import-result')?.remove();
    document.getElementById('nvs-scan-hud')?.remove();
    turboOverview?.destroy();
    genericListingPlayer?.destroy?.();
    genericListingPlayer = null;
  }

  // Resolve through the existing site's player adapter in this tab/session.
  // Signed media URLs are returned only on demand, never persisted on cards.
  document.addEventListener('nexus-video-resolve', async event => {
    let request; const controller = new AbortController(); let timer;
    try {
      request = JSON.parse(event.detail); const url = new URL(request.url, location.href);
      const multiKey = window.NVSMultiSitePlayer?.site?.(url.href);
      if (multiKey) {
        if (url.origin !== location.origin || !window.NVSMultiSitePlayer.watchUrl(url.href, location.href)) return;
        timer = setTimeout(() => controller.abort(), 12000);
        const entry = { url: url.href };
        const sources = await window.NVSMultiSitePlayer.adapter(multiKey).resolve(entry, controller.signal);
        const best = sources.find(source => /^https?:/i.test(source.url || ''));
        document.dispatchEvent(new CustomEvent('nexus-video-resolved', {
          detail: JSON.stringify({
            requestId: request.requestId,
            url: best?.url || '',
            format: best?.type === 'hls' ? 'hls' : 'mp4',
            embedUrl: best ? '' : entry.embedUrl || '',
          })
        }));
        return;
      }

      if (/(^|\.)pornone\.com$/i.test(url.hostname)) {
        timer = setTimeout(() => controller.abort(), 12000);
        const sources = await resolvePornonePlaybackSources(url.href, controller.signal);
        const best = sources.find(source => /^https?:/i.test(source.url || ''));
        document.dispatchEvent(new CustomEvent('nexus-video-resolved', {
          detail: JSON.stringify({
            requestId: request.requestId,
            url: best?.url || '',
            format: best?.type === 'hls' ? 'hls' : 'mp4',
            embedUrl: '',
          })
        }));
        return;
      }

      if (typeof state !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        let meta = state.fetchCache?.get(url.href) || null;
        if (!meta?.streamUrl && !meta?.embedUrl) {
          const resp = await chrome.runtime.sendMessage({ type: 'FETCH_META', url: url.href, force: false });
          if (resp?.meta) {
            meta = resp.meta;
            state.fetchCache?.set(url.href, meta);
          }
        }
        const streamUrl = String(meta?.streamUrl || '').trim();
        document.dispatchEvent(new CustomEvent('nexus-video-resolved', {
          detail: JSON.stringify({
            requestId: request.requestId,
            url: /^https?:/i.test(streamUrl) ? streamUrl : '',
            format: /\.m3u8(?:[?#]|$)/i.test(streamUrl) ? 'hls' : 'mp4',
            embedUrl: streamUrl ? '' : String(meta?.embedUrl || ''),
          })
        }));
      }
    } catch (error) {
      if (request) document.dispatchEvent(new CustomEvent('nexus-video-resolved', { detail: JSON.stringify({ requestId: request.requestId, error: error.message }) }));
    } finally { clearTimeout(timer); controller.abort(); }
  });
  document.documentElement.dataset.nexusVideoResolver = 'ready';

  // ── Session Selection (perzistencia výberu cez reload) ────

  function getSessionSelection() {
    try { return new Set(JSON.parse(sessionStorage.getItem('nvs-selected') || '[]')); } catch { return new Set(); }
  }
  function addToSessionSelection(url) {
    const sel = getSessionSelection(); sel.add(url);
    sessionStorage.setItem('nvs-selected', JSON.stringify([...sel]));
  }
  function removeFromSessionSelection(url) {
    const sel = getSessionSelection(); sel.delete(url);
    sessionStorage.setItem('nvs-selected', JSON.stringify([...sel]));
  }
  function clearSessionSelection() {
    sessionStorage.removeItem('nvs-selected');
  }

  // ── Port Health ───────────────────────────────────────────

  async function checkPortHealth() {
    const ports = Object.keys(state.portHealth);
    // A content script on https://hotcontainer.co (and any other public page)
    // is not allowed to fetch loopback. Chrome blocks it as Private Network
    // Access: "Permission was denied for this request to access the loopback
    // address space." The service worker has host permission, so it probes.
    let results = null;
    try {
      results = await chrome.runtime.sendMessage({ type: 'NVS_PORT_HEALTH', ports });
    } catch {
      results = null;
    }
    for (const port of ports) {
      const live = results?.[port];
      state.portHealth[port] = live === true ? true : live === false ? false : null;
    }
    const btn8000 = document.getElementById('nvs-btn-import-8000');
    const btn8001 = document.getElementById('nvs-btn-import-8001');
    const btn8002 = document.getElementById('nvs-btn-import-8002');
    if (btn8000) applyPortButtonState(btn8000, '8000');
    if (btn8001) applyPortButtonState(btn8001, '8001');
    if (btn8002) applyPortButtonState(btn8002, '8002');
  }

  function applyPortButtonState(btn, port) {
    const live = state.portHealth[port];
    const isDashboardPort = state.isDashboard && state.isDashboard === port;
    if (isDashboardPort) {
      btn.disabled = true;
      btn.title = `Port :${port} — toto je aktuálna stránka`;
      btn.classList.add('nvs-btn-dead');
    } else if (live === false) {
      btn.disabled = true;
      btn.classList.add('nvs-btn-dead');
      btn.title = `Port :${port} — offline`;
    } else {
      btn.disabled = false;
      btn.classList.remove('nvs-btn-dead');
    }
  }

  // ── Smart Card Detection ──────────────────────────────────

  /**
   * Hlavná heuristika — nájde všetky video karty na stránke.
   * Nevyžaduje žiadne site-specific selektory.
   */
  function normalizeXvideosCards(cards) {
    const normalized = new Set();
    for (const card of cards) {
      normalized.add(card.closest('.thumb-block') || card.closest('.mozaique .thumb-block') || card);
    }
    return [...normalized];
  }

  function findVideoCards() {
    const candidates = new Set();
    if (isArchvePage()) return [...document.querySelectorAll('a.media-card[href]')].filter(card => {
      try { const u = new URL(card.href); return /(^|\.)archve\.xyz$/i.test(u.hostname) && /^\/(?:watch|albums)\/[a-z0-9_-]+\/?$/i.test(u.pathname); } catch { return false; }
    });
    if (isEromeAlbumListing()) return window.NVSEromeListing.cards(document, location.href).map(item => item.card);
    if (isSpankBangPage() && window.NVSSpankBangListing) {
      return window.NVSSpankBangListing.cards(document, location.href).map(item => item.card);
    }
    if (window.NVSMultiSitePlayer?.site(location.href) === 'xvideos') {
      for (const item of window.NVSXvideosListing?.cards(document) || []) candidates.add(item.card);
      for (const entry of window.NVSMultiSitePlayer.collect(document.body, 'xvideos', { includeHidden: true })) candidates.add(entry.card);
      return normalizeXvideosCards(candidates);
    }

    // DrTuber search tiles are `a.th.ch-video` nodes inside `.thumbs_box`.
    // Accessibility exposes the grid as "search_results", but that is not an
    // actual CSS class, so target the site's real markup directly.
    if (isDrTuberPage()) {
      return [...document.querySelectorAll('.thumbs_box .thumbs > a.th.ch-video[href*="/video/"], a.th.ch-video[href*="/video/"]')]
        .filter(link => isVideoUrl(link.href));
    }

    if (isPornonePage()) {
      return [...document.querySelectorAll('a.videocard[href]')]
        .filter(link => !link.classList.contains('customnative') && !link.querySelector('.adlabel') && isVideoUrl(link.href));
    }

    if (isCumStPage()) {
      return [...document.querySelectorAll('a.cv-cell[href*="/post/"]')]
        .filter(link => isVideoUrl(link.href) && isCumStVideoCard(link));
    }

    if (isLeakedzonePage()) {
      for (const link of document.querySelectorAll('.media-items a[href*="/video/"], .media-items a[href*="/short/"], a.block[href*="/video/"], a.block[href*="/short/"]')) {
        candidates.add(link);
      }
    }

    // WordPress archive cards link to root-level post permalinks. Use the
    // article wrapper directly so title and thumbnail remain one selectable item.
    if (isInternetChicksPage()) {
      for (const link of document.querySelectorAll('article a[href], .post a[href], .entry a[href]')) {
        if (!isVideoUrl(link.href)) continue;
        const card = link.closest('article, .post, .entry') || findCardContainer(link);
        if (card && card !== document.body && card !== document.documentElement) candidates.add(card);
      }
    }

    if (isSxyprnPage()) {
      for (const card of document.querySelectorAll('.post_el_small')) {
        candidates.add(card);
      }
    }

    // FapFolder profile video grid: thumbnail is a CSS background, not an <img>.
    if (isFapFolderPage()) {
      for (const link of document.querySelectorAll('a.pg_video[href*="/posts/"], a[href*="/posts/"]')) {
        const card = findCardContainer(link);
        if (card && card !== document.body && card !== document.documentElement) {
          candidates.add(card);
        }
      }
    }

    if (isEromeVideoListingPage()) {
      // erome.com albums use /a/<id>; erome.vip model videos use /videos/<slug>
      for (const link of document.querySelectorAll('a[href*="/a/"], a[href*="/videos/"]')) {
        if (!isEromeListingVideoLink(link)) continue;
        if (!link.querySelector('img, picture, video') && !hasBackgroundThumbnail(link)) continue;
        const card = findCardContainer(link);
        if (card && card !== document.body && card !== document.documentElement) {
          candidates.add(card);
        }
      }
      for (const media of document.querySelectorAll('video, [data-video-src]')) {
        const card = findCardContainer(media);
        if (card && card !== document.body && card !== document.documentElement) {
          candidates.add(card);
        }
      }
    }

    // Redgifs: SPA tiles have NO <a href="/watch/"> anchor — the gif id lives in
    // the thumbnail/poster filename. Collect tiles from their media elements and
    // walk up to a sensible card container.
    if (isRedgifsPage()) {
      const media = document.querySelectorAll(
        'img[src*="redgifs.com"], img[srcset*="redgifs.com"], img[data-src*="redgifs.com"], ' +
        'video[poster*="redgifs.com"], video[src*="redgifs.com"], a[href*="/watch/"], a[href*="/ifr/"], a[href*="/i/"]'
      );
      for (const el of media) {
        const card = findRedgifsTile(el);
        if (card && card !== document.body && card !== document.documentElement) {
          candidates.add(card);
        }
      }
    }

    // XXBrits search/listing cards live in `.videos_list .th` (ads use `.th.avd`).
    // Walking past `.th` hits the whole `.main-flex.videos_list` grid.
    if (isXxbritsPage()) {
      for (const card of document.querySelectorAll('.videos_list .th, .list-videos .th, div.th')) {
        if (card.classList.contains('avd')) continue;
        if (getCamwhoresVideoUrlFromNode(card)) {
          candidates.add(card);
        }
      }
    }

    // Camwhores: profile, search, listing and playlist pages reuse the same
    // Kernel-style .list-videos/.item cards. Detect the item itself; walking too
    // far up tends to hit the whole grid or only a wrapper around the image.
    if (isCamwhoresPage()) {
      for (const card of document.querySelectorAll('.list-videos .item, .video-list .video-item, .videos-block .item, .thumbs-block .item')) {
        if (getCamwhoresVideoUrlFromNode(card)) {
          candidates.add(card);
        }
      }

      const anchors = document.querySelectorAll('a[href*="/videos/"]');
      for (const link of anchors) {
        const card = findCamwhoresCardContainer(link);
        if (card && card !== document.body && card !== document.documentElement) {
          candidates.add(card);
        }
      }

      const thumbs = document.querySelectorAll('img[src*="/contents/videos_screenshots/"], img[src*="/uploads/"], img[src*="thumb"], img[class*="thumb"]');
      for (const img of thumbs) {
        const node = img.closest('a[href*="/videos/"]') || img;
        const card = findCamwhoresCardContainer(node);
        if (card && card !== document.body && card !== document.documentElement) candidates.add(card);
      }
    }

    // GoFile: detection of video files in folder listings
    if (isGofilePage()) {
      for (const card of findGofileVideoCards()) {
        candidates.add(card);
      }
    }

    // EPAWG's cards are regular KVS `.list-videos .item` tiles. They often
    // omit a visible duration, so explicitly adding the tile avoids depending
    // on a third, incidental heuristic signal.
    if (isEpawgPage()) {
      for (const card of document.querySelectorAll('.list-videos .item')) {
        const link = card.querySelector('a[href*="/videos/"]');
        if (link && isVideoUrl(link.href)) candidates.add(card);
      }
    }

    // 1. Nájdi všetky linky smerujúce na video stránky
    const allLinks = document.querySelectorAll('a[href]');
    for (const link of allLinks) {
      if (link.closest('#nvs-overview, [id^="nvs-"]')) continue;
      if (!isVideoUrl(link.href)) continue;
      const card = findCardContainer(link);
      if (card && card !== document.body && card !== document.documentElement) {
        candidates.add(card);
      }
    }

    // 2. Filtruj — karty musia mať minimálne skóre (pre Camwhores povoľnejšie, GoFile karty majú vlastný príznak)
    const result = [];
    const requiredScore = (isCamwhoresPage() || isXxbritsPage()) ? 1 : CFG.minScore;
    for (const card of candidates) {
      if (card.closest('#nvs-overview, [id^="nvs-"]')) continue;
      if (card.dataset.nvsGofile === '1' || scoreCard(card) >= requiredScore) {
        result.push(card);
      }
    }
    return result;
  }

  function isLeakedzonePage() {
    return /(^|\.)leakedzone\.com$/i.test(location.hostname);
  }

  function isDrTuberPage() {
    return /(^|\.)drtuber\.com$/i.test(location.hostname);
  }

  function isPornonePage() {
    return /(^|\.)pornone\.com$/i.test(location.hostname);
  }

  function isFapFolderPage() {
    return /(^|\.)fapfolder\.club$/i.test(location.hostname);
  }

  function isNoodleMagazinePage() {
    return /(^|\.)noodlemagazine\.com$/i.test(location.hostname);
  }

  function isRedgifsPage() {
    return /(^|\.)redgifs\.com$/i.test(location.hostname);
  }

  function isCamwhoresPage() {
    return /(^|\.)camwhores\.(tv|com|cc|net|org)$/i.test(location.hostname);
  }

  function isXxbritsPage() {
    return /(^|\.)xxbrits\.com$/i.test(location.hostname);
  }

  function isEpawgPage() {
    return /(^|\.)epawg\.com$/i.test(location.hostname);
  }

  function isFreeusePornPage() {
    return /(^|\.)freeuseporn\.com$/i.test(location.hostname);
  }

  function isCyberLeaksPage() {
    return /(^|\.)cyberleaks\.(?:top|net|com|org)$/i.test(location.hostname);
  }

  function isXXXVideoPage() {
    return /(^|\.)x-x-x\.video$/i.test(location.hostname);
  }

  function isTube8Page() {
    return /(^|\.)tube8\.[a-z]+$/i.test(location.hostname);
  }

  function isSorryMotherPage() {
    return /(^|\.)sorrymother\.to$/i.test(location.hostname);
  }

  function isPureGirlPage() {
    return /(^|\.)puregirl\.tv$/i.test(location.hostname);
  }

  function isHdSexPage() {
    return /(^|\.)hdsex\.org$/i.test(location.hostname);
  }

  function isFigToPage() {
    return /(^|\.)fig\.to$/i.test(location.hostname);
  }

  function isBravoTubePage() {
    return /(^|\.)bravotube\.tv$/i.test(location.hostname);
  }

  function is01TubePage() {
    return /(^|\.)01tube\.com$/i.test(location.hostname);
  }

  function isPornHoarderPage() {
    return /(^|\.)pornhoarder\.(?:tv|io|net|pictures)$/i.test(location.hostname);
  }

  function isPorneecPage() {
    return /(^|\.)porneec\.com$/i.test(location.hostname);
  }

  function isCumStPage() {
    return /(^|\.)cum\.st$/i.test(location.hostname);
  }

  function isCumStVideoCard(card) {
    if (!card) return false;
    if (card.querySelector('svg path[d^="M6 4v16"], svg path[d*="m15 10l4.553"]')) return true;
    const text = card.textContent || '';
    return /\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(text);
  }

  function isGofilePage() {
    return /(^|\.)gofile\.io$/i.test(location.hostname);
  }

  function isXHamsterPage() {
    return /(^|\.)xhamster(?:-fr)?\.com$|(^|\.)xhamster\.desi$/i.test(location.hostname);
  }

  function isPimpBunnyPage() {
    return /(^|\.)(?:pimpbunny|fnxtube)\.com$/i.test(location.hostname);
  }

  function setPimpBunnySelection(card, selected) {
    const url = getVideoUrlFromCard(card);
    for (const other of document.querySelectorAll(`[${CFG.processedAttr}="1"]`)) {
      if (getVideoUrlFromCard(other) !== url) continue;
      if (selected) state.selected.add(other); else state.selected.delete(other);
      other.classList.toggle('nvs-card-selected', selected);
      other.querySelector('.nvs-checkbox')?.setAttribute('aria-checked', String(selected));
    }
    if (selected) addToSessionSelection(url); else removeFromSessionSelection(url);
  }

  async function loadPimpBunnyPages(count, stopped) {
    const adapter = window.NVSPimpBunnyListing;
    let next = state.pimpbunnyNextUrl ?? adapter.nextUrl(document, location.href);
    let loaded = 0;
    for (let i = 0; i < count && next && !stopped(); i++) {
      if (state.loadedExtraPages.has(next)) break;
      const response = await fetch(next, { credentials: 'include', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (new URL(response.url).origin !== location.origin) throw new Error('Stránka presmerovala mimo pôvodnej domény.');
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      if (stopped()) break;
      const liveCards = adapter.cards(document, location.href);
      const grid = window.NVSMultiSitePlayer?.cardParent?.(liveCards[0]?.card) || liveCards[0]?.card.parentElement;
      if (!grid) throw new Error('Otvor zoznam videí so stránkovaním.');
      const existing = new Set(liveCards.map(item => item.url));
      const candidates = adapter.cards(doc, next);
      if (!candidates.length) throw new Error('Ďalšia stránka neobsahuje čitateľné video karty.');
      const fragment = document.createDocumentFragment();
      for (const item of candidates) {
        if (existing.has(item.url)) continue;
        existing.add(item.url);
        const node = document.importNode(item.card, true);
        // The site's scripts do not initialize appended HTML. Hydrate only images,
        // retaining the native watch page URL and never importing preview streams.
        for (const image of node.querySelectorAll('img')) {
          const src = image.getAttribute('data-src') || image.getAttribute('data-original') || image.getAttribute('data-webp') || image.getAttribute('src');
          if (src) image.src = new URL(src, next).href;
          image.loading = 'lazy';
        }
        fragment.appendChild(node);
      }
      grid.appendChild(fragment);
      // The address stays on page 1 while cards accumulate. Keep the visible
      // native pager in sync so page 3 does not still look like page 1.
      const livePager = adapter.pagination(document);
      const fetchedPager = adapter.pagination(doc);
      if (livePager && fetchedPager) {
        const pager = document.importNode(fetchedPager, true);
        for (const link of pager.querySelectorAll('a[href]')) {
          link.href = new URL(link.getAttribute('href'), next).href;
        }
        livePager.replaceWith(pager);
      }
      state.loadedExtraPages.add(next);
      next = adapter.nextUrl(doc, next);
      state.pimpbunnyNextUrl = next;
      loaded++; scan();
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return loaded;
  }

  function isXHamsterListingPage() {
    if (!isXHamsterPage() || /\/videos\/[^/?#]+/i.test(location.pathname)) return false;
    return !!document.querySelector('a[rel="next"], .desktop-pagination, [data-role="thumb-list-block"]');
  }

  function getGofileFolderName() {
    const heading = document.querySelector('h1, h2, [class*="folder-title"], [class*="folderTitle"], [class*="folderName"]');
    const headingText = heading ? heading.textContent.trim() : '';
    if (headingText && !/gofile|manager|my files/i.test(headingText)) {
      return headingText;
    }
    const m = location.pathname.match(/\/[dc]\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : (document.title?.split('-')[0]?.trim() || 'GoFile Folder');
  }

  function getGofileVideoUrl(card) {
    if (!card) return location.href;
    const dlLink = card.querySelector('a[href*="gofile.io"], a[href*="download"], a[download]');
    if (dlLink?.href && /^https?:\/\//i.test(dlLink.href)) return dlLink.href;
    const vid = card.querySelector('video source, video[src]');
    if (vid?.src && /^https?:\/\//i.test(vid.src)) return vid.src;
    const fileName = card.dataset.nvsFileName || '';
    const m = location.pathname.match(/\/[dc]\/([a-zA-Z0-9_-]+)/);
    const contentId = m ? m[1] : '';
    const rowId = card.id || card.getAttribute('data-id') || card.getAttribute('data-target') || '';
    if (contentId) {
      if (rowId) return `https://gofile.io/d/${contentId}#${rowId}`;
      if (fileName) return `https://gofile.io/d/${contentId}?file=${encodeURIComponent(fileName)}`;
      return `https://gofile.io/d/${contentId}`;
    }
    return location.href;
  }

  function findGofileVideoCards() {
    if (!isGofilePage()) return [];
    const found = [];
    const videoExtRe = /\.(mp4|mkv|avi|mov|webm|m4v|flv|ts)\b/i;
    const seen = new Set();

    const candidates = document.querySelectorAll('span, div, p, a, td, li, tr');
    for (const el of candidates) {
      if (el.children.length > 2) continue;
      const text = (el.textContent || '').trim();
      if (!videoExtRe.test(text)) continue;

      const fileMatch = text.match(/\b([A-Za-z0-9_.\-\s()[\]]+\.(?:mp4|mkv|avi|mov|webm|m4v|flv|ts))\b/i);
      if (!fileMatch) continue;
      const fileName = fileMatch[1].trim();

      let row = el.parentElement;
      let steps = 0;
      let bestRow = null;
      while (row && steps < 8 && row !== document.body) {
        steps++;
        const rowText = row.textContent || '';
        const rect = row.getBoundingClientRect();
        const hasActions = !!row.querySelector('button, a, [role="button"]') || /download|preview/i.test(rowText);

        if (hasActions && rect.height >= 26 && rect.height <= window.innerHeight * 0.88 && rect.width >= 160) {
          // Take the FIRST (innermost) ancestor that qualifies and stop
          // climbing either way. Continuing past it and overwriting bestRow
          // on every later, larger ancestor meant a page where sibling rows
          // don't repeat the ".mp4" extension in plain text (so this "more
          // than one file" guard never fired) walked all the way up past the
          // real row — for one item all the way to <body>, dragging in the
          // page header/sidebar/logo as its "card".
          const matchedFiles = rowText.match(/\.(?:mp4|mkv|avi|mov|webm|m4v|flv|ts)\b/gi) || [];
          if (matchedFiles.length <= 1) bestRow = row;
          break;
        }
        row = row.parentElement;
      }

      const targetCard = bestRow || el.parentElement;
      if (targetCard && !seen.has(targetCard)) {
        seen.add(targetCard);
        targetCard.dataset.nvsGofile = '1';
        targetCard.dataset.nvsFileName = fileName;
        found.push(targetCard);
      }
    }

    injectGofileFolderAction();
    return found;
  }

  function injectGofileFolderAction() {
    if (!isGofilePage()) return;
    if (document.getElementById('nvs-gofile-batch-btn')) return;

    const folderName = getGofileFolderName();
    const allContainers = document.querySelectorAll('div, header, section');
    let targetContainer = null;

    for (const h of allContainers) {
      const text = h.textContent || '';
      if (text.includes(folderName) && h.querySelector('button, a') && h.children.length >= 2 && h.children.length < 15) {
        const rect = h.getBoundingClientRect();
        if (rect.height > 20 && rect.height < 250 && rect.width > 200) {
          targetContainer = h;
          break;
        }
      }
    }

    if (!targetContainer) {
      targetContainer = document.querySelector('h1, h2')?.parentElement;
    }

    if (!targetContainer) return;

    const btn = document.createElement('button');
    btn.id = 'nvs-gofile-batch-btn';
    btn.type = 'button';
    btn.className = 'nvs-gofile-folder-btn';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:currentColor;"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
      <span>⚡ Nexus Batch Import</span>
    `;
    btn.title = `Importovať videá z priečinka "${folderName}" ako pomenovaný batch do Nexus`;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const allGofileCards = [...document.querySelectorAll('[data-nvs-gofile="1"]')];
      if (allGofileCards.length === 0) {
        showToast('Nenašli sa žiadne videá v tomto priečinku', 'error');
        return;
      }

      if (state.selected.size === 0) {
        for (const c of allGofileCards) {
          state.selected.add(c);
          c.classList.add('nvs-card-selected');
          const cb = c.querySelector('.nvs-checkbox');
          if (cb) cb.setAttribute('aria-checked', 'true');
        }
        updateImportBar();
      }

      const count = state.selected.size || allGofileCards.length;
      const defaultName = getGofileFolderName();
      const enteredName = prompt(`Zadaj názov batchu pre import ${count} videí do Nexus:`, defaultName);
      if (enteredName === null) return;

      const finalBatchName = enteredName.trim() || defaultName;
      const port = getFirstLivePort();
      doImport(port, finalBatchName);
    });

    targetContainer.appendChild(btn);
  }

  function isFaphousePage() {
    return /(^|\.)faphouse\.com$/i.test(location.hostname);
  }

  function isArchvePage() { return /(^|\.)archve\.xyz$/i.test(location.hostname); }

  function isInternetChicksPage() {
    return /(^|\.)internetchicks\.com$/i.test(location.hostname);
  }

  function isSxyprnPage() {
    return /(^|\.)sxyprn\.(?:net|com)$/i.test(location.hostname);
  }

  function prefersMediaBadge() {
    return isFapFolderPage() || isNoodleMagazinePage() || isRedgifsPage();
  }

  function hasBackgroundThumbnail(el) {
    if (!el) return false;
    const bgEl = el.matches?.('.video-auth-placeholder-thumb, .video-auth-placeholder-thumb-square')
      ? el
      : el.querySelector?.('.video-auth-placeholder-thumb, .video-auth-placeholder-thumb-square, [style*="background-image"]');
    if (!bgEl) return false;
    const style = bgEl.getAttribute('style') || '';
    return /background-image\s*:\s*url\(/i.test(style);
  }

  /**
   * Overí či URL smeruje na video stránku.
   */
  function isVideoUrl(href) {
    if (!href || href.startsWith('javascript') || href === '#') return false;
    try {
      const url = new URL(href);
      if (isPimpBunnyPage()) return !!window.NVSPimpBunnyListing.watchUrl(url.href, location.href);
      if (isSpankBangPage()) return !!window.NVSSpankBangListing?.watchUrl(url.href, location.href);
      if (/(^|\.)freeuseporn\.com$/i.test(url.hostname)) {
        return /^\/video\/\d+(?:\/[^/?#]+)?\/?$/i.test(url.pathname);
      }
      if (/(^|\.)cyberleaks\.(?:top|net|com|org)$/i.test(url.hostname)) {
        return /^\/post\/[^/?#]+\/?$/i.test(url.pathname);
      }
      if (/(^|\.)x-x-x\.video$/i.test(url.hostname)) {
        return /^\/videos\/\d+\/[^/?#]+\/?$/i.test(url.pathname);
      }
      if (/(^|\.)tube8\.[a-z]+$/i.test(url.hostname)) {
        return /^\/porn-video\/\d+\/?/i.test(url.pathname);
      }
      if (/(^|\.)sorrymother\.to$/i.test(url.hostname)) {
        return /^\/pornleaks\/[^/?#]+(?:\/free-leaks)?\/?$/i.test(url.pathname);
      }
      if (/(^|\.)puregirl\.tv$/i.test(url.hostname)) {
        return /^\/post\/[^/?#]+\/?$/i.test(url.pathname);
      }
      if (/(^|\.)hdsex\.org$/i.test(url.hostname)) {
        return /^\/video\/\d+\/?$/i.test(url.pathname);
      }
      if (/(^|\.)fig\.to$/i.test(url.hostname)) {
        return /^\/[^/?#]+\/onlyfans-leaks\/[^/?#]+\/?$/i.test(url.pathname);
      }
      if (/(^|\.)bravotube\.tv$/i.test(url.hostname)) {
        return /^\/video-[a-z0-9]+\/[^/?#]+\/?$/i.test(url.pathname);
      }
      if (/(^|\.)01tube\.com$/i.test(url.hostname)) {
        return /^\/videos\/\d+(?:\/[^/?#]+)?\/?$/i.test(url.pathname);
      }
      if (/(^|\.)pornhoarder\.(?:tv|io|net|pictures)$/i.test(url.hostname)) {
        return /^\/(?:watch|pornvideo|videos?)\/[^?#]+$/i.test(url.pathname);
      }
      if (/(^|\.)cum\.st$/i.test(url.hostname)) {
        return /^\/creators\/[^/?#]+\/[^/?#]+\/post\/[^/?#]+\/?$/i.test(url.pathname);
      }
      if (/(^|\.)porneec\.com$/i.test(url.hostname)) {
        if (url.search && !/^\?$/.test(url.search)) return false;
        const seg = url.pathname.replace(/^\/+|\/+$/g, '');
        if (!seg || seg.includes('/')) return false;
        if (/^(?:wp-[a-z0-9-]+|categor(?:y|ies)|tags?|actors?|c|page|author|search|feed|contact|dmca|privacy-policy|terms(?:-of-use)?|2257|login|register|about|most-viewed|longest|top-rated|latest|random|popular)$/i.test(seg)) {
          return false;
        }
        return /^[a-z0-9][a-z0-9-]*[a-z0-9]$/i.test(seg);
      }
      for (const matcher of CFG.siteVideoMatchers) {
        if (matcher.host.test(url.hostname) && matcher.path.test(url.pathname)) return true;
      }
      // Musí byť na rovnakej alebo príbuznej doméne (povolíme aj cross-site embeds)
      for (const pattern of CFG.videoUrlPatterns) {
        if (pattern.test(url.pathname + url.search)) return true;
      }
      return false;
    } catch { return false; }
  }

  function isEromePage() {
    return /(^|\.)erome\.(?:vip|com)$/i.test(location.hostname);
  }

  // erome.com profile / search / explore pages: grid of album cards (posts).
  function isEromeAlbumListing() {
    return !!window.NVSEromeListing?.isListing(document, location);
  }

  // Appends the next `count` listing pages (?page=N) under the current grid.
  async function loadEromePages(count, stopped) {
    const adapter = window.NVSEromeListing;
    let next = state.eromeNextUrl ?? adapter.nextUrl(document, location.href);
    let loaded = 0;
    for (let i = 0; i < count && next && !stopped(); i++) {
      if (state.loadedExtraPages.has(next)) break;
      const response = await fetch(next, { credentials: 'include', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (new URL(response.url).origin !== location.origin) throw new Error('Stránka presmerovala mimo pôvodnej domény.');
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      if (stopped()) break;
      const live = adapter.cards(document, location.href);
      const grid = live[0]?.card.parentElement || document.getElementById('albums');
      if (!grid) throw new Error('Grid albumov sa nenašiel.');
      const existing = new Set(live.map(item => item.url));
      const fresh = adapter.cards(doc, next);
      const fragment = document.createDocumentFragment();
      for (const item of fresh) {
        if (existing.has(item.url)) continue;
        existing.add(item.url);
        const node = document.importNode(item.card, true);
        for (const image of node.querySelectorAll('img')) {
          const src = image.getAttribute('data-src') || image.getAttribute('src');
          if (src) image.src = new URL(src, next).href;
          image.loading = 'lazy';
        }
        for (const link of node.querySelectorAll('a[href]')) link.href = new URL(link.getAttribute('href'), next).href;
        fragment.appendChild(node);
      }
      grid.appendChild(fragment);
      state.loadedExtraPages.add(next);
      // Keep the native pager in sync with the page that was just appended.
      const livePager = document.querySelector('ul.pagination'), fetchedPager = doc.querySelector('ul.pagination');
      if (livePager && fetchedPager) {
        const pager = document.importNode(fetchedPager, true);
        for (const link of pager.querySelectorAll('a[href]')) link.href = new URL(link.getAttribute('href'), next).href;
        livePager.replaceWith(pager);
      }
      const following = adapter.nextUrl(doc, next);
      state.eromeNextUrl = following;
      next = following;
      loaded++; scan();
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return loaded;
  }

  function isEromeVideoListingPage() {
    // erome.vip uses /models/<slug>/videos (plural); keep singular for older paths
    return isEromePage() && /^\/models\/[^/]+\/videos?\/?$/i.test(location.pathname);
  }

  function isEromeListingVideoLink(link) {
    try {
      const path = new URL(link.href || link.getAttribute?.('href') || '', location.href).pathname;
      if (/\/a\/[^/?#]+/i.test(path)) return true;
      // Detail pages only — skip /videos, /videos/popular, /videos/random, model tabs
      return /^\/videos\/(?!popular\/?$|random\/?$)[^/?#]+\/?$/i.test(path);
    } catch {
      return false;
    }
  }

  function isEromeMediaStreamUrl(href) {
    // erome.vip serves signed streams as /media/v/<id>/video?expires=&signature= (no .mp4)
    return /\/media\/v\/\d+\/video(?:$|[?#])/i.test(String(href || ''));
  }

  function getEromeCardMediaUrl(card) {
    const candidates = [];
    const addCandidate = (url, isMediaElement = false) => {
      if (url) candidates.push({ url, isMediaElement });
    };
    for (const video of card.querySelectorAll('video')) {
      addCandidate(video.currentSrc, true);
      addCandidate(video.getAttribute('src'), true);
      addCandidate(video.getAttribute('data-src'), true);
      for (const source of video.querySelectorAll('source')) {
        addCandidate(source.getAttribute('src'), true);
        addCandidate(source.getAttribute('data-src'), true);
      }
    }
    for (const el of card.querySelectorAll('[data-video-src], [data-src], [data-original], a[href]')) {
      addCandidate(el.getAttribute('data-video-src'), true);
      addCandidate(el.getAttribute('data-src'));
      addCandidate(el.getAttribute('data-original'));
      if (el.matches('a[href]')) addCandidate(el.getAttribute('href'));
    }

    for (const { url: raw, isMediaElement } of candidates) {
      if (!raw || /^(?:blob:|data:|javascript:)/i.test(raw)) continue;
      try {
        const mediaUrl = new URL(raw, location.href);
        if (!/^https?:$/.test(mediaUrl.protocol) || /\.m3u8(?:$|[?#])/i.test(mediaUrl.href)) continue;
        if (
          !isMediaElement
          && !/\.(?:mp4|m4v|webm|mov|avi|mkv)(?:$|[?#])/i.test(mediaUrl.href)
          && !isEromeMediaStreamUrl(mediaUrl.href)
        ) continue;
        return mediaUrl.href;
      } catch { }
    }
    return null;
  }

  function enqueueEromeSizeProbe(card) {
    const mediaUrl = getEromeCardMediaUrl(card);
    if (!mediaUrl) return;

    card.dataset.nvsMediaUrl = mediaUrl;
    if (state.eromeSizeCache.has(mediaUrl)) {
      const sizeMb = state.eromeSizeCache.get(mediaUrl);
      if (sizeMb) applyEromeCardSize(card, sizeMb);
      return;
    }

    let job = state.eromeSizeJobs.get(mediaUrl);
    if (!job) {
      job = { mediaUrl, referer: location.href, cards: new Set() };
      state.eromeSizeJobs.set(mediaUrl, job);
      state.eromeSizeQueue.push(job);
    }
    job.cards.add(card);
    processEromeSizeQueue();
  }

  function processEromeSizeQueue() {
    while (state.eromeSizeActive < CFG.maxConcurrent && state.eromeSizeQueue.length) {
      const job = state.eromeSizeQueue.shift();
      state.eromeSizeActive++;
      chrome.runtime.sendMessage({
        type: 'PROBE_MEDIA_SIZE',
        url: job.mediaUrl,
        referer: job.referer,
      }, (response) => {
        state.eromeSizeActive--;
        const sizeMb = Number(response?.sizeMb || 0);
        const validSizeMb = Number.isFinite(sizeMb) && sizeMb > 0 ? sizeMb : null;
        state.eromeSizeCache.set(job.mediaUrl, validSizeMb);
        state.eromeSizeJobs.delete(job.mediaUrl);
        if (validSizeMb) {
          for (const card of job.cards) applyEromeCardSize(card, validSizeMb);
        }
        processEromeSizeQueue();
      });
    }
  }

  function applyEromeCardSize(card, sizeMb) {
    const meta = {
      ...(state.cardMeta.get(card) || {}),
      sizeMb,
      sizeText: formatSizeMb(sizeMb),
      sizeExact: true,
    };
    state.cardMeta.set(card, meta);
    updateBadge(card.querySelector('.nvs-badge'), card, meta);
  }

  // Walk up from a redgifs media element to the tile container — the ancestor
  // that still maps to a single gif (its thumbnail id stays constant) and has a
  // reasonable card size. Stop before hitting the whole grid.
  function findRedgifsTile(el) {
    const startId = redgifsWatchUrlFromCard(el.parentElement || el) || redgifsWatchUrlFromCard(el);
    let node = el;
    let best = el;
    let steps = 0;
    while (node && steps < 6) {
      steps++;
      const rect = node.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      if (rect.width > vw * 0.6 || rect.height > vh * 0.9) break; // too big = grid
      if (rect.width > 90 && rect.height > 90) {
        // don't merge two different gifs: bail if this node contains 2+ distinct thumbs
        const thumbs = node.querySelectorAll('img[src*="redgifs.com"], video[poster*="redgifs.com"]');
        if (thumbs.length > 1) break;
        best = node;
        // once we also have the caption text, this is the full card
        if ((node.textContent || '').trim().length > 8) return node;
      }
      node = node.parentElement;
    }
    return best;
  }

  function findCardContainer(link) {
    if (isDrTuberPage() && link?.matches?.('a.th.ch-video[href*="/video/"]')) {
      return link;
    }
    if (isPornonePage() && link?.matches?.('a.videocard[href]')) {
      return link;
    }
    if (isCumStPage() && link?.matches?.('a.cv-cell[href*="/post/"]')) {
      return link;
    }
    if (isLeakedzonePage()) {
      if (link.matches?.('a.block, .media-items a[href*="/video/"], .media-items a[href*="/short/"]')) {
        return link;
      }
      const card = link.closest?.('.media-items a, a.block');
      if (card) return card;
    }

    if (isPimpBunnyPage()) {
      const root = link.closest(window.NVSPimpBunnyListing.cardSelector);
      if (root) return root.parentElement?.classList.contains('col') ? root.parentElement : root;
    }
    if (isXVideosPage()) {
      const root = link.closest(window.NVSXvideosListing.cardSelector);
      if (root) return root;
    }
    if (isSpankBangPage()) {
      const root = link.closest?.(window.NVSSpankBangListing.cardSelector);
      if (root && !root.closest('.js-forced-layout')) return root;
      return null;
    }
    if (isXHamsterPage()) {
      const card = link.closest('.thumb-list__item, .video-thumb, [data-video-id]');
      if (card && card.querySelector('img, picture, video')) return card;
    }
    if (isXxbritsPage()) {
      const card = findXxbritsCardContainer(link);
      if (card) return card;
    }

    if (isCamwhoresPage()) {
      const card = findCamwhoresCardContainer(link);
      if (card) return card;
    }

    if (isFapFolderPage() && link?.matches?.('a.pg_video[href*="/posts/"]')) {
      return link;
    }

    if (isFreeusePornPage() && link?.matches?.('a[href*="/video/"]')) {
      return link;
    }

    if (isCyberLeaksPage() && link?.matches?.('a[href*="/post/"]')) {
      return link;
    }

    if (isXXXVideoPage()) {
      const card = link.closest('.item.thumb, .item');
      if (card) return card;
    }

    if (isTube8Page()) {
      const card = link.closest('article.video-box, .video-box, .thumb_box');
      if (card) return card;
    }

    if (isSorryMotherPage() || isFigToPage()) {
      if (link?.matches?.('a.bb-popular-creator')) return link;
      const card = link.closest('article.bb-card, .bb-card, .bb-popular-unlocks__item, article');
      if (card) return card;
    }

    if (isPureGirlPage() && link?.matches?.('a[href*="/post/"]')) {
      return link;
    }

    if (isHdSexPage()) {
      const card = link.closest('.video');
      if (card) return card;
    }

    if (isBravoTubePage()) {
      const card = link.closest('span.item, .item');
      if (card) return card;
    }

    if (isPornHoarderPage()) {
      const card = link.closest('.video-card, .video-item, .video, .thumb, article, .item');
      if (card) return card;
    }

    if (isPorneecPage()) {
      const card = link.closest('article.thumb-block, .video-preview-item, .thumb-block');
      if (card) return card;
    }

    let el = link.parentElement;
    const MAX_UP = 7;
    let steps = 0;
    let bestCandidate = el;

    while (el && steps < MAX_UP) {
      steps++;
      const hasImg = !!el.querySelector('img') || hasBackgroundThumbnail(el);
      const rect = el.getBoundingClientRect();
      const isReasonableSize = rect.width > 80 && rect.height > 60;

      if (hasImg && isReasonableSize) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        // Ak sme narazili na príliš veľký kontajner (napr. celú mriežku videí)
        if (rect.width > vw * 0.5 || rect.height > vh * 0.8) {
          break; // Zastavíme, nechceme vrátiť celú stránku
        }

        bestCandidate = el;

        // Ak tento element už obsahuje aj nejaký zmysluplný text (napr. nadpis, čas),
        // tak sme zrejme našli skutočnú kartu a nie len obal obrázka.
        const text = el.textContent.trim();
        if (text.length > 10) {
          // Máme obrázok aj text! Skúsime ísť ešte jeden level pre istotu (niekedy je text v sub-div)
          // ale bestCandidate už je bezpečne uložený.
        }
      }
      el = el.parentElement;
    }

    return bestCandidate || link.parentElement;
  }

  function findXxbritsCardContainer(node) {
    if (!node) return null;
    const th = node.matches?.('.th') ? node : node.closest?.('.th');
    if (th && !th.classList.contains('avd') && getCamwhoresVideoUrlFromNode(th)) return th;
    return null;
  }

  function findCamwhoresCardContainer(node) {
    if (!node) return null;
    const direct = node.matches?.('.item, .video-item') ? node : node.closest?.('.list-videos .item, .video-list .video-item, .videos-block .item, .thumbs-block .item, .item, .video-item');
    if (direct && getCamwhoresVideoUrlFromNode(direct)) return direct;

    let el = node.parentElement;
    let best = null;
    let steps = 0;
    while (el && steps < 6) {
      steps++;
      if (el === document.body || el === document.documentElement) break;
      const rect = el.getBoundingClientRect();
      const hasVideo = !!getCamwhoresVideoUrlFromNode(el);
      const hasMedia = !!el.querySelector?.('img, picture, video, [style*="background-image"]');
      if (hasVideo && hasMedia && rect.width >= 90 && rect.height >= 70) {
        best = el;
        if (el.matches?.('.item, .video-item')) return el;
      }
      if (rect.width > window.innerWidth * 0.7 || rect.height > window.innerHeight * 0.9) break;
      el = el.parentElement;
    }
    return best;
  }

  function getCamwhoresVideoUrlFromNode(node) {
    if (!node) return null;
    const links = [
      ...(node.matches?.('a[href]') ? [node] : []),
      ...((node.querySelectorAll?.('a[href]')) || [])
    ];
    for (const link of links) {
      const href = link.href || link.getAttribute?.('href') || '';
      if (!/\/videos\/\d+\//i.test(href)) continue;
      try {
        const url = new URL(href, location.origin);
        url.hash = '';
        return url.href;
      } catch { }
    }
    return null;
  }

  /**
   * Ohodnotí kartu — čím vyšší score, tým istejšie je to video karta.
   */
  function scoreCard(card) {
    let score = 0;

    if (isEromeVideoListingPage()) {
      const hasVideoLink = [...card.querySelectorAll('a[href]')].some((link) => isEromeListingVideoLink(link));
      if ((hasVideoLink && (card.querySelector('img, picture, video') || hasBackgroundThumbnail(card)))
        || card.querySelector('video, [data-video-src]')) score += 2;
    }

    // Redgifs: tiles carry the gif id in the thumbnail filename (no anchor / no
    // duration text). If we can derive a /watch/<id> URL, it's a real gif tile.
    if (isRedgifsPage() && redgifsWatchUrlFromCard(card)) {
      score += 2;
    }

    // +1 za obrázok (vrátane <picture>/<video poster> ktoré redgifs používa)
    if (card.querySelector('img, picture, video') || hasBackgroundThumbnail(card)) score++;

    // +1 za text s duration patternom (MM:SS, HH:MM:SS, alebo "13 min", "1h 5m")
    const text = card.textContent || '';
    if (/\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(text) || /\b\d+\s*(min|m|sec|s)\b/i.test(text)) score++;

    // +1 za link so video URL
    // Some listings (notably DrTuber) use the anchor as the card itself.
    // querySelector() only inspects descendants, so include the card when it
    // is already a video link.
    const link = card.matches?.('a[href]') ? card : card.querySelector('a[href]');
    if (link && isVideoUrl(link.href)) score++;
    // On DrTuber the result anchor itself is a complete, canonical card. Its
    // image can be lazy and it can lack a visible duration/HD badge, so avoid
    // rejecting valid search hits merely because those optional clues are not
    // currently mounted in the DOM.
    if (isDrTuberPage() && card.matches?.('a.th.ch-video[href*="/video/"]')) score += 2;
    if (isPornonePage() && card.matches?.('a.videocard[href]') && !card.classList.contains('customnative') && !card.querySelector('.adlabel') && isVideoUrl(card.href)) score += 2;
    if (isSxyprnPage() && (card.matches?.('.post_el_small') || card.querySelector?.('a[href*="/post/"]'))) score += 2;
    if (isFapFolderPage() && (card.matches?.('a.pg_video[href*="/posts/"]') || card.querySelector('a.pg_video[href*="/posts/"]'))) score += 2;
    if (/(^|\.)beeg\.com$/i.test(location.hostname) && link && /^\/-?\d{5,}\/?$/i.test(link.getAttribute('href'))) score += 2;
    if (isEpawgPage() && card.matches?.('.list-videos .item') && card.querySelector('a[href*="/videos/"]')) score += 2;
    if (isFreeusePornPage() && card.matches?.('a[href*="/video/"]') && isVideoUrl(card.href)) score += 2;
    if (isCyberLeaksPage() && card.matches?.('a[href*="/post/"]') && isVideoUrl(card.href)) score += 2;
    if (isXXXVideoPage() && card.matches?.('.item') && card.querySelector('a[href*="/videos/"]')) score += 2;
    if (isTube8Page() && card.matches?.('article.video-box, .video-box, .thumb_box') && card.querySelector('a[href*="/porn-video/"]')) score += 2;
    if (isSorryMotherPage() && (card.matches?.('a.bb-popular-creator[href*="/pornleaks/"]') || card.querySelector('a[href*="/pornleaks/"]'))) score += 2;
    if (isFigToPage() && (card.matches?.('a.bb-popular-creator[href*="/onlyfans-leaks/"]') || card.querySelector('a[href*="/onlyfans-leaks/"]'))) score += 2;
    if (isPureGirlPage() && card.matches?.('a[href*="/post/"]') && isVideoUrl(card.href)) score += 2;
    if (isHdSexPage() && card.matches?.('.video') && card.querySelector('a[href*="/video/"]')) score += 2;
    if (isBravoTubePage() && card.matches?.('.item') && card.querySelector('a[href*="/video-"]')) score += 2;
    if (isPornHoarderPage() && (card.matches?.('a[href*="/watch/"], a[href*="/pornvideo/"], a[href*="/video/"], a[href*="/videos/"]') || card.querySelector('a[href*="/watch/"], a[href*="/pornvideo/"], a[href*="/video/"], a[href*="/videos/"]'))) score += 2;
    if (isPorneecPage() && card.matches?.('article.thumb-block, .video-preview-item, .thumb-block') && card.querySelector('.post-thumbnail')) score += 2;
    if (isCumStPage() && card.matches?.('a.cv-cell[href*="/post/"]') && isVideoUrl(card.href) && isCumStVideoCard(card)) score += 2;

    // +1 za duration selector
    if (CFG.durationSelectors.some(sel => card.querySelector(sel))) score++;

    // +1 za quality badge (HD, 4K, 1080p, atď.)
    if (/\b(HD|4K|1080p?|720p?|480p?|2160p?)\b/i.test(text)) score++;

    // -1 ak je to veľmi malý element
    const rect = card.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 70) score--;

    return score;
  }

  // ── Scan & Process Cards ──────────────────────────────────

  function scan() {
    if (state.disabled) return;
    const cards = findVideoCards();
    let newCount = 0;
    const sessionSel = getSessionSelection();

    if (isEromePage() && !isEromeAlbumListing()) {
      for (const card of cards) enqueueEromeSizeProbe(card);
    }

    // Redgifs diagnostics — helps confirm detection when badges don't appear.
    if (isRedgifsPage()) {
      const rgMedia = document.querySelectorAll('img[src*="redgifs.com"], video[poster*="redgifs.com"]').length;
      const sample = cards[0] ? getVideoUrlFromCard(cards[0]) : '(no card)';
      console.log(`[NVS redgifs] media-els=${rgMedia} cards-detected=${cards.length} sample-url=${sample}`);
    }

    // Zbieraj nové karty najprv, aby sme oddelili layout-čítanie od DOM-zápisu
    // (inak striedanie getComputedStyle/getBoundingClientRect s injectBadge spôsobí
    // layout thrashing → zamrznutie pri 100+ kartách naraz).
    const fresh = [];
    let droppedPaid = 0;
    for (const card of cards) {
      if (discardPaidCard(card)) { droppedPaid++; continue; }
      if (card.getAttribute(CFG.processedAttr) === '1') continue;
      card.setAttribute(CFG.processedAttr, '1');
      card.dataset.nvsSortIndex = String(state.nextSortIndex++);
      fresh.push(card);
    }

    if (!fresh.length) {
      if (droppedPaid) updateImportBar();
      return 0;
    }

    // FÁZA 1 — čítanie layoutu naraz (žiadne DOM zápisy medzi tým).
    const vh = window.innerHeight;
    const reads = fresh.map((card) => {
      const rect = card.getBoundingClientRect();
      const pos = window.getComputedStyle(card).position;
      return { rect, isStatic: pos === 'static' };
    });

    // FÁZA 2 — DOM zápisy + enqueue (bez ďalších layout čítaní v cykle).
    for (let i = 0; i < fresh.length; i++) {
      const card = fresh[i];
      const { rect, isStatic } = reads[i];

      if (isStatic) card.style.position = 'relative';
      if (isArchvePage()) card.classList.add('nvs-archve-card');
      injectSelector(card);
      injectBadge(card, null);
      if (state.filterDuration !== 'all') {
        applyFilterToCard(card, state.filterDuration);
      }

      const url = getVideoUrlFromCard(card);

      if (url && sessionSel.has(url) && !state.selected.has(card)) {
        state.selected.add(card);
        card.classList.add('nvs-card-selected');
        const cb = card.querySelector('.nvs-checkbox');
        if (cb) cb.setAttribute('aria-checked', 'true');
      }
      if (url) {
        const nearViewport = rect.top < vh + 800 && rect.bottom > -800;
        if (nearViewport || isArchvePage() || isCamwhoresPage() || isXxbritsPage() || isSxyprnPage() || isInternetChicksPage()) {
          enqueue(card, url);
        } else {
          getLazyObserver().observe(card);
        }
      } else {
        getLazyObserver().observe(card);
      }

      newCount++;
    }

    // Pre sxyprn / InternetChicks: okamžite získať uložené metadáta z diskovej cache (aj po týždni)
    if (newCount > 0 && (isSxyprnPage() || isInternetChicksPage() || isSpankBangPage())) {
      const urlsToWarm = fresh.map(getVideoUrlFromCard).filter(u => u && !state.fetchCache.has(u));
      if (urlsToWarm.length) {
        chrome.runtime.sendMessage({ type: 'GET_CACHED_META', urls: urlsToWarm }, (res) => {
          const results = res?.results;
          if (!results || !Object.keys(results).length) return;
          for (const [u, meta] of Object.entries(results)) {
            if (!meta) continue;
            state.fetchCache.set(u, meta);
            for (const c of findCardsByUrl(u)) {
              updateBadge(c.querySelector('.nvs-badge'), c, meta);
            }
          }
        });
      }
    }

    // Pre karty kde DOM nebol hotový (SPA, lazy render) — znova skúsiť po chvíli
    if (newCount > 0) {
      updateImportBar();
      genericListingPlayer?.refresh?.();
      setTimeout(reinspectLoadingBadges, 1500);
      setTimeout(reinspectLoadingBadges, 4000);
    }

    return newCount;
  }

  /**
   * Pre karty kde extractCardMeta nenašlo nič (lebo DOM nebol hotový) —
   * znova skúsi extrahovať a aktualizuje badge ak teraz niečo nájde.
   */
  function reinspectLoadingBadges() {
    const loadingBadges = document.querySelectorAll('.nvs-badge-loading');
    for (const badge of loadingBadges) {
      const card = badge.closest(`[${CFG.processedAttr}="1"]`);
      if (!card) continue;
      const meta = extractCardMeta(card);
      const text = buildBadgeText(meta, true);
      if (text) {
        badge.classList.remove('nvs-badge-loading');
        badge.classList.add('nvs-badge-card-data');
        const textEl = badge.querySelector('.nvs-badge-text');
        if (textEl) textEl.textContent = text;
      }
    }
  }

  function getFirstLivePort() {
    for (const port of ['8000', '8001', '8002']) {
      if (state.portHealth[port] === true) return port;
    }
    for (const port of ['8000', '8001', '8002']) {
      if (state.portHealth[port] !== false) return port;
    }
    return '8000';
  }

  function injectGofileInlineTools(card) {
    if (card.querySelector('.nvs-gofile-inline-tools')) return;

    const fileName = card.dataset.nvsFileName || getCardTitle(card) || 'video';

    let titleEl = null;
    const candidates = card.querySelectorAll('span, div, p, a');
    for (const el of candidates) {
      if (el.children.length === 0 && el.textContent.includes(fileName)) {
        titleEl = el;
        break;
      }
    }
    if (!titleEl) {
      for (const el of candidates) {
        if (el.textContent.includes(fileName) && el.children.length <= 2) {
          titleEl = el;
          break;
        }
      }
    }

    const container = document.createElement('div');
    container.className = 'nvs-gofile-inline-tools';

    const cb = document.createElement('div');
    cb.className = 'nvs-checkbox nvs-gofile-checkbox';
    cb.setAttribute('role', 'checkbox');
    cb.setAttribute('aria-checked', state.selected.has(card) ? 'true' : 'false');
    cb.title = 'Označiť pre Nexus Import';
    cb.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleCard(card, cb);
    });

    const btnImport = document.createElement('button');
    btnImport.type = 'button';
    btnImport.className = 'nvs-gofile-btn-import';
    btnImport.innerHTML = `
      <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
      <span>Import</span>
    `;
    btnImport.title = `Importovať "${fileName}" priamo do Nexus Dashboardu`;
    btnImport.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const url = getVideoUrlFromCard(card);
      const meta = state.fetchCache.get(url) || {};
      const cardMeta = extractCardMeta(card);
      const singleItem = {
        url: meta.streamUrl || url,
        title: fileName,
        sourceUrl: location.href,
        sourceScope: 'collection',
        thumbnail: meta.thumbnail || getCardThumbnail(card) || '',
        duration: cardMeta.duration || meta.duration || '',
        sizeText: cardMeta.sizeText || meta.sizeText || null,
        sizeMb: cardMeta.sizeMb || meta.sizeMb || null,
        file_size_mb: cardMeta.sizeMb || meta.sizeMb || null,
        date: cardMeta.date || meta.date || null,
        addedAt: new Date().toISOString()
      };
      const port = getFirstLivePort();
      btnImport.disabled = true;
      const span = btnImport.querySelector('span');
      if (span) span.textContent = 'Importujem...';

      chrome.runtime.sendMessage({ type: 'IMPORT_TO_NEXUS', port, items: [singleItem] }, (res) => {
        const runtimeError = chrome.runtime.lastError;
        const outcome = res?.success && !runtimeError ? summarizeImport([singleItem], res.data) : null;
        if (outcome?.completedIndexes.length) {
          btnImport.classList.add('nvs-btn-success');
          if (span) span.textContent = '✓ Hotovo';
          showImportResult(outcome.message, 'success');
        } else {
          btnImport.disabled = false;
          if (span) span.textContent = 'Import';
          showImportResult(outcome?.message || `Import nepotvrdený: ${runtimeError?.message || res?.error || 'Import zlyhal'}`, 'error');
        }
      });
    });

    container.appendChild(cb);
    container.appendChild(btnImport);

    const openFileBtn = titleEl?.closest('button, a');
    if (openFileBtn && openFileBtn.parentElement === card) {
      openFileBtn.insertAdjacentElement('afterend', container);
    } else if (titleEl && titleEl.parentElement && !openFileBtn) {
      titleEl.insertAdjacentElement('afterend', container);
    } else {
      card.appendChild(container);
    }
  }

  // ── Selector Injection ────────────────────────────────────

  function injectSelector(card) {
    if (card.dataset.nvsGofile === '1') {
      injectGofileInlineTools(card);
      return;
    }
    if (card.querySelector('.nvs-selector-wrap')) return;

    const wrap = document.createElement('div');
    wrap.className = 'nvs-selector-wrap';

    const box = document.createElement('div');
    box.className = 'nvs-checkbox';
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', 'false');
    box.tabIndex = 0;
    box.setAttribute('aria-label', `Vybrať video: ${getCardTitle(card) || 'video'}`);
    box.title = 'Vybrať pre import do Nexus';

    wrap.appendChild(box);
    card.appendChild(wrap);

    box.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleCard(card, box);
    });
    box.addEventListener('keydown', (e) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault(); e.stopPropagation(); toggleCard(card, box);
    });

    // Náhľad je druhá, veľká selekčná zóna. Informácie pod náhľadom zostávajú
    // nedotknuté, takže klik na titulok/metadáta naďalej otvorí detail videa.
    const preview = getThumbnailSelectorHost(card);
    if (!preview) return;

    preview.classList.add('nvs-thumbnail-selector');
    preview.title = 'Vybrať pre import do Nexus';

    // Capture je potrebný pre stránky, ktoré majú náhľad zabalený do <a>:
    // zrušíme navigáciu skôr, než ju spracuje odkaz stránky.
    card.addEventListener('click', (e) => {
      // Ignoruj ovládacie prvky, checkbox a akékoľvek odznaky (zdroj, kvalita, dĺžka, dátum, popover)
      if (e.button !== 0 || e.target.closest('.nvs-selector-wrap, .nvs-wh-play, .nvs-badge, .nvs-source-badge, .nvs-badge-quality, .nvs-duration-badge, .nvs-server-popover')) return;
      if (!preview.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      toggleCard(card, box);
    }, true);
  }

  /**
   * Vráti iba vizuálnu časť videokarty, nie celý kontajner karty. Vďaka tomu
   * dolný titulok a údaje môžu ďalej fungovať ako bežný link na detail.
   */
  function getThumbnailSelectorHost(card) {
    if (card.dataset.nvsTurboId && card.querySelector('.thTurboPreview-button, iframe')) {
      return null;
    }
    for (const selector of CFG.imgWrapSelectors) {
      const host = card.querySelector(selector);
      if (host) return host;
    }

    const media = card.querySelector('img, picture, video');
    if (!media) return null;

    // Preferuj tesný obal média (často je to samotný odkaz s náhľadom), ale
    // nikdy neoznač celý card — ten môže obsahovať aj spodný informačný panel.
    const parent = media.parentElement;
    if (parent && parent !== card) {
      const parentRect = parent.getBoundingClientRect();
      const mediaRect = media.getBoundingClientRect();
      if (parentRect.height > 0 && parentRect.height <= mediaRect.height + 40) return parent;
    }
    return media;
  }

  function toggleCard(card, checkbox) {
    if (card.dataset.nvsTurboId && turboOverview?.toggle(card)) return;
    if (isPimpBunnyPage()) {
      setPimpBunnySelection(card, !state.selected.has(card));
      updateImportBar(); return;
    }
    const isSelected = state.selected.has(card);
    const url = getVideoUrlFromCard(card);
    if (isSelected) {
      state.selected.delete(card);
      card.classList.remove('nvs-card-selected');
      checkbox.setAttribute('aria-checked', 'false');
      if (url) removeFromSessionSelection(url);
    } else {
      state.selected.add(card);
      card.classList.add('nvs-card-selected');
      checkbox.setAttribute('aria-checked', 'true');
      if (url) addToSessionSelection(url);
    }
    updateImportBar();
  }

  let genericListingPlayer = null;

  function parsePornonePlaybackSources(html, pageUrl) {
    const seenUrls = new Set();
    const sources = [];
    const addCandidate = (rawUrl, resAttr = 0) => {
      if (!rawUrl) return;
      const decoded = String(rawUrl)
        .replace(/\\u002F/gi, '/')
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&')
        .trim();
      let absUrl = '';
      try {
        const parsed = new URL(decoded, pageUrl);
        if (!/^https?:$/i.test(parsed.protocol)) return;
        if (/preview|trailer|sample|\.jpg/i.test(parsed.pathname)) return;
        if (!/\.(?:mp4|m3u8)(?:[?#]|$)/i.test(parsed.pathname)) return;
        absUrl = parsed.href;
      } catch {
        return;
      }
      if (seenUrls.has(absUrl)) return;
      seenUrls.add(absUrl);

      const urlHeight = parseInt((absUrl.match(/_(\d{3,4})x(\d{3,4})(?:_|\.)/i) || [])[2] || '0', 10)
        || parseInt((absUrl.match(/(?:[_/-]|=)(\d{3,4})p(?:[._/]|$)/i) || [])[1] || '0', 10)
        || 0;
      const bitrate = parseInt((absUrl.match(/_(\d+)k\.mp4/i) || [])[1] || '0', 10) || 0;
      // PornOne labels 720x406 as 480p and occasionally labels 1920x1080 as 720p.
      const height = urlHeight >= 720 ? urlHeight : (resAttr || urlHeight);
      const isHls = /\.m3u8(?:[?#]|$)/i.test(new URL(absUrl).pathname);
      sources.push({
        url: absUrl,
        type: isHls ? 'hls' : 'file',
        height,
        quality: height ? `${height}P${isHls ? ' · HLS' : ''}` : (isHls ? 'HLS' : 'HD'),
        bitrate,
        resAttr,
      });
    };

    for (const match of String(html || '').matchAll(/<source\b[^>]*>/gi)) {
      const tag = match[0];
      const rawSrc = (tag.match(/\bsrc=["']([^"']+)["']/i) || [])[1];
      const resAttr = parseInt(
        (tag.match(/\bres=["'](\d+)["']/i) || tag.match(/\blabel=["'](\d+)p?["']/i) || [])[1] || '0',
        10
      ) || 0;
      addCandidate(rawSrc, resAttr);
    }

    if (!sources.length) {
      const ldUrl = (String(html || '').match(/"contentUrl"\s*:\s*"([^"]+\.(?:mp4|m3u8)[^"]*)"/i) || [])[1];
      if (ldUrl) addCandidate(ldUrl, 0);
    }

    sources.sort((a, b) => (b.height - a.height) || (b.bitrate - a.bitrate) || (b.resAttr - a.resAttr));
    return sources.map(({ url, type, height, quality }) => ({ url, type, height, quality }));
  }

  async function resolvePornonePlaybackSources(videoUrl, signal) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let parsedUrl;
    try { parsedUrl = new URL(videoUrl, location.href); } catch { return []; }
    if (!/(^|\.)pornone\.com$/i.test(parsedUrl.hostname)) return [];
    const fetchUrl = parsedUrl.origin === location.origin
      ? parsedUrl.href
      : `${location.origin}${parsedUrl.pathname}${parsedUrl.search}`;
    const res = await fetch(fetchUrl, { credentials: 'include', signal });
    if (!res.ok) return [];
    const html = await res.text();
    return parsePornonePlaybackSources(html, res.url || fetchUrl);
  }

  function createGenericListingPlayerAdapter() {
    const label = (normalizeHost(location.hostname) || 'NEXUS').toUpperCase();
    const fetchManifestText = async (url, signal) => {
      try {
        const res = await fetch(url, { credentials: 'include', signal });
        if (res.ok) {
          const text = await res.text();
          if (/^\s*#EXTM3U/i.test(text)) return { text, url: res.url || url };
        }
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
      }
      const bg = await chrome.runtime.sendMessage({ type: 'NVS_FETCH_MANIFEST', url });
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (bg?.ok && typeof bg.text === 'string') return { text: bg.text, url: bg.url || url };
      return null;
    };

    return {
      label,
      cardSelector: `[${CFG.processedAttr}="1"]`,
      allowUnsandboxedEmbed: true,
      collect(root) {
        const seen = new Set();
        const out = [];
        const scope = root || document;
        for (const card of scope.querySelectorAll(`[${CFG.processedAttr}="1"][data-nvs-url]`)) {
          if (card.closest('#nvs-sort-panel, #nvs-import-bar, #nvs-workbench-launch, #nvs-wh-player')) continue;
          if (card.hidden || card.classList.contains('nvs-hidden') || card.closest('[hidden], .nvs-hidden')) continue;
          if (getComputedStyle(card).display === 'none') continue;
          if (card.getClientRects && !card.getClientRects().length) continue;
          const url = String(card.dataset.nvsUrl || '').trim();
          if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
          if (!card.querySelector('img, picture, video, [style*="background-image"]')) continue;
          seen.add(url);
          const title = getCardTitle(card, url)
            || card.querySelector('.video-title, .titlethumb, .title, h2, h3, a[title]')?.textContent?.trim()
            || 'Video';
          out.push({ url, title: String(title).trim().slice(0, 160), card });
        }
        return out;
      },
      playHost(card) {
        const host = card.querySelector('.nvs-thumbnail-selector') || getThumbnailSelectorHost(card) || card;
        if (!host || host.tagName === 'IMG' || host.tagName === 'VIDEO') {
          return host?.parentElement || card;
        }
        return host;
      },
      embedUrl(entry) {
        return entry?.embedUrl || '';
      },
      async probeSize(url, referer) {
        const cached = (referer && (state.fetchCache.get(referer) || state.cardMeta.get(findCardsByUrl(referer)[0]))) || null;
        if (!/\.m3u8(?:[?#]|$)/i.test(String(url || ''))) {
          try {
            const probed = await chrome.runtime.sendMessage({ type: 'PROBE_MEDIA_SIZE', url, referer });
            if (probed?.sizeBytes > 0) return { sizeBytes: probed.sizeBytes };
          } catch { }
        }
        if (Number(cached?.sizeMb || 0) > 0) {
          return { sizeBytes: Math.round(Number(cached.sizeMb) * 1024 * 1024), estimated: Boolean(cached.sizeEstimated) };
        }
        return { sizeBytes: null };
      },
      async resolve(entry, signal) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (isPornonePage()) {
          const pornoneSources = await resolvePornonePlaybackSources(entry.url, signal);
          if (pornoneSources.length) {
            const expanded = [];
            for (const source of pornoneSources) {
              if (source.type !== 'hls') {
                expanded.push(source);
                continue;
              }
              try {
                const manifest = await fetchManifestText(source.url, signal);
                const parsed = manifest?.text && window.NVSMultiSitePlayer?.variants
                  ? window.NVSMultiSitePlayer.variants(manifest.text, manifest.url)
                  : [];
                expanded.push(...(parsed.length ? parsed : [source]));
              } catch (err) {
                if (err?.name === 'AbortError') throw err;
                expanded.push(source);
              }
            }
            return expanded;
          }
        }
        let meta = state.fetchCache.get(entry.url) || state.cardMeta.get(entry.card) || null;
        if (!meta?.streamUrl && !meta?.embedUrl) {
          const cardExtUrls = isSxyprnPage() && entry.card ? getCardExtUrls(entry.card) : [];
          const resp = await chrome.runtime.sendMessage({ type: 'FETCH_META', url: entry.url, force: false, cardExtUrls });
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          if (resp?.meta) {
            meta = resp.meta;
            state.fetchCache.set(entry.url, meta);
            for (const c of findCardsByUrl(entry.url)) {
              updateBadge(c.querySelector('.nvs-badge'), c, meta);
            }
          }
        }
        if (meta?.embedUrl) entry.embedUrl = meta.embedUrl;
        const streamUrl = String(meta?.streamUrl || '').trim();
        if (!streamUrl || !/^https?:\/\//i.test(streamUrl)) return [];

        const height = Number(String(meta?.quality || '').match(/\d{3,4}/)?.[0]) || 0;
        const qualityLabel = meta?.quality || (height ? `${height}P` : 'HD');
        if (/\.m3u8(?:[?#]|$)/i.test(streamUrl)) {
          try {
            const manifest = await fetchManifestText(streamUrl, signal);
            const parsed = manifest?.text && window.NVSMultiSitePlayer?.variants
              ? window.NVSMultiSitePlayer.variants(manifest.text, manifest.url)
              : [];
            if (parsed.length) return parsed;
          } catch (err) {
            if (err?.name === 'AbortError') throw err;
          }
          return [{ url: streamUrl, type: 'hls', height, quality: `${qualityLabel} · HLS` }];
        }
        return [{ url: streamUrl, type: 'file', height, quality: qualityLabel }];
      },
    };
  }

  function ensureGenericListingPlayer(panel) {
    if (!panel || !window.NVSListingPlayer) return null;
    if (window.NVSMultiSitePlayer?.site?.(location.href)) return null;
    if (/(^|\.)whoreshub\.com$/i.test(location.hostname)) return null;
    if (typeof isMegaPage === 'function' && isMegaPage()) return null;
    if (typeof isGofilePage === 'function' && isGofilePage()) return null;
    if (!genericListingPlayer) {
      genericListingPlayer = window.NVSListingPlayer.attach(document.body, panel, createGenericListingPlayerAdapter());
    }
    return genericListingPlayer;
  }

  // ── Sort Panel ────────────────────────────────────────────

  function injectSortPanel() {
    if (document.getElementById('nvs-sort-panel')) return;
    // Gallery supplies the XVideos import UI. Keep this content script active
    // for its metadata scanner, selectors and badges, but avoid a second panel.
    if (isXVideosPage()) return;
    if ((isXHamsterPage() || isPimpBunnyPage() || isEromeAlbumListing() || isSpankBangPage()) && window.createNVSImportWorkbench) { createSiteImportWorkbench(); return; }

    const panel = document.createElement('div');
    panel.id = 'nvs-sort-panel';
    panel.innerHTML = `
      <span class="nvs-sort-label">Filter</span>
      <select id="nvs-filter-duration" title="Filtrovať podľa dĺžky">
        <option value="all">Všetky</option>
        <option value="short">&lt; 10 min</option>
        <option value="medium">10 - 30 min</option>
        <option value="long">&gt; 30 min</option>
        <option value="no-size">Bez veľkosti</option>
        <option value="no-date">Bez dátumu</option>
      </select>
      <span class="nvs-sort-label" style="margin-left: 8px;">Sort</span>
      <select id="nvs-sort-key" title="Zoradiť video karty">
        <option value="none">Pôvodne</option>
        <option value="quality">Kvalita</option>
        <option value="size">Veľkosť</option>
        <option value="duration">Duration</option>
        <option value="date">Dátum</option>
      </select>
      <button id="nvs-sort-dir" type="button" title="Prepnúť smer zoradenia"></button>
      <button id="nvs-sort-apply" type="button" title="Zoradiť teraz">↕ Sort</button>
      <button id="nvs-select-visible" type="button" class="nvs-btn-select-visible" title="Vybrať všetky zobrazené karty (rešpektuje aktívny filter)">✓ Vybrať</button>
      <div class="nvs-panel-sep"></div>
      <span id="nvs-load-label" class="nvs-sort-label" title="Načítať ďalšie stránky pod aktuálne (spojí ich, aby sort fungoval na všetkých)">Strany po</span>
      <input id="nvs-load-until" type="number" min="1" max="50" step="1" title="Načítať stránky až po toto číslo" />
      <select id="nvs-load-count" class="nvs-load-count" title="Koľko ďalších strán načítať naraz" hidden>
        <option value="2">+2</option>
        <option value="3">+3</option>
        <option value="5">+5</option>
        <option value="10">+10</option>
        <option value="15">+15</option>
      </select>
      <button id="nvs-load-pages" type="button" class="nvs-btn-load-pages" title="Načítať a pripojiť videá z ďalších strán">＋ Načítať</button>
      <button id="nvs-retry-missing" type="button" class="nvs-btn-retry-missing" title="Doplniť chýbajúce overenia serverov pre neúplné karty" style="display: none;">⚡ Doplniť chýbajúce</button>
      <span id="nvs-fetch-counter" class="nvs-fetch-counter" title="Načítané meta">0/0</span>
      <button id="nvs-panel-rescan" type="button" class="nvs-btn-panel-rescan" title="Znovu skenovať stránku">↺</button>
      <div class="nvs-panel-sep"></div>
      <button id="nvs-panel-disable" type="button" class="nvs-btn-panel-disable" title="Vypnúť extension na tejto stránke">⊘ Vypnúť</button>
      <button id="nvs-panel-close" type="button" class="nvs-btn-panel-close" title="Skryť panel">✕</button>
    `;
    document.body.appendChild(panel);

    const filterDur = panel.querySelector('#nvs-filter-duration');
    const select = panel.querySelector('#nvs-sort-key');
    const dirBtn = panel.querySelector('#nvs-sort-dir');
    const applyBtn = panel.querySelector('#nvs-sort-apply');

    select.value = state.sortKey;
    filterDur.value = state.filterDuration;

    filterDur.addEventListener('change', () => {
      state.filterDuration = filterDur.value;
      localStorage.setItem('nvs-filter-duration', state.filterDuration);
      applyFilter();
    });

    const updateDirButton = () => {
      dirBtn.textContent = state.sortDir === 'desc' ? '↓ Najväčšie' : '↑ Najmenšie';
      if (state.sortKey === 'quality') dirBtn.textContent = state.sortDir === 'desc' ? '↓ Najvyššia' : '↑ Najnižšia';
      if (state.sortKey === 'date') dirBtn.textContent = state.sortDir === 'desc' ? '↓ Najnovšie' : '↑ Najstaršie';
      if (state.sortKey === 'duration') dirBtn.textContent = state.sortDir === 'desc' ? '↓ Najdlhšie' : '↑ Najkratšie';
      if (state.sortKey === 'none') dirBtn.textContent = 'Pôvodné';
      dirBtn.disabled = state.sortKey === 'none';
      // Sort tlačidlo je VŽDY klikateľné — pri "Pôvodne" obnoví pôvodné poradie.
      applyBtn.disabled = false;
    };

    // Zmena sortovacieho kľúča — aktualizuje stav, ale nevykonáva zoradenie.
    select.addEventListener('change', () => {
      state.sortKey = select.value;
      // Pri prepnutí na merateľný kľúč resetni smer na "najväčšie" — to je čo user chce.
      if (state.sortKey !== 'none') {
        state.sortDir = 'desc';
        localStorage.setItem('nvs-sort-dir', state.sortDir);
      }
      localStorage.setItem('nvs-sort-key', state.sortKey);
      updateDirButton();
    });

    // Zmena smeru — prepne, ale nevykonáva zoradenie.
    dirBtn.addEventListener('click', () => {
      if (state.sortKey === 'none') return;
      state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
      localStorage.setItem('nvs-sort-dir', state.sortDir);
      updateDirButton();
    });

    // Manuálny sort — vždy klikateľné. Pri "Pôvodne" obnoví pôvodné poradie.
    applyBtn.addEventListener('click', () => {
      applySort();
    });

    // Vybrať len zobrazené karty (rešpektuje aktívny filter)
    panel.querySelector('#nvs-select-visible').addEventListener('click', () => {
      const cards = document.querySelectorAll(`[${CFG.processedAttr}="1"]:not(.nvs-hidden)`);
      let changed = false;
      for (const card of cards) {
        if (!state.selected.has(card)) {
          state.selected.add(card);
          card.classList.add('nvs-card-selected');
          const cb = card.querySelector('.nvs-checkbox');
          if (cb) cb.setAttribute('aria-checked', 'true');
          const url = getVideoUrlFromCard(card);
          if (url) addToSessionSelection(url);
          changed = true;
        }
      }
      if (changed) updateImportBar();
    });

    // Rescan priamo z panelu
    panel.querySelector('#nvs-panel-rescan').addEventListener('click', () => {
      if (window.__nvsRescan) window.__nvsRescan();
      else if (window.__nvsScan) window.__nvsScan();
    });

    // Doplniť chýbajúce servery pre neúplné karty (InternetChicks, SxyPrn apod.)
    const retryMissingBtn = panel.querySelector('#nvs-retry-missing');
    if (retryMissingBtn && (isInternetChicksPage() || isSxyprnPage())) {
      retryMissingBtn.style.display = 'inline-flex';
      retryMissingBtn.addEventListener('click', () => {
        retryMissingCards(retryMissingBtn);
      });
    }

    // Načítať ďalšie stránky pod aktuálne (spojenie strán pre sort naprieč všetkými)
    const loadInput = panel.querySelector('#nvs-load-until');
    const loadCount = panel.querySelector('#nvs-load-count');
    const loadBtn = panel.querySelector('#nvs-load-pages');
    if (loadInput) {
      const cur = getCurrentPageNumber();
      if (isXHamsterPage()) {
        panel.querySelector('#nvs-load-label').textContent = 'Počet načítaní';
        panel.querySelector('#nvs-load-label').title = 'Počet stlačení Show more related videos';
        loadInput.value = '1';
        loadInput.placeholder = '1';
      } else if (isXxbritsPage()) {
        panel.querySelector('#nvs-load-label').textContent = 'Stránok';
        panel.querySelector('#nvs-load-label').title = 'Koľko ďalších XXBrits strán načítať naraz';
        loadInput.hidden = true;
        if (loadCount) {
          loadCount.hidden = false;
          const saved = parseInt(localStorage.getItem('nvs-xxbrits-page-count') || '5', 10);
          loadCount.value = [2, 3, 5, 10, 15].includes(saved) ? String(saved) : '5';
          loadCount.addEventListener('change', () => {
            localStorage.setItem('nvs-xxbrits-page-count', loadCount.value);
          });
        }
      } else {
        loadInput.value = String(cur + 1); // predvyplň nasledujúcu stranu
        loadInput.placeholder = `≥${cur + 1}`;
      }
    }
    if (loadBtn) {
      loadBtn.addEventListener('click', () => {
        if (state.isLoadingPages) return;
        const target = isXxbritsPage()
          ? parseInt(loadCount?.value || loadInput?.value || '0', 10)
          : parseInt(loadInput?.value || '0', 10);
        loadPagesUntil(target);
      });
      loadInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); loadBtn.click(); }
      });
    }

    window.NVSWhoreshubListing?.attach(panel, { scan, hydrateLazyImages, showToast });
    window.NVSMultiSitePlayer?.start(panel);
    ensureGenericListingPlayer(panel);

    // Vypnúť extension na tejto stránke
    panel.querySelector('#nvs-panel-disable').addEventListener('click', () => {
      const host = normalizeHost(location.hostname);
      chrome.storage.sync.get({ disabledHosts: [] }, (data) => {
        const hosts = (data.disabledHosts || []).map(normalizeHost).filter(Boolean);
        if (!hosts.includes(host)) hosts.push(host);
        chrome.storage.sync.set({ disabledHosts: hosts }, () => {
          deactivateOnPage();
          showToast(`⊘ Vypnuté na ${host}`, 'error');
        });
      });
    });

    // Zavrieť / skryť panel
    panel.querySelector('#nvs-panel-close').addEventListener('click', () => {
      setSortPanelVisible(false, true);
      try { chrome.runtime.sendMessage({ action: 'panelHidden' }); } catch { }
    });

    updateDirButton();

    // Načítaj uložený stav viditeľnosti panelu pre tento host
    const host = normalizeHost(location.hostname);
    const localHidden = localStorage.getItem('nvs-panel-hidden') === '1';
    if (localHidden) panel.classList.add('nvs-panel-hidden');

    chrome.storage.sync.get({ hiddenPanelHosts: [] }, (data) => {
      const hiddenHosts = (data.hiddenPanelHosts || []).map(normalizeHost);
      const isHidden = hiddenHosts.includes(host);
      if (isHidden) {
        panel.classList.add('nvs-panel-hidden');
        try { localStorage.setItem('nvs-panel-hidden', '1'); } catch {}
      } else if (!localHidden) {
        panel.classList.remove('nvs-panel-hidden');
        try { localStorage.setItem('nvs-panel-hidden', '0'); } catch {}
      }
    });
  }

  function isSortPanelVisible() {
    const panel = document.getElementById('nvs-sort-panel');
    if (!panel) return true;
    return !panel.classList.contains('nvs-panel-hidden');
  }

  function setSortPanelVisible(visible, syncToStorage = true) {
    if (importWorkbench) { importWorkbench.visible(visible, syncToStorage); return; }
    const panel = document.getElementById('nvs-sort-panel');
    if (!panel) return;
    panel.classList.toggle('nvs-panel-hidden', !visible);
    try {
      localStorage.setItem('nvs-panel-hidden', visible ? '0' : '1');
    } catch {}

    if (syncToStorage) {
      const host = normalizeHost(location.hostname);
      if (host) {
        chrome.storage.sync.get({ hiddenPanelHosts: [] }, (data) => {
          let hiddenHosts = (data.hiddenPanelHosts || []).map(normalizeHost).filter(Boolean);
          if (visible) {
            hiddenHosts = hiddenHosts.filter(h => h !== host);
          } else {
            if (!hiddenHosts.includes(host)) hiddenHosts.push(host);
          }
          chrome.storage.sync.set({ hiddenPanelHosts: hiddenHosts });
        });
      }
    }
  }

  function scheduleSort() {
    if (importWorkbench) { importWorkbench.schedule(); return; }
    if (state.sortKey === 'none') return;
    // Longer debounce: fetches complete in a stream and each one calls
    // scheduleSort(). Re-sorting the whole grid on every completion is what makes
    // a 100+ card page crawl. 600ms coalesces a burst into a single re-sort.
    clearTimeout(state.sortTimer);
    state.sortTimer = setTimeout(applySort, 600);
  }

  // ── Multi-page loader ──────────────────────────────────────
  // Fetch subsequent listing pages and append their cards under the current
  // grid, so filtering/sorting works across all of them (e.g. 100+ videos).

  // Which listing page are we on? Read it from the path's trailing /<n>/ segment.
  function getCurrentPageNumber() {
    if (isXVideosPage()) return Number(new URL(location.href).searchParams.get('p')) || 0;
    if (isLeakedzonePage()) {
      const u = new URL(location.href);
      const p = parseInt(u.searchParams.get('page'), 10);
      return Number.isFinite(p) && p >= 1 ? p : 1;
    }
    if (isFaphousePage()) {
      const u = new URL(location.href);
      const p = parseInt(u.searchParams.get('page'), 10);
      return Number.isFinite(p) && p >= 1 ? p : 1;
    }
    if (isXxbritsPage()) {
      return getXxbritsCurrentPageFromUrl(location.href);
    }
    if (isCamwhoresPage()) {
      const segs = location.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
      const last = segs[segs.length - 1] || '';
      const prev = segs[segs.length - 2] || '';
      const n = parseInt(last, 10);
      if (String(n) !== last || n < 1) return 1;
      // /members/<id>/ and /playlists/<id>/<slug>/ contain numeric entity IDs,
      // not page numbers. Only a trailing number after a section/slug is a page.
      if (segs[0] === 'members' && segs.length <= 2) return 1;
      if (segs[0] === 'playlists' && segs.length <= 3) return 1;
      if (segs[0] === 'members' && /^\d+$/.test(prev) && segs.length === 3) return 1;
      return n;
    }
    const segs = location.pathname.replace(/\/+$/, '').split('/');
    const last = segs[segs.length - 1];
    const n = parseInt(last, 10);
    return (String(n) === last && n >= 1) ? n : 1;
  }

  // Build the URL for page <n>. Prefer deriving the pattern from the live
  // "next page" anchor (robust across sites); fall back to inserting/replacing
  // the numeric path segment while preserving the query string.
  function buildPageUrl(n) {
    if (isLeakedzonePage()) {
      const u = new URL(location.href);
      if (n <= 1) u.searchParams.delete('page');
      else u.searchParams.set('page', n);
      return u.href;
    }
    if (isFaphousePage()) {
      const u = new URL(location.href);
      u.searchParams.set('page', n);
      return u.href;
    }
    if (isXxbritsPage()) {
      return buildXxbritsPageUrl(n, collectXxbritsPager(document));
    }
    if (isPornonePage()) {
      const nextLink = document.querySelector('link[rel="next"][href]');
      if (nextLink?.getAttribute('href')) {
        try {
          const u = new URL(nextLink.getAttribute('href'), location.href);
          u.protocol = location.protocol;
          const nextNum = getPageNumberFromUrl(u);
          if (nextNum) {
            const re = new RegExp(`(/)${nextNum}(/?)(?=$|[?#])`);
            if (re.test(u.pathname)) {
              u.pathname = u.pathname.replace(re, `$1${n}$2`);
              return u.href;
            }
          }
        } catch { }
      }
    }
    // 1) Derive from a real pagination anchor if present.
    const nextA = document.querySelector('a[href][class*="pagination"], a[href][rel="next"], .includes-pagination-arrow[href], a[href][class*="page"]');
    const cur = getCurrentPageNumber();
    if (nextA?.getAttribute('href')) {
      try {
        const u = new URL(nextA.href, location.origin);
        // The anchor points at cur+1; swap that number for n in the path.
        const nextNum = getPageNumberFromUrl(u);
        if (nextNum) {
          const re = new RegExp(`(/)${nextNum}(/?)(?=$|[?#])`);
          if (re.test(u.pathname)) {
            u.pathname = u.pathname.replace(re, `$1${n}$2`);
            return u.href;
          }
        }
      } catch { }
    }
    // 2) Fallback: replace a trailing /<num>/ or append /<n>/ before the query.
    const u = new URL(location.href);
    if (isCamwhoresPage()) {
      const segs = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
      const last = segs[segs.length - 1] || '';
      const hasPageNumber =
        /^\d+$/.test(last) &&
        !(segs[0] === 'members' && segs.length <= 2) &&
        !(segs[0] === 'playlists' && segs.length <= 3);
      if (hasPageNumber) {
        u.pathname = u.pathname.replace(/\/\d+(\/?)$/, `/${n}$1`);
      } else {
        u.pathname = u.pathname.replace(/\/?$/, '/') + `${n}/`;
      }
    } else if (/\/\d+\/?$/.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/\d+(\/?)$/, `/${n}$1`);
    } else {
      u.pathname = u.pathname.replace(/\/?$/, '/') + `${n}/`;
    }
    void cur;
    return u.href;
  }

  function getPageNumberFromUrl(u) {
    if (isFaphousePage() && u.searchParams.has('page')) {
      const p = parseInt(u.searchParams.get('page'), 10);
      if (Number.isFinite(p) && p >= 1) return p;
    }
    if (isXxbritsPage()) {
      const fromPage = getXxbritsPageFromSearch(u.searchParams);
      if (fromPage) return fromPage;
    }
    const segs = u.pathname.replace(/\/+$/, '').split('/');
    const n = parseInt(segs[segs.length - 1], 10);
    return (String(n) === segs[segs.length - 1] && n >= 1) ? n : null;
  }

  function parseKvsParameters(raw) {
    const out = {};
    for (const part of String(raw || '').split(';')) {
      const i = part.indexOf(':');
      if (i < 0) continue;
      const key = part.slice(0, i).trim();
      if (key) out[key] = part.slice(i + 1).trim();
    }
    return out;
  }

  // KVS page cursor: from, from10, from_videos, from_videos24, from_fav_videos…
  function isXxbritsFromParam(key) {
    return /^from(?:_[a-z]+)*\d*$/i.test(String(key || ''));
  }

  function xxbritsFromKey(params, href) {
    const keys = Object.keys(params || {}).filter(isXxbritsFromParam);
    if (keys.length) {
      keys.sort((a, b) => b.length - a.length);
      return keys[0];
    }
    try {
      if (/\/search\//i.test(new URL(href || location.href).pathname)) return 'from_videos';
    } catch { }
    return 'from';
  }

  function getXxbritsPageFromSearch(searchParams) {
    let found = 0;
    for (const [key, value] of searchParams.entries()) {
      if (!isXxbritsFromParam(key)) continue;
      const n = parseInt(value, 10);
      if (Number.isFinite(n) && n >= 1) found = Math.max(found, n);
    }
    return found || 0;
  }

  function getXxbritsCurrentPageFromUrl(href) {
    try {
      const u = new URL(href, 'https://www.xxbrits.com');
      const fromPage = getXxbritsPageFromSearch(u.searchParams);
      if (fromPage) return fromPage;
      const segs = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
      const last = segs[segs.length - 1] || '';
      if (segs[0] === 'videos') return 1;
      if (segs[0] === 'playlists' && segs.length <= 3) return 1;
      if (/^\d+$/.test(last)) return parseInt(last, 10);
    } catch { }
    return 1;
  }

  function collectXxbritsPager(root) {
    const scope = root || document;
    const links = [...(scope.querySelectorAll?.(
      '[id$="_pagination"] a, .pagination a, a[data-action="ajax"][data-parameters], a[data-parameters*="from"]'
    ) || [])];
    let blockId = '';
    let fromKey = 'from';
    let sortBy = '';
    let lastPage = 0;
    let current = 0;
    const extraParams = {};

    const active = scope.querySelector?.('[id$="_pagination"] .active, .pagination .active, .pagination li.active');
    if (active) {
      const n = parseInt(String(active.textContent || '').replace(/\D/g, ''), 10);
      if (n >= 1) current = n;
    }

    for (const a of links) {
      const params = parseKvsParameters(a.getAttribute?.('data-parameters') || '');
      const href = a.getAttribute?.('href') || a.href || '';
      blockId = blockId
        || a.getAttribute?.('data-block-id')
        || a.getAttribute?.('data-container-id')
        || '';
      if (!blockId) {
        try {
          const u = new URL(href, location.origin);
          blockId = u.searchParams.get('block_id') || '';
        } catch { }
      }
      if (!blockId) {
        const wrap = a.closest?.('[id$="_pagination"]');
        if (wrap?.id) blockId = wrap.id.replace(/_pagination$/, '');
      }
      const key = xxbritsFromKey(params, href || location.href);
      if (params[key]) fromKey = key;
      if (params.sort_by) sortBy = params.sort_by;
      for (const [k, v] of Object.entries(params)) {
        if (!isXxbritsFromParam(k) && k !== 'sort_by') extraParams[k] = v;
      }
      const page = parseInt(params[key] || params.from || '0', 10);
      const label = String(a.textContent || '').trim().toLowerCase();
      if (/^(last|posledn)/i.test(label)) {
        let resolved = page;
        if (!resolved) {
          try { resolved = getPageNumberFromUrl(new URL(href, location.origin)) || 0; } catch { }
        }
        if (resolved > lastPage) lastPage = resolved;
      }
    }

    if (!blockId) blockId = inferXxbritsBlockId(scope);
    if (!current) current = getXxbritsCurrentPageFromUrl(location.href);
    if (fromKey === 'from') fromKey = xxbritsFromKey({}, location.href);
    return {
      blockId,
      fromKey,
      sortBy,
      extraParams,
      current: current || 1,
      maxPage: lastPage,
    };
  }

  function inferXxbritsBlockId(root) {
    const scope = root || document;
    const nodes = [...(scope.querySelectorAll?.('[data-block-id], [id^="list_videos_"], [id^="playlist_view_"]') || [])];
    for (const el of nodes) {
      const raw = el.getAttribute?.('data-block-id') || el.id || '';
      const block = raw.replace(/_pagination$|_items$/, '');
      if (/^(list_videos_|playlist_view_)/.test(block)) return block;
    }
    return '';
  }

  function stripXxbritsFromParams(searchParams) {
    for (const key of [...searchParams.keys()]) {
      if (isXxbritsFromParam(key) || key === 'mode' || key === 'function' || key === 'action' || key === 'block_id') {
        searchParams.delete(key);
      }
    }
  }

  function buildXxbritsPathUrl(n, href, fromKey) {
    const u = new URL(href || location.href);
    u.hash = '';
    if (/\/search\//i.test(u.pathname)) {
      stripXxbritsFromParams(u.searchParams);
      u.searchParams.set(fromKey || 'from_videos', String(n));
      return u.href;
    }
    const segs = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    const last = segs[segs.length - 1] || '';
    const hasPageNumber =
      /^\d+$/.test(last) &&
      segs[0] !== 'videos' &&
      !(segs[0] === 'playlists' && segs.length <= 3);
    if (hasPageNumber) {
      u.pathname = u.pathname.replace(/\/\d+(\/?)$/, `/${n}$1`);
    } else {
      u.pathname = u.pathname.replace(/\/?$/, '/') + `${n}/`;
    }
    return u.href;
  }

  function buildXxbritsAjaxUrl(n, pager, href, actionKey = 'function') {
    const u = new URL(href || location.href);
    u.hash = '';
    stripXxbritsFromParams(u.searchParams);
    u.searchParams.set('mode', 'async');
    u.searchParams.set(actionKey, 'get_block');
    u.searchParams.set('block_id', pager.blockId);
    if (pager.sortBy) u.searchParams.set('sort_by', pager.sortBy);
    for (const [key, value] of Object.entries(pager.extraParams || {})) {
      if (value != null && value !== '' && !isXxbritsFromParam(key)) u.searchParams.set(key, String(value));
    }
    u.searchParams.set(pager.fromKey || xxbritsFromKey({}, u.href), String(n));
    return u.href;
  }

  function buildXxbritsPageUrl(n, pager, href) {
    if (pager?.blockId) return buildXxbritsAjaxUrl(n, pager, href);
    return buildXxbritsPathUrl(n, href);
  }

  function findXxbritsGrid() {
    const preferred = [
      document.querySelector('#playlist_view_playlist_view_items'),
      document.querySelector('.videos_list'),
      document.querySelector('.list-videos'),
    ];
    for (const el of preferred) {
      if (el?.querySelector?.('.th, [data-playlist-item]')) return el;
    }
    const items = [...document.querySelectorAll('[id$="_items"]')];
    return items.find((el) => el.querySelector('.th, [data-playlist-item]')) || findGridContainer();
  }

  function extractXxbritsPageItems(doc) {
    const cards = [...(doc.querySelectorAll?.('.videos_list .th, .list-videos .th, [data-playlist-item], div.th') || [])];
    return cards.filter((card) => {
      if (card.classList?.contains?.('avd')) return false;
      return !!getCamwhoresVideoUrlFromNode(card);
    });
  }

  function xxbritsKnownVideoUrls(root) {
    const urls = new Set();
    const scope = root || document;
    for (const card of scope.querySelectorAll?.('.th, [data-playlist-item]') || []) {
      const url = getCamwhoresVideoUrlFromNode(card);
      if (url) urls.add(url.replace(/\/+$/, ''));
    }
    return urls;
  }

  async function fetchXxbritsPageItems(page, pager, seen) {
    const urls = [];
    if (pager?.blockId) {
      urls.push(buildXxbritsAjaxUrl(page, pager, undefined, 'function'));
      urls.push(buildXxbritsAjaxUrl(page, pager, undefined, 'action'));
    }
    urls.push(buildXxbritsPathUrl(page, undefined, pager?.fromKey));
    let lastPager = pager;
    for (const url of [...new Set(urls)]) {
      try {
        const res = await fetch(url, {
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (!res.ok) continue;
        const html = await res.text();
        if (!html) continue;
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const items = extractXxbritsPageItems(doc);
        const fresh = items.filter((item) => {
          const videoUrl = (getCamwhoresVideoUrlFromNode(item) || '').replace(/\/+$/, '');
          return videoUrl && !(seen && seen.has(videoUrl));
        });
        if (!fresh.length) continue;
        lastPager = collectXxbritsPager(doc);
        return { items, pager: lastPager };
      } catch { }
    }
    return { items: [], pager: lastPager };
  }

  async function loadXxbritsPages(count) {
    if (!Number.isFinite(count) || count < 1) {
      showToast('Zadaj počet strán aspoň 1', 'error');
      return;
    }
    count = Math.min(20, Math.max(1, count));
    const liveGrid = findXxbritsGrid();
    if (!liveGrid) {
      showToast('Nenašiel som grid videí na tejto stránke', 'error');
      return;
    }

    let pager = collectXxbritsPager(document);
    const current = pager.current;
    const lastAllowed = pager.maxPage > current ? Math.min(current + count, pager.maxPage) : current + count;
    const pages = [];
    for (let p = current + 1; p <= lastAllowed; p++) {
      if (!state.loadedExtraPages.has(p)) pages.push(p);
    }
    if (!pages.length) {
      showToast(pager.maxPage <= current ? 'Ďalšie strany nie sú k dispozícii' : 'Tieto strany už sú načítané', 'error');
      return;
    }

    state.isLoadingPages = true;
    const btn = document.getElementById('nvs-load-pages');
    const origLabel = btn ? btn.textContent : '';
    const seen = xxbritsKnownVideoUrls(document);
    let appended = 0;
    const CONCURRENCY = 3;

    try {
      for (let i = 0; i < pages.length; i += CONCURRENCY) {
        const batch = pages.slice(i, i + CONCURRENCY);
        if (btn) btn.textContent = `Načítavam ${batch[0]}–${batch[batch.length - 1]}…`;
        const fetched = await Promise.all(batch.map(async (p) => {
          const result = await fetchXxbritsPageItems(p, pager, seen);
          return { p, ...result };
        }));

        for (const row of fetched) {
          if (row.pager?.maxPage) pager = { ...pager, ...row.pager, blockId: row.pager.blockId || pager.blockId };
          if (!row.items.length) continue;
          const frag = document.createDocumentFragment();
          let added = 0;
          for (const item of row.items) {
            const url = (getCamwhoresVideoUrlFromNode(item) || '').replace(/\/+$/, '');
            if (url && seen.has(url)) continue;
            if (url) seen.add(url);
            const node = document.importNode(item, true);
            hydrateLazyImages(node);
            frag.appendChild(node);
            added++;
          }
          if (added) {
            liveGrid.appendChild(frag);
            appended += added;
            state.loadedExtraPages.add(row.p);
          }
        }
        scan();
        await new Promise((r) => setTimeout(r, 40));
      }

      if (state.filterDuration !== 'all') applyFilter();
      showToast(`Pripojených ${appended} videí (+${pages.length} strán)`, appended ? '' : 'error');
    } finally {
      state.isLoadingPages = false;
      if (btn) btn.textContent = origLabel || '＋ Načítať';
    }
  }

  // The live grid we append into = the parent that holds the most cards.
  function findGridContainer() {
    const cards = [...document.querySelectorAll(`[${CFG.processedAttr}="1"]`)];
    if (!cards.length) return null;
    const counts = new Map();
    for (const card of cards) {
      const node = getSortableNode(card);
      const parent = node?.parentElement;
      if (!parent) continue;
      counts.set(parent, (counts.get(parent) || 0) + 1);
    }
    let best = null, max = 0;
    for (const [parent, c] of counts) {
      if (c > max) { max = c; best = parent; }
    }
    return best;
  }

  function getXVideosTagCards() {
    return [...document.querySelectorAll(`[${CFG.processedAttr}="1"]`)].filter(card => !!getVideoUrlFromCard(card));
  }

  // Given fetched page HTML, return the grid-item elements to append. We import
  // the children of the parsed grid that matches our live grid's structure.
  function extractPageItems(doc, liveGrid) {
    // Try to find a grid in the fetched doc with the same class as the live one.
    let srcGrid = null;
    const liveClass = (liveGrid?.className || '').trim().split(/\s+/).filter(Boolean);
    if (liveClass.length) {
      const sel = '.' + liveClass.join('.');
      try { srcGrid = doc.querySelector(sel); } catch { }
    }
    // Fallback: the grid holding the most video links.
    if (!srcGrid) {
      const grids = new Map();
      for (const a of doc.querySelectorAll('a[href]')) {
        if (!isVideoUrl(a.href)) continue;
        const card = findCardContainerIn(a);
        const g = card?.parentElement;
        if (g) grids.set(g, (grids.get(g) || 0) + 1);
      }
      let max = 0;
      for (const [g, c] of grids) if (c > max) { max = c; srcGrid = g; }
    }
    if (!srcGrid) return [];
    // Only keep children that actually contain a video link (skip ad slots etc.).
    return [...srcGrid.children].filter(ch =>
      (ch.matches?.('a[href]') && isVideoUrl(ch.href))
      || (ch.querySelector?.('a[href]') && [...ch.querySelectorAll('a[href]')].some(a => isVideoUrl(a.href)))
    );
  }

  // Lightweight card-container walk usable on a detached parsed document.
  function findCardContainerIn(link) {
    if (isDrTuberPage() && link?.matches?.('a.th.ch-video[href*="/video/"]')) return link;
    if (isPornonePage() && link?.matches?.('a.videocard[href]')) return link;
    if (isCumStPage() && link?.matches?.('a.cv-cell[href*="/post/"]')) return link;
    if (isXHamsterPage()) {
      const card = link.closest('.thumb-list__item, .video-thumb, [data-video-id]');
      if (card) return card;
    }
    if (isXxbritsPage()) {
      const card = findXxbritsCardContainer(link);
      if (card) return card;
    }
    let el = link.parentElement;
    let steps = 0;
    let best = el;
    while (el && steps < 7) {
      steps++;
      if (el.querySelector?.('img')) best = el;
      el = el.parentElement;
    }
    return best || link.parentElement;
  }

  // Cloned cards keep the site's lazy-load placeholder (real thumb lives in
  // data-original / data-src / data-webp / data-lazy…). The site's lazy observer
  // never binds to our clones, so promote the real URL into src/srcset ourselves.
  function hydrateLazyImages(root) {
    const LAZY_SRC_ATTRS = ['data-original', 'data-src', 'data-lazy-src', 'data-lazy', 'data-echo', 'data-webp', 'data-image', 'data-image-url', 'data-thumb', 'data-thumbnail', 'data-preview', 'data-poster', 'data-original-src'];
    const LAZY_SET_ATTRS = ['data-srcset', 'data-original-set', 'data-lazy-srcset', 'data-image-srcset', 'data-src-set'];
    const imgs = root.matches?.('img') ? [root] : root.querySelectorAll?.('img') || [];
    for (const img of imgs) {
      let real = '';
      for (const a of LAZY_SRC_ATTRS) {
        const v = img.getAttribute(a);
        if (v && !/^data:/.test(v)) { real = v; break; }
      }
      const cur = img.getAttribute('src') || '';
      if (!real) {
        const srcset = img.getAttribute('srcset') || '';
        real = srcset.split(',').map(part => part.trim().split(/\s+/)[0]).find(value => value && !/^data:|^blob:/i.test(value)) || '';
      }
      // Replace only if current src is a placeholder (data:) or empty.
      if (real && (!cur || /^data:/.test(cur))) {
        img.setAttribute('src', real);
      }
      for (const a of LAZY_SET_ATTRS) {
        const v = img.getAttribute(a);
        if (v) { img.setAttribute('srcset', v); break; }
      }
      img.classList.remove('lazy-load', 'lazy', 'lazyload');
      img.loading = 'eager';
    }
    // Background-image lazy holders (some grids use CSS backgrounds).
    const bgEls = root.querySelectorAll?.('[data-bg], [data-background-image], [data-background], [data-original][style], [data-src][style]') || [];
    for (const el of bgEls) {
      const bg = el.getAttribute('data-bg') || el.getAttribute('data-background-image') || el.getAttribute('data-background') || el.getAttribute('data-src') || el.getAttribute('data-original');
      if (bg && !/^data:/.test(bg)) el.style.backgroundImage = `url("${bg}")`;
    }
    for (const el of root.querySelectorAll?.('[data-video], [data-props], [data-json]') || []) {
      const raw = el.getAttribute('data-video') || el.getAttribute('data-props') || el.getAttribute('data-json') || '';
      const match = raw.match(/(?:thumbnail|thumb|poster|preview|image)[^"']*?["']\s*:\s*["']([^"']+)/i);
      const image = el.querySelector?.('img');
      if (match?.[1] && image && (!image.src || /^data:|blob:/i.test(image.src) || image.getAttribute('src')?.includes('placeholder'))) image.src = match[1];
    }
  }

  function wakeXHamsterLazyMedia() {
    if (!isXHamsterPage()) return;
    hydrateLazyImages(document);
    try {
      window.dispatchEvent(new Event('resize'));
      document.dispatchEvent(new Event('scroll', { bubbles: true }));
    } catch { }
  }

  function findXHamsterRelatedLoadMore() {
    // Only controls which are semantically buttons are eligible. Never use a
    // generic link/card as "Load more": those can navigate to ads or partners.
    const candidates = document.querySelectorAll('button, [role="button"]');
    for (const candidate of candidates) {
      const text = (candidate.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (candidate.closest('[id^="nvs-"]')) continue;
      if (candidate.tagName === 'A') continue;
      if (candidate.disabled || candidate.getAttribute('aria-disabled') === 'true') continue;
      const aria = `${candidate.getAttribute('aria-label') || ''} ${candidate.getAttribute('title') || ''}`.toLowerCase();
      const explicit = candidate.matches('[data-role="related-videos-load-more"], [data-testid="load-more"], [data-testid$="load-more"], [class*="load-more"], [class*="loadMore"]');
      if (explicit || /show more|load more|more videos|related videos|zobraziť viac|načítať viac/i.test(`${text} ${aria}`)) return candidate;
    }
    return null;
  }

  function getXHamsterVideoUrls() {
    const urls = new Set();
    for (const link of document.querySelectorAll('a[href]')) {
      try {
        const url = new URL(link.href, location.href);
        if (/(^|\.)xhamster(?:-fr)?\.com$|(^|\.)xhamster\.desi$/i.test(url.hostname) && /\/videos\//i.test(url.pathname)) {
          url.search = ''; url.hash = ''; urls.add(url.href);
        }
      } catch { }
    }
    return urls;
  }

  function getListingVideoUrls() {
    if (isXHamsterPage()) return getXHamsterVideoUrls();
    const urls = new Set();
    for (const link of document.querySelectorAll('a[href]')) {
      if (!isVideoUrl(link.href)) continue;
      try {
        const url = new URL(link.href, location.href);
        url.search = ''; url.hash = '';
        urls.add(url.href);
      } catch { }
    }
    return urls;
  }

  function findNextListingLink(doc) {
    const explicit = doc.querySelector('a[rel="next"], .pager-next a, a[data-page="next"]');
    if (explicit) return explicit;
    if (!isDrTuberPage()) return null;
    return [...doc.querySelectorAll('.pagination a[href], [class*="pagination"] a[href]')]
      .find(link => /^next$/i.test((link.textContent || '').replace(/\s+/g, ' ').trim())) || null;
  }

  async function waitForXHamsterRelatedLoad(previousUrls, button) {
    const deadline = Date.now() + 15000;
    const previousCards = document.querySelectorAll('[data-video-id], .thumb-list__item, .video-thumb').length;
    return new Promise((resolve) => {
      let observer;
      let poll;
      let timeout;
      const finish = (loaded) => {
        observer?.disconnect();
        clearInterval(poll);
        clearTimeout(timeout);
        resolve(loaded);
      };
      const check = () => {
        const currentUrls = getXHamsterVideoUrls();
        const currentCards = document.querySelectorAll('[data-video-id], .thumb-list__item, .video-thumb').length;
        if ([...currentUrls].some(url => !previousUrls.has(url)) || currentCards > previousCards) {
          finish(true);
        } else if (Date.now() >= deadline) {
          finish(false);
        }
      };
      observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true });
      poll = setInterval(check, 250);
      timeout = setTimeout(() => {
        check();
      }, 15050);
      check();
    });
  }

  function findXHamsterCardTemplate() {
    const cards = document.querySelectorAll('[data-role="thumb-list-block"] .thumb-list__item, .thumb-list__item');
    for (const card of cards) {
      if (window.NVSXhamsterListing?.isSkeletonCard(card) || window.NVSXhamsterListing?.isPaidCard(card)) continue;
      const img = [...card.querySelectorAll('img')].find((el) => !el.closest('noscript'));
      if (img && /^https?:/i.test(img.currentSrc || img.getAttribute('src') || '')) return card;
    }
    return null;
  }

  function xhamsterNextAnchor() {
    return document.querySelector('.desktop-pagination a[rel="next"], a.prev-next-list-link--next[rel="next"], a[rel="next"]');
  }

  async function loadXHamsterListingPages(count, stopped = () => false) {
    const api = window.NVSXhamsterListing;
    if (!api) throw new Error('xHamster listing modul chýba.');
    let loaded = 0;
    for (let step = 0; step < count && !stopped(); step++) {
      const anchor = xhamsterNextAnchor();
      const href = state.xhamsterNextUrl || anchor?.href || '';
      if (!href) break;
      const url = new URL(href, location.href);
      if (url.origin !== location.origin || state.loadedExtraPages.has(url.href)) break;
      const response = await fetch(url.href, { credentials: 'include', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      if (stopped()) break;
      const grid = findGridContainer();
      if (!grid) throw new Error('Grid kariet sa nenašiel.');
      const existing = getXHamsterVideoUrls();
      let videos = api.videosFromHtml(html).filter((video) => {
        if (existing.has(video.pageURL)) return false;
        existing.add(video.pageURL);
        return true;
      });
      if (!videos.length) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const base = doc.createElement('base');
        base.href = url.href;
        doc.head.prepend(base);
        videos = extractPageItems(doc, grid).filter((node) => !api.isSkeletonCard(node) && !api.isPaidCard(node)).flatMap((node) => {
          const link = [...node.querySelectorAll('a[href]')].find((a) => /\/videos\//i.test(a.pathname || a.getAttribute('href') || ''));
          if (!link) return [];
          const page = new URL(link.href, url); page.search = ''; page.hash = '';
          if (existing.has(page.href)) return [];
          const img = [...node.querySelectorAll('img')].find((el) => !el.closest('noscript'));
          existing.add(page.href);
          return [{
            id: node.getAttribute('data-video-id') || '',
            pageURL: page.href,
            thumbURL: img?.getAttribute('src') || '',
            title: node.querySelector('.video-thumb-info__name')?.textContent?.trim() || link.getAttribute('aria-label') || '',
            duration: 0,
            created: 0,
            views: 0,
          }];
        });
      }
      if (!videos.length) break;
      const template = findXHamsterCardTemplate();
      const fragment = document.createDocumentFragment();
      for (const video of videos) {
        const node = template ? api.applyVideo(template.cloneNode(true), video) : api.elementFromCardHtml(video);
        fragment.appendChild(node);
      }
      grid.appendChild(fragment);
      window.NVSXhamsterLayout?.clean();
      state.loadedExtraPages.add(url.href);
      const following = api.nextPageHref(html);
      state.xhamsterNextUrl = following ? new URL(following, url).href : '';
      if (anchor) {
        if (state.xhamsterNextUrl) anchor.href = state.xhamsterNextUrl;
        else anchor.remove();
      }
      loaded++;
      scan();
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    return loaded;
  }

  async function loadXVideosPages(count, stopped = () => false) {
    const api = window.NVSXvideosListing;
    if (!api) throw new Error('XVideos listing modul chýba.');
    let loaded = 0, next = state.xvideosNextUrl || api.nextUrl(document, location.href);
    for (let i = 0; i < count && next && !stopped(); i++) {
      if (state.loadedExtraPages.has(next)) break;
      const url = new URL(next, location.href);
      if (url.origin !== location.origin) throw new Error('Stránka presmerovala mimo XVideos.');
      const response = await fetch(url.href, { credentials: 'include', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (new URL(response.url).origin !== location.origin) throw new Error('Stránka presmerovala mimo XVideos.');
      const contentType = response.headers.get('content-type') || '';
      const pageData = contentType.includes('application/json') ? await response.json() : null;
      const doc = pageData ? null : new DOMParser().parseFromString(await response.text(), 'text/html');
      if (stopped()) break;
      const current = new Set(api.cards(document).map(item => item.url));
      const pageCards = pageData ? api.cardsFromJson(pageData, url.href) : api.cards(doc, url.href);
      const fresh = pageCards.filter(item => !current.has(item.url));
      if (!fresh.length) break;
      const liveCards = api.cards(document);
      const grid = liveCards[0]?.card.parentElement;
      if (!grid) throw new Error('Grid videí sa nenašiel.');
      const fragment = document.createDocumentFragment();
      for (const item of fresh) {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = item.card.outerHTML;
        const clone = wrapper.firstElementChild;
        if (clone) fragment.appendChild(clone);
      }
      grid.appendChild(fragment);
      state.loadedExtraPages.add(url.href);
      if (pageData && Number(pageData.nb_per_page) > 0) {
        const nextPage = Number(pageData.current_page) + 1;
        state.xvideosNextUrl = nextPage < Math.ceil(Number(pageData.nb_videos) / Number(pageData.nb_per_page))
          ? api.profilePageUrl(document, location.href, nextPage) : '';
      } else {
        state.xvideosNextUrl = api.nextUrl(doc, url.href);
      }
      next = state.xvideosNextUrl;
      scan();
      loaded++;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return loaded;
  }

  async function loadSpankBangPages(count, stopped = () => false) {
    const api = window.NVSSpankBangListing;
    if (!api) throw new Error('SpankBang listing modul chýba.');
    let loaded = 0;
    let next = state.spankbangNextUrl !== undefined ? state.spankbangNextUrl : api.nextUrl(document, location.href);
    for (let i = 0; i < count && next && !stopped(); i++) {
      if (state.loadedExtraPages.has(next)) break;
      const url = new URL(next, location.href);
      if (!api.onSite(url.href)) throw new Error('Ďalšia stránka nie je na SpankBangu.');
      const response = await fetch(url.href, { credentials: 'include', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!api.onSite(response.url)) throw new Error('Stránka presmerovala mimo SpankBangu.');
      const html = await response.text();
      if (api.isChallenge(html)) throw new Error('SpankBang vrátil kontrolu prehliadača.');
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const base = doc.createElement('base');
      base.href = url.href;
      doc.head.prepend(base);
      if (stopped()) break;
      const current = new Set(api.cards(document, location.href).map(item => item.url));
      const fresh = api.cards(doc, url.href).filter(item => !current.has(item.url));
      if (!fresh.length) { state.spankbangNextUrl = ''; break; }
      const grid = api.cards(document, location.href)[0]?.card.parentElement;
      if (!grid) throw new Error('Grid videí sa nenašiel.');
      const fragment = document.createDocumentFragment();
      for (const item of fresh) fragment.appendChild(document.importNode(item.card, true));
      grid.appendChild(fragment);
      state.loadedExtraPages.add(url.href);
      state.spankbangNextUrl = api.nextUrl(doc, url.href);
      next = state.spankbangNextUrl;
      scan();
      loaded++;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return loaded;
  }

  async function loadXHamsterRelated(count, btn, stopped = () => false) {
    let loaded = 0;
    for (let click = 1; click <= count && !stopped(); click++) {
      const loadMore = findXHamsterRelatedLoadMore();
      if (!loadMore || loadMore.disabled) break;
      if (btn) btn.textContent = `Načítavam ${click}/${count}…`;
      const previousUrls = getXHamsterVideoUrls();
      // Never allow a load-more heuristic to navigate or open a new tab.
      // xHamster's control is an in-page button; external anchors belong to
      // recommendations/ads and must never be clicked by the importer.
      if (loadMore.tagName === 'A') {
        const href = loadMore.getAttribute('href') || '';
        let target;
        try { target = new URL(href, location.href); } catch { target = null; }
        if (!target || target.origin !== location.origin || loadMore.target === '_blank' || (!href.startsWith('#') && !/^javascript:/i.test(href))) break;
        loadMore.addEventListener('click', event => event.preventDefault(), { capture: true, once: true });
      }
      loadMore.click();
      const changed = await waitForXHamsterRelatedLoad(previousUrls, loadMore);
      if (!changed) break;
      loaded++;
      wakeXHamsterLazyMedia();
      scan();
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return loaded;
  }

  async function loadPagesUntil(target) {
    if (isXxbritsPage()) {
      await loadXxbritsPages(target);
      return;
    }
    if (isSpankBangPage()) {
      if (!Number.isFinite(target) || target < 1 || target > 50) { showToast('Zadaj počet strán od 1 do 50', 'error'); return; }
      state.isLoadingPages = true;
      try { const loaded = await loadSpankBangPages(target); showToast(`Načítaných ${loaded} ďalších strán`, loaded ? '' : 'error'); }
      finally { state.isLoadingPages = false; }
      return;
    }
    if (isXVideosPage()) {
      if (!Number.isFinite(target) || target < 1 || target > 50) { showToast('Zadaj počet strán od 1 do 50', 'error'); return; }
      state.isLoadingPages = true;
      try { const loaded = await loadXVideosPages(target); showToast(`Načítaných ${loaded} ďalších strán`, loaded ? '' : 'error'); }
      finally { state.isLoadingPages = false; }
      return;
    }
    if (isXHamsterPage()) {
      if (!Number.isFinite(target) || target < 1) {
        showToast('Zadaj počet načítaní aspoň 1', 'error');
        return;
      }
      state.isLoadingPages = true;
      const btn = document.getElementById('nvs-load-pages');
      const origLabel = btn ? btn.textContent : '';
      try {
        const loaded = isXHamsterListingPage()
          ? await loadXHamsterListingPages(Math.min(target, 50), () => false)
          : await loadXHamsterRelated(Math.min(target, 50), btn);
        showToast(`Načítaných ${loaded} ďalších blokov`, loaded ? '' : 'error');
      } finally {
        state.isLoadingPages = false;
        if (btn) btn.textContent = origLabel || '＋ Načítať';
      }
      return;
    }
    const current = getCurrentPageNumber();
    const btn = document.getElementById('nvs-load-pages');
    if (!Number.isFinite(target) || target <= current) {
      showToast(`Zadaj číslo väčšie ako aktuálna strana (${current})`, 'error');
      return;
    }
    const liveGrid = findGridContainer();
    if (!liveGrid) {
      showToast('Nenašiel som grid videí na tejto stránke', 'error');
      return;
    }

    state.isLoadingPages = true;
    const origLabel = btn ? btn.textContent : '';
    let appended = 0;

    try {
      for (let p = current + 1; p <= target; p++) {
        if (state.loadedExtraPages.has(p)) continue;
        if (btn) btn.textContent = `Načítavam ${p}/${target}…`;

        const url = buildPageUrl(p);
        let html = null;
        try {
          const res = await fetch(url, { credentials: 'include' });
          if (res.ok) html = await res.text();
        } catch { }
        if (!html) { showToast(`Strana ${p} sa nenačítala`, 'error'); continue; }

        const doc = new DOMParser().parseFromString(html, 'text/html');
        const items = extractPageItems(doc, liveGrid);
        if (!items.length) { showToast(`Strana ${p}: žiadne karty`, 'error'); continue; }

        // Vlož karty do DocumentFragment (jediný reflow namiesto N) a hydratuj
        // náhľady mimo živého DOM — potom pripoj naraz.
        const frag = document.createDocumentFragment();
        for (const item of items) {
          const node = document.importNode(item, true);
          hydrateLazyImages(node);
          frag.appendChild(node);
          appended++;
        }
        liveGrid.appendChild(frag);
        state.loadedExtraPages.add(p);

        // Spracuj práve pripojenú stranu a nechaj vlákno vydýchnuť pred ďalšou
        // stranou — inak sa DOM/fetch práca za 100+ kariet nakopí a UI zamrzne.
        scan();
        await new Promise(r => setTimeout(r, 60));
      }

      // Re-apply the active filter so new cards respect the current filter.
      if (state.filterDuration !== 'all') applyFilter();
      showToast(`Pripojených ${appended} videí (strany po ${target})`, appended ? '' : 'error');
    } finally {
      state.isLoadingPages = false;
      if (btn) btn.textContent = origLabel || '＋ Načítať';
    }
  }


  function applyFilterToCard(card, filterValue) {
    if (importWorkbench) { importWorkbench.schedule(); return; }
    if (filterValue === 'all') {
      card.classList.remove('nvs-hidden');
      return;
    }
    // Metadátové filtre
    if (filterValue === 'no-size') {
      const sizeMb = getSortValue(card, 'size');
      card.classList.toggle('nvs-hidden', !!(sizeMb != null && sizeMb > 0));
      return;
    }
    if (filterValue === 'no-date') {
      const dateVal = getSortValue(card, 'date');
      card.classList.toggle('nvs-hidden', dateVal != null);
      return;
    }
    const durSec = getSortValue(card, 'duration');
    let show = true;
    if (filterValue === 'short') {
      if (durSec == null || durSec >= 600) show = false;
    } else if (filterValue === 'medium') {
      if (durSec == null || durSec < 600 || durSec > 1800) show = false;
    } else if (filterValue === 'long') {
      if (durSec == null || durSec <= 1800) show = false;
    }

    if (show) {
      card.classList.remove('nvs-hidden');
    } else {
      card.classList.add('nvs-hidden');
    }
  }

  function applyFilter() {
    const cards = document.querySelectorAll(`[${CFG.processedAttr}="1"]`);
    for (const card of cards) {
      applyFilterToCard(card, state.filterDuration);
    }
  }

  function applySort() {
    // Always read the live <select>/state so we never sort by a stale key. The
    // dropdown is the source of truth for the user's intent; state can lag if a
    // change event was missed or the panel was re-injected.
    const selEl = document.getElementById('nvs-sort-key');
    if (selEl && selEl.value !== state.sortKey) {
      state.sortKey = selEl.value;
      localStorage.setItem('nvs-sort-key', state.sortKey);
    }

    const cards = [...document.querySelectorAll(`[${CFG.processedAttr}="1"]`)];
    if (!cards.length) return;

    // Build per-container groups
    const groups = new Map();
    for (const card of cards) {
      const sortNode = getSortableNode(card);
      const container = sortNode?.parentElement;
      if (!sortNode || !container) continue;
      if (!groups.has(container)) groups.set(container, []);
      groups.get(container).push({
        card,
        sortNode,
        val: state.sortKey === 'none' ? null : getSortValue(card, state.sortKey),
        idx: getOriginalIndex(card),
      });
    }

    // ─── CROSS-PAGE MERGE ───────────────────────────────────────────────────
    // If cards were loaded from multiple pages they end up in separate containers
    // (each fetched page's grid-item is a direct child of liveGrid, but WhoresHub
    // and similar sites wrap each page's items in a sub-container).
    // Solution: when more than one group exists, move ALL sortNodes into the
    // biggest container so a single global sort can work.
    if (groups.size > 1) {
      // Find the container with the most cards (the live first-page grid).
      let primaryContainer = null;
      let primaryMax = 0;
      for (const [container, entries] of groups) {
        if (entries.length > primaryMax) { primaryMax = entries.length; primaryContainer = container; }
      }

      if (primaryContainer) {
        // Move nodes from all other containers into the primary one.
        for (const [container, entries] of groups) {
          if (container === primaryContainer) continue;
          for (const entry of entries) {
            primaryContainer.appendChild(entry.sortNode);
            // Update cached container reference
            entry._movedContainer = primaryContainer;
          }
          // Remove now-empty containers (page barrier wrappers)
          if (!container.querySelector(`[${CFG.processedAttr}="1"]`)) {
            container.remove();
          }
        }

        // Rebuild as a single group
        const allEntries = [...groups.values()].flat();
        groups.clear();
        groups.set(primaryContainer, allEntries);
        console.log(`[NVS sort] Merged ${groups.size} page groups into primary container (${allEntries.length} cards)`);
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    const cmp = (a, b) => {
      const av = a.val, bv = b.val;
      const aMissing = av == null || Number.isNaN(av);
      const bMissing = bv == null || Number.isNaN(bv);
      if (aMissing && bMissing) return a.idx - b.idx;
      if (aMissing) return 1;   // cards without the value sink to the bottom
      if (bMissing) return -1;
      const diff = state.sortDir === 'desc' ? bv - av : av - bv;
      return diff || (a.idx - b.idx);
    };

    let movedGroups = 0;
    let biggest = 0;
    for (const entries of groups.values()) {
      biggest = Math.max(biggest, entries.length);
      if (entries.length < 2) continue;
      entries.sort(cmp);
      // Re-append in sorted order — moving an existing child to the end reorders
      // it in place, so iterating the sorted list rebuilds the visual order.
      for (const entry of entries) {
        entry.sortNode.parentElement.appendChild(entry.sortNode);
      }
      movedGroups++;
    }

    // Diagnostic so it's obvious in the console whether sort ran and on how many
    // cards — helps when a page's grid nesting splits cards into tiny groups.
    console.log(`[NVS sort] key=${state.sortKey} dir=${state.sortDir} cards=${cards.length} groups=${groups.size} biggestGroup=${biggest} reordered=${movedGroups}`);
    if (movedGroups === 0) {
      showToast('Zoradenie: karty nemajú spoločný kontajner na preskupenie', 'error');
    }
  }

  function getSortableNode(card) {
    if (isXVideosPage()) return card.closest('.thumb-block') || card;
    let node = card;

    while (node?.parentElement && node.parentElement !== document.body && node.parentElement !== document.documentElement) {
      const parent = node.parentElement;
      const sortableChildren = [...parent.children].filter((child) => {
        if (child.getAttribute?.(CFG.processedAttr) === '1') return true;
        return !!child.querySelector?.(`[${CFG.processedAttr}="1"]`);
      });

      if (sortableChildren.length >= 2) {
        return node;
      }

      node = parent;
    }

    return card;
  }

  function getOriginalIndex(card) {
    return parseInt(card.dataset.nvsSortIndex || '0', 10);
  }

  function getSortValue(card, key) {
    const url = getVideoUrlFromCard(card);
    const cached = url ? state.fetchCache.get(url) : null;
    const meta = { ...extractCardMeta(card), ...(state.cardMeta.get(card) || {}), ...(cached || {}) };
    if (key === 'quality') {
      // Sort by pixel height so 4K > 2K > 1080p > 720p. Quality is always present
      // on the card (badge text) even when size probing failed, so this is the
      // reliable sort key for pimpbunny et al. Read our fetched label first, then
      // any quality visible in the card's own text.
      return qualityToHeight(meta.quality) || qualityToHeight(qualityFromText(card.textContent || ''));
    }
    if (key === 'size') {
      // Prefer the injected quality badge over raw card text: pimpbunny cards can
      // contain unrelated "MB" numbers, but our badge carries the real size.
      const badgeSize = parseSizeMb(card.querySelector('.nvs-badge-text')?.textContent || '');
      return meta.sizeMb || parseSizeMb(meta.sizeText || '') || badgeSize || parseSizeMb(card.textContent || '');
    }
    if (key === 'duration') return parseDurationSeconds(meta.duration || card.textContent || '');
    if (key === 'date') return parseDateValue(meta.date || meta.relDate || card.textContent || '');
    return getOriginalIndex(card);
  }

  // Map a quality label ("2K", "1080P", "4K", "HD"…) to a sortable pixel height.
  function qualityToHeight(q) {
    if (!q) return null;
    const s = String(q).toUpperCase();
    if (/\b(4K|2160|UHD)\b/.test(s)) return 2160;
    if (/\b(2K|1440|QHD)\b/.test(s)) return 1440;
    if (/\b(1080|FHD)\b/.test(s)) return 1080;
    if (/\b(720|HD)\b/.test(s)) return 720;
    if (/\b480\b/.test(s)) return 480;
    if (/\b360\b/.test(s)) return 360;
    if (/\b240\b/.test(s)) return 240;
    const n = parseInt(s.replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) && n >= 200 && n <= 4320 ? n : null;
  }

  function qualityFromText(text) {
    const m = String(text || '').match(/\b(4K|2160[pP]?|2K|1440[pP]?|1080[pP]?|720[pP]?|480[pP]?|360[pP]?|UHD|FHD|HD)\b/);
    return m ? m[1] : null;
  }

  // ── Badge Injection ───────────────────────────────────────

  /**
   * Extrahuje metadáta priamo z HTML karty (bez fetchu).
   * Zobrazí sa ihneď — relatívny čas + duration + quality badge ak sú viditeľné.
   */
  function extractCardMeta(card) {
    const result = { relDate: null, date: null, duration: null, quality: null, sizeText: null, sizeMb: null };
    // The gallery has only thumbnails. Do not parse our own badges, or the
    // badges injected by Nexus Gallery, as original site metadata.
    if (isFapFolderPage() || isInternetChicksPage()) return result;
    if (isSpankBangPage() && window.NVSSpankBangListing?.fieldsFromCard) {
      const fields = window.NVSSpankBangListing.fieldsFromCard(card, location.href) || {};
      if (fields.duration) result.duration = fields.duration;
      if (fields.quality) result.quality = fields.quality;
      return result;
    }

    if (isLeakedzonePage()) {
      const durSpan = card.querySelector('span.absolute, span[class*="bottom-2"]');
      if (durSpan) {
        const text = durSpan.textContent.trim();
        if (/\d+:\d+/.test(text)) {
          result.duration = text;
        } else if (/\b4K\b/i.test(text)) {
          result.quality = '4K';
          const match = text.match(/\d+:\d+/);
          if (match) result.duration = match[0];
        }
      }
      const faintDiv = card.querySelector('.text-on-surface-faint, div[class*="text-on-surface-faint"]');
      if (faintDiv) {
        const match = faintDiv.textContent.match(/(\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)/i);
        if (match) result.relDate = match[1];
      }
      return result;
    }

    if (isSxyprnPage()) {
      const durEl = card.querySelector('.duration_small');
      if (durEl) result.duration = durEl.textContent.trim();
      const qEl = card.querySelector('.shd_small');
      if (qEl) {
        const q = qEl.textContent.trim().toUpperCase();
        result.quality = (q.includes('FHD') || q.includes('1080')) ? '1080P'
          : (q.includes('HD') || q.includes('720')) ? '720P'
          : (q.includes('SD') || q.includes('480')) ? '480P' : q;
      }
      const timeEl = card.querySelector('.post_control_time span');
      if (timeEl) result.relDate = timeEl.textContent.trim();
      return result;
    }

    // Duration z existujúceho elementu na karte
    for (const sel of CFG.durationSelectors) {
      const el = card.querySelector(sel);
      if (el) {
        const t = el.textContent.trim();
        if (/\d+:\d+/.test(t)) { result.duration = t; break; }
        const human = t.match(/\b\d+\s*(?:h|hr|hour|hours|min|m|minute|minutes|sec|s|second|seconds)(?:\s+\d+\s*(?:min|m|minute|minutes|sec|s|second|seconds))*\b/i);
        if (human) { result.duration = human[0].trim(); break; }
        const m = t.match(/\b(\d+\s*(?:min|m|sec|s))\b/i);
        if (m) { result.duration = m[1]; break; }
      }
    }

    // ── Dátum — viac zdrojov ──────────────────────────────────

    // xHamster prints the upload day on the thumb and, after a fetch, under the title.
    const explicitDate = card.querySelector('.nvs-xh-date, .video-thumb__date-added, .entity-info-container__date');
    if (explicitDate) {
      const raw = (explicitDate.getAttribute('datetime') || explicitDate.getAttribute('data-tooltip') || explicitDate.textContent || '')
        .replace(/\s*[›>]\s*$/, '').replace(/\s+/g, ' ').trim();
      const parsed = new Date(raw);
      if (raw && !Number.isNaN(parsed.getTime()) && /\d{4}/.test(raw)) {
        result.date = parsed.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      } else if (/\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago/i.test(raw)) {
        result.relDate = raw;
      }
    }

    // 1. <time datetime="..."> element priamo na karte (xhamster, pornhub, ...)
    const timeEl = !result.date && card.querySelector('time[datetime]');
    if (timeEl) {
      const dt = timeEl.getAttribute('datetime') || '';
      const d = new Date(dt);
      if (!isNaN(d.getTime())) {
        result.date = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
      } else {
        result.relDate = (timeEl.textContent || '').trim() || dt;
      }
    }

    // 2. data-time / data-added / data-date atribúty na karte alebo potomkoch
    if (!result.date) {
      const dateAttrs = ['data-time', 'data-added', 'data-date', 'data-published', 'data-upload-date'];
      for (const attr of dateAttrs) {
        const el = card.querySelector(`[${attr}]`) || (card.hasAttribute(attr) ? card : null);
        if (el) {
          const val = el.getAttribute(attr) || '';
          const ts = /^\d{10}$/.test(val) ? new Date(parseInt(val) * 1000) : new Date(val);
          if (!isNaN(ts.getTime())) {
            result.date = ts.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
            break;
          }
        }
      }
    }

    // 3. Absolútny dátum z textu karty (Jun 15, 2026 / 15 Jun 2026 / 2026-06-15)
    const cardText = card.textContent || '';
    if (!result.date) {
      const absPatterns = [
        /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\b/i,
        /\b\d{1,2}\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}\b/i,
        /\b\d{4}-\d{2}-\d{2}\b/,
        /\b\d{2}\/\d{2}\/\d{4}\b/,
        /\b\d{1,2}\.\s*\d{1,2}\.\s*\d{4}\b/,
      ];
      for (const p of absPatterns) {
        const m = cardText.match(p);
        if (m) {
          let d = null;
          if (m[0].includes('.')) {
            const parts = m[0].split('.').map(s => parseInt(s.trim(), 10));
            if (parts.length >= 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
              d = new Date(parts[2], parts[1] - 1, parts[0]);
            }
          } else {
            d = new Date(m[0]);
          }
          if (d && !isNaN(d.getTime())) {
            result.date = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
            break;
          }
        }
      }
    }

    // 4. Relatívny čas ("4 months ago", "2 days ago", "1 week ago"...)
    if (!result.date && !result.relDate) {
      const relMatch = cardText.match(/\b(\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)\b/i)
        || cardText.match(/\b(just\s+now|yesterday|today)\b/i);
      if (relMatch) result.relDate = relMatch[1];
    }

    // ── Veľkosť — hľadaj vo všetkých potomkoch vrátane skrytých ──

    const sizeFromText = parseSizeMb(cardText);
    if (sizeFromText) {
      // Sanity: pre video dlhšie ako 3 min je veľkosť < 10 MB podozrivá (napr. preview clip na youporn)
      const dSec = result.duration ? parseDurationSeconds(result.duration) : 0;
      const tooSmall = dSec > 180 && sizeFromText < 10;
      if (!tooSmall) {
        result.sizeMb = sizeFromText;
        result.sizeText = formatSizeMb(sizeFromText);
      }
    }

    // Záloha: skúsiť data atribúty pre veľkosť (niektoré weby majú data-file-size)
    if (!result.sizeMb) {
      const sizeEl = card.querySelector('[data-file-size], [data-size], [data-filesize]');
      if (sizeEl) {
        const raw = sizeEl.getAttribute('data-file-size') || sizeEl.getAttribute('data-size') || sizeEl.getAttribute('data-filesize') || '';
        const bytes = parseInt(raw, 10);
        if (bytes > 0) {
          result.sizeMb = Math.round(bytes / (1024 * 1024));
          result.sizeText = formatSizeMb(result.sizeMb);
        }
      }
    }

    // ── Quality badge ──────────────────────────────────────────
    const qualMatch = cardText.match(/\b(4K|2160[pP]|2K|1440[pP]|1080[pP]|720[pP]|480[pP]|360[pP]|HD|FHD|UHD)\b/i);
    if (qualMatch) result.quality = qualMatch[1].toUpperCase().replace(/P$/, 'P');

    return result;
  }

  function extractBackgroundImageUrl(el) {
    if (!el) return '';
    const style = el.getAttribute('style') || '';
    const m = style.match(/background-image\s*:\s*url\((['"]?)(.*?)\1\)/i);
    if (!m?.[2]) return '';
    try { return new URL(m[2], location.href).href; } catch { return m[2]; }
  }

  function getCardThumbnail(card) {
    if (isPornonePage()) {
      const thumbImg = card.querySelector('img.thumbimg, img.imgvideo');
      const thumbSrc = thumbImg?.getAttribute('src') || thumbImg?.getAttribute('data-src') || thumbImg?.src || '';
      if (thumbSrc) {
        try { return new URL(thumbSrc, location.href).href; } catch { return thumbSrc; }
      }
    }
    const imgSrc = card.querySelector('img')?.src || '';
    if (imgSrc) return imgSrc;
    const bgEl = card.matches?.('.video-auth-placeholder-thumb, .video-auth-placeholder-thumb-square')
      ? card
      : card.querySelector('.video-auth-placeholder-thumb, .video-auth-placeholder-thumb-square, [style*="background-image"]');
    return extractBackgroundImageUrl(bgEl);
  }

  function getCardTitle(card, url) {
    if (isGofilePage()) {
      if (card.dataset.nvsFileName) return card.dataset.nvsFileName;
      const text = card.textContent || '';
      const m = text.match(/\b([A-Za-z0-9_.\-\s()[\]]+\.(?:mp4|mkv|avi|mov|webm|m4v|flv|ts))\b/i);
      if (m) return m[1].trim();
    }
    if (isSxyprnPage()) {
      const sxTitle = sxyprnCardTitle(card);
      if (sxTitle) return sxTitle;
    }
    if (isEromeAlbumListing()) {
      const eromeTitle = card.querySelector('a.album-title')?.textContent?.trim();
      if (eromeTitle) return eromeTitle;
    }
    if (isSpankBangPage()) {
      const spankbangTitle = window.NVSSpankBangListing?.titleFromCard(card, location.href);
      if (spankbangTitle) return spankbangTitle;
    }
    if (isPornonePage()) {
      const p1Title = card.querySelector('.videotitle')?.textContent?.trim()
        || card.querySelector('img.thumbimg, img.imgvideo')?.alt?.trim();
      if (p1Title) return p1Title;
    }
    if (isCumStPage()) {
      const caption = card.querySelector('.line-clamp-2')?.textContent?.trim();
      const creator = card.querySelector('.truncate')?.textContent?.trim();
      if (caption && creator) return `${creator} - ${caption}`;
      if (caption || creator) return caption || creator;
    }
    const imgAlt = card.querySelector('img')?.alt || '';
    const title = imgAlt
      || card.querySelector('[class*="title"]')?.textContent?.trim()
      || (card.matches?.('a[href]') ? card.title : '')
      || card.querySelector('a[href]')?.title
      || card.getAttribute('title')
      || '';
    if (title) return title;
    if (isFapFolderPage()) {
      const group = location.pathname.match(/\/groups\/([^/]+)/i)?.[1] || '';
      const postId = String(url || '').match(/\/posts\/(\d+)/i)?.[1] || '';
      return [group, postId ? `post ${postId}` : 'video'].filter(Boolean).join(' - ');
    }
    return '';
  }

  function parseSizeMb(text) {
    if (!text) return null;
    const m = String(text).match(/\b(\d+(?:[.,]\d+)?)\s*(GB|GiB|MB|MiB)\b/i);
    if (!m) return null;
    const value = parseFloat(m[1].replace(',', '.'));
    if (!Number.isFinite(value)) return null;
    return /^g/i.test(m[2]) ? value * 1024 : value;
  }

  function formatSizeMb(mb) {
    if (!Number.isFinite(mb) || mb <= 0) return null;
    if (mb < 1) return null;
    if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
    return `${Math.round(mb)} MB`;
  }

  function parseDurationSeconds(text) {
    if (!text) return null;
    const normalized = String(text).trim();
    const colon = normalized.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
    if (colon) {
      const a = parseInt(colon[1], 10);
      const b = parseInt(colon[2], 10);
      const c = colon[3] ? parseInt(colon[3], 10) : null;
      return c == null ? a * 60 + b : a * 3600 + b * 60 + c;
    }
    const h = normalized.match(/\b(\d+)\s*(?:h|hr|hour|hours)\b/i);
    const m = normalized.match(/\b(\d+)\s*(?:m|min|minute|minutes)\b/i);
    const s = normalized.match(/\b(\d+)\s*(?:s|sec|second|seconds)\b/i);
    const seconds = (h ? parseInt(h[1], 10) * 3600 : 0)
      + (m ? parseInt(m[1], 10) * 60 : 0)
      + (s ? parseInt(s[1], 10) : 0);
    return seconds > 0 ? seconds : null;
  }

  function parseDateValue(text) {
    if (!text) return null;
    const value = String(text);
    const direct = new Date(value);
    if (!Number.isNaN(direct.getTime())) return direct.getTime();

    if (/\btoday\b/i.test(value)) return Date.now();
    if (/\byesterday\b/i.test(value)) return Date.now() - 86400000;

    const rel = value.match(/\b(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago\b/i);
    if (!rel) return null;
    const amount = parseInt(rel[1], 10);
    const unitMs = {
      second: 1000,
      minute: 60000,
      hour: 3600000,
      day: 86400000,
      week: 604800000,
      month: 2629800000,
      year: 31557600000,
    };
    return Date.now() - amount * (unitMs[rel[2].toLowerCase()] || 0);
  }

  /**
   * Nájde správneho rodiča pre badge — img wrapper s opravenými CSS.
   * Kritické: force overflow:visible aby badge nebol orezaný.
   */
  // sxyprn: odznaky nesmú ležať v náhľade (zakrývali ikonky stránky). Dávame ich
  // do vlastného riadku pod náhľadom, tesne nad .post_control.
  function ensureSxyprnBar(card) {
    let bar = card.querySelector(':scope > .nvs-sx-bar');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className = 'nvs-sx-bar';
    const ctrl = card.querySelector(':scope > .post_control');
    if (ctrl) card.insertBefore(bar, ctrl); else card.appendChild(bar);
    return bar;
  }

    function getCardExtUrls(card) {
    if (!card) return [];
    const urls = [];
    const extRegex = /https?:\/\/(?:[a-zA-Z0-9-]+\.)?(?:streamcash\.to|vidara\.(?:so|to)|vidsonic\.(?:net|org)|vidfast\.(?:co|com)|streamtape\.(?:com|to)|doodstream\.(?:com|co)|dood\.[a-z]+|ds2play\.[a-z]+|doods\.[a-z]+|lulustream\.com|luluvdo\.(?:com|to)|luluvid\.(?:com|net|top)|lulust\.(?:com|to)|lulu\.stream|vidguard\.(?:to|com|net)|vgfplay\.com|filemoon\.(?:sx|to)|playmogo\.(?:com|to)|bigwarp\.(?:io|com)|strmup\.(?:to|cc)|streamhub\.(?:gg|to)|vidnest\.(?:io|com)|playmate\.to|savefiles\.com|voe\.sx)\/[^\s"'<>]+/gi;
    for (const a of card.querySelectorAll('a[href]')) {
      if (extRegex.test(a.href)) urls.push(a.href);
    }
    return [...new Set(urls)];
  }

  function sxyprnCardTitle(card) {
    const text = card.querySelector('.post_text');
    if (text) {
      const clone = text.cloneNode(true);
      clone.querySelectorAll('.hash_link, .post_b_text_el, .sub_cat_s, a.extlink, .extlink_icon, a[href^="http"]').forEach((n) => n.remove());
      const t = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t.slice(0, 140);
    }
    const tt = card.querySelector('a.post_time[title]')?.getAttribute('title') || '';
    return tt.split('#')[0].replace(/\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
  }

  function markScanError(card) {
    if (!card || card.querySelector('.nvs-source-badge')) return; // už máme použiteľné dáta
    const badge = card.querySelector('.nvs-badge:not(.nvs-badge-quality):not(.nvs-source-badge)');
    if (!badge) return;
    badge.classList.remove('nvs-badge-loading', 'nvs-badge-card-data');
    badge.classList.add('nvs-badge-error');
    badge.style.display = '';
    const textEl = badge.querySelector('.nvs-badge-text');
    if (textEl) textEl.textContent = '⚠ chyba skenu';
    badge.title = 'Sken zlyhal. Použi ⚡ Doplniť chýbajúce alebo Re-test.';
  }

  function getBadgeHost(card) {
    if (isSxyprnPage()) return ensureSxyprnBar(card);
    // Gofile používa reaktívny SPA framework; presun <img> cez replaceWith() rozbije
    // referenciu rodiča v DOMe a pri najbližšom re-renderi zhodí celú stránku na čiernu obrazovku.
    if (isGofilePage()) return card;
    // Pokús sa nájsť img wrapper zo zoznamu selektorov
    for (const sel of CFG.imgWrapSelectors) {
      const el = card.querySelector(sel);
      if (el && el.tagName !== 'IMG') {
        el.style.setProperty('overflow', 'visible', 'important');
        if (window.getComputedStyle(el).position === 'static') el.style.setProperty('position', 'relative', 'important');
        return el;
      }
    }

    // Fallback: img.parentElement (typicky <a> alebo <div>) — ale iba ak je to
    // naozaj tesný obal okolo obrázka. Na kartách s utility-class layoutom
    // (napr. gofile Tailwind: "min-w-0 flex-1") je img.parentElement celý
    // stĺpec karty — meno súboru, tlačidlá aj náhľad naraz. Badge (position:
    // absolute, bottom-left) sa potom prilepí na spodok CELEJ karty, nie na
    // roh obrázka, a prekryje sa s vlastnými metadátami stránky. Namiesto
    // dôverovania takémuto rodičovi obal obrázok vlastným tesným kontajnerom.
    const img = card.querySelector('img');
    if (img && img.parentElement && img.parentElement !== card) {
      const parent = img.parentElement;
      // The still image is taken out of flow so it can cover the same box as
      // the hover preview. Wrapping it would collapse that box.
      if (parent.matches('.thumb-image-container, .video-thumb__image-container')) {
        if (window.getComputedStyle(parent).position === 'static') parent.style.setProperty('position', 'relative', 'important');
        return parent;
      }
      const parentRect = parent.getBoundingClientRect();
      const imgRect = img.getBoundingClientRect();
      const isImgAbsolute = window.getComputedStyle(img).position === 'absolute';
      const parentIsTightWrap = parentRect.height > 0
        && parentRect.height <= imgRect.height + 40
        // Ratio-thumbnail wrappers often contain the absolute image plus the
        // site's own overlays and our quality badge. They are still a tight
        // image host; wrapping the image again would add a second full image
        // height to the card (seen on PimpBunny).
        && (parent.children.length <= 2 || isImgAbsolute);
      if (parentIsTightWrap) {
        // xHamster clips the hover sprite to this box. Unlocking overflow
        // lets the sprite sheet spill across the grid.
        if (!parent.matches('.thumb-image-container, .video-thumb__image-container')) {
          parent.style.setProperty('overflow', 'visible', 'important');
        }
        if (window.getComputedStyle(parent).position === 'static') parent.style.setProperty('position', 'relative', 'important');
        return parent;
      }

      // If the image itself is position:absolute (common on sites whose CSS
      // makes the thumbnail fill an already-sized wrapper, e.g. FapHouse's
      // .t-i inside .t-iw), it contributes NO size to a normal-flow parent.
      // An inline-block anchor around it then collapses to 0x0 — which also
      // collapses the absolutely-positioned image inside it, making every
      // thumbnail vanish. Copy the image's pre-move rendered size onto the
      // anchor explicitly so it never depends on the image's own box model.
      const anchor = document.createElement('span');
      anchor.className = 'nvs-badge-anchor';
      anchor.style.cssText = isImgAbsolute
        ? `position:relative !important; display:inline-block !important; width:${imgRect.width}px !important; height:${imgRect.height}px !important;`
        : 'position:relative !important; display:inline-block !important;';
      img.replaceWith(anchor);
      anchor.appendChild(img);
      return anchor;
    }

    // Posledný fallback: karta samotná (position:relative už nastavené)
    return card;
  }

  function injectBadge(card, meta) {
    let badge = card.querySelector('.nvs-main-badge') || card.querySelector('.nvs-badge:not(.nvs-badge-quality):not(.nvs-source-badge)');

    const host = getBadgeHost(card);

    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'nvs-badge nvs-main-badge';
      badge.innerHTML = `
        <svg viewBox="0 0 24 24"><path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V9h14v10zm0-12H5V5h14v2z"/></svg>
        <span class="nvs-badge-text">…</span>
      `;
      host.appendChild(badge);

      // Okamžite zobraz dáta z karty (bez čakania na fetch)
      const cardMeta = extractCardMeta(card);
      const immediateText = buildBadgeText(cardMeta, true, prefersMediaBadge());
      if (immediateText) {
        badge.querySelector('.nvs-badge-text').textContent = immediateText;
        badge.classList.add('nvs-badge-card-data');
      } else {
        badge.classList.add('nvs-badge-loading');
        badge.querySelector('.nvs-badge-text').textContent = '⏳';
      }

      if (isNoodleMagazinePage()) {
        updateNoodleCardInfo(card, cardMeta);
      }
    }

    if (meta) {
      updateBadge(badge, card, meta);
    }

    return badge;
  }

  /**
   * Zostaví text pre badge zo získaných metadát.
   * cardDataOnly=true → zobrazí aj len relatívny čas/duration (bez dátumu z fetch).
   */
  function buildBadgeText(meta, cardDataOnly = false, preferMedia = false) {
    const parts = [];

    if (isArchvePage() && /^archve-(?:video|album)-/.test(meta.adapter || '')) {
      const album = meta.adapter.startsWith('archve-album-');
      if (meta.sizeText) parts.push(meta.sizeText);
      if (meta.duration) parts.push(`${album ? 'Ø ' : ''}${meta.duration}${meta.durationPartial ? ' *' : ''}`);
      if (meta.date) parts.push(`${meta.dateEstimated ? '≈' : ''}${meta.date}${meta.datePartial ? ' *' : ''}`);
      if (album && !meta.complete) parts.push(`${meta.loadedCount}/${meta.videoCount}`);
      return parts.join(' • ');
    }

    if (meta.failureReason === 'exclusive_locked') {
      if (meta.date) parts.push(meta.date);
      else if (meta.relDate) parts.push(meta.relDate);
      parts.push('LOCKED');
      return parts.join(' • ');
    }

    if (preferMedia) {
      if (meta.duration) parts.push(meta.duration);
      const mediaSize = meta.sizeText || (meta.sizeMb ? formatSizeMb(meta.sizeMb) : null);
      if (mediaSize) parts.push(mediaSize);
      if (meta.quality) parts.push(meta.quality);
      return parts.join(' • ');
    }

    if (meta.duration && cardDataOnly) {
      parts.push(meta.duration);
    }

    // Absolútny dátum má prednosť pred relatívnym
    if (meta.date) {
      parts.push(`${meta.dateEstimated ? '≈' : ''}${meta.date}`);
    } else if (meta.relDate) {
      parts.push(meta.relDate);
    }

    // Veľkosť zobrazujeme samostatne. Kvalita bez veľkosti sa tu nepoužije,
    // aby sa "4K" nikdy netvárilo ako údaj o veľkosti súboru.
    const sizeText = meta.sizeText || (meta.sizeMb ? formatSizeMb(meta.sizeMb) : null);
    if (sizeText) parts.push(sizeText);

    // Duration iba ak nie je na karte alebo sme v cardDataOnly móde
    if (meta.duration && !cardDataOnly && parts.length === 0) {
      parts.push(meta.duration);
    }

    return parts.join(' • ');
  }

  function updateBadge(badge, card, meta) {
    importWorkbench?.schedule();
    if (!badge && card) {
      badge = card.querySelector('.nvs-main-badge') || card.querySelector('.nvs-badge:not(.nvs-badge-quality):not(.nvs-source-badge)');
    }
    if (!badge) return;
    if (/(^|\.)69tubed\.(com|live)$/i.test(location.hostname) && meta?.adapter === '69tubed-byse-v1') {
      card.dataset.nvsTubed69Meta = JSON.stringify({ quality: meta.quality, sizeMb: meta.sizeMb, duration: meta.duration });
    }
    badge.classList.remove('nvs-badge-loading', 'nvs-badge-card-data', 'nvs-badge-locked', 'nvs-badge-error');

    const previousMeta = state.cardMeta.get(card) || {};
    meta = { ...previousMeta, ...meta };
    if (!isInternetChicksPage() && previousMeta.sizeExact && !meta.sizeExact) {
      meta.sizeMb = previousMeta.sizeMb;
      meta.sizeText = previousMeta.sizeText;
      meta.sizeExact = true;
    }
    meta.sizeMb = meta.sizeMb || parseSizeMb(meta.sizeText || '');

    // Zahoď podozrivo malú veľkosť — napr. youporn preview clip (3 MB pre 15-min video)
    if (meta.sizeMb && !meta.sizeExact) {
      const dSec = parseDurationSeconds(meta.duration || '') || 0;
      if (dSec > 180 && meta.sizeMb < 10) {
        meta.sizeMb = null;
        meta.sizeText = null;
      }
    }

    // Doplň chýbajúci relDate z karty ak fetch nevrátil dátum
    if (!meta.date && !meta.relDate) {
      const cardMeta = extractCardMeta(card);
      meta.relDate = cardMeta.relDate;
      if (!meta.duration) meta.duration = cardMeta.duration;
      if (!meta.quality) meta.quality = cardMeta.quality;
      if (!meta.sizeText) meta.sizeText = cardMeta.sizeText;
      if (!meta.sizeMb) meta.sizeMb = cardMeta.sizeMb;
    }

    state.cardMeta.set(card, { ...(state.cardMeta.get(card) || {}), ...meta });
    // Public, versioned DOM snapshot shared with the userscript sandbox.
    // sxyprn: skutočný (nie preview) stream, ktorý Selector našiel – rovnaká logika ako pri exporte.
    let sxPlayUrl = '';
    let sxPlayFormat = '';
    if (isSxyprnPage()) {
      const isCdn = u => /trafficdeposit\.com|\.vid(?:[?#]|$)|vidthumb|preview|get_preview/i.test(u || '');
      const ext = (meta.sourceUrls || []).find(u => u && !/sxyprn\./i.test(u) && !isCdn(u));
      sxPlayUrl = (meta.streamUrl && !isCdn(meta.streamUrl) && !/sxyprn\./i.test(meta.streamUrl)) ? meta.streamUrl : (ext || '');
      // An extracted stream can have a signed URL with no file extension.
      const extracted = (meta.sourceResults || []).find(s => s.status === 'verified' &&
        s.streamUrl === sxPlayUrl && s.sourceUrl && s.streamUrl !== s.sourceUrl);
      if (extracted) sxPlayFormat = extracted.streamFormat || (/\.m3u8(?:[?#]|$)/i.test(sxPlayUrl) ? 'hls' : 'mp4');
    } else if (meta.streamUrl && /^https?:\/\//i.test(meta.streamUrl) && !/vidthumb|preview|get_preview/i.test(meta.streamUrl)) {
      sxPlayUrl = meta.streamUrl;
      sxPlayFormat = /\.m3u8(?:[?#]|$)/i.test(meta.streamUrl) ? 'hls' : 'mp4';
    }
    card.dataset.nexusVideoMeta=JSON.stringify({version:1,playUrl:sxPlayUrl,playFormat:sxPlayFormat,watchUrl:card.dataset.nvsUrl || getVideoUrlFromCard(card),sizeMb:meta.sizeMb || null,sizeText:meta.sizeText || '',sizeEstimated:Boolean(meta.sizeEstimated || /^\s*[~≈]/.test(meta.sizeText || '')),quality:meta.quality || '',duration:meta.duration || '',width:meta.width || 0,height:meta.height || 0,date:meta.date || '',dateEstimated:Boolean(meta.dateEstimated)});
    document.dispatchEvent(new Event('nexus-video-metadata'));

    if (meta.failureReason === 'exclusive_locked') badge.classList.add('nvs-badge-locked');
    if (meta.dateEstimated && !meta.failureMessage) badge.title = 'Približný dátum: čas poslednej zmeny videosúboru, nie potvrdený dátum uploadu.';
    else if (meta.failureMessage) badge.title = meta.failureMessage;
    else badge.removeAttribute('title');

    if (isNoodleMagazinePage()) {
      updateNoodleCardInfo(card, meta);
    }

    const paintedDate = isXHamsterPage() && window.NVSXhamsterLayout?.paintDate?.(card, meta.date || meta.relDate);
    const text = buildBadgeText(meta, false, prefersMediaBadge() || Boolean(paintedDate));
    if (isInternetChicksPage() || isSxyprnPage()) {
      let sourceBadge = card.querySelector('.nvs-source-badge');
      if (meta.selectedPlayer && meta.selectedSourceHost) {
        if (!sourceBadge) {
          sourceBadge = document.createElement('div');
          sourceBadge.className = 'nvs-badge nvs-source-badge';
          sourceBadge.setAttribute('role', 'button');
          sourceBadge.setAttribute('tabindex', '0');
          getBadgeHost(card).appendChild(sourceBadge);
        }
        if (!sourceBadge.dataset.nvsPopoverAttached) {
          sourceBadge.dataset.nvsPopoverAttached = '1';
          sourceBadge.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const currentMeta = state.cardMeta.get(card) || meta;
            openServerSwitcherPopover(card, currentMeta, sourceBadge);
          }, true);
        }
        const checked = Number(meta.verifiedSourceCount || 0);
        const total = Number(meta.totalSourceCount || 0);
        const sourceName = meta.selectedSourceHost.split('.')[0];
        const sz = meta.sizeText || (meta.sizeMb ? formatSizeMb(meta.sizeMb) : '');
        const sizePart = sz ? ` · ${sz}` : '';
        sourceBadge.textContent = `P${String(meta.selectedPlayer).padStart(2, '0')} ${sourceName}${sizePart} · TOP ${checked}/${total} ${meta.bestOfAllVerified ? '✓' : '⚠'}`;
        const unresolved = (meta.sourceResults || []).filter(source => source.status !== 'verified')
          .map(source => {
            let note = 'stream sa nepodarilo rozpoznať';
            if (source.status === 'mirror') note = 'mirror VOE';
            else if (source.status === 'unavailable') note = 'hoster neodpovedal';
            else if (source.status === 'unsupported') note = 'nepodporovaný hoster (šifrovaný prehrávač)';
            return `P${String(source.player).padStart(2, '0')} ${source.host}: ${note}`;
          }).join('\n');
        sourceBadge.title = (meta.bestOfAllVerified
          ? `TOP dostupný: najlepší z ${checked}/${total} overených zdrojov.${meta.comparisonSizeEstimated ? ' Veľkosť HLS je odhad zo segmentov.' : ''}${unresolved ? `\n${unresolved}` : ''}`
          : `TOP dostupný: najlepší z ${checked}/${total} overených zdrojov.\n${unresolved}`)
          + '\n\n💡 Kliknutím otvoríte prepínač serverov a detaily';
        sourceBadge.classList.toggle('nvs-source-all-verified', Boolean(meta.bestOfAllVerified));
      } else {
        sourceBadge?.remove();
      }
    }
    if (isFapFolderPage()) {
      if (!meta.duration) card.querySelector('.nvs-duration-badge')?.remove();
      if (!meta.quality) card.querySelector('.nvs-badge-quality')?.remove();
    }

    if (isFapFolderPage() && meta.streamUrl && !meta._playerMetadataAttempted && !meta._durationLoading) {
      hydrateFapFolderDuration(card, meta.streamUrl);
    }

    if (!text) {
      // Nemáme NIC — schovaj badge
      badge.style.display = 'none';
      return;
    }

    badge.style.display = '';
    const textEl = badge.querySelector('.nvs-badge-text');
    if (textEl) textEl.textContent = text;

    // Quality badge vpravo hore (aktualizuj alebo vytvor)
    const qualityToShow = meta.quality || extractCardMeta(card).quality;
    if (qualityToShow) {
      let qBadge = card.querySelector('.nvs-badge-quality');
      if (!qBadge) {
        qBadge = document.createElement('div');
        qBadge.className = 'nvs-badge nvs-badge-quality';
        getBadgeHost(card).appendChild(qBadge);
      }
      qBadge.textContent = qualityToShow;
    } else if (isFapFolderPage()) {
      card.querySelector('.nvs-badge-quality')?.remove();
    }

    // Duration badge vpravo dole (ak nie je pôvodný na karte)
    if (meta.duration) {
      const existingDur = isFapFolderPage() ? null : CFG.durationSelectors.map(s => card.querySelector(s)).find(el => el && !el.classList.contains('nvs-duration-badge'));
      if (!existingDur) {
        const durBadge = card.querySelector('.nvs-duration-badge') || document.createElement('div');
        durBadge.className = 'nvs-duration-badge';
        durBadge.textContent = meta.duration;
        getBadgeHost(card).appendChild(durBadge);
      }
    } else if (isFapFolderPage()) {
      card.querySelector('.nvs-duration-badge')?.remove();
    }

    if (state.filterDuration !== 'all') {
      applyFilterToCard(card, state.filterDuration);
    }

  }

  function updateNoodleCardInfo(card, meta = {}) {
    if (!card || !isNoodleMagazinePage()) return;

    const url = getVideoUrlFromCard(card);
    const cached = url ? state.fetchCache.get(url) : null;
    const merged = {
      ...extractCardMeta(card),
      ...(state.cardMeta.get(card) || {}),
      ...(cached || {}),
      ...(meta || {}),
    };

    const sizeText = merged.sizeText || (merged.sizeMb ? formatSizeMb(merged.sizeMb) : null);
    const quality = merged.quality || extractCardMeta(card).quality;
    const title = getCardTitle(card, url) || getNoodleVisibleTitle(card);

    const parts = [];
    if (merged.duration) parts.push(merged.duration);
    if (quality) parts.push(quality);
    if (sizeText) parts.push(sizeText);
    if (title) parts.push(title);

    if (!parts.length) return;

    let info = card.querySelector('.nvs-noodle-info');
    if (!info) {
      info = document.createElement('div');
      info.className = 'nvs-noodle-info';
      const titleEl = findNoodleTitleElement(card);
      if (titleEl?.parentElement) {
        titleEl.insertAdjacentElement('afterend', info);
      } else {
        card.appendChild(info);
      }
    }

    info.textContent = parts.join(' • ');
    info.title = parts.join(' • ');
  }

  function findNoodleTitleElement(card) {
    const links = [...card.querySelectorAll('a[href]')];
    const videoUrl = getVideoUrlFromCard(card);

    const titleLink = links.find((link) => {
      if (!videoUrl || link.href !== videoUrl) return false;
      const text = (link.textContent || link.title || '').replace(/\s+/g, ' ').trim();
      return text.length > 3 && !link.querySelector('img');
    });
    if (titleLink) return titleLink;

    return card.querySelector('[class*="title"], [class*="name"], h2, h3, p');
  }

  function getNoodleVisibleTitle(card) {
    const titleEl = findNoodleTitleElement(card);
    return (titleEl?.textContent || titleEl?.getAttribute?.('title') || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function hydrateFapFolderDuration(card, streamUrl) {
    const meta = state.cardMeta.get(card) || {};
    if (meta._durationLoading) return;
    meta._durationLoading = true;
    meta._playerMetadataAttempted = true;
    state.cardMeta.set(card, meta);
    const url = getVideoUrlFromCard(card);
    if (url) state.fetchCache.set(url, meta);
    state.fapFolderProbeQueue.push({ card, streamUrl, meta });
    drainFapFolderProbes();
  }

  function drainFapFolderProbes() {
    while (state.fapFolderProbeActive < 2 && state.fapFolderProbeQueue.length) {
      const { card, streamUrl, meta } = state.fapFolderProbeQueue.shift();
      if (!card.isConnected) { meta._durationLoading = false; continue; }
      state.fapFolderProbeActive++;
      startFapFolderProbe(card, streamUrl, meta);
    }
  }

  function startFapFolderProbe(card, streamUrl, meta) {
    const url = getVideoUrlFromCard(card);

    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      video.remove();
      meta._durationLoading = false;
      state.fapFolderProbeActive--;
      drainFapFolderProbes();
    };
    const timer = setTimeout(cleanup, 9000);
    video.addEventListener('loadedmetadata', () => {
      clearTimeout(timer);
      if (Number.isFinite(video.duration) && video.duration > 0) {
        const seconds = Math.round(video.duration);
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        meta.duration = h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
      }
      const height = Number(video.videoHeight || 0);
      const width = Number(video.videoWidth || 0);
      if (width > 0 && height > 0) {
        meta.width = width;
        meta.height = height;
        meta.quality = `${Math.min(width, height)}P`;
      }
      if (url) state.fetchCache.set(url, { ...(state.fetchCache.get(url) || {}), ...meta });
      cleanup();
      updateBadge(card.querySelector('.nvs-badge'), card, meta);
    }, { once: true });
    video.addEventListener('error', cleanup, { once: true });
    document.body.appendChild(video);
    video.src = streamUrl;
  }


  // ── Fetch Queue ───────────────────────────────────────────

  function getLazyObserver() {
    if (state.intersectObserver) return state.intersectObserver;

    state.intersectObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const card = entry.target;
        state.intersectObserver.unobserve(card);

        const url = getVideoUrlFromCard(card);
        if (url) enqueue(card, url);
      }
    }, {
      rootMargin: CFG.intersectMargin,
      threshold: 0.01
    });

    return state.intersectObserver;
  }

  function discardPaidCard(card) {
    if (!isXHamsterPage() || !card?.isConnected) return false;
    const url = card.dataset.nvsUrl || '';
    const paidUrl = /faphouse\.com|\/fh\/out\b/i.test(url);
    if (!paidUrl && !window.NVSXhamsterListing?.isPaidCard?.(card)) return false;
    state.selected.delete(card);
    if (url) {
      removeFromSessionSelection(url);
      state.queuedUrls.delete(url);
      state.fetchCache.delete(url);
      state.queue = state.queue.filter((job) => job.url !== url && job.card !== card);
    }
    card.remove();
    return true;
  }

  function enqueue(card, url, force = false) {
    const paidUrl = /faphouse\.com|\/fh\/out\b/i.test(String(url || ''));
    const paidCard = discardPaidCard(card);
    if (paidCard || paidUrl) {
      if (url) {
        state.queuedUrls.delete(url);
        state.fetchCache.delete(url);
        state.queue = state.queue.filter((job) => job.url !== url);
        removeFromSessionSelection(url);
      }
      if (card?.isConnected) card.remove();
      return 'skip';
    }
    if (!force && state.fetchCache.has(url)) {
      const meta = state.fetchCache.get(url);
      updateBadge(card.querySelector('.nvs-badge'), card, meta);
      recordScanOutcome(url, meta, true);
      return 'cache';
    }

    if (state.queuedUrls.has(url)) {
      if (state.fetchCache.has(url)) {
        const meta = state.fetchCache.get(url);
        updateBadge(card.querySelector('.nvs-badge'), card, meta);
        recordScanOutcome(url, meta, true);
      }
      return 'queued';
    }

    if (!state.scanRun.active) beginScanRun('Automatický scan kariet');
    if (!state.scanRun.urls.has(url)) {
      state.scanRun.urls.add(url);
      state.scanRun.total++;
    }
    state.queuedUrls.add(url);
    state.queue.push({ card, url, force: force || state.isRescanActive });
    if (isCamwhoresPage()) {
      // Listing scans enqueue many cards synchronously. Let them join one
      // backend batch instead of starting one request per DOM card.
      if (!camwhoresQueueTimer) {
        camwhoresQueueTimer = setTimeout(() => {
          camwhoresQueueTimer = null;
          processQueue();
        }, 40);
      }
    } else {
      processQueue();
    }
    return 'queued';
  }

  let camwhoresQueueTimer = null;

  function processQueue() {
    if (isCamwhoresPage()) {
      if (state.activeFetches > 0) return;
      const batch = state.queue.splice(0, 100);
      if (!batch.length) { finishScanRunIfIdle(); return; }
      state.activeFetches = batch.length;
      void (async () => {
        let results = {};
        let failed = false;
        try {
          const response = await chrome.runtime.sendMessage({
            type: 'FETCH_CAMWHORES_META_BATCH',
            items: batch.map(({ url, force }) => ({ url, force })),
          });
          results = response?.results || {};
        } catch { failed = true; }
        for (const { card, url } of batch) {
          state.activeFetches--;
          const meta = results[url] || null;
          recordScanOutcome(url, meta, Boolean(meta?._cacheHit), failed);
          if (meta) {
            state.fetchCache.set(url, meta);
            for (const currentCard of findCardsByUrl(url)) {
              updateBadge(currentCard.querySelector('.nvs-badge'), currentCard, meta);
            }
          } else {
            const badge = card?.querySelector('.nvs-badge');
            if (badge?.classList.contains('nvs-badge-loading')) badge.style.display = 'none';
          }
        }
        updateFetchCounter();
        processQueue();
        finishScanRunIfIdle();
      })();
      return;
    }
    const maxConcurrent = isCamwhoresPage() ? CFG.camwhoresMaxConcurrent : CFG.maxConcurrent;
    const twoPhase = isSxyprnPage() || isInternetChicksPage();
    while (state.activeFetches < maxConcurrent && state.queue.length > 0) {
      // Rýchle (quick) úlohy majú prednosť pred pomalými hĺbkovými (deep).
      const nextIdx = twoPhase ? Math.max(0, state.queue.findIndex((j) => j.phase !== 'deep')) : 0;
      const job = state.queue.splice(nextIdx, 1)[0];
      const { card, url, force } = job;
      state.activeFetches++;

      void (async () => {
        let response = null;
        let failed = false;
        const jobTitle = (twoPhase ? getCardTitle(card, url) : '') || url;
        state.currentScan = { title: jobTitle, url, phase: job.phase === 'deep' ? 'deep' : (twoPhase ? 'quick' : 'full'), at: Date.now() };
        try {
          if (twoPhase && job.phase !== 'deep') {
            const cardExtUrls = isSxyprnPage() ? getCardExtUrls(card) : [];
            const q = await chrome.runtime.sendMessage({ type: 'FETCH_META', url, force, quick: true, cardExtUrls });
            const qm = q?.meta;
            const incomplete = qm && (qm._stale || qm.adapter === 'sxyprn-source-quick');
            if (incomplete) {
              // Štítok sa ukáže hneď (z disku alebo z rýchleho skenu); externé servery dohľadá deep fáza.
              for (const c of findCardsByUrl(url)) updateBadge(c.querySelector('.nvs-badge'), c, qm);
              state.activeFetches--;
              state.queue.push({ card, url, force, phase: 'deep' });
              updateFetchCounter();
              processQueue();
              return;
            }
            response = q;
          } else {
            const cardExtUrls = isSxyprnPage() ? getCardExtUrls(card) : [];
            response = await chrome.runtime.sendMessage({ type: 'FETCH_META', url, force, cardExtUrls });
          }
        } catch {
          failed = true;
        }
        if (state.currentScan?.url === url) state.currentScan = null;
        state.activeFetches--;
        if (/faphouse\.com|\/fh\/out\b/i.test(String(url || '')) || (card?.isConnected && window.NVSXhamsterListing?.isPaidCard?.(card))) {
          state.fetchCache.delete(url);
          state.queuedUrls.delete(url);
          state.selected.delete(card);
          removeFromSessionSelection(url);
          if (card?.isConnected) card.remove();
          processQueue();
          finishScanRunIfIdle();
          return;
        }

        if (failed) {
          recordScanOutcome(url, null, false, true);
          if (twoPhase) markScanError(card);
          processQueue();
          finishScanRunIfIdle();
          return;
        }

        const meta = response?.meta;
        if (meta && isSpankBangPage()) state.spankbangTagLoader?.remember?.(url, meta);
        if (isRedgifsPage()) {
          console.log('[NVS redgifs] FETCH_META', url, '→', meta ? `dur=${meta.duration} q=${meta.quality} size=${meta.sizeText}` : 'null');
        }
        recordScanOutcome(url, meta, Boolean(meta?._cacheHit));
        if (meta) {
          state.fetchCache.set(url, meta);
          const allCards = findCardsByUrl(url);
          for (const c of allCards) {
            const badge = c.querySelector('.nvs-badge');
            updateBadge(badge, c, meta);
          }
        } else {
          const badge = card.querySelector('.nvs-badge');
          if (twoPhase) {
            markScanError(card);
          } else if (badge && badge.classList.contains('nvs-badge-loading')) {
            badge.style.display = 'none';
          }
        }
        updateFetchCounter();

        processQueue();
        finishScanRunIfIdle();
      })();
    }
    finishScanRunIfIdle();
  }

  function updateFetchCounter() {
    importWorkbench?.schedule();
    const panel = document.getElementById('nvs-sort-panel');
    if (!panel) return;
    const total = state.queuedUrls.size;
    const done = total - state.queue.length - state.activeFetches;
    const el = panel.querySelector('#nvs-fetch-counter');
    if (el) el.textContent = `${Math.min(done, total)}/${total}`;
    window.__nvsUpdateHud?.();
  }

  function findCardsByUrl(url) {
    if (!url) return [];
    // Match on the cached dataset URL via a CSS attribute selector — the browser
    // resolves this in native code, avoiding a per-card JS URL recompute. Cards
    // are guaranteed to have dataset.nvsUrl set because scan() called
    // getVideoUrlFromCard on each before any fetch could complete.
    const escaped = (window.CSS && CSS.escape) ? CSS.escape(url) : url.replace(/["\\]/g, '\\$&');
    return [...document.querySelectorAll(`[${CFG.processedAttr}="1"][data-nvs-url="${escaped}"]`)];
  }

  // Redgifs tiles have no <a href="/watch/..."> — the gif id is embedded in the
  // thumbnail/poster filename, e.g. media.redgifs.com/MediumOilyThrush-mobile.jpg
  // → id "mediumoilythrush". Reconstruct a canonical /watch/<id> URL from it.
  function redgifsWatchUrlFromCard(card) {
    if (!isRedgifsPage() || !card) return null;
    const candidates = [];
    const img = card.querySelector?.('img');
    if (img) { candidates.push(img.src, img.currentSrc, img.getAttribute?.('data-src')); }
    const video = card.querySelector?.('video');
    if (video) { candidates.push(video.poster, video.src, video.currentSrc); }
    const bg = extractBackgroundImageUrl(card.querySelector?.('[style*="background-image"]') || card);
    if (bg) candidates.push(bg);
    // an <a href> to a gif page if one exists
    const a = card.matches?.('a[href]') ? card : card.querySelector?.('a[href]');
    if (a?.href) candidates.push(a.href);

    for (const raw of candidates) {
      if (!raw) continue;
      // media file: /<Name>-mobile.jpg | -poster.jpg | -silent.mp4 | .mp4
      let m = String(raw).match(/redgifs\.com\/([A-Za-z0-9]+?)(?:-(?:mobile|poster|silent|large|small))?\.(?:jpg|jpeg|png|webp|mp4|webm)/i);
      if (m) return `https://www.redgifs.com/watch/${m[1].toLowerCase()}`;
      // canonical page url form
      m = String(raw).match(/redgifs\.com\/(?:watch|ifr|i|gifs)\/([A-Za-z0-9]+)/i);
      if (m) return `https://www.redgifs.com/watch/${m[1].toLowerCase()}`;
    }
    return null;
  }

  function getVideoUrlFromCard(card) {
    // Cache the resolved URL on the card. This function is called repeatedly
    // (scan, every completed fetch, sort, filter) and each call does DOM queries
    // + URL parsing. Without caching, N cards × N fetches = O(N²) and the tab
    // freezes once a few hundred cards are loaded. dataset write is cheap.
    if (card.dataset.nvsUrl) {
      if (isSxyprnPage() && !card.dataset.nvsUrl.includes('/post/')) {
        delete card.dataset.nvsUrl;
      } else {
        return card.dataset.nvsUrl;
      }
    }
    const resolved = computeVideoUrlFromCard(card);
    // Cache only a real URL. A null result can happen while a card's media/anchor
    // is still lazy-loading (e.g. redgifs) — leaving it uncached lets a later call
    // resolve it once the DOM fills in, instead of freezing the empty answer.
    if (resolved) card.dataset.nvsUrl = resolved;
    return resolved;
  }

  function computeVideoUrlFromCard(card) {
    if (isArchvePage() && card.matches?.('a.media-card[href]')) return card.href.split('#')[0];
    if (isSpankBangPage()) {
      for (const link of card.querySelectorAll?.('a[href]') || []) {
        const url = window.NVSSpankBangListing?.watchUrl(link.getAttribute('href'), location.href);
        if (url) return url;
      }
      return null;
    }
    if (isXVideosPage()) {
      for (const link of card.querySelectorAll('a[href]')) {
        const url = window.NVSXvideosListing?.watchUrl(link.href, location.href);
        if (url) return url;
      }
      return null;
    }
    if (isPimpBunnyPage()) {
      const link = card.querySelector('a[class*="ui-card-link"][href]');
      return window.NVSPimpBunnyListing.watchUrl(link?.getAttribute('href'), location.href);
    }
    if (isEromeAlbumListing()) {
      const link = card.querySelector('a.album-link[href], a.album-title[href]');
      return window.NVSEromeListing.watchUrl(link?.getAttribute('href'), location.href) || null;
    }
    if (isLeakedzonePage()) {
      const link = card.matches?.('a[href*="/video/"], a[href*="/short/"]') ? card : card.querySelector('a[href*="/video/"], a[href*="/short/"]');
      if (link?.href) return link.href.split('#')[0];
    }
    if (isGofilePage()) {
      const gfUrl = getGofileVideoUrl(card);
      if (gfUrl) return gfUrl;
    }

    // Redgifs first — its tiles carry the id in the thumbnail, not an anchor.
    const rg = redgifsWatchUrlFromCard(card);
    if (rg) return rg;

    if (isCamwhoresPage() || isXxbritsPage()) {
      const cw = getCamwhoresVideoUrlFromNode(card);
      if (cw) return cw;
    }

    // SxyPrn: striktne použi natívny odkaz na post (/post/<id>), nie externé linky
    // v popise karty (.post_text: vidara, lulustream a pod.)
    if (isSxyprnPage()) {
      const postLink = card.matches?.('a[href*="/post/"]') ? card : card.querySelector('a[href*="/post/"]');
      if (postLink?.href) {
        try {
          const url = new URL(postLink.href, location.origin);
          url.search = '';
          url.hash = '';
          return url.href;
        } catch { }
      }
    }

    const links = [
      ...(card.matches?.('a[href]') ? [card] : []),
      ...card.querySelectorAll('a[href]')
    ];

    // Pass 1: strict video URL match
    for (const link of links) {
      if (!link?.href) continue;
      if (!isVideoUrl(link.href)) continue;
      try {
        const url = new URL(link.href, location.origin);
        url.hash = '';
        if (isXHamsterPage()) url.search = '';
        return url.href;
      } catch { }
    }

    // Pass 2: fallback — any same-host link with a non-trivial path (handles sites with
    // unusual URL patterns that don't match videoUrlPatterns but are still video pages)
    for (const link of links) {
      if (!link?.href) continue;
      try {
        const url = new URL(link.href);
        if (url.hostname !== location.hostname) continue;
        const path = url.pathname;
        // Must be a real page path (not just /, not a static asset)
        if (path.length < 4) continue;
        if (/\.(css|js|png|jpg|gif|svg|ico|woff|ttf)$/i.test(path)) continue;
        // Skip obvious nav/category pages and non-video content paths
        if (/^\/(tag|tags|category|categories|page|pages|search|login|register|account|user|profile|contact|about|terms|privacy|channel[s]?|model[s]?|pornstar[s]?|studio[s]?|site[s]?|network[s]?)\b/i.test(path)) continue;
        url.hash = '';
        return url.href;
      } catch { }
    }

    return null;
  }

  // ── Import Bar ────────────────────────────────────────────

  function injectImportBar() {
    if (importWorkbench) return;
    if (document.getElementById('nvs-import-bar')) return;

    const bar = document.createElement('div');
    bar.id = 'nvs-import-bar';
    bar.innerHTML = `
      <span id="nvs-bar-count">0</span>
      <span class="nvs-bar-label">videí vybraných</span>
      <div class="nvs-bar-sep"></div>
      <button class="nvs-bar-btn nvs-btn-play-split" id="nvs-btn-play-splitscreen" title="Prehrať vybrané videá v Split-Screen prehrávači" style="background: linear-gradient(135deg, #9333ea, #db2777); color: white; font-weight: 700;">
        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        ▶ Prehrať vybrané
      </button>
      <div class="nvs-bar-sep"></div>
      <button class="nvs-bar-btn nvs-btn-import" id="nvs-btn-import-8000" title="Import do Nexus Dashboard (port 8000)">
        <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        Import :8000
      </button>
      <button class="nvs-bar-btn nvs-btn-secondary" id="nvs-btn-import-8001" title="Import do Nexus Dashboard (port 8001)">
        <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        :8001
      </button>
      <button class="nvs-bar-btn nvs-btn-secondary" id="nvs-btn-import-8002" title="Import do Nexus Dashboard (port 8002)">
        <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        :8002
      </button>
      <div class="nvs-bar-sep"></div>
      <div class="nvs-batch-input-wrap">
        <input type="text" id="nvs-batch-name" class="nvs-batch-input" placeholder="Názov batchu..." title="Vlastný názov batchu pre import do Nexus Dashboardu" />
      </div>
      <button class="nvs-bar-btn nvs-btn-batch" id="nvs-btn-import-batch" title="Importovať vybrané videá do pomenovaného batchu">
        <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        ⚡ Batch Import
      </button>
      <div class="nvs-bar-sep"></div>
      <button class="nvs-bar-btn nvs-btn-secondary" id="nvs-btn-copy-urls" title="Kopírovať URL adresy do schránky">
        <svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
        Kopírovať URL
      </button>
      <button class="nvs-bar-btn nvs-btn-secondary" id="nvs-btn-export-json" title="Exportovať ako JSON súbor">
        <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        Export JSON
      </button>
      <div class="nvs-bar-sep"></div>
      <button class="nvs-bar-btn nvs-btn-danger" id="nvs-btn-deselect-all" title="Zrušiť výber všetkých">
        <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        Zrušiť výber
      </button>
    `;

    document.body.appendChild(bar);

    // Event listeners
    document.getElementById('nvs-btn-play-splitscreen')?.addEventListener('click', () => {
      const nussPlay = document.querySelector('#nuss-quick-selection [data-quick="play"]');
      if (nussPlay && !nussPlay.disabled) {
        nussPlay.click();
        return;
      }
      const fab = document.getElementById('nuss-fab');
      if (fab) { fab.click(); return; }
      const items = getSelectedItems();
      if (items.length && items[0].url) window.open(items[0].url, '_blank');
    });
    document.getElementById('nvs-btn-import-8000').addEventListener('click', () => doImport('8000'));
    document.getElementById('nvs-btn-import-8001').addEventListener('click', () => doImport('8001'));
    document.getElementById('nvs-btn-import-8002').addEventListener('click', () => doImport('8002'));
    document.getElementById('nvs-btn-import-batch').addEventListener('click', () => doImport(getFirstLivePort()));
    document.getElementById('nvs-btn-copy-urls').addEventListener('click', doCopyUrls);
    document.getElementById('nvs-btn-export-json').addEventListener('click', doExportJson);
    document.getElementById('nvs-btn-deselect-all').addEventListener('click', doDeselectAll);

    // Aplikuj port health stav (môže byť už známy z checkPortHealth pri init)
    applyPortButtonState(document.getElementById('nvs-btn-import-8000'), '8000');
    applyPortButtonState(document.getElementById('nvs-btn-import-8001'), '8001');
    applyPortButtonState(document.getElementById('nvs-btn-import-8002'), '8002');
  }

  function updateImportBar() {
    importWorkbench?.schedule();
    document.dispatchEvent(new Event('nexus-video-selection'));
    turboOverview?.syncSelection();
    const count = new Set([...state.selected].map(card =>
      window.NVSTurboModel?.keyOf?.(card.dataset.nvsUrl) || window.NVSTurboModel?.idOf(card.dataset.nvsUrl) || card)).size;
    const bar = document.getElementById('nvs-import-bar');
    if (!bar) return;

    const counter = document.getElementById('nvs-bar-count');
    if (counter) counter.textContent = count;

    if (count > 0) {
      bar.classList.add('nvs-bar-visible');
      const batchInput = document.getElementById('nvs-batch-name');
      if (batchInput && !batchInput.value && isGofilePage()) {
        batchInput.value = getGofileFolderName();
      }
    } else {
      bar.classList.remove('nvs-bar-visible');
    }
  }

  // ── Import Actions ────────────────────────────────────────

  let importInProgress = false;

  function summarizeImport(items, data) {
    const completedIndexes = [];
    const counts = { imported: 0, duplicate: 0, mirror_attached: 0, skipped: 0 };
    const seen = new Set();
    for (const result of Array.isArray(data?.results) ? data.results : []) {
      const index = result.index;
      if (!Number.isInteger(index) || !items[index] || seen.has(index)) continue;
      if (result.url !== (items[index].streamUrl || items[index].url)) continue;
      seen.add(index);
      if (Object.hasOwn(counts, result.status)) counts[result.status]++;
      if (['imported', 'duplicate', 'mirror_attached'].includes(result.status)) completedIndexes.push(index);
    }
    const remaining = items.length - completedIndexes.length;
    let message;
    if (!Array.isArray(data?.results)) {
      const imported = Number.isInteger(data?.imported) ? data.imported : null;
      message = `${imported === null ? 'Server nepotvrdil jednotlivé položky.' : `Server hlási ${imported} nových položiek.`} Výber zostal zachovaný; skontroluj výsledok v Nexuse.`;
    } else {
      message = `Uložené: ${counts.imported} · Už v knižnici: ${counts.duplicate} · Alternatívny zdroj: ${counts.mirror_attached} · Preskočené: ${counts.skipped}.`;
      if (remaining) message += ` Na kontrolu zostáva ${remaining}; nevybavené položky zostali vybrané.`;
      else message += ' Všetky odoslané položky sú vybavené.';
      const reasons = new Set(data.results.filter(r => r.status === 'skipped').map(r => r.reason));
      if (reasons.has('too_short')) message += ' Krátke klipy backend neukladá.';
      if (reasons.has('xhamster_cdn_without_watch_page')) message += ' Pre xHamster je potrebný odkaz na stránku videa.';
    }
    return { completedIndexes, remaining, message };
  }

  function showImportResult(message, tone = '') {
    if (importWorkbench) { importWorkbench.message(message, tone); return; }
    let panel = document.getElementById('nvs-import-result');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'nvs-import-result';
      panel.setAttribute('role', 'status');
      const text = document.createElement('span');
      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = '×';
      close.setAttribute('aria-label', 'Zavrieť výsledok importu');
      close.addEventListener('click', () => panel.remove());
      panel.append(text, close);
      document.body.appendChild(panel);
    }
    panel.dataset.tone = tone;
    panel.querySelector('span').textContent = message;
  }

  function getSelectedItems(cards = state.selected) {
    const items = [];
    const turboIds = new Set();
    const seenUrls = new Set();
    const stale = [];
    for (const card of cards) {
      // Detect stale DOM references (SPA replaced the element)
      if (!document.contains(card)) {
        stale.push(card);
        continue;
      }
      const url = getVideoUrlFromCard(card);
      if (!url) continue;
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      const turboId = window.NVSTurboModel?.idOf(url);
      if (turboId && turboIds.has(turboId)) continue;
      if (turboId) turboIds.add(turboId);
      const meta = isXHamsterPage() || isXVideosPage() || isSpankBangPage() || /(?:pimpbunny|fnxtube)\.com\/videos\//i.test(String(url || ''))
        ? { ...extractCardMeta(card), ...(state.cardMeta.get(card) || {}), ...(state.fetchCache.get(url) || {}) }
        : state.fetchCache.get(url) || {};
      const isPimpBunny = /(?:pimpbunny|fnxtube)\.com\/videos\//i.test(String(url || ''));
      const title = (turboId ? meta.title : '') || getCardTitle(card, url) || meta.title || '';
      // Prefer API-provided thumbnail (redgifs, etc.) over a lazy DOM placeholder
      const thumbnail = meta.thumbnail || getCardThumbnail(card);
      let duration = card.querySelector(CFG.durationSelectors.join(','))?.textContent?.trim()
        || meta.duration || '';
      if (isSpankBangPage()) duration = meta.duration || window.NVSSpankBangListing?.fieldsFromCard(card, location.href)?.duration || '';
      if (isPimpBunny) duration = String(duration).match(/\d{1,3}:\d{2}(?::\d{2})?/)?.[0] || meta.duration || '';

      let exportUrl = url;
      if (isSpankBangPage() && meta.canonical) {
        exportUrl = meta.canonical;
      } else if (isPimpBunny || turboId || isXHamsterPage() || isXVideosPage() || isSpankBangPage()) {
        exportUrl = url;
      } else if (meta.streamUrl && !meta.streamUrl.includes('trafficdeposit.com') && !meta.streamUrl.endsWith('.vid')) {
        exportUrl = meta.streamUrl;
      } else if (meta.sourceUrls?.length) {
        const ext = meta.sourceUrls.find(u => !u.includes('sxyprn.') && !u.includes('trafficdeposit.com'));
        exportUrl = ext || url;
      } else {
        exportUrl = url;
      }

      items.push({
        url: exportUrl,
        title: String(title || '').substring(0, 200),
        thumbnail,
        duration,
        date: meta.dateEstimated ? null : (meta.date || null),
        quality: meta.quality || null,
        sizeText: meta.sizeText || null,
        sizeMb: meta.sizeMb || parseSizeMb(meta.sizeText || '') || null,
        file_size_mb: meta.sizeMb || parseSizeMb(meta.sizeText || '') || null,
        width: meta.width || 0,
        height: meta.height || 0,
        mirrorUrls: isSxyprnPage() ? [...new Set((meta.sourceUrls || []).filter(u => /^https?:\/\//i.test(u || '') && !/sxyprn\.|trafficdeposit\.com/i.test(u)))].slice(0, 6) : [],
        sourceUrl: url,
        streamUrl: isPimpBunny || turboId || isXHamsterPage() || isXVideosPage() || isSpankBangPage() ? null : (meta.streamUrl || null),
        tags: isSxyprnPage() ? (window.__nvsCardTags?.(card) || []) : (((state.pimpbunnyTagLoader || state.xhamsterTagLoader || state.xvideosTagLoader || state.spankbangTagLoader)?.get(url).tags || []).length ? (state.pimpbunnyTagLoader || state.xhamsterTagLoader || state.xvideosTagLoader || state.spankbangTagLoader).get(url).tags : (meta.tags || [])),
        addedAt: new Date().toISOString()
      });
    }
    // Clean up stale references (SPA replaced DOM nodes)
    for (const card of stale) {
      state.selected.delete(card);
    }
    if (stale.length > 0) updateImportBar();
    return items;
  }

  async function doImport(port, customBatchName = null, cards = state.selected) {
    if (importInProgress) return;
    importInProgress = true;
    const freshLiveSources = new Map();
    if (isInternetChicksPage() || isSxyprnPage()) {
      const urls = [...new Set([...cards].map(getVideoUrlFromCard).filter(Boolean))];
      showImportResult(`Overujem najlepší stream pre ${urls.length} videí…`);
      for (let offset = 0; offset < urls.length; offset += 3) {
        await Promise.all(urls.slice(offset, offset + 3).map(async url => {
          const existingMeta = state.fetchCache.get(url);
          state.fetchCache.delete(url);
          try {
            const cardObj = findCardsByUrl(url)[0];
            const cardExtUrls = isSxyprnPage() ? getCardExtUrls(cardObj) : [];
            const response = await chrome.runtime.sendMessage({ type: 'FETCH_META', url, force: true, cardExtUrls });
            if (response?.meta?.streamUrl) {
              freshLiveSources.set(url, response.meta);
              state.fetchCache.set(url, response.meta);
            } else if (existingMeta?.streamUrl) {
              freshLiveSources.set(url, existingMeta);
              state.fetchCache.set(url, existingMeta);
            } else {
              freshLiveSources.set(url, { streamUrl: url, quality: '720P' });
            }
          } catch {
            if (existingMeta?.streamUrl) freshLiveSources.set(url, existingMeta);
            else freshLiveSources.set(url, { streamUrl: url, quality: '720P' });
          }
        }));
      }
    }
    let items = getSelectedItems(cards);
    if (isArchvePage()) {
      const expanded = [];
      try {
        for (const item of items) {
          if (!/\/albums\//i.test(new URL(item.sourceUrl).pathname)) { expanded.push(item); continue; }
          showImportResult('Načítavam videá z vybraných albumov…');
          const album = state.fetchCache.get(item.sourceUrl) || (await chrome.runtime.sendMessage({type:'FETCH_META', url:item.sourceUrl}))?.meta;
          if (!album?.complete || !Array.isArray(album.videoUrls)) throw new Error('Album sa nepodarilo načítať celý. Skús sken zopakovať.');
          for (const url of album.videoUrls) {
            const meta = (await chrome.runtime.sendMessage({type:'FETCH_META', url}))?.meta || {};
            expanded.push({url, sourceUrl:url, albumUrl:item.sourceUrl, title:meta.title || 'Archve video', thumbnail:`https://hls.archve.xyz/${new URL(url).pathname.split('/')[2]}/thumbnail.jpg`, duration:meta.duration, quality:meta.quality, width:meta.width, height:meta.height, sizeMb:meta.sizeMb, file_size_mb:meta.sizeMb, date:meta.dateEstimated ? null : meta.date});
          }
        }
        items = [...new Map(expanded.map(item => [item.sourceUrl, item])).values()];
      } catch (error) { importInProgress = false; showImportResult(error.message || 'Album sa nepodarilo načítať.', 'error'); return; }
    }
    for (const item of items) {
      const fresh = freshLiveSources.get(item.sourceUrl);
      if (!fresh) continue;
      item.url = fresh.streamUrl;
      item.streamUrl = fresh.streamUrl;
      item.quality = fresh.quality;
      item.sizeText = fresh.sizeText;
      item.sizeMb = fresh.sizeMb;
      item.file_size_mb = fresh.sizeMb;
      item.width = fresh.width || 0;
      item.height = fresh.height || 0;
    }
    if (!items.length) {
      importInProgress = false;
      // Could be stale references (SPA replaced DOM) or unrecognized URL pattern
      const cardCount = state.selected.size;
      if (cardCount > 0) {
        showToast(`Chyba: URL nebolo možné extrahovať z ${cardCount} kariet. Skúste Rescan.`, 'error');
      }
      return;
    }

    const input = document.getElementById('nvs-batch-name');
    const entered = input ? input.value.trim() : '';
    const batchName = (customBatchName && String(customBatchName).trim())
      || (entered || null)
      || (isGofilePage() ? getGofileFolderName() : null);

    const submittedCards = [...cards].map(card => ({ card, url: getVideoUrlFromCard(card) }));
    showImportResult(`Posielam ${items.length} položiek do Nexusu :${port}…`);
    const finish = (res) => {
      importInProgress = false;
      importWorkbench?.schedule();
      turboOverview?.applyImportResults(items, chrome.runtime.lastError || !res
        ? { success: false, uncertain: true, error: 'Výsledok nebol potvrdený. Skontroluj Nexus.' } : res, port);
      if (chrome.runtime.lastError || !res) {
        showImportResult('Výsledok nebol potvrdený. Výber zostal zachovaný; pred opakovaním skontroluj Nexus.', 'error');
        return;
      }
      if (res.success) {
        const outcome = summarizeImport(items, res.data);
        const completedUrls = new Set(outcome.completedIndexes.map(index => items[index].sourceUrl || items[index].url));
        try { window.__nvsMarkImported?.([...completedUrls]); } catch { }
        for (const { card, url } of submittedCards) {
          const albumItems = items.filter(item => item.albumUrl === url);
          if (albumItems.length && albumItems.every(item => completedUrls.has(item.sourceUrl))) completedUrls.add(url);
          if (!completedUrls.has(url) || getVideoUrlFromCard(card) !== url) continue;
          state.selected.delete(card);
          card.classList.remove('nvs-card-selected');
          card.querySelector('.nvs-checkbox')?.setAttribute('aria-checked', 'false');
          removeFromSessionSelection(url);
        }
        updateImportBar();
        showImportResult(outcome.message, outcome.remaining ? 'warning' : 'success');
      } else {
        const detail = res.error || res.data?.detail || res.data?.error || res.data?.message || 'Nexus nie je spustený?';
        showImportResult(`Import nepotvrdený: ${detail}. Výber zostal zachovaný.`, 'error');
      }
    };
    try {
      chrome.runtime.sendMessage({ type: 'IMPORT_TO_NEXUS', port, items, batchName, ...(importWorkbench || isXHamsterPage() ? { strictPort: true } : {}) }, finish);
    } catch (_) {
      importInProgress = false;
      showImportResult('Rozšírenie nie je dostupné. Výber zostal zachovaný.', 'error');
    }
  }

  function doCopyUrls() {
    const items = getSelectedItems();
    if (!items.length) return;
    const text = items.map(i => i.url).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      showToast(`✓ Skopírované ${items.length} URL adries`, 'success');
    }).catch(() => {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      showToast(`✓ Skopírované ${items.length} URL adries`, 'success');
    });
  }

  function doExportJson(customCards) {
    let cardsToExport = customCards;
    if (!cardsToExport) {
      cardsToExport = state.selected.size > 0 ? state.selected : [...document.querySelectorAll('[data-nvs-processed], .post_el_small, article, .post')].filter(c => !c.classList.contains('nvs-tag-hidden'));
    }
    const items = getSelectedItems(cardsToExport);
    if (!items.length) {
      showToast('Nenašli sa žiadne videá na export', 'warning');
      return;
    }
    const host = location.hostname.replace(/^www\./, '');
    const json = JSON.stringify({ exportedAt: new Date().toISOString(), host, count: items.length, items }, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nexus-export-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`✓ Exportovaných ${items.length} videí ako JSON`, 'success');
  }

  function doDeselectAll() {
    for (const card of state.selected) {
      card.classList.remove('nvs-card-selected');
      const cb = card.querySelector('.nvs-checkbox');
      if (cb) cb.setAttribute('aria-checked', 'false');
    }
    state.selected.clear();
    clearSessionSelection();
    updateImportBar();
  }

  if (window.__NVS_ENABLE_TEST_HOOKS__) {
    window.__nvsTestHooks = {
      summarizeImport,
      isCamwhoresPage,
      isXxbritsPage,
      isVideoUrl,
      getCurrentPageNumber,
      buildPageUrl,
      parseKvsParameters,
      isXxbritsFromParam,
      xxbritsFromKey,
      getXxbritsCurrentPageFromUrl,
      buildXxbritsPathUrl,
      buildXxbritsAjaxUrl,
      buildXxbritsPageUrl,
      getCamwhoresVideoUrlFromNode,
    };
  }

  // ── Select All (klávesová skratka) ────────────────────────

  document.addEventListener('keydown', (e) => {
    // Ctrl+A — vybrať všetky viditeľné karty
    if (e.ctrlKey && e.key === 'a' && document.activeElement === document.body) {
      const cards = document.querySelectorAll(`[${CFG.processedAttr}="1"]:not(.nvs-hidden)`);
      let changed = false;
      for (const card of cards) {
        if (!state.selected.has(card)) {
          state.selected.add(card);
          card.classList.add('nvs-card-selected');
          const cb = card.querySelector('.nvs-checkbox');
          if (cb) cb.setAttribute('aria-checked', 'true');
          const url = getVideoUrlFromCard(card);
          if (url) addToSessionSelection(url);
          changed = true;
        }
      }
      if (changed) {
        e.preventDefault();
        updateImportBar();
      }
    }
    // Escape — zrušiť výber
    if (e.key === 'Escape' && !document.activeElement?.matches('input, textarea, select, [contenteditable="true"]')) {
      doDeselectAll();
    }
  });

  // ── Toast notifications ───────────────────────────────────

  function showToast(message, type = '') {
    const toast = document.createElement('div');
    toast.className = `nvs-toast${type ? ' nvs-toast-' + type : ''}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  // ── SPA Observer ──────────────────────────────────────────

  function installSpaObserver() {
    if (state.spaObserverInstalled) return;
    state.spaObserverInstalled = true;
    // MutationObserver pre dynamicky načítaný obsah
    const mo = new MutationObserver((mutations) => {
      if (mutations.every(m => m.target.closest?.('#nvs-overview, [id^="nvs-"], .nvs-badge, .nvs-selector-wrap, .nvs-wh-play') ||
          (m.addedNodes.length && [...m.addedNodes].every(n => n.nodeType === 1 && n.matches?.('[id^="nvs-"], .nvs-selector-wrap'))))) return;
      clearTimeout(state.spaTimer);
      state.spaTimer = setTimeout(() => {
        scan();
        window.NVSXhamsterLayout?.clean();
        turboOverview?.discover();
        // Xhamster/SPA stránky doplnia texty do existujúcich kariet neskôr
        setTimeout(reinspectLoadingBadges, 1000);
      }, CFG.debounceMs);
    });

    mo.observe(document.body, {
      childList: true,
      subtree: true,
      // Profile tabs can reveal existing cards or fill links without adding nodes.
      ...(window.NVSMultiSitePlayer?.site(location.href) === 'xvideos'
        ? { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'href', 'data-id'] } : {})
    });

    // SPA navigation events
    window.addEventListener('popstate', () => setTimeout(scan, 500));
    window.addEventListener('hashchange', () => setTimeout(scan, 500));

    // YouTube / React / Angular style navigation
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(scan, 800);
      }
    }, 1000);
  }

  function getCardCoverage(card, explicitMeta = null) {
    const url = card?.dataset?.nvsUrl || getVideoUrlFromCard(card);
    const meta = explicitMeta || state.cardMeta.get(card) || (url ? state.fetchCache.get(url) : null) || null;
    let cardDomMeta = null;
    try { cardDomMeta = extractCardMeta(card); } catch { }

    const fetched = Boolean(meta && !meta.failureReason && (
      meta.sizeMb || meta.sizeText || meta.duration || meta.quality || meta.date || meta.relDate || meta.streamUrl || meta._embedChecked
    ));
    const hasSize = Number(meta?.sizeMb || parseSizeMb(meta?.sizeText || '') || 0) > 0;
    const hasDuration = Boolean(meta?.duration || cardDomMeta?.duration);
    const hasQuality = Boolean(meta?.quality || cardDomMeta?.quality);
    const hasDate = Boolean(meta?.date || meta?.relDate || cardDomMeta?.date || cardDomMeta?.relDate);
    const complete = hasSize && hasDuration && hasQuality && hasDate;
    return {
      fetched,
      hasSize,
      hasDuration,
      hasQuality,
      hasDate,
      complete,
      fromCache: Boolean(meta?._cacheHit),
    };
  }
  window.__nvsGetCardCoverage = getCardCoverage;

  // ── Doplnenie chýbajúcich serverov / kariet ────────────────────────
  async function retryMissingCards(btn) {
    const hudBtn = document.getElementById('nvs-hud-btn-retry');
    const barBtn = document.getElementById('nvs-retry-missing');
    const targetBtns = [btn, hudBtn, barBtn].filter((b, idx, arr) => b && arr.indexOf(b) === idx);

    const updateBtns = (disabled, text) => {
      for (const b of targetBtns) {
        b.disabled = disabled;
        if (text) b.textContent = text;
      }
    };

    updateBtns(true, '⚡ Hľadám...');

    const cards = [...document.querySelectorAll(`[${CFG.processedAttr}="1"]`)];

    // Pre sxyprn: vyčisti nesprávne nacacheované externé URL z predchádzajúceho skenu
    if (isSxyprnPage()) {
      for (const card of cards) {
        if (card.dataset.nvsUrl && !card.dataset.nvsUrl.includes('/post/')) {
          delete card.dataset.nvsUrl;
        }
      }
    }

    const missingCards = cards.filter(card => {
      const url = getVideoUrlFromCard(card);
      if (!url) return false;
      const meta = state.cardMeta.get(card) || state.fetchCache.get(url);
      if (!meta) return true;
      const cov = getCardCoverage(card, meta);
      if (!cov.complete) return true;
      if (isSxyprnPage() || isInternetChicksPage()) {
        const minVerified = isSxyprnPage() ? 1 : 2;
        return !meta.bestOfAllVerified || Number(meta.verifiedSourceCount || 0) < minVerified;
      }
      return false;
    });

    if (!missingCards.length) {
      showToast('Všetky zobrazené karty majú kompletné metadáta ✓', 'success');
      updateBtns(false, '✓ Všetko kompletné');
      window.__nvsUpdateHud?.();
      return;
    }

    const total = missingCards.length;
    let done = 0;
    updateBtns(true, `⚡ Dopĺňam (0/${total})...`);
    showToast(`Dopĺňam servery pre ${total} neúplných kariet...`, 'info');
    if (typeof pushScanLog === 'function') {
      pushScanLog('info', `Dopĺňam ${total} neúplných kariet...`);
    }

    const BATCH_SIZE = 3;
    for (let i = 0; i < missingCards.length; i += BATCH_SIZE) {
      const slice = missingCards.slice(i, i + BATCH_SIZE);
      await Promise.all(slice.map(async card => {
        const url = getVideoUrlFromCard(card);
        if (!url) return;
        state.fetchCache.delete(url);
        state.queuedUrls.delete(url);
        const sourceBadge = card.querySelector('.nvs-source-badge');
        if (sourceBadge) {
          sourceBadge.textContent = '⚡ Overujem...';
          sourceBadge.style.opacity = '0.7';
        }
        const badge = card.querySelector('.nvs-badge');
        if (badge && badge.classList.contains('nvs-badge-error')) {
          badge.classList.remove('nvs-badge-error');
          badge.classList.add('nvs-badge-loading');
          const textEl = badge.querySelector('.nvs-badge-text');
          if (textEl) textEl.textContent = '⚡ načítavam...';
          badge.style.display = '';
        }
        try {
          const res = await chrome.runtime.sendMessage({ type: 'FETCH_META', url, force: true });
          const freshMeta = res?.meta;
          if (freshMeta) {
            state.fetchCache.set(url, freshMeta);
            state.cardMeta.set(card, freshMeta);
            updateBadge(card.querySelector('.nvs-badge'), card, freshMeta);
            if (typeof recordScanOutcome === 'function') {
              recordScanOutcome(url, freshMeta, false);
            }
          } else {
            if (typeof markScanError === 'function') markScanError(card);
          }
        } catch {
          if (typeof markScanError === 'function') markScanError(card);
        }
        finally {
          if (sourceBadge) sourceBadge.style.opacity = '';
          done++;
          updateBtns(true, `⚡ Dopĺňam (${done}/${total})...`);
        }
      }));
    }

    updateBtns(false, '⚡ Doplniť chýbajúce');
    showToast(`Doplnenie dokončené! Aktualizovaných ${done} kariet.`, 'success');
    if (typeof pushScanLog === 'function') {
      pushScanLog('done', `Doplnenie dokončené (${done}/${total}).`);
    }
    updateFetchCounter();
    window.__nvsUpdateHud?.();
  }

    window.__nvsImportSelected = (port = '8000') => {
    if (!state.selected.size) {
      showToast('Najprv označte aspoň jednu kartu pre import.', 'warning');
      return;
    }
    doImport(port);
  };

  window.__nvsImportAll = (port = '8000') => {
    const cards = document.querySelectorAll(`[${CFG.processedAttr}="1"]:not(.nvs-hidden):not(.nvs-tag-hidden)`);
    if (!cards.length) {
      showToast('Nenašli sa žiadne spracované karty videí.', 'warning');
      return;
    }
    for (const card of cards) {
      if (!state.selected.has(card)) {
        state.selected.add(card);
        card.classList.add('nvs-card-selected');
        const cb = card.querySelector('.nvs-checkbox');
        if (cb) cb.setAttribute('aria-checked', 'true');
        const url = getVideoUrlFromCard(card);
        if (url) addToSessionSelection(url);
      }
    }
    updateImportBar();
    doImport(port);
  };

  // Import presne zadanej sady kariet (napr. zhody tag filtra): vyberie ich a spustí import
  window.__nvsImportCards = (cards, port = '8000') => {
    const list = [...cards].filter((c) => c.getAttribute(CFG.processedAttr) === '1' || getVideoUrlFromCard(c));
    if (!list.length) {
      showToast('Nenašli sa žiadne karty na import.', 'warning');
      return;
    }
    for (const card of state.selected) {
      if (!list.includes(card)) {
        state.selected.delete(card);
        card.classList.remove('nvs-card-selected');
        card.querySelector('.nvs-checkbox')?.setAttribute('aria-checked', 'false');
      }
    }
    for (const card of list) {
      if (!state.selected.has(card)) {
        state.selected.add(card);
        card.classList.add('nvs-card-selected');
        card.querySelector('.nvs-checkbox')?.setAttribute('aria-checked', 'true');
        const url = getVideoUrlFromCard(card);
        if (url) addToSessionSelection(url);
      }
    }
    updateImportBar();
    doImport(port);
  };

  // Označí (bez importu) presne zadanú sadu kariet; ostatné z výberu odoberie ak replace=true
  window.__nvsSelectCards = (cards, replace = true) => {
    const list = [...cards].filter((c) => getVideoUrlFromCard(c));
    if (replace) {
      for (const card of [...state.selected]) {
        if (list.includes(card)) continue;
        state.selected.delete(card);
        card.classList.remove('nvs-card-selected');
        card.querySelector('.nvs-checkbox')?.setAttribute('aria-checked', 'false');
        const u = getVideoUrlFromCard(card);
        if (u) removeFromSessionSelection(u);
      }
    }
    for (const card of list) {
      if (state.selected.has(card)) continue;
      state.selected.add(card);
      card.classList.add('nvs-card-selected');
      card.querySelector('.nvs-checkbox')?.setAttribute('aria-checked', 'true');
      const u = getVideoUrlFromCard(card);
      if (u) addToSessionSelection(u);
    }
    updateImportBar();
    return list.length;
  };

  // sxyprn: stránkový JS nepozná dynamicky pripojené karty, preto hover náhľad (vidthumb.mp4) riešime sami
  let sxHoverBound = false;
  function ensureSxyprnHoverPreview() {
    if (sxHoverBound) return;
    sxHoverBound = true;
    const stop = (vc) => {
      const v = vc?.querySelector('video.hvp_player');
      if (!v) return;
      try { v.pause(); v.currentTime = 0; } catch { }
      v.style.display = 'none';
      vc.querySelector('img')?.style.removeProperty('visibility');
    };
    document.addEventListener('mouseover', (e) => {
      const vc = e.target.closest?.('.post_el_small[data-nvs-clone] .vid_container');
      if (!vc || vc.contains(e.relatedTarget)) return;
      const v = vc.querySelector('video.hvp_player');
      if (!v) return;
      v.muted = true;
      v.style.display = 'block';
      v.play().catch(() => stop(vc));
    });
    document.addEventListener('mouseout', (e) => {
      const vc = e.target.closest?.('.post_el_small[data-nvs-clone] .vid_container');
      if (!vc || vc.contains(e.relatedTarget)) return;
      stop(vc);
    });
  }

  // sxyprn: načíta ďalších `count` strán pod aktuálne (offsetová paginácia /<n>.html)
  window.__nvsLoadMoreSxyprn = async (count, onProgress) => {
    if (state.isLoadingPages) return 0;
    state.isLoadingPages = true;
    let appended = 0;
    try {
      const liveCards = [...document.querySelectorAll('.post_el_small')];
      const grid = liveCards[liveCards.length - 1]?.parentElement;
      if (!grid) { showToast('Nenašiel som grid sxyprn kariet', 'error'); return 0; }
      const keyOf = (c) => c.querySelector('a[href*="/post/"]')?.getAttribute('href')?.split('?')[0] || '';
      const seen = new Set(liveCards.map(keyOf).filter(Boolean));
      const offsetOf = (u) => { const m = new URL(u, location.href).pathname.match(/\/(\d+)\.html$/); return m ? parseInt(m[1], 10) : null; };
      let curUrl = state.sxLastUrl || location.href;
      let curDoc = state.sxLastDoc || document;
      for (let i = 1; i <= count; i++) {
        const curOff = offsetOf(curUrl) ?? 0;
        // 1) tlačidlo „Next Page" (tag stránky ?page=N) – najspoľahlivejšie
        let next = null;
        const nextA = curDoc.querySelector('.next_page')?.closest('a[href]');
        if (nextA) next = new URL(nextA.getAttribute('href'), curUrl).href;
        // 2) číslovaný pager v rovnakom priečinku (/blog/all/<offset>.html)
        if (!next) {
          const curDir = new URL(curUrl, location.href).pathname.replace(/[^/]*$/, '');
          let best = Infinity;
          for (const a of curDoc.querySelectorAll('a[href]')) {
            const h = a.getAttribute('href') || '';
            if (!/\/\d+\.html/.test(h) || /\/post\//.test(h)) continue;
            const hu = new URL(h, curUrl);
            if (hu.pathname.replace(/[^/]*$/, '') !== curDir) continue;
            const off = offsetOf(hu.href);
            if (off != null && off > curOff && off < best) { best = off; next = hu.href; }
          }
          if (next) { const nu = new URL(next); const cs = new URL(curUrl, location.href).search; if (!nu.search && cs) nu.search = cs; next = nu.href; }
        }
        if (!next) { showToast('Ďalšia strana sa nenašla (koniec zoznamu?)', 'warning'); break; }
        onProgress?.(i, count);
        let html = null;
        try { const r = await fetch(next, { credentials: 'include' }); if (r.ok) html = await r.text(); } catch { }
        if (!html) { showToast(`Strana ${i} sa nenačítala`, 'error'); break; }
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const frag = document.createDocumentFragment();
        let added = 0;
        for (const c of doc.querySelectorAll('.post_el_small')) {
          const k = keyOf(c);
          if (!k || seen.has(k)) continue;
          seen.add(k);
          const node = document.importNode(c, true);
          node.dataset.nvsClone = '1';
          hydrateLazyImages(node);
          // inline onerror z klonu: zachovaj fallback, ale bez tvrdého stlačenia šírky
          frag.appendChild(node);
          added++;
        }
        ensureSxyprnHoverPreview();
        curUrl = next; curDoc = doc;
        state.sxLastUrl = next; state.sxLastDoc = doc;
        if (!added) { showToast('Ďalšie strany už neobsahujú nové karty', 'warning'); break; }
        grid.appendChild(frag);
        appended += added;
        scan();
        await new Promise((r) => setTimeout(r, 80));
      }
      showToast(`Pripojených ${appended} kariet`, appended ? 'success' : 'warning');
    } finally {
      state.isLoadingPages = false;
    }
    return appended;
  };

  window.__nvsDoExportJson = (cards) => doExportJson(cards);
  window.__nvsGetExportItems = (cards) => getSelectedItems(cards);
  window.__nvsRetryMissing = () => retryMissingCards(document.getElementById('nvs-hud-btn-retry') || document.getElementById('nvs-retry-missing'));
  window.__nvsStopScan = () => {
    state.queue = [];
    state.activeFetches = 0;
    finishScanRunIfIdle();
    showToast('Skenovanie zastavené', 'info');
  };

  // ── Quick Server Switcher Popover ──────────────────────────────────
  let activeServerPopover = null;

  function closeServerSwitcherPopover() {
    if (activeServerPopover) {
      if (activeServerPopover.cleanup) activeServerPopover.cleanup();
      activeServerPopover.element.remove();
      activeServerPopover = null;
    }
  }

  function openServerSwitcherPopover(card, meta, badge, opts = {}) {
    if (!opts.refresh && activeServerPopover?.badge === badge) {
      closeServerSwitcherPopover();
      return;
    }
    closeServerSwitcherPopover();

    const url = getVideoUrlFromCard(card);
    const title = getCardTitle(card, url) || 'Video servery';
    const sourceResults = meta.sourceResults || [];

    const popover = document.createElement('div');
    popover.className = 'nvs-server-popover';

    // Header
    const header = document.createElement('div');
    header.className = 'nvs-pop-header';

    const titleEl = document.createElement('span');
    titleEl.className = 'nvs-pop-title';
    titleEl.textContent = title;
    titleEl.title = title;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'nvs-pop-close';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Zavrieť';
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeServerSwitcherPopover();
    });

    header.appendChild(titleEl);
    header.appendChild(closeBtn);
    popover.appendChild(header);

    // Stavový riadok (potvrdenie re-testu / aktuálny stav)
    const statusLine = document.createElement('div');
    statusLine.className = 'nvs-pop-statusline';
    statusLine.textContent = opts.statusText || '';
    statusLine.style.display = opts.statusText ? '' : 'none';
    popover.appendChild(statusLine);

    // Body
    const body = document.createElement('div');
    body.className = 'nvs-pop-body';

    if (!sourceResults.length) {
      const emptyRow = document.createElement('div');
      emptyRow.className = 'nvs-pop-row';
      emptyRow.textContent = 'Žiadne zistené servery.';
      body.appendChild(emptyRow);
    } else {
      sourceResults.forEach((source) => {
        const row = document.createElement('div');
        row.className = 'nvs-pop-row';
        const isCurrentActive = Number(meta.selectedPlayer) === Number(source.player);
        if (isCurrentActive) row.classList.add('nvs-pop-row-active');

        const hostName = (source.host || '').replace(/^www\./, '');
        const playerLabel = `P${String(source.player).padStart(2, '0')}`;

        const infoDiv = document.createElement('div');
        infoDiv.className = 'nvs-pop-server-info';

        const pNum = document.createElement('span');
        pNum.className = 'nvs-pop-player-num';
        pNum.textContent = playerLabel;

        const pHost = document.createElement('span');
        pHost.className = 'nvs-pop-host';
        pHost.textContent = hostName;

        infoDiv.appendChild(pNum);
        infoDiv.appendChild(pHost);

        const actionsDiv = document.createElement('div');
        actionsDiv.style.cssText = 'display:flex;align-items:center;gap:6px;';

        if (source.status === 'verified') {
          const qualText = source.quality ? ` · ${source.quality}` : '';
          const sizeInfo = source.sizeText ? ` · ${source.sizeText}` : '';
          if (isCurrentActive) {
            const badgeSpan = document.createElement('span');
            badgeSpan.className = 'nvs-pop-status nvs-pop-active';
            badgeSpan.textContent = `Aktívny ✓${qualText}${sizeInfo}`;
            actionsDiv.appendChild(badgeSpan);
          } else {
            const badgeSpan = document.createElement('span');
            badgeSpan.className = 'nvs-pop-status nvs-pop-active';
            badgeSpan.style.opacity = '0.85';
            badgeSpan.textContent = `Overený${qualText}${sizeInfo}`;
            actionsDiv.appendChild(badgeSpan);

            const selectBtn = document.createElement('button');
            selectBtn.type = 'button';
            selectBtn.className = 'nvs-pop-btn-select';
            selectBtn.textContent = 'Zvoliť';
            selectBtn.title = 'Prepnúť prehrávanie/import na tento server';
            selectBtn.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              meta.selectedPlayer = source.player;
              meta.selectedSourceHost = hostName;
              if (source.streamUrl) meta.streamUrl = source.streamUrl;
              if (source.quality) meta.quality = source.quality;
              if (source.sizeMb) {
                meta.sizeMb = source.sizeMb;
                meta.sizeText = source.sizeText;
                meta.sizeExact = Boolean(source.sizeExact);
              }
              state.cardMeta.set(card, meta);
              if (url) state.fetchCache.set(url, meta);
              updateBadge(card.querySelector('.nvs-badge'), card, meta);
              showToast(`Aktívny server zmenený na ${playerLabel} (${hostName})`, 'success');
              openServerSwitcherPopover(card, meta, badge, { refresh: true, statusText: 'Aktívny server: ' + playerLabel + ' (' + hostName + ') ✓' });
            });
            actionsDiv.appendChild(selectBtn);
          }
        } else if (source.status === 'mirror') {
          const mirrorSpan = document.createElement('span');
          mirrorSpan.className = 'nvs-pop-status nvs-pop-mirror';
          mirrorSpan.textContent = 'Mirror VOE';
          mirrorSpan.title = 'Zrkadlový server pre VOE';
          actionsDiv.appendChild(mirrorSpan);
        } else {
          const reasonText = source.status === 'unavailable' ? 'Nedostupný'
            : source.status === 'unsupported' ? 'Nepodporovaný hoster'
            : 'Neoverený ⚠';
          const unverifiedSpan = document.createElement('span');
          unverifiedSpan.className = 'nvs-pop-status nvs-pop-unverified';
          unverifiedSpan.textContent = reasonText;
          unverifiedSpan.title = String(source.status || 'Neoverený');
          actionsDiv.appendChild(unverifiedSpan);
        }

        row.appendChild(infoDiv);
        row.appendChild(actionsDiv);
        body.appendChild(row);
      });
    }
    popover.appendChild(body);

    // Footer
    const footer = document.createElement('div');
    footer.className = 'nvs-pop-footer';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'nvs-pop-btn';
    copyBtn.textContent = '📋 Kopírovať stream';
    copyBtn.title = 'Skopírovať priamy stream URL vybraného servera do schránky';
    if (!meta.streamUrl) copyBtn.disabled = true;
    copyBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!meta.streamUrl) return;
      try {
        await navigator.clipboard.writeText(meta.streamUrl);
        showToast('Stream link skopírovaný do schránky! 📋', 'success');
      } catch {
        prompt('Skopírujte stream link:', meta.streamUrl);
      }
    });

    const retestBtn = document.createElement('button');
    retestBtn.type = 'button';
    retestBtn.className = 'nvs-pop-btn';
    retestBtn.textContent = '🔄 Re-testovať';
    retestBtn.title = 'Znovu overiť všetky servery pre túto kartu';
    retestBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      retestBtn.disabled = true;
      retestBtn.textContent = '⏳ Testujem...';
      statusLine.style.display = '';
      statusLine.className = 'nvs-pop-statusline nvs-pop-statusline-busy';
      statusLine.textContent = '⏳ Testujem všetky servery… (môže trvať do 30 s)';
      pushScanLog('info', 'Re-test: ' + title, url);
      state.currentScan = { title, url, phase: 'retest', at: Date.now() };
      try {
        if (url) state.fetchCache.delete(url);
        const res = await chrome.runtime.sendMessage({ type: 'FETCH_META', url, force: true });
        const freshMeta = res?.meta;
        if (state.currentScan?.url === url) state.currentScan = null;
        if (freshMeta) {
          state.fetchCache.set(url, freshMeta);
          state.cardMeta.set(card, freshMeta);
          updateBadge(card.querySelector('.nvs-badge'), card, freshMeta);
          const okCount = Number(freshMeta.verifiedSourceCount || 0);
          const allCount = Number(freshMeta.totalSourceCount || 0);
          const stamp = new Date().toLocaleTimeString('sk-SK');
          pushScanLog('done', 'Re-test hotový: ' + okCount + '/' + allCount + ' serverov overených (' + title + ')', url);
          showToast('Re-test hotový: ' + okCount + '/' + allCount + ' serverov overených ✓', 'success');
          openServerSwitcherPopover(card, freshMeta, badge, { refresh: true, statusText: '✓ Re-test hotový ' + stamp + ' — ' + okCount + '/' + allCount + ' overených' });
        } else {
          pushScanLog('error', 'Re-test zlyhal: ' + title, url);
          showToast('Re-test zlyhal alebo server neodpovedal', 'error');
          statusLine.className = 'nvs-pop-statusline nvs-pop-statusline-error';
          statusLine.textContent = '⚠ Re-test zlyhal — stránka alebo servery neodpovedali';
          retestBtn.disabled = false;
          retestBtn.textContent = '🔄 Re-testovať';
        }
      } catch {
        if (state.currentScan?.url === url) state.currentScan = null;
        pushScanLog('error', 'Chyba re-testu: ' + title, url);
        showToast('Chyba pri re-teste', 'error');
        statusLine.className = 'nvs-pop-statusline nvs-pop-statusline-error';
        statusLine.textContent = '⚠ Chyba pri komunikácii s rozšírením';
        retestBtn.disabled = false;
        retestBtn.textContent = '🔄 Re-testovať';
      }
    });

    footer.appendChild(copyBtn);
    footer.appendChild(retestBtn);
    popover.appendChild(footer);

    document.body.appendChild(popover);

    // Pozícia popoveru
    const rect = badge.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const placeAbove = spaceBelow < 260 && rect.top > 260;
    const top = placeAbove
      ? (window.scrollY + rect.top - popRect.height - 6)
      : (window.scrollY + rect.bottom + 6);
    const left = Math.max(10, Math.min(window.scrollX + rect.left, window.innerWidth - popRect.width - 20));

    popover.style.position = 'absolute';
    popover.style.top = `${Math.round(top)}px`;
    popover.style.left = `${Math.round(left)}px`;

    popover.addEventListener('click', (e) => e.stopPropagation());
    popover.addEventListener('mousedown', (e) => e.stopPropagation());

    const onDocClick = (e) => {
      if (!popover.contains(e.target) && e.target !== badge && !badge.contains(e.target)) {
        closeServerSwitcherPopover();
      }
    };
    const onDocKey = (e) => {
      if (e.key === 'Escape') closeServerSwitcherPopover();
    };

    setTimeout(() => {
      document.addEventListener('click', onDocClick, { capture: true });
      document.addEventListener('keydown', onDocKey);
    }, 10);

    activeServerPopover = {
      badge,
      element: popover,
      cleanup: () => {
        document.removeEventListener('click', onDocClick, { capture: true });
        document.removeEventListener('keydown', onDocKey);
      }
    };
  }

  // ── Proxy Fetcher pre Background (obídenie 403 CDN ochrany) ──────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'CAMWHORES_META_PROGRESS' && isCamwhoresPage()) {
      const url = String(msg.url || '');
      const meta = msg.meta;
      if (url && meta) {
        state.fetchCache.set(url, meta);
        for (const card of findCardsByUrl(url)) {
          updateBadge(card.querySelector('.nvs-badge'), card, meta);
        }
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg.action === 'getScanStatus') {
      sendResponse(publicScanStatus());
      return;
    }
    if (msg.action === 'fetchMissingSizes') {
      sendResponse(window.__nvsFetchMissing(msg.options || {}));
      return;
    }
    if (msg.action === 'disableOnPage') {
      deactivateOnPage();
      showToast(`⊘ Vypnuté na ${normalizeHost(location.hostname)}`, 'error');
      sendResponse({ ok: true });
      return;
    }
    if (msg.action === 'enableOnPage') {
      state.disabled = false;
      init();
      showToast(`✓ Aktivované na ${normalizeHost(location.hostname)}`, 'done');
      sendResponse({ ok: true });
      return;
    }
    if (msg.action === 'getHostState') {
      sendResponse({
        enabled: !state.disabled,
        panelVisible: isSortPanelVisible()
      });
      return;
    }
    if (msg.action === 'setPanelVisible') {
      setSortPanelVisible(msg.visible, true);
      sendResponse({ ok: true });
      return;
    }
    if (msg.action === 'getPanelVisible') {
      sendResponse({ visible: isSortPanelVisible() });
      return;
    }
    if (msg.action === 'nvsProbeMediaSize') {
      (async () => {
        const mediaUrl = String(msg.url || '').trim();
        if (!mediaUrl) return null;

        const bytesFromResponse = (response, allowFullLength = true) => {
          const contentType = response?.headers?.get?.('content-type') || '';
          if (/text\/html|application\/xhtml|application\/json/i.test(contentType)) return 0;
          const contentRange = response?.headers?.get?.('content-range') || '';
          const rangeMatch = contentRange.match(/\/(\d+)\s*$/);
          if (rangeMatch) return Number(rangeMatch[1]) || 0;
          if (!allowFullLength || response?.status !== 200) return 0;
          return Number(response.headers.get('content-length') || 0) || 0;
        };

        try {
          const head = await fetch(mediaUrl, {
            method: 'HEAD',
            credentials: 'include',
            cache: 'no-store',
          });
          const bytes = bytesFromResponse(head);
          if (head.ok && bytes > 0) {
            return { sizeBytes: bytes, sizeMb: Math.round(bytes / (1024 * 1024)) };
          }
        } catch { }

        const controller = new AbortController();
        try {
          const ranged = await fetch(mediaUrl, {
            method: 'GET',
            credentials: 'include',
            cache: 'no-store',
            headers: { Range: 'bytes=0-0' },
            signal: controller.signal,
          });
          const bytes = bytesFromResponse(ranged);
          controller.abort();
          if (ranged.ok && bytes > 0) {
            return { sizeBytes: bytes, sizeMb: Math.round(bytes / (1024 * 1024)) };
          }
        } catch { }
        finally { controller.abort(); }
        return null;
      })().then(sendResponse).catch(() => sendResponse(null));
      return true;
    }
    if (msg.action === 'nvsProbeVideoDimensions') {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.removeAttribute('src');
        video.load();
        sendResponse(value);
      };
      const timer = setTimeout(() => finish(null), 6000);
      video.addEventListener('loadedmetadata', () => finish({ width: video.videoWidth, height: video.videoHeight }), { once: true });
      video.addEventListener('error', () => finish(null), { once: true });
      video.src = String(msg.url || '');
      return true;
    }
    if (msg.action === 'nvsFetchText') {
      fetch(msg.url)
        .then(r => r.text())
        .then(sendResponse)
        .catch(() => sendResponse(null));
      return true; // Asynchrónna odpoveď
    }
  });

})();
