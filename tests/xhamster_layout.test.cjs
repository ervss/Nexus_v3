const assert = require('node:assert/strict');
const fs = require('node:fs');

const layout = fs.readFileSync('extensions/nexus-video-selector/xhamster-layout.js', 'utf8');
const workbench = fs.readFileSync('extensions/nexus-video-selector/import-workbench.js', 'utf8');
const css = fs.readFileSync('extensions/nexus-video-selector/styles.css', 'utf8');
const manifest = fs.readFileSync('extensions/nexus-video-selector/manifest.json', 'utf8');

assert.match(layout, /nvs-xh-grid/);
assert.match(layout, /function paintDate/);
assert.match(layout, /pathname/);
assert.match(fs.readFileSync('extensions/nexus-video-selector/content.js', 'utf8'), /paintDate\?\.\(card, meta\.date \|\| meta\.relDate\)/);
assert.match(layout, /search in orientations/);
assert.match(layout, /nvs-xh-filters-launch/);
assert.match(layout, /setFiltersOpen\(false\)/);
assert.match(layout, /nvs-xh-filters'\) === '1'/);
assert.match(css, /nvs-xh-filters-open/);
assert.match(css, /#nvs-xh-filters-launch/);
assert.match(layout, /isPaidCard/);
assert.match(layout, /function dropPaid/);
assert.match(fs.readFileSync('extensions/nexus-video-selector/content.js', 'utf8'), /discardPaidCard/);
assert.match(layout, /relevant short/);
assert.match(layout, /page\|stránka\|stranka/);
assert.match(workbench, /data-filter="hideRejected"/);
assert.match(workbench, /data-part="columns"/);
assert.match(workbench, /nvs-xh-autoload/);
assert.match(css, /--nvs-xh-cols/);
assert.match(css, /html\.nvs-xh-wide \.nvs-xh-grid \.thumb-image-container__image,\s*html\.nvs-xh-wide \.nvs-xh-grid \.thumb-image-container__video \{\s*position: absolute !important; inset: 0 !important;/);
assert.match(css, /\.thumb-image-container__on-video \{\s*display: none !important;/);
assert.match(fs.readFileSync('extensions/nexus-video-selector/content.js', 'utf8'), /thumb-image-container, \.video-thumb__image-container/);
assert.match(manifest, /xhamster-layout\.js/);

console.log('xHamster layout contract: passed');
