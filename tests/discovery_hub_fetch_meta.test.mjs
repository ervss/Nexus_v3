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
const runtime = fs.readFileSync(path.join(root, 'app', 'discovery_hub_runtime.py'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'app', 'main.py'), 'utf8');

// 1. Script contains fetch meta methods
assert.match(script, /discoveryHubIsMissingMeta\(item\)/, 'discoveryHubIsMissingMeta must exist');
assert.match(script, /if \(item\._enriched\) return false;/, 'already enriched items must be skipped');
assert.match(script, /discoveryHubMissingMetaItems\(scope = 'auto'\)/, 'discoveryHubMissingMetaItems must exist');
assert.match(script, /discoveryHubSelectedMissingCount\(\)/, 'discoveryHubSelectedMissingCount must exist');
assert.match(script, /discoveryHubAllMissingCount\(\)/, 'discoveryHubAllMissingCount must exist');
assert.match(script, /async discoveryHubFetchMeta\(scope = 'auto'\)/, 'discoveryHubFetchMeta must exist');

// 2. Template exposes header button and selection buttons
assert.match(template, /dhub-header-btn-enrich/, 'header must have enrich button');
assert.match(template, /discoveryHubFetchMeta\(discoveryHubSelectedCount\(\) > 0 \? 'selected' : 'all'\)/, 'header button must trigger fetch meta for selected or all');
assert.match(template, /discoveryHubFetchMeta\('selected'\)/, 'selection toolbar must have fetch meta for selected');
assert.match(template, /discoveryHubFetchMeta\('all'\)/, 'selection toolbar must have fetch meta for all');

// 3. Balbums network resilience fixes
assert.match(runtime, /DEFAULT_BROWSER_HEADERS/, 'runtime must define realistic browser headers');
assert.match(runtime, /self\.balbums_stale/, 'runtime must maintain stale cache for balbums');
assert.match(mainPy, /timeout_val = 22 if is_balbums else 12/, 'main.py must set proper timeout for balbums');
assert.match(mainPy, /for attempt in range\(2 if is_balbums else 1\):/, 'main.py must retry transient failures for balbums');

console.log('All Discovery Hub fetch meta & Balbums resilience UI and logic contracts passed!');
