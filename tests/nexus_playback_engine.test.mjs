import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const searchSource = readFileSync(new URL('../app/static/search.js', import.meta.url), 'utf8');

function harnessSearch(fetch) {
    const context = vm.createContext({
        URL,
        AbortController,
        setTimeout,
        clearTimeout,
        fetch,
        document: { addEventListener() {} },
    });
    vm.runInContext(searchSource + '\nthis.Search = QuantumSearch;', context);
    const search = Object.create(context.Search.prototype);
    Object.assign(search, {
        _searchRunId: 1,
        _metaPending: new Map(),
        _metaControllers: new Set(),
        results: [],
        applyFilters() {},
    });
    return search;
}

test('_resolvePlayable succeeds when data.playback is present even without stream_url', async () => {
    const search = harnessSearch(async (endpoint, options) => {
        return {
            ok: true,
            json: async () => ({
                results: [{
                    url: 'https://example.com/embed-only',
                    status: 'success',
                    data: {
                        stream_url: '',
                        embed_urls: ['https://example.com/embed/123'],
                        playback: {
                            type: 'embed',
                            format: 'mp4',
                            playback_url: '/embed_proxy?url=https%3A%2F%2Fexample.com%2Fembed%2F123&referer=',
                            fallback_url: null,
                            iframe: true,
                        },
                    },
                }],
            }),
        };
    });

    const res = await search._resolvePlayable('https://example.com/embed-only', false);
    assert.ok(res.playback);
    assert.equal(res.playback.type, 'embed');
    assert.equal(res.playback.iframe, true);
});

test('_resolveQuantumPlayback prioritizes backend playback contract with fallback_url', async () => {
    const search = harnessSearch(async (endpoint, options) => {
        return {
            ok: true,
            json: async () => ({
                results: [{
                    url: 'https://www.eporner.com/video-abc/',
                    status: 'success',
                    data: {
                        stream_url: 'https://static.eporner.com/1080p.mp4',
                        playback: {
                            type: 'direct',
                            format: 'mp4',
                            playback_url: 'https://static.eporner.com/1080p.mp4',
                            fallback_url: '/hls_proxy?url=https%3A%2F%2Fstatic.eporner.com%2F1080p.mp4',
                            requires_proxy: false,
                            iframe: false,
                        },
                    },
                }],
            }),
        };
    });

    const pb = await search._resolveQuantumPlayback({ url: 'https://www.eporner.com/video-abc/' });
    assert.equal(pb.url, 'https://static.eporner.com/1080p.mp4');
    assert.equal(pb.fallback_url, '/hls_proxy?url=https%3A%2F%2Fstatic.eporner.com%2F1080p.mp4');
    assert.equal(pb.iframe, false);
    assert.equal(pb.format, 'mp4');
});

test('_resolveQuantumPlayback returns fast-path directly for telegram streams without API fetch', async () => {
    let fetchCalled = false;
    const search = harnessSearch(async () => {
        fetchCalled = true;
        throw new Error('Should not fetch for telegram stream');
    });

    const item = {
        url: 'https://t.me/c/123/456',
        stream_url: '/api/v1/telegram/stream/123/456',
    };
    const pb = await search._resolveQuantumPlayback(item);
    assert.equal(fetchCalled, false);
    assert.equal(pb.url, '/api/v1/telegram/stream/123/456');
    assert.equal(pb.iframe, false);
});
