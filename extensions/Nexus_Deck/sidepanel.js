import { splitUrls } from "./lib/canonical.js";
import {
  ago,
  clock,
  esc,
  hue,
  providerLabel,
  readyPlaylist,
  siteHost,
  sortImports,
  sourceLabel,
  statusLabel,
} from "./lib/format.js";
import { createApi } from "./lib/api.js";
import { icon, logo } from "./lib/icons.js";
import { SETTINGS_KEY, isExtension, loadSettings, saveSettings } from "./lib/settings.js";
import { createDeckPlayer } from "./lib/player.js";

const $ = (id) => document.getElementById(id);
const DEMO_HARVEST = [
  "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4?utm_source=deck&token=docasny",
  "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
];

let settings = null;
let api = null;
let snapshot = null;
let link = "boot";
let tab = "imports";
let openId = null;
let preflight = [];
let preflightSeq = 0;
let preflightTimer = 0;
let sending = false;
let filter = "";
let playingId = null;
let autoadvance = false;
let composerNote = "";
let settingsOpen = false;
let events = null;
let player = null;
const QUEUE_KEY = "nexus-deck-queue";
let queueOrder = [];
let hiddenQueueIds = new Set();
let draggedQueueId = null;
try {
  const savedQueue = JSON.parse(localStorage.getItem(QUEUE_KEY) || "{}");
  queueOrder = Array.isArray(savedQueue.order) ? savedQueue.order : [];
  hiddenQueueIds = new Set(Array.isArray(savedQueue.hidden) ? savedQueue.hidden : []);
} catch { /* fresh queue */ }

function saveQueue() {
  localStorage.setItem(QUEUE_KEY, JSON.stringify({ order: queueOrder, hidden: [...hiddenQueueIds] }));
}

function playlist() {
  const items = readyPlaylist(snapshot?.items || []).filter((item) => !hiddenQueueIds.has(item.id));
  const rank = new Map(queueOrder.map((id, index) => [id, index]));
  return items.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
}

function paintShell() {
  $("logo").innerHTML = logo;
  $("btn-refresh").innerHTML = icon("refresh");
  $("btn-settings").innerHTML = icon("settings");
  $("btn-tab").innerHTML = `${icon("tab")}<span>Táto karta</span>`;
  $("btn-page").innerHTML = `${icon("page")}<span>Videá na stránke</span>`;
  $("play-prev").innerHTML = icon("prev");
  $("play-next").innerHTML = icon("next");
  $("sheet-close").innerHTML = icon("close");
}

