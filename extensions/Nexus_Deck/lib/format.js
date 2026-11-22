export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

export function hue(seed) {
  let hash = 0;
  const text = String(seed || "");
  for (let i = 0; i < text.length; i += 1) hash = (hash * 33 + text.charCodeAt(i)) >>> 0;
  return hash % 360;
}

export function siteHost(canonical) {
  try {
    return new URL(canonical).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function ago(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, (now - then) / 1000);
  if (seconds < 15) return "práve teraz";
  if (seconds < 60) return `pred ${Math.floor(seconds)} s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `pred ${Math.floor(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 24) return `pred ${Math.floor(hours)} h`;
  return new Date(then).toLocaleString("sk-SK", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function clock(seconds) {
  if (!seconds) return "";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

export function providerLabel(provider) {
  if (provider === "file") return "Súbor";
  return "Príspevok";
}

export function sourceLabel(source) {
  if (source === "deck") return "Deck";
  if (source === "dashboard") return "Dashboard";
  return "Ukážka";
}

export function statusLabel(status) {
  return {
    queued: "Vo fronte",
    resolve: "Overujem",
    fetch: "Načítavam",
    index: "Zapisujem",
    ready: "V galérii",
    failed: "Zlyhalo",
  }[status] || status;
}

export function playbackKind(item) {
  if (!item) return { kind: "link", src: "" };
  if (item.playUrl) return { kind: "video", src: item.playUrl };
  const src = item.url || item.canonical || "";
  if (item.provider === "file" && !/\.m3u8(?:$|\?)/i.test(src)) {
    return { kind: "video", src };
  }
  return { kind: "link", src };
}

export function sortImports(items) {
  const rank = { resolve: 0, fetch: 1, index: 2, queued: 3, failed: 4, ready: 5 };
  return [...items].sort((a, b) => {
    const byStatus = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
    if (byStatus) return byStatus;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}

export function readyPlaylist(items) {
  return items
    .filter((item) => item.status === "ready")
    .sort((a, b) => Date.parse(a.readyAt || a.createdAt) - Date.parse(b.readyAt || b.createdAt));
}
