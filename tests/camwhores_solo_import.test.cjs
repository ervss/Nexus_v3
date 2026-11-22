const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const source = readFileSync('app/static/main.js', 'utf8');
const start = source.indexOf('        async importSelectedCamwhores(');
const end = source.indexOf('        async cwQuickPlay(', start);
test('standalone import sends selected metadata without a batch', async () => {
    let sent;
    const ctx = { fetch: async (url, options) => {
        sent = JSON.parse(options.body);
        return { ok: true, json: async () => ({ status: 'queued' }) };
    }, setTimeout: fn => fn(), console };
    const dashboard = vm.runInNewContext(`({${source.slice(start, end)}})`, ctx);
    const card = { url: 'https://www.camwhores.tv/videos/123/example/', title: 'example' };
    dashboard.camwhoresDiscovery = { selected: [card.url], results: [card], galleryTitle: 'existing album' };
    dashboard.importProgress = {};
    dashboard.showToast = dashboard.loadVideos = dashboard.loadBatches = () => {};
    await dashboard.importSelectedCamwhores('', true);
    assert.equal(sent.standalone, true);
    assert.equal(sent.batch_name, null);
    assert.equal(sent.items[0].url, card.url);
    assert.equal(dashboard.camwhoresDiscovery.importing, false);
});
