// Production UI functions with explicit local fixture providers; no external match claims.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
(async () => {
  const port = 20000 + process.pid % 20000;
  const fixture = spawn(process.env.PYTHON || 'python', [path.resolve('tests/quality_hunt_ui_preview.py')], {
    env: { ...process.env, QUALITY_HUNT_PREVIEW_PORT: String(port) },
    stdio: 'ignore',
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const previewUrl = process.env.QUALITY_HUNT_PREVIEW_URL || `http://127.0.0.1:${port}/`;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(previewUrl)).ok) break;
      } catch { }
      if (fixture.exitCode !== null) throw new Error(`Quality Hunt fixture exited with code ${fixture.exitCode}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!(await fetch(previewUrl)).ok) throw new Error('Quality Hunt fixture did not become ready.');
    await page.goto(previewUrl);
    await page.locator('.nexus-hunt-btn').click();
    const modal = page.locator('.nexus-hunt-modal');
    await modal.waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('.nexus-import-overlay')._huntRunning);
    await page.waitForFunction(() => !document.querySelector('.nexus-import-overlay')._huntFastBusy);
    assert.equal(await modal.locator('.nexus-hunt-card').count(), 3);
    assert.equal(await page.locator('.nexus-hunt-groups > .nexus-hunt-card').count(), 3);
    assert.equal(await page.locator('.nexus-hunt-relevance button').count(), 2);
    const firstGroupCard = page.locator('.nexus-hunt-groups > .nexus-hunt-card').first();
    assert.equal(await firstGroupCard.locator('.nh-corner-tl').count(), 1, 'quality corner shown when known');
    assert.equal(await firstGroupCard.locator('.nh-corner-tr').count(), 1, 'match corner shown');
    assert.equal(await firstGroupCard.locator('.nh-pb-dur').count(), 1, 'duration shown on preview when known');
    assert.ok(!(await firstGroupCard.innerText()).includes('?'), 'no ? placeholder badges on cards');
    assert.ok(await page.locator('input.nexus-hunt-visual').evaluate(e => e.getBoundingClientRect().width < 30), 'visual search checkbox keeps its native layout');
    const geometry = await modal.locator('.nexus-hunt-modal-card').boundingBox();
    assert.ok(geometry.width > 1000);
    assert.ok(Number(await modal.locator('.nexus-hunt-title').first().evaluate(e => parseFloat(getComputedStyle(e).fontSize))) >= 14);
    // Help drawer toggle
    await modal.locator('.nh-help-toggle').click();
    await modal.locator('#nh-help-drawer').waitFor({ state: 'visible' });
    assert.ok((await modal.locator('#nh-help-drawer').innerText()).includes('Režimy vyhľadávania'));
    await modal.locator('.nh-help-close').click();
    await modal.locator('#nh-help-drawer').waitFor({ state: 'hidden' });
    // Pill filters
    await modal.locator('.nh-pill[data-hunt-filter="same_clip"]').click();
    assert.equal(await modal.locator('.nexus-hunt-card').count(), 2);
    // Tech filter toggle & playable-only filter
    await modal.locator('.nh-tech-filters-toggle').click();
    await modal.locator('#nh-tech-filters').waitFor({ state: 'visible' });
    await modal.locator('.nh-only-playable').check();
    assert.equal(await modal.locator('.nexus-hunt-card').count(), 1);
    const singleCard = await modal.locator('.nexus-hunt-card').boundingBox();
    assert.ok(singleCard.width < 500, 'one result must retain a readable card width');
    await modal.locator('.nexus-hunt-reset-view').click();
    await modal.locator('.nh-tech-filters-toggle').click();
    await modal.locator('.nh-pill[data-hunt-filter="similar_all"]').click();
    assert.equal(await modal.locator('.nexus-hunt-card').count(), 1);
    assert.ok((await modal.locator('.nexus-hunt-card').first().innerText()).includes('Iné video'));
    await modal.locator('.nexus-hunt-tab-sources').click();
    await modal.locator('.nexus-hunt-workbench-sources').waitFor({ state: 'visible' });
    assert.ok((await modal.locator('.nexus-hunt-workbench-sources').innerText()).includes('Odlišné testovacie video'));
    await modal.locator('.nexus-hunt-tab-results').click();
    await modal.locator('.nh-pill[data-hunt-filter="all"]').click();
    assert.equal(await modal.locator('.nexus-hunt-card').count(), 4);
    assert.equal(await page.locator('.nexus-hunt-groups > .nexus-hunt-card').count(), 3);
    await modal.locator('.nh-pill[data-hunt-filter="same_clip"]').click();
    await modal.locator('.nexus-hunt-fast-fetch').click();
    await page.waitForFunction(() => !document.querySelector('.nexus-import-overlay')._huntFastBusy);
    const firstCard = modal.locator('.nexus-hunt-card').first();
    assert.ok((await firstCard.locator('.nexus-hunt-preview').innerText()).includes('10.0 MB'));
    assert.equal(await firstCard.locator('.nh-pb-dur').innerText(), '0:06');
    await firstCard.locator('.nexus-hunt-evidence summary').click();
    assert.equal(await firstCard.locator('.nexus-hunt-factor').count(), 4);
    const imageHeight = await firstCard.locator('.nexus-hunt-preview').evaluate(e => e.getBoundingClientRect().height);
    assert.ok(imageHeight > 140, `preview should be clear 16:9: ${imageHeight}`);
    const sourceUrl = await firstCard.getAttribute('data-hunt-url');
    await firstCard.locator('.nexus-hunt-import').click();
    const cardImport = await page.evaluate(() => window.__lastImportVideo);
    assert.equal(cardImport.streamUrl, `${new URL(sourceUrl).origin}/sample.webm?resolved=1`);
    assert.equal(cardImport.metadata.sourceUrl, sourceUrl);
    // Selection + Select All + Bulk Import All
    await modal.locator('.nh-select-all').click();
    assert.equal(await modal.locator('.nh-card-check:checked').count(), 2);
    assert.ok((await modal.locator('.nh-import-all').innerText()).includes('Import vybraných (1)'));
    await modal.locator('.nh-import-all').click();
    await page.waitForFunction(() => !document.querySelector('.nexus-import-overlay')._huntBulkImporting);
    assert.equal(await modal.locator('.nexus-hunt-card .nexus-hunt-import:has-text("Importované ✓")').count(), 2);
    await modal.locator('.nh-select-all').click();
    assert.equal(await modal.locator('.nh-card-check:checked').count(), 0);
    await page.screenshot({ path: path.resolve('.codex-test-tmp/quality-hunt-workbench-wide.png') });
    // Popup player (single video, no side-by-side comparison)
    await modal.locator('.nexus-hunt-play').first().click();
    await page.waitForFunction(() => document.querySelector('.nexus-hunt-modal-video')?.src.includes('sample.webm'));
    assert.equal(await modal.locator('.nexus-hunt-modal-stage video').count(), 1);
    assert.equal(await modal.locator('.nexus-hunt-original-video').count(), 0);
    assert.equal(await modal.locator('.nexus-hunt-modal-import').isDisabled(), true, 'an already imported result must not be imported twice');
    assert.equal(await modal.locator('.nexus-hunt-modal-import').innerText(), 'Importované ✓');
    const selected = await modal.locator('.nexus-hunt-card[aria-current="true"]').getAttribute('data-hunt-id');
    await page.locator('.nexus-hunt-modal-video').dispatchEvent('ended');
    assert.equal(await modal.isVisible(), true);
    assert.equal(await modal.locator('.nexus-hunt-card[aria-current="true"]').getAttribute('data-hunt-id'), selected);
    await page.screenshot({ path: path.resolve('.codex-test-tmp/quality-hunt-workbench-comparison.png') });
    await modal.locator('.nh-stage-close').click();
    await modal.locator('.nexus-hunt-modal-stage').waitFor({ state: 'hidden' });
    // Cross-source duplicate detection + Hide duplicates toggle
    await page.evaluate(() => {
      const owner = document.querySelector('.nexus-import-overlay');
      owner._huntCandidates = [
        { id: 'd1', url: 'https://porntrex.com/video/1', title: 'Same Scene Test 1080p', identity_state: 'confirmed', duration_sec: 120, height: 1080, availability_state: 'playable' },
        { id: 'd2', url: 'https://spankbang.com/video/2', title: 'Same Scene Test 720p', identity_state: 'confirmed', duration_sec: 121, height: 720, availability_state: 'playable' },
      ];
      owner._huntFilter = 'matches';
      renderHuntGroups(owner, {});
    });
    assert.equal(await modal.locator('.nexus-hunt-card').count(), 2);
    assert.ok((await modal.locator('.nh-dup-pill.is-primary').innerText()).includes('spankbang.com'));
    assert.ok((await modal.locator('.nh-dup-pill.is-secondary').innerText()).includes('Duplikát'));
    await modal.locator('.nh-hide-dups').check();
    assert.equal(await modal.locator('.nexus-hunt-card').count(), 1);
    await modal.locator('.nh-hide-dups').uncheck();
    await page.setViewportSize({ width: 420, height: 900 });
    const columns = await modal.locator('.nexus-hunt-modal-list').evaluate(e => getComputedStyle(e).gridTemplateColumns.split(' ').length);
    assert.equal(columns, 1);
    await page.screenshot({ path: path.resolve('.codex-test-tmp/quality-hunt-workbench-mobile.png') });
    await page.keyboard.press('Escape');
    assert.equal(await modal.isVisible(), false);
    await page.setViewportSize({ width: 1360, height: 1000 });
    await page.evaluate(() => {
      const owner = document.querySelector('.nexus-import-overlay');
      owner._huntCandidates = [
        { id: 'raw', url: 'https://example.test/raw', title: 'Iný klip s rovnakou dĺžkou', identity_state: 'unverified', duration_sec: 6, height: 2160 },
        { id: 'actor', url: 'https://example.test/actor', title: 'Ten istý tvorca – iná scéna', identity_state: 'related', duration_sec: 6, height: 1080 },
      ];
      owner._huntFilter = 'matches';
      owner._huntRunning = true;
      renderHuntGroups(owner, {});
    });
    assert.equal(await page.locator('.nexus-hunt-groups > .nexus-hunt-card').count(), 0);
    assert.ok((await page.locator('.nexus-hunt-groups .nexus-hunt-empty').innerText()).includes('Vyhľadávanie pokračuje'));
    assert.ok((await page.locator('.nexus-hunt-relevance strong').innerText()).includes('Overujem 2 prijatých kandidátov'));
    await page.evaluate(() => { const owner = document.querySelector('.nexus-import-overlay'); owner._huntRunning = false; renderHuntGroups(owner, {}); });
    assert.ok((await page.locator('.nexus-hunt-groups .nexus-hunt-empty').innerText()).includes('zatiaľ nepodarilo nájsť'));
    await page.locator('.nexus-hunt-relevance button').last().click();
    assert.equal(await modal.locator('.nexus-hunt-card').count(), 1);
    await page.screenshot({ path: path.resolve('.codex-test-tmp/quality-hunt-no-match.png') });
    await page.evaluate(() => {
      const owner = document.querySelector('.nexus-import-overlay');
      owner._huntCandidates = [
        { id: 'cut', url: 'https://different.test/cut', title: 'Coastal Walk – shorter cut', identity_state: 'variant', variant_kind: 'shorter', duration_sec: 4, height: 1080 },
        { id: 'similar', url: 'https://another.test/similar', title: 'Same creator – similar scene', identity_state: 'similar', duration_sec: 8, height: 720 },
      ];
      owner._huntFilter = 'matches';
      renderHuntGroups(owner, {});
    });
    assert.equal(await page.locator('.nexus-hunt-groups > .nexus-hunt-card').count(), 2);
    const shorterVersion = modal.locator('.nexus-hunt-card').filter({ hasText: 'shorter cut' });
    const shorterVersionText = await shorterVersion.evaluate(element => element.textContent);
    assert.ok(shorterVersionText.includes('Kratší zostrih'), shorterVersionText);
    const similarVersion = modal.locator('.nexus-hunt-card').filter({ hasText: 'similar scene' });
    assert.ok((await similarVersion.innerText()).includes('Podobná scéna'), await similarVersion.innerText());
    await page.screenshot({ path: path.resolve('.codex-test-tmp/quality-hunt-versions.png') });
    assert.deepEqual(errors, []);
    console.log('PASS: redesigned workbench pills, filters, sources, comparison stage, ended lifecycle, selection, mobile, Escape');
  } catch (error) {
    console.log(await page.evaluate(() => ({
      errors: document.querySelector('#toast')?.textContent,
      status: document.querySelector('.nexus-hunt-modal-status')?.textContent,
      video: {
        src: document.querySelector('.nexus-hunt-modal-video')?.src,
        error: document.querySelector('.nexus-hunt-modal-video')?.error?.message,
        readyState: document.querySelector('.nexus-hunt-modal-video')?.readyState
      },
      bodyError: window.__uiError
    })));
    await page.screenshot({ path: path.resolve('.codex-test-tmp/quality-hunt-workbench-error.png') });
    throw error;
  } finally { await browser.close(); fixture.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
