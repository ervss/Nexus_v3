// Nexus Importer - 1porn.tv content script
// Grid pages: checkboxes + bulk import toolbar
// Watch pages: "Import to Nexus" button using background-captured stream
(function () {
    'use strict';

    if (window.top !== window) return;
    if (!/(^|\.)1porn\.tv$/i.test(location.hostname)) return;

    const TOOLBAR_ID          = 'nexus-1p-toolbar';
    const TOAST_ID            = 'nexus-1p-toast';
    const CHECKBOX_CLASS      = 'nexus-1p-check';
    const CARD_SELECTED_CLASS = 'nexus-1p-selected';
    const SCAN_INTERVAL_MS    = 1800;
    const DETAIL_CONCURRENCY  = 3;

    const state = {
        items: new Map(),
        selectedIds: new Set(),
        busy: false,
        lastSignature: '',
    };

    // ── Helpers ──────────────────────────────────────────────────────────────────

    function toast(msg, isError) {
        let el = document.getElementById(TOAST_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = TOAST_ID;
            el.style.cssText = [
                'position:fixed;bottom:24px;right:24px;z-index:2147483647',
                'color:#fff;font:600 13px/1.4 sans-serif;padding:10px 16px',
                'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.6)',
                'pointer-events:none;opacity:0;transition:opacity .25s',
                'max-width:360px;word-break:break-word',
            ].join(';');
            document.body.appendChild(el);
        }
        el.style.background = isError ? '#c0392b' : '#27ae60';
        el.textContent = String(msg || '');
        el.style.opacity = '1';
        clearTimeout(el._t);
        el._t = setTimeout(() => { el.style.opacity = '0'; }, 3200);
    }

    function parseDurationText(raw) {
        const t = String(raw || '').trim();
        const parts = t.split(':').map(Number);
        if (parts.some(n => !Number.isFinite(n))) return 0;
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        return 0;
    }

    function parseIsoDuration(raw) {
        const m = String(raw || '').match(/P(?:T)?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
        if (!m) return 0;
        return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
    }

    function sendMsg(payload) {
        return new Promise(resolve => chrome.runtime.sendMessage(payload, r => resolve(r)));
    }

    // ── CSS ──────────────────────────────────────────────────────────────────────

    function injectCss() {
        if (document.getElementById('nexus-1p-css')) return;
        const s = document.createElement('style');
        s.id = 'nexus-1p-css';
        s.textContent = `
#${TOOLBAR_ID} {
    position:fixed;bottom:16px;left:50%;transform:translateX(-50%);
    z-index:2147483646;display:flex;align-items:center;gap:8px;
    background:#1a1a2e;border:1px solid #555;border-radius:10px;
    padding:8px 14px;box-shadow:0 4px 20px rgba(0,0,0,.7);
    font:600 13px/1 sans-serif;color:#eee;white-space:nowrap;
}
#${TOOLBAR_ID}[data-busy="1"] { opacity:.7;pointer-events:none; }
#${TOOLBAR_ID} .n1p-stats { color:#f39c12;min-width:90px; }
#${TOOLBAR_ID} button {
    cursor:pointer;border:none;border-radius:6px;
    padding:6px 14px;font:600 13px/1 sans-serif;
}
#${TOOLBAR_ID} [data-role="import"]  { background:#e74c3c;color:#fff; }
#${TOOLBAR_ID} [data-role="import"]:hover { background:#c0392b; }
#${TOOLBAR_ID} [data-role="select"]  { background:#2980b9;color:#fff; }
#${TOOLBAR_ID} [data-role="select"]:hover { background:#1c6ea4; }
#${TOOLBAR_ID} [data-role="clear"]   { background:#444;color:#ccc; }
#${TOOLBAR_ID} [data-role="clear"]:hover { background:#555; }
.${CHECKBOX_CLASS} {
    position:absolute;top:6px;left:6px;z-index:9999;
    width:20px;height:20px;cursor:pointer;accent-color:#e74c3c;
    filter:drop-shadow(0 1px 2px #000);
}
.${CARD_SELECTED_CLASS} { outline:3px solid #e74c3c !important;border-radius:4px; }
#nexus-1p-watch-btn {
    display:inline-flex;align-items:center;gap:6px;vertical-align:middle;
    background:#e74c3c;color:#fff;border:none;border-radius:6px;
    padding:7px 15px;font:600 13px/1 sans-serif;cursor:pointer;margin-left:10px;
}
#nexus-1p-watch-btn:hover { background:#c0392b; }
#nexus-1p-watch-btn:disabled { background:#777;cursor:default; }
        `;
        document.head.appendChild(s);
    }

    // ── Page type ─────────────────────────────────────────────────────────────────

    function isWatchPage() {
        return /^\/videos\/[^/]+/i.test(location.pathname);
    }

    // ── Card scanning (grid pages) ────────────────────────────────────────────────

    function getCardNodes() {
        // 1porn.tv uses various wrapper class names; we anchor on links to /videos/
        const seen = new Set();
        const results = [];
        document.querySelectorAll('a[href*="/videos/"]').forEach(link => {
            // Walk up to find the card container (max 4 levels)
            let node = link.parentElement;
            for (let i = 0; i < 4 && node && node !== document.body; i++) {
                const rect = node.getBoundingClientRect();
                if (rect.width > 100 && rect.height > 100) break;
                node = node.parentElement;
            }
            if (!node || seen.has(node)) return;
            // Must contain an image (real card, not nav link)
            if (!node.querySelector('img')) return;
            seen.add(node);
            results.push(node);
        });
        return results;
    }

    function cardKey(node) {
        const link = node.querySelector('a[href*="/videos/"]');
        if (!link) return '';
        try {
            const u = new URL(link.href, location.href);
            return u.pathname.replace(/\/+$/, '').toLowerCase();
        } catch {
            return String(link.href || '').toLowerCase();
        }
    }

    function collectCard(node) {
        const link = node.querySelector('a[href*="/videos/"]');
        if (!link) return null;
        const url = new URL(link.href, location.href).href;
        const img  = node.querySelector('img');
        let thumbnail = img?.getAttribute('data-src') || img?.getAttribute('src') || img?.src || '';
        if (thumbnail.startsWith('//')) thumbnail = `https:${thumbnail}`;
        const durationEl = node.querySelector('.duration,.time,.vtime,[class*="duration"],[class*="time"]');
        const title =
            link.getAttribute('title')
            || node.querySelector('[class*="title"],[class*="name"]')?.textContent?.trim()
            || img?.getAttribute('alt')
            || '1Porn Video';
        const key = cardKey(node);
        return {
            id: key,
            url,
            source_url: url,
            title: String(title).trim() || '1Porn Video',
            thumbnail,
            duration: parseDurationText(durationEl?.textContent || ''),
            card: node,
            selected: state.selectedIds.has(key),
        };
    }

    function visibleItems() {
        return Array.from(state.items.values()).filter(item => item.card?.isConnected);
    }

    function selectedItems() {
        return visibleItems().filter(item => item.selected);
    }

    // ── Card enrichment (fetch video page for LD+JSON / direct URL) ───────────────

    function findVideoJsonLd(doc) {
        for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
            try {
                const data = JSON.parse(script.textContent || '{}');
                const items = Array.isArray(data) ? data : (data['@graph'] ? [data, ...data['@graph']] : [data]);
                for (const item of items) {
                    if (/VideoObject/i.test(String(item?.['@type'] || ''))) return item;
                }
            } catch { /* skip */ }
        }
        return null;
    }

    async function enrichItem(item) {
        try {
            const resp = await fetch(item.url, { credentials: 'include' });
            if (!resp.ok) return item;
            const html = await resp.text();
            const doc  = new DOMParser().parseFromString(html, 'text/html');
            const ld   = findVideoJsonLd(doc) || {};

            // Try to extract direct MP4/HLS URL from page source
            let directUrl = String(ld.contentUrl || '').trim();

            if (!directUrl) {
                const m = html.match(/"(?:file|src|videoUrl|contentUrl)"\s*:\s*"(https?:[^"]+\.(?:mp4|m3u8)[^"]*)"/i);
                if (m) directUrl = m[1].replace(/\\\//g, '/');
            }

            const thumb    = (Array.isArray(ld.thumbnailUrl) ? ld.thumbnailUrl.at(-1) : ld.thumbnailUrl)
                           || ld.image || item.thumbnail || '';
            const duration = parseIsoDuration(ld.duration) || item.duration || 0;
            const height   = Number(ld.height || 0) || 0;
            const width    = Number(ld.width  || 0) || 0;

            const tags = Array.from(doc.querySelectorAll('a[href*="/tags/"],a[href*="/tag/"]'))
                .map(a => a.textContent.trim()).filter(Boolean);
            const categories = Array.from(doc.querySelectorAll('a[href*="/categor"]'))
                .map(a => a.textContent.trim()).filter(Boolean);

            return { ...item, directUrl, thumbnail: thumb || item.thumbnail, duration, height, width, tags, categories };
        } catch {
            return item;
        }
    }

    async function hydrateItems(items) {
        const out = [];
        for (let i = 0; i < items.length; i += DETAIL_CONCURRENCY) {
            const chunk = items.slice(i, i + DETAIL_CONCURRENCY);
            out.push(...await Promise.all(chunk.map(enrichItem)));
            toast(`Preparing ${Math.min(i + chunk.length, items.length)}/${items.length}…`);
        }
        return out;
    }

    // ── Bulk import via background.js (reuses EPORNER_IMPORT_BULK handler) ────────

    async function importSelected() {
        const picked = selectedItems();
        if (!picked.length) return;
        setBusy(true);
        try {
            const hydrated = await hydrateItems(picked);
            const videos = hydrated.map(e => ({
                url:        e.directUrl || e.url,
                source_url: e.source_url || e.url,
                title:      e.title || '1Porn Video',
                thumbnail:  e.thumbnail || '',
                duration:   Number(e.duration || 0) || 0,
                width:      Number(e.width    || 0) || 0,
                height:     Number(e.height   || 0) || 0,
                tags:       Array.isArray(e.tags) ? e.tags : [],
                categories: Array.isArray(e.categories) ? e.categories : [],
            })).filter(v => v.url);

            if (!videos.length) throw new Error('No importable videos found');

            const batchName = `1Porn Quick Import: ${document.title.trim()}`;
            const res = await sendMsg({ action: 'EPORNER_IMPORT_BULK', batchName, items: videos });
            if (!res?.ok) throw new Error(res?.error || 'Dashboard import failed');

            toast(`Imported ${res.imported || videos.length} video(s)`);
            state.items.forEach(item => { item.selected = false; upsertCardUI(item); });
            state.selectedIds.clear();
            updateToolbar();
        } catch (e) {
            toast(e?.message || 'Import failed', true);
        } finally {
            setBusy(false);
        }
    }

    // ── Card UI ───────────────────────────────────────────────────────────────────

    function upsertCardUI(item) {
        const card = item.card;
        if (!card) return;
        if (getComputedStyle(card).position === 'static') card.style.position = 'relative';

        let cb = card.querySelector(`.${CHECKBOX_CLASS}`);
        if (!cb) {
            cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = CHECKBOX_CLASS;
            cb.addEventListener('mousedown', e => e.stopPropagation());
            cb.addEventListener('click',     e => e.stopPropagation());
            cb.addEventListener('change', () => {
                item.selected = cb.checked;
                if (item.selected) state.selectedIds.add(item.id);
                else               state.selectedIds.delete(item.id);
                card.classList.toggle(CARD_SELECTED_CLASS, item.selected);
                updateToolbar();
            });
            card.appendChild(cb);
        }
        cb.checked = !!item.selected;
        card.classList.toggle(CARD_SELECTED_CLASS, !!item.selected);
    }

    function scanCards() {
        const seen = new Set();
        getCardNodes().forEach(node => {
            const card = collectCard(node);
            if (!card) return;
            seen.add(card.id);
            const existing = state.items.get(card.id) || {};
            const merged = { ...existing, ...card, selected: state.selectedIds.has(card.id) || !!existing.selected };
            state.items.set(card.id, merged);
            upsertCardUI(merged);
        });
        state.items.forEach((item, id) => {
            if (!seen.has(id) || !item?.card?.isConnected) state.items.delete(id);
        });
        updateToolbar();
    }

    // ── Toolbar ───────────────────────────────────────────────────────────────────

    function setBusy(val) {
        state.busy = !!val;
        updateToolbar();
    }

    function updateToolbar() {
        let bar = document.getElementById(TOOLBAR_ID);
        if (!bar) {
            bar = document.createElement('div');
            bar.id = TOOLBAR_ID;
            bar.innerHTML = `
                <span class="n1p-stats"></span>
                <button data-role="select">Select page</button>
                <button data-role="clear">Clear</button>
                <button data-role="import">⬇ Import selected</button>
            `;
            bar.querySelector('[data-role="select"]').addEventListener('click', () => {
                visibleItems().forEach(item => {
                    item.selected = true;
                    state.selectedIds.add(item.id);
                    upsertCardUI(item);
                });
                updateToolbar();
            });
            bar.querySelector('[data-role="clear"]').addEventListener('click', () => {
                state.items.forEach(item => { item.selected = false; upsertCardUI(item); });
                state.selectedIds.clear();
                updateToolbar();
            });
            bar.querySelector('[data-role="import"]').addEventListener('click', () => {
                importSelected();
            });
            document.body.appendChild(bar);
        }

        const sel = selectedItems().length;
        const vis = visibleItems().length;
        bar.querySelector('.n1p-stats').textContent = `${sel} / ${vis} selected`;
        bar.querySelector('[data-role="import"]').disabled = sel === 0 || state.busy;
        bar.querySelector('[data-role="clear"]').disabled  = sel === 0 || state.busy;
        bar.querySelector('[data-role="select"]').disabled = vis === 0 || state.busy;
        bar.dataset.busy = state.busy ? '1' : '0';
    }

    // ── Watch page ────────────────────────────────────────────────────────────────

    function setupWatchPage() {
        if (document.getElementById('nexus-1p-watch-btn')) return;

        const anchor = document.querySelector(
            '.video-actions,.video-buttons,.watch-buttons,.btn-group,[class*="video-actions"],[class*="watch-actions"],.download-btn,h1,[class*="title"]'
        );
        if (!anchor) return;

        const btn = document.createElement('button');
        btn.id = 'nexus-1p-watch-btn';
        btn.textContent = '⬇ Nexus Import';

        btn.addEventListener('click', async () => {
            if (state.busy) return;
            btn.disabled = true;
            btn.textContent = 'Capturing…';

            // Try background-captured stream first
            const captured = await sendMsg({
                action: 'GET_CAPTURED_STREAM',
                pageUrl: location.href,
                duration: 0,
            });
            const streamUrl = String(captured?.streamUrl || '').trim();

            if (!streamUrl || streamUrl.startsWith('blob:')) {
                toast('No stream captured yet — press Play and wait a moment, then try again', true);
                btn.textContent = '⬇ Nexus Import';
                btn.disabled = false;
                return;
            }

            // Build metadata from page
            const ld = (() => {
                for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
                    try {
                        const d = JSON.parse(s.textContent || '{}');
                        const arr = Array.isArray(d) ? d : (d['@graph'] ? [d, ...d['@graph']] : [d]);
                        for (const item of arr) {
                            if (/VideoObject/i.test(String(item?.['@type'] || ''))) return item;
                        }
                    } catch { /* skip */ }
                }
                return {};
            })();

            const title    = String(ld.name || document.querySelector('h1')?.textContent || document.title || '').trim() || '1Porn Video';
            const thumb    = String((Array.isArray(ld.thumbnailUrl) ? ld.thumbnailUrl.at(-1) : ld.thumbnailUrl) || ld.image || '').trim();
            const duration = parseIsoDuration(ld.duration) || 0;

            const videos = [{
                url:        streamUrl,
                source_url: location.href,
                title,
                thumbnail:  thumb,
                duration,
                tags:       [],
                categories: [],
            }];

            try {
                const res = await sendMsg({
                    action: 'EPORNER_IMPORT_BULK',
                    batchName: `1Porn: ${title}`,
                    items: videos,
                });
                if (!res?.ok) throw new Error(res?.error || 'Import failed');
                toast(`Imported: ${title}`);
                btn.textContent = '✓ Imported!';
                setTimeout(() => { btn.textContent = '⬇ Nexus Import'; btn.disabled = false; }, 3000);
            } catch (e) {
                toast(e?.message || 'Import failed', true);
                btn.textContent = '⬇ Nexus Import';
                btn.disabled = false;
            }
        });

        // Insert right after anchor
        anchor.insertAdjacentElement('afterend', btn);
    }

    // ── Init ──────────────────────────────────────────────────────────────────────

    function boot() {
        injectCss();

        if (isWatchPage()) {
            const tryMount = () => {
                setupWatchPage();
                if (!document.getElementById('nexus-1p-watch-btn')) setTimeout(tryMount, 800);
            };
            tryMount();
        } else {
            createToolbar();
            scanCards();
            setInterval(scanCards, SCAN_INTERVAL_MS);
            new MutationObserver(() => {
                const sig = `${location.href}|${getCardNodes().length}`;
                if (sig === state.lastSignature) return;
                state.lastSignature = sig;
                scanCards();
            }).observe(document.documentElement, { childList: true, subtree: true });
        }
    }

    function createToolbar() {
        updateToolbar(); // creates it if missing
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
