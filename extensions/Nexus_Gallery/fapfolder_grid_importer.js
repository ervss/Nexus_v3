(function () {
    'use strict';

    if (window.top !== window) return;
    if (!/(^|\.)fapfolder\.club$/i.test(location.hostname)) return;

    const TOOLBAR_ID = 'nexus-ff-toolbar';
    const BUBBLE_ID = 'nexus-ff-bubble';
    const CHECK_CLASS = 'nexus-ff-check';
    const META_CLASS = 'nexus-ff-meta';
    const STORAGE_MIN_KEY = 'nexus_ff_minimized';
    const STORAGE_TAB_KEY = 'nexus_ff_tab';
    const SOURCES_KEY = 'nexus_ff_mix_sources_v1';
    const VIDEO_LINK_SELECTOR = 'a.pg_video[href*="/posts/"], a.js_moment[href*="/posts/"], a[href*="/video/"], a[href*="/videos/"]';

    const state = {
        items: new Map(),
        busy: false,
        lastHash: '',
        hydrated: new Set(),
        hydrating: false,
        hydrateQueue: [],
        durationQueue: [],
        durationActive: 0,
        lastHydrateAt: 0,
        minimized: localStorage.getItem(STORAGE_MIN_KEY) === 'true',
        tab: localStorage.getItem(STORAGE_TAB_KEY) === 'library' ? 'library' : 'communities',
        fetchProgress: '',
        fetchCancelled: false,
        filters: { sort: 'original', direction: 'desc', durationMin: '', durationMax: '', sizeMin: '', sizeMax: '' },
        excludedQualities: new Set(),
        nextIndex: 0,
        sources: new Map(),
        communitySort: 'original',
        adopted: new Map(),
        mixActive: false,
        mixProgress: '',
        collecting: false,
        collectionAbort: null,
        searchText: '',
        // História: čo už bolo načítané alebo importované (drží sa na disku).
        cacheIndex: new Map(),
        history: { libraries: [], sources: [], imports: [] },
        historyPurgeArmed: false,
    };

    function getEl(id) {
        if (!id || typeof document === 'undefined') return null;
        if (typeof document.getElementById === 'function') return document.getElementById(id);
        return document.querySelector ? document.querySelector('#' + id) : null;
    }

    function toast(message, isError = false) {
        let el = getEl('nexus-ff-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'nexus-ff-toast';
            el.className = 'nexus-ff-toast';
            document.body.appendChild(el);
        }
        el.textContent = message;
        el.dataset.error = isError ? '1' : '0';
        el.classList.add('visible');
        clearTimeout(el._timer);
        el._timer = setTimeout(() => el.classList.remove('visible'), 3200);
    }

    function parseBackgroundUrl(el) {
        const style = el?.getAttribute?.('style') || '';
        const match = style.match(/background-image\s*:\s*url\((['"]?)(.*?)\1\)/i);
        if (!match?.[2]) return '';
        try { return new URL(match[2], location.href).href; } catch { return match[2]; }
    }

    function parseSizeMb(text) {
        const m = String(text || '').match(/\b(\d+(?:[.,]\d+)?)\s*(GB|GiB|MB|MiB)\b/i);
        if (!m) return null;
        const value = Number.parseFloat(m[1].replace(',', '.'));
        if (!Number.isFinite(value)) return null;
        return /^g/i.test(m[2]) ? value * 1024 : value;
    }

    function parseDuration(text) {
        const raw = String(text || '').trim();
        const colon = raw.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
        if (colon) {
            const a = Number.parseInt(colon[1], 10);
            const b = Number.parseInt(colon[2], 10);
            const c = colon[3] ? Number.parseInt(colon[3], 10) : null;
            return c == null ? a * 60 + b : a * 3600 + b * 60 + c;
        }
        return 0;
    }

    function formatDuration(seconds) {
        const total = Math.max(0, Math.round(Number(seconds || 0)));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = Math.floor(total % 60);
        if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function formatSize(mb) {
        const value = Number(mb || 0);
        if (!Number.isFinite(value) || value <= 0) return '';
        if (value < 1) return `${(value * 1024).toFixed(1)} KB`;
        if (value >= 1024) return `${(value / 1024).toFixed(2)} GB`;
        return `${Math.round(value)} MB`;
    }

    function formatNumber(value) {
        return Number(value).toLocaleString('sk-SK', { maximumFractionDigits: 2 });
    }

    function formatTotalSize(mb) {
        return mb >= 1024 ? `${formatNumber(mb / 1024)} GB` : `${formatNumber(mb)} MB`;
    }

    /* --------------------------------------------- trvalá pamäť metadát (veľkosť, kvalita, dĺžka) */
    const VIDEO_META_STORE = 'nexus_ff_meta_v2';
    function getStoredMeta(key) {
        if (!key) return null;
        try {
            const raw = localStorage.getItem(`${VIDEO_META_STORE}_${key}`);
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    }
    function saveStoredMeta(key, item) {
        if (!key || !item) return;
        try {
            const data = {
                streamUrl: item.streamUrl || '',
                sizeMb: item.sizeMb || null,
                duration: item.duration || 0,
                width: item.width || 0,
                height: item.height || 0,
                quality: item.quality || '',
                sizeExact: Boolean(item.sizeExact),
                addedAt: item.addedAt || '',
                savedAt: Date.now()
            };
            localStorage.setItem(`${VIDEO_META_STORE}_${key}`, JSON.stringify(data));
        } catch {}
    }
    function hydrateItemMeta(item) {
        if (!item) return;
        const cached = getStoredMeta(item.id) || (item.url ? getStoredMeta(item.url) : null);
        if (cached && (cached.sizeMb || cached.duration || cached.quality || cached.streamUrl)) {
            if (cached.duration && !item.duration) item.duration = cached.duration;
            if (cached.sizeMb && !item.sizeMb) { item.sizeMb = cached.sizeMb; item.sizeText = formatSize(item.sizeMb); }
            if (cached.quality && !item.quality) item.quality = cached.quality;
            if (cached.width && !item.width) item.width = cached.width;
            if (cached.height && !item.height) item.height = cached.height;
            if (cached.streamUrl && !item.streamUrl) item.streamUrl = cached.streamUrl;
            item.metadataAttempted = true;
        }
    }

    /* --------------------------------------------- historia (IndexedDB) — start
       Už načítané komunity a knižnice sa ukladajú na disk prehliadača, aby sa pri
       ďalšom otvorení dali doručiť okamžite a proti sieti sa len overili.
       Celý blok je samostatný, aby ho tests/fapfolder_history.test.cjs vedel
       spustiť s pamäťovou databázou. */
    const CACHE_DB_NAME = 'nexus_ff_cache_v1';
    const CACHE_FRESH_MS = 15 * 60 * 1000;
    const CACHE_MAX_ITEMS = 4000;
    const CACHE_MAX_LIBRARIES = 20;
    const CACHE_MAX_IMPORTS = 40;
    const CACHE_STORES = {
        // Komunity: kľúčom je normalizovaný odkaz zdroja.
        sources: { keyPath: 'key', autoIncrement: false },
        // Knižnice: kľúčom je zoradený zoznam zdrojov, takže tá istá kombinácia sa aktualizuje.
        libraries: { keyPath: 'key', autoIncrement: false },
        imports: { keyPath: 'id', autoIncrement: true },
    };

    function createNexusFfCache(openDatabase) {
        let openPromise = null;
        let warned = false;

        function warn(error) {
            if (warned) return;
            warned = true;
            console.warn('[nexus-ff] históriu sa nepodarilo uložiť:', error?.message || error);
        }

        function open() {
            if (!openPromise) {
                openPromise = Promise.resolve().then(openDatabase).catch(error => {
                    openPromise = null;
                    warn(error);
                    throw error;
                });
            }
            return openPromise;
        }

        // Best effort: história nesmie nikdy zhodiť samotné načítanie videí.
        // Preto sa chyba uloženia ohlási raz do konzoly a vráti sa null.
        // Zápisy preto vracajú boolean, aby volajúci nehlásil uloženie, ktoré
        // sa nepodarilo.
        function run(storeName, mode, work) {
            return open().then(db => new Promise((resolve, reject) => {
                let request = null;
                const tx = db.transaction(storeName, mode);
                tx.oncomplete = () => resolve(request ? request.result : undefined);
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
                request = work(tx.objectStore(storeName));
            })).catch(error => { warn(error); return null; });
        }

        async function getSource(key) {
            const record = await run('sources', 'readonly', os => os.get(key));
            return record && Array.isArray(record.items) ? record : null;
        }

        async function putSource(record) {
            return (await run('sources', 'readwrite', os => os.put(record))) !== null;
        }

        async function listSources() {
            const rows = await run('sources', 'readonly', os => os.getAll());
            return (rows || []).filter(row => row?.key).sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0));
        }

        async function deleteSource(key) {
            await run('sources', 'readwrite', os => os.delete(key));
        }

        async function getLibrary(key) {
            return (await run('libraries', 'readonly', os => os.get(key))) || null;
        }

        async function saveLibrary(record) {
            return (await run('libraries', 'readwrite', os => os.put(record))) !== null;
        }

        async function listLibraries() {
            const rows = await run('libraries', 'readonly', os => os.getAll());
            return (rows || []).filter(row => row?.key).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        }

        async function deleteLibrary(key) {
            await run('libraries', 'readwrite', os => os.delete(key));
        }

        async function logImport(record) {
            await run('imports', 'readwrite', os => os.add(record));
        }

        async function listImports() {
            const rows = await run('imports', 'readonly', os => os.getAll());
            return (rows || []).filter(row => row?.at).sort((a, b) => (b.at || 0) - (a.at || 0));
        }

        async function deleteImport(id) {
            await run('imports', 'readwrite', os => os.delete(id));
        }

        async function clear() {
            for (const name of Object.keys(CACHE_STORES)) await run(name, 'readwrite', os => os.clear());
        }

        // História rastie len do počtu posledných knižníc a importov; staršie záznamy sa zahodia.
        async function prune() {
            const libraries = await listLibraries();
            for (const row of libraries.slice(CACHE_MAX_LIBRARIES)) await deleteLibrary(row.key);
            const imports = await listImports();
            for (const row of imports.slice(CACHE_MAX_IMPORTS)) await run('imports', 'readwrite', os => os.delete(row.id));
        }

        return { getSource, putSource, listSources, deleteSource, getLibrary, saveLibrary, listLibraries, deleteLibrary, logImport, listImports, deleteImport, clear, prune };
    }

    function openCacheDatabase() {
        return new Promise((resolve, reject) => {
            if (typeof indexedDB === 'undefined' || !indexedDB) { reject(new Error('IndexedDB nie je dostupné')); return; }
            const request = indexedDB.open(CACHE_DB_NAME, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                for (const [name, config] of Object.entries(CACHE_STORES)) {
                    if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, config);
                }
            };
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => db.close();
                resolve(db);
            };
            request.onerror = () => reject(request.error || new Error('IndexedDB sa nedá otvoriť'));
        });
    }

    const cache = createNexusFfCache(openCacheDatabase);

    function formatAgo(timestamp) {
        const value = Number(timestamp);
        // Nula alebo nezmysel znamená "nikdy", nie 1. 1. 1970.
        if (!Number.isFinite(value) || value <= 0) return 'neznámy čas';
        const elapsed = Date.now() - value;
        if (elapsed < 0) return 'neznámy čas';
        const minutes = Math.floor(elapsed / 60000);
        if (minutes < 1) return 'práve teraz';
        if (minutes < 60) return `pred ${minutes} min`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `pred ${hours} h`;
        const days = Math.floor(hours / 24);
        if (days < 30) return `pred ${days} ${days === 1 ? 'dňom' : 'dňami'}`;
        return new Date(Number(timestamp)).toLocaleDateString('sk-SK');
    }

    // Do histórie ide iba trvalé metadata. Podpísané stream odkazy vypršia a data:
    // náhľady sú príliš veľké, preto sa neukladajú.
    function cacheableItem(item) {
        return {
            id: item.id,
            url: item.url,
            title: item.title || '',
            thumbnail: /^https?:/i.test(item.thumbnail || '') ? item.thumbnail : '',
            duration: Number(item.duration) || 0,
            quality: item.quality || '',
            width: Number(item.width) || 0,
            height: Number(item.height) || 0,
            sizeMb: Number(item.sizeMb) > 0 ? Number(item.sizeMb) : null,
            addedAt: item.addedAt || '',
            sources: [...(item.sources || [])],
        };
    }

    function summarizeCache(record) {
        if (!record) return null;
        return {
            count: Number(record.count) || 0,
            total: Number(record.total ?? record.count) || 0,
            complete: Boolean(record.complete),
            truncated: Boolean(record.truncated),
            fetchedAt: Number(record.fetchedAt) || 0,
            verifiedAt: Number(record.verifiedAt) || 0,
            name: record.name || '',
        };
    }

    /* Uloží komunitu do histórie. Neúplný kratší beh nikdy neprepíše dlhší
       kompletný záznam, aby sa zastavené načítanie nepodpísalo pod históriu. */
    async function persistSource(source, items, extra = {}) {
        const list = (items || []).filter(item => item?.id && item?.url);
        if (!list.length) return null;
        const previous = await cache.getSource(source.url);
        const complete = Boolean(extra.complete);
        if (!complete && previous?.complete && (Number(previous.count) || 0) >= list.length) return previous;
        const truncated = list.length > CACHE_MAX_ITEMS;
        const record = {
            key: source.url,
            url: source.url,
            name: source.name || previous?.name || '',
            items: list.slice(0, CACHE_MAX_ITEMS).map(cacheableItem),
            count: Math.min(list.length, CACHE_MAX_ITEMS),
            total: list.length,
            truncated,
            complete,
            freshCount: Number(extra.freshCount) || 0,
            removedCount: Number(extra.removed) || 0,
            status: source.status || previous?.status || '',
            fetchedAt: Date.now(),
            verifiedAt: complete ? Date.now() : (Number(previous?.verifiedAt) || null),
        };
        // Keď sa zápis nepodarí (napr. zakázaná IndexedDB), nehlási sa úspech
        // a zdroj si nesmie myslieť, že je v histórii.
        if (!await cache.putSource(record)) return null;
        source.cache = summarizeCache(record);
        return record;
    }

    // Doplní do histórie veľkosti a dĺžky zistené pri "Zistiť údaje", aby ďalšie
    // otvorenie knižnice ukázalo metriky bez siete.
    async function mergeCacheMetrics(url, metrics) {
        const record = await cache.getSource(url);
        if (!record?.items?.length || !metrics?.size) return;
        let changed = 0;
        const items = record.items.map(item => {
            const metric = metrics.get(item.id);
            if (!metric) return item;
            const next = { ...item };
            if (Number(metric.sizeMb) > 0 && Number(metric.sizeMb) !== Number(item.sizeMb)) { next.sizeMb = Number(metric.sizeMb); changed++; }
            if (Number(metric.duration) > 0 && Number(metric.duration) !== Number(item.duration)) { next.duration = Number(metric.duration); changed++; }
            return next;
        });
        if (!changed) return;
        await cache.putSource({ ...record, items });
    }

    /* Z uloženého záznamu spraví rovnaký útvar, aký používa "Zistiť údaje",
       takže karty komunít vedia ukázať metriky z histórie bez siete. */
    function cacheJobFromRecord(record) {
        const items = new Map();
        const metrics = new Map();
        for (const item of record.items || []) { items.set(item.id, item); metrics.set(item.id, item); }
        return {
            url: record.key,
            name: record.name || '',
            phase: 'cached',
            items,
            metrics,
            listComplete: Boolean(record.complete),
            error: '',
            fromCache: true,
            fetchedAt: Number(record.fetchedAt) || 0,
            total: Number(record.total ?? record.count) || items.size,
        };
    }
    /* ----------------------------------------------- historia (IndexedDB) — end */

    function collectCard(card) {
        const anchor = card.matches(VIDEO_LINK_SELECTOR) ? card : card.querySelector(VIDEO_LINK_SELECTOR);
        if (!anchor) return null;
        const rawHref = anchor.getAttribute('href') || '';
        let parsedUrl;
        try { parsedUrl = new URL(rawHref, location.href); } catch { return null; }
        if (!/(^|\.)fapfolder\.club$/i.test(parsedUrl.hostname)) return null;
        const m = parsedUrl.pathname.match(/^\/(posts|videos?)\/([a-zA-Z0-9_-]+)\/?$/i);
        if (!m) return null;
        const url = parsedUrl.href;
        const id = `${m[1].toLowerCase()}:${m[2]}`;
        const titleEl = card.querySelector('.title, h3, h4, .video-title') || anchor;
        const title = (titleEl?.getAttribute('title') || card.querySelector('img')?.getAttribute('alt') || titleEl?.textContent || '').trim() || `FapFolder video ${m[2]}`;
        const thumbEl = card.querySelector('.thumb, .preview, [style*="background-image"]') || card;
        const thumbnail = parseBackgroundUrl(thumbEl) || card.querySelector('img')?.src || '';
        const cleanCard = card.cloneNode(true);
        cleanCard.querySelectorAll('[class^="nvs-"], [class*=" nvs-"], .nexus-ff-check, .nexus-ff-meta, .nexus-ff-date').forEach((el) => el.remove());
        const textContent = cleanCard.textContent || '';
        const duration = parseDuration(textContent);
        const sizeMb = parseSizeMb(textContent);
        return {
            id,
            url,
            title,
            thumbnail,
            duration,
            quality: /4k|2160/i.test(textContent) ? '4K' : /1080/i.test(textContent) ? '1080p' : /720/i.test(textContent) ? '720p' : '',
            sizeMb,
            sizeText: sizeMb ? formatSize(sizeMb) : '',
            card,
            selected: !!state.items.get(id)?.selected,
        };
    }

    function isFeedVideoCard(card) {
        const postTime = card?.querySelector?.('.post-time')?.textContent || '';
        return /\badded video\b/i.test(postTime) || !!card?.querySelector?.('video, .video-auth-placeholder-thumb, .vid-placeholder');
    }

    function scanCards() {
        scanSources();
        if (state.mixActive) { applyView(); updateUi(); return; }
        const cards = Array.from(document.querySelectorAll(VIDEO_LINK_SELECTOR)).map((anchor) => anchor.closest('.post, .video-card, .grid-item') || anchor);
        for (const el of cards) {
            if (location.pathname === '/' && el.matches('.post') && !isFeedVideoCard(el)) continue;
            const item = collectCard(el);
            if (!item || !item.url) continue;
            hydrateItemMeta(item);
            const existing = state.items.get(item.id);
            if (existing) {
                existing.card = item.card;
                existing.thumbnail = item.thumbnail || existing.thumbnail;
                hydrateItemMeta(existing);
                upsertUi(existing);
            } else {
                item.originalIndex = state.nextIndex++;
                state.items.set(item.id, item);
                upsertUi(item);
            }
        }
        for (const [id, item] of state.items) {
            if (!item.card?.isConnected) state.items.delete(id);
        }
        applyView();
        updateUi();
        queueDateFetch();
        feedPanelApply();
    }

    const dateCache = new Map();
    let dateFetchRunning = false;

    function queueDateFetch() {
        for (const item of state.items.values()) {
            if (!item.addedAt && dateCache.has(item.id)) { item.addedAt = dateCache.get(item.id); upsertUi(item); }
        }
        if (dateFetchRunning) return;
        dateFetchRunning = true;
        (async () => {
            try {
                for (;;) {
                    const batch = Array.from(state.items.values())
                        .filter((i) => !i.addedAt && !i.dateTried && i.card?.isConnected)
                        .slice(0, 6);
                    if (!batch.length) break;
                    batch.forEach((i) => { i.dateTried = true; });
                    const res = await new Promise((resolve) => {
                        try {
                            chrome.runtime.sendMessage({ action: 'FAPFOLDER_FETCH_DATES', items: batch.map(({ id, url }) => ({ id, url })) }, (r) => resolve(chrome.runtime.lastError ? null : r));
                        } catch { resolve(null); }
                    });
                    for (const row of res?.items || []) {
                        const item = state.items.get(row?.id);
                        if (!row?.addedAt || !item) continue;
                        item.addedAt = row.addedAt;
                        dateCache.set(row.id, row.addedAt);
                        upsertUi(item);
                    }
                    await new Promise((r) => setTimeout(r, 400));
                }
            } finally { dateFetchRunning = false; }
        })();
    }

    // Default import / Source Board name = the group (page) name shown on the profile header.
    function detectGroupName() {
        if (state.mixActive) return 'FapFolder Mix';
        const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\s*[-|–·]\s*FapFolder.*$/i, '').trim();
        const fromSlug = () => {
            const m = location.pathname.match(/^\/(?:groups?|pages?|users?|u|profile)\/([^/]+)/i);
            return m ? decodeURIComponent(m[1]) : '';
        };
        const selectors = ['.profile-name', '.group-name', '.page-name', '.cover-title', '.profile-title', 'h1'];
        for (const sel of selectors) {
            for (const el of document.querySelectorAll(sel)) {
                if (el.closest(`#${TOOLBAR_ID}`)) continue;
                const t = clean(el.textContent);
                if (t && t.length < 120) return t;
            }
        }
        const og = clean(document.querySelector('meta[property="og:title"]')?.content);
        if (og && !/^videos?$/i.test(og)) return og;
        return fromSlug() || clean(document.title) || '';
    }

    function isHd(item) {
        const shortEdge = Math.min(Number(item.width) || 0, Number(item.height) || 0);
        if (shortEdge >= 720) return true;
        return /^(720p|1080p|1440p|4K)$/i.test(String(item.quality || ''));
    }

    // Compact, honest metadata line for a combined-library card.
    function renderMixCardMeta(item) {
        const card = item.card;
        const meta = card?.querySelector?.('.nexus-ff-mix-meta');
        const duration = card?.querySelector?.('.nexus-ff-duration');
        if (!meta) return;
        if (duration) {
            if (item.duration > 0) {
                duration.textContent = formatDuration(item.duration);
                duration.hidden = false;
            } else {
                duration.textContent = '';
                duration.hidden = true;
            }
        }
        const parts = [];
        if (item.sizeMb > 0) parts.push(formatSize(item.sizeMb));
        const shortEdge = Math.min(Number(item.width) || 0, Number(item.height) || 0);
        if (shortEdge > 0) parts.push(item.quality || `${shortEdge}p`);
        meta.replaceChildren();
        if (parts.length) {
            const text = document.createElement('span');
            text.textContent = parts.join(' · ');
            meta.append(text);
        }
        if (isHd(item)) {
            const chip = document.createElement('span');
            chip.className = 'nexus-ff-hd-chip';
            chip.textContent = 'HD';
            meta.append(chip);
        }
        meta.dataset.error = '0';
        if (item.metadataError) meta.title = item.metadataError;
    }

    function upsertUi(item) {
        if (!item?.card || !item.card.isConnected) return;
        const isMixCard = item.card.classList.contains('nexus-ff-mix-card');
        const isPost = item.card.matches?.('.post') || !!item.card.closest?.('.js_posts_stream');
        const mediaHost = isPost ? (item.card.querySelector('.overflow-hidden.clearfix, .pg_wrapper') || item.card) : item.card;
        const host = isMixCard ? (item.card.querySelector('.nexus-ff-poster') || item.card) : mediaHost;
        if (window.getComputedStyle(host).position === 'static') host.style.position = 'relative';

        item.card.dataset.selected = item.selected ? '1' : '0';

        let check = host.querySelector(`.${CHECK_CLASS}`);
        if (!check) {
            check = document.createElement('label');
            check.className = CHECK_CLASS;
            check.innerHTML = `<input type="checkbox"><span></span>`;
            check.onclick = (e) => e.stopPropagation();
            check.querySelector('input').onchange = (e) => {
                item.selected = e.target.checked;
                item.card.dataset.selected = item.selected ? '1' : '0';
                updateUi();
            };
            host.appendChild(check);
        }
        const input = check.querySelector('input');
        input.setAttribute('aria-label', `Vybrať video: ${item.title}`);
        if (input && input.checked !== item.selected) input.checked = item.selected;

        if (!isMixCard && !isPost) {
            let playBtn = host.querySelector('.nexus-ff-card-play');
            if (!playBtn) {
                playBtn = document.createElement('button');
                playBtn.type = 'button';
                playBtn.className = 'nexus-ff-card-play';
                playBtn.setAttribute('aria-label', `Prehrať: ${item.title}`);
                playBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
                playBtn.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openVideoModal(item);
                };
                host.appendChild(playBtn);
            }
        }

        if (isMixCard) { renderMixCardMeta(item); return; }

        if (item.addedAt && !isPost) {
            let date = item.card.querySelector('.nexus-ff-date');
            if (!date) {
                date = document.createElement('div');
                date.className = 'nexus-ff-date';
                item.card.appendChild(date);
            }
            const [day, time] = item.addedAt.split(' ');
            date.textContent = day.split('-').reverse().join('.') + ' ' + (time || '').slice(0, 5);
            date.title = `Added on FapFolder: ${item.addedAt} (site time)`;
            date.onclick = event => { event.preventDefault(); event.stopPropagation(); };
        }
        if (item.metadataAttempted || item.metadataLoading) {
            const metaContainer = isPost ? mediaHost : item.card;
            let meta = metaContainer.querySelector(`.${META_CLASS}`);
            if (!meta) {
                meta = document.createElement('div');
                meta.className = META_CLASS;
                metaContainer.appendChild(meta);
            }
            const parts = [
                item.duration > 0 ? formatDuration(item.duration) : '',
                item.width && item.height ? `${item.width}×${item.height} (${item.quality})` : (item.quality || ''),
                item.sizeMb > 0 ? formatSize(item.sizeMb) : '',
            ].filter(Boolean);
            meta.textContent = item.metadataLoading ? 'Zisťujem údaje...' : (parts.length ? parts.join(' · ') : '');
            meta.hidden = !item.metadataLoading && !parts.length;
            meta.title = item.metadataError || 'Measured from the video file; size is exact when reported by the server.';
            meta.dataset.error = item.metadataError ? '1' : '0';
            meta.onclick = (event) => { event.preventDefault(); event.stopPropagation(); };
        }
    }

    function selectedItems() {
        return Array.from(state.items.values()).filter((i) => i.selected && i.card?.isConnected && !i.filteredOut);
    }

    function visibleItems() {
        return Array.from(state.items.values()).filter((i) => i.card?.isConnected && !i.filteredOut);
    }

    function qualityKey(item) {
        return item.width > 0 && item.height > 0 ? `${Math.min(item.width, item.height)}p` : 'Unknown';
    }

    function matchesFilters(item) {
        if (state.mixActive) {
            const activeSources = selectedSources();
            if (activeSources.length === 0) return false;
            const activeNames = new Set(activeSources.map(s => (s.name || '').trim().toLowerCase()));
            const activeUrls = new Set(activeSources.map(s => (s.url || '').trim().toLowerCase()));
            const itemSources = item.sources instanceof Set ? [...item.sources] : (Array.isArray(item.sources) ? item.sources : []);
            const itemUrls = item.sourceUrls instanceof Set ? [...item.sourceUrls] : (Array.isArray(item.sourceUrls) ? item.sourceUrls : []);
            const matchName = itemSources.some(name => activeNames.has(String(name || '').trim().toLowerCase()));
            const matchUrl = itemUrls.some(u => activeUrls.has(String(u || '').trim().toLowerCase()));
            if (!matchName && !matchUrl) return false;
        }
        const f = state.filters;
        if (state.excludedQualities.has(qualityKey(item))) return false;
        for (const [value, min, max] of [[item.duration / 60, f.durationMin, f.durationMax], [item.sizeMb, f.sizeMin, f.sizeMax]]) {
            if (min === '' && max === '') continue;
            if (!(value > 0)) return false;
            if (min !== '' && value < Number(min)) return false;
            if (max !== '' && value > Number(max)) return false;
        }
        return true;
    }

    function hasActiveFilters() {
        const f = state.filters;
        return f.sort !== 'original' || f.direction !== 'desc' || f.durationMin !== '' || f.durationMax !== ''
            || f.sizeMin !== '' || f.sizeMax !== '' || state.excludedQualities.size > 0 || !!state.searchText;
    }

    function compareItems(a, b) {
        const key = state.filters.sort;
        if (key === 'original') return a.originalIndex - b.originalIndex;
        const value = item => key === 'quality' ? Math.min(item.width || 0, item.height || 0) : Number(item[key] || 0);
        const av = value(a), bv = value(b);
        if (!av || !bv) return av ? -1 : bv ? 1 : a.originalIndex - b.originalIndex;
        return (state.filters.direction === 'asc' ? av - bv : bv - av) || a.originalIndex - b.originalIndex;
    }

    function applyView() {
        const items = Array.from(state.items.values()).filter(item => item.card?.isConnected);
        const groups = new Map();
        for (const item of items) {
            let passPill = true;
            if (state.pillFilter === 'fav') passPill = !!item.selected;
            else if (state.pillFilter === 'hd') passPill = isHd(item) || (item.height >= 1080);
            else if (state.pillFilter === 'short') passPill = (item.duration > 0 && item.duration < 60);
            else if (state.pillFilter === 'long') passPill = (item.duration >= 180);

            item.filteredOut = !passPill || !matchesFilters(item) || !!(state.searchText && !`${item.title} ${[...(item.sources || [])].join(' ')}`.toLocaleLowerCase().includes(state.searchText));
            const tile = item.card.closest?.('li') || item.card;
            if (!tile.style) continue;
            tile.classList.toggle('nexus-ff-filtered', item.filteredOut);
            const parent = tile.parentElement;
            if (!parent) continue;
            if (!groups.has(parent)) groups.set(parent, []);
            groups.get(parent).push({ item, tile });
        }
        for (const [parent, entries] of groups) {
            const sorted = entries.slice().sort((a, b) => compareItems(a.item, b.item));
            const tiles = new Set(entries.map(entry => entry.tile));
            const current = Array.from(parent.children).filter(child => tiles.has(child));
            if (sorted.some((entry, index) => entry.tile !== current[index])) sorted.forEach(entry => parent.appendChild(entry.tile));
        }
        const list = document.querySelector?.('.nexus-ff-qualities');
        if (list) {
            const keys = [...new Set(items.map(qualityKey))].sort((a, b) => (parseInt(b) || 0) - (parseInt(a) || 0));
            for (const key of keys) {
                let input = Array.from(list.querySelectorAll('input')).find(el => el.value === key);
                if (!input) {
                    const label = document.createElement('label');
                    input = document.createElement('input');
                    input.type = 'checkbox'; input.value = key; input.checked = !state.excludedQualities.has(key);
                    input.addEventListener('change', () => {
                        if (input.checked) state.excludedQualities.delete(key); else state.excludedQualities.add(key);
                        applyView(); updateUi();
                    });
                    label.append(input, document.createTextNode(key)); list.appendChild(label);
                }
            }
            for (const input of list.querySelectorAll('input')) input.parentElement.hidden = !keys.includes(input.value);
        }
        renderLibraryState();
    }

    function resetAllFilters() {
        const bar = getEl(TOOLBAR_ID);
        Object.assign(state.filters, { sort: 'original', direction: 'desc', durationMin: '', durationMax: '', sizeMin: '', sizeMax: '' });
        state.excludedQualities.clear();
        state.searchText = '';
        bar?.querySelectorAll('[data-filter]').forEach(control => { control.value = state.filters[control.dataset.filter]; });
        bar?.querySelectorAll('.nexus-ff-qualities input').forEach(input => { input.checked = true; });
        const search = bar?.querySelector('.nexus-ff-search');
        if (search) search.value = '';
        applyView(); updateUi();
    }

    // Loading / initial / filtered-empty / complete states for the combined library.
    function renderLibraryState() {
        const panel = getEl('nexus-ff-mix');
        if (!panel) return;
        const grid = panel.querySelector('.nexus-ff-mix-grid');
        const loading = panel.querySelector('.nexus-ff-loading');
        const empty = panel.querySelector('.nexus-ff-empty');
        const items = Array.from(state.items.values()).filter(item => item.card?.isConnected);
        const shown = items.filter(item => !item.filteredOut);
        if (loading) {
            const active = state.collecting;
            loading.hidden = !active;
            if (active) loading.textContent = state.mixProgress || 'Načítavam videá zo zdrojov...';
        }
        if (!empty) return;
        empty.hidden = shown.length > 0 || state.collecting;
        if (empty.hidden) { panel.dataset.state = 'ready'; return; }
        const kind = items.length ? 'filtered' : (state.mixActive ? 'empty' : 'initial');
        panel.dataset.state = kind;
        // Rebuilt only when the message actually changes: this runs on the page
        // scan interval, and rebuilding every tick detached the reset button
        // mid-click (and dropped keyboard focus).
        const withReset = items.length > 0 && hasActiveFilters();
        const key = `${kind}|${withReset ? 'reset' : 'plain'}`;
        if (panel.dataset.emptyKey === key) return;
        panel.dataset.emptyKey = key;
        empty.replaceChildren();
        const message = document.createElement('p');
        message.textContent = items.length
            ? 'Žiadne videá nezodpovedajú filtrom ani hľadaniu.'
            : state.mixActive
                ? 'Vybrané zdroje nevrátili žiadne videá. Skús iný zdroj alebo zopakuj načítanie.'
                : 'Zatiaľ tu nie sú videá. Vyber komunity alebo pridaj odkaz vľavo a klikni na „Načítať všetky videá“.';
        empty.append(message);
        if (withReset) {
            const reset = document.createElement('button');
            reset.type = 'button';
            reset.textContent = 'Zrušiť filtre';
            reset.onclick = () => resetAllFilters();
            empty.append(reset);
        }
    }

    function updateUi() {
        const bar = getEl(TOOLBAR_ID);
        const bubble = getEl(BUBBLE_ID);
        const selected = selectedItems().length;
        const visible = visibleItems().length;

        if (bar) {
            const heroTitle = bar.querySelector('.nexus-ff-hero-title');
            if (heroTitle) {
                const selected = selectedSources();
                if (selected.length === 1) heroTitle.textContent = selected[0].name;
                else if (selected.length > 1) heroTitle.textContent = `${selected[0].name} + ${selected.length - 1} ďalších`;
                else heroTitle.textContent = 'Spoločná knižnica';
            }
            const vaultTotal = bar.querySelector('[data-role="vault-total"]');
            if (vaultTotal) {
                const totalVideos = state.items.size;
                const totalMb = [...state.items.values()].reduce((sum, i) => sum + (i.sizeMb || 0), 0);
                vaultTotal.textContent = `${totalVideos} videí (${formatTotalSize(totalMb) || '0 MB'})`;
            }
            const stats = bar.querySelector('.nexus-ff-stats');
            if (stats) stats.textContent = `${selected} vybraných · ${visible} zobrazených / ${state.items.size} videí`;
            const metrics = bar.querySelector('.nexus-ff-library-metrics');
            if (metrics) {
                const values = visibleItems(), sizes = values.filter(i => i.sizeMb > 0), durations = values.filter(i => i.duration > 0);
                const mb = sizes.reduce((sum, i) => sum + i.sizeMb, 0);
                const coverage = count => count === values.length ? '' : ` (${count}/${values.length})`;
                metrics.textContent = `${values.length} videí · ${sizes.length ? formatTotalSize(mb) + coverage(sizes.length) : '— GB'} · ${durations.length ? formatDuration(durations.reduce((sum, i) => sum + i.duration, 0) / durations.length) + coverage(durations.length) : '—'} priemer`;
            }
            const selectionSummary = bar.querySelector('[data-role="selection-summary"]');
            if (selectionSummary) {
                const chosen = selectedItems();
                const mb = chosen.filter(i => i.sizeMb > 0).reduce((sum, i) => sum + i.sizeMb, 0);
                const n = chosen.length;
                const label = n === 1 ? 'video vybrané' : (n >= 2 && n <= 4) ? 'videá vybrané' : 'videí vybraných';
                selectionSummary.textContent = `${n} ${label}${mb > 0 ? ` · ${formatTotalSize(mb)}` : ''}`;
            }
            const selBtn = bar.querySelector('[data-role="import-selected"]');
            if (selBtn) selBtn.disabled = selected === 0 || state.busy || state.hydrating || state.collecting;
            const visBtn = bar.querySelector('[data-role="import-visible"]');
            if (visBtn) visBtn.disabled = visible === 0 || state.busy || state.hydrating || state.collecting;
            const clearBtn = bar.querySelector('[data-role="clear"]');
            if (clearBtn) clearBtn.disabled = selected === 0;
            const fetchBtn = bar.querySelector('[data-role="fetch-meta"]');
            if (fetchBtn) fetchBtn.disabled = visible === 0 || state.busy || state.hydrating || state.collecting;
            const hdBtn = bar.querySelector('[data-role="hd-thumbs"]');
            if (hdBtn) hdBtn.disabled = visible === 0 || state.busy || state.hydrating || state.collecting;
            const cancelBtn = bar.querySelector('[data-role="cancel-meta"]');
            if (cancelBtn) {
                cancelBtn.hidden = !state.hydrating;
                cancelBtn.disabled = state.fetchCancelled;
            }
            const progress = bar.querySelector('.nexus-ff-progress');
            if (progress) {
                progress.textContent = state.fetchProgress;
                progress.hidden = !state.fetchProgress;
            }
            const build = bar.querySelector('[data-role="build-mix"]');
            if (build) build.disabled = state.collecting || !selectedSources().length;
            const openLibrary = bar.querySelector('[data-role="open-library"]');
            if (openLibrary) openLibrary.disabled = state.collecting || !selectedSources().length;
            const paneCount = bar.querySelector('[data-role="pane-count"]');
            if (paneCount) paneCount.textContent = `${selectedSources().length} vybraných`;
            updateCommunitySummary(bar);
        }

        if (bubble) {
            const badge = bubble.querySelector('.nexus-ff-bubble-badge');
            if (badge) {
                badge.textContent = String(selected);
                badge.classList.toggle('visible', selected > 0);
            }
        }
    }

    function selectedSources() {
        return [...state.sources.values()].filter(source => source.selected);
    }

    function setBusy(next) {
        state.busy = !!next;
        updateUi();
    }

    let workspaceVisible = false;

    function setWorkspaceVisible(visible) {
        const bar = getEl(TOOLBAR_ID);
        const bubble = getEl(BUBBLE_ID);
        workspaceVisible = !!visible;
        if (bar) bar.classList.toggle('nexus-hidden', !workspaceVisible);
        if (bubble) bubble.classList.toggle('nexus-hidden', workspaceVisible);
        if (workspaceVisible) {
            adoptCommunityCards();
            applyCommunitySort();
        } else {
            restoreCommunityCards();
        }
    }

    function setMinimized(minimized) {
        state.minimized = !!minimized;
        try { localStorage.setItem(STORAGE_MIN_KEY, String(state.minimized)); } catch {}
        setWorkspaceVisible(!state.minimized);
    }

    function switchTab(tab) {
        state.tab = tab === 'library' ? 'library' : 'communities';
        try { localStorage.setItem(STORAGE_TAB_KEY, state.tab); } catch {}
        const bar = getEl(TOOLBAR_ID);
        if (!bar) return;
        bar.classList.toggle('nexus-ff-tab-library', state.tab === 'library');
        bar.classList.toggle('nexus-ff-tab-communities', state.tab === 'communities');
        for (const page of bar.querySelectorAll('[data-page]')) page.hidden = page.dataset.page !== state.tab;
        for (const button of bar.querySelectorAll('.nexus-ff-nav button')) {
            const active = button.dataset.tab === state.tab;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', String(active));
            button.tabIndex = active ? 0 : -1;
        }
        updateUi();
    }

    /* ---------------------------------------------------------------- community page */

    const sourceInputIds = new Map();

    function sourceInputId(url) {
        if (!sourceInputIds.has(url)) sourceInputIds.set(url, `nexus-ff-src-${sourceInputIds.size + 1}`);
        return sourceInputIds.get(url);
    }

    function communityHandle(card) {
        const text = (card.querySelector('.nexus-ff-community-original')?.textContent || '').replace(/\s+/g, ' ');
        const followers = text.match(/([\d][\d\s.,]{0,10})\s*(?:sledovateľ|follower|člen|member)/i);
        const type = /komunita|group|skupina|kanál/i.test(text) ? 'Komunita' : 'Zdroj';
        return followers ? `${type} · ${followers[1].trim()} sledovateľov` : type;
    }

    function adoptCommunityCard(card) {
        const host = document.querySelector('[data-role="community-host"]');
        if (!host || card.parentElement === host) return;
        if (!state.adopted.has(card)) state.adopted.set(card, { parent: card.parentElement, next: card.nextElementSibling });
        host.append(card);
        // Page order is recorded once, at adoption, so sorting never rewrites it.
        if (card.dataset.source) {
            const order = JSON.parse(host.dataset.originalOrder || '[]');
            if (!order.includes(card.dataset.source)) order.push(card.dataset.source);
            host.dataset.originalOrder = JSON.stringify(order);
        }
    }

    function adoptCommunityCards() {
        for (const card of document.querySelectorAll('.nexus-ff-community')) adoptCommunityCard(card);
    }

    function restoreCommunityCards() {
        for (const [card, origin] of [...state.adopted].reverse()) {
            const parent = origin.parent;
            const ref = origin.next && origin.next.parentElement === parent ? origin.next : null;
            if (parent?.isConnected) parent.insertBefore(card, ref);
            else card.remove();
        }
        state.adopted.clear();
    }

    // História pre jeden odkaz: čerstvo načítaná hodnota má prednosť pred indexom z disku.
    function cacheInfoFor(url) {
        return state.sources.get(url)?.cache || state.cacheIndex.get(url) || null;
    }

    const cachedJobs = new Map();
    const cachedJobsPending = new Set();

    /* Karty komunít dostanú metriky z histórie hneď pri otvorení stránky.
       Načítava sa len raz na odkaz a len pre karty, ktoré sú na stránke. */
    function queueCachedStats(url) {
        if (cachedJobs.has(url) || cachedJobsPending.has(url) || sourceAudits.has(url)) return;
        cachedJobsPending.add(url);
        void cache.getSource(url).then(record => {
            cachedJobsPending.delete(url);
            if (!record?.items?.length || sourceAudits.has(url)) return;
            cachedJobs.set(url, cacheJobFromRecord(record));
            for (const card of document.querySelectorAll('.nexus-ff-community')) {
                if (card.dataset.source !== url) continue;
                renderCommunityStats(card, cachedJobs.get(url));
                renderCommunityCacheStatus(card);
            }
            updateCommunitySummary(getEl(TOOLBAR_ID));
        });
    }

    // Prizná, že čísla na karte pochádzajú z histórie a nie z aktuálneho merania.
    function renderCommunityCacheStatus(card) {
        if (sourceAudits.has(card.dataset.source)) return;
        const status = card.querySelector('.nexus-ff-source-status');
        if (!status) return;
        const info = cacheInfoFor(card.dataset.source);
        status.textContent = info?.total ? `Z histórie (${formatAgo(info.fetchedAt)})` : '';
    }

    function sourceCount(url) {
        const job = sourceAudits.get(url) || cachedJobs.get(url);
        return job ? job.items.size : 0;
    }

    function sourceSize(url) {
        const job = sourceAudits.get(url) || cachedJobs.get(url);
        return job ? [...job.metrics.values()].reduce((sum, item) => sum + (Number(item.sizeMb) || 0), 0) : 0;
    }

    function applyCommunitySort() {
        const host = document.querySelector('[data-role="community-host"]');
        if (!host) return;
        const sort = state.communitySort;
        const cards = [...host.children].filter(child => child.classList?.contains('nexus-ff-community'));
        if (!cards.length) return;
        const original = JSON.parse(host.dataset.originalOrder || '[]');
        const rank = card => {
            const index = original.indexOf(card.dataset.source);
            return index < 0 ? Number.MAX_SAFE_INTEGER : index;
        };
        if (sort === 'original') cards.sort((a, b) => rank(a) - rank(b));
        else if (sort === 'name') cards.sort((a, b) => (a.dataset.name || '').localeCompare(b.dataset.name || '', 'sk'));
        else if (sort === 'count') cards.sort((a, b) => sourceCount(b.dataset.source) - sourceCount(a.dataset.source) || rank(a) - rank(b));
        else if (sort === 'size') cards.sort((a, b) => sourceSize(b.dataset.source) - sourceSize(a.dataset.source) || rank(a) - rank(b));
        for (const card of cards) host.append(card);
    }

    /* ---------------------------------------------------------------- source cards */

    function decorateCommunityCard(card, url, name) {
        card.classList.add('nexus-ff-community');
        card.dataset.source = url;
        card.dataset.name = name || '';

        if (!card.querySelector('.nexus-ff-community-original')) {
            const wrap = document.createElement('div');
            wrap.className = 'nexus-ff-community-original';
            for (const node of [...card.childNodes]) {
                if (node.nodeType === 1 && (node.classList.contains('nexus-ff-community-cover') || node.classList.contains('nexus-ff-source-check') || node.classList.contains('nexus-ff-source-audit'))) continue;
                wrap.append(node);
            }
            card.append(wrap);
        }
        const original = card.querySelector('.nexus-ff-community-original');

        let cover = card.querySelector('.nexus-ff-community-cover');
        if (!cover) {
            cover = document.createElement('div');
            cover.className = 'nexus-ff-community-cover';
            const source = original.querySelector('img');
            if (source) {
                const picture = source.cloneNode(true);
                picture.removeAttribute('style');
                picture.removeAttribute('width');
                picture.removeAttribute('height');
                picture.className = '';
                picture.alt = '';
                picture.loading = 'lazy';
                cover.append(picture);
                source.classList.add('nexus-ff-original-avatar');
            } else {
                const letter = document.createElement('span');
                letter.className = 'nexus-ff-community-letter';
                letter.setAttribute('aria-hidden', 'true');
                letter.textContent = (name || '?').trim().slice(0, 1).toUpperCase() || '?';
                cover.append(letter);
            }
            card.prepend(cover);
        }

        if (!cover.querySelector('.nexus-ff-source-check')) {
            const check = document.createElement('label');
            check.className = 'nexus-ff-source-check nexus-ff-cover-check';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.id = sourceInputId(url);
            input.dataset.source = url;
            input.checked = !!state.sources.get(url)?.selected;
            input.disabled = state.collecting;
            input.setAttribute('aria-label', `Pridať do knižnice: ${name || url}`);
            input.onchange = () => rememberSource(url, name, input.checked);
            const mark = document.createElement('span');
            mark.className = 'nexus-ff-check-mark';
            mark.setAttribute('aria-hidden', 'true');
            check.append(input, mark);
            check.onclick = event => event.stopPropagation();
            cover.append(check);
        }

        if (!card.querySelector('.nexus-ff-community-stats')) {
            const handle = document.createElement('div');
            handle.className = 'nexus-ff-community-handle';
            handle.textContent = communityHandle(card);

            const stats = document.createElement('div');
            stats.className = 'nexus-ff-community-stats';
            for (const label of ['videí', 'spolu', 'priemer']) {
                const cell = document.createElement('div');
                const value = document.createElement('strong');
                value.textContent = '—';
                const caption = document.createElement('small');
                caption.textContent = label;
                cell.append(value, caption);
                stats.append(cell);
            }

            const footer = document.createElement('div');
            footer.className = 'nexus-ff-community-footer';
            const stateLabel = document.createElement('label');
            stateLabel.className = 'nexus-ff-community-state';
            stateLabel.htmlFor = sourceInputId(url);
            const audit = document.createElement('div');
            audit.className = 'nexus-ff-source-audit';
            audit.dataset.source = url;
            const status = document.createElement('span');
            status.className = 'nexus-ff-source-status';
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = 'Zistiť údaje';
            button.setAttribute('aria-label', `Zistiť údaje o videách: ${name || url}`);
            button.onclick = event => {
                event.preventDefault();
                event.stopPropagation();
                toggleSourceAudit(url, name);
            };
            audit.append(status, button);
            footer.append(stateLabel, audit);
            card.append(handle, stats, footer);
            card.querySelector('.nexus-ff-community-original')?.addEventListener('click', event => event.stopPropagation());
        }

        const stateLabel = card.querySelector('.nexus-ff-community-state');
        if (stateLabel) stateLabel.htmlFor = sourceInputId(url);
        renderCommunityStateLabel(card);
        if (sourceAudits.has(url)) renderSourceAudit(sourceAudits.get(url));
        else {
            // Metriky z histórie sú k dispozícii okamžite, bez jedinej požiadavky.
            renderCommunityStats(card, cachedJobs.get(url) || null);
            renderCommunityCacheStatus(card);
            if (!cachedJobs.has(url)) queueCachedStats(url);
        }
    }

    function renderCommunityStats(card, job) {
        const stats = card.querySelector('.nexus-ff-community-stats');
        if (!stats) return;
        const parts = communityStats(job);
        const cells = [...stats.children];
        const values = [parts.videos, parts.size, parts.average];
        const captions = ['videí', 'spolu', 'priemer'];
        const coverage = [parts.videosCoverage, parts.sizeCoverage, parts.averageCoverage];
        cells.forEach((cell, index) => {
            const value = cell.querySelector('strong');
            const caption = cell.querySelector('small');
            value.textContent = values[index];
            caption.textContent = coverage[index] ? `${captions[index]} · ${coverage[index]}` : captions[index];
            caption.title = coverage[index] ? `Údaje zistené pre ${coverage[index].replace('údaje ', '')} videí; zvyšok zatiaľ nie je zmeraný.` : '';
        });
    }

    // Every value is measured or an em dash; coverage is stated, never implied complete.
    function communityStats(job) {
        if (!job) return { videos: '—', size: '—', average: '—', videosCoverage: '', sizeCoverage: '', averageCoverage: '' };
        const values = [...job.metrics.values()];
        const sizes = values.filter(item => Number(item.sizeMb) > 0);
        const durations = values.filter(item => Number(item.duration) > 0);
        const count = job.items.size;
        const mb = sizes.reduce((sum, item) => sum + Number(item.sizeMb), 0);
        const coverage = known => (known === count && job.listComplete) ? '' : `údaje ${known}/${count}`;
        return {
            videos: `${job.listComplete ? '' : '≥ '}${count}`,
            videosCoverage: job.listComplete ? (job.error ? 'neúplný zoznam' : '') : 'neúplný zoznam',
            size: sizes.length ? formatTotalSize(mb) : '—',
            sizeCoverage: sizes.length ? coverage(sizes.length) : '',
            average: durations.length ? formatDuration(durations.reduce((sum, item) => sum + Number(item.duration), 0) / durations.length) : '—',
            averageCoverage: durations.length ? coverage(durations.length) : '',
        };
    }

    function sourceAuditSummary(job) {
        const s = communityStats(job);
        const parts = [
            `${s.videos} videí`,
            s.size !== '—' ? `${s.size}${s.sizeCoverage ? ` (${s.sizeCoverage.replace('údaje ', '')})` : ''}` : null,
            s.average !== '—' ? `priemer ${s.average}${s.averageCoverage ? ` (${s.averageCoverage.replace('údaje ', '')})` : ''}` : null,
        ].filter(Boolean);
        return parts.join(' · ');
    }

    function updateCommunitySummary(bar) {
        if (!bar) return;
        const selected = selectedSources();
        const countEl = bar.querySelector('[data-role="communities-count"]');
        const aggregateEl = bar.querySelector('[data-role="communities-aggregate"]');
        if (countEl) countEl.textContent = `${selected.length} ${selected.length === 1 ? 'komunita vybraná' : (selected.length === 0 || selected.length >= 5) ? 'komunít vybraných' : 'komunity vybrané'}`;
        if (!aggregateEl) return;
        if (!selected.length) { aggregateEl.textContent = 'Vyber komunitu alebo pridaj odkaz.'; return; }
        let videos = 0, videosKnown = 0, mb = 0, sizeKnown = 0, seconds = 0, durationKnown = 0, audited = 0, incomplete = false, fromHistory = 0;
        for (const source of selected) {
            // Údaje z histórie sa počítajú tiež, ale nikdy nie ako práve zmerané.
            const job = sourceAudits.get(source.url) || cachedJobs.get(source.url);
            if (!job) continue;
            if (job.fromCache) fromHistory++; else audited++;
            videosKnown += job.items.size;
            if (!job.listComplete) incomplete = true;
            const values = [...job.metrics.values()];
            const sizes = values.filter(item => Number(item.sizeMb) > 0);
            const durations = values.filter(item => Number(item.duration) > 0);
            sizeKnown += sizes.length;
            durationKnown += durations.length;
            mb += sizes.reduce((sum, item) => sum + Number(item.sizeMb), 0);
            seconds += durations.reduce((sum, item) => sum + Number(item.duration), 0);
            videos += job.listComplete ? job.items.size : 0;
        }
        const digits = value => Number(value).toLocaleString('sk-SK', { maximumFractionDigits: 0 });
        const parts = [
            `${incomplete ? '≥ ' : ''}${digits(videos || videosKnown)} videí`,
            sizeKnown ? formatTotalSize(mb) : '—',
            durationKnown ? `priemerná dĺžka ${formatDuration(seconds / durationKnown)}` : 'priemer —',
        ];
        const uncovered = audited < selected.length ? ` · údaje ${audited}/${selected.length} komunit` : '';
        const history = fromHistory ? ` · ${fromHistory} z histórie` : '';
        aggregateEl.textContent = parts.join(' · ') + uncovered + history;
    }

    /* ---------------------------------------------------------------- source audit */

    const sourceAudits = new Map();
    const sourceAuditQueue = [];
    let sourceAuditRunning = false;

    function toggleSourceAudit(url, name) {
        const existing = sourceAudits.get(url);
        if (existing && ['queued', 'counting', 'measuring'].includes(existing.phase)) {
            existing.controller.abort();
            renderSourceAudit(existing);
            return;
        }
        const job = { url, name, phase: 'queued', controller: new AbortController(), items: new Map(), metrics: new Map(), listComplete: false, error: '' };
        sourceAudits.set(url, job);
        sourceAuditQueue.push(job);
        renderSourceAudit(job);
        void runSourceAuditQueue();
    }

    function renderSourceAudit(job) {
        for (const card of document.querySelectorAll('.nexus-ff-community')) {
            if (card.dataset.source !== job.url) continue;
            card.dataset.phase = job.phase;
            const active = ['queued', 'counting', 'measuring'].includes(job.phase);
            const box = card.querySelector('.nexus-ff-source-audit');
            if (box) {
                const button = box.querySelector('button');
                if (button) {
                    button.textContent = active
                        ? (job.controller.signal.aborted ? 'Zastavujem...' : 'Zastaviť zisťovanie')
                        : ((job.error || job.phase === 'stopped') ? 'Skúsiť znova' : 'Obnoviť údaje');
                    button.disabled = active && job.controller.signal.aborted;
                }
                const status = box.querySelector('.nexus-ff-source-status');
                if (status) {
                    status.textContent = job.phase === 'queued' ? 'Čaká na načítanie'
                        : job.phase === 'counting' ? 'Načítavam všetky stránky...'
                            : job.phase === 'measuring' ? `Zisťujem údaje ${job.metrics.size}/${job.items.size}...`
                                : job.phase === 'stopped' ? 'Zastavené · neúplné údaje'
                                    : job.error ? `Neúplné: ${job.error}`
                                        : 'Kompletná video galéria';
                    status.title = job.error || 'Veľkosť je súčet zistených veľkostí. Priemer používa iba videá so zistenou dĺžkou. Údaje v zátvorke uvádzajú pokrytie.';
                }
            }
            renderCommunityStats(card, job);
        }
        updateCommunitySummary(getEl(TOOLBAR_ID));
    }

    async function auditSource(job) {
        const signal = job.controller.signal;
        try {
            if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
            job.phase = 'counting'; renderSourceAudit(job);
            try {
                await collectSource({ url: job.url, name: job.name }, signal, async items => {
                    for (const item of items) job.items.set(item.id, item);
                    renderSourceAudit(job);
                });
                job.listComplete = true;
            } catch (error) {
                if (signal.aborted) throw error;
                job.error = error.message;
            }
            // Show the complete count immediately. Only probe video files if the
            // post metadata did not already provide a valid duration.
            job.phase = 'measuring'; renderSourceAudit(job);
            const items = [...job.items.values()];
            let cursor = 0;
            const worker = async () => {
                while (cursor < items.length && !signal.aborted) {
                    const item = items[cursor++];
                    let result = {};
                    try {
                        const data = await requestMetadata(item);
                        if (signal.aborted) break;
                        result.sizeMb = Number(data.sizeMb) > 0 ? Number(data.sizeMb) : null;
                        result.duration = Number(data.duration) > 0 ? Number(data.duration) : 0;
                        if (!result.duration && data.streamUrl && !data.error) {
                            try { result.duration = (await probeVideoMetadata(data.streamUrl)).duration; } catch {}
                        }
                    } catch {}
                    if (signal.aborted) break;
                    job.metrics.set(item.id, result); renderSourceAudit(job);
                }
            };
            await Promise.all([worker(), worker()]);
            job.phase = signal.aborted ? 'stopped' : 'done';
        } catch (error) {
            job.error = error.message; job.phase = signal.aborted ? 'stopped' : 'done';
        } finally {
            renderSourceAudit(job);
            // Zmerané veľkosti a dĺžky idú do histórie, takže ďalšie otvorenie
            // stránky ukáže metriky bez jedinej požiadavky na sieť.
            if (job.metrics.size) void mergeCacheMetrics(job.url, job.metrics).then(() => refreshCacheIndex());
        }
    }

    async function runSourceAuditQueue() {
        if (sourceAuditRunning) return;
        sourceAuditRunning = true;
        try {
            while (sourceAuditQueue.length) await auditSource(sourceAuditQueue.shift());
        } finally { sourceAuditRunning = false; }
    }

    /* ---------------------------------------------------------------- sources */

    function normalizeSource(raw) {
        try {
            const url = new URL(raw, location.href);
            if (url.origin !== location.origin || url.protocol !== 'https:') return null;
            const match = url.pathname.match(/^\/(groups|pages)\/([^/]+)(?:\/(?:videos|photos|timeline))?\/?$/i);
            if (/^\/posts\/[\w-]+\/?$/i.test(url.pathname)) return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
            if (/^\/[\w.-]+\/videos\/?$/i.test(url.pathname)) return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
            if (!match) return null;
            return `${url.origin}/${match[1].toLowerCase()}/${match[2]}/videos`;
        } catch { return null; }
    }

    function saveSources() {
        try { localStorage.setItem(SOURCES_KEY, JSON.stringify([...state.sources.values()].map(({ url, name, selected }) => ({ url, name, selected })))); } catch {}
    }

    function renderSources() {
        const bar = getEl(TOOLBAR_ID);
        const list = bar?.querySelector('[data-role="sources-list"]');
        if (!bar || !list) return;
        list.replaceChildren();
        const query = (bar?.querySelector('.nexus-ff-side-search')?.value || '').toLowerCase().trim();
        for (const source of state.sources.values()) {
            if (query && !source.name.toLowerCase().includes(query)) continue;
            const row = document.createElement('div');
            row.className = 'nexus-ff-source-row';
            if (source.selected) row.dataset.active = '1';

            // Avatar (photo if available, or initial letter)
            const avatar = document.createElement('div');
            avatar.className = 'nexus-ff-creator-avatar';
            const commCard = document.querySelector?.(`.nexus-ff-community[data-source="${source.url}"]`);
            const photoSrc = source.avatar || commCard?.querySelector('img')?.src;
            if (photoSrc) {
                const img = document.createElement('img');
                img.src = photoSrc;
                img.className = 'nexus-ff-creator-photo';
                img.alt = source.name;
                img.onerror = () => { img.remove(); avatar.innerHTML = `<span class="nexus-ff-avatar-initial">${(source.name || 'C').charAt(0).toUpperCase()}</span>`; };
                avatar.append(img);
            } else {
                const initial = (source.name || 'C').charAt(0).toUpperCase();
                avatar.innerHTML = `<span class="nexus-ff-avatar-initial">${initial}</span>`;
            }

            // Info block (name + stats)
            const info = document.createElement('div');
            info.className = 'nexus-ff-creator-info';
            const nameEl = document.createElement('div');
            nameEl.className = 'nexus-ff-source-name';
            nameEl.textContent = source.name;

            const cacheInfo = cacheInfoFor(source.url);
            const sub = document.createElement('small');
            sub.className = 'nexus-ff-creator-sub';
            if (cacheInfo?.total) {
                sub.textContent = `${cacheInfo.total} videí · ${formatAgo(cacheInfo.fetchedAt)}`;
            } else {
                sub.textContent = source.status || 'Pripravené';
            }
            info.append(nameEl, sub);

            // Checkbox
            const check = document.createElement('input');
            check.type = 'checkbox';
            check.checked = source.selected;
            check.disabled = state.collecting;
            check.className = 'nexus-ff-creator-check';
            check.setAttribute('aria-label', `Zdroj: ${source.name}`);
            check.onchange = (e) => {
                source.selected = check.checked;
                row.dataset.active = source.selected ? '1' : '0';
                saveSources();
                syncSourceChecks();
                renderSources();
                applyView();
                updateUi();
            };

            // Remove button
            const remove = document.createElement('button');
            remove.className = 'nexus-ff-creator-remove';
            remove.innerHTML = '&times;';
            remove.type = 'button';
            remove.title = `Odstrániť ${source.name}`;
            remove.disabled = state.collecting;
            remove.onclick = (e) => {
                e.stopPropagation();
                state.sources.delete(source.url);
                saveSources();
                renderSources();
                syncSourceChecks();
                applyView();
                updateUi();
            };

            row.append(avatar, info, check, remove);

            // Subtle reload icon if retry needed
            const needsRetry = /Neúplné|Zastavené|Nenačítané|neúplná/i.test(source.status || '');
            if (source.selected && state.mixActive && needsRetry) {
                const retry = document.createElement('button');
                retry.type = 'button';
                retry.className = 'nexus-ff-creator-retry-icon';
                retry.title = 'Skúsiť znova';
                retry.innerHTML = '&#8635;';
                retry.disabled = state.collecting;
                retry.onclick = async (e) => {
                    e.stopPropagation();
                    if (state.collecting) return;
                    state.collecting = true;
                    state.collectionAbort = new AbortController();
                    bar.querySelector('[data-role="stop-mix"]').hidden = false;
                    renderSources(); syncSourceChecks(); updateUi();
                    try {
                        await collectSource(source, state.collectionAbort.signal, items => appendMixItems(items, source), true, {
                            baseline: source.baselineIds,
                        });
                    } catch (error) {
                        source.status = state.collectionAbort.signal.aborted ? 'Zastavené' : 'Chyba';
                    } finally {
                        state.collecting = false;
                        state.collectionAbort = null;
                        state.mixProgress = '';
                        bar.querySelector('[data-role="stop-mix"]').hidden = true;
                        renderSources(); syncSourceChecks(); applyView(); updateUi();
                    }
                };
                row.append(retry);
            }

            row.onclick = (e) => {
                if (e.target.closest('button, input')) return;
                check.checked = !check.checked;
                check.dispatchEvent(new Event('change'));
            };

            list.append(row);
        }
        renderLibraryState();
    }

    /* ---------------------------------------------------------------- historia UI */

    /* Prečíta históriu z disku a premietne ju do indexu (odkaz -> súhrn), ktorý
       používajú karty komunít aj riadky zdrojov. Beží pri každom otvorení stránky. */
    async function refreshCacheIndex() {
        const rows = await cache.listSources();
        state.cacheIndex = new Map(rows.map(row => [row.key, summarizeCache(row)]));
        for (const source of state.sources.values()) {
            source.cache = state.cacheIndex.get(source.url) || source.cache || null;
        }
        renderSources();
        syncSourceChecks();
        updateUi();
    }

    async function refreshHistory() {
        const [libraries, sources, imports] = await Promise.all([cache.listLibraries(), cache.listSources(), cache.listImports()]);
        state.history = { libraries, sources, imports };
        renderHistory();
    }

    function historyRow(title, subtitle, actions) {
        const row = document.createElement('div');
        row.className = 'nexus-ff-history-row';
        const info = document.createElement('div');
        info.className = 'nexus-ff-history-info';
        const name = document.createElement('strong');
        name.textContent = title;
        const detail = document.createElement('small');
        detail.textContent = subtitle;
        info.append(name, detail);
        const controls = document.createElement('div');
        controls.className = 'nexus-ff-history-actions';
        for (const action of actions) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = action.label;
            button.title = action.title || action.label;
            if (action.compact) button.className = 'nexus-ff-history-remove';
            button.disabled = state.collecting || state.hydrating || state.busy;
            button.onclick = action.onClick;
            controls.append(button);
        }
        row.append(info, controls);
        return row;
    }

    function historyGroup(host, title, rows) {
        if (!host) return;
        host.replaceChildren();
        host.hidden = !rows.length;
        if (!rows.length) return;
        const heading = document.createElement('h3');
        heading.className = 'nexus-ff-history-title';
        heading.textContent = title;
        host.append(heading);
        for (const row of rows) host.append(row);
    }

    function renderHistory() {
        const bar = getEl(TOOLBAR_ID);
        const panel = bar?.querySelector('[data-role="history"]');
        if (!panel) return;
        const { libraries, sources, imports } = state.history;
        const countEl = panel.querySelector('[data-role="history-count"]');
        const total = libraries.length + sources.length + imports.length;
        if (countEl) countEl.textContent = String(total);
        panel.hidden = total === 0;
        if (!total) return;

        historyGroup(panel.querySelector('[data-role="history-libraries"]'), 'Knižnice (kombinácie zdrojov)', libraries.slice(0, 10).map(record => historyRow(
            record.name || `${(record.sources || []).length} zdroje`,
            `${record.itemCount} videí · ${formatAgo(record.updatedAt)}${record.partial ? ' · neúplná' : ''} · otvorená ${record.openCount || 1}×`,
            [
                { label: 'Otvoriť', title: 'Obnoví zdroje a doručí videá z histórie', onClick: () => openLibraryFromHistory(record) },
                { label: '×', compact: true, title: 'Odstrániť knižnicu z histórie', onClick: () => removeLibraryFromHistory(record) },
            ],
        )));

        historyGroup(panel.querySelector('[data-role="history-sources"]'), 'Uložené komunity', sources.slice(0, 12).map(record => {
            const inSources = state.sources.has(record.key);
            const title = record.name || record.key;
            return historyRow(
                title,
                `${Number(record.total ?? record.count)} videí · ${formatAgo(record.fetchedAt)}${record.complete ? '' : ' · neúplná'}${inSources ? ' · v zdrojoch' : ''}`,
                [
                    { label: inSources ? 'Otvoriť v knižnici' : 'Pridať a otvoriť', title: 'Označí tento zdroj a doručí jeho videá z histórie', onClick: () => useSourceFromHistory(record) },
                    { label: '×', compact: true, title: 'Zmazať uloženú komunitu', onClick: () => removeSourceFromHistory(record) },
                ],
            );
        }));

        historyGroup(panel.querySelector('[data-role="history-imports"]'), 'Importy', imports.slice(0, 5).map(record => historyRow(
            record.name || 'Import',
            `${record.count} videí · ${formatAgo(record.at)}${record.asBoard ? ' · Source Board' : ''}`,
            [{ label: '×', compact: true, title: 'Odstrániť z histórie', onClick: () => removeImportFromHistory(record) }],
        )));
    }

    /* Rovnaká práca ako "Otvoriť" pri knižnici: označí jediný zdroj a doručí ho
       z histórie, takže tlačidlo robí presne to, čo sľubuje. */
    async function useSourceFromHistory(record) {
        if (state.collecting || state.hydrating || state.busy) return;
        rememberSource(record.key, record.name || '');
        const target = state.sources.get(record.key);
        for (const source of state.sources.values()) source.selected = source === target;
        saveSources();
        renderSources(); syncSourceChecks(); updateUi();
        switchTab('library');
        toast(`História: obnovujem ${record.name || 'zdroj'} (${Number(record.total ?? record.count) || 0} videí)`);
        await buildMix();
    }

    async function openLibraryFromHistory(record) {
        if (state.collecting || state.hydrating || state.busy) return;
        for (const row of record.sources || []) rememberSource(row.url, row.name || '');
        const wanted = new Set((record.sources || []).map(row => row.url));
        for (const source of state.sources.values()) source.selected = wanted.has(source.url);
        saveSources();
        renderSources(); syncSourceChecks(); updateUi();
        switchTab('library');
        toast(`História: obnovujem ${wanted.size} zdrojov (${record.itemCount} videí)`);
        await buildMix();
    }

    async function removeLibraryFromHistory(record) {
        await cache.deleteLibrary(record.key);
        await refreshHistory();
        toast('Knižnica odstránená z histórie');
    }

    async function removeSourceFromHistory(record) {
        await cache.deleteSource(record.key);
        const source = state.sources.get(record.key);
        if (source) source.cache = null;
        await refreshCacheIndex();
        await refreshHistory();
        toast('Uložená komunita zmazaná');
    }

    async function removeImportFromHistory(record) {
        await cache.deleteImport(record.id);
        await refreshHistory();
    }

    function renderCommunityStateLabel(card) {
        const label = card?.querySelector('.nexus-ff-community-state');
        if (!label) return;
        const selected = !!state.sources.get(card.dataset.source)?.selected;
        label.dataset.selected = selected ? '1' : '0';
        label.replaceChildren();
        const mark = document.createElement('span');
        mark.className = 'nexus-ff-check-mark';
        mark.setAttribute('aria-hidden', 'true');
        label.append(mark, document.createTextNode(selected ? 'Vybrané' : 'Vybrať'));
        const info = cacheInfoFor(card.dataset.source);
        if (info?.total) {
            const note = document.createElement('small');
            note.className = 'nexus-ff-community-cache';
            note.textContent = `z histórie: ${info.total}`;
            note.title = `${info.total} videí uložených ${formatAgo(info.fetchedAt)}${info.complete ? '' : ' · história je neúplná'}. Otvorenie knižnice ich doručí okamžite.`;
            label.append(note);
        }
    }

    function syncSourceChecks() {
        for (const input of document.querySelectorAll('.nexus-ff-source-check input')) {
            const selected = !!state.sources.get(input.dataset.source)?.selected;
            input.checked = selected;
            input.disabled = state.collecting;
            const card = input.closest('.nexus-ff-community');
            if (card) card.dataset.selected = selected ? '1' : '0';
        }
        for (const card of document.querySelectorAll('.nexus-ff-community')) renderCommunityStateLabel(card);
    }

    function rememberSource(url, name, selected = true) {
        const existing = state.sources.get(url);
        if (existing) existing.selected = selected;
        else state.sources.set(url, { url, name: name || new URL(url).pathname.split('/')[2], selected });
        saveSources();
        renderSources();
        syncSourceChecks();
        applyView();
        updateUi();
    }

    function scanSources() {
        for (const anchor of document.querySelectorAll('.ui-box a[href], .data-container a[href], .data-container-sugg a[href]')) {
            if (anchor.closest('#nexus-ff-mix') || anchor.closest(`#${TOOLBAR_ID}`) || anchor.closest('.js_posts_stream')) continue;
            const url = normalizeSource(anchor.getAttribute('href'));
            if (!url) continue;
            const card = anchor.closest('.ui-box, .data-container, .data-container-sugg');
            if (!card) continue;
            const name = (card.querySelector('.h6, .name')?.textContent || anchor.querySelector('img')?.alt || new URL(url).pathname.split('/')[2]).trim();
            decorateCommunityCard(card, url, name);
            if (workspaceVisible) adoptCommunityCard(card);
        }
        if (workspaceVisible) applyCommunitySort();
        // Counted from the decorated cards themselves: adopted cards no longer live in the page list.
        const empty = document.querySelector?.('[data-role="communities-empty"]');
        if (empty) empty.hidden = document.querySelectorAll('.nexus-ff-community').length > 0;
    }

    function setupSources(bar) {
        try {
            const saved = JSON.parse(localStorage.getItem(SOURCES_KEY) || '[]');
            for (const row of Array.isArray(saved) ? saved : []) {
                const url = normalizeSource(row.url);
                if (url) state.sources.set(url, { url, name: String(row.name || new URL(url).pathname.split('/')[2]), selected: !!row.selected });
            }
        } catch {}
        const addBtn = bar.querySelector('[data-role="add-sources"]');
        if (addBtn) addBtn.onclick = () => {
            const field = bar.querySelector('[data-role="source-urls"]');
            let rejected = 0;
            for (const raw of (field?.value || '').split(/\s+/).filter(Boolean)) {
                const url = normalizeSource(raw);
                if (url) rememberSource(url); else rejected++;
            }
            if (rejected) toast(`${rejected} nepodporovaných odkazov. Použi /groups/názov/videos, /profil/videos alebo /posts/ID.`, true);
            else if (field) field.value = '';
        };
        const selectSourcesBtn = bar.querySelector('[data-role="select-sources"]');
        if (selectSourcesBtn) selectSourcesBtn.onclick = () => {
            for (const input of document.querySelectorAll('.nexus-ff-source-check input')) {
                if (!input.checked && !input.disabled) { input.checked = true; input.dispatchEvent(new Event('change')); }
            }
            updateUi();
        };
        const curSourceBtn = bar.querySelector('[data-role="current-source"]');
        if (curSourceBtn) curSourceBtn.onclick = () => {
            const url = normalizeSource(location.href);
            if (url) rememberSource(url, detectGroupName());
            else toast('Otvor konkrétny kanál alebo pridaj jeho odkaz.', true);
        };
        const auditBtn = bar.querySelector('[data-role="audit-selected"]');
        if (auditBtn) auditBtn.onclick = () => {
            const pending = selectedSources().filter(source => {
                const job = sourceAudits.get(source.url);
                return !job || !['queued', 'counting', 'measuring'].includes(job.phase);
            });
            if (!pending.length) { toast('Vybrané komunity už majú zistené údaje.'); return; }
            for (const source of pending) toggleSourceAudit(source.url, source.name);
        };
        const commClearBtn = bar.querySelector('[data-role="communities-clear"]');
        if (commClearBtn) commClearBtn.onclick = () => {
            for (const input of document.querySelectorAll('.nexus-ff-source-check input')) {
                if (input.checked && !input.disabled) { input.checked = false; input.dispatchEvent(new Event('change')); }
            }
            updateUi();
        };
        const openLibBtn = bar.querySelector('[data-role="open-library"]');
        if (openLibBtn) openLibBtn.onclick = async () => {
            if (!selectedSources().length) { toast('Označ aspoň jednu komunitu alebo pridaj odkaz.', true); return; }
            switchTab('library');
            if (!state.mixActive) await buildMix();
        };
        const communitySort = bar.querySelector('[data-role="community-sort"]');
        if (communitySort) communitySort.onchange = () => { state.communitySort = communitySort.value; applyCommunitySort(); };
        const buildMixBtn = bar.querySelector('[data-role="build-mix"]');
        if (buildMixBtn) buildMixBtn.onclick = buildMix;
        const stopMixBtn = bar.querySelector('[data-role="stop-mix"]');
        if (stopMixBtn) stopMixBtn.onclick = () => state.collectionAbort?.abort();
        // Vymazanie histórie je nevratné, preto druhé kliknutie do 4 sekúnd potvrdzuje.
        const clearHistory = bar.querySelector('[data-role="history-clear"]');
        if (clearHistory) clearHistory.onclick = async () => {
            if (!state.historyPurgeArmed) {
                state.historyPurgeArmed = true;
                clearHistory.textContent = 'Naozaj vymazať?';
                clearHistory.dataset.armed = '1';
                setTimeout(() => {
                    if (!state.historyPurgeArmed) return;
                    state.historyPurgeArmed = false;
                    clearHistory.textContent = 'Vymazať históriu';
                    delete clearHistory.dataset.armed;
                }, 4000);
                return;
            }
            state.historyPurgeArmed = false;
            clearHistory.textContent = 'Vymazať históriu';
            delete clearHistory.dataset.armed;
            await cache.clear();
            cachedJobs.clear();
            for (const source of state.sources.values()) source.cache = null;
            await refreshCacheIndex();
            await refreshHistory();
            toast('História vymazaná');
        };
        const closeMixBtn = bar.querySelector('[data-role="close-mix"]');
        if (closeMixBtn) closeMixBtn.onclick = () => {
            if (state.collecting || state.hydrating || state.busy) return;
            const grid = document.querySelector('#nexus-ff-mix .nexus-ff-mix-grid');
            grid?.replaceChildren();
            state.mixActive = false;
            state.items = nativeItems || new Map();
            nativeItems = null;
            state.mixProgress = '';
            renderLibraryState();
            switchTab('communities');
            scanCards();
        };
        const toggleSources = bar.querySelector('[data-role="toggle-sources"]');
        if (toggleSources) toggleSources.onclick = () => {
            const pane = bar.querySelector('.nexus-ff-sources-pane');
            const open = pane.dataset.open !== '1';
            pane.dataset.open = open ? '1' : '0';
            toggleSources.setAttribute('aria-expanded', String(open));
        };
        renderSources();
        scanSources();
    }

    /* ---------------------------------------------------------------- collection */

    async function collectionRequest(url, signal, options = {}) {
        const response = await fetch(url, { ...options, credentials: 'include', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (new URL(response.url || url).origin !== location.origin) throw new Error('Presmerovanie mimo FapFolder');
        return response;
    }

    function parseVideoPage(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const items = [...doc.querySelectorAll(VIDEO_LINK_SELECTOR)].map(collectCard).filter(Boolean);
        const more = doc.querySelector('.js_see-more[data-get="videos"], .js_see-more-infinite[data-get="videos"]');
        return { doc, items, more };
    }

    async function collectSource(source, signal, onItems, reportMix = false, options = {}) {
        // baseline = čo už je v histórii. Vtedy nejde o prvé načítanie, ale o overenie
        // proti sieti: hlási sa, čo pribudlo a čo v komunite už nie je.
        const baseline = options.baseline instanceof Set ? options.baseline : null;
        const revalidate = Boolean(baseline);
        source.status = 'Načítavam...'; renderSources();
        const response = await collectionRequest(source.url, signal);
        const page = parseVideoPage(await response.text());
        const post = new URL(source.url).pathname.match(/^\/posts\/([\w-]+)$/i);
        if (post) {
            const media = page.doc.querySelector('video, .vid-placeholder');
            if (!media) throw new Error('Vlákno neobsahuje dostupné video');
            const thumbnail = media.getAttribute('poster') || media.getAttribute('data-poster') || '';
            const item = { id: `posts:${post[1]}`, url: source.url, title: page.doc.title || source.name, thumbnail, duration: 0, sizeMb: null, selected: false, sources: [source.name] };
            await onItems([item]);
            source.status = '1 video · kompletné';
            renderSources();
            await persistSource(source, [item], { complete: true });
            return;
        }
        if (!page.items.length && !page.more && !page.doc.querySelector('.profile-avatar, .profile-cover, .profile-header, .profile-name')) {
            throw new Error('Galéria nie je dostupná; skontroluj prihlásenie alebo prístup');
        }
        let count = 0;
        let freshCount = 0;
        const seen = new Set();
        const collected = [];
        const append = async items => {
            const fresh = items.filter(item => !seen.has(item.id) && seen.add(item.id));
            for (const item of fresh) {
                collected.push(item);
                if (!baseline || !baseline.has(item.id)) freshCount++;
            }
            count += fresh.length;
            await onItems(fresh);
            source.status = `${count} videí · načítavam`; renderSources();
            if (reportMix) {
                state.mixProgress = `${source.name}: ${count} videí · načítavam všetky stránky...`;
                const summary = document.querySelector('#nexus-ff-mix .nexus-ff-mix-summary');
                if (summary) summary.textContent = `${state.items.size} jedinečných videí · ${source.name}: ${count} · načítavam všetky stránky...`;
                renderLibraryState();
            }
            return fresh.length;
        };
        try {
            await append(page.items);
            if (page.more && !page.more.classList.contains('done')) {
                const params = new URLSearchParams({ get: 'videos', offset: '1', premfeed: '0', time: '-1' });
                for (const key of ['id', 'type', 'uid', 'filter']) {
                    if (page.more.hasAttribute(`data-${key}`)) params.set(key, page.more.getAttribute(`data-${key}`));
                }
                if (!params.get('id') && !params.get('uid')) throw new Error('Chýba ID pre See more');
                // Use FapFolder's actual load_more contract, never execute response.callback.
                let offset = Number(page.more.getAttribute('data-offset') || 1);
                for (;;) {
                    if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
                    params.set('offset', String(offset));
                    const res = await collectionRequest(`${location.origin}/includes/ajax/data/load.php`, signal, {
                        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }, body: params.toString(),
                    });
                    const result = await res.json();
                    if (result.callback || result.error) throw new Error('FapFolder vyžaduje prihlásenie alebo odmietol načítanie');
                    if (result.data === '' || result.data === null || result.data === false) break;
                    if (typeof result.data !== 'string') throw new Error('Neočakávaná odpoveď See more');
                    const next = parseVideoPage(result.data).items;
                    if (!next.length || !await append(next)) throw new Error('See more nevrátil ďalšie videá; zdroj je neúplný');
                    offset++;
                    await new Promise(resolve => setTimeout(resolve, 150));
                }
            }
        } catch (error) {
            // Neúplný beh sa ukladá tiež: pri ďalšom otvorení sa aspoň to, čo sa
            // stihlo načítať, zobrazí okamžite (a označí ako neúplné).
            await persistSource(source, collected, { complete: false });
            throw error;
        }
        const removed = baseline && !signal.aborted ? [...baseline].filter(id => !seen.has(id)).length : 0;
        source.status = revalidate
            ? `${count} videí · overené${freshCount ? ` · ${freshCount} nových` : ' · bez zmien'}${removed ? ` · ${removed} už nie je` : ''}`
            : `${count} videí · kompletné`;
        renderSources();
        await persistSource(source, collected, { complete: true, freshCount, removed });
    }

    /* ---------------------------------------------------------------- metadata */

    function requestMetadata(item) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'FAPFOLDER_HYDRATE_ITEMS', items: [{ id: item.id, url: item.url }] }, (response) => {
                const error = chrome.runtime.lastError;
                if (error || !response?.ok) reject(new Error(error?.message || response?.error || 'Metadata request failed'));
                else resolve(response.items?.[0] || {});
            });
        });
    }

    function probeVideoMetadata(streamUrl) {
        return new Promise((resolve, reject) => {
            const video = document.createElement('video');
            video.preload = 'metadata';
            video.muted = true;
            video.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;pointer-events:none;';
            let settled = false;
            const finish = (error, result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                video.removeAttribute('src');
                video.load();
                video.remove();
                if (error) reject(error); else resolve(result);
            };
            const timer = setTimeout(() => finish(new Error('Video metadata timed out')), 15000);
            video.addEventListener('loadedmetadata', () => {
                const duration = Number(video.duration);
                const width = Number(video.videoWidth);
                const height = Number(video.videoHeight);
                if (!Number.isFinite(duration) || duration <= 0 || !width || !height) {
                    finish(new Error('Video metadata unavailable'));
                    return;
                }
                // Use the short edge for portrait video, and retain exact dimensions.
                finish(null, { duration, width, height, quality: `${Math.min(width, height)}p` });
            }, { once: true });
            video.addEventListener('error', () => finish(new Error('Video cannot be read (expired URL or access denied)')), { once: true });
            document.body.appendChild(video);
            video.src = streamUrl;
            video.load();
        });
    }

    async function fetchMetadata(hd = false, feedVisibleOnly = false, onlyMissing = false, quiet = false) {
        const say = (message) => { if (feedVisibleOnly && !quiet) toast(message); };
        if (state.hydrating || state.collecting || state.busy) {
            say('Zisťovanie údajov už prebieha.');
            return;
        }
        scanCards();
        const selected = selectedItems();
        const items = feedVisibleOnly
            ? visibleItems().filter(item => isFeedVideoCard(item.card) && (!onlyMissing || feedItemNeedsMeta(item)))
            : selected.length ? selected : visibleItems();
        if (!items.length) {
            say(onlyMissing ? 'Všetky načítané videá už majú údaje.' : 'Nenašli sa žiadne načítané video-príspevky.');
            return;
        }
        state.hydrating = true;
        state.fetchCancelled = false;
        let cursor = 0, done = 0, complete = 0;
        state.fetchProgress = `Zisťujem 0/${items.length} (${feedVisibleOnly ? 'viditeľné' : selected.length ? 'vybrané' : 'zobrazené'} videá)`;
        updateUi();
        say(`Zisťujem údaje pre ${items.length} načítaných videí.`);
        const worker = async () => {
            while (cursor < items.length && !state.fetchCancelled) {
                const item = items[cursor++];
                item.metadataLoading = true;
                upsertUi(item);
                try {
                    const data = await requestMetadata(item);
                    item.streamUrl = data.streamUrl || '';
                    item.addedAt = data.addedAt || item.addedAt || '';
                    item.sizeMb = Number(data.sizeMb) > 0 ? Number(data.sizeMb) : null;
                    item.sizeText = item.sizeMb ? formatSize(item.sizeMb) : '';
                    item.sizeExact = Boolean(data.sizeExact);
                    if (data.error || !data.streamUrl) throw new Error(data.error || 'Video source unavailable');
                    Object.assign(item, await probeVideoMetadata(data.streamUrl));
                    if (hd && item.card.querySelector('img')) {
                        item.thumbnailError = '';
                        try { item.card.querySelector('img').src = await captureThumbnail(data.streamUrl); }
                        catch (error) { item.thumbnailError = error.message; }
                        // Keep the remote poster in import payloads; data URLs can be very large.
                    }
                    item.metadataError = [item.sizeMb ? '' : 'Server neuviedol presnú veľkosť súboru', item.thumbnailError || ''].filter(Boolean).join(' · ');
                    if (item.sizeMb) complete++;
                    saveStoredMeta(item.id, item);
                    if (item.url) saveStoredMeta(item.url, item);
                } catch (error) {
                    item.duration = 0;
                    item.quality = '';
                    item.width = item.height = 0;
                    item.metadataError = error.message;
                } finally {
                    item.metadataLoading = false;
                    item.metadataAttempted = true;
                    upsertUi(item);
                    applyView();
                    feedPanelApply();
                    done++;
                    state.fetchProgress = `Zistené ${done}/${items.length} · ${complete} kompletných · ${done - complete} neúplných`;
                    updateUi();
                }
            }
        };
        try { await Promise.all([worker(), worker()]); }
        finally {
            state.hydrating = false;
            if (state.fetchCancelled) state.fetchProgress = `Zastavené · ${state.fetchProgress}`;
            updateUi();
            say(state.fetchCancelled ? 'Zisťovanie údajov zastavené.' : `Hotovo: ${complete}/${items.length} videí má kompletné údaje.`);
            feedPanelApply();
        }
    }

    function captureThumbnail(streamUrl) {
        return new Promise((resolve, reject) => {
            const video = document.createElement('video');
            video.crossOrigin = 'anonymous'; video.muted = true; video.preload = 'auto';
            let settled = false;
            const finish = (error, image) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer); video.removeAttribute('src'); video.load();
                if (error) reject(error); else resolve(image);
            };
            const timer = setTimeout(() => finish(new Error('HD náhľad: timeout')), 18000);
            video.onloadedmetadata = () => { video.currentTime = Math.min(3, video.duration / 4); };
            video.onseeked = () => {
                try {
                    const canvas = document.createElement('canvas');
                    const scale = Math.min(1, 1920 / video.videoWidth);
                    canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
                    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                    finish(null, canvas.toDataURL('image/jpeg', 0.9));
                } catch { finish(new Error('HD náhľad blokuje CORS')); }
            };
            video.onerror = () => finish(new Error('HD náhľad sa nedá načítať'));
            video.src = streamUrl;
        });
    }

    /* ---------------------------------------------------------------- import */

    function importItems(items) {
        if (state.collecting || state.hydrating || state.busy) return;
        const payload = items.map(({ id, url, title, thumbnail, duration, quality, width, height, sizeMb, sizeText }) => ({
            id,
            url,
            title,
            thumbnail,
            duration,
            quality,
            width: width || 0,
            height: height || 0,
            sizeMb,
            sizeText,
            sourceUrl: location.href,
        }));
        if (!payload.length) return;
        const bar = getEl(TOOLBAR_ID);
        const nameInput = bar?.querySelector('[data-role="batch-name"]');
        const asBoard = !!bar?.querySelector('[data-role="as-board"]')?.checked;
        const importName = (nameInput?.value || '').replace(/\s+/g, ' ').trim() || detectGroupName() || 'FapFolder Extension';
        setBusy(true);
        const message = { action: 'FAPFOLDER_IMPORT_BULK', batchName: importName, items: payload };
        if (asBoard) message.sourceBoard = { name: importName, sourceUrl: location.origin + location.pathname.replace(/\/(videos|gallery|timeline)\/?$/i, '') };
        chrome.runtime.sendMessage(message, (res) => {
            setBusy(false);
            const runtimeError = chrome.runtime.lastError;
            if (runtimeError || !res?.ok) {
                toast(`Import zlyhal: ${runtimeError?.message || res?.error || 'neznáma chyba'}`, true);
                return;
            }
            toast(`Zaradených ${res.data?.count || payload.length} videí do importu`);
            // Import sa zapíše do histórie, aby bolo vidno, čo a koľko sa už poslalo.
            void cache.logImport({
                at: Date.now(),
                name: importName,
                count: Number(res.data?.count) || payload.length,
                asBoard,
                sources: [...new Set(items.map(item => item.sources ? [...item.sources].join(' / ') : '').filter(Boolean))],
            }).then(() => refreshHistory());
            items.forEach((item) => { item.selected = false; upsertUi(item); });
            updateUi();
        });
    }

    /* ---------------------------------------------------------------- combined library */

    let nativeItems = null;

    function mixCardThumb(item, poster) {
        if (!item.thumbnail) {
            poster.classList.add('nexus-ff-thumb-missing');
            poster.dataset.placeholder = (item.title || '?').trim().slice(0, 1).toUpperCase();
            return null;
        }
        const img = document.createElement('img');
        img.src = item.thumbnail;
        img.alt = item.title;
        img.loading = 'lazy';
        img.decoding = 'async';
        img.onerror = () => {
            img.remove();
            poster.classList.add('nexus-ff-thumb-missing');
            poster.dataset.placeholder = (item.title || '?').trim().slice(0, 1).toUpperCase();
        };
        return img;
    }

    let activeModalItem = null;
    let modalZoom = 1;

    function ensureVideoModal() {
        if (typeof document === 'undefined') return null;
        let modal = document.getElementById?.('nexus-ff-video-modal');
        if (modal) return modal;

        modal = document.createElement('div');
        modal.id = 'nexus-ff-video-modal';
        modal.className = 'nexus-ff-modal-overlay';
        modal.style.display = 'none';
        modal.innerHTML = `
            <div class="nexus-ff-modal-box">
                <div class="nexus-ff-modal-header">
                    <div class="nexus-ff-modal-title-wrap">
                        <span class="nexus-ff-modal-origin"></span>
                        <h2 class="nexus-ff-modal-title"></h2>
                    </div>
                    <div class="nexus-ff-modal-header-actions">
                        <button type="button" class="nexus-ff-modal-btn" data-role="modal-split" title="Prehrať v Split-Screen">📺 Split-Screen</button>
                        <button type="button" class="nexus-ff-modal-close" data-role="modal-close" aria-label="Zavrieť prehrávač">&times;</button>
                    </div>
                </div>

                <div class="nexus-ff-modal-stage">
                    <button type="button" class="nexus-ff-modal-nav nexus-ff-modal-prev" data-role="modal-prev" title="Predchádzajúce video (Shift+Šípka vľavo)">&#10094;</button>
                    <div class="nexus-ff-modal-video-wrap">
                        <video class="nexus-ff-modal-video" controls autoplay playsinline preload="auto"></video>
                        <div class="nexus-ff-modal-loader" data-role="modal-loader" style="display:none;">
                            <div class="nexus-ff-modal-spinner"></div>
                            <div class="nexus-ff-modal-loader-text">Pripravujem prehrávač…</div>
                            <div class="nexus-ff-modal-loader-sub">Zisťujem priamy stream</div>
                            <button type="button" class="nexus-ff-modal-retry-btn" data-role="modal-retry" style="display:none;">Skúsiť znova</button>
                        </div>
                    </div>
                    <button type="button" class="nexus-ff-modal-nav nexus-ff-modal-next" data-role="modal-next" title="Nasledujúce video (Shift+Šípka vpravo)">&#10095;</button>
                </div>

                <div class="nexus-ff-modal-footer">
                    <div class="nexus-ff-modal-meta">
                        <span class="nexus-ff-modal-chip nexus-ff-modal-quality" data-role="modal-quality">HD</span>
                        <span class="nexus-ff-modal-meta-item" data-role="modal-duration"></span>
                        <span class="nexus-ff-modal-meta-item" data-role="modal-size"></span>
                    </div>

                    <div class="nexus-ff-modal-controls">
                        <div class="nexus-ff-modal-speed-wrap">
                            <label>Rýchlosť:</label>
                            <select class="nexus-ff-modal-select" data-role="modal-speed">
                                <option value="0.5">0.5×</option>
                                <option value="0.75">0.75×</option>
                                <option value="1" selected>1.0×</option>
                                <option value="1.25">1.25×</option>
                                <option value="1.5">1.5×</option>
                                <option value="2">2.0×</option>
                            </select>
                        </div>

                        <div class="nexus-ff-modal-zoom-group">
                            <button type="button" class="nexus-ff-modal-btn" data-role="zoom-out" title="Zmenšiť">Zoom -</button>
                            <button type="button" class="nexus-ff-modal-btn" data-role="zoom-reset" title="Pôvodná veľkosť">100%</button>
                            <button type="button" class="nexus-ff-modal-btn" data-role="zoom-in" title="Zväčšiť">Zoom +</button>
                        </div>

                        <button type="button" class="nexus-ff-modal-btn" data-role="modal-copy-url" title="Skopírovať priamy odkaz na video">📋 Kopírovať stream</button>
                        <a class="nexus-ff-modal-btn" data-role="modal-open-tab" target="_blank" rel="noopener" title="Otvoriť v novej karte">↗ Otvoriť</a>
                    </div>
                </div>
            </div>
        `;
        document.body?.appendChild?.(modal);

        const video = modal.querySelector('video');
        const closeBtn = modal.querySelector('[data-role="modal-close"]');
        const prevBtn = modal.querySelector('[data-role="modal-prev"]');
        const nextBtn = modal.querySelector('[data-role="modal-next"]');
        const retryBtn = modal.querySelector('[data-role="modal-retry"]');
        const speedSel = modal.querySelector('[data-role="modal-speed"]');
        const zoomIn = modal.querySelector('[data-role="zoom-in"]');
        const zoomOut = modal.querySelector('[data-role="zoom-out"]');
        const zoomReset = modal.querySelector('[data-role="zoom-reset"]');
        const copyBtn = modal.querySelector('[data-role="modal-copy-url"]');
        const splitBtn = modal.querySelector('[data-role="modal-split"]');

        if (closeBtn) closeBtn.onclick = closeVideoModal;
        modal.onclick = (e) => {
            if (e.target === modal) closeVideoModal();
        };

        if (speedSel) {
            speedSel.onchange = () => {
                if (video) video.playbackRate = parseFloat(speedSel.value) || 1;
            };
        }

        const updateZoom = (level) => {
            modalZoom = Math.min(2.5, Math.max(0.5, level));
            if (video) {
                video.style.transform = `scale(${modalZoom})`;
                video.style.transformOrigin = 'center center';
                video.style.transition = 'transform 0.15s ease';
            }
        };
        if (zoomIn) zoomIn.onclick = () => updateZoom(modalZoom + 0.2);
        if (zoomOut) zoomOut.onclick = () => updateZoom(modalZoom - 0.2);
        if (zoomReset) zoomReset.onclick = () => updateZoom(1);

        if (copyBtn) {
            copyBtn.onclick = () => {
                if (!activeModalItem?.streamUrl) {
                    toast('Odkaz na stream zatiaľ nie je pripravený', true);
                    return;
                }
                if (navigator?.clipboard?.writeText) {
                    navigator.clipboard.writeText(activeModalItem.streamUrl).then(() => {
                        toast('Priamy MP4 stream skopírovaný do schránky');
                    }).catch(() => { toast(activeModalItem.streamUrl); });
                } else {
                    toast(activeModalItem.streamUrl);
                }
            };
        }

        if (splitBtn) {
            splitBtn.onclick = () => {
                if (!activeModalItem) return;
                const payload = [{
                    url: activeModalItem.url,
                    watchUrl: activeModalItem.url,
                    streamUrl: activeModalItem.streamUrl || '',
                    title: activeModalItem.title,
                    poster: activeModalItem.thumbnail || '',
                }];
                document.dispatchEvent(new CustomEvent('nexus-fapfolder-split-open', {
                    detail: JSON.stringify(payload)
                }));
                toast('Otváram video v Split-Screen prehrávači 📺');
            };
        }

        if (prevBtn) prevBtn.onclick = () => navigateModal(-1);
        if (nextBtn) nextBtn.onclick = () => navigateModal(1);
        if (retryBtn) {
            retryBtn.onclick = () => {
                if (activeModalItem) openVideoModal(activeModalItem);
            };
        }

        document.addEventListener?.('keydown', (e) => {
            if (modal.style.display === 'none') return;
            if (e.key === 'Escape') {
                e.preventDefault();
                closeVideoModal();
            } else if (e.key === ' ' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
                e.preventDefault();
                if (video) { if (video.paused) video.play(); else video.pause(); }
            } else if (e.key === 'ArrowLeft') {
                if (e.shiftKey) {
                    e.preventDefault();
                    navigateModal(-1);
                } else if (video) {
                    e.preventDefault();
                    video.currentTime = Math.max(0, video.currentTime - 5);
                }
            } else if (e.key === 'ArrowRight') {
                if (e.shiftKey) {
                    e.preventDefault();
                    navigateModal(1);
                } else if (video) {
                    e.preventDefault();
                    video.currentTime = Math.min(video.duration || 99999, video.currentTime + 5);
                }
            } else if (e.key === 'f' || e.key === 'F') {
                if (document.fullscreenElement) document.exitFullscreen?.();
                else video?.requestFullscreen?.();
            } else if (e.key === 'm' || e.key === 'M') {
                if (video) video.muted = !video.muted;
            }
        });

        return modal;
    }

    function navigateModal(direction) {
        if (!activeModalItem) return;
        const visible = visibleItems();
        if (!visible.length) return;
        const currentIndex = visible.findIndex(i => i.id === activeModalItem.id);
        if (currentIndex < 0) return;
        let nextIndex = currentIndex + direction;
        if (nextIndex < 0) nextIndex = visible.length - 1;
        if (nextIndex >= visible.length) nextIndex = 0;
        openVideoModal(visible[nextIndex]);
    }

    function closeVideoModal() {
        const modal = document.getElementById?.('nexus-ff-video-modal');
        if (!modal) return;
        const video = modal.querySelector('video');
        if (video) {
            video.pause();
            video.removeAttribute('src');
            video.load();
        }
        modal.style.display = 'none';
        document.body?.classList?.remove('nexus-ff-modal-open');
    }

    async function openVideoModal(item) {
        if (!item) return;
        activeModalItem = item;
        const modal = ensureVideoModal();
        if (!modal) return;
        modal.style.display = 'flex';
        document.body?.classList?.add('nexus-ff-modal-open');

        const titleEl = modal.querySelector('.nexus-ff-modal-title');
        const originEl = modal.querySelector('.nexus-ff-modal-origin');
        const qualityEl = modal.querySelector('[data-role="modal-quality"]');
        const durationEl = modal.querySelector('[data-role="modal-duration"]');
        const sizeEl = modal.querySelector('[data-role="modal-size"]');
        const openTabLink = modal.querySelector('[data-role="modal-open-tab"]');
        const loader = modal.querySelector('[data-role="modal-loader"]');
        const loaderText = loader?.querySelector('.nexus-ff-modal-loader-text');
        const loaderSub = loader?.querySelector('.nexus-ff-modal-loader-sub');
        const retryBtn = loader?.querySelector('[data-role="modal-retry"]');
        const video = modal.querySelector('video');

        modalZoom = 1;
        if (video) video.style.transform = 'scale(1)';
        const speedSel = modal.querySelector('[data-role="modal-speed"]');
        if (speedSel && video) { speedSel.value = '1'; video.playbackRate = 1; }

        if (titleEl) {
            titleEl.textContent = item.title || 'Video Player';
            titleEl.title = item.title || '';
        }
        const sourceName = item.sources ? [...item.sources].join(' · ') : (item.sourceName || detectGroupName() || 'FapFolder');
        if (originEl) {
            originEl.textContent = sourceName;
            originEl.style.display = sourceName ? 'inline-block' : 'none';
        }

        if (qualityEl) qualityEl.textContent = item.quality || (isHd(item) ? 'HD' : 'SD');
        if (durationEl) durationEl.textContent = item.duration > 0 ? `⏱ ${formatDuration(item.duration)}` : '';
        if (sizeEl) sizeEl.textContent = item.sizeMb > 0 ? `💾 ${formatSize(item.sizeMb)}` : '';
        if (openTabLink) openTabLink.href = item.url;

        hydrateItemMeta(item);
        if (item.streamUrl) {
            if (loader) loader.style.display = 'none';
            if (video) {
                video.src = item.streamUrl;
                video.poster = item.thumbnail || '';
                video.play().catch(() => {});
            }
            return;
        }

        if (loader) loader.style.display = 'flex';
        if (loaderText) loaderText.textContent = 'Pripravujem prehrávač…';
        if (loaderSub) loaderSub.textContent = 'Zisťujem priamy MP4 stream';
        if (retryBtn) retryBtn.style.display = 'none';
        if (video) video.removeAttribute('src');

        try {
            const data = await requestMetadata(item);
            if (!data.streamUrl || data.error) throw new Error(data.error || 'Video nie je dostupné');
            item.streamUrl = data.streamUrl;
            if (data.sizeMb) item.sizeMb = data.sizeMb;
            if (data.duration) item.duration = data.duration;
            saveStoredMeta(item.id, item);
            if (item.url) saveStoredMeta(item.url, item);

            if (durationEl && item.duration > 0) durationEl.textContent = `⏱ ${formatDuration(item.duration)}`;
            if (sizeEl && item.sizeMb > 0) sizeEl.textContent = `💾 ${formatSize(item.sizeMb)}`;
            if (qualityEl) qualityEl.textContent = item.quality || (isHd(item) ? 'HD' : 'SD');

            if (loader) loader.style.display = 'none';
            if (video) {
                video.src = data.streamUrl;
                video.poster = item.thumbnail || '';
                video.play().catch(() => {});
            }
            upsertUi(item);
        } catch (error) {
            if (loader) loader.style.display = 'flex';
            if (loaderText) loaderText.textContent = 'Chyba prehrávania';
            if (loaderSub) loaderSub.textContent = error.message || 'Stream sa nepodarilo získať.';
            if (retryBtn) retryBtn.style.display = 'inline-block';
        }
    }

    async function playMixItem(item, card, poster, play) {
        openVideoModal(item);
    }

    async function appendMixItems(items, source) {
        const grid = document.querySelector('#nexus-ff-mix .nexus-ff-mix-grid');
        if (!grid) return;
        for (let start = 0; start < items.length; start += 20) {
            for (const item of items.slice(start, start + 20)) {
                hydrateItemMeta(item);
                const previous = state.items.get(item.id);
                if (previous) {
                    if (!(previous.sources instanceof Set)) previous.sources = new Set(previous.sources || []);
                    previous.sources.add(source.name);
                    const origin = previous.card?.querySelector('.nexus-ff-origin');
                    if (origin) origin.textContent = [...previous.sources].join(' · ');
                    continue;
                }
                const card = document.createElement('article');
                card.className = 'nexus-ff-mix-card';
                const poster = document.createElement('div');
                poster.className = 'nexus-ff-poster';
                const thumb = mixCardThumb(item, poster);
                if (thumb) poster.append(thumb);
                const duration = document.createElement('span');
                duration.className = 'nexus-ff-duration';
                duration.hidden = true;
                const play = document.createElement('button');
                play.type = 'button';
                play.className = 'nexus-ff-play';
                play.setAttribute('aria-label', `Prehrať: ${item.title}`);
                play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
                poster.append(duration, play);

                const body = document.createElement('div');
                body.className = 'nexus-ff-mix-body';
                const title = document.createElement('a');
                title.className = 'nexus-ff-mix-title';
                title.href = item.url;
                title.target = '_blank';
                title.rel = 'noopener';
                let cleanName = (item.title || '').replace(/(?:onlyfans|sexy|hot|nude|video|thumbnail|leak|\.mp4)/gi, '').replace(/\s+/g, ' ').trim();
                title.textContent = cleanName || item.title;
                const origin = document.createElement('small');
                origin.className = 'nexus-ff-origin';
                origin.textContent = source.name;
                const meta = document.createElement('div');
                meta.className = 'nexus-ff-mix-meta';
                body.append(title, origin, meta);

                card.append(poster, body);
                poster.style.cursor = 'pointer';
                poster.onclick = (e) => {
                    if (e.target.closest('button, input, label')) return;
                    openVideoModal(item);
                };
                play.onclick = (e) => {
                    e.stopPropagation();
                    openVideoModal(item);
                };
                grid.append(card);
                item.card = card;
                // Zdroj môže prísť z histórie už s názvami zdrojov, v ktorých video bolo.
                item.sources = new Set([...(item.sources || []), source.name]);
                item.originalIndex = state.nextIndex++;
                state.items.set(item.id, item);
                upsertUi(item);
            }
            await new Promise(resolve => requestAnimationFrame(resolve));
        }
        applyView();
        updateUi();
    }

    /* Honest aggregate line for the library: recounts the selected sources every
       time, so a stopped or failed collection can never keep stale progress text. */
    function mixSummaryText() {
        const sources = [...state.sources.values()].filter(source => source.selected);
        const cached = sources.filter(source => source.fromCache).length;
        const pending = sources.filter(source => /overujem/.test(source.status || '')).length;
        const complete = sources.filter(source => /kompletné|overené/.test(source.status || '')).length;
        const failed = sources.filter(source => /Neúplné|Zastavené|neúplná|Nenačítané/i.test(source.status || '')).length;
        const stopped = sources.some(source => /Zastavené/.test(source.status || ''));
        const parts = [
            `${state.items.size} jedinečných videí`,
            `${complete}/${sources.length} kompletných zdrojov`,
        ];
        if (cached) parts.push(`${cached} z histórie`);
        if (pending) parts.push(`${pending} overujem`);
        if (failed) parts.push(`${failed} neúplných`);
        if (stopped) parts.push('zastavené');
        return parts.join(' · ');
    }

    async function buildMix() {
        if (state.collecting || state.hydrating || state.busy) return;
        const sources = selectedSources();
        if (!sources.length) { toast('Najprv označ aspoň jednu komunitu alebo pridaj odkaz.', true); return; }
        if (!state.mixActive) { nativeItems = state.items; state.mixActive = true; }
        state.items = new Map();
        state.nextIndex = 0;
        const bar = getEl(TOOLBAR_ID);
        const panel = getEl('nexus-ff-mix');
        panel.querySelector('.nexus-ff-mix-grid')?.replaceChildren();
        panel.querySelector('.nexus-ff-mix-summary').textContent = '';
        state.collecting = true;
        state.collectionAbort = new AbortController();
        panel.dataset.collecting = '1';
        bar.querySelector('[data-role="stop-mix"]').hidden = false;
        state.mixProgress = 'Načítavam videá zo zdrojov...';
        for (const control of bar.querySelectorAll('.nexus-ff-sources-pane button, .nexus-ff-sources-pane textarea')) {
            if (control.dataset.role !== 'stop-mix') control.disabled = true;
        }
        for (const source of sources) {
            source.status = 'Čaká';
            source.fromCache = false;
            source.skipNetwork = false;
            source.baselineIds = null;
        }
        renderSources(); syncSourceChecks(); renderLibraryState(); updateUi();
        let complete = 0, failed = 0;
        const statusEl = bar.querySelector('[data-role="mix-status"]');
        try {
            // Najprv história: čo už bolo načítané, sa zobrazí okamžite a až potom
            // sa to overuje proti sieti.
            const delivered = await deliverFromCache(sources);
            if (delivered) {
                statusEl.hidden = false;
                statusEl.textContent = `Z histórie: ${state.items.size} videí z ${sources.filter(source => source.fromCache).length} zdrojov · overujem proti sieti`;
                panel.querySelector('.nexus-ff-mix-summary').textContent = mixSummaryText();
                renderLibraryState(); applyView(); updateUi();
            }
            for (const source of sources) {
                if (state.collectionAbort.signal.aborted) break;
                if (source.skipNetwork) {
                    // Čerstvá história (do 15 minút) sa dá použiť bez siete.
                    complete++;
                    source.status = `${source.cache.total} videí · z histórie · overené ${formatAgo(source.cache.fetchedAt)}`;
                    renderSources();
                    statusEl.hidden = false;
                    statusEl.textContent = `Načítavam zdroje: ${complete + failed}/${sources.length} · ${state.items.size} jedinečných videí`;
                    continue;
                }
                try {
                    await collectSource(source, state.collectionAbort.signal, items => appendMixItems(items, source), true, {
                        baseline: source.baselineIds,
                    });
                    complete++;
                } catch (error) {
                    source.status = state.collectionAbort.signal.aborted ? 'Zastavené · neúplné' : `Neúplné: ${error.message}`;
                    failed++;
                }
                renderSources();
                statusEl.hidden = false;
                statusEl.textContent = `Načítavam zdroje: ${complete + failed}/${sources.length} · ${state.items.size} jedinečných videí`;
            }
        } finally {
            for (const source of sources) if (source.status === 'Čaká') source.status = 'Nenačítané';
            panel.querySelector('.nexus-ff-mix-summary').textContent = mixSummaryText();
            statusEl.hidden = true;
            statusEl.textContent = '';
            state.collecting = false;
            state.collectionAbort = null;
            state.mixProgress = '';
            delete panel.dataset.collecting;
            bar.querySelector('[data-role="stop-mix"]').hidden = true;
            for (const control of bar.querySelectorAll('.nexus-ff-sources-pane button, .nexus-ff-sources-pane textarea')) control.disabled = false;
            renderSources(); syncSourceChecks(); applyView(); updateUi(); queueDateFetch();
            // Kombinácia zdrojov sa zapamätá, aby sa dala z histórie otvoriť jedným klikom.
            await saveLibraryHistory(sources);
        }
    }

    /* Doručí z histórie všetko, čo už bolo načítané, skôr než sa čokoľvek pošle
       na sieť. Vráti počet doručených videí. */
    async function deliverFromCache(sources) {
        let delivered = 0;
        for (const source of sources) {
            const record = await cache.getSource(source.url);
            if (!record?.items?.length) { source.cache = source.cache || null; continue; }
            source.cache = summarizeCache(record);
            const age = Date.now() - Number(record.fetchedAt || 0);
            const fresh = Boolean(record.complete) && age >= 0 && age < CACHE_FRESH_MS;
            source.fromCache = true;
            source.baselineIds = new Set(record.items.map(item => item.id));
            source.skipNetwork = fresh;
            source.status = `${source.cache.total} videí · z histórie (${formatAgo(record.fetchedAt)})${record.complete ? '' : ' · neúplná'}${fresh ? ' · čerstvá' : ''}`;
            await appendMixItems(record.items, source);
            delivered += record.items.length;
            renderSources();
        }
        return delivered;
    }

    /* Knižnica = kombinácia zdrojov. Rovnaká kombinácia sa v histórii aktualizuje,
       aby zoznam nezaplnili stovky takmer rovnakých záznamov. */
    async function saveLibraryHistory(sources) {
        if (!state.items.size || !sources.length) return;
        const ordered = [...sources].sort((a, b) => a.url.localeCompare(b.url));
        const previous = await cache.getLibrary(ordered.map(source => source.url).join('|'));
        const statuses = ordered.map(source => source.status || '');
        const record = {
            key: ordered.map(source => source.url).join('|'),
            name: ordered.map(source => source.name).join(' · '),
            sources: ordered.map(source => ({ url: source.url, name: source.name })),
            itemCount: state.items.size,
            complete: statuses.every(status => /kompletné|overené/.test(status)),
            partial: statuses.some(status => /Neúplné|Zastavené|neúplná|Nenačítané/i.test(status)),
            createdAt: Number(previous?.createdAt) || Date.now(),
            updatedAt: Date.now(),
            openCount: (Number(previous?.openCount) || 0) + 1,
        };
        await cache.saveLibrary(record);
        await cache.prune();
        await refreshHistory();
    }

    /* ---------------------------------------------------------------- workspace */

    function createWidgets() {
        if (getEl(TOOLBAR_ID)) return;

        const bar = document.createElement('div');
        bar.id = TOOLBAR_ID;
        bar.className = 'nexus-ff-toolbar';
        bar.innerHTML = `
            <header class="nexus-ff-header">
                <div class="nexus-ff-brand"><span class="nexus-ff-brand-name">NEXUS</span><span class="nexus-ff-brand-host">/ FapFolder</span></div>
                <nav class="nexus-ff-nav" role="tablist" aria-label="Nexus sekcie">
                    <button type="button" role="tab" data-tab="communities" aria-controls="nexus-ff-page-communities">Komunity</button>
                    <button type="button" role="tab" data-tab="library" aria-controls="nexus-ff-page-library">Video knižnica</button>
                </nav>
                <div class="nexus-ff-header-actions">
                    <button type="button" class="nexus-ff-icon-btn" data-role="minimize" aria-label="Skryť Nexus a vrátiť sa na stránku" title="Skryť na stránku">
                        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 12h14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
                    </button>
                </div>
            </header>

            <section class="nexus-ff-page nexus-ff-page-communities" data-page="communities" id="nexus-ff-page-communities" role="tabpanel" aria-label="Komunity">
                <div class="nexus-ff-page-scroll">
                    <div class="nexus-ff-page-inner">
                        <div class="nexus-ff-heading">
                            <div>
                                <h1>Tvoje komunity</h1>
                                <p class="nexus-ff-muted">Vyber zdroje. Spoj ich videá do jednej knižnice.</p>
                            </div>
                            <div class="nexus-ff-heading-actions">
                                <button type="button" data-role="audit-selected">Zistiť údaje vybraných</button>
                                <label class="nexus-ff-field">Zoradiť
                                    <select data-role="community-sort" aria-label="Zoradiť komunity">
                                        <option value="original">pôvodné poradie</option>
                                        <option value="name">názov</option>
                                        <option value="count">počet videí</option>
                                        <option value="size">veľkosť</option>
                                    </select>
                                </label>
                            </div>
                        </div>
                        <div class="nexus-ff-community-host" data-role="community-host"></div>
                        <p class="nexus-ff-communities-empty" data-role="communities-empty" hidden>Na tejto stránke Nexus nenašiel žiadne komunity. Otvor stránku komunity alebo pridaj odkaz do knižnice.</p>
                    </div>
                </div>
                <div class="nexus-ff-communities-bar">
                    <div class="nexus-ff-communities-summary">
                        <strong data-role="communities-count">0 komunít vybraných</strong>
                        <span class="nexus-ff-muted" data-role="communities-aggregate">Vyber komunitu alebo pridaj odkaz.</span>
                    </div>
                    <div class="nexus-ff-actions">
                        <button type="button" data-role="communities-clear">Zrušiť výber</button>
                        <button type="button" class="primary" data-role="open-library" disabled>Otvoriť spoločnú knižnicu</button>
                    </div>
                </div>
            </section>

            <section class="nexus-ff-page nexus-ff-page-library" data-page="library" id="nexus-ff-page-library" role="tabpanel" aria-label="Video knižnica" hidden>
                <aside class="nexus-ff-sources nexus-ff-sources-pane" data-open="0">
                    <div class="nexus-ff-side-brand">
                        <div class="nexus-ff-side-brand-left">
                            <div class="nexus-ff-side-logo">N</div>
                            <div class="nexus-ff-side-title">
                                <span class="nexus-ff-vault-nexus">NEXUS</span>
                                <span class="nexus-ff-vault-sub">VAULT</span>
                            </div>
                            <span class="nexus-ff-vault-badge">PRO</span>
                        </div>
                        <button type="button" class="nexus-ff-side-collapse-btn" data-role="toggle-sidebar" title="Zbaliť panel tvorcov">◀</button>
                    </div>

                    <div class="nexus-ff-vault-stats-card">
                        <div class="nexus-ff-vault-stats-label">Celkový Archív</div>
                        <div class="nexus-ff-vault-stats-val" data-role="vault-total">0 videí (0 GB)</div>
                    </div>

                    <div class="nexus-ff-side-search-wrap">
                        <input type="text" class="nexus-ff-side-search" placeholder="Filtrovať tvorcov..." aria-label="Filtrovať tvorcov">
                    </div>

                    <div class="nexus-ff-side-section-header">
                        <span class="nexus-ff-side-section-title">TVOJI TVORCOVIA</span>
                        <div class="nexus-ff-sources-quick-actions">
                            <button type="button" class="nexus-ff-quick-btn" data-role="sources-select-all" title="Označiť všetkých tvorcov">✓ Všetko</button>
                            <button type="button" class="nexus-ff-quick-btn" data-role="sources-clear-all" title="Odznačiť všetkých tvorcov">✗ Nič</button>
                        </div>
                    </div>

                    <div class="nexus-ff-sources-body">
                        <div class="nexus-ff-source-list" data-role="sources-list"></div>

                        <details class="nexus-ff-importer-accordion">
                            <summary class="nexus-ff-add-scraper-btn">+ Pridať Linku / Scraper</summary>
                            <div class="nexus-ff-source-add">
                                <label class="nexus-ff-label" for="nexus-ff-source-urls">Odkaz na komunitu</label>
                                <textarea id="nexus-ff-source-urls" data-role="source-urls" placeholder="https://fapfolder.club/groups/..."></textarea>
                                <div class="nexus-ff-actions">
                                    <button type="button" data-role="add-sources">Pridať odkaz</button>
                                    <button type="button" data-role="current-source">Aktuálna stránka</button>
                                </div>
                                <div class="nexus-ff-source-primary">
                                    <button type="button" class="primary" data-role="build-mix" disabled>Načítať videá</button>
                                    <button type="button" data-role="stop-mix" hidden>Zastaviť</button>
                                </div>
                                <div class="nexus-ff-collection-status" data-role="mix-status" role="status" aria-live="polite" hidden></div>
                            </div>
                        </details>
                    </div>
                </aside>

                <main class="nexus-ff-library-main">
                    <div class="nexus-ff-hero-header">
                        <button type="button" class="nexus-ff-side-expand-btn" data-role="expand-sidebar" title="Rozbaliť panel tvorcov" hidden>☰ Tvorcovia</button>
                        <div class="nexus-ff-hero-profile">
                            <div class="nexus-ff-hero-avatar-wrap">
                                <div class="nexus-ff-hero-avatar">
                                    <span class="nexus-ff-hero-initial">★</span>
                                </div>
                                <span class="nexus-ff-hero-star">⭐</span>
                            </div>
                            <div class="nexus-ff-hero-info">
                                <div class="nexus-ff-hero-title-row">
                                    <h1 class="nexus-ff-hero-title">Spoločná knižnica</h1>
                                    <span class="nexus-ff-vip-badge">VIP CREATOR</span>
                                </div>
                                <div class="nexus-ff-hero-stats-row">
                                    <div class="nexus-ff-library-metrics">0 videí · — GB · — priemer</div>
                                    <span class="nexus-ff-verified-dot">● Všetky načítané</span>
                                </div>
                            </div>
                        </div>

                        <div class="nexus-ff-hero-controls">
                            <div class="nexus-ff-search-box">
                                <svg class="nexus-ff-search-icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                                <input type="search" class="nexus-ff-search" placeholder="Hľadať vo videách..." aria-label="Hľadať videá">
                            </div>

                            <div class="nexus-ff-density-selector">
                                <button type="button" class="nexus-ff-density-btn" data-density="6">Kompaktné (6)</button>
                                <button type="button" class="nexus-ff-density-btn active" data-density="5">Optimálne (5)</button>
                                <button type="button" class="nexus-ff-density-btn" data-density="3">Veľké (3)</button>
                            </div>

                            <div class="nexus-ff-hero-dropdowns">
                                <select data-filter="sort" aria-label="Zoradiť videá" class="nexus-ff-compact-select">
                                    <option value="original">Pôvodné poradie</option>
                                    <option value="sizeMb">Najväčšie</option>
                                    <option value="duration">Najdlhšie</option>
                                    <option value="quality">Kvalita</option>
                                </select>
                                <button type="button" data-role="fetch-meta" class="nexus-ff-action-pill" title="Zistiť údaje o videách">⚡ Zistiť údaje</button>
                                <button type="button" data-role="hd-thumbs" class="nexus-ff-action-pill" title="HD náhľady">💎 HD</button>
                                <button type="button" data-role="cancel-meta" class="nexus-ff-action-pill" hidden>Zastaviť</button>
                            </div>

                            <button type="button" class="nexus-ff-icon-btn nexus-ff-close" data-role="close-mix" aria-label="Zavrieť spoločnú knižnicu" title="Zavrieť knižnicu">
                                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
                            </button>
                        </div>
                    </div>

                    <!-- Dopamínové Filtre / Pills -->
                    <div class="nexus-ff-dopamine-strip">
                        <button type="button" class="nexus-ff-filter-pill active" data-pill="all">🔥 Všetky</button>
                        <button type="button" class="nexus-ff-filter-pill" data-pill="fav">⭐ Obľúbené</button>
                        <button type="button" class="nexus-ff-filter-pill" data-pill="hd">💎 1080p / 4K UHD</button>
                        <button type="button" class="nexus-ff-filter-pill" data-pill="short">⚡ Rýchle klipy (&lt; 1 min)</button>
                        <button type="button" class="nexus-ff-filter-pill" data-pill="long">💎 Dlhé exkluzívne (&gt; 3 min)</button>
                        <button type="button" class="nexus-ff-filter-pill" data-pill="new">✨ Novo stiahnuté</button>
                    </div>

                    <div class="nexus-ff-filters" hidden>
                        <div class="nexus-ff-range"><span>Dĺžka (min)</span><input type="number" min="0" step="any" data-filter="durationMin" aria-label="Minimálna dĺžka v minútach" placeholder="Min"><input type="number" min="0" step="any" data-filter="durationMax" aria-label="Maximálna dĺžka v minútach" placeholder="Max"></div>
                        <div class="nexus-ff-range"><span>Veľkosť (MB)</span><input type="number" min="0" step="any" data-filter="sizeMin" aria-label="Minimálna veľkosť v MB" placeholder="Min"><input type="number" min="0" step="any" data-filter="sizeMax" aria-label="Maximálna veľkosť v MB" placeholder="Max"></div>
                        <div class="nexus-ff-quality-label">Kvalita — označ, čo chceš vidieť</div>
                        <div class="nexus-ff-qualities"></div>
                        <button type="button" data-role="reset-filters">Zrušiť filtre</button>
                    </div>

                    <div class="nexus-ff-progress" role="status" aria-live="polite" hidden></div>

                    <div id="nexus-ff-mix" class="nexus-ff-library-body">
                        <div class="nexus-ff-mix-summary" role="status" aria-live="polite"></div>
                        <div class="nexus-ff-loading" role="status" aria-live="polite" hidden></div>
                        <div class="nexus-ff-empty" hidden></div>
                        <div class="nexus-ff-mix-grid" data-density="5"></div>
                    </div>

                    <details class="nexus-ff-advanced" hidden>
                        <summary>Ďalšie možnosti</summary>
                        <div class="nexus-ff-advanced-body">
                            <div class="nexus-ff-import-target">
                                <div class="nexus-ff-range">
                                    <span>Batch / board</span>
                                    <input type="text" data-role="batch-name" aria-label="Názov importu" placeholder="Názov importu">
                                    <button type="button" data-role="name-reset" title="Obnoviť názov podľa stránky">↺</button>
                                </div>
                                <label class="nexus-ff-board-check"><input type="checkbox" data-role="as-board"> Uložiť ako Source Board</label>
                            </div>
                            <div class="nexus-ff-actions">
                                <button type="button" data-role="refresh">Obnoviť zoznam</button>
                                <button type="button" data-role="select-visible">Vybrať zobrazené</button>
                                <button type="button" data-role="import-visible" disabled>Importovať zobrazené</button>
                            </div>
                        </div>
                    </details>

                    <div class="nexus-ff-import-strip">
                        <span data-role="selection-summary">0 videí vybraných</span>
                        <div class="nexus-ff-actions">
                            <button type="button" data-role="select-visible" class="nexus-ff-btn-secondary" title="Vybrať všetky zobrazené videá">✓ Vybrať zobrazené</button>
                            <button type="button" data-role="clear" disabled>Zrušiť výber</button>
                            <button type="button" class="nexus-ff-split-btn" data-role="open-split-screen" title="Prehrať vybrané videá v Split-Screen prehrávači">📺 Split-Screen</button>
                            <button type="button" class="primary" data-role="import-selected" disabled>📥 Stiahnuť vybrané</button>
                        </div>
                    </div>
                </main>
            </section>
        `;
        document.body.appendChild(bar);

        const bubble = document.createElement('div');
        bubble.id = BUBBLE_ID;
        bubble.className = 'nexus-ff-bubble nexus-hidden';
        bubble.setAttribute('role', 'button');
        bubble.tabIndex = 0;
        bubble.setAttribute('aria-label', 'Otvoriť Nexus FapFolder');
        bubble.title = 'Nexus FapFolder — otvoriť';
        bubble.innerHTML = `
            <span class="nexus-ff-bubble-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg></span>
            <span class="nexus-ff-bubble-badge">0</span>
        `;
        document.body.appendChild(bubble);

        const openWorkspace = () => setMinimized(false);
        bubble.addEventListener('click', (event) => { event.stopPropagation(); openWorkspace(); });
        bubble.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openWorkspace(); }
        });

        bar.querySelector('[data-role="minimize"]').addEventListener('click', (event) => {
            event.stopPropagation();
            setMinimized(true);
            toast('Nexus je skrytý v lište. Kliknutím na lištu ho vrátiš.');
        });

        for (const button of bar.querySelectorAll('.nexus-ff-nav button')) {
            button.addEventListener('click', () => switchTab(button.dataset.tab));
        }

        bar.querySelectorAll('.nexus-ff-density-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                bar.querySelectorAll('.nexus-ff-density-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const density = btn.dataset.density;
                const grid = bar.querySelector('.nexus-ff-mix-grid');
                if (grid) grid.dataset.density = density;
            });
        });

        bar.querySelectorAll('.nexus-ff-filter-pill').forEach(pill => {
            pill.addEventListener('click', () => {
                bar.querySelectorAll('.nexus-ff-filter-pill').forEach(p => p.classList.remove('active'));
                pill.classList.add('active');
                state.pillFilter = pill.dataset.pill;
                applyView();
            });
        });

        const sideSearch = bar.querySelector('.nexus-ff-side-search');
        if (sideSearch) {
            sideSearch.addEventListener('input', () => {
                renderSources();
            });
        }

        const toggleSidebar = (collapsed) => {
            const aside = bar.querySelector('.nexus-ff-sources-pane');
            const expandBtn = bar.querySelector('[data-role="expand-sidebar"]');
            const isCollapsed = typeof collapsed === 'boolean' ? collapsed : !aside?.classList.contains('collapsed');
            if (aside) aside.classList.toggle('collapsed', isCollapsed);
            if (expandBtn) expandBtn.hidden = !isCollapsed;
            try { localStorage.setItem('nexus_ff_sidebar_collapsed', isCollapsed ? '1' : '0'); } catch {}
        };
        bar.querySelector('[data-role="toggle-sidebar"]')?.addEventListener('click', () => toggleSidebar(true));
        bar.querySelector('[data-role="expand-sidebar"]')?.addEventListener('click', () => toggleSidebar(false));
        if (localStorage.getItem('nexus_ff_sidebar_collapsed') === '1') toggleSidebar(true);

        bar.querySelector('[data-role="sources-select-all"]')?.addEventListener('click', () => {
            for (const source of state.sources.values()) source.selected = true;
            saveSources();
            syncSourceChecks();
            renderSources();
            applyView();
            updateUi();
        });

        bar.querySelector('[data-role="sources-clear-all"]')?.addEventListener('click', () => {
            for (const source of state.sources.values()) source.selected = false;
            saveSources();
            syncSourceChecks();
            renderSources();
            applyView();
            updateUi();
        });

        bar.querySelector('[data-role="open-split-screen"]')?.addEventListener('click', () => {
            const selected = selectedItems();
            const items = selected.length ? selected : visibleItems().slice(0, 12);
            if (!items.length) {
                toast('Najprv vyber videá pre Split-Screen prehrávač.', true);
                return;
            }
            const payload = items.slice(0, 12).map(item => ({
                url: item.url,
                watchUrl: item.url,
                streamUrl: item.streamUrl || '',
                title: item.title,
                poster: item.thumbnail || '',
            }));
            document.dispatchEvent(new CustomEvent('nexus-fapfolder-split-open', {
                detail: JSON.stringify(payload)
            }));
            toast(`Otváram ${payload.length} videí v Split-Screen prehrávači 📺`);
        });

        bar.querySelector('[data-role="refresh"]')?.addEventListener('click', () => {
            scanCards();
            toast(`Nájdených ${visibleItems().length} videí na stránke`);
        });
        bar.querySelector('[data-role="select-visible"]')?.addEventListener('click', () => {
            visibleItems().forEach((item) => { item.selected = true; upsertUi(item); });
            updateUi();
        });
        bar.querySelector('[data-role="clear"]')?.addEventListener('click', () => {
            state.items.forEach((item) => { item.selected = false; upsertUi(item); });
            updateUi();
        });
        bar.querySelector('[data-role="import-selected"]')?.addEventListener('click', () => importItems(selectedItems()));
        bar.querySelector('[data-role="import-visible"]')?.addEventListener('click', () => importItems(visibleItems()));
        bar.querySelector('[data-role="fetch-meta"]')?.addEventListener('click', () => fetchMetadata());
        bar.querySelector('[data-role="hd-thumbs"]')?.addEventListener('click', () => fetchMetadata(true));
        document.addEventListener('nexus-fapfolder-fetch-visible', () => { void fetchMetadata(false, true); });
        bar.querySelector('[data-role="cancel-meta"]')?.addEventListener('click', () => {
            state.fetchCancelled = true;
            state.fetchProgress = 'Zastavujem... čakám na aktuálne požiadavky';
            updateUi();
        });
        setupSources(bar);

        bar.querySelectorAll('[data-filter]').forEach(control => control.addEventListener(control.tagName === 'SELECT' ? 'change' : 'input', () => {
            state.filters[control.dataset.filter] = control.value;
            applyView(); updateUi();
        }));
        bar.querySelector('[data-role="reset-filters"]')?.addEventListener('click', () => resetAllFilters());
        bar.querySelector('[data-role="toggle-filters"]')?.addEventListener('click', (event) => {
            const panel = bar.querySelector('.nexus-ff-filters');
            if (panel) {
                const open = panel.hidden;
                panel.hidden = !open;
                event.currentTarget.setAttribute('aria-expanded', String(open));
            }
        });
        const search = bar.querySelector('.nexus-ff-search');
        search?.addEventListener('input', () => { state.searchText = search.value.trim().toLocaleLowerCase(); applyView(); updateUi(); });

        const nameInput = bar.querySelector('[data-role="batch-name"]');
        if (nameInput) {
            nameInput.value = detectGroupName();
            nameInput.addEventListener('input', () => { nameInput.dataset.manual = '1'; });
            bar.querySelector('[data-role="name-reset"]')?.addEventListener('click', () => {
                delete nameInput.dataset.manual;
                nameInput.value = detectGroupName();
            });
            setInterval(() => {
                if (!nameInput.dataset.manual && document.activeElement !== nameInput) {
                    const detected = detectGroupName();
                    if (detected && nameInput.value !== detected) nameInput.value = detected;
                }
            }, 2000);
        }

        switchTab(state.tab);
        setWorkspaceVisible(!state.minimized);
        renderLibraryState();
        updateUi();
    }

    /* ------------------------------------------------ panel hlavnej stránky (feed)
       Samostatný malý panel: načítanie N strán, filter, triedenie, hľadanie,
       skrývanie videných/odstránených. Triedenie ide cez CSS `order`, takže sa
       nemení poradie v DOM a nekazí sa stránkovanie samotného webu. */
    const FEED_PANEL_KEY = 'nexus_ff_feed_panel_v1';
    const FEED_HIDDEN_KEY = 'nexus_ff_feed_hidden_v1';
    const FEED_SEEN_KEY = 'nexus_ff_feed_seen_v1';
    const feedPanel = {
        root: null,
        loading: false,
        stop: false,
        status: '',
        lastAuto: 0,
        hidden: new Set(),
        seen: new Set(),
        fresh: new Set(),
        settings: {
            pages: 3, fetchAfter: true, autoFetch: false,
            minDur: '', maxDur: '', minQuality: '', minSize: '',
            keepUnknown: true, mode: 'hide',
            sort: 'original', search: '', hideSeen: false, collapsed: false,
        },
    };

    function feedItemNeedsMeta(item) {
        return !item.metadataAttempted && !(item.duration > 0 && item.width > 0);
    }

    function feedLoadSet(key) {
        try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); }
    }

    function feedSaveSet(key, set) {
        try { localStorage.setItem(key, JSON.stringify([...set].slice(-5000))); } catch {}
    }

    function feedSaveSettings() {
        try { localStorage.setItem(FEED_PANEL_KEY, JSON.stringify(feedPanel.settings)); } catch {}
    }

    function feedEvaluate(item) {
        const s = feedPanel.settings;
        if (feedPanel.hidden.has(item.id)) return 'removed';
        if (s.hideSeen && feedPanel.seen.has(item.id) && !feedPanel.fresh.has(item.id)) return 'seen';

        let fail = false;
        let unknown = false;
        const minDur = Number(s.minDur) || 0;
        const maxDur = Number(s.maxDur) || 0;
        if (minDur || maxDur) {
            if (!(item.duration > 0)) unknown = true;
            else if ((minDur && item.duration < minDur) || (maxDur && item.duration > maxDur)) fail = true;
        }
        const minQuality = Number(s.minQuality) || 0;
        if (minQuality) {
            const edge = Math.min(Number(item.width) || 0, Number(item.height) || 0);
            if (!edge) unknown = true;
            else if (edge < minQuality * 0.97) fail = true;
        }
        const minSize = Number(s.minSize) || 0;
        if (minSize) {
            if (!(item.sizeMb > 0)) unknown = true;
            else if (item.sizeMb < minSize) fail = true;
        }
        const query = String(s.search || '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
        if (query.length && !fail) {
            const text = (item.card?.textContent || '').toLocaleLowerCase();
            for (const token of query) {
                if (token.startsWith('-') && token.length > 1) { if (text.includes(token.slice(1))) fail = true; }
                else if (!text.includes(token)) fail = true;
            }
        }
        if (fail) return 'unmatched';
        if (unknown) return s.keepUnknown ? 'unknown' : 'unmatched';
        return 'match';
    }

    function feedSortValue(item, sort) {
        if (sort === 'dur-desc' || sort === 'dur-asc') return Number(item.duration) || 0;
        if (sort === 'size-desc' || sort === 'size-asc') return Number(item.sizeMb) || 0;
        if (sort === 'quality-desc') return Math.min(Number(item.width) || 0, Number(item.height) || 0);
        if (sort === 'newest' || sort === 'oldest') return item.addedAt ? Date.parse(String(item.addedAt).replace(' ', 'T')) || 0 : 0;
        return 0;
    }

    function feedEnsureRemoveButton(item) {
        const card = item.card;
        if (!card || card.querySelector('.nexus-ff-fp-remove')) return;
        const host = card.querySelector('.overflow-hidden.clearfix, .pg_wrapper') || card;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'nexus-ff-fp-remove';
        button.textContent = '✕';
        button.title = 'Skryť toto video natrvalo';
        button.setAttribute('aria-label', 'Skryť toto video natrvalo');
        button.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            feedPanel.hidden.add(item.id);
            feedSaveSet(FEED_HIDDEN_KEY, feedPanel.hidden);
            feedPanelApply();
        };
        host.appendChild(button);
    }

    function feedPanelApply() {
        const panel = feedPanel;
        if (!panel.root) return;
        const s = panel.settings;
        const counts = { total: 0, shown: 0, unmatched: 0, removed: 0, seen: 0, unknown: 0 };
        const rank = new Map();
        const entries = [];

        for (const item of state.items.values()) {
            if (!item.card?.isConnected || !isFeedVideoCard(item.card)) continue;
            counts.total++;
            feedEnsureRemoveButton(item);
            const verdict = feedEvaluate(item);
            const tile = item.card.closest?.('li') || item.card;
            const hide = verdict === 'removed' || verdict === 'seen' || (verdict === 'unmatched' && s.mode === 'hide');
            const dim = verdict === 'unmatched' && s.mode === 'dim';
            tile.classList.toggle('nexus-ff-fp-hidden', hide);
            tile.classList.toggle('nexus-ff-fp-dim', dim);
            tile.classList.toggle('nexus-ff-fp-seen', panel.seen.has(item.id));
            if (verdict === 'removed') counts.removed++;
            else if (verdict === 'seen') counts.seen++;
            else if (verdict === 'unmatched') counts.unmatched++;
            if (verdict === 'unknown') counts.unknown++;
            if (!hide) counts.shown++;
            entries.push({ item, tile });
        }

        if (s.sort !== 'original') {
            const asc = s.sort === 'dur-asc' || s.sort === 'size-asc' || s.sort === 'oldest';
            entries.sort((a, b) => {
                const av = feedSortValue(a.item, s.sort);
                const bv = feedSortValue(b.item, s.sort);
                if (!av || !bv) return av ? -1 : bv ? 1 : a.item.originalIndex - b.item.originalIndex;
                return (asc ? av - bv : bv - av) || a.item.originalIndex - b.item.originalIndex;
            });
            entries.forEach((entry, index) => rank.set(entry.tile, index + 1));
        }
        const list = document.querySelector('.js_posts_stream > ul');
        if (list) {
            Array.from(list.children).forEach((child, index) => {
                if (s.sort === 'original') { if (child.style.order) child.style.order = ''; return; }
                child.style.order = String(rank.get(child) || 100000 + index);
            });
        }

        const q = (name) => panel.root.querySelector(`[data-fp="${name}"]`);
        q('count').textContent = `${counts.shown}/${counts.total} zobrazených`
            + (counts.unmatched ? ` · ${counts.unmatched} nezhodných` : '')
            + (counts.unknown ? ` · ${counts.unknown} bez údajov` : '')
            + (counts.seen ? ` · ${counts.seen} videných` : '');
        q('status').textContent = state.hydrating ? state.fetchProgress : panel.status;
        const restore = q('restore');
        restore.textContent = `Obnoviť skryté (${panel.hidden.size})`;
        restore.disabled = panel.hidden.size === 0;
        q('load').disabled = panel.loading;
        q('stop').disabled = !panel.loading && !state.hydrating;

        if (s.autoFetch && !state.hydrating && !state.collecting && !state.busy && Date.now() - panel.lastAuto > 3000
            && Array.from(state.items.values()).some(item => item.card?.isConnected && isFeedVideoCard(item.card) && feedItemNeedsMeta(item))) {
            panel.lastAuto = Date.now();
            void fetchMetadata(false, true, true, true);
        }
    }

    const feedSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    async function feedLoadPages(pages) {
        const panel = feedPanel;
        if (panel.loading) return;
        panel.loading = true;
        panel.stop = false;
        const count = () => document.querySelectorAll('.js_posts_stream .post').length;
        let loaded = 0;
        for (let i = 0; i < pages && !panel.stop; i++) {
            const before = count();
            window.scrollBy(0, -400);
            await feedSleep(120);
            window.scrollTo({ top: document.documentElement.scrollHeight });
            const started = Date.now();
            while (!panel.stop && count() <= before && Date.now() - started < 12000) await feedSleep(250);
            if (count() <= before) { panel.status = `Koniec feedu alebo sa nič nenačítalo (strana ${i + 1}).`; break; }
            loaded++;
            panel.status = `Načítaná strana ${loaded}/${pages} · ${count()} príspevkov`;
            scanCards();
            await feedSleep(350);
        }
        panel.loading = false;
        if (panel.stop) panel.status = `Zastavené · načítaných strán: ${loaded}`;
        else if (loaded === pages) panel.status = `Hotovo · načítaných strán: ${loaded}`;
        scanCards();
        if (panel.settings.fetchAfter && !panel.stop) await fetchMetadata(false, true, true, true);
        feedPanelApply();
    }

    function setupFeedPanel() {
        if (feedPanel.root || location.pathname !== '/' || !document.body) return;
        feedPanel.hidden = feedLoadSet(FEED_HIDDEN_KEY);
        feedPanel.seen = feedLoadSet(FEED_SEEN_KEY);
        try { Object.assign(feedPanel.settings, JSON.parse(localStorage.getItem(FEED_PANEL_KEY) || '{}')); } catch {}
        const s = feedPanel.settings;

        const durationOptions = (empty) => `<option value="">${empty}</option>`
            + [[30, '30 s'], [60, '1 min'], [120, '2 min'], [180, '3 min'], [300, '5 min'], [600, '10 min'], [1200, '20 min']]
                .map(([value, label]) => `<option value="${value}">${label}</option>`).join('');

        const root = document.createElement('section');
        root.id = 'nexus-ff-feed-panel';
        root.className = 'nexus-ff-fp';
        root.setAttribute('aria-label', 'Nexus panel feedu');
        root.innerHTML = `
            <div class="nexus-ff-fp-head">
                <strong>Nexus feed</strong>
                <span class="nexus-ff-fp-count" data-fp="count"></span>
                <span class="nexus-ff-fp-status" data-fp="status" role="status" aria-live="polite"></span>
                <button type="button" data-fp="collapse" aria-label="Zbaliť alebo rozbaliť panel">▾</button>
            </div>
            <div class="nexus-ff-fp-body">
                <div class="nexus-ff-fp-row">
                    <span class="nexus-ff-fp-label">Načítať</span>
                    <input type="number" min="1" max="50" data-fp="pages" aria-label="Počet strán">
                    <span>strán pod seba</span>
                    <button type="button" class="primary" data-fp="load">Načítať</button>
                    <label><input type="checkbox" data-fp="fetchAfter"> potom zistiť údaje</label>
                    <label><input type="checkbox" data-fp="autoFetch"> auto-fetch nových</label>
                    <button type="button" data-fp="fetch">Zistiť údaje</button>
                    <button type="button" data-fp="stop">Stop</button>
                </div>
                <div class="nexus-ff-fp-row">
                    <span class="nexus-ff-fp-label">Filter</span>
                    <label>Dĺžka od <select data-fp="minDur">${durationOptions('—')}</select></label>
                    <label>do <select data-fp="maxDur">${durationOptions('bez limitu')}</select></label>
                    <label>Kvalita <select data-fp="minQuality">
                        <option value="">—</option><option value="480">480p+</option><option value="720">720p+</option>
                        <option value="1080">1080p+</option><option value="2160">4K</option></select></label>
                    <label>Veľkosť od <select data-fp="minSize">
                        <option value="">—</option><option value="10">10 MB</option><option value="50">50 MB</option>
                        <option value="100">100 MB</option><option value="250">250 MB</option><option value="500">500 MB</option></select></label>
                    <label><input type="checkbox" data-fp="keepUnknown"> ponechať bez údajov</label>
                    <label>Nezhodné <select data-fp="mode"><option value="hide">skryť</option><option value="dim">stlmiť</option></select></label>
                    <span class="nexus-ff-fp-chips">
                        <button type="button" data-preset="minDur:60">1 min+</button>
                        <button type="button" data-preset="minDur:300">5 min+</button>
                        <button type="button" data-preset="minQuality:720">720p+</button>
                        <button type="button" data-preset="minQuality:1080">1080p+</button>
                    </span>
                </div>
                <div class="nexus-ff-fp-row">
                    <span class="nexus-ff-fp-label">Zobraziť</span>
                    <label>Triedenie <select data-fp="sort">
                        <option value="original">Pôvodné poradie</option><option value="dur-desc">Najdlhšie</option>
                        <option value="dur-asc">Najkratšie</option><option value="size-desc">Najväčšie</option>
                        <option value="size-asc">Najmenšie</option><option value="quality-desc">Najlepšia kvalita</option>
                        <option value="newest">Najnovšie</option><option value="oldest">Najstaršie</option></select></label>
                    <input type="search" data-fp="search" placeholder="Hľadať: slovo -vylúčiť" aria-label="Hľadať v príspevkoch">
                    <label><input type="checkbox" data-fp="hideSeen"> skryť už videné</label>
                    <button type="button" data-fp="restore">Obnoviť skryté</button>
                    <button type="button" data-fp="reset">Reset filtrov</button>
                </div>
            </div>`;
        document.body.appendChild(root);
        feedPanel.root = root;

        const controls = Array.from(root.querySelectorAll('input[data-fp], select[data-fp]'));
        const syncControls = () => {
            for (const control of controls) {
                const value = s[control.dataset.fp];
                if (control.type === 'checkbox') control.checked = !!value;
                else control.value = value ?? '';
            }
            root.classList.toggle('collapsed', !!s.collapsed);
            document.documentElement.classList.toggle('nexus-ff-fp-open', !s.collapsed);
        };
        for (const control of controls) {
            control.addEventListener(control.type === 'checkbox' || control.tagName === 'SELECT' ? 'change' : 'input', () => {
                const key = control.dataset.fp;
                s[key] = control.type === 'checkbox' ? control.checked
                    : control.type === 'number' ? Math.min(50, Math.max(1, Number(control.value) || 1))
                    : control.value;
                feedSaveSettings();
                feedPanelApply();
            });
        }
        const press = (name, handler) => root.querySelector(`[data-fp="${name}"]`).addEventListener('click', handler);
        press('load', () => { void feedLoadPages(s.pages); });
        press('fetch', () => { void fetchMetadata(false, true, true, false); });
        press('stop', () => { feedPanel.stop = true; state.fetchCancelled = true; feedPanelApply(); });
        press('collapse', () => { s.collapsed = !s.collapsed; feedSaveSettings(); syncControls(); });
        press('restore', () => {
            feedPanel.hidden.clear();
            feedSaveSet(FEED_HIDDEN_KEY, feedPanel.hidden);
            feedPanelApply();
        });
        press('reset', () => {
            Object.assign(s, { minDur: '', maxDur: '', minQuality: '', minSize: '', keepUnknown: true, mode: 'hide', sort: 'original', search: '', hideSeen: false });
            feedSaveSettings();
            syncControls();
            feedPanelApply();
        });
        for (const chip of root.querySelectorAll('[data-preset]')) {
            chip.addEventListener('click', () => {
                const [key, value] = chip.dataset.preset.split(':');
                s[key] = s[key] === value ? '' : value;
                feedSaveSettings();
                syncControls();
                feedPanelApply();
            });
        }

        // Videné = používateľ klikol do médií príspevku; skrýva sa až pri ďalšom načítaní stránky.
        document.addEventListener('click', (event) => {
            const post = event.target?.closest?.('.js_posts_stream .post');
            if (!post || event.target.closest('.nexus-ff-fp-remove, .nexus-ff-check')) return;
            if (!event.target.closest('video, .video-auth-placeholder-thumb, .vid-placeholder, .overflow-hidden.clearfix, .pg_wrapper')) return;
            for (const item of state.items.values()) {
                if (item.card !== post) continue;
                feedPanel.seen.add(item.id);
                feedPanel.fresh.add(item.id);
                feedSaveSet(FEED_SEEN_KEY, feedPanel.seen);
                break;
            }
        }, true);

        syncControls();
        feedPanelApply();
    }

    function boot() {
        createWidgets();
        setupFeedPanel();
        scanCards();
        setTimeout(scanCards, 600);
        setTimeout(scanCards, 1500);
        setInterval(scanCards, 2500);
        // Krížová kontrola pri otvorení: čo už je na disku, sa hneď premietne do
        // kariet komunít, riadkov zdrojov a histórie — bez jedinej požiadavky.
        void refreshCacheIndex()
            .then(() => cache.prune())
            .then(() => refreshHistory());
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
