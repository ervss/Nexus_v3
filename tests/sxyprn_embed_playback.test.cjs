const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

function loadBackground() {
  const context = {
    console, URL, Headers, AbortController, AbortSignal, setTimeout, clearTimeout, atob, btoa,
    Buffer,
    fetch: async () => { throw new Error('unexpected network request'); },
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    },
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync('extensions/nexus-video-selector/background.js', 'utf8'),
    context,
  );
  return context;
}

test('SxyPrn external-host embeds use the iframe player, not the HTML5 media player', () => {
  const source = fs.readFileSync('app/static/main.js', 'utf8');
  const method = source.match(/isSxyprnEmbedVideo\(video\)\s*\{([\s\S]*?)\n\s*\},/);
  assert.ok(method, 'SxyPrn embed predicate should exist');
  const isSxyprnEmbedVideo = vm.runInNewContext(
    `(video) => {${method[1]}}`,
    { URL },
  );
  const alias = source.match(/isSxyprnVideo\(video\)\s*\{([\s\S]*?)\n\s*\},/);
  assert.ok(alias, 'Netflix SxyPrn predicate should delegate to the shared embed predicate');
  const isSxyprnVideo = vm.runInNewContext(
    `(video) => {${alias[1]}}`,
    { isSxyprnEmbedVideo },
  );
  const embedUrlMethod = source.match(/sxyprnEmbedUrl\(video\)\s*\{([\s\S]*?)\n\s*\},/);
  assert.ok(embedUrlMethod, 'SxyPrn embed URL normalizer should exist');
  const sxyprnEmbedUrl = vm.runInNewContext(
    `(video) => {${embedUrlMethod[1]}}`,
    { URL },
  );

  for (const hostUrl of [
    'https://bysesukior.com/e/2mvqrccp6yck',
    'https://vidara.so/e/XABjFIu95yodC',
    'https://vidara.to/e/JZCcwRwPaPtln',
    'https://luluvdo.com/e/abc123',
    'https://lulustream.com/e/abc123',
    'https://luluvids.com/e/abc123',
    'https://streamtape.com/v/mQx9MY2mqxtdqM',
  ]) {
    const video = {
      source_url: 'https://www.sxyprn.net/post/649b06c507b12',
      url: hostUrl,
    };
    assert.equal(isSxyprnEmbedVideo(video), true, hostUrl);
    assert.equal(isSxyprnVideo.call({ isSxyprnEmbedVideo }, video), true, hostUrl);
    assert.match(sxyprnEmbedUrl(video), /^https:\/\/(?:bysesukior\.com|vidara\.(?:so|to)|luluvdo\.com|streamtape\.com)\/e\//);
  }
  assert.equal(isSxyprnEmbedVideo({
    source_url: 'https://www.sxyprn.net/post/67c3e0b7d8b89',
    url: 'https://cdn1018.cdn-tnmr.org/hls/video/master.m3u8',
  }), false);
  assert.equal(isSxyprnEmbedVideo({
    source_url: 'https://example.com/post/123',
    url: 'https://bysesukior.com/e/2mvqrccp6yck',
  }), false);
});

test('SxyPrn metadata includes an absolute OG thumbnail URL', async () => {
  const background = loadBackground();
  const meta = await background.extractSxyprnMeta(
    '<meta property="og:image" content="/images/poster.jpg?x=1&amp;y=2">',
    'https://www.sxyprn.net/post/6ae8fdd42a2c3',
    null,
    { quick: true },
  );

  assert.equal(
    meta.thumbnail,
    'https://www.sxyprn.net/images/poster.jpg?x=1&y=2',
  );
});

test('SxyPrn metadata does not use external hosts from recommended posts', async () => {
  const background = loadBackground();
  const meta = await background.extractSxyprnMeta(
    '<video id="player_el" data-postid="target-post"></video>' +
      '<span data-vnfo=\'{"target-post":"\\/cdn\\/video.vid"}\'></span>' +
      '<div class="post_el_small"><a href="https://luluvdo.com/e/other-post">Recommended</a></div>',
    'https://www.sxyprn.net/post/target-post',
    null,
    { quick: true },
  );

  assert.equal(meta.sourceUrls.some((url) => url.includes('luluvdo.com')), false);
  assert.equal(String(meta.streamUrl || '').includes('luluvdo.com'), false);
  assert.equal(meta.selectedSourceHost, 'sxyprn.net');

  const withoutPlayer = await background.extractSxyprnMeta(
    '<div class="post_el_small"><a href="https://luluvdo.com/e/other-post">Recommended</a></div>',
    'https://www.sxyprn.net/post/target-post',
    null,
    { quick: true },
  );
  assert.equal(withoutPlayer.sourceUrls.some((url) => url.includes('luluvdo.com')), false);
  assert.equal(String(withoutPlayer.streamUrl || '').includes('luluvdo.com'), false);
});
