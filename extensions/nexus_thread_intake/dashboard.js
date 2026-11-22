const state = {
  tabId: 0,
  tabUrl: "",
  threadTitle: "Thread links",
  pagination: { currentPage: 1, totalPages: 1, pageTemplate: "" },
  posts: [],
  candidates: [],
  selected: new Set(),
  failedPages: [],
  scope: "current",
  auto: false,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value) => String(value || "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
const AUTO_SCAN_PAGE_LIMIT = 3;

function canonicalUrl(raw) {
  try {
    const url = new URL(raw);
    if (!/mega\.(?:nz|io)/i.test(url.hostname)) {
      [...url.searchParams.keys()].filter(key => /^utm_|^fbclid$/i.test(key)).forEach(key => url.searchParams.delete(key));
      url.hash = "";
    }
    return url.href.replace(/\/$/, "");
  } catch (_) {
    return raw;
  }
}

function selectedCandidates() {
  return state.candidates.filter(candidate => state.selected.has(candidate.key));
}

function setStatus(message, tone = "") {
  const node = $("#connectionState");
  node.textContent = message;
  node.dataset.tone = tone;
}

function pageUrl(page) {
  return state.pagination.pageTemplate.replace("{{page}}", String(page));
}

function recomputeCandidates() {
  // A rescan must not silently reselect a link the user deliberately cleared.
  // Newly discovered supported links remain selected by default.
  const knownKeys = new Set(state.candidates.map(candidate => candidate.key));
  const previousSelection = new Set(state.selected);
  const byUrl = new Map();
  let found = 0;
  state.posts.forEach(post => post.links.forEach(link => {
    found += 1;
    const key = canonicalUrl(link.url);
    if (byUrl.has(key)) {
      byUrl.get(key).occurrences += 1;
      return;
    }
    byUrl.set(key, { ...link, key, occurrences: 1, post });
  }));
  state.candidates = [...byUrl.values()].map((candidate, index) => ({ ...candidate, number: index + 1 }));
  state.selected = new Set(state.candidates
    .filter(candidate => previousSelection.has(candidate.key) || (!knownKeys.has(candidate.key) && candidate.supported))
    .map(candidate => candidate.key));
  $("#foundCount").textContent = found;
  $("#readyCount").textContent = state.candidates.filter(candidate => candidate.supported).length;
  $("#dupeCount").textContent = found - state.candidates.length;
  $("#heldCount").textContent = state.candidates.filter(candidate => !candidate.supported).length;
  $("#testerRangeStart").value = 1;
  $("#testerRangeEnd").value = state.candidates.length || 1;
}

function renderScanReport() {
  const node = $("#scanReport");
  if (!state.failedPages.length) {
    node.hidden = true;
    node.textContent = "";
    return;
  }
  const pages = state.failedPages.map(({ page }) => page).join(", ");
  node.textContent = `Nepodarilo sa prečítať stranu ${pages}; zobrazené sú iba úspešne načítané strany. Znova načítať môžeš bezpečne spustiť neskôr.`;
  node.hidden = false;
}

function updateSourceFilter() {
  const select = $("#sourceFilter");
  const current = select.value;
  const sources = [...new Set(state.candidates.map(candidate => candidate.host).filter(Boolean))].sort();
  select.innerHTML = '<option value="">Všetky source</option>';
  sources.forEach(source => {
    const option = document.createElement("option");
    option.value = source;
    option.textContent = source;
    select.appendChild(option);
  });
  if (sources.includes(current)) select.value = current;
}

function visibleCandidates() {
  const search = $("#searchInput").value.trim().toLowerCase();
  const source = $("#sourceFilter").value;
  const onlySupported = $("#onlySupported").checked;
  return state.candidates.filter(candidate => {
    const haystack = `${candidate.text} ${candidate.url} ${candidate.postAuthor} ${candidate.host} ${candidate.context}`.toLowerCase();
    return (!search || haystack.includes(search))
      && (!source || candidate.host === source)
      && (!onlySupported || candidate.supported);
  });
}

function render() {
  updateSourceFilter();
  const visible = visibleCandidates();
  const groups = new Map();
  visible.forEach(candidate => {
    const key = candidate.post.postId;
    if (!groups.has(key)) groups.set(key, { post: candidate.post, links: [] });
    groups.get(key).links.push(candidate);
  });
  const container = $("#results");
  container.innerHTML = "";
  if (!visible.length) {
    container.innerHTML = '<div class="empty"><span>◇</span><h2>Žiadne odkazy pre tento filter</h2><p>Skús zmeniť vyhľadávanie alebo ukázať aj odkazy na kontrolu.</p></div>';
  }
  for (const group of groups.values()) {
    const node = $("#postTemplate").content.firstElementChild.cloneNode(true);
    node.querySelector(".post-author").textContent = group.post.author || "Neznámy autor";
    node.querySelector(".post-context").textContent = group.post.textContent || "Bez doplnkového textu";
    const source = node.querySelector(".post-link");
    if (group.post.postUrl) source.href = group.post.postUrl; else source.remove();
    const list = node.querySelector(".link-list");
    group.links.forEach(candidate => {
      const row = document.createElement("label");
      row.className = "link-row";
      row.innerHTML = `
        <span class="link-number">${candidate.number}</span>
        <input type="checkbox" data-key="${esc(candidate.key)}" ${state.selected.has(candidate.key) ? "checked" : ""}>
        <span class="link-main"><span class="link-title">${esc(candidate.text || candidate.url)}</span><span class="link-url">${esc(candidate.url)}</span></span>
        <span class="tag ${candidate.supported ? "ready" : "held"}">${esc(candidate.supported ? candidate.host : "kontrola")}</span>
        <span class="duplicate">${candidate.occurrences > 1 ? `×${candidate.occurrences}` : ""}</span>`;
      row.querySelector("input").addEventListener("change", event => {
        if (event.target.checked) state.selected.add(candidate.key); else state.selected.delete(candidate.key);
        updateSelection();
      });
      list.appendChild(row);
    });
    container.appendChild(node);
  }
  updateSelection();
}

function updateSelection() {
  const count = selectedCandidates().length;
  const max = state.candidates.length || 1;
  const startInput = $("#testerRangeStart");
  const endInput = $("#testerRangeEnd");
  startInput.max = max;
  endInput.max = max;
  const range = selectedCandidatesInRange();
  const testerButton = $("#testerBtn");
  if (testerButton.dataset.sent) {
    testerButton.innerHTML = "Poslať do Testera <span>→</span>";
    delete testerButton.dataset.sent;
  }
  $("#selectedCount").textContent = count;
  $("#testerRangeCount").textContent = `${range.links.length} v rozsahu`;
  testerButton.disabled = !range.links.length;
  $("#downloadJsonBtn").disabled = !count;
}

function selectedCandidatesInRange() {
  const max = state.candidates.length;
  const start = Number($("#testerRangeStart").value);
  const end = Number($("#testerRangeEnd").value);
  if (!max || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > max || start > end) {
    return { start, end, links: [] };
  }
  return {
    start,
    end,
    links: selectedCandidates().filter(candidate => candidate.number >= start && candidate.number <= end),
  };
}

function downloadSelectedJson() {
  const links = selectedCandidates();
  if (!links.length) return;
  const payload = {
    exported_at: new Date().toISOString(),
    thread_title: state.threadTitle,
    thread_url: state.tabUrl,
    scope: state.scope,
    pagination: state.pagination,
    failed_pages: state.failedPages,
    count: links.length,
    links: links.map(link => ({
      url: link.url, host: link.host, text: link.text, context: link.context,
      quality: link.quality, supported: link.supported, occurrences: link.occurrences,
      post_author: link.postAuthor, post_id: link.postId, post_url: link.post?.postUrl || "",
      timestamp: link.timestamp,
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const title = state.threadTitle
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "thread-links";
  anchor.href = url;
  anchor.download = `${title}-links.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  setStatus(`${links.length} odkazov stiahnutých ako JSON`, "ready");
}

async function injectAndMessage(message) {
  const send = () => new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(state.tabId, message, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
  try {
    return await send();
  } catch (_) {
    await chrome.scripting.executeScript({ target: { tabId: state.tabId }, files: ["content.js"] });
    return send();
  }
}

async function scan() {
  $("#scanBtn").disabled = true;
  setStatus("Čítam thread…");
  try {
    const first = await injectAndMessage({ action: "nexusThreadIntake.scrapeCurrent" });
    if (!first?.ok) throw new Error(first?.error || "Stránku sa nepodarilo prečítať.");
    state.threadTitle = first.data.threadTitle || "Thread links";
    state.tabUrl = first.data.currentUrl || state.tabUrl;
    state.pagination = first.data.pagination || state.pagination;
    let pages = [];
    state.failedPages = [];
    let start = state.pagination.currentPage;
    let end = start;
    if (state.scope === "all") { start = 1; end = state.pagination.totalPages; }
    if (state.scope === "range") {
      start = Number($("#fromPage").value) || 1;
      end = Math.min(Number($("#toPage").value) || start, state.pagination.totalPages);
      if (start > end) throw new Error("Začiatok rozsahu musí byť pred koncom.");
    }
    if (state.pagination.currentPage >= start && state.pagination.currentPage <= end) {
      pages.push(first.data);
    }
    if (end > start && !state.pagination.pageTemplate) throw new Error("Thread nemá rozpoznateľné stránkovanie. Použi túto stránku.");
    for (let page = start; page <= end; page += 1) {
      if (page === state.pagination.currentPage) continue;
      setStatus(`Čítam stranu ${page} z ${end}…`);
      const response = await injectAndMessage({ action: "nexusThreadIntake.scrapeUrl", url: pageUrl(page) });
      if (response?.ok) pages.push(response.data);
      else state.failedPages.push({ page, error: response?.error || "neznáma chyba" });
    }
    state.posts = pages.flatMap(page => page.posts || []);
    $("#threadTitle").textContent = state.threadTitle;
    $("#threadUrl").textContent = state.tabUrl;
    $("#fromPage").max = state.pagination.totalPages;
    $("#toPage").max = state.pagination.totalPages;
    $("#toPage").value = state.pagination.totalPages;
    recomputeCandidates();
    render();
    renderScanReport();
    const loadedPages = pages.length;
    const failed = state.failedPages.length;
    setStatus(
      failed
        ? `${state.candidates.length} odkazov z ${loadedPages} strán; ${failed} strán sa nepodarilo prečítať`
        : `${state.candidates.length} unikátnych odkazov pripravených`,
      failed ? "warning" : "ready",
    );
  } catch (error) {
    setStatus(error.message || "Zber zlyhal.", "error");
    if (state.candidates.length) {
      render();
      $("#scanReport").textContent = `Zber sa nedokončil: ${error.message || "Skús to znova z otvoreného threadu."} Predchádzajúci výber zostal zachovaný.`;
      $("#scanReport").hidden = false;
    } else {
      $("#results").innerHTML = `<div class="empty"><span>!</span><h2>Zber sa nepodaril</h2><p>${esc(error.message || "Skús to znova z otvoreného threadu.")}</p></div>`;
    }
  } finally {
    $("#scanBtn").disabled = false;
  }
}

async function sendToTester() {
  const range = selectedCandidatesInRange();
  const links = range.links;
  if (!links.length) {
    setStatus("Zadaj platný rozsah, ktorý obsahuje aspoň jeden vybraný odkaz.", "warning");
    return;
  }
  const button = $("#testerBtn");
  button.disabled = true;
  button.textContent = "Posielam do Testera…";
  const supportedLinks = links.filter(link => link.supported);
  const threadId = (state.tabUrl.match(/\/threads\/[^/]*\.(\d+)(?:\/|$)/i) || [])[1] || "";
  const cleanThreadUrl = state.tabUrl ? state.tabUrl.replace(/\/(?:page-\d+|unread|latest|post-\d+)\/?(?:#.*)?$/i, "").replace(/\/$/, "") + "/" : "";
  const payload = {
    thread_title: state.threadTitle,
    thread_url: state.tabUrl,
    threads: state.threadTitle ? [{
      id: threadId,
      title: state.threadTitle,
      url: cleanThreadUrl || state.tabUrl,
      linkCount: supportedLinks.length,
    }] : [],
    links: supportedLinks.map(link => ({
      url: link.url, host: link.host, text: link.text, context: link.context,
      quality: link.quality, postAuthor: link.postAuthor, postId: link.postId,
      timestamp: link.timestamp,
      threadId: link.threadId || threadId,
      threadTitle: link.threadTitle || state.threadTitle,
      threadUrl: link.threadUrl || cleanThreadUrl || state.tabUrl,
      postUrl: link.postUrl || link.post?.postUrl || "",
      thumbnail: link.thumbnail || "",
    })),
  };
  const bases = ["http://localhost:8000", "http://localhost:8001", "http://localhost:8002"];
  let lastError = null;
  for (const base of bases) {
    try {
      const response = await fetch(`${base}/api/v1/hunter/push`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data.session_id) throw new Error("Nexus nevrátil session ID.");
      setStatus(`${data.count || links.length} odkazov č. ${range.start}–${range.end} čaká v Testeri`, "ready");
      const autoImport = state.auto ? "&autoimport=1" : "";
      await chrome.tabs.create({ url: `${base}/tester?hunter=1&session=${encodeURIComponent(data.session_id)}&autostart=1&autoselect=1${autoImport}` });
      button.innerHTML = "Otvorené v Testeri <span>↗</span>";
      button.dataset.sent = "true";
      return;
    } catch (error) { lastError = error; }
  }
  button.innerHTML = "Poslať do Testera <span>→</span>";
  button.disabled = false;
  setStatus(`Nexus nie je dostupný: ${lastError?.message || "neznáma chyba"}`, "error");
}

async function boot() {
  if (!globalThis.chrome?.tabs) {
    setStatus("Túto obrazovku otvor z ikony rozšírenia v Chrome.");
    return;
  }
  const params = new URLSearchParams(location.search);
  state.tabId = Number(params.get("tabId"));
  state.tabUrl = params.get("url") || "";
  const automatic = params.get("auto") === "1";
  state.auto = automatic;
  if (!state.tabId) { setStatus("Chýba aktívny tab threadu.", "error"); return; }
  $$(".scope").forEach(button => button.addEventListener("click", () => {
    state.scope = button.dataset.scope;
    $$(".scope").forEach(node => node.classList.toggle("active", node === button));
    $("#rangeControls").classList.toggle("hidden", state.scope !== "range");
  }));
  $("#scanBtn").addEventListener("click", scan);
  $("#searchInput").addEventListener("input", render);
  $("#sourceFilter").addEventListener("change", render);
  $("#onlySupported").addEventListener("change", render);
  $("#selectVisibleBtn").addEventListener("click", () => { visibleCandidates().forEach(link => state.selected.add(link.key)); render(); });
  $("#clearVisibleBtn").addEventListener("click", () => { visibleCandidates().forEach(link => state.selected.delete(link.key)); render(); });
  $("#selectReadyBtn").addEventListener("click", () => { state.candidates.filter(link => link.supported).forEach(link => state.selected.add(link.key)); render(); });
  $("#clearSelectionBtn").addEventListener("click", () => { state.selected.clear(); render(); });
  $("#testerRangeStart").addEventListener("input", updateSelection);
  $("#testerRangeEnd").addEventListener("input", updateSelection);
  $("#downloadJsonBtn").addEventListener("click", downloadSelectedJson);
  $("#testerBtn").addEventListener("click", sendToTester);
  if (automatic) {
    state.scope = "range";
    $("#fromPage").value = "1";
    $("#toPage").value = String(AUTO_SCAN_PAGE_LIMIT);
    $$(".scope").forEach(button => button.classList.toggle("active", button.dataset.scope === "range"));
    $("#rangeControls").classList.remove("hidden");
  }
  await scan();
  if (automatic && state.candidates.length && !state.failedPages.length) {
    await sendToTester();
  } else if (automatic && state.failedPages.length) {
    setStatus("Niektoré strany sa nepodarilo načítať; skontroluj zber pred odoslaním.", "warning");
  } else if (automatic) {
    setStatus("Na prvých troch stranách sa nenašli odkazy na odoslanie.", "warning");
  }
}

document.addEventListener("DOMContentLoaded", boot);
