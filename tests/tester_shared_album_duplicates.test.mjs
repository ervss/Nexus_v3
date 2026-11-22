import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const template = fs.readFileSync('app/templates/tester.html', 'utf8');
const start = template.indexOf('function dupeFactsFor(');
const end = template.indexOf('async function runTest(', start);
assert.ok(start >= 0 && end > start, 'duplicate detection helpers are present');

const context = {
    batchMetaByUrl: new Map(),
    getMetadataForUrl: () => ({}),
    window: { location: { origin: 'http://localhost' } },
    showToast() {},
};
vm.createContext(context);
vm.runInContext(template.slice(start, end), context);
const visibilityStart = template.indexOf('function isSharedAlbumChild(');
const visibilityEnd = template.indexOf('\n        function getItemSortValue(', visibilityStart);
const importFilterStart = template.indexOf('function albumItemsForImport(');
const importFilterEnd = template.indexOf('\n        async function sendImport(', importFilterStart);
assert.ok(visibilityStart >= 0 && visibilityEnd > visibilityStart, 'shared duplicate visibility helper is present');
assert.ok(importFilterStart >= 0 && importFilterEnd > importFilterStart, 'shared album import filter is present');
vm.runInContext(template.slice(visibilityStart, visibilityEnd), context);
vm.runInContext(template.slice(importFilterStart, importFilterEnd), context);

const bestQuality = {
    url: 'https://host-a.example/video-a',
    data: {
        title: 'Different title from host A',
        thumbnail: 'https://host-a.example/thumb-a.jpg',
        visual_hash: '0000000000000000',
        height: 1080,
        size_bytes: 30_000_000,
        duration: 80,
    },
};
const lowerQuality = {
    url: 'https://host-b.example/video-b',
    data: {
        title: 'Different title from host B',
        thumbnail: 'https://host-b.example/thumb-b.jpg',
        visual_hash: '0000000000000001',
        height: 720,
        size_bytes: 90_000_000,
        duration: 81,
    },
};
context.detectAndMarkDuplicates([bestQuality, lowerQuality], { notify: false });
assert.equal(bestQuality.isDuplicate, false, 'the higher-resolution re-host remains visible');
assert.equal(lowerQuality.isDuplicate, true, 'a visually matching re-host is hidden as a duplicate');
assert.equal(lowerQuality.dupeOf, bestQuality.url);

const sameNameA = {
    url: 'https://filester.example/file/first',
    data: { title: 'same-video-title.mp4', size_bytes: 20_000_000, height: 720 },
};
const sameNameB = {
    url: 'https://other.example/file/second',
    data: { title: 'same video title.mp4', size_bytes: 25_000_000, height: 1080 },
};
context.detectAndMarkDuplicates([sameNameA, sameNameB], { notify: false });
assert.equal(sameNameA.isDuplicate, true, 'the better copy wins when titles match');
assert.equal(sameNameB.isDuplicate, false);

const unrelated = {
    url: 'https://host-c.example/unrelated',
    data: {
        title: 'Unrelated clip',
        visual_hash: 'ffffffffffffffff',
        height: 1080,
        size_bytes: 30_000_000,
        duration: 80,
    },
};
context.detectAndMarkDuplicates([bestQuality, unrelated], { notify: false });
assert.equal(unrelated.isDuplicate, false, 'different titles and previews are not merged by similar metadata');

context.sharedAlbumView = {
    viewPayload: { results: [{ url: 'shared-album' }] },
    showDuplicates: false,
};
assert.equal(context.isHiddenSharedAlbumDuplicate({
    _albumParent: 'shared-album',
    isDuplicate: true,
}), true);
assert.equal(context.isHiddenSharedAlbumDuplicate({
    _albumParent: 'shared-album',
    isDuplicate: false,
}), false);
assert.deepEqual(
    Array.from(context.albumItemsForImport({
        data: {
            _sharedAlbumRoot: true,
            album_items: [{ id: 'best' }, { id: 'duplicate', isDuplicate: true }],
        },
    }), item => item.id),
    ['best'],
    'selecting the shared album imports only its visible best copies by default',
);
context.sharedAlbumView.showDuplicates = true;
assert.equal(context.isHiddenSharedAlbumDuplicate({
    _albumParent: 'shared-album',
    isDuplicate: true,
}), false, 'the show-duplicates toggle reveals marked copies');
assert.deepEqual(
    Array.from(context.albumItemsForImport({
        data: {
            _sharedAlbumRoot: true,
            album_items: [{ id: 'best' }, { id: 'duplicate', isDuplicate: true }],
        },
    }), item => item.id),
    ['best', 'duplicate'],
    'revealed duplicates remain available for explicit import',
);
