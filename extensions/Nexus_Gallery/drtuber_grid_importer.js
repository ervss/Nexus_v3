(function () {
    'use strict';

    if (window.top !== window || !/(^|\.)drtuber\.com$/i.test(location.hostname)) return;

    const TOOLBAR_ID = 'nexus-drt-toolbar';
    const CARD_CLASS = 'nexus-drt-card';
    const CHECK_CLASS = 'nexus-drt-check';
    const META_CLASS = 'nexus-drt-meta';
    const HIDDEN_CLASS = 'nexus-drt-hidden';
    const QUALITY_LEVELS = [2160, 1440, 1080, 720, 480, 360, 240];
    const state = {
        items: new Map(),
        selected: new Set(),
        busy: false,
        metaBusy: false,
        nextUrl: '',
        scanTimer: 0,
        sort: 'page',
        direction: 'desc',
    };

    function canonicalVideoUrl(rawUrl) {
        try {
            const url = new URL(rawUrl, location.href);
            if (!/(^|\.)drtuber\.com$/i.test(url.hostname)) return '';
            const match = url.pathname.match(/^\/video\/(\d+)(?:\/[^/?#]*)?\/?$/i);
            return match ? `https://www.drtuber.com/video/${match[1]}${url.pathname.slice(match[0].match(/\/video\/\d+/i)[0].length).replace(/\/$/, '')}` : '';
        } catch {
            return '';
        }
    }

    function videoId(url) {
        return String(url || '').match(/\/video\/(\d+)/i)?.[1] || '';
    }

    function parseDuration(text) {
        const match = String(text || '').match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
        if (!match) return 0;
        return match[3]
            ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
            : Number(match[1]) * 60 + Number(match[2]);
    }

    function formatDuration(seconds) {
        const total = Math.max(0, Number(seconds) || 0);
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const remainder = Math.floor(total % 60);
        return hours
            ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
            : `${minutes}:${String(remainder).padStart(2, '0')}`;
    }

    function formatSize(bytes) {
        const value = Number(bytes) || 0;
        if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
        if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`;
        if (value >= 1024) return `${Math.round(value / 1024)} KB`;
        return value > 0 ? `${value} B` : '';
    }

    function qualityHeight(text) {
        const match = String(text || '').match(/\b(2160|1440|1080|720|480|360|240)p?\b|4k/i);
        if (!match) return 0;
        return /^4k$/i.test(match[0]) ? 2160 : Number.parseInt(match[0], 10) || 0;
    }

    function qualityFromCard(card) {
        const label = card.querySelector('.quality')?.textContent || '';
        const iconClasses = [...(card.querySelector('.quality')?.querySelector('i')?.classList || [])].join(' ');
        const height = qualityHeight(`${label} ${iconClasses} ${card.textContent}`);
        return height || (/\bico_hd\b/i.test(iconClasses) ? 720 : 0);
    }

    function getListingRoot(doc = document) {
        return doc.querySelector('.thumbs_box .thumbs');
    }

    function getCards(doc = document) {
        const root = getListingRoot(doc);
        if (!root) return [];
        return [...root.querySelectorAll(':scope > a.th.ch-video[href*="/video/"]')];
    }

    function collectCard(card) {
        const url = canonicalVideoUrl(card.getAttribute('href') || card.href);
        const id = videoId(url);
        if (!id) return null;
        const image = card.querySelector('img');
        const duration = parseDuration(card.querySelector('.time_thumb')?.textContent || card.textContent);
        const text = card.textContent || '';
        const sizeMatch = text.match(/\b([\d.,]+)\s*(GB|MB|KB)\b/i);
        const sizeValue = sizeMatch ? Number.parseFloat(sizeMatch[1].replace(',', '.')) : 0;
        const unit = sizeMatch?.[2]?.toUpperCase();
        const sizeBytes = sizeValue * (unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : unit === 'KB' ? 1024 : 0);
        return {
            id,
            url,
            title: image?.getAttribute('alt')?.trim()
                || card.querySelector('span em')?.textContent?.trim()
                || card.getAttribute('title')?.trim()
                || 'DrTuber Video',
            thumbnail: image?.getAttribute('src') || image?.getAttribute('data-src') || '',
            duration,
            height: qualityFromCard(card),
            sizeBytes,
            card,
        };
    }

    function setSelected(item, selected) {
        if (selected) state.selected.add(item.id);
        else state.selected.delete(item.id);
        item.card.classList.toggle('nexus-drt-selected', selected);
        const checkbox = item.card.querySelector(`.${CHECK_CLASS} input`);
        if (checkbox) checkbox.checked = selected;
        updateToolbar();
    }

    function renderCard(item) {
        const card = item.card;
        card.classList.add(CARD_CLASS);
        if (getComputedStyle(card).position === 'static') card.style.setProperty('position', 'relative', 'important');

        let checkbox = card.querySelector(`.${CHECK_CLASS}`);
        if (!checkbox) {
            checkbox = document.createElement('label');
            checkbox.className = CHECK_CLASS;
            checkbox.innerHTML = '<input type="checkbox" aria-label="Select video"><span></span>';
            checkbox.addEventListener('click', event => {
                event.stopPropagation();
            });
            checkbox.querySelector('input').addEventListener('change', event => {
                setSelected(item, event.target.checked);
            });
            card.appendChild(checkbox);
        }
        checkbox.querySelector('input').checked = state.selected.has(item.id);
        card.classList.toggle('nexus-drt-selected', state.selected.has(item.id));

        let badge = card.querySelector(`.${META_CLASS}`);
        if (!badge) {
            badge = document.createElement('div');
            badge.className = META_CLASS;
            badge.setAttribute('aria-label', 'Video details');
            card.appendChild(badge);
        }
        badge.replaceChildren();
        const chips = [];
        if (item.sizeBytes > 0) chips.push(['size', formatSize(item.sizeBytes)]);
        if (item.duration > 0) chips.push(['duration', formatDuration(item.duration)]);
        for (const [kind, text] of chips) {
            const chip = document.createElement('span');
            chip.className = `nexus-drt-chip nexus-drt-${kind}`;
            chip.textContent = text;
            badge.appendChild(chip);
        }
    }

    function matchesFilters(item) {
        const toolbar = document.getElementById(TOOLBAR_ID);
        const minimumSize = Number(toolbar?.querySelector('[data-role="size-min"]')?.value || 0) * 1024 ** 2;
        const maximumSize = Number(toolbar?.querySelector('[data-role="size-max"]')?.value || 0) * 1024 ** 2;
        const minimumDuration = Number(toolbar?.querySelector('[data-role="duration-min"]')?.value || 0) * 60;
        const maximumDuration = Number(toolbar?.querySelector('[data-role="duration-max"]')?.value || 0) * 60;
        const quality = Number(toolbar?.querySelector('[data-role="quality"]')?.value || 0);
        const onlySelected = toolbar?.querySelector('[data-role="only-selected"]')?.dataset.active === '1';
        if (onlySelected && !state.selected.has(item.id)) return false;
        if (minimumSize && item.sizeBytes < minimumSize) return false;
        if (maximumSize && item.sizeBytes > maximumSize) return false;
        if (minimumDuration && item.duration < minimumDuration) return false;
        if (maximumDuration && item.duration > maximumDuration) return false;
        if (quality && item.height !== quality) return false;
        return true;
    }

    function sortItems() {
        const field = state.sort;
        const direction = state.direction === 'asc' ? 1 : -1;
        const items = [...state.items.values()];
        if (field !== 'page') {
            items.sort((a, b) => {
                const left = field === 'title' ? a.title.toLowerCase()
                    : field === 'size' ? a.sizeBytes
                        : field === 'duration' ? a.duration : a.height;
                const right = field === 'title' ? b.title.toLowerCase()
                    : field === 'size' ? b.sizeBytes
                        : field === 'duration' ? b.duration : b.height;
                return (left < right ? -1 : left > right ? 1 : 0) * direction;
            });
        }
        const groups = new Map();
        for (const item of items) {
            const parent = item.card.parentElement;
            if (!parent) continue;
            if (!groups.has(parent)) groups.set(parent, []);
            groups.get(parent).push(item);
        }
        for (const [parent, group] of groups) {
            for (const item of group) parent.appendChild(item.card);
        }
    }

    function applyView() {
        for (const item of state.items.values()) {
            item.card.classList.toggle(HIDDEN_CLASS, !matchesFilters(item));
        }
        sortItems();
        updateToolbar();
    }

    function updateToolbar() {
        const toolbar = document.getElementById(TOOLBAR_ID);
        if (!toolbar) return;
        const visible = [...state.items.values()].filter(item => !item.card.classList.contains(HIDDEN_CLASS)).length;
        toolbar.querySelector('[data-role="stats"]').textContent =
            `${state.selected.size} selected · ${visible}/${state.items.size} shown`;
        toolbar.querySelector('[data-role="import"]').disabled = !state.selected.size || state.busy;
        toolbar.querySelector('[data-role="select"]').disabled = !visible || state.busy;
        toolbar.querySelector('[data-role="clear"]').disabled = !state.selected.size || state.busy;
        toolbar.querySelector('[data-role="fetch"]').disabled = state.metaBusy || state.busy || !state.items.size;
        toolbar.querySelector('[data-role="load"]').disabled = state.busy || !state.nextUrl;
        toolbar.dataset.busy = state.busy || state.metaBusy ? '1' : '0';
    }

    function toast(message, isError = false) {
        let el = document.getElementById('nexus-drt-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'nexus-drt-toast';
            document.body.appendChild(el);
        }
        el.textContent = message;
        el.dataset.error = isError ? '1' : '0';
        el.classList.add('visible');
        clearTimeout(el._timer);
        el._timer = setTimeout(() => el.classList.remove('visible'), 3500);
    }

    function scanCards(doc = document) {
        const cards = getCards(doc);
        for (const card of cards) {
            const collected = collectCard(card);
            if (!collected) continue;
            const previous = state.items.get(collected.id);
            const item = {
                ...previous,
                ...collected,
                sizeBytes: previous?.sizeBytes || collected.sizeBytes,
                height: collected.height || previous?.height || 0,
            };
            state.items.set(item.id, item);
            renderCard(item);
        }
        if (doc === document) {
            state.nextUrl = findNextPageUrl(document);
            applyView();
        }
        return cards.length;
    }

    function findNextPageUrl(doc, baseUrl = location.href) {
        const link = [...doc.querySelectorAll('a[rel="next"], .pagination a[href], [class*="pagination"] a[href]')]
            .find(anchor => {
                const label = `${anchor.getAttribute('rel') || ''} ${anchor.getAttribute('aria-label') || ''} ${anchor.textContent || ''}`;
                return /\bnext\b|›|»|→/i.test(label);
            });
        if (!link) return '';
        try {
            const url = new URL(link.getAttribute('href'), baseUrl);
            return url.origin === location.origin ? url.href : '';
        } catch {
            return '';
        }
    }

    async function requestSize(url, referer) {
        const response = await chrome.runtime.sendMessage({ action: 'DRTUBER_PROBE_SIZE', url, referer });
        if (!response?.ok) throw new Error(response?.error || 'Could not read media file size');
        return Number(response.sizeBytes) || 0;
    }

    async function fetchMetadata(item) {
        const pageResponse = await fetch(item.url, { credentials: 'include', redirect: 'follow' });
        if (!pageResponse.ok) throw new Error(`Video page returned HTTP ${pageResponse.status}`);
        const pageHtml = await pageResponse.text();
        const pageDoc = new DOMParser().parseFromString(pageHtml, 'text/html');
        const videoIdValue = videoId(item.url);
        const configUrl = new URL('/player_config_json/', item.url);
        configUrl.search = new URLSearchParams({
            vid: videoIdValue,
            aid: '0',
            domain_id: '0',
            embed: '0',
            ref: 'null',
            check_speed: '0',
        });
        const configResponse = await fetch(configUrl.href, {
            credentials: 'include',
            headers: {
                Accept: 'application/json, text/javascript, */*; q=0.01',
                'X-Requested-With': 'XMLHttpRequest',
            },
        });
        if (!configResponse.ok) throw new Error(`Player config returned HTTP ${configResponse.status}`);
        const config = await configResponse.json();
        const files = config?.files || {};
        const candidates = [...new Set([files.hq, files['4k'], files.lq].filter(url => typeof url === 'string' && url.trim()))];
        let sizeBytes = 0;
        for (const candidate of candidates) {
            let stream;
            try {
                stream = new URL(candidate, item.url);
            } catch {
                continue;
            }
            if (stream.protocol !== 'https:' || stream.hostname.toLowerCase() !== 'gcdn.drtuber.com') continue;
            sizeBytes = await requestSize(stream.href, item.url);
            if (sizeBytes > 0) break;
        }
        const duration = Number(config.duration) || item.duration || 0;
        const htmlQuality = pageHtml.match(/(?:defaultQuality|video_height|height)["'\s:=]+(?:\[)?["']?(2160|1440|1080|720|480|360|240)/i)?.[1];
        const quality = Number(htmlQuality) || item.height || 0;
        return {
            ...item,
            title: String(config.title || item.title).trim(),
            thumbnail: String(config.poster || item.thumbnail).trim(),
            duration,
            height: quality,
            sizeBytes: sizeBytes || item.sizeBytes,
            uploadDate: pageDoc.querySelector('meta[itemprop="uploadDate"]')?.content || '',
        };
    }

    async function mapInBatches(items, callback) {
        const output = [];
        for (let index = 0; index < items.length; index += 4) {
            const batch = items.slice(index, index + 4);
            output.push(...await Promise.all(batch.map(async item => {
                try {
                    const enriched = await callback(item);
                    state.items.set(item.id, enriched);
                    renderCard(enriched);
                    return { ok: true, item: enriched };
                } catch (error) {
                    console.warn('[Nexus DrTuber] Metadata lookup failed:', item.url, error?.message || error);
                    return { ok: false, item, error };
                }
            })));
        }
        return output;
    }

    async function fetchAllMetadata(items = [...state.items.values()]) {
        if (state.metaBusy || !items.length) return;
        state.metaBusy = true;
        updateToolbar();
        try {
            const results = await mapInBatches(items.filter(item => !item.sizeBytes), fetchMetadata);
            const sized = results.filter(result => result.ok && result.item.sizeBytes > 0).length;
            const failed = results.filter(result => !result.ok).length;
            toast(`DrTuber: ${sized} sizes found${failed ? ` · ${failed} lookups failed` : ''}`, failed > 0 && sized === 0);
        } finally {
            state.metaBusy = false;
            applyView();
        }
    }

    function visibleItems() {
        return [...state.items.values()].filter(item => !item.card.classList.contains(HIDDEN_CLASS));
    }

    async function importSelected() {
        const picked = [...state.selected].map(id => state.items.get(id)).filter(Boolean);
        if (!picked.length || state.busy) return;
        state.busy = true;
        updateToolbar();
        try {
            const missing = picked.filter(item => !item.sizeBytes);
            if (missing.length) {
                toast(`Checking size for ${missing.length} selected video${missing.length === 1 ? '' : 's'}…`);
                await mapInBatches(missing, fetchMetadata);
            }
            const items = picked.map(item => {
                const latest = state.items.get(item.id) || item;
                return {
                    url: latest.url,
                    source_url: latest.url,
                    title: latest.title,
                    thumbnail: latest.thumbnail,
                    duration: latest.duration,
                    height: latest.height,
                    width: latest.height >= 2160 ? 3840 : latest.height >= 1440 ? 2560 : latest.height >= 1080 ? 1920 : latest.height >= 720 ? 1280 : 0,
                    quality: latest.height ? (latest.height >= 2160 ? '4K' : `${latest.height}p`) : '',
                    sizeBytes: latest.sizeBytes,
                    uploadDate: latest.uploadDate || '',
                    tags: ['drtuber'],
                };
            });
            const response = await chrome.runtime.sendMessage({
                action: 'DRTUBER_IMPORT_BULK',
                batchName: `DrTuber Quick Import: ${document.title.trim()}`,
                items,
            });
            if (!response?.ok) throw new Error(response?.error || 'Nexus import failed');
            state.selected.clear();
            scanCards();
            toast(`Imported ${response.imported ?? items.length} videos to Nexus`);
        } finally {
            state.busy = false;
            updateToolbar();
        }
    }

    async function loadNextPage() {
        if (!state.nextUrl || state.busy) return;
        const nextUrl = state.nextUrl;
        state.busy = true;
        updateToolbar();
        try {
            const response = await fetch(nextUrl, { credentials: 'include', redirect: 'follow' });
            if (!response.ok) throw new Error(`Next page returned HTTP ${response.status}`);
            const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
            const currentIds = new Set(state.items.keys());
            const fresh = getCards(doc).filter(card => {
                const item = collectCard(card);
                return item && !currentIds.has(item.id);
            });
            if (!fresh.length) {
                state.nextUrl = '';
                toast('No more DrTuber videos found');
                return;
            }
            const root = getListingRoot();
            if (!root) throw new Error('DrTuber video grid was not found');
            const fragment = document.createDocumentFragment();
            for (const card of fresh) fragment.appendChild(document.importNode(card, true));
            root.appendChild(fragment);
            const followingPage = findNextPageUrl(doc, nextUrl);
            scanCards();
            state.nextUrl = followingPage;
            toast(`Loaded ${fresh.length} more DrTuber videos`);
        } finally {
            state.busy = false;
            updateToolbar();
        }
    }

    function createToolbar() {
        if (document.getElementById(TOOLBAR_ID)) return;
        const toolbar = document.createElement('section');
        toolbar.id = TOOLBAR_ID;
        toolbar.innerHTML = `
            <header><strong>Nexus · DrTuber</strong><span data-role="stats">0 selected · 0/0 shown</span></header>
            <div class="nexus-drt-controls">
                <label>Quality<select data-role="quality"><option value="0">Any</option>${QUALITY_LEVELS.map(height => `<option value="${height}">${height >= 2160 ? '4K' : `${height}p`}</option>`).join('')}</select></label>
                <label>Min MB<input data-role="size-min" type="number" min="0" placeholder="0"></label>
                <label>Max MB<input data-role="size-max" type="number" min="0" placeholder="0"></label>
                <label>Min min<input data-role="duration-min" type="number" min="0" placeholder="0"></label>
                <label>Max min<input data-role="duration-max" type="number" min="0" placeholder="0"></label>
                <label>Sort<select data-role="sort"><option value="page">Page order</option><option value="size">Size</option><option value="duration">Duration</option><option value="quality">Quality</option><option value="title">Title</option></select></label>
            </div>
            <nav>
                <button data-role="fetch">Fetch metadata</button><button data-role="only-selected" data-active="0">Only selected</button>
                <button data-role="direction">Desc</button><button data-role="load">Load next page</button>
                <button data-role="select">Select shown</button><button data-role="clear">Clear</button>
                <button data-role="import" class="primary">Import selected</button>
            </nav>`;
        document.body.appendChild(toolbar);
        toolbar.querySelectorAll('[data-role="quality"],[data-role="size-min"],[data-role="size-max"],[data-role="duration-min"],[data-role="duration-max"]')
            .forEach(control => control.addEventListener('input', applyView));
        toolbar.querySelector('[data-role="sort"]').addEventListener('change', event => {
            state.sort = event.target.value;
            applyView();
        });
        toolbar.querySelector('[data-role="direction"]').addEventListener('click', event => {
            state.direction = state.direction === 'asc' ? 'desc' : 'asc';
            event.currentTarget.textContent = state.direction === 'asc' ? 'Asc' : 'Desc';
            applyView();
        });
        toolbar.querySelector('[data-role="only-selected"]').addEventListener('click', event => {
            event.currentTarget.dataset.active = event.currentTarget.dataset.active === '1' ? '0' : '1';
            applyView();
        });
        toolbar.querySelector('[data-role="fetch"]').addEventListener('click', () => {
            fetchAllMetadata().catch(error => toast(error?.message || 'Metadata lookup failed', true));
        });
        toolbar.querySelector('[data-role="select"]').addEventListener('click', () => {
            visibleItems().forEach(item => setSelected(item, true));
        });
        toolbar.querySelector('[data-role="clear"]').addEventListener('click', () => {
            state.selected.clear();
            for (const item of state.items.values()) renderCard(item);
            applyView();
        });
        toolbar.querySelector('[data-role="import"]').addEventListener('click', () => {
            importSelected().catch(error => toast(error?.message || 'Import failed', true));
        });
        toolbar.querySelector('[data-role="load"]').addEventListener('click', () => {
            loadNextPage().catch(error => toast(error?.message || 'Could not load next page', true))
                .finally(() => { state.busy = false; updateToolbar(); });
        });
        updateToolbar();
    }

    function scheduleScan() {
        clearTimeout(state.scanTimer);
        state.scanTimer = setTimeout(() => scanCards(), 250);
    }

    function boot() {
        if (!getListingRoot()) return;
        createToolbar();
        const found = scanCards();
        const initiallyVisible = [...state.items.values()].filter(item => {
            const rect = item.card.getBoundingClientRect();
            return rect.top < window.innerHeight + 300 && rect.bottom > -300;
        });
        if (initiallyVisible.length) fetchAllMetadata(initiallyVisible).catch(error => {
            console.error('[Nexus DrTuber] Initial metadata scan failed:', error);
        });
        const observer = new MutationObserver(records => {
            if (records.some(record => [...record.addedNodes].some(node =>
                node.nodeType === Node.ELEMENT_NODE
                && !node.closest?.(`#${TOOLBAR_ID}, #nexus-drt-toast`)
                && (node.matches?.('a.th.ch-video') || node.querySelector?.('a.th.ch-video'))))) {
                scheduleScan();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        console.info(`[Nexus DrTuber] Gallery importer ready; ${found} cards found.`);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
