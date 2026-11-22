import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = { module: { exports: {} }, URL, Date, Math, Set, Map, Number, String, Array, Object, Boolean };
vm.runInNewContext(
  fs.readFileSync(path.join(root, 'userscripts/findr-nexus-manager.user.js'), 'utf8'),
  context
);
const fnm = context.module.exports;

test('Findr pure helpers, merging, deduplication, filtering and M3U8 export', () => {
  assert.equal(fnm.extractAlbumId('https://findr.to/albums/12345/'), '12345');
  assert.equal(fnm.extractAlbumId('/albums/98765?page=2'), '98765');
  assert.equal(fnm.canonicalUrl('https://bunkr.cr/f/abc123/#frag'), 'https://bunkr.cr/f/abc123');

  assert.equal(fnm.classifyMediaType('clip_1080p.mp4', 'https://bunkr.cr/f/xyz'), 'video');
  assert.equal(fnm.classifyMediaType('photo.webp', 'https://bunkr.cr/f/img'), 'image');
  assert.equal(fnm.classifyMediaType('Stream', 'https://turbo.cr/v/AbCdEf'), 'video');
  assert.equal(fnm.classifyMediaType('archive.zip', 'https://bunkr.cr/f/zip'), 'other');

  assert.equal(fnm.detectProvider('https://turbo.cr/v/abc', ''), 'turbo');
  assert.equal(fnm.detectProvider('https://bunkr.cr/f/abc', ''), 'bunkr');
  assert.equal(fnm.detectProvider('https://pixeldrain.com/u/123', ''), 'pixeldrain');

  assert.equal(fnm.parseSizeToBytes('1.5 GB'), Math.round(1.5 * 1000 ** 3));
  assert.equal(fnm.parseSizeToBytes('250 MiB'), 250 * 1024 ** 2);

  const albumEntry = fnm.normalizeFindrAlbumEntry({
    id: 42,
    name: 'Bimbo Mix',
    original_url: 'https://bunkrr.pics/a/BimboMix/',
    file_count: 18,
    folder_size_bytes: 341150000,
    thumbnails: ['https://cdn.example/1.jpg'],
  });
  assert.equal(albumEntry.albumId, '42');
  assert.equal(albumEntry.findrUrl, 'https://findr.to/albums/42');
  assert.equal(albumEntry.provider, 'bunkr');

  const va = fnm.createVirtualAlbum('Test Zlúčený');
  const metaA = { albumId: '42', title: 'Bimbo Mix', sourceKey: 'album:42', provider: 'bunkr', sourceUrl: 'https://bunkrr.pics/a/BimboMix' };
  const metaB = { albumId: '77', title: 'Turbo Drop', sourceKey: 'album:77', provider: 'turbo', sourceUrl: 'https://turbo.cr/a/drop' };

  const res1 = fnm.mergeItemsIntoAlbum(va, [
    { source_link: 'https://bunkr.cr/f/vid1', filename: 'alpha_1080p.mp4', file_size_bytes: 500_000_000, created_at: '2026-10-01T10:00:00Z' },
    { source_link: 'https://bunkr.cr/f/img1', filename: 'cover.jpg', file_size_bytes: 2_000_000, created_at: '2026-10-02T10:00:00Z' },
  ], metaA);
  assert.equal(res1.added, 2);
  assert.equal(res1.skipped, 0);

  const res2 = fnm.mergeItemsIntoAlbum(va, [
    { source_link: 'https://bunkr.cr/f/vid1/', filename: 'alpha_1080p.mp4', duration: 900, height: 1080 },
    { source_link: 'https://turbo.cr/v/turb1', filename: 'beta_4k.mp4', file_size_bytes: 1_200_000_000, duration: 1500, height: 2160, created_at: '2026-10-05T10:00:00Z' },
  ], metaB);
  assert.equal(res2.added, 1);
  assert.equal(res2.skipped, 1);
  assert.equal(va.items.length, 3);
  assert.equal(va.sources.length, 2);
  assert.equal(va.items.find((i) => i.key === 'https://bunkr.cr/f/vid1').duration, 900);

  const onlyVideos = fnm.filterAndSortItems(va.items, { mediaType: 'video', minHeight: 1080 }, 'sizeDesc');
  assert.equal(onlyVideos.length, 2);
  assert.equal(onlyVideos[0].key, 'https://turbo.cr/v/turb1');

  const onlyTurbo = fnm.filterAndSortItems(va.items, { provider: 'turbo' }, 'newest');
  assert.equal(onlyTurbo.length, 1);
  assert.equal(onlyTurbo[0].title, 'beta_4k.mp4');

  const m3u8 = fnm.buildM3U8Playlist(onlyVideos);
  assert.match(m3u8, /^#EXTM3U/m);
  assert.match(m3u8, /#EXTINF:1500,beta_4k\.mp4/);
  assert.match(m3u8, /https:\/\/turbo\.cr\/v\/turb1/);

  fnm.removeSourceFromAlbum(va, 'album:42');
  assert.equal(va.items.length, 1);
  assert.equal(va.sources.length, 1);
  assert.equal(va.sources[0].sourceKey, 'album:77');

  // Slug matching & metadata patching
  const va2 = fnm.createVirtualAlbum('Meta Match');
  fnm.mergeItemsIntoAlbum(va2, [
    { source_link: 'https://bunkrr.su/f/SlugXYZ', filename: 'SlugXYZ' },
  ]);
  const matched = fnm.findAlbumItemByUrl(va2, 'https://bunkr.cr/f/SlugXYZ');
  assert.ok(matched, 'findAlbumItemByUrl should match mirror domain by provider + slug');
  fnm.applyFetchedMetadata(matched, {
    duration: 315,
    width: 1920,
    height: 1080,
    size_bytes: 420_000_000,
    type: 'video',
    storyboard_url: 'https://i-scdn.bunkr.cr/hd/SlugXYZ.jpg',
    stream_url: 'https://cdn.bunkr.cr/SlugXYZ.mp4',
  });
  assert.equal(matched.mediaType, 'video');
  assert.equal(matched.duration, 315);
  assert.equal(matched.quality, '1080p');
  assert.equal(matched.storyboardUrl, 'https://i-scdn.bunkr.cr/hd/SlugXYZ.jpg');
  assert.equal(matched.thumbnail, '');
});

test('Duplicate review preserves metadata and can restore removed copies', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://findr.to/**', (route) => route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
    await page.goto('https://findr.to/');
    const album = fnm.createVirtualAlbum('Duplicates');
    fnm.mergeItemsIntoAlbum(album, [
      { source_link: 'https://bunkr.cr/f/small', filename: 'A long unique example 1080p.mp4', duration: 120, file_size_bytes: 100, thumbnail: 'https://findr.to/thumbnail.jpg', height: 1080 },
      { source_link: 'https://bunkr.cr/f/large', filename: 'A long unique example 1080p.mp4', duration: 120, file_size_bytes: 200, height: 1080 },
      { source_link: 'https://bunkr.cr/f/different', filename: 'A long unique example 1080p.mp4', duration: 400, file_size_bytes: 300, height: 1080 },
      { source_link: 'https://bunkr.cr/f/other', filename: 'Different recording.mp4', duration: 120, file_size_bytes: 100 },
    ]);
    album.selectedIds = ['https://bunkr.cr/f/small'];
    album.reviewedIds = ['https://bunkr.cr/f/small'];
    assert.equal(fnm.findDuplicateGroups(album.items).length, 1);
    await page.evaluate((album) => localStorage.setItem('fnm_store_v2', JSON.stringify({ activeAlbumId: album.id, albums: [album] })), album);
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'userscripts/findr-nexus-manager.user.js'), 'utf8') });
    await page.locator('[data-dock="album-btn"]').click();
    await page.locator('[data-ws-act="duplicates"]').click();
    await page.locator('.fnm-duplicate-group').first().waitFor({ timeout: 5000 });
    assert.equal(await page.locator('.fnm-duplicate-group').count(), 1);
    assert.match(await page.locator('.fnm-duplicate-item').first().textContent(), /200 B/);
    await page.locator('[data-dup-enabled="0"]').check();
    await page.locator('[data-dup-remove]').click();
    let stored = await page.evaluate(() => JSON.parse(localStorage.getItem('fnm_store_v2')).albums[0]);
    assert.equal(stored.items.length, 3);
    const kept = stored.items.find((item) => item.key.endsWith('/large'));
    assert.equal(kept.thumbnail, 'https://findr.to/thumbnail.jpg');
    assert.ok(stored.selectedIds.includes(kept.key));
    assert.ok(stored.reviewedIds.includes(kept.key));
    await page.locator('[data-dup-undo]').click();
    stored = await page.evaluate(() => JSON.parse(localStorage.getItem('fnm_store_v2')).albums[0]);
    assert.equal(stored.items.length, 4);
    assert.ok(stored.selectedIds.includes('https://bunkr.cr/f/small'));
  } finally { await browser.close(); }
});

