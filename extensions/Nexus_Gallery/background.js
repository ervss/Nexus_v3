try { importScripts('listing-player-network.js'); } catch { }
importScripts('direct-stream-network.js');
try { importScripts('lib/nexus_bridge.js'); } catch { }
const galleryOfflineQueue = globalThis.NexusBridge ? new globalThis.NexusBridge.OfflineImportQueue() : null;
const PORTS = [8000, 8001, 8002, 8003, 8004, 8005];
const EXPLORER_CONTEXT_KEY = "nexus_large_window_context";
const EXPLORER_WINDOW_KEY = "nexus_large_window_id";
const capturedStreams = new Map();
const megaCaptures = new Map();
const BAE_BRIDGE_CHANNEL = "NEXUS_BAE_BRIDGE";
const BAE_BRIDGE_VERSION = 1;
const BAE_BRIDGE_TIMEOUT_MS = 7000;
const baeBridgePending = new Map();
const baeBridgeTabState = new Map();
// Cache of last signed CDN URL per bunkr tab (tab URL → {signedUrl, filename, ts})
const bunkrSignedCache = new Map();
// Bunkr has migrated domains: bunkr-albums.io → balbums.st (and others). Check all known domains.
function isBunkrDomain(url) {
    return /bunkr|balbums\.st|balbums\.io/i.test(String(url || ""));
}
const BAE_BRIDGE_DEBUG = true;
const MIN_REAL_VIDEO_BYTES = 10 * 1024 * 1024;
const MIN_REAL_VIDEO_DURATION_SEC = 60;
const MIN_PIMPBUNNY_REMOTE_DURATION_SEC = 15;
const MEGA_CAPTURE_MAX_CHUNKS = 3000;
const MEGA_CAPTURE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const REDGIFS_API_BASE = "https://api.redgifs.com/v2";
let redgifsTokenCache = { token: "", expiresAt: 0 };

/** Canonical watch URL for captured_* storage keys (www strip, https, no hash/search, no trailing slash). */
function normalizeCaptureWatchPageUrl(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    try {
        const u = new URL(s);
        if (!/^https?:$/i.test(u.protocol)) return s;
        u.protocol = "https:";
        u.hostname = u.hostname.replace(/^www\./i, "").toLowerCase();
        u.hash = "";
        u.search = "";
        let p = u.pathname.replace(/\/+/g, "/");
        p = p.replace(/\/+$/, "") || "/";
        u.pathname = p;
        return u.href;
    } catch {
        return s;
    }
}

function capturedStreamStorageKey(pageUrl) {
    const normalized = normalizeCaptureWatchPageUrl(pageUrl);
    if (!normalized) return "";
    let domain = "";
    try {
        domain = new URL(normalized).hostname.replace(/^www\./i, "");
    } catch {
        return "";
    }
    return `captured_${domain}_${normalized}`;
}

function isMegaUserStorageUrl(url) {
    const raw = String(url || "").trim();
    if (!raw) return false;
    try {
        const u = new URL(raw);
        return /(^|\.)userstorage\.mega\.co\.nz$/i.test(u.hostname) && /^\/dl\//i.test(u.pathname);
    } catch {
        return /userstorage\.mega\.co\.nz\/dl\//i.test(raw);
    }
}

function parseMegaChunkRange(url) {
    const raw = String(url || "");
    const match = raw.match(/\/(\d+)-(\d+)(?:[?#]|$)/);
    if (!match) return { start: null, end: null, length: 0 };
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        return { start: null, end: null, length: 0 };
    }
    return { start, end, length: end - start + 1 };
}

function cleanMegaTitle(title) {
    return String(title || "")
        .replace(/\s*-\s*MEGA\s*$/i, "")
        .replace(/\s*\|\s*MEGA\s*$/i, "")
        .trim();
}

function serializeMegaCapture(cap, duration = 0) {
    if (!cap) {
        return {
            ready: false,
            captureId: "",
            pageUrl: "",
            title: "",
            duration: Number(duration || 0) || 0,
            chunks: [],
            totalCapturedBytes: 0,
            updatedAt: 0,
        };
    }
    const chunks = Array.isArray(cap.chunks) ? cap.chunks.slice() : [];
    chunks.sort((a, b) => {
        const as = Number.isFinite(Number(a.start)) ? Number(a.start) : Number.MAX_SAFE_INTEGER;
        const bs = Number.isFinite(Number(b.start)) ? Number(b.start) : Number.MAX_SAFE_INTEGER;
        return as - bs || String(a.url || "").localeCompare(String(b.url || ""));
    });
    const totalCapturedBytes = chunks.reduce((sum, c) => sum + (Number(c.length || 0) || 0), 0);
    return {
        ready: chunks.length > 0,
        captureId: cap.captureId || "",
        pageUrl: cap.pageUrl || "",
        title: cap.title || "",
        duration: Math.max(Number(duration || 0) || 0, Number(cap.duration || 0) || 0),
        chunks,
        totalCapturedBytes,
        updatedAt: Number(cap.updatedAt || 0) || 0,
        createdAt: Number(cap.createdAt || 0) || 0,
    };
}

function persistMegaCapture(tabId, cap) {
    if (!Number.isInteger(tabId) || tabId < 0 || !cap) return;
    const payload = serializeMegaCapture(cap);
    chrome.storage.local.set({ [`mega_capture_${tabId}`]: payload }).catch(() => { });
}

function rememberMegaChunk(tabId, chunkUrl, pageUrl = "", title = "") {
    if (!Number.isInteger(tabId) || tabId < 0 || !isMegaUserStorageUrl(chunkUrl)) return null;

    const now = Date.now();
    const cleanTitle = cleanMegaTitle(title);
    const range = parseMegaChunkRange(chunkUrl);
    let cap = megaCaptures.get(tabId);
    const stale = cap && cap.updatedAt && now - Number(cap.updatedAt || 0) > MEGA_CAPTURE_MAX_AGE_MS;
    const titleChanged = cap?.title && cleanTitle && cap.title !== cleanTitle;

    if (!cap || stale || titleChanged) {
        cap = {
            captureId: `mega-${tabId}-${now}`,
            tabId,
            pageUrl: pageUrl || "",
            title: cleanTitle || "",
            duration: 0,
            chunks: [],
            chunkKeys: new Set(),
            createdAt: now,
            updatedAt: now,
        };
        megaCaptures.set(tabId, cap);
    }

    if (!(cap.chunkKeys instanceof Set)) {
        cap.chunkKeys = new Set((cap.chunks || []).map((c) => c.url));
    }
    cap.pageUrl = pageUrl || cap.pageUrl || "";
    cap.title = cleanTitle || cap.title || "";
    cap.updatedAt = now;

    if (!cap.chunkKeys.has(chunkUrl)) {
        cap.chunks.push({
            url: chunkUrl,
            start: range.start,
            end: range.end,
            length: range.length,
            ts: now,
        });
        cap.chunkKeys.add(chunkUrl);
        cap.chunks.sort((a, b) => {
            const as = Number.isFinite(Number(a.start)) ? Number(a.start) : Number.MAX_SAFE_INTEGER;
            const bs = Number.isFinite(Number(b.start)) ? Number(b.start) : Number.MAX_SAFE_INTEGER;
            return as - bs || String(a.url || "").localeCompare(String(b.url || ""));
        });
        while (cap.chunks.length > MEGA_CAPTURE_MAX_CHUNKS) {
            const removed = cap.chunks.shift();
            if (removed?.url) cap.chunkKeys.delete(removed.url);
        }
        persistMegaCapture(tabId, cap);
    }
    return cap;
}

async function getMegaCapturePayload(tabId, duration = 0) {
    if (!Number.isInteger(tabId) || tabId < 0) return serializeMegaCapture(null, duration);
    let cap = megaCaptures.get(tabId);
    if (!cap) {
        try {
            const stored = await chrome.storage.local.get([`mega_capture_${tabId}`]);
            const payload = stored?.[`mega_capture_${tabId}`];
            if (payload?.chunks?.length) {
                cap = {
                    ...payload,
                    tabId,
                    chunkKeys: new Set(payload.chunks.map((c) => c.url)),
                };
                megaCaptures.set(tabId, cap);
            }
        } catch { }
    }
    return serializeMegaCapture(cap, duration);
}

function baeBridgeLog(...args) {
    if (!BAE_BRIDGE_DEBUG) return;
    try {
        console.log("[BAE Bridge]", ...args);
    } catch { }
}


async function getStoredExplorerWindowId() {
    const stored = await chrome.storage.local.get([EXPLORER_WINDOW_KEY]);
    return Number(stored[EXPLORER_WINDOW_KEY] || 0) || null;
}

function isQuotaError(error) {
    return /quota|bytes/i.test(String(error?.message || error || ""));
}

async function trimVolatileStorageForQuota() {
    try {
        const all = await chrome.storage.local.get(null);
        const removable = Object.keys(all || {}).filter((key) => (
            /^mega_capture_/i.test(key) ||
            /^nexus_turbo_(?:direct|tab)_/i.test(key) ||
            /^captured_/i.test(key) ||
            /^pornhoarder_debug_/i.test(key)
        ));
        if (removable.length) await chrome.storage.local.remove(removable);
    } catch { }
}

async function safeStorageSetForLaunch(payload) {
    try {
        await chrome.storage.local.set(payload);
        return true;
    } catch (error) {
        if (!isQuotaError(error)) throw error;
        await trimVolatileStorageForQuota();
        try {
            await chrome.storage.local.set(payload);
            return true;
        } catch {
            return false;
        }
    }
}

async function rememberExplorerContext(tab) {
    const context = {
        sourceTabId: tab?.id || null,
        sourceWindowId: tab?.windowId || null,
        sourceUrl: tab?.url || "",
        sourceTitle: tab?.title || "",
        updatedAt: Date.now(),
    };
    await safeStorageSetForLaunch({ [EXPLORER_CONTEXT_KEY]: context });
    return context;
}

function popupUrlForContext(context) {
    const url = new URL(chrome.runtime.getURL("popup.html"));
    if (context?.sourceTabId) url.searchParams.set("sourceTabId", String(context.sourceTabId));
    if (context?.sourceWindowId) url.searchParams.set("sourceWindowId", String(context.sourceWindowId));
    url.searchParams.set("launchTs", String(Date.now()));
    return url.href;
}

async function getExplorerWindowBounds(sourceWindowId) {
    let baseWindow = null;
    try {
        if (sourceWindowId) baseWindow = await chrome.windows.get(sourceWindowId);
    } catch { }
    if (!baseWindow) {
        try {
            baseWindow = await chrome.windows.getCurrent();
        } catch { }
    }

    const baseWidth = Math.max(900, Number(baseWindow?.width || 1440));
    const baseHeight = Math.max(720, Number(baseWindow?.height || 900));
    const width = Math.min(baseWidth, Math.max(960, Math.round(baseWidth * 0.9)));
    const height = Math.min(baseHeight, Math.max(720, Math.round(baseHeight * 0.9)));
    const left = Math.max(0, Math.round(Number(baseWindow?.left || 0) + (baseWidth - width) / 2));
    const top = Math.max(0, Math.round(Number(baseWindow?.top || 0) + (baseHeight - height) / 2));

    return { width, height, left, top };
}

async function focusOrCreateExplorerWindow(context) {
    const url = popupUrlForContext(context);
    const bounds = await getExplorerWindowBounds(context?.sourceWindowId);
    const existingWindowId = await getStoredExplorerWindowId();

    if (existingWindowId) {
        try {
            const existingWindow = await chrome.windows.get(existingWindowId, { populate: true });
            const explorerTab = existingWindow.tabs?.find((tab) => tab.url?.startsWith(chrome.runtime.getURL("popup.html")));
            await chrome.windows.update(existingWindowId, { ...bounds, focused: true });
            if (explorerTab?.id) {
                await chrome.tabs.update(explorerTab.id, { url, active: true });
            } else {
                await chrome.tabs.create({ windowId: existingWindowId, url, active: true });
            }
            return existingWindowId;
        } catch {
            await chrome.storage.local.remove(EXPLORER_WINDOW_KEY);
        }
    }

    const created = await chrome.windows.create({
        url,
        type: "popup",
        focused: true,
        ...bounds,
    });
    if (created?.id) {
        await safeStorageSetForLaunch({ [EXPLORER_WINDOW_KEY]: created.id });
    }
    return created?.id || null;
}

chrome.action.onClicked.addListener(async (tab) => {
    try {
        const context = await rememberExplorerContext(tab);
        await focusOrCreateExplorerWindow(context);
    } catch (error) {
        console.warn("[Nexus Gallery] Failed to open explorer window:", error);
        const context = {
            sourceTabId: tab?.id || null,
            sourceWindowId: tab?.windowId || null,
            sourceUrl: tab?.url || "",
            sourceTitle: tab?.title || "",
            updatedAt: Date.now(),
        };
        await chrome.tabs.create({ url: popupUrlForContext(context), active: true });
    }
});

chrome.windows.onRemoved.addListener(async (windowId) => {
    const storedId = await getStoredExplorerWindowId();
    if (storedId === windowId) {
        await chrome.storage.local.remove(EXPLORER_WINDOW_KEY);
    }
});

function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function isBaeBridgeEnvelope(message, expectedSource) {
    return !!(
        isObject(message) &&
        message.channel === BAE_BRIDGE_CHANNEL &&
        message.version === BAE_BRIDGE_VERSION &&
        message.source === expectedSource &&
        typeof message.type === "string" &&
        typeof message.requestId === "string" &&
        message.requestId.trim() &&
        typeof message.ts === "number" &&
        isObject(message.payload)
    );
}

function makeBaeBridgeEnvelope(type, requestId, payload = {}) {
    return {
        channel: BAE_BRIDGE_CHANNEL,
        version: BAE_BRIDGE_VERSION,
        source: "nexus-extension",
        type,
        requestId,
        ts: Date.now(),
        payload: isObject(payload) ? payload : {},
    };
}

function createBaeRequestId() {
    return `bae-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function rememberBaeBridgeState(tabId, patch = {}) {
    if (!tabId || tabId < 0) return;
    const previous = baeBridgeTabState.get(tabId) || {};
    baeBridgeTabState.set(tabId, {
        ...previous,
        ...patch,
        lastSeenAt: Date.now(),
    });
}

function getBaeBridgeState(tabId) {
    const state = tabId ? (baeBridgeTabState.get(tabId) || null) : null;
    if (!state) return { detected: false, status: "Not detected" };
    const stale = Date.now() - Number(state.lastSeenAt || 0) > 30000;
    return {
        detected: !stale && !!state.detected,
        ready: !stale && !!state.ready,
        status: stale ? "Not detected" : (state.status || "Ready"),
        capabilities: Array.isArray(state.capabilities) ? state.capabilities : [],
        lastSeenAt: state.lastSeenAt || 0,
        lastError: state.lastError || "",
    };
}

async function getBaeSourceTab(explicitTabId = 0) {
    if (Number.isInteger(explicitTabId) && explicitTabId > 0) {
        try {
            const tab = await chrome.tabs.get(explicitTabId);
            if (tab?.id) return tab;
        } catch { }
    }

    try {
        const stored = await chrome.storage.local.get([EXPLORER_CONTEXT_KEY]);
        const sourceTabId = Number(stored?.[EXPLORER_CONTEXT_KEY]?.sourceTabId || 0) || 0;
        if (sourceTabId > 0) {
            const tab = await chrome.tabs.get(sourceTabId);
            if (tab?.id) return tab;
        }
    } catch { }

    try {
        const tabs = await chrome.tabs.query({
            url: ["https://bunkr-albums.io/*", "https://balbums.st/*"],
        });
        const activeTab = tabs.find((tab) => tab.active) || tabs[0];
        return activeTab || null;
    } catch {
        return null;
    }
}

async function sendBaeBridgeRequest({ type, payload = {}, tabId = 0, timeoutMs = BAE_BRIDGE_TIMEOUT_MS }) {
    const tab = await getBaeSourceTab(tabId);
    if (!tab?.id || tab.id < 0) {
        throw new Error("No Bunkr tab available for bridge request");
    }

    const requestId = createBaeRequestId();
    const envelope = makeBaeBridgeEnvelope(type, requestId, payload);

    return new Promise((resolve, reject) => {
        const createdAt = Date.now();
        const timeout = setTimeout(() => {
            const pending = baeBridgePending.get(requestId);
            if (pending) {
                clearTimeout(pending.timeout);
                baeBridgePending.delete(requestId);
            }
            rememberBaeBridgeState(tab.id, { detected: false, ready: false, status: "Timeout", lastError: "Bridge request timed out" });
            baeBridgeLog("timeout", { requestId, tabId: tab.id, type, pendingSize: baeBridgePending.size, ageMs: Date.now() - createdAt });
            reject(new Error("Bridge request timed out"));
        }, Math.max(1000, Number(timeoutMs || BAE_BRIDGE_TIMEOUT_MS)));

        baeBridgePending.set(requestId, {
            requestId,
            tabId: tab.id,
            type,
            resolve,
            reject,
            timeout,
            createdAt,
        });

        rememberBaeBridgeState(tab.id, { status: "Busy" });
        baeBridgeLog("send", { requestId, tabId: tab.id, type, pendingSize: baeBridgePending.size });

        chrome.tabs.sendMessage(tab.id, {
            action: "BAE_BRIDGE_DELIVER_TO_PAGE",
            envelope,
        }).then((response) => {
            if (!response?.ok) {
                const pending = baeBridgePending.get(requestId);
                if (!pending) return;
                clearTimeout(pending.timeout);
                baeBridgePending.delete(requestId);
                rememberBaeBridgeState(tab.id, { detected: false, ready: false, status: "Error", lastError: response?.error || "Bridge relay failed" });
                baeBridgeLog("relay-error", { requestId, tabId: tab.id, type, error: response?.error || "Bridge relay failed", pendingSize: baeBridgePending.size });
                reject(new Error(response?.error || "Bridge relay failed"));
                return;
            }
            baeBridgeLog("relay-ok", { requestId, tabId: tab.id, type });
        }).catch((error) => {
            const pending = baeBridgePending.get(requestId);
            if (!pending) return;
            clearTimeout(pending.timeout);
            baeBridgePending.delete(requestId);
            rememberBaeBridgeState(tab.id, { detected: false, ready: false, status: "Error", lastError: error?.message || "Bridge relay failed" });
            baeBridgeLog("relay-catch", { requestId, tabId: tab.id, type, error: error?.message || "Bridge relay failed", pendingSize: baeBridgePending.size });
            reject(new Error(error?.message || "Bridge relay failed"));
        });
    });
}

async function findDashboardUrl() {
    const stored = await chrome.storage.local.get(["selected_port"]);
    const preferredPort = Number(stored.selected_port) || 8000;
    const hosts = ["127.0.0.1", "localhost"];

    const check = async (host, port) => {
        try {
            const resp = await fetch(`http://${host}:${port}/health`, {
                signal: AbortSignal.timeout(700),
            }).catch(() => null);
            return !!(resp && resp.ok);
        } catch {
            return false;
        }
    };

    const ports = [preferredPort, ...PORTS.filter((p) => p !== preferredPort)];
    for (const port of ports) {
        for (const host of hosts) {
            if (await check(host, port)) return `http://${host}:${port}`;
        }
    }
    return `http://127.0.0.1:${preferredPort}`;
}

async function getStoredBridgeToken() {
    try {
        const stored = await chrome.storage.local.get([
            "nexus_bridge_token",
            "bridge_token",
            "nexusBridgeToken",
        ]);
        return String(
            stored?.nexus_bridge_token ||
            stored?.bridge_token ||
            stored?.nexusBridgeToken ||
            ""
        ).trim();
    } catch {
        return "";
    }
}

async function buildLocalApiHeaders(extraHeaders = {}) {
    const headers = { ...(extraHeaders || {}) };
    const bridgeToken = await getStoredBridgeToken();
    if (bridgeToken) {
        headers["X-Nexus-Token"] = bridgeToken;
    }
    return headers;
}

function parseFapFolderDuration(value) {
    const raw = String(value || "").replace(/&nbsp;/gi, " ").trim();
    const colon = raw.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
    if (colon) {
        const a = Number.parseInt(colon[1], 10);
        const b = Number.parseInt(colon[2], 10);
        const c = colon[3] ? Number.parseInt(colon[3], 10) : null;
        return c == null ? a * 60 + b : a * 3600 + b * 60 + c;
    }
    const h = raw.match(/\b(\d+)\s*(?:h|hr|hour|hours)\b/i);
    const m = raw.match(/\b(\d+)\s*(?:m|min|minute|minutes)\b/i);
    const s = raw.match(/\b(\d+)\s*(?:s|sec|second|seconds)\b/i);
    const total = (h ? Number.parseInt(h[1], 10) * 3600 : 0)
        + (m ? Number.parseInt(m[1], 10) * 60 : 0)
        + (s ? Number.parseInt(s[1], 10) : 0);
    return total > 0 ? total : 0;
}

function parseFapFolderSizeMb(value) {
    const match = String(value || "").match(/\b(\d+(?:[.,]\d+)?)\s*(GB|GiB|MB|MiB)\b/i);
    if (!match) return null;
    const amount = Number.parseFloat(match[1].replace(",", "."));
    if (!Number.isFinite(amount)) return null;
    return /^g/i.test(match[2]) ? amount * 1024 : amount;
}

function formatFapFolderSize(mb) {
    const value = Number(mb || 0);
    if (!Number.isFinite(value) || value <= 0) return "";
    if (value < 1) return "";
    if (value >= 1024) return `${(value / 1024).toFixed(2)} GB`;
    return `${Math.round(value)} MB`;
}

