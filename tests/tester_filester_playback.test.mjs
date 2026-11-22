import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const template = fs.readFileSync('app/templates/tester.html', 'utf8');

function extractSlice(startMarker, endMarker) {
    const start = template.indexOf(startMarker);
    assert.notEqual(start, -1, `Missing start marker: ${startMarker}`);
    const end = template.indexOf(endMarker, start);
    assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);
    return template.slice(start, end);
}

function buildTesterContext(fetchImpl) {
    const elements = new Map();
    const makeEl = (id = '') => ({
        id,
        textContent: '',
        innerHTML: '',
        classList: {
            _set: new Set(),
            add(cls) { this._set.add(cls); },
            remove(cls) { this._set.delete(cls); },
            contains(cls) { return this._set.has(cls); },
        },
        attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        listeners: {},
        addEventListener(evt, fn) { this.listeners[evt] = fn; },
        removeEventListener() {},
        canPlayType() { return ''; },
        play() { return Promise.resolve(); },
        src: '',
        muted: false,
    });
    const playerTitle = makeEl('playerTitle');
    const playerMeta = makeEl('playerMeta');
    const playerSurface = makeEl('playerSurface');
    const playerModal = makeEl('playerModal');
    const playerVideoEl = makeEl('playerVideoEl');
    elements.set('playerVideoEl', playerVideoEl);

    const context = {
        URL,
        encodeURIComponent,
        Map,
        Set,
        Array,
        Object,
        String,
        Number,
        Boolean,
        Error,
        Promise,
        window: {},
        document: {
            getElementById(id) {
                if (id === 'playerVideoEl') return playerVideoEl;
                return elements.get(id) || makeEl(id);
            },
        },
        fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({ results: [] }) })),
        batchMetaByUrl: new Map(),
        playerRequestId: 0,
        testerPlayerHls: null,
        epornerTitleState: null,
        playerTitle,
        playerMeta,
        playerSurface,
        playerModal,
        isEpornerWatchUrl: url => /eporner\.com\/(?:video-|hd-porn\/)/i.test(url || ''),
        isDeadLegacyThumb: src => !String(src || '').trim(),
        turboFallbackThumbUrl: () => '',
        getMetadataForUrl: () => ({}),
        applyChildMetaToParents: () => {},
        videoTitleIdentity: u => u,
        escapeHtml: s => String(s || ''),
    };
    vm.createContext(context);

    const directSlice = extractSlice(
        '        function isKnownDirectVideoUrl(url)',
        '        function isDeadLegacyThumb(src)',
    );
    const modalSlice = extractSlice(
        '        async function openPlayerModal(item)',
        '        function updateHostFilterOptions(',
    );
    const childSlice = extractSlice(
        '        function createAlbumChildResult(album, albumItem, index, total)',
        '        function syncSearchChildren()',
    );
    vm.runInContext(directSlice + '\n' + modalSlice + '\n' + childSlice, context);
    return { context, playerVideoEl, playerMeta, playerSurface, playerModal };
}

test('Filester and FileDitch streams route through video_proxy and disable unproxied inline previews', () => {
    const { context } = buildTesterContext();
    const fscUrl = 'https://fsc1.cdn.cr/v2/adee7c23.mp4?token=abc';
    const cacheUrl = 'https://cache1.filester.me/v/abc123.mp4';
    const fdUrl = 'https://staysharpwakesat5am.xyz/beta1/abc/video.mp4?exp=1&sig=2';

    assert.equal(context.needsVideoProxy(fscUrl), true);
    assert.equal(context.needsVideoProxy(cacheUrl), true);
    assert.equal(context.needsVideoProxy(fdUrl), true);
    assert.equal(context.isKnownDirectVideoUrl(fscUrl), true);
    assert.equal(context.isKnownDirectVideoUrl(cacheUrl), true);
    assert.equal(context.canInlinePreview({ extractor: 'Filester', data: { kind: 'video', stream_url: fscUrl } }), false);
});

test('Expanded Filester folder children expose Play and lazy-resolve via batch-meta into video_proxy', async () => {
    const calls = [];
    const resolvedStream = 'https://fsc1.cdn.cr/v2/adee7c23.mp4?token=fresh';
    const { context, playerVideoEl } = buildTesterContext(async (url, opts) => {
        calls.push({ url, body: JSON.parse(opts.body) });
        return {
            ok: true,
            json: async () => ({
                results: [{
                    url: 'https://filester.me/d/Fa4cik1',
                    ok: true,
                    title: 'Clip 1',
                    stream_url: resolvedStream,
                    content_type: 'video/mp4',
                }],
            }),
        };
    });

    const album = { url: 'https://filester.me/f/8f37499e7d6063b1', extractor: 'Filester', data: { kind: 'album' } };
    assert.equal(context.canDirectPlay(album), false);

    const child = context.createAlbumChildResult(album, {
        url: 'https://filester.me/d/Fa4cik1',
        source_url: 'https://filester.me/d/Fa4cik1',
        title: 'Clip 1',
    }, 0, 1);

    assert.equal(context.canDirectPlay(child), true);
    await context.openPlayerModal(child);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/tester/batch-meta');
    assert.deepEqual(Array.from(calls[0].body.urls), ['https://filester.me/d/Fa4cik1']);
    assert.equal(
        playerVideoEl.src,
        `/api/v1/video_proxy?url=${encodeURIComponent(resolvedStream)}&referer=${encodeURIComponent('https://filester.me/d/Fa4cik1')}`,
    );
});

test('Direct Filester result plays through video_proxy without re-fetching', async () => {
    const calls = [];
    const { context, playerVideoEl } = buildTesterContext(async url => {
        calls.push(url);
        return { ok: true, json: async () => ({}) };
    });
    const stream = 'https://fsc1.cdn.cr/v2/video.mp4?token=live';
    const item = {
        url: 'https://filester.me/d/Fa4cik1',
        extractor: 'Filester',
        data: { kind: 'video', title: 'Clip', stream_url: stream },
    };

    assert.equal(context.canDirectPlay(item), true);
    await context.openPlayerModal(item);

    assert.equal(calls.length, 0);
    assert.equal(
        playerVideoEl.src,
        `/api/v1/video_proxy?url=${encodeURIComponent(stream)}&referer=${encodeURIComponent(item.url)}`,
    );
});

test('Filester lazy play falls back to /api/tester/resolve if batch-meta returns no stream', async () => {
    const calls = [];
    const resolvedStream = 'https://cache1.filester.me/v/fallback.mp4';
    const { context, playerVideoEl } = buildTesterContext(async url => {
        calls.push(url);
        if (url === '/api/tester/batch-meta') {
            return { ok: true, json: async () => ({ results: [{ url: 'https://filester.me/d/Abc123', ok: false }] }) };
        }
        return {
            ok: true,
            json: async () => ({
                results: [{
                    url: 'https://filester.me/d/Abc123',
                    status: 'success',
                    data: { title: 'Fallback', stream_url: resolvedStream, kind: 'video' },
                }],
            }),
        };
    });

    const item = {
        url: 'https://filester.me/d/Abc123',
        extractor: 'Filester',
        data: { kind: 'video', title: 'Fallback', stream_url: '' },
    };
    await context.openPlayerModal(item);

    assert.deepEqual(calls, ['/api/tester/batch-meta', '/api/tester/resolve']);
    assert.equal(
        playerVideoEl.src,
        `/api/v1/video_proxy?url=${encodeURIComponent(resolvedStream)}&referer=${encodeURIComponent(item.url)}`,
    );
});
