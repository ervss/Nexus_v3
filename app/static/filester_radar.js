import { RadarBrowser } from './filester_radar_browser.js?v=1';

const STORAGE_KEY = 'nexus.filesterRadar.v2';
const LEGACY_STORAGE_KEY = 'nexus.filesterRadar.v1';
const MAX_STORED_RUNS = 18;
const METADATA_BATCH_SIZE = 12;
const KEYWORD_SEARCH_BATCH_SIZE = 12;
const TARGET_PAGE_SIZE = 60;

export function normalizeKeyword(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function collectKeywordTargets(folders, keyword, sort = 'album') {
  const key = normalizeKeyword(keyword);
  const targets = new Map();
  if (!key) return [];
  for (const album of folders) {
    const search = album.contentSearch;
    if (!search || search.error || normalizeKeyword(search.keyword) !== key) continue;
    for (const file of search.matchedItems || []) {
      if (!normalizeKeyword(file.title).includes(key)) continue;
      let url;
      try { url = new URL(file.url); } catch (_) { continue; }
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      url.hash = '';
      const id = url.href;
      if (!targets.has(id)) targets.set(id, { ...file, url: id, albums: [] });
      const target = targets.get(id);
      if (!target.thumbnail && file.thumbnail) target.thumbnail = file.thumbnail;
      if (!target.albums.some(origin => origin.url === album.url)) target.albums.push({ url: album.url, title: album.title });
    }
  }
  return [...targets.values()].sort((a, b) => sort === 'size' ? Number(b.size_bytes || 0) - Number(a.size_bytes || 0)
    : sort === 'upload' ? dateValue(b.uploaded_at) - dateValue(a.uploaded_at)
      : sort === 'name' ? a.title.localeCompare(b.title, 'sk')
        : a.albums[0].title.localeCompare(b.albums[0].title, 'sk') || a.title.localeCompare(b.title, 'sk'));
}

const FOLDER_RE = /(?:https?:\/\/)?(?:www\.)?filester\.(?:me|gg|net|co|org|io)(?:\s*(?:›|»|>)\s*|\s*)\/f\/([a-z0-9_-]+)/ig;

export function canonicalFolderUrl(rawUrl) {
  const match = String(rawUrl || '').match(/(?:https?:\/\/)?(?:www\.)?filester\.(?:me|gg|net|co|org|io)(?:\s*(?:›|»|>)\s*|\s*)\/f\/([a-z0-9_-]+)/i);
  return match ? `https://filester.me/f/${match[1]}` : '';
}

export function galleryLaunchUrl(rawUrl) {
  const folderUrl = canonicalFolderUrl(rawUrl);
  return folderUrl ? `${folderUrl}#nexus-gallery` : '';
}

export function extractFileCount(text) {
  const value = String(text || '').replace(/\u00a0/g, ' ');
  const matches = [...value.matchAll(/(\d[\d\s,.]*)\s*files?\b/ig)];
  if (!matches.length) return null;
  const counts = matches.map(match => Number(match[1].replace(/[^\d]/g, ''))).filter(Number.isFinite);
  return counts.length ? Math.max(...counts) : null;
}

export function extractSizeBytes(text) {
  const units = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  const matches = [...String(text || '').matchAll(/(\d+(?:[.,]\d+)?)\s*(KB|MB|GB|TB)\b/ig)];
  if (!matches.length) return 0;
  return Math.max(...matches.map(match => Number(match[1].replace(',', '.')) * units[match[2].toUpperCase()]));
}

export function gigabytesToBytes(value) {
  const raw = String(value ?? '').trim().replace(',', '.');
  if (!raw) return null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric * 1024 ** 3 : null;
}

export function cleanTitle(title, url = '') {
  const id = canonicalFolderUrl(url).split('/').pop() || 'folder';
  let value = String(title || '').replace(/\s*[|–-]\s*filester\.me.*$/i, '').replace(/\s+/g, ' ').trim();
  if (!value || /^explore this folder with/i.test(value) || /^filester\.me/i.test(value)) value = `Filester folder ${id.slice(0, 8)}`;
  return value.slice(0, 140);
}

export function buildQueryPlan(seed = '', strategy = 'balanced', limit = 5, year = new Date().getFullYear()) {
  const safeSeed = String(seed || '').replace(/["<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  const root = 'site:filester.me/f';
  const withSeed = safeSeed ? ` "${safeSeed}"` : '';
  let tokens;
  if (strategy === 'focused' && safeSeed) tokens = ['', 'mp4', 'files', 'video', '4k', '1080p', 'GB', String(year)];
  else if (strategy === 'deep') tokens = ['mp4', 'files', 'video', '4k', '1080p', 'GB', String(year), 'page', 'files 1', 'files 2', 'files 3', 'files 4'];
  else tokens = ['mp4', 'files', 'video', '4k', '1080p', 'GB', String(year), 'page'];
  return [...new Set(tokens.map(token => `${root}${withSeed}${token ? ` ${token}` : ''}`.trim()))]
    .slice(0, Math.max(1, Math.min(Number(limit) || 5, 8)));
}

export function extractFolderUrlsFromText(text) {
  return extractFolderCandidatesFromText(text).map(item => item.url);
}

export function extractFolderCandidatesFromText(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const found = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    for (const match of lines[index].matchAll(FOLDER_RE)) {
      const url = `https://filester.me/f/${match[1]}`;
      if (found.has(url)) continue;
      const nearby = lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 5));
      const title = nearby.find(line => !/filester\.(?:me|gg|net|co|org|io)\/f\//i.test(line) && !/^explore this folder/i.test(line) && !/^(?:web|images|video|maps|translate)$/i.test(line)) || '';
      found.set(url, { url, title, snippet: nearby.join(' ').slice(0, 520) });
    }
  }
  return [...found.values()];
}

export function scoreFolder(item, seed = '') {
  let score = 24;
  if (item.fileCount === 0) score -= 45;
  else if (item.fileCount != null) score += Math.min(34, Math.log10(item.fileCount + 1) * 13);
  if (item.sizeBytes >= 1024 ** 3) score += 8;
  if (/\b(?:mp4|video|4k|1080p|2160p)\b/i.test(`${item.title} ${item.snippet}`)) score += 9;
  if (!/^Filester folder/i.test(item.title)) score += 10;
  if (seed && `${item.title} ${item.snippet}`.toLowerCase().includes(seed.toLowerCase())) score += 24;
  score += Math.min(10, Math.max(0, (item.queries || []).length - 1) * 3);
  return Math.max(0, Math.min(100, Math.round(score)));
}

function dateValue(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function compareAlbumSnapshots(previous, current) {
  if (!previous) return { type: 'new', fileDelta: null, sizeDelta: 0, uploadChanged: false, message: 'Prvýkrát nájdený' };
  const previousCount = Number.isFinite(Number(previous.fileCount)) ? Number(previous.fileCount) : null;
  const currentCount = Number.isFinite(Number(current.fileCount)) ? Number(current.fileCount) : null;
  const fileDelta = previousCount == null || currentCount == null ? null : currentCount - previousCount;
  const sizeDelta = Math.max(0, Number(current.sizeBytes || 0) - Number(previous.sizeBytes || 0));
  const uploadChanged = dateValue(current.latestUploadAt) > dateValue(previous.latestUploadAt);
  const changed = fileDelta !== null && fileDelta !== 0 || sizeDelta > 0 || uploadChanged;
  if (!changed) return { type: 'unchanged', fileDelta, sizeDelta, uploadChanged, message: 'Bez zmeny od posledného preletu' };
  let message = 'Novšia verzia albumu';
  if (fileDelta > 0) message = `+${fileDelta} ${fileDelta === 1 ? 'nové video' : fileDelta < 5 ? 'nové videá' : 'nových videí'}`;
  else if (fileDelta < 0) message = `${Math.abs(fileDelta)} ${Math.abs(fileDelta) === 1 ? 'súbor odstránený' : 'súborov odstránených'}`;
  else if (uploadChanged) message = 'Novší upload';
  else if (sizeDelta > 0) message = 'Väčší album';
  return { type: 'updated', fileDelta, sizeDelta, uploadChanged, message };
}

function createApp() {
  const $ = selector => document.querySelector(selector);
  const state = {
    folders: new Map(), runs: [], selected: new Set(), boards: new Set(), running: false,
    fetchingMeta: false, searchingKeyword: false, targetLimit: TARGET_PAGE_SIZE, completedQueries: new Set(), failedQueries: new Set(), lastCollectorReceipt: '',
  };
  const elements = {
    form: $('#radar-form'), seed: $('#seed'), strategy: $('#strategy'), queryLimit: $('#query-limit'), resultLimit: $('#result-limit'),
    scanBtn: $('#scan-btn'), creditEstimate: $('#credit-estimate'), plan: $('#coverage-plan'), coverageSummary: $('#coverage-summary'),
    results: $('#result-list'), empty: $('#empty-state'), status: $('#run-status'), filter: $('#filter-text'), changeFilter: $('#change-filter'),
    minFiles: $('#min-files'), sizeMin: $('#size-min'), sizeMax: $('#size-max'), sort: $('#sort-by'), selectVisible: $('#select-visible'),
    keyword: $('#album-keyword'), searchKeyword: $('#search-selected-keyword'), fetchMeta: $('#fetch-selected-meta'), clearSelection: $('#clear-selection'), selected: $('#selected-list'), createBoards: $('#create-boards'),
    deleteSelected: $('#delete-selected'), deleteAll: $('#delete-all'),
    keywordScope: $('#keyword-scope'), targetPanel: $('#target-panel'), targetGrid: $('#target-grid'), targetSummary: $('#target-summary'), targetMessage: $('#target-message'), targetMore: $('#target-more'), targetSort: $('#target-sort'), selectTargets: $('#select-target-albums'),
    boardCount: $('#board-count'), paste: $('#paste-input'), yandexQueries: $('#yandex-queries'), toast: $('#toast'),
  };
  const browser = new RadarBrowser({
    toast: showToast, bytes: humanBytes, keyword: () => elements.keyword.value.trim(),
    onMetadata: (url, meta) => {
      for (const album of state.folders.values()) for (const file of album.contentSearch?.matchedItems || []) if (file.url === url) Object.assign(file, meta);
      persist();
    },
  });

  function currentPlan() { return buildQueryPlan(elements.seed.value, elements.strategy.value, elements.queryLimit.value); }
  function estimateCredits() { return currentPlan().length * Math.ceil(Number(elements.resultLimit.value) / 10); }
  function refreshPlan() {
    const plan = currentPlan();
    elements.creditEstimate.textContent = `≈ ${estimateCredits()} API požiadaviek`;
    elements.coverageSummary.textContent = `Pripravených ${plan.length} dotazov`;
    elements.plan.innerHTML = plan.map((query, index) => `<li class="${state.completedQueries.has(query) ? 'done' : state.failedQueries.has(query) ? 'failed' : ''}" title="${escapeHtml(query)}"><b>${index + 1}</b> ${escapeHtml(query.replace('site:filester.me/f ', ''))}</li>`).join('');
    elements.yandexQueries.innerHTML = plan.slice(0, 4).map((query, index) => {
      const yandexQuery = query.replace('site:filester.me/f', 'url:filester.me/f/*');
      return `<a href="https://yandex.com/search?text=${encodeURIComponent(yandexQuery)}&lr=10489" target="_blank" rel="noopener">${index + 1}. ${escapeHtml(yandexQuery.replace('url:filester.me/f/* ', ''))}</a>`;
    }).join('');
  }

  function escapeHtml(value) { const node = document.createElement('div'); node.textContent = String(value ?? ''); return node.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function humanNumber(value) { return new Intl.NumberFormat('sk-SK').format(Number(value) || 0); }
  function humanBytes(bytes) {
    if (!bytes) return 'nezistená';
    const units = ['B', 'KB', 'MB', 'GB', 'TB']; let value = Number(bytes); let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value >= 10 || unit < 2 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
  }
  function formatDay(value) {
    const date = new Date(value); if (!Number.isFinite(date.getTime())) return 'Neznámy deň';
    const today = new Date(); const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
    if (today.toDateString() === date.toDateString()) return 'Dnes';
    if (yesterday.toDateString() === date.toDateString()) return 'Včera';
    return new Intl.DateTimeFormat('sk-SK', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  }
  function formatTime(value) {
    const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('sk-SK', { hour: '2-digit', minute: '2-digit' }).format(date) : '—';
  }
  function formatUploadDate(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('sk-SK', { day: 'numeric', month: 'short', year: 'numeric' }).format(date) : 'nezistený';
  }
  function showToast(message, error = false) {
    elements.toast.textContent = message; elements.toast.classList.toggle('error', error); elements.toast.hidden = false;
    clearTimeout(showToast.timer); showToast.timer = setTimeout(() => { elements.toast.hidden = true; }, 4200);
  }
  function newId(prefix = 'run') { return `${prefix}-${Date.now()}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(16).slice(2)}`; }
  function clone(value) { return value ? JSON.parse(JSON.stringify(value)) : null; }

  function persist() {
    try {
      const runs = state.runs.slice(0, MAX_STORED_RUNS).map(run => ({ ...run, entries: run.entries.map(item => {
        if (!item.contentSearch?.matchedItems) return item;
        const contentSearch = { ...item.contentSearch }; delete contentSearch.matchedItems;
        return { ...item, contentSearch };
      }) }));
      const payload = { schemaVersion: 2, folders: [...state.folders.values()], selected: [...state.selected], runs, keyword: elements.keyword.value, keywordScope: elements.keywordScope.value, targetSort: elements.targetSort.value, lastCollectorReceipt: state.lastCollectorReceipt, savedAt: Date.now() };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (_) {}
  }

  function migrateLegacy(saved) {
    const folders = (saved.folders || []).filter(item => canonicalFolderUrl(item.url));
    if (!folders.length) return;
    const timestamp = saved.savedAt || Math.max(...folders.map(item => Number(item.firstFound) || 0), Date.now());
    const run = { id: newId('legacy'), startedAt: timestamp, completedAt: timestamp, status: 'done', source: 'legacy', label: 'Doterajšie nálezy', seed: '', queries: [], failedQueries: [], entries: [] };
    for (const folder of folders) {
      const item = { ...folder, id: folder.id || canonicalFolderUrl(folder.url).split('/').pop(), previews: folder.previews || [], latestUploadAt: folder.latestUploadAt || '', observedAt: timestamp };
      item.change = { type: 'baseline', message: 'Uložené pred časovou históriou' };
      run.entries.push(item); state.folders.set(item.url, clone(item));
    }
    state.runs.push(run);
    for (const url of saved.selected || []) if (state.folders.has(url)) state.selected.add(url);
  }

  function restore() {
    try {
      const savedV2 = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (savedV2.schemaVersion === 2) {
        for (const item of savedV2.folders || []) if (canonicalFolderUrl(item.url)) state.folders.set(item.url, item);
        state.runs = (savedV2.runs || []).filter(run => run?.id && Array.isArray(run.entries)).slice(0, MAX_STORED_RUNS);
        state.lastCollectorReceipt = savedV2.lastCollectorReceipt || '';
        elements.keyword.value = savedV2.keyword || state.runs.find(run => run.seed)?.seed || '';
        elements.keywordScope.value = savedV2.keywordScope === 'selected' ? 'selected' : 'all';
        if (['album', 'name', 'size', 'upload'].includes(savedV2.targetSort)) elements.targetSort.value = savedV2.targetSort;
        for (const url of savedV2.selected || []) if (state.folders.has(url)) state.selected.add(url);
        return;
      }
      migrateLegacy(JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || '{}'));
    } catch (_) {}
  }

  function createRun({ source = 'google', label = '', seed = '', strategy = '', queries = [] } = {}) {
    const run = { id: newId(), startedAt: Date.now(), completedAt: null, status: 'running', source, label, seed, strategy, queries, failedQueries: [], entries: [] };
    state.runs.unshift(run);
    if (state.runs.length > MAX_STORED_RUNS) state.runs.length = MAX_STORED_RUNS;
    return run;
  }

  function normalizeResult(result, query, engine = 'google') {
    const url = canonicalFolderUrl(result.link || result.url);
    if (!url) return null;
    const body = `${result.title || ''} ${result.snippet || ''}`;
    const item = {
      url, id: url.split('/').pop(), title: cleanTitle(result.title, url), snippet: String(result.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 360),
      fileCount: extractFileCount(body), sizeBytes: extractSizeBytes(body), latestUploadAt: '', previews: [], engines: [engine], queries: query ? [query] : [],
      firstFound: Date.now(), observedAt: Date.now(), checkedAt: '', metaFetched: false, pinned: state.boards.has(url),
    };
    item.score = scoreFolder(item, elements.seed.value.trim());
    return item;
  }

  function mergeSnapshot(current, incoming) {
    if (!current) return clone(incoming);
    const merged = { ...current };
    if (/^Filester folder/i.test(merged.title) && !/^Filester folder/i.test(incoming.title)) merged.title = incoming.title;
    if ((incoming.snippet || '').length > (merged.snippet || '').length) merged.snippet = incoming.snippet;
    const incomingCount = Number.isFinite(Number(incoming.fileCount)) ? Number(incoming.fileCount) : null;
    const currentCount = Number.isFinite(Number(merged.fileCount)) ? Number(merged.fileCount) : null;
    if (incomingCount != null) merged.fileCount = currentCount == null ? incomingCount : Math.max(currentCount, incomingCount);
    merged.sizeBytes = Math.max(Number(merged.sizeBytes || 0), Number(incoming.sizeBytes || 0));
    if (dateValue(incoming.latestUploadAt) > dateValue(merged.latestUploadAt)) merged.latestUploadAt = incoming.latestUploadAt;
    if ((incoming.previews || []).length) merged.previews = incoming.previews.slice(0, 6);
    merged.engines = [...new Set([...(merged.engines || []), ...(incoming.engines || [])])];
    merged.queries = [...new Set([...(merged.queries || []), ...(incoming.queries || [])])];
    merged.metaFetched = merged.metaFetched || incoming.metaFetched;
    merged.checkedAt = incoming.checkedAt || merged.checkedAt;
    merged.observedAt = incoming.observedAt || merged.observedAt;
    merged.pinned = merged.pinned || incoming.pinned;
    merged.score = scoreFolder(merged, elements.seed.value.trim());
    return merged;
  }

  function updateCatalog(snapshot) {
    const previous = state.folders.get(snapshot.url); const merged = mergeSnapshot(previous, snapshot);
    merged.firstFound = previous?.firstFound || snapshot.firstFound || Date.now(); merged.lastSeenAt = snapshot.observedAt || Date.now(); delete merged.change; delete merged.previous;
    state.folders.set(snapshot.url, merged);
  }

  function addToRun(run, incoming) {
    if (!incoming?.url) return false;
    let entry = run.entries.find(item => item.url === incoming.url);
    if (!entry) {
      const previous = clone(state.folders.get(incoming.url));
      entry = mergeSnapshot(null, incoming); entry.previous = previous; entry.change = compareAlbumSnapshots(previous, entry);
      run.entries.push(entry); updateCatalog(entry); return !previous;
    }
    const previous = entry.previous; const updated = mergeSnapshot(entry, incoming);
    Object.assign(entry, updated, { previous, change: compareAlbumSnapshots(previous, updated) }); updateCatalog(entry); return false;
  }

  function applyMetadata(run, meta) {
    const url = canonicalFolderUrl(meta.url); const entry = run.entries.find(item => item.url === url);
    if (!entry) return false;
    if (!meta.ok) { entry.metaError = meta.error || 'Meta údaje nie sú dostupné'; return false; }
    const incoming = clone(entry);
    if (meta.title && !/^filester(?:\.me)?\s*$/i.test(meta.title)) incoming.title = cleanTitle(meta.title, entry.url);
    const count = Number(meta.file_count); if (Number.isFinite(count) && count > 0) incoming.fileCount = Math.max(Number(incoming.fileCount || 0), count);
    const size = Number(meta.size_bytes); if (Number.isFinite(size) && size > 0) incoming.sizeBytes = Math.max(Number(incoming.sizeBytes || 0), size);
    incoming.latestUploadAt = meta.latest_upload_at || incoming.latestUploadAt || '';
    incoming.previews = Array.isArray(meta.previews) ? meta.previews.slice(0, 6) : incoming.previews || [];
    incoming.metaFetched = true; incoming.checkedAt = meta.checked_at || new Date().toISOString(); incoming.observedAt = Date.now(); incoming.metaError = '';
    const previous = entry.previous; const updated = mergeSnapshot(entry, incoming);
    Object.assign(entry, updated, { previous, change: compareAlbumSnapshots(previous, updated) }); updateCatalog(entry); return true;
  }

  function runSummary(run) {
    return run.entries.reduce((summary, item) => {
      const type = item.change?.type || 'unchanged'; summary[type] = (summary[type] || 0) + 1; summary.files += Number(item.fileCount || 0); return summary;
    }, { new: 0, updated: 0, unchanged: 0, baseline: 0, files: 0 });
  }

  function matchesFilters(item) {
    const text = elements.filter.value.trim().toLowerCase(); const min = Number(elements.minFiles.value) || 0;
    const minSizeBytes = gigabytesToBytes(elements.sizeMin.value); const maxSizeBytes = gigabytesToBytes(elements.sizeMax.value);
    const changeMatches = elements.changeFilter.value === 'all' || item.change?.type === elements.changeFilter.value;
    const sizeMatches = minSizeBytes == null && maxSizeBytes == null || item.sizeBytes > 0 && (minSizeBytes == null || item.sizeBytes >= minSizeBytes) && (maxSizeBytes == null || item.sizeBytes <= maxSizeBytes);
    const searchedFiles = (item.contentSearch?.matchedTitles || []).join(' ');
    return changeMatches && (!text || `${item.title} ${item.id} ${item.snippet} ${searchedFiles}`.toLowerCase().includes(text))
      && (item.fileCount == null || item.fileCount >= min) && item.fileCount !== 0 && sizeMatches;
  }

  function sortEntries(entries) {
    const sort = elements.sort.value;
    return [...entries].sort((a, b) => sort === 'files' ? (b.fileCount ?? -1) - (a.fileCount ?? -1)
      : sort === 'name' ? a.title.localeCompare(b.title) : sort === 'found' ? Number(b.observedAt || 0) - Number(a.observedAt || 0)
        : b.score - a.score || (b.fileCount ?? -1) - (a.fileCount ?? -1));
  }

  function visibleEntries() { return state.runs.flatMap(run => run.entries.filter(matchesFilters)); }

  function renderPreview(preview) {
    const name = preview.title || preview.url?.split('/').pop() || 'Video';
    const image = preview.thumbnail ? `<img src="${escapeHtml(preview.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '';
    return `<a class="preview-tile" href="${escapeHtml(preview.url || '#')}" target="_blank" rel="noopener"><span class="preview-image">${image}<i aria-hidden="true">▶</i></span><strong title="${escapeHtml(name)}">${escapeHtml(name)}</strong><small>${preview.size_bytes ? humanBytes(preview.size_bytes) : 'veľkosť nezistená'}</small></a>`;
  }

  function keywordAlbums() {
    return [...state.folders.values()].filter(item => elements.keywordScope.value !== 'selected' || state.selected.has(item.url));
  }

  function targetFiles() { return collectKeywordTargets(keywordAlbums(), elements.keyword.value, elements.targetSort.value); }

  function renderTargets() {
    const keyword = elements.keyword.value.trim(); const key = normalizeKeyword(keyword);
    const albums = keywordAlbums(); const files = targetFiles();
    const checked = albums.filter(item => normalizeKeyword(item.contentSearch?.keyword) === key && key);
    const failed = checked.filter(item => item.contentSearch.error).length;
    const matchedAlbums = new Set(files.flatMap(file => file.albums.map(album => album.url)));
    const legacy = checked.some(item => item.contentSearch.matchCount > 0 && !item.contentSearch.matchedItems?.length);
    elements.targetSummary.textContent = key ? `„${keyword}“: ${humanNumber(files.length)} kariet · ${matchedAlbums.size} zdrojových albumov · ${checked.length}/${albums.length} prehľadaných${failed ? ` · ${failed} chýb` : ''}` : 'Zadaj keyword a prehľadaj názvy súborov vo všetkých nájdených albumoch.';
    elements.targetPanel.setAttribute('aria-busy', String(state.searchingKeyword));
    elements.targetMessage.hidden = files.length > 0 && !failed && !legacy && checked.length === albums.length;
    elements.targetMessage.textContent = !key ? 'Výsledkom budú karty konkrétnych súborov so zhodou v názve. Nič sa automaticky neimportuje.'
      : state.searchingKeyword ? 'Prehľadávam albumy. Karty pribúdajú po dokončení jednotlivých dávok…'
        : legacy ? 'Staršie výsledky obsahujú iba názvy. Spusti Vytvoriť cielený grid pre načítanie kariet.'
          : failed ? `${failed} albumov sa nepodarilo úplne prehľadať. Výsledok nie je kompletný; spusti hľadanie znovu.`
            : checked.length < albums.length ? 'Pre tento keyword ešte nie sú prehľadané všetky albumy v zvolenom rozsahu. Spusti Vytvoriť cielený grid.'
              : !albums.length ? 'V tomto rozsahu nie sú albumy. Spusti Radar alebo zmeň rozsah na všetky nájdené albumy.'
                : 'V názvoch súborov sa nenašla zhoda. Skús kratší alebo iný keyword.';
    browser.render(files, state.targetLimit);
    elements.selectTargets.disabled = matchedAlbums.size === 0;
    elements.selectTargets.textContent = `Vybrať zdrojové albumy (${matchedAlbums.size})`;
  }

  function renderKeywordSearch(item) {
    const search = item.contentSearch;
    if (!search?.keyword) return '';
    if (search.error) return `<div class="keyword-result error"><strong>Keyword „${escapeHtml(search.keyword)}“ sa nepodarilo prehľadať</strong><small>${escapeHtml(search.error)}</small></div>`;
    const count = Number(search.matchCount || 0);
    const files = (search.matchedTitles || []).slice(0, 6);
    if (!count) return `<div class="keyword-result"><strong>Keyword „${escapeHtml(search.keyword)}“: bez zhody</strong><small>Prehľadaných ${humanNumber(search.scannedFiles)} súborov.</small></div>`;
    return `<div class="keyword-result has-matches"><strong>Keyword „${escapeHtml(search.keyword)}“: ${humanNumber(count)} ${count === 1 ? 'zhoda' : count < 5 ? 'zhody' : 'zhôd'}</strong><small title="${escapeHtml(files.join('\n'))}">${escapeHtml(files.join(' · '))}${count > files.length ? ` · +${humanNumber(count - files.length)} ďalších` : ''}</small></div>`;
  }

  function changeBadge(item) {
    const type = item.change?.type || 'unchanged';
    const labels = { new: 'Nový album', updated: 'Aktualizovaný album', unchanged: 'Znova nájdený', baseline: 'Doterajší nález' };
    return `<div class="change-block ${type}"><span>${labels[type] || labels.unchanged}</span><strong>${escapeHtml(item.change?.message || '')}</strong></div>`;
  }

  function renderAlbum(item) {
    const selected = state.selected.has(item.url); const queryCount = (item.queries || []).length;
    const origins = `${(item.engines || []).join(' + ')} · ${queryCount} ${queryCount === 1 ? 'dotaz' : 'dotazov'}`;
    const previews = (item.previews || []).slice(0, 6);
    return `<article class="result-row ${selected ? 'is-selected' : ''} change-${item.change?.type || 'unchanged'}" data-url="${item.url}">
      <div class="album-select"><input class="result-check" type="checkbox" aria-label="Vybrať ${escapeHtml(item.title)}" ${selected ? 'checked' : ''}></div>
      <div class="album-content"><header class="album-head"><div class="album-identity"><h3 class="result-title"><a href="${item.url}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a></h3><span class="result-id">/f/${escapeHtml(item.id)}</span></div>
        ${changeBadge(item)}
        <dl class="album-metrics"><div><dt>Súbory</dt><dd>${item.fileCount == null ? '—' : humanNumber(item.fileCount)}</dd></div><div><dt>Posledný upload</dt><dd>${formatUploadDate(item.latestUploadAt)}</dd></div><div><dt>Veľkosť</dt><dd>${humanBytes(item.sizeBytes)}</dd></div></dl>
        <div class="result-actions"><a class="gallery-launch" href="${galleryLaunchUrl(item.url)}" target="_blank" rel="noopener"><span aria-hidden="true">▦</span> Prezrieť v Gallery</a><a class="source-launch" href="${item.url}" target="_blank" rel="noopener">Otvoriť zdroj</a></div></header>
        <div class="preview-strip ${previews.length ? '' : 'is-empty'}">${previews.length ? previews.map(renderPreview).join('') : `<div class="preview-empty"><span>${item.metaError ? 'Náhľady sa nepodarilo načítať' : state.fetchingMeta ? 'Načítavam prvé videá…' : 'Náhľady zatiaľ nie sú dostupné'}</span><small>${escapeHtml(item.metaError || 'Vyber album a použi Obnoviť meta.')}</small></div>`}</div>
        ${renderKeywordSearch(item)}
        <footer class="album-foot"><p title="${escapeHtml((item.queries || []).join('\n'))}">${escapeHtml(item.snippet || origins)}</p><div class="signal-list">${item.pinned ? '<span class="signal good">už je Source Board</span>' : '<span class="signal good">pripravený na výber</span>'}${/\bmp4\b/i.test(item.snippet || '') ? '<span class="signal">MP4</span>' : ''}<span class="signal">${escapeHtml(origins)}</span></div><div class="score" title="Skóre signálu"><b>${item.score}</b><div class="score-bar"><i style="width:${item.score}%"></i></div></div></footer>
      </div></article>`;
  }

  function renderRun(run, index) {
    const summary = runSummary(run); const entries = sortEntries(run.entries.filter(matchesFilters));
    const label = run.label || (run.seed ? `Hľadanie: ${run.seed}` : run.source === 'google' ? 'Široký radar' : 'Manuálne overenie');
    const status = run.status === 'running' ? 'Prelet prebieha' : run.status === 'checking' ? 'Dopĺňam meta údaje' : `${run.entries.length} albumov`;
    const open = index < 2 || run.status === 'running' || run.status === 'checking';
    return `<details class="search-run" data-run-id="${run.id}" ${open ? 'open' : ''}><summary class="run-heading"><div class="run-time"><strong>${formatDay(run.startedAt)}</strong><span>${formatTime(run.startedAt)}</span></div><div class="run-title"><h2>${escapeHtml(label)}</h2><p>${status}${run.queries?.length ? ` · ${run.queries.length} dotazov` : ''}</p></div><div class="run-totals"><span class="new">${summary.new} nových</span><span class="updated">${summary.updated} aktualizovaných</span><span>${summary.unchanged} bez zmeny</span></div><span class="run-chevron" aria-hidden="true"></span></summary>
      <div class="run-results">${entries.length ? entries.map(renderAlbum).join('') : `<div class="run-empty">${run.entries.length ? 'V tomto prelete nič nezodpovedá aktívnemu filtru.' : run.status === 'running' ? 'Čakám na prvé výsledky…' : 'Tento prelet nenašiel žiadny album.'}</div>`}</div></details>`;
  }

  function render() {
    const folders = [...state.folders.values()]; const latest = state.runs[0]; const latestSummary = latest ? runSummary(latest) : { new: 0, updated: 0 };
    elements.empty.hidden = state.runs.length > 0; elements.results.innerHTML = state.runs.map(renderRun).join('');
    $('#stat-folders').textContent = humanNumber(folders.length); $('#stat-runs').textContent = humanNumber(state.runs.length);
    $('#stat-new').textContent = humanNumber(latestSummary.new); $('#stat-updated').textContent = humanNumber(latestSummary.updated);
    $('#stat-files').textContent = humanNumber(folders.reduce((sum, item) => sum + Number(item.fileCount || 0), 0)); $('#stat-selected').textContent = humanNumber(state.selected.size);
    const visibleUrls = new Set(visibleEntries().map(item => item.url)); elements.selectVisible.textContent = `Vybrať viditeľné (${visibleUrls.size})`;
    elements.clearSelection.disabled = state.selected.size === 0; elements.clearSelection.textContent = `Zrušiť výber (${state.selected.size})`;
    elements.fetchMeta.disabled = state.fetchingMeta || state.selected.size === 0; elements.fetchMeta.textContent = state.fetchingMeta ? 'Obnovujem meta…' : `Obnoviť meta (${state.selected.size})`;
    const keyword = elements.keyword.value.trim();
    elements.keyword.disabled = state.searchingKeyword; elements.keywordScope.disabled = state.searchingKeyword;
    elements.searchKeyword.disabled = state.searchingKeyword || keywordAlbums().length === 0 || !normalizeKeyword(keyword);
    elements.searchKeyword.textContent = state.searchingKeyword ? 'Hľadám v albumoch…' : `Vytvoriť cielený grid (${keywordAlbums().length})`;
    elements.deleteSelected.disabled = state.selected.size === 0;
    elements.deleteSelected.textContent = `Zmazať vybrané (${state.selected.size})`;
    elements.deleteAll.disabled = state.folders.size === 0;
    renderTargets(); renderSelected(); persist();
  }

  function renderSelected() {
    const items = [...state.selected].map(url => state.folders.get(url)).filter(Boolean);
    elements.selected.innerHTML = items.length ? items.map(item => `<div class="selected-item" data-url="${item.url}"><strong>${escapeHtml(item.title)}</strong><small>${item.fileCount == null ? '?' : humanNumber(item.fileCount)} súborov · upload ${formatUploadDate(item.latestUploadAt)}</small><button type="button" aria-label="Odobrať ${escapeHtml(item.title)}">×</button></div>`).join('') : '<p class="rail-empty">Označ albumy, ktoré chceš ďalej preveriť.</p>';
    elements.createBoards.disabled = !items.length; elements.boardCount.textContent = items.length;
  }

  async function loadBoards() {
    try {
      const response = await fetch('/api/v1/source-boards'); if (!response.ok) return;
      const data = await response.json();
      for (const board of data.boards || []) { const url = canonicalFolderUrl(board.source_url); if (url) state.boards.add(url); }
      for (const item of state.folders.values()) item.pinned = state.boards.has(item.url);
      for (const run of state.runs) for (const item of run.entries) item.pinned = state.boards.has(item.url);
      render();
    } catch (_) {}
  }

  async function fetchMetadataForRun(run) {
    if (!run.entries.length) { run.status = 'done'; run.completedAt = Date.now(); render(); return; }
    state.fetchingMeta = true; run.status = 'checking'; render(); let updated = 0; let failed = 0;
    for (let offset = 0; offset < run.entries.length; offset += METADATA_BATCH_SIZE) {
      const batch = run.entries.slice(offset, offset + METADATA_BATCH_SIZE);
      elements.status.hidden = false; elements.status.textContent = `Prelet ${formatTime(run.startedAt)}: čítam albumy ${offset + 1}–${Math.min(offset + batch.length, run.entries.length)} z ${run.entries.length}…`;
      try {
        const response = await fetch('/api/v1/radar/collector/filester/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: batch.map(item => item.url) }) });
        const data = await response.json(); if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
        for (const meta of data.items || []) applyMetadata(run, meta) ? updated += 1 : failed += 1;
      } catch (error) { failed += batch.length; for (const item of batch) item.metaError = error.message; }
      render();
    }
    run.status = 'done'; run.completedAt = Date.now(); state.fetchingMeta = false; const summary = runSummary(run);
    elements.status.textContent = `Hotovo: ${run.entries.length} albumov · ${summary.new} nových · ${summary.updated} aktualizovaných${failed ? ` · ${failed} bez meta údajov` : ''}.`;
    showToast(summary.updated ? `Nájdené zmeny v ${summary.updated} albumoch.` : `Prelet uložený: ${updated}/${run.entries.length} albumov má čerstvé meta údaje.`); render();
  }

  async function loadCollectorFolders() {
    try {
      const response = await fetch('/api/v1/radar/collector/filester'); if (!response.ok) return;
      const data = await response.json(); const urls = (data.urls || []).map(canonicalFolderUrl).filter(Boolean); if (!urls.length) return;
      const receipt = data.received_at || `legacy:${urls.join('|')}`; if (receipt === state.lastCollectorReceipt) return;
      state.lastCollectorReceipt = receipt; const run = createRun({ source: 'collector', label: 'Nexus Collector' });
      for (const url of urls) addToRun(run, normalizeResult({ url, title: '', snippet: '' }, 'Nexus Collector', 'collector'));
      render(); showToast(`Collector vytvoril nový prelet s ${urls.length} albumami.`); await fetchMetadataForRun(run);
    } catch (_) {}
  }

  async function fetchSelectedMetadata() {
    if (state.fetchingMeta || !state.selected.size) return;
    const run = createRun({ source: 'refresh', label: 'Kontrola vybraných albumov' });
    for (const url of state.selected) { const current = state.folders.get(url); if (current) addToRun(run, { ...clone(current), observedAt: Date.now(), engines: ['manual refresh'], queries: [] }); }
    render(); await fetchMetadataForRun(run);
  }

  function applyKeywordSearch(result, keyword) {
    const url = canonicalFolderUrl(result.url);
    if (!url) return;
    const contentSearch = {
      keyword,
      matchCount: Math.max(0, Number(result.match_count) || 0),
      scannedFiles: Math.max(0, Number(result.scanned_files) || 0),
      matchedTitles: Array.isArray(result.matches) ? result.matches.map(match => String(match || '')).filter(Boolean).slice(0, 12) : [],
      matchedItems: Array.isArray(result.matched_items) ? result.matched_items : undefined,
      searchedAt: result.checked_at || new Date().toISOString(),
      error: result.ok === false ? String(result.error || 'Obsah albumu sa nepodarilo načítať')
        : !Array.isArray(result.matched_items) ? 'Backend vrátil starý formát výsledkov. Reštartuj Nexus backend a spusti hľadanie znovu.' : '',
    };
    const catalogItem = state.folders.get(url);
    if (catalogItem) catalogItem.contentSearch = clone(contentSearch);
    // Keep full match metadata only in the unique catalog, not in every historical snapshot.
    const summary = { ...contentSearch }; delete summary.matchedItems;
    for (const run of state.runs) for (const item of run.entries) if (item.url === url) item.contentSearch = clone(summary);
  }

  async function searchSelectedKeyword() {
    const keyword = elements.keyword.value.trim();
    const urls = keywordAlbums().map(item => item.url);
    if (!keyword || !urls.length || state.searchingKeyword) return;
    state.searchingKeyword = true; state.targetLimit = TARGET_PAGE_SIZE; elements.status.hidden = false;
    for (const url of urls) delete state.folders.get(url).contentSearch;
    render();
    let matchedAlbums = 0; let failed = 0;
    for (let offset = 0; offset < urls.length; offset += KEYWORD_SEARCH_BATCH_SIZE) {
      const batch = urls.slice(offset, offset + KEYWORD_SEARCH_BATCH_SIZE);
      elements.status.textContent = `Hľadám „${keyword}“ v albumoch ${offset + 1}–${Math.min(offset + batch.length, urls.length)} z ${urls.length}…`;
      try {
        const response = await fetch('/api/v1/radar/collector/filester/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: batch, keyword }) });
        const data = await response.json(); if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
        const returned = new Set();
        for (const result of data.items || []) { const url = canonicalFolderUrl(result.url); if (!batch.includes(url) || returned.has(url)) continue; returned.add(url); applyKeywordSearch(result, keyword); if (result.ok && Number(result.match_count) > 0) matchedAlbums += 1; if (!result.ok) failed += 1; }
        for (const url of batch) if (!returned.has(url)) { failed += 1; applyKeywordSearch({ url, ok: false, error: 'Server nevrátil výsledok albumu' }, keyword); }
      } catch (error) {
        failed += batch.length;
        for (const url of batch) applyKeywordSearch({ url, ok: false, error: error.message }, keyword);
      }
      render();
    }
    state.searchingKeyword = false;
    elements.status.textContent = `Hľadanie „${keyword}“ hotové: zhoda v ${matchedAlbums} ${matchedAlbums === 1 ? 'albume' : matchedAlbums < 5 ? 'albumoch' : 'albumoch'}${failed ? ` · ${failed} sa nepodarilo prehľadať` : ''}.`;
    showToast(failed ? `Hľadanie má ${failed} chýb; grid nie je kompletný.` : matchedAlbums ? `Keyword „${keyword}“ našiel zhodu v ${matchedAlbums} albumoch.` : `Keyword „${keyword}“ nemá v prehľadaných albumoch zhodu.`, failed > 0); render();
  }

  function removeAlbums(urls, all = false) {
    const targets = new Set(urls);
    const count = all ? state.folders.size : targets.size;
    if (!count) return;
    const question = all ? `Zmazať všetkých ${count} albumov z Filester Radaru? Táto akcia vymaže aj ich lokálnu históriu.` : `Zmazať ${count} vybraných albumov z Filester Radaru? Táto akcia vymaže aj ich lokálnu históriu.`;
    if (!globalThis.confirm(question)) return;
    if (all) { state.folders.clear(); state.selected.clear(); state.runs = []; }
    else {
      for (const url of targets) { state.folders.delete(url); state.selected.delete(url); }
      state.runs = state.runs.map(run => ({ ...run, entries: run.entries.filter(item => !targets.has(item.url)) })).filter(run => run.entries.length);
    }
    elements.status.hidden = true; showToast(all ? 'Všetky albumy boli z Radaru odstránené.' : `Odstránených ${count} vybraných albumov.`); render();
  }

  async function runScan(event) {
    event.preventDefault(); if (state.running || state.fetchingMeta) return;
    const plan = currentPlan(); const seed = elements.seed.value.trim(); const run = createRun({ source: 'google', seed, strategy: elements.strategy.value, queries: plan });
    if (!state.searchingKeyword && seed) { elements.keyword.value = seed; state.targetLimit = TARGET_PAGE_SIZE; }
    state.running = true; state.completedQueries.clear(); state.failedQueries.clear(); elements.scanBtn.disabled = true; elements.status.hidden = false; let newAlbums = 0;
    for (let index = 0; index < plan.length; index += 1) {
      const query = plan[index]; elements.status.textContent = `Dotaz ${index + 1}/${plan.length}: ${query}`; refreshPlan(); const planItem = elements.plan.children[index]; if (planItem) planItem.classList.add('running');
      try {
        const response = await fetch('/api/google/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, safe_search: false, num: Number(elements.resultLimit.value), filter_duplicates: false, page: 1 }) });
        const data = await response.json(); if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
        for (const raw of data.results || []) { const item = normalizeResult(raw, query); if (item && addToRun(run, item)) newAlbums += 1; }
        state.completedQueries.add(query); render();
      } catch (error) { state.failedQueries.add(query); run.failedQueries.push(query); elements.status.textContent = `Dotaz zlyhal: ${error.message}`; }
      refreshPlan();
    }
    state.running = false; elements.scanBtn.disabled = false; elements.status.textContent = `Vyhľadávanie hotové: ${run.entries.length} albumov. Dopĺňam počet súborov, posledný upload a náhľady…`;
    showToast(`Nájdených ${newAlbums} nových albumov. Teraz overujem ich obsah.`); render(); await fetchMetadataForRun(run);
  }

  async function parsePaste() {
    const candidates = extractFolderCandidatesFromText(elements.paste.value);
    if (!candidates.length) { showToast('Vo vloženom texte nebol Filester album.', true); return; }
    const run = createRun({ source: 'yandex', label: 'Vložené výsledky z Yandexu' });
    for (const candidate of candidates) addToRun(run, normalizeResult(candidate, 'pasted Yandex result', 'yandex'));
    elements.paste.value = ''; render(); showToast(`Vytvorený prelet s ${run.entries.length} albumami z vloženého textu.`); await fetchMetadataForRun(run);
  }

  async function createBoards() {
    const selected = [...state.selected].map(url => state.folders.get(url)).filter(item => item && !item.pinned);
    if (!selected.length) { showToast('Všetky vybrané albumy už sú v Source Boards.', true); return; }
    elements.createBoards.disabled = true;
    const boards = selected.map(item => ({ name: `${item.title} · ${item.id.slice(-6)}`.slice(0, 96), source_url: item.url, source_type: 'filester', description: `Filester Radar · skóre ${item.score} · ${item.fileCount == null ? 'neznámy' : item.fileCount} súborov`, icon: 'folder_special', color: '#f06432' }));
    try {
      const response = await fetch('/api/v1/source-boards/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ boards, auto_sync: false }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
      for (const board of data.created || []) { const url = canonicalFolderUrl(board.source_url); if (url) state.boards.add(url); }
      for (const item of state.folders.values()) item.pinned = state.boards.has(item.url); for (const savedRun of state.runs) for (const item of savedRun.entries) item.pinned = state.boards.has(item.url);
      showToast(`Vytvorených ${data.created?.length || 0} Source Boards. Sync zostáva na tvojom rozhodnutí.`); render();
    } catch (error) { showToast(`Source Boards sa nepodarilo vytvoriť: ${error.message}`, true); }
    finally { elements.createBoards.disabled = state.selected.size === 0; }
  }

  elements.form.addEventListener('submit', runScan);
  for (const input of [elements.seed, elements.strategy, elements.queryLimit, elements.resultLimit]) input.addEventListener('input', refreshPlan);
  for (const input of [elements.filter, elements.keyword, elements.changeFilter, elements.minFiles, elements.sizeMin, elements.sizeMax, elements.sort]) input.addEventListener('input', render);
  for (const input of [elements.keyword, elements.keywordScope, elements.targetSort]) input.addEventListener('input', () => { state.targetLimit = TARGET_PAGE_SIZE; render(); });
  elements.keyword.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); searchSelectedKeyword(); } });
  elements.targetMore.addEventListener('click', () => { state.targetLimit += TARGET_PAGE_SIZE; renderTargets(); });
  elements.selectTargets.addEventListener('click', () => { for (const file of targetFiles()) for (const album of file.albums) state.selected.add(album.url); render(); });
  elements.targetGrid.addEventListener('error', event => { if (event.target.matches('.preview-image img')) event.target.parentElement.classList.add('image-missing'); }, true);
  elements.results.addEventListener('change', event => { const row = event.target.closest('.result-row'); if (!row || !event.target.matches('.result-check')) return; event.target.checked ? state.selected.add(row.dataset.url) : state.selected.delete(row.dataset.url); render(); });
  elements.results.addEventListener('error', event => { if (event.target.matches('.preview-image img')) event.target.parentElement.classList.add('image-missing'); }, true);
  elements.selected.addEventListener('click', event => { const item = event.target.closest('.selected-item'); if (item && event.target.matches('button')) { state.selected.delete(item.dataset.url); render(); } });
  elements.selectVisible.addEventListener('click', () => { for (const item of visibleEntries()) state.selected.add(item.url); render(); });
  elements.fetchMeta.addEventListener('click', fetchSelectedMetadata); elements.searchKeyword.addEventListener('click', searchSelectedKeyword); elements.clearSelection.addEventListener('click', () => { state.selected.clear(); render(); });
  elements.deleteSelected.addEventListener('click', () => removeAlbums([...state.selected])); elements.deleteAll.addEventListener('click', () => removeAlbums([], true));
  $('#clear-selected').addEventListener('click', () => { state.selected.clear(); render(); }); $('#parse-paste').addEventListener('click', parsePaste); elements.createBoards.addEventListener('click', createBoards);
  restore(); refreshPlan(); render(); loadBoards(); loadCollectorFolders();
}

if (typeof document !== 'undefined') createApp();
