const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const importer = fs.readFileSync(path.join(root, 'redtube_grid_importer.js'), 'utf8');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const bulkImport = fs.readFileSync(path.resolve(root, '..', '..', 'app', 'routers', 'bulk_import.py'), 'utf8');

assert.match(importer, /data-role="load-pages"/);
assert.match(importer, /async function loadMorePages\(\)/);
assert.match(importer, /fetch\(pageUrl, \{ credentials: 'include' \}\)/);
assert.match(importer, /data-role="load-count"/);
assert.match(importer, /direct_url: entry\.directUrl \|\| ''/);
assert.match(background, /msg\.action === "REDTUBE_IMPORT_BULK"/);
assert.match(bulkImport, /direct_url: Optional\[str\] = None/);
assert.match(bulkImport, /\[RedTube-import\] using browser-resolved stream/);

console.log('RedTube quick-import and pagination contracts passed');
