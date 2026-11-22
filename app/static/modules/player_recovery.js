/**
 * Unified Player Recovery Pipeline (NexusPlayerRecovery).
 * Coalesces live stream re-extraction across player slots, enforces retry
 * limits, surfaces circuit-breaker/auth errors cleanly, and preserves resume time.
 */
(function (global) {
    'use strict';

    const inflightResolves = new Map();
    const cooldowns = new Map();

    async function resolveStreamForVideo(video, options = {}) {
        const videoId = video && video.id;
        if (!videoId) {
            return { ok: false, message: 'Chýba ID videa pre obnovu streamu.' };
        }

        const now = Date.now();
        const blockedUntil = cooldowns.get(videoId) || 0;
        if (blockedUntil > now && !options.ignoreCooldown) {
            const waitSec = Math.ceil((blockedUntil - now) / 1000);
            return {
                ok: false,
                rateLimited: true,
                message: `Zdroj je dočasne utlmený — skús znova o ${waitSec} s.`,
            };
        }

        if (inflightResolves.has(videoId)) {
            return inflightResolves.get(videoId);
        }

        const task = (async () => {
            try {
                const res = await fetch(`/api/v1/stream/resolve/${videoId}?force=1`, {
                    cache: 'no-store',
                    signal: options.signal || (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(45000) : undefined),
                });
                const data = await res.json().catch(() => ({}));

                if (res.status === 503) {
                    const retryAfter = parseInt(res.headers.get('Retry-After') || '30', 10) || 30;
                    cooldowns.set(videoId, Date.now() + retryAfter * 1000);
                    return {
                        ok: false,
                        rateLimited: true,
                        status: 503,
                        message: data.detail || `Doména je dočasne utlmená (${retryAfter} s).`,
                    };
                }

                if (res.ok && data.supported && data.stream_url) {
                    cooldowns.delete(videoId);
                    return {
                        ok: true,
                        streamUrl: String(data.stream_url).trim(),
                        data,
                    };
                }

                // Fallback to synchronous refresh endpoint for legacy/forum-linked videos
                const refRes = await fetch(`/api/v1/videos/${videoId}/refresh?sync=true`, {
                    method: 'POST',
                    cache: 'no-store',
                    signal: options.signal || (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(35000) : undefined),
                });
                const refData = await refRes.json().catch(() => ({}));
                if (refRes.ok && refData.url) {
                    cooldowns.delete(videoId);
                    return {
                        ok: true,
                        streamUrl: String(refData.url).trim(),
                        data: { supported: true, stream_url: refData.url, is_hls: /\.m3u8(\?|$)/i.test(refData.url) },
                    };
                }

                return {
                    ok: false,
                    status: res.status,
                    message: data.detail || data.reason || `HTTP ${res.status}`,
                };
            } catch (err) {
                return {
                    ok: false,
                    message: err && err.message ? err.message : 'Sieťová chyba pri obnove streamu',
                };
            } finally {
                inflightResolves.delete(videoId);
            }
        })();

        inflightResolves.set(videoId, task);
        return task;
    }

    function clearCooldown(videoId) {
        if (videoId === undefined || videoId === null) {
            cooldowns.clear();
        } else {
            cooldowns.delete(videoId);
        }
    }

    global.NexusPlayerRecovery = {
        resolveStreamForVideo,
        clearCooldown,
        _inflightCount: () => inflightResolves.size,
    };
})(typeof window !== 'undefined' ? window : globalThis);