function bind() {
  $("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    send();
  });
  $("urls").addEventListener("input", () => {
    composerNote = "";
    renderNote();
    schedulePreflight();
  });
  $("urls").addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      send();
    }
  });
  $("btn-tab").addEventListener("click", addTab);
  $("btn-page").addEventListener("click", addPage);
  $("btn-offline-flush")?.addEventListener("click", flushOfflineQueue);
  $("btn-refresh").addEventListener("click", () => refresh());
  $("btn-settings").addEventListener("click", () => toggleSettings(true));
  $("sheet-close").addEventListener("click", () => toggleSettings(false));
  $("settings-form").addEventListener("submit", saveForm);
  $("btn-test").addEventListener("click", testConnection);
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      tab = button.dataset.tab;
      renderTabs();
      renderView();
    });
  });
  $("filter").addEventListener("input", (event) => {
    filter = event.target.value;
    renderImports();
  });
  $("import-list").addEventListener("click", onImportClick);
  $("queue").addEventListener("click", onQueueClick);
  $("queue").addEventListener("dragstart", (event) => {
    draggedQueueId = event.target.closest(".q-row")?.dataset.id || null;
    if (draggedQueueId && event.dataTransfer) event.dataTransfer.setData("text/plain", draggedQueueId);
  });
  $("queue").addEventListener("dragover", (event) => { if (draggedQueueId && event.target.closest(".q-row")) event.preventDefault(); });
  $("queue").addEventListener("drop", (event) => {
    const targetId = event.target.closest(".q-row")?.dataset.id;
    if (!targetId || !draggedQueueId || targetId === draggedQueueId) return;
    event.preventDefault();
    queueOrder = playlist().map((item) => item.id).filter((id) => id !== draggedQueueId);
    queueOrder.splice(queueOrder.indexOf(targetId), 0, draggedQueueId);
    draggedQueueId = null;
    saveQueue();
    renderQueue();
  });
  $("queue").addEventListener("dragend", () => { draggedQueueId = null; });
  $("preflight").addEventListener("click", onPreflightClick);
  $("play-prev").addEventListener("click", () => step(-1));
  $("play-next").addEventListener("click", () => step(1));
  $("play-all").addEventListener("click", playAll);
  $("queue-reset").addEventListener("click", () => {
    queueOrder = [];
    hiddenQueueIds.clear();
    saveQueue();
    renderQueue();
    renderTabs();
  });
  $("queue-clear").addEventListener("click", () => {
    playlist().forEach((item) => hiddenQueueIds.add(item.id));
    saveQueue();
    clearPlayer();
    renderQueue();
    renderTabs();
  });
  $("sync").addEventListener("change", async () => {
    settings = await saveSettings({ ...settings, sync: $("sync").checked });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && settingsOpen) toggleSettings(false);
  });
}

async function boot() {
  paintShell();
  player = createDeckPlayer({
    resolvePlayback: (item) => api.resolvePlayback(item),
    onDownload: (item) => api.queueDownload(item),
    onStatus: (message) => {
      $("player-fallback").hidden = !message;
      $("player-fallback").textContent = message;
    },
    onStep: (direction, options) => step(direction, options),
    onHistorySelect: (entry) => {
      const item = snapshot?.items.find((video) => video.id === entry.id) || entry.item;
      if (!item) { composerNote = "Video už nie je medzi poslednými položkami."; renderNote(); return; }
      tab = "play";
      renderTabs();
      loadPlayer(item, { autoplay: false, resumeAt: entry.position });
    },
  });
  settings = await loadSettings();
  api = createApi(async () => settings);
  $("sync").checked = settings.sync !== false;
  $("api-base").value = settings.apiBase;
  $("api-token").value = settings.token || "";
  bind();
  await refresh();
  connect();
  if (isExtension()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[SETTINGS_KEY]?.newValue) return;
      settings = { ...settings, ...changes[SETTINGS_KEY].newValue };
      $("sync").checked = settings.sync !== false;
      $("api-base").value = settings.apiBase;
      $("api-token").value = settings.token || "";
      if (events) events.close();
      connect();
      refresh();
    });
  }
  setInterval(tickTimes, 15000);
  setInterval(() => refresh({ quiet: true }), 5000);
}

function schedulePreflight() {
  clearTimeout(preflightTimer);
  preflightTimer = setTimeout(runPreflight, 220);
}

async function runPreflight() {
  const urls = splitUrls($("urls").value);
  const seq = ++preflightSeq;
  if (!urls.length) {
    preflight = [];
    renderPreflight();
    renderSendButton();
    return;
  }
  try {
    const data = await api.check(urls);
    if (seq !== preflightSeq) return;
    preflight = data.results || [];
    link = "live";
    renderConnection();
  } catch (error) {
    if (seq !== preflightSeq) return;
    preflight = [];
    if (error.status === 0) setDown();
  }
  renderPreflight();
  renderSendButton();
}

