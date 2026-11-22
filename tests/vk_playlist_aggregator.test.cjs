const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('scripts/vk_playlist_aggregator_fixed.user.js', 'utf8');
const start = source.indexOf("    'use strict';");
const end = source.indexOf('    const style = document.createElement');
assert.ok(end > start);
const context = { URL, window: {}, location: {href:'https://vkvideo.ru/@popsmat/playlists', origin:'https://vkvideo.ru'} };
context.window.self = context.window.top = context.window;
vm.createContext(context);
vm.runInContext('(function(){' + source.slice(start, end) + '\nthis.helpers = {aggregateMetadata, canonicalizeVkPlaylistUrl, parseLooseCount, playlistSizeText, playlistDurationText};}).call(this);', context);
const h = context.helpers;

test('wall playlist negative ID and explicit zero counts survive parsing', () => {
  assert.equal(h.canonicalizeVkPlaylistUrl(new URL('https://vkvideo.ru/playlist/-186825900_-4')), 'https://vkvideo.ru/playlist/-186825900_-4');
  assert.equal(h.parseLooseCount('0 videos Updated 2 years ago'), 0);
  assert.equal(h.parseLooseCount('PopsMat 16+'), 0);
  assert.equal(h.parseLooseCount('310 videos'), 310);
});
test('sums matched videos once and uses card duration when metadata fails', () => {
  const result = h.aggregateMetadata([{url:'a',duration:60},{url:'b',duration:20}], [
    {url:'a',ok:true,duration:65,size_bytes:100,size_estimated:false},
    {url:'b',ok:false}, {url:'unrelated',ok:true,duration:999,size_bytes:999}
  ], 2);
  assert.equal(result.sizeBytes, 100);
  assert.equal(result.totalDurationSec, 85);
  assert.equal(result.sizePartial, true);
  assert.equal(result.durationPartial, false);
  assert.equal(result.sizeEstimated, false);
});
test('incomplete playlists never extrapolate a sample into a total', () => {
  const result = h.aggregateMetadata([{url:'a',duration:6}], [{url:'a',ok:true,duration:6,size_bytes:2250000}], 310);
  assert.equal(result.totalDurationSec, 6);
  assert.equal(result.sizeBytes, 2250000);
  assert.equal(result.durationPartial, true);
  assert.equal(result.sizeEstimated, true);
  assert.match(h.playlistSizeText(result), /^≥ ≈ /);
});
test('empty, pending and failed results have distinct labels', () => {
  assert.equal(h.playlistSizeText({analyzed:true,videoCount:0}), '0 B');
  assert.equal(h.playlistDurationText({analyzed:true,videoCount:0}), '0s');
  assert.equal(h.playlistSizeText({analysisPending:true}), 'Loading…');
  assert.equal(h.playlistDurationText({}), 'Unavailable');
});
test('automatic scan requests metadata and served installer matches source', () => {
  const worker = source.slice(source.indexOf('async function enrichCountsAfterScan'), source.indexOf('async function importPlaylistUrls'));
  assert.match(worker, /hydratePlaylistFromPage\(playlist, true\)/);
  assert.equal(fs.readFileSync('app/static/vk_playlist_aggregator_fixed.user.js','utf8'), source);
});