function decodeHtmlText(value) {
    return String(value || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function extractFapFolderMetaFromHtml(html) {
    const source = String(html || "");
    const title = decodeHtmlText((source.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || [])[1])
        || decodeHtmlText((source.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
    // Scope the source to this post's actual player. Post timestamps and
    // unrelated page text are not media metadata; og:image is often an avatar.
    const player = (source.match(/<video\b[^>]*\bid=["']video-\d+["'][^>]*>[\s\S]*?<\/video>/i) || [])[0]
        || (source.match(/<video\b[^>]*>[\s\S]*?<\/video>/i) || [])[0] || "";
    const lazyPlayer = (source.match(/<[^>]+\bdata-id=["']video-\d+["'][^>]*>/i) || [])[0] || "";
    const thumbnail = ((player.match(/\bposter=["']([^"']+)["']/i) || [])[1]
        || (lazyPlayer.match(/\bdata-poster=["']([^"']+)["']/i) || [])[1] || "").replace(/&amp;/g, "&");
    const postTimeTag = (source.match(/<[^>]+class=["'][^"']*\bjs_moment\b[^"']*["'][^>]*>/i) || [])[0] || "";
    const addedAt = (postTimeTag.match(/\bdata-time=["'](\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})["']/i) || [])[1] || "";
    const duration = 0;
    const sizeMb = null;
    const streamUrl = ((player.match(/<source[^>]+src=["']([^"']+)["']/i) || [])[1]
        || (player.match(/<video[^>]+\bsrc=["']([^"']+)["']/i) || [])[1]
        || (lazyPlayer.match(/\bdata-src=["']([^"']+)["']/i) || [])[1] || "")
        .replace(/&amp;/g, "&");

    return {
        title,
        thumbnail,
        duration,
        sizeMb,
        sizeText: formatFapFolderSize(sizeMb),
        addedAt,
        streamUrl,
    };
}

async function fetchFapFolderStreamSizeMb(url, referer) {
    if (!url) return null;
    const info = await fetchHeadInfo(url, referer);
    return info.ok && info.contentLength > 0 ? info.contentLength / (1024 * 1024) : null;
}
async function hydrateFapFolderItem(item) {
    const url = String(item?.url || "").trim();
    const base = {
        id: item?.id || url,
        url,
        title: item?.title || "",
        thumbnail: item?.thumbnail || "",
        duration: 0,
        sizeMb: null,
        sizeText: "",
    };
    if (!/^https:\/\/(?:[^/]+\.)?fapfolder\.club\/(?:posts|videos?)\/[\w-]+\/?(?:[?#].*)?$/i.test(url)) return { ...base, error: "Invalid FapFolder video URL" };
    try {
        const resp = await fetch(url, {
            credentials: "include",
            signal: AbortSignal.timeout(12000),
            headers: {
                "Accept": "text/html,application/xhtml+xml",
            },
        });
        if (!resp.ok) return { ...base, error: `HTTP ${resp.status}` };
        const html = await resp.text();
        const meta = extractFapFolderMetaFromHtml(html);
        const streamUrl = meta.streamUrl ? new URL(meta.streamUrl, url).href : "";
        if (!streamUrl) return { ...base, error: "Video source unavailable (login or access required)" };
        const mediaInfo = await fetchHeadInfo(streamUrl, url);
        const sizeMb = mediaInfo.ok && mediaInfo.contentLength > 0 ? mediaInfo.contentLength / (1024 * 1024) : null;
        return {
            ...base,
            title: meta.title || base.title,
            addedAt: meta.addedAt || "",
            thumbnail: meta.thumbnail || base.thumbnail,
            duration: meta.duration || 0,
            sizeMb: sizeMb || null,
            sizeText: formatFapFolderSize(sizeMb) || meta.sizeText || "",
            streamUrl,
            mediaUrl: mediaInfo.finalUrl || streamUrl,
            mediaValidated: Boolean(mediaInfo.ok),
            sizeExact: Boolean(sizeMb),
        };
    } catch (error) {
        return { ...base, error: error?.message || "Metadata request failed" };
    }
}

async function mapFapFolderWithLimit(items, limit, mapper) {
    const input = Array.isArray(items) ? items : [];
    const results = new Array(input.length);
    let index = 0;
    async function worker() {
        while (index < input.length) {
            const current = index++;
            results[current] = await mapper(input[current]);
        }
    }
    const workers = Array.from({ length: Math.min(Math.max(1, limit || 1), input.length || 1) }, worker);
    await Promise.all(workers);
    return results;
}

async function buildFapFolderImportVideos(items) {
    return mapFapFolderWithLimit(items, 2, async item => {
        const fresh = await hydrateFapFolderItem(item);
        if (fresh.error || !fresh.mediaUrl || !fresh.mediaValidated) throw new Error(fresh.error || "Video source could not be validated; fetch metadata and retry");
        return {
            url: fresh.mediaUrl,
            title: item.title || fresh.title || "FapFolder video",
            source_url: item.url,
            thumbnail: item.thumbnail || fresh.thumbnail || null,
            duration: item.duration || 0,
            quality: item.quality || 0,
            filesize: fresh.sizeText || item.sizeText || 0,
            file_size_mb: fresh.sizeMb || item.sizeMb || null,
            tags: "fapfolder,extension",
            width: Number(item.width || 0),
            height: Number(item.height || 0),
            upload_date: String(fresh.addedAt || '').slice(0, 10).replace(/-/g, ''),
        };
    });
}

async function reportCapturedStream(pageUrl, streamUrl, title = "") {
    if (!pageUrl || !streamUrl) return;
    if (isObviouslyNonPlayableCaptureUrl(streamUrl)) return;

    const normalizedPage = normalizeCaptureWatchPageUrl(pageUrl);
    if (!normalizedPage) return;

    // Store locally for popup to query
    let domain = "";
    try {
        domain = new URL(normalizedPage).hostname.replace(/^www\./i, "");
    } catch {
        return;
    }
    const key = `captured_${domain}_${normalizedPage}`;
    const existing = (await chrome.storage.local.get([key]))?.[key] || null;
    let chosenStream = choosePreferredCapturedStream(normalizedPage, existing?.streamUrl || '', streamUrl);
    let chosenSizeBytes = Number(existing?.sizeBytes || 0) || 0;
    if (isBogusXvideosContentLength(existing?.streamUrl || normalizedPage, normalizedPage, chosenSizeBytes)) {
        chosenSizeBytes = 0;
    }

    if (/(?:pimpbunny|fnxtube)\.com\/videos\//i.test(normalizedPage)) {
        try {
            const candidates = [existing?.streamUrl || "", streamUrl]
                .map((u) => String(u || "").trim())
                .filter(Boolean);
            const uniqueCandidates = [...new Set(candidates)];
            if (uniqueCandidates.length > 1) {
                const probed = await Promise.all(
                    uniqueCandidates.map(async (candidate) => {
                        const picked = await pickImportableStream({
                            pageUrl: normalizedPage,
                            streamUrl: candidate,
                            durationSec: 0,
                        });
                        return {
                            streamUrl: candidate,
                            sizeBytes: Number(picked?.sizeBytes || 0) || 0,
                            score: inferMediaQualityScore(candidate),
                        };
                    })
                );
                probed.sort((a, b) => {
                    // PimpBunny variants can have different bitrates. Quality is
                    // the primary contract; file size only breaks a quality tie.
                    if (b.score !== a.score) return b.score - a.score;
                    return b.sizeBytes - a.sizeBytes;
                });
                if (probed[0]?.streamUrl) {
                    chosenStream = probed[0].streamUrl;
                    chosenSizeBytes = isBogusXvideosContentLength(probed[0].streamUrl, normalizedPage, probed[0].sizeBytes)
                        ? 0
                        : probed[0].sizeBytes;
                }
            }
        } catch (e) {
            console.warn("[PimpBunny] Failed to compare captured stream sizes:", e?.message || e);
        }
    }

    await chrome.storage.local.set({ [key]: { streamUrl: chosenStream, title, ts: Date.now(), sizeBytes: chosenSizeBytes } });

    const base = await findDashboardUrl();
    try {
        await fetch(`${base}/api/v1/videos/update_stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                source_url: normalizedPage,
                stream_url: chosenStream,
                source: domain,
                title: title
            }),
        });
    } catch (e) {
        console.warn("[StreamCapture] update_stream failed:", e?.message || e);
    }
}

function inferMediaQualityScore(url) {
    const raw = String(url || '').toLowerCase();
    if (!raw) return -1;

    let score = 0;
    if (raw.includes('multi=')) score += 20000;
    if (raw.includes('.m3u8')) score += 15000;
    if (raw.includes('master')) score += 12000;
    // Faphouse/xHamster: pri rovnakom rozlíšení je AV1 rendition (2160.av1.mp4)
    // o rád menšia = nižší bitrate. Penalizácia je menšia než jeden stupeň
    // rozlíšenia (h*10), takže 2160 AV1 stále vyhrá nad 1080 h264.
    if (/\.av1\.mp4/.test(raw)) score -= 5000;

    const match = raw.match(/(?:^|[\/_.-])(2160|1440|1080|720|480|360|240)(?:p)?(?:[\/_.-]|$)/i);
    if (match) {
        score += parseInt(match[1], 10) * 10;
    }

    // PimpBunny's quality switcher often encodes the selected level in query
    // parameters rather than in the filename. Recognize both 2K and 1440p.
    const queryQuality = raw.match(/[?&](?:quality|q|res|resolution|height)=([^&]+)/i);
    if (queryQuality) {
        const label = decodeURIComponent(queryQuality[1]).toLowerCase();
        if (/^(?:2k|1440p?)$/.test(label)) score += 14400;
        else {
            const q = label.match(/^(2160|1080|720|480|360|240)p?$/);
            if (q) score += parseInt(q[1], 10) * 10;
        }
    }
    if (/\b2k\b|[_-]2k|1440p|_1440|_1440p/i.test(raw)) score += 14400;

    const encodedFileMatch = raw.match(/[?&]file=([^&]+)/i);
    if (encodedFileMatch) {
        try {
            const decodedFile = decodeURIComponent(encodedFileMatch[1]).toLowerCase();
            const fileQuality = decodedFile.match(
                /(?:^|[\/_.-])(2160|1440|1080|720|480|360|240)(?:p)?(?:[\/_.-]|\.mp4|$)/i
            );
            if (fileQuality) score += parseInt(fileQuality[1], 10) * 10;
            if (/_pb_(?:2160|1440|1080|720|480|360)p/i.test(decodedFile)) {
                const mm = decodedFile.match(/_pb_(2160|1440|1080|720|480|360)p/i);
                if (mm) score += parseInt(mm[1], 10) * 10;
            }
        } catch { }
    }

    if (/\b4k\b|\buhd\b|[_-]4k|2160p|3840|_2160|_2160p/i.test(raw)) score += 21600;
    if (/(?:pimpbunny|fnxtube)\.com\/remote_control\.php/i.test(raw)) score += 100000;
    if (/preview|thumb|small\.mp4|get_preview|vidthumb|trailer|sample|intro/i.test(raw)) score -= 50000;
    if (/\/(embed|preview)\//i.test(raw)) score -= 10000;
    return score;
}

function looksLikeTrailerUrl(url) {
    const raw = String(url || "").toLowerCase();
    if (!raw) return false;
    if (/trafficdeposit\.com\/.*vidthumb\.mp4/i.test(raw)) return true;
    if (/\/vidthumb\.mp4(?:[?#]|$)/i.test(raw)) return true;
    if (/preview|thumb|small\.mp4|get_preview|vidthumb|trailer|sample|intro/i.test(raw)) return true;
    return /\/(embed|preview)\//i.test(raw);
}

function looksLikeHls(url) {
    return /\.m3u8(\?|$)/i.test(String(url || ""));
}

function isBogusXvideosContentLength(url, referer, contentLength) {
    const size = Number(contentLength || 0) || 0;
    if (!size || size >= (1024 * 1024)) return false;
    const blob = `${url || ""} ${referer || ""}`.toLowerCase();
    return /xvideos\.(?:com|red)|xvideos-cdn\.com|xvideos\d*cdn\.com|xvideos-cdn\d*\.com/i.test(blob);
}

function isBlockedProxyProneHost(url) {
    const raw = String(url || "").toLowerCase();
    if (!raw) return false;
    if (/trafficdeposit\.com\/.*vidthumb\.mp4/i.test(raw)) return true;
    if (/\/vidthumb\.mp4(?:[?#]|$)/i.test(raw)) return true;
    if (/tnmr\.org\/hls2\//i.test(raw)) return true;
    return false;
}

function mediaRefererFor(url, referer = "") {
    // Lulu's current tnmr.org CDN rejects the full /e/<id> iframe referer but
    // accepts the provider origin.  Keep the original referer for every other
    // host, because several CDNs validate the precise watch-page path.
    if (/\.tnmr\.org(?:[/:?#]|$)/i.test(String(url || ""))
        && /(?:lulustream|luluvid|luluvdo|luluvids)\.(?:com|net|top)|lulu\.stream/i.test(String(referer || ""))) {
        try { return `${new URL(referer).origin}/`; } catch { return "https://luluvdo.com/"; }
    }
    return referer || "";
}

async function fetchHeadInfo(url, referer = "") {
    const cached = await chrome.storage.session.get("nexus_media_sizes");
    const observed = cached.nexus_media_sizes?.[url];
    if (observed?.contentLength > 0 && Date.now() - observed.ts < 30 * 60 * 1000
        && (observed.finalUrl || !/^https:\/\/(?:[^/]+\.)?fapfolder\.club\//i.test(url))) {
        return { ...observed, ok: true, source: "browser-response" };
    }
    const megaUrl = isMegaUserStorageUrl(url);
    const headers = {
        Referer: megaUrl ? "https://mega.nz/" : mediaRefererFor(url, referer),
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "*/*",
        Connection: "keep-alive",
    };
    if (megaUrl) {
        headers.Origin = "https://mega.nz";
        headers["Cache-Control"] = "no-cache";
        headers.Pragma = "no-cache";
    }
    try {
        // The signed FapFolder /video/play endpoint also uses the site's login
        // session. Preserve that session just as its own video/download does.
        const credentials = /^https:\/\/(?:[^/]+\.)?fapfolder\.club\//i.test(url) ? "include" : "omit";
        let lastError = "Server did not report the complete file size.";
        for (const method of ["GET", "HEAD"]) {
            let response;
            try {
                response = await fetch(url, {
                    method, credentials, signal: AbortSignal.timeout(8000),
                    headers: method === "GET" ? { ...headers, Range: "bytes=0-0" } : headers,
                });
                const contentType = response.headers.get("content-type") || "";
                if (!response.ok) { lastError = `HTTP ${response.status}`; continue; }
                if (/text\/html|application\/(?:json|problem\+json)/i.test(contentType)) {
                    lastError = "Server returned a page instead of media.";
                    continue;
                }
                const total = Number(response.headers.get("content-range")?.match(/\/(\d+)\s*$/)?.[1] || 0);
                // Content-Length on 206 is only the requested slice, often one byte.
                const length = total || (response.status === 200 ? Number(response.headers.get("content-length") || 0) : 0);
                if (Number.isSafeInteger(length) && length > 0 && !isBogusXvideosContentLength(url, referer, length)) {
                    return { ok: true, contentLength: length, contentType, finalUrl: response.url || url, source: "probe" };
                }
            } catch (error) { lastError = error?.message || String(error); }
            finally { if (response?.body) await response.body.cancel().catch(() => {}); }
        }
        return { ok: false, contentLength: 0, contentType: "", error: lastError };
    } catch (e) {
        return { ok: false, contentLength: 0, contentType: "", error: e?.message || String(e) };
    }
}

function nexusQualityLabelFromHeight(height) {
    const h = Number(height || 0);
    if (h >= 2160) return "4K";
    if (h >= 1440) return "1440p";
    if (h >= 1080) return "1080p";
    if (h >= 720) return "720p";
    if (h >= 480) return "480p";
    if (h >= 360) return "360p";
    if (h >= 240) return "240p";
    return "";
}

function nexusInferHeightFromText(value) {
    const text = String(value || "").toLowerCase();
    if (/\b4k\b/.test(text)) return 2160;
    const match = text.match(/(?:^|[\/_\-.])(2160|1440|1080|720|480|360|240)(?:p)?(?:[\/_\-.]|$)/i)
        || text.match(/\b(2160|1440|1080|720|480|360|240)p\b/i);
    return match ? (parseInt(match[1], 10) || 0) : 0;
}

function nexusContentRangeTotal(headers) {
    const cr = headers?.get?.("content-range") || "";
    const total = String(cr).split("/").pop();
    const n = Number(total || 0) || 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
}

function nexusParseHlsBestVariant(text, playlistUrl) {
    const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    let best = null;
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
        const next = lines[i + 1] || "";
        const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
        const bwMatch = line.match(/(?:AVERAGE-)?BANDWIDTH=(\d+)/i);
        const width = resMatch ? parseInt(resMatch[1], 10) || 0 : 0;
        const height = resMatch ? parseInt(resMatch[2], 10) || 0 : nexusInferHeightFromText(next);
        const bitrate = bwMatch ? parseInt(bwMatch[1], 10) || 0 : 0;
        let url = next && !next.startsWith("#") ? next : "";
        try {
            if (url) url = new URL(url, playlistUrl).href;
        } catch { }
        const score = height * 100000 + bitrate;
        if (!best || score > best.score) {
            best = { url, width, height, bitrate, score };
        }
    }
    return best || null;
}

function nexusParseMp4Dimensions(buffer) {
    if (!buffer || buffer.byteLength < 32) return { width: 0, height: 0 };
    const view = buffer instanceof DataView ? buffer : new DataView(buffer);
    const max = view.byteLength;
    const readType = (offset) => {
        if (offset < 0 || offset + 4 > max) return "";
        return String.fromCharCode(
            view.getUint8(offset),
            view.getUint8(offset + 1),
            view.getUint8(offset + 2),
            view.getUint8(offset + 3)
        );
    };

    for (let offset = 0; offset + 16 <= max; offset += 1) {
        if (readType(offset) !== "tkhd") continue;
        const boxStart = offset - 4;
        if (boxStart < 0) continue;
        let boxSize = view.getUint32(boxStart, false);
        let payloadStart = offset + 4;
        if (boxSize === 1 && boxStart + 16 <= max) {
            const high = view.getUint32(boxStart + 8, false);
            const low = view.getUint32(boxStart + 12, false);
            boxSize = high === 0 ? low : 0;
            payloadStart = offset + 12;
        }
        const boxEnd = boxSize > 0 ? Math.min(boxStart + boxSize, max) : Math.min(payloadStart + 96, max);
        if (boxEnd - payloadStart < 8) continue;
        const widthFixed = view.getUint32(boxEnd - 8, false);
        const heightFixed = view.getUint32(boxEnd - 4, false);
        const width = Math.round(widthFixed / 65536);
        const height = Math.round(heightFixed / 65536);
        if (width > 0 && height > 0 && width < 10000 && height < 10000) {
            return { width, height };
        }
    }
    return { width: 0, height: 0 };
}

async function probeMediaMetadata(url, referer = "") {
    const raw = String(url || "").trim();
    if (!raw) return { ok: false, error: "No URL" };
    const headers = {
        Referer: referer || "",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "*/*",
        Connection: "keep-alive",
    };

    const out = {
        ok: false,
        sizeBytes: 0,
        contentType: "",
        width: 0,
        height: nexusInferHeightFromText(raw),
        quality: nexusQualityLabelFromHeight(nexusInferHeightFromText(raw)),
        isHls: /\.m3u8(?:[?#]|$)/i.test(raw),
    };

    try {
        if (out.isHls) {
            const res = await fetch(raw, { method: "GET", credentials: "omit", headers });
            out.contentType = res.headers.get("content-type") || "";
            if (res.ok) {
                const text = await res.text();
                const best = nexusParseHlsBestVariant(text, raw);
                if (best) {
                    out.width = best.width || 0;
                    out.height = best.height || out.height || 0;
                    out.quality = nexusQualityLabelFromHeight(out.height) || out.quality || "";
                }
                out.ok = true;
            }
            return out;
        }

        const first = await fetch(raw, {
            method: "GET",
            credentials: "omit",
            headers: { ...headers, Range: "bytes=0-262143" },
        });
        out.contentType = first.headers.get("content-type") || "";
        out.sizeBytes = nexusContentRangeTotal(first.headers) || Number(first.headers.get("content-length") || 0) || 0;
        const firstBodyBytes = Number(first.headers.get("content-length") || 0) || 0;
        if (first.status === 206 || (first.ok && firstBodyBytes > 0 && firstBodyBytes <= 262144)) {
            const dims = nexusParseMp4Dimensions(await first.arrayBuffer());
            out.width = dims.width || 0;
            out.height = dims.height || out.height || 0;
        }

        if ((!out.sizeBytes || out.sizeBytes <= 262144) && !out.width && !out.height) {
            try {
                const head = await fetch(raw, { method: "HEAD", credentials: "omit", headers });
                out.sizeBytes = Number(head.headers.get("content-length") || 0) || out.sizeBytes || 0;
                out.contentType = out.contentType || head.headers.get("content-type") || "";
            } catch { }
        }

        if (out.sizeBytes > 262144 && (!out.width || !out.height)) {
            const start = Math.max(0, out.sizeBytes - 262144);
            try {
                const tail = await fetch(raw, {
                    method: "GET",
                    credentials: "omit",
                    headers: { ...headers, Range: `bytes=${start}-${out.sizeBytes - 1}` },
                });
                const tailBodyBytes = Number(tail.headers.get("content-length") || 0) || 0;
                if (tail.status === 206 || (tail.ok && tailBodyBytes > 0 && tailBodyBytes <= 262144)) {
                    const dims = nexusParseMp4Dimensions(await tail.arrayBuffer());
                    out.width = dims.width || out.width || 0;
                    out.height = dims.height || out.height || 0;
                }
            } catch { }
        }

        if (isBogusXvideosContentLength(raw, referer, out.sizeBytes)) {
            out.sizeBytes = 0;
        }
        out.quality = nexusQualityLabelFromHeight(out.height) || out.quality || "";
        out.ok = Boolean(out.sizeBytes || out.width || out.height || out.quality);
        return out;
    } catch (e) {
        return { ...out, ok: Boolean(out.sizeBytes || out.width || out.height || out.quality), error: e?.message || String(e) };
    }
}

// Size of the selected FapHouse stream, never the advertised source-file size
// or the byte length of the .m3u8 document. Sample segment headers only.
async function probeFaphouseStream(streamUrl, referer, expectedDuration = 0) {
    const headers = referer ? { Referer: referer } : {};
    let playlistUrl = String(streamUrl || '');
    if (!/^https:\/\/[^/]*flixcdn\.com\//i.test(playlistUrl)) return { ok: false, error: 'Nepodporovaný stream' };
    if (!/\.m3u8(?:[?#]|$)/i.test(playlistUrl)) {
        const res = await fetch(playlistUrl, { method: 'HEAD', headers, signal: AbortSignal.timeout(8000) });
        const sizeBytes = res.ok ? Number(res.headers.get('content-length') || 0) : 0;
        return { ok: res.ok, sizeBytes, estimated: false, streamUrl };
    }
    for (let depth = 0; depth < 4; depth++) {
        const res = await fetch(playlistUrl, { headers, signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`Playlist HTTP ${res.status}`);
        const text = await res.text();
        if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Neplatný HLS playlist');
        const best = nexusParseHlsBestVariant(text, res.url || playlistUrl);
        if (best?.url) { playlistUrl = best.url; continue; }
        const segments = [];
        let seconds = 0;
        for (const line of text.split(/\r?\n/).map(s => s.trim())) {
            if (line.startsWith('#EXTINF:')) seconds = Number(line.slice(8).split(',')[0]) || 0;
            else if (line && !line.startsWith('#') && seconds > 0) {
                segments.push({ url: new URL(line, res.url || playlistUrl).href, seconds });
                seconds = 0;
            }
        }
        const duration = segments.reduce((sum, segment) => sum + segment.seconds, 0);
        if (!segments.length || !text.includes('#EXT-X-ENDLIST')) throw new Error('Neúplný VOD playlist');
        if (expectedDuration > 0 && Math.abs(duration - expectedDuration) > Math.max(15, expectedDuration * 0.05)) {
            return { ok: false, durationMismatch: true, duration, error: 'Dĺžka streamu nesedí s videom' };
        }
        if (text.includes('#EXT-X-BYTERANGE')) return { ok: true, duration, sizeBytes: 0, error: 'Veľkosť streamu neoverená' };
        const count = Math.min(9, segments.length);
        const samples = Array.from({ length: count }, (_, i) => segments[Math.floor((i + 0.5) * segments.length / count)]);
        const sizes = await Promise.all(samples.map(async segment => {
            try {
                const head = await fetch(segment.url, { method: 'HEAD', headers, signal: AbortSignal.timeout(5000) });
                return head.ok ? Number(head.headers.get('content-length') || 0) : 0;
            } catch { return 0; }
        }));
        if (sizes.some(size => size <= 0)) return { ok: true, duration, sizeBytes: 0, error: 'Veľkosť streamu neoverená' };
        const sampleDuration = samples.reduce((sum, s) => sum + s.seconds, 0);
        return {
            ok: true, duration, streamUrl: playlistUrl,
            sizeBytes: Math.round(sizes.reduce((sum, s) => sum + s, 0) * duration / sampleDuration),
            estimated: count < segments.length
        };
    }
    throw new Error('Príliš veľa vnorených playlistov');
}

async function fetchCorsText(url, referer = "") {
    try {
        const res = await fetch(url, {
            credentials: "omit",
            headers: referer ? { Referer: referer } : {},
        });
        if (!res.ok) return null;
        return await res.text();
    } catch {
        return null;
    }
}

function extractHosterCandidatesFromSxyprnHtml(html, pageUrl) {
    const out = [];
    const seen = new Set();
    const push = (u) => {
        try {
            const abs = new URL(u, pageUrl).href;
            if (seen.has(abs)) return;
            seen.add(abs);
            out.push(abs);
        } catch { }
    };

    const hrefRegex = /href=["']([^"']+)["']/gi;
    for (const m of html.matchAll(hrefRegex)) {
        const href = String(m[1] || "");
        if (/(doodstream\.com|dood\.[a-z]+|playmogo\.com)\/(?:e|d)\//i.test(href) || /(lulustream\.[a-z]+|luluvid\.[a-z]+|luluvdo\.[a-z]+|luluvids\.[a-z]+|lulu\.stream|vidara\.so|vidsonic\.net|vidfast\.co)\//i.test(href)) push(href);
    }
    const rawUrlRegex = /(https?:\/\/[^\s"'<>]+)/gi;
    for (const m of html.matchAll(rawUrlRegex)) {
        const u = String(m[1] || "");
        if (/(doodstream\.com|dood\.[a-z]+|playmogo\.com)\/(?:e|d)\//i.test(u) || /(lulustream\.[a-z]+|luluvid\.[a-z]+|luluvdo\.[a-z]+|luluvids\.[a-z]+|lulu\.stream|vidara\.so|vidsonic\.net|vidfast\.co)\//i.test(u)) push(u);
    }
    return out;
}

async function resolveDoodstreamDirect(embedUrl) {
    embedUrl = String(embedUrl || '').replace(/\/d\//i, '/e/');
    const pageHtml = await fetchCorsText(embedUrl, embedUrl);
    if (!pageHtml) return null;

    const tokenQueryMatch = pageHtml.match(/[?&]token=([a-z0-9]+)/i);
    const passMatch = pageHtml.match(/(\/pass_md5\/[^'"\s<]+)/i);
    if (!passMatch) return null;
    const tokenPathMatch = passMatch[1].match(/\/pass_md5\/[^/]+\/([^/?#'"\s<]+)/i);
    const token = (tokenQueryMatch ? tokenQueryMatch[1] : "") || (tokenPathMatch ? tokenPathMatch[1] : "");

    const base = new URL(embedUrl).origin;
    const passUrl = `${base}${passMatch[1]}`;

    let passValue = null;
    try {
        const passResp = await fetch(passUrl, {
            credentials: "omit",
            headers: {
                Referer: embedUrl,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            },
        });
        if (!passResp.ok) return null;
        passValue = (await passResp.text()).trim();
    } catch {
        return null;
    }
    if (!passValue) return null;
    if (passValue.startsWith("//")) passValue = `https:${passValue}`;
    if (!/^https?:\/\//i.test(passValue)) return null;

    const randPart = Math.random().toString(36).slice(2, 12);
    const expiry = Date.now();
    const direct = `${passValue}${randPart}?token=${encodeURIComponent(token)}&expiry=${expiry}`;
    return direct;
}

function extractMediaUrlFromRawHtml(html, baseUrl) {
    if (!html) return "";
    const candidates = [];
    const push = (raw) => {
        try {
            const abs = new URL(raw, baseUrl).href;
            if (!/^https?:/i.test(abs)) return;
            if (
                !/\.(?:mp4|m3u8|mpd|webm|mov)(?:[?#]|$)/i.test(abs) &&
                !/\/get_file\//i.test(abs) &&
                !/(?:pimpbunny|fnxtube)\.com\/remote_control\.php/i.test(abs)
            ) return;
            candidates.push(abs);
        } catch { }
    };
    const patterns = [
        /https?:\/\/[\w.-]+\.(?:pimpbunny|fnxtube)\.com\/remote_control\.php\?[^"'\\\s<>]+/gi,
        /(?:https?:)?\/\/[\w.-]+\.(?:pimpbunny|fnxtube)\.com\/remote_control\.php\?[^"'\\\s<>]+/gi,
        /https?:\/\/[^"'\\\s<>]+?\.(?:mp4|m3u8|mpd|webm|mov)(?:\?[^"'\\\s<>]*)?/gi,
        /(?:https?:)?\/\/[^"'\\\s<>]+?\.(?:mp4|m3u8|mpd|webm|mov)(?:\?[^"'\\\s<>]*)?/gi,
        /https?:\/\/(?:[\w.-]+\.)?camwhores\.tv\/get_file\/[^\s"'<>]+/gi,
    ];
    for (const rx of patterns) {
        for (const m of String(html).matchAll(rx)) push(m[0]);
    }
    const uniq = Array.from(new Set(candidates));
    uniq.sort((a, b) => inferMediaQualityScore(b) - inferMediaQualityScore(a));
    return uniq[0] || "";
}

function unpackLuluPacker(html) {
    const packed = String(html || '').match(/eval\(function\(p,a,c,k,e,d\).*?\.split\(['"]\|['"]\)\)\)/s);
    if (!packed) return '';
    const args = packed[0].match(/}\s*\('(.+)',\s*(\d+),\s*(\d+),\s*'(.+)'\.split\(['"]\|['"]\)/s);
    if (!args) return '';
    let [, source, radix, count, words] = args;
    radix = Number(radix);
    count = Number(count);
    const dictionary = words.split('|');
    const digits = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const baseN = (number) => {
        if (!number) return '0';
        let result = '';
        for (let value = number; value; value = Math.floor(value / radix)) result = digits[value % radix] + result;
        return result;
    };
    for (let index = count - 1; index >= 0; index -= 1) {
        if (dictionary[index]) source = source.replace(new RegExp(`\\b${baseN(index)}\\b`, 'g'), dictionary[index]);
    }
    return source.replace(/\\\//g, '/');
}

async function resolveVidaraLikeDirect(pageUrl) {
    const html = await fetchCorsText(pageUrl, pageUrl);
    if (!html) return null;
    const hexMatch = html.match(/const _0x1\s*=\s*'([0-9a-f|]+)';/i);
    if (hexMatch) {
        try {
            const hexStr = hexMatch[1].replace(/\|/g, '');
            let decoded = "";
            for (let k = 0; k < hexStr.length; k += 2) {
                decoded += String.fromCharCode(parseInt(hexStr.substr(k, 2), 16));
            }
            const direct = decoded.split("").reverse().join("");
            if (/^https?:\/\//i.test(direct)) return direct;
        } catch { }
    }
    const extracted = extractMediaUrlFromRawHtml(html, pageUrl);
    return extracted || null;
}

async function resolveLulustreamDirect(pageUrl) {
    const html = await fetchCorsText(pageUrl, pageUrl);
    if (!html) return null;
    const extracted = extractMediaUrlFromRawHtml(unpackLuluPacker(html) || html, pageUrl);
    return extracted || null;
}

async function deepResolveRealStream(pageUrl, currentStream = "", declaredDuration = 0) {
    const normalizedPage = String(pageUrl || "").trim();
    if (!normalizedPage) return null;
    const lowPage = normalizedPage.toLowerCase();
    const lowStream = String(currentStream || "").toLowerCase();

    if (isBunkrDomain(lowPage)) {
        const direct = await resolveBunkrDirectFromPage(normalizedPage);
        if (direct) {
            const head = await fetchHeadInfo(direct, normalizedPage);
            return {
                streamUrl: direct,
                sizeBytes: Number(head?.contentLength || 0) || 0,
                duration: Number(declaredDuration || 0) || 0,
                source: "bunkr-resolve",
            };
        }
    }

    // Direct doodstream page import
    if (/(doodstream\.com|dood\.[a-z]+|playmogo\.com)\/(?:e|d)\//i.test(lowPage)) {
        const direct = await resolveDoodstreamDirect(normalizedPage);
        if (!direct) return null;
        const head = await fetchHeadInfo(direct, normalizedPage);
        if (head.ok && head.contentLength > 0 && head.contentLength < (1 * 1024 * 1024)) return null;
        return { streamUrl: direct, sizeBytes: head.ok ? head.contentLength : 0, duration: Number(declaredDuration || 0) || 0, source: "dood-resolve" };
    }
    if (/(lulustream\.[a-z]+|luluvid\.[a-z]+|luluvdo\.[a-z]+|luluvids\.[a-z]+|lulu\.stream|vidara\.so|vidsonic\.net|vidfast\.co)/i.test(lowPage)) {
        const direct = /(vidara\.so|vidsonic\.net|vidfast\.co)/i.test(lowPage)
            ? await resolveVidaraLikeDirect(normalizedPage)
            : await resolveLulustreamDirect(normalizedPage);
        if (direct) {
            const head = await fetchHeadInfo(direct, normalizedPage);
            if (head.ok && head.contentLength > 0 && head.contentLength < (1 * 1024 * 1024)) return null;
            return { streamUrl: direct, sizeBytes: head.ok ? head.contentLength : 0, duration: Number(declaredDuration || 0) || 0, source: "host-resolve" };
        }
    }

    // sxyprn post/list page deep scan to hosters
    if (/sxyprn\.(com|net)/i.test(lowPage) || /sxyprn\.(com|net)/i.test(lowStream)) {
        const html = await fetchCorsText(normalizedPage, normalizedPage);
        if (!html) return null;
        const candidates = extractHosterCandidatesFromSxyprnHtml(html, normalizedPage);
        for (const candidate of candidates) {
            if (/(doodstream\.com|dood\.[a-z]+|playmogo\.com)\/(?:e|d)\//i.test(candidate)) {
                const direct = await resolveDoodstreamDirect(candidate);
                if (!direct) continue;
                const head = await fetchHeadInfo(direct, candidate);
                if (head.ok && head.contentLength > 0 && head.contentLength < (1 * 1024 * 1024)) continue;
                return { streamUrl: direct, sizeBytes: head.ok ? head.contentLength : 0, duration: Number(declaredDuration || 0) || 0, source: "sxyprn-dood-deep" };
            } else if (/(lulustream\.[a-z]+|luluvid\.[a-z]+|luluvdo\.[a-z]+|luluvids\.[a-z]+|lulu\.stream)/i.test(candidate)) {
                const direct = await resolveLulustreamDirect(candidate);
                if (!direct) continue;
                const head = await fetchHeadInfo(direct, candidate);
                if (head.ok && head.contentLength > 0 && head.contentLength < (1 * 1024 * 1024)) continue;
                return { streamUrl: direct, sizeBytes: head.ok ? head.contentLength : 0, duration: Number(declaredDuration || 0) || 0, source: "sxyprn-lulu-deep" };
            } else if (/(vidara\.so|vidsonic\.net|vidfast\.co)/i.test(candidate)) {
                const direct = await resolveVidaraLikeDirect(candidate);
                if (!direct) continue;
                const head = await fetchHeadInfo(direct, candidate);
                if (head.ok && head.contentLength > 0 && head.contentLength < (1 * 1024 * 1024)) continue;
                return { streamUrl: direct, sizeBytes: head.ok ? head.contentLength : 0, duration: Number(declaredDuration || 0) || 0, source: "sxyprn-vidara-deep" };
            }
        }
    }
    return null;
}

function extractBunkrSlugFromUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
        const url = new URL(raw);
        const match = url.pathname.match(/\/f\/([^/?#]+)/i);
        return match ? String(match[1] || "").trim() : "";
    } catch {
        const match = raw.match(/\/f\/([^/?#]+)/i);
        return match ? String(match[1] || "").trim() : "";
    }
}

function extractDirectBunkrVideoUrlFromHtml(html, baseUrl = "") {
    const text = String(html || "");
    if (!text) return "";
    const patterns = [
        /https?:\/\/[a-z0-9.-]+\.(?:st|su|io|is|si|la|pk|cr|ru)\/[a-zA-Z0-9_-]+\.(?:mp4|mkv|mov|webm)(?:\?[^"'<>\\s]*)?/gi,
        /"file"\s*:\s*"([^"]+\.(?:mp4|mkv|webm)[^"]*)"/gi,
        /"src"\s*:\s*"([^"]+\.(?:mp4|mkv|webm)[^"]*)"/gi,
        /source\s+src=["']([^"']+\.(?:mp4|mkv|webm)[^"']*)["']/gi,
        /href=["'](https?:\/\/[^"']+\.(?:mp4|mkv|webm)[^"']*)["']/gi,
    ];
    const candidates = [];
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(text))) {
            let candidate = String(match[1] || match[0] || "").replace(/\\/g, "").trim();
            if (!candidate) continue;
            if (/preview|thumb|sample|trailer|intro/i.test(candidate)) continue;
            candidates.push(candidate);
        }
    }
    const picked = candidates[0] || "";
    if (!picked) return "";
    try {
        let finalUrl = new URL(picked, baseUrl || "https://bunkr.pk").href;
        if (finalUrl.startsWith("//")) finalUrl = "https:" + finalUrl;
        return finalUrl;
    } catch {
        return picked;
    }
}

function decodeBunkrVsUrl(encoded, timestamp) {
    if (!encoded || !timestamp) return null;
    try {
        const binary = atob(encoded);
        const key = `SECRET_KEY_${Math.floor(Number(timestamp) / 3600)}`;
        let out = "";
        for (let i = 0; i < binary.length; i++) {
            out += String.fromCharCode(binary.charCodeAt(i) ^ key.charCodeAt(i % key.length));
        }
        return out;
    } catch (e) {
        console.warn("[Bunkr] XOR Decode failed:", e);
        return null;
    }
}

async function resolveBunkrViaVs(pageUrl) {
    const slug = extractBunkrSlugFromUrl(pageUrl);
    if (!slug) return "";

    const cleanSlug = slug.replace(/\.(mp4|mkv|mov|webm|m4v|avi)$/i, "");
    let origin = "https://bunkr.pk";
    try {
        origin = new URL(pageUrl).origin || origin;
    } catch { }

    const tryResolve = async (s) => {
        try {
            const res = await fetch(`${origin}/api/vs`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    "Referer": pageUrl,
                    "Origin": origin,
                },
                credentials: "omit",
                body: JSON.stringify({ slug: s }),
            });
            if (!res.ok) return "";
            const data = await res.json().catch(() => null);
            let direct = String(data?.url || "").trim();

            if (data?.encrypted && direct) {
                direct = decodeBunkrVsUrl(direct, data.timestamp);
            }

            if (direct && !/preview|thumb/i.test(direct)) {
                if (direct.startsWith("//")) direct = "https:" + direct;
                if (!/^https?:\/\//i.test(direct)) return "";
                return direct;
            }
        } catch (e) {
            console.warn("[Bunkr] API Resolve error:", e);
        }
        return "";
    };

    let result = await tryResolve(cleanSlug);
    if (!result && cleanSlug !== slug) {
        result = await tryResolve(slug);
    }
    return result;
}

async function resolveBunkrDirectFromPage(pageUrl) {
    const viaVs = await resolveBunkrViaVs(pageUrl);
    if (viaVs) return viaVs;
    try {
        const res = await fetch(pageUrl, {
            credentials: "omit",
            headers: {
                Referer: pageUrl,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            },
        });
        if (!res.ok) return "";
        const html = await res.text();
        return extractDirectBunkrVideoUrlFromHtml(html, pageUrl);
    } catch {
        return "";
    }
}

async function pickImportableStream({ pageUrl, streamUrl, durationSec }) {
    const currentUrl = String(streamUrl || "").trim();
    const durationRaw = Number(durationSec || 0) || 0;
    const rawLooksSuspicious = looksLikeTrailerUrl(currentUrl);
    const blockedHost = isBlockedProxyProneHost(currentUrl);
    const megaChunk = isMegaUserStorageUrl(currentUrl);

    // Fast-path for bunkr file pages
    if (isBunkrDomain(pageUrl)) {
        // 0. If the passed streamUrl is already a Bunkr CDN signed mp4 — use it directly.
        // CDN servers (*.cdn.cr, *.cdn.st, *.cdn.bunkr.*, etc.) block HEAD/Range from extension
        // context and return 548-byte error bodies, so size validation is unreliable. Skip it.
        const isBunkrCdnDirect = currentUrl &&
            /\.(mp4|mkv|mov|webm|m4v)(\?|$)/i.test(currentUrl) &&
            /\.cdn\.[a-z]{2,6}(\/|$)/i.test(currentUrl);
        if (isBunkrCdnDirect) {
            console.log("[pickImportableStream] Bunkr CDN direct URL — skipping size check:", currentUrl);
            return {
                streamUrl: currentUrl,
                duration: durationRaw,
                sizeBytes: 0,
                source: "bunkr-cdn-direct",
            };
        }

        // 1. Check if content script already intercepted the signed URL (best source)
        const cached = bunkrSignedCache.get(pageUrl);
        const cacheAge = cached ? (Date.now() - cached.ts) : Infinity;
        if (cached?.signedUrl && cacheAge < 5 * 60 * 1000) { // valid for 5 min
            const head = await fetchHeadInfo(cached.signedUrl, pageUrl).catch(() => null);
            return {
                streamUrl: cached.signedUrl,
                duration: durationRaw,
                sizeBytes: Number(head?.contentLength || 0) || 0,
                source: "bunkr-intercepted",
            };
        }
        // 2. Fallback: try /api/vs resolution
        const bunkrDirect = await resolveBunkrDirectFromPage(pageUrl);
        if (bunkrDirect) {
            const head = await fetchHeadInfo(bunkrDirect, pageUrl).catch(() => null);
            return {
                streamUrl: bunkrDirect,
                duration: durationRaw,
                sizeBytes: Number(head?.contentLength || 0) || 0,
                source: "bunkr-vs",
            };
        }
    }

    let currentHead = null;
    if (currentUrl && !looksLikeHls(currentUrl)) {
        currentHead = await fetchHeadInfo(currentUrl, pageUrl || currentUrl);
    }
    const currentSize = Number(currentHead?.contentLength || 0) || 0;
    const megaHeadOk = megaChunk && currentHead?.ok && /application\/octet-stream/i.test(String(currentHead.contentType || ""));
    const pbRemote = /(?:pimpbunny|fnxtube)\.com\/remote_control\.php/i.test(currentUrl);
    const durationKnown = durationRaw > 0;
    const duration =
        pbRemote && durationRaw < MIN_PIMPBUNNY_REMOTE_DURATION_SEC
            ? MIN_PIMPBUNNY_REMOTE_DURATION_SEC
            : durationRaw;
    const minDurationForHost = pbRemote ? MIN_PIMPBUNNY_REMOTE_DURATION_SEC : MIN_REAL_VIDEO_DURATION_SEC;
    const durationTooShort = durationKnown && duration < minDurationForHost;
    const sizeOrHls =
        looksLikeHls(currentUrl) || currentSize >= MIN_REAL_VIDEO_BYTES;
    const passes =
        currentUrl &&
        !rawLooksSuspicious &&
        !blockedHost &&
        !durationTooShort &&
        (sizeOrHls || pbRemote || megaHeadOk);
    if (passes) {
        return {
            streamUrl: currentUrl,
            duration,
            sizeBytes: currentSize,
            source: "captured",
        };
    }

    const deep = await deepResolveRealStream(pageUrl, currentUrl, duration);
    if (deep?.streamUrl) {
        if (looksLikeTrailerUrl(deep.streamUrl) || isBlockedProxyProneHost(deep.streamUrl)) return null;
        return {
            streamUrl: deep.streamUrl,
            duration: Number(deep.duration || duration || 0) || 0,
            sizeBytes: Number(deep.sizeBytes || 0) || 0,
            source: deep.source || "deep",
        };
    }
    return null;
}

function choosePreferredCapturedStream(pageUrl, currentUrl, candidateUrl) {
    const current = String(currentUrl || '').trim();
    const next = String(candidateUrl || '').trim();
    if (!current) return next;
    if (!next) return current;
    if (looksLikeTrailerUrl(next) && !looksLikeTrailerUrl(current)) return current;
    if (!looksLikeTrailerUrl(next) && looksLikeTrailerUrl(current)) return next;

    const pageHost = String(pageUrl || '').toLowerCase();
    if (!/beeg\.com/i.test(pageHost)) {
        return inferMediaQualityScore(next) >= inferMediaQualityScore(current) ? next : current;
    }

    const currentScore = inferMediaQualityScore(current);
    const nextScore = inferMediaQualityScore(next);
    return nextScore >= currentScore ? next : current;
}

function getPornHoarderDebugKey() {
    return "ph_debug_latest";
}

function extractPornHoarderVideoId(url) {
    try {
        const pathname = new URL(url).pathname;
        const match = pathname.match(/\/watch\/([^/?#]+)/i);
        return match ? match[1] : "";
    } catch {
        return "";
    }
}

async function setPornHoarderDebug(data) {
    await chrome.storage.local.set({ [getPornHoarderDebugKey()]: data });
}

function isSupportedHost(url) {
    if (!url) return false;
    return /gofile\.io|filester\.(?:me|gg|net|co|org|io)|recurbate\.com|rec-ur-bate\.com|noodlemagazine\.com|fullporner\.com|whoreshub\.com|thots\.tv|vidara\.(?:so|to)|vtbe\.to|sxyprn\.(com|net)|krakenfiles\.com|hornysimp|hornybitches\.org|nsfw247|xmoviesforyou\.com|beeg\.com|katestube\.com|(?:pimpbunny|fnxtube)\.com|porncream\.com|xvideos\.(com|red)|eporner\.com|internetchicks\.com|xxbrits\.com|leakedzone\.com/i.test(url);
}

function addCamwhoresRnd(url) {
    const raw = String(url || '').trim();
    if (!/camwhores\.tv\/get_file\//i.test(raw)) return raw;
    try {
        const u = new URL(raw);
        u.searchParams.set('rnd', String(Date.now()));
        return u.href;
    } catch {
        return raw.includes('?') ? `${raw}&rnd=${Date.now()}` : `${raw}?rnd=${Date.now()}`;
    }
}

async function extractCamwhoresDirectFromHtml(pageUrl, attempt = 0) {
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    let html = '';

    try {
        const headers = { "User-Agent": UA, "Referer": "https://www.camwhores.tv/" };
        try {
            const cookies = await chrome.cookies.getAll({ domain: '.camwhores.tv' });
            const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
            if (cookieStr) headers['Cookie'] = cookieStr;
        } catch { }

        const res = await fetch(pageUrl, { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        html = await res.text();
    } catch (e) {
        if (attempt < 1) {
            await new Promise(r => setTimeout(r, 700));
            return extractCamwhoresDirectFromHtml(pageUrl, attempt + 1);
        }
        console.warn('[CW Resolver] Fetch failed:', e?.message || e);
        return null;
    }

    const candidates = [];

    function sanitizeUrl(raw) {
        if (!raw) return raw;
        const idxHttps = raw.indexOf('https://');
        if (idxHttps > 0) return raw.substring(idxHttps);
        const idxHttp = raw.indexOf('http://');
        if (idxHttp > 0) return raw.substring(idxHttp);
        return raw;
    }

    function scoreFromUrl(u) {
        const m = String(u || '').match(/[/_](2160|1440|1080|720|480|360)p/i) || String(u || '').match(/\/(2160|1440|1080|720|480|360)\//);
        const p = m ? parseInt(m[1], 10) : 0;
        if (p >= 2160) return 100;
        if (p >= 1440) return 95;
        if (p >= 1080) return 90;
        if (p >= 720) return 80;
        if (p >= 480) return 70;
        if (p >= 360) return 60;
        return 75;
    }

    const getFileRegex = /https?:\/\/(?:[\w.-]+\.)?camwhores\.tv\/get_file\/[^\s"'<>]+/gi;
    for (const m of html.matchAll(getFileRegex)) {
        const url = sanitizeUrl(m[0].split(/["'<>\s]/)[0]);
        candidates.push({ url, score: scoreFromUrl(url) + 40 });
    }

    const scriptPatterns = [
        /video_url_hd\s*[=:]\s*["']([^"']+)["']/gi,
        /video_url\s*[=:]\s*["']([^"']+)["']/gi,
        /"file"\s*:\s*"(https?:\/\/[^\"]+)"/gi,
        /source\s+src=["'](https?:\/\/[^"']+)["']/gi,
    ];
    for (const re of scriptPatterns) {
        for (const m of html.matchAll(re)) {
            const url = sanitizeUrl(String(m[1] || '').replace(/\\/g, ''));
            if (url && (url.includes('camwhores.tv') || url.includes('get_file'))) {
                candidates.push({ url, score: scoreFromUrl(url) + 20 });
            }
        }
    }

    if (!candidates.length) return null;

    const deduped = [];
    const seen = new Set();
    for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
        const key = String(candidate.url || '').split('?')[0];
        if (!key || seen.has(key)) continue;
        seen.add(key);
        deduped.push(candidate);
    }

    const best = deduped[0];
    return best?.url ? addCamwhoresRnd(best.url) : null;
}

function isMediaUrl(url) {
    if (isMegaUserStorageUrl(url)) return true;
    if (isFilesterPlaybackUrl(url)) return true;
    if (/(?:^|\.)gofile\.io\/download\//i.test(url || "")) return true;

    // Also capture JW Player ping URLs which contain the manifest in 'mu' parameter
    if (url && url.includes('ping.gif') && url.includes('mu=')) return true;

    // Camwhores direct URLs can be get_file without explicit file extension.
    if (/camwhores\.tv\/get_file\//i.test(url || "")) return true;
    if (/(?:pimpbunny|fnxtube)\.com\/remote_control\.php/i.test(url || "")) return true;
    if (/xgroovy(?:-fr)?\.com\/get_file\//i.test(url || "")) return true;

    if (/\.(mp4|m3u8|mpd|vid|webm|mkv|mov|m4v)(\?|$)/i.test(url || "") || /manifest|playlist|master/i.test(url || "")) {
        // Smart filter: Ignore common preview/thumbnail video patterns
        if (/vidthumb|preview|small\.mp4|get_preview/i.test(url)) return false;
        return true;
    }
    return false;
}

function isObviouslyNonPlayableCaptureUrl(url) {
    const raw = String(url || "").trim().toLowerCase();
    if (!raw) return true;
    if (/\.(?:json|js|css|png|jpe?g|webp|gif|svg|ico|woff2?|ttf)(?:[?#]|$)/i.test(raw)) return true;
    if (/\/(?:static|assets?|public)\//i.test(raw) && !/\.(?:mp4|m3u8|mpd|webm|mov|vid)(?:[?#]|$)/i.test(raw)) return true;
    if (/\/manifest\.json(?:[?#]|$)/i.test(raw)) return true;
    return false;
}

function extractRedgifsWatchId(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    const m = s.match(/\/watch\/([^/?#]+)/i);
    return m ? m[1] : "";
}

function parseDurationTextToSeconds(raw) {
    const s = String(raw || "").trim();
    if (!s) return 0;
    const parts = s.split(":").map((p) => Number(p));
    if (parts.some((n) => !Number.isFinite(n))) return 0;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
}

function decodeHtmlEntities(raw) {
    return String(raw || "")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}

async function getRedgifsTemporaryToken(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && redgifsTokenCache.token && redgifsTokenCache.expiresAt > now) {
        return redgifsTokenCache.token;
    }
    const resp = await fetch(`${REDGIFS_API_BASE}/auth/temporary`, {
        headers: {
            "Accept": "application/json",
            "Referer": "https://www.redgifs.com/",
            "Origin": "https://www.redgifs.com",
        },
    });
    if (!resp.ok) throw new Error(`RedGIFs temp token failed (${resp.status})`);
    const data = await resp.json().catch(() => ({}));
    const token = String(data?.token || "").trim();
    if (!token) throw new Error("RedGIFs temp token missing");
    redgifsTokenCache = {
        token,
        expiresAt: now + (25 * 60 * 1000),
    };
    return token;
}

function parseRedgifsHtmlDetails(html, fallbackItem = {}) {
    const text = String(html || "");
    const meta = {
        title: fallbackItem.title || "",
        video_url: fallbackItem.video_url || "",
        page_url: fallbackItem.page_url || "",
        thumbnail: fallbackItem.thumbnail || "",
        tags: Array.isArray(fallbackItem.tags) ? fallbackItem.tags.slice() : [],
        duration: Number(fallbackItem.duration || 0) || 0,
        width: Number(fallbackItem.width || 0) || 0,
        height: Number(fallbackItem.height || 0) || 0,
    };

    const ogTitle = text.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"]+)["']/i);
    if (ogTitle?.[1]) meta.title = decodeHtmlEntities(ogTitle[1]);

    const ogImage = text.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"]+)["']/i);
    if (ogImage?.[1]) meta.thumbnail = decodeHtmlEntities(ogImage[1]);

    const ogVideo = text.match(/<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']([^"]+)["']/i);
    if (ogVideo?.[1]) meta.video_url = decodeHtmlEntities(ogVideo[1]);

    const durationMatch = text.match(/"duration"\s*:\s*(\d{1,6})/i) || text.match(/video:duration["']?\s+content=["'](\d{1,6})["']/i);
    if (durationMatch?.[1]) meta.duration = Number(durationMatch[1]) || meta.duration;

    const widthMatch = text.match(/"width"\s*:\s*(\d{2,5})/i);
    const heightMatch = text.match(/"height"\s*:\s*(\d{2,5})/i);
    if (widthMatch?.[1]) meta.width = Number(widthMatch[1]) || meta.width;
    if (heightMatch?.[1]) meta.height = Number(heightMatch[1]) || meta.height;

    return meta;
}

async function fetchRedgifsApiDetails(item) {
    const gifId = extractRedgifsWatchId(item.page_url || item.pageUrl || item.source_url || "") || String(item.id || "").trim();
    if (!gifId) return null;

    let token = await getRedgifsTemporaryToken(false);
    let resp = await fetch(`${REDGIFS_API_BASE}/gifs/${encodeURIComponent(gifId)}`, {
        headers: {
            "Accept": "application/json",
            "Authorization": `Bearer ${token}`,
            "Referer": "https://www.redgifs.com/",
            "Origin": "https://www.redgifs.com",
        },
    });
    if (resp.status === 401) {
        token = await getRedgifsTemporaryToken(true);
        resp = await fetch(`${REDGIFS_API_BASE}/gifs/${encodeURIComponent(gifId)}`, {
            headers: {
                "Accept": "application/json",
                "Authorization": `Bearer ${token}`,
                "Referer": "https://www.redgifs.com/",
                "Origin": "https://www.redgifs.com",
            },
        });
    }
    if (!resp.ok) return null;

    const data = await resp.json().catch(() => ({}));
    const gif = data?.gif || data?.item || data?.result?.gif || data?.result || data;
    const urls = gif?.urls || {};
    return {
        id: gif?.id || gifId,
        title: gif?.caption || item.title || `RedGIFs ${gifId}`,
        video_url: urls.hd || urls.sd || urls.file_url || urls.embed_url || item.video_url || "",
        page_url: item.page_url || item.pageUrl || `https://www.redgifs.com/watch/${gifId}`,
        thumbnail: urls.thumbnail || urls.poster || item.thumbnail || "",
        tags: Array.isArray(gif?.tags) ? gif.tags : (Array.isArray(item.tags) ? item.tags : []),
        duration: Number(gif?.duration || item.duration || 0) || 0,
        width: Number(gif?.width || gif?.w || item.width || 0) || 0,
        height: Number(gif?.height || gif?.h || item.height || 0) || 0,
    };
}

async function fetchRedgifsPageDetails(item) {
    const pageUrl = String(item.page_url || item.pageUrl || item.source_url || "").trim();
    if (!pageUrl) return null;
    const resp = await fetch(pageUrl, {
        headers: {
            "Accept": "text/html,application/xhtml+xml",
            "Referer": "https://www.redgifs.com/",
        },
        credentials: "omit",
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    return parseRedgifsHtmlDetails(html, item);
}

async function probeRedgifsSizeMb(videoUrl) {
    const url = String(videoUrl || "").trim();
    if (!url) return 0;
    const headers = {
        "Accept": "*/*",
        "Referer": "https://www.redgifs.com/",
        "Origin": "https://www.redgifs.com",
    };
    try {
        const resp = await fetch(url, { method: "HEAD", headers, credentials: "omit", redirect: "follow" });
        const len = Number(resp.headers.get("content-length") || 0) || 0;
        if (len > 0) return Math.round(len / 1048576);
    } catch { }
    try {
        const resp = await fetch(url, { method: "GET", headers: { ...headers, Range: "bytes=0-0" }, credentials: "omit", redirect: "follow" });
        const range = resp.headers.get("content-range") || "";
        const match = range.match(/\/(\d+)$/);
        const len = match ? Number(match[1] || 0) : Number(resp.headers.get("content-length") || 0);
        if (len > 0) return Math.round(len / 1048576);
    } catch { }
    return 0;
}

async function hydrateRedgifsItems(items) {
    const sourceItems = Array.isArray(items) ? items : [];
    const results = [];

    for (const item of sourceItems) {
        const base = {
            id: String(item.id || extractRedgifsWatchId(item.page_url || item.pageUrl || "") || "").trim(),
            title: String(item.title || "").trim(),
            page_url: String(item.page_url || item.pageUrl || item.source_url || "").trim(),
            video_url: String(item.video_url || item.videoUrl || "").trim(),
            thumbnail: String(item.thumbnail || item.thumbnail_path || "").trim(),
            tags: Array.isArray(item.tags) ? item.tags.slice() : [],
            duration: Number(item.duration || parseDurationTextToSeconds(item.durationLabel || "")) || 0,
            width: Number(item.width || 0) || 0,
            height: Number(item.height || 0) || 0,
            file_size_mb: Number(item.file_size_mb || item.size_mb || item.filesize || 0) || 0,
        };

        let enriched = null;
        try {
            enriched = await fetchRedgifsApiDetails(base);
        } catch (error) {
            console.warn("[RedGIFs] API hydrate failed:", error);
        }
        if (!enriched) {
            try {
                enriched = await fetchRedgifsPageDetails(base);
            } catch (error) {
                console.warn("[RedGIFs] Page hydrate failed:", error);
            }
        }
        const merged = { ...base, ...(enriched || {}) };
        if (!merged.file_size_mb && merged.video_url) {
            merged.file_size_mb = await probeRedgifsSizeMb(merged.video_url);
        }
        results.push(merged);
    }

    return results;
}

function nexusTurboDecodeHtml(value) {
    return String(value || "")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}

function nexusTurboAbsUrl(rawUrl, baseUrl) {
    if (!rawUrl) return "";
    try {
        return new URL(nexusTurboDecodeHtml(rawUrl), baseUrl).href;
    } catch {
        return "";
    }
}

function nexusTurboMeta(html, property) {
    const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const direct = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i");
    const reverse = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, "i");
    return nexusTurboDecodeHtml(html.match(direct)?.[1] || html.match(reverse)?.[1] || "");
}

function nexusTurboParsePage(html, pageUrl) {
    // turbo.cr page source embeds VIDEO_DIRECT as a relative path JS variable, e.g.
    // const VIDEO_DIRECT = "\/KulILjXIep543.mp4";
    // Extract this first — it's the most reliable source of the stream URL.
    let streamUrl = "";
    const directVarMatch = html.match(/VIDEO_DIRECT\s*=\s*["'`](\\?\/[^"'`\s]+)["'`]/i);
    if (directVarMatch) {
        // nexusTurboAbsUrl uses new URL(path, base) — backslash-slash is treated as /
        streamUrl = nexusTurboAbsUrl(directVarMatch[1], pageUrl);
    }

    if (!streamUrl) {
        const streamPatterns = [
            /<video[^>]+src=["']([^"']+)["']/i,
            /<source[^>]+src=["']([^"']+)["']/i,
            /<meta[^>]+property=["']og:video(?::secure_url|:url)?["'][^>]+content=["']([^"']+)["']/i,
            /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video(?::secure_url|:url)?["']/i,
            /(https?:\/\/[^"'\\<>\s]+turbocdn[^"'\\<>\s]+\.mp4[^"'\\<>\s]*)/i,
            // Absolute mp4 URL anywhere in HTML (fallback)
            /(https?:\/\/[^"'\\<>\s]+\.mp4(?:\?[^"'\\<>\s]*)?)/i,
        ];

        for (const pattern of streamPatterns) {
            const match = html.match(pattern);
            if (match?.[1]) {
                streamUrl = nexusTurboAbsUrl(match[1], pageUrl);
                break;
            }
        }
    }

    const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
    const title = (nexusTurboMeta(html, "og:title") || nexusTurboDecodeHtml(titleTag) || "Turbo video")
        .replace(/\s*[-|]\s*turbo\.cr\s*$/i, "")
        .trim();
    const thumbnail = nexusTurboAbsUrl(
        nexusTurboMeta(html, "og:image") || html.match(/<video[^>]+poster=["']([^"']+)["']/i)?.[1],
        pageUrl
    );
    const duration = Number(nexusTurboMeta(html, "og:video:duration")) || 0;
    return { streamUrl, title, thumbnail, duration };
}

function nexusTurboExtractId(url) {
    const raw = String(url || "").trim();
    const m = raw.match(/turbo\.cr\/(?:v|d|embed)\/([^/?#]+)/i);
    return m?.[1] || "";
}

function nexusTurboCanonicalWatchUrl(url) {
    const id = nexusTurboExtractId(url);
    if (!id) return String(url || "").trim();
    return `https://turbo.cr/v/${id}`;
}

function nexusTurboEmbedUrl(url) {
    const id = nexusTurboExtractId(url);
    return id ? `https://turbo.cr/embed/${id}` : "";
}

async function nexusTurboResolve(url) {
    const canonicalUrl = nexusTurboCanonicalWatchUrl(url);
    const embedUrl = nexusTurboEmbedUrl(canonicalUrl);
    const turboId = nexusTurboExtractId(canonicalUrl);
    const cached = await chrome.storage.local.get([`nexus_turbo_direct_${canonicalUrl}`]);
    const cachedValue = cached?.[`nexus_turbo_direct_${canonicalUrl}`];
    if (cachedValue?.streamUrl && Date.now() - Number(cachedValue.ts || 0) < 90 * 60 * 1000) {
        return cachedValue;
    }

    const res = await fetch(canonicalUrl, {
        credentials: "include",
        headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    });
    const html = await res.text();
    if (!res.ok) throw new Error(`Turbo returned ${res.status}`);
    const parsed = nexusTurboParsePage(html, canonicalUrl);

    // Legacy VIDEO_DIRECT points to turbo.cr/{id}.mp4 which now returns 404.
    if (/^https?:\/\/turbo\.cr\/[^/?#]+\.mp4(?:\?|$)/i.test(parsed.streamUrl || "")) {
        parsed.streamUrl = "";
    }

    if (!parsed.streamUrl && turboId) {
        const signResp = await fetch(`https://turbo.cr/api/sign?v=${encodeURIComponent(turboId)}`, {
            credentials: "include",
            headers: {
                Accept: "application/json, text/plain, */*",
                Referer: embedUrl,
            },
        });
        if (signResp.ok) {
            const signData = await signResp.json().catch(() => null);
            const signed = String(signData?.url || "").trim();
            if (/^https?:\/\//i.test(signed)) {
                parsed.streamUrl = signed;
            }
        }
    }

    if (!parsed.streamUrl) {
        const embedResp = await fetch(embedUrl, {
            credentials: "include",
            headers: {
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                Referer: canonicalUrl,
            },
        });
        if (embedResp.ok) {
            const embedHtml = await embedResp.text();
            const embedParsed = nexusTurboParsePage(embedHtml, embedUrl);
            if (embedParsed.streamUrl) {
                parsed.streamUrl = embedParsed.streamUrl;
            }
        }
    }
    if (!parsed.streamUrl) throw new Error("Direct Turbo stream not found");
    return parsed;
}

async function nexusTurboImport({ url, port, title }) {
    const resolved = await nexusTurboResolve(url);
    const baseUrl = port ? `http://localhost:${port}` : await findDashboardUrl();
    const targetUrl = `${baseUrl}/api/v1/import/bulk`;
    const resp = await fetch(targetUrl, {
        method: "POST",
        headers: await buildLocalApiHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
            batch_name: "SimpCity Turbo Import",
            videos: [{
                url: resolved.streamUrl,
                title: resolved.title || title || "Turbo video",
                source_url: url,
                duration: resolved.duration || 0,
                thumbnail: resolved.thumbnail || null,
            }],
        }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `Nexus returned ${resp.status}`);
    return { resolved, data };
}

async function nexusTurboImportBulk({ items, port, batchName }) {
    const baseUrl = port ? `http://localhost:${port}` : await findDashboardUrl();
    const targetUrl = `${baseUrl}/api/v1/import/bulk`;
    const list = Array.isArray(items) ? items : [];
    const videos = [];
    const errors = [];

    for (const raw of list) {
        const sourceUrl = String(raw?.url || "").trim();
        if (!sourceUrl) continue;
        try {
            const resolved = await nexusTurboResolve(sourceUrl);
            if (!resolved?.streamUrl) {
                errors.push({ url: sourceUrl, error: "no-stream" });
                continue;
            }

            const sizeBytes = Number(raw?.sizeBytes || 0) || 0;
            videos.push({
                url: resolved.streamUrl,
                title: String(raw?.title || resolved.title || "Turbo video").trim() || "Turbo video",
                source_url: sourceUrl,
                duration: Number(raw?.duration || 0) || Number(resolved.duration || 0) || 0,
                thumbnail: raw?.thumbnail || resolved.thumbnail || null,
                file_size_mb: sizeBytes > 0 ? Number((sizeBytes / (1024 * 1024)).toFixed(3)) : undefined,
            });
        } catch (e) {
            errors.push({ url: sourceUrl, error: e?.message || String(e) });
        }
    }

    if (!videos.length) {
        throw new Error("No Turbo videos were resolved for import");
    }

    const resp = await fetch(targetUrl, {
        method: "POST",
        headers: await buildLocalApiHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
            batch_name: String(batchName || "Turbo Album Import").trim() || "Turbo Album Import",
            videos,
        }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `Nexus returned ${resp.status}`);
    return { imported: videos.length, requested: list.length, errors, data };
}


async function nexusTurboHunterPush({ links, thread_title, thread_url, autostart = true, autoselect = true, autoimport = false }) {
    const list = Array.isArray(links) ? links : [];
    if (!list.length) throw new Error("Žiadne odkazy na odoslanie do Testera.");

    const candidatePorts = [8000, 8001, 8002];
    let selectedBase = null;
    let pushResult = null;
    let lastError = null;

    const payload = {
        thread_title: String(thread_title || "Turbo.cr Library").trim(),
        thread_url: String(thread_url || "https://turbo.cr/library").trim(),
        links: list.map((l) => ({
            url: l.url,
            host: "turbo",
            text: l.text || l.title || l.url,
            context: l.context || "",
            quality: l.quality || "HD",
        })),
    };

    for (const port of candidatePorts) {
        const base = `http://localhost:${port}`;
        try {
            const resp = await fetch(`${base}/api/v1/hunter/push`, {
                method: "POST",
                headers: await buildLocalApiHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(4000),
            });
            if (resp.ok) {
                const data = await resp.json().catch(() => ({}));
                if (data && data.session_id) {
                    selectedBase = base;
                    pushResult = data;
                    break;
                }
            }
        } catch (err) {
            lastError = err;
        }
    }

    if (!selectedBase || !pushResult?.session_id) {
        throw new Error(lastError?.message || "Nexus server nie je dostupný na portoch 8000, 8001 ani 8002.");
    }

    const autoImportParam = autoimport ? "&autoimport=1" : "";
    const autoStartParam = autostart ? "&autostart=1" : "";
    const autoSelectParam = autoselect ? "&autoselect=1" : "";
    const testerUrl = `${selectedBase}/tester?hunter=1&session=${encodeURIComponent(pushResult.session_id)}${autoStartParam}${autoSelectParam}${autoImportParam}`;

    await chrome.tabs.create({ url: testerUrl });

    return {
        session_id: pushResult.session_id,
        count: pushResult.count || list.length,
        tester_url: testerUrl,
    };
}

async function nexusBunkrImportBulk({ items, port, batchName }) {
    const targetUrl = `http://localhost:${port || 8001}/api/v1/import/bulk`;
    const list = Array.isArray(items) ? items : [];
    const videos = [];
    const errors = [];

    for (const raw of list) {
        const sourceUrl = String(raw?.url || "").trim();
        if (!sourceUrl) continue;
        try {
            let directUrl = await resolveBunkrDirectFromPage(sourceUrl);

            // Fallback: If resolution failed but it's a valid Bunkr page, send the page URL anyway.
            // The backend BunkrExtractor is more powerful (has impersonation) and might succeed.
            if (!directUrl && (sourceUrl.includes("/f/") || sourceUrl.includes("/v/"))) {
                console.log("[Bunkr Import] Resolution failed in background, falling back to source URL for backend:", sourceUrl);
                directUrl = sourceUrl;
            }

            if (!directUrl) {
                errors.push({ url: sourceUrl, error: "no-stream" });
                continue;
            }

            videos.push({
                url: directUrl,
                title: String(raw?.title || "Bunkr video").trim(),
                source_url: sourceUrl,
                thumbnail: raw?.thumbnail || null,
                file_size_mb: raw?.sizeBytes ? Number((raw.sizeBytes / (1024 * 1024)).toFixed(3)) : undefined,
            });
        } catch (e) {
            errors.push({ url: sourceUrl, error: e?.message || String(e) });
        }
    }

    if (!videos.length) {
        throw new Error("No Bunkr videos were resolved for import");
    }

    const resp = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            batch_name: String(batchName || "Bunkr Album Import").trim() || "Bunkr Album Import",
            videos,
        }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `Nexus returned ${resp.status}`);
    return { imported: videos.length, requested: list.length, errors, data };
}

// Expands ONE Eporner playlist card (from the search-playlists / best-playlists
// grid) into every video it contains, then imports them all in one batch. The
// dashboard's own EpornerHub adapter already implements playlist paging
// (app/hubs/eporner.py's playlist_videos()) — this just walks every page of
// that endpoint and feeds the plain watch-page URLs straight into the normal
// bulk-import path. No per-video "hydrate" pass is needed here (unlike
// nexusEpornerImportBulk's caller, importSelected()): the backend already
// resolves a bare watch-page URL to its real stream during processing, same
// as every other *_IMPORT_BULK handler that imports by URL instead of a
// pre-resolved direct link.
function isTrustedEpornerPlaylistUrl(rawUrl) {
    try {
        const url = new URL(String(rawUrl || "").trim());
        return url.protocol === "https:"
            && /(^|\.)eporner\.com$/i.test(url.hostname)
            // Eporner exposes both /playlist/<id>/… and the normal search
            // card form /profile/<creator>/playlist/<id>/… .  Anchor on a
            // path segment, not the beginning of the path, while retaining
            // the HTTPS host allowlist and concrete playlist-id requirement.
            && /(?:^|\/)playlist\/[A-Za-z0-9]+(?:\/|$)/i.test(url.pathname);
    } catch {
        return false;
    }
}

async function nexusCyberfileImportBulk({ items, port, batchName }) {
    const list = Array.isArray(items) ? items : [];
    const videos = list.map((raw) => ({
        url: String(raw?.url || '').trim(),
        title: String(raw?.title || 'CyberFile video').trim() || 'CyberFile video',
        source_url: String(raw?.url || '').trim(),
        thumbnail: raw?.thumbnail || null,
        file_size_mb: raw?.sizeBytes ? Number((Number(raw.sizeBytes) / (1024 * 1024)).toFixed(3)) : undefined,
        tags: 'cyberfile,extension',
    })).filter((video) => video.url);
    if (!videos.length) throw new Error('No CyberFile videos selected');
    const targetUrl = `http://localhost:${port || 8000}/api/v1/import/bulk`;
    const response = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_name: String(batchName || 'CyberFile Import').trim() || 'CyberFile Import', videos }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `Nexus returned ${response.status}`);
    return { imported: videos.length, requested: list.length, data };
}

async function nexusEpornerExpandPlaylist({ playlistUrl, playlistTitle }) {
    const url = String(playlistUrl || "").trim();
    if (!isTrustedEpornerPlaylistUrl(url)) throw new Error("Expected an HTTPS Eporner playlist URL");

    const baseUrl = await findDashboardUrl();
    const headers = await buildLocalApiHeaders();
    const videos = [];
    let page = 1;
    let hasMore = true;
    // A playlist can run to hundreds of pages (20 videos/page) — this caps a
    // single import at 100 pages (~2000 videos) as a safety net, not a
    // real-world ceiling for the vast majority of playlists.
    const MAX_PAGES = 100;
    while (hasMore && page <= MAX_PAGES) {
        const resp = await fetch(`${baseUrl}/api/v1/hub/eporner/playlist?pid=${encodeURIComponent(url)}&page=${page}`, { headers });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.detail || `Nexus returned ${resp.status}`);
        const items = Array.isArray(data.items) ? data.items : [];
        for (const item of items) {
            const sourceUrl = String(item?.url || "").trim();
            if (!sourceUrl) continue;
            videos.push({
                url: sourceUrl,
                title: String(item?.title || "Eporner Video").trim() || "Eporner Video",
                source_url: sourceUrl,
                thumbnail: item?.thumb || null,
                duration: Number(item?.duration_sec || 0) || 0,
                height: Number(item?.height || 0) || 0,
                quality: String(item?.quality || "").trim() || undefined,
                tags: "eporner,playlist",
            });
        }
        hasMore = !!data.has_more;
        page += 1;
    }
    if (!videos.length) throw new Error("Playlist has no importable videos");

    const importResp = await fetch(`${baseUrl}/api/v1/import/bulk`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
            batch_name: `Eporner Playlist: ${String(playlistTitle || "Untitled").trim()}`,
            videos,
        }),
    });
    const importData = await importResp.json().catch(() => ({}));
    if (!importResp.ok) throw new Error(importData.detail || `Nexus returned ${importResp.status}`);
    return { imported: videos.length, data: importData };
}

async function nexusEpornerCreateMix({ playlists, name, snapshot, openTab = false }) {
    const list = Array.isArray(playlists) ? playlists : [];
    if (!list.length) throw new Error("Select at least one Eporner playlist");
    const baseUrl = await findDashboardUrl();
    const response = await fetch(`${baseUrl}/api/tester/eporner-mixes`, {
        method: "POST",
        headers: await buildLocalApiHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ playlists: list, name: String(name || "Eporner Playlist Mix"), snapshot: snapshot || {} }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `Nexus returned ${response.status}`);
    // The Dashboard Gallery can now render this indexed mix directly.  It
    // remains read-only and opens source pages for title-only rows, so this is
    // not an import or another deep fetch pass.
    const testerUrl = `${baseUrl}/tester?eporner_mix=${encodeURIComponent(data.mix_id)}`;
    if (openTab) await chrome.tabs.create({ url: testerUrl, active: true });
    return { ...data, testerUrl };
}

async function nexusEpornerFastScan({ playlists }) {
    const submitted = (Array.isArray(playlists) ? playlists : []).map((item) => String(item?.url || "").trim()).filter(Boolean);
    const urls = submitted.filter(isTrustedEpornerPlaylistUrl);
    if (!urls.length || urls.length !== submitted.length) {
        throw new Error("Fast Fetch accepts only HTTPS Eporner playlist URLs");
    }
    const baseUrl = await findDashboardUrl();
    const response = await fetch(`${baseUrl}/api/tester/eporner-playlists/titles/stream`, {
        method: "POST",
        headers: await buildLocalApiHeaders({ "Content-Type": "application/json", "Accept": "text/event-stream" }),
        body: JSON.stringify({ urls }),
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || `Nexus returned ${response.status}`);
    }
    const text = await response.text();
    const events = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data: ")) continue;
        try {
            events.push(JSON.parse(line.slice(6)));
        } catch {
            // A truncated final SSE line must not discard already completed pages.
        }
    }
    return { events };
}

async function nexusEpornerDeepResolve({ urls }) {
    const list = Array.from(new Set((Array.isArray(urls) ? urls : []).map((url) => String(url || "").trim()).filter(Boolean)));
    if (!list.length) throw new Error("No videos to resolve");
    const baseUrl = await findDashboardUrl();
    // Listed watch-page size (download table), not the full extractor.
    // /api/tester/resolve also HEADs /dload and can fall through to yt-dlp,
    // which stalls the extension message port behind the 2s Eporner pacer.
    const response = await fetch(`${baseUrl}/api/tester/batch-meta`, {
        method: "POST",
        headers: await buildLocalApiHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ urls: list.slice(0, 40), metadata_only: true }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `Nexus returned ${response.status}`);
    const rows = Array.isArray(data.results) ? data.results : [];
    return {
        results: rows.map((row) => {
            const sizeBytes = Number(row?.size_bytes || 0);
            return {
                url: row?.url || "",
                status: row?.ok && sizeBytes > 0 ? "success" : "error",
                message: row?.error || (sizeBytes > 0 ? "" : "Watch stránka nevrátila veľkosť z download tabuľky."),
                data: {
                    title: row?.title || "",
                    filename: row?.filename || "",
                    thumbnail: row?.thumbnail || "",
                    duration: Number(row?.duration || 0) || 0,
                    height: Number(row?.height || 0) || 0,
                    quality: row?.quality || "",
                    views: Number(row?.views || 0) || 0,
                    upload_date: row?.upload_date || "",
                    size_bytes: sizeBytes,
                    size_mb: row?.size_mb,
                    size_estimated: !(sizeBytes > 0),
                    stream_url: row?.stream_url || "",
                },
            };
        }),
        summary: {
            total: rows.length,
            success: rows.filter((row) => row?.ok && Number(row?.size_bytes || 0) > 0).length,
        },
    };
}

async function nexusEpornerImportBulk({ items, batchName }) {
    const list = Array.isArray(items) ? items : [];
    const videos = list
        .map((raw) => {
            const sourceUrl = String(raw?.source_url || raw?.url || "").trim();
            const importUrl = String(raw?.url || sourceUrl).trim();
            const sizeBytes = Number(raw?.sizeBytes || 0) || 0;
            const tags = Array.isArray(raw?.tags) ? raw.tags : [];
            const categories = Array.isArray(raw?.categories) ? raw.categories : [];
            const mergedTags = Array.from(new Set(tags.concat(categories).map((entry) => String(entry || "").trim()).filter(Boolean)));
            if (!sourceUrl || !importUrl) return null;
            return {
                url: importUrl,
                title: String(raw?.title || "Eporner Video").trim() || "Eporner Video",
                source_url: sourceUrl,
                thumbnail: raw?.thumbnail || null,
                file_size_mb: sizeBytes > 0 ? Number((sizeBytes / (1024 * 1024)).toFixed(3)) : undefined,
                duration: Number(raw?.duration || 0) || 0,
                width: Number(raw?.width || 0) || 0,
                height: Number(raw?.height || 0) || 0,
                quality: String(raw?.quality || "").trim() || undefined,
                tags: mergedTags.length ? mergedTags.join(",") : "eporner",
            };
        })
        .filter(Boolean);

    if (!videos.length) {
        throw new Error("No Eporner videos were prepared for import");
    }

    const baseUrl = await findDashboardUrl();
    const targetUrl = `${baseUrl}/api/v1/import/bulk`;
    const resp = await fetch(targetUrl, {
        method: "POST",
        headers: await buildLocalApiHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
            batch_name: String(batchName || "Eporner Quick Import").trim() || "Eporner Quick Import",
            videos,
        }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `Nexus returned ${resp.status}`);
    return { imported: videos.length, requested: list.length, data };
}

async function nexusTubed69ImportBulk({ items, batchName }) {
    const list = Array.isArray(items) ? items : [];
    const videos = list.map((raw) => {
        const url = String(raw?.source_url || raw?.url || "").trim();
        let parsed;
        try { parsed = new URL(url); } catch (_) { return null; }
        if (!/^https?:$/.test(parsed.protocol) ||
            !/(^|\.)69tubed\.(com|live)$/.test(parsed.hostname) ||
            !parsed.pathname.startsWith('/video/')) return null;
        const tags = Array.isArray(raw?.tags) ? raw.tags : [];
        return {
            url, source_url: url,
            title: String(raw?.title || '69Tubed Video').trim() || '69Tubed Video',
            thumbnail: raw?.thumbnail || null,
            quality: String(raw?.quality || '').trim(),
            tags: Array.from(new Set(['69tubed', ...tags.map(t => String(t || '').trim()).filter(Boolean)])).join(','),
        };
    }).filter(Boolean);
    if (!videos.length) throw new Error('Žiadne platné 69Tubed videá na import');
    const baseUrl = await findDashboardUrl();
    const resp = await fetch(`${baseUrl}/api/v1/import/bulk`, {
        method: 'POST',
        headers: await buildLocalApiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ batch_name: String(batchName || '69Tubed Quick Import').trim(), videos }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || `Nexus returned ${resp.status}`);
    return { imported: data.imported ?? videos.length, requested: list.length, data };
}

async function nexusRedtubeImportBulk({ items, batchName }) {
    const list = Array.isArray(items) ? items : [];
    const videos = list
        .map((raw) => {
            const sourceUrl = String(raw?.source_url || raw?.url || "").trim();
            // Import the RedTube watch page so the backend extractor resolves the
            // freshest stream; direct_url (if scraped) is passed as a hint only.
            const importUrl = String(raw?.url || sourceUrl).trim();
            if (!sourceUrl || !importUrl) return null;
            const sizeBytes = Number(raw?.sizeBytes || 0) || 0;
            const tags = Array.isArray(raw?.tags) ? raw.tags : [];
            const mergedTags = Array.from(new Set(tags.map((t) => String(t || "").trim()).filter(Boolean)));
            return {
                url: importUrl,
                title: String(raw?.title || "RedTube Video").trim() || "RedTube Video",
                source_url: sourceUrl,
                direct_url: String(raw?.direct_url || "").trim() || undefined,
                thumbnail: raw?.thumbnail || null,
                file_size_mb: sizeBytes > 0 ? Number((sizeBytes / (1024 * 1024)).toFixed(3)) : undefined,
                duration: Number(raw?.duration || 0) || 0,
                width: Number(raw?.width || 0) || 0,
                height: Number(raw?.height || 0) || 0,
                quality: String(raw?.quality || "").trim() || undefined,
                tags: mergedTags.length ? mergedTags.join(",") : "redtube",
            };
        })
        .filter(Boolean);

    if (!videos.length) throw new Error("No RedTube videos were prepared for import");

    const baseUrl = await findDashboardUrl();
    const targetUrl = `${baseUrl}/api/v1/import/bulk`;
    const resp = await fetch(targetUrl, {
        method: "POST",
        headers: await buildLocalApiHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
            batch_name: String(batchName || "RedTube Quick Import").trim() || "RedTube Quick Import",
            videos,
        }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `Nexus returned ${resp.status}`);
    return { imported: videos.length, requested: list.length, data };
}

async function nexusDrtuberProbeSize({ url, referer }, sender) {
    let page;
    let media;
    let watch;
    try {
        page = new URL(String(sender?.url || ""));
        media = new URL(String(url || ""));
        watch = new URL(String(referer || ""));
    } catch {
        throw new Error("Invalid DrTuber media request");
    }
    if (!/^https?:$/.test(page.protocol) || !/(^|\.)drtuber\.com$/i.test(page.hostname) ||
        !/^https?:$/.test(watch.protocol) || !/(^|\.)drtuber\.com$/i.test(watch.hostname) ||
        !/^\/video\/\d+(?:\/|$)/i.test(watch.pathname)) {
        throw new Error("DrTuber size probes must originate from a DrTuber video page");
    }
    if (media.protocol !== "https:" || media.hostname.toLowerCase() !== "gcdn.drtuber.com" ||
        media.username || media.password) {
        throw new Error("Untrusted DrTuber media host");
    }

    const readSize = (response, allowContentLength) => {
        const contentType = response.headers.get("content-type") || "";
        if (contentType && !/^video\/|^application\/octet-stream/i.test(contentType)) return 0;
        const range = response.headers.get("content-range") || "";
        const rangeMatch = range.match(/\/(\d+)\s*$/);
        if (rangeMatch) return Number(rangeMatch[1]) || 0;
        if (allowContentLength) return Number(response.headers.get("content-length") || 0) || 0;
        return 0;
    };
    const referrerOptions = {
        referrer: `https://www.drtuber.com${watch.pathname}`,
        referrerPolicy: "strict-origin-when-cross-origin",
    };
    let headError = null;
    const headController = new AbortController();
    const headTimer = setTimeout(() => headController.abort(), 7000);
    try {
        const response = await fetch(media.href, {
            method: "HEAD",
            redirect: "follow",
            credentials: "include",
            signal: headController.signal,
            ...referrerOptions,
        });
        if (response.ok) {
            const sizeBytes = readSize(response, true);
            if (sizeBytes > 0) return { sizeBytes };
        }
    } catch (error) {
        headError = error;
    } finally {
        clearTimeout(headTimer);
    }

    const rangeController = new AbortController();
    const rangeTimer = setTimeout(() => rangeController.abort(), 7000);
    try {
        const response = await fetch(media.href, {
            method: "GET",
            headers: { Range: "bytes=0-0" },
            redirect: "follow",
            credentials: "include",
            signal: rangeController.signal,
            ...referrerOptions,
        });
        const sizeBytes = response.status === 206
            ? readSize(response, false)
            : response.ok ? readSize(response, true) : 0;
        if (sizeBytes > 0) return { sizeBytes };
        if (headError) console.warn("[Nexus DrTuber] Media size probe returned no file length:", headError.message || headError);
        return { sizeBytes: 0 };
    } catch (error) {
        console.warn("[Nexus DrTuber] Media size probe failed:", error?.message || error);
        return { sizeBytes: 0 };
    } finally {
        rangeController.abort();
        clearTimeout(rangeTimer);
    }
}

async function nexusDrtuberImportBulk({ items, batchName }) {
    const list = Array.isArray(items) ? items : [];
    const videos = list.map((raw) => {
        const sourceUrl = String(raw?.source_url || raw?.url || "").trim();
        let parsed;
        try { parsed = new URL(sourceUrl); } catch { return null; }
        if (!/^https?:$/.test(parsed.protocol) ||
            !/(^|\.)drtuber\.com$/i.test(parsed.hostname) ||
            !/^\/video\/\d+(?:\/|$)/i.test(parsed.pathname)) return null;
        const sizeBytes = Number(raw?.sizeBytes || 0);
        const tags = Array.isArray(raw?.tags) ? raw.tags : [];
        const mergedTags = Array.from(new Set(["drtuber", ...tags.map(tag => String(tag || "").trim()).filter(Boolean)]));
        return {
            url: parsed.href,
            source_url: parsed.href,
            title: String(raw?.title || "DrTuber Video").trim() || "DrTuber Video",
            thumbnail: raw?.thumbnail || null,
            file_size_mb: Number.isFinite(sizeBytes) && sizeBytes > 0
                ? Number((sizeBytes / (1024 * 1024)).toFixed(3))
                : undefined,
            duration: Number(raw?.duration || 0) || 0,
            width: Number(raw?.width || 0) || 0,
            height: Number(raw?.height || 0) || 0,
            quality: String(raw?.quality || "").trim() || undefined,
            upload_date: String(raw?.uploadDate || "").trim() || undefined,
            tags: mergedTags.join(","),
        };
    }).filter(Boolean);
    if (!videos.length) throw new Error("No valid DrTuber videos were prepared for import");

    const baseUrl = await findDashboardUrl();
    const response = await fetch(`${baseUrl}/api/v1/import/bulk`, {
        method: "POST",
        headers: await buildLocalApiHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
            batch_name: String(batchName || "DrTuber Quick Import").trim() || "DrTuber Quick Import",
            videos,
        }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `Nexus returned ${response.status}`);
    return { imported: data.imported ?? videos.length, requested: list.length, data };
}

// The grid importer's importItems() (faphouse_grid_importer.js) already
// resolves direct_url in-tab before sending FAPHOUSE_IMPORT_BULK — the
// dashboard server has no logged-in Faphouse session, so unlike most other
// *_IMPORT_BULK handlers this one must NOT re-send the bare watch-page url
// as the import target; direct_url is what actually gets fetched.
async function nexusFaphouseImportBulk({ items, batchName }) {
    const list = Array.isArray(items) ? items : [];
    const videos = list
        .map((raw) => {
            const sourceUrl = String(raw?.source_url || raw?.url || "").trim();
            const directUrl = String(raw?.direct_url || "").trim();
            if (!sourceUrl || !directUrl) return null;
            return {
                url: directUrl,
                title: String(raw?.title || "Faphouse Video").trim() || "Faphouse Video",
                source_url: sourceUrl,
                direct_url: directUrl,
                thumbnail: raw?.thumbnail || null,
                duration: Number(raw?.duration || 0) || 0,
                quality: String(raw?.quality || "").trim() || undefined,
                tags: "faphouse",
            };
        })
        .filter(Boolean);

    if (!videos.length) throw new Error("No Faphouse videos were prepared for import");

    const baseUrl = await findDashboardUrl();
    const targetUrl = `${baseUrl}/api/v1/import/bulk`;
    const resp = await fetch(targetUrl, {
        method: "POST",
        headers: await buildLocalApiHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
            batch_name: String(batchName || "Faphouse Import").trim() || "Faphouse Import",
            videos,
        }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        const detail = data.detail || data.error || data.message || "";
        if (resp.status === 404) {
            throw new Error("Nexus na tomto porte nemá import API. Reštartni LITE/dashboard (potrebuje /api/v1/import/bulk).");
        }
        throw new Error(detail || `Nexus returned ${resp.status}`);
    }
    return { imported: videos.length, requested: list.length, count: data.count || videos.length, data };
}

async function nexusFuqImportBulk({ items, batchName }) {
    const list = Array.isArray(items) ? items : [];
    const videos = list
        .map((raw) => {
            const sourceUrl = String(raw?.source_url || raw?.url || "").trim();
            const importUrl = String(raw?.url || sourceUrl).trim();
            if (!sourceUrl || !importUrl) return null;
            const tags = Array.isArray(raw?.tags) ? raw.tags : [];
            const mergedTags = Array.from(new Set(tags.map((t) => String(t || "").trim()).filter(Boolean)));
            return {
                url: importUrl,
                title: String(raw?.title || "Fuq Video").trim() || "Fuq Video",
                source_url: sourceUrl,
                thumbnail: raw?.thumbnail || null,
                duration: Number(raw?.duration || 0) || 0,
                width: Number(raw?.width || 0) || 0,
                height: Number(raw?.height || 0) || 0,
                quality: String(raw?.quality || "").trim() || undefined,
                tags: mergedTags.length ? mergedTags.join(",") : "fuq",
            };
        })
        .filter(Boolean);

    if (!videos.length) throw new Error("No Fuq videos were prepared for import");

    const baseUrl = await findDashboardUrl();
    const targetUrl = `${baseUrl}/api/v1/import/bulk`;
    const resp = await fetch(targetUrl, {
        method: "POST",
        headers: await buildLocalApiHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
            batch_name: String(batchName || "Fuq Quick Import").trim() || "Fuq Quick Import",
            videos,
        }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `Nexus returned ${resp.status}`);
    return { imported: videos.length, requested: list.length, data };
}


function mergeCapturedStreamForTab(tabId, candidateUrl) {
    const cand = String(candidateUrl || "").trim();
    if (!cand) return;
    const prev = String(capturedStreams.get(tabId) || "").trim();
    const next = choosePreferredCapturedStream("", prev, cand);
    capturedStreams.set(tabId, next);
}

function isFilesterFilePageUrl(rawUrl) {
    try {
        const parsed = new URL(String(rawUrl || "").trim());
        return /(?:^|\.)filester\.(?:me|gg|net|co|org|io)$/i.test(parsed.hostname)
            && /^\/d\/[A-Za-z0-9_-]+\/?$/i.test(parsed.pathname);
    } catch {
        return false;
    }
}

function isFilesterPlaybackUrl(rawUrl) {
    const value = String(rawUrl || "").trim();
    if (!value || isFilesterFilePageUrl(value)) return false;
    try {
        const parsed = new URL(value);
        if (/^fsc\d*\.cdn\.cr$/i.test(parsed.hostname) && /\/v\d*\//i.test(parsed.pathname)) return true;
        if (/(?:^|\.)filester\.(?:me|gg|net|co|org|io)$/i.test(parsed.hostname)
            && !/^\/(?:d|f)\//i.test(parsed.pathname)
            && /\/(?:v|video|stream)\//i.test(parsed.pathname)) return true;
    } catch { }
    return /\.(?:mp4|m3u8|mpd|webm|mkv|mov|m4v)(?:[?#]|$)/i.test(value)
        && !/(?:thumb|preview|sample|trailer)/i.test(value);
}

async function resolveFilesterViaBridge(pageUrl) {
    const base = await findDashboardUrl();
    const headers = await buildLocalApiHeaders({ "Content-Type": "application/json" });
    const response = await fetch(`${base}/api/v1/bridge/filester/resolve`, {
        method: "POST",
        headers,
        body: JSON.stringify({ url: pageUrl }),
        signal: AbortSignal.timeout(9000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.ok || !isFilesterPlaybackUrl(data.stream_url)) {
        return { ok: false, error: data?.detail || data?.error || `Nexus HTTP ${response.status}` };
    }
    return { ok: true, ...data, resolver: "nexus-backend" };
}

async function resolveFilesterViaTempTab(pageUrl) {
    let tabId = null;
    let createdTab = false;
    try {
        const normalized = normalizeCaptureWatchPageUrl(pageUrl);
        const tabs = await chrome.tabs.query({});
        const existing = tabs.find((tab) => normalizeCaptureWatchPageUrl(tab?.url || "") === normalized);
        if (existing?.id) {
            tabId = existing.id;
        } else {
            const created = await chrome.tabs.create({ url: pageUrl, active: false });
            tabId = created?.id || null;
            createdTab = !!tabId;
        }
        if (!Number.isInteger(tabId)) return { ok: false, error: "Filester kartu sa nepodarilo otvoriť" };

        let metadata = {};
        for (let attempt = 0; attempt < 20; attempt += 1) {
            if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500));
            let candidate = String(capturedStreams.get(tabId) || "").trim();
            try {
                const injected = await chrome.scripting.executeScript({
                    target: { tabId },
                    func: () => {
                        const video = document.querySelector("video");
                        if (video) {
                            video.muted = true;
                            video.preload = "auto";
                            video.play().catch(() => { });
                        }
                        const values = [];
                        const add = (value) => {
                            const text = String(value || "").trim();
                            if (text && !values.includes(text)) values.push(text);
                        };
                        document.querySelectorAll("video, video source, source[type^='video']").forEach((node) => {
                            add(node.currentSrc);
                            add(node.src);
                            add(node.getAttribute?.("src"));
                            add(node.getAttribute?.("data-src"));
                        });
                        performance.getEntriesByType("resource").forEach((entry) => add(entry?.name));
                        return {
                            candidates: values,
                            title: String(document.querySelector("meta[property='og:title']")?.content || document.title || "").trim(),
                            thumbnail: String(document.querySelector("meta[property='og:image']")?.content || video?.poster || "").trim(),
                            duration: Number(video?.duration || 0) || 0,
                            width: Number(video?.videoWidth || 0) || 0,
                            height: Number(video?.videoHeight || 0) || 0,
                        };
                    },
                });
                const result = injected?.[0]?.result || {};
                metadata = { ...metadata, ...result };
                for (const value of result.candidates || []) {
                    if (isFilesterPlaybackUrl(value)) {
                        candidate = choosePreferredCapturedStream(pageUrl, candidate, value);
                    }
                }
            } catch { }

            if (isFilesterPlaybackUrl(candidate)) {
                await reportCapturedStream(pageUrl, candidate, metadata.title || "").catch(() => { });
                return {
                    ok: true,
                    stream_url: candidate,
                    title: metadata.title || "",
                    thumbnail: metadata.thumbnail || "",
                    duration: Number(metadata.duration || 0) || 0,
                    width: Number(metadata.width || 0) || 0,
                    height: Number(metadata.height || 0) || 0,
                    resolver: createdTab ? "temporary-browser-tab" : "open-browser-tab",
                };
            }
        }
        return { ok: false, error: "Filester nevydal prehrateľný stream" };
    } finally {
        if (createdTab && Number.isInteger(tabId)) {
            await chrome.tabs.remove(tabId).catch(() => { });
        }
    }
}

chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        let mediaUrl = details.url || "";
        if (!isMediaUrl(mediaUrl)) return;

        // Requests from service workers/background/preloads can have tabId = -1.
        // chrome.tabs.get requires a non-negative tab ID.
        if (!Number.isInteger(details.tabId) || details.tabId < 0) return;
        const isMegaChunk = isMegaUserStorageUrl(mediaUrl);

        // Extract real manifest from JW Player ping URL if detected
        if (mediaUrl.includes('ping.gif') && mediaUrl.includes('mu=')) {
            try {
                const muMatch = mediaUrl.match(/[?&]mu=([^&]+)/);
                if (muMatch) {
                    const decoded = decodeURIComponent(muMatch[1]);
                    console.log(`[StreamCapture] Extracted real manifest from ping URL: ${decoded}`);
                    mediaUrl = decoded;
                }
            } catch (e) {
                console.error('[StreamCapture] Failed to parse ping URL', e);
            }
        }

        if (isObviouslyNonPlayableCaptureUrl(mediaUrl)) return;

        if (isMegaChunk) {
            chrome.tabs.get(details.tabId, (tab) => {
                if (chrome.runtime.lastError || !tab) return;
                rememberMegaChunk(details.tabId, mediaUrl, tab.url || "", tab.title || "");
            });
            return;
        }

        // Universal Importer logic: capture latest stream for ANY tab
        const isSegment = /seg-\d+-v\d+|\.ts(\?|$)|\.m4s(\?|$)|\/segment\//i.test(mediaUrl);
        if (!isSegment && !mediaUrl.includes('ads') && !mediaUrl.includes('telemetry')) {
            mergeCapturedStreamForTab(details.tabId, mediaUrl);
        }

        chrome.tabs.get(details.tabId, (tab) => {
            if (chrome.runtime.lastError || !tab) return;
            const pageUrl = tab.url || "";
            const title = tab.title || "";
            if (!isSupportedHost(pageUrl)) return;

            // Skip if the media URL itself is just the page (some sites do this)
            if (mediaUrl.split('?')[0] === pageUrl.split('?')[0]) return;

            reportCapturedStream(pageUrl, mediaUrl, title);
        });
    },
    { urls: ["<all_urls>"] },
    []
);

// Retain the size reported by real media responses. This remains usable when
// a separate extension fetch is denied even though page playback succeeds.
let mediaSizeWrites = Promise.resolve();
chrome.webRequest.onHeadersReceived.addListener(details => {
    if (details.tabId < 0 || ![200, 206].includes(details.statusCode)) return;
    const headers = details.responseHeaders || [];
    const get = name => headers.find(h => String(h.name).toLowerCase() === name)?.value || "";
    const contentType = get("content-type");
    if (!/^video\//i.test(contentType) && !(/application\/octet-stream/i.test(contentType) && /\.mp4(?:[?#]|$)|\/video\/play\?/i.test(details.url))) return;
    const total = Number(get("content-range").match(/\/(\d+)\s*$/)?.[1] || 0);
    const length = total || (details.statusCode === 200 ? Number(get("content-length")) : 0);
    if (!Number.isSafeInteger(length) || length <= 0) return;
    mediaSizeWrites = mediaSizeWrites.catch(() => {}).then(async () => {
        const saved = await chrome.storage.session.get("nexus_media_sizes");
        const entries = Object.entries(saved.nexus_media_sizes || {})
            .filter(([key, entry]) => key !== details.url && Date.now() - entry.ts < 30 * 60 * 1000)
            .sort((a, b) => b[1].ts - a[1].ts).slice(0, 99);
        const sizes = Object.fromEntries(entries);
        sizes[details.url] = { contentLength: length, contentType, ts: Date.now() };
        await chrome.storage.session.set({ nexus_media_sizes: sizes });
        await chrome.tabs.sendMessage(details.tabId, {
            action: "MEDIA_SIZE_OBSERVED", url: details.url, sizeBytes: length,
        }).catch(() => {});
    });
}, { urls: ["<all_urls>"] }, ["responseHeaders"]);

// vTube's player often feeds MediaSource with a ``blob:`` URL.  In that
// layout the direct request has no .mp4/.m3u8 suffix, so onBeforeRequest
// above deliberately ignores it.  Response headers are the reliable signal:
// only retain a request made by a vTube watch tab when the server explicitly
// declares media content.  This runs before the page turns the response into
// an opaque blob URL.
chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
        if (!Number.isInteger(details.tabId) || details.tabId < 0) return;
        const contentType = (details.responseHeaders || []).find(
            (header) => String(header.name || "").toLowerCase() === "content-type"
        )?.value || "";
        if (!/^(?:video|audio)\//i.test(contentType)) return;

        chrome.tabs.get(details.tabId, (tab) => {
            if (chrome.runtime.lastError || !tab || !/https?:\/\/(?:[^/]+\.)?vtbe\.to(?:[/:?#]|$)/i.test(tab.url || "")) return;
            const mediaUrl = String(details.url || "").trim();
            if (!/^https?:\/\//i.test(mediaUrl)) return;
            mergeCapturedStreamForTab(details.tabId, mediaUrl);
            reportCapturedStream(tab.url || "", mediaUrl, tab.title || "");
        });
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
);

// Clean up on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
    capturedStreams.delete(tabId);
    megaCaptures.delete(tabId);
    chrome.storage.local.remove(`mega_capture_${tabId}`).catch(() => { });
    baeBridgeTabState.delete(tabId);
    for (const [requestId, pending] of baeBridgePending.entries()) {
        if (pending.tabId !== tabId) continue;
        clearTimeout(pending.timeout);
        pending.reject(new Error("Bridge tab was closed"));
        baeBridgePending.delete(requestId);
    }
});

async function resolveInternetChicksPlayer(embedUrl) {
    const embed = new URL(embedUrl);
    if (!/^https?:$/.test(embed.protocol) || !/^(?:streamtape\.com|www\.streamtape\.com)$/i.test(embed.hostname)
        || !/^\/e\/[a-z0-9_-]+\/?$/i.test(embed.pathname)) return null;
    const response = await fetch(embed.href, { credentials: 'include', signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    const html = await response.text();
    // The visible botlink has a decoy token. Only reconstruct the literal
    // expression assigned by the player, without executing provider script.
    for (const match of html.matchAll(/(?:robotlink|ideoolink|botlink)['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"]\s*\+\s*(?:['"]{2}\s*\+\s*)?\(['"]([^'"]+\?id=[^'"]+)['"]\)((?:\.substring\(\d+\))+)/gi)) {
        let suffix = match[2];
        for (const part of match[3].matchAll(/\.substring\((\d+)\)/g)) suffix = suffix.substring(Number(part[1]));
        try {
            const full = `${match[1]}${suffix}`;
            if (!full.startsWith('//')) continue;
            const url = new URL(`https:${full}`);
            if (!/^(?:streamtape\.com|www\.streamtape\.com)$/i.test(url.hostname) || url.pathname !== '/get_video') continue;
            const head = await fetch(url.href, { method: 'HEAD', credentials: 'include', signal: AbortSignal.timeout(10000) });
            if (!head.ok || !/^video\//i.test(head.headers.get('content-type') || '')) continue;
            return { streamUrl: url.href, sizeBytes: Number(head.headers.get('content-length') || 0) };
        } catch { }
    }
    return null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'INTERNETCHICKS_RESOLVE_PLAYER') {
        const sourceHost = (() => { try { return new URL(sender.tab?.url || sender.url).hostname; } catch { return ''; } })();
        if (!/(^|\.)internetchicks\.com$/i.test(sourceHost)) {
            sendResponse({ ok: false, error: 'Invalid source page' });
            return false;
        }
        resolveInternetChicksPlayer(String(msg.embedUrl || ''))
            .then(result => sendResponse(result ? { ok: true, ...result } : { ok: false, error: 'Stream not verified' }))
            .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
        return true;
    }
    if (msg.action === "QUALITY_FIND_HIGHEST") {
        const tabId = sender.tab?.id;
        const frameId = sender.frameId;
        if (!Number.isInteger(tabId) || !Number.isInteger(frameId) || !/^https?:\/\//i.test(sender.url || "")) {
            sendResponse({ ok: false, error: "Video player frame unavailable" });
            return false;
        }
        const executeQualityProbe = (target) => chrome.scripting.executeScript({
            target,
            world: "MAIN",
            func: async () => {
                // Bound every frame's probe. Some players expose many levels
                // but never acknowledge a switch; an unbounded per-level wait
                // made the Fast Import button look stuck for tens of seconds.
                const searchDeadline = Date.now() + 8500;
                const nextProbeDeadline = () => Math.min(Date.now() + 2200, searchDeadline);
                const heightOf = value => {
                    const text = String(value || "");
                    if (/\b8k\b/i.test(text)) return 4320;
                    if (/4k|uhd/i.test(text)) return 2160;
                    if (/\b2k\b/i.test(text)) return 1440;
                    if (/fhd/i.test(text)) return 1080;
                    return Number(text.match(/(?:^|\D)(4320|2160|1440|1280|1080|720|480|360|240)\s*p?(?=\D|$)/i)?.[1] || 0);
                };
                const videoNodes = [...document.querySelectorAll("video")]
                    .filter(video => !video.closest(".nexus-import-overlay, .nexus-hunt-modal"))
                    .map(video => ({ video, area: (video.getBoundingClientRect().width || 0) * (video.getBoundingClientRect().height || 0) }))
                    .sort((a, b) => b.area - a.area);
                const mainVideo = videoNodes[0]?.video || null;
                const area = videoNodes[0]?.area || 0;
                // KVS exposes its full rendition ladder in conf, not in native
                // <source> tags or JWPlayer/Video.js APIs. PimpBunny and
                // PornTrex both use this contract and data-format menu anchors.
                const kvs = window.player_obj;
                if (kvs?.conf && typeof kvs.container === "function" && typeof kvs.play === "function") {
                    const root = kvs.container();
                    let video = root?.querySelector?.("video") || mainVideo;
                    const levels = Object.entries(kvs.conf)
                        .filter(([key, url]) => /^video_(?:alt_)?url\d*$/.test(key) && typeof url === "string" && /^https?:\/\//i.test(url))
                        .map(([key, url]) => ({ url, label: String(kvs.conf[`${key}_text`] || ""), height: heightOf(kvs.conf[`${key}_text`] || url) }))
                        .filter(level => level.height > 0 && !/preview|upgrade/i.test(level.url))
                        .sort((a, b) => b.height - a.height);
                    if (video && levels.length) {
                        const target = levels[0];
                        const before = { src: video.currentSrc || video.src || "", time: Number(video.currentTime || 0), height: Number(video.videoHeight || 0) };
                        const pauseBriefly = () => new Promise(resolve => setTimeout(resolve, 150));
                        const startPlayback = () => {
                            // KVS can leave the engine in its preroll state when
                            // an ad request is blocked by the browser. Skip the
                            // ad state before asking the selected rendition to
                            // play; this keeps quality probing independent of
                            // third-party ad scripts.
                            try { kvs.skip_preroll?.(); } catch { }
                            try { kvs.skip_postroll?.(); } catch { }
                            try { kvs.play(); } catch { }
                            // A play() promise can remain pending indefinitely
                            // during a blocked VAST ad. Never await it unbounded.
                            try {
                                const attempt = video.play();
                                attempt?.catch?.(error => {
                                    if (error?.name === "NotAllowedError") {
                                        video.muted = true;
                                        try { video.play()?.catch?.(() => {}); } catch { }
                                    }
                                });
                            } catch { }
                        };
                        startPlayback();
                        let menuItem;
                        const menuDeadline = Math.min(Date.now() + 1600, searchDeadline);
                        do {
                            menuItem = [...(root?.querySelectorAll?.(".fp-settings-list a[data-format]") || [])]
                                .find(element => heightOf(element.textContent) === target.height);
                            if (menuItem || Date.now() >= menuDeadline) break;
                            await pauseBriefly();
                        } while (Date.now() < menuDeadline);
                        if (menuItem) {
                            // Click the exact data-format anchor even while its
                            // menu is collapsed. KVS preserves time and its menu.
                            menuItem.click();
                            try { kvs.skip_preroll?.(); } catch { }
                            startPlayback();
                        } else {
                            // Public KVS API fallback for a not-yet-rendered menu.
                            // Use only an actual signed URL from this player.
                            try { kvs.play(target.url); } catch { }
                            startPlayback();
                        }
                        const deadline = Math.min(Date.now() + 5500, searchDeadline);
                        while (Date.now() < deadline) {
                            await pauseBriefly();
                            // Flowplayer can replace its HTML5 engine on load.
                            // Verify the live element, not the discarded source.
                            video = root?.querySelector?.("video.fp-engine, video") || video;
                            const src = String(video.currentSrc || video.src || "");
                            const activeItem = root?.querySelector?.(".fp-settings-list .is-selected a[data-format]");
                            const selected = src === target.url ||
                                (heightOf(activeItem?.textContent) === target.height && src !== before.src);
                            const observed = Number(video.videoHeight || 0);
                            if (selected && !video.paused && video.readyState >= 2 && observed >= target.height * 0.94) {
                                if (!menuItem && before.time > 0 && before.time < video.duration) {
                                    try { video.currentTime = before.time; } catch { }
                                }
                                return { status: "verified", current: target.height, highest: target.height, measuredHeight: observed, levels, area, url: src, provider: "kvs" };
                            }
                        }
                        return { status: "unverified", current: before.height, highest: target.height, levels, area, provider: "kvs" };
                    }
                }
                const factory = window.jwplayer;
                if (typeof factory === "function") {
                    const ids = [];
                    for (let node = mainVideo; node && ids.length < 8; node = node.parentElement) if (node.id) ids.push(node.id);
                    for (const node of document.querySelectorAll(".jwplayer[id], [id='player_box'], [id^='player_']")) if (node.id && !ids.includes(node.id)) ids.push(node.id);
                    ids.push("");
                    for (const id of ids) {
                        let player;
                        try { player = id ? factory(id) : factory(); } catch { continue; }
                        if (!player || typeof player.getQualityLevels !== "function" || typeof player.setCurrentQuality !== "function") continue;
                        let levels = [], currentIndex = -1;
                        try { levels = player.getQualityLevels() || []; currentIndex = Number(player.getCurrentQuality?.()); } catch { continue; }
                        const entries = levels.map((level, index) => {
                            const label = String(level?.label || level?.name || "");
                            return { index, height: heightOf(label) || Number(level?.height || level?.res || 0), label };
                        }).filter(item => item.height > 0);
                        if (!entries.length) continue;
                        const highest = entries.reduce((best, item) => item.height > best.height ? item : best);
                        const current = entries.find(item => item.index === currentIndex);
                        const video = player.getContainer?.()?.querySelector?.("video") || mainVideo;
                        const priorHeight = Number(video?.videoHeight || 0);
                        try { if (player.getState?.() !== "playing") player.play(true); } catch { }
                        for (const level of [...entries].sort((a, b) => b.height - a.height)) {
                            try { player.setCurrentQuality(level.index); } catch { continue; }
                            const deadline = nextProbeDeadline();
                            let observed = 0;
                            while (Date.now() < deadline) {
                                await new Promise(resolve => setTimeout(resolve, 200));
                                try {
                                    const selected = Number(player.getCurrentQuality?.());
                                    observed = Number(video?.videoHeight || 0);
                                    if (selected === level.index && player.getState?.() === "playing" && video?.readyState >= 2 && observed >= level.height * 0.94) {
                                        return { status: level.height >= highest.height ? "verified" : "lower", current: observed, highest: highest.height, levels: entries, area };
                                    }
                                } catch { }
                            }
                            if (observed >= level.height * 0.94 && observed >= priorHeight * 0.94 && level.height === highest.height) {
                                return { status: "verified", current: observed, highest: highest.height, levels: entries, area };
                            }
                        }
                        try { player.setCurrentQuality(current?.index ?? highest.index); if (player.getState?.() !== "playing") player.play(true); } catch { }
                        return { status: "unverified", current: priorHeight || current?.height || 0, highest: highest.height, levels: entries, area };
                    }
                }

                // Video.js quality-level plugins are common on KVS-backed
                // sites (including PimpBunny). Keep this provider-agnostic:
                // use the player's public quality API when available.
                try {
                    const players = typeof window.videojs?.getPlayers === "function"
                        ? Object.values(window.videojs.getPlayers()) : [];
                    for (const player of players) {
                        const list = player?.qualityLevels?.();
                        if (!list || !Number.isFinite(Number(list.length))) continue;
                        const levels = Array.from({ length: Number(list.length) }, (_, index) => {
                            const level = list[index];
                            return { index, ref: level, height: Number(level?.height || 0), label: `${level?.height || 0}p` };
                        }).filter(level => level.height > 0);
                        if (!levels.length) continue;
                        const highest = Math.max(...levels.map(level => level.height));
                        const video = player.el?.()?.querySelector?.("video") || mainVideo;
                        const priorHeight = Number(video?.videoHeight || 0);
                        try { player.play(); } catch { }
                        for (const level of levels.sort((a, b) => b.height - a.height)) {
                            if (Date.now() >= searchDeadline) break;
                            for (const candidate of levels) {
                                try { candidate.ref.enabled = candidate.index === level.index; } catch { }
                            }
                            const deadline = nextProbeDeadline();
                            while (Date.now() < deadline) {
                                await new Promise(resolve => setTimeout(resolve, 200));
                                const observed = Number(video?.videoHeight || 0);
                                if (!video?.paused && video?.readyState >= 2 && observed >= level.height * 0.94) {
                                    return { status: level.height >= highest ? "verified" : "lower", current: observed, highest, levels: levels.map(({ index, height, label }) => ({ index, height, label })), area };
                                }
                            }
                        }
                        return { status: "unverified", current: priorHeight, highest, levels: levels.map(({ index, height, label }) => ({ index, height, label })), area };
                    }
                } catch { }

                // Some players expose their rendition menu only in the page
                // controls. Select a clearly labelled resolution option only
                // inside the active player's DOM; do not click generic page
                // buttons or guess from unrelated text.
                if (mainVideo) {
                    const playerRoot = mainVideo.closest(".jwplayer, .video-js, .plyr, [class*='player'], [id*='player']") || mainVideo.parentElement;
                    const qualityOptions = [...(playerRoot || document).querySelectorAll("button, [role='menuitem'], [role='option'], option, li, a, div, span")]
                        .map(element => {
                            const label = `${element.textContent || ""} ${element.getAttribute("aria-label") || ""} ${element.title || ""} ${element.getAttribute("data-quality") || ""}`.trim();
                            const match = label.match(/(?:^|\D)(2160|1440|1080|720|480|360|240)\s*p?(?:\D|$)/i);
                            return { element, label, height: Number(match?.[1] || 0) };
                        })
                        .filter(option => option.height > 0 && option.label.length <= 48 && option.element.getClientRects().length)
                        // Player menus often use plain div/span rows instead of
                        // semantic buttons. Keep the deepest matching node so
                        // clicking it bubbles through the player's own handler.
                        .filter(option => ![...option.element.querySelectorAll("button, [role='menuitem'], [role='option'], option, li, a, div, span")]
                            .some(child => child !== option.element && child.getClientRects().length &&
                                `${child.textContent || ""} ${child.getAttribute("aria-label") || ""} ${child.title || ""} ${child.getAttribute("data-quality") || ""}`.trim().length <= 48 &&
                                new RegExp(`(?:^|\\D)${option.height}\\s*p?(?:\\D|$)`, "i").test(`${child.textContent || ""} ${child.getAttribute("aria-label") || ""} ${child.title || ""} ${child.getAttribute("data-quality") || ""}`)));
                    if (qualityOptions.length > 1) {
                        const highest = Math.max(...qualityOptions.map(option => option.height));
                        const option = qualityOptions.filter(item => item.height === highest).at(-1);
                        try { option.element.click(); } catch { }
                        try { if (mainVideo.paused) await mainVideo.play(); } catch { }
                        const deadline = nextProbeDeadline();
                        while (Date.now() < deadline) {
                            await new Promise(resolve => setTimeout(resolve, 200));
                            const observed = Number(mainVideo.videoHeight || 0);
                            if (!mainVideo.paused && mainVideo.readyState >= 2 && observed >= highest * 0.94) {
                                return { status: "verified", current: observed, highest, levels: qualityOptions.map(item => ({ height: item.height, label: item.label })), area };
                            }
                        }
                        return { status: "unverified", current: Number(mainVideo.videoHeight || 0), highest, levels: qualityOptions.map(item => ({ height: item.height, label: item.label })), area };
                    }
                }

                if (!mainVideo) return { status: "unknown", current: 0, highest: 0, levels: [], area };
                const originals = {
                    src: String(mainVideo.currentSrc || mainVideo.src || ""),
                    time: Number(mainVideo.currentTime || 0),
                    paused: !!mainVideo.paused,
                };
                const sources = [...mainVideo.querySelectorAll("source[src]")].map(source => ({
                    url: source.src,
                    height: heightOf(`${source.label || ""} ${source.getAttribute("title") || ""} ${source.src}`),
                    label: source.label || source.getAttribute("title") || "",
                })).filter(source => source.height > 0 && source.url);
                if (!sources.length) return { status: "unknown", current: Number(mainVideo.videoHeight || 0), highest: 0, levels: [], area };
                const highest = Math.max(...sources.map(source => source.height));
                for (const source of sources.sort((a, b) => b.height - a.height)) {
                    if (Date.now() >= searchDeadline) break;
                    try {
                        mainVideo.src = source.url;
                        mainVideo.load();
                        await mainVideo.play().catch(() => {});
                    } catch { continue; }
                    const deadline = nextProbeDeadline();
                    while (Date.now() < deadline) {
                        await new Promise(resolve => setTimeout(resolve, 200));
                        if (!mainVideo.paused && mainVideo.readyState >= 2 && mainVideo.videoHeight >= source.height * 0.94) {
                            if (originals.time > 0 && Number.isFinite(mainVideo.duration) && originals.time < mainVideo.duration) {
                                try { mainVideo.currentTime = originals.time; } catch { }
                            }
                            return { status: source.height >= highest ? "verified" : "lower", current: mainVideo.videoHeight, highest, levels: sources, area };
                        }
                    }
                }
                try {
                    if (originals.src) { mainVideo.src = originals.src; mainVideo.load(); }
                    if (originals.time > 0) mainVideo.currentTime = originals.time;
                    if (!originals.paused) await mainVideo.play().catch(() => {});
                } catch { }
                return { status: "unverified", current: Number(mainVideo.videoHeight || 0), highest, levels: sources, area };
            },
        });
        executeQualityProbe({ tabId, frameIds: [frameId] }).then(results => {
            const candidates = (results || []).map(item => item.result).filter(result => result && result.status !== "unknown");
            candidates.sort((a, b) => (a.status === "verified" ? 1 : 0) - (b.status === "verified" ? 1 : 0) || Number(a.area || 0) - Number(b.area || 0) || Number(a.current || 0) - Number(b.current || 0));
            sendResponse({ ok: true, result: candidates.at(-1) || { status: "unknown", current: 0, highest: 0, levels: [] } });
        })
          .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
        return true;
    }

    if (msg.action === "FILESTER_RESOLVE_STREAM") {
        (async () => {
            const pageUrl = String(msg.pageUrl || "").trim();
            if (!isFilesterFilePageUrl(pageUrl)) {
                sendResponse({ ok: false, error: "Neplatná Filester file URL" });
                return;
            }

            let backendError = "";
            try {
                const backend = await resolveFilesterViaBridge(pageUrl);
                if (backend?.ok) {
                    await reportCapturedStream(pageUrl, backend.stream_url, backend.title || "").catch(() => { });
                    sendResponse(backend);
                    return;
                }
                backendError = backend?.error || "";
            } catch (error) {
                backendError = error?.message || String(error);
            }

            const browser = await resolveFilesterViaTempTab(pageUrl);
            if (browser?.ok) {
                sendResponse(browser);
                return;
            }
            sendResponse({
                ok: false,
                error: browser?.error || backendError || "Filester stream sa nepodarilo nájsť",
                backendError,
            });
        })().catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
        return true;
    }

    if (msg.action === "OPEN_EXPLORER_FOR_TAB") {
        (async () => {
            const tab = sender?.tab?.id ? sender.tab : await chrome.tabs.get(sender.tab?.id || 0).catch(() => null);
            if (!tab?.id) {
                sendResponse({ ok: false, error: "No source tab" });
                return;
            }
            const context = await rememberExplorerContext(tab);
            const windowId = await focusOrCreateExplorerWindow(context);
            sendResponse({ ok: true, windowId: windowId || null, tabId: tab.id });
        })().catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
        return true;
    }

    if (msg.action === "PORNHOARDER_RESOLVE_BATCH") {
        // Open each PornHoarder watch page in a hidden tab so the bundled
        // interceptors capture the real stream and POST it to update_stream.
        // Runs in the background so it survives the popup closing.
        (async () => {
            const urls = Array.isArray(msg.urls) ? msg.urls.filter(u =>
                /pornhoarder\.(?:io|net|pictures|tv)\/(?:watch|pornvideo)\//i.test(String(u || ''))) : [];
            if (!urls.length) { sendResponse({ ok: true, resolved: 0 }); return; }

            const CONCURRENCY = 2;
            const PER_TAB_MS = 12000;
            const HARD_CAP_MS = PER_TAB_MS + 8000;
            let done = 0;

            const resolveOne = (watchUrl) => new Promise((resolve) => {
                let tabId = null;
                let listener = null;
                let settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    if (listener) { try { chrome.tabs.onUpdated.removeListener(listener); } catch { } }
                    if (tabId) { try { chrome.tabs.remove(tabId); } catch { } }
                    resolve();
                };
                try {
                    chrome.tabs.create({ url: watchUrl, active: false }, (tab) => {
                        tabId = tab?.id || null;
                        if (!tabId) { finish(); return; }
                        listener = (updatedTabId, changeInfo) => {
                            if (updatedTabId === tabId && changeInfo.status === 'complete') {
                                setTimeout(finish, PER_TAB_MS);
                            }
                        };
                        chrome.tabs.onUpdated.addListener(listener);
                        setTimeout(finish, HARD_CAP_MS);
                    });
                } catch (e) {
                    console.warn('[PornHoarder] bg temp-tab failed', watchUrl, e);
                    finish();
                }
            });

            const queue = [...urls];
            const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
                while (queue.length) {
                    await resolveOne(queue.shift());
                    done += 1;
                }
            });
            await Promise.all(workers);
            sendResponse({ ok: true, resolved: done });
        })().catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === "CAPTURE_VISIBLE_TAB") {
        (async () => {
            try {
                const winId = sender?.tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
                const dataUrl = await chrome.tabs.captureVisibleTab(winId, { format: "jpeg", quality: 82 });
                if (!dataUrl || !dataUrl.startsWith("data:image/")) {
                    sendResponse({ ok: false, error: "empty capture" });
                    return;
                }
                sendResponse({ ok: true, dataUrl });
            } catch (e) {
                sendResponse({ ok: false, error: e?.message || String(e) });
            }
        })();
        return true;
    }

    if (msg.action === "FETCH_IMAGE_AS_DATAURL") {
        (async () => {
            try {
                const headers = { "User-Agent": "Mozilla/5.0" };
                if (msg.referer) headers.Referer = msg.referer;
                let resp;
                try {
                    resp = await fetch(msg.url, { credentials: "omit", headers });
                } catch (_) {
                    resp = null;
                }
                if (!resp || !resp.ok) {
                    resp = await fetch(msg.url, { credentials: "omit" });
                }
                if (!resp.ok) { sendResponse({ ok: false, error: resp.status }); return; }
                const blob = await resp.blob();
                const reader = new FileReader();
                reader.onloadend = () => {
                    const dataUrl = reader.result;
                    if (String(msg.url || '').includes('/api/v1/proxy')) {
                        fetch('http://127.0.0.1:7563/ingest/816815cd-9634-47af-8cd6-179216ffa642',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'ab7dcd'},body:JSON.stringify({sessionId:'ab7dcd',hypothesisId:'H7',location:'background.js:thumb',message:'proxy thumb',data:{ok:true,bytes:String(dataUrl||'').length},timestamp:Date.now()})}).catch(()=>{});
                    }
                    sendResponse({ ok: true, dataUrl });
                };
                reader.onerror = () => sendResponse({ ok: false, error: "reader error" });
                reader.readAsDataURL(blob);
            } catch (e) {
                sendResponse({ ok: false, error: String(e) });
            }
        })();
        return true;
    }

    if (msg.action === "FETCH_VIDEO_CHUNK_BASE64") {
        (async () => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000);
                const response = await fetch(msg.url, {
                    headers: { 'Range': 'bytes=0-1500000' },
                    credentials: 'omit',
                    signal: controller.signal
                });
                if (!response.ok && response.status !== 206) throw new Error("Fetch failed");
                const blob = await response.blob();
                clearTimeout(timeoutId);
                const reader = new FileReader();
                reader.onloadend = () => {
                    sendResponse({ ok: true, dataUrl: reader.result });
                };
                reader.onerror = () => sendResponse({ ok: false, error: "Failed to read blob" });
                reader.readAsDataURL(blob);
            } catch (err) {
                sendResponse({ ok: false, error: err.message });
            }
        })();
        return true;
    }

    if (msg.action === "BAE_BRIDGE_PAGE_MESSAGE") {
        const bridgeMessage = msg.message;
        const tabId = sender.tab?.id || 0;
        if (!tabId || !isBaeBridgeEnvelope(bridgeMessage, "bae-userscript")) {
            baeBridgeLog("page-invalid", {
                tabId,
                hasMessage: !!bridgeMessage,
                requestId: bridgeMessage?.requestId || "",
                type: bridgeMessage?.type || "",
            });
            sendResponse({ ok: false, error: "invalid-page-message" });
            return false;
        }

        if (bridgeMessage.type === "BAE_BRIDGE_READY") {
            rememberBaeBridgeState(tabId, {
                detected: true,
                ready: !!bridgeMessage.payload?.ready,
                status: "Ready",
                capabilities: Array.isArray(bridgeMessage.payload?.capabilities) ? bridgeMessage.payload.capabilities : [],
                lastError: "",
            });
            chrome.runtime.sendMessage({
                action: "BAE_BRIDGE_EVENT",
                tabId,
                message: bridgeMessage,
            }).catch(() => { });
            sendResponse({ ok: true, kind: "ready" });
            return false;
        }

        rememberBaeBridgeState(tabId, {
            detected: true,
            ready: true,
            status: bridgeMessage.type === "BAE_ERROR" ? "Error" : "Ready",
            lastError: bridgeMessage.type === "BAE_ERROR" ? (bridgeMessage.payload?.message || "") : "",
        });

        if (bridgeMessage.type === "BAE_FETCH_PROGRESS") {
            baeBridgeLog("progress", {
                tabId,
                requestId: bridgeMessage.requestId,
                stage: bridgeMessage.payload?.stage || "",
                pendingSize: baeBridgePending.size,
            });
            chrome.runtime.sendMessage({
                action: "BAE_BRIDGE_EVENT",
                tabId,
                message: bridgeMessage,
            }).catch(() => { });
            sendResponse({ ok: true, kind: "progress" });
            return false;
        }

        const pending = baeBridgePending.get(bridgeMessage.requestId);
        if (!pending) {
            baeBridgeLog("orphan", {
                tabId,
                requestId: bridgeMessage.requestId,
                type: bridgeMessage.type,
                pendingSize: baeBridgePending.size,
            });
            chrome.runtime.sendMessage({
                action: "BAE_BRIDGE_EVENT",
                tabId,
                message: bridgeMessage,
            }).catch(() => { });
            sendResponse({ ok: true, kind: "orphan" });
            return false;
        }

        clearTimeout(pending.timeout);
        baeBridgePending.delete(bridgeMessage.requestId);
        baeBridgeLog("resolve", {
            tabId,
            requestId: bridgeMessage.requestId,
            type: bridgeMessage.type,
            pendingSize: baeBridgePending.size,
            ageMs: Date.now() - Number(pending.createdAt || Date.now()),
        });

        const responsePayload = {
            ok: bridgeMessage.type !== "BAE_ERROR",
            tabId,
            envelope: bridgeMessage,
            payload: bridgeMessage.payload || {},
        };

        chrome.runtime.sendMessage({
            action: "BAE_BRIDGE_EVENT",
            tabId,
            message: bridgeMessage,
        }).catch(() => { });

        if (bridgeMessage.type === "BAE_ERROR") {
            pending.reject(new Error(bridgeMessage.payload?.message || "Bridge command failed"));
        } else {
            pending.resolve(responsePayload);
        }
        sendResponse({ ok: true, kind: "resolved" });
        return false;
    }

    if (msg.action === "BAE_BRIDGE_REQUEST") {
        sendBaeBridgeRequest({
            type: String(msg.type || "").trim(),
            payload: isObject(msg.payload) ? msg.payload : {},
            tabId: Number(msg.tabId || 0) || 0,
            timeoutMs: Number(msg.timeoutMs || 0) || BAE_BRIDGE_TIMEOUT_MS,
        })
            .then((result) => sendResponse(result))
            .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
        return true;
    }

    if (msg.action === "BAE_BRIDGE_STATUS") {
        getBaeSourceTab(Number(msg.tabId || 0) || 0)
            .then(async (tab) => {
                const tabId = tab?.id || 0;
                let state = getBaeBridgeState(tabId);
                if (tabId > 0 && !state.detected) {
                    try {
                        await sendBaeBridgeRequest({
                            type: "BAE_GET_STATE",
                            payload: {},
                            tabId,
                            timeoutMs: 1500,
                        });
                    } catch { }
                    state = getBaeBridgeState(tabId);
                }
                sendResponse({
                    ok: true,
                    tabId,
                    state,
                    pendingSize: baeBridgePending.size,
                    pendingRequestIds: Array.from(baeBridgePending.keys()),
                });
            })
            .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
        return true;
    }

    if (msg.action === "NEXUS_TURBO_CACHE_DIRECT") {
        const pageUrl = String(msg.pageUrl || "").trim();
        const streamUrl = String(msg.streamUrl || "").trim();
        if (pageUrl && streamUrl && !streamUrl.startsWith("blob:")) {
            const entry = {
                streamUrl,
                title: msg.title || "Turbo video",
                thumbnail: msg.thumbnail || null,
                duration: Number(msg.duration || 0) || 0,
                ts: Date.now(),
            };
            const tabId = sender?.tab?.id;
            const tabKey = tabId ? `nexus_turbo_tab_${tabId}` : null;
            const storeObj = { [`nexus_turbo_direct_${pageUrl}`]: entry };
            if (tabKey) {
                chrome.storage.local.get([tabKey]).then((stored) => {
                    const existing = Array.isArray(stored[tabKey]) ? stored[tabKey] : [];
                    const deduped = existing.filter((v) => v.pageUrl !== pageUrl);
                    deduped.push({ pageUrl, ...entry });
                    chrome.storage.local.set({ ...storeObj, [tabKey]: deduped.slice(-60) })
                        .then(() => sendResponse({ ok: true }))
                        .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
                }).catch(() => {
                    chrome.storage.local.set(storeObj)
                        .then(() => sendResponse({ ok: true }))
                        .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
                });
            } else {
                chrome.storage.local.set(storeObj)
                    .then(() => sendResponse({ ok: true }))
                    .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
            }
            return true;
        }
        sendResponse({ ok: false, error: "missing-page-or-stream" });
        return false;
    }

    if (msg.action === "GET_TURBO_FOR_TAB") {
        const tabId = Number(msg.tabId || 0) || null;
        if (!tabId) { sendResponse({ ok: true, videos: [] }); return false; }
        chrome.storage.local.get([`nexus_turbo_tab_${tabId}`])
            .then((stored) => sendResponse({ ok: true, videos: stored[`nexus_turbo_tab_${tabId}`] || [] }))
            .catch(() => sendResponse({ ok: true, videos: [] }));
        return true;
    }

    if (msg.action === "NEXUS_TURBO_RESOLVE") {
        nexusTurboResolve(String(msg.url || ""))
            .then((data) => sendResponse({ ok: true, ...data }))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === "NEXUS_TURBO_IMPORT") {
        nexusTurboImport(msg)
            .then((data) => sendResponse({ ok: true, ...data }))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    // Accept the old name too: an already-open Turbo tab can retain an older
    // content script while the extension service worker has just reloaded.
        if (msg.action === "NEXUS_TURBO_HUNTER_PUSH") {
        nexusTurboHunterPush(msg)
            .then((data) => sendResponse({ ok: true, ...data }))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === "NEXUS_TURBO_IMPORT_BULK" || msg.action === "TURBO_IMPORT_BULK") {
        nexusTurboImportBulk(msg)
            .then((data) => sendResponse({ ok: true, ...data }))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === "NEXUS_BUNKR_IMPORT_BULK") {
        nexusBunkrImportBulk(msg)
            .then((data) => sendResponse({ ok: true, ...data }))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === "NEXUS_CYBERFILE_IMPORT_BULK") {
        nexusCyberfileImportBulk(msg)
            .then((data) => sendResponse({ ok: true, ...data }))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === "EPORNER_IMPORT_BULK") {
        nexusEpornerImportBulk(msg)
            .then((data) => sendResponse({ ok: true, ...data }))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === "EPORNER_EXPAND_PLAYLIST") {
        nexusEpornerExpandPlaylist(msg)
            .then((data) => sendResponse({ ok: true, ...data }))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === "EPORNER_CREATE_MIX") {
        nexusEpornerCreateMix(msg)
            .then((data) => sendResponse({ ok: true, ...data }))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === "EPORNER_FAST_SCAN_PLAYLISTS") {
        nexusEpornerFastScan(msg)
            .then((data) => sendResponse({ ok: true, ...data }))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === "EPORNER_DEEP_RESOLVE") {
        nexusEpornerDeepResolve(msg)
            .then((data) => sendResponse({ ok: true, ...data }))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === "TUBED69_IMPORT_BULK") {
        (async () => {
            try { sendResponse({ ok: true, ...await nexusTubed69ImportBulk(msg) }); }
            catch (e) { sendResponse({ ok: false, error: e?.message || String(e) }); }
        })();
        return true;
    }

    if (msg.action === "REDTUBE_IMPORT_BULK") {
        nexusRedtubeImportBulk(msg)
            .then((data) => sendResponse({ ok: true, ...data }))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === "DRTUBER_PROBE_SIZE") {
        nexusDrtuberProbeSize(msg, sender)
            .then((data) => sendResponse({ ok: true, ...data }))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === "DRTUBER_IMPORT_BULK") {
        nexusDrtuberImportBulk(msg)
            .then((data) => sendResponse({ ok: true, ...data }))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === "FAPHOUSE_IMPORT_BULK") {
        nexusFaphouseImportBulk(msg)
            .then((data) => sendResponse({ ok: true, ...data }))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === "FUQ_IMPORT_BULK") {
        nexusFuqImportBulk(msg)
            .then((data) => sendResponse({ ok: true, ...data }))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === "XXXDBX_FETCH_META") {
        (async () => {
            const viewUrl = String(msg.url || "").trim();
            if (!viewUrl) throw new Error("No url");
            const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
            // 1) fetch the /view/ page and parse <source> mp4 tags
            const pageResp = await fetch(viewUrl, {
                headers: { "User-Agent": ua, "Referer": "https://xxxdbx.com/" },
            });
            if (!pageResp.ok) throw new Error(`view ${pageResp.status}`);
            const html = await pageResp.text();
            const srcs = Array.from(html.matchAll(/<source[^>]+src="([^"]+\.mp4[^"]*)"/gi))
                .map((m) => (m[1].startsWith("//") ? "https:" + m[1] : m[1]))
                .filter((u) => /^https?:/i.test(u));
            if (!srcs.length) throw new Error("no mp4");
            const heightOf = (u) => {
                const m = u.match(/\/(\d{3,4})\.mp4/);
                return m ? parseInt(m[1], 10) : 0;
            };
            const best = srcs.reduce((a, b) => (heightOf(b) > heightOf(a) ? b : a), srcs[0]);
            const height = heightOf(best);

            // 2) get total size via a 0-0 Range GET (content-range total), HEAD as fallback
            let sizeBytes = 0;
            try {
                const rr = await fetch(best, {
                    headers: { "User-Agent": ua, "Referer": "https://xxxdbx.com/", "Range": "bytes=0-0" },
                });
                const cr = rr.headers.get("content-range");
                if (cr) {
                    const tm = cr.match(/\/(\d+)\s*$/);
                    if (tm) sizeBytes = parseInt(tm[1], 10);
                }
                if (!sizeBytes) {
                    const cl = rr.headers.get("content-length");
                    if (cl && rr.status !== 206) sizeBytes = parseInt(cl, 10);
                }
            } catch (_) { /* size best-effort */ }
            if (!sizeBytes) {
                try {
                    const hr = await fetch(best, { method: "HEAD", headers: { "User-Agent": ua, "Referer": "https://xxxdbx.com/" } });
                    const cl = hr.headers.get("content-length");
                    if (cl) sizeBytes = parseInt(cl, 10);
                } catch (_) { }
            }
            const sizeMb = sizeBytes > 0 ? Math.round(sizeBytes / (1024 * 1024)) : 0;
            return { height, sizeMb, sizeBytes, streamUrl: best };
        })()
            .then((data) => sendResponse({ ok: true, ...data }))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === "XXXDBX_IMPORT_BULK") {
        (async () => {
            const list = Array.isArray(msg.items) ? msg.items : [];
            const videos = list.map((raw) => {
                const sourceUrl = String(raw?.source_url || raw?.url || "").trim();
                const importUrl = String(raw?.url || sourceUrl).trim();
                if (!sourceUrl || !importUrl) return null;
                const tags = Array.isArray(raw?.tags) ? raw.tags : [];
                const merged = Array.from(new Set(tags.map((t) => String(t || "").trim()).filter(Boolean)));
                return {
                    url: importUrl,                 // stable /view/ page; JIT-resolved at play time
                    title: String(raw?.title || "Xxxdbx Video").trim() || "Xxxdbx Video",
                    source_url: sourceUrl,
                    thumbnail: raw?.thumbnail || null,
                    duration: Number(raw?.duration || 0) || 0,
                    height: Number(raw?.height || 0) || 0,
                    quality: String(raw?.quality || "").trim() || undefined,
                    file_size_mb: Number(raw?.file_size_mb || 0) || null,
                    tags: merged.length ? merged.join(",") : "xxxdbx",
                };
            }).filter(Boolean);

            if (!videos.length) throw new Error("No Xxxdbx videos were prepared for import");

            const baseUrl = await findDashboardUrl();
            const resp = await fetch(`${baseUrl}/api/v1/import/bulk`, {
                method: "POST",
                headers: await buildLocalApiHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify({
                    batch_name: String(msg.batchName || "Xxxdbx Quick Import").trim() || "Xxxdbx Quick Import",
                    videos,
                }),
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(data.detail || `Nexus returned ${resp.status}`);
            return { imported: videos.length, requested: list.length, data };
        })()
            .then((data) => sendResponse({ ok: true, ...data }))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === "FAPFOLDER_IMPORT_BULK") {
        (async () => {
            const items = Array.isArray(msg.items) ? msg.items : [];
            if (!items.length) throw new Error("No videos provided");

            const baseUrl = await findDashboardUrl();
            const headers = await buildLocalApiHeaders({ "Content-Type": "application/json" });
            const videos = await buildFapFolderImportVideos(items);

            let batchName = String(msg.batchName || "FapFolder Import").replace(/\s+/g, " ").trim() || "FapFolder Import";
            const boardName = String(msg.sourceBoard?.name || "").replace(/\s+/g, " ").trim();
            if (boardName) {
                // Source Boards group their videos by batch_name; mirror backend's "Board - <name>" default.
                batchName = `Board - ${boardName}`;
                const boardResp = await fetch(`${baseUrl}/api/v1/source-boards`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        name: boardName,
                        source_url: String(msg.sourceBoard?.sourceUrl || "https://fapfolder.club/"),
                        source_type: "fapfolder",
                        batch_name: batchName,
                    }),
                });
                if (!boardResp.ok) {
                    const boardErr = await boardResp.json().catch(() => ({}));
                    // An already existing board is fine: we simply add into its batch.
                    if (!/already exists/i.test(String(boardErr.detail || ""))) {
                        throw new Error(boardErr.detail || `Source board error ${boardResp.status}`);
                    }
                }
            }

            const resp = await fetch(`${baseUrl}/api/v1/import/bulk`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    batch_name: batchName,
                    videos,
                }),
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) {
                throw new Error(data.detail || `Dashboard error ${resp.status}`);
            }
            return data;
        })()
            .then((data) => sendResponse({ ok: true, data }))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === "FAPFOLDER_FETCH_DATES") {
        (async () => {
            try {
                const items = Array.isArray(msg.items) ? msg.items : [];
                const results = await mapFapFolderWithLimit(items.slice(0, 12), 3, async (item) => {
                    const url = String(item?.url || "").trim();
                    if (!/^https:\/\/(?:[^/]+\.)?fapfolder\.club\/(?:posts|videos?)\/[\w-]+\/?(?:[?#].*)?$/i.test(url)) return { id: item?.id, addedAt: "" };
                    try {
                        const resp = await fetch(url, { credentials: "include", signal: AbortSignal.timeout(12000), headers: { "Accept": "text/html" } });
                        if (!resp.ok) return { id: item.id, addedAt: "" };
                        return { id: item.id, addedAt: extractFapFolderMetaFromHtml(await resp.text()).addedAt || "" };
                    } catch { return { id: item.id, addedAt: "" }; }
                });
                sendResponse({ ok: true, items: results });
            } catch (error) { sendResponse({ ok: false, error: error?.message || String(error) }); }
        })();
        return true;
    }

    if (msg.action === "FAPFOLDER_HYDRATE_ITEMS") {
        (async () => {
            try {
                const items = Array.isArray(msg.items) ? msg.items : [];
                const results = await mapFapFolderWithLimit(items.slice(0, 12), 2, hydrateFapFolderItem);
                sendResponse({ ok: true, items: results });
            } catch (error) { sendResponse({ ok: false, error: error?.message || String(error) }); }
        })();
        return true;
    }

    if (msg.action === "EPALOVO_IMPORT_BULK") {
        (async () => {
            try {
                const items = Array.isArray(msg.items) ? msg.items : [];
                const batchName = String(msg.batchName || "Epalovo Import").trim() || "Epalovo Import";
                if (!items.length) throw new Error("No videos provided");

                const baseUrl = await findDashboardUrl();
                const apiHeaders = await buildLocalApiHeaders({ "Content-Type": "application/json" });

                let imported = 0;
                const errors = [];

                // epalovo is a KVS-engine site; the stream URL is license-obfuscated
                // in the page. The extension fetches the page HTML (with cookies/VPN)
                // and hands it to the backend's browser-fetch route, which runs the
                // server-side KVS extractor — same proven path as sxyprn.
                for (const item of items) {
                    const url = String(item?.url || item?.source_url || "").trim();
                    if (!url) { errors.push({ url: "", error: "missing url" }); continue; }
                    try {
                        const providedDirect = String(item?.directUrl || item?.stream_url || item?.video_url || "").trim();
                        let data = {};
                        if (providedDirect) {
                            const pickedProvided = await pickImportableStream({
                                pageUrl: url,
                                streamUrl: providedDirect,
                                durationSec: Number(item?.duration || 0) || 0,
                            });
                            if (pickedProvided?.streamUrl) {
                                data = {
                                    ok: true,
                                    stream_url: pickedProvided.streamUrl,
                                    title: item?.title || "Epalovo Video",
                                    thumbnail: item?.thumbnail || "",
                                    duration: Number(pickedProvided.duration || item?.duration || 0) || 0,
                                    quality: "HD",
                                    tags: "epalovo",
                                    _picked: pickedProvided,
                                };
                            }
                        }

                        if (!data.stream_url) {
                            const pageResp = await fetch(url, {
                                credentials: "include",
                                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
                            });
                            if (!pageResp.ok) { errors.push({ url, error: `fetch ${pageResp.status}` }); continue; }
                            const html = await pageResp.text();

                            const extractResp = await fetch(`${baseUrl}/api/v1/intake/browser-fetch`, {
                                method: "POST",
                                headers: apiHeaders,
                                body: JSON.stringify({
                                    url,
                                    html,
                                    batch_name: batchName,
                                    // grid metadata hints (used as fallback if the page
                                    // extractor can't recover them)
                                    title: item?.title || undefined,
                                    thumbnail: item?.thumbnail || undefined,
                                    duration: Number(item?.duration || 0) || undefined,
                                }),
                            });
                            data = await extractResp.json().catch(() => ({}));
                            if (!extractResp.ok || data.ok === false || !data.stream_url) {
                                errors.push({ url, error: data.error || `backend ${extractResp.status}` });
                                continue;
                            }
                        }

                        const picked = data._picked || await pickImportableStream({
                            pageUrl: url,
                            streamUrl: data.stream_url,
                            durationSec: Number(data.duration || item?.duration || 0) || 0,
                        });
                        if (!picked?.streamUrl) {
                            errors.push({ url, error: "resolved stream looks blocked/too short" });
                            continue;
                        }

                        const importResp = await fetch(`${baseUrl}/api/v1/import/bulk`, {
                            method: "POST",
                            headers: apiHeaders,
                            body: JSON.stringify({
                                batch_name: batchName,
                                videos: [{
                                    url: picked.streamUrl,
                                    source_url: url,
                                    title: data.title || item?.title || "Epalovo Video",
                                    thumbnail: data.thumbnail || item?.thumbnail || "",
                                    duration: Number(picked.duration || data.duration || item?.duration || 0) || 0,
                                    file_size_mb: picked.sizeBytes > 0 ? Number((picked.sizeBytes / (1024 * 1024)).toFixed(3)) : undefined,
                                    width: Number(data.width || 0) || 0,
                                    height: Number(data.height || 0) || 0,
                                    quality: data.quality || (data.height ? `${data.height}p` : "HD"),
                                    tags: Array.isArray(data.tags) ? data.tags.join(",") : (data.tags || "epalovo"),
                                }],
                            }),
                        });
                        const importData = await importResp.json().catch(() => ({}));
                        if (importResp.ok) imported += Number(importData.imported ?? 1) || 1;
                        else errors.push({ url, error: importData.detail || importData.error || `import ${importResp.status}` });
                    } catch (e) {
                        errors.push({ url, error: e?.message || String(e) });
                    }
                }

                sendResponse({ ok: true, imported, total: items.length, errors });
            } catch (e) {
                sendResponse({ ok: false, error: e?.message || String(e) });
            }
        })();
        return true;
    }

    if (msg.action === "SXYPRN_BLOG_IMPORT") {
        (async () => {
            try {
                const urls = Array.isArray(msg.urls) ? msg.urls : [];
                const batchName = String(msg.batchName || "sxyprn Blog Import").trim() || "sxyprn Blog Import";
                if (!urls.length) throw new Error("No URLs provided");

                const baseUrl = await findDashboardUrl();
                const apiHeaders = await buildLocalApiHeaders({ "Content-Type": "application/json" });

                let imported = 0;
                const errors = [];

                for (const url of urls) {
                    try {
                        const pageResp = await fetch(url, {
                            credentials: "include",
                            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
                        });
                        if (!pageResp.ok) { errors.push({ url, error: `fetch ${pageResp.status}` }); continue; }
                        const html = await pageResp.text();

                        const extractResp = await fetch(`${baseUrl}/api/v1/intake/browser-fetch`, {
                            method: "POST",
                            headers: apiHeaders,
                            body: JSON.stringify({ url, html, batch_name: batchName }),
                        });
                        const data = await extractResp.json().catch(() => ({}));
                        if (extractResp.ok && data.ok !== false) imported++;
                        else errors.push({ url, error: data.error || `backend ${extractResp.status}` });
                    } catch (e) {
                        errors.push({ url, error: e?.message || String(e) });
                    }
                }

                sendResponse({ ok: true, imported, total: urls.length, errors });
            } catch (e) {
                sendResponse({ ok: false, error: e?.message || String(e) });
            }
        })();
        return true;
    }

    // Browser-proxy fetch: extension fetches the page HTML (with VPN/cookies)
    // and forwards it to the backend which extracts stream URL + metadata.
    if (msg.action === "BROWSER_FETCH_IMPORT") {
        (async () => {
            try {
                const url = String(msg.url || "").trim();
                if (!url) throw new Error("No URL provided");
                const resp = await fetch(url, {
                    credentials: "include",
                    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" }
                });
                if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
                const html = await resp.text();
                const baseUrl = await findDashboardUrl();
                const apiHeaders = await buildLocalApiHeaders({ "Content-Type": "application/json" });
                const extractResp = await fetch(`${baseUrl}/api/v1/intake/browser-fetch`, {
                    method: "POST",
                    headers: apiHeaders,
                    body: JSON.stringify({ url, html })
                });
                const data = await extractResp.json().catch(() => ({}));
                if (!extractResp.ok || !data.ok) throw new Error(data.error || `Backend returned ${extractResp.status}`);
                sendResponse({ ok: true, ...data });
            } catch (e) {
                sendResponse({ ok: false, error: e?.message || String(e) });
            }
        })();
        return true;
    }

    // Browser-refresh: extension fetches source page, extracts fresh .mp4, pushes to backend
    if (msg.action === "BROWSER_REFRESH_STREAM") {
        (async () => {
            try {
                const videoId = msg.video_id;
                const sourceUrl = String(msg.source_url || "").trim();
                if (!videoId || !sourceUrl) throw new Error("video_id and source_url required");

                // Fetch the source page HTML via Chrome (has VPN)
                const pageResp = await fetch(sourceUrl, { credentials: "include" });
                if (!pageResp.ok) throw new Error(`Page fetch failed: ${pageResp.status}`);
                const html = await pageResp.text();

                // Extract direct .mp4 stream from HTML
                let streamUrl = null;
                let height = 0;
                const qualityMap = [
                    { pat: /["']?(?:4k|2160p)["']?\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)/i, h: 2160 },
                    { pat: /["']?1440p["']?\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)/i, h: 1440 },
                    { pat: /["']?1080p["']?\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)/i, h: 1080 },
                    { pat: /["']?720p["']?\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)/i, h: 720 },
                    { pat: /["']?480p["']?\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)/i, h: 480 },
                    { pat: /["']?360p["']?\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)/i, h: 360 },
                ];
                for (const { pat, h } of qualityMap) {
                    const m = html.match(pat);
                    if (m) { streamUrl = m[1].replace(/\\\//g, '/'); height = h; break; }
                }
                // JSON-LD contentUrl fallback
                if (!streamUrl) {
                    const ldm = html.match(/"contentUrl"\s*:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/);
                    if (ldm) streamUrl = ldm[1].replace(/\\\//g, '/');
                }
                // /dload/ redirect fallback — resolve via HEAD
                if (!streamUrl) {
                    const dloadM = html.match(/href=["'](\/(dload\/[^"']+))["']/);
                    if (dloadM) {
                        const dloadUrl = `https://www.eporner.com/${dloadM[2]}`;
                        try {
                            const hr = await fetch(dloadUrl, { method: 'HEAD', credentials: 'include', redirect: 'follow' });
                            if (hr.ok && /\.mp4(\?|$)/i.test(hr.url)) streamUrl = hr.url;
                        } catch { }
                    }
                }

                if (!streamUrl) throw new Error("Could not extract stream URL from page");

                // Push to backend
                const baseUrl = await findDashboardUrl();
                const apiHeaders = await buildLocalApiHeaders({ "Content-Type": "application/json" });
                const pushResp = await fetch(`${baseUrl}/api/v1/videos/${videoId}/browser-refresh-stream`, {
                    method: "POST",
                    headers: apiHeaders,
                    body: JSON.stringify({ stream_url: streamUrl, height }),
                });
                const data = await pushResp.json().catch(() => ({}));
                if (!pushResp.ok) throw new Error(data.detail || `Backend returned ${pushResp.status}`);
                sendResponse({ ok: true, stream_url: streamUrl, height });
            } catch (e) {
                sendResponse({ ok: false, error: e?.message || String(e) });
            }
        })();
        return true;
    }

    if (msg.action === "OPEN_STREAM_TAB") {
        const streamUrl = String(msg.url || "").trim();
        if (streamUrl) chrome.tabs.create({ url: streamUrl, active: true });
        sendResponse({ ok: true });
        return false;
    }

    if (msg.action === "CHOOSE_BEST_MEDIA_URL") {
        const raw = Array.isArray(msg.candidates) ? msg.candidates : [];
        const uniq = [...new Set(raw.map((u) => String(u || "").trim()).filter(Boolean))];
        let best = "";
        for (const u of uniq) {
            best = choosePreferredCapturedStream(String(msg.pageUrl || ""), best, u);
        }
        sendResponse({ ok: true, url: best || "" });
        return false;
    }

    if (msg.action === "TRY_PICK_IMPORTABLE_STREAM") {
        (async () => {
            const pageUrlNorm =
                normalizeCaptureWatchPageUrl(String(msg.pageUrl || "").trim()) ||
                String(msg.pageUrl || "").trim();
            const picked = await pickImportableStream({
                pageUrl: pageUrlNorm,
                streamUrl: String(msg.streamUrl || "").trim(),
                durationSec: Number(msg.duration || 0) || 0,
            });
            if (!picked?.streamUrl) {
                sendResponse({ ok: false, streamUrl: "" });
                return;
            }
            sendResponse({
                ok: true,
                streamUrl: picked.streamUrl,
                sizeBytes: picked.sizeBytes || 0,
                duration: picked.duration || 0,
                source: picked.source || "pick",
            });
        })();
        return true;
    }

    if (msg.action === "GET_MEGA_CAPTURE") {
        (async () => {
            const tabId = Number(msg.captureTabId || sender.tab?.id || 0) || 0;
            const duration = Number(msg.duration || 0) || 0;
            const payload = await getMegaCapturePayload(tabId, duration);
            sendResponse({ ok: payload.ready, ...payload, data: payload });
        })();
        return true;
    }

    if (msg.action === "GET_CAPTURED_STREAM") {
        (async () => {
            const pageUrl = String(msg.pageUrl || sender.tab?.url || "").trim();
            let streamUrl = "";
            let title = "";

            const storageKeys = [];
            if (pageUrl) {
                const canonicalKey = capturedStreamStorageKey(pageUrl);
                if (canonicalKey) storageKeys.push(canonicalKey);
                try {
                    const u = new URL(pageUrl);
                    const domain = u.hostname.replace(/^www\./i, "");
                    const legacyKey = `captured_${domain}_${pageUrl}`;
                    if (!storageKeys.includes(legacyKey)) storageKeys.push(legacyKey);
                } catch { }

                try {
                    const norm = normalizeCaptureWatchPageUrl(pageUrl);
                    if (norm) {
                        const d = new URL(norm).hostname.replace(/^www\./i, "");
                        const altLegacy = `captured_${d}_${pageUrl}`;
                        if (!storageKeys.includes(altLegacy)) storageKeys.push(altLegacy);
                    }
                } catch { }
            }

            if (storageKeys.length) {
                const cached = await chrome.storage.local.get(storageKeys);
                for (const k of storageKeys) {
                    const row = cached?.[k];
                    if (row?.streamUrl) {
                        streamUrl = String(row.streamUrl).trim();
                        title = String(row.title || "").trim();
                        break;
                    }
                }
            }

            const captureTabId = Number(msg.captureTabId ?? msg.resolveTabId);
            if (
                !streamUrl &&
                Number.isFinite(captureTabId) &&
                captureTabId >= 0
            ) {
                streamUrl = String(capturedStreams.get(captureTabId) || "").trim();
            }

            if (!streamUrl) {
                const tabId = sender.tab?.id;
                if (Number.isInteger(tabId) && tabId >= 0) {
                    streamUrl = String(capturedStreams.get(tabId) || "").trim();
                    if (!streamUrl && chrome.storage?.session?.get) {
                        try {
                            const sessionAll = await chrome.storage.session.get(null);
                            const tabPage = normalizeCaptureWatchPageUrl(sender.tab?.url || "");
                            const reqPage = normalizeCaptureWatchPageUrl(pageUrl);
                            const rows = Object.entries(sessionAll || {})
                                .filter(([k, v]) => k.startsWith(`nexus_direct_response_${tabId}_`) && v?.url)
                                .filter(([, v]) => {
                                    if (Date.now() - Number(v.ts || 0) > 15 * 60 * 1000) return false;
                                    const rowPage = normalizeCaptureWatchPageUrl(v.pageUrl || "");
                                    return !rowPage || !tabPage || rowPage === tabPage || rowPage === reqPage;
                                })
                                .map(([, v]) => v)
                                .sort((a, b) => Number(/master/i.test(b.url)) - Number(/master/i.test(a.url))
                                    || Number(looksLikeHls(b.url)) - Number(looksLikeHls(a.url))
                                    || Number(b.ts || 0) - Number(a.ts || 0));
                            if (rows[0]?.url) {
                                streamUrl = String(rows[0].url).trim();
                            }
                        } catch { }
                    }
                }
            }

            const pageUrlForPick = normalizeCaptureWatchPageUrl(pageUrl) || pageUrl;
            const picked = await pickImportableStream({
                pageUrl: pageUrlForPick,
                streamUrl,
                durationSec: Number(msg.duration || 0) || 0,
            });
            if (picked?.streamUrl) {
                const payload = {
                    streamUrl: picked.streamUrl,
                    sizeBytes: picked.sizeBytes || 0,
                    duration: picked.duration || 0,
                    source: picked.source || "captured",
                    title,
                    playable: true,
                };
                sendResponse({ ok: true, ...payload, data: payload });
                return;
            }
            const payload = { streamUrl: "", title, rejected: true, reason: "below-threshold-or-no-deep-stream", playable: false, sizeBytes: 0, duration: Number(msg.duration || 0) || 0 };
            sendResponse({ ok: false, ...payload, data: payload });
        })();
        return true;
    }

    if (msg.action === "MEGA_NATIVE_ADD") {
        // MEGA Native Bridge: store the permanent mega.nz link; the dashboard
        // resolves + decrypts on demand at playback. No chunk capture needed.
        const port = msg.port || 8001;
        const pageUrl = String(msg.url || sender.tab?.url || "").trim();
        const isFolder = /mega\.nz\/folder\//i.test(pageUrl) || /#F!/.test(pageUrl);
        const endpoint = isFolder ? "add-folder" : "add";
        const targetUrl = `http://localhost:${port}/api/v1/mega/${endpoint}`;

        fetch(targetUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: pageUrl }),
        })
            .then(async (res) => {
                const data = await res.json().catch(() => ({}));
                if (res.ok) sendResponse({ ok: true, data, kind: isFolder ? "folder" : "file" });
                else sendResponse({ ok: false, error: data.detail || `Server error ${res.status}` });
            })
            .catch(() => sendResponse({ ok: false, error: "Dashboard unreachable on port " + port }));
        return true;
    }

    if (msg.action === "IMPORT_MEGA_VIDEO") {
        const { port, metadata } = msg;
        const targetUrl = `http://localhost:${port}/api/v1/import/mega-capture`;

        (async () => {
            const tabId = Number(msg.captureTabId || sender.tab?.id || 0) || 0;
            const duration = Number(metadata?.duration || msg.duration || 0) || 0;
            const capture = msg.capture?.chunks?.length
                ? msg.capture
                : await getMegaCapturePayload(tabId, duration);

            if (!capture?.chunks?.length) {
                sendResponse({ ok: false, error: "MEGA chunks not captured yet. Play the MEGA video for a few seconds first." });
                return;
            }

            const sourceUrl = String(metadata?.sourceUrl || capture.pageUrl || sender.tab?.url || "").trim();
            const title = String(metadata?.title || capture.title || sender.tab?.title || "MEGA video").trim();

            fetch(targetUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    capture_id: capture.captureId,
                    source_url: sourceUrl,
                    title,
                    duration: Math.max(duration, Number(capture.duration || 0) || 0),
                    thumbnail: metadata?.thumbnail || null,
                    batch_name: "MEGA Capture",
                    total_captured_bytes: Number(capture.totalCapturedBytes || 0) || 0,
                    chunks: capture.chunks,
                }),
            })
                .then(async (res) => {
                    const data = await res.json().catch(() => ({}));
                    if (res.ok) {
                        sendResponse({ ok: true, data, resolvedBy: "mega-capture" });
                    } else {
                        sendResponse({ ok: false, error: data.detail || `Server error ${res.status}` });
                    }
                })
                .catch((err) => {
                    console.error(`[Nexus] MEGA import failed:`, err);
                    sendResponse({ ok: false, error: "Dashboard unreachable. Is it running on port " + port + "?" });
                });
        })();

        return true;
    }

    if (msg.action === "BUNKR_SIGNED_URL") {
        // Content script intercepted bunkr's /api/sign response
        const pageUrl = String(msg.pageUrl || "").trim();
        if (pageUrl && msg.signedUrl) {
            bunkrSignedCache.set(pageUrl, {
                signedUrl: msg.signedUrl,
                filename: msg.filename || "",
                ts: Date.now(),
            });
        }
        sendResponse({ ok: true });
        return true;
    }

    if (msg.action === "QUALITY_HUNT_START") {
        (async () => {
            try {
                const port = Number(msg.port) || 0;
                const baseUrl = msg.baseUrl || (port ? `http://127.0.0.1:${port}` : await findDashboardUrl());
                const resp = await fetch(`${baseUrl}/api/v1/quality-hunt`, {
                    method: "POST",
                    headers: await buildLocalApiHeaders({ "Content-Type": "application/json" }),
                    body: JSON.stringify(msg.payload || {}),
                    signal: AbortSignal.timeout(12000),
                });
                const data = await resp.json().catch(() => ({}));
                if (!resp.ok) {
                    sendResponse({ ok: false, error: data.detail || `HTTP ${resp.status}` });
                    return;
                }
                sendResponse({ ok: true, data, baseUrl });
            } catch (err) {
                sendResponse({ ok: false, error: err?.message || String(err) });
            }
        })();
        return true;
    }

    if (msg.action === "QUALITY_HUNT_POLL") {
        (async () => {
            try {
                const port = Number(msg.port) || 0;
                const baseUrl = msg.baseUrl || (port ? `http://127.0.0.1:${port}` : await findDashboardUrl());
                const jobId = String(msg.jobId || "").trim();
                if (!jobId) {
                    sendResponse({ ok: false, error: "missing jobId" });
                    return;
                }
                const resp = await fetch(`${baseUrl}/api/v1/quality-hunt/${encodeURIComponent(jobId)}`, {
                    headers: await buildLocalApiHeaders(),
                    signal: AbortSignal.timeout(12000),
                });
                const data = await resp.json().catch(() => ({}));
                if (!resp.ok) {
                    sendResponse({ ok: false, error: data.detail || `HTTP ${resp.status}` });
                    return;
                }
                sendResponse({ ok: true, data });
            } catch (err) {
                sendResponse({ ok: false, error: err?.message || String(err) });
            }
        })();
        return true;
    }

    if (msg.action === "QUALITY_HUNT_CANCEL") {
        (async () => {
            try {
                const baseUrl = msg.baseUrl || (Number(msg.port) ? `http://localhost:${Number(msg.port)}` : await findDashboardUrl());
                const resp = await fetch(`${baseUrl}/api/v1/quality-hunt/${encodeURIComponent(msg.jobId)}/cancel`, {
                    method: "POST", headers: await buildLocalApiHeaders(), signal: AbortSignal.timeout(10000),
                });
                sendResponse({ ok: resp.ok, data: await resp.json().catch(() => ({})) });
            } catch (err) {
                sendResponse({ ok: false, error: err?.message || String(err) });
            }
        })();
        return true;
    }

    if (msg.action === "QUALITY_HUNT_RESOLVE") {
        (async () => {
            try {
                const pageUrl = String(msg.url || "").trim();
                if (!pageUrl) {
                    sendResponse({ ok: false, error: "missing url" });
                    return;
                }
                if (/\.(mp4|webm|m3u8|mkv|mov)(\?|$)/i.test(pageUrl)) {
                    sendResponse({ ok: true, streamUrl: pageUrl });
                    return;
                }
                const port = Number(msg.port) || 0;
                const baseUrl = msg.baseUrl || (port ? `http://127.0.0.1:${port}` : await findDashboardUrl());
                const resp = await fetch(
                    `${baseUrl}/api/v1/intel/resolve?url=${encodeURIComponent(pageUrl)}&refresh=${!!msg.refresh}`,
                    { headers: await buildLocalApiHeaders(), signal: AbortSignal.timeout(120000) }
                );
                const data = await resp.json().catch(() => ({}));
                const streamUrl = String(data.stream_url || data.streamUrl || "").trim();
                if (!resp.ok || !streamUrl) {
                    sendResponse({
                        ok: false,
                        error: data.detail || "Stream sa nepodarilo vytiahnuť",
                    });
                    return;
                }
                sendResponse({
                    ok: true,
                    streamUrl,
                    title: data.title || "",
                    height: Number(data.height || 0) || 0,
                    sizeBytes: Number(data.size_bytes || 0),
                    duration: Number(data.duration || data.duration_sec || 0),
                    alternatives: Array.isArray(data.fallback_urls) ? data.fallback_urls.filter(url => typeof url === 'string' && /^https?:\/\//i.test(url)).slice(0, 3) : [],
                    isHls: !!data.is_hls,
                    proxySession: String(data.proxy_session || ''),
                });
            } catch (err) {
                sendResponse({ ok: false, error: err?.message || String(err) });
            }
        })();
        return true;
    }

    if (msg.action === "QUALITY_HUNT_META") {
        (async () => {
            try {
                const port = Number(msg.port) || 0;
                const baseUrl = msg.baseUrl || (port ? `http://127.0.0.1:${port}` : await findDashboardUrl());
                const resp = await fetch(`${baseUrl}/api/v1/quality-hunt/meta`, {
                    method: "POST",
                    headers: await buildLocalApiHeaders({ "Content-Type": "application/json" }),
                    body: JSON.stringify({ urls: Array.isArray(msg.urls) ? msg.urls.slice(0, 16) : [], job_id: msg.jobId || '', fast: !!msg.fast }),
                    signal: AbortSignal.timeout(90000),
                });
                const data = await resp.json().catch(() => ({}));
                if (!resp.ok) {
                    sendResponse({ ok: false, error: data.detail || `HTTP ${resp.status}` });
                    return;
                }
                sendResponse({ ok: true, ...data, items: data.items || [] });
            } catch (err) {
                sendResponse({ ok: false, error: err?.message || String(err) });
            }
        })();
        return true;
    }

    if (msg.action === 'QUALITY_HUNT_REPORT') {
        (async () => {
            try {
                const base = msg.baseUrl || `http://127.0.0.1:${Number(msg.port) || 8000}`;
                const response = await fetch(`${base}/api/v1/quality-hunt/${encodeURIComponent(msg.jobId)}/playback`, {
                    method: 'POST', headers: await buildLocalApiHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify(msg.payload), signal: AbortSignal.timeout(10000),
                });
                const data = await response.json();
                sendResponse({ ok: response.ok, data });
            } catch (error) { sendResponse({ ok: false, error: error.message }); }
        })();
        return true;
    }

    if (msg.action === "QUALITY_HUNT_ARM") {
        (async () => {
            try {
                const streamUrl = String(msg.streamUrl || "").trim();
                const pageUrl = String(msg.pageUrl || "").trim();
                const host = new URL(streamUrl).hostname;
                const tabId = sender.tab?.id;
                if (!Number.isInteger(tabId)) {
                    sendResponse({ ok: false, error: 'video tab is unavailable' });
                    return;
                }
                const mediaUrl = new URL(streamUrl);
                const hls = /\.m3u8(?:$|\?)/i.test(streamUrl);
                const path = hls ? mediaUrl.pathname.slice(0, mediaUrl.pathname.lastIndexOf('/') + 1) : mediaUrl.pathname;
                // FPO get_file redirects to videos<N>.fpo.xxx/remote_control.php.
                // Keep the watch-page headers on that CDN request as well.
                const fpoMedia = /(^|\.)fpo\.xxx$/i.test(host) &&
                    /(^|\.)fpo\.xxx$/i.test(new URL(pageUrl).hostname);
                const camwhoresMedia = /(^|\.)camwhores\.tv$/i.test(new URL(pageUrl).hostname) &&
                    /(^|\.)camwhores\.(tv|cloud)$/i.test(host);
                const requestDomains = camwhoresMedia ? ['camwhores.tv', 'camwhores.cloud'] : [fpoMedia ? 'fpo.xxx' : host];
                // get_file redirects to a different CamWhores CDN host/path.
                // Apply the watch-page context on both requests, within this tab.
                const scope = camwhoresMedia ? undefined : fpoMedia ? '||fpo.xxx/' : `|${mediaUrl.origin}${path}`;
                let referer = pageUrl;
                try {
                    const page = new URL(pageUrl);
                    if (/(^|\.)pornhub\.(?:com|org|net)$/i.test(page.hostname)) referer = page.origin + "/";
                } catch { /* keep */ }
                let ruleHash = 0;
                for (const char of `${tabId}:${scope || requestDomains.join(',')}`) ruleHash = (ruleHash * 31 + char.charCodeAt(0)) >>> 0;
                const ruleId = 880000 + ruleHash % 100000;
                await chrome.declarativeNetRequest.updateSessionRules({
                    removeRuleIds: [88021, ruleId],
                    addRules: [{
                        id: ruleId,
                        priority: 1,
                        action: {
                            type: "modifyHeaders",
                            requestHeaders: [
                                { header: "referer", operation: "set", value: referer },
                                { header: "origin", operation: "set", value: new URL(pageUrl).origin },
                            ],
                            responseHeaders: [
                                { header: "access-control-allow-origin", operation: "set", value: "*" },
                            ],
                        },
                        condition: {
                            requestDomains,
                            ...(scope ? { urlFilter: scope } : {}),
                            tabIds: [tabId],
                            resourceTypes: ["media", "xmlhttprequest", "other"],
                        },
                    }],
                });
                sendResponse({ ok: true, host });
            } catch (err) {
                sendResponse({ ok: false, error: err?.message || String(err) });
            }
        })();
        return true;
    }

    if (msg.action === "IMPORT_VIDEO") {
        const { streamUrl, port, metadata } = msg;
        const targetUrl = `http://localhost:${port || 8000}/api/v1/import/bulk`;

        (async () => {
            const sourceUrl = String(metadata?.sourceUrl || sender.tab?.url || "").trim();
            const duration = Number(metadata?.duration || 0) || 0;
            const isFileditchViewer = /^https?:\/\/(?:[^/]+\.)?(?:fileditchfiles\.(?:st|me)|fileditchvids\.st|theditch\.st|freakingfileditch\.me|blehpooffileditchvidsstuff\.org|donotsharethesetemplinksyouidiot\.st)(?:[/:?#]|$)/i.test(sourceUrl);
            // FileDitch viewer URLs misleadingly end in .mp4 but return a protected
            // HTML viewer. Do not reject them in the direct-stream probe: the
            // dashboard's FileDitch extractor resolves the page with synced cookies.
            const picked = isFileditchViewer
                ? { streamUrl: sourceUrl, duration, sizeBytes: 0, source: "fileditch-page" }
                : await pickImportableStream({
                    pageUrl: sourceUrl,
                    streamUrl: String(streamUrl || "").trim(),
                    durationSec: duration,
                });
            if (!picked?.streamUrl) {
                // Distinguish between "file not found" and "stream too short/small"
                const isBunkr = isBunkrDomain(sourceUrl);
                let errorMsg;
                if (isBunkr) {
                    errorMsg = `File not found on Bunkr — may have been deleted or moved to a different domain. Try opening the file page directly to verify.`;
                } else {
                    errorMsg = `Could not find a playable stream. The video may be too short (<${MIN_REAL_VIDEO_DURATION_SEC}s), too small (<${Math.round(MIN_REAL_VIDEO_BYTES / (1024 * 1024))}MB), or the file no longer exists.`;
                }
                sendResponse({ ok: false, error: errorMsg });
                return;
            }

            console.log(`[Nexus] Importing to port ${port}: ${picked.streamUrl} (${picked.source})`);

            fetch(targetUrl, {
                method: "POST",
                headers: { ...await buildLocalApiHeaders(), "Content-Type": "application/json" },
                signal: AbortSignal.timeout(60000),
                body: JSON.stringify({
                    batch_name: "Extension Import",
                    videos: [{
                        url: picked.streamUrl,
                        title: metadata.title || "Imported Video",
                        source_url: sourceUrl,
                        duration: Math.max(duration, Number(picked.duration || 0) || 0),
                        thumbnail: metadata.thumbnail,
                        auto_rethumb: isFileditchViewer || !!metadata.autoRethumb,
                        file_size_mb: picked.sizeBytes > 0 ? Number((picked.sizeBytes / (1024 * 1024)).toFixed(3)) : undefined,
                    }],
                }),
            })
                .then(async (res) => {
                    const data = await res.json().catch(() => ({}));
                    if (res.ok && !(Number(data.errors || 0) > 0 && !Number(data.imported || 0) && !Number(data.duplicates || 0))) {
                        sendResponse({ ok: true, data, resolvedBy: picked.source });
                    } else {
                        sendResponse({ ok: false, error: data.detail || (Number(data.errors || 0) > 0 ? 'Nexus odmietol import videa' : `Server error ${res.status}`) });
                    }
                })
                .catch((err) => {
                    console.error(`[Nexus] Import failed:`, err);
                    sendResponse({ ok: false, error: "Dashboard unreachable. Is it running on port " + port + "?" });
                });
        })().catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));

        return true; // Async
    }

    if (msg.action === "PROBE_PLAYLIST") {
        (async () => {
            try {
                const baseUrl = await findDashboardUrl();
                const resp = await fetch(`${baseUrl}/api/v1/playlist/probe`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ url: msg.url }),
                });
                const data = await resp.json().catch(() => ({}));
                if (resp.ok) sendResponse({ ok: true, data });
                else sendResponse({ ok: false, error: data.detail || `Server error ${resp.status}` });
            } catch (error) {
                sendResponse({ ok: false, error: error?.message || String(error) });
            }
        })();
        return true;
    }

    if (msg.action === "REDGIFS_HYDRATE_ITEMS") {
        hydrateRedgifsItems(Array.isArray(msg.items) ? msg.items : [])
            .then((items) => sendResponse({ ok: true, items }))
            .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
        return true;
    }

    if (msg.action === "REDGIFS_IMPORT_BULK") {
        const batchName = String(msg.batchName || "RedGIFs Extension").trim() || "RedGIFs Extension";

        hydrateRedgifsItems(Array.isArray(msg.items) ? msg.items : [])
            .then(async (items) => {
                const baseUrl = await findDashboardUrl();
                const targetUrl = `${baseUrl}/api/v1/import/redgifs-bulk`;
                const payloadItems = items
                    .filter((item) => item?.page_url && item?.video_url)
                    .map((item) => ({
                        title: item.title || "RedGIFs item",
                        video_url: item.video_url,
                        page_url: item.page_url,
                        thumbnail: item.thumbnail || "",
                        tags: Array.isArray(item.tags) ? item.tags : [],
                        duration: Number(item.duration || 0) || 0,
                        width: Number(item.width || 0) || 0,
                        height: Number(item.height || 0) || 0,
                        file_size_mb: Number(item.file_size_mb || item.size_mb || 0) || 0,
                    }));
                const fallbackItems = items
                    .filter((item) => item?.page_url && !item?.video_url)
                    .map((item) => ({
                        title: item.title || "RedGIFs item",
                        video_url: "",
                        page_url: item.page_url,
                        thumbnail: item.thumbnail || "",
                        tags: Array.isArray(item.tags) ? item.tags : [],
                        duration: Number(item.duration || 0) || 0,
                        width: Number(item.width || 0) || 0,
                        height: Number(item.height || 0) || 0,
                        file_size_mb: Number(item.file_size_mb || item.size_mb || 0) || 0,
                    }));
                const finalItems = payloadItems.concat(fallbackItems);

                if (!finalItems.length) {
                    throw new Error("No importable RedGIFs items found after hydrate");
                }

                const resp = await fetch(targetUrl, {
                    method: "POST",
                    headers: await buildLocalApiHeaders({ "Content-Type": "application/json" }),
                    body: JSON.stringify({
                        batch_name: batchName,
                        items: finalItems,
                    }),
                });
                const rawText = await resp.text().catch(() => "");
                let data = {};
                try {
                    data = rawText ? JSON.parse(rawText) : {};
                } catch {
                    data = { detail: rawText || "" };
                }
                if (!resp.ok) {
                    throw new Error(data.detail || `Server error ${resp.status}`);
                }
                sendResponse({ ok: true, data, items: finalItems });
            })
            .catch((error) => {
                console.error("[Nexus] RedGIFs bulk import failed:", error);
                sendResponse({ ok: false, error: error?.message || "Dashboard unreachable" });
            });
        return true;
    }

    if (msg.action === "RESOLVE_CAMWHORES_DIRECT") {
        const pageUrl = String(msg.pageUrl || '').trim();
        extractCamwhoresDirectFromHtml(pageUrl)
            .then((url) => sendResponse({ ok: true, url: url || null }))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === "PH_GET_DEBUG") {
        const key = getPornHoarderDebugKey();
        chrome.storage.local.get([key], (res) => {
            sendResponse({ data: res[key] || null });
        });
        return true;
    }

    if (msg.action === "PH_PLAYER_STREAM") {
        const pageUrl = String(msg.pageUrl || "").trim();
        const playerUrl = String(msg.playerUrl || "").trim();
        const streamUrl = String(msg.streamUrl || "").trim();
        if (!pageUrl || !streamUrl) {
            sendResponse({ ok: false, error: "missing-page-or-stream" });
            return false;
        }

        const videoId = extractPornHoarderVideoId(pageUrl);
        const debugData = {
            pageUrl,
            playerUrl,
            streamUrl,
            videoId,
            status: msg.isHls ? "player-hls" : "player-direct",
            source: "ph_player_bridge",
            ts: Date.now(),
        };

        Promise.all([
            reportCapturedStream(pageUrl, streamUrl),
            setPornHoarderDebug(debugData),
        ])
            .then(() => sendResponse({ ok: true, data: debugData }))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === "FETCH_EMBED_CORS") {
        const { url, referer } = msg;
        fetch(url, {
            credentials: 'omit',
            headers: mediaRefererFor(url, referer) ? { Referer: mediaRefererFor(url, referer) } : {},
        })
            .then(r => {
                const status = r.status;
                if (r.ok) {
                    return r.text().then(html => ({ ok: true, html, status }));
                } else {
                    // Return status even for errors (especially 429)
                    return Promise.resolve({ ok: false, html: null, status });
                }
            })
            .then(result => sendResponse(result))
            .catch(e => sendResponse({ ok: false, error: e.message, status: 500 }));
        return true;
    }

    if (msg.action === "FETCH_HEAD_INFO") {
        (async () => {
            try { sendResponse(await fetchHeadInfo(msg.url, msg.referer || "")); }
            catch (error) { sendResponse({ ok: false, contentLength: 0, error: error?.message || String(error) }); }
        })();
        return true;
    }
    if (msg.action === "PROBE_MEDIA_METADATA") {
        const { url, referer } = msg;
        probeMediaMetadata(url, referer)
            .then((data) => sendResponse(data))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === 'FAPHOUSE_PROBE_STREAM') {
        probeFaphouseStream(msg.streamUrl, msg.referer, Number(msg.expectedDuration || 0))
            .then(sendResponse)
            .catch(error => sendResponse({ ok: false, error: error.message }));
        return true;
    }

    if (msg.action === "DOWNLOAD_WITH_IDM") {
        const { url, filename } = msg;
        if (!url || typeof url !== 'string') {
            sendResponse({ ok: false, error: 'No URL' });
            return false;
        }
        chrome.downloads.download({
            url: String(url).trim(),
            filename: filename ? String(filename).trim() : undefined,
            conflictAction: 'uniquify',
            saveAs: false,
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            } else {
                sendResponse({ ok: true, downloadId });
            }
        });
        return true;
    }

    if (msg.action === "FAST_IMPORT_PAGE_URL") {
        const targetUrl = `http://127.0.0.1:${msg.port || 8001}/api/fast-import`;
        fetch(targetUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ urls: String(msg.url || ""), filter_enabled: false })
        })
            .then(async (res) => {
                const data = await res.json().catch(() => ({}));
                sendResponse({ ok: res.ok, data });
            })
            .catch((err) => {
                sendResponse({ ok: false, error: err.message });
            });
        return true;
    }

    if (msg.action === "BYSE_FETCH") {
        // Fetch bysezoxexe API from background to avoid CORS
        const { apiUrl, referer } = msg;
        fetch(apiUrl, {
            credentials: 'omit',
            headers: {
                'Accept': 'application/json',
                'Referer': referer || 'https://bysezoxexe.com/',
                'Origin': 'https://bysezoxexe.com',
            },
        })
            .then(r => r.ok ? r.json() : null)
            .then(data => sendResponse({ ok: true, data }))
            .catch(() => sendResponse({ ok: false, data: null }));
        return true;
    }

    if (msg.action === "NEXUS_CF_IMPORT") {
        // Routes coomerfans bulk import through background to bypass adblocker
        const { batchName, videos, token } = msg;
        (async () => {
            try {
                const base = await findDashboardUrl();
                const headers = { "Content-Type": "application/json" };
                if (token) headers["X-Nexus-Token"] = token;
                const resp = await fetch(`${base}/api/v1/import/bulk`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ batch_name: batchName, videos }),
                });
                const data = await resp.json().catch(() => ({}));
                sendResponse({ ok: resp.ok, status: resp.status, data, base });
            } catch (e) {
                sendResponse({ ok: false, error: e.message });
            }
        })();
        return true;
    }

    if (msg.action === "FAPHOUSE_JD_PROXY_BASE") {
        (async () => {
            const base = await findDashboardUrl();
            try {
                const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1200) });
                sendResponse({ ok: health.ok, base, error: health.ok ? "" : `Nexus proxy HTTP ${health.status}` });
            } catch (error) {
                sendResponse({ ok: false, base, error: error?.message || "Nexus proxy nie je dostupný" });
            }
        })();
        return true;
    }

    if (msg.action === "NEXUS_CF_UPLOAD_THUMB_BINARY") {
        // Content script fetched the image binary (correct session) — just relay to server
        const { videoId, data, contentType, token } = msg;
        (async () => {
            try {
                const base = await findDashboardUrl();
                const headers = { "Content-Type": contentType || "image/jpeg" };
                if (token) headers["X-Nexus-Token"] = token;
                const resp = await fetch(`${base}/api/v1/thumbnail/${videoId}`, {
                    method: "POST",
                    headers,
                    body: data,
                });
                const d = await resp.json().catch(() => ({}));
                sendResponse({ ok: resp.ok, ...d });
            } catch (e) {
                sendResponse({ ok: false, error: e.message });
            }
        })();
        return true;
    }
});

// --- Action Behavior Logic & Context Menus ---
async function applyActionBehavior() {
    try {
        const stored = await chrome.storage.local.get(["actionBehavior"]);
        const behavior = stored.actionBehavior || "quick_panel";
        if (behavior === "quick_panel") {
            await chrome.action.setPopup({ popup: "popup.html?mode=quick" });
        } else {
            // Full Gallery behavior -> no popup, clicks open dashboard in new tab
            await chrome.action.setPopup({ popup: "" });
        }
    } catch (e) {
        console.warn("[ActionBehavior] Failed to apply action behavior:", e);
    }
}

async function openOrFocusDashboardUrl(targetPath) {
    try {
        const base = await findDashboardUrl();
        const tabs = await chrome.tabs.query({});
        const existing = tabs.find((t) => {
            if (!t.url) return false;
            try {
                const u = new URL(t.url);
                const isNexus = (u.hostname === "127.0.0.1" || u.hostname === "localhost");
                if (!isNexus) return false;
                const pathName = u.pathname.replace(/\/+$/, "") || "/";
                if (targetPath === "/discovery-hub") {
                    return pathName === "/discovery-hub" || u.searchParams.get("hub") === "discovery" || u.searchParams.has("discovery_hub");
                }
                if (targetPath === "/tester") {
                    return pathName === "/tester";
                }
                if (targetPath === "/") {
                    return pathName === "/" && !u.searchParams.has("hub") && !u.searchParams.has("discovery_hub");
                }
                return pathName === targetPath;
            } catch {
                return false;
            }
        });

        if (existing && existing.id) {
            if (existing.windowId) {
                await chrome.windows.update(existing.windowId, { focused: true });
            }
            await chrome.tabs.update(existing.id, { active: true });
            return;
        }

        const openUrl = targetPath === "/discovery-hub"
            ? `${base}/?hub=discovery`
            : `${base}${targetPath}`;

        await chrome.tabs.create({ url: openUrl, active: true });
    } catch (e) {
        console.warn("[Nexus ContextMenu] Failed to open URL:", targetPath, e);
        const fallbackUrl = targetPath === "/discovery-hub"
            ? "http://localhost:8000/?hub=discovery"
            : `http://localhost:8000${targetPath}`;
        await chrome.tabs.create({ url: fallbackUrl, active: true });
    }
}

function setupContextMenus() {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
            id: "open_nexus_dashboard",
            title: "Otvoriť Dashboard",
            contexts: ["action"]
        });
        chrome.contextMenus.create({
            id: "open_discovery_hub",
            title: "Otvoriť Discovery Hub",
            contexts: ["action"]
        });
        chrome.contextMenus.create({
            id: "open_nexus_tester",
            title: "Otvoriť Tester (/tester)",
            contexts: ["action"]
        });
        chrome.contextMenus.create({
            id: "sep_nav_actions",
            type: "separator",
            contexts: ["action"]
        });
        chrome.contextMenus.create({
            id: "toggle_quick_panel",
            title: "Režim: Quick Panel (Kompaktný)",
            contexts: ["action"]
        });
        chrome.contextMenus.create({
            id: "toggle_full_gallery",
            title: "Režim: Plná Galéria (Nová Karta)",
            contexts: ["action"]
        });
    });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "open_nexus_dashboard") {
        await openOrFocusDashboardUrl("/");
    } else if (info.menuItemId === "open_discovery_hub") {
        await openOrFocusDashboardUrl("/discovery-hub");
    } else if (info.menuItemId === "open_nexus_tester") {
        await openOrFocusDashboardUrl("/tester");
    } else if (info.menuItemId === "toggle_quick_panel") {
        await chrome.storage.local.set({ actionBehavior: "quick_panel" });
    } else if (info.menuItemId === "toggle_full_gallery") {
        await chrome.storage.local.set({ actionBehavior: "full_gallery" });
    }
});

chrome.runtime.onStartup.addListener(() => {
    applyActionBehavior();
    setupContextMenus();
});

chrome.runtime.onInstalled.addListener(() => {
    applyActionBehavior();
    setupContextMenus();
});

applyActionBehavior();

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.actionBehavior) {
        applyActionBehavior();
    }
});

/* ============================================================
   NEXUS RADAR — library-aware browsing (check + quick import)
   Content script batches page URLs; we proxy to the dashboard
   backend (CORS-free thanks to host_permissions).
   ============================================================ */
async function radarBackendBase() {
    // Was reading a "nexus_port" storage key nothing ever writes, so it
    // silently fell back to the 8001 default and every cookie-sync POST
    // (Faphouse/VK/forum) went to a closed port and died in the fetch's
    // own catch{} — findDashboardUrl() already does real port probing
    // (against PORTS, using the "selected_port" key the rest of the
    // extension actually sets) for the exact same problem, so reuse it
    // instead of a second, dead port-selection path.
    return await findDashboardUrl();
}

/* ============================================================
   FORUM HUB COOKIE SYNC — keeps simpcity.netscape.txt / smg.netscape.txt
   current without a manual DevTools copy-paste. `chrome.cookies.getAll`
   sees HttpOnly session/user cookies that content scripts never can, so
   this is the only place that can automate the export end to end.
   ============================================================ */
const FORUM_COOKIE_BOARDS = [
    { board: "simpcity", domain: "simpcity.cr" },
    { board: "smg", domain: "forums.socialmediagirls.com" },
];
const FORUM_COOKIE_ALARM = "forum_cookie_sync";

async function syncForumBoardCookies({ board, domain }) {
    const cookies = await chrome.cookies.getAll({ domain });
    if (!cookies.length) return;

    // Preserve the real browser metadata. In particular, a session cookie is
    // not a far-future cookie and a host-only DDoS-Guard cookie must not be
    // widened to every subdomain.
    const cookie_rows = cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        expirationDate: c.expirationDate || null,
    }));

    const base = await radarBackendBase();
    try {
        await fetch(`${base}/api/forum/cookies/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ board, cookie_rows }),
            signal: AbortSignal.timeout(3000),
        });
    } catch {
        // Dashboard not running right now; next alarm tick will retry.
    }
}

async function syncAllForumCookies() {
    for (const target of FORUM_COOKIE_BOARDS) {
        await syncForumBoardCookies(target);
    }
}

chrome.alarms.create(FORUM_COOKIE_ALARM, { periodInMinutes: 15 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === FORUM_COOKIE_ALARM) syncAllForumCookies();
});
// Also sync right after a fresh login/page load on the forum itself, not just on the timer.
chrome.cookies.onChanged.addListener((info) => {
    if (info.removed) return;
    const target = FORUM_COOKIE_BOARDS.find((t) => info.cookie.domain.endsWith(t.domain));
    if (target) syncForumBoardCookies(target);
});
// An alarm's first tick is delayed by its period. Sync now as well, so a
// browser/extension restart never leaves the Forum Hub with a stale jar.
syncAllForumCookies();

/* ============================================================
   FAPHOUSE COOKIE SYNC — same rationale as the forum sync above:
   chrome.cookies.getAll sees the real logged-in session (including
   HttpOnly cookies) so faphouse_cookies.txt self-heals without a manual
   DevTools export every time it goes stale. Unlike the forum jar, real
   per-cookie expirationDate is sent through (not a fabricated far-future
   date) — Faphouse mixes long-lived auth cookies with short-TTL Cloudflare
   challenge cookies, and the server needs the real numbers to tell a
   genuinely dead cookie from a live one.
   ============================================================ */
const FAPHOUSE_COOKIE_DOMAIN = "faphouse.com";
const FAPHOUSE_COOKIE_ALARM = "faphouse_cookie_sync";

async function syncFaphouseCookies() {
    const cookies = await chrome.cookies.getAll({ domain: FAPHOUSE_COOKIE_DOMAIN });
    if (!cookies.length) return;

    const rows = cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        expirationDate: c.expirationDate || null,
    }));

    const base = await radarBackendBase();
    try {
        await fetch(`${base}/api/v1/faphouse/cookies/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cookies: rows }),
            signal: AbortSignal.timeout(3000),
        });
    } catch {
        // Dashboard not running right now; next alarm tick will retry.
    }
}

