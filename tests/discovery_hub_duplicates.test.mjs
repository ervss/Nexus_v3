import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
globalThis.window = {};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'app', 'static', 'main.js'), 'utf8');
const duplicateStart = source.indexOf('        albumViewerDuplicateSignature(item) {');
const duplicateEnd = source.indexOf('        albumViewerSourceAlbumFileCount(', duplicateStart);
const visibleStart = source.indexOf('        albumViewerVisible() {');
const visibleEnd = source.indexOf('        albumViewerTotalSize() {', visibleStart);

assert.ok(duplicateStart >= 0 && duplicateEnd > duplicateStart, 'duplicate detection methods exist');
assert.ok(visibleStart >= 0 && visibleEnd > visibleStart, 'album visibility method exists');

const sizeStart = source.indexOf('        albumViewerImportSizeBytes(file) {');
const sizeEnd = source.indexOf('        albumViewerDefaultImportName(', sizeStart);
const methods = new Function(`return ({${source.slice(duplicateStart, duplicateEnd)}${source.slice(visibleStart, visibleEnd)}${source.slice(sizeStart, sizeEnd)}})`)();
const makeViewer = items => Object.assign({
    _avSeq: 1,
    discoveryHubDateValue: () => 0,
    albumViewer: {
        isCombined: true,
        showDuplicates: false,
        items,
        selected: new Set(),
        search: '',
        filter: 'all',
        sort: 'latest',
        sortDir: 'desc',
        sourceAlbumFilter: 'all',
        minSizeMb: 0,
        minDurSec: 0,
        minHeightPx: 0,
        duplicateUrls: new Set(),
        duplicateExactUrls: new Set(),
        duplicateHiddenUrls: new Set(),
        duplicateReasons: new Map(),
        thumbnailHashes: new Map(),
        thumbnailHashPromises: new Map(),
        duplicateGroupCount: 0,
    },
}, methods);

const titleMatches = makeViewer([
    { url: 'low', title: 'Movie Episode 720p.mp4', type: 'video', height: 720, source_album_url: 'album-a' },
    { url: 'high', title: 'Movie Episode 1080p.mp4', type: 'video', height: 1080, source_album_url: 'album-b' },
]);
titleMatches.albumViewerDetectDuplicates();
assert.deepEqual(titleMatches.albumViewerVisible().map(item => item.url), ['high'],
    'the gallery hides lower-resolution matches by default');
titleMatches.albumViewer.showDuplicates = true;
assert.equal(titleMatches.albumViewerVisible().length, 2, 'the toggle reveals hidden title matches');

const thumbnailMatches = makeViewer([
    { url: 'visual-low', title: 'Unrelated Clip One.mp4', type: 'video', height: 480, source_album_url: 'album-a' },
    { url: 'visual-high', title: 'Different Scene Two.mp4', type: 'video', height: 1080, source_album_url: 'album-b' },
]);
thumbnailMatches.albumViewer.thumbnailHashes.set('visual-low', '0000000000000000');
thumbnailMatches.albumViewer.thumbnailHashes.set('visual-high', '000000000000000f');
thumbnailMatches.albumViewer.selected.add('visual-low');
thumbnailMatches.albumViewerDetectDuplicates();
assert.deepEqual(thumbnailMatches.albumViewerVisible().map(item => item.url), ['visual-high'],
    'similar thumbnails keep the highest-resolution file visible');
assert.equal(thumbnailMatches.albumViewer.selected.has('visual-low'), false,
    'a newly hidden duplicate is removed from the active selection');
assert.equal(thumbnailMatches.albumViewerThumbnailHashesMatch('0000000000000000', '000000000000001f'), false,
    'visually distinct thumbnails outside the match threshold are not grouped');
thumbnailMatches.albumViewer.showDuplicates = true;
assert.equal(thumbnailMatches.albumViewerVisible().length, 2, 'the toggle reveals hidden thumbnail matches');

console.log('Discovery Hub duplicate detection and best-quality visibility passed.');

const sizeFilter = makeViewer([
    { url: 'image', type: 'image', size: '200 MB' },
    { url: 'small', type: 'video', size: '99 MB' },
    { url: 'boundary', type: 'video', size_bytes: 100 * 1048576 },
    { url: 'unknown', type: 'video' },
]);
assert.deepEqual(new Set(sizeFilter.albumViewerVisible().map(item => item.url)), new Set(['boundary', 'unknown']));
sizeFilter.albumViewer.isCombined = false;
assert.equal(sizeFilter.albumViewerVisible().length, 4, 'ordinary albums are unaffected');

const keywords = makeViewer([
    {url:'a',title:'Summer Streamss.mp4',type:'video'},
    {url:'b',title:'Summer Beach.mp4',type:'video'},
    {url:'c',title:'Winter Beach.mp4',type:'video'},
    {url:'d',title:'Summer Dildo.mp4',type:'video'},
]);
keywords.albumViewer.search='summer, winter';
keywords.albumViewer.excludeKeywords='stream, DILDO';
assert.deepEqual(new Set(keywords.albumViewerVisible().map(item=>item.url)),new Set(['b','c']));
keywords.albumViewer.search='';
keywords.albumViewer.excludeKeywords='';
assert.equal(keywords.albumViewerVisible().length,4);
