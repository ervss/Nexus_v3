const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('userscripts/filester-album-workspace.user.js', 'utf8');
const start = source.indexOf('  const DEFAULT_FILTERS = {');
const end = source.indexOf('  const selected = ', start);
const persistStart = source.indexOf('  function persist() {');
const persistEnd = source.indexOf('  function trimMetadata(', persistStart);
assert.ok(start >= 0 && end > start && persistStart >= 0 && persistEnd > persistStart);

const saved = {};
const context = vm.createContext({
  DEFAULT_PORT: 8001, PREF_KEY: 'prefs', META_KEY: 'meta', FOLDER_META_KEY: 'folders',
  loadObject: () => ({ query: 'cash', quality: '1080', minSize: '100', sort: 'newest',
    onlyUnreviewed: true, layout: 'mini', port: 8000 }),
  localStorage: { setItem: (key, value) => { saved[key] = value; } },
  metadata: {}, folderMetadata: {}, selected: new Set(), reviewed: new Set(),
  albumStorageKey: (name) => name, trimMetadata: (value) => value, console,
});
vm.runInContext(source.slice(start, end) + source.slice(persistStart, persistEnd) +
  '\nthis.state = state; this.persist = persist;', context);
assert.equal(context.state.query, '');
assert.equal(context.state.quality, 'all');
assert.equal(context.state.minSize, '');
assert.equal(context.state.sort, 'native');
assert.equal(context.state.onlyUnreviewed, false);
assert.equal(context.state.layout, 'mini');
assert.equal(context.state.port, 8000);
context.state.query = 'new search';
context.persist();
const preferences = JSON.parse(saved.prefs);
assert.equal(preferences.query, undefined);
assert.equal(preferences.quality, undefined);
assert.equal(preferences.layout, 'mini');
assert.equal(preferences.port, 8000);
console.log('Filester filter defaults: passed');
