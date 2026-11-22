// ============================================================
// Nexus Video Card Selector — Popup Script
// ============================================================

const PORTS = ['8000', '8001', '8002'];

function normalizeHost(value) {
  if (!value) return '';
  try {
    const raw = String(value).trim();
    const parsed = raw.includes('://') ? new URL(raw).hostname : raw;
    return parsed.replace(/^www\./i, '').toLowerCase();
  } catch {
    return String(value).replace(/^www\./i, '').toLowerCase().trim();
  }
}

async function getActiveTabInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return { tab: null, host: '', isSupported: false };
    if (/^(chrome|edge|brave|about|chrome-extension):/i.test(tab.url)) {
      return { tab, host: '', isSupported: false };
    }
    const host = normalizeHost(tab.url);
    return { tab, host, isSupported: Boolean(host) };
  } catch {
    return { tab: null, host: '', isSupported: false };
  }
}

// ── Inicializácia ─────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await loadScanOptions();
  await loadPanelState();
  await refreshPopup();
  checkPorts();
  setupListeners();
  const liveInterval = setInterval(refreshPopup, 500);
  window.addEventListener('unload', () => clearInterval(liveInterval));
});

async function refreshPopup() {
  await Promise.all([loadStats(), loadScanStatus()]);
}

// ── Settings ──────────────────────────────────────────────

async function loadSettings() {
  const { host, isSupported } = await getActiveTabInfo();
  const toggle = document.getElementById('toggle-enabled');

  const data = await chrome.storage.sync.get({
    disabledHosts: [],
    enabled: true,
    ports: { '8000': '8000', '8001': '8001', '8002': '8002' }
  });

  // Migrácia z predošlého globálneho vypínania: zabezpečíme globálny enabled=true
  if (data.enabled === false) {
    await chrome.storage.sync.set({ enabled: true });
  }

  if (!isSupported || !host) {
    toggle.classList.remove('active');
    toggle.disabled = true;
    toggle.title = 'Rozšírenie nemožno spustiť na tomto type stránky';
  } else {
    toggle.disabled = false;
    const disabledList = (data.disabledHosts || []).map(normalizeHost);
    const isHostDisabled = disabledList.includes(host);
    toggle.classList.toggle('active', !isHostDisabled);
    toggle.title = isHostDisabled
      ? `Aktivovať rozšírenie na ${host}`
      : `Vypnúť rozšírenie na ${host}`;
  }

  for (const port of PORTS) {
    const input = document.getElementById(`port-${port}`);
    if (input && data.ports?.[port]) input.value = data.ports[port];
  }
}

async function savePorts() {
  const ports = {};
  for (const port of PORTS) {
    const input = document.getElementById(`port-${port}`);
    if (input) ports[port] = input.value.trim() || port;
  }
  await chrome.storage.sync.set({ ports });
}

async function toggleHostEnabled() {
  const { tab, host, isSupported } = await getActiveTabInfo();
  const toggle = document.getElementById('toggle-enabled');
  if (!isSupported || !host || !tab?.id) return;

  const willBeActive = !toggle.classList.contains('active');
  toggle.classList.toggle('active', willBeActive);

  const data = await chrome.storage.sync.get({ disabledHosts: [] });
  let disabledHosts = (data.disabledHosts || []).map(normalizeHost).filter(Boolean);

  if (willBeActive) {
    disabledHosts = disabledHosts.filter(h => h !== host);
    await chrome.storage.sync.set({ disabledHosts, enabled: true });
    toggle.title = `Vypnúť rozšírenie na ${host}`;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { action: 'enableOnPage' });
      if (!res?.ok) throw new Error('not-ok');
    } catch {
      await enableHostAndInject(tab);
    }
  } else {
    if (!disabledHosts.includes(host)) {
      disabledHosts.push(host);
    }
    await chrome.storage.sync.set({ disabledHosts, enabled: true });
    toggle.title = `Aktivovať rozšírenie na ${host}`;
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'disableOnPage' });
    } catch {}
  }

  await loadPanelState();
  await refreshPopup();
}

