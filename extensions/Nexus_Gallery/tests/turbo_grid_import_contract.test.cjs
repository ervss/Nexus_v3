const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const grid = readFileSync(join(root, 'turbo_grid_importer.js'), 'utf8');
const styles = readFileSync(join(root, 'turbo_grid_importer.css'), 'utf8');
const background = readFileSync(join(root, 'background.js'), 'utf8');

test('Turbo Vault uses the service-worker bulk import command and preserves size', () => {
  assert.match(grid, /action:\s*'NEXUS_TURBO_IMPORT_BULK'/);
  assert.match(grid, /sizeBytes:\s*it\.size\s*\|\|\s*0/);
});

test('Turbo Vault gallery keeps the requested 4 by 3 browsing model and controls', () => {
  assert.match(grid, /galleryPerPage:\s*12/);
  assert.match(styles, /grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(grid, /data-gallery-load/);
  assert.match(grid, /data-card-play/);
  assert.match(grid, /data-gallery-import/);
});

test('service worker accepts the current and legacy Turbo Vault command names', () => {
  assert.match(background, /msg\.action === "NEXUS_TURBO_IMPORT_BULK"\s*\|\|\s*msg\.action === "TURBO_IMPORT_BULK"/);
  assert.match(background, /async function nexusTurboImportBulk[\s\S]*?await findDashboardUrl\(\)/);
  assert.match(background, /async function nexusTurboImportBulk[\s\S]*?await buildLocalApiHeaders\(\{ "Content-Type": "application\/json" \}\)/);
});
