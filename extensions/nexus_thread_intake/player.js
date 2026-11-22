(() => {
  const video = document.getElementById('video');
  const state = document.getElementById('state');
  let hls = null;
  let generation = 0;

  function show(message) { state.textContent = message; state.hidden = false; }
  function safeUrl(raw) {
    try {
      const url = new URL(raw);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }
  function reset() {
    if (hls) { hls.destroy(); hls = null; }
    video.pause(); video.removeAttribute('src'); video.load();
  }
  video.addEventListener('playing', () => { state.hidden = true; });
  video.addEventListener('error', () => show('Prehrávanie zlyhalo. Skús otvoriť pôvodný zdroj alebo Tester.'));

  window.addEventListener('message', async event => {
    if (event.source !== parent || !/^https:\/\/([a-z0-9-]+\.)?simpcity\.cr$/.test(event.origin)) return;
    const message = event.data;
    if (message?.type !== 'nexusThreadIntake.play') return;
    const url = safeUrl(message.url), port = Number(message.port);
    if (!url || ![8000, 8001, 8002].includes(port)) { show('Neplatný zdroj alebo port Nexusu.'); return; }
    const current = ++generation;
    reset(); show('Načítavam video zo zdroja…');
    try {
      const response = await chrome.runtime.sendMessage({ action: 'nexusThreadIntake.playWatched', port, url });
      if (current !== generation) return;
      if (!response?.ok) throw new Error(response?.error || 'Video sa nepodarilo načítať.');
      const playback = response.playback || {};
      const stream = safeUrl(playback.streamUrl);
      if (!stream) throw new Error('Zdroj nevrátil platný stream.');
      const base = `http://localhost:${port}`;
      const session = playback.proxySession ? `&session=${encodeURIComponent(playback.proxySession)}` : '';
      const proxy = playback.proxySession
        ? `${base}/media_proxy.mp4?url=${encodeURIComponent(stream)}&referer=${encodeURIComponent(url)}${session}`
        : `${base}/api/v1/video_proxy?url=${encodeURIComponent(stream)}&referer=${encodeURIComponent(url)}`;
      if (playback.isHls) {
        const playlist = `${base}/hls_proxy?url=${encodeURIComponent(stream)}&referer=${encodeURIComponent(url)}${session}`;
        if (globalThis.Hls?.isSupported()) {
          hls = new Hls({ maxBufferLength: 30 });
          hls.on(Hls.Events.ERROR, (_event, detail) => {
            if (detail?.fatal) show('HLS stream sa nepodarilo prehrať. Skús otvoriť pôvodný zdroj.');
          });
          hls.loadSource(playlist); hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => show('Klikni na ▶ pre prehratie.')));
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = playlist;
          video.play().catch(() => show('Klikni na ▶ pre prehratie.'));
        } else throw new Error('Tento prehliadač nepodporuje HLS video.');
      } else {
        video.src = proxy;
        video.play().catch(() => show('Klikni na ▶ pre prehratie.'));
      }
    } catch (error) {
      if (current === generation) show(error.message || String(error));
    }
  });
  window.addEventListener('pagehide', reset);
})();
