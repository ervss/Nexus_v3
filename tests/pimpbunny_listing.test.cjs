const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = { window: {}, URL };
vm.runInNewContext(fs.readFileSync('extensions/nexus-video-selector/pimpbunny-listing.js', 'utf8'), context);
const api = context.window.NVSPimpBunnyListing;
const base = 'https://pimpbunny.com/videos/';
const link = (href, arrow = false, parameters = '') => ({ getAttribute: name => name === 'href' ? href : name === 'data-parameters' ? parameters : null, querySelector: () => arrow ? {} : null });
const pager = (links, page = null, id = '') => ({ id, querySelectorAll: () => links, querySelector: () => page === null ? null : { textContent:String(page) } });
const pagination = links => ({ querySelectorAll: () => [pager(links)] });

test('FNXTube keeps its own watch identity and follows native video pages', () => {
  const fnx = 'https://fnxtube.com/videos/';
  assert.equal(api.watchUrl('/videos/example/?tracking=1', fnx), fnx + 'example/');
  assert.equal(api.watchUrl('https://www.fnxtube.com/videos/example/#player', fnx), fnx + 'example/');
  for (const url of ['/videos/2/', 'https://fnxtube.com.evil.test/videos/example/', '/get_file/0/preview.mp4']) {
    assert.equal(api.watchUrl(url, fnx), '');
  }
  assert.equal(api.nextUrl(pagination([link('/videos/2/')]), fnx + '?sort_by=rating'), fnx + '2/?sort_by=rating');
});

