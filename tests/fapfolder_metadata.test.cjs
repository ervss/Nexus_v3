const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const gallerySource = fs.readFileSync('extensions/Nexus_Gallery/background.js', 'utf8');
const selectorSource = fs.readFileSync('extensions/nexus-video-selector/background.js', 'utf8');
const page = `<title>Gallery post</title><time title="2026-09-08 14:17:16">a month ago</time>
<p>Unrelated text: 900 MB, 1080p, 0:02</p>
<video id="video-98678" poster="https://fap.onl/thumb.jpg"><source src="https://fapfolder.club/video/play?src=one&amp;sig=two"></video>`;

function gallery(fetch) {
    const a = gallerySource.indexOf('function parseFapFolderDuration');
    const b = gallerySource.indexOf('async function reportCapturedStream', a);
    const c = gallerySource.indexOf('async function fetchHeadInfo');
    const d = gallerySource.indexOf('function nexusQualityLabelFromHeight', c);
    const ctx = vm.createContext({ URL, AbortSignal, fetch,
        chrome: { storage: { session: { get: async () => ({}) } } },
        isMegaUserStorageUrl: () => false, mediaRefererFor: (_, ref) => ref,
        isBogusXvideosContentLength: () => false });
    vm.runInContext(gallerySource.slice(a, b) + gallerySource.slice(c, d), ctx);
    return ctx;
}

function selector(fetch) {
    const ctx = vm.createContext({ URL, AbortSignal, AbortController, fetch, setTimeout, clearTimeout, console,
        chrome: { runtime: { onMessage: { addListener() {} } }, storage: { local: {
            get: async () => ({ 'nvs_meta_v10:https://fapfolder.club/posts/166110': { ts: Date.now(), duration: '14:17:16', quality: '1080P', sizeMb: 900 } }),
            set: async () => {},
        } } } });
    vm.runInContext(selectorSource, ctx);
    return ctx;
}

test('both FapFolder parsers ignore post clock times and unrelated filesize/quality text', () => {
    for (const [ctx, name] of [[gallery(), 'extractFapFolderMetaFromHtml'], [selector(), 'extractFapFolderMeta']]) {
        const meta = ctx[name](page);
        assert.ok(!meta.duration);
        assert.equal(meta.sizeMb, null);
        assert.equal(meta.streamUrl, 'https://fapfolder.club/video/play?src=one&sig=two');
    }
    assert.equal(gallery().extractFapFolderMetaFromHtml(page).thumbnail, 'https://fap.onl/thumb.jpg');
});

test('actual FapFolder lazy player exposes its signed source before a video element exists', () => {
    const html = `<time>2026-09-08 14:17:16</time><div class="vid-placeholder unloaded"
      data-id="video-98678" data-length="113" data-src="https://fapfolder.club/video/play?src=one&amp;exp=two&amp;sig=three"
      data-aspect-ratio="1" data-poster="https://fap.onl/real-video-thumb.jpg"></div>`;
    for (const [ctx, name] of [[gallery(), 'extractFapFolderMetaFromHtml'], [selector(), 'extractFapFolderMeta']]) {
        const meta = ctx[name](html);
        assert.equal(meta.streamUrl, 'https://fapfolder.club/video/play?src=one&exp=two&sig=three');
        assert.ok(!meta.duration, 'clock time must still not become duration');
    }
    assert.equal(gallery().extractFapFolderMetaFromHtml(html).thumbnail, 'https://fap.onl/real-video-thumb.jpg');
});

test('both workers use complete Content-Range total and preserve the login session', async () => {
    const requests = [];
    const fetch = async (url, options) => {
        requests.push(options);
        return new Response('x', { status: 206, headers: { 'content-type': 'video/mp4', 'content-length': '1', 'content-range': 'bytes 0-0/43888888' } });
    };
    const a = await gallery(fetch).fetchFapFolderStreamSizeMb('https://fapfolder.club/video/play?sig=x', 'https://fapfolder.club/posts/166110');
    const b = await selector(fetch).fetchFapFolderStreamSizeMb('https://fapfolder.club/video/play?sig=x');
    assert.equal(a, 43888888 / 1048576);
    assert.equal(b, a);
    assert.ok(requests.every(options => options.credentials === 'include'));
    assert.ok(requests.every(options => options.headers.Range === 'bytes=0-0'));
});

test('neither worker mistakes login/error HTML or a one-byte partial response for full file size', async () => {
    for (const response of [
        () => new Response('Login', { headers: { 'content-type': 'text/html', 'content-length': '1000' } }),
        () => new Response('Denied', { status: 403, headers: { 'content-type': 'video/mp4', 'content-length': '1000' } }),
        () => new Response('x', { status: 206, headers: { 'content-type': 'video/mp4', 'content-length': '1' } }),
    ]) {
        assert.equal(await gallery(response).fetchFapFolderStreamSizeMb('https://fapfolder.club/video/play'), null);
        assert.equal(await selector(response).fetchFapFolderStreamSizeMb('https://fapfolder.club/video/play'), null);
    }
});