chrome.alarms.create(FAPHOUSE_COOKIE_ALARM, { periodInMinutes: 20 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === FAPHOUSE_COOKIE_ALARM) syncFaphouseCookies();
});
// Also sync right after a fresh login on faphouse.com itself, not just on the timer.
chrome.cookies.onChanged.addListener((info) => {
    if (info.removed) return;
    if (info.cookie.domain.endsWith(FAPHOUSE_COOKIE_DOMAIN)) syncFaphouseCookies();
});
// chrome.alarms.create only fires its FIRST tick after periodInMinutes has
// elapsed — without this, a fresh install/reload (or a browser restart,
// which respawns the service worker) would sit on whatever cookie jar
// existed at that moment for up to 20 minutes before the timer ever ran.
syncFaphouseCookies();

/* ============================================================
   FILESTER COOKIE SYNC — same rationale as the Faphouse sync above.
   Filester only needs one cookie (auth_token, a JWT) to authenticate, so
   there's no short-TTL challenge cookie to distinguish from a long-lived
   one — every cookie in the batch just carries its real expirationDate.
   Built after a live sync repeatedly failed with "Exceeded maximum allowed
   redirects" — the on-disk auth_token JWT had expired weeks earlier and
   nothing was refreshing it.
   ============================================================ */