test('FNXTube accumulates both remaining pages, updates the native pager and stops at 67 cards', async () => {
  const source = fs.readFileSync('extensions/nexus-video-selector/content.js', 'utf8');
  const url = 'https://fnxtube.com/videos/';
  const fetched = [];
  let visiblePage = 1;
  const nodes = n => Array.from({length:n}, (_,i) => ({
    url:url + `clip-${i}/`, querySelectorAll:()=>[],
  }));
  const grid = { appendChild(fragment) { live.push(...fragment.nodes); } };
  const live = nodes(32);
  live.forEach(n => n.parentElement = grid);
  const pages = { 2: nodes(64).slice(32), 3: nodes(67).slice(64) };
  const livePager = { replaceWith(node) { visiblePage = node.page; } };
  const ctx = {
    state:{loadedExtraPages:new Set()}, location:{href:url,origin:'https://fnxtube.com'}, URL, AbortSignal,
    window:{NVSPimpBunnyListing:{
      cards(doc) { return (doc.page ? pages[doc.page] : live).map(card => ({card,url:card.url})); },
      nextUrl(doc) { const page = doc.page || visiblePage; return page < 3 ? url + (page+1) + '/' : ''; },
      pagination(doc) { return doc.page ? {page:doc.page,querySelectorAll:()=>[]} : livePager; },
    }},
    document:{
      createDocumentFragment() { return {nodes:[],appendChild(n){this.nodes.push(n);}}; },
      importNode(node) { return node; },
    },
    fetch:async next => { fetched.push(next); return {ok:true,url:next,text:async()=>next}; },
    DOMParser:class { parseFromString(html) { return {page:Number(html.match(/\/(\d+)\/$/)[1])}; } },
    scan(){}, requestAnimationFrame:callback=>callback(),
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  async function loadPimpBunnyPages('),source.indexOf('  function isXHamsterListingPage(')),ctx);
  assert.equal(await ctx.loadPimpBunnyPages(1,()=>false),1);
  assert.equal(live.length,64); assert.equal(visiblePage,2);
  assert.equal(await ctx.loadPimpBunnyPages(1,()=>false),1);
  assert.equal(live.length,67); assert.equal(visiblePage,3);
  assert.equal(await ctx.loadPimpBunnyPages(1,()=>false),0);
  assert.deepEqual(fetched,[url+'2/',url+'3/']);
});

test('watch identity removes tracking and excludes numeric pages, external links and previews', () => {
  assert.equal(api.watchUrl('/videos/example-clip/?utm_source=test#player', base), base + 'example-clip/');
  for (const url of ['/videos/2/', '/videos/', 'https://evil.test/videos/a/', '/get_file/49/preview.mp4', '/categories/4k/', '/onlyfans-creators/model/']) assert.equal(api.watchUrl(url, base), '');
});

test('listing pagination advances one page and preserves native filters', () => {
  const doc = pagination([link('/videos/1/', true), link('/videos/3/'), link('/videos/3033/'), link('/videos/3/', true)]);
  assert.equal(api.nextUrl(doc, base + '2/?sort_by=rating&duration_from=10'), base + '3/?sort_by=rating&duration_from=10');
  assert.equal(api.nextUrl(pagination([link('/videos/3032/', true), link('/videos/1/')]), base + '3033/'), '');
});

test('search uses from_videos rather than invented path pagination', () => {
  const url = 'https://pimpbunny.com/search/model/?sort_by=post_date';
  const next = new URL(api.nextUrl(pagination([link('?from_videos=2', true)]), url));
  assert.equal(next.pathname,'/search/model/');
  assert.equal(next.searchParams.get('from_videos'),'2');
  assert.equal(next.searchParams.get('sort_by'),'post_date');
  assert.equal(api.nextUrl({ querySelectorAll: () => [] }, url), '');
});

test('real search AJAX links advance videos and preserve query, filters and page size', () => {
  const parameters = 'from_videos:2;ipp:30;page_type:;items_per_page:30;videos_per_page:30';
  const videoPager = pager([link('#',false,parameters),link('#',true,parameters)],1,'list_videos_videos_list_search_result_pagination');
  const albumPager = pager([link('#',true,'from_albums:2;ipp:4')],1,'list_albums_albums_list_search_result_pagination');
  const doc = { querySelectorAll: () => [albumPager,videoPager] };
  const next = new URL(api.nextUrl(doc,'https://pimpbunny.com/search/?q=sample&sort_by=rating&duration_from=10#results'));
  assert.equal(next.pathname,'/search/');
  assert.equal(next.searchParams.get('from_videos'),'2');
  assert.equal(next.searchParams.get('q'),'sample');
  assert.equal(next.searchParams.get('sort_by'),'rating');
  assert.equal(next.searchParams.get('duration_from'),'10');
  for (const key of ['ipp','items_per_page','videos_per_page']) assert.equal(next.searchParams.get(key),'30');
  assert.equal(next.hash,'');
  assert.equal(next.searchParams.has('from_albums'),false);
  assert.equal(next.searchParams.has('mode'),false);
  assert.equal(api.nextUrl({querySelectorAll:()=>[albumPager]},next.href),'');
});

test('visible AJAX page takes precedence over a stale address and reaches the last page', () => {
  const doc = page => ({querySelectorAll:()=>[pager([
    link('#',true,`from_videos:${page-1};ipp:30`),
    ...(page < 200 ? [link('#',true,`from_videos:${page+1};ipp:30`)] : []),
  ],page,'list_videos_videos_list_search_result_pagination')]});
  const url='https://pimpbunny.com/search/sample/';
  assert.equal(new URL(api.nextUrl(doc(2),url)).searchParams.get('from_videos'),'3');
  assert.equal(new URL(api.nextUrl(doc(199),url+'?from_videos=199')).searchParams.get('from_videos'),'200');
  assert.equal(api.nextUrl(doc(200),url+'?from_videos=200'),'');
});

test('listing cards use stable class prefixes and deduplicate canonical watch URLs', () => {
  const first = { id: 'first', classList: { contains: name => name === 'col' } };
  const root = (href, card) => ({ parentElement:card, querySelector: () => link(href) });
  const doc = { querySelectorAll: () => [root('/videos/sample/?a=1',first),root('/videos/sample/#player',{}),root('/videos/2/',{})] };
  const rows = api.cards(doc,base);
  assert.equal(rows.length,1); assert.equal(rows[0].card,first); assert.equal(rows[0].url,base+'sample/');
});

test('PimpBunny import carries page metadata once and excludes signed preview streams', () => {
  const source = fs.readFileSync('extensions/nexus-video-selector/content.js','utf8');
  const a = { dataset:{}, querySelector: () => ({ textContent:'13:294K' }) }, b = {dataset:{},querySelector: () => null};
  const url = base + 'sample/';
  const ctx = {
    state:{selected:new Set([a,b]),cardMeta:new WeakMap(),fetchCache:new Map([[url,{streamUrl:'https://st1.pimpbunny.com/preview.mp4',quality:'1440P',date:'2026-10-09',sizeMb:500}]]),pimpbunnyTagLoader:{get:()=>({tags:['landscape','outdoor'],fetched:true})}},
    document:{contains:()=>true},CFG:{durationSelectors:[]},Date,
    isXHamsterPage:()=>false,isXVideosPage:()=>false,isSxyprnPage:()=>false,isSpankBangPage:()=>false,getVideoUrlFromCard:()=>url,getCardTitle:()=> 'Sample',getCardThumbnail:()=> 'https://example.test/thumb.jpg',
    extractCardMeta:()=>({duration:'13:29',quality:'4K'}),parseSizeMb:()=>null,window:{},
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  function getSelectedItems('),source.indexOf('  async function doImport(')),ctx);
  const items = ctx.getSelectedItems();
  assert.equal(items.length,1);assert.equal(items[0].url,url);assert.equal(items[0].streamUrl,null);
  assert.equal(items[0].duration,'13:29');assert.equal(items[0].quality,'1440P');assert.equal(items[0].date,'2026-10-09');assert.equal(items[0].file_size_mb,500);
  assert.equal(JSON.stringify(items[0].tags),JSON.stringify(['landscape','outdoor']));
});
