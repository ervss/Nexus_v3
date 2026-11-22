/* Only gallery frames preload a still frame. Never start playback automatically. */
(() => {
  const isGallery = location.hash === '#nvs-gallery';
  let userInteracted = false;
  if (isGallery) {
    const markInteracted = event => { if (event?.isTrusted) userInteracted = true; };
    for (const evt of ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'click']) {
      window.addEventListener(evt, markInteracted, { capture: true, passive: true });
    }
  }
  const enforceManualPlay = video => {
    if (!isGallery || userInteracted) return;
    video.autoplay = false;
    video.removeAttribute('autoplay');
    if (!video.paused) video.pause();
  };
  const prepare = video => {
    if (isGallery && !video.dataset.nvsNoAutoplay) {
      video.dataset.nvsNoAutoplay = '1';
      enforceManualPlay(video);
      video.addEventListener('play', () => enforceManualPlay(video), true);
      video.addEventListener('playing', () => enforceManualPlay(video), true);
    }
    if (video.dataset.nvsPreview) return;
    video.dataset.nvsPreview = '1';
    video.preload = 'metadata';
    let size = 0;
    const report = () => {
      const id = location.pathname.split('/').filter(Boolean).at(-1);
      chrome.runtime.sendMessage({ type: 'TURBO_FRAME_META', id, meta: { duration: video.duration, width: video.videoWidth, height: video.videoHeight, size_bytes: size } }).catch(() => {});
    };
    video.addEventListener('loadedmetadata', report);
    video.addEventListener('loadeddata', report);
    if (video.readyState >= 1) report();
    const source = video.currentSrc || video.src;
    try {
      const u = new URL(source);
      if (u.protocol === 'https:' && /(^|\.)turbocdn\.st$/.test(u.hostname) && !u.username && !u.password && !u.port) {
        // Content-Range is not exposed by Turbo's CDN CORS policy. A HEAD
        // response exposes the full Content-Length without downloading media.
        fetch(source, { method: 'HEAD', signal: AbortSignal.timeout(8000), redirect: 'error' }).then(async response => {
          if (response.status === 200 && !/text\/|json|xml/i.test(response.headers.get('content-type') || '')) size = Number(response.headers.get('content-length')) || 0;
          await response.body?.cancel(); report();
        }).catch(() => {});
      }
    } catch { /* A player without a source will report after metadata loads. */ }
    const seek = () => {
      if (video.paused && Number.isFinite(video.duration) && video.duration > 0) video.currentTime = Math.min(1, video.duration / 2);
    };
    if (video.readyState >= 1) seek(); else video.addEventListener('loadedmetadata', seek, { once: true });
    if (video.readyState === 0) video.load();
  };
  let enabled = location.hash === '#nvs-gallery';
  chrome.runtime.sendMessage({ type: 'TURBO_FRAME_HELLO', id: location.pathname.split('/').filter(Boolean).at(-1) }).then(response => {
    if (response?.prepare) { enabled = true; document.querySelectorAll('video').forEach(prepare); }
  }).catch(() => {});
  chrome.runtime.onMessage.addListener(message => {
    if (message.type !== 'TURBO_PREPARE_FRAME' || message.id !== location.pathname.split('/').filter(Boolean).at(-1)) return;
    enabled = true; document.querySelectorAll('video').forEach(prepare);
  });
  if (enabled) document.querySelectorAll('video').forEach(prepare);
  const observer = new MutationObserver(() => { if (enabled) document.querySelectorAll('video').forEach(prepare); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
})();
