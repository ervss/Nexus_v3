const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const source = readFileSync('app/static/main.js', 'utf8');
const start = source.indexOf('        sortCamwhoresResults(results) {');
const end = source.indexOf('        cwSetGridDensity(density)', start);
assert.ok(start >= 0 && end > start);
const dashboard = vm.runInNewContext(`({${source.slice(start, end)}})`, {});
dashboard.camwhoresDiscovery = { sortBy: 'bitrate' };

test('Camwhores results reorder when detail bitrate arrives', () => {
    const cards = [
        { title: 'first', _discovery_index: 0, bitrate_kbps: 1800 },
        { title: 'second', _discovery_index: 1, bitrate_kbps: 6200 },
        { title: 'pending', _discovery_index: 2 },
        { title: 'third', _discovery_index: 3, bitrate_kbps: 3500 },
    ];
    assert.deepEqual(Array.from(dashboard.sortCamwhoresResults(cards), card => card.title),
        ['second', 'third', 'first', 'pending']);
    assert.equal(dashboard.camwhoresSortLabel(), 'Najvyšší bitrate');
    assert.equal(cards[0].title, 'first', 'sorting must not mutate the streamed results');
});
