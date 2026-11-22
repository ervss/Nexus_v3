import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../extensions/Nexus_Gallery/universal_importer.js', import.meta.url), 'utf8');
const helper = source.slice(source.indexOf('    function isPlayableFile('), source.indexOf('    function ensureHuntFrame('));
const context = vm.createContext({ URL, encodeURIComponent });
vm.runInContext(helper, context);

test('PH playback proxies signed streams and preserves the selected Nexus instance', () => {
    const stream = 'https://video.phncdn.com/video/master.m3u8?token=a+b&e=123';
    const page = 'https://www.pornhub.com/view_video.php?viewkey=example';
    const result = new URL(context.huntPlaybackUrl({ _huntBaseUrl: 'http://localhost:8002/' }, stream, page, true));
    assert.equal(result.origin, 'http://localhost:8002');
    assert.equal(result.pathname, '/hls_proxy.m3u8');
    assert.equal(result.searchParams.get('url'), stream);
    assert.equal(result.searchParams.get('referer'), page);
});

test('all providers use the media proxy with their own source context', () => {
    const stream = 'https://video.phncdn.com/video.mp4?token=123';
    for (const domain of ['pornhub.com', 'www.pornhub.org', 'pornhub.net']) {
        assert.equal(new URL(context.huntPlaybackUrl({}, stream, `https://${domain}/watch`, false)).pathname, '/media_proxy.mp4');
    }
    for (const page of ['https://pornone.com/video/1/', 'https://www.fpo.xxx/video/1/', 'https://noodlemagazine.com/watch/1']) {
        const result = new URL(context.huntPlaybackUrl({}, stream, page, false));
        assert.equal(result.pathname, '/media_proxy.mp4');
        assert.equal(result.searchParams.get('referer'), page);
    }
    assert.equal(context.huntPlaybackUrl({}, stream, 'invalid', false), stream);
    assert.equal(context.huntPlaybackUrl({}, 'https://player.example/embed/1', 'https://site.example/watch', false), 'https://player.example/embed/1');
    assert.equal(context.isPlayableFile('https://cdn.example/get_file/1/token/video.mp4/'), true);
});

test('a forced HLS stream without a file extension reaches Hls rather than an iframe', () => {
    const start = source.indexOf('    function playUrlInHuntModal(');
    const end = source.indexOf('    function paintHuntQuality(', start);
    const video = { style: {}, pause() {}, removeAttribute() {}, load() {} };
    const frame = { style: {} };
    let loaded;
    class Hls {
        static isSupported() { return true; }
        static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' };
        loadSource(url) { loaded = url; }
        attachMedia() {}
        on() {}
    }
    const sandbox = vm.createContext({ Hls, ensureHuntFrame: () => frame, isPlayableFile: () => false, isHls: () => false });
    vm.runInContext(source.slice(start, end), sandbox);
    sandbox.playUrlInHuntModal({ querySelector: selector => selector.endsWith('-video') ? video : {} }, 'https://cdn.example/manifest', true);
    assert.equal(loaded, 'https://cdn.example/manifest');
    assert.equal(frame.style.display, 'none');
});

function metadataSandbox(message) {
    const start = source.indexOf('    function huntCardsFlat(');
    const end = source.indexOf('    function huntMessage(', start);
    const sandbox = vm.createContext({ Set, huntMessage: message, selectedHuntPort: () => 8000,
        renderHuntGroups: (owner, groups) => { owner._huntGroups = groups; } });
    vm.runInContext(source.slice(start, end), sandbox);
    return sandbox;
}

test('metadata moves past sixteen unresolved results and verifies title claims', async () => {
    const groups = { maybe: Array.from({ length: 17 }, (_, index) => ({
        url: `https://example.com/${index}`, height: 2160, height_source: 'title',
    })) };
    const owner = { _huntRun: 1, _huntJobId: 'job', _huntGroups: groups, querySelector: () => ({}) };
    const calls = [];
    const sandbox = metadataSandbox(async message => { calls.push([...message.urls]); return { ok: true, groups }; });
    await sandbox.enrichHuntQualities(owner);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].length, 16);
    assert.deepEqual(calls[1], ['https://example.com/16']);
    assert.equal(owner._qualityBusy, false);
    await sandbox.enrichHuntQualities(owner);
    assert.equal(calls.length, 2, 'unresolved URLs are not retried indefinitely');
});

test('metadata errors release the busy state', async () => {
    const owner = { _huntRun: 1, _huntGroups: { other: [{ url: 'https://example.com/1' }] }, querySelector: () => ({}) };
    const sandbox = metadataSandbox(async () => ({ ok: false }));
    await sandbox.enrichHuntQualities(owner);
    assert.equal(owner._qualityBusy, false);
});

test('late metadata cannot overwrite results after cancellation', async () => {
    const groups = { maybe: [{ url: 'https://example.com/1' }] };
    const owner = { _huntRun: 1, _huntGroups: groups, querySelector: () => ({}) };
    let complete;
    const sandbox = metadataSandbox(() => new Promise(resolve => { complete = resolve; }));
    const pending = sandbox.enrichHuntQualities(owner);
    owner._huntStopped = true;
    complete({ ok: true, groups: { better: [{ url: 'wrong' }] } });
    await pending;
    assert.equal(owner._huntGroups, groups);
    assert.equal(owner._qualityBusy, false);
});
