/** Attaches an isolated WebGPU preview to an existing HTMLVideoElement. */
export class VideoEnhancer {
  constructor(video, mount) {
    this.video = video; this.mount = mount; this.quality = 'm'; this.content = 'rl';
    this.effects = { sharpen: true, color: true }; this.active = false; this.pending = false; this.compare = false;
    this.buildUI(); this.supportPromise = this.checkSupport();
    this.onLoaded = () => { if (this.active) this.schedule(); };
    video.addEventListener('loadeddata', this.onLoaded);
  }
  buildUI() {
    this.panel = document.createElement('div'); this.panel.className = 'nexus-enhancer-panel';
    this.panel.hidden = true;
    this.panel.innerHTML = `<button type="button" data-action="toggle">Enhance</button><button type="button" data-action="compare" hidden>Compare 50/50</button><button type="button" data-action="play">Play</button><button type="button" data-action="mute">Mute</button><button type="button" data-action="fullscreen">Fullscreen</button><input data-role="seek" type="range" min="0" max="1000" value="0" aria-label="Seek video"><span data-role="time">0:00 / 0:00</span><span data-role="support">Checking WebGPU…</span>
      <label>Quality <select data-role="quality"><option value="s">Small</option><option value="m" selected>Medium</option><option value="l">Large</option></select></label>
      <label>Content <select data-role="content"><option value="rl">Real life</option><option value="an">Animation</option><option value="3d">3D</option></select></label>
      <label><input type="checkbox" data-role="sharpen" checked> Sharpen</label><label><input type="checkbox" data-role="color" checked> Color</label>
      <button type="button" data-action="process">Process & Download</button><button type="button" data-action="cancel" hidden>Cancel</button>
      <progress data-role="progress" max="100" value="0" hidden></progress><span data-role="status" aria-live="polite"></span>
      <a data-role="download" hidden download="nexus-enhanced-2x.mp4">Download MP4</a><button type="button" data-action="replace" hidden>Replace in player</button>`;
    this.mount.append(this.panel);
    this.canvas = document.createElement('canvas'); this.canvas.className = 'nexus-enhancer-canvas'; this.canvas.hidden = true;
    this.video.after(this.canvas);
    this.panel.querySelector('[data-action="toggle"]').onclick = () => this.active ? this.disable() : this.enable();
    this.panel.querySelector('[data-action="compare"]').onclick = () => this.setCompare(!this.compare);
    this.panel.querySelector('[data-action="play"]').onclick = () => this.video.paused ? this.video.play() : this.video.pause();
    this.panel.querySelector('[data-action="mute"]').onclick = () => { this.video.muted = !this.video.muted; this.syncPlayback(); };
    this.panel.querySelector('[data-action="fullscreen"]').onclick = async () => {
      try { if (document.fullscreenElement === this.mount) await document.exitFullscreen(); else await this.mount.requestFullscreen(); }
      catch (error) { this.status(`Fullscreen unavailable: ${error.message}`); }
    };
    this.role('seek').oninput = () => { if (Number.isFinite(this.video.duration) && this.video.duration > 0) this.video.currentTime = this.video.duration * Number(this.role('seek').value) / 1000; };
    this.onPlayback = () => this.syncPlayback();
    this.onFullscreen = () => { this.panel.querySelector('[data-action="fullscreen"]').textContent = document.fullscreenElement === this.mount ? 'Exit fullscreen' : 'Fullscreen'; };
    for (const event of ['timeupdate','durationchange','play','pause','volumechange']) this.video.addEventListener(event, this.onPlayback);
    document.addEventListener('fullscreenchange', this.onFullscreen);
    this.syncPlayback();
    this.panel.querySelector('[data-action="process"]').onclick = () => this.process();
    this.panel.querySelector('[data-action="cancel"]').onclick = () => this.cancel();
    this.panel.querySelector('[data-action="replace"]').onclick = () => { if (!this.downloadUrl) return; this.disable(); delete this.video.__nexusSourceFile; this.video.src = this.downloadUrl; this.video.load(); this.status('Enhanced MP4 loaded in player.'); };
    for (const key of ['quality','content','sharpen','color']) this.panel.querySelector(`[data-role="${key}"]`).onchange = () => this.updateSettings();
  }
  attachControl() {
    const actions = this.mount.querySelector('.player-header .p-actions');
    if (!actions || this.control?.isConnected) return;
    this.control = document.createElement('button');
    this.control.type = 'button';
    this.control.title = 'Video Enhance';
    this.control.setAttribute('aria-label', 'Video Enhance');
    this.control.setAttribute('aria-expanded', String(!this.panel.hidden));
    this.control.innerHTML = '<span class="material-icons-round">high_quality</span>';
    this.control.onclick = event => {
      event.stopPropagation();
      this.panel.hidden = !this.panel.hidden;
      this.control.setAttribute('aria-expanded', String(!this.panel.hidden));
      this.control.classList.toggle('active', !this.panel.hidden);
    };
    actions.insertBefore(this.control, actions.lastElementChild);
  }
  role(name) { return this.panel.querySelector(`[data-role="${name}"]`); }
  status(message) { this.role('status').textContent = message; }
  syncPlayback() {
    const seconds = value => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
    const duration = Number.isFinite(this.video.duration) ? this.video.duration : 0;
    this.panel.querySelector('[data-action="play"]').textContent = this.video.paused ? 'Play' : 'Pause';
    this.panel.querySelector('[data-action="mute"]').textContent = this.video.muted ? 'Unmute' : 'Mute';
    this.role('time').textContent = `${seconds(this.video.currentTime || 0)} / ${seconds(duration)}`;
    this.role('seek').value = duration > 0 ? String(Math.round(this.video.currentTime / duration * 1000)) : '0';
  }
  setCompare(enabled) {
    this.compare = enabled && this.active && this.ready;
    this.mount.classList.toggle('nexus-enhancer-compare', this.compare);
    this.panel.querySelector('[data-action="compare"]').textContent = this.compare ? 'Enhanced only' : 'Compare 50/50';
    this.status(this.compare ? 'Left: original · Right: AI 2×' : 'AI 2× preview');
  }
  async checkSupport() {
    try { this.supported = !!(navigator.gpu && await navigator.gpu.requestAdapter()); }
    catch { this.supported = false; }
    this.role('support').textContent = this.supported ? 'WebGPU available' : 'WebGPU unavailable · basic filters only';
  }
  updateSettings() {
    const previousQuality = this.quality, previousContent = this.content;
    this.quality = this.role('quality').value; this.content = this.role('content').value;
    this.effects = { sharpen: this.role('sharpen').checked, color: this.role('color').checked };
    this.canvas.style.filter = `${this.effects.color ? 'contrast(1.08) saturate(1.12)' : ''} ${this.effects.sharpen ? 'url(#nexus-enhancer-sharpen)' : ''}`.trim() || 'none';
    // Preview effects are CSS/SVG filters. Only a model change needs GPU reinitialization.
    if (this.active && this.worker && (previousQuality !== this.quality || previousContent !== this.content)) this.worker.postMessage({ type: 'settings', quality: this.quality, content: this.content });
    if (this.active && this.basicFallback) this.video.style.filter = this.canvas.style.filter;
  }
  async prepareOnlineSource(source) {
    // A normally playable CDN video may still be tainted for canvas capture.
    // Check CORS before reloading, so unsupported hosts retain normal playback.
    this.status('Checking online source access for AI…');
    const controller = new AbortController(); this.corsProbe = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(source, { mode: 'cors', credentials: 'omit', headers: { Range: 'bytes=0-0' }, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await response.body?.cancel();
    } catch {
      throw new Error('Online source does not permit AI frame capture (CORS or access denied). Basic filters only. Use a compatible Nexus stream proxy for this source.');
    } finally { clearTimeout(timeout); this.corsProbe = null; }
    if (!this.active || this.video.currentSrc !== source) return false;
    const { currentTime, paused, playbackRate, muted } = this.video;
    const previousCors = this.video.getAttribute('crossorigin');
    const reload = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Online video reload timed out.')), 12000);
      const loaded = () => finish();
      const failed = () => finish(new Error('Online video cannot be loaded with CORS.'));
      const finish = error => { clearTimeout(timer); this.video.removeEventListener('loadeddata', loaded); this.video.removeEventListener('error', failed); error ? reject(error) : resolve(); };
      this.video.addEventListener('loadeddata', loaded); this.video.addEventListener('error', failed);
      this.video.load();
    });
    const restorePlayback = async () => {
      this.video.currentTime = Number.isFinite(this.video.duration) ? Math.min(currentTime, this.video.duration) : currentTime;
      this.video.playbackRate = playbackRate; this.video.muted = muted;
      if (!paused) await this.video.play().catch(() => {});
    };
    try {
      this.video.crossOrigin = 'anonymous';
      await reload();
      if (this.video.currentSrc !== source) return false;
      await restorePlayback();
      return this.active;
    } catch (error) {
      if (this.video.src === source) {
        if (previousCors === null) this.video.removeAttribute('crossorigin'); else this.video.setAttribute('crossorigin', previousCors);
        await reload().then(restorePlayback).catch(() => {});
      }
      throw error;
    }
  }
  async enable() {
    await this.supportPromise;
    if (!this.video.videoWidth) { this.status('Load a video first.'); return; }
    if (this.canvas.__transferred) { const fresh = document.createElement('canvas'); fresh.className = this.canvas.className; fresh.hidden = true; this.canvas.replaceWith(fresh); this.canvas = fresh; }
    this.active = true; this.basicFallback = false; this.updateSettings();
    this.panel.querySelector('[data-action="toggle"]').textContent = 'Original';
    const source = this.video.currentSrc;
    if (!this.supported || !this.video.requestVideoFrameCallback || !this.canvas.transferControlToOffscreen) {
      this.fallback('Basic filters active. AI upscale needs Chrome with WebGPU.'); return;
    }
    if (source && !source.startsWith('blob:') && new URL(source, location.href).origin !== location.origin && !this.video.crossOrigin) {
      try { if (!await this.prepareOnlineSource(source)) return; }
      catch (error) { if (this.active) this.fallback(error.message); return; }
    }
    this.video.style.filter = ''; this.renderedFrames = 0;
    this.frames = 0; this.fps = 0; this.fpsStart = 0;
    this.worker = new Worker('/static/video-enhancer/enhancer.worker.bundle.js?v=20261011_online', { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'ready') { this.ready = true; this.panel.querySelector('[data-action="compare"]').hidden = false; this.schedule(); if (this.mount.dataset.autoCompare === 'true') this.setCompare(true); }
      if (data.type === 'rendered') {
        this.pending = false;
        this.canvas.dataset.renderedFrames = String(++this.renderedFrames);
        this.canvas.dataset.mediaTime = String(data.timestamp);
        const now = performance.now(); this.frames = (this.frames || 0) + 1;
        if (!this.fpsStart) this.fpsStart = now;
        if (now - this.fpsStart >= 1000) { this.fps = Math.round(this.frames * 1000 / (now - this.fpsStart)); this.frames = 0; this.fpsStart = now; }
        this.status(`${this.compare ? 'Left: original · Right: AI 2×' : 'AI 2×'} · ${data.width}×${data.height}${this.fps ? ` · ${this.fps} FPS` : ''}`);
      }
      if (data.type === 'error') { this.disable(); this.status(data.message); }
    };
    this.worker.onerror = (event) => { this.disable(); this.status(event.message || 'Worker failed'); };
    const offscreen = this.canvas.transferControlToOffscreen();
    this.canvas.__transferred = true;
    this.worker.postMessage({ type: 'init', canvas: offscreen, quality: this.quality, content: this.content }, [offscreen]);
  }
  schedule() {
    if (!this.active || !this.ready || this.callback) return;
    this.callback = this.video.requestVideoFrameCallback(async (_now, meta) => {
      this.callback = null;
      if (!this.active) return;
      if (!this.pending && this.video.readyState >= 2) {
        try { const frame = await createImageBitmap(this.video); if (this.active && this.worker) { this.pending = true; this.worker.postMessage({ type: 'frame', frame, timestamp: meta.mediaTime }, [frame]); } else frame.close(); }
        catch (error) {
          const cors = /origin.clean|cross.origin|taint/i.test(error.message);
          this.fallback(cors ? 'AI preview blocked by source CORS. Basic filters are active; use a local or CORS-enabled MP4.' : `AI frame capture unavailable: ${error.message}. Basic filters are active.`);
          return;
        }
      }
      this.schedule();
    });
    this.canvas.hidden = false;
    this.video.classList.add('nexus-enhancer-source');
  }
  disable() {
    this.corsProbe?.abort(); this.basicFallback = false;
    this.active = false; this.ready = false; this.pending = false;
    this.setCompare(false); this.panel.querySelector('[data-action="compare"]').hidden = true;
    if (this.callback) this.video.cancelVideoFrameCallback(this.callback);
    this.callback = null; if (this.worker) this.worker.terminate(); this.worker = null;
    this.canvas.hidden = true; this.video.classList.remove('nexus-enhancer-source'); this.video.style.filter = '';
    this.panel.querySelector('[data-action="toggle"]').textContent = 'Enhance';
    this.status('Original video');
  }
  fallback(message) {
    this.basicFallback = true;
    this.setCompare(false); this.panel.querySelector('[data-action="compare"]').hidden = true;
    if (this.callback) this.video.cancelVideoFrameCallback(this.callback);
    this.callback = null; this.pending = false; this.ready = false;
    this.worker?.terminate(); this.worker = null;
    this.canvas.hidden = true; this.video.classList.remove('nexus-enhancer-source');
    this.video.style.filter = this.canvas.style.filter;
    this.status(message);
  }
  async process() {
    if (!this.supported) { this.status('WebGPU is required for 2× export.'); return; }
    if (this.exportWorker) return;
    const duration = this.video.duration;
    const outputPixels = this.video.videoWidth * this.video.videoHeight * 4;
    const pixelLimit = this.quality === 'l' ? 1_500_000 : 4_000_000;
    if (!Number.isFinite(duration) || duration <= 0 || !outputPixels) { this.status('Load a finite MP4 first.'); return; }
    if (duration > 30) { this.status('Export is limited to 30-second clips. This exporter keeps the whole MP4 in memory; trim the source first.'); return; }
    if (outputPixels > pixelLimit) { this.status(`Export stopped before GPU allocation: ${this.quality === 'l' ? 'Large' : 'this quality'} supports at most ${pixelLimit.toLocaleString()} output pixels. Choose a smaller clip or resolution.`); return; }
    let file;
    try {
      if (this.video.__nexusSourceFile) file = this.video.__nexusSourceFile;
      else { const response = await fetch(this.video.currentSrc, { mode: 'cors' }); if (!response.ok) throw new Error(`HTTP ${response.status}`); file = new File([await response.blob()], 'source.mp4', { type: 'video/mp4' }); }
    } catch {
      this.status('Source cannot be read locally. Select the same MP4 file to process.');
      file = await this.pickFile();
    }
    if (!file) return;
    if (file.size > 128 * 1024 * 1024) { this.status('Export is limited to MP4 files up to 128 MB because this exporter holds input and output in memory.'); return; }
    this.role('progress').hidden = false; this.role('progress').value = 0;
    this.panel.querySelector('[data-action="cancel"]').hidden = false;
    this.exportWorker = new Worker('/static/video-enhancer/export.worker.bundle.js?v=20261011_online', { type: 'module' });
    this.exportWorker.onmessage = ({ data }) => {
      if (data.type === 'progress') { this.role('progress').value = data.value; this.status(`Processing ${data.value}%`); }
      if (data.type === 'error') { this.status(data.message); this.finishExport(); }
      if (data.type === 'complete') {
        const url = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
        this.downloadUrl && URL.revokeObjectURL(this.downloadUrl); this.downloadUrl = url;
        this.role('download').href = url; this.role('download').hidden = false;
        this.panel.querySelector('[data-action="replace"]').hidden = false;
        const link = document.createElement('a'); link.href = url; link.download = 'nexus-enhanced-2x.mp4'; link.click();
        this.status(`Done · ${data.width}×${data.height} · ${data.hasAudio ? 'audio preserved' : 'no audio track'}. Download started.`);
        this.role('progress').value = 100;
        this.finishExport();
      }
    };
    this.exportWorker.onerror = event => { this.status(event.message || 'Export worker failed.'); this.finishExport(); };
    this.exportWorker.postMessage({ type: 'process', file, quality: this.quality, content: this.content, effects: this.effects });
    this.status('Processing locally…');
  }
  pickFile() { return new Promise(resolve => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'video/mp4';
    input.onchange = () => resolve(input.files[0]); input.oncancel = () => resolve(null); input.click();
  }); }
  finishExport() { this.exportWorker?.terminate(); this.exportWorker = null; this.panel.querySelector('[data-action="cancel"]').hidden = true; }
  cancel() { if (this.exportWorker) { this.exportWorker.terminate(); this.finishExport(); this.status('Cancelled.'); } }
  destroy() { this.cancel(); this.disable(); if (this.downloadUrl) URL.revokeObjectURL(this.downloadUrl); this.video.removeEventListener('loadeddata', this.onLoaded); for (const event of ['timeupdate','durationchange','play','pause','volumechange']) this.video.removeEventListener(event, this.onPlayback); document.removeEventListener('fullscreenchange', this.onFullscreen); this.canvas.remove(); this.panel.remove(); this.control?.remove(); delete this.video.__nexusEnhancer; }
}

export function attachVideoEnhancer(video, mount = video.closest('.player-box') || video.parentElement) {
  if (!video || video.__nexusEnhancer) return video?.__nexusEnhancer;
  video.__nexusEnhancer = new VideoEnhancer(video, mount);
  return video.__nexusEnhancer;
}
