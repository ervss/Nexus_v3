import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const indexHtml = fs.readFileSync('app/templates/index.html', 'utf8');
const vaultHtml = fs.readFileSync('app/templates/vault.html', 'utf8');
const railHtml = fs.readFileSync('app/templates/partials/nx_rail.html', 'utf8');
const obsidianCss = fs.readFileSync('app/static/obsidian_glass.css', 'utf8');
const hybridJs = fs.readFileSync('app/static/dashboard_hybrid.js', 'utf8');
const mainJs = fs.readFileSync('app/static/main.js', 'utf8');
const mainBundle = fs.readFileSync('app/static/main.min.js', 'utf8');

test('main dashboard and /vault share the Obsidian Vision Glass shell and rail', () => {
    assert.match(indexHtml, /\/static\/obsidian_glass\.css/);
    assert.match(vaultHtml, /\/static\/tokens\.css/);
    assert.match(vaultHtml, /\/static\/obsidian_glass\.css/);
    assert.match(vaultHtml, /\/static\/dashboard_hybrid\.css/);
    assert.match(vaultHtml, /class="nx-vault-page ui-classic skin-vision vision-dark"/);
    assert.match(indexHtml, /include "partials\/nx_rail\.html"/);
    assert.match(vaultHtml, /include "partials\/nx_rail\.html"/);
    assert.match(railHtml, /class="nx-rail"/);
    assert.match(railHtml, /href="\/forum"/);
    assert.match(railHtml, /href="\/tester"/);
    assert.match(railHtml, /href="\/stats"/);
    assert.doesNotMatch(railHtml, /href="\/studio"/);
    assert.doesNotMatch(railHtml, /href="\/multiview"/);
    assert.doesNotMatch(railHtml, /href="\/google-hub"/);
    assert.doesNotMatch(railHtml, /href="\/v1\/intake"/);
    assert.match(obsidianCss, /backdrop-filter:/);
    assert.match(obsidianCss, /\.nx-vault-page \.card/);
});

test('main dashboard exposes direct Local Vault navigation and openVault helper', () => {
    assert.match(railHtml, /data-tooltip="Local Vault \(Ctrl\+Shift\+V\)"/);
    assert.match(indexHtml, /class="nx-vault-jump-btn"[^>]*@click="openVault\(\)"/);
    assert.match(mainJs, /openVault\(/);
    assert.match(mainJs, /bootParams\.get\('view'\) === 'favorites'/);
    assert.match(mainBundle, /openVault/);
});

test('vault preserves splitscreen contracts, stash integration and recent queries', () => {
    assert.match(vaultHtml, /dataset\.nexusSplitStream/);
    assert.match(vaultHtml, /dataset\.nexusSplitWatch/);
    assert.match(vaultHtml, /nuss-page-selected/);
    assert.match(vaultHtml, /\/api\/v1\/discovery-hub\/combined-history\/collections\/stash/);
    assert.match(vaultHtml, /selBulkStashBtn/);
    assert.match(vaultHtml, /recentQueriesRow/);
});

test('dashboard_hybrid.js supports Ctrl+K on both main search and vault queryInput, plus Ctrl+Shift+V toggle', () => {
    let focusedId = '';
    let navigated = '';
    const listeners = [];
    const elements = {
        'nx-main-search': { id: 'nx-main-search', value: 'stella', focus() { focusedId = 'nx-main-search'; }, select() {} },
    };
    const ctx = {
        localStorage: { getItem: () => null, setItem() {} },
        document: {
            activeElement: null,
            querySelector: () => null,
            getElementById: (id) => elements[id] || null,
            addEventListener: (_ev, fn) => listeners.push(fn),
        },
        window: {
            location: { pathname: '/', href: 'http://127.0.0.1:8000/' },
            getComputedStyle: () => ({ display: 'none', visibility: 'hidden' }),
        },
    };
    Object.defineProperty(ctx.window.location, 'href', {
        get: () => 'http://127.0.0.1:8000/',
        set: (val) => { navigated = val; },
    });
    vm.runInNewContext(hybridJs, ctx);
    assert.equal(listeners.length, 1);

    let prevented = false;
    listeners[0]({ ctrlKey: true, shiftKey: false, altKey: false, key: 'k', preventDefault() { prevented = true; }, stopPropagation() {} });
    assert.equal(prevented, true);
    assert.equal(focusedId, 'nx-main-search');

    listeners[0]({ ctrlKey: true, shiftKey: true, altKey: false, key: 'V', preventDefault() {}, stopPropagation() {} });
    assert.equal(navigated, '/vault?q=stella');
});

test('vault player loads hls.min.js and supports HLS + JIT stream refresh', () => {
    assert.match(vaultHtml, /\/static\/hls\.min\.js/);
    assert.match(vaultHtml, /window\.Hls\.isSupported\(\)/);
    assert.match(vaultHtml, /\/api\/v1\/stream\/xhamster\//);
    assert.match(vaultHtml, /\/api\/v1\/stream\/resolve\//);
    assert.match(vaultHtml, /id="playerRefreshBtn"/);
});
