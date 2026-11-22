import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = fs.readFileSync(path.join(root, 'app', 'templates', 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'app', 'static', 'main.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(root, 'app', 'static', 'modules', 'dashboard', 'maintenance.js'), 'utf8');
const bundle = fs.readFileSync(path.join(root, 'app', 'static', 'main.min.js'), 'utf8');

assert.match(template, /:class="\{'active': filters\.poorThumbOnly\}"[\s\S]*?@click="filters\.poorThumbOnly = !filters\.poorThumbOnly; selectedIds = \[\]; loadVideos\(true\)"/,
    'gallery toolbar must expose the poor-thumbnail filter and reload the results');
assert.match(template, /:aria-pressed="filters\.poorThumbOnly\.toString\(\)"/,
    'poor-thumbnail filter state must be announced');
assert.match(template, /x-show="filters\.poorThumbOnly && !oldGalleryMode && !testerMix\?\.id"[\s\S]*?@click="toggleBatchMode\(true\); selectAll\(\)"[\s\S]*?>Označiť zobrazené<\/button>/,
    'poor-thumbnail results must provide an action to select the loaded cards');
assert.match(template, /nx-board-search[\s\S]*?x-model="boardQuery"[\s\S]*?sourceBoards\.filter\(b => \(b\.name \|\| ''\)\.toLowerCase\(\)\.includes\(boardQuery\.toLowerCase\(\)\.trim\(\)\)\)/,
    'Hybrid drawer must expose searching Source Boards by name');
assert.match(template, /@click="startAiTagBatch\('batch'\)"/,
    'selected imports must expose batch AI tagging');
assert.match(template, /@click="smartRethumbCurrentBatch\(\)"/,
    'a selected batch must expose whole-batch SmartThumb');
assert.match(template, /@click="showRelatedBatches\(\)"/,
    'related imports must expose the combined batch view');
assert.match(template, /@click="confirmDeleteNonMatching\(\)"/,
    'filtered gallery results must expose the confirmed non-matching deletion action');
assert.match(template, /@mousemove="scrubImportedDiscoverySprite\(\$event, video\)"/,
    'gallery cards must restore interactive Discovery sprite previews');
assert.match(template, /cbir_review\.css/,
    'Related review board and discovery sprite must load their extracted stylesheet');
assert.match(template, /obsidian_glass\.css/,
    'Dashboard must load Obsidian Glass stylesheet');
for (const handler of ['stepGalleryCollection', 'setSizePreset', 'setDurationPreset',
    'confirmDeleteNonMatching', 'showRelatedBatches', 'smartRethumbCurrentBatch', 'startAiTagBatch']) {
    assert.ok(script.includes(handler) && bundle.includes(handler),
        `the deployed dashboard bundle must contain ${handler}`);
}

console.log('Gallery restoration UI contracts passed.');
