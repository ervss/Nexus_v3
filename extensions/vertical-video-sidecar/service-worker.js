const MENU_QUEUE_ID = "sidecar-queue-video";
const MENU_PLAY_ID = "sidecar-play-video";
const PLAYBACK_RULE_ID = 84001;
const MAX_BATCH = 100;
const MAX_QUEUE = 500;
let queueWrites = Promise.resolve();

// Queue changes from every tab share one writer. A failed write must not block
// subsequent requests, and each operation reads the latest committed queue.
function writeQueue(operation) {
  const task = queueWrites.then(async () => {
    const state = await chrome.storage.local.get({ queue: [], activeId: null });
    state.queue = Array.isArray(state.queue) ? state.queue : [];
    const result = operation(state);
    await chrome.storage.local.set({ queue: state.queue, activeId: state.activeId });
    return result;
  });
  queueWrites = task.catch(() => {});
  return task;
}

function changeQueue(operation) {
  return writeQueue(state => {
    if (operation.kind === 'remove') {
      const ids = new Set(operation.ids || []);
      state.queue = state.queue.filter(item => !ids.has(item.id));
    } else if (operation.kind === 'reorder') {
      const from = state.queue.findIndex(item => item.id === operation.from);
      const to = state.queue.findIndex(item => item.id === operation.to);
      if (from >= 0 && to >= 0) state.queue.splice(to, 0, state.queue.splice(from, 1)[0]);
    } else if (operation.kind === 'activate') {
      if (state.queue.some(item => item.id === operation.id)) state.activeId = operation.id;
    } else if (operation.kind === 'restore') {
      const candidate = normalizeCandidate(operation.item);
      if (!candidate) throw new Error('This history item has no usable URL.');
      let item = state.queue.find(item => item.url === candidate.url);
      if (!item) {
        if (state.queue.length >= MAX_QUEUE) throw new Error('Queue is full. Remove an item before restoring history.');
        item = { ...candidate, id: crypto.randomUUID(), addedAt: Date.now() };
        state.queue.unshift(item);
      }
      state.activeId = item.id;
    } else {
      throw new Error('Unknown queue operation.');
    }
    if (!state.queue.some(item => item.id === state.activeId)) state.activeId = state.queue[0]?.id || null;
    return { activeId: state.activeId };
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_QUEUE_ID, title: "Add video to Sidecar playlist", contexts: ["video"] });
    chrome.contextMenus.create({ id: MENU_PLAY_ID, title: "Play video in Sidecar now", contexts: ["video"] });
  });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (![MENU_QUEUE_ID, MENU_PLAY_ID].includes(info.menuItemId) || !tab?.id) return;
  const candidate = await askForCandidate(tab.id, info.frameId);
  if (candidate) await addManyAndOpen([candidate], tab.id, { activate: info.menuItemId === MENU_PLAY_ID });
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "add-current-video") return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return;
  const candidate = await askForCandidate(tab.id);
  if (candidate) await addManyAndOpen([candidate], tab.id);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CHANGE_QUEUE") {
    changeQueue(message.operation || {}).then(
      result => sendResponse({ ok: true, ...result }),
      error => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }
  if (message.type === "ADD_VIDEO") {
    resolveTabId(sender)
      .then(async (tabId) => {
        const nativePanel = message.nativePanel === true && sender.url === chrome.runtime.getURL("popup.html");
        const targetTab = nativePanel && Number.isInteger(message.tabId) ? message.tabId : tabId;
        if (nativePanel) await chrome.tabs.sendMessage(targetTab, { type: "HIDE_DOCK" }).catch(() => {});
        return addManyAndOpen([message.candidate], targetTab, { activate: !!message.playNow, openDock: !nativePanel });
      })
      .then(
        (result) => sendResponse({ ok: true, ...result }),
        (error) => sendResponse({ ok: false, error: error.message })
      );
    return true;
  }
  if (message.type === "ADD_MANY") {
    resolveTabId(sender)
      .then((tabId) => addManyAndOpen(message.items, tabId, { activate: !!message.playNow }))
      .then(
        (result) => sendResponse({ ok: true, ...result }),
        (error) => sendResponse({ ok: false, error: error.message })
      );
    return true;
  }
  if (message.type === "PREPARE_MEDIA") {
    prepareMediaRequest(message.item).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }
});

