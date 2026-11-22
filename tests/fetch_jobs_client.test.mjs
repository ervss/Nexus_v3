import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = fs.readFileSync('app/static/fetch_jobs.js', 'utf8');
function setup(fetch) {
    const storage = new Map();
    const context = vm.createContext({ window: {}, crypto: webcrypto, DOMException, AbortController,
        sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
        fetch, clearTimeout, setTimeout: (fn, ms) => setTimeout(fn, ms === 10000 ? ms : 0) });
    vm.runInContext(source, context);
    return { client: context.window.NexusFetchJobs, storage };
}
const ok = data => ({ ok: true, json: async () => data });

// A disconnected/uncertain POST must reuse the persisted idempotency key.
{
    const keys = [];
    const { client } = setup(async (url, options) => {
        keys.push(JSON.parse(options.body).request_key);
        if (keys.length === 1) throw new TypeError('connection lost after accepting POST');
        return ok({ job_id: 'durable-1' });
    });
    await assert.rejects(client.start({ urls: ['https://bunkr.cr/a/a'], mode: 'index' }));
    assert.equal(await client.start({ urls: ['https://bunkr.cr/a/a'], mode: 'index' }), 'durable-1');
    assert.equal(keys[0], keys[1]);
}

// Replay is ordered and deduplicated even across a failed polling call.
{
    let calls = 0;
    const { client } = setup(async () => {
        calls++;
        if (calls === 1) return ok({ state: 'running', events: [{ seq: 1, type: 'listing' }], has_more: true });
        if (calls === 2) throw new TypeError('network offline');
        return ok({ state: 'completed', events: [{ seq: 1, type: 'listing' }, { seq: 2, type: 'patch' }], has_more: false });
    });
    const seen = [];
    const status = await client.watch('job', event => seen.push(event.seq));
    assert.deepEqual(seen, [1, 2]);
    assert.equal(status.state, 'completed');
}

// Leaving the viewer aborts monitoring without sending a server cancellation.
{
    const paths = [];
    const { client } = setup((url, options) => {
        paths.push(url);
        return new Promise((resolve, reject) => options.signal.addEventListener('abort',
            () => reject(new DOMException('Aborted', 'AbortError'))));
    });
    const controller = new AbortController();
    const watch = client.watch('job', () => {}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(watch, { name: 'AbortError' });
    assert.equal(paths.length, 1);
    assert.ok(!paths.some(path => path.includes('/cancel')));
}

console.log('Fetch client: idempotency, replay, reconnect and detach passed.');