async function loadScanOptions() {
  const data = await chrome.storage.sync.get({
    nvsIgnoreCache: true,
    nvsRetryLocked: false,
  });
  document.getElementById('opt-ignore-cache').checked = data.nvsIgnoreCache !== false;
  document.getElementById('opt-retry-locked').checked = Boolean(data.nvsRetryLocked);
}

async function saveScanOptions() {
  await chrome.storage.sync.set({
    nvsIgnoreCache: document.getElementById('opt-ignore-cache').checked,
    nvsRetryLocked: document.getElementById('opt-retry-locked').checked,
  });
}

// ── Panel visibility ──────────────────────────────────────

async function loadPanelState() {
  const btn = document.getElementById('toggle-panel');
  const { tab, host, isSupported } = await getActiveTabInfo();

  if (!isSupported || !host) {
    btn.classList.remove('active');
    btn.disabled = true;
    return;
  }
  btn.disabled = false;

  try {
    const data = await chrome.storage.sync.get({
      hiddenPanelHosts: [],
      disabledHosts: []
    });
    const hiddenHosts = (data.hiddenPanelHosts || []).map(normalizeHost);
    const disabledHosts = (data.disabledHosts || []).map(normalizeHost);

    const isHostDisabled = disabledHosts.includes(host);
    const isPanelHidden = hiddenHosts.includes(host);

    if (isHostDisabled) {
      btn.classList.remove('active');
      btn.title = `Rozšírenie je na ${host} vypnuté`;
      return;
    }

    // Predvolene pre každú novú stránku je panel viditeľný, pokiaľ nie je v hiddenPanelHosts
    let visible = !isPanelHidden;

    if (tab?.id) {
      try {
        const result = await chrome.tabs.sendMessage(tab.id, { action: 'getPanelVisible' });
        if (typeof result?.visible === 'boolean') {
          visible = result.visible;
          // Zosynchronizuj storage ak sa živý stav líši
          if (visible && isPanelHidden) {
            const next = hiddenHosts.filter(h => h !== host);
            await chrome.storage.sync.set({ hiddenPanelHosts: next });
          } else if (!visible && !isPanelHidden) {
            hiddenHosts.push(host);
            await chrome.storage.sync.set({ hiddenPanelHosts: hiddenHosts });
          }
        }
      } catch {
        // Content script sa ešte načítava; ponecháme predvolený stav zo storage
      }
    }

    btn.classList.toggle('active', visible);
    btn.title = visible
      ? `Skryť Filter / Sort panel na ${host}`
      : `Zobraziť Filter / Sort panel na ${host}`;
  } catch (e) {
    console.error('loadPanelState error', e);
  }
}

async function setPanelVisible(visible) {
  const { tab, host, isSupported } = await getActiveTabInfo();
  if (!isSupported || !host || !tab?.id) return;

  try {
    const data = await chrome.storage.sync.get({ hiddenPanelHosts: [] });
    let hiddenHosts = (data.hiddenPanelHosts || []).map(normalizeHost).filter(Boolean);
    if (visible) {
      hiddenHosts = hiddenHosts.filter(h => h !== host);
    } else {
      if (!hiddenHosts.includes(host)) hiddenHosts.push(host);
    }
    await chrome.storage.sync.set({ hiddenPanelHosts: hiddenHosts });
  } catch (e) {
    console.error('setPanelVisible storage error', e);
  }

  if (visible) {
    const data = await chrome.storage.sync.get({ disabledHosts: [] });
    const disabledHosts = (data.disabledHosts || []).map(normalizeHost);
    if (disabledHosts.includes(host)) {
      await enableHostAndInject(tab);
    }
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'setPanelVisible', visible });
  } catch {
    if (visible) {
      await enableHostAndInject(tab);
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'setPanelVisible', visible });
      } catch {}
    }
  }

  const btn = document.getElementById('toggle-panel');
  btn.classList.toggle('active', visible);
  btn.title = visible
    ? `Skryť Filter / Sort panel na ${host}`
    : `Zobraziť Filter / Sort panel na ${host}`;
}