// Nexus Video Selector targets this stable extension id and sends only selected
// playback records. The receiver still validates every field and caps batches.
chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "NEXUS_SELECTOR_ENQUEUE" || message.protocol !== 1) return;
  handleSelectorBatch(message).then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: error.message })
  );
  return true;
});

async function handleSelectorBatch(message) {
  if (!Array.isArray(message.items) || !message.items.length) throw new Error("Selector did not send any videos.");
  if (message.items.length > MAX_BATCH) throw new Error(`A single Sidecar batch is limited to ${MAX_BATCH} videos.`);
  const tabId = Number.isInteger(message.sourceTabId) ? message.sourceTabId : undefined;
  if (tabId !== undefined) {
    const tab = await chrome.tabs.get(tabId);
    const claimedPage = message.sourcePageUrl || message.items[0]?.pageUrl || message.items[0]?.sourceUrl;
    if (claimedPage && !sameOrigin(tab.url, claimedPage)) throw new Error("The selected videos do not belong to the source tab.");
  }
  return addManyAndOpen(message.items, tabId, { activate: !!message.playNow });
}

// Messages from popup.js have no sender.tab (a popup is not a content
// script). Without a tabId, addManyAndOpen never opens the dock, so a video
// added from the toolbar popup silently vanished into the queue. Fall back
// to the active tab of the current window in that case.
async function resolveTabId(sender) {
  if (sender.tab?.id !== undefined) return sender.tab.id;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id;
  } catch {
    return undefined;
  }
}

async function askForCandidate(tabId, frameId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "GET_LAST_VIDEO" }, frameId === undefined ? undefined : { frameId });
  } catch {
    return null;
  }
}

