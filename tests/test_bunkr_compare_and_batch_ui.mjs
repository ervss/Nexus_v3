import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '..', 'userscripts/bunkr-suite.user.js'), 'utf8');

// Contracts for BATCH NAME & scrolldown
assert.match(source, /data-role="batchName"/, 'Bunkr Helper must include BATCH NAME input.');
assert.match(source, /data-role="batchSelect"/, 'Bunkr Helper must include batch scrolldown select.');
assert.match(source, /async function loadDashboardBatches\(\)/, 'Must fetch dashboard batches sorted by name.');
assert.match(source, /\/api\/v1\/batches\?sort=name/, 'Must call batches API endpoint sorted by name.');

// Contracts for Dashboard comparison & quality resolution
assert.match(source, /async function compareWithDashboard\(\)/, 'Must have compareWithDashboard function.');
assert.match(source, /\/api\/v1\/duplicates\/compare-album/, 'Must call compare-album endpoint.');
assert.match(source, /data-comp-filter="better"/, 'Must have filter for better quality.');
assert.match(source, /data-comp-filter="duplicate"/, 'Must have filter for duplicates.');
assert.match(source, /data-comp-filter="worse"/, 'Must have filter for worse quality.');
assert.match(source, /data-act="replaceBetter"/, 'Must have action button to replace worse with better.');
assert.match(source, /async function replaceBetterWithDashboard\(\)/, 'Must have replace handler.');
assert.match(source, /\/api\/v1\/duplicates\/replace/, 'Must call replace API endpoint.');

// Contracts for HUD chips on thumbnails
assert.match(source, /bah-hud-compare/, 'Must inject compare HUD chips on album thumbnails.');
assert.match(source, /★ LEPŠIA KVALITA/, 'Must render LEPŠIA KVALITA label on cards.');
assert.match(source, /DUPLIKÁT/, 'Must render DUPLIKÁT label on cards.');
assert.match(source, /HORŠIA KVALITA/, 'Must render HORŠIA KVALITA label on cards.');

console.log('All Bunkr Suite dashboard comparison and batch controls contracts passed successfully.');
