import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const template = fs.readFileSync('app/templates/tester.html', 'utf8');
const start = template.indexOf('        function collectSelectedMetaTargets()');
const end = template.indexOf('        function updateSelectedResultsCount()', start);
const items = Array.from({length: 100}, (_, i) => ({url: `https://example.com/video/${i}`, title: i < 40 ? 'match' : 'other'}));
const parent = {url: 'https://example.com/album', data: {album_items: items}};
const children = items.slice(0,40).map(item => ({url: item.url, _albumChild: true, _albumParent: parent.url}));
let selected = [parent, ...children];
const context = {
 getSelectedResults: () => selected,
 searchFilter: {value: 'match'},
 albumItemsForResult: item => item.data?.album_items || [],
 albumItemMatchesQuery: (item, query) => item.title.includes(query),
 createAlbumChildResult: (_parent, item) => ({url: item.url}),
 passesFilters: () => true,
};
vm.createContext(context);
vm.runInContext(template.slice(start, end), context);
const targets = () => Array.from(context.collectSelectedMetaTargets());
assert.deepEqual(targets(), children.map(item => item.url));
selected = [parent, children[3]];
assert.deepEqual(targets(), [children[3].url]);
selected = [parent];
assert.equal(targets().length, 40);
context.searchFilter.value = '';
assert.equal(targets().length, 100);
selected = [children[0], children[0]];
assert.deepEqual(targets(), [children[0].url]);
assert.equal((template.match(/const urls = collectSelectedMetaTargets\(\);/g) || []).length, 2);
console.log('Selected metadata scope: 5 scenarios passed; both buttons use shared targets.');

const completenessStart = template.indexOf('        function missingMetaFields(');
const completenessEnd = template.indexOf('        async function runFetchMeta(', completenessStart);
vm.runInContext(template.slice(completenessStart, completenessEnd), context);
assert.deepEqual(Array.from(context.missingMetaFields({title: 'A title', duration: 120})), ['kvalita', 'veľkosť', 'dátum']);
assert.deepEqual(Array.from(context.missingMetaFields({duration: 120, quality: '1080p', size_bytes: 1024, upload_date: '2026-10-01'})), []);
assert.deepEqual(Array.from(context.missingMetaFields({duration: 120, quality: 'unknown', size_bytes: 0, upload_date: ''})), ['kvalita', 'veľkosť', 'dátum']);
console.log('Metadata completeness: complete, partial and unknown fields checked.');

// Execute the real button handler: selection must reach the metadata-only
// route, otherwise Eporner silently falls back to serial stream resolution.
const clickStart = template.indexOf("        fetchMetaBtn.addEventListener('click', () => {", completenessEnd);
const clickEnd = template.indexOf('        // Refetch only the selected cards', clickStart);
let click;
let fastCall;
context.fetchMetaBtn = {addEventListener: (_event, handler) => { click = handler; }};
context.runFetchMeta = (...args) => { fastCall = args; };
context.showToast = () => {};
vm.runInContext(template.slice(clickStart, clickEnd), context);
selected = [children[0], children[1]];
click();
assert.deepEqual(Array.from(fastCall[0]), [children[0].url, children[1].url]);
assert.equal(fastCall[2], true, 'Rychle meta must request metadata only');
fastCall = undefined;
selected = [];
click();
assert.equal(fastCall, undefined, 'Empty selection must not start a request');
console.log('Fast metadata button: selection and metadata-only routing passed.');
