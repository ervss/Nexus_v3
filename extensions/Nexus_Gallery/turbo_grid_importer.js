(function () {
    'use strict';

    if (window.top !== window) {
        // Embed Frame Autoplay Handler
        if (/^\/embed\/[a-zA-Z0-9_-]+/i.test(location.pathname)) {
            const startAutoplay = () => {
                const video = document.querySelector('video#main-video, video');
                if (video && (video.src || video.currentSrc)) {
                    const p = video.play();
                    if (p && p.catch) {
                        p.catch(() => {
                            video.muted = true;
                            video.play().catch(() => {});
                        });
                    }
                    return true;
                }
                return false;
            };

            if (!startAutoplay()) {
                const obs = new MutationObserver(() => {
                    if (startAutoplay()) obs.disconnect();
                });
                obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
                setTimeout(() => obs.disconnect(), 10000);
            }
        }
        return;
    }
    if (!/(^|\.)turbo\.cr$/i.test(location.hostname)) return;

    const TOOLBAR_ID = 'nexus-turbo-toolbar';
    const BUBBLE_ID = 'nexus-turbo-bubble';
    const TOAST_ID = 'nexus-turbo-toast';
    const GALLERY_ID = 'nexus-turbo-gallery';
    const PLAYER_ID = 'nexus-turbo-player';
    const STORAGE_POS_KEY = 'nexus_turbo_pos';
    const STORAGE_MIN_KEY = 'nexus_turbo_minimized';
    const STORAGE_GALLERY_KEY = 'nexus_turbo_gallery_open';
    const STORAGE_INFINITE_KEY = 'nexus_turbo_infinite_scroll';

    // ── Single Album State ─────────────────────────────────────────
    const state = {
        items: new Map(),
        busy: false,
        lastCardCount: 0,
        minimized: localStorage.getItem(STORAGE_MIN_KEY) === 'true',
        position: loadStoredPosition(),
        galleryOpen: localStorage.getItem(STORAGE_GALLERY_KEY) !== 'false',
        galleryQuery: '',
        gallerySort: 'source',
        galleryPage: 0,
        galleryPerPage: 12,
    };

    // ── Library Mode State ─────────────────────────────────────────
    const libState = {
        albums: new Map(), // id -> { id, title, url, cardEl, chkEl, badgeEl, peekBtn, scanned, files, videoCount, totalBytes, avgBytes, avgDuration, selected, visible }
        scanning: false,
        scanQueue: [],
        scanActive: 0,
        scanMaxConcurrency: 3,
        currentPage: 1,
        highestPage: 1,
        loadedPages: new Set(),
        maxPages: 40,
        paginationInitialized: false,
        loadingPage: false,
        infiniteScroll: localStorage.getItem(STORAGE_INFINITE_KEY) === 'true',
        busy: false,
        // Filter & Sort
        searchQuery: '',
        sortBy: 'default',
        filterMinVideos: 0,
        filterMinSizeMB: 0,
        filterMinDurationSec: 0,
        filterOnlySelected: false,
        filterOnlyScanned: false,
        autoScanNewPages: false,
    };

    function isLibraryPage() {
        return /^\/library/i.test(location.pathname);
    }

    function isAlbumPage() {
        return /^\/a\/[a-zA-Z0-9_-]+/i.test(location.pathname);
    }

    function isWatchPage() {
        return /^\/v\/[a-zA-Z0-9_-]+/i.test(location.pathname);
    }

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

        const onMouseDown = (e) => {
            if (e.target.closest('button, input, a, .nexus-turbo-min-btn, .nexus-turbo-btn-tester, .nexus-turbo-btn-main, .nexus-turbo-btn-sub')) return;
            isDragging = true;
            hasMoved = false;
            startX = e.clientX;
            startY = e.clientY;
            const rect = element.getBoundingClientRect();
            initialX = rect.left;
            initialY = rect.top;
            element.style.transition = 'none';
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            e.preventDefault();
        };

        const onMouseMove = (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
                hasMoved = true;
            }
            const newX = initialX + dx;
            const newY = initialY + dy;
            const maxLeft = Math.max(10, window.innerWidth - element.offsetWidth - 10);
            const maxTop = Math.max(10, window.innerHeight - element.offsetHeight - 10);
            const safeX = Math.max(10, Math.min(maxLeft, newX));
            const safeTop = Math.max(10, Math.min(maxTop, newY));

            element.style.left = `${safeX}px`;
            element.style.top = `${safeTop}px`;
            element.style.right = 'auto';
            element.style.bottom = 'auto';
        };

        const onMouseUp = () => {
            if (!isDragging) return;
            isDragging = false;
            element.style.transition = '';
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            if (hasMoved && onDragEnd) {
                const rect = element.getBoundingClientRect();
                onDragEnd(rect.left, rect.top);
            }
        };

        handle.addEventListener('mousedown', onMouseDown);
    }

    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    function formatDuration(value) {
        const total = Math.max(0, Math.round(Number(value) || 0));
        if (!total) return '0:00';
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
            : `${m}:${String(s).padStart(2, '0')}`;
    }

    function escapeHtml(value) {
        return String(value || '').replace(/[&<>'"]/g, (char) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
        }[char]));
    }

    function toast(text, isError = false) {
        let el = document.getElementById(TOAST_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = TOAST_ID;
            el.className = 'nexus-turbo-toast';
            document.body.appendChild(el);
        }
        el.style.borderColor = isError ? 'rgba(248, 81, 73, 0.6)' : 'rgba(88, 166, 255, 0.4)';
        el.innerHTML = `<span>${isError ? '⚠️' : '⚡'}</span><span>${text}</span>`;
        el.style.display = 'flex';
        clearTimeout(el._timer);
        el._timer = setTimeout(() => {
            el.style.display = 'none';
        }, 4000);
    }

    // ───────────────────────────────────────────────────────────────
    // 1. TURBO.CR LIBRARY MODE (SCANNER, MULTI-PAGE, TESTER INTAKE)
    // ───────────────────────────────────────────────────────────────

    // ── IndexedDB Vault Storage (Trvalé ukladanie na disk) ──────────
    const DB_NAME = 'NexusTurboVaultDB';
    const DB_VERSION = 1;
    const STORE_NAME = 'albums';

    let dbPromise = null;
    function getVaultDB() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open(DB_NAME, DB_VERSION);
                req.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(STORE_NAME)) {
                        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }
        return dbPromise;
    }

    async function vaultGetAlbum(id) {
        try {
            const db = await getVaultDB();
            return new Promise((resolve) => {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const store = tx.objectStore(STORE_NAME);
                const req = store.get(id);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            });
        } catch { return null; }
    }

    async function vaultSaveAlbum(record) {
        try {
            const db = await getVaultDB();
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(record);
        } catch {}
    }

    async function vaultGetAllAlbums() {
        try {
            const db = await getVaultDB();
            return new Promise((resolve) => {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const store = tx.objectStore(STORE_NAME);
                const req = store.getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => resolve([]);
            });
        } catch { return []; }
    }

    async function syncAlbumToBackend(albumRecord) {
        const ports = [8001, 8000, 8002];
        for (const port of ports) {
            try {
                const res = await fetch(`http://127.0.0.1:${port}/api/link-tester/turbo-vault-library`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ albums: [albumRecord] }),
                });
                if (res.ok) return true;
            } catch {}
        }
        return false;
    }

    function calculateAlbumQuality(files) {
        if (!files || !files.length) {
            return { label: 'SD', icon: '📁', tier: 1, bitrateMbps: 0, badgeClass: 'badge-quality-sd', tooltip: 'Bez videosúborov' };
        }
        let totalBits = 0;
        let totalDur = 0;

        files.forEach((f) => {
            if (f.dur > 0 && f.size > 0) {
                totalBits += (f.size * 8);
                totalDur += f.dur;
            }
        });

        let avgBitrateMbps = 0;
        if (totalDur > 0) {
            avgBitrateMbps = (totalBits / totalDur) / 1000000;
        } else {
            const avgSizeMB = (files.reduce((a, b) => a + (b.size || 0), 0) / files.length) / (1024 * 1024);
            avgBitrateMbps = (avgSizeMB * 8) / 45; // odhad priemernej dĺžky 45s
        }

        if (avgBitrateMbps >= 12.0) {
            return {
                label: '4K UHD',
                icon: '💎',
                tier: 4,
                bitrateMbps: avgBitrateMbps,
                badgeClass: 'badge-quality-4k',
                tooltip: `Priemerný dátový tok: ${avgBitrateMbps.toFixed(1)} Mbps (4K Ultra HD kvalita)`
            };
        } else if (avgBitrateMbps >= 3.5) {
            return {
                label: '1080p FHD',
                icon: '⭐',
                tier: 3,
                bitrateMbps: avgBitrateMbps,
                badgeClass: 'badge-quality-1080p',
                tooltip: `Priemerný dátový tok: ${avgBitrateMbps.toFixed(1)} Mbps (Full HD kvalita)`
            };
        } else if (avgBitrateMbps >= 1.6) {
            return {
                label: '720p HD',
                icon: '⚡',
                tier: 2,
                bitrateMbps: avgBitrateMbps,
                badgeClass: 'badge-quality-720p',
                tooltip: `Priemerný dátový tok: ${avgBitrateMbps.toFixed(1)} Mbps (HD kvalita)`
            };
        } else {
            return {
                label: '480p SD',
                icon: '📁',
                tier: 1,
                bitrateMbps: avgBitrateMbps,
                badgeClass: 'badge-quality-sd',
                tooltip: `Priemerný dátový tok: ${avgBitrateMbps.toFixed(1)} Mbps (Standard/Low kvalita)`
            };
        }
    }

    function parseFilesFromHtml(htmlText) {
        const match = htmlText.match(/const\s+FILES\s*=\s*\[(.*?)\]\s*;/s);
        if (!match) return [];
        const block = match[1];
        const files = [];
        const objectRegex = /\{([^}]+)\}/g;
        let objMatch;
        while ((objMatch = objectRegex.exec(block)) !== null) {
            const body = objMatch[1];
            const idMatch = body.match(/id\s*:\s*["']([^"']+)["']/);
            if (!idMatch) continue;
            const id = idMatch[1].trim();
            const nameMatch = body.match(/name\s*:\s*["']([^"']+)["']/);
            const name = nameMatch ? nameMatch[1].replace(/\\"/g, '"').trim() : `${id}.mp4`;
            const sizeMatch = body.match(/size\s*:\s*(\d+)/);
            const size = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
            const durMatch = body.match(/dur\s*:\s*(\d+)/);
            const dur = durMatch ? parseInt(durMatch[1], 10) : 0;
            const thumbMatch = body.match(/thumb\s*:\s*["']([^"']+)["']/);
            const thumb = thumbMatch ? thumbMatch[1].replace(/\\\//g, '/') : '';
            const viewsMatch = body.match(/views\s*:\s*(\d+)/);
            const views = viewsMatch ? parseInt(viewsMatch[1], 10) : 0;
            files.push({ id, name, size, dur, thumb, views });
        }
        return files;
    }

    function detectPaginationInfo() {
        if (libState.paginationInitialized) return;
        libState.paginationInitialized = true;

        const urlPageMatch = location.search.match(/page=(\d+)/i);
        const initPage = urlPageMatch ? parseInt(urlPageMatch[1], 10) : 1;
        libState.currentPage = initPage;
        libState.highestPage = Math.max(libState.highestPage || 1, initPage);
        libState.loadedPages.add(initPage);

        const text = document.body.innerText || '';
        const m = text.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
        if (m && m[2]) {
            libState.maxPages = Math.max(libState.maxPages, parseInt(m[2], 10) || 40);
        }

        document.querySelectorAll('a[href*="page="]').forEach((a) => {
            const pm = a.href.match(/page=(\d+)/);
            if (pm) {
                const p = parseInt(pm[1], 10);
                if (p > libState.maxPages) libState.maxPages = p;
            }
        });
    }

    function updateOnPageShowingText() {
        try {
            const spans = document.querySelectorAll('span, div, p');
            for (const el of spans) {
                if (/Showing\s+\d+\s+albums/i.test(el.textContent) && el.children.length === 0) {
                    el.textContent = `Showing ${libState.albums.size} albums — Pages 1–${libState.highestPage} of ${libState.maxPages}`;
                    break;
                }
            }
        } catch {}
    }

    function applyAlbumData(album, data) {
        album.scanned = true;
        album.files = data.files || [];
        album.videoCount = album.files.length;
        album.totalBytes = album.files.reduce((acc, f) => acc + (f.size || 0), 0);
        album.avgBytes = album.videoCount > 0 ? Math.round(album.totalBytes / album.videoCount) : 0;
        album.avgDuration = album.videoCount > 0
            ? Math.round(album.files.reduce((acc, f) => acc + (f.dur || 0), 0) / album.videoCount)
            : 0;

        const quality = calculateAlbumQuality(album.files);
        album.quality = quality;

        if (album.badgeEl) {
            album.badgeEl.className = 'nexus-turbo-album-badge badge-done';
            album.badgeEl.innerHTML = `
                <div class="badge-row-primary">
                    <span class="badge-stat">🎬 <b class="stat-hl">${album.videoCount} vid</b></span>
                    <span class="badge-stat">📦 <b class="stat-green">${formatBytes(album.totalBytes)}</b></span>
                    <span class="badge-quality ${quality.badgeClass}" title="${escapeHtml(quality.tooltip)}">${quality.icon} <b>${quality.label}</b></span>
                </div>
                <div class="badge-row-secondary">
                    <span class="badge-stat">📊 Ø <b class="stat-purple">${formatBytes(album.avgBytes)}</b> / vid</span>
                    <span class="badge-stat">⏱️ Ø <b class="stat-amber">${formatDuration(album.avgDuration)}</b></span>
                </div>
            `;
        }
    }

    
    function applyLibraryFilterAndSort() {
        const container = document.getElementById('grid')
            || document.querySelector('.grid')
            || document.querySelector('a.alb')?.parentElement;
        if (!container) return;

        const albums = Array.from(libState.albums.values());
        const query = libState.searchQuery.trim().toLowerCase();

        let visibleCount = 0;
        albums.forEach((album) => {
            let visible = true;

            if (libState.filterOnlySelected && !album.selected) {
                visible = false;
            }

            if (visible && libState.filterOnlyScanned && !album.scanned) {
                visible = false;
            }

            if (visible && query) {
                const matches = (album.title || '').toLowerCase().includes(query) || album.id.toLowerCase().includes(query);
                if (!matches) visible = false;
            }

            if (visible && libState.filterMinVideos > 0) {
                if (!album.scanned || album.videoCount < libState.filterMinVideos) {
                    visible = false;
                }
            }

            if (visible && libState.filterMinSizeMB > 0) {
                const sizeMB = (album.totalBytes || 0) / (1024 * 1024);
                if (!album.scanned || sizeMB < libState.filterMinSizeMB) {
                    visible = false;
                }
            }

            if (visible && libState.filterMinDurationSec > 0) {
                if (!album.scanned || album.avgDuration < libState.filterMinDurationSec) {
                    visible = false;
                }
            }

            if (visible && libState.filterQuality && libState.filterQuality !== 'all') {
                if (!album.scanned || !album.quality) {
                    visible = false;
                } else {
                    const qTier = album.quality.tier || 0;
                    if (libState.filterQuality === '4k' && qTier < 4) visible = false;
                    if (libState.filterQuality === '1080p' && qTier < 3) visible = false;
                    if (libState.filterQuality === '720p' && qTier < 2) visible = false;
                    if (libState.filterQuality === 'sd' && qTier > 1) visible = false;
                }
            }

            album.visible = visible;
            if (album.cardEl) {
                album.cardEl.classList.toggle('nexus-turbo-hidden', !visible);
                album.cardEl.style.setProperty('display', visible ? '' : 'none', 'important');
            }
            if (visible) visibleCount++;
        });

        const sorters = {
            default: () => 0,
            size_desc: (a, b) => (b.totalBytes || 0) - (a.totalBytes || 0),
            vids_desc: (a, b) => (b.videoCount || 0) - (a.videoCount || 0),
            dur_desc: (a, b) => (b.avgDuration || 0) - (a.avgDuration || 0),
            avg_desc: (a, b) => (b.avgBytes || 0) - (a.avgBytes || 0),
            name_asc: (a, b) => (a.title || '').localeCompare(b.title || '', undefined, { numeric: true }),
            selected_first: (a, b) => Number(b.selected) - Number(a.selected),
        };

        const sorter = sorters[libState.sortBy] || sorters.default;

        if (libState.sortBy !== 'default') {
            const sorted = [...albums].sort(sorter);
            sorted.forEach((album) => {
                if (album.cardEl && album.cardEl.parentElement === container) {
                    container.appendChild(album.cardEl);
                }
            });
        }

        updateLibraryToolbar();
    }

    const STORAGE_PEEK_LAYOUT_KEY = 'nexus_turbo_peek_layout';

    async function openAlbumQuickPeek(album) {
        if (!album.scanned || !album.files) {
            toast(`⏳ Sťahujem videá albumu "${album.title}"...`);
            await fetchAlbumMetadata(album);
        }

        const oldModal = document.getElementById('nexus-turbo-peek-modal');
        if (oldModal) oldModal.remove();

        let currentLayout = localStorage.getItem(STORAGE_PEEK_LAYOUT_KEY) || '3x2';
        let peekSearchQuery = '';
        let peekVisibleLimit = 100;
        let filteredFiles = [];
        const PEEK_BATCH_SIZE = 100;

        // Initialize selection on files if not set
        album.files.forEach((f) => {
            if (f.selected === undefined) f.selected = true;
        });

        const modal = document.createElement('div');
        modal.id = 'nexus-turbo-peek-modal';
        modal.innerHTML = `
            <div class="nexus-turbo-peek-backdrop" data-close-peek></div>
            <div class="nexus-turbo-peek-dialog" role="dialog" aria-modal="true">
                <!-- Header -->
                <div class="nexus-turbo-peek-header">
                    <h3>📂 ${escapeHtml(album.title)} <span style="font-size:12px;color:#8b949e;font-weight:normal;">(${album.videoCount || 0} videí · ${formatBytes(album.totalBytes)})</span></h3>
                    <div style="display:flex;align-items:center;gap:12px;">
                        <!-- Layout Switcher (3x2, 4x3, 2x2, List) -->
                        <div class="nexus-turbo-layout-group">
                            <button type="button" class="nexus-turbo-layout-btn ${currentLayout === '3x2' ? 'is-active' : ''}" data-peek-layout="3x2" title="3 stĺpce">▦ 3x2</button>
                            <button type="button" class="nexus-turbo-layout-btn ${currentLayout === '4x3' ? 'is-active' : ''}" data-peek-layout="4x3" title="4 stĺpce">▤ 4x3</button>
                            <button type="button" class="nexus-turbo-layout-btn ${currentLayout === '2x2' ? 'is-active' : ''}" data-peek-layout="2x2" title="2 stĺpce (veľké náhľady)">☷ 2x2</button>
                            <button type="button" class="nexus-turbo-layout-btn ${currentLayout === 'list' ? 'is-active' : ''}" data-peek-layout="list" title="Zoznam">☰ Zoznam</button>
                        </div>
                        <button type="button" class="nexus-turbo-min-btn" data-close-peek style="font-size:18px;">✕</button>
                    </div>
                </div>

                <!-- Action Toolbar -->
                <div class="nexus-turbo-peek-toolbar">
                    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:#c9d1d9;">
                            <input type="checkbox" id="nexus-turbo-peek-select-all" class="nexus-turbo-peek-chk" checked>
                            <span>Označiť filtrované</span>
                        </label>
                        <span id="nexus-turbo-peek-count" style="font-size:11.5px;color:#8b949e;">0 / 0 vybratých</span>
                        <input type="text" id="nexus-turbo-peek-search" class="nexus-turbo-peek-search-input" placeholder="🔍 Názov videa alebo albumu...">
                        <select id="nexus-turbo-peek-album" class="nexus-turbo-select" aria-label="Zdrojový album"><option value="">Všetky albumy</option>${(album.sources || []).map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.title)}</option>`).join('')}</select>
                        <select id="nexus-turbo-peek-sort" class="nexus-turbo-select" aria-label="Zoradenie videí"><option value="original">Pôvodné poradie</option><option value="name">Názov A–Z</option><option value="size">Najväčšie</option><option value="duration">Najdlhšie</option></select>
                        <select id="nexus-turbo-peek-filter" class="nexus-turbo-select" aria-label="Filter videí"><option value="all">Všetky videá</option><option value="selected">Iba vybraté</option></select>
                        <label class="nexus-turbo-peek-min">Min. MB <input id="nexus-turbo-peek-min-size" type="number" min="0" step="1" placeholder="0" aria-label="Minimálna veľkosť v MB"></label>
                        <label class="nexus-turbo-peek-min">Min. min <input id="nexus-turbo-peek-min-duration" type="number" min="0" step="1" placeholder="0" aria-label="Minimálna dĺžka v minútach"></label>
                        <select id="nexus-turbo-peek-min-quality" class="nexus-turbo-select" aria-label="Minimálna kvalita podľa názvu" title="Rozlíšenie podľa názvu videa; neznáme sa pri aktívnom filtri vynechajú"><option value="0">Kvalita: všetky</option><option value="480">Min. 480p</option><option value="720">Min. 720p</option><option value="1080">Min. 1080p</option><option value="1440">Min. 1440p</option><option value="2160">Min. 4K</option></select>
                    </div>

                    <div class="nexus-turbo-peek-actions">
                        <button type="button" class="nexus-turbo-btn-split" id="nexus-turbo-peek-btn-split" title="Spustiť Nexus Universal Split-Screen s vybratými videami">
                            📺 Split-Screen (0)
                        </button>
                        <button type="button" class="nexus-turbo-btn-tester" id="nexus-turbo-peek-btn-tester" style="padding:6px 10px;font-size:12px;" title="Poslať vybraté videá do Testera">
                            🚀 Do Testera (0)
                        </button>
                        <button type="button" class="nexus-turbo-btn-main" id="nexus-turbo-peek-btn-import" style="padding:6px 10px;font-size:12px;" title="Importovať vybraté videá do Nexus Vaultu">
                            ⚡ Importovať (0)
                        </button>
                    </div>
                </div>

                <!-- Gallery / Grid Container -->
                <div class="nexus-turbo-peek-grid" id="nexus-turbo-peek-grid" data-layout="${currentLayout}"></div>

                <!-- Pagination Footer Bar -->
                <div id="nexus-turbo-peek-pagination-container"></div>
            </div>
        `;

        const gridEl = modal.querySelector('#nexus-turbo-peek-grid');
        const countEl = modal.querySelector('#nexus-turbo-peek-count');
        const splitBtn = modal.querySelector('#nexus-turbo-peek-btn-split');
        const testerBtn = modal.querySelector('#nexus-turbo-peek-btn-tester');
        const importBtn = modal.querySelector('#nexus-turbo-peek-btn-import');
        const selectAllChk = modal.querySelector('#nexus-turbo-peek-select-all');

        function updatePeekToolbar() {
            const files = album.files || [];
            const sel = files.filter(f => f.selected);
            const selCount = sel.length;
            const selBytes = sel.reduce((acc, f) => acc + (f.size || 0), 0);

            countEl.textContent = `${selCount} / ${files.length} vybratých (${formatBytes(selBytes)})`;
            splitBtn.disabled = selCount === 0;
            splitBtn.innerHTML = `📺 Split-Screen (${selCount})`;

            testerBtn.disabled = selCount === 0;
            testerBtn.innerHTML = `🚀 Do Testera (${selCount})`;

            importBtn.disabled = selCount === 0;
            importBtn.innerHTML = `⚡ Importovať (${selCount})`;

            const selectedFiltered = filteredFiles.filter(f => f.selected).length;
            selectAllChk.checked = filteredFiles.length > 0 && selectedFiltered === filteredFiles.length;
            selectAllChk.indeterminate = selectedFiltered > 0 && selectedFiltered < filteredFiles.length;
        }

        const paginationContainer = modal.querySelector('#nexus-turbo-peek-pagination-container');
        const searchInput = modal.querySelector('#nexus-turbo-peek-search');

        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                peekSearchQuery = (e.target.value || '').trim();
                peekVisibleLimit = PEEK_BATCH_SIZE;
                renderPeekGrid();
            });
        }

        const albumFilter = modal.querySelector('#nexus-turbo-peek-album');
        const sortSelect = modal.querySelector('#nexus-turbo-peek-sort');
        const videoFilter = modal.querySelector('#nexus-turbo-peek-filter');
        const minSize = modal.querySelector('#nexus-turbo-peek-min-size');
        const minDuration = modal.querySelector('#nexus-turbo-peek-min-duration');
        const minQuality = modal.querySelector('#nexus-turbo-peek-min-quality');
        [minSize, minDuration, minQuality].forEach(control => control.addEventListener(control.tagName === 'SELECT' ? 'change' : 'input', () => {
            peekVisibleLimit = PEEK_BATCH_SIZE;
            renderPeekGrid();
        }));
        if (!album.sources) albumFilter.hidden = true;
        [albumFilter, sortSelect, videoFilter].forEach(control => control.addEventListener('change', () => {
            peekVisibleLimit = PEEK_BATCH_SIZE;
            renderPeekGrid();
        }));

        function renderPeekGrid() {
            gridEl.dataset.layout = currentLayout;
            const allFiles = album.files || [];
            const query = peekSearchQuery.toLowerCase();
            filteredFiles = allFiles.filter(f => {
                const matchesText = !query || [f.name, f.id, ...(f.sourceTitles || [])].some(value => (value || '').toLowerCase().includes(query));
                const matchesAlbum = !albumFilter.value || (f.sourceIds || []).includes(albumFilter.value);
                const matchesKind = videoFilter.value === 'all' || (videoFilter.value === 'selected' && f.selected);
                const sizeLimit = Math.max(0, Number(minSize.value) || 0) * 1024 * 1024;
                const durationLimit = Math.max(0, Number(minDuration.value) || 0) * 60;
                const qualityLimit = Number(minQuality.value) || 0;
                const name = f.name || '';
                const resolution = /(?:^|[^a-z0-9])(2160p?|4k|uhd)(?:[^a-z0-9]|$)/i.test(name) ? 2160 :
                    /(?:^|[^a-z0-9])(1440p?|2k)(?:[^a-z0-9]|$)/i.test(name) ? 1440 :
                    /(?:^|[^a-z0-9])(1080p?|fhd)(?:[^a-z0-9]|$)/i.test(name) ? 1080 :
                    /(?:^|[^a-z0-9])720p?(?:[^a-z0-9]|$)/i.test(name) ? 720 :
                    /(?:^|[^a-z0-9])480p?(?:[^a-z0-9]|$)/i.test(name) ? 480 : 0;
                return matchesText && matchesAlbum && matchesKind &&
                    (!sizeLimit || Number(f.size) >= sizeLimit) &&
                    (!durationLimit || Number(f.dur) >= durationLimit) &&
                    (!qualityLimit || resolution >= qualityLimit);
            });
            const sorters = {
                name: (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }),
                size: (a, b) => (b.size || 0) - (a.size || 0),
                duration: (a, b) => (b.dur || 0) - (a.dur || 0),
            };
            if (sorters[sortSelect.value]) filteredFiles.sort(sorters[sortSelect.value]);

            if (!filteredFiles.length) {
                gridEl.innerHTML = `<div style="padding:40px;text-align:center;color:#8b949e">
                    ${query ? 'Pre zadaný filter sa v albume nenašli žiadne videá.' : 'V tomto albume sa nenašli žiadne videá.'}
                </div>`;
                if (paginationContainer) paginationContainer.innerHTML = '';
                updatePeekToolbar();
                return;
            }

            const visibleFiles = filteredFiles.slice(0, peekVisibleLimit);

            if (currentLayout === 'list') {
                gridEl.innerHTML = visibleFiles.map((f) => `
                    <div class="nexus-turbo-peek-item ${f.selected ? 'is-selected' : ''}" data-file-id="${escapeHtml(f.id)}">
                        <input type="checkbox" class="nexus-turbo-peek-chk file-chk" ${f.selected ? 'checked' : ''} data-file-chk="${escapeHtml(f.id)}">
                        <div class="nexus-turbo-peek-poster" style="width:80px;height:48px;flex-shrink:0;cursor:pointer;" data-play-file="${escapeHtml(f.id)}">
                            <img src="${escapeHtml(f.thumb || '')}" alt="" onerror="this.style.display='none'">
                            <span class="nexus-turbo-peek-play-btn" style="width:28px;height:28px;font-size:12px;">▶</span>
                        </div>
                        <div class="nexus-turbo-peek-details">
                            <div class="nexus-turbo-peek-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>${f.sourceTitles ? `<div class="nexus-turbo-peek-source">📁 ${escapeHtml(f.sourceTitles.join(', '))}</div>` : ''}
                            <div class="nexus-turbo-peek-sub">
                                <span>📦 ${formatBytes(f.size)}</span>
                                <span>⏱️ ${formatDuration(f.dur)}</span>
                            </div>
                        </div>
                        <button type="button" class="nexus-turbo-btn-sub" data-play-file="${escapeHtml(f.id)}">▶ Prehrať</button>
                        <button type="button" class="nexus-turbo-peek-btn-import" data-import-single="${escapeHtml(f.id)}">⚡ Import</button>
                        <a href="https://turbo.cr/v/${escapeHtml(f.id)}" target="_blank" class="nexus-turbo-peek-btn-open">↗</a>
                    </div>
                `).join('');
            } else {
                // Gallery Grid (3x2, 4x3, 2x2)
                gridEl.innerHTML = visibleFiles.map((f) => `
                    <div class="nexus-turbo-peek-card ${f.selected ? 'is-selected' : ''}" data-file-id="${escapeHtml(f.id)}">
                        <div class="nexus-turbo-peek-poster">
                            <div class="nexus-turbo-peek-chk-wrap">
                                <input type="checkbox" class="nexus-turbo-peek-chk file-chk" ${f.selected ? 'checked' : ''} data-file-chk="${escapeHtml(f.id)}">
                            </div>
                            <img src="${escapeHtml(f.thumb || '')}" alt="" loading="lazy" onerror="this.src='https://turbo.cr/favicon.ico'">
                            <div class="nexus-turbo-peek-play-btn" data-play-file="${escapeHtml(f.id)}" title="Prehrať ${escapeHtml(f.name)}">
                                ▶
                            </div>
                            <div class="nexus-turbo-peek-meta-badge">
                                <span>⏱️ ${formatDuration(f.dur)}</span>
                                <span>·</span>
                                <span>📦 ${formatBytes(f.size)}</span>
                            </div>
                        </div>
                        <div class="nexus-turbo-peek-card-body">
                            <div class="nexus-turbo-peek-card-title" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>${f.sourceTitles ? `<div class="nexus-turbo-peek-source">📁 ${escapeHtml(f.sourceTitles.join(', '))}</div>` : ''}
                            <div class="nexus-turbo-peek-card-actions">
                                <button type="button" class="nexus-turbo-peek-btn-import" data-import-single="${escapeHtml(f.id)}" title="Importovať toto video do Nexus Vaultu">
                                    ⚡ Import
                                </button>
                                <a href="https://turbo.cr/v/${escapeHtml(f.id)}" target="_blank" class="nexus-turbo-peek-btn-open" title="Otvoriť na Turbo.cr">
                                    ↗
                                </a>
                            </div>
                        </div>
                    </div>
                `).join('');
            }

            // Pagination footer controls if more files exist
            if (paginationContainer) {
                if (filteredFiles.length > peekVisibleLimit) {
                    const remaining = filteredFiles.length - peekVisibleLimit;
                    const nextBatch = Math.min(PEEK_BATCH_SIZE, remaining);
                    paginationContainer.innerHTML = `
                        <div class="nexus-turbo-peek-pagination-bar">
                            <span style="font-size:12px;color:#8b949e;">
                                Zobrazených <b>${visibleFiles.length}</b> z <b>${filteredFiles.length}</b> videí (celkovo: ${allFiles.length})
                            </span>
                            <div style="display:flex;gap:8px;align-items:center;">
                                <button type="button" class="nexus-turbo-peek-load-more-btn" id="nexus-turbo-peek-load-more">
                                    ➕ Načítať ďalších ${nextBatch} videí
                                </button>
                                <button type="button" class="nexus-turbo-peek-load-all-btn" id="nexus-turbo-peek-load-all">
                                    ⏩ Zobraziť všetky (${filteredFiles.length})
                                </button>
                            </div>
                        </div>
                    `;
                    paginationContainer.querySelector('#nexus-turbo-peek-load-more')?.addEventListener('click', () => {
                        peekVisibleLimit += PEEK_BATCH_SIZE;
                        renderPeekGrid();
                    });
                    paginationContainer.querySelector('#nexus-turbo-peek-load-all')?.addEventListener('click', () => {
                        peekVisibleLimit = filteredFiles.length;
                        renderPeekGrid();
                    });
                } else {
                    paginationContainer.innerHTML = '';
                }
            }

            updatePeekToolbar();
        }

        renderPeekGrid();

        // ── Event Handlers ──────────────────────────────────────────

        // Layout Buttons
        modal.querySelectorAll('[data-peek-layout]').forEach((btn) => {
            btn.addEventListener('click', () => {
                currentLayout = btn.getAttribute('data-peek-layout');
                localStorage.setItem(STORAGE_PEEK_LAYOUT_KEY, currentLayout);
                modal.querySelectorAll('[data-peek-layout]').forEach(b => b.classList.remove('is-active'));
                btn.classList.add('is-active');
                renderPeekGrid();
            });
        });

        // Select All Checkbox
        selectAllChk.addEventListener('change', () => {
            const check = selectAllChk.checked;
            filteredFiles.forEach(f => { f.selected = check; });
            modal.querySelectorAll('.file-chk').forEach(c => { c.checked = check; });
            modal.querySelectorAll('.nexus-turbo-peek-card, .nexus-turbo-peek-item').forEach(el => {
                el.classList.toggle('is-selected', check);
            });
            renderPeekGrid();
        });

        // Click Delegation on Grid
        gridEl.addEventListener('click', (e) => {
            // Checkbox toggle
            const chk = e.target.closest('[data-file-chk]');
            if (chk) {
                const fId = chk.getAttribute('data-file-chk');
                const file = (album.files || []).find(f => f.id === fId);
                if (file) {
                    file.selected = chk.checked;
                    const card = chk.closest('.nexus-turbo-peek-card, .nexus-turbo-peek-item');
                    if (card) card.classList.toggle('is-selected', file.selected);
                    if (videoFilter.value === 'selected') renderPeekGrid();
                    else updatePeekToolbar();
                }
                return;
            }

            // Play Button
            const playBtn = e.target.closest('[data-play-file]');
            if (playBtn) {
                const fId = playBtn.getAttribute('data-play-file');
                const file = (album.files || []).find(f => f.id === fId);
                openPlayer({ id: fId, title: file ? file.name : `Video ${fId}` });
                return;
            }

            // Single Import Button
            const importSingle = e.target.closest('[data-import-single]');
            if (importSingle) {
                const fId = importSingle.getAttribute('data-import-single');
                const file = (album.files || []).find(f => f.id === fId);
                if (file) {
                    importSingle.disabled = true;
                    importSingle.textContent = '⏳ Import...';
                    chrome.runtime.sendMessage({
                        action: 'NEXUS_TURBO_IMPORT_BULK',
                        batchName: album.title,
                        items: [{
                            url: `https://turbo.cr/v/${file.id}`,
                            source_url: `https://turbo.cr/v/${file.id}`,
                            title: file.name,
                            thumbnail: file.thumb || '',
                            duration: file.dur || 0,
                            quality: 'HD',
                            sizeBytes: file.size || 0,
                        }],
                    }, (res) => {
                        if (res && res.ok) {
                            importSingle.textContent = '✓ Vložené';
                            importSingle.style.background = '#238636';
                            importSingle.style.color = '#fff';
                            toast(`⚡ Video "${file.name}" odoslané do Nexus Vaultu!`);
                        } else {
                            importSingle.disabled = false;
                            importSingle.textContent = '⚡ Import';
                            toast(`Chyba importu: ${res?.error || 'Neznáma chyba'}`, true);
                        }
                    });
                }
                return;
            }
        });

        // Split-Screen Launch Button
        splitBtn.addEventListener('click', () => {
            const selFiles = (album.files || []).filter(f => f.selected);
            if (!selFiles.length) {
                toast('Najprv označ aspoň jedno video na split-screen.', true);
                return;
            }

            const payload = selFiles.map(f => ({
                id: f.id,
                url: `https://turbo.cr/v/${f.id}`,
                watchUrl: `https://turbo.cr/v/${f.id}`,
                title: f.name || `Video ${f.id}`,
                poster: f.thumb || '',
                thumb: f.thumb || '',
                thumbnail: f.thumb || '',
                duration: f.dur || 0,
                size: f.size || 0,
            }));

            // Dispatch both dedicated turbo event and universal split-open event
            document.dispatchEvent(new CustomEvent('nexus-turbo-split-open', { detail: JSON.stringify(payload) }));
            document.dispatchEvent(new CustomEvent('nexus-split-open', { detail: JSON.stringify(payload.map(p => p.url)) }));

            toast(`📺 Spúšťam Nexus Split-Screen (${payload.length} videí z albumu "${album.title}")...`);
        });

        // Tester Launch Button
        testerBtn.addEventListener('click', () => {
            const selFiles = (album.files || []).filter(f => f.selected);
            if (!selFiles.length) return;

            const links = selFiles.map(f => ({
                url: `https://turbo.cr/v/${f.id}`,
                host: 'turbo',
                text: f.name || `Video ${f.id}`,
                context: `Album: ${album.title}`,
                quality: 'HD',
            }));

            toast(`🚀 Posielam ${links.length} videí do Testera...`);
            chrome.runtime.sendMessage({
                action: 'NEXUS_TURBO_HUNTER_PUSH',
                thread_title: `Turbo Album: ${album.title}`,
                thread_url: album.url,
                links: links,
                autostart: true,
                autoselect: true,
            }, (res) => {
                if (res && res.ok) {
                    toast(`🚀 ${links.length} videí odoslaných do Testera! Otváram kartu...`);
                } else {
                    toast(`Chyba Testera: ${res?.error || 'Nexus server neodpovedá'}`, true);
                }
            });
        });

        // Direct Bulk Import from Modal
        importBtn.addEventListener('click', () => {
            const selFiles = (album.files || []).filter(f => f.selected);
            if (!selFiles.length) return;

            const items = selFiles.map(f => ({
                url: `https://turbo.cr/v/${f.id}`,
                source_url: `https://turbo.cr/v/${f.id}`,
                title: f.name || `Video ${f.id}`,
                thumbnail: f.thumb || '',
                duration: f.dur || 0,
                quality: 'HD',
                sizeBytes: f.size || 0,
            }));

            toast(`⚡ Odosielam ${items.length} videí do Nexus Vaultu...`);
            chrome.runtime.sendMessage({
                action: 'NEXUS_TURBO_IMPORT_BULK',
                batchName: album.title,
                items: items,
            }, (res) => {
                if (res && res.ok) {
                    const count = res.data?.imported ?? items.length;
                    toast(`⚡ Úspešne odoslané: ${count} videí do Nexus Vaultu!`);
                } else {
                    toast(`Chyba importu: ${res?.error || 'Neznáma chyba'}`, true);
                }
            });
        });

        // Close on backdrop or close button
        modal.addEventListener('click', (e) => {
            if (e.target.hasAttribute('data-close-peek') || e.target.closest('[data-close-peek]')) {
                modal.remove();
            }
        });

        document.body.appendChild(modal);
    }

    function scanLibraryAlbums() {
        detectPaginationInfo();
        const cards = document.querySelectorAll('a.alb[href*="/a/"]');
        let added = 0;

        cards.forEach((card) => {
            const href = card.getAttribute('href') || '';
            const m = href.match(/\/a\/([a-zA-Z0-9_-]+)/);
            if (!m) return;
            const id = m[1];

            if (libState.albums.has(id)) {
                // Ensure DOM references are up to date
                const existing = libState.albums.get(id);
                existing.cardEl = card;
                return;
            }

            const titleEl = card.querySelector('.truncate, [title], .font-medium') || card;
            const title = (titleEl.getAttribute('title') || titleEl.textContent || `Album ${id}`).trim();

            const fullUrl = href.startsWith('http') ? href : location.origin + href;

            const album = {
                id,
                title,
                url: fullUrl,
                cardEl: card,
                chkEl: null,
                badgeEl: null,
                scanned: false,
                files: [],
                videoCount: 0,
                totalBytes: 0,
                avgBytes: 0,
                avgDuration: 0,
                selected: false,
            };

            // 1. Create and attach Checkbox
            let chkWrap = card.querySelector('.nexus-turbo-album-chk-wrap');
            if (!chkWrap) {
                chkWrap = document.createElement('div');
                chkWrap.className = 'nexus-turbo-album-chk-wrap';
                const chk = document.createElement('input');
                chk.type = 'checkbox';
                chk.className = 'nexus-turbo-album-chk';
                chk.title = `Označiť album: ${title}`;
                chkWrap.appendChild(chk);

                chkWrap.addEventListener('click', (e) => e.stopPropagation());
                chk.addEventListener('change', () => {
                    album.selected = chk.checked;
                    card.classList.toggle('is-selected', album.selected);
                    updateLibraryToolbar();
                });

                album.chkEl = chk;
                const strip = card.querySelector('.strip, .relative') || card;
                strip.appendChild(chkWrap);
            }
            album.chkEl = chkWrap.querySelector('.nexus-turbo-album-chk');

            // 2. Create and attach Metadata Badge
            let badge = card.querySelector('.nexus-turbo-album-badge');
            if (!badge) {
                badge = document.createElement('div');
                badge.className = 'nexus-turbo-album-badge';
                badge.innerHTML = `<span class="badge-stat">⏳ Čaká na sken...</span>`;
                album.badgeEl = badge;
                const strip = card.querySelector('.strip, .relative') || card;
                strip.appendChild(badge);
            } else {
                album.badgeEl = badge;
            }

            // Handle controls before the album link can navigate.
            if (!card.dataset.nexusProtected) {
                card.dataset.nexusProtected = '1';
                card.addEventListener('click', (e) => {
                    const eye = e.target.closest('.nexus-turbo-badge-peek');
                    const selection = e.target.closest('.nexus-turbo-album-chk-wrap');
                    if (!eye && !selection) return;
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    if (eye) {
                        openAlbumQuickPeek(album);
                    } else {
                        album.selected = !album.selected;
                        card.classList.toggle('is-selected', album.selected);
                        // A cancelled checkbox click restores its old checked state after dispatch.
                        queueMicrotask(() => { if (album.chkEl) album.chkEl.checked = album.selected; });
                        updateLibraryToolbar();
                    }
                }, true);
            }

            // 3. Create Quick Peek button
            let peek = card.querySelector('.nexus-turbo-badge-peek');
            if (!peek) {
                peek = document.createElement('div');
                peek.className = 'nexus-turbo-badge-peek';
                peek.title = 'Rýchly náhľad videí v albume';
                peek.setAttribute('data-turbo', 'false');
                peek.setAttribute('role', 'button');
                peek.innerHTML = '👁️';

                const blockNav = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                };

                peek.addEventListener('pointerdown', blockNav, true);
                peek.addEventListener('mousedown', blockNav, true);
                peek.addEventListener('mouseup', blockNav, true);
                peek.addEventListener('click', (e) => {
                    blockNav(e);
                    openAlbumQuickPeek(album);
                }, true);

                album.peekBtn = peek;
                const strip = card.querySelector('.strip, .relative') || card;
                strip.appendChild(peek);
            }

            libState.albums.set(id, album);
            added++;

            // 3. Try to restore cached metadata from sessionStorage or permanent IndexedDB
            try {
                const cached = sessionStorage.getItem(`nexus_turbo_alb_${id}`);
                if (cached) {
                    const parsed = JSON.parse(cached);
                    if (parsed && Array.isArray(parsed.files)) {
                        applyAlbumData(album, parsed);
                    }
                }
            } catch {}

            // Trvalé obnovenie z disku (IndexedDB)
            vaultGetAlbum(id).then((saved) => {
                if (saved && Array.isArray(saved.files) && saved.files.length) {
                    applyAlbumData(album, saved);
                    updateLibraryToolbar();
                    updateOnPageShowingText();
                }
            });
        });

        if (added > 0) {
            updateLibraryToolbar();
            updateOnPageShowingText();
        }
        return added;
    }

    async function openMergedAlbumQuickPeek() {
        const sources = Array.from(libState.albums.values()).filter(a => a.selected);
        if (!sources.length || libState.busy) return;
        libState.busy = true;
        updateLibraryToolbar();
        try {
            let next = 0;
            let completed = 0;
            const worker = async () => {
                while (next < sources.length) {
                    const source = sources[next++];
                    if (!source.scanned) await fetchAlbumMetadata(source);
                    completed++;
                    toast(`⏳ Pripravujem spoločný náhľad: ${completed}/${sources.length} albumov`);
                }
            };
            await Promise.all(Array.from({ length: Math.min(4, sources.length) }, worker));
            const failed = sources.filter(a => !a.scanned);
            const byId = new Map();
            for (const source of sources.filter(a => a.scanned)) {
                for (const file of source.files || []) {
                    if (!file.id) continue;
                    let entry = byId.get(file.id);
                    if (!entry) {
                        entry = { ...file, selected: true, sourceIds: [], sourceTitles: [] };
                        byId.set(file.id, entry);
                    }
                    entry.sourceIds.push(source.id);
                    entry.sourceTitles.push(source.title);
                }
            }
            const files = Array.from(byId.values());
            if (!files.length) {
                toast(failed.length ? `⚠️ Nepodarilo sa načítať ${failed.length} albumov; spoločný náhľad je prázdny.` : 'Vo vybratých albumoch sa nenašli videá.', true);
                return;
            }
            if (failed.length) toast(`⚠️ Nepodarilo sa načítať ${failed.length} albumov: ${failed.map(a => escapeHtml(a.title)).join(', ')}`, true);
            await openAlbumQuickPeek({ title: `Spoločný album (${sources.length - failed.length} albumov)`, sources: sources.filter(a => a.scanned), scanned: true, files, videoCount: files.length, totalBytes: files.reduce((sum, f) => sum + (Number(f.size) || 0), 0) });
        } finally {
            libState.busy = false;
            updateLibraryToolbar();
        }
    }

    async function fetchAlbumMetadata(album) {
        if (album.scanned && album.files.length > 0) return album;

        if (album.badgeEl) {
            album.badgeEl.className = 'nexus-turbo-album-badge badge-scanning';
            album.badgeEl.innerHTML = `<span class="badge-stat">🔍 Skenujem metadáta...</span>`;
        }

        try {
            const resp = await fetch(album.url, { credentials: 'same-origin' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const htmlText = await resp.text();
            const files = parseFilesFromHtml(htmlText);

            applyAlbumData(album, { files });

            try {
                sessionStorage.setItem(`nexus_turbo_alb_${album.id}`, JSON.stringify({ files }));
            } catch {}

            // Uloženie na disk do IndexedDB a na Nexus server
            const albumRecord = {
                id: album.id,
                title: album.title,
                url: album.url,
                scannedAt: Date.now(),
                files: files,
                videoCount: album.videoCount,
                totalBytes: album.totalBytes,
                avgBytes: album.avgBytes,
                avgDuration: album.avgDuration,
                quality: album.quality,
            };
            vaultSaveAlbum(albumRecord);
            syncAlbumToBackend(albumRecord);
            updateHistoryCounter();

            return album;
        } catch (err) {
            if (album.badgeEl) {
                album.badgeEl.className = 'nexus-turbo-album-badge';
                album.badgeEl.innerHTML = `<span class="badge-stat" style="color:#f85149">⚠️ Chyba skenu</span>`;
            }
            return album;
        }
    }

    async function runLibraryScanQueue() {
        if (!libState.scanning) return;

        while (libState.scanQueue.length > 0 && libState.scanActive < libState.scanMaxConcurrency) {
            const album = libState.scanQueue.shift();
            libState.scanActive++;
            updateLibraryToolbar();

            fetchAlbumMetadata(album).finally(() => {
                applyLibraryFilterAndSort();
                libState.scanActive--;
                updateLibraryToolbar();
                if (libState.scanQueue.length > 0 && libState.scanning) {
                    runLibraryScanQueue();
                } else if (libState.scanActive === 0 && libState.scanQueue.length === 0) {
                    libState.scanning = false;
                    toast(`✅ Skenovanie dokončené! Preskenovaných ${Array.from(libState.albums.values()).filter(a => a.scanned).length} albumov.`);
                    updateLibraryToolbar();
                }
            });
        }
    }

    function startLibraryScan() {
        const unscanned = Array.from(libState.albums.values()).filter(a => !a.scanned);
        if (unscanned.length === 0) {
            toast('Všetky zobrazené albumy sú už preskenované.');
            return;
        }
        libState.scanning = true;
        libState.scanQueue = unscanned;
        toast(`🔍 Spúšťam skenovanie ${unscanned.length} albumov...`);
        runLibraryScanQueue();
    }

    function stopLibraryScan() {
        libState.scanning = false;
        libState.scanQueue = [];
        toast('Skenovanie pozastavené.');
        updateLibraryToolbar();
    }

    async function loadNextPage(numPages = 1) {
        if (libState.loadingPage) return;
        libState.loadingPage = true;
        updateLibraryToolbar();

        let addedTotal = 0;

        for (let i = 0; i < numPages; i++) {
            const nextPage = (libState.highestPage || 1) + 1;
            if (nextPage > libState.maxPages) {
                toast(`Už si na poslednej stránke Turbo knižnice (${libState.maxPages}).`);
                break;
            }

            toast(`⏳ Načítavam stranu ${nextPage} z ${libState.maxPages}...`);
            try {
                const targetUrl = new URL(location.href);
                targetUrl.searchParams.set('page', nextPage);

                const resp = await fetch(targetUrl.toString(), { credentials: 'same-origin' });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const htmlText = await resp.text();

                const parser = new DOMParser();
                const doc = parser.parseFromString(htmlText, 'text/html');
                const newCards = doc.querySelectorAll('#grid a.alb, a.alb[href*="/a/"]');

                if (!newCards.length) {
                    toast(`Na strane ${nextPage} sa nenašli žiadne albumy.`);
                    break;
                }

                // Find destination container on current page (#grid preferred)
                const container = document.getElementById('grid')
                    || document.querySelector('.grid')
                    || document.querySelector('a.alb')?.parentElement;

                if (container) {
                    newCards.forEach((c) => {
                        // Avoid appending cards that might already be in container by href
                        const href = c.getAttribute('href') || '';
                        if (href && container.querySelector(`a.alb[href="${href}"]`)) {
                            return;
                        }
                        const importedCard = document.importNode(c, true);
                        container.appendChild(importedCard);
                    });
                }

                libState.highestPage = nextPage;
                libState.currentPage = nextPage;
                libState.loadedPages.add(nextPage);

                // Update maxPages if target doc has higher total
                const fetchedText = doc.body.innerText || '';
                const fm = fetchedText.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
                if (fm && fm[2]) {
                    libState.maxPages = Math.max(libState.maxPages, parseInt(fm[2], 10) || 40);
                }

                const addedThisPage = scanLibraryAlbums();
                addedTotal += (addedThisPage || 0);
                updateOnPageShowingText();
                applyLibraryFilterAndSort();
                toast(`➕ Pridaná strana ${nextPage}! (+${addedThisPage || newCards.length} nových albumov, celkovo ${libState.albums.size})`);

                if (libState.autoScanNewPages) {
                    startLibraryScan();
                }
            } catch (err) {
                toast(`Chyba pri načítaní strany ${nextPage}: ${err.message}`, true);
                break;
            }
        }

        libState.loadingPage = false;
        applyLibraryFilterAndSort();
    }

    function selectFirstNAlbums(count = 20) {
        const visibleAlbums = Array.from(libState.albums.values()).filter(a => a.visible !== false);
        let selectedCount = 0;
        visibleAlbums.forEach((album) => {
            const want = selectedCount < count;
            album.selected = want;
            if (album.chkEl) album.chkEl.checked = want;
            if (album.cardEl) album.cardEl.classList.toggle('is-selected', want);
            if (want) selectedCount++;
        });
        if (libState.filterOnlySelected) {
            applyLibraryFilterAndSort();
        } else {
            updateLibraryToolbar();
        }
        toast(`Označených prvých ${selectedCount} zobrazených albumov.`);
    }

    function selectAllAlbums(select = true) {
        const targetAlbums = Array.from(libState.albums.values()).filter(a => a.visible !== false);
        targetAlbums.forEach((album) => {
            album.selected = select;
            if (album.chkEl) album.chkEl.checked = select;
            if (album.cardEl) album.cardEl.classList.toggle('is-selected', select);
        });
        if (libState.filterOnlySelected) {
            applyLibraryFilterAndSort();
        } else {
            updateLibraryToolbar();
        }
        toast(select ? `Označených ${targetAlbums.length} zobrazených albumov.` : 'Výber zrušený.');
    }

    async function sendLibraryToTester() {
        const selected = Array.from(libState.albums.values()).filter(a => a.selected);
        if (!selected.length) {
            toast('Najprv označ aspoň jeden album na odoslanie do Testera.', true);
            return;
        }

        libState.busy = true;
        updateLibraryToolbar();

        // 1. Check if any selected album is not yet scanned; scan missing ones concurrently
        const unscanned = selected.filter(a => !a.scanned);
        if (unscanned.length > 0) {
            toast(`⏳ Rýchlo dočítavam metadáta pre ${unscanned.length} vybratých albumov...`);
            await Promise.allSettled(unscanned.map(a => fetchAlbumMetadata(a)));
        }

        // 2. Flatten all videos from selected albums
        const links = [];
        selected.forEach((album) => {
            (album.files || []).forEach((f) => {
                links.push({
                    url: `https://turbo.cr/v/${f.id}`,
                    host: 'turbo',
                    text: f.name || `Video ${f.id}`,
                    context: `Album: ${album.title}`,
                    quality: 'HD',
                });
            });
        });

        if (!links.length) {
            libState.busy = false;
            updateLibraryToolbar();
            toast('Vybraté albumy neobsahujú žiadne nájdené videá.', true);
            return;
        }

        toast(`🚀 Posielam ${links.length} videí (${selected.length} albumov) do Testera...`);

        chrome.runtime.sendMessage({
            action: 'NEXUS_TURBO_HUNTER_PUSH',
            thread_title: `Turbo.cr Library (${selected.length} albumov)`,
            thread_url: location.href,
            links: links,
            autostart: true,
            autoselect: true,
        }, (res) => {
            libState.busy = false;
            updateLibraryToolbar();
            if (res && res.ok) {
                toast(`🚀 Úspešne odoslané do Testera! (${links.length} videí) Otváram kartu...`);
            } else {
                toast(`Chyba Testera: ${res?.error || 'Nexus server neodpovedá na porte 8000/8001/8002'}`, true);
            }
        });
    }

    async function directImportLibrary() {
        const selected = Array.from(libState.albums.values()).filter(a => a.selected);
        if (!selected.length) {
            toast('Najprv označ aspoň jeden album na import.', true);
            return;
        }

        libState.busy = true;
        updateLibraryToolbar();

        const unscanned = selected.filter(a => !a.scanned);
        if (unscanned.length > 0) {
            toast(`⏳ Zisťujem súbory pre ${unscanned.length} albumov...`);
            await Promise.allSettled(unscanned.map(a => fetchAlbumMetadata(a)));
        }

        const items = [];
        selected.forEach((album) => {
            (album.files || []).forEach((f) => {
                items.push({
                    url: `https://turbo.cr/v/${f.id}`,
                    source_url: `https://turbo.cr/v/${f.id}`,
                    title: f.name || `Video ${f.id}`,
                    thumbnail: f.thumb || '',
                    duration: f.dur || 0,
                    quality: 'HD',
                    sizeBytes: f.size || 0,
                });
            });
        });

        if (!items.length) {
            libState.busy = false;
            updateLibraryToolbar();
            toast('Žiadne videá na import.', true);
            return;
        }

        toast(`⚡ Odosielam ${items.length} videí priamo do Nexus Vaultu...`);

        chrome.runtime.sendMessage({
            action: 'NEXUS_TURBO_IMPORT_BULK',
            batchName: `Turbo.cr Library (${selected.length} albumov)`,
            items: items,
        }, (res) => {
            libState.busy = false;
            updateLibraryToolbar();
            if (res && res.ok) {
                const count = res.data?.imported ?? items.length;
                toast(`⚡ Úspešne odoslané: ${count} videí do Nexus Vaultu!`);
            } else {
                toast(`Chyba importu: ${res?.error || 'Neznáma chyba'}`, true);
            }
        });
    }

    function updateLibraryToolbar() {
        const toolbar = document.getElementById(TOOLBAR_ID);
        if (!toolbar || !isLibraryPage()) return;

        const totalAlbums = libState.albums.size;
        const scannedAlbums = Array.from(libState.albums.values()).filter(a => a.scanned).length;
        const selectedAlbums = Array.from(libState.albums.values()).filter(a => a.selected);
        const selectedCount = selectedAlbums.length;

        const selectedVideos = selectedAlbums.reduce((sum, a) => sum + (a.videoCount || 0), 0);
        const selectedBytes = selectedAlbums.reduce((sum, a) => sum + (a.totalBytes || 0), 0);

        const countEl = toolbar.querySelector('.nexus-turbo-count');
        if (countEl) {
            countEl.innerHTML = `
                <b>${selectedCount}</b> / ${totalAlbums} albumov
                ${selectedCount > 0 ? `· <b>${selectedVideos}</b> videí (${formatBytes(selectedBytes)})` : ''}
            `;
        }

        const visibleAlbums = Array.from(libState.albums.values()).filter(a => a.visible !== false);
        const visibleCount = visibleAlbums.length;

        const statsEl = toolbar.querySelector('#nexus-turbo-lib-stats');
        if (statsEl) {
            const pageRange = libState.highestPage > 1 ? `1–${libState.highestPage}` : `${libState.highestPage || 1}`;
            statsEl.innerHTML = `
                <span>Strany: <b>${pageRange}</b> / ${libState.maxPages}</span>
                <span>Zobrazených: <b>${visibleCount}</b> / ${totalAlbums}</span>
            `;
        }

        const scanBtn = toolbar.querySelector('#nexus-turbo-scan-btn');
        if (scanBtn) {
            scanBtn.innerHTML = libState.scanning
                ? `⏸️ Pauza (${libState.scanQueue.length} v rade)`
                : `🔍 Skenovať albumy (${totalAlbums - scannedAlbums})`;
            scanBtn.style.background = libState.scanning ? 'rgba(210, 153, 34, 0.25)' : '';
        }

        const loadNextBtn = toolbar.querySelector('#nexus-turbo-load-next-btn');
        if (loadNextBtn) {
            loadNextBtn.disabled = libState.loadingPage;
            loadNextBtn.innerHTML = libState.loadingPage ? '⏳ Načítavam...' : '➕ Načítať ďalšiu stranu';
        }

        const testerBtn = toolbar.querySelector('#nexus-turbo-btn-tester');
        if (testerBtn) {
            testerBtn.disabled = selectedCount === 0 || libState.busy;
            testerBtn.innerHTML = libState.busy
                ? '⏳ Pripravujem...'
                : `🚀 Do Testera (${selectedCount} alb / ${selectedVideos} vid)`;
        }

        const mergedBtn = toolbar.querySelector('#nexus-turbo-btn-merged');
        if (mergedBtn) {
            mergedBtn.disabled = selectedCount === 0 || libState.busy;
            mergedBtn.textContent = libState.busy ? '⏳ Pripravujem...' : `👁️ Spoločný náhľad (${selectedCount})`;
        }

        const directImportBtn = toolbar.querySelector('#nexus-turbo-btn-direct');
        if (directImportBtn) {
            directImportBtn.disabled = selectedCount === 0 || libState.busy;
            directImportBtn.innerHTML = `⚡ Priamy import (${selectedCount})`;
        }

        const fillEl = toolbar.querySelector('.nexus-turbo-progress-fill');
        if (fillEl) {
            const pct = totalAlbums > 0 ? Math.round((scannedAlbums / totalAlbums) * 100) : 0;
            fillEl.style.width = `${pct}%`;
        }

        updateBubbleBadge();
    }

    function ensureLibraryToolbar() {
        if (!isLibraryPage()) return;
        let el = document.getElementById(TOOLBAR_ID);
        if (el) return;

        el = document.createElement('div');
        el.id = TOOLBAR_ID;
        el.innerHTML = `
            <div class="nexus-turbo-header" id="nexus-turbo-header">
                <div class="nexus-turbo-brand">
                    <span>⚡ NEXUS VAULT</span>
                </div>
                <div class="nexus-turbo-title" id="nexus-turbo-title">Library Scanner</div>
                <div class="nexus-turbo-header-actions">
                    <button class="nexus-turbo-min-btn" id="nexus-turbo-min-btn" title="Minimalizovať">—</button>
                </div>
            </div>

            <div class="nexus-turbo-info">
                <span class="nexus-turbo-count">0 / 0 albumov</span>
                <span style="font-size:11px;color:#58a6ff;">turbo.cr</span>
            </div>

            <div class="nexus-turbo-progress-bar">
                <div class="nexus-turbo-progress-fill"></div>
            </div>

            <div class="nexus-turbo-lib-stats" id="nexus-turbo-lib-stats">
                <span>Strany: 1 / 40</span>
                <span>Zobrazených: 0 / 0</span>
            </div>

            <!-- Filter & Sort Panel -->
            <div class="nexus-turbo-filter-box">
                <input type="search" class="nexus-turbo-search-input" id="nexus-turbo-search" placeholder="🔍 Filtrovať názov albumu...">
                
                <div class="nexus-turbo-filter-grid">
                    <div class="nexus-turbo-filter-field">
                        <label class="nexus-turbo-filter-label" for="nexus-turbo-sort">🔃 Zoradenie</label>
                        <select class="nexus-turbo-select" id="nexus-turbo-sort">
                            <option value="default">Pôvodné poradie</option>
                            <option value="size_desc">📦 Najväčšia veľkosť (GB)</option>
                            <option value="vids_desc">🎬 Najviac videí</option>
                            <option value="dur_desc">⏱️ Najdlhšie trvanie</option>
                            <option value="avg_desc">📊 Najvyššia Ø veľkosť</option>
                            <option value="selected_first">⚡ Vybraté najprv</option>
                            <option value="name_asc">🔤 Názov (A–Z)</option>
                        </select>
                    </div>

                    <div class="nexus-turbo-filter-field">
                        <label class="nexus-turbo-filter-label" for="nexus-turbo-filter-quality">💎 Kvalita</label>
                        <select class="nexus-turbo-select" id="nexus-turbo-filter-quality">
                            <option value="all">Kvalita: Všetky</option>
                            <option value="4k">💎 4K UHD</option>
                            <option value="1080p">⭐ 1080p+ (FHD & 4K)</option>
                            <option value="720p">⚡ 720p+ (HD a viac)</option>
                            <option value="sd">📁 480p SD</option>
                        </select>
                    </div>

                    <div class="nexus-turbo-filter-field">
                        <label class="nexus-turbo-filter-label" for="nexus-turbo-filter-vids">🎬 Min. videí</label>
                        <select class="nexus-turbo-select" id="nexus-turbo-filter-vids">
                            <option value="0">Videá: Všetky</option>
                            <option value="2">Videá: ≥ 2</option>
                            <option value="5">Videá: ≥ 5</option>
                            <option value="10">Videá: ≥ 10</option>
                            <option value="20">Videá: ≥ 20</option>
                            <option value="50">Videá: ≥ 50</option>
                        </select>
                    </div>

                    <div class="nexus-turbo-filter-field">
                        <label class="nexus-turbo-filter-label" for="nexus-turbo-filter-size">📦 Min. veľkosť</label>
                        <select class="nexus-turbo-select" id="nexus-turbo-filter-size">
                            <option value="0">Veľkosť: Všetky</option>
                            <option value="10">Veľkosť: ≥ 10 MB</option>
                            <option value="50">Veľkosť: ≥ 50 MB</option>
                            <option value="200">Veľkosť: ≥ 200 MB</option>
                            <option value="500">Veľkosť: ≥ 500 MB</option>
                            <option value="1000">Veľkosť: ≥ 1 GB</option>
                            <option value="2000">Veľkosť: ≥ 2 GB</option>
                            <option value="5000">Veľkosť: ≥ 5 GB</option>
                        </select>
                    </div>
                </div>

                <div class="nexus-turbo-toggles">
                    <button type="button" class="nexus-turbo-toggle-btn" id="nexus-turbo-toggle-hide-unselected" title="Zobraziť a usporiadať iba označené albumy">
                        👁️ Iba vybraté
                    </button>
                    <button type="button" class="nexus-turbo-toggle-btn" id="nexus-turbo-toggle-only-scanned" title="Skryť nepreskenované albumy">
                        🔍 Iba preskenované
                    </button>
                    <button type="button" class="nexus-turbo-toggle-btn" id="nexus-turbo-toggle-autoscan" title="Automaticky spustiť sken pri načítaní ďalších strán">
                        ⚡ Auto-sken
                    </button>
                </div>
            </div>

            <div class="nexus-turbo-lib-row">
                <div class="nexus-turbo-btn-group">
                    <button class="nexus-turbo-btn-sub" id="nexus-turbo-select-20" style="flex:1" title="Označiť TOP 20 zobrazených albumov">
                        TOP 20
                    </button>
                    <button class="nexus-turbo-btn-sub" id="nexus-turbo-select-all" style="flex:1" title="Označiť všetky zobrazené albumy">
                        Zobrazené
                    </button>
                    <button class="nexus-turbo-btn-sub" id="nexus-turbo-select-none" style="flex:1" title="Zrušiť výber">
                        Zrušiť
                    </button>
                </div>

                <div class="nexus-turbo-btn-group">
                    <button class="nexus-turbo-btn-sub" id="nexus-turbo-scan-btn" style="flex:2" title="Preskenovať Const FILES metadáta všetkých albumov">
                        🔍 Skenovať albumy
                    </button>
                    <button class="nexus-turbo-btn-sub" id="nexus-turbo-load-next-btn" style="flex:2" title="Načítať ďalšiu stranu pod seba">
                        ➕ Ďalšia strana
                    </button>
                    <button class="nexus-turbo-btn-sub" id="nexus-turbo-load-5-btn" style="flex:1" title="Načítať 5 strán naraz">
                        ⏩ +5
                    </button>
                </div>

                <button type="button" class="nexus-turbo-btn-sub" id="nexus-turbo-btn-merged" disabled>👁️ Spoločný náhľad (0)</button>

                <div class="nexus-turbo-btn-group" style="margin-top:2px;">
                    <button class="nexus-turbo-btn-sub" id="nexus-turbo-history-btn" style="flex:1" title="Zobraziť históriu všetkých preskenovaných albumov z disku">
                        📜 História (<span id="nexus-turbo-history-count">0</span>)
                    </button>
                    <button class="nexus-turbo-btn-tester" id="nexus-turbo-btn-tester" disabled title="Rozbaliť albumy a poslať videá do Testera (/tester)">
                        🚀 Do Testera (0)
                    </button>
                    <button class="nexus-turbo-btn-main" id="nexus-turbo-btn-direct" disabled title="Priamy hromadný import do Nexus DB">
                        ⚡ Import (0)
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(el);

        if (state.position) {
            applyPosition(el, state.position);
        }

        makeDraggable(el, el.querySelector('#nexus-turbo-header'), (x, y) => savePosition(x, y));

        el.querySelector('#nexus-turbo-min-btn').addEventListener('click', () => setMinimized(true));
        el.querySelector('#nexus-turbo-select-20').addEventListener('click', () => selectFirstNAlbums(20));
        el.querySelector('#nexus-turbo-select-all').addEventListener('click', () => selectAllAlbums(true));
        el.querySelector('#nexus-turbo-select-none').addEventListener('click', () => selectAllAlbums(false));
        el.querySelector('#nexus-turbo-history-btn')?.addEventListener('click', openLibraryHistoryModal);
        el.querySelector('#nexus-turbo-btn-merged').addEventListener('click', openMergedAlbumQuickPeek);
        updateHistoryCounter();

        // Quality Filter Listener
        el.querySelector('#nexus-turbo-filter-quality')?.addEventListener('change', (e) => {
            libState.filterQuality = e.target.value;
            applyLibraryFilterAndSort();
        });

        // Filter & Sort listeners
        const searchInput = el.querySelector('#nexus-turbo-search');
        searchInput.addEventListener('input', () => {
            libState.searchQuery = searchInput.value;
            applyLibraryFilterAndSort();
        });

        const sortSelect = el.querySelector('#nexus-turbo-sort');
        sortSelect.addEventListener('change', () => {
            libState.sortBy = sortSelect.value;
            applyLibraryFilterAndSort();
        });

        const vidsFilter = el.querySelector('#nexus-turbo-filter-vids');
        vidsFilter.addEventListener('change', () => {
            libState.filterMinVideos = parseInt(vidsFilter.value, 10) || 0;
            applyLibraryFilterAndSort();
        });

        const sizeFilter = el.querySelector('#nexus-turbo-filter-size');
        sizeFilter.addEventListener('change', () => {
            libState.filterMinSizeMB = parseInt(sizeFilter.value, 10) || 0;
            applyLibraryFilterAndSort();
        });

        const hideUnselectedBtn = el.querySelector('#nexus-turbo-toggle-hide-unselected');
        hideUnselectedBtn.addEventListener('click', () => {
            libState.filterOnlySelected = !libState.filterOnlySelected;
            hideUnselectedBtn.classList.toggle('is-active', libState.filterOnlySelected);
            applyLibraryFilterAndSort();
            toast(libState.filterOnlySelected ? '👁️ Zobrazené iba vybraté albumy (usporiadané za sebou)' : '👁️ Zobrazené všetky albumy');
        });

        const onlyScannedBtn = el.querySelector('#nexus-turbo-toggle-only-scanned');
        onlyScannedBtn.addEventListener('click', () => {
            libState.filterOnlyScanned = !libState.filterOnlyScanned;
            onlyScannedBtn.classList.toggle('is-active', libState.filterOnlyScanned);
            applyLibraryFilterAndSort();
        });

        const autoScanBtn = el.querySelector('#nexus-turbo-toggle-autoscan');
        autoScanBtn.addEventListener('click', () => {
            libState.autoScanNewPages = !libState.autoScanNewPages;
            autoScanBtn.classList.toggle('is-active', libState.autoScanNewPages);
            toast(libState.autoScanNewPages ? '⚡ Auto-skenovanie zapnuté' : 'Auto-skenovanie vypnuté');
        });

        el.querySelector('#nexus-turbo-scan-btn').addEventListener('click', () => {
            if (libState.scanning) stopLibraryScan();
            else startLibraryScan();
        });

        el.querySelector('#nexus-turbo-load-next-btn').addEventListener('click', () => loadNextPage(1));
        el.querySelector('#nexus-turbo-load-5-btn').addEventListener('click', () => loadNextPage(5));

        el.querySelector('#nexus-turbo-btn-tester').addEventListener('click', () => sendLibraryToTester());
        el.querySelector('#nexus-turbo-btn-direct').addEventListener('click', () => directImportLibrary());

        setMinimized(state.minimized);
        updateLibraryToolbar();

        // Infinite scroll listener
        window.addEventListener('scroll', () => {
            if (!libState.infiniteScroll || libState.loadingPage) return;
            if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 600) {
                loadNextPage(1);
            }
        }, { passive: true });
    }

    // ───────────────────────────────────────────────────────────────
    // 2. SINGLE ALBUM / WATCH PAGE LOGIC (EXISTING VAULT SUITE)
    // ───────────────────────────────────────────────────────────────

    function getAlbumTitle() {
        const h1 = document.querySelector('h1');
        if (h1 && h1.textContent.trim()) {
            return h1.textContent.trim();
        }
        const title = document.title.replace(/\s*[—\-]\s*turbo\.cr.*$/i, '').trim();
        return title || 'Turbo.cr Album';
    }

    function scanRows() {
        if (!isAlbumPage()) return;
        const fileRows = document.querySelectorAll('tr.file-row, tr[data-id]');
        let added = 0;

        fileRows.forEach((tr) => {
            const id = tr.getAttribute('data-id') || '';
            if (!id) return;

            const name = tr.getAttribute('data-name') || tr.querySelector('a')?.textContent.trim() || `Video ${id}`;
            const size = parseInt(tr.getAttribute('data-size') || '0', 10) || 0;

            const a = tr.querySelector('a[href*="/v/"], a[href*="/d/"], a');
            let pageUrl = a ? a.getAttribute('href') : `/v/${id}`;
            if (pageUrl && pageUrl.startsWith('/')) pageUrl = location.origin + pageUrl;
            if (pageUrl && pageUrl.includes('/d/')) pageUrl = pageUrl.replace('/d/', '/v/');
            if (!pageUrl) pageUrl = `https://turbo.cr/v/${id}`;

            let thumbnail = a?.getAttribute('data-thumb') || tr.querySelector('img')?.src || '';
            if (!thumbnail && id) {
                thumbnail = `https://static.scdn.st/6049fd43-838b-492d-a20a-9aead716dfe7/thumbs/${id}.jpg`;
            }

            let quality = 'HD';
            if (/2160|4k/i.test(name)) quality = '4K';
            else if (/1440|2k/i.test(name)) quality = '2K';
            else if (/1080/i.test(name)) quality = '1080p';
            else if (/720/i.test(name)) quality = '720p';

            if (!state.items.has(id)) {
                state.items.set(id, {
                    id,
                    url: pageUrl,
                    source_url: pageUrl,
                    title: name,
                    thumbnail,
                    size,
                    duration: 0,
                    quality,
                    selected: true,
                    row: tr,
                });
                added++;
            }

            const chk = tr.querySelector('input[type="checkbox"]');
            if (chk) {
                chk.classList.remove('pointer-events-none', 'opacity-30');
                chk.style.pointerEvents = 'auto';
                chk.style.opacity = '1';
                chk.style.cursor = 'pointer';
                chk.checked = !!state.items.get(id)?.selected;
                chk.onchange = () => {
                    const item = state.items.get(id);
                    if (item) {
                        item.selected = chk.checked;
                        updateToolbar();
                    }
                };
            }
        });

        if (added > 0 || state.items.size !== state.lastCardCount) {
            state.lastCardCount = state.items.size;
            updateToolbar();
            ensureGallery();
        }
    }

    function selectedItems() {
        return Array.from(state.items.values()).filter((it) => it.selected);
    }

    function setMinimized(minimized) {
        state.minimized = minimized;
        try {
            localStorage.setItem(STORAGE_MIN_KEY, String(minimized));
        } catch {}

        const toolbar = document.getElementById(TOOLBAR_ID);
        let bubble = document.getElementById(BUBBLE_ID);

        if (minimized) {
            if (toolbar) toolbar.classList.add('nexus-turbo-minimized');
            if (!bubble) {
                bubble = document.createElement('div');
                bubble.id = BUBBLE_ID;
                bubble.className = 'nexus-turbo-bubble';
                bubble.title = 'Nexus Vault (Turbo.cr) — Kliknutím rozbalíte';
                bubble.innerHTML = `
                    <span>⚡</span>
                    <div class="nexus-turbo-bubble-badge" id="nexus-turbo-bubble-badge">0</div>
                `;
                document.body.appendChild(bubble);

                makeDraggable(bubble, bubble, (x, y) => savePosition(x, y));

                bubble.addEventListener('click', () => {
                    if (bubble._hasMoved) {
                        bubble._hasMoved = false;
                        return;
                    }
                    setMinimized(false);
                });
            }
            bubble.style.display = 'flex';
            if (state.position) {
                applyPosition(bubble, state.position);
            }
            updateBubbleBadge();
        } else {
            if (toolbar) {
                toolbar.classList.remove('nexus-turbo-minimized');
                if (state.position) {
                    applyPosition(toolbar, state.position);
                }
            }
            if (bubble) bubble.style.display = 'none';
        }
    }

    function updateBubbleBadge() {
        const badge = document.getElementById('nexus-turbo-bubble-badge');
        if (!badge) return;
        const count = isLibraryPage()
            ? Array.from(libState.albums.values()).filter(a => a.selected).length
            : selectedItems().length;
        badge.textContent = count;
        badge.style.display = count > 0 ? 'block' : 'none';
    }

    function updateToolbar() {
        if (isLibraryPage()) {
            updateLibraryToolbar();
            return;
        }

        const toolbar = document.getElementById(TOOLBAR_ID);
        if (!toolbar) return;

        const total = state.items.size;
        const sel = selectedItems();
        const selCount = sel.length;
        const totalBytes = sel.reduce((acc, it) => acc + (it.size || 0), 0);

        const countEl = toolbar.querySelector('.nexus-turbo-count');
        if (countEl) {
            countEl.textContent = `${selCount} / ${total} vybratých (${formatBytes(totalBytes)})`;
        }

        const btnMain = toolbar.querySelector('.nexus-turbo-btn-main');
        if (btnMain) {
            btnMain.disabled = selCount === 0 || state.busy;
            btnMain.innerHTML = state.busy
                ? `⏳ Importujem ${selCount}...`
                : `⚡ Importovať do Nexusu (${selCount})`;
        }

        updateBubbleBadge();
        renderGallery();
    }

    function galleryItems() {
        const query = state.galleryQuery.trim().toLocaleLowerCase();
        const items = Array.from(state.items.values()).filter((item) => {
            return !query || `${item.title} ${item.id}`.toLocaleLowerCase().includes(query);
        });
        const sorters = {
            source: () => 0,
            name: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }),
            size: (a, b) => (b.size || 0) - (a.size || 0),
            selected: (a, b) => Number(b.selected) - Number(a.selected),
        };
        const sorter = sorters[state.gallerySort] || sorters.source;
        return state.gallerySort === 'source' ? items : items.sort(sorter);
    }

    function setGalleryOpen(open) {
        state.galleryOpen = !!open;
        try { localStorage.setItem(STORAGE_GALLERY_KEY, String(state.galleryOpen)); } catch {}
        const gallery = document.getElementById(GALLERY_ID);
        if (gallery) gallery.hidden = !state.galleryOpen;
        if (state.galleryOpen) renderGallery();
    }

    function openPlayer(item) {
        const old = document.getElementById(PLAYER_ID);
        if (old) old.remove();
        const id = String(item?.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
        if (!id) return;

        const dialog = document.createElement('div');
        dialog.id = PLAYER_ID;
        dialog.innerHTML = `
            <div class="nexus-turbo-player-backdrop" data-close-player></div>
            <section class="nexus-turbo-player-dialog" role="dialog" aria-modal="true" aria-label="Prehrať ${escapeHtml(item.title)}">
                <div class="nexus-turbo-player-head" id="nexus-turbo-player-drag-handle">
                    <span title="${escapeHtml(item.title)}">🎬 ${escapeHtml(item.title)}</span>
                    <div class="nexus-turbo-player-controls">
                        <button type="button" class="nexus-turbo-player-ctrl-btn" id="nexus-turbo-player-theater" title="Kino režim / Plná obrazovka">⛶</button>
                        <a href="https://turbo.cr/v/${encodeURIComponent(id)}" target="_blank" class="nexus-turbo-player-ctrl-btn" title="Otvoriť na Turbo.cr" style="text-decoration:none;">↗</a>
                        <button type="button" class="nexus-turbo-player-ctrl-btn close" data-close-player aria-label="Zavrieť prehrávač">✕</button>
                    </div>
                </div>
                <div class="nexus-turbo-player-body">
                    <iframe src="https://turbo.cr/embed/${encodeURIComponent(id)}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen></iframe>
                </div>
            </section>
        `;

        const dialogCard = dialog.querySelector('.nexus-turbo-player-dialog');
        const theaterBtn = dialog.querySelector('#nexus-turbo-player-theater');
        let isTheater = false;

        theaterBtn.addEventListener('click', () => {
            isTheater = !isTheater;
            dialogCard.classList.toggle('is-theater', isTheater);
            theaterBtn.innerHTML = isTheater ? '🗗' : '⛶';
            theaterBtn.title = isTheater ? 'Normálna veľkosť' : 'Kino režim / Plná obrazovka';
        });

        makeDraggable(dialogCard, dialog.querySelector('#nexus-turbo-player-drag-handle'));

        dialog.addEventListener('click', (event) => {
            if (event.target.hasAttribute('data-close-player')) {
                dialog.remove();
            }
        });

        const onKeyDown = (e) => {
            if (e.key === 'Escape') {
                dialog.remove();
                document.removeEventListener('keydown', onKeyDown);
            }
        };
        document.addEventListener('keydown', onKeyDown);

        document.body.appendChild(dialog);
    }

    function renderGallery() {
        const gallery = document.getElementById(GALLERY_ID);
        if (!gallery || gallery.hidden) return;
        const items = galleryItems();
        const total = items.length;
        const perPage = state.galleryPerPage;
        const maxPage = Math.max(0, Math.ceil(total / perPage) - 1);
        state.galleryPage = Math.max(0, Math.min(state.galleryPage, maxPage));
        const start = state.galleryPage * perPage;
        const pageItems = items.slice(start, start + perPage);

        const grid = gallery.querySelector('#nexus-turbo-gallery-grid');
        const count = gallery.querySelector('#nexus-turbo-gallery-count');
        const pagination = gallery.querySelector('#nexus-turbo-gallery-pagination');

        if (count) {
            count.textContent = `Zobrazených ${pageItems.length} z ${total} položiek (celkovo ${state.items.size})`;
        }

        if (grid) {
            grid.innerHTML = pageItems.map((item) => {
                const isSel = !!item.selected;
                return `
                    <article class="nexus-turbo-card ${isSel ? 'is-selected' : ''}" data-id="${escapeHtml(item.id)}">
                        <button class="nexus-turbo-card-check" type="button" data-toggle="${escapeHtml(item.id)}" aria-label="Označiť ${escapeHtml(item.title)}">
                            ${isSel ? '✓' : ''}
                        </button>
                        <button class="nexus-turbo-card-poster" type="button" data-play="${escapeHtml(item.id)}" data-card-play="${escapeHtml(item.id)}">
                            ${item.thumbnail ? `<img src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy">` : '<div class="nexus-turbo-card-fallback">NÁHĽAD</div>'}
                            <span class="nexus-turbo-card-play">▶</span>
                        </button>
                        <div class="nexus-turbo-card-body">
                            <h3 title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</h3>
                            <div class="nexus-turbo-card-meta">
                                <span>${escapeHtml(formatBytes(item.size))}</span>
                                <span>${escapeHtml(formatDuration(item.duration))}</span>
                                <span>${escapeHtml(item.quality || 'HD')}</span>
                            </div>
                            <div class="nexus-turbo-card-actions">
                                <button type="button" data-play="${escapeHtml(item.id)}" data-card-play="${escapeHtml(item.id)}">Prehrať</button>
                                <a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">Otvoriť</a>
                            </div>
                        </div>
                    </article>
                `;
            }).join('');
        }

        if (pagination) {
            pagination.innerHTML = `
                <button type="button" data-page="prev" ${state.galleryPage === 0 ? 'disabled' : ''}>← Predchádzajúca</button>
                <span>Strana ${state.galleryPage + 1} z ${maxPage + 1}</span>
                <button type="button" data-page="next" data-gallery-load ${state.galleryPage >= maxPage ? 'disabled' : ''}>Nasledujúca →</button>
            `;
        }
        const importButton = gallery.querySelector('[data-gallery-import]');
        if (importButton) {
            const selectedCount = selectedItems().length;
            importButton.disabled = selectedCount === 0 || state.busy;
            importButton.textContent = state.busy
                ? `Importujem ${selectedCount}...`
                : `Importovať označené (${selectedCount})`;
        }
    }

    function ensureGallery() {
        if (isLibraryPage()) return;
        let gallery = document.getElementById(GALLERY_ID);
        if (gallery) return;

        gallery = document.createElement('div');
        gallery.id = GALLERY_ID;
        gallery.hidden = !state.galleryOpen;
        gallery.innerHTML = `
            <section class="nexus-turbo-gallery-shell" aria-label="Nexus Vault galéria">
                <header class="nexus-turbo-gallery-header">
                    <div class="nexus-turbo-gallery-brand">
                        <span class="nexus-turbo-gallery-badge">NEXUS VAULT</span>
                        <div class="nexus-turbo-gallery-heading">
                            <h2>${escapeHtml(getAlbumTitle())}</h2>
                            <p id="nexus-turbo-gallery-count">Načítavam videá...</p>
                        </div>
                    </div>
                    <div class="nexus-turbo-gallery-actions">
                        <button type="button" class="nexus-turbo-gallery-select" id="nexus-turbo-select-all-btn">Označiť všetky</button>
                        <button type="button" class="nexus-turbo-gallery-select" id="nexus-turbo-select-none-btn">Zrušiť výber</button>
                        <button type="button" class="nexus-turbo-gallery-import" data-gallery-import>Importovať označené (0)</button>
                        <button type="button" class="nexus-turbo-gallery-quiet" id="nexus-turbo-gallery-close">Zavrieť</button>
                    </div>
                </header>

                <div class="nexus-turbo-gallery-tools">
                    <div class="nexus-turbo-gallery-search">
                        <input type="search" id="nexus-turbo-gallery-search-input" placeholder="Hľadať v albume..." value="${escapeHtml(state.galleryQuery)}">
                    </div>
                    <div class="nexus-turbo-gallery-sort">
                        <label for="nexus-turbo-gallery-sort-select">Zoradiť:</label>
                        <select id="nexus-turbo-gallery-sort-select">
                            <option value="source" ${state.gallerySort === 'source' ? 'selected' : ''}>Pôvodné poradie</option>
                            <option value="name" ${state.gallerySort === 'name' ? 'selected' : ''}>Názov</option>
                            <option value="size" ${state.gallerySort === 'size' ? 'selected' : ''}>Najväčšie</option>
                            <option value="selected" ${state.gallerySort === 'selected' ? 'selected' : ''}>Označené prvé</option>
                        </select>
                    </div>
                </div>

                <div class="nexus-turbo-gallery-grid" id="nexus-turbo-gallery-grid"></div>
                <div class="nexus-turbo-gallery-pagination" id="nexus-turbo-gallery-pagination"></div>
            </section>
        `;

        gallery.addEventListener('click', (event) => {
            const toggle = event.target.closest('[data-toggle]');
            if (toggle) {
                const id = toggle.getAttribute('data-toggle');
                const item = state.items.get(id);
                if (item) {
                    item.selected = !item.selected;
                    const chk = item.row?.querySelector('input[type="checkbox"]');
                    if (chk) chk.checked = item.selected;
                    updateToolbar();
                }
                return;
            }

            const play = event.target.closest('[data-play]');
            if (play) {
                const id = play.getAttribute('data-play');
                const item = state.items.get(id);
                if (item) openPlayer(item);
                return;
            }

            const pageBtn = event.target.closest('[data-page]');
            if (pageBtn) {
                const dir = pageBtn.getAttribute('data-page');
                state.galleryPage += dir === 'next' ? 1 : -1;
                renderGallery();
            }
        });

        gallery.querySelector('#nexus-turbo-gallery-close').addEventListener('click', () => setGalleryOpen(false));
        gallery.querySelector('#nexus-turbo-select-all-btn').addEventListener('click', () => {
            state.items.forEach((it) => {
                it.selected = true;
                const chk = it.row?.querySelector('input[type="checkbox"]');
                if (chk) chk.checked = true;
            });
            updateToolbar();
        });
        gallery.querySelector('#nexus-turbo-select-none-btn').addEventListener('click', () => {
            state.items.forEach((it) => {
                it.selected = false;
                const chk = it.row?.querySelector('input[type="checkbox"]');
                if (chk) chk.checked = false;
            });
            updateToolbar();
        });
        gallery.querySelector('[data-gallery-import]').addEventListener('click', () => {
            importItems(selectedItems());
        });

        const search = gallery.querySelector('#nexus-turbo-gallery-search-input');
        search.addEventListener('input', () => {
            state.galleryQuery = search.value;
            state.galleryPage = 0;
            renderGallery();
        });

        const sort = gallery.querySelector('#nexus-turbo-gallery-sort-select');
        sort.addEventListener('change', () => {
            state.gallerySort = sort.value;
            renderGallery();
        });

        document.body.appendChild(gallery);
        renderGallery();
    }

    function ensureToolbar() {
        if (isLibraryPage()) {
            ensureLibraryToolbar();
            return;
        }

        let el = document.getElementById(TOOLBAR_ID);
        if (el) return;

        el = document.createElement('div');
        el.id = TOOLBAR_ID;
        el.innerHTML = `
            <div class="nexus-turbo-header" id="nexus-turbo-header">
                <div class="nexus-turbo-brand">
                    <span>⚡ NEXUS VAULT</span>
                </div>
                <div class="nexus-turbo-title" id="nexus-turbo-title">${escapeHtml(getAlbumTitle())}</div>
                <div class="nexus-turbo-header-actions">
                    <button class="nexus-turbo-min-btn" id="nexus-turbo-min-btn" title="Minimalizovať">—</button>
                </div>
            </div>
            <div class="nexus-turbo-info">
                <span class="nexus-turbo-count">0 / 0 vybratých</span>
                <span>turbo.cr</span>
            </div>
            <div class="nexus-turbo-actions">
                <button class="nexus-turbo-btn-sub" id="nexus-turbo-gallery-btn">Galéria</button>
                <button class="nexus-turbo-btn-sub" id="nexus-turbo-select-btn">Označiť všetko</button>
                <button class="nexus-turbo-btn-main" id="nexus-turbo-import-btn">
                    ⚡ Importovať do Nexusu (0)
                </button>
            </div>
        `;

        document.body.appendChild(el);

        if (state.position) {
            applyPosition(el, state.position);
        }

        makeDraggable(el, el.querySelector('#nexus-turbo-header'), (x, y) => savePosition(x, y));

        el.querySelector('#nexus-turbo-min-btn').addEventListener('click', () => setMinimized(true));
        el.querySelector('#nexus-turbo-gallery-btn').addEventListener('click', () => setGalleryOpen(!state.galleryOpen));

        el.querySelector('#nexus-turbo-select-btn').addEventListener('click', () => {
            const allSelected = state.items.size > 0 && selectedItems().length === state.items.size;
            const newSelected = !allSelected;
            state.items.forEach((it) => {
                it.selected = newSelected;
                const chk = it.row?.querySelector('input[type="checkbox"]');
                if (chk) chk.checked = newSelected;
            });
            el.querySelector('#nexus-turbo-select-btn').textContent = newSelected ? 'Zrušiť výber' : 'Označiť všetko';
            updateToolbar();
        });

        el.querySelector('#nexus-turbo-import-btn').addEventListener('click', () => {
            importItems(selectedItems());
        });

        setMinimized(state.minimized);
    }

    function ensureWatchPageButton() {
        if (!isWatchPage()) return;
        if (document.getElementById('nexus-turbo-watch-btn')) return;

        const target = document.querySelector('.player-container, #player, .video-container, .card, main') || document.body;
        const wrap = document.createElement('div');
        wrap.id = 'nexus-turbo-watch-btn';
        wrap.className = 'nexus-turbo-watch-btn-wrap';
        wrap.innerHTML = `
            <button class="nexus-turbo-watch-btn">
                ⚡ Importovať toto video do Nexus Vaultu
            </button>
        `;

        wrap.querySelector('button').addEventListener('click', () => {
            const cleanUrl = location.href.split('#')[0];
            const title = document.querySelector('h1')?.textContent.trim() || document.title.replace(/\s*[—\-]\s*turbo\.cr.*$/i, '').trim();
            const videoEl = document.querySelector('video');

            importItems([{
                id: cleanUrl,
                url: cleanUrl,
                source_url: cleanUrl,
                title,
                thumbnail: videoEl?.getAttribute('poster') || '',
                duration: Math.round(videoEl?.duration || 0),
                quality: 'HD',
            }]);
        });

        if (target === document.body) {
            wrap.style.cssText = 'position:fixed;bottom:24px;left:24px;z-index:2147483646;';
            document.body.appendChild(wrap);
        } else {
            target.prepend(wrap);
        }
    }

    function importItems(items) {
        if (!items || !items.length || state.busy) return;
        state.busy = true;
        updateToolbar();

        const batchName = getAlbumTitle();
        toast(`Odosielam ${items.length} videí do Nexus Vaultu...`);

        chrome.runtime.sendMessage({
            action: 'NEXUS_TURBO_IMPORT_BULK',
            batchName: batchName || 'Turbo.cr Import',
            items: items.map((it) => ({
                url: it.url,
                source_url: it.source_url || it.url,
                title: it.title,
                thumbnail: it.thumbnail,
                duration: it.duration || 0,
                quality: it.quality || 'HD',
                sizeBytes: it.size || 0,
                direct_url: it.direct_url || null,
            })),
        }, (res) => {
            state.busy = false;
            updateToolbar();
            if (res && res.ok) {
                const count = res.data?.imported ?? items.length;
                toast(`⚡ Úspešne odoslané: ${count} videí do Nexus Vaultu!`);
            } else {
                toast(`Chyba importu: ${res?.error || 'Neznáma chyba'}`, true);
            }
        });
    }

    // ───────────────────────────────────────────────────────────────
    // 3. INITIALIZATION
    // ───────────────────────────────────────────────────────────────

    function init() {
        if (isLibraryPage()) {
            scanLibraryAlbums();
            ensureLibraryToolbar();
            const obs = new MutationObserver(() => scanLibraryAlbums());
            obs.observe(document.body, { childList: true, subtree: true });
        } else if (isAlbumPage()) {
            scanRows();
            ensureToolbar();
            ensureGallery();
            const obs = new MutationObserver(() => scanRows());
            obs.observe(document.body, { childList: true, subtree: true });
        } else if (isWatchPage()) {
            ensureWatchPageButton();
            const obs = new MutationObserver(() => ensureWatchPageButton());
            obs.observe(document.body, { childList: true, subtree: true });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

    async function updateHistoryCounter() {
        try {
            const albums = await vaultGetAllAlbums();
            const el = document.getElementById('nexus-turbo-history-count');
            if (el) el.textContent = albums.length;
        } catch {}
    }

    async function openLibraryHistoryModal() {
        const old = document.getElementById('nexus-turbo-history-modal');
        if (old) old.remove();

        toast('⏳ Načítavam históriu preskenovaných albumov z disku...');
        const albums = await vaultGetAllAlbums();
        albums.sort((a, b) => (b.scannedAt || 0) - (a.scannedAt || 0));

        let searchQuery = '';

        const modal = document.createElement('div');
        modal.id = 'nexus-turbo-history-modal';
        modal.innerHTML = `
            <div class="nexus-turbo-history-backdrop" data-close-history></div>
            <div class="nexus-turbo-history-dialog" role="dialog" aria-modal="true">
                <div class="nexus-turbo-history-header">
                    <div>
                        <h3 style="margin:0;font-size:16px;display:flex;align-items:center;gap:8px;">
                            📜 História preskenovaných albumov 
                            <span style="font-size:12px;color:#8b949e;font-weight:normal;">(uložených na disku: ${albums.length} albumov)</span>
                        </h3>
                    </div>
                    <div style="display:flex;align-items:center;gap:12px;">
                        <input type="text" id="nexus-turbo-history-search" class="nexus-turbo-peek-search-input" style="width:260px;" placeholder="🔍 Hľadať v histórii...">
                        <button type="button" class="nexus-turbo-btn-sub" id="nexus-turbo-history-sync" title="Odoslať zálohu histórie na disk Nexusu">💾 Zálohovať na disk</button>
                        <button type="button" class="nexus-turbo-min-btn" data-close-history style="font-size:18px;">✕</button>
                    </div>
                </div>
                <div class="nexus-turbo-history-body" id="nexus-turbo-history-list"></div>
            </div>
        `;

        document.body.appendChild(modal);

        const listEl = modal.querySelector('#nexus-turbo-history-list');
        const searchInput = modal.querySelector('#nexus-turbo-history-search');

        function renderHistoryList() {
            const q = searchQuery.trim().toLowerCase();
            const filtered = q
                ? albums.filter(a => (a.title || '').toLowerCase().includes(q) || (a.id || '').toLowerCase().includes(q))
                : albums;

            if (!filtered.length) {
                listEl.innerHTML = '<div style="padding:40px;text-align:center;color:#8b949e;">V histórii sa nenašli žiadne zodpovedajúce albumy.</div>';
                return;
            }

            listEl.innerHTML = filtered.map(a => {
                const dateStr = a.scannedAt ? new Date(a.scannedAt).toLocaleString() : 'Neznámy dátum';
                const qData = a.quality || calculateAlbumQuality(a.files || []);
                return `
                    <div class="nexus-turbo-history-item">
                        <div style="display:flex;flex-direction:column;gap:3px;flex:1;min-width:0;">
                            <div style="font-size:13.5px;font-weight:600;color:#e6edf3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(a.title)}">
                                📁 ${escapeHtml(a.title)}
                            </div>
                            <div style="font-size:11.5px;color:#8b949e;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
                                <span>🎬 <b>${a.videoCount || (a.files || []).length} videí</b></span>
                                <span>📦 <b>${formatBytes(a.totalBytes || 0)}</b></span>
                                <span class="badge-quality ${qData.badgeClass}">${qData.icon} ${qData.label} (${(qData.bitrateMbps || 0).toFixed(1)}M)</span>
                                <span>🕒 ${dateStr}</span>
                            </div>
                        </div>
                        <div style="display:flex;gap:8px;align-items:center;">
                            <button type="button" class="nexus-turbo-btn-sub" data-history-tester="${escapeHtml(a.id)}" title="Poslať videá tohto albumu do Testera">🚀 Do Testera</button>
                            <a href="${escapeHtml(a.url || ('https://turbo.cr/a/' + a.id))}" target="_blank" class="nexus-turbo-btn-sub" style="text-decoration:none;" title="Otvoriť album">↗ Otvoriť</a>
                        </div>
                    </div>
                `;
            }).join('');
        }

        renderHistoryList();

        searchInput.addEventListener('input', (e) => {
            searchQuery = e.target.value;
            renderHistoryList();
        });

        modal.addEventListener('click', (e) => {
            if (e.target.hasAttribute('data-close-history') || e.target.closest('[data-close-history]')) {
                modal.remove();
                return;
            }

            const testerBtn = e.target.closest('[data-history-tester]');
            if (testerBtn) {
                const aId = testerBtn.getAttribute('data-history-tester');
                const targetAlbum = albums.find(a => a.id === aId);
                if (targetAlbum && targetAlbum.files && targetAlbum.files.length) {
                    const links = targetAlbum.files.map(f => ({
                        url: `https://turbo.cr/v/${f.id}`,
                        host: 'turbo',
                        text: f.name || `Video ${f.id}`,
                        context: `Album: ${targetAlbum.title}`,
                        quality: 'HD',
                    }));
                    chrome.runtime.sendMessage({
                        action: 'NEXUS_TURBO_HUNTER_PUSH',
                        thread_title: `Turbo Album: ${targetAlbum.title}`,
                        thread_url: targetAlbum.url,
                        links: links,
                        autostart: true,
                        autoselect: true,
                    }, (res) => {
                        if (res && res.ok) toast(`🚀 ${links.length} videí odoslaných do Testera!`);
                        else toast(`Chyba Testera: ${res?.error || 'Server neodpovedá'}`, true);
                    });
                }
                return;
            }

            const syncBtn = e.target.closest('#nexus-turbo-history-sync');
            if (syncBtn) {
                syncBtn.disabled = true;
                syncBtn.textContent = '⏳ Zálohujem...';
                Promise.all(albums.map(a => syncAlbumToBackend(a))).then(() => {
                    syncBtn.textContent = '✓ Zálohované na disk!';
                    toast('✅ Všetky albumy z histórie boli úspešne zapísané na disk (data/turbo_vault_library.json).');
                }).catch((err) => {
                    syncBtn.disabled = false;
                    syncBtn.textContent = '💾 Zálohovať na disk';
                    toast(`Chyba zápisu na disk: ${err.message}`, true);
                });
            }
        });
    }
