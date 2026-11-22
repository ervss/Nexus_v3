// ==UserScript==
// @name         Nexus Vault Radar (Web ↔ Library & Vault Companion)
// @namespace    nexus.vault.radar
// @version      1.0.0
// @description  Živý Obsidian Glass Radar na ľubovoľnej stránke: porovnáva odkazy a označené mená s Nexus Knižnicou a 945k Local Vaultom, označuje nájdené videá a pripína tvorcov do Creator Radaru.
// @author       Nexus Architecture Team
// @match        https://*/*
// @match        http://*/*
// @exclude      http://127.0.0.1*/*
// @exclude      http://localhost*/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function (root) {
  'use strict';

  const DEFAULT_BASE_URLS = ['http://127.0.0.1:8000', 'http://127.0.0.1:8010', 'http://localhost:8000'];
  const STORE_KEY_BASE = 'nvr_nexus_base_url';
  const STORE_KEY_TOKEN = 'nvr_nexus_bridge_token';
  const VIDEO_HINT_RE = /(\/v\/|\/video|\/watch|\/embed|\/view_video|\/albums?\/|\/a\/|\/d\/|bunkr|filester|eporner|xvideos|xhamster|pornhub|redgifs|whoreshub|simpcity)/i;

  function canonicalUrl(raw, originHint = '') {
    if (!raw || typeof raw !== 'string') return '';
    try {
      const parsed = originHint ? new URL(raw.trim(), originHint) : new URL(raw.trim());
      if (!/^https?:$/i.test(parsed.protocol)) return '';
      parsed.hash = '';
      return parsed.href.replace(/\/+$/, '');
    } catch {
      return '';
    }
  }

  function cleanCreatorCandidate(raw) {
    return String(raw || '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s*[|•—-]\s*(Watch|Free|HD|Full Video|Porn|Eporner|xHamster|XVideos|Bunkr).*$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  }

  function detectActiveQuery(doc, win) {
    const sel = win && typeof win.getSelection === 'function' ? String(win.getSelection() || '').trim() : '';
    if (sel && sel.length >= 2 && sel.length <= 120) {
      return cleanCreatorCandidate(sel);
    }
    const h1 = doc?.querySelector?.('h1')?.textContent || '';
    const title = doc?.title || '';
    return cleanCreatorCandidate(h1 || title);
  }

  function collectPageCandidates(doc, pageUrl = '', limit = 60) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    const seen = new Set();
    const results = [];
    const anchors = doc.querySelectorAll('a[href]');
    for (const a of anchors) {
      const href = canonicalUrl(a.getAttribute('href') || a.href || '', pageUrl || undefined);
      if (!href || seen.has(href)) continue;
      if (!VIDEO_HINT_RE.test(href) && results.length >= 20) continue;
      seen.add(href);
      const title = cleanCreatorCandidate(a.getAttribute('title') || a.textContent || '');
      results.push({ url: href, title });
      if (results.length >= limit) break;
    }
    return results;
  }

  function buildVaultLink(baseUrl, query) {
    const cleanBase = String(baseUrl || DEFAULT_BASE_URLS[0]).replace(/\/+$/, '');
    const q = String(query || '').trim();
    return q ? `${cleanBase}/vault?q=${encodeURIComponent(q)}` : `${cleanBase}/vault`;
  }

  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const pureExports = {
    DEFAULT_BASE_URLS,
    canonicalUrl,
    cleanCreatorCandidate,
    detectActiveQuery,
    collectPageCandidates,
    buildVaultLink,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = pureExports;
    return;
  }

  // Browser runtime below
  if (typeof document === 'undefined' || !document.body) return;
  if (document.getElementById('nexusVaultRadarHost')) return;

  function getSavedBaseUrl() {
    try {
      return typeof GM_getValue === 'function' ? GM_getValue(STORE_KEY_BASE, '') : '';
    } catch {
      return '';
    }
  }

  function saveBaseUrl(url) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(STORE_KEY_BASE, String(url || '').replace(/\/+$/, ''));
    } catch {}
  }

  function getBridgeToken() {
    try {
      return typeof GM_getValue === 'function' ? GM_getValue(STORE_KEY_TOKEN, '') : '';
    } catch {
      return '';
    }
  }

  function gmRequestJson(method, url, payload, token) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest unavailable'));
        return;
      }
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['X-Nexus-Token'] = token;
      GM_xmlhttpRequest({
        method,
        url,
        data: payload ? JSON.stringify(payload) : undefined,
        headers,
        timeout: 4500,
        onload: (resp) => {
          let data = {};
          try { data = JSON.parse(resp.responseText || '{}'); } catch {}
          if (resp.status >= 200 && resp.status < 300) resolve(data);
          else reject(new Error(data.detail || `HTTP ${resp.status}`));
        },
        onerror: () => reject(new Error('Nexus server nedostupný')),
        ontimeout: () => reject(new Error('Timeout pripojenia k Nexusu')),
      });
    });
  }

  async function callCompanion(path, payload) {
    const custom = getSavedBaseUrl();
    const candidates = custom ? [custom, ...DEFAULT_BASE_URLS.filter(u => u !== custom)] : DEFAULT_BASE_URLS;
    const token = getBridgeToken();
    let lastErr = null;
    for (const base of candidates) {
      try {
        const data = await gmRequestJson('POST', `${base}${path}`, payload, token);
        saveBaseUrl(base);
        return { base, data };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('Nexus server nedostupný');
  }

  // Shadow DOM UI (Obsidian Vision Glass)
  const host = document.createElement('div');
  host.id = 'nexusVaultRadarHost';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483640; font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif; }
      .nvr-pill {
        display: inline-flex; align-items: center; gap: 8px; padding: 8px 13px; border-radius: 999px;
        border: 1px solid rgba(168, 85, 247, 0.45);
        background: linear-gradient(135deg, rgba(13, 17, 32, 0.88), rgba(7, 10, 19, 0.94));
        backdrop-filter: blur(18px); color: #f8fafc; font-size: 12px; font-weight: 700;
        cursor: pointer; box-shadow: 0 12px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.12);
        transition: transform .15s ease, border-color .15s ease;
      }
      .nvr-pill:hover { transform: translateY(-1px); border-color: rgba(34, 211, 238, 0.6); }
      .nvr-dot { width: 8px; height: 8px; border-radius: 50%; background: #a855f7; box-shadow: 0 0 8px #a855f7; }
      .nvr-dot.is-ok { background: #34d399; box-shadow: 0 0 8px #34d399; }
      .nvr-dot.is-err { background: #f87171; box-shadow: 0 0 8px #f87171; }
      .nvr-pop {
        width: min(380px, 92vw); max-height: 75vh; display: flex; flex-direction: column; gap: 10px;
        margin-bottom: 10px; padding: 14px; border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: radial-gradient(360px 180px at 15% 0%, rgba(168, 85, 247, 0.18), transparent 65%), linear-gradient(165deg, rgba(13, 17, 32, 0.92), rgba(6, 9, 18, 0.96));
        backdrop-filter: blur(28px); color: #f1f5f9;
        box-shadow: 0 24px 64px rgba(0, 0, 0, 0.65), inset 0 1px 0 rgba(255, 255, 255, 0.12);
      }
      .nvr-pop[hidden] { display: none; }
      .nvr-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .nvr-title { font-size: 13.5px; font-weight: 800; background: linear-gradient(90deg, #f8fafc, #c4b5fd, #67e8f9); -webkit-background-clip: text; color: transparent; }
      .nvr-close { border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.06); color: #cbd5e1; border-radius: 8px; width: 26px; height: 26px; cursor: pointer; font-weight: 700; }
      .nvr-search { display: flex; gap: 6px; }
      .nvr-search input { flex: 1; min-width: 0; border-radius: 9px; border: 1px solid rgba(255,255,255,0.14); background: rgba(5,8,16,0.75); color: #fff; padding: 6px 10px; font-size: 12px; outline: none; }
      .nvr-btn { border: 1px solid rgba(168,85,247,0.55); background: linear-gradient(135deg, #a855f7, #6366f1); color: #fff; border-radius: 9px; padding: 6px 11px; font-size: 11.5px; font-weight: 700; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 5px; }
      .nvr-btn.is-ghost { border-color: rgba(255,255,255,0.14); background: rgba(255,255,255,0.06); color: #e2e8f0; }
      .nvr-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
      .nvr-stat { padding: 7px 8px; border-radius: 10px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); text-align: center; }
      .nvr-stat span { display: block; font-size: 10px; color: #94a3b8; }
      .nvr-stat strong { font-size: 14px; font-weight: 800; color: #f8fafc; }
      .nvr-list { overflow-y: auto; display: flex; flex-direction: column; gap: 6px; max-height: 210px; }
      .nvr-row { padding: 7px 9px; border-radius: 10px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); font-size: 11.5px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
      .nvr-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #e2e8f0; }
      .nvr-tag { padding: 2px 6px; border-radius: 6px; font-size: 10px; font-weight: 700; background: rgba(34,211,238,0.14); color: #a5f3fc; flex-shrink: 0; }
      .nvr-foot { display: flex; gap: 6px; flex-wrap: wrap; }
      .nvr-status { font-size: 11px; color: #94a3b8; }
    </style>
    <div class="nvr-pop" id="nvrPop" hidden>
      <div class="nvr-head">
        <span class="nvr-title">✦ Nexus Vault Radar</span>
        <button type="button" class="nvr-close" id="nvrClose">×</button>
      </div>
      <form class="nvr-search" id="nvrForm">
        <input id="nvrQueryInput" type="search" placeholder="Meno tvorcu alebo dopyt...">
        <button type="submit" class="nvr-btn">Overiť</button>
      </form>
      <div class="nvr-stats" id="nvrStats"></div>
      <div class="nvr-list" id="nvrSamples"></div>
      <div class="nvr-foot" id="nvrActions"></div>
      <div class="nvr-status" id="nvrStatus">Alt+N otvorí alebo zavrie Radar</div>
    </div>
    <button type="button" class="nvr-pill" id="nvrPill" title="Otvoriť Nexus Vault Radar (Alt+N)">
      <span class="nvr-dot" id="nvrDot"></span>
      <span id="nvrPillText">Nexus Radar</span>
    </button>
  `;
  document.body.appendChild(host);

  let activeBase = getSavedBaseUrl() || DEFAULT_BASE_URLS[0];
  let lastResult = null;

  function renderBadgesOnPage(urlMatches) {
    if (!urlMatches || typeof urlMatches !== 'object') return;
    document.querySelectorAll('a[href]').forEach(a => {
      const norm = canonicalUrl(a.getAttribute('href') || a.href || '', window.location.href);
      const match = urlMatches[norm] || urlMatches[a.href];
      if (!match || a.dataset.nvrBadged === '1') return;
      a.dataset.nvrBadged = '1';
      const badge = document.createElement('span');
      badge.textContent = `✓ Nexus ${match.quality || 'Lib'}${match.storage_type === 'local' ? ' · Local' : ''}`;
      badge.style.cssText = 'display:inline-flex;align-items:center;margin-left:6px;padding:1px 6px;border-radius:999px;font-size:10px;font-weight:700;background:rgba(16,185,129,0.22);border:1px solid rgba(52,211,153,0.48);color:#a7f3d0;vertical-align:middle;';
      a.appendChild(badge);
    });
  }

  async function runProbe(customQuery = '') {
    const qInput = shadow.getElementById('nvrQueryInput');
    const dot = shadow.getElementById('nvrDot');
    const pillText = shadow.getElementById('nvrPillText');
    const status = shadow.getElementById('nvrStatus');
    const query = customQuery || (qInput?.value || '').trim() || detectActiveQuery(document, window);
    if (qInput && !qInput.value) qInput.value = query;
    const candidates = collectPageCandidates(document, window.location.href, 60);

    try {
      const { base, data } = await callCompanion('/api/v1/companion/probe', {
        query,
        page_url: canonicalUrl(window.location.href),
        page_title: document.title || '',
        candidates,
      });
      activeBase = base;
      lastResult = data;
      dot.className = 'nvr-dot is-ok';
      const urlHitCount = Object.keys(data.url_matches || {}).length;
      pillText.textContent = urlHitCount > 0
        ? `Nexus ✓ ${urlHitCount} na stránke · ${data.vault_count || 0} v Trezore`
        : `Nexus · ${data.library_count || 0} Knižnica · ${data.vault_count || 0} Trezor`;
      renderBadgesOnPage(data.url_matches);
      renderPopover(data);
      status.textContent = `Pripojené na ${base}`;
    } catch (err) {
      dot.className = 'nvr-dot is-err';
      pillText.textContent = 'Nexus offline';
      status.textContent = err.message;
    }
  }

  function renderPopover(data) {
    const statsEl = shadow.getElementById('nvrStats');
    const samplesEl = shadow.getElementById('nvrSamples');
    const actionsEl = shadow.getElementById('nvrActions');
    const query = data.query || '';

    statsEl.innerHTML = `
      <div class="nvr-stat"><span>V Knižnici</span><strong>${Number(data.library_count || 0)}</strong></div>
      <div class="nvr-stat"><span>Local</span><strong>${Number(data.library_local_count || 0)}</strong></div>
      <div class="nvr-stat"><span>Local Vault</span><strong>${Number(data.vault_count || 0)}</strong></div>
    `;

    const combined = [
      ...(data.library_samples || []).map(v => ({ title: v.title, tag: `${v.quality || 'Lib'}${v.storage_type === 'local' ? ' · Local' : ''}`, url: `${activeBase}/?q=${encodeURIComponent(query || v.title)}` })),
      ...(data.vault_samples || []).map(v => ({ title: v.title, tag: v.source_label || v.bucket || 'Vault', url: buildVaultLink(activeBase, query) })),
    ].slice(0, 6);

    samplesEl.innerHTML = combined.length
      ? combined.map(it => `<a class="nvr-row" href="${escapeHtml(it.url)}" target="_blank" rel="noopener"><span class="nvr-row-title">${escapeHtml(it.title)}</span><span class="nvr-tag">${escapeHtml(it.tag)}</span></a>`).join('')
      : '<div class="nvr-status">Zadaj meno tvorcu pre okamžitý prehľad v Knižnici aj 945k Local Vaulte.</div>';

    actionsEl.innerHTML = `
      <a class="nvr-btn" href="${escapeHtml(buildVaultLink(activeBase, query))}" target="_blank" rel="noopener">Otvoriť v Trezore</a>
      <button type="button" class="nvr-btn is-ghost" id="nvrFollowBtn">${data.is_followed ? '★ Sledovaný' : '📌 Pripnúť do Radaru'}</button>
    `;

    const followBtn = shadow.getElementById('nvrFollowBtn');
    if (followBtn && query.length >= 2) {
      followBtn.addEventListener('click', async () => {
        followBtn.disabled = true;
        try {
          await callCompanion('/api/v1/companion/follow', { name: query, source_hint: window.location.hostname });
          followBtn.textContent = '★ Pripnuté!';
        } catch (err) {
          shadow.getElementById('nvrStatus').textContent = err.message;
          followBtn.disabled = false;
        }
      });
    }
  }

  function togglePop(force) {
    const pop = shadow.getElementById('nvrPop');
    const nextOpen = typeof force === 'boolean' ? force : pop.hidden;
    pop.hidden = !nextOpen;
    if (nextOpen) {
      const sel = detectActiveQuery(document, window);
      const input = shadow.getElementById('nvrQueryInput');
      if (input && sel) input.value = sel;
      runProbe(input?.value || '');
    }
  }

  shadow.getElementById('nvrPill').addEventListener('click', () => togglePop());
  shadow.getElementById('nvrClose').addEventListener('click', () => togglePop(false));
  shadow.getElementById('nvrForm').addEventListener('submit', ev => {
    ev.preventDefault();
    runProbe((shadow.getElementById('nvrQueryInput').value || '').trim());
  });

  document.addEventListener('keydown', ev => {
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey && String(ev.key || '').toLowerCase() === 'n') {
      ev.preventDefault();
      togglePop();
    }
  });

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Nexus Radar: Nastaviť URL servera', () => {
      const current = getSavedBaseUrl() || DEFAULT_BASE_URLS[0];
      const next = window.prompt('Zadaj URL tvojho Nexus servera:', current);
      if (next && /^https?:\/\//i.test(next.trim())) {
        saveBaseUrl(next.trim());
        runProbe();
      }
    });
  }

  setTimeout(() => { runProbe(); }, 900);
})(typeof window !== 'undefined' ? window : globalThis);
