const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('extensions/Nexus_Gallery/background.js', 'utf8');
for (const action of ['EPORNER_CREATE_MIX', 'EPORNER_FAST_SCAN_PLAYLISTS', 'EPORNER_DEEP_RESOLVE']) {
    assert.match(source, new RegExp(`msg\\.action === "${action}"`));
}
assert.match(source, /\/api\/tester\/eporner-mixes/);
assert.match(source, /\/api\/tester\/eporner-playlists\/titles\/stream/);
assert.match(source, /\/api\/tester\/batch-meta/);
assert.match(source, /metadata_only: true/);
assert.match(source, /\/tester\?eporner_mix=/);
assert.match(source, /chrome\.tabs\.create/);

console.log('Eporner mix background contract: passed');
