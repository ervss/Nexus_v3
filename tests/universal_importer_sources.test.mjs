import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'extensions/Nexus_Gallery/universal_importer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'extensions/Nexus_Gallery/universal_importer.css'), 'utf8');

assert.doesNotMatch(source, /nexus-refresh-stream/, 'manual multi-source refresh returned');
assert.doesNotMatch(source, /nexus-scan-all-sources/, 'scan-all player control returned');
assert.doesNotMatch(source, /function scanAllPlayerSources/, 'scan-all player workflow returned');
assert.doesNotMatch(source, /function refreshStreamSources/, 'page-wide stream collection returned');
assert.doesNotMatch(source, /nexus-source-list/, 'multi-source list returned');
assert.doesNotMatch(source, /nexus-has-sources/, 'multi-source expansion state returned');
assert.doesNotMatch(styles, /\.nexus-source-item/, 'multi-source row styles returned');

const resolveIndex = source.indexOf('const directUrl = await resolveDirectUrl(video);');
const revealIndex = source.indexOf("container.style.display = 'flex';", resolveIndex);
assert.ok(resolveIndex >= 0, 'main direct URL is not resolved');
assert.ok(revealIndex > resolveIndex, 'fast import panel is revealed before the main direct URL resolves');
assert.match(source, /container\._directBindRun !== bindRun \|\| container\._boundVideo !== video/, 'a stale player can replace the main direct URL');
assert.match(source, /container\._directUrl = info\.variants\[0\]\.url;/, 'best HLS variant is not selected as the single import target');
assert.match(source, /function shouldSuppressFastImport\(\)/, 'collection-page suppression gate is missing');
assert.match(source, /function hasVideoCardGrid\(\)/, 'video-card grids are not detected');
assert.match(source, /function isExplicitCollectionRoute\(\)/, 'album, playlist and favorites routes are not detected');
assert.match(source, /xvideos\\\.\(\?:com\|red\).*eporner/, 'known listing-heavy hosts are not gated to detail routes');
assert.match(source, /if \(IS_TOP_FRAME && shouldSuppressFastImport\(\)\) \{\s*hideFastImportPanel\(\);\s*return;\s*\}\s*const video = getBestVideo\(\);/s, 'scanner does not stop before looking at grid previews');
assert.match(source, /shouldSuppressFastImport\(\) \|\| !isMainRelaySource\(event\.source\)/, 'hidden or card iframe streams can still open the panel');
assert.match(source, /window\.addEventListener\('hashchange', scheduleScan/, 'SPA tab changes do not re-check panel suppression');

console.log('Universal importer single-target contracts passed.');