async function send() {
  const urls = splitUrls($("urls").value);
  if (!urls.length || sending) return;
  sending = true;
  renderSendButton();
  try {
    const data = await api.importUrls(urls, "deck");
    const queued = data.results.filter((result) => result.verdict === "queued");
    const duplicate = data.results.filter((result) => result.verdict === "duplicate");
    const invalid = data.results.filter((result) => result.verdict === "invalid");
    $("urls").value = invalid.map((result) => result.input).join("\n");
    preflight = invalid;
    composerNote = summarize(queued.length, duplicate.length, invalid.length);
    link = "live";
    await refresh();
  } catch (error) {
    if (error.status === 0 && isExtension()) {
      const res = await chrome.runtime.sendMessage({
        type: "enqueue-offline-import",
        urls,
        lastError: error.message || "Dashboard neodpovedá",
      }).catch(() => null);
      if (res?.ok) {
        $("urls").value = "";
        preflight = [];
        composerNote = `Server je offline · ${urls.length} uložené do offline fronty (${res.queueLength} spolu)`;
        setDown();
        refreshOfflineQueueStatus();
        return;
      }
    }
    composerNote = error.status === 401 ? "Token nesedí s dashboardom." : error.message;
    if (error.status === 0) setDown();
  } finally {
    sending = false;
    renderPreflight();
    renderSendButton();
    renderNote();
  }
}

function summarize(queued, duplicate, invalid) {
  const parts = [];
  if (queued) parts.push(queued === 1 ? "1 zaradené" : `${queued} zaradené`);
  if (duplicate) parts.push(duplicate === 1 ? "1 už v galérii" : `${duplicate} už v galérii`);
  if (invalid) parts.push(invalid === 1 ? "1 neplatná adresa ostala v poli" : `${invalid} neplatné adresy ostali v poli`);
  return parts.join(" · ") || "Nič nové.";
}

async function addTab() {
  if (!isExtension()) {
    addToComposer(["https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4?utm_source=karta&token=docasny"]);
    composerNote = "Náhľad: vkladám ukážkový súbor. V rozšírení sa vezme adresa otvorenej karty.";
    renderNote();
    return;
  }
  const response = await chrome.runtime.sendMessage({ type: "active-tab" });
  const url = response?.url || "";
  if (!/^https?:/i.test(url)) {
    composerNote = "Túto kartu nejde poslať.";
    renderNote();
    return;
  }
  addToComposer([url]);
}

async function addPage() {
  if (!isExtension()) {
    addToComposer(DEMO_HARVEST);
    composerNote = "Náhľad: ukážkové videá zo stránky. V Brave sa zoberú z otvorenej karty.";
    renderNote();
    return;
  }
  const response = await chrome.runtime.sendMessage({ type: "harvest" });
  const urls = response?.urls || [];
  if (!urls.length) {
    composerNote = response?.error || "Na tejto karte nevidím žiadne video.";
    renderNote();
    return;
  }
  addToComposer(urls);
  composerNote = urls.length === 1 ? "Našiel som 1 adresu." : `Našiel som ${urls.length} adries.`;
  renderNote();
}

function addToComposer(urls) {
  const existing = splitUrls($("urls").value);
  const seen = new Set(existing);
  const next = [...existing];
  for (const url of urls) {
    if (!seen.has(url)) {
      seen.add(url);
      next.push(url);
    }
  }
  $("urls").value = next.join("\n");
  schedulePreflight();
}

async function refresh(options = {}) {
  try {
    snapshot = await api.state();
    link = "live";
    render();
    followPlayback();
    if (isExtension()) chrome.runtime.sendMessage({ type: "badge" }).catch(() => {});
  } catch (error) {
    if (!options.quiet) composerNote = error.status === 401 ? "Token nesedí s dashboardom." : "";
    setDown();
    renderNote();
  }
}

function setDown() {
  link = snapshot ? "stale" : "down";
  renderConnection();
  renderNow();
}

function connect() {
  api.eventsUrl().then((url) => {
    if (events) events.close();
    events = null;
    if (!url) return;
    events = new EventSource(url);
    events.addEventListener("state", (event) => {
      snapshot = JSON.parse(event.data);
      link = "live";
      render();
      followPlayback();
    });
    events.addEventListener("update", () => refresh({ quiet: true }));
    events.onerror = () => {
      if (link === "live") setDown();
    };
  }).catch(() => setDown());
}

