(() => {
  const JOB_KEY = "hc-profile-handoff-job";
  const normal = (value) => String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();

  function handoffFromHash() {
    if (!location.hash.startsWith("#nexus-job=")) return null;
    try {
      const params = new URLSearchParams(location.hash.slice(1));
      const jobId = params.get("nexus-job");
      if (jobId && params.get("mode") === "library") return { jobId, mode: "library" };
      const profileUrl = params.get("profile");
      const url = new URL(profileUrl);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      // xvideos serves creator profiles both under a prefix (/channels/foo,
      // /pornstars/foo, ...) and as a bare top-level slug (/foo). Bare slugs
      // must be excluded from xvideos' own reserved top-level paths (videos,
      // tags, search, ...) so this doesn't misfire on a non-profile page.
      const isPrefixedProfile = /\/(?:models|channels|profiles|pornstars)\/[^/]+/i.test(url.pathname);
      const isBareProfile = /^\/[a-z0-9._-]+\/?$/i.test(url.pathname)
        && !/^\/(?:video|videos|tags|categories|search|channels|models|profiles|pornstars|community|premium)([/?].*)?$/i.test(url.pathname);
      if (!jobId || host !== "xvideos.com" || !(isPrefixedProfile || isBareProfile)) return null;
      // A select-item handoff (see background.js's select-hotcontainer-item
      // handler): this tab exists ONLY to find and click one specific card by
      // thumbnail, then close itself. It never touches the user's visible
      // gallery tab. Absent -> ordinary full-gallery-collection handoff.
      const selectThumbnail = params.get("select-thumbnail");
      return selectThumbnail ? { jobId, profileUrl, selectThumbnail } : { jobId, profileUrl };
    } catch { return null; }
  }

  function readJob() {
    try {
      const job = JSON.parse(sessionStorage.getItem(JOB_KEY) || "null");
      if (!job || Date.now() - job.startedAt > 10 * 60 * 1000) return null;
      return job;
    } catch { return null; }
  }

  function saveJob(job) { sessionStorage.setItem(JOB_KEY, JSON.stringify(job)); }

  // ---------------------------------------------------------------------
  // Per-profile gallery cache — persisted in chrome.storage.local so the
  // NEXT time this same xvideos profile is opened, its gallery renders
  // instantly from what was already collected instead of re-clicking
  // through every pager page again. Keyed by profileUrl (normalized by the
  // caller before it reaches handoffFromHash), never by jobId — a job only
  // lives for one visit, the cache is meant to outlive it.
  // ---------------------------------------------------------------------
  const GALLERY_CACHE_PREFIX = "hc-gallery-cache:";
  //: A profile rarely disappears entirely between visits, but this bounds
  //: how long a fully-stale cache (e.g. abandoned profile) is trusted before
  //: a full re-scan is forced anyway, rather than trusting it forever.
  const GALLERY_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  // Older caches used recent-watched order or included unclassified cards.
  const GALLERY_CACHE_VERSION = 7;

  function galleryCacheKey(profileUrl) {
    return `${GALLERY_CACHE_PREFIX}${profileUrl}`;
  }

  async function readGalleryCache(profileUrl) {
    try {
      const key = galleryCacheKey(profileUrl);
      const data = await chrome.storage.local.get(key);
      const entry = data[key];
      if (!entry || !Array.isArray(entry.items) || !entry.items.length) return null;
      if (entry.version !== GALLERY_CACHE_VERSION) return null;
      if (Date.now() - (entry.cachedAt || 0) > GALLERY_CACHE_MAX_AGE_MS) return null;
      return entry;
    } catch { return null; }
  }

  async function writeGalleryCache(profileUrl, items, pageCount) {
    try {
      const key = galleryCacheKey(profileUrl);
      await chrome.storage.local.set({
        [key]: { items, pageCount, cachedAt: Date.now(), version: GALLERY_CACHE_VERSION },
      });
    } catch { /* best-effort — a failed cache write must never break the gallery itself */ }
  }

  // NOT `el.offsetParent !== null`: that reads as "hidden" for elements in a
  // background/inactive tab in at least some Chrome versions, which broke
  // the hidden select-item tab entirely (see findPageButtons below for the
  // same fix and fuller rationale) — this form field / button live in that
  // same hidden tab during a select-item handoff.
  const isRendered = (el) => el.getClientRects().length > 0;

  function findProfileField() {
    const fields = [...document.querySelectorAll("input, textarea")].filter((field) => {
      const type = (field.getAttribute("type") || "text").toLowerCase();
      return type === "text" || type === "url" || type === "search";
    });
    return fields.find((field) => /odkaz|kanál|kanal|profil|profile|channel|pornstar|xvideos|link/i.test(`${field.placeholder || ""} ${field.name || ""} ${field.id || ""}`)) || fields.find((field) => isRendered(field) && !field.disabled) || null;
  }

  function findListButton() {
    return [...document.querySelectorAll("button, input, a, [role='button'], [onclick]")].find((element) => {
      if (!isRendered(element) || element.disabled) return false;
      return /(?:zoznam|listar|list)\s+vide/i.test(normal(`${element.textContent || ""} ${element.value || ""} ${element.getAttribute("aria-label") || ""}`));
    }) || null;
  }

  function cardForImage(image) {
    let node = image.parentElement;
    while (node && node !== document.body) {
      if (normal(node.innerText).includes("kopírovať odkaz") && node.querySelectorAll("img").length === 1) return node;
      node = node.parentElement;
    }
    return image.closest("article, .video-card, .card") || null;
  }

  // Item ids are derived from the thumbnail URL (stable) rather than a
  // per-render counter: the modal collects every page before the user picks
  // anything, so by the time they click a card from page 1 the DOM has moved
  // on to whatever page loaded last and re-rendered its cards from scratch.
  // A counter-based id would come back different after navigating back to
  // that page; hashing the thumbnail URL is deterministic across renders of
  // the same card, so the id the modal has still resolves after the page
  // reloads its DOM. Falls back to a counter only for the rare card with no
  // thumbnail at all (filtered out by the callers anyway).
  let galleryItemFallbackCounter = 0;
  function stableItemId(thumbnail) {
    if (!thumbnail) return `hc-item-${galleryItemFallbackCounter++}`;
    let hash = 0;
    for (let i = 0; i < thumbnail.length; i++) hash = (hash * 31 + thumbnail.charCodeAt(i)) | 0;
    return `hc-item-${hash}`;
  }
  function galleryItems(pageNum = 1) {
    const directCards = [...document.querySelectorAll("a[href*='/vip/servico/assistir/XVideosRed']")].map((link) => {
      const card = link.closest("[class*='col']") || link.parentElement;
      const image = link.querySelector("img");
      if (!card || !image) return null;
      const thumbnail = image.currentSrc || image.src || "";
      const id = stableItemId(thumbnail);
      let sourceVideoUrl = '';
      try { sourceVideoUrl = new URL(link.href).searchParams.get('link') || ''; } catch { /* missing source */ }
      const videoId = sourceVideoUrl.match(/\/video\.([a-z0-9]+)/i)?.[1] || '';
      card.dataset.hcHandoffItem = id;
      return {
        id,
        videoId,
        sourceVideoUrl,
        watchUrl: link.href,
        page: pageNum,
        thumbnail,
        title: card.querySelector(".tituloConteudo")?.textContent?.trim() || link.querySelector("p")?.textContent?.trim() || link.getAttribute('title')?.trim() || link.textContent?.trim() || "Video",
        size: card.querySelector(".nvs-badge-text")?.textContent?.trim() || ""
      };
    }).filter((item) => item?.thumbnail);
    if (directCards.length) return directCards;

    const cards = new Set();
    document.querySelectorAll("img").forEach((image) => {
      const rect = image.getBoundingClientRect();
      const card = rect.width >= 120 && rect.height >= 70 ? cardForImage(image) : null;
      if (card) cards.add(card);
    });
    return [...cards].slice(0, 100).map((card) => {
      const image = card.querySelector("img");
      const thumbnail = image?.currentSrc || image?.src || "";
      const id = stableItemId(thumbnail);
      card.dataset.hcHandoffItem = id;
      return {
        id,
        page: pageNum,
        thumbnail,
        title: String(card.innerText || "").replace(/kopírovať odkaz/ig, "").trim().slice(0, 180) || image?.alt || "Video"
      };
    }).filter((item) => item.thumbnail);
  }

  // Numbered pager buttons/links near the gallery grid — same "find by what
  // it looks like, not a pinned class name" approach as findListButton()
  // above, since hotcontainer.co's own CSS classes aren't something this
  // extension controls or can rely on staying put across their deploys.
  // Sorted by page number so "next" always means strictly-greater, not
  // whatever DOM order the site happens to render them in.
  function findPageButtons() {
    // NOT `el.offsetParent !== null` as the visibility check: that reads as
    // "hidden" for elements in a background/inactive tab in at least some
    // Chrome versions (confirmed live — pager buttons in the hidden
    // select-item tab were being filtered out entirely, so page 2+ items
    // could never be reached; page 1 worked by luck since it never needs
    // findPageButtons to find a match already on the first page). getClientRects
    // still reflects real DOM layout in a background tab, just not paint/
    // compositing, so it stays a reliable "is this actually a rendered
    // element" signal there.
    const candidates = [...document.querySelectorAll("a, button, [role='button']")]
      .filter((el) => el.getClientRects().length > 0 && /^\d{1,3}$/.test((el.textContent || "").trim()));
    const withNum = candidates.map((el) => ({ el, num: parseInt(el.textContent.trim(), 10) }));
    withNum.sort((a, b) => a.num - b.num);
    return withNum;
  }

  function currentPageNumber(pageButtons) {
    const active = pageButtons.find(({ el }) =>
      el.classList.contains("active") || el.classList.contains("current") ||
      el.parentElement?.classList.contains("active") || el.parentElement?.classList.contains("current") ||
      el.getAttribute("aria-current") === "page" || el.disabled);
    return active ? active.num : (pageButtons[0]?.num ?? 1);
  }

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  // Capture the thumbnail sequence BEFORE clicking: equal-size pages and
  // asynchronous removal of the old grid must both be detected reliably.
  function gallerySignature() {
    return galleryItems().map((item) => item.thumbnail).join("\n");
  }

  function waitForGalleryChange(previousSignature, timeoutMs = 10000) {
    const pollMs = 60;
    return new Promise((resolve) => {
      let elapsed = 0;
      const poll = window.setInterval(() => {
        const items = galleryItems();
        if (items.length && items.map((item) => item.thumbnail).join("\n") !== previousSignature) {
          window.clearInterval(poll);
          resolve(items);
          return;
        }
        elapsed += pollMs;
        if (elapsed >= timeoutMs) {
          window.clearInterval(poll);
          resolve(galleryItems());
        }
      }, pollMs);
    });
  }

  async function selectNewestGallery() {
    const newest = document.querySelector("#filtroNovo") || [...document.querySelectorAll("a, button")]
      .find((el) => normal(el.textContent) === "novo");
    if (!newest) throw new Error("HotContainer: karta Novo sa nenašla.");
    const before = gallerySignature();
    // On this page Novo reloads the list asynchronously and keeps the page
    // number. Capture the old DOM before clicking, then wait for loading to end.
    newest.click();
    await sleep(60);
    await waitForGalleryChange(before);
    if (!galleryItems().length) throw new Error("HotContainer: videá na karte Novo sa nenačítali.");
    const pages = findPageButtons();
    const first = pages.find(({ num }) => num === 1);
    if (first && currentPageNumber(pages) !== 1) {
      const previous = gallerySignature();
      first.el.click();
      await waitForGalleryChange(previous);
    }
  }

  // Pulls every page of the gallery instead of just the first: a profile's
  // RED tab commonly spans several pages (see hotcontainer's own numbered
  // pager), and sending only page 1 silently hid the rest of the catalogue
  // from the modal. Caps at 30 pages as a safety net against a runaway loop
  // on an unexpectedly huge profile — that's ~10x a typical profile's page
  // count, so it's a backstop, not a real-world ceiling.
  const MAX_GALLERY_PAGES = 30;

  // `knownKeys` is the thumbnail/title key set from a previous cached run
  // (see readGalleryCache below). The gallery is sorted newest-first, so the
  // FIRST already-known card seen while walking pages means every remaining
  // page is stuff already in the cache — no need to keep clicking through
  // them. `stoppedEarly` tells the caller whether the walk covered every
  // page (safe to fully replace the cache) or bailed out on a known item
  // (only the new items in front of it are genuinely fresh).
  async function collectAllGalleryPages(job, knownKeys = null) {
    const seen = new Set();
    const all = [];
    let hitKnownItem = false;
    const addUnique = (items) => {
      for (const item of items) {
        const key = item.thumbnail || item.title;
        if (!key || seen.has(key)) continue;
        if (knownKeys && knownKeys.has(key)) { hitKnownItem = true; break; }
        seen.add(key);
        all.push(item);
      }
    };
    // Rough "how many total" estimate while the crawl is still running: page 1's
    // card count times the number of pager buttons. Only an estimate — the last
    // page usually has fewer cards than a full one — so it's replaced by the
    // real count (all.length) the moment the crawl actually finishes.
    const estimateTotal = (perPageCount, pages) => perPageCount * pages;
    const sendProgress = (page, pages, perPageCount) => chrome.runtime.sendMessage({
      type: "hotcontainer-gallery-progress", jobId: job.jobId,
      loaded: all.length, estimatedTotal: pages > 1 ? estimateTotal(perPageCount, pages) : all.length,
      page, pageCount: pages,
    });

    let pageButtons = findPageButtons();
    let pageCount = pageButtons.length ? pageButtons[pageButtons.length - 1].num : 1;
    let currentPage = currentPageNumber(pageButtons);
    const firstPageItems = galleryItems(currentPage);
    addUnique(firstPageItems);
    await sendProgress(currentPage, pageCount, firstPageItems.length);

    for (let i = 0; i < MAX_GALLERY_PAGES && !hitKnownItem; i++) {
      pageButtons = findPageButtons();
      const next = pageButtons.find(({ num }) => num === currentPage + 1);
      if (!next) break;
      pageCount = pageButtons[pageButtons.length - 1]?.num || pageCount;
      const before = gallerySignature();
      next.el.click();
      await sendProgress(next.num, pageCount, firstPageItems.length);
      await waitForGalleryChange(before);
      await sleep(40); // brief settle before the next click search — thumbnails are already in the DOM by the time waitForGalleryChange resolves
      currentPage = next.num;
      addUnique(galleryItems(currentPage));
    }
    return { items: all, pageCount, stoppedEarly: hitKnownItem };
  }

  function watchForGallery(job) {
    let tries = 0;
    const watcher = window.setInterval(async () => {
      const items = galleryItems();
      if (items.length) {
        clearInterval(watcher);
        saveJob({ ...job, phase: "gallery" });

        try {
          await selectNewestGallery();
        } catch (error) {
          await chrome.runtime.sendMessage({ type: "hotcontainer-gallery-error", jobId: job.jobId, text: error.message });
          return;
        }

        const cached = job.profileUrl ? await readGalleryCache(job.profileUrl) : null;
        if (cached && cached.items.every(item => item.accessType === 'premium')) {
          // Instant paint from what we already know — the incremental scan
          // below then tops it up with anything genuinely new.
          await chrome.runtime.sendMessage({
            type: "hotcontainer-gallery", jobId: job.jobId,
            items: cached.items, pageCount: cached.pageCount, fromCache: true,
          });
        }
        // A filtered cache may omit whole pages. It cannot be an early-stop
        // boundary for a subsequent full scan.
        const { items: freshItems, pageCount } = await collectAllGalleryPages(job);
        // Newest-first: fresh items found in front of the cached ones, then
        // everything the cache already had. When the scan did NOT stop early
        // (no cache, or it walked clean off the end without ever matching),
        // freshItems is the complete, authoritative list on its own.
        const merged = freshItems;

        await chrome.runtime.sendMessage({ type: "hotcontainer-gallery-progress", jobId: job.jobId,
          loaded: merged.length, estimatedTotal: merged.length, page: pageCount, pageCount,
          text: 'Overujem PREMIUM videá…' });
        try {
          const response = await chrome.runtime.sendMessage({ type: 'filter-hotcontainer-premium', jobId: job.jobId, items: merged });
          if (!response?.ok) throw new Error(response?.error || 'PREMIUM videá sa nepodarilo overiť.');
          await chrome.runtime.sendMessage({ type: "hotcontainer-gallery", jobId: job.jobId, items: response.items, pageCount, partial: response.partial, diagnostics: response.diagnostics });
          if (job.profileUrl && !response.partial) await writeGalleryCache(job.profileUrl, response.items, pageCount);
        } catch (error) {
          await chrome.runtime.sendMessage({ type: 'hotcontainer-gallery-error', jobId: job.jobId, text: error.message });
        }
      }
      if (++tries >= 80) clearInterval(watcher);
    }, 750);
  }

  // Runs in the hidden, disposable select-item tab (see background.js's
  // select-hotcontainer-item handler) — walks pages looking for a thumbnail
  // match since this tab never ran the full gallery scan the visible tab
  // did. Clicking is the ONLY thing this tab does before it gets closed; it
  // never reports a gallery listing back, so the visible gallery tab's own
  // state is never touched by it.
  async function watchForGalleryAndSelect(job) {
    let tries = 0;
    const watcher = window.setInterval(async () => {
      const items = galleryItems();
      if (!items.length) {
        if (++tries >= 80) {
          clearInterval(watcher);
          chrome.runtime.sendMessage({ type: "hotcontainer-status", jobId: job.jobId, state: "failed", text: "Galéria sa nenačítala." });
        }
        return;
      }
      clearInterval(watcher);
      saveJob({ ...job, phase: "gallery" });
      try {
        await selectNewestGallery();
      } catch (error) {
        await chrome.runtime.sendMessage({ type: "hotcontainer-status", jobId: job.jobId, state: "failed", text: error.message });
        return;
      }

      const findOnCurrentPage = () => galleryItems().find((it) => it.thumbnail === job.selectThumbnail) || null;
      let match = findOnCurrentPage();
      for (let i = 0; !match && i < MAX_GALLERY_PAGES; i++) {
        const pageButtons = findPageButtons();
        const current = currentPageNumber(pageButtons);
        const next = pageButtons.find(({ num }) => num === current + 1);
        if (!next) break;
        const before = gallerySignature();
        next.el.click();
        await waitForGalleryChange(before);
        await sleep(40);
        match = findOnCurrentPage();
      }

      if (!match) {
        chrome.runtime.sendMessage({ type: "hotcontainer-status", jobId: job.jobId, state: "failed", text: "Vybrané video sa v galérii nenašlo." });
        return;
      }
      const card = document.querySelector(`[data-hc-handoff-item="${CSS.escape(match.id)}"]`);
      // Navigate this tab's location directly rather than clicking the card's
      // <a target="_blank">: a .click() on it still opens a NEW tab (target
      // survives being cleared in at least some cases — confirmed live, the
      // "video sa generuje" confirmation ended up on a separate popup tab
      // this hidden tab's watchForGenerationConfirmation never saw, so the
      // card sat on "Pracujem…" forever). Setting location.href guarantees
      // the confirmation page loads in THIS tab, where it's being watched.
      const openLink = card?.querySelector("a[href*='/vip/servico/assistir/XVideosRed']");
      const targetHref = openLink?.href;
      if (!targetHref) {
        chrome.runtime.sendMessage({ type: "hotcontainer-status", jobId: job.jobId, state: "failed", text: "Odkaz na video sa nepodarilo nájsť." });
        return;
      }
      saveJob({ ...job, phase: "opening" });
      location.href = targetHref;
      chrome.runtime.sendMessage({ type: "hotcontainer-status", jobId: job.jobId, text: "HotContainer spracováva položku…" });
    }, 750);
  }

  function getHighQualityUrl(card) {
    const linkEl = card.querySelector("a[href*='/player/p2?link=']");
    if (!linkEl) return null;
    try {
      const match = linkEl.href.match(/[?&]link=([^&]+)/);
      if (match) return decodeURIComponent(match[1]);
    } catch (e) {
      console.error("Failed to decode high quality link", e);
    }
    return null;
  }

  function libraryItems() {
    const cards = [...new Set(
      [...document.querySelectorAll("a[href*='/player/p2?link=']")]
        .map((link) => link.closest("[class*='col']") || link.parentElement)
        .filter(Boolean)
    )];
    return cards.map((card, index) => {
      const link = card.querySelector("a[href*='/player/p2?link=']");
      const image = card?.querySelector("img");
      const downloadButton = card?.querySelector("button.btnDownload, button[id^='buttonDownload-']");
      if (!card || !image || !downloadButton) return null;
      const id = `hc-library-${index}`;
      card.dataset.hcLibraryItem = id;
      return {
        id,
        thumbnail: image.currentSrc || image.src || "",
        title: card.querySelector(".tituloConteudo")?.textContent?.trim() || link.querySelector("p")?.textContent?.trim() || "Video",
        size: card.querySelector(".nvs-badge-text")?.textContent?.trim() || "",
        hqUrl: getHighQualityUrl(card) || ""
      };
    }).filter((item) => item?.thumbnail);
  }

  function decodeHtml(value) {
    const node = document.createElement("textarea");
    node.innerHTML = value;
    node.innerHTML = node.value;
    return node.value;
  }

  function officialDownloadFor(card) {
    const button = card.querySelector("button.btnDownload, button[id^='buttonDownload-']");
    if (!button?.id) return null;
    const script = [...document.querySelectorAll("script:not([src])")].find((node) => node.textContent.includes(`#${button.id}`));
    const source = script?.textContent || "";
    const url = source.match(/var\s+videoUrl\s*=\s*'([^']+)'/)?.[1];
    const filename = source.match(/\.attr\(\s*['"]download['"]\s*,\s*'([^']+)'/)?.[1];
    return url ? { url: decodeHtml(url), filename: filename || `${button.id}.mp4` } : null;
  }

  function watchForLibrary(job) {
    let tries = 0;
    const watcher = window.setInterval(async () => {
      const items = libraryItems();
      if (items.length || ++tries >= 20) {
        clearInterval(watcher);
        saveJob({ ...job, phase: "library" });
        await chrome.runtime.sendMessage({ type: "hotcontainer-library", jobId: job.jobId, items });
      }
    }, 500);
  }

  function generationAccepted() {
    const pageText = normal(document.body?.innerText);
    return pageText.includes("video sa generuje") || pageText.includes("video esta sendo gerado") || pageText.includes("video is being generated");
  }

  function watchForGenerationConfirmation() {
    let tries = 0;
    const watcher = window.setInterval(async () => {
      const job = readJob();
      if (!job || job.phase === "accepted") return clearInterval(watcher);
      if (generationAccepted()) {
        clearInterval(watcher);
        const accepted = { ...job, phase: "accepted" };
        saveJob(accepted);
        await chrome.runtime.sendMessage({
          type: "hotcontainer-status",
          jobId: accepted.jobId,
          itemId: accepted.itemId,
          state: "accepted",
          text: "Prijaté – vytvára sa v Moje videá."
        });
      }
      if (++tries >= 30) clearInterval(watcher);
    }, 500);
  }

  function startHandoff() {
    const handoff = handoffFromHash();
    if (!handoff) return;
    if (handoff.mode === "library") {
      const job = { ...handoff, phase: "library", startedAt: Date.now() };
      saveJob(job);
      history.replaceState(null, "", `${location.pathname}${location.search}`);
      watchForLibrary(job);
      return;
    }
    const field = findProfileField();
    if (!field || !findListButton()) return;
    saveJob({ ...handoff, phase: "listing", startedAt: Date.now() });
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    window.setTimeout(() => {
      chrome.runtime.sendMessage({ type: "submit-hotcontainer-profile", profileUrl: handoff.profileUrl }, (result) => {
        if (!result?.ok) {
          chrome.runtime.sendMessage({
            type: "hotcontainer-gallery-error",
            jobId: handoff.jobId,
            text: result?.error || "HotContainer odmietol odkaz.",
          });
          return;
        }
        const job = readJob();
        if (!job) return;
        if (job.selectThumbnail) watchForGalleryAndSelect(job);
        else watchForGallery(job);
      });
    }, 150);
  }

  // NOTE: item selection used to be driven by a runtime message
  // ("select-hotcontainer-item") sent into the same tab the user was
  // watching load, clicking that tab's own pager to reach the target page —
  // which visibly hijacked and repainted the gallery tab out from under the
  // user mid-scroll. It's now handled entirely by watchForGalleryAndSelect
  // above, running in its own short-lived hidden tab spun up specifically
  // for one selection (see background.js's select-hotcontainer-item
  // handler) — the visible gallery tab is never touched.

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "library-action") return;
    const job = readJob();
    if (!job || job.jobId !== message.jobId || job.mode !== "library") {
      sendResponse({ ok: false, error: "Relácia Mojich videí vypršala. Klikni na Moje videá znova." });
      return;
    }
    const card = document.querySelector(`[data-hc-library-item="${CSS.escape(message.itemId)}"]`);
    if (!card) {
      sendResponse({ ok: false, error: "Video už nie je v zozname Mojich videí." });
      return;
    }
    if (message.action === "download") {
      const hqUrl = getHighQualityUrl(card);
      if (!hqUrl) {
        chrome.runtime.sendMessage({ type: "hotcontainer-status", jobId: job.jobId, itemId: message.itemId, text: "Kvalitný odkaz sa nenašiel." });
        sendResponse({ ok: false, error: "Kvalitný odkaz sa nenašiel." });
        return;
      }
      void (async () => {
        try {
          const result = await chrome.runtime.sendMessage({
            type: "hotcontainer-download", url: hqUrl,
            title: card.querySelector("a[href*='/player/p2?link='] p")?.textContent?.trim() || "HotContainer video",
          });
          sendResponse(result || { ok: false, error: "Sťahovanie sa nepodarilo spustiť." });
        } catch (error) {
          sendResponse({ ok: false, error: error.message });
        }
      })();
      return true;
    }
    if (message.action === "play") {
      const hqUrl = getHighQualityUrl(card);
      if (!hqUrl) {
        chrome.runtime.sendMessage({ type: "hotcontainer-status", jobId: job.jobId, itemId: message.itemId, text: "Kvalitný odkaz pre Sidecar sa nenašiel." });
        sendResponse({ ok: false, error: "Kvalitný odkaz pre Sidecar sa nenašiel." });
        return;
      }
      chrome.runtime.sendMessage({
        type: "hotcontainer-sidecar",
        jobId: job.jobId,
        itemId: message.itemId,
        item: {
          url: hqUrl,
          title: card.querySelector("a[href*='/player/p2?link='] p")?.textContent?.trim() || "HotContainer video",
          poster: card.querySelector("img")?.currentSrc || card.querySelector("img")?.src || "",
          pageUrl: location.href,
          sourceUrl: location.href,
          typeHint: hqUrl.includes('.m3u8') ? "hls" : "file"
        }
      });
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: "Neznáma akcia pre video." });
  });

  let attempts = 0;
  const starter = window.setInterval(() => {
    startHandoff();
    if (++attempts >= 20 || !location.hash.startsWith("#nexus-job=")) clearInterval(starter);
  }, 300);

  watchForGenerationConfirmation();
})();
