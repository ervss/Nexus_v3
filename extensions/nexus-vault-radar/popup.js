'use strict';

(function () {
  const connStatus = document.getElementById('connStatus');
  const queryInput = document.getElementById('queryInput');
  const probeForm = document.getElementById('probeForm');
  const libCount = document.getElementById('libCount');
  const locCount = document.getElementById('locCount');
  const vaultCount = document.getElementById('vaultCount');
  const resultsList = document.getElementById('resultsList');
  const followBtn = document.getElementById('followBtn');
  const openVaultBtn = document.getElementById('openVaultBtn');
  const baseUrlInput = document.getElementById('baseUrlInput');
  const tokenInput = document.getElementById('tokenInput');

  let activeBase = 'http://127.0.0.1:8000';

  function runProbe(q) {
    connStatus.textContent = 'Skenujem...';
    chrome.runtime.sendMessage(
      { type: 'NVR_PROBE', payload: { query: q || '' } },
      resp => {
        if (!resp || !resp.ok) {
          connStatus.textContent = 'Offline';
          resultsList.innerHTML = `<div class="item"><span class="item-t">${resp?.error || 'Server nedostupný'}</span></div>`;
          return;
        }
        activeBase = resp.baseUrl || activeBase;
        connStatus.textContent = activeBase.replace(/^https?:\/\//, '');
        const d = resp.data || {};
        libCount.textContent = String(d.library_count || 0);
        locCount.textContent = String(d.library_local_count || 0);
        vaultCount.textContent = String(d.vault_count || 0);
        followBtn.textContent = d.is_followed ? '★ Sledovaný' : '📌 Pripnúť do Radaru';

        const rows = [
          ...(d.library_samples || []).map(v => ({ title: v.title, tag: v.quality || 'Lib' })),
          ...(d.vault_samples || []).map(v => ({ title: v.title, tag: v.source_label || v.bucket || 'Vault' })),
        ].slice(0, 6);

        resultsList.innerHTML = '';
        for (const r of rows) {
          const row = document.createElement('div');
          row.className = 'item';
          const t = document.createElement('span');
          t.className = 'item-t';
          t.textContent = r.title;
          const tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = r.tag;
          row.append(t, tag);
          resultsList.appendChild(row);
        }
      }
    );
  }

  chrome.storage.local.get(['nexusBaseUrl', 'nexusBridgeToken', 'activeNexusBase'], cfg => {
    baseUrlInput.value = cfg.nexusBaseUrl || cfg.activeNexusBase || 'http://127.0.0.1:8000';
    tokenInput.value = cfg.nexusBridgeToken || '';
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tabTitle = (tabs?.[0]?.title || '').replace(/\s*[-|].*$/, '').trim().slice(0, 100);
      queryInput.value = tabTitle;
      runProbe(tabTitle);
    });
  });

  probeForm.addEventListener('submit', ev => {
    ev.preventDefault();
    runProbe(queryInput.value.trim());
  });

  followBtn.addEventListener('click', () => {
    const q = queryInput.value.trim();
    if (q.length < 2) return;
    chrome.runtime.sendMessage({ type: 'NVR_FOLLOW', payload: { name: q } }, resp => {
      if (resp && resp.ok) followBtn.textContent = '★ Pripnuté!';
    });
  });

  openVaultBtn.addEventListener('click', () => {
    const q = queryInput.value.trim();
    const url = q ? `${activeBase}/vault?q=${encodeURIComponent(q)}` : `${activeBase}/vault`;
    chrome.tabs.create({ url });
  });

  const saveConfig = () => {
    chrome.storage.local.set({
      nexusBaseUrl: baseUrlInput.value.trim().replace(/\/+$/, ''),
      nexusBridgeToken: tokenInput.value.trim(),
    });
  };
  baseUrlInput.addEventListener('change', saveConfig);
  tokenInput.addEventListener('change', saveConfig);
})();