test('selector replaces wrong legacy metadata and resolves signed sources fresh', async () => {
    let calls = 0;
    const ctx = selector(async url => {
        calls++;
        return String(url).includes('/posts/') ? new Response(page)
            : new Response('x', { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-0/43888888' } });
    });
    for (let i = 0; i < 2; i++) {
        const meta = await ctx.fetchVideoMeta('https://fapfolder.club/posts/166110', 1);
        assert.equal(meta.duration, null);
        assert.equal(meta.quality, null);
        assert.equal(meta.adapter, 'fapfolder-player-v2');
        assert.equal(meta.sizeExact, true);
        assert.equal(meta.sizeMb, 43888888 / 1048576);
    }
    assert.equal(calls, 4);
});

test('Gallery hydration rejects foreign URLs and reports unavailable sources explicitly', async () => {
    let calls = 0;
    const ctx = gallery(async () => { calls++; return new Response('<title>Login</title>'); });
    assert.match((await ctx.hydrateFapFolderItem({ url: 'https://example.com/post/1' })).error, /Invalid/);
    assert.equal(calls, 0);
    assert.match((await ctx.hydrateFapFolderItem({ url: 'https://fapfolder.club/posts/1' })).error, /source unavailable/);
});

test('worker queue preserves every item and limits concurrent requests to two', async () => {
    let active = 0, peak = 0;
    const ctx = gallery();
    const result = await ctx.mapFapFolderWithLimit(Array.from({ length: 111 }, (_, i) => i), 2, async value => {
        peak = Math.max(peak, ++active);
        await new Promise(resolve => setTimeout(resolve, 1));
        active--;
        return value;
    });
    assert.equal(result.length, 111);
    assert.equal(result[110], 110);
    assert.equal(peak, 2);
});

test('selector gallery metadata never reads injected duration badges', () => {
    const source = fs.readFileSync('extensions/nexus-video-selector/content.js', 'utf8');
    const a = source.indexOf('  function extractCardMeta(card)');
    const b = source.indexOf('  function extractBackgroundImageUrl', a);
    const ctx = vm.createContext({ isFapFolderPage: () => true });
    vm.runInContext(source.slice(a, b), ctx);
    const result = ctx.extractCardMeta({ querySelector: () => { throw Error('Must not read injected badges'); } });
    assert.equal(result.duration, null);
    assert.equal(result.quality, null);
});

test('selector player probe replaces duration, uses portrait short edge and cleans up', async () => {
    const source = fs.readFileSync('extensions/nexus-video-selector/content.js', 'utf8');
    const a = source.indexOf('  function hydrateFapFolderDuration');
    const b = source.indexOf('  function getLazyObserver', a);
    const card = { isConnected: true, querySelector: () => ({}) };
    const handlers = {};
    let removed = false, displayed = null;
    const video = {
        duration: 112.5, videoWidth: 624, videoHeight: 832, style: {},
        addEventListener: (name, callback) => { handlers[name] = callback; },
        removeAttribute() {}, load() {}, remove: () => { removed = true; },
        set src(value) { queueMicrotask(() => handlers.loadedmetadata()); },
    };
    const state = { cardMeta: new WeakMap(), fetchCache: new Map(), fapFolderProbeQueue: [], fapFolderProbeActive: 0 };
    state.cardMeta.set(card, { duration: null, quality: null, sizeMb: 41 });
    const ctx = vm.createContext({ state, setTimeout, clearTimeout,
        document: { createElement: () => video, body: { appendChild() {} } },
        getVideoUrlFromCard: () => 'https://fapfolder.club/posts/166110',
        updateBadge: (_, __, meta) => { displayed = meta; },
    });
    vm.runInContext(source.slice(a, b), ctx);
    ctx.hydrateFapFolderDuration(card, 'https://fapfolder.club/video/play?sig=fresh');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(displayed.duration, '1:53');
    assert.equal(displayed.quality, '624P');
    assert.equal(displayed.width, 624);
    assert.equal(displayed.height, 832);
    assert.equal(displayed._durationLoading, false);
    assert.equal(displayed._playerMetadataAttempted, true);
    assert.equal(removed, true);
    assert.equal(state.fapFolderProbeActive, 0);
});


test('Gallery reads added date only from the post timestamp, never video duration', () => {
    const meta = gallery().extractFapFolderMetaFromHtml(`<a class="js_moment" data-time="2026-09-08 14:17:16">a month ago</a>` + page);
    assert.equal(meta.addedAt, '2026-09-08 14:17:16');
    assert.equal(meta.duration, 0);
    assert.equal(gallery().extractFapFolderMetaFromHtml(page).addedAt, '');
});


test('FapFolder import resolves a fresh validated CDN file and keeps each unique post source', async () => {
    let pages = 0;
    const ctx = gallery(async url => {
        if (String(url).includes('/posts/')) { pages++; return new Response('<a class="js_moment" data-time="2026-09-08 14:17:16">date</a>' + page); }
        const response = new Response('x', { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-0/43888888' } });
        Object.defineProperty(response, 'url', { value: 'https://cdn.example/video.mp4' });
        return response;
    });
    const items = [1, 2].map(id => ({ url: `https://fapfolder.club/posts/${id}`, sourceUrl: 'https://fapfolder.club/groups/model/videos', duration: 112.5, width: 624, height: 832 }));
    const videos = await ctx.buildFapFolderImportVideos(items);
    assert.equal(pages, 2);
    assert.equal(videos[0].url, 'https://cdn.example/video.mp4');
    assert.equal(videos[0].source_url, items[0].url);
    assert.equal(videos[1].source_url, items[1].url);
    assert.equal(videos[0].duration, 112.5);
    assert.equal(videos[0].upload_date, '20260908');
    assert.equal(videos[0].file_size_mb, 43888888 / 1048576);
});

test('FapFolder import rejects a login page instead of sending a false playable item', async () => {
    const ctx = gallery(async () => new Response('<title>Login</title>'));
    await assert.rejects(ctx.buildFapFolderImportVideos([{ url: 'https://fapfolder.club/posts/1' }]), /source unavailable/);
});
