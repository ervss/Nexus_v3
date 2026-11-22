(function () {
    'use strict';

    if (window.top !== window) return;
    if (!/redgifs\.com$/i.test(location.hostname)) return;

    const TOOLBAR_ID = 'nexus-redgifs-toolbar';
    const CHECKBOX_CLASS = 'nexus-rg-check';
    const BADGE_CLASS = 'nexus-rg-meta';
    const SCAN_INTERVAL_MS = 1200;
    const state = {
        items: new Map(),
        lastHash: '',
        busy: false,
        scanInfo: {
            links: 0,
            cards: 0,
            media: 0,
        },
    };

    function toast(message, isError = false) {
        let el = document.getElementById('nexus-rg-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'nexus-rg-toast';
            el.className = 'nexus-rg-toast';
            document.body.appendChild(el);
        }
        el.textContent = message;
        el.dataset.error = isError ? '1' : '0';
        el.classList.add('visible');
        clearTimeout(el._timer);
        el._timer = setTimeout(() => el.classList.remove('visible'), 3200);
    }

    function parseDurationText(raw) {
        const s = String(raw || '').trim();
        if (!s) return 0;
        const parts = s.split(':').map(Number);
        if (parts.some((n) => !Number.isFinite(n))) return 0;
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        return 0;
    }

    function titleFromUrl(url) {
        const id = extractId(url);
        return id ? `RedGIFs ${id}` : 'RedGIFs item';
    }

    function extractId(url) {
        const m = String(url || '').match(/\/watch\/([^/?#]+)/i);
        return m ? m[1] : '';
    }

    function extractIdFromMediaUrl(url) {
        const raw = String(url || '').trim();
        if (!raw) return '';
        const normalized = raw.split('?')[0];
        const patterns = [
            /\/([A-Za-z0-9-]{6,})-(?:mobile|small|large|poster|thumb|snapshot|preview)\.(?:jpg|jpeg|png|webp|mp4|webm)$/i,
            /\/([A-Za-z0-9-]{6,})\.(?:jpg|jpeg|png|webp|mp4|webm)$/i,
            /\/([A-Za-z0-9-]{6,})\/?(?:index)?\.(?:jpg|jpeg|png|webp|mp4|webm)$/i,
        ];
        for (const pattern of patterns) {
            const m = normalized.match(pattern);
            if (m) return m[1];
        }
        return '';
    }

    function detectQuality(text) {
        const m = String(text || '').match(/\b(2160|1440|1080|720|480)p\b/i);
        return m ? Number(m[1]) : 0;
    }

    function getCardAnchors() {
        const anchors = Array.from(document.querySelectorAll('a[href*="/watch/"], a[href^="/watch/"]'));
        const seen = new Set();
        const filtered = [];
        for (const anchor of anchors) {
            const href = anchor.href || anchor.getAttribute('href') || '';
            const id = extractId(href);
            if (!href || !id || seen.has(id)) continue;
            seen.add(id);
            filtered.push(anchor);
        }
        state.scanInfo.links = filtered.length;
        return filtered;
    }

    function getStandaloneMediaTiles() {
        const nodes = Array.from(document.querySelectorAll('#root img, #root video'));
        const filtered = [];
        const seen = new Set();
        for (const node of nodes) {
            const rect = node.getBoundingClientRect();
            if (rect.width < 110 || rect.height < 110) continue;
            const src = node.currentSrc || node.src || node.poster || node.getAttribute('src') || '';
            const id = extractIdFromMediaUrl(src);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            filtered.push(node);
        }
        state.scanInfo.media = filtered.length;
        return filtered;
    }

    function findMediaInNode(node) {
        if (!node) return null;
        const direct = node.querySelector('img, video, picture img');
        if (direct) return direct;

        let sibling = node.previousElementSibling;
        while (sibling) {
            const found = sibling.querySelector?.('img, video, picture img');
            if (found) return found;
            sibling = sibling.previousElementSibling;
        }

        sibling = node.nextElementSibling;
        while (sibling) {
            const found = sibling.querySelector?.('img, video, picture img');
            if (found) return found;
            sibling = sibling.nextElementSibling;
        }

        return null;
    }

    function findCardRoot(anchor) {
        const preferred = anchor.closest('article, li, [role="listitem"], .tile, .Tile, .masonry-item');
        if (preferred) return preferred;

        let node = anchor;
        while (node && node !== document.body) {
            const rect = node.getBoundingClientRect();
            const hasMedia = !!findMediaInNode(node);
            if (hasMedia && rect.width > 120 && rect.height > 120) return node;
            node = node.parentElement;
        }
        return anchor.parentElement || anchor;
    }

    function findCardRootFromMedia(media) {
        const preferred = media.closest('article, li, [role="listitem"], .tile, .Tile, .masonry-item');
        if (preferred) return preferred;

        let node = media.parentElement;
        while (node && node !== document.body) {
            const rect = node.getBoundingClientRect();
            if (rect.width > 110 && rect.height > 110) return node;
            node = node.parentElement;
        }
        return media.parentElement || media;
    }

    function collectCard(anchor) {
        const root = findCardRoot(anchor);
        const href = anchor.href || anchor.getAttribute('href') || '';
        const id = extractId(href);
        if (!id) return null;
        const media = anchor.querySelector('img, video, picture img') || findMediaInNode(root);
        const text = root.innerText || '';
        const durationText = (text.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/) || [])[0] || '';
        const quality = detectQuality(text);
        const title = (
            media?.alt ||
            media?.getAttribute?.('aria-label') ||
            anchor.getAttribute('aria-label') ||
            anchor.title ||
            ''
        ).trim() || titleFromUrl(href);
        const thumbnail = (
            media?.currentSrc ||
            media?.src ||
            media?.poster ||
            media?.getAttribute?.('src') ||
            ''
        );
        return {
            id,
            page_url: href,
            video_url: '',
            title,
            thumbnail,
            tags: [],
            duration: parseDurationText(durationText),
            durationLabel: durationText,
            width: 0,
            height: quality || 0,
            card: root,
        };
    }

    function collectMediaCard(media) {
        const src = media.currentSrc || media.src || media.poster || media.getAttribute('src') || '';
        const id = extractIdFromMediaUrl(src);
        if (!id) return null;

        const root = findCardRootFromMedia(media);
        const nearbyAnchor = root.querySelector('a[href*="/watch/"], a[href^="/watch/"]');
        const href = nearbyAnchor?.href || nearbyAnchor?.getAttribute('href') || `https://www.redgifs.com/watch/${id}`;
        const text = root.innerText || '';
        const durationText = (text.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/) || [])[0] || '';
        const quality = detectQuality(text);
        const title = (
            media?.alt ||
            media?.getAttribute?.('aria-label') ||
            root.getAttribute?.('aria-label') ||
            ''
        ).trim() || titleFromUrl(href);

        return {
            id,
            page_url: href,
            video_url: '',
            title,
            thumbnail: src,
            tags: [],
            duration: parseDurationText(durationText),
            durationLabel: durationText,
            width: 0,
            height: quality || 0,
            card: root,
        };
    }

    function isSelected(id) {
        return !!state.items.get(id)?.selected;
    }

    function visibleItems() {
        return Array.from(state.items.values()).filter((item) => item.card && item.card.isConnected);
    }

    function selectedItems() {
        return visibleItems().filter((item) => item.selected);
    }

    function updateToolbar() {
        const toolbar = document.getElementById(TOOLBAR_ID);
        if (!toolbar) return;
        const selected = selectedItems().length;
        const visible = visibleItems().length;
        const stats = toolbar.querySelector('.nexus-rg-stats');
        if (stats) stats.textContent = `${selected} selected / ${visible} visible / ${state.scanInfo.links} links / ${state.scanInfo.media} media`;
        toolbar.querySelector('[data-role="import-selected"]').disabled = selected === 0 || state.busy;
        toolbar.querySelector('[data-role="hydrate-selected"]').disabled = selected === 0 || state.busy;
        toolbar.querySelector('[data-role="import-visible"]').disabled = visible === 0 || state.busy;
        toolbar.querySelector('[data-role="hydrate-visible"]').disabled = visible === 0 || state.busy;
    }

    function upsertCheckbox(item) {
        const card = item.card;
        if (!card) return;
        if (getComputedStyle(card).position === 'static') {
            card.style.position = 'relative';
        }
        let box = card.querySelector(`.${CHECKBOX_CLASS}`);
        if (!box) {
            box = document.createElement('label');
            box.className = CHECKBOX_CLASS;
            box.innerHTML = '<input type="checkbox"><span></span>';
            card.appendChild(box);
            box.querySelector('input').addEventListener('change', (event) => {
                item.selected = !!event.target.checked;
                updateToolbar();
            });
        }
        box.querySelector('input').checked = !!item.selected;

        let badge = card.querySelector(`.${BADGE_CLASS}`);
        if (!badge) {
            badge = document.createElement('div');
            badge.className = BADGE_CLASS;
            card.appendChild(badge);
        }
        const chips = [];
        if (item.duration) chips.push(formatDuration(item.duration));
        if (item.height) chips.push(`${item.height}p`);
        const sizeMb = Number(item.file_size_mb || item.size_mb || 0) || 0;
        if (sizeMb > 0) chips.push(formatSizeMb(sizeMb));
        if (item.title) chips.push(item.title.length > 42 ? `${item.title.slice(0, 42)}...` : item.title);
        badge.textContent = chips.join(' · ');
    }

    function formatSizeMb(mb) {
        const value = Number(mb || 0);
        if (!value) return '';
        if (value >= 1024) return `${(value / 1024).toFixed(2)} GB`;
        return `${Math.round(value)} MB`;
    }

    function formatDuration(seconds) {
        const s = Math.max(0, Number(seconds || 0));
        const m = Math.floor(s / 60);
        const r = Math.floor(s % 60);
        return `${m}:${String(r).padStart(2, '0')}`;
    }

    function scanCards() {
        const anchors = getCardAnchors();
        const mediaTiles = getStandaloneMediaTiles();
        const ids = [];
        anchors.forEach((anchor) => {
            const card = collectCard(anchor);
            if (!card) return;
            ids.push(card.id);
            const existing = state.items.get(card.id) || {};
            const merged = { ...existing, ...card, selected: !!existing.selected };
            state.items.set(card.id, merged);
            upsertCheckbox(merged);
        });
        mediaTiles.forEach((media) => {
            const card = collectMediaCard(media);
            if (!card || ids.includes(card.id)) return;
            ids.push(card.id);
            const existing = state.items.get(card.id) || {};
            const merged = { ...existing, ...card, selected: !!existing.selected };
            state.items.set(card.id, merged);
            upsertCheckbox(merged);
        });
        state.scanInfo.cards = ids.length;

        for (const [id, item] of state.items.entries()) {
            if (!ids.includes(id) || !item.card?.isConnected) {
                state.items.delete(id);
            }
        }
        updateToolbar();
    }

    function createToolbar() {
        if (document.getElementById(TOOLBAR_ID)) return;
        const bar = document.createElement('div');
        bar.id = TOOLBAR_ID;
        bar.className = 'nexus-rg-toolbar';
        bar.innerHTML = `
            <div class="nexus-rg-title">RedGIFs Nexus Tool</div>
            <div class="nexus-rg-stats">0 selected / 0 visible / 0 links / 0 media</div>
            <div class="nexus-rg-actions">
                <button data-role="refresh">Refresh scan</button>
                <button data-role="select-visible">Select visible</button>
                <button data-role="clear">Clear</button>
                <button data-role="hydrate-selected">Hydrate selected</button>
                <button data-role="hydrate-visible">Hydrate visible</button>
                <button data-role="import-selected" class="primary">Import selected</button>
                <button data-role="import-visible" class="primary">Import visible</button>
            </div>
        `;
        document.body.appendChild(bar);

        bar.querySelector('[data-role="refresh"]').addEventListener('click', () => {
            scanCards();
            toast(`Scan refreshed: ${state.scanInfo.cards} cards from ${state.scanInfo.links} watch links / ${state.scanInfo.media} media`);
        });
        bar.querySelector('[data-role="select-visible"]').addEventListener('click', () => {
            visibleItems().forEach((item) => { item.selected = true; upsertCheckbox(item); });
            updateToolbar();
        });
        bar.querySelector('[data-role="clear"]').addEventListener('click', () => {
            state.items.forEach((item) => { item.selected = false; upsertCheckbox(item); });
            updateToolbar();
        });
        bar.querySelector('[data-role="hydrate-selected"]').addEventListener('click', () => hydrateAndRefresh(selectedItems()));
        bar.querySelector('[data-role="hydrate-visible"]').addEventListener('click', () => hydrateAndRefresh(visibleItems()));
        bar.querySelector('[data-role="import-selected"]').addEventListener('click', () => importItems(selectedItems()));
        bar.querySelector('[data-role="import-visible"]').addEventListener('click', () => importItems(visibleItems()));
        updateToolbar();
    }

    function setBusy(next) {
        state.busy = !!next;
        const toolbar = document.getElementById(TOOLBAR_ID);
        if (toolbar) toolbar.dataset.busy = next ? '1' : '0';
        updateToolbar();
    }

    function mergeHydratedItems(items) {
        (items || []).forEach((entry) => {
            const existing = state.items.get(entry.id);
            if (!existing) return;
            Object.assign(existing, entry);
            upsertCheckbox(existing);
        });
        updateToolbar();
    }

    function buildPayload(items) {
        return items.map(({ id, page_url, video_url, title, thumbnail, tags, duration, durationLabel, width, height, file_size_mb, size_mb, filesize }) => ({
            id,
            page_url,
            video_url,
            title,
            thumbnail,
            tags,
            duration,
            durationLabel,
            width,
            height,
            file_size_mb: Number(file_size_mb || size_mb || filesize || 0) || 0,
        }));
    }

    function hydrateAndRefresh(items) {
        const payload = buildPayload(items);
        if (!payload.length) return;
        setBusy(true);
        chrome.runtime.sendMessage({ action: 'REDGIFS_HYDRATE_ITEMS', items: payload }, (res) => {
            setBusy(false);
            if (!res?.ok) {
                toast(`Hydrate failed: ${res?.error || 'Unknown error'}`, true);
                return;
            }
            mergeHydratedItems(res.items || []);
            toast(`Hydrated ${res.items?.length || 0} RedGIFs cards`);
        });
    }

    function importItems(items) {
        const payload = buildPayload(items);
        if (!payload.length) return;
        setBusy(true);
        chrome.runtime.sendMessage({ action: 'REDGIFS_IMPORT_BULK', batchName: 'RedGIFs Extension', items: payload }, (res) => {
            setBusy(false);
            if (!res?.ok) {
                toast(`Import failed: ${res?.error || 'Unknown error'}`, true);
                return;
            }
            toast(`Queued ${res.data?.count || 0} RedGIFs items`);
        });
    }

    function boot() {
        createToolbar();
        scanCards();
        setTimeout(scanCards, 600);
        setTimeout(scanCards, 1800);
        setInterval(scanCards, SCAN_INTERVAL_MS);
        new MutationObserver(() => {
            const hash = `${location.href}|${document.body?.innerText?.length || 0}`;
            if (hash === state.lastHash) return;
            state.lastHash = hash;
            scanCards();
        }).observe(document.documentElement, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
