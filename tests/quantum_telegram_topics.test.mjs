import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app/static/search.js', import.meta.url), 'utf8');

function harness() {
    const elements = {};
    const create = () => ({
        style: {},
        classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
        dataset: {},
        children: [],
        hidden: false,
        value: '',
        textContent: '',
        innerHTML: '',
        setAttribute() {},
        addEventListener() {},
        querySelectorAll() { return []; },
        querySelector() { return null; },
        append() {},
        replaceChildren() {},
    });
    const document = {
        getElementById(id) {
            if (!elements[id]) elements[id] = create();
            return elements[id];
        },
        querySelectorAll() { return []; },
        addEventListener() {},
    };
    const context = vm.createContext({
        URL,
        URLSearchParams,
        Map,
        Set,
        AbortController,
        setTimeout,
        clearTimeout,
        fetch: async () => ({ ok: true, json: async () => ({}) }),
        document,
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    });
    vm.runInContext(source + '\nthis.Search = QuantumSearch;', context);
    const search = Object.create(context.Search.prototype);
    search.escapeHtml = (value) => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    search.results = [];
    search.filteredResults = [];
    search.selectedUrls = new Set();
    search.activeFilters = { duration: 0 };
    search._formatCardSize = () => '';
    search._orientationBadgeInfo = () => ({ label: '', title: '', estimated: false });
    search._playUrlForResult = (result) => result.stream_url || result.url || '';
    search._usesTesterMetadata = () => false;
    search.proxifyThumbnail = (url) => url;
    search._isInDashboard = () => false;
    search.updateSelectionToolbar = () => {};
    search._queueLibraryStatusCheck = () => {};
    search.applyFilters = () => { search.filteredResults = search.results.slice(); search.renderResultsList(); };
    return { search, elements };
}

test('topic chip shows the thread name and video count', () => {
    const { search, elements } = harness();
    search.filteredResults = [{
        title: 'clip',
        url: 'https://t.me/bimbo_central/99',
        source: 'Telegram',
        source_channels: ['BIMBO CENTRAL'],
        stream_url: '/api/v1/telegram/stream/1/99',
        topic_id: 92078,
        topic_title: 'Cyrish',
        topic_video_count: 24,
        topic_channel: 'bimbo_central',
    }];
    search.renderResultsList();
    const html = elements.quantumSearchResults.innerHTML;
    assert.match(html, /class="tg-topic-chip"/);
    assert.match(html, /Cyrish · 24 videí/);
    assert.match(html, /data-topic-id="92078"/);
    assert.match(html, /data-topic-channel="bimbo_central"/);
});

test('a video without a thread has no topic chip', () => {
    const { search, elements } = harness();
    search.filteredResults = [{
        title: 'clip',
        url: 'https://t.me/bimbo_central/5',
        source: 'Telegram',
        source_channels: ['BIMBO CENTRAL'],
        stream_url: '/api/v1/telegram/stream/1/5',
    }];
    search.renderResultsList();
    assert.equal(elements.quantumSearchResults.innerHTML.includes('tg-topic-chip'), false);
});

test('topic scrape asks the stream for that topic id', () => {
    const { search } = harness();
    const url = search.telegramScrapeQuery('bimbo_central', 50, '', 0, 0, 0, 92078);
    const parsed = new URL(url, 'http://localhost');
    assert.equal(parsed.searchParams.get('channel'), 'bimbo_central');
    assert.equal(parsed.searchParams.get('topic_id'), '92078');
    assert.equal(parsed.searchParams.get('limit'), '50');
});

test('threads sort by newest upload, video count, and name', () => {
    const { search } = harness();
    const topics = [
        { id: 1, title: 'Aletta', video_count: 10, last_message_at: 100 },
        { id: 2, title: 'Portia', video_count: 50, last_message_at: 300 },
        { id: 3, title: 'Cyrish', video_count: null, last_message_at: 200 },
    ];
    search._telegramTopicSort = 'newest';
    assert.deepEqual(search.sortTelegramTopics(topics).map(topic => topic.id), [2, 3, 1]);
    search._telegramTopicSort = 'largest';
    assert.deepEqual(search.sortTelegramTopics(topics).map(topic => topic.id), [2, 1, 3]);
    search._telegramTopicSort = 'name';
    assert.deepEqual(search.sortTelegramTopics(topics).map(topic => topic.id), [1, 3, 2]);
    assert.deepEqual(topics.map(topic => topic.id), [1, 2, 3]);
});

test('the channel button names the selected threads', () => {
    const { search, elements } = harness();
    search.selectedTelegramChatIds = new Set(['-100']);
    search.selectedTelegramTopics = new Map([
        ['-100:1', {}],
        ['-100:2', {}],
        ['-100:3', {}],
        ['-100:4', {}],
        ['-100:5', {}],
    ]);
    search.updateTelegramChatButton();
    assert.equal(elements.telegramJoinedChatsButton.textContent, '1 kanál · 5 threadov');
});

test('arriving topic counts update the open cards', () => {
    const { search } = harness();
    search.results = [{ topic_id: 92078, topic_title: 'Cyrish', topic_video_count: null }];
    search.filteredResults = search.results.slice();
    let rendered = 0;
    search.applyFilters = () => { rendered += 1; };
    search._refreshTopicMeta([{ id: 92078, title: 'Cyrish', video_count: 24 }]);
    assert.equal(search.results[0].topic_video_count, 24);
    assert.equal(rendered, 1);
});

test('chats sort by newest upload, video count, and name, and format ISO upload dates', () => {
    const { search } = harness();
    const chats = [
        { id: '1', title: 'Alpha', video_count: 10, last_post_at: '2026-11-10T10:00:00+00:00' },
        { id: '2', title: 'Gamma', video_count: 50, last_post_at: '2026-11-16T12:30:00+00:00' },
        { id: '3', title: 'Beta', video_count: null, indexed: 5, last_post_at: '2026-11-12T08:00:00+00:00' },
    ];
    search._telegramChatSort = 'newest';
    assert.deepEqual(search.sortTelegramChats(chats).map(chat => chat.id), ['2', '3', '1']);
    search._telegramChatSort = 'largest';
    assert.deepEqual(search.sortTelegramChats(chats).map(chat => chat.id), ['2', '1', '3']);
    search._telegramChatSort = 'name';
    assert.deepEqual(search.sortTelegramChats(chats).map(chat => chat.id), ['1', '3', '2']);
    assert.ok(search.formatTopicWhen('2026-11-16T12:30:00+00:00').includes('2026'));
});
