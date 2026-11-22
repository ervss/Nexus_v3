(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.NexusEpornerMix = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const BITRATE_RANGES = {
        2160: [10_000, 22_000], 1440: [7_000, 14_000], 1080: [3_500, 8_000],
        720: [1_800, 4_500], 480: [900, 2_200], 360: [500, 1_200], 0: [1_200, 4_000],
    };

    function videoIdentity(url) {
        const match = String(url || '').match(/\/(?:video-|hd-porn\/)([A-Za-z0-9]+)/i);
        return match ? match[1].toLowerCase() : String(url || '').split('?')[0].replace(/\/+$/, '').toLowerCase();
    }

    function normalizePlaylistUrl(raw) {
        try {
            const url = new URL(String(raw || ''));
            if (!/(^|\.)eporner\.com$/i.test(url.hostname) || !/\/playlist\/[A-Za-z0-9]+(?:\/|$)/.test(url.pathname)) return '';
            url.hash = '';
            url.search = '';
            return url.href;
        } catch (_) {
            return '';
        }
    }

    function playlistIdentity(url) {
        return String(url || '').match(/\/playlist\/([A-Za-z0-9]+)/i)?.[1]?.toLowerCase() || normalizePlaylistUrl(url);
    }

    function hasExactSizes(videos) {
        return Boolean(videos?.length) && videos.every(video =>
            Number(video?.size_bytes || 0) > 0 && !video?.size_estimated);
    }

    function heightBucket(value) {
        const height = Number(value || 0);
        return [2160, 1440, 1080, 720, 480, 360].find(level => height >= level) || 0;
    }

    function estimateSize(videos) {
        let low = 0;
        let high = 0;
        videos.forEach(video => {
            const duration = Math.max(0, Number(video.duration || 0));
            const range = BITRATE_RANGES[heightBucket(video.height)] || BITRATE_RANGES[0];
            low += duration * range[0] * 125;
            high += duration * range[1] * 125;
        });
        return { low: Math.round(low), high: Math.round(high) };
    }

    function mixBadges(videos, histogram) {
        const total = videos.length || 1;
        const high = (histogram['2160'] || 0) + (histogram['1440'] || 0);
        const hd = high + (histogram['1080'] || 0) + (histogram['720'] || 0);
        const ratings = videos.map(video => parseFloat(video.rating) || 0).filter(Boolean);
        const badges = [];
        if (high / total >= 0.5) badges.push('4K-heavy');
        else if (hd / total >= 0.7) badges.push('HD mix');
        else badges.push('Mixed quality');
        if (ratings.length && ratings.reduce((sum, value) => sum + value, 0) / ratings.length >= 90) badges.push('Highly rated');
        return badges;
    }

    function mergeFastEvents(events, playlists) {
        const sources = new Map((playlists || []).map(item => [playlistIdentity(item.url), {
            url: normalizePlaylistUrl(item.url), title: item.title || item.url,
        }]));
        const unique = new Map();
        let duplicates = 0;
        (events || []).filter(event => event.type === 'page').forEach(event => {
            const source = sources.get(playlistIdentity(event.url)) || { url: event.url, title: event.url };
            (event.items || []).forEach(raw => {
                const key = videoIdentity(raw.source_url || raw.url);
                const existing = unique.get(key);
                if (existing) {
                    duplicates++;
                    if (!existing.playlist_sources.some(item => item.url === source.url)) existing.playlist_sources.push(source);
                    return;
                }
                unique.set(key, { ...raw, source_url: raw.source_url || raw.url, playlist_sources: [source] });
            });
        });
        const videos = [...unique.values()];
        const quality_histogram = {};
        videos.forEach(video => {
            const key = String(heightBucket(video.height));
            quality_histogram[key] = (quality_histogram[key] || 0) + 1;
        });
        const estimate = estimateSize(videos);
        return {
            videos,
            duplicates,
            duration: videos.reduce((sum, video) => sum + Math.max(0, Number(video.duration || 0)), 0),
            quality_histogram,
            estimated_size_low_bytes: estimate.low,
            estimated_size_high_bytes: estimate.high,
            size_estimated: true,
            badges: mixBadges(videos, quality_histogram),
        };
    }

    return { videoIdentity, normalizePlaylistUrl, playlistIdentity, hasExactSizes, heightBucket, estimateSize, mergeFastEvents };
});