// Odoberie host z disabledHosts a v prípade potreby injektuje skripty
async function enableHostAndInject(tab) {
  const host = normalizeHost(tab?.url);
  if (!host || !tab?.id) return;

  // 1) Odoberieme host z disabledHosts
  try {
    const { disabledHosts = [] } = await chrome.storage.sync.get({ disabledHosts: [] });
    const next = disabledHosts.map(normalizeHost).filter(h => h && h !== host);
    if (next.length !== disabledHosts.length) {
      await chrome.storage.sync.set({ disabledHosts: next, enabled: true });
    }
  } catch {}

  const t = document.getElementById('toggle-enabled');
  if (t) t.classList.add('active');

  // 2) Skontrolujeme, či content script žije
  let alive = false;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'enableOnPage' });
    if (res?.ok) alive = true;
  } catch { alive = false; }

  // 3) Ak neodpovedá, injektujeme všetky potrebné skripty
  if (!alive) {
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['styles.css', 'listing-player.css']
      });
    } catch {}
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
          'overview.js',
          'import-workbench.js',
          'xhamster-listing.js',
          'xhamster-layout.js',
          'xvideos-listing.js',
          'spankbang-listing.js',
          'pimpbunny-listing.js',
          'vendor/hls.min.js',
          'whoreshub-player.js',
          'listing-player-sites.js',
          'whoreshub-listing.js',
          'scan-hud.js',
          'content.js'
        ]
      });
      await new Promise(r => setTimeout(r, 250));
    } catch {}
  }
}

// ── Stats zo stránky ──────────────────────────────────────

