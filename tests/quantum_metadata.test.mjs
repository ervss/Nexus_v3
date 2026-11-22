import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app/static/search.js', import.meta.url), 'utf8');
function harness(fetch) {
    const context = vm.createContext({ URL, AbortController, setTimeout, clearTimeout, fetch, document: { addEventListener() {} } });
    vm.runInContext(source + '\nthis.Search = QuantumSearch;', context);
    const search = Object.create(context.Search.prototype);
    Object.assign(search, { _searchRunId: 1, _metaPending: new Map(), _metaControllers: new Set(), results: [], applyFilters() {} });
    return search;
}

test('fetch fills all card metadata while preserving known fields when provider omits them', async () => {
    const url = 'https://www.whoreshub.com/videos/123/example/';
    let body;
    const search = harness(async (endpoint, options) => {
        assert.equal(endpoint, '/api/tester/batch-meta');
        body = JSON.parse(options.body);
        return { ok: true, json: async () => ({ results: [{ url, ok: true, duration: 1234, quality: '1080p', size_bytes: 200000000, upload_date: '2026-10-01', thumbnail: '' }] }) };
    });
    search.results = [{ url, thumbnail: 'known.jpg' }];
    await search._prefetchTesterMetadata(1);
    assert.equal(body.metadata_only, true);
    assert.equal(body.full_metadata, true);
    assert.equal(search.results[0].duration, 1234);
    assert.equal(search.results[0].quality, '1080p');
    assert.equal(search.results[0].size_bytes, 200000000);
    assert.equal(search.results[0].upload_date, '2026-10-01');
    assert.equal(search.results[0].thumbnail, 'known.jpg');
    assert.equal(search._metaPending.size, 0);
});

test('all requested providers use full metadata, with estimates visibly marked', () => {
    const search = harness();
    for (const host of ['pornone.com', 'xhamster.com', 'eporner.com', 'xvideos.com', 'noodlemagazine.com', 'camwhores.tv', 'porntrex.com', 'whoreshub.com']) {
        assert.equal(search._usesTesterMetadata(`https://www.${host}/video/123`), true, host);
        assert.equal(search._usesTesterMetadata(`https://${host}.attacker.test/video/123`), false, host);
    }
    assert.equal(search._formatCardSize({size_bytes: 1073741824, size_estimated: true}), '≈ 1.0 GB');
    assert.equal(search._formatCardSize({size_bytes: 104857600, size_estimated: false}), '100 MB');
});

test('manual retry replaces an estimated size flag with a measured size', async () => {
    const url = 'https://www.xvideos.com/video.abc/clip';
    const search = harness(async () => ({ok: true, json: async () => ({results: [{url, ok: true, duration: 600, height: 1080, quality: '1080p', size_bytes: 104857600, size_estimated: false, upload_date: '2026-10-01'}]})}));
    search.results = [{url, size_estimated: true}];
    await search._prefetchTesterMetadata(1, [url]);
    assert.equal(search.results[0].size_estimated, false);
    assert.equal(search.results[0]._metaMissing.length, 0);
});

test('old search responses cannot overwrite a new search and failures remain retryable', async () => {
    const url = 'https://www.porntrex.com/video/123/example/';
    let release;
    const search = harness(() => new Promise(resolve => { release = resolve; }));
    search.results = [{ url, duration: 60 }];
    const work = search._prefetchTesterMetadata(1);
    search._searchRunId = 2;
    release({ ok: true, json: async () => ({ results: [{ url, ok: true, duration: 999 }] }) });
    await work;
    assert.equal(search.results[0].duration, 60);
    assert.equal(search.results[0]._metaFetched, undefined);
    assert.equal(search._metaPending.size, 0);
    assert.equal(search._usesTesterMetadata('https://whoreshub.com.attacker.test/videos/1'), false);
});

test('all sources means the complete server catalog, and an empty selection means none', () => {
    const search = harness();
    search.sourceCatalog = Array.from({length: 23}, (_, index) => ({id: `source${index}`}));
    search.searchFilters = {source: ['all'], quality: ['all']};
    assert.equal(search.getSearchSourceKeys().length, 23);
    search.searchFilters.source = [];
    assert.equal(search.getSearchSourceKeys().length, 0);
    search.searchFilters.source = ['source2', 'invalid'];
    assert.deepEqual([...search.getSearchSourceKeys()], ['source2']);
});

test('quality threshold and total cap preserve a turn for distinct sources', () => {
    const search = harness();
    search.searchFilters = {source: ['all'], quality: ['4K']};
    assert.equal(search.requestedQuality(), 2160);
    const rows = [
        {source_key: 'a', url: 'a1'}, {source_key: 'a', url: 'a2'},
        {source_key: 'b', url: 'b1'}, {source_key: 'b', url: 'b2'},
    ];
    assert.equal(search.fairResultLimit(rows, 2).map(row => row.url).join(','), 'a1,b1');
});

