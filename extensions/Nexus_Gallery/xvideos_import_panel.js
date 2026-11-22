/* XVideos collection workbench for the active Nexus Gallery extension. */
(() => {
  'use strict';
  if (!/(^|\.)xvideos\.(?:com|red)$/i.test(location.hostname) || window.__nexusXvideosImportPanel) return;
  window.__nexusXvideosImportPanel = true;

  const state = { selected: new Set(), tags: new Map(), meta: new Map(), next: '', loading: false, scanning: false, filter: '', tag: '', quality: '', durationMin: 0, durationMax: 0, sizeMin: 0, sizeMax: 0, hideUnselected: false, hideUnmatched: false, sort: 'original', direction: 'asc' };
  const host = location.hostname.replace(/^www\./i, '').toLowerCase();
  const cardSelector = '.thumb-block, .video-snippet, .video-thumb';
  const isXvideosHost = hostname => {
    const normalized = String(hostname || '').replace(/^www\./i, '').toLowerCase();
    return normalized === host && /(^|\.)xvideos\.(?:com|red)$/i.test(normalized);
  };
  const pageUrl = raw => {
    try {
      const url = new URL(raw, location.href);
      if (!isXvideosHost(url.hostname) || !/^\/video(?:\.[a-z0-9]+|\d+)/i.test(url.pathname)) return '';
      url.hash = ''; return url.href;
    } catch { return ''; }
  };
  const watchUrl = raw => {
    try {
      const url = new URL(raw, location.href);
      if (!isXvideosHost(url.hostname)) return '';
      if (/^\/(?:prof-video-click|model-click)\//i.test(url.pathname)) {
        const target = url.searchParams.get('url') || url.searchParams.get('video');
        if (target) return pageUrl(target);
        const match = url.pathname.match(/^\/(?:prof-video-click|model-click)\/(?:upload(?:-(?:straight|gay|shemale))?|pornstar(?:-(?:straight|gay|shemale))?|profiles?|models?|members?)\/[^/]+\/([a-z0-9]+)(?:\/([^/]*))?\/?$/i);
        if (!match) return '';
        url.pathname = `/video${/^\d+$/.test(match[1]) ? '' : '.'}${match[1]}/${match[2] || ''}`;
      }
      return pageUrl(url.href);
    } catch { return ''; }
  };
  const cards = root => {
    const seen = new Set(), rows = [];
    const links = [...root.querySelectorAll('a[href]')];
    for (const link of links) {
      const url = watchUrl(link.href);
      if (!url || seen.has(url)) continue;
      const card = link.closest(cardSelector);
      if (!card) continue;
      seen.add(url); rows.push({ card, url, title: (card.querySelector('.title, .video-title, [class*="title"]')?.textContent || link?.title || card.querySelector('img')?.alt || '').replace(/\s+/g, ' ').trim() });
    }
    return rows;
  };
  const profilePageUrl = (root, page) => {
    try {
      const current = new URL(location.href);
      const profile = current.pathname.match(/^\/(pornstars|models)\/([^/]+)\/?$/i);
      const tab = root.querySelector?.('#tabVideos');
      if (!profile || !tab || !Number.isInteger(Number(page)) || Number(page) < 0) return '';
      const sort = tab.querySelector('[data-sort].is-selected')?.getAttribute('data-sort') || 'best';
      const link = tab.querySelector('a[href*="/prof-video-click/"], a[href*="/model-click/"]');
      const trackingPath = link ? new URL(link.getAttribute('href'), location.href).pathname : '';
      const content = trackingPath.match(/\/(?:prof-video-click|model-click)\/(?:pornstar-)?(straight|gay|shemale|trans)\//i)?.[1] || 'straight';
      current.pathname = `${current.pathname.replace(/\/$/, '')}/videos/${encodeURIComponent(sort)}/${encodeURIComponent(content)}/${Number(page)}`;
      current.search = '';
      current.hash = '';
      return current.href;
    } catch { return ''; }
  };
  const nextUrl = root => {
    const current = new URL(location.href);
    if (/^\/(?:pornstars|models)\/[^/]+\/?$/i.test(current.pathname) && root.querySelector?.('#tabVideos')) {
      const links = [...root.querySelectorAll('#tabVideos .pagination [data-page]')];
      if (!links.length) return '';
      const active = links.find(link => /\bactive\b/.test(link.className || ''));
      const page = Number(active?.getAttribute('data-page')) || 0;
      const next = links.map(link => Number(link.getAttribute('data-page')))
        .filter(value => Number.isInteger(value) && value > page)
        .reduce((lowest, value) => Math.min(lowest, value), Infinity);
      return Number.isFinite(next) ? profilePageUrl(root, next) : '';
    }
    const next = [...root.querySelectorAll('a[href]')].find(a => /(?:^|\s)(?:next|pagination-next)(?:\s|$)/i.test(a.className || '') || /^(?:›|»|>|next)$/i.test((a.textContent || '').trim()));
    if (next) { try { const u = new URL(next.href, location.href); return isXvideosHost(u.hostname) ? u.href : ''; } catch {} }
    const url = new URL(location.href), queryPage = Number(url.searchParams.get('p')) || 0;
    const pages = [...root.querySelectorAll('a[href*="?p="]')].map(a => Number(new URL(a.href, location.href).searchParams.get('p')) || 0);
    const last = Math.max(0, ...pages); if (!last || queryPage >= last) return '';
    url.searchParams.set('p', String(queryPage + 1)); return url.href;
  };
  const cardsFromJson = data => {
    if (!Array.isArray(data?.videos)) return [];
    const seen = new Set(), rows = [];
    for (const item of data.videos) {
      const url = watchUrl(item?.u);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const title = String(item.tf || item.t || '').trim();
      const card = document.createElement('div');
      card.className = 'thumb-block tb_full_init';
      if (item.eid) { card.id = `video_${item.eid}`; card.dataset.eid = String(item.eid); }
      if (item.id != null) card.dataset.id = String(item.id);
      const inside = document.createElement('div'); inside.className = 'thumb-inside';
      const thumb = document.createElement('div'); thumb.className = 'thumb';
      const link = document.createElement('a'); link.setAttribute('href', item.u);
      if (title) link.setAttribute('title', title);
      const image = document.createElement('img');
      const imageUrl = [item.i, item.il, item.if].find(value => {
        try { const parsed = new URL(value, location.href); return parsed.protocol === 'https:' && /(^|\.)xvideos-cdn\.com$/i.test(parsed.hostname); } catch { return false; }
      });
      if (imageUrl) { image.src = imageUrl; image.alt = title; image.loading = 'lazy'; link.appendChild(image); }
      thumb.appendChild(link); inside.appendChild(thumb); card.appendChild(inside);
      const under = document.createElement('div'); under.className = 'thumb-under';
      const titleNode = document.createElement('p'); titleNode.className = 'title';
      const titleLink = document.createElement('a'); titleLink.setAttribute('href', item.u);
      if (title) titleLink.setAttribute('title', title);
      titleLink.textContent = title || url.split('/').pop().replace(/_/g, ' ');
      titleNode.appendChild(titleLink); under.appendChild(titleNode);
      if (item.d) { const duration = document.createElement('span'); duration.className = 'duration'; duration.textContent = String(item.d); under.appendChild(duration); }
      card.appendChild(under);
      rows.push({ card, url, title });
    }
    return rows;
  };
  const normalize = value => String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 80);
  const titleOf = row => row.title || row.url.split('/').pop().replace(/_/g, ' ');
  const grid = () => cards(document)[0]?.card.parentElement || document.querySelector('.mozaique');
  const tagList = url => state.tags.get(url)?.tags || [];
  const durationOf = row => state.meta.get(row.url)?.duration || Number((row.card.textContent || '').match(/\b(\d{1,3})\s*min\b/i)?.[1]) * 60 || 0;
  const qualityOf = row => state.meta.get(row.url)?.quality || Number((row.card.textContent || '').match(/\b(2160|1440|1080|720|480|360)p\b/i)?.[1]) || 0;
  const sizeOf = row => state.meta.get(row.url)?.sizeMb || 0;
  const isMatch = row => {
    const duration = durationOf(row), quality = qualityOf(row), size = sizeOf(row);
    return (!state.filter || titleOf(row).toLowerCase().includes(state.filter))
      && (!state.tag || tagList(row.url).some(t => t.includes(state.tag)))
      && (!state.quality || quality === Number(state.quality))
      && (!state.durationMin || duration >= state.durationMin * 60)
      && (!state.durationMax || duration <= state.durationMax * 60)
      && (!state.sizeMin || size >= state.sizeMin)
      && (!state.sizeMax || size <= state.sizeMax);
  };

  function addSelectors(rows) {
    for (const row of rows) {
      if (row.card.querySelector(':scope > .nexus-xv-select')) continue;
      row.card.classList.add('nexus-xv-card');
      const box = document.createElement('button'); box.type = 'button'; box.className = 'nexus-xv-select'; box.setAttribute('aria-label', 'Vybrať video'); box.setAttribute('aria-pressed', 'false');
      box.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); toggle(row); });
      row.card.prepend(box);
    }
  }
  function toggle(row, selected = !state.selected.has(row.url)) {
    if (selected) state.selected.add(row.url); else state.selected.delete(row.url);
    row.card.classList.toggle('nexus-xv-selected', selected);
    row.card.querySelector('.nexus-xv-select')?.setAttribute('aria-pressed', String(selected));
    render();
  }
  function apply(rows) {
    for (const row of rows) {
      const matched = isMatch(row), selected = state.selected.has(row.url);
      row.card.classList.toggle('nexus-xv-hidden', state.hideUnmatched && !matched || state.hideUnselected && !selected);
    }
    if (state.sort !== 'original') {
      const parent = rows[0]?.card.parentElement || grid(); if (!parent) return;
      const ordered = [...rows].sort((a, b) => {
        const values = row => state.sort === 'title' ? titleOf(row) : state.sort === 'duration' ? durationOf(row) : state.sort === 'quality' ? qualityOf(row) : sizeOf(row);
        const av = values(a), bv = values(b);
        const d = typeof av === 'string' ? av.localeCompare(bv) : av - bv; return state.direction === 'desc' ? -d : d;
      });
      const marker = document.createComment('nexus-xv-order'); parent.prepend(marker); ordered.forEach(row => parent.insertBefore(row.card, marker)); marker.remove();
    }
  }
  function render() {
    const rows = cards(document);
    addSelectors(rows); apply(rows);
    const matched = rows.filter(isMatch), selected = rows.filter(row => state.selected.has(row.url));
    const metaCount = rows.filter(row => state.meta.has(row.url)).length;
    panel.querySelector('[data-xv="summary"]').textContent = `${rows.length} načítaných · ${matched.length} vyhovuje · ${selected.length} vybraných · ${metaCount} metadát`;
    panel.querySelector('[data-xv="load"]').disabled = state.loading || !(state.next || nextUrl(document));
    panel.querySelector('[data-xv="scan"]').disabled = state.scanning;
    panel.querySelector('[data-xv="import"]').disabled = !selected.length;
    panel.querySelector('[data-xv="copy"]').disabled = !selected.length;
  }
  async function loadPages() {
    if (state.loading) return;
    const count = Math.max(1, Math.min(50, Number(panel.querySelector('[data-xv="count"]').value) || 1));
    state.loading = true; render(); let added = 0, next = state.next || nextUrl(document);
    try {
      for (let i = 0; i < count && next; i++) {
        const response = await fetch(next, { credentials: 'include' }); if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (response.headers.get('content-type') || '').includes('application/json') ? await response.json() : null;
        const doc = data ? null : new DOMParser().parseFromString(await response.text(), 'text/html');
        const known = new Set(cards(document).map(row => row.url)), destination = grid(); if (!destination) throw new Error('Grid videí sa nenašiel.');
        const fragment = document.createDocumentFragment();
        const pageRows = data ? cardsFromJson(data) : cards(doc);
        for (const row of pageRows) if (!known.has(row.url)) { fragment.append(row.card); known.add(row.url); added++; }
        destination.append(fragment);
        if (data && Number(data.nb_per_page) > 0) {
          const nextPage = Number(data.current_page) + 1;
          next = nextPage < Math.ceil(Number(data.nb_videos) / Number(data.nb_per_page)) ? profilePageUrl(document, nextPage) : '';
        } else next = nextUrl(doc);
      }
      state.next = next || '';
      notice(added ? `Pripojených ${added} videí pod aktuálny zoznam.` : 'Ďalšie videá už nie sú dostupné.');
    } catch (error) { notice(`Načítanie zlyhalo: ${error.message}`, true); }
    finally { state.loading = false; render(); }
  }
  async function loadTags() {
    const targets = cards(document).filter(row => state.selected.has(row.url) || !state.selected.size).filter(row => !state.tags.has(row.url));
    if (!targets.length) return notice('Tagy sú už načítané pre vybrané videá.');
    notice(`Načítavam tagy 0/${targets.length}…`);
    let done = 0;
    for (const row of targets) {
      try {
        const response = await fetch(row.url, { credentials: 'include' }); const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        const tags = [...doc.querySelectorAll('a[href*="/tags/"]')].map(a => normalize(a.textContent || new URL(a.href).pathname.split('/').pop())).filter(Boolean);
        state.tags.set(row.url, { tags: [...new Set(tags)] });
      } catch { state.tags.set(row.url, { tags: [] }); }
      done++; notice(`Tagy ${done}/${targets.length}`);
    }
    render(); notice(`Tagy načítané pre ${done} videí.`);
  }
  function streamCandidates(html) {
    const clean = String(html || '').replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    const found = [];
    for (const match of clean.matchAll(/setVideo(?:Url)?(Low|High|HLS|\d{3,4}p|4k|2k)\s*\(\s*['"]([^'"]+)/gi)) {
      const label = match[1].toLowerCase();
      const quality = label === '4k' ? 2160 : label === '2k' ? 1440 : Number(label.match(/\d{3,4}/)?.[0]) || (label === 'high' ? 1080 : label === 'low' ? 720 : 0);
      found.push({ url: match[2], quality });
    }
    for (const match of clean.matchAll(/['"](2160|1440|1080|720|480|360)p?['"]\s*:\s*['"](https?:[^'"]+)/gi)) found.push({ url: match[2], quality: Number(match[1]) });
    return found.filter(item => /^https?:/i.test(item.url));
  }
  const message = payload => new Promise(resolve => chrome.runtime.sendMessage(payload, resolve));
  async function scanMetadata() {
    const targets = cards(document)
      .filter(row => state.selected.has(row.url) || !state.selected.size)
      .filter(row => !state.meta.get(row.url)?.quality || !state.meta.get(row.url)?.sizeMb);
    if (!targets.length) return notice('Metadáta sú už načítané pre vybraný rozsah.');
    state.scanning = true; render(); let done = 0, failures = 0, incomplete = 0, index = 0;
    notice(`Skenujem metadáta 0/${targets.length}…`);
    const worker = async () => {
      while (index < targets.length) {
        const row = targets[index++];
        try {
          const response = await fetch(row.url, { credentials: 'include' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const html = await response.text(), candidates = streamCandidates(html).sort((a, b) => b.quality - a.quality);
          const best = candidates[0], duration = durationOf(row);
          let quality = best?.quality || qualityOf(row);
          let sizeMb = 0;
          if (best?.url) {
            const isHls = /\.m3u8(?:[?#]|$)/i.test(best.url);
            let probed = null;
            if (!isHls) {
              const head = await message({ action: 'FETCH_HEAD_INFO', url: best.url, referer: row.url });
              sizeMb = Math.round(Number(head?.contentLength || head?.sizeBytes || 0) / 1024 / 1024);
            }
            if (!quality || !sizeMb || isHls) {
              probed = await message({ action: 'PROBE_MEDIA_METADATA', url: best.url, referer: row.url });
              quality ||= Number(probed?.height || 0);
              if (!isHls && !sizeMb) sizeMb = Math.round(Number(probed?.sizeBytes || 0) / 1024 / 1024);
            }
          }
          state.meta.set(row.url, { duration, quality, sizeMb, streamUrl: best?.url || '' });
          row.card.dataset.nexusXvMeta = JSON.stringify({ duration, quality, sizeMb });
          if (!quality || !sizeMb) incomplete++;
        } catch { failures++; incomplete++; state.meta.set(row.url, { duration: durationOf(row), quality: qualityOf(row), sizeMb: 0 }); }
        done++; notice(`Skenujem metadáta ${done}/${targets.length}${failures ? ` · chyby ${failures}` : ''}`); render();
      }
    };
    try { await Promise.all(Array.from({ length: Math.min(3, targets.length) }, worker)); }
    finally { state.scanning = false; render(); notice(`Sken dokončený: ${done - failures}/${done} úspešne · ${incomplete} bez kompletnej kvality alebo veľkosti${failures ? ` · chyby ${failures}` : ''}.`); }
  }
  function selectedRows() { return cards(document).filter(row => state.selected.has(row.url)); }
  function copy() { navigator.clipboard.writeText(selectedRows().map(row => row.url).join('\n')).then(() => notice(`Skopírovaných ${state.selected.size} URL pre IDM/JD2.`), () => notice('Schránka nie je dostupná.', true)); }
  function importSelected() {
    const rows = selectedRows(); if (!rows.length) return;
    let done = 0, failed = 0; notice(`Importujem 0/${rows.length}…`);
    for (const row of rows) chrome.runtime.sendMessage({ action: 'IMPORT_VIDEO', streamUrl: row.url, port: 8000, metadata: { title: titleOf(row), sourceUrl: row.url, tags: tagList(row.url) } }, response => {
      done++; if (!response?.ok) failed++; notice(`Import ${done}/${rows.length}${failed ? ` · chyby ${failed}` : ''}`); if (done === rows.length) notice(failed ? `Import dokončený: ${rows.length-failed}/${rows.length} prijatých.` : `Import dokončený: ${done} videí odoslaných do Nexusu.`);
    });
  }
  function notice(text, error = false) { const box = panel.querySelector('[data-xv="notice"]'); box.textContent = text; box.classList.toggle('nexus-xv-error', error); }

  const panel = document.createElement('section'); panel.id = 'nexus-xv-import-panel';
  panel.innerHTML = `<header><strong>NEXUS <span>· XVideos import</span></strong><button type="button" data-xv="collapse" aria-label="Zbaliť panel">−</button></header><div class="nexus-xv-body"><div class="nexus-xv-summary" data-xv="summary"></div><div class="nexus-xv-controls"><label>Hľadať<input data-xv="filter" type="search" placeholder="názov videa"></label><label>Tag<input data-xv="tag" type="search" placeholder="napr. pov"></label><label>Kvalita<select data-xv="quality"><option value="">Všetky</option><option value="2160">4K</option><option value="1440">1440p</option><option value="1080">1080p</option><option value="720">720p</option><option value="480">480p</option></select></label><label>Radiť<select data-xv="sort"><option value="original">Pôvodne</option><option value="title">Názov</option><option value="duration">Dĺžka</option><option value="quality">Kvalita</option><option value="size">Veľkosť</option></select></label><label>Smer<select data-xv="direction"><option value="asc">Vzostupne</option><option value="desc">Zostupne</option></select></label></div><div class="nexus-xv-range"><label>Dĺžka min<input data-xv="duration-min" type="number" min="0" placeholder="od"></label><label>Dĺžka max<input data-xv="duration-max" type="number" min="0" placeholder="do"></label><label>Veľkosť MB min<input data-xv="size-min" type="number" min="0" placeholder="od"></label><label>Veľkosť MB max<input data-xv="size-max" type="number" min="0" placeholder="do"></label></div><div class="nexus-xv-toggles"><label><input data-xv="hide-unmatched" type="checkbox"> Skryť nevyhovujúce</label><label><input data-xv="hide-unselected" type="checkbox"> Skryť nevybrané</label></div><div class="nexus-xv-actions"><label>Ďalšie strany<input data-xv="count" type="number" min="1" max="50" value="1"></label><button type="button" data-xv="load">+ Načítať</button><button type="button" data-xv="scan">Skenovať metadáta</button><button type="button" data-xv="tags">Tagy</button></div><div class="nexus-xv-actions"><button type="button" data-xv="select">Vybrať vyhovujúce</button><button type="button" data-xv="clear">Zrušiť výber</button><button type="button" data-xv="copy">Kopírovať pre IDM/JD2</button></div><button type="button" class="nexus-xv-import" data-xv="import">Importovať vybrané do Nexusu</button><small data-xv="notice" role="status" aria-live="polite"></small></div>`;
  document.body.append(panel);
  const launcher = document.createElement('button'); launcher.id = 'nexus-xv-import-launch'; launcher.textContent = 'NEXUS · XVideos Import'; document.body.append(launcher);
  const show = visible => { panel.hidden = !visible; launcher.hidden = visible; document.documentElement.classList.toggle('nexus-xv-panel-open', visible); };
  panel.querySelector('[data-xv="collapse"]').onclick = () => show(false); launcher.onclick = () => show(true);
  panel.querySelector('[data-xv="filter"]').oninput = event => { state.filter = event.target.value.trim().toLowerCase(); render(); };
  panel.querySelector('[data-xv="tag"]').oninput = event => { state.tag = normalize(event.target.value); render(); };
  panel.querySelector('[data-xv="quality"]').onchange = event => { state.quality = event.target.value; render(); };
  for (const [key, prop] of [['duration-min','durationMin'], ['duration-max','durationMax'], ['size-min','sizeMin'], ['size-max','sizeMax']]) panel.querySelector(`[data-xv="${key}"]`).oninput = event => { state[prop] = Math.max(0, Number(event.target.value) || 0); render(); };
  panel.querySelector('[data-xv="hide-unmatched"]').onchange = event => { state.hideUnmatched = event.target.checked; render(); };
  panel.querySelector('[data-xv="hide-unselected"]').onchange = event => { state.hideUnselected = event.target.checked; render(); };
  panel.querySelector('[data-xv="sort"]').onchange = event => { state.sort = event.target.value; render(); };
  panel.querySelector('[data-xv="direction"]').onchange = event => { state.direction = event.target.value; render(); };
  panel.querySelector('[data-xv="load"]').onclick = loadPages; panel.querySelector('[data-xv="scan"]').onclick = scanMetadata; panel.querySelector('[data-xv="tags"]').onclick = loadTags;
  panel.querySelector('[data-xv="select"]').onclick = () => {
    for (const row of cards(document).filter(isMatch)) {
      state.selected.add(row.url); row.card.classList.add('nexus-xv-selected'); row.card.querySelector('.nexus-xv-select')?.setAttribute('aria-pressed', 'true');
    }
    render();
  };
  panel.querySelector('[data-xv="clear"]').onclick = () => { state.selected.clear(); cards(document).forEach(row => row.card.classList.remove('nexus-xv-selected')); render(); };
  panel.querySelector('[data-xv="copy"]').onclick = copy; panel.querySelector('[data-xv="import"]').onclick = importSelected;
  // XVideos continuously mutates its player, ads and navigation. Watching the
  // whole DOM and re-rendering for each mutation created a feedback loop: this
  // panel adds controls, the observer sees them, then renders again forever.
  // Only react to a genuinely new, unprocessed video card (lazy/infinite load).
  let refreshTimer = 0;
  const containsNewCard = node => {
    if (node.nodeType !== Node.ELEMENT_NODE || node.closest?.('#nexus-xv-import-panel, #nexus-xv-import-launch')) return false;
    const candidates = [node, ...node.querySelectorAll?.(cardSelector) || []];
    return candidates.some(card => card.matches?.(cardSelector) && !card.querySelector(':scope > .nexus-xv-select'));
  };
  new MutationObserver(mutations => {
    if (state.loading || !mutations.some(m => [...m.addedNodes].some(containsNewCard))) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(render, 100);
  }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('hashchange', () => {
    setTimeout(render, 150);
    setTimeout(render, 600);
  });
  window.addEventListener('popstate', () => setTimeout(render, 150));
  show(true); render();
})();
