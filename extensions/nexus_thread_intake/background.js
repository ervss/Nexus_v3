function openDashboard(tab, automatic = false, callback = () => {}) {
  if (!tab.id || !/^https?:/i.test(tab.url || "")) {
    callback(new Error("Aktívna stránka nemá platnú webovú adresu."));
    return;
  }
  const query = new URLSearchParams({
    tabId: String(tab.id),
    url: tab.url || "",
  });
  if (automatic) query.set("auto", "1");
  chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html?${query}`) }, () => {
    const error = chrome.runtime.lastError;
    callback(error ? new Error(error.message) : null);
  });
}

chrome.action.onClicked.addListener((tab) => {
  openDashboard(tab);
});

const WATCHED_URL = /^https:\/\/([a-z0-9-]+\.)?simpcity\.cr\/watched\/threads(?:\/|$)/i;

function watchedRequest(message, sender) {
  if (!sender.tab || !WATCHED_URL.test(sender.tab.url || "")) throw new Error("Táto akcia je dostupná iba na Watched Threads.");
  const port = Number(message.port);
  if (![8000, 8001, 8002].includes(port)) throw new Error("Neplatný port Nexusu.");
  let url;
  try { url = new URL(message.url); } catch { throw new Error("Neplatný odkaz na zdroj."); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Neplatný odkaz na zdroj.");
  return { port, url: url.href };
}

async function testerRequest(port, path, url, options = {}) {
  const response = await fetch(`http://localhost:${port}/api/tester/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls: [url], ...options }), signal: AbortSignal.timeout(105000),
  });
  if (!response.ok) throw new Error(`Nexus ${port}: HTTP ${response.status}`);
  return response.json();
}

async function watchedMedia(message, sender) {
  const { port, url } = watchedRequest(message, sender);
  if (message.action === "nexusThreadIntake.sourceMeta") {
    const payload = await testerRequest(port, "batch-meta", url, { metadata_only: true, full_metadata: true });
    const row = payload.results?.[0];
    if (!row?.ok) throw new Error(row?.error || "Zdroj neposkytol metadáta.");
    return { ok: true, meta: {
      title: row.title || "", thumbnail: row.thumbnail || "",
      duration: row.duration || row.duration_sec || 0,
      size_bytes: row.size_bytes || 0, size_mb: row.size_mb || 0,
      width: row.width || 0, height: row.height || 0,
      quality: row.quality || "", upload_date: row.upload_date || "",
      item_count: row.item_count || 0, video_count: row.video_count || 0,
      kind: row.kind || "", size_estimated: Boolean(row.size_estimated || row.album_size_estimated),
    } };
  }
  let payload = await testerRequest(port, "batch-meta", url);
  let row = payload.results?.[0];
  if (!row?.ok || !row.stream_url) {
    payload = await testerRequest(port, "resolve", url);
    const result = payload.results?.[0];
    if (result?.status === "success") row = { ...result.data, ok: true };
  }
  if (!row?.ok || !row.stream_url) throw new Error(row?.error || "Pre tento zdroj sa nepodarilo nájsť prehrateľné video.");
  let stream;
  try { stream = new URL(row.stream_url); } catch { throw new Error("Zdroj vrátil neplatnú adresu videa."); }
  if (!/^https?:$/.test(stream.protocol) || stream.username || stream.password) throw new Error("Zdroj vrátil neplatnú adresu videa.");
  return { ok: true, playback: {
    streamUrl: stream.href, isHls: Boolean(row.is_hls || /\.m3u8(?:[?#]|$)/i.test(stream.href)),
    title: row.title || "", sourceUrl: url, proxySession: row.proxy_session || "",
  } };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (["nexusThreadIntake.sourceMeta", "nexusThreadIntake.playWatched"].includes(message?.action)) {
    watchedMedia(message, sender).then(sendResponse, error => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.action === "nexusThreadIntake.pushWatched") {
    (async () => {
      const tabUrl = sender.tab?.url || "";
      const isSupportedPage = /^https:\/\/([a-z0-9-]+\.)?simpcity\.cr\/(?:watched\/threads|search|tags|forums|threads)(?:\/|$)/i.test(tabUrl);
      if (!sender.tab || !isSupportedPage) {
        throw new Error("Odoslanie je dostupné iba zo stránky SimpCity (Watched, Search, Tags, Forums alebo Thread).");
      }
      const port = Number(message.port);
      if (![8000, 8001, 8002].includes(port)) throw new Error("Neplatný port Nexusu.");
      const links = Array.isArray(message.links) ? message.links.slice(0, 500) : [];
      if (!links.length) throw new Error("Vyber aspoň jeden odkaz.");
      const threads = Array.isArray(message.threads) ? message.threads.slice(0, 500) : [];
      const fallbackTitle = /\/search\//i.test(tabUrl)
        ? "SimpCity Search"
        : /\/tags\//i.test(tabUrl)
          ? "SimpCity Tag"
          : /\/forums\//i.test(tabUrl)
            ? "SimpCity Forum"
            : "SimpCity Watched – novinky";
      const base = `http://localhost:${port}`;
      const response = await fetch(`${base}/api/v1/hunter/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread_title: message.title ? String(message.title).slice(0, 160) : fallbackTitle,
          thread_url: tabUrl,
          threads,
          links,
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`Nexus ${port}: HTTP ${response.status}`);
      const data = await response.json();
      if (!data.session_id) throw new Error("Nexus nevrátil session ID.");
      await chrome.tabs.create({ url: `${base}/tester?hunter=1&session=${encodeURIComponent(data.session_id)}&autostart=1&autoselect=1` });
      return { ok: true, sessionId: data.session_id, count: data.count };
    })().then(sendResponse, error => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.action !== "nexusThreadIntake.openDashboard") return;
  if (!sender.tab) {
    sendResponse({ ok: false, error: "Chýba aktívna karta." });
    return;
  }
  openDashboard(sender.tab, true, error => {
    sendResponse(error ? { ok: false, error: error.message } : { ok: true });
  });
  return true;
});

const FILEDITCH_COOKIE_DOMAINS = [
  "fileditchfiles.st", "fileditch.st", "freakingfileditch.me",
  "donotsharethesetemplinksyouidiot.st",
];

async function syncFileditchCookies() {
  const all = [];
  for (const domain of FILEDITCH_COOKIE_DOMAINS) {
    all.push(...await chrome.cookies.getAll({ domain }));
  }
  const unique = new Map(all.map(cookie => [`${cookie.domain}|${cookie.path}|${cookie.name}`, cookie]));
  if (!unique.size) return;
  const rows = [...unique.values()].map(cookie => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    expirationDate: cookie.expirationDate || null,
  }));
  const payload = JSON.stringify({ cookies: rows });
  for (const base of ["http://localhost:8000", "http://localhost:8001", "http://localhost:8002"]) {
    try {
      const response = await fetch(`${base}/api/v1/fileditch/cookies/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) return;
    } catch (_) {
      // Try the next local Nexus port.
    }
  }
}

chrome.cookies.onChanged.addListener((change) => {
  if (!change.removed && FILEDITCH_COOKIE_DOMAINS.some(domain => change.cookie.domain.endsWith(domain))) {
    syncFileditchCookies();
  }
});
syncFileditchCookies();
