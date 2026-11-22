import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../app/static/main.js', import.meta.url), 'utf8');
const start = source.indexOf('        albumViewerResetAi() {');
const end = source.indexOf('        albumViewerVisible() {', start);
const methods = new Function(`return ({${source.slice(start, end)}})`)();
const items = [{url:'one',type:'video'}, {url:'two',type:'video'}, {url:'three',type:'video'}];
const viewer = Object.assign({ _avSeq: 2, albumViewer: {open:true, ai:{category:'blowjob', mode:'deep', filter:'all', results:{}, running:false}},
    albumViewerVisible: () => items,
    albumViewerAiFrames: async file => { if (file.url === 'two') throw new Error('no frame'); return {images:['frame'], incomplete:file.url === 'three'}; }
}, methods);
viewer.albumViewerAiFrames = async file => { if (file.url === 'two') throw new Error('no frame'); return {images:['frame'], incomplete:file.url === 'three'}; };
globalThis.fetch = async () => ({ok:true,json:async () => ({status:'match',score:1.2,frames:1})});
await viewer.albumViewerAiStart();
assert.equal(viewer.albumViewer.ai.done, 3);
assert.equal(viewer.albumViewer.ai.results.two.status, 'failed');
assert.equal(viewer.albumViewer.ai.results.three.incomplete, true);
assert.equal(viewer.albumViewer.ai.running, false);
viewer.albumViewerAiFrames = async () => { viewer.albumViewerAiCancel(); throw new Error('abort'); };
await viewer.albumViewerAiStart();
assert.equal(viewer.albumViewer.ai.done, 0);
assert.deepEqual(viewer.albumViewer.ai.results, {});
console.log('Discovery album AI passed');
