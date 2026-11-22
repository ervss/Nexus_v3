import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const template = fs.readFileSync('app/templates/tester.html', 'utf8');
const start = template.indexOf('async function loadMorePlaylist(');
const end = template.indexOf('// Expand an album result', start);
assert.ok(start >= 0 && end > start, 'playlist loader is present');
assert.match(template, /data-load-all-playlist-url/);
assert.match(template, /NAČÍTAŤ VŠETKY/);

const playlistUrl = 'https://www.xxbrits.com/playlists/1/example/';
const requestedPages = [];
const responses = [
    {
        items: [{ url: 'https://www.xxbrits.com/videos/2/', source_url: 'https://www.xxbrits.com/videos/2/' }],
        pages_loaded: 10,
        next_page: 21,
        has_more: true,
    },
    {
        items: [{ url: 'https://www.xxbrits.com/videos/3/', source_url: 'https://www.xxbrits.com/videos/3/' }],
        pages_loaded: 4,
        next_page: 0,
        has_more: false,
    },
];
const playlist = {
    url: playlistUrl,
    extractor: 'XXBrits',
    _expanded: false,
    data: {
        album_items: [{ url: 'https://www.xxbrits.com/videos/1/', source_url: 'https://www.xxbrits.com/videos/1/' }],
        playlist_next_page: 11,
        playlist_has_more: true,
        playlist_pages_loaded: 10,
    },
};
let renders = 0;

const context = {
    lastPayload: { results: [playlist] },
    CSS: { escape: value => value },
    document: { querySelector: () => null },
    Progress: { reset() {}, indeterminate() {}, hide() {} },
    fetch: async (_url, options) => {
        requestedPages.push(JSON.parse(options.body).start_page);
        const payload = responses.shift();
        return { ok: true, json: async () => payload };
    },
    renderResults: () => { renders += 1; },
    toggleAlbumExpand() {},
    showToast() {},
};
vm.createContext(context);
vm.runInContext(template.slice(start, end), context);

await context.loadMorePlaylist(playlistUrl, true);

assert.deepEqual(requestedPages, [11, 21]);
assert.equal(playlist.data.album_items.length, 3);
assert.equal(playlist.data.playlist_pages_loaded, 24);
assert.equal(playlist.data.playlist_has_more, false);
assert.equal(playlist.data.playlist_next_page, 0);
assert.equal(renders, 1);
