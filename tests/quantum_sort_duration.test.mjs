import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app/static/search.js', import.meta.url), 'utf8');

function harness() {
    const elements = {};
    const dom = {
        getElementById(id) {
            return elements[id] || { style: {}, value: '', innerHTML: '' };
        },
        body: { insertAdjacentHTML() {} },
        addEventListener() {}
    };
    const context = vm.createContext({
        URL,
        AbortController,
        setTimeout,
        clearTimeout,
        fetch: async () => ({ ok: true, json: async () => ({}) }),
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
    search.activeFilters = { duration: 0 };
    search.activeSort = 'relevance';
    search.renderResults = () => {};
    search.fairResultLimit = (r) => r;
    return search;
}

test('parseDate accurately parses ISO strings and formatted dates', () => {
    const search = harness();
    assert.equal(search.parseDate('2026-10-25'), new Date('2026-10-25').getTime());
    assert.equal(search.parseDate('2026-05-15T12:00:00Z'), new Date('2026-05-15T12:00:00Z').getTime());
    assert.equal(search.parseDate(''), 0);
    assert.equal(search.parseDate(null), 0);
});

test('sorting by date orders newest videos first', () => {
    const search = harness();
    search.results = [
        { id: 1, title: 'Old video', upload_date: '2024-01-01' },
        { id: 2, title: 'Newest video', upload_date: '2026-10-25' },
        { id: 3, title: 'Mid video', upload_date: '2025-06-15' },
        { id: 4, title: 'No date' },
    ];
    search.activeSort = 'date';
    search.applyFilters();
    assert.equal(search.filteredResults[0].id, 2); // 2026-10-25
    assert.equal(search.filteredResults[1].id, 3); // 2025-06-15
    assert.equal(search.filteredResults[2].id, 1); // 2024-01-01
    assert.equal(search.filteredResults[3].id, 4); // no date at the end
});

test('duration filters 1m+ (60s), 2m+ (120s), and 10m+ (600s)', () => {
    const search = harness();
    search.results = [
        { id: 1, title: '30s clip', duration: '0:30' },
        { id: 2, title: '1m 15s clip', duration: '1:15' },
        { id: 3, title: '3m 00s clip', duration: '3:00' },
        { id: 4, title: '12m clip', duration: '12:00' },
    ];

    // Filter 1m+ (60s)
    search.activeFilters.duration = 60;
    search.applyFilters();
    assert.equal(search.filteredResults.map(r => r.id).join(','), '2,3,4');

    // Filter 2m+ (120s)
    search.activeFilters.duration = 120;
    search.applyFilters();
    assert.equal(search.filteredResults.map(r => r.id).join(','), '3,4');

    // Filter 10m+ (600s)
    search.activeFilters.duration = 600;
    search.applyFilters();
    assert.equal(search.filteredResults.map(r => r.id).join(','), '4');
});
