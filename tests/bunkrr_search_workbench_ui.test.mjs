import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'userscripts/bunkrr-search-workbench.user.js'), 'utf8');

assert.match(source, /@match\s+https:\/\/bunkrr\.pics\/search\*/, 'Bunkrr search URL is not covered');
assert.match(source, /@match\s+https:\/\/findr\.to\/search\*/, 'Findr search URL is not covered');
assert.match(source, /@match\s+https:\/\/\*\.findr\.to\/search\*/, 'Findr subdomain search URL is not covered');
assert.match(source, /Fetch do nového gridu/, 'fetch-to-grid action is missing');
assert.match(source, /Hľadať názov, album alebo súbor/, 'keyword search is missing');
assert.match(source, /Najväčšie/, 'size sort is missing');
assert.match(source, /Najdlhšie/, 'duration sort is missing');
assert.match(source, /Vybrať všetko/, 'select-all action is missing');
assert.match(source, /Invertovať výber/, 'invert-selection action is missing');
assert.match(source, /Deep fetch/, 'deep metadata fetch is missing');
assert.match(source, /Import všetkých/, 'import-all action is missing');
assert.match(source, /Prehrať/, 'play action is missing');
assert.match(source, /\/api\/v1\/discovery-hub\/album-files-index/, 'combined gallery must use the fast local listing API');
assert.match(source, /Promise\.all\(selected\.slice\(start, start \+ 4\)\.map\(indexOneAlbum\)\)/, 'album listings must be fetched in parallel');
assert.match(source, /videí z \$\{sourceFileCount\} súborov/, 'the combined grid must disclose files skipped by the video filter');
assert.match(source, /aspect-ratio:3\/4/, 'previews must use a consistent portrait format');
assert.match(source, /align-items:start/, 'one portrait card must not stretch its entire grid row');
assert.match(source, /align-self:start/, 'cards must keep their own natural metadata height');
assert.match(source, /<fieldset class="bsw-filters">/, 'minimum filter panel is missing');
assert.match(source, /data-draft="minHeight"/, 'minimum resolution filter is missing');
assert.match(source, /data-draft="minDuration"/, 'minimum duration filter is missing');
assert.match(source, /data-draft="minSizeMb"/, 'minimum file size filter is missing');
assert.match(source, /data-draft="minQuality"/, 'minimum quality filter is missing');
assert.match(source, /\/api\/v1\/intake\/import/, 'import must create a Nexus import job');
assert.doesNotMatch(source, /:has\(a\[href\^="\/albums\/"\]\)/, 'the live search scanner must not use an expensive :has selector');
assert.match(source, /nodeContainsAlbumLink/, 'new search cards must be reconciled selectively');
assert.match(source, /setTimeout\(\(\) => \{ syncSearchCards\(\); updateToolbar\(\); \}, 120\)/, 'search-card reconciliation must be debounced');

console.log('Bunkrr search workbench UI contracts passed.');
