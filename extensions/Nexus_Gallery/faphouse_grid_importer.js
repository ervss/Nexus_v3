(function () {
    'use strict';

    if (window.top !== window) return;
    if (!/(^|\.)faphouse\.com$/i.test(location.hostname)) return;

    const TOOLBAR_ID = 'nexus-fh-toolbar';
    const BUBBLE_ID = 'nexus-fh-bubble';
    const CHECK_CLASS = 'nexus-fh-check';
    const TOAST_ID = 'nexus-fh-toast';
    const SELECTED_CLASS = 'nexus-fh-selected';
    const STORAGE_POS_KEY = 'nexus_fh_pos';
    const STORAGE_MIN_KEY = 'nexus_fh_minimized';
    const STORAGE_PAGE_COUNT_KEY = 'nexus_fh_next_page_count';
    const SIZE_PROBE_CONCURRENCY = 4;

    const state = {
        items: new Map(),
        busy: false,
        lastCardCount: 0,
        minimized: localStorage.getItem(STORAGE_MIN_KEY) === 'true',
        position: loadStoredPosition(),
        sizeProbeQueue: [],
        activeSizeProbes: 0,
        lastFetchedItems: [],
        nextCardOrder: 0,
        isLoadingPages: false,
        loadedPages: new Set(),
        nextPage: 0,
        filter: {
            query: '',
            sort: 'site',
            onlyMatches: false,
        },
    };

    function loadStoredPosition() {
        try {
            const raw = localStorage.getItem(STORAGE_POS_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
                    return parsed;
                }
            }
        } catch {}
        return null;
    }

    function savePosition(x, y) {
        state.position = { x, y };
        try {
            localStorage.setItem(STORAGE_POS_KEY, JSON.stringify({ x, y }));
        } catch {}
    }

    function applyPosition(el, pos) {
        if (!el || !pos) return;
        const maxLeft = Math.max(10, window.innerWidth - (el.offsetWidth || 50) - 10);
        const maxTop = Math.max(10, window.innerHeight - (el.offsetHeight || 50) - 10);
        const safeX = Math.max(10, Math.min(maxLeft, pos.x));
        const safeTop = Math.max(10, Math.min(maxTop, pos.y));
        el.style.left = `${safeX}px`;
        el.style.top = `${safeTop}px`;
        el.style.right = 'auto';
        el.style.bottom = 'auto';
    }

    function makeDraggable(element, handle, onDragEnd) {
        let isDragging = false;
        let hasMoved = false;
        let startX = 0, startY = 0;
        let initialX = 0, initialY = 0;

        handle = handle || element;

        handle.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            // Prevent drag when clicking buttons inside header
            if (e.target.closest('button, input, a')) return;

            isDragging = true;
            hasMoved = false;
            startX = e.clientX;
            startY = e.clientY;

            const rect = element.getBoundingClientRect();
            initialX = rect.left;
            initialY = rect.top;

            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
                hasMoved = true;
            }

            if (hasMoved) {
                const maxLeft = Math.max(0, window.innerWidth - element.offsetWidth - 10);
                const maxTop = Math.max(0, window.innerHeight - element.offsetHeight - 10);
                const nx = Math.max(10, Math.min(maxLeft, initialX + dx));
                const ny = Math.max(10, Math.min(maxTop, initialY + dy));

                element.style.left = `${nx}px`;
                element.style.top = `${ny}px`;
                element.style.right = 'auto';
                element.style.bottom = 'auto';
            }
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                if (hasMoved) {
                    const rect = element.getBoundingClientRect();
                    savePosition(Math.round(rect.left), Math.round(rect.top));
                    if (typeof onDragEnd === 'function') {
                        onDragEnd(Math.round(rect.left), Math.round(rect.top));
                    }
                }
            }
        });

        // Return check if recently dragged to prevent accidental clicks
        return () => hasMoved;
    }

    function toast(message, isError = false) {
        let el = document.getElementById(TOAST_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = TOAST_ID;
            el.className = 'nexus-fh-toast';
            document.body.appendChild(el);
        }
        el.textContent = message;
        el.dataset.error = isError ? '1' : '0';
        el.classList.add('visible');
        clearTimeout(el._timer);
        el._timer = setTimeout(() => el.classList.remove('visible'), 3500);
    }

    function parseDurationSeconds(text) {
        const raw = String(text || '').trim();
        const m = raw.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
        if (m) {
            const a = Number.parseInt(m[1], 10);
            const b = Number.parseInt(m[2], 10);
            const c = m[3] ? Number.parseInt(m[3], 10) : null;
            return c == null ? a * 60 + b : a * 3600 + b * 60 + c;
        }
        return 0;
    }

    function isWatchPage() {
        return /^\/videos\/[a-zA-Z0-9_-]+/i.test(location.pathname);
    }

    // Faphouse listing URLs retain all active filters in the query string.  Only
    // the page parameter changes, so a multi-page load stays within the exact
    // category/sort/quality selection the user is currently viewing.
    function currentListingPage() {
        const page = Number.parseInt(new URL(location.href).searchParams.get('page') || '1', 10);
        return Number.isFinite(page) && page > 0 ? page : 1;
    }

    function listingPageUrl(page) {
        const url = new URL(location.href);
        url.searchParams.set('page', String(page));
        return url.href;
    }

    function listingCardSelectors() {
        return [
            '[data-el="Thumb"][data-id]',
            '[data-id][data-el-video]',
            '.thumb:has(a[href*="/videos/"])',
            '.t-m',
            '[data-el="VideoCard"]',
            '.video-item',
        ];
    }

    function listingCards(root) {
        for (const selector of listingCardSelectors()) {
            try {
                const cards = Array.from(root.querySelectorAll(selector)).filter((node) => node.querySelector('img'));
                if (cards.length) return cards;
            } catch {}
        }
        return [];
    }

    function itemIdFromCard(card) {
        const anchor = card?.matches?.('a[href*="/videos/"]')
            ? card
            : card?.querySelector?.('a.t-vl[href*="/videos/"], a[href*="/videos/"]');
        const rawHref = anchor?.getAttribute?.('href') || '';
        const slug = rawHref.split('?')[0].replace(/\/+$/, '').split('/videos/')[1] || '';
        return slug.split('-').pop() || '';
    }

    function liveListingContainer() {
        const item = Array.from(state.items.values()).find((candidate) => candidate.card?.isConnected);
        if (item?.card?.parentElement) return item.card.parentElement;
        const firstCard = listingCards(document)[0];
        return firstCard?.parentElement || null;
    }

    async function loadNextPages(requestedCount) {
        if (isWatchPage()) {
            toast('Load Next funguje iba na stránke so zoznamom videí.', true);
            return;
        }
        if (state.isLoadingPages) return;

        const container = liveListingContainer();
        if (!container) {
            toast('Nenašiel sa zoznam videí, preto sa ďalšie stránky nedajú pripojiť.', true);
            return;
        }

        const count = Math.max(1, Math.min(50, Number.parseInt(requestedCount, 10) || 5));
        const firstPage = state.nextPage || currentListingPage() + 1;
        let added = 0;
        let loaded = 0;
        let reachedEnd = false;
        state.isLoadingPages = true;
        updateUi();

        try {
            for (let page = firstPage; page < firstPage + count; page += 1) {
                const status = document.querySelector(`#${TOOLBAR_ID} [data-role="page-status"]`);
                if (status) status.textContent = `Načítavam stranu ${page} (${loaded + 1}/${count})…`;

                const response = await fetch(listingPageUrl(page), { credentials: 'include' });
                if (!response.ok) throw new Error(`strana ${page}: HTTP ${response.status}`);
                const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
                const fetchedCards = listingCards(doc);
                if (!fetchedCards.length) {
                    reachedEnd = true;
                    state.nextPage = page;
                    break;
                }

                let addedOnPage = 0;
                for (const fetchedCard of fetchedCards) {
                    const id = itemIdFromCard(fetchedCard);
                    if (!id || state.items.has(id) || container.querySelector(`[data-nexus-fh-loaded-id="${CSS.escape(id)}"]`)) continue;
                    const clone = fetchedCard.cloneNode(true);
                    clone.dataset.nexusFhLoadedId = id;
                    clone.dataset.nexusFhLoadedPage = String(page);
                    container.appendChild(clone);
                    added += 1;
                    addedOnPage += 1;
                }
                loaded += 1;
                state.loadedPages.add(page);
                state.nextPage = page + 1;
                scanCards();

                // A non-empty page that contains only cards already present is
                // the site's end/loop page. Stop here instead of fetching the
                // same last page for every remaining requested slot.
                if (!addedOnPage) {
                    reachedEnd = true;
                    break;
                }
            }
            toast(added
                ? `Pripojené ${added} nových videí z ${loaded} strán${reachedEnd ? ' (koniec zoznamu)' : ''}.`
                : 'Nenašli sa žiadne nové videá; pravdepodobne je koniec zoznamu.');
        } catch (error) {
            toast(`Load Next zlyhal: ${error?.message || 'neznáma chyba'}`, true);
        } finally {
            state.isLoadingPages = false;
            updateUi();
        }
    }

    function collectCard(container) {
        // a.t-vl is the poster link of a real card; the generic lookup also hits
        // tag/category links such as /videos/blonde, which produced ghost items.
        const anchor = container.matches('a[href*="/videos/"]')
            ? container
            : (container.querySelector('a.t-vl[href*="/videos/"]') || container.querySelector('a[href*="/videos/"]'));
        if (!anchor) return null;

        const rawHref = anchor.getAttribute('href') || '';
        if (!rawHref || rawHref === '/videos' || rawHref === '/videos/' || rawHref.startsWith('/videos/vr')) return null;
        // Watch URLs are either "<slug>-<id>" or a bare mixed-case "<id>";
        // tag/category URLs are all-lowercase single words (/videos/blonde).
        const slug = rawHref.split('?')[0].replace(/\/+$/, '').split('/videos/')[1] || '';
        const isWatchHref = anchor.classList.contains('t-vl')
            || /-[a-zA-Z0-9]{4,}$/.test(slug)
            || (/^[A-Za-z0-9]{5,}$/.test(slug) && /[A-Z]/.test(slug) && /[a-z0-9]/.test(slug));
        if (!isWatchHref) return null;

        let absUrl = '';
        try {
            absUrl = new URL(rawHref, location.origin).href.split('#')[0];
        } catch {
            absUrl = rawHref.split('#')[0];
        }

        // The same card is exposed through several nested Faphouse elements.
        // Its watch URL is stable; container data-id is not, and was causing a
        // second Nexus checkbox to appear when the React tree refreshed.
        // The id is the LAST dash segment of the slug.  The old pattern
        // (`[^-]*-(...)`) captured the second word instead, so unrelated videos
        // shared an id ("blonde", "let") and overwrote each other in state.
        const id = slug.split('-').pop() || absUrl;

        const img = container.querySelector('img.t-i, img[src*="flixcdn"], img');
        const thumbnail = img?.src || img?.dataset?.src || '';

        let title = img?.getAttribute('alt') || anchor.getAttribute('title') || anchor.textContent.trim() || '';
        title = title.replace(/\s+/g, ' ').trim();
        if (!title || title.length < 3) {
            const titleEl = container.querySelector('.t-t, .title, h3, h4');
            if (titleEl) title = titleEl.textContent.trim();
        }

        const durEl = container.querySelector('.t-vi, .duration, [class*="duration"]');
        const durationText = durEl?.textContent || '';
        const duration = parseDurationSeconds(durationText);
        const quality = /HD/i.test(durationText) ? '1080p' : '';

        return {
            id,
            url: absUrl,
            title: title || `Faphouse Video ${id}`,
            thumbnail,
            duration,
            quality,
            sizeBytes: Number(state.items.get(id)?.sizeBytes || 0),
            reportedSizeBytes: cardSizeBytes(container),
            addedDate: state.items.get(id)?.addedDate || cardAddedDate(container),
            direct_url: null, // Don't use card previews as direct stream
            selected: !!state.items.get(id)?.selected,
            discoveryOrder: Number(state.items.get(id)?.discoveryOrder || 0) || ++state.nextCardOrder,
            card: container,
        };
    }

    // ── Background stream resolve ─────────────────────────────────────────────
    // A grid card only carries the watch-page URL, and the dashboard's server-side
    // extractor cannot turn that into a stream: its cookie jar is a signed-out
    // session, so Faphouse hands it the trailer and nothing else. This page is
    // logged in, so fetching the watch page from here — credentials included, no
    // tab, no playback — returns the source used by the actual player.
    //
    // Do not pick the first media URL from the full document. A Faphouse watch
    // page contains previews and preloaded manifests for related videos; those
    // are valid HLS playlists, but are not the selected feature. The main video
    // element and its view-state data are authoritative. The broad HLS search
    // below is deliberately only a compatibility fallback.
    //
    // A signed HLS source can carry a _TPL_ placeholder plus its renditions:
    //   .../media=hls4/multi=426x240:240,...,3840x2160:2160/Ll/<id>/format/_TPL_.mp4.m3u8
    // Substituting _TPL_ with the highest number in `multi=` yields the top
    // quality (verified: 2160 returns a valid VOD playlist, "master" 404s).
    const MANIFEST_RE = /https?:\/\/[^"'\\\s<>]+_TPL_[^"'\\\s<>]*\.m3u8/gi;
    const DIRECT_STREAM_RE = /https?:\/\/[^"'\\\s<>]+\.(?:m3u8|mp4)(?:\?[^"'\\\s<>]*)?/gi;
    const RESOLVE_CONCURRENCY = 3;

    function highestQualityFromManifest(manifestUrl) {
        const multi = manifestUrl.match(/multi=([^/]+)/i);
        if (!multi) return { url: manifestUrl.replace('_TPL_', '1080'), height: 1080 };
        const heights = (multi[1].match(/:(\d{3,4})/g) || [])
            .map((h) => parseInt(h.slice(1), 10))
            .filter((h) => h > 0);
        const best = heights.length ? Math.max(...heights) : 1080;
        return { url: manifestUrl.replace('_TPL_', String(best)), height: best };
    }

    function streamHeight(url) {
        const raw = String(url || '');
        // multi= lists AVAILABLE renditions; the filename is the SELECTED one.
        const selected = raw.match(/\/format\/(\d{3,4})(?:\.av1)?\.mp4(?:\.m3u8)?(?:[?#]|$)/i);
        if (selected) return Number(selected[1]);
        const multi = raw.match(/multi=([^/]+)/i);
        if (multi) {
            const heights = (multi[1].match(/:(\d{3,4})/g) || [])
                .map((h) => parseInt(h.slice(1), 10))
                .filter((h) => h > 0);
            if (heights.length) return Math.max(...heights);
        }
        const match = raw.match(/(?:^|[\/_.-])(2160|1440|1080|720|480|360|240)(?:p)?(?:[\/_.-]|\.mp4|\.m3u8|$)/i);
        return match ? parseInt(match[1], 10) : 0;
    }

    function formatBytes(bytes) {
        const value = Number(bytes || 0);
        if (!Number.isFinite(value) || value <= 0) return '';
        if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
        return `${(value / 1024 ** 2).toFixed(1)} MB`;
    }

    function streamSizeLabel(item) {
        const streamSize = formatBytes(item?.sizeBytes);
        if (streamSize) return `${item?.sizeEstimated ? 'Odhad streamu ≈' : 'Stream'} ${streamSize}`;

        // FapHouse exposes the source-file size directly on its cards.  Show
        // it while the optional HLS estimate is still running (or when that
        // CDN check is unavailable), but keep its origin explicit.
        const reportedSize = formatBytes(item?.reportedSizeBytes);
        if (reportedSize) return `Zdroj ${reportedSize}`;
        return item?.sizePending ? 'Veľkosť streamu…' : '';
    }

    function fetchedStreamLine(item) {
        return [item?.quality || 'stream', streamSizeLabel(item), item?.title || 'FapHouse video']
            .filter(Boolean)
            .join(' | ');
    }

    function formatAddedDate(value) {
        if (value == null || value === '') return '';
        const raw = String(value).trim();
        if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(raw)) return raw;
        const numeric = Number(raw);
        const date = Number.isFinite(numeric) && numeric > 0
            ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
            : new Date(raw);
        if (Number.isNaN(date.getTime())) return '';
        return new Intl.DateTimeFormat('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
    }

    // Fast path copied from Nexus Video Card Selector: the Faphouse grid often
    // already contains a file-size label, so show it before any HLS probing.
    function cardSizeBytes(card) {
        let largest = 0;
        const add = (value, unit) => {
            const number = Number(String(value).replace(',', '.'));
            if (!Number.isFinite(number) || number <= 0) return;
            largest = Math.max(largest, Math.round(number * (/^g/i.test(unit) ? 1024 ** 3 : 1024 ** 2)));
        };
        // FapHouse keeps the thumbnail and its file-size pill in separate
        // nested elements.  `data-el=Thumb` is intentionally used for stable
        // card discovery, but does not itself contain the pill, so include the
        // surrounding card when extracting the displayed source size.
        const scopes = [card, card?.closest?.('.t-m, [data-el="VideoCard"], .video-item')]
            .filter((node, index, list) => node && list.indexOf(node) === index);
        for (const scope of scopes) {
            for (const match of String(scope.textContent || '').matchAll(/\b(\d+(?:[.,]\d+)?)\s*(GB|GiB|MB|MiB)\b/gi)) add(match[1], match[2]);
            scope.querySelectorAll?.('[data-file-size], [data-size], [data-filesize]').forEach((el) => {
                const bytes = Number(el.getAttribute('data-file-size') || el.getAttribute('data-size') || el.getAttribute('data-filesize') || 0);
                if (Number.isFinite(bytes) && bytes > 0) largest = Math.max(largest, Math.round(bytes));
            });
        }
        return largest;
    }

    function cardAddedDate(card) {
        const time = card?.querySelector?.('time[datetime]');
        if (time) {
            const formatted = formatAddedDate(time.getAttribute('datetime') || time.textContent);
            if (formatted) return formatted;
        }
        for (const attr of ['data-time', 'data-added', 'data-date', 'data-published', 'data-upload-date']) {
            const el = card?.hasAttribute?.(attr) ? card : card?.querySelector?.(`[${attr}]`);
            const formatted = formatAddedDate(el?.getAttribute?.(attr));
            if (formatted) return formatted;
        }
        const text = String(card?.textContent || '');
        const match = text.match(/\b\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4}\b/)
            || text.match(/\b\d{4}-\d{2}-\d{2}\b/)
            || text.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/i);
        if (!match) return '';
        return /^\d{4}-\d{2}-\d{2}$/.test(match[0])
            ? formatAddedDate(match[0])
            : formatAddedDate(match[0].replace(/[/-]/g, '.'));
    }

    function faphouseAddedDate(video, html = '') {
        const keys = [
            'publishedAt', 'published_at', 'published', 'publishDate', 'publish_at', 'datePublished',
            'createdAt', 'created_at', 'created', 'createDate', 'addedAt',
            'uploadedAt', 'uploaded_at', 'uploadDate', 'videoPublishedAt', 'videoCreatedAt', 'date',
        ];
        for (const key of keys) {
            const formatted = formatAddedDate(video?.[key]);
            if (formatted) return formatted;
        }
        // The actual field has changed between Faphouse page builds. Search
        // nested JSON too, matching the resilient Video Card Selector logic.
        const seen = new Set();
        const stack = [video];
        while (stack.length && seen.size < 300) {
            const current = stack.pop();
            if (!current || typeof current !== 'object' || seen.has(current)) continue;
            seen.add(current);
            for (const [key, value] of Object.entries(current)) {
                if (/(?:date|published|uploaded|created|added)/i.test(key)) {
                    const formatted = formatAddedDate(value);
                    if (formatted) return formatted;
                }
                if (value && typeof value === 'object') stack.push(value);
            }
        }
        // Faphouse also renders this as visible page text (for example
        // "Published: 27.05.2026") instead of putting it in video JSON.
        const match = String(html).match(/(?:published|uploaded|added)\s*(?:on|:)?\s*(?:<[^>]*>\s*)?(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4})/i)
            || String(html).match(/(?:published|uploaded|added)\s*(?:on|:)?\s*(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4})/i);
        if (match?.[1]) return formatAddedDate(match[1].replace(/[/-]/g, '.'));
        return '';
    }

    const MAIN_VIDEO_RE = /<video[^>]*\bid=["']video-[^"']*["'][^>]*>[\s\S]*?<\/video>/i;
    const ANY_VIDEO_RE = /<video[^>]*>[\s\S]*?<\/video>/i;
    const PLAYER_MEDIA_RE = /(?:\bsrc|\bdata-fallback)=["']([^"']+\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/gi;
    const MEDIA_URL_RE = /^https?:\/\/[^\s"'<>]+\.(?:m3u8|mp4)(?:[?#][^\s"'<>]*)?$/i;

    function normaliseStreamUrl(raw) {
        return String(raw || '')
            .replace(/\\u0026/gi, '&')
            .replace(/&amp;/gi, '&')
            // Some FapHouse page builds HTML-escape the JSON quality map.
            // Decode its delimiters before matching URLs; otherwise the broad
            // fallback treats `240.mp4&quot;,...` as one long, invalid URL.
            .replace(/&quot;|&#34;|&#x22;/gi, '"')
            .replace(/&apos;|&#39;|&#x27;/gi, "'")
            .replace(/\\\//g, '/')
            .trim();
    }

    function mainPlayerMediaUrls(html) {
        const unescaped = normaliseStreamUrl(html);
        const player = MAIN_VIDEO_RE.exec(unescaped)?.[0] || ANY_VIDEO_RE.exec(unescaped)?.[0] || '';
        if (!player) return [];
        const urls = [];
        for (const match of player.matchAll(PLAYER_MEDIA_RE)) {
            const url = normaliseStreamUrl(match[1]);
            if (MEDIA_URL_RE.test(url)) urls.push(url);
        }
        return urls;
    }

    function mediaUrlsFromVideoState(video) {
        // The player shape differs between Faphouse deployments. Restrict this
        // walk to the current `video` state object; scanning the entire page JSON
        // would reintroduce related-video URLs into the export.
        const urls = [];
        const seen = new Set();
        const walk = (value, key = '') => {
            if (value == null || seen.has(value)) return;
            if (typeof value === 'string') {
                const url = normaliseStreamUrl(value);
                if (/(?:url|src|source|stream|file|manifest|hls|download)/i.test(key)
                    && MEDIA_URL_RE.test(url)) urls.push(url);
                return;
            }
            if (typeof value !== 'object') return;
            seen.add(value);
            for (const [childKey, childValue] of Object.entries(value)) walk(childValue, `${key}.${childKey}`);
        };
        walk(video);
        return urls;
    }

    function faphouseVideoId(url) {
        try {
            const parsed = new URL(url);
            if (!/(^|\.)faphouse\.com$/i.test(parsed.hostname)) return '';
            return parsed.pathname.match(/\/videos\/(?:[^/]*-)?([A-Za-z0-9]{5,})\/?$/)?.[1] || '';
        } catch { return ''; }
    }

    function findBestDirectStream(html, video = {}, pageUrl = '') {
        const expectedId = faphouseVideoId(pageUrl);
        const candidates = new Map();
        const add = (raw, origin = 0) => {
            const url = normaliseStreamUrl(raw);
            if (!url || /\/(?:trailer|preview|sample|teaser)\//i.test(url)) return;
            // Reject malformed values before URL() can normalize their HTML
            // entity tail into a seemingly valid, but unusable CDN URL.
            if (!MEDIA_URL_RE.test(url)) return;
            // Bind every candidate to this watch page, including page-wide JSON.
            // Never attach a recommendation's stream to the selected card title.
            try { if (expectedId && !new URL(url).pathname.split('/').includes(expectedId)) return; }
            catch { return; }
            let direct = url.includes('_TPL_') ? highestQualityFromManifest(url).url : url;
            // The player often starts at 240p. Select only a rendition explicitly
            // listed in this signed URL, without changing its asset ID/signature.
            if (/\/media=hls\d+\/multi=/i.test(direct)) {
                const best = highestQualityFromManifest(direct).height;
                direct = direct.replace(/(\/format\/)\d{3,4}((?:\.av1)?\.mp4\.m3u8)(?=[?#]|$)/i, (_, prefix, suffix) => `${prefix}${best}${suffix}`);
            }
            const isHls = /\.m3u8(?:[?#]|$)/i.test(direct);
            // Prefer the non-AV1 variant at the same resolution. Byte size alone
            // does not establish visual quality across different codecs.
            const isAv1 = /\.av1\.mp4/i.test(direct);
            const height = streamHeight(direct);
            const previous = candidates.get(direct);
            if (!previous || origin > previous.origin || (origin === previous.origin && height > previous.height)) {
                candidates.set(direct, { url: direct, height, isHls, isAv1, origin });
            }
        };

        // The actual <video> source wins even when a related-card playlist has
        // a larger nominal resolution. This is the URL that direct playback
        // and JDownloader must receive.
        for (const url of mainPlayerMediaUrls(html)) add(url, 3);
        for (const url of mediaUrlsFromVideoState(video)) add(url, 2);

        // Older Faphouse markup sometimes omits the source from both the player
        // element and the view state. Preserve the former broad parser for that
        // case, but never let it override a scoped current-video source.
        const decodedHtml = normaliseStreamUrl(html);
        for (const match of decodedHtml.matchAll(MANIFEST_RE)) add(match[0], 1);
        for (const match of decodedHtml.matchAll(DIRECT_STREAM_RE)) add(match[0], 1);

        // Within the same source scope prefer HLS, then resolution, then h264
        // over AV1. Source scope is intentionally the primary ordering.
        return Array.from(candidates.values())
            .sort((a, b) => (expectedId ? 0 : b.origin - a.origin)
                || b.height - a.height
                || Number(a.isAv1) - Number(b.isAv1)
                || Number(a.isHls) - Number(b.isHls)
                || b.origin - a.origin)[0] || null;
    }

    function parseWatchPage(html, pageUrl = '') {
        let viewState = {};
        const blob = html.match(/<script[^>]*id="view-state-data"[^>]*>([\s\S]*?)<\/script>/i);
        if (blob) { try { viewState = JSON.parse(blob[1].trim()); } catch {} }
        const video = viewState.video || {};

        // `videoViewAllowed` is Faphouse's own verdict on this session. Trust it:
        // when it is false the page carries only the trailer, and importing that
        // silently swaps a 2-minute teaser in for the feature.
        if (video.videoViewAllowed === false) {
            return { locked: true, reason: `bez prístupu (${video.videoAccessType || 'premium'})` };
        }

        const best = findBestDirectStream(html, video, pageUrl);
        if (!best) {
            const onlyTrailer = /\/trailer\/\d{3,4}\.mp4/i.test(html);
            return { locked: true, reason: onlyTrailer ? 'dostupný len trailer' : 'stream sa nenašiel' };
        }

        return {
            locked: false,
            streamUrl: best.url,
            height: best.height,
            quality: best.height ? `${best.height}p` : (best.isHls ? 'HLS' : 'MP4'),
            duration: Number(video.duration) || 0,
            addedDate: faphouseAddedDate(video, html),
        };
    }

    async function resolveCardStream(item) {
        try {
            const resp = await fetch(item.url, { credentials: 'include' });
            if (!resp.ok) return { locked: true, reason: `HTTP ${resp.status}` };
            return parseWatchPage(await resp.text(), item.url);
        } catch (e) {
            return { locked: true, reason: e?.message || 'fetch zlyhal' };
        }
    }

    // Resolve in a small pool: these are full watch pages (~800 KB each), so a
    // 40-card grid fired off at once would stall the tab and hammer the site.
    async function resolveMany(items, onProgress, { force = false } = {}) {
        const pending = items.filter((it) => force || (!it.direct_url && !it.resolveFailed));
        if (force) {
            pending.forEach((item) => {
                item.direct_url = null;
                item.resolveFailed = null;
                item.sizeBytes = 0;
                item.sizeStreamUrl = '';
            });
        }
        let done = 0;
        const queue = pending.slice();
        const workers = Array.from({ length: Math.min(RESOLVE_CONCURRENCY, queue.length) }, async () => {
            while (queue.length) {
                const item = queue.shift();
                const res = await resolveCardStream(item);
                if (res.locked) {
                    item.resolveFailed = res.reason;
                } else {
                    item.direct_url = res.streamUrl;
                    item.sizeBytes = 0;
                    item.sizeStreamUrl = '';
                    item.quality = res.quality;
                    if (res.duration) item.duration = res.duration;
                    if (res.addedDate) item.addedDate = res.addedDate;
                    item.resolveFailed = null;
                    // Direct URL + date become visible immediately. The HLS
                    // size calculation is intentionally queued separately;
                    // waiting for hundreds of segment HEAD requests used to
                    // leave every card blank until the very end of Fetch.
                    item.sizePending = true;
                    item.sizeError = '';
                    scheduleSizeProbe(item);
                }
                refreshItemPresentation(item);
                onProgress?.(++done, pending.length);
            }
        });
        await Promise.all(workers);
        return pending.length;
    }

    function updateWatchMetadata(item, status = '') {
        if (!isWatchPage()) return;
        const titleEl = document.getElementById('nexus-fh-watch-video-title');
        const metaEl = document.getElementById('nexus-fh-watch-video-meta');
        if (titleEl && item?.title) titleEl.textContent = item.title;
        if (!metaEl) return;
        const parts = [
            item?.quality || '',
            formatBytes(item?.sizeBytes),
            item?.addedDate || '',
            status,
        ].filter(Boolean);
        metaEl.textContent = parts.join(' · ') || 'Hľadám najvyššiu kvalitu…';
        metaEl.classList.toggle('is-error', !!item?.resolveFailed);
    }

    function refreshItemPresentation(item, status = '') {
        upsertCardUi(item);
        updateWatchMetadata(item, status);
        updateUi();
    }

    function watchPageItem() {
        const url = location.href.split('#')[0];
        const slug = location.pathname.replace(/\/+$/, '').split('/').pop() || url;
        const existing = state.items.get(slug);
        if (existing) return existing;
        const item = {
            id: slug,
            url,
            title: document.querySelector('h1')?.textContent?.trim() || document.title,
            thumbnail: document.querySelector('meta[property="og:image"]')?.content || '',
            duration: Math.round(document.querySelector('video')?.duration || 0) || 0,
            quality: '',
            sizeBytes: 0,
            addedDate: '',
            direct_url: null,
            selected: false,
            discoveryOrder: ++state.nextCardOrder,
            card: null,
        };
        state.items.set(item.id, item);
        return item;
    }

    function cardItemForPlayer(video) {
        if (isWatchPage()) return watchPageItem();
        const card = video.closest?.('[data-id][data-el-video], .t-m, [data-el="VideoCard"], .video-item') || video.parentElement;
        const discovered = collectCard(card);
        if (!discovered) return null;
        const existing = state.items.get(discovered.id);
        if (existing) {
            existing.card = discovered.card;
            existing.title = discovered.title || existing.title;
            return existing;
        }
        state.items.set(discovered.id, discovered);
        return discovered;
    }

    function setHighestQualityPlayerStream(video, item) {
        const streamUrl = String(item?.direct_url || '');
        if (!video || !streamUrl || video.dataset.nexusFhStreamUrl === streamUrl) return;
        const wasPlaying = !video.paused;
        const position = Number(video.currentTime || 0);

        const resume = () => {
            if (position > 0 && Number.isFinite(position)) {
                try { video.currentTime = position; } catch {}
            }
            if (wasPlaying) video.play().catch(() => {});
        };

        const HlsCtor = globalThis.Hls;
        const isHls = /\.m3u8(?:[?#]|$)/i.test(streamUrl);
        if (isHls && HlsCtor?.isSupported?.()) {
            try {
                video.dataset.nexusFhStreamUrl = streamUrl;
                video.__nexusFhHls?.destroy?.();
                const hls = new HlsCtor({
                    enableWorker: true,
                    startLevel: -1,
                    capLevelToPlayerSize: false,
                    maxBufferLength: 30,
                });
                video.__nexusFhHls = hls;
                hls.loadSource(streamUrl);
                hls.attachMedia(video);
                hls.on(HlsCtor.Events.MANIFEST_PARSED, () => {
                    // A master source may still expose several renditions. Pin
                    // the greatest height; the resolver's _TPL_ URL is already
                    // 2160p when Faphouse signed that rendition.
                    const levels = hls.levels || [];
                    const highest = levels.reduce((best, level, index) =>
                        Number(level?.height || 0) > Number(levels[best]?.height || 0) ? index : best, 0);
                    if (levels.length) {
                        hls.currentLevel = highest;
                        hls.nextLevel = highest;
                        hls.loadLevel = highest;
                    }
                    resume();
                });
                return;
            } catch (error) {
                updateWatchMetadata(item, `Player: ${error?.message || 'HLS sa nedá načítať'}`);
                return;
            }
        }

        if (isHls && video.canPlayType?.('application/vnd.apple.mpegurl')) {
            video.dataset.nexusFhStreamUrl = streamUrl;
            video.src = streamUrl;
            video.load();
            video.addEventListener('loadedmetadata', resume, { once: true });
            return;
        }
        if (!isHls) {
            video.dataset.nexusFhStreamUrl = streamUrl;
            video.src = streamUrl;
            video.load();
            video.addEventListener('loadedmetadata', resume, { once: true });
        }
    }

    async function hydrateOpenedPlayer(video) {
        const item = cardItemForPlayer(video);
        if (!item || item.playerHydrating) return;
        item.playerHydrating = true;
        updateWatchMetadata(item, 'Načítavam 2160p stream…');
        try {
            const result = item.direct_url ? null : await resolveCardStream(item);
            if (result?.locked) {
                item.resolveFailed = result.reason;
                refreshItemPresentation(item, result.reason);
                return;
            }
            if (result) {
                item.direct_url = result.streamUrl;
                item.quality = result.quality;
                item.duration = result.duration || item.duration;
                item.addedDate = result.addedDate || item.addedDate;
                item.resolveFailed = null;
            }
            if (!item.direct_url) return;
            item.sizePending = !item.sizeBytes;
            if (!item.sizeBytes) scheduleSizeProbe(item);
            setHighestQualityPlayerStream(video, item);
            refreshItemPresentation(item, item.sizeBytes ? '' : 'Rátam veľkosť súboru…');
        } finally {
            item.playerHydrating = false;
        }
    }

    function observeOpenedPlayers() {
        const onVideoOpened = (event) => {
            const video = event.target;
            if (video instanceof HTMLVideoElement) void hydrateOpenedPlayer(video);
        };
        document.addEventListener('play', onVideoOpened, true);
        document.addEventListener('loadedmetadata', onVideoOpened, true);
        if (isWatchPage()) {
            const initial = document.querySelector('video');
            if (initial) void hydrateOpenedPlayer(initial);
        }
    }

    function scheduleSizeProbe(item) {
        if (!item?.direct_url || item.sizeProbeQueued === item.direct_url) return;
        const streamUrl = item.direct_url;
        item.sizeProbeQueued = streamUrl;
        let finish;
        item.sizeProbePromise = new Promise(resolve => { finish = resolve; });
        state.sizeProbeQueue.push({ item, streamUrl, finish });
        void drainSizeProbeQueue();
    }

    async function drainSizeProbeQueue() {
        while (state.activeSizeProbes < SIZE_PROBE_CONCURRENCY && state.sizeProbeQueue.length) {
            const { item, streamUrl, finish } = state.sizeProbeQueue.shift();
            state.activeSizeProbes += 1;
            void (async () => {
                try {
                    const probe = await askBackground({
                        action: 'FAPHOUSE_PROBE_STREAM',
                        streamUrl,
                        referer: item.url,
                        expectedDuration: item.duration,
                    });
                    if (item.direct_url !== streamUrl) return;
                    if (probe?.durationMismatch) {
                        item.resolveFailed = 'Dĺžka streamu nesedí s vybraným videom. Export zastavený.';
                        item.direct_url = null;
                    } else if (!probe?.ok) {
                        // The stream itself was extracted from this logged-in
                        // page. A CDN probe may still be rejected when its
                        // referer policy changes; that only makes the optional
                        // size estimate unavailable, it does not disprove the
                        // signed URL. Keep it usable for Fetch/IDM/import.
                        item.sizeError = probe?.error || 'veľkosť sa nedala zistiť';
                    }
                    if (probe?.ok && Number(probe.sizeBytes || 0) > 0) {
                        item.sizeBytes = Number(probe.sizeBytes);
                        item.sizeStreamUrl = streamUrl;
                        item.sizeEstimated = !!probe.estimated;
                    } else {
                        item.sizeError = probe?.error || 'veľkosť sa nedala zistiť';
                    }
                } catch (error) {
                    if (item.direct_url === streamUrl) item.sizeError = error?.message || 'veľkosť sa nedala zistiť';
                } finally {
                    if (item.sizeProbeQueued === streamUrl) {
                        item.sizePending = false;
                        item.sizeProbeQueued = false;
                    }
                    finish();
                    refreshItemPresentation(item);
                    if (state.lastFetchedItems.includes(item)) renderFetchedStreams(state.lastFetchedItems);
                    state.activeSizeProbes -= 1;
                    void drainSizeProbeQueue();
                }
            })();
        }
    }

    // ── Expired-link refresh ─────────────────────────────────────────────────
    // The signed playlist a video was imported with dies after a few hours, and
    // the rows are stored as remote streams, so once it lapses the video stops
    // playing entirely. The dashboard can spot that (the deadline is inside the
    // URL) but cannot fix it — re-signing needs this logged-in session. So it
    // hands over the list and the work happens here, reusing the exact resolve
    // path the importer uses.
    function askBackground(message) {
        return new Promise((resolve) => {
            try {
                const runtime = globalThis.chrome?.runtime;
                if (!runtime?.id || !runtime?.sendMessage) {
                    resolve({ ok: false, error: 'rozšírenie bolo znovu načítané; obnov stránku' });
                    return;
                }
                runtime.sendMessage(message, (res) => {
                    let runtimeError = '';
                    try { runtimeError = runtime.lastError?.message || ''; } catch (_) {}
                    resolve(res || { ok: false, error: runtimeError || 'no response' });
                });
            } catch (error) {
                resolve({ ok: false, error: error?.message || 'background nie je dostupný' });
            }
        });
    }

    async function refreshExpiredLinks() {
        setBusy(true);
        toast('Hľadám expirované odkazy…');

        const listRes = await askBackground({ action: 'FAPHOUSE_STALE_LIST', source: 'faphouse', limit: 100 });
        if (!listRes.ok) {
            setBusy(false);
            toast(`Nepodarilo sa načítať zoznam: ${listRes.error}`, true);
            return;
        }

        const rows = (listRes.data?.videos || []).filter((r) => r.source_url);
        if (!rows.length) {
            setBusy(false);
            toast('Žiadne expirované odkazy — všetko je platné.');
            return;
        }

        let fixed = 0;
        const failures = [];
        const queue = rows.slice();
        let done = 0;

        const workers = Array.from({ length: Math.min(RESOLVE_CONCURRENCY, queue.length) }, async () => {
            while (queue.length) {
                const row = queue.shift();
                const res = await resolveCardStream({ url: row.source_url });
                done++;
                toast(`Obnovujem… ${done}/${rows.length}`);
                if (res.locked || !res.streamUrl) {
                    failures.push(res.reason || 'nevyriešené');
                    continue;
                }
                const push = await askBackground({
                    action: 'FAPHOUSE_PUSH_STREAM',
                    videoId: row.id,
                    streamUrl: res.streamUrl,
                    height: res.height || row.height || 0,
                });
                if (push.ok) fixed++;
                else failures.push(push.error || 'zápis zlyhal');
            }
        });
        await Promise.all(workers);

        setBusy(false);
        if (fixed && !failures.length) toast(`Obnovených ${fixed} odkazov.`);
        else if (fixed) toast(`Obnovených ${fixed}, ${failures.length} zlyhalo (${failures[0]})`, true);
        else toast(`Nepodarilo sa obnoviť nič (${failures[0] || 'neznámy dôvod'})`, true);
    }

    function scanCards() {
        // Ordered by specificity, NOT by node count.  The generic
        // `div:has(> a[href*="/videos/"])` matches more nodes than the real
        // card (title wrappers, nav, tag links), and the last match for a video
        // used to win — a 20x20 avatar box.  Its rectangle then failed the
        // visibility test, so every selector was rendered with display:none.
        let foundNodes = listingCards(document);

        if (!foundNodes.length) {
            try {
                foundNodes = Array.from(document.querySelectorAll('div:has(> a[href*="/videos/"])'))
                    .filter((n) => n.querySelector('img'));
            } catch {}
        }

        if (!foundNodes.length) {
            foundNodes = Array.from(document.querySelectorAll('a[href*="/videos/"]:has(img)'));
        }

        for (const node of foundNodes) {
            const item = collectCard(node);
            if (!item || !item.url) continue;

            const existing = state.items.get(item.id);
            if (existing) {
                existing.card = item.card;
                existing.thumbnail = item.thumbnail || existing.thumbnail;
                existing.title = item.title || existing.title;
                existing.duration = item.duration || existing.duration;
                existing.sizeBytes = existing.sizeBytes || item.sizeBytes;
                existing.reportedSizeBytes = item.reportedSizeBytes || existing.reportedSizeBytes;
                existing.addedDate = existing.addedDate || item.addedDate;
                upsertCardUi(existing);
            } else {
                state.items.set(item.id, item);
                upsertCardUi(item);
            }
        }

        updateUi();
    }

    function upsertCardUi(item) {
        if (!item?.card || !item.card.isConnected) return;

        // Always own the overlay positioning context.  The thumbnail link
        // beneath a Faphouse card is recreated by React and may clip or hide
        // children appended to it; controls therefore live on the scanned
        // card root, never inside that link/image wrapper.
        item.card.style.setProperty('position', 'relative', 'important');
        item.card.style.setProperty('overflow', 'visible', 'important');
        item.card.style.setProperty('isolation', 'isolate', 'important');

        if (!item.card.dataset.nexusFhClick) {
            item.card.dataset.nexusFhClick = "1";
            const thumbLink = item.card.matches('a[href*="/videos/"]') ? item.card : (item.card.querySelector('a.t-vl[href*="/videos/"]') || item.card.querySelector('a[href*="/videos/"]'));
            if (thumbLink) {
                const toggle = (e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    if (e.type === 'click') {
                        item.selected = !item.selected;
                        item.card.classList.toggle(SELECTED_CLASS, item.selected);
                        upsertCardUi(item);
                        updateUi();
                    }
                };
                thumbLink.addEventListener('click', toggle, true);
                thumbLink.addEventListener('mousedown', toggle, true);
                thumbLink.addEventListener('mouseup', toggle, true);
            }
        }

        item.card.classList.toggle(SELECTED_CLASS, !!item.selected);

        // Controls are real children of the card root (position:absolute),
        // never a viewport-fixed portal. A fixed-position layer stops tracking
        // the page the instant any ancestor gets a CSS transform during
        // scroll (FapHouse applies one to its scroll container) — every badge
        // then drifts as one rigid sheet and only snaps back once the
        // transform resets. An absolute child has no such dependency: it
        // scrolls exactly as fast as the card underneath it, natively.
        // Faphouse still replaces the *inner* thumbnail/link subtree and can
        // clip it; that's why item.card (the scanned root, forced to
        // overflow:visible + isolate above) is the anchor, never a nested
        // wrapper that gets torn down.
        const overlayHost = item.card;
        const isVisible = true;

        // Keep one overlay per canonical watch URL, even when Faphouse changes
        // the nested React card that our scanner sees on a later pass.
        const itemId = String(item.id);
        document.querySelectorAll(`.${CHECK_CLASS}[data-nexus-fh-id]`).forEach((node) => {
            if (node.dataset.nexusFhId === itemId && node.parentElement !== overlayHost) node.remove();
        });
        document.querySelectorAll('.nexus-fh-card-meta[data-nexus-fh-id]').forEach((node) => {
            if (node.dataset.nexusFhId === itemId && node.parentElement !== overlayHost) node.remove();
        });

        let check = Array.from(overlayHost.children).find((node) => node.classList?.contains(CHECK_CLASS) && node.dataset.nexusFhId === itemId);
        // Faphouse's card stylesheet can hide labels and checkbox inputs. Use
        // a real button instead; the old label is replaced on the first scan.
        if (!check || check.tagName !== 'BUTTON') {
            check?.remove();
            check = document.createElement('button');
            check.type = 'button';
            check.className = CHECK_CLASS;
            check.dataset.nexusFhId = itemId;
            check.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                item.selected = !item.selected;
                item.card.classList.toggle(SELECTED_CLASS, item.selected);
                upsertCardUi(item);
                updateUi();
            });
            overlayHost.appendChild(check);
        }
        check.dataset.nexusFhId = itemId;
        check.textContent = item.selected ? '✓' : '';
        check.setAttribute('aria-label', item.selected ? 'Zrušiť výber videa' : 'Vybrať video');
        check.setAttribute('aria-pressed', String(!!item.selected));
        // Faphouse has broad card-label CSS. Keep the selector independent of
        // it, in the requested top-left corner of the thumbnail.
        check.style.setProperty('position', 'absolute', 'important');
        check.style.setProperty('display', isVisible ? 'inline-flex' : 'none', 'important');
        check.style.setProperty('align-items', 'center', 'important');
        check.style.setProperty('justify-content', 'center', 'important');
        check.style.setProperty('top', '8px', 'important');
        check.style.setProperty('left', '8px', 'important');
        check.style.setProperty('width', '36px', 'important');
        check.style.setProperty('height', '36px', 'important');
        check.style.setProperty('z-index', '1', 'important');
        check.style.setProperty('padding', '0', 'important');
        check.style.setProperty('margin', '0', 'important');
        check.style.setProperty('border', item.selected ? '2px solid #f59e0b' : '2px solid rgba(255,255,255,.78)', 'important');
        check.style.setProperty('border-radius', '8px', 'important');
        check.style.setProperty('background', item.selected ? 'linear-gradient(135deg,#f59e0b,#a855f7)' : 'rgba(5,7,10,.82)', 'important');
        check.style.setProperty('color', '#fff', 'important');
        check.style.setProperty('font', '900 20px/1 system-ui,sans-serif', 'important');
        check.style.setProperty('cursor', 'pointer', 'important');
        check.style.setProperty('visibility', 'visible', 'important');
        check.style.setProperty('opacity', '1', 'important');
        check.style.setProperty('pointer-events', 'auto', 'important');
        check.style.setProperty('box-sizing', 'border-box', 'important');
        check.style.setProperty('transform', 'none', 'important');

        let meta = Array.from(overlayHost.children).find((node) => node.classList?.contains('nexus-fh-card-meta') && node.dataset.nexusFhId === itemId);
        const size = streamSizeLabel(item);
        const sizeState = !size && item.sizeError ? 'Veľkosť —' : '';
        if (!meta && (size || item.addedDate || sizeState)) {
            meta = document.createElement('div');
            meta.className = 'nexus-fh-card-meta';
            meta.dataset.nexusFhId = itemId;
            overlayHost.appendChild(meta);
        }
        if (meta) {
            meta.style.setProperty('position', 'absolute', 'important');
            meta.style.setProperty('display', isVisible ? 'flex' : 'none', 'important');
            meta.style.setProperty('left', '8px', 'important');
            meta.style.setProperty('top', 'auto', 'important');
            meta.style.setProperty('bottom', '8px', 'important');
            meta.style.setProperty('z-index', '1', 'important');
            meta.style.setProperty('font-size', '13px', 'important');
            meta.innerHTML = `${item.quality ? `<span class="nexus-fh-card-quality">${item.quality}</span>` : ''}${size ? `<span class="nexus-fh-card-size">${size}</span>` : ''}${sizeState ? `<span class="nexus-fh-card-size nexus-fh-card-size-pending" title="${item.sizeError || 'Počítam veľkosť najvyššej kvality'}">${sizeState}</span>` : ''}${item.addedDate ? `<span class="nexus-fh-card-date">${item.addedDate}</span>` : ''}`;
            meta.querySelectorAll('span').forEach((badge) => {
                badge.style.setProperty('display', 'inline-block', 'important');
                badge.style.setProperty('padding', '5px 9px', 'important');
                badge.style.setProperty('background', 'rgba(5, 7, 10, 0.88)', 'important');
                badge.style.setProperty('border', '1px solid rgba(255,255,255,.28)', 'important');
                badge.style.setProperty('border-radius', '5px', 'important');
            });
            meta.hidden = !size && !item.addedDate && !sizeState;
        }
    }

    function selectedItems() {
        return Array.from(state.items.values()).filter((i) => i.selected && i.card?.isConnected);
    }

    function visibleItems() {
        return filterOnlyItems(Array.from(state.items.values()).filter((i) => i.card?.isConnected));
    }

    function normalizeFilterText(value) {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLocaleLowerCase();
    }

    function addedDateValue(value) {
        const raw = String(value || '').trim();
        const localized = raw.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
        if (localized) return Date.UTC(Number(localized[3]), Number(localized[2]) - 1, Number(localized[1]));
        const parsed = Date.parse(raw);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function qualityValue(value) {
        const match = String(value || '').match(/(2160|1440|1080|720|480|360|240)\s*p?/i);
        return match ? Number(match[1]) : 0;
    }

    function itemMatchesFilter(item) {
        const tokens = normalizeFilterText(state.filter.query).trim().split(/\s+/).filter(Boolean);
        if (!tokens.length) return true;
        const haystack = normalizeFilterText([
            item.title,
            item.quality,
            item.addedDate,
            formatBytes(item.sizeBytes),
            item.url,
        ].join(' '));
        return tokens.every((token) => haystack.includes(token));
    }

    function filterOnlyItems(items) {
        return state.filter.onlyMatches ? items.filter(itemMatchesFilter) : items;
    }

    function applyCardFilter() {
        const items = Array.from(state.items.values()).filter((item) => item.card?.isConnected);
        const matched = items.filter(itemMatchesFilter);
        const sort = state.filter.sort;
        const sorted = [...items].sort((a, b) => {
            const fallback = Number(a.discoveryOrder || 0) - Number(b.discoveryOrder || 0);
            if (sort === 'size-desc') return Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0) || fallback;
            if (sort === 'size-asc') return Number(a.sizeBytes || 0) - Number(b.sizeBytes || 0) || fallback;
            if (sort === 'date-desc') return addedDateValue(b.addedDate) - addedDateValue(a.addedDate) || fallback;
            if (sort === 'date-asc') return addedDateValue(a.addedDate) - addedDateValue(b.addedDate) || fallback;
            if (sort === 'quality-desc') return qualityValue(b.quality) - qualityValue(a.quality) || fallback;
            if (sort === 'quality-asc') return qualityValue(a.quality) - qualityValue(b.quality) || fallback;
            return fallback;
        });

        const onlyMatches = state.filter.onlyMatches && !!state.filter.query.trim();
        const rank = new Map(sorted.map((item, index) => [item.id, index + 1]));
        for (const item of items) {
            const isMatch = itemMatchesFilter(item);
            item.card.classList.toggle('nexus-fh-filter-hidden', onlyMatches && !isMatch);
            if (sort === 'site') item.card.style.removeProperty('order');
            else item.card.style.setProperty('order', String(rank.get(item.id) || 99999), 'important');
            upsertCardUi(item);
        }
        return { total: items.length, matched: matched.length, hidden: onlyMatches ? items.length - matched.length : 0 };
    }

    function updateUi() {
        const bar = document.getElementById(TOOLBAR_ID);
        const bubble = document.getElementById(BUBBLE_ID);

        const filterStats = applyCardFilter();
        const selCount = selectedItems().length;
        const visCount = visibleItems().length;

        if (bar) {
            const stats = bar.querySelector('.nexus-fh-stats');
            if (stats) {
                const filterSuffix = state.filter.query.trim()
                    ? ` · ${filterStats.matched} zhôd${filterStats.hidden ? `, ${filterStats.hidden} skrytých` : ''}`
                    : '';
                stats.textContent = `${selCount} vybraných / ${visCount} na stránke${filterSuffix}`;
            }
            const importSel = bar.querySelector('[data-role="import-selected"]');
            if (importSel) importSel.disabled = selCount === 0 || state.busy;
            const importVis = bar.querySelector('[data-role="import-visible"]');
            if (importVis) {
                importVis.disabled = visCount === 0 || state.busy;
                importVis.textContent = state.filter.onlyMatches && state.filter.query.trim()
                    ? `Importovať filtrované (${visCount})`
                    : 'Importovať všetko';
            }
            const filterCount = bar.querySelector('[data-role="filter-count"]');
            if (filterCount) {
                filterCount.textContent = state.filter.query.trim()
                    ? `${filterStats.matched} zhôd${filterStats.hidden ? ` · ${filterStats.hidden} skrytých` : ''}`
                    : 'Filter je pripravený po Fetch';
            }
            const fetchSel = bar.querySelector('[data-role="fetch-selected"]');
            if (fetchSel) fetchSel.disabled = selCount === 0 || state.busy;
            const loadNext = bar.querySelector('[data-role="load-next"]');
            if (loadNext) {
                loadNext.disabled = state.busy || state.isLoadingPages || isWatchPage();
                loadNext.textContent = state.isLoadingPages ? '⏳ Načítavam…' : 'Load Next';
            }
            const pageStatus = bar.querySelector('[data-role="page-status"]');
            if (pageStatus && !state.isLoadingPages) {
                const next = state.nextPage || currentListingPage() + 1;
                pageStatus.textContent = isWatchPage() ? 'Dostupné v zozname videí.' : `Ďalšia strana: ${next}`;
            }
            const sidecarSel = bar.querySelector('[data-role="sidecar-selected"]');
            if (sidecarSel) {
                const readyCount = selectedItems().filter((item) => item.direct_url).length;
                sidecarSel.disabled = readyCount === 0 || state.busy;
                sidecarSel.textContent = readyCount ? `▶ Sidecar playlist (${readyCount})` : '▶ Sidecar playlist';
            }
            const idmSel = bar.querySelector('[data-role="idm-selected"]');
            if (idmSel) {
                const readyCount = selectedItems().filter((item) => item.direct_url).length;
                idmSel.disabled = readyCount === 0 || state.busy;
                idmSel.textContent = readyCount ? `⇩ Download IDM (${readyCount})` : '⇩ Download IDM';
            }
            const jdSel = bar.querySelector('[data-role="jdownloader-selected"]');
            if (jdSel) {
                const readyCount = selectedItems().filter((item) => item.direct_url).length;
                jdSel.disabled = readyCount === 0 || state.busy;
                jdSel.textContent = readyCount ? `⇩ Send to JDownloader (${readyCount})` : '⇩ Send to JDownloader';
            }

            // Show/hide watch-page import row
            const watchRow = bar.querySelector('#nexus-fh-watch-import-row');
            if (watchRow) {
                if (isWatchPage()) {
                    watchRow.classList.remove('nexus-hidden');
                    const titleEl = bar.querySelector('#nexus-fh-watch-video-title');
                    if (titleEl && !titleEl.textContent) {
                        const h1 = document.querySelector('h1');
                        if (h1) titleEl.textContent = h1.textContent.trim();
                    }
                } else {
                    watchRow.classList.add('nexus-hidden');
                }
            }
        }

        if (bubble) {
            const badge = bubble.querySelector('.nexus-fh-bubble-badge');
            if (badge) {
                badge.textContent = String(selCount);
                badge.classList.toggle('visible', selCount > 0);
            }
        }
    }

    function setBusy(busy) {
        state.busy = !!busy;
        updateUi();
    }

    function renderFetchedStreams(items) {
        const field = document.getElementById('nexus-fh-direct-streams');
        const status = document.getElementById('nexus-fh-fetch-status');
        if (!field) return;

        const ready = items.filter((item) => item.direct_url);
        field.value = ready.map((item) => `${fetchedStreamLine(item)}\n${item.direct_url}`).join('\n\n');
        if (status) {
            status.textContent = ready.length
                ? `${ready.length}/${items.length} direct streamov pripravených (najvyššia kvalita)`
                : `Nenašiel sa žiadny dostupný direct stream z ${items.length} vybraných`;
        }
    }

    async function fetchSelectedStreams() {
        const items = selectedItems();
        if (!items.length) return;

        setBusy(true);
        const button = document.querySelector(`#${TOOLBAR_ID} [data-role="fetch-selected"]`);
        if (button) button.textContent = '⏳ Fetching…';
        await resolveMany(items, (done, total) => {
            toast(`Zisťujem direct streamy… ${done}/${total}`);
        }, { force: true });
        // HLS size estimation samples up to nine segments per item.  Do not
        // block the entire 60-card batch on that optional work: render URLs
        // and the card-reported size now, then refresh each line as its stream
        // estimate arrives from the background queue.
        state.lastFetchedItems = items;
        renderFetchedStreams(items);
        setBusy(false);
        if (button) button.textContent = 'Fetch selected';

        const ready = items.filter((item) => item.direct_url);
        if (ready.length) {
            toast(`Pripravených ${ready.length}/${items.length} direct streamov v najvyššej kvalite`);
        } else {
            toast(`Streamy sa nepodarilo získať (${items[0]?.resolveFailed || 'bez prístupu'})`, true);
        }
    }

    function enqueueInSidecar(items) {
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                window.removeEventListener('message', receive);
                resolve({ ok: false, error: 'Vertical Video Sidecar nie je na tejto stránke aktívny' });
            }, 5000);
            const receive = (event) => {
                if (event.source !== window || event.origin !== location.origin) return;
                const message = event.data;
                if (message?.type !== 'NEXUS_SIDECAR_RESULT' || message.requestId !== requestId) return;
                clearTimeout(timeout);
                window.removeEventListener('message', receive);
                resolve(message.result || { ok: false, error: 'Sidecar nevrátil výsledok' });
            };
            window.addEventListener('message', receive);
            window.postMessage({
                type: 'NEXUS_SIDECAR_ENQUEUE',
                requestId,
                playNow: false,
                items: items.map((item) => ({
                    streamUrl: item.direct_url,
                    title: item.title,
                    pageUrl: item.url,
                    sourceUrl: item.url,
                    poster: item.thumbnail,
                    quality: item.quality,
                    duration: item.duration,
                    typeHint: /\.m3u8(?:[?#]|$)/i.test(item.direct_url || '') ? 'hls' : 'file',
                })),
            }, location.origin);
        });
    }

    async function sendSelectedToSidecar() {
        const selected = selectedItems();
        const ready = selected.filter((item) => item.direct_url);
        if (!ready.length) {
            toast('Najprv klikni Fetch selected, aby Sidecar dostal direct streamy.', true);
            return;
        }

        setBusy(true);
        const button = document.querySelector(`#${TOOLBAR_ID} [data-role="sidecar-selected"]`);
        if (button) button.textContent = '⏳ Sidecar…';
        const result = await enqueueInSidecar(ready);
        setBusy(false);
        updateUi();

        if (!result?.ok) {
            toast(`Sidecar: ${result?.error || 'odoslanie zlyhalo'}`, true);
            return;
        }
        const added = Number(result.added || 0);
        const duplicates = Number(result.duplicates || 0);
        const skipped = selected.length - ready.length;
        const details = [
            `${added} pridaných`,
            duplicates ? `${duplicates} už bolo v playliste` : '',
            skipped ? `${skipped} bez streamu` : '',
        ].filter(Boolean).join(', ');
        toast(`Sidecar playlist: ${details}`);
    }

    function sendSelectedToIdm() {
        const ready = selectedItems().filter((item) => item.direct_url);
        if (!ready.length) {
            toast('Najprv klikni Fetch selected, aby IDM dostal priame streamy.', true);
            return;
        }

        setBusy(true);
        const button = document.querySelector(`#${TOOLBAR_ID} [data-role="idm-selected"]`);
        if (button) button.textContent = '⏳ Otváram IDM…';
        void askBackground({
            action: 'DOWNLOAD_WITH_IDM_BATCH',
            items: ready.map((item) => ({ url: item.direct_url, filename: item.title })),
        }).then((result) => {
            setBusy(false);
            updateUi();
            if (!result?.ok) {
                toast(`IDM: ${result?.error || 'nepodarilo sa odovzdať odkazy'}`, true);
                return;
            }
            const queued = Number(result.queued || 0);
            const skipped = Number(result.skipped || 0);
            toast(`IDM: odovzdaných ${queued} priamych streamov${skipped ? `, ${skipped} preskočených` : ''}.`);
        });
    }

    function buildJDownloaderCrawljobs(items) {
        const pageHeading = (document.querySelector('h1')?.textContent || 'Faphouse').replace(/[\\/:*?"<>|]+/g, '_').trim();
        return items.map((item) => {
            const cleanTitle = String(item.title || 'Faphouse Video').replace(/[\\/:*?"<>|]+/g, '_').trim();
            const qualityStr = item.quality ? ` [${item.quality}]` : '';
            const sizeLabel = streamSizeLabel(item);
            const sizeStr = sizeLabel ? ` | ${sizeLabel}` : '';
            const dateStr = item.addedDate ? ` | Dátum: ${item.addedDate}` : '';
            const durationStr = item.duration ? ` | Trvanie: ${Math.floor(item.duration / 60)}:${String(item.duration % 60).padStart(2, '0')}` : '';
            const fileName = `${cleanTitle}${qualityStr}.mp4`;

            return {
                text: item.direct_url,
                packageName: cleanTitle,
                filename: fileName,
                forcedFileName: fileName,
                comment: `Názov: ${item.title || cleanTitle}${qualityStr}${sizeStr}${durationStr}${dateStr} | Zdroj: ${item.url}`,
                sourceUrl: item.url,
                downloadFolder: pageHeading || cleanTitle,
                autoConfirm: true,
                autoStart: false,
                overwritePackagizerEnabled: true
            };
        });
    }

    function faphouseJDownloaderProxyUrl(base, streamUrl, filename = '') {
        const proxyBase = String(base || '').replace(/\/$/, '');
        const isHls = /\.m3u8(?:[?#]|$)/i.test(streamUrl || '');
        const endpoint = isHls
            ? 'hls_proxy.m3u8'
            : 'media_proxy.mp4';
        const nameParam = !isHls && filename ? `&filename=${encodeURIComponent(filename)}` : '';
        return `${proxyBase}/${endpoint}?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent('https://faphouse.com/')}${nameParam}`;
    }

    async function buildJDownloaderDelivery(items) {
        const proxy = await askBackground({ action: 'FAPHOUSE_JD_PROXY_BASE' });
        if (!proxy?.ok || !proxy.base) {
            throw new Error(proxy?.error || 'Nexus HLS proxy nie je dostupný');
        }
        return {
            base: proxy.base,
            urls: items.map((item) => {
                const cleanTitle = String(item.title || 'Faphouse Video').replace(/[\\/:*?"<>|]+/g, '_').trim();
                const quality = item.quality ? ` [${item.quality}]` : '';
                return faphouseJDownloaderProxyUrl(proxy.base, item.direct_url, `${cleanTitle}${quality}.mp4`);
            }),
        };
    }

    function downloadCrawljobFile(jobs, baseName) {
        const jsonContent = JSON.stringify(jobs, null, 2);
        const blob = new Blob([jsonContent], { type: 'application/json' });
        const downloadUrl = URL.createObjectURL(blob);
        const cleanName = (baseName || 'faphouse_export').replace(/[\\/:*?"<>|]+/g, '_').trim();
        const crawlFileName = `${cleanName}.crawljob`;

        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = crawlFileName;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            a.remove();
            URL.revokeObjectURL(downloadUrl);
        }, 1500);

        return crawlFileName;
    }

    async function sendSelectedToJDownloader({ downloadOnly = false } = {}) {
        if (state.busy) return;
        setBusy(true);
        const selected = selectedItems();
        await resolveMany(selected, null, { force: true });
        state.lastFetchedItems = selected;
        renderFetchedStreams(selected);
        const ready = selected.filter((item) => item.direct_url);
        if (!ready.length) {
            setBusy(false);
            toast(selected[0]?.resolveFailed || 'Najprv označ videá pre export.', true);
            return;
        }

        setBusy(true);
        const button = document.querySelector(`#${TOOLBAR_ID} [data-role="jdownloader-selected"]`);
        if (button) button.textContent = '⏳ Pripravujem JDownloader…';

        const pageHeading = (document.querySelector('h1')?.textContent || 'Faphouse').replace(/[\\/:*?"<>|]+/g, '_').trim();
        const dateTag = new Date().toISOString().slice(0, 10);
        let delivery;
        try {
            delivery = await buildJDownloaderDelivery(ready);
        } catch (error) {
            setBusy(false);
            updateUi();
            toast(`JDownloader: ${error?.message || 'Nexus HLS proxy nie je dostupný'}`, true);
            return;
        }
        // Skusame najprv lokalne FlashGot API JDownloaderu. Ak prejde, .crawljob
        // subor ani schranku uz NEPOUZIVAME - JD by tie iste odkazy dostal druhykrat,
        // zahodil by ich ako duplikaty a na crawljob by zahlasil "Invalid container".
        let apiOk = false;
        try {
            const urls = delivery.urls.join('\n');

            const fnames = ready.map((it) => {
                const cleanTitle = String(it.title || 'Video').replace(/[\\/:*?"<>|]+/g, '_').trim();
                const q = it.quality ? ` [${it.quality}]` : '';
                return `${cleanTitle}${q}.mp4`;
            }).join('\n');

            const descriptions = ready.map((it) => {
                const cleanTitle = (it.title || 'Video').replace(/[\\/:*?"<>|]+/g, '_').trim();
                const q = it.quality ? ` [${it.quality}]` : '';
                const sizeLabel = streamSizeLabel(it);
                const size = sizeLabel ? ` | ${sizeLabel}` : '';
                return `${cleanTitle}${q}${size} | Zdroj: ${it.url}`;
            }).join('\n');

            const params = new URLSearchParams();
            params.append('urls', urls);
            params.append('fnames', fnames);
            params.append('filenames', fnames);
            params.append('descriptions', descriptions);
            params.append('package', pageHeading || 'Nexus Faphouse');
            // FlashGot's `referer` parameter becomes the actual HTTP Referer
            // in JDownloader. `source` is only metadata and leaves FapHouse's
            // hotlink-protected CDN links offline.
            params.append('referer', 'https://faphouse.com/');

            const res = downloadOnly ? null : await fetch('http://127.0.0.1:9666/flashgot', {
                method: 'POST',
                body: params,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            }).catch(() => null);

            if (res && res.ok) apiOk = true;
        } catch (_) {}

        // Fallback, ked JDownloader nebezi alebo ma vypnute lokalne API:
        // .crawljob subor s kompletnými metadátami a refererom. Nekopírujeme
        // čisté URL do schránky — JD Clipboard Watcher by vytvoril druhú,
        // nepomenovanú a nefunkčnú sadu odkazov.
        let fileName = '';
        if (!apiOk) {
            const jobs = buildJDownloaderCrawljobs(ready);
            jobs.forEach((job, index) => { job.text = delivery.urls[index] || job.text; });
            fileName = downloadCrawljobFile(jobs, `${pageHeading}_${ready.length}videi_${dateTag}`);
        }

        setBusy(false);
        updateUi();

        if (apiOk) {
            toast(`✓ JDownloader: ${ready.length} videí odoslaných cez Nexus HLS proxy`);
        } else {
            toast(`Stiahnutý ${fileName} (${ready.length}/${selected.length} videí) — vlož do folderwatch`);
        }
    }

    function setMinimized(minimized) {
        state.minimized = !!minimized;
        try {
            localStorage.setItem(STORAGE_MIN_KEY, String(state.minimized));
        } catch {}

        const bar = document.getElementById(TOOLBAR_ID);
        const bubble = document.getElementById(BUBBLE_ID);

        if (state.minimized) {
            if (bar) bar.classList.add('nexus-hidden');
            if (bubble) {
                bubble.classList.remove('nexus-hidden');
                if (state.position) applyPosition(bubble, state.position);
            }
        } else {
            if (bubble) bubble.classList.add('nexus-hidden');
            if (bar) {
                bar.classList.remove('nexus-hidden');
                if (state.position) applyPosition(bar, state.position);
            }
        }
    }

    async function importItems(items) {
        if (!items.length) return;

        // Resolve first, always. Sending the watch-page URL and letting the
        // dashboard figure it out is what used to happen, and it cannot work:
        // the server is a signed-out session there. Only this tab can see the
        // real stream, so a card that fails to resolve here is dropped rather
        // than queued as a link the importer will choke on.
        setBusy(true);
        const attempted = await resolveMany(items, (done, total) => {
            toast(`Zisťujem streamy… ${done}/${total}`);
        });

        const ready = items.filter((it) => it.direct_url);
        const failed = items.filter((it) => !it.direct_url);
        if (failed.length) {
            const why = failed[0].resolveFailed || 'neznámy dôvod';
            toast(`${failed.length} z ${items.length} sa nepodarilo (${why})`, true);
        }
        if (!ready.length) {
            setBusy(false);
            return;
        }

        const payload = ready.map(({ id, url, title, thumbnail, duration, quality, direct_url }) => ({
            id,
            url,
            title,
            thumbnail,
            duration,
            quality,
            direct_url,
            source_url: url,
        }));

        if (attempted) toast(`Streamy pripravené — odosielam ${payload.length} videí…`);
        else toast(`Odosielam ${payload.length} videí do Nexus Vaultu...`);

        void askBackground({
            action: 'FAPHOUSE_IMPORT_BULK',
            batchName: 'Faphouse Import',
            items: payload,
        }).then((res) => {
            setBusy(false);
            if (!res?.ok) {
                toast(`Chyba importu: ${res?.error || 'Neznáma chyba'}`, true);
                return;
            }
            toast(`Úspešne pridané do frontu: ${res.data?.count || payload.length} videí!`);
            // Only the imported ones get deselected — anything that failed to
            // resolve stays selected and visibly marked, so it can be retried
            // instead of quietly vanishing from the selection.
            ready.forEach((item) => {
                item.selected = false;
                upsertCardUi(item);
            });
            updateUi();
        });
    }

    function createWidgets() {
        if (document.getElementById(TOOLBAR_ID)) return;

        // 1. Create Main Toolbar
        const bar = document.createElement('div');
        bar.id = TOOLBAR_ID;
        bar.className = 'nexus-fh-toolbar';
        bar.innerHTML = `
            <div class="nexus-fh-header">
                <div class="nexus-fh-header-left">
                    <span class="nexus-fh-drag-icon" title="Potiahnutím presuniete">⠿</span>
                    <span class="nexus-fh-title">⚡ Nexus Faphouse</span>
                    <span class="nexus-fh-badge">Live</span>
                </div>
                <div class="nexus-fh-header-actions">
                    <button class="nexus-fh-min-btn" data-role="minimize" title="Zbaliť do plávajúcej ikonky">─</button>
                </div>
            </div>
            <div class="nexus-fh-watch-import-row nexus-hidden" id="nexus-fh-watch-import-row">
                <div class="nexus-fh-watch-video-info">
                    <div class="nexus-fh-watch-video-title" id="nexus-fh-watch-video-title"></div>
                    <div class="nexus-fh-watch-video-meta" id="nexus-fh-watch-video-meta">Hľadám najvyššiu kvalitu…</div>
                </div>
                <div class="nexus-fh-watch-import-buttons">
                    <button class="nexus-fh-watch-import-main" id="nexus-fh-watch-import-main">
                        ⚡ Importovať toto video
                    </button>
                    <button class="nexus-fh-watch-sidecar-btn" id="nexus-fh-watch-sidecar-btn" title="Pošle najvyššiu kvalitu priamo do Vertical Video Sidecar (bez automatického prehrávania)">
                        ▶ Sidecar
                    </button>
                </div>
            </div>
            <div class="nexus-fh-stats">0 vybraných / 0 na stránke</div>
            <div class="nexus-fh-actions">
                <button data-role="refresh">Obnoviť</button>
                <button data-role="refresh-expired" title="Znovu podpíše odkazy, ktorým vypršala platnosť">♻ Expirované</button>
                <button data-role="select-visible">Označiť všetky</button>
                <button data-role="clear">Zrušiť výber</button>
                <button data-role="fetch-selected" class="primary" disabled>Fetch selected</button>
                <button data-role="sidecar-selected" disabled title="Po Fetch selected pridá direct streamy do trvalého Sidecar playlistu">▶ Sidecar playlist</button>
                <button data-role="idm-selected" disabled title="Otvorí IDM Integration Module pre priame Fetch streamy">⇩ Download IDM</button>
                <button data-role="jdownloader-selected" disabled title="Odošle do JDownloaderu / stiahne .crawljob balíček s názvami, veľkosťou a zdrojom">⇩ Send to JDownloader</button>
                <button data-role="import-selected" class="primary" disabled>Importovať vybrané</button>
                <button data-role="import-visible" class="primary">Importovať všetko</button>
            </div>
            <div class="nexus-fh-page-loader">
                <div class="nexus-fh-page-loader-heading">Rozšíriť zoznam videí</div>
                <div class="nexus-fh-page-loader-controls">
                    <label>Strán
                        <input data-role="page-count" type="number" min="1" max="50" step="1" value="5" inputmode="numeric" aria-label="Počet ďalších strán">
                    </label>
                    <button data-role="load-next" class="primary" title="Pripojí videá z nasledujúcich strán pri zachovaní aktuálnych filtrov">Load Next</button>
                </div>
                <div data-role="page-status" class="nexus-fh-page-status">Ďalšia strana: 2</div>
            </div>
            <div class="nexus-fh-filter-wrap">
                <div class="nexus-fh-filter-heading">
                    <span>Filtrovanie a zoradenie</span>
                    <span data-role="filter-count" class="nexus-fh-filter-count">Filter je pripravený po Fetch</span>
                </div>
                <input data-role="filter-query" class="nexus-fh-filter-query" type="search" autocomplete="off" placeholder="Hľadať v názve, kvalite, dátume…">
                <div class="nexus-fh-filter-controls">
                    <select data-role="sort" aria-label="Zoradiť karty">
                        <option value="site">Pôvodné poradie</option>
                        <option value="size-desc">Veľkosť: najväčšie</option>
                        <option value="size-asc">Veľkosť: najmenšie</option>
                        <option value="date-desc">Dátum: najnovšie</option>
                        <option value="date-asc">Dátum: najstaršie</option>
                        <option value="quality-desc">Kvalita: najvyššia</option>
                        <option value="quality-asc">Kvalita: najnižšia</option>
                    </select>
                    <button data-role="clear-filter" title="Vymaže vyhľadávanie a obnoví pôvodné poradie">Reset</button>
                </div>
                <label class="nexus-fh-filter-toggle">
                    <input data-role="only-matches" type="checkbox">
                    <span>Zobraziť iba filtrované</span>
                </label>
            </div>
            <div class="nexus-fh-direct-streams-wrap">
                <div class="nexus-fh-direct-streams-label" style="display:flex; justify-content:space-between; align-items:center;">
                    <span>Direct HLS / MP4 streamy — najvyššia kvalita</span>
                </div>
                <textarea id="nexus-fh-direct-streams" class="nexus-fh-direct-streams" readonly placeholder="Označ karty a klikni na Fetch selected."></textarea>
                <div id="nexus-fh-fetch-status" class="nexus-fh-fetch-status">Zatiaľ neboli načítané žiadne streamy.</div>
            </div>
        `;
        document.body.appendChild(bar);

        // 2. Create Floating Bubble (FAB)
        const bubble = document.createElement('div');
        bubble.id = BUBBLE_ID;
        bubble.className = 'nexus-fh-bubble nexus-hidden';
        bubble.title = 'Nexus Faphouse Tool - Kliknutím rozbalíte (potiahnutím presuniete)';
        bubble.innerHTML = `
            <span class="nexus-fh-bubble-icon">⚡</span>
            <span class="nexus-fh-bubble-badge">0</span>
        `;
        document.body.appendChild(bubble);

        // Position restoring
        if (state.position) {
            applyPosition(bar, state.position);
            applyPosition(bubble, state.position);
        }

        // Draggable for bar
        const header = bar.querySelector('.nexus-fh-header');
        makeDraggable(bar, header, (x, y) => {
            applyPosition(bubble, { x, y });
        });

        // Draggable for bubble
        const wasBubbleDragged = makeDraggable(bubble, bubble, (x, y) => {
            applyPosition(bar, { x, y });
        });

        // Click on bubble -> expand (only if not dragged)
        bubble.addEventListener('click', (e) => {
            if (wasBubbleDragged()) return;
            e.stopPropagation();
            setMinimized(false);
        });

        // Minimize button click
        bar.querySelector('[data-role="minimize"]').addEventListener('click', (e) => {
            e.stopPropagation();
            setMinimized(true);
            toast('Panel zbalený do ikonky ⚡. Kliknutím na ňu ho opäť otvoríte.');
        });

        // Toolbar Action buttons
        bar.querySelector('[data-role="refresh-expired"]').addEventListener('click', () => {
            refreshExpiredLinks();
        });

        bar.querySelector('[data-role="refresh"]').addEventListener('click', () => {
            scanCards();
            toast(`Nájdených ${visibleItems().length} Faphouse videí`);
        });

        const pageCount = bar.querySelector('[data-role="page-count"]');
        try {
            const storedPageCount = Number.parseInt(localStorage.getItem(STORAGE_PAGE_COUNT_KEY) || '', 10);
            if (storedPageCount >= 1 && storedPageCount <= 50 && pageCount) pageCount.value = String(storedPageCount);
        } catch {}
        pageCount?.addEventListener('change', () => {
            const value = Math.max(1, Math.min(50, Number.parseInt(pageCount.value, 10) || 5));
            pageCount.value = String(value);
            try { localStorage.setItem(STORAGE_PAGE_COUNT_KEY, String(value)); } catch {}
        });
        bar.querySelector('[data-role="load-next"]')?.addEventListener('click', () => {
            void loadNextPages(pageCount?.value);
        });

        bar.querySelector('[data-role="select-visible"]').addEventListener('click', () => {
            visibleItems().forEach((item) => { item.selected = true; upsertCardUi(item); });
            updateUi();
        });

        bar.querySelector('[data-role="clear"]').addEventListener('click', () => {
            state.items.forEach((item) => { item.selected = false; upsertCardUi(item); });
            updateUi();
        });

        bar.querySelector('[data-role="fetch-selected"]').addEventListener('click', () => {
            fetchSelectedStreams();
        });

        bar.querySelector('[data-role="sidecar-selected"]').addEventListener('click', () => {
            sendSelectedToSidecar();
        });

        bar.querySelector('[data-role="idm-selected"]').addEventListener('click', () => {
            sendSelectedToIdm();
        });

        bar.querySelector('[data-role="jdownloader-selected"]')?.addEventListener('click', () => {
            sendSelectedToJDownloader();
        });

        bar.querySelector('[data-role="import-selected"]').addEventListener('click', () => {
            importItems(selectedItems());
        });

        bar.querySelector('[data-role="import-visible"]').addEventListener('click', () => {
            importItems(visibleItems());
        });

        const filterQuery = bar.querySelector('[data-role="filter-query"]');
        const sortSelect = bar.querySelector('[data-role="sort"]');
        const onlyMatches = bar.querySelector('[data-role="only-matches"]');
        filterQuery?.addEventListener('input', () => {
            state.filter.query = filterQuery.value;
            updateUi();
        });
        sortSelect?.addEventListener('change', () => {
            state.filter.sort = sortSelect.value;
            updateUi();
        });
        onlyMatches?.addEventListener('change', () => {
            state.filter.onlyMatches = !!onlyMatches.checked;
            updateUi();
        });
        bar.querySelector('[data-role="clear-filter"]')?.addEventListener('click', () => {
            state.filter.query = '';
            state.filter.sort = 'site';
            state.filter.onlyMatches = false;
            if (filterQuery) filterQuery.value = '';
            if (sortSelect) sortSelect.value = 'site';
            if (onlyMatches) onlyMatches.checked = false;
            updateUi();
        });

        // Watch page: wire up the inline import button in toolbar
        const watchImportBtn = bar.querySelector('#nexus-fh-watch-import-main');
        if (watchImportBtn) {
            watchImportBtn.addEventListener('click', async () => {
                const cleanUrl = location.href.split('#')[0];
                const title = document.querySelector('h1')?.textContent.trim() || document.title;
                const videoEl = document.querySelector('video');

                watchImportBtn.disabled = true;
                watchImportBtn.textContent = '⏳ Zisťujem stream...';

                // Trigger play if paused to load real stream
                if (videoEl && videoEl.paused) {
                    try {
                        videoEl.muted = true;
                        await videoEl.play();
                    } catch {}
                }

                // Poll background for captured stream
                let directStreamUrl = '';
                for (let attempt = 0; attempt < 8; attempt++) {
                    const res = await askBackground({
                        action: 'GET_CAPTURED_STREAM',
                        pageUrl: cleanUrl,
                        duration: Math.round(videoEl?.duration || 0),
                    });
                    const candidate = String(res?.streamUrl || '').trim();
                    directStreamUrl = candidate && !candidate.includes('/trailer/') && !candidate.includes('/preview/')
                        ? candidate
                        : '';
                    if (directStreamUrl) break;
                    await new Promise((r) => setTimeout(r, 400));
                }

                // Fallback: video src
                if (!directStreamUrl) {
                    for (const s of document.querySelectorAll('video source, video[src]')) {
                        const src = s.src || s.getAttribute('src') || '';
                        if (src && !src.startsWith('blob:') && !src.includes('/trailer/') && !src.includes('/preview/')) {
                            directStreamUrl = src;
                            break;
                        }
                    }
                }

                watchImportBtn.disabled = false;
                let qualityLabel = '1080p';
                if (directStreamUrl) {
                    const qm = directStreamUrl.match(/(?:^|[\/_.-])(2160|1440|1080|720|480)(?:p)?(?:[\/_.-]|$)/i);
                    if (qm) qualityLabel = `${qm[1]}p`;
                    watchImportBtn.textContent = `⚡ Importovať toto video`;
                    toast(`⚡ Direct stream (${qualityLabel}) zachytený! Odosielam...`);
                } else {
                    watchImportBtn.textContent = `⚡ Importovať toto video`;
                    toast(`Odosielam video do Nexus Vaultu...`);
                }

                importItems([{
                    id: cleanUrl,
                    url: directStreamUrl || cleanUrl,
                    title,
                    thumbnail: document.querySelector('meta[property="og:image"]')?.content || '',
                    duration: Math.round(videoEl?.duration || 0),
                    quality: qualityLabel,
                    direct_url: directStreamUrl || null,
                }]);
            });
        }

        // Watch page: send this single video straight to the Sidecar queue,
        // reusing the same "highest quality" resolver as Fetch selected so it
        // never falls back to a lower-quality generic <video> src. playNow is
        // always false — the dock/panel just opens with the item queued, no
        // autoplay.
        const watchSidecarBtn = bar.querySelector('#nexus-fh-watch-sidecar-btn');
        if (watchSidecarBtn) {
            watchSidecarBtn.addEventListener('click', async () => {
                watchSidecarBtn.disabled = true;
                watchSidecarBtn.textContent = '⏳ Zisťujem kvalitu…';

                const item = watchPageItem();
                if (!item.direct_url) {
                    const resolved = await resolveCardStream(item);
                    if (resolved.locked) {
                        item.resolveFailed = resolved.reason || 'stream sa nenašiel';
                    } else {
                        item.direct_url = resolved.streamUrl;
                        item.quality = resolved.quality;
                        item.duration = resolved.duration || item.duration;
                        item.addedDate = resolved.addedDate;
                    }
                    refreshItemPresentation(item);
                }

                watchSidecarBtn.disabled = false;
                watchSidecarBtn.textContent = '▶ Sidecar';

                if (!item.direct_url) {
                    toast(`Sidecar: stream sa nenašiel (${item.resolveFailed || 'bez prístupu'})`, true);
                    return;
                }

                const result = await enqueueInSidecar([item]);
                if (!result?.ok) {
                    toast(`Sidecar: ${result?.error || 'odoslanie zlyhalo'}`, true);
                    return;
                }
                const duplicateText = result.duplicates ? ' (už bolo v playliste)' : '';
                toast(`Sidecar: pridané${duplicateText}`);
            });
        }

        // Apply initial minimized state
        setMinimized(state.minimized);
    }

    function boot() {
        // Remove untagged controls left behind by the older scanner.  Those
        // controls were attached to transient nested Faphouse nodes and could
        // leave a second selector visible after a React refresh.
        document.querySelectorAll(`.${CHECK_CLASS}:not([data-nexus-fh-id]), .nexus-fh-card-meta:not([data-nexus-fh-id])`).forEach((node) => node.remove());
        createWidgets();
        observeOpenedPlayers();
        scanCards();
        setTimeout(scanCards, 600);
        setTimeout(scanCards, 1500);
        setInterval(scanCards, 2000);

        // Faphouse replaces thumbnail wrappers after its first paint without
        // changing the number of /videos/ links. A ResizeObserver catches that
        // late responsive hydration, so selectors do not depend on opening F12.
        let resizeTimer = 0;
        const scheduleRescan = () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(scanCards, 80);
        };
        window.addEventListener('resize', scheduleRescan, { passive: true });
        if (window.ResizeObserver && document.body) {
            new ResizeObserver(scheduleRescan).observe(document.body);
        }

        new MutationObserver(() => {
            const currentCount = document.querySelectorAll('a[href*="/videos/"]').length;
            if (currentCount !== state.lastCardCount) {
                state.lastCardCount = currentCount;
                scanCards();
            }
        }).observe(document.documentElement, { childList: true, subtree: true });
    }

    // Popup bridge: keep Faphouse out of the generic Base64 scanner and
    // reveal the page-level importer when the extension popup is opened.
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.action === 'FAPHOUSE_GALLERY_ITEMS' || message?.action === 'FAPHOUSE_GALLERY_RESOLVE') {
            const serialize = (item) => ({
                id: String(item.id || item.url), url: item.url, source_url: item.url,
                title: item.title, thumbnail: item.thumbnail, duration: item.duration || 0,
                quality: item.quality || 'HD', directUrl: item.direct_url || '',
                size: Number(item.sizeBytes || 0), uploadDate: item.addedDate || '',
                sizeStreamUrl: item.sizeStreamUrl || '', sizeEstimated: !!item.sizeEstimated,
                resolverVersion: 2,
                selected: !!item.selected, resolveError: item.resolveFailed || '',
            });
            (async () => {
                scanCards();
                let items = Array.from(state.items.values()).filter(item => item.card?.isConnected);
                if (isWatchPage()) {
                    const current = watchPageItem();
                    if (current && !items.some(item => item.url === current.url)) items.unshift(current);
                }
                if (message.action === 'FAPHOUSE_GALLERY_RESOLVE') {
                    const id = faphouseVideoId(message.url);
                    if (!id) throw new Error('Neplatná FapHouse watch URL.');
                    items = items.filter(item => faphouseVideoId(item.url) === id);
                    if (!items.length) items = [{ id, url: message.url, duration: 0, sizeBytes: 0 }];
                    await resolveMany(items, null, { force: !!message.force });
                    await Promise.all(items.map(item => item.sizeProbePromise));
                }
                return { ok: true, items: items.map(serialize) };
            })().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
            return true;
        }
        if (message?.action !== 'FAPHOUSE_POPUP_OPEN') return;
        try {
            scanCards();
            setMinimized(false);
            sendResponse({ ok: true, count: visibleItems().length });
        } catch (error) {
            sendResponse({ ok: false, error: error?.message || String(error) });
        }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
