import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('app/static/main.js', 'utf8');
const start = source.indexOf('        discoveryHubShow() {');
const bulk = source.indexOf('        async _dhubBulkImport(items)', start);
const end = source.indexOf('\n        },', bulk) + '\n        },'.length;
let request;
const storage = new Map();
const methods = vm.runInNewContext(`({${source.slice(start, end)}})`, {
    URLSearchParams, AbortController, console: {error(){},warn(){}},
    setTimeout, clearTimeout, window: {},
    localStorage: {getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
    fetch: (...args)=>request(...args),
});
const response = (data, ok=true) => ({ok, status:ok?200:503, json:async()=>data});
const tick = () => new Promise(resolve=>setImmediate(resolve));
function state() {return {...methods, discoveryHubRememberSearch() {},discoveryHubLoading:false,discoveryHubQuery:'first',
    discoveryHubMode:'search',discoveryHubPage:1,discoveryHubFilters:{sort:'relevance'},
    discoveryHubSources:{balbums:true,bunkrr:false,explorer:false},discoveryHubResults:[],
    discoveryHubImportJobs:{},dhubImportProgress:{active:false},discoveryHubSelected:new Set(),discoveryHubLocked:new Set(),
    discoveryHubAutoFillIfFiltered(){},discoveryHubEnrichVisible(){}};}
// HTTP errors remain errors; failed pagination retries the same page.
{
    const s=state();s.discoveryHubResults=[{url:'existing'}]; const pages=[];
    request=async url=>{pages.push(new URL(url,'http://local').searchParams.get('page'));return response({detail:'offline'},false);};
    await s.discoveryHubLoadMore();await s.discoveryHubLoadMore();
    assert.deepEqual(pages,['2','2']);assert.equal(s.discoveryHubPage,1);
    assert.equal(s.discoveryHubResults.length,1);assert.equal(s.discoveryHubError,'offline');
}
// A late reply cannot replace the newer query even if transport ignores abort.
{
    const s=state();let oldResolve;
    request=async url=>new URL(url,'http://local').searchParams.get('query')==='first'
        ? new Promise(r=>oldResolve=r) : response({results:[{url:'new'}],has_more:false});
    const pending=s.discoveryHubSearch();await tick();s.discoveryHubQuery='second';
    await s.discoveryHubSearch();oldResolve(response({results:[{url:'old'}]}));await pending;
    assert.equal(s.discoveryHubResults[0].url,'new');assert.equal(s.discoveryHubLoading,false);
}
// Keyword exclusions are reversible even when already set before loading.
{
    const s=state(); s.discoveryHubFilters.excludeKeyword='trans, stream';
    request=async()=>response({results:[{url:'a',title:'Trans collection'}, {url:'b',title:'streamss'}, {url:'c',title:'Keep'}],has_more:false});
    await s.discoveryHubSearch();
    assert.deepEqual(Array.from(s.discoveryHubResults,x=>x.url),['a','b','c']);
    assert.deepEqual(Array.from(s.discoveryHubVisibleResults(),x=>x.url),['c']);
    s.discoveryHubFilters.excludeKeyword='';
    assert.deepEqual(Array.from(s.discoveryHubVisibleResults(),x=>x.url),['a','b','c']);
}

{
    const s=state();s.discoveryHubEnrichVisible=methods.discoveryHubEnrichVisible;
    let metadataResolve;
    request=async url=>url.includes('/enrich') ? new Promise(r=>metadataResolve=r)
        : response({results:[{url:'a',type:'album'},{url:'b',type:'album'}],has_more:false});
    await s.discoveryHubSearch();await tick();
    assert.equal(s.discoveryHubLoading,false);assert.equal(s.discoveryHubEnriching,true);
    assert.equal(s.discoveryHubResults.length,2);
    metadataResolve(response({results:[{url:'b',file_count:2,thumbnail:'thumb'},{url:'a',file_count:1,thumbnail:'thumb'}]}));
    await tick();assert.deepEqual(Array.from(s.discoveryHubResults,x=>x.url),['a','b']);
    assert.equal(s.discoveryHubEnriching,false);
}
// Acceptance is queued, not imported. Completion and failure follow the job ID.
{
    const s=state(); const item={url:'https://bunkr.cr/f/sample'};s.discoveryHubResults=[item];
    s.discoveryHubPollImports=()=>{};
    request=async()=>response({job:{id:91,status:'queued'}});
    await s.discoveryHubImport(item);assert.equal(item._imported,false);assert.equal(item._importing,true);
    assert.equal(s.discoveryHubImportLabel(item),'Vo fronte');
    s.discoveryHubPollImports=methods.discoveryHubPollImports;
    request=async()=>response({job:{id:91,status:'completed',imported_items:1,duplicate_items:0,failed_items:0}});
    await s.discoveryHubPollImports();assert.equal(s.discoveryHubResults[0]._imported,true);
    s.discoveryHubImportJobs[item.url].status='running';
    request=async()=>response({job:{id:91,status:'completed_with_errors',imported_items:0,duplicate_items:0,failed_items:1}});
    await s.discoveryHubPollImports();assert.equal(s.discoveryHubResults[0]._imported,false);
    const retry=s.discoveryHubResults[0];retry._importing=false;
    s.discoveryHubPollImports=()=>{};let endpoint;
    request=async url=>{endpoint=url;return response({job:{id:91,status:'queued'}});};
    await s.discoveryHubImport(retry);assert.equal(endpoint,'/api/v1/intake/jobs/91/retry');
}
// Continuation retains Findr's cursor/provider even if the primary recovers.
{
    const s=state();const urls=[];
    request=async url=>{urls.push(new URL(url,'http://local'));return response({
        results:[{url:urls.length===1?'page-one':'page-two'}],has_more:true,
        pagination_provider:'findr_api',fallback:true,message:'Náhradný index Findr',next_cursor:'stable-cursor',
    });};
    await s.discoveryHubSearch();await s.discoveryHubLoadMore();
    assert.equal(s.discoveryHubWarning,'Náhradný index Findr');
    assert.equal(urls[1].searchParams.get('provider'),'findr_api');
    assert.equal(urls[1].searchParams.get('cursor'),'stable-cursor');
    assert.equal(urls[1].searchParams.get('page'),'2');
}
console.log('Discovery Hub: error, page retry, stale replies, progressive metadata, import completion and retry passed.');

// Opening and category switches are passive, even with a populated query.
{
    const s=state(); let searched=0;
    s.discoveryHubRestoreImports=()=>{};
    s.discoveryHubSearch=()=>{searched++;};
    s.discoveryHubShow();
    assert.equal(searched,0);
    for (const mode of ['trending','latest','search','files']) {
        s.discoveryHubSetMode(mode);
        assert.equal(s.discoveryHubMode,mode);
        assert.equal(s.discoveryHubQuery,'first');
        assert.equal(s.discoveryHubResults.length,0);
        assert.equal(s.discoveryHubLoading,false);
    }
    assert.equal(searched,0);
    const template=fs.readFileSync('app/templates/index.html','utf8');
    const tabs=template.slice(template.indexOf('class="dhub-mode-tab"'),template.indexOf('class="dhub-sources-info"'));
    assert.ok(!tabs.includes('discoveryHubSearch('));
}

// Large indexed file listings must not trigger a second crawl of every file.
{
    const s=state(); s.discoveryHubEnrichVisible=methods.discoveryHubEnrichVisible;
    s.discoveryHubResults=[{url:'album',type:'album',thumbnail:'preview.jpg',file_count:0,size_bytes:0}];
    let options;
    s.discoveryHubEnrichItems=async (items, opts)=>{options=opts; return items.map(item=>({...item,file_count:12,total_size_bytes:104857600}));};
    await s.discoveryHubEnrichVisible();
    assert.equal(options.basicAlbumStats,true);
    assert.equal(s.discoveryHubResults[0].file_count,12);
    assert.equal(s.discoveryHubResults[0]._enriched,false);
}

{
    const s=state();s.discoveryHubEnrichVisible=methods.discoveryHubEnrichVisible;
    s.discoveryHubResults=Array.from({length:988},(_,i)=>({url:`file-${i}`,type:'video',thumbnail:'preview.jpg'}));
    let requests=0;
    s.discoveryHubEnrichItems=async items=>{requests++;return items;};
    await s.discoveryHubEnrichVisible();
    assert.equal(requests,0);
    assert.equal(s.discoveryHubResults.length,988);
    assert.equal(s.discoveryHubEnrichTotal,0);
    s.discoveryHubResults.forEach(item=>{item.thumbnail='';});
    s.discoveryHubMergeEnriched=()=>{};
    await s.discoveryHubEnrichVisible();
    assert.equal(requests,3);
    assert.equal(s.discoveryHubEnrichTotal,24);
}

// Content filters must exclude archives, documents, audio and unknown files.
{
    const s=state(); s._dhubSeq=1; s._dhubAbort=new AbortController();
    s.discoveryHubEnrichVisible=methods.discoveryHubEnrichVisible;
    s.discoveryHubResults=[{url:'keep',title:'Keep',type:'album'}, {url:'drop',title:'Drop',type:'album'}];
    s.discoveryHubFilters={excludeKeyword:'drop'};
    let finishOld; const batches=[];
    s.discoveryHubEnrichItems=(items)=>{
        batches.push(items.map(item=>item.url));
        return batches.length===1 ? new Promise(resolve=>{finishOld=resolve;}) : Promise.resolve(items);
    };
    const pending=s.discoveryHubEnrichVisible(); await tick();
    const oldSignal=s._dhubAbort.signal;
    s.discoveryHubHideNonMatching(); await tick();
    assert.equal(oldSignal.aborted,true);
    assert.deepEqual(batches,[['keep','drop'],['keep']]);
    finishOld([{url:'drop',type:'album',file_count:5}]); await pending;
    assert.deepEqual(Array.from(s.discoveryHubResults,item=>item.url),['keep']);
}

{
    const s=state();
    s.discoveryHubResults=[{url:'a',title:'Trans Collection'}, {url:'b',title:'Holiday Collection'}, {url:'c',title:'Other'}];
    s.discoveryHubFilters={keyword:'COLLECTION',excludeKeyword:'trans'};
    assert.deepEqual(Array.from(s.discoveryHubVisibleResults(),x=>x.url),['b']);
    s.discoveryHubSelected=new Set(['a','b']);
    s.discoveryHubHideNonMatching();
    s.discoveryHubResetFilters();
    assert.equal(s.discoveryHubFilters.excludeKeyword, '');
    assert.deepEqual(Array.from(s.discoveryHubVisibleResults(),x=>x.url),['b']);
    assert.equal(s.discoveryHubSelected.size,0);
    assert.deepEqual(Array.from(s.discoveryHubResults,x=>x.url),['b']);
    s.discoveryHubResults.push({url:'c',title:'Other'});
    s.discoveryHubResults.push({url:'d',title:'Streamss Collection'}, {url:'e',title:'DILDO Collection'});
    s.discoveryHubFilters.excludeKeyword=' trans, stream, dildo, ';
    assert.deepEqual(Array.from(s.discoveryHubVisibleResults(),x=>x.url),['b','c']);
}

// The same album stays excluded across pages and provider fallback; identical titles alone are not enough.
{
    const s=state();
    s.discoveryHubMode='files';
    const file=(url, album_id, title, provider='findr_api_search') =>
        ({url, album_id, title, provider, type:'video', album_title:'Letné rozhovory'});
    const first=file('a',7,'Rozhovor 1080p');
    request=async url=>{
        const page=new URL(url,'http://local').searchParams.get('page');
        return response(page==='1' ? {results:[first,file('b',8,'Rozhovor 1080p')],has_more:true} : {
            results:[file('c','7','Bonus 1080p','bunkrr_file_payload'),file('d',null,'Krátka ukážka 1080p')],
            has_more:false,
        });
    };
    await s.discoveryHubSearch();
    s.discoveryHubExcludeAlbum(first);
    await s.discoveryHubLoadMore();
    assert.deepEqual(Array.from(s.discoveryHubVisibleResults(),x=>x.url),['b','d']);
    s.discoveryHubFilters.keyword='letne, 1080P';
    s.discoveryHubFilters.excludeKeyword='trailer, ukazka';
    let imported;
    s._dhubBulkImport=async items=>{imported=Array.from(items,x=>x.url);};
    await s.discoveryHubImportAll();
    assert.deepEqual(imported,['b']);
    s.discoveryHubRestoreAlbum(s.discoveryHubAlbumKey(first));
    assert.deepEqual(Array.from(s.discoveryHubVisibleResults(),x=>x.url),['a','b','c']);
}

{
    const s=state();
    s.discoveryHubFilters={content:'video'};
    s.discoveryHubResults=['clip.mp4','Bimbo.rar','Bimbo-Ex-Machina_01.pdf','mix.mp3','photo.jpg','unknown'].map(title=>({title,url:`https://example.test/${title}`,type:'file'}));
    s.discoveryHubResults.push({title:'Friendly title',type:'file',url:'https://example.test/clip.webm?download=1'});
    assert.deepEqual(Array.from(s.discoveryHubVisibleResults(),x=>x.title),['clip.mp4','Friendly title']);
    s.discoveryHubFilters.content='image';
    assert.deepEqual(Array.from(s.discoveryHubVisibleResults(),x=>x.title),['photo.jpg']);
    s.discoveryHubFilters.content='all';
    assert.equal(s.discoveryHubVisibleResults().length,7);
}

{
    const s=state();s.discoveryHubMode='files';s.discoveryHubProvider='findr_api';
    s.discoveryHubSummary={files_total:3076};s.discoveryHubHasMore=true;
    s.discoveryHubResults=Array.from({length:768},(_,i)=>({url:String(i)}));
    s.discoveryHubVisibleResults=()=>s.discoveryHubResults;
    assert.equal(s.discoveryHubLoadedLabel(),'Načítané 768 z 3,076 celkovo · zostáva približne 2,308');
    s.discoveryHubHasMore=false;
    assert.ok(s.discoveryHubLoadedLabel().endsWith('všetky stránky načítané'));
}

// Loading all pages includes later matches and stops cleanly on errors/cancel.
{
    const s=state();s.discoveryHubHasMore=true;s.discoveryHubPage=1;
    let pages=[];
    s.discoveryHubSearch=async()=>{pages.push(++s.discoveryHubPage);if(s.discoveryHubPage===4)s.discoveryHubHasMore=false;};
    await s.discoveryHubLoadAll();
    assert.deepEqual(pages,[2,3,4]);assert.equal(s.discoveryHubLoadingAll,false);
    s.discoveryHubHasMore=true;s.discoveryHubError='';
    s.discoveryHubSearch=async()=>{s.discoveryHubError='offline';};
    await s.discoveryHubLoadAll();assert.equal(s.discoveryHubLoadingAll,false);
    s.discoveryHubError='';
    s.discoveryHubSearch=async()=>{s.discoveryHubPage++;s.discoveryHubStopLoadAll();};
    await s.discoveryHubLoadAll();assert.equal(s.discoveryHubLoadingAll,false);
}

// Expanding the date window restores older cards; duplicate keys render once.
{
 const s=state();s.discoveryHubFilters={date:'30d'};
 s.discoveryHubResults=[{url:'new',created_at:new Date().toISOString()},
 {url:'old',created_at:'2020-01-01'}, {url:'old',created_at:'2020-01-01'}];
 assert.equal(s.discoveryHubVisibleResults().length,1);
 s.discoveryHubFilters.date='all';
 assert.equal(s.discoveryHubVisibleResults().length,2);
 s.discoveryHubSelected=new Set(['new']);
 s.discoveryHubFiltersChanged();
 assert.equal(s.discoveryHubSelected.size,0);
}