const FILESTER_COOKIE_DOMAIN = "filester.me";
const FILESTER_COOKIE_ALARM = "filester_cookie_sync";
let filesterSyncInFlight = null;
let filesterSyncTimer = null;
let filesterLastSync = { fingerprint: "", at: 0 };

function syncFilesterCookies() {
    if (filesterSyncInFlight) return filesterSyncInFlight;
    filesterSyncInFlight = pushFilesterCookies().finally(() => {
        filesterSyncInFlight = null;
    });
    return filesterSyncInFlight;
}

function scheduleFilesterCookieSync() {
    clearTimeout(filesterSyncTimer);
    filesterSyncTimer = setTimeout(() => {
        if (filesterSyncInFlight) {
            scheduleFilesterCookieSync();
            return;
        }
        syncFilesterCookies().catch(() => {});
    }, 1000);
}

async function pushFilesterCookies() {
    const cookies = await chrome.cookies.getAll({ domain: FILESTER_COOKIE_DOMAIN });
    if (!cookies.length) return;

    const rows = cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        expirationDate: c.expirationDate || null,
    }));

    rows.sort((a, b) => `${a.domain}|${a.path}|${a.name}`.localeCompare(`${b.domain}|${b.path}|${b.name}`));
    const fingerprint = JSON.stringify(rows);
    if (fingerprint === filesterLastSync.fingerprint && Date.now() - filesterLastSync.at < 60000) return;
    const base = await radarBackendBase();
    try {
        const response = await fetch(`${base}/api/v1/filester/cookies/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cookies: rows }),
            signal: AbortSignal.timeout(3000),
        });
        if (response.ok && (await response.json()).success) {
            filesterLastSync = { fingerprint, at: Date.now() };
        }
    } catch {
        // Dashboard not running right now; next alarm tick will retry.
    }
}

const FILEDITCH_COOKIE_DOMAINS = [
    "fileditchfiles.st", "fileditchfiles.me", "fileditch.st", "fileditchvids.st",
    "theditch.st", "freakingfileditch.me", "blehpooffileditchvidsstuff.org",
    "donotsharethesetemplinksyouidiot.st",
];

async function syncFileditchCookies() {
    const all = [];
    for (const domain of FILEDITCH_COOKIE_DOMAINS) {
        all.push(...await chrome.cookies.getAll({ domain }));
    }
    const unique = new Map(all.map((c) => [`${c.domain}|${c.path}|${c.name}`, c]));
    if (!unique.size) return;
    const rows = [...unique.values()].map((c) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        secure: c.secure, expirationDate: c.expirationDate || null,
    }));
    const base = await radarBackendBase();
    try {
        await fetch(`${base}/api/v1/fileditch/cookies/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cookies: rows }),
            signal: AbortSignal.timeout(3000),
        });
    } catch {
        // Dashboard not running right now; the next alarm tick will retry.
    }
}

