import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '..', 'userscripts/bunkr-suite.user.js'), 'utf8');

const importButton = '<button class="bah-import" data-act="importSelected">Import selected →</button>';
const yandexButton = '<button class="bah-wide bah-yandex" data-act="yandexHD">🔍 Yandex HD Search (selected)</button>';
const fetchMetaButton = '<button class="bah-wide" data-act="fetchmeta">Fetch durations & quality</button>';

assert.ok(source.indexOf(fetchMetaButton) < source.indexOf(importButton), 'Import selected must immediately follow metadata fetch.');
assert.ok(source.indexOf(importButton) < source.indexOf(yandexButton), 'Yandex search must move below Import selected.');
assert.match(source, /aspect-ratio:\s*4\s*\/\s*5\s*!important/, 'Cards must retain the large vertical preview viewport.');
assert.match(source, /img\.bah-main-thumb[\s\S]{0,500}?object-fit:\s*cover\s*!important/, 'The native thumbnail must fill the vertical viewport without distortion while HD loads.');
assert.match(source, /data-act="fetchHdThumbs">Fetch HD/, 'HD thumbnail fetching needs an explicit panel action.');
assert.match(source, /function fetchHdThumbs\(\)/, 'The explicit HD thumbnail fetch handler is missing.');
assert.match(source, /gridLayoutVersion === 2/, 'Existing compact grid preferences must migrate once to the larger Auto layout.');
assert.match(source, /setCardRatio\(el,\s*viewAr\)/, 'Loaded HD storyboard must size the card for the visible storyboard viewport.');
assert.match(source, /\.bah-hd-overlay\s*\{[\s\S]{0,300}?inset:\s*0\s*!important/, 'HD storyboard overlay must cover the card stage.');

console.log('Bunkr Suite album helper UI contracts passed.');