test('resolved provider stream updates metadata without replacing a measured size', async () => {
    const url = 'https://www.pornhub.com/view_video.php?viewkey=abc';
    const search = harness(async () => ({ok: true, json: async () => ({results: [{
        url, status: 'success', data: {stream_url: 'https://cdn.example/clip.m3u8',
            duration: 600, height: 1080, size_bytes: 50000000, size_estimated: true,
            proxy_session: 'opaque'}
    }]})}));
    search.results = [{url, size_bytes: 70000000, size_estimated: false}];
    search.renderResultsList = () => {};
    const data = await search._resolvePlayable(url);
    assert.equal(data.proxy_session, 'opaque');
    assert.equal(search.results[0].size_bytes, 70000000);
    assert.equal(search.results[0].size_estimated, false);
    assert.equal(search.results[0].duration, 600);
});

test('ready-import provider matching rejects lookalike hosts and parses card duration', () => {
    const search = harness();
    for (const host of ['porntrex.com', 'whoreshub.com', 'pornhub.com', 'eporner.com', 'leakporner.com', 'mypornerleak.com']) {
        assert.equal(search._readyImportSource(`https://www.${host}/video/1`), true);
        assert.equal(search._readyImportSource(`https://${host}.attacker.test/video/1`), false);
    }
    assert.equal(search._durationSeconds('16:02'), 962);
    assert.equal(search._durationSeconds('1:02:03'), 3723);
    assert.equal(search._durationSeconds('bad'), 0);
});

test('Eporner cards resolve their watch page instead of framing external embeds', () => {
    const search = harness();
    const watch = 'https://www.eporner.com/video-AbCd12/example-title/';
    const embed = 'https://www.eporner.com/embed/AbCd12/';
    assert.equal(search._playUrlForResult({ source: 'Eporner', url: watch, stream_url: embed }), watch);
    assert.equal(search._embedUrlFor(embed), '');
    assert.equal(search._isEpornerUrl('https://media.eporner.com/dload/token'), true);
    assert.equal(search._isEpornerUrl('https://eporner.com.attacker.test/embed/AbCd12/'), false);
});

test('FPO provider URLs are recognised for referer-preserving proxy playback', () => {
    const search = harness();
    assert.equal(search._isFpoUrl('https://www.fpo.xxx/video/123/example/'), true);
    assert.equal(search._isFpoUrl('https://videos12.fpo.xxx/remote_control.php?file=clip'), true);
    assert.equal(search._isFpoUrl('https://fpo.xxx.attacker.test/video/123/'), false);
});

test('HornySimp Byse embeds use the local embed proxy and preserve the source referer', async () => {
    const url = 'https://hornysimp.com/video/123/example';
    const embed = 'https://bysezoxexe.com/e/AbC_123';
    const search = harness(async (endpoint, options) => {
        assert.equal(endpoint, '/api/tester/resolve');
        assert.deepEqual(JSON.parse(options.body), { urls: [url] });
        return { ok: true, json: async () => ({ results: [{
            status: 'success', data: { stream_url: 'https://hornysimp.com/embed/123', embed_urls: [embed] }
        }] }) };
    });
    const playback = await search._resolveQuantumPlayback({ url }, url);
    const proxy = new URL(playback.url, 'https://nexus.test');
    assert.equal(playback.iframe, true);
    assert.equal(proxy.pathname, '/e/AbC_123');
    assert.equal(proxy.searchParams.get('upstream'), embed);
    assert.equal(proxy.searchParams.get('referer'), url);
    assert.equal(playback.players.length, 2);
});

test('LeakPorner-family HLS playback uses the stream proxy with the resolver referer', async () => {
    const url = 'https://www.djav.org/video/456/example';
    const stream = 'https://cdn.example/playlist.m3u8?token=short-lived';
    const referer = 'https://www.djav.org/watch/456';
    const search = harness();
    const playback = await search._resolveQuantumPlayback({
        url,
        _resolvedPlayback: {
            stream_url: stream,
            is_hls: true,
            playback_referer: referer,
            embed_urls: ['https://embed.example/e/456', 'https://embed.example/e/456'],
        },
        _resolvedAt: Date.now(),
    }, url);
    const proxy = new URL(playback.url, 'https://nexus.test');
    assert.equal(playback.iframe, false);
    assert.equal(playback.format, 'hls');
    assert.equal(proxy.pathname, '/hls_proxy');
    assert.equal(proxy.searchParams.get('url'), stream);
    assert.equal(proxy.searchParams.get('referer'), referer);
    assert.equal(playback.embedFallbacks.length, 1);
    const embed = new URL(playback.embedFallbacks[0], 'https://nexus.test');
    assert.equal(embed.pathname, '/embed_proxy');
    assert.equal(embed.searchParams.get('url'), 'https://embed.example/e/456');
    assert.equal(embed.searchParams.get('referer'), referer);
});

