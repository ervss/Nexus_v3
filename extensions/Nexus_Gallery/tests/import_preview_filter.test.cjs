const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync('extensions/Nexus_Gallery/universal_importer.js', 'utf8');
const previewPattern = source.match(/const PREVIEW_HINT_RE = (\/.*\/i);/);
assert.ok(previewPattern, 'production preview filter exists');
const context = { PREVIEW_HINT_RE: vm.runInNewContext(previewPattern[1]) };
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('    function hasPreviewLikeContext('), source.indexOf('    // ── HLS Variant Parser')), context);
function video(overrides = {}) {
  return { currentSrc: 'https://cdn.example/full.mp4', duration: 600,
    getBoundingClientRect: () => ({ width: 960, height: 540 }),
    closest: () => null, querySelectorAll: () => [], getAttribute: () => null,
    hasAttribute: () => false, ...overrides };
}
test('large listing hover previews are rejected before metadata arrives', () => {
  assert.equal(context.isLikelyHoverPreviewVideo(video({ duration: NaN, closest: selector => selector.includes('.mb,') ? {} : null })), true);
});
test('preview and trailer streams are rejected regardless of player size', () => {
  for (const path of ['previews/abc.mp4', 'abc-trailer.mp4', 'thumbs/abc.webm']) {
    assert.equal(context.isLikelyHoverPreviewVideo(video({ currentSrc: `https://cdn.example/${path}` })), true);
  }
});
test('real short clips and full players are preserved; preview poster is not a stream', () => {
  assert.equal(context.isLikelyHoverPreviewVideo(video()), false);
  assert.equal(context.isLikelyHoverPreviewVideo(video({ duration: 10, poster: 'https://cdn.example/thumb.jpg' })), false);
  assert.equal(context.isLikelyHoverPreviewVideo(video({ duration: NaN })), false);
});
test('Video.js workinghover is not mistaken for a hover preview', () => {
  const player = { className: 'video-js vjs-workinghover vjs-playing', getAttribute: () => null };
  assert.equal(context.isLikelyHoverPreviewVideo(video({ parentElement: player })), false);
  player.className = 'video-js hover player';
  assert.equal(context.isLikelyHoverPreviewVideo(video({ parentElement: player })), true);
});
test('muted looping thumbnail playback is rejected', () => {
  assert.equal(context.isLikelyHoverPreviewVideo(video({ autoplay: true, muted: true, loop: true, duration: 10 })), true);
});
test('duration renders beside size including hours and unknown metadata', () => {
  const value = {};
  const durationContext = { getBestKnownDuration: video => video.duration };
  vm.createContext(durationContext);
  vm.runInContext(source.slice(source.indexOf('    function updateImportDuration('), source.indexOf('    function bgFetchHead(')), durationContext);
  const container = { _boundVideo: { duration: 3661 }, querySelector: () => value };
  durationContext.updateImportDuration(container);
  assert.equal(value.textContent, 'Duration: 1:01:01');
  container._boundVideo.duration = 10;
  durationContext.updateImportDuration(container);
  assert.equal(value.textContent, 'Duration: 0:10');
  container._boundVideo.duration = 0;
  durationContext.updateImportDuration(container);
  assert.equal(value.textContent, 'Duration: unknown');
});
