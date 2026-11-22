import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('app/static/main.js', 'utf8');
const template = fs.readFileSync('app/templates/index.html', 'utf8').replace(
    /\{%\s*include\s+"([^"]+)"\s*%\}/g,
    (_, rel) => fs.readFileSync(`app/templates/${rel}`, 'utf8')
);
const suite = fs.readFileSync('userscripts/bunkr-suite.user.js', 'utf8');

function extractMethods(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.notEqual(start, -1, `Missing method marker: ${startMarker}`);
    assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);
    return new Function('window', `return ({${source.slice(start, end)}})`)(globalThis.window || {});
}

const orientationMethods = extractMethods(
    '        albumViewerIsVertical(item) {',
    '        albumViewerTotalSize()',
);
assert.equal(orientationMethods.albumViewerIsVertical({ type: 'video', width: 720, height: 1280 }), true);
assert.equal(orientationMethods.albumViewerIsVertical({ type: 'video', width: 1280, height: 720 }), false);
assert.equal(orientationMethods.albumViewerIsVertical({ type: 'file', width: 720, height: 1280 }), false);
assert.equal(orientationMethods.albumViewerAspectRatio({ type: 'video', aspect_ratio: 0.5625 }), '0.5625');
assert.equal(orientationMethods.albumViewerAspectRatio({ type: 'video', isVertical: true }), '9 / 16');

const thumbnailMethods = extractMethods(
    '        albumViewerThumbnailLoaded(event, item) {',
    '        albumViewerEnsureThumbnailHash(item, source) {',
);
const portrait = { type: 'video', url: 'https://bunkr.cr/f/portrait' };
const hashes = [];
const thumbnailViewer = {
    ...thumbnailMethods,
    albumViewer: { isCombined: true },
    albumViewerEnsureThumbnailHash: (item, url) => hashes.push([item.url, url]),
};
thumbnailViewer.albumViewerThumbnailLoaded({
    target: { naturalWidth: 360, naturalHeight: 640, currentSrc: 'https://scdn.st/portrait.jpg' },
}, portrait);
assert.equal(portrait.isVertical, true);
assert.equal(portrait.aspect_ratio, 360 / 640);
assert.deepEqual(hashes, [['https://bunkr.cr/f/portrait', 'https://scdn.st/portrait.jpg']]);

const visibleMethods = extractMethods(
    '        albumViewerVisible() {',
    '        albumViewerIsVertical(item) {',
);
const verticalFiles = [
    { url: 'vertical', type: 'video', width: 720, height: 1280, size_bytes: 10 },
    { url: 'landscape', type: 'video', width: 1280, height: 720, size_bytes: 10 },
    { url: 'image', type: 'image', width: 400, height: 800, size_bytes: 10 },
];
const visibleViewer = {
    ...visibleMethods,
    ...orientationMethods,
    albumViewer: {
        items: verticalFiles,
        isCombined: true,
        sharedFilesOnly: true,
        onlyVertical: true,
        filter: 'all',
        sourceAlbumFilter: 'all',
        sourceAlbumFilters: [],
        search: '',
        excludeKeywords: '',
        showDuplicates: true,
        minSizeMb: 0,
        minDurSec: 0,
        minHeightPx: 0,
        sort: 'name',
        sortDir: 'asc',
    },
    albumViewerImportSizeBytes: item => item.size_bytes,
};
assert.deepEqual(visibleViewer.albumViewerVisible().map(item => item.url), ['vertical']);
visibleViewer.albumViewer.onlyVertical = false;
assert.deepEqual(visibleViewer.albumViewerVisible().map(item => item.url), ['vertical', 'landscape', 'image']);
visibleViewer.albumViewer.hideVertical = true;
assert.deepEqual(visibleViewer.albumViewerVisible().map(item => item.url), ['landscape', 'image']);

const albumKeyMethods = extractMethods(
    '        discoveryHubAlbumKey(item) {',
    '        discoveryHubExcludeAlbum(item) {',
);
const handoffMethods = extractMethods(
    '        async discoveryHubOpenSharedFiles(payload) {',
    '        async discoveryHubOpenSelectedAlbums(',
);
const openStart = source.indexOf('        async discoveryHubOpenSelectedAlbums(');
const openEnd = source.indexOf('        combinedHistoryDay()', openStart);
assert.notEqual(openStart, -1);
assert.notEqual(openEnd, -1);
const openMethods = new Function('window', `return ({${source.slice(openStart, openEnd)}})`)(globalThis.window || {});
const albumViewer = {};
const handoffViewer = {
    ...albumKeyMethods,
    ...handoffMethods,
    ...openMethods,
    albumViewer,
    discoveryHubCombinedDays: 0,
    discoveryHubQuery: '',
    discoveryHubCombinedDateMatches: () => true,
    albumViewerResetImportStatus() {},
    albumViewerResetAi() {},
    albumViewerCloseRelated() {},
    albumViewerClosePlayer() {},
    albumViewerDetectDuplicates() {},
    _avScheduleThumbnailScan() {},
    _avScheduleDupes() {},
    albumViewerRefreshImportStatus() {},
    albumViewerMarkSuspectListingSizes() {},
    combinedHistoryRemember: async () => {},
    showToast: (...args) => { throw new Error(`Unexpected toast: ${args.join(' ')}`); },
};
await handoffViewer.discoveryHubOpenSharedFiles({
    version: 1,
    title: 'Bunkr Suite · vertical',
    files: [
        { url: 'https://bunkr.cr/f/1', type: 'video', isVertical: true, aspect_ratio: 0.5625, size_bytes: 10 },
        { url: 'https://bunkr.cr/f/1', type: 'video', isVertical: true },
        { url: 'javascript:alert(1)', type: 'video' },
    ],
});
assert.equal(albumViewer.albumTitle, 'Bunkr Suite · vertical');
assert.equal(albumViewer.sharedFilesOnly, true);
assert.equal(albumViewer.sourceAlbums.length, 0, 'handoff must not request the source album listing');
assert.equal(albumViewer.items.length, 1, 'handoff should deduplicate URLs and reject non-http schemes');
assert.equal(albumViewer.items[0].url, 'https://bunkr.cr/f/1');
assert.equal(albumViewer.items[0].isVertical, true);
assert.equal(albumViewer.items[0].aspect_ratio, 0.5625);

assert.match(suite, /data-act="openInHubVertical"/, 'rocket menu must include vertical-only handoff');
assert.match(suite, /data-act="openInHubSelected"/, 'rocket menu must include selected-only handoff');
assert.match(suite, /items\.filter\(\(it\) => it\.isVideo && it\.isVertical\)/,
    'vertical handoff must include only items detected as portrait videos');
assert.match(suite, /#nexus-bunkr=\$\{token\}/, 'handoff data must be carried to the local Discovery Hub page');
assert.match(template, /albumViewerAspectRatio\(file\)/, 'portrait cards must use a tall aspect ratio');
assert.match(template, /class="av-vertical-badge"/, 'portrait videos must show an orientation badge');

console.log('Discovery Hub portrait detection and Bunkr Suite handoff passed.');
