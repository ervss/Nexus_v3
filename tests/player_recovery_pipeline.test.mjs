import test from 'node:test';
import assert from 'node:assert/strict';
import '../app/static/modules/player_recovery.js';

test('NexusPlayerRecovery coalesces concurrent resolves and handles 503 cooldown + refresh fallback', async () => {
    const recovery = globalThis.NexusPlayerRecovery;
    recovery.clearCooldown();

    let fetchCount = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        fetchCount += 1;
        if (url.includes('/api/v1/stream/resolve/101')) {
            await new Promise((r) => setTimeout(r, 20));
            return new Response(JSON.stringify({ supported: true, stream_url: 'https://cdn.test/101.mp4' }), { status: 200 });
        }
        if (url.includes('/api/v1/stream/resolve/102')) {
            return new Response(JSON.stringify({ detail: 'Doména utlmená' }), {
                status: 503,
                headers: { 'Retry-After': '12' },
            });
        }
        if (url.includes('/api/v1/stream/resolve/103')) {
            return new Response(JSON.stringify({ supported: false, reason: 'no extractor' }), { status: 200 });
        }
        if (url.includes('/api/v1/videos/103/refresh?sync=true')) {
            return new Response(JSON.stringify({ status: 'refreshed', url: 'https://cdn.test/103-fresh.mp4' }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    };

    try {
        // 1. Concurrent resolves for the same video ID coalesce into a single fetch
        const [a, b] = await Promise.all([
            recovery.resolveStreamForVideo({ id: 101 }),
            recovery.resolveStreamForVideo({ id: 101 }),
        ]);
        assert.equal(a.ok, true);
        assert.equal(b.ok, true);
        assert.equal(a.streamUrl, 'https://cdn.test/101.mp4');
        assert.equal(fetchCount, 1);

        // 2. 503 trips client cooldown and blocks immediate duplicate call
        const rl1 = await recovery.resolveStreamForVideo({ id: 102 });
        assert.equal(rl1.ok, false);
        assert.equal(rl1.rateLimited, true);
        const beforeCount = fetchCount;
        const rl2 = await recovery.resolveStreamForVideo({ id: 102 });
        assert.equal(rl2.ok, false);
        assert.equal(rl2.rateLimited, true);
        assert.equal(fetchCount, beforeCount);

        // 3. Unsupported in resolve falls back to /refresh?sync=true
        const fb = await recovery.resolveStreamForVideo({ id: 103 });
        assert.equal(fb.ok, true);
        assert.equal(fb.streamUrl, 'https://cdn.test/103-fresh.mp4');
    } finally {
        globalThis.fetch = origFetch;
        recovery.clearCooldown();
    }
});
