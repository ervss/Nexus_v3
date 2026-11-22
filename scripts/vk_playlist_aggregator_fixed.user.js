// ==UserScript==
// @name         Nexus VK Video Playlist Aggregator & Bulk Importer
// @namespace    http://tampermonkey.net/
// @version      6.2
// @description  Aggregates, analyzes and bulk-imports VK Video playlists into Nexus with light/detail views.
// @author       Antigravity Codecraft
// @match        https://*.vk.com/video*
// @match        https://*.vkvideo.ru/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @connect      vk.com
// @connect      vkvideo.ru
// ==/UserScript==

(function () {
    'use strict';

    // The analysis frame must not start another aggregator recursively.
    if (window.self !== window.top) return;

    const API_BASE = 'http://127.0.0.1:8000/api/v1';
    const STORAGE_KEY = 'nexus_vk_aggregator_state_v6';
    const MAX_META_BATCH = 4;
    const metaCache = new Map();

    const state = {
        collapsed: true,
        viewMode: 'light',
        playlists: [],
        currentSort: { key: 'videoCount', asc: false },
        activePlaylist: null,
        activePlaylistStatus: 'pending',
        scanBusy: false,
        bulkBusy: false,
        selectAllLabel: 'Select All',
        hydrationActive: false,
    };

    function loadState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (typeof parsed.collapsed === 'boolean') state.collapsed = parsed.collapsed;
            if (parsed.viewMode === 'detail' || parsed.viewMode === 'light') state.viewMode = parsed.viewMode;
            if (parsed.currentSort?.key) state.currentSort = parsed.currentSort;
        } catch (_) {
            // ignore
        }
    }

    function saveState() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                collapsed: state.collapsed,
                viewMode: state.viewMode,
                currentSort: state.currentSort,
            }));
        } catch (_) {
            // ignore
        }
    }

    function gmRequest(opts) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: opts.method || 'GET',
                url: opts.url,
                headers: opts.headers || {},
                data: opts.data,
                overrideMimeType: 'text/html; charset=utf-8',
                timeout: opts.timeout || 45000,
                onload: (response) => resolve(response),
                onerror: (error) => reject(error),
                ontimeout: () => reject(new Error(`Timeout for ${opts.url}`)),
            });
        });
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function canonicalizeVkPlaylistUrl(url) {
        try {
            const zValue = url.searchParams.get('z') || '';
            const zMatch = zValue.match(/video_playlist(-?\d+_-?\d+)/i);
            if (zMatch) {
                return `${url.origin}/playlist/${zMatch[1]}`;
            }

            const pathMatch = `${url.pathname}${url.search}`.match(/\/playlist\/(-?\d+_-?\d+)/i);
            if (pathMatch) {
                return `${url.origin}/playlist/${pathMatch[1]}`;
            }
        } catch (_) {
            // ignore
        }
        return '';
    }

    function normalizePlaylistUrl(raw) {
        const value = String(raw || '').trim();
        if (!value) return '';
        try {
            const url = new URL(value, location.origin);
            url.hash = '';
            const canonical = canonicalizeVkPlaylistUrl(url);
            if (canonical) return canonical;
            url.pathname = url.pathname.replace(/\/+$/, '');
            if (/\/playlist\//i.test(url.pathname)) {
                return url.href;
            }
            if (/\/playlists$/i.test(url.pathname)) {
                return '';
            }
            return url.href;
        } catch (_) {
            return '';
        }
    }

    function normalizeVideoUrl(raw, baseUrl) {
        const value = String(raw || '').trim();
        if (!value) return '';
        try {
            const url = new URL(value, baseUrl || location.href);
            const match = `${url.pathname}${url.search}`.match(/video(-?\d+_\d+)/i);
            if (match) {
                return `${url.origin}/video${match[1]}`;
            }
            url.hash = '';
            return url.href;
        } catch (_) {
            return '';
        }
    }

    function uniqueBy(items, keyFn) {
        const out = [];
        const seen = new Set();
        for (const item of items || []) {
            const key = keyFn(item);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(item);
        }
        return out;
    }

    function formatBytes(bytes) {
        const value = Number(bytes || 0);
        if (!value || value < 0) return '--';
        if (value >= 1024 ** 3) return `${(value / (1024 ** 3)).toFixed(2)} GB`;
        if (value >= 1024 ** 2) return `${(value / (1024 ** 2)).toFixed(1)} MB`;
        if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
        return `${value} B`;
    }

    function formatDuration(seconds) {
        const total = Math.max(0, Math.round(Number(seconds || 0)));
        if (!total) return '--';
        const hrs = Math.floor(total / 3600);
        const mins = Math.floor((total % 3600) / 60);
        const secs = total % 60;
        if (hrs) return `${hrs}h ${mins}m`;
        if (mins) return `${mins}m ${secs}s`;
        return `${secs}s`;
    }

    function playlistSizeText(playlist) {
        if (playlist.analyzed && playlist.videoCount === 0) return '0 B';
        if (!playlist.sizeBytes) return playlist.analysisPending ? 'Loading…' : 'Unavailable';
        return `${playlist.sizePartial ? '≥ ' : ''}${playlist.sizeEstimated ? '≈ ' : ''}${formatBytes(playlist.sizeBytes)}`;
    }

    function playlistDurationText(playlist) {
        if (playlist.analyzed && playlist.videoCount === 0) return '0s';
        if (!playlist.totalDurationSec) return playlist.analysisPending ? 'Loading…' : 'Unavailable';
        return `${playlist.durationPartial ? '≥ ' : ''}${formatDuration(playlist.totalDurationSec)}`;
    }

    function parseLooseCount(text) {
        const raw = String(text || '').replace(/\u00a0/g, ' ').trim();
        if (!raw) return 0;
        const patterns = [
            /(\d{1,6})\s*(?:videos?|видео|ролик(?:ов)?)/i,
            /(?:videos?|видео|ролик(?:ов)?)\s*[:|-]?\s*(\d{1,6})/i,
        ];
        for (const pattern of patterns) {
            const match = raw.match(pattern);
            if (match) return parseInt(match[1], 10) || 0;
        }
        return 0;
    }

    function getTextLines(node) {
        const raw = String(
            node?.innerText ||
            node?.textContent ||
            ''
        ).replace(/\u00a0/g, ' ');
        return raw
            .split(/\r?\n+/)
            .map((line) => line.replace(/\s+/g, ' ').trim())
            .filter(Boolean);
    }

    function cleanTitle(title) {
        if (!title) return '';
        let clean = String(title)
            .replace(/\s+/g, ' ')
            .replace(/\s*-\s*VK Video.*$/i, '')
            .replace(/\s*[>|•-]\s*Playlists\s*[>|•-]?\s*$/i, '')
            .replace(/\s*[>|•-]\s*Playlists\s*$/i, '')
            .replace(/\bPlaylists\s*>\s*/i, '')
            .trim();
        // Remove trailing breadcrumb/separators
        clean = clean.replace(/^[>|•\s-]+|[>|•\s-]+$/g, '').trim();
        return clean;
    }

    function isCurrentPage(url) {
        if (!url) return false;
        try {
            const u1 = new URL(url, location.href);
            const u2 = new URL(location.href);
            if (u1.origin !== u2.origin) return false;
            const p1 = u1.pathname.replace(/\/+$/, '');
            const p2 = u2.pathname.replace(/\/+$/, '');
            if (p1 === p2) return true;
        } catch (_) {
            // ignore
        }
        try {
            const n1 = normalizePlaylistUrl(url);
            const n2 = normalizePlaylistUrl(location.href);
            return n1 && n2 && n1 === n2;
        } catch (_) {
            return false;
        }
    }

    function pickPlaylistTitleFromLines(lines, fallback = '') {
        const skipExact = new Set([
            'home', 'videos', 'playlists', 'more', 'follow', 'watch all',
            'import', 'analyze', 'select all', 'clear',
        ]);
        for (const line of lines || []) {
            const clean = cleanTitle(line);
            if (!clean) continue;
            const low = clean.toLowerCase();
            if (skipExact.has(low)) continue;
            if (/^\d+\s*(videos?|видео|ролик(?:ов)?)$/i.test(clean)) continue;
            if (/^(updated|обновлено)\b/i.test(low)) continue;
            if (/^(playlist|vk playlist)$/i.test(low)) continue;
            if (!/[a-zа-яё0-9]/i.test(clean)) continue;
            if (clean.length < 2) continue;
            return clean;
        }
        return cleanTitle(fallback);
    }

    function scorePlaylistContainer(node) {
        if (!node) return -1;
        const text = getTextLines(node).join(' ');
        const textLen = text.length;
        let score = 0;
        if (parseLooseCount(text) > 0) score += 40;
        if (node.querySelector?.('img')) score += 14;
        if (node.querySelector?.('[class*="title"], [class*="Title"], h3, h4, strong')) score += 22;
        if (node.querySelectorAll?.('a[href*="/playlist/"], a[href*="video_playlist"]').length) score += 10;
        if (textLen >= 8 && textLen <= 260) score += 16;
        if (textLen > 260) score -= 22;
        if (node.matches?.('body, html, main, #root, #page_wrap, [id*="page"]')) score -= 80;
        return score;
    }

    function findPlaylistContainer(link) {
        let current = link;
        for (let depth = 0; depth < 12 && current?.parentElement; depth += 1) {
            const keys = new Set(Array.from(current.querySelectorAll('a[href*="/playlist/"]'))
                .map(a => playlistKeyFromUrl(a.getAttribute('href'))).filter(Boolean));
            if (keys.size > 1) break;
            if (/\d+\s*(?:videos?|видео)/i.test(getTextLines(current).join(' '))) return current;
            current = current.parentElement;
        }
        return link.parentElement || link;
    }

    function inferTitleFromUrl(url) {
        try {
            const parsed = new URL(url, location.href);
            const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
            return cleanTitle(last.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim());
        } catch (_) {
            return '';
        }
    }

    function playlistKeyFromUrl(raw) {
        try {
            const parsed = new URL(raw, location.href);
            const direct = parsed.pathname.match(/\/playlist\/([^/?#]+)/i);
            if (direct) return decodeURIComponent(direct[1]);
            const pl = parsed.searchParams.get('pl');
            if (pl) return pl;
            const z = parsed.searchParams.get('z') || '';
            const zMatch = z.match(/video_playlist([^/?#]+)/i);
            if (zMatch) return zMatch[1];
        } catch (_) {
            // ignore
        }
        return '';
    }

    function findPlaylistCountByKey(doc, key) {
        if (!key) return 0;
        const anchors = doc.querySelectorAll('a[href*="?pl="], a[href*="&pl="]');
        for (const anchor of anchors) {
            if (playlistKeyFromUrl(anchor.getAttribute('href') || anchor.href || '') !== key) continue;
            const text = [
                anchor.getAttribute('aria-label'),
                anchor.getAttribute('title'),
                anchor.innerText,
                anchor.textContent,
            ].filter(Boolean).join(' ');
            const count = parseLooseCount(text);
            if (count > 0) return count;
        }
        return 0;
    }

    // eslint-disable-next-line no-unused-vars
    function buildBatchName(prefix, title) {
        const clean = String(title || 'VK Playlist').replace(/\s+/g, ' ').trim();
        return `${prefix}: ${clean.slice(0, 60)}`;
    }

    function parseDocument(html) {
        return new DOMParser().parseFromString(html, 'text/html');
    }

    function isPlaylistPage(url) {
        const raw = String(url || '');
        return /\/playlist\//i.test(raw) || /[?&]z=video_playlist/i.test(raw);
    }

    function collectPlaylistLinksFromDocument(doc, baseUrl) {
        const candidates = [];
        doc.querySelectorAll('a[href*="/playlist/"], a[href*="video_playlist"], a[href*="z=video_playlist"]').forEach((link) => {
            if (link.closest('#nexus-aggregator-panel')) return;
            const rawHref = link.getAttribute('href') || link.href || '';
            let fetchUrl = '';
            try {
                fetchUrl = new URL(rawHref, baseUrl || location.href).href;
            } catch (_) {
                fetchUrl = rawHref;
            }
            const url = normalizePlaylistUrl(rawHref);
            if (!url) return;
            const playlistKey = playlistKeyFromUrl(url);

            const card = findPlaylistContainer(link);

            const cardLines = getTextLines(card);
            const titleCandidate = (
                link.getAttribute('title') ||
                link.getAttribute('aria-label') ||
                link.innerText ||
                link.textContent ||
                card.querySelector([
                    '[class*="title"]',
                    '[class*="Title"]',
                    '[data-testid*="title"]',
                    'h3',
                    'h4',
                    'strong',
                ].join(', '))?.textContent ||
                link.querySelector('img')?.getAttribute('alt') ||
                ''
            ).replace(/\s+/g, ' ').trim();
            const title = pickPlaylistTitleFromLines(
                titleCandidate ? [titleCandidate, ...cardLines] : cardLines,
                inferTitleFromUrl(fetchUrl || url),
            );

            const countSources = [
                findPlaylistCountByKey(doc, playlistKey),
                card.querySelector('[class*="count"]')?.textContent,
                card.querySelector('[class*="meta"]')?.textContent,
                card.getAttribute('aria-label'),
                link.getAttribute('aria-label'),
                ...cardLines,
            ];
            let videoCount = 0;
            for (const source of countSources) {
                videoCount = typeof source === 'number' ? source : parseLooseCount(source);
                if (videoCount > 0 || /\b0\s*(?:videos?|видео)/i.test(String(source))) break;
            }

            const countKnown = countSources.some(source => /\b\d+\s*(?:videos?|видео)\b/i.test(String(source)));
            candidates.push({
                url,
                fetchUrl,
                title: title && !/^vk playlist$/i.test(title) ? title : `Playlist ${url.split('/').pop()}`,
                videoCount,
                countKnown,
                selected: true,
                status: 'pending',
                sizeBytes: 0,
                totalDurationSec: 0,
                analyzed: false,
                analysisPending: false,
                analysisError: '',
                videoUrls: [],
                origin: baseUrl || location.href,
            });
        });

        return uniqueBy(candidates, (item) => item.url);
    }

    function collectVideoUrlsFromDocument(doc, baseUrl) {
        const urls = [];
        doc.querySelectorAll('a[href*="/video"], a[href*="video-"], a[href*="video_ext.php"]').forEach((link) => {
            const href = link.getAttribute('href') || link.href || '';
            if (!/(?:\/video-?\d+_\d+|video-?\d+_\d+|video_ext\.php)/i.test(href)) return;
            const normalized = normalizeVideoUrl(href, baseUrl);
            if (normalized) urls.push(normalized);
        });
        return uniqueBy(urls, (url) => url);
    }

    function inferPlaylistTitle(doc) {
        const direct = (
            doc.querySelector('h1, h2, [class*="playlist"] h1, [class*="playlist"] h2, .video_playlist_title')?.textContent ||
            doc.querySelector('[class*="title"], [class*="Title"]')?.textContent ||
            ''
        );
        const cleaned = cleanTitle(direct);
        if (cleaned && !/^vk playlist$/i.test(cleaned)) return cleaned;
        const lines = getTextLines(doc.body);
        return cleanTitle(pickPlaylistTitleFromLines(lines, doc.title ? cleanTitle(doc.title) : 'VK Playlist'));
    }

    async function fetchPlaylistDocument(url) {
        if (isCurrentPage(url)) {
            return document;
        }
        try {
            const native = await fetch(url, {
                method: 'GET',
                credentials: 'include',
                headers: {
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                },
            });
            if (native.ok) {
                return parseDocument(await native.text());
            }
        } catch (_) {
            // fallback below
        }
        const response = await gmRequest({
            url,
            method: 'GET',
            headers: {
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
        });
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Playlist page returned ${response.status}`);
        }
        return parseDocument(response.responseText || '');
    }

    async function fetchVkMeta(urls) {
        const missing = urls.filter(url => !metaCache.has(url));
        if (!missing.length) return urls.map(url => metaCache.get(url));
        const response = await gmRequest({
            method: 'POST',
            url: `${API_BASE}/meta/vk`,
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            data: JSON.stringify({ urls: missing }),
            timeout: 120000,
        });
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`VK meta returned ${response.status}`);
        }
        const payload = JSON.parse(response.responseText || '{}');
        const items = payload.results || payload.items;
        if (!Array.isArray(items)) throw new Error('Invalid VK metadata response');
        for (const item of items) if (item?.ok && item.url) metaCache.set(item.url, item);
        return urls.map(url => metaCache.get(url) || items.find(item => item.url === url) || {url, ok: false});
    }

    async function collectRenderedPlaylist(playlist) {
        const url = new URL(playlist.url, location.href);
        if (url.origin !== location.origin) throw new Error('Open this playlist on the current VK domain to analyze it');
        const frame = document.createElement('iframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.style.cssText = 'position:fixed;left:-1600px;top:0;width:1366px;height:1000px;pointer-events:none;';
        const videos = new Map();
        const key = playlistKeyFromUrl(url.href);
        const started = Date.now();
        let stable = 0;
        let lastCount = -1;
        let expected = Number(playlist.videoCount || 0);
        frame.src = url.href;
        document.body.appendChild(frame);
        try {
            while (Date.now() - started < 90000) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                const doc = frame.contentDocument;
                if (!doc || !doc.querySelector('h1')) continue;
                const title = cleanTitle(doc.querySelector('h1').textContent);
                if (title) playlist.title = title;
                const countMatch = (doc.body?.textContent || '').match(/\b(\d+)\s*(?:videos?|видео)\b/i);
                if (countMatch) expected = Number(countMatch[1]);
                for (const a of doc.querySelectorAll('a[data-testid="video_card_thumb"], [data-testid="video_card_title"] a[href]')) {
                    const href = new URL(a.getAttribute('href') || '', url.href);
                    if (href.searchParams.get('pl') !== key) continue;
                    const videoUrl = normalizeVideoUrl(href.href, url.href);
                    if (!/\/video-?\d+_\d+$/.test(videoUrl)) continue;
                    const time = (a.textContent || '').match(/\b(\d{1,3}):(\d{2})(?::(\d{2}))?\b/);
                    const duration = time ? (time[3] ? Number(time[1])*3600+Number(time[2])*60+Number(time[3]) : Number(time[1])*60+Number(time[2])) : 0;
                    const prior = videos.get(videoUrl);
                    videos.set(videoUrl, {url: videoUrl, duration: duration || prior?.duration || 0});
                }
                playlist.videoCount = expected || videos.size;
                stable = videos.size === lastCount ? stable + 1 : 0;
                lastCount = videos.size;
                if ((expected > 0 && videos.size >= expected) || (stable >= 5 && videos.size) || (expected === 0 && countMatch)) break;
                const scrollNodes = [doc.scrollingElement, ...doc.querySelectorAll('div')];
                for (const node of scrollNodes) {
                    if (node && node.scrollHeight > node.clientHeight + 100 && node.clientHeight > 200) node.scrollTop = node.scrollHeight;
                }
                frame.contentWindow.scrollTo(0, doc.documentElement.scrollHeight);
            }
            if (!videos.size && (!frame.contentDocument?.querySelector('h1') || expected !== 0)) throw new Error('VK did not load playlist videos. Retry Analyze.');
            return {videos: [...videos.values()], expected};
        } finally {
            frame.remove();
        }
    }

    function aggregateMetadata(videos, items, expected) {
        const byUrl = new Map(items.map(item => [item.url, item]));
        let sizeBytes = 0, totalDurationSec = 0, sizeCount = 0, durationCount = 0;
        let sizeEstimated = false;
        for (const video of videos) {
            const item = byUrl.get(video.url);
            const duration = Number(item?.ok && item.duration) || video.duration || 0;
            const size = Number(item?.ok && item.size_bytes) || 0;
            if (duration > 0) { totalDurationSec += duration; durationCount++; }
            if (size > 0) {
                sizeBytes += size; sizeCount++;
                // Older Nexus endpoints estimate size without supplying a flag.
                sizeEstimated ||= item.size_estimated !== false;
            }
        }
        return {sizeBytes, totalDurationSec, sizeCount, durationCount, sizeEstimated,
            sizePartial: sizeCount < expected, durationPartial: durationCount < expected};
    }

    function isValidCustomTitle(title) {
        if (!title) return false;
        const low = String(title).trim().toLowerCase();
        if (!low) return false;
        if (/^playlist\s+\d+/i.test(low)) return false;
        if (/^(vk|vk video|video|playlist|video playlist|)$/i.test(low)) return false;
        if (low.includes('\uFFFD')) return false;
        return true;
    }

    async function hydratePlaylistFromPage(playlist, withMeta = false) {
        if (!playlist) return;
        if (playlist.countKnown && playlist.videoCount === 0) {
            playlist.videoUrls = [];
            Object.assign(playlist, aggregateMetadata([], [], 0));
            return;
        }
        const {videos, expected} = await collectRenderedPlaylist(playlist);
        playlist.videoUrls = videos.map(video => video.url);
        playlist.videoCount = Math.max(expected, videos.length);

        if (!withMeta) return;

        const items = [];
        let batchError = '';
        for (let i = 0; i < videos.length; i += MAX_META_BATCH) {
            try {
                items.push(...await fetchVkMeta(videos.slice(i, i + MAX_META_BATCH).map(video => video.url)));
            } catch (error) { batchError = error?.message || String(error); }
            Object.assign(playlist, aggregateMetadata(videos, items, playlist.videoCount));
            renderPanel();
        }
        Object.assign(playlist, aggregateMetadata(videos, items, playlist.videoCount));
        playlist.analysisError = batchError || (playlist.sizePartial || playlist.durationPartial
            ? `Partial metadata: size ${playlist.sizeCount}/${playlist.videoCount}, duration ${playlist.durationCount}/${playlist.videoCount}. Retry Analyze.` : '');
    }

    async function analyzePlaylist(playlist) {
        if (!playlist || playlist.analysisPending) return;
        playlist.analysisPending = true;
        playlist.analysisError = '';
        renderPanel();

        try {
            await hydratePlaylistFromPage(playlist, true);
            playlist.analyzed = true;
            playlist.analysisPending = false;
        } catch (error) {
            playlist.analysisPending = false;
            playlist.analyzed = false;
            playlist.analysisError = error?.message || String(error);
        }

        renderPanel();
    }

    async function enrichCountsAfterScan() {
        const targets = state.playlists.filter((playlist) => !playlist.analyzed && !playlist.analysisPending);
        if (targets.length === 0) return;

        state.hydrationActive = true;
        renderPanel();

        const concurrency = 1;
        let index = 0;

        async function worker() {
            while (index < targets.length) {
                const playlist = targets[index++];
                if (!playlist) continue;

                try {
                    playlist.analysisPending = true;
                    renderPanel();
                    await hydratePlaylistFromPage(playlist, true);
                    playlist.analyzed = true;
                    playlist.analysisPending = false;
                } catch (error) {
                    playlist.analysisPending = false;
                    playlist.analyzed = false; // let them retry if needed
                    playlist.analysisError = error?.message || String(error);
                } finally {
                    renderPanel();
                }
            }
        }

        const workers = Array.from({ length: Math.min(concurrency, targets.length) }, worker);
        await Promise.all(workers);

        state.hydrationActive = false;
        renderPanel();
    }

    async function importPlaylistUrls(urls, batchName) {
        const response = await gmRequest({
            method: 'POST',
            url: `${API_BASE}/bridge/import`,
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            data: JSON.stringify({
                urls,
                batch_name: batchName,
            }),
            timeout: 60000,
        });
        if (response.status < 200 || response.status >= 300) {
            const detail = response.responseText || `HTTP ${response.status}`;
            throw new Error(detail);
        }
        return JSON.parse(response.responseText || '{}');
    }

    function sortPlaylists(key, force = false) {
        if (!force && state.currentSort.key === key) {
            state.currentSort.asc = !state.currentSort.asc;
        } else {
            state.currentSort.key = key;
            if (!force) state.currentSort.asc = key === 'title';
        }

        state.playlists.sort((a, b) => {
            const aVal = key === 'sizeBytes' ? Number(a.sizeBytes || 0) : (a[key] ?? 0);
            const bVal = key === 'sizeBytes' ? Number(b.sizeBytes || 0) : (b[key] ?? 0);
            if (typeof aVal === 'string' || typeof bVal === 'string') {
                const cmp = String(aVal || '').localeCompare(String(bVal || ''));
                return state.currentSort.asc ? cmp : -cmp;
            }
            return state.currentSort.asc ? (aVal - bVal) : (bVal - aVal);
        });

        saveState();
        renderPanel();
    }

    function toggleSelectAll() {
        const pending = state.playlists.filter((p) => p.status === 'pending');
        const allSelected = pending.length > 0 && pending.every((p) => p.selected);
        pending.forEach((p) => {
            p.selected = !allSelected;
        });
        renderPanel();
    }

    function detectActivePlaylist() {
        if (!isPlaylistPage(location.href)) {
            state.activePlaylist = null;
            return;
        }

        const title = inferPlaylistTitle(document);
        const urls = collectVideoUrlsFromDocument(document, location.href);
        const bodyText = document.body?.innerText || '';
        const textCount = parseLooseCount(bodyText);

        state.activePlaylist = {
            url: normalizePlaylistUrl(location.href) || location.href,
            fetchUrl: location.href,
            title,
            videoCount: Math.max(urls.length, textCount),
            selected: true,
            status: 'pending',
            sizeBytes: 0,
            totalDurationSec: 0,
            analyzed: false,
            analysisPending: false,
            analysisError: '',
            videoUrls: urls,
        };
    }

    async function analyzeActivePlaylist() {
        if (!state.activePlaylist || state.activePlaylist.analysisPending || state.activePlaylist.analyzed) return;
        await analyzePlaylist(state.activePlaylist);
    }

    async function doScan() {
        state.scanBusy = true;
        renderPanel();
        try {
            const found = collectPlaylistLinksFromDocument(document, location.href);
            state.playlists = found;
            sortPlaylists(state.currentSort.key || 'videoCount', true);
            enrichCountsAfterScan().catch(console.error);
        } finally {
            state.scanBusy = false;
            renderPanel();
        }
    }

    function doClear() {
        state.playlists = [];
        renderPanel();
    }

    async function importActive() {
        if (!state.activePlaylist) return;
        state.activePlaylistStatus = 'loading';
        renderPanel();
        try {
            await importPlaylistUrls(
                [state.activePlaylist.fetchUrl || state.activePlaylist.url],
                buildBatchName('VK Active Playlist', state.activePlaylist.title),
            );
            state.activePlaylistStatus = 'success';
        } catch (_) {
            state.activePlaylistStatus = 'failed';
        }
        renderPanel();
    }

    async function importSingle(playlist) {
        playlist.status = 'loading';
        renderPanel();
        try {
            await importPlaylistUrls(
                [playlist.fetchUrl || playlist.url],
                buildBatchName('VK Playlist', playlist.title),
            );
            playlist.status = 'success';
        } catch (_) {
            playlist.status = 'failed';
        }
        renderPanel();
    }

    async function bulkImport() {
        const selected = state.playlists.filter((p) => p.selected && p.status === 'pending');
        if (!selected.length || state.bulkBusy) return;

        state.bulkBusy = true;
        selected.forEach((p) => { p.status = 'loading'; });
        renderPanel();

        try {
            await importPlaylistUrls(
                selected.map((p) => p.fetchUrl || p.url),
                `VK Bulk Playlists (${selected.length})`,
            );
            selected.forEach((p) => { p.status = 'success'; });
        } catch (_) {
            selected.forEach((p) => { p.status = 'failed'; });
        }

        state.bulkBusy = false;
        renderPanel();
    }

    function renderProgressBar() {
        const total = state.playlists.length;
        if (total === 0 || (!state.scanBusy && !state.hydrationActive)) return '';

        const completed = state.playlists.filter((p) => p.analyzed || p.status === 'success' || p.status === 'failed').length;
        const percent = Math.min(100, Math.round((completed / total) * 100));

        return `
            <div class="nexus-progress-container">
                <div class="nexus-progress-bar-wrap">
                    <div class="nexus-progress-bar-fill" style="width: ${percent}%;"></div>
                </div>
                <div class="nexus-progress-text">
                    <span>Hydrating: ${completed} / ${total} playlists</span>
                    <span>${percent}%</span>
                </div>
            </div>
        `;
    }

    function renderActiveCard() {
        const p = state.activePlaylist;
        if (!p) return '';

        const detailBits = [];
        detailBits.push(`<strong>Videos:</strong> ${p.videoCount || '--'}`);
        if (state.viewMode === 'detail') {
            detailBits.push(`<strong>Size:</strong> ${playlistSizeText(p)}`);
            detailBits.push(`<strong>Duration:</strong> ${playlistDurationText(p)}`);
        }

        return `
            <div class="nexus-active-alert">
                <div class="nexus-active-head">
                    <div>
                        <div class="nexus-active-title">Active Playlist Detected</div>
                        <div class="nexus-active-sub">${escapeHtml(p.title)}</div>
                    </div>
                    <button class="nexus-mini-btn" id="active-analyze-btn">${p.analysisPending ? 'Analyzing…' : 'Analyze'}</button>
                </div>
                <div class="nexus-active-meta">${detailBits.join(' &nbsp;•&nbsp; ')}</div>
                ${p.analysisError ? `<div class="nexus-inline-error">${escapeHtml(p.analysisError)}</div>` : ''}
                ${state.activePlaylistStatus === 'pending'
                    ? `<button class="nexus-btn nexus-btn-active-playlist" id="import-active-btn">Import This Playlist Into Nexus</button>`
                    : `<div style="text-align:center;"><span class="status-badge status-${p.status || state.activePlaylistStatus}">${state.activePlaylistStatus.toUpperCase()}</span></div>`
                }
            </div>
        `;
    }

    function renderRows() {
        if (!state.playlists.length) {
            return `
                <tr>
                    <td colspan="${state.viewMode === 'detail' ? 6 : 4}" class="nexus-empty-cell">
                        Open a VK playlists page and run scan. In detail mode you can also analyze total playlist size in MB/GB.
                    </td>
                </tr>
            `;
        }

        return state.playlists.map((playlist, index) => {
            const displayTitle = String(playlist.title || '').trim() || `Playlist ${String(playlist.url || playlist.fetchUrl || index + 1).split('/').pop() || (index + 1)}`;
            const detailColumns = state.viewMode === 'detail' ? `
                <td class="mono-cell">${playlistSizeText(playlist)}</td>
                <td class="mono-cell">${playlistDurationText(playlist)}</td>
            ` : '';

            const actionContent = playlist.status === 'pending'
                ? `
                    <div class="action-stack">
                        ${state.viewMode === 'detail'
                            ? `<button class="nexus-mini-btn" id="analyze-btn-${index}">${playlist.analysisPending ? 'Analyzing…' : 'Analyze'}</button>`
                            : ''
                        }
                        <button class="nexus-mini-btn is-primary" id="import-btn-${index}">Import</button>
                    </div>
                `
                : `<span class="status-badge status-${playlist.status}">${playlist.status.toUpperCase()}</span>`;

            return `
                <tr>
                    <td>
                        <label class="checkbox-container">
                            <input type="checkbox" id="cb-${index}" ${playlist.selected ? 'checked' : ''} ${playlist.status !== 'pending' ? 'disabled' : ''}>
                        </label>
                    </td>
                    <td class="playlist-title-cell">
                        <a href="${escapeHtml(playlist.fetchUrl || playlist.url)}" target="_blank" title="${escapeHtml(displayTitle)}">${escapeHtml(displayTitle)}</a>
                        ${playlist.analysisError ? `<div class="row-sub-error">${escapeHtml(playlist.analysisError)}</div>` : ''}
                    </td>
                    <td class="mono-cell"><span class="count-badge">${playlist.videoCount ?? '--'}</span></td>
                    ${detailColumns}
                    <td class="status-cell">${actionContent}</td>
                </tr>
            `;
        }).join('');
    }

    function renderPanel() {
        panel.className = `${state.collapsed ? 'collapsed' : ''} view-${state.viewMode}`;

        if (state.collapsed) {
            panel.innerHTML = `
                <div class="nexus-header" id="nexus-header-trigger">
                    <span class="nexus-title">Nexus Aggregator</span>
                    <div class="header-actions-inline">
                        <span class="nexus-chip">${state.viewMode === 'detail' ? 'Detail' : 'Light'}</span>
                        <button class="nexus-btn compact-btn">Open</button>
                    </div>
                </div>
            `;
            document.getElementById('nexus-header-trigger').addEventListener('click', togglePanel);
            return;
        }

        panel.innerHTML = `
            <div class="nexus-header" id="nexus-header-trigger">
                <div class="header-title-wrap">
                    <span class="nexus-title">Nexus Playlist Aggregator</span>
                    <span class="nexus-subtitle">${state.viewMode === 'detail' ? 'Detail view with size analytics' : 'Light view for quick import'}</span>
                </div>
                <div class="header-actions-inline">
                    <button class="nexus-mini-btn" id="toggle-view-btn">${state.viewMode === 'detail' ? 'Light' : 'Detail'}</button>
                    <span class="nexus-collapse-tag">Collapse</span>
                </div>
            </div>
            <div class="nexus-body">
                ${renderActiveCard()}
                <div class="toolbar-row">
                    <button class="nexus-btn" id="scan-playlists-btn">${state.scanBusy ? 'Scanning…' : 'Scan page for links'}</button>
                    <button class="nexus-btn nexus-btn-secondary" id="clear-playlists-btn">Clear</button>
                </div>
                <div class="nexus-search-info">
                    <span id="scanned-count">Scanned: ${state.playlists.length} playlists</span>
                    <div class="right-meta-tools">
                        <button class="nexus-link-btn" id="select-all-btn">${state.selectAllLabel}</button>
                        <span class="resize-hint">drag corner to resize</span>
                    </div>
                </div>
                ${renderProgressBar()}
                <div class="nexus-list-container">
                    <table class="nexus-table">
                        <thead>
                            <tr>
                                <th style="width: 34px;"></th>
                                <th id="sort-title">Playlist Title</th>
                                <th id="sort-count" class="mono-cell">Videos</th>
                                ${state.viewMode === 'detail' ? `
                                    <th id="sort-size" class="mono-cell">Total Size</th>
                                    <th class="mono-cell">Duration</th>
                                ` : ''}
                                <th class="status-cell">Action</th>
                            </tr>
                        </thead>
                        <tbody id="playlist-table-body">${renderRows()}</tbody>
                    </table>
                </div>
            </div>
            <div class="nexus-footer">
                <span class="footer-target">Target: <strong>Local Nexus bridge import</strong></span>
                <button class="nexus-btn" id="bulk-import-btn" ${state.playlists.filter((p) => p.selected && p.status === 'pending').length === 0 ? 'disabled' : ''}>
                    Bulk Import Selected (${state.playlists.filter((p) => p.selected && p.status === 'pending').length})
                </button>
            </div>
        `;

        document.getElementById('nexus-header-trigger').addEventListener('click', onHeaderClick);
        document.getElementById('toggle-view-btn').addEventListener('click', (event) => {
            event.stopPropagation();
            state.viewMode = state.viewMode === 'detail' ? 'light' : 'detail';
            saveState();
            renderPanel();
        });
        document.getElementById('scan-playlists-btn').addEventListener('click', (event) => {
            event.stopPropagation();
            doScan().catch(console.error);
        });
        document.getElementById('clear-playlists-btn').addEventListener('click', (event) => {
            event.stopPropagation();
            doClear();
        });
        document.getElementById('select-all-btn').addEventListener('click', (event) => {
            event.stopPropagation();
            toggleSelectAll();
        });
        document.getElementById('bulk-import-btn').addEventListener('click', (event) => {
            event.stopPropagation();
            bulkImport().catch(console.error);
        });
        document.getElementById('sort-title').addEventListener('click', (event) => {
            event.stopPropagation();
            sortPlaylists('title');
        });
        document.getElementById('sort-count').addEventListener('click', (event) => {
            event.stopPropagation();
            sortPlaylists('videoCount');
        });
        document.getElementById('sort-size')?.addEventListener('click', (event) => {
            event.stopPropagation();
            sortPlaylists('sizeBytes');
        });

        if (state.activePlaylist) {
            document.getElementById('active-analyze-btn')?.addEventListener('click', (event) => {
                event.stopPropagation();
                analyzePlaylist(state.activePlaylist).catch(console.error);
            });
            document.getElementById('import-active-btn')?.addEventListener('click', (event) => {
                event.stopPropagation();
                importActive().catch(console.error);
            });
        }

        state.playlists.forEach((playlist, index) => {
            document.getElementById(`cb-${index}`)?.addEventListener('change', (event) => {
                playlist.selected = event.target.checked;
                renderPanel();
            });
            document.getElementById(`import-btn-${index}`)?.addEventListener('click', (event) => {
                event.stopPropagation();
                importSingle(playlist).catch(console.error);
            });
            document.getElementById(`analyze-btn-${index}`)?.addEventListener('click', (event) => {
                event.stopPropagation();
                analyzePlaylist(playlist).catch(console.error);
            });
        });
    }

    function onHeaderClick(event) {
        if (
            event.target.closest('button') ||
            event.target.closest('a') ||
            event.target.closest('input')
        ) {
            return;
        }
        togglePanel();
    }

    function togglePanel() {
        state.collapsed = !state.collapsed;
        saveState();
        renderPanel();
        if (!state.collapsed) {
            analyzeActivePlaylist().catch(console.error);
        }
    }

    const style = document.createElement('style');
    style.textContent = `
        #nexus-aggregator-panel {
            position: fixed;
            right: 24px;
            bottom: 24px;
            width: 520px;
            min-width: 360px;
            min-height: 210px;
            max-width: min(92vw, 980px);
            max-height: 84vh;
            background: rgba(14, 12, 25, 0.90);
            backdrop-filter: blur(18px);
            border: 1px solid rgba(143, 96, 255, 0.34);
            border-radius: 18px;
            box-shadow: 0 18px 60px rgba(0, 0, 0, 0.55), 0 0 28px rgba(143, 96, 255, 0.18);
            color: #f5f3ff;
            font-family: "Segoe UI", Arial, sans-serif;
            z-index: 999999;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            resize: both;
        }
        #nexus-aggregator-panel.view-detail {
            width: 780px;
            height: 72vh;
        }
        #nexus-aggregator-panel.view-light {
            width: 520px;
            height: 520px;
        }
        #nexus-aggregator-panel.collapsed {
            width: 220px;
            min-height: 0;
            height: auto;
            resize: none;
        }
        .nexus-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 12px 14px;
            background: linear-gradient(135deg, rgba(85, 31, 143, 0.72), rgba(42, 54, 151, 0.72));
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            cursor: pointer;
            user-select: none;
        }
        .header-title-wrap {
            display: flex;
            flex-direction: column;
            gap: 3px;
            min-width: 0;
        }
        .header-actions-inline {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-shrink: 0;
        }
        .nexus-title {
            font-size: 14px;
            font-weight: 700;
            letter-spacing: 0.02em;
        }
        .nexus-subtitle {
            font-size: 11px;
            color: rgba(231, 225, 255, 0.72);
        }
        .nexus-chip, .nexus-collapse-tag {
            font-size: 11px;
            color: #d6bcff;
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 999px;
            padding: 4px 8px;
        }
        .compact-btn {
            padding: 4px 10px;
            font-size: 11px;
        }
        .nexus-body {
            display: flex;
            flex-direction: column;
            gap: 12px;
            padding: 14px;
            overflow: auto;
            flex: 1;
        }
        .nexus-active-alert {
            border: 1px solid rgba(16, 185, 129, 0.24);
            background: rgba(16, 185, 129, 0.09);
            border-radius: 12px;
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .nexus-active-head {
            display: flex;
            justify-content: space-between;
            gap: 12px;
            align-items: start;
        }
        .nexus-active-title {
            font-size: 13px;
            font-weight: 700;
            color: #a7f3d0;
        }
        .nexus-active-sub {
            font-size: 12px;
            color: #eef2ff;
            word-break: break-word;
        }
        .nexus-active-meta {
            font-size: 12px;
            color: #ddd6fe;
        }
        .toolbar-row {
            display: flex;
            gap: 8px;
        }
        .nexus-btn, .nexus-mini-btn {
            border: none;
            border-radius: 10px;
            color: white;
            cursor: pointer;
            font-weight: 600;
        }
        .nexus-btn {
            background: linear-gradient(135deg, #7c3aed, #4f46e5);
            padding: 8px 12px;
            font-size: 12px;
        }
        .nexus-btn:disabled {
            opacity: 0.45;
            cursor: not-allowed;
        }
        .nexus-btn-secondary {
            background: rgba(255, 255, 255, 0.10);
            border: 1px solid rgba(255, 255, 255, 0.12);
        }
        .nexus-btn-active-playlist {
            background: linear-gradient(135deg, #10b981, #059669);
            padding: 10px 12px;
        }
        .nexus-mini-btn {
            background: rgba(255, 255, 255, 0.10);
            border: 1px solid rgba(255, 255, 255, 0.12);
            padding: 6px 10px;
            font-size: 11px;
        }
        .nexus-mini-btn.is-primary {
            background: linear-gradient(135deg, #8b5cf6, #6366f1);
        }
        .nexus-link-btn {
            border: none;
            background: transparent;
            color: #c4b5fd;
            cursor: pointer;
            font-size: 11px;
            text-decoration: underline;
        }
        .nexus-search-info {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 10px;
            font-size: 11px;
            color: #a1a1aa;
        }
        .right-meta-tools {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .resize-hint {
            color: #7c7c8d;
            font-size: 10px;
        }
        .nexus-list-container {
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 12px;
            overflow: auto;
            background: rgba(0, 0, 0, 0.20);
            flex: 1;
            min-height: 180px;
        }
        .nexus-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
        }
        .nexus-table th, .nexus-table td {
            padding: 10px 12px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.06);
            text-align: left;
            vertical-align: top;
        }
        .nexus-table th {
            position: sticky;
            top: 0;
            background: rgba(26, 20, 44, 0.96);
            color: #c4b5fd;
            z-index: 1;
            cursor: pointer;
        }
        .nexus-table tr:hover td {
            background: rgba(139, 92, 246, 0.06);
        }
        .playlist-title-cell {
            max-width: 320px;
            font-weight: 600;
        }
        .playlist-title-cell a {
            color: #f5f3ff;
            text-decoration: none;
        }
        .playlist-title-cell a:hover {
            color: #c4b5fd;
            text-decoration: underline;
        }
        .count-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 34px;
            padding: 3px 8px;
            border-radius: 999px;
            background: rgba(139, 92, 246, 0.16);
            border: 1px solid rgba(139, 92, 246, 0.28);
            color: #ddd6fe;
            font-weight: 700;
        }
        .mono-cell {
            white-space: nowrap;
            font-variant-numeric: tabular-nums;
        }
        .status-cell {
            white-space: nowrap;
            width: 132px;
        }
        .action-stack {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
            justify-content: end;
        }
        .status-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 5px 9px;
            border-radius: 999px;
            font-size: 10px;
            font-weight: 700;
        }
        .status-pending { background: rgba(161, 161, 170, 0.16); color: #d4d4d8; }
        .status-loading { background: rgba(245, 158, 11, 0.16); color: #fcd34d; }
        .status-success { background: rgba(16, 185, 129, 0.16); color: #86efac; }
        .status-failed { background: rgba(239, 68, 68, 0.16); color: #fca5a5; }
        .checkbox-container input {
            accent-color: #8b5cf6;
        }
        .nexus-footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            padding: 12px 14px;
            border-top: 1px solid rgba(255, 255, 255, 0.08);
            background: rgba(0, 0, 0, 0.18);
        }
        .footer-target {
            color: #a1a1aa;
            font-size: 11px;
        }
        .footer-target strong {
            color: #c4b5fd;
        }
        .nexus-empty-cell {
            text-align: center;
            color: #9ca3af;
            padding: 22px;
        }
        .row-sub-error, .nexus-inline-error {
            margin-top: 6px;
            color: #fca5a5;
            font-size: 11px;
        }
        #nexus-aggregator-panel::-webkit-scrollbar,
        .nexus-body::-webkit-scrollbar,
        .nexus-list-container::-webkit-scrollbar {
            width: 8px;
            height: 8px;
        }
        #nexus-aggregator-panel::-webkit-scrollbar-thumb,
        .nexus-body::-webkit-scrollbar-thumb,
        .nexus-list-container::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.14);
            border-radius: 999px;
        }

        /* Progress Bar styles */
        .nexus-progress-container {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.05);
            border-radius: 10px;
            padding: 10px;
            margin-bottom: 4px;
        }
        .nexus-progress-bar-wrap {
            height: 6px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 999px;
            overflow: hidden;
            position: relative;
        }
        .nexus-progress-bar-fill {
            height: 100%;
            background: linear-gradient(90deg, #8b5cf6, #3b82f6);
            border-radius: 999px;
            transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            position: relative;
            overflow: hidden;
        }
        .nexus-progress-bar-fill::after {
            content: '';
            position: absolute;
            top: 0; left: 0; right: 0; bottom: 0;
            background: linear-gradient(
                90deg,
                rgba(255,255,255,0) 0%,
                rgba(255,255,255,0.15) 50%,
                rgba(255,255,255,0) 100%
            );
            animation: progress-shimmer 1.6s infinite;
        }
        .nexus-progress-text {
            display: flex;
            justify-content: space-between;
            font-size: 11px;
            color: #c4b5fd;
            margin-top: 6px;
            font-weight: 600;
        }
        @keyframes progress-shimmer {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(100%); }
        }

        /* Micro-interactions & animations */
        .nexus-btn {
            transition: transform 0.2s, box-shadow 0.2s, background 0.2s;
        }
        .nexus-btn:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3);
        }
        .nexus-btn:active {
            transform: translateY(1px);
        }
        .nexus-table tr {
            transition: background-color 0.2s;
        }
        .status-loading {
            animation: pulse-loading 1.5s infinite ease-in-out;
        }
        @keyframes pulse-loading {
            0%, 100% { opacity: 0.6; }
            50% { opacity: 1; }
        }
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'nexus-aggregator-panel';
    document.body.appendChild(panel);

    loadState();
    detectActivePlaylist();
    renderPanel();
    if (!state.collapsed) {
        analyzeActivePlaylist().catch(console.error);
    }

    let lastUrl = location.href;
    new MutationObserver(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            state.activePlaylistStatus = 'pending';
            detectActivePlaylist();
            renderPanel();
            if (!state.collapsed) {
                analyzeActivePlaylist().catch(console.error);
            }
        } else if (state.activePlaylist && (!state.activePlaylist.videoUrls || state.activePlaylist.videoUrls.length === 0)) {
            const beforeCount = state.activePlaylist.videoCount;
            detectActivePlaylist();
            if (state.activePlaylist && state.activePlaylist.videoCount !== beforeCount) {
                renderPanel();
                if (!state.collapsed) {
                    analyzeActivePlaylist().catch(console.error);
                }
            }
        }
    }).observe(document.documentElement || document.body, { childList: true, subtree: true });
})();
