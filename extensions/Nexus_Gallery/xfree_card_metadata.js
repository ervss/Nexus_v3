(function () {
    'use strict';

    if (window.top !== window || !/(^|\.)xfree\.com$/i.test(location.hostname)) return;

    const BADGE_CLASS = 'nexus-xfree-meta';
    const cardState = new WeakMap();
    const pending = new Set();

    function formatDuration(seconds) {
        const total = Math.round(Number(seconds || 0));
        if (!Number.isFinite(total) || total <= 0) return '';
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
            : `${m}:${String(s).padStart(2, '0')}`;
    }

    function formatSize(bytes) {
        const value = Number(bytes || 0);
        if (!Number.isFinite(value) || value <= 0) return '';
        if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
        return `${(value / 1024 ** 2).toFixed(1)} MB`;
    }

    function qualityLabel(height) {
        const h = Number(height || 0);
        if (h >= 2160) return '4K';
        if (h >= 1440) return '1440p';
        if (h >= 1080) return '1080p';
        if (h >= 720) return '720p';
        if (h >= 480) return '480p';
        return h ? `${h}p` : '';
    }

    function mediaUrl(video) {
        return String(video.currentSrc || video.src || video.querySelector('source')?.src || '').trim();
    }

    function detailUrl(video, card) {
        const link = video.closest('a[href*="/video?id="], a[href*="/video/"]') ||
            card.closest?.('a[href*="/video?id="], a[href*="/video/"]') ||
            card.querySelector?.('a[href*="/video?id="], a[href*="/video/"]');
        return String(link?.href || link?.getAttribute?.('href') || '').trim();
    }

    function streamFromHtml(html) {
        const decoded = String(html || '').replace(/\\\//g, '/').replace(/\\u0026/g, '&');
        return decoded.match(/https:\/\/cdn\.xfree\.com\/[^\s"']+?\.mp4(?:\?[^\s"']*)?/i)?.[0] || '';
    }

    function durationFromHtml(html) {
        const source = String(html || '');
        const match = source.match(/og:video:duration"[^>]+content="(\d+)"/i) ||
            source.match(/"duration"\s*:\s*(\d+)/i);
        return Number(match?.[1] || 0) || 0;
    }

    function cardFor(video) {
        const linked = video.closest('a[href*="/video?id="], a[href*="/video/"]');
        if (linked) return linked;
        let node = video.parentElement;
        while (node && node !== document.body) {
            const rect = node.getBoundingClientRect();
            if (rect.width >= 140 && rect.height >= 140 && node.querySelector('video')) return node;
            node = node.parentElement;
        }
        return video.parentElement;
    }

    function badgeFor(card) {
        let badge = card.querySelector(`:scope > .${BADGE_CLASS}`);
        if (!badge) {
            badge = document.createElement('div');
            badge.className = BADGE_CLASS;
            card.appendChild(badge);
            const style = getComputedStyle(card);
            if (style.position === 'static') card.style.position = 'relative';
        }
        return badge;
    }

    function render(card, data) {
        const parts = [
            formatDuration(data.duration),
            qualityLabel(data.height),
            formatSize(data.sizeBytes),
        ].filter(Boolean);
        const badge = badgeFor(card);
        badge.textContent = parts.length ? parts.join('  ·  ') : 'Načítavam údaje…';
        badge.classList.toggle('is-ready', parts.length > 0);
    }

    function updateFromVideo(card, video, data) {
        data.duration = Number(video.duration || data.duration || 0) || 0;
        data.height = Number(video.videoHeight || data.height || 0) || 0;
        render(card, data);
    }

    async function enrich(card, video, data) {
        const pageUrl = detailUrl(video, card);
        let url = mediaUrl(video);
        if (pageUrl) {
            try {
                // Same card-by-card detail fetch as Eporner/Camwhores: the
                // search listing is only a preview, while the watch page holds
                // the direct MP4 and its canonical duration.
                const response = await fetch(pageUrl, { credentials: 'include' });
                if (response.ok) {
                    const pageHtml = await response.text();
                    url = streamFromHtml(pageHtml) || url;
                    data.duration = durationFromHtml(pageHtml) || data.duration || 0;
                }
            } catch (_) { /* fall back to the card's own media URL */ }
        }
        if (!url || url.startsWith('blob:') || pending.has(url)) return;
        pending.add(url);
        try {
            const result = await new Promise(resolve => chrome.runtime.sendMessage({
                action: 'PROBE_MEDIA_METADATA', url, referer: location.href,
            }, resolve));
            if (result) {
                data.sizeBytes = Number(result.sizeBytes || data.sizeBytes || 0) || 0;
                data.height = Number(result.height || data.height || 0) || 0;
            }
        } catch (_) {
            // The card still receives duration/dimensions from its HTML video.
        } finally {
            pending.delete(url);
            updateFromVideo(card, video, data);
        }
    }

    function attach(video) {
        if (!video || cardState.has(video)) return;
        const card = cardFor(video);
        if (!card) return;
        const data = { duration: 0, height: 0, sizeBytes: 0 };
        cardState.set(video, data);
        updateFromVideo(card, video, data);
        video.addEventListener('loadedmetadata', () => {
            updateFromVideo(card, video, data);
            enrich(card, video, data);
        }, { once: true });
        enrich(card, video, data);
    }

    function scan() {
        document.querySelectorAll('video').forEach(attach);
    }

    scan();
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(scan, 2000);
})();