test('Duplicate review compares images with different names and missing durations', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 120, height: 120 } });
    await page.setContent('<div style="width:120px;height:120px;background:linear-gradient(135deg,red 20%,black 20%,black 40%,white 40%,white 60%,blue 60%,blue 80%,yellow 80%)"></div>');
    const png = await page.screenshot();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.route('https://findr.to/**', (route) => route.request().url().endsWith('.png') ? route.fulfill({ contentType: 'image/png', body: png }) : route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
    await page.goto('https://findr.to/');
    const album = fnm.createVirtualAlbum('Visual duplicates');
    fnm.mergeItemsIntoAlbum(album, [
      { source_link: 'https://bunkr.cr/f/one', filename: 'DA8F03~1.MP4', file_size_bytes: 1500000000, thumbnail: 'https://findr.to/a.png' },
      { source_link: 'https://bunkr.cr/f/two', filename: 'DAMION~4.MP4', file_size_bytes: 1510000000, thumbnail: 'https://findr.to/b.png' },
      { source_link: 'https://bunkr.cr/f/three', filename: 'different.mp4', file_size_bytes: 900000000, thumbnail: 'https://findr.to/b.png' },
    ]);
    await page.evaluate((album) => localStorage.setItem('fnm_store_v2', JSON.stringify({ activeAlbumId: album.id, albums: [album] })), album);
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'userscripts/findr-nexus-manager.user.js'), 'utf8') });
    await page.locator('[data-dock="album-btn"]').click();
    await page.locator('[data-ws-act="duplicates"]').click();
    await page.locator('.fnm-duplicate-group').waitFor();
    assert.equal(await page.locator('.fnm-duplicate-item').count(), 2);
    assert.equal(await page.locator('[data-dup-enabled="0"]').isChecked(), false);
  } finally { await browser.close(); }
});

