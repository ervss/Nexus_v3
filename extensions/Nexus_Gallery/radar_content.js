/* ============================================================
   NEXUS RADAR — content script
   ------------------------------------------------------------
   While you browse a supported site, every video link gets a
   badge telling you where it stands against your library:

       ✓  (green)  already in the library
       ◌  (amber)  waiting in the discovery review queue
       ＋ (hover)  unknown → one-click import to Nexus

   Batched lookups via background → /api/v1/radar/check.
   Handles infinite scroll through a debounced MutationObserver.
   ============================================================ */
(function () {
    'use strict';

    const host = location.hostname.replace(/^www\./i, '').toLowerCase();
    const RADAR_DISABLED_HOSTS = new Set([
        'pornhub.com',
    ]);
    if (RADAR_DISABLED_HOSTS.has(host)) return;

    const BATCH_LIMIT = 300;
    const SCAN_DEBOUNCE_MS = 800;

    // Paths that look like a single-video page on the sites we support
    const VIDEO_PATH_RE = /\/(video|videos|watch|view_video|movie|porn|pornvideo|embed|gifs?|v|a|u|post|performer)\/[^\/]|watch\?v=|viewkey=|\/gif\//i;

    const checked = new Map();   // absolute url -> status
    let scanTimer = null;

    function isVideoLink(a) {
        const href = a.href || '';
        if (!href.startsWith('http')) return false;
        if (a.dataset.nxRadar) return false;
        
        if (host === 'baddiehub.com') {
            try {
                const url = new URL(href);
                if (url.hostname.includes('baddiehub.com')) {
                    if (/^\/(category|page|tag|author|privacy-policy|terms|contact)/i.test(url.pathname)) return false;
                    if (url.pathname === '/' || url.pathname === '') return false;
                    return true;
                }
            } catch (e) {}
        }
        
        if (host.includes('tnaflix.com')) {
            try {
                const url = new URL(href);
                if (url.hostname.includes('tnaflix.com')) {
                    return /\/video\d+/.test(url.pathname);
                }
            } catch (e) {}
        }

        // same-site listing links only; skip nav/pagination/anchors
        if (!VIDEO_PATH_RE.test(href)) return false;
        return true;
    }

    function collectLinks() {
        return Array.from(document.querySelectorAll('a[href]')).filter(isVideoLink);
    }

    function badgeFor(status) {
        const b = document.createElement('span');
        b.className = `nx-radar-badge nx-radar-${status}`;
        b.textContent = status === 'library' ? '✓' : status === 'discovered' ? '◌' : '＋';
        b.title = status === 'library' ? 'Nexus: už v knižnici'
                : status === 'discovered' ? 'Nexus: čaká v discovery fronte'
                : 'Nexus: importovať 1 klikom';
        return b;
    }

    function anchorHost(a) {
        // badge sits on the thumbnail wrapper when there is one
        const host = a.querySelector('img')?.closest('a') || a;
        if (getComputedStyle(host).position === 'static') {
            host.style.position = 'relative';
        }
        return host;
    }

    function findOverlayContext(host) {
        let node = host;
        for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
            const hasSelector = !!node.querySelector?.('.nvs-selector-wrap');
            const hasQuality = !!node.querySelector?.('.nvs-badge-quality');
            if (hasSelector || hasQuality) {
                return { hasSelector, hasQuality };
            }
        }
        return { hasSelector: false, hasQuality: false };
    }

    function applyBadge(a, status) {
        a.dataset.nxRadar = status;
        const host = anchorHost(a);
        const badge = badgeFor(status);
        const overlayContext = findOverlayContext(host);

        if (overlayContext.hasSelector) {
            badge.classList.add('nx-radar-slot-right');
        }
        if (overlayContext.hasSelector && overlayContext.hasQuality) {
            badge.classList.add('nx-radar-slot-right-below');
        }

        if (status === 'unknown') {
            badge.classList.add('nx-radar-import');
            badge.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                badge.textContent = '…';
                badge.classList.add('nx-radar-busy');
                chrome.runtime.sendMessage({ action: 'RADAR_IMPORT', url: a.href }, (resp) => {
                    badge.classList.remove('nx-radar-busy');
                    if (resp && resp.ok) {
                        badge.textContent = '✓';
                        badge.className = 'nx-radar-badge nx-radar-library';
                        badge.title = 'Nexus: import spustený';
                        a.dataset.nxRadar = 'library';
                        checked.set(a.href, 'library');
                    } else {
                        badge.textContent = '!';
                        badge.title = 'Import zlyhal: ' + (resp?.error || 'neznáma chyba');
                    }
                });
            });
        }
        host.appendChild(badge);
    }

    function scan() {
        const links = collectLinks();
        if (!links.length) return;

        const toCheck = [];
        for (const a of links) {
            const known = checked.get(a.href);
            if (known) {
                applyBadge(a, known);
            } else {
                toCheck.push(a);
            }
        }
        if (!toCheck.length) return;

        const urls = [...new Set(toCheck.map(a => a.href))].slice(0, BATCH_LIMIT);
        chrome.runtime.sendMessage({ action: 'RADAR_CHECK', urls }, (resp) => {
            if (!resp || !resp.ok) return;   // backend offline → no badges, no noise
            const results = resp.data.results || {};
            for (const a of toCheck) {
                const r = results[a.href];
                if (!r) continue;
                checked.set(a.href, r.status);
                if (!a.dataset.nxRadar) applyBadge(a, r.status);
            }
        });
    }

    function scheduleScan() {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(scan, SCAN_DEBOUNCE_MS);
    }

    const observer = new MutationObserver((mutations) => {
        if (mutations.some(m => m.addedNodes.length)) scheduleScan();
    });

    function start() {
        scan();
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
