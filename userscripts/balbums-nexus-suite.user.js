// ==UserScript==
// @name         Nexus Balbums Suite (Vault + Deep Scanner + Quick Peek)
// @namespace    https://github.com/nexus/balbums-suite
// @version      2.4.0
// @description  Pokročilý nástroj pre balbums.st: oddelenie videí od foto albumov, automatické zoradenie podľa veľkosti (GB/MB), podpora stránkovania (+1, +5, AutoPager), hĺbkový skener, okamžitá synchronizácia s Bunkr cache a export do Nexus Vault / Hunter testera.
// @author       Nexus Team
// @match        https://balbums.st/*
// @match        https://*.balbums.st/*
// @match        https://bunkr-albums.io/*
// @match        https://*.bunkr-albums.io/*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      *
// @connect      balbums.st
// @connect      bunkr-albums.io
// @connect      bunkr.is
// @connect      bunkr.to
// @connect      bunkr.site
// @connect      bunkr.black
// @connect      bunkr.ru
// @connect      bunkr.se
// @connect      bunkr.su
// @connect      bunkr.media
// @connect      bunkr.pm
// @connect      bunkr.ws
// @connect      bunkr.la
// @connect      bunkr.ci
// @connect      bunkr.cr
// @connect      bunkr.ac
// @connect      bunkr.red
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