function normalizeCandidate(raw) {
  const url = String(raw?.streamUrl || raw?.url || "").trim();
  if (!/^https?:/i.test(url)) return null;
  const pageUrl = String(raw?.pageUrl || raw?.sourceUrl || "").trim();
  return {
    url,
    title: String(raw?.title || "Untitled video").slice(0, 200),
    pageUrl: /^https?:/i.test(pageUrl) ? pageUrl : "",
    sourceUrl: /^https?:/i.test(String(raw?.sourceUrl || "")) ? String(raw.sourceUrl) : pageUrl,
    poster: String(raw?.poster || raw?.thumbnail || "").slice(0, 4000),
    typeHint: raw?.typeHint === "hls" || /\.m3u8(?:$|[?#])/i.test(url) ? "hls" : "file",
    quality: raw?.quality || null,
    duration: raw?.duration || null,
    captureHint: String(raw?.captureHint || "").slice(0, 300)
  };
}

function bunkrSlug(pageUrl) {
  try { return new URL(pageUrl).pathname.match(/\/f\/([^/?#]+)/i)?.[1] || ""; }
  catch { return String(pageUrl || "").match(/\/f\/([^/?#]+)/i)?.[1] || ""; }
}

function decodeBunkrUrl(encoded, timestamp) {
  try {
    const bytes = atob(encoded);
    const key = `SECRET_KEY_${Math.floor(Number(timestamp) / 3600)}`;
    return [...bytes].map((char, index) => String.fromCharCode(char.charCodeAt(0) ^ key.charCodeAt(index % key.length))).join("");
  } catch { return ""; }
}

function directBunkrUrlFromHtml(html, baseUrl) {
  const patterns = [
    /"file"\s*:\s*"([^"\\]+\.(?:mp4|mkv|webm)[^"]*)"/gi,
    /"src"\s*:\s*"([^"\\]+\.(?:mp4|mkv|webm)[^"]*)"/gi,
    /source\s+src=["']([^"']+\.(?:mp4|mkv|webm)[^"']*)["']/gi,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(String(html || ""));
    if (!match?.[1] || /preview|thumb|sample|trailer/i.test(match[1])) continue;
    try { return new URL(match[1].replace(/\\/g, ""), baseUrl).href; } catch {}
  }
  return "";
}

async function resolveBunkrPage(pageUrl) {
  let origin = "";
  try { origin = new URL(pageUrl).origin; } catch { return ""; }
  const slug = bunkrSlug(pageUrl).replace(/\.(mp4|mkv|mov|webm|m4v|avi)$/i, "");
  if (slug) {
    try {
      const response = await fetch(`${origin}/api/vs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ slug }),
      });
      const data = response.ok ? await response.json() : null;
      let direct = String(data?.url || "");
      if (data?.encrypted && direct) direct = decodeBunkrUrl(direct, data.timestamp);
      if (/^https?:/i.test(direct) && !/preview|thumb/i.test(direct)) return direct;
    } catch {}
  }
  try {
    const response = await fetch(pageUrl);
    return response.ok ? directBunkrUrlFromHtml(await response.text(), pageUrl) : "";
  } catch { return ""; }
}

async function addManyAndOpen(rawItems, tabId, { activate = false, openDock = true } = {}) {
  if (!Array.isArray(rawItems) || rawItems.length > MAX_BATCH) throw new Error(`A single batch is limited to ${MAX_BATCH} videos.`);
  const items = [];
  for (const raw of rawItems || []) {
    const item = normalizeCandidate(raw);
    if (!item) continue;
    if (/bunkr|balbums/i.test(item.url) && /\/f\//i.test(item.url)) {
      const directUrl = await resolveBunkrPage(item.url);
      if (directUrl) item.url = directUrl;
    }
    items.push(item);
  }
  if (!items.length) throw new Error("No usable http(s) MP4/HLS URL was supplied.");
  const result = await writeQueue(state => {
  const queue = Array.isArray(state.queue) ? state.queue : [];
  const known = new Set(queue.map((item) => item.url));
  const incoming = new Set(items.map(item => item.url).filter(url => !known.has(url)));
  if (queue.length + incoming.size > MAX_QUEUE) throw new Error('Queue is full. Remove items before adding this batch; nothing was discarded.');
  const added = [];
  for (const item of items) {
    if (known.has(item.url)) continue;
    const record = { ...item, id: crypto.randomUUID(), addedAt: Date.now() };
    queue.push(record); known.add(item.url); added.push(record);
  }
  // Playlist enqueue deliberately preserves the viewer's current video.  Only
  // an explicit "play now" request may replace it; the first ever item still
  // becomes active so a new Sidecar is ready to use.
  const existingActive = queue.some((item) => item.id === state.activeId) ? state.activeId : null;
  const activeId = activate
    ? (added[0]?.id || queue.find((item) => item.url === items[0].url)?.id || existingActive || queue[0]?.id || null)
    : (existingActive || queue[0]?.id || null);
  state.queue = queue;
  state.activeId = activeId;
  return { added: added.length, duplicates: items.length - added.length, total: queue.length };
  });
  if (openDock && tabId !== undefined) await showDock(tabId);
  return result;
}

async function prepareMediaRequest(item) {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [PLAYBACK_RULE_ID] });
  const mediaUrl = new URL(item?.url || "");
  if (!/^https?:$/.test(mediaUrl.protocol)) throw new Error("Unsupported media protocol.");
  let referrer;
  try {
    const source = new URL(item?.pageUrl || item?.sourceUrl || "");
    if (!/^https?:$/.test(source.protocol) || source.origin === mediaUrl.origin) return;
    referrer = `${source.origin}/`;
  } catch {
    return;
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{
      id: PLAYBACK_RULE_ID,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "Referer", operation: "set", value: referrer }]
      },
      condition: {
        resourceTypes: ["media", "xmlhttprequest", "other"],
        tabIds: [chrome.tabs.TAB_ID_NONE]
      }
    }]
  });
}

async function showDock(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { type: "SHOW_DOCK" }); }
  catch { await chrome.sidePanel.open({ tabId }); }
}

function sameOrigin(left, right) {
  try { return new URL(left).origin === new URL(right).origin; }
  catch { return false; }
}