chrome.alarms.create(FILESTER_COOKIE_ALARM, { periodInMinutes: 20 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === FILESTER_COOKIE_ALARM) {
        syncFilesterCookies();
        syncFileditchCookies();
    }
});
// Also sync right after a fresh login on filester.me itself, not just on the timer.
chrome.cookies.onChanged.addListener((info) => {
    if (info.removed) return;
    if (info.cookie.domain.endsWith(FILESTER_COOKIE_DOMAIN)) scheduleFilesterCookieSync();
    if (FILEDITCH_COOKIE_DOMAINS.some((domain) => info.cookie.domain.endsWith(domain))) syncFileditchCookies();
});
syncFilesterCookies();
syncFileditchCookies();

/* ============================================================
   VK COOKIE SYNC — same rationale, two domains this time: vk.com (the
   desktop site groups/subscriptions are scraped from) and vkvideo.ru (the
   actual video-serving domain). VK's real session cookie is commonly
   HttpOnly, so document.cookie-based approaches can never see it — only
   chrome.cookies.getAll can. Pushes each domain's jar independently so a
   change on either tab syncs just that domain, not a mandatory pair.
   ============================================================ */
const VK_COOKIE_DOMAINS = ["vk.com", "vkvideo.ru"];
const VK_COOKIE_ALARM = "vk_cookie_sync";

