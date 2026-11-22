const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const source = readFileSync('app/static/main.js', 'utf8');
const start = source.indexOf('        async searchCamwhoresDiscovery()');
const end = source.indexOf('        toggleCamwhoresSelection(url)', start);
assert.ok(start >= 0 && end > start);

test('discovery batches streamed detail updates and progressively renders cards', async () => {
    const events = [
        { type: 'listing', results: [
            { url: 'https://www.camwhores.tv/videos/1/one/', title: 'One' },
            { url: 'https://www.camwhores.tv/videos/2/two/', title: 'Two' },
        ] },
        { type: 'detail', url: 'https://www.camwhores.tv/videos/1/one/', video: { resolution: 1080 } },
        { type: 'detail', url: 'https://www.camwhores.tv/videos/2/two/', video: { resolution: 720 } },
    ];
    const body = events.map(event => JSON.stringify(event)).join('\n') + '\n';
    const context = {
        AbortController,
        TextDecoder,
        Uint8Array,
        clearTimeout,
        setTimeout,
        fetch: async () => new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } }),
    };
    const dashboard = vm.runInNewContext(`({${source.slice(start, end)}})`, context);
    let resultAssignments = 0;
    let results = [];
    dashboard.camwhoresDiscovery = {
        keyword: 'test',
        minQuality: 0,
        minDuration: 0,
        maxDuration: 0,
        searchTerms: '',
        pages: 1,
        sortBy: 'newest',
        onlyPublic: true,
        autoSkipLowQuality: false,
        selected: [],
        showAllResults: false,
        get results() { return results; },
        set results(value) {
            results = value;
            resultAssignments++;
        },
    };
    dashboard.cwPlaylists = { fetchResults: null, selected: [] };
    dashboard.showToast = () => {};
    dashboard.cancelCwMetadata = () => {};
    dashboard.getCamwhoresFilteredResults = () => Array.from({ length: 50 }, (_, index) => ({ url: String(index) }));

    await dashboard.searchCamwhoresDiscovery();

    assert.equal(dashboard.camwhoresDiscovery.loading, false);
    assert.equal(dashboard.camwhoresDiscovery.enriching, false);
    assert.equal(dashboard.camwhoresDiscovery.enrichedCount, 2);
    assert.deepEqual(Array.from(results, video => video.resolution), [1080, 720]);
    assert.equal(resultAssignments, 3, 'search reset, listing, and one batched detail update');
    const searchController = new AbortController();
    dashboard._cwDiscoveryController = searchController;
    dashboard.cancelCamwhoresDiscovery();
    assert.equal(searchController.signal.aborted, true);
    assert.equal(dashboard.getCamwhoresVisibleResults().length, 24);
    dashboard.loadMoreCamwhoresResults();
    assert.equal(dashboard.getCamwhoresVisibleResults().length, 48);
});

test('both discovery views expose the stop action and render cards in batches', () => {
    for (const filePath of ['app/templates/index.html']) {
        const template = readFileSync(filePath, 'utf8').replace(
            /\{%\s*include\s+"([^"]+)"\s*%\}/g,
            (_, rel) => readFileSync(`app/templates/${rel}`, 'utf8')
        );
        assert.match(template, /cancelCamwhoresDiscovery\(\)/);
        assert.match(template, /getCamwhoresVisibleResults\(\)/);
        assert.match(template, /Načítať ďalších 24 videí/);
    }
});
