import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app/static/search.js', import.meta.url), 'utf8');

function harness() {
    const mockStorage = {};
    const elements = {};
    let lastFetch = null;
    const fetches = [];
    const dom = {
        getElementById(id) {
            return elements[id] || { value: '', style: {}, focus() {}, innerHTML: '', disabled: false };
        },
        body: {
            insertAdjacentHTML() {}
        },
        addEventListener() {}
    };
    const context = vm.createContext({
        URL,
        URLSearchParams,
        AbortController,
        setTimeout,
        clearTimeout,
        fetch: async (url, opts) => {
            lastFetch = { url, opts };
            fetches.push(lastFetch);
            return { ok: true, json: async () => ({ videos: [] }) };
        },
        document: dom,
        localStorage: {
            getItem(key) { return mockStorage[key] || null; },
            setItem(key, val) { mockStorage[key] = String(val); },
            removeItem(key) { delete mockStorage[key]; }
        }
    });
    vm.runInContext(source + '\nthis.Search = QuantumSearch;', context);
    const search = Object.create(context.Search.prototype);
    search.settings = { limitPerSource: 30, limitTotal: 100 };
    search.searchFilters = { quality: ['all'], source: ['all'] };
    search.activeFilters = { duration: 0 };
    search.showLoading = () => {};
    search.showError = () => {};
    search.clearResults = () => {};
    search.renderResults = () => {};
    return { search, elements, mockStorage, getLastFetch: () => lastFetch, getFetches: () => fetches };
}

test('getTelegramLimit returns preset values and custom values up to 2000', () => {
    const { search, elements } = harness();
    const select = { value: '100' };
    const input = { value: '50' };
    elements['telegramLimitSelect'] = select;
    elements['telegramScrapeLimit'] = input;

    assert.equal(search.getTelegramLimit(), 100);

    select.value = '1000';
    assert.equal(search.getTelegramLimit(), 1000);

    select.value = 'custom';
    input.value = '1500';
    assert.equal(search.getTelegramLimit(), 1500);

    // Clamped between 1 and 2000
    input.value = '9999';
    assert.equal(search.getTelegramLimit(), 2000);

    input.value = '0';
    assert.equal(search.getTelegramLimit(), 50);
});

test('onTelegramLimitSelectChange toggles custom input and persists preset', () => {
    const { search, elements, mockStorage } = harness();
    const select = { value: '50' };
    const input = { value: '50', style: { display: 'none' }, focus() {} };
    elements['telegramLimitSelect'] = select;
    elements['telegramScrapeLimit'] = input;

    search.onTelegramLimitSelectChange('1000');
    assert.equal(input.style.display, 'none');
    assert.equal(input.value, '1000');
    assert.equal(mockStorage['quantum_telegram_limit'], '1000');

    search.onTelegramLimitSelectChange('custom');
    assert.equal(input.style.display, 'inline-block');
});

test('scrapeChannel and searchJoinedChannels pass min_duration from activeFilters', async () => {
    const { search, elements, getLastFetch, getFetches } = harness();
    elements['telegramChannelInput'] = { value: 'test_channel' };
    elements['telegramLimitSelect'] = { value: '100' };
    elements['telegramScrapeLimit'] = { value: '100' };
    elements['quantumSearchInput'] = { value: 'durov' };

    // Set duration filter to 5m+ (300 seconds)
    search.activeFilters.duration = 300;

    // Test scrapeChannel
    await search.scrapeChannel();
    const scrapeReq = getFetches().find(request => request.url.includes('/api/v1/telegram/scrape_stream'));
    assert.ok(scrapeReq.url.includes('/api/v1/telegram/scrape'));
    assert.ok(scrapeReq.url.includes('channel=test_channel'));
    assert.ok(scrapeReq.url.includes('limit=100'));
    assert.ok(scrapeReq.url.includes('min_duration=300'));

    // Test searchJoinedChannels
    await search.searchJoinedChannels('durov');
    const globalReq = getFetches().find(request => request.url.includes('/api/v1/telegram/catalog/search?'));
    assert.ok(globalReq.url.includes('/api/v1/telegram/catalog/search?'));
    assert.ok(globalReq.url.includes('limit=100'));
    assert.ok(globalReq.url.includes('min_duration=300'));
    await search.searchJoinedChannels('durov', true);
    const liveReq = getFetches().find(request => request.url.includes('/api/v1/telegram/search_global?'));
    assert.ok(liveReq.url.includes('force_live=true'));
    assert.ok(liveReq.url.includes('min_duration=300'));
});
