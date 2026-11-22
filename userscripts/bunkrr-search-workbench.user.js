// ==UserScript==
// @name         Bunkrr Search Workbench for Nexus
// @namespace    local.nexus.bunkrr-search-workbench
// @version      1.4.2
// @description  Turns Findr/Bunkrr search results into a selectable, deep-fetchable video workbench with local Nexus playback and import.
// @match        https://bunkrr.pics/search*
// @match        https://*.bunkrr.pics/search*
// @match        https://findr.to/search*
// @match        https://*.findr.to/search*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

/*
 * Findr/Bunkrr Search Workbench
 *
 * This script deliberately starts from the first-party search-card source URLs.
 * It never guesses media URLs in the browser: album/file expansion, deep metadata,
 * playback resolution and imports are delegated to the local Nexus API.
 */
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

  const LOCAL = 'http://localhost:8000';
  const SEARCH_LABEL = location.hostname === 'findr.to' || location.hostname.endsWith('.findr.to') ? 'Findr' : 'Bunkrr';
  const ALBUM_LINK_SELECTOR = 'a[href^="/albums/"]';
  const state = {
    albums: new Map(),
    albumStats: new Map(),
    files: [],
    selectedAlbums: new Set(),
    selectedFiles: new Set(),
    query: '',
    queryDraft: '',
    sort: 'date',
    filters: { minHeight: 0, minDuration: 0, minSizeMb: 0, minQuality: 0 },
    filtersDraft: { minHeight: 0, minDuration: 0, minSizeMb: 0, minQuality: 0 },
    fetching: false,
    deep: { active: false, done: 0, total: 0, ok: 0, failed: 0, running: 0, startedAt: 0 },
  };
  const gmRequest = typeof GM_xmlhttpRequest === 'function'
    ? GM_xmlhttpRequest
    : (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function' ? GM.xmlHttpRequest.bind(GM) : null);

  function request(path, options = {}) {
    const url = path.startsWith('http') ? path : `${LOCAL}${path}`;
    if (!gmRequest) return fetch(url, options).then(async (response) => ({
      ok: response.ok, status: response.status, text: await response.text(),
    }));
    return new Promise((resolve, reject) => gmRequest({
      method: options.method || 'GET', url, data: options.body || undefined,
      headers: options.headers || {}, timeout: options.timeout || 45000,
      onload: (response) => resolve({ ok: response.status >= 200 && response.status < 300, status: response.status, text: response.responseText || '' }),
      onerror: () => reject(new Error('Nexus is unreachable')),
      ontimeout: () => reject(new Error('Nexus request timed out')),
    }));
  }

  // NDJSON streams from /refetch-meta. Prefer fetch for live chunks; fall back
  // to Tampermonkey progress callbacks when the page origin blocks CORS.
  async function streamNdjson(path, options = {}, onEvent) {
    const url = path.startsWith('http') ? path : `${LOCAL}${path}`;
    const feed = (buffer) => {
      const lines = buffer.split('\n');
      const rest = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { onEvent(JSON.parse(trimmed)); } catch (_) { /* ignore partial JSON */ }
      }
      return rest;
    };

    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body || undefined,
      });
      if (!response.ok) throw new Error(`Nexus returned HTTP ${response.status}`);
      if (!response.body || !response.body.getReader) {
        feed(`${await response.text()}\n`);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer = feed(buffer + decoder.decode(value, { stream: true }));
      }
      if (buffer.trim()) feed(`${buffer}\n`);
      return;
    } catch (corsError) {
      if (!gmRequest) throw corsError;
    }

    await new Promise((resolve, reject) => {
      let seen = 0;
      let buffer = '';
      gmRequest({
        method: options.method || 'GET',
        url,
        data: options.body || undefined,
        headers: options.headers || {},
        timeout: options.timeout || 300000,
        onprogress: (response) => {
          const text = response.responseText || '';
          if (text.length <= seen) return;
          buffer = feed(buffer + text.slice(seen));
          seen = text.length;
        },
        onload: (response) => {
          const text = response.responseText || '';
          if (text.length > seen) buffer = feed(buffer + text.slice(seen));
          if (buffer.trim()) feed(`${buffer}\n`);
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`Nexus returned HTTP ${response.status}`));
            return;
          }
          resolve();
        },
        onerror: () => reject(new Error('Nexus is unreachable')),
        ontimeout: () => reject(new Error('Nexus request timed out')),
      });
    });
  }

  async function json(path, options) {
    const response = await request(path, options);
    let data = {};
    try { data = JSON.parse(response.text || '{}'); } catch (_) { /* shown below */ }
    if (!response.ok) throw new Error(data.detail || data.error || `Nexus returned HTTP ${response.status}`);
    return data;
  }

  const fileKey = (file) => file.url || file.source_url || '';
  const bytes = (file) => Number(file.size_bytes || file.size_raw || 0) || 0;
  const formatBytes = (value) => {
    const n = Number(value || 0);
    if (!n) return 'veľkosť n/a';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const unit = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / (1024 ** unit)).toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
  };
  const duration = (value) => {
    const seconds = Math.max(0, Number(value || 0));
    if (!seconds) return 'dĺžka n/a';
    return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  };
  const dateValue = (file) => Date.parse(file.created_at || file.upload_date || file.updated_at || file.date || '') || 0;
  const qualityHeight = (file) => {
    const direct = Number(file.height || 0);
    if (direct) return direct;
    const quality = String(file.quality || '').toLowerCase();
    if (/4k|2160/.test(quality)) return 2160;
    if (/1440/.test(quality)) return 1440;
    if (/fhd|1080/.test(quality)) return 1080;
    if (/(^|[^a-z])hd([^a-z]|$)|720/.test(quality)) return 720;
    if (/sd|480/.test(quality)) return 480;
    return 0;
  };
  const qualityLabel = (file) => {
    const raw = String(file.quality || '').trim();
    if (raw) return raw.toUpperCase() === 'FHD' ? '1080p' : raw;
    const h = Number(file.height || 0);
    if (h >= 2160) return '4K';
    if (h >= 1440) return '1440p';
    if (h >= 1080) return '1080p';
    if (h >= 720) return '720p';
    if (h > 0) return `${h}p`;
    return '';
  };
  const qualityTier = (file) => {
    const h = qualityHeight(file);
    if (h >= 2160) return 'q4k';
    if (h >= 1440) return 'q1440';
    if (h >= 1080) return 'qfhd';
    if (h >= 720) return 'qhd';
    if (h > 0) return 'qsd';
    return 'qna';
  };

  function showToast(message, error = false) {
    let toast = document.getElementById('bsw-toast');
    if (!toast) {
      toast = document.createElement('div'); toast.id = 'bsw-toast'; document.body.append(toast);
    }
    toast.textContent = message; toast.dataset.error = error ? 'true' : 'false'; toast.classList.add('is-visible');
    clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('is-visible'), 4200);
  }

  function albumCards() {
    // Do not use `.group:has(...)` here.  On a long Next/React search page it
    // forces Chrome to re-evaluate every group on every lazy-render mutation.
    // Starting from the few stable album links is linear and keeps the page
    // responsive while Bunkrr streams thumbnails and result cards into the DOM.
    const seen = new Set();
    return [...document.querySelectorAll(ALBUM_LINK_SELECTOR)].map((detail) => {
      const card = detail.closest('.group');
      if (!card || seen.has(card)) return null;
      seen.add(card);
      const title = card.querySelector('h3')?.textContent?.trim() || 'Bunkrr album';
      const source = [...card.querySelectorAll('a[href]')].find((link) => /bunkr(?:r)?\.[a-z]+\/a\//i.test(link.href));
      return source ? { card, title, sourceUrl: source.href, detailUrl: detail?.href || '' } : null;
    }).filter(Boolean);
  }

  function syncSearchCards() {
    const albums = albumCards();
    albums.forEach((album) => {
      album.card.classList.add('bsw-source-card');
      let control = album.card.querySelector('.bsw-source-select');
      if (!control) {
        control = document.createElement('label'); control.className = 'bsw-source-select';
        control.innerHTML = '<input type="checkbox"><span>Pridať do fetchu</span>';
        control.querySelector('input').addEventListener('click', (event) => event.stopPropagation());
        control.querySelector('input').addEventListener('change', (event) => {
          if (event.currentTarget.checked) state.selectedAlbums.add(album.sourceUrl);
          else state.selectedAlbums.delete(album.sourceUrl);
          updateToolbar();
        });
        album.card.append(control);
      }
      control.querySelector('input').checked = state.selectedAlbums.has(album.sourceUrl);
    });
    return albums;
  }

  function updateToolbar() {
    const count = state.selectedAlbums.size;
    const badge = document.querySelector('#bsw-toolbar [data-count]');
    if (badge) badge.textContent = count ? `${count} album${count === 1 ? '' : 'ov'} vybraných` : 'Vyber albumy';
    const fetchButton = document.querySelector('#bsw-fetch');
    if (fetchButton) fetchButton.disabled = !count || state.fetching;
    const openButton = document.querySelector('#bsw-open');
    if (openButton) openButton.disabled = !state.files.length;
  }

  function setAlbumSelection(selected) {
    const albums = syncSearchCards();
    state.selectedAlbums = new Set(selected ? albums.map((album) => album.sourceUrl) : []);
    syncSearchCards(); updateToolbar();
  }

  async function fetchSelectedAlbums() {
    if (state.fetching || !state.selectedAlbums.size) return;
    state.fetching = true; updateToolbar();
    const selected = [...state.selectedAlbums]; const records = [];
    let complete = 0;
    showToast(`Rýchlo indexujem ${selected.length} albumov do spoločného gridu…`);
    try {
      // Four listings travel in parallel. This deliberately requests only the
      // base list — media probes belong to the explicit Deep fetch action.
      const indexOneAlbum = async (albumUrl) => {
        const result = await json(`/api/v1/discovery-hub/album-files-index?url=${encodeURIComponent(albumUrl)}`);
        const albumTitle = albumCards().find((album) => album.sourceUrl === albumUrl)?.title || 'Bunkrr album';
        const sourceItems = result.items || [];
        const videos = sourceItems.filter((file) => file.type === 'video' || /\.(mp4|mkv|webm|mov|m4v)(?:$|[?#])/i.test(file.url || ''));
        state.albumStats.set(albumUrl, { total: Number(result.total || sourceItems.length), videos: videos.length, title: albumTitle });
        videos.forEach((file) => {
          records.push({ ...file, albumUrl, albumTitle, _fetchedAt: Date.now() });
        });
        complete += 1;
        showToast(`Index ${complete}/${selected.length}: ${records.length} videí v spoločnom gride`);
      };
      for (let start = 0; start < selected.length; start += 4) {
        await Promise.all(selected.slice(start, start + 4).map(indexOneAlbum));
      }
      state.files = [...new Map(records.map((file) => [fileKey(file), file])).values()];
      state.selectedFiles.clear();
      state.query = '';
      state.queryDraft = '';
      state.filters = { minHeight: 0, minDuration: 0, minSizeMb: 0, minQuality: 0 };
      state.filtersDraft = { ...state.filters };
      openWorkspace();
      showToast(`Pripravený nový grid: ${state.files.length} videí.`);
    } catch (error) {
      showToast(_t(`Fetch zlyhal: ${error.message || error}`, `Fetch failed: ${error.message || error}`), true);
    } finally { state.fetching = false; updateToolbar(); }
  }

  function visibleFiles() {
    const terms = state.query.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().split(/\s+/).filter(Boolean);
    const filters = state.filters;
    const filtered = state.files.filter((file) => {
      const matchesQuery = terms.every((term) => `${file.title || ''} ${file.albumTitle || ''} ${file.filename || ''}`.toLowerCase().includes(term));
      if (!matchesQuery) return false;
      if (filters.minHeight && Number(file.height || 0) < filters.minHeight) return false;
      if (filters.minDuration && Number(file.duration || 0) < filters.minDuration) return false;
      if (filters.minSizeMb && bytes(file) < filters.minSizeMb * 1024 * 1024) return false;
      return !filters.minQuality || qualityHeight(file) >= filters.minQuality;
    });
    return filtered.sort((left, right) => {
      if (state.sort === 'size') return bytes(right) - bytes(left);
      if (state.sort === 'duration') return Number(right.duration || 0) - Number(left.duration || 0);
      if (state.sort === 'name') return String(left.title || '').localeCompare(String(right.title || ''));
      return dateValue(right) - dateValue(left);
    });
  }

  function applyWorkspaceFilters() {
    state.query = state.queryDraft;
    state.filters = { ...state.filtersDraft };
    renderWorkspace();
  }

  function clearWorkspaceFilters() {
    state.query = '';
    state.queryDraft = '';
    state.filters = { minHeight: 0, minDuration: 0, minSizeMb: 0, minQuality: 0 };
    state.filtersDraft = { ...state.filters };
    renderWorkspace();
  }

  function activeFilterCount() {
    const filters = state.filters;
    return [filters.minHeight, filters.minDuration, filters.minSizeMb, filters.minQuality]
      .filter((value) => Number(value) > 0).length + (state.query.trim() ? 1 : 0);
  }

  function openWorkspace() {
    let dialog = document.getElementById('bsw-workspace');
    if (!dialog) {
      dialog = document.createElement('section'); dialog.id = 'bsw-workspace'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
      document.body.append(dialog);
    }
    dialog.hidden = false; renderWorkspace();
  }

  function closeWorkspace() { const dialog = document.getElementById('bsw-workspace'); if (dialog) dialog.hidden = true; }

  function deepProgressHtml() {
    const deep = state.deep;
    if (!deep.active && !deep.done) return '';
    const total = Math.max(1, deep.total || 0);
    const done = Math.min(deep.done, total);
    const left = Math.max(0, total - done);
    const pct = Math.round((done / total) * 100);
    const elapsed = deep.startedAt ? Math.max(1, (Date.now() - deep.startedAt) / 1000) : 1;
    const rate = done / elapsed;
    const eta = left > 0 && rate > 0 ? Math.ceil(left / rate) : 0;
    const etaText = !deep.active ? 'hotovo' : (eta > 0 ? `~${eta}s do konca` : 'odhadujem…');
    return `<div class="bsw-deep"${deep.active ? '' : ' data-done="true"'}>
      <div class="bsw-deep-row">
        <strong>${deep.active ? 'Deep fetch beží' : 'Deep fetch hotový'}</strong>
        <span>${done} / ${total} videí · ${pct}%</span>
      </div>
      <div class="bsw-deep-track"><div class="bsw-deep-fill" style="width:${pct}%"></div></div>
      <div class="bsw-deep-row bsw-deep-sub">
        <span>zostáva ${left}${deep.running ? ` · ${deep.running} práve beží` : ''}</span>
        <span>OK ${deep.ok} · ${_t('zlyhalo', 'failed')} ${deep.failed} · ${etaText}</span>
      </div>
    </div>`;
  }

  function paintDeepProgress() {
    const dialog = document.getElementById('bsw-workspace');
    if (!dialog || dialog.hidden) return;
    let bar = dialog.querySelector('[data-role="deep-progress"]');
    if (!bar) {
      bar = document.createElement('div');
      bar.dataset.role = 'deep-progress';
      const anchor = dialog.querySelector('.bsw-selection');
      if (anchor) dialog.insertBefore(bar, anchor);
      else dialog.append(bar);
    }
    bar.innerHTML = deepProgressHtml();
    const button = dialog.querySelector('[data-action="deep"]');
    if (button) {
      if (state.deep.active) {
        button.disabled = true;
        button.textContent = `Deep fetch… ${state.deep.done}/${state.deep.total || '?'}`;
      } else if (!state.selectedFiles.size) {
        button.disabled = true;
        button.textContent = 'Deep fetch (0)';
      } else {
        button.disabled = false;
        button.textContent = `Deep fetch (${state.selectedFiles.size})`;
      }
    }
  }

  function renderWorkspace() {
    const dialog = document.getElementById('bsw-workspace'); if (!dialog) return;
    const files = visibleFiles(); const allSelected = files.length > 0 && files.every((file) => state.selectedFiles.has(fileKey(file)));
    const sourceFileCount = [...state.albumStats.values()].reduce((total, stat) => total + stat.total, 0);
    const deepBusy = state.deep.active;
    const draft = state.filtersDraft;
    const activeFilters = activeFilterCount();
    dialog.innerHTML = `
      <div class="bsw-head"><div><span class="bsw-kicker">${SEARCH_LABEL} / Nexus workbench</span><h2>Fetched video gallery</h2><p>${state.files.length} videí z ${sourceFileCount} súborov v ${state.selectedAlbums.size} albumoch · ${files.length} vo filtrovanom pohľade${activeFilters ? ` · aktívne filtre: ${activeFilters}` : ''}</p></div><button class="bsw-icon" data-action="close" aria-label="Zavrieť workspace">×</button></div>
      <div class="bsw-tools">
        <input type="search" data-role="query" placeholder="Hľadať názov, album alebo súbor…" value="${escapeHtml(state.queryDraft)}">
        <button data-action="search">Hľadať</button>
        <select data-role="sort" aria-label="Zoradenie videí"><option value="date">Najnovšie</option><option value="size">Najväčšie</option><option value="duration">Najdlhšie</option><option value="name">Názov A–Z</option></select>
        <button data-action="select">${allSelected ? 'Zrušiť výber' : `Vybrať všetko (${files.length})`}</button>
        <button data-action="invert">Invertovať výber</button>
        <button data-action="deep" ${state.selectedFiles.size && !deepBusy ? '' : 'disabled'}>${deepBusy ? `Deep fetch… ${state.deep.done}/${state.deep.total || '?'}` : `Deep fetch (${state.selectedFiles.size})`}</button>
        <button data-action="import" ${state.selectedFiles.size ? '' : 'disabled'}>Import vybraných</button>
        <button data-action="import-all" ${files.length ? '' : 'disabled'}>Import všetkých</button>
      </div>
      <fieldset class="bsw-filters">
        <legend>Filtre (až po Hľadať / Enter)</legend>
        <label>Kvalita / rozlíšenie
          <select data-draft="minHeight">
            <option value="0">bez minima</option>
            <option value="480">480p+</option>
            <option value="720">720p HD+</option>
            <option value="1080">1080p FHD+</option>
            <option value="1440">1440p+</option>
            <option value="2160">4K+</option>
          </select>
        </label>
        <label>Min. dĺžka (min)
          <input data-draft="minDuration" type="number" min="0" step="1" value="${draft.minDuration ? Math.floor(draft.minDuration / 60) : ''}" placeholder="napr. 20">
        </label>
        <label>Min. veľkosť (MB)
          <input data-draft="minSizeMb" type="number" min="0" step="50" value="${draft.minSizeMb || ''}" placeholder="napr. 800">
        </label>
        <label>Min. kvalita (podľa badge)
          <select data-draft="minQuality">
            <option value="0">bez minima</option>
            <option value="480">SD+</option>
            <option value="720">HD+</option>
            <option value="1080">FHD+</option>
            <option value="2160">4K</option>
          </select>
        </label>
        <div class="bsw-filter-actions">
          <button type="button" data-action="apply-filters">Použiť filtre</button>
          <button type="button" data-action="clear-filters">Vyčistiť</button>
          <span class="bsw-filter-note">Text aj filtre sa aplikujú až po Enter / Hľadať / Použiť filtre. Karty bez meta (Deep fetch) pri minime vypadnú.</span>
        </div>
      </fieldset>
      <div data-role="deep-progress">${deepProgressHtml()}</div>
      <div class="bsw-selection">Vybraných: <strong>${state.selectedFiles.size}</strong> · ${formatBytes([...state.selectedFiles].reduce((sum, key) => sum + bytes(state.files.find((file) => fileKey(file) === key)), 0))}</div>
      <div class="bsw-grid">${files.length ? files.map(renderFile).join('') : '<div class="bsw-empty">Nenašli sa žiadne videá. Uprav hľadanie/filtre a stlač Hľadať / Použiť filtre.</div>'}</div>`;
    dialog.querySelector('[data-role="sort"]').value = state.sort;
    dialog.querySelector('[data-draft="minHeight"]').value = String(draft.minHeight || 0);
    dialog.querySelector('[data-draft="minQuality"]').value = String(draft.minQuality || 0);
    const queryInput = dialog.querySelector('[data-role="query"]');
    queryInput.addEventListener('input', (event) => { state.queryDraft = event.currentTarget.value; });
    queryInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); applyWorkspaceFilters(); }
    });
    dialog.querySelector('[data-action="search"]').addEventListener('click', applyWorkspaceFilters);
    dialog.querySelector('[data-action="apply-filters"]').addEventListener('click', applyWorkspaceFilters);
    dialog.querySelector('[data-action="clear-filters"]').addEventListener('click', clearWorkspaceFilters);
    dialog.querySelector('[data-role="sort"]').addEventListener('change', (event) => { state.sort = event.currentTarget.value; renderWorkspace(); });
    dialog.querySelectorAll('[data-draft]').forEach((control) => {
      const syncDraft = (event) => {
        const key = event.currentTarget.dataset.draft;
        const value = Math.max(0, Number(event.currentTarget.value || 0));
        state.filtersDraft[key] = key === 'minDuration' ? value * 60 : value;
      };
      control.addEventListener('input', syncDraft);
      control.addEventListener('change', syncDraft);
      control.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); syncDraft(event); applyWorkspaceFilters(); }
      });
    });
    dialog.querySelectorAll('[data-select-file]').forEach((input) => input.addEventListener('change', (event) => {
      const key = event.currentTarget.dataset.selectFile; if (event.currentTarget.checked) state.selectedFiles.add(key); else state.selectedFiles.delete(key); renderWorkspace();
    }));
    dialog.querySelectorAll('[data-play]').forEach((button) => button.addEventListener('click', () => playFile(button.dataset.play)));
    dialog.querySelector('[data-action="close"]').addEventListener('click', closeWorkspace);
    dialog.querySelector('[data-action="select"]').addEventListener('click', () => { files.forEach((file) => allSelected ? state.selectedFiles.delete(fileKey(file)) : state.selectedFiles.add(fileKey(file))); renderWorkspace(); });
    dialog.querySelector('[data-action="invert"]').addEventListener('click', () => { files.forEach((file) => state.selectedFiles.has(fileKey(file)) ? state.selectedFiles.delete(fileKey(file)) : state.selectedFiles.add(fileKey(file))); renderWorkspace(); });
    dialog.querySelector('[data-action="deep"]').addEventListener('click', deepFetch);
    dialog.querySelector('[data-action="import"]').addEventListener('click', () => importFiles(files.filter((file) => state.selectedFiles.has(fileKey(file)))));
    dialog.querySelector('[data-action="import-all"]').addEventListener('click', () => importFiles(files));
  }

  function renderFile(file) {
    const key = fileKey(file);
    const selected = state.selectedFiles.has(key);
    const title = escapeHtml(file.title || file.filename || 'Bunkrr video');
    const q = qualityLabel(file);
    const tier = qualityTier(file);
    const sizeText = formatBytes(bytes(file));
    const durText = duration(file.duration);
    const dateText = dateValue(file) ? new Date(dateValue(file)).toLocaleDateString('sk-SK') : '—';
    const badge = q
      ? `<span class="bsw-qbadge ${tier}" title="Kvalita / rozlíšenie">${escapeHtml(q)}</span>`
      : `<span class="bsw-qbadge qna" title="Deep fetch ešte nepriniesol kvalitu">?</span>`;
    return `<article class="bsw-card${selected ? ' is-selected' : ''}${q ? ' has-quality' : ''}" data-file-key="${escapeHtml(key)}">
      <label class="bsw-card-select"><input type="checkbox" data-select-file="${escapeHtml(key)}" ${selected ? 'checked' : ''}> Vybrať</label>
      <div class="bsw-thumb">${file.thumbnail ? `<img src="${escapeHtml(file.thumbnail)}" alt="">` : '<span>VIDEO</span>'}${badge}<button data-play="${escapeHtml(key)}">▶ Prehrať</button></div>
      <h3 title="${title}">${title}</h3>
      <p>${escapeHtml(file.albumTitle)}</p>
      <div class="bsw-meta">
        <span class="bsw-chip bsw-chip-q ${tier}">${q ? escapeHtml(q) : 'kvalita ?'}</span>
        <span class="bsw-chip" title="Dĺžka">${durText}</span>
        <span class="bsw-chip" title="Veľkosť">${sizeText}</span>
        <span class="bsw-chip bsw-chip-muted" title="Dátum">${dateText}</span>
      </div>
    </article>`;
  }

  function paintFileCard(file) {
    const dialog = document.getElementById('bsw-workspace');
    if (!dialog) return;
    const key = fileKey(file);
    const card = dialog.querySelector(`[data-file-key="${CSS.escape(key)}"]`);
    if (!card) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = renderFile(file);
    const next = tmp.firstElementChild;
    if (!next) return;
    card.replaceWith(next);
    next.querySelector('[data-select-file]')?.addEventListener('change', (event) => {
      if (event.currentTarget.checked) state.selectedFiles.add(key);
      else state.selectedFiles.delete(key);
      renderWorkspace();
    });
    next.querySelector('[data-play]')?.addEventListener('click', () => playFile(key));
  }

  async function deepFetch() {
    const files = state.files.filter((file) => state.selectedFiles.has(fileKey(file)));
    if (!files.length || state.deep.active) return;
    // Large selections are sent in 400-URL chunks — the same cap as Nexus.
    const chunks = [];
    for (let start = 0; start < files.length; start += 400) chunks.push(files.slice(start, start + 400));
    state.deep = {
      active: true, done: 0, total: files.length, ok: 0, failed: 0,
      running: Math.min(4, files.length), startedAt: Date.now(),
    };
    paintDeepProgress();
    try {
      for (const chunk of chunks) {
        await streamNdjson('/api/v1/discovery-hub/refetch-meta', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: chunk.map(fileKey) }),
          timeout: Math.max(120000, chunk.length * 8000),
        }, (event) => {
          if (event.type === 'start' || event.type === 'progress') {
            state.deep.running = Math.max(0, Number(event.active) || 0);
            paintDeepProgress();
            return;
          }
          if (event.type !== 'patch') return;
          state.deep.done = Math.min(files.length, state.deep.done + 1);
          state.deep.running = Math.max(0, Math.min(4, files.length - state.deep.done));
          if (event.ok) state.deep.ok += 1;
          else state.deep.failed += 1;
          if (event.url && event.data) {
            let updated = null;
            state.files = state.files.map((file) => {
              if (fileKey(file) !== event.url) return file;
              updated = { ...file, ...event.data };
              return updated;
            });
            if (updated) paintFileCard(updated);
          }
          paintDeepProgress();
        });
      }
      state.deep.active = false;
      state.deep.running = 0;
      state.deep.done = Math.max(state.deep.done, files.length);
      paintDeepProgress();
      showToast(_t(`Deep fetch hotový: ${state.deep.ok}/${files.length} OK${state.deep.failed ? `, ${state.deep.failed} zlyhalo` : ''}.`, `Deep fetch completed: ${state.deep.ok}/${files.length} OK${state.deep.failed ? `, ${state.deep.failed} failed` : ''}.`));
      renderWorkspace();
    } catch (error) {
      state.deep.active = false;
      state.deep.running = 0;
      paintDeepProgress();
      showToast(`Deep fetch zlyhal: ${error.message || error}`, true);
      renderWorkspace();
    }
  }

  async function playFile(key) {
    const file = state.files.find((item) => fileKey(item) === key); if (!file) return;
    showToast('Pripravujem stream…');
    try {
      const data = await json(`/api/v1/discovery-hub/stream?url=${encodeURIComponent(key)}`);
      let overlay = document.getElementById('bsw-player');
      if (!overlay) { overlay = document.createElement('div'); overlay.id = 'bsw-player'; document.body.append(overlay); }
      overlay.innerHTML = `<div><button aria-label="Zavrieť prehrávač">×</button><strong>${escapeHtml(file.title || 'Bunkrr video')}</strong><video controls autoplay src="${escapeHtml(data.stream_url || '')}"></video></div>`;
      overlay.hidden = false; overlay.querySelector('button').addEventListener('click', () => { overlay.hidden = true; overlay.querySelector('video')?.pause(); });
    } catch (error) { showToast(_t(`Prehrávanie zlyhalo: ${error.message || error}`, `Playback failed: ${error.message || error}`), true); }
  }

  async function importFiles(files) {
    if (!files.length) return;
    showToast(`Posielam ${files.length} videí do Nexus importu…`);
    try {
      const candidates = files.map((file) => ({ url: fileKey(file), source_url: fileKey(file), title: file.title || file.filename || 'Bunkrr video', thumbnail: file.thumbnail || '', duration: file.duration || 0, size_bytes: bytes(file), source: 'bunkrr.pics', tags: ['bunkrr', file.albumTitle].filter(Boolean) }));
      await json('/api/v1/intake/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batch_name: `${SEARCH_LABEL} workbench · ${new Date().toLocaleDateString('sk-SK')}`, candidates }) });
      showToast(`Import fronta vytvorená pre ${files.length} videí.`); state.selectedFiles.clear(); renderWorkspace();
    } catch (error) { showToast(_t(`Import zlyhal: ${error.message || error}`, `Import failed: ${error.message || error}`), true); }
  }

  function escapeHtml(value) { return String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }

  function teardownForFindrManager() {
    document.getElementById('bsw-toolbar')?.remove();
    document.getElementById('bsw-workspace')?.remove();
    document.querySelectorAll('.bsw-source-select').forEach((node) => node.remove());
    document.querySelectorAll('.bsw-source-card').forEach((node) => node.classList.remove('bsw-source-card'));
  }

  function mount() {
    if (document.documentElement.dataset.nexusFindrManager === '1') return;
    if (document.getElementById('bsw-toolbar')) return;
    const toolbar = document.createElement('aside'); toolbar.id = 'bsw-toolbar';
    toolbar.innerHTML = `<strong>${SEARCH_LABEL} workbench</strong><span data-count>Vyber albumy</span><button id="bsw-select-all">Vybrať všetko</button><button id="bsw-fetch" disabled>Fetch do nového gridu</button><button id="bsw-open" disabled>Otvoriť grid</button>`;
    document.body.append(toolbar);
    toolbar.querySelector('#bsw-select-all').addEventListener('click', () => setAlbumSelection(true));
    toolbar.querySelector('#bsw-fetch').addEventListener('click', fetchSelectedAlbums);
    toolbar.querySelector('#bsw-open').addEventListener('click', openWorkspace);
    // Bunkrr mutates the page continuously while image/lazy components settle.
    // Only reconcile when a newly-added node actually contains a search result,
    // then coalesce a burst into one small update.  The old unfiltered observer
    // could repeatedly scan the complete search grid and freeze the tab.
    let reconcileTimer = 0;
    const nodeContainsAlbumLink = (node) => node.nodeType === Node.ELEMENT_NODE
      && (node.matches?.(ALBUM_LINK_SELECTOR) || node.querySelector?.(ALBUM_LINK_SELECTOR));
    const observer = new MutationObserver((mutations) => {
      if (document.documentElement.dataset.nexusFindrManager === '1') {
        observer.disconnect();
        teardownForFindrManager();
        return;
      }
      if (!mutations.some((mutation) => [...mutation.addedNodes].some(nodeContainsAlbumLink))) return;
      clearTimeout(reconcileTimer);
      reconcileTimer = setTimeout(() => { syncSearchCards(); updateToolbar(); }, 120);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('nexus-findr-manager-ready', () => {
      observer.disconnect();
      teardownForFindrManager();
    }, { once: true });
    syncSearchCards(); updateToolbar();
  }

  const style = document.createElement('style');
  style.textContent = `#bsw-toolbar{position:fixed;z-index:2147483000;right:22px;bottom:22px;display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid #3b5162;border-radius:14px;background:#0e151dcc;color:#eaf5f7;font:600 12px system-ui;box-shadow:0 18px 54px #0008;backdrop-filter:blur(16px)}#bsw-toolbar strong{color:#9ff2df}#bsw-toolbar span{color:#9baeba}#bsw-toolbar button,.bsw-tools button{border:1px solid #3d5966;border-radius:8px;background:#15242b;color:#dff8f2;padding:8px 10px;font:700 11px system-ui;cursor:pointer}#bsw-toolbar button:disabled,.bsw-tools button:disabled{opacity:.45;cursor:not-allowed}.bsw-source-card{position:relative!important}.bsw-source-select{position:absolute;z-index:4;top:9px;right:9px;display:flex;gap:5px;align-items:center;padding:6px 8px;border:1px solid #558075;border-radius:8px;background:#081012df;color:#dff8f2;font:700 10px system-ui;cursor:pointer}.bsw-source-select input{accent-color:#48d6bc}#bsw-workspace{position:fixed;z-index:2147483001;inset:20px;overflow:auto;border:1px solid #38505e;border-radius:20px;background:#0b1118;color:#ebf3f5;box-shadow:0 26px 90px #000d;padding:20px;font-family:system-ui}#bsw-workspace[hidden],#bsw-player[hidden]{display:none}.bsw-head{display:flex;justify-content:space-between;gap:16px;align-items:start;padding-bottom:16px;border-bottom:1px solid #263844}.bsw-head h2{margin:3px 0;font-size:28px;letter-spacing:-.04em}.bsw-head p,.bsw-card p{margin:0;color:#91a5ae;font-size:12px}.bsw-kicker{color:#67ddc8;font-size:11px;font-weight:800}.bsw-icon{border:0;background:transparent;color:#dcebf0;font-size:28px;cursor:pointer}.bsw-tools{display:flex;gap:8px;flex-wrap:wrap;padding:14px 0}.bsw-tools input,.bsw-tools select{min-height:36px;border:1px solid #344b59;border-radius:9px;background:#121e27;color:#eaf5f7;padding:0 10px;font:600 12px system-ui}.bsw-tools input{flex:1;min-width:240px}.bsw-selection{padding:9px 0 13px;color:#9baeba;font-size:12px}.bsw-selection strong{color:#a6f5e4}.bsw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px;align-items:start}.bsw-card{position:relative;align-self:start;overflow:hidden;border:1px solid #263c47;border-radius:13px;background:#101b23}.bsw-card.is-selected{border-color:#5bd8c2;box-shadow:0 0 0 1px #5bd8c244}.bsw-card h3{margin:11px 11px 5px;display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;min-height:32px;font-size:13px;line-height:16px}.bsw-card p{margin:0 11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bsw-card-select{position:absolute;z-index:3;top:8px;right:8px;padding:5px 7px;border-radius:7px;background:#081014dc;color:#e7f9f5;font-size:10px}.bsw-thumb{position:relative;display:grid;place-items:center;aspect-ratio:3/4;overflow:hidden;background:linear-gradient(145deg,#10232a,#071015 58%);color:#71909b}.bsw-thumb img{display:block;width:100%;height:100%;object-fit:cover;object-position:center}.bsw-thumb button{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);border:1px solid #6de3ce;border-radius:999px;background:#071418db;color:#e9fffa;padding:8px 10px;font:800 11px system-ui;cursor:pointer}.bsw-meta{display:flex;gap:6px;flex-wrap:wrap;padding:10px 11px 12px;color:#aabcc3;font:600 10px ui-monospace,monospace}.bsw-meta span{padding:3px 5px;border-radius:5px;background:#192832}.bsw-empty{grid-column:1/-1;padding:34px;text-align:center;color:#90a3ad}#bsw-player{position:fixed;z-index:2147483002;inset:0;display:grid;place-items:center;background:#020508cc;padding:22px}#bsw-player>div{width:min(1000px,96vw);padding:12px;border-radius:14px;background:#0d161e;color:#e9f5f6}#bsw-player button{float:right;border:0;background:transparent;color:white;font-size:24px;cursor:pointer}#bsw-player video{display:block;width:100%;max-height:76vh;margin-top:10px;background:#000}@media(max-width:720px){#bsw-toolbar{left:10px;right:10px;bottom:10px;flex-wrap:wrap}.bsw-source-select span{display:none}#bsw-workspace{inset:8px;padding:14px}.bsw-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}}#bsw-toast{position:fixed;z-index:2147483004;left:50%;bottom:86px;transform:translate(-50%,14px);max-width:min(92vw,620px);padding:10px 14px;border:1px solid #4a716a;border-radius:9px;background:#0d1b1ce8;color:#dffff8;font:600 12px system-ui;opacity:0;transition:.2s;pointer-events:none}#bsw-toast[data-error="true"]{border-color:#ca7373;color:#ffdede}#bsw-toast.is-visible{opacity:1;transform:translate(-50%,0)}`;
  // Keep the minimum filters compact and visibly separate from destructive
  // batch actions. Appending this rule set avoids coupling their layout to the
  // media-card grid above.
  style.textContent += `.bsw-filters{display:flex;align-items:end;gap:9px;flex-wrap:wrap;margin:0 0 12px;padding:10px 12px;border:1px solid #263c47;border-radius:11px;background:#0e1921}.bsw-filters legend{padding:0 5px;color:#72dfca;font:800 10px system-ui}.bsw-filters label{display:grid;gap:5px;color:#a8bbc4;font:700 10px system-ui}.bsw-filters input,.bsw-filters select{min-height:34px;border:1px solid #344b59;border-radius:8px;background:#121e27;color:#eaf5f7;padding:0 9px;font:600 12px system-ui}.bsw-filters input{width:118px}.bsw-filter-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto}.bsw-filter-actions button{border:1px solid #3d5966;border-radius:8px;background:#15242b;color:#dff8f2;padding:8px 10px;font:700 11px system-ui;cursor:pointer}.bsw-filter-actions button[data-action="clear-filters"]{background:transparent;color:#9bb0b8}.bsw-filter-note{max-width:360px;color:#738894;font:500 10px/1.35 system-ui}.bsw-deep{margin:0 0 12px;padding:11px 12px;border:1px solid #2f6f63;border-radius:11px;background:linear-gradient(180deg,#10241f,#0d171c)}.bsw-deep[data-done="true"]{border-color:#355447}.bsw-deep-row{display:flex;justify-content:space-between;gap:12px;align-items:baseline;color:#d7fff5;font:700 12px system-ui}.bsw-deep-sub{margin-top:7px;color:#8fb4aa;font:600 11px system-ui}.bsw-deep-track{margin-top:8px;height:10px;overflow:hidden;border-radius:999px;background:#163029}.bsw-deep-fill{height:100%;border-radius:inherit;background:linear-gradient(90deg,#2dd4bf,#67e8f9);transition:width .25s ease}`;
  style.textContent += `.bsw-qbadge{position:absolute;z-index:2;left:8px;bottom:8px;padding:3px 8px;border-radius:6px;font:800 11px/1.1 system-ui;letter-spacing:.02em;box-shadow:0 6px 16px #0007;backdrop-filter:blur(6px)}.bsw-qbadge.q4k{background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff}.bsw-qbadge.q1440{background:linear-gradient(135deg,#a78bfa,#7c3aed);color:#fff}.bsw-qbadge.qfhd{background:linear-gradient(135deg,#38bdf8,#0284c7);color:#062033}.bsw-qbadge.qhd{background:linear-gradient(135deg,#2dd4bf,#0f766e);color:#04201c}.bsw-qbadge.qsd{background:#475569cc;color:#e2e8f0}.bsw-qbadge.qna{background:#0b1418cc;color:#7f96a1;border:1px dashed #4a6070}.bsw-meta{display:flex;gap:5px;flex-wrap:wrap;padding:9px 11px 11px;align-items:center}.bsw-chip{display:inline-flex;align-items:center;padding:3px 7px;border-radius:6px;background:#192832;color:#b7c9d0;font:700 10px/1.2 ui-monospace,Consolas,monospace;white-space:nowrap}.bsw-chip-q{font-family:system-ui;letter-spacing:.02em}.bsw-chip-q.q4k{background:#7a4a12;color:#ffe7b8}.bsw-chip-q.q1440{background:#3b2a6b;color:#e9ddff}.bsw-chip-q.qfhd{background:#0c3d57;color:#b8e8ff}.bsw-chip-q.qhd{background:#0d3f39;color:#b7f5ea}.bsw-chip-q.qsd{background:#2a3440;color:#c5d0da}.bsw-chip-q.qna{background:#152028;color:#6f8490;border:1px dashed #3a4f5c}.bsw-chip-muted{color:#80949e;background:#141f27}.bsw-card.has-quality{border-color:#355a52}`;
  document.head.append(style);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
})();
