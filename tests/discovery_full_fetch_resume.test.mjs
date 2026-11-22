import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('app/static/main.js', 'utf8');
const missing = source.slice(source.indexOf('        albumViewerIsMissingMeta(i) {'), source.indexOf('        async _avFetchJob('));
const start = source.indexOf('        async albumViewerRefetchMeta(');
const end = source.indexOf('        albumViewer', start + 20);
const requests = [];
globalThis.window = {NexusFetchJobs: {
    async start(payload) { requests.push(payload); return 'job'; },
    async watch(id, callback) {
        callback({type:'patch', url:'missing', data:{duration:30, height:720, enriched:true}});
        return {state:'completed', counts:{'file:succeeded':1, 'file:failed':0}};
    },
}};
const methods = new Function(`return ({${missing}${source.slice(start, end)}})`)();
const messages = [];
const viewer = Object.assign({
    _avSeq: 1,
    albumViewer: {items:[
        {url:'complete',type:'video',duration:60,height:1080},
        {url:'missing',type:'video',duration:0,height:0},
        {url:'unsupported',type:'video',metadata_state:'unsupported'},
    ], selected:new Set()},
    _avApplyEvent(ev) { Object.assign(this.albumViewer.items.find(item=>item.url===ev.url), ev.data); },
    combinedHistoryRemember() {}, showToast(message) {messages.push(message);},
}, methods);
await viewer.albumViewerRefetchMeta('all');
assert.deepEqual(requests.map(request=>request.urls), [['missing']]);
await viewer.albumViewerRefetchMeta('all');
assert.equal(requests.length, 1, 'a second Full fetch creates no job for completed videos');
assert.match(messages.at(-1), /už majú načítané meta/);