test('Broken HD thumbnails fall back to the original image in grid and list', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://findr.to/**', (route) => {
      const url = route.request().url();
      if (url.endsWith('/broken.jpg')) return route.fulfill({ status: 404, body: 'missing' });
      if (url.endsWith('/original.png')) return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXcAAAAASUVORK5CYII=', 'base64') });
      return route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' });
    });
    await page.goto('https://findr.to/');
    const album = fnm.createVirtualAlbum('Fallback');
    fnm.mergeItemsIntoAlbum(album, [{ source_link: 'https://bunkr.cr/f/test', filename: 'test.mp4', thumbnail: 'https://findr.to/original.png', storyboard_url: 'https://findr.to/broken.jpg' }]);
    await page.evaluate((album) => localStorage.setItem('fnm_store_v2', JSON.stringify({ activeAlbumId: album.id, albums: [album] })), album);
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'userscripts/findr-nexus-manager.user.js'), 'utf8') });
    await page.locator('[data-dock="album-btn"]').click();
    await page.waitForFunction(() => { const img = document.querySelector('.fnm-ws-thumb img'); return img?.src.endsWith('/original.png') && img.complete && img.naturalWidth > 0; });
    await page.locator('[data-ws-layout="list"]').click();
    await page.waitForFunction(() => { const img = document.querySelector('.fnm-ws-row-thumb img'); return img?.src.endsWith('/original.png') && img.complete && img.naturalWidth > 0; });
  } finally {
    await browser.close();
  }
});

