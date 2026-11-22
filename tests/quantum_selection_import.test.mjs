import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app/static/search.js', import.meta.url), 'utf8');

function harness() {
    const elements = {};
    let fetchCalls = [];
    let alertMessages = [];
    const dom = {
        getElementById(id) {
            if (!elements[id]) {
                elements[id] = {
                    value: '',
                    style: {},
                    focus() {},
                    innerHTML: '',
                    textContent: '',
                    disabled: false,
                    checked: false,
                    indeterminate: false,
                    querySelectorAll: () => []
                };
            }
            return elements[id];
        },
        querySelectorAll(selector) {
            return [];
        },
        querySelector(selector) {
            return null;
        },
        body: { insertAdjacentHTML() {} },
        addEventListener() {}
    };
    const context = vm.createContext({
        URL,
        AbortController,
        setTimeout,
        clearTimeout,
        alert: (msg) => alertMessages.push(msg),
        fetch: async (url, opts) => {
            fetchCalls.push({ url, opts });
            return { ok: true, json: async () => ({ status: 'success', id: 101 }) };
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
    search.selectedUrls = new Set();
    search.activeSource = 'all';
    search.searchFilters = { quality: ['all'], source: ['all'] };
    search.activeFilters = { duration: 0, orientation: 'all' };
    search.activeSort = 'relevance';
    search.renderResults = () => {};
    search.fairResultLimit = (r) => r;
    search.showLoading = () => {};
    search.showError = () => {};
    search.clearResults = () => {};

    return {
        search,
        elements,
        getFetchCalls: () => fetchCalls,
        getAlertMessages: () => alertMessages,
        clearCalls: () => { fetchCalls = []; alertMessages = []; }
    };
}

test('toggleSelect and getSelectedResults manage item selection', () => {
    const { search } = harness();
    search.filteredResults = [
        { url: 'https://t.me/bimbo_central/1', title: 'Video 1', chat_id: 100, message_id: 1, source: 'Telegram' },
        { url: 'https://t.me/bimbo_central/2', title: 'Video 2', chat_id: 100, message_id: 2, source: 'Telegram' },
        { url: 'https://t.me/bimbo_central/3', title: 'Video 3', chat_id: 100, message_id: 3, source: 'Telegram' }
    ];

    assert.equal(search.getSelectedResults().length, 0);

    search.toggleSelect('https://t.me/bimbo_central/1', true);
    assert.equal(search.getSelectedResults().length, 1);
    assert.equal(search.getSelectedResults()[0].url, 'https://t.me/bimbo_central/1');

    search.toggleSelect('https://t.me/bimbo_central/3', true);
    assert.equal(search.getSelectedResults().length, 2);

    search.toggleSelect('https://t.me/bimbo_central/1', false);
    assert.equal(search.getSelectedResults().length, 1);
    assert.equal(search.getSelectedResults()[0].url, 'https://t.me/bimbo_central/3');
});

test('split-screen import keeps the selected result and supplied batch after filters change', async () => {
    const { search, getFetchCalls } = harness();
    const result = { url: 'https://t.me/example/7', source: 'Telegram', chat_id: 123, message_id: 7, title: 'Selected' };
    search.filteredResults = [];
    assert.equal(await search.importVideo(result.url, null, true, 'Quantum Search test batch', result), true);
    const call = getFetchCalls()[0];
    assert.equal(call.url, '/api/v1/telegram/import');
    const body = JSON.parse(call.opts.body);
    assert.equal(body.message_id, 7);
    assert.equal(body.batch_name, 'Quantum Search test batch');
});

test('toggleSelectAll selects and deselects all filtered items', () => {
    const { search } = harness();
    search.filteredResults = [
        { url: 'https://t.me/bimbo_central/1', title: 'Video 1', chat_id: 100, message_id: 1, source: 'Telegram' },
        { url: 'https://t.me/bimbo_central/2', title: 'Video 2', chat_id: 100, message_id: 2, source: 'Telegram' }
    ];

    search.toggleSelectAll(true);
    assert.equal(search.getSelectedResults().length, 2);

    search.toggleSelectAll(false);
    assert.equal(search.getSelectedResults().length, 0);
});

test('updateSelectionToolbar updates select-all checkbox and badges', () => {
    const { search, elements } = harness();
    search.filteredResults = [
        { url: 'https://t.me/bimbo_central/1', title: 'Video 1' },
        { url: 'https://t.me/bimbo_central/2', title: 'Video 2' }
    ];

    search.updateSelectionToolbar();
    assert.equal(elements.quantumSelectAllCheckbox.checked, false);
    assert.equal(elements.quantumSelectAllCheckbox.indeterminate, false);
    assert.equal(elements.quantumSelectedBadge.style.display, 'none');

    search.toggleSelect('https://t.me/bimbo_central/1', true);
    assert.equal(elements.quantumSelectAllCheckbox.checked, false);
    assert.equal(elements.quantumSelectAllCheckbox.indeterminate, true);
    assert.equal(elements.quantumSelectedBadge.style.display, 'inline-flex');
    assert.equal(elements.quantumSelectedCount.textContent, 1);
    assert.equal(elements.quantumImportSelectedBtn.style.display, 'inline-flex');

    search.toggleSelect('https://t.me/bimbo_central/2', true);
    assert.equal(elements.quantumSelectAllCheckbox.checked, true);
    assert.equal(elements.quantumSelectAllCheckbox.indeterminate, false);
    assert.equal(elements.quantumSelectedCount.textContent, 2);
});

test('importSelected imports only chosen Telegram videos via /api/v1/telegram/import', async () => {
    const { search, getFetchCalls, getAlertMessages } = harness();
    let closed = 0;
    search.close = () => { closed++; };
    search.filteredResults = [
        { url: 'https://t.me/bimbo_central/10', title: 'Vid 10', chat_id: -100123, message_id: 10, source: 'Telegram', stream_url: '/api/v1/telegram/stream/-100123/10' },
        { url: 'https://t.me/bimbo_central/20', title: 'Vid 20', chat_id: -100123, message_id: 20, source: 'Telegram', stream_url: '/api/v1/telegram/stream/-100123/20' },
        { url: 'https://t.me/bimbo_central/30', title: 'Vid 30', chat_id: -100123, message_id: 30, source: 'Telegram', stream_url: '/api/v1/telegram/stream/-100123/30' }
    ];

    // Select only video 20
    search.toggleSelect('https://t.me/bimbo_central/20', true);

    await search.importSelected();

    const calls = getFetchCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/v1/telegram/import');

    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.message_id, 20);
    assert.equal(body.chat_id, -100123);

    // Selected item was imported and removed from selected set
    assert.equal(search.selectedUrls.has('https://t.me/bimbo_central/20'), false);
    assert.equal(getAlertMessages().some(msg => msg.includes('1 ready to play')), true);
    assert.equal(closed, 0);
});
