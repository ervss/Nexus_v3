import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../app/static/main.js', import.meta.url), 'utf8');
const start = source.indexOf('        albumViewerResetImportStatus() {');
const end = source.indexOf('        async albumViewerImportSelected()', start);
assert.ok(start >= 0 && end > start);
const methods = new Function(`return ({${source.slice(start, end)}})`)();
const files = [
    { url: 'https://bunkr.cr/f/one', stream_url: 'https://cdn.test/one.mp4' },
    { url: 'https://bunkr.cr/f/two' },
    { url: 'https://bunkr.cr/f/three' },
];
const viewer = Object.assign({ _avSeq: 1, albumViewer: {
    items: files, open: false, importStatus: {}, importStatusChecked: false,
} }, methods);
globalThis.fetch = async (_url, options) => {
    assert.ok(JSON.parse(options.body).urls.includes(files[0].url));
    return { ok: true, json: async () => ({ matches: {
        [files[0].url]: { status: 'duplicate', job_id: 9, in_dashboard: true },
        [files[1].url]: { status: 'failed', error: 'timeout' },
    } }) };
};
await viewer.albumViewerRefreshImportStatus();
assert.equal(viewer.albumViewerImportLabel(files[0]), 'Už existuje');
assert.equal(viewer.albumViewerImportCanQueue(files[0]), false);
assert.equal(viewer.albumViewerImportCanQueue(files[1]), true);
assert.equal(viewer.albumViewerImportLabel(files[2]), 'V knižnici nenájdené');
assert.deepEqual(viewer.albumViewerImportCounts(), { queued: 0, imported: 0, duplicate: 1, failed: 1, absent: 1 });
globalThis.fetch = async () => { throw new Error('offline'); };
await viewer.albumViewerRefreshImportStatus();
assert.equal(viewer.albumViewer.importStatusChecked, false);
assert.match(viewer.albumViewer.importStatusError, /offline/);
console.log('Discovery album import status passed.');
