// ==UserScript==
// @name         Nexus — Google Video & Playlist Collector
// @namespace    nexus.google.video.collector
// @version      1.0.0
// @description  Skenuje Google výsledky, detekuje VK video a playlist linky, pridáva inline badge na každý výsledok a floating panel na zber/kopírovanie/import.
// @author       Nexus
// @match        *://*.google.com/search*
// @match        *://*.google.sk/search*
// @match        *://*.google.cz/search*
// @match        *://*.google.co.uk/search*
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @connect      google.com
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

    // ── Nexus porty ───────────────────────────────────────────────
    const NEXUS_PORTS = [8000, 8001, 8002];
    const DISCOVERY_PATH = '/vk-discovery';
    const TESTER_PATH = '/tester';

    // ─────────────────────────────────────────────────────────────
    // URL patterny — VIDEO linky
    // ─────────────────────────────────────────────────────────────
    const VIDEO_PATTERNS = [
        { name: 'VK Video',    re: /vk\.com\/video-\d+_\d+/i,                              tag: 'vk-video'    },
        { name: 'VK Video',    re: /vk\.com\/video\d+_\d+/i,                               tag: 'vk-video'    },
        { name: 'VK Video',    re: /vkvideo\.ru\/video-?\d+_\d+/i,                         tag: 'vk-video'    },
        { name: 'VK Clip',     re: /(?:vk\.com|vkvideo\.ru)\/clip-?\d+_\d+/i,             tag: 'vk-clip'     },
        { name: 'VK Video',    re: /vk\.com\/.*[?&]z=video-?\d+_\d+/i,                    tag: 'vk-video'    },
        { name: 'YouTube',     re: /youtube\.com\/watch[^"'\s]*[?&]v=[\w-]+/i,            tag: 'youtube'     },
        { name: 'YouTube',     re: /youtu\.be\/[\w-]{6,}/i,                                tag: 'youtube'     },
        { name: 'YT Shorts',   re: /youtube\.com\/shorts\/[\w-]+/i,                        tag: 'yt-shorts'   },
        { name: 'Vimeo',       re: /vimeo\.com\/\d{5,}/i,                                  tag: 'vimeo'       },
        { name: 'Dailymotion', re: /dailymotion\.com\/video\/[\w]+/i,                      tag: 'dailymotion' },
        { name: 'OK Video',    re: /ok\.ru\/video\/\d+/i,                                  tag: 'ok'          },
        { name: 'Rutube',      re: /rutube\.ru\/video\/[\w-]+/i,                           tag: 'rutube'      },
        { name: 'Coub',        re: /coub\.com\/view\/[\w-]+/i,                             tag: 'coub'        },
        { name: 'TikTok',      re: /tiktok\.com\/@[^/]+\/video\/\d+/i,                    tag: 'tiktok'      },
    ];

    // ─────────────────────────────────────────────────────────────
    // URL patterny — PLAYLIST linky
    // ─────────────────────────────────────────────────────────────
    const PLAYLIST_PATTERNS = [
        { name: 'VK Playlist',    re: /(?:vk\.com|vkvideo\.ru)\/playlist\/-?\d+_\d+/i,    tag: 'vk-pl'    },
        { name: 'VK Videos',      re: /vk\.com\/videos-?\d+/i,                            tag: 'vk-vids'  },
        { name: 'VK Album',       re: /vk\.com\/.*[?&]section=album_\d+/i,                tag: 'vk-album' },
        { name: 'YT Playlist',    re: /youtube\.com\/(?:watch\?[^"'\s]*list=|playlist\?list=)[\w-]+/i, tag: 'yt-pl' },
        { name: 'YT Channel',     re: /youtube\.com\/@[\w.-]+(?:\/videos)?/i,             tag: 'yt-ch'    },
        { name: 'Vimeo Chan.',    re: /vimeo\.com\/(?:channels|showcase|groups)\/[\w-]+/i, tag: 'vimeo-pl' },
        { name: 'OK Playlist',    re: /ok\.ru\/video\/playlist\/\d+/i,                    tag: 'ok-pl'    },
        { name: 'Rutube Chan.',   re: /rutube\.ru\/channel\/[\w-]+/i,                     tag: 'rutube-pl'},
    ];

    const PLAYLIST_TEXT_RE = /(?:vkvideo\.ru|vk\.com)\s*[›>/]+\s*playlist\s*[›>/]+\s*(-?\d+_\d+)/gi;
    const PLAYLIST_ID_RE   = /\/playlist\/(-?\d+_\d+)/gi;

    const state = {
        videoLinks:    new Map(),    
        playlistLinks: new Map(),    
        badgedItems:   new Set(),    
        scanTimer:     null,
    };

    let currentFilter = 'all';

    GM_addStyle(`
        /* ── Floating Panel ── */
        #nxs-panel {
            position: fixed;
            top: 72px;
            right: 16px;
            z-index: 2147483647;
            width: 340px;
            background: rgba(10, 5, 22, 0.97);
            border: 1px solid rgba(234, 67, 53, 0.38); /* Google red highlight */
            border-radius: 18px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(234, 67, 53, 0.1);
            backdrop-filter: blur(20px) saturate(180%);
            font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
            font-size: 13px;
            color: #e2e8f0;
            overflow: hidden;
        }
        #nxs-panel-header {
            display: flex;
            align-items: center;
            gap: 9px;
            padding: 12px 14px 10px;
            background: linear-gradient(135deg, rgba(66, 133, 244, 0.22), rgba(234, 67, 53, 0.15));
            border-bottom: 1px solid rgba(66, 133, 244, 0.15);
            cursor: move;
            user-select: none;
        }
        #nxs-panel-icon {
            width: 28px; height: 28px;
            background: linear-gradient(135deg, #4285F4, #EA4335, #FBBC05, #34A853);
            border-radius: 7px;
            display: flex; align-items: center; justify-content: center;
            font-size: 14px; flex-shrink: 0;
        }
        #nxs-panel-title { font-size: 13px; font-weight: 700; color: #f1f5f9; flex: 1; }
        #nxs-panel-sub { font-size: 10px; color: #EA4335; }
        #nxs-panel-min-btn {
            background: none; border: none; color: #6b7280; font-size: 17px;
            cursor: pointer; padding: 2px 5px; border-radius: 4px; line-height: 1;
            transition: color .14s, background .14s;
        }
        #nxs-panel-min-btn:hover { color: #fca5a5; background: rgba(234, 67, 53, 0.15); }

        /* Stats */
        #nxs-stats {
            display: flex; gap: 5px; padding: 9px 12px 7px;
            border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        .nxs-stat {
            flex: 1; background: rgba(255,255,255,0.04);
            border: 1px solid rgba(255,255,255,0.07);
            border-radius: 9px; padding: 6px 8px; text-align: center;
        }
        .nxs-stat-val { font-size: 20px; font-weight: 700; line-height: 1; }
        .nxs-stat-label { font-size: 9px; color: #6b7280; text-transform: uppercase; letter-spacing: .6px; margin-top: 2px; }
        .nxs-stat-val.v { color: #fca5a5; }
        .nxs-stat-val.p { color: #fcd34d; }
        .nxs-stat-val.t { color: #60a5fa; }

        /* Filter tabs */
        #nxs-tabs { display: flex; gap: 4px; padding: 7px 12px 0; }
        .nxs-tab {
            flex: 1; padding: 5px 0; font-size: 11px; font-weight: 700;
            border-radius: 7px; border: 1px solid transparent;
            background: rgba(255,255,255,0.05); color: #94a3b8;
            cursor: pointer; text-align: center; transition: all .13s;
        }
        .nxs-tab.active { background: rgba(234, 67, 53, 0.22); border-color: rgba(234, 67, 53, 0.45); color: #fca5a5; }
        .nxs-tab:hover:not(.active) { background: rgba(255,255,255,0.08); color: #e2e8f0; }

        /* URL list */
        #nxs-list {
            max-height: 150px; overflow-y: auto; padding: 5px 12px 3px;
            scrollbar-width: thin; scrollbar-color: rgba(234, 67, 53, 0.35) transparent;
        }
        #nxs-list::-webkit-scrollbar { width: 3px; }
        #nxs-list::-webkit-scrollbar-thumb { background: rgba(234, 67, 53, 0.4); border-radius: 2px; }
        .nxs-url-row {
            font-size: 10px; color: #94a3b8; padding: 3px 0;
            border-bottom: 1px solid rgba(255,255,255,0.04);
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            display: flex; align-items: center; gap: 5px;
        }
        .nxs-url-row:last-child { border-bottom: none; }
        .nxs-url-text { overflow: hidden; text-overflow: ellipsis; }
        #nxs-list-empty { font-size: 11px; color: #4b5563; padding: 12px 0; text-align: center; }

        /* Tags */
        .nxs-tag {
            font-size: 9px; font-weight: 700; padding: 1px 5px;
            border-radius: 999px; flex-shrink: 0; color: #fff; white-space: nowrap;
        }
        .nxs-tag.vk-video, .nxs-tag.vk-clip  { background: #0077ff; }
        .nxs-tag.vk-pl, .nxs-tag.vk-vids, .nxs-tag.vk-album { background: #0059c2; }
        .nxs-tag.youtube, .nxs-tag.yt-shorts  { background: #c00; }
        .nxs-tag.yt-pl, .nxs-tag.yt-ch        { background: #8b0000; }
        .nxs-tag.vimeo, .nxs-tag.vimeo-pl     { background: #1ab7ea; }
        .nxs-tag.ok, .nxs-tag.ok-pl           { background: #f7650e; }
        .nxs-tag.rutube, .nxs-tag.rutube-pl   { background: #e2002a; }
        .nxs-tag.tiktok                        { background: #333; }
        .nxs-tag.dailymotion                   { background: #0066dc; }
        .nxs-tag.coub                          { background: #e5534b; }

        /* Buttons */
        #nxs-btns { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; padding: 7px 12px 10px; }
        .nxs-btn {
            padding: 7px 9px; border-radius: 9px; border: 1px solid transparent;
            font-size: 11px; font-weight: 700; font-family: inherit;
            cursor: pointer; color: #fff; text-align: center;
            transition: filter .13s, transform .1s; white-space: nowrap;
        }
        .nxs-btn:hover:not(:disabled) { filter: brightness(1.2); transform: translateY(-1px); }
        .nxs-btn:disabled { opacity: .38; cursor: default; }
        .nxs-btn.primary { background: linear-gradient(135deg, #EA4335, #FBBC05); grid-column: span 2; font-size: 12px; }
        .nxs-btn.green   { background: rgba(52,211,153,.15); border-color: rgba(52,211,153,.3); color: #6ee7b7; }
        .nxs-btn.blue    { background: rgba(59,130,246,.15); border-color: rgba(59,130,246,.3); color: #93c5fd; }
        .nxs-btn.gray    { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.1); color: #94a3b8; }
        .nxs-btn.amber   { background: rgba(251,146,60,.12); border-color: rgba(251,146,60,.28); color: #fcd34d; }
        .nxs-btn.span2   { grid-column: span 2; }

        /* Status */
        #nxs-status {
            padding: 4px 12px 9px; font-size: 11px; color: #6b7280; min-height: 20px;
            border-top: 1px solid rgba(255,255,255,0.04);
        }
        #nxs-status.ok  { color: #34d399; }
        #nxs-status.err { color: #f87171; }
        #nxs-status.inf { color: #a78bfa; }

        /* Minimized bubble */
        #nxs-mini {
            position: fixed; top: 72px; right: 16px; z-index: 2147483647;
            width: 50px; height: 50px; border-radius: 999px; border: none;
            background: linear-gradient(135deg, #4285F4, #EA4335, #FBBC05, #34A853);
            box-shadow: 0 8px 26px rgba(234, 67, 53, 0.55);
            color: #fff; font-size: 20px; cursor: pointer;
            display: none; align-items: center; justify-content: center;
            transition: transform .18s, box-shadow .18s;
        }
        #nxs-mini:hover { transform: scale(1.1); box-shadow: 0 12px 34px rgba(234, 67, 53, 0.7); }

        /* ── Inline badge na každom Google výsledku ── */
        .nxs-serp-badge {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            margin: 4px 0 0 0;
            padding: 3px 9px 3px 6px;
            background: rgba(234, 67, 53, 0.10);
            border: 1px solid rgba(234, 67, 53, 0.28);
            border-radius: 999px;
            font-size: 11px;
            color: #EA4335;
            font-family: "Segoe UI", system-ui, sans-serif;
            cursor: pointer;
            transition: background .13s, border-color .13s;
            user-select: none;
            text-decoration: none !important;
            line-height: 1.4;
        }
        .nxs-serp-badge:hover {
            background: rgba(234, 67, 53, 0.20);
            border-color: rgba(234, 67, 53, 0.5);
        }
        .nxs-serp-badge .nxs-b-icon { font-size: 12px; }
        .nxs-serp-badge .nxs-b-count { font-weight: 700; }
        .nxs-serp-badge .nxs-b-sep { width: 1px; height: 10px; background: rgba(234, 67, 53, 0.3); }
        .nxs-serp-badge .nxs-b-types { color: #94a3b8; font-size: 10px; }
        .nxs-serp-badge.copied { background: rgba(52,211,153,0.15) !important; border-color: rgba(52,211,153,0.4) !important; color: #6ee7b7 !important; }
    `);

    function normalizeVkUrl(href) {
        if (href.startsWith('//')) href = 'https:' + href;
        if (href.startsWith('/') && !href.startsWith('//')) href = 'https://vk.com' + href;
        try {
            const u = new URL(href);
            ['utm_source','utm_medium','utm_campaign','from','ref','_ga'].forEach(p => u.searchParams.delete(p));
            return u.toString();
        } catch { return href; }
    }

    function extractPlaylistIdsFromText(text) {
        const found = new Set();
        let m;
        PLAYLIST_TEXT_RE.lastIndex = 0;
        while ((m = PLAYLIST_TEXT_RE.exec(text))) found.add(m[1]);
        PLAYLIST_ID_RE.lastIndex = 0;
        while ((m = PLAYLIST_ID_RE.exec(text))) found.add(m[1]);
        return [...found].map(id => `https://vk.com/playlist/${id}`);
    }

    function detectLink(href) {
        if (!href || href.length < 8) return null;
        for (const p of PLAYLIST_PATTERNS) {
            if (p.re.test(href)) return { kind: 'playlist', name: p.name, tag: p.tag };
        }
        for (const p of VIDEO_PATTERNS) {
            if (p.re.test(href)) return { kind: 'video', name: p.name, tag: p.tag };
        }
        return null;
    }

    function extractFromContainer(container) {
        const videos    = [];
        const playlists = [];

        for (const a of container.querySelectorAll('a[href]')) {
            const rawHref = a.getAttribute('href') || '';
            let href = rawHref;
            // Google redirects (e.g. /url?q=...)
            if (href.startsWith('/url?')) {
                try {
                    const params = new URLSearchParams(href.split('?')[1]);
                    if (params.has('q')) href = params.get('q');
                    else if (params.has('url')) href = params.get('url');
                } catch {}
            }
            
            href = normalizeVkUrl(href);
            const type = detectLink(href);
            if (!type) continue;
            if (type.kind === 'playlist') playlists.push({ url: href, name: type.name, tag: type.tag });
            else                          videos.push({ url: href, name: type.name, tag: type.tag });
        }

        const visText = container.innerText || container.textContent || '';
        for (const plUrl of extractPlaylistIdsFromText(visText)) {
            playlists.push({ url: plUrl, name: 'VK Playlist', tag: 'vk-pl' });
        }

        const dedup = (arr) => {
            const seen = new Set();
            return arr.filter(x => seen.has(x.url) ? false : seen.add(x.url));
        };

        return { videos: dedup(videos), playlists: dedup(playlists) };
    }

    function injectBadge(container, videos, playlists) {
        const titleEl = container.querySelector('h3');
        let insertAnchor = titleEl ? titleEl.closest('a') || titleEl : container.querySelector('a');

        const badge = document.createElement('div');
        badge.className = 'nxs-serp-badge';

        const total = videos.length + playlists.length;
        const typeParts = [];
        if (videos.length)    typeParts.push(`▶ ${videos.length}`);
        if (playlists.length) typeParts.push(`📋 ${playlists.length}`);

        badge.innerHTML = `
            <span class="nxs-b-icon">🎬</span>
            <span class="nxs-b-count">${total} link${total > 1 ? 'ov' : ''}</span>
            <span class="nxs-b-sep"></span>
            <span class="nxs-b-types">${typeParts.join(' · ')}</span>
        `;

        badge.title = [...videos, ...playlists].map(x => x.url).join('\n');

        badge.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const urls = [...videos, ...playlists].map(x => x.url);
            const ok = await copyText(urls.join('\n'));
            if (ok) {
                badge.classList.add('copied');
                badge.querySelector('.nxs-b-count').textContent = '✔ Skopírované!';
                setTimeout(() => {
                    badge.classList.remove('copied');
                    badge.querySelector('.nxs-b-count').textContent = `${total} link${total > 1 ? 'ov' : ''}`;
                }, 2000);
                setStatus(`✔ ${urls.length} linkov skopírovaných`, 'ok');
            }
        });

        if (insertAnchor && insertAnchor.parentElement) {
            insertAnchor.parentElement.insertBefore(badge, insertAnchor.nextSibling);
        } else if (container.firstChild) {
            container.insertBefore(badge, container.firstChild.nextSibling);
        } else {
            container.appendChild(badge);
        }
    }

    function scan() {
        if (!document.getElementById('nxs-panel')) {
            buildPanel();
            refreshPanel();
        }

        // Google search results selectors
        const CONTAINER_SELECTORS = [
            'div.g', 
            'div[data-sokoban-container]',
            'div.tF2Cxc',
            'div.MjjYud'
        ];

        const seen = new Set();
        const containers = [];
        for (const sel of CONTAINER_SELECTORS) {
            for (const el of document.querySelectorAll(sel)) {
                if (!el.dataset.nxsId) {
                    el.dataset.nxsId = Math.random().toString(36).substr(2, 9);
                }
                const cid = el.dataset.nxsId;
                if (!seen.has(cid)) { seen.add(cid); containers.push(el); }
            }
        }

        if (containers.length === 0) {
            const { videos, playlists } = extractFromContainer(document.body);
            for (const v of videos)    state.videoLinks.set(v.url, v);
            for (const p of playlists) state.playlistLinks.set(p.url, p);
            refreshPanel();
            return;
        }

        let newFound = 0;
        for (const container of containers) {
            const cid = container.dataset.nxsId;
            const { videos, playlists } = extractFromContainer(container);
            const hasNew = videos.length > 0 || playlists.length > 0;

            for (const v of videos)    state.videoLinks.set(v.url, v);
            for (const p of playlists) state.playlistLinks.set(p.url, p);

            if (hasNew && cid !== null && !state.badgedItems.has(cid)) {
                state.badgedItems.add(cid);
                injectBadge(container, videos, playlists);
                newFound++;
            } else if (hasNew && cid === null && !container.querySelector('.nxs-serp-badge')) {
                injectBadge(container, videos, playlists);
                newFound++;
            }
        }

        refreshPanel();
        return newFound;
    }

    function refreshPanel() {
        const vEl = document.getElementById('nxs-stat-v');
        const pEl = document.getElementById('nxs-stat-p');
        const tEl = document.getElementById('nxs-stat-t');
        if (vEl) vEl.textContent = state.videoLinks.size;
        if (pEl) pEl.textContent = state.playlistLinks.size;
        if (tEl) tEl.textContent = state.videoLinks.size + state.playlistLinks.size;
        renderList();
    }

    function renderList() {
        const wrap = document.getElementById('nxs-list');
        if (!wrap) return;
        const entries = [];
        if (currentFilter !== 'playlist') for (const [url, m] of state.videoLinks)    entries.push({ url, ...m, kind: 'video' });
        if (currentFilter !== 'video')    for (const [url, m] of state.playlistLinks) entries.push({ url, ...m, kind: 'playlist' });

        if (entries.length === 0) {
            wrap.innerHTML = '<div id="nxs-list-empty">' + _t('Žiadne linky. Skúste scroll alebo fetch stránok.', 'No links found. Try scrolling or fetching pages.') + '</div>';
            return;
        }
        wrap.innerHTML = entries.map(e =>
            `<div class="nxs-url-row" title="${e.url}">
                <span class="nxs-tag ${e.tag}">${e.name}</span>
                <span class="nxs-url-text">${e.url}</span>
             </div>`
        ).join('');
    }

    async function copyText(text) {
        if (!String(text).trim()) return false;
        try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch {}
        try { GM_setClipboard(text, 'text'); return true; } catch {}
        return false;
    }

    function getUrls(filter = currentFilter) {
        const urls = [];
        if (filter !== 'playlist') for (const [url] of state.videoLinks)    urls.push(url);
        if (filter !== 'video')    for (const [url] of state.playlistLinks) urls.push(url);
        return [...new Set(urls)];
    }

    function gmRequest(opts) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                ...opts,
                onload: resolve,
                onerror: reject,
                ontimeout: () => reject(new Error('timeout')),
            });
        });
    }

    async function findLivePort() {
        for (const port of NEXUS_PORTS) {
            try {
                const r = await gmRequest({
                    method: 'GET',
                    url: `http://localhost:${port}/health`,
                    timeout: 1200,
                });
                if (r.status >= 200 && r.status < 300) return port;
            } catch {}
        }
        return null;
    }

    async function pushToNexus(port, urls) {
        const r = await gmRequest({
            method: 'POST',
            url: `http://localhost:${port}/api/v1/hunter/push`,
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000,
            data: JSON.stringify({
                thread_title: document.title || 'Google VK zber',
                thread_url: location.href,
                links: urls.map(u => ({ url: u, host: 'vk' })),
            }),
        });
        if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
        return JSON.parse(r.responseText || '{}');
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    function randomSleep(min, max) { return sleep(Math.floor(Math.random() * (max - min + 1)) + min); }

    async function autoScroll(rounds = 15, cb = () => {}) {
        let prevH = 0;
        for (let i = 0; i < rounds; i++) {
            cb(`⬇ Scroluje ${i + 1}/${rounds}…`);
            
            const scrollY = document.body.scrollHeight - Math.floor(Math.random() * 200);
            window.scrollTo({ top: scrollY, behavior: 'smooth' });
            
            await randomSleep(1200, 2600);
            
            const moreBtn = [...document.querySelectorAll('button, a, [role="button"], div')]
                .find(el => /more results|viac výsledkov|ďalšie výsledky|load more|pokračovať/i.test(el.innerText || ''));
                
            if (moreBtn && moreBtn.offsetParent !== null) { 
                moreBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await randomSleep(500, 1200);
                moreBtn.click(); 
                await randomSleep(1000, 2200); 
            }
            
            scan();
            const curH = document.body.scrollHeight;
            if (curH === prevH) { 
                await randomSleep(800, 1500); 
                if (document.body.scrollHeight === curH) { 
                    cb(`Zastavené po ${i + 1} scrolloch`); 
                    return; 
                } 
            }
            prevH = document.body.scrollHeight;
        }
        cb(`Dokončené — ${rounds} scrollov`);
    }

    function buildPagedUrl(startIdx) {
        const u = new URL(location.href);
        startIdx <= 0 ? u.searchParams.delete('start') : u.searchParams.set('start', String(startIdx));
        return u.toString();
    }

    function fetchHtml(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url,
                headers: { 'Accept': 'text/html,application/xhtml+xml', 'User-Agent': navigator.userAgent },
                onload: r => resolve(String(r.responseText || '')),
                onerror: reject,
            });
        });
    }

    async function fetchPages(count = 10, cb = () => {}) {
        const startIdx = Math.max(0, Number(new URL(location.href).searchParams.get('start') || '0'));
        for (let i = 0; i < count; i++) {
            const idx = startIdx + (i * 10);
            cb(`🌐 Stránka ${(idx/10) + 1}…`);
            try {
                const html = await fetchHtml(buildPagedUrl(idx));
                if (!html.trim()) continue;
                const doc = new DOMParser().parseFromString(html, 'text/html');
                for (const a of doc.querySelectorAll('a[href]')) {
                    let href = a.getAttribute('href') || '';
                    if (href.startsWith('/url?')) {
                        try {
                            const params = new URLSearchParams(href.split('?')[1]);
                            if (params.has('q')) href = params.get('q');
                            else if (params.has('url')) href = params.get('url');
                        } catch {}
                    }
                    href = normalizeVkUrl(href);
                    const type = detectLink(href);
                    if (!type) continue;
                    if (type.kind === 'playlist') state.playlistLinks.set(href, { name: type.name, tag: type.tag });
                    else                           state.videoLinks.set(href, { name: type.name, tag: type.tag });
                }
                const bodyText = doc.body?.innerText || doc.body?.textContent || '';
                for (const plUrl of extractPlaylistIdsFromText(bodyText)) {
                    state.playlistLinks.set(plUrl, { name: 'VK Playlist', tag: 'vk-pl' });
                }
                refreshPanel();
                cb(`✔ Stránka ${(idx/10) + 1} — celkom ${state.videoLinks.size + state.playlistLinks.size} linkov`);
            } catch {
                cb(`✘ Stránka ${(idx/10) + 1} — chyba`);
            }
            await sleep(400); 
        }
    }

    function setStatus(msg, cls = '') {
        const el = document.getElementById('nxs-status');
        if (!el) return;
        el.textContent = msg;
        el.className = cls;
    }

    function makeDraggable(panel, handle) {
        let ox, oy, px, py;
        handle.addEventListener('mousedown', e => {
            e.preventDefault();
            ox = e.clientX; oy = e.clientY;
            const r = panel.getBoundingClientRect();
            px = r.left; py = r.top;
            document.addEventListener('mousemove', mv);
            document.addEventListener('mouseup', up);
        });
        const mv = e => { panel.style.left = (px + e.clientX - ox) + 'px'; panel.style.top = (py + e.clientY - oy) + 'px'; panel.style.right = 'auto'; };
        const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
    }

    function buildPanel() {
        const panel = document.createElement('div');
        panel.id = 'nxs-panel';
        panel.innerHTML = `
            <div id="nxs-panel-header">
                <div id="nxs-panel-icon">▶</div>
                <div>
                    <div id="nxs-panel-title">Nexus Video Collector</div>
                    <div id="nxs-panel-sub">Google · VK video &amp; playlist zberač</div>
                </div>
                <button id="nxs-panel-min-btn" title="Minimalizovať">–</button>
            </div>
            <div id="nxs-stats">
                <div class="nxs-stat"><div class="nxs-stat-val v" id="nxs-stat-v">0</div><div class="nxs-stat-label">Videí</div></div>
                <div class="nxs-stat"><div class="nxs-stat-val p" id="nxs-stat-p">0</div><div class="nxs-stat-label">Playlistov</div></div>
                <div class="nxs-stat"><div class="nxs-stat-val t" id="nxs-stat-t">0</div><div class="nxs-stat-label">Celkom</div></div>
            </div>
            <div id="nxs-tabs">
                <div class="nxs-tab active" data-f="all">Všetko</div>
                <div class="nxs-tab" data-f="video">▶ Videá</div>
                <div class="nxs-tab" data-f="playlist">📋 Playlisty</div>
            </div>
            <div id="nxs-list"><div id="nxs-list-empty">Skenujem…</div></div>
            <div id="nxs-btns">
                <button class="nxs-btn primary" data-a="copy">📋 Kopírovať všetky URL</button>
                <button class="nxs-btn green"   data-a="scroll">⬇ Scroll&nbsp;+&nbsp;scan</button>
                <button class="nxs-btn blue"    data-a="fetch">🌐 Fetch&nbsp;10 stránok</button>
                <button class="nxs-btn amber"   data-a="open">📋 + Otvoriť Nexus</button>
                <button class="nxs-btn gray"    data-a="rescan">🔄 Rescan</button>
                <button class="nxs-btn gray"    data-a="clear">🗑 Vyčistiť</button>
            </div>
            <div id="nxs-status">Skenujem stránku…</div>
        `;

        const mini = document.createElement('button');
        mini.id = 'nxs-mini';
        mini.textContent = '▶';
        mini.title = 'Nexus Video Collector (Google)';

        document.body.appendChild(panel);
        document.body.appendChild(mini);

        makeDraggable(panel, document.getElementById('nxs-panel-header'));

        document.getElementById('nxs-panel-min-btn').addEventListener('click', () => {
            panel.style.display = 'none'; mini.style.display = 'flex';
        });
        mini.addEventListener('click', () => {
            panel.style.display = ''; mini.style.display = 'none';
        });

        document.getElementById('nxs-tabs').addEventListener('click', e => {
            const tab = e.target.closest('[data-f]');
            if (!tab) return;
            document.querySelectorAll('.nxs-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentFilter = tab.dataset.f;
            renderList();
        });

        panel.addEventListener('click', async e => {
            const btn = e.target.closest('[data-a]');
            if (!btn || btn.disabled) return;
            const a = btn.dataset.a;

            if (a === 'copy') {
                const urls = getUrls();
                if (!urls.length) { setStatus(_t('Žiadne linky.', 'No links found.'), 'err'); return; }
                const ok = await copyText(urls.join('\n'));
                setStatus(ok ? _t(`✔ Skopírovaných ${urls.length} URL`, `✔ Copied ${urls.length} URLs`) : _t('✘ Kopírovanie zlyhalo', '✘ Copying failed'), ok ? 'ok' : 'err');
            }
            else if (a === 'open') {
                const urls = getUrls();
                if (!urls.length) { setStatus(_t('Žiadne linky.', 'No links found.'), 'err'); return; }
                await copyText(urls.join('\n'));
                setStatus('🔍 Hľadám Nexus port…', 'inf');
                const port = await findLivePort();
                if (!port) { setStatus('✘ Nexus nenájdený (8000–8002)', 'err'); return; }

                setStatus(`📤 Posielam ${urls.length} URL…`, 'inf');
                let sessionId;
                try {
                    const result = await pushToNexus(port, urls);
                    sessionId = result.session_id;
                    if (!sessionId) throw new Error('Nexus nevrátil ID dávky; aktualizuj backend.');
                } catch (e) {
                    setStatus(_t(`✘ Odoslanie zlyhalo: ${e.message}`, `✘ Sending failed: ${e.message}`), 'err');
                    return;
                }
                GM_openInTab(`http://localhost:${port}${TESTER_PATH}?hunter=1&session=${encodeURIComponent(sessionId)}&autostart=1`,
                             { active: true, insert: true });
                setStatus(`✔ ${urls.length} URL → tester :${port}`, 'ok');
            }
            else if (a === 'scroll') {
                btn.disabled = true;
                await autoScroll(15, msg => setStatus(msg, 'inf'));
                const urls = getUrls();
                await copyText(urls.join('\n'));
                setStatus(`✔ ${urls.length} URL skopírovaných`, 'ok');
                btn.disabled = false;
            }
            else if (a === 'fetch') {
                btn.disabled = true;
                await fetchPages(10, msg => setStatus(msg, 'inf'));
                const urls = getUrls();
                await copyText(urls.join('\n'));
                setStatus(`✔ Fetch hotový — ${urls.length} URL`, 'ok');
                btn.disabled = false;
            }
            else if (a === 'rescan') {
                scan();
                setStatus(`Rescan — ${state.videoLinks.size + state.playlistLinks.size} linkov`, 'inf');
            }
            else if (a === 'clear') {
                state.videoLinks.clear(); state.playlistLinks.clear(); state.badgedItems.clear();
                document.querySelectorAll('.nxs-serp-badge').forEach(b => b.remove());
                refreshPanel(); setStatus('Vyčistené.', 'inf');
            }
        });
    }

    function installObserver() {
        const mo = new MutationObserver(() => {
            clearTimeout(state.scanTimer);
            state.scanTimer = setTimeout(() => {
                if (/search/i.test(location.href)) {
                    if (!document.getElementById('nxs-panel')) buildPanel();
                    scan();
                } else {
                    const p = document.getElementById('nxs-panel');
                    const m = document.getElementById('nxs-mini');
                    if (p) p.style.display = 'none';
                    if (m) m.style.display = 'none';
                }
            }, 350);
        });
        mo.observe(document.body, { childList: true, subtree: true });
    }

    function init() {
        if (window.top !== window.self) return;
        if (!/google\./i.test(location.hostname)) return;

        installObserver();

        if (/search/i.test(location.href)) {
            if (!document.getElementById('nxs-panel')) buildPanel();
            setTimeout(() => {
                const found = scan();
                const total = state.videoLinks.size + state.playlistLinks.size;
                setStatus(
                    total > 0
                        ? `✔ Nájdených ${total} linkov (${state.videoLinks.size} videí, ${state.playlistLinks.size} playlistov)`
                        : _t('Žiadne VK linky nenájdené — skúste Scroll alebo Fetch', 'No VK links found — try Scroll or Fetch'),
                    total > 0 ? 'ok' : ''
                );
            }, 800);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }

})();
