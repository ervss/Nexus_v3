// Execute the actual serialized callback without any popup helper globals.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('extensions/Nexus_Gallery/popup.js', 'utf8');
const handler = source.indexOf('async function handleEpornerScraping(tab)');
const start = source.indexOf('func: async (limit, shouldEnrichDetails) => {', handler) + 'func: '.length;
const args = source.indexOf('args: [pageLimit, isDeep || pageLimit <= 1]', start);
const end = source.lastIndexOf('},', args) + 1;
const makeCard = (href) => ({
    innerText: 'Clip 720p',
    querySelector: (selector) => {
        if (selector.startsWith('a[href')) return { getAttribute: (key) => key === 'href' ? href : 'Clip' };
        if (selector.includes('.mbtit')) return { innerText: 'Clip' };
        return null;
    },
});
const listing = { querySelectorAll: () => [makeCard('/video-abc/clip/'), makeCard('/hd-porn/def/clip/')] };
const document = {
    querySelector: (selector) => selector === '.streamevents' ? listing : null,
    querySelectorAll: () => [],
};
let fetchCount = 0;
const context = vm.createContext({
    URL, console, document,
    window: { location: { href: 'https://www.eporner.com/profile/demo/playlist/abc/clips/' } },
    location: { pathname: '/profile/demo/playlist/abc/clips/' },
    chrome: { runtime: { sendMessage: async () => ({}) } },
    fetch: async () => { fetchCount++; return { ok: true, text: async () => '' }; },
    DOMParser: class { parseFromString() { return { querySelector: () => null, querySelectorAll: () => [] }; } },
    setTimeout: (callback) => callback(),
});
const scraper = vm.runInContext('(' + source.slice(start, end) + ')', context);
scraper(1, true).then((rows) => {
    assert.equal(rows.length, 2);
    assert.equal(fetchCount, 2);
    assert.equal(rows[1].url, 'https://www.eporner.com/hd-porn/def/clip/');
    console.log('Eporner isolated popup scraper regression: passed');
}).catch((error) => { console.error(error); process.exitCode = 1; });
