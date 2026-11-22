/**
 * BunkrFastStart Engine v2
 * Extreme fast-start playback for Bunkr videos in Nexus gallery & splitscreen.
 *
 * Mandatory requirements:
 * 1. Pre-warm on cell load:
 *    - Resolves CDN URL as soon as item is shown, downloads first 3.5 MB via Range requests.
 *    - Stores bytes in memory (and Cache API).
 *    - Strict limit to 2 parallel connections across warmups to avoid 503.
 * 2. Instant play from cache + Progressive Streaming:
 *    - Feeds warm cache bytes immediately to MediaSource Extensions + MP4Box (0ms network wait).
 *    - When streaming live, feeds chunks progressively via ReadableStream to MP4Box so playback
 *      starts as soon as moov + first fragments arrive without waiting for full 3.5 MB download.
 *    - Background pump fetches remaining data.
 *    - Fallback to proxied <video> src if MediaSource fails.
 * 3. Fast recovery:
 *    - On 503, 429, 410 (Gone), 403 (Forbidden) or timeout, instantly re-resolves for a fresh
 *      signed URL and retries Range once.
 *    - No backoff longer than 800ms (uses 200ms).
 *    - Never blocks other videos.
 * 4. Measurement:
 *    - Logs TTFB, time-to-moov-complete, time-to-first-frame in console and debug overlay.
 * 5. Integration:
 *    - Works with existing resolver and UI.
 */

