const state = {
  results: [],
  hash: "",
  mode: "",
  progress: 0,
  timer: 0,
  retries: 0,
  token: 0,
};

const grid = document.querySelector("#grid");
const statusLine = document.querySelector("#status");
const player = document.querySelector("#player");
const dock = document.querySelector("#player-dock");

function text(value) {
  return String(value ?? "");
}

function detailOf(payload, fallback) {
  if (payload && typeof payload.detail === "string") return payload.detail;
  return fallback;
}

function tone(message, kind) {
  statusLine.textContent = message;
  statusLine.dataset.tone = kind || "";
}

function formatBytes(value) {
  const size = Number(value) || 0;
  if (size < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
  return `${(size / 1024 ** exp).toFixed(exp ? 1 : 0)} ${units[exp]}`;
}

function formatEta(seconds) {
  if (seconds == null || seconds < 0) return "—";
  const mins = Math.round(seconds / 60);
  if (mins < 1) return "< 1 min";
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

function visibleResults() {
  const needle = document.querySelector("#filter-text").value.trim().toLowerCase();
  const seeds = Number(document.querySelector("#filter-seeds").value) || 0;
  const indexer = document.querySelector("#filter-indexer").value;
  const sort = document.querySelector("#sort").value;
  const rows = state.results.filter((row) => {
    if (seeds && Number(row.seeders) < seeds) return false;
    if (indexer && row.indexer !== indexer) return false;
    if (needle && !text(row.title).toLowerCase().includes(needle)) return false;
    return true;
  });
  rows.sort((a, b) => {
    if (sort === "size") return Number(b.size) - Number(a.size);
    if (sort === "date") return text(b.publish_date).localeCompare(text(a.publish_date));
    if (sort === "title") return text(a.title).localeCompare(text(b.title), "sk");
    return Number(b.seeders) - Number(a.seeders);
  });
  return rows;
}

function fillIndexers() {
  const select = document.querySelector("#filter-indexer");
  const current = select.value;
  const names = [...new Set(state.results.map((row) => row.indexer).filter(Boolean))].sort();
  select.replaceChildren(new Option("Všetky", ""));
  for (const name of names) select.append(new Option(name, name));
  select.value = names.includes(current) ? current : "";
}

function render() {
  const rows = visibleResults();
  grid.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = state.results.length ? "Filtre nič nenechali." : "Zatiaľ žiadne výsledky.";
    grid.append(empty);
    return;
  }
  for (const row of rows) {
    const card = document.createElement("article");
    card.className = "card";
    card.dataset.hash = row.infohash || "";
    const image = document.createElement("img");
    image.width = 320;
    image.height = 180;
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.src = row.thumb_url || "/static/torrent_placeholder.svg";
    image.addEventListener("error", () => {
      image.src = "/static/torrent_placeholder.svg";
    });
    const body = document.createElement("div");
    body.className = "body";
    const title = document.createElement("h3");
    title.textContent = row.title || "Bez názvu";
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.innerHTML = `<b>${Number(row.seeders) || 0} seed</b> · ${Number(row.leechers) || 0} leech · ${formatBytes(row.size)}`;
    const sub = document.createElement("p");
    sub.className = "meta";
    const when = row.publish_date ? row.publish_date.slice(0, 10) : "";
    sub.textContent = [row.indexer, when].filter(Boolean).join(" · ");
    const actions = document.createElement("div");
    actions.className = "actions";
    const play = document.createElement("button");
    play.type = "button";
    play.textContent = "Prehrať";
    play.disabled = !row.magnet && !row.ref;
    play.addEventListener("click", () => startPlayback(row, play));
    actions.append(play);
    if (/pornclub/i.test(row.indexer || "") && row.details_url) {
      const trailer = document.createElement("button");
      trailer.type = "button";
      trailer.className = "quiet";
      trailer.textContent = "Trailer";
      trailer.addEventListener("click", () => playTrailer(row));
      actions.append(trailer);
    }
    if (row.details_url) {
      const link = document.createElement("a");
      link.className = "quiet";
      link.href = row.details_url;
      link.target = "_blank";
      link.rel = "noreferrer noopener";
      link.textContent = "Detail";
      actions.append(link);
    }
    body.append(title, meta, sub, actions);
    card.append(image, body);
    grid.append(card);
  }
}

async function readError(response, fallback) {
  try {
    return detailOf(await response.json(), fallback);
  } catch {
    return fallback;
  }
}

function playTrailer(row) {
  state.kind = "trailer";
  dock.hidden = false;
  document.querySelector("#player-title").textContent = row.title || "Trailer";
  document.querySelector("#player-stat").textContent = "Trailer z MyPornClub";
  const details = encodeURIComponent(row.details_url || "");
  const hash = encodeURIComponent(row.infohash || "");
  player.preload = "auto";
  player.src = `/api/torrent/trailer?hash=${hash}&details=${details}`;
  player.play().catch(() => tone("Trailer spusti tlačidlom v prehrávači."));
}

async function startPlayback(row, button) {
  const token = ++state.token;
  button.disabled = true;
  tone("Pridávam do qBittorrent…");
  const response = await fetch("/api/torrent/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ magnet: row.magnet || "", ref: row.ref || "" }),
  });
  if (!response.ok) {
    button.disabled = false;
    tone(await readError(response, "Torrent sa nepodarilo pridať"), "bad");
    return;
  }
  const added = await response.json();
  if (token !== state.token) return;
  state.hash = added.hash;
  state.kind = "download";
  state.retries = 0;
  state.started = false;
  state.mode = "";
  state.progress = 0;
  state.misses = 0;
  dock.hidden = false;
  document.querySelector("#player-title").textContent = row.title || added.hash;
  player.preload = "none";
  player.removeAttribute("src");
  player.load();
  dock.scrollIntoView({ block: "start" });
  pollStatus();
}

