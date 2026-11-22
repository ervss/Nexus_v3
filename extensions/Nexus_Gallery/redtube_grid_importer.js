(function () {
    'use strict';

    if (window.top !== window) return;
    if (!/(^|\.)redtube\.com$/i.test(location.hostname)) return;

    const TOOLBAR_ID = 'nexus-rt-toolbar';
    const TOAST_ID = 'nexus-rt-toast';
    const GRID_ID = 'nexus-rt-clean-grid';
    const CHECKBOX_CLASS = 'nexus-rt-check';
    const META_CLASS = 'nexus-rt-meta';
    const CARD_SELECTED_CLASS = 'nexus-rt-selected';
    const CARD_HIDDEN_CLASS = 'nexus-rt-filter-hidden';
    const META_CACHE_PREFIX = 'nexus_redtube_card_meta_v3:';
    const META_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 45;
    const DETAIL_CONCURRENCY = 4;
    const QUALITY_LEVELS = [2160, 1440, 1080, 720, 480, 360];

    const state = {
        items: new Map(),
        selectedIds: new Set(),
        busy: false,
        metaBusy: false,
        pageBusy: false,
        loadedPageUrls: new Set(),
        lastSignature: '',
        nextOrder: 1,
        filters: {
            qualities: [],
            minDuration: 0,
            maxDuration: 0,
            minSize: 0,
            maxSize: 0,
            onlySelected: false,
        },
        sortField: 'page',
        sortDir: 'desc',
        scanTimer: 0,
    };

    // ---------------------------------------------------------- URL helpers
    // RedTube watch pages look like https://www.redtube.com/12345678 (numeric id).
    function isVideoHref(href) {
        try {
            const url = new URL(href || '', location.href);
            if (!/(^|\.)redtube\.com$/i.test(url.hostname)) return false;
            return /^\/(?:[a-z]{2}\/)?\d{4,}(?:\/[^/?#]*)?\/?$/i.test(url.pathname);
        } catch {
            return false;
        }
    }

    function normalizeVideoKey(rawUrl) {
        const raw = String(rawUrl || '').trim();
        if (!raw) return '';
        try {
            const url = new URL(raw, location.href);
            const match = url.pathname.match(/\/(?:[a-z]{2}\/)?(\d{4,})/i);
            if (match?.[1]) return `redtube:${match[1]}`;
            return `${url.hostname.replace(/^www\./i, '').toLowerCase()}${url.pathname}`.toLowerCase();
        } catch {
            return raw.toLowerCase();
        }
    }

    function canonicalVideoUrl(rawUrl) {
        try {
            const url = new URL(rawUrl, location.href);
            const match = url.pathname.match(/\/(?:[a-z]{2}\/)?(\d{4,})/i);
            if (match?.[1]) return `https://www.redtube.com/${match[1]}`;
            return url.href;
        } catch {
            return String(rawUrl || '');
        }
    }

    // --------------------------------------------------------------- toasts
    function toast(message, isError) {
        let el = document.getElementById(TOAST_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = TOAST_ID;
            el.className = 'nexus-rt-toast';
            document.body.appendChild(el);
        }
        el.textContent = String(message || '').trim() || (isError ? 'Import failed' : 'Done');
        el.dataset.error = isError ? '1' : '0';
        el.classList.add('visible');
        clearTimeout(el._timer);
        el._timer = setTimeout(() => el.classList.remove('visible'), 3200);
    }

    // ------------------------------------------------------------- parsers
    function parseDurationText(raw) {
        const text = String(raw || '').trim();
        if (!text) return 0;
        const parts = text.split(':').map(Number);
        if (parts.some((n) => !Number.isFinite(n))) return 0;
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        return 0;
    }

    function parseDurationFromText(raw) {
        const match = String(raw || '').match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
        return match?.[1] ? parseDurationText(match[1]) : 0;
    }

    function parseIsoDuration(raw) {
        const match = String(raw || '').match(/P(?:T)?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
        if (!match) return 0;
        return (Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0);
    }

    function parseSizeBytes(raw) {
        const match = String(raw || '').match(/([\d.,]+)\s*(TB|GB|MB|KB|B)\b/i);
        if (!match) return 0;
        const value = parseFloat(String(match[1]).replace(',', '.')) || 0;
        const unit = String(match[2] || '').toUpperCase();
        if (unit === 'TB') return Math.round(value * 1099511627776);
        if (unit === 'GB') return Math.round(value * 1073741824);
        if (unit === 'MB') return Math.round(value * 1048576);
        if (unit === 'KB') return Math.round(value * 1024);
        return Math.round(value);
    }

    function formatSize(bytes) {
        const value = Number(bytes || 0);
        if (!value) return '';
        if (value >= 1073741824) return `${(value / 1073741824).toFixed(value >= 10 * 1073741824 ? 0 : 1)} GB`;
        if (value >= 1048576) return `${Math.round(value / 1048576)} MB`;
        if (value >= 1024) return `${Math.round(value / 1024)} KB`;
        return `${Math.round(value)} B`;
    }

    async function headSize(url) {
        const target = String(url || '').trim();
        if (!/^https?:\/\//i.test(target)) return 0;
        try {
            const resp = await fetch(target, { method: 'HEAD', redirect: 'follow' });
            const len = resp.headers.get('content-length') || resp.headers.get('Content-Length');
            const bytes = Number(len || 0);
            if (!(Number.isFinite(bytes) && bytes > 0)) {
                console.warn('[NexusRT] HEAD no content-length (status', resp.status + ', type', resp.type + ')', target.slice(0, 80));
            }
            return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
        } catch (e) {
            console.warn('[NexusRT] HEAD failed:', e?.message || e, target.slice(0, 80));
            return 0;
        }
    }

    function qualityHeight(raw) {
        const text = String(raw || '');
        if (/\b4K\b/i.test(text)) return 2160;
        return parseInt(text.match(/(2160|1440|1080|720|480|360|240)p?/i)?.[1] || '0', 10) || 0;
    }

    function qualityLabel(raw) {
        const h = qualityHeight(raw);
        if (h >= 2160) return '4K (2160p)';
        return h ? `${h}p` : '';
    }

    function qualityWidth(height) {
        return {
            2160: 3840, 1440: 2560, 1080: 1920,
            720: 1280, 480: 854, 360: 640, 240: 426,
        }[Number(height || 0)] || 0;
    }

    function formatDuration(seconds) {
        const total = Math.max(0, Number(seconds || 0));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = Math.floor(total % 60);
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function parseUploadDateValue(raw) {
        const text = String(raw || '').trim();
        if (!text) return 0;
        const date = new Date(text);
        if (Number.isNaN(date.getTime())) return 0;
        date.setHours(12, 0, 0, 0);
        return date.getTime();
    }

    function parseDateInputValue(raw, endOfDay = false) {
        const text = String(raw || '').trim();
        const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) return parseUploadDateValue(text);
        const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        date.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
        return date.getTime();
    }

    function formatUploadDate(value) {
        const ts = Number(value || 0) || parseUploadDateValue(value);
        if (!ts) return '';
        return new Date(ts).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    }

    function dateInputValue(ts) {
        const value = Number(ts || 0);
        if (!value) return '';
        const date = new Date(value);
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    // ----------------------------------------------------------- meta cache
    function readMetaCache(key) {
        if (!key) return null;
        try {
            const raw = localStorage.getItem(META_CACHE_PREFIX + key);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed?.ts || Date.now() - parsed.ts > META_CACHE_TTL_MS) {
                localStorage.removeItem(META_CACHE_PREFIX + key);
                return null;
            }
            return parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : null;
        } catch {
            return null;
        }
    }

    function writeMetaCache(key, meta) {
        if (!key || !meta) return;
        try {
            localStorage.setItem(META_CACHE_PREFIX + key, JSON.stringify({ ts: Date.now(), meta }));
        } catch { }
    }

    // --------------------------------------------------------- card finding
    function findVideoLink(node) {
        if (!node?.querySelector) return null;
        if (node.matches?.('a[href]') && isVideoHref(node.getAttribute('href') || node.href)) return node;
        return Array.from(node.querySelectorAll('a[href]')).find((link) => {
            return isVideoHref(link.getAttribute('href') || link.href);
        }) || null;
    }

    function cardScore(node) {
        if (!node?.querySelector) return 0;
        let score = 0;
        if (node.querySelector('img, picture')) score += 4;
        if (findVideoLink(node)) score += 4;
        if (node.querySelector('.duration, .video_duration, [class*="dur"], [class*="time"]')) score += 2;
        if (node.querySelector('.hd_mark, .quality, [class*="qual"], [class*="hd"]')) score += 2;
        if (node.querySelector('.video_title, .title, h2, h3, [class*="title"]')) score += 1;
        return score;
    }

    function findCardFromVideoLink(link) {
        let preferred = link.closest('.nexus-rt-grid-card, li.video_block, .video_block, .videoblock, .tm_video_block, .js_mvideo-preview, .thumb, .video-item, .videoBox');
        if (!preferred) preferred = link.closest('.item, article, li');
        if (preferred?.tagName === 'A') preferred = preferred.parentElement;
        if (preferred && preferred !== document.body && preferred !== document.documentElement && cardScore(preferred) >= 6) {
            return preferred;
        }

        let best = null;
        let node = link.parentElement;
        for (let depth = 0; node && node !== document.body && depth < 8; depth += 1, node = node.parentElement) {
            if (node.closest(`#${TOOLBAR_ID}, #${TOAST_ID}`)) continue;
            const rect = node.getBoundingClientRect?.();
            const score = cardScore(node);
            const linkCount = node.querySelectorAll?.('a[href]').length || 0;
            const isHuge = rect && (rect.width > Math.max(760, window.innerWidth * 0.7) || rect.height > 560);
            if (score >= 6 && linkCount <= 6 && !isHuge) {
                best = node;
                break;
            }
        }
        return best || link.closest('a[href]') || null;
    }

    function cardPriority(card) {
        if (!card) return 0;
        let score = 0;
        if (card.closest('#video_listing, .video_listing_container, .search_results, [class*="listing"]')) score += 12;
        if (card.closest('main, #content')) score += 4;
        if (card.closest('aside, #sidebar, [class*="sidebar"], [class*="related_sidebar"]')) score -= 6;
        if (card.classList?.contains('nexus-rt-grid-card')) score += 2;
        return score;
    }

    function getCardCandidates() {
        const candidates = [];
        Array.from(document.querySelectorAll('a[href]')).forEach((link, index) => {
            if (!isVideoHref(link.getAttribute('href') || link.href)) return;
            const card = findCardFromVideoLink(link);
            if (!card || card.closest(`#${TOOLBAR_ID}, #${TOAST_ID}`)) return;
            const id = getNodeVideoId(card) || normalizeVideoKey(link.getAttribute('href') || link.href);
            candidates.push({ card, id, index, priority: cardPriority(card) });
        });
        return candidates.sort((a, b) => {
            if (b.priority !== a.priority) return b.priority - a.priority;
            return a.index - b.index;
        });
    }

    function getAllCardNodes() {
        const seen = new Set();
        const cards = [];
        getCardCandidates().forEach(({ card }) => {
            if (seen.has(card)) return;
            seen.add(card);
            cards.push(card);
        });
        return cards;
    }

    function getCardNodes() {
        const seen = new Set();
        const cards = [];
        getCardCandidates().forEach(({ card, id }) => {
            const dedupeKey = id || card;
            if (seen.has(dedupeKey)) return;
            seen.add(dedupeKey);
            cards.push(card);
        });
        return cards;
    }

    function getNodeVideoId(node) {
        const link = findVideoLink(node);
        const url = link?.href || link?.getAttribute?.('href') || '';
        return normalizeVideoKey(url) || url;
    }

    // --------------------------------------------------------- layout / grid
    // RedTube already renders a clean responsive grid, so we must NOT re-parent
    // cards into a custom container (that fought its layout and mangled the page).
    // Just tag the cards in place; checkboxes/badges are overlaid via position.
    function normalizeCardLayout() {
        const cards = getCardNodes();
        if (!cards.length) return;
        cards.forEach((card) => card.classList.add('nexus-rt-grid-card'));
    }

    // -------------------------------------------------------------- paging
    function pageNumberFromUrl(rawUrl) {
        try {
            const url = new URL(rawUrl || location.href, location.href);
            return Math.max(1, Number(url.searchParams.get('page') || 1) || 1);
        } catch {
            return 1;
        }
    }

    function listingUrlKey(rawUrl) {
        try {
            const url = new URL(rawUrl, location.href);
            url.hash = '';
            return url.href;
        } catch {
            return String(rawUrl || '');
        }
    }

    function nextListingUrl(doc = document, baseUrl = location.href) {
        const currentPage = pageNumberFromUrl(baseUrl);
        const next = Array.from(doc.querySelectorAll('a[href]')).find((link) => {
            const label = `${link.getAttribute('rel') || ''} ${link.getAttribute('aria-label') || ''} ${link.textContent || ''}`.replace(/\s+/g, ' ').trim();
            if (!/(?:\bnext\b|next page|›|»|→)/i.test(label)) return false;
            try { return pageNumberFromUrl(new URL(link.href, baseUrl).href) > currentPage; } catch { return false; }
        });
        if (next) return new URL(next.href, baseUrl).href;
        const fallback = new URL(baseUrl, location.href);
        fallback.searchParams.set('page', String(currentPage + 1));
        return fallback.href;
    }

    function listingTarget() {
        const firstCard = getCardNodes()[0];
        return firstCard?.parentElement || document.querySelector('#video_listing, .video_listing_container, .search_results, [class*="listing"]');
    }

    function pageCardsFromDocument(doc) {
        const seen = new Set();
        const cards = [];
        Array.from(doc.querySelectorAll('a[href]')).forEach((link) => {
            if (!isVideoHref(link.getAttribute('href') || link.href)) return;
            const card = findCardFromVideoLink(link);
            const id = getNodeVideoId(card) || normalizeVideoKey(link.href);
            if (!card || !id || seen.has(id)) return;
            seen.add(id);
            cards.push({ id, card });
        });
        return cards;
    }

    async function loadMorePages() {
        const toolbar = document.getElementById(TOOLBAR_ID);
        const count = Math.min(20, Math.max(1, Number(toolbar?.querySelector('[data-role="load-count"]')?.value || 1) || 1));
        const target = listingTarget();
        if (!target) throw new Error('Could not find the RedTube results grid');
        state.pageBusy = true;
        updateToolbar();
        try {
            let loaded = 0;
            let currentUrl = location.href;
            state.loadedPageUrls.add(listingUrlKey(currentUrl));
            for (let i = 0; i < count; i += 1) {
                const pageUrl = nextListingUrl(document, currentUrl);
                const key = listingUrlKey(pageUrl);
                if (state.loadedPageUrls.has(key)) break;
                toast(`Loading page ${pageNumberFromUrl(pageUrl)}…`);
                const resp = await fetch(pageUrl, { credentials: 'include' });
                if (!resp.ok) throw new Error(`Could not load page ${pageNumberFromUrl(pageUrl)} (HTTP ${resp.status})`);
                const doc = new DOMParser().parseFromString(await resp.text(), 'text/html');
                const known = new Set(Array.from(state.items.keys()));
                const fresh = pageCardsFromDocument(doc).filter(({ id }) => !known.has(id));
                state.loadedPageUrls.add(key);
                if (!fresh.length) {
                    if (!loaded) throw new Error('The next page has no new video cards');
                    break;
                }
                const fragment = document.createDocumentFragment();
                fresh.forEach(({ card }) => fragment.appendChild(document.importNode(card, true)));
                target.appendChild(fragment);
                currentUrl = pageUrl;
                loaded += 1;
                scanCards();
            }
            toast(loaded ? `Loaded ${loaded} more page${loaded === 1 ? '' : 's'} · ${pageItems().length} cards` : 'No more pages to load');
        } finally {
            state.pageBusy = false;
            updateToolbar();
        }
    }

    function parseVisibleUploadDate(text, node) {
        const timeValue = node?.querySelector?.('time[datetime]')?.getAttribute('datetime');
        const fromTime = parseUploadDateValue(timeValue);
        if (fromTime) return fromTime;
        const patterns = [
            /\b(\d{4}-\d{1,2}-\d{1,2})\b/,
            /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/i,
        ];
        for (const pattern of patterns) {
            const parsed = parseUploadDateValue(String(text || '').match(pattern)?.[1]);
            if (parsed) return parsed;
        }
        return 0;
    }

    function collectCard(node) {
        const link = findVideoLink(node);
        if (!link) return null;
        const rawUrl = link.href || link.getAttribute('href') || '';
        if (!rawUrl) return null;
        const url = canonicalVideoUrl(rawUrl);

        const cardText = String(node.innerText || '').replace(/\s+/g, ' ').trim();
        const img = node.querySelector('img');
        let thumbnail = img?.getAttribute('data-original') || img?.getAttribute('data-src') || img?.getAttribute('data-thumb_url') || img?.getAttribute('src') || img?.src || '';
        if (thumbnail.startsWith('//')) thumbnail = `https:${thumbnail}`;
        const durationLabel = node.querySelector('.duration, .video_duration, [class*="duration"]')?.textContent?.trim() || '';
        const rawQuality =
            node.querySelector('.hd_mark, .quality, [class*="hd"]')?.textContent?.trim() ||
            (cardText.match(/(4K|2160p|1440p|1080p|720p|480p|360p|240p)/i) || [''])[0];
        const title =
            link.getAttribute('title') ||
            node.querySelector('.video_title, .title, .thumb-title, h2, h3, [class*="title"]')?.textContent?.trim() ||
            img?.getAttribute('alt') ||
            link.textContent?.trim() ||
            'RedTube Video';
        const key = normalizeVideoKey(url) || url;
        const cached = readMetaCache(key) || readMetaCache(url) || {};
        const cardDuration = parseDurationText(durationLabel) || parseDurationFromText(cardText);
        const cardHeight = qualityHeight(rawQuality);
        const cardSize = parseSizeBytes(cardText);
        const cardUploadTs = parseVisibleUploadDate(cardText, node);

        const base = {
            id: key,
            url,
            source_url: url,
            title: String(title || '').trim() || 'RedTube Video',
            thumbnail,
            duration: cardDuration,
            quality: qualityLabel(rawQuality) || 'HD',
            height: cardHeight,
            size: cardSize,
            uploadTs: cardUploadTs,
            uploadDate: cardUploadTs ? formatUploadDate(cardUploadTs) : '',
            card: node,
            selected: state.selectedIds.has(key) || !!state.items.get(key)?.selected,
            order: state.items.get(key)?.order || state.nextOrder++,
        };
        return {
            ...base,
            ...cached,
            id: base.id,
            url: base.url,
            source_url: base.source_url,
            title: base.title,
            thumbnail: cached.thumbnail || base.thumbnail,
            duration: Number(cached.duration || base.duration || 0) || 0,
            height: Number(cached.height || base.height || 0) || 0,
            width: Number(cached.width || base.width || 0) || 0,
            size: Number(cached.size || base.size || 0) || 0,
            uploadTs: Number(cached.uploadTs || base.uploadTs || 0) || 0,
            uploadDate: cached.uploadDate || base.uploadDate || '',
            quality: cached.quality || base.quality,
            card: node,
            selected: base.selected,
            order: base.order,
        };
    }

    // ------------------------------------------------------------ item views
    function pageItems() {
        return Array.from(state.items.values()).filter((item) => {
            if (!item.card || !item.card.isConnected) return false;
            const style = window.getComputedStyle(item.card);
            const hiddenByNexus = item.card.classList.contains(CARD_HIDDEN_CLASS);
            if (!hiddenByNexus && (style.display === 'none' || style.visibility === 'hidden')) return false;
            return true;
        });
    }

    function visibleItems() {
        return pageItems().filter((item) => !item.card.classList.contains(CARD_HIDDEN_CLASS));
    }

    function isNodeShown(node) {
        if (!node || node.classList.contains(CARD_HIDDEN_CLASS)) return false;
        const style = window.getComputedStyle(node);
        return !(style.display === 'none' || style.visibility === 'hidden');
    }

    function visibleNodeIds() {
        const ids = new Set();
        getCardNodes().forEach((node) => {
            if (!isNodeShown(node)) return;
            const id = getNodeVideoId(node);
            if (id) ids.add(id);
        });
        return ids;
    }

    function selectedItems() {
        const visibleIds = visibleNodeIds();
        const picked = new Map();
        state.items.forEach((item) => {
            if (!visibleIds.has(item.id) || !isItemSelected(item) || picked.has(item.id)) return;
            picked.set(item.id, { ...item, selected: true });
        });
        return Array.from(picked.values());
    }

    function qualityBucket(height) {
        const value = Number(height || 0);
        return QUALITY_LEVELS.find((q) => value >= q) || 0;
    }

    function matchesCurrentFilters(item) {
        if (state.filters.onlySelected && !isItemSelected(item)) return false;
        if (state.filters.qualities.length && !state.filters.qualities.includes(qualityBucket(item.height))) return false;
        if (state.filters.minDuration && Number(item.duration || 0) < state.filters.minDuration) return false;
        if (state.filters.maxDuration && Number(item.duration || 0) > state.filters.maxDuration) return false;
        if (state.filters.minSize && Number(item.size || 0) < state.filters.minSize) return false;
        if (state.filters.maxSize && Number(item.size || 0) > state.filters.maxSize) return false;
        return true;
    }

    function isItemSelected(item) {
        return !!item?.selected || state.selectedIds.has(item?.id);
    }

    function setItemSelected(id, selected) {
        if (!id) return;
        if (selected) state.selectedIds.add(id);
        else state.selectedIds.delete(id);
        state.items.forEach((item) => {
            if (item.id === id) item.selected = !!selected;
        });
        getCardNodes().forEach((node) => {
            if (getNodeVideoId(node) !== id) return;
            node.classList.toggle(CARD_SELECTED_CLASS, !!selected);
            const input = node.querySelector(`.${CHECKBOX_CLASS} input`);
            if (input) input.checked = !!selected;
        });
    }

    // ------------------------------------------------------------- filtering
    function readNumber(toolbar, role) {
        const value = Number(toolbar.querySelector(`[data-role="${role}"]`)?.value || 0);
        return Number.isFinite(value) && value > 0 ? value : 0;
    }

    function readFiltersFromToolbar() {
        const toolbar = document.getElementById(TOOLBAR_ID);
        if (!toolbar) return;
        state.filters.qualities = Array.from(toolbar.querySelectorAll('[data-role="quality-option"][data-active="1"]'))
            .map((button) => Number(button.dataset.quality || 0))
            .filter(Boolean);
        state.filters.minDuration = Math.round(readNumber(toolbar, 'duration-min') * 60);
        state.filters.maxDuration = Math.round(readNumber(toolbar, 'duration-max') * 60);
        state.filters.minSize = Math.round(readNumber(toolbar, 'size-min') * 1048576);
        state.filters.maxSize = Math.round(readNumber(toolbar, 'size-max') * 1048576);
        state.sortField = toolbar.querySelector('[data-role="sort-field"]')?.value || 'page';
    }

    function writeFiltersToToolbar() {
        const toolbar = document.getElementById(TOOLBAR_ID);
        if (!toolbar) return;
        toolbar.querySelectorAll('[data-role="quality-option"]').forEach((button) => {
            const quality = Number(button.dataset.quality || 0);
            button.dataset.active = state.filters.qualities.includes(quality) ? '1' : '0';
        });
        toolbar.querySelector('[data-role="duration-min"]').value = state.filters.minDuration ? String(Math.round(state.filters.minDuration / 60)) : '';
        toolbar.querySelector('[data-role="duration-max"]').value = state.filters.maxDuration ? String(Math.round(state.filters.maxDuration / 60)) : '';
        toolbar.querySelector('[data-role="size-min"]').value = state.filters.minSize ? String(Math.round(state.filters.minSize / 1048576)) : '';
        toolbar.querySelector('[data-role="size-max"]').value = state.filters.maxSize ? String(Math.round(state.filters.maxSize / 1048576)) : '';
        toolbar.querySelector('[data-role="sort-field"]').value = state.sortField;
    }

    function sortValue(item) {
        if (state.sortField === 'quality') return Number(item.height || 0);
        if (state.sortField === 'duration') return Number(item.duration || 0);
        if (state.sortField === 'size') return Number(item.size || 0);
        if (state.sortField === 'date') return Number(item.uploadTs || 0);
        if (state.sortField === 'title') return String(item.title || '').toLowerCase();
        return Number(item.order || 0);
    }

    function compareItems(a, b) {
        const av = sortValue(a);
        const bv = sortValue(b);
        const dir = state.sortDir === 'asc' ? 1 : -1;
        let result = 0;
        if (typeof av === 'string' || typeof bv === 'string') {
            result = String(av).localeCompare(String(bv));
        } else {
            result = Number(av || 0) - Number(bv || 0);
        }
        if (result === 0) result = Number(a.order || 0) - Number(b.order || 0);
        if (state.sortField === 'page') return result;
        return result * dir;
    }

    function sortCards() {
        const grid = document.getElementById(GRID_ID);
        if (grid) {
            pageItems().sort(compareItems).forEach((item) => {
                if (item.card?.parentElement === grid) grid.appendChild(item.card);
            });
            return;
        }
        const byParent = new Map();
        pageItems().forEach((item) => {
            const parent = item.card?.parentElement;
            if (!parent) return;
            if (!byParent.has(parent)) byParent.set(parent, []);
            byParent.get(parent).push(item);
        });
        byParent.forEach((group, parent) => {
            group.sort(compareItems).forEach((item) => {
                if (item.card?.parentElement === parent) parent.appendChild(item.card);
            });
        });
    }

    function hasActiveViewFilter() {
        return !!(
            state.filters.onlySelected ||
            state.filters.qualities.length ||
            state.filters.minDuration ||
            state.filters.maxDuration ||
            state.filters.minSize ||
            state.filters.maxSize
        );
    }

    function setCardHidden(node, hidden) {
        if (!node) return;
        node.classList.toggle(CARD_HIDDEN_CLASS, !!hidden);
        if (hidden) {
            node.style.setProperty('display', 'none', 'important');
        } else {
            node.style.removeProperty('display');
        }
    }

    function applyView(showToast) {
        readFiltersFromToolbar();
        const visibleIds = new Set();
        pageItems().forEach((item) => {
            if (matchesCurrentFilters(item)) visibleIds.add(item.id);
        });

        const shownNodes = new Set();
        const preferredVisibleNodes = new Set();
        getCardNodes().forEach((node) => {
            const id = getNodeVideoId(node);
            if (id && visibleIds.has(id) && !shownNodes.has(id)) {
                shownNodes.add(id);
                preferredVisibleNodes.add(node);
            }
        });

        const activeFilter = hasActiveViewFilter();
        getAllCardNodes().forEach((node) => {
            setCardHidden(node, activeFilter && !preferredVisibleNodes.has(node));
        });
        state.items.forEach((item) => {
            setCardHidden(item.card, activeFilter && !visibleIds.has(item.id));
        });

        const shown = shownNodes.size;
        const hidden = Math.max(0, state.items.size - shown);
        sortCards();
        updateToolbar();
        if (showToast) toast(`Showing ${shown} card${shown !== 1 ? 's' : ''}${hidden ? `, hidden ${hidden}` : ''}`);
    }

    function updateToolbar() {
        const toolbar = document.getElementById(TOOLBAR_ID);
        if (!toolbar) return;
        const selected = selectedItems().length;
        const visible = visibleItems().length;
        const total = pageItems().length;
        const hidden = Math.max(0, total - visible);
        toolbar.querySelector('.nexus-rt-stats').textContent = `${selected} selected / ${visible} shown / ${total} cards${hidden ? ` (${hidden} hidden)` : ''}`;
        toolbar.querySelector('[data-role="collapse"]').textContent = toolbar.dataset.collapsed === '1' ? '+' : '-';
        toolbar.querySelector('[data-role="import"]').disabled = selected === 0 || state.busy;
        toolbar.querySelector('[data-role="copy-urls"]').disabled = selected === 0;
        toolbar.querySelector('[data-role="clear"]').disabled = selected === 0 || state.busy;
        toolbar.querySelector('[data-role="select"]').disabled = visible === 0 || state.busy;
        toolbar.querySelector('[data-role="fetch-meta"]').disabled = total === 0 || state.busy || state.metaBusy;
        toolbar.querySelector('[data-role="load-pages"]').disabled = state.busy || state.pageBusy;
        toolbar.querySelector('[data-role="load-count"]').disabled = state.busy || state.pageBusy;
        toolbar.querySelector('[data-role="only-selected"]').dataset.active = state.filters.onlySelected ? '1' : '0';
        toolbar.querySelector('[data-role="sort-dir"]').textContent = state.sortDir === 'asc' ? 'Asc' : 'Desc';
        toolbar.dataset.busy = (state.busy || state.metaBusy || state.pageBusy) ? '1' : '0';
    }

    function upsertCardUI(item) {
        const card = item.card;
        if (!card) return;
        if (getComputedStyle(card).position === 'static') card.style.position = 'relative';

        let box = card.querySelector(`.${CHECKBOX_CLASS}`);
        if (!box) {
            box = document.createElement('label');
            box.className = CHECKBOX_CLASS;
            box.innerHTML = '<input type="checkbox"><span></span>';
            box.addEventListener('mousedown', (event) => event.stopPropagation());
            box.addEventListener('click', (event) => event.stopPropagation());
            const input = box.querySelector('input');
            input.addEventListener('change', (event) => {
                setItemSelected(item.id, !!event.target.checked);
                applyView(false);
            });
            card.appendChild(box);
        }
        const input = box.querySelector('input');
        const selected = isItemSelected(item);
        input.checked = selected;
        card.classList.toggle(CARD_SELECTED_CLASS, selected);

        // Attach the badge directly to the card (already position:relative). The
        // card wraps the thumbnail, so absolutely-positioned chips overlay it.
        // Anchoring to an inner wrapper was unreliable — RedTube's own CSS often
        // clips it (overflow:hidden) and hides the chips.
        let badge = card.querySelector(`.${META_CLASS}`);
        if (!badge) {
            badge = document.createElement('div');
            badge.className = META_CLASS;
            card.appendChild(badge);
        } else if (badge.parentElement !== card) {
            card.appendChild(badge);
        }
        const dateText = item.uploadTs > 0 ? formatUploadDate(item.uploadTs) : '';
        const sizeText = item.size > 0 ? formatSize(item.size) : '';
        const durationText = item.duration > 0 ? formatDuration(item.duration) : '';
        const qualityText = item.height > 0 ? (item.height >= 2160 ? '4K' : `${item.height}p`) : '';
        badge.innerHTML = `
            ${dateText ? `<span class="nexus-rt-chip nexus-rt-date">${dateText}</span>` : ''}
            ${sizeText ? `<span class="nexus-rt-chip nexus-rt-size">${sizeText}</span>` : ''}
            ${durationText ? `<span class="nexus-rt-chip nexus-rt-duration">${durationText}</span>` : ''}
            ${qualityText ? `<span class="nexus-rt-chip nexus-rt-quality">${qualityText}</span>` : ''}
        `;
    }

    function scanCards() {
        normalizeCardLayout();
        const seen = new Set();
        const nodes = getCardNodes();
        state.lastSignature = nodes.map((node) => getNodeVideoId(node)).filter(Boolean).join('|');
        nodes.forEach((node) => {
            const card = collectCard(node);
            if (!card) return;
            seen.add(card.id);
            const existing = state.items.get(card.id) || {};
            const merged = { ...existing, ...card, selected: state.selectedIds.has(card.id) || !!existing.selected };
            state.items.set(card.id, merged);
            upsertCardUI(merged);
        });
        Array.from(state.items.keys()).forEach((id) => {
            const item = state.items.get(id);
            if (!seen.has(id) || !item?.card?.isConnected) state.items.delete(id);
        });
        refreshQualityFilter();
        applyView(false);
        return nodes.length;
    }

    function nodeMayContainVideoCard(node) {
        if (!node || node.nodeType !== 1) return false;
        if (node.closest?.(`#${TOOLBAR_ID}, #${TOAST_ID}`)) return false;
        if (node.matches?.('a[href], .video_block, .videoblock, li')) return true;
        return !!node.querySelector?.('a[href]');
    }

    function scheduleScan() {
        clearTimeout(state.scanTimer);
        state.scanTimer = setTimeout(() => {
            const before = state.lastSignature || '';
            const current = getCardNodes().map((node) => getNodeVideoId(node)).filter(Boolean).join('|');
            if (current && current !== before) scanCards();
            else updateToolbar();
        }, 350);
    }

    function watchForNewCards() {
        const observer = new MutationObserver((mutations) => {
            const hasCards = mutations.some((mutation) => {
                return Array.from(mutation.addedNodes || []).some(nodeMayContainVideoCard);
            });
            if (hasCards) scheduleScan();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function getAvailableQualities() {
        const found = new Set();
        pageItems().forEach((item) => {
            if (item.height > 0) {
                const match = qualityBucket(item.height);
                if (match) found.add(match);
            }
        });
        return QUALITY_LEVELS.filter((q) => found.has(q));
    }

    function refreshQualityFilter() {
        const toolbar = document.getElementById(TOOLBAR_ID);
        if (!toolbar) return;
        const root = toolbar.querySelector('[data-role="quality-filter"]');
        if (!root) return;
        const avail = getAvailableQualities();
        state.filters.qualities = state.filters.qualities.filter((q) => avail.includes(q));
        root.innerHTML = avail.length
            ? avail.map((q) => `<button type="button" data-role="quality-option" data-quality="${q}" data-active="${state.filters.qualities.includes(q) ? '1' : '0'}">${q >= 2160 ? '4K' : q + 'p'}</button>`).join('')
            : '<span class="nexus-rt-quality-empty">Fetch metadata for qualities</span>';
    }

    // -------------------------------------------------------------- toolbar
    function createToolbar() {
        if (document.getElementById(TOOLBAR_ID)) return;
        const toolbar = document.createElement('div');
        toolbar.id = TOOLBAR_ID;
        toolbar.className = 'nexus-rt-toolbar';
        toolbar.innerHTML = `
            <div class="nexus-rt-head">
                <div class="nexus-rt-title">RedTube Quick Import</div>
                <button data-role="collapse" class="nexus-rt-collapse" title="Minimize panel">-</button>
            </div>
            <div class="nexus-rt-stats">0 selected / 0 cards</div>
            <div class="nexus-rt-filter-grid">
                <label class="nexus-rt-quality-field">
                    <span>Quality</span>
                    <div data-role="quality-filter" class="nexus-rt-quality-picks" title="Pick exact qualities"></div>
                </label>
                <label>
                    <span>Min min</span>
                    <input data-role="duration-min" type="number" min="0" step="1" placeholder="0">
                </label>
                <label>
                    <span>Max min</span>
                    <input data-role="duration-max" type="number" min="0" step="1" placeholder="0">
                </label>
                <label>
                    <span>Min MB</span>
                    <input data-role="size-min" type="number" min="0" step="1" placeholder="0">
                </label>
                <label>
                    <span>Max MB</span>
                    <input data-role="size-max" type="number" min="0" step="1" placeholder="0">
                </label>
                <label>
                    <span>Sort</span>
                    <select data-role="sort-field" title="Sort visible cards">
                        <option value="page">Page</option>
                        <option value="date">Date</option>
                        <option value="quality">Quality</option>
                        <option value="duration">Duration</option>
                        <option value="size">Size</option>
                        <option value="title">Title</option>
                    </select>
                </label>
            </div>
            <div class="nexus-rt-actions">
                <button data-role="refresh">Refresh</button>
                <button data-role="apply-view">Apply view</button>
                <button data-role="show-all">Show all</button>
                <button data-role="only-selected">Only selected</button>
                <button data-role="sort-dir">Desc</button>
                <button data-role="fetch-meta">Fetch metadata</button>
                <label class="nexus-rt-load-pages"><span>Pages</span><input data-role="load-count" type="number" min="1" max="20" value="1"></label>
                <button data-role="load-pages">Load next</button>
                <button data-role="select-quality">Select quality</button>
                <button data-role="select">Select all</button>
                <button data-role="clear">Clear</button>
                <button data-role="copy-urls" title="Copy selected URLs to clipboard">Copy URLs</button>
                <button data-role="import" class="primary">Import selected</button>
            </div>
        `;
        document.body.appendChild(toolbar);

        toolbar.querySelector('[data-role="collapse"]').addEventListener('click', () => {
            toolbar.dataset.collapsed = toolbar.dataset.collapsed === '1' ? '0' : '1';
            updateToolbar();
        });
        toolbar.querySelector('[data-role="refresh"]').addEventListener('click', () => {
            scanCards();
            refreshQualityFilter();
            toast(`Refreshed ${visibleItems().length} cards`);
        });
        toolbar.querySelectorAll('input[data-role], select[data-role]').forEach((control) => {
            control.addEventListener('change', () => applyView(false));
        });
        toolbar.querySelector('[data-role="quality-filter"]').addEventListener('click', (event) => {
            const button = event.target.closest('[data-role="quality-option"]');
            if (!button) return;
            button.dataset.active = button.dataset.active === '1' ? '0' : '1';
            applyView(false);
        });
        toolbar.querySelector('[data-role="apply-view"]').addEventListener('click', () => applyView(true));
        toolbar.querySelector('[data-role="show-all"]').addEventListener('click', () => {
            state.filters = { qualities: [], minDuration: 0, maxDuration: 0, minSize: 0, maxSize: 0, onlySelected: false };
            state.sortField = 'page';
            state.sortDir = 'desc';
            writeFiltersToToolbar();
            applyView(true);
        });
        toolbar.querySelector('[data-role="only-selected"]').addEventListener('click', () => {
            state.filters.onlySelected = !state.filters.onlySelected;
            applyView(true);
        });
        toolbar.querySelector('[data-role="sort-dir"]').addEventListener('click', () => {
            state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
            applyView(true);
        });
        toolbar.querySelector('[data-role="fetch-meta"]').addEventListener('click', () => {
            fetchVisibleMetadata().catch((error) => toast(error?.message || 'Could not fetch metadata', true));
        });
        toolbar.querySelector('[data-role="load-pages"]').addEventListener('click', () => {
            loadMorePages().catch((error) => toast(error?.message || 'Could not load more pages', true));
        });
        toolbar.querySelector('[data-role="select-quality"]').addEventListener('click', () => {
            readFiltersFromToolbar();
            const selectedQualities = state.filters.qualities.slice();
            let count = 0;
            visibleItems().forEach((item) => {
                const matches = !selectedQualities.length || selectedQualities.includes(qualityBucket(item.height));
                if (matches) {
                    setItemSelected(item.id, true);
                    count++;
                }
            });
            applyView(false);
            const label = selectedQualities.length ? selectedQualities.map((q) => q >= 2160 ? '4K' : `${q}p`).join(', ') : 'all';
            toast(`Selected ${count} ${label} cards`);
        });
        toolbar.querySelector('[data-role="select"]').addEventListener('click', () => {
            visibleItems().forEach((item) => setItemSelected(item.id, true));
            applyView(false);
        });
        toolbar.querySelector('[data-role="clear"]').addEventListener('click', () => {
            Array.from(state.selectedIds).forEach((id) => setItemSelected(id, false));
            state.selectedIds.clear();
            state.filters.onlySelected = false;
            applyView(false);
        });
        toolbar.querySelector('[data-role="copy-urls"]').addEventListener('click', () => {
            const picked = selectedItems();
            if (!picked.length) { toast('No videos selected', true); return; }
            const text = picked.map((item) => item.url).join('\n');
            navigator.clipboard.writeText(text).then(() => {
                toast(`Copied ${picked.length} URL${picked.length !== 1 ? 's' : ''}`);
            }).catch(() => {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                toast(`Copied ${picked.length} URL${picked.length !== 1 ? 's' : ''}`);
            });
        });
        toolbar.querySelector('[data-role="import"]').addEventListener('click', () => {
            importSelected().catch((error) => toast(error?.message || 'Import failed', true));
        });
        updateToolbar();
        refreshQualityFilter();
        writeFiltersToToolbar();
    }

    function setBusy(next) {
        state.busy = !!next;
        updateToolbar();
    }

    // ---------------------------------------------------------- metadata I/O
    function findVideoJsonLd(doc) {
        const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
        const stack = [];
        for (const script of scripts) {
            try { stack.push(JSON.parse(script.textContent || '{}')); } catch { }
        }
        while (stack.length) {
            const item = stack.shift();
            if (!item) continue;
            if (Array.isArray(item)) { stack.push(...item); continue; }
            if (typeof item !== 'object') continue;
            const type = Array.isArray(item['@type']) ? item['@type'].join(' ') : String(item['@type'] || '');
            if (/VideoObject/i.test(type)) return item;
            if (item['@graph']) stack.push(item['@graph']);
        }
        return null;
    }

    // Highest quality advertised on the page, from "defaultQuality":[480,240,720,1080].
    // Gives an accurate height without any extra request.
    function extractMaxQualityFromHtml(html) {
        const m = String(html || '').match(/"defaultQuality"\s*:\s*\[([\d,\s]+)\]/i);
        if (!m) return 0;
        const nums = m[1].split(',').map((n) => parseInt(n.trim(), 10)).filter(Boolean);
        return nums.length ? Math.max(...nums) : 0;
    }

    // Modern RedTube pages don't inline direct mp4s. mediaDefinitions carries a
    // relative "/media/mp4?s=..." endpoint that returns a JSON array of
    // {quality, videoUrl:<direct .mp4>}. We return that endpoint so it can be
    // resolved in a second step (needed for the real size + top mp4 url).
    function extractMediaEndpoint(html) {
        // Prefer the mp4 media endpoint; fall back to hls.
        const mp4 = html.match(/"format"\s*:\s*"mp4"\s*,\s*"videoUrl"\s*:\s*"([^"]+)"/i)
            || html.match(/"videoUrl"\s*:\s*"([^"]*\/media\/mp4[^"]*)"/i);
        if (mp4) return { path: mp4[1].replace(/\\\//g, '/'), isHls: false };
        const hls = html.match(/"format"\s*:\s*"hls"\s*,\s*"videoUrl"\s*:\s*"([^"]+)"/i)
            || html.match(/"videoUrl"\s*:\s*"([^"]*\/media\/hls[^"]*)"/i);
        if (hls) return { path: hls[1].replace(/\\\//g, '/'), isHls: true };
        return null;
    }

    // Resolve the /media/mp4 endpoint into the best direct mp4 { url, height }.
    async function resolveMediaEndpoint(endpoint, pageUrl) {
        if (!endpoint?.path) return { url: '', height: 0 };
        const abs = endpoint.path.startsWith('http')
            ? endpoint.path
            : `https://www.redtube.com${endpoint.path.startsWith('/') ? '' : '/'}${endpoint.path}`;
        try {
            const resp = await fetch(abs, { credentials: 'include' });
            if (!resp.ok) { console.warn('[NexusRT] media endpoint HTTP', resp.status, abs); return { url: '', height: 0 }; }
            const arr = await resp.json();
            if (!Array.isArray(arr)) { console.warn('[NexusRT] media endpoint not array', arr); return { url: '', height: 0 }; }
            let best = null;
            let bestH = 0;
            for (const entry of arr) {
                const q = parseInt(entry?.quality, 10) || qualityHeight(entry?.videoUrl || '') || 0;
                const u = String(entry?.videoUrl || '').replace(/\\\//g, '/');
                if (q > bestH && /\.mp4/i.test(u)) { best = u; bestH = q; }
            }
            return { url: best || '', height: bestH };
        } catch (e) {
            console.warn('[NexusRT] media endpoint fetch failed:', e?.message || e);
            return { url: '', height: 0 };
        }
    }

    function extractTags(doc) {
        const tags = Array.from(doc.querySelectorAll('a[href*="/tags/"], a[href*="/tag/"], .video_tags a, .tags a'))
            .map((a) => (a.textContent || '').trim())
            .filter(Boolean);
        return Array.from(new Set(tags)).slice(0, 25);
    }

    async function metadataFromDoc(doc, html, item, pageUrl) {
        const ld = findVideoJsonLd(doc) || {};
        const thumb = Array.isArray(ld.thumbnailUrl) ? (ld.thumbnailUrl[ld.thumbnailUrl.length - 1] || ld.thumbnailUrl[0]) : (ld.thumbnailUrl || ld.image || '');
        const duration = parseIsoDuration(ld.duration) || item.duration || 0;

        // Quality: the page lists all available heights in "defaultQuality":[...].
        // Take the max — accurate without any extra request.
        const pageMaxHeight = extractMaxQualityFromHtml(html);

        // Resolve the /media/mp4 endpoint to get the direct top-quality mp4 (for a
        // precise height) and HEAD it for the real file size. HLS-only videos have
        // no single-file size, so size stays 0 there.
        let directUrl = '';
        let resolvedHeight = 0;
        let size = Number(item.size || 0) || 0;
        const endpoint = extractMediaEndpoint(html);
        if (endpoint && !endpoint.isHls) {
            const resolved = await resolveMediaEndpoint(endpoint, pageUrl || item.url);
            directUrl = resolved.url || '';
            resolvedHeight = resolved.height || 0;
            if (directUrl) {
                const bytes = await headSize(directUrl);
                if (bytes) size = bytes;
            }
        } else {
            console.warn('[NexusRT] no mp4 endpoint (isHls=' + (endpoint ? endpoint.isHls : 'none') + ') for', item.url);
        }
        console.log('[NexusRT] meta', item.url, '→ q=' + (pageMaxHeight || resolvedHeight), 'size=' + size, 'mp4=' + (directUrl ? 'yes' : 'no'));

        const height = Number(pageMaxHeight || resolvedHeight || ld.height || item.height || 0) || 0;
        const width = Number(ld.width || (height ? qualityWidth(height) : 0) || item.width || 0) || 0;
        const uploadTs = parseUploadDateValue(ld.uploadDate || doc.querySelector('meta[itemprop="uploadDate"]')?.content || '') || item.uploadTs || 0;
        return {
            thumbnail: thumb || item.thumbnail || '',
            directUrl,
            duration,
            height,
            width,
            size,
            quality: qualityLabel(`${height}p`) || item.quality || 'HD',
            uploadTs,
            uploadDate: uploadTs ? formatUploadDate(uploadTs) : (item.uploadDate || ''),
            tags: extractTags(doc),
            metaReady: true,
        };
    }

    async function enrichItem(item) {
        const cached = readMetaCache(item.id) || readMetaCache(item.url);
        if (cached?.metaReady && (cached.duration || cached.height || cached.size)) {
            return { ...item, ...cached };
        }
        try {
            const resp = await fetch(item.url, { credentials: 'include' });
            if (!resp.ok) return { ...item };
            const html = await resp.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const meta = await metadataFromDoc(doc, html, item, item.url);
            writeMetaCache(item.id, meta);
            writeMetaCache(item.url, meta);
            return { ...item, ...meta };
        } catch {
            return { ...item };
        }
    }

    async function fetchVisibleMetadata() {
        const candidates = pageItems();
        if (!candidates.length) return;
        state.metaBusy = true;
        updateToolbar();
        try {
            let done = 0;
            for (let i = 0; i < candidates.length; i += DETAIL_CONCURRENCY) {
                const chunk = candidates.slice(i, i + DETAIL_CONCURRENCY);
                const hydrated = await Promise.all(chunk.map((item) => enrichItem(item).catch(() => item)));
                hydrated.forEach((item) => {
                    const existing = state.items.get(item.id) || {};
                    const merged = { ...existing, ...item, card: existing.card || item.card };
                    state.items.set(item.id, merged);
                    upsertCardUI(merged);
                });
                done += chunk.length;
                toast(`Fetched metadata ${Math.min(done, candidates.length)}/${candidates.length}`);
            }
            refreshQualityFilter();
            applyView(false);
            const withSize = pageItems().filter((it) => Number(it.size || 0) > 0).length;
            const withQuality = pageItems().filter((it) => Number(it.height || 0) > 0).length;
            toast(`Updated ${candidates.length} cards · ${withQuality} quality · ${withSize} size`);
        } finally {
            state.metaBusy = false;
            updateToolbar();
        }
    }

    async function hydrateItems(items) {
        const output = [];
        for (let i = 0; i < items.length; i += DETAIL_CONCURRENCY) {
            const chunk = items.slice(i, i + DETAIL_CONCURRENCY);
            const hydrated = await Promise.all(chunk.map((item) => enrichItem(item)));
            output.push(...hydrated);
            toast(`Preparing ${Math.min(i + chunk.length, items.length)}/${items.length}...`);
        }
        return output;
    }

    async function importSelected() {
        const picked = selectedItems();
        if (!picked.length) return;
        setBusy(true);
        try {
            const hydrated = await hydrateItems(picked);
            const items = hydrated.map((entry) => ({
                title: entry.title || 'RedTube Video',
                // Prefer the RedTube watch page as the import url so the backend
                // extractor can resolve/refresh the freshest stream; keep any
                // directly-scraped mp4 as a hint.
                url: entry.url,
                source_url: entry.source_url || entry.url,
                direct_url: entry.directUrl || '',
                thumbnail: entry.thumbnail || '',
                sizeBytes: Number(entry.size || 0) || 0,
                duration: Number(entry.duration || 0) || 0,
                width: Number(entry.width || 0) || 0,
                height: Number(entry.height || 0) || 0,
                quality: entry.quality || 'HD',
                uploadDate: entry.uploadDate || (entry.uploadTs ? new Date(entry.uploadTs).toISOString() : ''),
                tags: Array.isArray(entry.tags) ? entry.tags : [],
            })).filter((entry) => entry.url);
            if (!items.length) throw new Error('No importable videos found');

            const batchName = `RedTube Quick Import: ${document.title.trim()}`;
            const res = await new Promise((resolve) => {
                chrome.runtime.sendMessage({ action: 'REDTUBE_IMPORT_BULK', batchName, items }, resolve);
            });
            if (!res?.ok) throw new Error(res?.error || 'Dashboard import failed');

            toast(`Imported ${res.imported || items.length} videos`);
            Array.from(state.selectedIds).forEach((id) => setItemSelected(id, false));
            state.selectedIds.clear();
            state.filters.onlySelected = false;
            applyView(false);
        } finally {
            setBusy(false);
        }
    }

    function boot() {
        console.log('[NexusRT] importer booted on', location.pathname);
        createToolbar();
        const n = scanCards();
        console.log('[NexusRT] initial scan found', n, 'cards');
        watchForNewCards();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
