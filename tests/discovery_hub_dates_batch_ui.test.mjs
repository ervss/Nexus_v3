import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = fs.readFileSync(path.join(root, 'app', 'static', 'main.js'), 'utf8');
const template = fs.readFileSync(path.join(root, 'app', 'templates', 'index.html'), 'utf8').replace(
    /\{%\s*include\s+"([^"]+)"\s*%\}/g,
    (_, rel) => fs.readFileSync(path.join(root, 'app', 'templates', rel), 'utf8')
);
const api = fs.readFileSync(path.join(root, 'app', 'main.py'), 'utf8');

assert.ok(script.indexOf('this.discoveryHubResults = newResults') < script.indexOf('this.discoveryHubEnrichVisible(seq, signal)'), 'cards render before background metadata');
assert.match(script, /async discoveryHubEnrichSelectedAlbums\(\)/);
assert.match(script, /start \+= 8/, 'metadata batches must be bounded');
assert.match(template, /Načítať meta albumov/,
    'selection toolbar must expose the batch metadata action');
assert.match(api, /min\(int\(req\.max_items or 100\), 100\)/,
    'the enrich API must accept one full Discovery Hub page');

console.log('Discovery Hub date and batch-enrich UI contracts passed.');
