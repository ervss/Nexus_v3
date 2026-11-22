import assert from 'node:assert/strict';
import fs from 'node:fs';
globalThis.window = {};
const source = fs.readFileSync('app/static/main.js', 'utf8');
const selectStart = source.indexOf('        albumViewerToggleSourceAlbum(url) {');
const selectEnd = source.indexOf("        // Bunkr's album HTML", selectStart);
const visibleStart = source.indexOf('        albumViewerVisible() {');
const visibleEnd = source.indexOf('        albumViewerTotalSize() {', visibleStart);
const sizeStart = source.indexOf('        albumViewerImportSizeBytes(file) {');
const sizeEnd = source.indexOf('        albumViewerDefaultImportName(', sizeStart);
const methods = new Function(`return ({${source.slice(selectStart,selectEnd)}${source.slice(visibleStart,visibleEnd)}${source.slice(sizeStart,sizeEnd)}})`)();
const viewer = Object.assign({
    albumViewer: {isCombined:true, sourceAlbumFilter:'all', sourceAlbumFilters:[],
        sourceAlbums:[{url:'a',title:'Album A'}, {url:'b',title:'Album B'}, {url:'c',title:'Album C'}],
        items:[{url:'a-only',title:'A',type:'video',source_album_urls:['a']},
            {url:'shared',title:'Shared',type:'video',source_album_urls:['a','b']},
            {url:'b-only',title:'B',type:'video',source_album_urls:['b']},
            {url:'c-only',title:'C',type:'video',source_album_urls:['c']}],
        selected:new Set(['a-only','shared']), showDuplicates:true, search:'',filter:'all',sort:'name',sortDir:'asc'},
    albumViewerDetectDuplicates() {}, albumViewerRefreshImportStatus() {}, combinedHistoryRemember() {},
}, methods);
viewer.albumViewerToggleSourceAlbum('a');
viewer.albumViewerToggleSourceAlbum('c');
assert.deepEqual(new Set(viewer.albumViewerVisible().map(i=>i.url)),new Set(['a-only','shared','c-only']));
viewer.albumViewerRemoveSourceAlbum('a');
assert.deepEqual(new Set(viewer.albumViewer.items.map(i=>i.url)),new Set(['shared','b-only','c-only']));
assert.deepEqual(viewer.albumViewer.items.find(i=>i.url==='shared').source_album_urls,['b']);
assert.deepEqual([...viewer.albumViewer.selected],['shared']);
assert.deepEqual(viewer.albumViewer.sourceAlbumFilters,['c']);
assert.deepEqual(viewer.albumViewerVisible().map(i=>i.url),['c-only']);
viewer.albumViewer.fetchJobId='running'; viewer.albumViewer.fetchState='running';
viewer.albumViewerRemoveSourceAlbum('c');
assert.equal(viewer.albumViewer.sourceAlbums.length,2,'cannot remove while source listings are still arriving');
