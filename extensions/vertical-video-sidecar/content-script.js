let lastVideo = null;
let backgroundAvailable = true;

function extensionInvalidated(error) {
  return /extension context invalidated|context might have missed important events/i.test(String(error || ""));
}

function sendToBackground(message, callback) {
  if (!backgroundAvailable) {
    callback({ ok: false, error: "Extension was reloaded. Refresh this page." });
    return;
  }
  let runtime;
  try {
    runtime = chrome.runtime;
    if (!runtime?.id || typeof runtime.sendMessage !== "function") throw new Error("Extension context invalidated.");
    runtime.sendMessage(message, (result) => {
      let error = "";
      try { error = runtime.lastError?.message || ""; } catch (_) {}
      if (extensionInvalidated(error)) backgroundAvailable = false;
      callback(result || (error ? { ok: false, error } : { ok: false, error: "No background response." }));
    });
  } catch (error) {
    if (extensionInvalidated(error?.message)) backgroundAvailable = false;
    callback({ ok: false, error: error?.message || String(error) });
  }
}

document.addEventListener("contextmenu", (event) => {
  const video = event.composedPath().find((node) => node instanceof HTMLVideoElement);
  if (video) rememberVideo(video);
}, true);

document.addEventListener("pointerdown", (event) => {
  const video = event.composedPath().find((node) => node instanceof HTMLVideoElement);
  if (video) rememberVideo(video);
}, true);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_LAST_VIDEO") {
    lastCandidate().then(sendResponse, () => sendResponse(lastVideo || firstVideo()));
    return true;
  }
  if (message.type === "GET_PAGE_VIDEOS") {
    pageCandidates().then(sendResponse, () => sendResponse([]));
    return true;
  }
  if (message.type === "SHOW_DOCK" && window.top === window) mountDock();
  if (message.type === "HIDE_DOCK" && window.top === window) {
    document.querySelectorAll("#vertical-video-sidecar-host").forEach(node => node.remove());
  }
});

// Same-page bridge for Nexus helpers.  It avoids a brittle hard-coded Chrome
// extension ID when Sidecar is loaded unpacked from a different folder.
window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const message = event.data;
  if (!message || message.type !== "NEXUS_SIDECAR_ENQUEUE") return;
  const requestId = String(message.requestId || "");
  const items = Array.isArray(message.items) ? message.items : [];
  sendToBackground({ type: "ADD_MANY", items, playNow: !!message.playNow }, (result) => {
    window.postMessage({ type: "NEXUS_SIDECAR_RESULT", requestId, result }, window.location.origin);
  });
}, false);

const DOCK_WIDTH_KEY = "dockWidth";
const DOCK_WIDTH_DEFAULT = 390;
const DOCK_WIDTH_MIN = 280;
const DOCK_WIDTH_MAX = 900;

function clampDockWidth(width) {
  return Math.min(DOCK_WIDTH_MAX, Math.max(DOCK_WIDTH_MIN, Math.round(width)));
}

