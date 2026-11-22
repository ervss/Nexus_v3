importScripts("lib/nexus_bridge.js");

const SETTINGS_KEY = "nexus-deck-settings";
const DEFAULT_BASE = "http://127.0.0.1:8000";
const offlineQueue = new globalThis.NexusBridge.OfflineImportQueue();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "send-nexus",
      title: "Poslať odkaz do Nexus Gallery",
      contexts: ["link", "video", "page", "selection"],
    });
  });
  chrome.alarms.create("nexus-badge", { periodInMinutes: 1 });
  refreshBadge();
});

chrome.runtime.onStartup.addListener(() => refreshBadge());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "nexus-badge") refreshBadge();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const raw = info.linkUrl || info.srcUrl || (looksLikeUrl(info.selectionText) ? info.selectionText : "") || info.pageUrl;
  if (!raw) return;
  await postImport([raw.trim()]);
  if (tab?.windowId !== undefined) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
  refreshBadge();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "active-tab") {
    chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      sendResponse({ url: tabs[0]?.url || "" });
    });
    return true;
  }
  if (message?.type === "harvest") {
    harvest().then(sendResponse);
    return true;
  }
  if (message?.type === "badge") {
    refreshBadge();
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "health-check") {
    readSettings().then((s) => globalThis.NexusBridge.probeHealth(s.apiBase)).then(sendResponse);
    return true;
  }
  if (message?.type === "offline-queue-status") {
    offlineQueue.list().then((items) => sendResponse({ count: items.length, items }));
    return true;
  }
  if (message?.type === "enqueue-offline-import") {
    const urls = Array.isArray(message.urls) ? message.urls : [];
    offlineQueue.enqueue({
      source: "Nexus Deck",
      endpoints: ["/api/v1/intake/import", "/api/lite/quick-import"],
      payload: { urls, batch_name: message.batchName || "Nexus Deck" },
      lastError: message.lastError || "Dashboard neodpovedá",
    }).then((res) => {
      refreshBadge();
      sendResponse({ ok: true, ...res });
    });
    return true;
  }
  if (message?.type === "flush-offline-queue") {
    readSettings()
      .then((s) => offlineQueue.flush(s.apiBase, { token: s.token }))
      .then((res) => {
        refreshBadge();
        sendResponse(res);
      });
    return true;
  }
  return false;
});

async function harvest() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/i.test(tab.url || "")) {
    return { urls: [], error: "Túto kartu nejde čítať." };
  }
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectMediaUrls,
    });
    return { urls: injection?.result || [] };
  } catch {
    return { urls: [], error: "Túto kartu nejde čítať." };
  }
}

function collectMediaUrls() {
  const found = new Set();
  const add = (value) => {
    if (typeof value === "string" && /^https?:/i.test(value)) found.add(value);
  };
  document.querySelectorAll("video, audio").forEach((node) => add(node.currentSrc || node.src));
  document.querySelectorAll("video source, audio source").forEach((node) => add(node.src));
  document.querySelectorAll("a[href]").forEach((node) => {
    if (/\.(mp4|webm|mov|m4v|mkv|m3u8)(?:$|\?)/i.test(node.href)) add(node.href);
  });
  const meta = document.querySelector('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]');
  if (meta?.content) add(meta.content);
  return [...found].slice(0, 40);
}

async function postImport(urls) {
  const settings = await readSettings();
  const payload = { urls, batch_name: "Nexus Deck" };
  const endpoints = ["/api/v1/intake/import", "/api/lite/quick-import"];
  try {
    return await globalThis.NexusBridge.postJsonWithFallback(settings.apiBase, endpoints, payload, {
      token: settings.token,
    });
  } catch (error) {
    if (error?.isNetwork || error?.status === 0) {
      const queued = await offlineQueue.enqueue({
        source: "Nexus Deck",
        endpoints,
        payload,
        lastError: error.message || "Dashboard neodpovedá",
      });
      return { ok: false, queued: true, queueLength: queued.queueLength };
    }
    throw error;
  }
}

async function refreshBadge() {
  try {
    const settings = await readSettings();
    const pendingCount = await offlineQueue.count();
    if (pendingCount > 0) {
      await offlineQueue.flush(settings.apiBase, { token: settings.token }).catch(() => null);
    }
    const data = await requestWithLiteFallback(settings,
      "/api/v1/dashboard/import-monitor?limit=1",
      "/api/lite/stats");
    const active = data.queue
      ? (Number(data.queue.processing) || 0) + (Number(data.queue.pending) || 0)
      : Number(data.pending_queue) || Number(data.active_jobs) || 0;
    chrome.action.setBadgeBackgroundColor({ color: "#e6a23c" });
    chrome.action.setBadgeText({ text: active ? String(Math.min(active, 99)) : "" });
  } catch {
    const queuedCount = await offlineQueue.count().catch(() => 0);
    chrome.action.setBadgeBackgroundColor({ color: queuedCount ? "#d97706" : "#e37b6a" });
    chrome.action.setBadgeText({ text: queuedCount ? `Q${Math.min(queuedCount, 9)}` : "!" });
  }
}

async function requestWithLiteFallback(settings, classicPath, litePath, options = {}) {
  try {
    return await dashboardRequest(settings, classicPath, options);
  } catch (error) {
    if (error.status !== 404) throw error;
    return dashboardRequest(settings, litePath, options);
  }
}

async function dashboardRequest(settings, path, options) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["content-type"] = "application/json";
  if (settings.token) headers["X-Nexus-Token"] = settings.token;
  let response;
  try {
    response = await fetch(`${settings.apiBase.replace(/\/$/, "")}${path}`, {
      ...options,
      headers,
    });
  } catch {
    const error = new Error("Dashboard neodpovedá");
    error.status = 0;
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const error = new Error(data.message || data.detail || data.error || `Požiadavka zlyhala (HTTP ${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function readSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = {
    apiBase: DEFAULT_BASE,
    token: "",
    ...(stored[SETTINGS_KEY] || {}),
  };
  try {
    const url = new URL(settings.apiBase);
    if (["127.0.0.1", "localhost"].includes(url.hostname) && Number(url.port) === 38_471) {
      settings.apiBase = DEFAULT_BASE;
      await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    }
  } catch {
    settings.apiBase = DEFAULT_BASE;
  }
  return settings;
}

function looksLikeUrl(value) {
  return typeof value === "string" && /^https?:\/\/\S+$/i.test(value.trim());
}