async function pollStatus() {
  window.clearTimeout(state.timer);
  if (!state.hash) return;
  try {
    const response = await fetch(`/api/torrent/status?hash=${encodeURIComponent(state.hash)}`);
    if (!response.ok) {
      if (response.status === 404 && state.kind === "download" && (state.misses || 0) < 15) {
        state.misses = (state.misses || 0) + 1;
        tone("qBittorrent ešte zaradil torrent…");
        return;
      }
      tone(await readError(response, "Stav torrentu nie je dostupný"), "bad");
      return;
    }
    const status = await response.json();
    if (state.kind === "trailer") return;
    state.mode = status.stream_mode || "";
    state.progress = Number(status.progress) || 0;
    const pct = Math.max(0, Math.min(100, Number(status.progress_pct) || 0));
    document.querySelector("#player-bar").style.inlineSize = `${pct}%`;
    const speed = formatBytes(status.speed) + "/s";
    document.querySelector("#player-stat").textContent =
      `${status.state || ""} · ${pct.toFixed(0)} % · ${speed} · ETA ${formatEta(status.eta)}`;
    if (status.archive) {
      tone("V torrente je archív a zatiaľ žiadne video.", "bad");
    } else if (status.stream_ready && !state.started && state.kind === "download") {
      state.started = true;
      player.src = status.stream_url;
      player.preload = "auto";
      dock.scrollIntoView({ block: "start" });
      try {
        await player.play();
        tone("Prehrávanie v dashboarde");
      } catch {
        tone("Súbor je pripravený. Spusti prehrávanie tlačidlom v prehrávači.");
      }
    } else if (!status.stream_ready) {
      tone("Sťahuje sa začiatok videa…");
    }
  } catch {
    tone("Stav torrentu sa nepodarilo načítať", "bad");
  } finally {
    if (state.hash) state.timer = window.setTimeout(pollStatus, 2000);
  }
}

player.addEventListener("ended", () => {
  if (state.kind === "trailer") return;
  if (!state.hash || state.progress >= 0.995 || state.mode !== "remux") return;
  const at = player.currentTime;
  if (at < 1) return;
  player.src = `/api/torrent/stream?hash=${encodeURIComponent(state.hash)}&t=${at.toFixed(3)}`;
  player.play().catch(() => {});
});

player.addEventListener("error", () => {
  if (state.kind === "trailer") {
    tone("Trailer sa nepodarilo prehrať", "bad");
    return;
  }
  if (!state.hash || state.retries > 8) {
    tone("Prehrávač zatiaľ nemá dosť dát. Nechávam sťahovať.", "bad");
    return;
  }
  state.retries += 1;
  window.setTimeout(() => {
    if (player.currentSrc) player.load();
  }, 2000);
});

document.querySelector("#search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.querySelector("#search-btn");
  const query = document.querySelector("#q").value.trim();
  if (!query) return;
  button.disabled = true;
  tone("Hľadám vo všetkých indexeroch…");
  grid.replaceChildren();
  try {
    const response = await fetch(`/api/torrent/search?q=${encodeURIComponent(query)}`);
    const payload = await response.json();
    if (!response.ok) {
      tone(detailOf(payload, "Hľadanie zlyhalo"), "bad");
      return;
    }
    state.results = payload.results || [];
    fillIndexers();
    const warn = (payload.warnings || []).length ? ` ${payload.warnings[0]}` : "";
    const counts = Object.entries(payload.indexer_counts || {})
      .sort((left, right) => right[1] - left[1])
      .map(([name, count]) => `${name} ${count}`)
      .join(", ");
    tone(`${payload.count} výsledkov cez ${payload.engine}${counts ? ` (${counts})` : ""} za ${payload.took_ms} ms.${warn}`);
    render();
  } catch {
    tone("Nexus search endpoint neodpovedá", "bad");
  } finally {
    button.disabled = false;
  }
});

for (const id of ["filter-text", "filter-seeds", "filter-indexer", "sort"]) {
  document.querySelector(`#${id}`).addEventListener("input", render);
  document.querySelector(`#${id}`).addEventListener("change", render);
}

async function loadHealth() {
  const node = document.querySelector("#health");
  const label = node.querySelector("span");
  try {
    const response = await fetch("/api/torrent/health");
    if (!response.ok) {
      node.className = "health is-bad";
      label.textContent = "Neprihlásený alebo API nie je dostupné";
      return;
    }
    const health = await response.json();
    const qbit = health.qbittorrent || {};
    const ok = qbit.reachable && health.engine !== "none";
    node.className = ok ? "health is-ok" : "health is-bad";
    const parts = [
      health.engine === "none" ? "chýba indexer" : health.engine,
      qbit.reachable ? `qBit ${qbit.version || "ok"}` : "qBit nedostupný",
      health.ffmpeg ? "ffmpeg" : "bez ffmpeg",
    ];
    label.textContent = parts.join(" · ");
  } catch {
    node.className = "health is-bad";
    label.textContent = "Health endpoint neodpovedá";
  }
}

loadHealth();
