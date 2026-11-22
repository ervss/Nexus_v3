const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('extensions/Nexus_Gallery/eporner_grid_importer.js', 'utf8');
function extract(start, end) { return source.slice(source.indexOf(start), source.indexOf(end)); }
const origin = 'https://www.eporner.com';
const location = { origin, href: `${origin}/pornstar/name/recent/`, pathname: '/pornstar/name/recent/' };
const paginationCode = extract('    function normalizePageUrl(', '    function syncPaginationFromDocument(');
function link(href, text, title = '') { return { href, textContent: text, getAttribute: k => ({ href, title }[k] || '') }; }
const links = [link('/pornstar/name/recent/', '1'), link('/pornstar/name/2/recent/', '2'), link('/pornstar/name/5/recent/', '5'), link('/pornstar/name/2/recent/', 'NEXT', 'Next page')];
const doc = { querySelectorAll: selector => { assert.match(selector, /numlist2/); return [{ closest: () => null, querySelectorAll: () => links }]; } };
const ctx = { URL, location, doc };
vm.runInNewContext(`${paginationCode}\nresult = findPagination(doc, location.href); page = pageNumberFromUrl('/pornstar/name/4/recent/');`, ctx);
assert.equal(ctx.result.nextUrl, `${origin}/pornstar/name/2/recent/`);
assert.equal(ctx.result.maxPage, 5);
assert.equal(ctx.page, 4);
const empty = { querySelectorAll: () => [] };
ctx.doc = empty;
vm.runInNewContext('result = findPagination(doc, location.href)', ctx);
assert.equal(ctx.result.nextUrl, '', 'ordinary video titles cannot become pagination links');

const layoutCode = extract('    function normalizeCardLayout()', '    function hideEmptyEpornerBlocks(');
const grid = { dataset: {}, parentElement: {}, contains: node => node === grid, appendChild: () => assert.fail('card already belongs to grid') };
const card = { parentElement: grid, contains: () => false, classList: { add() {} } };
const gridContext = { getCardNodes: () => [card], location, document: { getElementById: () => grid }, GRID_ID: 'grid', state: { gridColumns: 5 }, playlistVideoListing: () => null, applyFullBleedGridLayout() {}, hideEmptyEpornerBlocks() {}, mountWorkspace() {} };
vm.runInNewContext(`${layoutCode}\nnormalizeCardLayout(); normalizeCardLayout();`, gridContext);
console.log('Eporner layout and pagination regression: passed');
