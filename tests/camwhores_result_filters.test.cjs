const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const source = readFileSync('app/static/main.js', 'utf8');
const start = source.indexOf('        isCamwhoresVideoMatchingFilters(video) {');
const end = source.indexOf('        cwApplyQuickPill(preset)', start);
assert.ok(start >= 0 && end > start);
const dashboard = vm.runInNewContext(`({${source.slice(start, end)}})`, {});
dashboard.camwhoresDiscovery = {
    searchTerms: '', minQuality: 0, minDuration: 0, maxDuration: 0,
    durationFilter: 'all', metadataFilter: 'all', sortBy: 'newest',
    sortDescending: true,
    results: [
        { title: 'Known HD', url: 'a', resolution: 1080, duration: 500, enriched: true, bitrate_kbps: 2000, _discovery_index: 0 },
        { title: 'Unknown', url: 'b', _discovery_index: 1 },
        { title: 'Long SD', url: 'c', resolution: 480, duration: 2400, bitrate_kbps: 900, _discovery_index: 2 },
        { title: 'Mid HD', url: 'd', resolution: 720, duration: 1200, bitrate_kbps: 4000, _discovery_index: 3 },
    ],
};
const titles = () => Array.from(dashboard.getCamwhoresFilteredResults(), card => card.title);

test('result filters combine quality, duration, metadata and title without admitting unknown values', () => {
    const state = dashboard.camwhoresDiscovery;
    state.minQuality = 720;
    assert.deepEqual(titles(), ['Known HD', 'Mid HD']);
    state.durationFilter = 'short';
    assert.deepEqual(titles(), ['Known HD']);
    state.metadataFilter = 'missing';
    assert.deepEqual(titles(), []);
    state.metadataFilter = 'verified';
    state.searchTerms = 'known';
    assert.deepEqual(titles(), ['Known HD']);
    dashboard.cwClearResultFilters();
    assert.equal(titles().length, 4);
});

test('sort direction changes numeric order and keeps missing values last', () => {
    const state = dashboard.camwhoresDiscovery;
    state.sortBy = 'bitrate';
    assert.deepEqual(titles(), ['Mid HD', 'Known HD', 'Long SD', 'Unknown']);
    dashboard.cwToggleSortDirection();
    assert.deepEqual(titles(), ['Long SD', 'Known HD', 'Mid HD', 'Unknown']);
    state.sortBy = 'quality';
    assert.deepEqual(titles(), ['Long SD', 'Mid HD', 'Known HD', 'Unknown']);
});

test('tag and category filters only use verified detail metadata', () => {
    const state = dashboard.camwhoresDiscovery;
    state.sortBy = 'newest'; state.sortDescending = true;
    state.results = [
        { title: 'one', tags: ['oil', 'brunette'], categories: 'OnlyFans', taxonomy_verified: true, _discovery_index: 0 },
        { title: 'two', tags: ['oil'], categories: 'Fansly', taxonomy_verified: true, _discovery_index: 1 },
        { title: 'unknown', tags: ['oil', 'brunette'], categories: 'OnlyFans', taxonomy_verified: false, _discovery_index: 2 },
    ];
    state.tagFilter = 'oil, brunette'; state.tagMatch = 'all'; state.categoryFilter = '';
    assert.deepEqual(titles(), ['one']);
    state.tagMatch = 'any'; assert.deepEqual(titles(), ['one', 'two']);
    state.categoryFilter = 'onlyfans'; assert.deepEqual(titles(), ['one']);
    dashboard.cwClearResultFilters(); assert.equal(titles().length, 3);
});

test('text OR verified tag accepts either and re-evaluates after enrichment', () => {
    const state = dashboard.camwhoresDiscovery;
    Object.assign(state, {searchTerms: 'blowjob', textMatchScope: 'title_or_tags', tagFilter: '', categoryFilter: '', minQuality: 0, minDuration: 0, maxDuration: 0, durationFilter: 'all', metadataFilter: 'all'});
    const matches = video => dashboard.isCamwhoresVideoMatchingFilters(video);
    assert.equal(matches({title: 'New Blowjob'}), true);
    assert.equal(matches({title: 'New video', tags: ['blowjob'], taxonomy_verified: true}), true);
    const pending = {title: 'New video', tags: ['blowjob']};
    assert.equal(matches(pending), false);
    pending.taxonomy_verified = true;
    assert.equal(matches(pending), true);
    assert.equal(matches({title: 'Other', tags: ['solo'], taxonomy_verified: true}), false);
    state.textMatchScope = 'title';
    assert.equal(matches(pending), false);
    assert.equal(matches({title: 'Blowjob'}), true);
});
