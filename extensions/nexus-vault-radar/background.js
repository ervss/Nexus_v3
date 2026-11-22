'use strict';

const DEFAULT_BASES = ['http://127.0.0.1:8000', 'http://127.0.0.1:8010', 'http://localhost:8000'];

async function getConfig() {
  const saved = await chrome.storage.local.get(['nexusBaseUrl', 'nexusBridgeToken']);
  return {
    baseUrl: String(saved.nexusBaseUrl || '').trim().replace(/\/+$/, ''),
    token: String(saved.nexusBridgeToken || '').trim(),
  };
}

async function requestCompanion(path, payload) {
  const { baseUrl, token } = await getConfig();
  const candidates = baseUrl ? [baseUrl, ...DEFAULT_BASES.filter(b => b !== baseUrl)] : DEFAULT_BASES;
  let lastError = 'Nexus server nedostupný';

  for (const candidate of candidates) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['X-Nexus-Token'] = token;
      const res = await fetch(`${candidate}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload || {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastError = data.detail || `HTTP ${res.status}`;
        continue;
      }
      await chrome.storage.local.set({ activeNexusBase: candidate });
      return { ok: true, baseUrl: candidate, data };
    } catch (err) {
      lastError = err?.message || String(err);
    }
  }
  return { ok: false, error: lastError };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return false;
  if (message.type === 'NVR_PROBE') {
    requestCompanion('/api/v1/companion/probe', message.payload).then(sendResponse);
    return true;
  }
  if (message.type === 'NVR_FOLLOW') {
    requestCompanion('/api/v1/companion/follow', message.payload).then(sendResponse);
    return true;
  }
  return false;
});