function followPlayback() {
  if (!$("sync").checked) return;
  const id = snapshot?.playback?.itemId;
  if (!id || id === playingId) return;
  const item = snapshot.items.find((entry) => entry.id === id);
  if (item?.status === "ready") {
    tab = "play";
    renderTabs();
    loadPlayer(item, { autoplay: true, remote: true });
  }
}

function render() {
  renderConnection();
  renderNow();
  renderTabs();
  renderView();
  renderNote();
  renderSendButton();
}

function renderConnection() {
  const rail = $("rail");
  rail.className = "rail";
  if (link === "boot") {
    $("conn-sub").textContent = "Pripájam sa…";
    return;
  }
  if (link === "down" || link === "stale") {
    rail.classList.add("down");
    $("conn-sub").textContent = link === "stale" ? "Spojenie spadlo · údaje nemusia byť čerstvé" : "Dashboard neodpovedá";
    return;
  }
  if (snapshot?.worker?.state === "running") rail.classList.add("running");
  else rail.classList.add("live");
  let host = settings.apiBase;
  try {
    host = new URL(settings.apiBase).host;
  } catch {
    /* keep raw */
  }
  $("conn-sub").textContent = `Pripojené · ${host}`;
  refreshOfflineQueueStatus();
}

async function refreshOfflineQueueStatus() {
  const btn = $("btn-offline-flush");
  if (!btn || !isExtension()) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: "offline-queue-status" });
    const count = Number(res?.count || 0);
    btn.hidden = count <= 0;
    btn.textContent = `Fronta (${count})`;
  } catch {
    btn.hidden = true;
  }
}

async function flushOfflineQueue() {
  if (!isExtension()) return;
  const btn = $("btn-offline-flush");
  if (btn) btn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: "flush-offline-queue" });
    if (res?.offline) {
      composerNote = `Server stále offline · čaká ${res.remaining} položiek`;
    } else if (res) {
      composerNote = `Offline fronta: odoslané ${res.sent || 0}, zostáva ${res.remaining || 0}`;
      await refresh();
    }
    renderNote();
    await refreshOfflineQueueStatus();
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderNow() {
  const worker = snapshot?.worker;
  const stats = snapshot?.stats;
  if (!snapshot) {
    $("now-title").textContent = link === "down" ? "Bez spojenia" : "Pripájam sa";
    $("now-sub").textContent = link === "down"
      ? "Skontroluj, či beží Nexus Gallery, a adresu v nastaveniach."
      : "Hľadám dashboard.";
    $("now-bar").style.width = "0%";
    $("now-pct").textContent = "";
    $("now-meta").textContent = "";
    return;
  }
  const running = worker?.state === "running";
  $("now-title").textContent = worker?.label || "Čaká na ďalší import";
  $("now-sub").textContent = running ? (worker.title || "Bez názvu") : "Žiadna rozrobená úloha";
  $("now-bar").style.width = running ? `${worker.progress || 0}%` : "0%";
  $("now-pct").textContent = running ? `${worker.progress || 0}%` : "";
  $("now-meta").textContent = `${stats.ready} v galérii · ${stats.active} vo fronte · ${stats.failed} zlyhalo`;
}

function renderTabs() {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    const on = button.dataset.tab === tab;
    button.classList.toggle("on", on);
    button.setAttribute("aria-selected", on ? "true" : "false");
    const count = button.querySelector(".count");
    if (!count || !snapshot) return;
    if (button.dataset.tab === "imports") count.textContent = snapshot.stats.active ? String(snapshot.stats.active) : "";
    if (button.dataset.tab === "play") count.textContent = playlist().length || "";
    if (button.dataset.tab === "log") count.textContent = "";
  });
  $("pane-imports").hidden = tab !== "imports";
  $("pane-play").hidden = tab !== "play";
  $("pane-log").hidden = tab !== "log";
}

