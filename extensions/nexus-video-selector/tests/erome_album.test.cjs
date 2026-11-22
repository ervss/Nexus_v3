const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const dir = 'extensions/nexus-video-selector/';
const adapterCtx = { window: {}, URL };
vm.createContext(adapterCtx);
vm.runInContext(fs.readFileSync(dir + 'erome-listing.js', 'utf8'), adapterCtx);
const adapter = adapterCtx.window.NVSEromeListing;

const bg = fs.readFileSync(dir + 'background.js', 'utf8');
const parseSrc = bg.slice(bg.indexOf('// <erome-album-parse>'), bg.indexOf('// </erome-album-parse>'));
const bgCtx = {};
vm.createContext(bgCtx);
vm.runInContext(parseSrc + '\nthis.parse = parseEromeAlbumHtml; this.secs = eromeDurationSeconds; this.fmt = formatEromeDuration;', bgCtx);

test('album URLs are canonicalised and non-albums rejected', () => {
  assert.equal(adapter.watchUrl('https://www.erome.com/a/MXMXYlF9?x=1#y', 'https://www.erome.com/u'), 'https://www.erome.com/a/MXMXYlF9');
  assert.equal(adapter.watchUrl('/a/abc', 'https://www.erome.com/u'), 'https://www.erome.com/a/abc');
  assert.equal(adapter.watchUrl('/Respected_Killah23?t=posts', 'https://www.erome.com/'), '');
  assert.equal(adapter.watchUrl('https://evil.com/a/abc', 'https://www.erome.com/'), '');
});

test('view counters and onlyvideos hash are parsed', () => {
  assert.equal(adapter.parseCount('122'), 122);
  assert.equal(adapter.parseCount('2,5K'), 2500);
  assert.equal(adapter.parseCount('1.2M'), 1200000);
  assert.equal(adapter.onlyVideosRequested('#onlyvideos=1'), true);
  assert.equal(adapter.onlyVideosRequested('#onlyvideos=0'), false);
  assert.equal(adapter.onlyVideosRequested(''), false);
});

test('album HTML yields one entry per video with best resolution and duration', () => {
  const html = `<meta property="og:title" content="Neighbor&#039;s title"/>
    <video id="player-lg-11" class="x"><source src="https://v1.erome.com/a/b_720p.mp4" res='720'></video>
    <video id="player-11" class="x"><source src="https://v1.erome.com/a/b_480p.mp4" res='480'><source src="https://v1.erome.com/a/b_1080p.mp4" res='1080'></video>
    <span id="player-11-duration" class="duration" >1:02:03</span>
    <video id="player-12"><source src="https://v1.erome.com/a/c_720p.mp4"></video>`;
  const r = bgCtx.parse(html);
  assert.equal(r.videos.length, 2);
  assert.equal(r.videos[0].res, 1080);
  assert.equal(r.videos[0].duration, '1:02:03');
  assert.equal(r.videos[1].res, 720);
  assert.equal(r.title, "Neighbor's title");
  assert.equal(bgCtx.parse('<img src="x.jpg">').videos.length, 0);
});

test('duration helpers sum correctly', () => {
  assert.equal(bgCtx.fmt(bgCtx.secs('11:36') + bgCtx.secs('1:05')), '12:41');
  assert.equal(bgCtx.fmt(3725), '1:02:05');
});