async function loadStats() {
  try {
    const { tab, host, isSupported } = await getActiveTabInfo();
    if (!tab?.id || !isSupported) {
      document.getElementById('stat-cards').textContent = '–';
      return;
    }

    const { disabledHosts = [] } = await chrome.storage.sync.get({ disabledHosts: [] });
    if ((disabledHosts || []).map(normalizeHost).includes(host)) {
      document.getElementById('stat-cards').textContent = '0';
      document.getElementById('stat-selected').textContent = '0';
      document.getElementById('stat-fetched').textContent = '0';
      document.getElementById('stat-no-size').textContent = '0';
      document.getElementById('stat-no-date').textContent = '0';
      return;
    }

    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const cards = document.querySelectorAll('[data-nvs-processed="1"]');
        const selected = document.querySelectorAll('.nvs-card-selected');
        
        let fetched = 0;
        let noSize = 0;
        let noDate = 0;
        let totalQueued = 0;
        let queueLength = 0;
        
        if (window.__nvsState) {
          totalQueued = window.__nvsState.queuedUrls.size;
          queueLength = window.__nvsState.queue.length;
          
          for (const meta of window.__nvsState.fetchCache.values()) {
            if (!meta) continue;
            fetched++;
            if (!meta.sizeMb) noSize++;
            if (!meta.date && !meta.relDate) noDate++;
          }
        } else {
          const badges = document.querySelectorAll('.nvs-badge:not(.nvs-badge-loading):not(.nvs-badge-quality)');
          fetched = badges.length;
          
          badges.forEach(b => {
            const text = b.textContent.trim();
            if (!/MB|GB|MiB|GiB/i.test(text)) noSize++;
            if (!/\d{4}|ago|yesterday|today|•/i.test(text)) noDate++;
          });
          
          const loading = document.querySelectorAll('.nvs-badge-loading').length;
          queueLength = loading;
          totalQueued = fetched + loading;
        }

        return {
          cards: cards.length,
          selected: selected.length,
          fetched,
          noSize,
          noDate,
          totalQueued,
          queueLength
        };
      }
    });

    const stats = result?.[0]?.result;
    if (stats) {
      document.getElementById('stat-cards').textContent = stats.cards || 0;
      document.getElementById('stat-selected').textContent = stats.selected || 0;
      document.getElementById('stat-fetched').textContent = stats.fetched || 0;
      document.getElementById('stat-no-size').textContent = stats.noSize || 0;
      document.getElementById('stat-no-date').textContent = stats.noDate || 0;
    }
  } catch (e) {
    document.getElementById('stat-cards').textContent = 'N/A';
  }
}

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0.0 s';
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60000);
  return `${minutes}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
}

function shortLogUrl(value) {
  try {
    const url = new URL(value);
    return url.pathname.split('/').filter(Boolean).slice(-1)[0] || url.hostname;
  } catch { return ''; }
}

async function loadScanStatus() {
  const dot = document.getElementById('status-dot');
  const title = document.getElementById('status-title');
  const timer = document.getElementById('status-time');
  const summary = document.getElementById('status-summary');
  const log = document.getElementById('status-log');
  const missingButton = document.getElementById('btn-fetch-missing');
  const rescanButton = document.getElementById('btn-rescan');
  const progress = document.getElementById('scan-progress');

  const { tab, host, isSupported } = await getActiveTabInfo();
  if (!isSupported || !host || !tab?.id) {
    dot.className = 'status-dot';
    title.textContent = 'Nepodporovaná stránka';
    timer.textContent = '–';
    summary.textContent = 'Rozšírenie na tejto stránke nie je aktívne.';
    document.getElementById('scan-status')?.setAttribute('aria-busy', 'false');
    if (progress) { progress.hidden = true; progress.value = 0; }
    missingButton.disabled = true;
    rescanButton.disabled = true;
    return;
  }

  const { disabledHosts = [] } = await chrome.storage.sync.get({ disabledHosts: [] });
  if ((disabledHosts || []).map(normalizeHost).includes(host)) {
    dot.className = 'status-dot';
    title.textContent = 'Vypnuté na tejto stránke';
    timer.textContent = '–';
    summary.textContent = `Rozšírenie je deaktivované pre ${host}.`;
    document.getElementById('scan-status')?.setAttribute('aria-busy', 'false');
    if (progress) { progress.hidden = true; progress.value = 0; }
    missingButton.disabled = true;
    rescanButton.disabled = true;
    return;
  }

  try {
    const status = await chrome.tabs.sendMessage(tab.id, { action: 'getScanStatus' });
    if (!status) throw new Error('no-status');

    const end = status.active ? Date.now() : (status.finishedAt || Date.now());
    const elapsed = status.startedAt ? end - status.startedAt : 0;
    timer.textContent = formatElapsed(elapsed);
    if (status.startedAt) timer.dateTime = new Date(status.startedAt).toISOString();
    else timer.removeAttribute('datetime');
    title.textContent = status.active
      ? `${status.label} (${status.done}/${status.total || '?'})`
      : status.label || 'Pripravené';
    dot.className = `status-dot ${status.active ? 'running' : (status.startedAt ? 'done' : '')}`;
    summary.textContent = `Cache: ${status.cacheHits} · Sieť: ${status.network} · Fronta: ${status.queueLength} · LOCKED: ${status.locked}`;
    document.getElementById('scan-status').setAttribute('aria-busy', status.active ? 'true' : 'false');
    missingButton.disabled = Boolean(status.active);
    rescanButton.disabled = Boolean(status.active);

    if (status.active && status.total > 0) {
      progress.hidden = false;
      progress.max = status.total;
      progress.value = Math.min(status.done, status.total);
    } else {
      progress.hidden = true;
      progress.value = 0;
    }

    const entries = Array.isArray(status.logs) ? status.logs : [];
    const signature = entries.map(entry => `${entry.ts}|${entry.type}|${entry.message}|${entry.url || ''}`).join('\n');
    if (log.dataset.signature !== signature) {
      log.dataset.signature = signature;
      log.replaceChildren();
      if (!entries.length) {
        const row = document.createElement('div');
        row.className = 'log-row';
        row.textContent = 'Zatiaľ žiadne udalosti.';
        log.appendChild(row);
      } else {
        for (const entry of entries) {
          const row = document.createElement('div');
          row.className = `log-row ${entry.type || ''}`;
          const time = new Date(entry.ts || Date.now()).toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          const target = shortLogUrl(entry.url);
          row.textContent = `[${time}] ${entry.message}${target ? ` · ${target}` : ''}`;
          log.appendChild(row);
        }
        log.scrollTop = log.scrollHeight;
      }
    }
  } catch {
    dot.className = 'status-dot';
    title.textContent = 'Content script nie je dostupný';
    timer.textContent = '–';
    summary.textContent = 'Obnov stránku alebo zapni rozšírenie na tomto webe.';
    document.getElementById('scan-status')?.setAttribute('aria-busy', 'false');
    if (progress) {
      progress.hidden = true;
      progress.value = 0;
    }
    missingButton.disabled = true;
    rescanButton.disabled = false;
  }
}

// ── Port availability check ───────────────────────────────

async function checkPorts() {
  for (const port of PORTS) {
    const dot = document.getElementById(`dot-${port}`);
    const input = document.getElementById(`port-${port}`);
    if (!dot || !input) continue;

    const actualPort = input.value.trim() || port;
    dot.className = 'port-dot checking';

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`http://localhost:${actualPort}/health`, {
        signal: controller.signal
      });
      clearTimeout(timeout);
      dot.className = res.ok ? 'port-dot' : 'port-dot error';
    } catch {
      dot.className = 'port-dot error';
    }
  }
}