test('Workspace filters multiple source albums together', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://findr.to/**', (route) => route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
    await page.goto('https://findr.to/');
    const album = fnm.createVirtualAlbum('Sources');
    for (const id of ['1', '2', '3']) {
      fnm.mergeItemsIntoAlbum(album, [{ source_link: `https://bunkr.cr/f/item${id}`, filename: `video${id}.mp4`, created_at: id === '1' ? '2026-10-01T10:00:00Z' : '' }], { albumId: id, title: `Album ${id}`, sourceKey: `album:${id}` });
    }
    await page.evaluate((album) => localStorage.setItem('fnm_store_v2', JSON.stringify({ activeAlbumId: album.id, albums: [album] })), album);
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'userscripts/findr-nexus-manager.user.js'), 'utf8') });
    await page.locator('[data-dock="album-btn"]').click();
    assert.equal(await page.getByText('Nahrané: 1. 10. 2026').count(), 1);
    assert.equal(await page.getByText('Dátum nahratia: neznámy').count(), 2);
    await page.locator('[data-ws-layout="list"]').click();
    assert.equal(await page.locator('.fnm-ws-row .fnm-ws-date').count(), 3);
    assert.equal(await page.getByText('Nahrané: 1. 10. 2026').count(), 1);
    await page.locator('[data-ws-layout="grid"]').click();
    const source = (id) => page.locator(`[data-ws-source="album:${id}"]`);
    await source('1').click();
    assert.equal(await page.locator('.fnm-ws-card').count(), 1);
    await source('2').click();
    assert.equal(await page.locator('.fnm-ws-card').count(), 2);
    assert.equal(await source('1').getAttribute('aria-pressed'), 'true');
    assert.equal(await source('2').getAttribute('aria-pressed'), 'true');
    await source('1').click();
    assert.equal(await page.locator('.fnm-ws-card').count(), 1);
    await page.locator('[data-ws-source="all"]').click();
    assert.equal(await page.locator('.fnm-ws-card').count(), 3);
  } finally {
    await browser.close();
  }
});

