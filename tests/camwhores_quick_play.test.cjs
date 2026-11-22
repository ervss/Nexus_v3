const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const source = readFileSync('app/static/main.js', 'utf8');

test('Discovery quick play uses the referer-aware proxy without importing', async () => {
    const start = source.indexOf('        async cwQuickPlay(video) {');
    const end = source.indexOf('        cwSearchUploader(uploader)', start);
    assert.ok(start >= 0 && end > start);
    const calls = [];
    const dashboard = vm.runInNewContext(`({${source.slice(start, end)}})`, {
        fetch: async () => ({ ok: true, json: async () => ({ stream_url: 'https://cdn.example/film.mp4' }) }),
        console,
    });
    dashboard.showToast = () => {};
    dashboard.playVideo = video => calls.push(video);
    await dashboard.cwQuickPlay({
        url: 'https://www.camwhores.tv/videos/123/example/',
        title: 'Example',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].storage_type, 'remote_preview');
    assert.equal(calls[0].status, 'ready');
    const proxy = new URL(calls[0].url, 'http://localhost:8000');
    assert.equal(proxy.pathname, '/stream_proxy/cw-temp.mp4');
    assert.equal(proxy.searchParams.get('url'), 'https://cdn.example/film.mp4');
    assert.equal(proxy.searchParams.get('referer'), 'https://www.camwhores.tv/videos/123/example/');
});

test('player seeds preview proxy before database-only stream refresh', () => {
    const start = source.indexOf('            let src = tsRemuxSrc;');
    const end = source.indexOf('            // Resolver cookie jars stay server-side.', start);
    assert.ok(start >= 0 && end > start);
    const sourceSelection = vm.runInNewContext(
        `(video, tsRemuxSrc) => { ${source.slice(start, end)} return src; }`,
    );
    const proxy = '/stream_proxy/cw-temp.mp4?url=https%3A%2F%2Fcdn.example%2Ffilm.mp4';
    assert.equal(sourceSelection({ storage_type: 'remote_preview', external_playback_url: proxy }, null), proxy);
    assert.equal(sourceSelection({ storage_type: 'remote', external_playback_url: proxy }, null), null);
});
