const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({ URL });
vm.runInContext(fs.readFileSync('extensions/Nexus_Gallery/eporner_playlist_mix_shared.js', 'utf8'), context);
const mix = context.NexusEpornerMix;

const playlistA = 'https://www.eporner.com/profile/demo/playlist/aaa111/clips/';
const playlistB = 'https://eporner.com/playlist/bbb222/clips/';

const state = mix.mergeFastEvents([
    { type: 'page', url: playlistA, items: [
        { url: 'https://www.eporner.com/hd-porn/v1/one/', title: 'One', duration: 60, height: 1080, rating: '90%' },
        { url: 'https://www.eporner.com/hd-porn/v2/two/', title: 'Two', duration: 120, height: 720, rating: '80%' },
    ] },
    { type: 'page', url: playlistB, items: [
        { url: 'https://www.eporner.com/video-v1/one/', title: 'One again', duration: 60, height: 1080, rating: '90%' },
    ] },
], [
    { url: playlistA, title: 'A' },
    { url: playlistB, title: 'B' },
]);

assert.equal(state.videos.length, 2);
assert.equal(state.duplicates, 1);
assert.equal(state.duration, 180);
assert.equal(state.videos[0].playlist_sources.length, 2);
assert.equal(state.quality_histogram['1080'], 1);
assert.ok(state.estimated_size_low_bytes > 0);
assert.ok(state.estimated_size_high_bytes > state.estimated_size_low_bytes);
assert.match(state.badges.join(' '), /HD|1080/);
assert.equal(mix.hasExactSizes([{ size_bytes: 10 }, { size_bytes: 20 }]), true);
assert.equal(mix.hasExactSizes([{ size_bytes: 10 }, { size_bytes: 0 }]), false);
assert.equal(mix.hasExactSizes([{ size_bytes: 10, size_estimated: true }]), false);

assert.equal(
    mix.videoIdentity('https://www.eporner.com/video-v1/one/'),
    mix.videoIdentity('https://www.eporner.com/hd-porn/v1/one/'),
);
assert.equal(mix.normalizePlaylistUrl('https://eporner.com/playlist/aaa111/test/?x=1'), 'https://eporner.com/playlist/aaa111/test/');
assert.equal(mix.normalizePlaylistUrl('https://example.com/playlist/aaa111/'), '');

const alias = mix.mergeFastEvents([
    { type: 'page', url: 'https://www.eporner.com/playlist/aaa111/alias/', items: [
        { url: 'https://www.eporner.com/video-v3/three/', title: 'Three', duration: 30 },
    ] },
], [{ url: playlistA, title: 'A' }]);
assert.equal(alias.videos[0].playlist_sources[0].title, 'A');

console.log('Eporner playlist mix shared helpers: passed');
