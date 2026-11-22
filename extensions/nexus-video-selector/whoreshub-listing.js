// Whoreshub KVS lists: keep the original block, sort and favorites parameters.
(() => {
  'use strict';
  const isPage = () => /(^|\.)whoreshub\.com$/i.test(location.hostname);
  function params(raw) {
    return Object.fromEntries(String(raw || '').split(';').filter(p => p.includes(':')).map(p => {
      const i = p.indexOf(':'); return [p.slice(0, i), p.slice(i + 1)];
    }));
  }
  function videoUrl(card) {
    const a = card.matches?.('a[href]') ? card : card.querySelector('a[href*="/videos/"]');
    try {
      const u = new URL(a?.getAttribute('href'), location.href);
      if (u.origin !== location.origin || !/^\/videos\/\d+\//.test(u.pathname)) return '';
      return u.origin + u.pathname.replace(/\/+$/, '/');
    } catch { return ''; }
  }
  function cards(root) {
    return [...root.querySelectorAll('.thumb')].filter(c => videoUrl(c));
  }
  function pager(root, block) {
    const el = root.getElementById(block + '_pagination');
    const links = [...(el?.querySelectorAll('a[data-parameters]') || [])];
    const active = el?.querySelector('.active, .selected');
    const current = Number(active?.textContent.trim()) || 1;
    const next = links.find(a => /^(next|ďalš|›|»)/i.test(a.textContent.trim()) || a.rel === 'next');
    const sample = next || links[0];
    const values = params(sample?.getAttribute('data-parameters'));
    const fromKey = Object.keys(values).find(k => /^from(?:_\w+)?\d*$/i.test(k)) || 'from';
    return { current, next: next ? Number(values[fromKey]) : null, fromKey, values };
  }
  function pageUrl(block, page, p) {
    const u = new URL(location.href);
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (/^from(?:_\w+)?\d*$/i.test(key)) u.searchParams.delete(key);
    }
    u.searchParams.set('mode', 'async');
    u.searchParams.set('function', 'get_block');
    u.searchParams.set('block_id', block);
    for (const [k, v] of Object.entries(p.values)) u.searchParams.set(k, v);
    u.searchParams.set(p.fromKey, String(page));
    return u.href;
  }
  function attach(panel, { scan, hydrateLazyImages, showToast }) {
    if (!isPage() || /^\/videos\/\d+\//.test(location.pathname)) return false;
    const grid = [...document.querySelectorAll('[id$="_items"]')].find(el =>
      /^(playlist_view_|list_videos_)/.test(el.id) && !/related/.test(el.id) && cards(el).length);
    if (!grid || panel.querySelector('#nvs-wh-all')) return false;
    const block = grid.id.replace(/_items$/, '');
    let p = pager(document, block);
    let next = p.next;
    let pending = [];
    let busy = false;
    let stopped = false;
    const seen = new Set(cards(grid).map(videoUrl));
    const visited = new Set();
    const nativePager = document.getElementById(block + '_pagination');
    // Native AJAX would replace the accumulated list, so use our controls here.
    if (nativePager) { nativePager.hidden = true; nativePager.setAttribute('data-nvs-wh-pager', ''); }
    const load = panel.querySelector('#nvs-load-pages');
    panel.querySelector('#nvs-load-until').hidden = true;
    panel.querySelector('#nvs-load-label').textContent = 'Videá po 50';
    load.textContent = 'Ďalších 50';
    load.title = 'Pripojiť ďalších 50 videí pod aktuálny zoznam';
    const all = document.createElement('button');
    all.id = 'nvs-wh-all'; all.className = 'nvs-btn-load-pages'; all.type = 'button';
    all.textContent = 'Načítať všetko'; load.after(all);
    const status = document.createElement('span');
    status.id = 'nvs-wh-status'; status.setAttribute('aria-live', 'polite');
    all.after(status);
    const footer = document.createElement('div');
    footer.className = 'nvs-wh-footer';
    const moreBottom = document.createElement('button');
    const allBottom = document.createElement('button');
    moreBottom.textContent = 'Ďalších 50'; allBottom.textContent = 'Načítať všetko';
    for (const b of [moreBottom, allBottom]) { b.type = 'button'; b.className = 'nvs-btn-load-pages'; footer.append(b); }
    grid.after(footer);
    function update() {
      const done = !next && !pending.length;
      status.textContent = `${cards(grid).length} videí${done ? ' · všetko načítané' : busy ? ' · načítavam…' : ''}`;
      load.disabled = moreBottom.disabled = busy || done;
      all.disabled = allBottom.disabled = done;
      all.textContent = allBottom.textContent = busy ? 'Zastaviť' : 'Načítať všetko';
    }
    async function run(limit) {
      if (busy) { stopped = true; return; }
      busy = true; stopped = false; update();
      let added = 0;
      try {
        while (!stopped && added < limit && (pending.length || next)) {
          if (!grid.isConnected || !panel.isConnected) break;
          if (!pending.length) {
            if (visited.has(next)) { next = null; break; }
            const page = next;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 20000);
            let html;
            try {
              const res = await fetch(pageUrl(block, page, p), {
                credentials: 'include', signal: controller.signal,
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              html = await res.text();
            } finally { clearTimeout(timer); }
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const fetchedGrid = doc.getElementById(grid.id);
            if (!fetchedGrid) throw new Error('Server nevrátil požadovaný zoznam videí');
            const fresh = cards(fetchedGrid).filter(c => !seen.has(videoUrl(c)));
            const following = pager(doc, block);
            visited.add(page);
            next = following.next && following.next > page ? following.next : null;
            p = { ...p, ...following, values: { ...p.values, ...following.values } };
            pending = fresh;
            if (!fresh.length) { next = null; break; }
          }
          const batch = pending.splice(0, Math.min(20, limit - added));
          const fragment = document.createDocumentFragment();
          for (const card of batch) {
            const url = videoUrl(card);
            if (seen.has(url)) continue;
            seen.add(url);
            const node = document.importNode(card, true);
            hydrateLazyImages(node); fragment.append(node); added++;
          }
          await new Promise(resolve => requestAnimationFrame(() => { grid.append(fragment); resolve(); }));
          scan(); update();
        }
      } catch (error) {
        showToast(`Whoreshub: ${error.message}. Načítanie môžeš skúsiť znova.`, 'error');
      } finally { busy = false; update(); }
    }
    // Override the generic page loader without running its listener.
    load.addEventListener('click', event => { event.stopImmediatePropagation(); void run(50); }, true);
    moreBottom.addEventListener('click', () => { void run(50); });
    for (const b of [all, allBottom]) b.addEventListener('click', () => { void run(Infinity); });
    panel.querySelector('#nvs-panel-disable')?.addEventListener('click', () => {
      stopped = true; footer.remove();
      if (nativePager) { nativePager.hidden = false; nativePager.removeAttribute('data-nvs-wh-pager'); }
    });
    update();
    window.NVSWhoreshubPlayer?.attach(grid, panel);
    // First batch includes cards that were already rendered by the website.
    setTimeout(() => { if (grid.isConnected && panel.isConnected) void run(Math.max(0, 50 - cards(grid).length)); }, 0);
    return true;
  }
  window.NVSWhoreshubListing = { attach, params, pager, pageUrl, videoUrl };
})();
