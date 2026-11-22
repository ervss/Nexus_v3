'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../userscripts/nexus-universal-splitscreen.user.js'), 'utf8');
const staticSource = fs.readFileSync(path.resolve(__dirname, '../app/static/nexus-universal-splitscreen.js'), 'utf8');
const queueStart = source.indexOf("  const VAULT_OFFLINE_QUEUE_KEY = 'nexus_vault_offline_queue';");
const importStart = source.indexOf('  async function importCellsToNexus(cells)', queueStart);
const importEnd = source.indexOf('  async function saveItemToNexusVault', importStart);

assert.ok(queueStart >= 0 && importStart > queueStart && importEnd > importStart);
const implementation = source.slice(queueStart, importStart) + source.slice(importStart, importEnd);

function createHarness(request) {
  const storage = new Map();
  const toasts = [];
  const listeners = {};
  const document = { buttons: [], querySelectorAll() { return this.buttons; } };
  const context = vm.createContext({
    CONFIG: { DEFAULT_NEXUS_PORT: 8000 },
    Date,
    JSON,
    Math,
    console,
    location: { hostname: 'example.test' },
    navigator: { onLine: false },
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, String(value)); },
    },
    document,
    window: { addEventListener(type, listener) { listeners[type] = listener; } },
    setTimeout() { return 1; },
    _t(message) { return message; },
    showToast(message) { toasts.push(message); },
    gmFetch: request,
  });
  vm.runInContext(
    `${implementation}\nglobalThis.hooks = { importCellsToNexus, flushVaultOfflineQueue };`,
    context,
    { filename: 'nexus-universal-splitscreen.js' }
  );
  return { context, storage, toasts, listeners, document };
}

test('transient Vault import failures persist and later drain the offline batch', async () => {
  const requests = [];
  let online = false;
  const harness = createHarness(async (url, options) => {
    requests.push({ url, options });
    if (!online) throw new TypeError('Failed to fetch');
    return { ok: true, json: async () => ({ success: true, job: { id: 17, total_items: 1 } }) };
  });
  const button = { classList: { add() {} }, dataset: {}, textContent: '' };
  harness.document.buttons = [button];
  const cell = {
    item: { url: 'https://example.test/video/1', title: 'Test video' },
    video: null,
    element: { querySelector: () => button },
  };

  assert.equal(await harness.context.hooks.importCellsToNexus([cell]), true);
  const queued = JSON.parse(harness.storage.get('nexus_vault_offline_queue'));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].candidates[0].url, 'https://example.test/video/1');
  assert.match(button.textContent, /Čaká v rade/);
  assert.match(harness.toasts.at(-1), /offline fronte/);

  online = true;
  harness.context.navigator.onLine = true;
  assert.equal(await harness.context.hooks.flushVaultOfflineQueue(), 1);
  assert.deepEqual(requests.map(request => request.url), [
    'http://localhost:8000/api/v1/intake/import',
    'http://localhost:8000/api/v1/intake/import',
  ]);
  assert.deepEqual(JSON.parse(harness.storage.get('nexus_vault_offline_queue')), []);
  assert.equal(button.textContent, '✓ Zaradené');
  assert.equal(button.dataset.nexusVaultQueueId, undefined);
});

test('server validation errors are reported and not placed in the offline queue', async () => {
  const harness = createHarness(async () => ({
    ok: false,
    status: 422,
    json: async () => ({ detail: 'Invalid candidate' }),
  }));
  const result = await harness.context.hooks.importCellsToNexus([
    { item: { url: 'https://example.test/video/2' }, video: null, element: { querySelector: () => null } },
  ]);

  assert.equal(result, false);
  assert.equal(harness.storage.has('nexus_vault_offline_queue'), false);
  assert.match(harness.toasts.at(-1), /Invalid candidate/);
});

test('app and userscript contain the same offline queue implementation', () => {
  assert.match(staticSource, /VAULT_OFFLINE_QUEUE_KEY = 'nexus_vault_offline_queue'/);
  assert.match(staticSource, /function enqueueVaultImport\(batch\)/);
});
