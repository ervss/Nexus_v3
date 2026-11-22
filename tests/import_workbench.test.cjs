const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = { window: {}, Date };
vm.runInNewContext(fs.readFileSync('extensions/nexus-video-selector/import-workbench.js', 'utf8'), context);
const model = context.window.NVSWorkbenchModel;
const row = { title: 'Mountain sunrise', quality: 2160, duration: 600, size: 200, date: new Date('2026-10-09T12:00:00').getTime(), order: 1 };
test('combined keyword, multiple qualities, minute and MB ranges, inclusive date', () => {
  const f = { ...model.defaults(), keyword: 'SUNrise', qualities: ['2160','1080'], durationMin: '10', durationMax: '10', sizeMin: '200', sizeMax: '200', dateMin: '2026-10-09', dateMax: '2026-10-09' };
  assert.equal(model.matches(row, f), true);
  for (const changed of [{title:'Ocean'}, {quality:720}, {duration:599}, {size:201}, {date:new Date('2026-10-10T00:00:00').getTime()}]) assert.equal(model.matches({...row,...changed}, f), false);
});
test('unknown metadata can be included deliberately without bypassing keyword', () => {
  const f = { ...model.defaults(), keyword:'mountain', sizeMin:'100', qualities:['2160'] };
  assert.equal(model.matches({ ...row, quality:null, size:null },f),false);
  assert.equal(model.matches({ ...row, quality:null, size:null },{...f,unknown:true}),true);
  assert.equal(model.matches({ ...row, title:'Ocean', quality:null, size:null },{...f,unknown:true}),false);
});
test('reversed ranges never match even when unknown values are allowed', () => {
  for (const key of ['size','duration','date']) {
    const f = {...model.defaults(),unknown:true,[key+'Min']:key==='date'?'2026-10-09':'20',[key+'Max']:key==='date'?'2026-10-01':'10'};
    assert.equal(model.matches({...row,[key]:null},f),false);
  }
});
test('card order changes only from the sort control, not from a refresh', () => {
  const workbench = fs.readFileSync('extensions/nexus-video-selector/import-workbench.js', 'utf8');
  const refresh = workbench.slice(workbench.indexOf('function refresh()'), workbench.indexOf('return { mount'));
  assert.equal(refresh.includes('api.sort'), false);
  assert.match(workbench, /data-action="sort"/);
  assert.match(workbench, /el\.dataset\.filter === 'sort' \|\| el\.dataset\.filter === 'direction'/);
});
test('unknown values sort last in both directions and ties keep original order', () => {
  for (const direction of ['asc','desc']) {
    const f = { ...model.defaults(), sort:'size', direction };
    assert.equal(model.compare({...row,size:null},{...row,size:1},f)>0,true);
    assert.equal(model.compare({...row,order:1},{...row,order:2},f)<0,true);
  }
  assert.equal(model.compare({title:'Clip 2',order:1},{title:'Clip 10',order:2},{...model.defaults(),sort:'title'})<0,true);
});

const source = fs.readFileSync('extensions/nexus-video-selector/content.js', 'utf8');
test('both site workbench startup paths mount playback controls and start the player', () => {
  for (const site of ['pimpbunny', 'fnxtube', 'xhamster']) {
    const pimpbunny = site !== 'xhamster';
    const calls = [];
    const body = { prepend(node) { calls.push(['controls', node]); } };
    const panel = { querySelector() { return body; } };
    const ctx = {
      window: {
        createNVSImportWorkbench(options) { calls.push(['site', options.site]); return { mount() { calls.push(['mount']); } }; },
        NVSMultiSitePlayer: { start(node) { calls.push(['player', node]); } },
      },
      document: { getElementById() { return panel; }, createElement() { return { dataset: {} }; } },
      location: { hostname: site + '.com' },
      isPimpBunnyPage() { return pimpbunny; }, isEromeAlbumListing() { return false; }, isXVideosPage() { return false; }, isSpankBangPage() { return false; },
      ensureGenericListingPlayer() {}, updateImportBar() {}, doDeselectAll() {}, doCopyUrls() {}, publicScanStatus() {},
    };
    vm.runInNewContext(source.slice(source.indexOf('  function createSiteImportWorkbench()'), source.indexOf('  const turboOverview')), ctx);
    ctx.createSiteImportWorkbench();
    assert.deepEqual(calls.map(call => call[0]), ['site', 'mount', 'controls', 'player']);
    assert.equal(calls[0][1], site);
    assert.equal(calls[2][1], calls[3][1]);
    assert.equal(calls[3][1].dataset.nvsPlaybackControls, '1');
  }
});

test('card selection capture leaves the play button alone but still selects thumbnail clicks', () => {
  let capture, selected = 0;
  const preview = { classList: { add() {} }, contains() { return true; } };
  const card = { dataset: {}, querySelector() { return null; }, appendChild() {}, addEventListener(type, listener, useCapture) { if (useCapture) capture = listener; } };
  const ctx = {
    document: { createElement() { return { appendChild() {}, setAttribute() {}, addEventListener() {} }; } },
    getCardTitle() { return 'Example'; }, getThumbnailSelectorHost() { return preview; }, toggleCard() { selected++; },
  };
  vm.runInNewContext(source.slice(source.indexOf('  function injectSelector(card)'), source.indexOf('  /**', source.indexOf('  function injectSelector(card)'))), ctx);
  ctx.injectSelector(card);
  const event = (play) => ({ button: 0, target: { closest(selector) { return play && selector.includes('.nvs-wh-play') ? {} : null; } }, preventDefault() {}, stopPropagation() {} });
  capture(event(true)); assert.equal(selected, 0);
  capture(event(false)); assert.equal(selected, 1);
});

