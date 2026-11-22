import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app/static/search.js', import.meta.url), 'utf8');

function harness() {
    const elements = {};
    let lastFetch = null;
    const fetches = [];
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
        fetch: async (url, opts) => {
            lastFetch = { url, opts };
            fetches.push(lastFetch);
            return { ok: true, json: async () => ({ videos: mockVideos }) };
        },
        document: dom,
        window: {},
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
    return { search, elements, context, getLastFetch: () => lastFetch, getFetches: () => fetches, setMockVideos: (v) => { mockVideos = v; } };
}

test('setQuickQualityFilter updates searchFilters and requestedQuality', () => {
    const { search } = harness();
    assert.equal(search.requestedQuality(), 0);

    search.setQuickQualityFilter('720p');
    assert.equal(search.requestedQuality(), 720);

    search.setQuickQualityFilter('1080p');
    assert.equal(search.requestedQuality(), 1080);

    search.setQuickQualityFilter('4K');
    assert.equal(search.requestedQuality(), 2160);

    search.setQuickQualityFilter('all');
    assert.equal(search.requestedQuality(), 0);
});

test('scrapeChannel and searchJoinedChannels pass min_quality to backend', async () => {
    const { search, elements, getFetches } = harness();
    elements['telegramChannelInput'] = { value: 'bimbo_central' };
    elements['telegramLimitSelect'] = { value: '100' };
    elements['telegramScrapeLimit'] = { value: '100' };
    elements['quantumSearchInput'] = { value: '' };

    // Select 1080p quality
    search.setQuickQualityFilter('1080p');

    // Scrape channel
    await search.scrapeChannel();
    const scrapeReq = getFetches().find(request => request.url.includes('/api/v1/telegram/scrape'));
    assert.ok(scrapeReq.url.includes('/api/v1/telegram/scrape'));
    assert.ok(scrapeReq.url.includes('channel=bimbo_central'));
    assert.ok(scrapeReq.url.includes('min_quality=1080'));

    // Global search
    await search.searchJoinedChannels('model');
    const globalReq = getFetches().find(request => request.url.includes('/api/v1/telegram/catalog/search'));
    assert.ok(globalReq.url.includes('min_quality=1080'));
});

test('applyFilters filters items based on effective_res and quality threshold', () => {
    const { search } = harness();
    search.results = [
        { id: 1, title: '480p SD', effective_res: 480, quality: '480p' },
        { id: 2, title: '720p HD', effective_res: 720, quality: '720p' },
        { id: 3, title: '1080p FHD', effective_res: 1080, quality: '1080p' },
        { id: 4, title: '2160p 4K', effective_res: 2160, quality: '4K' },
    ];

    // Filter 1080p+
    search.searchFilters.quality = ['1080p'];
    search.applyFilters();
    assert.equal(search.filteredResults.map(r => r.id).join(','), '3,4');

    // Filter 720p+
    search.searchFilters.quality = ['720p'];
    search.applyFilters();
    assert.equal(search.filteredResults.map(r => r.id).join(','), '2,3,4');

    // Filter 4K
    search.searchFilters.quality = ['4k'];
    search.applyFilters();
    assert.equal(search.filteredResults.map(r => r.id).join(','), '4');
});

test('portrait filtering trusts video dimensions and keeps missing orientation unknown', () => {
    const { search } = harness();
    search.results = [
        { id: 1, title: 'Vertical dimensions', width: 720, height: 1280, orientation: 'landscape' },
        { id: 2, title: 'Horizontal dimensions', width: 1920, height: 1080, orientation: 'portrait' },
        { id: 3, title: 'No orientation metadata' },
        { id: 4, title: 'Provider-declared vertical', orientation: 'vertical' },
        { id: 5, title: 'Square dimensions', width: 1000, height: 1000 },
    ];

    search.activeFilters.orientation = 'portrait';
    search.applyFilters();
    assert.equal(search.filteredResults.map(r => r.id).join(','), '1,4');

    search.activeFilters.orientation = 'landscape';
    search.applyFilters();
    assert.equal(search.filteredResults.map(r => r.id).join(','), '2,5');
    assert.equal(search._orientationBadgeInfo(search.results[0]).label, 'Vertikálne · rozmery');
    assert.equal(search._orientationBadgeInfo(search.results[3]).label, 'Vertikálne · zdroj');
});