(function () {

  // Universal Nexus i18n helper (supports Slovak and English)
  const _getLang = () => {
    try {
      if (typeof GM_getValue === 'function') {
        const g = GM_getValue('nexus_language');
        if (g === 'en' || g === 'sk') return g;
      }
      if (typeof localStorage !== 'undefined') {
        const l = localStorage.getItem('nexus_language');
        if (l === 'en' || l === 'sk') return l;
        const v = localStorage.getItem('vipSettings');
        if (v) {
          const p = JSON.parse(v);
          if (p.language === 'en' || p.tooltipLanguage === 'en') return 'en';
          if (p.language === 'sk' || p.tooltipLanguage === 'sk') return 'sk';
        }
      }
      if (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) {
        if (document.documentElement.lang.startsWith('sk')) return 'sk';
        if (document.documentElement.lang.startsWith('en')) return 'en';
      }
      if (typeof navigator !== 'undefined' && navigator.language && navigator.language.startsWith('sk')) return 'sk';
    } catch (_) {}
    return 'en';
  };
  const _t = (sk, en) => (_getLang() === 'sk' ? sk : en);

    'use strict';

    // ── Safe Isolation Guard ───────────────────────────────────────
    const host = window.location.hostname.toLowerCase();
    if (!host.includes('balbums.st') && !host.includes('bunkr-albums.io')) {
        return;
    }

    // ── Polyfills & Environment ────────────────────────────────────
    const GM_REQ = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : null;
    const GM_GET = typeof GM_getValue === 'function' ? GM_getValue : (k, d) => {
        try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; }
    };
    const GM_SET = typeof GM_setValue === 'function' ? GM_setValue : (k, v) => {
        try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
    };

    // ── Constants & Configuration ──────────────────────────────────
    const TOOLBAR_ID = 'nexus-balbums-toolbar';
    const BUBBLE_ID = 'nexus-balbums-bubble';
    const PLAYER_ID = 'nexus-balbums-player';
    const DB_NAME = 'nexus_vault_db';
    const DB_VERSION = 2;
    const DB_STORE = 'albums_cache';
    const STORAGE_POS_KEY = 'nexus_balbums_pos';
    const STORAGE_MIN_KEY = 'nexus_balbums_minimized';
    const STORAGE_PEEK_LAYOUT_KEY = 'nexus_balbums_peek_layout';
    const LEGACY_BUNKR_CACHE_KEY = 'bae_album_metadata_cache_v2';

    // Robust selectors matching current balbums.st and legacy structures
    const CARD_SELECTOR = 'a.card[href*="/a/"], a.card.rounded-xl, .rounded-xl.bg-mute.border-b';
    const GRID_SELECTOR = 'section.grid.gap-4, section.grid, main section.grid, div.grid.grid-cols-2';

    // ── State Management ───────────────────────────────────────────
    const libState = {
        albums: new Map(),           // urlKey -> albumObject
        scanQueue: [],
        scanning: false,
        scanActive: 0,
        scanMaxConcurrency: 4,
        currentPage: getUrlPage(),
        highestPage: getUrlPage(),
        loadedPages: new Set([getUrlPage()]),
        maxPages: 100,
        loadingPage: false,
        minimized: localStorage.getItem(STORAGE_MIN_KEY) === 'true',
        position: loadStoredPosition(),
        searchQuery: '',
        sortBy: 'default',          // 'default', 'size_desc', 'vids_desc', 'avg_desc', 'selected_first', 'name_asc'
        filterQuality: 'all',       // 'all', '4k', '1080p', '720p', 'sd', 'photos_only', 'hide_photos'
        filterMinVideos: 0,
        filterMinSizeMB: 0,
        filterOnlySelected: false,
        filterOnlyScanned: false,
        hidePhotoAlbums: true,      // Predvolene skryť čisto foto albumy (keďže hľadáme videá)
    };

    let sortDebounceTimer = null;

    function getUrlPage() {
        try {
            const p = parseInt(new URL(window.location.href).searchParams.get('page') || '1', 10);
            return isNaN(p) || p < 1 ? 1 : p;
        } catch {
            return 1;
        }
    }

    function loadStoredPosition() {
        try {
            const raw = localStorage.getItem(STORAGE_POS_KEY);
            if (raw) return JSON.parse(raw);
        } catch {}
        return { bottom: 20, right: 20 };
    }

    function savePosition(x, y) {
        try {
            localStorage.setItem(STORAGE_POS_KEY, JSON.stringify({ x, y }));
        } catch {}
    }

    function applyPosition(el, pos) {
        if (!el || !pos) return;
        el.style.top = 'auto';
        el.style.left = 'auto';
        if (typeof pos.x === 'number' && typeof pos.y === 'number') {
            const maxLeft = Math.max(10, window.innerWidth - (el.offsetWidth || 340) - 10);
            const maxTop = Math.max(10, window.innerHeight - (el.offsetHeight || 380) - 10);
            el.style.left = `${Math.min(Math.max(10, pos.x), maxLeft)}px`;
            el.style.top = `${Math.min(Math.max(10, pos.y), maxTop)}px`;
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        } else {
            el.style.right = `${pos.right ?? 20}px`;
            el.style.bottom = `${pos.bottom ?? 20}px`;
        }
    }

    // ── Formatting & Quality Calculator ────────────────────────────
    function formatBytes(bytes) {
        if (!bytes || isNaN(bytes) || bytes <= 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        const val = bytes / Math.pow(k, i);
        return `${val.toFixed(val >= 100 || i === 0 ? 0 : (val >= 10 ? 1 : 2))} ${sizes[i]}`;
    }

    function parseSizeToBytes(sizeStr) {
        if (!sizeStr) return 0;
        const s = String(sizeStr).trim();
        const match = s.match(/([\d.,\s]+)\s*(TB|GB|MB|KB|B)\b/i);
        if (!match) return 0;
        let rawNum = match[1].trim();

        if (rawNum.includes(',') && rawNum.includes('.')) {
            if (rawNum.lastIndexOf(',') > rawNum.lastIndexOf('.')) {
                rawNum = rawNum.replace(/\./g, '').replace(',', '.');
            } else {
                rawNum = rawNum.replace(/,/g, '');
            }
        } else if (rawNum.includes(',')) {
            rawNum = rawNum.replace(',', '.');
        }
        rawNum = rawNum.replace(/\s+/g, '');

        const value = parseFloat(rawNum);
        if (isNaN(value)) return 0;
        const unit = match[2].toUpperCase();
        const multipliers = {
            B: 1,
            KB: 1024,
            MB: 1024 * 1024,
            GB: 1024 * 1024 * 1024,
            TB: 1024 * 1024 * 1024 * 1024,
        };
        return value * (multipliers[unit] || 0);
    }

    function calculateAlbumQuality(totalBytes, videoCount, isPhotoOnly = false) {
        if (isPhotoOnly) {
            return { tier: 0, label: _t('Iba fotky', 'Photos only'), badgeClass: 'quality-photos', icon: '📷', tooltip: _t('Album obsahuje iba obrázky, žiadne videá', 'Album contains only pictures, no videos') };
        }
        if (!totalBytes || !videoCount || videoCount <= 0) {
            return { tier: 0, label: 'Neznáma', badgeClass: 'quality-unknown', icon: '❓', tooltip: 'Čaká na sken' };
        }
        const avgMB = totalBytes / (videoCount * 1024 * 1024);
        if (avgMB >= 650) {
            return { tier: 4, label: '4K Ultra', badgeClass: 'quality-4k', icon: '💎', tooltip: `Priemer ${avgMB.toFixed(0)} MB/vid (Veľmi vysoká kvalita)` };
        }
        if (avgMB >= 250) {
            return { tier: 3, label: '1080p+ HD', badgeClass: 'quality-1080p', icon: '⭐', tooltip: `Priemer ${avgMB.toFixed(0)} MB/vid (Vysoká kvalita)` };
        }
        if (avgMB >= 90) {
            return { tier: 2, label: '720p HQ', badgeClass: 'quality-720p', icon: '⚡', tooltip: `Priemer ${avgMB.toFixed(0)} MB/vid (Štandardná kvalita)` };
        }
        return { tier: 1, label: 'SD Light', badgeClass: 'quality-sd', icon: '📁', tooltip: `Priemer ${avgMB.toFixed(0)} MB/vid (Nižšia kvalita)` };
    }

    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function toast(msg, isError = false) {
        let t = document.getElementById('nexus-balbums-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'nexus-balbums-toast';
            t.className = 'nexus-balbums-toast';
            document.body.appendChild(t);
        }
        t.style.background = isError ? '#da3633' : '#238636';
        t.textContent = msg;
        t.classList.add('is-visible');
        clearTimeout(t._timer);
        t._timer = setTimeout(() => {
            t.classList.remove('is-visible');
        }, 3000);
    }

    // ── Safe Albums Grid Container Finder ──────────────────────────
    function getAlbumsContainer() {
        const firstCard = document.querySelector(CARD_SELECTOR);
        if (firstCard && firstCard.parentElement) {
            return firstCard.parentElement;
        }
        return document.querySelector(GRID_SELECTOR) || null;
    }

    // ── Legacy Bunkr Cache Reader ──────────────────────────────────
    function readLegacyBunkrCache() {
        try {
            const raw = GM_GET(LEGACY_BUNKR_CACHE_KEY, null);
            if (raw && raw.entries && typeof raw.entries === 'object') {
                return raw.entries;
            }
        } catch {}
        return {};
    }

    
    // ── Resilient HTTP GET Helper (GM_xmlhttpRequest with fetch fallback) ──
    function httpGet(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    timeout: 12000,
                    onload: (r) => {
                        if (r.status >= 200 && r.status < 300) resolve(r.responseText);
                        else reject(new Error(`HTTP ${r.status}`));
                    },
                    onerror: (e) => reject(new Error('Network error / CORS blocked')),
                    ontimeout: () => reject(new Error('Timeout')),
                });
            } else {
                fetch(url, { credentials: 'omit' })
                    .then(r => {
                        if (!r.ok) throw new Error(`HTTP ${r.status}`);
                        return r.text();
                    })
                    .then(resolve)
                    .catch(reject);
            }
        });
    }

    // ── IndexedDB Cache Persistence ────────────────────────────────
    let dbInstance = null;
    function openDb() {
        if (dbInstance) return Promise.resolve(dbInstance);
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(DB_STORE)) {
                    db.createObjectStore(DB_STORE, { keyPath: 'id' });
                }
            };
            req.onsuccess = () => {
                dbInstance = req.result;
                resolve(dbInstance);
            };
            req.onerror = () => reject(req.error);
        });
    }

    async function vaultGetAlbum(id) {
        try {
            const db = await openDb();
            return new Promise((resolve) => {
                const tx = db.transaction(DB_STORE, 'readonly');
                const store = tx.objectStore(DB_STORE);
                const req = store.get(id);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            });
        } catch {
            return null;
        }
    }

    async function vaultSaveAlbum(albumRecord) {
        try {
            const db = await openDb();
            return new Promise((resolve) => {
                const tx = db.transaction(DB_STORE, 'readwrite');
                const store = tx.objectStore(DB_STORE);
                store.put(albumRecord);
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => resolve(false);
            });
        } catch {
            return false;
        }
    }

    // ── Drag & Drop Engine ─────────────────────────────────────────
    function makeDraggable(panel, handle, onSave) {
        let isDragging = false;
        let startX = 0, startY = 0;
        let origX = 0, origY = 0;

        handle.addEventListener('mousedown', (e) => {
            if (e.target.closest('button, input, select')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            origX = rect.left;
            origY = rect.top;
            panel.classList.add('is-dragging');
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            e.preventDefault();
        });

        function onMouseMove(e) {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const newX = Math.max(10, Math.min(window.innerWidth - panel.offsetWidth - 10, origX + dx));
            const newY = Math.max(10, Math.min(window.innerHeight - panel.offsetHeight - 10, origY + dy));
            panel.style.top = `${newY}px`;
            panel.style.left = `${newX}px`;
            panel.style.bottom = 'auto';
            panel.style.right = 'auto';
        }

        function onMouseUp(e) {
            if (!isDragging) return;
            isDragging = false;
            panel.classList.remove('is-dragging');
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            const rect = panel.getBoundingClientRect();
            if (onSave) onSave(rect.left, rect.top);
        }
    }

    // ── CSS Styles Injection ───────────────────────────────────────
    function injectStyles() {
        if (document.getElementById('nexus-balbums-styles')) return;
        const style = document.createElement('style');
        style.id = 'nexus-balbums-styles';
        style.textContent = `
/* Potlačenie starých duplicitných elementov z predchádzajúceho bunkr-suite */
#bae-archive-dashboard,
.bae-cache-badge,
.bae-video-quality,
.bae-album-meta,
.bae-album-controls,
.album-preview-flex {
    display: none !important;
}

/* Card Selection and Modern Badges */
a.card, .rounded-xl.bg-mute.border-b {
    position: relative !important;
    transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease !important;
}
a.card.is-selected, .rounded-xl.bg-mute.border-b.is-selected {
    outline: 2px solid #58a6ff !important;
    outline-offset: 2px !important;
    box-shadow: 0 0 16px rgba(88, 166, 255, 0.35) !important;
}
a.card.nexus-balbums-hidden, .rounded-xl.bg-mute.border-b.nexus-balbums-hidden {
    display: none !important;
}

/* Top Checkbox Overlay on Album Card */
.nexus-balbums-chk-wrap {
    position: absolute;
    top: 8px;
    left: 8px;
    z-index: 15;
    background: rgba(13, 17, 23, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 6px;
    padding: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(4px);
    cursor: pointer;
}
.nexus-balbums-chk {
    width: 17px;
    height: 17px;
    cursor: pointer;
    accent-color: #58a6ff;
    margin: 0;
}

/* Eye Quick Peek Button on Album Card */
.nexus-balbums-peek-btn {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 15;
    background: rgba(13, 17, 23, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 6px;
    padding: 4px 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(4px);
    cursor: pointer;
    font-size: 13px;
    transition: transform 0.15s, background 0.15s;
    user-select: none;
}
.nexus-balbums-peek-btn:hover {
    transform: scale(1.1);
    background: #1f6feb;
    border-color: #58a6ff;
}

/* Compact Album Metadata Badge */
.nexus-balbums-album-badge {
    margin: 6px 8px 8px;
    padding: 5px 8px;
    background: rgba(22, 27, 34, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
    font-size: 11px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    z-index: 5;
}
.nexus-balbums-album-badge .badge-row-primary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-weight: 600;
}
.nexus-balbums-album-badge .badge-row-secondary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 10px;
    color: #8b949e;
}
.badge-stat {
    display: inline-flex;
    align-items: center;
    gap: 3px;
}
.badge-stat .stat-hl { color: #58a6ff; font-weight: 700; }
.badge-stat .stat-green { color: #3fb950; font-weight: 700; }
.badge-stat .stat-purple { color: #bc8cff; font-weight: 700; }
.badge-stat .stat-orange { color: #f0883e; font-weight: 700; }

.badge-quality {
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 9.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.3px;
}
.quality-4k { background: rgba(163, 113, 247, 0.25); color: #d2a8ff; border: 1px solid rgba(163, 113, 247, 0.4); }
.quality-1080p { background: rgba(56, 139, 253, 0.25); color: #79c0ff; border: 1px solid rgba(56, 139, 253, 0.4); }
.quality-720p { background: rgba(63, 185, 80, 0.25); color: #7ee787; border: 1px solid rgba(63, 185, 80, 0.4); }
.quality-sd { background: rgba(210, 153, 34, 0.25); color: #e3b341; border: 1px solid rgba(210, 153, 34, 0.4); }
.quality-photos { background: rgba(240, 136, 62, 0.25); color: #f0883e; border: 1px solid rgba(240, 136, 62, 0.4); }
.quality-unknown { background: rgba(110, 118, 129, 0.2); color: #8b949e; border: 1px solid rgba(110, 118, 129, 0.3); }

/* Floating Vault Panel */
#nexus-balbums-toolbar {
    position: fixed;
    z-index: 2147483640;
    width: 335px;
    background: rgba(13, 17, 23, 0.94);
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 12px;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.75), 0 0 1px 1px rgba(255, 255, 255, 0.1);
    backdrop-filter: blur(14px);
    color: #e6edf3;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 12px;
    user-select: none;
    transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1), transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
#nexus-balbums-toolbar.is-dragging {
    opacity: 0.9;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.9);
}
#nexus-balbums-toolbar.nexus-balbums-minimized {
    display: none !important;
}

/* Floating Minimized Bubble */
#nexus-balbums-bubble {
    position: fixed;
    bottom: 24px;
    right: 24px;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: linear-gradient(135deg, #1f6feb 0%, #238636 100%);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
    border: 2px solid rgba(255, 255, 255, 0.3);
    z-index: 2147483639;
    cursor: pointer;
    display: none;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    color: #fff;
    transition: transform 0.15s ease;
}
#nexus-balbums-bubble:hover {
    transform: scale(1.1);
}
#nexus-balbums-bubble.is-visible {
    display: flex !important;
}

/* Toolbar Sub-components */
.nexus-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: move;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    padding-bottom: 6px;
}
.nexus-brand {
    font-weight: 800;
    font-size: 11px;
    letter-spacing: 0.8px;
    color: #58a6ff;
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 5px;
}
.nexus-title {
    font-size: 11px;
    color: #8b949e;
    font-weight: 500;
}
.nexus-min-btn {
    background: transparent;
    border: none;
    color: #8b949e;
    cursor: pointer;
    font-size: 14px;
    padding: 0 4px;
    line-height: 1;
}
.nexus-min-btn:hover { color: #fff; }

.nexus-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 11.5px;
    color: #8b949e;
}
.nexus-info b { color: #e6edf3; }

.nexus-progress-bar {
    width: 100%;
    height: 4px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    overflow: hidden;
}
.nexus-progress-fill {
    height: 100%;
    width: 0%;
    background: linear-gradient(90deg, #58a6ff, #3fb950);
    transition: width 0.25s ease;
}

.nexus-signal-strip {
    display: grid;
    grid-template-columns: repeat(20, 1fr);
    gap: 2px;
    height: 12px;
    background: rgba(0, 0, 0, 0.3);
    border-radius: 3px;
    padding: 2px;
}
.nexus-signal-tile {
    background: rgba(255, 255, 255, 0.1);
    border-radius: 1px;
}
.nexus-signal-tile.scanned { background: #3fb950; }
.nexus-signal-tile.has-videos { background: #58a6ff; }
.nexus-signal-tile.is-photos { background: #f0883e; }

/* Filter Box */
.nexus-filter-box {
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    padding: 6px 8px;
}

.nexus-search-input {
    width: 100%;
    box-sizing: border-box;
    background: #0d1117;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 6px;
    color: #e6edf3;
    padding: 5px 8px;
    font-size: 12px;
    outline: none;
}
.nexus-search-input:focus { border-color: #58a6ff; }

.nexus-filter-grid {
    display: grid !important;
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    gap: 5px 6px !important;
    width: 100% !important;
    box-sizing: border-box !important;
}

.nexus-filter-field {
    display: flex !important;
    flex-direction: column !important;
    gap: 2px !important;
    min-width: 0 !important;
    width: 100% !important;
}

.nexus-filter-label {
    font-size: 9.5px !important;
    font-weight: 700 !important;
    color: #8b949e !important;
    text-transform: uppercase !important;
    letter-spacing: 0.3px !important;
}

.nexus-select {
    width: 100% !important;
    box-sizing: border-box !important;
    min-width: 0 !important;
    height: 28px !important;
    font-size: 11px !important;
    padding: 2px 4px !important;
    background: #0d1117 !important;
    border: 1px solid rgba(255, 255, 255, 0.15) !important;
    border-radius: 6px !important;
    color: #e6edf3 !important;
    outline: none !important;
    cursor: pointer !important;
}

.nexus-toggles { display: flex; gap: 4px; }
.nexus-toggle-btn {
    flex: 1;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    color: #8b949e;
    font-size: 10.5px;
    font-weight: 600;
    padding: 4px 0;
    cursor: pointer;
    text-align: center;
    transition: all 0.15s;
}
.nexus-toggle-btn:hover { color: #fff; background: rgba(255, 255, 255, 0.1); }
.nexus-toggle-btn.is-active { background: rgba(88, 166, 255, 0.2); border-color: #58a6ff; color: #58a6ff; }
.nexus-toggle-btn.is-active-orange { background: rgba(240, 136, 62, 0.2); border-color: #f0883e; color: #f0883e; }

/* Action Buttons */
.nexus-btn-group { display: flex; gap: 4px; }
.nexus-btn-sub {
    flex: 1;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 6px;
    color: #c9d1d9;
    font-size: 11px;
    font-weight: 600;
    padding: 5px 6px;
    cursor: pointer;
    transition: all 0.15s;
    text-align: center;
}
.nexus-btn-sub:hover:not(:disabled) { background: rgba(255, 255, 255, 0.14); color: #fff; }
.nexus-btn-sub:disabled { opacity: 0.5; cursor: not-allowed; }

.nexus-btn-tester {
    flex: 1;
    background: linear-gradient(135deg, rgba(168, 85, 247, 0.25) 0%, rgba(124, 58, 237, 0.35) 100%);
    border: 1px solid rgba(168, 85, 247, 0.6);
    border-radius: 6px;
    color: #d8b4fe;
    font-size: 11.5px;
    font-weight: 700;
    padding: 6px 8px;
    cursor: pointer;
    transition: all 0.15s;
}
.nexus-btn-tester:hover:not(:disabled) { background: #7c3aed; color: #fff; box-shadow: 0 4px 12px rgba(124, 58, 237, 0.4); }
.nexus-btn-tester:disabled { opacity: 0.4; cursor: not-allowed; }

.nexus-btn-main {
    flex: 1;
    background: linear-gradient(135deg, #238636 0%, #2ea043 100%);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 6px;
    color: #fff;
    font-size: 11.5px;
    font-weight: 700;
    padding: 6px 8px;
    cursor: pointer;
    transition: all 0.15s;
}
.nexus-btn-main:hover:not(:disabled) { background: #2ea043; box-shadow: 0 4px 12px rgba(46, 160, 67, 0.4); }
.nexus-btn-main:disabled { opacity: 0.4; cursor: not-allowed; }

/* Quick Peek Modal (3x2, 4x3, 2x2, Zoznam) */
.nexus-peek-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.85);
    backdrop-filter: blur(6px);
    z-index: 2147483645;
}

.nexus-peek-dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(1620px, 98vw);
    height: 94vh;
    max-height: 95vh;
    background: #0d1117;
    border: 1px solid rgba(255, 255, 255, 0.22);
    border-radius: 14px;
    box-shadow: 0 32px 100px rgba(0, 0, 0, 0.95);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    z-index: 2147483646;
    color: #e6edf3;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

.nexus-peek-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 18px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(22, 27, 34, 0.85);
}

.nexus-peek-controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 18px;
    background: rgba(13, 17, 23, 0.95);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    flex-wrap: wrap;
    gap: 10px;
}

.nexus-peek-layout-switch {
    display: flex;
    background: rgba(255, 255, 255, 0.06);
    border-radius: 6px;
    padding: 2px;
    gap: 2px;
}
.nexus-peek-layout-btn {
    background: transparent;
    border: none;
    color: #8b949e;
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
}
.nexus-peek-layout-btn.is-active {
    background: #1f6feb;
    color: #fff;
}

.nexus-peek-grid {
    flex: 1;
    overflow-y: auto;
    padding: 18px;
    display: grid;
    gap: 16px;
    align-content: start;
    box-sizing: border-box;
}

.nexus-peek-grid[data-layout="3x2"] {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    grid-auto-rows: minmax(360px, auto);
}
.nexus-peek-grid[data-layout="4x3"] {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    grid-auto-rows: minmax(300px, auto);
}
.nexus-peek-grid[data-layout="2x2"] {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-auto-rows: minmax(460px, auto);
}
.nexus-peek-grid[data-layout="list"] {
    grid-template-columns: 1fr;
    gap: 8px;
}

.nexus-peek-card {
    background: #161b22;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 10px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;
    transition: transform 0.15s, border-color 0.15s;
    min-height: 0;
}
.nexus-peek-card:hover {
    border-color: rgba(255, 255, 255, 0.25);
    transform: translateY(-2px);
}
.nexus-peek-card.is-selected {
    border-color: #58a6ff;
    box-shadow: 0 0 12px rgba(88, 166, 255, 0.3);
}

.nexus-peek-poster {
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 9;
    background: #000;
    overflow: hidden;
    cursor: pointer;
}
.nexus-peek-poster img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform 0.2s;
}
.nexus-peek-poster:hover img {
    transform: scale(1.03);
}

.nexus-peek-play-btn {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 44px;
    height: 44px;
    background: rgba(0, 0, 0, 0.7);
    border: 2px solid rgba(255, 255, 255, 0.8);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-size: 18px;
    padding-left: 3px;
    pointer-events: none;
    transition: all 0.15s;
}
.nexus-peek-poster:hover .nexus-peek-play-btn {
    background: #238636;
    border-color: #fff;
    transform: translate(-50%, -50%) scale(1.1);
}

.nexus-peek-card-body {
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
    min-height: 0;
}

.nexus-peek-card-title {
    font-size: 12.5px;
    font-weight: 600;
    color: #f0f6fc;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.3;
}

.nexus-peek-card-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    margin-top: auto;
}

.nexus-peek-btn-import {
    flex: 1;
    height: 30px;
    background: linear-gradient(135deg, #238636 0%, #2ea043 100%);
    border: 1px solid rgba(255, 255, 255, 0.25);
    color: #fff;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    cursor: pointer;
    transition: all 0.15s;
}
.nexus-peek-btn-import:hover { background: #2ea043; transform: translateY(-1px); }

.nexus-peek-btn-open {
    width: 30px;
    height: 30px;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: #c9d1d9;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    text-decoration: none;
    font-size: 13px;
    font-weight: bold;
}
.nexus-peek-btn-open:hover { background: rgba(255, 255, 255, 0.2); color: #fff; }

/* Cinema Video Player */
.nexus-player-dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(1360px, 96vw);
    height: min(840px, 92vh);
    background: #000;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 12px;
    box-shadow: 0 24px 90px rgba(0, 0, 0, 0.95);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    z-index: 2147483647;
    resize: both;
}

.nexus-player-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 16px;
    background: #111622;
    border-bottom: 1px solid rgba(255, 255, 255, 0.12);
}

.nexus-balbums-toast {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%) translateY(30px);
    background: #238636;
    color: #fff;
    padding: 10px 20px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    z-index: 2147483647;
    opacity: 0;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    pointer-events: none;
}
.nexus-balbums-toast.is-visible { transform: translateX(-50%) translateY(0); opacity: 1; }
        `;
        document.head.appendChild(style);
    }

    // ── Parse Files & Distinguish Videos vs Images ─────────────────
    function parseFilesFromBunkrHtml(htmlText, albumUrl) {
        const doc = new DOMParser().parseFromString(htmlText, 'text/html');
        const items = Array.from(doc.querySelectorAll('.grid-images .theItem, .theItem, [class*="grid-images_box"], a[href*="/f/"], a[href*="/v/"], a[href*="/i/"]'));
        const files = [];
        const seen = new Set();

        items.forEach((item) => {
            const link = (item.matches && item.matches('a[href*="/f/"], a[href*="/v/"], a[href*="/i/"]'))
                ? item
                : item.querySelector("a[href*='/f/'], a[href*='/v/'], a[href*='/i/']");
            if (!link) return;
            const href = link.getAttribute('href') || '';
            if (!href || seen.has(href)) return;
            seen.add(href);

            const isVideo = !!item.querySelector('.type-Video') || /\.(mp4|mkv|mov|webm|m4v|avi|ts)(\?|$)/i.test(href) || /\/v\//i.test(href);
            const isImage = !!item.querySelector('.type-Image') || /\.(jpg|jpeg|png|webp|gif|avif)(\?|$)/i.test(href) || /\/i\//i.test(href);

            const text = item.textContent || '';
            const sizeStr = (text.match(/([\d.,]+)\s*(TB|GB|MB|KB|B)\b/i) || [])[0] || '';
            const sizeBytes = parseSizeToBytes(sizeStr);

            const img = item.querySelector('img[data-src], img[data-lazy-src], img[data-original], img[src]');
            let thumb = img?.getAttribute('data-src') || img?.getAttribute('data-lazy-src') || img?.getAttribute('data-original') || img?.getAttribute('src') || '';
            if (thumb && !thumb.startsWith('http')) {
                try { thumb = new URL(thumb, albumUrl).href; } catch {}
            }

            const title = item.querySelector('p')?.textContent?.trim()
                || item.querySelector('.grid-images_box-name')?.textContent?.trim()
                || link.getAttribute('title')?.trim()
                || href.split('/').pop()?.replace(/[-_]+/g, ' ').trim()
                || (isVideo ? 'Video' : 'Obrázok');

            const idMatch = href.match(/\/[fvi]\/([a-zA-Z0-9_.-]+)/i);
            const id = idMatch ? idMatch[1] : href;

            files.push({
                id,
                href,
                title,
                size: sizeBytes,
                sizeStr,
                thumb,
                isVideo,
                isImage,
                selected: false,
            });
        });

        return files;
    }

    // ── Debounced Sort Trigger ─────────────────────────────────────
    function requestSortReorder() {
        clearTimeout(sortDebounceTimer);
        sortDebounceTimer = setTimeout(() => {
            if (libState.sortBy !== 'default') {
                applyFilterAndSort();
            }
        }, 50);
    }

    // ── DOM Scanning & Card Enrichment on balbums.st ───────────────
    function scanBalbumsPage() {
        // 1. Clean legacy duplicate badges
        document.querySelectorAll('.bae-cache-badge, .bae-video-quality, .bae-album-meta').forEach(el => el.remove());

        // 2. Read legacy cache entries
        const legacyEntries = readLegacyBunkrCache();

        const cards = document.querySelectorAll(CARD_SELECTOR);
        let added = 0;

        cards.forEach((card) => {
            let fullUrl = '';
            if (card.tagName === 'A' && card.href) {
                fullUrl = card.href;
            } else {
                const link = card.querySelector("a[href*='/a/'], a[href*='bunkr.']");
                fullUrl = link?.href || card.getAttribute('data-href') || card.getAttribute('href') || '';
            }
            if (!fullUrl || !fullUrl.includes('/a/')) return;

            const urlKey = fullUrl.replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
            if (libState.albums.has(urlKey)) {
                libState.albums.get(urlKey).cardEl = card;
                return;
            }

            const titleEl = card.querySelector('h3, p.text-subs span, .truncate') || card;
            const title = (titleEl.textContent || 'Bunkr Album').trim();

            // Extract initial file count from card text (e.g. "14 files", "162 files")
            let initialTotalFiles = parseInt(card.dataset.fileCount || '0', 10) || 0;
            if (initialTotalFiles === 0) {
                const countMatch = card.textContent.match(/(\d+)\s*(?:videos?|files?)/i);
                if (countMatch) initialTotalFiles = parseInt(countMatch[1], 10);
            }

            // Check if name indicates photos
            const looksLikePhotos = /\b(photos?|pics?|pictures?|images?|fotky)\b/i.test(title);

            // Check legacy cache
            let legacyData = legacyEntries[urlKey] || legacyEntries[urlKey.replace(/^\/+/, '')] || null;
            if (!legacyData) {
                for (const [k, v] of Object.entries(legacyEntries)) {
                    if (k.toLowerCase().includes(urlKey) || urlKey.includes(k.toLowerCase())) {
                        legacyData = v;
                        break;
                    }
                }
            }

            let scanned = false;
            let files = [];
            let videoCount = 0;
            let photoCount = 0;
            let initialBytes = parseFloat(card.dataset.totalSizeBytes || '0') || 0;

            if (legacyData && (legacyData.totalBytes || legacyData.files)) {
                files = Array.isArray(legacyData.files) ? legacyData.files : [];
                // Separate videos and photos in cached files
                const videoFiles = files.filter(f => f.isVideo !== false && !/\.(jpg|jpeg|png|webp|gif|avif)(\?|$)/i.test(f.href || ''));
                videoCount = videoFiles.length;
                photoCount = files.length - videoCount;
                initialBytes = videoFiles.reduce((acc, f) => acc + (f.size || 0), 0) || legacyData.totalBytes || 0;
                scanned = true;
            } else {
                // Pre-scan: We only know total file count from HTML, not video count!
                videoCount = looksLikePhotos ? 0 : initialTotalFiles;
                photoCount = looksLikePhotos ? initialTotalFiles : 0;
            }

            const isPhotoOnly = scanned ? (videoCount === 0 && photoCount > 0) : (looksLikePhotos && initialTotalFiles > 0);
            const quality = calculateAlbumQuality(initialBytes, videoCount, isPhotoOnly);

            const album = {
                id: urlKey,
                title,
                url: fullUrl,
                cardEl: card,
                chkEl: null,
                badgeEl: null,
                scanned,
                files,
                totalFiles: initialTotalFiles,
                videoCount,
                photoCount,
                isPhotoOnly,
                totalBytes: initialBytes,
                avgBytes: videoCount > 0 ? Math.round(initialBytes / videoCount) : 0,
                quality,
                selected: false,
                visible: true,
            };

            // 1. Attach Checkbox
            let chkWrap = card.querySelector('.nexus-balbums-chk-wrap');
            if (!chkWrap) {
                chkWrap = document.createElement('div');
                chkWrap.className = 'nexus-balbums-chk-wrap';
                chkWrap.setAttribute('data-nexus-prevent-nav', 'true');
                const chk = document.createElement('input');
                chk.type = 'checkbox';
                chk.className = 'nexus-balbums-chk';
                chk.setAttribute('data-nexus-prevent-nav', 'true');
                chk.title = `Označiť album: ${title}`;
                chkWrap.appendChild(chk);

                const stopChkNav = (e) => {
                    e.stopPropagation();
                    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                };
                ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(evt => {
                    chkWrap.addEventListener(evt, stopChkNav, true);
                    chkWrap.addEventListener(evt, stopChkNav, false);
                });

                chk.addEventListener('change', () => {
                    album.selected = chk.checked;
                    card.classList.toggle('is-selected', album.selected);
                    updateToolbar();
                });
                album.chkEl = chk;
                card.appendChild(chkWrap);
            }

            // 2. Attach Quick Peek Eye Button
            let peek = card.querySelector('.nexus-balbums-peek-btn');
            if (!peek) {
                peek = document.createElement('div');
                peek.className = 'nexus-balbums-peek-btn';
                peek.setAttribute('data-nexus-prevent-nav', 'true');
                peek.title = 'Rýchly náhľad položiek v albume (Quick Peek)';
                peek.innerHTML = '👁️';

                const stopPeekAndOpen = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                    if (e.type === 'click') {
                        openQuickPeekModal(album);
                    }
                };
                ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(evt => {
                    peek.addEventListener(evt, stopPeekAndOpen, true);
                    peek.addEventListener(evt, stopPeekAndOpen, false);
                });
                card.appendChild(peek);
            }

            // 3. Attach Metadata Badge
            let badge = card.querySelector('.nexus-balbums-album-badge');
            if (!badge) {
                badge = document.createElement('div');
                badge.className = 'nexus-balbums-album-badge';
                // Insert after description or thumbnail
                const bodyWrap = card.querySelector('.p-3\\.5, .p-3, div:last-child') || card;
                bodyWrap.appendChild(badge);
            }
            album.badgeEl = badge;

            renderAlbumBadge(album);

            libState.albums.set(urlKey, album);
            added++;

            if (scanned) {
                vaultSaveAlbum({
                    id: album.id,
                    title: album.title,
                    url: album.url,
                    files: album.files,
                    totalFiles: album.totalFiles,
                    videoCount: album.videoCount,
                    photoCount: album.photoCount,
                    isPhotoOnly: album.isPhotoOnly,
                    totalBytes: album.totalBytes,
                    avgBytes: album.avgBytes,
                    quality: album.quality,
                    scannedAt: Date.now(),
                });
            } else {
                vaultGetAlbum(urlKey).then((saved) => {
                    if (saved && (saved.totalBytes > 0 || (saved.files && saved.files.length))) {
                        applyAlbumData(album, saved);
                        updateToolbar();
                        requestSortReorder();
                    }
                });
            }
        });

        if (added > 0) {
            updateToolbar();
            updateHeatmap();
            requestSortReorder();
        }
    }

    function renderAlbumBadge(album) {
        if (!album.badgeEl) return;
        if (album.isPhotoOnly) {
            album.badgeEl.innerHTML = `
                <div class="badge-row-primary">
                    <span class="badge-stat">📷 <b class="stat-orange">${album.photoCount || album.totalFiles} fotiek</b></span>
                    <span class="badge-quality quality-photos">📷 Iba fotky</span>
                </div>
                <div class="badge-row-secondary">
                    <span class="badge-stat">⚠️ 0 videí</span>
                    <span class="badge-stat">🕒 ${album.scanned ? 'Preskenované' : 'Foto album'}</span>
                </div>
            `;
            return;
        }

        if (album.scanned && album.totalBytes > 0) {
            album.badgeEl.innerHTML = `
                <div class="badge-row-primary">
                    <span class="badge-stat">🎬 <b class="stat-hl">${album.videoCount} vid</b></span>
                    <span class="badge-stat">📦 <b class="stat-green">${formatBytes(album.totalBytes)}</b></span>
                    <span class="badge-quality ${album.quality.badgeClass}" title="${escapeHtml(album.quality.tooltip)}">${album.quality.icon} <b>${album.quality.label}</b></span>
                </div>
                <div class="badge-row-secondary">
                    <span class="badge-stat">📊 Ø <b class="stat-purple">${formatBytes(album.avgBytes)}</b> / vid</span>
                    <span class="badge-stat">🕒 Preskenované</span>
                </div>
            `;
        } else {
            album.badgeEl.innerHTML = `
                <div class="badge-row-primary">
                    <span class="badge-stat">📁 <b class="stat-hl">${album.totalFiles} súborov</b></span>
                    <span class="badge-stat" style="color:#8b949e;">⏳ Čaká na sken</span>
                </div>
            `;
        }
    }

    function applyAlbumData(album, data) {
        album.scanned = true;
        const allFiles = data.files || [];
        album.files = allFiles;

        const videoFiles = allFiles.filter(f => f.isVideo !== false && !/\.(jpg|jpeg|png|webp|gif|avif)(\?|$)/i.test(f.href || ''));
        const photoFiles = allFiles.filter(f => f.isVideo === false || /\.(jpg|jpeg|png|webp|gif|avif)(\?|$)/i.test(f.href || ''));

        album.videoCount = videoFiles.length;
        album.photoCount = photoFiles.length;
        album.totalFiles = allFiles.length || album.totalFiles;
        album.isPhotoOnly = (album.videoCount === 0 && album.photoCount > 0);

        album.totalBytes = videoFiles.reduce((acc, f) => acc + (f.size || 0), 0) || (album.isPhotoOnly ? 0 : (data.totalBytes || 0));
        album.avgBytes = album.videoCount > 0 ? Math.round(album.totalBytes / album.videoCount) : 0;
        album.quality = calculateAlbumQuality(album.totalBytes, album.videoCount, album.isPhotoOnly);

        renderAlbumBadge(album);
    }

    // ── Filter & Sort Logic ────────────────────────────────────────
    function applyFilterAndSort() {
        const albums = Array.from(libState.albums.values());
        const query = libState.searchQuery.trim().toLowerCase();

        albums.forEach((album) => {
            let visible = true;

            // 1. Hide Photo Albums Filter
            if (libState.hidePhotoAlbums && album.isPhotoOnly) {
                visible = false;
            }

            // 2. Selection & Scan state
            if (visible && libState.filterOnlySelected && !album.selected) visible = false;
            if (visible && libState.filterOnlyScanned && !album.scanned) visible = false;

            // 3. Search Query
            if (visible && query) {
                const titleMatch = (album.title || '').toLowerCase().includes(query);
                const fileMatch = album.files.some(f => (f.title || '').toLowerCase().includes(query));
                if (!titleMatch && !fileMatch) visible = false;
            }

            // 4. Min Videos
            if (visible && libState.filterMinVideos > 0) {
                if (album.videoCount < libState.filterMinVideos) visible = false;
            }

            // 5. Min Size MB
            if (visible && libState.filterMinSizeMB > 0) {
                const mb = (album.totalBytes || 0) / (1024 * 1024);
                if (mb < libState.filterMinSizeMB) visible = false;
            }

            // 6. Quality Filter
            if (visible && libState.filterQuality !== 'all') {
                if (libState.filterQuality === 'photos_only') {
                    if (!album.isPhotoOnly) visible = false;
                } else if (!album.quality) {
                    visible = false;
                } else {
                    const tier = album.quality.tier || 0;
                    if (libState.filterQuality === '4k' && tier < 4) visible = false;
                    if (libState.filterQuality === '1080p' && tier < 3) visible = false;
                    if (libState.filterQuality === '720p' && tier < 2) visible = false;
                    if (libState.filterQuality === 'sd' && (tier < 1 || tier > 1)) visible = false;
                }
            }

            album.visible = visible;
            if (album.cardEl) {
                album.cardEl.classList.toggle('nexus-balbums-hidden', !visible);
                album.cardEl.style.setProperty('display', visible ? '' : 'none', 'important');
            }
        });

        // 7. Guaranteed DOM Reordering by Sorting
        if (libState.sortBy !== 'default') {
            const sorted = [...albums].sort((a, b) => {
                if (libState.sortBy === 'size_desc') {
                    const diff = (b.totalBytes || 0) - (a.totalBytes || 0);
                    if (diff !== 0) return diff;
                    return (b.videoCount || 0) - (a.videoCount || 0);
                }
                if (libState.sortBy === 'vids_desc') return (b.videoCount || 0) - (a.videoCount || 0);
                if (libState.sortBy === 'avg_desc') return (b.avgBytes || 0) - (a.avgBytes || 0);
                if (libState.sortBy === 'name_asc') return (a.title || '').localeCompare(b.title || '');
                if (libState.sortBy === 'selected_first') return Number(b.selected) - Number(a.selected);
                return 0;
            });

            // Guaranteed reordering in actual DOM parent container
            sorted.forEach((a) => {
                if (a.cardEl && a.cardEl.parentElement) {
                    a.cardEl.parentElement.appendChild(a.cardEl);
                }
            });
        }

        updateToolbar();
    }

    // ── Pagination: Load Next Page & Multi-page Loader ──────────────
    async function loadNextPage(batchCount = 1) {
        if (libState.loadingPage) return;
        libState.loadingPage = true;
        updateToolbar();

        const loadBtn = document.getElementById('nexus-load-next');
        if (loadBtn) loadBtn.textContent = '⏳ Načítavam...';

        const container = getAlbumsContainer();
        let loaded = 0;

        for (let i = 0; i < batchCount; i++) {
            const targetPage = libState.highestPage + 1;
            const currentUrl = new URL(window.location.href);
            currentUrl.searchParams.set('page', targetPage);

            try {
                const resp = await fetch(currentUrl.toString(), { credentials: 'same-origin' });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const htmlText = await resp.text();
                const doc = new DOMParser().parseFromString(htmlText, 'text/html');
                const newCards = Array.from(doc.querySelectorAll(CARD_SELECTOR));

                if (!newCards.length) {
                    toast(`Dosiahnutý koniec zoznamu (strana ${targetPage - 1}).`);
                    break;
                }

                if (container) {
                    newCards.forEach((card) => {
                        container.appendChild(card);
                    });
                }

                libState.highestPage = targetPage;
                libState.loadedPages.add(targetPage);
                loaded += newCards.length;

                scanBalbumsPage();
                applyFilterAndSort();
            } catch (err) {
                toast(`Chyba načítania strany ${targetPage}: ${err.message}`, true);
                break;
            }
        }

        libState.loadingPage = false;
        updateToolbar();
        if (loaded > 0) {
            toast(_t(`➕ Úspešne načítaných ${loaded} nových albumov (strana ${libState.highestPage}).`, `➕ Successfully loaded ${loaded} new albums (page ${libState.highestPage}).`));
        }
    }

    // ── Deep Scanner Queue ─────────────────────────────────────────
    async function fetchAlbumMetadata(album) {
        if (!album.url) {
            console.warn('[Nexus Balbums] Missing URL for album:', album.title);
            return album;
        }
        try {
            const res = await httpGet(album.url);
            const files = parseFilesFromBunkrHtml(res, album.url);
            applyAlbumData(album, { files });

            // Save to IndexedDB
            const record = {
                id: album.id,
                title: album.title,
                url: album.url,
                files,
                totalFiles: album.totalFiles,
                videoCount: album.videoCount,
                photoCount: album.photoCount,
                isPhotoOnly: album.isPhotoOnly,
                totalBytes: album.totalBytes,
                avgBytes: album.avgBytes,
                quality: album.quality,
                scannedAt: Date.now(),
            };
            vaultSaveAlbum(record);
            return album;
        } catch {
            if (album.badgeEl) {
                album.badgeEl.innerHTML = `<span class="badge-stat" style="color:#f85149">⚠️ Chyba skenu</span>`;
            }
            return album;
        }
    }

    async function runScanQueue() {
        if (!libState.scanning) return;
        while (libState.scanQueue.length > 0 && libState.scanActive < libState.scanMaxConcurrency) {
            const album = libState.scanQueue.shift();
            libState.scanActive++;
            updateToolbar();
            updateHeatmap();

            fetchAlbumMetadata(album).finally(() => {
                libState.scanActive--;
                applyFilterAndSort();
                updateToolbar();
                updateHeatmap();
                if (libState.scanQueue.length > 0 && libState.scanning) {
                    runScanQueue();
                } else if (libState.scanActive === 0 && libState.scanQueue.length === 0) {
                    libState.scanning = false;
                    toast(`✅ Skenovanie dokončené! Preskenovaných ${Array.from(libState.albums.values()).filter(a => a.scanned).length} albumov.`);
                    updateToolbar();
                    updateHeatmap();
                }
            });
        }
    }

    function startScan() {
        let targets = Array.from(libState.albums.values()).filter(a => !a.scanned || (!a.files || !a.files.length));
        if (!targets.length) {
            // Force re-scan all visible albums if everything was already in cache
            targets = Array.from(libState.albums.values()).filter(a => a.visible !== false);
        }
        if (!targets.length) {
            toast(_t('Žiadne albumy na skenovanie.', 'No albums to scan.'));
            return;
        }
        libState.scanning = true;
        libState.scanQueue = [...targets];
        toast('🔍 Skenujem ' + targets.length + ' albumov...');
        runScanQueue();
        updateToolbar();
    }

    function stopScan() {
        libState.scanning = false;
        libState.scanQueue = [];
        updateToolbar();
    }

    // ── Quick Peek Modal (Multi-Layout) ────────────────────────────
    function openQuickPeekModal(album) {
        let modal = document.getElementById('nexus-balbums-peek-modal');
        if (modal) modal.remove();

        modal = document.createElement('div');
        modal.id = 'nexus-balbums-peek-modal';
        let currentLayout = localStorage.getItem(STORAGE_PEEK_LAYOUT_KEY) || '4x3';
        let peekQuery = '';

        modal.innerHTML = `
            <div class="nexus-peek-backdrop"></div>
            <div class="nexus-peek-dialog">
                <div class="nexus-peek-header">
                    <div style="display:flex;align-items:center;gap:10px;min-width:0;">
                        <span style="font-size:16px;">${album.isPhotoOnly ? '📷' : '📁'}</span>
                        <div style="font-size:14px;font-weight:700;color:#f0f6fc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(album.title)}">
                            ${escapeHtml(album.title)}
                        </div>
                        <span style="font-size:12px;color:#8b949e;">(${album.videoCount} videí · ${album.photoCount} fotiek · ${formatBytes(album.totalBytes)})</span>
                    </div>
                    <button type="button" class="nexus-min-btn" style="font-size:20px;padding:2px 8px;" id="nexus-peek-close">✕</button>
                </div>

                <div class="nexus-peek-controls">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <input type="checkbox" id="nexus-peek-select-all" class="nexus-balbums-chk">
                        <label for="nexus-peek-select-all" style="font-size:12px;cursor:pointer;">Označiť všetky</label>
                        <input type="search" id="nexus-peek-search" class="nexus-search-input" style="width:200px;" placeholder="🔍 Hľadať v albume...">
                    </div>

                    <div style="display:flex;align-items:center;gap:10px;">
                        <div class="nexus-peek-layout-switch">
                            <button type="button" class="nexus-peek-layout-btn ${currentLayout === '3x2' ? 'is-active' : ''}" data-layout="3x2">3x2</button>
                            <button type="button" class="nexus-peek-layout-btn ${currentLayout === '4x3' ? 'is-active' : ''}" data-layout="4x3">4x3</button>
                            <button type="button" class="nexus-peek-layout-btn ${currentLayout === '2x2' ? 'is-active' : ''}" data-layout="2x2">2x2</button>
                            <button type="button" class="nexus-peek-layout-btn ${currentLayout === 'list' ? 'is-active' : ''}" data-layout="list">Zoznam</button>
                        </div>

                        <button type="button" class="nexus-btn-sub" id="nexus-peek-split" style="background:#8957e5;color:#fff;">📺 Split-Screen</button>
                        <button type="button" class="nexus-btn-tester" id="nexus-peek-tester">🚀 Do Testera</button>
                        <button type="button" class="nexus-btn-main" id="nexus-peek-import-btn">⚡ Importovať</button>
                    </div>
                </div>

                <div class="nexus-peek-grid" data-layout="${currentLayout}"></div>
            </div>
        `;
        document.body.appendChild(modal);

        const gridEl = modal.querySelector('.nexus-peek-grid');
        const selectAllChk = modal.querySelector('#nexus-peek-select-all');
        const searchInput = modal.querySelector('#nexus-peek-search');

        if (!album.files || !album.files.length) {
            gridEl.innerHTML = '<div style="padding:40px;text-align:center;color:#8b949e;">⏳ Sťahujem zoznam položiek z Bunkru...</div>';
            fetchAlbumMetadata(album).then(() => {
                renderGrid();
            });
        }

        function renderGrid() {
            gridEl.dataset.layout = currentLayout;
            const query = peekQuery.toLowerCase();
            const filtered = query
                ? album.files.filter(f => (f.title || '').toLowerCase().includes(query))
                : album.files;

            if (!filtered.length) {
                gridEl.innerHTML = `<div style="padding:40px;text-align:center;color:#8b949e;">${_t('V albume sa nenašli žiadne položky.', 'No items found in album.')}</div>`;
                return;
            }

            if (currentLayout === 'list') {
                gridEl.innerHTML = filtered.map(f => `
                    <div class="nexus-peek-card" style="min-height:0;flex-direction:row;align-items:center;padding:8px 12px;gap:12px;" data-file-id="${escapeHtml(f.id)}">
                        <input type="checkbox" class="nexus-balbums-chk file-chk" ${f.selected ? 'checked' : ''} data-file-chk="${escapeHtml(f.id)}">
                        <div class="nexus-peek-poster" style="width:90px;height:52px;flex-shrink:0;" data-play-file="${escapeHtml(f.href)}">
                            <img src="${escapeHtml(f.thumb || '')}" alt="" onerror="this.style.display='none'">
                            ${f.isVideo ? '<span class="nexus-peek-play-btn" style="width:26px;height:26px;font-size:12px;">▶</span>' : '<span style="position:absolute;top:3px;right:3px;font-size:10px;">📷</span>'}
                        </div>
                        <div style="flex:1;min-width:0;">
                            <div class="nexus-peek-card-title" title="${escapeHtml(f.title)}">${escapeHtml(f.title)}</div>
                            <div style="font-size:11px;color:#8b949e;margin-top:2px;">${f.isVideo ? '🎬 Video' : '📷 Fotka'} · 📦 ${formatBytes(f.size)}</div>
                        </div>
                        ${f.isVideo ? `<button type="button" class="nexus-btn-sub" style="flex:0 0 auto;" data-play-file="${escapeHtml(f.href)}">▶ Prehrať</button>` : ''}
                        <button type="button" class="nexus-peek-btn-import" style="flex:0 0 auto;padding:0 12px;" data-import-single="${escapeHtml(f.id)}">⚡ Import</button>
                        <a href="${escapeHtml(f.href)}" target="_blank" class="nexus-peek-btn-open">↗</a>
                    </div>
                `).join('');
            } else {
                gridEl.innerHTML = filtered.map(f => `
                    <div class="nexus-peek-card ${f.selected ? 'is-selected' : ''}" data-file-id="${escapeHtml(f.id)}">
                        <div class="nexus-peek-poster" data-play-file="${escapeHtml(f.href)}">
                            <div class="nexus-balbums-chk-wrap">
                                <input type="checkbox" class="nexus-balbums-chk file-chk" ${f.selected ? 'checked' : ''} data-file-chk="${escapeHtml(f.id)}">
                            </div>
                            <img src="${escapeHtml(f.thumb || '')}" alt="" loading="lazy">
                            ${f.isVideo ? '<div class="nexus-peek-play-btn" title="Prehrať">▶</div>' : '<div style="position:absolute;top:6px;right:6px;background:rgba(0,0,0,0.6);border-radius:4px;padding:2px 5px;font-size:11px;">📷 Fotka</div>'}
                            <div style="position:absolute;bottom:6px;right:6px;background:rgba(0,0,0,0.75);border-radius:4px;padding:2px 6px;font-size:10.5px;font-weight:600;">
                                📦 ${formatBytes(f.size)}
                            </div>
                        </div>
                        <div class="nexus-peek-card-body">
                            <div class="nexus-peek-card-title" title="${escapeHtml(f.title)}">${escapeHtml(f.title)}</div>
                            <div class="nexus-peek-card-actions">
                                <button type="button" class="nexus-peek-btn-import" data-import-single="${escapeHtml(f.id)}">⚡ Import</button>
                                <a href="${escapeHtml(f.href)}" target="_blank" class="nexus-peek-btn-open" title="Otvoriť">↗</a>
                            </div>
                        </div>
                    </div>
                `).join('');
            }
        }

        renderGrid();

        // Layout Switcher
        modal.querySelectorAll('.nexus-peek-layout-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                currentLayout = btn.dataset.layout;
                localStorage.setItem(STORAGE_PEEK_LAYOUT_KEY, currentLayout);
                modal.querySelectorAll('.nexus-peek-layout-btn').forEach(b => b.classList.remove('is-active'));
                btn.classList.add('is-active');
                renderGrid();
            });
        });

        // Search Input
        searchInput.addEventListener('input', (e) => {
            peekQuery = e.target.value;
            renderGrid();
        });

        // Select All
        selectAllChk.addEventListener('change', () => {
            const check = selectAllChk.checked;
            album.files.forEach(f => f.selected = check);
            modal.querySelectorAll('.file-chk').forEach(c => c.checked = check);
            modal.querySelectorAll('.nexus-peek-card').forEach(c => c.classList.toggle('is-selected', check));
        });

        // Delegate Grid Actions (Play, Select, Import)
        gridEl.addEventListener('click', (e) => {
            const chk = e.target.closest('.file-chk');
            if (chk) {
                const fId = chk.dataset.fileChk;
                const file = album.files.find(f => f.id === fId);
                if (file) {
                    file.selected = chk.checked;
                    chk.closest('.nexus-peek-card')?.classList.toggle('is-selected', file.selected);
                }
                return;
            }

            const playTarget = e.target.closest('[data-play-file]');
            if (playTarget) {
                const href = playTarget.dataset.playFile;
                const file = album.files.find(f => f.href === href);
                if (file && file.isVideo) {
                    openCinemaPlayer(href, file?.title || album.title);
                } else if (file) {
                    window.open(href, '_blank');
                }
                return;
            }

            const importSingle = e.target.closest('[data-import-single]');
            if (importSingle) {
                const fId = importSingle.dataset.importSingle;
                const file = album.files.find(f => f.id === fId);
                if (file) importSingleVideo(file, album);
                return;
            }
        });

        // Split-Screen
        modal.querySelector('#nexus-peek-split').addEventListener('click', () => {
            const selected = album.files.filter(f => f.selected && f.isVideo);
            const targets = selected.length ? selected : album.files.filter(f => f.isVideo).slice(0, 4);
            const urls = targets.map(f => f.href);
            const titles = targets.map(f => f.title);
            if (!urls.length) {
                toast(_t('Album neobsahuje žiadne videá pre Split-Screen.', 'Album contains no videos for Split-Screen.'), true);
                return;
            }
            window.dispatchEvent(new CustomEvent('nexus-turbo-split-open', { detail: { urls, titles } }));
            toast(`📺 Spustený Split-Screen pre ${urls.length} videí!`);
        });

        // Hunter /tester Push
        modal.querySelector('#nexus-peek-tester').addEventListener('click', () => {
            const selected = album.files.filter(f => f.selected);
            const targets = selected.length ? selected : album.files;
            sendVideosToTester(targets, album.title, album.url);
        });

        // Close
        const closeModal = () => modal.remove();
        modal.querySelector('#nexus-peek-close').addEventListener('click', closeModal);
        modal.querySelector('.nexus-peek-backdrop').addEventListener('click', closeModal);
    }

    // ── Cinema Video Player ────────────────────────────────────────
    async function openCinemaPlayer(fileUrl, title) {
        let player = document.getElementById(PLAYER_ID);
        if (player) player.remove();

        player = document.createElement('div');
        player.id = PLAYER_ID;
        player.innerHTML = `
            <div class="nexus-peek-backdrop"></div>
            <div class="nexus-player-dialog">
                <div class="nexus-player-header">
                    <span style="font-weight:700;font-size:13px;color:#f0f6fc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:80%;">
                        🎬 ${escapeHtml(title)}
                    </span>
                    <button type="button" class="nexus-min-btn" style="font-size:20px;" id="nexus-player-close">✕</button>
                </div>
                <div style="flex:1;background:#000;display:flex;align-items:center;justify-content:center;position:relative;" id="nexus-player-container">
                    <span style="color:#8b949e;font-size:14px;">⏳ Resolvujem priamy stream z Bunkru...</span>
                </div>
            </div>
        `;
        document.body.appendChild(player);

        const closeBtn = player.querySelector('#nexus-player-close');
        const backdrop = player.querySelector('.nexus-peek-backdrop');
        const container = player.querySelector('#nexus-player-container');

        const closePlayer = () => player.remove();
        closeBtn.addEventListener('click', closePlayer);
        backdrop.addEventListener('click', closePlayer);

        const streamUrl = await resolveBunkrStream(fileUrl);
        container.innerHTML = `
            <video src="${escapeHtml(streamUrl)}" controls autoplay playsinline style="width:100%;height:100%;object-fit:contain;background:#000;"></video>
        `;
    }

    // ── Hunter /tester Integration ─────────────────────────────────
    async function sendVideosToTester(files, albumTitle, albumUrl) {
        if (!files.length) {
            toast(_t('Žiadne položky na odoslanie.', 'No items to send.'), true);
            return;
        }

        const candidatePorts = [8000, 8001, 8002];
        let workingPort = null;

        for (const port of candidatePorts) {
            try {
                const ok = await new Promise((resolve) => {
                    GM_REQ({
                        method: 'GET',
                        url: `http://localhost:${port}/health`,
                        timeout: 1000,
                        onload: (r) => resolve(r.status === 200),
                        onerror: () => resolve(false),
                        ontimeout: () => resolve(false),
                    });
                });
                if (ok) { workingPort = port; break; }
            } catch {}
        }

        if (!workingPort) {
            toast('Nexus server nie je dostupný na portoch 8000/8001/8002.', true);
            return;
        }

        const links = files.map(f => ({
            url: f.href,
            host: 'bunkr',
            text: f.title || (f.isVideo ? 'Bunkr video' : 'Bunkr image'),
            context: `Album: ${albumTitle}`,
            quality: f.isVideo ? 'HD' : 'Photo',
        }));

        const payload = {
            thread_title: `Balbums: ${albumTitle}`,
            thread_url: albumUrl,
            links,
            autostart: true,
            autoselect: true,
        };

        GM_REQ({
            method: 'POST',
            url: `http://localhost:${workingPort}/api/v1/hunter/push`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify(payload),
            timeout: 15000,
            onload: (r) => {
                try {
                    const data = JSON.parse(r.responseText);
                    if (data && data.session_id) {
                        const targetUrl = `http://localhost:${workingPort}/tester?hunter=1&session=${encodeURIComponent(data.session_id)}&autostart=1&autoselect=1`;
                        window.open(targetUrl, '_blank');
                        toast(`🚀 ${links.length} položiek odoslaných do Testera (port ${workingPort})!`);
                    } else {
                        toast(_t('Chyba: Server nevrávil session_id', 'Error: Server did not return session_id'), true);
                    }
                } catch (e) { toast(`Chyba odpovede servera: ${e.message}`, true); }
            },
            onerror: () => toast('Chyba komunikácie s Nexus Hunter endpointom.', true),
        });
    }

    async function sendSelectedAlbumsToTester() {
        const selected = Array.from(libState.albums.values()).filter(a => a.selected);
        if (!selected.length) {
            toast('Najprv označte aspoň 1 album.');
            return;
        }

        toast(`⏳ Zhromažďujem videá z ${selected.length} označených albumov...`);
        const allFiles = [];

        for (const alb of selected) {
            if (!alb.scanned || !alb.files.length) {
                await fetchAlbumMetadata(alb);
            }
            allFiles.push(...alb.files.map(f => ({ ...f, albumTitle: alb.title, albumUrl: alb.url })));
        }

        if (!allFiles.length) {
            toast(_t('V označených albumoch sa nenašli žiadne položky.', 'No items found in selected albums.'), true);
            return;
        }

        sendVideosToTester(allFiles, `${selected.length} Bunkr albumov`, location.href);
    }

    // ── Direct Import to Vault ─────────────────────────────────────
    async function importSingleVideo(file, album) {
        toast(`Importujem: ${file.title}...`);
        const candidate = {
            url: file.href,
            source_url: file.href,
            title: file.title,
            thumbnail: file.thumb,
            file_size_mb: Number((file.size / (1024 * 1024)).toFixed(2)),
            source: 'bunkr',
            tags: ['bunkr', 'balbums', file.isVideo ? 'video' : 'photo'],
        };

        GM_REQ({
            method: 'POST',
            url: 'http://localhost:8000/api/v1/intake/import',
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ batch_name: `Balbums: ${album.title}`, candidates: [candidate] }),
            onload: (r) => {
                if (r.status >= 200 && r.status < 300) toast(`⚡ Položka "${file.title}" importovaná!`);
                else toast(`Chyba importu HTTP ${r.status}`, true);
            },
            onerror: () => toast('Nexus server neodpovedá.', true),
        });
    }

    // ── Floating Nexus Toolbar ─────────────────────────────────────
    function ensureToolbar() {
        let el = document.getElementById(TOOLBAR_ID);
        if (el) return;

        el = document.createElement('div');
        el.id = TOOLBAR_ID;
        el.innerHTML = `
            <div class="nexus-header" id="nexus-drag-handle">
                <div class="nexus-brand">⚡ NEXUS VAULT</div>
                <div class="nexus-title">Balbums Scanner</div>
                <button class="nexus-min-btn" id="nexus-btn-minimize" title="Minimalizovať">—</button>
            </div>

            <div class="nexus-info">
                <span id="nexus-stats-count"><b>0</b> / 0 albumov</span>
                <span style="font-size:11px;color:#58a6ff;">balbums.st</span>
            </div>

            <div class="nexus-progress-bar">
                <div class="nexus-progress-fill" id="nexus-progress"></div>
            </div>

            <!-- Signal Heatmap Strip -->
            <div class="nexus-signal-strip" id="nexus-heatmap" title="Stav prvých 100 albumov (zelená = preskenované, modrá = videá, oranžová = foto)"></div>

            <!-- Filter Panel -->
            <div class="nexus-filter-box">
                <input type="search" class="nexus-search-input" id="nexus-search" placeholder="🔍 Hľadať (album alebo video, kláves /)...">

                <div class="nexus-filter-grid">
                    <div class="nexus-filter-field">
                        <label class="nexus-filter-label" for="nexus-sort">🔃 Zoradenie</label>
                        <select class="nexus-select" id="nexus-sort">
                            <option value="default">Pôvodné poradie</option>
                            <option value="size_desc">📦 Najväčšia veľkosť (GB)</option>
                            <option value="vids_desc">🎬 Najviac videí</option>
                            <option value="avg_desc">📊 Najvyššia Ø veľkosť</option>
                            <option value="selected_first">⚡ Vybraté najprv</option>
                            <option value="name_asc">🔤 Názov (A–Z)</option>
                        </select>
                    </div>

                    <div class="nexus-filter-field">
                        <label class="nexus-filter-label" for="nexus-quality">💎 Kvalita / Typ</label>
                        <select class="nexus-select" id="nexus-quality">
                            <option value="all">Kvalita: Všetky</option>
                            <option value="4k">💎 4K Very High</option>
                            <option value="1080p">⭐ 1080p+ High</option>
                            <option value="720p">⚡ 720p+ Standard</option>
                            <option value="sd">📁 Light SD</option>
                            <option value="photos_only">📷 Iba Foto albumy</option>
                        </select>
                    </div>

                    <div class="nexus-filter-field">
                        <label class="nexus-filter-label" for="nexus-vids">🎬 Min. videí</label>
                        <select class="nexus-select" id="nexus-vids">
                            <option value="0">Videá: Všetky</option>
                            <option value="1">Videá: ≥ 1 (bez fotiek)</option>
                            <option value="2">Videá: ≥ 2</option>
                            <option value="5">Videá: ≥ 5</option>
                            <option value="10">Videá: ≥ 10</option>
                            <option value="20">Videá: ≥ 20</option>
                            <option value="50">Videá: ≥ 50</option>
                        </select>
                    </div>

                    <div class="nexus-filter-field">
                        <label class="nexus-filter-label" for="nexus-size">📦 Min. veľkosť</label>
                        <select class="nexus-select" id="nexus-size">
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

                <div class="nexus-toggles">
                    <button type="button" class="nexus-toggle-btn is-active-orange" id="nexus-toggle-hide-photos" title="' + _t('Skryť albumy, ktoré neobsahujú žiadne videá', 'Hide albums that contain no videos') + '">📷 ' + _t('Skryť foto', 'Hide photos') + ' (${countPhotoAlbums()})</button>
                    <button type="button" class="nexus-toggle-btn" id="nexus-toggle-selected">👁️ Iba vybraté</button>
                    <button type="button" class="nexus-toggle-btn" id="nexus-toggle-scanned">🔍 Iba preskenované</button>
                </div>
            </div>

            <!-- Action Buttons -->
            <div style="display:flex;flex-direction:column;gap:5px;">
                <div class="nexus-btn-group">
                    <button type="button" class="nexus-btn-sub" id="nexus-top-20">TOP 20</button>
                    <button type="button" class="nexus-btn-sub" id="nexus-select-visible">Zobrazené</button>
                    <button type="button" class="nexus-btn-sub" id="nexus-select-none">Zrušiť</button>
                </div>

                <div class="nexus-btn-group">
                    <button type="button" class="nexus-btn-sub" id="nexus-scan-btn" style="flex:2;">🔍 Skenovať albumy</button>
                    <button type="button" class="nexus-btn-sub" id="nexus-load-next" style="flex:2;">➕ Ďalšia strana</button>
                    <button type="button" class="nexus-btn-sub" id="nexus-load-5" style="flex:1;">⏩ +5</button>
                </div>

                <div class="nexus-btn-group" style="margin-top:2px;">
                    <button type="button" class="nexus-btn-tester" id="nexus-btn-tester" disabled>🚀 Do Testera (0)</button>
                    <button type="button" class="nexus-btn-main" id="nexus-btn-direct" disabled>⚡ Import (0)</button>
                </div>
            </div>
        `;
        document.body.appendChild(el);

        // Minimized Floating Bubble
        let bubble = document.getElementById(BUBBLE_ID);
        if (!bubble) {
            bubble = document.createElement('div');
            bubble.id = BUBBLE_ID;
            bubble.innerHTML = '⚡';
            bubble.title = 'Otvoriť Nexus Vault Panel';
            document.body.appendChild(bubble);
            bubble.addEventListener('click', () => setMinimized(false));
        }

        if (libState.position) applyPosition(el, libState.position);
        makeDraggable(el, el.querySelector('#nexus-drag-handle'), (x, y) => savePosition(x, y));

        // Minimize / Restore
        el.querySelector('#nexus-btn-minimize').addEventListener('click', () => setMinimized(true));
        if (libState.minimized) setMinimized(true);

        // Listeners for Filters
        el.querySelector('#nexus-search').addEventListener('input', (e) => {
            libState.searchQuery = e.target.value;
            applyFilterAndSort();
        });

        el.querySelector('#nexus-sort').addEventListener('change', (e) => {
            libState.sortBy = e.target.value;
            applyFilterAndSort();
        });

        el.querySelector('#nexus-quality').addEventListener('change', (e) => {
            libState.filterQuality = e.target.value;
            applyFilterAndSort();
        });

        el.querySelector('#nexus-vids').addEventListener('change', (e) => {
            libState.filterMinVideos = parseInt(e.target.value, 10) || 0;
            applyFilterAndSort();
        });

        el.querySelector('#nexus-size').addEventListener('change', (e) => {
            libState.filterMinSizeMB = parseInt(e.target.value, 10) || 0;
            applyFilterAndSort();
        });

        const togglePhotosBtn = el.querySelector('#nexus-toggle-hide-photos');
        togglePhotosBtn.addEventListener('click', () => {
            libState.hidePhotoAlbums = !libState.hidePhotoAlbums;
            togglePhotosBtn.classList.toggle('is-active-orange', libState.hidePhotoAlbums);
            applyFilterAndSort();
        });

        const toggleSelBtn = el.querySelector('#nexus-toggle-selected');
        toggleSelBtn.addEventListener('click', () => {
            libState.filterOnlySelected = !libState.filterOnlySelected;
            toggleSelBtn.classList.toggle('is-active', libState.filterOnlySelected);
            applyFilterAndSort();
        });

        const toggleScannedBtn = el.querySelector('#nexus-toggle-scanned');
        toggleScannedBtn.addEventListener('click', () => {
            libState.filterOnlyScanned = !libState.filterOnlyScanned;
            toggleScannedBtn.classList.toggle('is-active', libState.filterOnlyScanned);
            applyFilterAndSort();
        });

        el.querySelector('#nexus-top-20').addEventListener('click', () => selectFirstNAlbums(20));
        el.querySelector('#nexus-select-visible').addEventListener('click', () => selectAllVisibleAlbums(true));
        el.querySelector('#nexus-select-none').addEventListener('click', () => selectAllVisibleAlbums(false));

        el.querySelector('#nexus-scan-btn').addEventListener('click', () => {
            if (libState.scanning) stopScan();
            else startScan();
        });

        // Paging Button Listeners
        el.querySelector('#nexus-load-next').addEventListener('click', () => loadNextPage(1));
        el.querySelector('#nexus-load-5').addEventListener('click', () => loadNextPage(5));

        el.querySelector('#nexus-btn-tester').addEventListener('click', sendSelectedAlbumsToTester);

        // Global hotkey '/'
        document.addEventListener('keydown', (e) => {
            if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
                if (tag !== 'input' && tag !== 'textarea') {
                    e.preventDefault();
                    el.querySelector('#nexus-search')?.focus();
                }
            }
        });
    }

    function countPhotoAlbums() {
        return Array.from(libState.albums.values()).filter(a => a.isPhotoOnly).length;
    }

    function setMinimized(min) {
        libState.minimized = min;
        try { localStorage.setItem(STORAGE_MIN_KEY, min ? 'true' : 'false'); } catch {}
        const toolbar = document.getElementById(TOOLBAR_ID);
        const bubble = document.getElementById(BUBBLE_ID);
        if (toolbar) toolbar.classList.toggle('nexus-balbums-minimized', min);
        if (bubble) bubble.classList.toggle('is-visible', min);
    }

    function updateToolbar() {
        const toolbar = document.getElementById(TOOLBAR_ID);
        if (!toolbar) return;

        const total = libState.albums.size;
        const scanned = Array.from(libState.albums.values()).filter(a => a.scanned).length;
        const selected = Array.from(libState.albums.values()).filter(a => a.selected);
        const visible = Array.from(libState.albums.values()).filter(a => a.visible !== false).length;
        const photoAlbums = countPhotoAlbums();

        const countEl = toolbar.querySelector('#nexus-stats-count');
        if (countEl) {
            countEl.innerHTML = `<b>${selected.length}</b> vybratých · <b>${visible}</b>/${total} zobrazených (str. ${libState.highestPage})`;
        }

        const photoToggleBtn = toolbar.querySelector('#nexus-toggle-hide-photos');
        if (photoToggleBtn) {
            photoToggleBtn.textContent = `📷 Skryť foto (${photoAlbums})`;
        }

        const progress = toolbar.querySelector('#nexus-progress');
        if (progress) {
            const pct = total > 0 ? Math.round((scanned / total) * 100) : 0;
            progress.style.width = `${pct}%`;
        }

        const scanBtn = toolbar.querySelector('#nexus-scan-btn');
        if (scanBtn) {
            const unscannedCount = total - scanned;
            scanBtn.innerHTML = libState.scanning
                ? `⏸️ Pauza (${libState.scanQueue.length})`
                : (unscannedCount > 0 ? `🔍 Skenovať (${unscannedCount})` : `🔍 Skenovať (${total})`);
        }

        const loadNextBtn = toolbar.querySelector('#nexus-load-next');
        if (loadNextBtn) {
            loadNextBtn.disabled = libState.loadingPage;
            loadNextBtn.innerHTML = libState.loadingPage ? '⏳ Načítavam...' : '➕ Ďalšia strana';
        }

        const load5Btn = toolbar.querySelector('#nexus-load-5');
        if (load5Btn) {
            load5Btn.disabled = libState.loadingPage;
        }

        const testerBtn = toolbar.querySelector('#nexus-btn-tester');
        if (testerBtn) {
            testerBtn.disabled = selected.length === 0;
            testerBtn.innerHTML = `🚀 Do Testera (${selected.length})`;
        }

        const directBtn = toolbar.querySelector('#nexus-btn-direct');
        if (directBtn) {
            directBtn.disabled = selected.length === 0;
            directBtn.innerHTML = `⚡ Import (${selected.length})`;
        }
    }

    function updateHeatmap() {
        const strip = document.getElementById('nexus-heatmap');
        if (!strip) return;
        const albums = Array.from(libState.albums.values()).slice(0, 100);
        strip.innerHTML = albums.map(a => {
            let cls = 'nexus-signal-tile';
            if (a.isPhotoOnly) cls += ' is-photos';
            else if (a.scanned && a.videoCount > 0) cls += ' has-videos';
            else if (a.scanned) cls += ' scanned';
            return `<div class="${cls}" title="${escapeHtml(a.title)}: ${a.videoCount} videí · ${a.photoCount} fotiek · ${formatBytes(a.totalBytes)}"></div>`;
        }).join('');
    }

    function selectFirstNAlbums(n) {
        let count = 0;
        libState.albums.forEach((album) => {
            const select = count < n && album.visible !== false;
            album.selected = select;
            if (album.chkEl) album.chkEl.checked = select;
            if (album.cardEl) album.cardEl.classList.toggle('is-selected', select);
            if (select) count++;
        });
        updateToolbar();
        toast(`Označených prvých ${count} zobrazených albumov.`);
    }

    function selectAllVisibleAlbums(check) {
        libState.albums.forEach((album) => {
            if (album.visible !== false) {
                album.selected = check;
                if (album.chkEl) album.chkEl.checked = check;
                if (album.cardEl) album.cardEl.classList.toggle('is-selected', check);
            }
        });
        updateToolbar();
    }

    // ── External Auto-Pager & Scroll Support ───────────────────────
    function setupScrollObserver() {
        let timer = null;
        const observer = new MutationObserver((mutations) => {
            let cardAdded = false;
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType === 1 && (node.matches?.(CARD_SELECTOR) || node.querySelector?.(CARD_SELECTOR))) {
                        cardAdded = true;
                        break;
                    }
                }
                if (cardAdded) break;
            }

            if (cardAdded) {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    scanBalbumsPage();
                    if (libState.sortBy !== 'default' || libState.filterOnlySelected || libState.searchQuery || libState.hidePhotoAlbums) {
                        applyFilterAndSort();
                    }
                }, 80);
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ── Global Capture Guards ─────────────────────────────────────────
    function setupGlobalCaptureGuards() {
        const handleGlobalCapture = (e) => {
            const target = e.target;
            if (!target || !target.closest) return;

            // 1. Quick Peek eye button or child
            const peekBtn = target.closest('.nexus-balbums-peek-btn, .nexus-turbo-badge-peek');
            if (peekBtn) {
                e.preventDefault();
                e.stopPropagation();
                if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                if (e.type === 'click') {
                    const card = peekBtn.closest('article, .album, .album-card, .rounded-xl, [data-album-url]') || peekBtn.parentElement;
                    const link = card ? (card.matches('a[href*="/a/"]') ? card : card.querySelector("a[href*='/a/'], a[href^='https://bunkr.']")) : null;
                    const fullUrl = link?.href || card?.getAttribute('data-album-url') || '';
                    const urlKey = fullUrl.replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
                    const album = urlKey ? libState.albums.get(urlKey) : null;
                    if (album) {
                        openQuickPeekModal(album);
                    }
                }
                return;
            }

            // 2. Checkboxes or controls
            const chk = target.closest('.nexus-balbums-chk-wrap, .nexus-balbums-chk, .nexus-turbo-album-chk-wrap');
            if (chk) {
                e.stopPropagation();
                if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                return;
            }

            // 3. Modal dialog, backdrops, player, or any nexus widget
            const modal = target.closest('.nexus-peek-backdrop, .nexus-peek-dialog, .nexus-player-dialog, [class*="nexus-peek-"], [class*="nexus-player-"], [data-nexus-prevent-nav]');
            if (modal) {
                e.stopPropagation();
                if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                return;
            }
        };

        ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(evt => {
            window.addEventListener(evt, handleGlobalCapture, true);
            document.addEventListener(evt, handleGlobalCapture, true);
        });
    }

    setupGlobalCaptureGuards();

    // ── Initialization ─────────────────────────────────────────────
    function init() {
        injectStyles();
        scanBalbumsPage();
        ensureToolbar();
        setupScrollObserver();

        if (libState.sortBy !== 'default' || libState.hidePhotoAlbums) {
            applyFilterAndSort();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
