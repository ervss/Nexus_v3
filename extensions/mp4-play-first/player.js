const video = document.getElementById('video');
const status = document.getElementById('status');
const source = document.getElementById('source');
// This page lives for the lifetime of its tab. No background state is held here.
let hls;
let generation = 0;
let probe;
function showError(text) {
  document.body.classList.remove('playing');
  status.textContent = text;
}
async function autoplay() {
  try { await video.play(); }
  catch { status.textContent = 'Klikni Play v prehrávači. Automatické prehrávanie bolo odmietnuté.'; }
}
async function loadSource(raw) {
  const current = ++generation;
  probe?.abort(); probe = new AbortController();
  hls?.destroy(); hls = undefined;
  video.pause(); video.removeAttribute('src'); video.load();
  document.body.classList.remove('playing');
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Použi HTTP alebo HTTPS odkaz.');
    source.value = url.href;
    history.replaceState(null, '', '#' + url.href);
    status.textContent = 'Načítavam video…';
    let isHls = /\.m3u8(?:[?&#]|$)/i.test(url.href);
    if (!isHls && !/\.(mp4|m4v|webm|ogv|ogg|mov|mkv|avi|mpg|mpeg|3gp|3g2|ts|m2ts|flv|wmv)(?:[?&#]|$)/i.test(url.href)) {
      const response = await fetch(url.href, {method: 'HEAD', signal: probe.signal});
      if (!response.ok) throw new Error(`Server vrátil HTTP ${response.status}. Potrebuješ platný priamy odkaz.`);
      isHls = /mpegurl/i.test(response.headers.get('content-type') || '');
    }
    if (current !== generation) return;
    video.muted = true;
    if (isHls && Hls.isSupported()) {
      // No blob worker or remote JavaScript: compatible with MV3 extension CSP.
      hls = new Hls({enableWorker: false});
      hls.on(Hls.Events.MANIFEST_PARSED, autoplay);
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        const code = data.response?.code;
        if (code) showError(`HLS server vrátil HTTP ${code}. Odkaz môže byť neplatný, expirovaný alebo viazaný na IP/prihlásenie. Skopíruj čerstvý playlist zo stránky.`);
        else showError(`HLS sa nepodarilo prehrať (${data.details}). Skontroluj platnosť odkazu a podporu kodeku.`);
      });
      hls.loadSource(url.href);
      hls.attachMedia(video);
    } else {
      if (isHls && !video.canPlayType('application/vnd.apple.mpegurl')) throw new Error('Tento Chrome nepodporuje HLS prehrávanie.');
      video.src = url.href;
      await autoplay();
    }
  } catch (error) {
    if (current === generation && error.name !== 'AbortError') showError(error.message);
  }
}
video.addEventListener('playing', () => {
  status.textContent = '';
  document.body.classList.add('playing');
});
video.addEventListener('error', () => showError('Video sa nedá načítať. Skontroluj odkaz; Chrome musí podporovať jeho formát a kodek.'));
document.getElementById('source-form').addEventListener('submit', event => { event.preventDefault(); void loadSource(source.value.trim()); });
window.addEventListener('pagehide', () => { probe?.abort(); hls?.destroy(); });
if (location.hash.length > 1) void loadSource(location.hash.slice(1));
