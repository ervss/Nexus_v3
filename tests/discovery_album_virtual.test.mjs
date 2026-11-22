import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('app/static/main.js', 'utf8');
const start = source.indexOf('        albumViewerVirtualSync(');
const end = source.indexOf('        albumViewerVisible() {', start);
assert.ok(start >= 0 && end > start);
const methods = new Function(`return ({${source.slice(start, end)}})`)();
globalThis.requestAnimationFrame = () => 1;
globalThis.getComputedStyle = () => ({gridTemplateColumns: '100px 100px 100px 100px', rowGap: '12px'});
const body = {scrollTop: 0, clientHeight: 600, getBoundingClientRect: () => ({top: 0})};
const grid = {clientWidth: 1000, getBoundingClientRect: () => ({top: -body.scrollTop}), querySelectorAll: () => []};
const files = Array.from({length: 1200}, (_, i) => ({url: `file-${i}`}));
const viewer = Object.assign({$refs: {avBody: body, avGrid: grid}, $nextTick() {}, albumViewer: {
    open: true, isCombined: true, layout: '4', renderMode: 'smooth',
    virtual: {items: [], start: 0, end: 32, top: 0, bottom: 0, columns: 4, gap: 12, rowHeight: 260, heights: [], signature: ''},
}}, methods);
viewer.albumViewerVirtualSync(files, '4', false, 'smooth');
viewer.albumViewerVirtualRefresh();
assert.ok(viewer.albumViewerRenderItems().length < 100, 'only a bounded viewport of cards is rendered');
assert.equal(viewer.albumViewerRenderItems()[0].url, 'file-0');
assert.ok(viewer.albumViewer.virtual.bottom > 0);
body.scrollTop = 100000;
viewer.albumViewerVirtualRefresh();
assert.ok(viewer.albumViewer.virtual.start > 0, 'scrolling removes earlier cards');
assert.equal(viewer.albumViewerRenderItems().at(-1).url, 'file-1199', 'last item remains reachable');
assert.ok(viewer.albumViewer.virtual.top > 0);
viewer.albumViewer.renderMode = 'classic';
viewer.albumViewerVirtualSync(files, '4', false, 'classic');
assert.equal(viewer.albumViewerRenderItems().length, 1200, 'classic mode shows all items');
viewer.albumViewer.renderMode = 'smooth';
body.scrollTop = 0;
viewer.albumViewerVirtualSync(files.slice(0, 12), '4', false, 'smooth');
viewer.albumViewerVirtualRefresh();
assert.equal(viewer.albumViewerRenderItems().length, 12, 'filtering resets the virtual range');
console.log('Discovery Hub virtual album window passed.');
