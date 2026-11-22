(() => {
  if (window.__nxTgGallery) return;
  window.__nxTgGallery = true;

  const SHOW_ICON = 0xe9d0;
  const SELECT_ICON = 0xea1f;
  const BRIDGE_VERSION = 5;
  const ITEM = "#column-right .search-super-container-media .search-super-content-media-grid > .grid-item";
  const STORE_KEY = "nxTgGalleryState";
  const MAX_HISTORY = 40;
  const MAX_COLLECTION_ITEMS = 300;

  const host = document.createElement("div");
  host.id = "nx-tg-gallery-host";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        position: fixed;
        inset: 0;
        z-index: 3;
        pointer-events: none;
      }
      .launch, .overlay, button, input, select { font: 13px/1.3 system-ui, sans-serif; }
      .launch {
        position: fixed;
        right: 22px;
        bottom: 22px;
        z-index: 3;
        pointer-events: auto;
        border: 0;
        border-radius: 999px;
        padding: 10px 16px;
        background: #2aabee;
        color: #fff;
        cursor: pointer;
      }
      .launch[hidden] { display: none; }
      .overlay {
        position: fixed;
        inset: 0;
        z-index: 3;
        display: none;
        flex-direction: column;
        background: #0e1621;
        color: #f5f7fa;
        pointer-events: auto;
      }
      .overlay.open { display: flex; }
      header, footer, .drawer-head {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px 18px;
        background: #17212b;
      }
      header { justify-content: space-between; }
      .titles { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .name { font-size: 16px; font-weight: 650; }
      .sub, .status, .date, .size, .drawer-meta { color: #8b9aab; }
      .actions, footer { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .filters {
        display: flex;
        flex-wrap: wrap;
        gap: 10px 14px;
        align-items: end;
        padding: 8px 18px 10px;
        background: #121a24;
        border-bottom: 1px solid #242f3d;
      }
      .filter-group {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }
      .filter-group > span {
        color: #8b9aab;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .filter-row { display: flex; gap: 6px; align-items: center; }
      .filters input {
        border: 0;
        border-radius: 8px;
        padding: 7px 8px;
        background: #242f3d;
        color: #f5f7fa;
        width: 96px;
        font: inherit;
      }
      .filters input[type="date"] { width: 138px; }
      .filters input::placeholder { color: #6b7a8c; }
      .filters .filter-sep { color: #6b7a8c; font-size: 12px; }
      button, select {
        border: 0;
        border-radius: 8px;
        padding: 8px 12px;
        background: #242f3d;
        color: #f5f7fa;
        cursor: pointer;
      }
      button:disabled { opacity: 0.45; cursor: default; }
      button.active { background: #2aabee; }
      .body { flex: 1; display: flex; min-height: 0; }
      .grid {
        flex: 1;
        overflow: auto;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 14px;
        padding: 16px 18px 24px;
        align-content: start;
      }
      .drawer {
        width: 320px;
        border-left: 1px solid #242f3d;
        background: #121a24;
        display: none;
        flex-direction: column;
        min-height: 0;
      }
      .drawer.open { display: flex; }
      .drawer-head { justify-content: space-between; }
      .drawer-list { overflow: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
      .drawer-item {
        text-align: left;
        background: #1b2733;
        display: flex;
        flex-direction: column;
        gap: 4px;
        align-items: stretch;
      }
      .drawer-item strong { font-weight: 650; }
      article {
        content-visibility: auto;
        contain-intrinsic-size: auto 220px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 0;
      }
      .frame {
        position: relative;
        aspect-ratio: 16 / 9;
        background: #111a22;
        border-radius: 10px;
        overflow: hidden;
      }
      img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .time, .pick, .size-badge { position: absolute; z-index: 1; }
      .time, .size-badge {
        padding: 2px 6px;
        border-radius: 6px;
        background: rgba(0, 0, 0, 0.72);
        color: #fff;
        font-size: 12px;
      }
      .time { right: 8px; bottom: 8px; }
      .size-badge { left: 8px; bottom: 8px; }
      .pick {
        left: 8px;
        top: 8px;
        width: 40px;
        height: 40px;
        margin: 0;
        display: grid;
        place-items: center;
        border-radius: 10px;
        background: rgba(0, 0, 0, 0.55);
        cursor: pointer;
      }
      .pick input {
        width: 32px;
        height: 32px;
        margin: 0;
        accent-color: #2aabee;
        cursor: pointer;
      }
      .play {
        position: absolute;
        inset: 0;
        background: transparent;
        border-radius: 10px;
      }
      .play:hover { background: rgba(0, 0, 0, 0.28); }
      .meta { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
      .meta-left { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .card-actions { display: flex; gap: 8px; }
      .goto, .dl { background: transparent; color: #6ec1ff; padding-inline: 0; }
      footer { justify-content: space-between; }
      footer[hidden] { display: none; }
      .queue {
        display: none;
        position: absolute;
        right: 12px;
        bottom: 72px;
        width: min(34vw, 420px);
        max-height: min(42vh, 360px);
        flex-direction: column;
        gap: 8px;
        overflow: auto;
        padding: 10px 12px 12px;
        background: rgba(18, 26, 36, 0.96);
        border: 1px solid #242f3d;
        border-radius: 12px;
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
        z-index: 6;
      }
      .queue.open { display: flex; }
      .queue-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        position: sticky;
        top: 0;
        background: rgba(18, 26, 36, 0.98);
        z-index: 1;
        padding-bottom: 2px;
      }
      .queue-item {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 4px 8px;
        padding: 8px 10px;
        border-radius: 8px;
        background: #1b2733;
      }
      .queue-item .title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .queue-item .meta { color: #8b9aab; font-size: 12px; }
      .queue-item .row-actions {
        display: flex;
        flex-direction: column;
        gap: 4px;
        align-items: stretch;
      }
      .queue-item .row-actions button {
        padding: 5px 8px;
        font-size: 11px;
        white-space: nowrap;
      }
      .queue-item .row-actions [data-force] {
        background: #3a2a12;
        color: #ffcc66;
      }
      .bar {
        grid-column: 1 / -1;
        height: 4px;
        border-radius: 999px;
        background: #242f3d;
        overflow: hidden;
      }
      .bar > span {
        display: block;
        height: 100%;
        width: 0;
        background: #2aabee;
      }
      .queue-item.done .bar > span { background: #3dd68c; }
      .queue-item.error .bar > span { background: #f07178; }
      .empty {
        grid-column: 1 / -1;
        color: #8b9aab;
        padding: 40px 8px;
        text-align: center;
      }
    </style>
    <button type="button" class="launch" hidden>Galéria</button>
    <div class="overlay" role="dialog" aria-modal="true" aria-label="Galéria kanála">
      <header>
        <div class="titles">
          <div class="name"></div>
          <div class="sub"></div>
        </div>
        <div class="actions">
          <span class="status"></span>
          <select data-act="sort" title="Zoradiť">
            <option value="date:desc">Dátum ↓</option>
            <option value="date:asc">Dátum ↑</option>
            <option value="size:desc">Veľkosť ↓</option>
            <option value="size:asc">Veľkosť ↑</option>
            <option value="duration:desc">Trvanie ↓</option>
            <option value="duration:asc">Trvanie ↑</option>
          </select>
          <button type="button" data-act="history">História</button>
          <button type="button" data-act="collections">Kolekcie</button>
          <button type="button" data-act="queue">Front</button>
          <button type="button" data-act="channel" hidden>Späť do kanála</button>
          <button type="button" data-act="more">Načítať ďalšie</button>
          <button type="button" data-act="close">Zavrieť</button>
        </div>
      </header>
      <section class="filters" aria-label="Filtre výsledkov">
        <div class="filter-group">
          <span>Trvanie (min)</span>
          <div class="filter-row">
            <input data-filter="dur-min" type="number" min="0" step="1" placeholder="od" inputmode="numeric">
            <span class="filter-sep">–</span>
            <input data-filter="dur-max" type="number" min="0" step="1" placeholder="do" inputmode="numeric">
          </div>
        </div>
        <div class="filter-group">
          <span>Veľkosť (MB)</span>
          <div class="filter-row">
            <input data-filter="size-min" type="number" min="0" step="1" placeholder="od" inputmode="numeric">
            <span class="filter-sep">–</span>
            <input data-filter="size-max" type="number" min="0" step="1" placeholder="do" inputmode="numeric">
          </div>
        </div>
        <div class="filter-group">
          <span>Dátum</span>
          <div class="filter-row">
            <input data-filter="date-min" type="date" title="Od dátumu">
            <span class="filter-sep">–</span>
            <input data-filter="date-max" type="date" title="Do dátumu">
          </div>
        </div>
        <button type="button" data-act="filters-clear">Reset filtrov</button>
      </section>
      <div class="body">
        <div class="grid"></div>
        <aside class="drawer">
          <div class="drawer-head">
            <strong class="drawer-title"></strong>
            <button type="button" data-act="drawer-close">Zavrieť panel</button>
          </div>
          <div class="drawer-list"></div>
        </aside>
      </div>
      <section class="queue" aria-label="Front sťahovania">
        <div class="queue-head">
          <strong>Front sťahovania</strong>
          <div class="actions">
            <button type="button" data-act="queue-clear">Vyčistiť hotové</button>
            <button type="button" data-act="queue-hide">Skryť</button>
          </div>
        </div>
        <div class="queue-list"></div>
      </section>
      <footer hidden>
        <span class="chosen"></span>
        <div class="actions">
          <button type="button" data-act="download">Stiahnuť</button>
          <button type="button" data-act="saved">Do Saved Messages</button>
          <button type="button" data-act="hide-others">Skryť ostatné</button>
          <button type="button" data-act="show-all" hidden>Ukázať všetky</button>
          <button type="button" data-act="collect">Do kolekcie</button>
          <button type="button" data-act="goto" disabled>Ukázať v chate</button>
          <button type="button" data-act="select-all">Vybrať všetky</button>
          <button type="button" data-act="clear">Zrušiť výber</button>
        </div>
      </footer>
    </div>
  `;

  const launch = shadow.querySelector(".launch");
  const overlay = shadow.querySelector(".overlay");
  const grid = shadow.querySelector(".grid");
  const drawer = shadow.querySelector(".drawer");
  const drawerTitle = shadow.querySelector(".drawer-title");
  const drawerList = shadow.querySelector(".drawer-list");
  const nameEl = shadow.querySelector(".name");
  const subEl = shadow.querySelector(".sub");
  const statusEl = shadow.querySelector(".status");
  const footer = shadow.querySelector("footer");
  const chosenEl = shadow.querySelector(".chosen");
  const sortSelect = shadow.querySelector('[data-act="sort"]');
  const gotoBtn = shadow.querySelector('[data-act="goto"]');
  const hideBtn = shadow.querySelector('[data-act="hide-others"]');
  const showAllBtn = shadow.querySelector('[data-act="show-all"]');
  const channelBtn = shadow.querySelector('[data-act="channel"]');
  const historyBtn = shadow.querySelector('[data-act="history"]');
  const collectionsBtn = shadow.querySelector('[data-act="collections"]');
  const queueBtn = shadow.querySelector('[data-act="queue"]');
  const queuePanel = shadow.querySelector(".queue");
  const queueList = shadow.querySelector(".queue-list");
  const filterInputs = {
    durMin: shadow.querySelector('[data-filter="dur-min"]'),
    durMax: shadow.querySelector('[data-filter="dur-max"]'),
    sizeMin: shadow.querySelector('[data-filter="size-min"]'),
    sizeMax: shadow.querySelector('[data-filter="size-max"]'),
    dateMin: shadow.querySelector('[data-filter="date-min"]'),
    dateMax: shadow.querySelector('[data-filter="date-max"]'),
  };

  let renderQueued = false;
  let loadingMore = false;
  let focusMids = null;
  let downloadQueue = [];
  let viewMode = "channel";
  let activeCollectionId = null;
  let drawerMode = null;
  let sortKey = "date";
  let sortDir = "desc";
  let state = { history: [], collections: [] };
  const sizeCache = new Map();
  const pendingMeta = new Set();
  const gallerySelected = new Set();
  let reqSeq = 0;
  let bridgeReady = null;
  let filterTimer = 0;

  function pingBridge() {
    return new Promise((resolve) => {
      const requestId = `ping-${++reqSeq}`;
      const onRes = (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== "nx-tg-gallery" || data.direction !== "res") return;
        if (data.requestId !== requestId) return;
        window.removeEventListener("message", onRes);
        resolve(data.ok ? data : null);
      };
      window.addEventListener("message", onRes);
      window.postMessage({
        source: "nx-tg-gallery",
        direction: "req",
        requestId,
        type: "ping",
      }, "*");
      window.setTimeout(() => {
        window.removeEventListener("message", onRes);
        resolve(null);
      }, 500);
    });
  }

  function injectBridge(force = false) {
    return new Promise((resolve) => {
      const current = Number(document.documentElement.dataset.nxTgBridgeVersion || 0);
      if (!force && current === BRIDGE_VERSION && document.documentElement.dataset.nxTgBridgeInjected === "1") {
        resolve(true);
        return;
      }
      try {
        const script = document.createElement("script");
        script.src = `${chrome.runtime.getURL("page-bridge.js")}?v=${BRIDGE_VERSION}`;
        script.onload = () => {
          document.documentElement.dataset.nxTgBridgeInjected = "1";
          document.documentElement.dataset.nxTgBridgeVersion = String(BRIDGE_VERSION);
          resolve(true);
        };
        script.onerror = () => resolve(false);
        (document.documentElement || document.head).append(script);
      } catch (_) {
        resolve(false);
      }
    });
  }

  function ensureBridge() {
    if (bridgeReady) return bridgeReady;
    bridgeReady = (async () => {
      const ping = await pingBridge();
      if (ping && Number(ping.bridgeVersion) === BRIDGE_VERSION) return true;
      await injectBridge(true);
      const again = await pingBridge();
      return !!(again && Number(again.bridgeVersion) === BRIDGE_VERSION);
    })();
    return bridgeReady;
  }

  function items() {
    return [...document.querySelectorAll(ITEM)];
  }

  function liveItem(mid) {
    return document.querySelector(`${ITEM}[data-mid="${CSS.escape(String(mid))}"]`);
  }

  function mediaOpen() {
    return items().length > 0;
  }

  function selectionBar() {
    const bar = document.querySelector("#column-right .search-super-selection-container");
    return bar && bar.getClientRects().length ? bar : null;
  }

  function channelName() {
    const el = document.querySelector("#column-right .profile-name");
    return el ? el.textContent.replace(/\s+/g, " ").trim() : "Telegram";
  }

  function channelPeerId() {
    const item = items()[0];
    return item ? item.dataset.peerId || "" : "";
  }

  function libraryLabel() {
    const el = [...document.querySelectorAll("#column-right .i18n")].find((node) => {
      const text = (node.textContent || "").trim();
      return text.length < 40 && /video/i.test(text);
    });
    return el ? el.textContent.trim() : "";
  }

  function menuButtons() {
    const menu = document.querySelector(".btn-menu.search-contextmenu");
    if (!menu) return [];
    return [...menu.querySelectorAll(".btn-menu-item")].filter((el) => !el.classList.contains("hide"));
  }

  function openMenu(item) {
    const rect = item.getBoundingClientRect();
    item.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 2,
      clientX: Math.max(8, rect.left + 12),
      clientY: Math.max(8, rect.top + 12),
    }));
  }

  function clickMenu(icon, acceptText) {
    const button = menuButtons().find((el) => {
      const iconEl = el.querySelector(".btn-menu-item-icon");
      if (!iconEl || iconEl.textContent.codePointAt(0) !== icon) return false;
      const text = (el.querySelector(".btn-menu-item-text") || {}).textContent || "";
      return acceptText(text);
    });
    if (button) button.click();
    return !!button;
  }

  function invokeMenu(item, icon, acceptText) {
    openMenu(item);
    window.setTimeout(() => clickMenu(icon, acceptText), 40);
  }

  function toggleNative(item, want) {
    if (!item) return;
    const selected = item.classList.contains("is-selected");
    if (selected === want) return;
    if (!selectionBar()) {
      if (!want) return;
      invokeMenu(item, SELECT_ICON, (text) => !/clear|zruši/i.test(text));
      return;
    }
    item.click();
  }

  function showInChat(item) {
    if (!item) {
      statusEl.textContent = "Video nie je v aktuálnom paneli Media";
      return;
    }
    const selected = items().filter((el) => el.classList.contains("is-selected"));
    const goto = document.querySelector("#column-right .search-super-selection-goto");
    if (goto && selected.length === 1 && selected[0] === item) {
      goto.click();
      return;
    }
    invokeMenu(item, SHOW_ICON, () => true);
  }

  function play(item) {
    if (!item) {
      statusEl.textContent = "Video nie je v aktuálnom paneli Media";
      return;
    }
    const cancel = document.querySelector("#column-right .search-super-selection-cancel");
    if (cancel) cancel.click();
    window.setTimeout(() => item.click(), 70);
  }

  function formatDate(unix) {
    if (!unix) return "";
    return new Date(unix * 1000).toLocaleDateString("sk-SK", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (!n) return "";
    if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${n} B`;
  }

  function parseDuration(text) {
    const parts = String(text || "").split(":").map((part) => Number(part));
    if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
  }

  function parseFilterNumber(input) {
    const raw = String(input?.value || "").trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function parseFilterDate(input, endOfDay = false) {
    const raw = String(input?.value || "").trim();
    if (!raw) return null;
    const stamp = Date.parse(`${raw}T${endOfDay ? "23:59:59" : "00:00:00"}`);
    if (!Number.isFinite(stamp)) return null;
    return Math.floor(stamp / 1000);
  }

  function readFilters() {
    const durMinMin = parseFilterNumber(filterInputs.durMin);
    const durMaxMin = parseFilterNumber(filterInputs.durMax);
    const sizeMinMb = parseFilterNumber(filterInputs.sizeMin);
    const sizeMaxMb = parseFilterNumber(filterInputs.sizeMax);
    return {
      durMin: durMinMin == null ? null : durMinMin * 60,
      durMax: durMaxMin == null ? null : durMaxMin * 60,
      sizeMin: sizeMinMb == null ? null : sizeMinMb * 1024 * 1024,
      sizeMax: sizeMaxMb == null ? null : sizeMaxMb * 1024 * 1024,
      dateMin: parseFilterDate(filterInputs.dateMin, false),
      dateMax: parseFilterDate(filterInputs.dateMax, true),
    };
  }

  function filtersActive(f = readFilters()) {
    return Object.values(f).some((v) => v != null);
  }

  function passesFilters(metrics, f = readFilters()) {
    if (!filtersActive(f)) return true;
    const duration = Number(metrics.duration) || 0;
    const size = Number(metrics.size) || 0;
    const timestamp = Number(metrics.timestamp) || 0;

    if (f.durMin != null || f.durMax != null) {
      if (!duration) return false;
      if (f.durMin != null && duration < f.durMin) return false;
      if (f.durMax != null && duration > f.durMax) return false;
    }
    if (f.sizeMin != null || f.sizeMax != null) {
      if (!size) return false;
      if (f.sizeMin != null && size < f.sizeMin) return false;
      if (f.sizeMax != null && size > f.sizeMax) return false;
    }
    if (f.dateMin != null || f.dateMax != null) {
      if (!timestamp) return false;
      if (f.dateMin != null && timestamp < f.dateMin) return false;
      if (f.dateMax != null && timestamp > f.dateMax) return false;
    }
    return true;
  }

  function rowMetrics(row, kind) {
    if (kind === "collection") {
      return {
        duration: parseDuration(row.durationText),
        size: Number(row.size) || 0,
        timestamp: Number(row.timestamp) || 0,
      };
    }
    const meta = sizeCache.get(`${row.dataset.peerId}:${row.dataset.mid}`) || {};
    return {
      duration: meta.duration || parseDuration((row.querySelector(".video-time") || {}).textContent),
      size: Number(meta.size) || 0,
      timestamp: Number(row.dataset.timestamp) || 0,
    };
  }

  async function bridge(type, payload) {
    await ensureBridge();
    return new Promise((resolve) => {
      const requestId = `r${++reqSeq}`;
      const onRes = (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== "nx-tg-gallery" || data.direction !== "res") return;
        if (data.requestId !== requestId) return;
        window.removeEventListener("message", onRes);
        resolve(data);
      };
      window.addEventListener("message", onRes);
      window.postMessage({
        source: "nx-tg-gallery",
        direction: "req",
        requestId,
        type,
        ...(payload || {}),
      }, "*");
      window.setTimeout(() => {
        window.removeEventListener("message", onRes);
        resolve({ ok: false, error: "timeout" });
      }, type === "download" ? 20000 : type === "meta-batch" ? 8000 : 2500);
    });
  }

  async function ensureMeta(peerId, mid) {
    const key = `${peerId}:${mid}`;
    if (sizeCache.has(key)) return sizeCache.get(key);
    if (pendingMeta.has(key)) return null;
    pendingMeta.add(key);
    try {
      const res = await bridge("meta", { peerId, mid });
      if (res && res.ok && res.meta && Number(res.meta.size) > 0) {
        sizeCache.set(key, res.meta);
        return res.meta;
      }
      return null;
    } finally {
      pendingMeta.delete(key);
    }
  }

  function loadState() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([STORE_KEY], (data) => {
          const saved = data && data[STORE_KEY];
          state = {
            history: Array.isArray(saved?.history) ? saved.history : [],
            collections: Array.isArray(saved?.collections) ? saved.collections : [],
          };
          resolve(state);
        });
      } catch (_) {
        state = { history: [], collections: [] };
        resolve(state);
      }
    });
  }

  function saveState() {
    try {
      chrome.storage.local.set({ [STORE_KEY]: state });
    } catch (_) {}
  }

  function rememberChannel() {
    if (!mediaOpen()) return;
    const peerId = channelPeerId();
    const title = channelName();
    if (!peerId || !title) return;
    const href = location.href;
    state.history = [
      { id: `${peerId}:${Date.now()}`, peerId, title, href, at: Date.now(), count: items().length },
      ...state.history.filter((row) => row.peerId !== peerId),
    ].slice(0, MAX_HISTORY);
    saveState();
  }

  async function thumbDataUrl(img) {
    if (!img || !img.src) return "";
    try {
      const canvas = document.createElement("canvas");
      const w = 320;
      const h = Math.max(1, Math.round((img.naturalHeight || 180) * (w / Math.max(1, img.naturalWidth || 320))));
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      return canvas.toDataURL("image/jpeg", 0.72);
    } catch (_) {
      return "";
    }
  }

  function selectedTargets() {
    if (viewMode === "collection") {
      const col = activeCollection();
      if (!col) return [];
      return col.videos.filter((video) => gallerySelected.has(String(video.mid)));
    }
    return items()
      .filter((el) => gallerySelected.has(String(el.dataset.mid)))
      .map((el) => ({
        mid: el.dataset.mid,
        peerId: el.dataset.peerId,
        timestamp: Number(el.dataset.timestamp) || 0,
        durationText: (el.querySelector(".video-time") || {}).textContent?.trim() || "",
        size: sizeCache.get(`${el.dataset.peerId}:${el.dataset.mid}`)?.size || 0,
        fileName: sizeCache.get(`${el.dataset.peerId}:${el.dataset.mid}`)?.fileName || "",
        channel: channelName(),
        item: el,
      }));
  }

  async function snapshotSelected() {
    const picked = selectedTargets();
    const out = [];
    for (const row of picked) {
      const meta = await ensureMeta(row.peerId, row.mid);
      const live = row.item || liveItem(row.mid);
      const img = live && live.querySelector("img.media-photo");
      out.push({
        mid: row.mid,
        peerId: row.peerId,
        timestamp: row.timestamp || 0,
        durationText: row.durationText || "",
        size: meta?.size || row.size || 0,
        fileName: meta?.fileName || row.fileName || "",
        channel: row.channel || channelName(),
        thumb: row.thumb || await thumbDataUrl(img),
        savedAt: Date.now(),
      });
    }
    return out;
  }

  async function createCollection() {
    const videos = await snapshotSelected();
    if (!videos.length) return;
    const name = window.prompt("Názov kolekcie", `${channelName()} · ${videos.length}`);
    if (!name) return;
    const collection = {
      id: `c${Date.now()}`,
      name: name.trim(),
      createdAt: Date.now(),
      videos: videos.slice(0, MAX_COLLECTION_ITEMS),
    };
    state.collections = [collection, ...state.collections].slice(0, 60);
    saveState();
    statusEl.textContent = `Kolekcia „${collection.name}“`;
    openDrawer("collections");
  }

  function queueSummary(rows = downloadQueue) {
    const active = rows.filter((job) => job.status === "downloading").length;
    const waiting = rows.filter((job) => job.status === "queued").length;
    const done = rows.filter((job) => job.status === "done").length;
    const failed = rows.filter((job) => job.status === "error").length;
    return { active, waiting, done, failed };
  }

  function renderQueue(rows = downloadQueue) {
    downloadQueue = Array.isArray(rows) ? rows : [];
    const summary = queueSummary(downloadQueue);
    const busy = summary.active + summary.waiting;
    queueBtn.classList.toggle("active", queuePanel.classList.contains("open") || busy > 0);
    if (busy > 0) {
      const current = downloadQueue.find((job) => job.status === "downloading");
      statusEl.textContent = current
        ? `Sťahujem ${current.percent || 0}% · front ${summary.waiting}`
        : `Vo fronte: ${summary.waiting}`;
    } else if (summary.failed && !summary.active && !summary.waiting) {
      statusEl.textContent = `Hotovo, chyby: ${summary.failed}`;
    } else if (summary.done && !summary.active && !summary.waiting) {
      statusEl.textContent = `Stiahnuté: ${summary.done}`;
    }

    if (!queuePanel.classList.contains("open") && busy === 0 && !downloadQueue.length) {
      queueList.replaceChildren();
      return;
    }

    queueList.replaceChildren();
    if (!downloadQueue.length) {
      queueList.innerHTML = `<div class="meta">Front je prázdny.</div>`;
      return;
    }

    for (const job of downloadQueue.slice().reverse()) {
      const row = document.createElement("div");
      row.className = `queue-item ${job.status}`;
      const title = job.fileName || `${job.mid}.mp4`;
      const sizeText = job.total ? `${formatSize(job.done)} / ${formatSize(job.total)}` : formatSize(job.size);
      const stateText = job.status === "downloading"
        ? `${job.percent || 0}%`
        : job.status === "queued"
          ? "čaká"
          : job.status === "done"
            ? "hotové"
            : job.status === "cancelled"
              ? "zrušené"
              : "chyba";
      row.innerHTML = `
        <div class="title"></div>
        <div class="row-actions">
          <button type="button" data-force hidden>FORCE</button>
          <button type="button" data-cancel hidden>Zrušiť</button>
        </div>
        <div class="meta"></div>
        <div class="meta state"></div>
        <div class="bar"><span></span></div>
      `;
      row.querySelector(".title").textContent = title;
      row.querySelector(".meta").textContent = sizeText || "—";
      row.querySelector(".state").textContent = job.error ? job.error : stateText;
      row.querySelector(".bar > span").style.width = `${job.status === "done" ? 100 : (job.percent || 0)}%`;
      const cancelBtn = row.querySelector("[data-cancel]");
      const forceBtn = row.querySelector("[data-force]");
      if (job.status === "queued" || job.status === "downloading") {
        cancelBtn.hidden = false;
        cancelBtn.textContent = "Zrušiť";
        cancelBtn.onclick = () => { bridge("download-cancel", { id: job.id }); };
      }
      if (job.status === "queued") {
        forceBtn.hidden = false;
        forceBtn.textContent = "FORCE";
        forceBtn.title = "Vynútiť ďalšie paralelné sťahovanie (až 4 naraz)";
        forceBtn.onclick = () => {
          bridge("download-force", { id: job.id }).then((res) => {
            if (res && Array.isArray(res.queue)) renderQueue(res.queue);
            statusEl.textContent = res && res.ok
              ? `FORCE · paralelne ${res.maxParallel || "?"}`
              : `FORCE zlyhal${res?.error ? `: ${res.error}` : ""}`;
          });
        };
      }
      queueList.append(row);
    }
  }

  function openQueue() {
    queuePanel.classList.add("open");
    queueBtn.classList.add("active");
    renderQueue(downloadQueue);
  }

  async function enqueueDownloads(items) {
    const list = (items || []).filter((row) => row.peerId && row.mid);
    if (!list.length) {
      statusEl.textContent = "Nie je čo zaradiť do frontu";
      return;
    }
    openQueue();
    statusEl.textContent = `Zaradujem ${list.length}…`;
    const res = await bridge("download-enqueue", {
      items: list.map((row) => ({ peerId: row.peerId, mid: row.mid })),
    });
    if (res && Array.isArray(res.queue)) renderQueue(res.queue);
    if (res && res.ok) {
      statusEl.textContent = `Vo fronte: ${(res.added || 0)} nových`;
    } else {
      statusEl.textContent = `Front zlyhal${res?.error ? `: ${res.error}` : ""}`;
    }
  }

  async function downloadSelected() {
    const targets = selectedTargets().filter((row) => row.peerId && row.mid);
    await enqueueDownloads(targets);
  }

  async function downloadOneTarget(peerId, mid) {
    if (!peerId || !mid) {
      statusEl.textContent = "Chýba peer/mid na stiahnutie";
      return;
    }
    await enqueueDownloads([{ peerId, mid }]);
  }

  function syncSelectionChrome() {
    const picked = selectedTargets();
    footer.hidden = false;
    chosenEl.textContent = picked.length === 1 ? "1 video" : `${picked.length} videí`;
    gotoBtn.disabled = picked.length !== 1;
    hideBtn.hidden = picked.length === 0;
    showAllBtn.hidden = !focusMids;
    shadow.querySelector('[data-act="download"]').disabled = picked.length === 0;
    shadow.querySelector('[data-act="saved"]').disabled = picked.length === 0;
    shadow.querySelector('[data-act="collect"]').disabled = picked.length === 0;
    shadow.querySelector('[data-act="clear"]').disabled = picked.length === 0;
  }

  async function forwardSelectedToSaved() {
    const targets = selectedTargets().filter((row) => row.peerId && row.mid);
    if (!targets.length) {
      statusEl.textContent = "Nie je čo uložiť do Saved";
      return;
    }
    statusEl.textContent = `Posielam ${targets.length} do Saved…`;
    const res = await bridge("forward-saved", {
      items: targets.map((row) => ({ peerId: row.peerId, mid: row.mid })),
    });
    if (res && res.ok) {
      statusEl.textContent = `Uložené do Saved: ${res.forwarded}`;
    } else {
      statusEl.textContent = `Saved zlyhalo${res?.error ? `: ${res.error}` : ""}`;
    }
  }

  function setGallerySelected(mid, want) {
    if (want) gallerySelected.add(String(mid));
    else gallerySelected.delete(String(mid));
    // len chrome výberu — plný re-render by scrollol grid/tab
    syncSelectionChrome();
  }

  function syncCardChecks() {
    for (const card of grid.querySelectorAll("article[data-mid]")) {
      const input = card.querySelector("input[type='checkbox']");
      if (input) input.checked = gallerySelected.has(String(card.dataset.mid));
    }
  }

  function selectAllVisible() {
    const rows = viewMode === "collection" ? visibleCollectionRows() : visibleChannelRows();
    if (!rows.length) {
      statusEl.textContent = "Nič na výber";
      return;
    }
    for (const row of rows) {
      const mid = String(row.mid || row.dataset?.mid || "");
      if (mid) gallerySelected.add(mid);
    }
    syncCardChecks();
    syncSelectionChrome();
    statusEl.textContent = `Vybrané: ${gallerySelected.size}`;
  }

  function openDrawer(mode) {
    drawerMode = mode;
    drawer.classList.add("open");
    historyBtn.classList.toggle("active", mode === "history");
    collectionsBtn.classList.toggle("active", mode === "collections");
    drawerTitle.textContent = mode === "history" ? "História" : "Kolekcie";
    drawerList.replaceChildren();

    if (mode === "history") {
      if (!state.history.length) {
        drawerList.innerHTML = `<div class="drawer-meta">Zatiaľ prázdna. Otvor galériu v kanáli.</div>`;
        return;
      }
      for (const row of state.history) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "drawer-item";
        btn.innerHTML = `<strong></strong><span class="drawer-meta"></span>`;
        btn.querySelector("strong").textContent = row.title;
        btn.querySelector(".drawer-meta").textContent = new Date(row.at).toLocaleString("sk-SK");
        btn.addEventListener("click", () => {
          if (row.href) location.href = row.href;
          statusEl.textContent = "Otváram históriu…";
        });
        drawerList.append(btn);
      }
      return;
    }

    if (!state.collections.length) {
      drawerList.innerHTML = `<div class="drawer-meta">Zatiaľ žiadna kolekcia. Označ videá a stlač Do kolekcie.</div>`;
      return;
    }
    for (const col of state.collections) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "drawer-item";
      btn.innerHTML = `<strong></strong><span class="drawer-meta"></span>`;
      btn.querySelector("strong").textContent = col.name;
      btn.querySelector(".drawer-meta").textContent = `${col.videos.length} videí · ${new Date(col.createdAt).toLocaleString("sk-SK")}`;
      btn.addEventListener("click", () => {
        viewMode = "collection";
        activeCollectionId = col.id;
        focusMids = null;
        gallerySelected.clear();
        statusEl.textContent = `Kolekcia: ${col.name}`;
        scheduleRender();
      });
      drawerList.append(btn);
    }
  }

  function closeDrawer() {
    drawerMode = null;
    drawer.classList.remove("open");
    historyBtn.classList.remove("active");
    collectionsBtn.classList.remove("active");
  }

  function activeCollection() {
    return state.collections.find((col) => col.id === activeCollectionId) || null;
  }

  function sortRows(rows, kind) {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      let av = 0;
      let bv = 0;
      if (kind === "collection") {
        if (sortKey === "size") {
          av = a.size || 0;
          bv = b.size || 0;
        } else if (sortKey === "duration") {
          av = parseDuration(a.durationText);
          bv = parseDuration(b.durationText);
        } else {
          av = a.timestamp || 0;
          bv = b.timestamp || 0;
        }
      } else {
        const aMeta = sizeCache.get(`${a.dataset.peerId}:${a.dataset.mid}`) || {};
        const bMeta = sizeCache.get(`${b.dataset.peerId}:${b.dataset.mid}`) || {};
        if (sortKey === "size") {
          av = aMeta.size || 0;
          bv = bMeta.size || 0;
        } else if (sortKey === "duration") {
          av = aMeta.duration || parseDuration((a.querySelector(".video-time") || {}).textContent);
          bv = bMeta.duration || parseDuration((b.querySelector(".video-time") || {}).textContent);
        } else {
          av = Number(a.dataset.timestamp) || 0;
          bv = Number(b.dataset.timestamp) || 0;
        }
      }
      if (av === bv) return 0;
      return av > bv ? dir : -dir;
    });
  }

  function prefetchFilterMeta(rows) {
    const f = readFilters();
    if (f.sizeMin == null && f.sizeMax == null && f.durMin == null && f.durMax == null) return;
    let kicked = 0;
    for (const el of rows) {
      if (kicked >= 24) break;
      const peerId = el.dataset.peerId;
      const mid = el.dataset.mid;
      const key = `${peerId}:${mid}`;
      if (!peerId || !mid || sizeCache.has(key) || pendingMeta.has(key)) continue;
      kicked += 1;
      ensureMeta(peerId, mid).then((meta) => {
        if (meta && (meta.size || meta.duration)) scheduleRender();
      });
    }
  }

  function visibleChannelRows() {
    let rows = items();
    if (focusMids) rows = rows.filter((el) => focusMids.has(el.dataset.mid));
    const f = readFilters();
    if (f.sizeMin != null || f.sizeMax != null || f.durMin != null || f.durMax != null) {
      prefetchFilterMeta(rows);
    }
    if (filtersActive(f)) rows = rows.filter((el) => passesFilters(rowMetrics(el, "channel"), f));
    return sortRows(rows, "channel");
  }

  function visibleCollectionRows() {
    const col = activeCollection();
    if (!col) return [];
    let rows = col.videos;
    if (focusMids) rows = rows.filter((video) => focusMids.has(video.mid));
    const f = readFilters();
    if (filtersActive(f)) rows = rows.filter((video) => passesFilters(rowMetrics(video, "collection"), f));
    return sortRows(rows, "collection");
  }

  function ensureCardShell(mid) {
    let card = grid.querySelector(`article[data-mid="${CSS.escape(mid)}"]`);
    if (card) return card;
    card = document.createElement("article");
    card.dataset.mid = mid;
    card.innerHTML = `
      <div class="frame">
        <img alt="">
        <button type="button" class="play" aria-label="Prehrať"></button>
        <label class="pick"><input type="checkbox" aria-label="Vybrať"></label>
        <span class="size-badge"></span>
        <span class="time"></span>
      </div>
      <div class="meta">
        <div class="meta-left">
          <span class="date"></span>
          <span class="size"></span>
        </div>
        <div class="card-actions">
          <button type="button" class="dl">Stiahnuť</button>
          <button type="button" class="goto">V chate</button>
        </div>
      </div>
    `;
    grid.append(card);
    return card;
  }

  function bindCard(card) {
    const playBtn = card.querySelector(".play");
    const gotoBtnCard = card.querySelector(".goto");
    const dlBtn = card.querySelector(".dl");
    const pick = card.querySelector("input");

    playBtn.onclick = () => {
      const live = liveItem(card.dataset.mid) || card._nxItem;
      play(live);
    };
    gotoBtnCard.onclick = () => {
      const live = liveItem(card.dataset.mid) || card._nxItem;
      showInChat(live);
    };
    dlBtn.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const peerId = card.dataset.peerId || card._nxVideo?.peerId || channelPeerId();
      downloadOneTarget(peerId, card.dataset.mid);
    };
    const pickLabel = card.querySelector(".pick");
    // preventDefault na mousedown zabráni focus scroll jumpu stránky/gridu
    pickLabel.onmousedown = (event) => { event.preventDefault(); };
    pick.onmousedown = (event) => { event.preventDefault(); };
    pick.onchange = () => {
      setGallerySelected(card.dataset.mid, pick.checked);
    };
  }

  function renderCollectionCards(videos) {
    const seen = new Set();
    for (const video of videos) {
      seen.add(video.mid);
      const card = ensureCardShell(video.mid);
      card.dataset.peerId = video.peerId || "";
      card._nxVideo = video;
      card._nxItem = liveItem(video.mid);
      bindCard(card);
      const photo = card.querySelector("img");
      if (video.thumb && photo.getAttribute("src") !== video.thumb) photo.src = video.thumb;
      card.querySelector(".time").textContent = video.durationText || "";
      card.querySelector(".date").textContent = `${video.channel || ""} · ${formatDate(video.timestamp)}`.trim();
      const sizeText = formatSize(video.size);
      card.querySelector(".size").textContent = sizeText;
      card.querySelector(".size-badge").textContent = sizeText;
      card.querySelector("input").checked = gallerySelected.has(String(video.mid));
      grid.append(card);
    }
    for (const card of [...grid.querySelectorAll("article")]) {
      if (!seen.has(String(card.dataset.mid))) card.remove();
    }
  }

  function renderChannelCards(rows) {
    const seen = new Set();
    const missing = [];
    for (const item of rows) {
      const mid = item.dataset.mid;
      const peerId = item.dataset.peerId;
      if (!mid) continue;
      seen.add(mid);
      const card = ensureCardShell(mid);
      card.dataset.peerId = peerId || "";
      card._nxItem = item;
      bindCard(card);
      const img = item.querySelector("img.media-photo");
      const photo = card.querySelector("img");
      const src = img ? (img.currentSrc || img.src) : "";
      if (src && photo.getAttribute("src") !== src) photo.src = src;
      card.querySelector(".time").textContent = (item.querySelector(".video-time") || {}).textContent?.trim() || "";
      card.querySelector(".date").textContent = formatDate(Number(item.dataset.timestamp) || 0);
      card.querySelector("input").checked = gallerySelected.has(String(mid));

      const key = `${peerId}:${mid}`;
      const meta = sizeCache.get(key);
      const sizeText = formatSize(meta?.size);
      card.querySelector(".size").textContent = sizeText || (pendingMeta.has(key) ? "…" : "");
      card.querySelector(".size-badge").textContent = sizeText || "";
      if (!meta && !pendingMeta.has(key)) missing.push({ peerId, mid, key });
      grid.append(card);
    }

    for (const card of [...grid.querySelectorAll("article")]) {
      if (!seen.has(card.dataset.mid)) card.remove();
    }

    missing.slice(0, 12).forEach((row) => {
      ensureMeta(row.peerId, row.mid).then((meta) => {
        if (meta && meta.size) scheduleRender();
      });
    });
  }

  function render() {
    renderQueued = false;
    try {
      const open = overlay.classList.contains("open");
      launch.hidden = open || !mediaOpen();
      if (!open) return;

      channelBtn.hidden = viewMode !== "collection";
      sortSelect.value = `${sortKey}:${sortDir}`;

      const filtering = filtersActive();
      if (viewMode === "collection") {
        const col = activeCollection();
        const rows = visibleCollectionRows();
        nameEl.textContent = col ? col.name : "Kolekcia";
        subEl.textContent = col
          ? `${rows.length} videí v kolekcii${focusMids ? " · výber" : ""}${filtering ? " · filtre" : ""}`
          : "Kolekcia neexistuje";
        if (!col) grid.innerHTML = `<div class="empty">Táto kolekcia už nie je uložená.</div>`;
        else if (!rows.length) {
          grid.innerHTML = `<div class="empty">${filtering ? "Žiadne videá podľa filtrov." : "Kolekcia je prázdna."}</div>`;
        } else renderCollectionCards(rows);
      } else {
        const rows = visibleChannelRows();
        nameEl.textContent = channelName() || "Telegram";
        const library = libraryLabel();
        const loaded = items().length;
        const base = focusMids
          ? `${rows.length} vybraných · skryté ostatné`
          : library
            ? `${loaded} načítaných · ${library}`
            : `${loaded} načítaných`;
        subEl.textContent = filtering ? `${rows.length} po filtroch · ${base}` : base;
        if (!rows.length) {
          grid.innerHTML = `<div class="empty">${
            filtering
              ? "Žiadne videá podľa filtrov. Skús Reset alebo načítaj ďalšie."
              : focusMids
                ? "Žiadne vybrané videá v paneli."
                : "V paneli Media zatiaľ nie sú videá."
          }</div>`;
        } else {
          renderChannelCards(rows);
        }
      }

      syncSelectionChrome();
    } catch (error) {
      statusEl.textContent = `Chyba galérie: ${String(error.message || error).slice(0, 80)}`;
    }
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    window.requestAnimationFrame(() => {
      const top = grid.scrollTop;
      render();
      grid.scrollTop = top;
    });
  }

  function openGallery() {
    viewMode = "channel";
    activeCollectionId = null;
    overlay.classList.add("open");
    launch.hidden = true;
    try {
      rememberChannel();
    } catch (_) {}
    renderQueued = false;
    render();
  }

  function closeGallery() {
    // len skryje UI — front v page-bridge beží ďalej na Telegram stránke
    overlay.classList.remove("open");
    queuePanel.classList.remove("open");
    closeDrawer();
    scheduleRender();
  }

  async function loadMore() {
    if (loadingMore || viewMode === "collection") return;
    const scroller = document.querySelector("#column-right .sidebar-content .scrollable.scrollable-y");
    if (!scroller) return;
    loadingMore = true;
    statusEl.textContent = "Načítavam…";
    const before = items().length;
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    let after = before;
    for (let step = 0; step < 8 && after === before; step += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      after = items().length;
    }
    loadingMore = false;
    statusEl.textContent = after > before ? `+${after - before}` : "Nič ďalšie v tomto posune";
    scheduleRender();
  }

  launch.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openGallery();
  });
  host.addEventListener("nx-tg-open", openGallery);
  host.addEventListener("nx-tg-download", (event) => {
    const detail = event.detail || {};
    if (detail.multi) downloadSelected();
    else downloadOneTarget(detail.peerId, detail.mid);
  });
  shadow.querySelector('[data-act="close"]').addEventListener("click", closeGallery);
  shadow.querySelector('[data-act="more"]').addEventListener("click", () => { loadMore(); });
  shadow.querySelector('[data-act="select-all"]').addEventListener("click", () => { selectAllVisible(); });
  shadow.querySelector('[data-act="clear"]').addEventListener("click", () => {
    gallerySelected.clear();
    const cancel = document.querySelector("#column-right .search-super-selection-cancel");
    if (cancel) cancel.click();
    syncCardChecks();
    syncSelectionChrome();
  });
  shadow.querySelector('[data-act="download"]').addEventListener("click", () => { downloadSelected(); });
  shadow.querySelector('[data-act="saved"]').addEventListener("click", () => { forwardSelectedToSaved(); });
  queueBtn.addEventListener("click", () => {
    if (queuePanel.classList.contains("open")) {
      queuePanel.classList.remove("open");
      queueBtn.classList.remove("active");
    } else {
      openQueue();
      bridge("download-queue-get").then((res) => {
        if (res && res.queue) renderQueue(res.queue);
      });
    }
  });
  shadow.querySelector('[data-act="queue-hide"]').addEventListener("click", () => {
    queuePanel.classList.remove("open");
    queueBtn.classList.remove("active");
  });
  shadow.querySelector('[data-act="queue-clear"]').addEventListener("click", () => {
    bridge("download-clear-finished").then((res) => {
      if (res && res.queue) renderQueue(res.queue);
    });
  });
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "nx-tg-gallery" || data.direction !== "queue") return;
    if (!queuePanel.classList.contains("open")) queuePanel.classList.add("open");
    renderQueue(data.queue || []);
  });
  shadow.querySelector('[data-act="hide-others"]').addEventListener("click", () => {
    const picked = selectedTargets();
    if (!picked.length) return;
    focusMids = new Set(picked.map((row) => row.mid));
    statusEl.textContent = "Zobrazené len označené";
    scheduleRender();
  });
  shadow.querySelector('[data-act="show-all"]').addEventListener("click", () => {
    focusMids = null;
    statusEl.textContent = "";
    scheduleRender();
  });
  shadow.querySelector('[data-act="collect"]').addEventListener("click", () => { createCollection(); });
  shadow.querySelector('[data-act="drawer-close"]').addEventListener("click", closeDrawer);
  channelBtn.addEventListener("click", () => {
    viewMode = "channel";
    activeCollectionId = null;
    focusMids = null;
    statusEl.textContent = "";
    scheduleRender();
  });
  historyBtn.addEventListener("click", () => openDrawer("history"));
  collectionsBtn.addEventListener("click", () => openDrawer("collections"));
  sortSelect.addEventListener("change", () => {
    const [key, dir] = String(sortSelect.value || "date:desc").split(":");
    sortKey = key || "date";
    sortDir = dir || "desc";
    scheduleRender();
  });
  const onFilterInput = () => {
    window.clearTimeout(filterTimer);
    filterTimer = window.setTimeout(() => scheduleRender(), 180);
  };
  Object.values(filterInputs).forEach((input) => {
    input.addEventListener("input", onFilterInput);
    input.addEventListener("change", onFilterInput);
  });
  shadow.querySelector('[data-act="filters-clear"]').addEventListener("click", () => {
    Object.values(filterInputs).forEach((input) => { input.value = ""; });
    scheduleRender();
  });
  gotoBtn.addEventListener("click", () => {
    const [row] = selectedTargets();
    if (!row) return;
    showInChat(row.item || liveItem(row.mid));
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && overlay.classList.contains("open")) {
      if (drawer.classList.contains("open")) closeDrawer();
      else closeGallery();
    }
  });

  let observerTimer = 0;
  const observer = new MutationObserver(() => {
    window.clearTimeout(observerTimer);
    observerTimer = window.setTimeout(scheduleRender, 80);
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "data-mid"],
  });

  document.documentElement.append(host);
  loadState().then(scheduleRender);
})();