test('thumbnail ratios are a separate, labeled estimate rather than confirmed portrait', () => {
    const { search } = harness();
    search.results = [
        { id: 1, title: 'Portrait-shaped preview', thumbnail_width: 400, thumbnail_height: 600 },
        { id: 2, title: 'Confirmed portrait', width: 720, height: 1280 },
        { id: 3, title: 'Near-square preview', thumbnail_width: 1000, thumbnail_height: 1090 },
        { id: 4, title: 'Landscape preview', thumbnail_width: 1280, thumbnail_height: 720 },
    ];

    search.activeFilters.orientation = 'portrait_estimate';
    search.applyFilters();
    assert.equal(search.filteredResults.map(r => r.id).join(','), '1');
    assert.equal(search._hasPortraitThumbnailEstimate(search.filteredResults[0]), true);
    assert.equal(search._orientationBadgeInfo(search.filteredResults[0]).estimated, true);

    search.activeFilters.orientation = 'portrait';
    search.applyFilters();
    assert.equal(search.filteredResults.map(r => r.id).join(','), '2');
});

test('thumbnail estimate scan is fair across sources and bounded to 48 with four concurrent loads', () => {
    const { search, context } = harness();
    const images = [];
    let active = 0;
    let peak = 0;
    context.Image = class {
        constructor() {
            this.naturalWidth = 400;
            this.naturalHeight = 700;
            images.push(this);
        }
        set src(value) {
            this.url = value;
            active++;
            peak = Math.max(peak, active);
        }
        complete() {
            active--;
            this.onload();
        }
    };
    search._searchRunId = 1;
    search.results = Array.from({ length: 60 }, (_, index) => ({
        id: index,
        url: `https://source${Math.floor(index / 5)}.example/video/${index}`,
        source: `source${Math.floor(index / 5)}`,
        thumbnail: `https://source${Math.floor(index / 5)}.example/thumb/${index}.jpg`,
    }));

    search.setOrientationFilter('portrait_estimate');
    assert.equal(images.length, 4);
    assert.equal(search._orientationThumbnailPending.size, 48);
    search.setOrientationFilter('portrait_estimate');
    assert.equal(images.length, 4, 'repeated clicks must not exceed the four-request scan window');

    while (images.some(image => !image.completed)) {
        const image = images.find(candidate => !candidate.completed);
        image.completed = true;
        image.complete();
    }

    assert.equal(images.length, 48);
    assert.equal(peak, 4);
    assert.equal(search._orientationThumbnailPending.size, 0);
    assert.equal(search._orientationThumbnailScanInProgress, false);
    assert.equal(search.results.filter(result => result.thumbnail_orientation_checked).length, 48);
});

test('scrapeChannel applies active quality filter and maps effective_res', async () => {
    const { search, elements, setMockVideos } = harness();
    elements['telegramChannelInput'] = { value: 'bimbo_central' };
    elements['telegramLimitSelect'] = { value: '100' };

    setMockVideos([
        { id: 10, text: 'Clip 480p', width: 854, height: 480, quality: '480p' },
        { id: 20, text: 'Clip 720p', width: 1280, height: 720, quality: '720p' },
        { id: 30, text: 'Clip 1080p Cinemascope', width: 1920, height: 800 },
        { id: 40, text: 'Clip 4K UHD', width: 3840, height: 2160, quality: '4K' },
    ]);

    // Set quality filter to 1080p+
    search.searchFilters.quality = ['1080p'];
    await search.scrapeChannel();

    // Verify only 1080p and 4K clips are retained in filteredResults
    assert.equal(search.results.length, 4);
    assert.equal(search.filteredResults.map(r => r.message_id).join(','), '30,40');
    assert.equal(search.filteredResults[0].effective_res, 1080);
    assert.equal(search.filteredResults[0].quality, '1080p');
    assert.equal(search.filteredResults[1].effective_res, 2160);
    assert.equal(search.filteredResults[1].quality, '4K');
});

