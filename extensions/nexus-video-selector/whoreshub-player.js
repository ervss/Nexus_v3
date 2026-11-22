// Play the visible Whoreshub list in its current DOM order using the site player.
(() => {
  'use strict';
  if (window.NVSWhoreshubPlayer) return;
  function selectHlsLevel(levels, source) {
    if (!levels?.length) return -1;
    const rows = levels.map((item, index) => ({ item, index, height: Number(item.height) || 0,
      bandwidth: Number(item.averageBitrate || item.bitrate) || 0 }));
    const exact = source.variantUrl && rows.filter(({ item }) =>
      item.uri === source.variantUrl || (Array.isArray(item.url) ? item.url : [item.url]).includes(source.variantUrl));
    let candidates = exact?.length ? exact : rows;
    if (!exact?.length && source.height) {
      const heightMatches = rows.filter(row => row.height === source.height);
      const lower = rows.filter(row => row.height <= source.height);
      candidates = heightMatches.length ? heightMatches : lower.length ? lower : rows;
    }
    candidates.sort((a, b) => b.height - a.height ||
      (source.bandwidth && (exact?.length || a.height === source.height)
        ? Math.abs(a.bandwidth - source.bandwidth) - Math.abs(b.bandwidth - source.bandwidth)
        : b.bandwidth - a.bandwidth));
    return candidates[0].index;
  }
  function startHlsAtQuality(session, source) {
    const level = selectHlsLevel(session.levels, source);
    if (level < 0) return null;
    // HLS.js indices refer to its sorted, supported levels, not manifest order.
    // Choose before loading the first fragment and keep manual quality locked.
    session.startLevel = level;
    session.currentLevel = level;
    session.loadLevel = level;
    session.startLoad();
    return session.levels[level];
  }
  function embedUrl(raw, base = location.href) {
    try {
      const u = new URL(raw, base);
      const origin = new URL(base).origin;
      const match = u.pathname.match(/^\/videos\/(\d+)\//);
      if (u.origin !== origin || !/(^|\.)whoreshub\.com$/i.test(u.hostname) || !match) return '';
      return `${origin}/embed/${match[1]}`;
    } catch { return ''; }
  }
  // Same KVS URL decoding used by the extension's metadata extractor.
  function realUrl(raw, license) {
    if (!raw.startsWith('function/0/')) return raw;
    if (!/^\$?\d+$/.test(license || '')) return '';
    const code = license.replace(/\$/g, '');
    const values = [...code].map(Number);
    const modified = code.replace(/0/g, '1');
    const center = Math.floor(modified.length / 2);
    const digits = String(4 * Math.abs(parseInt(modified.slice(0, center + 1), 10) - parseInt(modified.slice(center), 10))).slice(0, center + 1);
    const token = [...digits].flatMap((v, i) => [0, 1, 2, 3].map(offset => (values[i + offset] + Number(v)) % 10));
    const u = new URL(raw.slice('function/0/'.length));
    const parts = u.pathname.split('/');
    const hash = parts[3] || '';
    if (hash.length < 32) return '';
    const indices = Array.from({ length: 32 }, (_, i) => i);
    let sum = 0;
    for (let i = 31; i >= 0; i--) { sum += token[i] || 0; const dest = (i + sum) % 32; [indices[i], indices[dest]] = [indices[dest], indices[i]]; }
    parts[3] = indices.map(i => hash[i]).join('') + hash.slice(32);
    u.pathname = parts.join('/'); return u.href;
  }
  function sourcesFromHtml(html, pageUrl) {
    if (!embedUrl(pageUrl)) return [];
    const block = String(html || '').match(/\bflashvars\s*=\s*\{([\s\S]*?)\}\s*;/i)?.[1] || '';
    const license = block.match(/\blicense_code\s*:\s*['"]([^'"]+)['"]/)?.[1] || '';
    const id = block.match(/\bvideo_id\s*:\s*['"](\d+)['"]/)?.[1];
    if (id && id !== new URL(pageUrl).pathname.split('/')[2]) return [];
    const sources = [];
    const seen = new Set();
    for (const match of block.matchAll(/\b(video_(?:alt_)?url\d*)\s*:\s*['"]([^'"]+)['"]/g)) {
      try {
        const u = new URL(realUrl(match[2].replace(/\\\//g, '/').replace(/&amp;/g, '&'), license), pageUrl);
        if (u.protocol !== 'https:' || (!u.pathname.includes('/get_file/') && !/\.(mp4|webm)\/?$/i.test(u.pathname)) || /preview|trailer/i.test(u.pathname) || seen.has(u.href)) continue;
        seen.add(u.href);
        const label = block.match(new RegExp(`\\b${match[1]}_text\\s*:\\s*['"]([^'"]+)['"]`))?.[1] || '';
        const height = Number(label.match(/(\d{3,4})\s*p/i)?.[1] || u.pathname.match(/[_-](\d{3,4})p/i)?.[1]) || (/4k/i.test(label) ? 2160 : /2k/i.test(label) ? 1440 : 0);
        sources.push({ url: u.href, height, quality: height ? `${height}P` : 'ORIGINAL' });
      } catch { }
    }
    return sources.sort((a, b) => b.height - a.height);
  }
  function collect(grid) {
    const seen = new Set();
    const entries = [];
    for (const card of grid.querySelectorAll('.thumb')) {
      if (card.hidden || card.classList.contains('nvs-hidden')) continue;
      const link = card.querySelector('a[href*="/videos/"]');
      if (!link) continue;
      let url;
      try { url = new URL(link.getAttribute('href'), location.href).href.split(/[?#]/)[0]; }
      catch { continue; }
      if (!embedUrl(url) || seen.has(url)) continue;
      seen.add(url);
      const title = link.getAttribute('title') || card.querySelector('img[alt]')?.alt
        || card.querySelector('.description')?.textContent.trim() || 'Video';
      entries.push({ url, title, card });
    }
    return entries;
  }
  // Resolve by URL on each move so sorting and appended batches keep their order.
  function createPlaylist(readEntries, onChange) {
    let current = null;
    const refresh = () => {
      const entries = readEntries();
      const index = current ? entries.findIndex(e => e.url === current.url) : -1;
      return { entries, index, current };
    };
    const open = url => {
      const entry = readEntries().find(e => e.url === url);
      if (!entry) return false;
      current = entry; onChange(entry); return true;
    };
    const move = delta => {
      const { entries, index } = refresh();
      const target = index < 0 ? (delta > 0 ? 0 : entries.length - 1) : index + delta;
      if (target < 0 || target >= entries.length) return false;
      return open(entries[target].url);
    };
    return { open, move, refresh };
  }
  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const n = Math.floor(seconds);
    const s = String(n % 60).padStart(2, '0');
    return n >= 3600 ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${s}` : `${Math.floor(n / 60)}:${s}`;
  }

  function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return 'Nedostupná';
    return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  }
  let attached = null;
  function attach(grid, panel, adapter = null) {
    const readEntries = () => adapter ? adapter.collect(grid) : collect(grid);
    const cardSelector = adapter?.cardSelector || '.thumb';
    if (attached?.grid === grid) return attached;
    attached?.destroy();
    let dialog = null;
    let frame = null;
    let media = null;
    let mediaCleanup = () => {};
    let poll = null;
    let loadingTimer = null;
    let sourceController = null;
    let focusSource = null;
    let priorOverflow = '';
    let generation = 0;
    let paintScheduled = false;
    let dead = false;
    const entryButtons = new Set();
    const playlist = createPlaylist(readEntries, entry => render(entry));
    const launch = document.createElement('button');
    launch.type = 'button'; launch.id = 'nvs-wh-playlist';
    launch.className = 'nvs-btn-load-pages'; launch.textContent = '▶ Prehrať playlist';
    launch.title = 'Prehrať zobrazené videá v aktuálnom poradí';
    const anchor = panel.querySelector('#nvs-wh-all');
    if (anchor) anchor.after(launch); else panel.append(launch);
    launch.addEventListener('click', () => {
      const first = readEntries()[0];
      if (first) open(first.url, launch);
    });
    function navigation() {
      if (!dialog) return;
      const { entries, index, current } = playlist.refresh();
      dialog.querySelector('[data-wh="position"]').textContent = index >= 0 ? `${index + 1} / ${entries.length}` : `Mimo aktuálneho filtra · ${entries.length} videí`;
      dialog.querySelector('[data-wh="previous"]').disabled = !entries.length || index === 0;
      dialog.querySelector('[data-wh="next"]').disabled = !entries.length || index === entries.length - 1;
      for (const card of grid.querySelectorAll('.nvs-wh-playing')) {
        if (card !== current?.card) card.classList.remove('nvs-wh-playing');
      }
      if (current?.card && !current.card.classList.contains('nvs-wh-playing')) current.card.classList.add('nvs-wh-playing');
    }
    function disposeFrame() {
      generation++;
      clearInterval(poll); poll = null;
      clearTimeout(loadingTimer); loadingTimer = null;
      sourceController?.abort(); sourceController = null;
      mediaCleanup(); mediaCleanup = () => {};
      try { media?.pause(); } catch { }
      if (media?.ownerDocument === document) {
        media.removeAttribute('src'); media.load(); media.remove();
      }
      media = null;
      frame?.remove(); frame = null;
    }
    function close() {
      if (!dialog) return;
      disposeFrame();
      document.removeEventListener('keydown', keydown, true);
      document.body.style.overflow = priorOverflow;
      const old = dialog; dialog = null;
      if (old.open) old.close();
      old.remove();
      for (const card of grid.querySelectorAll('.nvs-wh-playing')) card.classList.remove('nvs-wh-playing');
      if (focusSource?.isConnected) focusSource.focus({ preventScroll: true });
    }
    async function togglePlayback() {
      if (!media || !dialog) return;
      if (!media.paused) media.pause();
      else {
        try { await media.play(); }
        catch { if (dialog) dialog.querySelector('[data-wh="status"]').textContent = 'Spusti video tlačidlom ▶ v prehrávači.'; }
      }
      updatePlayback();
    }
    function keydown(event) {
      if (!dialog || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (event.target?.matches?.('input, textarea, select, [contenteditable="true"]') && event.key !== 'Escape') return;
      if (!['ArrowLeft', 'ArrowRight', 'Escape', ' ', 'Spacebar'].includes(event.key)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.repeat) return;
      if (event.key === 'Escape') close();
      else if (event.key === 'ArrowLeft') playlist.move(-1);
      else if (event.key === 'ArrowRight') playlist.move(1);
      else void togglePlayback();
    }
    function updatePlayback() {
      if (!dialog || !media) return;
      dialog.querySelector('[data-wh="toggle"]').disabled = false;
      dialog.querySelector('[data-wh="toggle"]').textContent = media.paused ? '▶ Prehrať' : '❚❚ Pozastaviť';
      if (media.error) {
        dialog.querySelector('[data-wh="status"]').textContent = 'Video sa nedá prehrať. Skús Otvoriť detail alebo ďalšie video.';
      } else if (media.ended) {
        const { entries, index } = playlist.refresh();
        dialog.querySelector('[data-wh="status"]').textContent = index === entries.length - 1 ? 'Koniec načítaného playlistu.' : 'Video sa skončilo.';
      } else if (media.readyState >= 1) {
        const quality = media.videoHeight ? `${media.videoHeight}p (${media.videoWidth} × ${media.videoHeight})` : media.dataset.nvsWhQuality;
        dialog.querySelector('[data-wh="playing-quality"]').textContent = quality || 'Zisťujem…';
        dialog.querySelector('[data-wh="status"]').textContent = `${media.paused ? 'Pozastavené' : 'Prehráva sa'}${quality ? ` · ${quality}` : ''} · ${formatTime(media.currentTime)} / ${formatTime(media.duration)}`;
        clearTimeout(loadingTimer);
      }
    }
    function wirePlayer(token) {
      if (!frame || !dialog || token !== generation) return;
      try {
        const doc = frame.contentDocument;
        if (!doc) return;
        mediaCleanup(); mediaCleanup = () => {};
        doc.addEventListener('keydown', keydown, true);
        let video = null;
        const bindVideo = () => {
          if (!dialog || token !== generation) return;
          const candidate = [...doc.querySelectorAll('video')].find(v => v.currentSrc || v.getAttribute('src')) || doc.querySelector('video');
          if (!candidate || video === candidate) return;
          if (video) video.removeEventListener('ended', ended);
          media = video = candidate;
          video.addEventListener('ended', ended);
          void (async () => {
            try { await video.play(); }
            catch { if (dialog && token === generation) dialog.querySelector('[data-wh="status"]').textContent = 'Klikni na ▶ Prehrať.'; }
          })();
        };
        const ended = () => {
          if (dialog?.querySelector('[data-wh="autonext"]').checked) {
            if (!playlist.move(1) && dialog) dialog.querySelector('[data-wh="status"]').textContent = 'Koniec načítaného playlistu.';
          }
        };
        const observer = new MutationObserver(bindVideo);
        observer.observe(doc, { childList: true, subtree: true });
        mediaCleanup = () => {
          observer.disconnect(); doc.removeEventListener('keydown', keydown, true);
          video?.removeEventListener('ended', ended);
        };
        bindVideo();
      } catch {
        dialog.querySelector('[data-wh="status"]').textContent = 'Použi tlačidlá pod prehrávačom alebo Otvoriť detail.';
      }
    }
    function embed(entry, token) {
      if (!dialog || token !== generation) return;
      mediaCleanup(); mediaCleanup = () => {};
      if (media?.ownerDocument === document) {
        media.pause(); media.removeAttribute('src'); media.load(); media.remove();
      }
      media = null;
      dialog.querySelector('[data-wh="quality"]').disabled = true;
      dialog.querySelector('[data-wh="playing-quality"]').textContent = 'Náhradný prehrávač';
      dialog.querySelector('[data-wh="size"]').textContent = 'Nedostupná';
      const fallbackUrl = adapter ? adapter.embedUrl(entry) : embedUrl(entry.url);
      if (!fallbackUrl) {
        dialog.querySelector('[data-wh="status"]').textContent = 'Zdroj nie je dostupný. Skús Otvoriť detail alebo ďalšie video.';
        return;
      }
      dialog.querySelector('[data-wh="status"]').textContent = 'Načítavam náhradný prehrávač…';
      dialog.querySelector('[data-wh="toggle"]').disabled = true;
      clearTimeout(loadingTimer);
      loadingTimer = setTimeout(() => {
        if (dialog && token === generation) dialog.querySelector('[data-wh="status"]').textContent = 'Prehrávač sa nenačítal. Skús Otvoriť detail alebo ďalšie video.';
      }, 20000);
      frame = document.createElement('iframe');
      frame.title = `Prehrávač: ${entry.title}`;
      frame.allow = 'autoplay; fullscreen; picture-in-picture';
      frame.setAttribute('allowfullscreen', '');
      if (!adapter?.allowUnsandboxedEmbed) {
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
      }
      frame.addEventListener('load', () => wirePlayer(token));
      frame.src = fallbackUrl;
      dialog.querySelector('[data-wh="stage"]').append(frame);
    }
    function nativePlayer(entry, sources, token) {
      if (!dialog || token !== generation) return;
      const video = document.createElement('video');
      video.controls = true; video.playsInline = true; video.preload = 'metadata';
      video.setAttribute('aria-label', `Prehrávač: ${entry.title}`);
      dialog.querySelector('[data-wh="stage"]').append(video);
      media = video;
      let hls = null;
      let index = 0;
      let epoch = 0;
      let restoreTime = 0;
      let resume = true;
      let probed = false;
      const select = dialog.querySelector('[data-wh="quality"]');
      select.replaceChildren();
      const automatic = document.createElement('option');
      automatic.value = 'auto'; automatic.textContent = 'Najvyššia dostupná'; select.append(automatic);
      sources.forEach((source, i) => {
        const option = document.createElement('option'); option.value = String(i);
        option.textContent = source.quality; select.append(option);
      });
      select.disabled = false;
      const chooseSource = () => {
        if (!dialog || token !== generation) return;
        epoch++; probed = false;
        video.dataset.nvsWhQuality = sources[index].quality;
        dialog.querySelector('[data-wh="playing-quality"]').textContent = `Načítavam ${sources[index].quality}…`;
        dialog.querySelector('[data-wh="size"]').textContent = 'Zisťujem…';
        hls?.destroy(); hls = null;
        const source = sources[index];
        if (source.type === 'hls' && window.Hls?.isSupported()) {
          hls = new window.Hls({ enableWorker: false, autoStartLoad: false });
          const session = hls;
          session.on(window.Hls.Events.MANIFEST_PARSED, () => {
            if (session !== hls || token !== generation) return;
            const chosen = startHlsAtQuality(session, source);
            if (!chosen) { failed(); return; }
            source.bandwidth = Number(chosen.averageBitrate || chosen.bitrate) || source.bandwidth;
            if (source.height && chosen.height !== source.height) {
              dialog.querySelector('[data-wh="quality-note"]').textContent = `${source.quality} nedostupné → ${chosen.height}p`;
            }
          });
          session.on(window.Hls.Events.ERROR, (event, data) => { if (data.fatal && session === hls) failed(); });
          session.loadSource(source.url); session.attachMedia(video);
        } else { video.src = source.url; video.load(); }
        dialog.querySelector('[data-wh="status"]').textContent = `Načítavam ${sources[index].quality}…`;
      };
      const changed = () => {
        restoreTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
        resume = !video.paused;
        index = select.value === 'auto' ? 0 : Number(select.value);
        dialog.querySelector('[data-wh="quality-note"]').textContent = '';
        chooseSource();
      };
      const failed = () => {
        if (Number.isFinite(video.currentTime) && video.currentTime > 0) restoreTime = video.currentTime;
        const failedQuality = sources[index].quality;
        if (++index < sources.length) {
          dialog.querySelector('[data-wh="quality-note"]').textContent = `${failedQuality} nedostupné → ${sources[index].quality}`;
          chooseSource();
        } else embed(entry, token);
      };
      const metadata = () => {
        if (!dialog || token !== generation || media !== video) return;
        if (restoreTime > 0 && Number.isFinite(video.duration)) video.currentTime = Math.min(restoreTime, Math.max(0, video.duration - 0.1));
        if (resume) void (async () => { try { await video.play(); } catch { } })();
        updatePlayback();
        probeSize();
      };
      const probeSize = () => {
        if (probed || !dialog || token !== generation) return;
        probed = true;
        const requestEpoch = epoch;
        void (async () => {
          let result;
          try {
            const source = sources[index];
            if (source.type === 'hls') {
              result = { estimated: true, sizeBytes: source.bandwidth && Number.isFinite(video.duration) ? source.bandwidth * video.duration / 8 : null };
            } else result = adapter ? await adapter.probeSize(source.url, entry.url) : await chrome.runtime.sendMessage({ type: 'PROBE_MEDIA_SIZE', url: source.url, referer: entry.url });
          } catch { }
          if (!dialog || token !== generation || requestEpoch !== epoch || media !== video) return;
          dialog.querySelector('[data-wh="size"]').textContent = `${result?.estimated && result?.sizeBytes ? '≈ ' : ''}${formatSize(result?.sizeBytes || (result?.sizeMb ? result.sizeMb * 1024 ** 2 : null))}`;
        })();
      };
      select.addEventListener('change', changed);
      const ended = () => {
        if (dialog?.querySelector('[data-wh="autonext"]').checked) playlist.move(1);
        updatePlayback();
      };
      video.addEventListener('error', failed);
      video.addEventListener('ended', ended);
      video.addEventListener('loadedmetadata', metadata);
      video.addEventListener('playing', probeSize);
      video.addEventListener('playing', updatePlayback);
      mediaCleanup = () => {
        video.removeEventListener('error', failed); video.removeEventListener('ended', ended);
        video.removeEventListener('loadedmetadata', metadata); video.removeEventListener('playing', updatePlayback);
        video.removeEventListener('playing', probeSize); select.removeEventListener('change', changed);
        epoch++; hls?.destroy(); hls = null;
      };
      chooseSource();
    }
    function render(entry) {
      if (!dialog) return;
      disposeFrame();
      const token = generation;
      dialog.querySelector('[data-wh="quality"]').disabled = true;
      dialog.querySelector('[data-wh="playing-quality"]').textContent = 'Zisťujem…';
      dialog.querySelector('[data-wh="size"]').textContent = 'Zisťujem…';
      dialog.querySelector('[data-wh="quality-note"]').textContent = '';
      dialog.querySelector('[data-wh="title"]').textContent = entry.title;
      dialog.querySelector('[data-wh="detail"]').href = entry.url;
      dialog.querySelector('[data-wh="status"]').textContent = 'Načítavam prehrávač…';
      dialog.querySelector('[data-wh="toggle"]').disabled = true;
      const controller = sourceController = new AbortController();
      const fetchTimer = setTimeout(() => controller.abort(), 12000);
      void (async () => {
        let sources = [];
        try {
          if (adapter) sources = await adapter.resolve(entry, controller.signal);
          else {
            const res = await fetch(entry.url, { credentials: 'include', signal: controller.signal });
            if (res.ok) sources = sourcesFromHtml(await res.text(), entry.url);
          }
        } catch { }
        finally { clearTimeout(fetchTimer); if (sourceController === controller) sourceController = null; }
        if (!dialog || token !== generation) return;
        if (sources.length) nativePlayer(entry, sources, token);
        else embed(entry, token);
      })();
      poll = setInterval(updatePlayback, 500);
      loadingTimer = setTimeout(() => {
        if (dialog && token === generation) dialog.querySelector('[data-wh="status"]').textContent = 'Načítanie trvá dlho. Skús Otvoriť detail alebo ďalšie video.';
      }, 20000);
      navigation();
    }
    function open(url, source) {
      focusSource = source;
      if (!dialog) {
        dialog = document.createElement('dialog');
        dialog.id = 'nvs-wh-player'; dialog.setAttribute('aria-labelledby', 'nvs-wh-player-title');
        dialog.innerHTML = `
          <header class="nvs-wh-player-header"><div><span class="nvs-wh-player-caption">${adapter?.label || 'WHORESHUB'} PLAYLIST</span><h2 id="nvs-wh-player-title" data-wh="title"></h2></div><span data-wh="position"></span><button type="button" data-wh="close" aria-label="Zatvoriť prehrávač">✕</button></header>
          <div class="nvs-wh-player-stage" data-wh="stage"></div>
          <div class="nvs-wh-quality-bar"><label>Kvalita <select data-wh="quality" aria-label="Kvalita videa" disabled><option>Najvyššia dostupná</option></select></label><span>Prehráva sa: <strong data-wh="playing-quality">Zisťujem…</strong></span><span>Veľkosť súboru: <strong data-wh="size">Zisťujem…</strong></span><span data-wh="quality-note" role="status"></span></div>
          <div class="nvs-wh-player-controls"><button type="button" data-wh="previous">← Predchádzajúce</button><button type="button" data-wh="toggle" disabled>▶ Prehrať</button><button type="button" data-wh="next">Ďalšie →</button><label><input type="checkbox" data-wh="autonext" checked> Automaticky ďalšie</label><a data-wh="detail" target="_blank" rel="noopener noreferrer">Otvoriť detail ↗</a></div>
          <footer class="nvs-wh-player-footer"><span data-wh="status"></span><span>← / → video · Space play/pause · Esc zavrieť</span></footer>`;
        document.body.append(dialog);
        dialog.querySelector('[data-wh="close"]').addEventListener('click', close);
        dialog.querySelector('[data-wh="previous"]').addEventListener('click', () => playlist.move(-1));
        dialog.querySelector('[data-wh="next"]').addEventListener('click', () => playlist.move(1));
        dialog.querySelector('[data-wh="toggle"]').addEventListener('click', () => { void togglePlayback(); });
        dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
        dialog.addEventListener('close', event => { if (event.target === dialog) close(); });
        dialog.addEventListener('click', event => {
          if (event.target !== dialog) return;
          const r = dialog.getBoundingClientRect();
          if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close();
        });
        priorOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        for (const video of document.querySelectorAll('video')) video.pause();
        document.addEventListener('keydown', keydown, true);
        dialog.showModal();
      }
      if (!playlist.open(url)) close();
    }
    async function paint() {
      paintScheduled = false;
      const list = readEntries();
      launch.disabled = !list.length;
      for (let start = 0; start < list.length && !dead; start += 20) {
        for (const entry of list.slice(start, start + 20)) {
          if (entry.card.querySelector('.nvs-wh-play')) continue;
          const host = adapter?.playHost?.(entry.card) || entry.card.querySelector('.thumb-img') || entry.card;
          if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
          const button = document.createElement('button');
          button.type = 'button'; button.className = 'nvs-wh-play'; button.textContent = '▶';
          button.title = `Prehrať v playliste: ${entry.title}`;
          button.setAttribute('aria-label', button.title);
          for (const evt of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'touchstart']) {
            button.addEventListener(evt, event => { event.stopPropagation(); }, true);
          }
          const activate = event => {
            event.preventDefault(); event.stopImmediatePropagation(); open(entry.url, button);
          };
          button.addEventListener('click', activate, true);
          button.addEventListener('nvs-wh-activate', activate);
          host.append(button); entryButtons.add(button);
        }
        if (start + 20 < list.length) await new Promise(resolve => requestAnimationFrame(resolve));
      }
      navigation();
    }
    function schedulePaint() {
      if (paintScheduled || dead) return;
      paintScheduled = true; requestAnimationFrame(() => { void paint(); });
    }
    const observer = new MutationObserver(records => {
      if (records.some(r => r.type === 'attributes'
        ? (r.target.matches(cardSelector) || r.target.querySelector(cardSelector)) && (r.attributeName === 'hidden' || r.attributeName === 'style'
          || (!r.target.matches(cardSelector) && r.attributeName === 'class')
          || /\bnvs-hidden\b/.test(r.oldValue || '') !== r.target.classList.contains('nvs-hidden'))
        : [...r.addedNodes, ...r.removedNodes].some(n => n.matches?.(cardSelector) || n.querySelector?.(cardSelector)))) schedulePaint();
    });
    observer.observe(grid, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'hidden', 'style'] });
    const destroy = () => {
      dead = true; observer.disconnect(); close(); launch.remove();
      for (const button of entryButtons) button.remove();
      entryButtons.clear();
      panel.querySelector('#nvs-panel-disable')?.removeEventListener('click', destroy);
      if (attached?.grid === grid) attached = null;
    };
    panel.querySelector('#nvs-panel-disable')?.addEventListener('click', destroy);
    attached = { grid, destroy, refresh: schedulePaint };
    schedulePaint();
    return attached;
  }
  window.NVSWhoreshubPlayer = { attach, embedUrl, sourcesFromHtml, collect, createPlaylist, formatTime, formatSize, realUrl, selectHlsLevel, startHlsAtQuality };
  window.NVSListingPlayer = window.NVSWhoreshubPlayer;
})();
