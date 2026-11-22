import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app/static/search.js', import.meta.url), 'utf8');

function harness() {
    const elements = {};
    let fetchCalls = [];
    let alertMessages = [];

    const createMockElement = (tag = 'div') => {
        const el = {
            tagName: tag.toUpperCase(),
            value: '',
            style: {},
            classList: {
                _classes: new Set(),
                add(c) { this._classes.add(c); },
                remove(c) { this._classes.delete(c); },
                toggle(c, force) {
                    if (force !== undefined) {
                        if (force) this._classes.add(c);
                        else this._classes.delete(c);
                        return force;
                    }
                    if (this._classes.has(c)) { this._classes.delete(c); return false; }
                    this._classes.add(c);
                    return true;
                },
                contains(c) { return this._classes.has(c); }
            },
            dataset: {},
            title: '',
            innerHTML: '',
            textContent: '',
            disabled: false,
            checked: false,
            children: [],
            querySelectorAll(selector) {
                const results = [];
                const check = (node) => {
                    if (selector.startsWith('.')) {
                        const cls = selector.slice(1);
                        if (node.classList && node.classList.contains(cls)) results.push(node);
                    } else if (selector.startsWith('[')) {
                        results.push(node);
                    }
                    if (node.children) node.children.forEach(check);
                };
                if (this.children) this.children.forEach(check);
                return results;
            },
            querySelector(selector) {
                return this.querySelectorAll(selector)[0] || null;
            },
            addEventListener() {},
            removeEventListener() {}
        };
        return el;
    };

    const dom = {
        getElementById(id) {
            if (!elements[id]) {
                elements[id] = createMockElement('div');
            }
            return elements[id];
        },
        querySelectorAll(selector) {
            const all = [];
            for (const key of Object.keys(elements)) {
                all.push(...elements[key].querySelectorAll(selector));
            }
            return all;
        },
        querySelector(selector) {
            return this.querySelectorAll(selector)[0] || null;
        },
        body: { insertAdjacentHTML() {} },
        addEventListener() {}
    };

    let fetchResponseMap = new Map();

    const context = vm.createContext({
        URL,
        AbortController,
        setTimeout,
        clearTimeout,
        alert: (msg) => alertMessages.push(msg),
        fetch: async (url, opts) => {
            fetchCalls.push({ url, opts });
            if (fetchResponseMap.has(url)) {
                return fetchResponseMap.get(url)(url, opts);
            }
            return {
                ok: true,
                json: async () => ({ status: 'success', id: 201 })
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
    search._libraryStatusCache = new Map();
    search._libraryCheckTimer = null;
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
    search.escapeHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    search._formatCardSize = () => '';
    search._orientationBadgeInfo = () => ({ label: '', title: '', estimated: false });
    search._playUrlForResult = (r) => r.stream_url || r.url || '';
    search._durationSeconds = (d) => Number(d) || 0;
    search._usesTesterMetadata = () => false;
    search.proxifyThumbnail = (u) => u;
    search._newImportBatchName = () => 'Test Batch';
    search._telegramImportPayload = (result) => {
        if (result?.source === 'Telegram' && result.chat_id && result.message_id) {
            return { chat_id: result.chat_id, message_id: result.message_id, url: result.url };
        }
        return null;
    };
    search._readyImportSource = (url) => false;
    search.updateSelectionToolbar = () => {};

    return {
        search,
        dom,
        elements,
        createMockElement,
        getFetchCalls: () => fetchCalls,
        setFetchHandler: (url, fn) => fetchResponseMap.set(url, fn),
        clearCalls: () => { fetchCalls = []; alertMessages = []; }
    };
}

test('QuantumSearch._isInDashboard detects library membership from direct flag and cache', () => {
    const { search } = harness();

    const video1 = { url: 'https://example.com/video1.mp4' };
    assert.equal(search._isInDashboard(video1), false);

    // Direct flag
    video1.in_dashboard = true;
    assert.equal(search._isInDashboard(video1), true);

    // URL in cache
    const video2 = { url: 'https://example.com/video2.mp4', source_url: 'https://example.com/watch2' };
    assert.equal(search._isInDashboard(video2), false);
    search._libraryStatusCache.set('https://example.com/video2.mp4', { in_dashboard: true, video_id: 42 });
    assert.equal(search._isInDashboard(video2), true);
    assert.equal(search._getDashboardInfo(video2)?.video_id, 42);

    // Source URL in cache
    const video3 = { url: 'https://cdn.example.com/stream3.mp4', source_url: 'https://example.com/page3' };
    assert.equal(search._isInDashboard(video3), false);
    search._libraryStatusCache.set('https://example.com/page3', { in_dashboard: true, video_id: 99 });
    assert.equal(search._isInDashboard(video3), true);
    assert.equal(search._getDashboardInfo(video3)?.video_id, 99);

    // Telegram chat_id + message_id in cache
    const tgVideo = { url: 'https://t.me/c/12345/678', chat_id: 12345, message_id: 678, source: 'Telegram' };
    assert.equal(search._isInDashboard(tgVideo), false);
    search._libraryStatusCache.set('tg:12345:678', { in_dashboard: true, video_id: 555 });
    assert.equal(search._isInDashboard(tgVideo), true);
    assert.equal(search._getDashboardInfo(tgVideo)?.video_id, 555);
});

test('renderResultsList displays "V DASHBOARDE" badge and "is-in-dashboard" class for existing videos', () => {
    const { search, dom } = harness();

    const container = dom.getElementById('quantumSearchResults');
    dom.getElementById('quantumSearchStats');
    dom.getElementById('quantumResultCount');

    search.filteredResults = [
        {
            url: 'https://eporner.com/v1',
            title: 'Existing Video',
            in_dashboard: true,
            _libraryInfo: { in_dashboard: true, video_id: 10 }
        },
        {
            url: 'https://eporner.com/v2',
            title: 'New Video',
            in_dashboard: false
        }
    ];

    search.renderResultsList();

    const html = container.innerHTML;
    assert.ok(html.includes('is-in-dashboard'), 'Existing card must contain class is-in-dashboard');
    assert.ok(html.includes('V DASHBOARDE'), 'Card must contain V DASHBOARDE badge');
    assert.ok(html.includes('title="Video je už v dashboarde (ID #10)"'), 'Badge title must reflect dashboard status');
    assert.ok(html.includes('is-imported'), 'Import button must have is-imported class');
    assert.ok(html.includes('style="display:none;"'), 'New card badge must be hidden by default');
});

test('checkLibraryStatus queries /api/v1/videos/library-status and updates badges', async () => {
    const { search, dom, setFetchHandler, getFetchCalls, createMockElement } = harness();

    const v1 = { url: 'https://eporner.com/v1', title: 'Video 1' };
    const v2 = { url: 'https://eporner.com/v2', title: 'Video 2' };
    search.filteredResults = [v1, v2];

    const container = dom.getElementById('quantumSearchResults');
    const card1 = createMockElement('div');
    card1.dataset.url = v1.url;
    card1.classList.add('search-result-card');
    const badge1 = createMockElement('span');
    badge1.classList.add('in-dashboard-badge');
    badge1.style.display = 'none';
    const btn1 = createMockElement('button');
    btn1.classList.add('btn-import');
    btn1.textContent = 'Import';
    card1.children = [badge1, btn1];

    container.children = [card1];

    setFetchHandler('/api/v1/videos/library-status', async (url, opts) => {
        return {
            ok: true,
            json: async () => ({
                matches: {
                    'https://eporner.com/v1': { in_dashboard: true, on_disk: false, video_id: 77 }
                }
            })
        };
    });

    await search.checkLibraryStatus();

    const calls = getFetchCalls().filter(c => c.url === '/api/v1/videos/library-status');
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0].opts.body).urls, ['https://eporner.com/v1', 'https://eporner.com/v2']);

    assert.equal(v1.in_dashboard, true);
    assert.equal(search._isInDashboard(v1), true);
    assert.equal(card1.classList.contains('is-in-dashboard'), true);
    assert.equal(badge1.style.display, 'inline-flex');
    assert.ok(badge1.innerHTML.includes('V DASHBOARDE'));
    assert.equal(btn1.classList.contains('is-imported'), true);
});

test('importVideo marks video as in-dashboard and activates badge immediately', async () => {
    const { search, dom, createMockElement } = harness();

    const video = { url: 'https://eporner.com/v100', title: 'Imported Video' };
    search.filteredResults = [video];

    const container = dom.getElementById('quantumSearchResults');
    const card = createMockElement('div');
    card.dataset.url = video.url;
    card.classList.add('search-result-card');
    const badge = createMockElement('span');
    badge.classList.add('in-dashboard-badge');
    badge.style.display = 'none';
    const btn = createMockElement('button');
    btn.classList.add('btn-import');
    btn.textContent = 'Import';
    card.children = [badge, btn];
    container.children = [card];

    const ok = await search.importVideo(video.url, btn, true, 'TestBatch', video);
    assert.equal(ok, true);

    assert.equal(video.in_dashboard, true);
    assert.equal(search._isInDashboard(video), true);
    assert.equal(card.classList.contains('is-in-dashboard'), true);
    assert.equal(badge.style.display, 'inline-flex');
    assert.ok(badge.innerHTML.includes('V DASHBOARDE'));
});
