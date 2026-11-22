const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('extensions/Nexus_Gallery/tubed69_grid_importer.js', 'utf8');
function fixture(fetch) {
  const state = {items:new Map(), fetchingTags:false};
  const nodes = Array.from({length:200}, (_,key)=>({key}));
  const ctx = vm.createContext({state, fetch, AbortController, nodes,
    setTimeout:(fn,ms)=>ms===20000 ? setTimeout(fn,ms) : setTimeout(fn,0), clearTimeout,
    getCardNodes:()=>nodes, extractCard:n=>({key:n.key,url:`https://69tubed.com/video/${n.key}/clip/`,tags:[],_tagsFetched:false}),
    decorateCard(){}, applyMatchDimming(){}, applyCardSort(){}, updateToolbar(){}, updateLoadMoreBtn(){}, renderTagChips(){}, toast(){},
    parseTagsFromDetail:()=>['pov'],
  });
  vm.runInContext(source.slice(source.indexOf('    function scanCards()'),source.indexOf('    // Dim cards')),ctx);
  vm.runInContext(source.slice(source.indexOf('    async function fetchTagsFor('),source.indexOf('    // How many loaded cards')),ctx);
  return {ctx,state};
}
test('one click retains all 200 tag results while periodic scans replace card metadata',async()=>{
  let scans=0,calls=0;
  let ctx;
  const f=fixture(async()=>{
    calls++;
    await new Promise(r=>setImmediate(r));
    vm.runInContext('scanCards()',ctx); scans++;
    return {ok:true,text:async()=>'<tags>'};
  });
  ctx=f.ctx;
  vm.runInContext('scanCards()',ctx);
  const original=f.state.items.get(0);
  await vm.runInContext('enrichTags([...state.items.values()])',ctx);
  assert.equal(scans,200); assert.equal(calls,200);
  assert.equal(f.state.items.get(0),original);
  assert.equal([...f.state.items.values()].filter(i=>i._tagsFetched).length,200);
  assert.ok([...f.state.items.values()].every(i=>i.tags[0]==='pov'));
  await vm.runInContext('enrichTags([...state.items.values()])',ctx);
  assert.equal(calls,200);
});
test('transient failure retries automatically; permanent failure stays pending',async()=>{
  let calls=0;
  const {ctx,state}=fixture(async()=>({ok:++calls===3,status:503,text:async()=>'<tags>'}));
  vm.runInContext('scanCards()',ctx);
  assert.equal(await vm.runInContext('fetchTagsFor(state.items.get(0))',ctx),true);
  assert.equal(calls,3);
  assert.equal(await vm.runInContext('fetchTagsFor(state.items.get(1))',ctx),false);
  assert.equal(calls,6);
  assert.equal(state.items.get(1)._tagsFetched,false);
});
