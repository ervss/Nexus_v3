const STORAGE_KEY = 'nexus.filesterRadar.browser.v1';
const TERMINAL_JOBS = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled']);
const SUBMITTED = new Set(['queued', 'pending', 'running', 'imported', 'duplicate']);

export function escapeMarkup(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
export function safeMediaUrl(value) {
  const raw = String(value || '').trim();
  if (/^\/(?!\/)/.test(raw)) return raw;
  if (/^data:image\/(?:png|jpeg|webp|svg\+xml)[;,]/i.test(raw)) return raw;
  try { const url = new URL(raw); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; } catch (_) { return ''; }
}
export function isVideoFile(file) {
  return !/\.(?:rar|zip|7z|jpe?g|png|gif|pdf|txt|mp3|wav|flac|srt|vtt|exe|js)(?:\.\d+)?$/i.test(file.title || '');
}
function positiveNumber(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : 0; }
export function formatDuration(value) {
  const seconds = Math.round(Number(value) || 0);
  if (seconds <= 0) return 'Čas ?';
  const hours = Math.floor(seconds / 3600); const minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
export function fileQuality(file) {
  const height = Number(file.height) || 0;
  if (height) return { height, label: height >= 2160 ? '4K' : `${height}p`, inferred: Boolean(file.quality_inferred) };
  const match = String(file.title || '').match(/(?:^|[^a-z0-9])(2160|1440|1080|720|480)p?(?=$|[^a-z0-9])|(?:^|[^a-z0-9])4k(?=$|[^a-z0-9])/i);
  const guessed = match ? Number(match[1]) || 2160 : 0;
  return { height: guessed, label: guessed >= 2160 ? '4K' : guessed ? `${guessed}p` : 'Kvalita ?', inferred: Boolean(guessed) };
}
export function buildRadarImport(files, keyword = '') {
  return {
    candidates: files.filter(isVideoFile).map(file => ({
      url: file.url, source_url: file.url, title: file.title || 'Filester video', source: 'filester',
      thumbnail: safeMediaUrl(file.thumbnail), duration: positiveNumber(file.duration),
      width: positiveNumber(file.width), height: positiveNumber(file.height),
      file_size_mb: positiveNumber(file.size_bytes) / 1024 ** 2,
      upload_date: file.uploaded_at || file.upload_date || null,
      tags: ['Filester Radar', ...(keyword ? [keyword] : [])],
    })),
    batch_name: `Filester Radar ${keyword ? `· ${keyword} ` : ''}· ${new Date().toISOString()}`.slice(0, 160),
    source_mode: 'filester', min_quality: 0, min_duration: 0, auto_metadata: true, playwright_fallback: true,
  };
}

export class RadarBrowser {
  constructor({ toast, bytes, onMetadata, keyword }) {
    this.toast = toast; this.bytes = bytes; this.onMetadata = onMetadata; this.keyword = keyword;
    this.files = []; this.limit = 60; this.chosen = new Map(); this.meta = new Map(); this.submitted = new Map(); this.jobs = [];
    this.importing = false; this.enriching = false; this.playerSequence = 0; this.queue = []; this.active = null;
    const ids = ['target-grid', 'browser-find', 'browser-quality', 'browser-density', 'browser-shape', 'browse-focus', 'browser-meta', 'browser-count', 'browser-selected-count', 'browser-selected-size', 'browser-select-visible', 'browser-clear', 'browser-import', 'browser-job', 'radar-player', 'radar-player-title', 'radar-player-meta', 'radar-player-video', 'radar-player-status', 'radar-player-close', 'radar-player-prev', 'radar-player-next', 'radar-player-position', 'radar-player-retry', 'radar-player-source', 'radar-player-select', 'radar-player-import'];
    this.el = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
    this.restore(); this.bind(); this.pollJobs();
  }
  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        chosen: [...this.chosen.values()], meta: [...this.meta].slice(-1000), jobs: this.jobs.slice(-6), submitted: [...this.submitted].slice(-1000),
        density: this.el['browser-density'].value, shape: this.el['browser-shape'].value,
      }));
    } catch (_) { /* Browsing and selection remain usable when storage is full. */ }
  }
  restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      for (const file of saved.chosen || []) if (/^https?:\/\//i.test(file.url)) this.chosen.set(file.url, file);
      this.meta = new Map(saved.meta || []); this.submitted = new Map(saved.submitted || []); this.jobs = saved.jobs || [];
      if (['large', 'medium', 'compact'].includes(saved.density)) this.el['browser-density'].value = saved.density;
      if (['portrait', 'landscape'].includes(saved.shape)) this.el['browser-shape'].value = saved.shape;
    } catch (_) {}
  }
  bind() {
    const el = this.el;
    for (const id of ['browser-find', 'browser-quality', 'browser-density', 'browser-shape']) el[id].addEventListener('input', () => { this.renderGrid(); this.save(); });
    el['browse-focus'].addEventListener('click', () => {
      const focused = document.body.classList.toggle('radar-browsing');
      el['browse-focus'].setAttribute('aria-pressed', String(focused)); el['browse-focus'].textContent = focused ? '⛶ Späť na Radar' : '⛶ Iba browsing';
      document.getElementById('target-panel').scrollIntoView({ block: 'start' });
    });
    el['target-grid'].addEventListener('change', event => {
      if (!event.target.matches('.browser-check')) return;
      this.toggle(event.target.closest('[data-file-url]').dataset.fileUrl, event.target.checked);
    });
    el['target-grid'].addEventListener('click', event => {
      const card = event.target.closest('[data-file-url]'); if (!card) return;
      if (event.target.closest('.browser-play')) this.openPlayer(card.dataset.fileUrl);
      if (event.target.closest('.browser-card-import')) this.importFiles([this.find(card.dataset.fileUrl)]);
    });
    el['target-grid'].addEventListener('error', event => { if (event.target.matches('.browser-thumb')) event.target.parentElement.classList.add('image-missing'); }, true);
    el['browser-select-visible'].addEventListener('click', () => {
      for (const file of this.filtered().slice(0, this.limit)) if (isVideoFile(file) && !this.isSubmitted(file.url)) this.chosen.set(file.url, file);
      this.renderGrid(); this.save();
    });
    el['browser-clear'].addEventListener('click', () => { this.chosen.clear(); this.renderGrid(); this.save(); });
    el['browser-import'].addEventListener('click', () => this.importFiles([...this.chosen.values()].map(file => this.enriched(file))));
    el['browser-meta'].addEventListener('click', () => this.enrich());
    el['radar-player-close'].addEventListener('click', () => el['radar-player'].close());
    el['radar-player'].addEventListener('close', () => this.stopPlayer());
    el['radar-player'].addEventListener('click', event => { if (event.target === el['radar-player']) { const rect = el['radar-player'].getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) el['radar-player'].close(); } });
    el['radar-player-prev'].addEventListener('click', () => this.stepPlayer(-1)); el['radar-player-next'].addEventListener('click', () => this.stepPlayer(1));
    el['radar-player-retry'].addEventListener('click', () => { if (this.active) this.loadPlayer(this.active.url); });
    el['radar-player-select'].addEventListener('click', () => { if (this.active) this.toggle(this.active.url, !this.chosen.has(this.active.url)); });
    el['radar-player-import'].addEventListener('click', () => { if (this.active) this.importFiles([this.enriched(this.active)]); });
    el['radar-player'].addEventListener('keydown', event => { if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); this.stepPlayer(event.key === 'ArrowLeft' ? -1 : 1); } });
    window.addEventListener('pagehide', () => { clearTimeout(this.pollTimer); this.stopPlayer(); });
  }
  enriched(file) { return { ...file, ...this.meta.get(file.url), url: file.url, title: file.title, albums: file.albums }; }
  find(url) { const file = this.files.find(item => item.url === url) || this.queue.find(item => item.url === url) || this.chosen.get(url); return file ? this.enriched(file) : null; }
  isSubmitted(url) { return SUBMITTED.has(this.submitted.get(url)); }
  filtered() {
    const query = this.el['browser-find'].value.trim().toLocaleLowerCase(); const minQuality = Number(this.el['browser-quality'].value);
    return this.files.map(file => this.enriched(file)).filter(file => (!query || `${file.title} ${(file.albums || []).map(album => album.title).join(' ')}`.toLocaleLowerCase().includes(query)) && (!minQuality || fileQuality(file).height >= minQuality));
  }
  render(files, limit) { this.files = files; this.limit = limit; this.renderGrid(); }
  card(file) {
    const e = escapeMarkup; const quality = fileQuality(file); const thumbnail = safeMediaUrl(file.thumbnail); const selected = this.chosen.has(file.url);
    const uploaded = new Date(file.uploaded_at || file.upload_date || ''); const date = Number.isFinite(uploaded.getTime()) ? new Intl.DateTimeFormat('sk-SK').format(uploaded) : 'Dátum ?';
    const state = this.submitted.get(file.url); const labels = { queued: 'Vo fronte importu', pending: 'Vo fronte importu', running: 'Importujem…', imported: 'V knižnici', duplicate: 'Už v knižnici', failed: 'Import zlyhal – môžeš skúsiť znovu', cancelled: 'Import zrušený' };
    return `<article class="target-card ${selected ? 'is-file-selected' : ''}" data-file-url="${e(file.url)}">
      <div class="browser-visual"><div class="browser-placeholder"><b aria-hidden="true">▦</b><span>${thumbnail ? 'Náhľad sa nepodarilo načítať' : 'Náhľad zatiaľ nie je dostupný'}</span></div>${thumbnail ? `<img class="browser-thumb" src="${e(thumbnail)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}
        <span class="browser-corner browser-date" title="Dátum uploadu">${e(date)}</span><span class="browser-corner browser-quality ${quality.height ? '' : 'browser-unknown'}" title="${quality.inferred ? 'Odhad podľa názvu súboru; potvrď cez Doplniť meta' : quality.height ? 'Rozlíšenie z metadata' : 'Rozlíšenie ešte nie je zistené'}">${e(quality.label)}${quality.inferred ? '*' : ''}</span>
        <label class="browser-file-check"><input class="browser-check" type="checkbox" aria-label="Vybrať video ${e(file.title)}" ${selected ? 'checked' : ''} ${!isVideoFile(file) || this.isSubmitted(file.url) || this.importing ? 'disabled' : ''}></label>
        <button class="browser-play" type="button" aria-label="Prehrať ${e(file.title)}" ${isVideoFile(file) ? '' : 'disabled'}>${isVideoFile(file) ? '▶' : '▤'}</button>
        <span class="browser-corner browser-duration ${file.duration ? '' : 'browser-unknown'}" title="Dĺžka videa">◷ ${e(formatDuration(file.duration))}</span><span class="browser-corner browser-size ${file.size_bytes ? file.size_bytes < 1024 ** 3 ? 'is-small' : '' : 'browser-unknown'}">${e(file.size_bytes ? this.bytes(file.size_bytes) : 'Veľkosť ?')}</span>
      </div><div class="browser-card-info"><h3 class="browser-card-title" title="${e(file.title)}">${e(file.title)}</h3><div class="target-origins">${(file.albums || []).map(album => `<a href="${e(album.url)}" target="_blank" rel="noopener" title="Zdrojový album: ${e(album.title)}">${e(album.title)}</a>`).join('')}</div>
      <div class="browser-card-actions"><a class="source-launch" href="${e(file.url)}" target="_blank" rel="noopener">Otvoriť zdroj</a><button class="browser-card-import" type="button" ${this.importing || this.isSubmitted(file.url) || !isVideoFile(file) ? 'disabled' : ''}>${this.isSubmitted(file.url) ? 'Odoslané ✓' : 'Importovať'}</button></div>${state ? `<p class="browser-card-state ${state === 'failed' ? 'error' : ''}">${labels[state] || e(state)}</p>` : ''}</div></article>`;
  }
  renderGrid() {
    const el = this.el; const files = this.filtered(); const shown = files.slice(0, this.limit);
    el['target-grid'].dataset.density = el['browser-density'].value; el['target-grid'].dataset.shape = el['browser-shape'].value;
    el['target-grid'].innerHTML = shown.map(file => this.card(file)).join('');
    el['browser-count'].textContent = `${shown.length}/${files.length} kariet${files.length !== this.files.length ? ` · ${this.files.length} celkovo` : ''}`;
    el['browser-select-visible'].disabled = this.importing || !shown.some(file => isVideoFile(file) && !this.isSubmitted(file.url));
    el['browser-meta'].disabled = this.enriching || !this.files.length; el['browser-meta'].textContent = this.enriching ? 'Dopĺňam meta…' : `Doplniť meta${this.chosen.size ? ' vybraných' : ' náhľadov'}`;
    this.renderSelection();
    const more = document.getElementById('target-more'); more.hidden = files.length <= this.limit; more.textContent = `Zobraziť ďalšie (${Math.max(0, files.length - this.limit)})`;
    this.renderPlayerActions();
  }
  renderSelection() {
    const el = this.el; const files = this.filtered();
    el['browser-clear'].disabled = this.importing || !this.chosen.size;
    el['browser-meta'].textContent = this.enriching ? 'Dopĺňam meta…' : `Doplniť meta${this.chosen.size ? ' vybraných' : ' náhľadov'}`;
    const selected = [...this.chosen.values()].map(file => this.enriched(file)); const visibleUrls = new Set(files.map(file => file.url)); const hidden = selected.filter(file => !visibleUrls.has(file.url)).length;
    el['browser-selected-count'].textContent = `${selected.length} videí vybraných${hidden ? ` (${hidden} mimo gridu)` : ''}`;
    el['browser-selected-size'].textContent = selected.length ? `${this.bytes(selected.reduce((sum, file) => sum + Number(file.size_bytes || 0), 0))} známej veľkosti · importuje iba vybrané súbory, nie celé albumy` : 'Vyber checkboxom na karte. Play otvorí prehrávač.';
    el['browser-import'].disabled = this.importing || !selected.length; el['browser-import'].textContent = this.importing ? 'Odosielam…' : `Importovať vybrané (${selected.length})`;
    this.renderPlayerActions();
  }
  toggle(url, selected) {
    if (this.importing || this.isSubmitted(url)) return;
    const file = this.find(url); if (!file || !isVideoFile(file)) return;
    selected ? this.chosen.set(url, file) : this.chosen.delete(url);
    // Keep focus and the card under the pointer stable while selecting.
    const card = [...this.el['target-grid'].querySelectorAll('[data-file-url]')].find(node => node.dataset.fileUrl === url);
    if (card) { card.classList.toggle('is-file-selected', selected); card.querySelector('.browser-check').checked = selected; }
    this.renderSelection(); this.save();
  }
  async api(path, body, signal) {
    const response = await fetch(path, body === undefined ? { signal } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `HTTP ${response.status}`);
    return data;
  }
  rememberMetadata(url, raw) {
    const meta = { ...this.meta.get(url) };
    for (const field of ['duration', 'width', 'height', 'size_bytes']) if (positiveNumber(raw[field])) meta[field] = positiveNumber(raw[field]);
    if (safeMediaUrl(raw.thumbnail)) meta.thumbnail = raw.thumbnail;
    if (raw.upload_date || raw.uploaded_at) meta.uploaded_at = raw.upload_date || raw.uploaded_at;
    if (Number(raw.height) > 0) meta.quality_inferred = false;
    this.meta.set(url, meta); this.onMetadata(url, meta); this.save();
  }
  async enrich() {
    if (this.enriching) return;
    const files = this.chosen.size ? [...this.chosen.values()] : this.filtered().slice(0, this.limit).filter(file => !this.meta.has(file.url)).slice(0, 12);
    const urls = files.filter(isVideoFile).map(file => file.url);
    if (!urls.length) { this.toast('Náhľady už majú metadata. Vyber videá pre opätovné načítanie.'); return; }
    this.enriching = true; this.renderGrid(); let ok = 0; let failed = 0;
    for (let offset = 0; offset < urls.length; offset += 6) {
      try {
        const batch = urls.slice(offset, offset + 6); const data = await this.api('/api/tester/batch-meta', { urls: batch });
        const returned = new Set();
        for (const item of data.results || []) if (batch.includes(item.url) && !returned.has(item.url)) { returned.add(item.url); if (item.ok) { this.rememberMetadata(item.url, item); ok += 1; } else failed += 1; }
        failed += batch.length - returned.size;
      } catch (_) { failed += Math.min(6, urls.length - offset); }
      this.renderGrid();
    }
    this.enriching = false; this.renderGrid(); this.toast(`Metadata: ${ok}/${urls.length} videí${failed ? ` · ${failed} sa nepodarilo načítať` : ''}.`, failed > 0);
  }
  async importFiles(rawFiles) {
    if (this.importing) return;
    const files = rawFiles.filter(file => file && isVideoFile(file) && !this.isSubmitted(file.url)); if (!files.length) return;
    this.importing = true; this.renderGrid();
    try {
      const payload = buildRadarImport(files.map(file => this.enriched(file)), this.keyword());
      const data = await this.api('/api/v1/intake/import', payload);
      if (!data.job?.id) throw new Error('Server nepotvrdil ID importu. Skontroluj Import Desk pred ďalším pokusom.');
      const urls = files.map(file => file.url); this.jobs.push({ id: data.job.id, urls }); this.jobs = this.jobs.slice(-6);
      for (const url of urls) { this.submitted.set(url, 'queued'); this.chosen.delete(url); }
      this.showJob(`Import #${data.job.id}: ${files.length} videí odoslaných do fronty. Metadata a duplicity spracuje Nexus.`);
      this.toast(`Odoslaných ${files.length} videí do importu #${data.job.id}.`); this.save(); this.pollJobs();
    } catch (error) { this.showJob(`Import sa nepodarilo potvrdiť: ${error.message} Skontroluj Import Desk pred opakovaním.`, true); this.toast(error.message, true); }
    finally { this.importing = false; this.renderGrid(); }
  }
  showJob(message, error = false) {
    const node = this.el['browser-job']; node.hidden = false; node.classList.toggle('error', error);
    node.innerHTML = `${escapeMarkup(message)} <a href="/" target="_blank" rel="noopener">Otvoriť Knižnicu</a>`;
  }
  async pollJobs() {
    clearTimeout(this.pollTimer); if (this.polling || !this.jobs.length) return;
    this.polling = true; let changed = false;
    try {
      for (const record of this.jobs.filter(job => !job.done)) {
        try {
          const data = await this.api(`/api/v1/intake/jobs/${encodeURIComponent(record.id)}`); const job = data.job; if (!job) continue;
          for (const item of job.items || []) { const url = item.source_url || item.url; if (record.urls.includes(url)) { changed ||= this.submitted.get(url) !== item.status; this.submitted.set(url, item.status); } }
          record.done = TERMINAL_JOBS.has(job.status);
          this.showJob(`Import #${record.id}: ${job.imported_items || 0} importovaných · ${job.duplicate_items || 0} duplicít · ${job.failed_items || 0} chýb${record.done ? ' · dokončený' : ' · prebieha'}.`, Boolean(record.done && job.failed_items));
        } catch (error) { this.showJob(`Stav importu #${record.id} sa nepodarilo načítať: ${error.message}. Sleduj ho v Import Desk.`, true); }
      }
      this.save(); if (changed) this.renderGrid();
    } finally { this.polling = false; if (this.jobs.some(job => !job.done)) this.pollTimer = setTimeout(() => this.pollJobs(), 5000); }
  }
  openPlayer(url) {
    this.queue = this.filtered().filter(isVideoFile); this.playerTrigger = document.activeElement;
    if (!this.el['radar-player'].open) this.el['radar-player'].showModal();
    this.loadPlayer(url);
  }
  stepPlayer(direction) {
    if (!this.active) return; const index = this.queue.findIndex(file => file.url === this.active.url);
    const file = this.queue[index + direction]; if (file) this.loadPlayer(file.url);
  }
  renderPlayerActions() {
    if (!this.active) return; const el = this.el; const index = this.queue.findIndex(file => file.url === this.active.url);
    el['radar-player-position'].textContent = `${index + 1} / ${this.queue.length}`;
    el['radar-player-prev'].disabled = index <= 0; el['radar-player-next'].disabled = index >= this.queue.length - 1;
    el['radar-player-select'].textContent = this.chosen.has(this.active.url) ? 'Vybrané ✓' : 'Vybrať video';
    el['radar-player-select'].disabled = this.importing || this.isSubmitted(this.active.url);
    el['radar-player-import'].disabled = this.importing || this.isSubmitted(this.active.url);
    el['radar-player-import'].textContent = this.isSubmitted(this.active.url) ? 'Odoslané do importu ✓' : 'Importovať video';
  }
  async loadPlayer(url) {
    const file = this.find(url); if (!file) return;
    this.playerAbort?.abort(); this.playerAbort = new AbortController(); const sequence = ++this.playerSequence;
    const el = this.el; const video = el['radar-player-video'];
    video.pause(); video.onloadedmetadata = null; video.onerror = null; video.onended = null; video.removeAttribute('src'); video.load(); video.hidden = true;
    this.active = file; el['radar-player-title'].textContent = file.title; el['radar-player-meta'].textContent = `${(file.albums || []).map(album => album.title).join(' · ')} · ${file.size_bytes ? this.bytes(file.size_bytes) : 'veľkosť nezistená'}`;
    el['radar-player-source'].href = url; el['radar-player-status'].hidden = false; el['radar-player-status'].textContent = 'Pripravujem čerstvý stream z Filesteru…'; el['radar-player-retry'].hidden = true; this.renderPlayerActions();
    try {
      const data = await this.api('/api/tester/resolve', { urls: [url] }, this.playerAbort.signal);
      if (sequence !== this.playerSequence || !el['radar-player'].open) return;
      const result = data.results?.find(item => item.url === url) || data.results?.[0]; const resolved = result?.data || {};
      const src = safeMediaUrl(resolved.stream_url);
      if (!src || src.startsWith('data:') || resolved.kind === 'album' || resolved.kind === 'page') throw new Error(result?.message || 'Filester neposkytol prehrateľný stream. Skús Obnoviť stream alebo otvor zdroj.');
      if ((resolved.is_hls || /\.m3u8(?:\?|$)/i.test(src)) && !video.canPlayType('application/vnd.apple.mpegurl')) throw new Error('Tento stream je HLS a prehliadač ho natívne nepodporuje. Otvor zdroj videa.');
      this.rememberMetadata(url, resolved); this.renderGrid();
      video.onerror = () => { if (sequence !== this.playerSequence) return; el['radar-player-status'].hidden = false; el['radar-player-status'].textContent = 'Stream sa nedá prehrať alebo jeho platnosť vypršala. Obnov stream; ak problém pokračuje, otvor zdroj.'; el['radar-player-retry'].hidden = false; };
      video.onloadedmetadata = () => {
        if (sequence !== this.playerSequence) return;
        this.rememberMetadata(url, { duration: video.duration, width: video.videoWidth, height: video.videoHeight }); this.renderGrid();
        el['radar-player-meta'].textContent = `${(file.albums || []).map(album => album.title).join(' · ')} · ${formatDuration(video.duration)} · ${video.videoWidth} × ${video.videoHeight}`;
      };
      video.onended = () => { if (sequence === this.playerSequence) { el['radar-player-status'].hidden = false; el['radar-player-status'].textContent = 'Video sa skončilo. Prehraj ho znovu alebo prejdi na ďalšie.'; } };
      video.muted = true; video.poster = safeMediaUrl(resolved.thumbnail || file.thumbnail); video.src = src; video.hidden = false; el['radar-player-status'].hidden = true;
      await video.play().catch(() => { if (sequence === this.playerSequence) { el['radar-player-status'].hidden = false; el['radar-player-status'].textContent = 'Stream je pripravený. Stlač Play v ovládaní prehrávača.'; } });
    } catch (error) {
      if (error.name === 'AbortError' || sequence !== this.playerSequence) return;
      el['radar-player-status'].hidden = false; el['radar-player-status'].textContent = error.message; el['radar-player-retry'].hidden = false;
    }
  }
  stopPlayer() {
    this.playerSequence += 1; this.playerAbort?.abort(); const video = this.el['radar-player-video'];
    video.pause(); video.onloadedmetadata = null; video.onerror = null; video.onended = null; video.removeAttribute('src'); video.load();
    this.active = null; this.playerTrigger?.isConnected && this.playerTrigger.focus({ preventScroll: true });
  }
}
