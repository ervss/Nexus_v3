// ==UserScript==
// @name         MEGA Folder Browser Helper
// @namespace    local.codex.mega.folder.helper
// @version      0.11.0
// @description  MEGA folder filters, selective import and sending folders to the Nexus MEGA Hub.
// @match        https://mega.nz/folder/*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

// NOTE: MEGA's page sets a strict CSP (connect-src) that blocks a plain page
// fetch() to http://localhost. We route every dashboard call through
// GM_xmlhttpRequest (privileged, runs outside the page context, bypasses CSP
// and CORS). The @connect lines whitelist the local dashboard host.

(function () {
  'use strict';

  const STORAGE_KEY = 'mega-folder-helper:prefs:v3';
  const AUTO_OPEN_KEY = 'mega-folder-helper:auto-opened';
  const PANEL_ID = 'mega-folder-helper-panel';
  const STYLE_ID = 'mega-folder-helper-style';
  const GRID_STATE_CLASS = 'mega-folder-helper-grid';
  const DEFAULT_PORT = 8001;
  // Ports the dashboard commonly runs on, probed in order for auto-connect.
  const CANDIDATE_PORTS = [8000, 8001, 8002, 8080, 5173, 3000];

  // Connection status: 'unknown' | 'searching' | 'online' | 'offline'
  let connStatus = 'unknown';
  let detecting = null;
  let portCheckTimer = 0;

  const QUALITY_OPTIONS = ['sd', '480', '720', '1080', '1440', '2160', 'unknown'];
  let currentFolderUrl = folderUrlKey();
  const state = loadPrefs();
  let rootNode = null;
  let activeItems = [];
  let observer = null;
  let refreshTimer = 0;
  let uiReady = false;
  let isApplying = false;
  let nextOriginalIndex = 1;
  let periodicTimer = 0;
  let currentResults = [];
  let sortedDirectory = '';
  let customQualityOrder = false;
  const qualityCache = new Map();
  const qualityPending = new Set();
  const qualityAttempts = new Map();
  let qualityWorkers = 0;

  function megaPage() {
    return typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  }

  // Use MEGA's own sort so virtualized/offscreen cards follow the same order.
  function syncNativeSort() {
    try {
      const model = megaPage().M;
      if (!model?.currentdirid || !Array.isArray(model.v) || !model.v.length
          || typeof model.doSort !== 'function' || typeof model.renderMain !== 'function') return;
      const directory = `${location.pathname}${location.hash}|${model.currentdirid}`;
      if (directory !== sortedDirectory) {
        sortedDirectory = directory;
        syncPanel();
      }
      if (state.sort === 'qualityAsc' || state.sort === 'qualityDesc') {
        customQualityOrder = true;
        const before = model.v.map(node => node.h).join(',');
        model.v.sort((a, b) => {
          if (a.t !== b.t) return a.t ? -1 : 1;
          const itemA = { megaHandle: a.h }, itemB = { megaHandle: b.h };
          return compareQuality(itemA, itemB, state.sort === 'qualityDesc')
            || String(a.name || '').localeCompare(String(b.name || ''));
        });
        if (before !== model.v.map(node => node.h).join(',')) model.renderMain();
        return;
      }
      const nativeSort = {
        sizeDesc: ['size', -1], sizeAsc: ['size', 1],
        az: ['name', 1], za: ['name', -1]
      }[state.sort];
      if (!nativeSort || (!customQualityOrder && model.sortmode?.n === nativeSort[0] && model.sortmode?.d === nativeSort[1])) return;
      model.doSort(...nativeSort);
      customQualityOrder = false;
      model.renderMain();
    } catch (error) {
      sortedDirectory = '';
      console.warn('[MEGA Helper] Native folder sorting unavailable:', error);
    }
  }

  // Selection: set of stable keys the user has ticked.
  const selectedKeys = new Set();
  let lastClickedKey = null;

  // /mega/preview data keyed by normalized name -> {ref, size, handle, name}
  let previewByName = new Map();
  let previewByHandle = new Map();
  let previewMeta = { title: '', count: 0, fetchedFor: '', loading: false, error: '' };

  const ITEM_SELECTORS = [
    '.megaListItem',
    '.mega-list-item',
    '.data-block-view',
    '.data-block-bg',
    '.fm-item',
    '.file-block',
    '.folder-block',
    '[data-nodeid]',
    '[data-handle]',
    '[data-item-id]',
    'a[href*="/folder/"]',
    'a[href*="/file/"]'
  ].join(',');

  // GM bridge: privileged cross-origin request that bypasses MEGA's CSP.
  const GM_REQ = (typeof GM_xmlhttpRequest !== 'undefined') ? GM_xmlhttpRequest
    : (typeof GM !== 'undefined' && GM.xmlHttpRequest) ? GM.xmlHttpRequest.bind(GM)
    : null;

  // Minimal fetch-like wrapper. Returns {ok, status, json(), text()}.
  function bridgeFetch(url, opts = {}) {
    if (!GM_REQ) {
      // Fallback (will be CSP-blocked on mega.nz, but kept for completeness).
      return fetch(url, opts).then(async (r) => ({
        ok: r.ok, status: r.status,
        json: () => r.json(), text: () => r.text()
      }));
    }
    return new Promise((resolve, reject) => {
      GM_REQ({
        method: opts.method || 'GET',
        url,
        headers: opts.headers || {},
        anonymous: opts.anonymous === true,
        data: opts.body,
        timeout: opts.timeoutMs || 20000,
        onload: (res) => {
          const text = res.responseText || '';
          resolve({
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            text: () => Promise.resolve(text),
            json: () => Promise.resolve((() => { try { return JSON.parse(text); } catch { return {}; } })())
          });
        },
        onerror: () => reject(new TypeError('Failed to fetch')),
        ontimeout: () => reject(new TypeError('Request timed out'))
      });
    });
  }

  const IMAGE_RE = /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp|heic|heif|tif?f)$/i;
  const VIDEO_RE = /\.(mp4|m4v|webm|mov|avi|mkv|wmv|flv|mpe?g|3gp|ogv|ts)$/i;
  const FOLDER_HINT_RE = /folder|directory|album|collection/i;

  injectStyles();
  boot();
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('MEGA Hub: nastaviť Nexus bridge token', () => {
      const token = window.prompt('Nexus bridge token (iba ak je nastavený v Nexuse)');
      if (token !== null) GM_setValue('megaHubToken', token.trim());
    });
  }

  function boot() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', scheduleRefresh, { once: true });
    }
    const start = () => {
      ensurePanel();
      observePage();
      scheduleRefresh();
      detectPort().then(() => maybeFetchPreview());
    };
    if (document.body) start();
    else window.addEventListener('load', start, { once: true });
    window.addEventListener('hashchange', () => { checkFolderUrl(); resetPreview(); maybeFetchPreview(); }, { passive: true });
  }

  function folderUrlKey() {
    // MEGA appends /folder/<handle> when navigating inside a shared folder.
    return `${location.origin}${location.pathname}${location.hash.split('/')[0]}`;
  }

  function checkFolderUrl() {
    const url = folderUrlKey();
    if (url === currentFolderUrl) return;
    currentFolderUrl = url;
    const port = state.port;
    Object.assign(state, defaultState(), { port });
    selectedKeys.clear();
    lastClickedKey = null;
    clearAllLocalHiding();
    savePrefs();
    syncPanel();
  }

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      if (parsed.folderUrl !== currentFolderUrl) {
        return Object.assign(defaultState(), { port: Number(parsed.port) || DEFAULT_PORT });
      }
      return Object.assign(defaultState(), {
        q: typeof parsed.q === 'string' ? parsed.q : '',
        sort: ['none', 'az', 'za', 'sizeAsc', 'sizeDesc', 'durAsc', 'durDesc', 'qualityAsc', 'qualityDesc'].includes(parsed.sort) ? parsed.sort : 'sizeDesc',
        qualities: Array.isArray(parsed.qualities) ? [...new Set(parsed.qualities.filter(q => QUALITY_OPTIONS.includes(q)))] : [],
        foldersFirst: Boolean(parsed.foldersFirst),
        media: ['all', 'videos', 'images'].includes(parsed.media) ? parsed.media : 'all',
        onlyMatches: Boolean(parsed.onlyMatches),
        markDupes: parsed.markDupes !== false,
        durationMin: str(parsed.durationMin),
        durationMax: str(parsed.durationMax),
        sizeMin: str(parsed.sizeMin),
        sizeMax: str(parsed.sizeMax),
        port: Number(parsed.port) || DEFAULT_PORT
      });
    } catch {
      return defaultState();
    }
  }

  function str(v) { return typeof v === 'string' ? v : ''; }

  function defaultState() {
    return {
      q: '', sort: 'sizeDesc', foldersFirst: false, media: 'videos',
      qualities: [],
      onlyMatches: true, markDupes: true,
      durationMin: '60s', durationMax: '', sizeMin: '', sizeMax: '',
      port: DEFAULT_PORT
    };
  }

  function savePrefs() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, folderUrl: currentFolderUrl })); } catch {}
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed; top: 14px; right: 14px; z-index: 2147483647;
        width: 332px; max-height: calc(100vh - 28px); overflow: auto;
        padding: 12px; border-radius: 16px;
        background: rgba(12, 16, 24, 0.94); color: #eef2ff;
        border: 1px solid rgba(255,255,255,0.12);
        box-shadow: 0 18px 48px rgba(0,0,0,0.45);
        font: 12px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        backdrop-filter: blur(12px);
      }
      #${PANEL_ID}.is-collapsed { width: auto; padding: 8px 12px; }
      #${PANEL_ID}.is-collapsed .mfh-body { display: none; }
      #${PANEL_ID} * { box-sizing: border-box; }
      #${PANEL_ID} .mfh-row { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
      #${PANEL_ID} .mfh-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 6px; }
      #${PANEL_ID} input {
        width: 100%; border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
        background: rgba(255,255,255,0.05); color: inherit; padding: 8px 10px; outline: none;
      }
      #${PANEL_ID} input::placeholder { color: rgba(238,242,255,0.45); }
      #${PANEL_ID} button {
        border: 1px solid rgba(255,255,255,0.10); border-radius: 10px;
        background: rgba(255,255,255,0.06); color: inherit;
        padding: 7px 9px; cursor: pointer; font-size: 11px; line-height: 1;
        transition: background .12s, border-color .12s;
      }
      #${PANEL_ID} button:hover { background: rgba(255,255,255,0.12); }
      #${PANEL_ID} button.is-on { background: #66d9ef; color: #08111a; border-color: #66d9ef; font-weight: 700; }
      #${PANEL_ID} button.mfh-primary { background: #36d399; color: #062018; border-color: #36d399; font-weight: 700; }
      #${PANEL_ID} button.mfh-primary:hover { background: #2bbf88; }
      #${PANEL_ID} button.mfh-primary[disabled] { opacity: .45; cursor: default; }
      #${PANEL_ID} button.mfh-danger { background: rgba(255,90,90,0.16); border-color: rgba(255,90,90,0.4); }
      #${PANEL_ID} .mfh-title { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-weight: 700; margin-bottom: 8px; }
      #${PANEL_ID} .mfh-title .mfh-min { padding: 3px 8px; }
      #${PANEL_ID} .mfh-brand { display: flex; align-items: center; gap: 8px; }
      #${PANEL_ID} .mfh-led {
        width: 10px; height: 10px; border-radius: 50%;
        background: #888; box-shadow: 0 0 8px #888; flex: 0 0 auto; transition: background .2s, box-shadow .2s;
      }
      #${PANEL_ID} .mfh-led.mfh-led-pulse { animation: mfhPulse 1s ease-in-out infinite; }
      @keyframes mfhPulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
      #${PANEL_ID} .mfh-sub { opacity: 0.72; font-size: 11px; margin-top: 6px; }
      #${PANEL_ID} .mfh-label { opacity: 0.78; font-size: 10px; margin-top: 10px; text-transform: uppercase; letter-spacing: 0.06em; }
      #${PANEL_ID} .mfh-stat { margin-top: 8px; font-size: 11px; opacity: 0.9; }
      #${PANEL_ID} .mfh-summary {
        margin-top: 8px; padding: 8px 10px; border-radius: 10px;
        background: rgba(102,217,239,0.10); border: 1px solid rgba(102,217,239,0.22);
        display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px; text-align: center;
      }
      #${PANEL_ID} .mfh-summary b { display: block; font-size: 14px; }
      #${PANEL_ID} .mfh-summary span { opacity: .7; font-size: 9px; text-transform: uppercase; letter-spacing: .05em; }
      #${PANEL_ID} .mfh-selbar {
        margin-top: 8px; padding: 8px 10px; border-radius: 10px;
        background: rgba(54,211,153,0.12); border: 1px solid rgba(54,211,153,0.28);
      }
      #${PANEL_ID} .mfh-selbar .mfh-selcount { font-weight: 700; }
      #${PANEL_ID} .mfh-selbar .mfh-row { margin-top: 8px; }
      #${PANEL_ID} .mfh-selbar button { flex: 1; }
      #${PANEL_ID} .mfh-preview-state { margin-top: 6px; font-size: 10px; opacity: .65; }
      #${PANEL_ID} .mfh-results { max-height: 168px; overflow: auto; margin-top: 8px; display: grid; gap: 5px; }
      #${PANEL_ID} .mfh-result { width: 100%; display: grid; grid-template-columns: auto 1fr auto; gap: 8px; text-align: left; line-height: 1.25; padding: 7px 8px; align-items: center; }
      #${PANEL_ID} .mfh-result .mfh-tick { width: 14px; height: 14px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.4); flex: 0 0 auto; }
      #${PANEL_ID} .mfh-result.is-sel .mfh-tick { background: #36d399; border-color: #36d399; }
      #${PANEL_ID} .mfh-result-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${PANEL_ID} .mfh-result-meta { opacity: 0.78; white-space: nowrap; font-variant-numeric: tabular-nums; }

      /* ── Grid + cards on the MEGA page ─────────────────────────────────── */
      [data-mfh-card="1"] { position: relative !important; }
      [data-mfh-match="1"] { outline: 2px solid rgba(102, 217, 239, 0.9) !important; outline-offset: 2px !important; }
      [data-mfh-selected="1"] { outline: 3px solid #36d399 !important; outline-offset: 2px !important; box-shadow: 0 0 0 3px rgba(54,211,153,0.25) !important; }
      [data-mfh-dupe="1"]::before {
        content: "DUP"; position: absolute; top: 6px; left: 6px; z-index: 21;
        padding: 2px 6px; border-radius: 7px; background: rgba(255,170,40,0.92); color: #20140a;
        font: 800 9px/1.2 system-ui, sans-serif; letter-spacing: .06em; pointer-events: none;
      }
      .mfh-checkbox {
        position: absolute; top: 6px; right: 6px; z-index: 22;
        width: 22px; height: 22px; border-radius: 7px;
        background: rgba(8,14,22,0.72); border: 1.5px solid rgba(255,255,255,0.55);
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        font: 800 13px/1 system-ui, sans-serif; color: transparent; transition: all .1s;
      }
      .mfh-checkbox:hover { border-color: #36d399; }
      .mfh-date-label {
        position: absolute; top: 6px; left: 6px; z-index: 23;
        padding: 3px 7px; border-radius: 7px;
        background: rgba(5,10,18,0.88); color: #eef2ff;
        border: 1px solid rgba(255,255,255,0.35);
        font: 700 11px/1.2 system-ui, sans-serif;
        font-variant-numeric: tabular-nums; pointer-events: none;
      }
      .mfh-quality-label {
        position: absolute; left: 6px; top: 32px; z-index: 23;
        padding: 3px 7px; border-radius: 7px;
        background: rgba(21,43,77,0.94); color: #9eeaff;
        border: 1px solid rgba(158,234,255,0.5);
        font: 800 11px/1.2 system-ui, sans-serif; pointer-events: none;
      }
      [data-mfh-quality-label][data-mfh-dupe="1"]::before { top: 58px; }
      [data-mfh-date-label][data-mfh-dupe="1"]:not([data-mfh-quality-label])::before { top: 32px; }
      [data-mfh-selected="1"] .mfh-checkbox { background: #36d399; border-color: #36d399; color: #062018; }
      [data-mfh-selected="1"] .mfh-checkbox::after { content: "✓"; }

      [data-mfh-size-label]::after {
        content: attr(data-mfh-size-label);
        position: absolute; left: 8px; bottom: 30px; z-index: 20;
        padding: 3px 8px; border-radius: 8px;
        background: linear-gradient(180deg, rgba(102,217,239,0.95), rgba(56,189,248,0.95));
        color: #04131c; border: 1px solid rgba(255,255,255,0.25);
        box-shadow: 0 4px 14px rgba(0,0,0,0.5);
        font: 800 12px/1.15 system-ui, sans-serif; pointer-events: none; letter-spacing: .01em;
      }
      [data-mfh-dur-label]::before {
        content: attr(data-mfh-dur-label);
        position: absolute; right: 8px; bottom: 30px; z-index: 20;
        padding: 3px 8px; border-radius: 8px;
        background: #050a12; color: #ffe27a; border: 1px solid rgba(255,226,122,0.4);
        box-shadow: 0 4px 14px rgba(0,0,0,0.5);
        font: 800 12px/1.15 system-ui, sans-serif; pointer-events: none;
      }

      [data-mfh-dur-label] .video-thumb-details,
      [data-mfh-dur-label] .video-thumb-duration,
      [data-mfh-dur-label] .video-duration,
      [data-mfh-dur-label] .duration { visibility: hidden !important; }

      /* Bigger cards: aim for ~7 across instead of MEGA's default ~11. */
      .${GRID_STATE_CLASS}.mfh-biggrid .data-block-view,
      .${GRID_STATE_CLASS}.mfh-biggrid .file-block,
      .${GRID_STATE_CLASS}.mfh-biggrid .folder-block,
      .${GRID_STATE_CLASS}.mfh-biggrid .megaListItem.data-block-view {
        width: 13.2% !important;
        min-width: 200px !important;
        height: auto !important;
      }
      .${GRID_STATE_CLASS}.mfh-biggrid .data-block-view .data-block-bg,
      .${GRID_STATE_CLASS}.mfh-biggrid .data-block-view .block-view-file-type {
        width: 100% !important;
        height: 165px !important;
        background-size: cover !important;
      }
      .${GRID_STATE_CLASS} [data-mfh-hidden="1"] { display: none !important; }
    `;
    document.head.appendChild(style);
  }

  function ensurePanel() {
    if (document.getElementById(PANEL_ID)) return;
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="mfh-title">
        <span class="mfh-brand">
          <span class="mfh-led" data-role="conn-led" title="Dashboard connection"></span>
          MEGA Helper
        </span>
        <span>
          <button type="button" class="mfh-min" data-action="reconnect" title="Find &amp; connect to the dashboard">⟳</button>
          <button type="button" class="mfh-min" data-action="toggle-collapse" title="Collapse">–</button>
          <button type="button" data-action="reset" title="Reset filters">reset</button>
        </span>
      </div>
      <div class="mfh-body">
        <input type="search" placeholder="Search files/folders" aria-label="Search">
        <div class="mfh-label">Sort</div>
        <div class="mfh-row">
          <button type="button" data-sort="az">A-Z</button>
          <button type="button" data-sort="za">Z-A</button>
          <button type="button" data-sort="sizeDesc">Size ↓</button>
          <button type="button" data-sort="sizeAsc">Size ↑</button>
          <button type="button" data-sort="durDesc">Dur ↓</button>
          <button type="button" data-sort="durAsc">Dur ↑</button>
          <button type="button" data-sort="qualityDesc">Kvalita ↓</button>
          <button type="button" data-sort="qualityAsc">Kvalita ↑</button>
          <button type="button" data-toggle="foldersFirst">Folders first</button>
        </div>
        <div class="mfh-label">Type / View</div>
        <div class="mfh-row">
          <button type="button" data-media="videos">Videos only</button>
          <button type="button" data-media="images">Images only</button>
          <button type="button" data-toggle="onlyMatches">Hide non-matches</button>
          <button type="button" data-toggle="markDupes">Mark dupes</button>
        </div>
        <div class="mfh-label">Kvalita – vyber aj viac možností</div>
        <div class="mfh-row">
          <button type="button" data-action="quality-all">Všetky</button>
          <button type="button" data-quality="sd" title="Menej ako 480p">SD</button>
          <button type="button" data-quality="480" title="480–719p">480p</button>
          <button type="button" data-quality="720" title="720–1079p">720p</button>
          <button type="button" data-quality="1080" title="1080–1439p">1080p</button>
          <button type="button" data-quality="1440" title="1440–2159p">1440p</button>
          <button type="button" data-quality="2160" title="2160p a viac">4K+</button>
          <button type="button" data-quality="unknown">Neznáma</button>
        </div>
        <div class="mfh-sub">Možnosti sa kombinujú. Rozhoduje kratšia strana videa; žiadny výber = všetky kvality.</div>
        <div class="mfh-label">Duration</div>
        <div class="mfh-grid2">
          <input type="text" data-field="durationMin" placeholder="Min e.g. 12m">
          <input type="text" data-field="durationMax" placeholder="Max e.g. 25m">
        </div>
        <div class="mfh-label">Size (bare number = MB)</div>
        <div class="mfh-grid2">
          <input type="text" data-field="sizeMin" placeholder="Min e.g. 500">
          <input type="text" data-field="sizeMax" placeholder="Max e.g. 1.5GB">
        </div>

        <div class="mfh-summary" data-role="summary">
          <div><b data-sum="count">0</b><span>items</span></div>
          <div><b data-sum="size">–</b><span>total size</span></div>
          <div><b data-sum="dur">–</b><span>total dur</span></div>
        </div>

        <div class="mfh-label">Selection &amp; import</div>
        <div class="mfh-selbar">
          <span class="mfh-selcount" data-role="selcount">0 selected</span>
          <span class="mfh-sub" data-role="selsize"></span>
          <div class="mfh-row">
            <button type="button" data-action="select-filtered">Select filtered</button>
            <button type="button" data-action="clear-selection">Clear</button>
          </div>
          <div class="mfh-row">
            <button type="button" class="mfh-primary" data-action="import-selected" disabled>Import selected →</button>
          </div>
          <div class="mfh-row">
            <button type="button" data-action="import-filtered">Import all filtered →</button>
          </div>
          <div class="mfh-row">
            <button type="button" data-action="send-hub">Poslať do MEGA Hubu</button>
          </div>
          <div class="mfh-row">
            <button type="button" data-action="split-selected">▶ Prehrať vybrané</button>
            <button type="button" data-action="split-filtered">▶ Prehrať filtrované (max. 12)</button>
            <button type="button" data-action="sidecar-selected">Sidecar selected</button>
            <button type="button" data-action="sidecar-filtered">Sidecar filtered grid</button>
          </div>
          <div class="mfh-row" style="margin-top:6px;align-items:center;">
            <input type="text" data-field="port" placeholder="Port" inputmode="numeric" style="flex:0 0 70px;">
            <button type="button" data-action="reconnect" style="flex:0 0 auto;">Auto-connect</button>
            <span class="mfh-preview-state" data-role="conn-text" style="margin:0;flex:1;text-align:right;">not checked</span>
          </div>
          <div class="mfh-preview-state" data-role="preview-state">link not read yet</div>
        </div>

        <div class="mfh-sub">Click a card's ✓ to select. Shift-click for a range. Import needs the dashboard running locally.</div>
        <div class="mfh-stat" data-role="stat">Waiting for items…</div>
        <div class="mfh-results" data-role="results"></div>
      </div>
    `;
    document.body.appendChild(panel);

    const searchInput = panel.querySelector('input[type="search"]');
    searchInput.value = state.q;
    searchInput.addEventListener('input', () => { state.q = searchInput.value.trim(); savePrefs(); scheduleRefresh(); });

    panel.querySelectorAll('input[data-field]').forEach((input) => {
      const field = input.getAttribute('data-field');
      input.value = field === 'port' ? String(state.port) : (state[field] || '');
      input.addEventListener('input', () => {
        if (field === 'port') {
          state.port = Number(input.value) || DEFAULT_PORT;
          savePrefs();
          clearTimeout(portCheckTimer);
          // Re-ping the typed port shortly after the user stops typing.
          portCheckTimer = window.setTimeout(() => {
            pingPort(state.port).then((ok) => {
              connStatus = ok ? 'online' : 'offline';
              updateConnIndicator();
              if (ok) { resetPreview(); maybeFetchPreview(); }
            });
          }, 500);
          return;
        }
        state[field] = input.value.trim();
        savePrefs();
        scheduleRefresh();
      });
    });

    panel.addEventListener('click', onPanelClick);
    uiReady = true;
    syncPanel();
  }

  function onPanelClick(event) {
    const button = event.target.closest('button');
    if (!button) return;
    const action = button.getAttribute('data-action');
    const sort = button.getAttribute('data-sort');
    const media = button.getAttribute('data-media');
    const toggle = button.getAttribute('data-toggle');
    const quality = button.getAttribute('data-quality');
    const resultIndex = button.getAttribute('data-result-index');

    if (resultIndex !== null) {
      const item = currentResults[Number(resultIndex)];
      if (event.shiftKey || event.target.closest('.mfh-tick')) {
        if (item) toggleSelection(item.key, !selectedKeys.has(item.key), false);
      } else if (item?.el?.isConnected) {
        item.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      return;
    }
    if (action === 'toggle-collapse') {
      document.getElementById(PANEL_ID).classList.toggle('is-collapsed');
      return;
    }
    if (action === 'reset') {
      Object.assign(state, defaultState());
      savePrefs(); syncPanel(); clearAllLocalHiding(); scheduleRefresh();
      return;
    }
    if (action === 'quality-all') { state.qualities = []; savePrefs(); syncPanel(); scheduleRefresh(); return; }
    if (quality && QUALITY_OPTIONS.includes(quality)) {
      state.qualities = state.qualities.includes(quality)
        ? state.qualities.filter(q => q !== quality) : [...state.qualities, quality];
      savePrefs(); syncPanel(); scheduleRefresh(); return;
    }
    if (action === 'reconnect') { detectPort(true).then((ok) => { if (ok) maybeFetchPreview(); }); return; }
    if (action === 'split-selected' || action === 'split-filtered') { launchSplit(action === 'split-selected' ? selectedItems() : activeItems.filter(i => passesFilters(i, buildFilterContext()))); return; }
    if (action === 'select-filtered') { selectFiltered(); return; }
    if (action === 'clear-selection') { clearSelection(); return; }
    if (action === 'import-selected') { importSelected(); return; }
    if (action === 'import-filtered') { importFiltered(); return; }
    if (action === 'send-hub') { sendFolderToHub(button); return; }
    if (action === 'sidecar-selected') { sendToSidecar(selectedItems(), 'selected'); return; }
    if (action === 'sidecar-filtered') {
      const ctx = buildFilterContext();
      sendToSidecar(activeItems.filter((i) => i.type !== 'folder' && passesFilters(i, ctx)), 'filtered grid');
      return;
    }
    if (sort) { state.sort = state.sort === sort ? 'none' : sort; savePrefs(); syncPanel(); scheduleRefresh(); return; }
    if (media) { state.media = state.media === media ? 'all' : media; savePrefs(); syncPanel(); scheduleRefresh(); return; }
    if (toggle) { state[toggle] = !state[toggle]; savePrefs(); syncPanel(); scheduleRefresh(); return; }
  }

  function syncPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const searchInput = panel.querySelector('input[type="search"]');
    if (searchInput && searchInput.value !== state.q) searchInput.value = state.q;
    panel.querySelectorAll('input[data-field]').forEach((input) => {
      const field = input.getAttribute('data-field');
      const next = field === 'port' ? String(state.port) : (state[field] || '');
      if (input.value !== next) input.value = next;
    });
    panel.querySelectorAll('button[data-sort]').forEach((b) => b.classList.toggle('is-on', b.getAttribute('data-sort') === state.sort));
    panel.querySelectorAll('button[data-quality]').forEach(b => {
      const selected = state.qualities.includes(b.getAttribute('data-quality'));
      b.classList.toggle('is-on', selected);
      b.setAttribute('aria-pressed', String(selected));
    });
    const allQualities = panel.querySelector('[data-action="quality-all"]');
    if (allQualities) { allQualities.classList.toggle('is-on', !state.qualities.length); allQualities.setAttribute('aria-pressed', String(!state.qualities.length)); }
    panel.querySelectorAll('button[data-media]').forEach((b) => b.classList.toggle('is-on', b.getAttribute('data-media') === state.media));
    ['foldersFirst', 'onlyMatches', 'markDupes'].forEach((t) => {
      const b = panel.querySelector(`button[data-toggle="${t}"]`);
      if (b) b.classList.toggle('is-on', Boolean(state[t]));
    });
  }

  function observePage() {
    if (observer) return;
    observer = new MutationObserver(() => scheduleRefresh());
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('focus', scheduleRefresh, { passive: true });
    window.addEventListener('resize', scheduleRefresh, { passive: true });
    document.addEventListener('scroll', scheduleRefresh, { passive: true, capture: true });
    if (!periodicTimer) periodicTimer = window.setInterval(scheduleRefresh, 1800);
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(refreshNow, 120);
  }

  const VIDEO_FOLDER_RE = /(^|[^a-z0-9])(vids?|videos?|movies?|films?|ppvs?|clips?|footage)(?=[^a-z0-9]|$)/i;
  const IMAGE_FOLDER_RE = /(^|[^a-z0-9])(imgs?|images?|pics?|photos?|pictures?|galleries|gallery|jpgs?)(?=[^a-z0-9]|$)/i;

  function bytesFromText(text) {
    const match = String(text || '').match(/(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB|B)\b/i);
    if (!match) return 0;
    const parsed = parseSizeInput(`${match[1]}${match[2]}`);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function folderBytes(node) {
    const direct = Number(node?.tb || node?.s || 0);
    if (direct > 0) return direct;
    const el = node?.h ? document.getElementById(node.h) : null;
    return bytesFromText(el?.innerText || '');
  }

  function atAlbumRoot(model) {
    if (/\/folder\/[^/?#]+#[^/]+\/folder\//i.test(location.href)) return false;
    const root = rootHandleFromUrl();
    const current = String(model?.currentdirid || '');
    const megaRoot = String(model?.RootID || '');
    return Boolean(current) && (current === root || current === megaRoot);
  }

  function pickVideoFolder(nodes) {
    const folders = (nodes || []).filter((node) => node && node.t === 1 && node.h);
    if (!folders.length) return null;
    const ranked = folders.map((node) => {
      const name = String(node.name || node.n || '');
      const bytes = folderBytes(node);
      let score = Math.log10(bytes + 1);
      if (VIDEO_FOLDER_RE.test(name)) score += 100;
      if (IMAGE_FOLDER_RE.test(name)) score -= 40;
      if (bytes >= 1024 ** 3) score += 8;
      return { node, name, bytes, score };
    }).sort((a, b) => b.score - a.score || b.bytes - a.bytes);
    const best = ranked[0];
    if (IMAGE_FOLDER_RE.test(best.name) && !VIDEO_FOLDER_RE.test(best.name)) return null;
    const named = VIDEO_FOLDER_RE.test(best.name);
    const nextBytes = ranked[1]?.bytes || 0;
    const heavy = best.bytes >= 500 * 1024 * 1024 && (ranked.length === 1 || best.bytes >= nextBytes * 8);
    return (named || heavy) ? best.node : null;
  }

  function maybeAutoOpenVideoFolder() {
    try {
      const model = megaPage().M;
      if (!model?.currentdirid || !Array.isArray(model.v) || !model.v.length) return;
      if (!atAlbumRoot(model)) return;
      const root = rootHandleFromUrl() || String(model.RootID || model.currentdirid);
      if (sessionStorage.getItem(AUTO_OPEN_KEY) === root) return;
      const folders = model.v.filter((node) => node && node.t === 1);
      const filesNamed = model.v.some((node) => node && node.t === 0 && (node.name || node.n));
      if (!folders.length) {
        if (!filesNamed) return;
        sessionStorage.setItem(AUTO_OPEN_KEY, root);
        return;
      }
      const pending = folders.some((node) => !(node.name || node.n) && folderBytes(node) <= 0);
      const videoNamed = folders.some((node) => VIDEO_FOLDER_RE.test(String(node.name || node.n || '')));
      if (pending && !videoNamed) return;
      const target = pickVideoFolder(model.v);
      sessionStorage.setItem(AUTO_OPEN_KEY, root);
      if (!target?.h || String(target.h) === String(model.currentdirid)) return;
      if (typeof model.openFolder === 'function') {
        model.openFolder(target.h);
        return;
      }
      document.getElementById(target.h)?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    } catch (error) {
      console.warn('[MEGA Helper] Auto-open video folder failed:', error);
    }
  }

  function refreshNow() {
    checkFolderUrl();
    maybeAutoOpenVideoFolder();
    if (isApplying) return;
    syncNativeSort();
    const grid = findGridRoot();
    if (!grid) return;
    rootNode = grid;
    const items = findItems(grid);
    if (!items.length) return;
    activeItems = items;
    document.dispatchEvent(new CustomEvent('nexus-mega-catalog', { detail: JSON.stringify(splitItems(items)) }));
    grid.classList.add(GRID_STATE_CLASS, 'mfh-biggrid');
    if (observer) observer.disconnect();
    isApplying = true;
    try { applyLayout(grid, items); queueQualityProbes(); }
    finally {
      isApplying = false;
      if (observer) observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  // ── Port auto-detection + connection status ─────────────────────────────────
  function pingPort(port, timeoutMs = 1500) {
    return bridgeFetch(`http://localhost:${port}/health`, { timeoutMs })
      .then((r) => r.ok)
      .catch(() => false);
  }

  // Find a live dashboard port. Tries the saved port first, then the candidates.
  async function detectPort(force) {
    if (detecting) return detecting;
    connStatus = 'searching';
    updateConnIndicator();
    detecting = (async () => {
      const order = [state.port, ...CANDIDATE_PORTS.filter(p => p !== state.port)];
      for (const port of order) {
        if (!await pingPort(port)) continue;
        const changed = port !== state.port;
        state.port = port;
        savePrefs();
        syncPanel();
        connStatus = 'online';
        updateConnIndicator();
        if (changed || force) resetPreview();
        return true;
      }
      connStatus = 'offline';
      updateConnIndicator();
      return false;
    })();
    try {
      return await detecting;
    } finally {
      detecting = null;
    }
  }

  function updateConnIndicator() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const led = panel.querySelector('[data-role="conn-led"]');
    const text = panel.querySelector('[data-role="conn-text"]');
    const map = {
      online:    { c: '#36d399', t: `connected :${state.port}` },
      offline:   { c: '#ff6b6b', t: 'dashboard offline' },
      searching: { c: '#ffd166', t: 'searching…' },
      unknown:   { c: '#888',    t: 'not checked' }
    };
    const m = map[connStatus] || map.unknown;
    if (led) {
      led.style.background = m.c;
      led.style.boxShadow = `0 0 8px ${m.c}`;
      led.classList.toggle('mfh-led-pulse', connStatus === 'searching');
    }
    if (text) { text.textContent = m.t; text.style.color = connStatus === 'offline' ? '#ff9a9a' : ''; }
  }

  // ── Preview bridge: pull exact refs/sizes from the dashboard ────────────────
  function resetPreview() {
    previewByName = new Map();
    previewByHandle = new Map();
    previewMeta = { title: '', count: 0, fetchedFor: '', loading: false, error: '' };
  }

  function normName(name) {
    return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // The folder link often points at an unnamed subfolder ("Videos" / "MEGA
  // Album"), but the breadcrumb shows the real album name. Read the first
  // meaningful breadcrumb segment so the dashboard can name the batch/videos.
  function getAlbumTitle() {
    const crumb = document.querySelector('.fm-breadcrumbs, [class*="breadcrumb"]');
    if (crumb) {
      // Each crumb segment is usually its own child; take the first non-generic one.
      const segs = [...crumb.querySelectorAll('*')]
        .map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const generic = /^(videos?|vids?|mega album|clips?|files?)$/i;
      const pick = segs.find((s) => s.length > 2 && !generic.test(s));
      if (pick) return pick;
      const whole = (crumb.textContent || '').replace(/\s+/g, ' ').trim();
      if (whole) return whole;
    }
    return previewMeta.title || '';
  }

  function maybeFetchPreview() {
    const url = location.href;
    if (previewMeta.loading || previewMeta.fetchedFor === url) return;
    previewMeta.loading = true;
    previewMeta.error = '';
    updatePreviewState();

    const endpoint = `http://localhost:${state.port}/api/v1/mega/preview?url=${encodeURIComponent(url)}`;
    bridgeFetch(endpoint, { method: 'GET' })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || `Server ${res.status}`);
        previewByName = new Map();
        previewByHandle = new Map();
        (data.videos || []).forEach((v) => {
          previewByName.set(normName(v.name), v);
          if (v.handle) previewByHandle.set(String(v.handle), v);
        });
        previewMeta = { title: data.title || '', count: data.count || 0, fetchedFor: url, loading: false, error: '' };
        connStatus = 'online';
        updateConnIndicator();
        updatePreviewState();
        scheduleRefresh();
      })
      .catch((err) => {
        previewMeta.loading = false;
        previewMeta.error = String(err.message || err);
        previewMeta.fetchedFor = '';
        const networkDown = previewMeta.error.includes('Failed to fetch') || previewMeta.error.includes('NetworkError');
        updatePreviewState();
        // A network-level failure usually means the port moved/died — re-scan once.
        if (networkDown && connStatus !== 'searching') {
          detectPort(true).then((ok) => { if (ok) maybeFetchPreview(); });
        }
      });
  }

  function updatePreviewState() {
    const el = document.querySelector(`#${PANEL_ID} [data-role="preview-state"]`);
    if (!el) return;
    if (previewMeta.loading) { el.textContent = 'reading folder…'; el.style.color = ''; return; }
    if (previewMeta.error) {
      el.textContent = (previewMeta.error.includes('Failed to fetch') || previewMeta.error.includes('NetworkError'))
        ? `dashboard offline :${state.port}` : previewMeta.error.slice(0, 40);
      el.style.color = '#ff9a9a';
      return;
    }
    el.textContent = `${previewMeta.count} videos linked`;
    el.style.color = '#9affc8';
  }

  function refForItem(item) {
    if (!item) return null;
    const byHandle = item.megaHandle && previewByHandle.get(item.megaHandle);
    if (byHandle) return byHandle;
    const byName = previewByName.get(normName(item.label));
    return byName || null;
  }

  // ── Item discovery ──────────────────────────────────────────────────────────
  function findGridRoot() {
    const candidates = [
      document.querySelector('#fmholder'),
      document.querySelector('#startholder'),
      document.querySelector('[class*="files-grid"]'),
      document.querySelector('[class*="folder-view"]'),
      document.querySelector('[class*="file-view"]'),
      document.querySelector('main')
    ].filter(Boolean);
    for (const c of candidates) {
      if (c.querySelectorAll(ITEM_SELECTORS).length >= 3) return c;
    }
    return document.body || null;
  }

  function findItems(grid) {
    const raw = Array.from(grid.querySelectorAll(`${ITEM_SELECTORS}, [data-mfh-card="1"]`));
    const seenNodes = new Set();
    const seenKeys = new Set();
    const items = [];

    for (const candidate of raw) {
      const el = getCardElement(candidate, grid);
      if (!el || seenNodes.has(el)) continue;
      if (!isVisible(el) && el.dataset.mfhCard !== '1') continue;
      if (el.id === PANEL_ID || el.closest(`#${PANEL_ID}`)) continue;
      const label = getItemLabel(el);
      if (!label) continue;
      if (looksLikeControl(el)) continue;
      const key = getStableKey(el, label);
      if (seenKeys.has(key)) continue;
      seenNodes.add(el);
      seenKeys.add(key);
      markManagedCard(el, key);
      items.push({
        el, key, label,
        lower: label.toLowerCase(),
        fullText: getItemFullText(el),
        type: getItemType(el, label),
        megaHandle: getMegaHandle(el),
        durationSeconds: 0,
        sizeBytes: 0
      });
    }

    const unique = [];
    const nodeSet = new Set();
    for (const item of items) {
      if (nodeSet.has(item.el)) continue;
      nodeSet.add(item.el);
      item.durationSeconds = extractDuration(item.fullText);
      // Prefer the exact size from the dashboard preview, else M.d, else card text.
      const pv = refForItem(item);
      const previewSize = pv ? Number(pv.size || 0) : 0;
      item.sizeBytes = previewSize || getMegaNodeSize(item.el) || extractSizeBytes(item.fullText);
      const media = nativeVideoMetadata(item);
      if (media?.playtime > 0 && !item.durationSeconds) item.durationSeconds = media.playtime;
      const cached = cachedQuality(item);
      if (cached?.duration > 0 && !item.durationSeconds) item.durationSeconds = cached.duration;
      if (item.type === 'file' && item.durationSeconds > 0) item.type = 'video';
      applyBadges(item);
      ensureCheckbox(item);
      unique.push(item);
    }
    return unique;
  }

  function getCardElement(el, grid) {
    if (!el || el === grid || el === document.body || el.closest(`#${PANEL_ID}`)) return null;
    const stableCard = el.closest([
      '[data-mfh-card="1"]', '.megaListItem', '.mega-list-item', '.data-block-view',
      '.data-block-bg', '.fm-item', '.file-block', '.folder-block',
      '[data-nodeid]', '[data-handle]', '[data-item-id]'
    ].join(','));
    const card = stableCard && grid.contains(stableCard) ? stableCard : el;
    if (!card || card === grid || card.closest(`#${PANEL_ID}`)) return null;
    const rect = card.getBoundingClientRect();
    if (card.dataset.mfhCard !== '1' && (rect.width < 45 || rect.height < 45)) return null;
    if (looksLikeToolbarOrPanel(card)) return null;
    return card;
  }

  function markManagedCard(el, key) {
    setDataValue(el, 'mfhCard', '1');
    setDataValue(el, 'mfhKey', key);
    if (!el.dataset.mfhOriginalIndex) setDataValue(el, 'mfhOriginalIndex', String(nextOriginalIndex++));
  }

  function ensureCheckbox(item) {
    if (item.type === 'folder') return;
    let box = item.el.querySelector(':scope > .mfh-checkbox');
    if (!box) {
      box = document.createElement('div');
      box.className = 'mfh-checkbox';
      box.title = 'Select (Shift-click for range)';
      box.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        toggleSelection(item.key, !selectedKeys.has(item.key), e.shiftKey);
      });
      item.el.appendChild(box);
    }
    setDataValue(item.el, 'mfhSelected', selectedKeys.has(item.key) ? '1' : '0');
  }

  function clearAllLocalHiding() {
    document.querySelectorAll('[data-mfh-card="1"], [data-mfh-hidden="1"], [data-mfh-match="1"]').forEach((el) => {
      setDataValue(el, 'mfhHidden', '0');
      setDataValue(el, 'mfhMatch', '0');
      if (el.style.order) el.style.order = '';
    });
  }

  function setDataValue(el, key, value) { if (el.dataset[key] !== value) el.dataset[key] = value; }

  function getStableKey(el, label) {
    return [
      el.getAttribute('data-nodeid') || '', el.getAttribute('data-handle') || '',
      el.getAttribute('data-item-id') || '', el.getAttribute('id') || '', label
    ].join('|');
  }

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 10 && rect.height > 10;
  }

  function getItemLabel(el) {
    const direct = [el.getAttribute('aria-label'), el.getAttribute('title'), el.dataset?.name, el.dataset?.title]
      .find((v) => v && v.trim());
    if (direct) return direct.trim();
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > 180 ? text.slice(0, 180) : text;
  }

  function looksLikeToolbarOrPanel(el) {
    const role = (el.getAttribute('role') || '').toLowerCase();
    const className = String(el.className || '').toLowerCase();
    const id = String(el.id || '').toLowerCase();
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (role === 'button' || role === 'menu' || role === 'dialog') return true;
    if (/toolbar|context|menu|button|dropdown|tooltip|search|topbar|sidebar/.test(`${className} ${id}`)) return true;
    return text.length > 260;
  }

  function getItemFullText(el) {
    const parts = [el.getAttribute('aria-label'), el.getAttribute('title'), el.dataset?.name, el.dataset?.title, el.innerText, el.textContent].filter(Boolean);
    return parts.join(' | ').replace(/\s+/g, ' ').trim();
  }

  function looksLikeControl(el) {
    const text = (el.textContent || '').trim().toLowerCase();
    return /^(search|sort|view|download|upload|copy|share|close|menu|settings)$/.test(text);
  }

  function getItemType(el, label) {
    const tagName = el.tagName.toLowerCase();
    const hint = `${label} ${el.className || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-type') || ''}`.toLowerCase();
    const href = el.getAttribute('href') || '';
    if (tagName === 'a' && /\/folder\//i.test(href)) return 'folder';
    if (tagName === 'a' && /\/file\//i.test(href)) return 'file';
    if (FOLDER_HINT_RE.test(hint)) return 'folder';
    if (IMAGE_RE.test(label) || IMAGE_RE.test(href) || /image|photo|picture|thumbnail/.test(hint)) return 'image';
    if (VIDEO_RE.test(label) || VIDEO_RE.test(href) || /video|movie|clip|stream/.test(hint)) return 'video';
    return 'file';
  }

  function extractDuration(text) {
    const source = String(text || '');
    const colonMatches = source.match(/\b(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)\b/g) || [];
    let best = 0;
    for (const raw of colonMatches) {
      const parts = raw.split(':').map(Number);
      const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
      if (seconds > best) best = seconds;
    }
    const labeled = source.match(/\b(?:(\d+(?:[.,]\d+)?)\s*h(?:ours?)?)?\s*(?:(\d+(?:[.,]\d+)?)\s*m(?:in(?:utes?)?)?)?\s*(?:(\d+(?:[.,]\d+)?)\s*s(?:ec(?:onds?)?)?)?\b/i);
    if (labeled) {
      const h = Number(String(labeled[1] || '0').replace(',', '.'));
      const m = Number(String(labeled[2] || '0').replace(',', '.'));
      const s = Number(String(labeled[3] || '0').replace(',', '.'));
      const total = Math.round(h * 3600 + m * 60 + s);
      if (total > best) best = total;
    }
    return best;
  }

  function extractSizeBytes(text) {
    const source = String(text || '');
    const matches = [...source.matchAll(/\b(\d+(?:[.,]\d+)?)\s*(B|KB|MB|GB|TB)\b/gi)];
    let best = 0;
    for (const m of matches) {
      const value = Number(m[1].replace(',', '.'));
      const scale = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[m[2].toUpperCase()] || 0;
      const bytes = value * scale;
      if (bytes > best) best = bytes;
    }
    return best;
  }

  function getMegaNodeSize(el) {
    const handle = getMegaHandle(el);
    if (!handle) return 0;
    try {
      const node = megaPage().M?.d?.[handle];
      const size = Number(node?.s || node?.tb || 0);
      return Number.isFinite(size) && size > 0 ? size : 0;
    } catch { return 0; }
  }

  function getMegaHandle(el) {
    const direct = [el.getAttribute('data-nodeid'), el.getAttribute('data-handle'), el.getAttribute('data-item-id'), el.getAttribute('id')].find(Boolean);
    if (direct && /^[A-Za-z0-9_-]{6,12}$/.test(direct)) return direct;
    const nested = el.querySelector?.('[data-nodeid], [data-handle], [data-item-id]');
    const nestedHandle = nested && [nested.getAttribute('data-nodeid'), nested.getAttribute('data-handle'), nested.getAttribute('data-item-id'), nested.getAttribute('id')].find(Boolean);
    if (nestedHandle && /^[A-Za-z0-9_-]{6,12}$/.test(nestedHandle)) return nestedHandle;
    return '';
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value >= 1024 ** 3) return `${trimNumber(value / 1024 ** 3)} GB`;
    if (value >= 1024 ** 2) return `${trimNumber(value / 1024 ** 2)} MB`;
    if (value >= 1024) return `${trimNumber(value / 1024)} KB`;
    return `${Math.round(value)} B`;
  }

  function trimNumber(value) { return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, ''); }

  function applyBadges(item) {
    if (!item || item.type === 'folder') return;
    applyDateBadge(item);
    applyQualityBadge(item);
    const sizeText = formatBytes(item.sizeBytes);
    if (sizeText) setDataValue(item.el, 'mfhSizeLabel', sizeText);
    else if (item.el.dataset.mfhSizeLabel) delete item.el.dataset.mfhSizeLabel;

    const durText = item.durationSeconds ? formatDuration(item.durationSeconds) : '';
    if (durText) setDataValue(item.el, 'mfhDurLabel', durText);
    else if (item.el.dataset.mfhDurLabel) delete item.el.dataset.mfhDurLabel;
  }

  function formatAddedDate(timestamp) {
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const date = new Date(seconds * 1000);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat('sk-SK', {
      day: '2-digit', month: '2-digit', year: 'numeric'
    }).format(date).replace(/\s/g, '');
  }

  function nativeVideoMetadata(item) {
    try {
      const page = megaPage();
      const node = page.M?.d?.[item.megaHandle];
      if (node && typeof page.MediaAttribute === 'function') return new page.MediaAttribute(node).data || null;
    } catch {}
    return null;
  }

  function qualityLabel(meta) {
    const w = Number(meta?.width), h = Number(meta?.height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 || w > 16384 || h > 16384) return '';
    const side = Math.round(Math.min(w, h));
    return side >= 2160 ? '4K' : `${side}p`;
  }

  function qualityKey(item) { return `${rootHandleFromUrl()}:${item.megaHandle}`; }

  function itemQuality(item) {
    const native = nativeVideoMetadata(item);
    const meta = qualityLabel(native) ? native : cachedQuality(item);
    return qualityLabel(meta) ? Math.round(Math.min(Number(meta.width), Number(meta.height))) : 0;
  }

  function qualityBucket(height) {
    if (!height) return 'unknown';
    for (const limit of [2160, 1440, 1080, 720, 480]) if (height >= limit) return String(limit);
    return 'sd';
  }

  function compareQuality(a, b, descending) {
    const qa = itemQuality(a), qb = itemQuality(b);
    if (!qa || !qb) return qa ? -1 : qb ? 1 : 0;
    return descending ? qb - qa : qa - qb;
  }

  function cachedQuality(item) {
    const key = qualityKey(item);
    if (qualityCache.has(key)) return qualityCache.get(key);
    try {
      const saved = JSON.parse(sessionStorage.getItem(`mfh:quality:${key}`) || 'null');
      if (qualityLabel(saved)) { qualityCache.set(key, saved); return saved; }
    } catch {}
    return null;
  }

  function applyQualityBadge(item) {
    let badge = item.el.querySelector(':scope > .mfh-quality-label');
    if (item.type !== 'video') {
      badge?.remove();
      delete item.el.dataset.mfhQualityLabel;
      return;
    }
    const native = nativeVideoMetadata(item);
    const meta = qualityLabel(native) ? native : cachedQuality(item);
    const label = qualityLabel(meta);
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'mfh-quality-label';
      item.el.appendChild(badge);
    }
    const text = label || (qualityPending.has(qualityKey(item)) ? 'Kvalita…' : 'Kvalita ?');
    if (badge.textContent !== text) badge.textContent = text;
    badge.title = label ? `Rozlíšenie: ${meta.width} × ${meta.height}` : 'Rozlíšenie zatiaľ nie je dostupné';
    setDataValue(item.el, 'mfhQualityLabel', text);
  }

  function queueQualityProbes() {
    if (connStatus !== 'online') return;
    const ctx = { ...buildFilterContext(), qualities: [] };
    for (const item of activeItems) {
      if (qualityWorkers >= 3) break;
      if (item.type !== 'video') continue;
      // Unknown cards hidden by the quality filter must still get resolved.
      const resolvingFilter = state.qualities.length && !itemQuality(item) && passesFilters(item, ctx);
      if (!resolvingFilter && item.el.dataset.mfhHidden === '1') continue;
      const rect = item.el.getBoundingClientRect();
      if (!resolvingFilter && (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth)) continue;
      if (qualityLabel(nativeVideoMetadata(item)) || qualityLabel(cachedQuality(item))) continue;
      const key = qualityKey(item);
      const attempt = qualityAttempts.get(key);
      if (qualityPending.has(key) || (attempt && (attempt.count >= 2 || Date.now() - attempt.time < 60000))) continue;
      const keyed = keyedVideoFromHandle(item.megaHandle, rootHandleFromUrl(), 0);
      const ref = keyed?.ref || refForItem(item)?.ref;
      if (!ref) continue;
      qualityPending.add(key);
      qualityAttempts.set(key, { count: (attempt?.count || 0) + 1, time: Date.now() });
      qualityWorkers++;
      applyQualityBadge(item);
      void fetchCardQuality(item, key, ref);
    }
  }

  async function fetchCardQuality(item, key, ref) {
    try {
      const response = await bridgeFetch(`http://localhost:${state.port}/api/v1/mega/metadata`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref }), timeoutMs: 10000
      });
      if (!response.ok) return;
      const meta = await response.json();
      if (!qualityLabel(meta)) return;
      qualityCache.set(key, meta);
      try { sessionStorage.setItem(`mfh:quality:${key}`, JSON.stringify(meta)); } catch {}
      if (meta.duration > 0) item.durationSeconds = meta.duration;
    } catch { /* Keep an honest unknown badge and allow one delayed retry. */ }
    finally {
      qualityPending.delete(key);
      qualityWorkers--;
      if (item.el.isConnected) applyBadges(item);
      scheduleRefresh();
    }
  }

  function applyDateBadge(item) {
    let badge = item.el.querySelector(':scope > .mfh-date-label');
    let dateText = '';
    try {
      // ts is MEGA's Date added; mtime is Last modified and is deliberately not substituted.
      if (item.type === 'video') dateText = formatAddedDate(megaPage().M?.d?.[item.megaHandle]?.ts);
    } catch {}
    if (!dateText) {
      badge?.remove();
      delete item.el.dataset.mfhDateLabel;
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'mfh-date-label';
      item.el.appendChild(badge);
    }
    if (badge.textContent !== dateText) badge.textContent = dateText;
    badge.title = `Dátum pridania do MEGA: ${dateText}`;
    setDataValue(item.el, 'mfhDateLabel', dateText);
  }

  function parseDurationInput(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return 0;
    if (/^\d+$/.test(text)) return Number(text);
    let total = 0;
    const matches = [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)/g)];
    if (matches.length) {
      for (const m of matches) {
        const num = Number(m[1].replace(',', '.'));
        if (m[2].startsWith('h')) total += num * 3600;
        else if (m[2].startsWith('m')) total += num * 60;
        else total += num;
      }
      return Math.round(total);
    }
    const colon = text.split(':').map(Number);
    if (colon.every(Number.isFinite)) {
      if (colon.length === 2) return colon[0] * 60 + colon[1];
      if (colon.length === 3) return colon[0] * 3600 + colon[1] * 60 + colon[2];
    }
    return Number.NaN;
  }

  function parseSizeInput(value) {
    const text = String(value || '').trim().toUpperCase();
    if (!text) return 0;
    const m = text.match(/^(\d+(?:[.,]\d+)?)\s*(B|KB|MB|GB|TB)?$/i);
    if (!m) return Number.NaN;
    const num = Number(m[1].replace(',', '.'));
    const scale = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[(m[2] || 'MB').toUpperCase()];
    return num * scale;
  }

  function passesFilters(item, ctx) {
    const { query, minDuration, maxDuration, minSize, maxSize,
      hasDurationFilter, hasSizeFilter, invalidDurationInput, invalidSizeInput } = ctx;
    if (query && !item.lower.includes(query)) return false;
    if (state.media === 'videos' && item.type !== 'video') return false;
    if (state.media === 'images' && item.type !== 'image') return false;
    if (ctx.qualities?.length && (item.type !== 'video' || !ctx.qualities.includes(qualityBucket(itemQuality(item))))) return false;
    if (!invalidDurationInput && hasDurationFilter) {
      if (!item.durationSeconds) return false;
      if (state.durationMin && item.durationSeconds < minDuration) return false;
      if (state.durationMax && item.durationSeconds > maxDuration) return false;
    }
    if (!invalidSizeInput && hasSizeFilter) {
      if (!item.sizeBytes) return false;
      if (state.sizeMin && item.sizeBytes < minSize) return false;
      if (state.sizeMax && item.sizeBytes > maxSize) return false;
    }
    return true;
  }

  function applyLayout(grid, items) {
    const ctx = buildFilterContext();
    const visibleItems = [];
    const currentElements = new Set(items.map((i) => i.el));
    const noActiveFilters = !ctx.query && state.sort === 'none' && !state.foldersFirst
      && state.media === 'all' && !ctx.hasDurationFilter && !ctx.hasSizeFilter && !ctx.qualities.length && !state.onlyMatches;

    grid.querySelectorAll('[data-mfh-hidden="1"], [data-mfh-card="1"]').forEach((el) => {
      if (!currentElements.has(el)) {
        setDataValue(el, 'mfhHidden', '0');
        if (el.style.order) el.style.order = '';
      }
    });

    for (const item of items) {
      const show = passesFilters(item, ctx);
      setDataValue(item.el, 'mfhMatch', show && !noActiveFilters ? '1' : '0');
      setDataValue(item.el, 'mfhHidden', (state.onlyMatches || ctx.qualities.length > 0) && !show ? '1' : '0');
      if (show) visibleItems.push(item);
    }

    markDuplicates(state.markDupes ? visibleItems : []);

    const sorted = (noActiveFilters ? items.slice() : visibleItems.slice());
    sorted.sort((a, b) => compareItems(a, b, noActiveFilters));

    updateStat(items.length, visibleItems.length, ctx.invalidDurationInput, ctx.invalidSizeInput);
    updateSummary(visibleItems);
    updateSelectionBar(visibleItems);
    updateResultsList(sorted, noActiveFilters, ctx.invalidDurationInput || ctx.invalidSizeInput);
  }

  function buildFilterContext() {
    const minDuration = parseDurationInput(state.durationMin);
    const maxDuration = parseDurationInput(state.durationMax);
    const minSize = parseSizeInput(state.sizeMin);
    const maxSize = parseSizeInput(state.sizeMax);
    return {
      query: state.q.toLowerCase(),
      qualities: state.qualities,
      minDuration, maxDuration, minSize, maxSize,
      hasDurationFilter: Boolean(state.durationMin || state.durationMax),
      hasSizeFilter: Boolean(state.sizeMin || state.sizeMax),
      invalidDurationInput: (state.durationMin && !Number.isFinite(minDuration)) || (state.durationMax && !Number.isFinite(maxDuration)),
      invalidSizeInput: (state.sizeMin && !Number.isFinite(minSize)) || (state.sizeMax && !Number.isFinite(maxSize))
    };
  }

  function compareItems(a, b, noActiveFilters) {
    if (noActiveFilters) return Number(a.el.dataset.mfhOriginalIndex || 0) - Number(b.el.dataset.mfhOriginalIndex || 0);
    if (state.foldersFirst) {
      const ra = a.type === 'folder' ? 0 : 1;
      const rb = b.type === 'folder' ? 0 : 1;
      if (ra !== rb) return ra - rb;
    }
    switch (state.sort) {
      case 'az': return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
      case 'za': return b.label.localeCompare(a.label, undefined, { sensitivity: 'base' });
      case 'sizeAsc': return (a.sizeBytes || 0) - (b.sizeBytes || 0);
      case 'sizeDesc': return (b.sizeBytes || 0) - (a.sizeBytes || 0);
      case 'durAsc': return (a.durationSeconds || 0) - (b.durationSeconds || 0);
      case 'durDesc': return (b.durationSeconds || 0) - (a.durationSeconds || 0);
      case 'qualityAsc': return compareQuality(a, b, false);
      case 'qualityDesc': return compareQuality(a, b, true);
      default: return 0;
    }
  }

  function markDuplicates(items) {
    // Clear stale dupe marks among current cards first.
    document.querySelectorAll('[data-mfh-dupe="1"]').forEach((el) => setDataValue(el, 'mfhDupe', '0'));
    if (!items.length) return;
    const push = (map, key, it) => { if (!map.has(key)) map.set(key, []); map.get(key).push(it); };
    const byName = new Map();
    const bySize = new Map();
    for (const it of items) {
      const nameKey = normName(it.label);
      if (nameKey) push(byName, nameKey, it);
      if (it.sizeBytes) push(bySize, it.sizeBytes, it);
    }
    const flag = (groups) => groups.forEach((g) => { if (g.length > 1) g.forEach((it) => setDataValue(it.el, 'mfhDupe', '1')); });
    flag([...byName.values()]);
    flag([...bySize.values()]);
  }

  // ── Selection ───────────────────────────────────────────────────────────────
  function toggleSelection(key, makeSelected, isShift) {
    if (isShift && lastClickedKey && lastClickedKey !== key) {
      applyRangeSelection(lastClickedKey, key, makeSelected);
    } else if (makeSelected) {
      selectedKeys.add(key);
    } else {
      selectedKeys.delete(key);
    }
    lastClickedKey = key;
    reflectSelection();
  }

  function applyRangeSelection(fromKey, toKey, makeSelected) {
    const order = activeItems.filter((i) => i.el.dataset.mfhHidden !== '1');
    const ai = order.findIndex((i) => i.key === fromKey);
    const bi = order.findIndex((i) => i.key === toKey);
    if (ai === -1 || bi === -1) {
      if (makeSelected) selectedKeys.add(toKey); else selectedKeys.delete(toKey);
      return;
    }
    const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai];
    for (let i = lo; i <= hi; i++) {
      if (order[i].type === 'folder') continue;
      if (makeSelected) selectedKeys.add(order[i].key); else selectedKeys.delete(order[i].key);
    }
  }

  function selectFiltered() {
    const ctx = buildFilterContext();
    for (const item of activeItems) {
      if (item.type === 'folder') continue;
      if (passesFilters(item, ctx)) selectedKeys.add(item.key);
    }
    reflectSelection();
  }

  function clearSelection() { selectedKeys.clear(); lastClickedKey = null; reflectSelection(); }

  function reflectSelection() {
    for (const item of activeItems) {
      setDataValue(item.el, 'mfhSelected', selectedKeys.has(item.key) ? '1' : '0');
    }
    updateSelectionBar(activeItems.filter((i) => i.el.dataset.mfhHidden !== '1'));
    renderResultTicks();
    document.dispatchEvent(new CustomEvent('nexus-mega-catalog', { detail: JSON.stringify(splitItems(activeItems)) }));
  }

  function selectedItems() {
    const byKey = new Map(activeItems.map((i) => [i.key, i]));
    return [...selectedKeys].map((k) => byKey.get(k)).filter(Boolean);
  }

  function updateSelectionBar() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const sel = selectedItems();
    const count = panel.querySelector('[data-role="selcount"]');
    const size = panel.querySelector('[data-role="selsize"]');
    const importBtn = panel.querySelector('[data-action="import-selected"]');
    const totalBytes = sel.reduce((s, i) => s + (i.sizeBytes || 0), 0);
    if (count) count.textContent = `${sel.length} selected`;
    if (size) size.textContent = sel.length ? `≈ ${formatBytes(totalBytes) || '?'}` : '';
    if (importBtn) {
      importBtn.disabled = sel.length === 0;
      importBtn.textContent = sel.length ? `Import ${sel.length} selected →` : 'Import selected →';
    }
  }

  function updateSummary(visibleItems) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const vids = visibleItems.filter((i) => i.type !== 'folder');
    const totalBytes = vids.reduce((s, i) => s + (i.sizeBytes || 0), 0);
    const totalDur = vids.reduce((s, i) => s + (i.durationSeconds || 0), 0);
    const set = (sel, val) => { const el = panel.querySelector(`[data-sum="${sel}"]`); if (el) el.textContent = val; };
    set('count', String(visibleItems.length));
    set('size', formatBytes(totalBytes) || '–');
    set('dur', totalDur ? formatDuration(totalDur) : '–');
  }

  // ── Import ──────────────────────────────────────────────────────────────────
  async function importRefs(refs, label) {
    if (!refs.length) { toast('Nothing to import (no matching MEGA refs).', true); return; }
    toast(`Importing ${refs.length} video(s) → port ${state.port}…`);
    try {
      const res = await bridgeFetch(`http://localhost:${state.port}/api/v1/mega/add-selected`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: location.href, refs, title: getAlbumTitle() || undefined })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `Server ${res.status}`);
      const added = data.added ?? 0;
      const skipped = data.skipped ?? 0;
      toast(`Imported ${added} new${skipped ? `, ${skipped} already in library` : ''} (${label}).`);
    } catch (err) {
      const msg = String(err.message || err);
      toast(msg.includes('Failed to fetch') ? `Dashboard offline on port ${state.port}.` : `Import failed: ${msg}`, true);
    }
  }

  function collectRefs(items) {
    const refs = [];
    const missing = [];
    for (const item of items) {
      const pv = refForItem(item);
      if (pv?.ref) refs.push(pv.ref);
      else missing.push(item.label);
    }
    return { refs: [...new Set(refs)], missing };
  }

  // ── Relinked-share fallback: build refs from MEGA's in-page decrypted keys ──
  // Some shares (re-shared from another account) hand file keys to the logged-in
  // web page but NOT to an anonymous folder-link reader, so the dashboard's
  // server-side preview returns 0 videos. The page itself already holds the
  // decrypted keys in window.M.d, so we assemble the compact refs here.
  const VIDEO_EXT_RE = /\.(mp4|mkv|avi|mov|m4v|webm|flv|wmv|ts|m2ts)$/i;

  function b64urlFromBytes(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // MEGA stores a file key as 8 unsigned 32-bit ints (a32). Pack big-endian.
  function a32ToBytes(a32) {
    const out = new Uint8Array(a32.length * 4);
    for (let i = 0; i < a32.length; i++) {
      const v = a32[i] >>> 0;
      out[i * 4] = (v >>> 24) & 0xff;
      out[i * 4 + 1] = (v >>> 16) & 0xff;
      out[i * 4 + 2] = (v >>> 8) & 0xff;
      out[i * 4 + 3] = v & 0xff;
    }
    return out;
  }

  // The share root handle the dashboard streams against = first /folder/<h> in URL.
  function rootHandleFromUrl() {
    const m = location.href.match(/\/folder\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : '';
  }

  function keyedVideoFromHandle(handle, root, seq) {
    const node = megaPage().M?.d?.[handle];
    if (!node || node.t !== 0) return null;           // t=0 → file
    const k = node.k;
    if (!Array.isArray(k) || k.length < 8) return null; // need full 8-word file key
    const name = node.name || node.n || '';
    if (!VIDEO_EXT_RE.test(name)) return null;
    const keyB64 = b64urlFromBytes(a32ToBytes(k.slice(0, 8)));
    return {
      ref: `mega:n:${root}:${handle}:${keyB64}`,
      name,
      size: Number(node.s || 0) || 0,
      seq,
    };
  }

  // Build keyed videos for the given items; seq numbers by position among all
  // current video items so stable "{album} {N}" naming survives selective import.
  function buildKeyedVideos(items) {
    const root = rootHandleFromUrl();
    if (!root) return [];
    const allVideoHandles = activeItems
      .filter((i) => i.type !== 'folder' && i.megaHandle)
      .map((i) => i.megaHandle);
    const seqOf = new Map(allVideoHandles.map((h, idx) => [h, idx + 1]));
    const out = [];
    const seen = new Set();
    for (const item of items) {
      const h = item.megaHandle;
      if (!h || seen.has(h)) continue;
      seen.add(h);
      const kv = keyedVideoFromHandle(h, root, seqOf.get(h));
      if (kv) out.push(kv);
    }
    return out;
  }

  function folderSnapshotForHub() {
    const url = new URL(location.href);
    if (url.hash.includes('/file/')) url.hash = url.hash.split('/file/')[0];
    const root = rootHandleFromUrl();
    const model = megaPage().M;
    const hashFolder = url.hash.match(/\/folder\/([\w-]{8})/)?.[1];
    const nodeId = model?.currentdirid;
    const scope = hashFolder || (model?.d?.[nodeId]?.t ? nodeId : model?.RootID);
    if (!root || !model?.d || !/^[\w-]{8}$/.test(scope || '')) return { url: url.href };

    if (!hashFolder && model.RootID && scope !== model.RootID && /^[\w-]{8}$/.test(model.RootID)) {
      url.hash = `${url.hash.split('/')[0]}/folder/${scope}`;
    }
    const children = new Map();
    for (const node of Object.values(model.d)) {
      if (!node?.p || !/^[\w-]{8}$/.test(node.h || '')) continue;
      if (!children.has(node.p)) children.set(node.p, []);
      children.get(node.p).push(node);
    }
    const folders = [];
    const videos = [];
    const pending = [scope];
    const visited = new Set(pending);
    let partial = false;
    while (pending.length) {
      const parent = pending.pop();
      const nodes = children.get(parent) || [];
      if (model.d[parent]?.tvf > 0 && !nodes.length) partial = true;
      for (const node of nodes) {
        if (visited.has(node.h)) continue;
        visited.add(node.h);
        if (node.t) {
          if (folders.length >= 10000) { partial = true; continue; }
          folders.push({ id: node.h, parent, name: (node.name || 'MEGA priečinok').slice(0, 1024) });
          pending.push(node.h);
        } else if (VIDEO_EXT_RE.test(node.name || node.n || '')) {
          const video = keyedVideoFromHandle(node.h, root);
          if (!video || videos.length >= 10000) { partial = true; continue; }
          const meta = nativeVideoMetadata({ megaHandle: node.h });
          videos.push({ ref: video.ref, name: video.name.slice(0, 1024), parent, size: video.size,
            timestamp: Math.max(0, Number(node.ts) || 0), duration: Number(meta?.playtime) || 0,
            width: Number(meta?.width) || 0, height: Number(meta?.height) || 0 });
        } else if (!node.name && !node.n) {
          partial = true;
        }
      }
    }
    const title = (model.d[scope]?.name || getAlbumTitle() || 'MEGA priečinok').slice(0, 1024);
    return { url: url.href, page: { title, scope, folders, videos, partial } };
  }

  async function sendFolderToHub(button) {
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = 'Posielam do MEGA Hubu…';
    try {
      const payload = folderSnapshotForHub();
      if (connStatus !== 'online') await detectPort(true);
      if (connStatus !== 'online') throw new Error('Lokálny Nexus nie je dostupný.');
      const result = await bridgeFetch(`http://localhost:${state.port}/api/v1/mega/hub/entries`, {
        method: 'POST', anonymous: true, timeoutMs: 30000,
        headers: { 'Content-Type': 'application/json', 'X-Nexus-Mega-Hub': 'userscript',
          'X-Nexus-Token': typeof GM_getValue === 'function' ? GM_getValue('megaHubToken', '') : '' },
        body: JSON.stringify(payload),
      });
      const data = await result.json();
      if (result.status === 401) throw new Error('Nastav Nexus bridge token v menu userscriptu.');
      if (result.status === 404) throw new Error('Spusti verziu Nexusu s MEGA Hubom.');
      if (!result.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `Chyba Nexusu (${result.status})`);
      if (!data.entry) {
        const reasons = { empty: 'V priečinku sa nenašli videá.', unavailable: 'MEGA priečinok nie je dostupný.',
          open_in_mega: 'Počkaj, kým sa načíta obsah tohto MEGA priečinka, a skús znova.', retry: 'MEGA teraz neodpovedá. Skús znova.' };
        throw new Error(reasons[data.status] || 'Priečinok sa nepodarilo odoslať.');
      }
      const target = `http://127.0.0.1:${state.port}/?mega_hub=${data.entry.id}`;
      toast(`${data.status === 'exists' ? 'Už je v Hube' : 'Pridané do MEGA Hubu'} · ${data.entry.count} videí.`, false, target);
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = 'Poslať do MEGA Hubu';
    }
  }

  async function importKeyed(videos, label) {
    if (!videos.length) {
      toast('Could not read keys from the MEGA page for these items.', true);
      return;
    }
    toast(`Importing ${videos.length} video(s) via page keys → port ${state.port}…`);
    try {
      const res = await bridgeFetch(`http://localhost:${state.port}/api/v1/mega/add-keyed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: location.href, videos, title: getAlbumTitle() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `Server ${res.status}`);
      const added = data.added ?? 0;
      const skipped = data.skipped ?? 0;
      toast(`Imported ${added} new${skipped ? `, ${skipped} already in library` : ''} (${label}, page keys).`);
    } catch (err) {
      const msg = String(err.message || err);
      toast(msg.includes('Failed to fetch') ? `Dashboard offline on port ${state.port}.` : `Import failed: ${msg}`, true);
    }
  }

  function importSelected() {
    const items = selectedItems();
    // Relinked shares: dashboard preview is empty but the page holds the keys.
    if (shouldUsePageKeys()) { importKeyed(buildKeyedVideos(items), 'selected'); return; }
    if (!ensurePreviewReady()) return;
    const { refs, missing } = collectRefs(items);
    if (missing.length) toast(`${missing.length} selected item(s) had no matched ref and were skipped.`, true);
    importRefs(refs, 'selected');
  }

  function importFiltered() {
    const ctx = buildFilterContext();
    const filtered = activeItems.filter((i) => i.type !== 'folder' && passesFilters(i, ctx));
    if (shouldUsePageKeys()) { importKeyed(buildKeyedVideos(filtered), 'filtered'); return; }
    if (!ensurePreviewReady()) return;
    const { refs } = collectRefs(filtered);
    importRefs(refs, 'filtered');
  }

  function splitItems(items) {
    return items.filter(i => i.type === 'video').slice().sort((a, b) => compareItems(a, b, false)).flatMap(item => {
      const ref = keyedVideoFromHandle(item.megaHandle, rootHandleFromUrl(), 0)?.ref || refForItem(item)?.ref;
      if (!ref || !/^mega:[nf]:/.test(ref)) return [];
      const url = `http://localhost:${state.port}/api/v1/mega/stream-ref?ref=${encodeURIComponent(ref)}`;
      return [{ url, directUrl: url, watchUrl: location.href, title: item.label,
        poster: item.el.querySelector('img')?.src || '', duration: item.durationSeconds || 0,
        quality: itemQuality(item), type: 'mp4', isResolved: true,
        isSelectedOnPage: selectedKeys.has(item.key) }];
    });
  }

  function launchSplit(items) {
    if (connStatus !== 'online') { toast('Spusti Nexus dashboard a pripoj MEGA Helper cez Auto-connect.', true); return; }
    if (document.documentElement.dataset.nexusMegaSplitReady !== '1') {
      toast('Aktualizuj a zapni Nexus Universal Split-Screen na tejto stránke.', true); return;
    }
    const videos = splitItems(items);
    if (!videos.length) { toast('Vyber video s dostupným MEGA kľúčom.', true); return; }
    document.dispatchEvent(new CustomEvent('nexus-mega-split-open', { detail: JSON.stringify(videos.slice(0, 12)) }));
    if (videos.length > 12) toast(`Prehrávam prvých 12 z ${videos.length} videí.`);
  }

  function requestSidecar(items) {
    return new Promise((resolve) => {
      const requestId = `mfh-sidecar-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timeout = window.setTimeout(() => {
        window.removeEventListener('message', onResult);
        resolve({ ok: false, error: 'Sidecar bridge did not respond. Reload Sidecar and this MEGA page.' });
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
        sourcePageUrl: location.href,
        playNow: false,
      }, window.location.origin);
    });
  }

  async function sendToSidecar(items, label) {
    const videos = items.filter((item) => item && item.type !== 'folder');
    if (!videos.length) { toast('Nothing selected for Sidecar.', true); return; }
    const keyedByName = new Map(buildKeyedVideos(videos).map((video) => [normName(video.name), video]));
    const sidecarItems = videos.map((item) => {
      const preview = refForItem(item);
      const keyed = keyedByName.get(normName(item.label));
      const ref = String(preview?.ref || keyed?.ref || location.href).trim();
      return {
        url: ref,
        streamUrl: ref,
        source_url: location.href,
        title: item.label || getAlbumTitle() || 'MEGA video',
        duration: Number(item.durationSeconds || 0) || 0,
        sizeBytes: Number(item.sizeBytes || preview?.size || keyed?.size || 0) || 0,
        megaRef: ref,
      };
    });
    toast(`Sending ${sidecarItems.length} MEGA item(s) to Sidecar…`);
    const res = await requestSidecar(sidecarItems);
    if (!res?.ok) {
      toast(`Sidecar failed: ${res?.error || 'Unknown error'}`, true);
      return;
    }
    const duplicateText = res.duplicates ? `, ${res.duplicates} already queued` : '';
    toast(`Sidecar: added ${res.added || 0} / ${res.requested || sidecarItems.length}${duplicateText} (${label}).`);
  }

  // Use the in-page-key path when the dashboard is reachable but its preview
  // could not decrypt any videos (relinked share) yet the page exposes node keys.
  function shouldUsePageKeys() {
    const previewEmpty = !previewByName.size && !previewByHandle.size && !previewMeta.loading;
    if (!previewEmpty) return false;
    const root = rootHandleFromUrl();
    if (!root || !window.M?.d) return false;
    // Confirm at least one visible video item has a usable decrypted key.
    return activeItems.some((i) => i.type !== 'folder' && i.megaHandle
      && keyedVideoFromHandle(i.megaHandle, root));
  }

  function ensurePreviewReady() {
    if (previewByName.size || previewByHandle.size) return true;
    if (previewMeta.loading) { toast('Still reading folder from the dashboard, try again in a moment.', true); return false; }
    toast(`Folder not linked yet. Is the dashboard running on port ${state.port}?`, true);
    maybeFetchPreview();
    return false;
  }

  // ── Results list ──────────────────────────────────────────────────────────────
  function updateResultsList(items, noActiveFilters, hasInvalidInput) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const results = panel.querySelector('[data-role="results"]');
    if (!results) return;
    if (noActiveFilters || hasInvalidInput) { results.innerHTML = ''; currentResults = []; return; }

    currentResults = items.slice(0, 60);
    const rows = currentResults.map((item, index) => {
      const meta = [itemQuality(item) ? qualityLabel({ width: itemQuality(item), height: itemQuality(item) }) : '', item.durationSeconds ? formatDuration(item.durationSeconds) : '', item.sizeBytes ? formatBytes(item.sizeBytes) : '']
        .filter(Boolean).join(' · ');
      const selCls = selectedKeys.has(item.key) ? ' is-sel' : '';
      return `<button type="button" class="mfh-result${selCls}" data-result-index="${index}">
          <span class="mfh-tick"></span>
          <span class="mfh-result-name">${escapeHtml(item.label)}</span>
          <span class="mfh-result-meta">${escapeHtml(meta)}</span>
        </button>`;
    }).join('');
    results.innerHTML = rows || '<div class="mfh-sub">No rendered matches. Scroll the MEGA list to load more items.</div>';
  }

  function renderResultTicks() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.querySelectorAll('.mfh-result').forEach((btn) => {
      const item = currentResults[Number(btn.getAttribute('data-result-index'))];
      btn.classList.toggle('is-sel', item ? selectedKeys.has(item.key) : false);
    });
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function updateStat(total, visible, invalidDurationInput, invalidSizeInput) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const stat = panel.querySelector('[data-role="stat"]');
    if (!stat) return;
    if (invalidDurationInput && invalidSizeInput) { stat.textContent = 'Invalid duration & size. Try 12m, 01:30:00, 500MB, 1.5GB.'; return; }
    if (invalidDurationInput) { stat.textContent = 'Invalid duration. Try 12m, 720s, 01:30:00.'; return; }
    if (invalidSizeInput) { stat.textContent = 'Invalid size. Try 500MB or 1.5GB.'; return; }
    stat.textContent = `Showing ${visible} / ${total} items`;
  }

  // ── Toast ─────────────────────────────────────────────────────────────────────
  let toastEl = null;
  let toastTimer = 0;
  function toast(message, isError, hubUrl) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:2147483647;max-width:360px;' +
        'padding:11px 14px;border-radius:12px;font:13px/1.35 system-ui,sans-serif;color:#04131c;' +
        'box-shadow:0 10px 30px rgba(0,0,0,.4);transition:opacity .2s;opacity:0;';
      document.body.appendChild(toastEl);
    }
    toastEl.style.background = isError ? '#ff8a8a' : '#36d399';
    toastEl.textContent = message;
    if (hubUrl) {
      const link = document.createElement('a');
      link.href = hubUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Otvoriť MEGA Hub ↗';
      link.style.cssText = 'display:block;color:inherit;margin-top:6px;font-weight:700';
      toastEl.appendChild(link);
    }
    toastEl.style.opacity = '1';
    toastEl.style.pointerEvents = 'auto';
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastEl.style.opacity = '0';
      toastEl.style.pointerEvents = 'none';
    }, hubUrl ? 14000 : isError ? 6000 : 4000);
  }
})();
