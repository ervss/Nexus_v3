import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source = readFileSync(new URL('../extensions/Nexus_Gallery/universal_importer.js', import.meta.url), 'utf8');
const context = vm.createContext({ URL });
test('metadata filters combine ranges and sorting keeps unknown values last', () => {
 const owner = {_huntFilter:'all', _huntCandidates:[
  {id:'a',url:'https://a.test/a',identity_state:'related',height:1080,size_bytes:100*1048576,duration_sec:600},
  {id:'b',url:'https://b.test/b',identity_state:'confirmed',height:720,size_bytes:50*1048576,duration_sec:300},
  {id:'c',url:'https://c.test/c',identity_state:'possible',height:0},
 ]};
 owner._huntView={quality:'1080',sizeMin:'90',sizeMax:'110',durationMin:'9',durationMax:'11'};
 assert.deepEqual(Array.from(context.selectHuntCards(owner),c=>c.id),['a']);
 owner._huntView={sort:'size_bytes:asc'};
 assert.deepEqual(Array.from(context.selectHuntCards(owner),c=>c.id),['b','a','c']);
 owner._huntView={sort:'duration_sec:desc'};
 assert.deepEqual(Array.from(context.selectHuntCards(owner),c=>c.id),['a','b','c']);
 owner._huntView={quality:'unknown'};
 assert.deepEqual(Array.from(context.selectHuntCards(owner),c=>c.id),['c']);
 owner._huntView={durationMin:'11',durationMax:'9'};
 assert.equal(context.selectHuntCards(owner).length,0);
});
vm.runInContext(source.slice(source.indexOf('    function normalizeHuntCards('), source.indexOf('    function acceptHuntResponse(')), context);
test('legacy duplicates and mirrors use the same selector and count', () => {
 const card = { url:'https://camwhores.tv/videos/123/test', confirmed:true, height:1080, height_source:'metadata' };
 const owner = { _huntGroups:{ better:[card], other:[{...card, mirrors:[card]}] } };
 assert.equal(context.normalizeHuntCards(owner).length, 1);
 assert.equal(context.selectHuntCards(owner).length, 1);
 assert.equal(context.huntSummary(owner).confirmed, 1);
});
test('independent source families and upgrade counts use normalized states', () => {
 const base = { identity_state:'confirmed', availability_state:'playable', quality_state:'measured', quality_status:'higher' };
 const owner = { _huntCandidates:[{...base,id:'1',url:'https://camwhores.tv/videos/1'}, {...base,id:'2',url:'https://camwhores.video/videos/2'}, {...base,id:'3',url:'https://host.example/video/3',availability_state:'login_required'}, {...base,id:'4',url:'https://host.example/video/4',identity_state:'rejected'}] };
 assert.equal(context.huntSummary(owner).sources, 2);
 assert.equal(context.huntSummary(owner).improvements, 2);
 owner._huntFilter = 'improved'; assert.equal(context.selectHuntCards(owner).length, 2);
 owner._huntFilter = 'all'; assert.equal(context.selectHuntCards(owner).length, 3);
});
test('the default shows exact, edited and plausible scene matches; actor-only stays separate', () => {
 const base={availability_state:'unknown',quality_state:'unknown'};
 const owner={_huntCandidates:[
  {...base,id:'wrong',url:'https://a.test/wrong',identity_state:'unverified',height:2160},
  {...base,id:'actor',url:'https://b.test/actor',identity_state:'related',height:2160},
  {...base,id:'similar',url:'https://f.test/similar',identity_state:'similar',height:2160},
  {...base,id:'maybe',url:'https://c.test/maybe',identity_state:'possible',height:1080},
  {...base,id:'cut',url:'https://e.test/cut',identity_state:'variant',variant_kind:'shorter',height:1080},
  {...base,id:'same',url:'https://d.test/same',identity_state:'confirmed',height:720},
 ]};
 assert.deepEqual(Array.from(context.selectHuntCards(owner),card=>card.id),['same','cut','maybe','similar']);
 assert.equal(context.huntSummary(owner).variants,1);
 assert.equal(context.huntSummary(owner).sources,2);
 assert.equal(context.huntSummary(owner).related,1);
 assert.equal(context.huntSummary(owner).excluded,1);
 owner._huntFilter='verify'; assert.deepEqual(Array.from(context.selectHuntCards(owner),card=>card.id),['maybe']);
 owner._huntFilter='similar'; assert.deepEqual(Array.from(context.selectHuntCards(owner),card=>card.id),['similar']);
 owner._huntFilter='variant'; assert.deepEqual(Array.from(context.selectHuntCards(owner),card=>card.id),['cut']);
 owner._huntFilter='performer'; assert.deepEqual(Array.from(context.selectHuntCards(owner),card=>card.id),['actor']);
 owner._huntFilter='all'; assert.equal(context.selectHuntCards(owner).length,5);
});

test('independent sources precede repeat mirrors of one site', () => {
 const base={identity_state:'confirmed',availability_state:'unknown',quality_state:'unknown'};
 const owner={_huntCandidates:[
  {...base,id:'a1',url:'https://a.test/one',height:2160},
  {...base,id:'a2',url:'https://a.test/two',height:1080},
  {...base,id:'b1',url:'https://b.test/one',height:720},
 ]};
 assert.deepEqual(Array.from(context.selectHuntCards(owner),card=>card.id),['a1','b1','a2']);
});