function importContext(response) {
  const selected = { dataset:{}, classList:{ remove(){} }, querySelector(){return {setAttribute(){}};} };
  const other = { dataset:{}, classList:{ remove(){} }, querySelector(){return {setAttribute(){}};} };
  const ctx = {
    state:{selected:new Set([selected])}, importInProgress:false, importWorkbench:{schedule(){},message(){}},
    turboOverview:null, document:{getElementById(){return {value:'Review batch'};}},
    getSelectedItems(cards){return [...cards].map(card=>({url:card===selected?'https://example.test/a':'https://example.test/b',sourceUrl:card===selected?'https://example.test/a':'https://example.test/b'}));},
    getVideoUrlFromCard(card){return card===selected?'https://example.test/a':'https://example.test/b';},
    isXHamsterPage(){return true;},isXVideosPage(){return false;},isGofilePage(){return false;},isInternetChicksPage(){return false;},isSxyprnPage(){return false;},isArchvePage(){return false;},
    removeFromSessionSelection(){},updateImportBar(){},showToast(){},showImportResult(text){ctx.result=text;},
    chrome:{runtime:{lastError:null,sendMessage(message,callback){ctx.sent=message;callback(response);}}},
  };
  vm.createContext(ctx);
  const importStart = source.indexOf('  async function doImport(');
  const importEnd = source.indexOf('  function doCopyUrls(', importStart);
  assert.ok(importStart >= 0 && importEnd > importStart, 'import handler section should be present');
  vm.runInContext(source.slice(source.indexOf('  function summarizeImport('), source.indexOf('  function showImportResult(')) + source.slice(importStart, importEnd),ctx);
  return {ctx,selected,other};
}
test('explicit all/filtered scope sends its snapshot without replacing selection; only acknowledged items clear', () => {
  const {ctx,selected,other} = importContext({success:true,data:{results:[{index:0,url:'https://example.test/b',status:'imported'}]}});
  ctx.doImport('8001',null,[other]);
  assert.equal(ctx.sent.items.length,1); assert.equal(ctx.sent.items[0].url,'https://example.test/b');
  assert.equal(ctx.sent.strictPort,true); assert.equal(ctx.sent.port,'8001'); assert.equal(ctx.sent.batchName,'Review batch');
  assert.equal(ctx.state.selected.has(selected),true);
});
test('failure and aggregate-only responses preserve selection', () => {
  for (const response of [{success:false,error:'offline'}, {success:true,data:{job_id:'queued-job'}}, {success:true,data:{results:[{index:0,url:'https://example.test/wrong',status:'imported'}]}}]) {
    const {ctx,selected} = importContext(response); ctx.doImport('8000'); assert.equal(ctx.state.selected.has(selected),true);
  }
});
test('import double-click guard prevents a second submission', () => {
  const {ctx} = importContext({success:false}); ctx.importInProgress=true; ctx.doImport('8000'); assert.equal(ctx.sent,undefined);
});
test('card import keeps page identity, de-duplicates cards and carries visible metadata', () => {
  const a = { querySelector(){return null;} }, b = {querySelector(){return null;}};
  const url = 'https://example.test/videos/clip';
  const ctx = {
    state:{selected:new Set([a,b]),cardMeta:new WeakMap(),fetchCache:new Map([[url,{streamUrl:'https://cdn.example.test/expiring.mp4'}]])},
    document:{contains(){return true;}},window:{},CFG:{durationSelectors:[]},
    isXHamsterPage(){return true;},isXVideosPage(){return false;},isSpankBangPage(){return false;},isSxyprnPage(){return false;},getVideoUrlFromCard(){return url;},extractCardMeta(){return {quality:'2160P',duration:'11:00',sizeMb:478,date:'2026-10-08'};},
    getCardTitle(){return 'Mountain sunrise';},getCardThumbnail(){return 'https://example.test/thumb.png';},parseSizeMb(){return 0;},Date,
  };
  vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('  function getSelectedItems('),source.indexOf('  async function doImport(')),ctx);
  const items = ctx.getSelectedItems();assert.equal(items.length,1);assert.equal(items[0].url,url);assert.equal(items[0].streamUrl,null);
  assert.equal(items[0].quality,'2160P');assert.equal(items[0].sizeMb,478);assert.equal(items[0].duration,'11:00');assert.equal(items[0].date,'2026-10-08');
});
test('background transports publication date and stays on the explicit port', async () => {
  const bg = fs.readFileSync('extensions/nexus-video-selector/background.js','utf8');
  const calls = [];
  const ctx = {chrome:{storage:{local:{get:async()=>({})}}},AbortSignal,fetch:async(url,options)=>{calls.push({url,options});return {ok:true,status:200,text:async()=>'{"results":[]}'};}};
  vm.createContext(ctx);vm.runInContext(bg.slice(bg.indexOf('async function importToNexus('),bg.indexOf('// ── Message handler',bg.indexOf('async function importToNexus('))),ctx);
  await ctx.importToNexus('8001',[{url:'https://example.test/video',date:'2026-10-08',quality:'2160P',file_size_mb:478}],'Review',true);
  assert.equal(calls.length,2);assert.equal(calls[1].url,'http://127.0.0.1:8001/api/v1/import/bulk');
  assert.equal(JSON.parse(calls[1].options.body).videos[0].upload_date,'2026-10-08');
});
