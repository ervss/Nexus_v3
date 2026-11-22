import { test } from 'node:test';
import assert from 'node:assert/strict';
import './nexus_bridge.js';

const NexusBridge = globalThis.NexusBridge;

test('probeHealth handles /api/health, 404 fallback to /health, and network offline errors', async () => {
  const res404Fallback = await NexusBridge.probeHealth('http://127.0.0.1:8000/', {
    fetch: async (url) => {
      if (url.endsWith('/api/health')) return { ok: false, status: 404 };
      if (url.endsWith('/health')) return { ok: true, status: 200, json: async () => ({ status: 'healthy', service: 'Nexus Lite' }) };
      throw new Error('unexpected url');
    },
  });
  assert.equal(res404Fallback.ok, true);
  assert.equal(res404Fallback.endpoint, '/health');
  assert.equal(res404Fallback.service, 'Nexus Lite');

  const offline = await NexusBridge.probeHealth('http://127.0.0.1:8000', {
    fetch: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(offline.ok, false);
  assert.equal(offline.offline, true);
});

test('OfflineImportQueue deduplicates, persists, and flushes when server recovers', async () => {
  const storage = NexusBridge.createMemoryStorage();
  const queue = new NexusBridge.OfflineImportQueue({ storage });

  await queue.enqueue({
    source: 'Nexus Deck',
    endpoints: ['/api/v1/intake/import', '/api/lite/quick-import'],
    payload: { urls: ['https://example.com/v1'], batch_name: 'Deck' },
    lastError: 'Server offline',
  });
  // Duplicate should update in place instead of doubling
  const { queueLength } = await queue.enqueue({
    source: 'Nexus Deck',
    endpoints: ['/api/v1/intake/import', '/api/lite/quick-import'],
    payload: { urls: ['https://example.com/v1'], batch_name: 'Deck' },
    lastError: 'Still offline',
  });
  assert.equal(queueLength, 1);

  // Flush while server is offline keeps item queued
  const offlineFlush = await queue.flush('http://127.0.0.1:8000', {
    fetch: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(offlineFlush.offline, true);
  assert.equal(offlineFlush.remaining, 1);

  // Flush once server returns online uses fallback endpoint on 404 and clears queue
  const posted = [];
  const okFlush = await queue.flush('http://127.0.0.1:8000', {
    fetch: async (url, opts) => {
      if (url.endsWith('/api/health')) return { ok: true, status: 200, json: async () => ({ status: 'healthy' }) };
      if (url.endsWith('/api/v1/intake/import')) return { ok: false, status: 404, json: async () => ({}) };
      if (url.endsWith('/api/lite/quick-import')) {
        posted.push(JSON.parse(opts.body));
        return { ok: true, status: 200, json: async () => ({ status: 'queued' }) };
      }
      throw new Error('unexpected url: ' + url);
    },
  });
  assert.equal(okFlush.ok, true);
  assert.equal(okFlush.sent, 1);
  assert.equal(okFlush.remaining, 0);
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].urls, ['https://example.com/v1']);
  assert.equal(await queue.count(), 0);
});