test('status bar updates and stopScrape retains matched videos', () => {
    const { search, elements } = harness();
    elements['quantumScrapeStatus'] = { style: {} };
    elements['quantumStatusState'] = { textContent: '' };
    elements['quantumStatusCount'] = { textContent: '' };
    elements['quantumProgressBarFill'] = { style: {} };
    elements['quantumStatusDetails'] = { innerHTML: '' };
    elements['quantumStatusPulse'] = { className: '' };
    elements['quantumStopScrapeBtn'] = { style: {} };

    // Update status bar test
    search.updateScrapeStatus('Prehľadávam...', '12 / 25 videí', 48, 'Nájdených 12 videí...', 'active');
    assert.equal(elements['quantumStatusState'].textContent, 'Prehľadávam...');
    assert.equal(elements['quantumStatusCount'].textContent, '12 / 25 videí');
    assert.equal(elements['quantumProgressBarFill'].style.width, '48%');
    assert.equal(elements['quantumStatusDetails'].innerHTML, 'Nájdených 12 videí...');
    assert.ok(elements['quantumStatusPulse'].className.includes('active'));

    // Populate results and trigger stopScrape
    search.results = [
        { message_id: 1, title: 'Video 1', effective_res: 1080, quality: '1080p' },
        { message_id: 2, title: 'Video 2', effective_res: 720, quality: '720p' }
    ];
    let aborted = false;
    search._activeScrapeController = { abort: () => { aborted = true; } };

    search.stopScrape();
    assert.equal(aborted, true);
    assert.equal(elements['quantumStatusState'].textContent, 'Zastavené');
    assert.ok(elements['quantumStatusPulse'].className.includes('stopped'));
    assert.equal(search.filteredResults.length, 2);
});

test('portrait_any combines confirmed, probed and text-hinted vertical results', () => {
    const { search } = harness();
    search.results = [
        { id: 1, title: 'Probed', width: 720, height: 1280, orientation: 'portrait', orientation_evidence: 'page_dimensions' },
        { id: 2, title: 'Hinted vertical', orientation: 'unknown', orientation_likely: 'portrait', orientation_evidence: 'text_hint' },
        { id: 3, title: 'Landscape', width: 1920, height: 1080 },
        { id: 4, title: 'Nothing known' },
    ];
    search.activeFilters.orientation = 'portrait_any';
    search.applyFilters();
    assert.equal(search.filteredResults.map(r => r.id).join(','), '1,2');
    assert.equal(search._orientationBadgeInfo(search.results[0]).label, 'Vertikálne · rozmery');
    assert.equal(search._orientationBadgeInfo(search.results[1]).estimated, true);

    search.activeFilters.orientation = 'portrait';
    search.applyFilters();
    assert.equal(search.filteredResults.map(r => r.id).join(','), '1');
    assert.equal(search._orientationQuery(), '&orientation=portrait');
    search.activeFilters.orientation = 'all';
    assert.equal(search._orientationQuery(), '');
});

test('portrait quality filter uses the shorter side', () => {
    const { search } = harness();
    search.results = [
        { id: 1, title: '720x1280', width: 720, height: 1280 },
        { id: 2, title: '1080x1920', width: 1080, height: 1920 },
    ];
    search.searchFilters.quality = ['1080p'];
    search.applyFilters();
    assert.equal(search.filteredResults.map(r => r.id).join(','), '2');
});