function mountDock() {
  // A page can accumulate more than one host: an older content-script
  // generation's host survives an extension reload (only navigation removes
  // page DOM), and would otherwise keep showing its stale baked-in CSS
  // (e.g. an old left-docked layout) side by side with a fresh one. Always
  // start clean instead of trusting whatever #vertical-video-sidecar-host
  // already contains.
  document.querySelectorAll("#vertical-video-sidecar-host").forEach((node) => node.remove());
  const host = document.createElement("div"); host.id = "vertical-video-sidecar-host";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    :host { all: initial; } .dock { position:fixed; z-index:2147483647; right:0; top:0; width:${DOCK_WIDTH_DEFAULT}px; height:100vh; background:#11131b; box-shadow:-5px 0 30px #000a; transition:transform .2s ease; }
    .dock.collapsed { transform:translateX(100%); } iframe { border:0; width:100%; height:100%; display:block; } .tab { position:absolute; right:100%; top:42%; width:26px; height:70px; border:0; border-radius:9px 0 0 9px; background:#75ead4; color:#08201c; font:700 12px system-ui; cursor:pointer; box-shadow:-3px 2px 8px #0007; }
    .resize-handle { position:absolute; left:-4px; top:0; width:8px; height:100%; cursor:ew-resize; z-index:1; touch-action:none; }
    .resize-handle:hover, .dock.resizing .resize-handle { background:#75ead466; }
    .dock.resizing { transition:none; user-select:none; }
    @media (max-width:560px) { .dock{width:min(88vw,${DOCK_WIDTH_DEFAULT}px) !important} .dock.collapsed{transform:translateX(100%)} .resize-handle{display:none} }
  </style><div class="dock"><div class="resize-handle" title="Drag to resize"></div><iframe title="Vertical Video Sidecar" src="${chrome.runtime.getURL("sidepanel.html?dock=1")}"></iframe><button class="tab" title="Hide video dock">›</button></div>`;
  const dock = root.querySelector(".dock");
  root.querySelector(".tab").addEventListener("click", () => { dock.classList.toggle("collapsed"); root.querySelector(".tab").textContent = dock.classList.contains("collapsed") ? "‹" : "›"; });
  document.documentElement.append(host);

  chrome.storage.local.get(DOCK_WIDTH_KEY, (result) => {
    const stored = Number(result?.[DOCK_WIDTH_KEY]);
    if (Number.isFinite(stored)) dock.style.width = `${clampDockWidth(stored)}px`;
  });

  const handle = root.querySelector(".resize-handle");
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    dock.classList.add("resizing");
    const startX = event.clientX;
    const startWidth = dock.getBoundingClientRect().width;
    let finalWidth = startWidth;

    const onMove = (moveEvent) => {
      finalWidth = clampDockWidth(startWidth + (startX - moveEvent.clientX));
      dock.style.width = `${finalWidth}px`;
    };
    const onUp = () => {
      dock.classList.remove("resizing");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      chrome.storage.local.set({ [DOCK_WIDTH_KEY]: finalWidth });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  });
}

function firstVideo() {
  const videos = [...document.querySelectorAll("video")];
  return videos.length ? describe(videos.find((video) => !video.paused) || videos[0]) : null;
}

function rememberVideo(video) {
  lastVideo = describe(video);
  // Faphouse uses MediaSource, so the DOM video normally reports a blob: URL.
  // Resolve the signed HLS URL while this logged-in page can still read it.
  if (isFaphouse()) {
    void faphouseCandidate().then((candidate) => {
      if (candidate) lastVideo = candidate;
    });
  }
}

async function lastCandidate() {
  if (isFaphouse()) return await faphouseCandidate() || lastVideo || firstVideo();
  if (isFapfolder()) {
    const candidate = lastVideo || firstVideo();
    if (candidate && /^https?:/i.test(candidate.url)) return candidate;
    // A MediaSource blob belongs to the page renderer and cannot be replayed
    // from the extension panel. Try explicit source elements before returning it.
    const video = document.querySelector("video");
    const direct = video && [...video.querySelectorAll("source")]
      .map((source) => source.src || source.getAttribute("src") || "")
      .find((source) => /^https?:/i.test(source));
    if (direct) return { ...describe(video), url: direct };
    return candidate;
  }
  return lastVideo || firstVideo();
}

function isFapfolder() {
  return /(^|\.)fapfolder\.club$/i.test(location.hostname);
}

async function pageCandidates() {
  const candidates = [...document.querySelectorAll("video")]
    .map(describe)
    .filter((item) => /^https?:/i.test(item.url));
  if (!isFaphouse()) return candidates;

  const resolved = await faphouseCandidate();
  if (!resolved) return candidates;
  return [resolved, ...candidates.filter((item) => item.url !== resolved.url)];
}

function isFaphouse() {
  return /(^|\.)faphouse\.com$/i.test(location.hostname);
}

function faphouseHighestQuality(url) {
  const multi = String(url || "").match(/multi=([^/]+)/i);
  const heights = (multi?.[1]?.match(/:(\d{3,4})/g) || [])
    .map((value) => Number.parseInt(value.slice(1), 10))
    .filter((value) => value > 0);
  return heights.length ? Math.max(...heights) : 0;
}

function faphouseStreamHeight(url) {
  const fromMulti = faphouseHighestQuality(url);
  if (fromMulti) return fromMulti;
  const match = String(url || "").match(/(?:^|[\/_.-])(2160|1440|1080|720|480|360|240)(?:p)?(?:[\/_.-]|\.mp4|\.m3u8|$)/i);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function faphouseBestStream(pageHtml) {
  const found = new Map();
  const patterns = [
    /https?:\/\/[^"'\\\s<>]+_TPL_[^"'\\\s<>]*\.m3u8/gi,
    /https?:\/\/[^"'\\\s<>]+\.(?:m3u8|mp4)(?:\?[^"'\\\s<>]*)?/gi,
  ];
  const add = (raw) => {
    const original = String(raw || "").replace(/\\u0026/gi, "&").replace(/&amp;/gi, "&");
    if (!original || /\/(?:trailer|preview)\//i.test(original)) return;
    const height = faphouseHighestQuality(original) || faphouseStreamHeight(original);
    const url = original.includes("_TPL_") ? original.replace("_TPL_", String(height || 1080)) : original;
    const candidate = { url, height: height || faphouseStreamHeight(url), hls: /\.m3u8(?:[?#]|$)/i.test(url) };
    const existing = found.get(url);
    if (!existing || candidate.height > existing.height) found.set(url, candidate);
  };
  for (const pattern of patterns) {
    for (const match of String(pageHtml || "").matchAll(pattern)) add(match[0]);
  }
  // Full Faphouse titles are signed HLS; page MP4s are commonly previews.
  return [...found.values()].sort((a, b) => Number(b.hls) - Number(a.hls) || b.height - a.height)[0] || null;
}

async function faphouseCandidate() {
  if (!isFaphouse()) return null;
  try {
    const response = await fetch(location.href.split("#")[0], { credentials: "include" });
    if (!response.ok) return null;
    const pageHtml = await response.text();
    const stateMatch = pageHtml.match(/<script[^>]*id="view-state-data"[^>]*>([\s\S]*?)<\/script>/i);
    let videoState = {};
    if (stateMatch) {
      try { videoState = JSON.parse(stateMatch[1].trim()).video || {}; } catch {}
    }
    if (videoState.videoViewAllowed === false) return null;
    const stream = faphouseBestStream(pageHtml);
    if (!stream?.url) return null;
    const title = document.querySelector("h1")?.textContent?.trim() || document.title || "Faphouse video";
    return {
      url: stream.url,
      title: title.slice(0, 140),
      pageUrl: location.href.split("#")[0],
      sourceUrl: location.href.split("#")[0],
      poster: document.querySelector('meta[property="og:image"]')?.content || "",
      typeHint: stream.hls ? "hls" : "file",
      quality: stream.height ? `${stream.height}p` : null,
      duration: Number(videoState.duration) || null,
    };
  } catch {
    return null;
  }
}

function describe(video) {
  const source = video.currentSrc || video.src || video.querySelector("source")?.src || "";
  const label = video.getAttribute("aria-label") || video.title || document.title || "Untitled video";
  return {
    url: source,
    title: label.slice(0, 140),
    pageUrl: location.href,
    poster: video.poster || "",
    typeHint: /\.m3u8(?:$|[?#])/i.test(source) ? "hls" : "file",
    ...(source.startsWith("blob:") ? { captureHint: "This site uses a page-only media stream. Capture its direct stream from the video controls." } : {})
  };
}
