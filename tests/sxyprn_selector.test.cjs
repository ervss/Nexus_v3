const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

function worker(fetch) {
  const context = {
    console, URL, Headers, AbortController, AbortSignal, setTimeout, clearTimeout, atob, btoa, fetch,
    Buffer,
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('extensions/nexus-video-selector/background.js', 'utf8'), context);
  return context;
}

test('SxyPrn URL detector and CDN stream deobfuscator', () => {
  const bg = worker(async () => { throw new Error('unexpected fetch'); });

  assert.equal(bg.isSxyprnUrl('https://www.sxyprn.net/post/6aca70d018603.html'), true);
  assert.equal(bg.isSxyprnUrl('https://sxyprn.net/post/6aca70d018603'), true);
  assert.equal(bg.isSxyprnUrl('https://sxyprn.com/post/6aca70d018603.html'), true);
  assert.equal(bg.isSxyprnUrl('https://other.com/post/123'), false);

  const rawPath = '/cdn/c10/pw1d9m5szj1e4y6xz81l5w7szp6v2/kJOpxhx7THsVXrNJu_cKyA/1791738606/g5kfx3f8xca54687o0zb8dh2r5f/rw6pa1cha77104db0y1q8i6u0c3.vid';
  const cdnUrl = bg.resolveSxyprnCdnUrl(rawPath, 'https://www.sxyprn.net/post/6aca70d018603.html');
  assert.match(cdnUrl, /^https:\/\/www\.sxyprn\.net\/cdn5\/[A-Za-z0-9_.-]+\/c10\//);
  assert.match(cdnUrl, /\.vid$/);
});

test('SxyPrn keeps the primary CDN as an unverified fallback and verifies external streams', async () => {
  const sampleHtml = `<meta property="og:title" content="Test video">
    <meta itemprop="duration" content="PT10M">
    <div data-vnfo='{"file":"/cdn/c10/pw1d9m5szj1e4y6xz81l5w7szp6v2/kJOpxhx7THsVXrNJu_cKyA/1791738606/g5kfx3f8xca54687o0zb8dh2r5f/rw6pa1cha77104db0y1q8i6u0c3.vid"}' data-mgfs="600000000"></div>
    <a href="https://vidara.so/v/test123">Player</a><div id="player_el"></div>`;
  const bg = worker(async (url) => {
    if (url.includes('/api/stream')) {
      return {
        ok: true,
        json: async () => ({
          streaming_url: 'https://cdn.example/vidara/master.m3u8',
          title: 'Mock Vidara',
        }),
      };
    }
    if (url === 'https://cdn.example/vidara/master.m3u8') {
      return { ok: true, text: async () => '#EXTM3U\n#EXT-X-ENDLIST' };
    }
    return { ok: false };
  });

  const meta = await bg.extractSxyprnMeta(sampleHtml, 'https://www.sxyprn.net/post/6aca70d018603.html', null);
  assert.ok(meta);
  assert.equal(meta.adapter, 'sxyprn-source-v1');
  assert.equal(meta.selectedPlayer, 2);
  assert.equal(meta.selectedSourceHost, 'vidara.so');
  assert.match(meta.streamUrl, /^https:\/\/cdn\.example\/vidara\//);
  assert.ok(meta.sizeMb > 500, `Expected sizeMb > 500, got ${meta.sizeMb}`);
  assert.equal(meta.bestOfAllVerified, true);
  assert.ok(meta.sourceResults.length >= 2, `Expected at least 2 servers in sourceResults, got ${meta.sourceResults.length}`);
  assert.equal(meta.sourceResults[0].status, 'unverified');
  assert.equal(meta.sourceResults[0].host, 'sxyprn.net');
});

test('SxyPrn does not hand off a manifest URL that returns an HTML error', async () => {
  const mirror = 'https://vidara.so/v/test123';
  const broken = 'https://cdn.example/broken.m3u8';
  const bg = worker(async url => {
    if (url.includes('/api/stream')) return { ok: true, json: async () => ({ streaming_url: broken }) };
    if (url === broken) return { ok: true, text: async () => '<html>Source unavailable</html>' };
    return { ok: false };
  });
  const meta = await bg.extractSxyprnMeta(`<a href="${mirror}">Player</a><div id="player_el"></div>`,
    'https://www.sxyprn.net/post/6aca70d018603.html', null);
  assert.equal(meta.streamUrl, mirror);
  assert.equal(meta.sourceResults[0].streamFormat, undefined);
});

test('SxyPrn quick mode and nvsCacheAdmin logic', async () => {
  const sampleHtml = `<meta property="og:title" content="Test video">
    <meta itemprop="duration" content="PT10M">
    <div data-vnfo='{"file":"/cdn/c10/pw1d9m5szj1e4y6xz81l5w7szp6v2/kJOpxhx7THsVXrNJu_cKyA/1791738606/g5kfx3f8xca54687o0zb8dh2r5f/rw6pa1cha77104db0y1q8i6u0c3.vid"}' data-mgfs="600000000"></div>
    <a href="https://vidara.so/v/test123">Player</a><div id="player_el"></div>`;
  const mockStorage = {};
  const bg = worker(async () => ({ ok: false }));
  bg.chrome.storage.local = {
    get: async (key) => {
      if (key === null) return mockStorage;
      if (typeof key === 'string') return { [key]: mockStorage[key] };
      return {};
    },
    set: async (items) => { Object.assign(mockStorage, items); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete mockStorage[k]; },
  };

  // 1. Quick mode test
  const quickMeta = await bg.extractSxyprnMeta(sampleHtml, 'https://www.sxyprn.net/post/6aca70d018603.html', null, { quick: true });
  assert.equal(quickMeta.adapter, 'sxyprn-source-quick');
  assert.equal(quickMeta.sourceResults.length, 2);
  assert.equal(quickMeta.selectedPlayer, 2);

  // 2. Cache Admin test
  const testUrl = 'https://www.sxyprn.net/post/6aca70d018603.html';
  await bg.writeCache(testUrl, { title: 'Test Video', sizeMb: 500, streamUrl: 'https://test/v.mp4', adapter: 'sxyprn-source-v1' });

  const stats = await bg.nvsCacheAdmin({ action: 'stats', host: 'sxyprn.net' });
  assert.equal(stats.ok, true);
  assert.equal(stats.count, 1);
  assert.ok(stats.bytes > 50);

  const exp = await bg.nvsCacheAdmin({ action: 'export', host: 'sxyprn.net' });
  assert.equal(exp.ok, true);
  assert.ok(exp.entries[testUrl]);

  const clr = await bg.nvsCacheAdmin({ action: 'clear', host: 'sxyprn.net' });
  assert.equal(clr.ok, true);
  assert.equal(clr.removed, 1);

  const statsAfter = await bg.nvsCacheAdmin({ action: 'stats', host: 'sxyprn.net' });
  assert.equal(statsAfter.count, 0);
});

test('SxyPrn card URL resolver and HUD retry controls in content.js', () => {
  const contentCode = fs.readFileSync('extensions/nexus-video-selector/content.js', 'utf8');

  // 1. isSxyprnPage existuje a filtruje sxyprn doménu
  assert.match(contentCode, /function isSxyprnPage\(\)/);

  // 2. computeVideoUrlFromCard prioritizuje natívny /post/ odkaz pred externými linkami (vidara.so v .post_text)
  assert.match(contentCode, /if \(isSxyprnPage\(\)\) \{\s*const postLink = card\.matches\?\.\('a\[href\*="\/post\/"\]'\) \? card : card\.querySelector\('a\[href\*="\/post\/"\]'\);/);

  // 3. getVideoUrlFromCard čistí neplatné zakešované externé adresy bez /post/
  assert.match(contentCode, /if \(isSxyprnPage\(\) && !card\.dataset\.nvsUrl\.includes\('\/post\/'\)\)/);

  // 4. retryMissingCards čistí staré externé URL a podporuje HUD tlačidlo aj panel
  assert.match(contentCode, /const hudBtn = document\.getElementById\('nvs-hud-btn-retry'\);/);
  assert.match(contentCode, /const barBtn = document\.getElementById\('nvs-retry-missing'\);/);
  assert.match(contentCode, /window\.__nvsRetryMissing = \(\) => retryMissingCards\(document\.getElementById\('nvs-hud-btn-retry'\) \|\| document\.getElementById\('nvs-retry-missing'\)\);/);
});

test('SxyPrn bimbo.html cards resolve all 30 canonical /post/ URLs', () => {
  const bimboHtml = Array.from({ length: 30 }, (_, index) =>
    `<div class='post_el_small'><a href='/post/test${index + 1}?page=1'>Video ${index + 1}</a></div>`
  ).join('');
  const cardBlocks = bimboHtml.split("<div class='post_el_small'>").slice(1);
  assert.equal(cardBlocks.length, 30, 'Should have exactly 30 cards in bimbo.html');

  const resolvedUrls = [];
  for (const block of cardBlocks) {
    const postMatch = block.match(/href=['"](\/post\/[a-z0-9]+(?:\?[^'"]*)?)['"]/i);
    assert.ok(postMatch, 'Card must contain /post/ link');
    const u = new URL(postMatch[1], 'https://www.sxyprn.net');
    u.search = '';
    u.hash = '';
    resolvedUrls.push(u.href);
    assert.match(u.href, /^https:\/\/www\.sxyprn\.net\/post\/[a-z0-9]+$/);
    assert.equal(u.hostname, 'www.sxyprn.net');
  }
  assert.equal(resolvedUrls.length, 30);
  assert.equal(new Set(resolvedUrls).size, 30, 'All 30 cards should have unique canonical post URLs');
});

test('Scan HUD panel visibility and continuous data hydration', () => {
  const stylesCode = fs.readFileSync('extensions/nexus-video-selector/styles.css', 'utf8');
  const hudCode = fs.readFileSync('extensions/nexus-video-selector/scan-hud.js', 'utf8');

  // 1. Panel je v styles.css predvolene skrytý a otvára sa cez .nvs-hud-open
  assert.match(stylesCode, /#nvs-scan-hud-panel\s*\{[\s\S]*?display:\s*none\s*!important;/);
  assert.match(stylesCode, /#nvs-scan-hud-panel\.nvs-hud-open\s*\{[\s\S]*?display:\s*flex\s*!important;/);

  // 2. scan-hud.js prepína triedu nvs-hud-open a pamätá stav v localStorage
  assert.match(hudCode, /panel\.classList\.add\('nvs-hud-open'\);/);
  assert.match(hudCode, /panel\.classList\.remove\('nvs-hud-open'\);/);
  assert.match(hudCode, /localStorage\.getItem\('nvs-hud-open'\)/);

  // 3. Panel dáta sa aktualizujú vždy (bez predčasného returnu), takže pri otvorení nie sú nulové
  assert.doesNotMatch(hudCode, /if \(!isOpen \|\| !panel\) return;/);
  assert.match(hudCode, /if \(!panel\) return;/);
  assert.match(hudCode, /window\.__nvsUpdateHud = updateHudUi;/);
});

