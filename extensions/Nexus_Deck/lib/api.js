import { classifyUrl } from "./canonical.js";

const isHlsUrl = (url) => /\.m3u8(?:$|[?#])/i.test(url || "");

function createdAt(value) {
  const match = /^(\d{2}):(\d{2}) · (\d{2})\.(\d{2})\.(\d{4})$/.exec(value || "");
  if (match) {
    const [, hours, minutes, day, month, year] = match;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes)).toISOString();
  }
  const timestamp = Date.parse(value || "");
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function mapVideo(video, base, apiMode) {
  const source = video.source_url || video.url || "";
  const url = video.url || source;
  const status = ["ready", "ready_to_stream", "completed", "working"].includes(video.status) ? "ready"
    : ["error", "failed"].includes(video.status) ? "failed" : "queued";
  const thumbnailPath = video.thumbnail || video.thumbnail_path || "";
  const thumbnail = thumbnailPath.startsWith("/") ? `${base}${thumbnailPath}` : thumbnailPath;
  const date = createdAt(video.created_at);
  const isHls = isHlsUrl(url);
  const referer = encodeURIComponent(source);
  const playUrl = apiMode === "lite"
    ? (isHls
      ? `${base}/api/lite/hls?url=${encodeURIComponent(url)}&referer=${referer}`
      : `${base}/api/lite/stream/${video.id}`)
    : (isHls
      ? `${base}/hls_proxy?url=${encodeURIComponent(url)}&referer=${referer}`
      : video.storage_type === "local_direct" || url.startsWith("file://")
        ? `${base}/api/v1/videos/${video.id}/stream`
        : video.storage_type === "mega" || /^mega:/.test(url)
          ? `${base}/api/v1/mega/stream/${video.id}`
        : url.startsWith("/") ? `${base}${url}` : `${base}/stream_proxy/${video.id}.mp4`);
  return {
    id: String(video.id),
    title: video.title || source || "Bez názvu",
    url: source,
    canonical: source,
    provider: /\.(mp4|webm|ogv|mov|m4v|mkv|m3u8)(?:$|[?#])/i.test(url) ? "file" : "page",
    source: "dashboard",
    status,
    thumbnail,
    durationSec: Number(video.duration) || 0,
    isHls,
    apiMode,
    storageType: video.storage_type || "remote",
    playUrl,
    createdAt: date,
    updatedAt: date,
    readyAt: status === "ready" ? date : null,
  };
}

export function createApi(getSettings) {
  let lastState = null;
  let mode = null;

  async function request(path, options = {}) {
    const settings = await getSettings();
    const headers = { ...(options.headers || {}) };
    if (options.body) headers["content-type"] = "application/json";
    if (settings.token) headers["X-Nexus-Token"] = settings.token;
    let response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);
    try {
      response = await fetch(`${settings.apiBase.replace(/\/$/, "")}${path}`, {
        method: options.method || "GET",
        headers,
        body: options.body,
        signal: controller.signal,
      });
    } catch (cause) {
      const error = new Error(cause.name === "AbortError" ? "Zdroj neodpovedal v časovom limite" : "Dashboard neodpovedá");
      error.status = 0;
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      const error = new Error(data.message || data.detail || data.error || "Požiadavka zlyhala");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function classicState() {
    const [library, monitor] = await Promise.all([
      request("/api/v1/videos?limit=120&page=1"),
      request("/api/v1/dashboard/import-monitor?limit=15"),
    ]);
    const settings = await getSettings();
    const base = settings.apiBase.replace(/\/$/, "");
    const videos = Array.isArray(library) ? library : (library.items || []);
    const items = videos.map((video) => mapVideo(video, base, "classic"));
    const jobs = monitor.items || [];
    const activeJob = jobs.find((job) => ["pending", "processing"].includes(job.status) && Number(job.remaining_items) > 0);
    const completed = activeJob ? (Number(activeJob.done_items) || 0) + (Number(activeJob.duplicate_items) || 0)
      + (Number(activeJob.failed_items) || 0) + (Number(activeJob.cancelled_items) || 0) : 0;
    const queue = monitor.queue || {};
    mode = "classic";
    lastState = {
      items,
      stats: {
        ready: items.filter((item) => item.status === "ready").length,
        active: (Number(queue.processing) || 0) + (Number(queue.pending) || 0),
        failed: jobs.reduce((sum, job) => sum + (Number(job.failed_items) || 0), 0),
      },
      worker: activeJob ? {
        state: "running",
        label: activeJob.batch_name || "Import",
        title: `${completed} z ${activeJob.total_items || 0} spracovaných`,
        progress: Number(activeJob.percent) || 0,
      } : (queue.active ? {
        state: "running",
        label: queue.batch_name || "Import",
        title: `${queue.recent_done || 0} z ${queue.total || 0} spracovaných`,
        progress: Number(queue.percent) || 0,
      } : { state: "idle" }),
      activity: jobs.slice(0, 12).map((job) => ({
        at: job.updated_at || job.created_at,
        text: `${job.batch_name || "Import"} · ${job.status}`,
        tone: job.failed_items ? "bad" : "",
      })),
      playback: null,
    };
    return lastState;
  }

  async function liteState() {
    const [stats, library, monitor] = await Promise.all([
      request("/api/lite/stats"),
      request("/api/lite/videos?limit=120"),
      request("/api/lite/import-monitor?limit=15"),
    ]);
    const settings = await getSettings();
    const base = settings.apiBase.replace(/\/$/, "");
    const items = (library.items || []).map((video) => mapVideo(video, base, "lite"));
    const jobs = monitor.jobs || [];
    const activeJob = jobs.find((job) => ["queued", "pending", "running", "extracting"].includes(job.status));
    const completed = activeJob ? (activeJob.imported_items || 0) + (activeJob.duplicate_items || 0)
      + (activeJob.failed_items || 0) + (activeJob.cancelled_items || 0) : 0;
    mode = "lite";
    lastState = {
      items,
      stats: {
        ready: Number(stats.total_videos) || 0,
        active: Number(stats.pending_queue) || Number(stats.active_jobs) || 0,
        failed: jobs.reduce((sum, job) => sum + (Number(job.failed_items) || 0), 0),
      },
      worker: activeJob ? {
        state: "running",
        label: activeJob.batch_name || "Import",
        title: `${completed} z ${activeJob.total_items || 0} spracovaných`,
        progress: activeJob.total_items ? Math.round(completed * 100 / activeJob.total_items) : 0,
      } : { state: "idle" },
      activity: jobs.slice(0, 12).map((job) => ({
        at: job.updated_at || job.created_at,
        text: `${job.batch_name || "Import"} · ${job.status}`,
        tone: job.failed_items ? "bad" : "",
      })),
      playback: null,
    };
    return lastState;
  }

  async function state() {
    try {
      return await classicState();
    } catch (error) {
      if (error.status !== 404) throw error;
      return liteState();
    }
  }

  function check(urls) {
    const known = new Map((lastState?.items || []).map((item) => [classifyUrl(item.canonical).canonical, item]));
    return { results: urls.map((input) => {
      const parsed = classifyUrl(input);
      if (!parsed.ok) return { verdict: "invalid", input, reason: parsed.reason };
      const item = known.get(parsed.canonical);
      return { verdict: item ? "duplicate" : "new", input, canonical: parsed.canonical, host: parsed.host, item };
    }) };
  }

  async function importUrls(urls) {
    const results = check(urls).results;
    const fresh = results.filter((result) => result.verdict === "new");
    if (fresh.length) {
      const options = {
        method: "POST",
        body: JSON.stringify({ urls: fresh.map((result) => result.input), batch_name: "Nexus Deck" }),
      };
      try {
        await request("/api/v1/intake/import", options);
      } catch (error) {
        if (error.status !== 404) throw error;
        await request("/api/lite/quick-import", options);
      }
      for (const result of fresh) result.verdict = "queued";
    }
    return { results };
  }

  async function resolvePlayback(item) {
    const settings = await getSettings();
    const base = settings.apiBase.replace(/\/$/, "");
    // Lite's range endpoint resolves and refreshes upstream links itself.
    if (item.apiMode === "lite" || mode === "lite") return item;
    if (item.storageType === "mega" || /^mega:/.test(item.url || "")) {
      return { ...item, isHls: false, playUrl: `${base}/api/v1/mega/stream/${encodeURIComponent(item.id)}` };
    }
    if (!["remote", "cdn_direct", ""].includes(item.storageType ?? "remote")) return item;
    const resolved = await request(`/api/v1/stream/resolve/${encodeURIComponent(item.id)}`);
    if (resolved.supported === false) return item;
    if (!/^https?:\/\//i.test(resolved.stream_url || "")) throw new Error("Resolver nevrátil prehrateľný stream");
    const isHls = resolved.is_hls === true || isHlsUrl(resolved.stream_url);
    const query = new URLSearchParams({ url: resolved.stream_url, referer: item.url || "" });
    if (resolved.proxy_session) query.set("session", resolved.proxy_session);
    return { ...item, isHls, nativeDirect: false, directFallback: !isHls && !resolved.proxy_session ? resolved.stream_url : null, playUrl: isHls || resolved.proxy_session
      ? `${base}/hls_proxy?${query}`
      : `${base}/stream_proxy/${encodeURIComponent(item.id)}.mp4?${query}` };
  }

  return {
    async health() {
      try {
        return await request("/api/health");
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      try {
        return await request("/api/v1/videos?limit=1&page=1");
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      return request("/api/lite/stats");
    },
    state,
    resolvePlayback,
    async queueDownload(item) {
      if (item.source === "dashboard" && item.apiMode !== "lite" && /^\d+$/.test(String(item.id || ""))) {
        return request(`/api/v1/videos/${encodeURIComponent(item.id)}/download`, { method: "POST" });
      }
      const url = item.directFallback || item.url || "";
      if (!/^https?:\/\//i.test(url)) throw new Error("Pre toto video nie je dostupný priamy odkaz na stiahnutie.");
      const result = await request("/api/downloads/start", {
        method: "POST",
        body: JSON.stringify({ urls: [{
          url,
          title: item.title || "Deck download",
          source: "deck",
          referer: item.canonical || item.url || "",
        }] }),
      });
      return result.added?.[0] || result;
    },
    check: async (urls) => check(urls),
    importUrls,
    retry: async () => { throw new Error("Opakovaný import spusti v dashboarde."); },
    remove: async () => { throw new Error("Video odstráň v dashboarde."); },
    play: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    async eventsUrl() {
      if (mode !== "lite") return null;
      const settings = await getSettings();
      return `${settings.apiBase.replace(/\/$/, "")}/api/lite/events`;
    },
  };
}
