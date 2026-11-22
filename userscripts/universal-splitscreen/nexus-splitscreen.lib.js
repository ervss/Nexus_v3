/*!
 * NexusSplitScreen — univerzálna Split-Screen knižnica (bez závislostí)
 * Použitie:  NexusSplitScreen.open([{ url, title, resolve }], options)
 *   url      – priama URL videa (.mp4/.webm/.m3u8) ALEBO stránka videa, ak zadáš resolve()
 *   resolve  – voliteľné async (item) => priama URL  (podpis tokenov, scraping stránky, ...)
 *   options  – { layout:'auto'|'row'|'grid2'|'grid3', fit:'contain'|'cover', diag:false,
 *                fallbackIframe:true, hlsUrl:'https://cdn.jsdelivr.net/npm/hls.js@1' }
 * Funguje v userscripte, v Chrome extension content scripte aj ako bežný <script>.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NexusSplitScreen = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CSS = `
  .nss-modal{position:fixed;inset:0;z-index:2147483647;background:rgba(5,7,12,.96);display:none;flex-direction:column;padding:10px;box-sizing:border-box;font:600 12px system-ui,sans-serif;color:#e2e8f0}
  .nss-modal *{box-sizing:border-box}
  .nss-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;padding:6px 10px;background:#0f1420;border:1px solid rgba(168,85,247,.4);border-radius:10px 10px 0 0}
  .nss-title{font-weight:800;color:#f3e8ff}
  .nss-group{display:flex;gap:4px;flex-wrap:wrap}
  .nss-btn{background:#1e293b;border:1px solid rgba(148,163,184,.3);color:#e2e8f0;border-radius:6px;padding:5px 9px;cursor:pointer;font:inherit}
  .nss-btn:hover{border-color:#a855f7;background:rgba(168,85,247,.25)}
  .nss-btn.on{background:linear-gradient(135deg,#7c3aed,#a855f7);border-color:#c084fc;color:#fff}
  .nss-close{background:#3b0d0d;border-color:#ef4444}
  .nss-stage{flex:1;min-height:0;display:grid;gap:8px;padding:8px;background:#030508;border:1px solid rgba(168,85,247,.25);border-top:0;border-radius:0 0 10px 10px}
  .nss-cell{position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;background:#0a0e17;border:1px solid rgba(148,163,184,.2);border-radius:10px;overflow:hidden}
  .nss-cell:hover{border-color:rgba(168,85,247,.7)}
  .nss-head{display:flex;gap:6px;align-items:center;padding:4px 8px;background:#0f1729;font-size:11px}
  .nss-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .nss-body{position:relative;flex:1;min-height:0;background:#000}
  .nss-body video,.nss-body iframe{width:100%;height:100%;border:0;background:#000;object-fit:contain}
  .nss-stage[data-fit=cover] video{object-fit:cover}
  .nss-loader{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(10,14,23,.85);z-index:2}
  .nss-diag{position:absolute;left:6px;right:6px;bottom:6px;z-index:3;display:none;grid-template-columns:1fr 1fr;gap:2px 8px;padding:4px 8px;background:rgba(10,15,26,.92);border:1px solid rgba(16,185,129,.45);border-radius:6px;font:700 10px Consolas,monospace;pointer-events:none}
  .nss-modal.diag .nss-diag{display:grid}
  .nss-ok{color:#34d399}.nss-warn{color:#f59e0b}.nss-bad{color:#ef4444}`;

  let modal, stage, cells = [], opts = {}, timers = [], styleEl;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function ensureUi() {
    if (modal) return;
    styleEl = document.createElement('style');
    styleEl.textContent = CSS;
    (document.head || document.documentElement).appendChild(styleEl);
    modal = document.createElement('div');
    modal.className = 'nss-modal';
    modal.innerHTML = `
      <div class="nss-bar">
        <span class="nss-title">▶▶ Split-Screen</span>
        <div class="nss-group">
          <button class="nss-btn" data-a="play">▶ Play</button>
          <button class="nss-btn" data-a="pause">⏸ Pause</button>
          <button class="nss-btn" data-a="sync0">⏮ 0:00</button>
          <button class="nss-btn" data-a="back">⏪ -10s</button>
          <button class="nss-btn" data-a="fwd">⏩ +10s</button>
          <button class="nss-btn" data-a="muteall">🔇 Mute all</button>
        </div>
        <div class="nss-group">
          <button class="nss-btn" data-l="auto">Auto</button>
          <button class="nss-btn" data-l="row">1 rad</button>
          <button class="nss-btn" data-l="grid2">2 stĺpce</button>
          <button class="nss-btn" data-l="grid3">3 stĺpce</button>
          <button class="nss-btn" data-a="fit">⛶ Fit</button>
          <button class="nss-btn" data-a="diag">📊 Diag</button>
          <button class="nss-btn nss-close" data-a="close">✕</button>
        </div>
      </div>
      <div class="nss-stage" data-fit="contain"></div>`;
    document.body.appendChild(modal);
    stage = modal.querySelector('.nss-stage');
    modal.addEventListener('click', onBar);
    document.addEventListener('keydown', (e) => {
      if (modal.style.display !== 'flex') return;
      if (e.key === 'Escape') close();
      else if (e.key === ' ' && e.target === document.body) { e.preventDefault(); toggleAll(); }
    });
  }

  const vids = () => cells.map((c) => c.video).filter(Boolean);
  function toggleAll() { const v = vids(); const anyPlaying = v.some((x) => !x.paused); v.forEach((x) => (anyPlaying ? x.pause() : x.play().catch(() => {}))); }

  function onBar(e) {
    const l = e.target.closest('[data-l]');
    if (l) { opts.layout = l.dataset.l; layout(); return; }
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const v = vids();
    switch (b.dataset.a) {
      case 'play': v.forEach((x) => x.play().catch(() => { x.muted = true; x.play().catch(() => {}); })); break;
      case 'pause': v.forEach((x) => x.pause()); break;
      case 'sync0': v.forEach((x) => { x.currentTime = 0; x.play().catch(() => {}); }); break;
      case 'back': v.forEach((x) => (x.currentTime = Math.max(0, x.currentTime - 10))); break;
      case 'fwd': v.forEach((x) => (x.currentTime += 10)); break;
      case 'muteall': v.forEach((x) => (x.muted = true)); break;
      case 'fit': opts.fit = opts.fit === 'cover' ? 'contain' : 'cover'; layout(); break;
      case 'diag': modal.classList.toggle('diag'); break;
      case 'close': close(); break;
    }
  }

  function grid(n) {
    const m = opts.layout;
    if (n <= 1) return [1, 1];
    if (m === 'row') return [n, 1];
    if (m === 'grid2') return [2, Math.ceil(n / 2)];
    if (m === 'grid3') return [3, Math.ceil(n / 3)];
    if (n === 2) return [2, 1];
    if (n === 3) return [3, 1];
    if (n === 4) return [2, 2];
    if (n <= 6) return [3, 2];
    if (n <= 9) return [3, 3];
    return [4, Math.ceil(n / 4)];
  }
  function layout() {
    const [c, r] = grid(cells.length);
    stage.style.gridTemplateColumns = `repeat(${c},minmax(0,1fr))`;
    stage.style.gridTemplateRows = `repeat(${r},minmax(0,1fr))`;
    stage.dataset.fit = opts.fit;
    modal.querySelectorAll('[data-l]').forEach((b) => b.classList.toggle('on', b.dataset.l === opts.layout));
    modal.querySelector('.nss-title').textContent = `▶▶ Split-Screen (${cells.length})`;
  }

  async function loadHls() {
    if (window.Hls) return window.Hls;
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = opts.hlsUrl; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
    return window.Hls;
  }

  async function attach(cell, item, idx) {
    const { video, loader, body } = cell;
    await sleep(idx * 200); // jemné rozloženie štartu, nie hromadný burst
    let src = item.url;
    try {
      if (typeof item.resolve === 'function') {
        for (let a = 0; a < 4 && !src_ok(src, item); a++) {
          src = await item.resolve(item);
          if (!src) await sleep(700 * (a + 1));
        }
      }
    } catch (e) { console.warn('[NSS] resolve failed', e); src = null; }
    if (cell.dead) return;
    if (!src) return fallback(cell, item);
    cell.src = src;
    video.style.display = 'block';
    video.muted = idx > 0;
    const done = () => (loader.style.display = 'none');
    video.addEventListener('canplay', done);
    video.addEventListener('playing', done);
    video.addEventListener('waiting', () => { cell.stalls++; });
    video.onerror = () => { if (!cell.dead && !cell.retried) { cell.retried = true; fallback(cell, item); } };
    try {
      if (/\.m3u8(\?|$)/i.test(src) && !video.canPlayType('application/vnd.apple.mpegurl')) {
        const Hls = await loadHls();
        cell.hls = new Hls({ maxBufferLength: 40, enableWorker: true });
        cell.hls.loadSource(src); cell.hls.attachMedia(video);
      } else video.src = src;
    } catch { video.src = src; }
    video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
  }
  const src_ok = (s) => !!s;

  function fallback(cell, item) {
    if (opts.fallbackIframe === false) { cell.loader.textContent = 'Nepodarilo sa načítať'; return; }
    cell.loader.style.display = 'none';
    cell.video.style.display = 'none';
    const f = document.createElement('iframe');
    f.allow = 'autoplay *; fullscreen *'; f.src = item.pageUrl || item.url;
    cell.body.appendChild(f);
  }

  function diagTick() {
    cells.forEach((c) => {
      const v = c.video; if (!v || !c.diag) return;
      let ahead = 0; const t = v.currentTime;
      for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= t && v.buffered.end(i) >= t) ahead = v.buffered.end(i) - t;
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : {};
      let net = '';
      try {
        const e = performance.getEntriesByType('resource').reverse().find((x) => c.src && x.name.split('?')[0] === c.src.split('?')[0]);
        if (e) net = `${e.nextHopProtocol || '?'} TTFB ${Math.round(e.responseStart - e.requestStart)}ms`;
      } catch {}
      const cls = ahead < 2 ? 'nss-bad' : ahead < 6 ? 'nss-warn' : 'nss-ok';
      c.diag.innerHTML = `<div>Buffer <span class="${cls}">${ahead.toFixed(1)}s</span></div><div>Stalls <span class="${c.stalls > 2 ? 'nss-bad' : 'nss-ok'}">${c.stalls}</span></div><div>Dropped <span class="nss-ok">${q.droppedVideoFrames || 0}</span></div><div>${esc(net) || '—'}</div>`;
    });
  }
  function driftTick() {
    const v = vids().filter((x) => !x.paused && x.readyState >= 2);
    if (v.length < 2) return;
    const avg = v.reduce((a, x) => a + x.currentTime, 0) / v.length;
    v.forEach((x) => {
      const d = x.currentTime - avg;
      x.playbackRate = Math.abs(d) > 0.35 && Math.abs(d) < 3 ? (d > 0 ? 0.96 : 1.04) : 1;
    });
  }

  function close() {
    if (!modal) return;
    timers.forEach(clearInterval); timers = [];
    cells.forEach(destroyCell);
    cells = []; stage.innerHTML = ''; modal.style.display = 'none';
  }
  function destroyCell(c) {
    c.dead = true;
    try { c.hls && c.hls.destroy(); } catch {}
    try { c.video.pause(); c.video.removeAttribute('src'); c.video.load(); } catch {}
    c.body.querySelectorAll('iframe').forEach((f) => (f.src = 'about:blank'));
  }

  function open(items, options) {
    items = (items || []).filter((i) => i && (i.url || i.resolve));
    if (!items.length) return false;
    ensureUi(); close();
    opts = Object.assign({ layout: 'auto', fit: 'contain', diag: false, fallbackIframe: true,
      hlsUrl: 'https://cdn.jsdelivr.net/npm/hls.js@1' }, options || {});
    modal.style.display = 'flex';
    modal.classList.toggle('diag', !!opts.diag);
    items.forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'nss-cell';
      el.innerHTML = `<div class="nss-head"><span class="nss-name" title="${esc(item.title || item.url)}">#${i + 1} ${esc(item.title || item.url)}</span>
        <button class="nss-btn" data-c="mute">🔇</button><button class="nss-btn" data-c="solo">🎯</button><button class="nss-btn" data-c="x">✕</button></div>
        <div class="nss-body"><div class="nss-loader">Načítavam…</div><video controls autoplay loop playsinline preload="auto" style="display:none"></video><div class="nss-diag"></div></div>`;
      stage.appendChild(el);
      const cell = { el, body: el.querySelector('.nss-body'), video: el.querySelector('video'),
        loader: el.querySelector('.nss-loader'), diag: el.querySelector('.nss-diag'), stalls: 0 };
      cells.push(cell);
      el.querySelector('.nss-head').addEventListener('click', (e) => {
        const a = e.target.closest('[data-c]'); if (!a) return;
        if (a.dataset.c === 'mute') cell.video.muted = !cell.video.muted;
        else if (a.dataset.c === 'solo') cells.forEach((c) => { c.video.muted = c !== cell; });
        else { destroyCell(cell); cells = cells.filter((c) => c !== cell); el.remove(); cells.length ? layout() : close(); }
      });
      attach(cell, item, i);
    });
    layout();
    timers.push(setInterval(diagTick, 1000), setInterval(driftTick, 2000));
    return true;
  }

  return { open, close, version: '1.0.0' };
});
