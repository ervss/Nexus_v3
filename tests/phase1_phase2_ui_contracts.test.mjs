import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { createCommandModule } from '../app/static/modules/dashboard/command_palette.js';

const indexHtml = fs.readFileSync('app/templates/index.html', 'utf8');
const settingsHtml = fs.readFileSync('app/templates/partials/settings.html', 'utf8');
const railHtml = fs.readFileSync('app/templates/partials/nx_rail.html', 'utf8');
const tokensCss = fs.readFileSync('app/static/tokens.css', 'utf8');
const palettesCss = fs.readFileSync('app/static/color_palettes.css', 'utf8');
const palettesJs = fs.readFileSync('app/static/color_palettes.js', 'utf8');
const obsidianCss = fs.readFileSync('app/static/obsidian_glass.css', 'utf8');
const quantumUxJs = fs.readFileSync('app/static/quantum_ux.js', 'utf8');
const i18nJs = fs.readFileSync('app/static/modules/i18n.js', 'utf8');
const mainJs = fs.readFileSync('app/static/main.js', 'utf8');

test('Fáza 1: tokens.css definuje z-index škálu a Frosted Light tokeny', () => {
    for (const token of ['--z-rail: 40', '--z-topbar: 45', '--z-dropdown: 60', '--z-modal: 100', '--z-command: 140', '--z-toast: 160']) {
        assert.ok(tokensCss.includes(token), `Chýba token ${token}`);
    }
    assert.match(tokensCss, /body\.light-theme/);
    assert.match(obsidianCss, /body:not\(\.light-theme\):not\(\.skin-vision:not\(\.vision-dark\)\) \.nx-shell/);
    assert.match(obsidianCss, /:root:not\(#_\) body\.perf-none \*/);
    assert.match(obsidianCss, /\.nx-filter-menu\b/);
    // Palety nesmú prepisovať Frosted Light režim tmavým pozadím
    assert.match(palettesCss, /html\[data-nx-palette\]:not\(\[data-nx-tone="light"\]\)/);
    assert.match(palettesCss, /body:is\(\.ui-classic, \.ui-v1\):not\(\.light-theme\):not\(\.skin-vision:not\(\.vision-dark\)\)/);
    assert.match(palettesJs, /nx:tone-change/);
    // .nx-rail-top nesmie mať overflow-y: auto (orezávalo by to rail tooltips)
    const railTopRule = obsidianCss.match(/\.nx-rail-top\s*\{[^}]*\}/);
    assert.ok(railTopRule, 'Nenašlo sa pravidlo .nx-rail-top');
    assert.doesNotMatch(railTopRule[0], /overflow-y\s*:\s*auto/);
});

test('Fáza 1: mŕtve .ui-v1 CSS a šablóny sú odpojené/odstránené a index.html je čistý', () => {
    assert.match(indexHtml, /^<!DOCTYPE html>\s*<html lang="sk">/);
    assert.doesNotMatch(indexHtml, /href="\/static\/v1_compact_controls\.css/);
    assert.doesNotMatch(indexHtml, /href="\/static\/skin_aurora\.css/);
    assert.doesNotMatch(indexHtml, /href="\/static\/skin_vision\.css/);
    assert.doesNotMatch(indexHtml, /href="\/static\/gallery_v1\.css/);
    assert.match(indexHtml, /href="\/static\/cbir_review\.css/);
    assert.doesNotMatch(indexHtml, /command-palette-overlay/);
    assert.doesNotMatch(indexHtml, /hover-preview-sheet/);
    assert.doesNotMatch(indexHtml, /background:#0b1220/);
    assert.equal(fs.existsSync('app/templates/dashboard.html'), false);
    assert.equal(fs.existsSync('app/templates/partials/checker_status.html'), false);
});

test('Fáza 1: karty v Grid aj Flow View nepoužívajú eager preview mimo hoveru', () => {
    assert.match(indexHtml, /<template x-if="hoverVideoId === video\.id && video\.gif_preview_path">/);
    assert.match(indexHtml, /<template x-if="hoverVideoId === video\.id && video\.preview_url && video\.storage_type !== 'local_direct'">/);
    assert.match(indexHtml, /<template x-if="useLocalVideoThumb\(video\)">/);
    assert.doesNotMatch(indexHtml, /:src="useLocalVideoThumb\(video\) \? getLocalStreamUrl\(video\) : ''"/);
});

test('Fáza 1: Command Palette + Quantum UX bez kolízie a runtime crashu', () => {
    const qCtx = {};
    vm.runInNewContext(`${quantumUxJs}\nthis.createQuantumUXModule = createQuantumUXModule;`, qCtx);
    const toastCalls = [];
    const combined = Object.assign(
        {
            settings: { theme: 'dark', perfMode: 'balanced', perfLite: true },
            filters: { favoritesOnly: false },
            videos: [],
            showToast(msg, icon, type) { toastCalls.push({ msg, icon, type }); },
            saveSettings() {},
            toggleBatchMode() { this._batchToggled = true; },
            loadVideos() { this._loaded = true; },
        },
        createCommandModule(),
        qCtx.createQuantumUXModule()
    );

    assert.equal('commandPaletteOpen' in combined, false);
    assert.equal(Array.isArray(combined.commands), true);
    assert.ok(combined.commands.length >= 15);
    assert.ok(combined.commands.every(c => typeof c.action === 'function'));

    combined.runCommandSearch('');
    assert.equal(combined.commandResults.length, combined.commands.length);

    const themeCmd = combined.commandResults.find(c => c.id === 'cmd_theme');
    assert.ok(themeCmd);
    combined.executeCommandResult(themeCmd);
    assert.equal(combined.settings.theme, 'light');
    assert.equal(combined.showCommandPalette, false);

    // Overenie, že quantum_ux.js neprepísal showToast a neobsahuje Vue 2 this.$set
    assert.doesNotMatch(quantumUxJs, /this\.\$set\(/);
    combined.playRandomVideo();
    assert.equal(toastCalls.length, 1);
});

test('Fáza 1: Jednotné embed helpery pre Split-Screen Box 1 aj Box 2 (vrátane Bunkr page)', () => {
    assert.match(indexHtml, /x-if="isEmbedVideo\(activeVideo\)"/);
    assert.match(indexHtml, /x-if="isEmbedVideo\(activeVideo2\)"/);
    assert.match(indexHtml, /:src="getEmbedPlayerUrl\(activeVideo2\)"/);
    assert.match(indexHtml, /getEmbedPlayerLabel\(activeVideo2\)/);

    const embedStart = mainJs.indexOf('        isEmbedVideo(video) {');
    const embedEnd = mainJs.indexOf('        async initPlayer(video, playerIdx) {');
    const start = mainJs.indexOf('        isArchveVideo(video) {');
    const end = mainJs.indexOf('        isCamwhoresVideo(video) {');
    assert.ok(embedStart > 0 && embedEnd > embedStart && start > 0 && end > start, 'Embed helper sekcia sa nenašla v main.js');
    const snippet = mainJs.slice(embedStart, embedEnd) + '\n' + mainJs.slice(start, end);
    const helpers = vm.runInNewContext(`({${snippet}})`, { console, encodeURIComponent, URL });

    // Bunkr stránka (nie direct stream) musí ísť cez embed
    const bunkrPage = { source_url: 'https://bunkr.cr/f/abc123', url: 'https://bunkr.cr/f/abc123' };
    assert.equal(helpers.isEmbedVideo(bunkrPage), true);
    assert.equal(helpers.getEmbedPlayerUrl(bunkrPage), 'https://bunkr.cr/f/abc123');
    assert.equal(helpers.getEmbedPlayerLabel(bunkrPage), 'Bunkr');

    // Bunkr priamy CDN MP4 stream nesmie ísť cez embed
    const bunkrDirect = { source_url: 'https://bunkr.cr/f/abc123', url: 'https://i-cdn.bunkr.ru/video.mp4' };
    assert.equal(helpers.isEmbedVideo(bunkrDirect), false);

    // Faphouse embed vs direct stream
    const faphousePage = { source_url: 'https://faphouse.com/videos/test-xyz99', url: '' };
    assert.equal(helpers.isEmbedVideo(faphousePage), true);
    assert.equal(helpers.getEmbedPlayerUrl(faphousePage), 'https://faphouse.com/embed/xyz99');
    assert.equal(helpers.getEmbedPlayerLabel(faphousePage), 'Faphouse');

    const faphouseDirect = { source_url: 'https://faphouse.com/videos/test-xyz99', url: 'https://cdn.example/master.m3u8' };
    assert.equal(helpers.isEmbedVideo(faphouseDirect), false);

    // Edge case: null/prázdne video
    assert.equal(helpers.isEmbedVideo(null), false);
    assert.equal(helpers.getEmbedPlayerUrl(null), '');
    assert.equal(helpers.getEmbedPlayerLabel(null), 'Embed');
});

test('Fáza 1: 3-stupňový perfMode (balanced / full / none) v nastaveniach aj main.js', () => {
    assert.match(settingsHtml, /setPerformanceMode\('balanced'\)/);
    assert.match(settingsHtml, /setPerformanceMode\('full'\)/);
    assert.match(settingsHtml, /setPerformanceMode\('none'\)/);

    const values = new Map();
    let reloads = 0;
    const context = {
        console,
        localStorage: {
            getItem: k => values.get(k) || null,
            setItem: (k, v) => values.set(k, v),
        },
        window: { location: { reload: () => reloads++ } },
    };
    const settingsMethods = mainJs.slice(mainJs.indexOf('        loadSettings() {'), mainJs.indexOf('        toggleFastBrowse() {'));
    const state = vm.runInNewContext(`({settings:{perfLite:true,perfMode:'balanced',turbo:false},${settingsMethods}})`, context);

    state.loadSettings();
    assert.equal(state.settings.perfMode, 'balanced');
    assert.equal(state.settings.perfLite, true);

    state.setPerformanceMode('none');
    assert.equal(values.get('dashboardPerformanceMode'), 'none');
    assert.equal(state.settings.perfMode, 'none');
    assert.equal(state.settings.perfLite, true);
    assert.equal(reloads, 1);

    state.loadSettings();
    assert.equal(state.settings.perfMode, 'none');
    assert.equal(state.settings.perfLite, true);
});

test('Fáza 1: i18n.js nespúšťa celoplošný MutationObserver nad document.body', () => {
    assert.doesNotMatch(i18nJs, /new MutationObserver/);
    assert.match(i18nJs, /\.virtual-gallery-canvas/);
});

test('Fáza 2: zdieľaný nx_rail.html má aria-label na všetkých tlačidlách/odkazoch a 2-lištový header nemá duplicity', () => {
    const railItems = [...railHtml.matchAll(/<(?:button|a)\b[^>]*class="[^"]*nx-rail-btn[^"]*"[^>]*>/g)];
    assert.ok(railItems.length >= 10, 'Očakávam aspoň 10 položiek v nx_rail.html');
    for (const match of railItems) {
        assert.match(match[0], /aria-label="/, `Chýba aria-label na: ${match[0]}`);
    }
    // Vyčistený rail a drawer obsahujú len aktívne používané sekcie
    for (const removed of ['/studio', '/multiview', '/google-hub', '/v1/intake', '/filester-radar', 'discoveryHubShow']) {
        assert.equal(railHtml.includes(removed), false, `nx_rail.html nemá obsahovať odstránenú položku: ${removed}`);
    }
    const sourcesDrawer = indexHtml.match(/x-show="nxDrawerTab === 'sources'"[\s\S]*?(?=<!-- TAB 3:)/);
    assert.ok(sourcesDrawer, 'Nenašla sa sekcia Zdroje v index.html');
    for (const kept of ['Camwhores', 'SxyPrn', 'Faphouse', 'Fusion Hub', 'MEGA Hub']) {
        assert.ok(sourcesDrawer[0].includes(kept), `Sekcia Zdroje musí obsahovať ${kept}`);
    }
    for (const removed of ['Eporner', 'PornTrex', 'WhoresHub', 'LeakPorner', 'PornOne', 'Tnaflix', 'RedGIFs', 'VK Discovery', 'Bunkr Nexus', 'PornHub Hub', 'MEGA Import']) {
        assert.equal(sourcesDrawer[0].includes(removed), false, `Sekcia Zdroje nemá obsahovať ${removed}`);
    }
    const toolsDrawer = indexHtml.match(/x-show="nxDrawerTab === 'tools'"[\s\S]*?(?=<\/div>\s*<\/aside>)/);
    assert.ok(toolsDrawer, 'Nenašla sa sekcia Nástroje v index.html');
    for (const kept of ['Otvoriť súbor', 'Lokálny priečinok', 'Webshare', 'Forum Hub', 'Link Tester', 'Test webov', 'Quantum Search', 'Príkazová paleta', 'Klávesové skratky']) {
        assert.ok(toolsDrawer[0].includes(kept), `Sekcia Nástroje musí obsahovať ${kept}`);
    }
    for (const removed of ['XVideos TXT', 'XVideos Playlist', 'Import CSV', 'Filester Radar', 'Torrenty', 'Nexus Studio', 'Multiview', 'Google Hub', 'Úlohy (Jobs)', 'Systémové logy', 'Základné hľadanie', 'Náhodné video', 'BitTorrent Web']) {
        assert.equal(toolsDrawer[0].includes(removed), false, `Sekcia Nástroje nemá obsahovať ${removed}`);
    }
    assert.equal(fs.existsSync('app/templates/intake.html'), false, 'intake.html má byť odstránený');
    assert.equal(fs.existsSync('app/static/intake.js'), false, 'intake.js má byť odstránený');
    assert.equal(fs.existsSync('app/static/intake.css'), false, 'intake.css má byť odstránený');
    // Topbar má jediný .nx-topbar-row (zlúčené z pôvodných 2 riadkov)
    const topbarMatch = indexHtml.match(/<header class="nx-topbar">([\s\S]*?)<\/header>/);
    assert.ok(topbarMatch, 'Nenašiel sa <header class="nx-topbar">');
    const topbarRows = topbarMatch[1].match(/class="nx-topbar-row"/g) || [];
    assert.equal(topbarRows.length, 1, 'Topbar má mať presne 1 riadok');
    assert.match(topbarMatch[1], /Nástroje pohľadu/);
    assert.match(topbarMatch[1], /nx-activity-pill/);
});

test('Fáza 1 (regresia): Command Palette highlight escapuje RegExp + HTML a ignoruje zastarané async výsledky', async () => {
    const hlStart = mainJs.indexOf('        highlight(text, query) {');
    const hlEnd = mainJs.indexOf('        get exportUrl() {');
    assert.ok(hlStart > 0 && hlEnd > hlStart, 'Funkcia highlight sa nenašla v main.js');
    const hlObj = vm.runInNewContext(`({${mainJs.slice(hlStart, hlEnd)}})`);

    // RegExp metaznaky nesmú zhodiť aplikáciu
    const regexResult = hlObj.highlight('Video [1080p](HD)+test', '[1080p](');
    assert.match(regexResult, /<mark>\[1080p\]\(<\/mark>/);

    // HTML sa musí escapovať (žiadne surové <script>)
    const xssResult = hlObj.highlight('<script>alert(1)</script> demo', 'demo');
    assert.doesNotMatch(xssResult, /<script>/);
    assert.match(xssResult, /&lt;script&gt;/);
    assert.match(xssResult, /<mark>demo<\/mark>/);

    // Async race-condition guard: starší sľub nesmie prepísať novšie výsledky
    let resolveFirst;
    let resolveSecond;
    const mod = createCommandModule();
    mod.searchVideos = (q) => new Promise((res) => {
        if (q === 'first') resolveFirst = res;
        else resolveSecond = res;
    });

    mod.runCommandSearch('first');
    mod.runCommandSearch('second');
    resolveSecond([{ id: 2, title: 'Nové video' }]);
    await Promise.resolve();
    resolveFirst([{ id: 1, title: 'Staré video' }]);
    await Promise.resolve();

    assert.equal(mod.commandResults.some(r => r.id === 2), true);
    assert.equal(mod.commandResults.some(r => r.id === 1), false);
});
