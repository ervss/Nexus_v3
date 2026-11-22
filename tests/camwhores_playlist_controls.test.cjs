const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const source = readFileSync('app/static/main.js', 'utf8');
const start = source.indexOf('        cancelCwMetadata(reason =');
const end = source.indexOf('        async enrichSelectedCwCards()', start);
assert.ok(start > 0 && end > start);

test('pausing preserves unfinished cards and old playlist responses cannot overwrite the new one', async () => {
    const pendingFetches = [];
    const context = {
        AbortController, TextDecoder, Uint8Array,
        fetch: () => new Promise(resolve => pendingFetches.push(resolve)),
    };
    const controls = vm.runInNewContext(`({${source.slice(start, end)}})`, context);
    const oldCard = { url: 'https://www.camwhores.tv/videos/1/old/', title: 'Old' };
    const dashboard = {
        ...controls,
        _cwGalleryKey: 1,
        camwhoresDiscovery: { results: [oldCard], enrichingCards: false },
        showToast() {},
    };

    const first = dashboard.enrichCwCards([oldCard]);
    assert.equal(pendingFetches.length, 1);
    dashboard.pauseCwMetadata();
    assert.equal(dashboard.camwhoresDiscovery.enrichStatus, 'paused');
    assert.equal(dashboard.camwhoresDiscovery.enrichPausedCount, 1);

    const resumed = dashboard.resumeCwMetadata();
    assert.equal(pendingFetches.length, 2);
    const event = JSON.stringify({ type: 'detail', url: oldCard.url, video: {
        title: 'Verified', enriched: true, size_bytes: 123, size_status: 'exact'
    } }) + '\n';
    pendingFetches[1]({ ok: true, body: new Response(event).body });
    assert.equal((await resumed).completed, true);
    assert.equal(oldCard.title, 'Verified');

    pendingFetches[0]({ ok: true, body: new Response(JSON.stringify({ type: 'detail', url: oldCard.url,
        video: { title: 'Stale' } }) + '\n').body });
    assert.equal((await first).completed, false);
    assert.equal(oldCard.title, 'Verified');

    const third = dashboard.enrichCwCards([oldCard]);
    assert.equal(pendingFetches.length, 3);
    dashboard.beginCwGalleryChange();
    const newCard = { url: 'https://www.camwhores.tv/videos/2/new/', title: 'New' };
    dashboard.camwhoresDiscovery.results = [newCard];
    pendingFetches[2]({ ok: true, body: new Response(event).body });
    assert.equal((await third).completed, false);
    assert.equal(newCard.title, 'New');
    assert.equal(dashboard.camwhoresDiscovery.enrichingCards, false);
});
