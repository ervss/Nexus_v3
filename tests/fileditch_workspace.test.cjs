const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const context = {module:{exports:{}}, URL};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../userscripts/fileditch-album-workspace.user.js'),'utf8'), context);
const {mediaUrl,identity,typeOf,sizeBytes,visibleItems}=context.module.exports;
test('accepts real Fileditch hosts and rejects lookalikes and executable URLs',()=>{
  assert.equal(mediaUrl('https://fileditchvids.st/alpha/id/a.mp4','https://fileditchalbums.st/a'),'https://fileditchvids.st/alpha/id/a.mp4');
  for(const u of ['https://fakefileditchvids.st/a.mp4','https://fileditchvids.st.evil.test/a.mp4','javascript:alert(1)','http://fileditchfiles.st/a.mp4'])assert.equal(mediaUrl(u,'https://fileditchalbums.st/a'),'');
});
test('selection identity survives refreshed query tokens without changing actual media URL',()=>{
  const u='https://fileditchfiles.st/alpha/id/Video%20One.mp4?token=new#x';
  assert.equal(identity(u),identity(u.replace('new','old')));
  assert.equal(mediaUrl(u,u),u);
  assert.equal(typeOf(u),'video');
  assert.equal(typeOf('https://fileditchfiles.st/a.JPG?x=1'),'image');
  assert.equal(typeOf('https://fileditchfiles.st/a.zip'),'other');
});
test('human sizes handle decimal and binary units without parsing missing values',()=>{
  assert.equal(sizeBytes('6.73 GB'),6.73e9);
  assert.equal(sizeBytes('1,5 GiB'),1.5*1024**3);
  assert.equal(sizeBytes('900 KB'),900e3);
  assert.equal(sizeBytes(undefined),0);
});
const items=[{id:'a',title:'Video 10',type:'video',index:0,bytes:1,date:5},{id:'b',title:'Video 2',type:'video',index:1,bytes:9,date:1},{id:'c',title:'Poster',type:'image',index:2,bytes:3,date:3}];
const state={query:'',type:'all',scope:'all',sort:'native'};
const ids=list=>Array.from(list,i=>i.id);
test('filter does not mutate album selection or native order',()=>{
  const chosen=new Set(['a','b']);
  assert.deepEqual(ids(visibleItems(items,{...state,query:'video 2'},chosen,new Set())),['b']);
  assert.deepEqual([...chosen],['a','b']);
  assert.deepEqual(ids(visibleItems(items,{...state,sort:'name'},chosen,new Set())),['c','b','a']);
  assert.deepEqual(ids(items),['a','b','c']);
});
test('reviewed, selected, type and sorting filters compose',()=>{
  assert.deepEqual(ids(visibleItems(items,{...state,type:'video',scope:'unreviewed',sort:'size'},new Set(),new Set(['a']))),['b']);
  assert.deepEqual(ids(visibleItems(items,{...state,scope:'selected'},new Set(['c']),new Set())),['c']);
  assert.deepEqual(ids(visibleItems(items,{...state,scope:'reviewed'},new Set(),new Set(['a']))),['a']);
  assert.deepEqual(ids(visibleItems(items,{...state,sort:'date'},new Set(),new Set())),['a','c','b']);
});
