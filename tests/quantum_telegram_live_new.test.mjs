import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {TextEncoder, TextDecoder} from 'node:util';

const source = readFileSync(new URL('../app/static/search.js', import.meta.url), 'utf8');
test('live pass renders streamed matches, preserves progress, and removes imported cards', async () => {
    const elements = {telegramCatalogMore:{}, telegramLiveNew:{}, telegramLiveNewStop:{}, telegramCatalogSearchInfo:{}, telegramNewFilterInfo:{}, telegramExcludeInput:{value:''},searchLimitTotal:{value:'100'}};
    const document = {getElementById:id=>elements[id] || null, addEventListener(){}};
    const events = [
        {status:'start',total:2,scan_per_chat:20,per_chat:5},
        {status:'progress',completed:1,total:2,errors:0,channel:'one',videos:[
            {chat_id:1,message_id:4,title:'matching',url:'one',quality:'1080p',effective_res:1080,duration:'12:00'},
            {chat_id:1,message_id:5,title:'short',url:'two',quality:'1080p',effective_res:1080,duration:'2:52'},
            {chat_id:1,message_id:6,title:'low quality',url:'three',quality:'720p',effective_res:720,duration:'15:00'}]},
        {status:'done',completed:2,total:2,errors:0,limited:false},
    ];
    const bytes = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
    let consumed = false;
    const context = vm.createContext({document,URL,AbortController,TextDecoder,setTimeout,clearTimeout,
        fetch:async()=>({ok:true,body:{getReader:()=>({read:async()=>consumed ? {done:true} : (consumed=true,{done:false,value:bytes})})}})});
    vm.runInContext(source + '\nthis.Search = QuantumSearch;', context);
    const s = Object.create(context.Search.prototype);
    Object.assign(s, {_searchRunId:0,selectedUrls:new Set(),activeFilters:{duration:600},searchFilters:{quality:['1080p']},results:[],filteredResults:[],searchMode:2});
    Object.assign(s, {getTelegramLimit:()=>50,requestedMinSizeMb:()=>0,renderResults(){},setActivity(){}});
    await s.searchLiveNewTelegramVideos();
    assert.equal(s.filteredResults.length,1);
    assert.equal(s.filteredResults[0].title,'matching');
    const allChoice = {value:'all',checked:false};
    const qualityChoice = {value:'1080p',checked:true,closest:()=>({querySelector:()=>allChoice,querySelectorAll:()=>[qualityChoice]})};
    elements['ms-btn-quality'] = {};
    s._lastQuery = 'old search';
    s.search = () => { throw Error('changing quality must not restart an earlier search'); };
    s.handleMSChange('quality',qualityChoice);
    assert.equal(s.filteredResults.length,1);
    s.selectedUrls.add('one'); s.selectedUrls.add('two'); s.applyFilters();
    assert.equal(s.getSelectedResults().length,1);
    assert.match(elements.telegramNewFilterInfo.textContent,/1 označených je skrytých/);
    s.setQuickQualityFilter('all'); s.setDurationFilter(0);
    assert.equal(s.filteredResults.length,3);
    assert.equal(s.getSelectedResults().length,2);
    s.setQuickQualityFilter('1080p'); s.setDurationFilter(600);
    assert.match(elements.telegramCatalogSearchInfo.textContent,/Hotovo · 2\/2/);
    assert.equal(elements.telegramLiveNewStop.hidden,true);
    s.removeLiveNewResults([s.results[0]]);
    assert.equal(s.results.length,2);
    assert.equal(s.filteredResults.length,0);
});
