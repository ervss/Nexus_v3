/**
 * Erome Batch Scanner & Metadata Enhancer  v3.0
 *
 * IMPROVEMENTS v3.0:
 *   1. Auto-sort – keď sa dozbierajú veľkosti, automaticky sortuje podľa zvoleného módu
 *   2. Export CSV – tlačidlo na export zoznamu albumov s URL, veľkosťou, kvalitou
 *   3. Filter podľa minimálnej veľkosti – "Zobraz iba albumy > X MB"
 *   4. Bulk select page – "Select All" checkbox pre celú stránku
 *   5. Quality color coding – farebné odlíšenie FHD+(zelená) / HD(žltá) / SD(oranžová) / LOW(červená)
 *
 * FIXES (v2.1):
 *   - Correct link selector (a.img[href*="/a/"])
 *   - data-src lazy loading support
 *   - Queue-based fetch (anti-timeout)
 *   - localStorage cache (7-day TTL)
 */

(function () {
    'use strict';

    const DEBUG = false;
    function log(...args) { if (DEBUG) console.log('[EromeScanner]', ...args); }

    // ── CONFIG ─────────────────────────────────────────────────────────────
    const ALBUM_CONCURRENCY = 4;
    const VIDEO_CONCURRENCY = 8;
    const FETCH_DELAY_MS    = 150;
    const CACHE_KEY         = 'nexus_erome_sizes_v3';
    const CACHE_TTL_MS      = 7 * 24 * 60 * 60 * 1000;

    // Quality → color mapping
    const QUALITY_COLORS = {
        'FHD+': { bg: '#10b981', text: '#fff' },  // green
        'HD':   { bg: '#f59e0b', text: '#000' },  // yellow
        'SD':   { bg: '#f97316', text: '#fff' },  // orange
        'LOW':  { bg: '#ef4444', text: '#fff' },  // red
        '?':    { bg: '#64748b', text: '#fff' },  // grey
    };

    // ── PERSISTENT CACHE ───────────────────────────────────────────────────
    let sizeCache = {};
    try { sizeCache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch {}
    function saveCache() { try { localStorage.setItem(CACHE_KEY, JSON.stringify(sizeCache)); } catch {} }

    // ── SETTINGS (auto-sort, filter) ───────────────────────────────────────
    const SETTINGS_KEY = 'nexus_erome_settings_v3';
    const settings = Object.assign(
        { autoSort: true, filterMinMB: 0, sortMode: 'size' },
        (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; } })()
    );
    function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }

    // ── UTILS ──────────────────────────────────────────────────────────────
    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) return 'N/A';
        const units = ['B', 'KB', 'MB', 'GB'];
        const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
        return (bytes / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0) + '\u00a0' + units[i];
    }

    function parseDuration(text) {
        if (!text) return 0;
        const parts = String(text).trim().split(':').map(Number);
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        return parts[0] || 0;
    }

    function estimateQuality(sizeBytes, durationSec, videoCount = 1) {
        if (videoCount === 0) return { label: 'IMG', cls: 'q-unknown' };
        if (!sizeBytes || sizeBytes <= 0)
            return { label: '?', cls: 'q-unknown' };
        if (durationSec && durationSec > 0) {
            const bitrateMbps = (sizeBytes * 8) / (durationSec * 1_000_000);
            if (bitrateMbps >= 2.0) return { label: 'FHD+', cls: 'q-high' };
            if (bitrateMbps >= 0.9) return { label: 'HD',   cls: 'q-good' };
            if (bitrateMbps >= 0.4) return { label: 'SD',   cls: 'q-ok'   };
            return { label: 'LOW', cls: 'q-low' };
        }
        // Fallback: estimate quality using average size per video
        const count = Math.max(1, videoCount || 1);
        const avgSizeMB = (sizeBytes / (1024 * 1024)) / count;
        if (avgSizeMB >= 150) return { label: 'FHD+', cls: 'q-high' };
        if (avgSizeMB >= 60)  return { label: 'HD',   cls: 'q-good' };
        if (avgSizeMB >= 15)  return { label: 'SD',   cls: 'q-ok'   };
        return { label: 'LOW', cls: 'q-low' };
    }

    // ── STATE ──────────────────────────────────────────────────────────────
    const state = {
        selectedIds: new Set(),
        activePort: 8001,
        totalAlbums: 0,
        fetchedAlbums: 0,
    };

    // ── SECURE CHROME MESSAGE TIMEOUT HELPER ──────────────────────────────
    async function sendMessageWithTimeout(message, timeoutMs = 8000) {
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                log('chrome.runtime.sendMessage timed out for', message.action);
                resolve(null);
            }, timeoutMs);

            chrome.runtime.sendMessage(message, res => {
                clearTimeout(timer);
                resolve(res || null);
            });
        });
    }

    // ── QUEUE ──────────────────────────────────────────────────────────────
    let fetchQueue    = [];
    let activeFetches = 0;

    async function processQueue() {
        while (fetchQueue.length > 0 && activeFetches < ALBUM_CONCURRENCY) {
            const { albumUrl, albumEl } = fetchQueue.shift();
            activeFetches++;
            fetchAlbumSize(albumUrl, albumEl)
                .then(meta => {
                    activeFetches--;
                    state.fetchedAlbums++;
                    if (meta) {
                        injectSizeBadge(albumEl, meta);
                        applyFilter();
                        // [1] Auto-sort: when queue finishes, re-sort
                        if (settings.autoSort && fetchQueue.length === 0 && activeFetches === 0) {
                            sortAlbums();
                        }
                    }
                    updateQueueStatus();
                    setTimeout(processQueue, FETCH_DELAY_MS);
                })
                .catch(() => {
                    activeFetches--;
                    updateQueueStatus();
                    setTimeout(processQueue, FETCH_DELAY_MS);
                });
        }
    }

    function enqueue(albumEl) {
        const link = getAlbumLink(albumEl);
        if (!link) return;
        const albumUrl = link.href;
        if (!albumUrl.includes('/a/')) return;

        const cached = sizeCache[albumUrl];
        if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
            // Recalculate/upgrade quality representation in case thresholds changed
            if (cached.meta) {
                const quality = estimateQuality(cached.meta.size, cached.meta.durationSec, cached.meta.videoCount);
                cached.meta.quality = quality.label;
                cached.meta.qualityClass = quality.cls;
            }
            injectSizeBadge(albumEl, cached.meta);
            applyFilter();
            return;
        }

        if (albumEl.dataset.nexusFetching) return;
        albumEl.dataset.nexusFetching = '1';

        setBadgeText(albumEl, '⏳');
        state.totalAlbums++;
        fetchQueue.push({ albumUrl, albumEl });
        processQueue();
    }

    // ── LINK SELECTOR ─────────────────────────────────────────────────────
    function getAlbumLink(albumEl) {
        return (
            albumEl.querySelector('a.img[href*="/a/"]') ||
            albumEl.querySelector('.img a[href*="/a/"]') ||
            albumEl.querySelector('a[href*="/a/"]') ||
            albumEl.querySelector('a.album-link')
        );
    }

    // ── FETCH ALBUM SIZE ───────────────────────────────────────────────────
    async function fetchAlbumSize(albumUrl, albumEl) {
        const result = await sendMessageWithTimeout(
            { action: 'FETCH_EMBED_CORS', url: albumUrl, referer: 'https://www.erome.com/' },
            10000
        );

        if (!result?.ok || !result.html) {
            log('HTML fetch failed for', albumUrl, result?.status);
            return null;
        }

        const html = result.html;

        // Extract video URLs (lazy data-src + eager src + JSON-embedded)
        const videoUrls = new Set();
        for (const m of html.matchAll(/data-src=["']([^"']+\.mp4[^"']*?)["']/gi))  videoUrls.add(m[1]);
        for (const m of html.matchAll(/<source[^>]+src=["']([^"']+\.mp4[^"']*?)["']/gi)) videoUrls.add(m[1]);
        for (const m of html.matchAll(/"(https?:\/\/[^"]+\.mp4[^"]*)"/gi)) {
            const u = m[1];
            if (u.includes('erome.com') || u.includes('cdn') || u.includes('media')) videoUrls.add(u);
        }

        if (videoUrls.size === 0) {
            log('No video URLs in', albumUrl);
        }

        const urls = [...videoUrls];
        let totalBytes = 0;

        for (let i = 0; i < urls.length; i += VIDEO_CONCURRENCY) {
            const chunk = urls.slice(i, i + VIDEO_CONCURRENCY);
            const sizes = await Promise.all(chunk.map(vUrl =>
                sendMessageWithTimeout(
                    { action: 'FETCH_HEAD_INFO', url: vUrl, referer: albumUrl },
                    6000
                ).then(res => parseInt(res?.contentLength || '0') || 0)
            ));
            totalBytes += sizes.reduce((a, b) => a + b, 0);
        }

        let durationSec = 0;
        let thumbUrl = '';
        let title = '';
        let views = '';
        let tags = [];
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            doc.querySelectorAll('.duration').forEach(durEl => {
                const s = parseDuration(durEl.textContent.trim());
                if (s > 0) durationSec += s;
            });
            const ogImg = doc.querySelector('meta[property="og:image"]');
            if (ogImg) thumbUrl = ogImg.content;
            if (!thumbUrl) {
                const vid = doc.querySelector('video.video-js');
                if (vid && vid.getAttribute('poster')) thumbUrl = vid.getAttribute('poster');
            }

            // Title
            const ogTitle = doc.querySelector('meta[property="og:title"]');
            if (ogTitle) title = ogTitle.content;
            if (!title) title = doc.querySelector('h1')?.textContent?.trim() || '';

            // Views
            const pageText = doc.body?.textContent || '';
            const viewsMatch = pageText.match(/([\d,\.]+[kM]?)\s+views?/i);
            if (viewsMatch) views = viewsMatch[1];

            // Tags
            doc.querySelectorAll('.tags a, a[href*="/search?q="]').forEach(t => {
                const txt = t.textContent.trim();
                if (txt && !tags.includes(txt)) tags.push(txt);
            });
        } catch (e) {
            log('Failed to parse meta from HTML', e);
        }

        // Fallback to album card duration element if any exists
        if (durationSec === 0 && albumEl) {
            const durationEl = albumEl.querySelector('.album-bottom-right, .album-videos');
            const durationText = durationEl?.textContent?.match(/\d+:\d+(?::\d+)?/)?.[0] || '';
            durationSec = parseDuration(durationText);
        }

        const quality = estimateQuality(totalBytes, durationSec, urls.length);

        const meta = {
            size: totalBytes,
            sizeStr: formatBytes(totalBytes),
            sizeMB: totalBytes / (1024 * 1024),
            videoCount: urls.length,
            durationSec,
            quality: quality.label,
            qualityClass: quality.cls,
            url: albumUrl,
            thumbUrl,
            title,
            views,
            tags,
        };

        sizeCache[albumUrl] = { ts: Date.now(), meta };
        saveCache();
        log('Fetched', albumUrl, '→', meta.sizeStr, meta.quality);
        return meta;
    }

    // ── BADGES ─────────────────────────────────────────────────────────────
    function setBadgeText(albumEl, text) {
        let badge = albumEl.querySelector('.nexus-size-badge');
        if (!badge) {
            badge = document.createElement('div');
            badge.className = 'nexus-size-badge';
            albumEl.appendChild(badge);
        }
        badge.textContent = text;
        badge.style.background = 'rgba(0,0,0,0.7)';
        badge.classList.remove('visible');
    }

    // [5] Quality color coding on badge
    function injectSizeBadge(albumEl, meta) {
        let badge = albumEl.querySelector('.nexus-size-badge');
        if (!badge) {
            badge = document.createElement('div');
            badge.className = 'nexus-size-badge';
            albumEl.appendChild(badge);
        }

        albumEl.setAttribute('data-size', String(meta.size || 0));
        albumEl.setAttribute('data-size-mb', String(Math.round(meta.sizeMB || 0)));

        const colors = QUALITY_COLORS[meta.quality] || QUALITY_COLORS['?'];

        badge.innerHTML = `
            <span style="color:#fff">${meta.videoCount}\u00a0vid\u00a0\u2022\u00a0${meta.sizeStr}</span>
            <span style="
                background:${colors.bg};
                color:${colors.text};
                font-weight:800;
                padding:1px 4px;
                border-radius:3px;
                margin-left:3px;
            ">${meta.quality}</span>
        `;
        badge.style.background = 'rgba(0,0,0,0.72)';
        badge.classList.add('visible');
    }

    // ── [3] FILTER BY MIN SIZE ─────────────────────────────────────────────
    function applyFilter() {
        const minMB = settings.filterMinMB || 0;
        document.querySelectorAll('.album[data-nexus-processed]').forEach(el => {
            const sizeMB = parseFloat(el.getAttribute('data-size-mb') || '-1');
            if (sizeMB < 0) {
                // Not yet fetched → keep visible
                el.style.display = '';
                return;
            }
            el.style.display = (sizeMB >= minMB) ? '' : 'none';
        });
    }

    // ── [1] SORT ───────────────────────────────────────────────────────────
    function sortAlbums() {
        const firstAlbum = document.querySelector('.album');
        if (!firstAlbum) return;
        const container = firstAlbum.parentElement;

        // Hide all page separators so they don't break the layout or stack up at the top
        container.querySelectorAll('.ee-page-separator, .separator').forEach(el => {
            el.style.display = 'none';
        });

        const controls = document.getElementById('nexus-sort-controls');
        const items = [...container.querySelectorAll('.album')];
        items.sort((a, b) => {
            return (parseInt(b.getAttribute('data-size') || 0)) -
                   (parseInt(a.getAttribute('data-size') || 0));
        });
        items.forEach(item => container.appendChild(item));
        // Move controls back to top if it is inside container
        if (controls && controls.parentElement === container) {
            container.prepend(controls);
        }
    }

    // ── [2] EXPORT CSV ────────────────────────────────────────────────────
    function exportCSV() {
        const rows = [['Album URL', 'Title', 'Videos', 'Size (MB)', 'Size (human)', 'Quality', 'Duration (s)']];
        document.querySelectorAll('.album[data-nexus-processed]').forEach(el => {
            const link = getAlbumLink(el);
            const url = link?.href || '';
            const cached = sizeCache[url];
            const meta = cached?.meta;
            const title = el.querySelector('.album-title, h3, h4, [class*="title"]')?.textContent?.trim() || '';
            if (meta) {
                rows.push([
                    url, title, meta.videoCount,
                    meta.sizeMB.toFixed(1), meta.sizeStr,
                    meta.quality, meta.durationSec
                ]);
            } else {
                rows.push([url, title, '', '', 'N/A', '', '']);
            }
        });

        const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `erome_albums_${new Date().toISOString().slice(0,10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    // ── QUEUE STATUS ───────────────────────────────────────────────────────
    function updateQueueStatus() {
        const el = document.getElementById('nexus-queue-status');
        if (!el) return;
        if (fetchQueue.length > 0 || activeFetches > 0) {
            const done = state.fetchedAlbums;
            const total = state.fetchedAlbums + fetchQueue.length + activeFetches;
            el.textContent = `⏳ ${done}/${total} albums fetched`;
        } else if (state.fetchedAlbums > 0) {
            el.textContent = `✅ ${state.fetchedAlbums} albums fetched`;
        } else {
            el.textContent = '';
        }
    }

    // ── CONTROLS TOOLBAR ──────────────────────────────────────────────────
    function createSortButton() {
        if (document.getElementById('nexus-sort-controls')) return;
        const container = document.getElementById('albums') || document.querySelector('.page-content.row');
        if (!container) return;

        const controls = document.createElement('div');
        controls.id = 'nexus-sort-controls';
        controls.style.cssText = `
            margin: 10px 0; padding: 10px 14px;
            background: rgba(15,23,42,0.85);
            border: 1px solid rgba(99,102,241,0.3);
            border-radius: 10px;
            display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
            grid-column: 1 / -1; width: 100%; box-sizing: border-box;
            backdrop-filter: blur(4px);
        `;

        // Button helper
        const btn = (id, label, bg, border = bg) => `
            <button id="${id}" style="
                background:${bg}; border:1px solid ${border};
                padding:6px 13px; border-radius:6px; cursor:pointer;
                color:#fff; font-weight:bold; font-size:12px;
                transition: opacity .15s;
            " onmouseover="this.style.opacity='.8'" onmouseout="this.style.opacity='1'">${label}</button>
        `;

        controls.innerHTML = `
            ${btn('nexus-btn-sort-size',  '📊 Sort by Size',     '#10b981', '#059669')}
            ${btn('nexus-btn-fetch-all',  '📡 Fetch All Sizes',  '#6366f1', '#4338ca')}
            ${btn('nexus-btn-recalculate', '🔄 Force Re-Fetch',   '#f43f5e', '#e11d48')}
            ${btn('nexus-btn-deep-scan',  '🚀 Deep Scan Profile', '#d946ef', '#c026d3')}
            ${btn('nexus-btn-export-csv', '📥 Export CSV',       '#0ea5e9', '#0284c7')}

            <label style="color:#94a3b8; font-size:12px; display:flex; align-items:center; gap:5px;">
                <input type="checkbox" id="nexus-auto-sort" ${settings.autoSort ? 'checked' : ''}> Auto-sort
            </label>

            <label style="color:#94a3b8; font-size:12px; display:flex; align-items:center; gap:5px;">
                Min size:
                <input id="nexus-filter-mb" type="number" min="0" value="${settings.filterMinMB}"
                    style="width:60px; padding:3px 6px; border-radius:4px; border:1px solid #334155;
                           background:#1e293b; color:#fff; font-size:12px;">
                MB
                ${btn('nexus-btn-apply-filter', 'Filter', '#475569', '#334155')}
            </label>

            <span id="nexus-queue-status" style="color:#94a3b8; font-size:12px; margin-left:4px;"></span>
        `;
        container.prepend(controls);

        // Sort
        document.getElementById('nexus-btn-sort-size').addEventListener('click', () => {
            sortAlbums();
        });

        // Fetch all
        document.getElementById('nexus-btn-fetch-all').addEventListener('click', () => {
            state.fetchedAlbums = 0;
            state.totalAlbums = 0;
            fetchQueue = [];
            activeFetches = 0;
            document.querySelectorAll('.album').forEach(el => {
                delete el.dataset.nexusFetching;
            });
            document.querySelectorAll('.album').forEach(enqueue);
        });

        // Deep Scan Profile
        document.getElementById('nexus-btn-deep-scan').addEventListener('click', () => {
            initDeepScanner();
        });

        // Force Re-Fetch & Recalculate
        document.getElementById('nexus-btn-recalculate').addEventListener('click', () => {
            sizeCache = {};
            saveCache();
            state.fetchedAlbums = 0;
            state.totalAlbums = 0;
            fetchQueue = [];
            activeFetches = 0;
            updateQueueStatus();
            document.querySelectorAll('.album').forEach(el => {
                delete el.dataset.nexusFetching;
                const badge = el.querySelector('.nexus-size-badge');
                if (badge) badge.remove();
            });
            document.querySelectorAll('.album').forEach(enqueue);
        });

        // [2] Export CSV
        document.getElementById('nexus-btn-export-csv').addEventListener('click', exportCSV);

        // [1] Auto-sort toggle
        document.getElementById('nexus-auto-sort').addEventListener('change', e => {
            settings.autoSort = e.target.checked;
            saveSettings();
        });

        // [3] Filter apply
        document.getElementById('nexus-btn-apply-filter').addEventListener('click', () => {
            settings.filterMinMB = parseFloat(document.getElementById('nexus-filter-mb').value) || 0;
            saveSettings();
            applyFilter();
        });
        document.getElementById('nexus-filter-mb').addEventListener('keydown', e => {
            if (e.key === 'Enter') document.getElementById('nexus-btn-apply-filter').click();
        });

        // Queue status ticker
        setInterval(updateQueueStatus, 800);
    }

    // ── BULK IMPORT BAR ────────────────────────────────────────────────────
    function createBulkImportBar() {
        if (document.getElementById('nexus-erome-bulk-import-bar')) return;
        const bar = document.createElement('div');
        bar.id = 'nexus-erome-bulk-import-bar';
        bar.innerHTML = `
            <div class="nexus-bar-text">Selected: <span id="nexus-selected-count">0</span> albums</div>

            <label style="color:#94a3b8; font-size:12px; display:flex; align-items:center; gap:5px; cursor:pointer;">
                <input type="checkbox" id="nexus-select-all-cb"> Select all
            </label>

            <select class="nexus-bar-port-select" id="nexus-bulk-port">
                ${[8001,8000,8002,8003,8004,8005].map(p => `<option value="${p}">Port ${p}</option>`).join('')}
            </select>
            <button class="nexus-bar-import-btn" id="nexus-bulk-import-btn">Import Selected</button>
        `;
        document.body.appendChild(bar);

        document.getElementById('nexus-bulk-import-btn').addEventListener('click', handleBulkImport);
        document.getElementById('nexus-bulk-port').addEventListener('change', e => {
            state.activePort = parseInt(e.target.value);
        });

        // [4] Select all on page
        document.getElementById('nexus-select-all-cb').addEventListener('change', e => {
            const checked = e.target.checked;
            document.querySelectorAll('.nexus-erome-selector input[type=checkbox]').forEach(cb => {
                cb.checked = checked;
                const albumUrl = cb.getAttribute('data-url');
                if (albumUrl) {
                    if (checked) state.selectedIds.add(albumUrl);
                    else state.selectedIds.delete(albumUrl);
                }
            });
            updateBulkBar();
        });
    }

    function updateBulkBar() {
        const countSpan = document.getElementById('nexus-selected-count');
        const bar = document.getElementById('nexus-erome-bulk-import-bar');
        if (!countSpan || !bar) return;
        countSpan.textContent = state.selectedIds.size;
        bar.classList.toggle('active', state.selectedIds.size > 0);
        // Sync select-all checkbox state
        const allCbs = document.querySelectorAll('.nexus-erome-selector input[type=checkbox]');
        const allChecked = allCbs.length > 0 && [...allCbs].every(cb => cb.checked);
        const selAll = document.getElementById('nexus-select-all-cb');
        if (selAll) selAll.checked = allChecked;
    }

    async function handleBulkImport() {
        const btn = document.getElementById('nexus-bulk-import-btn');
        const orig = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Importing…';
        for (const url of [...state.selectedIds]) {
            await new Promise(resolve => {
                chrome.runtime.sendMessage(
                    { action: 'FAST_IMPORT_PAGE_URL', url, port: state.activePort },
                    resolve
                );
            }).catch(() => {});
        }
        state.selectedIds.clear();
        document.querySelectorAll('.nexus-erome-selector input').forEach(cb => cb.checked = false);
        const selAll = document.getElementById('nexus-select-all-cb');
        if (selAll) selAll.checked = false;
        updateBulkBar();
        btn.disabled = false;
        btn.textContent = orig;
    }

    // ── PROCESS ALBUM CARD ─────────────────────────────────────────────────
    function processAlbum(albumEl) {
        if (albumEl.dataset.nexusProcessed) return;
        albumEl.dataset.nexusProcessed = '1';

        const link = getAlbumLink(albumEl);
        if (!link) { log('No link found in album card'); return; }
        const albumUrl = link.href;

        // Checkbox
        const thumbContainer =
            albumEl.querySelector('.album-thumbnail-container') ||
            albumEl.querySelector('.img') ||
            albumEl;
        if (!thumbContainer.querySelector('.nexus-erome-selector')) {
            const selector = document.createElement('div');
            selector.className = 'nexus-erome-selector';
            selector.innerHTML = `<input type="checkbox" data-url="${albumUrl}">`;
            thumbContainer.style.position = 'relative';
            thumbContainer.appendChild(selector);

            selector.querySelector('input').addEventListener('change', e => {
                if (e.target.checked) state.selectedIds.add(albumUrl);
                else state.selectedIds.delete(albumUrl);
                updateBulkBar();
            });
        }

        enqueue(albumEl);
    }

    // ── SYNCHRONIZE BADGES ──────────────────────────────────────────────────
    function synchronizeBadges() {
        document.querySelectorAll('.album').forEach(albumEl => {
            const link = getAlbumLink(albumEl);
            if (!link) return;
            const albumUrl = link.href;

            // 1. If Erome Ultimate Suite has set sizeMb in the DOM, let's ingest it into our cache!
            const domSizeMb = parseFloat(albumEl.dataset.sizeMb);
            if (domSizeMb && domSizeMb > 0) {
                const cached = sizeCache[albumUrl];
                // If not cached, or cached size is different, or cached quality is unknown
                if (!cached || Math.abs((cached.meta?.sizeMB || 0) - domSizeMb) > 1 || cached.meta?.quality === '?') {
                    const sizeBytes = domSizeMb * 1024 * 1024;
                    let durationSec = 0;
                    
                    // Try to read duration
                    const durationEl = albumEl.querySelector('.album-bottom-right, .album-videos');
                    const durationText = durationEl?.textContent?.match(/\d+:\d+(?::\d+)?/)?.[0] || '';
                    durationSec = parseDuration(durationText);
                    
                    // Fallback to DOM dataset if Erome Ultimate Suite set it
                    const domDuration = parseFloat(albumEl.dataset.totalVideoDuration);
                    if (domDuration > 0) durationSec = domDuration;

                    const videoCount = parseInt(albumEl.querySelector('.album-videos')?.textContent) || 1;
                    const quality = estimateQuality(sizeBytes, durationSec, videoCount);

                    const meta = {
                        size: sizeBytes,
                        sizeStr: formatBytes(sizeBytes),
                        sizeMB: domSizeMb,
                        videoCount,
                        durationSec,
                        quality: quality.label,
                        qualityClass: quality.cls,
                        url: albumUrl,
                    };
                    sizeCache[albumUrl] = { ts: Date.now(), meta };
                    saveCache();
                }
            }

            // 2. Now, check if we have this album in our cache
            const cached = sizeCache[albumUrl];
            if (cached && cached.meta) {
                // If thresholds changed, recalculate
                const quality = estimateQuality(cached.meta.size, cached.meta.durationSec, cached.meta.videoCount);
                cached.meta.quality = quality.label;
                cached.meta.qualityClass = quality.cls;

                // Ensure our beautifully formatted badge is present and fully synchronized!
                injectSizeBadge(albumEl, cached.meta);
            }
        });
        applyFilter();
    }

    // ── SCAN ───────────────────────────────────────────────────────────────
    function scan() {
        document.querySelectorAll('.album:not([data-nexus-processed])').forEach(processAlbum);
        synchronizeBadges();
        createBulkImportBar();
        createSortButton();
    }

    // Inject CSS for badges and toolbar
    const style = document.createElement('style');
    style.textContent = `
        .nexus-size-badge {
            position: absolute;
            bottom: 4px; left: 4px;
            display: flex; align-items: center; gap: 3px;
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 11px;
            font-family: monospace;
            pointer-events: none;
            z-index: 20;
            opacity: 0;
            transition: opacity .2s;
        }
        .nexus-size-badge.visible { opacity: 1; }
        .album:hover .nexus-size-badge { opacity: 1 !important; }

        .nexus-erome-selector {
            position: absolute;
            top: 6px; left: 6px;
            z-index: 30;
        }
        .nexus-erome-selector input[type=checkbox] {
            width: 18px; height: 18px;
            cursor: pointer;
            accent-color: #6366f1;
        }

        #nexus-erome-bulk-import-bar {
            position: fixed;
            bottom: -80px; left: 50%;
            transform: translateX(-50%);
            background: rgba(15,23,42,0.95);
            border: 1px solid #6366f1;
            border-radius: 12px;
            padding: 10px 20px;
            display: flex; align-items: center; gap: 12px;
            color: #fff; font-size: 13px;
            z-index: 9999;
            transition: bottom .3s ease;
            backdrop-filter: blur(8px);
            box-shadow: 0 -4px 30px rgba(99,102,241,0.3);
            white-space: nowrap;
        }
        #nexus-erome-bulk-import-bar.active { bottom: 20px; }
        .nexus-bar-import-btn {
            background: #6366f1;
            color: #fff;
            border: none;
            padding: 6px 14px;
            border-radius: 6px;
            cursor: pointer;
            font-weight: bold;
            font-size: 12px;
        }
        .nexus-bar-import-btn:hover { background: #4f46e5; }
        .nexus-bar-port-select {
            background: #1e293b;
            color: #94a3b8;
            border: 1px solid #334155;
            padding: 4px 8px;
            border-radius: 5px;
            font-size: 12px;
        }
    `;
    document.head.appendChild(style);

    // ── DEEP SCANNER (PROFILE MASS EXTRACTOR) ────────────────────────────────
    let dsIsScanning = false;
    let dsResults = [];

    function initDeepScanner() {
        let modal = document.getElementById('nexus-deepscan-modal');
        if (modal) {
            modal.style.display = 'flex';
            return;
        }

        modal = document.createElement('div');
        modal.id = 'nexus-deepscan-modal';
        modal.style.cssText = `
            position: fixed; top: 5%; left: 5%; width: 90%; height: 90%;
            background: rgba(15,23,42,0.98); border: 2px solid #d946ef; border-radius: 12px;
            z-index: 100000; display: flex; flex-direction: column;
            color: white; font-family: sans-serif; overflow: hidden;
            box-shadow: 0 10px 50px rgba(0,0,0,0.8); backdrop-filter: blur(10px);
        `;
        modal.innerHTML = `
            <div style="padding: 15px 20px; border-bottom: 1px solid #334155; display: flex; justify-content: space-between; align-items: center; background: #0f172a;">
                <h2 style="margin: 0; font-size: 18px; color: #d946ef; display:flex; align-items:center; gap:8px;">
                    🚀 Deep Profile Scanner <span style="font-size:12px; color:#94a3b8; font-weight:normal;">(Quantum Grid View)</span>
                </h2>
                <div style="display:flex; gap: 15px; align-items: center;">
                    <span id="ds-status" style="font-size: 14px; color: #94a3b8; font-weight:bold;">Ready</span>
                    <button id="ds-close" style="background: transparent; border: none; color: #ef4444; font-size: 20px; cursor: pointer;">✖</button>
                </div>
            </div>
            <div style="padding: 15px 20px; display: flex; gap: 10px; background: #1e293b; align-items: center; box-shadow: 0 4px 15px rgba(0,0,0,0.5); z-index: 20;">
                <button id="ds-start-btn" style="background: #d946ef; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: bold;">Start Deep Scan</button>
                <button id="ds-export-btn" style="background: #0ea5e9; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: bold;" disabled>📥 Export CSV</button>
                
                <div style="width:1px; height:24px; background:#475569; margin: 0 5px;"></div>
                
                <button id="ds-import-btn" style="background: #10b981; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: bold;" disabled>✅ Import Selected</button>
                <select id="ds-port" style="background: #0f172a; color: white; border: 1px solid #334155; padding: 6px; border-radius: 6px; font-weight: bold;">
                    ${[8001,8000,8002,8003,8004,8005].map(p => `<option value="${p}">Port ${p}</option>`).join('')}
                </select>

                <div style="width:1px; height:24px; background:#475569; margin: 0 5px;"></div>

                <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#f8fafc; font-weight:bold; font-size:14px;">
                    <input type="checkbox" id="ds-select-all" style="width:18px; height:18px; accent-color:#d946ef;"> Select All
                </label>

                <div style="flex-grow: 1;"></div>
                
                <div style="display: flex; gap: 8px; align-items: center; background: #0f172a; padding: 4px; border-radius: 6px; border: 1px solid #334155;">
                    <span style="color:#94a3b8; font-size:12px; padding: 0 8px; font-weight:bold;">Sort by:</span>
                    <button class="ds-sort-btn" id="ds-sort-videos" style="background:transparent; color:#cbd5e1; border:none; cursor:pointer; font-size:12px; font-weight:bold; padding:4px 8px; border-radius:4px;" onmouseover="this.style.color='#fff'" onmouseout="this.style.color='#cbd5e1'">Videos ↕</button>
                    <button class="ds-sort-btn" id="ds-sort-duration" style="background:transparent; color:#cbd5e1; border:none; cursor:pointer; font-size:12px; font-weight:bold; padding:4px 8px; border-radius:4px;" onmouseover="this.style.color='#fff'" onmouseout="this.style.color='#cbd5e1'">Duration ↕</button>
                    <button class="ds-sort-btn" id="ds-sort-size" style="background:transparent; color:#cbd5e1; border:none; cursor:pointer; font-size:12px; font-weight:bold; padding:4px 8px; border-radius:4px;" onmouseover="this.style.color='#fff'" onmouseout="this.style.color='#cbd5e1'">Size ↕</button>
                    <button class="ds-sort-btn" id="ds-sort-quality" style="background:transparent; color:#cbd5e1; border:none; cursor:pointer; font-size:12px; font-weight:bold; padding:4px 8px; border-radius:4px;" onmouseover="this.style.color='#fff'" onmouseout="this.style.color='#cbd5e1'">Quality ↕</button>
                </div>
            </div>
            
            <div style="height: 4px; width: 100%; background: #0f172a;">
                <div id="ds-progress-bar" style="width: 0%; height: 100%; background: #d946ef; transition: width 0.3s;"></div>
            </div>

            <div id="ds-grid" style="flex-grow: 1; overflow-y: auto; padding: 25px; display: grid; grid-template-columns: repeat(5, 1fr); gap: 25px; background: #0f172a; grid-auto-rows: max-content; align-items: start;">
            </div>
        `;
        document.body.appendChild(modal);

        document.getElementById('ds-close').onclick = () => modal.style.display = 'none';
        document.getElementById('ds-start-btn').onclick = startDeepScan;
        
        let currentSort = null;
        let sortDesc = true;
        const renderSorted = (key) => {
            if (currentSort === key) sortDesc = !sortDesc;
            else { currentSort = key; sortDesc = true; }
            dsResults.sort((a, b) => {
                let valA = a[key]; let valB = b[key];
                if (key === 'quality') {
                    const qMap = { 'FHD+':4, 'HD':3, 'SD':2, 'LOW':1, '?':0 };
                    valA = qMap[valA] || 0; valB = qMap[valB] || 0;
                }
                return sortDesc ? (valB - valA) : (valA - valB);
            });
            renderDsGrid();
        };

        document.getElementById('ds-sort-videos').onclick = () => renderSorted('videoCount');
        document.getElementById('ds-sort-duration').onclick = () => renderSorted('durationSec');
        document.getElementById('ds-sort-size').onclick = () => renderSorted('size');
        document.getElementById('ds-sort-quality').onclick = () => renderSorted('quality');

        document.getElementById('ds-select-all').onchange = (e) => {
            document.querySelectorAll('.ds-row-cb').forEach(cb => cb.checked = e.target.checked);
        };

        document.getElementById('ds-export-btn').onclick = () => {
            let csv = 'Album URL,Videos,Size (MB),Size (str),Duration (sec),Quality\n';
            dsResults.forEach(r => {
                csv += `${r.url},${r.videoCount},${r.sizeMB.toFixed(1)},${r.sizeStr},${r.durationSec},${r.quality}\n`;
            });
            const blob = new Blob([csv], { type: 'text/csv' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `erome_deep_scan_${Date.now()}.csv`;
            a.click();
        };

        document.getElementById('ds-import-btn').onclick = async () => {
            const btn = document.getElementById('ds-import-btn');
            btn.disabled = true;
            btn.textContent = 'Importing...';
            const port = parseInt(document.getElementById('ds-port').value) || 8001;
            const selectedUrls = [...document.querySelectorAll('.ds-row-cb:checked')].map(cb => cb.getAttribute('data-url'));
            
            for (const url of selectedUrls) {
                await new Promise(resolve => {
                    chrome.runtime.sendMessage({ action: 'FAST_IMPORT_PAGE_URL', url, port }, resolve);
                }).catch(() => {});
            }
            btn.disabled = false;
            btn.textContent = `✅ Imported ${selectedUrls.length}`;
            setTimeout(() => btn.textContent = '✅ Import Selected', 2000);
        };
    }

    function renderDsGrid() {
        const grid = document.getElementById('ds-grid');
        grid.innerHTML = '';
        dsResults.forEach(meta => {
            const card = document.createElement('div');
            card.style.cssText = `
                background: #1e293b; border-radius: 12px; overflow: hidden; border: 1px solid #334155;
                display: flex; flex-direction: column; position: relative; transition: transform 0.2s, box-shadow 0.2s;
                cursor: pointer; height: 100%;
            `;
            card.onmouseover = () => { card.style.transform = 'translateY(-4px)'; card.style.boxShadow = '0 12px 24px rgba(0,0,0,0.6)'; };
            card.onmouseout = () => { card.style.transform = 'none'; card.style.boxShadow = 'none'; };

            const mins = Math.floor(meta.durationSec/60);
            const secs = meta.durationSec % 60;
            const durationStr = `${mins}m ${secs.toString().padStart(2, '0')}s`;
            const name = meta.title || meta.url.split('/a/')[1] || 'Unknown';
            const qualityBg = QUALITY_COLORS[meta.quality]?.bg || '#64748b';
            const thumbSrc = meta.thumbUrl || '';
            const viewsStr = meta.views ? `<span style="display: flex; align-items: center; gap: 4px; font-size:12px; color:#cbd5e1;"><span style="font-size:14px;">👁️</span> ${meta.views}</span>` : '';
            const tagsHtml = (meta.tags && meta.tags.length > 0) ? `<div style="display: flex; gap: 6px; overflow-x: auto; padding-top: 8px; border-top: 1px solid #334155; scrollbar-width: none;">${meta.tags.slice(0, 4).map(t => `<span style="background: #0f172a; padding: 3px 8px; border-radius: 6px; font-size: 11px; color: #94a3b8; white-space: nowrap;">#${t}</span>`).join('')}</div>` : '';

            card.innerHTML = `
                <div style="position: relative; width: 100%; aspect-ratio: 16/9; background: #0f172a; flex-shrink: 0;">
                    ${thumbSrc ? `<img src="${thumbSrc}" style="position: absolute; top:0; left:0; width:100%; height:100%; object-fit: cover;">` : ''}
                    <div style="position: absolute; top:0; left:0; width:100%; height:100%; background: linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, transparent 40%, transparent 60%, rgba(0,0,0,0.9) 100%);"></div>
                    <input type="checkbox" class="ds-row-cb" data-url="${meta.url}" style="position: absolute; top: 12px; left: 12px; width: 24px; height: 24px; accent-color: #d946ef; z-index: 10; cursor: pointer; box-shadow: 0 2px 5px rgba(0,0,0,0.5);">
                    <span style="position: absolute; bottom: 10px; right: 10px; background: rgba(15,23,42,0.85); color: #fff; padding: 4px 8px; border-radius: 6px; font-size: 13px; font-weight: bold; font-family: monospace; border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(4px);">${durationStr}</span>
                </div>
                <div style="padding: 16px; display: flex; flex-direction: column; gap: 12px; flex-grow: 1; justify-content: space-between;">
                    <div style="display: flex; flex-direction: column; gap: 10px;">
                        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 10px;">
                            <a href="${meta.url}" target="_blank" style="color: #60a5fa; text-decoration: none; font-weight: bold; font-size: 15px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; text-overflow: ellipsis; line-height: 1.3;" title="${name}">${name}</a>
                            <span style="background:${qualityBg}; color:#fff; padding: 3px 8px; border-radius: 6px; font-size: 12px; font-weight: bold; flex-shrink: 0;">${meta.quality}</span>
                        </div>
                        ${tagsHtml}
                    </div>
                    <div style="display: flex; justify-content: space-between; align-items: center; color: #94a3b8; font-size: 14px; margin-top: auto; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.05);">
                        <span style="display: flex; align-items: center; gap: 6px;"><span style="color:#38bdf8; font-size:16px;">🎬</span> <b>${meta.videoCount}</b> <span style="font-size:12px;">vids</span></span>
                        <div style="display: flex; align-items: center; gap: 12px;">
                            ${viewsStr}
                            <span style="display: flex; align-items: center; gap: 6px; font-weight:bold; color:#e2e8f0;"><span style="color:#a78bfa; font-size:16px;">💾</span> ${meta.sizeStr}</span>
                        </div>
                    </div>
                </div>
            `;
            
            card.addEventListener('click', (e) => {
                if(e.target.tagName !== 'INPUT' && e.target.tagName !== 'A') {
                    const cb = card.querySelector('input');
                    cb.checked = !cb.checked;
                }
            });
            grid.appendChild(card);
        });
    }

    async function collectAllAlbumUrls() {
        const urlObj = new URL(window.location.href);
        const baseUrl = urlObj.origin + urlObj.pathname;
        
        const lastPageLi = document.querySelector('.pagination li:nth-last-child(2)');
        let maxPage = 1;
        if (lastPageLi && parseInt(lastPageLi.textContent) > 0) {
            maxPage = parseInt(lastPageLi.textContent);
        }

        const urls = new Set();
        document.querySelectorAll('.album a.album-link, .album a[href*="/a/"]').forEach(a => urls.add(a.href));

        const fetchPage = async (p) => {
            urlObj.searchParams.set('page', p);
            const res = await sendMessageWithTimeout({ action: 'FETCH_EMBED_CORS', url: urlObj.href, referer: baseUrl }, 15000);
            if (!res || !res.html) return;
            const matches = res.html.matchAll(/href=["']((?:https?:\/\/[^"']*erome\.com)?\/a\/[^"']+)["']/gi);
            for (const m of matches) {
                let u = m[1];
                if (u.startsWith('/a/')) u = 'https://www.erome.com' + u;
                urls.add(u);
            }
        };

        const promises = [];
        for (let p = 2; p <= maxPage; p++) {
            promises.push(fetchPage(p));
            if (promises.length >= 3) { 
                await Promise.all(promises);
                promises.length = 0;
            }
        }
        if (promises.length > 0) await Promise.all(promises);

        return [...urls];
    }

    async function startDeepScan() {
        if (dsIsScanning) return;
        dsIsScanning = true;
        dsResults = [];
        
        const grid = document.getElementById('ds-grid');
        grid.innerHTML = '';
        const statusEl = document.getElementById('ds-status');
        const startBtn = document.getElementById('ds-start-btn');
        const progBar = document.getElementById('ds-progress-bar');
        
        startBtn.disabled = true;
        startBtn.textContent = 'Scanning...';
        document.getElementById('ds-export-btn').disabled = true;
        document.getElementById('ds-import-btn').disabled = true;
        
        statusEl.textContent = 'Discovering all pages...';
        progBar.style.width = '5%';
        const urls = await collectAllAlbumUrls();
        
        statusEl.textContent = `Found ${urls.length} albums. Fetching metadata...`;
        
        let completed = 0;
        const total = urls.length;
        
        const updateProgress = () => {
            progBar.style.width = `${5 + (completed / total) * 95}%`;
            statusEl.textContent = `${completed} / ${total} albums fetched`;
            if (completed === total) {
                dsIsScanning = false;
                startBtn.disabled = false;
                startBtn.textContent = 'Restart Scan';
                document.getElementById('ds-export-btn').disabled = false;
                document.getElementById('ds-import-btn').disabled = false;
                statusEl.textContent = `Done! Scanned ${total} albums.`;
            }
        };
        
        const processAlbumUrl = async (url) => {
            const cached = sizeCache[url];
            let meta = null;
            if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS && cached.meta) {
                meta = cached.meta;
            } else {
                meta = await fetchAlbumSize(url, null);
            }
            
            if (meta) {
                dsResults.push(meta);
                renderDsGrid();
            }
            completed++;
            updateProgress();
        };

        let queue = [...urls];
        const processor = async () => {
            while (queue.length > 0 && dsIsScanning) {
                const url = queue.shift();
                await processAlbumUrl(url);
                await new Promise(r => setTimeout(r, 200));
            }
        };
        
        const concurrency = ALBUM_CONCURRENCY; 
        const workers = [];
        for (let i = 0; i < concurrency; i++) workers.push(processor());
        await Promise.all(workers);
    }

    // ── INIT ───────────────────────────────────────────────────────────────
    scan();

    let scanTimer;
    const observer = new MutationObserver(() => {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(scan, 500);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setInterval(scan, 4000);

    log('Erome Scanner v3.0 initialized');
})();
