import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source = readFileSync(new URL('../app/static/search.js', import.meta.url), 'utf8');
test('catalog appends pages, preserves search criteria and filters exclusions instantly', async () => {
    const elements = {telegramExcludeInput: {value: ''}, telegramCatalogMore: {}, searchLimitTotal: {value: '1'}};
    const requests = [], saved = [];
    const document = {getElementById: id => elements[id] || null, addEventListener(){}};
    const context = vm.createContext({document, URL, AbortController, setTimeout, clearTimeout,
        fetch: async url => { requests.push(url); return {ok: true, json: async () => ({source:'fts5_local', has_more: requests.length === 1, videos: requests.length === 1 ? [{message_id:1, chat_id:1, title:'Clip', text:'#gay', duration:'1:00'}] : [{message_id:2, chat_id:1, title:'Clip two', duration:'1:00'}]})}; }
    });
    vm.runInContext(source + '\nthis.Search = QuantumSearch;', context);
    const s = Object.create(context.Search.prototype);
    Object.assign(s, {_searchRunId:0, selectedTelegramChatIds:new Set(['1']), selectedUrls:new Set(), activeFilters:{duration:0}, searchFilters:{quality:['all']}, activeSource:'all', activeSort:'relevance', searchMode:2, results:[], filteredResults:[]});
    Object.assign(s, {getTelegramLimit:()=>1, requestedQuality:()=>0, requestedMinSizeMb:()=>0, showLoading(){}, updateSelectionToolbar(){}, renderResults(){}, saveTelegramHistory:async function(){saved.push(JSON.parse(JSON.stringify({results:this.results, page:this._catalogPage})));}});
    await s.searchJoinedChannels('clip');
    assert.equal(s.results.length, 1);
    elements.telegramExcludeInput.value = 'GAY'; s.applyFilters();
    assert.equal(s.filteredResults.length, 0);
    await s.loadMoreTelegramCatalog();
    assert.equal(s.results.length, 2);
    assert.equal(s.filteredResults.length, 1);
    assert.match(requests[1], /offset=1/);
    assert.match(requests[1], /chat_ids=1/);
    assert.equal(saved[1].page.offset, 2);
    assert.equal(elements.telegramCatalogMore.hidden, true);
});

test('new videos ignores keywords, applies filters and keeps cursor when loading more', async () => {
    const elements = {telegramExcludeInput:{value:''}, telegramCatalogMore:{}, telegramCatalogSearchInfo:{}};
    const requests = [];
    const document = {getElementById:id=>elements[id] || null, addEventListener(){}};
    const context = vm.createContext({document, URL, AbortController, setTimeout, clearTimeout,
        fetch:async url=>{requests.push(url); return {ok:true, json:async()=>({new_only:true, has_more:requests.length===1,
            coverage:{complete_channels:0,total_channels:2,enabled:false}, videos:[{message_id:requests.length, chat_id:1, title:'clip', duration:'20:00', effective_res:2160, size_bytes:2000000000, date:'2026-01-01', _catalog_id:10-requests.length}]})};}});
    vm.runInContext(source + '\nthis.Search = QuantumSearch;', context);
    const s = Object.create(context.Search.prototype);
    Object.assign(s, {_searchRunId:0,selectedTelegramChatIds:new Set(['42']),selectedUrls:new Set(),activeFilters:{duration:999},searchFilters:{quality:['4k']}, activeSort:'date',searchMode:2,results:[],filteredResults:[]});
    Object.assign(s, {getTelegramLimit:()=>1,requestedQuality:()=>2160,requestedMinSizeMb:()=>1000,showLoading(){},updateSelectionToolbar(){},renderResults(){},saveTelegramHistory(){throw Error('new search must not restore stale history');}});
    await s.searchNewTelegramVideos();
    assert.equal(s.filteredResults.length, 1);
    assert.match(requests[0], /query=&/);
    assert.match(requests[0], /chat_ids=&new_only=true/);
    await s.loadMoreTelegramCatalog();
    assert.equal(s.filteredResults.length, 2);
    assert.match(requests[1], /before_date=2026-01-01&before_id=9/);
    assert.match(elements.telegramCatalogSearchInfo.textContent, /pozastavené/);
});
