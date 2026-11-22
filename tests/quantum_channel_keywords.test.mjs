import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app/static/search.js', import.meta.url), 'utf8');

function harness() {
    const elements = {};
    let lastFetch = null;
    let mockVideos = [];
    const dom = {
        getElementById(id) {
            return elements[id] || { value: '', style: {}, focus() {}, innerHTML: '', disabled: false, querySelectorAll: () => [] };
        },
        body: { insertAdjacentHTML() {} },
        addEventListener() {}
    };
    const context = vm.createContext({
        URL,
        URLSearchParams,
        AbortController,
        setTimeout,
        clearTimeout,
        TextDecoder,
        fetch: async (url, opts) => {
            lastFetch = { url, opts };
            return {
                ok: true,
                body: {
                    getReader: () => ({
                        read: async () => ({ done: true, value: new Uint8Array() })
                    })
                },
                json: async () => ({ videos: mockVideos })
            };
        },
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
    search.showLoading = () => {};
    search.showError = () => {};
    search.clearResults = () => {};
    search.updateScrapeStatus = () => {};
    search.finishScrape = () => {};
    search.applyFilters = () => {};
    return { search, elements, getLastFetch: () => lastFetch, setMockVideos: (v) => { mockVideos = v; } };
}

test('scrapeChannel prioritizes telegramKeywordInput over quantumSearchInput', async () => {
    const { search, elements, getLastFetch } = harness();
    elements['telegramChannelInput'] = { value: 'bimbo_central' };
    elements['telegramKeywordInput'] = { value: 'cherry, blonde' };
    elements['quantumSearchInput'] = { value: 'ignored_query' };
    elements['telegramLimitSelect'] = { value: '50' };

    await search.scrapeChannel();
    const req = getLastFetch();
    assert.ok(req.url.includes('/api/v1/telegram/scrape_stream'));
    assert.ok(req.url.includes('channel=bimbo_central'));
    assert.equal(new URL('http://127.0.0.1' + req.url).searchParams.get('query'), 'cherry, blonde', 'Query must contain cherry, blonde');
});

test('scrapeChannel falls back to quantumSearchInput if telegramKeywordInput is empty', async () => {
    const { search, elements, getLastFetch } = harness();
    elements['telegramChannelInput'] = { value: 'bimbo_central' };
    elements['telegramKeywordInput'] = { value: '' };
    elements['quantumSearchInput'] = { value: 'fallback_query' };
    elements['telegramLimitSelect'] = { value: '50' };

    await search.scrapeChannel();
    const req = getLastFetch();
    assert.ok(req.url.includes('/api/v1/telegram/scrape_stream'));
    assert.ok(req.url.includes('query=fallback_query'));
});
