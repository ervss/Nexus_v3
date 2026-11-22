import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('app/static/main.js', 'utf8');
const start = source.indexOf('        discoveryHubShow() {');
const end = source.indexOf('        discoveryHubProviderLabel(provider)', start);
const calls = [];
const fetchProxy = async url => {
    calls.push(new URL(url, 'http://localhost'));
    return { json: async () => ({ results: [{url:'https://bunkr.cr/a/newest'}], has_more: true }) };
};
const methods = vm.runInNewContext(`({${source.slice(start, end)}})`, {
    URLSearchParams, console, AbortController,
    localStorage: { setItem() {} },
    window: {},
    fetch: async url => {
        calls.push(new URL(url, 'http://localhost'));
        return { json: async () => ({ results: [{url:'https://bunkr.cr/a/newest'}], has_more: true }) };
    },
});

for (const mode of ['latest', 'search', 'files']) {
    const state = {
        ...methods, discoveryHubRememberSearch() {}, discoveryHubFetch: async url => { const response = await fetchProxy(url); return response.json(); },
        discoveryHubBindImports: items => items, discoveryHubEnrichVisible() {}, discoveryHubRestoreImports() {}, discoveryHubLoading: false, discoveryHubQuery: '   ',
        discoveryHubMode: mode, discoveryHubFilters: {sort:'latest'},
        discoveryHubSources: {balbums:false, bunkrr:true, explorer:true},
        discoveryHubEnrichItems: async items => items,
        discoveryHubAutoFillIfFiltered() {},
    };
    await state.discoveryHubSearch();
    assert.equal(calls.length, 0, 'blank input must not start discovery');

}

const keywordState = {
    ...methods, discoveryHubRememberSearch() {}, discoveryHubFetch: async url => { const response = await fetchProxy(url); return response.json(); },
    discoveryHubItemKey: item => item.url,
        discoveryHubBindImports: items => items, discoveryHubEnrichVisible() {}, discoveryHubRestoreImports() {}, discoveryHubLoading:false, discoveryHubQuery:'studio',
    discoveryHubMode:'search', discoveryHubFilters:{sort:'latest'},
    discoveryHubSources:{balbums:true,bunkrr:true,explorer:false},
    discoveryHubEnrichItems:async items=>items, discoveryHubAutoFillIfFiltered() {},
};
await keywordState.discoveryHubSearch();
assert.equal(calls.at(-1).searchParams.get('query'), 'studio');
assert.equal(calls.at(-1).searchParams.get('include_bunkrr'), '0');
assert.equal(calls.at(-1).searchParams.get('include_balbums'), '1');
assert.equal(keywordState.discoveryHubFilters.sort, 'relevance');
assert.equal(keywordState.discoveryHubMode, 'search');

keywordState.discoveryHubMode = 'latest';
keywordState.discoveryHubQuery = 'BBC';
await keywordState.discoveryHubSearch();
assert.equal(calls.at(-1).searchParams.get('query'), 'BBC');
assert.equal(calls.at(-1).searchParams.get('mode'), 'search');
assert.equal(calls.at(-1).searchParams.get('include_bunkrr'), '0');
assert.equal(keywordState.discoveryHubQuery, 'BBC');

keywordState.discoveryHubMode = 'files';
await keywordState.discoveryHubSearch();
assert.equal(calls.at(-1).searchParams.get('mode'), 'files');
assert.equal(calls.at(-1).searchParams.get('include_bunkrr'), '1');

let openedSearch = 0;
const opened = {
    ...methods, discoveryHubRememberSearch() {}, discoveryHubRestoreImports() {}, discoveryHubResults:[], discoveryHubLoading:false,
    discoveryHubQuery:'old', discoveryHubMode:'trending',
    discoveryHubResetFilters() {}, discoveryHubSearch() {openedSearch++;},
};
opened.discoveryHubShow();
assert.equal(opened.discoveryHubOpen, true);
assert.equal(opened.discoveryHubMode, 'trending');
assert.equal(opened.discoveryHubQuery, 'old');
assert.equal(openedSearch, 0);
console.log('Discovery Hub empty search, source selection, and opening checks passed.');