function renderView() {
  if (tab === "imports") renderImports();
  if (tab === "play") renderQueue();
  if (tab === "log") renderLog();
}

function renderImports() {
  const list = $("import-list");
  if (!snapshot) {
    setHtml(list, `<p class="empty">Pripájam sa na galériu.</p>`);
    return;
  }
  const query = filter.trim().toLowerCase();
  const items = sortImports(snapshot.items).filter((item) => {
    if (!query) return true;
    return `${item.title} ${item.canonical} ${item.author || ""}`.toLowerCase().includes(query);
  });
  if (!snapshot.items.length) {
    setHtml(list, `<p class="empty">Zatiaľ tu nie sú žiadne nedávne videá.</p>`);
    return;
  }
  if (!items.length) {
    setHtml(list, `<p class="empty">Nič s týmto textom v galérii nie je.</p>`);
    return;
  }
  setHtml(list, items.map(importRow).join(""));
  paintHues(list);
}

function importRow(item) {
  const active = ["queued", "resolve", "fetch", "index"].includes(item.status);
  const opened = item.id === openId;
  return `<article class="row" data-status="${esc(item.status)}">
    <button class="row-main" type="button" data-id="${esc(item.id)}">
      ${poster(item)}
      <span class="row-copy">
        <span class="row-title">${esc(item.title)}</span>
        <span class="row-sub">${esc(providerLabel(item.provider))} · ${esc(sourceLabel(item.source))} · <time data-time="${esc(item.updatedAt)}">${esc(ago(item.updatedAt))}</time></span>
        ${active ? `<span class="mini-bar"><span style="width:${Number(item.progress) || 0}%"></span></span>` : ""}
      </span>
      <span class="pill ${esc(item.status)}">${esc(statusLabel(item.status))}</span>
    </button>
    ${opened ? detail(item) : ""}
  </article>`;
}

function detail(item) {
  const stages = [
    ["resolve", "Zdroj"],
    ["fetch", "Popis"],
    ["index", "Galéria"],
  ];
  const current = stages.findIndex(([id]) => id === item.status);
  const failedAt = stages.findIndex(([id]) => id === item.failedStage);
  const bits = stages.map(([id, label], index) => {
    let cls = "";
    if (item.status === "ready" || (current > index && !["failed", "queued"].includes(item.status))) cls = "done";
    if (item.status === "ready") cls = "done";
    if (item.status === id) cls = "now";
    if (item.status === "failed" && failedAt >= 0 && index < failedAt) cls = "done";
    if (item.status === "failed" && index === failedAt) cls = "bad";
    return `<li class="${cls}">${label}</li>`;
  }).join("");
  const actions = [];
  if (item.status === "ready") actions.push(`<button type="button" data-act="play" data-id="${esc(item.id)}">${icon("play")}<span>Prehrať</span></button>`);
  actions.push(`<a href="${esc(item.url)}" target="_blank" rel="noreferrer">${icon("external")}<span>Zdroj</span></a>`);
  return `<div class="detail">
    <ol class="stages">${bits}</ol>
    ${item.error ? `<p class="error">${esc(item.error)}</p>` : ""}
    <p class="canonical">${esc(item.canonical)}</p>
    ${item.url !== item.canonical ? `<p class="canonical dim">Pôvodne ${esc(item.url)}</p>` : ""}
    <div class="row-actions">${actions.join("")}</div>
  </div>`;
}

function poster(item, wide = false) {
  const thumb = item.thumbnail
    ? `<img src="${esc(item.thumbnail)}" alt="" />`
    : `<span class="mark"></span>`;
  const duration = item.durationSec
    ? `<span class="dur">${esc(clock(item.durationSec))}</span>`
    : "";
  return `<span class="poster${wide ? " wide" : ""}" data-hue="${hue(item.canonical)}">${thumb}${duration}</span>`;
}

