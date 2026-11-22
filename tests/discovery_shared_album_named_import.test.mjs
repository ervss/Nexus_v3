import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../app/static/main.js', import.meta.url), 'utf8');
const start = source.indexOf('        albumViewerResetImportStatus() {');
const end = source.indexOf('        async albumViewerImportSelected()', start);
const methodEnd = source.indexOf('\n        },', end) + 11;
const methods = new Function(`return ({${source.slice(start, methodEnd)}})`)();
const files = Array.from({length: 63}, (_, i) => ({url: `https://bunkr.cr/f/${i}`, type:'video', size_bytes: 1073741824 * 30 / 63}));
const requests = [];
const viewer = Object.assign({ albumViewer: {items:files, selected:new Set(files.map(f => f.url)), importStatus:{}, isCombined:true, importKeyword:'Madiiitay'},
  albumViewerVisible: () => files, albumViewerImportSprite: async () => '', albumViewerRefreshImportStatus: () => {},
  showToast: () => {}, loadSourceBoards: () => {}, loadImportMonitor: () => {} }, methods);
viewer.albumViewerRefreshImportStatus = () => {};
viewer.albumViewerOpenImportOptions();
assert.equal(viewer.albumViewer.importName, 'Madiiitay - bunkr 63 vids 30 GB');
assert.equal(viewer.albumViewer.importAsBoard, true);
globalThis.fetch = async (url, options) => {
  const body = JSON.parse(options.body); requests.push({url, body});
  return {ok:true, json:async () => url.endsWith('/intake/import') ? {job:{id:42,batch_name:`${body.batch_name} · job #42`}} : {success:true}};
};
await viewer.albumViewerImportSelected();
assert.equal(requests.length, 2);
assert.equal(requests[0].body.candidates.length, 63);
assert.equal(requests[0].body.batch_name, 'Madiiitay - bunkr 63 vids 30 GB');
assert.equal(requests[1].body.name, requests[0].body.batch_name);
assert.equal(requests[1].body.batch_name, 'Madiiitay - bunkr 63 vids 30 GB · job #42');
assert.equal(viewer.albumViewerDefaultImportName([{type:'video',size_bytes:0}]), 'Madiiitay - bunkr 1 vids neznáma veľkosť');
console.log('Discovery shared album named import passed.');

