const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function worker(fetch) {
  const listeners = [];
  const event = { addListener() {} };
  const chrome = {
    action: { onClicked: event, async setPopup() {} }, windows: { onRemoved: event },
    tabs: { onRemoved: event }, contextMenus: { onClicked: event },
    webRequest: { onBeforeRequest: event, onHeadersReceived: event },
    runtime: { onMessage: { addListener(fn) { listeners.push(fn); } }, onStartup: event, onInstalled: event },
    storage: { onChanged: event, local: { async get() { return {}; }, async set() {} } },
    alarms: { create() {}, onAlarm: event }, cookies: { onChanged: event, async getAll() { return []; } },
  };
  const ctx = vm.createContext({ chrome, fetch, URL, console, setTimeout, clearTimeout, importScripts() {} });
  vm.runInContext(fs.readFileSync('extensions/Nexus_Gallery/background.js', 'utf8'), ctx);
  vm.runInContext("findDashboardUrl = async () => 'http://localhost:8000'; buildLocalApiHeaders = async h => ({...h, 'X-Nexus-Token':'fixture'});", ctx);
  return msg => new Promise(resolve => {
    assert.equal(listeners[0](msg, {}, resolve), true, 'async response channel stays open');
  });
}

test('selected 69Tubed import reaches authenticated bulk API and preserves metadata', async () => {
  let payload;
  const send = worker(async (url, opts) => {
    assert.equal(url, 'http://localhost:8000/api/v1/import/bulk');
    assert.equal(opts.headers['X-Nexus-Token'], 'fixture');
    payload = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ imported: 0, duplicates: 1 }) };
  });
  const result = await send({ action: 'TUBED69_IMPORT_BULK', batchName: 'Selected batch', items: [
    { url: 'https://www.69tubed.com/video/123/clip/', title: 'Clip', quality: '1080P', thumbnail: 'thumb.jpg', tags: ['pov','69tubed'] },
    { url: 'https://69tubed.com.evil.example/video/123/clip/' },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.imported, 0);
  assert.equal(payload.batch_name, 'Selected batch');
  assert.equal(payload.videos.length, 1);
  assert.equal(payload.videos[0].tags, '69tubed,pov');
  assert.equal(payload.videos[0].quality, '1080P');
  assert.equal(payload.videos[0].source_url, payload.videos[0].url);
});

test('backend failures return their error to the panel', async () => {
  const send = worker(async () => ({ ok: false, json: async () => ({ detail: 'Token rejected' }) }));
  const result = await send({ action: 'TUBED69_IMPORT_BULK', items: [{url:'https://69tubed.live/video/123/clip/'}] });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Token rejected');
});