test('Workspace selection keeps the scrolled cards in place', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.route('https://findr.to/**', (route) => route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
    await page.goto('https://findr.to/');
    const album = fnm.createVirtualAlbum('Scroll test');
    fnm.mergeItemsIntoAlbum(album, Array.from({ length: 100 }, (_, i) => ({ source_link: `https://bunkr.cr/f/item${i}`, filename: `video${i}.mp4` })));
    await page.evaluate((album) => localStorage.setItem('fnm_store_v2', JSON.stringify({ activeAlbumId: album.id, albums: [album] })), album);
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'userscripts/findr-nexus-manager.user.js'), 'utf8') });
    await page.locator('[data-dock="album-btn"]').click();
    const content = page.locator('.fnm-ws-content');
    await content.evaluate((el) => { el.scrollTop = 1600; });
    const checkbox = page.locator('[data-ws-check]').nth(24);
    await checkbox.scrollIntoViewIfNeeded();
    const before = await content.evaluate((el) => { window.__card = el.querySelectorAll('[data-ws-check]')[24].closest('[data-fnm-item-key]'); return el.scrollTop; });
    assert.ok(before > 0);
    await checkbox.check();
    assert.equal(await content.evaluate((el) => el.scrollTop), before);
    assert.equal(await page.evaluate(() => window.__card.isConnected), true);
    assert.match(await page.locator('.fnm-ws-footer-info').textContent(), /Vybrané:\s*1/);
    await checkbox.uncheck();
    assert.equal(await content.evaluate((el) => el.scrollTop), before);
    const card = page.locator('.fnm-ws-card').nth(24);
    await card.locator('.fnm-ws-title').click({ modifiers: ['Control'] });
    assert.equal(await checkbox.isChecked(), true);
    assert.equal(await content.evaluate((el) => el.scrollTop), before);
    await page.locator('.fnm-ws-card').nth(25).locator('.fnm-ws-title').click({ modifiers: ['Control'] });
    assert.match(await page.locator('.fnm-ws-footer-info').textContent(), /Vybrané:\s*2/);
    await card.locator('.fnm-ws-title').click({ modifiers: ['Control'] });
    assert.equal(await checkbox.isChecked(), false);
    assert.match(await page.locator('.fnm-ws-footer-info').textContent(), /Vybrané:\s*1/);
    await page.locator('[data-ws-layout="list"]').click();
    await page.locator('.fnm-ws-row').first().locator('.fnm-ws-title').click({ modifiers: ['Control'] });
    assert.equal(await page.locator('.fnm-ws-row').first().locator('[data-ws-check]').isChecked(), true);
  } finally {
    await browser.close();
  }
});

test('Findr integration contracts across scripts and extension manifest', () => {
  const fnmSource = fs.readFileSync(path.join(root, 'userscripts/findr-nexus-manager.user.js'), 'utf8');
  const splitSource = fs.readFileSync(path.join(root, 'userscripts/nexus-universal-splitscreen.user.js'), 'utf8');
  const bswSource = fs.readFileSync(path.join(root, 'userscripts/bunkrr-search-workbench.user.js'), 'utf8');
  const nvsManifest = JSON.parse(fs.readFileSync(path.join(root, 'extensions/nexus-video-selector/manifest.json'), 'utf8'));

  assert.match(fnmSource, /@match\s+https:\/\/findr\.to\/\*/);
  assert.match(fnmSource, /nexus-findr-split-open/);
  assert.match(fnmSource, /nexus-findr-split-picker/);
  assert.match(fnmSource, /\/api\/v1\/intake\/import/);
  assert.match(fnmSource, /\/api\/v1\/discovery-hub\/refetch-meta/);

  assert.match(splitSource, /function isFindr\(host\)/);
  assert.match(splitSource, /function harvestFindrCards\(\)/);
  assert.match(splitSource, /nexus-findr-split-open/);
  assert.match(splitSource, /nexus-findr-split-picker/);
  assert.match(splitSource, /dataset\.nexusFindrSplitReady\s*=\s*'1'/);

  assert.match(bswSource, /dataset\.nexusFindrManager\s*===\s*'1'/);
  assert.ok(nvsManifest.content_scripts[0].exclude_matches.includes('https://findr.to/*'));
});

