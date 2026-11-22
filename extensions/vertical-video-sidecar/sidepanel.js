const $ = (s) => document.querySelector(s);
const player = $("#player"), canvas = $("#fxCanvas"), stage = $("#stage"), list = $("#queue"), historyList = $("#history");
const HISTORY_LIMIT = 120;
let queue = [], history = [], activeId = null, hls = null, dragId = null, fxOn = false, gl = null, fxState = null, fxFrame = 0, pendingResumeAt = 0, playbackHistoryKey = null, libraryStatuses = new Map(), libraryPort = null;
let loopA = null, loopB = null, availableLevels = [];
let isDragging = false, dragStartX = 0, dragStartY = 0, startPanX = 0, startPanY = 0, badgeTimer = 0;
const settings = { rate: 1, volume: .8, loop: false, muted: false, fit: true, zoom: 1, panX: 0, panY: 0, rotation: 0, mirror: false, brightness: 1, contrast: 1, saturation: 1, hue: 0, blur: 0, sharpness: .25 };

async function load() {
  const saved = await chrome.storage.local.get({ queue: [], history: [], activeId: null, settings });
  queue = saved.queue;
  history = Array.isArray(saved.history) ? saved.history.slice(0, HISTORY_LIMIT) : [];
  activeId = saved.activeId || queue[0]?.id || null;
  Object.assign(settings, saved.settings || {});
  applySettings();
  render();
  // Also unload a previously playing item when another extension context clears
  // the queue or active item.
  await loadActive();
  refreshLibraryStatuses();
  const session = await chrome.storage.session.get("sidecarNotice");
  if (session.sidecarNotice) {
    showNotice(session.sidecarNotice);
    await chrome.storage.session.remove("sidecarNotice");
  }
}
// Playback settings/history must never overwrite a queue changed by another tab.
function persist() { return chrome.storage.local.set({ history, settings }); }
let pendingQueueChanges = 0;
async function editQueue(operation) {
  pendingQueueChanges++;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'CHANGE_QUEUE', operation });
    if (!result?.ok) throw new Error(result?.error || 'Queue change was not confirmed.');
    const saved = await chrome.storage.local.get({ queue: [], activeId: null });
    queue = saved.queue;
    activeId = saved.activeId;
    render();
    return true;
  } catch (error) {
    showNotice(error.message || 'Queue change failed.');
    return false;
  } finally {
    pendingQueueChanges--;
  }
}
function current() { return queue.find((item) => item.id === activeId); }
function format(seconds) { return Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2,"0")}` : "0:00"; }
function showNotice(text) { const el = $("#notice"); el.textContent = text; el.hidden = false; }

function mediaErrorMessage() {
  const error = player.error;
  const item = current();
  if (item?.captureHint) return item.captureHint;
  if (!error) return "Playback stopped before the browser reported a media error. Check the stream URL and try again.";
  const url = String(item?.url || "");
  if (/^blob:/i.test(url)) return "This is a page-only blob stream. Capture the direct video URL from the source tab and add it again.";
  if (error.code === MediaError.MEDIA_ERR_ABORTED) return "Playback was cancelled while the stream was loading. Press Play to retry.";
  if (error.code === MediaError.MEDIA_ERR_NETWORK) return "The stream connection failed. It may need a fresh signed URL, source-site cookies, or a permitted referrer.";
  if (error.code === MediaError.MEDIA_ERR_DECODE) return "Chrome received the stream but could not decode it. The codec or container may be unsupported or the stream may be damaged.";
  if (error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
    if (/\.m3u8(?:$|[?#])/i.test(url)) return "This HLS stream could not be opened. It may need source-site headers or an expired signed link; try refreshing the source page and recapturing it.";
    return "Chrome cannot play this format or the server rejected the request. Check the direct URL, source-site access, and required headers.";
  }
  return `Playback failed (media error ${error.code}). Check the stream URL, access headers, and codec support.`;
}

function showZoomBadge(text) {
  const badge = $("#zoomBadge");
  if (!badge) return;
  badge.textContent = text;
  badge.hidden = false;
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => { badge.hidden = true; }, 1000);
}

function updateRadar() {
  const radar = $("#radarMap");
  const box = $("#radarBox");
  if (!radar || !box) return;
  const needsRadar = stage.classList.contains("has-video") && (!settings.fit || settings.zoom > 1.05);
  radar.hidden = !needsRadar;
  if (!needsRadar) return;

  const radarW = 80;
  const radarH = 45; // pomer 16:9
  const aspect = (player.videoWidth && player.videoHeight) ? (player.videoWidth / player.videoHeight) : (16 / 9);
  const containerAspect = 9 / 16;
  const visibleFractionW = Math.min(1, Math.max(0.12, (containerAspect / aspect) / settings.zoom));
  const visibleFractionH = Math.min(1, Math.max(0.12, 1 / settings.zoom));

  const boxW = Math.max(10, Math.round(radarW * visibleFractionW));
  const boxH = Math.max(10, Math.round(radarH * visibleFractionH));

  const centerX = (radarW / 2) - (settings.panX / 100) * (radarW / 2);
  const centerY = (radarH / 2) - (settings.panY / 100) * (radarH / 2);

  const left = Math.max(0, Math.min(radarW - boxW, Math.round(centerX - (boxW / 2))));
  const top = Math.max(0, Math.min(radarH - boxH, Math.round(centerY - (boxH / 2))));

  box.style.width = `${boxW}px`;
  box.style.height = `${boxH}px`;
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
}

function applySettings() {
  player.playbackRate = settings.rate;
  player.volume = settings.volume;
  player.loop = settings.loop;
  player.muted = settings.muted;
  stage.classList.toggle("fill", !settings.fit);
  $("#mode").textContent = settings.fit ? "FIT" : "FILL";
  $("#fit").textContent = settings.fit ? "Fit" : "Fill";
  $("#cinemaFit").textContent = settings.fit ? "Fill" : "Fit";

  const transform = `scale(${settings.zoom}) translate(${settings.panX}%,${settings.panY}%) rotate(${settings.rotation}deg) scaleX(${settings.mirror ? -1 : 1})`;
  const filter = `brightness(${settings.brightness}) contrast(${settings.contrast}) saturate(${settings.saturation}) hue-rotate(${settings.hue}deg) blur(${settings.blur}px)`;
  player.style.transform = canvas.style.transform = transform;
  player.style.filter = canvas.style.filter = filter;

  for (const key of ["rate","volume","zoom","panX","panY","rotation","brightness","contrast","saturation","hue","blur","sharpness"]) {
    const el = $("#" + key);
    if (el) el.value = settings[key];
  }
  $("#loop").setAttribute("aria-pressed", settings.loop);
  $("#mute").setAttribute("aria-pressed", settings.muted);
  $("#mute").textContent = settings.muted ? "Sound" : "Mute";
  $("#mirror").setAttribute("aria-pressed", settings.mirror);

  updateRadar();
}

function populateQualitySelector(levels = []) {
  availableLevels = levels;
  const selects = [$("#qualitySelect"), $("#cinemaQuality")].filter(Boolean);
  selects.forEach((sel) => {
    sel.innerHTML = '<option value="-1">Auto</option>';
    levels.forEach((lvl, idx) => {
      const opt = document.createElement("option");
      opt.value = String(idx);
      opt.textContent = lvl.height ? `${lvl.height}p` : `Level ${idx + 1}`;
      sel.appendChild(opt);
    });
    if (hls && typeof hls.currentLevel === "number") {
      sel.value = String(hls.currentLevel);
    }
  });
}

function onQualityChange(value) {
  const lvl = Number(value);
  if (hls) {
    hls.currentLevel = lvl;
    const label = lvl === -1 ? "Auto" : `${hls.levels?.[lvl]?.height || lvl}p`;
    showZoomBadge(`Kvalita: ${label}`);
  } else {
    const item = current();
    if (item?.url && lvl > 0) {
      const curTime = player.currentTime;
      const nextUrl = item.url.replace(/(?:^|[\/_.-])(2160|1440|1080|720|480)(?:p)?(?:[\/_.-]|$)/i, (m) => m.replace(/\d{3,4}/, String(lvl)));
      if (nextUrl !== item.url) {
        item.url = nextUrl;
        player.src = nextUrl;
        player.currentTime = curTime;
        player.play().catch(() => {});
        showZoomBadge(`Kvalita: ${lvl}p`);
      }
    }
  }
  const selects = [$("#qualitySelect"), $("#cinemaQuality")].filter(Boolean);
  selects.forEach((s) => { s.value = String(lvl); });
}

function setPanPreset(side) {
  if (side === "L") {
    settings.panX = -35;
    showZoomBadge("◂ Pohľad vľavo");
  } else if (side === "R") {
    settings.panX = 35;
    showZoomBadge("Pohľad vpravo ▸");
  } else {
    settings.panX = 0;
    settings.panY = 0;
    showZoomBadge("● Stred");
  }
  applySettings();
  persist();
}

function updateLoopABButtons() {
  let text = "A-B: Off";
  let active = false;
  if (loopA !== null && loopB !== null) {
    text = `${format(loopA)}-${format(loopB)} 🔁`;
    active = true;
  } else if (loopA !== null) {
    text = `A: ${format(loopA)}…`;
    active = true;
  }
  const b1 = $("#loopAB"), b2 = $("#cinemaLoopAB");
  if (b1) { b1.textContent = text; b1.classList.toggle("active", active); }
  if (b2) { b2.textContent = active ? (loopB !== null ? "A-B 🔁" : "A…") : "A-B"; b2.classList.toggle("active", active); }
}

function toggleLoopAB() {
  const cur = player.currentTime || 0;
  if (loopA === null) {
    loopA = cur;
    loopB = null;
    showZoomBadge(`A: ${format(loopA)}`);
  } else if (loopB === null) {
    if (cur > loopA) { loopB = cur; } else { loopB = loopA; loopA = cur; }
    showZoomBadge(`Slučka: ${format(loopA)} - ${format(loopB)}`);
  } else {
    loopA = null;
    loopB = null;
    showZoomBadge("A-B slučka vypnutá");
  }
  updateLoopABButtons();
}

async function loadActive(resumeAt = 0) {
  const item = current();
  pendingResumeAt = Math.max(0, Number(resumeAt) || 0);
  playbackHistoryKey = null;
  loopA = null;
  loopB = null;
  updateLoopABButtons();
  populateQualitySelector([]);
  stopHls();
  stopFx();
  player.pause();
  player.removeAttribute("src");
  player.load();
  $("#notice").hidden = true;
  if (!item) {
    stage.classList.remove("has-video");
    render();
    return;
  }
  if (item.captureHint) showNotice(item.captureHint);
  stage.classList.add("has-video");
  const prepared = await chrome.runtime.sendMessage({ type: "PREPARE_MEDIA", item }).catch((error) => ({ ok: false, error: error.message }));
  if (!prepared?.ok) showNotice(`Playback preparation warning: ${prepared?.error || "request headers could not be prepared"}`);
  if (item.typeHint === "hls" || /\.m3u8(?:$|[?#])/i.test(item.url)) {
    await loadHls(item.url);
  } else {
    player.src = item.url;
    player.load();
    const qMatch = item.url.match(/(?:^|[\/_.-])(2160|1440|1080|720|480)(?:p)?(?:[\/_.-]|$)/i);
    if (qMatch) {
      populateQualitySelector([
        { height: 2160 }, { height: 1440 }, { height: 1080 }, { height: 720 }, { height: 480 }
      ]);
      const currentH = parseInt(qMatch[1], 10);
      const idx = [2160, 1440, 1080, 720, 480].indexOf(currentH);
      const selects = [$("#qualitySelect"), $("#cinemaQuality")].filter(Boolean);
      selects.forEach((s) => { s.value = idx >= 0 ? String(idx) : "-1"; });
    }
  }
  render();
}

async function loadHls(url) {
  if (player.canPlayType("application/vnd.apple.mpegurl")) {
    player.src = url;
    player.load();
    return;
  }
  if (window.Hls?.isSupported()) {
    hls = new window.Hls({ enableWorker: true });
    hls.loadSource(url);
    hls.attachMedia(player);
    hls.on(window.Hls.Events.MANIFEST_PARSED, (_event, data) => {
      populateQualitySelector(data.levels || []);
    });
    hls.on(window.Hls.Events.LEVEL_SWITCHED, (_event, data) => {
      const lvl = data.level;
      const selects = [$("#qualitySelect"), $("#cinemaQuality")].filter(Boolean);
      selects.forEach((s) => { s.value = String(lvl); });
    });
    return;
  }
  showNotice("HLS needs the bundled hls.js player. Run the one-time npm build step from the README, then reload this extension.");
}

function stopHls() { hls?.destroy(); hls = null; }
function itemLibraryStatus(item) { return libraryStatuses.get(item.url) || libraryStatuses.get(item.sourceUrl) || libraryStatuses.get(item.pageUrl) || null; }
function statusBadges(item) { const status = itemLibraryStatus(item); if (!status?.in_dashboard) return ""; return `<span class="badge nexus">NEXUS</span>${status.on_disk ? '<span class="badge disk">DISK</span>' : ""}`; }

function render() {
  $("#count").textContent = queue.length;
  list.replaceChildren(...queue.map((item) => {
    const card = document.createElement("li");
    card.className = `card${item.id === activeId ? " active" : ""}`;
    card.draggable = true;
    card.dataset.id = item.id;
    let host = "video";
    try { host = new URL(item.pageUrl || item.url).hostname.replace(/^www\./, ""); } catch {}
    card.innerHTML = `<span class="handle" aria-hidden="true">⠿</span><div class="title">${escapeHtml(item.title)}<span class="source">${escapeHtml(host)}</span>${statusBadges(item)}</div><div class="card-actions"><button data-action="play" title="Play now" aria-label="Play ${escapeHtml(item.title)}">▶</button><button data-action="download" title="Download direct media" aria-label="Download ${escapeHtml(item.title)}">⇩</button><button data-action="remove" title="Remove from queue" aria-label="Remove ${escapeHtml(item.title)}">×</button></div>`;
    card.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      playItem(item.id);
    });
    card.querySelector('[data-action="play"]').addEventListener("click", (event) => { event.stopPropagation(); playItem(item.id); });
    card.querySelector('[data-action="download"]').addEventListener("click", (event) => { event.stopPropagation(); downloadItem(item); });
    card.querySelector('[data-action="remove"]').addEventListener("click", (event) => { event.stopPropagation(); remove(item.id); });
    card.addEventListener("dragstart", () => { dragId = item.id; card.classList.add("dragging"); });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    card.addEventListener("dragover", (event) => event.preventDefault());
    card.addEventListener("drop", (event) => { event.preventDefault(); reorder(dragId, item.id); });
    return card;
  }));
  renderHistory();
}

function historyKey(item) { return item?.pageUrl || item?.sourceUrl || item?.url || ""; }
function historyTime(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : ""; }
function recordPlayback() {
  const item = current();
  const key = historyKey(item);
  if (!item || !key || playbackHistoryKey === key) return;
  playbackHistoryKey = key;
  const entry = { key, item: { ...item }, playedAt: Date.now(), position: player.currentTime || 0, duration: Number.isFinite(player.duration) ? player.duration : 0 };
  history = [entry, ...history.filter((x) => x.key !== key)].slice(0, HISTORY_LIMIT);
  persist();
  renderHistory();
}
function saveHistoryProgress() {
  const key = playbackHistoryKey || historyKey(current());
  const entry = history.find((x) => x.key === key);
  if (!entry) return;
  entry.position = player.currentTime || 0;
  entry.duration = Number.isFinite(player.duration) ? player.duration : entry.duration || 0;
  entry.playedAt = Date.now();
  persist();
}
async function playHistory(key) {
  const entry = history.find((x) => x.key === key);
  if (!entry?.item) return;
  if (!(await editQueue({ kind: 'restore', item: entry.item }))) return;
  await loadActive(entry.position);
  player.play().catch(() => showNotice("Press Play to continue this video."));
}
function renderHistory() {
  $("#historyCount").textContent = history.length;
  if (!history.length) {
    historyList.innerHTML = '<li class="empty-history">Nothing played yet.</li>';
    return;
  }
  historyList.replaceChildren(...history.map((entry) => {
    const item = entry.item || {};
    const card = document.createElement("li");
    card.className = "card";
    let host = "video";
    try { host = new URL(item.pageUrl || item.url).hostname.replace(/^www\./, ""); } catch {}
    const progress = entry.duration ? `${format(entry.position)} / ${format(entry.duration)}` : format(entry.position);
    card.innerHTML = `<div class="title">${escapeHtml(item.title || "Untitled video")}<span class="source">${escapeHtml(host)} · ${escapeHtml(progress)} · ${escapeHtml(historyTime(entry.playedAt))}</span></div><button title="Play again" aria-label="Play ${escapeHtml(item.title || "video")} again">▶</button>`;
    card.addEventListener("click", () => playHistory(entry.key));
    card.querySelector("button").addEventListener("click", (event) => { event.stopPropagation(); playHistory(entry.key); });
    return card;
  }));
}
function escapeHtml(value = "") { const div = document.createElement("div"); div.textContent = value; return div.innerHTML; }
async function reorder(from, to) {
  if (!from || from === to) return;
  await editQueue({ kind: 'reorder', from, to });
}
async function remove(id) {
  const wasActive = id === activeId;
  if (await editQueue({ kind: 'remove', ids: [id] })) {
    if (wasActive) loadActive();
  }
}
async function move(delta) {
  const index = queue.findIndex((item) => item.id === activeId);
  if (index < 0 || !queue[index + delta]) return;
  if (await editQueue({ kind: 'activate', id: queue[index + delta].id })) loadActive();
}

async function playItem(id) {
  if (!id) return;
  if (!(await editQueue({ kind: 'activate', id }))) return;
  await loadActive();
  player.play().catch(() => showNotice("Press Play to continue this video."));
}
function downloadItem(item) {
  const title = String(item?.title || "sidecar-video").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120) || "sidecar-video";
  const extension = String(item?.url || "").match(/\.(mp4|webm|mkv|mov|m4v|m3u8)(?:[?#]|$)/i)?.[1] || "mp4";
  chrome.downloads.download({ url: item.url, filename: `${title}.${extension}`, saveAs: false }).catch((error) => showNotice(`Download failed: ${error?.message || error}`));
}
function downloadWithIdm(item) {
  if (!/^https?:/i.test(String(item?.url || ""))) {
    showNotice("No direct media link is available for IDM.");
    return;
  }
  const title = String(item?.title || "sidecar-video").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120) || "sidecar-video";
  const extension = String(item.url).match(/\.(mp4|webm|mkv|mov|m4v|m3u8)(?:[?#]|$)/i)?.[1] || "mp4";
  chrome.downloads.download({ url: item.url, filename: `${title}.${extension}`, conflictAction: "uniquify", saveAs: false }).then(() => showNotice("Download request accepted by Chrome. Check Chrome or IDM for progress.")).catch((error) => showNotice(`Download request failed: ${error?.message || error}`));
}
async function refreshLibraryStatuses() {
  const urls = [...new Set(queue.flatMap((item) => [item.url, item.sourceUrl, item.pageUrl]).filter((url) => /^https?:/i.test(String(url || ""))))].slice(0, 500);
  const label = $("#libraryState");
  if (!urls.length) {
    libraryStatuses = new Map();
    libraryPort = null;
    if (label) label.textContent = "Nexus: no queue";
    return;
  }
  if (label) label.textContent = "Nexus: checking…";
  for (const port of [8001, 8000, 8002]) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/videos/library-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls })
      });
      if (!response.ok) continue;
      const data = await response.json();
      libraryStatuses = new Map(Object.entries(data?.matches || {}));
      libraryPort = port;
      if (label) label.textContent = `Nexus :${port}`;
      render();
      return;
    } catch {}
  }
  libraryStatuses = new Map();
  libraryPort = null;
  if (label) label.textContent = "Nexus: offline";
  render();
}

$("#play").onclick = () => player.paused ? player.play().catch(() => showNotice("This host did not allow the video to play in the dock.")) : player.pause();
$("#previous").onclick = () => move(-1);
$("#next").onclick = () => move(1);
$("#downloadIdm").onclick = () => downloadWithIdm(current());
$("#remove").onclick = () => activeId && remove(activeId);
$("#clear").onclick = async () => {
  // Remove only the items shown when clicked; preserve concurrent additions.
  if (await editQueue({ kind: 'remove', ids: queue.map(item => item.id) })) loadActive();
};
$("#clearHistory").onclick = () => { history = []; playbackHistoryKey = null; persist(); renderHistory(); };

function toggleCinema(force) { document.body.classList.toggle("cinema", force ?? !document.body.classList.contains("cinema")); }
$("#cinema").onclick = () => toggleCinema(true);
$("#cinemaExit").onclick = () => toggleCinema(false);
$("#cinemaPrevious").onclick = () => move(-1);
$("#cinemaPlay").onclick = () => $("#play").click();
$("#cinemaFit").onclick = () => $("#fit").click();

$("#rate").onchange = (e) => { settings.rate = Number(e.target.value); applySettings(); persist(); };
$("#volume").oninput = (e) => { settings.volume = Number(e.target.value); settings.muted = false; applySettings(); persist(); };
$("#loop").onclick = () => { settings.loop = !settings.loop; applySettings(); persist(); };
$("#mute").onclick = () => { settings.muted = !settings.muted; applySettings(); persist(); };
$("#fit").onclick = () => { settings.fit = !settings.fit; applySettings(); persist(); };

for (const key of ["zoom","panX","panY","rotation","brightness","contrast","saturation","hue","blur","sharpness"]) {
  const el = $("#" + key);
  if (el) el.oninput = (e) => { settings[key] = Number(e.target.value); applySettings(); persist(); };
}
$("#mirror").onclick = () => { settings.mirror = !settings.mirror; applySettings(); persist(); };
$("#resetScan").onclick = () => { Object.assign(settings, { zoom: 1, panX: 0, panY: 0, rotation: 0, mirror: false }); applySettings(); persist(); showZoomBadge("Reset 1.0×"); };

$("#qualitySelect")?.addEventListener("change", (e) => onQualityChange(e.target.value));
$("#cinemaQuality")?.addEventListener("change", (e) => onQualityChange(e.target.value));

$("#presetL")?.addEventListener("click", () => setPanPreset("L"));
$("#presetC")?.addEventListener("click", () => setPanPreset("C"));
$("#presetR")?.addEventListener("click", () => setPanPreset("R"));
$("#cinemaPresetL")?.addEventListener("click", () => setPanPreset("L"));
$("#cinemaPresetC")?.addEventListener("click", () => setPanPreset("C"));
$("#cinemaPresetR")?.addEventListener("click", () => setPanPreset("R"));

$("#loopAB")?.addEventListener("click", toggleLoopAB);
$("#cinemaLoopAB")?.addEventListener("click", toggleLoopAB);

$("#radarMap")?.addEventListener("click", (e) => {
  const r = $("#radarMap").getBoundingClientRect();
  const clickX = e.clientX - r.left;
  const clickY = e.clientY - r.top;
  const normX = (clickX / r.width) - 0.5;
  const normY = (clickY / r.height) - 0.5;
  settings.panX = Math.min(100, Math.max(-100, +(-normX * 160).toFixed(1)));
  settings.panY = Math.min(100, Math.max(-100, +(-normY * 160).toFixed(1)));
  applySettings();
  persist();
});

// ── Interaktívne gestá na videu (Zoom kolieskom + Drag & Pan + Dvojklik) ──
stage.addEventListener("wheel", (e) => {
  e.preventDefault();
  const delta = e.deltaY < 0 ? 0.15 : -0.15;
  const nextZoom = Math.min(4, Math.max(1, +(settings.zoom + delta).toFixed(2)));
  if (nextZoom === settings.zoom) return;
  settings.zoom = nextZoom;
  if (settings.zoom === 1 && settings.fit) {
    settings.panX = 0;
    settings.panY = 0;
  }
  applySettings();
  persist();
  showZoomBadge(`${settings.zoom.toFixed(1)}×`);
}, { passive: false });

stage.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  if (e.target.closest("button, input, select, a, #cinemaTools, #seekWrap, .radar-map")) return;
  isDragging = true;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  startPanX = settings.panX;
  startPanY = settings.panY;
  stage.classList.add("is-dragging");
  try { stage.setPointerCapture(e.pointerId); } catch {}
});

stage.addEventListener("pointermove", (e) => {
  if (!isDragging) return;
  const dx = e.clientX - dragStartX;
  const dy = e.clientY - dragStartY;
  const rect = stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const aspect = (player.videoWidth && player.videoHeight) ? (player.videoWidth / player.videoHeight) : (16 / 9);
  const videoW = settings.fit ? rect.width : (rect.height * aspect);
  const videoH = settings.fit ? (rect.width / aspect) : rect.height;

  const factorX = (dx / (videoW * settings.zoom)) * 100;
  const factorY = (dy / (videoH * settings.zoom)) * 100;

  const mx = settings.mirror ? -factorX : factorX;
  settings.panX = Math.min(100, Math.max(-100, +(startPanX + mx).toFixed(1)));
  settings.panY = Math.min(100, Math.max(-100, +(startPanY + factorY).toFixed(1)));
  applySettings();
});

const stopDrag = (e) => {
  if (!isDragging) return;
  isDragging = false;
  stage.classList.remove("is-dragging");
  try { stage.releasePointerCapture(e.pointerId); } catch {}
  persist();
};
stage.addEventListener("pointerup", stopDrag);
stage.addEventListener("pointercancel", stopDrag);

stage.addEventListener("dblclick", (e) => {
  if (e.target.closest("button, input, select, a, #cinemaTools, #seekWrap, .radar-map")) return;
  settings.zoom = 1;
  settings.panX = 0;
  settings.panY = 0;
  applySettings();
  persist();
  showZoomBadge("Reset 1.0×");
});

const seek = $("#seek");
let seeking = false;
function syncSeek() {
  const duration = Number.isFinite(player.duration) ? player.duration : 0;
  seek.max = duration;
  if (!seeking) seek.value = Math.min(player.currentTime || 0, duration);
  $("#time").textContent = `${format(player.currentTime)} / ${format(player.duration)}`;
}
function seekBy(seconds) {
  const end = Number.isFinite(player.duration) ? player.duration : Infinity;
  player.currentTime = Math.max(0, Math.min(end, player.currentTime + seconds));
}
seek.addEventListener("pointerdown", () => seeking = true);
seek.addEventListener("input", () => { player.currentTime = Number(seek.value); syncSeek(); });
seek.addEventListener("change", () => { seeking = false; syncSeek(); });
seek.addEventListener("pointerup", () => { seeking = false; syncSeek(); });

player.addEventListener("play", () => { recordPlayback(); $("#play").textContent = "Pause"; $("#cinemaPlay").textContent = "Pause"; });
player.addEventListener("pause", () => { saveHistoryProgress(); $("#play").textContent = "Play"; $("#cinemaPlay").textContent = "Play"; });
player.addEventListener("timeupdate", () => {
  syncSeek();
  if (loopA !== null && loopB !== null) {
    if (player.currentTime >= loopB || player.currentTime < loopA - 0.25) {
      player.currentTime = loopA;
    }
  }
});
player.addEventListener("durationchange", syncSeek);
player.addEventListener("loadedmetadata", () => {
  if (pendingResumeAt && Number.isFinite(player.duration)) player.currentTime = Math.min(pendingResumeAt, Math.max(0, player.duration - .25));
  pendingResumeAt = 0;
  syncSeek();
  updateRadar();
});
player.addEventListener("ended", () => { saveHistoryProgress(); if (!settings.loop) move(1); });
player.addEventListener("error", () => showNotice(mediaErrorMessage()));
window.addEventListener("pagehide", saveHistoryProgress);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("cinema")) { toggleCinema(false); return; }
  if (event.target.matches("input,select,button,textarea")) return;
  if (event.code === "Space") { event.preventDefault(); $("#play").click(); }
  if (event.key.toLowerCase() === "j") move(-1);
  if (event.key.toLowerCase() === "l") move(1);
  if (event.key.toLowerCase() === "a") setPanPreset("L");
  if (event.key.toLowerCase() === "s") setPanPreset("C");
  if (event.key.toLowerCase() === "d") setPanPreset("R");
  if (event.key === "ArrowLeft") seekBy(event.shiftKey ? -30 : -5);
  if (event.key === "ArrowRight") seekBy(event.shiftKey ? 30 : 5);
  if (event.key === "Home") player.currentTime = 0;
  if (event.key === "End" && Number.isFinite(player.duration)) player.currentTime = player.duration;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || (!changes.queue && !changes.activeId)) return;
  if (pendingQueueChanges) return; // editQueue reads the committed state itself.
  const nextQueue = changes.queue?.newValue;
  const nextActiveId = changes.activeId ? changes.activeId.newValue : activeId;
  if (nextActiveId !== activeId) { load(); return; }
  if (Array.isArray(nextQueue)) { queue = nextQueue; render(); refreshLibraryStatuses(); }
});

$("#filter").onclick = () => fxOn ? stopFx() : startFx();
function shader(type, source) {
  const unit = gl.createShader(type);
  gl.shaderSource(unit, source);
  gl.compileShader(unit);
  if (!gl.getShaderParameter(unit, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(unit));
  return unit;
}
function startFx() {
  try {
    gl = canvas.getContext("webgl", { premultipliedAlpha: false });
    if (!gl) throw Error("No WebGL");
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, `attribute vec2 p;attribute vec2 uv;varying vec2 v;void main(){gl_Position=vec4(p,0.,1.);v=uv;}`));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `precision mediump float;varying vec2 v;uniform sampler2D t;uniform vec2 px;uniform float sharp;void main(){vec4 c=texture2D(t,v);vec4 n=texture2D(t,v+vec2(0.,px.y));vec4 s=texture2D(t,v-vec2(0.,px.y));vec4 e=texture2D(t,v+vec2(px.x,0.));vec4 w=texture2D(t,v-vec2(px.x,0.));gl_FragColor=c*(1.+4.*sharp)-sharp*(n+s+e+w);}`));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getShaderInfoLog(program));
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,0,0,1,-1,1,0,-1,1,0,1,1,1,1,1]), gl.STATIC_DRAW);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    for (const key of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, key, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    fxState = { program, buffer, texture, p: gl.getAttribLocation(program,"p"), uv: gl.getAttribLocation(program,"uv"), px: gl.getUniformLocation(program,"px"), sharp: gl.getUniformLocation(program,"sharp") };
    canvas.hidden = false;
    player.style.visibility = "hidden";
    fxOn = true;
    $("#filter").setAttribute("aria-pressed", "true");
    renderFx();
  } catch {
    stopFx();
    showNotice("WebGL filters are unavailable in this browser.");
  }
}
function stopFx() {
  cancelAnimationFrame(fxFrame);
  fxOn = false;
  canvas.hidden = true;
  player.style.visibility = "visible";
  $("#filter").setAttribute("aria-pressed", "false");
  gl = null;
  fxState = null;
}
function renderFx() {
  if (!fxOn || !gl || !fxState) return;
  if (!player.videoWidth || !player.videoHeight) {
    fxFrame = requestAnimationFrame(renderFx);
    return;
  }
  try {
    if (canvas.width !== player.videoWidth || canvas.height !== player.videoHeight) {
      canvas.width = player.videoWidth;
      canvas.height = player.videoHeight;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(fxState.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, fxState.buffer);
    gl.enableVertexAttribArray(fxState.p);
    gl.vertexAttribPointer(fxState.p, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(fxState.uv);
    gl.vertexAttribPointer(fxState.uv, 2, gl.FLOAT, false, 16, 8);
    gl.bindTexture(gl.TEXTURE_2D, fxState.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, player);
    gl.uniform2f(fxState.px, 1 / canvas.width, 1 / canvas.height);
    gl.uniform1f(fxState.sharp, settings.sharpness);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  } catch {
    stopFx();
    showNotice("This media has no CORS permission for WebGL enhancement. Normal playback and CSS controls still work.");
    return;
  }
  fxFrame = requestAnimationFrame(renderFx);
}

load();
