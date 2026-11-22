const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function setup({ metrics = false } = {}) {
    class Element extends EventTarget {
        constructor() { super(); this.children = []; this.dataset = {}; this.attributes = {}; }
        get textContent() { return this._text || this.children.map(child => child.textContent || '').join(''); }
        set textContent(value) { this._text = value; this.children = []; }
        append(...elements) { this.children.push(...elements); }
        appendChild(element) { this.children.push(element); }
        replaceChildren() { this.children = []; }
        setAttribute(name, value) { this.attributes[name] = value; }
        getAttribute(name) { return this.attributes[name] || null; }
        closest() { return null; }
        insertBefore() {}
    }
    const window = {};
    const document = {
        head: new Element(), documentElement: new Element(),
        createElement: () => new Element(), querySelectorAll: () => [],
    };
    let observer;
    let clock = 10000;
    class Clock extends Date { static now() { return clock; } }
    const timers = [];
    const reports = [];
    const context = { window, document, Date: Clock, setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {},
        performance: { now: () => clock }, AbortSignal,
        fetch: (url, options) => { reports.push(JSON.parse(options.body)); return Promise.resolve({ok: true, json: async () => ({background_limit: 1})}); },
        MutationObserver: class { constructor(callback) { observer = callback; } observe() {} } };
    if (metrics) vm.runInNewContext(fs.readFileSync('app/static/playback_metrics.js', 'utf8'), context);
    vm.runInNewContext(fs.readFileSync('app/static/playback_activity.js', 'utf8'), context);
    const media = new Element();
    media.parentNode = new Element();
    media.currentSrc = '/stream';
    media.currentTime = 0;
    media.paused = false;
    media.isConnected = true;
    return { api: window.NexusPlayback, media, observer, timers, reports, advance: milliseconds => { clock += milliseconds; } };
}

test('idle preloading players do not reserve playback capacity', () => {
    const { api, media, reports } = setup({metrics:true});
    api.begin(media);
    media.paused = true;
    media.currentSrc = '';
    media.dispatchEvent(new Event('loadstart'));
    assert.equal(reports.length, 0);
    media.currentSrc = '/stream';
    media.paused = false;
    media.dispatchEvent(new Event('play'));
    assert.equal(reports.at(-1).phase, 'loading');
    media.currentTime = 2;
    media.dispatchEvent(new Event('timeupdate'));
    media.paused = true;
    media.dispatchEvent(new Event('pause'));
    assert.equal(reports.at(-1).phase, 'paused');
    assert.ok(reports.at(-1).sequence > reports[0].sequence);
});

test('step stopwatch updates live and preserves completed step duration', () => {
    const { api, media, timers, advance } = setup();
    const session = api.begin(media, { reset: true, id: 1 });
    advance(2500);
    timers.at(-1)();
    assert.match(session.log.children[0].textContent, /prebieha 2.5 s/);
    api.update(media, 'NAČÍTAVAM STREAM');
    assert.match(session.log.children[0].textContent, /trvanie 2.5 s/);
    advance(1300);
    timers.at(-1)();
    assert.match(session.log.children[1].textContent, /prebieha 1.3 s/);
    assert.match(session.log.children[0].textContent, /trvanie 2.5 s/);
    api.stop(media);
    assert.match(session.log.children[1].textContent, /trvanie 1.3 s/);
});

test('journal and clock text changes do not rescan the dashboard', () => {
    const { observer, timers } = setup();
    observer([{ addedNodes: [{ nodeType: 3 }], removedNodes: [] }]);
    observer([{ addedNodes: [{ nodeType: 1, matches: () => false, querySelector: () => null }], removedNodes: [] }]);
    assert.equal(timers.length, 0);
});

test('player and gallery insertion bursts schedule only one scan', () => {
    const { observer, timers } = setup();
    const records = [{ addedNodes: [{ nodeType: 1, matches: () => true }], removedNodes: [] }];
    observer(records);
    observer(records);
    assert.equal(timers.length, 1);
    timers[0]();
    observer(records);
    assert.equal(timers.length, 2);
});