function renderQueue() {
  const queue = $("queue");
  const items = playlist();
  $("play-all").disabled = !items.length;
  if (!snapshot) {
    setHtml(queue, "");
    return;
  }
  if (!items.length) {
    setHtml(queue, `<p class="empty">Keď bude video v galérii, dá sa spustiť odtiaľto.</p>`);
    return;
  }
  setHtml(queue, items.map((item) => `<div class="q-row${item.id === playingId ? " on" : ""}" data-id="${esc(item.id)}" draggable="true">
      <button class="q-play" type="button" data-queue-act="play" title="Prehrať">${poster(item)}</button>
      <span class="row-copy"><span class="row-title">${esc(item.title)}</span><span class="row-sub">${esc(providerLabel(item.provider))} · ⠿ potiahni na zmenu poradia</span></span>
      <button class="q-remove" type="button" data-queue-act="remove" title="Odobrať z poradia">×</button>
    </div>`).join(""));
  paintHues(queue);
}

function renderLog() {
  const list = $("log-list");
  if (!snapshot?.activity?.length) {
    setHtml(list, `<li class="empty">Zatiaľ ticho. Keď niečo príde do galérie, ostane to tu.</li>`);
    return;
  }
  setHtml(list, snapshot.activity.map((entry) => `<li class="log ${esc(entry.tone)}">
      <time data-time="${esc(entry.at)}">${esc(ago(entry.at))}</time>
      <span>${esc(entry.text)}</span>
    </li>`).join(""));
}

function renderPreflight() {
  const list = $("preflight");
  if (!preflight.length) {
    setHtml(list, "");
    return;
  }
  setHtml(list, preflight.map((result) => {
    if (result.verdict === "invalid") {
      return `<li class="pf bad"><span class="pill failed">Neplatné</span><span><b>${esc(result.input)}</b><small>${esc(result.reason || "")}</small></span></li>`;
    }
    if (result.verdict === "duplicate") {
      const title = result.item?.title || shortUrl(result.canonical);
      const play = result.item?.status === "ready"
        ? `<button type="button" data-act="play" data-id="${esc(result.item.id)}">Prehrať</button>`
        : "";
      return `<li class="pf ok"><span class="pill ready">V galérii</span><span><b>${esc(title)}</b><small>${esc(result.host || "")} · ${esc(statusLabel(result.item?.status || "ready"))}</small></span>${play}</li>`;
    }
    return `<li class="pf new"><span class="pill queued">Nové</span><span><b>${esc(shortUrl(result.canonical))}</b><small>${esc(result.host || "")}</small></span></li>`;
  }).join(""));
}

function shortUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    const path = `${url.pathname}${url.search}`;
    return `${url.hostname.replace(/^www\./, "")}${path === "/" ? "" : path}`;
  } catch {
    return value;
  }
}

function renderSendButton() {
  const button = $("btn-send");
  const urls = splitUrls($("urls").value);
  const fresh = preflight.filter((result) => result.verdict === "new").length;
  const duplicate = preflight.filter((result) => result.verdict === "duplicate").length;
  const known = preflight.length > 0 && preflight.length === urls.length;
  button.disabled = sending || !urls.length || (known && fresh === 0);
  if (sending) {
    button.textContent = "Posielam…";
    return;
  }
  if (!urls.length) {
    button.textContent = "Vlož adresu";
    return;
  }
  if (known && fresh === 0 && duplicate) {
    button.textContent = "Všetko už v galérii";
    return;
  }
  if (known && fresh) {
    button.textContent = fresh === 1 ? "Zaradiť 1 nové" : `Zaradiť ${fresh} nové`;
    return;
  }
  button.textContent = "Skontrolovať a zaradiť";
}

function renderNote() {
  $("composer-note").textContent = composerNote;
}

