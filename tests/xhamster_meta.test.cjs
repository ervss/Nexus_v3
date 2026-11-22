const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = { globalThis: {} };
context.globalThis = context;
vm.runInNewContext(fs.readFileSync('extensions/nexus-video-selector/xhamster-meta.js', 'utf8'), context);
const api = context.NVSXhamsterMeta;

const html = `"videoTabInitialData":{"videoListProps":{"videoThumbProps":[{"id":1,"duration":225}]}}
"videoModel":{"id":99,"idHashSlug":"xhTest","duration":905,"title":"Current"}
"xplayerSettings":{"videoId":99,"duration":905}
<link rel="preload" href="https://video-nss.example/media=hls4/multi=3840x2160:2160p/99/_TPL_.h264.mp4.m3u8">`;
const playlist = `#EXTM3U
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=513755,BANDWIDTH=770632,RESOLUTION=854x480
480p.h264.mp4.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=12866265,BANDWIDTH=19299397,RESOLUTION=3840x2160
2160p.h264.mp4.m3u8`;

test('current video duration is not taken from the first related clip', () => {
  assert.equal(api.durationSeconds(html), 905);
  assert.equal(api.formatDuration(905), '15:05');
});

test('highest rendition average bandwidth fills a size the short related duration would reject', () => {
  const sized = api.sizeFromMasterPlaylist(playlist, api.durationSeconds(html));
  assert.equal(sized.quality, '4K');
  assert.equal(sized.sizeMb, Math.round((12866265 * 905) / (8 * 1024 * 1024)));
  assert.equal(api.masterPlaylistUrl(html).endsWith('.m3u8'), true);
});

test('watch page date comes from videoModel.created, not an earlier related thumb', () => {
  const page = `<script id="initials-script">window.initials=${JSON.stringify({
    related: [{ id: 1, created: 1600000000, pageURL: 'https://xhamster.com/videos/related' }],
    videoModel: { id: 99, title: 'She Made Me Take It Off Halfway Through', description: 'x'.repeat(9000), duration: 708, created: 1791522056 },
  })};</script>`;
  assert.equal(api.uploadInfo(page).date, '9 October 2026');
  assert.equal(api.uploadInfo('<div class="entity-info-container__date" data-tooltip="2026-10-05T00:00:00.000Z">5 Oct</div>').date, '5 October 2026');
  assert.equal(api.uploadInfo('<script id="initials-script">window.initials={"videoEntity":{"dateAgo":"3 days ago"}};</script>').relDate, '3 days ago');
});

test('a cached xhamster size without a date is not treated as complete', () => {
  const background = fs.readFileSync('extensions/nexus-video-selector/background.js', 'utf8');
  assert.match(background, /uploadInfo/);
  assert.match(background, /cached\?\.adapter === 'xhamster-hls-v1' && Number\(cached\.sizeMb\) > 0 && cached\.date/);
});
