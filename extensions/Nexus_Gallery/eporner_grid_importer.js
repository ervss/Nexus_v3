(function () {
    'use strict';

    if (window.top !== window) return;
    if (!/(^|\.)eporner\.com$/i.test(location.hostname)) return;

    const TOOLBAR_ID = 'nexus-ep-toolbar';
    const TOAST_ID = 'nexus-ep-toast';
    const GRID_ID = 'nexus-ep-clean-grid';
    const SHELL_ID = 'nexus-ep-shell';
    const STAGE_ID = 'nexus-ep-stage';
    const CHECKBOX_CLASS = 'nexus-ep-check';
    const META_CLASS = 'nexus-ep-meta';
    const CARD_SELECTED_CLASS = 'nexus-ep-selected';
    const CARD_HIDDEN_CLASS = 'nexus-ep-filter-hidden';
    const META_CACHE_PREFIX = 'nexus_eporner_card_meta_v2:';
    const META_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 45;
    const DETAIL_CONCURRENCY = 4;
    const PAGE_LOAD_DEFAULT = 5;
    const PAGE_LOAD_ALL_LIMIT = 100;
    const GRID_COLUMN_OPTIONS = [3, 4, 5, 6];
    const RAIL_WIDTH_SPINE = 320;
    const RAIL_WIDTH_COLLAPSED = 48;
    const state = {
        items: new Map(),
        selectedIds: new Set(),
        busy: false,
        metaBusy: false,
        statusText: '',
        lastSignature: '',
        nextOrder: 1,
        filters: {
            qualities: [],
            minDuration: 0,
            maxDuration: 0,
            minSize: 0,
            maxSize: 0,
            playlistMinCount: 0,
            newerThan: 0,
            olderThan: 0,
            onlySelected: false,
            titleQuery: '',
        },
        sortField: 'page',
        sortDir: 'desc',
        gridColumns: 5,
        layout: 'spine',
        scanTimer: 0,
        pageLoading: false,
        pagination: {
            nextUrl: '',
            maxPage: 0,
            loadedUrls: new Set(),
        },
    };

    function normalizeVideoKey(rawUrl) {
        const raw = String(rawUrl || '').trim();
        if (!raw) return '';
        try {
            const url = new URL(raw, location.href);
            const pathname = url.pathname.replace(/\/+$/, '');
            const match = pathname.match(/\/video-([^/?#]+)(?:\/([^/?#]*))?/i);
            if (match?.[1]) return `eporner:${String(match[1]).toLowerCase()}`;
            return `${url.hostname.replace(/^www\./i, '').toLowerCase()}${pathname}`.toLowerCase();
        } catch {
            return raw.toLowerCase();
        }
    }

    function toast(message, isError) {
        let el = document.getElementById(TOAST_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = TOAST_ID;
            el.className = 'nexus-ep-toast';
            document.body.appendChild(el);
        }
        el.textContent = String(message || '').trim() || (isError ? 'Import failed' : 'Done');
        el.dataset.error = isError ? '1' : '0';
        el.classList.add('visible');
        clearTimeout(el._timer);
        el._timer = setTimeout(() => el.classList.remove('visible'), 3200);
    }

    function setStatus(message) {
        state.statusText = String(message || '');
        updateToolbar();
    }

    function isToolbarCollapsed() {
        return document.getElementById(TOOLBAR_ID)?.dataset.collapsed === '1';
    }

    function currentRailWidth() {
        if (isToolbarCollapsed()) return RAIL_WIDTH_COLLAPSED;
        return RAIL_WIDTH_SPINE;
    }

    function listingAnchor() {
        const grid = document.getElementById(GRID_ID);
        const header = document.querySelector('#header, #topheader, .topheader');
        const content = document.querySelector('#profile_content, .profilemain, [class*="profilemain"], #content, #maincontent, .streameventsday, main');
        if (content && header && (content === header || content.contains(header))) return grid;
        if (content && content !== document.body && (!grid || content.contains(grid))) return content;
        return grid;
    }

    function expandShell(shell) {
        if (!shell?.parentElement) return;
        const parentRect = shell.parentElement.getBoundingClientRect();
        const shift = Math.max(0, Math.round(parentRect.left));
        const width = document.documentElement.clientWidth || window.innerWidth || 0;
        shell.style.setProperty('margin-left', shift ? `-${shift}px` : '0px', 'important');
        shell.style.setProperty('width', width ? `${width}px` : '100vw', 'important');
        shell.style.setProperty('max-width', 'none', 'important');
    }

    function mountWorkspace() {
        const toolbar = document.getElementById(TOOLBAR_ID);
        if (!toolbar) return;

        let shell = document.getElementById(SHELL_ID);
        let stage = document.getElementById(STAGE_ID);
        if (!shell) {
            const anchor = listingAnchor();
            if (!anchor?.parentElement || anchor === document.body || anchor === document.documentElement) return;
            shell = document.createElement('div');
            shell.id = SHELL_ID;
            stage = document.createElement('div');
            stage.id = STAGE_ID;
            anchor.parentElement.insertBefore(shell, anchor);
            shell.appendChild(stage);
            stage.appendChild(anchor);
        }
        stage = document.getElementById(STAGE_ID);
        shell.dataset.layout = 'spine';
        if (toolbar.nextElementSibling !== stage) shell.insertBefore(toolbar, stage);
        expandShell(shell);
        pinToolbarInColumn(toolbar);
    }

    function pinToolbarInColumn(toolbar) {
        const width = `${currentRailWidth()}px`;
        toolbar.style.setProperty('position', 'sticky', 'important');
        toolbar.style.setProperty('top', '0', 'important');
        toolbar.style.setProperty('left', 'auto', 'important');
        toolbar.style.setProperty('right', 'auto', 'important');
        toolbar.style.setProperty('bottom', 'auto', 'important');
        toolbar.style.setProperty('z-index', '20', 'important');
        toolbar.style.setProperty('width', width, 'important');
        toolbar.style.setProperty('min-width', width, 'important');
        toolbar.style.setProperty('max-width', width, 'important');
        toolbar.style.setProperty('flex', `0 0 ${width}`, 'important');
        toolbar.style.setProperty('height', '100vh', 'important');
        toolbar.style.setProperty('border-radius', '0', 'important');
        toolbar.style.setProperty('box-shadow', 'none', 'important');
        toolbar.style.setProperty('margin', '0', 'important');
    }

    function applyWorkspaceLayout() {
        state.layout = 'spine';
        const html = document.documentElement;
        html.classList.add('nexus-ep-docked');
        html.dataset.nexusEpLayout = state.layout;
        html.dataset.nexusEpCollapsed = isToolbarCollapsed() ? '1' : '0';
        html.style.setProperty('--nexus-ep-rail', `${currentRailWidth()}px`);
        mountWorkspace();
        applyFullBleedGridLayout();
    }

    function applyFullBleedGridLayout(grid = document.getElementById(GRID_ID)) {
        expandShell(document.getElementById(SHELL_ID));
        if (grid) {
            grid.dataset.columns = String(state.gridColumns);
            grid.style.setProperty('--nexus-ep-grid-columns', String(state.gridColumns));
        }
        if (!grid?.parentElement || /^\/video-/i.test(location.pathname)) return;
        // The results parent reserves space for Eporner's native filters.
        // Bleeding back to the stage edge puts the first cards under that panel.
        // Let the grid follow its results column in both importer layouts.
        grid.dataset.fullBleed = '0';
        grid.style.removeProperty('--nexus-ep-left-bleed');
        grid.style.removeProperty('--nexus-ep-stage-width');
    }

    function setGalleryColumns(columns) {
        const value = Number(columns);
        if (!GRID_COLUMN_OPTIONS.includes(value)) return;
        state.gridColumns = value;
        const grid = document.getElementById(GRID_ID);
        if (grid) {
            grid.dataset.columns = String(value);
            grid.style.setProperty('--nexus-ep-grid-columns', String(value));
        }
        document.querySelectorAll(`#${TOOLBAR_ID} [data-role="grid-columns"]`).forEach((button) => {
            const active = Number(button.dataset.columns) === value;
            button.dataset.active = active ? '1' : '0';
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
    }

    function suppressEpornerHoverPopups() {
        const selectors = [
            '#float_preview', '#previewdiv', '#mbpreview',
            '#gifhover', '#imghover', '.mbhover', '.hoverpreview',
        ];
        selectors.forEach((selector) => {
            document.querySelectorAll(selector).forEach((node) => {
                if (node.closest?.(`#${TOOLBAR_ID}, #${TOAST_ID}, #${GRID_ID}, #${SHELL_ID}`)) return;
                node.style.setProperty('display', 'none', 'important');
                node.style.setProperty('visibility', 'hidden', 'important');
                node.style.setProperty('pointer-events', 'none', 'important');
            });
        });
    }

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
        const text = String(raw || '');
        const match = text.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
        return match?.[1] ? parseDurationText(match[1]) : 0;
    }

    function parseIsoDuration(raw) {
        const match = String(raw || '').match(/P(?:T)?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
        if (!match) return 0;
        return (Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0);
    }

    function parseSizeBytes(raw) {
        const match = String(raw || '').match(/([\d.,]+)\s*(GB|MB|KB|B)\b/i);
        if (!match) return 0;
        const value = parseFloat(String(match[1]).replace(',', '.')) || 0;
        const unit = String(match[2] || '').toUpperCase();
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

    // Eporner lazy-loads listing posters by keeping the real URL in data-src
    // (and sometimes data-original) until its own intersection observer sees a
    // card. Quick Import can move a card into the compact grid before that
    // happens; the site observer then no longer watches it and the card remains
    // black. Hydrate those native image nodes ourselves without replacing their
    // markup or touching already loaded thumbnails.
    const THUMB_SOURCE_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-thumb', 'data-thumbnail'];

    function isUsableThumbUrl(value) {
        const url = String(value || '').trim();
        return !!url && !/^data:image\/(?:gif|svg)/i.test(url) && !/(?:blank|placeholder|spacer|loading)\.(?:gif|png|svg)(?:[?#]|$)/i.test(url);
    }

    // Eporner names each thumbnail by its height: ".../<frame>_240.jpg" is the
    // 427x240 tile shown in listings, but the very same frame also exists at
    // "_360" (640x360). Swapping the suffix costs no extra request (it replaces
    // the one image the card was going to load anyway) and never touches the
    // video CDN, so it can't trigger a rate-limit / IP ban. If "_360" happens
    // not to exist for a frame, the <img> error handler falls back to the
    // original candidates list, which still includes the working "_240" URL.
    function upscaleEpornerThumb(url) {
        return url.replace(
            /(\/thumbs\/[^"'\s]*?\/\d+)_240(\.jpg)(\b|$)/i,
            '$1_360$2$3',
        );
    }

    function thumbCandidates(image) {
        const raw = [
            ...THUMB_SOURCE_ATTRS.map((attr) => image.getAttribute(attr) || ''),
            image.getAttribute('src') || '',
        ].filter(isUsableThumbUrl);
        const absolute = raw.map((value) => {
            try { return new URL(value, location.href).href; } catch { return value; }
        });
        // Prefer the larger frame, but keep the original as a fallback candidate.
        const withUpscaled = [];
        for (const url of absolute) {
            const bigger = upscaleEpornerThumb(url);
            if (bigger !== url) withUpscaled.push(bigger);
            withUpscaled.push(url);
        }
        return [...new Set(withUpscaled)];
    }

    function hydrateCardThumbnails(card) {
        if (!card?.querySelectorAll) return;
        card.querySelectorAll('img').forEach((image) => {
            const candidates = thumbCandidates(image);
            if (!candidates.length) return;
            const current = image.currentSrc || image.getAttribute('src') || '';
            const failed = image.complete && image.naturalWidth === 0;
            if (!isUsableThumbUrl(current) || failed) {
                const nextIndex = failed ? candidates.findIndex((url) => url !== current) : 0;
                const index = nextIndex >= 0 ? nextIndex : 0;
                image.src = candidates[index];
                image.dataset.nexusEpThumbAttempt = String(index);
            }
            const srcset = image.getAttribute('data-srcset') || image.getAttribute('data-lazy-srcset');
            if (srcset && !image.getAttribute('srcset')) image.setAttribute('srcset', srcset);
            image.loading = 'eager';
            image.decoding = 'async';

            if (image.dataset.nexusEpThumbBound) return;
            image.dataset.nexusEpThumbBound = '1';
            image.addEventListener('error', () => {
                const sources = thumbCandidates(image);
                const nextIndex = Number(image.dataset.nexusEpThumbAttempt || 0) + 1;
                if (nextIndex < sources.length) {
                    image.dataset.nexusEpThumbAttempt = String(nextIndex);
                    image.src = sources[nextIndex];
                }
            });
        });
    }

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

        let date = new Date(text);
        if (Number.isNaN(date.getTime())) {
            const eu = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
            if (eu) {
                let year = Number(eu[3]);
                if (year < 100) year += 2000;
                date = new Date(year, Number(eu[2]) - 1, Number(eu[1]));
            }
        }
        if (Number.isNaN(date.getTime())) return 0;
        date.setHours(12, 0, 0, 0);
        return date.getTime();
    }

    function parseDateInputValue(raw, endOfDay = false) {
        const text = String(raw || '').trim();
        if (!text) return 0;
        const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) return parseUploadDateValue(text);
        const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        if (endOfDay) date.setHours(23, 59, 59, 999);
        else date.setHours(0, 0, 0, 0);
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
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    function isVideoHref(href) {
        try {
            const url = new URL(href || '', location.href);
            return /(^|\.)eporner\.com$/i.test(url.hostname) && /\/video-[^/]+(?:\/[^/?#]*)?\/?$/i.test(url.pathname);
        } catch {
            return false;
        }
    }

    function findVideoLink(node) {
        if (!node?.querySelector) return null;
        if (node.matches?.('a[href*="/video-"]') && isVideoHref(node.getAttribute('href') || node.href)) return node;
        return Array.from(node.querySelectorAll('a[href*="/video-"]')).find((link) => {
            return isVideoHref(link.getAttribute('href') || link.href);
        }) || null;
    }

    function cardScore(node) {
        if (!node?.querySelector) return 0;
        let score = 0;
        if (node.querySelector('img, picture')) score += 4;
        if (findVideoLink(node)) score += 4;
        if (node.querySelector('.vtime, .duration, .mbtim, [class*="dur"], [class*="time"]')) score += 2;
        if (node.querySelector('.mvhdico, .mbqual, .hd, .quality, .hd-thumbnail, [class*="qual"]')) score += 2;
        if (node.querySelector('.mbtit, .mbt, .title, .video-title, .thumb-title, h2, h3')) score += 1;
        return score;
    }

    function isGifOrPhotoHref(href) {
        try {
            const url = new URL(href || '', location.href);
            return /(^|\.)eporner\.com$/i.test(url.hostname) && /\/(?:gif|gifs|photo|photos|pics)\//i.test(url.pathname);
        } catch {
            return false;
        }
    }

    function isGifGalleryNode(node) {
        if (!node?.querySelector) return false;
        const gifCount = node.querySelectorAll('a[href*="/gif/"], a[href*="/photo/"], a[href*="/pics/"]').length;
        if (!gifCount) return false;
        const videoCount = Array.from(node.querySelectorAll('a[href*="/video-"]')).filter((link) => {
            return isVideoHref(link.getAttribute('href') || link.href);
        }).length;
        return gifCount >= videoCount;
    }

    function isPlaylistVideoListingPage() {
        return /^\/profile\/[^/]+\/playlist\/[A-Za-z0-9]+(?:\/[^/?#]+)?(?:\/\d+)?\/?$/i.test(location.pathname);
    }

    function playlistVideoListing() {
        if (!isPlaylistVideoListingPage()) return null;
        return Array.from(document.querySelectorAll('.streameventsday'))
            .filter((listing) => !listing.closest('.pf-pl-head, .pf-pl-info'))
            .find((listing) => Array.from(listing.querySelectorAll('.mb')).some((card) => {
                return !card.closest('.pf-pl-head, .pf-pl-info') && !!findVideoLink(card);
            })) || null;
    }

    function isProtectedMediaRegion(node) {
        if (!node?.closest) return false;
        if (node.closest(`#${TOOLBAR_ID}, #${TOAST_ID}, #${GRID_ID}`)) return false;
        if (node.closest('#profilehead, .profilehead, .bigprofile, .userinfo, #userinfo')) return true;
        return isGifGalleryNode(node);
    }

    function findCardFromVideoLink(link) {
        if (link && isGifOrPhotoHref(link.getAttribute('href') || link.href)) return null;
        let preferred = link.closest('.nexus-ep-grid-card, .mb, .post-data, .p-v-y');
        if (preferred && isProtectedMediaRegion(preferred)) preferred = null;
        if (!preferred) preferred = link.closest('.video, .video-item, .video-card, .thumb-item');
        if (!preferred) preferred = link.closest('.item, article, li');
        if (preferred?.tagName === 'A') preferred = preferred.parentElement;
        if (preferred && isProtectedMediaRegion(preferred)) preferred = null;
        if (preferred && preferred !== document.body && preferred !== document.documentElement && cardScore(preferred) >= 6) {
            return preferred;
        }

        let best = null;
        let node = link.parentElement;
        for (let depth = 0; node && node !== document.body && depth < 8; depth += 1, node = node.parentElement) {
            if (node.closest(`#${TOOLBAR_ID}, #${TOAST_ID}`)) continue;
            if (isProtectedMediaRegion(node)) continue;
            const rect = node.getBoundingClientRect?.();
            const score = cardScore(node);
            const linkCount = node.querySelectorAll?.('a[href*="/video-"]').length || 0;
            const isHuge = rect && (rect.width > Math.max(760, window.innerWidth * 0.7) || rect.height > 520);
            if (score >= 6 && linkCount <= 3 && !isHuge) {
                best = node;
                break;
            }
        }
        return best || link.closest('a[href*="/video-"]') || null;
    }

    function cardPriority(card) {
        if (!card) return 0;
        let score = 0;
        if (card.closest('.streameventsday, .profilemain, .fillerOuter, [id*="playlist"], [class*="playlist"]')) score += 20;
        if (card.closest('#content, main')) score += 4;
        if (card.closest('#profile_sidebar, #responsive_sidebar')) score -= 6;
        if (card.closest('.plexcontainer')) score -= 10;
        if (card.classList?.contains('nexus-ep-grid-card')) score += 2;
        return score;
    }

    function getCardCandidates() {
        const candidates = [];
        const playlistListing = playlistVideoListing();
        Array.from(document.querySelectorAll('a[href*="/video-"]')).forEach((link, index) => {
            if (!isVideoHref(link.getAttribute('href') || link.href)) return;
            if (isGifOrPhotoHref(link.getAttribute('href') || link.href)) return;
            const card = findCardFromVideoLink(link);
            // Cards may already have been moved into our clean grid. Exclude the
            // grid and its ancestors: otherwise a broad card selector can return
            // the grid itself, and normalizeCardLayout later attempts
            // grid.appendChild(grid), which throws HierarchyRequestError.
            const cleanGrid = document.getElementById(GRID_ID);
            if (card === cleanGrid || card?.contains?.(cleanGrid)) return;
            if (!card || card.closest(`#${TOOLBAR_ID}, #${TOAST_ID}`)) return;
            if (isPlaylistVideoListingPage() && (
                !playlistListing ||
                !playlistListing.contains(card) ||
                card.closest('.pf-pl-head, .pf-pl-info')
            )) return;
            if (isProtectedMediaRegion(card)) return;
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

    function normalizeCardLayout() {
        const cards = getCardNodes();
        if (!cards.length) return;

        // Dense listing pages should share one clean grid so sorting/filtering works
        // across every loaded page chunk, including profile playlists.
        // Any non-detail page with video cards is a batch surface: categories,
        // searches, feeds, profile favourites and playlists all need one grid.
        const isGridPage = !/^\/video-/i.test(location.pathname);
        if (!isGridPage) {
            cards.forEach((card) => card.classList.add('nexus-ep-grid-card'));
            return;
        }

        let grid = document.getElementById(GRID_ID);
        if (!grid) {
            grid = document.createElement('div');
            grid.id = GRID_ID;
            grid.className = 'nexus-ep-clean-grid';
            grid.dataset.columns = String(state.gridColumns);
        }
        const playlistListing = playlistVideoListing();
        const firstCard = cards[0];
        const gridParent = playlistListing || firstCard.parentElement;
        // Once cards are inside the grid, their parent is the grid itself.
        // Never try to insert the grid into itself on the next scan.
        if (gridParent && gridParent !== grid && !grid.contains(gridParent) && grid.parentElement !== gridParent) {
            const reference = firstCard.parentElement === gridParent ? firstCard : null;
            gridParent.insertBefore(grid, reference);
        }
        grid.dataset.columns = String(state.gridColumns);
        applyFullBleedGridLayout(grid);

        cards.forEach((card) => {
            // The page structure can change while more cards are appended. Keep
            // the destination grid out of the move set even if card discovery
            // matched a containing listing wrapper.
            if (card === grid || card.contains?.(grid)) return;
            card.classList.add('nexus-ep-grid-card');
            if (card.parentElement !== grid) grid.appendChild(card);
        });

        hideEmptyEpornerBlocks(grid);
        mountWorkspace();
    }

    function hideEmptyEpornerBlocks(grid) {
        const page = grid.closest('#content, main, .content, .main, body') || document.body;
        const candidates = Array.from(new Set([
            ...Array.from(page.children),
            ...Array.from(document.querySelectorAll('body div, body section, body article')),
        ]));
        candidates.forEach((node) => {
            if (node === grid || node.contains(grid) || node.closest(`#${GRID_ID}, #${TOOLBAR_ID}, #${TOAST_ID}, #${SHELL_ID}`)) return;
            if (isProtectedMediaRegion(node)) return;
            if (node.querySelector?.('a[href*="/video-"], a[href*="/gif/"], a[href*="/photo/"], a[href*="/playlist/"], img, video, iframe, canvas')) return;
            const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
            const rect = node.getBoundingClientRect?.();
            const isLargeBlank = rect && rect.width > 200 && rect.height > 70 && text.length < 40;
            const isEmptyShell = rect && rect.width > 200 && rect.height > 20 && text.length === 0 && node.children.length <= 2;
            const isPageSeparator = /^(Str[aá]nka|Page)\s+\d+$/i.test(text);
            const isPager = /\b(BACK|NEXT|Str[aá]nka|Page)\b/i.test(text)
                && (node.matches?.('nav, [class*="pag"], [id*="pag"]') || node.querySelector?.('a, button'))
                && !node.querySelector?.('img, video, iframe, canvas');
            if (isPageSeparator || isPager || isLargeBlank) {
                node.classList.add('nexus-ep-layout-hidden');
            }
            if (isEmptyShell && !node.querySelector('img, video, iframe, canvas')) {
                node.classList.add('nexus-ep-layout-hidden');
            }
        });
    }

    function parseVisibleUploadDate(text, node) {
        const timeValue = node?.querySelector?.('time[datetime]')?.getAttribute('datetime');
        const fromTime = parseUploadDateValue(timeValue);
        if (fromTime) return fromTime;

        for (const attr of ['data-upload-date', 'data-date', 'data-added', 'data-created', 'data-published']) {
            const raw = node?.getAttribute?.(attr) || node?.querySelector?.(`[${attr}]`)?.getAttribute(attr);
            const parsed = parseUploadDateValue(raw);
            if (parsed) return parsed;
        }

        const patterns = [
            /\b(\d{4}-\d{1,2}-\d{1,2})\b/,
            /\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/,
            /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/i,
            /\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{4})\b/i,
        ];
        for (const pattern of patterns) {
            const match = String(text || '').match(pattern);
            const parsed = parseUploadDateValue(match?.[1]);
            if (parsed) return parsed;
        }
        return 0;
    }

    function collectCard(node) {
        const link = findVideoLink(node);
        if (!link) return null;
        const url = link.href || link.getAttribute('href') || '';
        if (!url) return null;

        const cardText = String(node.innerText || '').replace(/\s+/g, ' ').trim();
        const img = node.querySelector('img');
        let thumbnail = img?.getAttribute('data-src') || img?.getAttribute('src') || img?.src || '';
        if (thumbnail.startsWith('//')) thumbnail = `https:${thumbnail}`;
        const durationLabel = node.querySelector('.vtime, .duration, .mbtim')?.textContent?.trim() || '';
        const rawQuality =
            node.querySelector('.mvhdico span, .mbqual, .hd, .quality, .hd-thumbnail')?.textContent?.trim() ||
            (cardText.match(/(4K\s?\(2160p\)|2160p|1440p|1080p|720p|480p|360p|240p)/i) || [''])[0];
        const title =
            link.getAttribute('title') ||
            node.querySelector('.mbtit, .mbt, .title, .video-title, .thumb-title, h2, h3')?.textContent?.trim() ||
            img?.getAttribute('alt') ||
            link.textContent?.trim() ||
            'Eporner Video';
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
            title: String(title || '').trim() || 'Eporner Video',
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

    // Playlist search results are not video cards, so they deliberately stay
    // outside the video importer map.  They still share the Quick Import
    // panel's title filter, bulk selection and ordering controls.
    function playlistEntries() {
        return Array.from(document.querySelectorAll(`a[href*="/playlist/"]`)).map((link, index) => {
            const card = findPlaylistCard(link);
            if (!card || card.closest(`#${TOOLBAR_ID}, #${TOAST_ID}`)) return null;
            const url = link.href || link.getAttribute('href') || '';
            if (!url) return null;
            return {
                card, url,
                title: link.getAttribute('title') || link.querySelector('img')?.getAttribute('alt') || link.textContent.trim() || 'Playlist',
                count: playlistCountFromCard(card),
                order: index,
            };
        }).filter(Boolean).filter((entry, index, entries) => entries.findIndex((other) => other.card === entry.card) === index);
    }

    function playlistPicker(entry) {
        return entry.card.querySelector('.nexus-ep-playlist-picker input[type="checkbox"]');
    }

    function isPlaylistSelected(entry) {
        return !!playlistPicker(entry)?.checked;
    }

    function playlistMatchesFilters(entry) {
        if (state.filters.onlySelected && !isPlaylistSelected(entry)) return false;
        const titleQuery = String(state.filters.titleQuery || '').trim().toLowerCase();
        if (titleQuery && !String(entry.title || '').toLowerCase().includes(titleQuery)) return false;
        return !state.filters.playlistMinCount || Number(entry.count || 0) >= state.filters.playlistMinCount;
    }

    function visiblePlaylistEntries() {
        return playlistEntries().filter((entry) => isNodeShown(entry.card) && playlistMatchesFilters(entry));
    }

    function selectedPlaylistEntries() {
        return playlistEntries().filter((entry) => isNodeShown(entry.card) && isPlaylistSelected(entry));
    }

    function isNodeShown(node) {
        if (!node || node.classList.contains(CARD_HIDDEN_CLASS)) return false;
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return true;
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

    function matchesCurrentFilters(item) {
        if (state.filters.onlySelected && !isItemSelected(item)) return false;
        const titleQuery = String(state.filters.titleQuery || '').trim().toLowerCase();
        if (titleQuery && !String(item.title || '').toLowerCase().includes(titleQuery)) return false;
        if (state.filters.qualities.length && !state.filters.qualities.includes(qualityBucket(item.height))) return false;
        if (state.filters.minDuration && Number(item.duration || 0) < state.filters.minDuration) return false;
        if (state.filters.maxDuration && Number(item.duration || 0) > state.filters.maxDuration) return false;
        if (state.filters.minSize && Number(item.size || 0) < state.filters.minSize) return false;
        if (state.filters.maxSize && Number(item.size || 0) > state.filters.maxSize) return false;
        if (state.filters.newerThan && (!item.uploadTs || Number(item.uploadTs || 0) < state.filters.newerThan)) return false;
        if (state.filters.olderThan && (!item.uploadTs || Number(item.uploadTs || 0) > state.filters.olderThan)) return false;
        return true;
    }

    function qualityBucket(height) {
        const value = Number(height || 0);
        return QUALITY_LEVELS.find((q) => value >= q) || 0;
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
            node.querySelector('.nexus-ep-preview')?.classList.toggle('nexus-ep-preview-selected', !!selected);
            const input = node.querySelector(`.${CHECKBOX_CLASS} input`);
            if (input) input.checked = !!selected;
        });
    }

    // Filtering/sorting moves cards between their original parent and the
    // compact helper grid. Pin the first visible card to the same viewport
    // position so selecting an item deep in a page never jumps to page top.
    function captureViewportAnchor() {
        const scrollX = window.scrollX;
        const scrollY = window.scrollY;
        const anchor = getCardNodes().find((node) => {
            const rect = node?.getBoundingClientRect?.();
            return rect && rect.bottom > 0 && rect.top < window.innerHeight;
        });
        return { scrollX, scrollY, anchor, top: anchor?.getBoundingClientRect?.().top || 0 };
    }

    function restoreViewportAnchor(snapshot) {
        if (!snapshot) return;
        const restore = () => {
            const nextTop = snapshot.anchor?.isConnected ? snapshot.anchor.getBoundingClientRect().top : snapshot.top;
            window.scrollTo(snapshot.scrollX, Math.max(0, snapshot.scrollY + nextTop - snapshot.top));
        };
        restore();
        requestAnimationFrame(restore);
    }

    function readFiltersFromToolbar() {
        const toolbar = document.getElementById(TOOLBAR_ID);
        if (!toolbar) return;
        state.filters.qualities = Array.from(toolbar.querySelectorAll('[data-role="quality-option"][data-active="1"]'))
            .map((button) => Number(button.dataset.quality || 0))
            .filter(Boolean);
        state.filters.minDuration = 0;
        state.filters.maxDuration = 0;
        state.filters.minSize = 0;
        state.filters.maxSize = 0;
        state.filters.playlistMinCount = 0;
        state.filters.newerThan = 0;
        state.filters.olderThan = 0;
        state.filters.titleQuery = String(toolbar.querySelector('[data-role="title-hunt"]')?.value || '').trim();
        state.sortField = toolbar.querySelector('[data-role="sort-field"]')?.value || 'page';
    }

    function writeFiltersToToolbar() {
        const toolbar = document.getElementById(TOOLBAR_ID);
        if (!toolbar) return;
        toolbar.querySelectorAll('[data-role="quality-option"]').forEach((button) => {
            const quality = Number(button.dataset.quality || 0);
            button.dataset.active = state.filters.qualities.includes(quality) ? '1' : '0';
        });
        const hunt = toolbar.querySelector('[data-role="title-hunt"]');
        if (hunt) hunt.value = state.filters.titleQuery || '';
        const sort = toolbar.querySelector('[data-role="sort-field"]');
        if (sort) sort.value = state.sortField;
    }

    function sortValue(item) {
        if (state.sortField === 'quality') return Number(item.height || 0);
        if (state.sortField === 'duration') return Number(item.duration || 0);
        if (state.sortField === 'size') return Number(item.size || 0);
        if (state.sortField === 'date') return Number(item.uploadTs || 0);
        if (state.sortField === 'title') return String(item.title || '').toLowerCase();
        return Number(item.order || 0);
    }

    function comparePlaylistEntries(a, b) {
        const field = state.sortField;
        let av;
        let bv;
        if (field === 'title') {
            av = String(a.title || '').toLowerCase();
            bv = String(b.title || '').toLowerCase();
        } else if (field === 'size' || field === 'playlist-size') {
            // Playlists do not expose byte size in a search listing. Their
            // meaningful size is the number of videos they contain.
            av = Number(a.count || 0);
            bv = Number(b.count || 0);
        } else {
            av = Number(a.order || 0);
            bv = Number(b.order || 0);
        }
        let result = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
        if (result === 0) result = Number(a.order || 0) - Number(b.order || 0);
        return field === 'page' ? result : result * (state.sortDir === 'asc' ? 1 : -1);
    }

    function sortPlaylistCards() {
        const byParent = new Map();
        playlistEntries().forEach((entry) => {
            const parent = entry.card?.parentElement;
            if (!parent) return;
            if (!byParent.has(parent)) byParent.set(parent, []);
            byParent.get(parent).push(entry);
        });
        byParent.forEach((entries, parent) => {
            entries.sort(comparePlaylistEntries).forEach((entry) => {
                if (entry.card?.parentElement === parent) parent.appendChild(entry.card);
            });
        });
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
            state.filters.maxSize ||
            state.filters.playlistMinCount ||
            state.filters.newerThan ||
            state.filters.olderThan ||
            String(state.filters.titleQuery || '').trim()
        );
    }

    function rememberCardHome(card) {
        if (!card || card.__nexusEpHome) return;
        const marker = document.createComment('nexus-ep-home');
        card.parentElement?.insertBefore(marker, card);
        card.__nexusEpHome = marker;
    }

    function restoreCardHomes() {
        const grid = document.getElementById(GRID_ID);
        state.items.forEach((item) => {
            const card = item.card;
            const marker = card?.__nexusEpHome;
            if (!card || !marker?.parentNode) return;
            if (card.parentNode !== marker.parentNode || marker.nextSibling !== card) {
                marker.parentNode.insertBefore(card, marker.nextSibling);
            }
        });
        if (grid?.dataset.temporary === '1' && !grid.children.length) grid.remove();
    }

    function ensureCompactGrid(firstCard) {
        let grid = document.getElementById(GRID_ID);
        if (!grid) {
            grid = document.createElement('div');
            grid.id = GRID_ID;
            grid.className = 'nexus-ep-clean-grid';
            grid.dataset.temporary = '1';
            firstCard?.parentElement?.insertBefore(grid, firstCard);
        }
        applyFullBleedGridLayout(grid);
        return grid;
    }

    function arrangeFilteredCards(visibleIds) {
        const keepNativeDetailLayout = !hasActiveViewFilter() && isDetailPage();
        if (keepNativeDetailLayout) {
            restoreCardHomes();
            return;
        }

        const visibleNodes = getCardNodes().filter((node) => visibleIds.has(getNodeVideoId(node)));
        if (!visibleNodes.length) return;

        const grid = ensureCompactGrid(visibleNodes[0]);
        visibleNodes.forEach((node) => {
            rememberCardHome(node);
            node.classList.add('nexus-ep-grid-card');
            grid.appendChild(node);
            hydrateCardThumbnails(node);
        });
    }

    function setCardHidden(node, hidden) {
        if (!node) return;
        node.classList.toggle(CARD_HIDDEN_CLASS, !!hidden);
        if (hidden) {
            node.style.setProperty('display', 'none', 'important');
            node.style.setProperty('visibility', 'hidden', 'important');
            node.style.setProperty('pointer-events', 'none', 'important');
        } else {
            node.style.removeProperty('display');
            node.style.removeProperty('visibility');
            node.style.removeProperty('pointer-events');
        }
    }

    // On a video detail page the only cards are Eporner's own "related videos",
    // which the site keeps lazy-loading. Reordering them behind the user's back
    // makes the row visibly jump around, so DOM rearranging there happens only
    // when the user explicitly asks for it (sort / apply view / filter click).
    function isDetailPage() {
        return /^\/video-/i.test(location.pathname);
    }

    function mayRearrangeNow(userDriven) {
        return userDriven || !isDetailPage();
    }

    function applyView(showToast, options = {}) {
        const userDriven = options.userDriven !== false;
        const viewport = captureViewportAnchor();
        readFiltersFromToolbar();
        const visibleIds = new Set();
        pageItems().forEach((item) => {
            if (matchesCurrentFilters(item)) visibleIds.add(item.id);
        });

        const shownNodes = new Set();
        const preferredVisibleNodes = new Set();
        getCardNodes().forEach((node) => {
            const id = getNodeVideoId(node);
            const match = id && visibleIds.has(id) && !shownNodes.has(id);
            if (match) {
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

        // Apply the shared title/selected filter and the playlist-specific
        // minimum-video filter to playlist search cards as well.
        const visiblePlaylistCards = new Set(playlistEntries()
            .filter(playlistMatchesFilters)
            .map((entry) => entry.card));
        playlistEntries().forEach((entry) => {
            setCardHidden(entry.card, activeFilter && !visiblePlaylistCards.has(entry.card));
        });

        const shown = shownNodes.size;
        const hidden = Math.max(0, state.items.size - shown);
        if (mayRearrangeNow(userDriven)) {
            arrangeFilteredCards(visibleIds);
            sortCards();
            sortPlaylistCards();
        }
        updateToolbar();
        if (showToast) toast(`Showing ${shown} card${shown !== 1 ? 's' : ''}${hidden ? `, hidden ${hidden}` : ''}`);
        restoreViewportAnchor(viewport);
    }

    function updateToolbar() {
        const toolbar = document.getElementById(TOOLBAR_ID);
        if (!toolbar) return;
        const selectedVideos = selectedItems().length;
        const selectedPlaylists = selectedPlaylistEntries().length;
        const selected = selectedVideos + selectedPlaylists;
        const visible = visibleItems().length;
        const playlists = visiblePlaylistEntries().length;
        const total = pageItems().length;
        const hidden = Math.max(0, total - visible);
        const sourcePages = state.pagination.loadedUrls.size;
        const maxPages = state.pagination.maxPage >= sourcePages ? state.pagination.maxPage : '?';
        const stats = toolbar.querySelector('.nexus-ep-stats');
        if (stats) stats.textContent = `${visible} of ${total} videos · ${selected} selected · ${sourcePages}/${maxPages} pages${hidden ? ` · ${hidden} filtered` : ''}${selectedPlaylists ? ` · ${selectedPlaylists} playlists` : ''}`;
        const status = toolbar.querySelector('[data-role="status"]');
        if (status) status.textContent = state.statusText || (state.busy ? 'Working…' : state.metaBusy ? 'Fetching video details…' : '');
        const collapse = toolbar.querySelector('[data-role="collapse"]');
        if (collapse) {
            collapse.textContent = toolbar.dataset.collapsed === '1' ? '+' : '−';
            collapse.title = toolbar.dataset.collapsed === '1' ? 'Expand panel' : 'Collapse panel';
            collapse.setAttribute('aria-label', collapse.title);
        }
        const importButton = toolbar.querySelector('[data-role="import"]');
        if (importButton) {
            importButton.disabled = selected === 0 || state.busy;
            importButton.textContent = state.busy ? 'Importing…' : `Import selected${selected ? ` (${selected})` : ''}`;
        }
        const clearButton = toolbar.querySelector('[data-role="clear"]');
        if (clearButton) clearButton.disabled = selected === 0 || state.busy;
        const selectButton = toolbar.querySelector('[data-role="select"]');
        if (selectButton) selectButton.disabled = (visible + playlists) === 0 || state.busy;
        const fetchButton = toolbar.querySelector('[data-role="fetch-meta"]');
        if (fetchButton) {
            fetchButton.disabled = total === 0 || state.busy || state.metaBusy || state.pageLoading;
            fetchButton.textContent = state.metaBusy ? 'Fetching…' : 'Fetch details';
        }
        const nextButton = toolbar.querySelector('[data-role="load-next-pages"]');
        if (nextButton) {
            nextButton.disabled = !state.pagination.nextUrl || state.pageLoading || state.busy;
            nextButton.textContent = state.pageLoading ? 'Loading…' : 'Load next 5 pages';
        }
        const allButton = toolbar.querySelector('[data-role="load-all-pages"]');
        if (allButton) {
            allButton.disabled = !state.pagination.nextUrl || state.pageLoading || state.busy;
            allButton.textContent = state.pageLoading ? 'Loading…' : 'Load all';
        }
        const directionButton = toolbar.querySelector('[data-role="sort-dir"]');
        if (directionButton) {
            directionButton.textContent = state.sortDir === 'asc' ? 'Ascending' : 'Descending';
            directionButton.setAttribute('aria-label', `Sort ${directionButton.textContent.toLowerCase()}`);
        }
        toolbar.querySelectorAll('[data-role="grid-columns"]').forEach((button) => {
            const active = Number(button.dataset.columns) === state.gridColumns;
            button.dataset.active = active ? '1' : '0';
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        toolbar.dataset.busy = (state.busy || state.metaBusy) ? '1' : '0';
        document.documentElement.dataset.nexusEpCollapsed = isToolbarCollapsed() ? '1' : '0';
        document.documentElement.style.setProperty('--nexus-ep-rail', `${currentRailWidth()}px`);
    }

    function upsertCardUI(item) {
        const card = item.card;
        if (!card) return;
        hydrateCardThumbnails(card);
        const preview = card.querySelector('.mbimg, .thumb, .thumb-block, .img, .image, .poster')
            || card.querySelector('img')?.closest('a[href*="/video-"]');
        if (preview) preview.classList.add('nexus-ep-preview');
        card.querySelectorAll('a[href*="/video-"]').forEach((link) => {
            if (preview && (preview === link || preview.contains(link))) return;
            link.target = '_blank';
            link.relList.add('noopener', 'noreferrer');
        });
        // position:relative alone does not create a stacking context: the
        // checkbox's huge z-index only wins against siblings inside this
        // card, not against Eporner's own sidebar, unless the card itself
        // also gets a z-index and so enters the page's top-level stacking
        // order on equal footing. Without this the leftmost column's
        // checkbox/badge render underneath the sidebar.
        if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
        if (!card.style.zIndex) card.style.zIndex = '1';

        let box = card.querySelector(`.${CHECKBOX_CLASS}`);
        if (!box) {
            box = document.createElement('label');
            box.className = CHECKBOX_CLASS;
            box.innerHTML = '<input type="checkbox"><span></span>';
            box.addEventListener('mousedown', (event) => {
                event.stopPropagation();
            });
            box.addEventListener('click', (event) => {
                event.stopPropagation();
            });
            const input = box.querySelector('input');
            input.addEventListener('change', (event) => {
                setItemSelected(item.id, !!event.target.checked);
                if (state.filters.onlySelected) applyView(false);
                else updateToolbar();
            });
            (preview || card).appendChild(box);
        }

        if (!card.dataset.nexusEpSelectBound) {
            card.dataset.nexusEpSelectBound = '1';
            // Only the preview selects; native information links remain usable.
            card.addEventListener('click', (event) => {
                if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                if (event.target.closest(`.${CHECKBOX_CLASS}, #${TOOLBAR_ID}, #${TOAST_ID}, .nvs-wh-play`)) return;
                const currentPreview = card.querySelector('.nexus-ep-preview');
                if (!currentPreview || !currentPreview.contains(event.target)) {
                    // Keep uploader/profile links native; the remaining info
                    // surface opens the video without changing the selection.
                    if (event.target.closest('a, button, input, select, textarea')) return;
                    if (event.target.closest('.mbunder')) {
                        event.preventDefault();
                        event.stopImmediatePropagation();
                        window.open(item.url, '_blank', 'noopener,noreferrer');
                    }
                    return;
                }
                event.preventDefault();
                event.stopImmediatePropagation();
                const next = !isItemSelected(item);
                setItemSelected(item.id, next);
                if (state.filters.onlySelected) applyView(false);
                else updateToolbar();
            }, true);
        }

        const input = box.querySelector('input');
        const selected = isItemSelected(item);
        input.checked = selected;
        card.classList.toggle(CARD_SELECTED_CLASS, selected);
        preview?.classList.toggle('nexus-ep-preview-selected', selected);

        const metaHost = card.querySelector('.mbimg, .thumb, .thumb-block, .img, .image, .poster, a[href*="/video-"]') || card;
        if (getComputedStyle(metaHost).position === 'static') metaHost.style.position = 'relative';

        let badge = card.querySelector(`.${META_CLASS}`);
        if (!badge) {
            badge = document.createElement('div');
            badge.className = META_CLASS;
            metaHost.appendChild(badge);
        } else if (badge.parentElement !== metaHost) {
            metaHost.appendChild(badge);
        }
        const dateText = item.uploadTs > 0 ? formatUploadDate(item.uploadTs) : '';
        const sizeText = item.size > 0 ? formatSize(item.size) : '';
        const durationText = item.duration > 0 ? formatDuration(item.duration) : '';
        const qualityText = item.height > 0 ? `${item.height}p` : '';
        badge.innerHTML = `
            ${dateText ? `<span class="nexus-ep-chip nexus-ep-date">${dateText}</span>` : ''}
            ${sizeText ? `<span class="nexus-ep-chip nexus-ep-size">${sizeText}</span>` : ''}
            ${durationText ? `<span class="nexus-ep-chip nexus-ep-duration">${durationText}</span>` : ''}
            ${qualityText ? `<span class="nexus-ep-chip nexus-ep-quality">${qualityText}</span>` : ''}
        `;
    }

    function scanCards() {
        syncPaginationFromDocument(document, location.href);
        normalizeCardLayout();
        const seen = new Set();
        const nodes = getCardNodes();
        const signature = nodes.map((node) => getNodeVideoId(node)).filter(Boolean).join('|');
        state.lastSignature = signature;
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
            if (!seen.has(id) || !item?.card?.isConnected) {
                state.items.delete(id);
            }
        });
        refreshQualityFilter();
        state.statusText = nodes.length ? `Found ${state.items.size} videos on this page.` : 'No videos found on this page.';
        applyView(false, { userDriven: false });
        return nodes.length;
    }

    function normalizePageUrl(rawUrl, baseUrl = location.href) {
        try {
            const url = new URL(rawUrl || '', baseUrl);
            if (url.origin !== location.origin) return '';
            url.hash = '';
            return url.href;
        } catch {
            return '';
        }
    }

    function pageNumberFromUrl(rawUrl) {
        try {
            const url = new URL(rawUrl, location.href);
            for (const key of ['page', 'p', 'page_num', 'pg']) {
                const page = Number(url.searchParams.get(key));
                if (Number.isInteger(page) && page > 0) return page;
            }
            const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
            // Pornstar routes place the page before the sort suffix: /2/recent/.
            const last = Number(parts[parts.length - 1] || 0);
            const beforeSort = /^(recent|weekly|monthly|top|viewed|rated|longest|shortest)$/i.test(parts.at(-1) || '')
                ? Number(parts.at(-2) || 0) : 0;
            return Number.isInteger(last) && last > 0 ? last : (Number.isInteger(beforeSort) && beforeSort > 0 ? beforeSort : 1);
        } catch {
            return 1;
        }
    }

    function findPagination(doc, baseUrl) {
        const base = normalizePageUrl(baseUrl);
        // Only pagination controls can advance the cursor. A video title may
        // contain the word "next", and Pagetual can add unrelated page bars.
        const containers = Array.from(doc.querySelectorAll('.numlist, .numlist2, [class*="pagination"], [id*="pagination"], nav[aria-label*="pagin" i]'))
            .filter((node) => !node.closest('[id^="pagetual"], [class*="pagetual"]'));
        const links = containers.flatMap((node) => Array.from(node.querySelectorAll('a[href]'))).map((link) => ({
            link,
            url: normalizePageUrl(link.getAttribute('href') || link.href, baseUrl),
            text: String(link.textContent || '').replace(/\s+/g, ' ').trim(),
        })).filter(({ url }) => !!url);
        const next = links.find(({ link, text, url }) => {
            const label = `${link.getAttribute('rel') || ''} ${link.getAttribute('aria-label') || ''} ${link.getAttribute('title') || ''} ${text}`.toLowerCase();
            return url !== base && (/\bnext\b/.test(label) || text === '›' || text === '»');
        })?.url || '';
        let maxPage = pageNumberFromUrl(base);
        links.forEach(({ url, text }) => {
            if (/^\d+$/.test(text)) maxPage = Math.max(maxPage, Number(text));
            maxPage = Math.max(maxPage, pageNumberFromUrl(url));
        });
        return { nextUrl: next, maxPage };
    }

    function syncPaginationFromDocument(doc, baseUrl) {
        const currentUrl = normalizePageUrl(baseUrl);
        if (currentUrl) state.pagination.loadedUrls.add(currentUrl);
        const found = findPagination(doc, baseUrl);
        // scanCards runs after every appended page, but the visible document is
        // still page 1. Do not move the cursor back to an already-loaded page.
        if (found.nextUrl && !state.pagination.loadedUrls.has(found.nextUrl)) {
            state.pagination.nextUrl = found.nextUrl;
        }
        state.pagination.maxPage = Math.max(state.pagination.maxPage, found.maxPage || 0);
    }

    function appendFetchedCards(doc) {
        const grid = document.getElementById(GRID_ID) || ensureCompactGrid(getCardNodes()[0]);
        if (!grid) return 0;
        const known = new Set(getCardNodes().map((node) => getNodeVideoId(node)).filter(Boolean));
        let added = 0;
        Array.from(doc.querySelectorAll('a[href*="/video-"]')).forEach((link) => {
            if (!isVideoHref(link.getAttribute('href') || link.href)) return;
            const card = findCardFromVideoLink(link);
            const id = getNodeVideoId(card);
            if (!card || !id || known.has(id)) return;
            known.add(id);
            const clone = card.cloneNode(true);
            clone.classList.remove(CARD_HIDDEN_CLASS, CARD_SELECTED_CLASS);
            clone.classList.add('nexus-ep-grid-card');
            grid.appendChild(clone);
            added++;
        });
        return added;
    }

    async function loadPages(mode) {
        if (state.pageLoading || !state.pagination.nextUrl) {
            if (!state.pagination.nextUrl) {
                setStatus('No more pages to load.');
                toast('No next page found', true);
            }
            return;
        }
        state.pageLoading = true;
        updateToolbar();
        try {
            const wanted = mode === 'all' ? PAGE_LOAD_ALL_LIMIT : PAGE_LOAD_DEFAULT;
            let added = 0;
            let loaded = 0;
            while (state.pagination.nextUrl && loaded < wanted) {
                const url = state.pagination.nextUrl;
                if (state.pagination.loadedUrls.has(url)) break;
                state.statusText = `Fetching page ${pageNumberFromUrl(url)}…`;
                updateToolbar();
                toast(`Loading page ${pageNumberFromUrl(url)}…`);
                const response = await fetch(url, { credentials: 'include' });
                if (!response.ok) throw new Error(`Could not load page ${pageNumberFromUrl(url)} (${response.status})`);
                const html = await response.text();
                const doc = new DOMParser().parseFromString(html, 'text/html');
                added += appendFetchedCards(doc);
                state.pagination.loadedUrls.add(url);
                const found = findPagination(doc, url);
                state.pagination.nextUrl = found.nextUrl;
                state.pagination.maxPage = Math.max(state.pagination.maxPage, found.maxPage || 0);
                loaded++;
                scanCards();
            }
            applyView(false, { userDriven: true });
            const capped = mode === 'all' && loaded === PAGE_LOAD_ALL_LIMIT && state.pagination.nextUrl;
            state.statusText = `Loaded ${loaded} page${loaded === 1 ? '' : 's'} · added ${added} videos${capped ? ' · limit reached, load all again to continue' : ''}.`;
            toast(`Loaded ${loaded} page${loaded !== 1 ? 's' : ''}, added ${added} cards${capped ? ' · load all again to continue' : ''}`);
        } catch (error) {
            state.statusText = `Could not load pages: ${error.message || error}`;
            toast(state.statusText, true);
        } finally {
            state.pageLoading = false;
            updateToolbar();
        }
    }

    function nodeMayContainVideoCard(node) {
        if (!node || node.nodeType !== 1) return false;
        if (node.closest?.(`#${TOOLBAR_ID}, #${TOAST_ID}`)) return false;
        if (node.matches?.('a[href*="/video-"], .mb, .post-data, .p-v-y')) return true;
        return !!node.querySelector?.('a[href*="/video-"], .mb, .post-data, .p-v-y');
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

    const QUALITY_LEVELS = [2160, 1440, 1080, 720, 480, 360];

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
            ? avail.map((q) => {
                const active = state.filters.qualities.includes(q);
                return `<button type="button" data-role="quality-option" data-quality="${q}" data-active="${active ? '1' : '0'}" aria-pressed="${active}">${q >= 2160 ? '4K' : q + 'p'}</button>`;
            }).join('')
            : '<span class="nexus-ep-quality-empty">No qualities yet</span>';
    }

    function createToolbar() {
        if (document.getElementById(TOOLBAR_ID)) return;
        const toolbar = document.createElement('div');
        toolbar.id = TOOLBAR_ID;
        toolbar.className = 'nexus-ep-toolbar';
        toolbar.innerHTML = `
            <div class="nexus-ep-head">
                <div>
                    <div class="nexus-ep-kicker">EPORNER</div>
                    <div class="nexus-ep-title">Quick import</div>
                </div>
                <button type="button" data-role="collapse" class="nexus-ep-collapse" aria-label="Collapse import panel" title="Collapse panel">−</button>
            </div>
            <div class="nexus-ep-stats" aria-live="polite">Scanning this page…</div>
            <div class="nexus-ep-status" data-role="status" role="status" aria-live="polite">Finding videos…</div>
            <section class="nexus-ep-gallery-layout" aria-label="Gallery layout">
                <span class="nexus-ep-section-title">Gallery view · columns</span>
                <div class="nexus-ep-column-picks" role="group" aria-label="Videos per row">
                    ${GRID_COLUMN_OPTIONS.map((columns) => `
                        <button type="button" data-role="grid-columns" data-columns="${columns}"
                            aria-label="${columns} columns" aria-pressed="${columns === state.gridColumns ? 'true' : 'false'}"
                            title="${columns} columns">${columns}</button>
                    `).join('')}
                </div>
            </section>
            <section class="nexus-ep-section" aria-label="Filter and sort videos">
                <div class="nexus-ep-section-title">Filter &amp; sort</div>
                <label class="nexus-ep-field">
                    <span>Title</span>
                    <input data-role="title-hunt" type="search" placeholder="Search titles…" autocomplete="off">
                </label>
                <div class="nexus-ep-quality-field">
                    <span class="nexus-ep-label">Quality</span>
                    <div data-role="quality-filter" class="nexus-ep-quality-picks" aria-label="Filter by video quality"></div>
                </div>
                <div class="nexus-ep-sort-row">
                    <label class="nexus-ep-field">
                        <span>Sort by</span>
                        <select data-role="sort-field">
                            <option value="page">Page order</option>
                            <option value="quality">Quality</option>
                            <option value="date">Upload date</option>
                            <option value="duration">Duration</option>
                            <option value="size">File size</option>
                            <option value="playlist-size">Playlist size</option>
                            <option value="title">Title</option>
                        </select>
                    </label>
                    <button type="button" data-role="sort-dir" class="nexus-ep-sort-dir" aria-label="Change sort direction">Newest</button>
                </div>
                <button type="button" data-role="show-all" class="nexus-ep-reset">Reset filters</button>
            </section>
            <section class="nexus-ep-section" aria-label="Fetch videos">
                <div class="nexus-ep-section-title">Fetch</div>
                <div class="nexus-ep-fetch-row">
                    <button type="button" data-role="refresh">Scan page</button>
                    <button type="button" data-role="fetch-meta">Fetch details</button>
                </div>
                <div class="nexus-ep-fetch-row">
                    <button type="button" data-role="load-next-pages">Load next 5 pages</button>
                    <button type="button" data-role="load-all-pages">Load all</button>
                </div>
            </section>
            <div class="nexus-ep-selection-row">
                <button type="button" data-role="select">Select visible</button>
                <button type="button" data-role="clear">Clear selection</button>
            </div>
            <div class="nexus-ep-actions">
                <button type="button" data-role="import" class="primary">Import selected</button>
            </div>
        `;
        document.body.appendChild(toolbar);
        toolbar.querySelector('[data-role="collapse"]').addEventListener('click', () => {
            toolbar.dataset.collapsed = toolbar.dataset.collapsed === '1' ? '0' : '1';
            applyWorkspaceLayout();
            updateToolbar();
        });
        toolbar.querySelector('[data-role="grid-columns"]').parentElement.addEventListener('click', (event) => {
            const button = event.target.closest('[data-role="grid-columns"]');
            if (!button) return;
            setGalleryColumns(button.dataset.columns);
        });
        toolbar.querySelector('[data-role="refresh"]').addEventListener('click', () => {
            scanCards();
            refreshQualityFilter();
            setStatus(`Found ${visibleItems().length} videos on this page.`);
        });
        toolbar.querySelector('[data-role="load-next-pages"]').addEventListener('click', () => {
            loadPages('next').catch((error) => {
                setStatus(error?.message || 'Could not load more pages.');
                toast(error?.message || 'Could not load more pages', true);
            });
        });
        toolbar.querySelector('[data-role="load-all-pages"]').addEventListener('click', () => {
            loadPages('all').catch((error) => {
                setStatus(error?.message || 'Could not load all pages.');
                toast(error?.message || 'Could not load all pages', true);
            });
        });
        toolbar.querySelector('[data-role="title-hunt"]').addEventListener('input', () => applyView(false));
        toolbar.querySelectorAll('select[data-role]').forEach((control) => {
            control.addEventListener('change', () => applyView(false));
        });
        toolbar.querySelector('[data-role="quality-filter"]').addEventListener('click', (event) => {
            const button = event.target.closest('[data-role="quality-option"]');
            if (!button) return;
            button.dataset.active = button.dataset.active === '1' ? '0' : '1';
            button.setAttribute('aria-pressed', button.dataset.active === '1' ? 'true' : 'false');
            applyView(false);
        });
        toolbar.querySelector('[data-role="show-all"]').addEventListener('click', () => {
            state.filters = {
                qualities: [],
                minDuration: 0,
                maxDuration: 0,
                minSize: 0,
                maxSize: 0,
                playlistMinCount: 0,
                newerThan: 0,
                olderThan: 0,
                onlySelected: false,
                titleQuery: '',
            };
            state.sortField = 'page';
            state.sortDir = 'desc';
            writeFiltersToToolbar();
            applyView(false);
        });
        toolbar.querySelector('[data-role="sort-dir"]').addEventListener('click', () => {
            state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
            applyView(false);
        });
        toolbar.querySelector('[data-role="fetch-meta"]').addEventListener('click', () => {
            fetchVisibleMetadata().catch((error) => {
                setStatus(error?.message || 'Could not fetch video details.');
                toast(error?.message || 'Could not fetch sizes/dates', true);
            });
        });
        toolbar.querySelector('[data-role="select"]').addEventListener('click', () => {
            visibleItems().forEach((item) => {
                setItemSelected(item.id, true);
            });
            let selectedPlaylists = 0;
            visiblePlaylistEntries().forEach((entry) => {
                const picker = playlistPicker(entry);
                if (picker && !picker.checked) {
                    picker.click(); // keeps the Playlist Studio basket in sync
                    selectedPlaylists++;
                }
            });
            applyView(false);
            if (selectedPlaylists) toast(`Selected ${selectedPlaylists} visible playlist${selectedPlaylists === 1 ? '' : 's'} for the playlist basket`);
        });
        toolbar.querySelector('[data-role="clear"]').addEventListener('click', () => {
            Array.from(state.selectedIds).forEach((id) => setItemSelected(id, false));
            state.selectedIds.clear();
            playlistEntries().forEach((entry) => {
                const picker = playlistPicker(entry);
                if (picker?.checked) picker.click(); // let Playlist Studio clear its own state
            });
            state.filters.onlySelected = false;
            applyView(false);
        });
        toolbar.querySelector('[data-role="import"]').addEventListener('click', () => {
            importSelectedWithPlaylists().catch((error) => {
                setStatus(error?.message || 'Import failed.');
                toast(error?.message || 'Import failed', true);
            });
        });
        updateToolbar();
        refreshQualityFilter();
        writeFiltersToToolbar();
        applyWorkspaceLayout();
    }

    function setBusy(next) {
        state.busy = !!next;
        updateToolbar();
    }

    function findVideoJsonLd(doc) {
        const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
        const stack = [];
        for (const script of scripts) {
            try {
                stack.push(JSON.parse(script.textContent || '{}'));
            } catch { }
        }
        while (stack.length) {
            const item = stack.shift();
            if (!item) continue;
            if (Array.isArray(item)) {
                stack.push(...item);
                continue;
            }
            if (typeof item !== 'object') continue;
            const type = Array.isArray(item['@type']) ? item['@type'].join(' ') : String(item['@type'] || '');
            if (/VideoObject/i.test(type)) return item;
            if (item['@graph']) stack.push(item['@graph']);
        }
        return null;
    }

    function findUploadDateDeep(value) {
        if (!value) return '';
        if (Array.isArray(value)) {
            for (const item of value) {
                const found = findUploadDateDeep(item);
                if (found) return found;
            }
            return '';
        }
        if (typeof value === 'object') {
            if (value.uploadDate) return value.uploadDate;
            for (const key of Object.keys(value)) {
                const found = findUploadDateDeep(value[key]);
                if (found) return found;
            }
        }
        return '';
    }

    function extractUploadDate(doc, ld) {
        const fromLd = findUploadDateDeep(ld);
        if (fromLd) return fromLd;
        return doc.querySelector('meta[itemprop="uploadDate"]')?.content ||
            doc.querySelector('meta[property="video:release_date"]')?.content ||
            doc.querySelector('time[datetime]')?.getAttribute('datetime') ||
            '';
    }

    function extractTaxonomy(doc) {
        const tags = Array.from(doc.querySelectorAll('.vit-tag a[href*="/tag/"], a[href*="/tag/"]'))
            .map((a) => (a.textContent || '').trim())
            .filter(Boolean);
        const categories = Array.from(doc.querySelectorAll('.vit-category a[href*="/cat/"], a[href*="/cat/"]'))
            .map((a) => (a.textContent || '').trim())
            .filter(Boolean);
        return {
            tags: Array.from(new Set(tags)),
            categories: Array.from(new Set(categories)),
        };
    }

    function extractDownloads(doc, baseUrl) {
        const options = Array.from(doc.querySelectorAll('#downloaddiv a[href*="/dload/"], a[href*="/dload/"]'))
            .map((a) => {
                const text = a.textContent || '';
                const href = new URL(a.getAttribute('href') || a.href, baseUrl).href;
                const height = qualityHeight(`${text} ${href}`);
                const size = parseSizeBytes(text);
                const codec = /av1/i.test(text) || /-av1\.mp4/i.test(href) ? 'AV1' : (/h264/i.test(text) ? 'h264' : '');
                return {
                    href,
                    height,
                    size,
                    quality: qualityLabel(text || href),
                    score: height * 100 + (codec === 'h264' ? 20 : 0) + (size > 0 ? 1 : 0),
                };
            })
            .filter((x) => x.href && x.height > 0);
        options.sort((a, b) => b.score - a.score);
        return options;
    }

    function metadataFromDoc(doc, item) {
        const ld = findVideoJsonLd(doc) || {};
        const downloads = extractDownloads(doc, item.url);
        const best = downloads[0] || null;
        const taxonomy = extractTaxonomy(doc);
        const thumb = Array.isArray(ld.thumbnailUrl) ? (ld.thumbnailUrl[ld.thumbnailUrl.length - 1] || ld.thumbnailUrl[0]) : (ld.thumbnailUrl || ld.image || '');
        const duration = parseIsoDuration(ld.duration) || item.duration || 0;
        const height = Number(ld.height || best?.height || item.height || 0) || 0;
        const width = Number(ld.width || item.width || 0) || 0;
        const quality = best?.quality || qualityLabel(`${height}p`) || item.quality || 'HD';
        const uploadTs = parseUploadDateValue(extractUploadDate(doc, ld)) || item.uploadTs || 0;
        return {
            thumbnail: thumb || item.thumbnail || '',
            size: Number(best?.size || item.size || 0) || 0,
            duration,
            height,
            width,
            quality,
            uploadTs,
            uploadDate: uploadTs ? formatUploadDate(uploadTs) : (item.uploadDate || ''),
            tags: taxonomy.tags,
            categories: taxonomy.categories,
            metaReady: true,
        };
    }

    async function enrichItemMeta(item) {
        const cached = readMetaCache(item.id) || readMetaCache(item.url);
        if (cached?.metaReady && (cached.size || cached.duration || cached.height)) {
            return { ...item, ...cached };
        }
        const resp = await fetch(item.url, { credentials: 'include' });
        if (!resp.ok) return { ...item };
        const html = await resp.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const meta = metadataFromDoc(doc, item);
        writeMetaCache(item.id, meta);
        writeMetaCache(item.url, meta);
        return { ...item, ...meta };
    }

    async function fetchVisibleMetadata() {
        const candidates = pageItems();
        if (!candidates.length) return;
        state.metaBusy = true;
        state.statusText = 'Fetching video details…';
        updateToolbar();
        try {
            let done = 0;
            for (let i = 0; i < candidates.length; i += DETAIL_CONCURRENCY) {
                const chunk = candidates.slice(i, i + DETAIL_CONCURRENCY);
                const hydrated = await Promise.all(chunk.map((item) => enrichItemMeta(item).catch(() => item)));
                hydrated.forEach((item) => {
                    const existing = state.items.get(item.id) || {};
                    const merged = { ...existing, ...item, card: existing.card || item.card };
                    state.items.set(item.id, merged);
                    upsertCardUI(merged);
                });
                done += chunk.length;
                state.statusText = `Fetching details · ${Math.min(done, candidates.length)}/${candidates.length}`;
                updateToolbar();
                toast(`Fetched sizes/dates ${Math.min(done, candidates.length)}/${candidates.length}`);
            }
            applyView(false);
            state.statusText = `Fetched details for ${candidates.length} videos.`;
            toast(`Updated ${candidates.length} card${candidates.length !== 1 ? 's' : ''}`);
        } finally {
            state.metaBusy = false;
            updateToolbar();
        }
    }

    // Extract the playable stream from page HTML. Eporner commonly exposes an
    // HLS manifest here; that is the same URL used by Open Direct in Nexus.
    function extractStreamFromHtml(html, pageUrl) {
        for (const q of ['4k', '2160p', '1440p', '1080p', '720p', '480p', '360p']) {
            const pat = new RegExp(`(?:["']?${q}["']?)\s*:\s*["'](https?://[^"']+\.(?:m3u8|mp4)[^"']*)["']`, 'i');
            const m = html.match(pat);
            if (m) return m[1].replace(/\\\//g, '/');
        }
        // Prefer HLS when both HLS and download URLs are present.
        const hls = html.match(/https?:\/\/[^"'<>\s]+\.m3u8(?:\?[^"'<>\s]*)?/i);
        if (hls) return hls[0].replace(/\\\//g, '/');
        // JSON-LD contentUrl fallback
        const ldm = html.match(/"contentUrl"\s*:\s*"(https?:\/\/[^\"]+\.(?:m3u8|mp4)[^\"]*)"/i);
        if (ldm) return ldm[1].replace(/\\\//g, '/');
        return null;
    }

    async function enrichItem(item) {
        try {
            // Match Nexus Open Direct: use the stream captured by the real
            // Eporner player first. This is normally the signed HLS manifest.
            if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
                const captured = await new Promise((resolve) => {
                    const timer = setTimeout(() => resolve(''), 1500);
                    try {
                        chrome.runtime.sendMessage({
                            action: 'GET_CAPTURED_STREAM',
                            pageUrl: item.url,
                            duration: Number(item.duration || 0) || 0,
                        }, (response) => {
                            clearTimeout(timer);
                            if (chrome.runtime.lastError) {
                                resolve('');
                                return;
                            }
                            const data = response?.data || response || {};
                            resolve(response?.ok && data?.playable ? String(data.streamUrl || '').trim() : '');
                        });
                    } catch {
                        clearTimeout(timer);
                        resolve('');
                    }
                });
                if (/\.(?:m3u8|mp4)(?:[?#]|$)/i.test(captured)) {
                    return { ...item, directUrl: captured };
                }
            }

            const resp = await fetch(item.url, { credentials: 'include' });
            if (!resp.ok) return { ...item };
            const html = await resp.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const ld = findVideoJsonLd(doc) || {};
            const downloads = extractDownloads(doc, item.url);
            const best = downloads[0] || null;
            const taxonomy = extractTaxonomy(doc);
            const thumb = Array.isArray(ld.thumbnailUrl) ? (ld.thumbnailUrl[ld.thumbnailUrl.length - 1] || ld.thumbnailUrl[0]) : (ld.thumbnailUrl || ld.image || '');
            const duration = parseIsoDuration(ld.duration) || item.duration || 0;
            const height = Number(ld.height || best?.height || item.height || 0) || 0;
            const width = Number(ld.width || 0) || 0;
            const quality = best?.quality || qualityLabel(`${height}p`) || item.quality || 'HD';
            const uploadTs = parseUploadDateValue(extractUploadDate(doc, ld)) || item.uploadTs || 0;

            // Try to get direct .mp4 stream from HTML (bypasses backend needing to re-fetch eporner)
            let directUrl = extractStreamFromHtml(html, item.url);

            // Fallback: resolve /dload/ redirect to actual .mp4 via HEAD request
            if (!directUrl && best?.href) {
                try {
                    const headResp = await fetch(best.href, { method: 'HEAD', credentials: 'include', redirect: 'follow' });
                    if (headResp.ok) {
                        const final = headResp.url || best.href;
                        if (/\.mp4(\?|$)/i.test(final)) directUrl = final;
                    }
                } catch { /* use dload href as-is */ }
                if (!directUrl) directUrl = best.href;
            }

            if (!directUrl) directUrl = String(ld.contentUrl || '').trim();

            const meta = {
                thumbnail: thumb || item.thumbnail,
                size: Number(best?.size || 0) || 0,
                duration,
                height,
                width,
                quality,
                uploadTs,
                uploadDate: uploadTs ? formatUploadDate(uploadTs) : (item.uploadDate || ''),
                tags: taxonomy.tags,
                categories: taxonomy.categories,
                metaReady: true,
            };
            writeMetaCache(item.id, meta);
            writeMetaCache(item.url, meta);

            return {
                ...item,
                directUrl,
                ...meta,
            };
        } catch {
            return { ...item };
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
                title: entry.title || 'Eporner Video',
                url: entry.directUrl || entry.url,
                source_url: entry.source_url || entry.url,
                thumbnail: entry.thumbnail || '',
                sizeBytes: Number(entry.size || 0) || 0,
                duration: Number(entry.duration || 0) || 0,
                width: Number(entry.width || 0) || 0,
                height: Number(entry.height || 0) || 0,
                quality: entry.quality || 'HD',
                uploadDate: entry.uploadDate || (entry.uploadTs ? new Date(entry.uploadTs).toISOString() : ''),
                tags: Array.isArray(entry.tags) ? entry.tags : [],
                categories: Array.isArray(entry.categories) ? entry.categories : [],
            })).filter((entry) => entry.url);
            if (!items.length) throw new Error('No importable videos found');

            const batchName = `Eporner Quick Import: ${document.title.trim()}`;
            const res = await new Promise((resolve) => {
                chrome.runtime.sendMessage({
                    action: 'EPORNER_IMPORT_BULK',
                    batchName,
                    items,
                }, resolve);
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

    async function importSelectedWithPlaylists() {
        const playlists = selectedPlaylistEntries();
        if (playlists.length) {
            setBusy(true);
            let imported = 0;
            try {
                for (let index = 0; index < playlists.length; index++) {
                    const playlist = playlists[index];
                    toast(`Importing playlist ${index + 1}/${playlists.length}…`);
                    const response = await new Promise((resolve) => {
                        chrome.runtime.sendMessage({
                            action: 'EPORNER_EXPAND_PLAYLIST',
                            playlistUrl: playlist.url,
                            playlistTitle: playlist.title,
                        }, resolve);
                    });
                    if (!response?.ok) throw new Error(response?.error || `Playlist import failed: ${playlist.title}`);
                    imported += Number(response.imported || 0);
                    const picker = playlistPicker(playlist);
                    if (picker?.checked) picker.click(); // clear the Studio basket too
                }
                toast(`Imported ${playlists.length} playlist${playlists.length === 1 ? '' : 's'} · ${imported} videos`);
            } finally {
                setBusy(false);
            }
        }
        if (selectedItems().length) await importSelected();
        updateToolbar();
    }

    // ============================================================
    // PLAYLIST CARDS — completely separate from the video-card scanner
    // above. Every function in this file up to here assumes a card wraps an
    // `a[href*="/video-"]` link (findVideoLink, getNodeVideoId,
    // normalizeVideoKey, hideEmptyEpornerBlocks all hardcode that), so a
    // playlist card (`a[href*="/playlist/"]`, no video link at all) is
    // invisible to that machinery — worse, hideEmptyEpornerBlocks actively
    // hides it as an "empty" block on grid pages. Rather than thread a
    // second card shape through code that was tuned specifically around one
    // link pattern, this runs its own small, independent scan: find
    // playlist cards, drop one "Import playlist" button on each, and expand
    // + bulk-import through the dashboard's existing EpornerHub adapter
    // (app/hubs/eporner.py already fully implements playlist paging) on click.
    // ============================================================
    const PLAYLIST_BUTTON_CLASS = 'nexus-ep-playlist-import';
    const PLAYLIST_MARK_ATTR = 'data-nexus-ep-playlist-marked';

    function findPlaylistLink(node) {
        if (!node?.querySelector) return null;
        if (node.matches?.('a[href*="/playlist/"]')) return node;
        return node.querySelector('a[href*="/playlist/"]');
    }

    function findPlaylistCard(link) {
        return link.closest('.mb, .post-data, .p-v-y, .item, article, li') || link.parentElement;
    }

    function playlistCountFromCard(card) {
        const el = card.querySelector('.mbphoto2_playlistico, .mbphoto2_galleryico, [class*="playlist"][class*="ico"]');
        const digits = String(el?.textContent || '').replace(/[^\d]/g, '');
        return digits ? parseInt(digits, 10) : 0;
    }

    function scanPlaylistCards() {
        document.querySelectorAll('a[href*="/playlist/"]').forEach((link) => {
            const card = findPlaylistCard(link);
            if (!card || card.hasAttribute(PLAYLIST_MARK_ATTR)) return;
            if (card.closest(`#${TOOLBAR_ID}, #${TOAST_ID}`)) return;
            card.setAttribute(PLAYLIST_MARK_ATTR, '1');

            const count = playlistCountFromCard(card);
            const title = link.getAttribute('title') || link.querySelector('img')?.getAttribute('alt')
                || link.textContent.trim() || 'Playlist';
            const href = link.href || link.getAttribute('href');

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = PLAYLIST_BUTTON_CLASS;
            btn.textContent = count ? `Import playlist (${count})` : 'Import playlist';
            btn.style.cssText = 'position:absolute;left:6px;bottom:6px;z-index:5;padding:4px 9px;'
                + 'border:1px solid #d4af37;border-radius:6px;background:rgba(10,10,10,.85);'
                + 'color:#f0d060;font:600 11px Arial,sans-serif;cursor:pointer';
            btn.addEventListener('click', async (event) => {
                event.preventDefault();
                event.stopPropagation();
                const original = btn.textContent;
                btn.disabled = true;
                btn.textContent = 'Expanduje sa…';
                try {
                    const response = await new Promise((resolve) => {
                        chrome.runtime.sendMessage({
                            action: 'EPORNER_EXPAND_PLAYLIST',
                            playlistUrl: href,
                            playlistTitle: title,
                        }, resolve);
                    });
                    if (!response?.ok) throw new Error(response?.error || 'Import failed');
                    toast(`Playlist imported: ${response.imported} videos`);
                    btn.textContent = 'Imported!';
                } catch (error) {
                    toast(error?.message || 'Playlist import failed', true);
                    btn.textContent = original;
                    btn.disabled = false;
                    return;
                }
                setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 2500);
            });

            if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
            card.appendChild(btn);
        });
        updateToolbar();
    }

    function watchForNewPlaylistCards() {
        const observer = new MutationObserver((mutations) => {
            const hasPlaylistLinks = mutations.some((mutation) =>
                Array.from(mutation.addedNodes || []).some((node) =>
                    node.nodeType === 1 && (node.matches?.('a[href*="/playlist/"]') || node.querySelector?.('a[href*="/playlist/"]'))
                )
            );
            if (hasPlaylistLinks) scanPlaylistCards();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function isGifOnlySurface() {
        if (!/\/(?:gif|gifs|photo|photos|pics)(?:\/|$)/i.test(location.pathname)) return false;
        return !document.querySelector('a[href*="/video-"]');
    }

    function bindHoverSuppression() {
        document.addEventListener('mouseover', (event) => {
            const gif = event.target?.closest?.('a[href*="/gif/"], a[href*="/photo/"], a[href*="/pics/"]');
            if (!gif || gif.closest(`#${GRID_ID}, #${TOOLBAR_ID}`)) return;
            event.stopPropagation();
            suppressEpornerHoverPopups();
        }, true);
    }

    function boot() {
        if (isGifOnlySurface()) return;
        createToolbar();
        applyWorkspaceLayout();
        scanCards();
        watchForNewCards();
        scanPlaylistCards();
        watchForNewPlaylistCards();
        document.addEventListener('change', (event) => {
            if (event.target?.matches?.('.nexus-ep-playlist-picker input[type="checkbox"]')) updateToolbar();
        }, true);
        bindHoverSuppression();
        suppressEpornerHoverPopups();
        window.addEventListener('resize', () => applyFullBleedGridLayout(), { passive: true });

        // The bleed math reads the grid's parent (the results column next to
        // Eporner's own sidebar) once at boot. If the sidebar's filter counts,
        // category list or fonts finish laying out a moment later, that
        // measurement goes stale — nothing but a literal window resize ever
        // triggered a recompute, so the grid stayed offset by the wrong
        // amount indefinitely (worst at the left edge, since that is exactly
        // what the bleed margin controls). Re-measure shortly after boot and
        // keep watching the parent's own size for late layout shifts.
        setTimeout(() => applyFullBleedGridLayout(), 600);
        setTimeout(() => applyFullBleedGridLayout(), 1500);
        const grid = document.getElementById(GRID_ID);
        if (window.ResizeObserver && grid?.parentElement) {
            new ResizeObserver(() => applyFullBleedGridLayout()).observe(grid.parentElement);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
