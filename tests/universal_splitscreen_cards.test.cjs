const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Execute the production harvester against actual DOM APIs, without starting
// the userscript's players, network requests or persistent UI.
const source = fs.readFileSync(path.join(__dirname, '../userscripts/nexus-universal-splitscreen.user.js'), 'utf8');
const start = source.indexOf('  function harvestGenericVideoCards()');
const end = source.indexOf('\n  // ---------------------------------------------------------------------------', start);
assert.ok(start >= 0 && end > start);
const sharedStart = source.indexOf('  function sharedCard(item)');
const durationStart = source.indexOf('  function formatDuration(sec)');
const durationEnd = source.indexOf('\n  function ', durationStart + 5);
const turboStart = source.indexOf('  function turboVideoInfo(');
const turboEnd = source.indexOf('\n  function isPixeldrain(', turboStart);
assert.ok(turboStart >= 0 && turboEnd > turboStart);
const harvester = 'function applyMetadataFromCache() { return false; }\n' + source.slice(turboStart, turboEnd) + '\n' + source.slice(durationStart, durationEnd) + '\n' + source.slice(sharedStart, start) + source.slice(start, end);
const extractorStart = source.indexOf('  function extractVideoPageSource(');
const extractorEnd = source.indexOf('  async function resolveStreamUrl(', extractorStart);
const extractor = source.slice(extractorStart, extractorEnd);
const formatStart = source.indexOf('  function detectFormat(');
const formatEnd = source.indexOf('\n  //', formatStart);
const format = source.slice(formatStart, formatEnd);
const bunkrStart = source.indexOf('  function harvestBunkrTurboCards()');
const bunkrEnd = source.indexOf('\n  // 5b.', bunkrStart);
const bunkrHarvester = source.slice(bunkrStart, bunkrEnd);
const mergeStart = source.indexOf('  function mergeSelectedPageCards(results)');
const mergeEnd = source.indexOf('\n  function scanPageVideos()', mergeStart);
assert.ok(mergeStart > 0 && mergeEnd > mergeStart);
const mergeSelection = source.slice(mergeStart, mergeEnd);

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://gallery.example/**', route => route.fulfill({ body: '', contentType: 'text/html' }));
    await page.goto('https://gallery.example/groups/example/videos');
    const scan = async html => {
      await page.setContent(html);
      return page.evaluate(code => {
        return new Function('isCamwhores', `${code}; return harvestGenericVideoCards();`)(() => false);
      }, harvester);
    };
    let items = await scan(`<div class="card">
      <a class="pg_video" href="/posts/one" style="background-image:url('/thumbs/one.jpg')"></a>
      <a class="pg_video" href="/posts/two" style="background-image:url('/thumbs/two.jpg')"></a>
    </div>`);
    assert.equal(items.length, 2, 'bare video-post anchors inside a gallery');
    assert.equal(items[0].poster, 'https://gallery.example/thumbs/one.jpg');
    assert.equal(items[0].watchUrl, 'https://gallery.example/posts/one');
    items = await scan(`<div class="video-card"><a href="/members/person">Profile</a>
      <a href="/watch/movie"><img data-src="/lazy.jpg" alt="Movie title"></a>
      <span>1:18:14 · 1280×720 · 657 MB</span></div>`);
    assert.equal(items.length, 1, 'nested anchors deduplicate');
    assert.equal(items[0].watchUrl, 'https://gallery.example/watch/movie', 'prefer video over profile');
    assert.equal(items[0].title, 'Movie title');
    assert.equal(items[0].durationStr, '1:18:14');
    assert.equal(items[0].poster, 'https://gallery.example/lazy.jpg');
    items = await scan(`<a href="/posts/other"><div style="background-image:url('/other.jpg')"></div>
      <span>42:09 · 853×480 · 148 MB</span></a>`);
    assert.equal(items.length, 1, 'unknown classes and nested background thumbnails');
    items = await scan(`<div id="nuss-picker-modal"><a class="pg_video" href="/posts/internal" data-thumb="/x.jpg"></a></div>
      <a href="/groups/foo/videos">Videos</a><a href="/posts/photo" style="background-image:url('/photo.jpg')">14:30</a>
      <a class="pg_video" href="javascript:alert(1)" data-thumb="/x.jpg"></a>
      <a class="pg_video" href="#player" data-thumb="/x.jpg"></a>`);
    assert.equal(items.length, 0, 'ignore own UI, navigation, photo timestamps and unsafe URLs');
    items = await scan('<div class="thumb-block"><a href="/unusual-route/123"><img src="/legacy.jpg"></a><span>12:34</span></div>');
    assert.equal(items.length, 1, 'preserve image-and-duration fallback');
    await page.setContent('<a class="pg_video" href="/posts/dynamic" data-thumb="/dynamic.jpg"></a>');
    items = await page.evaluate(code => new Function('isCamwhores', `${code}; return harvestGenericVideoCards();`)(() => false), harvester);
    assert.equal(items.length, 1, 'rescan reads newly loaded cards');
    const turboCards = Array.from({ length: 4 }, (_, i) => `<span data-nvs-processed="1" data-nvs-url="https://turbo.cr/v/video${i + 1}" class="nvs-turbo-card${i < 3 ? ' nvs-card-selected' : ''}"><iframe src="https://turbo.cr/embed/video${i + 1}"></iframe></span>`).join('');
    items = await scan(turboCards);
    assert.equal(items.length, 4, 'each Turbo thread embed becomes one canonical video');
    const selectedTurbo = items.filter(item => item.isSelectedOnPage);
    assert.equal(selectedTurbo.length, 3, 'all three selected Turbo embeds remain selected');
    assert.equal(selectedTurbo.map(item => item.url).join(','), 'https://turbo.cr/v/video1,https://turbo.cr/v/video2,https://turbo.cr/v/video3');
    assert.ok(items.every(item => item.type === 'bunkr_turbo'), 'Turbo embeds use the direct-stream resolver');
    await page.setContent(`<script>const FILES = [{id:'one',name:'One'},{id:'two',name:'Two'},{id:'three',name:'Three'},{id:'four',name:'Four'}];</script>${['one','two','three','four'].map((id, i) => `<div class="bah-card${i < 3 ? ' bah-selected' : ''}"><img src="/images/video.svg"><a href="/f/${id}"><img class="bah-main-thumb" src="/thumb-${id}.jpg"></a></div>`).join('')}`);
    items = await page.evaluate(code => new Function(`${code}; return harvestBunkrTurboCards();`)(), bunkrHarvester);
    assert.equal(items.length, 4, 'Bunkr cards merge with FILES by id');
    assert.deepEqual(items.filter(item => item.isSelectedOnPage).map(item => item.id), ['one', 'two', 'three']);
    assert.equal(items[0].poster, 'https://gallery.example/thumb-one.jpg', 'use the actual card thumbnail');
    await page.setContent(`<div data-nvs-processed="1" data-nvs-url="https://gallery.example/videos/one" class="nvs-card-selected"><img src="/one.jpg"></div>
      <div data-nvs-processed="1" data-nvs-url="https://gallery.example/videos/two"><img src="/two.jpg"></div>`);
    const merged = await page.evaluate(code => new Function('getPixeldrainId', 'turboVideoInfo', `${code}; return mergeSelectedPageCards([{url:'https://gallery.example/videos/one',title:'One'},{url:'https://gallery.example/videos/two',title:'Two'}]);`)(() => null, () => null), mergeSelection);
    assert.equal(merged[0].isSelectedOnPage, true, 'specialized results inherit the selector choice');
    assert.equal(merged[0].poster, 'https://gallery.example/one.jpg');
    assert.equal(merged[1].isSelectedOnPage, undefined, 'unselected cards stay unselected');
    items = await scan('<a class="pg_video" href="/posts/date" data-thumb="/x.jpg">16.10.2026 03:44</a>');
    assert.equal(items[0].durationStr, '', 'post timestamp is not video duration');
    const extract = html => page.evaluate(({ code, html }) => new Function('html', `${code}; return extractVideoPageSource(html, 'https://gallery.example/posts/one');`)(html), {
      code: `function getPixeldrainId() { return ''; }\n${format}\n${extractor}`, html
    });
    let media = await extract(`<audio><source src="/notification.mp3" type="audio/mpeg"></audio>
      <div data-id="video-123" data-src="/video/play?src=abc&amp;exp=123&amp;sig=xyz" data-length="2778" data-poster="/poster.jpg"></div>`);
    assert.equal(media.url, 'https://gallery.example/video/play?src=abc&exp=123&sig=xyz');
    assert.equal(media.duration, 2778);
    assert.equal(media.poster, 'https://gallery.example/poster.jpg');
    media = await extract('<audio><source src="/notification.mp3"></audio><video><source type="video/mp4" src="/movie.mp4?a=1&amp;b=2"></video>');
    assert.equal(media.url, 'https://gallery.example/movie.mp4?a=1&b=2');
    assert.equal(media.type, 'mp4');
    assert.equal(await extract('<audio><source src="/notification.mp3"></audio>'), null);
    assert.equal(await extract('<video src="/notification.mp3"></video>'), null);
    media = await extract('<meta content="/video/movie.webm" property="og:video">');
    assert.equal(media.url, 'https://gallery.example/video/movie.webm');
    assert.equal(await extract('<meta property="og:video" content="/embed/html-page">'), null);
    media = await extract('<script type="application/ld+json">{"@graph":[{"@type":"ImageObject","contentUrl":"/photo.jpg"},{"@type":"VideoObject","contentUrl":"/structured.mp4"}]}</script>');
    assert.equal(media.url, 'https://gallery.example/structured.mp4');
    console.log('Passed 8 card scenarios and 7 video-source scenarios.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
