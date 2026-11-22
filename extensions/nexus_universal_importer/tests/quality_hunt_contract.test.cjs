const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const calls = [];
let listener;

assert.equal(manifest.version, '1.1.0');
assert.ok(manifest.content_scripts.some(entry => entry.js.includes('content.js')));
for (const iconPath of Object.values(manifest.icons)) {
  assert.ok(fs.existsSync(path.join(root, iconPath)), `manifest icon exists: ${iconPath}`);
}
assert.match(content, /Hľadať lepšiu kvalitu/);
assert.match(content, /QUALITY_HUNT_START/);
assert.match(content, /QUALITY_HUNT_POLL/);
assert.match(content, /QUALITY_HUNT_CANCEL/);
assert.match(content, /mode === 'deep' \? 'deep' : 'quick'/);

const chrome = {
  webRequest: { onBeforeRequest: { addListener() {} } },
  tabs: { onRemoved: { addListener() {} } },
  runtime: { onMessage: { addListener(fn) { listener = fn; } } },
  storage: { local: { async get() { return { nexus_bridge_token: 'test-token' }; } } },
};
const sandbox = {
  chrome,
  console,
  Map,
  URL,
  AbortSignal,
  setTimeout,
  clearTimeout,
  fetch: async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/health')) {
      return { ok: String(url).includes(':8000'), json: async () => ({}) };
    }
    if (options.method === 'POST' && String(url).endsWith('/api/v1/quality-hunt')) {
      return { ok: true, json: async () => ({ job_id: 'job-1' }) };
    }
    if (String(url).endsWith('/api/v1/quality-hunt/job-1')) {
      return { ok: true, json: async () => ({ status: 'done', groups: { better: [] } }) };
    }
    if (String(url).endsWith('/api/v1/quality-hunt/job-1/cancel')) {
      return { ok: true, json: async () => ({ status: 'cancelled' }) };
    }
    return { ok: false, status: 500, json: async () => ({ detail: 'test failure' }) };
  },
};
vm.runInNewContext(background, sandbox, { filename: 'background.js' });

function send(message) {
  return new Promise((resolve, reject) => {
    const keepChannelOpen = listener(message, { tab: { id: 5 } }, resolve);
    if (!keepChannelOpen) reject(new Error('asynchronous handler did not keep the channel open'));
  });
}

(async () => {
  const started = await send({ type: 'QUALITY_HUNT_START', port: 8001, payload: { title: 'Diagnostic sample' } });
  assert.equal(started.ok, true);
  assert.equal(started.data.job_id, 'job-1');
  assert.equal(started.baseUrl, 'http://127.0.0.1:8000');
  const startCall = calls.find(call => call.url.endsWith('/api/v1/quality-hunt'));
  assert.equal(startCall.options.method, 'POST');
  assert.equal(startCall.options.headers['X-Nexus-Token'], 'test-token');

  const polled = await send({ type: 'QUALITY_HUNT_POLL', jobId: 'job-1', baseUrl: started.baseUrl });
  assert.equal(polled.ok, true);
  assert.equal(polled.data.status, 'done');
  assert.equal(calls.at(-1).url, 'http://127.0.0.1:8000/api/v1/quality-hunt/job-1');

  const cancelled = await send({ type: 'QUALITY_HUNT_CANCEL', jobId: 'job-1', baseUrl: started.baseUrl });
  assert.equal(cancelled.ok, true);
  assert.equal(calls.at(-1).options.method, 'POST');
  assert.equal(calls.at(-1).url, 'http://127.0.0.1:8000/api/v1/quality-hunt/job-1/cancel');
  console.log('Nexus Universal Importer quality hunt contract: passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
