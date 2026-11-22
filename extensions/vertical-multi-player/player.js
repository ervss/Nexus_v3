
const _getLang = () => (typeof localStorage !== 'undefined' && localStorage.getItem('nexus_language') === 'sk') ? 'sk' : 'en';
const _t = (sk, en) => (_getLang() === 'sk' ? sk : en);

'use strict';

const MAX_STREAMS = 3;
const videoInput = document.getElementById('videoInput');
const urlInput = document.getElementById('urlInput');
const loadUrlsBtn = document.getElementById('loadUrls');
const dropZone = document.getElementById('dropZone');
const videoContainer = document.getElementById('videoContainer');
const videoCountSpan = document.getElementById('videoCount');
const playbackStatus = document.getElementById('playbackStatus');
const mainBackground = document.getElementById('mainBackground');
const exportVideoBtn = document.getElementById('exportVideo');

let activeVideos = [];
let currentSources = [];
let objectUrls = [];
let hlsPlayers = [];
let ffmpeg = null;

function setStatus(message, tone = '') {
    playbackStatus.textContent = message;
    playbackStatus.dataset.tone = tone;
}

function sourceTitle(source) {
    if (source.kind === 'file') return source.file.name;
    try {
        const url = new URL(source.url);
        return decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || url.hostname);
    } catch (_) {
        return source.url;
    }
}

