import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const indexHtml = fs.readFileSync('app/templates/index.html', 'utf8');
const mainJs = fs.readFileSync('app/static/main.js', 'utf8');
const megaHubJs = fs.readFileSync('app/static/modules/mega_hub.js', 'utf8');
const obsidianCss = fs.readFileSync('app/static/obsidian_glass.css', 'utf8');
const searchJs = fs.readFileSync('app/static/search.js', 'utf8');
const searchCss = fs.readFileSync('app/static/search.css', 'utf8');

const EXPECTED_MODAL_PARTIALS = [
    'album_viewer_modal.html',
    'batch_tools_modals.html',
    'camwhores_modal.html',
    'discovery_hub_modal.html',
    'eporner_modal.html',
    'fusion_hub_modal.html',
    'leakporner_modal.html',
    'pornhub_hub_modal.html',
    'pornone_modal.html',
    'porntrex_modal.html',
    'tnaflix_modal.html',
    'whoreshub_modal.html',
];

test('Fáza 3: ťažké modály sú vyčlenené do partials/modals/ s lazy x-if a prístupnosťou', () => {
    for (const file of EXPECTED_MODAL_PARTIALS) {
        const fullPath = path.join('app/templates/partials/modals', file);
        assert.ok(fs.existsSync(fullPath), `Chýba partial ${fullPath}`);
        assert.ok(indexHtml.includes(`partials/modals/${file}`), `index.html neinkluduje ${file}`);
        const content = fs.readFileSync(fullPath, 'utf8');
        assert.match(content, /role="dialog"/, `${file} nemá role="dialog"`);
        assert.match(content, /aria-modal="true"/, `${file} nemá aria-modal="true"`);
        assert.match(content, /<template\s+x-if=/, `${file} nepoužíva lazy <template x-if=...>`);
    }
    assert.ok(indexHtml.split('\n').length < 5000, 'index.html by mal byť po modularizácii pod 5 000 riadkov');
});

test('Fáza 3: .v-card používa čisté kontextové menu (openCardMenuId) a player-drawer', () => {
    assert.match(indexHtml, /class="v-card-more-wrap"/);
    assert.match(indexHtml, /class="v-card-more-menu"\s+x-show="openCardMenuId === video\.id"/);
    assert.doesNotMatch(mainJs, /\bcardMenuOpenId\b/, 'Starý duplicitný stav cardMenuOpenId nesmie v main.js ostať');
    assert.match(indexHtml, /id="player-drawer"\s+class="player-drawer"/);
    assert.match(obsidianCss, /\.player-drawer\s*\{/);
    assert.match(obsidianCss, /\.v-card \.v-card-more-menu\s*\{/);
});

test('Fáza 3: jednotný globálny NexusToast (--z-toast) naprieč dashboardom, MEGA Hubom aj QS', () => {
    assert.match(mainJs, /window\.NexusToast\.show/);
    assert.match(megaHubJs, /window\.NexusToast\.show/);
    assert.match(searchJs, /window\.NexusToast\.success/);
    assert.doesNotMatch(searchJs, /nexusQsToastHost/, 'Duplicitný lokálny QS toast host bol nahradený globálnym NexusToast');
    assert.match(obsidianCss, /NexusToast/);
});

test('Fáza 4: QS Mega Links je 100 % v slovenčine, má slide-over Harvester Inspector, live cooldown a pin Top kanálov', () => {
    for (const label of ['>Kanál</label>', '>Min. dĺžka</label>', 'id="megaHarvestInspector"', 'mega-ch-pin-btn', 'pinnedIds']) {
        assert.ok(searchJs.includes(label), `search.js chýba Fáza 4 prvok: ${label}`);
    }
    assert.match(searchCss, /\.mega-harvest-inspector/);
    assert.match(searchCss, /\.mega-ch-pin-btn/);
    assert.match(searchCss, /var\(--z-drawer/);
    assert.match(searchCss, /var\(--z-sticky-bar/);
});
