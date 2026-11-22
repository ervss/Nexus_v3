// ==UserScript==

// @name         Bunkr Suite — Album Helper + Archive Search

// @namespace    local.codex.bunkr.suite

// @version      1.8.58

// @description  Unified Bunkr album tools: wide adaptive grids, metadata HUD, Balbums search, sorting, previews and Nexus imports.

// @author       Local Bunkr Helper + WendysBro archive module

// @match        https://bunkr.cr/a/*

// @match        https://bunkr.si/a/*

// @match        https://bunkr.is/a/*

// @match        https://bunkr.la/a/*

// @match        https://bunkr.ph/a/*

// @match        https://bunkr.pk/a/*

// @match        https://bunkr.ps/a/*

// @match        https://bunkr.ac/a/*

// @match        https://bunkr.sk/a/*

// @match        https://bunkr.fi/a/*

// @match        https://bunkr.ws/a/*

// @match        https://bunkr.black/a/*

// @match        https://bunkr.media/a/*

// @match        https://bunkr.ru/a/*

// @match        https://*.bunkrr.pics/a/*

// @match        https://bunkrr.pics/a/*

// @match        https://bunkrr.pics/album*/*

// @match        https://findr.to/albums/*

// @match        https://*.findr.to/albums/*

// @match        https://balbums.st/*

// @match        https://*.balbums.st/*

// @match        https://bunkr-albums.io/*

// @match        https://*.bunkr-albums.io/*

// @connect      *

// @run-at       document-idle

// @grant        GM_xmlhttpRequest

// @grant        GM.xmlHttpRequest

// @grant        GM_getValue

// @grant        GM_setValue

// @connect      localhost

// @connect      127.0.0.1

// @connect      bunkr.la

// @connect      bunkr.si

// @connect      bunkr.is

// @connect      bunkr.cr

// @connect      bunkr.black

// @connect      bunkr.su

// @connect      bunkr.pk

// @connect      bunkrr.su

// @connect      bunkr.ws

// @connect      bunkr.vc

// @connect      bunkr.media

// @connect      bunkr.ru

// @connect      bunkr.to

// @connect      bunkr.ac

// @connect      bunkr.ph

// @connect      bunkr.sk

// @connect      bunkr.ps

// @connect      bunkr.fi

// @connect      cdn.cr

// @connect      *.cdn.cr

// @connect      glb-apisign.cdn.cr

// @connect      scdn.st

// @connect      *.scdn.st

// @connect      balbums.st

// @icon         https://www.google.com/s2/favicons?sz=64&domain=bunkr.cr

// ==/UserScript==





const BUNKR_SUITE_ALBUM_PAGE = /^\/(?:a\/|album)/i.test(location.pathname);

const BUNKR_SUITE_FINDR_ALBUM = location.hostname === 'findr.to' || location.hostname.endsWith('.findr.to');

document.documentElement.classList.add(BUNKR_SUITE_ALBUM_PAGE ? 'bks-album-page' : 'bks-archive-page');

// Which build is actually running? Tampermonkey happily keeps an old copy in

// memory after a plain page reload, so the version is stamped on the document

// where it can be read back: document.documentElement.dataset.bahVersion

document.documentElement.dataset.bahVersion = '1.8.57';



if (BUNKR_SUITE_ALBUM_PAGE) {

  /* Album Helper module */

  // Bunkr pages set a strict CSP that blocks a plain page fetch() to http://localhost.

  // We route every dashboard call through GM_xmlhttpRequest (privileged, bypasses

  // CSP + CORS). @connect whitelists the local dashboard host. The dashboard

  // endpoints used: GET /health, POST /api/tester/batch-meta (duration/quality),

  // POST /api/v1/intake/import (import). The backend resolves Bunkr streams from

  // the page URL, so we only send /f/ page links + the metadata we fetched.

  //

  // /api/v1/intake/import (not the legacy /api/v1/import/bulk) creates a real

  // ImportJob with per-item rows visible immediately in the dashboard's Import

  // Desk panel (live progress, retry, per-item event log) — the old bulk

  // endpoint wrote straight to the Video table in one big blocking request with

  // zero visibility until the entire batch finished.



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

    if (window.__bunkrAlbumHelperLoaded) return;

    window.__bunkrAlbumHelperLoaded = true;



    // NEXUS_TOKENS — mirror of app/static/tokens.css so this injected panel reads

    // as a native part of the Nexus dashboard, not a foreign widget. Values are the

    // sRGB equivalents of the dashboard's OKLCH tokens (violet accent, nexus green

    // for the primary/import action). Keep in sync with tokens.css if it changes.

    const NEXUS_TOKENS = `

    --bah-bg: rgba(19,21,28,.97);

    --bah-surface: #1a1f2b;

    --bah-surface-2: #232734;

    --bah-field: #0f1219;

    --bah-border: #2a2f3a;

    --bah-text: #e6e8ef;

    --bah-text-dim: #9aa3b2;

    --bah-accent: #a855f7;      /* electric violet — matches --nx-accent */

    --bah-accent-strong: #7c3aed;

    --bah-ok: #22c55e;          /* matches --nx-ok */

    --bah-ok-deep: #16a34a;

    --bah-radius: 12px;

    --bah-radius-sm: 8px;

    --bah-shadow: 0 10px 40px rgba(0,0,0,.5);

    --bah-font: "Manrope", system-ui, "Segoe UI", Roboto, sans-serif;

  `;



    document.documentElement.dataset.nexusBunkrHelper = '1';

    document.dispatchEvent(new Event('nexus-bunkr-helper-ready'));

    const PANEL_ID = 'bunkr-album-helper-panel';

    const HUD_LAYER_ID = 'bunkr-album-helper-hud-layer';

    const STORAGE_KEY = 'bunkr-suite:album:prefs:v1';

    const META_KEY = 'bunkr-album-helper:meta:v1';   // url -> probed meta (persists across reloads)

    const ALBUM_KEY = 'bunkr-album-helper:albums:v1'; // albumUrl -> {title,count,timed,ts}

    const MAX_CACHE = 6000;          // cap persisted video-meta entries (LRU by ts)

    const DEFAULT_PORT = 8000;

    const CANDIDATE_PORTS = [8000, 8001, 8002, 8003];

    // Submit up to 50 files in one metadata-only request. The backend checks its

    // probe cache before resolving URLs and skips HTML when /api/vs succeeds.

    // Existing Bunkr/CDN concurrency limits remain unchanged.

    const META_CHUNK = 50;



    const GM_REQ = (typeof GM_xmlhttpRequest !== 'undefined') ? GM_xmlhttpRequest

      : (typeof GM !== 'undefined' && GM.xmlHttpRequest) ? GM.xmlHttpRequest.bind(GM)

        : null;



    const state = loadPrefs();

    let connStatus = 'searching';   // 'online' | 'offline' | 'searching'

    let detecting = false;

    let items = [];                 // discovered cards: {el, url, title, thumb, sizeBytes, dateTs, isVideo, meta}

    const metaByUrl = new Map();    // url -> {duration, quality, height, width, sizeBytes, ok}

    let metaFetching = false;

    let refreshTimer = null;

    let suppressObserver = false;   // ignore our own DOM writes in the MutationObserver

    let suppressTimer = null;

    let hudPositionFrame = 0;

    let hudHealTimer = 0;



    // The badges live in a viewport-fixed layer, so their position has to be

    // re-derived as the album scrolls. Re-measuring every badge on every scroll

    // frame forced a synchronous layout plus four style writes per badge; past a

    // few dozen cards the main thread fell behind the compositor and the chips

    // visibly swam against their thumbnails (the "badges drift while scrolling"

    // symptom). The rect is now measured once — and again only when the layout

    // really changed — while a scroll event just shifts each chip by the scroll

    // delta. That is a pure style write with no layout read, so the chips track

    // the cards even when the main thread is busy.

    function nearestScrollContainer(node) {

      let el = node?.parentElement || null;

      while (el && el !== document.documentElement && el !== document.body) {

        const cs = getComputedStyle(el);

        const scrollsY = /(auto|scroll|overlay)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;

        const scrollsX = /(auto|scroll|overlay)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;

        if (scrollsY || scrollsX) return el;

        el = el.parentElement;

      }

      return viewportScroller();

    }



    // Which element actually carries the page scroll. A layout with

    // html{overflow:hidden} and a scrolling body reports documentElement as the

    // scrolling element while body holds the offset, and reading the wrong one

    // would leave every chip frozen at its first measured spot.

    function viewportScroller() {

      const candidates = [document.scrollingElement, document.body, document.documentElement];

      for (const el of candidates) {

        if (el && el.scrollHeight > el.clientHeight + 1) return el;

      }

      return document.scrollingElement || document.documentElement;

    }



    function placeHud(hud, img) {

      if (!hud || !img) return;

      const scroller = nearestScrollContainer(img);

      hud._bahScroller = scroller;

      hud._bahScroll = { x: scroller.scrollLeft || 0, y: scroller.scrollTop || 0 };

      const rect = img.getBoundingClientRect();

      hud._bahPageTop = rect.top + hud._bahScroll.y;

      hud._bahPageBottom = rect.bottom + hud._bahScroll.y;

      hud.style.left = rect.left + 'px';

      hud.style.top = rect.top + 'px';

      hud.style.width = rect.width + 'px';

      hud.style.height = rect.height + 'px';

      hud.style.visibility = rect.width && rect.height ? 'visible' : 'hidden';

      shiftHud(hud);

    }



    function shiftHud(hud) {

      const anchor = hud._bahScroll;

      if (!anchor) return;

      const scroller = hud._bahScroller || viewportScroller();

      const dx = anchor.x - (scroller.scrollLeft || 0);

      const dy = anchor.y - (scroller.scrollTop || 0);

      hud.style.transform = dx || dy ? `translate3d(${dx}px,${dy}px,0)` : '';

      // Promote only what is near the viewport. A big album must not keep a

      // composited layer alive for every card it has ever rendered.

      const viewTop = (scroller.scrollTop || 0) - 300;

      const nearViewport = hud._bahPageBottom > viewTop &&

        hud._bahPageTop < viewTop + (window.innerHeight || 800) + 600;

      const want = nearViewport ? 'transform' : '';

      if (hud.style.willChange !== want) hud.style.willChange = want;

    }



    function shiftHudsToScroll() {

      const layer = document.getElementById(HUD_LAYER_ID);

      if (!layer) return;

      for (const hud of layer.children) {

        if (hud.style.display === 'none') continue;

        shiftHud(hud);

      }

    }



    // Measured positions go stale when something above the card changes height

    // (a lazy thumbnail, a card that grew). Nothing resizes the image itself in

    // that case, so ResizeObserver stays silent and the heal has to re-measure.

    // Doing it once the scrolling settles keeps the cost off the scroll frames.

    function scheduleHudHeal() {

      clearTimeout(hudHealTimer);

      hudHealTimer = setTimeout(() => positionHudLayer(), 160);

    }



    function ensureHudLayer() {

      let layer = document.getElementById(HUD_LAYER_ID);

      if (layer) return layer;

      layer = document.createElement('div');

      layer.id = HUD_LAYER_ID;

      document.documentElement.appendChild(layer);

      const schedule = () => {

        if (hudPositionFrame) return;

        hudPositionFrame = requestAnimationFrame(() => {

          hudPositionFrame = 0;

          positionHudLayer();

        });

      };

      window.addEventListener('scroll', () => {

        shiftHudsToScroll();

        scheduleHudHeal();

      }, { capture: true, passive: true });

      window.addEventListener('scrollend', () => positionHudLayer(), { passive: true });

      window.addEventListener('resize', schedule, { passive: true });

      return layer;

    }



    function positionHudLayer() {

      const layer = document.getElementById(HUD_LAYER_ID);

      if (!layer) return;

      for (const hud of layer.children) {

        const img = hud._bahImage;

        if (!img?.isConnected) {

          hud.remove();

          continue;

        }

        const card = img.closest('.bah-card') || img.closest('.theItem, .grid-item, .file-card');

        if (card && (card.classList.contains('bah-hidden') || card.style.display === 'none')) {

          hud.style.display = 'none';

          hud.style.visibility = 'hidden';

          continue;

        }

        hud.style.display = '';

        placeHud(hud, img);

      }

    }



    // --------------------------------------------------------------------------- //

    // bridge fetch (CSP/CORS-proof localhost calls)

    // --------------------------------------------------------------------------- //

    function bridgeFetch(url, opts = {}) {

      if (!GM_REQ) {

        return fetch(url, opts).then(async (r) => ({

          ok: r.ok, status: r.status, json: () => r.json(), text: () => r.text(),

        }));

      }

      return new Promise((resolve, reject) => {

        GM_REQ({

          method: opts.method || 'GET',

          url,

          headers: opts.headers || {},

          data: opts.body,

          timeout: opts.timeoutMs || 20000,

          onload: (res) => {

            const text = res.responseText || '';

            resolve({

              ok: res.status >= 200 && res.status < 300,

              status: res.status,

              text: () => Promise.resolve(text),

              json: () => Promise.resolve((() => { try { return JSON.parse(text); } catch { return {}; } })()),

            });

          },

          onerror: () => reject(new TypeError('Failed to fetch')),

          ontimeout: () => reject(new TypeError('Request timed out')),

        });

      });

    }



    // --------------------------------------------------------------------------- //

    // prefs

    // --------------------------------------------------------------------------- //

    function defaultState() {

      return {

        q: '', sort: 'none', media: 'all', onlyMatches: false, onlySelected: false, hideDuplicates: false,

        onlyVertical: false,

        durationMin: '', durationMax: '', sizeMin: '', sizeMax: '',

        qualities: [],            // selected quality tiers, e.g. ['4K','1080p']

        port: DEFAULT_PORT, selected: [],

        gridCols: -1,             // Auto: 5 columns with the helper open, 6 when collapsed

        hdMode: '2x2',            // '2x2' (4-frame grid) | '1x' (single frame) | 'off'

        batchName: '',            // custom or selected batch name for intake import

        compareFilter: 'all',     // 'all' | 'better' | 'duplicate' | 'worse'

      };

    }

    function loadPrefs() {

      const s = defaultState();

      try {

        const p = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');

        s.port = Number(p.port) || DEFAULT_PORT;

        // v1's 8-column default made vertical previews too small. Migrate it once

        // to the new, larger Auto layout; later user choices remain untouched.

        if (p.gridLayoutVersion === 2 && p.gridCols !== undefined) s.gridCols = Number(p.gridCols);

        if (p.hdMode !== undefined) s.hdMode = p.hdMode;

        // Batch name must start fresh per album - do NOT restore legacy persisted batchName

        // Selection and filters must start clean on every page - clean any legacy persisted selection

        if (p.selected || p.onlySelected || p.onlyMatches || p.q || p.batchName) {

          delete p.selected;

          delete p.onlySelected;

          delete p.onlyMatches;

          delete p.onlyVertical;

          delete p.q;

          delete p.qualities;

          delete p.batchName;

          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch { /* ignore */ }

        }

      } catch { /* ignore */ }

      return s;

    }

    function savePrefs() {

      try {

        localStorage.setItem(STORAGE_KEY, JSON.stringify({

          port: state.port,

          gridCols: state.gridCols,

          gridLayoutVersion: 2,

          hdMode: state.hdMode,

          // batchName is not persisted: each album gets a fresh batch name defaulted to the album title

        }));

      } catch { /* ignore */ }

    }



    const selected = new Set();

    let dashboardBatches = [];

    let batchNameUserEdited = false;

    const compareByUrl = new Map(); // url -> { status: 'better'|'worse'|'duplicate'|'new'|'replaced', reason, needs_probe, matched_video }

    let compareRunning = false;

    let lastCompareTs = 0;





    // --------------------------------------------------------------------------- //

    // persistent memory: video meta cache + album index (survive reloads)

    // --------------------------------------------------------------------------- //

    function loadMetaCache() {

      try {

        const obj = JSON.parse(localStorage.getItem(META_KEY) || '{}');

        for (const [url, m] of Object.entries(obj)) {

          if (m && m.duration > 0) metaByUrl.set(url, m); // only cache real hits

        }

      } catch { /* ignore */ }

    }

    let saveMetaTimer = null;

    function scheduleSaveMeta() {

      clearTimeout(saveMetaTimer);

      saveMetaTimer = setTimeout(saveMetaCache, 800);

    }

    function saveMetaCache() {

      try {

        // Persist only successful probes; keep the most recent MAX_CACHE by ts.

        let entries = [];

        for (const [url, m] of metaByUrl) {

          if (m && m.duration > 0) {

            entries.push([url, {

              ok: true, duration: m.duration, quality: m.quality || '',

              height: m.height || 0, width: m.width || 0, sizeBytes: m.sizeBytes || 0,

              bitrateBps: m.bitrateBps || bitrateOf(m), qualityScore: m.qualityScore || qualityScore(m),

              ts: m.ts || Date.now()

            }]);

          }

        }

        if (entries.length > MAX_CACHE) {

          entries.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));

          entries = entries.slice(0, MAX_CACHE);

        }

        localStorage.setItem(META_KEY, JSON.stringify(Object.fromEntries(entries)));

      } catch { /* ignore (quota) */ }

    }

    function albumKey() { return location.origin + location.pathname; }

    function recordAlbum() {

      try {

        const idx = JSON.parse(localStorage.getItem(ALBUM_KEY) || '{}');

        const timed = items.filter((it) => metaByUrl.get(it.url)?.duration).length;

        idx[albumKey()] = { title: albumTitle(), count: items.length, timed, ts: Date.now() };

        // Cap the album index to the 200 most recent.

        const keys = Object.keys(idx);

        if (keys.length > 200) {

          keys.sort((a, b) => (idx[b].ts || 0) - (idx[a].ts || 0))

            .slice(200).forEach((k) => delete idx[k]);

        }

        localStorage.setItem(ALBUM_KEY, JSON.stringify(idx));

      } catch { /* ignore */ }

    }

    function cachedAlbumCount() {

      try { return Object.keys(JSON.parse(localStorage.getItem(ALBUM_KEY) || '{}')).length; }

      catch { return 0; }

    }

    let recordAlbumTimer = null;

    function scheduleRecordAlbum() {

      clearTimeout(recordAlbumTimer);

      recordAlbumTimer = setTimeout(recordAlbum, 1500);

    }



    // --------------------------------------------------------------------------- //

    // boot (executed at bottom of IIFE after all let/const declarations)

    // --------------------------------------------------------------------------- //

    const VERT_AR_KEY = 'bunkr-album-helper:vert-ar:v1';

    const vertArByUrl = new Map();

    function loadVertArCache() {

      try {

        const obj = JSON.parse(localStorage.getItem(VERT_AR_KEY) || '{}');

        for (const [u, ar] of Object.entries(obj)) {

          const n = Number(ar);

          if (n > 0 && n < 0.95) vertArByUrl.set(u, n);

        }

      } catch { /* ignore */ }

    }

    let saveVertArTimer = null;

    function recordVertAr(url, ar) {

      if (!url) return;

      const n = Number(ar);

      if (!(n > 0 && n < 0.95)) return;

      const rounded = Number(n.toFixed(4));

      if (vertArByUrl.get(url) === rounded) return;

      vertArByUrl.set(url, rounded);

      clearTimeout(saveVertArTimer);

      saveVertArTimer = setTimeout(() => {

        try {

          const entries = [...vertArByUrl.entries()].slice(-5000);

          localStorage.setItem(VERT_AR_KEY, JSON.stringify(Object.fromEntries(entries)));

        } catch { /* ignore */ }

      }, 600);

    }

    let vertRatioSyncTimer = null;

    function scheduleVertRatioSync() {

      clearTimeout(vertRatioSyncTimer);

      vertRatioSyncTimer = setTimeout(() => {

        applyVisibility();

        syncPanel();

      }, 120);

    }



    function start() {

      document.addEventListener('change', (e) => {

        const nCb = e.target?.closest?.('.nexus-bunkr-checkbox');

        if (!nCb) return;

        const rawUrl = nCb.dataset.url;

        const card = nCb.closest(CARD_SEL) || nCb.closest('.bah-card');

        const link = card?.querySelector('a[href*="/f/"], a[href*="/v/"]');

        const url = rawUrl || (link ? absUrl(link.getAttribute('href')) : '');

        if (!url) return;

        if (nCb.checked) selected.add(url);

        else selected.delete(url);

        if (card) {

          card.classList.toggle('bah-selected', nCb.checked);

          const bahCb = card.querySelector('.bah-cb');

          if (bahCb && bahCb.checked !== nCb.checked) bahCb.checked = nCb.checked;

        }

        savePrefs();

        if (state.onlySelected) applyVisibility();

        syncPanel();

      }, true);

      document.addEventListener('click', (e) => {

        const closeBtn = e.target?.closest?.('.nexus-batch-close');

        if (closeBtn) {

          setTimeout(() => {

            selected.clear();

            savePrefs();

            refresh();

          }, 20);

        }

        const selAllBtn = e.target?.closest?.('.nexus-batch-select-all-btn');

        if (selAllBtn) {

          setTimeout(() => {

            document.querySelectorAll('.nexus-bunkr-checkbox:checked').forEach((cb) => {

              if (cb.dataset.url) selected.add(cb.dataset.url);

            });

            savePrefs();

            refresh();

          }, 20);

        }

      }, true);

      releaseNativeThumbs();

      applyGridMode();

      ensurePanel();

      cleanAlbumChrome();

      placeHelperToggle();

      window.addEventListener('resize', placeHelperToggle);

      window.addEventListener('resize', () => { updateRatioPitch(); scheduleRefresh(); });

      observePage();

      scheduleRefresh();

      detectPort();

      let currentAlbumUrl = location.href;

      function checkUrlChange() {

        if (location.href !== currentAlbumUrl) {

          currentAlbumUrl = location.href;

          selected.clear();

          state.onlySelected = false;

          state.onlyMatches = false;

          state.onlyVertical = false;

          state.q = '';

          batchNameUserEdited = false;

          state.batchName = albumTitle();

          const bInput = document.querySelector(`#${PANEL_ID} [data-role="batchName"]`);

          if (bInput) bInput.value = state.batchName;

          const bSel = document.querySelector(`#${PANEL_ID} [data-role="batchSelect"]`);

          if (bSel) bSel.value = '';

          metaByUrl.clear();

          loadMetaCache();

          refresh();

        }

      }

      window.addEventListener('popstate', checkUrlChange);

      window.addEventListener('hashchange', checkUrlChange);

      setInterval(checkUrlChange, 500);

    }



    function applyGridMode() {

      const cols = Number(state.gridCols);

      const auto = cols < 0;

      if (cols !== 0) {

        document.body.classList.add('bah-wide-grid');

        document.body.classList.toggle('bah-auto-grid', auto);

        const collapsed = document.getElementById(PANEL_ID)?.classList.contains('bah-collapsed');

        document.documentElement.style.setProperty('--bah-grid-cols', String(densityCols(auto, collapsed, cols)));

        updateRatioPitch();

      } else {

        document.body.classList.remove('bah-wide-grid');

        document.body.classList.remove('bah-auto-grid');

        document.documentElement.style.removeProperty('--bah-grid-cols');

        document.documentElement.style.removeProperty('--bah-row');

      }

    }



    // Column buttons are a density control. Row height is chosen so about N

    // 16:9 frames fit the workspace; portrait and wide frames then share that

    // height and keep their own width.

    function densityCols(auto, collapsed, cols) {

      if (auto === undefined) auto = Number(state.gridCols) < 0;

      if (cols === undefined) cols = Number(state.gridCols);

      if (collapsed === undefined) collapsed = !!document.getElementById(PANEL_ID)?.classList.contains('bah-collapsed');

      let count = auto ? (collapsed ? 6 : 5) : cols;

      const w = window.innerWidth || 1280;

      if (w <= 768) count = Math.min(count, 2);

      else if (w <= 1280) count = Math.min(count, 4);

      else if (w <= 1600) count = Math.min(count, 6);

      return Math.max(2, count || 5);

    }



    function updateRatioPitch() {

      if (!document.body.classList.contains('bah-wide-grid')) return;

      const grid = document.querySelector('.bah-ratio-grid');

      const cols = densityCols();

      const width = grid?.clientWidth || Math.max(320, (window.innerWidth || 1280) - 300);

      const gap = 12;

      const isOnlyVert = document.body.classList.contains('bah-only-vertical');

      const baseRow = Math.round(Math.min(340, Math.max(128, (width - gap * (cols - 1)) / cols * 9 / 16)));

      const row = isOnlyVert ? Math.round(baseRow * 2.1) : baseRow;

      document.documentElement.style.setProperty('--bah-grid-cols', String(cols));

      document.documentElement.style.setProperty('--bah-row', `${row}px`);

    }



    function clampRatio(ratio) {

      if (!Number.isFinite(ratio) || ratio <= 0.05) return 0;

      return Math.min(2.35, Math.max(0.46, ratio));

    }



    function checkIsVertical(el, url, meta) {

      if (el?.classList?.contains('bah-vertical-card')) return true;

      if (el?.dataset?.bahOrigAr && Number(el.dataset.bahOrigAr) < 0.95) return true;

      if (url && vertArByUrl.has(url)) {

        const cachedAr = vertArByUrl.get(url);

        if (el && !el.dataset.bahOrigAr) {

          el.dataset.bahOrigAr = cachedAr.toFixed(4);

          el.style.setProperty('--bah-orig-ar', cachedAr.toFixed(4));

        }

        return true;

      }

      if (meta?.height && meta?.width && meta.height > meta.width * 1.05) {

        const metaAr = clampRatio(meta.width / meta.height);

        if (metaAr && url) recordVertAr(url, metaAr);

        return true;

      }

      const img = getCardThumbImg(el);

      if (img?.naturalWidth && img?.naturalHeight && (img.naturalWidth / img.naturalHeight) < 0.95) {

        const imgAr = clampRatio(img.naturalWidth / img.naturalHeight);

        if (imgAr && url) recordVertAr(url, imgAr);

        return true;

      }

      return false;

    }



    function triggerRollout(el, active) {

      if (document.body.classList.contains('bah-only-vertical')) return;

      el.classList.toggle('bah-rollout-active', active);

      const stage = el.querySelector('.bah-stage');

      if (stage) {

        if (active) {

          const orig = el.dataset.bahOrigAr || '0.5625';

          stage.style.aspectRatio = orig;

        } else {

          stage.style.aspectRatio = '16 / 9';

        }

      }

      requestAnimationFrame(positionHudLayer);

      setTimeout(positionHudLayer, 60);

      setTimeout(positionHudLayer, 200);

      setTimeout(positionHudLayer, 380);

    }



    function setCardRatio(el, ratio) {

      const clamped = clampRatio(ratio);

      if (!el || !clamped) return;

      const stage = el.querySelector('.bah-stage');

      const isVert = clamped < 0.95;



      if (isVert) {

        el.classList.add('bah-vertical-card');

        const origAr = clamped.toFixed(4);

        el.dataset.bahOrigAr = origAr;

        el.style.setProperty('--bah-orig-ar', origAr);

        const it = items.find((x) => x.el === el);

        if (it) {

          recordVertAr(it.url, clamped);

          if (!it.isVertical) {

            it.isVertical = true;

            scheduleVertRatioSync();

          }

        }



        const isOnlyVert = document.body.classList.contains('bah-only-vertical');

        const activeAr = isOnlyVert ? origAr : '1.7778';

        el.dataset.bahAr = activeAr;

        el.style.setProperty('--bah-ar', activeAr);

        if (stage && !el.classList.contains('bah-rollout-active')) {

          stage.style.aspectRatio = isOnlyVert ? origAr : '16 / 9';

        }



        if (stage && !stage.querySelector('.bah-vertical-badge')) {

          const vBadge = document.createElement('span');

          vBadge.className = 'bah-vertical-badge';

          vBadge.textContent = 'V';

          vBadge.title = 'Vertikálne video / náhľad (9:16)';

          stage.appendChild(vBadge);

        }

      } else {

        el.classList.remove('bah-vertical-card');

        const text = clamped.toFixed(4);

        el.dataset.bahAr = text;

        el.style.setProperty('--bah-ar', text);

        if (stage) stage.style.aspectRatio = text;

      }

    }



    function bindThumbRatio(img, el) {

      const apply = () => {

        if (!img.naturalWidth || !img.naturalHeight) return;

        if (el.classList.contains('bah-hd-live')) return;

        const r = img.naturalWidth / img.naturalHeight;

        setCardRatio(el, r);

        const it = items.find((x) => x.el === el);

        if (it) {

          const wasVert = it.isVertical;

          it.isVertical = r < 0.95;

          if (it.isVertical) recordVertAr(it.url, clampRatio(r));

          if (wasVert !== it.isVertical) scheduleVertRatioSync();

        }

      };

      apply();

      if (img.dataset.bahRatioBound === '1') return;

      img.dataset.bahRatioBound = '1';

      img.addEventListener('load', () => {

        apply();

        requestAnimationFrame(positionHudLayer);

      });

    }



    function prettyTitle(title) {

      let text = String(title || '');

      try { text = decodeURIComponent(text.replace(/\+/g, ' ')); } catch { /* already plain */ }

      return text.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

    }



    function ensureMediaStage(el) {

      const img = getCardThumbImg(el);

      if (!img) return null;

      el.classList.add('bah-card');

      el.querySelectorAll('.bah-stage-spacer').forEach((s) => s.remove());



      let stage = img.closest('.bah-stage');

      if (!stage) {

        stage = document.createElement('div');

        stage.className = 'bah-stage';

        img.parentNode.insertBefore(stage, img);

        stage.appendChild(img);

      }

      let anchor = stage.closest('.bah-stage-anchor');

      if (!anchor) {

        anchor = document.createElement('div');

        anchor.className = 'bah-stage-anchor';

        stage.parentNode.insertBefore(anchor, stage);

        anchor.appendChild(stage);

      }

      const play = el.querySelector('.bah-play-btn');

      if (play && play.parentElement !== stage) stage.appendChild(play);

      const cb = el.querySelector(':scope > .bah-cb-wrap');

      if (cb) stage.appendChild(cb);

      return stage;

    }



    function ensureCaption(el, title) {

      const label = prettyTitle(title);

      let cap = el.querySelector(':scope > .bah-caption');

      if (!cap) {

        cap = document.createElement('div');

        cap.className = 'bah-caption';

        el.appendChild(cap);

      }

      if (cap.textContent !== label) cap.textContent = label;

      cap.title = label;

      const nativeTitle = el.querySelector('.mt-2 p, .title, .theName, .filename, .grid-images_box-name');

      if (nativeTitle && !nativeTitle.closest('.bah-caption, .bah-thumb-hud, .bah-stage-chips') && !/^\s*\d+(?:[.,]\d+)?\s*(?:TB|GB|MB|KB)\s*$/i.test(nativeTitle.textContent || '')) {

        nativeTitle.classList.add('bah-native-title');

      }

    }



    function markRatioGrids() {

      const parents = new Set(items.map((it) => it.el.parentElement).filter(Boolean));

      document.querySelectorAll('.bah-ratio-grid').forEach((node) => {

        if (!parents.has(node)) node.classList.remove('bah-ratio-grid');

      });

      const wide = document.body.classList.contains('bah-wide-grid');

      for (const parent of parents) {

        parent.classList.add('bah-ratio-grid');

        let tail = [...parent.children].find((node) => node.classList?.contains('bah-flex-tail'));

        if (!wide) {

          tail?.remove();

          continue;

        }

        if (!tail) {

          tail = document.createElement('span');

          tail.className = 'bah-flex-tail';

          tail.setAttribute('aria-hidden', 'true');

        }

        parent.appendChild(tail);

      }

      document.querySelectorAll('.bah-flex-tail').forEach((node) => {

        if (!node.parentElement?.classList.contains('bah-ratio-grid') || !wide) node.remove();

      });

      if (wide) updateRatioPitch();

    }



    function placeHelperToggle() {

      const panel = document.getElementById(PANEL_ID);

      if (!panel) return;

      if (!panel.classList.contains('bah-collapsed')) {

        panel.style.removeProperty('top');

        panel.style.removeProperty('left');

        panel.style.removeProperty('right');

        return;

      }

      const sortLabels = new Set(['date', 'name', 'size']);

      const sortButtons = [...document.querySelectorAll('button')]

        .filter((button) => sortLabels.has(button.textContent.trim().toLowerCase()));

      if (!sortButtons.length) {

        panel.style.removeProperty('top');

        panel.style.removeProperty('left');

        panel.style.removeProperty('right');

        return;

      }

      const rects = sortButtons.map((button) => button.getBoundingClientRect());

      const top = Math.min(...rects.map((rect) => rect.top));

      const left = Math.min(...rects.map((rect) => rect.left));

      panel.style.top = `${Math.max(72, Math.min(window.innerHeight - 60, top))}px`;

      panel.style.left = `${Math.max(14, left - 58)}px`;

      panel.style.right = 'auto';

    }



    function cleanAlbumChrome() {

      const redirectPhrase = 'bunkr-albums.io is now balbums.st';

      const noticeLeaf = [...document.querySelectorAll('a,div,p,section,aside')]

        .filter((node) => (node.textContent || '').toLowerCase().includes(redirectPhrase))

        .sort((a, b) => a.childElementCount - b.childElementCount)[0];

      if (noticeLeaf) {

        let banner = noticeLeaf;

        for (let node = noticeLeaf; node && node !== document.body; node = node.parentElement) {

          const rect = node.getBoundingClientRect();

          banner = node;

          if (rect.width >= window.innerWidth * .72 && rect.height > 24 && rect.height < 180) break;

        }

        banner.classList.add('bks-redirect-banner-hidden');

      }



      const albumsLink = [...document.querySelectorAll('header a,nav a')]

        .find((link) => link.textContent.trim().toLowerCase() === 'albums');

      if (!albumsLink) return;

      const topBar = albumsLink.closest('header') || albumsLink.closest('nav')?.parentElement || albumsLink.parentElement;

      if (!topBar) return;



      topBar.classList.add('bks-clean-topbar');

      albumsLink.classList.remove('bks-site-control-hidden');

      albumsLink.target = '_blank';

      albumsLink.rel = 'noopener noreferrer';

      albumsLink.title = 'Open Balbums';



      let search = topBar.querySelector('.bks-balbums-search');

      if (!search) {

        search = document.createElement('form');

        search.className = 'bks-balbums-search';

        search.setAttribute('role', 'search');

        search.innerHTML = `

        <span class="bks-search-mark" aria-hidden="true">⌕</span>

        <input type="search" name="query" autocomplete="off" spellcheck="false"

          aria-label="Search Balbums" placeholder="Search Balbums…">

        <button type="submit" title="Search in a new tab" aria-label="Search in a new tab">↗</button>`;

        search.addEventListener('submit', (event) => {

          event.preventDefault();

          const query = search.elements.query.value.trim();

          if (!query) {

            search.elements.query.focus();

            return;

          }

          const opened = window.open(url, '_blank', 'noopener,noreferrer');

          if (opened) opened.opener = null;

        });

        topBar.appendChild(search);

      }



      topBar.querySelectorAll('a,button').forEach((control) => {

        if (control === albumsLink || control.closest('.bks-balbums-search')) return;

        control.classList.add('bks-site-control-hidden');

      });

    }



    function observePage() {

      const root = document.querySelector('.grid-images, #galleryGrid') || document.body;

      const obs = new MutationObserver((mutations) => {

        if (suppressObserver) return;

        const ownUi = mutations.every((mutation) => {

          const node = mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement;

          return node?.closest?.(`#${PANEL_ID}, #${HUD_LAYER_ID}, #bah-hover-preview, .bah-hd-overlay, .bah-stage, .bah-stage-anchor, .bah-caption, .bah-flex-tail, .bah-floating-split-bar, .bah-split-modal, .bah-player-modal`);

        });

        if (!ownUi) scheduleRefresh();

      });

      obs.observe(root, { childList: true, subtree: true });

    }

    function scheduleRefresh() {

      clearTimeout(refreshTimer);

      refreshTimer = setTimeout(refresh, 600);

    }



    function releaseNativeThumbs(root = document) {

      const eagerLimit = (window.innerHeight || 800) * 2.5;

      root.querySelectorAll('img.grid-images_box-img, img.thumb-img').forEach((img) => {

        img.decoding = 'async';

        if (/this\.remove\s*\(/.test(img.getAttribute('onerror') || '')) {

          img.removeAttribute('onerror');

          img.addEventListener('error', () => {

            if (img.dataset.bahRetried === '1') return;

            img.dataset.bahRetried = '1';

            const src = img.getAttribute('src');

            if (src) img.src = src;

          });

        }

        if (img.getBoundingClientRect().top < eagerLimit) img.loading = 'eager';

      });

    }



    // --------------------------------------------------------------------------- //

    // card discovery (link-first: climb to the real per-card element, never a

    // multi-card wrapper — hiding a wrapper would blank the whole grid)

    // --------------------------------------------------------------------------- //

    const CARD_SEL = '.theItem, .grid-item, .file-card, .border-b.py-3.px-3';

    function getCards() {

      const links = Array.from(document.querySelectorAll('a[href*="/f/"], a[href*="/v/"]'));

      const seen = new Set();

      const out = [];

      for (const link of links) {

        if (link.closest(`#${PANEL_ID}`)) continue;

        const url = absUrl(link.getAttribute('href'));

        if (!url || seen.has(url)) continue;

        const el = link.closest(CARD_SEL) || (BUNKR_SUITE_FINDR_ALBUM ? link.closest('.group') : null) || link.parentElement;

        if (!el || el.id === PANEL_ID || el.closest(`#${PANEL_ID}`)) continue;

        // Safety net: never accept an element that itself contains many file

        // links (i.e. a grid/wrapper) — that would hide everything when filtered.

        if (el.querySelectorAll('a[href*="/f/"], a[href*="/v/"]').length > 3) continue;

        seen.add(url);

        out.push({ el, url });

      }

      return out;

    }



    function absUrl(href) {

      try { return new URL(href, location.href).href; } catch { return ''; }

    }



    function cardTitle(el, url) {

      const p = el.querySelector('.mt-2 p, .title, .theName, h1, h2, h3, .filename');

      let t = (p?.textContent || '').trim();

      if (!t) {

        const a = [...el.querySelectorAll('a[href*="/f/"], a[href*="/v/"]')].find((link) => link.textContent.trim());

        if (a && a.textContent.trim().toLowerCase() !== 'open') t = a.textContent.trim();

      }

      t = t || url.split('/').pop() || 'Bunkr file';



      // Bunkr sometimes squishes title, size, and date together in the DOM.

      // Strip everything after the file extension (if it's not a letter).

      t = t.replace(/(\.(?:mp4|m4v|mkv|mov|webm|avi|wmv|flv|ts|rar|zip|7z|tar|gz|jpg|jpeg|png|gif|webp|txt|pdf|epub))(?![a-z]).*$/i, '$1');

      return t.trim();

    }



    function getCardThumbImg(el) {

      if (!el) return null;

      // Prefer the real preview. Measuring every icon with getBoundingClientRect

      // forced a layout on each card during every refresh and stalled thumbnail loads.

      const direct = el.querySelector('img.grid-images_box-img, img.thumb-img');

      if (direct) return direct;

      return Array.from(el.querySelectorAll('img')).find((img) => {

        const src = img.getAttribute('data-src') || img.getAttribute('src') || '';

        return src && !/video\.svg|\/icon|avatar|badge|placeholder/i.test(src);

      }) || null;

    }



    function cardThumb(el) {

      const img = getCardThumbImg(el);

      const raw = img?.getAttribute('data-src') || img?.getAttribute('src') || '';

      if (raw && raw.startsWith('http') && !raw.includes('video.svg')) return raw;

      return '';

    }

    function cardSizeBytes(el) {

      // Read the size label directly. innerText and a full-card query force layout

      // and were running again on every mutation while thumbnails were still loading.

      const sizeOnly = el.querySelector('.theSize') || [...el.querySelectorAll('p, span')]

        .find((node) => /^\s*\d+(?:[.,]\d+)?\s*(?:TB|GB|MB|KB)\s*$/i.test(node.textContent || ''));

      const m = (sizeOnly?.textContent || '')

        .match(/(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB)\b/i);

      if (!m) return 0;

      const val = parseFloat(m[1].replace(',', '.'));

      const mult = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

      return Math.round(val * (mult[m[2].toUpperCase()] || 1));

    }

    function cardDateTs(el) {

      // Bunkr shows "12:00:37 08/07/2025" (HH:MM:SS DD/MM/YYYY).

      const m = ((el.querySelector('.theDate')?.textContent || el.textContent || '')).match(/(\d{2}):(\d{2}):(\d{2})\s+(\d{2})\/(\d{2})\/(\d{4})/);

      if (!m) return 0;

      const [, hh, mm, ss, d, mo, y] = m.map(Number);

      return new Date(y, mo - 1, d, hh, mm, ss).getTime() || 0;

    }

    const VIDEO_FILE_RE = /\.(?:mp4|m4v|mkv|mov|webm|avi|wmv|flv|ts|m2ts|mts|mpeg|mpg|3gp|ogv)(?=$|[\s?#[\]()])/i;

    // Bunkr's multipart archives often end in .z01/.z02 or .r00/.r01, not .zip.

    // Treat those as non-video too; otherwise their preview sheets leak into the

    // Videos only result set.

    const NON_VIDEO_FILE_RE = /\.(?:rar|zip|7z|tar|gz|bz2|xz|iso|z\d{2}|r\d{2}|jpg|jpeg|png|gif|webp|avif|bmp|svg|heic|tiff?|txt|pdf|epub)(?=$|[\s?#[\]()])/i;



    function cardFileEvidence(el, url, title) {

      const fileLink = el.querySelector('a[href*="/f/"], a[href*="/v/"]');

      return [

        title,

        fileLink?.textContent,

        fileLink?.getAttribute('download'),

        fileLink?.dataset?.filename,

        fileLink?.dataset?.name,

        el.querySelector('.grid-images_box-name, .filename, [data-filename]')?.textContent,

        el.textContent,

        url,

      ].filter(Boolean).join('\n');

    }



    function cardIsVideo(el, url, title) {

      const evidence = cardFileEvidence(el, url, title);

      // A named archive/image always wins over decorative play/thumbnail markup.

      if (NON_VIDEO_FILE_RE.test(evidence)) return false;

      if (VIDEO_FILE_RE.test(evidence)) return true;

      // Current Bunkr markup marks real video rows this way, even where the

      // filename is shortened or lacks an extension in the visible title.

      if (el.querySelector('.type-Video, [data-type="video"], [data-file-type="video"], [data-icon*="video"], .ic-videos, svg[class*="video"]')) return true;

      if (el.querySelector('.fas.fa-play, .fa-video, .icon-video')) return true;

      // Do not guess. "Videos only" must be strict: unknown file types are

      // excluded rather than letting images and archives through.

      return false;

    }



    // --------------------------------------------------------------------------- //

    // main refresh: discover, inject overlays, apply filter/sort, repaint panel

    // --------------------------------------------------------------------------- //

    function refresh() {

      cleanAlbumChrome();

      applyGridMode();

      const viewport = captureViewportAnchor();

      // Our overlay injection + visibility toggling mutate the DOM; mute the page

      // observer for a beat so we don't trigger a refresh→mutate→refresh storm

      // (which, combined with Bunkr's own lazy-loader, blanked the grid).

      suppressObserver = true;

      clearTimeout(suppressTimer);

      const cards = getCards();

      items = cards.map(({ el, url }) => {

        const title = cardTitle(el, url);

        const meta = metaByUrl.get(url) || null;

        return {

          el, url, title,

          thumb: cardThumb(el),

          sizeBytes: cardSizeBytes(el),

          dateTs: cardDateTs(el),

          isVideo: cardIsVideo(el, url, title),

          meta,

          isVertical: checkIsVertical(el, url, meta),

        };

      });

      injectOverlays();

      applyOrder();

      applyVisibility();

      markRatioGrids();

      requestAnimationFrame(() => {

        positionHudLayer();

        requestAnimationFrame(positionHudLayer);

      });

      syncPanel();

      if (items.length) scheduleRecordAlbum();

      startHdUpgrade();

      items.filter(it=>it.isVideo && selected.has(it.url)).slice(0,12).forEach(it=>warmStream(it.url));

      if (connStatus === 'online' && !compareRunning && Date.now() - lastCompareTs > 2500) {

        compareWithDashboard();

      }

      if (!items.length) console.warn('[Bunkr Album Helper] No file cards found on this page. Bunkr may have changed its album markup.');

      suppressTimer = setTimeout(() => { suppressObserver = false; }, 350);

      restoreViewportAnchor(viewport);

    }



    // --------------------------------------------------------------------------- //

    // Storyboard Cache (GM_setValue + localStorage disk storage, 180-day TTL)

    // --------------------------------------------------------------------------- //

    const STORYBOARD_CACHE_KEY = 'bah_storyboard_cache_v2';

    const STORYBOARD_TTL = 180 * 24 * 60 * 60 * 1000; // 180 days (6 months)



    function normalizeCacheKey(url) {

      if (!url) return '';

      try {

        const parsed = new URL(url, location.href);

        let path = parsed.pathname.toLowerCase().replace(/\/+$/, '');

        path = path.replace(/^\/v\//, '/f/'); // normalize /v/ to /f/

        return path;

      } catch {

        return String(url).toLowerCase();

      }

    }



    function loadStoryboardCache() {

      let obj = {};

      // 1. Try GM_getValue (cross-domain persistent disk storage in Tampermonkey)

      try {

        if (typeof GM_getValue !== 'undefined') {

          const rawGM = GM_getValue(STORYBOARD_CACHE_KEY, null);

          if (rawGM) obj = typeof rawGM === 'string' ? JSON.parse(rawGM) : rawGM;

        }

      } catch { }



      // 2. Fallback / merge with localStorage

      try {

        const rawLS = localStorage.getItem(STORYBOARD_CACHE_KEY);

        if (rawLS) {

          const parsedLS = JSON.parse(rawLS);

          obj = Object.assign({}, parsedLS, obj);

        }

      } catch { }



      // Prune expired entries

      const now = Date.now();

      for (const k of Object.keys(obj)) {

        if (!obj[k] || (now - (obj[k].ts || 0) > STORYBOARD_TTL)) {

          delete obj[k];

        }

      }

      return obj;

    }



    function saveStoryboardCache(cache) {

      const raw = JSON.stringify(cache);

      // Save to GM_setValue for cross-domain disk storage

      try {

        if (typeof GM_setValue !== 'undefined') {

          GM_setValue(STORYBOARD_CACHE_KEY, raw);

        }

      } catch { }

      // Save to localStorage

      try {

        localStorage.setItem(STORYBOARD_CACHE_KEY, raw);

      } catch { }

    }



    const storyboardCache = loadStoryboardCache();



    async function fetchStoryboardUrl(videoPageUrl, retry = false) {

      const key = normalizeCacheKey(videoPageUrl);

      if (!key) return null;



      // A manual Fetch HD retries earlier missing/invalid storyboards.

      if (retry) delete storyboardCache[key];

      if (storyboardCache[key]?.url && Date.now() - storyboardCache[key].ts < STORYBOARD_TTL) {

        const entry = storyboardCache[key];

        return entry ? entry.url : null;

      }



      try {

        const res = await bridgeFetch(videoPageUrl, {

          headers: { 'Accept': 'text/html,*/*' },

          timeoutMs: 8000,

        });

        if (!res.ok) return null;

        const html = await res.text();

        const coverMatch = html.match(/videoCoverUrl\s*=\s*['"]([^'"]+)['"]/i);

        const ogMatch = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);

        let url = null;

        if (coverMatch && coverMatch[1]) {

          url = coverMatch[1].replace(/\\\//g, '/');

        } else if (ogMatch && /_grid\./i.test(ogMatch[1])) {

          url = ogMatch[1];

        }

        if (url) storyboardCache[key] = { url, ts: Date.now() };

        else delete storyboardCache[key];

        saveStoryboardCache(storyboardCache);

        return url;

      } catch {

        delete storyboardCache[key];

        return null;

      }

    }



    // --------------------------------------------------------------------------- //

    // Hover Preview

    // --------------------------------------------------------------------------- //

    let hoverPreviewNode = null;



    function ensureHoverPreviewNode() {

      if (hoverPreviewNode) return hoverPreviewNode;

      hoverPreviewNode = document.createElement('div');

      hoverPreviewNode.id = 'bah-hover-preview';

      document.body.appendChild(hoverPreviewNode);

      return hoverPreviewNode;

    }



    function hideHoverPreview() {

      if (hoverPreviewNode) {

        hoverPreviewNode.classList.remove('is-visible');

        hoverPreviewNode.innerHTML = '';

      }

    }



    async function showHoverPreview(el, url) {

      if (!cardIsVideo(el, url, cardTitle(el, url))) return;

      const modal = ensureHoverPreviewNode();

      const rect = el.getBoundingClientRect();

      // Clamp position so it stays on screen

      const mw = 520, mh = 420;

      let left = rect.left + rect.width / 2 - mw / 2;

      let top = rect.top - mh - 10;

      if (top < 10) top = rect.bottom + 10;

      left = Math.max(10, Math.min(left, window.innerWidth - mw - 10));

      top = Math.max(10, Math.min(top, window.innerHeight - mh - 10));

      modal.style.left = `${left}px`;

      modal.style.top = `${top}px`;

      modal.innerHTML = '<div class="bah-hp-spinner">Načítavam HD náhľad...</div>';

      modal.classList.add('is-visible');

      const posterUrl = await fetchStoryboardUrl(url);

      if (!modal.classList.contains('is-visible')) return;

      if (posterUrl) {

        modal.innerHTML = `<img src="${posterUrl}">`;

      } else {

        modal.innerHTML = '<div class="bah-hp-spinner" style="color:#ef4444">Náhľad nedostupný</div>';

      }

    }



    // --------------------------------------------------------------------------- //

    // HD Thumbnail Upgrade — replace blurry thumbs with storyboard frames

    // Modes: '1x' = single frame, '2x2' = 4-frame grid, 'off' = disabled

    // --------------------------------------------------------------------------- //

    const hdUpgradeQueue = [], hdQueued = new Set();

    let hdUpgradeActive = false, hdProgress = null;

    function updateHdProgress() {

      const button = document.querySelector('[data-act="fetchHdThumbs"]');

      if (button) button.textContent = hdProgress ? `HD ${hdProgress.done}/${hdProgress.total}` : 'Fetch HD';

    }

    async function runHdUpgradeQueue() {

      if (hdUpgradeActive) return;

      hdUpgradeActive = true;

      const worker = async () => {

        while (hdUpgradeQueue.length) {

          const {el,url,manual} = hdUpgradeQueue.shift();

          let success = false;

          try {

            if (!el.isConnected || state.hdMode === 'off') continue;

            if (el.classList.contains('bah-hd-done')) { success = true;continue; }

            el.dataset.bahHdState = 'loading';

            const sheetUrl = await fetchStoryboardUrl(url,manual);

            if (sheetUrl) success = await applyHdThumb(el,sheetUrl);

            if (!success && manual && el.isConnected) {

              delete storyboardCache[normalizeCacheKey(url)];

              success = await captureHdFrames(el,url);

            }

            if (success) { el.dataset.bahHdDone='1';el.dataset.bahHdState='ready'; }

            else { delete el.dataset.bahHdDone;el.dataset.bahHdState='failed'; }

          } catch (error) {

            delete el.dataset.bahHdDone;el.dataset.bahHdState='failed';

            console.warn('[Bunkr HD] Thumbnail failed:',url,error.message);

          } finally {

            hdQueued.delete(el);

            if (manual && hdProgress) { hdProgress.done++;success?hdProgress.ok++:hdProgress.failed++;updateHdProgress(); }

          }

        }

      };

      try { await Promise.all([worker(),worker()]); }

      finally {

        hdUpgradeActive=false;

        if (hdProgress && hdProgress.done >= hdProgress.total) {

          const {ok,failed}=hdProgress;hdProgress=null;updateHdProgress();

          toast(`HD náhľady: ${ok} načítaných · ${failed} nedostupných`,failed>0);

        }

      }

    }



    // Missing Bunkr contact sheets can be replaced with four decoded frames.

    // Keep the canvas on the page: canvas export is forbidden for many CDN CORS

    // configurations, but drawing and displaying their video frames is allowed.

    async function captureHdFrames(el,pageUrl) {

      if (document.querySelector('#nuss-overlay[style*="flex"],.bah-split-modal[style*="flex"]')) return false;

      const stream = await getVideoSrc(pageUrl);if (!stream || !el.isConnected) return false;

      const video = document.createElement('video'), cancel = new AbortController();

      video.muted=true;video.preload='metadata';video.playsInline=true;

      const abort=()=>cancel.abort();document.addEventListener('nexus-split-open',abort);

      const wait = (event,action) => new Promise((resolve,reject) => {

        const cleanup=()=>{clearTimeout(timer);video.removeEventListener(event,ready);video.removeEventListener('error',fail);cancel.signal.removeEventListener('abort',fail);};

        const ready=()=>{cleanup();resolve();};

        const fail=()=>{cleanup();reject(new Error('Video frame unavailable'));};

        const timer=setTimeout(fail,8000);

        video.addEventListener(event,ready,{once:true});video.addEventListener('error',fail,{once:true});cancel.signal.addEventListener('abort',fail,{once:true});

        if(cancel.signal.aborted){fail();return;}action();

      });

      try {

        await wait('loadedmetadata',()=>{video.src=stream;video.load();});

        if(!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration) || video.duration<=0)return false;

        const scale=Math.min(1,640/video.videoWidth,640/video.videoHeight);

        const width=Math.max(1,Math.round(video.videoWidth*scale)),height=Math.max(1,Math.round(video.videoHeight*scale));

        const canvas=document.createElement('canvas');canvas.width=width*2;canvas.height=height*2;

        const ctx=canvas.getContext('2d');if(!ctx)return false;

        for(const [i,fraction] of [.1,.35,.6,.85].entries()) {

          if(!el.isConnected || state.hdMode==='off' || cancel.signal.aborted)return false;

          await wait('seeked',()=>{video.currentTime=Math.max(.001,Math.min(video.duration-.001,video.duration*fraction));});

          ctx.drawImage(video,(i%2)*width,Math.floor(i/2)*height,width,height);

        }

        if(!el.isConnected)return false;

        const stage=ensureMediaStage(el), overlay=stage.querySelector('.bah-hd-overlay') || document.createElement('div');

        overlay.className='bah-hd-overlay';canvas.className='bah-hd-sheet';canvas.dataset.natW=String(canvas.width);canvas.dataset.natH=String(canvas.height);canvas.dataset.cols='2';canvas.dataset.rows='2';

        overlay.replaceChildren(canvas);if(!overlay.isConnected)stage.appendChild(overlay);

        el.classList.add('bah-hd-done');el.dataset.bahHdSource='video';syncHdPresentation(el);return true;

      } catch(error) {

        const canonical=new URL(new URL(pageUrl,location.href).pathname.replace(/^\/v\//,'/f/'),location.origin).href;

        delete videoSrcCache[canonical];throw error;

      } finally {

        document.removeEventListener('nexus-split-open',abort);cancel.abort();video.pause();video.removeAttribute('src');video.load();

      }

    }



    // Bunkr's preview sheet is a 4×4 contact sheet. One cell (and a 2×2 block)

    // has the same aspect ratio as the whole sheet, so the card can adopt that

    // ratio and we only pan/scale the sheet uniformly — never stretch a cell

    // into the old fixed box.

    const HD_SHEET = { cols: 4, rows: 4 };

    const hdStageObserver = typeof ResizeObserver !== 'undefined'

      ? new ResizeObserver((entries) => {

        for (const entry of entries) {

          const sheet = entry.target.querySelector?.('.bah-hd-sheet');

          if (sheet && state.hdMode !== 'off') placeHdSheet(sheet, entry.target);

        }

      })

      : null;



    function hdView(mode, cols = 4, rows = 4) {

      // Center of the sheet: cell (1,1), or the center 2×2 starting there.

      const col=cols===2?0:1,row=rows===2?0:1;

      if (mode === '2x2') return { col, row, cols: 2, rows: 2 };

      return { col, row, cols: 1, rows: 1 };

    }



    function placeHdSheet(sheet, stage) {

      const sheetW = Number(sheet.dataset.natW);

      const sheetH = Number(sheet.dataset.natH);

      const stageW = stage.clientWidth;

      const stageH = stage.clientHeight;

      if (!sheetW || !sheetH || stageW < 2 || stageH < 2) return;

      const cols=Number(sheet.dataset.cols)||HD_SHEET.cols,rows=Number(sheet.dataset.rows)||HD_SHEET.rows;

      const view = hdView(state.hdMode || '2x2',cols,rows);

      const cellW = sheetW / cols;

      const cellH = sheetH / rows;

      const viewW = cellW * view.cols;

      const viewH = cellH * view.rows;

      const scale = Math.min(stageW / viewW, stageH / viewH);

      const left = (stageW - viewW * scale) / 2 - view.col * cellW * scale;

      const top = (stageH - viewH * scale) / 2 - view.row * cellH * scale;

      sheet.style.width = `${sheetW * scale}px`;

      sheet.style.height = `${sheetH * scale}px`;

      sheet.style.left = `${left}px`;

      sheet.style.top = `${top}px`;

    }



    function syncHdPresentation(el) {

      if (!el) return;

      const overlay = el.querySelector('.bah-hd-overlay');

      const sheet = overlay?.querySelector('.bah-hd-sheet');

      const stage = el.querySelector('.bah-stage');

      const mode = state.hdMode || '2x2';

      if (!overlay || !sheet || !stage || mode === 'off' || !Number(sheet.dataset.natW)) {

        if (overlay) overlay.classList.remove('is-on');

        el.classList.remove('bah-hd-live');

        const img = getCardThumbImg(el);

        if (img?.naturalWidth && img.naturalHeight) setCardRatio(el, img.naturalWidth / img.naturalHeight);

        return;

      }

      const cols=Number(sheet.dataset.cols)||HD_SHEET.cols,rows=Number(sheet.dataset.rows)||HD_SHEET.rows;

      const view = hdView(mode,cols,rows);

      const viewAr = (Number(sheet.dataset.natW) / cols * view.cols)

        / (Number(sheet.dataset.natH) / rows * view.rows);

      el.classList.add('bah-hd-live');

      setCardRatio(el, viewAr);

      overlay.classList.add('is-on');

      hdStageObserver?.observe(stage);

      requestAnimationFrame(() => {

        placeHdSheet(sheet, stage);

        positionHudLayer();

      });

    }



    function applyHdThumb(el, storyboardUrl) {

      return new Promise(resolve => {

        if (!getCardThumbImg(el)) { resolve(false);return; }

        const probe=new Image();let settled=false;

        const finish=ok=>{if(settled)return;settled=true;clearTimeout(timer);probe.onload=probe.onerror=null;resolve(ok);};

        const timer=setTimeout(()=>{finish(false);probe.src='';},8000);

        probe.onload=()=>{

          if(!el.isConnected || !probe.naturalWidth || state.hdMode==='off'){finish(false);return;}

          el.dataset.bahSbUrl=storyboardUrl;el.dataset.bahHdSource='storyboard';

          const stage=ensureMediaStage(el)||el;

          const overlay=stage.querySelector('.bah-hd-overlay')||document.createElement('div');overlay.className='bah-hd-overlay';

          const sheet=document.createElement('img');sheet.className='bah-hd-sheet';sheet.alt='';sheet.draggable=false;

          sheet.dataset.natW=String(probe.naturalWidth);sheet.dataset.natH=String(probe.naturalHeight);sheet.dataset.cols='4';sheet.dataset.rows='4';sheet.src=storyboardUrl;

          overlay.replaceChildren(sheet);if(!overlay.isConnected)stage.appendChild(overlay);

          el.classList.add('bah-hd-done');syncHdPresentation(el);finish(true);

        };

        probe.onerror=()=>finish(false);probe.src=storyboardUrl;

      });

    }



    function switchAllHdMode(mode) {

      document.querySelectorAll('.bah-card, .bah-hd-done').forEach((el) => {

        if (el.querySelector?.('.bah-hd-overlay')) syncHdPresentation(el);

      });

      if (mode === 'off') return;

    }



    const hdObserver = typeof IntersectionObserver !== 'undefined'

      ? new IntersectionObserver((entries) => {

        if (state.hdMode === 'off') return;

        for (const entry of entries) {

          if (!entry.isIntersecting) continue;

          const el = entry.target;

          if (el.dataset.bahHdDone) continue;

          const a = el.querySelector('a[href*="/v/"], a[href*="/f/"]');

          const url = a?.href || '';

          if (url && cardIsVideo(el, url, cardTitle(el, url))) {

            if(!hdQueued.has(el)){hdQueued.add(el);hdUpgradeQueue.push({ el, url, manual:false });}

            runHdUpgradeQueue();

          }

        }

      }, { rootMargin: '200px', threshold: 0.1 })

      : null;



    function startHdUpgrade() {

      if (!hdObserver || state.hdMode === 'off') return;

      // Only paint storyboards we already have. Fetching a page per visible video

      // on load saturated the connection and the native thumbnails never appeared.

      for (const it of items) {

        if (!it.isVideo || it.el.dataset.bahHdDone) continue;

        const cached = storyboardCache[normalizeCacheKey(it.url)];

        if (cached && cached.url) hdObserver.observe(it.el);

      }

    }



    function fetchHdThumbs() {

      if(hdProgress){toast('HD náhľady sa ešte načítavajú…');return;}

      if (state.hdMode === 'off') {

        state.hdMode = '2x2';

        savePrefs();

        switchAllHdMode(state.hdMode);

        syncPanel();

      }

      const selectedVideos = items.filter((it) => it.isVideo && selected.has(it.url));

      const candidates = selectedVideos.length ? selectedVideos : filteredItems().filter((it) => it.isVideo);

      if (!candidates.length) {

        toast('No video cards are available for HD thumbnails.', true);

        return;

      }

      let queued = 0;

      for (const it of candidates) {

        if (!it.el?.isConnected || it.el.classList.contains('bah-hd-done') || hdQueued.has(it.el)) continue;

        // Allow a manual retry when an earlier background attempt could not load.

        delete it.el.dataset.bahHdDone;

        hdQueued.add(it.el);hdUpgradeQueue.push({ el: it.el, url: it.url, manual:true });

        queued++;

      }

      if (!queued) {

        toast('HD thumbnails are already loaded for these cards.');

        return;

      }

      hdProgress={total:queued,done:0,ok:0,failed:0};updateHdProgress();

      toast(`Fetching HD thumbnails for ${queued} ${selectedVideos.length ? 'selected' : 'visible'} video${queued === 1 ? '' : 's'}…`);

      runHdUpgradeQueue();

    }



    // --------------------------------------------------------------------------- //

    // Yandex Reverse Image Search

    // --------------------------------------------------------------------------- //

    async function yandexSearchSelected() {

      const sel = items.filter(it => selected.has(it.url) && it.isVideo);

      if (!sel.length) {

        alert('Najprv označ nejaké video karty!');

        return;

      }

      const batchSize = 5;

      for (let i = 0; i < sel.length; i += batchSize) {

        const batch = sel.slice(i, i + batchSize);

        for (const it of batch) {

          const thumbImg = getCardThumbImg(it.el);

          const thumbSrc = thumbImg?.getAttribute('data-src') || thumbImg?.src || '';

          if (!thumbSrc) continue;

          const yUrl = `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(thumbSrc)}`;

          window.open(yUrl, '_blank');

        }

        // Pause between batches

        if (i + batchSize < sel.length) {

          await new Promise(r => setTimeout(r, 1500));

        }

      }

    }



    function injectOverlays() {

      for (const it of items) {

        const { el, url } = it;



        if (!el.dataset.bahHoverBound) {

          el.dataset.bahHoverBound = '1';

          let hoverTimer;

          el.addEventListener('mouseenter', () => {

            if (el.classList.contains('bah-vertical-card')) return;

            hoverTimer = setTimeout(() => showHoverPreview(el, url), 600);

          });

          el.addEventListener('mouseleave', () => {

            clearTimeout(hoverTimer);

            hideHoverPreview();

          });

        }



        if (!el.dataset.bahRolloutBound) {

          el.dataset.bahRolloutBound = '1';

          let rolloutTimer = null;

          el.addEventListener('mouseenter', () => {

            if (!el.classList.contains('bah-vertical-card')) return;

            clearTimeout(rolloutTimer);

            rolloutTimer = setTimeout(() => {

              hideHoverPreview();

              triggerRollout(el, true);

            }, 1500);

          });

          el.addEventListener('mouseleave', () => {

            clearTimeout(rolloutTimer);

            if (el.classList.contains('bah-rollout-active')) {

              triggerRollout(el, false);

            }

          });

        }



        el.style.position = el.style.position || 'relative';

        el.style.cursor = el.style.cursor || 'pointer';

        ensureMediaStage(el);

        ensureCaption(el, it.title);

        const thumbForRatio = getCardThumbImg(el);

        if (thumbForRatio) bindThumbRatio(thumbForRatio, el);

        // checkbox

        let cb = el.querySelector('.bah-cb');

        if (!cb) {

          const wrap = document.createElement('label');

          wrap.className = 'bah-cb-wrap';

          wrap.innerHTML = `<input type="checkbox" class="bah-cb">`;

          el.appendChild(wrap);

          cb = wrap.querySelector('input');

          // A Bunkr card can itself be an interactive link. Never let its click

          // handler see a helper checkbox click, otherwise it may reset/reload the

          // gallery and throw the user back to the top of the album.

          wrap.addEventListener('mousedown', (e) => e.stopPropagation());

          wrap.addEventListener('click', (e) => e.stopPropagation());

          cb.addEventListener('change', (e) => {

            if (e.target.checked) selected.add(url); else selected.delete(url);

            el.classList.toggle('bah-selected', e.target.checked);

            el.classList.toggle('nexus-bunkr-item-selected', e.target.checked);

            const nCb = el.querySelector('.nexus-bunkr-checkbox');

            if (nCb && nCb.checked !== e.target.checked) nCb.checked = e.target.checked;

            savePrefs();

            if (state.onlySelected) applyVisibility();

            syncPanel();

          });

        }

        cb.checked = selected.has(url);

        const nexusCb = el.querySelector('.nexus-bunkr-checkbox');

        if (nexusCb && nexusCb.checked !== cb.checked) {

          nexusCb.checked = cb.checked;

        }

        el.classList.toggle('bah-selected', cb.checked);

        el.classList.toggle('nexus-bunkr-item-selected', cb.checked);



        // Click-to-select on the info block below the thumbnail (title/size/date),

        // not just the small checkbox — mirrors clicking the checkbox itself.

        // Bunkr often wraps the whole card (thumbnail + text) in one <a>, so this

        // must preventDefault to stop that navigation when the click lands outside

        // the actual thumbnail image.

        if (!el.dataset.bahInfoClickBound) {

          el.dataset.bahInfoClickBound = '1';

          el.addEventListener('click', (e) => {

            if (e.target.closest('.bah-cb-wrap, .nexus-bunkr-checkbox-container, .bah-play-btn, .bah-stage, .bah-stage-anchor, .bah-vertical-badge')) return;

            const pBtn = el.querySelector('.bah-play-btn');

            if (pBtn && e.clientX && e.clientY) {

              const r = pBtn.getBoundingClientRect();

              if (r.width > 0 && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {

                e.preventDefault();

                e.stopPropagation();

                openVideoPlayer(url);

                return;

              }

            }

            const img = getCardThumbImg(el);

            const thumbWrap = img ? (img.closest('a') || img.parentElement) : null;

            if (thumbWrap && thumbWrap.contains(e.target)) return;   // let the thumbnail navigate/open normally

            e.preventDefault();

            e.stopPropagation();

            const box = el.querySelector('.bah-cb');

            if (box) { box.checked = !box.checked; box.dispatchEvent(new Event('change', { bubbles: true })); }

          });

        }

        const stage = ensureMediaStage(el);

        if (it.isVideo) {

          let playBtn = el.querySelector('.bah-play-btn');

          if (!playBtn) {

            playBtn = document.createElement('div');

            playBtn.className = 'bah-play-btn';

            playBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;

            playBtn.title = 'Prehrať video';

            const handlePlay = (e) => {

              e.preventDefault();

              e.stopPropagation();

              if (e.stopImmediatePropagation) e.stopImmediatePropagation();

              openVideoPlayer(url);

            };

            playBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation(); }, true);

            playBtn.addEventListener('mousedown', (e) => { e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation(); }, true);

            playBtn.addEventListener('mouseup', (e) => { e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation(); }, true);

            playBtn.addEventListener('click', handlePlay, true);

          }

          if (stage && playBtn.parentElement !== stage) {

            stage.appendChild(playBtn);

          } else if (!stage && playBtn.parentElement !== el) {

            el.appendChild(playBtn);

          }

        }



        // Four-corner thumbnail HUD: each corner owns one fact, so metadata no

        // longer competes with the title/date block below the preview.

        const img = getCardThumbImg(el);

        const staleStage = img?.closest('.bah-thumb-stage');

        if (staleStage?.parentNode) {

          staleStage.parentNode.insertBefore(img, staleStage);

          staleStage.remove();

        }

        // Chips are mounted inside the card's own stage — the exact box the

        // thumbnail fills — so the browser keeps them glued to the card while the

        // album scrolls. The vertical "V" badge has always been rendered that way

        // and has never drifted. The fixed viewport layer is kept as the fallback

        // for any card whose thumbnail has no stage to mount into.

        const chipStage = img?.closest('.bah-stage') || null;

        let chipHost = chipStage?.querySelector(':scope > .bah-stage-chips') || null;

        if (chipStage && !chipHost) {

          chipHost = document.createElement('div');

          chipHost.className = 'bah-stage-chips';

          chipStage.appendChild(chipHost);

        }

        const hudLayer = chipHost ? null : ensureHudLayer();

        let hud = hudLayer ? [...hudLayer.children].find((node) => node._bahUrl === url) : null;

        if (hudLayer && img && !hud) {

          hud = document.createElement('span');

          hud.className = 'bah-thumb-hud';

          hud._bahUrl = url;

          hudLayer.appendChild(hud);

        }

        const chipTarget = chipHost || hud;

        const m = metaByUrl.get(url);

        if (it.isVertical || checkIsVertical(el, url, m)) {

          it.isVertical = true;

          el.classList.add('bah-vertical-card');

          chipTarget?.classList?.add('bah-hud-has-v');

          const stage = el.querySelector('.bah-stage');

          if (stage && !stage.querySelector('.bah-vertical-badge')) {

            const vBadge = document.createElement('span');

            vBadge.className = 'bah-vertical-badge';

            vBadge.textContent = 'V';

            vBadge.title = 'Vertikálne video / náhľad (9:16)';

            stage.appendChild(vBadge);

          }

          // Selector na stred pri vertikálnych kartách

          const cbEl = el.querySelector('.bah-cb-wrap, .nexus-bunkr-checkbox-container');

          if (cbEl) {

            cbEl.style.setProperty('left', '50%', 'important');

            cbEl.style.setProperty('transform', 'translateX(-50%)', 'important');

            cbEl.style.setProperty('top', '7px', 'important');

          }

        }

        if (chipTarget && img) {

          img.classList.add('bah-main-thumb');

          // Only the layer fallback needs measuring and re-placing. In-stage

          // chips are positioned by the browser together with the card, so they

          // need no bookkeeping at all.

          if (hud) {

            hud._bahImage = img;

            const positionHud = () => {

              if (!img.isConnected || !hud.isConnected) return;

              placeHud(hud, img);

            };

            positionHud();

            if (!img.dataset.bahHudLoadBound) {

              img.dataset.bahHudLoadBound = '1';

              img.addEventListener('load', () => requestAnimationFrame(positionHud));

              img.addEventListener('error', () => requestAnimationFrame(positionHud));

            }

            if (window.ResizeObserver && !img._bahResizeObs) {

              const obs = new ResizeObserver(() => positionHud());

              obs.observe(img);

              img._bahResizeObs = obs;

            }

          }

          chipTarget.replaceChildren();

          const dur = m?.duration ? fmtDur(m.duration) : '';

          const q = m?.quality || (m?.height ? heightToQ(m.height) : '');

          const rate = bitrateOf(m);

          const score = qualityScore(m);

          const shortRate = score.label === 'HQ' ? 'H' : score.label === 'OK' ? 'M' : score.label === 'LOW' ? 'L' : '';

          // Bunkr already prints the size on the card, so locate that label first

          // and fall back to its text when the metadata pass hasn't run. Wide-grid

          // mode covers the native card text with the thumbnail, so without this

          // the size is gone entirely until "Fetch durations & quality" is pressed

          // — that is the "changing the grid hides sizes" symptom.

          // The chip lives in the stage now, so it must not be mistaken for

          // Bunkr's own size label — hiding it would remove the very chip we

          // just placed.

          const sizePattern = /^\s*\d+(?:[.,]\d+)?\s*(?:TB|GB|MB|KB)\s*$/i;

          const nativeSize = [...el.querySelectorAll('p,span,div')]

            .filter((node) => !node.closest('.bah-thumb-hud, .bah-stage-chips') && sizePattern.test(node.textContent || ''))

            .sort((a, b) => a.childElementCount - b.childElementCount)[0];



          const sizeBytes = m?.sizeBytes || it.sizeBytes || 0;

          const sizeText = sizeBytes ? fmtBytes(sizeBytes) : (nativeSize?.textContent || '').trim();

          const sizeRateText = shortRate && sizeText ? `${sizeText} • ${shortRate}` : sizeText;



          let dateStr = '';

          if (it.dateTs) {

            const d = new Date(it.dateTs);

            if (d.getTime()) {

              dateStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

            }

          }



          const addChip = (corner, text, extraClass = '', title = '') => {

            if (!text) return;

            const chip = document.createElement('span');

            chip.className = `bah-hud-chip bah-hud-${corner}${extraClass ? ` ${extraClass}` : ''}`;

            chip.textContent = text;

            if (title) chip.title = title;

            chipTarget.appendChild(chip);

          };

          addChip('date', dateStr);

          addChip('duration', dur ? `◷ ${dur}` : '');

          addChip('quality', q, /(?:4k|2160)/i.test(q) ? 'is-4k' : '');

          addChip('size', sizeRateText, score.cls);

          const cmp = compareByUrl.get(url);

          if (cmp && cmp.status && cmp.status !== 'new') {

            let label = '';

            let cls = '';

            if (cmp.status === 'better') {

              label = '★ LEPŠIA KVALITA';

              cls = 'is-better';

            } else if (cmp.status === 'worse') {

              label = 'HORŠIA KVALITA';

              cls = 'is-worse';

            } else if (cmp.status === 'duplicate') {

              label = 'DUPLIKÁT';

              cls = 'is-dupe';

            } else if (cmp.status === 'replaced') {

              label = _t('NAHRADENÉ ✓', 'REPLACED ✓');

              cls = 'is-replaced';

            }

            if (cmp.needs_probe && cmp.status !== 'replaced') {

              label += ' ◷?';

            }

            addChip('compare', label, cls, cmp.reason || label);

          }

          chipTarget.hidden = !chipTarget.childElementCount;



          // Only hide Bunkr's own label once our chip is genuinely standing in for

          // it. addChip() no-ops on empty text, so hiding unconditionally stripped

          // the size off every card and put nothing back. The remove() matters too:

          // a card can lose its metadata on a re-render, and without it the label

          // would stay hidden from an earlier pass.

          if (sizeRateText) nativeSize?.classList.add('bah-native-size');

          else nativeSize?.classList.remove('bah-native-size');

        }

      }

      const activeUrls = new Set(items.map((it) => it.url));

      const liveLayer = document.getElementById(HUD_LAYER_ID);

      if (liveLayer) {

        for (const hud of liveLayer.children) {

          if (!activeUrls.has(hud._bahUrl)) hud.remove();

        }

        positionHudLayer();

      }

    }



    // --------------------------------------------------------------------------- //

    // filtering + sorting

    // --------------------------------------------------------------------------- //

    // Pixel height of an item (from probed meta, else parsed from its quality str).

    function heightOf(it) {

      const m = it.meta || {};

      if (m.height) return m.height;

      const q = String(m.quality || '');

      if (/4k/i.test(q)) return 2160;

      const d = q.match(/(\d{3,4})/);

      return d ? Number(d[1]) : 0;

    }

    // Bucket a height into one of the filter chips: 4K / 1080p / 720p / 480p / SD.

    function qualityTier(it) {

      const h = heightOf(it);

      if (h >= 2160) return '4K';

      if (h >= 1080) return '1080p';

      if (h >= 720) return '720p';

      if (h >= 480) return '480p';

      return h > 0 ? 'SD' : '';

    }

    function buildCtx() {

      const q = state.q.trim().toLowerCase();

      const durMin = numOr(state.durationMin) * 60;   // input is minutes → secs

      const durMax = numOr(state.durationMax) * 60;

      const sizeMin = numOr(state.sizeMin) * 1024 ** 2; // input is MB → bytes

      const sizeMax = numOr(state.sizeMax) * 1024 ** 2;

      const quals = state.qualities || [];

      return { q, durMin, durMax, sizeMin, sizeMax, quals };

    }

    function passes(it, ctx) {

      if (state.hideDuplicates && compareByUrl.get(it.url)?.status === 'duplicate') return false;

      if (state.onlyVertical && !it.isVertical) return false;

      if (state.media === 'videos' && !it.isVideo) return false;

      if (ctx.q && !it.title.toLowerCase().includes(ctx.q)) return false;

      if (state.compareFilter && state.compareFilter !== 'all') {

        const cmp = compareByUrl.get(it.url);

        const st = cmp ? cmp.status : 'new';

        if (state.compareFilter === 'better' && st !== 'better') return false;

        if (state.compareFilter === 'duplicate' && st !== 'duplicate') return false;

        if (state.compareFilter === 'worse' && st !== 'worse') return false;

      }

      const dur = it.meta?.duration || 0;

      // A Bunkr card can expose its size before probing duration/quality. Prefer

      // probed metadata when available, but do not let a missing value silently

      // pass an active size filter: that made "min 1000 MB" leave every card on

      // screen when card-size parsing briefly lagged behind Bunkr's lazy render.

      const size = Number(it.meta?.sizeBytes || it.sizeBytes || 0);

      if (ctx.durMin && dur && dur < ctx.durMin) return false;

      if (ctx.durMax && dur && dur > ctx.durMax) return false;

      if ((ctx.sizeMin || ctx.sizeMax) && !(size > 0)) return false;

      if (ctx.sizeMin && size < ctx.sizeMin) return false;

      if (ctx.sizeMax && size > ctx.sizeMax) return false;

      // When a duration filter is set but we have no meta yet, hide to avoid noise.

      if ((ctx.durMin || ctx.durMax) && !dur) return false;

      // Quality filter: keep only items whose tier is among the selected chips.

      if (ctx.quals.length) {

        const tier = qualityTier(it);

        if (!tier || !ctx.quals.includes(tier)) return false;

      }

      return true;

    }

    function sortList(list) {

      const by = state.sort;

      const sizeOf = (it) => it.meta?.sizeBytes || it.sizeBytes || 0;

      const durOf = (it) => it.meta?.duration || 0;

      if (by === 'az') list.sort((a, b) => a.title.localeCompare(b.title));

      else if (by === 'za') list.sort((a, b) => b.title.localeCompare(a.title));

      else if (by === 'sizeAsc') list.sort((a, b) => sizeOf(a) - sizeOf(b));

      else if (by === 'sizeDesc') list.sort((a, b) => sizeOf(b) - sizeOf(a));

      else if (by === 'durAsc') list.sort((a, b) => durOf(a) - durOf(b));

      else if (by === 'durDesc') list.sort((a, b) => durOf(b) - durOf(a));

      else if (by === 'qualAsc') list.sort((a, b) => heightOf(a) - heightOf(b));

      else if (by === 'qualDesc') list.sort((a, b) => heightOf(b) - heightOf(a));

      else if (by === 'rateAsc') list.sort((a, b) => bitrateOf(a.meta || {}) - bitrateOf(b.meta || {}));

      else if (by === 'rateDesc') list.sort((a, b) => bitrateOf(b.meta || {}) - bitrateOf(a.meta || {}));

      else if (by === 'dateNew') list.sort((a, b) => b.dateTs - a.dateTs);

      else if (by === 'dateOld') list.sort((a, b) => a.dateTs - b.dateTs);

      return list;

    }

    function filteredItems() {

      const ctx = buildCtx();

      return sortList(items.filter((it) => passes(it, ctx)));

    }

    function displayedItems() {

      const ctx = buildCtx();

      const matched = new Set(items.filter((it) => passes(it, ctx)).map((it) => it.url));

      return items.filter((it) => {

        if (state.hideDuplicates && compareByUrl.get(it.url)?.status === 'duplicate') return false;

        const isMatch = matched.has(it.url);

        const isSelected = selected.has(it.url);

        if (state.onlySelected && !isSelected) return false;

        if ((state.onlyMatches || state.onlyVertical) && !isMatch) return false;

        return true;

      });

    }

    function currentFetchPool() {

      const selectedInAlbum = items.filter((it) => selected.has(it.url));

      if (selectedInAlbum.length > 0) {

        return selectedInAlbum;

      }

      return items.length > 0 ? items : displayedItems();

    }

    // Physically reorder the card elements in their grid container so the chosen

    // sort is actually visible (CSS grid/flex lays out in DOM order). Without this

    // the sort only affected internal lists, never the page.

    function applyOrder() {

      if (state.sort === 'none') return;            // keep Bunkr's native order

      const ordered = sortList(items.slice());

      const byParent = new Map();

      for (const it of ordered) {

        const p = it.el.parentElement;

        if (!p) continue;

        if (!byParent.has(p)) byParent.set(p, []);

        byParent.get(p).push(it.el);

      }

      // Re-append each card to its parent in sorted order (appendChild moves it).

      for (const [p, els] of byParent) for (const el of els) p.appendChild(el);

    }

    function applyVisibility() {

      if (state.onlySelected && selected.size === 0) {

        state.onlySelected = false;

      }

      const ctx = buildCtx();

      const visibleItems = items.filter((it) => {

        return passes(it, ctx) && (!state.onlySelected || selected.has(it.url));

      });

      const visible = new Set(visibleItems.map((it) => it.url));



      const isOnlyVerticalActive = Boolean(

        state.onlyVertical ||

        ((state.onlyMatches || state.onlySelected) && visibleItems.length > 0 && visibleItems.every((it) => it.isVertical))

      );

      document.body.classList.toggle('bah-only-vertical', isOnlyVerticalActive);



      for (const it of items) {

        const isVisible = visible.has(it.url);

        const hide = ((state.onlyMatches || state.onlyVertical) && !isVisible) ||
          (state.onlySelected && !selected.has(it.url)) ||
          (state.hideDuplicates && compareByUrl.get(it.url)?.status === 'duplicate');

        it.el.classList.toggle('bah-hidden', hide);

        if (hide) {

          it.el.style.setProperty('display', 'none', 'important');

        } else {

          it.el.style.removeProperty('display');

        }

        it.el.classList.toggle('bah-dim', !isVisible && !hide);



        if (it.isVertical) {

          const stage = it.el.querySelector('.bah-stage');

          const origAr = it.el.dataset.bahOrigAr || '0.5625';

          if (isOnlyVerticalActive) {

            it.el.style.setProperty('--bah-ar', origAr);

            if (stage) stage.style.aspectRatio = origAr;

          } else {

            it.el.style.setProperty('--bah-ar', '1.7778');

            if (stage && !it.el.classList.contains('bah-rollout-active')) {

              stage.style.aspectRatio = '16 / 9';

            }

          }

        }

      }

      updateRatioPitch();

      requestAnimationFrame(positionHudLayer);

      setTimeout(positionHudLayer, 100);

    }



    // --------------------------------------------------------------------------- //

    // meta fetch (duration + quality + size) via dashboard

    // --------------------------------------------------------------------------- //

    async function fetchMetaChunk(chunk) {

      const res = await bridgeFetch(`http://localhost:${state.port}/api/tester/batch-meta`, {

        method: 'POST',

        headers: { 'Content-Type': 'application/json' },

        body: JSON.stringify({ urls: chunk, metadata_only: true }),

        timeoutMs: 90000,

      });

      const data = await res.json().catch(() => ({}));

      if (res.ok && Array.isArray(data.results)) {

        for (const r of data.results) {

          if (!r || !r.url) continue;

          const prev = metaByUrl.get(r.url);

          const dur = Number(r.duration || 0);

          metaByUrl.set(r.url, {

            ok: !!r.ok, duration: dur, quality: r.quality || '',

            height: Number(r.height || 0), width: Number(r.width || 0),

            sizeBytes: Number(r.size_bytes || 0),

            bitrateBps: Number(r.bitrate_bps || 0),

            attempts: dur > 0 ? 0 : ((prev?.attempts || 0) + 1),

            ts: Date.now(),

          });

        }

      }

      // Count a failed attempt for every URL still missing a duration after this

      // chunk (covers URLs the server returned nothing for / a non-OK response).

      for (const u of chunk) {

        const m = metaByUrl.get(u);

        if (!m || !m.duration) {

          metaByUrl.set(u, Object.assign(

            { ok: false, duration: 0, quality: '', height: 0, width: 0, sizeBytes: 0, bitrateBps: 0 },

            m || {}, { attempts: (m?.attempts || 0) + (m ? 0 : 1) }));

        }

      }

      scheduleSaveMeta();   // persist successful probes for next time

    }



    async function fetchMeta(onlyFiltered) {

      if (metaFetching) { toast('Meta fetch already running…'); return; }

      if (connStatus !== 'online' && !(await detectPort())) {

        toast(`Dashboard offline on port ${state.port}.`, true); return;

      }

      const selectedInAlbum = items.filter((it) => selected.has(it.url));

      let pool = (onlyFiltered && selectedInAlbum.length > 0)

        ? selectedInAlbum

        : (items.length > 0 ? items : displayedItems());

      if (!pool || !pool.length) pool = items;

      if (!pool.length) {

        toast(_t('Na stránke sa nenašli žiadne položky na načítanie metadát.', 'No items found on page to fetch metadata.'), true); return;

      }

      if (!pool.map((it) => it.url).some(needsFetch)) {

        toast('Všetky položky už majú načítané trvanie.'); return;

      }



      metaFetching = true;

      try {

        // Auto-retry rounds: Bunkr rate-limits bursts, so a handful miss on the

        // first pass. Each round re-targets only the still-missing URLs (smaller

        // batches = less pressure), pausing briefly so the CDN cools down.

        for (let round = 1; round <= MAX_META_ROUNDS; round++) {

          const urls = pool.map((it) => it.url).filter(needsFetch);

          if (!urls.length) break;

          let done = 0;

          for (let i = 0; i < urls.length; i += META_CHUNK) {

            const chunk = urls.slice(i, i + META_CHUNK);

            setMetaState(`round ${round}: ${done}/${urls.length}…`);

            // eslint-disable-next-line no-await-in-loop

            await fetchMetaChunk(chunk);

            done += chunk.length;

            refresh();

          }

          const remaining = pool.map((it) => it.url).filter(needsFetch).length;

          if (!remaining) break;

          // brief cooldown before the next retry round

          // eslint-disable-next-line no-await-in-loop

          await new Promise((r) => setTimeout(r, 1200));

        }

        const withMeta = pool.filter((it) => metaByUrl.get(it.url)?.duration).length;

        const missing = pool.length - withMeta;

        setMetaState(`${withMeta}/${pool.length} have duration`);

        toast(missing

          ? `${withMeta}/${pool.length} timed — ${missing} couldn't be probed (non-MP4 or unavailable).`

          : `All ${withMeta} items timed.`);

      } catch (err) {

        setMetaState('fetch failed');

        toast(`Meta fetch failed: ${err.message || err}`, true);

      } finally {

        metaFetching = false;

        saveMetaCache();

        recordAlbum();

        syncPanel();

        compareWithDashboard();

      }

    }



    // --------------------------------------------------------------------------- //

    // import

    // --------------------------------------------------------------------------- //

    async function importUrls(urls, label) {

      if (!urls.length) { toast('Nothing selected to import.', true); return; }

      if (connStatus !== 'online' && !(await detectPort())) {

        toast(`Dashboard offline on port ${state.port}.`, true); return;

      }

      const chosenBatch = (state.batchName || '').trim() ||

        (document.querySelector(`#${PANEL_ID} [data-role="batchName"]`)?.value || '').trim() ||

        albumTitle();

      const byUrl = new Map(items.map((it) => [it.url, it]));

      const candidates = urls.map((url) => {

        const it = byUrl.get(url) || {};

        const m = metaByUrl.get(url) || {};

        const sizeBytes = m.sizeBytes || it.sizeBytes || 0;

        return {

          url,

          source_url: url,

          title: it.title || 'Bunkr file',

          thumbnail: it.thumb || '',

          duration: m.duration || 0,

          height: m.height || 0,

          width: m.width || 0,

          file_size_mb: sizeBytes ? Number((sizeBytes / (1024 ** 2)).toFixed(2)) : 0,

          source: 'bunkr',

          tags: ['bunkr'],

        };

      });

      toast(`Queuing ${candidates.length} item(s) to "${chosenBatch}" → port ${state.port}…`);

      try {

        const res = await bridgeFetch(`http://localhost:${state.port}/api/v1/intake/import`, {

          method: 'POST',

          headers: { 'Content-Type': 'application/json' },

          body: JSON.stringify({ batch_name: chosenBatch, candidates }),

          timeoutMs: 30000,   // this only has to enqueue the job now, not resolve every file

        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) throw new Error(data.detail || `Server ${res.status}`);

        const total = data.job?.total_items ?? candidates.length;

        toast(`Queued ${total} item(s) (${label}) — job #${data.job?.id ?? '?'}. Watch progress in the dashboard's Import Desk.`);

      } catch (err) {

        toast(`Import failed: ${err.message || err}`, true);

      }

    }



    function requestSidecar(items) {

      return new Promise((resolve) => {

        const requestId = `bks-sidecar-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        const timeout = window.setTimeout(() => {

          window.removeEventListener('message', onResult);

          resolve({ ok: false, error: 'Sidecar bridge did not respond. Reload Sidecar and this album page.' });

        }, 12000);

        function onResult(event) {

          if (event.source !== window || event.origin !== window.location.origin) return;

          const data = event.data;

          if (data?.type !== 'NEXUS_SIDECAR_RESULT' || data.requestId !== requestId) return;

          window.clearTimeout(timeout);

          window.removeEventListener('message', onResult);

          resolve(data.result || { ok: false, error: 'Empty Sidecar response' });

        }

        window.addEventListener('message', onResult);

        window.postMessage({

          type: 'NEXUS_SIDECAR_ENQUEUE',

          requestId,

          items,

          sourcePageUrl: window.location.href,

          playNow: false,

        }, window.location.origin);

      });

    }



    async function sendUrlsToSidecar(urls, label) {

      if (!urls.length) { toast('Nothing selected for Sidecar.', true); return; }

      const byUrl = new Map(items.map((it) => [it.url, it]));

      const sidecarItems = urls.map((url) => {

        const it = byUrl.get(url) || {};

        const m = metaByUrl.get(url) || {};

        const sizeBytes = m.sizeBytes || it.sizeBytes || 0;

        return {

          url,

          source_url: url,

          title: it.title || 'Bunkr file',

          thumbnail: it.thumb || '',

          duration: m.duration || 0,

          quality: m.height ? `${m.height}p` : '',

          sizeBytes,

        };

      });

      toast(`Sending ${sidecarItems.length} item(s) to Sidecar…`);

      const res = await requestSidecar(sidecarItems);

      if (!res?.ok) {

        toast(`Sidecar failed: ${res?.error || 'Unknown error'}`, true);

        return;

      }

      const duplicateText = res.duplicates ? `, ${res.duplicates} already queued` : '';

      toast(`Sidecar: added ${res.added || 0} / ${res.requested || sidecarItems.length}${duplicateText} (${label}).`);

    }



    async function copyDirectUrls(urls, label) {

      if (!urls.length) { toast('Nothing selected to copy.', true); return; }

      const backendDirect = new Map();

      try {

        if (connStatus !== 'online' && !(await detectPort())) {

          toast('Nexus dashboard is offline.', true);

          return;

        }

        const response = await bridgeFetch(`http://localhost:${state.port}/api/tester/batch-meta`, {

          method: 'POST',

          headers: { 'Content-Type': 'application/json' },

          body: JSON.stringify({ urls, metadata_only: false }),

          timeoutMs: 120000,

        });

        const data = await response.json().catch(() => ({}));

        for (const result of (data.results || [])) {

          const direct = cleanMediaUrl(result?.stream_url || result?.direct_url || '');

          if (result?.url && direct && !/preview|thumb|placeholder/i.test(direct)) {

            backendDirect.set(result.url, direct);

          }

        }

      } catch (err) {

        console.warn('[Bunkr Helper] backend direct URL resolve failed:', err);

      }



      const resolved = [];

      for (const url of urls) {

        try {

          // Prefer the same full-resolution backend path used by Nexus Import.

          const direct = backendDirect.get(url) || await resolveBunkrStreamUrl(url);

          const clean = cleanMediaUrl(direct);

          const isCanonicalMedia = clean

            && clean !== cleanMediaUrl(url)

            && !/preview|thumb|placeholder/i.test(clean);

          if (isCanonicalMedia) {

            resolved.push(clean);

          }

        } catch (err) {

          console.warn('[Bunkr Helper] direct URL resolve failed:', url, err);

        }

      }

      const exact = [...new Set(resolved.filter(Boolean))];

      if (!exact.length) {

        toast(`No direct MP4 URLs resolved for ${label}.`, true);

        return;

      }

      try {

        await navigator.clipboard.writeText(exact.join('\n'));

        toast(`Copied ${exact.length} direct MP4 URL(s) (${label}).`);

      } catch (err) {

        toast(`Copy failed: ${err.message || err}`, true);

      }

    }



    function cleanAlbumTitle(raw) {

      if (!raw) return '';

      let t = String(raw).trim();

      t = t.split(/[\r\n]+/)[0] || t;

      t = t.replace(/\s*\[[\d.,]+\s*[KMGTP]?B\].*$/i, '');

      t = t.replace(/\s*\b\d+\s+files?\b.*$/i, '');

      t = t.replace(/\s*[-–—|]?\s*\b\d+\s+views?\b.*$/i, '');

      t = t.replace(/\s*[-–—|]\s*(?:Bunkr|Balbums).*$/i, '');

      return t.replace(/\s+/g, ' ').trim();

    }



    function albumTitle() {

      let h = document.querySelector(`h1:not(#${PANEL_ID} h1), [class*="album"] h1`);

      if (!h) {

        const candidates = document.querySelectorAll('h1, h2, .truncate');

        for (const el of candidates) {

          if (el.closest(`#${PANEL_ID}`) || el.closest(CARD_SEL) || el.closest('.group') || el.closest('.grid-images') || el.closest('#galleryGrid')) continue;

          h = el;

          break;

        }

      }

      let t = '';

      if (h) {

        const attrTitle = cleanAlbumTitle(h.getAttribute('title') || '');

        const clone = h.cloneNode(true);

        clone.querySelectorAll('span, p, small, .text-sm, .text-xs, [class*="badge"]').forEach((s) => {

          if (/files|views|bytes|[kmgt]b/i.test(s.textContent)) s.remove();

        });

        const textTitle = cleanAlbumTitle(clone.textContent || '');

        if (textTitle.endsWith('...') && attrTitle && !attrTitle.endsWith('...')) {

          t = attrTitle;

        } else {

          t = attrTitle && attrTitle.length >= textTitle.length ? attrTitle : (textTitle || attrTitle);

        }

      }

      if (!t || t.toLowerCase() === 'album') {

        t = cleanAlbumTitle(document.title || '');

      }

      return t || 'Album';

    }



    function escapeHtml(str) {

      return String(str || '')

        .replace(/&/g, '&amp;')

        .replace(/</g, '&lt;')

        .replace(/>/g, '&gt;')

        .replace(/"/g, '&quot;')

        .replace(/'/g, '&#39;');

    }



    async function loadDashboardBatches() {

      if (connStatus !== 'online') return;

      try {

        const res = await bridgeFetch(`http://localhost:${state.port}/api/v1/batches?sort=name`, { timeoutMs: 8000 });

        if (res.ok) {

          const list = await res.json();

          if (Array.isArray(list)) {

            dashboardBatches = list.filter(Boolean);

            updateBatchDropdown();

          }

        }

      } catch (err) {

        console.warn('[Bunkr Helper] loading batches failed:', err);

      }

    }



    function updateBatchDropdown() {

      const panel = document.getElementById(PANEL_ID);

      if (!panel) return;

      const sel = panel.querySelector('[data-role="batchSelect"]');

      if (!sel) return;

      const currentVal = (state.batchName || '').trim();

      const options = ['<option value="">-- Vybrať existujúci batch (' + dashboardBatches.length + ') --</option>'];

      for (const b of dashboardBatches) {

        const selectedAttr = b === currentVal ? ' selected' : '';

        options.push(`<option value="${escapeHtml(b)}"${selectedAttr}>${escapeHtml(b)}</option>`);

      }

      sel.innerHTML = options.join('');

      const input = panel.querySelector('[data-role="batchName"]');

      if (input && !input.value) {

        input.value = currentVal || albumTitle();

        state.batchName = input.value;

      }

    }



    async function compareWithDashboard() {

      if (connStatus !== 'online' || compareRunning) return;

      const videoItems = items.filter(it => it.isVideo);

      if (!videoItems.length) return;



      compareRunning = true;

      try {

        const payloadItems = videoItems.map(it => {

          const m = metaByUrl.get(it.url) || it.meta || {};

          const sizeBytes = m.sizeBytes || it.sizeBytes || 0;

          return {

            url: it.url,

            title: it.title || '',

            size_bytes: sizeBytes,

            duration: m.duration || 0,

            height: m.height || heightOf(it) || 0,

            thumb: it.thumb || '',

          };

        });



        const res = await bridgeFetch(`http://localhost:${state.port}/api/v1/duplicates/compare-album`, {

          method: 'POST',

          headers: { 'Content-Type': 'application/json' },

          body: JSON.stringify({ items: payloadItems }),

          timeoutMs: 15000,

        });



        if (res.ok) {

          const data = await res.json().catch(() => ({}));

          if (Array.isArray(data.results)) {

            for (const r of data.results) {

              if (r && r.url) compareByUrl.set(r.url, r);

            }

            lastCompareTs = Date.now();

            injectOverlays();

            applyVisibility();

            syncPanel();

          }

        }

      } catch (err) {

        console.warn('[Bunkr Helper] compareWithDashboard failed:', err);

      } finally {

        compareRunning = false;

      }

    }



    async function replaceBetterWithDashboard() {

      if (connStatus !== 'online' && !(await detectPort())) {

        toast('Dashboard je offline.', true);

        return;

      }

      const betterCandidates = items.filter(it => {

        const cmp = compareByUrl.get(it.url);

        return cmp && cmp.status === 'better' && cmp.matched_video?.id;

      });

      const targets = selected.size

        ? betterCandidates.filter(it => selected.has(it.url))

        : betterCandidates;



      if (!targets.length) {

        toast(_t('Žiadne videá s lepšou kvalitou nie sú k dispozícii na nahradenie.', 'No videos with better quality are available for replacement.'), true);

        return;

      }



      toast(`Nahradzujem ${targets.length} videí v Nexuse novou lepšou verziou…`);

      try {

        const replacements = targets.map(it => {

          const cmp = compareByUrl.get(it.url);

          const m = metaByUrl.get(it.url) || it.meta || {};

          const sizeBytes = m.sizeBytes || it.sizeBytes || 0;

          return {

            existing_id: cmp.matched_video.id,

            url: it.url,

            source_url: it.url,

            title: it.title || cmp.matched_video.title,

            duration: m.duration || 0,

            height: m.height || heightOf(it) || 0,

            width: m.width || 0,

            file_size_mb: sizeBytes ? Number((sizeBytes / (1024 ** 2)).toFixed(2)) : 0,

            thumbnail: it.thumb || '',

          };

        });



        const res = await bridgeFetch(`http://localhost:${state.port}/api/v1/duplicates/replace`, {

          method: 'POST',

          headers: { 'Content-Type': 'application/json' },

          body: JSON.stringify({ replacements }),

          timeoutMs: 30000,

        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) throw new Error(data.detail || `Server ${res.status}`);



        for (const it of targets) {

          const cmp = compareByUrl.get(it.url);

          if (cmp) {

            cmp.status = 'replaced';

            cmp.reason = _t('Úspešne nahradené v Nexuse!', 'Successfully replaced in Nexus!');

          }

        }

        toast(_t(`Nahradených ${data.replaced_count || targets.length} videí v Nexuse novou lepšou verziou!`, `Replaced ${data.replaced_count || targets.length} videos in Nexus with a new better version!`));

        injectOverlays();

        syncPanel();

      } catch (err) {

        toast(_t(`Nahradenie zlyhalo: ${err.message || err}`, `Replacement failed: ${err.message || err}`), true);

      }

    }



    async function fetchUncertainMeta() {

      const uncertain = items.filter(it => compareByUrl.get(it.url)?.needs_probe && needsFetch(it.url));

      if (!uncertain.length) {

        toast('Všetky neisté videá už majú duration a kvalitu zmeranú.');

        return;

      }

      toast(`Overujem duration a kvalitu pre ${uncertain.length} neistých videí…`);

      for (let i = 0; i < uncertain.length; i += META_CHUNK) {

        const chunk = uncertain.slice(i, i + META_CHUNK).map(it => it.url);

        // eslint-disable-next-line no-await-in-loop

        await fetchMetaChunk(chunk);

        refresh();

      }

      await compareWithDashboard();

      toast('Overenie neistých videí dokončené.');

    }



    // --------------------------------------------------------------------------- //

    // panel UI

    // --------------------------------------------------------------------------- //

    function ensurePanel() {

      if (document.getElementById(PANEL_ID)) return;

      const panel = document.createElement('div');

      panel.id = PANEL_ID;

      panel.innerHTML = `

      <div class="bah-head">

        <span class="bah-led" data-role="conn-led" title="dashboard connection"></span>

        <span class="bah-title">Bunkr Helper</span>

        <button class="bah-mini" data-act="openInHub" title="Otvoriť výber v Discovery Hub" aria-label="Otvoriť v Discovery Hub" aria-expanded="false">🚀</button>

        <button class="bah-mini" data-act="autoconnect" title="Re-scan dashboard port">⟳</button>

        <button class="bah-mini" data-act="toggle" title="Collapse">–</button>

      </div>

      <div class="bah-hub-menu" data-role="hub-menu" hidden>
        <button type="button" data-act="openInHubFull">Celý album</button>
        <button type="button" data-act="openInHubVertical">Vertikálne videá <b data-role="hub-vertical-count">0</b></button>
        <button type="button" data-act="openInHubSelected">Označené položky <b data-role="hub-selected-count">0</b></button>
      </div>

      <div class="bah-body">

        <button class="bah-wide bah-split-play-btn" data-act="playSplitSelected">▶▶ Split-Screen (vyber 2+ videá)</button>

        <input class="bah-input" data-role="q" placeholder="Search files…">

        <div class="bah-sort-controls">
          <label>Sort by<select class="bah-input" data-role="sort-field">
            <option value="" disabled selected>Choose…</option>
            <option value="name">Name</option><option value="date">Date</option>
            <option value="size">Size</option><option value="duration">Duration</option>
            <option value="quality">Quality</option><option value="bitrate">Bitrate</option>
          </select></label>
          <label>Order<select class="bah-input" data-role="sort-direction">
            <option value="asc">Ascending ↑</option><option value="desc">Descending ↓</option>
          </select></label>
        </div>

        <div class="bah-row">

          <button data-toggle="videos">Videos only</button>

          <button data-toggle="onlyMatches" title="Skryť položky, ktoré nezodpovedajú aktívnym filtrom; výber nie je potrebný">Hide non-matches</button>

          <button data-toggle="hideDuplicates" title="Skryť duplikáty zistené porovnaním s dashboardom">Hide duplicates</button>

          <button data-toggle="onlyVertical" title="Filtrovať iba vertikálne videá (9:16)">Vertical (V)</button>

        </div>

        <div class="bah-grp" title="Každý náhľad si drží vlastný pomer. HD thumb len vymení ostrejší záber.">GRID · POMER STRÁN</div>

        <select class="bah-input" data-role="grid-cols" aria-label="Grid columns">
          <option value="-1">Auto</option><option value="0">Native</option>
          <option value="4">4 columns</option><option value="5">5 columns</option>
          <option value="6">6 columns</option><option value="7">7 columns</option>
          <option value="8">8 columns</option>
        </select>

        <div class="bah-grp">HD THUMBS</div>

        <div class="bah-row">

          <button data-hd="2x2">2×2</button>

          <button data-hd="1x">1 frame</button>

          <button data-hd="off">Off</button>

          <button class="bah-fetch-thumbs" data-act="fetchHdThumbs">Fetch HD</button>

        </div>

        <div class="bah-grp">QUALITY</div>

        <div class="bah-row bah-quals">

          <button data-qual="4K">4K</button><button data-qual="1080p">1080p</button>

          <button data-qual="720p">720p</button><button data-qual="480p">480p</button>

          <button data-qual="SD">SD</button>

        </div>

        <div class="bah-grp">DURATION (minutes)</div>

        <div class="bah-row">

          <input class="bah-num" data-role="durationMin" placeholder="Min e.g. 5">

          <input class="bah-num" data-role="durationMax" placeholder="Max e.g. 40">

        </div>

        <div class="bah-grp">SIZE (MB)</div>

        <div class="bah-row">

          <input class="bah-num" data-role="sizeMin" placeholder="Min e.g. 300">

          <input class="bah-num" data-role="sizeMax" placeholder="Max e.g. 1500">

        </div>

        <div class="bah-stats" data-role="stats">0 files</div>

        <button class="bah-wide" data-act="fetchmeta">Fetch durations & quality</button>



        <button class="bah-import" data-act="importSelected">Import selected →</button>

        <div class="bah-meta-state" data-role="meta-state">no metadata yet</div>

        <div class="bah-row">

          <button class="bah-half" data-act="selectFiltered">Select filtered</button>

          <button class="bah-half" data-act="selectVertical" title="Označiť všetky vertikálne položky">Select vertical (V)</button>

          <button class="bah-half" data-act="clear">Clear</button>

        </div>

        <div class="bah-grp">BATCH NAME</div>

        <input class="bah-input" data-role="batchName" placeholder="Zadaj alebo vyber batch…">

        <select class="bah-input bah-batch-select" data-role="batchSelect">

          <option value="">-- Vybrať existujúci batch --</option>

        </select>

        <div class="bah-grp">POROVNANIE S DASHBOARDOM</div>

        <div class="bah-row bah-compare-row">

          <button class="bah-comp-btn" data-comp-filter="better" title="Filtrovať videá s lepšou kvalitou ako v dashboarde">★ Lepšia (<span data-role="count-better">0</span>)</button>

          <button class="bah-comp-btn" data-comp-filter="duplicate" title="Filtrovať duplikáty">Duplikát (<span data-role="count-dupe">0</span>)</button>

          <button class="bah-comp-btn" data-comp-filter="worse" title="Filtrovať videá s horšou kvalitou ako v dashboarde">Horšia (<span data-role="count-worse">0</span>)</button>

        </div>

        <button class="bah-wide bah-replace-btn" data-act="replaceBetter" style="display:none;background:linear-gradient(135deg,#15803d,#22c55e);color:#fff;font-weight:700;margin-top:2px;">

          ⚡ Nahradiť horšie lepšími (<span data-role="count-replace">0</span>)

        </button>

        <button class="bah-wide bah-probe-uncertain" data-act="fetchUncertain" style="display:none;background:var(--bah-surface);color:#f59e0b;font-size:11px;border-color:rgba(245,158,11,.4);margin-top:2px;">

          ◷ Overiť duration & quality pre neisté (<span data-role="count-uncertain">0</span>)

        </button>

        <button class="bah-wide bah-yandex" data-act="yandexHD">🔍 Yandex HD Search (selected)</button>

        <button class="bah-wide ghost" data-act="importFiltered">Import all filtered →</button>

        <div class="bah-row">

          <button class="bah-half" data-act="sidecarSelected">Sidecar selected</button>

          <button class="bah-half" data-act="sidecarFiltered">Sidecar filtered grid</button>

        </div>

        <div class="bah-row">

          <button class="bah-wide bah-copy-direct" data-act="copyDirectSelected">COPY DIRECT URL</button>

        </div>

        <div class="bah-conn">

          port

          <select data-role="port-select">

            <option value="8000">8000</option>

            <option value="8001">8001</option>

            <option value="8002">8002</option>

            <option value="8003">8003</option>

          </select>

        </div>

      </div>`;

      document.body.appendChild(panel);



      // Bunkr may install a document-level pop-under handler that reacts to

      // clicks on its own controls. Keep helper actions isolated from page

      // click listeners.

      //

      // This MUST run in the bubble phase. A capture-phase listener fires on the

      // way down to the button, so stopping propagation there means the event

      // never reaches the button and never reaches panel's own delegated click

      // handler either — the entire panel goes dead to every click. In the

      // bubble phase the panel's handler has already run (same node, same phase,

      // and stopPropagation does not cancel the remaining listeners on that

      // node), and the event still never leaves the panel: exactly the isolation

      // that was wanted, without the dead panel.

      const isolateHelperClick = (event) => {

        event.stopPropagation();

      };

      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {

        panel.addEventListener(type, (event) => {

          const hit = event.target?.closest?.('button, input, select, textarea, a, [role="button"]');

          if (!hit) return;

          isolateHelperClick(event);

          // Only real links need their navigation cancelled. preventDefault on

          // mousedown/pointerdown would stop the search field from ever taking

          // focus — a text input cannot be typed into without it.

          if (type === 'click' && hit.tagName === 'A') event.preventDefault();

        });

      }



      panel.querySelector('[data-role="q"]').value = state.q;

      panel.querySelector('[data-role="durationMin"]').value = state.durationMin;

      panel.querySelector('[data-role="durationMax"]').value = state.durationMax;

      panel.querySelector('[data-role="sizeMin"]').value = state.sizeMin;

      panel.querySelector('[data-role="sizeMax"]').value = state.sizeMax;

      const bInput = panel.querySelector('[data-role="batchName"]');

      if (bInput) {

        if (!state.batchName) state.batchName = albumTitle();

        bInput.value = state.batchName;

      }



      panel.addEventListener('click', onPanelClick);

      const sortValues = {
        name: { asc: 'az', desc: 'za' }, date: { asc: 'dateOld', desc: 'dateNew' },
        size: { asc: 'sizeAsc', desc: 'sizeDesc' }, duration: { asc: 'durAsc', desc: 'durDesc' },
        quality: { asc: 'qualAsc', desc: 'qualDesc' }, bitrate: { asc: 'rateAsc', desc: 'rateDesc' },
      };
      const sortField = panel.querySelector('[data-role="sort-field"]');
      const sortDirection = panel.querySelector('[data-role="sort-direction"]');
      const updateSort = () => {
        const value = sortValues[sortField.value]?.[sortDirection.value];
        if (!value) return;
        state.sort = value; savePrefs(); refresh();
      };
      sortField.addEventListener('change', updateSort);
      sortDirection.addEventListener('change', updateSort);
      panel.querySelector('[data-role="grid-cols"]').addEventListener('change', (e) => {
        state.gridCols = Number(e.target.value); savePrefs(); applyGridMode(); syncPanel();
      });

      panel.querySelector('[data-role="q"]').addEventListener('input', (e) => {

        state.q = e.target.value; savePrefs(); applyVisibility(); syncPanel();

      });

      for (const k of ['durationMin', 'durationMax', 'sizeMin', 'sizeMax']) {

        panel.querySelector(`[data-role="${k}"]`).addEventListener('input', (e) => {

          state[k] = e.target.value; savePrefs(); refresh();

        });

      }

      panel.querySelector('[data-role="batchName"]')?.addEventListener('input', (e) => {

        batchNameUserEdited = true;

        state.batchName = e.target.value;

      });

      panel.querySelector('[data-role="batchSelect"]')?.addEventListener('change', (e) => {

        if (e.target.value) {

          batchNameUserEdited = true;

          state.batchName = e.target.value;

          const input = panel.querySelector('[data-role="batchName"]');

          if (input) input.value = e.target.value;

        }

      });

      panel.querySelector('[data-role="port-select"]')?.addEventListener('change', (e) => {

        state.port = Number(e.target.value);

        savePrefs();

        detectPort(true);

      });

      updateConnIndicator();

      updateBatchDropdown();

      syncPanel();

    }



    function onPanelClick(e) {

      const btn = e.target.closest('button');

      if (!btn) return;

      const toggle = btn.dataset.toggle;

      const qual = btn.dataset.qual;

      const hd = btn.dataset.hd;

      const act = btn.dataset.act;

      const compFilter = btn.dataset.compFilter;

      if (compFilter !== undefined) {

        state.compareFilter = state.compareFilter === compFilter ? 'all' : compFilter;

        savePrefs();

        applyVisibility();

        syncPanel();

        return;

      }

      if (hd !== undefined) {

        state.hdMode = hd;

        savePrefs();

        switchAllHdMode(hd);

        syncPanel();

        if (hd !== 'off') startHdUpgrade();

        return;

      }

      if (qual) {

        const i = state.qualities.indexOf(qual);

        if (i >= 0) state.qualities.splice(i, 1); else state.qualities.push(qual);

        savePrefs(); refresh(); return;

      }

      if (toggle === 'onlyVertical') { state.onlyVertical = !state.onlyVertical; savePrefs(); refresh(); return; }

      if (toggle === 'videos') { state.media = state.media === 'videos' ? 'all' : 'videos'; savePrefs(); refresh(); return; }

      if (toggle === 'onlyMatches') { state.onlyMatches = !state.onlyMatches; savePrefs(); refresh(); return; }

      if (toggle === 'hideDuplicates') { state.hideDuplicates = !state.hideDuplicates; savePrefs(); refresh(); return; }

      if (toggle === 'onlySelected') { state.onlySelected = !state.onlySelected; savePrefs(); refresh(); return; }

      if (act === 'toggle') {

        const panel = document.getElementById(PANEL_ID);

        const collapsed = panel.classList.toggle('bah-collapsed');

        document.body.classList.toggle('bks-helper-collapsed', collapsed);

        applyGridMode();

        requestAnimationFrame(placeHelperToggle);

        setTimeout(placeHelperToggle, 220);

        setTimeout(() => {

          updateRatioPitch();

          requestAnimationFrame(positionHudLayer);

        }, 240);

        return;

      }

      if (act === 'openInHub') {

        const menu = document.querySelector(`#${PANEL_ID} [data-role="hub-menu"]`);

        if (menu) {

          menu.hidden = !menu.hidden;

          btn.setAttribute('aria-expanded', String(!menu.hidden));

        }

        return;

      }

      if (['openInHubFull', 'openInHubVertical', 'openInHubSelected'].includes(act)) {

        const menu = document.querySelector(`#${PANEL_ID} [data-role="hub-menu"]`);

        if (menu) menu.hidden = true;

        document.querySelector(`#${PANEL_ID} [data-act="openInHub"]`)?.setAttribute('aria-expanded', 'false');

        if (act === 'openInHubFull') {

          const url = encodeURIComponent(window.location.href);

          window.open(`http://127.0.0.1:${state.port}/bunker?url=${url}`, '_blank');

          return;

        }

        const chosen = act === 'openInHubVertical'

          ? items.filter((it) => it.isVideo && it.isVertical)

          : items.filter((it) => selected.has(it.url));

        if (!chosen.length) {

          toast(act === 'openInHubVertical' ? 'Zatiaľ sa nenašli vertikálne videá.' : 'Najprv označ položky.');

          return;

        }

        if (chosen.length > 500) {

          toast('Do Discovery Hubu možno naraz odovzdať najviac 500 položiek.');

          return;

        }

        const payload = {

          version: 1,

          title: `${albumTitle()} · ${act === 'openInHubVertical' ? 'vertikálne videá' : 'označené položky'}`,

          files: chosen.map((it) => {

            const meta = it.meta || {};

            const aspectRatio = Number(it.el?.dataset?.bahOrigAr || 0);

            return {

              url: it.url,

              title: it.title || it.url.split('/').pop() || 'Bunkr súbor',

              thumbnail: it.thumb || '',

              type: it.isVideo ? 'video' : 'file',

              isVertical: Boolean(it.isVertical),

              aspect_ratio: aspectRatio || (Number(meta.width) > 0 && Number(meta.height) > 0 ? Number(meta.width) / Number(meta.height) : 0),

              width: Number(meta.width || 0),

              height: Number(meta.height || 0),

              duration: Number(meta.duration || meta.duration_sec || 0),

              size_bytes: Number(it.sizeBytes || 0),

              quality: meta.quality || '',

            };

          }),

        };

        try {

          const bytes = new TextEncoder().encode(JSON.stringify(payload));

          let binary = '';

          for (let offset = 0; offset < bytes.length; offset += 0x8000) {

            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));

          }

          const token = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

          const albumUrl = encodeURIComponent(window.location.href);

          window.open(`http://127.0.0.1:${state.port}/bunker?url=${albumUrl}#nexus-bunkr=${token}`, '_blank');

        } catch (error) {

          console.error('[Bunkr Suite] Discovery Hub handoff failed', error);

          toast('Výber sa nepodarilo odovzdať do Discovery Hubu.');

        }

        return;

      }

      if (act === 'autoconnect') { detectPort(true); return; }

      if (act === 'fetchmeta') {

        const hasSelection = items.some((it) => selected.has(it.url));

        fetchMeta(hasSelection);

        return;

      }

      if (act === 'fetchHdThumbs') { fetchHdThumbs(); return; }

      if (act === 'yandexHD') { yandexSearchSelected(); return; }

      if (act === 'replaceBetter') { replaceBetterWithDashboard(); return; }

      if (act === 'fetchUncertain') { fetchUncertainMeta(); return; }

      if (act === 'selectVertical') {

        selected.clear();

        items.filter((it) => it.isVertical).forEach((it) => selected.add(it.url));

        savePrefs();

        refresh();

        toast(`Vybraných ${selected.size} vertikálnych položiek.`);

        return;

      }

      if (act === 'playSplitSelected') {

        let urls = [...selected];

        if (urls.length < 2) {

          urls = displayedItems().filter((it) => it.isVideo).slice(0, 2).map((it) => it.url);

          if (urls.length >= 2) toast('Nič nebolo označené — spúšťam prvé 2 viditeľné videá.');

        }

        openSplitScreenPlayer(urls);

        return;

      }

      if (act === 'clear') { selected.clear(); savePrefs(); refresh(); return; }

      if (act === 'selectFiltered') {

        filteredItems().forEach((it) => selected.add(it.url)); savePrefs(); refresh(); return;

      }

      if (act === 'importSelected') { importUrls([...selected], 'selected'); return; }

      if (act === 'importFiltered') { importUrls(filteredItems().map((it) => it.url), 'filtered'); return; }

      if (act === 'sidecarSelected') { sendUrlsToSidecar([...selected], 'selected'); return; }

      if (act === 'sidecarFiltered') { sendUrlsToSidecar(filteredItems().map((it) => it.url), 'filtered grid'); return; }

      if (act === 'copyDirectSelected') { copyDirectUrls([...selected], 'selected'); return; }

      if (act === 'copyDirectFiltered') { copyDirectUrls(currentFetchPool().map((it) => it.url), 'current visible'); return; }

    }



    function syncPanel() {

      const panel = document.getElementById(PANEL_ID);

      if (!panel) return;

      if (!batchNameUserEdited) {

        const curTitle = albumTitle();

        if (curTitle && curTitle !== 'Album' && (!state.batchName || state.batchName === 'Album')) {

          state.batchName = curTitle;

          const bInput = panel.querySelector('[data-role="batchName"]');

          if (bInput && document.activeElement !== bInput) {

            bInput.value = curTitle;

          }

        }

      }

      const gridCols = panel.querySelector('[data-role="grid-cols"]');
      if (gridCols) gridCols.value = String(state.gridCols);

      const vertBtn = panel.querySelector('[data-toggle="onlyVertical"]');

      const vertCount = items.filter((it) => it.isVertical).length;

      if (vertBtn) {

        vertBtn.classList.toggle('on', Boolean(state.onlyVertical));

        vertBtn.textContent = `Vertical (V) [${vertCount}]`;

      }

      const selectVertBtn = panel.querySelector('[data-act="selectVertical"]');

      if (selectVertBtn) {

        selectVertBtn.textContent = `Select vertical [${vertCount}]`;

      }

      const verticalHandoffCount = panel.querySelector('[data-role="hub-vertical-count"]');

      if (verticalHandoffCount) verticalHandoffCount.textContent = String(items.filter((it) => it.isVideo && it.isVertical).length);

      const selectedHandoffCount = panel.querySelector('[data-role="hub-selected-count"]');

      if (selectedHandoffCount) selectedHandoffCount.textContent = String(items.filter((it) => selected.has(it.url)).length);

      panel.querySelector('[data-toggle="videos"]')?.classList.toggle('on', state.media === 'videos');

      panel.querySelector('[data-toggle="onlyMatches"]')?.classList.toggle('on', state.onlyMatches);

      panel.querySelector('[data-toggle="hideDuplicates"]')?.classList.toggle('on', state.hideDuplicates);

      panel.querySelector('[data-toggle="onlySelected"]')?.classList.toggle('on', state.onlySelected);

      panel.querySelectorAll('[data-qual]').forEach((b) =>

        b.classList.toggle('on', state.qualities.includes(b.dataset.qual)));

      panel.querySelectorAll('[data-hd]').forEach((b) =>

        b.classList.toggle('on', b.dataset.hd === state.hdMode));

      panel.querySelectorAll('[data-comp-filter]').forEach((b) =>

        b.classList.toggle('on', b.dataset.compFilter === (state.compareFilter || 'all')));



      let cntBetter = 0, cntDupe = 0, cntWorse = 0, cntUncertain = 0, cntReplace = 0;

      for (const it of items) {

        if (!it.isVideo) continue;

        const cmp = compareByUrl.get(it.url);

        if (!cmp) continue;

        if (cmp.status === 'better') {

          cntBetter++;

          if (cmp.matched_video?.id) cntReplace++;

        } else if (cmp.status === 'duplicate') {

          cntDupe++;

        } else if (cmp.status === 'worse') {

          cntWorse++;

        }

        if (cmp.needs_probe && needsFetch(it.url)) cntUncertain++;

      }



      const elBetter = panel.querySelector('[data-role="count-better"]');

      if (elBetter) elBetter.textContent = String(cntBetter);

      const elDupe = panel.querySelector('[data-role="count-dupe"]');

      if (elDupe) elDupe.textContent = String(cntDupe);

      const elWorse = panel.querySelector('[data-role="count-worse"]');

      if (elWorse) elWorse.textContent = String(cntWorse);

      const elReplace = panel.querySelector('[data-role="count-replace"]');

      if (elReplace) elReplace.textContent = String(cntReplace);

      const elUncertain = panel.querySelector('[data-role="count-uncertain"]');

      if (elUncertain) elUncertain.textContent = String(cntUncertain);



      const replaceBtn = panel.querySelector('[data-act="replaceBetter"]');

      if (replaceBtn) replaceBtn.style.display = cntReplace > 0 ? 'block' : 'none';

      const uncertainBtn = panel.querySelector('[data-act="fetchUncertain"]');

      if (uncertainBtn) uncertainBtn.style.display = cntUncertain > 0 ? 'block' : 'none';



      const filtered = filteredItems();

      const withMeta = items.filter((it) => metaByUrl.get(it.url)?.duration).length;

      panel.querySelector('[data-role="stats"]').textContent =

        `${filtered.length}/${items.length} files · ${selected.size} selected · ${withMeta} timed`;

      const portSel = panel.querySelector('[data-role="port-select"]');

      if (portSel) portSel.value = state.port;

      const imp = panel.querySelector('[data-act="importSelected"]');

      if (imp) imp.textContent = `Import selected (${selected.size}) →`;

      const splitBtn = panel.querySelector('[data-act="playSplitSelected"]');

      if (splitBtn) {

        splitBtn.style.display = 'block';

        splitBtn.textContent = selected.size >= 2 ? `▶▶ Prehrať vedľa seba (${selected.size} vybrané)` : "▶▶ Split-Screen (vyber 2+ videá / klik = prvé 2)";

      }

      syncFloatingSplitBar();

      // Reflect cached memory when not actively fetching.

      if (!metaFetching) {

        setMetaState(withMeta

          ? `${withMeta}/${items.length} timed (cached) · ${cachedAlbumCount()} albums remembered`

          : `no metadata yet · ${cachedAlbumCount()} albums remembered`);

      }



      document.body.classList.toggle('bah-single-selected', selected.size === 1);

    }

    function setMetaState(txt) {

      const el = document.querySelector(`#${PANEL_ID} [data-role="meta-state"]`);

      if (el) el.textContent = txt;

    }



    // --------------------------------------------------------------------------- //

    // Video Player Modal

    // --------------------------------------------------------------------------- //

    // Video Player Modal

    // --------------------------------------------------------------------------- //

    const videoSrcCache = {};

    const videoSrcPending = new Map();

    let resolvingStreams = 0;const streamWaiters = [];

    async function getVideoSrc(url) {

      // /f and /v are two views of the same file. One request per file at a time.

      const key = new URL(url, location.href).pathname.replace(/^\/v\//, '/f/');

      const canonical = new URL(key, location.origin).href;

      if (videoSrcPending.has(canonical)) return videoSrcPending.get(canonical);

      const pending = (async () => {

        if (resolvingStreams >= 4) await new Promise(resolve => streamWaiters.push(resolve));

        else resolvingStreams++;

        try { return await getVideoSrcUncached(canonical); }

        finally { const next=streamWaiters.shift();if(next)next();else resolvingStreams--; }

      })();

      videoSrcPending.set(canonical, pending);

      try { return await pending; } finally { videoSrcPending.delete(canonical); }

    }

    document.addEventListener('nexus-bunkr-resolve', async e => {

      let request;

      try {

        request = JSON.parse(e.detail);

        const url = new URL(request.url, location.href);

        if (url.origin !== location.origin || !/^\/[fv]\//.test(url.pathname)) return;

        const direct = await getVideoSrc(url.href);

        document.dispatchEvent(new CustomEvent('nexus-bunkr-resolved', { detail: JSON.stringify({ requestId:request.requestId, url:direct || '' }) }));

      } catch { if (request) document.dispatchEvent(new CustomEvent('nexus-bunkr-resolved', { detail: JSON.stringify({requestId:request.requestId,url:''}) })); }

    });

    document.documentElement.dataset.nexusBunkrResolver = 'ready';

    const warmQueue = new Set();let warming = 0;

    function warmStream(url) {

      if (!url || document.querySelector('#nuss-overlay[style*="flex"],.bah-split-modal[style*="flex"]')) return;

      if (warmQueue.size >= 12) return;

      warmQueue.add(url);drainWarmStreams();

    }

    function drainWarmStreams() {

      while (warming < 3 && warmQueue.size) {

        const url = warmQueue.values().next().value;warmQueue.delete(url);warming++;

        getVideoSrc(url).catch(()=>{}).finally(()=>{warming--;drainWarmStreams();});

      }

    }

    document.addEventListener('change', e => {

      if (!e.target.matches('.bah-cb,.nexus-bunkr-checkbox') || !e.target.checked) return;

      warmStream(e.target.closest('.bah-card')?.querySelector('a[href*="/f/"],a[href*="/v/"]')?.href);

    });

    let warmHoverTimer;

    document.addEventListener('pointerover', e => {

      const card = e.target.closest?.('.bah-card');if (!card || card.contains(e.relatedTarget)) return;

      clearTimeout(warmHoverTimer);warmHoverTimer = setTimeout(()=>warmStream(card.querySelector('a[href*="/f/"],a[href*="/v/"]')?.href),120);

    },{passive:true});

    document.addEventListener('nexus-split-ready',()=>floatingSplitBar?.classList.remove('is-visible'));





    function decodeBunkrVsUrl(encUrl, timestamp) {

      try {

        const raw = atob(encUrl);

        const ts = Number(timestamp || Date.now() / 1000);

        const key = `SECRET_KEY_${Math.floor(ts / 3600)}`;

        let out = '';

        for (let i = 0; i < raw.length; i++) {

          out += String.fromCharCode(raw.charCodeAt(i) ^ key.charCodeAt(i % key.length));

        }

        return out;

      } catch {

        return null;

      }

    }



    function isMediaStreamUrl(u) {

      if (!u || typeof u !== 'string') return false;

      const low = u.toLowerCase();

      if (low.startsWith('blob:') || low.startsWith('data:') || low.includes('video.svg') || low.includes('placeholder')) return false;

      if (/\.(mp4|mkv|mov|webm|m4v|avi|m3u8)(\?|$)/i.test(low)) return true;

      if (low.includes('media-files') || low.includes('scdn.st') || low.includes('get.bunkr')) return true;

      return false;

    }



    function cleanMediaUrl(u) {

      if (!u) return '';

      // The signing endpoint can return a JSON-escaped URL such as

      // https:\\cdn... or https:\/\/cdn... .  Such a value is invalid when

      // pasted as a video source into the extension player.

      let clean = String(u)

        .trim()

        .replace(/^['"]+|['"]+$/g, '')

        .replace(/\\u0026/gi, '&')

        .replace(/\\\//g, '/')

        .replace(/\\/g, '/')

        .replace(/&amp;/gi, '&');

      if (clean.startsWith('//')) clean = 'https:' + clean;

      try {

        const parsed = new URL(clean);

        return /^https?:$/i.test(parsed.protocol) ? parsed.href : '';

      } catch {

        return '';

      }

    }





    // Dynamic DNS Prefetch and Preconnect for Ultra-Low-Latency CDN requests

    function injectCdnPreconnect(cdnUrl) {

      if (!cdnUrl) return;

      try {

        const origin = new URL(cdnUrl).origin;

        if (document.head.querySelector(`link[href="${origin}"]`)) return;

        const preconnect = document.createElement('link');

        preconnect.rel = 'preconnect';

        preconnect.href = origin;

        const prefetch = document.createElement('link');

        prefetch.rel = 'dns-prefetch';

        prefetch.href = origin;

        document.head.appendChild(preconnect);

        document.head.appendChild(prefetch);

      } catch {}

    }



    // Bunkr CDN URLs (jsCDN) are only playable once signed with token + ex.

    async function signCdnUrl(rawCdnUrl, signEndpoint) {

      const endpoint = signEndpoint || 'https://glb-apisign.cdn.cr/sign';

      const orig = new URL(cleanMediaUrl(rawCdnUrl));

      if (orig.searchParams.get('token')) return orig.toString();

      const path = decodeURIComponent(orig.pathname);

      const signReq = `${endpoint}?path=${encodeURIComponent(path)}`;

      let data = null;

      try {

        const r = await fetch(signReq, { credentials: 'omit' });

        if (r.ok) data = await r.json();

      } catch { /* fall back to GM request */ }

      if (!data?.token) {

        const r = await bridgeFetch(signReq, { headers: { Accept: 'application/json', Referer: location.origin + '/' }, timeoutMs: 10000 });

        if (r.ok) data = await r.json();

      }

      if (!data?.token) throw new Error('CDN sign failed');

      orig.searchParams.set('token', data.token);

      if (data.ex) orig.searchParams.set('ex', data.ex);

      return orig.toString();

    }



    // Album and archive modules have separate scopes. Keep the canonical API

    // resolver in this module too, rather than silently skipping an undefined one.

    async function resolveBunkrStreamUrl(videoPageUrl) {

      const parsed = new URL(videoPageUrl, location.href);

      if (!/^\/(?:f|v)\//i.test(parsed.pathname)) return null;

      const slug = parsed.pathname.split('/')[2];

      const bareSlug = slug.replace(/\.(mp4|mkv|mov|webm|m4v|avi|ts)$/i, '');

      for (const candidate of new Set([bareSlug, slug])) {

        const response = await bridgeFetch(`${parsed.origin}/api/vs`, {

          method: 'POST',

          headers: { 'Content-Type': 'application/json', Accept: 'application/json', Referer: videoPageUrl },

          body: JSON.stringify({ slug: candidate }),

          timeoutMs: 8000,

        });

        if (!response.ok) continue;

        const data = await response.json();

        const raw = data?.encrypted ? decodeBunkrVsUrl(data.url, data.timestamp) : data?.url;

        const url = cleanMediaUrl(raw);

        if (url && isMediaStreamUrl(url)) return url;

      }

      return null;

    }



    async function getVideoSrcUncached(videoPageUrl) {

      const cached = videoSrcCache[videoPageUrl];

      if (cached) {

        try {

          const expiry = Number(new URL(cached).searchParams.get('ex'));

          if (!expiry || expiry * 1000 > Date.now() + 60000) return cached;

        } catch { /* Resolve an invalid cached URL again. */ }

        delete videoSrcCache[videoPageUrl];

      }



      // Prefer the canonical Bunkr /api/vs resolver first. This is the same

      // endpoint the player uses to generate the real signed mp4 CDN URL and it

      // avoids returning the intermediate HTML page / landing URL that fails in

      // the copy-direct flow.

      try {

        const viaVs = await resolveBunkrStreamUrl(videoPageUrl);

        if (viaVs && isMediaStreamUrl(viaVs)) {

          const url = cleanMediaUrl(viaVs);

          if (url) {

            videoSrcCache[videoPageUrl] = url;

            return url;

          }

        }

      } catch (e) {

        console.warn('[Bunkr Helper] /api/vs resolution failed:', e);

      }



      const parsed = new URL(videoPageUrl, location.href);

      const pathParts = parsed.pathname.split('/').filter(Boolean);

      if (pathParts.length >= 2 && (pathParts[0] === 'f' || pathParts[0] === 'v')) {

        const slug = pathParts[1].replace(/\.(mp4|mkv|mov|webm|m4v|avi)$/i, '');



        // Method 1: Bunkr active /api/sign?v=<slug> endpoint (returns signed CDN mp4 url)

        try {

          const signUrl = `${parsed.origin}/api/sign?v=${encodeURIComponent(slug)}`;

          const res = await bridgeFetch(signUrl, {

            method: 'GET',

            headers: {

              'Accept': 'application/json',

              'Referer': videoPageUrl,

            },

            timeoutMs: 8000,

          });

          if (res.ok) {

            const data = await res.json();

            if (data?.url) {

              const url = cleanMediaUrl(data.url);

              videoSrcCache[videoPageUrl] = url;

              return url;

            }

          }

        } catch (e) {

          console.warn('[Bunkr Helper] /api/sign GET failed:', e);

        }



        // Method 1b: /api/sign POST fallback

        try {

          const signRes = await bridgeFetch(`${parsed.origin}/api/sign`, {

            method: 'POST',

            headers: {

              'Content-Type': 'application/json',

              'Accept': 'application/json',

              'Referer': videoPageUrl,

              'Origin': parsed.origin,

            },

            body: JSON.stringify({ v: slug, slug }),

            timeoutMs: 8000,

          });

          if (signRes.ok) {

            const data = await signRes.json();

            if (data?.url) {

              const url = cleanMediaUrl(data.url);

              videoSrcCache[videoPageUrl] = url;

              return url;

            }

          }

        } catch (e) {

          console.warn('[Bunkr Helper] /api/sign POST failed:', e);

        }

      }



      // Method 2: HTML page fetch parsing via bridgeFetch

      try {

        const res = await bridgeFetch(videoPageUrl, {

          headers: {

            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',

            'Referer': location.origin + '/',

          },

          timeoutMs: 12000,

        });

        const html = await res.text();



        // Candidate 1: jsCDN variable

        const jsCdnMatch = html.match(/jsCDN\s*[:=]\s*["']([^"']+)["']/i) || html.match(/["']jsCDN["']\s*:\s*["']([^"']+)["']/i);

        if (jsCdnMatch && jsCdnMatch[1] && isMediaStreamUrl(jsCdnMatch[1])) {

          const signMatch0 = html.match(/signUrl\s*[:=]\s*["']([^"']+)["']/i);

          const signEp = signMatch0 && /^https?:/i.test(signMatch0[1].replace(/\\\//g, '/')) ? signMatch0[1].replace(/\\\//g, '/') : '';

          let url = cleanMediaUrl(jsCdnMatch[1]);

          try { url = await signCdnUrl(url, signEp); } catch (e) { console.warn('[Bunkr Helper] CDN sign failed:', e); }

          videoSrcCache[videoPageUrl] = url;

          return url;

        }



        // Candidate 2: signUrl variable

        const signUrlMatch = html.match(/signUrl\s*[:=]\s*["']([^"']+)["']/i) || html.match(/["']signUrl["']\s*:\s*["']([^"']+)["']/i);

        if (signUrlMatch && signUrlMatch[1] && isMediaStreamUrl(signUrlMatch[1])) {

          const url = cleanMediaUrl(signUrlMatch[1]);

          videoSrcCache[videoPageUrl] = url;

          return url;

        }



        // Candidate 3: <video> or <source> src

        const srcMatch = html.match(/<source[^>]+src=["']([^"']+)["']/i) || html.match(/<video[^>]+src=["']([^"']+)["']/i);

        if (srcMatch && srcMatch[1] && isMediaStreamUrl(srcMatch[1])) {

          const url = cleanMediaUrl(srcMatch[1]);

          videoSrcCache[videoPageUrl] = url;

          return url;

        }



        // Candidate 4: Any direct CDN url regex

        const directMatch = html.match(/["'](https?:\/\/[^"'\s]+\.(?:mp4|mkv|mov|webm|m4v|avi)(?:\?[^"'\s]*)?)["']/i)

          || html.match(/["'](https?:\/\/[^"'\s]+?(?:media-files|scdn\.st|get\.bunkr)[^"'\s]*)["']/i);

        if (directMatch && directMatch[1]) {

          const url = cleanMediaUrl(directMatch[1]);

          videoSrcCache[videoPageUrl] = url;

          return url;

        }

      } catch (e) {

        console.error('[Bunkr Helper] HTML fetch error:', e);

      }



      return null;

    }



    let playerModal = null;

    let playerRequestId = 0;

    let playerIframeTimer = null;



    async function openVideoPlayer(pageUrl) {

      closeVideoPlayer();

      const requestId = playerRequestId;

      const isCurrent = () => requestId === playerRequestId;

      if (!playerModal) {

        playerModal = document.createElement('div');

        playerModal.className = 'bah-player-modal';

        playerModal.innerHTML = `

        <div class="bah-player-container">

          <div class="bah-player-bar">

            <span class="bah-player-title">▶ Prehrávač videa</span>

            <div class="bah-player-actions">

              <a class="bah-player-btn-link bah-player-download" target="_blank" download rel="noopener" title="Stiahnuť video súbor">⬇ Stiahnuť MP4</a>

              <a class="bah-player-btn-link bah-player-page-link" target="_blank" rel="noopener" title="Otvoriť samostatnú stránku videa">↗ Otvoriť stránku</a>

              <div class="bah-player-close" title="Zatvoriť (Esc)">&times;</div>

            </div>

          </div>

          <div class="bah-player-body">

            <div class="bah-player-loader">Zisťujem video stream...</div>

            <video class="bah-player-video" controls autoplay playsinline preload="auto"></video>

            <iframe class="bah-player-iframe" allow="autoplay *; encrypted-media *; fullscreen *; picture-in-picture *" referrerpolicy="origin" style="display:none;"></iframe>

          </div>

        </div>

      `;

        document.body.appendChild(playerModal);



        playerModal.querySelector('.bah-player-close').addEventListener('click', closeVideoPlayer);

        playerModal.addEventListener('click', (e) => {

          if (e.target === playerModal) closeVideoPlayer();

        });

        document.addEventListener('keydown', (e) => {

          if (e.key === 'Escape' && playerModal.style.display === 'flex') {

            closeVideoPlayer();

          }

        });

      }



      playerModal.style.display = 'flex';

      const video = playerModal.querySelector('.bah-player-video');

      const iframe = playerModal.querySelector('.bah-player-iframe');

      const loader = playerModal.querySelector('.bah-player-loader');

      const downloadBtn = playerModal.querySelector('.bah-player-download');

      const pageBtn = playerModal.querySelector('.bah-player-page-link');



      if (pageBtn) pageBtn.href = pageUrl;

      if (downloadBtn) downloadBtn.style.display = 'none';



      video.style.display = 'none';

      iframe.style.display = 'none';

      iframe.src = 'about:blank';

      video.pause();

      video.onerror = null;

      video.removeAttribute('src');

      video.load();

      loader.style.display = 'block';

      loader.textContent = 'Zisťujem video stream...';



      // Step 1: Resolve stream URL

      const streamUrl = await getVideoSrc(pageUrl);

      if (!isCurrent()) return;



      if (streamUrl) {

        if (downloadBtn) {

          downloadBtn.href = streamUrl;

          downloadBtn.style.display = 'inline-flex';

        }



        // Try direct playback first

        video.style.display = 'block';

        loader.style.display = 'none';

        injectCdnPreconnect(streamUrl);

        video.onerror = () => switchToIframePlayer(pageUrl);

        video.src = streamUrl;



        // Handle unmuted vs muted autoplay policy

        try {

          await video.play();

        } catch (error) {

          if (!isCurrent() || error.name !== 'NotAllowedError') return;

          video.muted = true;

          try { await video.play(); } catch { /* Controls remain available. */ }

        }



      } else {

        switchToIframePlayer(pageUrl);

      }



      function switchToIframePlayer(targetUrl) {

        if (!isCurrent()) return;

        video.onerror = null;

        video.pause();

        video.removeAttribute('src');

        video.load();

        loader.style.display = 'none';

        video.style.display = 'none';

        iframe.style.display = 'block';

        let playerUrl = targetUrl;

        if (playerUrl.includes('/f/')) {

          playerUrl = playerUrl.replace('/f/', '/v/');

        }



        iframe.onload = () => {

          if (!isCurrent()) return;

          const cleanIframe = () => {

            if (!isCurrent()) return;

            try {

              const doc = iframe.contentDocument || iframe.contentWindow?.document;

              if (!doc) return;



              if (!doc.getElementById('bah-clean-iframe')) {

                const style = doc.createElement('style');

                style.id = 'bah-clean-iframe';

                style.textContent = `

                header, footer, nav, aside,

                .bks-clean-topbar, .bks-redirect-banner-hidden,

                [class*="banner"], [class*="bg-red"], [class*="bg-rose"], [class*="bg-danger"],

                .sidebar, .comments, .navbar, #header, #footer {

                  display: none !important;

                }

                html, body {

                  background: #000 !important;

                  margin: 0 !important;

                  padding: 0 !important;

                  overflow: hidden !important;

                  width: 100vw !important;

                  height: 100vh !important;

                }

              `;

                (doc.head || doc.documentElement).appendChild(style);

              }



              const v = doc.querySelector('video');

              if (v) {

                const wrapper = v.closest('.plyr, .video-container, .theVideo') || v;

                wrapper.style.setProperty('position', 'fixed', 'important');

                wrapper.style.setProperty('top', '0', 'important');

                wrapper.style.setProperty('left', '0', 'important');

                wrapper.style.setProperty('width', '100vw', 'important');

                wrapper.style.setProperty('height', '100vh', 'important');

                wrapper.style.setProperty('max-width', 'none', 'important');

                wrapper.style.setProperty('max-height', 'none', 'important');

                wrapper.style.setProperty('z-index', '2147483647', 'important');

                wrapper.style.setProperty('background', '#000', 'important');

                wrapper.style.setProperty('display', wrapper.style.display === 'none' ? 'block' : '', 'important');



                if (v.paused) {

                  v.muted = false;

                  v.play().catch(() => {

                    v.muted = true;

                    v.play().catch(() => { });

                  });

                }

              } // Close if (v)

            } catch (e) {

              /* ignore cross-origin if any */

            }

          };



          cleanIframe();

          clearInterval(playerIframeTimer);

          let attempts = 0;

          playerIframeTimer = setInterval(() => {

            attempts++;

            cleanIframe();

            if (!isCurrent() || attempts >= 12) clearInterval(playerIframeTimer);

          }, 250);

        };



        iframe.src = playerUrl;

      }

    }



    function closeVideoPlayer() {

      playerRequestId++;

      clearInterval(playerIframeTimer);

      playerIframeTimer = null;

      if (playerModal) {

        playerModal.style.display = 'none';

        const video = playerModal.querySelector('.bah-player-video');

        const iframe = playerModal.querySelector('.bah-player-iframe');

        if (video) {

          video.pause();

          video.onerror = null;

          video.removeAttribute('src');

          video.load();

        }

        if (iframe) { iframe.onload = null; iframe.src = 'about:blank'; }

      }

    }



    // --------------------------------------------------------------------------- //

    // Split-Screen Multi-Video Player (vedľa seba)

    // --------------------------------------------------------------------------- //

    let splitModal = null;

    let splitLayoutMode = 'auto'; // 'auto' | 'row' | 'grid2' | 'grid3'

    let splitFitMode = 'contain'; // 'contain' | 'cover'

    let splitDiagVisible = false;

    let splitDiagTimer = null;

    let floatingSplitBar = null;



    function syncFloatingSplitBar() {

      const selVideos = [...selected].filter((u) => {

        const it = items.find((x) => x.url === u);

        return it ? it.isVideo : true;

      });

      if (selVideos.length < 2) {

        if (floatingSplitBar) floatingSplitBar.classList.remove('is-visible');

        return;

      }

      if (document.documentElement.dataset.nexusSplitReady === '1') { floatingSplitBar?.classList.remove('is-visible'); return; }

      if (!floatingSplitBar) {

        floatingSplitBar = document.createElement('div');

        floatingSplitBar.className = 'bah-floating-split-bar';

        floatingSplitBar.innerHTML = `

          <span class="bah-fsb-badge" data-role="fsb-count">0</span>

          <button class="bah-fsb-play" data-act="fsb-play">▶▶ Spustiť Split-Screen (vedľa seba)</button>

          <button class="bah-fsb-clear" data-act="fsb-clear" title="Zrušiť výber">&times;</button>

        `;

        document.body.appendChild(floatingSplitBar);

        const isolateFloatingClick = (event) => {

          if (!event.target?.closest?.('button')) return;

          event.preventDefault();

          event.stopPropagation();

          event.stopImmediatePropagation?.();

        };

        for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {

          floatingSplitBar.addEventListener(type, isolateFloatingClick, true);

        }

        floatingSplitBar.querySelector('[data-act="fsb-play"]').addEventListener('click', () => {

          openSplitScreenPlayer([...selected]);

        });

        floatingSplitBar.querySelector('[data-act="fsb-clear"]').addEventListener('click', () => {

          selected.clear();

          savePrefs();

          refresh();

        });

      }

      const badge = floatingSplitBar.querySelector('[data-role="fsb-count"]');

      if (badge) badge.textContent = `${selVideos.length} vybrané`;

      floatingSplitBar.classList.add('is-visible');

    }



    function computeSplitGridTemplate(count, mode) {

      if (count <= 1) return { cols: 1, rows: 1 };

      if (mode === 'row') return { cols: count, rows: 1 };

      if (mode === 'grid2') return { cols: 2, rows: Math.ceil(count / 2) };

      if (mode === 'grid3') return { cols: 3, rows: Math.ceil(count / 3) };

      // Auto mode:

      const allVert = document.body.classList.contains('bah-only-vertical');

      if (allVert && count <= 5) return { cols: count, rows: 1 };

      if (count === 2) return { cols: 2, rows: 1 };

      if (count === 3) return { cols: 3, rows: 1 };

      if (count === 4) return { cols: 2, rows: 2 };

      if (count <= 6) return { cols: 3, rows: 2 };

      if (count <= 9) return { cols: 3, rows: 3 };

      return { cols: 4, rows: Math.ceil(count / 4) };

    }



    function applySplitGridLayout() {

      if (!splitModal) return;

      const stage = splitModal.querySelector('.bah-split-stage');

      if (!stage) return;

      const cells = [...stage.querySelectorAll('.bah-split-cell')];

      const count = cells.length;

      const { cols, rows } = computeSplitGridTemplate(count, splitLayoutMode);

      stage.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;

      stage.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;

      stage.dataset.fit = splitFitMode;

      splitModal.querySelectorAll('[data-split-layout]').forEach((b) => {

        b.classList.toggle('is-active', b.dataset.splitLayout === splitLayoutMode);

      });

      const fitBtn = splitModal.querySelector('[data-split-act="toggleFit"]');

      if (fitBtn) {

        fitBtn.textContent = splitFitMode === 'contain' ? '⛶ Fit: Celé' : '⛶ Fit: Výplň';

      }

      const titleEl = splitModal.querySelector('.bah-split-title');

      if (titleEl) {

        titleEl.textContent = `▶▶ Split-Screen Prehrávač (${count} ${count === 1 ? 'video' : count < 5 ? 'videá' : 'videí'} vedľa seba)`;

      }

    }



    function closeSplitScreenPlayer() {

      if (splitDiagTimer) { clearInterval(splitDiagTimer); splitDiagTimer = null; }

      if (!splitModal) return;

      splitModal.style.display = 'none';

      splitModal.querySelectorAll('.bah-split-cell').forEach((c) => {

        if (c._bahTurbo) { c._bahTurbo.destroy(); c._bahTurbo = null; }

      });

      splitModal.querySelectorAll('video').forEach((v) => {

        try { v.onerror = null; v.pause(); v.removeAttribute('src'); v.load(); } catch {}

      });

      splitModal.querySelectorAll('iframe').forEach((f) => {

        try { f.src = 'about:blank'; } catch {}

      });

      const stage = splitModal.querySelector('.bah-split-stage');

      if (stage) stage.innerHTML = '';

    }





    // --------------------------------------------------------------------------- //

    // Native progressive playback and signed-URL refresh bookkeeping.

    // --------------------------------------------------------------------------- //

    class BunkrTurboStreamer {

      constructor(videoEl, initialUrl, pageUrl) {

        this.video = videoEl;

        this.currentUrl = initialUrl;

        this.pageUrl = pageUrl;

        this.isDestroyed = false;

        this.tokenRefreshTimer = null;

      }



      start() {

        if (this.isDestroyed) return;

        injectCdnPreconnect(this.currentUrl);

        this.scheduleTokenRefresh();

        // Native progressive playback: attach error handlers before calling start.

        // Do not wait for metadata before play(); it postpones network priority.

        this.video.src = this.currentUrl;

      }



      scheduleTokenRefresh() {

        try {

          const u = new URL(this.currentUrl);

          const ex = Number(u.searchParams.get('ex'));

          if (ex) {

            const nowSec = Math.floor(Date.now() / 1000);

            const refreshInSec = Math.max(30, (ex - nowSec) - 120); // 2 minutes before expiry

            this.tokenRefreshTimer = setTimeout(async () => {

              if (this.isDestroyed) return;

              try {

                delete videoSrcCache[this.pageUrl];

                const refreshed = await getVideoSrc(this.pageUrl);

                if (this.isDestroyed) return;

                if (refreshed && refreshed !== this.currentUrl) {

                  this.currentUrl = refreshed;

                  injectCdnPreconnect(refreshed);

                  // Update download link silently

                  const cell = this.video.closest('.bah-split-cell');

                  const dl = cell?.querySelector('.bah-split-dl');

                  if (dl) dl.href = refreshed;

                }

              } catch (e) {

                console.warn('[Bunkr Turbo] Token refresh warning:', e);

              }

              if (!this.isDestroyed) this.scheduleTokenRefresh();

            }, refreshInSec * 1000);

          }

        } catch {}

      }



      destroy() {

        this.isDestroyed = true;

        clearTimeout(this.tokenRefreshTimer);

      }

    }



    async function loadSplitCellStream(cell, pageUrl, index) {

      const video = cell.querySelector('.bah-split-video');

      const iframe = cell.querySelector('.bah-split-iframe');

      const loader = cell.querySelector('.bah-split-loader');

      const dlBtn = cell.querySelector('.bah-split-dl');

      const isCurrent = () => cell.isConnected;

      loader.style.display = 'flex';

      loader.textContent = 'Zisťujem video stream…';

      video.style.display = 'none';

      iframe.style.display = 'none';



      let handedOff = false;

      const switchCellToIframe = () => {

        if (!isCurrent() || handedOff) return;

        handedOff = true;

        video.onerror = null;

        cell._bahTurbo?.destroy();

        cell._bahTurbo = null;

        video.pause();

        video.removeAttribute('src');

        video.load();

        loader.style.display = 'none';

        video.style.display = 'none';

        iframe.style.display = 'block';

        iframe.src = pageUrl.replace(/\/f\//i, '/v/');

      };



      let streamUrl = await getVideoSrc(pageUrl);

      for (let attempt = 1; !streamUrl && attempt <= 2 && isCurrent(); attempt++) {

        loader.textContent = `Zisťujem video stream… (pokus ${attempt + 1}/3)`;

        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));

        if (!isCurrent()) return;

        delete videoSrcCache[pageUrl];

        streamUrl = await getVideoSrc(pageUrl);

      }

      if (!isCurrent()) return;

      if (!streamUrl) { switchCellToIframe(); return; }



      if (dlBtn) { dlBtn.href = streamUrl; dlBtn.style.display = 'inline-flex'; }

      video.style.display = 'block';

      video.muted = index > 0;

      updateCellMuteBtn(cell, video.muted);

      let stalls = 0;

      video.addEventListener('waiting', () => {

        if (video.seeking || video.paused || video.currentTime === 0) return;

        stalls++;

        const el = cell.querySelector('[data-diag="stalls"]');

        if (el) { el.textContent = String(stalls); el.className = 'bah-diag-val is-warn'; }

      });

      video.addEventListener('playing', () => { loader.style.display = 'none'; });

      // Per-video byte throughput is unavailable without CDN timing permission.

      // Buffer duration is not a byte counter (especially after seeks / VBR).

      const speedEl = cell.querySelector('[data-diag="speed"]');

      if (speedEl) speedEl.textContent = 'N/A';

      video.onerror = switchCellToIframe;

      const streamer = new BunkrTurboStreamer(video, streamUrl, pageUrl);

      cell._bahTurbo = streamer;

      streamer.start();

      const play = async () => {

        try {

          await video.play();

        } catch (error) {

          if (!isCurrent() || handedOff || error.name !== 'NotAllowedError') return;

          video.muted = true;

          updateCellMuteBtn(cell, true);

          try { await video.play(); } catch { /* Keep manual play controls available. */ }

        }

      };

      void play();

    }



    function updateCellMuteBtn(cell, isMuted) {

      const btn = cell.querySelector('[data-cell-act="mute"]');

      if (!btn) return;

      btn.textContent = isMuted ? '🔇' : '🔊';

      btn.classList.toggle('is-unmuted', !isMuted);

      btn.title = isMuted ? 'Zapnúť zvuk tohto videa (iba toto)' : 'Stlmiť zvuk';

    }



    function openSplitScreenPlayer(urls) {

      if (document.documentElement.dataset.nexusSplitReady === '1') {

        hideHoverPreview();

        document.querySelectorAll('.bah-rollout-active').forEach(el=>triggerRollout(el,false));

        closeVideoPlayer();closeSplitScreenPlayer();

        document.dispatchEvent(new CustomEvent('nexus-split-open',{detail:JSON.stringify(urls || [])}));

        return;

      }

      const validUrls = (urls || []).filter(Boolean);

      if (!validUrls.length) {

        toast('Najprv označ aspoň 2 videá pomocou checkboxu.', true);

        return;

      }

      if (validUrls.length === 1) {

        openVideoPlayer(validUrls[0]);

        return;

      }



      if (!splitModal) {

        splitModal = document.createElement('div');

        splitModal.className = 'bah-split-modal';

        splitModal.innerHTML = `

          <div class="bah-split-container">

            <div class="bah-split-bar">

              <span class="bah-split-title">▶▶ Split-Screen Prehrávač</span>

              <div class="bah-split-controls">

                <div class="bah-split-group">

                  <button class="bah-split-btn" data-split-act="playAll" title="Spustiť všetky naraz">▶ Play All</button>

                  <button class="bah-split-btn" data-split-act="pauseAll" title="Pozastaviť všetky">⏸ Pause All</button>

                  <button class="bah-split-btn" data-split-act="syncStart" title="Zosynchronizovať všetky na začiatok (0:00)">⏮ Sync 0:00</button>

                  <button class="bah-split-btn" data-split-act="stepBack" title="Posunúť všetky o -10s">⏪ -10s</button>

                  <button class="bah-split-btn" data-split-act="stepFwd" title="Posunúť všetky o +10s">⏩ +10s</button>

                  <button class="bah-split-btn" data-split-act="muteAll" title="Stlmiť všetky videá">🔇 Mute All</button>

                </div>

                <div class="bah-split-group">

                  <button class="bah-split-btn is-active" data-split-layout="auto" title="Automatické rozloženie">Auto Grid</button>

                  <button class="bah-split-btn" data-split-layout="row" title="Všetky videá v jednom rade vedľa seba">Vedľa seba (1 rad)</button>

                  <button class="bah-split-btn" data-split-layout="grid2" title="2 stĺpce">2 stĺpce</button>

                  <button class="bah-split-btn" data-split-layout="grid3" title="3 stĺpce">3 stĺpce</button>

                  <button class="bah-split-btn" data-split-act="toggleFit" title="Prepnúť prispôsobenie obrazu (Contain / Cover)">⛶ Fit: Celé</button>

                  <button class="bah-split-btn bah-split-diag-btn" data-split-act="toggleDiag" title="Zobraziť diagnostický panel pre každé video (Mb/s, buffer, stally, dropped frames)">📊 Diag HUD</button>

                </div>

                <div class="bah-split-close" title="Zatvoriť Split-Screen (Esc)">&times;</div>

              </div>

            </div>

            <div class="bah-split-stage" data-fit="contain"></div>

          </div>

        `;

        document.body.appendChild(splitModal);



        splitModal.querySelector('.bah-split-close').addEventListener('click', closeSplitScreenPlayer);

        splitModal.addEventListener('click', (e) => {

          if (e.target === splitModal) closeSplitScreenPlayer();

        });

        document.addEventListener('keydown', (e) => {

          if (e.key === 'Escape' && splitModal.style.display === 'flex') {

            closeSplitScreenPlayer();

          }

        });



        splitModal.querySelector('.bah-split-bar').addEventListener('click', (e) => {

          const layoutBtn = e.target.closest('[data-split-layout]');

          if (layoutBtn) {

            splitLayoutMode = layoutBtn.dataset.splitLayout;

            applySplitGridLayout();

            return;

          }

          const actBtn = e.target.closest('[data-split-act]');

          if (!actBtn) return;

          const act = actBtn.dataset.splitAct;

          const vids = [...splitModal.querySelectorAll('.bah-split-video')];

          if (act === 'playAll') {

            vids.forEach((v) => v.play().catch(() => { v.muted = true; v.play().catch(() => {}); }));

          } else if (act === 'pauseAll') {

            vids.forEach((v) => v.pause());

          } else if (act === 'syncStart') {

            vids.forEach((v) => { try { v.currentTime = 0; v.play().catch(() => {}); } catch {} });

          } else if (act === 'stepBack') {

            vids.forEach((v) => { try { v.currentTime = Math.max(0, (v.currentTime || 0) - 10); } catch {} });

          } else if (act === 'stepFwd') {

            vids.forEach((v) => { try { v.currentTime = (v.currentTime || 0) + 10; } catch {} });

          } else if (act === 'muteAll') {

            vids.forEach((v) => {

              v.muted = true;

              const cell = v.closest('.bah-split-cell');

              if (cell) updateCellMuteBtn(cell, true);

            });

          } else if (act === 'toggleFit') {

            splitFitMode = splitFitMode === 'contain' ? 'cover' : 'contain';

            applySplitGridLayout();

          } else if (act === 'toggleDiag') {

            splitDiagVisible = !splitDiagVisible;

            actBtn.classList.toggle('is-active', splitDiagVisible);

            splitModal.querySelectorAll('.bah-split-diag-panel').forEach((p) => {

              p.classList.toggle('is-visible', splitDiagVisible);

            });

          }

        });

      }



      closeSplitScreenPlayer();

      splitModal.style.display = 'flex';



      // Live 1-second Diagnostic Poller & Master Drift Sync

      splitDiagTimer = setInterval(() => {

        if (!splitModal || splitModal.style.display !== 'flex' || !splitDiagVisible || document.hidden) return;

        const entries = performance.getEntriesByType('resource').slice(-60);

        const cells = splitModal.querySelectorAll('.bah-split-cell');

        cells.forEach((cell) => {

          const v = cell.querySelector('.bah-split-video');

          if (!v) return;

          // 1. Buffer ahead

          let ahead = 0;

          const cur = v.currentTime || 0;

          for (let i = 0; i < v.buffered.length; i++) {

            if (v.buffered.start(i) <= cur && v.buffered.end(i) >= cur) {

              ahead = Math.max(0, v.buffered.end(i) - cur);

              break;

            }

          }

          const bufEl = cell.querySelector('[data-diag="buf"]');

          if (bufEl) {

            bufEl.textContent = ahead.toFixed(1) + ' s';

            bufEl.className = 'bah-diag-val ' + (ahead < 2 ? 'is-bad' : ahead < 6 ? 'is-warn' : '');

          }

          // 2. Dropped frames

          const qual = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;

          const dropEl = cell.querySelector('[data-diag="drop"]');

          if (dropEl && qual) {

            dropEl.textContent = String(qual.droppedVideoFrames || 0);

            if (qual.droppedVideoFrames > 30) dropEl.className = 'bah-diag-val is-bad';

            else if (qual.droppedVideoFrames > 5) dropEl.className = 'bah-diag-val is-warn';

          }

          // 3. Network Performance Metrics from PerformanceResourceTiming

          try {

            const cdnEntry = entries.filter((e) => e.name === v.currentSrc).pop();

            if (cdnEntry) {

              const protoEl = cell.querySelector('[data-net="proto"]');

              if (protoEl) protoEl.textContent = cdnEntry.nextHopProtocol || 'N/A';

              const ttfbEl = cell.querySelector('[data-net="ttfb"]');

              if (ttfbEl && cdnEntry.responseStart > 0 && cdnEntry.requestStart > 0) {

                ttfbEl.textContent = Math.round(cdnEntry.responseStart - cdnEntry.requestStart) + ' ms';

              }

              const tlsEl = cell.querySelector('[data-net="tls"]');

              if (tlsEl && cdnEntry.connectEnd > 0 && cdnEntry.secureConnectionStart > 0) {

                tlsEl.textContent = Math.round(cdnEntry.connectEnd - cdnEntry.secureConnectionStart) + ' ms';

              }

              const dnsEl = cell.querySelector('[data-net="dns"]');

              if (dnsEl && cdnEntry.domainLookupEnd > 0 && cdnEntry.domainLookupStart > 0) {

                dnsEl.textContent = Math.round(cdnEntry.domainLookupEnd - cdnEntry.domainLookupStart) + ' ms';

              }

            }

          } catch {}

        });

      }, 1000);



      // Independent clips play at their chosen speed; Sync is an explicit seek.

      const stage = splitModal.querySelector('.bah-split-stage');



      validUrls.forEach((u, idx) => {

        const it = items.find((x) => x.url === u);

        const title = it?.title ? prettyTitle(it.title) : u.split('/').pop();

        const cell = document.createElement('div');

        cell.className = 'bah-split-cell';

        cell.dataset.url = u;

        cell.innerHTML = `

          <div class="bah-split-cell-head">

            <span class="bah-split-cell-num">#${idx + 1}</span>

            <span class="bah-split-cell-title" title="${title.replace(/"/g, '&quot;')}">${title}</span>

            <div class="bah-split-cell-actions">

              <button class="bah-split-cell-btn" data-cell-act="mute" title="Zvuk">🔇</button>

              <button class="bah-split-cell-btn" data-cell-act="solo" title="Zapnúť zvuk iba pre toto video">🎯 Solo</button>

              <a class="bah-split-cell-btn bah-split-dl" target="_blank" download rel="noopener" style="display:none" title="Stiahnuť MP4">⬇</a>

              <a class="bah-split-cell-btn" href="${u}" target="_blank" rel="noopener" title="Otvoriť stránku">↗</a>

              <button class="bah-split-cell-btn is-remove" data-cell-act="remove" title="Zavrieť toto video zo Split-Screenu">&times;</button>

            </div>

          </div>

          <div class="bah-split-cell-body">

            <div class="bah-split-loader">Načítavam…</div>

            <video class="bah-split-video" controls autoplay loop playsinline preload="auto"></video>

            <iframe class="bah-split-iframe" allow="autoplay *; encrypted-media *; fullscreen *" referrerpolicy="origin" style="display:none"></iframe>

            <div class="bah-split-diag-panel" title="Klikni pre detailný sieťový rozpad (HTTP verzia, TTFB, TLS handshake)">

              <div>Bitrate: <span class="bah-diag-val" data-diag="speed">-- Mb/s</span></div>

              <div>Buffer: <span class="bah-diag-val" data-diag="buf">-- s</span></div>

              <div>Stalls: <span class="bah-diag-val" data-diag="stalls">0</span></div>

              <div>Dropped: <span class="bah-diag-val" data-diag="drop">0</span></div>

            </div>

            <div class="bah-split-net-tooltip">

              <div>Proto: <span class="val" data-net="proto">N/A</span> | TTFB: <span class="val" data-net="ttfb">-- ms</span></div>

              <div>TLS Handshake: <span class="val" data-net="tls">-- ms</span> | DNS: <span class="val" data-net="dns">-- ms</span></div>

              <div>Backend Cache: <span class="val" data-net="cache">DIRECT CDN</span></div>

            </div>

          </div>

        `;

        stage.appendChild(cell);



        const video = cell.querySelector('.bah-split-video');

        video.addEventListener('volumechange', () => {

          updateCellMuteBtn(cell, video.muted || video.volume === 0);

        });



        const diagPanel = cell.querySelector('.bah-split-diag-panel');

        diagPanel?.classList.toggle('is-visible', splitDiagVisible);

        const netTooltip = cell.querySelector('.bah-split-net-tooltip');

        if (diagPanel && netTooltip) {

          diagPanel.addEventListener('click', (e) => {

            e.stopPropagation();

            netTooltip.classList.toggle('is-open');

          });

        }

        cell.querySelector('.bah-split-cell-head').addEventListener('click', (e) => {

          const btn = e.target.closest('[data-cell-act]');

          if (!btn) return;

          const act = btn.dataset.cellAct;

          if (act === 'mute') {

            video.muted = !video.muted;

            updateCellMuteBtn(cell, video.muted);

          } else if (act === 'solo') {

            splitModal.querySelectorAll('.bah-split-cell').forEach((c) => {

              const v = c.querySelector('.bah-split-video');

              if (!v) return;

              const isThis = c === cell;

              v.muted = !isThis;

              if (isThis && v.volume === 0) v.volume = 1;

              updateCellMuteBtn(c, v.muted);

            });

          } else if (act === 'remove') {

            if (cell._bahTurbo) { cell._bahTurbo.destroy(); cell._bahTurbo = null; }

            try { video.onerror = null; video.pause(); video.removeAttribute('src'); video.load(); } catch {}

            cell.querySelector('.bah-split-iframe').src = 'about:blank';

            cell.remove();

            const remaining = splitModal.querySelectorAll('.bah-split-cell').length;

            if (remaining === 0) {

              closeSplitScreenPlayer();

            } else {

              applySplitGridLayout();

            }

          }

        });



      });



      // Bound resolver concurrency without delaying every cell by its index.

      const pending = [...stage.querySelectorAll('.bah-split-cell')];

      let next = 0;

      const startWorker = async () => {

        while (next < pending.length) {

          const index = next++;

          const cell = pending[index];

          if (!cell.isConnected) continue;

          try { await loadSplitCellStream(cell, cell.dataset.url, index); }

          catch (error) { console.warn('[Bunkr Split] Stream startup failed:', error); }

        }

      };

      // play() can remain pending while buffering: don't serialize cells on it.

      for (let i = 0; i < Math.min(3, pending.length); i++) void startWorker();

      applySplitGridLayout();

    }



    // --------------------------------------------------------------------------- //

    // port detect

    // --------------------------------------------------------------------------- //

    function pingPort(port, timeoutMs = 1500) {

      return bridgeFetch(`http://localhost:${port}/health`, { timeoutMs })

        .then((r) => r.ok).catch(() => false);

    }

    async function detectPort(force) {

      if (detecting) return connStatus === 'online';

      detecting = true; connStatus = 'searching'; updateConnIndicator();

      const order = [state.port, ...CANDIDATE_PORTS.filter((p) => p !== state.port)];

      let found = 0;

      for (const port of order) {

        // eslint-disable-next-line no-await-in-loop

        if (await pingPort(port)) { found = port; break; }

      }

      detecting = false;

      if (found) {

        state.port = found; savePrefs(); connStatus = 'online'; updateConnIndicator(); syncPanel();

        loadDashboardBatches();

        compareWithDashboard();

        return true;

      }

      connStatus = 'offline'; updateConnIndicator();

      if (force) toast(`No dashboard found on ${CANDIDATE_PORTS.join(', ')}.`, true);

      return false;

    }

    function updateConnIndicator() {

      const led = document.querySelector(`#${PANEL_ID} [data-role="conn-led"]`);

      if (!led) return;

      led.style.background = connStatus === 'online' ? '#22c55e'

        : connStatus === 'searching' ? '#eab308' : '#ef4444';

      led.title = connStatus === 'online' ? `connected :${state.port}`

        : connStatus === 'searching' ? 'searching…' : 'offline';

    }



    // --------------------------------------------------------------------------- //

    // helpers + toast + styles

    // --------------------------------------------------------------------------- //

    const MAX_META_ROUNDS = 4;        // auto-retry rounds within a single Fetch click

    // A URL needs (re)fetching whenever it still has no duration. We never lock it

    // out permanently: a Bunkr CDN node can 503 for a while then recover, so a

    // later Fetch click must be able to pick the stragglers back up.

    function needsFetch(u) {

      return !(metaByUrl.get(u)?.duration > 0);

    }

    function numOr(v) { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : 0; }

    function fmtDur(s) {

      s = Math.round(s || 0);

      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;

      return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`

        : `${m}:${String(sec).padStart(2, '0')}`;

    }

    function fmtBytes(bytes) {

      const value = Number(bytes || 0);

      if (value >= 1024 ** 3) return `${(value / (1024 ** 3)).toFixed(value >= 10 * 1024 ** 3 ? 1 : 2)} GB`;

      if (value >= 1024 ** 2) return `${(value / (1024 ** 2)).toFixed(value >= 100 * 1024 ** 2 ? 0 : 1)} MB`;

      if (value >= 1024) return `${Math.round(value / 1024)} KB`;

      return value ? `${value} B` : '';

    }

    function heightToQ(h) {

      return h >= 2160 ? '4K' : h >= 1080 ? '1080p' : h >= 720 ? '720p' : h >= 480 ? '480p' : h ? `${h}p` : '';

    }

    function captureViewportAnchor() {

      const scrollX = window.scrollX;

      const scrollY = window.scrollY;

      const anchor = items.map((it) => it.el).find((el) => {

        const r = el?.getBoundingClientRect?.();

        return r && r.bottom > 0 && r.top < window.innerHeight;

      });

      return { scrollX, scrollY, anchor, top: anchor?.getBoundingClientRect?.().top || 0 };

    }

    function restoreViewportAnchor(snapshot) {

      if (!snapshot) return;

      const restore = () => {

        const nextTop = snapshot.anchor?.isConnected ? snapshot.anchor.getBoundingClientRect().top : snapshot.top;

        const targetY = Math.max(0, snapshot.scrollY + nextTop - snapshot.top);

        window.scrollTo(snapshot.scrollX, targetY);

      };

      // Bunkr's virtual grid can finish its own layout one frame later.

      restore();

      requestAnimationFrame(restore);

    }

    function bitrateOf(m) {

      const explicit = Number(m?.bitrateBps || 0);

      if (explicit > 0) return explicit;

      const bytes = Number(m?.sizeBytes || 0);

      const seconds = Number(m?.duration || 0);

      return bytes > 0 && seconds > 0 ? Math.round((bytes * 8) / seconds) : 0;

    }

    function fmtBitrate(bps) {

      return bps >= 1000000 ? `${(bps / 1000000).toFixed(1)} Mb/s` : `${Math.round(bps / 1000)} kb/s`;

    }

    function qualityScore(m) {

      const bps = bitrateOf(m);

      const h = Number(m?.height || 0) || heightOf({ meta: m || {} });

      if (!bps || !h) return { label: '', cls: '', title: '' };

      // Thresholds are intentionally resolution-aware: 5 Mb/s can be excellent

      // at 720p but weak at 4K. This is a practical encode-density signal, not a

      // claim about source quality, codec efficiency, or HDR.

      const mbps = bps / 1000000;

      const [good, fair] = h >= 2160 ? [18, 8] : h >= 1440 ? [10, 4.5] : h >= 1080 ? [6, 2.5] : h >= 720 ? [3, 1.2] : [1.5, 0.6];

      if (mbps >= good) return { label: 'HQ', cls: 'is-hq', title: `High encode density for ${heightToQ(h)}: ${fmtBitrate(bps)}` };

      if (mbps >= fair) return { label: 'OK', cls: 'is-ok', title: `Typical encode density for ${heightToQ(h)}: ${fmtBitrate(bps)}` };

      return { label: 'LOW', cls: 'is-low', title: `Low encode density for ${heightToQ(h)}: ${fmtBitrate(bps)}` };

    }

    let toastEl = null, toastTimer = null;

    function toast(text, isError = false) {

      if (!toastEl) {

        toastEl = document.createElement('div');

        toastEl.id = 'bah-toast';

        document.body.appendChild(toastEl);

      }

      toastEl.textContent = text;

      toastEl.style.borderColor = isError ? 'rgba(239,68,68,.7)' : 'rgba(34,197,94,.6)';

      toastEl.classList.add('show');

      clearTimeout(toastTimer);

      toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4200);

    }





    function injectStyles() {

      const css = `

      html[data-nexus-bunkr-helper="1"] .nexus-batch-toolbar, html[data-nexus-bunkr-helper="1"] .nexus-bunkr-checkbox-container { display:none!important; }

      #${PANEL_ID}, #${HUD_LAYER_ID}, #bah-toast, .bah-cb-wrap, .bah-selected, .bah-thumb-hud, .bks-balbums-search { ${NEXUS_TOKENS} }

      .bks-redirect-banner-hidden,.bks-site-control-hidden{display:none!important}

      .bks-clean-topbar{position:relative!important}

      .bks-balbums-search{position:absolute;left:50%;top:50%;z-index:80;display:grid;

        grid-template-columns:26px minmax(0,1fr) 38px;align-items:center;width:clamp(300px,38vw,620px);

        min-height:42px;transform:translate(-50%,-50%);border:1px solid rgba(168,85,247,.42);

        border-radius:12px;background:rgba(10,15,24,.92);box-shadow:0 12px 34px rgba(0,0,0,.28);

        color:var(--bah-text);overflow:hidden;backdrop-filter:blur(12px)}

      .bks-search-mark{padding-left:12px;color:#a78bfa;font:700 18px/1 var(--bah-font);pointer-events:none}

      .bks-balbums-search input{box-sizing:border-box;width:100%;height:40px;padding:0 10px;border:0!important;

        outline:0!important;background:transparent!important;color:#f8fafc!important;font:600 13px/1 var(--bah-font)!important;

        box-shadow:none!important}

      .bks-balbums-search input::placeholder{color:#748094}

      .bks-balbums-search:focus-within{border-color:#a855f7;box-shadow:0 0 0 3px rgba(168,85,247,.14),0 12px 34px rgba(0,0,0,.3)}

      .bks-balbums-search button{display:grid!important;place-items:center!important;width:38px!important;height:42px!important;

        padding:0!important;border:0!important;border-left:1px solid rgba(168,85,247,.24)!important;border-radius:0!important;

        background:linear-gradient(135deg,#0891b2,#8b5cf6)!important;color:#fff!important;font:800 17px/1 var(--bah-font)!important;

        cursor:pointer!important}

      .bks-balbums-search button:hover{filter:brightness(1.12)}



      /* Hide native Bunkr top-right video badge/icons */

      .theItem .ic-videos, .grid-item .ic-videos, .file-card .ic-videos,

      .theItem [data-icon*="video"], .grid-item [data-icon*="video"], .file-card [data-icon*="video"],

      .theItem svg[class*="video"], .grid-item svg[class*="video"], .file-card svg[class*="video"],

      .theItem .fa-video, .grid-item .fa-video, .file-card .fa-video,

      .theItem [class*="bg-purple"], .grid-item [class*="bg-purple"], .file-card [class*="bg-purple"],

      .theItem img[src*="video.svg"], .grid-item img[src*="video.svg"], .file-card img[src*="video.svg"] {

        display: none !important;

      }



      /* The picture keeps its own ratio. The stage is exactly that ratio, and

         the bitmap is contained inside it, so nothing is cropped or stretched. */

      html.bks-album-page .bah-card.bah-hidden,

      body.bah-wide-grid .bah-ratio-grid > .bah-card.bah-hidden,

      body.bah-wide-grid .theItem.bah-hidden,

      body.bah-wide-grid .grid-item.bah-hidden,

      body.bah-wide-grid .file-card.bah-hidden,

      .bah-card.bah-hidden {

        display: none !important;

      }



      html.bks-album-page .bah-card {

        height: auto !important;

        min-height: 0 !important;

        align-self: start !important;

      }

      html.bks-album-page .bah-card a:has(.bah-stage),

      html.bks-album-page a.bah-card:has(.bah-stage),

      html.bks-album-page .bah-card :has(> .bah-stage),

      html.bks-album-page .bah-card a:has(.bah-stage-anchor),

      html.bks-album-page a.bah-card:has(.bah-stage-anchor),

      html.bks-album-page .bah-card :has(> .bah-stage-anchor) {

        display: block !important;

        height: auto !important;

        aspect-ratio: auto !important;

        overflow: visible !important;

      }

      html.bks-album-page .bah-stage {

        position: relative !important;

        display: block !important;

        width: 100% !important;

        height: auto !important;

        aspect-ratio: var(--bah-ar, 16 / 9) !important;

        overflow: hidden !important;

        border-radius: 12px !important;

        background:

          radial-gradient(90% 80% at 50% 0%, rgba(139, 92, 246, .16), transparent 62%),

          #070b10 !important;

        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .05);

      }



      /* Vertical Thumbnails & Rollout (rigid grid layout) */

      html.bks-album-page .bah-stage-anchor {

        position: relative !important;

        display: block !important;

        width: 100% !important;

        height: auto !important;

        aspect-ratio: auto !important;

        overflow: visible !important;

      }

      html.bks-album-page .bah-vertical-card .bah-stage-anchor {
        position: relative !important;
        display: block !important;
        width: 100% !important;
        aspect-ratio: 4 / 5 !important;
        height: auto !important;
        overflow: visible !important;
      }



      html.bks-album-page .bah-vertical-card {

        position: relative !important;

      }

      body.bah-wide-grid .bah-ratio-grid > .bah-card.bah-rollout-active,

      html.bks-album-page .bah-card.bah-rollout-active,

      html.bks-album-page .bah-vertical-card.bah-rollout-active {

        z-index: 1000 !important;

        overflow: visible !important;

      }

      html.bks-album-page .bah-vertical-card.bah-rollout-active .bah-stage-anchor {

        z-index: 1001 !important;

        overflow: visible !important;

      }

      html.bks-album-page .bah-card a::after,

      .bah-card a::after {

        display: none !important;

        pointer-events: none !important;

      }

      html.bks-album-page .bah-vertical-card .bah-stage-anchor {

        z-index: 25 !important;

      }

      html.bks-album-page .bah-vertical-card .bah-stage {

        position: absolute !important;

        top: 0 !important;

        left: 0 !important;

        width: 100% !important;

        height: 100% !important;

        aspect-ratio: 4 / 5 !important;

        overflow: hidden !important;

        border-radius: 12px !important;

        z-index: 25 !important;

        transition: aspect-ratio 0.3s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.25s ease !important;

      }

      html.bks-album-page .bah-vertical-card .bah-stage img.bah-main-thumb {

        position: absolute !important;

        inset: 0 !important;

        width: 100% !important;

        height: 100% !important;

        max-width: none !important;

        max-height: none !important;

        object-fit: cover !important;

        object-position: top center !important;

        transition: object-fit 0.2s ease !important;

      }

      html.bks-album-page .bah-vertical-card.bah-rollout-active .bah-stage {

        position: absolute !important;

        top: 0 !important;

        left: 0 !important;

        width: 100% !important;

        height: auto !important;

        aspect-ratio: var(--bah-orig-ar, 0.5625) !important;

        max-height: 85vh !important;

        overflow: hidden !important;

        z-index: 1002 !important;

        border-radius: 14px !important;

        box-shadow: 0 25px 70px rgba(0, 0, 0, 0.95), 0 0 0 2px #a855f7, 0 0 35px rgba(168, 85, 247, 0.45) !important;

      }

      html.bks-album-page .bah-vertical-card.bah-rollout-active .bah-stage img.bah-main-thumb {

        object-fit: contain !important;

        object-position: center !important;

      }

      html.bks-album-page body.bah-only-vertical .bah-vertical-card .bah-stage-anchor,

      body.bah-only-vertical .bah-vertical-card .bah-stage-anchor {

        position: relative !important;

        display: block !important;

        width: 100% !important;

        aspect-ratio: var(--bah-orig-ar, 0.5625) !important;

        height: auto !important;

      }

      html.bks-album-page body.bah-only-vertical .bah-vertical-card .bah-stage,

      body.bah-only-vertical .bah-vertical-card .bah-stage {

        position: relative !important;

        top: auto !important;

        left: auto !important;

        width: 100% !important;

        height: auto !important;

        aspect-ratio: var(--bah-orig-ar, 0.5625) !important;

        z-index: 25 !important;

      }

      html.bks-album-page body.bah-only-vertical .bah-vertical-card .bah-stage img.bah-main-thumb,

      body.bah-only-vertical .bah-vertical-card .bah-stage img.bah-main-thumb {

        object-fit: cover !important;

        object-position: center !important;

      }

      /* Selector pri vertikálnych kartách umiestniť do stredu */

      html.bks-album-page .bah-vertical-card .bah-cb-wrap,

      html.bks-album-page .bah-vertical-card .nexus-bunkr-checkbox-container {

        position: absolute !important;

        top: 7px !important;

        left: 50% !important;

        right: auto !important;

        width: 24px !important;

        height: 24px !important;

        transform: translateX(-50%) !important;

        z-index: 40 !important;

      }

      .bah-vertical-badge {

        position: absolute !important;

        top: 7px !important;

        left: 7px !important;

        z-index: 33 !important;

        display: inline-flex !important;

        align-items: center !important;

        justify-content: center !important;

        width: 22px !important;

        height: 22px !important;

        border-radius: 6px !important;

        background: linear-gradient(135deg, #a855f7 0%, #6366f1 100%) !important;

        color: #ffffff !important;

        font: 800 12px/1 var(--bah-font, system-ui) !important;

        box-shadow: 0 3px 10px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.3) !important;

        letter-spacing: 0 !important;

        pointer-events: auto !important;

        user-select: none !important;

        transition: transform 0.15s ease !important;

      }

      .bah-vertical-badge:hover {

        transform: scale(1.15) !important;

      }

      html.bks-album-page .bah-thumb-hud.bah-hud-has-v .bah-hud-date,

      html.bks-album-page .bah-stage-chips.bah-hud-has-v .bah-hud-date {

        left: 34px !important;

      }

      html.bks-album-page .bah-stage::after {

        content: "";

        position: absolute;

        left: 0; right: 0; bottom: 0;

        height: 16%;

        background: linear-gradient(to top, rgba(5, 8, 14, .42), transparent);

        pointer-events: none;

        z-index: 3;

      }

      html.bks-album-page .bah-stage img.bah-main-thumb {

        position: absolute !important;

        inset: 0 !important;

        width: 100% !important;

        height: 100% !important;

        max-width: none !important;

        max-height: none !important;

        object-fit: contain !important;

        object-position: center !important;

        border-radius: 0 !important;

        z-index: 1 !important;

        background: transparent !important;

      }

      html.bks-album-page .bah-ratio-grid {

        align-items: start !important;

      }



      /* Full-width workspace. The open helper owns a real right rail; once

         collapsed, the grid receives the full browser width again. */

      body.bah-wide-grid main {

        box-sizing: border-box !important;

        max-width: none !important;

        width: 100% !important;

        margin: 0 !important;

        padding-left: 22px !important;

        padding-right: 284px !important;

        transition: padding-right .18s ease !important;

      }

      body.bah-wide-grid.bks-helper-collapsed main {

        padding-right: 22px !important;

      }

      body.bah-wide-grid main .container,

      body.bah-wide-grid main [class*="max-w-"],

      body.bah-wide-grid main .max-w-7xl,

      body.bah-wide-grid main .max-w-6xl,

      body.bah-wide-grid main .max-w-5xl,

      body.bah-wide-grid main .max-w-4xl {

        box-sizing: border-box !important;

        max-width: none !important;

        width: 100% !important;

        margin-left: 0 !important;

        margin-right: 0 !important;

      }

      body.bah-wide-grid div.grid,

      body.bah-wide-grid section.grid,

      body.bah-wide-grid [class*="grid-cols"],

      body.bah-wide-grid .grid-images {

        display: grid !important;

        grid-template-columns: repeat(var(--bah-grid-cols, 7), minmax(0, 1fr)) !important;

        gap: 10px !important;

      }

      body.bah-wide-grid .theItem,

      body.bah-wide-grid .grid-item,

      body.bah-wide-grid .file-card {

        width: 100% !important;

        max-width: none !important;

      }

      @media (max-width: 1600px) {

        body.bah-wide-grid div.grid,

        body.bah-wide-grid section.grid,

        body.bah-wide-grid [class*="grid-cols"],

        body.bah-wide-grid .grid-images {

          grid-template-columns: repeat(min(var(--bah-grid-cols, 7), 6), minmax(0, 1fr)) !important;

        }

      }

      @media (max-width: 1280px) {

        body.bah-wide-grid div.grid,

        body.bah-wide-grid section.grid,

        body.bah-wide-grid [class*="grid-cols"],

        body.bah-wide-grid .grid-images {

          grid-template-columns: repeat(min(var(--bah-grid-cols, 7), 4), minmax(0, 1fr)) !important;

        }

      }

      @media (max-width: 768px) {

        body.bah-wide-grid div.grid,

        body.bah-wide-grid section.grid,

        body.bah-wide-grid [class*="grid-cols"],

        body.bah-wide-grid .grid-images {

          grid-template-columns: repeat(2, minmax(0, 1fr)) !important;

        }

      }



      /* Justified light table. Flex-grow follows the picture ratio, so a row

         shares one height and each frame keeps its width. The trailing spacer

         absorbs leftover space on the last row so a single card does not blow up. */

      body.bah-wide-grid .bah-ratio-grid {

        display: flex !important;

        flex-flow: row wrap !important;

        align-items: flex-start !important;

        align-content: flex-start !important;

        gap: 12px !important;

        grid-template-columns: none !important;

      }

      body.bah-wide-grid .bah-ratio-grid > .bah-card {

        position: relative !important;

        display: flex !important;

        flex-direction: column !important;

        flex: var(--bah-ar, 1.6) 1 calc(var(--bah-ar, 1.6) * var(--bah-row, 176px)) !important;

        width: auto !important;

        max-width: 100% !important;

        min-width: 0 !important;

        height: auto !important;

        overflow: hidden !important;

        border-radius: 14px !important;

        background: linear-gradient(180deg, #151c2c 0%, #0c111a 100%) !important;

        border: 1px solid rgba(226, 232, 240, .08) !important;

        box-shadow: 0 16px 36px rgba(0, 0, 0, .34) !important;

        transition: border-color .18s ease, box-shadow .18s ease !important;

      }

      body.bah-wide-grid .bah-card:hover {

        border-color: rgba(167, 139, 250, .55) !important;

        box-shadow: 0 18px 40px rgba(0, 0, 0, .42), 0 0 0 1px rgba(139, 92, 246, .32) !important;

      }

      body.bah-wide-grid .bah-stage {

        flex: 0 0 auto !important;

        border-radius: 13px 13px 0 0 !important;

      }

      body.bah-wide-grid .bah-caption {

        display: block;

        padding: 8px 11px 10px;

        color: #e8eef8;

        font: 600 12px/1.35 var(--bah-font, system-ui);

        letter-spacing: .01em;

        white-space: nowrap;

        overflow: hidden;

        text-overflow: ellipsis;

      }

      body.bah-wide-grid .bah-native-title { display: none !important; }



      #${PANEL_ID}{position:fixed;top:90px;right:14px;width:248px;z-index:2147483000;

        background:var(--bah-bg);color:var(--bah-text);border:1px solid var(--bah-border);

        border-radius:var(--bah-radius);

        font:13px/1.35 var(--bah-font);box-shadow:var(--bah-shadow);

        backdrop-filter:blur(8px);user-select:none}

      #${PANEL_ID} .bah-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--bah-surface-2)}

      #${PANEL_ID} .bah-title{font-weight:600;flex:1}

      #${PANEL_ID} .bah-led{width:10px;height:10px;border-radius:50%;background:var(--bah-text-dim)}

      #${PANEL_ID} .bah-mini{background:none;border:0;color:var(--bah-text-dim);font-size:15px;cursor:pointer;padding:0 4px}

      #${PANEL_ID} .bah-hub-menu{position:absolute;top:42px;right:34px;z-index:4;display:flex;flex-direction:column;

        width:190px;padding:5px;border:1px solid var(--bah-border);border-radius:9px;background:var(--bah-bg);

        box-shadow:0 10px 28px rgba(0,0,0,.5);backdrop-filter:blur(12px)}

      #${PANEL_ID} .bah-hub-menu[hidden]{display:none!important}

      #${PANEL_ID} .bah-hub-menu button{display:flex;align-items:center;justify-content:space-between;gap:8px;

        width:100%;padding:8px;border:0;border-radius:6px;background:transparent;color:var(--bah-text);

        font:inherit;text-align:left;cursor:pointer}

      #${PANEL_ID} .bah-hub-menu button:hover{background:var(--bah-accent-strong);color:#fff}

      #${PANEL_ID} .bah-hub-menu b{color:#c4b5fd;font-size:11px}

      #${PANEL_ID}.bah-collapsed .bah-body{display:none}

      #${PANEL_ID}.bah-collapsed .bah-hub-menu{display:none}

      #${PANEL_ID}.bah-collapsed{top:clamp(78px,19vh,210px);right:16px;width:48px;border-color:rgba(168,85,247,.65)}

      #${PANEL_ID}.bah-collapsed .bah-head{justify-content:center;padding:10px 6px;border-bottom:0}

      #${PANEL_ID}.bah-collapsed .bah-led,

      #${PANEL_ID}.bah-collapsed .bah-title,

      #${PANEL_ID}.bah-collapsed .bah-mini:not([data-act="toggle"]){display:none}

      #${PANEL_ID}.bah-collapsed [data-act="toggle"]{font-size:0;color:#d8b4fe}

      #${PANEL_ID}.bah-collapsed [data-act="toggle"]::after{content:"☰";font-size:18px;line-height:1}

      #${PANEL_ID} .bah-body{padding:10px 12px;display:flex;flex-direction:column;gap:8px;max-height:78vh;overflow:auto}

      #${PANEL_ID} .bah-input,#${PANEL_ID} .bah-num{background:var(--bah-field);border:1px solid var(--bah-border);border-radius:var(--bah-radius-sm);

        color:var(--bah-text);padding:6px 8px;width:100%;box-sizing:border-box;font-size:12px}

      #${PANEL_ID} .bah-row{display:flex;gap:6px;flex-wrap:wrap}

      #${PANEL_ID} .bah-sort-controls{display:grid;grid-template-columns:1fr 1fr;gap:6px}

      #${PANEL_ID} .bah-sort-controls label{display:flex;flex-direction:column;gap:4px;min-width:0;color:var(--bah-text-dim);font-size:10px}

      #${PANEL_ID} select.bah-input{min-width:0;cursor:pointer}

      #${PANEL_ID} .bah-row button,#${PANEL_ID} .bah-wide,#${PANEL_ID} .bah-half,#${PANEL_ID} .bah-import{

        background:var(--bah-surface);border:1px solid var(--bah-border);color:#cbd2df;border-radius:var(--bah-radius-sm);padding:6px 8px;

        font-size:11.5px;cursor:pointer;transition:.12s}

      #${PANEL_ID} .bah-row button:hover{border-color:var(--bah-accent)}

      #${PANEL_ID} .bah-row button.on{background:var(--bah-accent-strong);border-color:var(--bah-accent);color:#fff}

      #${PANEL_ID} .bah-grp{font-size:10px;letter-spacing:.05em;color:#7c8597;margin-top:2px}

      #${PANEL_ID} .bah-num{flex:1}

      #${PANEL_ID} .bah-stats{font-size:11px;color:var(--bah-text-dim);padding:2px 0}

      #${PANEL_ID} .bah-wide{width:100%}

      #${PANEL_ID} .bah-fetch-thumbs{margin-left:auto;border-color:rgba(168,85,247,.6);color:#e9d5ff;font-weight:700}

      #${PANEL_ID} .bah-fetch-thumbs:hover{background:rgba(168,85,247,.2)}

      #${PANEL_ID} .bah-half{flex:1}

      #${PANEL_ID} .bah-meta-state{font-size:11px;color:#9affc8;min-height:14px}

      #${PANEL_ID} .bah-import{width:100%;background:linear-gradient(90deg,var(--bah-ok-deep),var(--bah-ok));

        border:0;color:#04210f;font-weight:700;padding:9px}

      #${PANEL_ID} .bah-import:hover{filter:brightness(1.08)}

      #${PANEL_ID} .bah-wide.ghost{background:none;color:var(--bah-text-dim)}

      #${PANEL_ID} .bah-conn{font-size:10.5px;color:#6b7280;text-align:center;display:flex;align-items:center;justify-content:center;gap:4px}

      #${PANEL_ID} .bah-conn select{background:var(--bah-field);color:var(--bah-text);border:1px solid var(--bah-border);border-radius:4px;padding:2px 4px;font-size:10.5px;outline:none;cursor:pointer}

      .bah-cb-wrap{position:absolute;top:6px;left:50%;z-index:31;transform:translateX(-50%);opacity:0;transition:opacity .14s ease}

      .bah-cb-wrap:hover,.bah-selected .bah-cb-wrap{opacity:1}

      .bah-cb{width:20px;height:20px;cursor:pointer;accent-color:var(--bah-ok)}

      .bah-selected{outline:3px solid var(--bah-ok) !important;outline-offset:-3px;border-radius:var(--bah-radius-sm)}

      .bah-dim{opacity:.4}

      #${HUD_LAYER_ID}{position:fixed;inset:0;z-index:2147483000;pointer-events:none;overflow:visible}

      .bah-thumb-hud{position:absolute;z-index:1;display:block;overflow:hidden;border-radius:6px;pointer-events:none !important}

      .bah-thumb-hud[hidden]{display:none}

      /* Chips mounted inside the card's stage. The stage is exactly the box the

         thumbnail fills, so the chips land where the viewport layer used to put

         them — but the browser scrolls them with the card, which no amount of

         scroll bookkeeping could match. */

      .bah-stage-chips{position:absolute;inset:0;z-index:4;display:block;overflow:hidden;

        border-radius:inherit;pointer-events:none}

      .bah-stage-chips[hidden]{display:none}

      /* Nothing else on the page may animate the chips: a transition on left/top

         is what makes a badge visibly slide behind its card. */

      .bah-stage-chips .bah-hud-chip,.bah-thumb-hud .bah-hud-chip{transition:none !important;animation:none !important}

      .bah-hud-chip{position:absolute;max-width:calc(100% - 14px);padding:5px 9px;

        border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.6);

        color:#f8fafc;font:800 12.5px/1.1 var(--bah-font);font-variant-numeric:tabular-nums;

        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;backdrop-filter:blur(10px);

        letter-spacing:0.02em}

      .bah-hud-date {top:7px;left:7px;background:rgba(15,23,42,.92);color:#94a3b8;border:1px solid rgba(255,255,255,.1);font-weight:600}

      .bah-hud-duration {bottom:8px;left:8px;background:rgba(15,23,42,.92);color:#f8fafc;border:1px solid rgba(255,255,255,.24)}

      .bah-hud-quality {top:7px;right:7px;background:linear-gradient(135deg,#6d28d9,#9333ea);border:1px solid rgba(216,180,254,.75);color:#fff;box-shadow:0 4px 16px rgba(147,51,234,.55)}

      .bah-hud-quality.is-4k {border:1px solid rgba(244,114,182,.85);background:linear-gradient(115deg,#0284c7,#7c3aed,#d946ef);color:#fff;box-shadow:0 4px 18px rgba(217,70,239,.65)}



      .bah-hud-size {right:8px;bottom:8px;background:rgba(15,23,42,.94);color:#38bdf8;border:1px solid rgba(56,189,248,.6);box-shadow:0 4px 14px rgba(14,165,233,.3)}

      .bah-hud-size.is-hq {background:linear-gradient(135deg,#15803d,#22c55e);color:#fff;border:1px solid rgba(134,239,172,.65);box-shadow:0 4px 14px rgba(34,197,94,.4)}

      .bah-hud-size.is-ok {background:linear-gradient(135deg,#b45309,#f59e0b);color:#fff;border:1px solid rgba(253,230,138,.65);box-shadow:0 4px 14px rgba(245,158,11,.4)}

      .bah-hud-size.is-low {background:linear-gradient(135deg,#b91c1c,#ef4444);color:#fff;border:1px solid rgba(254,202,202,.65);box-shadow:0 4px 14px rgba(239,68,68,.4)}



      .bah-hud-title {display:none !important}

      .bah-hud-compare {top:7px;left:50%;transform:translateX(-50%);font-size:11px;padding:4px 8px;letter-spacing:0.03em;z-index:3;pointer-events:auto;cursor:pointer}

      .bah-hud-compare.is-better {background:linear-gradient(135deg,#15803d,#22c55e)!important;color:#fff!important;border:1px solid rgba(134,239,172,.9)!important;box-shadow:0 4px 18px rgba(34,197,94,.6)!important;font-weight:800!important}

      .bah-hud-compare.is-worse {background:linear-gradient(135deg,#b45309,#d97706)!important;color:#fff!important;border:1px solid rgba(253,230,138,.8)!important;box-shadow:0 4px 14px rgba(217,119,6,.5)!important;font-weight:700!important}

      .bah-hud-compare.is-dupe {background:rgba(185,28,28,.92)!important;color:#fef2f2!important;border:1px solid rgba(254,202,202,.7)!important;box-shadow:0 4px 14px rgba(220,38,38,.4)!important;font-weight:700!important}

      .bah-hud-compare.is-replaced {background:linear-gradient(135deg,#4f46e5,#7c3aed)!important;color:#fff!important;border:1px solid rgba(196,181,253,.9)!important;box-shadow:0 4px 18px rgba(124,58,237,.6)!important;font-weight:800!important}

      #${PANEL_ID} .bah-batch-select{cursor:pointer;outline:none}

      #${PANEL_ID} .bah-compare-row{gap:4px}

      #${PANEL_ID} .bah-comp-btn{flex:1 0 auto;min-width:58px;padding:5px 4px;font-size:10.5px;text-align:center}

      .bah-native-size{display:none!important}



      /* HD sheet is scaled uniformly inside the same stage, then faded in. */

      .bah-hd-overlay {

        position: absolute !important;

        inset: 0 !important;

        z-index: 2 !important;

        border-radius: inherit !important;

        pointer-events: none !important;

        overflow: hidden !important;

        opacity: 0;

        background: #070b10;

        transition: opacity .35s ease;

      }

      .bah-hd-overlay.is-on { opacity: 1; }

      .bah-hd-sheet {

        position: absolute !important;

        max-width: none !important;

        max-height: none !important;

        border-radius: 0 !important;

        pointer-events: none !important;

      }

      .bah-caption { display: none; }

      .bah-flex-tail {

        flex: 999 1 0px !important;

        width: 0 !important;

        height: 0 !important;

        min-width: 0 !important;

        margin: 0 !important;

        padding: 0 !important;

        overflow: hidden !important;

        pointer-events: none !important;

      }



      /* Play Button and Player Modal */

      .bah-play-btn {

        position: absolute !important;

        top: 50% !important;

        left: 50% !important;

        transform: translate(-50%, -50%) scale(0.85) !important;

        width: 62px !important;

        height: 62px !important;

        background: linear-gradient(135deg, rgba(34, 197, 94, 0.95), rgba(22, 163, 74, 0.95)) !important;

        border: 2px solid rgba(134, 239, 172, 0.9) !important;

        border-radius: 50% !important;

        display: flex !important;

        align-items: center !important;

        justify-content: center !important;

        cursor: pointer !important;

        z-index: 2147483640 !important;

        box-shadow: 0 0 25px rgba(34, 197, 94, 0.55), 0 8px 32px rgba(0, 0, 0, 0.55) !important;

        opacity: 0;

        visibility: hidden;

        pointer-events: none;

        transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.2s ease, visibility 0.2s ease, box-shadow 0.2s ease, background 0.2s ease !important;

        backdrop-filter: blur(8px) !important;

      }

      .theItem:hover .bah-play-btn,

      .grid-item:hover .bah-play-btn,

      .file-card:hover .bah-play-btn,

      .bah-card:hover .bah-play-btn,

      .bah-selected .bah-play-btn,

      body.bah-single-selected .bah-selected .bah-play-btn {

        opacity: 1 !important;

        visibility: visible !important;

        pointer-events: auto !important;

        transform: translate(-50%, -50%) scale(1) !important;

      }

      .bah-play-btn:hover {

        transform: translate(-50%, -50%) scale(1.14) !important;

        background: linear-gradient(135deg, #22c55e, #15803d) !important;

        box-shadow: 0 0 35px rgba(34, 197, 94, 0.8), 0 12px 40px rgba(0, 0, 0, 0.65) !important;

        border-color: #ffffff !important;

      }

      .bah-play-btn:active {

        transform: translate(-50%, -50%) scale(0.94) !important;

      }

      .bah-play-btn svg {

        width: 30px !important;

        height: 30px !important;

        fill: #ffffff !important;

        margin-left: 4px !important;

        filter: drop-shadow(0 2px 5px rgba(0,0,0,0.5));

      }



      /* Player Modal */

      .bah-player-modal {

        position: fixed;

        inset: 0;

        background: rgba(8, 10, 16, 0.95);

        z-index: 2147483647;

        display: none;

        flex-direction: column;

        align-items: center;

        justify-content: center;

        backdrop-filter: blur(16px);

        padding: 20px;

        box-sizing: border-box;

      }

      .bah-player-container {

        position: relative;

        width: min(92vw, 1280px);

        height: min(85vh, 720px);

        background: #000;

        border: 1px solid rgba(168, 85, 247, 0.35);

        border-radius: 16px;

        box-shadow: 0 25px 70px rgba(0, 0, 0, 0.8), 0 0 30px rgba(168, 85, 247, 0.2);

        overflow: hidden;

        display: flex;

        flex-direction: column;

      }

      .bah-player-bar {

        display: flex;

        align-items: center;

        justify-content: space-between;

        padding: 10px 16px;

        background: rgba(15, 20, 32, 0.95);

        border-bottom: 1px solid rgba(255, 255, 255, 0.1);

        color: #f1f5f9;

        font: 600 13px var(--bah-font);

        user-select: none;

      }

      .bah-player-title {

        overflow: hidden;

        text-overflow: ellipsis;

        white-space: nowrap;

        color: #e2e8f0;

      }

      .bah-player-actions {

        display: flex;

        align-items: center;

        gap: 10px;

      }

      .bah-player-btn-link {

        background: rgba(168, 85, 247, 0.2);

        border: 1px solid rgba(168, 85, 247, 0.5);

        color: #d8b4fe;

        padding: 4px 10px;

        border-radius: 6px;

        font-size: 11px;

        text-decoration: none;

        transition: background 0.15s;

      }

      .bah-player-btn-link:hover {

        background: rgba(168, 85, 247, 0.4);

        color: #fff;

      }

      .bah-player-close {

        width: 30px;

        height: 30px;

        border-radius: 50%;

        background: rgba(255, 255, 255, 0.1);

        border: 1px solid rgba(255, 255, 255, 0.2);

        color: #fff;

        font-size: 20px;

        display: grid;

        place-items: center;

        cursor: pointer;

        line-height: 1;

        transition: background 0.15s, transform 0.15s;

      }

      .bah-player-close:hover {

        background: #ef4444;

        border-color: #ef4444;

        transform: scale(1.1);

      }

      .bah-player-btn-link.bah-player-download {

        background: rgba(34, 197, 94, 0.2);

        border: 1px solid rgba(34, 197, 94, 0.5);

        color: #4ade80;

      }

      .bah-player-btn-link.bah-player-download:hover {

        background: rgba(34, 197, 94, 0.4);

        color: #fff;

      }

      .bah-player-body {

        position: relative;

        flex: 1;

        width: 100%;

        height: 100%;

        background: #000;

        display: flex;

        align-items: center;

        justify-content: center;

        overflow: hidden;

      }

      .bah-player-video {

        width: 100%;

        height: 100%;

        max-width: 100%;

        max-height: 100%;

        object-fit: contain;

        background: #000;

        outline: none;

      }

      .bah-player-loader {

        color: #e2e8f0;

        font: 600 14px var(--bah-font);

        letter-spacing: 0.5px;

        background: rgba(15, 23, 42, 0.85);

        padding: 16px 28px;

        border-radius: 12px;

        border: 1px solid rgba(168, 85, 247, 0.35);

        box-shadow: 0 10px 30px rgba(0,0,0,0.5);

      }

      .bah-player-iframe {

        width: 100%;

        height: 100%;

        border: 0;

        background: #000;

      }





      /* Split-Screen Diagnostic HUD & Enhanced Controls */



      .bah-split-diag-btn.is-active {

        background: linear-gradient(135deg, #059669, #10b981) !important;

        border-color: #34d399 !important;

        color: #fff !important;

      }

      .bah-split-diag-panel {

        position: absolute;

        bottom: 8px;

        left: 8px;

        right: 8px;

        background: rgba(10, 15, 26, 0.94);

        border: 1px solid rgba(16, 185, 129, 0.45);

        border-radius: 6px;

        padding: 5px 8px;

        font: 700 10.5px/1.3 Consolas, Monaco, monospace;

        color: #e2e8f0;

        z-index: 10;

        pointer-events: auto;

        backdrop-filter: blur(8px);

        display: none;

        grid-template-columns: repeat(2, 1fr);

        gap: 2px 8px;

        cursor: pointer;

      }

      .bah-split-diag-panel.is-visible {

        display: grid;

      }

      .bah-split-net-tooltip {

        position: absolute;

        bottom: 50px;

        left: 8px;

        right: 8px;

        background: rgba(5, 8, 15, 0.96);

        border: 1px solid rgba(56, 189, 248, 0.6);

        border-radius: 6px;

        padding: 6px 10px;

        font: 600 10px/1.4 Consolas, Monaco, monospace;

        color: #94a3b8;

        z-index: 12;

        display: none;

        box-shadow: 0 10px 25px rgba(0,0,0,0.8);

      }

      .bah-split-net-tooltip.is-open {

        display: block;

      }

      .bah-split-net-tooltip span.val {

        color: #38bdf8;

        font-weight: 700;

      }

      .bah-diag-val {

        color: #34d399;

      }

      .bah-diag-val.is-warn {

        color: #f59e0b;

      }

      .bah-diag-val.is-bad {

        color: #ef4444;

      }





      /* Split-Screen Button & Floating Action Bar */

      #${PANEL_ID} .bah-split-play-btn {

        background: linear-gradient(135deg, #7c3aed 0%, #c026d3 55%, #ec4899 100%) !important;

        border: 1px solid rgba(244, 114, 182, 0.75) !important;

        color: #ffffff !important;

        font-weight: 800 !important;

        padding: 9px 10px !important;

        letter-spacing: 0.02em !important;

        box-shadow: 0 6px 20px rgba(192, 38, 211, 0.45) !important;

        transition: transform 0.15s ease, filter 0.15s ease, box-shadow 0.15s ease !important;

      }

      #${PANEL_ID} .bah-split-play-btn:hover {

        filter: brightness(1.12) !important;

        transform: translateY(-1px) !important;

        box-shadow: 0 10px 26px rgba(236, 72, 153, 0.6) !important;

      }



      .bah-floating-split-bar {

        position: fixed;

        bottom: 96px;

        left: 50%;

        transform: translateX(-50%) translateY(100px);

        z-index: 2147483647;

        display: flex;

        align-items: center;

        gap: 10px;

        padding: 10px 16px;

        background: rgba(13, 18, 30, 0.94);

        border: 1px solid rgba(192, 38, 211, 0.65);

        border-radius: 999px;

        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.8), 0 0 28px rgba(168, 85, 247, 0.35);

        backdrop-filter: blur(14px);

        opacity: 0;

        pointer-events: none;

        transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.25s ease;

        font: 600 13px var(--bah-font, system-ui);

        color: #f8fafc;

      }

      .bah-floating-split-bar.is-visible {

        transform: translateX(-50%) translateY(0);

        opacity: 1;

        pointer-events: auto;

      }

      .bah-fsb-badge {

        background: rgba(168, 85, 247, 0.25);

        border: 1px solid rgba(192, 132, 252, 0.5);

        color: #e9d5ff;

        padding: 4px 10px;

        border-radius: 999px;

        font-size: 12px;

        font-weight: 800;

      }

      .bah-fsb-play {

        background: linear-gradient(135deg, #7c3aed 0%, #db2777 100%);

        border: 1px solid rgba(244, 114, 182, 0.8);

        color: #fff;

        font: 800 13px var(--bah-font, system-ui);

        padding: 7px 16px;

        border-radius: 999px;

        cursor: pointer;

        box-shadow: 0 4px 16px rgba(219, 39, 119, 0.5);

        transition: transform 0.15s ease, filter 0.15s ease;

      }

      .bah-fsb-play:hover {

        filter: brightness(1.12);

        transform: scale(1.03);

      }

      .bah-fsb-clear {

        background: rgba(255, 255, 255, 0.08);

        border: 1px solid rgba(255, 255, 255, 0.18);

        color: #cbd5e1;

        width: 28px;

        height: 28px;

        border-radius: 50%;

        font-size: 16px;

        line-height: 1;

        cursor: pointer;

        display: grid;

        place-items: center;

      }

      .bah-fsb-clear:hover {

        background: #ef4444;

        border-color: #ef4444;

        color: #fff;

      }



      /* Split-Screen Modal */

      .bah-split-modal {

        position: fixed;

        inset: 0;

        background: rgba(5, 7, 12, 0.96);

        z-index: 2147483647;

        display: none;

        flex-direction: column;

        padding: 12px;

        box-sizing: border-box;

      }

      .bah-split-container {

        width: 100%;

        height: 100%;

        background: #06090f;

        border: 1px solid rgba(168, 85, 247, 0.4);

        border-radius: 14px;

        box-shadow: 0 25px 80px rgba(0, 0, 0, 0.9);

        display: flex;

        flex-direction: column;

        overflow: hidden;

      }

      .bah-split-bar {

        display: flex;

        align-items: center;

        justify-content: space-between;

        flex-wrap: wrap;

        gap: 10px;

        padding: 8px 14px;

        background: rgba(15, 20, 32, 0.98);

        border-bottom: 1px solid rgba(255, 255, 255, 0.1);

        color: #f1f5f9;

        font: 700 13px var(--bah-font, system-ui);

        user-select: none;

      }

      .bah-split-title {

        color: #f3e8ff;

        font-weight: 800;

        letter-spacing: 0.02em;

      }

      .bah-split-controls {

        display: flex;

        align-items: center;

        flex-wrap: wrap;

        gap: 10px;

      }

      .bah-split-group {

        display: flex;

        align-items: center;

        gap: 5px;

        background: rgba(255, 255, 255, 0.04);

        padding: 3px;

        border-radius: 8px;

        border: 1px solid rgba(255, 255, 255, 0.08);

      }

      .bah-split-btn {

        background: rgba(30, 41, 59, 0.8);

        border: 1px solid rgba(148, 163, 184, 0.25);

        color: #e2e8f0;

        padding: 5px 10px;

        border-radius: 6px;

        font: 600 11.5px var(--bah-font, system-ui);

        cursor: pointer;

        transition: all 0.14s ease;

      }

      .bah-split-btn:hover {

        border-color: #a855f7;

        color: #fff;

        background: rgba(168, 85, 247, 0.25);

      }

      .bah-split-btn.is-active {

        background: linear-gradient(135deg, #7c3aed, #a855f7);

        border-color: #c084fc;

        color: #fff;

      }

      .bah-split-close {

        width: 30px;

        height: 30px;

        border-radius: 50%;

        background: rgba(255, 255, 255, 0.1);

        border: 1px solid rgba(255, 255, 255, 0.2);

        color: #fff;

        font-size: 20px;

        display: grid;

        place-items: center;

        cursor: pointer;

        transition: background 0.15s, transform 0.15s;

      }

      .bah-split-close:hover {

        background: #ef4444;

        border-color: #ef4444;

        transform: scale(1.1);

      }

      .bah-split-stage {

        flex: 1;

        width: 100%;

        height: 100%;

        min-height: 0;

        display: grid;

        gap: 8px;

        padding: 8px;

        box-sizing: border-box;

        background: #030508;

        overflow: hidden;

      }

      .bah-split-cell {

        position: relative;

        display: flex;

        flex-direction: column;

        min-width: 0;

        min-height: 0;

        background: #0a0e17;

        border: 1px solid rgba(148, 163, 184, 0.18);

        border-radius: 10px;

        overflow: hidden;

        transition: border-color 0.15s ease;

      }

      .bah-split-cell:hover {

        border-color: rgba(168, 85, 247, 0.65);

      }

      .bah-split-cell-head {

        display: flex;

        align-items: center;

        gap: 6px;

        padding: 5px 8px;

        background: rgba(15, 23, 42, 0.95);

        border-bottom: 1px solid rgba(255, 255, 255, 0.07);

        font: 600 11px var(--bah-font, system-ui);

        color: #cbd5e1;

      }

      .bah-split-cell-num {

        background: rgba(168, 85, 247, 0.25);

        color: #d8b4fe;

        padding: 2px 6px;

        border-radius: 4px;

        font-weight: 800;

        font-size: 10px;

      }

      .bah-split-cell-title {

        flex: 1;

        overflow: hidden;

        text-overflow: ellipsis;

        white-space: nowrap;

        color: #e2e8f0;

      }

      .bah-split-cell-actions {

        display: flex;

        align-items: center;

        gap: 4px;

      }

      .bah-split-cell-btn {

        background: rgba(255, 255, 255, 0.07);

        border: 1px solid rgba(255, 255, 255, 0.14);

        color: #e2e8f0;

        padding: 2px 6px;

        border-radius: 5px;

        font-size: 11px;

        cursor: pointer;

        text-decoration: none;

        line-height: 1.2;

      }

      .bah-split-cell-btn:hover {

        background: rgba(168, 85, 247, 0.35);

        border-color: #a855f7;

        color: #fff;

      }

      .bah-split-cell-btn.is-unmuted {

        background: rgba(34, 197, 94, 0.25);

        border-color: rgba(34, 197, 94, 0.65);

        color: #4ade80;

      }

      .bah-split-cell-btn.is-remove:hover {

        background: #ef4444;

        border-color: #ef4444;

        color: #fff;

      }

      .bah-split-cell-body {

        position: relative;

        flex: 1;

        min-height: 0;

        width: 100%;

        height: 100%;

        background: #000;

        display: flex;

        align-items: center;

        justify-content: center;

        overflow: hidden;

      }

      .bah-split-video {

        width: 100%;

        height: 100%;

        max-width: 100%;

        max-height: 100%;

        object-fit: contain;

        background: #000;

        outline: none;

      }

      .bah-split-stage[data-fit="cover"] .bah-split-video {

        object-fit: cover;

      }

      .bah-split-iframe {

        width: 100%;

        height: 100%;

        border: 0;

        background: #000;

      }

      .bah-split-loader {

        position: absolute;

        inset: 0;

        display: flex;

        align-items: center;

        justify-content: center;

        color: #e2e8f0;

        font: 600 12px var(--bah-font, system-ui);

        background: rgba(10, 14, 23, 0.85);

        z-index: 2;

      }



      /* Yandex HD Search button */

      .bah-yandex {

        background: linear-gradient(135deg, #ff5533 0%, #ff2222 100%) !important;

        color: #fff !important;

        border: 1px solid rgba(255,85,51,0.5) !important;

        font-weight: 700 !important;

        transition: filter 0.15s, transform 0.15s !important;

      }

      .bah-yandex:hover {

        filter: brightness(1.15) !important;

        transform: scale(1.02) !important;

      }

      .bah-copy-direct {

        background: linear-gradient(135deg, #ff3b30 0%, #d90429 100%) !important;

        color: #fff !important;

        border: 1px solid rgba(255, 92, 92, 0.9) !important;

        font-weight: 800 !important;

        letter-spacing: 0.04em !important;

        box-shadow: 0 8px 22px rgba(217, 4, 41, 0.45) !important;

      }

      .bah-copy-direct:hover {

        filter: brightness(1.08) !important;

        transform: translateY(-1px) !important;

      }



      #bah-hover-preview {

        position: fixed;

        z-index: 2147483005;

        pointer-events: none;

        opacity: 0;

        transform: scale(0.95) translateY(10px);

        transition: opacity 0.2s ease, transform 0.2s ease;

        background: rgba(10, 15, 24, 0.95);

        border: 1px solid rgba(168, 85, 247, 0.5);

        border-radius: 12px;

        box-shadow: 0 30px 60px rgba(0,0,0,0.6);

        padding: 8px;

        backdrop-filter: blur(16px);

        display: flex;

        align-items: center;

        justify-content: center;

        min-width: 200px;

        min-height: 100px;

      }

      #bah-hover-preview.is-visible {

        opacity: 1;

        transform: scale(1) translateY(0);

      }

      #bah-hover-preview img {

        max-width: 500px;

        max-height: 400px;

        border-radius: 6px;

        object-fit: contain;

      }

      #bah-hover-preview .bah-hp-spinner {

        color: #d8b4fe;

        font: 600 13px var(--bah-font);

        padding: 20px;

      }



      @media (max-width:900px){

        body.bah-wide-grid main,body.bah-wide-grid.bks-helper-collapsed main{

          padding-left:12px!important;padding-right:12px!important}

        .bks-balbums-search{left:auto;right:12px;width:min(52vw,430px);transform:translateY(-50%)}

      }

      @media (prefers-reduced-motion:reduce){

        body.bah-wide-grid main{transition:none!important}

      }

      #bah-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(20px);

        background:var(--bah-bg);color:var(--bah-text);border:1px solid var(--bah-border);border-radius:10px;

        padding:10px 16px;font:13px var(--bah-font);z-index:2147483600;opacity:0;transition:.25s;pointer-events:none;

        max-width:60vw}

      #bah-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}

    `;

      const style = document.createElement('style');

      style.textContent = css;

      (document.head || document.documentElement).appendChild(style);

    }



    // Boot after all let/const declarations are initialized

    injectStyles();

    loadMetaCache();

    loadVertArCache();

    if (document.body) start();

    else window.addEventListener('load', start, { once: true });

  })();



} else {

  /* Archive Search module — upstream MIT implementation */

  if (window.__nexusBaeArchive) {

    /* bunkr-albums-enhanced.user.js already owns this page */

  } else {

  window.__nexusBaeArchive = true;

  (function () {

    'use strict';



    if (window.__bunkrAlbumHelperLoaded) return;

    window.__bunkrAlbumHelperLoaded = true;



    const CONFIG = {

      previewDelay: 250,

      maxPreviews: 60,

      previewSize: '220px',

      scrollThreshold: 600,

      maxAlbumPagesToScan: 250,

      concurrentAlbumFetches: 5,

      concurrentAlbumPageFetches: 3,

      maxGlobalFileRows: 0, // one scrollable combined library; no pagination

      globalFileRenderChunk: 48, // keep large fetched libraries responsive; append more while the gallery scrolls

      fetchRenderEveryAlbums: 8,

    };

    const STORAGE_KEYS = {

      resultSort: 'bae_result_sort',

      libraryCollapsed: 'bae_library_collapsed',

      hoverPreviews: 'bae_hover_previews_enabled',

    };

    const PERSISTENT_CACHE_KEY = 'bae_album_metadata_cache_v2';

    const PERSISTENT_CACHE_VERSION = 2;

    const MAX_PERSISTENT_ALBUMS = 2500;



    function loadPersistentAlbumCache() {

      try {

        const stored = GM_getValue(PERSISTENT_CACHE_KEY, null);

        if (stored && stored.version === PERSISTENT_CACHE_VERSION && stored.entries && typeof stored.entries === 'object') return stored;

      } catch (error) {

        console.warn('[Bunkr Albums Enhanced] Persistent cache unavailable:', error);

      }

      return { version: PERSISTENT_CACHE_VERSION, entries: {} };

    }



    function getPersistentAlbumKey(url) {

      try {

        const parsed = new URL(url, window.location.href);

        const parts = parsed.pathname.split('/').filter(Boolean);

        // /a/306547 is an album ID; only /a/306547/2 contains a page suffix.

        if (parts.length > 2 && /^\d+$/.test(parts[parts.length - 1])) parts.pop();

        return `/${parts.join('/')}`.toLowerCase();

      } catch {

        return String(url || '').replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();

      }

    }



    function getAlbumCacheTtl(metadata) {

      const ageDays = metadata.newestTimestamp ? (Date.now() - metadata.newestTimestamp) / (24 * 60 * 60 * 1000) : Infinity;

      if (ageDays <= 30) return 24 * 60 * 60 * 1000;

      if (ageDays <= 90) return 3 * 24 * 60 * 60 * 1000;

      return 14 * 24 * 60 * 60 * 1000;

    }



    function isAlbumCacheFresh(metadata) {

      return !!(metadata && metadata.fetchedAt && Date.now() - metadata.fetchedAt < getAlbumCacheTtl(metadata));

    }



    function releaseSearchThumbs(root = document) {

      root.querySelectorAll('img.thumb-img, img.grid-images_box-img').forEach((img) => {

        img.decoding = 'async';

        if (/this\.remove\s*\(/.test(img.getAttribute('onerror') || '')) {

          img.removeAttribute('onerror');

          img.addEventListener('error', () => {

            if (img.dataset.baeRetried === '1') return;

            img.dataset.baeRetried = '1';

            const src = img.getAttribute('src');

            if (src) img.src = src;

          });

        }

      });

    }



    function getAlbumsGridContainer(root = document) {

      const strict = root.querySelector('div.grid.auto-rows-max.gap-1\\.5')

        || root.querySelector('main section .grid.gap-1\\.5')

        || root.querySelector('main .grid.gap-1\\.5');

      if (strict) return strict;

      const candidates = Array.from(root.querySelectorAll('section.grid, div.grid'));

      return candidates.find((el) => el.querySelector('a[href*="/a/"]')) || null;

    }



    function getAlbumCards(root = document) {

      return Array.from(root.querySelectorAll('.rounded-xl.bg-mute.border-b, a.card[href*="/a/"]'));

    }



    function getAlbumUrlFromCard(card) {

      if (!card) return '';

      const selfLink = card.matches && card.matches('a[href*="/a/"]') ? card : null;

      const nestedLink = card.querySelector("a[href^='https://bunkr.'], a[href*='/a/']");

      const href = selfLink?.href || nestedLink?.href || '';

      return href || '';

    }



    function getAlbumTitleFromCard(card) {

      return (card.querySelector('p.text-subs span')?.textContent

        || card.querySelector('h3')?.textContent

        || '').trim();

    }



    function getAlbumFileCountFromCard(card) {

      const oldText = card.querySelector('p.text-xs span')?.textContent || '';

      const oldCount = parseInt(oldText.match(/\d+/)?.[0] || '0', 10);

      if (oldCount > 0) return oldCount;



      const spans = Array.from(card.querySelectorAll('span'));

      for (const span of spans) {

        const text = (span.textContent || '').trim().toLowerCase();

        const m = text.match(/^(\d+)\s+(?:files?|videos?)$/);

        if (m) return parseInt(m[1], 10) || 0;

      }

      return 0;

    }



    function normalizeSearchText(value) {

      return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();

    }



    function injectArchiveControlStyles() {

      if (document.getElementById('bae-archive-control-styles')) return;

      const style = document.createElement('style');

      style.id = 'bae-archive-control-styles';

      style.textContent = `

html.bks-archive-page body main,

html.bks-archive-page body main.cont {

  box-sizing:border-box !important;

  width:calc(100vw - 32px) !important;

  max-width:none !important;

  margin-left:auto !important;

  margin-right:auto !important;

}

.bae-command-center { position:sticky; top:72px; z-index:24; margin:12px 0 16px; padding:12px; border:1px solid #2b2e36; border-radius:14px; background:rgba(11,12,14,.96); box-shadow:0 16px 44px rgba(0,0,0,.28); backdrop-filter:blur(16px); color:#e7e9ee; }

.bae-command-main { display:grid; grid-template-columns:minmax(250px,1.35fr) minmax(360px,2fr) minmax(250px,1.2fr); gap:10px; }

.bae-command-group { display:flex; align-items:flex-end; gap:7px; min-width:0; padding:9px; border:1px solid #242730; border-radius:10px; background:#111216; }

.bae-command-group--refine { flex-wrap:wrap; }

.bae-field { display:grid; gap:4px; min-width:0; }

.bae-field--grow { flex:1; }

.bae-field > span, .bae-command-title { color:#7f8490; font:700 9px/1.1 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.11em; text-transform:uppercase; }

.bae-command-center input, .bae-command-center select, .bae-command-center button { min-height:34px; border:1px solid #343844; border-radius:8px; background:#17191f; color:#eef0f4; font:600 11px/1.2 system-ui,sans-serif; outline:none; }

.bae-command-center input, .bae-command-center select { padding:0 9px; }

.bae-command-center input:focus-visible, .bae-command-center select:focus-visible, .bae-command-center button:focus-visible { border-color:#b9ff2c; box-shadow:0 0 0 2px rgba(185,255,44,.17); }

.bae-command-center button { padding:0 11px; cursor:pointer; white-space:nowrap; transition:border-color .15s ease,background .15s ease,transform .15s ease; }

.bae-command-center button:hover { border-color:#646b79; background:#20232a; }

.bae-command-center button:active { transform:translateY(1px); }

.bae-command-center .bae-primary { border-color:#b9ff2c; background:#b9ff2c; color:#101207; }

.bae-command-center .bae-primary:hover { background:#c7ff55; border-color:#c7ff55; }

.bae-command-center .bae-apply { border-color:#54d6c7; color:#8af1e5; }

.bae-command-center .bae-hover-toggle { border-color:#3b4250; color:#9ba3b4; }

.bae-command-center .bae-hover-toggle.is-on { border-color:#54d6c7; color:#8af1e5; background:rgba(84,214,199,.09); }

.bae-command-sub { display:flex; align-items:center; gap:8px; margin-top:9px; padding-top:9px; border-top:1px solid #242730; overflow:auto; }

.bae-preset { min-height:28px !important; padding:0 9px !important; color:#b9bec9 !important; }

.bae-status-text { margin-left:auto; color:#8fded5; font:600 10px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace; white-space:nowrap; }

.bae-workspace { display:grid; grid-template-columns:minmax(0,1fr); gap:14px; align-items:start; }

.bae-workspace > .grid { grid-template-columns:repeat(auto-fit,minmax(250px,1fr)) !important; gap:14px !important; min-width:0; width:100% !important; }

.bae-workspace > .grid > * { box-sizing:border-box !important; width:100% !important; max-width:480px !important; }

.bae-dashboard { order:-1; position:relative; top:auto; display:grid; grid-template-columns:minmax(150px,.65fr) minmax(620px,3fr) minmax(250px,1.2fr); grid-template-rows:auto auto; align-items:center; gap:8px 16px; padding:12px 14px; border:1px solid #2b2e36; border-radius:14px; background:#111216; color:#e7e9ee; box-shadow:0 18px 50px rgba(0,0,0,.22); }

.bae-dashboard-head { grid-column:1; grid-row:1 / 3; display:flex; flex-direction:column; align-items:flex-start; justify-content:center; gap:8px; }

.bae-dashboard-title { font:700 11px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.12em; text-transform:uppercase; }

.bae-dashboard-live { display:flex; align-items:center; gap:6px; color:#8b909b; font-size:10px; }

.bae-dashboard-live::before { content:''; width:6px; height:6px; border-radius:50%; background:#b9ff2c; box-shadow:0 0 10px rgba(185,255,44,.6); }

.bae-stat-grid { grid-column:2; grid-row:1 / 3; display:grid; grid-template-columns:repeat(6,minmax(82px,1fr)); gap:8px; }

.bae-stat { min-height:54px; padding:8px 10px; border:1px solid #282b34; border-radius:10px; background:#17191f; }

.bae-stat strong { display:block; color:#f4f5f7; font:700 16px/1.1 system-ui,sans-serif; }

.bae-stat span { display:block; margin-top:5px; color:#777d88; font:600 9px/1.1 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.08em; text-transform:uppercase; }

.bae-signal-label { grid-column:3; grid-row:1; align-self:end; display:flex; justify-content:space-between; color:#777d88; font:600 9px/1.1 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.07em; text-transform:uppercase; }

.bae-signal-strip { grid-column:3; grid-row:2; align-self:start; display:grid; grid-template-columns:repeat(20,1fr); gap:3px; min-height:32px; }

.bae-signal { min-height:11px; border-radius:2px; background:#292c34; }

.bae-signal[data-state='fresh'] { background:#54d6c7; }

.bae-signal[data-state='warm'] { background:#ffb454; }

.bae-signal[data-state='old'] { background:#555b67; }

.bae-signal[data-state='hidden'] { opacity:.2; }

.bae-dashboard-note { display:none; }

.bae-file-results-panel { margin:8px 0 12px; border:1px solid #334155; border-radius:10px; background:#0b1220; overflow:hidden; }

.bae-album-meta { letter-spacing:.01em; }

.bae-video-quality { background:rgba(255,255,255,.025); }

@media (max-width:1180px) {

  .bae-command-main { grid-template-columns:1fr; }

  .bae-dashboard { grid-template-columns:1fr; grid-template-rows:auto; }

  .bae-dashboard-head,.bae-stat-grid,.bae-signal-label,.bae-signal-strip { grid-column:1; grid-row:auto; }

  .bae-dashboard-head { flex-direction:row; align-items:center; justify-content:space-between; }

  .bae-stat-grid { grid-template-columns:repeat(3,1fr); }

}

@media (max-width:720px) {

  html.bks-archive-page body main,

  html.bks-archive-page body main.cont { width:calc(100vw - 20px) !important; }

  .bae-command-center { position:relative; top:auto; }

  .bae-workspace > .grid { grid-template-columns:repeat(auto-fit,minmax(165px,1fr)) !important; gap:8px !important; }

  .bae-stat-grid { grid-template-columns:1fr 1fr; }

  .bae-command-group { flex-wrap:wrap; }

}

/* Fetched library: make discovery and the media itself the visual priority. */

.bae-command-center { position:relative; padding:0; overflow:hidden; border-radius:20px; background:#0d1015; box-shadow:0 22px 70px rgba(0,0,0,.34); }

.bae-discovery-hero { display:grid; grid-template-columns:minmax(270px,.72fr) minmax(420px,1.45fr); gap:28px; align-items:end; padding:24px 26px; background:radial-gradient(circle at 84% 0,rgba(39,207,184,.13),transparent 36%),linear-gradient(118deg,#11161c 0,#0b0e13 72%); border-bottom:1px solid #29313b; }

.bae-discovery-kicker { display:block; margin-bottom:9px; color:#4fe0ca; font:650 12px/1.2 system-ui,sans-serif; }

.bae-discovery-copy h2 { margin:0; color:#f7fafb; font:750 clamp(24px,2.1vw,38px)/1.04 system-ui,sans-serif; letter-spacing:-.035em; }

.bae-discovery-copy p { margin:10px 0 0; max-width:58ch; color:#929ba7; font:500 13px/1.55 system-ui,sans-serif; }

.bae-search-shell { display:grid; gap:8px; }

.bae-search-shell>label { color:#dce4e8; font:650 12px/1.25 system-ui,sans-serif; }

.bae-search-wrap { position:relative; }

.bae-search-icon { position:absolute; left:16px; top:50%; width:18px; height:18px; transform:translateY(-50%); color:#58dac8; pointer-events:none; }

.bae-global-filter { width:100%; min-height:58px!important; padding:0 108px 0 47px!important; border-color:#3f4d59!important; border-radius:14px!important; background:#171d24!important; color:#fff!important; font-size:16px!important; }

.bae-global-filter::placeholder { color:#727d88; }

.bae-search-shortcut { position:absolute; right:13px; top:50%; transform:translateY(-50%); padding:5px 8px; border:1px solid #3c4650; border-radius:7px; color:#8c98a3; font:650 10px/1 system-ui,sans-serif; }

.bae-search-submit { min-height:34px; padding:0 13px; border:1px solid #55cbbb; border-radius:9px; background:#12332f; color:#b8fff0; font:700 11px/1 system-ui,sans-serif; cursor:pointer; }

.bae-search-submit:hover { background:#19463f; }

.bae-search-hint { color:#78838e; font:500 11px/1.3 system-ui,sans-serif; }

.bae-command-main { padding:12px; }

.bae-command-sub { margin:0; padding:0 14px 11px; border:0; }

.bae-file-results-panel { margin:0 0 18px; border:1px solid #28343f; border-radius:18px; background:#0a0f15; box-shadow:0 24px 70px rgba(0,0,0,.25); }

.bae-file-results-panel.is-collapsed { box-shadow:0 12px 34px rgba(0,0,0,.2); }

.bae-results-head { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:16px 18px; border-bottom:1px solid #26313b; background:#10161d; }

.bae-results-head--focus { position:sticky; top:0; z-index:2; }

.bae-results-title { display:grid; gap:3px; }

.bae-results-title strong { color:#edf4f5; font:720 16px/1.2 system-ui,sans-serif; }

.bae-results-title span { color:#7e8b96; font:500 11px/1.35 system-ui,sans-serif; }

.bae-results-tools { display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end; }

.bae-result-search { width:min(260px,28vw); min-height:34px!important; padding:0 10px!important; border:1px solid #35424e!important; border-radius:9px!important; background:#171f27!important; color:#dce4e8!important; font:600 11px/1.2 system-ui,sans-serif!important; }

.bae-result-sort { min-height:34px; padding:0 30px 0 10px; border:1px solid #35424e; border-radius:9px; background:#171f27; color:#dce4e8; font:600 11px/1.2 system-ui,sans-serif; }

.bae-combined-toggle,.bae-duration-fetch,.bae-batch-fetch { min-height:34px; padding:0 10px; border:1px solid #3e716a; border-radius:9px; background:#102822; color:#86ebd8; font:700 10px/1 system-ui,sans-serif; cursor:pointer; }

.bae-batch-fetch:disabled { cursor:not-allowed; opacity:.48; }

.bae-combined-toggle.is-active { border-color:#b9ff2c; background:#21300f; color:#d7ff80; }

.bae-results-grid { max-height:min(76vh,790px); overflow:auto; padding:12px; display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:11px; }

.bae-file-results-panel .bae-results-grid { transition:max-height .26s ease,padding .26s ease,opacity .18s ease; }

.bae-file-results-panel.is-collapsed .bae-results-grid { max-height:0; min-height:0; padding-top:0; padding-bottom:0; opacity:0; overflow:hidden; pointer-events:none; }

.bae-file-results-panel.is-collapsed .bae-results-tools > :not(.bae-library-drawer-toggle) { display:none; }

.bae-file-results-panel.is-collapsed .bae-results-tools { margin-left:auto; }

.bae-library-drawer-toggle { min-height:34px; padding:0 10px; border:1px solid #445360; border-radius:9px; background:#151d25; color:#dbe4e7; font:700 10px/1 system-ui,sans-serif; cursor:pointer; }

.bae-library-drawer-toggle:hover { border-color:#69d9c6; color:#fff; }

.bae-result-card { position:relative; min-width:0; overflow:hidden; border:1px solid #27333e; border-radius:13px; background:#111820; transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease; }

.bae-result-card.is-selected { border-color:#67d8c9; box-shadow:0 0 0 1px rgba(103,216,201,.28),0 12px 30px rgba(0,0,0,.28); }

.bae-result-card:hover { transform:translateY(-2px); border-color:#4a746f; box-shadow:0 12px 30px rgba(0,0,0,.28); }

.bae-result-media { position:relative; aspect-ratio:16/10; overflow:hidden; background:#070a0e; cursor:pointer; }

.bae-result-select { position:absolute; z-index:2; top:8px; right:8px; display:inline-flex; align-items:center; gap:5px; padding:5px 7px; border:1px solid rgba(216,244,241,.26); border-radius:8px; background:rgba(7,12,16,.84); color:#e9f7f5; font:700 10px/1 system-ui,sans-serif; cursor:pointer; backdrop-filter:blur(8px); }

.bae-result-select input { width:13px; height:13px; accent-color:#62d8c6; cursor:pointer; }

.bae-result-import { border-color:#4fae88 !important; background:#123427 !important; color:#c5ffe1 !important; }

.bae-result-media img { width:100%; height:100%; display:block; object-fit:cover; transition:transform .28s ease; }

.bae-result-card:hover .bae-result-media img { transform:scale(1.025); }

.bae-result-media::after { content:'Play'; position:absolute; left:50%; top:50%; transform:translate(-50%,-45%); padding:8px 12px; border-radius:999px; background:rgba(5,10,14,.82); color:#fff; font:700 11px/1 system-ui,sans-serif; opacity:0; transition:.16s; }

.bae-result-card:hover .bae-result-media::after,.bae-result-media:focus-visible::after { opacity:1; transform:translate(-50%,-50%); }

.bae-result-badge { position:absolute; left:8px; bottom:8px; padding:4px 7px; border:1px solid rgba(255,255,255,.14); border-radius:7px; background:rgba(7,11,15,.78); color:#eaf2f3; font:700 10px/1 system-ui,sans-serif; }

.bae-result-body { display:grid; gap:8px; padding:10px; }

.bae-result-name { min-height:32px; overflow:hidden; color:#f0f4f5; font:650 12px/1.35 system-ui,sans-serif; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }

.bae-result-album { overflow:hidden; color:#49cfbd; font:600 10px/1.25 system-ui,sans-serif; white-space:nowrap; text-overflow:ellipsis; }

.bae-result-meta { color:#83909c; font:550 10px/1.2 system-ui,sans-serif; }

.bae-result-actions { display:flex; gap:6px; }

.bae-result-actions button,.bae-result-actions a { display:inline-flex; min-height:30px; align-items:center; justify-content:center; border:1px solid #35424e; border-radius:8px; background:#18212a; color:#dce5e7; font:650 10px/1 system-ui,sans-serif; text-decoration:none; cursor:pointer; }

.bae-result-actions button { flex:1; }.bae-result-actions a { width:32px; }

.bae-results-empty { padding:34px 18px; text-align:center; color:#84919d; font:500 13px/1.5 system-ui,sans-serif; }

.bae-combined-mode .bae-command-center,.bae-combined-mode .bae-workspace > .grid,.bae-combined-mode .bae-dashboard { display:none!important; }

.bae-combined-mode .bae-workspace { display:block; }

@media (max-width:1680px){.bae-results-grid{grid-template-columns:repeat(5,minmax(0,1fr))}}

@media (max-width:1380px){.bae-results-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}

@media (max-width:1080px){.bae-discovery-hero{grid-template-columns:1fr}.bae-results-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}

@media (max-width:720px){.bae-discovery-hero{grid-template-columns:1fr;padding:19px 16px;gap:18px}.bae-results-grid{grid-template-columns:repeat(2,minmax(0,1fr));padding:8px;gap:8px}.bae-results-head{align-items:flex-start;flex-direction:column}.bae-results-tools{width:100%;justify-content:flex-start}.bae-result-search{width:100%}.bae-search-shortcut{display:none}}

@media (max-width:430px){.bae-results-grid{grid-template-columns:1fr}}

@media (prefers-reduced-motion:reduce) { .bae-command-center button,.bae-result-card,.bae-result-media img,.bae-result-media::after { transition:none; } }

`;

      document.head.appendChild(style);

    }



    function addSortingControls() {

      if (document.querySelector('.bae-command-center')) return;

      injectArchiveControlStyles();

      const gridContainer = getAlbumsGridContainer(document);

      if (!gridContainer || !gridContainer.parentElement) return;

      const parent = gridContainer.parentElement;

      const controls = document.createElement('section');

      controls.className = 'bae-command-center';

      controls.innerHTML = `

<div class="bae-discovery-hero">

  <div class="bae-discovery-copy"><span class="bae-discovery-kicker">Your fetched Bunkr library</span><h2>Find the video, not the album.</h2><p>Index album and video titles first. Album thumbnails load with that index. Duration and playback stay on demand.</p></div>

  <div class="bae-search-shell"><label for="bae-library-search">Search fetched videos and album titles</label><div class="bae-search-wrap"><svg class="bae-search-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="m21 21-4.35-4.35m1.35-5.15A6.5 6.5 0 1 1 5 11.5a6.5 6.5 0 0 1 13 0Z"/></svg><input id="bae-library-search" class="bae-global-filter" type="search" autocomplete="off" placeholder="Search the fetched library: creator, scene, filename or album…"><span class="bae-search-shortcut">Press /</span></div><button class="bae-search-submit" type="button">Search fetched library</button><span class="bae-search-hint">Type freely, then press Enter or Search to filter the fetched library.</span></div>

</div>

<div class="bae-command-main">

  <div class="bae-command-group">

    <label class="bae-field"><span>Albums</span><input class="bae-fetch-count" type="number" min="1" max="200" value="100" title="Visible albums to fetch"></label>

    <button class="bae-primary bae-fetch">Index visible</button>

    <button class="bae-hover-toggle" title="Expand album contents when the pointer rests over a card">Hover previews: OFF</button>

  </div>

  <div class="bae-command-group bae-command-group--refine">

    <label class="bae-field"><span>Min videos</span><input class="bae-min-count" type="number" min="0" value="0"></label>

    <label class="bae-field"><span>Min size</span><input class="bae-min-size" type="text" placeholder="1 GB"></label>

    <label class="bae-field"><span>Updated</span><select class="bae-updated-within"><option value="0">Any time</option><option value="7">7 days</option><option value="14">2 weeks</option><option value="30">1 month</option><option value="90">3 months</option><option value="180">6 months</option></select></label>

    <label class="bae-field"><span>Estimate</span><select class="bae-quality-min"><option value="0">Any</option><option value="1">Standard+</option><option value="2">High+</option><option value="3">Very high</option></select></label>

    <button class="bae-apply">Apply filters</button>

  </div>

  <div class="bae-command-group">

    <label class="bae-field bae-field--grow"><span>Sort</span><select class="bae-sort"><option value="default">Default</option><option value="newest">Newest update</option><option value="size">Largest videos</option><option value="count">Most videos</option><option value="name">Name A–Z</option><option value="oldest">Oldest first</option></select></label>

    <button class="bae-reset">Reset</button>

  </div>

</div>

<div class="bae-command-sub">

  <span class="bae-command-title">Presets</span>

  <button class="bae-preset" data-preset="fresh">Fresh videos</button>

  <button class="bae-preset" data-preset="large">Large recent</button>

  <button class="bae-preset" data-preset="quality">High estimate</button>

  <span class="bae-status-text">Ready to scan</span>

</div>`;



      const fetchCount = controls.querySelector('.bae-fetch-count');

      const globalFilter = controls.querySelector('.bae-global-filter');

      const minCountInput = controls.querySelector('.bae-min-count');

      const minSizeInput = controls.querySelector('.bae-min-size');

      const updatedWithinSelect = controls.querySelector('.bae-updated-within');

      const qualityMinSelect = controls.querySelector('.bae-quality-min');

      const sortSelect = controls.querySelector('.bae-sort');

      const hoverToggleBtn = controls.querySelector('.bae-hover-toggle');

      const applyFilters = () => window.dispatchEvent(new CustomEvent('bae-min-filter', {

        detail: {

          minCount: parseInt(minCountInput.value || '0', 10) || 0,

          minSizeRaw: (minSizeInput.value || '').trim(),

          updatedWithinDays: parseInt(updatedWithinSelect.value || '0', 10) || 0,

          qualityMin: parseInt(qualityMinSelect.value || '0', 10) || 0,

        }

      }));



      controls.querySelector('.bae-fetch').addEventListener('click', () => {

        const value = parseInt(fetchCount.value || '100', 10);

        window.dispatchEvent(new CustomEvent('bae-fetch-visible', { detail: Number.isFinite(value) ? value : 100 }));

      });

      const submitGlobalSearch = () => window.dispatchEvent(new CustomEvent('bae-global-filter', { detail: globalFilter.value || '' }));

      controls.querySelector('.bae-search-submit').addEventListener('click', submitGlobalSearch);

      globalFilter.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitGlobalSearch(); } });

      controls.querySelector('.bae-apply').addEventListener('click', applyFilters);

      [minCountInput, minSizeInput, updatedWithinSelect, qualityMinSelect].forEach((input) => input.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyFilters(); }));

      sortSelect.addEventListener('change', () => sortAlbums(sortSelect.value));

      const renderHoverToggle = (enabled) => {

        hoverToggleBtn.textContent = `Hover previews: ${enabled ? 'ON' : 'OFF'}`;

        hoverToggleBtn.classList.toggle('is-on', enabled);

        hoverToggleBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');

      };

      renderHoverToggle(localStorage.getItem(STORAGE_KEYS.hoverPreviews) === '1');

      hoverToggleBtn.addEventListener('click', () => {

        const enabled = localStorage.getItem(STORAGE_KEYS.hoverPreviews) !== '1';

        localStorage.setItem(STORAGE_KEYS.hoverPreviews, enabled ? '1' : '0');

        renderHoverToggle(enabled);

        window.dispatchEvent(new CustomEvent('bae-hover-previews', { detail: enabled }));

      });

      controls.querySelector('.bae-reset').addEventListener('click', () => {

        globalFilter.value = ''; minCountInput.value = '0'; minSizeInput.value = ''; updatedWithinSelect.value = '0'; qualityMinSelect.value = '0'; sortSelect.value = 'default';

        window.dispatchEvent(new CustomEvent('bae-global-filter', { detail: '' })); applyFilters(); sortAlbums('default');

      });

      controls.querySelectorAll('.bae-preset').forEach((button) => button.addEventListener('click', () => {

        const preset = button.dataset.preset;

        if (preset === 'fresh') { minCountInput.value = '5'; minSizeInput.value = ''; updatedWithinSelect.value = '14'; qualityMinSelect.value = '0'; sortSelect.value = 'newest'; }

        if (preset === 'large') { minCountInput.value = '5'; minSizeInput.value = '1 GB'; updatedWithinSelect.value = '30'; qualityMinSelect.value = '0'; sortSelect.value = 'size'; }

        if (preset === 'quality') { minCountInput.value = '3'; minSizeInput.value = ''; updatedWithinSelect.value = '90'; qualityMinSelect.value = '2'; sortSelect.value = 'size'; }

        applyFilters(); sortAlbums(sortSelect.value);

      }));

      window.addEventListener('bae-status', (e) => { controls.querySelector('.bae-status-text').textContent = (e && e.detail) || 'Ready'; });



      parent.insertBefore(controls, gridContainer);

      let fileResults = parent.querySelector('.bae-file-results-panel');

      if (!fileResults) { fileResults = document.createElement('div'); fileResults.className = 'bae-file-results-panel'; fileResults.style.display = 'none'; parent.insertBefore(fileResults, gridContainer); }

      const workspace = document.createElement('div');

      workspace.className = 'bae-workspace';

      parent.insertBefore(workspace, gridContainer);

      workspace.appendChild(gridContainer);

      const dashboard = document.createElement('aside');

      dashboard.className = 'bae-dashboard';

      dashboard.innerHTML = `<div class="bae-dashboard-head"><span class="bae-dashboard-title">Album signal</span><span class="bae-dashboard-live">local scan</span></div><div class="bae-stat-grid"><div class="bae-stat"><strong data-stat="fetched">0</strong><span>Fetched</span></div><div class="bae-stat"><strong data-stat="visible">0</strong><span>Visible</span></div><div class="bae-stat"><strong data-stat="videos">0</strong><span>Videos</span></div><div class="bae-stat"><strong data-stat="size">0 B</strong><span>Video size</span></div><div class="bae-stat"><strong data-stat="fresh">0</strong><span>Updated ≤30d</span></div><div class="bae-stat"><strong data-stat="quality">0</strong><span>High estimate</span></div></div><div class="bae-signal-label"><span>100-album signal</span><span>fresh → old</span></div><div class="bae-signal-strip"></div><p class="bae-dashboard-note">Signals are calculated locally from fetched video metadata. Quality is an estimate based on average size per video.</p>`;

      workspace.appendChild(dashboard);

    }



    function sortAlbums(method) {

      const container = getAlbumsGridContainer(document);

      if (!container) return;



      const albums = Array.from(container.children);

      if (method === 'name') {

        albums.sort((a, b) => {

          const nameA = getAlbumTitleFromCard(a).toLowerCase();

          const nameB = getAlbumTitleFromCard(b).toLowerCase();

          return nameA.localeCompare(nameB);

        });

      } else if (method === 'count') {

        albums.sort((a, b) => {

          const countA = getAlbumFileCountFromCard(a);

          const countB = getAlbumFileCountFromCard(b);

          return countB - countA;

        });

      } else if (method === 'oldest') {

        albums.sort((a, b) => {

          const dateA = parseInt(a.dataset.oldestDate || '0');

          const dateB = parseInt(b.dataset.oldestDate || '0');

          return dateA - dateB;

        });

      } else if (method === 'newest') {

        albums.sort((a, b) => {

          const dateA = parseInt(a.dataset.newestDate || '0');

          const dateB = parseInt(b.dataset.newestDate || '0');

          return dateB - dateA;

        });

      } else if (method === 'size') {

        albums.sort((a, b) => {

          const sizeA = parseFloat(a.dataset.totalSizeBytes || '0');

          const sizeB = parseFloat(b.dataset.totalSizeBytes || '0');

          return sizeB - sizeA;

        });

      } else {

        return;

      }



      albums.forEach((album) => container.appendChild(album));

    }



    // Helper function to parse file size to bytes

    function parseSizeToBytes(sizeStr) {

      if (!sizeStr) return 0;

      const normalized = sizeStr.replace(',', '.');

      const match = normalized.match(/([\d.]+)\s*(TB|GB|MB|KB|B)/i);

      if (!match) return 0;

      const value = parseFloat(match[1]);

      const unit = match[2].toUpperCase();

      const multipliers = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024, TB: 1024 * 1024 * 1024 * 1024 };

      return value * (multipliers[unit] || 0);

    }



    // Helper function to format bytes to human-readable size

    function formatBytes(bytes) {

      if (bytes === 0) return '0 B';

      if (bytes < 1024) return bytes + ' B';

      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';

      if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';

      if (bytes < 1024 * 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';

      return (bytes / (1024 * 1024 * 1024 * 1024)).toFixed(2) + ' TB';

    }



    // This is an estimate only: without video duration we cannot derive bitrate

    // or resolution. Average bytes per video is still useful for a quick scan.

    function getVideoQualityEstimate(totalBytes, videoCount) {

      if (!totalBytes || !videoCount) return null;

      const averageBytes = totalBytes / videoCount;

      const mb = averageBytes / (1024 * 1024);

      if (mb < 150) return { label: 'Light', color: '#fbbf24', averageBytes };

      if (mb < 500) return { label: 'Standard', color: '#60a5fa', averageBytes };

      if (mb < 1500) return { label: 'High', color: '#4ade80', averageBytes };

      return { label: 'Very high', color: '#c084fc', averageBytes };

    }



    function getVideoQualityLevel(totalBytes, videoCount) {

      const estimate = getVideoQualityEstimate(totalBytes, videoCount);

      if (!estimate) return 0;

      return estimate.label === 'Very high' ? 3 : estimate.label === 'High' ? 2 : estimate.label === 'Standard' ? 1 : 0;

    }



    function extractSizeFromText(text) {

      if (!text) return '';

      const match = text.match(/([\d.,]+)\s*(TB|GB|MB|KB|B)\b/i);

      if (!match) return '';

      return `${match[1].replace(',', '.')} ${match[2].toUpperCase()}`;

    }



    function extractDateFromText(text) {

      if (!text) return '';

      const match = text.match(/\d{2}:\d{2}:\d{2}\s+\d{2}\/\d{2}\/\d{4}/);

      return match ? match[0] : '';

    }



    function getNormalizedAlbumUrl(url) {

      if (!url) return '';

      try {

        const u = new URL(url);

        u.hash = '';

        u.search = '';

        return u.toString().replace(/\/+$/, '');

      } catch {

        return (url || '').replace(/[?#].*$/, '').replace(/\/+$/, '');

      }

    }



    function getAlbumRootKey(url) {

      const normalized = getNormalizedAlbumUrl(url);

      try {

        const parsed = new URL(normalized);

        const parts = parsed.pathname.split('/').filter(Boolean);

        if (parts.length > 2 && /^\d+$/.test(parts[parts.length - 1])) parts.pop();

        return `${parsed.origin}/${parts.join('/')}`;

      } catch {

        return normalized;

      }

    }



    function getAlbumDedupKeyFromCard(card) {

      if (!card) return '';



      const link = card.querySelector("a[href*='/a/']") || card.querySelector("a[href^='https://bunkr.']");

      if (link && link.href) {

        try {

          const parsed = new URL(link.href);

          const parts = parsed.pathname.split('/').filter(Boolean);

          if (parts.length > 2 && /^\d+$/.test(parts[parts.length - 1])) parts.pop();

          const pathKey = `/${parts.join('/')}`;

          if (pathKey && pathKey !== '/') return pathKey.toLowerCase();

        } catch {

          const href = link.getAttribute('href') || '';

          const pathOnly = href.replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '').replace(/\/+$/, '');

          const parts = pathOnly.split('/').filter(Boolean);

          if (parts.length > 2 && /^\d+$/.test(parts[parts.length - 1])) parts.pop();

          const cleaned = `/${parts.join('/')}`;

          if (cleaned) return cleaned.toLowerCase();

        }

      }



      const title = getAlbumTitleFromCard(card).toLowerCase();

      const meta = (card.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();

      return `${title}::${meta}`;

    }



    // Decode XOR-encrypted URL returned by Bunkr /api/vs (mirrors player.enc.js logic)

    function decodeBunkrUrl(encoded, timestamp) {

      try {

        const raw = atob(encoded);

        const ts = Number(timestamp || 0);

        const key = `SECRET_KEY_${Math.floor(ts / 3600)}`;

        let out = '';

        for (let i = 0; i < raw.length; i++) {

          out += String.fromCharCode(raw.charCodeAt(i) ^ key.charCodeAt(i % key.length));

        }

        return out;

      } catch (e) {

        return null;

      }

    }



    function postJsonCrossOrigin(url, payload, headers = {}) {

      return new Promise((resolve, reject) => {

        if (typeof GM_xmlhttpRequest !== 'function') {

          fetch(url, {

            method: 'POST',

            headers: {

              'Content-Type': 'application/json',

              'Accept': 'application/json',

              ...headers,

            },

            body: JSON.stringify(payload),

          })

            .then((response) => {

              if (!response.ok) throw new Error(`HTTP ${response.status}`);

              return response.json();

            })

            .then(resolve)

            .catch(reject);

          return;

        }



        GM_xmlhttpRequest({

          method: 'POST',

          url,

          headers: {

            'Content-Type': 'application/json',

            'Accept': 'application/json',

            ...headers,

          },

          data: JSON.stringify(payload),

          onload: (response) => {

            if (response.status < 200 || response.status >= 300) {

              reject(new Error(`HTTP ${response.status}`));

              return;

            }

            try {

              resolve(JSON.parse(response.responseText || '{}'));

            } catch (error) {

              reject(error);

            }

          },

          onerror: () => reject(new Error('Cross-origin request failed')),

          ontimeout: () => reject(new Error('Cross-origin request timed out')),

        });

      });

    }



    function fetchTextCrossOrigin(url, options = {}) {

      const method = options.method || 'GET';

      const headers = options.headers || {};

      return new Promise((resolve, reject) => {

        if (typeof GM_xmlhttpRequest !== 'function') {

          fetch(url, { method, headers, body: options.body })

            .then(async (response) => resolve({ ok: response.ok, status: response.status, text: await response.text() }))

            .catch(reject);

          return;

        }

        GM_xmlhttpRequest({

          method,

          url,

          headers,

          data: options.body,

          timeout: options.timeout || 12000,

          onload: (response) => resolve({

            ok: response.status >= 200 && response.status < 300,

            status: response.status,

            text: response.responseText || '',

          }),

          onerror: () => reject(new Error('Cross-origin request failed')),

          ontimeout: () => reject(new Error('Cross-origin request timed out')),

        });

      });

    }



    function cleanPlayableMediaUrl(candidate, baseUrl = '') {

      if (!candidate) return '';

      let value = String(candidate)

        .trim()

        .replace(/^['"]+|['"]+$/g, '')

        .replace(/\\u0026/gi, '&')

        .replace(/\\\//g, '/')

        .replace(/\\/g, '/')

        .replace(/&amp;/gi, '&');

      if (value.startsWith('//')) value = 'https:' + value;

      try {

        const url = new URL(value, baseUrl || undefined).href;

        const lower = url.toLowerCase();

        const isVideo = /\.(mp4|mkv|mov|webm|m4v|avi|m3u8)(\?|$)/i.test(lower)

          || lower.includes('media-files') || lower.includes('scdn.st') || lower.includes('get.bunkr');

        return isVideo ? url : '';

      } catch {

        return '';

      }

    }



    function mediaUrlFromResponse(data, baseUrl) {

      return cleanPlayableMediaUrl(data?.url || data?.data?.url || data?.stream?.url, baseUrl);

    }



    const bunkrStreamCache = new Map();



    // Resolve a Bunkr file landing page to its short-lived, directly playable CDN URL.

    async function resolveBunkrStreamUrl(filePageUrl) {

      const cached = bunkrStreamCache.get(filePageUrl);

      if (cached && Date.now() - cached.createdAt < 4 * 60 * 1000) return cached.url;



      const parsed = new URL(filePageUrl);

      const pathParts = parsed.pathname.split('/').filter(Boolean);

      if (pathParts.length < 2 || !['f', 'v'].includes(pathParts[0])) {

        const directUrl = cleanPlayableMediaUrl(filePageUrl);

        if (directUrl) return directUrl;

        throw new Error('This item does not have a playable Bunkr video URL.');

      }

      const slug = pathParts[1];

      const slugNoExt = slug.replace(/\.(mp4|mkv|mov|webm|m4v|avi|ts)$/i, '');

      const origin = parsed.origin;

      const headers = { 'Referer': filePageUrl, 'Origin': origin };

      let streamUrl = '';



      for (const currentSlug of [...new Set([slugNoExt, slug])]) {

        const data = await postJsonCrossOrigin(`${origin}/api/vs`, { slug: currentSlug }, headers).catch(() => null);

        let candidate = data?.url;

        if (candidate && data?.encrypted) candidate = decodeBunkrUrl(candidate, Number(data.timestamp) || 0);

        streamUrl = cleanPlayableMediaUrl(candidate, origin);

        if (streamUrl) break;

      }



      if (!streamUrl) {

        const signed = await fetchTextCrossOrigin(`${origin}/api/sign?v=${encodeURIComponent(slugNoExt)}`, {

          headers: { 'Accept': 'application/json', 'Referer': filePageUrl },

        }).catch(() => null);

        if (signed?.ok) {

          try { streamUrl = mediaUrlFromResponse(JSON.parse(signed.text), origin); } catch { }

        }

      }



      if (!streamUrl) {

        const signed = await postJsonCrossOrigin(`${origin}/api/sign`, { v: slugNoExt, slug: slugNoExt }, headers).catch(() => null);

        streamUrl = mediaUrlFromResponse(signed, origin);

      }



      if (!streamUrl) {

        const page = await fetchTextCrossOrigin(filePageUrl, {

          headers: { 'Accept': 'text/html,application/xhtml+xml', 'Referer': origin + '/' },

        }).catch(() => null);

        if (page?.ok) {

          const html = page.text;

          const match = html.match(/(?:jsCDN|signUrl)\s*[:=]\s*["']([^"']+)["']/i)

            || html.match(/<(?:source|video)[^>]+src=["']([^"']+)["']/i)

            || html.match(/["'](https?:\/\/[^"'\s]+(?:\.(?:mp4|mkv|mov|webm|m4v|avi|m3u8)|media-files|scdn\.st|get\.bunkr)[^"'\s]*)["']/i);

          streamUrl = cleanPlayableMediaUrl(match?.[1], origin);

        }

      }



      if (!streamUrl) throw new Error('Unable to resolve a playable stream for this Bunkr file.');

      bunkrStreamCache.set(filePageUrl, { url: streamUrl, createdAt: Date.now() });

      return streamUrl;

    }



    async function startVideoPlayback(videoEl, isCurrent = () => true) {

      if (!videoEl || !isCurrent()) return;

      videoEl.autoplay = true;

      videoEl.playsInline = true;

      videoEl.controls = true;

      try {

        await videoEl.play();

      } catch (error) {

        if (!isCurrent() || error.name !== 'NotAllowedError') return;

        videoEl.muted = true;

        try { await videoEl.play(); } catch { /* browser still blocked */ }

      }

    }



    // Helper function to parse Bunkr date format (HH:MM:SS DD/MM/YYYY)

    function parseBunkrDate(dateStr) {

      if (!dateStr) return null;

      // Match format like "16:43:15 12/02/2026" or "03:41:49 12/02/2026"

      const match = dateStr.match(/(\d{2}):(\d{2}):(\d{2})\s+(\d{2})\/(\d{2})\/(\d{4})/);

      if (!match) return null;

      const [, hours, minutes, seconds, day, month, year] = match;

      // JavaScript Date: month is 0-indexed

      return new Date(year, month - 1, day, hours, minutes, seconds);

    }



    const BAE_BRIDGE_CHANNEL = 'NEXUS_BAE_BRIDGE';

    const BAE_BRIDGE_VERSION = 1;

    const BAE_BRIDGE_DEBUG = true;

    function baeBridgeDebug(...args) {

      if (!BAE_BRIDGE_DEBUG) return;

      try {

        console.log('[BAE Userscript Bridge]', ...args);

      } catch { }

    }

    const BAE_BRIDGE_MAX_EXPORT_ALBUMS = 25;

    const BAE_BRIDGE_MAX_ROWS_PER_ALBUM = 20;

    const BAE_BRIDGE_MAX_TOTAL_ROWS = 400;

    const BAE_BRIDGE_EXTENSION_TYPES = new Set([

      'BAE_GET_STATE',

      'BAE_GET_SELECTION',

      'BAE_GET_CACHE_EXPORT',

      'BAE_FETCH_SELECTED',

      'BAE_PLAY_FILE',

      'BAE_COMPARE_SET',

    ]);



    function createBridgeEnvelope(source, type, requestId, payload = {}) {

      return {

        channel: BAE_BRIDGE_CHANNEL,

        version: BAE_BRIDGE_VERSION,

        source,

        type,

        requestId,

        ts: Date.now(),

        payload: payload && typeof payload === 'object' ? payload : {},

      };

    }



    class BaeExtensionBridge {

      constructor(app) {

        this.app = app;

        this.isReady = false;

        this.boundMessageHandler = (event) => this.handleWindowMessage(event);

        window.addEventListener('message', this.boundMessageHandler);

        // Marker for quick verification from page console.

        window.__BAE_USERSCRIPT_BRIDGE_ACTIVE__ = true;

        baeBridgeDebug('listener-attached');

      }



      setReady() {

        this.isReady = true;

        baeBridgeDebug('ready');

        this.emitReady();

      }



      emitReady() {

        this.postToWindow('BAE_BRIDGE_READY', `bridge-ready-${Date.now()}`, {

          ready: true,

          capabilities: Array.from(BAE_BRIDGE_EXTENSION_TYPES),

        });

      }



      postToWindow(type, requestId, payload = {}) {

        baeBridgeDebug('post', { type, requestId });

        window.postMessage(createBridgeEnvelope('bae-userscript', type, requestId, payload), window.location.origin);

      }



      postError(requestId, code, message, details = null) {

        const payload = { code, message };

        if (details && typeof details === 'object') payload.details = details;

        this.postToWindow('BAE_ERROR', requestId, payload);

      }



      isValidEnvelope(data) {

        return !!(

          data &&

          typeof data === 'object' &&

          data.channel === BAE_BRIDGE_CHANNEL &&

          data.version === BAE_BRIDGE_VERSION &&

          data.source === 'nexus-extension' &&

          typeof data.type === 'string' &&

          typeof data.requestId === 'string' &&

          data.requestId.trim() &&

          typeof data.ts === 'number' &&

          data.payload &&

          typeof data.payload === 'object'

        );

      }



      handleWindowMessage(event) {

        // In userscript sandboxes (Tampermonkey/Violentmonkey), event.source can be

        // a wrapped/proxied window object. Do not hard-filter by source identity.

        const data = event.data;

        if (!data || typeof data !== 'object') return;

        if (data.channel !== BAE_BRIDGE_CHANNEL) return;

        if (data.source !== 'nexus-extension') return;

        baeBridgeDebug('recv', { type: data.type, requestId: data.requestId });



        if (!this.isValidEnvelope(data)) {

          if (typeof data.requestId === 'string' && data.requestId.trim()) {

            this.postError(data.requestId, 'INVALID_ENVELOPE', 'Bridge envelope validation failed.');

          }

          return;

        }



        if (!this.isReady) {

          this.postError(data.requestId, 'BRIDGE_NOT_READY', 'Userscript bridge is not ready yet.');

          return;

        }



        if (!BAE_BRIDGE_EXTENSION_TYPES.has(data.type)) return;

        this.handleRequest(data).catch((error) => {

          this.postError(data.requestId, 'INTERNAL_ERROR', error?.message || 'Unexpected bridge error.');

        });

      }



      validatePlayPayload(payload) {

        return !!(payload && typeof payload.url === 'string' && payload.url.trim());

      }



      validateComparePayload(payload) {

        return !!(

          payload &&

          (payload.slot === 'A' || payload.slot === 'B') &&

          typeof payload.url === 'string' &&

          payload.url.trim()

        );

      }



      buildCacheExport(payload) {

        const includeRows = !!payload.includeRows;

        const requestedLimit = parseInt(payload.limit || `${BAE_BRIDGE_MAX_EXPORT_ALBUMS}`, 10);

        const albumLimit = Math.max(1, Math.min(BAE_BRIDGE_MAX_EXPORT_ALBUMS, Number.isFinite(requestedLimit) ? requestedLimit : BAE_BRIDGE_MAX_EXPORT_ALBUMS));

        const requestedRowsPerAlbum = parseInt(payload.rowsPerAlbum || `${BAE_BRIDGE_MAX_ROWS_PER_ALBUM}`, 10);

        const rowsPerAlbum = Math.max(1, Math.min(BAE_BRIDGE_MAX_ROWS_PER_ALBUM, Number.isFinite(requestedRowsPerAlbum) ? requestedRowsPerAlbum : BAE_BRIDGE_MAX_ROWS_PER_ALBUM));

        const cacheEntries = Array.from(this.app.albumCache.values())

          .sort((a, b) => (b.newestTimestamp || 0) - (a.newestTimestamp || 0));

        let totalRowsIncluded = 0;



        const albums = cacheEntries.slice(0, albumLimit).map((entry) => {

          const base = {

            albumUrl: entry.albumUrl,

            albumDomain: entry.albumDomain,

            albumName: entry.albumName,

            fileCount: entry.fileCount,

            totalBytes: entry.totalBytes || 0,

            oldestTimestamp: entry.oldestTimestamp || 0,

            newestTimestamp: entry.newestTimestamp || 0,

          };

          if (!includeRows) return base;



          const remaining = Math.max(0, BAE_BRIDGE_MAX_TOTAL_ROWS - totalRowsIncluded);

          const localLimit = Math.min(rowsPerAlbum, remaining);

          const files = localLimit > 0

            ? (entry.files || []).slice(0, localLimit).map((file) => ({

              href: file.href,

              title: file.title || '',

              size: file.size || '',

              isVideo: !!file.isVideo,

              thumbSrc: file.thumbSrc || '',

              timestamp: file.timestamp || 0,

            }))

            : [];

          totalRowsIncluded += files.length;

          return {

            ...base,

            files,

            rowsReturned: files.length,

          };

        });



        return {

          includeRows,

          limit: albumLimit,

          rowsPerAlbum: includeRows ? rowsPerAlbum : 0,

          totalAlbums: cacheEntries.length,

          returnedAlbums: albums.length,

          totalRowsIncluded,

          albums,

        };

      }



      emitFetchProgress(requestId, stage, extra = {}) {

        this.postToWindow('BAE_FETCH_PROGRESS', requestId || `fetch-progress-${Date.now()}`, {

          stage,

          ...extra,

        });

      }



      async handleRequest(message) {

        const { type, requestId, payload } = message;

        switch (type) {

          case 'BAE_GET_STATE':

            this.postToWindow('BAE_STATE', requestId, this.app.getBridgeStateSnapshot());

            return;

          case 'BAE_GET_SELECTION':

            this.postToWindow('BAE_SELECTION', requestId, this.app.getBridgeSelectionSnapshot());

            return;

          case 'BAE_GET_CACHE_EXPORT':

            this.postToWindow('BAE_CACHE_EXPORT', requestId, this.buildCacheExport(payload || {}));

            return;

          case 'BAE_FETCH_SELECTED': {

            await this.app.fetchSelectedAlbums({ requestId, emitBridgeProgress: true });

            this.postToWindow('BAE_OK', requestId, {

              action: type,

              state: this.app.getBridgeStateSnapshot(),

            });

            return;

          }

          case 'BAE_PLAY_FILE': {

            if (!this.validatePlayPayload(payload)) {

              this.postError(requestId, 'INVALID_PAYLOAD', 'BAE_PLAY_FILE requires payload.url.');

              return;

            }

            await this.app.openPlayerModal(payload.url, payload.title || 'Untitled');

            this.postToWindow('BAE_OK', requestId, {

              action: type,

              url: payload.url,

              title: payload.title || 'Untitled',

            });

            return;

          }

          case 'BAE_COMPARE_SET': {

            if (!this.validateComparePayload(payload)) {

              this.postError(requestId, 'INVALID_PAYLOAD', 'BAE_COMPARE_SET requires payload.slot and payload.url.');

              return;

            }

            await this.app.setCompareSlot(payload.slot, payload.url, payload.title || 'Untitled');

            this.postToWindow('BAE_OK', requestId, {

              action: type,

              slot: payload.slot,

              url: payload.url,

              title: payload.title || 'Untitled',

              compareSlots: this.app.getBridgeStateSnapshot().compareSlots,

            });

            return;

          }

          default:

            return;

        }

      }

    }



    class BunkrAlbumsEnhanced {

      constructor() {

        this.nextPage = 2;

        this.loading = false;

        this.previewTimeout = null;

        this.domObserver = null;

        this.reconcileTimer = null;

        this.albumCache = new Map();

        this.persistentAlbumCache = { version: PERSISTENT_CACHE_VERSION, entries: {} };

        this.persistentCacheSaveTimer = null;

        this.selectedAlbumUrls = new Set();

        this.selectedFetchedVideoUrls = new Set();

        this.activeGlobalFilter = '';

        this.activeMinCount = 0;

        this.activeMinSizeBytes = 0;

        this.activeUpdatedWithinDays = 0;

        this.activeQualityMin = 0;

        this.selectionMode = false;

        this.resultSort = localStorage.getItem(STORAGE_KEYS.resultSort) || 'newest';

        this.searchRenderTimer = null;

        this.libraryRenderTimer = null;

        this.combinedView = false;

        this.libraryDrawerCollapsed = localStorage.getItem(STORAGE_KEYS.libraryCollapsed) === '1';

        // Expanding a whole album inside a grid card causes severe layout

        // shift. Keep it opt-in; users can enable it from the command bar.

        this.hoverPreviewsEnabled = localStorage.getItem(STORAGE_KEYS.hoverPreviews) === '1';

        this.compareSlots = { A: null, B: null };

        this.playerModal = null;

        this.floatingPlayers = null;

        this.isTopAlbumsPage = window.location.pathname.includes('/topalbums');

        this.initialized = false;



        // Register bridge listener early so extension requests are not missed

        // while init() is still wiring UI/observers on heavy pages.

        this.bridge = new BaeExtensionBridge(this);

        this.bridge.setReady();

        // Let the result thumbnails start before we parse the album cache or move the grid.

        setTimeout(() => releaseSearchThumbs(), 0);

        const boot = () => {

          this.persistentAlbumCache = loadPersistentAlbumCache();

          this.init();

        };

        if (typeof requestIdleCallback === 'function') requestIdleCallback(boot, { timeout: 700 });

        else setTimeout(boot, 50);

      }



      init() {

        releaseSearchThumbs();

        const containerReady = getAlbumsGridContainer(document);

        if (!containerReady) {

          setTimeout(() => this.init(), 350);

          return;

        }

        if (this.initialized) return;

        this.initialized = true;



        this.setupInfiniteScroll();

        this.setupAllHoverPreviews();

        this.dedupeAlbums();

        this.observeAlbumContainer();

        addSortingControls();

        this.hydrateVisibleAlbumsFromPersistentCache();

        this.updateDashboard();

        window.addEventListener('bae-global-filter', (e) => {

          this.activeGlobalFilter = (e && e.detail) || '';

          clearTimeout(this.searchRenderTimer);

          this.searchRenderTimer = setTimeout(() => this.applyGlobalFilter(this.activeGlobalFilter), 90);

        });

        window.addEventListener('bae-min-filter', (e) => {

          const { minCount, minSizeRaw, updatedWithinDays, qualityMin } = e?.detail || {};

          this.activeMinCount = parseInt(minCount || '0', 10) || 0;

          this.activeMinSizeBytes = parseSizeToBytes(minSizeRaw || '') || 0;

          this.activeUpdatedWithinDays = parseInt(updatedWithinDays || '0', 10) || 0;

          this.activeQualityMin = parseInt(qualityMin || '0', 10) || 0;

          this.applyGlobalFilter(this.activeGlobalFilter);

          const hidden = Array.from(getAlbumsGridContainer(document)?.children || []).filter(a => a.style.display === 'none').length;

          this.emitStatus(`Filters applied — ${hidden} albums hidden.`);

        });

        window.addEventListener('bae-hover-previews', (e) => {

          this.hoverPreviewsEnabled = e?.detail === true;

          clearTimeout(this.previewTimeout);

          if (!this.hoverPreviewsEnabled) {

            this.qsa('.album-preview-flex').forEach((container) => {

              container.style.display = 'none';

            });

          }

          this.emitStatus(`Hover previews ${this.hoverPreviewsEnabled ? 'enabled' : 'disabled'}.`);

        });

        window.addEventListener('bae-fetch-visible', async (e) => {

          const count = parseInt((e && e.detail) || '100', 10);

          await this.fetchVisibleAlbums(Number.isFinite(count) ? count : 100);

        });

        const paintLibrary = () => this.renderGlobalFileResults([]);

        if (typeof requestIdleCallback === 'function') requestIdleCallback(paintLibrary, { timeout: 400 });

        else setTimeout(paintLibrary, 0);

        document.addEventListener('keydown', (e) => this.handleGlobalShortcuts(e));

      }



      handleGlobalShortcuts(e) {

        if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {

          const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';

          if (tag !== 'input' && tag !== 'textarea') {

            e.preventDefault();

            const input = this.qs('.bae-global-filter');

            if (input) input.focus();

          }

        }



        if (e.key === 'Escape') {

          this.closePlayerModal();

          this.closeFloatingPlayers();

        }

      }



      initStickySelectionBar() {

        const bar = this.qs('.bae-sticky-selection-bar');

        if (!bar || bar.dataset.initialized === '1') return;

        bar.dataset.initialized = '1';



        const count = document.createElement('span');

        count.className = 'bae-sticky-count';

        count.style = 'color: #e2e8f0; font-size: 12px;';



        const clearBtn = document.createElement('button');

        clearBtn.textContent = 'Clear';

        clearBtn.style = 'padding: 6px 8px; border-radius: 7px; border: 1px solid #475569; background: #1e293b; color: #f8fafc; font-size: 11px; cursor: pointer;';

        clearBtn.addEventListener('click', () => this.clearAlbumSelection());



        bar.append(count, clearBtn);

      }



      updateSelectionBar() {

        const bar = this.qs('.bae-sticky-selection-bar');

        if (!bar) return;

        const count = this.qs('.bae-sticky-count', bar);

        if (count) count.textContent = `Selected: ${this.selectedAlbumUrls.size}`;

        bar.style.display = this.selectedAlbumUrls.size > 0 ? 'inline-flex' : 'none';

      }



      qs(selector, el = document) {

        return el.querySelector(selector);

      }



      qsa(selector, el = document) {

        return Array.from(el.querySelectorAll(selector));

      }



      getCurrentParams() {

        const params = new URLSearchParams(window.location.search);

        return this.isTopAlbumsPage ? { lapse: params.get('lapse') || '24h', page: this.nextPage } : { search: params.get('search') || '', page: this.nextPage };

      }



      getAlbumDomain(albumUrl) {

        const match = albumUrl.match(/https:\/\/(bunkr\.[a-z]+)/);

        return match ? match[1] : 'bunkr.cr';

      }



      setupInfiniteScroll() {

        if (!this.isLastPage()) {

          window.addEventListener('scroll', this.handleScroll.bind(this));

        }

      }



      isLastPage() {

        return !!this.qs('.text-center.text-xs.text-subtle');

      }



      handleScroll() {

        if (this.loading) return;

        const scrollPosition = window.innerHeight + window.scrollY;

        if (scrollPosition >= document.body.offsetHeight - CONFIG.scrollThreshold) {

          this.loadNextPage();

        }

      }



      async loadNextPage() {

        if (this.loading) return 0;

        this.loading = true;

        const sp = new URLSearchParams(window.location.search);

        if (!this._pageInit) {

          const cur = parseInt(sp.get('page') || '1', 10) || 1;

          this.nextPage = Math.max(this.nextPage, cur + 1);

          this._pageInit = true;

        }

        sp.set('page', String(this.nextPage));

        let url;

        if (this.isTopAlbumsPage) {

          if (!sp.has('lapse')) sp.set('lapse', '24h');

          url = `/topalbums?${sp.toString()}`;

        } else {

          url = `/?${sp.toString()}`;

        }



        let added = 0;

        try {

          const response = await fetch(url, { credentials: 'same-origin' });

          if (!response.ok) throw new Error(`Failed to load page ${this.nextPage} (HTTP ${response.status})`);



          const doc = new DOMParser().parseFromString(await response.text(), 'text/html');

          const newAlbums = getAlbumCards(doc);

          const container = getAlbumsGridContainer(doc) ? getAlbumsGridContainer(document) : getAlbumsGridContainer(document);

          const before = getAlbumCards(document).length;



          if (newAlbums.length && container) {

            newAlbums.forEach((album) => this.setupHoverPreview(album));

            container.append(...newAlbums);

            this.dedupeAlbums();

            this.hydrateVisibleAlbumsFromPersistentCache();

            this.nextPage++;

            this.updateDashboard();

            added = Math.max(0, getAlbumCards(document).length - before);



            const sortEl = document.getElementById('nexus-sort');

            const sortMethod = sortEl ? sortEl.value : '';

            if (sortMethod && sortMethod !== 'default') sortAlbums(sortMethod);

          } else {

            window.removeEventListener('scroll', this.handleScroll);

          }

        } catch (error) {

          console.error('[Bunkr Albums Enhanced]', error);

          this.lastLoadError = error;

        } finally {

          this.loading = false;

        }

        return added;

      }



      setupAllHoverPreviews() {

        getAlbumCards(document).forEach((album) => {

          this.setupHoverPreview(album);

        });

      }



      observeAlbumContainer() {

        const container = getAlbumsGridContainer(document);

        if (!container) return;



        this.domObserver = new MutationObserver((mutations) => {

          let hasAlbumChanges = false;

          for (const mutation of mutations) {

            if (mutation.addedNodes?.length) {

              hasAlbumChanges = true;

              break;

            }

          }



          if (!hasAlbumChanges) return;



          clearTimeout(this.reconcileTimer);

          this.reconcileTimer = setTimeout(() => {

            this.setupAllHoverPreviews();

            this.dedupeAlbums();

          }, 100);

        });



        this.domObserver.observe(container, { childList: true, subtree: false });

      }



      dedupeAlbums() {

        const container = getAlbumsGridContainer(document);

        if (!container) return;



        const seen = new Set();

        const albums = Array.from(container.children);



        albums.forEach((album) => {

          if (!(album instanceof HTMLElement)) return;

          const key = getAlbumDedupKeyFromCard(album);

          if (!key) return;

          if (seen.has(key)) {

            album.remove();

            return;

          }

          seen.add(key);

        });

      }



      applyGlobalFilter(rawTerm) {

        const container = getAlbumsGridContainer(document);

        if (!container) return;



        const normalized = normalizeSearchText(rawTerm);

        const terms = normalized ? normalized.split(/\s+/).filter(Boolean) : [];

        this.renderGlobalFileResults(terms);



        const minCount = this.activeMinCount || 0;

        const minSize = this.activeMinSizeBytes || 0;

        const updatedWithinDays = this.activeUpdatedWithinDays || 0;

        const qualityMin = this.activeQualityMin || 0;

        const newestAllowedCutoff = updatedWithinDays > 0

          ? Date.now() - (updatedWithinDays * 24 * 60 * 60 * 1000)

          : 0;



        Array.from(container.children).forEach((album) => {

          if (!(album instanceof HTMLElement)) return;



          // Text filter

          if (terms.length) {

            const albumName = normalizeSearchText(getAlbumTitleFromCard(album));

            const cachedIndex = normalizeSearchText(album.dataset.previewIndex || '');

            const albumUrl = getNormalizedAlbumUrl(getAlbumUrlFromCard(album));

            const metadata = albumUrl ? this.albumCache.get(albumUrl) : null;

            const cachedAlbumName = normalizeSearchText(metadata?.albumName || '');

            const cachedFiles = (metadata?.files || [])

              .map((file) => `${file.title || ''} ${file.size || ''}`)

              .join(' ')

              .toLowerCase();

            const haystack = `${albumName} ${cachedAlbumName} ${cachedIndex} ${cachedFiles}`;

            if (!terms.every((term) => haystack.includes(term))) {

              album.style.display = 'none';

              return;

            }

          }



          // Min file count (only if data fetched — dataset.totalSizeBytes is set after fetch)

          if (minCount > 0 && album.dataset.totalSizeBytes !== undefined && album.dataset.totalSizeBytes !== '') {

            const fileCount = parseInt(album.dataset.fileCount || '0', 10);

            // Also check the raw card file count as fallback

            const cardCount = getAlbumFileCountFromCard(album);

            const count = fileCount || cardCount || 0;

            if (count > 0 && count < minCount) {

              album.style.display = 'none';

              return;

            }

          }



          // Min size (only if data fetched)

          if (minSize > 0 && album.dataset.totalSizeBytes) {

            const albumSize = parseFloat(album.dataset.totalSizeBytes || '0') || 0;

            if (albumSize > 0 && albumSize < minSize) {

              album.style.display = 'none';

              return;

            }

          }



          if (qualityMin > 0) {

            const albumSize = parseFloat(album.dataset.totalSizeBytes || '0') || 0;

            const videoCount = parseInt(album.dataset.fileCount || '0', 10) || 0;

            if (getVideoQualityLevel(albumSize, videoCount) < qualityMin) {

              album.style.display = 'none';

              return;

            }

          }



          // The newest timestamp comes from the newest fetched video. When this

          // filter is active, unknown dates are hidden too: they cannot prove

          // that an album is recent.

          if (newestAllowedCutoff > 0) {

            const newestTimestamp = parseInt(album.dataset.newestDate || '0', 10) || 0;

            if (!newestTimestamp || newestTimestamp < newestAllowedCutoff) {

              album.style.display = 'none';

              return;

            }

          }



          album.style.display = '';

        });

        this.updateDashboard();

      }



      renderGlobalFileResults(terms) {

        const panel = this.qs('.bae-file-results-panel');

        if (!panel) return;



        const rows = [];

        this.albumCache.forEach((metadata) => {

          const albumName = normalizeSearchText(metadata.albumName || '');

          (metadata.files || []).forEach((file) => {

            const title = normalizeSearchText(file.title || '');

            const size = normalizeSearchText(file.size || '');

            const haystack = `${title} ${size} ${albumName}`;

            if (terms.every((t) => haystack.includes(t))) {

              const fileUrl = metadata.albumDomain ? `https://${metadata.albumDomain}${file.href || ''}` : '';

              rows.push({

                albumName: metadata.albumName || 'Album',

                albumDomain: metadata.albumDomain,

                albumUrl: metadata.albumUrl || '',

                duration: Number(file.duration || 0) || (typeof metaByUrl !== 'undefined' ? Number(metaByUrl.get(fileUrl)?.duration || 0) : 0),

                file,

              });

            }

          });

        });



        if (this.resultSort === 'largest') rows.sort((a, b) => parseSizeToBytes(b.file.size) - parseSizeToBytes(a.file.size));

        else if (this.resultSort === 'duration') rows.sort((a, b) => (b.duration || 0) - (a.duration || 0));

        else if (this.resultSort === 'name') rows.sort((a, b) => (a.file.title || '').localeCompare(b.file.title || ''));

        else if (this.resultSort === 'album') rows.sort((a, b) => a.albumName.localeCompare(b.albumName));

        else rows.sort((a, b) => (b.file.timestamp || 0) - (a.file.timestamp || 0));

        const limited = CONFIG.maxGlobalFileRows > 0 ? rows.slice(0, CONFIG.maxGlobalFileRows) : rows;

        const initiallyRendered = Math.min(CONFIG.globalFileRenderChunk, limited.length);



        panel.innerHTML = '';

        const header = document.createElement('div');

        panel.classList.toggle('is-collapsed', this.libraryDrawerCollapsed);

        header.className = `bae-results-head${this.combinedView ? ' bae-results-head--focus' : ''}`;

        const title = document.createElement('div');

        title.className = 'bae-results-title';

        const titleStrong = document.createElement('strong');

        titleStrong.textContent = this.combinedView ? 'Combined fetched album' : 'Fetched video library';

        const titleMeta = document.createElement('span');

        titleMeta.textContent = `${this.albumCache.size} fetched albums · ${rows.length} total videos · ${terms.length ? `${rows.length} match${rows.length === 1 ? '' : 'es'}` : 'all videos'}${this.selectedFetchedVideoUrls.size ? ` · ${this.selectedFetchedVideoUrls.size} selected` : ''}${limited.length !== rows.length ? ` · showing ${limited.length}` : ''}${limited.length > initiallyRendered ? ` · rendering ${initiallyRendered}/${limited.length}` : ''}`;

        title.append(titleStrong, titleMeta);

        const tools = document.createElement('div');

        tools.className = 'bae-results-tools';

        const importSelected = document.createElement('button');

        importSelected.className = 'bae-combined-toggle bae-result-import';

        importSelected.type = 'button';

        importSelected.textContent = this.selectedFetchedVideoUrls.size ? `Import selected (${this.selectedFetchedVideoUrls.size})` : 'Import selected';

        importSelected.disabled = !this.selectedFetchedVideoUrls.size;

        importSelected.addEventListener('click', () => this.importFetchedVideoRows(rows.filter((row) => this.selectedFetchedVideoUrls.has(this.getFetchedVideoKey(row)))));

        const allSelected = rows.length > 0 && rows.every((row) => this.selectedFetchedVideoUrls.has(this.getFetchedVideoKey(row)));

        const selectAll = document.createElement('button');

        selectAll.className = 'bae-batch-fetch';

        selectAll.type = 'button';

        selectAll.textContent = allSelected ? 'Clear selection' : `Select all (${rows.length})`;

        selectAll.addEventListener('click', () => this.setFetchedVideoSelection(rows, !allSelected));

        const fetchSelected = document.createElement('button');

        fetchSelected.className = 'bae-batch-fetch';

        fetchSelected.type = 'button';

        fetchSelected.textContent = this.selectedFetchedVideoUrls.size ? `Fetch selected (${this.selectedFetchedVideoUrls.size})` : 'Fetch selected';

        fetchSelected.title = 'Fetch preview and page details only for selected videos';

        fetchSelected.disabled = !this.selectedFetchedVideoUrls.size;

        fetchSelected.addEventListener('click', () => this.fetchFetchedVideoDetails(rows.filter((row) => this.selectedFetchedVideoUrls.has(this.getFetchedVideoKey(row))), 'selected videos'));

        const fetchAllDetails = document.createElement('button');

        fetchAllDetails.className = 'bae-batch-fetch';

        fetchAllDetails.type = 'button';

        fetchAllDetails.textContent = `Fetch all details (${rows.length})`;

        fetchAllDetails.title = 'Fetch preview and page details for every matching video';

        fetchAllDetails.disabled = !rows.length;

        fetchAllDetails.addEventListener('click', () => this.fetchFetchedVideoDetails(rows, 'matching videos'));

        if (this.combinedView) {

          const combinedSearch = document.createElement('input');

          combinedSearch.className = 'bae-result-search';

          combinedSearch.type = 'search';

          combinedSearch.placeholder = 'Search combined album…';

          combinedSearch.value = this.activeGlobalFilter;

          combinedSearch.setAttribute('aria-label', 'Search combined fetched album');

          const submitCombinedSearch = () => window.dispatchEvent(new CustomEvent('bae-global-filter', { detail: combinedSearch.value || '' }));

          combinedSearch.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); submitCombinedSearch(); } });

          const combinedSearchButton = document.createElement('button');

          combinedSearchButton.className = 'bae-search-submit';

          combinedSearchButton.type = 'button';

          combinedSearchButton.textContent = 'Search';

          combinedSearchButton.addEventListener('click', submitCombinedSearch);

          tools.append(combinedSearch, combinedSearchButton);

        }

        const sort = document.createElement('select');

        sort.className = 'bae-result-sort';

        sort.setAttribute('aria-label', 'Sort fetched videos');

        sort.innerHTML = '<option value="newest">Newest first</option><option value="largest">Largest first</option><option value="duration">Longest duration</option><option value="name">Video name A–Z</option><option value="album">Album name A–Z</option>';

        sort.value = this.resultSort;

        sort.addEventListener('change', () => {

          this.resultSort = sort.value;

          localStorage.setItem(STORAGE_KEYS.resultSort, this.resultSort);

          this.renderGlobalFileResults(terms);

        });

        const combined = document.createElement('button');

        combined.className = `bae-combined-toggle${this.combinedView ? ' is-active' : ''}`;

        combined.textContent = this.combinedView ? 'Exit combined view' : 'Open as combined album';

        combined.addEventListener('click', () => this.setCombinedView(!this.combinedView));

        const drawerToggle = document.createElement('button');

        drawerToggle.className = 'bae-library-drawer-toggle';

        drawerToggle.type = 'button';

        drawerToggle.textContent = this.libraryDrawerCollapsed ? '▸ Show gallery' : '▾ Hide gallery';

        drawerToggle.setAttribute('aria-expanded', this.libraryDrawerCollapsed ? 'false' : 'true');

        drawerToggle.addEventListener('click', () => this.setLibraryDrawerCollapsed(!this.libraryDrawerCollapsed));

        const durationFetch = document.createElement('button');

        durationFetch.className = 'bae-duration-fetch';

        durationFetch.textContent = 'Fetch durations';

        durationFetch.title = 'Fetch duration metadata using the Nexus helper';

        durationFetch.style.display = document.querySelector('button[data-act="fetchmeta"]') ? '' : 'none';

        durationFetch.addEventListener('click', () => document.querySelector('button[data-act="fetchmeta"]')?.click());

        tools.append(selectAll, fetchSelected, fetchAllDetails, importSelected, durationFetch, combined, sort, drawerToggle);

        header.append(title, tools);

        panel.appendChild(header);



        const list = document.createElement('div');

        list.className = limited.length ? 'bae-results-grid' : 'bae-results-empty';

        if (limited.length) {

          const appendNextChunk = () => {

            const start = list.children.length;

            const nextRows = limited.slice(start, start + CONFIG.globalFileRenderChunk);

            if (!nextRows.length) return;

            const fragment = document.createDocumentFragment();

            nextRows.forEach((row) => fragment.appendChild(this.buildFileResultItem(row)));

            list.appendChild(fragment);

          };

          appendNextChunk();

          let appendQueued = false;

          list.addEventListener('scroll', () => {

            if (appendQueued || list.scrollTop + list.clientHeight < list.scrollHeight - 480) return;

            appendQueued = true;

            requestAnimationFrame(() => { appendQueued = false; appendNextChunk(); });

          }, { passive: true });

        }

        else list.textContent = this.albumCache.size

          ? 'No videos match this search. Try fewer words or a different spelling.'

          : 'Index visible albums to build a fast searchable video-title library. Fetch a card only when you need its preview or details.';



        panel.appendChild(list);

        panel.style.display = 'block';

      }



      setCombinedView(enabled) {

        this.combinedView = !!enabled;

        document.body.classList.toggle('bae-combined-mode', this.combinedView);

        this.renderGlobalFileResults(normalizeSearchText(this.activeGlobalFilter).split(/\s+/).filter(Boolean));

      }



      setLibraryDrawerCollapsed(collapsed) {

        this.libraryDrawerCollapsed = !!collapsed;

        localStorage.setItem(STORAGE_KEYS.libraryCollapsed, this.libraryDrawerCollapsed ? '1' : '0');

        const panel = this.qs('.bae-file-results-panel');

        panel?.classList.toggle('is-collapsed', this.libraryDrawerCollapsed);

        const toggle = this.qs('.bae-library-drawer-toggle', panel);

        if (toggle) {

          toggle.textContent = this.libraryDrawerCollapsed ? '▸ Show gallery' : '▾ Hide gallery';

          toggle.setAttribute('aria-expanded', this.libraryDrawerCollapsed ? 'false' : 'true');

        }

      }



      getFetchedVideoUrl(row) {

        return `https://${row.albumDomain}${row.file.href}`;

      }



      getFetchedVideoKey(row) {

        return this.getFetchedVideoUrl(row);

      }



      toggleFetchedVideoSelection(row, selected) {

        const key = this.getFetchedVideoKey(row);

        if (selected) this.selectedFetchedVideoUrls.add(key);

        else this.selectedFetchedVideoUrls.delete(key);

        this.renderGlobalFileResults(normalizeSearchText(this.activeGlobalFilter).split(/\s+/).filter(Boolean));

      }



      setFetchedVideoSelection(rows, selected) {

        rows.forEach((row) => {

          const key = this.getFetchedVideoKey(row);

          if (selected) this.selectedFetchedVideoUrls.add(key);

          else this.selectedFetchedVideoUrls.delete(key);

        });

        this.renderGlobalFileResults(normalizeSearchText(this.activeGlobalFilter).split(/\s+/).filter(Boolean));

      }



      async importFetchedVideoRows(rows) {

        const uniqueRows = Array.from(new Map(rows.map((row) => [this.getFetchedVideoKey(row), row])).values());

        if (!uniqueRows.length) return;

        const candidates = uniqueRows.map((row) => ({

          url: this.getFetchedVideoUrl(row), source_url: this.getFetchedVideoUrl(row), title: row.file.title || 'Bunkr video',

          thumbnail: row.file.thumbSrc || '', duration: row.duration || 0, file_size_mb: Number((parseSizeToBytes(row.file.size) / (1024 ** 2)).toFixed(2)),

          source: 'bunkr', tags: ['bunkr', 'balbums'],

        }));

        if (connStatus !== 'online' && !(await detectPort())) {

          this.emitStatus(`Import unavailable: Nexus dashboard is offline on port ${state.port}.`);

          return;

        }

        this.emitStatus(`Queuing ${candidates.length} selected video(s) for import…`);

        try {

          const response = await bridgeFetch(`http://localhost:${state.port}/api/v1/intake/import`, {

            method: 'POST', headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify({ batch_name: `Bunkr archive · ${this.activeGlobalFilter || 'fetched library'}`, candidates }), timeoutMs: 30000,

          });

          const data = await response.json().catch(() => ({}));

          if (!response.ok) throw new Error(data.detail || `Server ${response.status}`);

          this.selectedFetchedVideoUrls.clear();

          this.emitStatus(`Queued ${data.job?.total_items ?? candidates.length} video(s) for import — job #${data.job?.id ?? '?'}.`);

          this.renderGlobalFileResults(normalizeSearchText(this.activeGlobalFilter).split(/\s+/).filter(Boolean));

        } catch (error) {

          this.emitStatus(`Import failed: ${error.message || error}`);

        }

      }



      async fetchFileDetails(row, button, options = {}) {

        const fileUrl = this.getFetchedVideoUrl(row);

        if (button) { button.disabled = true; button.textContent = 'Loading…'; }

        try {

          const doc = await this.fetchDocumentWithRetry(fileUrl, 2);

          const rawThumb = this.qs('meta[property="og:image"], meta[name="twitter:image"]', doc)?.getAttribute('content') || '';

          if (rawThumb && !row.file.thumbSrc && !/video\.svg|placeholder|\/icon/i.test(rawThumb)) {

            row.file.thumbSrc = new URL(rawThumb, fileUrl).href;

          }

          const detailTitle = this.qs('meta[property="og:title"], title', doc)?.getAttribute('content') || this.qs('title', doc)?.textContent?.trim() || '';

          if (detailTitle && !row.file.title) row.file.title = detailTitle;

          row.file.detailFetched = true;

          const metadata = this.albumCache.get(getNormalizedAlbumUrl(row.albumUrl));

          if (metadata) this.queuePersistentAlbumSave(metadata);

          if (options.render !== false) this.renderGlobalFileResults(normalizeSearchText(this.activeGlobalFilter).split(/\s+/).filter(Boolean));

        } catch (error) {

          if (button) { button.disabled = false; button.textContent = 'Fetch details'; }

          this.emitStatus(`Could not fetch details: ${error.message || error}`);

        }

      }



      async fetchFetchedVideoDetails(rows, label) {

        const pending = rows.filter((row) => !row.file.detailFetched);

        if (!pending.length) {

          this.emitStatus('Details are already loaded for these videos.');

          return;

        }

        let complete = 0;

        this.emitStatus(`Fetching details: 0/${pending.length}`);

        await this.processWithConcurrency(pending, 4, async (row) => {

          await this.fetchFileDetails(row, null, { render: false });

          complete += 1;

          if (complete === pending.length || complete % 12 === 0) this.emitStatus(`Fetching details: ${complete}/${pending.length}`);

        });

        this.emitStatus(`Loaded details for ${complete} ${label}.`);

        this.renderGlobalFileResults(normalizeSearchText(this.activeGlobalFilter).split(/\s+/).filter(Boolean));

      }



      buildFileResultItem(row) {

        const fileUrl = this.getFetchedVideoUrl(row);

        const dateText = row.file.timestamp ? new Date(row.file.timestamp).toLocaleDateString('en-GB') : 'n/a';



        const item = document.createElement('div');

        item.className = 'bae-result-card';

        const media = document.createElement('div');

        media.className = 'bae-result-media';

        media.tabIndex = 0;

        media.setAttribute('role', 'button');

        media.setAttribute('aria-label', `Play ${row.file.title || 'video'}`);



        const thumb = document.createElement('img');

        if (row.file.thumbSrc) {

          thumb.src = row.file.thumbSrc;

          thumb.onerror = () => { thumb.style.display = 'none'; };

        } else {

          thumb.style.display = 'none';

        }

        thumb.alt = row.file.title ? `Preview for ${row.file.title}` : 'Video preview';

        thumb.loading = 'lazy';

        thumb.decoding = 'async';

        const sizeBadge = document.createElement('span');

        sizeBadge.className = 'bae-result-badge';

        sizeBadge.textContent = row.file.size || 'Size unknown';

        const selectLabel = document.createElement('label');

        selectLabel.className = 'bae-result-select';

        const select = document.createElement('input');

        select.type = 'checkbox';

        select.checked = this.selectedFetchedVideoUrls.has(this.getFetchedVideoKey(row));

        select.setAttribute('aria-label', `Select ${row.file.title || 'video'} for import`);

        select.addEventListener('click', (event) => event.stopPropagation());

        select.addEventListener('change', () => this.toggleFetchedVideoSelection(row, select.checked));

        selectLabel.append(select, document.createTextNode('Select'));

        item.classList.toggle('is-selected', select.checked);

        media.append(thumb, sizeBadge, selectLabel);



        const textWrap = document.createElement('div');

        textWrap.className = 'bae-result-body';



        const title = document.createElement('div');

        title.textContent = row.file.title || 'Untitled';

        title.className = 'bae-result-name';

        title.title = title.textContent;



        const album = document.createElement('div');

        album.className = 'bae-result-album';

        album.textContent = row.albumName;

        album.title = row.albumName;

        const sub = document.createElement('div');

        sub.className = 'bae-result-meta';

        const durationText = row.duration ? `${Math.floor(row.duration / 60)}:${String(Math.floor(row.duration % 60)).padStart(2, '0')}` : 'duration n/a';

        sub.textContent = `${dateText} · ${row.file.size || 'size unknown'} · ${durationText}`;



        const actions = document.createElement('div');

        actions.className = 'bae-result-actions';



        const playBtn = document.createElement('button');

        playBtn.textContent = 'Play';

        const play = (e) => {

          e.preventDefault();

          e.stopPropagation();

          this.openPlayerModal(fileUrl, row.file.title || 'Untitled');

        };

        playBtn.addEventListener('click', play);

        media.addEventListener('click', play);

        media.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') play(e); });

        const detailsBtn = document.createElement('button');

        detailsBtn.textContent = row.file.detailFetched ? 'Details loaded' : 'Fetch details';

        detailsBtn.disabled = !!row.file.detailFetched;

        detailsBtn.title = 'Fetch preview and page details for this video only';

        detailsBtn.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); this.fetchFileDetails(row, detailsBtn); });



        const openBtn = document.createElement('a');

        openBtn.href = fileUrl;

        openBtn.target = '_blank';

        openBtn.rel = 'noopener noreferrer';

        openBtn.textContent = '↗';

        openBtn.title = 'Open video source';

        openBtn.setAttribute('aria-label', 'Open video source');

        const albumBtn = document.createElement('a');

        albumBtn.href = row.albumUrl || fileUrl;

        albumBtn.target = '_blank';

        albumBtn.rel = 'noopener noreferrer';

        albumBtn.textContent = 'A';

        albumBtn.title = 'Open source album';

        albumBtn.setAttribute('aria-label', 'Open source album');



        const importBtn = document.createElement('button');

        importBtn.className = 'bae-result-import';

        importBtn.textContent = 'Import';

        importBtn.title = 'Import this video into Nexus';

        importBtn.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); this.importFetchedVideoRows([row]); });

        actions.append(playBtn, detailsBtn, importBtn, albumBtn, openBtn);

        textWrap.append(title, album, sub, actions);

        item.append(media, textWrap);

        return item;

      }



      async openPlayerModal(url, title) {

        if (!this.playerModal) {

          const overlay = document.createElement('div');

          overlay.className = 'bae-player-modal';

          overlay.style = 'position:fixed; inset:0; z-index:100000; background:rgba(2,6,23,0.72); display:none; align-items:center; justify-content:center; padding:20px;';



          const card = document.createElement('div');

          card.style = 'width:min(1000px, 96vw); background:#0b1220; border:1px solid #334155; border-radius:10px; padding:10px;';



          const head = document.createElement('div');

          head.style = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; gap:10px;';



          const hTitle = document.createElement('div');

          hTitle.className = 'bae-player-title';

          hTitle.style = 'color:#f8fafc; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';



          const close = document.createElement('button');

          close.textContent = 'Close';

          close.style = 'padding:5px 8px; border-radius:6px; border:1px solid #475569; background:#1e293b; color:#f8fafc; font-size:11px; cursor:pointer;';

          close.addEventListener('click', () => this.closePlayerModal());



          const video = document.createElement('video');

          video.className = 'bae-player-video';

          video.controls = true;

          video.autoplay = true;

          video.playsInline = true;

          video.preload = 'auto';

          video.style = 'width:100%; max-height:75vh; border-radius:8px; background:#000;';

          const iframe = document.createElement('iframe');

          iframe.className = 'bae-player-iframe';

          iframe.allow = 'autoplay *; encrypted-media *; fullscreen *; picture-in-picture *';

          iframe.referrerPolicy = 'origin';

          iframe.style = 'display:none; width:100%; height:min(75vh, 620px); border:0; border-radius:8px; background:#000;';



          head.append(hTitle, close);

          card.append(head, video, iframe);

          overlay.appendChild(card);

          overlay.addEventListener('click', (e) => {

            if (e.target === overlay) this.closePlayerModal();

          });

          document.body.appendChild(overlay);

          this.playerModal = overlay;

        }



        const titleEl = this.qs('.bae-player-title', this.playerModal);

        const videoEl = this.qs('.bae-player-video', this.playerModal);

        const iframeEl = this.qs('.bae-player-iframe', this.playerModal);

        const requestId = Symbol('bae-player-request');

        this.playerRequestId = requestId;

        if (this.playerBlobUrl) {

          URL.revokeObjectURL(this.playerBlobUrl);

          this.playerBlobUrl = null;

        }



        const autoplayNativeIframe = () => {

          let attempts = 0;

          const tick = () => {

            if (this.playerRequestId !== requestId || !iframeEl) return;

            try {

              const doc = iframeEl.contentDocument || iframeEl.contentWindow?.document;

              const video = doc?.querySelector('video');

              if (video && video.paused) {

                video.muted = false;

                video.play().catch(() => {

                  video.muted = true;

                  video.play().catch(() => { });

                });

              }

            } catch { /* cross-origin bunkr page */ }

            attempts += 1;

            if (attempts < 16) setTimeout(tick, 250);

          };

          iframeEl.addEventListener('load', tick, { once: true });

          setTimeout(tick, 400);

        };



        const switchToNativePlayer = () => {

          if (this.playerRequestId !== requestId || !iframeEl) return;

          if (videoEl) {

            videoEl.onerror = null;

            videoEl.pause();

            videoEl.removeAttribute('src');

            videoEl.load();

            videoEl.style.display = 'none';

          }

          const nativeUrl = url.replace(/\/f\//i, '/v/');

          iframeEl.style.display = 'block';

          iframeEl.src = nativeUrl;

          autoplayNativeIframe();

          if (titleEl) titleEl.textContent = `${title} — playing with Bunkr's native player.`;

        };



        const playDirect = async (streamUrl, label = title) => {

          if (this.playerRequestId !== requestId || !videoEl) return;

          if (iframeEl) { iframeEl.style.display = 'none'; iframeEl.src = 'about:blank'; }

          videoEl.style.display = 'block';

          videoEl.muted = false;

          videoEl.src = streamUrl;

          if (titleEl) titleEl.textContent = label;

          await startVideoPlayback(videoEl, () => this.playerRequestId === requestId);

        };



        if (titleEl) titleEl.textContent = `${title} — resolving…`;

        if (videoEl) {

          videoEl.onerror = null;

          videoEl.pause();

          videoEl.style.display = 'block';

          videoEl.removeAttribute('src');

          videoEl.load();

        }

        if (iframeEl) { iframeEl.style.display = 'none'; iframeEl.src = 'about:blank'; }

        this.playerModal.style.display = 'flex';



        try {

          const streamUrl = await resolveBunkrStreamUrl(url);

          if (this.playerRequestId !== requestId) return;

          if (!cleanPlayableMediaUrl(streamUrl)) throw new Error('Resolver did not return a media URL.');

          let handedOff = false;

          if (videoEl) {

            videoEl.onerror = () => {

              if (handedOff || this.playerRequestId !== requestId) return;

              handedOff = true;

              switchToNativePlayer();

            };

          }

          await playDirect(streamUrl);

        } catch (error) {

          console.warn('[Bunkr Albums Enhanced] Stream resolution failed; using native Bunkr player', { url, error });

          switchToNativePlayer();

        }

      }



      closePlayerModal() {

        if (!this.playerModal) return;

        const videoEl = this.qs('.bae-player-video', this.playerModal);

        if (videoEl) {

          videoEl.onerror = null;

          videoEl.pause();

          videoEl.removeAttribute('src');

          videoEl.load();

        }

        const iframeEl = this.qs('.bae-player-iframe', this.playerModal);

        if (iframeEl) { iframeEl.src = 'about:blank'; iframeEl.style.display = 'none'; }

        if (this.playerBlobUrl) {

          URL.revokeObjectURL(this.playerBlobUrl);

          this.playerBlobUrl = null;

        }

        this.playerRequestId = null;

        this.playerModal.style.display = 'none';

      }



      ensureFloatingPlayers() {

        if (this.floatingPlayers) return;

        const root = document.createElement('div');

        root.className = 'bae-floating-players';

        root.style = 'position:fixed; left:12px; bottom:12px; z-index:100001; display:flex; gap:10px; pointer-events:none;';



        const makeSlot = (slot) => {

          const card = document.createElement('div');

          card.className = `bae-float-${slot}`;

          card.style = 'width:340px; background:rgba(2,6,23,0.96); border:1px solid #334155; border-radius:10px; padding:8px; display:none; pointer-events:auto;';



          const head = document.createElement('div');

          head.style = 'display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:6px;';

          const title = document.createElement('div');

          title.className = 'bae-float-title';

          title.style = 'font-size:11px; color:#e2e8f0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';



          const close = document.createElement('button');

          close.textContent = 'x';

          close.style = 'padding:2px 6px; border-radius:5px; border:1px solid #475569; background:#1e293b; color:#f8fafc; font-size:11px; cursor:pointer;';

          close.addEventListener('click', () => {

            const video = this.qs('video', card);

            if (video) { video.pause(); video.removeAttribute('src'); video.load(); }

            card.style.display = 'none';

            this.compareSlots[slot] = null;

          });



          const video = document.createElement('video');

          video.controls = true;

          video.style = 'width:100%; height:190px; border-radius:8px; background:#000;';



          head.append(title, close);

          card.append(head, video);

          return card;

        };



        root.append(makeSlot('A'), makeSlot('B'));

        document.body.appendChild(root);

        this.floatingPlayers = root;

      }



      async setCompareSlot(slot, url, title) {

        this.ensureFloatingPlayers();

        const card = this.qs(`.bae-float-${slot}`, this.floatingPlayers);

        if (!card) return;

        const titleEl = this.qs('.bae-float-title', card);

        const video = this.qs('video', card);

        if (titleEl) titleEl.textContent = `${slot}: resolving…`;

        if (video) { video.removeAttribute('src'); video.load(); }

        card.style.display = 'block';

        const request = { url, title };

        this.compareSlots[slot] = request;



        const streamUrl = await resolveBunkrStreamUrl(url);

        if (this.compareSlots[slot] !== request) return;

        if (titleEl) titleEl.textContent = `${slot}: ${title}`;

        if (video) {

          video.src = streamUrl;

          video.muted = slot === 'B';

          video.play().catch(() => { });

        }

      }



      closeFloatingPlayers() {

        if (!this.floatingPlayers) return;

        ['A', 'B'].forEach((slot) => {

          const card = this.qs(`.bae-float-${slot}`, this.floatingPlayers);

          if (!card) return;

          const video = this.qs('video', card);

          if (video) {

            video.pause();

            video.removeAttribute('src');

            video.load();

          }

          card.style.display = 'none';

          this.compareSlots[slot] = null;

        });

      }



      emitStatus(message) {

        window.dispatchEvent(new CustomEvent('bae-status', { detail: message || '' }));

      }



      scheduleLibraryRender() {

        clearTimeout(this.libraryRenderTimer);

        this.libraryRenderTimer = setTimeout(() => this.applyGlobalFilter(this.activeGlobalFilter), 350);

      }



      getBridgeSelectionSnapshot() {

        return {

          selectedAlbumUrls: Array.from(this.selectedAlbumUrls),

          count: this.selectedAlbumUrls.size,

        };

      }



      getBridgeStateSnapshot() {

        const cachedAlbums = Array.from(this.albumCache.values());

        const cachedFiles = cachedAlbums.reduce((sum, album) => sum + (album.fileCount || 0), 0);

        return {

          ready: true,

          selectionMode: this.selectionMode,

          resultsLayout: 'grid',

          activeGlobalFilter: this.activeGlobalFilter,

          selectedCount: this.selectedAlbumUrls.size,

          visibleAlbumCount: this.getVisibleAlbums().length,

          cache: {

            albumCount: cachedAlbums.length,

            fileCount: cachedFiles,

          },

          compareSlots: {

            A: this.compareSlots.A ? { title: this.compareSlots.A.title || '', url: this.compareSlots.A.url || '' } : null,

            B: this.compareSlots.B ? { title: this.compareSlots.B.title || '', url: this.compareSlots.B.url || '' } : null,

          },

          playerModalOpen: !!(this.playerModal && this.playerModal.style.display !== 'none'),

          capabilities: Array.from(BAE_BRIDGE_EXTENSION_TYPES),

        };

      }



      getVisibleAlbums() {

        return getAlbumCards(document).filter((album) => album.style.display !== 'none');

      }



      hydrateVisibleAlbumsFromPersistentCache() {

        const entries = this.persistentAlbumCache?.entries || {};

        let restored = 0;

        getAlbumCards(document).forEach((album) => {

          const albumUrl = getAlbumUrlFromCard(album);

          const stored = entries[getPersistentAlbumKey(albumUrl)];

          if (!stored) return;

            const metadata = {

            ...stored,

            albumUrl,

            albumDomain: this.getAlbumDomain(albumUrl),

            files: Array.isArray(stored.files) ? stored.files : [],

            fromPersistentCache: true,

          };

          this.albumCache.set(getNormalizedAlbumUrl(albumUrl), metadata);

          this.applyMetadataToAlbumCard(album, metadata);

          restored += 1;

        });

        if (restored) this.emitStatus(`Restored ${restored} cached album(s) instantly.`);

      }



      queuePersistentAlbumSave(metadata) {

        if (!metadata?.albumUrl) return;

        const key = getPersistentAlbumKey(metadata.albumUrl);

        this.persistentAlbumCache.entries[key] = {

          albumName: metadata.albumName || '',

          fileCount: metadata.fileCount || 0,

          totalBytes: metadata.totalBytes || 0,

          oldestTimestamp: metadata.oldestTimestamp || 0,

          newestTimestamp: metadata.newestTimestamp || 0,

          previewIndex: (metadata.previewIndex || '').slice(0, 2000),

		  detailsReady: !!metadata.detailsReady,

          files: (metadata.files || []).map((file) => ({

            href: file.href || '',

            title: file.title || '',

            size: file.size || '',

            isVideo: !!file.isVideo,

            thumbSrc: file.thumbSrc || '',

			 detailFetched: !!file.detailFetched,

            timestamp: file.timestamp || 0,

          })),

          fetchedAt: metadata.fetchedAt || Date.now(),

        };

        clearTimeout(this.persistentCacheSaveTimer);

        this.persistentCacheSaveTimer = setTimeout(() => this.flushPersistentAlbumCache(), 180);

      }



      flushPersistentAlbumCache() {

        clearTimeout(this.persistentCacheSaveTimer);

        this.persistentCacheSaveTimer = null;

        try {

          const entries = Object.entries(this.persistentAlbumCache.entries || {});

          if (entries.length > MAX_PERSISTENT_ALBUMS) {

            entries.sort((a, b) => (b[1].fetchedAt || 0) - (a[1].fetchedAt || 0));

            this.persistentAlbumCache.entries = Object.fromEntries(entries.slice(0, MAX_PERSISTENT_ALBUMS));

          }

          GM_setValue(PERSISTENT_CACHE_KEY, this.persistentAlbumCache);

        } catch (error) {

          console.warn('[Bunkr Albums Enhanced] Could not save persistent album cache:', error);

        }

      }



      updateDashboard() {

        const dashboard = this.qs('.bae-dashboard');

        if (!dashboard) return;

        const cachedAlbums = Array.from(this.albumCache.values());

        const allCards = getAlbumCards(document);

        const visibleCards = allCards.filter((album) => album.style.display !== 'none');

        const totalVideos = cachedAlbums.reduce((sum, album) => sum + (album.fileCount || 0), 0);

        const totalBytes = cachedAlbums.reduce((sum, album) => sum + (album.totalBytes || 0), 0);

        const freshCutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);

        const freshCount = cachedAlbums.filter((album) => (album.newestTimestamp || 0) >= freshCutoff).length;

        const highCount = cachedAlbums.filter((album) => getVideoQualityLevel(album.totalBytes || 0, album.fileCount || 0) >= 2).length;

        const stats = { fetched: cachedAlbums.length, visible: visibleCards.length, videos: totalVideos.toLocaleString(), size: formatBytes(totalBytes), fresh: freshCount, quality: highCount };

        Object.entries(stats).forEach(([key, value]) => {

          const node = this.qs(`[data-stat="${key}"]`, dashboard);

          if (node) node.textContent = `${value}`;

        });



        const strip = this.qs('.bae-signal-strip', dashboard);

        if (!strip) return;

        strip.innerHTML = '';

        allCards.slice(0, 100).forEach((album) => {

          const signal = document.createElement('span');

          signal.className = 'bae-signal';

          const newest = parseInt(album.dataset.newestDate || '0', 10) || 0;

          const ageDays = newest ? (Date.now() - newest) / (24 * 60 * 60 * 1000) : Infinity;

          signal.dataset.state = !newest ? 'unknown' : ageDays <= 30 ? 'fresh' : ageDays <= 90 ? 'warm' : 'old';

          if (album.style.display === 'none') signal.dataset.state = 'hidden';

          signal.title = `${getAlbumTitleFromCard(album) || 'Album'}${newest ? ` · ${Math.max(0, Math.floor(ageDays))}d` : ' · not fetched'}`;

          strip.appendChild(signal);

        });

      }



      selectTopVisibleAlbums(count) {

        const limit = Math.max(1, count || 10);

        const visible = this.getVisibleAlbums();

        this.clearAlbumSelection();

        visible.slice(0, limit).forEach((album) => {

          const checkbox = this.qs('.bae-select-album-checkbox', album);

          if (checkbox) {

            checkbox.checked = true;

            checkbox.dispatchEvent(new Event('change', { bubbles: true }));

          }

        });

        this.updateSelectionBar();

        this.emitStatus(`Selected ${Math.min(limit, visible.length)} albums.`);

      }



      clearAlbumSelection() {

        this.selectedAlbumUrls.clear();

        this.qsa('.bae-select-album-checkbox').forEach((cb) => {

          cb.checked = false;

        });

        this.updateSelectionBar();

        this.emitStatus('Selection cleared.');

      }



      getAlbumCardByUrl(albumUrl) {

        const key = getNormalizedAlbumUrl(albumUrl);

        return getAlbumCards(document).find((album) => {

          const href = getAlbumUrlFromCard(album);

          if (!href) return false;

          return getNormalizedAlbumUrl(href) === key;

        }) || null;

      }



      ensureAlbumMetaBadge(album) {

        // Try multiple selectors — bunkr card structure varies

        const container = this.qs('.flex-1.grid.auto-rows-max', album)

          || this.qs('.p-3\\.5', album)

          || this.qs('[class*="p-3"]', album)

          || album;

        if (!container) return null;

        let meta = this.qs('.bae-album-meta', album);

        if (!meta) {

          meta = document.createElement('div');

          meta.className = 'bae-album-meta';

          meta.style = 'font-size: 11px; color: #9ca3af; margin-top: 4px; line-height: 1.3; min-height: 14px; padding: 0 4px;';

          // Insert after album title or file-count line, or append to container

          const titleLine = this.qs('p.text-subs', container) || this.qs('h3', container) || this.qs('p', container);

          if (titleLine && titleLine.parentElement) {

            titleLine.parentElement.insertBefore(meta, titleLine.nextSibling);

          } else {

            container.appendChild(meta);

          }

        }

        return meta;

      }



      ensureAlbumSelectControl(album, albumUrl) {

        if (this.qs('.bae-album-controls', album)) return;



        const controls = document.createElement('div');

        controls.className = 'bae-album-controls';

        controls.style = 'display: inline-flex; align-items: center; gap: 8px; margin: 4px 0; padding: 6px 8px; position: relative; z-index: 9999; pointer-events: auto; border: 1px solid #334155; border-radius: 8px; background: rgba(15,23,42,0.7); max-width: fit-content;';

        controls.addEventListener('click', (e) => e.stopPropagation());

        controls.addEventListener('mousedown', (e) => e.stopPropagation());

        controls.addEventListener('mouseup', (e) => e.stopPropagation());

        controls.addEventListener('pointerdown', (e) => e.stopPropagation());

        controls.addEventListener('pointerup', (e) => e.stopPropagation());



        const label = document.createElement('label');

        label.style = 'display: inline-flex; align-items: center; gap: 6px; color: #cbd5e1; font-size: 11px; cursor: pointer; user-select: none;';



        const checkbox = document.createElement('input');

        checkbox.type = 'checkbox';

        checkbox.className = 'bae-select-album-checkbox';

        checkbox.style = 'cursor: pointer;';

        checkbox.addEventListener('click', (e) => e.stopPropagation());

        checkbox.addEventListener('change', (e) => {

          e.stopPropagation();

          const key = getNormalizedAlbumUrl(albumUrl);

          if (checkbox.checked) {

            this.selectedAlbumUrls.add(key);

          } else {

            this.selectedAlbumUrls.delete(key);

          }

          this.updateSelectionBar();

          this.emitStatus(`Selected ${this.selectedAlbumUrls.size} album(s).`);

        });



        const text = document.createElement('span');

        text.textContent = 'Select for batch fetch';

        label.addEventListener('click', (e) => e.stopPropagation());



        label.append(checkbox, text);

        controls.appendChild(label);

        album.insertBefore(controls, album.firstChild);

      }



      applyMetadataToAlbumCard(album, metadata) {

        if (!album || !metadata) return;

        album.dataset.oldestDate = metadata.oldestTimestamp ? `${metadata.oldestTimestamp}` : '0';

        album.dataset.newestDate = metadata.newestTimestamp ? `${metadata.newestTimestamp}` : '0';

        album.dataset.totalSizeBytes = `${metadata.totalBytes || 0}`;

        album.dataset.fileCount = `${metadata.fileCount || 0}`;

        album.dataset.previewIndex = metadata.previewIndex || '';



        if (metadata.isPhotoOnly) {

          album.dataset.isPhotoOnly = '1';

          album.classList.add('bae-photo-album');

          let metaNode = this.ensureAlbumMetaBadge(album);

          if (metaNode) {

            metaNode.textContent = `📷 ${metadata.photoCount || 0} Photos (0 Videos)`;

            metaNode.style.cssText = 'font-size:11px; color:#f0883e; font-weight:700; margin-top:4px; padding:2px 6px; line-height:1.3; display:block;';

          }

          const sourceCount = this.qs('p.text-xs span', album)

            || this.qsa('span', album).find((span) => /^\d+\s+files?$/i.test((span.textContent || '').trim()));

          if (sourceCount) sourceCount.textContent = `${metadata.photoCount || 0} Photos`;

          return;

        }



        const parts = [];

        if (metadata.totalBytes > 0) parts.push(formatBytes(metadata.totalBytes));

        if (metadata.newestTimestamp) {

          parts.push('📅 ' + new Date(metadata.newestTimestamp).toLocaleDateString('en-GB'));

        }

        if (metadata.fileCount) parts.push(metadata.fileCount + ' Videos');

        const text = parts.join(' • ');

        if (!text) return;



        // Try structured badge first

        let metaNode = this.ensureAlbumMetaBadge(album);

        // Hard fallback — just find or create directly on album root

        if (!metaNode) {

          metaNode = album.querySelector('.bae-album-meta') || document.createElement('div');

          metaNode.className = 'bae-album-meta';

          if (!metaNode.parentElement) album.appendChild(metaNode);

        }



        metaNode.textContent = text;

        metaNode.style.cssText = 'font-size:11px; color:#4ade80; font-weight:600; margin-top:4px; padding:2px 6px; line-height:1.3; display:block;';



        // Replace Bunkr's original total-file label too, so the card never

        // presents an all-file count as if it were the video count.

        const sourceCount = this.qs('p.text-xs span', album)

          || this.qsa('span', album).find((span) => /^\d+\s+files?$/i.test((span.textContent || '').trim()));

        if (sourceCount) sourceCount.textContent = `${metadata.fileCount || 0} Videos`;

        let cacheBadge = this.qs('.bae-cache-badge', album);

        if (metadata.fromPersistentCache) {

          if (!cacheBadge) {

            cacheBadge = document.createElement('span');

            cacheBadge.className = 'bae-cache-badge';

            cacheBadge.style.cssText = 'display:inline-flex;width:fit-content;margin:4px 4px 0;padding:2px 6px;border:1px solid #343844;border-radius:999px;color:#8b909b;font:700 9px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace;text-transform:uppercase;letter-spacing:.07em;';

            metaNode.insertAdjacentElement('afterend', cacheBadge);

          }

          cacheBadge.textContent = isAlbumCacheFresh(metadata) ? 'cached' : 'cached · refresh due';

          cacheBadge.title = metadata.fetchedAt ? `Saved ${new Date(metadata.fetchedAt).toLocaleString()}` : 'Restored from Tampermonkey cache';

        } else {

          cacheBadge?.remove();

        }



        const quality = getVideoQualityEstimate(metadata.totalBytes, metadata.fileCount);

        let qualityBadge = this.qs('.bae-video-quality', album);

        if (!quality) {

          qualityBadge?.remove();

          return;

        }

        if (!qualityBadge) {

          qualityBadge = document.createElement('span');

          qualityBadge.className = 'bae-video-quality';

          qualityBadge.style.cssText = 'display:inline-flex; width:fit-content; margin:4px 4px 0; padding:2px 6px; border:1px solid; border-radius:999px; font-size:10px; font-weight:700; line-height:1.35;';

          metaNode.insertAdjacentElement('afterend', qualityBadge);

        }

        qualityBadge.textContent = `≈ ${quality.label} · Ø ${formatBytes(quality.averageBytes)}/video`;

        qualityBadge.title = 'Estimated from average video file size. Duration, bitrate, and resolution are unknown.';

        qualityBadge.style.color = quality.color;

        qualityBadge.style.borderColor = quality.color;

      }



      applyMetadataToAllMatchingCards(albumUrl, metadata) {

        const key = getNormalizedAlbumUrl(albumUrl);

        getAlbumCards(document).forEach((album) => {

          const href = getAlbumUrlFromCard(album);

          if (!href) return;

          if (getNormalizedAlbumUrl(href) !== key) return;

          this.applyMetadataToAlbumCard(album, metadata);

        });

      }



      extractFileFromItem(item) {

        const selfLink = item && item.matches && item.matches("a[href^='/f/'], a[href^='/v/'], a[href*='/f/'], a[href*='/v/']") ? item : null;

        const fileLink = selfLink || this.qs("a[href^='/f/'], a[href^='/v/'], a[href*='/f/'], a[href*='/v/']", item);

        if (!fileLink) return null;

        const href = fileLink.getAttribute('href') || '';

        if (!href) return null;



          const text = item.textContent || '';

          const image = Array.from(item.querySelectorAll('.grid-images_box-img, img')).find((candidate) => {

            const source = candidate.getAttribute('data-src')

              || candidate.getAttribute('data-lazy-src')

              || candidate.getAttribute('data-original')

              || candidate.getAttribute('src')

              || '';

            return source && !/video\.svg|placeholder|icon/i.test(source);

          });

          const rawThumb = image?.getAttribute('data-src')

            || image?.getAttribute('data-lazy-src')

            || image?.getAttribute('data-original')

            || image?.getAttribute('src')

            || '';

          const title = item.querySelector('p')?.textContent?.trim()

            || item.querySelector('.grid-images_box-name')?.textContent?.trim()

            || fileLink.textContent?.trim()

            || fileLink.getAttribute('title')?.trim()

            || image?.getAttribute('alt')?.trim()

            || href.split('/').pop()?.replace(/[-_]+/g, ' ').trim()

            || 'Untitled';

        const size = extractSizeFromText(text) || this.qs('.grid-images_box-size', item)?.textContent?.trim() || '';

        const dateText = extractDateFromText(text);

        const dateObj = dateText ? parseBunkrDate(dateText) : null;

        // Check if file is a video by badge, href or extension

        const hasVideoClass = !!this.qs('.type-Video, [data-type="video"], [data-file-type="video"], [data-icon*="video"], .ic-videos, svg[class*="video"], .fa-play, .fa-video', item);

        const isVideoHref = /\/v\//i.test(href);

        const isVideoExt = /\.(mp4|m4v|mkv|webm|mov|avi|wmv|ts|flv)(\?|$)/i.test(title || href);

        const isVideo = hasVideoClass || isVideoHref || isVideoExt;



        return {

          href,

          title,

          size,

          isVideo,

            thumbSrc: rawThumb,

          timestamp: dateObj ? dateObj.getTime() : 0,

        };

      }



      extractFilesFromDoc(doc) {

        const found = [];

        const candidates = this.qsa('.grid-images .theItem, .theItem, [class*="grid-images_box"], [class*="grid-images"] a[href*="/f/"], [class*="grid-images"] a[href*="/v/"]', doc);

        const sourceItems = candidates.length ? candidates : this.qsa("a[href*='/f/'], a[href*='/v/']", doc);



        sourceItems.forEach((node) => {

          const item = node.matches && node.matches('a[href*="/f/"], a[href*="/v/"]') ? node.closest('.theItem, [class*="grid-images_box"]') || node : node;

          const file = this.extractFileFromItem(item);

          if (file) found.push(file);

        });

        return found;

      }



      async fetchAlbumData(albumUrl, albumCard, options = {}) {

        const cacheKey = getNormalizedAlbumUrl(albumUrl);

        if (this.albumCache.has(cacheKey)) {

          const cached = this.albumCache.get(cacheKey);

          if (albumCard) this.applyMetadataToAlbumCard(albumCard, cached);

          const wantsAlbumDetails = options.indexOnly === false;

          if ((cached.files || []).length && isAlbumCacheFresh(cached) && (!wantsAlbumDetails || cached.detailsReady)) return cached;

        }



        const firstDoc = await this.fetchDocumentWithRetry(albumUrl);

        const albumDomain = this.getAlbumDomain(albumUrl);

        const headerText = this.qs('h1 + p', firstDoc)?.textContent?.trim() || '';

        const metaMatch = headerText.match(/\(([^)]+)\)/);

        const albumMeta = metaMatch ? metaMatch[1] : '';



        const discoveredUrls = this.getAlbumPageUrls(firstDoc, albumUrl).slice(0, CONFIG.maxAlbumPagesToScan);

        const docs = [firstDoc];

        const extraPageUrls = discoveredUrls.filter((u) => u !== albumUrl);

        await this.processWithConcurrency(extraPageUrls, CONFIG.concurrentAlbumPageFetches, async (pageUrl) => {

          const doc = await this.fetchDocumentWithRetry(pageUrl, 2).catch(() => null);

          if (doc) docs.push(doc);

        });

        const indexOnly = options.indexOnly !== false;



        const seen = new Set();

        const files = [];

        let totalBytes = 0;

        let oldestTimestamp = 0;

        let newestTimestamp = 0;



        let videoCount = 0;

        let photoCount = 0;

        docs.forEach((doc) => {

          this.extractFilesFromDoc(doc).forEach((file) => {

            if (!file) return;

            try {

              file.href = new URL(file.href, albumUrl).href;

            } catch {}

            try {

              file.thumbSrc = file.thumbSrc ? new URL(file.thumbSrc, albumUrl).href : '';

            } catch {

              file.thumbSrc = '';

            }

            if (seen.has(file.href)) return;

            seen.add(file.href);

            files.push(file);



            if (file.isVideo) {

              videoCount++;

              if (file.size) totalBytes += parseSizeToBytes(file.size);

            } else {

              photoCount++;

            }



            if (file.timestamp > 0) {

              if (!oldestTimestamp || file.timestamp < oldestTimestamp) oldestTimestamp = file.timestamp;

              if (!newestTimestamp || file.timestamp > newestTimestamp) newestTimestamp = file.timestamp;

            }

          });

        });

        const isPhotoOnly = (videoCount === 0 && photoCount > 0);



            const metadata = {

          albumUrl,

          albumDomain,

          albumName: this.qs('h1', firstDoc)?.textContent?.trim() || getAlbumTitleFromCard(albumCard) || albumUrl,

          files,

          fileCount: files.length,

          photoCount,

          isPhotoOnly,

          totalBytes,

          oldestTimestamp,

          newestTimestamp,

          previewIndex: files.map((f) => (f.title || '').toLowerCase()).filter(Boolean).join(' '),

          fetchedAt: Date.now(),

          fromPersistentCache: false,

          detailsReady: !indexOnly,

        };



        this.albumCache.set(cacheKey, metadata);

        this.queuePersistentAlbumSave(metadata);

        if (albumCard) this.applyMetadataToAlbumCard(albumCard, metadata);

        this.applyMetadataToAllMatchingCards(albumUrl, metadata);

        return metadata;

      }



      async processWithConcurrency(items, limit, worker) {

        const queue = [...items];

        const running = [];

        const max = Math.max(1, limit || 1);



        for (let i = 0; i < max; i++) {

          running.push(

            (async () => {

              while (queue.length) {

                const item = queue.shift();

                if (!item) return;

                await worker(item);

              }

            })()

          );

        }



        await Promise.all(running);

      }



      async fetchDocumentWithRetry(url, attempts = 3) {

        let lastError = null;

        for (let attempt = 1; attempt <= attempts; attempt++) {

          try {

            const res = await fetchTextCrossOrigin(url, {

              headers: {

                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',

              }

            });

            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            return new DOMParser().parseFromString(res.text, 'text/html');

          } catch (error) {

            lastError = error;

            if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 240 * attempt));

          }

        }

        throw lastError || new Error('Album request failed');

      }



      async fetchVisibleAlbums(limit = 100) {

        const albumUrls = this.getVisibleAlbums()

          .slice(0, Math.max(1, limit || 100))

          .map((album) => getNormalizedAlbumUrl(getAlbumUrlFromCard(album)))

          .filter(Boolean);



        const previousSelection = this.selectedAlbumUrls;

        this.selectedAlbumUrls = new Set(albumUrls);

        try {

          await this.fetchSelectedAlbums();

        } finally {

          this.selectedAlbumUrls = previousSelection;

        }

      }



      async fetchSelectedAlbums(options = {}) {

        const selected = Array.from(this.selectedAlbumUrls);

        const requestId = options && typeof options.requestId === 'string' ? options.requestId : '';

        const emitBridgeProgress = !!(options && options.emitBridgeProgress && this.bridge);

        if (!selected.length) {

          this.emitStatus('No albums to fetch.');

          if (emitBridgeProgress) {

            this.bridge.emitFetchProgress(requestId, 'empty', {

              total: 0,

              processed: 0,

              status: 'No albums to fetch.',

            });

          }

          return;

        }



        let done = 0;

        const failed = [];

        this.emitStatus(`Fetching albums: 0/${selected.length}`);

        if (emitBridgeProgress) {

          this.bridge.emitFetchProgress(requestId, 'start', {

            total: selected.length,

            processed: 0,

            status: `Fetching albums: 0/${selected.length}`,

          });

        }

        try {

          await this.processWithConcurrency(selected, CONFIG.concurrentAlbumFetches, async (normalizedUrl) => {

            const album = this.getAlbumCardByUrl(normalizedUrl);

            const realUrl = album ? getAlbumUrlFromCard(album) : normalizedUrl;

            if (!realUrl) return;

            try {

              await this.fetchAlbumData(realUrl, album);

            } catch (error) {

              failed.push({ url: realUrl, message: error?.message || 'Fetch failed' });

            }

            done += 1;

            this.updateDashboard();

            if (done % CONFIG.fetchRenderEveryAlbums === 0 || done === selected.length) this.scheduleLibraryRender();

            const status = `Fetching albums: ${done}/${selected.length}`;

            this.emitStatus(status);

            if (emitBridgeProgress) {

              this.bridge.emitFetchProgress(requestId, 'progress', {

                total: selected.length,

                processed: done,

                albumUrl: normalizedUrl,

                status,

              });

            }

          });

        } catch (error) {

          if (emitBridgeProgress) {

            this.bridge.emitFetchProgress(requestId, 'error', {

              total: selected.length,

              processed: done,

              status: error?.message || 'Fetch failed.',

            });

          }

          throw error;

        }



        this.applyGlobalFilter(this.activeGlobalFilter);

        this.flushPersistentAlbumCache();

        const successful = selected.length - failed.length;

        this.emitStatus(failed.length

          ? `Fetched ${successful}/${selected.length} albums · ${failed.length} failed after retries.`

          : `Fetched video metadata for ${selected.length} album(s).`);

        if (emitBridgeProgress) {

          this.bridge.emitFetchProgress(requestId, 'complete', {

            total: selected.length,

            processed: done,

            status: failed.length ? `Fetched ${successful}/${selected.length} albums.` : `Fetched video metadata for ${selected.length} album(s).`,

            failed,

            state: this.getBridgeStateSnapshot(),

          });

        }

      }



      async copySelectedFileNames() {

        const selected = Array.from(this.selectedAlbumUrls);

        if (!selected.length) {

          this.emitStatus('No albums selected.');

          return;

        }



        const blocks = [];

        for (const normalizedUrl of selected) {

          const card = this.getAlbumCardByUrl(normalizedUrl);

          const realUrl = card ? getAlbumUrlFromCard(card) : normalizedUrl;

          if (!realUrl) continue;

          const data = await this.fetchAlbumData(realUrl, card, { requireFiles: true });

          const albumName = getAlbumTitleFromCard(card) || realUrl;

          const fileLines = data.files.map((f) => `${f.title || 'Untitled'}${f.size ? ` | ${f.size}` : ''}`);

          blocks.push(`# ${albumName}`);

          blocks.push(...fileLines);

          blocks.push('');

        }



        const text = blocks.join('\n').trim();

        if (!text) {

          this.emitStatus('No file names available to copy.');

          return;

        }



        await navigator.clipboard.writeText(text);

        this.emitStatus(`Copied file names for ${selected.length} album(s).`);

      }



      getAlbumPageUrls(doc, albumUrl) {

        const urls = new Set([albumUrl]);

        const base = new URL(albumUrl);

        const baseRoot = getAlbumRootKey(albumUrl);



        this.qsa('a[href]', doc).forEach((a) => {

          try {

            const href = a.getAttribute('href');

            if (!href) return;

            const abs = new URL(href, albumUrl);

            if (abs.origin !== base.origin) return;

            if (getAlbumRootKey(abs.toString()) !== baseRoot) return;



            const hasPageQuery = /[?&]page=\d+/i.test(abs.search);

            const hasTrailingPage = /\/\d+\/?$/.test(abs.pathname);

            if (hasPageQuery || hasTrailingPage) {

              urls.add(abs.toString());

            }

          } catch {

            // ignore malformed links

          }

        });



        return Array.from(urls);

      }



      setupHoverPreview(album) {

        if (album.dataset.previewBound === '1') return;

        album.dataset.previewBound = '1';



        const albumLink = (album.matches && album.matches('a[href*="/a/"]')) ? album : this.qs("a[href^='https://bunkr.'], a[href*='/a/']", album);

        if (!albumLink) return;

        const albumUrl = albumLink.href;

        const albumTextContainer = this.qs('.flex-1.grid.auto-rows-max', album) || this.qs('.p-3\\.5', album) || album;



        this.ensureAlbumMetaBadge(album);



        let previewContainer = this.qs('.album-preview-flex', albumTextContainer);

        if (!previewContainer) {

          previewContainer = this.createPreviewContainer();

          albumTextContainer.appendChild(previewContainer);

        }



        album.addEventListener('mouseenter', () => this.showPreview(albumUrl, previewContainer));

        album.addEventListener('mouseleave', () => this.hidePreview(previewContainer));

        album.addEventListener('pointerdown', (e) => {

          if (e.target.closest('.album-preview-flex, .bae-album-controls, [class*="nexus-"], [data-nexus-prevent-nav]')) return;

          if (!this.selectionMode) return;

          e.preventDefault();

          e.stopPropagation();

        }, true);

        album.addEventListener('click', (e) => this.handleAlbumClick(e, albumUrl, previewContainer), true);

      }



      createPreviewContainer() {

        const container = document.createElement('div');

        container.className = 'album-preview-flex';

        container.style = `

display: none;

flex-wrap: wrap;

justify-content: center;

gap: 12px;

padding: 10px;

background: #222;

border-radius: 5px;

margin-top: 10px;

max-width: 100%;

overflow: hidden;

`;

        return container;

      }



      async showPreview(albumUrl, container) {

        if (!this.hoverPreviewsEnabled) return;

        this.previewTimeout = setTimeout(async () => {

          if (!this.hoverPreviewsEnabled) return;

          if (this.selectionMode) return;

          if (container.innerHTML.trim()) {

            container.style.display = 'flex';

            return;

          }



          try {

            const albumElement = container.closest('.rounded-xl.bg-mute.border-b, a.card[href*="/a/"]');

            const cached = this.albumCache.get(getNormalizedAlbumUrl(albumUrl));

            const hasThumbs = (cached?.files || []).some((file) => file.thumbSrc);

            const data = await this.fetchAlbumData(albumUrl, albumElement, { requireFiles: true, indexOnly: hasThumbs });



            container.innerHTML = '';



            // Info Bar

            const infoBar = document.createElement('div');

            infoBar.style = 'width: 100%; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; border-bottom: 1px solid #444; padding-bottom: 8px;';



            const searchInput = document.createElement('input');

            searchInput.placeholder = '🔍 Filter videos...';

            searchInput.style = 'background: #111827; color: #fff; border: 1px solid #4b5563; border-radius: 8px; padding: 8px 10px; font-size: 13px; flex: 1; min-width: 260px; outline: none;';



            const filteredCountText = document.createElement('span');

            filteredCountText.style = 'color: #9ca3af; font-size: 12px; min-width: 74px; text-align: right;';

            filteredCountText.textContent = '0/0';



            searchInput.addEventListener('input', (e) => {

              const terms = (e.target.value || '').toLowerCase().trim().split(/\s+/).filter(Boolean);

              let visible = 0;

              const cards = container.querySelectorAll('.preview-item-wrapper');

              cards.forEach(el => {

                const title = (el.getAttribute('data-title') || '').toLowerCase();

                const size = (el.getAttribute('data-size') || '').toLowerCase();

                const haystack = `${title} ${size}`;

                const match = terms.length === 0 || terms.every(t => haystack.includes(t));

                el.style.display = match ? 'flex' : 'none';

                if (match) visible++;

              });

              filteredCountText.textContent = `${visible}/${cards.length}`;

            });

            // Isolation to prevent album navigation

            ['click', 'mousedown', 'mouseup', 'keydown', 'keyup'].forEach(evName => {

              searchInput.addEventListener(evName, (e) => e.stopPropagation());

            });



            const copyBtn = document.createElement('button');

            copyBtn.textContent = '📋 Links';

            copyBtn.style = 'background: #1f2937; color: #fff; border: 1px solid #4b5563; border-radius: 8px; padding: 7px 10px; font-size: 12px; cursor: pointer; white-space: nowrap;';

            copyBtn.addEventListener('click', (e) => {

              e.preventDefault();

              e.stopPropagation();

              const visibleItems = Array.from(container.querySelectorAll('.preview-item-wrapper'))

                .filter(el => el.style.display !== 'none');

              const links = visibleItems.map(el => el.getAttribute('data-url')).join('\n');

              navigator.clipboard.writeText(links).then(() => {

                const oldText = copyBtn.textContent;

                copyBtn.textContent = '✅ Copied!';

                setTimeout(() => copyBtn.textContent = oldText, 2000);

              });

            });

            copyBtn.addEventListener('click', (e) => e.stopPropagation());



            const infoText = document.createElement('span');

            infoText.style = 'color: #cbd5e1; font-size: 12px; font-weight: 600; white-space: nowrap; margin-right: auto;';



            // Build info text with size and dates

            let infoContent = '';

            if (data.totalBytes > 0) {

              infoContent += formatBytes(data.totalBytes);

            }

            if (data.oldestTimestamp && data.newestTimestamp) {

              const oldestStr = new Date(data.oldestTimestamp).toLocaleDateString('en-GB');

              const newestStr = new Date(data.newestTimestamp).toLocaleDateString('en-GB');

              if (oldestStr === newestStr) {

                infoContent += ` • ${oldestStr}`;

              } else {

                infoContent += ` • ${oldestStr} → ${newestStr}`;

              }

            }

            if (!infoContent) {

              infoContent = `${data.fileCount} Videos`;

            } else if (data.fileCount) {

              infoContent += ` • ${data.fileCount} Videos`;

            }



            infoText.textContent = infoContent;



            infoBar.append(infoText, searchInput, filteredCountText, copyBtn);

            container.appendChild(infoBar);



            data.files.slice(0, CONFIG.maxPreviews).forEach((file) => {

              if (!file.thumbSrc || !file.href) return;

              const img = { src: file.thumbSrc };

              const fileLink = { getAttribute: () => file.href };

              this.addPreviewItem(img, fileLink, data.albumDomain, file.size, file.isVideo, file.title, container);

            });



            const renderedCards = container.querySelectorAll('.preview-item-wrapper').length;

            filteredCountText.textContent = `${renderedCards}/${renderedCards}`;



            container.style.display = 'flex';

          } catch (error) {

            console.error('[Bunkr Albums Enhanced]', error);

            container.innerHTML = '<p style="color:white">Preview unavailable</p>';

            container.style.display = 'flex';

          }

        }, CONFIG.previewDelay);

      }



      addPreviewItem(img, fileLink, domain, size, isVideo, title, container) {

        const wrapper = document.createElement('div');

        const fullUrl = `https://${domain}${fileLink.getAttribute('href')}`;

        wrapper.className = 'preview-item-wrapper';

        wrapper.setAttribute('data-title', title.toLowerCase());

        wrapper.setAttribute('data-url', fullUrl);

        wrapper.setAttribute('data-size', (size || '').toLowerCase());

        wrapper.style = `position: relative; width: min(${CONFIG.previewSize}, 42vw); transition: transform 0.1s; display: flex; flex-direction: column; gap: 4px;`;



        const thumb = document.createElement('img');

        thumb.src = img.src;

        thumb.title = title;

        thumb.style = `width: 100%; height: 138px; object-fit: cover; border-radius: 6px; cursor: pointer; border: 1px solid #444;`;

        thumb.alt = 'Preview';



        const caption = document.createElement('div');

        caption.style = 'display: flex; flex-direction: column; gap: 2px; background: rgba(15,23,42,0.88); border: 1px solid #334155; border-radius: 6px; padding: 4px 6px; min-height: 38px;';



        const titleLine = document.createElement('div');

        titleLine.textContent = title || 'Untitled';

        titleLine.style = 'color: #f8fafc; font-size: 11px; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';



        const metaLine = document.createElement('div');

        metaLine.style = 'display: flex; justify-content: space-between; align-items: center; gap: 6px; color: #cbd5e1; font-size: 10px;';



        const typeText = document.createElement('span');

        typeText.textContent = 'VIDEO';



        const sizeText = document.createElement('span');

        sizeText.textContent = size || '-';



        metaLine.append(typeText, sizeText);

        caption.append(titleLine, metaLine);



        if (isVideo) {

          const vidBadge = document.createElement('span');

          vidBadge.textContent = '▶';

          vidBadge.style = 'position: absolute; top: 4px; left: 4px; background: rgba(124, 58, 237, 0.9); color: #fff; font-size: 10px; width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; border-radius: 50%; pointer-events: none; border: 0.5px solid #fff;';

          wrapper.appendChild(vidBadge);

        }



        wrapper.addEventListener('mouseenter', () => wrapper.style.transform = 'scale(1.05)');

        wrapper.addEventListener('mouseleave', () => wrapper.style.transform = 'scale(1)');



        wrapper.addEventListener('click', (e) => {

          e.preventDefault();

          e.stopPropagation();

          window.open(`https://${domain}${fileLink.getAttribute('href')}`, '_blank');

        });



        wrapper.appendChild(thumb);

        wrapper.appendChild(caption);

        container.appendChild(wrapper);

      }



      hidePreview(container) {

        clearTimeout(this.previewTimeout);

        container.style.display = 'none';

      }



      handleAlbumClick(e, albumUrl, previewContainer) {

        // Ignore if clicking anywhere inside preview area or Nexus suite UI

        if (e.target.closest('.album-preview-flex, .bae-album-controls, [class*="nexus-"], [data-nexus-prevent-nav]')) {

          return;

        }

        if (this.selectionMode) {

          e.preventDefault();

          e.stopPropagation();

          const key = getNormalizedAlbumUrl(albumUrl);

          const shouldSelect = !this.selectedAlbumUrls.has(key);

          if (shouldSelect) this.selectedAlbumUrls.add(key);

          else this.selectedAlbumUrls.delete(key);

          const card = this.getAlbumCardByUrl(albumUrl);

          const checkbox = card ? this.qs('.bae-select-album-checkbox', card) : null;

          if (checkbox) checkbox.checked = shouldSelect;

          this.updateSelectionBar();

          this.emitStatus(`Selected ${this.selectedAlbumUrls.size} album(s).`);

          return;

        }

        window.location.href = albumUrl;

      }

    }



  /* ═══════════════════════════════════════════════════════════════════

     NEXUS BALBUMS VAULT HUD & QUICK PEEK EXTENSION (INTEGRATED)

     ═══════════════════════════════════════════════════════════════════ */

    





    /* ═══════════════════════════════════════════════════════════════════

       NEXUS BALBUMS VAULT HUD & QUICK PEEK EXTENSION (INTEGRATED)

       ═══════════════════════════════════════════════════════════════════ */

    const TOOLBAR_ID = 'nexus-balbums-toolbar';

    const BUBBLE_ID = 'nexus-balbums-bubble';

    const PLAYER_ID = 'nexus-balbums-player';

    const STORAGE_POS_KEY = 'nexus_balbums_pos';

    const STORAGE_MIN_KEY = 'nexus_balbums_minimized';

    const STORAGE_PEEK_LAYOUT_KEY = 'nexus_balbums_peek_layout';



    let hidePhotosActive = true;



    function escapeHtml(str) {

      return String(str || '')

        .replace(/&/g, '&amp;')

        .replace(/</g, '&lt;')

        .replace(/>/g, '&gt;')

        .replace(/"/g, '&quot;')

        .replace(/'/g, '&#039;');

    }



    function injectNexusStyles() {

      if (document.getElementById('nexus-balbums-integrated-styles')) return;

      const s = document.createElement('style');

      s.id = 'nexus-balbums-integrated-styles';

      s.textContent = `

/* Floating Vault Toolbar */

#nexus-balbums-toolbar {

  position: fixed;

  z-index: 2147483640;

  width: 340px;

  background: rgba(13, 17, 23, 0.95);

  border: 1px solid rgba(255, 255, 255, 0.16);

  border-radius: 12px;

  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.7);

  backdrop-filter: blur(14px);

  padding: 12px;

  display: flex;

  flex-direction: column;

  gap: 8px;

  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;

  color: #c9d1d9;

  font-size: 13px;

  user-select: none;

  box-sizing: border-box;

}

#nexus-balbums-toolbar.nexus-balbums-minimized {

  display: none !important;

}



#nexus-balbums-bubble {

  position: fixed;

  bottom: 24px;

  right: 24px;

  z-index: 2147483641;

  width: 48px;

  height: 48px;

  border-radius: 50%;

  background: #1f6feb;

  color: #fff;

  display: none;

  align-items: center;

  justify-content: center;

  font-size: 22px;

  cursor: pointer;

  box-shadow: 0 8px 24px rgba(31, 111, 235, 0.6);

  transition: transform 0.2s, background 0.2s;

}

#nexus-balbums-bubble:hover {

  transform: scale(1.1);

  background: #388bfd;

}

#nexus-balbums-bubble.is-visible {

  display: flex !important;

}



.nexus-header {

  display: flex;

  align-items: center;

  justify-content: space-between;

  cursor: grab;

  padding-bottom: 6px;

  border-bottom: 1px solid rgba(255, 255, 255, 0.08);

}

.nexus-header:active {

  cursor: grabbing;

}

.nexus-brand {

  font-weight: 800;

  font-size: 11px;

  letter-spacing: 0.08em;

  color: #58a6ff;

  text-transform: uppercase;

}

.nexus-title {

  font-weight: 700;

  font-size: 13px;

  color: #f0f6fc;

}

.nexus-min-btn {

  background: transparent;

  border: none;

  color: #8b949e;

  cursor: pointer;

  font-size: 16px;

  padding: 0 4px;

  line-height: 1;

}

.nexus-min-btn:hover {

  color: #f0f6fc;

}



.nexus-info {

  display: flex;

  justify-content: space-between;

  font-size: 12px;

  color: #8b949e;

}

.nexus-info b {

  color: #f0f6fc;

}



.nexus-filter-box {

  display: flex;

  flex-direction: column;

  gap: 6px;

}

.nexus-filter-grid {

  display: grid;

  grid-template-columns: 1fr 1fr;

  gap: 6px;

}

.nexus-filter-field {

  display: flex;

  flex-direction: column;

  gap: 2px;

}

.nexus-filter-label {

  font-size: 10px;

  text-transform: uppercase;

  color: #8b949e;

  font-weight: 700;

}

.nexus-select, .nexus-search-input {

  width: 100%;

  background: rgba(22, 27, 34, 0.9);

  border: 1px solid rgba(255, 255, 255, 0.15);

  border-radius: 6px;

  color: #f0f6fc;

  font-size: 11px;

  padding: 5px 8px;

  outline: none;

  box-sizing: border-box;

}

.nexus-select:focus, .nexus-search-input:focus {

  border-color: #58a6ff;

}



.nexus-toggles {

  display: flex;

  gap: 6px;

}

.nexus-toggle-btn {

  flex: 1;

  background: rgba(22, 27, 34, 0.8);

  border: 1px solid rgba(255, 255, 255, 0.15);

  border-radius: 6px;

  color: #8b949e;

  font-size: 11px;

  padding: 5px 0;

  cursor: pointer;

  font-weight: 600;

  text-align: center;

  transition: all 0.15s ease;

}

.nexus-toggle-btn:hover {

  background: rgba(30, 41, 59, 0.9);

  color: #f0f6fc;

}

.nexus-toggle-btn.is-active-orange {

  background: #f0883e !important;

  color: #0d1117 !important;

  border-color: #f0883e !important;

  font-weight: 700 !important;

}



.nexus-btn-group {

  display: flex;

  gap: 5px;

}

.nexus-btn-sub {

  flex: 1;

  background: rgba(33, 38, 45, 0.85);

  border: 1px solid rgba(255, 255, 255, 0.15);

  border-radius: 6px;

  color: #c9d1d9;

  font-size: 11px;

  font-weight: 600;

  padding: 6px 4px;

  cursor: pointer;

  text-align: center;

  transition: all 0.15s ease;

}

.nexus-btn-sub:hover {

  background: #30363d;

  color: #f0f6fc;

}

.nexus-btn-main {

  background: linear-gradient(135deg, #238636 0%, #2ea043 100%);

  border: 1px solid rgba(255, 255, 255, 0.2);

  border-radius: 6px;

  color: #fff;

  font-size: 11px;

  font-weight: 700;

  padding: 6px 8px;

  cursor: pointer;

  text-align: center;

}

.nexus-btn-tester {

  background: linear-gradient(135deg, #8957e5 0%, #a371f7 100%);

  border: 1px solid rgba(255, 255, 255, 0.2);

  border-radius: 6px;

  color: #fff;

  font-size: 11px;

  font-weight: 700;

  padding: 6px 8px;

  cursor: pointer;

  text-align: center;

}



/* Quick Peek Eye Button on Card */

.nexus-balbums-peek-btn {

  position: absolute !important;

  top: 8px !important;

  right: 8px !important;

  z-index: 9999 !important;

  background: rgba(13, 17, 23, 0.9) !important;

  border: 1px solid rgba(255, 255, 255, 0.3) !important;

  border-radius: 6px !important;

  padding: 4px 6px !important;

  color: #fff !important;

  cursor: pointer !important;

  font-size: 13px !important;

  box-shadow: 0 4px 12px rgba(0,0,0,0.5) !important;

  backdrop-filter: blur(4px) !important;

  user-select: none !important;

  line-height: 1 !important;

  transition: transform 0.15s, background 0.15s !important;

}

.nexus-balbums-peek-btn:hover {

  background: #1f6feb !important;

  border-color: #58a6ff !important;

  transform: scale(1.12) !important;

}



/* Photo album styling and hiding */

.bae-photo-album.nexus-hidden-photo {

  display: none !important;

}



/* Quick Peek Modal */

#nexus-balbums-peek-modal {

  position: fixed;

  inset: 0;

  z-index: 2147483645;

  display: flex;

  align-items: center;

  justify-content: center;

  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;

}

.nexus-peek-backdrop {

  position: absolute;

  inset: 0;

  background: rgba(0, 0, 0, 0.75);

  backdrop-filter: blur(6px);

}

.nexus-peek-dialog {

  position: relative;

  z-index: 10;

  width: min(92vw, 1100px);

  max-height: 88vh;

  background: #0d1117;

  border: 1px solid rgba(255, 255, 255, 0.18);

  border-radius: 14px;

  box-shadow: 0 24px 60px rgba(0,0,0,0.8);

  display: flex;

  flex-direction: column;

  overflow: hidden;

}

.nexus-peek-header {

  padding: 12px 18px;

  background: #161b22;

  border-bottom: 1px solid rgba(255, 255, 255, 0.1);

  display: flex;

  align-items: center;

  justify-content: space-between;

}

.nexus-peek-controls {

  padding: 8px 18px;

  background: #0d1117;

  border-bottom: 1px solid rgba(255, 255, 255, 0.08);

  display: flex;

  align-items: center;

  justify-content: space-between;

  gap: 12px;

  flex-wrap: wrap;

}

.nexus-peek-layout-btns {

  display: flex;

  background: #161b22;

  border-radius: 6px;

  padding: 2px;

  border: 1px solid rgba(255, 255, 255, 0.1);

}

.nexus-peek-layout-btn {

  background: transparent;

  border: none;

  color: #8b949e;

  font-size: 11px;

  padding: 4px 8px;

  border-radius: 4px;

  cursor: pointer;

  font-weight: 600;

}

.nexus-peek-layout-btn.is-active {

  background: #1f6feb;

  color: #fff;

}

.nexus-peek-grid {

  flex: 1;

  overflow-y: auto;

  padding: 16px;

  display: grid;

  gap: 12px;

  background: #090d13;

}

.nexus-peek-grid[data-layout="3x2"] {

  grid-template-columns: repeat(3, minmax(0, 1fr));

}

.nexus-peek-grid[data-layout="4x3"] {

  grid-template-columns: repeat(4, minmax(0, 1fr));

}

.nexus-peek-grid[data-layout="2x2"] {

  grid-template-columns: repeat(2, minmax(0, 1fr));

}

.nexus-peek-grid[data-layout="list"] {

  grid-template-columns: 1fr;

}

.nexus-peek-card {

  background: #161b22;

  border: 1px solid rgba(255, 255, 255, 0.1);

  border-radius: 8px;

  overflow: hidden;

  display: flex;

  flex-direction: column;

  position: relative;

  transition: transform 0.15s, border-color 0.15s;

}

.nexus-peek-card:hover {

  transform: translateY(-2px);

  border-color: #58a6ff;

}

.nexus-peek-poster {

  position: relative;

  width: 100%;

  aspect-ratio: 16 / 9;

  background: #000;

  display: flex;

  align-items: center;

  justify-content: center;

  overflow: hidden;

  cursor: pointer;

}

.nexus-peek-poster img {

  width: 100%;

  height: 100%;

  object-fit: cover;

}

.nexus-peek-play-btn {

  position: absolute;

  width: 36px;

  height: 36px;

  border-radius: 50%;

  background: rgba(31, 111, 235, 0.9);

  color: #fff;

  display: flex;

  align-items: center;

  justify-content: center;

  font-size: 15px;

  padding-left: 2px;

  box-shadow: 0 4px 12px rgba(0,0,0,0.5);

  pointer-events: none;

  transition: transform 0.15s;

}

.nexus-peek-card:hover .nexus-peek-play-btn {

  transform: scale(1.15);

}

.nexus-peek-card-body {

  padding: 8px 10px;

  display: flex;

  flex-direction: column;

  gap: 4px;

}

.nexus-peek-card-title {

  font-size: 12px;

  font-weight: 600;

  color: #f0f6fc;

  overflow: hidden;

  text-overflow: ellipsis;

  white-space: nowrap;

}

.nexus-peek-card-actions {

  display: flex;

  gap: 6px;

  margin-top: 4px;

}

.nexus-peek-btn-import {

  flex: 1;

  background: #238636;

  border: none;

  border-radius: 4px;

  color: #fff;

  font-size: 11px;

  font-weight: 600;

  padding: 4px 0;

  cursor: pointer;

}

.nexus-peek-btn-open {

  background: #21262d;

  border: 1px solid rgba(255, 255, 255, 0.15);

  border-radius: 4px;

  color: #c9d1d9;

  font-size: 11px;

  padding: 4px 8px;

  text-decoration: none;

  display: flex;

  align-items: center;

}



/* Cinema Video Player */

#nexus-balbums-player {

  position: fixed;

  inset: 0;

  z-index: 2147483647;

  display: flex;

  align-items: center;

  justify-content: center;

}

.nexus-player-dialog {

  position: relative;

  z-index: 10;

  width: min(94vw, 1200px);

  height: min(88vh, 760px);

  background: #000;

  border: 1px solid rgba(255, 255, 255, 0.2);

  border-radius: 12px;

  overflow: hidden;

  display: flex;

  flex-direction: column;

}

.nexus-player-header {

  padding: 10px 16px;

  background: #161b22;

  border-bottom: 1px solid rgba(255, 255, 255, 0.1);

  display: flex;

  align-items: center;

  justify-content: space-between;

}



/* ===== FIXED PEEK LAYOUT (v1.8.56) ===== */

#nexus-balbums-peek-modal .nexus-peek-dialog {

  width: min(94vw, 1200px) !important;

  height: min(90vh, 880px) !important;

  max-height: 90vh !important;

  display: flex !important;

  flex-direction: column !important;

  box-sizing: border-box !important;

  overflow: hidden !important;

}



#nexus-balbums-peek-modal .nexus-peek-header,

#nexus-balbums-peek-modal .nexus-peek-controls {

  flex: 0 0 auto !important;

}



#nexus-balbums-peek-modal .nexus-peek-controls {

  row-gap: 8px !important;

  padding: 8px 16px !important;

}



#nexus-balbums-peek-modal .nexus-peek-grid {

  flex: 1 1 0 !important;

  min-height: 0 !important;

  height: 100% !important;

  overflow-y: auto !important;

  overflow-x: hidden !important;

  padding: 16px !important;

  gap: 14px !important;

  align-content: start !important;

  align-items: start !important;

  grid-auto-rows: max-content !important;

  scrollbar-width: thin !important;

  scrollbar-color: #388bfd #0d1117 !important;

}



#nexus-balbums-peek-modal .nexus-peek-grid::-webkit-scrollbar {

  width: 10px !important;

}

#nexus-balbums-peek-modal .nexus-peek-grid::-webkit-scrollbar-track {

  background: #090d13 !important;

}

#nexus-balbums-peek-modal .nexus-peek-grid::-webkit-scrollbar-thumb {

  background: #30363d !important;

  border-radius: 6px !important;

}

#nexus-balbums-peek-modal .nexus-peek-grid::-webkit-scrollbar-thumb:hover {

  background: #58a6ff !important;

}



/* Explicit columns per layout with high priority */

#nexus-balbums-peek-modal .nexus-peek-grid[data-layout="3x2"] {

  grid-template-columns: repeat(3, minmax(0, 1fr)) !important;

}

#nexus-balbums-peek-modal .nexus-peek-grid[data-layout="4x3"] {

  grid-template-columns: repeat(4, minmax(0, 1fr)) !important;

}

#nexus-balbums-peek-modal .nexus-peek-grid[data-layout="2x2"] {

  grid-template-columns: repeat(2, minmax(0, 1fr)) !important;

}

#nexus-balbums-peek-modal .nexus-peek-grid[data-layout="list"] {

  grid-template-columns: 1fr !important;

}



/* Card dimensions - solid and stable */

#nexus-balbums-peek-modal .nexus-peek-card {

  flex: 0 0 auto !important;

  min-width: 0 !important;

  height: auto !important;

  box-sizing: border-box !important;

}



#nexus-balbums-peek-modal .nexus-peek-grid:not([data-layout="list"]) .nexus-peek-poster {

  position: relative !important;

  width: 100% !important;

  height: auto !important;

  aspect-ratio: 16 / 9 !important;

  min-height: 120px !important;

  flex: 0 0 auto !important;

  overflow: hidden !important;

  background: #000 !important;

}



#nexus-balbums-peek-modal .nexus-peek-poster img {

  position: absolute !important;

  inset: 0 !important;

  width: 100% !important;

  height: 100% !important;

  object-fit: cover !important;

}



#nexus-balbums-peek-modal .nexus-peek-card-body {

  flex: 0 0 auto !important;

  padding: 8px 10px !important;

}



#nexus-balbums-peek-modal .nexus-peek-card-actions {

  display: flex !important;

  gap: 6px !important;

  flex-wrap: nowrap !important;

}



#nexus-balbums-peek-modal .nexus-peek-btn-import {

  flex: 0 0 38px !important;

  width: 38px !important;

  background: #238636 !important;

  color: #fff !important;

  font-size: 13px !important;

  font-weight: 700 !important;

  border-radius: 4px !important;

  border: none !important;

  cursor: pointer !important;

  display: inline-flex !important;

  align-items: center !important;

  justify-content: center !important;

  line-height: 1 !important;

  padding: 5px 0 !important;

}

#nexus-balbums-peek-modal .nexus-peek-btn-import:hover {

  background: #2ea043 !important;

}



#nexus-balbums-peek-modal .nexus-peek-btn-open {

  flex: 0 0 32px !important;

  width: 32px !important;

  justify-content: center !important;

  align-items: center !important;

  padding: 4px 0 !important;

}



#nexus-balbums-peek-modal .nexus-peek-card-actions .nexus-btn-sub {

  min-width: 0 !important;

  flex: 1 1 auto !important;

}



/* List layout specific styling */

#nexus-balbums-peek-modal .nexus-peek-grid[data-layout="list"] .nexus-peek-card {

  flex-direction: row !important;

  align-items: center !important;

  padding: 8px 12px !important;

  gap: 12px !important;

  min-height: 64px !important;

}

#nexus-balbums-peek-modal .nexus-peek-grid[data-layout="list"] .nexus-peek-poster {

  position: relative !important;

  width: 104px !important;

  height: 58px !important;

  aspect-ratio: 16 / 9 !important;

  flex: 0 0 104px !important;

  border-radius: 4px !important;

}

      `;

      (document.head || document.documentElement).appendChild(s);

    }



    function makeDraggableElement(el, handle) {

      let isDragging = false, startX = 0, startY = 0, origX = 0, origY = 0;

      handle.addEventListener('mousedown', (e) => {

        if (e.target.closest('button, input, select')) return;

        isDragging = true;

        startX = e.clientX; startY = e.clientY;

        const rect = el.getBoundingClientRect();

        origX = rect.left; origY = rect.top;

        document.addEventListener('mousemove', onMove);

        document.addEventListener('mouseup', onUp);

        e.preventDefault();

      });

      function onMove(e) {

        if (!isDragging) return;

        el.style.left = (origX + e.clientX - startX) + 'px';

        el.style.top = (origY + e.clientY - startY) + 'px';

        el.style.right = 'auto'; el.style.bottom = 'auto';

      }

      function onUp() {

        if (!isDragging) return;

        isDragging = false;

        document.removeEventListener('mousemove', onMove);

        document.removeEventListener('mouseup', onUp);

        const rect = el.getBoundingClientRect();

        try { localStorage.setItem(STORAGE_POS_KEY, JSON.stringify({ x: rect.left, y: rect.top })); } catch {}

      }

    }



    function openCinemaPlayer(fileUrl, title) {

      let player = document.getElementById(PLAYER_ID);

      if (player) player.remove();



      player = document.createElement('div');

      player.id = PLAYER_ID;

      player.innerHTML = `

        <div class="nexus-peek-backdrop"></div>

        <div class="nexus-player-dialog">

          <div class="nexus-player-header">

            <span style="font-weight:700;font-size:13px;color:#f0f6fc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:80%;">

              🎬 ${escapeHtml(title)}

            </span>

            <button type="button" class="nexus-min-btn" style="font-size:20px;" id="nexus-player-close">✕</button>

          </div>

          <div style="flex:1;background:#000;display:flex;align-items:center;justify-content:center;">

            <iframe src="${escapeHtml(fileUrl)}" style="width:100%;height:100%;border:none;" allowfullscreen></iframe>

          </div>

        </div>

      `;

      document.body.appendChild(player);

      const close = () => player.remove();

      player.querySelector('#nexus-player-close').addEventListener('click', close);

      player.querySelector('.nexus-peek-backdrop').addEventListener('click', close);

    }



    function sendVideosToTester(files, albumTitle, albumUrl) {

      const links = files.map(f => ({ url: f.href, host: 'bunkr', text: f.title || 'Bunkr video', quality: 'HD' }));

      const payload = { thread_title: `Balbums: ${albumTitle}`, thread_url: albumUrl, links, autostart: true, autoselect: true };

      postJsonCrossOrigin('http://localhost:8000/api/v1/hunter/push', payload)

        .then(res => {

          if (res?.session_id) window.open(`http://localhost:8000/tester?hunter=1&session=${encodeURIComponent(res.session_id)}&autostart=1`, '_blank');

        }).catch(() => {});

    }



    // ── Dashboard bridge (self-contained: port detect, meta fetch, import) ──

    const NEXUS_PORT_KEY = 'nexus_balbums_port';

    const nexusMetaCache = new Map();

    let nexusPort = Number(localStorage.getItem(NEXUS_PORT_KEY)) || 8000;

    let nexusPortPromise = null;



    function nexusToast(msg, isErr) {

      let el = document.getElementById('nexus-balbums-toast');

      if (!el) {

        el = document.createElement('div');

        el.id = 'nexus-balbums-toast';

        el.style.cssText = 'position:fixed;left:20px;bottom:20px;z-index:2147483647;max-width:420px;padding:10px 14px;border-radius:8px;font:600 12px/1.4 system-ui,sans-serif;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.6);transition:opacity .25s;pointer-events:none;';

        document.body.appendChild(el);

      }

      el.textContent = msg;

      el.style.background = isErr ? '#da3633' : '#238636';

      el.style.opacity = '1';

      clearTimeout(el._t);

      el._t = setTimeout(() => { el.style.opacity = '0'; }, 4200);

    }



    function nexusReq(method, url, body, timeout) {

      return new Promise((resolve, reject) => {

        const gm = (typeof GM_xmlhttpRequest === 'function') ? GM_xmlhttpRequest

          : (typeof GM !== 'undefined' && GM.xmlHttpRequest) ? GM.xmlHttpRequest.bind(GM) : null;

        if (!gm) {

          fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body })

            .then(async (r) => resolve({ ok: r.ok, status: r.status, json: await r.json().catch(() => ({})) }))

            .catch(reject);

          return;

        }

        gm({

          method, url, data: body, timeout: timeout || 20000,

          headers: { 'Content-Type': 'application/json' },

          onload: (r) => {

            let j = {};

            try { j = JSON.parse(r.responseText || '{}'); } catch {}

            resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, json: j });

          },

          onerror: () => reject(new Error('Dashboard nedostupný')),

          ontimeout: () => reject(new Error('Dashboard timeout')),

        });

      });

    }



    async function nexusDetectPort() {

      if (!nexusPortPromise) {

        nexusPortPromise = (async () => {

          const ports = [nexusPort, ...[8000, 8001, 8002, 8003].filter((p) => p !== nexusPort)];

          for (const p of ports) {

            try {

              const r = await nexusReq('GET', `http://localhost:${p}/health`, undefined, 1500);

              if (r.ok) { nexusPort = p; try { localStorage.setItem(NEXUS_PORT_KEY, String(p)); } catch {} return p; }

            } catch {}

          }

          return 0;

        })();

      }

      const p = await nexusPortPromise;

      if (!p) nexusPortPromise = null;

      return p;

    }



    function nexusFmtDuration(sec) {

      sec = Math.round(Number(sec) || 0);

      if (!sec) return '';

      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;

      return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;

    }



    function nexusQualityLabel(m) {

      if (!m) return '';

      if (m.height) return `${m.height}p`;

      return m.quality || '';

    }



    // Super-fast meta: small chunks, 4 parallel workers, results streamed via onUpdate.

    async function nexusFetchMeta(files, onUpdate) {

      const port = await nexusDetectPort();

      if (!port) throw new Error('Nexus dashboard nebeží (porty 8000–8003)');

      const urls = files.filter((f) => f.isVideo && !nexusMetaCache.has(f.href)).map((f) => f.href);

      const chunks = [];

      for (let i = 0; i < urls.length; i += 25) chunks.push(urls.slice(i, i + 25));

      let idx = 0;

      const worker = async () => {

        while (idx < chunks.length) {

          const chunk = chunks[idx++];

          try {

            const r = await nexusReq('POST', `http://localhost:${port}/api/tester/batch-meta`,

              JSON.stringify({ urls: chunk, metadata_only: true }), 90000);

            if (r.ok && Array.isArray(r.json.results)) {

              for (const x of r.json.results) {

                if (!x || !x.url) continue;

                const dur = Number(x.duration || 0);

                if (dur > 0 || x.quality || x.height) {

                  nexusMetaCache.set(x.url, {

                    duration: dur, quality: x.quality || '',

                    height: Number(x.height || 0), width: Number(x.width || 0),

                    sizeBytes: Number(x.size_bytes || 0),

                  });

                }

              }

            }

          } catch (e) { console.warn('[Nexus meta]', e); }

          if (onUpdate) onUpdate();

        }

      };

      await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, worker));

    }



    async function nexusImportFiles(files, label) {

      const vids = files.filter((f) => f.isVideo);

      if (!vids.length) { nexusToast(_t('Žiadne videá na import.', 'No videos to import.'), true); return; }

      const port = await nexusDetectPort();

      if (!port) { nexusToast('Nexus dashboard nebeží (porty 8000–8003).', true); return; }

      const candidates = vids.map((f) => {

        const m = nexusMetaCache.get(f.href) || {};

        const sb = m.sizeBytes || parseSizeToBytes(f.size || '') || 0;

        return {

          url: f.href, source_url: f.href, title: f.title || 'Bunkr video',

          thumbnail: f.thumbSrc || '', duration: m.duration || 0,

          height: m.height || 0, width: m.width || 0,

          file_size_mb: sb ? Number((sb / 1048576).toFixed(2)) : 0,

          source: 'bunkr', tags: ['bunkr', 'balbums'],

        };

      });

      nexusToast(`Importujem ${candidates.length} video(í)…`);

      try {

        const r = await nexusReq('POST', `http://localhost:${port}/api/v1/intake/import`,

          JSON.stringify({ batch_name: `Balbums · ${label}`.slice(0, 120), candidates }), 30000);

        if (!r.ok) throw new Error(r.json.detail || `Server ${r.status}`);

        nexusToast(`✅ Import zaradený: ${r.json.job?.total_items ?? candidates.length} video(í), job #${r.json.job?.id ?? '?'}.`);

      } catch (err) {

        nexusToast(_t(`Import zlyhal: ${err.message || err}`, `Import failed: ${err.message || err}`), true);

      }

    }



    async function openQuickPeekModal(albumUrl, albumCard, bae) {

      let modal = document.getElementById('nexus-balbums-peek-modal');

      if (modal) modal.remove();



      modal = document.createElement('div');

      modal.id = 'nexus-balbums-peek-modal';

      let currentLayout = localStorage.getItem(STORAGE_PEEK_LAYOUT_KEY) || '4x3';

      let peekQuery = '';

      let peekSort = 'default';



      const normalized = getNormalizedAlbumUrl(albumUrl);

      let metadata = bae.albumCache.get(normalized);

      const title = metadata?.albumName || getAlbumTitleFromCard(albumCard) || 'Bunkr Album';



      modal.innerHTML = `

        <div class="nexus-peek-backdrop"></div>

        <div class="nexus-peek-dialog">

          <div class="nexus-peek-header">

            <div style="display:flex;align-items:center;gap:10px;min-width:0;">

              <span style="font-size:16px;">📁</span>

              <div style="font-size:14px;font-weight:700;color:#f0f6fc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:550px;">${escapeHtml(title)}</div>

              <span style="font-size:12px;color:#8b949e;" id="nexus-peek-stats"></span>

              <span style="font-size:11px;color:#58a6ff;" id="nexus-peek-meta-status"></span>

            </div>

            <button type="button" class="nexus-min-btn" style="font-size:20px;padding:2px 8px;" id="nexus-peek-close">✕</button>

          </div>

          <div class="nexus-peek-controls">

            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">

              <input type="checkbox" id="nexus-peek-select-all" style="cursor:pointer;accent-color:#58a6ff;">

              <label for="nexus-peek-select-all" style="font-size:12px;cursor:pointer;color:#c9d1d9;">Označiť všetky</label>

              <input type="search" id="nexus-peek-search" placeholder="🔍 Filtrovať..." style="background:#161b22;border:1px solid rgba(255,255,255,0.15);border-radius:4px;color:#f0f6fc;font-size:11px;padding:4px 8px;outline:none;width:130px;">

              <select id="nexus-peek-sort" class="nexus-select" style="width:auto;">

                <option value="default">Pôvodné</option>

                <option value="duration">⏱️ Najdlhšie</option>

                <option value="quality">💎 Najvyššie rozlíšenie</option>

                <option value="size">📦 Najväčšie</option>

              </select>

              <button type="button" class="nexus-btn-sub" id="nexus-peek-meta" style="flex:0 0 auto;padding:5px 9px;">⏱️ Dĺžka + kvalita</button>

            </div>

            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">

              <div class="nexus-peek-layout-btns">

                <button type="button" class="nexus-peek-layout-btn ${currentLayout === '3x2' ? 'is-active' : ''}" data-layout="3x2">3x2</button>

                <button type="button" class="nexus-peek-layout-btn ${currentLayout === '4x3' ? 'is-active' : ''}" data-layout="4x3">4x3</button>

                <button type="button" class="nexus-peek-layout-btn ${currentLayout === '2x2' ? 'is-active' : ''}" data-layout="2x2">2x2</button>

                <button type="button" class="nexus-peek-layout-btn ${currentLayout === 'list' ? 'is-active' : ''}" data-layout="list">Zoznam</button>

              </div>

              <button type="button" class="nexus-btn-main" id="nexus-peek-import-sel">⚡ Import vybrané</button>

              <button type="button" class="nexus-btn-main" id="nexus-peek-import-all">⚡ Import všetky</button>

              <button type="button" class="nexus-btn-sub" id="nexus-peek-split" style="flex:0 0 auto;background:#8957e5;color:#fff;">📺 Split</button>

              <button type="button" class="nexus-btn-tester" id="nexus-peek-tester">🚀 Tester</button>

            </div>

          </div>

          <div class="nexus-peek-grid" data-layout="${currentLayout}">

            <div style="padding:40px;text-align:center;color:#8b949e;font-size:14px;">⏳ Načítavam položky z Bunkru...</div>

          </div>

        </div>

      `;

      document.body.appendChild(modal);



      const gridEl = modal.querySelector('.nexus-peek-grid');

      const statsEl = modal.querySelector('#nexus-peek-stats');

      const metaStatusEl = modal.querySelector('#nexus-peek-meta-status');

      const searchInput = modal.querySelector('#nexus-peek-search');

      const selectAll = modal.querySelector('#nexus-peek-select-all');



      const onEsc = (e) => { if (e.key === 'Escape') closeModal(); };

      const closeModal = () => { modal.remove(); document.removeEventListener('keydown', onEsc); };

      modal.querySelector('#nexus-peek-close').addEventListener('click', closeModal);

      modal.querySelector('.nexus-peek-backdrop').addEventListener('click', closeModal);

      document.addEventListener('keydown', onEsc);



      if (!metadata || !metadata.files || !metadata.files.length) {

        try {

          metadata = await bae.fetchAlbumData(albumUrl, albumCard, { requireFiles: true, indexOnly: false });

        } catch (err) {

          gridEl.innerHTML = `<div style="padding:40px;text-align:center;color:#f85149;font-size:14px;">Chyba načítania položiek: ${escapeHtml(err.message || String(err))}</div>`;

          return;

        }

      }



      const files = (metadata?.files || []).map(f => ({ ...f, selected: false }));

      const videoFiles = files.filter(f => f.isVideo);

      const photoFiles = files.filter(f => !f.isVideo);



      if (statsEl) {

        if (videoFiles.length === 0 && photoFiles.length > 0) {

          statsEl.innerHTML = `<span style="color:#f0883e;font-weight:700;">📷 ${photoFiles.length} fotiek (0 videí)</span>`;

        } else if (photoFiles.length > 0) {

          statsEl.textContent = `(${videoFiles.length} videí · ${photoFiles.length} fotiek · ${formatBytes(metadata.totalBytes || 0)})`;

        } else {

          statsEl.textContent = `(${videoFiles.length} videí · ${formatBytes(metadata.totalBytes || 0)})`;

        }

      }



      const metaOf = (f) => nexusMetaCache.get(f.href) || null;

      const sizeOf = (f) => (metaOf(f)?.sizeBytes) || parseSizeToBytes(f.size || '') || 0;



      function sortedFiltered() {

        const q = peekQuery.toLowerCase();

        let arr = q ? files.filter(f => (f.title || '').toLowerCase().includes(q)) : files.slice();

        if (peekSort === 'duration') arr.sort((a, b) => (metaOf(b)?.duration || 0) - (metaOf(a)?.duration || 0));

        else if (peekSort === 'quality') arr.sort((a, b) => (metaOf(b)?.height || 0) - (metaOf(a)?.height || 0));

        else if (peekSort === 'size') arr.sort((a, b) => sizeOf(b) - sizeOf(a));

        return arr;

      }



      function badges(f) {

        const m = metaOf(f);

        const dur = m && m.duration ? nexusFmtDuration(m.duration) : '';

        const q = nexusQualityLabel(m);

        return { dur, q };

      }



      function renderGrid() {

        gridEl.dataset.layout = currentLayout;

        const filtered = sortedFiltered();



        if (!filtered.length) {

          gridEl.innerHTML = '<div style="padding:40px;text-align:center;color:#8b949e;font-size:14px;">Žiadne zodpovedajúce položky v tomto albume.</div>';

          return;

        }



        if (currentLayout === 'list') {

          gridEl.innerHTML = filtered.map(f => {

            const b = badges(f);

            return `

            <div class="nexus-peek-card" style="min-height:0;flex-direction:row;align-items:center;padding:8px 12px;gap:12px;">

              <input type="checkbox" class="nexus-peek-chk" ${f.selected ? 'checked' : ''} data-href="${escapeHtml(f.href)}">

              <div class="nexus-peek-poster" style="width:90px;height:52px;flex-shrink:0;" ${f.isVideo ? `data-play="${escapeHtml(f.href)}"` : ''}>

                <img src="${escapeHtml(f.thumbSrc || f.thumb || '')}" alt="" onerror="this.style.display='none'">

                ${f.isVideo ? '<span class="nexus-peek-play-btn" style="width:26px;height:26px;font-size:12px;">▶</span>' : '<span style="position:absolute;bottom:2px;right:2px;background:rgba(240,136,62,0.85);color:#000;font-size:9px;font-weight:800;padding:1px 3px;border-radius:3px;">FOTO</span>'}

              </div>

              <div style="flex:1;min-width:0;">

                <div class="nexus-peek-card-title">${escapeHtml(f.title || (f.isVideo ? 'Video' : 'Fotka'))}</div>

                <div style="font-size:11px;color:#8b949e;margin-top:2px;">${f.isVideo ? '🎬' : '📷'} ${b.dur ? `⏱️ ${b.dur} · ` : ''}${b.q ? `💎 ${escapeHtml(b.q)} · ` : ''}📦 ${escapeHtml(f.size || 'Neznáma veľkosť')}</div>

              </div>

              ${f.isVideo ? `<button type="button" class="nexus-btn-sub" style="flex:0 0 auto;" data-play="${escapeHtml(f.href)}">▶ Prehrať</button><button type="button" class="nexus-btn-main" style="flex:0 0 auto;" data-import="${escapeHtml(f.href)}">⚡ Import</button>` : `<a href="${escapeHtml(f.href)}" target="_blank" class="nexus-btn-sub" style="flex:0 0 auto;text-decoration:none;">🔍 Zobraziť</a>`}

              <a href="${escapeHtml(f.href)}" target="_blank" class="nexus-peek-btn-open">↗</a>

            </div>`;

          }).join('');

        } else {

          gridEl.innerHTML = filtered.map(f => {

            const b = badges(f);

            return `

            <div class="nexus-peek-card">

              <div class="nexus-peek-poster" ${f.isVideo ? `data-play="${escapeHtml(f.href)}"` : ''}>

                <input type="checkbox" class="nexus-peek-chk" style="position:absolute;top:8px;left:8px;z-index:10;" ${f.selected ? 'checked' : ''} data-href="${escapeHtml(f.href)}">

                <img src="${escapeHtml(f.thumbSrc || f.thumb || '')}" alt="" loading="lazy">

                ${f.isVideo ? '<div class="nexus-peek-play-btn">▶</div>' : ''}

                <div style="position:absolute;top:8px;right:8px;background:${f.isVideo ? 'rgba(31,111,235,0.9)' : 'rgba(240,136,62,0.9)'};padding:2px 5px;border-radius:4px;font-size:10px;color:#fff;font-weight:700;">

                  ${f.isVideo ? (b.q ? `💎 ${escapeHtml(b.q)}` : '🎬 VIDEO') : '📷 FOTO'}

                </div>

                ${b.dur ? `<div style="position:absolute;bottom:6px;left:6px;background:rgba(0,0,0,0.75);padding:2px 5px;border-radius:4px;font-size:10px;color:#fff;font-weight:700;">⏱️ ${b.dur}</div>` : ''}

                <div style="position:absolute;bottom:6px;right:6px;background:rgba(0,0,0,0.7);padding:2px 5px;border-radius:4px;font-size:10px;color:#fff;font-weight:600;">

                  📦 ${escapeHtml(f.size || '')}

                </div>

              </div>

              <div class="nexus-peek-card-body">

                <div class="nexus-peek-card-title" title="${escapeHtml(f.title || '')}">${escapeHtml(f.title || (f.isVideo ? 'Video' : 'Fotka'))}</div>

                <div class="nexus-peek-card-actions">

                  ${f.isVideo ? `<button type="button" class="nexus-btn-sub" data-play="${escapeHtml(f.href)}" style="flex:1;">▶ Prehrať</button><button type="button" class="nexus-peek-btn-import" data-import="${escapeHtml(f.href)}" title="Importovať toto video">⚡</button>` : `<a href="${escapeHtml(f.href)}" target="_blank" class="nexus-btn-sub" style="flex:1;text-align:center;text-decoration:none;">🔍 Zobraziť</a>`}

                  <a href="${escapeHtml(f.href)}" target="_blank" class="nexus-peek-btn-open">↗</a>

                </div>

              </div>

            </div>`;

          }).join('');

        }

      }



      renderGrid();



      let renderTimer = null;

      const scheduleRender = () => {

        if (renderTimer) return;

        renderTimer = setTimeout(() => {

          renderTimer = null;

          const keep = gridEl.scrollTop;

          renderGrid();

          gridEl.scrollTop = keep;

          const done = videoFiles.filter(f => nexusMetaCache.has(f.href)).length;

          if (metaStatusEl) metaStatusEl.textContent = `⏱️ ${done}/${videoFiles.length}`;

        }, 200);

      };



      const metaBtn = modal.querySelector('#nexus-peek-meta');

      async function runMeta() {

        if (!videoFiles.length) return;

        metaBtn.disabled = true;

        if (metaStatusEl) metaStatusEl.textContent = '⏱️ načítavam…';

        try {

          await nexusFetchMeta(videoFiles, scheduleRender);

        } catch (err) {

          if (metaStatusEl) metaStatusEl.textContent = `⚠️ ${err.message || err}`;

        } finally {

          metaBtn.disabled = false;

          scheduleRender();

        }

      }

      metaBtn.addEventListener('click', runMeta);

      runMeta();



      modal.querySelectorAll('.nexus-peek-layout-btn').forEach(btn => {

        btn.addEventListener('click', () => {

          currentLayout = btn.dataset.layout;

          localStorage.setItem(STORAGE_PEEK_LAYOUT_KEY, currentLayout);

          modal.querySelectorAll('.nexus-peek-layout-btn').forEach(b => b.classList.remove('is-active'));

          btn.classList.add('is-active');

          renderGrid();

        });

      });



      modal.querySelector('#nexus-peek-sort').addEventListener('change', (e) => { peekSort = e.target.value; renderGrid(); });

      searchInput.addEventListener('input', (e) => { peekQuery = e.target.value; renderGrid(); });

      selectAll.addEventListener('change', () => {

        const c = selectAll.checked;

        files.forEach(f => f.selected = c);

        renderGrid();

      });



      gridEl.addEventListener('click', (e) => {

        const imp = e.target.closest('[data-import]');

        if (imp) {

          const f = files.find(x => x.href === imp.dataset.import);

          if (f) {

            imp.disabled = true;

            nexusImportFiles([f], title).finally(() => { imp.disabled = false; });

          }

          return;

        }

        const chk = e.target.closest('.nexus-peek-chk');

        if (chk) {

          const f = files.find(x => x.href === chk.dataset.href);

          if (f) f.selected = chk.checked;

          return;

        }

        const playBtn = e.target.closest('[data-play]');

        if (playBtn) {

          const href = playBtn.dataset.play;

          const f = files.find(x => x.href === href);

          if (typeof bae.openPlayerModal === 'function') {

            bae.openPlayerModal(href, f?.title || title);

          } else {

            openCinemaPlayer(href, f?.title || title);

          }

          return;

        }

      });



      modal.querySelector('#nexus-peek-import-sel').addEventListener('click', () => {

        const sel = files.filter(f => f.selected && f.isVideo);

        if (!sel.length) { nexusToast('Najprv označ aspoň 1 video.', true); return; }

        nexusImportFiles(sel, title);

      });

      modal.querySelector('#nexus-peek-import-all').addEventListener('click', () => {

        nexusImportFiles(videoFiles, title);

      });



      modal.querySelector('#nexus-peek-split').addEventListener('click', () => {

        const sel = files.filter(f => f.selected && f.isVideo);

        const tg = sel.length ? sel : videoFiles.slice(0, 4);

        const urls = tg.map(f => f.href);

        const titles = tg.map(f => f.title);

        window.dispatchEvent(new CustomEvent('nexus-turbo-split-open', { detail: { urls, titles } }));

      });



      modal.querySelector('#nexus-peek-tester').addEventListener('click', () => {

        const sel = files.filter(f => f.selected && f.isVideo);

        const tg = sel.length ? sel : videoFiles;

        sendVideosToTester(tg, title, albumUrl);

      });

    }



    

function initNexusBalbumsHUD(bae) {

      if (!window.location.hostname.includes('balbums.st') && !window.location.hostname.includes('bunkr-albums.io')) {

        return;

      }

      injectNexusStyles();



      let tb = document.getElementById(TOOLBAR_ID);

      if (!tb) {

        tb = document.createElement('div');

        tb.id = TOOLBAR_ID;

        tb.innerHTML = `

          <div class="nexus-header" id="nexus-drag-handle">

            <div class="nexus-brand">⚡ NEXUS VAULT</div>

            <div class="nexus-title">Balbums Suite</div>

            <button class="nexus-min-btn" id="nexus-btn-minimize" title="Minimalizovať">—</button>

          </div>

          <div class="nexus-info">

            <span id="nexus-stats-count"><b>0</b> vybratých</span>

            <span style="font-size:11px;color:#58a6ff;">balbums.st</span>

          </div>

          <div class="nexus-filter-box">

            <div class="nexus-filter-grid">

              <div class="nexus-filter-field">

                <label class="nexus-filter-label" for="nexus-sort">🔃 Zoradenie</label>

                <select class="nexus-select" id="nexus-sort">

                  <option value="default">Pôvodné poradie</option>

                  <option value="size">📦 Najväčšia veľkosť (GB)</option>

                  <option value="count">🎬 Najviac videí</option>

                  <option value="newest">🕒 Najnovšie</option>

                  <option value="name">🔤 Názov (A–Z)</option>

                </select>

              </div>

              <div class="nexus-filter-field">

                <label class="nexus-filter-label" for="nexus-vids">🎬 Min. videí</label>

                <select class="nexus-select" id="nexus-vids">

                  <option value="0">Videá: Všetky</option>

                  <option value="2">Videá: ≥ 2</option>

                  <option value="5">Videá: ≥ 5</option>

                  <option value="10">Videá: ≥ 10</option>

                  <option value="20">Videá: ≥ 20</option>

                </select>

              </div>

            </div>

            <div class="nexus-toggles">

              <button type="button" class="nexus-toggle-btn is-active-orange" id="nexus-toggle-hide-photos">📷 Skryť foto</button>

              <button type="button" class="nexus-toggle-btn" id="nexus-toggle-selected">👁️ Iba vybraté</button>

            </div>

          </div>

          <div style="display:flex;flex-direction:column;gap:5px;">

            <div class="nexus-btn-group">

              <button type="button" class="nexus-btn-sub" id="nexus-top-20">TOP 20</button>

              <button type="button" class="nexus-btn-sub" id="nexus-select-all">Vybrať všetky</button>

              <button type="button" class="nexus-btn-sub" id="nexus-select-none">Zrušiť</button>

            </div>

            <div class="nexus-btn-group">

              <button type="button" class="nexus-btn-sub" id="nexus-scan-btn" style="flex:2;background:#1f6feb;color:#fff;font-weight:700;">🔍 Skenovať albumy</button>

              <button type="button" class="nexus-btn-sub" id="nexus-load-next" style="flex:2;">➕ Ďalšia strana</button>

              <button type="button" class="nexus-btn-sub" id="nexus-load-5" style="flex:1;">⏩ +5</button>

            </div>

            <div class="nexus-btn-group" style="margin-top:2px;">

              <button type="button" class="nexus-btn-tester" id="nexus-btn-tester" style="flex:1;">🚀 Do Testera</button>

            </div>

          </div>

        `;

        document.body.appendChild(tb);



        try {

          const raw = localStorage.getItem(STORAGE_POS_KEY);

          if (raw) {

            const p = JSON.parse(raw);

            if (p.x && p.y) { tb.style.left = p.x + 'px'; tb.style.top = p.y + 'px'; tb.style.right = 'auto'; tb.style.bottom = 'auto'; }

          } else {

            tb.style.right = '20px'; tb.style.bottom = '20px';

          }

        } catch {}



        makeDraggableElement(tb, tb.querySelector('#nexus-drag-handle'));



        let bubble = document.getElementById(BUBBLE_ID);

        if (!bubble) {

          bubble = document.createElement('div');

          bubble.id = BUBBLE_ID;

          bubble.innerHTML = '⚡';

          bubble.title = 'Otvoriť Nexus Vault Panel';

          document.body.appendChild(bubble);

          bubble.addEventListener('click', () => {

            tb.classList.remove('nexus-balbums-minimized');

            bubble.classList.remove('is-visible');

          });

        }



        tb.querySelector('#nexus-btn-minimize').addEventListener('click', () => {

          tb.classList.add('nexus-balbums-minimized');

          bubble.classList.add('is-visible');

        });



        tb.querySelector('#nexus-top-20').addEventListener('click', () => {

          const cards = getAlbumCards(document);

          cards.slice(0, 20).forEach(card => {

            const url = getAlbumUrlFromCard(card);

            if (url) {

              bae.selectedAlbumUrls.add(getNormalizedAlbumUrl(url));

              const cb = card.querySelector('.bae-select-album-checkbox');

              if (cb) cb.checked = true;

            }

          });

          bae.updateSelectionBar();

          updateHudStats();

        });



        tb.querySelector('#nexus-select-all').addEventListener('click', () => {

          const cards = getAlbumCards(document);

          cards.forEach(card => {

            const url = getAlbumUrlFromCard(card);

            if (url) {

              bae.selectedAlbumUrls.add(getNormalizedAlbumUrl(url));

              const cb = card.querySelector('.bae-select-album-checkbox');

              if (cb) cb.checked = true;

            }

          });

          bae.updateSelectionBar();

          updateHudStats();

        });



        tb.querySelector('#nexus-select-none').addEventListener('click', () => {

          bae.clearAlbumSelection();

          const cards = getAlbumCards(document);

          cards.forEach(card => {

            const cb = card.querySelector('.bae-select-album-checkbox');

            if (cb) cb.checked = false;

          });

          bae.updateSelectionBar();

          updateHudStats();

        });



        tb.querySelector('#nexus-btn-tester').addEventListener('click', async () => {

          const selected = Array.from(bae.selectedAlbumUrls || []);

          if (!selected.length) {

            alert('Najprv označte aspoň 1 album.');

            return;

          }

          tb.querySelector('#nexus-btn-tester').textContent = '⏳ Zhromažďujem...';

          const allFiles = [];

          for (const url of selected) {

            let meta = bae.albumCache.get(url);

            if (!meta || !meta.files || !meta.files.length) {

              meta = await bae.fetchAlbumData(url, null, { requireFiles: true }).catch(() => null);

            }

            if (meta?.files) {

              allFiles.push(...meta.files.map(f => ({ ...f, albumTitle: meta.albumName || url, albumUrl: url })));

            }

          }

          tb.querySelector('#nexus-btn-tester').textContent = '🚀 Do Testera';

          if (!allFiles.length) {

            alert(_t('V označených albumoch sa nenašli žiadne videá.', 'No videos found in selected albums.'));

            return;

          }

          sendVideosToTester(allFiles, `${selected.length} Bunkr albumov`, location.href);

        });



        tb.querySelector('#nexus-scan-btn').addEventListener('click', () => {

          tb.querySelector('#nexus-scan-btn').textContent = '⏳ Skenujem...';

          bae.fetchVisibleAlbums(100).finally(() => {

            tb.querySelector('#nexus-scan-btn').textContent = '🔍 Skenovať albumy';

            updateHudStats();

          });

        });



        tb.querySelector('#nexus-sort').addEventListener('change', (e) => {

          sortAlbums(e.target.value);

        });



        tb.querySelector('#nexus-load-next').addEventListener('click', async () => {

          const btn = tb.querySelector('#nexus-load-next');

          btn.textContent = '⏳ Načítavam...';

          const n = await bae.loadNextPage();

          btn.textContent = '➕ Ďalšia strana';

          if (n > 0) nexusToast(`Pridaných ${n} albumov.`);

          else nexusToast(bae.lastLoadError ? `Chyba: ${bae.lastLoadError.message}` : 'Žiadne ďalšie albumy.', true);

          updateHudStats();

        });



        tb.querySelector('#nexus-load-5').addEventListener('click', async () => {

          const btn = tb.querySelector('#nexus-load-5');

          let total = 0;

          for (let i = 0; i < 5; i++) {

            btn.textContent = `⏳ ${i + 1}/5`;

            const n = await bae.loadNextPage();

            if (n <= 0) break;

            total += n;

            await new Promise(r => setTimeout(r, 400));

          }

          btn.textContent = '⏩ +5';

          nexusToast(total > 0 ? `Pridaných ${total} albumov.` : 'Žiadne ďalšie albumy.', total <= 0);

          updateHudStats();

        });



        const hidePhotosBtn = tb.querySelector('#nexus-toggle-hide-photos');

        hidePhotosBtn.addEventListener('click', () => {

          hidePhotosActive = !hidePhotosActive;

          hidePhotosBtn.classList.toggle('is-active-orange', hidePhotosActive);

          applyPhotoFilter();

        });



        window.addEventListener('bae-status', updateHudStats);

      }



      function applyPhotoFilter() {

        const cards = getAlbumCards(document);

        cards.forEach(card => {

          if (!card) return;

          const isPhoto = card.dataset?.isPhotoOnly === '1' || (card.classList && card.classList.contains('bae-photo-album'));

          if (isPhoto && card.classList) {

            card.classList.toggle('nexus-hidden-photo', hidePhotosActive);

          }

        });

      }



      function updateHudStats() {

        const count = bae.selectedAlbumUrls ? bae.selectedAlbumUrls.size : 0;

        const total = getAlbumCards(document).length;

        const statsEl = tb.querySelector('#nexus-stats-count');

        if (statsEl) statsEl.innerHTML = `<b>${count}</b> vybratých · <b>${total}</b> albumov`;

      }



      function attachPeekButtons() {

        const cards = getAlbumCards(document);

        cards.forEach(card => {

          if (card.querySelector('.nexus-balbums-peek-btn')) return;

          const albumUrl = getAlbumUrlFromCard(card);

          if (!albumUrl) return;



          card.style.position = 'relative';



          const btn = document.createElement('div');

          btn.className = 'nexus-balbums-peek-btn';

          btn.innerHTML = '👁️';

          btn.title = 'Rýchly náhľad videí v albume (Quick Peek)';



          btn.addEventListener('click', (e) => {

            e.preventDefault();

            e.stopPropagation();

            openQuickPeekModal(albumUrl, card, bae).catch((err) => { console.error('[Nexus QuickPeek]', err); alert('Quick Peek chyba: ' + (err && err.message || err)); });

          });



          card.appendChild(btn);

        });



        if (hidePhotosActive) applyPhotoFilter();

      }



      attachPeekButtons();

      setInterval(attachPeekButtons, 1200);

    }



    const bae = new BunkrAlbumsEnhanced();

    window.baeInstance = bae;

    window.__initNexusBalbums = initNexusBalbumsHUD;

    if (window.location.hostname.includes('balbums.st') || window.location.hostname.includes('bunkr-albums.io')) {

      initNexusBalbumsHUD(bae);

    }

  })();

  }

}
