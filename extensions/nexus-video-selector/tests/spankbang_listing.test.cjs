const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const context = { URL, Date };
vm.runInNewContext(fs.readFileSync('extensions/nexus-video-selector/spankbang-listing.js', 'utf8'), context);
const api = context.NVSSpankBangListing;

function anchor(href, attrs = {}, text = '') {
  return { getAttribute: name => (name === 'href' ? href : attrs[name] || null), textContent: text };
}
function card(spec) {
  const anchors = spec.anchors || [];
  return {
    querySelectorAll(selector) { return selector === 'a[href]' ? anchors : []; },
    querySelector(selector) {
      if (selector === 'img') return spec.alt ? { getAttribute: () => spec.alt } : null;
      if (selector === '[data-testid="video-item-length"]') return { textContent: spec.length || '' };
      if (selector === '[data-testid="video-item-resolution"]') return { textContent: spec.resolution || '' };
      return null;
    },
  };
}
function grid(className, items) {
  return {
    classList: { contains: name => className.split(/\s+/).includes(name) },
    querySelectorAll(selector) { return selector === '[data-testid="video-item"]' ? items : []; },
  };
}
function root(grids, links = []) {
  const pagination = {
    querySelectorAll(selector) { return selector === 'a[href]' ? links : []; },
  };
  return {
    querySelectorAll(selector) { return selector === 'div.js-media-list' ? grids : []; },
    querySelector(selector) { return String(selector).includes('pagination') ? pagination : null; },
  };
}

test('watch links keep the id and slug and reject listings, channels and other hosts', () => {
  const base = 'https://spankbang.com/s/bimbo/?o=new';
  assert.equal(api.watchUrl('/4nnkw/video/example-title?o=new', base), 'https://spankbang.com/4nnkw/video/example-title/');
  assert.equal(api.watchUrl('https://spankbang.party/abc123/video/other/', base), 'https://spankbang.party/abc123/video/other/');
  for (const path of ['/s/bimbo/', '/s/bimbo/2/', '/new_videos/', '/channel/name/', '/playlist/rus/', '/5x2u6/playlist/bimbo/', '/5x2u6/playlist/bimbo/2/', 'https://example.test/abc/video/no/']) {
    assert.equal(api.watchUrl(path, base), '');
  }
  assert.equal(api.watchUrl('/5x2u6-shoyfj/playlist/bimbo', 'https://spankbang.com/5x2u6/playlist/bimbo/'), 'https://spankbang.com/5x2u6-shoyfj/playlist/bimbo/');
});

test('playlist cards keep the per-video link and the next page is a path segment', () => {
  const base = 'https://spankbang.com/5x2u6/playlist/bimbo/';
  const tag = anchor('/s/babe/', { title: 'Babe', 'data-testid': 'title' }, 'Babe');
  const item = card({
    anchors: [
      anchor('/5x2u6-shoyfj/playlist/bimbo'),
      tag,
      anchor('/5x2u6-shoyfj/playlist/bimbo', { title: 'Brandy Robbins 2' }),
    ],
    length: '11m',
    resolution: 'HD',
  });
  const found = api.cards(root([grid('js-media-list', [item])]), base);
  assert.equal(found.length, 1);
  assert.equal(String(found[0].url), 'https://spankbang.com/5x2u6-shoyfj/playlist/bimbo/');
  assert.equal(found[0].title, 'Brandy Robbins 2');
  assert.equal(found[0].duration, '11m');
  const links = [
    anchor('/5x2u6/playlist/bimbo/2/', {}, '2'),
    anchor('/5x2u6/playlist/bimbo/3/', {}, '3'),
  ];
  assert.equal(api.nextUrl(root([], links), base), 'https://spankbang.com/5x2u6/playlist/bimbo/2/');
});

