// ==UserScript==
// @name         WMOVIES — conservative IMDb ratings
// @namespace    local.wmovies.imdb
// @version      1.3.0
// @description  IMDb poster badges, persistent filters and a bounded OMDb queue.
// @match        *://*.wmovies.nl/*
// @match        *://wmovies.nl/*
// @match        *://*.wmovies.org/*
// @match        *://wmovies.org/*
// @match        *://*.ovies.org/*
// @match        *://ovies.org/*
// @match        *://*.wmovies.*/*
// @match        *://wmovies.*/*
// @match        *://*.ovies.*/*
// @match        *://ovies.*/*
// @include      /^https?:\/\/(?:[a-zA-Z0-9-]+\.)*(?:wmovies|ovies)\.[a-zA-Z]{2,}(?::\d+)?\/.*$/
// @include      *://*wmovies.*/*
// @include      *://*ovies.*/*
// @match        https://www.imdb.com/title/tt*
// @match        https://imdb.com/title/tt*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_openInTab
// @grant        window.onurlchange
// @connect      www.omdbapi.com
// @connect      www.imdb.com
// @connect      imdb.com
// @connect      self
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  const CONFIG = {
    apiKey: '3d375d7',
    cacheTTLDays: 30,
    negativeCacheHours: 24,
    maxSearchPages: 3,
    imdbFallback: true,
    imdbTabScan: { enabled: true, maxCards: 30, timeoutMs: 20000, retryMinutes: 60 },
    manualScanCooldownSeconds: 60,
    showMissingStatus: true,
    concurrency: 3,
    showVotes: false,
    filter: { enabled: true, defaultMinimum: 0, keepUnknown: true },
    requestTimeoutMs: 12000,
    maxCacheEntries: 1500
  };

  const titleKey = value => String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[‘’']/g, '').replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
  const imdbIDFrom = value => {
    try {
      const url = new URL(value);
      return /^(www\.)?imdb\.com$/.test(url.hostname) ? url.pathname.match(/^\/title\/(tt\d{7,10})(?:\/|$)/)?.[1] : null;
    } catch { return null; }
  };
  // Only the title's own aggregateRating is accepted; reviews and related titles are ignored.
  function parseIMDb(doc, expectedID) {
    const canonical = doc.querySelector('link[rel="canonical"]')?.href;
    if (imdbIDFrom(canonical) !== expectedID) return null;
    const entities = [];
    function visit(value) {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!value || typeof value !== 'object') return;
      entities.push(value);
      if (value['@graph']) visit(value['@graph']);
    }
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try { visit(JSON.parse(script.textContent)); } catch { /* malformed unrelated JSON */ }
    }
    const matches = entities.filter(value => imdbIDFrom(value.url || value['@id']) === expectedID &&
      ['Movie', 'TVSeries', 'TVMiniSeries'].includes(value['@type']));
    if (matches.length !== 1) return null;
    const value = matches[0], rating = Number(value.aggregateRating?.ratingValue);
    const votes = Number(value.aggregateRating?.ratingCount);
    const year = String(value.datePublished || '').match(/^\d{4}/)?.[0];
    if (!value.name || !year || !value.aggregateRating || !Number.isFinite(rating) || rating < 0 || rating > 10 ||
      Number(value.aggregateRating.bestRating) !== 10 || !Number.isInteger(votes) || votes < 1) return null;
    const nameDoc = doc.createElement('textarea'); nameDoc.innerHTML = value.name;
    return { title: nameDoc.value, year, type: value['@type'] === 'Movie' ? 'movie' : 'series',
      status: 'rated', rating, votes: votes.toLocaleString('en-US'), imdbID: expectedID, source: 'IMDb', canonicalVerified: true,
      checkedAt: Date.now(), until: Date.now() + CONFIG.cacheTTLDays * 86400000 };
  }
  const shared = {
    get(key) { try { return typeof GM_getValue === 'function' ? GM_getValue(key, null) : null; } catch { return null; } },
    set(key, value) { try { if (typeof GM_setValue === 'function') GM_setValue(key, value); } catch { /* optional bridge */ } }
  };
  if (/^(www\.)?imdb\.com$/.test(location.hostname)) {
    const id = imdbIDFrom(location.href);
    let saved = '';
    const capture = () => {
      const record = parseIMDb(document, id);
      if (!record || saved === JSON.stringify([record.imdbID, record.rating, record.votes])) return;
      const requested = location.hash.match(/^#wm-imdb-from=(tt\d{7,10})$/)?.[1];
      const identity = requested && shared.get('wm-imdb-identity:' + requested);
      if (requested && requested !== id && identity?.until > Date.now() &&
        identity.title === titleKey(record.title) && identity.year === record.year && identity.type === record.type) {
        record.requestedID = requested; record.redirectVerified = true;
        shared.set('wm-imdb-record:' + requested, record);
      }
      saved = JSON.stringify([record.imdbID, record.rating, record.votes]);
      shared.set('wm-imdb-record:' + id, record);
      shared.set('wm-imdb-last-import', record);
      let confirmation = document.getElementById('wm-imdb-imported');
      if (!confirmation) {
        confirmation = document.createElement('div'); confirmation.id = 'wm-imdb-imported';
        confirmation.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483000;background:#101b2a;color:#ffcf33;padding:12px;border:1px solid #ffcf33;border-radius:8px;font:14px system-ui;pointer-events:none';
        document.body.append(confirmation);
      }
      confirmation.textContent = `WMOVIES: ⭐ ${record.rating.toFixed(1)} uložené pre ${record.title}`;
    };
    capture();
    const observer = new MutationObserver(changes => {
      if (changes.some(m =>
        ((m.target.nodeType === 1 ? m.target : m.target.parentElement)?.matches?.('script[type="application/ld+json"]') ||
         Array.from(m.addedNodes).some(n => n.nodeType === 1 && (n.matches?.('script[type="application/ld+json"]') || n.querySelector?.('script[type="application/ld+json"]')))))) capture();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    window.addEventListener('pageshow', capture);
    return;
  }

  // Uisti sa, že skript beží na cieľovom webe (wmovies.* alebo ovies.*)
  const isTargetSite = /^(?:[a-zA-Z0-9-]+\.)*(?:wmovies|ovies)\.[a-zA-Z]{2,}$/i.test(location.hostname);
  if (!isTargetSite) return;

  // No API key is ever written to page storage or sent to the movie website.
  const NS = 'wm-imdb-v1:';
  const CARD = '.item[id^="post-"]';
  const BADGE = 'wm-imdb-badge';
  const states = new WeakMap();
  const memo = new Map();
  const memoUntil = new Map();
  const pending = new Set();
  const queue = [];
  const limit = Math.max(1, Math.min(6, Number(CONFIG.concurrency) || 3));
  let active = 0, scheduled = false, notice = '', toolbar, toolbarScheduled = false;
  let fetching = false;
  let imdbScanning = false, cancelIMDb = false;
  const imdbWaiters = new Map();
  const validKey = CONFIG.apiKey.trim() && !/PUT_YOUR|YOUR_API/i.test(CONFIG.apiKey);
  const normal = s => String(s || '').normalize('NFKC').toLowerCase()
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ').trim();
  const storage = {
    get(key) { try { return JSON.parse(localStorage.getItem(NS + key)); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(NS + key, JSON.stringify(value)); } catch { /* memory still works */ } },
    remove(key) { try { localStorage.removeItem(NS + key); } catch { /* unavailable storage */ } }
  };
  // The detail URL separates same-name, same-year works; grid/sidebar copies still deduplicate.
  const identityKey = card => JSON.stringify([normal(card.title), card.year, card.type, card.url]);
  const ttlFor = result => result.status === 'rated' ? CONFIG.cacheTTLDays * 86400000 : CONFIG.negativeCacheHours * 3600000;
  const validCached = cached => cached?.until > Date.now() && cached.result &&
    ['rated', 'missing', 'ambiguous', 'mismatch', 'unrated'].includes(cached.result.status) &&
    (cached.result.status === 'rated' || cached.version === 2) &&
    (cached.result.status !== 'rated' || (Number.isFinite(cached.result.rating) && cached.result.rating >= 0 &&
      cached.result.rating <= 10 && /^tt\d{7,10}$/.test(cached.result.imdbID)));
  const STATUS = { pending: 'načítavam', unrated: 'OMDb nemá rating', missing: 'OMDb nenašlo titul',
    ambiguous: 'nejasná zhoda', mismatch: 'nezhodný výsledok', incomplete: 'chýba rok alebo typ',
    error: 'chyba API', paused: 'pozastavené' };
  function remember(card) {
    if (!card.year || !card.type) return;
    const old = storage.get('history:' + card.url);
    if (old?.key === identityKey(card) && old.until > Date.now() && old.lastSeen > Date.now() - 3600000) return;
    storage.set('history:' + card.url, { title: normal(card.title), year: card.year, type: card.type,
      key: identityKey(card), lastSeen: Date.now(), until: Date.now() + CONFIG.cacheTTLDays * 86400000 });
  }
  // Fingerprint only isolates cooldowns when a user changes keys; this is not encryption.
  let hash = 2166136261;
  for (const c of CONFIG.apiKey) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  const stopKey = 'stop:' + (hash >>> 0).toString(16);
  let stop = storage.get(stopKey);
  if (!stop || !(stop.until > Date.now())) stop = null;
  let minimum = storage.get('filter');
  if (![0, 6, 7, 8].includes(minimum)) minimum = [0, 6, 7, 8].includes(CONFIG.filter.defaultMinimum) ? CONFIG.filter.defaultMinimum : 0;

  function prune() {
    try {
      const entries = [], history = [];
      for (const k of Object.keys(localStorage)) {
        if (!k.startsWith(NS + 'cache:') && !k.startsWith(NS + 'history:')) continue;
        const value = storage.get(k.slice(NS.length));
        if (!value || value.until <= Date.now()) localStorage.removeItem(k);
        else (k.startsWith(NS + 'cache:') ? entries : history).push([k, value.until]);
      }
      entries.sort((a, b) => b[1] - a[1]);
      for (const [k] of entries.slice(CONFIG.maxCacheEntries)) localStorage.removeItem(k);
      history.sort((a, b) => b[1] - a[1]);
      for (const [k] of history.slice(CONFIG.maxCacheEntries)) localStorage.removeItem(k);
    } catch { /* storage can be disabled */ }
  }
  prune();

  const style = document.createElement('style');
  style.id = 'wm-imdb-style';
  style.textContent = `
    .wm-imdb-poster{position:relative!important}
    .wm-imdb-badge{position:absolute;top:7px;left:7px;z-index:5;pointer-events:none;
      background:rgba(5,13,27,.93);color:#ffcf33;border:1px solid rgba(255,207,51,.45);
      border-radius:6px;padding:4px 6px;font:700 12px/1.2 system-ui,sans-serif;
      box-shadow:0 2px 5px #0008;white-space:nowrap}
    .wm-imdb-badge small{display:block;color:#d6dae0;font-size:9px;font-weight:400;margin-top:2px}
    .wm-imdb-badge a{display:block;pointer-events:auto;color:#ffcf33!important;font-size:9px;font-weight:500;margin-top:3px;text-decoration:underline}
    .wm-imdb-badge.wm-imdb-unknown{color:#d5dce5;border-color:#718095;font-weight:500}
    .item.wm-imdb-hidden{display:none!important}
    #wm-imdb-toolbar{position:fixed;right:12px;top:108px;z-index:2147483000;
      max-width:calc(100vw - 24px);background:#071121f2;color:#e5e9ef;border:1px solid #58606b;
      border-radius:8px;padding:7px;font:12px/1.4 system-ui,sans-serif;box-shadow:0 3px 12px #0008}
    #wm-imdb-toolbar button{background:#111e30;color:#ddd;border:1px solid #455064;
      border-radius:4px;padding:4px 8px;margin-left:4px;cursor:pointer;font:inherit}
    #wm-imdb-toolbar button[aria-pressed=true]{background:#ffcf33;color:#08101c;border-color:#ffcf33}
    #wm-imdb-toolbar button:disabled{opacity:.6;cursor:wait}
    #wm-imdb-summary{display:block;max-width:340px;color:#e5e9ef;margin-top:4px}
    #wm-imdb-status{display:block;max-width:290px;color:#bac5d5;margin-top:3px}
    #wm-imdb-status:empty{display:none}
  `;
  if (document.getElementById(style.id)) return; // Also guards accidental double execution.
  document.head.append(style);

  function updateToolbar() {
    if (!toolbar || !toolbar.isConnected) return;
    for (const b of toolbar.querySelectorAll('button[data-minimum]')) {
      const value = String(Number(b.dataset.minimum) === minimum);
      if (b.getAttribute('aria-pressed') !== value) b.setAttribute('aria-pressed', value);
    }
    const message = !validKey ? 'Set your OMDb API key in CONFIG.' : stop ? stop.message : notice;
    const label = toolbar.querySelector('output');
    if (label.textContent !== message) label.textContent = message;
    const counts = { rated: 0, pending: 0, unrated: 0, other: 0 };
    for (const card of document.querySelectorAll(CARD)) {
      const result = states.get(card)?.result;
      if (!states.has(card)) continue;
      if (!result || result.status === 'pending') counts.pending++;
      else if (result.status === 'rated') counts.rated++;
      else if (result.status === 'unrated') counts.unrated++;
      else counts.other++;
    }
    const summary = `${counts.rated} ratingov · ${counts.pending} čaká · ${counts.unrated} OMDb bez ratingu · ${counts.other} ostatné`;
    const summaryLabel = toolbar.querySelector('#wm-imdb-summary');
    if (summaryLabel.textContent !== summary) summaryLabel.textContent = summary;
    const fetchButton = toolbar.querySelector('#wm-imdb-fetch');
    fetchButton.disabled = fetching || imdbScanning || active > 0 || queue.length > 0 || !validKey;
    fetchButton.textContent = fetching || active > 0 || queue.length > 0 ? 'Fetching…' : 'Scan all / Fetch ratings';
    const imdbButton = toolbar.querySelector('#wm-imdb-scan-imdb');
    if (imdbButton) {
      imdbButton.disabled = !imdbScanning && (fetching || active > 0 || queue.length > 0);
      imdbButton.textContent = imdbScanning ? 'Zastaviť IMDb' : 'Dohľadať cez IMDb';
    }
  }
  function refreshToolbar() {
    if (toolbarScheduled) return;
    toolbarScheduled = true;
    requestAnimationFrame(() => { toolbarScheduled = false; updateToolbar(); });
  }
  function ensureToolbar() {
    if (toolbar?.isConnected) return;
    toolbar = document.createElement('div');
    toolbar.id = 'wm-imdb-toolbar';
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', 'IMDb rating filter');
    toolbar.append(document.createTextNode('IMDb'));
    for (const value of CONFIG.filter.enabled ? [0, 6, 7, 8] : []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.minimum = value;
      button.textContent = value ? value + '+' : 'ALL';
      button.addEventListener('click', () => {
        minimum = value;
        storage.set('filter', value);
        for (const card of document.querySelectorAll(CARD)) applyFilter(card, states.get(card)?.result);
        updateToolbar();
      });
      toolbar.append(button);
    }
    const fetchButton = document.createElement('button');
    fetchButton.id = 'wm-imdb-fetch';
    fetchButton.type = 'button';
    fetchButton.textContent = 'Scan all / Fetch ratings';
    fetchButton.title = 'Prejde všetky načítané karty aj mimo obrazovky. Použije cache a znovu preverí chýbajúce výsledky.';
    fetchButton.addEventListener('click', manualScan);
    toolbar.append(fetchButton);
    if (CONFIG.imdbTabScan.enabled) {
      const imdbButton = document.createElement('button');
      imdbButton.id = 'wm-imdb-scan-imdb'; imdbButton.type = 'button';
      imdbButton.textContent = 'Dohľadať cez IMDb';
      imdbButton.title = 'Pri tituloch so známou identitou a N/A v OMDb otvorí postupne jednu dočasnú kartu IMDb na pozadí a uloží rating. Bez hádania nejasných zhôd.';
      imdbButton.addEventListener('click', scanIMDbTabs);
      toolbar.append(imdbButton);
    }
    const summary = document.createElement('span');
    summary.id = 'wm-imdb-summary';
    toolbar.append(summary);
    const output = document.createElement('output');
    output.id = 'wm-imdb-status';
    toolbar.append(output);
    document.body.append(toolbar);
    updateToolbar();
  }
  function applyFilter(card, result) {
    const hide = CONFIG.filter.enabled && minimum > 0 &&
      (Number.isFinite(result?.rating) ? result.rating < minimum : !CONFIG.filter.keepUnknown);
    card.classList.toggle('wm-imdb-hidden', hide);
  }

  function readCard(card) {
    const poster = card.querySelector(':scope > .poster');
    const meta = card.querySelector(':scope > .meta, :scope > .info');
    const name = card.querySelector(':scope > .meta > a, :scope > .info > .name');
    const link = card.matches('a[href]') ? card : poster?.querySelector('a[href]');
    if (!poster || !meta || !name || !link || !poster.querySelector('img')) return null;
    const spans = Array.from(meta.querySelectorAll(':scope > div > span'), s => s.textContent.trim());
    const year = spans.find(s => /^\d{4}$/.test(s)) || '';
    const type = spans.some(s => /^Movie$/i.test(s)) ? 'movie' :
      spans.some(s => /^(TV|SS\s*\d+|EP\s*\d+)$/i.test(s)) ? 'series' : '';
    const title = name.textContent.trim();
    const url = new URL(link.href, location.href);
    if (!/^https?:$/.test(url.protocol) || url.origin !== location.origin || !title) return null;
    return { title, year, sourceYear: year, type, url: url.origin + url.pathname.replace(/\/$/, ''), poster };
  }

  function halt(message, hours) {
    const until = Date.now() + hours * 3600000;
    if (stop && stop.until >= until) return;
    stop = { message, until };
    storage.set(stopKey, stop);
    updateToolbar();
  }
  function request(params) {
    return new Promise((resolve, reject) => {
      if (stop) return reject(new Error('paused'));
      const url = new URL('https://www.omdbapi.com/');
      url.search = new URLSearchParams({ apikey: CONFIG.apiKey.trim(), r: 'json', ...params });
      GM_xmlhttpRequest({
        method: 'GET', url: url.href, timeout: CONFIG.requestTimeoutMs, anonymous: true,
        onload(response) {
          try {
            if (response.status === 401 || response.status === 403) {
              halt('OMDb rejected the API key. Correct CONFIG and reload.', 6);
              return reject(new Error('auth'));
            }
            if (response.status === 429) {
              halt('OMDb quota reached. Requests paused for one hour.', 1);
              return reject(new Error('quota'));
            }
            if (response.status < 200 || response.status >= 300) throw new Error('http');
            const data = JSON.parse(response.responseText);
            if (!data || !['True', 'False'].includes(data.Response)) throw new Error('schema');
            if (data.Response === 'False' && /key|limit|quota|too many/i.test(data.Error || '')) {
              halt(/key/i.test(data.Error) ? 'OMDb rejected the API key. Correct CONFIG and reload.' :
                'OMDb quota reached. Requests paused for one hour.', /key/i.test(data.Error) ? 6 : 1);
              return reject(new Error('service'));
            }
            resolve(data);
          } catch {
            if (!stop) halt('OMDb unavailable. Wait a minute, then reload to retry.', 1 / 60);
            reject(new Error('response'));
          }
        },
        onerror() { halt('OMDb network error. Wait a minute, then reload to retry.', 1 / 60); reject(new Error('network')); },
        ontimeout() { halt('OMDb timed out. Wait a minute, then reload to retry.', 1 / 60); reject(new Error('timeout')); }
      });
    });
  }
  const same = (data, card) => titleKey(data.Title) === titleKey(card.title) &&
    String(data.Year || '').match(/^\d{4}/)?.[0] === card.year && data.Type === card.type;

  function publicGet(url) {
    return new Promise(resolve => GM_xmlhttpRequest({ method: 'GET', url,
      anonymous: true, timeout: CONFIG.requestTimeoutMs,
      onload: r => resolve(r.status === 200 ? r.responseText : null),
      onerror: () => resolve(null), ontimeout: () => resolve(null) }));
  }
  const sharedMatches = (record, card, id) => record?.until > Date.now() && record.status === 'rated' &&
    (record.imdbID === id || (record.requestedID === id && record.redirectVerified === true)) &&
    record.canonicalVerified === true && record.source === 'IMDb' && Number.isFinite(record.rating) && record.rating >= 0 && record.rating <= 10 &&
    record.year === card.year && record.type === card.type;
  const imdbMemo = new Map();
  async function finishDetail(detail, card) {
    shared.set('wm-imdb-identity:' + detail.imdbID, { title: titleKey(card.title), year: card.year,
      type: card.type, until: Date.now() + CONFIG.cacheTTLDays * 86400000 });
    const imported = shared.get('wm-imdb-record:' + detail.imdbID);
    if (sharedMatches(imported, card, detail.imdbID)) return imported;
    const rating = /^\d+(\.\d+)?$/.test(detail.imdbRating) ? Number(detail.imdbRating) : NaN;
    if (Number.isFinite(rating) && rating >= 0 && rating <= 10) return { status: 'rated', rating,
      imdbID: detail.imdbID, source: 'OMDb', votes: /^[\d,]+$/.test(detail.imdbVotes || '') ? detail.imdbVotes : '' };
    if (CONFIG.imdbFallback) {
      if (!imdbMemo.has(detail.imdbID)) imdbMemo.set(detail.imdbID, (async () => {
        const html = await publicGet('https://www.imdb.com/title/' + detail.imdbID + '/');
        return html ? parseIMDb(new DOMParser().parseFromString(html, 'text/html'), detail.imdbID) : null;
      })());
      const record = await imdbMemo.get(detail.imdbID);
      if (sharedMatches(record, card, detail.imdbID)) {
        shared.set('wm-imdb-record:' + detail.imdbID, record);
        return record;
      }
    }
    // N/A in OMDb does not prove that IMDb itself is unrated.
    return { status: 'unrated', imdbID: detail.imdbID, source: 'OMDb' };
  }
  const siteDetails = new Map();
  async function sitePeople(card) {
    if (!siteDetails.has(card.url)) siteDetails.set(card.url, (async () => {
      const html = await publicGet(card.url);
      if (!html) return null;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const info = doc.querySelector('.info');
      if (titleKey(info?.querySelector('h1.name')?.textContent) !== titleKey(card.title) ||
        info?.querySelector('.meta .year')?.textContent.trim() !== card.year) return null;
      return {
        actors: Array.from(info.querySelectorAll('.detail .casts a[href*="/actors/"]'), a => titleKey(a.textContent)),
        directors: Array.from(info.querySelectorAll('.detail a[href*="/director/"]'), a => titleKey(a.textContent))
      };
    })());
    return siteDetails.get(card.url);
  }
  async function resolveCandidates(candidates, card) {
    const details = [];
    for (const candidate of candidates) {
      const detail = await request({ i: candidate.imdbID, plot: 'short' });
      if (detail.Response === 'True' && same(detail, card) && detail.imdbID === candidate.imdbID) details.push(detail);
    }
    if (candidates.length === 1) return details[0] ? finishDetail(details[0], card) : { status: 'mismatch' };
    const people = await sitePeople(card);
    if (!people) return { status: 'ambiguous' };
    const matches = details.filter(detail => {
      const actors = String(detail.Actors || '').split(',').map(titleKey);
      const directors = String(detail.Director || '').split(',').map(titleKey);
      const castOverlap = people.actors.filter(name => actors.includes(name)).length;
      const directorOverlap = people.directors.some(name => directors.includes(name));
      return castOverlap >= 2 || (directorOverlap && castOverlap >= 1);
    });
    return matches.length === 1 ? finishDetail(matches[0], card) : { status: 'ambiguous' };
  }

  async function lookup(card) {
    // Search first: an exact-title endpoint alone could silently pick a duplicate.
    const search = await request({ s: card.title, y: card.year, type: card.type, page: '1' });
    if (search.Response === 'False') {
      if (/not found/i.test(search.Error || '')) return { status: 'missing' };
      if (/too many results/i.test(search.Error || '')) return { status: 'ambiguous' };
      halt('OMDb returned an unexpected error. Wait a minute, then reload.', 1 / 60);
      throw new Error('search');
    }
    if (!Array.isArray(search.Search)) throw new Error('schema');
    const total = Number(search.totalResults);
    const pageLimit = Math.max(1, Math.min(3, Number(CONFIG.maxSearchPages) || 3));
    if (!Number.isInteger(total) || total < 1 || total > pageLimit * 10) return { status: 'ambiguous' };
    const all = [...search.Search];
    for (let page = 2; page <= Math.ceil(total / 10); page++) {
      const more = await request({ s: card.title, y: card.year, type: card.type, page: String(page) });
      if (more.Response !== 'True' || !Array.isArray(more.Search) || Number(more.totalResults) !== total) return { status: 'ambiguous' };
      all.push(...more.Search);
    }
    const unique = Array.from(new Map(all.map(d => [d.imdbID, d])).values());
    if (all.length !== total) return { status: 'ambiguous' };
    const candidates = unique.filter(d => same(d, card) && /^tt\d{7,10}$/.test(d.imdbID));
    if (!candidates.length) return { status: 'missing' };
    // Bound detail requests too; never select by popularity or first-result order.
    if (candidates.length > 4) return { status: 'ambiguous' };
    return resolveCandidates(candidates, card);
  }
  async function pump() {
    if (stop) {
      while (queue.length) {
        const job = queue.shift();
        pending.delete(job.key);
        memoUntil.set(job.key, stop.until);
        job.resolve({ status: 'paused' });
      }
      refreshToolbar();
      return;
    }
    while (active < limit && queue.length) {
      const job = queue.shift();
      active++;
      void run(job);
    }
  }
  async function run(job) {
    let result;
    try {
      result = await lookup(job.card);
      const ttl = ttlFor(result);
      const until = Math.min(Date.now() + ttl, result.until || Infinity);
      storage.set('cache:' + job.key, { version: 2, until, result });
      memoUntil.set(job.key, until);
    } catch {
      result = { status: 'error' };
      if (!stop) halt('OMDb response unavailable. Wait a minute, then reload.', 1 / 60);
      memoUntil.set(job.key, stop?.until || Date.now() + 60000);
    } finally {
      pending.delete(job.key);
      job.resolve(result);
      active--;
      void pump();
      refreshToolbar();
    }
  }
  function getRating(card, force = false) {
    const key = identityKey(card);
    if (pending.has(key)) return memo.get(key);
    if (!force && memo.has(key) && memoUntil.get(key) > Date.now()) return memo.get(key);
    let cached = storage.get('cache:' + key);
    if (!cached) {
      const legacy = storage.get('cache:' + JSON.stringify([normal(card.title), card.year, card.type]));
      // Version 1.1 accepted only a globally unique candidate, so its positive entries can migrate.
      if (legacy?.version !== 2 && legacy?.result?.status === 'rated' && validCached(legacy)) {
        cached = legacy; storage.set('cache:' + key, legacy);
      }
    }
    if (cached?.result?.imdbID) {
      const imported = shared.get('wm-imdb-record:' + cached.result.imdbID);
      if (sharedMatches(imported, card, cached.result.imdbID)) {
        cached = { version: 2, until: imported.until, result: imported };
        storage.set('cache:' + key, cached);
      }
    }
    let promise;
    if (validCached(cached) && (!force || cached.result.status === 'rated')) {
      promise = Promise.resolve(cached.result);
      memoUntil.set(key, cached.until);
    } else if (!validKey || stop) promise = Promise.resolve({ status: 'paused' });
    else {
      pending.add(key);
      promise = new Promise(resolve => queue.push({ card, key, resolve }));
    }
    memo.set(key, promise);
    void pump();
    refreshToolbar();
    return promise;
  }
  async function process(card, data, force = false) {
    const signature = JSON.stringify([data.title, data.year, data.sourceYear, data.type, data.url]);
    let state = states.get(card);
    if (state?.signature === signature && !force && (!state.result || state.until > Date.now())) {
      if (state.result && !card.querySelector('.' + BADGE)) paint(card, data, state.result);
      return;
    }
    for (const badge of card.querySelectorAll('.' + BADGE)) badge.remove();
    state = { signature, result: null, until: Infinity };
    states.set(card, state);
    applyFilter(card, null);
    if (!data.year || !data.type) {
      state.result = { status: 'incomplete' };
      paint(card, data, state.result);
      refreshToolbar();
      return;
    }
    const promise = getRating(data, force);
    if (pending.has(identityKey(data))) paint(card, data, { status: 'pending' });
    const result = await promise;
    if (!card.isConnected || states.get(card) !== state) return;
    const current = readCard(card);
    if (!current || current.title !== data.title || current.year !== data.sourceYear ||
        current.type !== data.type || current.url !== data.url) {
      schedule(); // A response may arrive before the mutation's next animation frame.
      return;
    }
    state.result = result;
    state.until = memoUntil.get(identityKey(data)) || stop?.until || Date.now() + 60000;
    paint(card, current, result); // A site may replace only the poster while the request is pending.
    refreshToolbar();
  }
  function paint(card, data, result) {
    if ((result.status === 'rated' || CONFIG.showMissingStatus) && data.poster.isConnected) {
      data.poster.classList.add('wm-imdb-poster');
      let badge = data.poster.querySelector('.' + BADGE);
      if (!badge) {
        badge = document.createElement('span');
        badge.className = BADGE;
        data.poster.append(badge);
      }
      badge.classList.toggle('wm-imdb-unknown', result.status !== 'rated');
      const label = result.status === 'rated' ? '⭐ ' + result.rating.toFixed(1) : 'IMDb —';
      const description = result.status === 'rated' ?
        `IMDb ${result.rating}/10${result.votes ? ' · ' + result.votes + ' votes' : ''} · ${result.imdbID} · zdroj ${result.source || 'OMDb'}` :
        'IMDb — ' + (STATUS[result.status] || 'neznáme');
      if (badge.getAttribute('aria-label') !== description) {
        badge.textContent = label;
        badge.title = description;
        badge.setAttribute('aria-label', description);
        if (CONFIG.showVotes && result.status === 'rated' && result.votes) {
          const votes = document.createElement('small'); votes.textContent = result.votes + ' votes'; badge.append(votes);
        } else if (result.status !== 'rated' && card.matches('div')) {
          const reason = document.createElement('small'); reason.textContent = STATUS[result.status] || 'neznáme'; badge.append(reason);
        }
        if (result.status === 'unrated' && /^tt\d{7,10}$/.test(result.imdbID)) {
          shared.set('wm-imdb-identity:' + result.imdbID, { title: titleKey(data.title), year: data.year,
            type: data.type, until: Date.now() + CONFIG.cacheTTLDays * 86400000 });
          const verify = document.createElement('a');
          verify.href = 'https://www.imdb.com/title/' + result.imdbID + '/#wm-imdb-from=' + result.imdbID;
          verify.target = '_blank'; verify.rel = 'noopener noreferrer';
          verify.textContent = 'Overiť IMDb ↗';
          verify.title = 'Po otvorení IMDb tento skript uloží aktuálny rating a priradí ho aj sem.';
          verify.addEventListener('click', e => e.stopPropagation());
          badge.append(verify);
        }
      }
    }
    applyFilter(card, result);
  }
  function recordsOnPage() {
    const cards = Array.from(document.querySelectorAll(CARD));
    const records = cards.map(card => [card, readCard(card)]).filter(([, data]) => data);
    const known = new Map();
    for (const [, data] of records) {
      if (!data.year || !data.type) continue;
      const previous = known.get(data.url);
      known.set(data.url, previous === false || (previous &&
        (previous.year !== data.year || previous.type !== data.type || normal(previous.title) !== normal(data.title))) ? false : data);
    }
    for (const [card, data] of records) {
      const sibling = known.get(data.url);
      if (!data.year && sibling && sibling.type === data.type && normal(sibling.title) === normal(data.title)) data.year = sibling.year;
      if (!data.year) {
        const history = storage.get('history:' + data.url);
        if (history?.until > Date.now() && history.title === normal(data.title) && history.type === data.type &&
            /^\d{4}$/.test(history.year)) data.year = history.year;
      }
      remember(data);
    }
    return records;
  }
  function scan() {
    scheduled = false;
    ensureToolbar();
    const cards = Array.from(document.querySelectorAll(CARD));
    for (const [card, data] of recordsOnPage()) void process(card, data);
    // Clear a recycled card that has become unrecognizable instead of retaining an old rating.
    for (const card of cards) if (!readCard(card) && states.has(card)) {
      states.delete(card);
      card.classList.remove('wm-imdb-hidden');
      for (const badge of card.querySelectorAll('.' + BADGE)) badge.remove();
    }
    updateToolbar();
  }
  async function manualScan() {
    if (fetching || imdbScanning || active || queue.length) return;
    if (stop && stop.until <= Date.now()) { stop = null; storage.remove(stopKey); }
    if (!validKey || stop) { updateToolbar(); return; }
    const last = storage.get('manualScanAt') || 0;
    if (Date.now() - last < CONFIG.manualScanCooldownSeconds * 1000) {
      notice = 'Opakované dohľadanie je možné po minúte. Uložené ratingy už sú priradené.';
      scan(); return;
    }
    storage.set('manualScanAt', Date.now());
    fetching = true;
    notice = '';
    try {
      const promises = recordsOnPage().map(([card, data]) => process(card, data, true));
      updateToolbar();
      await Promise.allSettled(promises);
      notice = 'Scan dokončený. Ratingy aj stavy sú uložené.';
    } finally { fetching = false; updateToolbar(); }
  }
  async function scanIMDbTabs() {
    if (imdbScanning) { cancelIMDb = true; for (const done of imdbWaiters.values()) done(null); return; }
    if (fetching || active || queue.length) return;
    if (typeof GM_openInTab !== 'function' || typeof GM_addValueChangeListener !== 'function') {
      notice = 'Automatické IMDb dohľadanie vyžaduje Tampermonkey. Použi odkaz Overiť IMDb.'; updateToolbar(); return;
    }
    const lock = shared.get('wm-imdb-scan-lock');
    if (lock?.until > Date.now()) { notice = 'IMDb scan už beží v inej karte.'; updateToolbar(); return; }
    const owner = Date.now() + ':' + Math.random().toString(36).slice(2);
    const candidates = new Map();
    for (const [card, data] of recordsOnPage()) {
      const result = states.get(card)?.result;
      if (result?.status === 'unrated' && /^tt\d{7,10}$/.test(result.imdbID)) candidates.set(result.imdbID, data);
    }
    const cap = Math.max(1, Math.min(30, Number(CONFIG.imdbTabScan.maxCards) || 30));
    const work = Array.from(candidates).filter(([id]) => !(shared.get('wm-imdb-tab-attempt:' + id)?.until > Date.now())).slice(0, cap);
    if (!work.length) { notice = 'Žiadne nové overené IMDb ID na dohľadanie. Neúspešné pokusy čakajú hodinu.'; updateToolbar(); return; }
    imdbScanning = true; cancelIMDb = false;
    let imported = 0, completed = 0;
    try {
      for (const [id, card] of work) {
        if (cancelIMDb) break;
        shared.set('wm-imdb-scan-lock', { owner, until: Date.now() + 60000 });
        shared.set('wm-imdb-identity:' + id, { title: titleKey(card.title), year: card.year,
          type: card.type, until: Date.now() + CONFIG.cacheTTLDays * 86400000 });
        notice = `IMDb ${++completed}/${work.length}: ${card.title}`; updateToolbar();
        const record = await new Promise(resolve => {
          let tab, timer, finished = false;
          const finish = value => {
            if (finished) return;
            finished = true; clearTimeout(timer); imdbWaiters.delete(id);
            try { tab?.close(); } catch { /* tab already closed */ }
            resolve(value);
          };
          imdbWaiters.set(id, value => finish(sharedMatches(value, card, id) ? value : null));
          timer = setTimeout(() => finish(null), Math.max(5000, Math.min(30000, Number(CONFIG.imdbTabScan.timeoutMs) || 20000)));
          try { tab = GM_openInTab('https://www.imdb.com/title/' + id + '/#wm-imdb-from=' + id, { active: false, insert: true, setParent: true }); }
          catch { finish(null); }
          if (finished) { try { tab?.close(); } catch { /* synchronous test bridge */ } }
        });
        if (record) { imported++; importRating(record); }
        else if (!cancelIMDb) shared.set('wm-imdb-tab-attempt:' + id,
          { until: Date.now() + Math.max(1, Number(CONFIG.imdbTabScan.retryMinutes) || 60) * 60000 });
      }
      notice = `IMDb dohľadanie: ${imported} uložených ratingov z ${completed} titulov.${cancelIMDb ? ' Zastavené.' : ''}`;
    } finally {
      if (shared.get('wm-imdb-scan-lock')?.owner === owner) shared.set('wm-imdb-scan-lock', null);
      imdbScanning = false; updateToolbar();
    }
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(scan);
  }
  const own = node => (node.nodeType === 1 ? node : node.parentElement)?.closest?.(
    '#wm-imdb-toolbar, #wm-imdb-style, .' + BADGE);
  const observer = new MutationObserver(changes => {
    if (changes.some(m => !own(m.target) && (m.type !== 'childList' ||
      Array.from([...m.addedNodes, ...m.removedNodes]).some(n => !own(n))))) schedule();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['href', 'alt'] });
  window.addEventListener('popstate', schedule);
  window.addEventListener('hashchange', schedule);
  window.addEventListener('urlchange', schedule);
  window.addEventListener('pageshow', schedule);
  window.addEventListener('storage', e => {
    if (e.key === NS + 'filter') {
      const value = storage.get('filter');
      if ([0, 6, 7, 8].includes(value)) {
        minimum = value;
        for (const card of document.querySelectorAll(CARD)) applyFilter(card, states.get(card)?.result);
        updateToolbar();
      }
    }
  });
  function importRating(record) {
    if (!record?.imdbID) return;
    imdbWaiters.get(record.requestedID || record.imdbID)?.(record);
    for (const [card, data] of recordsOnPage()) {
      const key = identityKey(data), cached = storage.get('cache:' + key);
      const result = states.get(card)?.result || cached?.result;
      if (!result?.imdbID || !sharedMatches(record, data, result.imdbID)) continue;
      storage.set('cache:' + key, { version: 2, until: record.until, result: record });
      memo.set(key, Promise.resolve(record)); memoUntil.set(key, record.until);
      const state = states.get(card);
      if (state) { state.result = record; state.until = record.until; paint(card, data, record); }
    }
    refreshToolbar();
  }
  if (typeof GM_addValueChangeListener === 'function') {
    GM_addValueChangeListener('wm-imdb-last-import', (_name, _old, record) => importRating(record));
  }
  window.addEventListener('focus', () => importRating(shared.get('wm-imdb-last-import')));
  scan();
})();
