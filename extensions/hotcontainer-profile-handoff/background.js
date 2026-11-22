importScripts("qualities.js", "premium.js");
importScripts("direct-rules.js");

const HOTCONTAINER_RED_PAGE = "https://hotcontainer.co/tabred";
const HOTCONTAINER_LIBRARY_PAGE = "https://hotcontainer.co/meusvideos";
const JOB_PREFIX = "hotcontainerProfileHandoff:";
//: Candidate Nexus dashboard ports, same list Nexus_Gallery probes — kept in
//: sync manually since these are separate extensions with no shared module.
const NEXUS_PORTS = [8001, 8000, 8002, 8003, 8004, 8005];

function jobKey(jobId) { return `${JOB_PREFIX}${jobId}`; }

async function findDashboardUrl() {
  const stored = await chrome.storage.local.get(["selected_port"]);
  const preferredPort = stored.selected_port || 8001;
  const check = async (port) => {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/v1/config/gofile_token`, {
        signal: AbortSignal.timeout(700),
      }).catch(() => null);
      return !!(resp && resp.ok);
    } catch {
      return false;
    }
  };
  if (await check(preferredPort)) return `http://127.0.0.1:${preferredPort}`;
  for (const port of NEXUS_PORTS) {
    if (port === preferredPort) continue;
    if (await check(port)) return `http://127.0.0.1:${port}`;
  }
  return `http://127.0.0.1:${preferredPort}`;
}

async function getStoredBridgeToken() {
  try {
    const stored = await chrome.storage.local.get(["nexus_bridge_token", "bridge_token", "nexusBridgeToken"]);
    return String(stored?.nexus_bridge_token || stored?.bridge_token || stored?.nexusBridgeToken || "").trim();
  } catch {
    return "";
  }
}

async function buildLocalApiHeaders(extraHeaders = {}) {
  const headers = { ...(extraHeaders || {}) };
  const bridgeToken = await getStoredBridgeToken();
  if (bridgeToken) headers["X-Nexus-Token"] = bridgeToken;
  return headers;
}

// HotContainer's hqUrl is a signed link that dies in roughly 1-3 hours (its
// own "Moje videá" page says so). A plain bulk-import only STORES that url
// for later on-demand streaming, so it would already be dead by the time
// anyone plays it — this imports the row AND immediately kicks off the
// existing server-side download-to-disk job (the same one the dashboard's
// manual "Download" button uses), so the video survives past the token's
// lifetime as a real local file instead of a rotted link.
async function nexusHotcontainerImportBulk(items) {
  const list = Array.isArray(items) ? items : [];
  const videos = list
    .map((raw) => {
      const hqUrl = String(raw?.hqUrl || "").trim();
      const sourceUrl = String(raw?.sourceUrl || "").trim();
      if (!hqUrl) return null;
      return {
        url: hqUrl,
        title: String(raw?.title || "HotContainer Video").trim() || "HotContainer Video",
        source_url: sourceUrl || hqUrl,
        source_scope: "collection",
        thumbnail: raw?.thumbnail || null,
        tags: "xvideos-red,hotcontainer",
      };
    })
    .filter(Boolean);
  if (!videos.length) throw new Error("No HotContainer videos were prepared for import");

  const baseUrl = await findDashboardUrl();
  const importResp = await fetch(`${baseUrl}/api/v1/import/bulk`, {
    method: "POST",
    headers: await buildLocalApiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ batch_name: "HotContainer XVideos RED", videos }),
  });
  const importData = await importResp.json().catch(() => ({}));
  if (!importResp.ok) throw new Error(importData.detail || `Nexus returned ${importResp.status}`);

  const videoIds = Array.isArray(importData.video_ids) ? importData.video_ids : [];
  const downloadHeaders = await buildLocalApiHeaders();
  const downloadResults = await Promise.allSettled(
    videoIds.map((id) =>
      fetch(`${baseUrl}/api/v1/videos/${id}/download`, {
        method: "POST",
        headers: downloadHeaders,
      })
    )
  );
  const downloadsStarted = downloadResults.filter((r) => r.status === "fulfilled" && r.value.ok).length;
  return { imported: videoIds.length, downloadsStarted, data: importData };
}

function isSupportedProfile(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.hostname.toLowerCase().replace(/^www\./, "") === "xvideos.com";
  } catch { return false; }
}