test('canplay does not claim playback; one second of progress does', () => {
    const { api, media } = setup();
    const session = api.begin(media, { reset: true, id: 1 });
    media.dispatchEvent(new Event('canplay'));
    assert.equal(session.confirmed, false);
    media.currentTime = 0.5;
    media.dispatchEvent(new Event('timeupdate'));
    assert.equal(session.confirmed, false);
    media.currentTime = 1.1;
    media.dispatchEvent(new Event('timeupdate'));
    assert.equal(session.confirmed, true);
    assert.equal(session.box.dataset.state, 'playing');
});

test('journal hides after confirmed playback and returns for errors and a new session', () => {
    const { api, media } = setup();
    const session = api.begin(media, { reset: true, id: 1 });
    assert.equal(session.box.hidden, false);
    media.dispatchEvent(new Event('canplay'));
    assert.equal(session.box.hidden, false);
    media.currentTime = 1;
    media.dispatchEvent(new Event('timeupdate'));
    assert.equal(session.box.hidden, true);
    api.update(media, 'Chyba', 'error');
    assert.equal(session.box.hidden, false);
    api.begin(media, { reset: true, id: 2 });
    assert.equal(session.box.hidden, false);
});

test('a recovery keeps the journal and changing video clears it', () => {
    const { api, media } = setup();
    const session = api.begin(media, { reset: true, id: 1 });
    api.update(media, 'HTTP 410; refreshing');
    api.begin(media, { reset: true, id: 1 });
    assert.ok(session.log.children.some(row => row.textContent.includes('HTTP 410')));
    api.begin(media, { reset: true, id: 2 });
    assert.equal(session.log.children.some(row => row.textContent.includes('HTTP 410')), false);
});

test('simultaneous media failures start only one refresh', async () => {
    const { api, media } = setup();
    let calls = 0;
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    api.begin(media, { reset: true, id: 1, retry: async () => { calls++; await pending; } });
    const first = api.recover(media, 'HTTP 410');
    await api.recover(media, 'network error');
    assert.equal(calls, 1);
    resolve();
    await first;
});

test('playback watchdog does not refresh the source while a seek is active', async () => {
    const { api, media, timers, advance } = setup();
    let recoveries = 0;
    const session = api.begin(media, { reset: true, id: 1, retry: async () => { recoveries++; } });
    media.seeking = true;
    advance(40000);
    timers[session.timer - 1]();
    await new Promise(setImmediate);
    assert.equal(recoveries, 0);

    media.seeking = false;
    advance(5000);
    timers[session.timer - 1]();
    await new Promise(setImmediate);
    assert.equal(recoveries, 1);
});

test('a late failed refresh cannot overwrite a different video', async () => {
    const { api, media } = setup();
    let reject;
    const pending = new Promise((_resolve, fail) => { reject = fail; });
    api.begin(media, { reset: true, id: 1, retry: () => pending });
    const recovery = api.recover(media, 'HTTP 410');
    const session = api.begin(media, { reset: true, id: 2 });
    reject(new Error('old video failed'));
    await recovery;
    assert.equal(session.last.includes('old video failed'), false);
});

test('failed refresh is displayed even after reinitializing the same player', async () => {
    const { api, media } = setup();
    const session = api.begin(media, { reset: true, id: 1, retry: async () => {
        api.begin(media, { reset: true, id: 1 });
        throw new Error('source returned HTTP 403');
    } });
    await api.recover(media, 'expired token');
    assert.ok(session.last.includes('HTTP 403'));
    assert.equal(session.box.dataset.state, 'error');
});

test('closing a player clears playing status and ignores late progress', () => {
    const { api, media } = setup();
    const session = api.begin(media, { reset: true, id: 1 });
    media.currentTime = 2;
    media.dispatchEvent(new Event('timeupdate'));
    api.stop(media);
    media.dispatchEvent(new Event('timeupdate'));
    assert.equal(session.box.dataset.state, 'stopped');
    assert.equal(session.confirmed, false);
});
