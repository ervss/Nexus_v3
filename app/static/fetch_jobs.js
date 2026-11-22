/* Durable fetch client: only short HTTP calls; work survives browser disconnects. */
(() => {
    const terminal = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled']);
    const storageKey = 'nexus.fetchJobs.v1';
    const load = () => { try { return JSON.parse(sessionStorage.getItem(storageKey) || '{}'); } catch (_) { return {}; } };
    const save = value => { try { sessionStorage.setItem(storageKey, JSON.stringify(value)); } catch (_) { } };
    const signature = request => JSON.stringify([request.mode, request.limit || 0, [...new Set(request.urls)].sort()]);

    async function request(path, options = {}, signal) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(abort, 10000);
        try {
            const response = await fetch(`/api/v1/fetch-jobs${path}`, { ...options, signal: controller.signal });
            const data = await response.json();
            if (!response.ok) {
                const error = new Error(data.detail || `HTTP ${response.status}`);
                error.status = response.status;
                throw error;
            }
            return data;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
        }
    }

    function pause(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
            const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
            const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
            signal?.addEventListener('abort', abort, { once: true });
        });
    }

    window.NexusFetchJobs = {
        async start(input, signal) {
            const key = signature(input);
            const saved = load();
            const entry = saved[key] || { request_key: crypto.randomUUID() };
            saved[key] = entry;
            save(saved); // Persist before sending: an uncertain POST is safe to retry.
            const data = await request('', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...input, request_key: entry.request_key }) }, signal);
            entry.job_id = data.job_id;
            save(saved);
            return data.job_id;
        },
        async watch(jobId, onEvent, { signal, onStatus } = {}) {
            let cursor = 0;
            let failures = 0;
            while (!signal?.aborted) {
                let snapshot;
                try {
                    snapshot = await request(`/${encodeURIComponent(jobId)}?after=${cursor}`, {}, signal);
                    failures = 0;
                } catch (error) {
                    if (signal?.aborted || [401, 403, 404, 422].includes(error.status)) throw error;
                    onStatus?.({ state: 'reconnecting', counts: {} });
                    await pause(Math.min(15000, 500 * 2 ** Math.min(failures++, 5)) + Math.random()*250, signal);
                    continue;
                }
                for (const event of snapshot.events || []) {
                    if (event.seq <= cursor) continue;
                    await onEvent(event);
                    cursor = event.seq;
                }
                onStatus?.(snapshot);
                if (terminal.has(snapshot.state) && !snapshot.has_more) {
                    const saved = load();
                    for (const key of Object.keys(saved)) if (saved[key].job_id === jobId) delete saved[key];
                    save(saved);
                    return snapshot;
                }
                if (!snapshot.has_more) await pause(120, signal);
            }
            throw new DOMException('Aborted', 'AbortError');
        },
        async cancel(jobId) {
            const result = await request(`/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
            const saved = load();
            for (const key of Object.keys(saved)) if (saved[key].job_id === jobId) delete saved[key];
            save(saved);
            return result;
        },
    };
})();