function normalizeDirectUrls(text) {
    const unique = new Set();
    for (const value of String(text || '').split(/[\r\n\s]+/)) {
        if (!value) continue;
        try {
            // Accept URLs copied from APIs which escaped slashes as `\\/` or
            // even returned `https:\\cdn...` (Bunkr's signer can do both).
            const clean = String(value)
                .trim()
                .replace(/^['"]+|['"]+$/g, '')
                .replace(/\\u0026/gi, '&')
                .replace(/\\\//g, '/')
                .replace(/\\/g, '/')
                .replace(/&amp;/gi, '&');
            const url = new URL(clean);
            if (!/^https?:$/i.test(url.protocol)) continue;
            unique.add(url.href);
        } catch (_) { /* non-URL text is ignored */ }
        if (unique.size === MAX_STREAMS) break;
    }
    return [...unique].map(url => ({ kind: 'url', url }));
}

function localSources(files) {
    return Array.from(files || [])
        .filter(file => file && (file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name)))
        .slice(0, MAX_STREAMS)
        .map(file => ({ kind: 'file', file }));
}

function isHls(url) {
    try { return /\.m3u8(?:$|[?#])/i.test(new URL(url).pathname + new URL(url).search); }
    catch (_) { return /\.m3u8(?:$|[?#])/i.test(String(url || '')); }
}

function cleanupPlayers() {
    hlsPlayers.forEach(player => player.destroy());
    hlsPlayers = [];
    objectUrls.forEach(url => URL.revokeObjectURL(url));
    objectUrls = [];
    activeVideos.forEach(video => {
        video.pause();
        video.removeAttribute('src');
        video.load();
    });
    activeVideos = [];
    mainBackground.replaceChildren();
}

function updateCount() {
    videoCountSpan.textContent = `Streamy: ${activeVideos.length}/${MAX_STREAMS}`;
    const allLocal = currentSources.length && currentSources.every(source => source.kind === 'file');
    exportVideoBtn.disabled = !allLocal;
    exportVideoBtn.title = allLocal
        ? 'Spojí lokálne videá vedľa seba'
        : 'Export funguje len pri lokálnych súboroch; URL streamy sa nepreberajú do FFmpeg.';
}

function attachHls(video, url, index) {
    if (window.Hls?.isSupported()) {
        const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_event, data) => {
            if (!data.fatal) return;
            setStatus(_t(`Stream ${index + 1}: HLS chyba (${data.type}).`, `Stream ${index + 1}: HLS error (${data.type}).`), 'error');
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
            else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        });
        hlsPlayers.push(hls);
        return;
    }
    // Safari and a few Chromium builds can handle HLS natively.
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        return;
    }
    setStatus(`Stream ${index + 1}: tento prehliadač nepodporuje HLS.`, 'error');
}

function setupFilters(video, controls) {
    const update = () => {
        const brightness = controls.querySelector('.f-bright').value;
        const contrast = controls.querySelector('.f-contrast').value;
        const saturation = controls.querySelector('.f-saturate').value;
        const zoom = Number(controls.querySelector('.t-zoom').value) / 100;
        const panX = controls.querySelector('.t-panx').value;
        const mirror = controls.querySelector('.t-mirror').checked;
        video.style.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;
        video.style.transform = `scale(${zoom}) translateX(${panX}px)${mirror ? ' scaleX(-1)' : ''}`;
    };
    controls.querySelectorAll('input').forEach(input => input.addEventListener('input', update));
    controls.querySelector('.t-mirror').addEventListener('change', update);
}

function createStreamCard(source, index) {
    const wrapper = document.createElement('article');
    wrapper.className = 'video-wrapper';
    const video = document.createElement('video');
    video.loop = true;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.controls = true;
    video.preload = 'metadata';

    const label = document.createElement('div');
    label.className = 'source-label';
    label.title = source.kind === 'url' ? source.url : source.file.name;
    label.textContent = `${index + 1}. ${sourceTitle(source)}`;

    const controls = document.createElement('div');
    controls.className = 'video-controls';
    controls.innerHTML = `
        <div class="control-group"><label>Jas <input type="range" class="f-bright" min="0" max="200" value="100"></label>
        <label>Kontrast <input type="range" class="f-contrast" min="0" max="200" value="100"></label>
        <label>Sýtosť <input type="range" class="f-saturate" min="0" max="200" value="100"></label></div>
        <div class="control-group"><label>Zoom <input type="range" class="t-zoom" min="100" max="300" value="100"></label>
        <label>Pan X <input type="range" class="t-panx" min="-100" max="100" value="0"></label>
        <label><input type="checkbox" class="t-mirror"> Zrkadlo</label></div>`;

    wrapper.append(label, video, controls);
    videoContainer.appendChild(wrapper);
    setupFilters(video, controls);
    video.addEventListener('error', () => setStatus(`Stream ${index + 1} sa nedá prehrať. Skontroluj priamu URL alebo referer ochranu.`, 'error'));
    video.addEventListener('loadedmetadata', () => setStatus(`${activeVideos.length}/${MAX_STREAMS} streamy pripravené. Klikni na audio ovládanie konkrétneho videa pre zvuk.`, 'ready'));

    if (source.kind === 'file') {
        const objectUrl = URL.createObjectURL(source.file);
        objectUrls.push(objectUrl);
        video.src = objectUrl;
    } else if (isHls(source.url)) {
        attachHls(video, source.url, index);
    } else {
        video.src = source.url;
    }
    activeVideos.push(video);
    video.play().catch(() => { /* autoplay policy may wait for the first user click */ });
}

function loadSources(sources) {
    if (!sources.length) {
        setStatus('Nenašla sa platná HTTP(S) video URL ani video súbor.', 'error');
        return;
    }
    cleanupPlayers();
    currentSources = sources.slice(0, MAX_STREAMS);
    videoContainer.replaceChildren();
    currentSources.forEach(createStreamCard);
    updateCount();
    if (document.getElementById('blurBackground').checked) updateBackground();
}

function loadUrlsFromInput() {
    const sources = normalizeDirectUrls(urlInput.value);
    if (sources.length) {
        // Reflect the repaired direct URL(s) back into the input so it is
        // immediately obvious what will be loaded and can be copied again.
        urlInput.value = sources.map(source => source.url).join('\n');
        loadSources(sources);
    }
}

function updateBackground() {
    if (!document.getElementById('blurBackground').checked || !activeVideos.length) return;
    mainBackground.replaceChildren();
    const background = activeVideos[0].cloneNode(true);
    background.muted = true;
    background.controls = false;
    mainBackground.appendChild(background);
    background.play().catch(() => {});
}

async function loadFFmpeg() {
    if (ffmpeg) return ffmpeg;
    if (!window.FFmpegWASM || !window.FFmpegUtil) throw new Error('FFmpeg knižnice nie sú dostupné.');
    const { FFmpeg } = window.FFmpegWASM;
    const { toBlobURL } = window.FFmpegUtil;
    ffmpeg = new FFmpeg();
    setStatus('Načítavam FFmpeg engine…');
    await ffmpeg.load({
        coreURL: await toBlobURL('lib/ffmpeg-core.js', 'text/javascript'),
        wasmURL: await toBlobURL('lib/ffmpeg-core.wasm', 'application/wasm'),
    });
    return ffmpeg;
}

async function exportLocalVideos() {
    if (!currentSources.length || !currentSources.every(source => source.kind === 'file')) return;
    try {
        const engine = await loadFFmpeg();
        const { fetchFile } = window.FFmpegUtil;
        for (let index = 0; index < currentSources.length; index++) {
            await engine.writeFile(`input${index}.mp4`, await fetchFile(currentSources[index].file));
        }
        setStatus('Renderujem lokálne videá…');
        const inputs = currentSources.flatMap((_source, index) => ['-i', `input${index}.mp4`]);
        await engine.exec([...inputs, '-filter_complex', `hstack=inputs=${currentSources.length}`, '-map', '0:a?', 'output.mp4']);
        const data = await engine.readFile('output.mp4');
        const url = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
        const link = Object.assign(document.createElement('a'), { href: url, download: `nexus-multi-${Date.now()}.mp4` });
        link.click();
        URL.revokeObjectURL(url);
        setStatus('Export dokončený.', 'ready');
    } catch (error) {
        setStatus(_t(`Export zlyhal: ${error.message}`, `Export failed: ${error.message}`), 'error');
    }
}

document.getElementById('vybratVidea').addEventListener('click', () => videoInput.click());
videoInput.addEventListener('change', event => loadSources(localSources(event.target.files)));
loadUrlsBtn.addEventListener('click', loadUrlsFromInput);
urlInput.addEventListener('paste', () => setTimeout(loadUrlsFromInput, 0));
urlInput.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        loadUrlsFromInput();
    }
});

['dragenter', 'dragover'].forEach(type => dropZone.addEventListener(type, event => {
    event.preventDefault();
    dropZone.classList.add('dragging');
}));
['dragleave', 'drop'].forEach(type => dropZone.addEventListener(type, event => {
    event.preventDefault();
    dropZone.classList.remove('dragging');
}));
dropZone.addEventListener('drop', event => {
    const files = localSources(event.dataTransfer.files);
    if (files.length) return loadSources(files);
    const text = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain');
    if (text) {
        urlInput.value = text;
        loadUrlsFromInput();
    }
});

document.getElementById('resetVidea').addEventListener('click', () => {
    cleanupPlayers();
    currentSources = [];
    videoInput.value = '';
    urlInput.value = '';
    videoContainer.innerHTML = '<div class="placeholder-text">Vlož alebo pretiahni najviac 3 priame video streamy či lokálne súbory.</div>';
    updateCount();
    setStatus('Resetované.');
});
document.getElementById('seamlessMode').addEventListener('change', event => videoContainer.classList.toggle('seamless-active', event.target.checked));
document.getElementById('blurBackground').addEventListener('change', event => {
    mainBackground.style.display = event.target.checked ? 'block' : 'none';
    if (event.target.checked) updateBackground(); else mainBackground.replaceChildren();
});
document.getElementById('playPauseAll').addEventListener('click', () => {
    const playing = activeVideos.length && activeVideos.every(video => !video.paused);
    activeVideos.forEach(video => playing ? video.pause() : video.play().catch(() => {}));
});
document.getElementById('syncSeek').addEventListener('click', () => {
    if (activeVideos.length < 2) return;
    const time = activeVideos[0].currentTime;
    activeVideos.slice(1).forEach(video => { video.currentTime = time; });
    setStatus('Čas zosynchronizovaný podľa prvého streamu.', 'ready');
});
document.getElementById('masterSpeed').addEventListener('input', event => {
    const speed = Number(event.target.value);
    document.getElementById('speedVal').textContent = `${speed.toFixed(1)}x`;
    activeVideos.forEach(video => { video.playbackRate = speed; });
});
document.getElementById('nudgeBack').addEventListener('click', () => activeVideos.forEach(video => { video.currentTime = Math.max(0, video.currentTime - 0.5); }));
document.getElementById('nudgeForward').addEventListener('click', () => activeVideos.forEach(video => { video.currentTime += 0.5; }));
document.getElementById('toggleTheater').addEventListener('click', () => document.body.classList.toggle('theater-mode'));
document.getElementById('toggleZoomToFill').addEventListener('click', () => videoContainer.classList.toggle('zoom-to-fill'));
document.getElementById('toggleFullscreen').addEventListener('click', () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
exportVideoBtn.addEventListener('click', exportLocalVideos);

const helpModal = document.getElementById('helpModal');
function toggleHelp() { helpModal.open ? helpModal.close() : helpModal.showModal(); }
helpModal.querySelector('.close-button').addEventListener('click', () => helpModal.close());
document.addEventListener('keydown', event => {
    if (event.target.matches('input, textarea')) return;
    const key = event.key.toLowerCase();
    if (key === ' ') { event.preventDefault(); document.getElementById('playPauseAll').click(); }
    else if (key === 's') document.getElementById('syncSeek').click();
    else if (key === 'f') document.getElementById('toggleFullscreen').click();
    else if (key === 't') document.getElementById('toggleTheater').click();
    else if (key === 'z') document.getElementById('toggleZoomToFill').click();
    else if (key === 'h') toggleHelp();
    else if (key === 'r') document.getElementById('resetVidea').click();
    else if (key === 'arrowright') activeVideos.forEach(video => { video.currentTime += 5; });
    else if (key === 'arrowleft') activeVideos.forEach(video => { video.currentTime = Math.max(0, video.currentTime - 5); });
});
window.addEventListener('beforeunload', cleanupPlayers);
updateCount();
