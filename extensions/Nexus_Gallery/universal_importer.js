// Nexus Universal Video Importer - Content Script for WorkingBig

// Dashboard postMessage relay — runs on localhost dashboard ports, before the localhost guard below.
// Allows dashboard JS to send messages to background.js via window.postMessage.
(function () {
    const _h = window.location.hostname;
    const _p = window.location.port;
    const _isDashboard = (_h === 'localhost' || _h === '127.0.0.1') && (_p === '8000' || _p === '8001' || _p === '8002');
    if (!_isDashboard) return;

    window.addEventListener('message', (event) => {
        if (!event.data || event.data.type !== 'NEXUS_TO_EXT') return;
        const msg = { ...event.data };
        delete msg.type;
        chrome.runtime.sendMessage(msg, (response) => {
            window.postMessage({
                type: 'NEXUS_FROM_EXT',
                action: msg.action,
                video_id: msg.video_id,
                ...(response || {}),
            }, '*');
        });
    });
})();

(function () {
    // Avoid injecting/running on local dashboard URLs (localhost, 127.0.0.1) on ports 8000-8002
    const currentLoc = window.location.href.toLowerCase();
    const hostname = window.location.hostname.toLowerCase();
    // The dedicated FapFolder library owns selection and import on this host.
    if (/(^|\.)fapfolder\.club$/i.test(hostname)) return;
    const port = window.location.port;

    if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        port === '8000' ||
        port === '8001' ||
        port === '8002' ||
        currentLoc.includes('//localhost') ||
        currentLoc.includes('//127.0.0.1') ||
        currentLoc.includes(':8000') ||
        currentLoc.includes(':8001') ||
        currentLoc.includes(':8002') ||
        currentLoc.includes('//192.168.') ||
        currentLoc.includes('//10.') ||
        currentLoc.includes('//172.16.') ||
        currentLoc.includes('//172.17.') ||
        currentLoc.includes('//172.18.') ||
        currentLoc.includes('//172.19.') ||
        currentLoc.includes('//172.20.') ||
        currentLoc.includes('//172.21.') ||
        currentLoc.includes('//172.22.') ||
        currentLoc.includes('//172.23.') ||
        currentLoc.includes('//172.24.') ||
        currentLoc.includes('//172.25.') ||
        currentLoc.includes('//172.26.') ||
        currentLoc.includes('//172.27.') ||
        currentLoc.includes('//172.28.') ||
        currentLoc.includes('//172.29.') ||
        currentLoc.includes('//172.30.') ||
        currentLoc.includes('//172.31.')
    ) {
        console.log("Nexus Importer: Disabled on local dashboard pages to prevent importing from dashboard to dashboard.");
        return;
    }

    // Run in all frames so we catch <video> inside cross-origin player embeds
    // (filemoon, streamtape, hrnytube, …). BUT the panel must live in the TOP
    // frame — a panel built inside a small player iframe is clipped/invisible.
    // So: sub-frames relay the resolved stream URL up; the top frame shows the
    // panel. This is what fixes hornysimp/fileditch-style embed pages.
    const IS_TOP_FRAME = (() => { try { return window.self === window.top; } catch { return false; } })();
    const NEXUS_IFRAME_MSG = 'NEXUS_IFRAME_VIDEO';
    let qualitySearchState = { status: 'unknown', current: 0, highest: 0, levels: [] };

    function requestHighestQuality(owner, userInitiated = false) {
        const container = owner || document.querySelector('.nexus-import-overlay');
        if (!container || container._qualitySearchBusy) return;
        if (!userInitiated && container._qualitySearchCompletedFor === container._boundVideo &&
            container._qualitySearchCompletedPage === location.href) return;
        if (!userInitiated && (Date.now() - Number(container._qualitySearchRequestAt || 0)) < 8000) return;
        container._qualitySearchRequestAt = Date.now();
        const requestId = (Number(container._qualitySearchRequestId) || 0) + 1;
        container._qualitySearchRequestId = requestId;
        const requestedVideo = container._boundVideo;
        container._qualitySearchBusy = true;
        const qualityEl = container.querySelector('.nexus-quality-state');
        const findButton = container.querySelector('.nexus-quality-find');
        if (userInitiated && qualityEl) qualityEl.textContent = 'Spúšťam prehrávanie a hľadám najvyššiu kvalitu…';
        if (findButton) { findButton.disabled = true; findButton.textContent = 'Hľadám…'; }
        const timeoutId = setTimeout(() => {
            if (container._qualitySearchRequestId !== requestId) return;
            container._qualitySearchRequestId++;
            container._qualitySearchBusy = false;
            qualitySearchState = { status: 'unknown', current: 0, highest: 0, levels: [] };
            if (qualityEl) {
                qualityEl.textContent = 'Hľadanie trvalo príliš dlho · skús znova';
                qualityEl.title = 'Prehrávač neodpovedal v časovom limite.';
            }
            if (findButton) { findButton.disabled = false; findButton.textContent = 'Nájsť najvyššiu'; }
        }, 11000);
        chrome.runtime.sendMessage({ action: 'QUALITY_FIND_HIGHEST' }, response => {
            if (container._qualitySearchRequestId !== requestId) return;
            clearTimeout(timeoutId);
            container._qualitySearchBusy = false;
            if (chrome.runtime.lastError || !response?.ok) {
                qualitySearchState = { status: 'unknown', current: 0, highest: 0, levels: [] };
                if (qualityEl) paintVideoQuality(qualityEl);
            } else {
                qualitySearchState = response.result || qualitySearchState;
                if (qualityEl) paintVideoQuality(qualityEl);
                if (qualitySearchState.status === 'verified' && container._boundVideo === requestedVideo) {
                    container._qualitySearchCompletedFor = requestedVideo;
                    container._qualitySearchCompletedPage = location.href;
                    // The captured URL and byte count must follow the selected
                    // rendition, rather than remain bound to the old source.
                    bindVideoToOverlay(requestedVideo, true).catch(() => {});
                }
            }
            if (findButton) { findButton.disabled = false; findButton.textContent = 'Nájsť najvyššiu'; }
        });
    }

    function paintVideoQuality(element, boundVideo = null) {
        const { status, current, highest } = qualitySearchState;
        if (status === 'verified') {
            element.textContent = `${current}p · najvyššia overená`;
            element.title = `Prehrávač ponúka najviac ${highest}p a túto kvalitu prehráva.`;
        } else if (status === 'upgrade-failed') {
            element.textContent = `${current}p · vyššiu ${highest}p sa nepodarilo overiť`;
            element.title = `Prehrávač ponúka až ${highest}p, ale jej prehratie sa nepodarilo overiť.`;
        } else if (status === 'lower') {
            element.textContent = `${current}p prehráva · vyššia ${highest}p neoverená`;
            element.title = `Prehrávanie funguje pri ${current}p. Vyššia kvalita ${highest}p je ponúkaná, ale nepodarilo sa ju potvrdiť.`;
        } else if (status === 'unverified') {
            element.textContent = highest ? `${highest}p dostupné · prehratie neoverené` : 'Vyššiu kvalitu sa nepodarilo overiť';
            element.title = `Aktuálne overená: ${current ? `${current}p` : 'neznáma'}; prehrávač ponúka až ${highest || 'neznámu'}p.`;
        } else {
            const v = boundVideo || document.querySelector('.nexus-import-overlay')?._boundVideo;
            const height = Number(v?.videoHeight || 0);
            if (height > 0) {
                element.textContent = `${height}p · priamy súbor`;
                element.title = `Rozlíšenie prehrávaného videa: ${v.videoWidth || '?'}x${height}`;
                return;
            }
            const titleMatch = (document.title || '').match(/\b(2160|1440|1080|720|480|360)p?\b/i);
            if (titleMatch) {
                element.textContent = `${titleMatch[1]}p · z názvu videa`;
                element.title = `Kvalita odhadnutá z názvu súboru (${titleMatch[1]}p).`;
                return;
            }
            element.textContent = 'Kvalitu sa nepodarilo overiť';
            element.title = 'Prehrávač neposkytol čitateľný zoznam dostupných kvalít.';
        }
    }

    // Userscripts (MEGA Folder Helper) cannot call chrome.runtime directly.
    // Relay their explicit Sidecar request through this content script and send
    // a correlated result back to the same page.
    if (IS_TOP_FRAME) {
        window.addEventListener('message', (event) => {
            if (event.source !== window || event.origin !== window.location.origin) return;
            const message = event.data;
            if (!message || message.type !== 'NEXUS_GALLERY_SIDECAR_ENQUEUE') return;
            const requestId = String(message.requestId || '');
            const items = Array.isArray(message.items) ? message.items : [];
            chrome.runtime.sendMessage({
                action: 'NEXUS_SEND_TO_SIDECAR',
                items,
                sourcePageUrl: String(message.sourcePageUrl || window.location.href),
            }, (result) => {
                window.postMessage({ type: 'NEXUS_GALLERY_SIDECAR_RESULT', requestId, result }, window.location.origin);
            });
        }, false);
    }

    const SCAN_INTERVAL = 2000;
    const MIN_DURATION = 1; // Show for everything, even short clips
    const MIN_IMPORT_SIZE_BYTES = 10 * 1024 * 1024;
    // Minimum dimensions to ignore thumbnail/cam preview videos
    const MIN_WIDTH_PX = 200; // Relaxed
    const MIN_HEIGHT_PX = 150; // Relaxed
    // Video.js uses `vjs-workinghover` for normal players; only treat hover as
    // a preview hint when it is a separate class or name component.
    const PREVIEW_HINT_RE = /(?:preview|thumb|thumbnail|trailer|teaser|sample|snippet|(?:^|[\s_./-])hover(?:$|[\s_./-])|promo|poster|related|carousel|mini[-\s]?player|video[-\s]?preview)/i;
    const PLAYER_FILTER_DEFAULTS = {
        zoom: 1,
        brightness: 1,
        contrast: 1,
        saturation: 1,
        gamma: 1,
        sharpen: 0,
        panX: 0,
        panY: 0,
    };

    // ── Utilities ──────────────────────────────────────────────────────────────

    function formatSize(bytes) {
        const v = Number(bytes || 0);
        if (!Number.isFinite(v) || v <= 0) return null;
        if (v >= 1073741824) return `${(v / 1073741824).toFixed(2)} GB`;
        if (v >= 1048576) {
            const mb = v / 1048576;
            const decimals = mb % 1 === 0 ? 0 : Math.round(mb * 100) % 10 === 0 ? 1 : 2;
            return `${mb.toFixed(decimals)} MB`;
        }
        if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
        return `${v} B`;
    }

    function knownImportSizeBytes(container) {
        const measured = Number(container?._sizeBytes || 0);
        if (Number.isFinite(measured) && measured > 0) return measured;

        const text = container?.querySelector?.('.nexus-size-value')?.textContent || '';
        const match = text.match(/(?:Size:\s*)?([\d.,]+)\s*(B|KB|KiB|MB|MiB|GB|GiB)\b/i);
        if (!match) return 0;
        const amount = Number(match[1].replace(',', '.'));
        const unit = match[2].toUpperCase();
        const multiplier = unit.startsWith('G') ? 1024 ** 3
            : unit.startsWith('M') ? 1024 ** 2
                : unit.startsWith('K') ? 1024 : 1;
        return Number.isFinite(amount) && amount > 0 ? Math.round(amount * multiplier) : 0;
    }

    function isBelowMinimumImportSize(bytes) {
        return Number.isFinite(Number(bytes)) && Number(bytes) > 0 && Number(bytes) < MIN_IMPORT_SIZE_BYTES;
    }

    function parseDurationSeconds(raw) {
        const text = String(raw || '').trim();
        if (!text) return 0;
        if (/^\d+(?:\.\d+)?$/.test(text)) return Math.max(0, Math.round(Number(text)));
        const compact = text.replace(/\s+/g, '');
        const parts = compact.split(':').map((part) => Number(part));
        if (parts.some((n) => !Number.isFinite(n))) return 0;
        if (parts.length === 2) return Math.max(0, Math.round(parts[0] * 60 + parts[1]));
        if (parts.length === 3) return Math.max(0, Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2]));
        return 0;
    }

    function getBestKnownDuration(video) {
        const direct = Number(video?.duration || 0) || 0;
        if (Number.isFinite(direct) && direct > 0) return Math.round(direct);

        const attrs = [
            video?.dataset?.duration,
            video?.getAttribute?.('data-duration'),
            video?.getAttribute?.('duration'),
            video?.getAttribute?.('data-length'),
        ];
        for (const value of attrs) {
            const parsed = parseDurationSeconds(value);
            if (parsed > 0) return parsed;
        }

        const selectors = [
            'meta[property="video:duration"]',
            'meta[property="og:video:duration"]',
            'meta[name="video:duration"]',
            'meta[itemprop="duration"]',
        ];
        for (const selector of selectors) {
            const el = document.querySelector(selector);
            const parsed = parseDurationSeconds(el?.getAttribute?.('content') || el?.content || el?.textContent || '');
            if (parsed > 0) return parsed;
        }

        const textCandidates = [
            video?.parentElement?.querySelector?.('.duration, .video-duration, .vjs-duration-display')?.textContent || '',
            // Avoid taking the first related-card timestamp as the main duration.
            document.querySelector('#player .duration, #video-player .duration, .video-info .video-duration')?.textContent || '',
        ];
        for (const text of textCandidates) {
            const match = String(text || '').match(/\b(\d{1,2}:)?\d{1,2}:\d{2}\b/);
            const parsed = parseDurationSeconds(match?.[0] || '');
            if (parsed > 0) return parsed;
        }

        return 0;
    }

    function isHls(url) { return /\.m3u8(\?|$)/i.test(url); }

    function updateImportDuration(container) {
        const value = container.querySelector('.nexus-duration-value');
        if (!value) return;
        const seconds = getBestKnownDuration(container._boundVideo);
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor(seconds / 60) % 60;
        const clock = hours ? `${hours}:${String(minutes).padStart(2, '0')}` : String(minutes);
        value.textContent = seconds > 0 ? `Duration: ${clock}:${String(seconds % 60).padStart(2, '0')}` : 'Duration: unknown';
    }

    function bgFetchHead(url, referer) {
        return new Promise(resolve => {
            chrome.runtime.sendMessage({ action: 'FETCH_HEAD_INFO', url, referer: referer || '' }, res => {
                if (chrome.runtime.lastError) { resolve(null); return; }
                resolve(res || null);
            });
        });
    }

    function bgFetchText(url, referer = window.location.href) {
        return new Promise(resolve => {
            chrome.runtime.sendMessage({ action: 'FETCH_EMBED_CORS', url, referer }, res => {
                resolve(res?.html || null);
            });
        });
    }

    function bgProbeMediaMetadata(url, referer) {
        return new Promise(resolve => {
            chrome.runtime.sendMessage({ action: 'PROBE_MEDIA_METADATA', url, referer: referer || '' }, res => {
                resolve(res || null);
            });
        });
    }

    function isGofilePage(url = window.location.href) {
        try {
            const host = new URL(url, window.location.href).hostname.toLowerCase();
            return /(?:^|\.)gofile\.io$/i.test(host);
        } catch {
            return /gofile\.io/i.test(String(url || ""));
        }
    }

    function isBunkrPage(url) {
        try {
            const host = new URL(url, window.location.href).hostname.toLowerCase();
            return /(?:^|\.)(?:bunkr[a-z0-9-]*|balbums)\.[a-z.]+$/i.test(host) || host.includes('bunkr') || host.includes('balbums');
        } catch {
            return /bunkr|balbums/i.test(String(url || ''));
        }
    }

    function extractBunkrSlug(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        try {
            const url = new URL(raw, window.location.href);
            const match = url.pathname.match(/\/(?:f|v|d)\/([^/?#]+)/i);
            return match ? String(match[1] || '').trim() : '';
        } catch {
            const match = raw.match(/\/(?:f|v|d)\/([^/?#]+)/i);
            return match ? String(match[1] || '').trim() : '';
        }
    }

    function decryptBunkrVsUrl(encodedUrl, timestamp) {
        const payload = String(encodedUrl || '').trim();
        const ts = Number(timestamp || 0);
        if (!payload || !ts) return null;
        try {
            const decoded = atob(payload);
            const bytes = new Uint8Array(decoded.length);
            for (let i = 0; i < decoded.length; i += 1) {
                bytes[i] = decoded.charCodeAt(i);
            }
            const key = new TextEncoder().encode(`SECRET_KEY_${Math.floor(ts / 3600)}`);
            const output = new Uint8Array(bytes.length);
            for (let i = 0; i < bytes.length; i += 1) {
                output[i] = bytes[i] ^ key[i % key.length];
            }
            const url = new TextDecoder().decode(output).trim();
            return /^https?:\/\//i.test(url) ? url : null;
        } catch {
            return null;
        }
    }

    function extractDirectBunkrVideoUrlFromHtml(html) {
        const text = String(html || '');
        if (!text) return '';
        const patterns = [
            /https?:\/\/[a-z0-9.-]+\.(?:st|su|io|is|si|la|pk|cr|ru)\/[a-zA-Z0-9_-]+\.(?:mp4|mkv|mov|webm)(?:\?[^"'<>\\s]*)?/gi,
            /"file"\s*:\s*"([^"]+\.(?:mp4|mkv|webm)[^"]*)"/gi,
            /"src"\s*:\s*"([^"]+\.(?:mp4|mkv|webm)[^"]*)"/gi,
            /source\s+src=["']([^"']+\.(?:mp4|mkv|webm)[^"']*)["']/gi,
            /href=["'](https?:\/\/[^"']+\.(?:mp4|mkv|webm)[^"']*)["']/gi,
        ];
        const candidates = [];
        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(text))) {
                const candidate = String(match[1] || match[0] || '').replace(/\\/g, '').trim();
                if (!candidate) continue;
                if (/preview|thumb|sample|trailer|intro/i.test(candidate)) continue;
                candidates.push(candidate);
            }
        }
        return candidates[0] || '';
    }

    async function resolveBunkrViaVs(pageUrlOrSlug) {
        const rawSlug = extractBunkrSlug(pageUrlOrSlug) || String(pageUrlOrSlug || '').trim();
        if (!rawSlug) return '';
        let baseOrigin = window.location.origin;
        try {
            const parsed = new URL(pageUrlOrSlug, window.location.href);
            if (parsed.origin && !parsed.origin.startsWith('null')) baseOrigin = parsed.origin;
        } catch { }

        const slugsToTry = [
            rawSlug.replace(/\.(mp4|mkv|mov|webm|m4v|avi)$/i, ''),
            rawSlug,
        ].filter(Boolean);

        for (const slug of [...new Set(slugsToTry)]) {
            try {
                const res = await fetch(`${baseOrigin}/api/vs`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                    },
                    body: JSON.stringify({ slug }),
                    credentials: 'include',
                });
                if (!res.ok) continue;
                const data = await res.json().catch(() => null);
                if (!data) continue;
                let direct = String(data.url || '').trim();
                if (data.timestamp && (data.encrypted || !direct.startsWith('http'))) {
                    const decrypted = decryptBunkrVsUrl(direct, data.timestamp);
                    if (decrypted) direct = decrypted;
                }
                if (direct.startsWith('//')) direct = 'https:' + direct;
                if (direct && /^https?:\/\//i.test(direct) && !/preview|thumb/i.test(direct)) {
                    return direct;
                }
            } catch { }
        }
        return '';
    }

    async function resolveBunkrDirectUrl(pageUrl) {
        const viaVs = await resolveBunkrViaVs(pageUrl);
        if (viaVs) return viaVs;

        try {
            const html = document.documentElement?.innerHTML || '';
            const fromDom = extractDirectBunkrVideoUrlFromHtml(html);
            if (fromDom) {
                try { return new URL(fromDom, pageUrl).href; } catch { return fromDom; }
            }
        } catch { }

        const fetched = await bgFetchText(pageUrl).catch(() => null);
        if (fetched) {
            const fromFetch = extractDirectBunkrVideoUrlFromHtml(fetched);
            if (fromFetch) {
                try { return new URL(fromFetch, pageUrl).href; } catch { return fromFetch; }
            }
        }
        return '';
    }

    function parseBunkrDisplayedSize(boundVideo = null) {
        const overlaySelectors = '.nexus-import-overlay, .nexus-hunt-modal, .nexus-listing-player, .nexus-listing-player-modal, .nexus-batch-toolbar';
        const ignoreContainers = '.grid, .grid-item, .file-card, .theItem, .border-b.py-3.px-3, [class*="grid"], [class*="album-files"], [class*="related"], footer, nav';

        function toBytes(amountStr, unitStr) {
            const val = parseFloat(String(amountStr || '').replace(',', '.'));
            const u = String(unitStr || '').toUpperCase();
            if (!Number.isFinite(val) || val <= 0) return 0;
            const mult = { B: 1, KB: 1024, KIB: 1024, MB: 1048576, MIB: 1048576, GB: 1073741824, GIB: 1073741824, TB: 1099511627776, TIB: 1099511627776 };
            return Math.round(val * (mult[u] || 1));
        }

        function extractSize(text) {
            if (!text) return 0;
            const str = String(text).trim();
            // Ignore album total indicators like "(760.3 MB)" or "(15 files, 760.3 MB)"
            if (/^\([^)]*(?:files|items|total|\d+\s*(?:GB|MB))\)/i.test(str)) return 0;
            const m = str.match(/\b(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB)\b/i);
            if (!m) return 0;
            return toBytes(m[1], m[2]);
        }

        // Priority 1: Main media/video filename heading outside grids/overlays
        // On Bunkr, the file title is in an h1/h2 (e.g., "gymgirl.billie_video_4113909354.mp4")
        const headings = [...document.querySelectorAll('h1, h2, h3, .title, .file-name')].filter(el => {
            return !el.closest(overlaySelectors) && !el.closest(ignoreContainers);
        });

        const fileHeading = headings.find(el => {
            const t = (el.textContent || '').trim();
            return /\.(mp4|mkv|mov|webm|m4v|avi|flv|wmv|ts|zip|rar|7z)\b/i.test(t);
        }) || headings[0];

        if (fileHeading) {
            const parent = fileHeading.parentElement;
            if (parent && !parent.closest(ignoreContainers)) {
                for (const child of parent.children) {
                    if (child === fileHeading || child.closest(overlaySelectors)) continue;
                    const bytes = extractSize(child.textContent);
                    if (bytes > 0) return bytes;
                }
                const grand = parent.parentElement;
                if (grand && !grand.closest(ignoreContainers)) {
                    for (const sibling of grand.children) {
                        if (sibling === parent || sibling.closest(overlaySelectors)) continue;
                        const bytes = extractSize(sibling.textContent);
                        if (bytes > 0) return bytes;
                    }
                }
            }
        }

        // Priority 2: Look near the "Live user" / "Live users" indicator
        // Bunkr displays the file size right above or next to "1 Live user"
        const liveUserEls = [...document.querySelectorAll('*')].filter(el => {
            if (el.children.length > 2) return false;
            if (el.closest(overlaySelectors) || el.closest(ignoreContainers)) return false;
            return /\b\d+\s+Live\s+users?\b/i.test(el.textContent || '');
        });
        for (const liveEl of liveUserEls) {
            const p = liveEl.parentElement;
            if (!p || p.closest(ignoreContainers)) continue;
            for (const sibling of p.children) {
                if (sibling === liveEl || sibling.closest(overlaySelectors)) continue;
                const bytes = extractSize(sibling.textContent);
                if (bytes > 0) return bytes;
            }
            const grand = p.parentElement;
            if (grand && !grand.closest(ignoreContainers)) {
                for (const child of grand.children) {
                    if (child === p || child.closest(overlaySelectors)) continue;
                    const bytes = extractSize(child.textContent);
                    if (bytes > 0) return bytes;
                }
            }
        }

        // Priority 3: Look near the main "Download" button for this file
        const downloadBtns = [...document.querySelectorAll('a[download], a[href*="/d/"], a.btn-download, button.btn-download, a, button')].filter(el => {
            if (el.closest(overlaySelectors) || el.closest(ignoreContainers)) return false;
            const t = (el.textContent || '').trim();
            return /^Download\b/i.test(t) || el.matches('a[download], a[href*="/d/"]');
        });
        for (const btn of downloadBtns) {
            const p = btn.parentElement;
            if (!p || p.closest(ignoreContainers)) continue;
            for (const sibling of p.children) {
                if (sibling === btn || sibling.closest(overlaySelectors)) continue;
                const bytes = extractSize(sibling.textContent);
                if (bytes > 0) return bytes;
            }
            const grand = p.parentElement;
            if (grand && !grand.closest(ignoreContainers)) {
                for (const child of grand.children) {
                    if (child === p || child.closest(overlaySelectors)) continue;
                    const bytes = extractSize(child.textContent);
                    if (bytes > 0) return bytes;
                }
            }
        }

        // Priority 4: Look near the active video player element
        const v = boundVideo || document.querySelector('.nexus-import-overlay')?._boundVideo || document.querySelector('video');
        if (v) {
            let container = v.parentElement;
            for (let depth = 0; container && depth < 4; depth++, container = container.parentElement) {
                if (container.closest(ignoreContainers)) break;
                for (const sibling of container.children) {
                    if (sibling.contains(v) || sibling.closest(overlaySelectors)) continue;
                    const bytes = extractSize(sibling.textContent);
                    if (bytes > 0) return bytes;
                }
            }
        }

        // Priority 5: Fallback to standalone size elements, strictly excluding grids/albums/nav/footer
        for (const el of document.querySelectorAll('span, p, div, b, strong')) {
            if (el.closest(overlaySelectors) || el.closest(ignoreContainers)) continue;
            if (el.children.length > 2) continue;
            const text = (el.textContent || '').trim();
            if (/^\(.*\)$/.test(text)) continue;
            const m = text.match(/^(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB)$/i);
            if (m) {
                const bytes = toBytes(m[1], m[2]);
                if (bytes > 0) return bytes;
            }
        }

        return 0;
    }

    function hasPreviewLikeContext(node) {
        if (typeof isGofilePage === 'function' && isGofilePage()) return false;
        let current = node;
        for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
            // JWPlayer 8 puts `jw-keep-thumbnail` on its main `.jwplayer` container.
            const classText = String(current.className || '').replace(/\bjw-keep-thumbnail\b/gi, '');
            const text = [
                classText,
                current.id,
                current.getAttribute?.('aria-label'),
                current.getAttribute?.('title'),
                current.getAttribute?.('data-testid'),
                current.getAttribute?.('data-role'),
            ].filter(Boolean).join(' ');
            if (PREVIEW_HINT_RE.test(text)) return true;
        }
        return false;
    }

    function isLikelyHoverPreviewVideo(video) {
        if (!video) return false;
        if (typeof isGofilePage === 'function' && isGofilePage()) return false;

        // Listing thumbnails can be large, and often start before metadata exists.
        // Their card context is stronger evidence than dimensions or duration.
        if (video.closest?.('.nexus-listing-player, .nexus-listing-player-modal')) return false;
        if (video.closest?.('.mb, .video-card, .video-item, .thumb, .thumbnail, .thumb-block, [data-preview], [data-preview-url]')) return true;

        const src = [video.currentSrc, video.src, ...Array.from(video.querySelectorAll?.('source') || []).map(source => source.src)].filter(Boolean).join(' ');
        if (/(?:^|[\/_.?&=-])(?:previews?|trailers?|teasers?|thumbs?|hover|video[_-]?preview)(?:[\/_.?&=-]|$)/i.test(src)) return true;
        const rect = video.getBoundingClientRect?.() || { width: 0, height: 0 };
        const width = rect.width || video.videoWidth || video.offsetWidth || 0;
        const height = rect.height || video.videoHeight || video.offsetHeight || 0;
        const duration = Number(video.duration || 0) || 0;
        const autoplay = !!video.autoplay || video.hasAttribute?.('autoplay') === true;
        const muted = !!video.muted || !!video.defaultMuted || Number(video.volume || 1) === 0;
        const looped = !!video.loop || video.hasAttribute?.('loop') === true;
        const tinySurface = width > 0 && height > 0 && (width <= 360 || height <= 240 || (width * height) <= 120000);
        const shortClip = duration > 0 && duration <= 45;

        if (hasPreviewLikeContext(video)) return true;
        if (PREVIEW_HINT_RE.test(src)) return true;
        if (autoplay && muted && looped && (tinySurface || shortClip)) return true;
        if (autoplay && muted && tinySurface && shortClip) return true;
        if (!duration && autoplay && muted && tinySurface) return true;
        return false;
    }

    // ── HLS Variant Parser ─────────────────────────────────────────────────────

    function parseHlsVariants(m3u8Text, baseUrl) {
        const variants = [];
        const lines = m3u8Text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
            const resMatch = line.match(/RESOLUTION=(\d+x\d+)/i);
            const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
            const nameMatch = line.match(/NAME="([^"]+)"/i);
            const nextLine = (lines[i + 1] || '').trim();
            if (!nextLine || nextLine.startsWith('#')) continue;
            let varUrl = nextLine;
            try { if (!varUrl.startsWith('http')) varUrl = new URL(nextLine, baseUrl).href; } catch { }
            const height = resMatch ? parseInt(resMatch[1].split('x')[1]) : 0;
            const label = nameMatch ? nameMatch[1]
                : resMatch ? `${resMatch[1].split('x')[1]}p`
                    : bwMatch ? `${Math.round(parseInt(bwMatch[1]) / 1000)}k`
                        : 'stream';
            variants.push({ label, height, url: varUrl, bandwidth: bwMatch ? parseInt(bwMatch[1]) : 0 });
            i++;
        }
        variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
        return variants;
    }

    async function getStreamInfo(directUrl, referer, video = null) {
        if (!directUrl) return { size: null, sizeBytes: 0, variants: [], isHlsStream: false };

        if (isHls(directUrl)) {
            const text = await bgFetchText(directUrl, referer).catch(() => null);
            const variants = text ? parseHlsVariants(text, directUrl) : [];
            return { size: null, sizeBytes: 0, variants, isHlsStream: true };
        }

        // Try HEAD for MP4 or unknown
        const head = await bgFetchHead(directUrl, referer).catch(() => null);
        const ct = String(head?.contentType || '').toLowerCase();

        if (ct.includes('mpegurl') || ct.includes('x-mpegurl') || ct.includes('apple.mpegurl')) {
            const text = await bgFetchText(directUrl, referer).catch(() => null);
            const variants = text ? parseHlsVariants(text, directUrl) : [];
            return { size: null, sizeBytes: 0, variants, isHlsStream: true };
        }

        let sizeBytes = Number(head?.contentLength || 0) || 0;
        let displayedSize = false;
        if (!sizeBytes && /(^|\.)filester\.(me|gg|net|co|org|io)$/i.test(location.hostname)) {
            // File-detail size belongs to this file, unlike related-card sizes.
            const heading = [...document.querySelectorAll('h1,h2,h3')].find(el => /\.(mp4|mkv|webm|mov|m4v)\b/i.test(el.textContent || ''));
            const text = heading?.parentElement?.textContent || '';
            const match = text.match(/\b(\d+(?:[.,]\d+)?)\s*(GiB|MiB|KiB|GB|MB|KB)\b/i);
            if (match) {
                const unit = match[2].toUpperCase();
                sizeBytes = Math.round(Number(match[1].replace(',', '.')) * (unit.startsWith('G') ? 1024 ** 3 : unit.startsWith('M') ? 1024 ** 2 : 1024));
                displayedSize = true;
            }
        }
        if (isBunkrPage(referer || window.location.href)) {
            const pageSize = parseBunkrDisplayedSize(video);
            if (pageSize > 0) {
                sizeBytes = pageSize;
                displayedSize = true;
            }
        }
        const size = sizeBytes ? formatSize(sizeBytes) : null;
        return { size, sizeBytes, displayedSize, variants: [], isHlsStream: false };
    }

    async function resolveDirectUrl(video) {
        const valid = value => isPlayableStreamUrl(value) && String(value).split('#')[0] !== location.href.split('#')[0];
        if (video?.dataset?.nexusInternetChicksSelected && valid(video.currentSrc || video.src)) {
            return video.currentSrc || video.src;
        }
        if (video === _manualVideo) {
            for (const source of [video.currentSrc, video.getAttribute('src'), ...[...video.querySelectorAll('source[src]')].map(el => el.src)]) {
                if (valid(source)) return source;
            }
            // A page-wide capture or HTML fallback can belong to a different
            // feed card. Never substitute it for a deliberately selected video.
            if (!/(^|\.)filester\.(me|gg|net|co|org|io)$/i.test(location.hostname)) return '';
        }
        if (/(^|\.)filester\.(me|gg|net|co|org|io)$/i.test(location.hostname)) {
            for (const source of [video?.currentSrc, video?.getAttribute?.('src'), video?.querySelector?.('source[src]')?.src]) {
                if (valid(source)) return source;
            }
            const resolved = await new Promise(resolve => chrome.runtime.sendMessage({ action: 'FILESTER_RESOLVE_STREAM', pageUrl: location.href }, response => {
                if (chrome.runtime.lastError) return resolve(null);
                resolve(response);
            }));
            const stream = resolved?.stream_url || resolved?.streamUrl || '';
            if (valid(stream)) return stream;
        }
        // On signed FapFolder streams the current player's URL is authoritative.
        // A tab-wide capture can belong to another feed card or an expired link.
        if (/(^|\.)(?:fapfolder\.club|pixeldrain\.com)$/i.test(window.location.hostname)) {
            for (const source of [video?.currentSrc, video?.src, video?.querySelector?.('source[src]')?.src]) {
                const url = String(source || '').trim();
                if (valid(url)) return url;
            }
        }
        if (isBunkrPage(window.location.href)) {
            const bunkrDirect = await resolveBunkrDirectUrl(window.location.href).catch(() => '');
            if (bunkrDirect && !bunkrDirect.startsWith('blob:')) return bunkrDirect;
        }

        const fromBg = await new Promise(resolve =>
            chrome.runtime.sendMessage({
                action: 'GET_CAPTURED_STREAM',
                pageUrl: window.location.href,
                duration: getBestKnownDuration(video)
            }, r => resolve(String(r?.streamUrl || '').trim()))
        );
        if (valid(fromBg)) return fromBg;

        for (const src of [video?.currentSrc, video?.src, video?.querySelector?.('source[src]')?.src]) {
            const s = String(src || '').trim();
            if (valid(s)) return s;
        }

        // Meta-tag fallback: VK-mirror / KVS players (ukdevilz, sexcdn, …) expose
        // the direct MP4 in <meta> even before the jwplayer <video> exists.
        try {
            const metaSel = [
                'meta[property="ya:ovs:content_url"]',
                'meta[property="og:video:url"]',
                'meta[property="og:video:secure_url"]',
                'meta[property="og:video"]',
                'meta[itemprop="contentURL"]',
                'meta[name="twitter:player:stream"]',
            ];
            for (const sel of metaSel) {
                const c = document.querySelector(sel)?.getAttribute('content');
                const v = String(c || '').trim();
                if (v && /\.(mp4|m3u8|webm|mkv|m4v)(?:[?#]|$)/i.test(v) && !v.startsWith('blob:')) {
                    try { return new URL(v, window.location.href).href; } catch { return v; }
                }
            }
        } catch { }

        // Filester / KVS fallback: direct stream often exists in inline scripts as `video_url`
        // even when player runtime uses blob/MSE and currentSrc is not copyable.
        try {
            const html = document.documentElement?.innerHTML || '';
            const match =
                html.match(/https?:\/\/[\w.-]+\.(?:pimpbunny|fnxtube)\.com\/remote_control\.php\?[^"'<>]+/i) ||
                html.match(/\/\/[\w.-]+\.(?:pimpbunny|fnxtube)\.com\/remote_control\.php\?[^"'<>]+/i) ||
                html.match(/video_url\s*:\s*'([^']+)'/i) ||
                html.match(/["']?file["']?\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i) ||
                html.match(/https?:\/\/[^"'<>]+\/videofile\/[^"'<>]+\.mp4/i) ||
                html.match(/https?:\/\/[^"'<>]+\/get_file\/[^"'<>]+/i);
            let raw = String(match?.[1] || match?.[0] || '').trim();
            raw = raw.replace(/&amp;/g, '&');
            if (raw.startsWith('//')) raw = `https:${raw}`;
            if (raw.startsWith('function/0/')) raw = raw.slice('function/0/'.length);
            if (raw) {
                try { const url = new URL(raw, window.location.href).href; if (valid(url)) return url; } catch { }
            }
        } catch { }
        return '';
    }

    function isFileditchViewerPage(url = window.location.href) {
        try {
            return /(^|\.)(?:fileditchfiles\.(?:st|me)|fileditchvids\.st|theditch\.st|freakingfileditch\.me|blehpooffileditchvidsstuff\.org|donotsharethesetemplinksyouidiot\.st)$/i
                .test(new URL(String(url || '')).hostname);
        } catch (_) {
            return false;
        }
    }

    async function resolvePanelDirect(container, action = 'RESOLVE_DIRECT_STREAM') {
        if (container._resolvingDirect) throw new Error('Overovanie streamu už prebieha.');
        const video = container._boundVideo;
        const wasPaused = video?.paused;
        const wasMuted = video?.muted;
        const buttons = [...container.querySelectorAll('.nexus-copy-direct, .nexus-open-direct')];
        container._resolvingDirect = true;
        buttons.forEach(button => { button.disabled = true; });
        setPlayerStatus(container, 'Zachytávam a overujem aktuálny stream…');
        try {
            if (wasPaused && typeof video?.play === 'function') {
                video.muted = true;
                // Site player wrappers live in MAIN; the isolated content world
                // sees only the native method and can miss their lazy HLS setup.
                const start = await chrome.runtime.sendMessage({action:'START_DIRECT_CAPTURE',videoIndex:[...document.querySelectorAll('video')].indexOf(video)});
                if (!start?.ok) throw new Error(start?.error || 'Prehrávač sa nepodarilo spustiť.');
            }
            const nativeSources = [video?.currentSrc, video?.src, video?.querySelector?.('source[src]')?.src].filter(isPlayableStreamUrl);
            const selectedOnly = video === _manualVideo || nativeSources.length > 0;
            const candidates = nativeSources.length ? nativeSources : [container._directUrl];
            if (!selectedOnly) {
                for (const entry of performance.getEntriesByType('resource').slice(-100)) {
                    if (isPlayableStreamUrl(entry.name)) candidates.push(entry.name);
                }
            }
            const result = await chrome.runtime.sendMessage({
                action, pageUrl: location.href, candidates: [...new Set(candidates.filter(Boolean))], selectedOnly
            });
            if (!result?.ok) throw new Error(result?.error || 'Dostupná video URL sa nenašla.');
            if (container._boundVideo !== video) throw new Error('Vybrané video sa zmenilo. Skús znova.');
            container._directUrl = result.streamUrl;
            container.querySelector('.nexus-size-value').textContent = result.isHls
                ? `HLS · overené${result.height ? ` · ${result.height}p` : ''}` : 'Video URL overená';
            setPlayerStatus(container, 'Aktuálny stream overený.');
            return result;
        } catch (error) {
            setPlayerStatus(container, error.message, true);
            throw error;
        } finally {
            if (wasPaused && typeof video?.pause === 'function') { video.pause(); video.muted = wasMuted; }
            container._resolvingDirect = false;
            buttons.forEach(button => { button.disabled = false; });
        }
    }

    function isPlayableStreamUrl(url) {
        const raw = String(url || '').trim();
        if (!raw || raw.startsWith('blob:')) return false;
        if (/https?:\/\/(?:[^/]+\.)?filester\.(?:me|gg|net|co|org|io)\/d\//i.test(raw)) return false;
        if (/https?:\/\/fsc\d*\.cdn\.cr\/v\d*\//i.test(raw)) return true;
        if (/(?:pimpbunny|fnxtube)\.com\/remote_control\.php/i.test(raw)) return true;
        if (/pixeldrain\.com\/api\/file\/[a-z0-9_-]+(?:[?#]|$)/i.test(raw)) return true;
        if (/^https?:\/\/(?:www\.)?streamtape\.com\/get_video\?id=/i.test(raw)) return true;
        if (/https?:\/\/(?:[^/]+\.)?gofile\.io\/download\//i.test(raw)) return true;
        return /\.(mp4|m3u8|webm|mkv|mov|m4v|avi|mpd|ts|m2ts|ogv)(?:[?#]|$)/i.test(raw) ||
            /\/(?:get_file|video|stream|playlist|manifest)\b/i.test(raw);
    }

    let _iframeObservedVideo = null;

    chrome.runtime.onMessage.addListener(message => {
        if (message.action === 'DIRECT_STREAM_OBSERVED') {
            const overlay = document.querySelector('.nexus-import-overlay');
            if (overlay?._boundVideo && !overlay._resolvingDirect && isPlayableStreamUrl(message.url)) {
                overlay.querySelectorAll('.nexus-copy-direct, .nexus-open-direct').forEach(button => { button.disabled = false; });
                if (IS_TOP_FRAME && !overlay._directUrl) {
                    bindVideoToOverlay(overlay._boundVideo).catch(() => { });
                }
            }
            if (!IS_TOP_FRAME && isPlayableStreamUrl(message.url)) {
                const targetVideo = (_iframeObservedVideo?.isConnected ? _iframeObservedVideo : null)
                    || getBestVideo()
                    || document.querySelector('video[data-nexus-importer-active="true"]');
                if (targetVideo) {
                    relayVideoToTopFrame(targetVideo, message.url).catch(() => { });
                }
            }
            return;
        }
        if (message.action !== 'MEDIA_SIZE_OBSERVED') return;
        const container = document.querySelector('.nexus-import-overlay');
        const bytes = Number(message.sizeBytes);
        if (!container || container._directUrl !== message.url || !Number.isSafeInteger(bytes) || bytes <= 0) return;

        // If on Bunkr / balbums and we already have a site size or the reported size is a tiny chunk (< 10 MB),
        // keep the authoritative displayed size instead of corrupting it with an error body or partial range!
        if (isBunkrPage(window.location.href)) {
            const pageSize = parseBunkrDisplayedSize(container?._boundVideo);
            if (pageSize > 0) {
                container._sizeBytes = pageSize;
                container.querySelector('.nexus-size-value').textContent = `Size: ${formatSize(pageSize)} (site)`;
                return;
            }
        }

        container._sizeBytes = bytes;
        const belowMinimum = isBelowMinimumImportSize(bytes);
        container.querySelector('.nexus-size-value').textContent =
            `Size: ${formatSize(bytes)}${belowMinimum ? ' · below 10 MB minimum' : ''}`;
    });

    function isMegaFolderPage() {
        return IS_TOP_FRAME && /(^|\.)mega\.nz$/i.test(location.hostname)
            && (/\/folder\//i.test(location.href) || /#F!/.test(location.href));
    }

    function normalizeHostName(value) {
        return String(value || '').trim().toLowerCase().replace(/^www\./, '');
    }

    function isInternetChicksVideoPage() {
        return IS_TOP_FRAME && normalizeHostName(location.hostname) === 'internetchicks.com'
            && !!document.querySelector('article .button_choice_server, .entry .button_choice_server');
    }

    function isLikelySingleVideoRoute() {
        const path = String(window.location.pathname || '').toLowerCase();
        const query = String(window.location.search || '').toLowerCase();
        const host = normalizeHostName(window.location.hostname || '');
        return isInternetChicksVideoPage()
            || (host === 'leakedzone.com' && /^\/(?:[^/]+\/)?(?:video|videos|short|shorts)\/\d+\/?$/i.test(path))
            || (host === 'camwhores.tv' && /^\/videos\/\d+(?:\/|$)/i.test(path))
            || (['pimpbunny.com', 'fnxtube.com'].includes(host) && /^\/videos\/[^/]+\/?$/i.test(path))
            || (host === 'fikfok.net' && /^\/detail\/[^/]+\/?$/i.test(path))
            || (host === 'pixeldrain.com' && /^\/u\/[a-z0-9_-]+\/?$/i.test(path))
            || (host === 'pixeldrain.com' && /^\/l\/[a-z0-9_-]+\/?$/i.test(path) && /^#item=\d+(?:&|$)/i.test(window.location.hash || ''))
            || /(?:^|\/)video(?!s(?:\/|$))[^/]*(?:\/|$)/i.test(path)
            || /(?:^|\/)(?:watch|embed|player)(?:\/|$)/i.test(path)
            || /(?:^|\/)(?:v|e)\/[a-z0-9_-]{5,}(?:\/|$)/i.test(path)
            || (/(?:^|\.)(?:bunkr[a-z0-9-]*|balbums)\.[a-z.]+$/i.test(host) && /(?:^|\/)(?:f|v|d)\/[a-z0-9_-]+(?:\/|$)/i.test(path))
            || (/(?:^|\.)gofile\.io$/i.test(host) && /^\/d\/[a-z0-9_-]+/i.test(path))
            || /(?:^|[?&])(?:viewkey|video_id|vid)=/i.test(query);
    }

    function isExplicitCollectionRoute() {
        if (isLikelySingleVideoRoute()) return false;
        const host = normalizeHostName(window.location.hostname || '');
        const path = String(window.location.pathname || '').toLowerCase();
        if (/(?:^|\.)xvideos\.(?:com|red)$|(?:^|\.)eporner\.com$/i.test(host)) return true;
        if (/(?:^|\.)erome\.com$|(?:^|\.)(?:bunkr[a-z0-9-]*|balbums)\.[a-z.]+$/i.test(host)
            && /^\/(?:a|album|albums)(?:\/|$)/i.test(path)) return true;
        const route = `${window.location.pathname || ''}${window.location.search || ''}${window.location.hash || ''}`;
        return /(?:^|[\/?#&=_,.-])(?:albums?|playlists?|favorites?|favourites?|collections?|galleries?|channels?|models?|pornstars?|profiles?|members?|users?|categories?|tags?|search|results?|latest|popular|trending|most[-_]?viewed)(?:[\/?#&=_,.-]|$)/i.test(route);
    }

    function isVisiblePrimaryMediaNode(node) {
        if (!node || node.closest?.('.nexus-import-overlay, .nexus-hunt-modal')) return false;
        const rect = node.getBoundingClientRect?.() || { width: 0, height: 0 };
        const width = rect.width || node.clientWidth || node.offsetWidth || node.videoWidth || 0;
        const height = rect.height || node.clientHeight || node.offsetHeight || node.videoHeight || 0;
        if (width < 360 || height < 200 || (width * height) < 100000) return false;
        const ratio = width / Math.max(height, 1);
        if (ratio < 1.15 || ratio > 2.6) return false;
        return !hasPreviewLikeContext(node);
    }

    function hasVisiblePrimaryMediaSurface() {
        return Array.from(document.querySelectorAll('video, iframe[src], embed[src], object[data]'))
            .some(isVisiblePrimaryMediaNode);
    }

    function hasVideoCardGrid() {
        const hrefs = new Set();
        document.querySelectorAll('a[href]').forEach((anchor) => {
            const href = String(anchor.getAttribute('href') || '').trim();
            if (/(?:^|\/)(?:video(?!s(?:\/|$))[^/]*|watch|videos?\/[^/]+)(?:\/|$|[?#])/i.test(href)) hrefs.add(href);
        });
        if (hrefs.size >= 6) return true;
        return document.querySelectorAll([
            '[class*="video-card" i]', '[class*="video_item" i]', '[class*="video-item" i]',
            '[class*="thumb-block" i]', '[class*="video-thumb" i]', '[data-video-id]'
        ].join(',')).length >= 6;
    }

    function shouldSuppressFastImport() {
        if (_manualVideo?.isConnected) return false;
        if (isMegaFolderPage()) return true;
        if (isGofilePage()) {
            return !document.querySelector("video");
        }
        if (!IS_TOP_FRAME || isLikelySingleVideoRoute()) return false;
        if (hasVisiblePrimaryMediaSurface()) return false;
        return isExplicitCollectionRoute() || hasVideoCardGrid();
    }

    function hideFastImportPanel() {
        if (!_overlayEl) return;
        _overlayEl._directBindRun = (_overlayEl._directBindRun || 0) + 1;
        _overlayEl._boundVideo = null;
        _overlayEl._directUrl = '';
        _overlayEl.style.display = 'none';
        _overlayEl.classList.remove('nexus-open', 'nexus-player-active');
        const importButton = _overlayEl.querySelector('.nexus-import-btn');
        if (importButton) importButton.style.display = 'none';
        destroyOverlayPlayer(_overlayEl);
    }

    function isLenientMediaPage() {
        // Inside a sub-frame we're almost always a dedicated player embed
        // (filemoon, streamtape, hrnytube, …) — the only <video> there IS the
        // main video, so relax the size/preview heuristics that assume a busy
        // listing page. This lets embed-based sites (hornysimp/fileditch) relay.
        if (!IS_TOP_FRAME) return true;
        if (isInternetChicksVideoPage()) return true;
        try {
            const host = normalizeHostName(window.location.hostname || '');
            const knownMediaHost = /(?:^|\.)?(?:bunkr|balbums|xvideos\.com|xvideos\.red|eporner\.com|erome\.com|pixeldrain\.com|vtbe\.to|fikfok\.net)$/i.test(host);
            return (knownMediaHost && isLikelySingleVideoRoute()) || isBunkrPage(window.location.href);
        } catch {
            return isBunkrPage(window.location.href) ||
                (/xvideos\.(?:com|red)|eporner\.com|erome\.com|pixeldrain\.com|vtbe\.to|fikfok\.net/i.test(String(window.location.href || ''))
                    && isLikelySingleVideoRoute());
        }
    }

    function isVtbePage() {
        return /(?:^|\.)vtbe\.to$/i.test(window.location.hostname || '');
    }

    function makePseudoMediaCandidate(sourceUrl = '') {
        const src = String(sourceUrl || '').trim();
        return {
            dataset: {},
            duration: 0,
            currentSrc: src,
            src,
            poster: '',
            querySelector: () => null,
            closest: () => null,
            addEventListener: () => { },
            removeEventListener: () => { },
            pause: () => { },
            load: () => { },
            play: () => Promise.resolve(),
        };
    }

    function getBestLenientFallbackCandidate() {
        const pageVideo = Array.from(document.querySelectorAll('video')).find((node) => {
            if (!node || node.closest('.nexus-import-overlay')) return false;
            if (isLikelyHoverPreviewVideo(node)) return false;
            const src = String(node.currentSrc || node.src || '').trim();
            const rect = node.getBoundingClientRect?.() || { width: 0, height: 0 };
            const w = rect.width || node.clientWidth || node.offsetWidth || node.videoWidth || 0;
            const h = rect.height || node.clientHeight || node.offsetHeight || node.videoHeight || 0;
            if (!src && w < 120 && h < 90) return false;
            return true;
        });
        if (pageVideo) return pageVideo;

        const mediaNodes = Array.from(document.querySelectorAll('iframe[src], embed[src], object[data]')).filter((node) => {
            const rect = node.getBoundingClientRect?.() || { width: 0, height: 0 };
            const w = rect.width || node.clientWidth || node.offsetWidth || 0;
            const h = rect.height || node.clientHeight || node.offsetHeight || 0;
            if (w < 240 || h < 160) return false;
            return true;
        });
        if (!mediaNodes.length) return null;
        mediaNodes.sort((a, b) => {
            const ra = a.getBoundingClientRect?.() || { width: 0, height: 0 };
            const rb = b.getBoundingClientRect?.() || { width: 0, height: 0 };
            return (rb.width * rb.height) - (ra.width * ra.height);
        });
        const node = mediaNodes[0];
        const src = String(node?.src || node?.getAttribute?.('src') || node?.data || node?.getAttribute?.('data') || '').trim();
        if (!src) return null;
        return makePseudoMediaCandidate(src);
    }

    // ── Draggable Fixed Overlay ────────────────────────────────────────────────

    let _overlayEl = null;
    let _manualVideo = null;
    let _stopVideoPicker = null;

    function startVideoPicker() {
        _stopVideoPicker?.();
        const marker = document.createElement('div');
        marker.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:3px solid #00edba;background:#00edba18;box-sizing:border-box;display:none';
        document.documentElement.append(marker);
        let hovered = null;
        const findVideo = event => {
            const path = event.composedPath();
            const direct = path.find(node => node instanceof HTMLVideoElement);
            if (direct && !direct.closest('.nexus-import-overlay,.nexus-hunt-modal') && !isLikelyHoverPreviewVideo(direct)) return direct;
            return [...document.querySelectorAll('video')].filter(video => {
                if (video.closest('.nexus-import-overlay,.nexus-hunt-modal')) return false;
                if (isLikelyHoverPreviewVideo(video)) return false;
                const rect = video.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
            }).sort((a,b) => {
                const x=a.getBoundingClientRect(), y=b.getBoundingClientRect();
                return x.width*x.height-y.width*y.height;
            })[0] || null;
        };
        const move = event => {
            hovered = findVideo(event);
            marker.style.display = hovered ? 'block' : 'none';
            if (!hovered) return;
            const rect = hovered.getBoundingClientRect();
            Object.assign(marker.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        };
        const stop = () => {
            marker.remove();
            document.removeEventListener('pointermove', move, true);
            document.removeEventListener('click', click, true);
            document.removeEventListener('keydown', key, true);
            _stopVideoPicker = null;
        };
        const click = event => {
            const video = findVideo(event);
            if (!video) return;
            event.preventDefault(); event.stopImmediatePropagation();
            stop(); _manualVideo = video; _panelDismissed = false;
            bindVideoToOverlay(video).catch(error => showToast(error.message, true));
        };
        const key = event => { if (event.key === 'Escape') { stop(); showToast('Výber zrušený.'); } };
        _stopVideoPicker = stop;
        document.addEventListener('pointermove', move, true);
        document.addEventListener('click', click, true);
        document.addEventListener('keydown', key, true);
        showToast('Zamier na video a klikni. Esc zruší výber.');
    }
    let _panelDismissed = false;

    function makeDraggable(container, handle) {
        let dragging = false;
        let hasMoved = false;
        let sx = 0, sy = 0;
        let ox = 0, oy = 0;

        handle.style.cursor = 'grab';

        handle.addEventListener('mousedown', e => {
            if (e.button !== 0) return;
            dragging = true;
            hasMoved = false;
            sx = e.clientX;
            sy = e.clientY;
            const r = container.getBoundingClientRect();
            ox = r.left;
            oy = r.top;
            handle.style.cursor = 'grabbing';
            e.preventDefault();
        });

        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            const dx = e.clientX - sx;
            const dy = e.clientY - sy;
            if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
                hasMoved = true;
            }
            if (hasMoved) {
                const nx = Math.max(0, Math.min(window.innerWidth - container.offsetWidth, ox + dx));
                const ny = Math.max(0, Math.min(window.innerHeight - container.offsetHeight, oy + dy));
                container.style.left = `${nx}px`;
                container.style.top = `${ny}px`;
                container.style.right = 'auto';
                container.style.bottom = 'auto';
            }
        });

        document.addEventListener('mouseup', e => {
            if (dragging) {
                dragging = false;
                handle.style.cursor = 'grab';
                if (!hasMoved) {
                    container.classList.toggle('nexus-open');
                }
            }
        });
    }

    function getOrCreateOverlay() {
        if (_overlayEl && document.body.contains(_overlayEl)) return _overlayEl;

        const container = document.createElement('div');
        container.className = 'nexus-import-overlay nexus-fixed';
        container.style.display = 'none'; // Hidden by default
        container.innerHTML = `
            <div class="nexus-import-btn" style="display: none;">
                <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                <span class="nexus-btn-label">Import to Nexus</span>
                <span class="nexus-drag-hint" title="Drag to move">⠿</span>
            </div>
            <div class="nexus-port-menu">
                <div class="nexus-stream-meta">
                    <span class="nexus-size-value">Scanning...</span>
                    <span class="nexus-duration-value">Duration: unknown</span>
                    <span class="nexus-quality-state" role="status" aria-live="polite">Hľadám najvyššiu kvalitu…</span>
                    <button type="button" class="nexus-mini-btn nexus-quality-find" title="Spusti prehrávanie a over najvyššiu funkčnú kvalitu">Nájsť najvyššiu</button>
                </div>
                <div class="nexus-quality-list"></div>
                <button type="button" class="nexus-hunt-btn" title="Nájdi iné verzie klipu a porovnaj ich rozlíšenie">Nájsť iné verzie</button>
                <div class="nexus-hunt-panel" hidden>
                    <div class="nexus-hunt-head">
                        <div class="nexus-hunt-status" role="status" aria-live="polite">Čakám…</div>
                        <button type="button" class="nexus-mini-btn nexus-hunt-stop" hidden>Zastaviť</button>
                        <button type="button" class="nexus-mini-btn nexus-hunt-popout" title="Otvoriť porovnanie a všetky výsledky">Porovnanie</button>
                        <button type="button" class="nexus-mini-btn nexus-hunt-expand" hidden title="Zväčšiť výsledky">Zväčšiť</button>
                        <button type="button" class="nexus-mini-btn nexus-hunt-collapse" title="Skryť výsledky">✕</button>
                    </div>
                    <div class="nexus-hunt-reference"></div>
                    <details class="nexus-hunt-options">
                        <summary>Upresniť hľadanie</summary>
                        <label>Hľadanie <select class="nexus-hunt-mode"><option value="quick">Rýchle</option><option value="deep">Dôkladné</option></select></label>
                        <label>Kľúčové slová <input class="nexus-hunt-keywords" name="manual_keywords" type="text" maxlength="300" autocomplete="off" placeholder="napr. office, massage, cosplay"></label>
                        <label>Účinkujúci <input class="nexus-hunt-performer" name="performer" type="text" maxlength="120" autocomplete="off" placeholder="meno alebo prezývka"></label>
                        <label><input type="checkbox" class="nexus-hunt-visual"> Obrazové hľadanie (Vision + Yandex)</label>
                        <label><input type="checkbox" class="nexus-hunt-visual-only"> Len podľa náhľadu</label>
                        <button type="button" class="nexus-mini-btn nexus-hunt-retry">Hľadať znova</button>
                    </details>
                    <details class="nexus-hunt-diagnostics" hidden><summary>Zdroje a priebeh</summary><div></div></details>
                    <div class="nexus-hunt-relevance"></div>
                    <div class="nexus-hunt-groups"></div>
                </div>
                <div class="nexus-direct-actions">
                    <button class="nexus-mini-btn nexus-copy-direct" disabled>Copy Direct URL</button>
                    <button class="nexus-mini-btn nexus-open-direct" disabled>Open Direct</button>
                    <button class="nexus-mini-btn nexus-send-sidecar" title="Send this video or MEGA album to Vertical Video Sidecar">Sidecar</button>
                </div>
                <button class="nexus-idm-btn" disabled>⬇ Download (IDM)</button>
                <div class="nexus-ports-header">Import to port:</div>
                <div class="nexus-port-opt" data-port="8000">Port 8000 <span>MAIN</span></div>
                <div class="nexus-port-opt" data-port="8001">Port 8001 <span>ALT</span></div>
                <div class="nexus-port-opt" data-port="8002">Port 8002 <span>ALT</span></div>
                <div class="nexus-panel-footer">
                    <button class="nexus-mini-btn nexus-close-panel" title="Skryť celý panel">ZAVRIEŤ (X)</button>
                </div>
                <div class="nexus-player-card">
                    <div class="nexus-player-toolbar">
                        <span>Live player</span>
                        <div class="nexus-player-actions">
                            <button class="nexus-icon-btn nexus-play-direct" disabled title="Play captured direct stream">▶</button>
                            <button class="nexus-icon-btn nexus-pip-player" disabled title="Picture in Picture - floating above Chrome">▣</button>
                            <button class="nexus-icon-btn nexus-fullscreen-player" disabled title="Fullscreen player">⛶</button>
                        </div>
                    </div>
                    <div class="nexus-player-stage">
                        <video class="nexus-live-video" controls playsinline></video>
                        <div class="nexus-player-status">Waiting for direct stream...</div>
                    </div>
                    <div class="nexus-player-controls">
                        <label>Zoom <input class="nexus-player-range" data-filter="zoom" type="range" min="1" max="3" step="0.05" value="1"></label>
                        <label>Jas <input class="nexus-player-range" data-filter="brightness" type="range" min="0.45" max="1.8" step="0.05" value="1"></label>
                        <label>Kontrast <input class="nexus-player-range" data-filter="contrast" type="range" min="0.45" max="2" step="0.05" value="1"></label>
                        <label>Saturácia <input class="nexus-player-range" data-filter="saturation" type="range" min="0" max="2.4" step="0.05" value="1"></label>
                        <label>Gamma <input class="nexus-player-range" data-filter="gamma" type="range" min="0.45" max="2.2" step="0.05" value="1"></label>
                        <label>Zaostrenie <input class="nexus-player-range" data-filter="sharpen" type="range" min="0" max="1.8" step="0.05" value="0"></label>
                        <button class="nexus-mini-btn nexus-player-reset" type="button">Reset obraz</button>
                    </div>
                </div>
            </div>
        `;

        for (const eventType of ['click', 'auxclick', 'dblclick', 'contextmenu']) {
            container.addEventListener(eventType, event => event.stopPropagation());
        }
        document.body.appendChild(container);
        const importBtn = container.querySelector('.nexus-import-btn');
        makeDraggable(container, importBtn);

        // Auto-fade logic for the button if not opened
        let fadeTimer = null;
        function startFadeTimer() {
            if (container.classList.contains('nexus-open')) return;
            fadeTimer = setTimeout(() => {
                if (!container.classList.contains('nexus-open')) {
                    container.style.display = 'none';
                }
            }, 5000);
        }
        container.addEventListener('mouseenter', () => clearTimeout(fadeTimer));
        container.addEventListener('mouseleave', () => startFadeTimer());

        const pickerControls = document.createElement('div');
        pickerControls.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
        pickerControls.innerHTML = '<button type="button" class="nexus-mini-btn nexus-pick-video">Vybrať video</button><button type="button" class="nexus-mini-btn nexus-refresh-video">Obnoviť údaje</button><button type="button" class="nexus-mini-btn nexus-auto-video">Automaticky</button><span class="nexus-picked-label" role="status"></span>';
        container.querySelector('.nexus-size-value').parentElement.append(pickerControls);
        container.querySelector('.nexus-quality-find').addEventListener('click', event => {
            event.stopPropagation();
            requestHighestQuality(container, true);
        });
        pickerControls.querySelector('.nexus-pick-video').onclick = startVideoPicker;
        pickerControls.querySelector('.nexus-refresh-video').onclick = () => {
            const video = _manualVideo?.isConnected ? _manualVideo : container._boundVideo;
            if (video) bindVideoToOverlay(video).catch(error => showToast(error.message, true));
        };
        pickerControls.querySelector('.nexus-auto-video').onclick = () => { _manualVideo = null; pickerControls.querySelector('.nexus-picked-label').textContent = ''; scheduleScan(); };

        container.querySelector('.nexus-copy-direct').onclick = async e => {
            e.stopPropagation();
            try {
                const result = await resolvePanelDirect(container);
                await navigator.clipboard.writeText(result.streamUrl);
                showToast('Skopírovaná aktuálna overená video URL.');
            } catch (error) { showToast(error.message, true); }
        };

        container.querySelector('.nexus-open-direct').onclick = async e => {
            e.stopPropagation();
            try {
                await resolvePanelDirect(container, 'OPEN_DIRECT_PLAYER');
                showToast('Video otvorené v samostatnom prehrávači.');
            } catch (error) { showToast(error.message, true); }
        };

        container.querySelector('.nexus-send-sidecar').onclick = e => {
            e.stopPropagation();
            sendCurrentToSidecar(container._boundVideo, container._directUrl);
        };

        container.querySelector('.nexus-idm-btn').onclick = e => {
            e.stopPropagation();
            const url = container._directUrl || '';
            if (!url) return showToast('No direct URL available.', true);
            const title = (document.title || 'video').split(' - ')[0].trim().replace(/[\\/:*?"<>|]/g, '_');
            chrome.runtime.sendMessage({ action: 'DOWNLOAD_WITH_IDM', url, filename: title }, res => {
                if (res?.ok) showToast('IDM download started!');
                else showToast(`IDM error: ${res?.error || 'unknown'}`, true);
            });
        };

        const huntBtn = container.querySelector('.nexus-hunt-btn');
        container.querySelector('.nexus-hunt-retry').onclick = () => startQualityHunt(container, { force_refresh: true }).catch(err => showToast(err.message, true));
        container.querySelector('.nexus-hunt-stop').onclick = () => stopQualityHunt(container);
        if (huntBtn) {
            huntBtn.onclick = e => {
                e.stopPropagation();
                // An explicit click means "search again". Bypass the short
                // degraded-result cache so a second/third attempt gets fresh
                // provider responses instead of replaying the same 0-result.
                startQualityHunt(container, { force_refresh: true }).catch(err => {
                    showToast(`Lov zlyhal: ${err?.message || err}`, true);
                });
            };
        }
        const collapseBtn = container.querySelector('.nexus-hunt-collapse');
        if (collapseBtn) {
            collapseBtn.onclick = e => {
                e.stopPropagation();
                const panel = container.querySelector('.nexus-hunt-panel');
                if (panel) {
                    panel.hidden = true;
                    panel.style.display = 'none';
                }
                container.classList.remove('nexus-hunting');
                container.classList.remove('nexus-hunt-expanded');
                // Hiding results does not cancel a running job.
            };
        }
        const expandBtn = container.querySelector('.nexus-hunt-expand');
        if (expandBtn) {
            expandBtn.onclick = e => {
                e.stopPropagation();
                container.classList.toggle('nexus-hunt-expanded');
                expandBtn.textContent = container.classList.contains('nexus-hunt-expanded') ? 'Zmenšiť' : 'Zväčšiť';
            };
        }
        const popBtn = container.querySelector('.nexus-hunt-popout');
        if (popBtn) {
            popBtn.onclick = e => {
                e.stopPropagation();
                openHuntModal(container);
            };
        }

        container.querySelectorAll('.nexus-port-opt').forEach(opt => {
            opt.onclick = e => {
                e.stopPropagation();
                container.querySelectorAll('.nexus-port-opt').forEach(item => item.classList.remove('is-selected'));
                opt.classList.add('is-selected');
                handleImport(container._boundVideo, opt.dataset.port, container._directUrl);
            };
        });

        container.querySelector('.nexus-close-panel').onclick = e => {
            e.stopPropagation();
            _panelDismissed = true;
            destroyOverlayPlayer(container);
            container.classList.remove('nexus-open');
            container.classList.remove('nexus-player-active');
            container.style.display = 'none';
        };

        wirePlayerControls(container);

        _overlayEl = container;
        return container;
    }

    function getPlayerState(container) {
        if (!container._playerState) {
            container._playerState = {
                hls: null,
                url: '',
                filterId: `nexus-player-filter-${Math.random().toString(36).slice(2)}`,
                filters: { ...PLAYER_FILTER_DEFAULTS },
            };
        }
        return container._playerState;
    }

    function ensureSvgPlayerFilter(container) {
        const state = getPlayerState(container);
        let svg = container.querySelector('.nexus-player-svg-filter');
        if (!svg) {
            svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('class', 'nexus-player-svg-filter');
            svg.setAttribute('width', '0');
            svg.setAttribute('height', '0');
            svg.innerHTML = `
                <filter id="${state.filterId}" color-interpolation-filters="sRGB">
                    <feComponentTransfer result="gamma">
                        <feFuncR type="gamma" exponent="1"></feFuncR>
                        <feFuncG type="gamma" exponent="1"></feFuncG>
                        <feFuncB type="gamma" exponent="1"></feFuncB>
                    </feComponentTransfer>
                    <feConvolveMatrix class="nexus-sharpen-kernel" in="gamma" order="3" preserveAlpha="true" kernelMatrix="0 0 0 0 1 0 0 0 0"></feConvolveMatrix>
                </filter>
            `;
            container.appendChild(svg);
        }
        return svg;
    }

    function applyPlayerFilters(container) {
        const state = getPlayerState(container);
        const video = container.querySelector('.nexus-live-video');
        if (!video) return;
        const svg = ensureSvgPlayerFilter(container);
        const gamma = Math.max(0.45, Math.min(2.2, Number(state.filters.gamma || 1)));
        svg.querySelectorAll('feFuncR, feFuncG, feFuncB').forEach(fn => fn.setAttribute('exponent', String(gamma)));

        const sharp = Math.max(0, Math.min(1.8, Number(state.filters.sharpen || 0)));
        const kernel = `0 ${-sharp} 0 ${-sharp} ${1 + 4 * sharp} ${-sharp} 0 ${-sharp} 0`;
        svg.querySelector('.nexus-sharpen-kernel')?.setAttribute('kernelMatrix', kernel);

        const panX = Number(state.filters.panX || 0);
        const panY = Number(state.filters.panY || 0);
        const zoom = Number(state.filters.zoom || 1);

        video.style.transform = `scale(${zoom.toFixed(2)}) translate(${panX}px, ${panY}px)`;
        video.style.filter = [
            `brightness(${Number(state.filters.brightness || 1).toFixed(2)})`,
            `contrast(${Number(state.filters.contrast || 1).toFixed(2)})`,
            `saturate(${Number(state.filters.saturation || 1).toFixed(2)})`,
            `url(#${state.filterId})`,
        ].join(' ');
    }

    function setPlayerStatus(container, text, isError = false) {
        const status = container.querySelector('.nexus-player-status');
        if (!status) return;
        status.textContent = text;
        status.classList.toggle('nexus-error', !!isError);
    }

    function destroyOverlayPlayer(container) {
        const state = getPlayerState(container);
        const video = container.querySelector('.nexus-live-video');
        if (state.hls) {
            state.hls.destroy();
            state.hls = null;
        }
        if (video) {
            video._huntToken = (video._huntToken || 0) + 1;
            video.pause();
            video.removeAttribute('src');
            video.load();
        }
        state.url = '';
    }

    function setPlayerButtonsEnabled(container, enabled) {
        ['.nexus-play-direct', '.nexus-pip-player', '.nexus-fullscreen-player'].forEach(selector => {
            const btn = container.querySelector(selector);
            if (btn) btn.disabled = !enabled;
        });
    }

    function wirePlayerControls(container) {
        container.querySelector('.nexus-play-direct').onclick = e => {
            e.stopPropagation();
            initOverlayPlayer(container, container._directUrl);
        };
        container.querySelector('.nexus-pip-player').onclick = async e => {
            e.stopPropagation();
            const video = container.querySelector('.nexus-live-video');
            if (!video) return;
            try {
                if (document.pictureInPictureElement) await document.exitPictureInPicture();
                else if (document.pictureInPictureEnabled) await video.requestPictureInPicture();
            } catch {
                showToast('Picture-in-Picture sa nepodaril spustiť.', true);
            }
        };
        container.querySelector('.nexus-fullscreen-player').onclick = e => {
            e.stopPropagation();
            // Request fullscreen on the WHOLE menu area to keep controls visible
            const menu = container.querySelector('.nexus-port-menu');
            if (menu?.requestFullscreen) {
                menu.requestFullscreen().catch(() => {
                    // Fallback to stage if menu fails
                    container.querySelector('.nexus-player-stage')?.requestFullscreen().catch(() => { });
                });
            }
        };
        container.querySelector('.nexus-player-reset').onclick = e => {
            e.stopPropagation();
            const state = getPlayerState(container);
            state.filters = { ...PLAYER_FILTER_DEFAULTS };
            container.querySelectorAll('.nexus-player-range').forEach(input => {
                input.value = String(state.filters[input.dataset.filter] ?? 1);
            });
            applyPlayerFilters(container);
        };
        container.querySelectorAll('.nexus-player-range').forEach(input => {
            input.addEventListener('input', e => {
                e.stopPropagation();
                const state = getPlayerState(container);
                state.filters[input.dataset.filter] = Number(input.value);
                applyPlayerFilters(container);
            });
        });
        const stage = container.querySelector('.nexus-player-stage');

        // Panning logic
        let isPanning = false;
        let lastX = 0, lastY = 0;

        stage?.addEventListener('mousedown', e => {
            const state = getPlayerState(container);
            if (state.filters.zoom > 1 && e.button === 0) {
                isPanning = true;
                lastX = e.clientX;
                lastY = e.clientY;
                stage.style.cursor = 'move';
                e.preventDefault();
            }
        });

        document.addEventListener('mousemove', e => {
            if (!isPanning) return;
            const state = getPlayerState(container);
            const dx = e.clientX - lastX;
            const dy = e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;

            // Adjust pan based on zoom (inverted or direct? usually direct for "dragging" the content)
            state.filters.panX = (state.filters.panX || 0) + (dx / state.filters.zoom);
            state.filters.panY = (state.filters.panY || 0) + (dy / state.filters.zoom);
            applyPlayerFilters(container);
        });

        document.addEventListener('mouseup', () => {
            if (isPanning) {
                isPanning = false;
                stage.style.cursor = 'default';
            }
        });

        stage?.addEventListener('wheel', e => {
            if (!e.ctrlKey && !e.shiftKey) return; // Allow normal scroll unless modified
            e.preventDefault();
            const state = getPlayerState(container);
            const oldZoom = state.filters.zoom || 1;
            state.filters.zoom = Math.max(1, Math.min(5, oldZoom + (e.deltaY < 0 ? 0.15 : -0.15)));

            const zoomInput = container.querySelector('.nexus-player-range[data-filter="zoom"]');
            if (zoomInput) zoomInput.value = String(state.filters.zoom);

            // Reset pan if zoom is 1
            if (state.filters.zoom <= 1) {
                state.filters.panX = 0;
                state.filters.panY = 0;
            }

            applyPlayerFilters(container);
        }, { passive: false });

        // Keyboard 'O' toggle and Auto-hide
        let controlsVisible = true;
        let hideTimer = null;

        function showControls() {
            controlsVisible = true;
            container.querySelector('.nexus-player-controls').style.display = 'grid';
            container.querySelector('.nexus-player-toolbar').style.opacity = '1';
            resetHideTimer();
        }

        function toggleControls() {
            if (controlsVisible) {
                container.querySelector('.nexus-player-controls').style.display = 'none';
                container.querySelector('.nexus-player-toolbar').style.opacity = '0';
                controlsVisible = false;
            } else {
                showControls();
            }
        }

        function resetHideTimer() {
            clearTimeout(hideTimer);
            if (document.fullscreenElement) {
                hideTimer = setTimeout(() => {
                    if (controlsVisible && document.fullscreenElement) toggleControls();
                }, 3000);
            }
        }

        document.addEventListener('keydown', e => {
            if (e.key.toLowerCase() === 'o') {
                toggleControls();
            }
        });

        container.addEventListener('mousemove', () => {
            if (!controlsVisible) showControls();
            else resetHideTimer();
        });
    }

    function initOverlayPlayer(container, requestedUrl) {
        const url = String(requestedUrl || container._directUrl || '').trim();
        const video = container.querySelector('.nexus-live-video');
        if (!video || !url) return showToast('No direct stream to play yet.', true);

        const state = getPlayerState(container);
        container.classList.add('nexus-player-active');
        setPlayerStatus(container, 'Loading stream...');
        setPlayerButtonsEnabled(container, true);
        applyPlayerFilters(container);

        if (state.hls) {
            state.hls.destroy();
            state.hls = null;
        }
        video.pause();
        video.removeAttribute('src');
        video.load();
        state.url = url;

        const isHlsStream = isHls(url);
        if (isHlsStream && typeof Hls !== 'undefined' && Hls.isSupported()) {
            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: true,
                backBufferLength: 60,
            });
            state.hls = hls;
            hls.loadSource(url);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                setPlayerStatus(container, 'Live link connected');
                video.play().catch(() => setPlayerStatus(container, 'Click play in the player'));
            });
            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data?.fatal) setPlayerStatus(container, `Stream error: ${data.type || 'HLS'}`, true);
            });
        } else {
            video.src = url;
            video.load();
            video.play().catch(() => setPlayerStatus(container, 'Click play in the player'));
        }

        video.onloadeddata = () => setPlayerStatus(container, 'Live link connected');
        video.onerror = () => setPlayerStatus(container, 'Browser could not play this stream. Try Open Direct or PiP after reload.', true);
    }

    async function bindVideoToOverlay(video, skipQualitySearch = false) {
        if (isLikelyHoverPreviewVideo(video)) return false;
        if (_manualVideo && !_manualVideo.isConnected) _manualVideo = null;
        if (_manualVideo && video !== _manualVideo) return false;
        if (video?.closest?.('.nexus-import-overlay, .nexus-hunt-modal')) return;
        if (IS_TOP_FRAME && shouldSuppressFastImport()) {
            hideFastImportPanel();
            return false;
        }
        const container = getOrCreateOverlay();
        const replacingVideo = container._boundVideo !== video;
        const bindRun = (container._directBindRun || 0) + 1;
        container._directBindRun = bindRun;
        container._boundVideo = video;
        updateImportDuration(container);
        if (!skipQualitySearch) requestHighestQuality(container);
        container._directUrl = '';
        container._sizeBytes = 0;
        container.querySelector('.nexus-picked-label').textContent = _manualVideo ? `Pripnuté video · ${video.id || `${Math.round(getBestKnownDuration(video))} s`}` : '';
        if (replacingVideo) {
            container._directUrl = '';
            container.style.display = 'none';
            container.classList.remove('nexus-open');
            const importButton = container.querySelector('.nexus-import-btn');
            if (importButton) importButton.style.display = 'none';
        }

        const sizeEl = container.querySelector('.nexus-size-value');
        const qualityEl = container.querySelector('.nexus-quality-state');
        if (qualityEl) paintVideoQuality(qualityEl, video);
        const qualList = container.querySelector('.nexus-quality-list');
        const copyBtn = container.querySelector('.nexus-copy-direct');
        const openBtn = container.querySelector('.nexus-open-direct');
        const idmBtn = container.querySelector('.nexus-idm-btn');

        sizeEl.textContent = 'Scanning...';
        qualList.innerHTML = '';
        copyBtn.disabled = true;
        openBtn.disabled = true;
        idmBtn.disabled = true;
        setPlayerButtonsEnabled(container, false);
        setPlayerStatus(container, 'Waiting for direct stream...');

        const directUrl = await resolveDirectUrl(video);
        if (container._directBindRun !== bindRun || container._boundVideo !== video) return false;
        if (IS_TOP_FRAME && shouldSuppressFastImport()) {
            hideFastImportPanel();
            return false;
        }
        if (!directUrl) {
            sizeEl.textContent = 'URL not resolved';
            // These actions can start the site player and capture its first request.
            copyBtn.disabled = false;
            openBtn.disabled = false;
            if (/(^|\.)filester\.(me|gg|net|co|org|io)$/i.test(location.hostname)) {
                const heading = [...document.querySelectorAll('h1,h2,h3')].find(el => /\.(mp4|mkv|webm|mov|m4v)\b/i.test(el.textContent || ''));
                const match = (heading?.parentElement?.textContent || '').match(/\b(\d+(?:[.,]\d+)?)\s*(GiB|MiB|KiB|GB|MB|KB)\b/i);
                if (match) sizeEl.textContent = `Size: ${match[1]} ${match[2]} (site)`;
            } else if (isBunkrPage(window.location.href)) {
                const pageSize = parseBunkrDisplayedSize(video);
                if (pageSize > 0) {
                    container._sizeBytes = pageSize;
                    sizeEl.textContent = `Size: ${formatSize(pageSize)} (site)`;
                }
            }
            setPlayerStatus(container, 'Start the site video to capture its direct stream.');
            container.style.display = 'flex';
            container.classList.add('nexus-open');
            const trigger = container.querySelector('.nexus-import-btn');
            if (trigger) trigger.style.display = 'flex';
            return false;
        }
        container._directUrl = directUrl;
        container._sizeBytes = 0;
        const sourcePageUrl = video?.dataset?.nexusFramePageUrl || window.location.href;
        copyBtn.disabled = false;
        openBtn.disabled = false;
        idmBtn.disabled = false;
        setPlayerButtonsEnabled(container, isPlayableStreamUrl(directUrl));

        const referer = sourcePageUrl;
        const info = await getStreamInfo(directUrl, referer, video);
        if (container._directBindRun !== bindRun || container._boundVideo !== video) return false;
        if (IS_TOP_FRAME && shouldSuppressFastImport()) {
            hideFastImportPanel();
            return false;
        }

        if (info.isHlsStream) {
            if (info.variants.length > 0) {
                sizeEl.textContent = `HLS · ${info.variants.length} ${info.variants.length === 1 ? 'quality' : 'qualities'}`;
                info.variants.forEach(v => {
                    const el = document.createElement('div');
                    el.className = 'nexus-quality-item';
                    el.innerHTML = `<span class="nexus-q-label">${v.label}</span><div class="nexus-q-actions"><button class="nexus-q-play" data-url="${v.url}">Play</button><button class="nexus-q-copy" data-url="${v.url}">Copy</button></div>`;
                    el.querySelector('.nexus-q-play').onclick = ev => {
                        ev.stopPropagation();
                        container._directUrl = v.url;
                        initOverlayPlayer(container, v.url);
                    };
                    el.querySelector('.nexus-q-copy').onclick = async ev => {
                        ev.stopPropagation();
                        try { await navigator.clipboard.writeText(v.url); showToast(`Copied ${v.label}`); }
                        catch { showToast('Copy failed.', true); }
                    };
                    qualList.appendChild(el);
                });
                // Best quality becomes the default direct URL
                container._directUrl = info.variants[0].url;
                setPlayerButtonsEnabled(container, true);
                copyBtn.title = `Copy best quality (${info.variants[0].label})`;
            } else {
                sizeEl.textContent = 'HLS stream';
            }
        } else {
            container._sizeBytes = info.sizeBytes || container._sizeBytes || 0;
            const belowMinimum = isBelowMinimumImportSize(container._sizeBytes);
            sizeEl.textContent = container._sizeBytes
                ? `Size: ${formatSize(container._sizeBytes)}${info.displayedSize ? ' (site)' : ''}${belowMinimum ? ' · below 10 MB minimum' : ''}`
                : 'Size: unknown';
        }
        container.style.display = 'flex';
        container.classList.add('nexus-open');
        const importButton = container.querySelector('.nexus-import-btn');
        if (importButton) importButton.style.display = 'flex';
        return true;
    }

    async function relayVideoToTopFrame(video, observedUrl = '') {
        if (!video || video._relayInFlight) return;
        video._relayInFlight = true;
        // Resolve the direct stream URL here (we have the iframe's document +
        // referer) then hand it to the top frame, which owns the visible panel.
        try {
            let directUrl = await resolveDirectUrl(video);
            const fallbackUrl = String(observedUrl || '').trim();
            if (isPlayableStreamUrl(fallbackUrl) && (!isPlayableStreamUrl(directUrl) || (/master/i.test(fallbackUrl) && !/master/i.test(directUrl)))) {
                directUrl = fallbackUrl;
            }
            if (!isPlayableStreamUrl(directUrl)) return;
            if (video.dataset.nexusRelayedUrl === directUrl) return;
            video.dataset.nexusRelayedUrl = directUrl;
            const payload = {
                type: NEXUS_IFRAME_MSG,
                directUrl,
                duration: getBestKnownDuration(video),
                poster: video?.poster || findThumbnail(video) || '',
                pageUrl: (() => { try { return window.top.location.href; } catch { return ''; } })(),
                framePageUrl: window.location.href,
                referer: window.location.href,
            };
            console.log('Nexus: relaying iframe video to top frame →', directUrl.slice(0, 80));
            window.top.postMessage(payload, '*');
        } catch (_) { /* cross-origin top or resolve failed — ignore */ }
        finally {
            video._relayInFlight = false;
        }
    }

    function createOverlay(video) {
        if (isLikelyHoverPreviewVideo(video)) return;
        if (video?.closest?.('.nexus-import-overlay, .nexus-hunt-modal')) return;
        if (IS_TOP_FRAME && shouldSuppressFastImport()) {
            hideFastImportPanel();
            return;
        }
        if (video.dataset.nexusImporterActive) return;
        video.dataset.nexusImporterActive = 'true';

        // Inside a player iframe → don't build a clipped/invisible panel here;
        // relay the stream up to the top frame which shows the real panel.
        // Embed players (e.g. Vidara/JWPlayer) often mount <video> pre-play with
        // no stream yet, so keep retrying when playback/metadata starts.
        if (!IS_TOP_FRAME) {
            _iframeObservedVideo = video;
            if (typeof video.addEventListener === 'function') {
                const retryIfNotRelayed = () => {
                    if (!video.dataset.nexusRelayedUrl) {
                        relayVideoToTopFrame(video).catch(() => { });
                    }
                };
                video.addEventListener('playing', () => relayVideoToTopFrame(video).catch(() => { }));
                video.addEventListener('loadedmetadata', retryIfNotRelayed);
                video.addEventListener('canplay', retryIfNotRelayed);
            }
            relayVideoToTopFrame(video);
            return;
        }

        // If user dismissed the panel, silently bind video but don't re-show
        if (_panelDismissed) {
            bindVideoToOverlay(video).catch(() => { });
            return;
        }

        console.log("Nexus: Main video detected; waiting for its direct URL.");
        bindVideoToOverlay(video).catch(() => { });
        video.addEventListener('playing', () => bindVideoToOverlay(video).catch(() => { }), { once: true });
        video.addEventListener('loadedmetadata', () => {
            if (_overlayEl?._boundVideo === video) {
                const qEl = _overlayEl.querySelector('.nexus-quality-state');
                if (qEl) paintVideoQuality(qEl, video);
            }
            bindVideoToOverlay(video).catch(() => { });
        }, { once: true });
        video.addEventListener('durationchange', () => {
            if (_overlayEl?._boundVideo === video) updateImportDuration(_overlayEl);
        });

    }

    // ── Quality Hunt ───────────────────────────────────────────────────────────

    function collectBestTitle(video) {
        if (isGofilePage()) {
            const dialogTitle = video?.closest?.('[data-dialog]')?.querySelector?.('header h2')?.textContent?.trim()
                || document.querySelector('[data-dialog] header h2')?.textContent?.trim()
                || document.querySelector('#fm-file-preview')?.parentElement?.querySelector('h1, h2')?.textContent?.trim();
            if (dialogTitle && dialogTitle.length > 2) return dialogTitle;
        }
        const local = video?.getAttribute?.('data-title') || video?.getAttribute?.('title');
        if (local?.trim().length > 4) return local.trim();
        // Prefer download/filename-looking labels, then og:title, h1, JSON-LD, document.title
        const downloadBtn = document.querySelector(
            'a[download], a[href*="download" i], button[class*="download" i], a[class*="download" i]'
        );
        const dlText = (downloadBtn?.getAttribute('download') || downloadBtn?.textContent || '').trim();
        if (dlText && dlText.length > 8 && /\.(mp4|mkv|webm)/i.test(dlText)) return dlText;

        const og = document.querySelector('meta[property="og:title"]')?.content?.trim();
        if (og && og.length > 4) return og;

        const h1 = document.querySelector('h1')?.textContent?.trim();
        if (h1 && h1.length > 4) return h1;

        try {
            for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
                const data = JSON.parse(script.textContent || '');
                const nodes = Array.isArray(data) ? data : [data];
                for (const node of nodes) {
                    const type = String(node?.['@type'] || '');
                    if (/VideoObject/i.test(type) && node?.name) return String(node.name).trim();
                }
            }
        } catch (_) { /* ignore */ }

        const rawTitle = String(document.title || '').trim();
        const cleaned = rawTitle.replace(/\s*(?:-|\|)\s*(?:Bunkr|Balbums|MEGA|Gofile)\b.*$/i, '').trim();
        const stripped = (cleaned || rawTitle).replace(/^Gofile\s*(?:—|-|\|)\s*/i, "").trim();
        return stripped || "video";
    }

    function isCanvasBlankOrBlack(canvas, ctx) {
        try {
            const w = Math.min(32, canvas.width), h = Math.min(32, canvas.height);
            if (!w || !h) return true;
            const data = ctx.getImageData(0, 0, w, h).data;
            let sum = 0, samples = 0;
            for (let i = 0; i < data.length; i += 16) {
                sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
                samples++;
            }
            return samples > 0 && (sum / samples) < 3.5;
        } catch (_) {
            return false;
        }
    }

    function captureVideoFrameJpeg(video, quality = 0.76) {
        try {
            if (!video || !video.videoWidth || !video.videoHeight) return null;
            const canvas = document.createElement('canvas');
            const maxW = 640;
            const scale = Math.min(1, maxW / video.videoWidth);
            canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
            canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', quality);
            // Tainted canvas throws on toDataURL in some browsers; empty if so
            if (!dataUrl || dataUrl.length < 200) return null;
            if (isCanvasBlankOrBlack(canvas, ctx)) return null;
            return dataUrl;
        } catch (_) {
            return null;
        }
    }

    function loadDataUrlImage(dataUrl) {
        return new Promise(resolve => {
            if (!dataUrl || !String(dataUrl).startsWith('data:image/')) return resolve(null);
            const img = new Image();
            const timer = setTimeout(() => resolve(null), 2000);
            img.onload = () => { clearTimeout(timer); resolve(img); };
            img.onerror = () => { clearTimeout(timer); resolve(null); };
            img.src = dataUrl;
        });
    }

    async function captureVideoViaVisibleTab(video, container) {
        try {
            if (!video || !video.isConnected) return null;
            const rect = video.getBoundingClientRect();
            const left = Math.max(0, rect.left);
            const top = Math.max(0, rect.top);
            const right = Math.min(window.innerWidth, rect.right);
            const bottom = Math.min(window.innerHeight, rect.bottom);
            const visW = right - left, visH = bottom - top;
            if (visW < 80 || visH < 60) return null;

            const modal = document.querySelector('.nexus-hunt-modal');
            const prevOverlayVis = container ? container.style.visibility : '';
            const prevModalVis = modal ? modal.style.visibility : '';
            if (container) container.style.visibility = 'hidden';
            if (modal) modal.style.visibility = 'hidden';
            await new Promise(r => requestAnimationFrame(() => setTimeout(r, 15)));
            let res;
            try {
                res = await huntMessage({ action: 'CAPTURE_VISIBLE_TAB' }, 2500);
            } finally {
                if (container) container.style.visibility = prevOverlayVis;
                if (modal) modal.style.visibility = prevModalVis;
            }
            if (!res?.ok || !res.dataUrl || !String(res.dataUrl).startsWith('data:image/')) return null;
            const img = await loadDataUrlImage(res.dataUrl);
            if (!img || !img.naturalWidth || !img.naturalHeight) return null;
            const scaleX = img.naturalWidth / Math.max(1, window.innerWidth);
            const scaleY = img.naturalHeight / Math.max(1, window.innerHeight);
            const sx = Math.max(0, Math.round(left * scaleX));
            const sy = Math.max(0, Math.round(top * scaleY));
            const sw = Math.min(img.naturalWidth - sx, Math.round(visW * scaleX));
            const sh = Math.min(img.naturalHeight - sy, Math.round(visH * scaleY));
            if (sw < 40 || sh < 30) return null;

            const canvas = document.createElement('canvas');
            const outScale = Math.min(1, 640 / sw);
            canvas.width = Math.max(1, Math.round(sw * outScale));
            canvas.height = Math.max(1, Math.round(sh * outScale));
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
            if (isCanvasBlankOrBlack(canvas, ctx)) return null;
            const cropped = canvas.toDataURL('image/jpeg', 0.78);
            return cropped && cropped.length >= 200 ? cropped : null;
        } catch (_) {
            return null;
        }
    }

    async function capturePosterAsFrame(video) {
        try {
            const rawUrl = (video?.poster || findThumbnail(video) || '').trim();
            if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return null;
            // Ignore generic site logos/favicons
            if (/\/(?:favicon|apple-touch-icon|logo|default[-_]?thumb|avatar)\b/i.test(rawUrl)) return null;
            const res = await huntMessage({ action: 'FETCH_IMAGE_AS_DATAURL', url: rawUrl, referer: window.location.href }, 3000);
            if (!res?.ok || !res.dataUrl || !String(res.dataUrl).startsWith('data:image/')) return null;
            const img = await loadDataUrlImage(res.dataUrl);
            if (!img || img.naturalWidth < 90 || img.naturalHeight < 60) return null;
            const canvas = document.createElement('canvas');
            const scale = Math.min(1, 640 / img.naturalWidth);
            canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            if (isCanvasBlankOrBlack(canvas, ctx)) return null;
            const out = canvas.toDataURL('image/jpeg', 0.78);
            return out && out.length >= 200 ? out : null;
        } catch (_) {
            return null;
        }
    }

    async function captureHuntFrames(video, container) {
        // 3-tier CORS-proof frame extraction:
        // 1. Direct <video> canvas capture (fast, works when same-origin / CORS allowed)
        // 2. Visible tab screenshot cropped to <video> bounding box (bypasses CORS 100%)
        // 3. Browser-authenticated poster/og:image download as JPEG bytes
        const frames = [];
        const direct = captureVideoFrameJpeg(video);
        if (direct) {
            frames.push(direct);
        } else {
            const tabCrop = await captureVideoViaVisibleTab(video, container);
            if (tabCrop) frames.push(tabCrop);
        }
        const posterFrame = await capturePosterAsFrame(video);
        if (posterFrame && !frames.includes(posterFrame)) {
            frames.push(posterFrame);
        }
        return frames.slice(0, 3);
    }

    function openHuntPanel(container, message) {
        const panel = container.querySelector('.nexus-hunt-panel');
        const status = container.querySelector('.nexus-hunt-status');
        const huntBtn = container.querySelector('.nexus-hunt-btn');
        container.classList.add('nexus-hunting');
        container.classList.add('nexus-open');
        if (panel) {
            panel.removeAttribute('hidden');
            panel.hidden = false;
            panel.style.display = 'flex';
            try { panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) { }
        }
        if (status) status.textContent = message || '…';
        if (huntBtn) {
            huntBtn.disabled = true;
            huntBtn.classList.add('nexus-hunt-busy');
            huntBtn.textContent = 'Hľadám…';
        }
        container.querySelector('.nexus-hunt-stop').hidden = false;
        container.querySelector('.nexus-hunt-retry').disabled = true;
        showToast(message || 'Lov lepšej kvality…');
    }

    function closeHuntBusy(container, finalLabel) {
        const huntBtn = container.querySelector('.nexus-hunt-btn');
        if (huntBtn) {
            huntBtn.disabled = false;
            huntBtn.classList.remove('nexus-hunt-busy');
            huntBtn.textContent = finalLabel || 'Nájsť iné verzie';
        }
        container._huntRunning = false;
        container.querySelector('.nexus-hunt-stop').hidden = true;
        container.querySelector('.nexus-hunt-retry').disabled = false;
    }

    function syncHuntPresetUI(container, modal) {
        if (!modal) return;
        const mode = container?.querySelector('.nexus-hunt-mode')?.value || 'quick';
        const visual = !!container?.querySelector('.nexus-hunt-visual')?.checked;
        const visualOnly = !!container?.querySelector('.nexus-hunt-visual-only')?.checked;
        const activePreset = visualOnly ? 'visual-only' : (mode === 'deep' || visual) ? 'deep-visual' : 'quick';
        for (const btn of modal.querySelectorAll('[data-hunt-preset]')) {
            btn.setAttribute('aria-checked', String(btn.dataset.huntPreset === activePreset));
        }
    }

    function ensureHuntModal(container) {
        let modal = document.querySelector('.nexus-hunt-modal');
        if (modal) {
            modal._huntContainer = container;
            return modal;
        }
        modal = document.createElement('div');
        modal.className = 'nexus-hunt-modal';
        modal.hidden = true;
        modal._huntContainer = container;
        modal.innerHTML = `
            <div class="nexus-hunt-modal-card" role="dialog" aria-modal="true" aria-labelledby="nh-modal-title">
                <header class="nh-topbar">
                    <div class="nh-topbar-left">
                        <h2 id="nh-modal-title" class="nh-title">Iné verzie klipu</h2>
                        <div class="nh-ref-chip nexus-hunt-modal-reference" title="Pôvodné video">Pôvodné video</div>
                    </div>
                    <div class="nh-topbar-center">
                        <div class="nh-segmented" role="radiogroup" aria-label="Režim hľadania">
                            <button type="button" class="nh-seg-btn" data-hunt-preset="quick" aria-checked="true" title="Rýchle vyhľadávanie podľa názvu a metadát">Rýchle</button>
                            <button type="button" class="nh-seg-btn" data-hunt-preset="deep-visual" aria-checked="false" title="Dôkladné hľadanie vrátane vizuálnej zhody záberov (Vision + Yandex)">Dôkladné + Obraz</button>
                            <button type="button" class="nh-seg-btn" data-hunt-preset="visual-only" aria-checked="false" title="Hľadanie iba podľa náhľadu videa bez textového názvu">Len podľa náhľadu</button>
                        </div>
                    </div>
                    <div class="nh-topbar-right">
                        <span class="nh-live-status nexus-hunt-modal-now" role="status" aria-live="polite">Pripravené</span>
                        <button type="button" class="nh-btn nh-btn-danger nexus-hunt-workbench-stop" hidden title="Okamžite zastaví prebiehajúce hľadanie a ponechá doterajšie výsledky">Zastaviť</button>
                        <button type="button" class="nh-btn nh-btn-primary nexus-hunt-refresh" title="Spustí nové hľadanie naprieč zdrojmi">Hľadať znova</button>
                        <button type="button" class="nh-btn nh-btn-warning nexus-hunt-retry-failed" hidden title="Zopakuje iba zdroje, ktoré pri poslednom behu zlyhali alebo vypršal čas">Opakovať zlyhané</button>
                        <button type="button" class="nh-btn nh-btn-ghost nh-query-toggle" aria-expanded="false" aria-controls="nh-query-drawer" title="Upraviť kľúčové slová scény alebo meno účinkujúceho">Upresniť dotaz</button>
                        <button type="button" class="nh-btn nh-btn-ghost nh-help-toggle" aria-expanded="false" aria-controls="nh-help-drawer" title="Návod ako efektívne vyhľadávať a vysvetlenie režimov">? Návod</button>
                        <button type="button" class="nh-btn nh-btn-icon nexus-hunt-modal-close" aria-label="Zavrieť" title="Zavrieť okno (Esc)">✕</button>
                    </div>
                </header>

                <section id="nh-help-drawer" class="nh-help-drawer" hidden aria-label="Návod na vyhľadávanie">
                    <div class="nh-help-head">
                        <strong>Ako rýchlo nájsť najlepšiu verziu alebo podobné videá</strong>
                        <button type="button" class="nh-btn nh-btn-ghost nh-help-close">Skryť návod</button>
                    </div>
                    <div class="nh-help-grid">
                        <div class="nh-help-col">
                            <h4>1. Režimy vyhľadávania</h4>
                            <ul>
                                <li><b>Rýchle:</b> prehľadá názov a lokálnu knižnicu za pár sekúnd.</li>
                                <li><b>Dôkladné + Obraz:</b> pridá širšie zdroje, kaskádové dopyty a obrazové hľadanie (Google Vision + Yandex) zo záberu videa.</li>
                                <li><b>Len podľa náhľadu:</b> ignoruje text názvu a hľadá čisto podľa obrazu – ideálne pre názvy typu <code>video_123.mp4</code>.</li>
                            </ul>
                        </div>
                        <div class="nh-help-col">
                            <h4>2. Tipy pre lepšie výsledky</h4>
                            <ul>
                                <li><b>Upresniť dotaz:</b> ak sa nič nenašlo, zadaj len jadro názvu alebo meno/prezývku účinkujúceho bez tagov ako <code>1080p</code> či <code>OnlyFans</code>.</li>
                                <li><b>Overiť kvalitu a veľkosť:</b> prvé 4 karty sa overia automaticky; tlačidlom doplníš rozlíšenie, dĺžku, dátum a veľkosť na náhľady všetkých ostatných kariet.</li>
                                <li><b>Rovnaký účinkujúci &amp; podobné:</b> ak neexistuje kópia toho istého klipu, tu nájdeš podobné scény a ďalšie videá rovnakého tvorcu.</li>
                            </ul>
                        </div>
                        <div class="nh-help-col">
                            <h4>3. Prehrávanie a hromadný import</h4>
                            <ul>
                                <li><b>▶ Prehrať (alebo klik na náhľad):</b> otvorí popup prehrávač priamo nad výsledkami bez opustenia stránky.</li>
                                <li><b>Výber a duplikáty:</b> označ jednotlivé videá alebo klikni na <b>Vybrať všetky</b>; duplikáty z iných webov vieš skryť jedným prepínačom.</li>
                                <li><b>Import vybraných / Importovať všetko:</b> odošle všetky označené (alebo viditeľné) videá do Nexusu naraz.</li>
                            </ul>
                        </div>
                    </div>
                </section>

                <section id="nh-query-drawer" class="nh-drawer" hidden>
                    <div class="nh-drawer-grid">
                        <label class="nh-field">
                            <span>Kľúčové slová alebo názov scény</span>
                            <input class="nh-input nexus-hunt-workbench-keywords" name="manual_keywords" type="text" maxlength="300" autocomplete="off" placeholder="napr. názov scény, tagy…">
                            <small class="nh-field-hint">Nechaj prázdne pre automatický názov; píš bez koncoviek (.mp4, 1080p).</small>
                        </label>
                        <label class="nh-field">
                            <span>Účinkujúci / tvorca</span>
                            <input class="nh-input nexus-hunt-workbench-performer" name="performer" type="text" maxlength="120" autocomplete="off" placeholder="meno alebo prezývka">
                            <small class="nh-field-hint">Pomôže nájsť premenované kópie aj ďalšie videá rovnakého tvorcu.</small>
                        </label>
                        <div class="nh-drawer-actions">
                            <button type="button" class="nh-btn nh-btn-primary nh-query-apply">Použiť a hľadať</button>
                            <button type="button" class="nh-btn nh-btn-ghost nh-query-cancel">Zrušiť</button>
                        </div>
                    </div>
                </section>

                <nav class="nh-filterbar" aria-label="Filtre výsledkov">
                    <div class="nh-pills" role="tablist" aria-label="Kategórie zhôd">
                        <button type="button" class="nh-pill" data-hunt-filter="matches" aria-pressed="true" title="Potvrdené kópie, zostrihy a nádejné zhody rovnakej scény">Najlepšie zhody <span class="nh-pill-count">0</span></button>
                        <button type="button" class="nh-pill nh-pill-accent" data-hunt-filter="improved" aria-pressed="false" title="Prehrateľné verzie s overeným vyšším rozlíšením než pôvodné video">Vyššia kvalita <span class="nh-pill-count">0</span></button>
                        <button type="button" class="nh-pill" data-hunt-filter="same_clip" aria-pressed="false" title="Kópie so zhodnou dĺžkou alebo kratšie/dlhšie zostrihy tej istej scény">Rovnaké video <span class="nh-pill-count">0</span></button>
                        <button type="button" class="nh-pill" data-hunt-filter="similar_all" aria-pressed="false" title="Podobné scény a ďalšie videá toho istého účinkujúceho">Rovnaký účinkujúci &amp; podobné <span class="nh-pill-count">0</span></button>
                        <button type="button" class="nh-pill" data-hunt-filter="all" aria-pressed="false" title="Zobrazí všetky prijaté výsledky bez obmedzenia kategórie">Všetko <span class="nh-pill-count">0</span></button>
                    </div>
                    <div class="nh-filterbar-utils">
                        <button type="button" class="nh-btn nh-btn-subtle nh-select-all" title="Označí alebo odznačí všetky aktuálne zobrazené výsledky">Vybrať všetky</button>
                        <button type="button" class="nh-btn nh-btn-primary nh-import-all" title="Hromadne naimportuje označené videá (alebo všetky viditeľné, ak nie je nič označené)">Importovať všetko</button>
                        <label class="nh-inline-field nh-inline-check" title="Skryje duplicitné kópie toho istého videa z iných zdrojov a ponechá najlepšiu verziu">
                            <input type="checkbox" class="nh-hide-dups"> Skryť duplikáty
                        </label>
                        <button type="button" class="nh-btn nh-btn-subtle nexus-hunt-fast-fetch" title="Overí reálne rozlíšenie, veľkosť, dátum a náhľady pre všetky karty">Overiť kvalitu a veľkosť</button>
                        <span class="nh-fast-status nexus-hunt-fast-status" role="status"></span>
                        <select class="nh-select" data-hunt-view="sort" aria-label="Zoradenie" title="Zoradenie kariet">
                            <option value="">Odporúčané</option>
                            <option value="height:desc">Najvyššie rozlíšenie</option>
                            <option value="size_bytes:desc">Najväčší súbor</option>
                            <option value="duration_sec:desc">Najdlhšie video</option>
                        </select>
                        <button type="button" class="nh-btn nh-btn-ghost nh-tech-filters-toggle" aria-expanded="false" aria-controls="nh-tech-filters" title="Filtrovať podľa minimálneho rozlíšenia, veľkosti v MB, dĺžky alebo dostupnosti">Filtre <span class="nh-active-dot" hidden></span></button>
                        <div class="nh-view-tabs" role="tablist" aria-label="Zobrazenie">
                            <button type="button" class="nh-tab-btn nexus-hunt-tab-results" aria-pressed="true" title="Zobraziť mriežku nájdených videí">Výsledky</button>
                            <button type="button" class="nh-tab-btn nexus-hunt-tab-sources" aria-pressed="false" title="Prehľad prehľadaných zdrojov, pokrytia a dôvodov vyradenia">Zdroje</button>
                        </div>
                    </div>
                </nav>

                <div id="nh-tech-filters" class="nh-tech-filters" hidden>
                    <label class="nh-inline-field">Min. kvalita
                        <select class="nh-select" data-hunt-view="quality">
                            <option value="">Všetky</option>
                            <option value="720">720p+</option>
                            <option value="1080">1080p+</option>
                            <option value="1440">1440p+</option>
                            <option value="2160">4K+</option>
                            <option value="unknown">Neznáma</option>
                        </select>
                    </label>
                    <label class="nh-inline-field">Veľkosť (MB)
                        <input class="nh-input nh-input-num" data-hunt-view="sizeMin" type="number" min="0" step="any" placeholder="od">
                        <span>–</span>
                        <input class="nh-input nh-input-num" aria-label="Maximálna veľkosť (MB)" data-hunt-view="sizeMax" type="number" min="0" step="any" placeholder="do">
                    </label>
                    <label class="nh-inline-field">Dĺžka (min)
                        <input class="nh-input nh-input-num" data-hunt-view="durationMin" type="number" min="0" step="any" placeholder="od">
                        <span>–</span>
                        <input class="nh-input nh-input-num" aria-label="Maximálna dĺžka (min)" data-hunt-view="durationMax" type="number" min="0" step="any" placeholder="do">
                    </label>
                    <label class="nh-inline-field nh-inline-check">
                        <input type="checkbox" class="nh-only-playable"> Len ihneď prehrateľné
                    </label>
                    <button type="button" class="nh-btn nh-btn-ghost nexus-hunt-reset-view">Vynulovať</button>
                    <span class="nh-visible-count nexus-hunt-visible-count" role="status"></span>
                </div>

                <div class="nexus-hunt-modal-body">
                    <div class="nexus-hunt-modal-stage nh-player-popup" hidden role="dialog" aria-label="Prehrávač videa">
                        <div class="nh-player-popup-card">
                            <div class="nh-player-popup-head">
                                <div class="nh-player-popup-title-wrap">
                                    <strong class="nexus-hunt-comparison-label">Prehrávač videa</strong>
                                    <span class="nh-pane-status nexus-hunt-modal-status">Načítavam…</span>
                                </div>
                                <div class="nh-player-popup-specs">
                                    <span class="nh-cand-res">—</span>
                                    <span class="nh-cand-dur">—</span>
                                    <span class="nexus-hunt-candidate-size">—</span>
                                </div>
                                <button type="button" class="nh-btn nh-btn-icon nh-stage-close" aria-label="Zavrieť prehrávač" title="Zavrieť prehrávač">✕</button>
                            </div>
                            <div class="nh-player-popup-media">
                                <video class="nexus-hunt-modal-video" controls playsinline></video>
                            </div>
                            <div class="nexus-hunt-modal-actions">
                                <button type="button" class="nh-btn nh-btn-primary nexus-hunt-modal-import" disabled>Importovať toto video</button>
                                <button type="button" class="nh-btn nh-btn-subtle nexus-hunt-modal-open" disabled>Otvoriť zdroj ↗</button>
                            </div>
                        </div>
                    </div>
                    <div class="nexus-hunt-modal-list"></div>
                    <div class="nexus-hunt-workbench-sources" hidden>
                        <div class="nh-sources-toolbar">
                            <div class="nexus-hunt-cache-info"></div>
                            <button type="button" class="nh-btn nh-btn-subtle nexus-hunt-export">Exportovať JSON</button>
                        </div>
                        <div class="nh-sources-content"></div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('.nexus-hunt-modal-close').onclick = () => closeHuntModal();
        modal.addEventListener('keydown', e => {
            if (e.key === 'Tab') {
                const controls = [...modal.querySelectorAll('button:not(:disabled), input, select, video[controls], summary, a[href]')]
                    .filter(el => el.getClientRects().length);
                if (!controls.length) return;
                const first = controls[0], last = controls[controls.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
                return;
            }
            const tag = (document.activeElement?.tagName || '').toLowerCase();
            if (['input', 'select', 'textarea', 'video'].includes(tag)) return;
            const stage = modal.querySelector('.nexus-hunt-modal-stage');
            if (stage && !stage.hidden && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
                e.preventDefault();
                stepHuntStageCard(modal._huntContainer, modal, e.key === 'ArrowRight' ? 1 : -1);
            }
        });
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeHuntModal();
        });
        if (!window.__nexusHuntEsc) {
            window.__nexusHuntEsc = true;
            document.addEventListener('keydown', (e) => {
                const open = document.querySelector('.nexus-hunt-modal');
                if (e.key === 'Escape' && open && !open.hidden) closeHuntModal();
            });
        }
        modal.querySelector('.nexus-hunt-modal-open').onclick = () => {
            const url = modal._activeUrl;
            if (url) window.open(url, '_blank', 'noopener,noreferrer');
        };
        modal.querySelector('.nexus-hunt-modal-import').onclick = () => {
            const card = modal._activeCard;
            const owner = modal._huntContainer;
            if (!card || !owner) return;
            importHuntCard(owner, card);
        };
        for (const pill of modal.querySelectorAll('.nh-pill[data-hunt-filter]')) {
            pill.onclick = () => {
                const owner = modal._huntContainer;
                owner._huntFilter = pill.dataset.huntFilter;
                renderHuntGroups(owner, owner._huntGroups || {});
            };
        }
        for (const control of modal.querySelectorAll('[data-hunt-view]')) control.oninput = () => {
            const owner = modal._huntContainer;
            owner._huntView = { ...owner._huntView, [control.dataset.huntView]: control.value };
            renderHuntGroups(owner, owner._huntGroups || {});
        };
        modal.querySelector('.nh-only-playable').onchange = event => {
            const owner = modal._huntContainer;
            owner._huntView = { ...owner._huntView, onlyPlayable: event.target.checked };
            renderHuntGroups(owner, owner._huntGroups || {});
        };
        modal.querySelector('.nexus-hunt-reset-view').onclick = () => {
            const owner = modal._huntContainer;
            owner._huntView = {};
            modal.querySelector('.nh-only-playable').checked = false;
            renderHuntGroups(owner, owner._huntGroups || {});
        };
        const helpDrawer = modal.querySelector('#nh-help-drawer');
        const helpToggle = modal.querySelector('.nh-help-toggle');
        const setHelpOpen = open => {
            if (!helpDrawer || !helpToggle) return;
            helpDrawer.hidden = !open;
            helpToggle.setAttribute('aria-expanded', String(open));
        };
        if (helpToggle) helpToggle.onclick = () => setHelpOpen(helpDrawer.hidden);
        modal.querySelector('.nh-help-close')?.addEventListener('click', () => setHelpOpen(false));
        const queryDrawer = modal.querySelector('#nh-query-drawer');
        const queryToggle = modal.querySelector('.nh-query-toggle');
        const setDrawerOpen = open => {
            queryDrawer.hidden = !open;
            queryToggle.setAttribute('aria-expanded', String(open));
            if (open) modal.querySelector('.nexus-hunt-workbench-keywords')?.focus();
        };
        queryToggle.onclick = () => setDrawerOpen(queryDrawer.hidden);
        modal.querySelector('.nh-query-cancel').onclick = () => setDrawerOpen(false);
        const techFilters = modal.querySelector('#nh-tech-filters');
        const techToggle = modal.querySelector('.nh-tech-filters-toggle');
        techToggle.onclick = () => {
            const open = techFilters.hidden;
            techFilters.hidden = !open;
            techToggle.setAttribute('aria-expanded', String(open));
        };
        for (const tab of ['results', 'sources']) modal.querySelector(`.nexus-hunt-tab-${tab}`).onclick = () => {
            modal._sourcesTab = tab === 'sources';
            modal.querySelector('.nexus-hunt-modal-list').hidden = modal._sourcesTab;
            modal.querySelector('.nexus-hunt-workbench-sources').hidden = !modal._sourcesTab;
            for (const key of ['results', 'sources']) modal.querySelector(`.nexus-hunt-tab-${key}`).setAttribute('aria-pressed', String(key === tab));
        };
        modal.querySelector('.nexus-hunt-workbench-stop').onclick = () => stopQualityHunt(modal._huntContainer);
        const applyInputsToOwner = owner => {
            owner.querySelector('.nexus-hunt-keywords').value = modal.querySelector('.nexus-hunt-workbench-keywords').value;
            owner.querySelector('.nexus-hunt-performer').value = modal.querySelector('.nexus-hunt-workbench-performer').value;
        };
        const rerun = retry => {
            const owner = modal._huntContainer;
            applyInputsToOwner(owner);
            owner._coverageTarget = 5;
            startQualityHunt(owner, { force_refresh: true, retry_job_id: retry ? owner._huntJobId : '' }).catch(error => showToast(error.message, true));
        };
        for (const segBtn of modal.querySelectorAll('[data-hunt-preset]')) {
            segBtn.onclick = () => {
                const owner = modal._huntContainer;
                const preset = segBtn.dataset.huntPreset;
                const modeEl = owner.querySelector('.nexus-hunt-mode');
                const visEl = owner.querySelector('.nexus-hunt-visual');
                const visOnlyEl = owner.querySelector('.nexus-hunt-visual-only');
                if (preset === 'quick') {
                    if (modeEl) modeEl.value = 'quick';
                    if (visEl) visEl.checked = false;
                    if (visOnlyEl) visOnlyEl.checked = false;
                } else if (preset === 'deep-visual') {
                    if (modeEl) modeEl.value = 'deep';
                    if (visEl) visEl.checked = true;
                    if (visOnlyEl) visOnlyEl.checked = false;
                } else if (preset === 'visual-only') {
                    if (modeEl) modeEl.value = 'deep';
                    if (visEl) visEl.checked = true;
                    if (visOnlyEl) visOnlyEl.checked = true;
                }
                syncHuntPresetUI(owner, modal);
                if (!owner._huntRunning) rerun(false);
            };
        }
        modal.querySelector('.nh-query-apply').onclick = () => { setDrawerOpen(false); rerun(false); };
        modal.querySelector('.nexus-hunt-refresh').onclick = () => rerun(false);
        modal.querySelector('.nexus-hunt-fast-fetch').onclick = () => fastFetchHuntCards(modal._huntContainer).catch(error => showToast(error.message, true));
        modal.querySelector('.nexus-hunt-retry-failed').onclick = () => rerun(true);
        modal.querySelector('.nh-stage-close').onclick = () => resetHuntComparison(modal);
        modal.querySelector('.nh-player-popup').addEventListener('click', e => {
            if (e.target === e.currentTarget) resetHuntComparison(modal);
        });
        modal.querySelector('.nh-hide-dups').onchange = event => {
            const owner = modal._huntContainer;
            owner._huntView = { ...owner._huntView, hideDuplicates: event.target.checked };
            renderHuntGroups(owner, owner._huntGroups || {});
        };
        modal.querySelector('.nh-select-all').onclick = () => {
            const owner = modal._huntContainer;
            const selected = owner._huntSelectedUrls || (owner._huntSelectedUrls = new Set());
            const visible = selectHuntCards(owner);
            const selectable = visible.filter(c => c.url);
            const allSelected = selectable.length > 0 && selectable.every(c => selected.has(c.url));
            if (allSelected) {
                for (const c of selectable) selected.delete(c.url);
            } else {
                for (const c of selectable) selected.add(c.url);
            }
            renderHuntModalList(owner);
        };
        modal.querySelector('.nh-import-all').onclick = () => {
            importAllHuntCards(modal._huntContainer).catch(err => showToast(err.message, true));
        };
        modal.querySelector('.nexus-hunt-export').onclick = () => {
            const owner = modal._huntContainer;
            const blob = new Blob([JSON.stringify({
                original: owner._huntPayload?.page_url,
                counts: huntSummary(owner), candidates: selectHuntCards(owner).map(({ stream_url, ...card }) => card)
            }, null, 2)], { type: 'application/json' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob); link.download = 'nexus-verzie.json'; link.click();
            setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        };
        return modal;
    }

    function resetHuntComparison(modal) {
        const video = modal.querySelector('.nexus-hunt-modal-video');
        if (video) {
            video._huntToken = (video._huntToken || 0) + 1;
            video.pause();
            video.removeAttribute('src');
            video.load();
        }
        if (modal._hls) {
            try { modal._hls.destroy(); } catch (_) { }
            modal._hls = null;
        }
        const original = modal.querySelector('.nexus-hunt-original-video');
        if (original) { original._huntToken = (original._huntToken || 0) + 1; original.pause(); original.removeAttribute('src'); original._huntSource = ''; original.load(); }
        modal._originalHls?.destroy(); modal._originalHls = null;
        const frame = modal.querySelector('.nexus-hunt-modal-frame');
        if (frame) frame.src = 'about:blank';
        modal._activeCard = null;
        modal._activeUrl = '';
        if (modal._huntContainer) modal._huntContainer._huntSelectedId = null;
        modal.querySelector('.nexus-hunt-modal-stage').hidden = true;
        modal.querySelector('.nexus-hunt-modal-open').disabled = true;
        modal.querySelector('.nexus-hunt-modal-import').disabled = true;
    }

    function closeHuntModal() {
        const modal = document.querySelector('.nexus-hunt-modal');
        if (!modal) return;
        resetHuntComparison(modal);
        modal.hidden = true;
        modal._returnFocus?.focus();
    }

    function openHuntModal(container) {
        const modal = ensureHuntModal(container);
        modal._returnFocus = document.activeElement;
        modal.hidden = false;
        syncHuntPresetUI(container, modal);
        renderHuntModalList(container);
        modal.querySelector('.nexus-hunt-modal-close').focus();
    }

    function huntDupSignature(card) {
        if (card.cluster_key && !String(card.cluster_key).startsWith('fb:')) return `ck:${card.cluster_key}`;
        let title = String(card.title || '').toLowerCase()
            .replace(/\.(mp4|mkv|webm|mov|avi|ts)\b/g, ' ')
            .replace(/\b(2160|1440|1080|720|480|360|240)p?\b|\b[48]k\b|\b(hd|fhd|uhd|x264|x265|hevc)\b/g, ' ')
            .replace(/\s*[-–|]\s*(pornhub|xvideos|xhamster|spankbang|eporner|porntrex|noodlemagazine|camwhores(?:\.tv)?|pimpbunny|whoreshub)\b.*$/i, '')
            .replace(/[^a-z0-9\u0400-\u04ff]+/g, ' ')
            .trim();
        const tokens = [...new Set(title.split(/\s+/).filter(t => t.length >= 3 && !['the', 'and', 'with', 'for', 'porn', 'video', 'full', 'scene'].includes(t)))].sort();
        if (tokens.length < 2) return '';
        const durBucket = Number(card.duration_sec || 0) > 0 ? Math.round(Number(card.duration_sec) / 8) : 0;
        return `tk:${tokens.slice(0, 6).join('_')}:${durBucket}`;
    }

    function annotateHuntDuplicates(cards) {
        const groups = new Map();
        for (const card of cards) {
            card.is_dup_secondary = false;
            card.dup_sources = [];
            card.dup_primary_domain = '';
            card.dup_count = 1;
            const sig = huntDupSignature(card);
            if (!sig) continue;
            if (!groups.has(sig)) groups.set(sig, []);
            groups.get(sig).push(card);
        }
        for (const members of groups.values()) {
            if (members.length < 2) continue;
            const sorted = [...members].sort((a, b) => {
                const pa = (a.availability_state === 'playable' ? 1 : 0) * 1e9 + Number(a.height || 0) * 1e5 + Number(a.size_bytes || 0);
                const pb = (b.availability_state === 'playable' ? 1 : 0) * 1e9 + Number(b.height || 0) * 1e5 + Number(b.size_bytes || 0);
                return pb - pa;
            });
            const primary = sorted[0];
            const primaryDomain = huntDomainLabel(primary);
            const otherDomains = [...new Set(sorted.slice(1).map(c => huntDomainLabel(c)).filter(d => d && d !== primaryDomain))];
            primary.dup_count = sorted.length;
            primary.dup_sources = otherDomains;
            for (const sec of sorted.slice(1)) {
                sec.is_dup_secondary = true;
                sec.dup_count = sorted.length;
                sec.dup_primary_domain = primaryDomain;
            }
        }
        return cards;
    }

    function normalizeHuntCards(container) {
        const native = Array.isArray(container._huntCandidates) ? container._huntCandidates : null;
        const raw = native || ['better', 'other', 'maybe'].flatMap(key => (container._huntGroups?.[key] || []).flatMap(c => [c, ...(c.mirrors || [])]));
        const cards = new Map();
        for (const input of raw) {
            if (!input?.url) continue;
            const card = {
                ...input, import_result: container._huntImports?.[input.url], mirrors: [], mirror_count: 1,
                id: input.id || input.url,
                identity_state: input.identity_state || (input.confirmed ? 'confirmed' : 'possible'),
                availability_state: input.availability_state || (input.requires_login ? 'login_required' : 'unknown'),
                quality_state: input.quality_state || (input.height ? ['metadata', 'library'].includes(input.height_source) ? 'measured' : 'estimated' : 'unknown')
            };
            if (!cards.has(card.id) || card.confirmed && !cards.get(card.id).confirmed) cards.set(card.id, card);
        }
        return annotateHuntDuplicates([...cards.values()]);
    }

    function selectHuntCards(container, filter = container._huntFilter || 'matches') {
        const cards = normalizeHuntCards(container).filter(card => {
            // Raw search hits remain in diagnostics; they are not alternative versions.
            if (!['confirmed', 'variant', 'possible', 'similar', 'related'].includes(card.identity_state)) return false;
            switch (filter) {
                case 'matches': return ['confirmed', 'variant', 'possible', 'similar'].includes(card.identity_state);
                case 'same_clip': return ['confirmed', 'variant'].includes(card.identity_state);
                case 'similar_all': return ['similar', 'related'].includes(card.identity_state);
                case 'confirmed': return card.identity_state === 'confirmed';
                case 'variant': return card.identity_state === 'variant';
                case 'verify': return card.identity_state === 'possible';
                case 'similar': return card.identity_state === 'similar';
                case 'performer': return card.identity_state === 'related';
                case 'available': return ['confirmed', 'variant'].includes(card.identity_state) && card.availability_state === 'playable';
                case 'improved': return ['confirmed', 'variant'].includes(card.identity_state) && card.availability_state === 'playable' && card.quality_state === 'measured' && card.quality_status === 'higher';
                default: return true;
            }
        });
        const view = container._huntView || {};
        const inRange = (value, min, max, unit) => {
            const hasMin = min !== undefined && min !== '', hasMax = max !== undefined && max !== '';
            if (!hasMin && !hasMax) return true;
            const number = Number(value);
            return Number.isFinite(number) && number > 0 && (!hasMin || number >= Number(min) * unit) && (!hasMax || number <= Number(max) * unit);
        };
        const matching = cards.filter(card => {
            const height = Number(card.height || 0);
            return (!view.quality || (view.quality === 'unknown' ? !(height > 0) : height >= Number(view.quality)))
                && (!view.onlyPlayable || card.availability_state === 'playable')
                && (!view.hideDuplicates || !card.is_dup_secondary)
                && inRange(card.size_bytes, view.sizeMin, view.sizeMax, 1024 * 1024)
                && inRange(card.duration_sec, view.durationMin, view.durationMax, 60);
        });
        const [field, direction] = (view.sort || '').split(':');
        if (['height', 'size_bytes', 'duration_sec'].includes(field) && ['asc', 'desc'].includes(direction)) {
            return matching.sort((a, b) => {
                const left = Number(a[field]), right = Number(b[field]);
                const leftKnown = Number.isFinite(left) && left > 0, rightKnown = Number.isFinite(right) && right > 0;
                if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
                return (leftKnown ? (left - right) * (direction === 'asc' ? 1 : -1) : 0) || String(a.id).localeCompare(String(b.id));
            });
        }
        const origDur = Number(container._huntOriginalMeta?.duration_sec || container._huntPayload?.duration_sec || 0);
        const rank = card => {
            const candDur = Number(card.duration_sec || 0);
            const durBonus = (origDur > 0 && candDur > 0) ? Math.max(0, 1 - Math.abs(candDur - origDur) / Math.max(origDur, 1)) : 0;
            return [
                card.identity_state === 'confirmed' ? 5 : card.identity_state === 'variant' ? 4 : card.identity_state === 'possible' ? 3 : card.identity_state === 'similar' ? 2 : 1,
                card.availability_state === 'playable' ? 2 : card.availability_state === 'login_required' ? 0 : 1,
                card.quality_state === 'measured' && card.quality_status === 'higher' ? 2 : 0,
                Number(card.match_coverage || 0),
                Number(card.visual_score || 0),
                durBonus,
                Number(card.height || 0),
                Number(card.size_bytes || 0),
            ];
        };
        const sorted = matching.sort((a, b) => {
            const left = rank(a), right = rank(b);
            for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return right[i] - left[i];
            return String(a.url).localeCompare(String(b.url));
        });
        // Keep identity strength first; within each class show distinct sites
        // before a second mirror from the same site.
        const ordered = [];
        for (const state of ['confirmed', 'variant', 'possible', 'similar', 'related']) {
            const seen = new Set(), first = [], mirrors = [];
            for (const card of sorted.filter(item => item.identity_state === state)) {
                let domain = card.url;
                try {
                    const parts = new URL(card.url).hostname.replace(/^(www\.|m\.)/, '').split('.');
                    const suffix = parts.slice(-2).join('.');
                    domain = suffix.startsWith('camwhores.') ? 'camwhores.tv' : ['co.uk', 'com.au', 'co.jp', 'com.br'].includes(suffix) ? parts.slice(-3).join('.') : suffix;
                } catch (_) { }
                if (seen.has(domain)) mirrors.push(card);
                else { seen.add(domain); first.push(card); }
            }
            ordered.push(...first, ...mirrors);
        }
        if (filter !== 'matches') return ordered;
        let relatedShown = 0;
        return ordered.filter(card => card.identity_state !== 'similar' || ++relatedShown <= 5);
    }

    function huntSummary(container) {
        const cards = normalizeHuntCards(container);
        const confirmed = cards.filter(c => c.identity_state === 'confirmed');
        const variants = cards.filter(c => c.identity_state === 'variant');
        const sceneMatches = [...confirmed, ...variants];
        const domains = new Set(sceneMatches.map(c => {
            try {
                const parts = new URL(c.url).hostname.replace(/^(www\.|m\.)/, '').split('.');
                const suffix = parts.slice(-2).join('.');
                return suffix.startsWith('camwhores.') ? 'camwhores.tv' : ['co.uk', 'com.au', 'co.jp', 'com.br'].includes(suffix) ? parts.slice(-3).join('.') : suffix;
            } catch (_) { return ''; }
        }).filter(Boolean));
        return {
            candidates: cards.length, confirmed: confirmed.length, variants: variants.length,
            possible: cards.filter(c => c.identity_state === 'possible').length,
            similar: cards.filter(c => c.identity_state === 'similar').length,
            related: cards.filter(c => c.identity_state === 'related').length,
            excluded: cards.filter(c => !['confirmed', 'variant', 'possible', 'similar', 'related'].includes(c.identity_state)).length,
            playable: sceneMatches.filter(c => c.availability_state === 'playable').length, sources: domains.size,
            improvements: sceneMatches.filter(c => c.availability_state === 'playable' && c.quality_state === 'measured' && c.quality_status === 'higher').length
        };
    }

    function acceptHuntResponse(container, data) {
        if (Array.isArray(data.candidates)) container._huntCandidates = data.candidates;
        container._huntData = data;
        renderHuntGroups(container, data.groups || container._huntGroups || {});
    }

    function reconcileHuntCards(scope, owner, cards, modal = false) {
        const existing = new Map([...scope.querySelectorAll(':scope > .nexus-hunt-card')].map(el => [el.dataset.huntId, el]));
        const ids = new Set(cards.map(c => c.id));
        for (const [id, el] of existing) if (!ids.has(id)) el.remove();
        scope.querySelector('.nexus-hunt-empty')?.remove();
        cards.forEach((card, index) => {
            let element = existing.get(card.id);
            const signature = JSON.stringify(card);
            if (!element || element._signature !== signature) {
                const focusClass = element?.contains(document.activeElement) ? document.activeElement.className : '';
                const detailsOpen = element?.querySelector('details')?.open;
                const replacement = buildHuntCard(owner, card, { modal });
                if (detailsOpen && replacement.querySelector('details')) replacement.querySelector('details').open = true;
                replacement.dataset.huntId = card.id; replacement._signature = signature;
                if (element) element.replaceWith(replacement);
                element = replacement;
                if (focusClass) element.querySelector('.' + focusClass.split(' ').join('.'))?.focus();
            }
            const checked = !!owner._huntSelectedUrls?.has(card.url);
            const checkEl = element.querySelector('.nh-card-check');
            if (checkEl && checkEl.checked !== checked) checkEl.checked = checked;
            element.dataset.selected = checked ? 'true' : 'false';
            element.setAttribute('aria-current', String(owner._huntSelectedId === card.id));
            if (scope.children[index] !== element) scope.insertBefore(element, scope.children[index] || null);
        });
        if (!cards.length) {
            const filter = modal ? owner._huntFilter || 'matches' : 'matches';
            const stillRunning = !!owner?._huntRunning || owner?._huntData?.status === 'running';
            const message = filter === 'matches' && stillRunning ? 'Vyhľadávanie pokračuje – zatiaľ sa nenašla potvrdená zhoda.' :
                filter === 'matches' ? 'Rovnaký klip ani jeho možnú verziu sa zatiaľ nepodarilo nájsť.' :
                    filter === 'improved' ? 'Nenašla sa dostupná verzia s overeným vyšším rozlíšením.' :
                        'V tejto skupine nie sú výsledky.';
            const emptyEl = Object.assign(document.createElement('div'), { className: 'nexus-hunt-empty', textContent: message });
            const summary = huntSummary(owner);
            const relatedCount = summary.similar + summary.related;
            if (modal && filter === 'matches' && !stillRunning && relatedCount > 0) {
                const switchBtn = document.createElement('button');
                switchBtn.type = 'button';
                switchBtn.className = 'nh-btn nh-btn-primary nh-empty-switch';
                switchBtn.textContent = `Zobraziť podobné videá účinkujúceho (${relatedCount})`;
                switchBtn.onclick = () => {
                    owner._huntFilter = 'similar_all';
                    renderHuntGroups(owner, owner._huntGroups || {});
                };
                emptyEl.appendChild(document.createElement('br'));
                emptyEl.appendChild(switchBtn);
            }
            scope.appendChild(emptyEl);
        }
        hydrateHuntThumbs(scope);
    }

    function formatHuntBitrate(sizeBytes, durationSec) {
        const bytes = Number(sizeBytes || 0);
        const dur = Number(durationSec || 0);
        if (!(bytes > 0 && dur > 5)) return '';
        const mbps = (bytes * 8) / (dur * 1000000);
        return mbps >= 0.1 ? `${mbps.toFixed(1)} Mb/s` : '';
    }

    function renderHuntWorkbenchState(container, modal) {
        renderHuntComparisonSizes(container, modal);
        const data = container._huntData || {};
        const summary = huntSummary(container);
        const measured = container._huntOriginalMeta;
        const origH = Number(measured?.height || container._huntPayload?.height || 0);
        const origDur = Number(measured?.duration_sec || container._huntPayload?.duration_sec || 0);
        const origDurText = origDur > 0 ? `${Math.floor(origDur / 60)}:${String(Math.floor(origDur % 60)).padStart(2, '0')}` : '';
        const refParts = [origH ? `${origH}p` : '', origDurText, container._huntPayload?.title || ''].filter(Boolean);
        const refEl = modal.querySelector('.nexus-hunt-modal-reference');
        if (refEl) {
            refEl.textContent = refParts.join(' · ') || 'Pôvodné video';
            refEl.title = refEl.textContent;
        }
        const nowEl = modal.querySelector('.nexus-hunt-modal-now');
        if (nowEl) nowEl.textContent = container.querySelector('.nexus-hunt-status')?.textContent || 'Pripravené';

        syncHuntPresetUI(container, modal);

        const activeFilter = container._huntFilter || 'matches';
        const pillCounts = {
            matches: selectHuntCards({ ...container, _huntView: {} }, 'matches').length,
            improved: summary.improvements,
            same_clip: summary.confirmed + summary.variants,
            similar_all: summary.similar + summary.related,
            all: selectHuntCards({ ...container, _huntView: {} }, 'all').length,
        };
        for (const pill of modal.querySelectorAll('.nh-pill[data-hunt-filter]')) {
            const key = pill.dataset.huntFilter;
            const count = pillCounts[key] ?? 0;
            const countEl = pill.querySelector('.nh-pill-count');
            if (countEl) countEl.textContent = String(count);
            pill.setAttribute('aria-pressed', String(key === activeFilter));
            pill.hidden = !['matches', 'all'].includes(key) && count === 0 && key !== activeFilter;
        }

        const diagnostics = data.diagnostics || [];
        const failedCount = diagnostics.filter(d => ['timeout', 'rate_limited', 'auth_required', 'parse_error', 'unavailable', 'error', 'cancelled'].includes(d.status)).length;
        const running = !!container._huntRunning;
        const stopBtn = modal.querySelector('.nexus-hunt-workbench-stop');
        const refreshBtn = modal.querySelector('.nexus-hunt-refresh');
        const retryBtn = modal.querySelector('.nexus-hunt-retry-failed');
        if (stopBtn) { stopBtn.hidden = !running; stopBtn.disabled = !running; }
        if (refreshBtn) { refreshBtn.hidden = running; refreshBtn.disabled = running; }
        if (retryBtn) {
            retryBtn.hidden = running || !container._huntJobId || failedCount === 0;
            retryBtn.disabled = running || !container._huntJobId;
            retryBtn.textContent = failedCount > 0 ? `Opakovať zlyhané (${failedCount})` : 'Opakovať zlyhané';
        }

        const view = container._huntView || {};
        const hasTechFilters = Boolean(view.quality || view.sizeMin || view.sizeMax || view.durationMin || view.durationMax || view.onlyPlayable);
        const dot = modal.querySelector('.nh-active-dot');
        if (dot) dot.hidden = !hasTechFilters;

        const hideDupsBox = modal.querySelector('.nh-hide-dups');
        if (hideDupsBox && hideDupsBox.checked !== !!view.hideDuplicates) hideDupsBox.checked = !!view.hideDuplicates;

        const visibleCards = selectHuntCards(container);
        const selectedSet = container._huntSelectedUrls || new Set();
        const selectedVisible = visibleCards.filter(c => c.url && selectedSet.has(c.url));
        const importableTargets = (selectedVisible.length ? selectedVisible : visibleCards)
            .filter(c => c.url && !['pending', 'success'].includes(container._huntImports?.[c.url]?.state));
        const selectAllBtn = modal.querySelector('.nh-select-all');
        if (selectAllBtn) {
            const allChecked = visibleCards.length > 0 && visibleCards.every(c => c.url && selectedSet.has(c.url));
            selectAllBtn.disabled = visibleCards.length === 0;
            selectAllBtn.textContent = allChecked ? `Zrušiť výber (${selectedVisible.length})` : 'Vybrať všetky';
        }
        const importAllBtn = modal.querySelector('.nh-import-all');
        if (importAllBtn && !container._huntBulkImporting) {
            importAllBtn.disabled = importableTargets.length === 0;
            importAllBtn.textContent = selectedVisible.length > 0
                ? `Import vybraných (${importableTargets.length})`
                : `Importovať všetko (${importableTargets.length})`;
        }

        const sourcesTabBtn = modal.querySelector('.nexus-hunt-tab-sources');
        if (sourcesTabBtn) sourcesTabBtn.textContent = summary.sources ? `Zdroje (${summary.sources}/5)` : 'Zdroje';

        // Popup player specs
        const activeCard = modal._activeCard;
        const candResEl = modal.querySelector('.nh-cand-res');
        const candDurEl = modal.querySelector('.nh-cand-dur');
        if (activeCard && candResEl && candDurEl) {
            const candH = Number(activeCard.height || 0);
            const candDur = Number(activeCard.duration_sec || 0);
            const candDurText = candDur > 0 ? `${Math.floor(candDur / 60)}:${String(Math.floor(candDur % 60)).padStart(2, '0')}` : '—';
            candResEl.textContent = candH ? `${candH}p` : '—';
            candDurEl.textContent = candDurText;
        }

        const cache = data.cache || {};
        const cacheInfo = modal.querySelector('.nexus-hunt-cache-info');
        if (cacheInfo) {
            cacheInfo.textContent = `${cache.hit ? `Výsledok z cache (${Math.round(cache.age_sec || 0)} s)` : 'Aktuálne overenie'}${data.status === 'degraded' || data.status === 'partial' ? ' · časť krokov zlyhala' : ''} · pokrytie ${summary.sources}/5 zdrojov`;
        }
        const sourcesContent = modal.querySelector('.nh-sources-content');
        if (sourcesContent) {
            const balance = data.balance || {};
            const metrics = data.metrics || {};
            const latency = value => value == null ? '—' : `${(value / 1000).toFixed(1)} s`;
            const statusNames = { ok: 'Dokončené', done: 'Dokončené', empty: 'Bez výsledkov', timeout: 'Časový limit', rate_limited: 'Obmedzené zdrojom', auth_required: 'Vyžaduje prístup', parse_error: 'Chyba spracovania', unavailable: 'Nedostupné', error: 'Chyba', running: 'Beží', partial: 'Čiastočné', cancelled: 'Zastavené', skip: 'Preskočené' };
            const statusLabel = status => statusNames[status] || status || 'Neznáme';
            sourcesContent.innerHTML = `<p>Prvý kandidát: ${latency(metrics.first_candidate_ms)} · prvá potvrdená zhoda: ${latency(metrics.first_confirmed_ms)} · prvé dostupné zlepšenie: ${latency(metrics.first_improvement_ms)} · trvanie behu: ${latency(metrics.elapsed_ms)}</p><p>Získané odkazy: ${Number(balance.fetched || 0)} · pôvodná stránka: ${Number(balance.original_excluded || 0)} · duplicity: ${Number(balance.duplicate || 0)} · vylúčené zdroje: ${Number(balance.source_excluded || 0)} · vyradené zhody: ${Number(balance.rejected || 0)} · neoverené metadáta: ${Number(balance.metadata_unverified || 0)} · neoverený obraz: ${Number(balance.visual_unverified || 0)} · zlyhané overenia: ${Number(balance.verification_failures || 0)}</p><p>Spracované poskytovateľmi: ${Number(balance.provider_parsed || 0)} · odfiltrované podľa identity pred prijatím: ${Number(balance.provider_identity_filtered || 0)}</p><div class="nexus-hunt-source-table">${diagnostics.map(d => `<div><strong>${escapeHuntText(d.source_key || d.source || 'zdroj')}</strong><span>${escapeHuntText(statusLabel(d.status))} · ${Number(d.elapsed_ms || 0)} ms</span><span>${Number(d.count || 0)} výsledkov</span><span>${escapeHuntText(d.query || '')}</span><span>${escapeHuntText(d.error || [...(d.http_failures || []).map(code => `HTTP ${code}`), ...(d.warnings || [])].join(', '))}</span></div>`).join('')}</div><h3>Kroky overenia</h3>${(data.steps || []).map(step => `<p>${escapeHuntText(step.id)}: ${escapeHuntText(statusLabel(step.status))} · ${Number(step.elapsed_ms || 0)} ms · ${escapeHuntText(step.reason || '')}</p>`).join('')}<h3>Vyradené kandidáty</h3>${normalizeHuntCards(container).filter(c => c.identity_state === 'rejected').map(c => `<p>${escapeHuntText(c.title || c.url)} — ${escapeHuntText(c.rejection_reason || 'Odlišná scéna')}</p>`).join('') || '<p>Žiadne.</p>'}`;
        }
    }

    function renderHuntModalList(container) {
        const modal = document.querySelector('.nexus-hunt-modal');
        if (!modal || modal.hidden || modal._huntContainer !== container) return;
        const list = modal.querySelector('.nexus-hunt-modal-list');
        if (!list) return;
        const visible = selectHuntCards(container);
        for (const control of modal.querySelectorAll('[data-hunt-view]')) {
            const value = container._huntView?.[control.dataset.huntView] || '';
            if (control.value !== value) control.value = value;
        }
        const totalInFilter = selectHuntCards({ ...container, _huntView: {} }).length;
        modal.querySelector('.nexus-hunt-visible-count').textContent = `${visible.length} z ${totalInFilter} kariet`;
        if (modal._activeCard && !visible.some(card => card.id === container._huntSelectedId)) resetHuntComparison(modal);
        reconcileHuntCards(list, container, visible, true);
        renderHuntWorkbenchState(container, modal);
        const latest = normalizeHuntCards(container).find(c => c.id === container._huntSelectedId);
        if (latest && modal._activeCard) Object.assign(modal._activeCard, latest);
        renderHuntComparisonSizes(container, modal);
    }

    async function fastFetchHuntCards(container, limit = 0) {
        if (container._huntFastBusy) return;
        container._huntFastBusy = true;
        const run = container._huntRun, modal = ensureHuntModal(container);
        const button = modal.querySelector('.nexus-hunt-fast-fetch');
        const status = modal.querySelector('.nexus-hunt-fast-status');
        if (button) button.disabled = true;
        let cards = [...new Map([...selectHuntCards(container), ...normalizeHuntCards(container)]
            .filter(c => ['confirmed', 'variant', 'possible', 'similar', 'related'].includes(c.identity_state)).map(c => [c.id, c])).values()];
        if (limit > 0) {
            cards = cards.filter(c => !(c.metadata_status === 'ok' && c.size_bytes > 0 && c.thumbnail)).slice(0, limit);
        }
        if (!cards.length) {
            container._huntFastBusy = false;
            if (button) button.disabled = false;
            return;
        }
        let index = 0, completed = 0, failed = 0;
        if (status) status.textContent = `Overujem 0/${cards.length}…`;
        const worker = async () => {
            while (index < cards.length && container._huntRun === run) {
                const batch = cards.slice(index, index += 4);
                const answer = await huntMessage({
                    action: 'QUALITY_HUNT_META', fast: true, urls: batch.map(c => c.url),
                    jobId: container._huntJobId, port: container._huntPort, baseUrl: container._huntBaseUrl
                }, 65000);
                if (container._huntRun !== run) return;
                if (Array.isArray(answer.candidates)) acceptHuntResponse(container, answer);
                else if (answer.ok) {
                    for (const item of answer.items || []) {
                        for (const card of huntCardsFlat(container).filter(c => c.url === item.url)) {
                            if (item.height) Object.assign(card, { height: item.height, height_source: 'metadata', quality_state: 'measured' });
                            if (item.upload_date) card.upload_date = item.upload_date;
                            if (item.size_bytes) card.size_bytes = item.size_bytes;
                            if (item.duration_sec) card.duration_sec = item.duration_sec;
                            if (item.stream_url) card.stream_url = item.stream_url;
                            if (item.thumbnail && !card.thumbnail) card.thumbnail = item.thumbnail;
                            if (item.title && !card.title) card.title = item.title;
                        }
                    }
                    renderHuntGroups(container, container._huntGroups || {});
                }
                completed += batch.length;
                failed += answer.ok ? (answer.items || []).filter(item => item.error).length : batch.length;
                if (status) status.textContent = completed < cards.length ? `Overujem ${completed}/${cards.length}…` : `${completed}/${cards.length} overených${failed ? ` · ${failed} zlyhaní` : ''}`;
            }
        };
        try { await Promise.all([worker(), worker(), worker()]); }
        finally { container._huntFastBusy = false; if (button) button.disabled = false; }
    }

    function thumbNeedsLocalFetch(thumb) {
        return /cdntrex\.com|porntrex\.com|58img\.top|nsfwpics\.co|leakporner|mypornerleak/i.test(String(thumb || ''));
    }

    function thumbFetchReferer(url) {
        if (/porntrex|cdntrex/i.test(url)) return 'https://www.porntrex.com/';
        if (/mypornerleak/i.test(url)) return 'https://mypornerleak.com/';
        return 'https://leakporner.com/';
    }

    function unwrapThumbUrl(raw) {
        const text = String(raw || '').trim();
        try {
            if (text.includes('/api/v1/proxy')) {
                const parsed = new URL(text, 'http://127.0.0.1:8000');
                return parsed.searchParams.get('url') || text;
            }
        } catch (_) { /* keep raw */ }
        return text;
    }

    function buildThumbFallbackEl(domainText) {
        const wrap = document.createElement('div');
        wrap.className = 'nh-thumb-fallback';
        wrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="M9.5 9.25l5.5 2.75-5.5 2.75V9.25z" fill="currentColor" stroke="none"/></svg><span>${escapeHuntText(domainText || 'Video')}</span><small>Náhľad nedostupný</small>`;
        return wrap;
    }

    function hydrateHuntThumbs(scope) {
        if (!scope) return;
        scope.querySelectorAll('img.nexus-hunt-thumb').forEach(img => {
            const fetchUrl = img.dataset.fetchThumb || unwrapThumbUrl(img.getAttribute('src'));
            const base = img.dataset.thumbBase || 'http://127.0.0.1:8000';
            if (!img.dataset.errorWired) {
                img.dataset.errorWired = '1';
                img.onerror = () => {
                    if (!img.dataset.proxyTried && fetchUrl && /^https?:/i.test(fetchUrl) && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
                        img.dataset.proxyTried = '1';
                        const proxied = `${base}/api/v1/proxy?url=${encodeURIComponent(fetchUrl)}`;
                        chrome.runtime.sendMessage({ action: 'FETCH_IMAGE_AS_DATAURL', url: proxied }, res => {
                            if (res?.ok && res.dataUrl) {
                                img.src = res.dataUrl;
                            } else {
                                img.replaceWith(buildThumbFallbackEl(img.dataset.domain || ''));
                            }
                        });
                    } else {
                        img.replaceWith(buildThumbFallbackEl(img.dataset.domain || ''));
                    }
                };
            }
            if (img.dataset.fetchThumb && img.dataset.hydrated !== '1') {
                img.dataset.hydrated = '1';
                const proxied = `${base}/api/v1/proxy?url=${encodeURIComponent(img.dataset.fetchThumb)}`;
                chrome.runtime.sendMessage({
                    action: 'FETCH_IMAGE_AS_DATAURL',
                    url: proxied,
                }, res => {
                    if (res?.ok && res.dataUrl) img.src = res.dataUrl;
                });
            }
        });
    }

    function huntThumbSrc(container, thumb) {
        const raw = String(thumb || '').trim();
        if (!raw) return '';
        const base = String(container._huntBaseUrl || 'http://127.0.0.1:8000').replace(/\/$/, '');
        if (raw.startsWith('/api/')) return base + raw;
        if (/58img\.top|nsfwpics\.co|leakporner|mypornerleak|nsfw247/i.test(raw)) {
            return `${base}/api/v1/proxy?url=${encodeURIComponent(raw)}`;
        }
        if (raw.startsWith('//')) return 'https:' + raw;
        return raw;
    }

    function isPlayableFile(url) {
        return /\.(mp4|webm|m3u8|mkv|mov)([/?#]|$)/i.test(String(url || '')) || /\/get_file\//i.test(String(url || ''));
    }

    function huntPlaybackUrl(container, streamUrl, pageUrl, hlsMode, forceMedia = false, proxySession = '') {
        // Carry source context across redirects and every CDN resource, for
        // all resolved media. Embed pages still use the iframe path.
        if (!forceMedia && !hlsMode && !isPlayableFile(streamUrl)) return streamUrl;
        try { if (/^\/(?:media_proxy\.mp4|hls_proxy(?:\.m3u8)?)$/.test(new URL(streamUrl).pathname)) return streamUrl; } catch (_) { }
        let page;
        try { page = new URL(pageUrl); } catch (_) { return streamUrl; }
        const base = String(container._huntBaseUrl || 'http://127.0.0.1:8000').replace(/\/$/, '');
        const route = hlsMode ? '/hls_proxy.m3u8' : '/media_proxy.mp4';
        const referer = page.href;
        return `${base}${route}?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(referer)}${proxySession ? `&session=${encodeURIComponent(proxySession)}` : ''}`;
    }

    function ensureHuntFrame(modal) {
        let frame = modal.querySelector('.nexus-hunt-modal-frame');
        if (frame) return frame;
        const video = modal.querySelector('.nexus-hunt-modal-video');
        frame = document.createElement('iframe');
        frame.className = 'nexus-hunt-modal-frame';
        frame.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
        frame.setAttribute('allowfullscreen', 'true');
        frame.style.cssText = 'flex:1;width:100%;min-height:280px;border:0;border-radius:12px;background:#000;display:none';
        if (video && video.parentNode) video.parentNode.insertBefore(frame, video);
        return frame;
    }

    function renderHuntComparisonSizes(container, modal) {
        const original = modal.querySelector('.nexus-hunt-original-size');
        const candidate = modal.querySelector('.nexus-hunt-candidate-size');
        const label = bytes => formatSize(bytes) ? `Veľkosť: ${formatSize(bytes)}` : 'Veľkosť neznáma';
        if (original) original.textContent = label(container._huntOriginalMeta?.size_bytes ?? container._huntPayload?.size_bytes ?? container._sizeBytes);
        if (candidate) candidate.textContent = label(modal._activeCard?.size_bytes);
    }

    function huntNativeStream(container, stream) {
        try {
            const url = new URL(stream);
            const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
                (container._huntBaseUrl && url.origin === new URL(container._huntBaseUrl).origin);
            if (local && /^\/(?:media_proxy\.mp4|hls_proxy(?:\.m3u8)?)$/.test(url.pathname)) {
                const direct = url.searchParams.get('url');
                if (direct && /^https?:\/\//i.test(direct)) return direct;
            }
        } catch (_) { }
        return stream;
    }

    function huntCamwhoresErrorVideo(video, pageUrl) {
        try {
            return /(^|\.)camwhores\.tv$/i.test(new URL(pageUrl).hostname) &&
                video.videoWidth === 544 && video.videoHeight === 408 &&
                Math.abs(video.duration - 19.966667) < 0.15;
        } catch (_) { return false; }
    }

    function huntEmbedStream(stream, pageUrl, hlsMode) {
        if (hlsMode || isPlayableFile(stream)) return false;
        try {
            const url = new URL(stream);
            if (!/^https?:$/.test(url.protocol)) return false;
            return url.href === new URL(pageUrl).href || /^\/(?:e|embed)\//i.test(url.pathname);
        } catch (_) { return false; }
    }

    async function loadHuntMedia(container, modal, video, status, stream, pageUrl, hlsMode, original = false, proxySession = '') {
        stream = huntNativeStream(container, stream);
        hlsMode = hlsMode || isHls(stream);
        const token = (video._huntToken || 0) + 1;
        video._huntToken = token;
        const active = () => !modal.hidden && video._huntToken === token && modal._huntContainer === container;
        const key = original ? '_originalHls' : '_hls';
        let refreshed = false, proxied = false, timeout, recovering = false;
        let alternatives = [];
        const clear = () => { clearTimeout(timeout); modal[key]?.destroy(); modal[key] = null; };
        const fail = async () => {
            if (!active() || recovering) return;
            recovering = true;
            try {
                clear();
                if (!refreshed) {
                    refreshed = true;
                    status.textContent = 'Obnovujem stream zo zdroja…';
                    const resolved = await huntMessage({
                        action: 'QUALITY_HUNT_RESOLVE', url: pageUrl, refresh: true,
                        port: container._huntPort, baseUrl: container._huntBaseUrl
                    }, 125000);
                    if (!active()) return;
                    if (resolved.ok) proxySession = resolved.proxySession || '';
                    alternatives = [...new Set((resolved.alternatives || []).map(url => huntNativeStream(container, url)))].filter(url => url !== stream).slice(0, 3);
                    const freshStream = huntNativeStream(container, resolved.streamUrl || '');
                    if (resolved.ok && freshStream && freshStream !== stream) {
                        stream = freshStream; hlsMode = !!resolved.isHls || isHls(stream);
                        if (!original && modal._activeCard) Object.assign(modal._activeCard, { stream_url: stream, is_hls: hlsMode, size_bytes: Number(resolved.sizeBytes || 0) });
                        renderHuntComparisonSizes(container, modal);
                        await arm(); if (active()) start(proxySession ? huntPlaybackUrl(container, stream, pageUrl, hlsMode, true, proxySession) : stream); return;
                    }
                }
                if (alternatives.length) {
                    stream = alternatives.shift(); hlsMode = isHls(stream);
                    status.textContent = 'Skúšam ďalšiu kvalitu toho istého videa…';
                    if (!original && modal._activeCard) Object.assign(modal._activeCard, { stream_url: stream, is_hls: hlsMode, size_bytes: 0 });
                    renderHuntComparisonSizes(container, modal);
                    await arm(); if (active()) start(proxySession ? huntPlaybackUrl(container, stream, pageUrl, hlsMode, true, proxySession) : stream); return;
                }
                if (!proxied) {
                    proxied = true;
                    status.textContent = 'Skúšam prehratie cez Nexus…';
                    start(huntPlaybackUrl(container, stream, pageUrl, hlsMode, true, proxySession));
                    return;
                }
                status.textContent = 'Stream zlyhal aj po obnovení a skúške cez Nexus. Otvor zdroj pre kontrolu prístupu.';
                if (!original) reportHuntPlayback(modal, 'error');
            } finally { recovering = false; }
        };
        const arm = async () => {
            if (!original) await huntMessage({ action: 'QUALITY_HUNT_ARM', streamUrl: stream, pageUrl });
        };
        const start = url => {
            if (!active()) return;
            clear();
            video.onerror = null; video.onplaying = null; video.onloadedmetadata = null;
            video.pause(); video.removeAttribute('src'); video.load();
            if (!original && huntEmbedStream(stream, pageUrl, hlsMode)) {
                const frame = ensureHuntFrame(modal);
                video.style.display = 'none';
                frame.style.display = '';
                frame.src = stream;
                status.textContent = 'Vložený prehrávač zdroja. Spusti Play; prehratie a kvalita zatiaľ nie sú overené.';
                return;
            }
            if (!original) {
                video.style.display = '';
                const frame = modal.querySelector('.nexus-hunt-modal-frame');
                if (frame) { frame.style.display = 'none'; frame.src = 'about:blank'; }
            }
            video.onerror = () => { fail().catch(() => { if (active()) status.textContent = 'Stream sa nepodarilo obnoviť.'; }); };
            video.onloadedmetadata = () => {
                if (!active()) return;
                if (huntCamwhoresErrorVideo(video, pageUrl)) {
                    video.pause();
                    if (!original && modal._activeCard) modal._activeCard.size_bytes = 0;
                    renderHuntComparisonSizes(container, modal);
                    fail().catch(() => { if (active()) status.textContent = 'CamWhores vrátil chybové video. Otvor zdroj pre kontrolu prístupu.'; });
                    return;
                }
                if (original) {
                    container._huntOriginalMeta = { ...container._huntOriginalMeta, height: video.videoHeight, duration_sec: Number.isFinite(video.duration) ? video.duration : 0 };
                    renderHuntWorkbenchState(container, modal);
                } else if (modal._activeCard) {
                    const card = modal._activeCard;
                    if (video.videoHeight) Object.assign(card, { height: video.videoHeight, height_source: 'metadata', quality_state: 'measured' });
                    if (Number.isFinite(video.duration)) {
                        const previous = Number(card.duration_sec || 0), actual = video.duration;
                        if (previous && Math.abs(previous - actual) > Math.max(2, Math.min(20, .08 * Math.max(previous, actual)))) card.size_bytes = 0;
                        card.duration_sec = actual;
                    }
                    renderHuntModalList(container);
                }
                renderHuntComparisonSizes(container, modal);
                status.textContent = `Pripravené${video.videoHeight ? ` · ${video.videoHeight}p` : ''}`;
            };
            video.onplaying = () => {
                if (!active()) return;
                if (huntCamwhoresErrorVideo(video, pageUrl)) { video.pause(); return; }
                clearTimeout(timeout);
                status.textContent = `Prehráva sa${video.videoHeight ? ` · ${video.videoHeight}p` : ''}`;
                if (!original) reportHuntPlayback(modal, 'playing');
            };
            video.onended = () => { if (active()) status.textContent = 'Prehratie skončilo. Výsledky zostávajú dostupné.'; };
            timeout = setTimeout(() => { if (active() && video.readyState < 2) fail().catch(() => { }); }, 15000);
            if (hlsMode && typeof Hls !== 'undefined' && Hls.isSupported()) {
                const hls = new Hls({ xhrSetup: xhr => { xhr.withCredentials = false; } });
                modal[key] = hls;
                hls.on(Hls.Events.MANIFEST_PARSED, () => { if (active()) video.play().catch(() => { status.textContent = 'Pripravené. Stlač Play.'; }); });
                hls.on(Hls.Events.ERROR, (_event, data) => { if (data?.fatal && active() && modal[key] === hls) fail().catch(() => { }); });
                hls.attachMedia(video); hls.loadSource(url);
            } else {
                video.src = url; video.load();
                video.play().catch(() => { if (active() && !video.error) status.textContent = 'Pripravené. Stlač Play.'; });
            }
        };
        await arm();
        if (active()) {
            if (!original && modal._activeCard) Object.assign(modal._activeCard, { stream_url: stream, is_hls: hlsMode });
            const sessionPlayback = !!proxySession;
            if (sessionPlayback) proxied = true;
            status.textContent = sessionPlayback ? 'Načítavam stream cez Nexus…' : 'Načítavam stream priamo zo zdroja…';
            start(sessionPlayback ? huntPlaybackUrl(container, stream, pageUrl, hlsMode, true, proxySession) : stream);
        }
    }

    async function playHuntOriginal(container, modal) {
        const video = modal.querySelector('.nexus-hunt-original-video');
        const status = modal.querySelector('.nexus-hunt-original-status');
        if (video._huntSource && !video.error && video.readyState >= 2) return;
        const token = (video._huntToken || 0) + 1;
        video._huntToken = token;
        const run = container._huntRun;
        const active = () => !modal.hidden && modal._huntContainer === container &&
            container._huntRun === run && video._huntToken === token;
        const bound = container._boundVideo;
        let url = [bound?.currentSrc, container._directUrl, bound?.src].find(value => value && !value.startsWith('blob:')) || '';
        let hlsMode = isHls(url);
        if (!url) {
            url = await resolveDirectUrl(bound).catch(() => '');
            if (!active()) return;
            if (!url || url.startsWith('blob:')) {
                const answer = await huntMessage({
                    action: 'QUALITY_HUNT_RESOLVE', url: container._huntPayload?.page_url || location.href,
                    port: container._huntPort, baseUrl: container._huntBaseUrl
                }, 125000);
                url = answer.streamUrl || ''; hlsMode = !!answer.isHls || isHls(url);
                if (!active()) return;
            } else hlsMode = isHls(url);
        }
        if (!active()) return;
        if (!url) { status.textContent = 'Pôvodný stream sa nepodarilo získať.'; return; }
        if (video._huntSource === url && !video.error && video.readyState >= 2) return;
        video._huntSource = url;
        await loadHuntMedia(container, modal, video, status, url, container._huntPayload?.page_url || location.href, hlsMode, true);
    }

    function reportHuntPlayback(modal, outcome) {
        const owner = modal._huntContainer, card = modal._activeCard;
        const video = modal.querySelector('.nexus-hunt-modal-video');
        if (!owner?._huntJobId || !card?.id || !Array.isArray(owner._huntCandidates)) return;
        const run = owner._huntRun;
        huntMessage({
            action: 'QUALITY_HUNT_REPORT', jobId: owner._huntJobId,
            baseUrl: owner._huntBaseUrl, port: owner._huntPort,
            payload: {
                candidate_id: card.id, outcome, height: video.videoHeight || 0,
                stream_url: card.stream_url || '', is_hls: !!card.is_hls, size_bytes: Number(card.size_bytes || 0),
                duration_sec: Number.isFinite(video.duration) ? video.duration : 0
            }
        }).then(answer => {
            if (answer.ok && owner._huntRun === run) acceptHuntResponse(owner, answer.data);
        });
    }

    function playUrlInHuntModal(modal, url, forceHls) {
        const video = modal.querySelector('.nexus-hunt-modal-video');
        const status = modal.querySelector('.nexus-hunt-modal-status');
        if (!video || !url) return;
        const frame = ensureHuntFrame(modal);
        if (modal._hls) {
            try { modal._hls.destroy(); } catch (_) { }
            modal._hls = null;
        }
        if (!forceHls && !isPlayableFile(url)) {
            video.pause();
            video.removeAttribute('src');
            video.style.display = 'none';
            frame.style.display = 'block';
            frame.src = url;
            if (status) status.textContent = 'Embed prehrávač';
            return;
        }
        frame.style.display = 'none';
        try { frame.src = 'about:blank'; } catch (_) { }
        video.style.display = '';
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.onerror = null;
        video.onplaying = () => {
            if (status) status.textContent = `Prehráva sa${video.videoHeight ? ` · aktuálne ${video.videoHeight}p` : ''}`;
            reportHuntPlayback(modal, 'playing');
        };
        video.onended = () => { if (status) status.textContent = 'Prehratie skončilo. Vyber ďalšiu verziu alebo prehraj znova.'; };
        video.onpause = () => { if (status && !video.ended && video.currentTime > 0) status.textContent = 'Pozastavené'; };
        if (status) status.textContent = 'Načítavam stream…';
        const hlsMode = !!forceHls || isHls(url);
        if (hlsMode && typeof Hls !== 'undefined' && Hls.isSupported()) {
            const hls = new Hls({
                xhrSetup: (xhr) => {
                    try { xhr.withCredentials = false; } catch (_) { }
                },
            });
            modal._hls = hls;
            hls.loadSource(url);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                if (status) status.textContent = 'Pripravené';
                video.play().catch(() => { });
            });
            hls.on(Hls.Events.ERROR, (_e, data) => {
                if (data?.fatal) {
                    hls.destroy();
                    if (modal._hls === hls) modal._hls = null;
                    if (status) status.textContent = `Stream sa nepodarilo prehrať (${data.response?.code || data.details || data.type || 'HLS'}). Skús znova alebo otvor stránku.`;
                    reportHuntPlayback(modal, 'error');
                }
            });
            return;
        }
        video.onerror = () => {
            if (status) status.textContent = 'Prehliadač tento stream nevie prehrať. Otvor stránku.';
            reportHuntPlayback(modal, 'error');
        };
        video.src = url;
        video.load();
        video.play().then(() => {
            if (status) status.textContent = `Prehráva sa${video.videoHeight ? ` · aktuálne ${video.videoHeight}p` : ''}`;
        }).catch(() => {
            if (status && !video.error) status.textContent = 'Klikni play v prehrávači';
        });
    }

    function paintHuntQuality(url, height) {
        if (!url) return;
        const label = Number(height) >= 200 ? `${height}p` : '—';
        document.querySelectorAll('.nexus-hunt-card').forEach(el => {
            if (el.dataset.huntUrl !== url) return;
            const q = el.querySelector('.nexus-hunt-q');
            if (q) q.textContent = label;
        });
    }

    function huntCardsFlat(container) {
        if (Array.isArray(container._huntCandidates)) return container._huntCandidates;
        const groups = container._huntGroups || {};
        return ['better', 'other', 'maybe'].flatMap(key => (groups[key] || []).flatMap(card => [card, ...(card.mirrors || [])]));
    }

    async function enrichHuntQualities(container) {
        if (container._qualityBusy) return;
        const run = container._huntRun;
        const tried = container._huntMetaTried || (container._huntMetaTried = new Set());
        container._qualityBusy = true;
        const port = container._huntPort || selectedHuntPort(container) || 0;
        try {
            while (container._huntRun === run && !container._huntStopped) {
                const urls = [...new Set(huntCardsFlat(container)
                    .filter(c => c?.url && !['metadata', 'library'].includes(c.height_source) && !tried.has(c.url))
                    .map(c => c.url))].slice(0, 16);
                if (!urls.length) break;
                urls.forEach(url => tried.add(url));
                const res = await huntMessage({
                    action: 'QUALITY_HUNT_META', urls, port,
                    jobId: container._huntJobId, baseUrl: container._huntBaseUrl || ''
                }, 95000);
                if (container._huntRun !== run || container._huntStopped) return;
                if (!res.ok) {
                    const status = container.querySelector('.nexus-hunt-status');
                    if (status) status.textContent = 'Výsledky sú dostupné; časť rozlíšení sa nepodarilo overiť.';
                    break;
                }
                if (res.groups) {
                    if (Array.isArray(res.candidates)) acceptHuntResponse(container, res);
                    else renderHuntGroups(container, res.groups);
                }
            }
        } finally {
            container._qualityBusy = false;
            // A previous run may have been resolving when the next one finished.
            if (container._huntRun !== run && !container._huntRunning && !container._huntStopped) {
                enrichHuntQualities(container).catch(() => { });
            }
        }
    }

    function huntMessage(message, timeout = 15000) {
        return new Promise(resolve => {
            const timer = setTimeout(() => resolve({ ok: false, error: 'Časový limit spojenia s Nexus' }), timeout);
            try {
                chrome.runtime.sendMessage(message, answer => {
                    clearTimeout(timer);
                    const error = chrome.runtime.lastError;
                    resolve(error ? { ok: false, error: error.message } : (answer || { ok: false }));
                });
            } catch (error) {
                clearTimeout(timer);
                resolve({ ok: false, error: error.message });
            }
        });
    }

    async function stopQualityHunt(container) {
        container._huntStopped = true;
        const run = container._huntRun;
        const res = container._huntJobId ? await huntMessage({
            action: 'QUALITY_HUNT_CANCEL',
            jobId: container._huntJobId, baseUrl: container._huntBaseUrl, port: container._huntPort
        }) : { ok: true };
        if (container._huntRun !== run) return;
        closeHuntBusy(container);
        const status = container.querySelector('.nexus-hunt-status');
        if (status) status.textContent = res.ok ? 'Zastavené. Dostupné výsledky zostali.' : 'Sledovanie zastavené; Nexus úlohu ukončí po časovom limite.';
        if (res.data?.candidates) acceptHuntResponse(container, res.data);
        renderHuntModalList(container);
        showToast(res.ok ? 'Hľadanie zastavené' : 'Sledovanie zastavené');
        container.querySelector('.nexus-hunt-btn')?.focus();
    }

    async function playHuntCard(container, card) {
        const modal = ensureHuntModal(container);
        const previousVideo = modal.querySelector('.nexus-hunt-modal-video');
        previousVideo._huntToken = (previousVideo._huntToken || 0) + 1;
        previousVideo.pause();
        modal._hls?.destroy(); modal._hls = null;
        if (modal.hidden) modal._returnFocus = document.activeElement;
        modal.hidden = false;
        modal._activeCard = card;
        renderHuntComparisonSizes(container, modal);
        modal._activeUrl = card.url;
        container._huntSelectedId = card.id || card.url;
        modal.querySelector('.nexus-hunt-modal-stage').hidden = false;
        modal.querySelector('.nexus-hunt-comparison-label').textContent = card.title || card.url || 'Prehrávač videa';
        const now = modal.querySelector('.nexus-hunt-modal-now');
        const status = modal.querySelector('.nexus-hunt-modal-status');
        const openBtn = modal.querySelector('.nexus-hunt-modal-open');
        const importBtn = modal.querySelector('.nexus-hunt-modal-import');
        if (now) now.textContent = card.title || card.url || '';
        if (openBtn) openBtn.disabled = !card.url;
        if (importBtn) {
            const state = container._huntImports?.[card.url]?.state;
            importBtn.disabled = !card.url || ['pending', 'success'].includes(state);
            importBtn.textContent = state === 'pending' ? 'Importujem…' : state === 'success' ? 'Importované ✓' : state === 'failed' ? 'Skúsiť import znova' : 'Import';
        }
        if (status) status.textContent = 'Hľadám prehrateľný stream…';
        renderHuntModalList(container);
        modal.querySelector('.nexus-hunt-modal-close').focus();

        const direct = isPlayableFile(card.url);
        let streamUrl = card.stream_url || '';
        let height = Number(card.height || 0);
        let isHlsStream = !!card.is_hls || isHls(streamUrl);
        const isPornhubCard = (() => { try { return /(^|\.)pornhub\.(com|org|net)$/i.test(new URL(card.url).hostname); } catch (_) { return false; } })();
        const isCamwhoresCard = (() => { try { return /(^|\.)camwhores\.tv$/i.test(new URL(card.url).hostname); } catch (_) { return false; } })();
        let proxySession = '';
        if (!direct && (!streamUrl || isPornhubCard || isCamwhoresCard)) {
            const port = container._huntPort || selectedHuntPort(container) || 0;
            const resolved = await huntMessage({
                action: 'QUALITY_HUNT_RESOLVE', url: card.url, refresh: isCamwhoresCard,
                port, baseUrl: container._huntBaseUrl || ''
            }, 125000);
            if (modal._activeCard !== card || modal.hidden) return;
            if (!resolved.ok || !resolved.streamUrl) {
                if (!streamUrl) {
                    if (status) status.textContent = resolved.error || 'Stream sa nepodarilo vytiahnuť. Otvor stránku.';
                    return;
                }
                if (status) status.textContent = 'Nový stream sa nepodarilo získať; skúšam uloženú URL…';
            } else {
                streamUrl = resolved.streamUrl;
                height = Number(resolved.height || height || 0);
                isHlsStream = !!resolved.isHls || isHls(streamUrl);
                proxySession = resolved.proxySession || '';
                card.stream_url = streamUrl;
                card.is_hls = isHlsStream;
                if (resolved.sizeBytes > 0) card.size_bytes = Number(resolved.sizeBytes);
                if (resolved.duration > 0) card.duration_sec = Number(resolved.duration);
                if (height) {
                    card.height = height;
                    card.height_source = 'metadata';
                    paintHuntQuality(card.url, height);
                }
                const run = container._huntRun;
                if (container._huntJobId && !container._huntRunning) {
                    huntMessage({
                        action: 'QUALITY_HUNT_META', urls: [card.url], jobId: container._huntJobId,
                        port, baseUrl: container._huntBaseUrl || ''
                    }, 95000).then(answer => {
                        if (answer.ok && answer.groups && container._huntRun === run) acceptHuntResponse(container, answer);
                    });
                }
            }
        } else if (direct) {
            streamUrl = card.url;
        }
        if (modal._activeCard !== card || modal.hidden) return;
        const frame = ensureHuntFrame(modal);
        frame.style.display = 'none'; frame.src = 'about:blank';
        const candidateVideo = modal.querySelector('.nexus-hunt-modal-video');
        candidateVideo.style.display = '';
        modal._referer = card.url;
        renderHuntComparisonSizes(container, modal);
        await loadHuntMedia(container, modal, candidateVideo, status, streamUrl, card.url, isHlsStream, false, proxySession);
    }

    function selectedHuntPort(container) {
        const open = container?.querySelector('.nexus-port-opt.nexus-port-active');
        if (open?.dataset?.port) return Number(open.dataset.port);
        return 0; // 0 = background findDashboardUrl (8000/8001/8002…)
    }

    function portFromBaseUrl(baseUrl) {
        try {
            const u = new URL(baseUrl);
            return Number(u.port) || 8000;
        } catch (_) {
            return 8000;
        }
    }

    function renderHuntGroups(container, groups) {
        container._huntGroups = groups || {};
        const wrap = container.querySelector('.nexus-hunt-groups');
        if (!wrap) return;
        const summary = huntSummary(container);
        container._huntSourceCount = summary.sources;
        const relevance = container.querySelector('.nexus-hunt-relevance');
        const stillRunning = !!container._huntRunning || container._huntData?.status === 'running';
        const relevanceSignature = `${stillRunning}:${summary.confirmed}:${summary.variants}:${summary.possible}:${summary.similar}:${summary.related}`;
        if (relevance && relevance.dataset.signature !== relevanceSignature) {
            relevance.dataset.signature = relevanceSignature;
            relevance.replaceChildren();
            const headline = document.createElement('strong');
            headline.textContent = stillRunning
                ? (summary.candidates ? `Overujem ${summary.candidates} prijatých kandidátov…` : 'Čakám na prvé kandidáty…')
                : summary.confirmed || summary.variants || summary.possible
                    ? `${summary.confirmed} zhôd dĺžky · ${summary.variants} verzií · ${summary.possible} možných zhôd · ${summary.sources} zdrojov scény`
                    : summary.similar ? `Rovnaký klip sa nenašiel · ${summary.similar} podobných scén (iné video)` : 'Zatiaľ žiadna zhoda scény';
            relevance.appendChild(headline);
            for (const [filter, count, label] of [
                ['same_clip', summary.variants, 'Kratšie/dlhšie verzie'],
                ['verify', summary.possible, 'Možná rovnaká scéna'],
                ['similar', summary.similar, 'Podobné scény · iné video'],
                ['performer', summary.related, 'Iba rovnaký účinkujúci'],
            ]) {
                if (!count) continue;
                const button = document.createElement('button');
                button.type = 'button'; button.className = 'nexus-mini-btn';
                button.textContent = `${label} · ${count}`;
                button.onclick = () => { container._huntFilter = filter; openHuntModal(container); renderHuntModalList(container); };
                relevance.appendChild(button);
            }
        }
        reconcileHuntCards(wrap, container, selectHuntCards(container, 'matches'));
        renderHuntModalList(container);
    }

    function scoreHuntCard(card) {
        const identity = { confirmed: 45, variant: 35, possible: 20, similar: 12, related: 8, unverified: 0, rejected: 0 }[card.identity_state] || 0;
        const confidence = { confirmed: 1, variant: .75, possible: .45, similar: .2, related: .15, unverified: 0, rejected: 0 }[card.identity_state] || 0;
        const played = /prehr[aá]vanie overen[eé] v prehliada[cč]i/i.test(card.availability_reason || '');
        const access = card.availability_state === 'playable' ? played ? 25 : 18 : 0;
        const quality = card.quality_state === 'measured'
            ? { higher: 20, same: 10, lower: 3, unknown: 6 }[card.quality_status] || 6
            : card.quality_state === 'estimated' ? 3 : 0;
        const completeness = (Number(card.duration_sec || 0) > 0 ? 4 : 0) +
            (Number(card.size_bytes || 0) > 0 ? 3 : 0) +
            (card.quality_state === 'measured' && Number(card.height || 0) > 0 ? 3 : 0);
        const factors = [
            { label: 'Zhoda', value: identity, max: 45 },
            { label: 'Prehratie', value: Math.round(access * confidence), max: 25 },
            { label: 'Rozlíšenie', value: Math.round(quality * confidence), max: 20 },
            { label: 'Údaje', value: Math.round(completeness * confidence), max: 10 },
        ];
        const value = factors.reduce((sum, factor) => sum + factor.value, 0);
        const tier = card.identity_state === 'confirmed' && played && value >= 75
            ? 'silny' : card.identity_state === 'confirmed' ? 'overit' : 'nepotvrdeny';
        const label = card.identity_state === 'related' ? 'Iba rovnaký účinkujúci' :
            card.identity_state === 'similar' ? 'Podobná scéna · iné video' :
                card.identity_state === 'variant' ? 'Iná dĺžka tej istej scény' :
                    tier === 'silny' ? 'Silný kandidát' : tier === 'overit' ? 'Overiť prehratie' : 'Zhodu treba overiť';
        return { value, factors, tier, label };
    }

    function formatHuntUploadDate(value) {
        const raw = String(value || '').trim();
        const match = raw.match(/^(\d{4})-?(\d{2})-?(\d{2})(?:$|T| )/);
        return match ? `${match[3]}.${match[2]}.${match[1]}` : raw;
    }

    function huntDomainLabel(card) {
        try { return new URL(card.url).hostname.replace(/^www\./, ''); }
        catch (_) { return card.source || ''; }
    }

    function buildHuntCard(container, card, opts = {}) {
        const el = document.createElement('article');
        el.className = opts.modal ? 'nexus-hunt-card nexus-hunt-card-lg' : 'nexus-hunt-card';
        const domain = huntDomainLabel(card);
        const rawThumb = unwrapThumbUrl(card.thumbnail);
        const fetchThumb = thumbNeedsLocalFetch(rawThumb);
        const thumbBase = String(container._huntBaseUrl || 'http://127.0.0.1:8000').replace(/\/$/, '');
        const thumbUrl = huntThumbSrc(container, card.thumbnail) || rawThumb;
        const thumb = thumbUrl
            ? `<img class="nexus-hunt-thumb" src="${String(thumbUrl).replace(/"/g, '')}" data-domain="${escapeHuntText(domain)}" data-thumb-base="${thumbBase}" ${fetchThumb ? `data-fetch-thumb="${escapeHuntText(rawThumb)}"` : ''} alt="" loading="eager" referrerpolicy="no-referrer">`
            : buildThumbFallbackEl(domain).outerHTML;

        const origH = Number(container._huntOriginalMeta?.height || container._huntPayload?.height || 0);
        const candH = Number(card.height || 0);
        const hasHeight = candH >= 200;
        const isUpgrade = hasHeight && card.quality_status === 'higher';
        const isEstimated = hasHeight && card.quality_state === 'estimated';
        const qualityPill = hasHeight
            ? `<span class="nh-corner nh-corner-tl ${isUpgrade ? 'nh-quality-upgrade' : isEstimated ? 'nh-quality-estimated' : ''}" title="${escapeHuntText(isEstimated ? 'Odhad z názvu súboru' : 'Overené rozlíšenie')}">${isUpgrade ? '▲ ' : isEstimated ? '~' : ''}${candH}p</span>`
            : '';

        const rating = scoreHuntCard(card);
        const isOtherVideo = ['similar', 'related'].includes(card.identity_state);
        const matchPillText = isOtherVideo ? 'Iné video'
            : card.identity_state === 'confirmed' ? `${rating.value} % zhoda`
            : card.identity_state === 'variant' ? 'Zostrih'
            : 'Overiť';
        const matchPillClass = card.identity_state === 'confirmed' ? 'nh-match-strong'
            : card.identity_state === 'possible' ? 'nh-match-verify' : '';

        const durSec = Number(card.duration_sec || 0);
        const durText = durSec > 0 ? `${Math.floor(durSec / 60)}:${String(Math.floor(durSec % 60)).padStart(2, '0')}` : '';
        const dateText = card.upload_date ? formatHuntUploadDate(card.upload_date) : '';
        const sizeText = Number(card.size_bytes || 0) > 0
            ? `${(card.size_bytes / (card.size_bytes >= 1073741824 ? 1073741824 : 1048576)).toFixed(1)} ${card.size_bytes >= 1073741824 ? 'GB' : 'MB'}` : '';
        const bitrateText = formatHuntBitrate(card.size_bytes, durSec);
        const srcDateText = [domain, dateText].filter(Boolean).join(' · ');
        const previewBottomHtml = (durText || srcDateText || sizeText)
            ? `<div class="nh-preview-bottom">
                ${durText ? `<span class="nh-pb-chip nh-pb-dur" title="Dĺžka videa">${escapeHuntText(durText)}</span>` : '<span class="nh-pb-spacer"></span>'}
                ${srcDateText ? `<span class="nh-pb-chip nh-pb-src" title="${escapeHuntText(srcDateText)}">${escapeHuntText(srcDateText)}</span>` : ''}
                ${sizeText ? `<span class="nh-pb-chip nh-pb-size" title="${escapeHuntText(bitrateText ? `Veľkosť súboru (${bitrateText})` : 'Veľkosť súboru')}">${escapeHuntText(sizeText)}</span>` : '<span class="nh-pb-spacer"></span>'}
               </div>`
            : '';

        let verdictText = '';
        let verdictClass = 'is-other';
        if (isUpgrade && origH > 0) {
            verdictText = `Vyššie rozlíšenie · ${origH}p → ${candH}p`;
            verdictClass = 'is-upgrade';
        } else if (isUpgrade) {
            verdictText = `Vyššie rozlíšenie (${candH}p)`;
            verdictClass = 'is-upgrade';
        } else if (card.identity_state === 'confirmed') {
            verdictText = card.quality_status === 'same' && hasHeight ? `Zhodná dĺžka · ${candH}p` : 'Zhodná dĺžka · Rovnaká scéna';
            verdictClass = 'is-match';
        } else if (card.identity_state === 'variant') {
            verdictText = card.variant_kind === 'shorter' ? 'Kratší zostrih tej istej scény' : 'Dlhšia verzia tej istej scény';
            verdictClass = 'is-match';
        } else if (card.identity_state === 'possible') {
            verdictText = 'Možná zhoda · treba prehrať';
            verdictClass = 'is-verify';
        } else if (card.identity_state === 'similar') {
            verdictText = 'Podobná scéna · iné video';
        } else {
            verdictText = 'Iba rovnaký účinkujúci';
        }

        const accessPill = card.availability_state === 'playable'
            ? '<span class="nh-access-pill is-playable">Prehrateľné</span>'
            : card.availability_state === 'login_required'
                ? '<span class="nh-access-pill is-locked">Vyžaduje prístup</span>'
                : card.availability_state === 'unavailable'
                    ? '<span class="nh-access-pill is-locked">Nedostupné</span>'
                    : '';

        const dupPill = card.dup_sources?.length
            ? `<span class="nh-dup-pill is-primary" title="${escapeHuntText(`Rovnaké video nájdené aj na: ${card.dup_sources.join(', ')}`)}">Aj na: ${escapeHuntText(card.dup_sources.slice(0, 2).join(', '))}${card.dup_sources.length > 2 ? ` +${card.dup_sources.length - 2}` : ''}</span>`
            : card.is_dup_secondary
                ? `<span class="nh-dup-pill is-secondary" title="${escapeHuntText(`Duplicitná kópia videa zo zdroja ${card.dup_primary_domain}`)}">Duplikát (${escapeHuntText(card.dup_primary_domain)})</span>`
                : '';

        const isChecked = !!container._huntSelectedUrls?.has(card.url);
        if (isChecked) el.dataset.selected = 'true';
        const reason = card.reason || (card.signals || []).join(' + ') || '';
        el.dataset.huntUrl = card.url || '';
        el.innerHTML = `
            <div class="nexus-hunt-preview" title="Kliknutím spustíš prehrávanie v popupe">
                ${thumb}
                ${qualityPill}
                <span class="nh-corner nh-corner-tr ${matchPillClass}">${escapeHuntText(matchPillText)}</span>
                ${previewBottomHtml}
                <div class="nh-preview-hover" aria-hidden="true"><span>▶ Prehrať</span></div>
            </div>
            <div class="nexus-hunt-body">
                <div class="nexus-hunt-title" title="${escapeHuntText(card.title || '')}">${escapeHuntText(card.title || card.url || '')}</div>
                <div class="nh-verdict-row">
                    <span class="nh-verdict-pill ${verdictClass}">${escapeHuntText(verdictText)}</span>
                    ${accessPill}
                    ${dupPill}
                </div>
                <div class="nexus-hunt-actions">
                    ${opts.modal ? `<label class="nh-card-select" title="Označiť pre hromadný import"><input type="checkbox" class="nh-card-check" ${isChecked ? 'checked' : ''}></label>` : ''}
                    <button type="button" class="nh-btn nh-btn-primary nexus-hunt-play">▶ Prehrať</button>
                    <button type="button" class="nh-btn nh-btn-subtle nexus-hunt-import" ${['pending', 'success'].includes(card.import_result?.state) ? 'disabled' : ''}>${card.import_result?.state === 'pending' ? 'Importujem…' : card.import_result?.state === 'success' ? 'Importované ✓' : card.import_result?.state === 'failed' ? 'Skúsiť znova' : 'Import'}</button>
                    <button type="button" class="nh-btn nh-btn-icon nexus-hunt-open" title="Otvoriť zdrojovú stránku" aria-label="Otvoriť zdrojovú stránku">↗</button>
                </div>
                <div class="nexus-hunt-import-status" role="status">${escapeHuntText(card.import_result?.message || '')}</div>
                <details class="nexus-hunt-evidence">
                    <summary>Viac info a dôkazy</summary>
                    ${isOtherVideo ? '<div class="nexus-hunt-rating-detail">Iné video · bez hodnotenia ako verzia klipu</div>' : `<div class="nexus-hunt-rating-detail" role="group" aria-label="Skóre výberu ${rating.value} zo 100. ${rating.label}.">
                        <div class="nexus-hunt-rating-head"><strong>${rating.label}</strong><span>Skóre ${rating.value}/100</span></div>
                        <div class="nexus-hunt-factors">${rating.factors.map(factor => `<div class="nexus-hunt-factor" role="meter" aria-valuemin="0" aria-valuemax="${factor.max}" aria-valuenow="${factor.value}" aria-label="${factor.label}" title="${factor.label}: ${factor.value} z ${factor.max} bodov"><span>${factor.label}</span><span class="nexus-hunt-factor-track"><i style="width:${Math.round(factor.value / factor.max * 100)}%"></i></span></div>`).join('')}</div>
                    </div>`}
                    <p>${escapeHuntText(reason)}</p>
                    ${(card.evidence || []).map(e => `<p>${escapeHuntText(e.kind)}: ${escapeHuntText(e.reason || '')} (${escapeHuntText(e.source || '')}${e.checked_at ? ', ' + new Date(e.checked_at * 1000).toLocaleTimeString() : ''})</p>`).join('')}
                    ${Object.entries(card.verification || {}).map(([key, value]) => `<p>${escapeHuntText(key)}: ${escapeHuntText(value.status || '')} — ${escapeHuntText(value.reason || '')}</p>`).join('')}
                </details>
            </div>
        `;
        const info = el.querySelector('.nexus-hunt-evidence');
        if (card.mirrors?.length) {
            const details = document.createElement('details');
            const summary = document.createElement('summary');
            summary.textContent = `Ďalšie zrkadlá (${card.mirrors.length})`;
            details.appendChild(summary);
            for (const mirror of card.mirrors) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'nh-btn nh-btn-subtle';
                button.textContent = `${mirror.source || 'Zdroj'}${mirror.height ? ` ${mirror.height}p` : ''}`;
                button.onclick = ev => { ev.stopPropagation(); playHuntCard(container, mirror).catch(err => showToast(err.message, true)); };
                details.appendChild(button);
            }
            info.appendChild(details);
        }
        el.querySelector('.nexus-hunt-preview').onclick = ev => {
            ev.stopPropagation();
            playHuntCard(container, card).catch(err => {
                showToast(`Prehrávanie zlyhalo: ${err?.message || err}`, true);
            });
        };
        const checkEl = el.querySelector('.nh-card-check');
        if (checkEl) {
            checkEl.onclick = ev => ev.stopPropagation();
            checkEl.onchange = () => {
                const selected = container._huntSelectedUrls || (container._huntSelectedUrls = new Set());
                if (checkEl.checked) selected.add(card.url);
                else selected.delete(card.url);
                el.dataset.selected = checkEl.checked ? 'true' : 'false';
                renderHuntWorkbenchState(container, ensureHuntModal(container));
            };
        }
        el.querySelector('.nexus-hunt-play').onclick = ev => {
            ev.stopPropagation();
            playHuntCard(container, card).catch(err => {
                showToast(`Prehrávanie zlyhalo: ${err?.message || err}`, true);
            });
        };
        el.querySelector('.nexus-hunt-open').onclick = ev => {
            ev.stopPropagation();
            window.open(card.url, '_blank', 'noopener,noreferrer');
        };
        el.querySelector('.nexus-hunt-import').onclick = ev => {
            ev.stopPropagation();
            importHuntCard(container, card);
        };
        return el;
    }

    async function importHuntCard(container, card) {
        if (!card.url) return;
        const imports = container._huntImports || (container._huntImports = {});
        if (['pending', 'success'].includes(imports[card.url]?.state)) return;
        const port = selectedHuntPort(container) || container._huntPort || portFromBaseUrl(container._huntBaseUrl) || 8000;
        const update = (state, message) => {
            imports[card.url] = { state, message };
            renderHuntGroups(container, container._huntGroups || {});
            const modal = document.querySelector('.nexus-hunt-modal');
            if (modal?._huntContainer === container && modal._activeCard?.url === card.url) {
                const button = modal.querySelector('.nexus-hunt-modal-import');
                button.disabled = ['pending', 'success'].includes(state);
                button.textContent = state === 'pending' ? 'Importujem…' : state === 'success' ? 'Importované ✓' : 'Skúsiť import znova';
            }
            showToast(message, state === 'failed');
        };
        update('pending', `Importujem: ${card.title || 'video'}…`);
        const res = await huntMessage({
            action: 'IMPORT_VIDEO',
            streamUrl: card.stream_url || card.url,
            port: String(port),
            metadata: {
                title: card.title || 'Quality Hunt',
                sourceUrl: card.url,
                duration: Number(card.duration_sec || 0) || 0,
                thumbnail: card.thumbnail || null,
            },
        }, 180000);
        if (res.ok) update('success', `Importované na port ${port}: ${card.title || 'video'}`);
        else update('failed', `Import zlyhal: ${res.error || 'Nexus nevrátil potvrdenie importu'}`);
    }

    async function importAllHuntCards(container) {
        if (container._huntBulkImporting) return;
        const modal = ensureHuntModal(container);
        const visible = selectHuntCards(container);
        const selected = container._huntSelectedUrls || new Set();
        const selectedVisible = visible.filter(c => c.url && selected.has(c.url));
        const targets = (selectedVisible.length ? selectedVisible : visible)
            .filter(c => c.url && !['pending', 'success'].includes(container._huntImports?.[c.url]?.state));
        if (!targets.length) {
            showToast('Nie sú vybrané žiadne nové videá na import.');
            return;
        }
        container._huntBulkImporting = true;
        const btn = modal.querySelector('.nh-import-all');
        let done = 0;
        try {
            if (btn) btn.disabled = true;
            for (const card of targets) {
                done++;
                if (btn) btn.textContent = `Importujem ${done}/${targets.length}…`;
                await importHuntCard(container, card);
            }
            showToast(`Hromadný import dokončený (${done}/${targets.length})`);
        } finally {
            container._huntBulkImporting = false;
            renderHuntWorkbenchState(container, modal);
        }
    }

    function escapeHuntText(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    async function startQualityHunt(container, options = {}) {
        if (container._huntRunning) return;
        try {
            return await runQualityHunt(container, options);
        } catch (error) {
            closeHuntBusy(container, 'Skús znova');
            const status = container.querySelector('.nexus-hunt-status');
            if (status) status.textContent = `Chyba: ${error?.message || error}`;
            renderHuntModalList(container);
            throw error;
        }
    }

    async function runQualityHunt(container, options = {}) {
        const retryPayload = options.retry_job_id ? container._huntPayload : null;
        const previousModal = document.querySelector('.nexus-hunt-modal');
        if (previousModal && previousModal._huntContainer === container) {
            closeHuntModal(previousModal);
            previousModal.querySelector('.nexus-hunt-modal-stage').hidden = true;
        }
        container._huntRunning = true;
        const run = (container._huntRun || 0) + 1;
        container._huntRun = run;
        container._huntStopped = false;
        container._huntJobId = '';
        container._huntMetaTried = new Set();
        container._huntGroups = {};
        container._huntCandidates = null;
        container._huntData = {};
        container._huntFilter = 'matches';
        container._huntSelectedId = null;
        container._huntSelectedUrls = new Set();
        container._huntOriginalMeta = null;
        const video = container._boundVideo;
        const panel = container.querySelector('.nexus-hunt-panel');
        const status = container.querySelector('.nexus-hunt-status');
        const groupsEl = container.querySelector('.nexus-hunt-groups');

        const title = collectBestTitle(video);
        let frames = [];
        try {
            frames = await captureHuntFrames(video, container);
        } catch (_) {
            frames = [];
        }

        openHuntPanel(container, 'Pripravujem lov…');
        openHuntModal(container);
        const workbench = ensureHuntModal(container);
        const kwInput = workbench.querySelector('.nexus-hunt-workbench-keywords');
        const perfInput = workbench.querySelector('.nexus-hunt-workbench-performer');
        if (kwInput) kwInput.value = container.querySelector('.nexus-hunt-keywords')?.value || '';
        if (perfInput) perfInput.value = container.querySelector('.nexus-hunt-performer')?.value || '';
        syncHuntPresetUI(container, workbench);
        const fastStatusEl = workbench.querySelector('.nexus-hunt-fast-status');
        if (fastStatusEl) fastStatusEl.textContent = '';
        if (groupsEl) {
            groupsEl.innerHTML = '<div class="nexus-hunt-empty">Posielam na dashboard…</div>';
        }
        if (status) status.textContent = frames.length ? `Snímka OK (${frames.length}) · ${title.slice(0, 40)}` : `Bez snímky · ${title.slice(0, 40)}`;

        const knownDuration = Number(video?.duration) || getBestKnownDuration(video) || 0;
        const candidateStream = [container._directUrl, video?.currentSrc, video?.src]
            .map(u => String(u || '').trim())
            .find(u => /^https?:\/\//i.test(u) && !u.startsWith('blob:')) || '';
        const payload = {
            title,
            page_url: window.location.href,
            stream_url: candidateStream,
            duration_sec: Number.isFinite(knownDuration) ? knownDuration : 0,
            height: Number(video?.videoHeight) || 0,
            size_bytes: 0,
            thumbnail_url: findThumbnail(video) || '',
            poster_url: video?.poster || '',
            frames,
            frame_jpeg: frames[0] || '',
            mode: container.querySelector('.nexus-hunt-mode')?.value || 'quick',
            manual_keywords: container.querySelector('.nexus-hunt-keywords')?.value.trim() || '',
            performer: container.querySelector('.nexus-hunt-performer')?.value.trim() || '',
            visual_only: !!container.querySelector('.nexus-hunt-visual-only')?.checked,
            allow_visual_search: !!container.querySelector('.nexus-hunt-visual')?.checked || !!container.querySelector('.nexus-hunt-visual-only')?.checked,
            force_refresh: !!options.force_refresh,
            retry_job_id: options.retry_job_id || '',
            coverage_target: container._coverageTarget ?? 5,
        };
        if (retryPayload) {
            Object.assign(payload, retryPayload, {
                force_refresh: true, retry_job_id: options.retry_job_id,
                coverage_target: container._coverageTarget ?? 5
            });
        }
        container._huntPayload = payload;
        const reference = container.querySelector('.nexus-hunt-reference');
        if (reference) reference.textContent = `Pôvodné video: ${payload.height ? `${payload.height}p` : 'rozlíšenie neznáme'}${payload.duration_sec ? ` · ${Math.floor(payload.duration_sec / 60)}:${String(Math.floor(payload.duration_sec % 60)).padStart(2, '0')}` : ''} · ${title}`;

        const sizeText = container.querySelector('.nexus-size-value')?.textContent || '';
        const sizeMatch = sizeText.match(/([\d.]+)\s*(MB|GB)/i);
        if (container._sizeBytes > 0 && !retryPayload) {
            payload.size_bytes = container._sizeBytes;
        } else if (sizeMatch && !retryPayload) {
            let mb = parseFloat(sizeMatch[1]);
            if (/gb/i.test(sizeMatch[2])) mb *= 1024;
            payload.size_bytes = Math.round(mb * 1024 * 1024);
        }

        if (status) status.textContent = 'Volám dashboard :8000…';
        let port = selectedHuntPort(container);

        const startRes = await huntMessage({ action: 'QUALITY_HUNT_START', port, payload });
        if (container._huntRun !== run || container._huntStopped) {
            if (startRes.ok && startRes.data?.job_id) await huntMessage({
                action: 'QUALITY_HUNT_CANCEL',
                jobId: startRes.data.job_id, port, baseUrl: startRes.baseUrl
            });
            return null;
        }
        if (!startRes.ok) {
            if (status) status.textContent = `Chyba: ${startRes.error}`;
            if (groupsEl) {
                groupsEl.innerHTML = `<div class="nexus-hunt-empty nexus-hunt-error">${escapeHuntText(startRes.error || 'štart zlyhal')}</div>`;
            }
            closeHuntBusy(container, 'Skús znova');
            renderHuntModalList(container);
            showToast(`Lov zlyhal: ${startRes.error}`, true);
            throw new Error(startRes.error || 'start failed');
        }

        const jobId = startRes.data?.job_id;
        const baseUrl = startRes.baseUrl || '';
        if (baseUrl) {
            port = portFromBaseUrl(baseUrl);
            container._huntPort = port;
            container._huntBaseUrl = baseUrl;
        }
        if (!jobId) {
            closeHuntBusy(container, 'Skús znova');
            throw new Error('chýba job_id');
        }
        container._huntJobId = jobId;
        if (container._huntStopped || container._huntRun !== run) {
            await huntMessage({ action: 'QUALITY_HUNT_CANCEL', jobId, port, baseUrl });
            return null;
        }
        if (status) status.textContent = `Beží na :${port}…`;
        if (groupsEl) {
            groupsEl.innerHTML = '<div class="nexus-hunt-empty">Čakám na prvé výsledky…</div>';
        }
        showToast(`Lov beží na porte ${port}`);

        const deadline = Date.now() + (payload.mode === 'deep' ? 180000 : 90000);
        while (Date.now() < deadline) {
            if (container._huntStopped || container._huntRun !== run) return null;
            const poll = await huntMessage({ action: 'QUALITY_HUNT_POLL', port, jobId, baseUrl });
            if (container._huntStopped || container._huntRun !== run) return null;
            if (!poll.ok) {
                if (status) status.textContent = `Poll: ${poll.error || 'error'}`;
                await new Promise(r => setTimeout(r, 1200));
                continue;
            }
            const data = poll.data || {};

            const phase = data.progress?.message || data.progress?.phase || data.status;
            if (data.identity?.performer) {
                const wbPerf = document.querySelector('.nexus-hunt-modal .nexus-hunt-workbench-performer');
                if (wbPerf && !wbPerf.value && document.activeElement !== wbPerf) wbPerf.value = data.identity.performer;
            }
            acceptHuntResponse(container, data);
            if (status) {
                const live = huntSummary(container);
                status.textContent = data.status === 'running'
                    ? `${phase || 'Hľadám'} · ${live.candidates ? `${live.candidates} kandidátov` : 'hľadám…'}`
                    : `${phase || data.status}`;
            }
            const diagnostics = container.querySelector('.nexus-hunt-diagnostics div');
            if (diagnostics) diagnostics.textContent = (data.diagnostics || []).map(d => `${d.source || d.source_key || 'zdroj'}: ${d.status || 'OK'}${d.count != null ? ` (${d.count})` : ''}${d.error ? ` – ${String(d.error).slice(0, 140)}` : ''}`).join('\n');
            if (['done', 'degraded', 'error', 'partial', 'cancelled'].includes(data.status)) {
                if (data.status === 'error' && status) {
                    status.textContent = data.error || 'Chyba';
                    closeHuntBusy(container, 'Skús znova');
                } else if (status) {
                    const counts = huntSummary(container);
                    const totalMatched = counts.confirmed + counts.variants + counts.possible;
                    const relatedTotal = counts.similar + counts.related;
                    if (!totalMatched && relatedTotal > 0 && container._huntFilter === 'matches') {
                        container._huntFilter = 'similar_all';
                    }
                    status.textContent = totalMatched
                        ? `${counts.improvements ? `${counts.improvements} lepších · ` : ''}${totalMatched} zhôd (${counts.sources} zdrojov)`
                        : relatedTotal
                            ? `Rovnaký klip sa nenašiel · ${relatedTotal} podobných videí účinkujúceho`
                            : (data.status === 'degraded' || data.status === 'partial' ? 'Časť zdrojov zlyhala' : 'Žiadne zhody');
                    closeHuntBusy(container);
                    showToast(totalMatched ? `Nájdené verzie klipu: ${totalMatched}` : relatedTotal ? `Rovnaký klip sa nenašiel · zobrazujem ${relatedTotal} podobných videí účinkujúceho` : 'Rovnaký klip sa zatiaľ nenašiel. Skús upresniť dotaz alebo obrazové hľadanie.');
                    if (data.status !== 'cancelled') {
                        if (!Array.isArray(data.candidates)) enrichHuntQualities(container).catch(() => { });
                        else if (!container._huntStopped) fastFetchHuntCards(container, 4).catch(() => { });
                    }
                }
                renderHuntModalList(container);
                return data;
            }
            await new Promise(r => setTimeout(r, 900));
        }
        await stopQualityHunt(container);
        if (status) status.textContent = 'Časový limit spojenia – dostupné výsledky zostali.';
        return null;
    }

    // ── Import ─────────────────────────────────────────────────────────────────

    async function handleImport(video, port, directUrl) {
        // MEGA Native Bridge: on mega.nz just save the permanent link — the
        // dashboard decrypts + streams on demand, so it always replays later.
        if (/(^|\.)mega\.nz$/i.test(location.hostname)) {
            const isFolder = /\/folder\//i.test(location.href) || /#F!/.test(location.href);
            showToast(isFolder ? `Saving MEGA album to port ${port}...` : `Saving MEGA video to port ${port}...`);
            chrome.runtime.sendMessage(
                { action: 'MEGA_NATIVE_ADD', url: location.href, port },
                res => {
                    if (res?.ok) {
                        const d = res.data || {};
                        if (res.kind === 'folder') showToast(`Album saved: ${d.added} video(s) → port ${port}!`);
                        else showToast(d.status === 'exists' ? 'Already in library.' : `MEGA video saved to port ${port}!`);
                    } else {
                        showToast(`Failed: ${res?.error || 'Unknown error'}`, true);
                    }
                }
            );
            return;
        }

        let knownSize = knownImportSizeBytes(_overlayEl);
        if (isBunkrPage(window.location.href)) {
            const pageSize = parseBunkrDisplayedSize(_overlayEl?._boundVideo);
            if (pageSize > 0) {
                knownSize = pageSize;
                _overlayEl._sizeBytes = pageSize;
            }
        }
        if (isBelowMinimumImportSize(knownSize)) {
            if (!isBunkrPage(window.location.href)) {
                return showToast(
                    `Import blocked: ${formatSize(knownSize)} is below the 10 MB minimum.`,
                    true
                );
            }
        }

        showToast(`Importing to port ${port}...`);

        let streamUrl = String(directUrl || '').trim();
        if (!streamUrl || streamUrl.startsWith('blob:')) {
            const fromBg = await new Promise(r =>
                chrome.runtime.sendMessage({
                    action: 'GET_CAPTURED_STREAM',
                    pageUrl: window.location.href,
                    duration: Math.round(video?.duration) || 0
                }, res => r(String(res?.streamUrl || '').trim()))
            );
            if (fromBg && !fromBg.startsWith('blob:')) streamUrl = fromBg;
        }
        const isFileditch = isFileditchViewerPage();
        if ((!streamUrl || streamUrl.startsWith('blob:')) && isFileditch) {
            // FileDitch's apparent .mp4 URL is a protected viewer page, not a
            // browser-copyable stream. The Nexus extractor can resolve that page
            // with the synced browser cookies, so pass the stable page URL through.
            streamUrl = window.location.href;
            showToast('FileDitch: posielam URL stránky do Nexus…');
        }
        if (!streamUrl || streamUrl.startsWith('blob:')) {
            return showToast('Could not resolve video URL.', true);
        }

        const duration = getBestKnownDuration(video);
        let title = collectBestTitle(video);
        if (!title || title === 'video') {
            title = String(document.title || '').replace(/\s*(?:-|\|)\s*(?:Bunkr|Balbums|MEGA)\b.*$/i, '').trim() || 'video';
        }
        const metadata = {
            title,
            sourceUrl: window.location.href,
            duration,
            // FileDitch posters are often short-lived or unavailable. Let Nexus
            // generate a local thumbnail from a fresh resolved stream instead.
            thumbnail: isFileditch ? null : findThumbnail(video),
            autoRethumb: isFileditch,
        };

        chrome.runtime.sendMessage({ action: 'IMPORT_VIDEO', streamUrl, port, metadata }, res => {
            if (res?.ok) showToast(`Imported to port ${port}!`);
            else showToast(`Failed: ${res?.error || 'Unknown error'}`, true);
        });
    }

    function enqueueSidecarOnPage(items, playNow = false) {
        return new Promise((resolve, reject) => {
            const requestId = `nexus-gallery-sidecar-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const timer = window.setTimeout(() => {
                window.removeEventListener('message', onResult);
                reject(new Error('Sidecar bridge did not respond.'));
            }, 5000);
            function onResult(event) {
                if (event.source !== window || event.origin !== window.location.origin) return;
                const data = event.data;
                if (data?.type !== 'NEXUS_SIDECAR_RESULT' || data.requestId !== requestId) return;
                window.clearTimeout(timer);
                window.removeEventListener('message', onResult);
                if (data.result?.ok) resolve(data.result);
                else reject(new Error(data.result?.error || 'Sidecar rejected the request.'));
            }
            window.addEventListener('message', onResult);
            window.postMessage({ type: 'NEXUS_SIDECAR_ENQUEUE', requestId, items, playNow }, window.location.origin);
        });
    }

    async function sendCurrentToSidecar(video, directUrl) {
        const sourceUrl = window.location.href;
        const streamUrl = String(directUrl || '').trim();
        const itemUrl = streamUrl && !streamUrl.startsWith('blob:') ? streamUrl : sourceUrl;
        const isMega = /(^|\.)mega\.nz$/i.test(location.hostname);
        const isFolder = isMega && (/\/folder\//i.test(sourceUrl) || /#F!/.test(sourceUrl));
        const item = {
            url: itemUrl,
            streamUrl: itemUrl,
            source_url: sourceUrl,
            title: String(document.title || '').replace(/\s*(?:-|\|)\s*MEGA\s*$/i, '').trim() || (isFolder ? 'MEGA album' : 'Video'),
            thumbnail: findThumbnail(video),
            duration: getBestKnownDuration(video),
        };
        showToast(`Sending ${isFolder ? 'MEGA album' : 'video'} to Sidecar...`);
        try {
            const res = await enqueueSidecarOnPage([item]);
            const duplicateText = res.duplicates ? ' (already queued)' : '';
            showToast(`Sidecar: added ${res.added || 0}${duplicateText}`);
        } catch (error) {
            showToast(`Sidecar failed: ${error?.message || 'Unknown error'}`, true);
        }
    }

    function findThumbnail(video) {
        if (video?.poster) return video.poster;
        return document.querySelector('meta[property="og:image"]')?.content || null;
    }

    function showToast(text, isError = false) {
        let toast = document.querySelector('.nexus-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.className = 'nexus-toast';
            document.body.appendChild(toast);
        }
        toast.style.borderColor = isError ? 'rgba(255,50,50,0.6)' : 'rgba(0,255,127,0.4)';
        // The hunt modal uses the same top z-index; keep notifications after it.
        document.body.appendChild(toast);
        toast.innerText = text;
        toast.classList.add('visible');
        setTimeout(() => toast.classList.remove('visible'), 4000);
    }

    // ── Scanner ────────────────────────────────────────────────────────────────

    function getBestVideo() {
        if (_manualVideo?.isConnected) return _manualVideo;
        const lenientPage = isLenientMediaPage();
        const candidates = Array.from(document.querySelectorAll('video')).filter(v => {
            // Never bind to our own overlay player instance.
            if (v.closest('.nexus-import-overlay, .nexus-hunt-modal')) return false;
            if (v.dataset.nexusImporterActive) return false;
            // Skip videos too small to be the main player
            const rect = v.getBoundingClientRect();
            const w = rect.width || v.videoWidth || v.offsetWidth || 0;
            const h = rect.height || v.videoHeight || v.offsetHeight || 0;
            if (!lenientPage && (w < MIN_WIDTH_PX || h < MIN_HEIGHT_PX)) return false;
            if (lenientPage && (w < 120 || h < 90) && !String(v.currentSrc || v.src || '').trim()) return false;
            if (isLikelyHoverPreviewVideo(v)) return false;
            return true;
        });
        if (!candidates.length) return null;
        // Prefer the largest by rendered area
        candidates.sort((a, b) => {
            const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
            return (rb.width * rb.height) - (ra.width * ra.height);
        });
        return candidates[0];
    }

    // Direct MP4 exposed in page <meta> (VK-mirror / KVS players like ukdevilz):
    // the <video> only appears after clicking play, but the stream URL is known
    // from page load — surface the panel immediately so import works pre-play.
    function getMetaStreamUrl() {
        const sels = [
            'meta[property="ya:ovs:content_url"]',
            'meta[property="og:video:secure_url"]',
            'meta[property="og:video:url"]',
            'meta[property="og:video"]',
            'meta[itemprop="contentURL"]',
        ];
        for (const sel of sels) {
            const v = String(document.querySelector(sel)?.getAttribute('content') || '').trim();
            if (v && /\.(mp4|m3u8|webm|mkv|m4v)(?:[?#]|$)/i.test(v) && !v.startsWith('blob:')) {
                try { return new URL(v, window.location.href).href; } catch { return v; }
            }
        }
        // Pixeldrain may create its player lazily. The public API media URL
        // is stable and can be offered immediately on /u/<id> pages.
        const pixeldrainMatch = /(?:^|\.)pixeldrain\.com$/i.test(window.location.hostname || '')
            ? String(window.location.pathname || '').match(/^\/u\/([a-z0-9_-]+)\/?$/i) : null;
        if (pixeldrainMatch) return `https://pixeldrain.com/api/file/${pixeldrainMatch[1]}`;

        if (/(?:^|\.)leakedzone\.com$/i.test(window.location.hostname || '')) {
            for (const s of document.scripts) {
                const m = (s.textContent || '').match(/file:\s*f\(["']([^"']+)["']\)/);
                if (m) {
                    try {
                        const trimmed = String(m[1]).slice(16, -16);
                        const reversed = trimmed.split('').reverse().join('');
                        const decoded = atob(reversed);
                        if (decoded && (decoded.startsWith('http://') || decoded.startsWith('https://'))) {
                            return decoded;
                        }
                    } catch { }
                }
            }
        }
        return '';
    }
    let _metaPanelShown = false;

    let internetChicksSelectionRun = 0;
    function showInternetChicksPlayer(button) {
        const selected = String(button.getAttribute('onclick') || '').match(/playEmbed\(['"](https?:\/\/[^'"]+)['"]\)/i)?.[1];
        if (!selected) return;
        let embedUrl;
        try { embedUrl = new URL(selected).href; } catch { return; }
        const run = ++internetChicksSelectionRun;
        _panelDismissed = false;
        const container = getOrCreateOverlay();
        container._directBindRun = (container._directBindRun || 0) + 1;
        container._boundVideo = null;
        container._directUrl = '';
        container._sizeBytes = 0;
        container.style.display = 'flex';
        container.classList.add('nexus-open');
        container.querySelector('.nexus-size-value').textContent = 'Overujem vybraný player…';
        const importButton = container.querySelector('.nexus-import-btn');
        if (importButton) importButton.style.display = 'none';
        setPlayerStatus(container, 'Hľadám priamy stream vybraného playera.');
        chrome.runtime.sendMessage({ action: 'INTERNETCHICKS_RESOLVE_PLAYER', embedUrl }, response => {
            if (run !== internetChicksSelectionRun || _panelDismissed) return;
            if (chrome.runtime.lastError || !response?.ok || !isPlayableStreamUrl(response.streamUrl)) {
                container.querySelector('.nexus-size-value').textContent = 'Stream zatiaľ neoverený';
                setPlayerStatus(container, 'Spusti prehrávanie vo vybranom playeri; panel zachytí stream.');
                return;
            }
            const candidate = makePseudoMediaCandidate(response.streamUrl);
            candidate.dataset.nexusInternetChicksSelected = 'true';
            candidate.dataset.nexusFramePageUrl = embedUrl;
            candidate.dataset.nexusImporterActive = 'true';
            bindVideoToOverlay(candidate, true).catch(error => showToast(error.message, true));
        });
    }

    if (IS_TOP_FRAME) {
        document.addEventListener('click', event => {
            if (!isInternetChicksVideoPage()) return;
            const button = event.target.closest?.('.button_choice_server');
            if (button) showInternetChicksPlayer(button);
        });
    }

    function scanVideos() {
        if (_manualVideo?.isConnected) return;
        if (_manualVideo) _manualVideo = null;
        if (IS_TOP_FRAME && shouldSuppressFastImport()) {
            hideFastImportPanel();
            return;
        }
        const video = getBestVideo();
        if (!video) {
            if (!IS_TOP_FRAME && _iframeObservedVideo?.isConnected && !_iframeObservedVideo.dataset.nexusRelayedUrl) {
                relayVideoToTopFrame(_iframeObservedVideo).catch(() => { });
                return;
            }
            // The article adds its iframe only after choosing a server. Its
            // click handler opens the panel for that exact choice.
            if (isInternetChicksVideoPage()) return;
            // No <video> yet — but a direct MP4 in <meta> means we can already
            // offer import (KVS/VK-mirror players inject <video> only on play).
            if (IS_TOP_FRAME && !_metaPanelShown && !_panelDismissed) {
                const metaUrl = getMetaStreamUrl();
                if (metaUrl) {
                    _metaPanelShown = true;
                    const candidate = makePseudoMediaCandidate(metaUrl);
                    candidate.dataset.nexusImporterActive = 'true';
                    console.log('Nexus: main direct stream found in metadata →', metaUrl.slice(0, 80));
                    bindVideoToOverlay(candidate).catch(() => { });
                    return;
                }
            }
            const fallback = isLenientMediaPage() ? getBestLenientFallbackCandidate() : null;
            if (!fallback) return;
            createOverlay(fallback);
            return;
        }

        // vTube uses MSE and may leave duration as NaN/0 until well after the
        // blob-backed <video> is added.  The video is still the only primary
        // player on this host, so show the panel immediately; its Import action
        // resolves the real URL from the background capture after playback.
        if (isVtbePage()) {
            createOverlay(video);
            return;
        }

        if (video.duration && video.duration < MIN_DURATION) return;

        if (typeof video.addEventListener !== 'function' || isNaN(video.duration)) {
            // A visible primary player can still be searched while its stream
            // metadata is delayed or unavailable. createOverlay binds the later
            // loadedmetadata event and updates the measured duration then.
            createOverlay(video);
        } else {
            createOverlay(video);
        }
    }

    function showMegaFolderOverlay() {
        if (!isMegaFolderPage()) return;
        hideFastImportPanel();
    }

    let scanQueued = false;
    function scheduleScan() {
        if (scanQueued) return;
        scanQueued = true;
        requestAnimationFrame(() => {
            scanQueued = false;
            scanVideos();
        });
    }

    try {
        const observer = new MutationObserver((mutations) => {
            // Ignore mutations caused by our own overlay to prevent feedback loops
            const fromOverlay = mutations.every(m => m.target.closest?.('.nexus-import-overlay, .nexus-hunt-modal') ||
                (_overlayEl && (_overlayEl === m.target || _overlayEl.contains(m.target))));
            if (!fromOverlay) scheduleScan();
        });
        if (document.documentElement) {
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['src', 'class', 'style', 'poster']
            });
        }
        window.addEventListener('pageshow', scheduleScan, { passive: true });
        window.addEventListener('focus', scheduleScan, { passive: true });
        window.addEventListener('hashchange', scheduleScan, { passive: true });
        window.addEventListener('popstate', scheduleScan, { passive: true });
        document.addEventListener('loadedmetadata', scheduleScan, true);
        document.addEventListener('playing', scheduleScan, true);
    } catch { }

    // ── Top-frame relay: show the panel for a stream found inside a player
    // iframe (filemoon, streamtape, hrnytube, …) on embed-based sites such as
    // hornysimp / fileditch, where the top page itself has no <video>. ────────
    if (IS_TOP_FRAME) {
        const isMainRelaySource = (sourceWindow) => {
            if (isLikelySingleVideoRoute()) return true;
            if (sourceWindow === window) return hasVisiblePrimaryMediaSurface();
            const frames = Array.from(document.querySelectorAll('iframe, frame'));
            let probe = sourceWindow;
            while (probe && probe !== window) {
                const sourceFrame = frames.find((frame) => {
                    try { return frame.contentWindow === probe; } catch { return false; }
                });
                if (sourceFrame) return isVisiblePrimaryMediaNode(sourceFrame);
                try {
                    if (!probe.parent || probe.parent === probe) break;
                    probe = probe.parent;
                } catch {
                    break;
                }
            }
            return false;
        };
        let _lastRelayUrl = '';
        window.addEventListener('message', (event) => {
            const d = event.data;
            if (!d || typeof d !== 'object') return;
            // Accept both our own relay and the PH player interceptor, which
            // captures blob/MSE streams from doodstream / filemoon / jwplayer
            // embeds (erofans-style pages) that have no readable <video>.src.
            const isOurs = d.type === NEXUS_IFRAME_MSG;
            const isPh = d.action === 'PH_PLAYER_STREAM';
            if (!isOurs && !isPh) return;
            if (isInternetChicksVideoPage()) {
                const activeEmbed = document.querySelector('#main-player')?.src || '';
                const reportedEmbed = String(d.playerUrl || d.framePageUrl || '');
                if (activeEmbed && reportedEmbed && activeEmbed.split('#')[0] !== reportedEmbed.split('#')[0]) return;
            }
            if (shouldSuppressFastImport() || !isMainRelaySource(event.source)) {
                hideFastImportPanel();
                return;
            }
            // A PH-captured stream is authoritative (real player lives in the
            // embed iframe). For our own relay, defer to a real top-frame player
            // if one exists to avoid duplicate panels.
            if (isOurs && getBestVideo()) return;
            const url = String((isPh ? d.streamUrl : d.directUrl) || '').trim();
            if (!url || url === _lastRelayUrl) return;
            if (_panelDismissed) return;
            _lastRelayUrl = url;

            const candidate = makePseudoMediaCandidate(url);
            if (Number(d.duration || 0) > 0) candidate.duration = Math.round(Number(d.duration));
            if (d.poster) candidate.poster = String(d.poster);
            candidate.dataset.nexusFramePageUrl = String(d.playerUrl || d.framePageUrl || window.location.href);
            candidate.dataset.nexusImporterActive = 'true';
            console.log('Nexus: main direct iframe stream found →', url.slice(0, 80));
            bindVideoToOverlay(candidate).catch(() => { });
        }, false);
    }

    // ── XVideos "Related playlists" fast fetch ──────────────────────────────
    // Adds a small "⚡ Fast fetch" button to every playlist card in the
    // #related-playlists tab. On click it asks the backend to sample the
    // playlist's own first page (server-side, see PROBE_PLAYLIST in
    // background.js / app/routers/playlist_probe.py) and renders the result
    // as a badge on the card — video count, avg duration, avg size estimate,
    // last-updated text if the site exposes one. Nothing is fetched until the
    // user clicks: with 20+ playlist cards per video, auto-fetching all of
    // them would hammer both xvideos and the backend for no reason.
    const PLAYLIST_PROBE_ATTR = 'data-nexus-playlist-probe';

    function isXVideosWatchPage() {
        return /(?:^|\.)xvideos\.(?:com|red)$/i.test(window.location.hostname);
    }

    function findRelatedPlaylistCards() {
        // The tab content lives under an id containing "related-playlist"
        // (xvideos ships it as `#related-playlists`); fall back to scanning
        // any anchor whose href matches the site's playlist URL shape
        // (`/favorite/{id}/...`) so a markup tweak doesn't silently break this.
        const scope = document.querySelector('[id*="related-playlist" i]') || document;
        const cards = new Set();
        scope.querySelectorAll('a[href*="/favorite/"]').forEach(anchor => {
            const card = anchor.closest('div.thumb-block, li, .playlist-item') || anchor.parentElement;
            if (card) cards.add(card);
        });
        return [...cards];
    }

    function formatPlaylistBadge(data) {
        const parts = [];
        if (data.video_count) parts.push(`${data.video_count} videí`);
        if (data.avg_duration) parts.push(`⌀ ${data.avg_duration}`);
        if (data.avg_size_mb) {
            const size = data.avg_size_mb >= 1024
                ? `${(data.avg_size_mb / 1024).toFixed(2)} GB`
                : `${data.avg_size_mb.toFixed(0)} MB`;
            parts.push(`⌀ ${size}${data.size_estimated ? ' (odhad)' : ''}`);
        }
        if (data.last_updated) parts.push(data.last_updated);
        return parts.join(' · ') || 'Žiadne dáta';
    }

    function addFastFetchButton(card) {
        if (!card || card.hasAttribute(PLAYLIST_PROBE_ATTR)) return;
        const anchor = card.querySelector('a[href*="/favorite/"]');
        if (!anchor) return;
        card.setAttribute(PLAYLIST_PROBE_ATTR, 'true');
        card.style.position = card.style.position || 'relative';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '⚡ Fast fetch';
        btn.title = 'Rýchlo zisti počet videí, priemernú dĺžku a veľkosť tohto playlistu';
        btn.style.cssText = 'position:absolute;top:6px;right:6px;z-index:50;padding:4px 8px;'
            + 'border:1px solid #5a8fd6;border-radius:6px;background:rgba(10,20,35,.92);'
            + 'color:#dff0ff;font:600 11px Arial,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4)';

        const badge = document.createElement('div');
        badge.style.cssText = 'margin-top:4px;font-size:11px;color:#9fd0f5;line-height:1.4';

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const url = new URL(anchor.getAttribute('href'), window.location.href).href;
            btn.disabled = true;
            btn.textContent = 'Načítavam…';
            chrome.runtime.sendMessage({ action: 'PROBE_PLAYLIST', url }, (res) => {
                btn.disabled = false;
                if (res?.ok) {
                    btn.textContent = '⚡ Fast fetch';
                    badge.textContent = formatPlaylistBadge(res.data || {});
                } else {
                    btn.textContent = 'Skús znova';
                    badge.textContent = res?.error || 'Fetch zlyhal';
                }
            });
        });

        card.appendChild(btn);
        const titleHost = card.querySelector('.title, p.title') || card;
        titleHost.appendChild(badge);
    }

    function scanRelatedPlaylists() {
        if (!isXVideosWatchPage()) return;
        findRelatedPlaylistCards().forEach(addFastFetchButton);
    }

    showMegaFolderOverlay();
    scheduleScan();
    scanRelatedPlaylists();
    setInterval(scheduleScan, SCAN_INTERVAL);
    setInterval(scanRelatedPlaylists, SCAN_INTERVAL);

})();
