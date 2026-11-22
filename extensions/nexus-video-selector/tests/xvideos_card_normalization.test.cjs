const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync('extensions/nexus-video-selector/content.js', 'utf8');
const start = source.indexOf('  function normalizeXvideosCards(cards) {');
const end = source.indexOf('\n  function findVideoCards()', start);
assert.notEqual(start, -1, 'XVideos card normalizer exists');
assert.notEqual(end, -1, 'XVideos card normalizer boundary exists');

test('XVideos card normalization terminates when candidates are already thumb-blocks', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  const first = { closest: () => first };
  const second = { closest: () => second };
  assert.deepEqual(Array.from(context.normalizeXvideosCards([first, second])), [first, second]);
});

test('nested XVideos listing cards normalize to unique thumb-block parents', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  const parent = { closest: () => parent };
  const child = { closest: () => parent };
  assert.deepEqual(Array.from(context.normalizeXvideosCards([child, parent])), [parent]);
});