test('result cards ignore the promoted strip and the channel title', () => {
  const promoted = grid('js-media-list js-forced-layout', [
    card({ anchors: [anchor('/promo/video/sponsored/', { title: 'Sponsored' })], length: '1m' }),
  ]);
  const channel = anchor('/8abc/profile/name/', { title: 'Channel name', 'data-testid': 'title' }, 'Channel name');
  const watch = anchor('/4nnkw/video/real-title/', { title: 'Real title' });
  const real = grid('js-media-list', [
    card({ anchors: [channel, watch], length: '49m', resolution: 'HD' }),
    card({ anchors: [anchor('/8xyz/video/four-k/', { title: 'Four K' })], length: '12m', resolution: '4K' }),
  ]);
  const found = api.cards(root([promoted, real]), 'https://spankbang.com/s/bimbo/?o=new');
  assert.deepEqual(Array.from(found, item => String(item.url)), [
    'https://spankbang.com/4nnkw/video/real-title/',
    'https://spankbang.com/8xyz/video/four-k/',
  ]);
  assert.equal(found[0].title, 'Real title');
  assert.equal(found[0].duration, '49m');
  assert.equal(found[0].quality, 'HD');
  assert.equal(found[1].quality, '4K');
});

test('next page follows the path segment and keeps the current query', () => {
  const base = 'https://spankbang.com/s/bimbo/?o=new';
  const links = [
    anchor('/s/bimbo/?o=new', {}, '1'),
    anchor('/s/bimbo/2/?o=new', {}, '2'),
    anchor('/s/bimbo/1000/?o=new', {}, '1000'),
  ];
  assert.equal(api.nextUrl(root([], links), base), 'https://spankbang.com/s/bimbo/2/?o=new');
  assert.equal(new URL(api.nextUrl(root([], links), base)).searchParams.get('page'), null);
  assert.equal(api.nextUrl(root([], links), 'https://spankbang.com/s/bimbo/1000/?o=new'), '');
  assert.equal(api.nextUrl(root([], links), 'https://spankbang.com/4nnkw/video/example/'), '');
});

test('watch page supplies the upload time, exact duration, best file and tags', () => {
  const html = `
    <link rel="canonical" href="https://spankbang.com/708rb/video/brandy+robbins+2" />
    <time datetime="2026-10-06T00:28:12+00:00" title="2026-10-06 00:28:12 UTC">1 month ago</time>
    <script>var live_keywords = 'sb_verified,Brittany Bardot,MILF,sb-internal';</script>
    <script>var stream_data = {'4k': [], '1080p': ['https://vdownload-1.sb-cd.com/a-1080p.mp4?secure=abc'], '720p': ['https://vdownload-1.sb-cd.com/a-720p.mp4?secure=abc'], 'm3u8': ['https://hls-uranus.sb-cd.com/hls/a/master.m3u8?secure=abc'], 'length': 481, 'main': ['https://vdownload-1.sb-cd.com/a-720p.mp4?secure=abc']};</script>`;
  const parsed = api.watchMeta(html);
  assert.equal(parsed.datetime, '2026-10-06T00:28:12+00:00');
  assert.equal(parsed.date, new Date('2026-10-06T00:28:12+00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }));
  assert.equal(parsed.duration, '8:01');
  assert.equal(parsed.quality, '1080P');
  assert.equal(parsed.streamUrl, 'https://vdownload-1.sb-cd.com/a-1080p.mp4?secure=abc');
  assert.deepEqual(Array.from(parsed.tags, tag => String(tag)), ['brittany-bardot', 'milf']);
  assert.equal(parsed.sources.some(source => source.type === 'hls'), true);
  const meta = api.toMeta(parsed, 175.2);
  assert.equal(meta.adapter, 'spankbang-watch-v1');
  assert.equal(meta.sizeMb, 175);
  assert.equal(meta.sizeText, '175 MB');
  assert.equal(meta.streamUrl, undefined);
  assert.equal(meta.canonical, 'https://spankbang.com/708rb/video/brandy+robbins+2/');
  assert.equal(api.toMeta(api.watchMeta('<html>Just a moment...</html>')), null);
});

test('selector wires SpankBang into cards, import and the manifest', () => {
  const content = fs.readFileSync('extensions/nexus-video-selector/content.js', 'utf8');
  const manifest = JSON.parse(fs.readFileSync('extensions/nexus-video-selector/manifest.json', 'utf8'));
  assert.match(content, /isSpankBangPage\(\)/);
  assert.match(content, /NVSSpankBangListing\.cards/);
  assert.match(content, /js-forced-layout/);
  assert.match(content, /loadSpankBangPages/);
  assert.match(content, /meta\.canonical/);
  assert.equal(manifest.version, '1.5.15');
  assert.ok(manifest.content_scripts[0].js.includes('spankbang-listing.js'));
  assert.ok(manifest.content_scripts[0].js.indexOf('spankbang-listing.js') < manifest.content_scripts[0].js.indexOf('content.js'));
});
