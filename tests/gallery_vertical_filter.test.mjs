import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = fs.readFileSync(path.join(root, 'app', 'templates', 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'app', 'static', 'main.js'), 'utf8');

assert.match(template, /class="gcb-btn" x-show="!oldGalleryMode && !testerMix\?\.id"[\s\S]*?:class="\{'active': filters\.aspect === 'Vertical'\}"[\s\S]*?:aria-pressed="\(\s*filters\.aspect === 'Vertical'\)\.toString\(\)"/,
    'gallery controls must expose an accessible active-state button for vertical videos');
assert.match(template, /@click="filters\.aspect = filters\.aspect === 'Vertical' \? 'All' : 'Vertical'; selectedIds = \[\]; loadVideos\(true\)"/,
    'the vertical filter button must toggle the existing orientation filter and reload the gallery');
assert.match(script, /params\.set\('aspect', this\.filters\.aspect \|\| 'All'\)/,
    'the selected orientation must be sent to the server-side gallery filter');

console.log('Vertical gallery filter UI contract passed.');