function onImportClick(event) {
  const action = event.target.closest("[data-act]");
  if (action) {
    act(action.dataset.act, action.dataset.id);
    return;
  }
  if (event.target.closest("a")) return;
  const row = event.target.closest("[data-id]");
  if (!row) return;
  openId = openId === row.dataset.id ? null : row.dataset.id;
  renderImports();
}

function onQueueClick(event) {
  const row = event.target.closest("[data-id]");
  if (!row || !snapshot) return;
  if (event.target.closest('[data-queue-act="remove"]')) {
    hiddenQueueIds.add(row.dataset.id);
    saveQueue();
    if (playingId === row.dataset.id) clearPlayer();
    renderQueue();
    renderTabs();
    return;
  }
  const item = snapshot.items.find((entry) => entry.id === row.dataset.id);
  if (!item) return;
  autoadvance = false;
  loadPlayer(item, { autoplay: true });
}

function onPreflightClick(event) {
  const action = event.target.closest("[data-act='play']");
  if (!action) return;
  act("play", action.dataset.id);
}

async function act(name, id) {
  if (name === "play") {
    const item = snapshot?.items.find((entry) => entry.id === id);
    if (!item) return;
    tab = "play";
    autoadvance = false;
    renderTabs();
    loadPlayer(item, { autoplay: true });
  }
}

function playAll() {
  const items = playlist();
  if (!items.length) return;
  autoadvance = true;
  tab = "play";
  renderTabs();
  loadPlayer(items[0], { autoplay: true });
}

function step(direction, { wrap = true } = {}) {
  const items = playlist();
  if (!items.length) return;
  const index = items.findIndex((item) => item.id === playingId);
  let nextIndex = (index < 0 ? 0 : index) + direction;
  if (!wrap && (nextIndex < 0 || nextIndex >= items.length)) return;
  nextIndex = (nextIndex + items.length) % items.length;
  loadPlayer(items[nextIndex], { autoplay: true });
}

function loadPlayer(item, { autoplay, resumeAt = 0 } = {}) {
  playingId = item.id;
  $("player-shell").hidden = false;
  $("player-title").textContent = item.title;
  $("player-sub").textContent = `${providerLabel(item.provider)} · ${siteHost(item.canonical)}`;
  $("open-source").href = item.url || item.canonical;
  $("player-frame").hidden = true;
  $("player-fallback").hidden = true;
  player.load(item, { autoplay, resumeAt });
  renderQueue();
}

function clearPlayer() {
  playingId = null;
  player.stop();
  $("player-shell").hidden = true;
}

function tickTimes() {
  document.querySelectorAll("[data-time]").forEach((node) => {
    node.textContent = ago(node.dataset.time);
  });
}

function toggleSettings(open) {
  settingsOpen = open;
  $("settings").hidden = !open;
  if (open) $("api-base").focus();
}

async function saveForm(event) {
  event.preventDefault();
  settings = await saveSettings({
    apiBase: $("api-base").value.trim() || settings.apiBase,
    token: $("api-token").value.trim(),
    sync: $("sync").checked,
  });
  $("settings-msg").textContent = "Uložené.";
  if (events) events.close();
  connect();
  refresh();
}

async function testConnection() {
  const previous = settings;
  settings = {
    ...settings,
    apiBase: $("api-base").value.trim() || settings.apiBase,
    token: $("api-token").value.trim(),
  };
  try {
    await api.health();
    await api.state();
    $("settings-msg").textContent = "Spojenie je v poriadku.";
  } catch (error) {
    $("settings-msg").textContent = error.status === 401 ? "Token nesedí s dashboardom." : "Dashboard neodpovedá.";
  } finally {
    settings = previous;
  }
}

function setHtml(element, html) {
  if (element.__html === html) return;
  element.__html = html;
  element.innerHTML = html;
}

function paintHues(root) {
  root.querySelectorAll("[data-hue]").forEach((node) => node.style.setProperty("--hue", node.dataset.hue));
}

boot();