test('Byse embed detection rejects lookalike hosts', () => {
    const search = harness();
    assert.equal(search._isByseEmbedUrl('https://398fitus.com/kpw/abc-123'), true);
    assert.equal(search._isByseEmbedUrl('https://398fitus.com.attacker.test/e/abc'), false);
    assert.equal(search._isByseEmbedUrl('https://bysezoxexe.com.attacker.test/e/abc'), false);
});

test('PornTrex split playback keeps the proxied contract and watch-page referer', async () => {
    const page = 'https://www.porntrex.com/video/123/example/';
    const stream = 'https://video.cdntrex.com/get_file/123/video.mp4/?token=abc';
    const proxy = `/hls_proxy?url=${encodeURIComponent(stream)}&referer=${encodeURIComponent(page)}`;
    const search = harness(async () => ({ ok: true, json: async () => ({
        results: [{ status: 'success', data: { stream_url: stream,
            playback: { playback_url: proxy, format: 'mp4', iframe: false } } }]
    }) }));
    const playback = await search._resolveQuantumPlayback({ url: page }, page);
    assert.equal(playback.url, proxy);
    assert.equal(playback.iframe, false);
    assert.equal(new URL(playback.url, 'http://localhost').searchParams.get('referer'), page);
});


test('Quantum playback resolves LeakPorner, Pornhub, XVideos, and HornySimp streams for Split-Screen', async () => {
    const lpUrl = 'https://w12.leakporner.com/video/9876/leak-clip/';
    const lpStream = 'https://cdnvids.top/hls/9876/master.m3u8';
    const lpReferer = 'https://tnmr.org/embed/9876';
    const searchLp = harness(async () => ({
        ok: true,
        json: async () => ({
            results: [{
                status: 'success',
                data: { stream_url: lpStream, is_hls: true, playback_referer: lpReferer }
            }]
        })
    }));
    const lpPlayback = await searchLp._resolveQuantumPlayback({ url: lpUrl }, lpUrl);
    const lpProxy = new URL(lpPlayback.url, 'https://nexus.test');
    assert.equal(lpPlayback.format, 'hls');
    assert.equal(lpPlayback.iframe, false);
    assert.equal(lpProxy.pathname, '/hls_proxy');
    assert.equal(lpProxy.searchParams.get('url'), lpStream);
    assert.equal(lpProxy.searchParams.get('referer'), lpReferer);

    const phUrl = 'https://www.pornhub.com/view_video.php?viewkey=654321abcdef';
    const phStream = 'https://ev-h.phncdn.com/hls/videos/master.m3u8?validfrom=1';
    const searchPh = harness(async () => ({
        ok: true,
        json: async () => ({
            results: [{
                status: 'success',
                data: {
                    stream_url: phStream,
                    is_hls: true,
                    playback_referer: phUrl,
                    proxy_session: 'ph-session-123'
                }
            }]
        })
    }));
    const phPlayback = await searchPh._resolveQuantumPlayback({ url: phUrl }, phUrl);
    const phProxy = new URL(phPlayback.url, 'https://nexus.test');
    assert.equal(phPlayback.format, 'hls');
    assert.equal(phPlayback.iframe, false);
    assert.equal(phProxy.pathname, '/hls_proxy');
    assert.equal(phProxy.searchParams.get('url'), phStream);
    assert.equal(phProxy.searchParams.get('referer'), phUrl);
    assert.equal(phProxy.searchParams.get('session'), 'ph-session-123');

    const xvUrl = 'https://www.xvideos.com/video.kfubdfv1234/example_clip';
    const xvMp4 = 'https://cdn77-vid.xvideos-cdn.com/videos/mp4/clip.mp4?e=123';
    const searchXv = harness(async () => ({
        ok: true,
        json: async () => ({
            results: [{
                status: 'success',
                data: { stream_url: xvMp4, is_hls: false, playback_referer: xvUrl }
            }]
        })
    }));
    const xvPlayback = await searchXv._resolveQuantumPlayback({ url: xvUrl }, xvUrl);
    const xvProxy = new URL(xvPlayback.url, 'https://nexus.test');
    assert.equal(xvPlayback.format, 'mp4');
    assert.equal(xvPlayback.iframe, false);
    assert.equal(xvProxy.pathname, '/hls_proxy');
    assert.equal(xvProxy.searchParams.get('url'), xvMp4);
    assert.equal(xvProxy.searchParams.get('referer'), xvUrl);
});
