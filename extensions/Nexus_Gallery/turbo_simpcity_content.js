(() => {
  const TURBO_RE = /(?:https?:)?\/\/turbo\.cr\/(?:embed|v|d)\/[A-Za-z0-9_-]+/gi;
  const IS_TURBO_HOST = /(^|\.)turbo\.cr$/i.test(location.hostname);
  const IS_TOP_WINDOW = (() => {
    try {
      return window.top === window;
    } catch {
      return true;
    }
  })();
  const SHOULD_RENDER_UI = false; // Vypnuté na žiadosť používateľa (vizuálny panel a popup vypnutý)
  const PORTS = [8001, 8000, 8002];

  const found = new Map(); // url -> { title, sizeBytes, sizeText, durationSec }
  const resolving = new Set();
  const sizes = new Map(); // url -> formatted size text
  let contextActive = true;
  let scanInterval = null;

  function stopScanner() {
    contextActive = false;
    if (scanInterval !== null) clearInterval(scanInterval);
    scanInterval = null;
    resolving.clear();
  }

  function getRuntime() {
    try {
      const runtime = globalThis.chrome?.runtime;
      if (contextActive && runtime?.id && typeof runtime.sendMessage === "function") return runtime;
    } catch {}
    stopScanner();
    return null;
  }

  // Content scripts on already-open forum tabs survive an extension reload,
  // but their runtime connection does not. Retire their polling loop and
  // complete pending callers with an error instead of throwing every 2.5 s.
  function sendBackground(message, callback = () => {}) {
    const runtime = getRuntime();
    if (!runtime) {
      callback({ ok: false, error: "Rozšírenie bolo obnovené. Obnov túto stránku." });
      return;
    }
    let completed = false;
    const finish = (response, error) => {
      if (completed) return;
      completed = true;
      if (/extension context invalidated/i.test(error || "")) stopScanner();
      callback(error ? { ok: false, error } : response);
    };
    try {
      runtime.sendMessage(message, (response) => {
        let error;
        try {
          error = runtime.lastError?.message;
        } catch (failure) {
          error = failure?.message || String(failure);
        }
        if (!getRuntime()) error = "Rozšírenie bolo obnovené. Obnov túto stránku.";
        finish(response, error);
      });
    } catch (error) {
      finish(null, error?.message || String(error));
    }
  }

  let panel = null;
  let toggleBtn = null;
  let albumModal = null;
  let lastPanelCount = -1;
  let lastModalCount = -1;
  let isClosed = localStorage.getItem("nexus-turbo-closed") === "true";
  let albumPopupDismissed = sessionStorage.getItem("nexus-turbo-album-dismissed") === "1";
  let albumAutoOpen = localStorage.getItem("nexus-turbo-album-auto-open") !== "false";

  function isAlbumPage() {
    return /^\/a\/[A-Za-z0-9_-]+/i.test(location.pathname || "");
  }

  function normalize(raw) {
    try {
      const full = String(raw || "").startsWith("//") ? `https:${raw}` : String(raw || "");
      const url = new URL(full, location.href);
      const match = url.pathname.match(/\/(?:embed|v|d)\/([^/?#]+)/i);
      if (!/turbo\.cr$/i.test(url.hostname) || !match) return null;
      return `${url.protocol}//${url.host}/v/${match[1]}`;
    } catch {
      return null;
    }
  }

  function esc(value) {
    return String(value || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  function titleFor(el) {
    const post = el?.closest?.("article, .message, .message-inner, .message-content, [data-content]");
    const postTitle = post?.querySelector?.(".message-attribution, h1, h2, h3")?.textContent?.trim();
    return postTitle || document.title.replace(/\s*[-|].*$/, "").trim() || "Turbo video";
  }

  function parseSizeBytes(sizeText) {
    const m = String(sizeText || "").match(/(\d+(?:[.,]\d+)?)\s*(KB|MB|GB|TB)\b/i);
    if (!m) return 0;
    const num = Number(m[1].replace(",", "."));
    if (!Number.isFinite(num) || num <= 0) return 0;
    const unit = m[2].toUpperCase();
    const mul = unit === "KB" ? 1024 : unit === "MB" ? 1024 ** 2 : unit === "GB" ? 1024 ** 3 : 1024 ** 4;
    return Math.round(num * mul);
  }

  function extractSizeText(text) {
    const m = String(text || "").match(/(\d+(?:[.,]\d+)?)\s*(KB|MB|GB|TB)\b/i);
    return m ? `${m[1]} ${m[2].toUpperCase()}` : "";
  }

  function parseDurationSec(text) {
    const m = String(text || "").match(/(^|\s)(\d{1,2}:\d{2}(?::\d{2})?)(\s|$)/);
    if (!m) return 0;
    const parts = m[2].split(":").map((p) => Number(p));
    if (parts.some((n) => !Number.isFinite(n))) return 0;
    return parts.length === 3
      ? (parts[0] * 3600 + parts[1] * 60 + parts[2])
      : (parts[0] * 60 + parts[1]);
  }

  function formatDuration(sec) {
    const s = Number(sec || 0);
    if (!Number.isFinite(s) || s <= 0) return "--:--";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = Math.floor(s % 60);
    return h > 0
      ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
      : `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }

  function formatSize(bytes) {
    const n = Number(bytes || 0);
    if (!Number.isFinite(n) || n <= 0) return "";
    if (n >= 1024 ** 3) return `${(n / (1024 ** 3)).toFixed(2)} GB`;
    if (n >= 1024 ** 2) return `${(n / (1024 ** 2)).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
  }

  function mergeEntry(url, payload = {}) {
    const prev = found.get(url) || {};
    const merged = {
      title: payload.title || prev.title || "Turbo video",
      sizeBytes: Number(payload.sizeBytes || prev.sizeBytes || 0) || 0,
      sizeText: payload.sizeText || prev.sizeText || "",
      durationSec: Number(payload.durationSec || prev.durationSec || 0) || 0,
    };
    if (!merged.sizeText && merged.sizeBytes > 0) merged.sizeText = formatSize(merged.sizeBytes);
    found.set(url, merged);
    if (merged.sizeText) sizes.set(url, merged.sizeText);
  }

  function add(raw, title, payload = {}) {
    const url = normalize(raw);
    if (!url) return;
    mergeEntry(url, { ...payload, title: title || payload.title || "Turbo video" });
    enrichMetadata(url);
    render();
  }

  function enrichMetadata(url) {
    if (!url || resolving.has(url)) return;
    const current = found.get(url) || {};
    if (current.durationSec > 0 && current.sizeBytes > 0) return;
    resolving.add(url);

    sendBackground({ action: "NEXUS_TURBO_RESOLVE", url }, (res) => {
      if (res?.ok) {
        const durationSec = Number(res?.duration || 0) || 0;
        const title = String(res?.title || "").trim();
        if (durationSec > 0 || title) {
          mergeEntry(url, { durationSec, title });
        }

        const streamUrl = String(res?.streamUrl || "").trim();
        const after = found.get(url) || {};
        if (streamUrl && (!after.sizeBytes || after.sizeBytes <= 0)) {
          sendBackground({ action: "FETCH_HEAD_INFO", url: streamUrl, referer: url }, (info) => {
            const len = Number(info?.contentLength || 0) || 0;
            if (len > 0) {
              mergeEntry(url, { sizeBytes: len, sizeText: formatSize(len) });
              render();
            }
          });
        }
      }
      resolving.delete(url);
      render();
    });
  }

  function importUrls(urls, port) {
    const selected = Array.from(new Set((urls || []).filter(Boolean)));
    if (!selected.length) {
      toast("No videos selected", true);
      return;
    }
    const items = selected.map((url) => {
      const meta = found.get(url) || {};
      return {
        url,
        title: meta.title || "Turbo video",
        duration: Number(meta.durationSec || 0) || 0,
        sizeBytes: Number(meta.sizeBytes || 0) || 0,
      };
    });

    sendBackground({
      action: "NEXUS_TURBO_IMPORT_BULK",
      items,
      port,
      batchName: `Turbo Album Import ${new Date().toLocaleDateString()}`,
    }, (res) => {
      if (res?.ok) {
        toast(`Imported ${res.imported || 0}/${res.requested || items.length} to ${port}`);
      } else {
        toast(`Turbo import failed: ${res?.error || "unknown"}`, true);
      }
    });
  }

  function collectCheckedUrls() {
    if (!albumModal) return [];
    return Array.from(albumModal.querySelectorAll("input[data-url]:checked")).map((n) => n.getAttribute("data-url"));
  }

  function closeAlbumModal(persist = true) {
    if (!albumModal) return;
    albumModal.remove();
    albumModal = null;
    if (persist) {
      albumPopupDismissed = true;
      sessionStorage.setItem("nexus-turbo-album-dismissed", "1");
    }
  }

  function toggleAlbumAutoOpen() {
    albumAutoOpen = !albumAutoOpen;
    localStorage.setItem("nexus-turbo-album-auto-open", String(albumAutoOpen));
    const state = albumAutoOpen ? "ON" : "OFF";
    toast(`Auto album popup: ${state}`);
    render();
  }

  function openAlbumImporterManually() {
    if (!SHOULD_RENDER_UI) return;
    if (!isAlbumPage()) {
      toast("Open this on turbo album page (/a/...)", true);
      return;
    }
    if (!found.size) {
      toast("Waiting for album videos to scan...");
      return;
    }
    albumPopupDismissed = false;
    sessionStorage.removeItem("nexus-turbo-album-dismissed");
    renderAlbumModal(true);
  }

  function renderAlbumModal(force = false) {
    if (!SHOULD_RENDER_UI) return;
    if (!isAlbumPage() || !found.size) return;
    if (!force && (!albumAutoOpen || albumPopupDismissed)) return;
    if (!document.body) return;

    if (!albumModal) {
      albumModal = document.createElement("div");
      albumModal.id = "nexus-turbo-album-modal";
      document.body.appendChild(albumModal);
    }

    const entries = Array.from(found.entries()).slice(0, 120);
    if (albumModal && lastModalCount === entries.length) return;
    lastModalCount = entries.length;

    albumModal.innerHTML = `
      <div class="nta-backdrop" data-close="1"></div>
      <div class="nta-dialog">
        <div class="nta-head">
          <strong>Nexus Turbo Album Import</strong>
          <button class="nta-close" data-close="1">&times;</button>
        </div>
        <div class="nta-sub">Choose single videos or import all selected. Size and duration are shown per item.</div>
        <div class="nta-toolbar">
          <label>Port
            <select id="nexus-turbo-port">
              ${PORTS.map((p, i) => `<option value="${p}" ${i === 0 ? "selected" : ""}>${p}</option>`).join("")}
            </select>
          </label>
          <button data-action="all">Import all</button>
          <button data-action="selected">Import selected</button>
        </div>
        <div class="nta-list">
          ${entries.map(([url, meta]) => `
            <div class="nta-item">
              <input type="checkbox" data-url="${esc(url)}" checked />
              <div class="nta-main">
                <div class="nta-title">${esc(meta.title || "Turbo video")}</div>
                <div class="nta-meta">
                  <span class="nta-id">${esc(url.split("/").pop() || "")}</span>
                  <span class="nta-duration">${formatDuration(meta.durationSec)}</span>
                  <span class="nta-size">${esc(meta.sizeText || "--")}</span>
                </div>
              </div>
              <button data-action="single" data-url="${esc(url)}">Import</button>
            </div>
          `).join("")}
        </div>
      </div>
    `;

    albumModal.querySelectorAll("[data-close='1']").forEach((el) => {
      el.onclick = () => closeAlbumModal(true);
    });

    albumModal.querySelectorAll("button[data-action='single']").forEach((btn) => {
      btn.onclick = (e) => {
        e.preventDefault();
        const url = btn.getAttribute("data-url") || "";
        const port = Number(albumModal.querySelector("#nexus-turbo-port")?.value || 8001) || 8001;
        importUrls([url], port);
      };
    });

    const importAllBtn = albumModal.querySelector("button[data-action='all']");
    if (importAllBtn) {
      importAllBtn.onclick = (e) => {
        e.preventDefault();
        const port = Number(albumModal.querySelector("#nexus-turbo-port")?.value || 8001) || 8001;
        importUrls(entries.map(([url]) => url), port);
      };
    }

    const importSelectedBtn = albumModal.querySelector("button[data-action='selected']");
    if (importSelectedBtn) {
      importSelectedBtn.onclick = (e) => {
        e.preventDefault();
        const port = Number(albumModal.querySelector("#nexus-turbo-port")?.value || 8001) || 8001;
        importUrls(collectCheckedUrls(), port);
      };
    }
  }

  function togglePanel() {
    isClosed = !isClosed;
    localStorage.setItem("nexus-turbo-closed", String(isClosed));
    render();
  }

  function renderPanel() {
    if (!SHOULD_RENDER_UI) return;
    if (!document.body) return;
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "nexus-simpcity-turbo-panel";
      document.body.appendChild(panel);
    }
    if (!toggleBtn) {
      toggleBtn = document.createElement("div");
      toggleBtn.id = "nexus-simpcity-turbo-toggle";
      toggleBtn.innerHTML = "<span>N</span>";
      toggleBtn.onclick = togglePanel;
      document.body.appendChild(toggleBtn);
    }

    if (isClosed) {
      panel.classList.add("is-hidden");
      toggleBtn.classList.add("is-visible");
      return;
    }
    panel.classList.remove("is-hidden");
    toggleBtn.classList.remove("is-visible");

    const entries = Array.from(found.entries()).slice(0, 20);
    if (panel && lastPanelCount === entries.length && !panel.classList.contains("is-hidden")) return;
    lastPanelCount = entries.length;

    panel.innerHTML = `
      <div class="nst-head">
        <div class="nst-head-left">
          <strong>Nexus Turbo</strong>
          <span>${entries.length} found</span>
        </div>
        <button class="nst-close" title="Close panel">&times;</button>
      </div>
      <div class="nst-tools">
        <button class="nst-mini-btn" data-action="open-album-importer">Open album importer</button>
        <button class="nst-mini-btn ${albumAutoOpen ? "is-on" : "is-off"}" data-action="toggle-album-auto">Auto album popup: ${albumAutoOpen ? "ON" : "OFF"}</button>
      </div>
      <div class="nst-list">
        ${entries.length ? entries.map(([url, meta]) => {
          const id = url.split("/").pop();
          return `
            <div class="nst-item" data-url="${esc(url)}">
              <div class="nst-item-main">
                <div class="nst-title">${esc(meta.title || "Turbo video")}</div>
                <div class="nst-meta">
                  <span class="nst-id">${esc(id || "")}</span>
                  <span class="nst-duration">${formatDuration(meta.durationSec)}</span>
                  ${meta.sizeText ? `<span class="nst-size">${esc(meta.sizeText)}</span>` : ""}
                </div>
              </div>
              <div class="nst-actions">
                ${PORTS.map((p) => `<button data-port="${p}">${p}</button>`).join("")}
                <button data-copy="1" title="Copy direct URL">Copy</button>
              </div>
            </div>
          `;
        }).join("") : `<div class="nst-empty">Scanner active. Waiting for turbo.cr embeds...</div>`}
      </div>
    `;

    panel.querySelector(".nst-close")?.addEventListener("click", togglePanel);
    panel.querySelector("button[data-action='open-album-importer']")?.addEventListener("click", openAlbumImporterManually);
    panel.querySelector("button[data-action='toggle-album-auto']")?.addEventListener("click", toggleAlbumAutoOpen);

    panel.querySelectorAll("button[data-port]").forEach((button) => {
      button.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const item = button.closest(".nst-item");
        const url = item?.getAttribute("data-url") || "";
        importUrls([url], Number(button.getAttribute("data-port") || 8001));
      };
    });

    panel.querySelectorAll("button[data-copy]").forEach((button) => {
      button.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const item = button.closest(".nst-item");
        const url = item?.getAttribute("data-url") || "";
        sendBackground({ action: "NEXUS_TURBO_RESOLVE", url }, (res) => {
          const value = String(res?.streamUrl || url || "");
          navigator.clipboard.writeText(value)
            .then(() => toast(res?.streamUrl ? "Direct URL copied" : "Turbo URL copied"))
            .catch(() => toast("Copy failed", true));
        });
      };
    });
  }

  function render() {
    if (!SHOULD_RENDER_UI) return;
    renderPanel();
    if (isAlbumPage()) renderAlbumModal();
  }

  function toast(text, error = false) {
    const node = document.createElement("div");
    node.className = `nst-toast ${error ? "is-error" : ""}`;
    node.textContent = text;
    document.body.appendChild(node);
    setTimeout(() => {
      node.style.opacity = "0";
      node.style.transform = "translateY(-10px)";
      setTimeout(() => node.remove(), 350);
    }, 2600);
  }

  function scanTurboFrame() {
    if (!IS_TURBO_HOST) return;
    add(location.href, document.title || "Turbo video");
    const video = document.querySelector("video[src], video source[src]");
    const videoUrl = video?.currentSrc || video?.src || video?.querySelector?.("source[src]")?.src;
    if (videoUrl) {
      sendBackground({
        action: "NEXUS_TURBO_CACHE_DIRECT",
        pageUrl: normalize(location.href),
        streamUrl: videoUrl,
        title: document.title || "Turbo video",
        thumbnail: document.querySelector("video")?.poster || null,
        duration: Math.round(document.querySelector("video")?.duration || 0),
      });
    }
  }

  function scanAlbumRows() {
    if (!isAlbumPage()) return;
    document.querySelectorAll("a[href*='/v/']").forEach((link) => {
      const href = link.getAttribute("href") || "";
      if (!href || /\/v\/[A-Za-z0-9_-]+/i.test(href) === false) return;

      const row = link.closest("tr, [role='row'], .file-row, li, .item, .card") || link.parentElement;
      const blockText = String(row?.innerText || "");
      const sizeText = extractSizeText(blockText);
      const sizeBytes = parseSizeBytes(sizeText);
      const durationSec = parseDurationSec(blockText);
      const title = String(link.textContent || "").trim() || titleFor(link) || "Turbo video";
      add(link.href, title, { sizeText, sizeBytes, durationSec });
    });
  }

  function scanGeneric() {
    document.querySelectorAll("iframe[src*='turbo.cr/'], iframe[data-src*='turbo.cr/']").forEach((el) => {
      const rawSrc = el.src || el.dataset.src || "";
      add(rawSrc, titleFor(el));
      // On the parent (forum) page, pre-report the turbo URL to background so popup can discover it
      if (!IS_TURBO_HOST) {
        const canonical = normalize(rawSrc);
        if (canonical) {
          sendBackground({
            action: "NEXUS_TURBO_RESOLVE",
            url: canonical,
          }, (res) => {
            if (res?.ok && res.streamUrl && !res.streamUrl.startsWith("blob:")) {
              sendBackground({
                action: "NEXUS_TURBO_CACHE_DIRECT",
                pageUrl: canonical,
                streamUrl: res.streamUrl,
                title: res.title || titleFor(el) || "Turbo video",
                thumbnail: res.thumbnail || null,
                duration: Number(res.duration || 0) || 0,
              });
            }
          });
        }
      }
    });
    document.querySelectorAll("a[href*='turbo.cr/']").forEach((el) => add(el.href, titleFor(el)));
    document.querySelectorAll("[data-url*='turbo.cr/'], [data-href*='turbo.cr/'], [data-src*='turbo.cr/']").forEach((el) => add(el.dataset.url || el.dataset.href || el.dataset.src, titleFor(el)));

    const html = document.documentElement?.innerHTML || "";
    (html.match(TURBO_RE) || []).forEach((url) => add(url, "Turbo video"));

    try {
      performance.getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter(Boolean)
        .forEach((url) => {
          if (/turbo\.cr\/(?:embed|v|d)\//i.test(url)) add(url, "Turbo video");
        });
    } catch {}
  }

  function scan() {
    if (!getRuntime()) return;
    scanTurboFrame();
    scanAlbumRows();
    scanGeneric();
    render();
  }

  console.log("[Nexus Turbo] detector active", location.href);
  scan();
  if (contextActive) scanInterval = setInterval(scan, 2500);
})();