async function syncVkDomainCookies(domain) {
    const cookies = await chrome.cookies.getAll({ domain });
    if (!cookies.length) return;

    const rows = cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        expirationDate: c.expirationDate || null,
    }));

    const base = await radarBackendBase();
    try {
        await fetch(`${base}/api/vk/cookies/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cookies: { [domain]: rows } }),
            signal: AbortSignal.timeout(3000),
        });
    } catch {
        // Dashboard not running right now; next alarm tick will retry.
    }
}

async function syncAllVkCookies() {
    for (const domain of VK_COOKIE_DOMAINS) {
        await syncVkDomainCookies(domain);
    }
}

chrome.alarms.create(VK_COOKIE_ALARM, { periodInMinutes: 20 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === VK_COOKIE_ALARM) syncAllVkCookies();
});
// Also sync right after a fresh login on either VK domain, not just on the timer.
chrome.cookies.onChanged.addListener((info) => {
    if (info.removed) return;
    const target = VK_COOKIE_DOMAINS.find((d) => info.cookie.domain.endsWith(d));
    if (target) syncVkDomainCookies(target);
});
// Same reasoning as syncFaphouseCookies() above: don't wait up to 20 minutes
// for the first alarm tick after every install/reload/browser restart.
syncAllVkCookies();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "RADAR_CHECK") {
        (async () => {
            try {
                const base = await radarBackendBase();
                const resp = await fetch(`${base}/api/v1/radar/check`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ urls: msg.urls || [] }),
                });
                if (!resp.ok) { sendResponse({ ok: false, error: `HTTP ${resp.status}` }); return; }
                sendResponse({ ok: true, data: await resp.json() });
            } catch (e) {
                sendResponse({ ok: false, error: String(e) });
            }
        })();
        return true;
    }

    if (msg.action === "RADAR_IMPORT") {
        (async () => {
            try {
                const base = await radarBackendBase();
                const resp = await fetch(`${base}/api/fast-import`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ urls: msg.url, filter_enabled: false }),
                });
                if (!resp.ok) { sendResponse({ ok: false, error: `HTTP ${resp.status}` }); return; }
                const data = await resp.json();
                // Radar index must forget its cache so the badge flips on next scan
                fetch(`${base}/api/v1/radar/refresh`, { method: 'POST' }).catch(() => { });
                sendResponse({ ok: true, data });
            } catch (e) {
                sendResponse({ ok: false, error: String(e) });
            }
        })();
        return true;
    }
});

importScripts('vlc_bridge_background.js');

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!globalThis.NexusBridge) return false;
    if (msg?.action === 'checkNexusHealth') {
        globalThis.NexusBridge.discoverServerBase(PORTS.map((p) => `http://127.0.0.1:${p}`))
            .then(sendResponse);
        return true;
    }
    if (msg?.action === 'getOfflineImportQueue' && galleryOfflineQueue) {
        galleryOfflineQueue.list().then((items) => sendResponse({ ok: true, count: items.length, items }));
        return true;
    }
    if (msg?.action === 'enqueueOfflineImport' && galleryOfflineQueue) {
        galleryOfflineQueue.enqueue({
            source: msg.source || 'Nexus Gallery',
            endpoints: msg.endpoints || ['/api/v1/intake/import', '/api/lite/quick-import'],
            payload: msg.payload || {},
            lastError: msg.lastError || 'Offline',
        }).then((res) => sendResponse({ ok: true, ...res }));
        return true;
    }
    if (msg?.action === 'flushOfflineImportQueue' && galleryOfflineQueue) {
        (async () => {
            const discovered = await globalThis.NexusBridge.discoverServerBase(PORTS.map((p) => `http://127.0.0.1:${p}`));
            if (!discovered.ok) {
                const count = await galleryOfflineQueue.count();
                sendResponse({ ok: false, offline: true, remaining: count });
                return;
            }
            const res = await galleryOfflineQueue.flush(discovered.baseUrl);
            sendResponse(res);
        })();
        return true;
    }
    return false;
});
