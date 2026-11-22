import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';

const radarVmCtx = { module: { exports: {} }, URL, Set, Map, Number, String, Array, Object, Boolean };
vm.runInNewContext(
    fs.readFileSync('userscripts/nexus-vault-radar.user.js', 'utf8'),
    radarVmCtx
);
const radarScript = radarVmCtx.module.exports;

const indexHtml = fs.readFileSync('app/templates/index.html', 'utf8');
const modalHtml = fs.readFileSync('app/templates/partials/creator_radar_modal.html', 'utf8');
const creatorRadarJs = fs.readFileSync('app/static/modules/creator_radar.js', 'utf8');
const hybridJs = fs.readFileSync('app/static/dashboard_hybrid.js', 'utf8');
const obsidianCss = fs.readFileSync('app/static/obsidian_glass.css', 'utf8');

test('nexus-vault-radar userscript pure helpers normalize URLs, detect creator queries and build vault links', () => {
    assert.equal(
        radarScript.canonicalUrl('/watch/abc-1#player', 'https://example.com/models/milan'),
        'https://example.com/watch/abc-1'
    );
    assert.equal(radarScript.canonicalUrl('javascript:void(0)'), '');

    assert.equal(
        radarScript.cleanCreatorCandidate('Milan Cheek - Full Video | Eporner'),
        'Milan Cheek'
    );

    const mockDoc = {
        title: 'Fallback Title | Pornhub',
        querySelector: (sel) => (sel === 'h1' ? { textContent: '  Amirah Adara | Eporner  ' } : null),
        querySelectorAll: () => [
            { getAttribute: () => '/v/milan-123#top', textContent: 'Milan Scene' },
            { getAttribute: () => '/v/milan-123/', textContent: 'Duplicate Link' },
            { getAttribute: () => 'https://bunkr.cr/v/clip-9', textContent: 'Bunkr Clip' },
        ],
    };
    const mockWin = { getSelection: () => '  Selected Model  ' };
    assert.equal(radarScript.detectActiveQuery(mockDoc, mockWin), 'Selected Model');
    assert.equal(radarScript.detectActiveQuery(mockDoc, {}), 'Amirah Adara');

    const cands = radarScript.collectPageCandidates(mockDoc, 'https://example.com/home', 10);
    assert.equal(cands.length, 2);
    assert.equal(cands[0].url, 'https://example.com/v/milan-123');
    assert.equal(cands[1].url, 'https://bunkr.cr/v/clip-9');

    assert.equal(
        radarScript.buildVaultLink('http://127.0.0.1:8010/', 'Milan Cheek'),
        'http://127.0.0.1:8010/vault?q=Milan%20Cheek'
    );
});

test('nexus-vault-radar Chrome MV3 extension files and manifest are complete', () => {
    const extDir = path.join('extensions', 'nexus-vault-radar');
    for (const file of ['manifest.json', 'background.js', 'content.js', 'content.css', 'popup.html', 'popup.js']) {
        assert.ok(fs.existsSync(path.join(extDir, file)), `missing ${file}`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.background.service_worker, 'background.js');
    assert.equal(manifest.action.default_popup, 'popup.html');
    const bg = fs.readFileSync(path.join(extDir, 'background.js'), 'utf8');
    assert.match(bg, /\/api\/v1\/companion\/probe/);
    assert.match(bg, /\/api\/v1\/companion\/follow/);
});

test('dashboard wires Creator Radar & Vault Dossier rail entry, shortcut, modal and Obsidian Glass styling', () => {
    const railHtml = fs.readFileSync('app/templates/partials/nx_rail.html', 'utf8');
    assert.match(indexHtml, /\/static\/modules\/creator_radar\.js/);
    assert.match(indexHtml, /include "partials\/nx_rail\.html"/);
    assert.match(railHtml, /data-tooltip="Creator Radar \(Ctrl\+Shift\+R\)"/);
    assert.match(indexHtml, /partials\/creator_radar_modal\.html/);
    assert.match(modalHtml, /id="creatorRadarOverlay"/);
    assert.match(modalHtml, /id="cradarResultsGrid"/);
    assert.match(creatorRadarJs, /\/api\/v1\/radar\/creators/);
    assert.match(creatorRadarJs, /\/api\/v1\/radar\/dossier/);
    assert.match(creatorRadarJs, /\/api\/vault\/import/);
    assert.match(hybridJs, /key === 'r'/);
    assert.match(obsidianCss, /\.cradar-overlay/);
    assert.match(obsidianCss, /body\.perf-lite \.cradar-shell/);

    // Filter, Sort, Selectors, Split-Screen & Inline Playback contracts
    assert.match(modalHtml, /id="cradarSortSelect"/);
    assert.match(modalHtml, /id="cradarMinQualSelect"/);
    assert.match(modalHtml, /id="cradarMinDurSelect"/);
    assert.match(modalHtml, /id="cradarSourceSelect"/);
    assert.match(modalHtml, /id="cradarSplitBtn"/);
    assert.match(modalHtml, /id="cradarImportSelectedBtn"/);
    assert.match(modalHtml, /id="cradarPlayerOverlay"/);
    assert.match(creatorRadarJs, /nexus-album-split-picker/);
    assert.match(creatorRadarJs, /data-nexus-split-stream/);
    assert.match(creatorRadarJs, /nuss-page-selected/);
    assert.match(creatorRadarJs, /getFilteredSortedItems/);
    assert.match(creatorRadarJs, /\/api\/v1\/stream\/xhamster\//);
    assert.match(obsidianCss, /\.cradar-player-overlay/);
});
