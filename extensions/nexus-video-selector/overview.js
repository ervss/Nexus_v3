/* Turbo overview. One hosting ID, shared card selection, bounded metadata queue. */
(function () {
  'use strict';
  const validTurboId = value => /^[A-Za-z0-9_-]{1,128}$/.test(String(value || '').trim()) ? String(value).trim() : null;
  const idOf = value => {
    try {
      const u = new URL(value, location.href);
      if (u.protocol !== 'https:' || u.hostname !== 'turbo.cr' || u.port || u.username || u.password) return null;
      return u.pathname.match(/^\/(?:v|d|embed)\/([A-Za-z0-9_-]{1,128})\/?$/)?.[1] || null;
    } catch { return null; }
  };
  const archveIdOf = value => {
    try {
      const u = new URL(value, location.href);
      if (u.protocol !== 'https:' || u.port || u.username || u.password) return null;
      if (/^hls\.archve\.xyz$/i.test(u.hostname)) {
        return u.pathname.match(/^\/([a-f0-9-]{8,64})(?:\/|$)/i)?.[1] || null;
      }
      if (!/(^|\.)archve\.xyz$/i.test(u.hostname)) return null;
      return u.pathname.match(/^\/(?:watch|e|d)\/([a-f0-9-]{8,64})\/?$/i)?.[1] || null;
    } catch { return null; }
  };
  const keyOf = value => {
    const turbo = idOf(value);
    if (turbo) return turbo;
    const archve = archveIdOf(value);
    return archve ? `archve:${archve}` : null;
  };
  const targetFromNode = node => {
    if (node.tagName === 'A' || node.tagName === 'IFRAME' || node.tagName === 'VIDEO' || node.tagName === 'SOURCE') {
      const raw = node.getAttribute(node.tagName === 'A' ? 'href' : 'src');
      const turbo = idOf(raw);
      if (turbo) {
        return {
          provider: 'turbo', key: turbo, id: turbo,
          url: `https://turbo.cr/v/${turbo}`, originalUrl: new URL(raw, location.href).href,
          embedUrl: `https://turbo.cr/embed/${turbo}#nvs-gallery`
        };
      }
      const archve = archveIdOf(raw);
      if (archve) {
        return {
          provider: 'archve', key: `archve:${archve}`, id: archve,
          url: `https://archve.xyz/watch/${archve}`, originalUrl: new URL(raw, location.href).href,
          embedUrl: `https://archve.xyz/e/${archve}`
        };
      }
      return null;
    }
    if (node.hasAttribute?.('data-video-id') && (
      node.classList?.contains('thTurboPreview')
      || node.classList?.contains('thTurboPlayer')
      || /turbo/i.test(node.getAttribute('data-sign-url') || '')
    )) {
      const turbo = validTurboId(node.getAttribute('data-video-id'));
      if (!turbo) return null;
      return {
        provider: 'turbo', key: turbo, id: turbo,
        url: `https://turbo.cr/v/${turbo}`, originalUrl: `https://turbo.cr/v/${turbo}`,
        embedUrl: `https://turbo.cr/embed/${turbo}#nvs-gallery`
      };
    }
    return null;
  };
  const positive = v => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;
  const shortSide = r => positive(r.width) && positive(r.height) ? Math.min(r.width, r.height) : null;
  const durationText = n => {
    if (!positive(n)) return 'Nezistené';
    const s = Math.round(n), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
    return `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  const sizeText = n => !positive(n) ? 'Nezistené' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GiB` : `${(n / 1024 ** 2).toFixed(1)} MiB`;
  function threadName() {
    const heading = document.querySelector('.p-title-value');
    if (heading) {
      const copy = heading.cloneNode(true);
      copy.querySelectorAll('.label, .label-append').forEach(node => node.remove());
      const title = copy.textContent.replace(/\s+/g, ' ').trim();
      if (title) return title;
    }
    const slug = location.pathname.match(/\/threads\/([^/.]+)/i)?.[1];
    if (!slug) return '';
    try { return decodeURIComponent(slug).replace(/[-_]+/g, ' ').trim(); } catch { return slug.replace(/[-_]+/g, ' ').trim(); }
  }
  const labels = { waiting: 'Čaká', loading: 'Načítava údaje', ready: 'Pripravené', unknown: 'Nezistené', unavailable: 'Nedostupné', importing: 'Importuje sa', queued: 'Prijaté do fronty', imported: 'Importované', duplicate: 'Už v Nexuse', error: 'Chyba importu', uncertain: 'Výsledok nepotvrdený' };
  function filtered(rows, f) {
    return rows.filter(r => {
      const side = shortSide(r);
      if (f.search && !`${r.title} ${r.id}`.toLowerCase().includes(f.search.toLowerCase())) return false;
      if (f.resolution === 'unknown' && side !== null) return false;
      if (Number(f.resolution) > 0 && (side === null || side < Number(f.resolution))) return false;
      for (const [key, field, scale] of [['duration', 'duration', 1], ['size', 'size_bytes', 1024 ** 2]]) {
        const min = f[key + 'Min'], max = f[key + 'Max'], value = positive(r[field]);
        if (min !== '' && min != null && (value === null || value < Number(min) * scale)) return false;
        if (max !== '' && max != null && (value === null || value > Number(max) * scale)) return false;
      }
      const status = r.importStatus || r.status;
      if (f.status === 'not-imported' && ['imported', 'duplicate', 'queued', 'importing', 'uncertain'].includes(status)) return false;
      if (f.status !== 'all' && f.status !== 'not-imported' && status !== f.status) return false;
      return true;
    }).sort((a, b) => {
      const val = r => f.sort === 'resolution' ? shortSide(r) : positive(r[f.sort]);
      const av = val(a), bv = val(b);
      if (av === null || bv === null) return av === bv ? a.order - b.order : av === null ? 1 : -1;
      return (av - bv) * (f.direction === 'desc' ? -1 : 1) || a.order - b.order;
    });
  }
  function totals(rows) {
    return rows.reduce((t, r) => {
      for (const [field, missing] of [['size_bytes', 'missingSize'], ['duration', 'missingDuration']]) {
        if (positive(r[field])) t[field] += Number(r[field]); else t[missing]++;
      }
      return t;
    }, { size_bytes: 0, duration: 0, missingSize: 0, missingDuration: 0 });
  }
  function importOutcome(item, index, response) {
    if (!response?.success) return { status: response?.uncertain ? 'uncertain' : 'error', detail: response?.error || 'Nexus neodpovedá' };
    const result = response.data?.results?.find(r => r.index === index && r.url === item.url);
    if (result) {
      if (result.status === 'imported' && result.video_id) return { status: 'imported', detail: `Video #${result.video_id} uložené v knižnici; následné spracovanie môže ešte bežať.` };
      if (result.status === 'duplicate' && result.video_id) return { status: 'duplicate', detail: `Video #${result.video_id}` };
      if (result.status === 'mirror_attached' && result.video_id) return { status: 'imported', detail: `Zdroj pripojený k videu #${result.video_id}` };
      return { status: 'error', detail: result.reason || 'Položka nebola uložená' };
    }
    const job = response.data?.job_id || response.data?.job?.id;
    if (job) return { status: 'queued', detail: `Úloha #${job} prijatá serverom. Dokončenie over v import monitore Nexusu.`, job };
    return { status: 'uncertain', detail: 'Server nepotvrdil výsledok tejto položky. Pred opakovaním skontroluj Nexus.' };
  }
  window.NVSTurboModel = { idOf, archveIdOf, keyOf, filtered, totals, importOutcome, durationText, sizeText, shortSide };

  window.createNVSTurboOverview = function (adapter) {
    const records = new Map();
    let panel = null, observer = null, timer = null, renderTimer = null, paused = false, running = 0;
    let generation = 0, importing = false, port = '8000', settingsReady = false;
    let button = null, opener = null, cooldownUntil = 0;
    let threadTools = null, threadScanning = false, autoScan = false;
    const pending = new Set(), requestIds = new Set();
    const filters = { search: '', resolution: 'all', durationMin: '', durationMax: '', sizeMin: '', sizeMax: '', status: 'all', sort: 'duration', direction: 'desc' };
    const send = message => new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(message, response => resolve(chrome.runtime.lastError ? { success: false, error: 'Rozšírenie neodpovedá', uncertain: message.type === 'IMPORT_TO_NEXUS' } : response));
      } catch { resolve({ success: false, error: 'Obnov rozšírenie a stránku', uncertain: message.type === 'IMPORT_TO_NEXUS' }); }
    });
    const selected = r => [...r.cards].some(c => adapter.isSelected(c));
    function choose(r, value) {
      for (const c of r.cards) adapter.select(c, value);
      adapter.selectionChanged();
      scheduleRender();
    }
    function discover() {
      let added = false;
      for (const node of document.querySelectorAll('.message-body a[href], .message-body iframe[src], .message-body video[src], .message-body source[src], .message-body [data-video-id]')) {
        if (node.closest('#nvs-overview, [id^="nvs-"]')) continue;
        const target = targetFromNode(node);
        if (!target) continue;
        const post = node.closest('[id^="js-post-"], [id^="post-"], [data-content^="post-"]');
        if (!post) continue;
        let r = records.get(target.key);
        if (!r) {
          r = { ...target,
            title: `Video ${String(records.size + 1).padStart(2, '0')}`, order: records.size + 1,
            status: 'waiting', cards: new Set(), sources: new Map() };
          records.set(target.key, r); pending.add(target.key); added = true;
        }
        const postId = (post.id || post.dataset.content || '').replace(/^js-/, '');
        const link = [...post.querySelectorAll('a[href]')].find(a => /^#\d+$/.test(a.textContent.trim()));
        const permalink = link ? new URL(link.getAttribute('href'), location.href).href : `${location.href.split('#')[0]}#${postId}`;
        r.sources.set(permalink, { url: permalink, label: link?.textContent.trim() || postId });
        // Known embed wrapper is tight around a single video. Anchors get their
        // own wrapper, so selecting one never selects a whole post/reaction bar.
        let card = node.closest('[data-nvs-turbo-id]');
        if (!card) {
          if ((node.tagName === 'IFRAME' || node.tagName === 'VIDEO') && node.parentElement?.classList.contains('generic2wide-iframe-div')) {
            card = node.parentElement;
          } else if (node.tagName === 'SOURCE' && node.closest('.generic2wide-iframe-div')) {
            card = node.closest('.generic2wide-iframe-div');
          } else if (node.hasAttribute?.('data-video-id') && (
            node.classList?.contains('generic2wide-iframe-div')
            || node.classList?.contains('thTurboPreview')
            || node.classList?.contains('thTurboPlayer')
          )) {
            card = node;
          }
          if (!card) {
            const targetNode = node.tagName === 'SOURCE' ? (node.closest('video') || node) : node;
            card = document.createElement('span'); card.className = 'nvs-turbo-card';
            targetNode.before(card); card.append(targetNode);
          }
          card.dataset.nvsTurboId = target.key;
          adapter.register(card, r.url);
        }
        const wasSelected = selected(r);
        r.cards.add(card);
        if (wasSelected) adapter.select(card, true);
        if (panel && filters.durationMin === '60' && selected(r) && (!positive(r.duration) || r.duration < 60)) choose(r, false);
      }
      if (button) {
        button.textContent = `Prehľad videí (${records.size})`;
        button.hidden = !records.size && !document.querySelector('.message-body');
      }
      if (panel) { if (added) pump(); scheduleRender(); }
      scheduleRender();
    }
    function syncSelection() {
      for (const r of records.values()) {
        const value = selected(r);
        for (const c of r.cards) if (adapter.isSelected(c) !== value) adapter.select(c, value);
        if (autoScan && value && !r.autoSelected && !['ready','loading'].includes(r.status)) { r.status = 'waiting'; pending.add(r.key || r.id); }
        r.autoSelected = value;
      }
      if (autoScan) {
        threadScanning = true;
        for (const r of records.values()) if (selected(r) && r.status === 'waiting') pending.add(r.key || r.id);
        pump();
      }
      scheduleRender();
    }
    function scheduleRender() {
      if (renderTimer) return;
      renderTimer = requestAnimationFrame(() => { renderTimer = null; renderThread(); render(); });
    }
    function renderThread() {
      for (const r of records.values()) for (const card of r.cards) {
        let badges = card.querySelector(':scope > .nvs-thread-meta');
        if (!badges) {
          badges = element('div', null, 'nvs-thread-meta');
          for (const label of ['Dĺžka','Kvalita','Veľkosť']) { const badge = element('span'); badge.append(element('small', label), element('b')); badges.append(badge); }
          card.append(badges);
        }
        const side = shortSide(r), values = [durationText(r.duration), side ? `${side}p` : 'Nezistené', sizeText(r.size_bytes)];
        badges.querySelectorAll('b').forEach((b,i) => { b.textContent = values[i]; b.title = i === 1 && side ? `${r.width} × ${r.height}` : values[i]; });
        badges.dataset.state = r.status; badges.title = r.error || labels[r.status];
      }
      if (threadTools) {
        const picked = [...records.values()].filter(selected);
        threadTools.hidden = !records.size;
        threadTools.querySelector('[data-part="thread-progress"]').textContent = `${picked.length} vybraných · ${picked.filter(r=>r.status === 'ready').length} s údajmi${threadScanning && !paused && (running || pending.size) ? ` · skenujem (${pending.size + running})` : paused ? ' · zastavené' : ''}`;
        threadTools.querySelector('[data-part="thread-scan"]').disabled = !picked.length;
      }
    }
    function scanSelected(force = true) {
      stop(); pending.clear(); threadScanning = true;
      for (const r of records.values()) if (selected(r) && (force || r.status !== 'ready')) { r.force = force; r.status = 'waiting'; pending.add(r.key || r.id); }
      paused = false; pump(); scheduleRender();
    }
    function element(tag, text, cls) {
      const e = document.createElement(tag); if (text != null) e.textContent = text;
      if (cls) e.className = cls; return e;
    }
    function action(text, fn) {
      const b = element('button', text); b.type = 'button'; b.addEventListener('click', fn); return b;
    }
    function render() {
      if (!panel) return;
      const rows = [...records.values()], shown = filtered(rows, filters), picked = rows.filter(selected);
      const hidden = picked.filter(r => !shown.includes(r)).length, sum = totals(picked);
      panel.querySelector('[data-part="progress"]').textContent = `${records.size} unikátnych videí · Aktuálna stránka (vrátane už pripojených príspevkov) · ${rows.filter(r => !['waiting', 'loading'].includes(r.status)).length}/${rows.length} spracovaných · ${paused ? 'Zastavené' : running || pending.size ? 'Načítavam údaje' : 'Sken dokončený'}`;
      panel.querySelector('[data-part="summary"]').textContent = `${picked.length} vybraných · ${hidden} skrytých filtrom · ${sum.size_bytes ? sizeText(sum.size_bytes) : '0 MiB'} známych${sum.missingSize ? ` · veľkosť ${sum.missingSize} videí nezistená` : ''} · ${sum.duration ? durationText(sum.duration) : '0:00'} známych${sum.missingDuration ? ` · dĺžka ${sum.missingDuration} videí nezistená` : ''}`;
      const importBtn = panel.querySelector('[data-part="import"]');
      importBtn.textContent = importing ? 'Importuje sa…' : `Importovať vybrané (${picked.length})`;
      importBtn.disabled = importing || !settingsReady || !picked.length || picked.some(r => ['queued', 'importing', 'uncertain'].includes(r.importStatus));
      panel.querySelector('[data-part="retry"]').disabled = importing || !rows.some(r => r.importStatus === 'error');
      panel.querySelector('[data-part="port"]').disabled = importing;
      const body = panel.querySelector('.nvs-gallery'), visible = shown;
      // Keep existing media nodes connected: metadata and selection changes must
      // never reload a player or reset its currentTime.
      for (const card of [...body.children]) if (!visible.some(r => (r.key || r.id) === card.dataset.videoId)) card.remove();
      visible.forEach((r, index) => {
        const cardKey = r.key || r.id;
        let card = [...body.children].find(c => c.dataset.videoId === cardKey);
        if (!card) {
          card = element('article', null, 'nvs-gallery-card'); card.dataset.videoId = cardKey;
          const media = element('div', null, 'nvs-gallery-media');
          const frame = element('iframe'); frame.src = r.embedUrl || `https://turbo.cr/embed/${r.id}#nvs-gallery`;
          frame.loading = 'lazy';
          frame.title = `Prehrať ${r.id}`; frame.allow = 'fullscreen; picture-in-picture'; frame.allowFullscreen = true;
          frame.referrerPolicy = 'strict-origin-when-cross-origin'; media.append(frame);
          const info = element('div', null, 'nvs-gallery-info');
          const heading = element('label', null, 'nvs-gallery-heading'), cb = element('input'); cb.type = 'checkbox';
          cb.addEventListener('change', () => choose(r, cb.checked));
          heading.append(cb, element('strong')); info.append(heading, element('small', r.id, 'nvs-gallery-id'));
          const metrics = element('div', null, 'nvs-gallery-metrics');
          for (const label of ['Dĺžka', 'Kvalita', 'Veľkosť']) { const metric = element('div'); metric.append(element('small', label), element('b')); metrics.append(metric); }
          media.append(metrics);
          info.append(element('div', null, 'nvs-gallery-status'), element('div', null, 'nvs-gallery-sources'));
          card.append(media, info); body.append(card);
        }
        // CSS ordering avoids moving/reconnecting active iframe nodes.
        card.style.order = index; card.classList.toggle('is-selected', selected(r));
        const cb = card.querySelector('input'); cb.checked = selected(r); cb.setAttribute('aria-label', `Vybrať ${r.title}`);
        card.querySelector('strong').textContent = r.title;
        const side = shortSide(r), values = [durationText(r.duration), side ? `${side}p` : 'Nezistené', sizeText(r.size_bytes)];
        card.querySelectorAll('.nvs-gallery-metrics b').forEach((b, i) => { b.textContent = values[i]; b.title = i === 1 && side ? `${r.width} × ${r.height}` : values[i]; });
        const status = card.querySelector('.nvs-gallery-status'); status.dataset.state = r.importStatus || r.status;
        status.textContent = labels[r.importStatus || r.status]; status.title = r.detail || r.error || '';
        if (r.detail || r.error) status.append(element('small', r.detail || r.error));
        const sources = card.querySelector('.nvs-gallery-sources'); sources.replaceChildren(document.createTextNode('Príspevok '));
        for (const s of r.sources.values()) { const a = element('a', s.label); a.href = s.url; a.addEventListener('click', close); sources.append(a, document.createTextNode(' ')); }
        const link = element('a', 'Otvoriť ↗'); link.href = r.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; sources.append(link);
      });
      if (!visible.length) body.textContent = 'Žiadne videá nezodpovedajú filtru.';
      else if (body.firstChild?.nodeType === 3) body.firstChild.remove();
      panel.querySelector('[data-part="count"]').textContent = `${shown.length} zobrazených videí`;
    }
    async function pump() {
      if (!(panel || threadScanning) || paused || !settingsReady || running >= 3) return;
      if (Date.now() < cooldownUntil) {
        clearTimeout(timer); timer = setTimeout(pump, Math.min(60000, cooldownUntil - Date.now())); return;
      }
      while ((panel || threadScanning) && !paused && running < 3 && pending.size) {
        const key = pending.values().next().value; pending.delete(key);
        const r = records.get(key), epoch = generation, target = port;
        if (!r || (!panel && !selected(r))) continue;
        const requestId = crypto.randomUUID(); r.requestId = requestId; requestIds.add(requestId); running++; r.status = 'loading'; scheduleRender();
        for (const card of r.cards) for (const frame of card.querySelectorAll('iframe')) frame.loading = 'eager';
        if (r.provider !== 'archve') void send({ type: 'TURBO_PREPARE_FRAME', id: r.id });
        (async () => {
          try {
            const res = await send({ type: 'TURBO_OVERVIEW_META', url: r.url, originalUrl: r.originalUrl, port: target, requestId, force: Boolean(r.force) });
            if (epoch !== generation) return;
            r.force = false;
            if (res?.meta?.ok) {
              for (const k of ['duration', 'width', 'height', 'size_bytes']) if (positive(res.meta[k])) r[k] = positive(res.meta[k]);
              if (res.meta.title) r.title = res.meta.title;
              if (panel && filters.durationMin === '60' && positive(r.duration) && r.duration < 60 && selected(r)) choose(r, false);
              adapter.metadata?.(r.url, res.meta);
              r.error = ''; r.status = ['duration', 'width', 'height', 'size_bytes'].every(k => positive(r[k])) ? 'ready' : 'unknown';
            } else {
              r.status = ['duration','width','height','size_bytes'].every(k => positive(r[k])) ? 'ready' : res?.meta?.unavailable ? 'unavailable' : 'unknown';
              r.error = r.status === 'ready' ? '' : res?.meta?.error || res?.error || 'Nexus metadata API neodpovedá';
              if (res?.meta?.retry_after) cooldownUntil = Date.now() + res.meta.retry_after * 1000;
            }
          } finally {
            requestIds.delete(requestId); running--; scheduleRender(); pump();
          }
        })();
      }
    }
    function stop() {
      paused = true; generation++;
      clearTimeout(timer);
      for (const requestId of requestIds) void send({ type: 'TURBO_OVERVIEW_CANCEL', requestId });
      for (const r of records.values()) if (r.status === 'loading') { r.status = 'waiting'; pending.add(r.key || r.id); }
      scheduleRender();
    }
    function refresh() {
      stop();
      for (const r of records.values()) { r.force = true; r.status = 'waiting'; pending.add(r.key || r.id); }
      paused = false; pump(); scheduleRender();
    }
    async function importRows(rows) {
      if (importing || !rows.length || !settingsReady || rows.some(r => ['queued', 'importing', 'uncertain'].includes(r.importStatus))) return;
      // Snapshot all selected IDs, including those hidden by filters.
      const snapshot = rows.map(r => ({ r, item: { url: r.url, sourceUrl: r.url, title: r.title,
        duration: r.duration || 0, width: r.width || 0, height: r.height || 0,
        file_size_mb: positive(r.size_bytes) ? r.size_bytes / 1024 ** 2 : null } }));
      const target = port;
      importing = true;
      for (const { r } of snapshot) { r.importStatus = 'importing'; r.importPort = target; r.detail = ''; }
      scheduleRender();
      try {
        const response = await adapter.importItems(target, snapshot.map(s => s.item), panel.querySelector('[data-part="batch"]').value.trim() || `Turbo prehľad ${new Date().toISOString()} ${crypto.randomUUID().slice(0, 8)}`);
        snapshot.forEach(({ r, item }, index) => {
          const outcome = importOutcome(item, index, response);
          r.importStatus = outcome.status; r.detail = outcome.detail;
          if (['imported', 'duplicate', 'queued'].includes(outcome.status)) choose(r, false);
        });
      } catch {
        for (const { r } of snapshot) { r.importStatus = 'uncertain'; r.detail = 'Výsledok nepotvrdený; pred retry skontroluj Nexus.'; }
      } finally {
        importing = false;
        if (panel) panel.querySelector('[data-part="notice"]').textContent = 'Výsledok je pri každom videu. Dávka už prijatá serverom sa zatvorením ani Stop nezastaví. Prijaté do fronty neznamená dokončený import.';
        scheduleRender();
      }
    }
    function exportItems() {
      return [...records.values()].filter(selected).map(r => ({ url: r.url, sourceUrl: r.url, title: r.title, duration: r.duration || null,
        width: r.width || null, height: r.height || null, size_bytes: r.size_bytes || null,
        file_size_mb: r.size_bytes ? r.size_bytes / 1024 ** 2 : null, hosting_id: r.id, sources: [...r.sources.values()] }));
    }
    async function copyUrls() {
      try { await navigator.clipboard.writeText(exportItems().map(r => r.url).join('\n')); panel.querySelector('[data-part="notice"]').textContent = 'URL skopírované.'; }
      catch { panel.querySelector('[data-part="notice"]').textContent = 'Kopírovanie zlyhalo. Použi Export JSON.'; }
    }
    function close() {
      if (!threadScanning) stop(); observer?.disconnect(); observer = null;
      if (renderTimer) cancelAnimationFrame(renderTimer); renderTimer = null;
      panel?.close(); panel?.remove(); panel = null;
      document.getElementById('nvs-import-bar')?.classList.remove('nvs-overview-open');
      opener?.focus();
    }
    async function open() {
      if (panel) return;
      filters.durationMin = '60';
      opener = document.activeElement;
      panel = element('dialog'); panel.id = 'nvs-overview'; panel.setAttribute('aria-label', 'Prehľad videí Turbo.cr');
      panel.innerHTML = `<div class="nvs-overview-shell"><header><div><h2>Prehľad videí <small>Turbo.cr</small></h2><p data-part="progress"></p></div><button type="button" data-part="close" aria-label="Zatvoriť prehľad">✕ Zatvoriť</button></header>
        <div class="nvs-overview-filters"><label>Hľadať názov alebo ID<input data-filter="search" type="search" placeholder="Názov alebo ID videa"></label>
        <label>Rozlíšenie<select data-filter="resolution"><option value="all">Všetky</option><option value="720">Aspoň 720p</option><option value="1080">Aspoň 1080p</option><option value="unknown">Neznáme</option></select></label>
        <label>Dĺžka od (sekundy)<input data-filter="durationMin" type="number" min="0"></label><label>Dĺžka do (sekundy)<input data-filter="durationMax" type="number" min="0"></label>
        <label>Veľkosť od (MiB)<input data-filter="sizeMin" type="number" min="0" step="any"></label><label>Veľkosť do (MiB)<input data-filter="sizeMax" type="number" min="0" step="any"></label>
        <label>Stav<select data-filter="status"><option value="all">Všetky</option><option value="ready">Pripravené</option><option value="unknown">Neznáme údaje</option><option value="unavailable">Nedostupné</option><option value="not-imported">Ešte neimportované</option><option value="error">Chyba importu</option></select></label>
        <label>Triedenie<select data-filter="sort"><option value="order">Poradie v threade</option><option value="duration">Dĺžka</option><option value="size_bytes">Veľkosť</option><option value="resolution">Rozlíšenie</option></select></label>
        <label>Smer<select data-filter="direction"><option value="asc">Vzostupne</option><option value="desc">Zostupne</option></select></label></div>
        <div class="nvs-overview-actions" data-part="actions"></div><p class="nvs-overview-help">Galéria · všetky videá v jednom prehľade · Posúvaj galériu nadol. Klikni na ▶ v náhľade pre prehrávanie. Kvalita p = kratšia strana videa. MiB = 1 048 576 bajtov.</p>
        <div class="nvs-gallery" aria-label="Galéria videí"></div>
        <div class="nvs-overview-count" data-part="count"></div>
        <footer><div><strong data-part="summary"></strong><p data-part="notice" role="status">Pri otvorení sa odznačia videá pod 60 s a s nezistenou dĺžkou. Import zahŕňa aj výber skrytý filtrom.</p></div><div class="nvs-overview-import"><label>Nexus<select data-part="port"><option>8000</option><option>8001</option><option>8002</option></select></label><label>Názov batchu<input data-part="batch" placeholder="Názov batchu (voliteľný)"></label><button data-part="retry">Zopakovať iba zlyhané</button><button data-part="import" class="nvs-overview-primary">Importovať vybrané (0)</button></div></footer></div>`;
      document.body.append(panel);
      panel.querySelector('[data-part="batch"]').value = threadName();
      const advanced = element('details', null, 'nvs-gallery-advanced');
      advanced.append(element('summary', 'Ďalšie filtre · dĺžka a veľkosť'));
      const ranges = element('div', null, 'nvs-gallery-ranges');
      for (const field of ['durationMax', 'sizeMin', 'sizeMax']) ranges.append(panel.querySelector(`[data-filter="${field}"]`).parentElement);
      advanced.append(ranges); panel.querySelector('.nvs-overview-filters').after(advanced);
      // Browser top layer prevents unrelated extension floating panels from
      // covering our close button, filters or import controls.
      panel.showModal();
      document.getElementById('nvs-import-bar')?.classList.add('nvs-overview-open');
      panel.querySelector('[data-part="close"]').addEventListener('click', close);
      panel.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.stopPropagation(); close(); }
        if (e.key === 'Tab') {
          const controls = [...panel.querySelectorAll('button:not(:disabled), input, select, a[href]')];
          const first = controls[0], last = controls.at(-1);
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      });
      for (const input of panel.querySelectorAll('[data-filter]')) {
        input.value = filters[input.dataset.filter];
        input.addEventListener('input', () => { filters[input.dataset.filter] = input.value; panel.querySelector('.nvs-gallery').scrollTop = 0; scheduleRender(); });
      }
      const actions = panel.querySelector('[data-part="actions"]');
      actions.append(action('Vybrať zobrazené', () => { for (const r of filtered([...records.values()], filters)) if (!['queued', 'uncertain', 'importing'].includes(r.importStatus)) choose(r, true); }),
        action('Zrušiť výber zobrazených', () => { for (const r of filtered([...records.values()], filters)) choose(r, false); }),
        action('Zrušiť celý výber', () => { for (const r of records.values()) choose(r, false); }),
        action('Obnoviť údaje', refresh), action('Stop', stop), action('Pokračovať', () => { paused = false; pump(); scheduleRender(); }),
        action('Kopírovať URL', copyUrls), action('Export JSON', () => adapter.exportJson({ schemaVersion: 2, exportedAt: new Date().toISOString(), items: exportItems() })));
      panel.querySelector('[data-part="import"]').addEventListener('click', () => importRows([...records.values()].filter(selected)));
      panel.querySelector('[data-part="retry"]').addEventListener('click', () => importRows([...records.values()].filter(r => r.importStatus === 'error')));
      const target = panel.querySelector('[data-part="port"]'); target.value = port;
      target.addEventListener('change', async () => {
        stop(); port = target.value;
        await chrome.storage.sync.set({ nvsOverviewPort: port });
        for (const r of records.values()) {
          r.importStatus = null; r.detail = ''; r.status = 'waiting'; pending.add(r.key || r.id);
        }
        paused = false; pump(); scheduleRender();
      });
      discover();
      for (const r of records.values()) if (selected(r) && (!positive(r.duration) || r.duration < 60)) choose(r, false);
      observer = new MutationObserver(mutations => {
        if (!mutations.some(m => !m.target.closest?.('#nvs-overview, [id^="nvs-"]') && (m.type === 'attributes' || [...m.addedNodes].some(n => n.nodeType === 1 && !n.matches?.('.nvs-selector-wrap, .nvs-badge, [id^="nvs-"]'))))) return;
        clearTimeout(timer); timer = setTimeout(discover, 150);
      });
      const root = document.querySelector('.js-threadMessages') || document.querySelector('.block-body') || document.body;
      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href', 'data-video-id'] });
      for (const r of records.values()) if (r.status === 'waiting') pending.add(r.key || r.id);
      paused = false; render(); pump(); panel.querySelector('[data-part="close"]').focus();
    }
    async function init() {
      chrome.runtime.onMessage.addListener(message => {
        if (message.type !== 'TURBO_FRAME_META') return;
        const r = records.get(message.id); if (!r) return;
        for (const key of ['duration','width','height','size_bytes']) if (positive(message.meta?.[key])) r[key] = positive(message.meta[key]);
        if (panel && filters.durationMin === '60' && positive(r.duration) && r.duration < 60 && selected(r)) choose(r, false);
        r.status = ['duration','width','height','size_bytes'].every(k => positive(r[k])) ? 'ready' : 'unknown';
        if (r.status === 'ready') r.error = '';
        if (r.status === 'ready' && r.requestId) void send({ type: 'TURBO_OVERVIEW_CANCEL', requestId: r.requestId });
        adapter.metadata?.(r.url, r); scheduleRender();
      });
      button = action('Prehľad videí', open); button.id = 'nvs-overview-launch';
      document.body.append(button);
      threadTools = element('div'); threadTools.id = 'nvs-thread-tools';
      const scan = action('Skenovať vybrané', () => scanSelected()); scan.dataset.part = 'thread-scan';
      const automatic = element('label'), check = element('input'); check.type = 'checkbox';
      check.addEventListener('change', () => { autoScan = check.checked; if (autoScan) scanSelected(false); }); automatic.append(check, document.createTextNode('Automaticky skenovať výber'));
      const progress = element('small'); progress.dataset.part = 'thread-progress';
      threadTools.append(action('Vybrať všetky', () => { for (const r of records.values()) choose(r,true); if (autoScan) scanSelected(false); }), scan, action('Stop skenu', stop), automatic, progress);
      document.body.append(threadTools);
      discover();
      try {
        const settings = await chrome.storage.sync.get({ nvsOverviewPort: null, ports: { '8000': '8000' } });
        const preferred = settings.nvsOverviewPort || settings.ports?.['8000'] || '8000';
        if (['8000', '8001', '8002'].includes(String(preferred))) port = String(preferred);
      } catch {
        // Use the same explicit default when extension settings cannot be read.
        port = '8000';
      } finally {
        settingsReady = true;
        if (panel) panel.querySelector('[data-part="port"]').value = port;
        pump(); scheduleRender();
      }
    }
    window.addEventListener('pagehide', close);
    return { init, discover, syncSelection, close, applyImportResults(items, response, target) {
      if (String(target) !== port) return;
      items.forEach((item, index) => {
        const r = records.get(keyOf(item.sourceUrl || item.url));
        if (!r) return;
        const outcome = importOutcome(item, index, response);
        r.importStatus = outcome.status; r.detail = outcome.detail; r.importPort = target;
        if (['imported', 'duplicate', 'queued'].includes(outcome.status)) choose(r, false);
      });
      scheduleRender();
    }, toggle(card) {
      const r = records.get(card.dataset.nvsTurboId); if (!r) return false;
      choose(r, !selected(r)); return true;
    }, destroy() { threadScanning = false; close(); threadTools?.remove(); button?.remove(); window.removeEventListener('pagehide', close); } };
  };
})();
