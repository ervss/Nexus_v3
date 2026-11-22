const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const context = {};
vm.runInNewContext(fs.readFileSync(`${__dirname}/export.js`, 'utf8'), context);
const {bounds, wrap} = context.NexusAnnotationExport;
test('reverse drag and high DPI map to correct source pixels', () => {
  const crop = {start:{x:.8,y:.9},end:{x:.2,y:.1}};
  assert.equal(JSON.stringify(bounds(crop, 2000, 1000)), JSON.stringify({x:400,y:100,width:1200,height:800}));
});
test('clips coordinates to source image', () => {
  assert.equal(JSON.stringify(bounds({start:{x:-1,y:-1},end:{x:2,y:2}},100,50)), JSON.stringify({x:0,y:0,width:100,height:50}));
});
test('rejects empty area', () => {
  assert.throws(() => bounds({start:{x:0,y:0},end:{x:0,y:0}},100,100));
});
test('wraps long notes and URLs without losing characters', () => {
  const text = 'Poznámka: dlhý text https://example.test/very-long-path';
  const lines = wrap({measureText:s=>({width:[...s].length*10})},text,70);
  assert.equal(lines.join(''),text);
  assert.ok(lines.every(line=>[...line].length<=7));
});
