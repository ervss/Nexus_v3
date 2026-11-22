(function () {
    'use strict';

    if (window.top !== window) return;
    if (!/(^|\.)epalovo\.com$/i.test(location.hostname)) return;

    const TOOLBAR_ID = 'nexus-epalovo-toolbar';
    const TOAST_ID = 'nexus-epalovo-toast';
    const CHECKBOX_CLASS = 'nexus-epalovo-check';
    const META_CLASS = 'nexus-epalovo-meta';
    const CARD_SELECTED_CLASS = 'nexus-epalovo-selected';
    const SCAN_INTERVAL_MS = 1800;

    const state = {
        items: new Map(),
        selectedIds: new Set(),
        busy: false,
        lastSignature: '',
    };

    // ── Utilities ──────────────────────────────────────────────────────────────

    function normalizeKey(rawUrl) {
        const raw = String(rawUrl || '').trim();
        if (!raw) return '';
        try {
            const url = new URL(raw, location.href);
            const pathname = url.pathname.replace(/\/+$/, '');
            // epalovo (KVS) video URLs look like /video/{slug}/
            const match = pathname.match(/\/video\/([^/]+)/i);
            if (match?.[1]) return `epalovo-${match[1].toLowerCase()}`;
            return `${url.hostname.replace(/^www\./i, '')}${pathname}`.toLowerCase();
        } catch {
            return raw.toLowerCase();
        }
    }

    function toast(message, isError) {
        let el = document.getElementById(TOAST_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = TOAST_ID;
            el.className = 'nexus-epalovo-toast';
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

    // ── DOM Card Detection ─────────────────────────────────────────────────────
    // epalovo (KVS engine) grid: each card is an <a href="/video/{slug}/"> with an
    // <img> thumbnail from img.ebacdn.com and a duration badge overlay.

    function isEpalovoVideoLink(a) {
        const href = a.getAttribute('href') || '';
        if (!href) return false;
        // Accept relative or absolute, but only /video/ paths
        try {
            const u = new URL(href, location.href);
            if (!/(^|\.)epalovo\.com$/i.test(u.hostname)) return false;
            if (!/^\/video\/[^/]+/i.test(u.pathname)) return false;
        } catch {
            return false;
        }
        return !!a.querySelector('img');
    }

    function getCardNodes() {
        const seen = new Set();
        const results = [];

        document.querySelectorAll('a[href]').forEach((link) => {
            if (!isEpalovoVideoLink(link)) return;

            // Walk up max 4 levels to find the card wrapper
            let node = link;
            for (let i = 0; i < 4; i++) {
                const parent = node.parentElement;
                if (!parent || parent === document.body || parent === document.documentElement) break;
                const childLinks = parent.querySelectorAll('a[href]');
                if (childLinks.length > 3) break;
                node = parent;
            }

            if (seen.has(node)) return;
            seen.add(node);
            results.push(node);
        });

        return results;
    }

    function collectCard(node) {
        const link = node.tagName === 'A' ? node : node.querySelector('a[href]');
        if (!link || !isEpalovoVideoLink(link)) return null;

        const url = new URL(link.getAttribute('href'), location.href).href;

        const img = node.querySelector('img');
        let thumbnail = img?.getAttribute('data-src') ||
                        img?.getAttribute('data-original') ||
                        img?.getAttribute('data-lazy') ||
                        img?.getAttribute('src') ||
                        img?.src || '';
        if (thumbnail.startsWith('//')) thumbnail = `https:${thumbnail}`;

        // Duration badge — KVS overlays text like "12:34"
        const durationEl = node.querySelector(
            '.duration, .dur, .video-duration, .time, .length, ' +
            '[class*="dur"], [class*="time"], [class*="length"]'
        );
        let durationLabel = durationEl?.textContent?.trim() || '';
        if (!durationLabel) {
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
            let tn;
            while ((tn = walker.nextNode())) {
                const t = tn.textContent.trim();
                if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) { durationLabel = t; break; }
            }
        }

        // Title — KVS cards use the link's title attr, an inner .title, or img alt
        const titleEl = node.querySelector('.title, .video-title, .name, [class*="title"]');
        const title = (titleEl?.textContent?.trim()) ||
                      link.getAttribute('title') ||
                      img?.getAttribute('alt') ||
                      link.textContent?.trim() ||
                      'Epalovo Video';

        const key = normalizeKey(url) || url;

        return {
            id: key,
            url,
            source_url: url,
            title: String(title || '').trim() || 'Epalovo Video',
            thumbnail,
            duration: parseDurationText(durationLabel),
            card: node,
            selected: state.selectedIds.has(key) || !!state.items.get(key)?.selected,
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
        toolbar.querySelector('.nexus-epalovo-stats').textContent = `${selected} selected / ${visible} cards`;
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
            box.addEventListener('mousedown', (e) => e.stopPropagation());
            box.addEventListener('click', (e) => e.stopPropagation());
            const input = box.querySelector('input');
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
        const chips = [];
        if (item.duration > 0) chips.push(formatDuration(item.duration));
        const shortTitle = item.title.length > 40 ? `${item.title.slice(0, 40)}…` : item.title;
        chips.push(shortTitle);
        badge.textContent = chips.join(' · ');
    }

    function scanCards() {
        const seen = new Set();
        getCardNodes().forEach((node) => {
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
        updateToolbar();
    }

    function createToolbar() {
        if (document.getElementById(TOOLBAR_ID)) return;
        const toolbar = document.createElement('div');
        toolbar.id = TOOLBAR_ID;
        toolbar.className = 'nexus-epalovo-toolbar';
        toolbar.innerHTML = `
            <div class="nexus-epalovo-title">⚡ Epalovo Quick Import</div>
            <div class="nexus-epalovo-stats">0 selected / 0 cards</div>
            <div class="nexus-epalovo-actions">
                <button data-role="refresh">Refresh</button>
                <button data-role="select">Select all</button>
                <button data-role="clear">Clear</button>
                <button data-role="copy-urls" title="Copy selected URLs to clipboard">Copy URLs</button>
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
            state.items.forEach((item) => {
                item.selected = false;
                upsertCardUI(item);
            });
            state.selectedIds.clear();
            updateToolbar();
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
            importSelected().catch((err) => toast(err?.message || 'Import failed', true));
        });

        updateToolbar();
    }

    // ── Import ─────────────────────────────────────────────────────────────────
    // KVS stream extraction (license-obfuscated video_url) is brittle to do in the
    // page, so we hand each video page to the background → backend browser-fetch
    // route, which runs the proven server-side KVS extractor (same path sxyprn
    // uses). The grid metadata (title/thumb) we already have is passed along.

    function setBusy(next) {
        state.busy = !!next;
        updateToolbar();
    }

    async function importSelected() {
        const picked = selectedItems();
        if (!picked.length) return;
        setBusy(true);
        try {
            const items = picked.map((entry) => ({
                url: entry.url,
                source_url: entry.source_url || entry.url,
                title: entry.title || 'Epalovo Video',
                thumbnail: entry.thumbnail || '',
                duration: Number(entry.duration || 0) || 0,
            })).filter((entry) => entry.url);

            if (!items.length) throw new Error('No importable videos found');

            const pageTitle = (document.title || '').replace(/\s*[-|–].*$/, '').trim();
            const batchName = `Epalovo: ${pageTitle || location.pathname.replace(/\/+$/, '').split('/').pop() || 'import'}`;

            toast(`Importing ${items.length} video${items.length !== 1 ? 's' : ''}…`);
            const res = await new Promise((resolve) => {
                chrome.runtime.sendMessage({
                    action: 'EPALOVO_IMPORT_BULK',
                    batchName,
                    items,
                }, resolve);
            });
            if (!res?.ok) throw new Error(res?.error || 'Dashboard import failed');

            const imported = res.imported ?? items.length;
            const failed = res.total ? (res.total - imported) : 0;
            toast(`Imported ${imported}${failed ? ` · ${failed} failed` : ''}`, failed > 0 && imported === 0);
            state.items.forEach((item) => {
                item.selected = false;
                upsertCardUI(item);
            });
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
            const signature = `${location.href}|${document.body?.innerText?.length || 0}|${getCardNodes().length}`;
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
