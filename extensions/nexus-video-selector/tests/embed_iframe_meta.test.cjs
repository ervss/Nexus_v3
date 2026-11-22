const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const bgPath = path.resolve(__dirname, '../background.js');

function loadExtractSlice() {
    const src = fs.readFileSync(bgPath, 'utf8');
    const start = src.indexOf('async function fetchTextViaTabOrDirect(');
    const end = src.indexOf('function isFapFolderUrl(', start);
    assert.ok(start >= 0 && end > start, 'background.js extraction slice found');
    return src.slice(start, end);
}

test('extractQualityAndSizeAsync resolves Vidara iframe embed stream, quality and size', async () => {
    const slice = loadExtractSlice();
    const fetchCalls = [];
    const context = {
        URL,
        AbortSignal,
        Number,
        String,
        Boolean,
        Promise,
        Math,
        Set,
        parseInt,
        parseFloat,
        isNaN,
        chrome: {
            tabs: { sendMessage: (_tabId, _msg, cb) => cb(null) },
            runtime: { lastError: null },
        },
        extractPornhubMediaMeta: async () => null,
        normalizeQualityLabel: (q) => String(q || '').toUpperCase(),
        isReasonableSizeEstimate: (mb) => Number(mb) > 0,
        calculateQualityFromBitrate: () => null,
        fetchHeadSize: async () => null,
        extractLuluHlsUrl: () => '',
        fetchHtml: async () => '',
        fetch: async (url, opts = {}) => {
            fetchCalls.push({ url: String(url), method: opts.method || 'GET' });
            if (String(url) === 'https://vidara.to/api/stream') {
                return {
                    ok: true,
                    json: async () => ({
                        streaming_url: 'https://cdn.example.test/hls/abc/master.m3u8?token=1',
                    }),
                };
            }
            if (String(url) === 'https://cdn.example.test/hls/abc/master.m3u8?token=1') {
                return {
                    ok: true,
                    text: async () => [
                        '#EXTM3U',
                        '#EXT-X-STREAM-INF:BANDWIDTH=3000000,AVERAGE-BANDWIDTH=3000000,RESOLUTION=1280x720',
                        'index_1280x720.m3u8?token=1',
                    ].join('\n'),
                };
            }
            if (String(url) === 'https://cdn.example.test/hls/abc/index_1280x720.m3u8?token=1') {
                return {
                    ok: true,
                    text: async () => [
                        '#EXTM3U',
                        '#EXTINF:6.0,',
                        'seg0.ts',
                        '#EXTINF:6.0,',
                        'seg1.ts',
                        '#EXTINF:6.0,',
                        'seg2.ts',
                    ].join('\n'),
                };
            }
            if (/seg\d\.ts$/.test(String(url)) && opts.method === 'HEAD') {
                return {
                    ok: true,
                    headers: new Headers({ 'content-length': String(3 * 1024 * 1024) }),
                };
            }
            return { ok: false, headers: new Headers(), text: async () => '' };
        },
    };
    vm.createContext(context);
    vm.runInContext(slice, context);

    const html = '<div class="player-wrapper"><iframe id="embed-player-frame" src="https://vidara.to/e/zkQNMntdBxilK"></iframe></div>';
    const result = await context.extractQualityAndSizeAsync(html, '0:18', 1, 'https://onlypornv.com/video/sample');
    assert.equal(result.quality, '720P');
    assert.equal(result.sizeMb, 9);
    assert.equal(result.sizeText, '~9 MB');
    assert.equal(result.sizeEstimated, true);
    assert.equal(result.streamUrl, 'https://cdn.example.test/hls/abc/master.m3u8?token=1');
    assert.ok(fetchCalls.some((c) => c.url === 'https://vidara.to/api/stream' && c.method === 'POST'));
});

test('extractQualityAndSizeAsync resolves 2-hop HQPornerxxx -> myxstudio -> mydaddy escaped MP4 and div duration', async () => {
    const slice = loadExtractSlice();
    const headUrls = [];
    const context = {
        URL,
        AbortSignal,
        Number,
        String,
        Boolean,
        Promise,
        Math,
        Set,
        parseInt,
        parseFloat,
        isNaN,
        chrome: {
            tabs: { sendMessage: (_tabId, _msg, cb) => cb(null) },
            runtime: { lastError: null },
        },
        extractPornhubMediaMeta: async () => null,
        normalizeQualityLabel: (q) => String(q || '').toUpperCase(),
        isReasonableSizeEstimate: (mb) => Number(mb) > 0,
        calculateQualityFromBitrate: () => null,
        extractLuluHlsUrl: () => '',
        fetchHeadSize: async (url, _ref, _exact, outMeta) => {
            headUrls.push(url);
            if (outMeta && url.endsWith('/1080.mp4')) {
                outMeta.lastModified = 'Tue, 10 Nov 2026 22:27:34 GMT';
            }
            return url.endsWith('/1080.mp4') ? 978 : 420;
        },
        fetchHtml: async (url) => {
            if (url === 'https://myxstudio.top/embed/0210bc8545fc0c79ca') {
                return '<iframe src="//mydaddy.cc/video/0210bc8545fc0c79ca"></iframe>';
            }
            if (url === 'https://mydaddy.cc/video/0210bc8545fc0c79ca') {
                return '<script>html("<source src=\\"//tops.mydaddy.cc/pubs/abc/720.mp4\\"><source src=\\"//tops.mydaddy.cc/pubs/abc/1080.mp4\\">")</script>';
            }
            return '';
        },
        fetch: async () => ({ ok: false, headers: new Headers(), text: async () => '' }),
    };
    vm.createContext(context);
    vm.runInContext(slice, context);

    const detailHtml = '<div class="ratio"><iframe src="//myxstudio.top/embed/0210bc8545fc0c79ca"></iframe></div><div class="duration" title="40:31">40:31</div>';
    const duration = context.extractDuration(detailHtml);
    assert.equal(duration, '40:31');

    const result = await context.extractQualityAndSizeAsync(detailHtml, duration, 1, 'https://hqpornerxxx.com/videos/sample-39962.html');
    assert.equal(result.quality, '1080P');
    assert.equal(result.sizeMb, 978);
    assert.equal(result.sizeText, '978 MB');
    assert.equal(result.streamUrl, 'https://tops.mydaddy.cc/pubs/abc/1080.mp4');
    assert.equal(result.lastModifiedDate, 'Nov 10, 2026');
    assert.deepEqual(headUrls, [
        'https://tops.mydaddy.cc/pubs/abc/1080.mp4',
        'https://tops.mydaddy.cc/pubs/abc/720.mp4',
    ]);
});
