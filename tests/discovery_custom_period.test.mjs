import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.window = {};
const source = fs.readFileSync('app/static/main.js', 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const methods = new Function(`return ({${extract('        discoveryHubCombinedDateMatches(', '        async discoveryHubOpenSharedFiles(')}${extract('        albumViewerVisible() {', '        albumViewerTotalSize() {')}})`)();
const now = Date.now();
const items = [
    ...Array.from({length: 35}, (_, i) => ({url: `a${i}`, title: `a${i}`, type: 'video', source_album_url: 'a', uploaded_at: new Date(now - (i + 1.5) * 86400000).toISOString()})),
    ...Array.from({length: 35}, (_, i) => ({url: `b${i}`, title: `b${i}`, type: 'video', source_album_url: 'b', uploaded_at: new Date(now - (i + 1.5) * 86400000).toISOString()})),
    {url: 'unknown', title: 'unknown', type: 'video', source_album_url: 'a'},
];
const viewer = Object.assign({albumViewer: {isCombined: true, sharedFilesOnly: true, items, showDuplicates: true,
    sourceAlbumFilter: 'all', sourceAlbumFilters: [], search: '', filter: 'all', sort: 'name', sortDir: 'asc'},
    discoveryHubDateValue: () => 0}, methods);
viewer.albumViewer.recentFilter = 'older-than';
viewer.albumViewer.olderThanDays = '30';
assert.deepEqual(new Set(viewer.albumViewerVisible().map(i => i.url)), new Set(['a29', 'a30', 'a31', 'a32', 'a33', 'a34', 'b29', 'b30', 'b31', 'b32', 'b33', 'b34']));
viewer.albumViewer.olderThanDays = '';
assert.equal(viewer.albumViewerVisible().length, 71);
viewer.albumViewer.recentFilter = 'custom-per-album';
viewer.albumViewer.recentPerAlbumCount = '30';
const latest = viewer.albumViewerVisible();
assert.equal(latest.length, 60);
assert.ok(latest.some(i => i.url === 'a29') && !latest.some(i => i.url === 'a30'));
assert.ok(latest.some(i => i.url === 'b29') && !latest.some(i => i.url === 'b30'));
viewer.albumViewer.recentPerAlbumCount = '';
assert.equal(viewer.albumViewerVisible().length, 71);
viewer.albumViewer.recentFilter = '10-per-album';
assert.equal(viewer.albumViewerVisible().length, 20);
console.log('Discovery Hub custom period filters passed.');
