(() => {
  'use strict';

  if (document.getElementById('nvrExtensionHud')) return;

  function normUrl(raw) {
    try {
      const u = new URL(String(raw || ''), window.location.href);
      if (!/^https?:$/i.test(u.protocol)) return '';
      u.hash = '';
      return u.href.replace(/\/+$/, '');
    } catch {
      return '';
    }
  }

  function detectQuery() {
    const sel = String(window.getSelection?.() || '').trim();
    if (sel.length >= 2 && sel.length <= 120) return sel;
    const h1 = document.querySelector('h1')?.textContent || document.title || '';
    return h1.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  function collectCandidates() {
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const url = normUrl(a.getAttribute('href'));
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({ url, title: (a.textContent || '').trim().slice(0, 120) });
      if (out.length >= 60) break;
    }
    return out;
  }

  function markLinks(urlMatches) {
    if (!urlMatches) return;
    for (const a of document.querySelectorAll('a[href]')) {
      if (a.dataset.nvrExtMarked === '1') continue;
      const hit = urlMatches[normUrl(a.getAttribute('href'))] || urlMatches[a.href];
      if (!hit) continue;
      a.dataset.nvrExtMarked = '1';
      const badge = document.createElement('span');
      badge.className = 'nvr-ext-badge';
      badge.textContent = `✓ Nexus ${hit.quality || 'Lib'}`;
      a.appendChild(badge);
    }
  }

  const hud = document.createElement('button');
  hud.type = 'button';
  hud.id = 'nvrExtensionHud';
  hud.className = 'nvr-ext-hud';
  hud.textContent = '✦ Nexus Radar';
  document.body.appendChild(hud);

  let activeBase = 'http://127.0.0.1:8000';
  let currentQuery = '';

  function runProbe(forceQuery = '') {
    currentQuery = forceQuery || detectQuery();
    chrome.runtime.sendMessage(
      {
        type: 'NVR_PROBE',
        payload: {
          query: currentQuery,
          page_url: normUrl(window.location.href),
          page_title: document.title || '',
          candidates: collectCandidates(),
        },
      },
      response => {
        if (!response || !response.ok) {
          hud.textContent = '✦ Nexus offline';
          return;
        }
        activeBase = response.baseUrl || activeBase;
        const d = response.data || {};
        const hits = Object.keys(d.url_matches || {}).length;
        markLinks(d.url_matches);
        hud.textContent = hits > 0
          ? `✦ Nexus ✓ ${hits} na stránke · ${d.vault_count || 0} Trezor`
          : `✦ Radar · ${d.library_count || 0} Lib · ${d.vault_count || 0} Vault`;
      }
    );
  }

  hud.addEventListener('click', () => {
    const q = detectQuery() || currentQuery;
    const target = q ? `${activeBase}/vault?q=${encodeURIComponent(q)}` : `${activeBase}/vault`;
    window.open(target, '_blank', 'noopener');
  });

  setTimeout(() => runProbe(), 1000);
})();
