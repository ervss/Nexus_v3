(function (root) {
  'use strict';

  const DEFAULT_BASE = 'http://127.0.0.1:8000';
  const DEFAULT_CANDIDATES = [
    'http://127.0.0.1:8000',
    'http://localhost:8000',
    'http://127.0.0.1:8001',
    'http://127.0.0.1:8002',
    'http://127.0.0.1:5000',
  ];
  const QUEUE_KEY = 'nexus_offline_import_queue_v1';

  function normalizeBaseUrl(url) {
    return String(url || DEFAULT_BASE).trim().replace(/\/+$/, '');
  }

  function createAbortSignal(timeoutMs, externalSignal) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' && !externalSignal) {
      return { signal: AbortSignal.timeout(timeoutMs), cleanup: () => {} };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Request timeout')), timeoutMs);
    const onExternalAbort = () => controller.abort(externalSignal.reason);
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort(externalSignal.reason);
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(timer);
        if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
      },
    };
  }

  async function probeHealth(baseUrl, options = {}) {
    const fetchImpl = options.fetch || globalThis.fetch;
    const timeoutMs = Number(options.timeoutMs) || 2000;
    const cleanBase = normalizeBaseUrl(baseUrl);
    const started = Date.now();
    for (const path of ['/api/health', '/health']) {
      const { signal, cleanup } = createAbortSignal(timeoutMs, options.signal);
      try {
        const res = await fetchImpl(`${cleanBase}${path}`, { method: 'GET', signal });
        if (res && res.ok) {
          const data = await res.json().catch(() => ({}));
          return {
            ok: true,
            status: res.status,
            baseUrl: cleanBase,
            endpoint: path,
            latencyMs: Date.now() - started,
            service: data.service || data.status || 'Nexus',
            data,
          };
        }
        if (res && res.status === 404) continue;
        return {
          ok: false,
          status: res ? res.status : 0,
          baseUrl: cleanBase,
          endpoint: path,
          latencyMs: Date.now() - started,
          error: `HTTP ${res ? res.status : 'error'}`,
        };
      } catch (err) {
        if (path === '/health') {
          return {
            ok: false,
            status: 0,
            baseUrl: cleanBase,
            endpoint: path,
            latencyMs: Date.now() - started,
            offline: true,
            error: err?.message || 'Network error',
          };
        }
      } finally {
        cleanup();
      }
    }
    return {
      ok: false,
      status: 0,
      baseUrl: cleanBase,
      latencyMs: Date.now() - started,
      offline: true,
      error: 'Health endpoint unavailable',
    };
  }

  async function discoverServerBase(candidates = DEFAULT_CANDIDATES, options = {}) {
    const unique = [...new Set((candidates || []).filter(Boolean).map(normalizeBaseUrl))];
    for (const base of unique) {
      const result = await probeHealth(base, options);
      if (result.ok) return result;
    }
    return { ok: false, baseUrl: unique[0] || DEFAULT_BASE, offline: true };
  }

  async function postJsonWithFallback(baseUrl, endpoints, payload, options = {}) {
    const fetchImpl = options.fetch || globalThis.fetch;
    const timeoutMs = Number(options.timeoutMs) || 10000;
    const cleanBase = normalizeBaseUrl(baseUrl);
    const headers = {
      'Content-Type': 'application/json',
      ...(options.token ? { 'X-Nexus-Token': options.token } : {}),
      ...(options.headers || {}),
    };
    const paths = Array.isArray(endpoints) && endpoints.length ? endpoints : ['/api/v1/intake/import', '/api/lite/quick-import'];

    let lastErr = null;
    for (let i = 0; i < paths.length; i += 1) {
      const path = paths[i];
      const { signal, cleanup } = createAbortSignal(timeoutMs, options.signal);
      try {
        const res = await fetchImpl(`${cleanBase}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal,
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          return { ok: true, status: res.status, endpoint: path, data };
        }
        if (res.status === 404 && i < paths.length - 1) {
          continue;
        }
        const err = new Error(data.detail || data.message || `HTTP ${res.status}`);
        err.status = res.status;
        err.data = data;
        err.isNetwork = false;
        throw err;
      } catch (err) {
        if (err && typeof err.status === 'number') {
          lastErr = err;
          break;
        }
        const netErr = new Error(err?.message || 'Server unreachable');
        netErr.isNetwork = true;
        lastErr = netErr;
        break;
      } finally {
        cleanup();
      }
    }
    throw lastErr || new Error('Request failed');
  }

  function createMemoryStorage(initial = {}) {
    const store = { ...initial };
    return {
      async get(key) {
        return { [key]: store[key] };
      },
      async set(obj) {
        Object.assign(store, obj);
      },
    };
  }

  function resolveStorage(storage) {
    if (storage && typeof storage.get === 'function' && typeof storage.set === 'function') {
      return storage;
    }
    if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
      return chrome.storage.local;
    }
    return createMemoryStorage();
  }

  class OfflineImportQueue {
    constructor(options = {}) {
      this.storage = resolveStorage(options.storage);
      this.key = options.storageKey || QUEUE_KEY;
      this.maxItems = Number(options.maxItems) || 200;
    }

    async list() {
      const data = await this.storage.get(this.key);
      const items = data?.[this.key];
      return Array.isArray(items) ? items : [];
    }

    async save(items) {
      await this.storage.set({ [this.key]: items.slice(0, this.maxItems) });
    }

    async count() {
      const items = await this.list();
      return items.length;
    }

    async clear() {
      await this.save([]);
    }

    async enqueue(entry) {
      const items = await this.list();
      const urls = Array.isArray(entry?.payload?.urls)
        ? entry.payload.urls
        : entry?.payload?.url
          ? [entry.payload.url]
          : [];
      const fingerprint = `${(entry.endpoints || []).join('|')}::${urls.join('|')}`;
      const existingIdx = items.findIndex((it) => it.fingerprint === fingerprint);
      const record = {
        id: existingIdx >= 0 ? items[existingIdx].id : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        fingerprint,
        source: entry.source || 'extension',
        endpoints: entry.endpoints || ['/api/v1/intake/import', '/api/lite/quick-import'],
        payload: entry.payload || {},
        createdAt: existingIdx >= 0 ? items[existingIdx].createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: existingIdx >= 0 ? (items[existingIdx].attempts || 0) : 0,
        lastError: entry.lastError || '',
      };
      if (existingIdx >= 0) items[existingIdx] = record;
      else items.push(record);
      await this.save(items);
      return { record, queueLength: items.length };
    }

    async flush(baseUrl, options = {}) {
      const items = await this.list();
      if (!items.length) {
        return { ok: true, sent: 0, failed: 0, remaining: 0, offline: false };
      }
      const health = await probeHealth(baseUrl, options);
      if (!health.ok) {
        return { ok: false, sent: 0, failed: 0, remaining: items.length, offline: true, health };
      }

      const remaining = [];
      let sent = 0;
      let failed = 0;
      for (const item of items) {
        try {
          await postJsonWithFallback(baseUrl, item.endpoints, item.payload, options);
          sent += 1;
        } catch (err) {
          failed += 1;
          remaining.push({
            ...item,
            attempts: (item.attempts || 0) + 1,
            updatedAt: new Date().toISOString(),
            lastError: err?.message || 'Retry failed',
          });
        }
      }
      await this.save(remaining);
      return {
        ok: failed === 0,
        sent,
        failed,
        remaining: remaining.length,
        offline: false,
        health,
      };
    }
  }

  const api = {
    DEFAULT_BASE,
    DEFAULT_CANDIDATES,
    QUEUE_KEY,
    normalizeBaseUrl,
    probeHealth,
    discoverServerBase,
    postJsonWithFallback,
    OfflineImportQueue,
    createMemoryStorage,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.NexusBridge = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