test('Playwright browser fixture: album & file card selectors, virtual album merge, workspace & splitscreen handoff', async () => {
  const fnmSource = fs.readFileSync(path.join(root, 'userscripts/findr-nexus-manager.user.js'), 'utf8');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.route('https://findr.to/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/api/albums/101')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            name: 'Bimbo Turbo Pack',
            original_url: 'https://turbo.cr/a/101',
            total_pages: 1,
            file_count: 2,
            folder_size_bytes: 1_500_000_000,
            files: [
              { source_link: 'https://turbo.cr/v/t1', filename: 'bimbo_one.mp4', file_size_bytes: 900_000_000, thumbnail_path: '', created_at: '2026-11-01T10:00:00Z' },
              { source_link: 'https://turbo.cr/v/t2', filename: 'bimbo_two.mp4', file_size_bytes: 600_000_000, thumbnail_path: '', created_at: '2026-11-02T10:00:00Z' },
            ],
          }),
        });
      }
      if (url.includes('/search?q=bimbo&view=files')) {
        return route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html><html><body class="bg-slate-950 text-white"><main>
            <div class="grid">
              <div class="group"><a href="https://bunkr.cr/f/f999"><h3>solo_clip.mp4</h3></a><span>450 MB</span><span>Bunkr</span></div>
              <div class="group"><a href="https://turbo.cr/v/v888"><h3>turbo_clip.mp4</h3></a><span>720 MB</span><span>Turbo</span></div>
            </div>
          </main></body></html>`,
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><body class="bg-slate-950 text-white"><main>
          <div class="grid">
            <div class="group"><a href="/albums/101"><h3>Bimbo Turbo Pack</h3></a><a href="https://turbo.cr/a/101">Turbo</a><span>2 files · 1.46 GB</span></div>
            <div class="group"><a href="/albums/202"><h3>Bimbo Bunkr Set</h3></a><a href="https://bunkr.cr/a/202">Bunkr</a><span>12 files · 1.17 GB</span></div>
          </div>
        </main></body></html>`,
      });
    });

    // 1. Test Search Albums page
    await page.goto('https://findr.to/search?q=bimbo');
    await page.addScriptTag({ content: fnmSource });

    await page.waitForSelector('.fnm-card .fnm-check-pill');
    const albumCardsCount = await page.locator('.fnm-card[data-fnm-card-type="album"]').count();
    assert.equal(albumCardsCount, 2);

    // Select first album and merge into Virtual Album
    await page.locator('.fnm-card[data-fnm-card-type="album"]').first().locator('.fnm-card-check').check();
    await page.locator('[data-dock="add-selected"]').click();
    await page.waitForFunction(() => document.querySelector('[data-dock="album-btn"]')?.textContent?.includes('(2)'));

    // Open Workspace & verify merged files + Split-Screen event dispatch
    await page.evaluate(() => {
      window.__splitDispatched = null;
      document.documentElement.dataset.nexusFindrSplitReady = '1';
      document.addEventListener('nexus-findr-split-open', (e) => {
        window.__splitDispatched = JSON.parse(e.detail);
      });
    });
    await page.locator('[data-dock="album-btn"]').click();
    await page.waitForSelector('#fnm-workspace:not([hidden]) .fnm-ws-card');
    assert.equal(await page.locator('.fnm-ws-card').count(), 2);

    await page.locator('[data-ws-act="split-open"]').click();
    const dispatched = await page.evaluate(() => window.__splitDispatched);
    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[0].watchUrl, 'https://turbo.cr/v/t2');
    assert.equal(dispatched[1].watchUrl, 'https://turbo.cr/v/t1');

    // Close workspace and verify Quick Peek drawer on second album card
    await page.locator('[data-ws-act="close"]').click();
    await page.locator('.fnm-card[data-fnm-card-type="album"]').first().locator('button[title*="Quick Peek"]').click();
    await page.waitForSelector('#fnm-peek:not([hidden]) .fnm-peek-item');
    assert.equal(await page.locator('#fnm-peek .fnm-peek-item').count(), 2);

    // 2. Test Search Files page (?view=files)
    await page.goto('https://findr.to/search?q=bimbo&view=files');
    await page.addScriptTag({ content: fnmSource });
    await page.waitForSelector('.fnm-card[data-fnm-card-type="file"]');
    assert.equal(await page.locator('.fnm-card[data-fnm-card-type="file"]').count(), 2);
    // Virtual album persisted across navigation!
    assert.match(await page.locator('[data-dock="album-btn"]').textContent(), /\(2\)/);

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Playwright browser fixture: Deep Fetch and HD Thumbs update Bunkr + Turbo cards in Workspace', async () => {
  const fnmSource = fs.readFileSync(path.join(root, 'userscripts/findr-nexus-manager.user.js'), 'utf8');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.route('https://findr.to/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/api/albums/505')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            name: 'Mixed Pack',
            original_url: 'https://bunkr.cr/a/505',
            total_pages: 1,
            file_count: 2,
            files: [
              { source_link: 'https://bunkr.cr/f/bunkr01', filename: 'bunkr_no_ext', thumbnail_path: '', created_at: '2026-11-01T10:00:00Z' },
              { source_link: 'https://turbo.cr/v/turbo01', filename: 'turbo_clip.mp4', thumbnail_path: '', created_at: '2026-11-02T10:00:00Z' },
            ],
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><body><main><div class="group"><a href="/albums/505"><h3>Mixed Pack</h3></a></div></main></body></html>`,
      });
    });

    await page.route('http://localhost:8000/**', async (route) => {
      const url = route.request().url();
      if (url.endsWith('/health')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'healthy', service: 'Nexus Pokrok API' }) });
      }
      if (url.endsWith('/api/v1/discovery-hub/fetch-hd-thumbs')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/x-ndjson',
          body: JSON.stringify({
            type: 'patch',
            url: 'https://bunkr.cr/f/bunkr01',
            data: { storyboard_url: 'https://findr.to/mock-hd-bunkr01.jpg', hd_ready: true },
          }) + '\n' + JSON.stringify({ type: 'done', total: 1, found: 1 }) + '\n',
        });
      }
      if (url.endsWith('/api/v1/discovery-hub/refetch-meta')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/x-ndjson',
          body: JSON.stringify({
            type: 'patch',
            url: 'https://bunkr.cr/f/bunkr01',
            ok: true,
            data: { type: 'video', duration: 125, height: 1080, width: 1920, quality: '1080p', size_bytes: 250_000_000 },
          }) + '\n' + JSON.stringify({ type: 'done' }) + '\n',
        });
      }
      if (url.endsWith('/api/tester/batch-meta')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            results: [{
              url: 'https://turbo.cr/v/turbo01',
              ok: true,
              duration: 420,
              height: 2160,
              width: 3840,
              quality: '4K',
              size_bytes: 950_000_000,
              thumbnail: 'https://findr.to/mock-turbo01.jpg',
              stream_url: 'https://cdn1.turbocdn.st/turbo01.mp4',
            }],
          }),
        });
      }
      return route.fulfill({ status: 404, body: '{}' });
    });

    await page.goto('https://findr.to/search?q=mixed');
    await page.addScriptTag({ content: fnmSource });
    await page.waitForSelector('.fnm-card[data-fnm-card-type="album"]');
    await page.locator('.fnm-card .fnm-qbtn-add').click();
    await page.waitForFunction(() => document.querySelector('[data-dock="album-btn"]')?.textContent?.includes('(2)'));

    await page.locator('[data-dock="album-btn"]').click();
    await page.waitForSelector('#fnm-workspace:not([hidden]) .fnm-ws-card');

    // Run HD Thumbs
    await page.locator('[data-ws-act="hd-thumbs"]').click();
    await page.waitForFunction(() =>
      document.querySelector('[data-fnm-item-key="https://bunkr.cr/f/bunkr01"] img')?.getAttribute('src') === 'https://findr.to/mock-hd-bunkr01.jpg'
      && document.querySelector('[data-fnm-item-key="https://turbo.cr/v/turbo01"] img')?.getAttribute('src') === 'https://findr.to/mock-turbo01.jpg'
    );

    // Run Deep Fetch
    await page.locator('[data-ws-act="deep-fetch"]').click();
    await page.waitForFunction(() =>
      document.querySelector('[data-fnm-item-key="https://bunkr.cr/f/bunkr01"] .fnm-ws-dur')?.textContent === '2:05'
      && document.querySelector('[data-fnm-item-key="https://turbo.cr/v/turbo01"] .fnm-ws-q')?.textContent === '4K'
    );
    const progressText = await page.locator('[data-progress-meta]').textContent();
    assert.match(progressText || '', /⏱ \d+:\d{2} · 2 \/ 2 \(100%\)/);

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