function normalizeProfile(rawUrl) {
  const url = new URL(rawUrl);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const hashBody = url.hash.replace(/^#/, "");
  // HotContainer accepts the address-bar link only with the RED filters.
  // A bare #_tabRed is rejected ("Informe um link válido!").
  const hash = /^_tabRed,/i.test(hashBody) ? hashBody : "_tabRed,premium,new";
  return `${url.origin}${path}#${hash}`;
}

async function fillHotcontainerProfile(profileUrl) {
  const parsed = new URL(profileUrl);
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  const hashBody = parsed.hash.replace(/^#/, "");
  const hash = /^_tabRed,/i.test(hashBody) ? hashBody : "_tabRed,premium,new";
  const link = `${parsed.origin}${path}#${hash}`;
  const visible = (el) => !!(el && el.getClientRects && el.getClientRects().length);
  const fields = [...document.querySelectorAll("input, textarea")].filter((field) => {
    const type = (field.getAttribute("type") || "text").toLowerCase();
    return type === "text" || type === "url" || type === "search";
  });
  const label = (field) => `${field.placeholder || ""} ${field.name || ""} ${field.id || ""} ${field.getAttribute("aria-label") || ""}`;
  const field = fields.find((item) => /perfil|profile|canal|channel|pornstar|xvideos|link/i.test(label(item)))
    || fields.find((item) => visible(item) && !item.disabled);
  if (!field) return { ok: false, error: "Pole na odkaz profilu sa nenašlo." };
  // type=url can drop the #fragment, which is the part HotContainer requires.
  if ((field.getAttribute("type") || "").toLowerCase() === "url") field.setAttribute("type", "text");
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  field.focus();
  setter?.call(field, link);
  field.setAttribute("value", link);
  field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: link }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
  field.dispatchEvent(new Event("blur", { bubbles: true }));
  if (field.value !== link) return { ok: false, error: `Do poľa sa nepodarilo vložiť odkaz ${link}.`, fieldValue: field.value };
  const button = [...document.querySelectorAll("button, input, a")].find((element) => {
    if (!visible(element) || element.disabled) return false;
    const text = `${element.textContent || ""} ${element.value || ""}`.replace(/\s+/g, " ").trim();
    return /listar\s+vide/i.test(text);
  });
  if (!button) return { ok: false, error: "Tlačidlo Listar videos sa nenašlo." };
  const previousAlert = window.alert;
  let rejected = "";
  window.alert = (message) => { rejected = String(message || "Informe um link válido!"); };
  try {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
  } finally {
    window.alert = previousAlert;
  }
  if (rejected) return { ok: false, error: `HotContainer odmietol odkaz ${link}: ${rejected}`, fieldValue: field.value };
  return { ok: true, fieldValue: field.value };
}

async function getJob(jobId) {
  const data = await chrome.storage.session.get(jobKey(jobId));
  const job = data[jobKey(jobId)];
  return job && Date.now() - job.createdAt < 10 * 60 * 1000 ? job : null;
}

// Same request collectFromApi makes, without opening a profile tab.
// GET {origin}{userUrl}/fan-club/best/{mainCat?}premium|membership/{page}
// Headers: Accept: application/json. Cookies go with the request because
// the extension has host permission for xvideos.com (credentials: 'include').
// userUrl and mainCat are the fields readProfileListing used to scrape from
// inline scripts; here they come from one HTML GET of the stored profile URL.
async function collectHotcontainerPremiumCatalog(profileUrl) {
  const pageUrl = new URL(profileUrl);
  const pageResp = await fetch(pageUrl.toString(), {
    method: "GET",
    credentials: "include",
    headers: { Accept: "text/html" },
  });
  if (!pageResp.ok) throw new Error(`Profil vrátil ${pageResp.status}.`);
  const html = await pageResp.text();
  const rawUrl = html.match(/"url":"(\\\/(?:channels|profiles|models|pornstars)\\\/[^"\\]+)"/);
  const userUrl = rawUrl?.[1]?.replace(/\\\//g, "/") || pageUrl.pathname.replace(/\/+$/, "");
  if (!userUrl || userUrl === "/") throw new Error("Z profilu sa nepodarilo prečítať adresu fan-club zoznamu.");
  const mainCat = html.match(/"main_cat":"([a-z]+)"/)?.[1] || "";
  const multipleCats = /"main_cats":\[[^\]]+,/.test(html);
  return HotContainerPremium.collectFromListing({
    origin: pageUrl.origin,
    userUrl,
    mainCat: multipleCats ? mainCat : "",
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "filter-hotcontainer-premium") {
    void (async () => {
      try {
        const job = await getJob(message.jobId);
        if (!job?.profileUrl || sender.tab?.id !== job.hotTabId) throw new Error('Relácia HotContaineru vypršala.');
        let catalogResponse;
        try {
          const catalog = await collectHotcontainerPremiumCatalog(job.profileUrl);
          catalogResponse = catalog
            ? { ok: true, catalog }
            : { ok: false, error: 'Profil nemá samostatný PREMIUM zoznam.' };
        } catch (error) {
          catalogResponse = { ok: false, error: error?.message || 'Kontrola PREMIUM sa nedokončila.' };
        }
        const rawItems = message.items || [];
        let items = catalogResponse?.ok ? HotContainerPremium.filter(rawItems, catalogResponse.catalog) : [];
        const diagnostics = { input: rawItems.length, helperPremium: catalogResponse?.catalog?.ids?.length || 0, currentPremium: 0, matched: items.length };
        let partial = false;
        if (job.sourceTabId != null) {
          try {
            const current = await chrome.tabs.sendMessage(job.sourceTabId, { type: 'collect-current-hotcontainer-premium' });
            if (current?.ok) {
              diagnostics.currentPremium = current.catalog?.ids?.length || 0;
              const currentItems = HotContainerPremium.filter(rawItems, current.catalog);
              const keyOf = item => item.id || item.videoId || item.thumbnail || item.title;
              const verified = new Map();
              for (const item of [...items, ...currentItems]) {
                const previous = verified.get(keyOf(item));
                verified.set(keyOf(item), { ...item,
                  duration: item.duration || previous?.duration || '',
                  addedDate: item.addedDate || previous?.addedDate || '',
                });
              }
              // Preserve Novo order while merging both verified catalogs.
              items = rawItems.filter(item => verified.has(keyOf(item))).map(item => verified.get(keyOf(item)));
              partial = !catalogResponse?.ok || diagnostics.helperPremium === 0;
            }
          } catch { /* source tab may be closed or blocked */ }
        }
        diagnostics.matched = items.length;
        if (!items.length && rawItems.length) {
          const counts = `HC 0.2.2: HotContainer=${diagnostics.input}, pomocná PREMIUM=${diagnostics.helperPremium}, otvorená PREMIUM=${diagnostics.currentPremium}, zhody=0`;
          throw new Error(`${catalogResponse?.error || 'Kontrola PREMIUM sa nedokončila. Videá sa nepodarilo priradiť.'} ${counts}`);
        }
        sendResponse({ ok: true, items, diagnostics, partial });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }
  if (message?.type === "hotcontainer-download") {
    void (async () => {
      try {
        const host = new URL(sender.tab?.url || sender.url || "").hostname.replace(/^www\./, "");
        const isDirectPage = typeof sender.url === "string"
          && sender.url.split("#")[0] === chrome.runtime.getURL?.("direct.html");
        if (!isDirectPage && !["xvideos.com", "hotcontainer.co"].includes(host)) throw new Error("Nepodporovaná stránka.");
        if (!HotContainerQualities.isAllowedUrl(message.url)) throw new Error("Nepodporovaný zdroj videa.");
        if (/\.m3u8(?:[?#]|$)/i.test(message.url)) await HotContainerQualities.load(message.url);
        const baseUrl = await findDashboardUrl();
        let response;
        try {
          response = await fetch(`${baseUrl}/api/tester/idm`, {
            method: "POST",
            headers: await buildLocalApiHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ start: true, items: [{
              url: message.url,
              filename: `${String(message.title || "HotContainer video").replace(/\.(?:m3u8|mp4)$/i, "")}.mp4`,
            }] }),
            signal: AbortSignal.timeout(30000),
          });
        } catch {
          throw new Error("Nexus nie je dostupný. Spusti Nexus a skús Stiahnuť znova.");
        }
        const result = await response.json();
        if (!response.ok || result.queued !== 1) {
          if (!chrome.downloads?.download || !/\.m3u8(?:[?#]|$)/i.test(message.url)) {
            throw new Error(result.detail || result.skipped?.[0]?.reason || "IDM nepotvrdil prevzatie sťahovania.");
          }
          const token = btoa(new URL(message.url).href).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          const name = String(message.title || "HotContainer video").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120).replace(/\.(?:m3u8|mp4)$/i, "") || "video";
          await chrome.downloads.download({
            url: `${baseUrl}/api/tester/hls-download/${token}/${name}.mp4`,
            filename: `${name}.mp4`, conflictAction: "uniquify",
          });
          sendResponse({ ok: true, method: "chrome" });
          return;
        }
        sendResponse({ ok: true, method: "idm" });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || "Sťahovanie sa nepodarilo spustiť." });
      }
    })();
    return true;
  }

  if (message?.type === "hotcontainer-qualities") {
    void (async () => {
      try {
        const senderHost = new URL(sender.tab?.url || sender.url || "").hostname.replace(/^www\./, "");
        if (!["xvideos.com", "hotcontainer.co"].includes(senderHost)) throw new Error("Nepodporovaná stránka.");
        const variants = await HotContainerQualities.load(message.url);
        sendResponse({ ok: true, variants });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || "Kvality sa nepodarilo načítať." });
      }
    })();
    return true;
  }

  if (message?.type === "submit-hotcontainer-profile") {
    const tabId = sender.tab?.id;
    if (tabId == null || !isSupportedProfile(message.profileUrl)) {
      sendResponse({ ok: false, error: "Odkaz profilu sa nedá vložiť." });
      return;
    }
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: fillHotcontainerProfile,
      args: [message.profileUrl],
    }).then((results) => {
      sendResponse(results?.[0]?.result || { ok: false, error: "Vloženie odkazu nevrátilo výsledok." });
    }).catch((error) => {
      sendResponse({ ok: false, error: error?.message || "Odkaz sa nepodarilo vložiť do formulára." });
    });
    return true;
  }

  if (message?.type === "open-hotcontainer-red") {
    if (!isSupportedProfile(message.profileUrl) || sender.tab?.id == null) {
      sendResponse({ ok: false, error: "Nepodporovaný odkaz na profil alebo kanál." });
      return;
    }
    const jobId = crypto.randomUUID();
    const profileUrl = normalizeProfile(message.profileUrl);
    const targetUrl = `${HOTCONTAINER_RED_PAGE}#nexus-job=${jobId}&profile=${encodeURIComponent(profileUrl)}`;
    chrome.tabs.create({ url: "about:blank", active: false }).then(async (tab) => {
      await chrome.storage.session.set({
        [jobKey(jobId)]: { sourceTabId: sender.tab.id, hotTabId: tab.id, profileUrl, createdAt: Date.now() }
      });
      await chrome.tabs.update(tab.id, { url: targetUrl });
      sendResponse({ ok: true, jobId });
    }).catch(() => sendResponse({ ok: false, error: "Nepodarilo sa otvoriť HotContainer." }));
    return true;
  }

  if (message?.type === "open-hotcontainer-library") {
    if (sender.tab?.id == null) {
      sendResponse({ ok: false, error: "Nenašla sa pôvodná karta." });
      return;
    }
    const jobId = crypto.randomUUID();
    const targetUrl = `${HOTCONTAINER_LIBRARY_PAGE}#nexus-job=${jobId}&mode=library`;
    chrome.tabs.create({ url: "about:blank", active: false }).then(async (tab) => {
      await chrome.storage.session.set({
        [jobKey(jobId)]: { sourceTabId: sender.tab.id, hotTabId: tab.id, mode: "library", createdAt: Date.now() }
      });
      await chrome.tabs.update(tab.id, { url: targetUrl });
      sendResponse({ ok: true, jobId });
    }).catch(() => sendResponse({ ok: false, error: "Nepodarilo sa otvoriť Moje videá." }));
    return true;
  }

  if (["hotcontainer-gallery", "hotcontainer-gallery-error", "hotcontainer-gallery-progress", "hotcontainer-library", "hotcontainer-status", "hotcontainer-sidecar"].includes(message?.type)) {
    getJob(message.jobId).then((job) => {
      if (job?.sourceTabId != null) {
        // A select-item job runs under its OWN jobId/hidden tab (see
        // select-hotcontainer-item below) — the content script's gallery
        // listener filters incoming messages by activeJobId, so relaying
        // this as-is would be silently dropped and the card would sit on
        // "Pracujem…" forever. Rewriting jobId back to the parent gallery
        // job (and itemId to the card that started it) makes it look, from
        // the visible tab's point of view, like the status update came from
        // its own job — which for UI purposes it did.
        const outgoing = job.isSelectJob
          ? { ...message, jobId: job.parentJobId, itemId: job.parentItemId }
          : message;
        chrome.tabs.sendMessage(job.sourceTabId, outgoing).catch(() => {});
      }
      // A select-item job's hidden tab (see select-hotcontainer-item below)
      // has exactly one purpose — click one card — so it closes itself on
      // either outcome. The ordinary full-gallery job only ever closes on
      // "accepted" (its tab is meant to stay open and visible otherwise).
      const shouldCloseTab = message.type === "hotcontainer-status"
        && (message.state === "accepted" || (job?.isSelectJob && message.state === "failed"));
      if (shouldCloseTab) {
        const tabIds = [...new Set([sender.tab?.id, job?.hotTabId].filter(Number.isInteger))];
        if (tabIds.length) chrome.tabs.remove(tabIds).catch(() => {});
      }
      sendResponse({ ok: Boolean(job) });
    });
    return true;
  }

  if (message?.type === "select-hotcontainer-item") {
    // The card anchor is a same-origin GET. A service-worker fetch drops the
    // session, so the listing tab that is already open performs it.
    void (async () => {
      let reported = false;
      const report = (state, text) => {
        reported = true;
        if (message.itemId == null) return;
        getJob(message.jobId).then((job) => {
          if (job?.sourceTabId == null) return;
          chrome.tabs.sendMessage(job.sourceTabId, {
            type: "hotcontainer-status",
            jobId: message.jobId,
            itemId: message.itemId,
            state,
            text,
          }).catch(() => {});
        });
      };
      try {
        const job = await getJob(message.jobId);
        if (!job?.profileUrl || job.hotTabId == null) throw new Error("Relácia zoznamu už nie je otvorená.");
        let watchUrl = String(message.watchUrl || "").trim();
        let sourceVideoUrl = String(message.sourceVideoUrl || "").trim();
        if (!watchUrl || !sourceVideoUrl) {
          const cacheKey = `hc-gallery-cache:${job.profileUrl}`;
          const stored = await chrome.storage.local.get(cacheKey);
          const items = stored?.[cacheKey]?.items || [];
          const match = items.find((item) => item?.thumbnail && item.thumbnail === message.thumbnail)
            || items.find((item) => item?.title && item.title === message.title);
          watchUrl = watchUrl || String(match?.watchUrl || "").trim();
          sourceVideoUrl = sourceVideoUrl || String(match?.sourceVideoUrl || "").trim();
        }
        if (!watchUrl && sourceVideoUrl) {
          const target = new URL("/vip/servico/assistir/XVideosRed", HOTCONTAINER_RED_PAGE);
          target.searchParams.set("link", sourceVideoUrl);
          watchUrl = target.toString();
        }
        if (!watchUrl) throw new Error("Odkaz na video sa nenašiel.");
        const [injected] = await chrome.scripting.executeScript({
          target: { tabId: job.hotTabId },
          world: "MAIN",
          func: async (pageUrl) => {
            const response = await fetch(pageUrl, {
              method: "GET",
              credentials: "include",
              redirect: "follow",
              headers: { Accept: "text/html" },
            });
            const html = await response.text();
            const plain = html.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
            return { status: response.status, url: response.url || pageUrl, plain: plain.slice(0, 4000) };
          },
          args: [watchUrl],
        });
        const result = injected?.result;
        if (!result) throw new Error("Požiadavka na položku nevrátila odpoveď.");
        const plain = result.plain || "";
        const landedOnLogin = /\/cadastro\/login|\/login/i.test(result.url || "");
        const rejected = plain.includes("informe um link valido") || plain.includes("link invalido");
        const accepted = result.status >= 200 && result.status < 300 && !landedOnLogin && !rejected && (
          plain.includes("video sa generuje")
          || plain.includes("video esta sendo gerado")
          || plain.includes("video is being generated")
          || /assistir\/xvideosred/i.test(result.url || "")
        );
        const statusText = accepted
          ? "Prijaté – vytvára sa v Moje videá."
          : (landedOnLogin ? "Služba vyžaduje prihlásenie." : `Služba položku neprijala (${result.status}).`);
        report(accepted ? "accepted" : "failed", statusText);
        if (!accepted) throw new Error(statusText);
        sendResponse({ ok: true });
      } catch (error) {
        const text = error?.message || "Výber videa zlyhal.";
        if (!reported) report("failed", text);
        sendResponse({ ok: false, error: text });
      }
    })();
    return true;
  }

  if (message?.type === "library-action") {
    getJob(message.jobId).then((job) => {
      if (job?.hotTabId == null) return sendResponse({ ok: false, error: "Moje videá nie sú pripravené." });
      chrome.tabs.sendMessage(job.hotTabId, message).then(
        (result) => sendResponse(result || { ok: false, error: "Karta nepotvrdila akciu." }),
        () => sendResponse({ ok: false, error: "Karta s videami už nie je otvorená." })
      );
    });
    return true;
  }

  if (message?.type === "launch-library-player") {
    chrome.tabs.create({ url: message.url, active: true }).then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false, error: "Prehrávač sa nepodarilo otvoriť." })
    );
    return true;
  }

  if (message?.type === "import-to-nexus") {
    nexusHotcontainerImportBulk(message.items)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

});
