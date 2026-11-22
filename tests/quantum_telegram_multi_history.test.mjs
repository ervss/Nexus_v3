import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app/static/search.js', import.meta.url), 'utf8');

test('multi-chat search requests each selected chat and combines results', async () => {
    const requests = [];
    const elements = {};
    const document = { getElementById: id => elements[id] || { style: {}, disabled: false }, addEventListener() {} };
    const context = vm.createContext({
        document, AbortController, URL, setTimeout, clearTimeout,
        fetch: async (url, options) => {
            requests.push({ url, body: JSON.parse(options.body) });
            return { ok: true, json: async () => ({ videos: [{ id: requests.length, text: 'Clip', chat_id: requests.length }] }) };
        }
    });
    vm.runInContext(source + '\nthis.Search = QuantumSearch;', context);
    const search = Object.create(context.Search.prototype);
    search.activeFilters = { duration: 300 };
    search.results = [];
    search.filteredResults = [];
    search.showLoading = () => {};
    search.updateScrapeStatus = () => {};
    search.requestedQuality = () => 0;
    search.requestedMinSizeMb = () => 0;
    search.applyFilters = () => { search.filteredResults = [...search.results]; };
    search.finishScrape = () => {};

    await search.scrapeMultipleTelegramChats([
        { id: '-1001', title: 'One' }, { id: '-1002', title: 'Two' }
    ], 'clip', 50);

    assert.deepEqual(requests.map(request => request.body.channel), ['-1001', '-1002']);
    assert.ok(requests.every(request => request.body.min_duration === 300));
    assert.equal(search.results.length, 2);
    assert.equal(search._telegramMultiLimit, 100);
});
