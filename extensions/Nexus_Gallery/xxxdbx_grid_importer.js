(function () {
    'use strict';

    if (window.top !== window) return;
    if (!/(^|\.)xxxdbx\.com$/i.test(location.hostname)) return;

    const TOOLBAR_ID = 'nexus-xxxdbx-toolbar';
    const TOAST_ID = 'nexus-xxxdbx-toast';
    const CHECKBOX_CLASS = 'nexus-xxxdbx-check';
    const META_CLASS = 'nexus-xxxdbx-meta';
    const CARD_SELECTED_CLASS = 'nexus-xxxdbx-selected';
    const SCAN_INTERVAL_MS = 1600;
    const META_CONCURRENCY = 4;

    const state = {
        items: new Map(),
        selectedIds: new Set(),
        busy: false,
        lastSignature: '',
        metaCache: new Map(),   // id -> {height, sizeMb, streamUrl}
        metaQueue: [],
        metaQueued: new Set(),
        metaActive: 0,
        sortKey: 'none',        // 'none' | 'size' | 'duration'
        sortDir: 'desc',
        origIndex: new Map(),   // id -> original DOM order (for stable 'none')
    };

    // ── Utilities ──────────────────────────────────────────────────────────────

    function viewId(href) {
        const m = String(href || '').match(/\/view\/(\d+)/i);
        return m ? m[1] : '';
    }

    function toast(message, isError) {
        let el = document.getElementById(TOAST_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = TOAST_ID;
            el.className = 'nexus-xxxdbx-toast';
            document.body.appendChild(el);
        }
        el.textContent = String(message || '').trim() || (isError ? 'Import failed' : 'Done');
        el.dataset.error = isError ? '1' : '0';
        el.classList.add('visible');
        clearTimeout(el._timer);
        el._timer = setTimeout(() => el.classList.remove('visible'), 3200);
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

    function formatDuration(seconds) {
        const total = Math.max(0, Number(seconds || 0));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = Math.floor(total % 60);
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function formatSize(mb) {
        const v = Number(mb || 0);
        if (v <= 0) return '';
        if (v >= 1024) return `${(v / 1024).toFixed(2)} GB`;
        return `${Math.round(v)} MB`;
    }

    // ── Card detection ─────────────────────────────────────────────────────────
    // xxxdbx card: <a href="/view/<id>"><div class="v_width">…
    //   <img class="v_pic" src|data-src="/thumb.jpg"><div class="v_dur">MM:SS</div>
    //   <div class="v_title">Title</div></a>

    function getCardLinks() {
        return Array.from(document.querySelectorAll('a[href^="/view/"], a[href*="xxxdbx.com/view/"]'))
            .filter((a) => a.querySelector('img.v_pic, .v_thumb img, img'));
    }

    function collectCard(link) {
        const rawHref = link.getAttribute('href') || '';
        const id = viewId(rawHref);
        if (!id) return null;
        const url = new URL(rawHref, location.href).href;

        const img = link.querySelector('img.v_pic') || link.querySelector('img');
        let thumbnail = img?.getAttribute('data-src') ||
                        img?.getAttribute('data-original') ||
                        (img && !/spinner\.svg/i.test(img.getAttribute('src') || '') ? img.getAttribute('src') : '') ||
                        '';
        if (thumbnail && !/^https?:/i.test(thumbnail)) {
            thumbnail = new URL(thumbnail, location.href).href;
        }

        const durLabel = (link.querySelector('.v_dur')?.textContent || '').trim();
        const title = (link.querySelector('.v_title')?.textContent || '').trim() ||
                      link.getAttribute('title') ||
                      img?.getAttribute('alt') ||
                      'Xxxdbx Video';

        return {
            id: `xxxdbx-${id}`,
            url,
            source_url: url,
            title: String(title || '').trim() || 'Xxxdbx Video',
            thumbnail,
            duration: parseDurationText(durLabel),
            card: link,
            wrapper: link.closest('.v') || link,   // reorderable grid cell
            selected: state.selectedIds.has(`xxxdbx-${id}`) || !!state.items.get(`xxxdbx-${id}`)?.selected,
        };
    }

    function visibleItems() {
        return Array.from(state.items.values()).filter((item) => {
            if (!item.card || !item.card.isConnected) return false;
            const style = window.getComputedStyle(item.card);
            return style.display !== 'none' && style.visibility !== 'hidden';
        });
    }

    function selectedItems() {
        return visibleItems().filter((item) => item.selected);
    }

    // ── Toolbar ────────────────────────────────────────────────────────────────

    function updateToolbar() {
        const toolbar = document.getElementById(TOOLBAR_ID);
        if (!toolbar) return;
        const selected = selectedItems().length;
        const visible = visibleItems().length;
        toolbar.querySelector('.nexus-xxxdbx-stats').textContent = `${selected} selected / ${visible} cards`;
        toolbar.querySelector('[data-role="import"]').disabled = selected === 0 || state.busy;
        toolbar.querySelector('[data-role="copy-urls"]').disabled = selected === 0;
        toolbar.querySelector('[data-role="clear"]').disabled = selected === 0 || state.busy;
        toolbar.querySelector('[data-role="select"]').disabled = visible === 0 || state.busy;
        toolbar.dataset.busy = state.busy ? '1' : '0';
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
            ['mousedown', 'click'].forEach((ev) => box.addEventListener(ev, (e) => { e.stopPropagation(); e.preventDefault(); }));
            const input = box.querySelector('input');
            input.addEventListener('click', (e) => e.stopPropagation());
            input.addEventListener('change', (e) => {
                item.selected = !!e.target.checked;
                if (item.selected) state.selectedIds.add(item.id);
                else state.selectedIds.delete(item.id);
                card.classList.toggle(CARD_SELECTED_CLASS, item.selected);
                updateToolbar();
            });
            card.appendChild(box);
        }
        const input = box.querySelector('input');
        input.checked = !!item.selected;
        card.classList.toggle(CARD_SELECTED_CLASS, !!item.selected);

        let badge = card.querySelector(`.${META_CLASS}`);
        if (!badge) {
            badge = document.createElement('div');
            badge.className = META_CLASS;
            card.appendChild(badge);
        }
        const meta = state.metaCache.get(item.id);
        const chips = [];
        if (item.duration > 0) chips.push(formatDuration(item.duration));
        if (meta && meta.height) chips.push(`${meta.height}p`);
        if (meta && meta.sizeMb > 0) {
            chips.push(formatSize(meta.sizeMb));
        } else if (meta && meta.error) {
            chips.push('✓ ready');
        } else {
            chips.push('⏳ size…');
            badge.classList.add('nexus-xxxdbx-meta-loading');
        }
        if (meta && (meta.sizeMb > 0 || meta.error)) badge.classList.remove('nexus-xxxdbx-meta-loading');
        badge.textContent = chips.join(' · ');
    }

    function scanCards() {
        // Merge any newly-appended page blocks (Pagetual etc.) into one grid first,
        // so cards are all siblings and sorting spans the whole collection.
        mergeContainers();
        const seen = new Set();
        getCardLinks().forEach((link) => {
            const card = collectCard(link);
            if (!card) return;
            seen.add(card.id);
            if (!state.origIndex.has(card.id)) state.origIndex.set(card.id, state.origIndex.size);
            const existing = state.items.get(card.id) || {};
            // keep a thumbnail once resolved (lazy imgs may revert to spinner)
            const thumbnail = card.thumbnail || existing.thumbnail || '';
            const merged = { ...existing, ...card, thumbnail, selected: state.selectedIds.has(card.id) || !!existing.selected };
            state.items.set(card.id, merged);
            upsertCardUI(merged);
        });
        Array.from(state.items.keys()).forEach((id) => {
            const item = state.items.get(id);
            if (!seen.has(id) || !item?.card?.isConnected) state.items.delete(id);
        });
        // Queue file-size / quality scan for cards we haven't resolved yet
        state.items.forEach((item) => {
            if (!state.metaCache.has(item.id) && !state.metaQueued.has(item.id)) {
                state.metaQueued.add(item.id);
                state.metaQueue.push(item);
            }
        });
        pumpMetaQueue();
        updateToolbar();
    }

    // ── File-size / quality scan (per card, throttled via background) ───────────

    function pumpMetaQueue() {
        while (state.metaActive < META_CONCURRENCY && state.metaQueue.length) {
            const item = state.metaQueue.shift();
            if (!item || !item.card || !item.card.isConnected) continue;
            state.metaActive++;
            chrome.runtime.sendMessage({ action: 'XXXDBX_FETCH_META', url: item.url }, (res) => {
                state.metaActive--;
                if (res && res.ok) {
                    state.metaCache.set(item.id, {
                        height: res.height || item.height || 0,
                        sizeMb: res.sizeMb || 0,
                        streamUrl: res.streamUrl || '',
                    });
                } else {
                    state.metaCache.set(item.id, { error: true });
                }
                const cur = state.items.get(item.id);
                if (cur && cur.card && cur.card.isConnected) upsertCardUI(cur);
                if (state.sortKey === 'size') scheduleResort();
                pumpMetaQueue();
            });
        }
    }

    function createToolbar() {
        if (document.getElementById(TOOLBAR_ID)) return;
        const toolbar = document.createElement('div');
        toolbar.id = TOOLBAR_ID;
        toolbar.className = 'nexus-xxxdbx-toolbar';
        toolbar.innerHTML = `
            <div class="nexus-xxxdbx-title">⚡ Xxxdbx Quick Import</div>
            <div class="nexus-xxxdbx-stats">0 selected / 0 cards</div>
            <div class="nexus-xxxdbx-sortrow">
                <label>Sort</label>
                <select data-role="sort-key">
                    <option value="none">Original</option>
                    <option value="size">File size</option>
                    <option value="duration">Duration</option>
                </select>
                <button data-role="sort-dir" title="Toggle direction">↓ Largest</button>
            </div>
            <div class="nexus-xxxdbx-actions">
                <button data-role="refresh">Refresh</button>
                <button data-role="select">Select all</button>
                <button data-role="clear">Clear</button>
                <button data-role="copy-urls" title="Copy selected URLs">Copy URLs</button>
                <button data-role="import" class="primary">Import selected</button>
            </div>
        `;
        document.body.appendChild(toolbar);

        toolbar.querySelector('[data-role="refresh"]').addEventListener('click', () => {
            scanCards();
            toast(`Refreshed ${visibleItems().length} cards`);
        });
        toolbar.querySelector('[data-role="select"]').addEventListener('click', () => {
            visibleItems().forEach((item) => {
                item.selected = true;
                state.selectedIds.add(item.id);
                upsertCardUI(item);
            });
            updateToolbar();
        });
        toolbar.querySelector('[data-role="clear"]').addEventListener('click', () => {
            state.items.forEach((item) => { item.selected = false; upsertCardUI(item); });
            state.selectedIds.clear();
            updateToolbar();
        });
        toolbar.querySelector('[data-role="copy-urls"]').addEventListener('click', () => {
            const picked = selectedItems();
            if (!picked.length) { toast('No videos selected', true); return; }
            const text = picked.map((item) => item.url).join('\n');
            navigator.clipboard.writeText(text)
                .then(() => toast(`Copied ${picked.length} URL${picked.length !== 1 ? 's' : ''}`))
                .catch(() => toast('Copy failed', true));
        });
        toolbar.querySelector('[data-role="import"]').addEventListener('click', () => {
            importSelected().catch((err) => toast(err?.message || 'Import failed', true));
        });

        const sortKeyEl = toolbar.querySelector('[data-role="sort-key"]');
        const sortDirEl = toolbar.querySelector('[data-role="sort-dir"]');
        const refreshDirLabel = () => {
            if (state.sortKey === 'none') { sortDirEl.textContent = '—'; sortDirEl.disabled = true; return; }
            sortDirEl.disabled = false;
            const asc = state.sortDir === 'asc';
            sortDirEl.textContent = state.sortKey === 'duration'
                ? (asc ? '↑ Shortest' : '↓ Longest')
                : (asc ? '↑ Smallest' : '↓ Largest');
        };
        sortKeyEl.addEventListener('change', () => {
            state.sortKey = sortKeyEl.value;
            refreshDirLabel();
            applySort();
            if (state.sortKey === 'size') ensureAllSizesScanned();
        });
        sortDirEl.addEventListener('click', () => {
            state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
            refreshDirLabel();
            applySort();
        });
        refreshDirLabel();

        updateToolbar();
    }

    // ── Sorting ─────────────────────────────────────────────────────────────────
    // Reorders the .v grid cells inside their shared .vids container.

    function sortValue(item) {
        const meta = state.metaCache.get(item.id) || {};
        if (state.sortKey === 'size') return Number(meta.sizeMb || 0);
        if (state.sortKey === 'duration') return Number(item.duration || 0);
        return null;
    }

    let _resortTimer = null;
    function scheduleResort() {
        clearTimeout(_resortTimer);
        _resortTimer = setTimeout(applySort, 400);
    }

    function applySort() {
        if (state.sortKey === 'none') return;
        // Group reorderable wrappers by their parent container
        const groups = new Map();
        state.items.forEach((item) => {
            const w = item.wrapper;
            if (!w || !w.isConnected || !w.parentElement) return;
            const parent = w.parentElement;
            if (!groups.has(parent)) groups.set(parent, []);
            groups.get(parent).push(item);
        });

        const dir = state.sortDir === 'asc' ? 1 : -1;
        groups.forEach((list, parent) => {
            if (list.length < 2) return;
            list.sort((a, b) => {
                const av = sortValue(a);
                const bv = sortValue(b);
                const aMiss = av == null || av <= 0;
                const bMiss = bv == null || bv <= 0;
                // Cards without a scanned value sink to the bottom regardless of dir
                if (aMiss && bMiss) return (state.origIndex.get(a.id) || 0) - (state.origIndex.get(b.id) || 0);
                if (aMiss) return 1;
                if (bMiss) return -1;
                return (av - bv) * dir || ((state.origIndex.get(a.id) || 0) - (state.origIndex.get(b.id) || 0));
            });
            list.forEach((item) => parent.appendChild(item.wrapper));
        });
    }

    // When sorting by size, make sure every card gets scanned (not just the ones
    // near the viewport) so the ordering is complete.
    function ensureAllSizesScanned() {
        let added = false;
        state.items.forEach((item) => {
            if (!state.metaCache.has(item.id) && !state.metaQueued.has(item.id)) {
                state.metaQueued.add(item.id);
                state.metaQueue.push(item);
                added = true;
            }
        });
        if (added) { toast('Scanning file sizes…'); pumpMetaQueue(); }
    }

    // ── Merge stacked page blocks into ONE grid ─────────────────────────────────
    // Auto-scroll pagers (e.g. Pagetual) append each page as a SEPARATE .vids
    // block (often with a "page N" heading). Sorting works per-container, so each
    // block would sort independently. We move every card into the first .vids so
    // both this importer's sort and the selector extension's sort span everything.

    function mergeContainers() {
        const grids = Array.from(document.querySelectorAll('.vids'));
        if (grids.length < 2) return false;
        // Primary = the first grid in DOM order (keeps original position).
        const primary = grids[0];
        let moved = 0;
        for (let i = 1; i < grids.length; i++) {
            const g = grids[i];
            Array.from(g.querySelectorAll(':scope > .v')).forEach((card) => {
                primary.appendChild(card);
                moved++;
            });
            // Hide the now-empty block and any "page N" separator heading right before it.
            if (!g.querySelector('.v')) {
                const prev = g.previousElementSibling;
                if (prev && /page\s*\d+|stránka|str\.?/i.test(prev.textContent || '') && (prev.textContent || '').length < 60) {
                    prev.style.display = 'none';
                }
                g.style.display = 'none';
            }
        }
        return moved > 0;
    }

    // ── Import ─────────────────────────────────────────────────────────────────

    function setBusy(next) { state.busy = !!next; updateToolbar(); }

    async function importSelected() {
        const picked = selectedItems();
        if (!picked.length) return;
        setBusy(true);
        try {
            // No per-item page fetch needed: the backend re-resolves the fresh mp4
            // from the /view/ page at play time (JIT). We import the stable view URL.
            const items = picked.map((entry) => {
                const meta = state.metaCache.get(entry.id) || {};
                return {
                    title: entry.title || 'Xxxdbx Video',
                    url: entry.url,             // stable /view/ page — JIT-resolved on playback
                    source_url: entry.source_url || entry.url,
                    thumbnail: entry.thumbnail || '',
                    duration: Number(entry.duration || 0) || 0,
                    height: Number(meta.height || entry.height || 0) || 0,
                    quality: meta.height ? `${meta.height}p` : '',
                    file_size_mb: Number(meta.sizeMb || 0) || 0,
                    tags: ['xxxdbx'],
                };
            }).filter((entry) => entry.url);

            if (!items.length) throw new Error('No importable videos found');

            const batchName = `Xxxdbx Quick Import: ${document.title.replace(/\s*–\s*xx?dbx.*$/i, '').trim() || 'gallery'}`;
            const res = await new Promise((resolve) => {
                chrome.runtime.sendMessage({ action: 'XXXDBX_IMPORT_BULK', batchName, items }, resolve);
            });
            if (!res?.ok) throw new Error(res?.error || 'Dashboard import failed');

            toast(`Imported ${res.imported || items.length} videos ✓`);
            state.items.forEach((item) => { item.selected = false; upsertCardUI(item); });
            state.selectedIds.clear();
            updateToolbar();
        } finally {
            setBusy(false);
        }
    }

    // ── Boot ───────────────────────────────────────────────────────────────────

    function boot() {
        createToolbar();
        scanCards();
        setInterval(scanCards, SCAN_INTERVAL_MS);
        new MutationObserver(() => {
            const signature = `${location.href}|${getCardLinks().length}`;
            if (signature === state.lastSignature) return;
            state.lastSignature = signature;
            scanCards();
        }).observe(document.documentElement, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
