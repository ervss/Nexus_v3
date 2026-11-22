import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app/static/search.js', import.meta.url), 'utf8');

function harness() {
    const elements = {};
    const dom = {
        getElementById(id) {
            return elements[id] || { value: '', style: {}, focus() {}, innerHTML: '', disabled: false };
        },
        body: { insertAdjacentHTML() {} },
        addEventListener() {}
    };
    const context = vm.createContext({
        URL,
        AbortController,
        setTimeout,
        clearTimeout,
        fetch: async () => ({ ok: true, json: async () => ({ videos: [] }) }),
        document: dom,
        localStorage: {
            getItem() { return null; },
            setItem() {},
            removeItem() {}
        }
    });
    vm.runInContext(source + '\nthis.Search = QuantumSearch;', context);
    const search = Object.create(context.Search.prototype);
    search.results = [];
    search.filteredResults = [];
    search.activeSource = 'all';
    search.searchFilters = { quality: ['all'], source: ['all'] };
    search.activeFilters = { duration: 0, orientation: 'all' };
    search.activeSort = 'relevance';
    search.renderResults = () => {};
    search.fairResultLimit = (r) => r;
    return search;
}

test('sorting by views orders most viewed videos first', () => {
    const search = harness();
    search.results = [
        { id: 1, title: 'Low views', views: 50 },
        { id: 2, title: 'Viral video', views: 250000 },
        { id: 3, title: 'Mid views', views: 1200 },
        { id: 4, title: 'No views' },
    ];
    search.activeSort = 'views';
    search.applyFilters();
    assert.equal(search.filteredResults.map(r => r.id).join(','), '2,3,1,4');
});

test('orientation filter filters landscape and portrait videos', () => {
    const search = harness();
    search.results = [
        { id: 1, title: 'Landscape video', orientation: 'landscape', width: 1920, height: 1080 },
        { id: 2, title: 'Reels video', orientation: 'portrait', width: 1080, height: 1920 },
        { id: 3, title: 'Square video', orientation: 'landscape', width: 1080, height: 1080 },
        { id: 4, title: 'TikTok video', orientation: 'portrait', width: 720, height: 1280 },
    ];

    // Filter Landscape
    search.activeFilters.orientation = 'landscape';
    search.applyFilters();
    assert.equal(search.filteredResults.map(r => r.id).join(','), '1,3');

    // Filter Portrait
    search.activeFilters.orientation = 'portrait';
    search.applyFilters();
    assert.equal(search.filteredResults.map(r => r.id).join(','), '2,4');

    // Filter All
    search.activeFilters.orientation = 'all';
    search.applyFilters();
    assert.equal(search.filteredResults.map(r => r.id).join(','), '1,2,3,4');
});

test('quality and size sorting work on Telegram metadata fields', () => {
    const search = harness();
    search.results = [
        { id: 1, title: '720p 100MB', quality: '720p', height: 720, size_bytes: 100000000 },
        { id: 2, title: '4K 2GB', quality: '4K', height: 2160, size_bytes: 2000000000 },
        { id: 3, title: '1080p 500MB', quality: '1080p', height: 1080, size_bytes: 500000000 },
    ];

    // Sort by Quality (4K > 1080p > 720p)
    search.activeSort = 'quality';
    search.applyFilters();
    assert.equal(search.filteredResults.map(r => r.id).join(','), '2,3,1');

    // Sort by Size (2GB > 500MB > 100MB)
    search.activeSort = 'size';
    search.applyFilters();
    assert.equal(search.filteredResults.map(r => r.id).join(','), '2,3,1');
});
