(function () {
    'use strict';

    if (window.top !== window) return;
    if (!/(^|\.)fuq\.com$/i.test(location.hostname)) return;

    const TOOLBAR_ID = 'nexus-fuq-toolbar';
    const TOAST_ID = 'nexus-fuq-toast';
    const CHECKBOX_CLASS = 'nexus-fuq-check';
    const META_CLASS = 'nexus-fuq-meta';
    const CARD_SELECTED_CLASS = 'nexus-fuq-selected';
    const SCAN_INTERVAL_MS = 1800;
    const DETAIL_CONCURRENCY = 3;

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
            // fuq.com video URLs are like /video/123456/slug/
            const match = pathname.match(/\/video\/(\d+)/i);
            if (match?.[1]) return `fuq-${match[1]}`;
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
            el.className = 'nexus-fuq-toast';
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

    function parseIsoDuration(raw) {
        const match = String(raw || '').match(/P(?:T)?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
        if (!match) return 0;
        return (Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0);
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

    // ── DOM Card Detection ─────────────────────────────────────────────────────
    // fuq.com video links look like /t/slug/, /tv/slug/, /videos/NNN/, or similar short paths
    // They always have a thumbnail <img> inside the <a>

    const NAV_HREF_RE = /^\/(categories|tags?|pornstars?|channels?|popular|new|search|top|best|ranking|page|user|profile|login|register|signup|settings|premium|pricing|more|videos?\/page|\?)/i;

    function isFuqVideoLink(a) {
        const href = a.getAttribute('href') || '';
        if (!href || href === '/' || href.startsWith('#') || href.startsWith('http')) return false;
        // Must have an img inside
        if (!a.querySelector('img')) return false;
        // Skip nav/filter/category links
        if (NAV_HREF_RE.test(href)) return false;
        // Skip if href is just a query string or very short
        if (href.length < 3) return false;
        return true;
    }

    function getCardNodes() {
        const seen = new Set();
        const results = [];

        document.querySelectorAll('a[href]').forEach((link) => {
            if (!isFuqVideoLink(link)) return;

            // Walk up max 4 levels to find best wrapper
            let node = link;
            for (let i = 0; i < 4; i++) {
                const parent = node.parentElement;
                if (!parent || parent === document.body || parent === document.documentElement) break;
                // Stop if parent spans many columns (grid container)
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
        // Find primary link with img
        const link = node.tagName === 'A' ? node : node.querySelector('a[href]');
        if (!link) return null;

        const rawHref = link.getAttribute('href') || '';
        if (!rawHref || rawHref === '/' || rawHref.startsWith('#')) return null;
        if (NAV_HREF_RE.test(rawHref)) return null;
        const url = new URL(rawHref, location.href).href;

        const img = node.querySelector('img');
        let thumbnail = img?.getAttribute('data-src') ||
                        img?.getAttribute('data-original') ||
                        img?.getAttribute('data-lazy') ||
                        img?.getAttribute('src') ||
                        img?.src || '';
        if (thumbnail.startsWith('//')) thumbnail = `https:${thumbnail}`;

        // Duration badge — fuq uses text like "39:13", "1:04:22" overlaid on thumb
        // Try common selectors first, then scan all text nodes in the card
        const durationEl = node.querySelector(
            '.duration, .dur, .video-duration, .time, .length, ' +
            '[class*="dur"], [class*="time"], [class*="length"], [class*="overlay"]'
        );
        let durationLabel = durationEl?.textContent?.trim() || '';
        if (!durationLabel) {
            // Scan text nodes for time pattern MM:SS or H:MM:SS
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
            let tn;
            while ((tn = walker.nextNode())) {
                const t = tn.textContent.trim();
                if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) { durationLabel = t; break; }
            }
        }

        // Quality badge
        const qualityEl = node.querySelector(
            '.hd, .quality, .badge-hd, .res, .resolution, ' +
            '[class*="quality"], [class*="hd-"], [class*="-hd"], [class*="4k"], [class*="res"]'
        );
        let rawQuality = qualityEl?.textContent?.trim() || '';
        if (!rawQuality) {
            // Check for text like "4K", "HD", "1080p" anywhere in the card
            const cardText = node.innerText || '';
            const qm = cardText.match(/\b(4K|2160p|1440p|1080p|720p|480p|360p|HD)\b/i);
            if (qm) rawQuality = qm[1];
        }

        // Title
        const titleEl = node.querySelector(
            '.title, .video-title, .name, .caption, p, ' +
            '[class*="title"], [class*="name"], [class*="caption"]'
        );
        const title = titleEl?.textContent?.trim() ||
                      link.getAttribute('title') ||
                      img?.getAttribute('alt') ||
                      'Fuq Video';

        const key = normalizeKey(url) || url;

        return {
            id: key,
            url,
            source_url: url,
            title: String(title || '').trim() || 'Fuq Video',
            thumbnail,
            duration: parseDurationText(durationLabel),
            quality: qualityLabel(rawQuality) || '',
            height: qualityHeight(rawQuality),
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
        toolbar.querySelector('.nexus-fuq-stats').textContent = `${selected} selected / ${visible} cards`;
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
        if (item.height > 0) chips.push(`${item.height}p`);
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
        toolbar.className = 'nexus-fuq-toolbar';
        toolbar.innerHTML = `
            <div class="nexus-fuq-title">⚡ Fuq Quick Import</div>
            <div class="nexus-fuq-stats">0 selected / 0 cards</div>
            <div class="nexus-fuq-actions">
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

    // ── Metadata Enrichment ────────────────────────────────────────────────────

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

    function extractTags(doc) {
        return Array.from(doc.querySelectorAll('a[href*="/tag/"], a[href*="/tags/"], .tags a, .tag a'))
            .map((a) => (a.textContent || '').trim())
            .filter(Boolean);
    }

    function extractStreamUrl(html) {
        // fuq.com embeds the video source as a JS variable or in a <source> tag
        const patterns = [
            // player config patterns
            /(?:video_url|videoUrl|file|src)\s*[:=]\s*["'](https?:\/\/[^"']+\.mp4[^"']*)/i,
            // HLS manifests
            /(?:video_url|videoUrl|file|src)\s*[:=]\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/i,
            // JSON-LD contentUrl
            /"contentUrl"\s*:\s*"(https?:\/\/[^"]+)"/,
            // data-src or src on source/video tags
            /<source[^>]+src=["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i,
            /<source[^>]+src=["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
        ];
        for (const pattern of patterns) {
            const m = html.match(pattern);
            if (m) return m[1].replace(/\\\//g, '/');
        }
        return null;
    }

    async function enrichItem(item) {
        try {
            const resp = await fetch(item.url, { credentials: 'include' });
            if (!resp.ok) return { ...item };
            const html = await resp.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const ld = findVideoJsonLd(doc) || {};
            const tags = extractTags(doc);

            const thumbLd = Array.isArray(ld.thumbnailUrl)
                ? (ld.thumbnailUrl[ld.thumbnailUrl.length - 1] || ld.thumbnailUrl[0])
                : (ld.thumbnailUrl || ld.image || '');
            const duration = parseIsoDuration(ld.duration) || item.duration || 0;
            const height = Number(ld.height || item.height || 0) || 0;
            const width = Number(ld.width || 0) || 0;
            const quality = qualityLabel(`${height}p`) || item.quality || '';

            const directUrl = extractStreamUrl(html) || String(ld.contentUrl || '').trim() || item.url;

            return {
                ...item,
                directUrl,
                thumbnail: thumbLd || item.thumbnail,
                duration,
                height,
                width,
                quality,
                tags,
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
            toast(`Preparing ${Math.min(i + chunk.length, items.length)}/${items.length}…`);
        }
        return output;
    }

    // ── Import ─────────────────────────────────────────────────────────────────

    function setBusy(next) {
        state.busy = !!next;
        updateToolbar();
    }

    async function importSelected() {
        const picked = selectedItems();
        if (!picked.length) return;
        setBusy(true);
        try {
            const hydrated = await hydrateItems(picked);
            const items = hydrated.map((entry) => ({
                title: entry.title || 'Fuq Video',
                url: entry.directUrl || entry.url,
                source_url: entry.source_url || entry.url,
                thumbnail: entry.thumbnail || '',
                duration: Number(entry.duration || 0) || 0,
                width: Number(entry.width || 0) || 0,
                height: Number(entry.height || 0) || 0,
                quality: entry.quality || '',
                tags: Array.isArray(entry.tags) ? entry.tags : [],
            })).filter((entry) => entry.url);

            if (!items.length) throw new Error('No importable videos found');

            const batchName = `Fuq Quick Import: ${document.title.trim()}`;
            const res = await new Promise((resolve) => {
                chrome.runtime.sendMessage({
                    action: 'FUQ_IMPORT_BULK',
                    batchName,
                    items,
                }, resolve);
            });
            if (!res?.ok) throw new Error(res?.error || 'Dashboard import failed');

            toast(`Imported ${res.imported || items.length} videos`);
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
