(() => {
  const BUTTON_ID = "hc-profile-handoff";
  const MODAL_ID = "hc-profile-handoff-modal";
  const MINIMIZED_ID = "hc-profile-handoff-minimized";
  const MODAL_GUTTER = 16;
  const MODAL_MIN_WIDTH = 360;
  const MODAL_MIN_HEIGHT = 250;
  let activeJobId = null;
  let libraryRenderId = 0;

  const supportedPage = () => true;
  const escapeHtml = (value) => String(value || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
  const modalRoot = () => document.getElementById(MODAL_ID);
  //: Accent/case-insensitive normalizer for the gallery keyword filter —
  //: matches how hotcontainer.js's own `normal()` treats text elsewhere in
  //: this handoff, so "café" and "cafe" behave the same way here too.
  const normal = (value) => String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();

  const clamp = (value, lower, upper) => Math.min(Math.max(value, lower), Math.max(lower, upper));

  function pinModalToViewport(modal) {
    const rect = modal.getBoundingClientRect();
    const maxWidth = Math.max(MODAL_MIN_WIDTH, window.innerWidth - MODAL_GUTTER * 2);
    const maxHeight = Math.max(MODAL_MIN_HEIGHT, window.innerHeight - MODAL_GUTTER * 2);
    const width = clamp(rect.width, Math.min(MODAL_MIN_WIDTH, maxWidth), maxWidth);
    const height = clamp(rect.height, Math.min(MODAL_MIN_HEIGHT, maxHeight), maxHeight);
    modal.style.inset = "auto";
    modal.style.transform = "none";
    modal.style.width = `${width}px`;
    modal.style.height = `${height}px`;
    modal.style.left = `${clamp(rect.left, MODAL_GUTTER, window.innerWidth - width - MODAL_GUTTER)}px`;
    modal.style.top = `${clamp(rect.top, MODAL_GUTTER, window.innerHeight - height - MODAL_GUTTER)}px`;
  }

  function enableWindowControls(modal) {
    if (modal.dataset.hcWindowControls) return;
    modal.dataset.hcWindowControls = "true";
    let interaction = null;
    modal.addEventListener("pointerdown", (event) => {
      const dragHandle = event.target.closest("[data-hc-drag-handle]");
      const isControl = event.target.closest("button, a, input, select, textarea");
      const isResize = event.target.closest("[data-hc-resize-grip]");
      if ((!dragHandle || isControl) && !isResize) return;
      const rect = modal.getBoundingClientRect();
      pinModalToViewport(modal);
      interaction = {
        kind: isResize ? "resize" : "drag",
        startX: event.clientX,
        startY: event.clientY,
        left: modal.getBoundingClientRect().left,
        top: modal.getBoundingClientRect().top,
        width: rect.width,
        height: rect.height,
      };
      modal.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    modal.addEventListener("pointermove", (event) => {
      if (!interaction) return;
      const dx = event.clientX - interaction.startX;
      const dy = event.clientY - interaction.startY;
      if (interaction.kind === "drag") {
        const rect = modal.getBoundingClientRect();
        modal.style.left = `${clamp(interaction.left + dx, MODAL_GUTTER, window.innerWidth - rect.width - MODAL_GUTTER)}px`;
        modal.style.top = `${clamp(interaction.top + dy, MODAL_GUTTER, window.innerHeight - rect.height - MODAL_GUTTER)}px`;
      } else {
        const maxWidth = Math.max(Math.min(MODAL_MIN_WIDTH, window.innerWidth - MODAL_GUTTER * 2), window.innerWidth - interaction.left - MODAL_GUTTER);
        const maxHeight = Math.max(Math.min(MODAL_MIN_HEIGHT, window.innerHeight - MODAL_GUTTER * 2), window.innerHeight - interaction.top - MODAL_GUTTER);
        modal.style.width = `${clamp(interaction.width + dx, Math.min(MODAL_MIN_WIDTH, maxWidth), maxWidth)}px`;
        modal.style.height = `${clamp(interaction.height + dy, Math.min(MODAL_MIN_HEIGHT, maxHeight), maxHeight)}px`;
      }
    });
    const stopInteraction = (event) => {
      if (!interaction) return;
      interaction = null;
      if (event?.pointerId !== undefined && modal.hasPointerCapture?.(event.pointerId)) modal.releasePointerCapture(event.pointerId);
    };
    modal.addEventListener("pointerup", stopInteraction);
    modal.addEventListener("pointercancel", stopInteraction);
    window.addEventListener("resize", () => {
      if (modal.isConnected && modal.style.transform === "none") pinModalToViewport(modal);
    });
  }

  function restoreModal() {
    const modal = modalRoot();
    if (modal) modal.style.display = "block";
    document.getElementById(MINIMIZED_ID)?.remove();
  }

  function minimizeModal() {
    const modal = modalRoot();
    if (!modal || document.getElementById(MINIMIZED_ID)) return;
    modal.style.display = "none";
    const chip = document.createElement("button");
    chip.id = MINIMIZED_ID;
    chip.type = "button";
    chip.textContent = "HotContainer · vrátiť panel";
    chip.style.cssText = "position:fixed;right:18px;bottom:76px;z-index:2147483647;padding:10px 13px;border:1px solid #3a6f95;border-radius:9px;background:#102c43;color:#d9f0ff;font:600 13px Inter,Segoe UI,Arial,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.45);cursor:pointer";
    chip.addEventListener("click", restoreModal);
    document.documentElement.append(chip);
  }

  function openModal(message, isError = false) {
    let modal = modalRoot();
    if (!modal) {
      modal = document.createElement("section");
      modal.id = MODAL_ID;
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.style.cssText = "position:fixed;inset:50% auto auto 50%;transform:translate(-50%,-50%);z-index:2147483647;display:flex;flex-direction:column;width:min(940px,calc(100vw - 40px));height:min(620px,calc(100vh - 40px));min-width:360px;min-height:250px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);box-sizing:border-box;overflow:hidden;border:1px solid #315777;border-radius:14px;background:#091422;color:#edf7ff;box-shadow:0 30px 100px rgba(0,0,0,.7);font:14px/1.4 Inter,Segoe UI,Arial,sans-serif";
      document.documentElement.append(modal);
      enableWindowControls(modal);
    }
    modal.innerHTML = `<div data-hc-drag-handle style="flex:none;display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid #1f3f59;background:#0d1d2c;cursor:grab;user-select:none"><div><div style="font-size:19px;font-weight:750;letter-spacing:-.02em">HotContainer galéria</div><div style="margin-top:2px;color:#8eb7cf;font-size:12px">${escapeHtml(location.pathname)}</div></div><div style="display:flex;align-items:center;gap:9px"><button type="button" data-hc-library style="border:1px solid #3a6f95;border-radius:7px;background:#102c43;color:#d9f0ff;padding:7px 10px;cursor:pointer">Moje videá</button><button type="button" data-hc-minimize style="border:1px solid #315777;border-radius:7px;background:transparent;color:#c9dceb;padding:7px 10px;cursor:pointer">Minimalizovať</button><button type="button" data-hc-close style="border:0;background:transparent;color:#c9dceb;font-size:24px;cursor:pointer" aria-label="Zavrieť">×</button></div></div><div data-hc-content style="flex:1;min-height:0;overflow:auto;padding:48px 22px;text-align:center;color:${isError ? "#ff9a9a" : "#a7d5ec"}">${escapeHtml(message)}</div><div data-hc-resize-grip title="Zmeniť veľkosť" aria-label="Zmeniť veľkosť okna" style="position:absolute;right:5px;bottom:5px;width:17px;height:17px;border-right:2px solid #77b5d7;border-bottom:2px solid #77b5d7;opacity:.9;cursor:nwse-resize;z-index:3"></div>`;
    modal.querySelector("[data-hc-close]").addEventListener("click", () => { modal.remove(); document.getElementById(MINIMIZED_ID)?.remove(); });
    modal.querySelector("[data-hc-library]").addEventListener("click", openLibrary);
    modal.querySelector("[data-hc-minimize]").addEventListener("click", minimizeModal);
  }

  //: The full, unfiltered gallery from the last collectAllGalleryPages() run
  //: — kept so the keyword filter can re-render the grid purely client-side
  //: (every item is already fetched, so filtering never needs a new request).
  let galleryAllItems = [];

  // ---------------------------------------------------------------------
  // Per-item status (accepted/failed) + hidden flag, persisted per profile
  // in chrome.storage.local so it survives a grid re-render (filter/sort
  // change) AND closing and reopening the gallery later — a card fetched
  // last week should still show as done, not reset to a blank state. Keyed
  // by location.href (this IS the xvideos.com profile URL), same identity
  // hotcontainer.js's own gallery cache uses from the other side.
  // ---------------------------------------------------------------------
  const ITEM_STATUS_PREFIX = "hc-item-status:";
  let itemStatusMap = {}; // itemId -> { state: "accepted"|"failed", hidden: bool }

  function itemStatusKey() {
    return `${ITEM_STATUS_PREFIX}${location.href}`;
  }

  async function loadItemStatusMap() {
    try {
      const key = itemStatusKey();
      const data = await chrome.storage.local.get(key);
      itemStatusMap = data[key] || {};
    } catch { itemStatusMap = {}; }
  }

  async function saveItemStatusMap() {
    try {
      await chrome.storage.local.set({ [itemStatusKey()]: itemStatusMap });
    } catch { /* best-effort — a failed write must never break the gallery */ }
  }

  function setItemStatus(itemId, patch) {
    itemStatusMap[itemId] = { ...(itemStatusMap[itemId] || {}), ...patch };
    saveItemStatusMap();
  }

  const STATE_BORDER_COLOR = { accepted: "#38c987", failed: "#e5527d" };

  function renderGalleryGrid(items) {
    const grid = modalRoot()?.querySelector("[data-hc-grid]");
    if (!grid) return;
    grid.innerHTML = "";
    items.forEach((item) => {
      const saved = itemStatusMap[item.id] || {};
      const card = document.createElement("button");
      card.type = "button";
      card.dataset.itemId = item.id;
      const borderColor = STATE_BORDER_COLOR[saved.state] || "#264d6b";
      card.style.cssText = `position:relative;padding:0;overflow:hidden;text-align:left;border:1px solid ${borderColor};border-radius:10px;background:#102337;color:#f2f8fc;cursor:pointer`;
      const label = saved.state === "accepted" ? "Prijaté – vytvára sa v Moje videá."
        : saved.state === "failed" ? "Video sa nepodarilo pripraviť."
        : (item.title || "Video");
      const isHidden = Boolean(saved.hidden);
      const hideBtnLabel = isHidden ? "↺" : "×";
      const hideBtnTitle = isHidden ? "Zrušiť skrytie" : "Skryť z galérie";
      card.innerHTML = `
        <button type="button" data-hc-hide title="${hideBtnTitle}" style="position:absolute;top:6px;right:6px;z-index:2;width:24px;height:24px;border:1px solid #3a6f95;border-radius:6px;background:#0d1d2cdd;color:#c9dceb;font-size:14px;line-height:1;cursor:pointer">${hideBtnLabel}</button>
        <div style="position:relative">
          <img src="${escapeHtml(item.thumbnail)}" alt="" style="display:block;width:100%;aspect-ratio:16/9;height:auto;object-fit:cover;background:#07111c">
          <div style="position:absolute;bottom:6px;left:6px;right:6px;display:flex;justify-content:space-between;gap:5px;align-items:flex-end;pointer-events:none;font-size:11px;font-weight:500;color:#f2f8fc">
            <span data-hc-added-date title="Dátum pridania podľa profilu" style="padding:3px 6px;border-radius:4px;background:#07111cdd;overflow-wrap:anywhere">Pridané: ${escapeHtml(item.addedDate || '—')}</span>
            <span data-hc-duration title="Dĺžka videa" style="padding:3px 6px;border-radius:4px;background:#07111cdd;white-space:nowrap">${escapeHtml(item.duration || '—')}</span>
          </div>
        </div>
        <span data-hc-title style="display:block;padding:11px 12px 13px;font-weight:650;min-height:58px">${escapeHtml(label)}</span>
      `;
      card.querySelector("[data-hc-hide]").addEventListener("click", (event) => {
        event.stopPropagation();
        setItemStatus(item.id, { hidden: !isHidden });
        applyActiveFilter();
      });
      if (saved.state === "accepted" || saved.state === "failed") card.disabled = false;
      card.addEventListener("click", async () => {
        if (!activeJobId) return;
        card.disabled = true;
        card.style.opacity = "0.7";
        card.querySelector("[data-hc-title]").textContent = "Pracujem…";
        const response = await chrome.runtime.sendMessage({
          type: "select-hotcontainer-item", jobId: activeJobId, itemId: item.id,
          thumbnail: item.thumbnail, title: item.title,
          sourceVideoUrl: item.sourceVideoUrl || "", watchUrl: item.watchUrl || "",
        });
        if (!response?.ok) {
          card.disabled = false;
          card.style.opacity = "1";
          card.querySelector("[data-hc-title]").textContent = response?.error || "Skús znova";
        }
      });
      grid.append(card);
    });
  }

  // Exposed at module scope (not local to renderGallery) so the per-card
  // Hide button in renderGalleryGrid can re-apply the current filter/sort/
  // view right after hiding one item, without renderGallery needing to
  // re-run its whole setup.
  let applyActiveFilter = () => {};

  async function renderGallery(items, pageCount = 1, fromCache = false, partial = false) {
    const modal = modalRoot();
    if (!modal) return;
    if (items.some(item => item.accessType !== 'premium')) {
      openModal('HC 0.2.2: Prišla správa zo staršej verzie rozšírenia. Obnov rozšírenie aj karty XVideos a HotContainer a otvor galériu znova.', true);
      return;
    }
    items = items.filter(item => item.accessType === 'premium');
    galleryAllItems = items;
    await loadItemStatusMap();
    const content = modal.querySelector("[data-hc-content]");
    content.style.cssText = "flex:1;min-height:0;overflow:auto;padding:18px 22px;text-align:left";
    if (!items.length) {
      content.textContent = "HC 0.2.2: Kontrola vrátila prázdny zoznam. PREMIUM katalóg sa nepodarilo overiť; nejde o potvrdenie, že profil nemá PREMIUM videá.";
      return;
    }
    const totalLabel = pageCount > 1
      ? `${items.length} PREMIUM videí naprieč ${pageCount} stránkami`
      : `${items.length} PREMIUM videí`;
    const cacheNote = partial ? ' · čiastočný výsledok z otvorenej stránky profilu; úplný katalóg sa nenačítal' : fromCache ? ` · z cache, dopĺňam nové…` : "";
    content.innerHTML = `
      <div data-hc-total-label style="margin:0 0 10px;color:#a7d5ec;font-size:12.5px">${escapeHtml(totalLabel)}${cacheNote}</div>
      <div style="display:flex; gap:10px; align-items:center; margin:0 0 14px; flex-wrap:wrap;">
        <input type="text" id="hc-gallery-filter" placeholder="Filtrovať podľa kľúčového slova…"
          style="flex:1;min-width:160px;border:1px solid #3a6f95;background:#0d1d2c;color:#edf7ff;padding:8px 11px;border-radius:6px;font-size:13px;">
        <select id="hc-gallery-view" style="border:1px solid #3a6f95;background:#0d1d2c;color:#edf7ff;padding:8px 11px;border-radius:6px;font-size:13px;cursor:pointer">
          <option value="active">Všetky (bez skrytých)</option>
          <option value="fetched">Len prijaté/fetchnuté</option>
          <option value="hidden">Skryté</option>
        </select>
        <select id="hc-gallery-sort" style="border:1px solid #3a6f95;background:#0d1d2c;color:#edf7ff;padding:8px 11px;border-radius:6px;font-size:13px;cursor:pointer">
          <option value="newest">Najnovšie</option>
          <option value="oldest">Najstaršie</option>
        </select>
        <span data-hc-filter-count style="color:#a7d5ec;font-size:12px;white-space:nowrap"></span>
      </div>
      <div data-hc-grid style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px"></div>
    `;
    const filterInput = content.querySelector("#hc-gallery-filter");
    const viewSelect = content.querySelector("#hc-gallery-view");
    const sortSelect = content.querySelector("#hc-gallery-sort");
    const countEl = content.querySelector("[data-hc-filter-count]");
    // galleryAllItems arrives newest-first (HotContainer's own page-1-first
    // order, which collectAllGalleryPages preserves) — "Najstaršie" is just
    // that list reversed, no extra scrape needed. Trending/best-rated aren't
    // offered here: the scraped card carries no view-count or rating, and
    // getting those would mean re-walking every page per sort mode through
    // HotContainer's own sort buttons, which defeats the point of the cache.
    applyActiveFilter = () => {
      const needle = normal(filterInput.value);
      const view = viewSelect.value;
      const byView = galleryAllItems.filter((it) => {
        const hidden = Boolean(itemStatusMap[it.id]?.hidden);
        if (view === "hidden") return hidden;
        if (hidden) return false; // "active"/"fetched" both exclude hidden items
        if (view === "fetched") return Boolean(itemStatusMap[it.id]?.state);
        return true;
      });
      const filtered = needle ? byView.filter((it) => normal(it.title).includes(needle)) : byView;
      const sorted = sortSelect.value === "oldest" ? [...filtered].reverse() : filtered;
      renderGalleryGrid(sorted);
      countEl.textContent = `${filtered.length} / ${galleryAllItems.length}`;
    };
    filterInput.addEventListener("input", applyActiveFilter);
    viewSelect.addEventListener("change", applyActiveFilter);
    sortSelect.addEventListener("change", applyActiveFilter);
    applyActiveFilter();
  }

  async function openLibrary() {
    openModal("Načítavam tvoje vygenerované videá…");
    const response = await chrome.runtime.sendMessage({ type: "open-hotcontainer-library" });
    if (response?.ok) activeJobId = response.jobId;
    else openModal(response?.error || "Moje videá sa nepodarilo načítať.", true);
  }

  function renderLibrary(items) {
    const renderId = ++libraryRenderId;
    const qualityTasks = [];
    const modal = modalRoot();
    if (!modal) return;
    const content = modal.querySelector("[data-hc-content]");
    content.style.cssText = "flex:1;min-height:0;overflow:auto;padding:18px 22px;text-align:left";

    content.innerHTML = items.length ? `
      <div style="display:flex; justify-content:space-between; align-items:center; margin:0 0 14px;">
        <div style="color:#a7d5ec; font-size:13px;">Vyber kvalitu pri videu. Stiahnuť spustí download MP4. Kopírovať URL skopíruje priamy odkaz zvolenej kvality. Odkazy sú dočasné.</div>
        <div style="display:flex; gap:8px; align-items:center;">
           <button type="button" id="hc-sel-all" style="border:1px solid #3a6f95;background:#12304a;color:#e5f5ff;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:12px;">Všetky</button>
           <button type="button" id="hc-sel-none" style="border:1px solid #3a6f95;background:#12304a;color:#e5f5ff;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:12px;">Nič</button>
           <button type="button" id="hc-copy-sel" style="border:1px solid #2c9a68;background:#103526;color:#d8ffeb;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:12px;">Kopírovať URLs (0)</button>
           <button type="button" id="hc-import-sel" style="border:1px solid #e5a637;background:#4a3510;color:#ffe5b0;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:12px;">Importovať do Nexusu (0)</button>
        </div>
      </div>
      <div data-hc-grid style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px"></div>
    ` : "Zatiaľ tu nie sú žiadne vygenerované videá.";

    const grid = content.querySelector("[data-hc-grid]");
    if (!grid) return;
    
    items.forEach((item) => {
      const card = document.createElement("article");
      card.dataset.itemId = item.id;
      card.style.cssText = "position:relative;overflow:hidden;border:1px solid #264d6b;border-radius:10px;background:#102337;color:#f2f8fc";
      const sizeBadge = item.size ? `<span style="display:inline-block;margin-top:6px;padding:2px 6px;border-radius:4px;background:#193f58;color:#bde8ff;font-size:11px">${escapeHtml(item.size)}</span>` : "";
      
      card.innerHTML = `
        <input type="checkbox" class="hc-card-checkbox" data-url="" style="position:absolute; top:8px; left:8px; width:18px; height:18px; cursor:pointer; z-index:10;">
        <img src="${escapeHtml(item.thumbnail)}" class="hc-card-img" alt="" style="display:block;width:100%;aspect-ratio:16/9;height:auto;object-fit:cover;background:#07111c;cursor:pointer;">
        <div style="padding:11px 12px 13px">
          <div data-hc-title style="font-weight:650;min-height:45px">${escapeHtml(item.title || "Video")}</div>
          ${sizeBadge}
          <label style="display:block;margin-top:10px;color:#bde8ff;font-size:12px">Kvalita
            <select data-hc-quality aria-label="Kvalita videa" disabled style="display:block;width:100%;margin-top:4px;padding:7px;border:1px solid #3a6f95;border-radius:6px;background:#12304a;color:#e5f5ff">
              <option value="">Načítavam kvality…</option>
            </select>
          </label>
          <div data-hc-quality-status role="status" style="margin-top:5px;color:#a7d5ec;font-size:12px;overflow-wrap:anywhere">Načítavam dostupné rozlíšenia…</div>
          <button type="button" data-hc-quality-retry hidden style="margin-top:5px;border:1px solid #3a6f95;background:#12304a;color:#e5f5ff;padding:5px;border-radius:4px;cursor:pointer">Znova načítať kvality</button>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button type="button" data-hc-play disabled style="flex:1;border:1px solid #3a6f95;border-radius:6px;background:#12304a;color:#e5f5ff;padding:7px;cursor:pointer">Sidecar</button>
            <button type="button" data-hc-download disabled style="flex:1;border:1px solid #2c9a68;border-radius:6px;background:#103526;color:#d8ffeb;padding:7px;cursor:pointer">Stiahnuť</button>
            <button type="button" data-hc-import disabled style="flex:1;border:1px solid #e5a637;border-radius:6px;background:#4a3510;color:#ffe5b0;padding:7px;cursor:pointer">Nexus</button>
          </div>
          <button type="button" data-hc-copy disabled style="width:100%;margin-top:8px;border:1px solid #3a6f95;border-radius:6px;background:#12304a;color:#e5f5ff;padding:7px;cursor:pointer">Kopírovať URL</button>
        </div>
      `;

      const qualitySelect = card.querySelector("[data-hc-quality]");
      const qualityStatus = card.querySelector("[data-hc-quality-status]");
      const retryButton = card.querySelector("[data-hc-quality-retry]");
      item.selectedUrl = "";
      const applyQuality = () => {
        item.selectedUrl = qualitySelect.value;
        card.querySelector(".hc-card-checkbox").dataset.url = item.selectedUrl;
        card.querySelectorAll("[data-hc-download], [data-hc-play], [data-hc-import], [data-hc-copy]")
          .forEach(button => { button.disabled = !item.selectedUrl; });
      };
      qualitySelect.addEventListener("change", applyQuality);
      const loadQualities = async () => {
        qualitySelect.disabled = true;
        qualitySelect.innerHTML = '<option value="">Načítavam kvality…</option>';
        applyQuality();
        retryButton.hidden = true;
        qualityStatus.textContent = "Načítavam dostupné rozlíšenia…";
        try {
          if (!item.hqUrl) throw new Error("Video zatiaľ nemá pripravený odkaz.");
          const result = await chrome.runtime.sendMessage({ type: "hotcontainer-qualities", url: item.hqUrl });
          if (!result?.ok || !result.variants?.length) throw new Error(result?.error || "Kvality sa nenačítali.");
          if (renderId !== libraryRenderId || !card.isConnected) return;
          qualitySelect.replaceChildren();
          result.variants.forEach(variant => {
            const option = document.createElement("option");
            option.value = variant.url;
            option.textContent = variant.label;
            qualitySelect.append(option);
          });
          if (result.variants.length > 1) {
            const all = document.createElement("option");
            all.value = item.hqUrl;
            all.textContent = "Všetky kvality (JDownloader)";
            qualitySelect.append(all);
          }
          qualitySelect.disabled = false;
          qualityStatus.textContent = `Dostupné: ${result.variants.map(variant => variant.label).join(", ")}`;
          applyQuality();
        } catch (error) {
          if (renderId !== libraryRenderId || !card.isConnected) return;
          qualityStatus.textContent = error.message || "Kvality sa nepodarilo načítať.";
          qualitySelect.innerHTML = '<option value="">Vyber po načítaní kvalít</option>';
          if (item.hqUrl) {
            const fallback = document.createElement("option");
            fallback.value = item.hqUrl;
            fallback.textContent = "Celý playlist (JDownloader)";
            qualitySelect.append(fallback);
            qualitySelect.disabled = false;
            retryButton.hidden = false;
          }
        }
      };
      retryButton.addEventListener("click", loadQualities);
      qualityTasks.push(loadQualities);

      card.querySelector(".hc-card-img").addEventListener("click", () => {
        const cb = card.querySelector(".hc-card-checkbox");
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
      });

      card.querySelector("[data-hc-copy]").addEventListener("click", async () => {
        if (!item.selectedUrl) return;
        try {
          await navigator.clipboard.writeText(item.selectedUrl);
          qualityStatus.textContent = "Priama URL zvolenej kvality skopírovaná.";
        } catch {
          qualityStatus.textContent = "Kopírovanie sa nepodarilo. Skús Kopírovať URL znova.";
        }
      });

      card.querySelector("[data-hc-download]").addEventListener("click", async () => {
        const btn = card.querySelector("[data-hc-download]");
        if (!item.selectedUrl) {
          btn.textContent = "Chýba link";
          return;
        }
        btn.disabled = true;
        try {
          const response = await chrome.runtime.sendMessage({
            type: "hotcontainer-download", url: item.selectedUrl, title: item.title,
          });
          if (!response?.ok) throw new Error(response?.error || "Sťahovanie sa nepodarilo spustiť.");
          btn.textContent = "Download odoslaný";
          qualityStatus.textContent = `${response.method === "chrome" ? "Chrome" : "IDM"} prevzal sťahovanie zvolenej kvality cez Nexus (MP4).`;
        } catch (e) {
          btn.textContent = "Skúsiť znova";
          qualityStatus.textContent = e.message || "Sťahovanie sa nepodarilo spustiť.";
        }
        setTimeout(() => {
          btn.textContent = "Stiahnuť";
          btn.disabled = false;
        }, 1500);
      });

      card.querySelector("[data-hc-play]").addEventListener("click", () => {
        const btn = card.querySelector("[data-hc-play]");
        if (!item.selectedUrl) {
          btn.textContent = "Chýba link";
          return;
        }
        btn.disabled = true;
        btn.textContent = "Posielam…";
        const sidecarItem = {
          url: item.selectedUrl,
          title: item.title || "Video",
          poster: item.thumbnail || "",
          pageUrl: location.href,
          sourceUrl: location.href,
          typeHint: item.selectedUrl.includes('.m3u8') ? "hls" : "file"
        };
        enqueueInSidecar(sidecarItem).then(
          () => {
            btn.textContent = "Odoslané!";
            setTimeout(() => {
              btn.textContent = "Sidecar";
              btn.disabled = false;
            }, 1500);
          },
          (error) => {
            btn.textContent = "Chyba Sidecaru";
            btn.disabled = false;
            alert(error.message || "Sidecar neodpovedal.");
          }
        );
      });
      card.querySelector("[data-hc-import]").addEventListener("click", () => {
        const btn = card.querySelector("[data-hc-import]");
        if (!item.selectedUrl) {
          btn.textContent = "Chýba link";
          return;
        }
        btn.disabled = true;
        btn.textContent = "Importujem…";
        chrome.runtime.sendMessage({
          type: "import-to-nexus",
          items: [{ hqUrl: item.selectedUrl, title: item.title, thumbnail: item.thumbnail, sourceUrl: location.href }],
        }).then((response) => {
          if (response?.ok) {
            btn.textContent = response.downloadsStarted ? "Sťahuje sa!" : "Importované";
            setTimeout(() => { btn.textContent = "Nexus"; btn.disabled = false; }, 2000);
          } else {
            btn.textContent = "Chyba";
            btn.disabled = false;
            alert(response?.error || "Import do Nexusu zlyhal.");
          }
        });
      });
      grid.append(card);
    });

    // Keep large libraries responsive and avoid flooding the CDN with requests.
    let nextQualityTask = 0;
    const worker = async () => {
      while (renderId === libraryRenderId && grid.isConnected && nextQualityTask < qualityTasks.length) {
        await qualityTasks[nextQualityTask++]();
      }
    };
    void Promise.all([worker(), worker(), worker()]);

    if (items.length) {
      const copyBtn = content.querySelector("#hc-copy-sel");
      const importSelBtn = content.querySelector("#hc-import-sel");
      const selAllBtn = content.querySelector("#hc-sel-all");
      const selNoneBtn = content.querySelector("#hc-sel-none");
      const itemById = new Map(items.map((it) => [it.id, it]));

      const updateCount = () => {
        const count = content.querySelectorAll(".hc-card-checkbox:checked").length;
        copyBtn.textContent = `Kopírovať URLs (${count})`;
        importSelBtn.textContent = `Importovať do Nexusu (${count})`;
      };

      const updateStyles = () => {
        content.querySelectorAll(".hc-card-checkbox").forEach(cb => {
          const cardEl = cb.closest("article");
          if (cardEl) {
            cardEl.style.borderColor = cb.checked ? "#2c9a68" : "#264d6b";
            cardEl.style.boxShadow = cb.checked ? "0 0 0 2px rgba(44,154,104,0.4)" : "none";
          }
        });
      };

      content.addEventListener("change", (e) => {
        if (e.target.classList.contains("hc-card-checkbox")) {
          updateCount();
          updateStyles();
        }
      });

      selAllBtn.addEventListener("click", () => {
        content.querySelectorAll(".hc-card-checkbox").forEach(cb => cb.checked = true);
        updateCount();
        updateStyles();
      });

      selNoneBtn.addEventListener("click", () => {
        content.querySelectorAll(".hc-card-checkbox").forEach(cb => cb.checked = false);
        updateCount();
        updateStyles();
      });

      copyBtn.addEventListener("click", async () => {
        const checked = content.querySelectorAll(".hc-card-checkbox:checked");
        if (!checked.length) return;
        const urls = [...checked].map(cb => cb.dataset.url).filter(Boolean);
        if (urls.length !== checked.length) {
          alert("Pri každom vybranom videu najprv načítaj a vyber kvalitu.");
          return;
        }
        try {
          await navigator.clipboard.writeText(urls.join("\n"));
          const orig = copyBtn.textContent;
          copyBtn.textContent = "Skopírované!";
          setTimeout(() => copyBtn.textContent = orig, 1500);
        } catch (err) { alert("Chyba pri kopírovaní: " + err); }
      });

      importSelBtn.addEventListener("click", () => {
        const checked = [...content.querySelectorAll(".hc-card-checkbox:checked")];
        if (!checked.length) return;
        const payload = checked
          .map((cb) => itemById.get(cb.closest("article")?.dataset.itemId))
          .filter((it) => it?.selectedUrl)
          .map((it) => ({ hqUrl: it.selectedUrl, title: it.title, thumbnail: it.thumbnail, sourceUrl: location.href }));
        if (payload.length !== checked.length) {
          alert("Pri každom vybranom videu najprv načítaj a vyber kvalitu.");
          return;
        }
        const orig = importSelBtn.textContent;
        importSelBtn.disabled = true;
        importSelBtn.textContent = `Importujem ${payload.length}…`;
        chrome.runtime.sendMessage({ type: "import-to-nexus", items: payload }).then((response) => {
          importSelBtn.disabled = false;
          if (response?.ok) {
            importSelBtn.textContent = `Importované ${response.imported}, sťahuje sa ${response.downloadsStarted}`;
            setTimeout(() => { importSelBtn.textContent = orig; }, 3000);
          } else {
            importSelBtn.textContent = orig;
            alert(response?.error || "Import do Nexusu zlyhal.");
          }
        });
      });
    }
  }

  function enqueueInSidecar(item) {
    return new Promise((resolve, reject) => {
      const requestId = `hotcontainer-sidecar-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", receiveResult);
        reject(new Error("Vertical Sidecar neodpovedal. Skontroluj, že je rozšírenie načítané a stránka je obnovená."));
      }, 5000);
      const receiveResult = (event) => {
        if (event.source !== window || event.origin !== location.origin) return;
        const response = event.data;
        if (response?.type !== "NEXUS_SIDECAR_RESULT" || response.requestId !== requestId) return;
        window.clearTimeout(timeout);
        window.removeEventListener("message", receiveResult);
        if (response.result?.ok) resolve(response.result);
        else reject(new Error(response.result?.error || "Vertical Sidecar položku neprijal."));
      };
      window.addEventListener("message", receiveResult);
      window.postMessage({ type: "NEXUS_SIDECAR_ENQUEUE", requestId, items: [item], playNow: true }, location.origin);
    });
  }

  function addButton() {
    if (!supportedPage() || document.getElementById(BUTTON_ID)) return;
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.textContent = "HotContainer galéria";
    button.title = "Načíta dostupnú galériu priamo do panelu";
    button.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;padding:11px 15px;border:1px solid #e55237;border-radius:8px;background:#171717;color:#fff;font:600 14px Arial,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.45);cursor:pointer";
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Pripravujem…";
      const response = await chrome.runtime.sendMessage({ type: "open-hotcontainer-red", profileUrl: location.href });
      button.disabled = false;
      button.textContent = "HotContainer galéria";
      if (response?.ok) {
        activeJobId = response.jobId;
        openModal("Načítavam galériu cez HotContainer…");
      } else openModal(response?.error || "Galériu sa nepodarilo pripraviť.", true);
    });
    document.documentElement.append(button);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'collect-hotcontainer-premium') {
      void (async () => {
        try {
          const catalog = await HotContainerPremium.collect();
          sendResponse({ ok: true, catalog });
        } catch (error) { sendResponse({ ok: false, error: error.message }); }
      })();
      return true;
    }
    if (message?.type === 'collect-current-hotcontainer-premium') {
      sendResponse({ ok: true, catalog: HotContainerPremium.collectCurrent() });
      return false;
    }
    if (message?.jobId !== activeJobId) return;
    if (message.type === "hotcontainer-gallery-error") openModal(message.text || "Galériu sa nepodarilo načítať.", true);
    if (message.type === "hotcontainer-gallery") renderGallery(message.items || [], message.pageCount || 1, Boolean(message.fromCache), Boolean(message.partial));
    if (message.type === "hotcontainer-gallery-progress") {
      const content = modalRoot()?.querySelector("[data-hc-content]");
      const { loaded, estimatedTotal, page, pageCount } = message;
      const totalPart = pageCount > 1 ? ` z odhadom ~${estimatedTotal}` : "";
      const pagePart = pageCount > 1 ? ` (stránka ${page}/${pageCount})` : "";
      const totalLabel = content?.querySelector("[data-hc-total-label]");
      if (message.text) {
        if (totalLabel) totalLabel.textContent = message.text;
        else if (content) content.textContent = message.text;
        return;
      }
      // A cached gallery is already on screen (data-hc-grid exists) — don't
      // blow it away with a bare loading string, just nudge the small label
      // above it so the grid stays visible while new items get appended.
      if (totalLabel) totalLabel.textContent = `Dopĺňam nové videá: ${loaded}${totalPart}${pagePart}…`;
      else if (content) content.textContent = `Načítané ${loaded}${totalPart} videí${pagePart}…`;
    }
    if (message.type === "hotcontainer-library") renderLibrary(message.items || []);
    if (message.type === "hotcontainer-sidecar" && message.itemId && message.item) {
      enqueueInSidecar(message.item).then(
        () => chrome.runtime.sendMessage({ type: "hotcontainer-status", jobId: activeJobId, itemId: message.itemId, text: "Prehrávanie odoslané do Vertical Sidecaru." }),
        (error) => chrome.runtime.sendMessage({ type: "hotcontainer-status", jobId: activeJobId, itemId: message.itemId, text: error.message || "Vertical Sidecar neodpovedal." })
      );
    }
    if (message.type === "hotcontainer-status" && message.itemId) {
      const card = modalRoot()?.querySelector(`[data-item-id="${CSS.escape(message.itemId)}"]`);
      if (card) {
        const label = card.querySelector("[data-hc-title]") || card.querySelector("span");
        if (label) label.textContent = message.text || "Pracujem…";
        const playButton = card.querySelector("[data-hc-play]");
        const downloadButton = card.querySelector("[data-hc-download]");
        if (playButton) {
          playButton.disabled = false;
          playButton.textContent = "Sidecar";
        }
        if (downloadButton) {
          downloadButton.disabled = false;
          downloadButton.textContent = "Stiahnuť";
        }
        if (message.state === "accepted") {
          card.disabled = false;
          card.style.opacity = "1";
          card.style.borderColor = "#38c987";
          setItemStatus(message.itemId, { state: "accepted" });
        } else if (message.state === "failed") {
          // Let the user retry instead of leaving the card permanently
          // greyed out on "Pracujem…" when the hidden select-item tab
          // couldn't find or click the target video. Not persisted as
          // "failed" status — a transient failure (video not found this
          // pass, tab hiccup) shouldn't permanently mark a card as broken
          // when a retry might just work; the visible border reset is
          // enough feedback for this run.
          card.disabled = false;
          card.style.opacity = "1";
          card.style.borderColor = "#e5527d";
        }
      }
    }
  });

  addButton();
  new MutationObserver(addButton).observe(document.documentElement, { childList: true, subtree: true });
})();
