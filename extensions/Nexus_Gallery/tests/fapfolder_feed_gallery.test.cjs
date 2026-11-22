const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../fapfolder_feed_gallery.js'), 'utf8');

function run({ hostname = 'fapfolder.club', pathname = '/', topLevel = true, readyState = 'complete', feedPosts = [], initialStorage = {} } = {}) {
    let enabled = false;
    let menuOpen = false;
    let videoFilterEnabled = false;
    let resizeEvents = 0;
    const documentListeners = new Map();
    const rafCallbacks = [];
    const storage = new Map(Object.entries(initialStorage));
    const createElement = (tagName) => {
        const listeners = new Map();
        const attributes = new Map();
        const classes = new Set();
        return {
            tagName,
            className: '',
            id: '',
            value: '',
            textContent: '',
            children: [],
            classList: {
                add(name) {
                    classes.add(name);
                    if (tagName === 'html' && name === 'nexus-ff-feed-gallery') enabled = true;
                    if (tagName === 'html' && name === 'nexus-ff-feed-menu-open') menuOpen = true;
                    if (tagName === 'html' && name === 'nexus-ff-feed-video-only') videoFilterEnabled = true;
                },
                remove(name) {
                    classes.delete(name);
                    if (tagName === 'html' && name === 'nexus-ff-feed-menu-open') menuOpen = false;
                    if (tagName === 'html' && name === 'nexus-ff-feed-video-only') videoFilterEnabled = false;
                },
                toggle(name, force) {
                    const active = typeof force === 'boolean' ? force : !classes.has(name);
                    if (active) classes.add(name);
                    else classes.delete(name);
                    if (tagName === 'html' && name === 'nexus-ff-feed-menu-open') menuOpen = active;
                    if (tagName === 'html' && name === 'nexus-ff-feed-video-only') videoFilterEnabled = active;
                    return active;
                },
                contains(name) { return classes.has(name); },
            },
            setAttribute(name, value) { attributes.set(name, value); },
            getAttribute(name) { return attributes.get(name) || null; },
            addEventListener(name, callback) {
                if (!listeners.has(name)) listeners.set(name, []);
                listeners.get(name).push(callback);
            },
            click() { for (const callback of listeners.get('click') || []) callback({ currentTarget: this }); },
            change() { for (const callback of listeners.get('change') || []) callback({ currentTarget: this }); },
            append(...items) { this.children.push(...items); },
            appendChild(item) { this.children.push(item); },
        };
    };
    const window = {};
    window.top = topLevel ? window : {};
    window.dispatchEvent = (event) => { if (event.type === 'resize') resizeEvents++; };
    const root = createElement('html');
    const body = createElement('body');
    const sidebar = createElement('aside');
    const document = {
        documentElement: root,
        body,
        readyState,
        createElement,
        querySelectorAll: (selector) => selector === '.js_posts_stream .post' ? feedPosts : [],
        getElementById: () => null,
        querySelector: (selector) => selector === '.offcanvas-sidebar' ? sidebar : null,
        addEventListener: (name, callback) => {
            if (!documentListeners.has(name)) documentListeners.set(name, []);
            documentListeners.get(name).push(callback);
        },
        dispatchEvent: (event) => {
            for (const callback of documentListeners.get(event.type) || []) callback(event);
        },
    };

    vm.runInNewContext(source, {
        window,
        document,
        location: { hostname, pathname },
        Event: class Event { constructor(type) { this.type = type; } },
        Node: { ELEMENT_NODE: 1 },
        MutationObserver: class MutationObserver { observe() {} },
        requestAnimationFrame: (callback) => rafCallbacks.push(callback),
        localStorage: {
            getItem: (key) => storage.get(key) || null,
            setItem: (key, value) => storage.set(key, value),
        },
    });

    return {
        isEnabled: () => enabled,
        isMenuOpen: () => menuOpen,
        isVideoFilterEnabled: () => videoFilterEnabled,
        gridColumns: () => root.getAttribute('data-nexus-ff-feed-columns'),
        storage,
        resizeEvents: () => resizeEvents,
        fireReady: () => document.dispatchEvent(new Event('DOMContentLoaded')),
        finishAnimationFrames: () => {
            while (rafCallbacks.length) {
                const callbacks = rafCallbacks.splice(0);
                callbacks.forEach((callback) => callback());
            }
        },
        elements: () => ({ body, sidebar }),
        listen: (type, callback) => {
            if (!documentListeners.has(type)) documentListeners.set(type, []);
            documentListeners.get(type).push(callback);
        },
        dispatch: (type) => document.dispatchEvent(new Event(type)),
    };
}

test('enables the gallery only on the FapFolder homepage', () => {
    const homepage = run();
    assert.equal(homepage.isEnabled(), true);
    homepage.finishAnimationFrames();
    assert.ok(homepage.resizeEvents() > 0);
    for (const page of [
        run({ pathname: '/groups/example' }),
        run({ hostname: 'other.example' }),
        run({ topLevel: false }),
    ]) {
        assert.equal(page.isEnabled(), false);
        assert.equal(page.resizeEvents(), 0);
    }
});

test('waits for the document before enabling the homepage layout', () => {
    const page = run({ readyState: 'loading' });
    assert.equal(page.isEnabled(), true);
    page.fireReady();
    assert.equal(page.isEnabled(), true);
    assert.equal(page.elements().body.children.length, 2);
    page.finishAnimationFrames();
    assert.ok(page.resizeEvents() > 0);
});

