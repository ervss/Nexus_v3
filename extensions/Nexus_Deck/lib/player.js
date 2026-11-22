const STORAGE_KEY = "nexus-deck-player";
const DEFAULTS = { rate: 1, volume: .8, muted: false, loop: false, fit: true, zoom: 1, panX: 0, panY: 0, rotation: 0, mirror: false, brightness: 1, contrast: 1, saturation: 1, hue: 0, blur: 0, sharpness: .25 };
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const byId = (id) => document.getElementById(id);
const isHlsUrl = (url) => /\.m3u8(?:$|[?#])/i.test(url || "");
const isHlsItem = (item) => typeof item.isHls === "boolean" ? item.isHls : isHlsUrl(item.playUrl || item.url);
const time = (seconds) => {
  if (!Number.isFinite(seconds)) return "0:00";
  const n = Math.floor(seconds);
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};

export function createDeckPlayer({ onStep, onHistorySelect, resolvePlayback, onDownload = async () => {}, onStatus = () => {} }) {
  const video = byId("player-video");
  const canvas = byId("player-canvas");
  const stage = byId("stage-media");
  const seek = byId("player-seek");
  const quality = byId("player-quality");
  let settings = { ...DEFAULTS };
  let history = [];
  let current = null;
  let hls = null;
  let loopA = null;
  let loopB = null;
  let dragging = null;
  let badgeTimer = 0;
  let lastSaved = 0;
  let gl = null;
  let fx = null;
  let fxFrame = 0;
  let generation = 0;
  let recover = null;
  let resumeListener = null;
  let startupTimer = 0;

  async function read() {
    if (globalThis.chrome?.runtime?.id) return (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {};
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch { return {}; }
  }
  async function persist() {
    const value = { settings, history };
    if (globalThis.chrome?.runtime?.id) await chrome.storage.local.set({ [STORAGE_KEY]: value });
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  }
  function badge(message) {
    const node = byId("zoom-badge");
    node.textContent = message;
    node.hidden = false;
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => { node.hidden = true; }, 1100);
  }
  function updateRadar() {
    const radar = byId("radar-map");
    radar.hidden = !current || (settings.fit && settings.zoom <= 1.05);
    if (radar.hidden) return;
    const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
    const viewport = stage.clientWidth / Math.max(1, stage.clientHeight);
    const width = Math.max(10, Math.min(80, 80 * (settings.fit ? 1 : viewport / aspect) / settings.zoom));
    const height = Math.max(10, Math.min(45, 45 / settings.zoom));
    const box = byId("radar-box");
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
    box.style.left = `${clamp(40 - settings.panX * .4 - width / 2, 0, 80 - width)}px`;
    box.style.top = `${clamp(22.5 - settings.panY * .225 - height / 2, 0, 45 - height)}px`;
  }
  function apply() {
    video.playbackRate = settings.rate;
    video.volume = settings.volume;
    video.muted = settings.muted;
    video.loop = settings.loop && loopA === null;
    stage.classList.toggle("is-fill", !settings.fit);
    byId("player-mode").textContent = settings.fit ? "FIT" : "FILL";
    byId("player-fit").textContent = settings.fit ? "FILL" : "FIT";
    const transform = `scale(${settings.zoom}) translate(${settings.panX}%, ${settings.panY}%) rotate(${settings.rotation}deg) scaleX(${settings.mirror ? -1 : 1})`;
    const filter = `brightness(${settings.brightness}) contrast(${settings.contrast}) saturate(${settings.saturation}) hue-rotate(${settings.hue}deg) blur(${settings.blur}px)`;
    for (const target of [video, canvas]) { target.style.transform = transform; target.style.filter = filter; }
    for (const [key, id] of Object.entries({ rate:"player-rate", volume:"player-volume", zoom:"player-zoom", panX:"player-pan-x", panY:"player-pan-y", rotation:"player-rotation", brightness:"player-brightness", contrast:"player-contrast", saturation:"player-saturation", hue:"player-hue", blur:"player-blur", sharpness:"player-sharpness" })) byId(id).value = settings[key];
    byId("player-loop").setAttribute("aria-pressed", String(settings.loop));
    byId("player-mute").setAttribute("aria-pressed", String(settings.muted));
    byId("player-mute").textContent = settings.muted ? "Zapnúť zvuk" : "Stlmiť";
    byId("player-mirror").setAttribute("aria-pressed", String(settings.mirror));
    updateRadar();
  }
  function updateTime() {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    seek.max = duration;
    if (!seek.matches(":active")) seek.value = Math.min(video.currentTime || 0, duration);
    byId("player-time").textContent = `${time(video.currentTime)} / ${time(duration)}`;
  }
  function renderHistory() {
    const list = byId("history-list");
    list.replaceChildren();
    byId("history-count").textContent = String(history.length);
    for (const entry of history) {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${entry.title} · ${time(entry.position)}`;
      button.addEventListener("click", () => onHistorySelect(entry));
      row.append(button);
      list.append(row);
    }
  }
  function remember() {
    if (!current) return;
    history = [{ id: current.id, title: current.title, position: video.currentTime || 0, playedAt: Date.now(), item: current }, ...history.filter((entry) => entry.id !== current.id)].slice(0, 120);
    renderHistory();
    persist();
  }
  function stopHls() {
    hls?.destroy();
    hls = null;
    quality.replaceChildren(new Option("Auto", "-1"));
  }
  function populateQuality(levels) {
    quality.replaceChildren(new Option("Auto", "-1"));
    levels.forEach((level, index) => quality.add(new Option(level.height ? `${level.height}p` : `Úroveň ${index + 1}`, String(index))));
  }
  function stopFx() {
    cancelAnimationFrame(fxFrame);
    fx = null;
    gl = null;
    canvas.hidden = true;
    video.style.visibility = "visible";
    byId("player-fx").setAttribute("aria-pressed", "false");
  }
  function shader(type, source) {
    const unit = gl.createShader(type);
    gl.shaderSource(unit, source);
    gl.compileShader(unit);
    if (!gl.getShaderParameter(unit, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(unit));
    return unit;
  }
  function renderFx() {
    if (!fx || !gl) return;
    if (video.videoWidth && video.videoHeight) {
      try {
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; }
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.useProgram(fx.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, fx.buffer);
        gl.enableVertexAttribArray(fx.position);
        gl.vertexAttribPointer(fx.position, 2, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(fx.uv);
        gl.vertexAttribPointer(fx.uv, 2, gl.FLOAT, false, 16, 8);
        gl.bindTexture(gl.TEXTURE_2D, fx.texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        gl.uniform2f(fx.pixel, 1 / canvas.width, 1 / canvas.height);
        gl.uniform1f(fx.sharp, settings.sharpness);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      } catch {
        stopFx();
        badge("FX: zdroj nepovoľuje CORS");
        return;
      }
    }
    fxFrame = requestAnimationFrame(renderFx);
  }
  function startFx() {
    if (!current) return;
    try {
      gl = canvas.getContext("webgl", { premultipliedAlpha: false });
      if (!gl) throw new Error("WebGL");
      const program = gl.createProgram();
      gl.attachShader(program, shader(gl.VERTEX_SHADER, "attribute vec2 p;attribute vec2 uv;varying vec2 v;void main(){gl_Position=vec4(p,0.,1.);v=uv;}"));
      gl.attachShader(program, shader(gl.FRAGMENT_SHADER, "precision mediump float;varying vec2 v;uniform sampler2D t;uniform vec2 px;uniform float sharp;void main(){vec4 c=texture2D(t,v);vec4 n=texture2D(t,v+vec2(0.,px.y));vec4 s=texture2D(t,v-vec2(0.,px.y));vec4 e=texture2D(t,v+vec2(px.x,0.));vec4 w=texture2D(t,v-vec2(px.x,0.));gl_FragColor=c*(1.+4.*sharp)-sharp*(n+s+e+w);}"));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Shader");
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,0,0,1,-1,1,0,-1,1,0,1,1,1,1,1]), gl.STATIC_DRAW);
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      for (const key of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, key, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      fx = { program, buffer, texture, position: gl.getAttribLocation(program, "p"), uv: gl.getAttribLocation(program, "uv"), pixel: gl.getUniformLocation(program, "px"), sharp: gl.getUniformLocation(program, "sharp") };
      canvas.hidden = false;
      video.style.visibility = "hidden";
      byId("player-fx").setAttribute("aria-pressed", "true");
      renderFx();
    } catch { stopFx(); badge("FX nie je dostupné"); }
  }
  function toggleAb() {
    const now = video.currentTime || 0;
    if (loopA === null) { loopA = now; loopB = null; }
    else if (loopB === null) { loopB = Math.max(now, loopA); loopA = Math.min(now, loopA); }
    else { loopA = null; loopB = null; }
    video.loop = settings.loop && loopA === null;
    byId("player-ab").textContent = loopA === null ? "A–B" : loopB === null ? `A ${time(loopA)}…` : `${time(loopA)}–${time(loopB)} ↻`;
  }
  async function load(item, { autoplay = true, resumeAt = 0, recovery = false } = {}) {
    const activeGeneration = ++generation;
    clearTimeout(startupTimer);
    if (resumeListener) video.removeEventListener("loadedmetadata", resumeListener);
    recover = null;
    remember();
    stopFx();
    stopHls();
    video.pause();
    video.removeAttribute("src");
    if (item.nativeDirect) video.removeAttribute("crossorigin");
    else video.setAttribute("crossorigin", "anonymous");
    video.load();
    current = item;
    loopA = loopB = null;
    byId("player-ab").textContent = "A–B";
    const source = item.playUrl || item.url;
    const hlsSource = isHlsItem(item);
    const active = () => activeGeneration === generation;
    let recovering = false;
    recover = async () => {
      if (!active() || recovering) return;
      clearTimeout(startupTimer);
      if (recovery || !resolvePlayback) {
        if (item.directFallback && !item.nativeDirect) {
          recovering = true;
          await load({ ...item, playUrl: item.directFallback, directFallback: null, nativeDirect: true }, { autoplay, resumeAt: video.currentTime || resumeAt, recovery: true });
          return;
        }
        stopHls();
        onStatus("Prehratie zlyhalo aj po obnovení odkazu. Skús Prehrať znova alebo otvor Zdroj.");
        return;
      }
      recovering = true;
      const position = video.currentTime || resumeAt;
      video.pause();
      stopHls();
      onStatus("Obnovujem odkaz zo zdroja…");
      try {
        const fresh = await resolvePlayback(item);
        if (active()) await load(fresh, { autoplay, resumeAt: position, recovery: true });
      } catch (error) {
        if (active()) onStatus(`Obnovenie zdroja zlyhalo: ${error.message}. Skús Prehrať znova alebo otvor Zdroj.`);
      }
    };
    const tryPlay = async () => {
      if (!autoplay || !active()) return;
      try { await video.play(); }
      catch (error) {
        if (active() && error.name === "NotAllowedError") onStatus("Video je pripravené. Klikni na Prehrať.");
      }
    };
    onStatus("Načítavam video…");
    startupTimer = setTimeout(() => { if (active() && video.readyState < 2) void recover?.(); }, 25000);
    resumeListener = () => {
      if (!active()) return;
      if (resumeAt && Number.isFinite(video.duration)) video.currentTime = Math.min(resumeAt, Math.max(0, video.duration - .25));
    };
    video.addEventListener("loadedmetadata", resumeListener, { once: true });
    if (hlsSource && globalThis.Hls?.isSupported()) {
      hls = new Hls({ enableWorker: true });
      const activeHls = hls;
      let recoveredMedia = false;
      activeHls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => { if (!active() || hls !== activeHls) return; populateQuality(data.levels || []); void tryPlay(); });
      activeHls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => { if (active() && hls === activeHls) quality.value = String(data.level); });
      activeHls.on(Hls.Events.ERROR, (_event, data) => {
        if (!active() || !data.fatal || hls !== activeHls) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recoveredMedia) {
          recoveredMedia = true;
          activeHls.recoverMediaError();
          return;
        }
        void recover?.();
      });
      activeHls.attachMedia(video);
      activeHls.loadSource(source);
    } else {
      video.src = source;
      video.load();
      void tryPlay();
    }
    apply();
    updateTime();
  }
  function stop() { ++generation; recover = null; clearTimeout(startupTimer); if (resumeListener) video.removeEventListener("loadedmetadata", resumeListener); remember(); current = null; stopFx(); stopHls(); video.pause(); video.removeAttribute("src"); video.load(); onStatus(""); }
  function seekBy(seconds) { video.currentTime = clamp((video.currentTime || 0) + seconds, 0, Number.isFinite(video.duration) ? video.duration : Infinity); }

  function bind() {
    video.addEventListener("error", () => { if (current && video.getAttribute("src")) void recover?.(); });
    video.addEventListener("playing", () => { clearTimeout(startupTimer); onStatus(""); });
    video.addEventListener("canplay", () => { clearTimeout(startupTimer); onStatus(""); });
    for (const event of ["waiting", "stalled"]) video.addEventListener(event, () => {
      if (!current || video.paused) return;
      clearTimeout(startupTimer);
      const activeGeneration = generation;
      startupTimer = setTimeout(() => { if (activeGeneration === generation && !video.paused && video.readyState < 3) void recover?.(); }, 25000);
    });
    const controls = { rate:"player-rate", volume:"player-volume", zoom:"player-zoom", panX:"player-pan-x", panY:"player-pan-y", rotation:"player-rotation", brightness:"player-brightness", contrast:"player-contrast", saturation:"player-saturation", hue:"player-hue", blur:"player-blur", sharpness:"player-sharpness" };
    for (const [key, id] of Object.entries(controls)) byId(id).addEventListener(key === "rate" || key === "rotation" ? "change" : "input", (event) => { settings[key] = Number(event.target.value); if (key === "volume") settings.muted = false; apply(); persist(); });
    byId("player-loop").addEventListener("click", () => { settings.loop = !settings.loop; apply(); persist(); });
    byId("player-mute").addEventListener("click", () => { settings.muted = !settings.muted; apply(); persist(); });
    for (const id of ["player-fit", "player-mode"]) byId(id).addEventListener("click", () => { settings.fit = !settings.fit; apply(); persist(); });
    byId("player-ab").addEventListener("click", toggleAb);
    byId("player-fx").addEventListener("click", () => { if (fx) stopFx(); else startFx(); });
    byId("player-mirror").addEventListener("click", () => { settings.mirror = !settings.mirror; apply(); persist(); });
    byId("player-reset").addEventListener("click", () => { Object.assign(settings, { zoom:1, panX:0, panY:0, rotation:0, mirror:false }); apply(); persist(); badge("Výrez obnovený"); });
    document.querySelectorAll("[data-pan-preset]").forEach((button) => button.addEventListener("click", () => { const side = button.dataset.panPreset; settings.panX = side === "L" ? -35 : side === "R" ? 35 : 0; if (side === "C") settings.panY = 0; apply(); persist(); }));
    quality.addEventListener("change", () => { if (hls) hls.currentLevel = Number(quality.value); });
    byId("player-drawer-toggle").addEventListener("click", () => { const drawer = byId("player-drawer"); drawer.hidden = !drawer.hidden; byId("player-drawer-toggle").setAttribute("aria-expanded", String(!drawer.hidden)); });
    byId("player-expand").addEventListener("click", () => { stage.classList.toggle("is-expanded"); updateRadar(); });
    byId("player-toggle").addEventListener("click", async () => {
      if (current && video.paused && (video.error || video.readyState === 0)) {
        await load(current, { autoplay: true, resumeAt: video.currentTime });
      } else if (video.paused) {
        try { await video.play(); } catch (error) { onStatus(`Prehratie sa nepodarilo: ${error.message}`); }
      } else video.pause();
    });
    byId("player-download").addEventListener("click", async () => {
      if (!current) return;
      if (isHlsItem(current)) { badge("HLS stiahni cez zdroj"); return; }
      try {
        await onDownload(current);
        badge("Stiahnutie zaradené");
      } catch (error) {
        badge(error.message || "Stiahnutie zlyhalo");
      }
    });
    byId("history-clear").addEventListener("click", () => { history = []; renderHistory(); persist(); });
    byId("radar-map").addEventListener("click", (event) => { const r = event.currentTarget.getBoundingClientRect(); settings.panX = clamp(-((event.clientX - r.left) / r.width - .5) * 160, -100, 100); settings.panY = clamp(-((event.clientY - r.top) / r.height - .5) * 160, -100, 100); apply(); persist(); });
    seek.addEventListener("input", () => { video.currentTime = Number(seek.value); updateTime(); });
    video.addEventListener("timeupdate", () => { updateTime(); if (loopA !== null && loopB !== null && (video.currentTime >= loopB || video.currentTime < loopA - .25)) video.currentTime = loopA; if (Date.now() - lastSaved > 5000) { lastSaved = Date.now(); remember(); } });
    video.addEventListener("loadedmetadata", () => { updateTime(); updateRadar(); });
    video.addEventListener("play", () => { byId("player-toggle").textContent = "Pauza"; remember(); });
    video.addEventListener("pause", () => { byId("player-toggle").textContent = "Prehrať"; remember(); });
    video.addEventListener("ended", () => { remember(); if (!settings.loop && loopA === null) onStep(1, { wrap:false }); });
    stage.addEventListener("wheel", (event) => { if (!current || event.target.closest("button,input,.radar-map")) return; event.preventDefault(); settings.zoom = clamp(+(settings.zoom + (event.deltaY < 0 ? .15 : -.15)).toFixed(2), 1, 4); if (settings.zoom === 1 && settings.fit) settings.panX = settings.panY = 0; apply(); persist(); badge(`${settings.zoom.toFixed(1)}×`); }, { passive:false });
    stage.addEventListener("pointerdown", (event) => { if (!current || event.button !== 0 || event.target.closest("button,input,.radar-map,.stage-hud")) return; dragging = { x:event.clientX, y:event.clientY, panX:settings.panX, panY:settings.panY }; stage.classList.add("is-dragging"); stage.setPointerCapture(event.pointerId); });
    stage.addEventListener("pointermove", (event) => { if (!dragging) return; const rect = stage.getBoundingClientRect(); const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9; const w = settings.fit ? rect.width : rect.height * aspect; const h = settings.fit ? rect.width / aspect : rect.height; settings.panX = clamp(dragging.panX + (event.clientX - dragging.x) / (w * settings.zoom) * 100 * (settings.mirror ? -1 : 1), -100, 100); settings.panY = clamp(dragging.panY + (event.clientY - dragging.y) / (h * settings.zoom) * 100, -100, 100); apply(); });
    for (const name of ["pointerup", "pointercancel"]) stage.addEventListener(name, (event) => { if (!dragging) return; dragging = null; stage.classList.remove("is-dragging"); if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId); persist(); });
    stage.addEventListener("dblclick", (event) => { if (event.target.closest("button,input,.radar-map")) return; settings.zoom = 1; settings.panX = settings.panY = 0; apply(); persist(); badge("1.0×"); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && stage.classList.contains("is-expanded")) { stage.classList.remove("is-expanded"); return; } if (byId("pane-play").hidden || event.target.closest("input,textarea,select,button")) return; if (event.code === "Space") { event.preventDefault(); byId("player-toggle").click(); } else if (event.key.toLowerCase() === "j") onStep(-1); else if (event.key.toLowerCase() === "l") onStep(1); else if (event.key.toLowerCase() === "a") byId("pane-play").querySelector('[data-pan-preset="L"]').click(); else if (event.key.toLowerCase() === "s") byId("pane-play").querySelector('[data-pan-preset="C"]').click(); else if (event.key.toLowerCase() === "d") byId("pane-play").querySelector('[data-pan-preset="R"]').click(); else if (event.key === "ArrowLeft") seekBy(event.shiftKey ? -30 : -5); else if (event.key === "ArrowRight") seekBy(event.shiftKey ? 30 : 5); else if (event.key === "Home") video.currentTime = 0; else if (event.key === "End" && Number.isFinite(video.duration)) video.currentTime = video.duration; });
    window.addEventListener("pagehide", remember);
  }

  bind();
  read().then((stored) => { settings = { ...DEFAULTS, ...(stored.settings || {}) }; history = Array.isArray(stored.history) ? stored.history.slice(0, 120) : []; apply(); renderHistory(); });
  apply();
  return { load, stop, get current() { return current; }, remember };
}