// ── Event listeners ───────────────────────────────────────

function setupListeners() {
  // Toggle extension per host
  document.getElementById('toggle-enabled').addEventListener('click', toggleHostEnabled);

  // Toggle filter/sort panel per host
  document.getElementById('toggle-panel').addEventListener('click', async function() {
    this.classList.toggle('active');
    await setPanelVisible(this.classList.contains('active'));
  });

  // Port inputs
  for (const port of PORTS) {
    const input = document.getElementById(`port-${port}`);
    if (input) {
      input.addEventListener('change', () => {
        savePorts();
        checkPorts();
      });
    }
  }

  document.getElementById('opt-ignore-cache').addEventListener('change', saveScanOptions);
  document.getElementById('opt-retry-locked').addEventListener('change', saveScanOptions);

  document.getElementById('btn-fetch-missing').addEventListener('click', async () => {
    const btn = document.getElementById('btn-fetch-missing');
    btn.textContent = 'Zaraďujem…';
    btn.disabled = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        const result = await chrome.tabs.sendMessage(tab.id, {
          action: 'fetchMissingSizes',
          options: {
            ignoreCache: document.getElementById('opt-ignore-cache').checked,
            retryLocked: document.getElementById('opt-retry-locked').checked,
          },
        });
        if (result?.busy) btn.textContent = 'Scan ešte beží';
      }
    } catch {
      btn.textContent = 'Stránka neodpovedá';
    }
    setTimeout(() => { btn.textContent = 'Doplniť chýbajúce'; }, 800);
    await refreshPopup();
  });

  // Rescan button
  document.getElementById('btn-rescan').addEventListener('click', async () => {
    const btn = document.getElementById('btn-rescan');
    btn.textContent = 'Skenujem…';
    btn.disabled = true;

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            document.querySelectorAll('[data-nvs-processed]').forEach(el => {
              el.removeAttribute('data-nvs-processed');
              el.querySelector?.('.nvs-selector-wrap')?.remove();
              el.querySelector?.('.nvs-badge')?.remove();
              el.querySelector?.('.nvs-badge-quality')?.remove();
              el.querySelector?.('.nvs-duration-badge')?.remove();
              el.classList.remove('nvs-card-selected');
            });
            if (window.__nvsRescan) window.__nvsRescan();
            else if (window.__nvsScan) window.__nvsScan();
          }
        });

        await new Promise(r => setTimeout(r, 200));
        await loadStats();
      }
    } catch {}

    btn.textContent = 'Skenovať všetko';
    btn.disabled = false;
  });
}