test('homepage controls open the drawer and request visible-feed metadata', () => {
    const page = run();
    const { body, sidebar } = page.elements();
    const controls = body.children.find((el) => el.className === 'nexus-ff-feed-controls');
    const [menuButton, layoutSelect, filterButton, fetchButton] = controls.children;

    assert.equal(sidebar.id, 'nexus-ff-feed-menu');
    assert.equal(page.isMenuOpen(), false);
    menuButton.click();
    assert.equal(page.isMenuOpen(), true);
    assert.equal(menuButton.getAttribute('aria-expanded'), 'true');
    menuButton.click();
    assert.equal(page.isMenuOpen(), false);

    filterButton.click();
    assert.equal(page.isVideoFilterEnabled(), true);
    assert.equal(filterButton.getAttribute('aria-pressed'), 'true');
    assert.equal(page.storage.get('nexus_ff_feed_videos_only'), 'true');
    filterButton.click();
    assert.equal(page.isVideoFilterEnabled(), false);

    assert.deepEqual(layoutSelect.children.map((option) => option.value), ['4', '5', '6']);
    assert.equal(layoutSelect.getAttribute('aria-label'), 'Počet stĺpcov v galérii');
    assert.equal(page.gridColumns(), '4');
    layoutSelect.value = '6';
    layoutSelect.change();
    assert.equal(page.gridColumns(), '6');
    assert.equal(page.storage.get('nexus_ff_feed_columns'), '6');
    layoutSelect.value = 'invalid';
    layoutSelect.change();
    assert.equal(page.gridColumns(), '6');

    let fetchRequested = false;
    page.listen('nexus-fapfolder-fetch-visible', () => { fetchRequested = true; });
    fetchButton.click();
    assert.equal(fetchRequested, true);
});

test('restores a valid saved homepage grid density and defaults invalid values to four columns', () => {
    const saved = run({ initialStorage: { nexus_ff_feed_columns: '5' } });
    const controls = saved.elements().body.children.find((el) => el.className === 'nexus-ff-feed-controls');
    assert.equal(saved.gridColumns(), '5');
    assert.equal(controls.children[1].value, '5');

    const invalid = run({ initialStorage: { nexus_ff_feed_columns: '12' } });
    assert.equal(invalid.gridColumns(), '4');
});

test('marks feed cards with video media separately from photo-only posts', () => {
    const makePost = ({ addedVideo = false, media = false } = {}) => {
        const classes = new Set();
        const item = {
            classList: {
                toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
                contains: (name) => classes.has(name),
            },
        };
        const post = {
            querySelector(selector) {
                if (selector === '.post-time') return { textContent: addedVideo ? 'Creator added video' : 'Creator added 4 photos' };
                return media ? {} : null;
            },
            closest: () => item,
        };
        return { post, item };
    };
    const video = makePost({ media: true });
    const photo = makePost();
    const page = run({ feedPosts: [video.post, photo.post] });
    assert.equal(video.item.classList.contains('nexus-ff-feed-has-video'), true);
    assert.equal(video.item.classList.contains('nexus-ff-feed-no-video'), false);
    assert.equal(photo.item.classList.contains('nexus-ff-feed-no-video'), true);
    assert.equal(page.isVideoFilterEnabled(), false);
});

test('homepage feed CSS supports saved desktop densities and narrower responsive breakpoints', () => {
    const css = fs.readFileSync(path.join(__dirname, '../fapfolder_feed_gallery.css'), 'utf8');
    assert.match(css, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(css, /\[data-nexus-ff-feed-columns="5"\][\s\S]*?grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(css, /\[data-nexus-ff-feed-columns="6"\][\s\S]*?grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(css, /@media\s*\(max-width:\s*1199px\)/);
    assert.match(css, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(css, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(css, /\.offcanvas-sidebar\s*\{[\s\S]*?transform:\s*translateX\(-105%\)\s*!important/);
    assert.match(css, /\.nexus-ff-feed-menu-open\s+\.offcanvas-sidebar/);
    assert.match(css, /\.js_posts_stream\s*>\s*ul\s*>\s*\.hbanner[\s\S]*?display:\s*none\s*!important/);
    assert.match(css, /\.nexus-ff-feed-video-only[\s\S]*?\.nexus-ff-feed-no-video\s*\{\s*display:\s*none/);
    assert.match(css, /\.post \.pg_wrapper[\s\S]*?overflow:\s*hidden/);
    assert.match(css, /\.post\s*:has\(>\s*\.video-auth-placeholder-thumb\)\s*\{[\s\S]*?position:\s*relative\s*!important;[\s\S]*?aspect-ratio:\s*1;[\s\S]*?overflow:\s*hidden/);
    assert.match(css, /\.overflow-hidden\.clearfix\s+video[\s\S]*?object-fit:\s*contain/);
    assert.match(css, /\.video-auth-placeholder-thumb[\s\S]*?background-size:\s*cover/);
    assert.match(css, /\.overflow-hidden\.clearfix[\s\S]*?isolation:\s*isolate/);
    assert.match(css, /\.post:has\([^)]*video\[src\][\s\S]*?\.video-auth-placeholder-thumb\s*\{\s*display:\s*none/);

    assert.match(css, /\.nexus-ff-community-cover[\s\S]*?display:\s*none\s*!important/);
    assert.match(css, /\.post-footer[\s\S]*?display:\s*none\s*!important/);
    assert.match(css, /\.post-actions[\s\S]*?display:\s*none\s*!important/);

    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../manifest.json'), 'utf8'));
    const feedScript = manifest.content_scripts.find((entry) => entry.js?.includes('fapfolder_feed_gallery.js'));
    assert.equal(feedScript.run_at, 'document_start');
});
