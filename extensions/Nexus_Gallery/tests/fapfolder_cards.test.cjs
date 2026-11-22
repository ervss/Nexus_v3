const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

function harness() {
    const source = readFileSync(join(__dirname, '../fapfolder_grid_importer.js'), 'utf8');
    const marker = source.lastIndexOf("    if (document.readyState === 'loading') {");
    assert.ok(marker > 0);
    const window = {};
    window.top = window;
    const document = { querySelectorAll: () => [], getElementById: () => null };
    vm.runInNewContext(`${source.slice(0, marker)} window.helpers = { collectCard, scanCards, state, matchesFilters, compareItems, qualityKey, isFeedVideoCard }; })();`, {
        window, document, URL, Map, Set, setTimeout,
        location: { hostname: 'fapfolder.club', href: 'https://fapfolder.club/groups/example/videos' },
        localStorage: { getItem: () => null },
    });
    return { ...window.helpers, document };
}

function card(href, { gallery = true, feedLink = false, feedVideo = false, postTime = '', text = '', alt = 'Gallery video', injected = '' } = {}) {
    return {
        isConnected: true,
        matches: (selector) => (gallery && selector.includes('a.pg_video')) || (feedLink && selector.includes('a.js_moment')) || /\/(videos?)\//.test(href),
        getAttribute: (name) => name === 'href' ? href : null,
        textContent: text + injected,
        querySelector: (selector) => {
            if (selector === 'img') return { src: 'https://fap.onl/thumb.jpg', getAttribute: () => alt };
            if (selector === '.post-time') return postTime ? { textContent: postTime } : null;
            if (selector.includes('.video-auth-placeholder-thumb')) return feedVideo ? {} : null;
            return null;
        },
        cloneNode: () => ({ textContent: text, querySelectorAll: () => [] }),
        closest() { return null; },
    };
}

test('current pg_video gallery cards resolve post URLs and thumbnail titles', () => {
    const { collectCard } = harness();
    const item = collectCard(card('/posts/166110'));
    assert.equal(item.url, 'https://fapfolder.club/posts/166110');
    assert.equal(item.id, 'posts:166110');
    assert.equal(item.title, 'Gallery video');
    assert.equal(item.thumbnail, 'https://fap.onl/thumb.jpg');
});

test('homepage feed post links are recognized and photo posts are excluded from video metadata fetches', () => {
    const { collectCard, isFeedVideoCard } = harness();
    const video = card('/posts/feed-video', { gallery: false, feedLink: true, postTime: 'Author added video', feedVideo: true });
    const photo = card('/posts/feed-photo', { gallery: false, feedLink: true, postTime: 'Author added 3 photos' });
    assert.equal(collectCard(video).id, 'posts:feed-video');
    assert.equal(isFeedVideoCard(video), true);
    assert.equal(collectCard(photo).id, 'posts:feed-photo');
    assert.equal(isFeedVideoCard(photo), false);
});

test('legacy video links remain supported and navigation/external links are rejected', () => {
    const { collectCard } = harness();
    assert.equal(collectCard(card('/video/abc', { gallery: false })).id, 'video:abc');
    assert.equal(collectCard(card('/videos/abc', { gallery: false })).id, 'videos:abc');
    assert.equal(collectCard(card('/groups/example/videos')), null);
    assert.equal(collectCard(card('https://example.org/posts/123')), null);
    assert.equal(collectCard(card('/posts/166110', { gallery: false })), null);
});

test('injected selector badges do not become video duration or filesize', () => {
    const { collectCard } = harness();
    const item = collectCard(card('/posts/123', { injected: '14:17:16 200 MB' }));
    assert.equal(item.duration, 0);
    assert.equal(item.sizeMb, null);
    assert.equal(collectCard(card('/posts/124', { text: '2:30 1080p 100 MB' })).duration, 150);
});

test('Refresh removes detached cards rather than retaining stale selections', () => {
    const { scanCards, state } = harness();
    state.items.set('posts:old', { card: { isConnected: false }, selected: true });
    state.items.set('posts:current', { card: { isConnected: true }, selected: true });
    scanCards();
    assert.equal(state.items.has('posts:old'), false);
    assert.equal(state.items.get('posts:current').selected, true);
});


test('ranges are inclusive and combine with checked exact portrait qualities', () => {
    const { state, matchesFilters } = harness();
    const item = { duration: 120, sizeMb: 100, width: 720, height: 1280 };
    Object.assign(state.filters, { durationMin: '2', durationMax: '3', sizeMin: '100', sizeMax: '200' });
    assert.equal(matchesFilters(item), true);
    assert.equal(matchesFilters({ ...item, duration: 119 }), false);
    assert.equal(matchesFilters({ ...item, sizeMb: 201 }), false);
    assert.equal(matchesFilters({ ...item, sizeMb: null }), false);
    state.excludedQualities.add('720p');
    assert.equal(matchesFilters(item), false);
});

test('numeric sort supports both directions, stable ties and unknown values last', () => {
    const { state, compareItems } = harness();
    const items = [{ originalIndex: 0, sizeMb: null, duration: 0 }, { originalIndex: 1, sizeMb: 2, duration: 10, width: 720, height: 1280 }, { originalIndex: 2, sizeMb: 100, duration: 100, width: 1080, height: 1920 }];
    for (const sort of ['sizeMb', 'duration', 'quality']) {
        state.filters.sort = sort;
        state.filters.direction = 'desc';
        assert.deepEqual(items.slice().sort(compareItems).map(i => i.originalIndex), [2, 1, 0]);
        state.filters.direction = 'asc';
        assert.deepEqual(items.slice().sort(compareItems).map(i => i.originalIndex), [1, 2, 0]);
    }
    state.filters.sort = 'original';
    assert.deepEqual(items.slice().reverse().sort(compareItems).map(i => i.originalIndex), [0, 1, 2]);
});