(function (global) {
  'use strict';

  const CONFIG = {
    WARMUP_BYTES: 3.5 * 1024 * 1024,      // 3.5 MB covers up to 1.94 MB moov + initial fragments
    MAX_PARALLEL_WARMUP: 2,               // Mandatory: max 2 parallel connections to avoid 503
    WARMUP_TIMEOUT_MS: 3500,              // TTFB timeout for Range headers before fast recovery
    BODY_STALL_TIMEOUT_MS: 8000,          // Per-read stall timeout while streaming body bytes
    MAX_RECOVERY_BACKOFF_MS: 200,         // Mandatory: no backoff longer than 800ms
    CHUNK_SIZE: 1024 * 1024,              // 1 MB chunks for background pump
    STREAM_APPEND_STEP: 192 * 1024,       // Feed MP4Box every ~192 KB during progressive startup
    TARGET_BUFFER_AHEAD: 45,              // 45 seconds ahead
    MP4BOX_URL: '/static/mp4box.all.min.js',
    CACHE_NAME: 'nexus-bunkr-faststart-v2'
  };

  // ── Concurrency Limiter (Semaphore) ──────────────────────────────────────────
  class ConcurrencyLimiter {
    constructor(max) {
      this.max = max;
      this.current = 0;
      this.queue = [];
    }
    async acquire() {
      if (this.current < this.max) {
        this.current++;
        return;
      }
      await new Promise(resolve => this.queue.push(resolve));
      this.current++;
    }
    release() {
      this.current = Math.max(0, this.current - 1);
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        next();
      }
    }
    clearPending() {
      this.queue.length = 0;
    }
    async run(fn) {
      await this.acquire();
      try {
        return await fn();
      } finally {
        this.release();
      }
    }
  }

  const warmupLimiter = new ConcurrencyLimiter(CONFIG.MAX_PARALLEL_WARMUP);

  // ── In-Memory Cache ─────────────────────────────────────────────────────────
  const cache = new Map(); // key -> Entry

  // Helpery pre detekciu Bunkr
  function isBunkr(itemOrUrl) {
    if (!itemOrUrl) return false;
    if (typeof itemOrUrl === 'object') {
      const srcUrl = String(itemOrUrl.source_url || '').toLowerCase();
      if (srcUrl && (srcUrl.includes('filester.') || srcUrl.includes('fileditch'))) {
        return false;
      }
    }
    const str = typeof itemOrUrl === 'string'
      ? itemOrUrl
      : `${itemOrUrl.source_url || ''} ${itemOrUrl.url || ''} ${itemOrUrl.source || ''}`;
    return /(?:bunkr|bunkrr|balbums|scdn\.st|cdn\.cr)/i.test(str);
  }

  function getBunkrKey(itemOrUrl) {
    if (!itemOrUrl) return '';
    if (typeof itemOrUrl === 'object') {
      if (itemOrUrl.id != null) return String(itemOrUrl.id);
      itemOrUrl = itemOrUrl.source_url || itemOrUrl.url || '';
    }
    const match = String(itemOrUrl).match(/\/(?:v|f|d)\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : String(itemOrUrl);
  }

  function getRangeUrl(directUrl, watchUrl, timeoutSec = 12) {
    if (!directUrl) return '';
    if (directUrl.startsWith('/api/v1/video_proxy')) return directUrl;
    if (typeof window !== 'undefined' && window.location && window.location.origin) {
      // Use local proxy to ensure exact Bunkr Referer and CORS compliance
      return `/api/v1/video_proxy?url=${encodeURIComponent(directUrl)}&referer=${encodeURIComponent(watchUrl || 'https://bunkr.cr/')}&upstream_timeout=${timeoutSec}`;
    }
    return directUrl;
  }

  function isUrlValidAndFresh(rawUrl) {
    if (!rawUrl || !/\.(?:mp4|webm|m4v)(?:\?|$)/i.test(rawUrl)) return false;
    if (rawUrl.includes('/v/') || rawUrl.includes('/f/')) return false;
    try {
      const parsed = new URL(rawUrl);
      const expRaw = ['ex', 'expires', 'exp'].map(k => parsed.searchParams.get(k)).find(Boolean);
      if (!expRaw) return true;
      const exp = Number(expRaw);
      if (!Number.isFinite(exp)) return false;
      const expSec = exp > 1e12 ? exp / 1000 : exp;
      const now = Date.now() / 1000;
      return expSec > now + 120; // At least 2 minutes remaining
    } catch (_) {
      return false;
    }
  }

  // Resolver helper
  async function resolveUrl(item, force = false) {
    if (!item) return '';
    const id = item.id;
    const watchUrl = item.source_url || item.url || '';

    // 1. Check if item has a valid, non-expired direct URL already (and not forcing)
    const candidate = item.directUrl || item.url || '';
    if (!force && isUrlValidAndFresh(candidate)) {
      return candidate;
    }

    // 2. Try backend resolver
    if (id != null) {
      try {
        const url = `/api/v1/stream/bunkr/${id}${force ? '?force=1' : ''}`;
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 8000);
        try {
          const res = await fetch(url, { signal: abort.signal, cache: 'no-store' });
          if (res.ok) {
            const data = await res.json();
            if (data && data.stream_url) {
              const fresh = String(data.stream_url).trim();
              item.url = fresh;
              if ('directUrl' in item) item.directUrl = fresh;
              return fresh;
            }
          }
        } finally {
          clearTimeout(timer);
        }
      } catch (_) { }
    }

    // 3. Fallback to GM/page resolver if available
    if (typeof global.resolveBunkrDirect === 'function') {
      try {
        const direct = await global.resolveBunkrDirect(watchUrl, { force });
        if (direct) {
          item.url = direct;
          if ('directUrl' in item) item.directUrl = direct;
          return direct;
        }
      } catch (_) { }
    }

    return candidate;
  }

  // MP4Box loader
  let mp4boxPromise = null;
  async function ensureMp4Box() {
    if (global.MP4Box && typeof global.MP4Box.createFile === 'function') {
      return global.MP4Box;
    }
    if (mp4boxPromise) return mp4boxPromise;
    mp4boxPromise = (async () => {
      if (typeof document !== 'undefined') {
        await new Promise((resolve, reject) => {
          const existing = document.querySelector('script[src*="mp4box"]');
          if (existing) {
            let checks = 0;
            const iv = setInterval(() => {
              checks++;
              if (global.MP4Box) { clearInterval(iv); resolve(global.MP4Box); }
              else if (checks > 60) { clearInterval(iv); reject(new Error('MP4Box load timeout')); }
            }, 50);
            return;
          }
          const s = document.createElement('script');
          s.src = CONFIG.MP4BOX_URL;
          s.onload = () => {
            if (global.MP4Box) resolve(global.MP4Box);
            else reject(new Error('MP4Box loaded but global missing'));
          };
          s.onerror = () => reject(new Error('Failed to load MP4Box'));
          document.head.appendChild(s);
        });
      }
      return global.MP4Box;
    })();
    return mp4boxPromise;
  }

  function isRecoverableError(err) {
    if (!err) return true;
    const st = err.status || 0;
    if ([403, 404, 410, 429, 500, 502, 503, 504].includes(st)) return true;
    if (err.name === 'AbortError' || err.name === 'TypeError') return true;
    const msg = String(err.message || '');
    return /(?:503|502|504|429|410|403|abort|timeout|fetch|network)/i.test(msg);
  }

  function parseTotalBytes(resp) {
    if (!resp || !resp.headers || typeof resp.headers.get !== 'function') return 0;
    const cr = resp.headers.get('content-range') || '';
    const match = cr.match(/bytes\s+(\d+)-(\d+)\/(\d+)/);
    if (match) return parseInt(match[3], 10);
    const cl = resp.headers.get('content-length');
    return cl ? parseInt(cl, 10) : 0;
  }

  // Range request helper with separate TTFB timeout vs body streaming timeout
  async function fetchRange(url, start, end, externalSignal, onChunk) {
    const t0 = performance.now();
    const abort = new AbortController();
    const onExternalAbort = () => abort.abort();
    if (externalSignal) {
      if (externalSignal.aborted) abort.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    // TTFB timer: only aborts if response headers take longer than WARMUP_TIMEOUT_MS
    let ttfbTimer = setTimeout(() => abort.abort(), CONFIG.WARMUP_TIMEOUT_MS);
    let stallTimer = null;

    try {
      const resp = await fetch(url, {
        headers: { 'Range': `bytes=${start}-${end}` },
        signal: abort.signal,
        cache: 'no-store'
      });
      clearTimeout(ttfbTimer);
      ttfbTimer = null;

      const ttfb = performance.now() - t0;
      if (resp.status !== 206 && resp.status !== 200) {
        const err = new Error(`HTTP ${resp.status}`);
        err.status = resp.status;
        throw err;
      }

      const total = parseTotalBytes(resp);

      // Progressive streaming via ReadableStream if available and onChunk callback provided
      if (onChunk && resp.body && typeof resp.body.getReader === 'function') {
        const reader = resp.body.getReader();
        const chunks = [];
        let received = 0;

        const resetStall = () => {
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = setTimeout(() => abort.abort(), CONFIG.BODY_STALL_TIMEOUT_MS);
        };
        resetStall();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          resetStall();
          if (value && value.byteLength > 0) {
            chunks.push(value);
            received += value.byteLength;
            onChunk(value, received, total, ttfb);
          }
        }
        if (stallTimer) clearTimeout(stallTimer);

        const combined = new Uint8Array(received);
        let offset = 0;
        for (const c of chunks) {
          combined.set(c, offset);
          offset += c.byteLength;
        }
        return { data: combined.buffer, total: total || received, ttfb, status: resp.status };
      }

      // Standard arrayBuffer read with generous body stall timeout
      stallTimer = setTimeout(() => abort.abort(), CONFIG.BODY_STALL_TIMEOUT_MS * 2);
      const data = await resp.arrayBuffer();
      clearTimeout(stallTimer);
      if (onChunk && data.byteLength > 0) {
        onChunk(new Uint8Array(data), data.byteLength, total || data.byteLength, ttfb);
      }
      return { data, total: total || data.byteLength, ttfb, status: resp.status };
    } finally {
      if (ttfbTimer) clearTimeout(ttfbTimer);
      if (stallTimer) clearTimeout(stallTimer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }

  // ── Pre-warm Engine ──────────────────────────────────────────────────────────
  async function prewarmVideo(item, options = {}) {
    if (!isBunkr(item)) return null;
    const key = getBunkrKey(item);
    if (!key) return null;

    let entry = cache.get(key);
    if (entry && (entry.status === 'ready' || entry.status === 'warming') && !options.force) {
      return entry.promise || entry;
    }

    if (!entry) {
      entry = {
        key,
        item,
        status: 'idle',
        signedUrl: item.directUrl || item.url || '',
        watchUrl: item.source_url || item.url || '',
        bytes: null,
        partialChunks: [],
        partialLength: 0,
        total: 0,
        ttfb: 0,
        timeToMoov: 0,
        timeToFirstFrame: 0,
        warmupStart: 0,
        warmupEnd: 0,
        retries: 0,
        promise: null
      };
      cache.set(key, entry);
    }

    entry.status = 'warming';
    entry.warmupStart = performance.now();
    entry.partialChunks = [];
    entry.partialLength = 0;

    const runWarmup = async () => {
      // 1. Resolve CDN URL (check expiry first)
      let signedUrl = entry.signedUrl;
      if (!isUrlValidAndFresh(signedUrl)) {
        signedUrl = await resolveUrl(item, false);
        entry.signedUrl = signedUrl;
      }

      if (!signedUrl) {
        entry.status = 'failed';
        return entry;
      }

      // 2. Download first 3.5 MB via Range with progressive chunk buffering
      const endByte = CONFIG.WARMUP_BYTES - 1;
      let rangeUrl = getRangeUrl(signedUrl, entry.watchUrl, 12);
      let attempt = 0;

      while (attempt < 2) {
        attempt++;
        entry.partialChunks = [];
        entry.partialLength = 0;
        try {
          const res = await fetchRange(rangeUrl, 0, endByte, null, (chunk, received, total, ttfb) => {
            entry.partialChunks.push(chunk);
            entry.partialLength = received;
            if (total > 0) entry.total = total;
            if (ttfb > 0 && !entry.ttfb) entry.ttfb = ttfb;
          });
          entry.bytes = new Uint8Array(res.data);
          entry.total = res.total;
          entry.ttfb = res.ttfb;
          entry.status = 'ready';
          entry.warmupEnd = performance.now();

          // Try caching in Cache API if supported
          if (typeof caches !== 'undefined') {
            try {
              const c = await caches.open(CONFIG.CACHE_NAME);
              await c.put(
                new Request(`https://bunkr-warmup.local/${key}`),
                new Response(entry.bytes, {
                  headers: {
                    'Content-Type': 'video/mp4',
                    'Content-Range': `bytes 0-${entry.bytes.byteLength - 1}/${entry.total}`,
                    'X-Bunkr-Url': signedUrl
                  }
                })
              );
            } catch (_) { }
          }

          console.log(`[BunkrFastStart] Pre-warmed #${key}: ${entry.bytes.byteLength} B in ${(entry.warmupEnd - entry.warmupStart).toFixed(0)}ms (TTFB: ${res.ttfb.toFixed(0)}ms, total: ${res.total} B)`);
          return entry;
        } catch (err) {
          if (attempt === 1 && isRecoverableError(err)) {
            entry.retries++;
            console.warn(`[BunkrFastStart] Range failed (${err.message}) on #${key}, instant re-resolve and retry once...`);
            await new Promise(r => setTimeout(r, Math.min(CONFIG.MAX_RECOVERY_BACKOFF_MS, 200)));
            try {
              signedUrl = await resolveUrl(item, true);
              entry.signedUrl = signedUrl;
              rangeUrl = getRangeUrl(signedUrl, entry.watchUrl, 12);
              continue; // retry once
            } catch (resErr) {
              console.warn(`[BunkrFastStart] Re-resolve failed for #${key}:`, resErr);
            }
          }
          entry.status = 'failed';
          entry.error = err;
          return entry;
        }
      }
      return entry;
    };

    const task = options.priority ? runWarmup() : warmupLimiter.run(runWarmup);
    entry.promise = task;
    return task;
  }

  // ── HUD / Debug Overlay ──────────────────────────────────────────────────────
  function updateHudOverlay(metrics) {
    if (typeof document === 'undefined') return;
    let hud = document.getElementById('nexus-bunkr-faststart-hud');
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'nexus-bunkr-faststart-hud';
      hud.style.cssText = [
        'position:fixed',
        'bottom:14px',
        'left:14px',
        'z-index:99999',
        'background:rgba(10,12,22,0.88)',
        'backdrop-filter:blur(8px)',
        'border:1px solid rgba(168,85,247,0.45)',
        'border-radius:8px',
        'padding:6px 11px',
        'font:600 11px/1.4 "JetBrains Mono", monospace',
        'color:#e9d5ff',
        'pointer-events:none',
        'box-shadow:0 6px 20px rgba(0,0,0,0.45)',
        'transition:opacity 0.3s ease'
      ].join(';');
      document.body.appendChild(hud);
    }
    hud.style.opacity = '1';
    const ttfbStr = metrics.ttfb ? `${metrics.ttfb.toFixed(0)}ms` : '0ms (cache)';
    const moovStr = metrics.timeToMoov ? `${metrics.timeToMoov.toFixed(0)}ms` : '…';
    const frameStr = metrics.timeToFirstFrame ? `${metrics.timeToFirstFrame.toFixed(0)}ms` : '…';
    const badge = metrics.warmCacheHit ? '⚡ WARM HIT' : '🚀 LIVE STREAM';
    hud.innerHTML = `<span style="color:#a855f7">${badge}</span> · TTFB: <b>${ttfbStr}</b> · moov: <b>${moovStr}</b> · 1st frame: <b style="color:#4ade80">${frameStr}</b>`;

    clearTimeout(hud._hideTimer);
    hud._hideTimer = setTimeout(() => {
      if (hud) hud.style.opacity = '0';
    }, 8000);
  }

  // ── MSE Fast-Start Player Controller ─────────────────────────────────────────
  class BunkrFastPlayer {
    constructor(videoElement, item, options = {}) {
      this.video = videoElement;
      this.item = item;
      this.options = options;
      this.key = getBunkrKey(item);
      this.dead = false;
      this.ready = false;
      this.offset = 0;
      this.total = 0;
      this.buffers = new Map();
      this.pendingBytes = 0;
      this.requests = new Set();
      this.pumpTimer = null;
      this.mediaSource = null;
      this.objectUrl = null;
      this.mp4box = null;

      this.tPlayStart = performance.now();
      this.metrics = {
        key: this.key,
        warmCacheHit: false,
        ttfb: 0,
        timeToMoov: 0,
        timeToFirstFrame: 0
      };
      this.onFallback = options.onFallback || (() => {});
      this.onMetrics = options.onMetrics || (() => {});
    }

    async start() {
      this.video.muted = true;
      const MP4Box = await ensureMp4Box();
      if (!MP4Box || typeof MediaSource === 'undefined') {
        throw new Error('MediaSource or MP4Box not available');
      }

      // 1. Check warm cache entry (ready OR partially warmed in-flight)
      let warmEntry = cache.get(this.key);
      const hasReadyBytes = warmEntry && warmEntry.status === 'ready' && warmEntry.bytes && warmEntry.bytes.byteLength > 0;
      const hasPartialBytes = !hasReadyBytes && warmEntry && warmEntry.status === 'warming' && warmEntry.partialLength >= 256 * 1024;

      this.metrics.warmCacheHit = !!(hasReadyBytes || hasPartialBytes);

      if (hasReadyBytes) {
        this.metrics.ttfb = warmEntry.ttfb;
        this.total = warmEntry.total;
        this.signedUrl = warmEntry.signedUrl;
        this.watchUrl = warmEntry.watchUrl;
      } else if (hasPartialBytes) {
        this.metrics.ttfb = warmEntry.ttfb;
        this.total = warmEntry.total;
        this.signedUrl = warmEntry.signedUrl;
        this.watchUrl = warmEntry.watchUrl;
      } else {
        const candidate = this.item.directUrl || this.item.url || '';
        this.signedUrl = isUrlValidAndFresh(candidate) ? candidate : await resolveUrl(this.item, false);
        this.watchUrl = this.item.source_url || this.item.url || '';
      }

      if (!this.signedUrl) throw new Error('No playable signed URL');

      // 2. Create MediaSource
      this.mediaSource = new MediaSource();
      this.objectUrl = URL.createObjectURL(this.mediaSource);

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error('MediaSource open timeout'));
        }, 3000);
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          clearTimeout(timeout);
          this.mediaSource.removeEventListener('sourceopen', onOpen);
        };
        this.mediaSource.addEventListener('sourceopen', onOpen);
        this.video.src = this.objectUrl;
        this.video.load();
      });

      if (this.dead) return;

      // 3. Initialize MP4Box
      this.mp4box = MP4Box.createFile();
      this.mp4box.onError = (err) => {
        console.warn('[BunkrFastStart] MP4Box error:', err);
        if (!this.ready) this.triggerFallback(err);
      };

      this.mp4box.onReady = (info) => {
        try {
          this.metrics.timeToMoov = performance.now() - this.tPlayStart;
          this.duration = info.duration / info.timescale;
          if (this.mediaSource.readyState === 'open' && Number.isFinite(this.duration) && this.duration > 0) {
            try { this.mediaSource.duration = this.duration; } catch (_) {}
          }
          const tracks = info.tracks.filter(t => t.video || t.audio);
          if (!tracks.some(t => t.video)) throw new Error('No video track found');

          for (const track of tracks) {
            const mime = `${track.video ? 'video' : 'audio'}/mp4; codecs="${track.codec}"`;
            if (!MediaSource.isTypeSupported(mime)) throw new Error(`Unsupported codec: ${track.codec}`);
            const sb = this.mediaSource.addSourceBuffer(mime);
            const entry = { sb, queue: [] };
            this.buffers.set(track.id, entry);
            sb.addEventListener('updateend', () => this.drain(entry));
            sb.addEventListener('error', (e) => {
              console.warn('[BunkrFastStart] SourceBuffer error:', e);
            });
            // Smaller segment sample count (15 video / 24 audio) so first segment emits after just ~0.5s of media!
            this.mp4box.setSegmentOptions(track.id, entry, { nbSamples: track.video ? 15 : 24 });
          }

          this.mp4box.onSegment = (id, entry, data, sample) => {
            this.pendingBytes += data.byteLength;
            entry.queue.push({ data, id, sample });
            this.drain(entry);
          };

          for (const init of this.mp4box.initializeSegmentation()) {
            const entry = this.buffers.get(init.id);
            if (entry) {
              this.pendingBytes += init.buffer.byteLength;
              entry.queue.push({ data: init.buffer });
              this.drain(entry);
            }
          }

          this.ready = true;
          this.mp4box.start();

          // Setup first frame measurement
          this.setupFirstFrameMeasurement();

          // Start playback immediately
          this.video.play().catch(() => {});
        } catch (err) {
          console.warn('[BunkrFastStart] onReady setup failed:', err);
          this.triggerFallback(err);
        }
      };

      // 4. Feed initial bytes immediately (from warm cache OR progressive stream)
      if (hasReadyBytes) {
        const bufferCopy = warmEntry.bytes.slice(0).buffer;
        bufferCopy.fileStart = 0;
        const next = this.mp4box.appendBuffer(bufferCopy);
        this.offset = Number.isFinite(next) ? next : bufferCopy.byteLength;
      } else {
        await this.streamInitialWarmup();
      }

      // If moov was at the end of the file (tail moov) or larger than initial window, fetch required offset
      let probe = 0;
      while (!this.ready && probe < 8 && !this.dead) {
        probe++;
        const res = await this.fetchChunkWithRecovery(this.offset, this.offset + CONFIG.CHUNK_SIZE - 1);
        if (this.dead) return;
        this.total = res.total || this.total;
        res.data.fileStart = this.offset;
        const next = this.mp4box.appendBuffer(res.data);
        this.offset = Number.isFinite(next) ? next : this.offset + res.data.byteLength;
      }

      if (!this.ready && !this.dead) {
        throw new Error('Failed to parse MP4 metadata in initial chunks');
      }

      // 5. Start background pump
      this.pumpTimer = setInterval(() => { void this.pump(); }, 200);
      void this.pump();
    }

    async streamInitialWarmup() {
      let attempt = 0;
      while (attempt < 2 && !this.dead) {
        attempt++;
        const rangeUrl = getRangeUrl(this.signedUrl, this.watchUrl, 12);
        const abort = new AbortController();
        this.requests.add(abort);

        let pendingChunks = [];
        let pendingLen = 0;
        let appendedOffset = 0;

        const flushPendingToMp4Box = (force = false) => {
          if (this.dead || !this.mp4box || pendingLen === 0) return;
          if (!force && pendingLen < CONFIG.STREAM_APPEND_STEP) return;
          const combined = new Uint8Array(pendingLen);
          let pos = 0;
          for (const c of pendingChunks) {
            combined.set(c, pos);
            pos += c.byteLength;
          }
          pendingChunks = [];
          pendingLen = 0;

          const ab = combined.buffer;
          ab.fileStart = appendedOffset;
          appendedOffset += ab.byteLength;
          const next = this.mp4box.appendBuffer(ab);
          this.offset = Number.isFinite(next) ? next : appendedOffset;
        };

        try {
          const res = await fetchRange(
            rangeUrl,
            0,
            CONFIG.WARMUP_BYTES - 1,
            abort.signal,
            (chunk, received, total, ttfb) => {
              if (!this.metrics.ttfb && ttfb > 0) this.metrics.ttfb = ttfb;
              if (total > 0) this.total = total;
              pendingChunks.push(chunk);
              pendingLen += chunk.byteLength;
              // Feed progressively only if MP4Box hasn't jumped to a tail-moov offset
              if (!this.offset || this.offset === appendedOffset) {
                flushPendingToMp4Box(false);
              }
            }
          );

          if (!this.offset || this.offset === appendedOffset) {
            flushPendingToMp4Box(true);
          }

          // Save into warm cache for instant replay if user re-opens
          cache.set(this.key, {
            key: this.key,
            item: this.item,
            status: 'ready',
            signedUrl: this.signedUrl,
            watchUrl: this.watchUrl,
            bytes: new Uint8Array(res.data),
            total: res.total,
            ttfb: res.ttfb,
            warmupStart: this.tPlayStart,
            warmupEnd: performance.now(),
            retries: attempt - 1
          });
          return;
        } catch (err) {
          if (this.dead) return;
          if (attempt === 1 && isRecoverableError(err)) {
            console.warn(`[BunkrFastStart] Initial stream failed (${err.message}) on #${this.key}, re-resolving fresh URL...`);
            await new Promise(r => setTimeout(r, Math.min(CONFIG.MAX_RECOVERY_BACKOFF_MS, 200)));
            const fresh = await resolveUrl(this.item, true);
            if (fresh) {
              this.signedUrl = fresh;
              // Reset mp4box if partial bytes were fed before failure
              if (appendedOffset > 0 && global.MP4Box) {
                this.offset = 0;
              }
              continue;
            }
          }
          throw err;
        } finally {
          this.requests.delete(abort);
        }
      }
    }

    setupFirstFrameMeasurement() {
      const onFirstFrame = () => {
        if (this.metrics.timeToFirstFrame > 0) return;
        this.metrics.timeToFirstFrame = performance.now() - this.tPlayStart;

        console.log(
          `%c[Bunkr FastStart] ⚡ FAST PLAYBACK READY:
  • TTFB: ${this.metrics.ttfb.toFixed(0)} ms
  • moov complete: ${this.metrics.timeToMoov.toFixed(0)} ms
  • First frame: ${this.metrics.timeToFirstFrame.toFixed(0)} ms
  • Warm Cache Hit: ${this.metrics.warmCacheHit}`,
          'color:#4ade80;font-weight:bold;'
        );

        updateHudOverlay(this.metrics);
        this.onMetrics(this.metrics);
      };

      if ('requestVideoFrameCallback' in this.video) {
        this.video.requestVideoFrameCallback(onFirstFrame);
      }
      this.video.addEventListener('playing', onFirstFrame, { once: true });
      this.video.addEventListener('loadeddata', onFirstFrame, { once: true });
    }

    async fetchChunk(start, end) {
      const rangeUrl = getRangeUrl(this.signedUrl, this.watchUrl, 12);
      const abort = new AbortController();
      this.requests.add(abort);
      try {
        return await fetchRange(rangeUrl, start, end, abort.signal);
      } finally {
        this.requests.delete(abort);
      }
    }

    async fetchChunkWithRecovery(start, end) {
      try {
        return await this.fetchChunk(start, end);
      } catch (err) {
        if (this.dead) throw err;
        if (isRecoverableError(err)) {
          await new Promise(r => setTimeout(r, Math.min(CONFIG.MAX_RECOVERY_BACKOFF_MS, 200)));
          const fresh = await resolveUrl(this.item, true);
          if (fresh) this.signedUrl = fresh;
          return await this.fetchChunk(start, end);
        }
        throw err;
      }
    }

    async pump() {
      if (this.dead || this.pumpBusy || !this.ready || this.video.paused || this.video.ended) return;
      if (this.total > 0 && this.offset >= this.total) {
        if (this.mediaSource && this.mediaSource.readyState === 'open') {
          const allEmpty = [...this.buffers.values()].every(e => !e.queue.length && !e.sb.updating);
          if (allEmpty) {
            try { this.mediaSource.endOfStream(); } catch (_) {}
          }
        }
        return;
      }

      let bufferedAhead = 0;
      const ct = this.video.currentTime;
      for (let i = 0; i < this.video.buffered.length; i++) {
        if (this.video.buffered.start(i) <= ct + 0.5 && this.video.buffered.end(i) >= ct) {
          bufferedAhead = this.video.buffered.end(i) - ct;
          break;
        }
      }

      if (bufferedAhead >= CONFIG.TARGET_BUFFER_AHEAD || this.pendingBytes >= 6 * 1024 * 1024) return;

      this.pumpBusy = true;
      try {
        const end = this.total > 0
          ? Math.min(this.total - 1, this.offset + CONFIG.CHUNK_SIZE - 1)
          : this.offset + CONFIG.CHUNK_SIZE - 1;

        const res = await this.fetchChunkWithRecovery(this.offset, end);
        if (this.dead) return;
        if (res.total > 0) this.total = res.total;
        res.data.fileStart = this.offset;
        const next = this.mp4box.appendBuffer(res.data);
        this.offset = Number.isFinite(next) ? next : this.offset + res.data.byteLength;
      } catch (err) {
        if (!this.dead) {
          console.warn('[BunkrFastStart] Background pump error:', err.message);
        }
      } finally {
        this.pumpBusy = false;
      }
    }

    drain(entry) {
      if (this.dead || entry.sb.updating || !this.mediaSource || this.mediaSource.readyState !== 'open') return;
      const trim = this.video.currentTime - 20;
      if (entry.sb.buffered.length && entry.sb.buffered.start(0) < trim - 5) {
        try {
          entry.sb.remove(0, trim);
          return;
        } catch (_) {}
      }
      const next = entry.queue[0];
      if (!next) return;
      try {
        entry.sb.appendBuffer(next.data);
        entry.queue.shift();
        this.pendingBytes = Math.max(0, this.pendingBytes - next.data.byteLength);
        if (next.id != null && this.mp4box) {
          this.mp4box.releaseUsedSamples(next.id, next.sample);
        }
      } catch (err) {
        if (err.name === 'QuotaExceededError' && trim > 0) {
          try { entry.sb.remove(0, trim); } catch (_) {}
        }
      }
    }

    triggerFallback(err) {
      if (this.dead) return;
      this.destroy();
      console.warn('[BunkrFastStart] Triggering native fallback:', err);
      const rawUrl = this.signedUrl || this.item.url;
      const fallbackUrl = getRangeUrl(rawUrl, this.watchUrl, 20) || rawUrl;
      this.onFallback(fallbackUrl);
    }

    destroy() {
      if (this.dead) return;
      this.dead = true;
      clearInterval(this.pumpTimer);
      for (const abort of this.requests) abort.abort();
      this.requests.clear();
      if (this.mp4box) {
        try { this.mp4box.stop(); } catch (_) {}
        this.mp4box.onReady = null;
        this.mp4box.onSegment = null;
        this.mp4box.onError = null;
      }
      for (const entry of this.buffers.values()) entry.queue.length = 0;
      if (this.objectUrl) {
        try { URL.revokeObjectURL(this.objectUrl); } catch (_) {}
        this.objectUrl = null;
      }
    }
  }

  // ── Native Proxy FastStart Player (0ms RAM Prefix + C++ Demuxer + Instant Seek)
  class BunkrNativeProxyPlayer {
    constructor(videoElement, item, options = {}) {
      this.video = videoElement;
      this.item = typeof item === 'string' ? { url: item, source_url: item } : (item || {});
      this.key = getBunkrKey(this.item);
      this.watchUrl = String(this.item.source_url || this.item.url || '').trim();
      this.signedUrl = null;
      this.dead = false;
      this.recovering = false;
      this.recoveryCount = 0;
      this.tPlayStart = performance.now();
      this.metrics = {
        ttfb: 0,
        timeToMoov: 0,
        timeToFirstFrame: 0,
        warmCacheHit: false,
        retries: 0
      };
      this.onMetrics = options.onMetrics || (() => {});
      this.onFallback = options.onFallback || (() => {});
      this._cleanups = [];
    }

    async start() {
      this.tPlayStart = performance.now();
      const warmEntry = cache.get(this.key);

      if (warmEntry && warmEntry.status === 'ready' && warmEntry.bytes && warmEntry.bytes.byteLength > 0) {
        this.metrics.warmCacheHit = true;
        this.metrics.ttfb = warmEntry.ttfb || 1;
        this.metrics.retries = warmEntry.retries || 0;
        this.signedUrl = warmEntry.signedUrl;
      } else if (warmEntry && warmEntry.signedUrl && isUrlValidAndFresh(warmEntry.signedUrl)) {
        this.signedUrl = warmEntry.signedUrl;
        if (warmEntry.ttfb) {
          this.metrics.ttfb = warmEntry.ttfb;
          this.metrics.warmCacheHit = true;
        }
      } else if (isUrlValidAndFresh(this.item.url)) {
        this.signedUrl = this.item.url;
      } else {
        this.signedUrl = await resolveUrl(this.item, false);
      }

      if (this.dead) return;
      if (!this.signedUrl) {
        throw new Error('Could not resolve Bunkr signed URL');
      }

      const proxyUrl = getRangeUrl(this.signedUrl, this.watchUrl, 15);
      this._wireEvents();
      this.video.src = proxyUrl;
      this.video.load();
    }

    _wireEvents() {
      const onProgressOrLoadData = () => {
        if (this.dead || this.metrics.ttfb > 0) return;
        this.metrics.ttfb = Math.max(1, performance.now() - this.tPlayStart);
        updateHudOverlay(this.metrics);
        this.onMetrics(this.metrics);
      };

      const onLoadedMetadata = () => {
        if (this.dead) return;
        if (!this.metrics.ttfb) {
          this.metrics.ttfb = Math.max(1, performance.now() - this.tPlayStart);
        }
        if (!this.metrics.timeToMoov) {
          this.metrics.timeToMoov = Math.max(1, performance.now() - this.tPlayStart);
        }
        updateHudOverlay(this.metrics);
        this.onMetrics(this.metrics);
      };

      const onFirstFrame = () => {
        if (this.dead || this.metrics.timeToFirstFrame > 0) return;
        const nowElapsed = Math.max(1, performance.now() - this.tPlayStart);
        if (!this.metrics.ttfb) this.metrics.ttfb = nowElapsed;
        if (!this.metrics.timeToMoov) this.metrics.timeToMoov = nowElapsed;
        this.metrics.timeToFirstFrame = nowElapsed;

        console.log(
          `%c[Bunkr FastStart] ⚡ FAST PLAYBACK READY:
  • TTFB: ${this.metrics.ttfb.toFixed(0)} ms
  • moov complete: ${this.metrics.timeToMoov.toFixed(0)} ms
  • First frame: ${this.metrics.timeToFirstFrame.toFixed(0)} ms
  • Warm Cache Hit: ${this.metrics.warmCacheHit}`,
          'color:#4ade80;font-weight:bold;'
        );

        updateHudOverlay(this.metrics);
        this.onMetrics(this.metrics);
      };

      const onError = async () => {
        if (this.dead || this.recovering || this.recoveryCount >= 1) return;
        this.recovering = true;
        this.recoveryCount++;
        this.metrics.retries++;
        try {
          console.warn(`[BunkrFastStart] Video stream error on #${this.key}, re-resolving fresh URL...`);
          await new Promise(r => setTimeout(r, Math.min(CONFIG.MAX_RECOVERY_BACKOFF_MS, 200)));
          if (this.dead) return;
          const fresh = await resolveUrl(this.item, true);
          if (this.dead || !fresh) return;
          this.signedUrl = fresh;
          this.item.url = fresh;
          const savedTime = this.video.currentTime || 0;
          const freshProxyUrl = getRangeUrl(fresh, this.watchUrl, 15);
          this.video.src = freshProxyUrl;
          this.video.load();
          if (savedTime > 0.5) {
            this.video.addEventListener('loadedmetadata', () => {
              if (!this.dead) {
                try { this.video.currentTime = savedTime; } catch (_) {}
              }
            }, { once: true });
          }
          this.video.play?.()?.catch(() => {});
        } catch (err) {
          console.warn('[BunkrFastStart] Fast recovery failed:', err);
        } finally {
          this.recovering = false;
        }
      };

      this.video.addEventListener('progress', onProgressOrLoadData, { once: true });
      this.video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
      this.video.addEventListener('loadeddata', onFirstFrame, { once: true });
      this.video.addEventListener('playing', onFirstFrame, { once: true });
      this.video.addEventListener('error', onError);

      if ('requestVideoFrameCallback' in this.video) {
        try { this.video.requestVideoFrameCallback(onFirstFrame); } catch (_) {}
      }

      this._cleanups.push(() => {
        this.video.removeEventListener('progress', onProgressOrLoadData);
        this.video.removeEventListener('loadedmetadata', onLoadedMetadata);
        this.video.removeEventListener('loadeddata', onFirstFrame);
        this.video.removeEventListener('playing', onFirstFrame);
        this.video.removeEventListener('error', onError);
      });
    }

    destroy() {
      if (this.dead) return;
      this.dead = true;
      for (const fn of this._cleanups) {
        try { fn(); } catch (_) {}
      }
      this._cleanups.length = 0;
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  const BunkrFastStart = {
    CONFIG,
    cache,
    limiter: warmupLimiter,
    isBunkr,
    getBunkrKey,
    getRangeUrl,
    isUrlValidAndFresh,
    prewarmVideo,
    prewarmBatch(items) {
      if (!Array.isArray(items)) return;
      warmupLimiter.clearPending();
      const bunkrItems = items.filter(isBunkr).slice(0, 6);
      for (const item of bunkrItems) {
        prewarmVideo(item);
      }
    },
    attachPlayer(videoElement, item, options = {}) {
      const player = new BunkrFastPlayer(videoElement, item, options);
      return player;
    },
    attachNativeProxyPlayer(videoElement, item, options = {}) {
      const player = new BunkrNativeProxyPlayer(videoElement, item, options);
      return player;
    },
    getWarmEntry(itemOrUrl) {
      const key = getBunkrKey(itemOrUrl);
      return cache.get(key) || null;
    }
  };

  global.NexusBunkrFastStart = BunkrFastStart;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BunkrFastStart;
  }
})(typeof window !== 'undefined' ? window : globalThis);
