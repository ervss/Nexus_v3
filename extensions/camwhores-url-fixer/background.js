const STORAGE_KEY = "cwUrlFixerEnabled";
const LOCALE_STORAGE_KEY = "cwStripLocaleEnabled";
const BYPASS_MODE_STORAGE_KEY = "cwBypassMode";
const BYPASS_ROTATE_IDX_KEY = "cwBypassRotateIdx";

const BYPASS_PROVIDERS = {
  bypass_city: {
    name: "Bypass.city",
    build: (u) => `https://bypass.city/bypass?bypass=${encodeURIComponent(u)}`
  },
  bypass_vip: {
    name: "Bypass.vip",
    build: (u) => `https://bypass.vip/?url=${encodeURIComponent(u)}`
  },
  keybypass: {
    name: "KeyBypass",
    build: (u) => `https://keybypass.net/?url=${encodeURIComponent(u)}`
  }
};
const AUTO_ROTATE_POOL = ["bypass_city", "bypass_vip"];

const LINKVERTISE_DYNAMIC_HOSTS = new Set([
  "link-to.net",
  "link-center.net",
  "link-hub.net",
  "link-target.net",
  "direct-link.net",
  "direct-link.org",
  "linkvertise.com",
  "linkvertise.net",
  "file-link.net",
  "up-to-down.net"
]);

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|svg|ico|bmp|avif)$/i;

// ── Language subdomains ──────────────────────────────────────────────────────
// Sites geo-guess a language and drop you on de.eporner.com / fr.xhamster.com.
// Strip that first label so every URL lands on the site's base host.

const LOCALE_LABELS = new Set([
  "af", "am", "ar", "az", "be", "bg", "bn", "bs", "ca", "cs", "cy", "da", "de",
  "el", "en", "eo", "es", "et", "eu", "fa", "fi", "fil", "fr", "ga", "gl", "gu",
  "he", "hi", "hr", "hu", "hy", "id", "is", "it", "iw", "ja", "ka", "kk", "km",
  "kn", "ko", "ky", "lo", "lt", "lv", "mk", "ml", "mn", "mr", "ms", "mt", "my",
  "ne", "nl", "nb", "nn", "no", "pa", "pl", "pt", "ro", "ru", "si", "sk", "sl",
  "sq", "sr", "sv", "sw", "ta", "te", "th", "tl", "tr", "uk", "ur", "uz", "vi",
  "zh"
]);

// Language subdomains that ARE the content: stripping them changes what you read.
const LOCALE_EXEMPT_SUFFIXES = [
  "wikipedia.org", "wikimedia.org", "wiktionary.org", "wikiquote.org",
  "wikisource.org", "wikibooks.org", "wikiversity.org", "wikivoyage.org",
  "wikinews.org", "stackexchange.com"
];

function isLocaleLabel(label) {
  const l = String(label || "").toLowerCase();
  if (LOCALE_LABELS.has(l)) return true;
  // Region variants: pt-br, zh-cn, zh-hans, en-gb.
  const m = /^([a-z]{2,3})-[a-z0-9]{2,4}$/.exec(l);
  return Boolean(m && LOCALE_LABELS.has(m[1]));
}

function isLocaleExempt(hostname) {
  const h = String(hostname || "").toLowerCase();
  return LOCALE_EXEMPT_SUFFIXES.some((s) => h === s || h.endsWith("." + s));
}

/**
 * "de.eporner.com" -> "eporner.com".  Returns null when nothing to strip.
 *
 * Only ever removes leading locale labels, and never leaves fewer than two
 * labels behind — otherwise "is.gd" (Icelandic "is") would collapse to "gd".
 */
function stripLocaleHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!h || isLocaleExempt(h)) return null;

  const labels = h.split(".");
  let i = 0;
  while (i < labels.length && isLocaleLabel(labels[i]) && labels.length - i > 2) {
    i += 1;
  }
  if (i === 0) return null;

  const stripped = labels.slice(i).join(".");
  return stripped === h ? null : stripped;
}

const BLOCKED_PREFIXES = [
  /^\/login(?:\/|$)/i,
  /^\/signup(?:\/|$)/i,
  /^\/logout(?:\/|$)/i,
  /^\/settings(?:\/|$)/i,
  /^\/account(?:\/|$)/i,
  /^\/terms(?:\/|$)/i,
  /^\/privacy(?:\/|$)/i,
  /^\/contact(?:\/|$)/i
];

function isCamwhoresHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!h) return false;
  if (/^([\w-]+\.)*camwhores\.[a-z0-9.-]+$/.test(h)) return true;
  if (/^([\w-]+\.)*camwhoreshd\.[a-z0-9.-]+$/.test(h)) return true;
  return false;
}

function isSocialMediaGirlsHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!h) return false;
  return /^([\w-]+\.)*socialmediagirls\.[a-z0-9.-]+$/.test(h);
}

function isSpeedyLinksHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!h) return false;
  return h === "speedy-links.com" || h.endsWith(".speedy-links.com");
}

function isLinkvertiseDynamicHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^www\./, "");
  return LINKVERTISE_DYNAMIC_HOSTS.has(h);
}

function extractLinkvertiseDynamicTarget(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!isLinkvertiseDynamicHost(u.hostname) && !/\/dynamic(?:\/|$)/i.test(u.pathname)) return null;

  const rawR = u.searchParams.get("r");
  if (!rawR) return null;

  const direct = tryParseHttpUrl(rawR);
  if (direct) return direct;

  const decoded = decodeBase64Utf8(rawR);
  if (!decoded) return null;
  const directDecoded = tryParseHttpUrl(decoded.trim());
  if (directDecoded) return directDecoded;
  try {
    return tryParseHttpUrl(decodeURIComponent(decoded.trim()));
  } catch {
    return null;
  }
}

function extractSpeedyLinksBypassTarget(url, providerId = "bypass_city") {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!isSpeedyLinksHost(u.hostname)) return null;

  // Presmerujeme len konkrétne odkazy (napr. /s?52Q1eEA6), nie prázdnu domovskú stránku.
  const hasPath = Boolean(u.pathname && u.pathname !== "/");
  const hasSearch = Boolean(u.search && u.search !== "?");
  if (!hasPath && !hasSearch) return null;

  const prov = BYPASS_PROVIDERS[providerId] || BYPASS_PROVIDERS.bypass_city;
  return prov.build(u.href);
}

function normalizeBase64(input) {
  const value = String(input || "").trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!value) return "";

  const padding = value.length % 4;
  if (padding === 0) return value;
  if (padding === 1) return "";

  return value + "=".repeat(4 - padding);
}

function decodeBase64Utf8(input) {
  const normalized = normalizeBase64(input);
  if (!normalized) return null;

  try {
    return atob(normalized);
  } catch {
    return null;
  }
}

function tryParseHttpUrl(rawValue) {
  if (!rawValue) return null;

  try {
    const target = new URL(rawValue);
    if (target.protocol !== "http:" && target.protocol !== "https:") return null;
    return target.href;
  } catch {
    return null;
  }
}

function getCanonicalHost(hostname, stripLocale = true) {
  const h = String(hostname || "").toLowerCase();
  if (!h) return null;

  // Keep XVideos paths, query strings and fragments when moving off .red.
  if (h === "xvideos.red" || h.endsWith(".xvideos.red")) {
    const host = h.slice(0, -"red".length) + "com";
    return (stripLocale && stripLocaleHost(host)) || host;
  }

  // Bunkr moves between TLDs; keep every Bunkr subdomain on the current .cr host.
  if (/^([\w-]+\.)*bunkr\.[a-z0-9.-]+$/.test(h)) {
    return "bunkr.cr";
  }

  if (/^([\w-]+\.)*simpcity\.[a-z0-9.-]+$/.test(h)) {
    return "simpcity.cr";
  }

  if (/^([\w-]+\.)*pornhu?b\.(?!com$)[a-z0-9.-]+$/.test(h)) {
    return "pornhub.com";
  }

  if (/^([\w-]+\.)*filester\.[a-z0-9.-]+$/.test(h)) {
    return "filester.me";
  }

  if (isCamwhoresHost(h)) {
    return "www.camwhores.tv";
  }

  // Presmerovanie pre mobilné verzie VK a VK Video na ich desktopové (PC) verzie
  if (h === "m.vkvideo.ru") {
    return "vkvideo.ru";
  }

  if (h === "m.vkvideo.com") {
    return "vkvideo.com";
  }

  if (h === "m.vk.com") {
    return "vk.com";
  }

  if (h === "m.vk.ru") {
    return "vk.ru";
  }

  // Generic, last: applies to every site that isn't special-cased above.
  if (stripLocale) {
    const stripped = stripLocaleHost(h);
    if (stripped) return stripped;
  }

  return null;
}

function extractSocialMediaGirlsRedirectTarget(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }

  if (!isSocialMediaGirlsHost(u.hostname)) return null;
  if (!/^\/goto\/link-confirmation(?:\/|$)/i.test(u.pathname)) return null;

  const rawTarget = u.searchParams.get("url");
  if (!rawTarget) return null;

  const directTarget = tryParseHttpUrl(rawTarget);
  if (directTarget) return directTarget;

  const decodedTarget = decodeBase64Utf8(rawTarget);
  if (decodedTarget) {
    return tryParseHttpUrl(decodedTarget);
  }

  return null;
}

function isBlockedPath(pathname) {
  const p = pathname || "/";
  if (IMAGE_EXT.test(p)) return true;
  if (p.toLowerCase().startsWith("/api")) return true;
  if (/\/(admin|dashboard)(?:\/|$)/i.test(p)) return true;
  for (const re of BLOCKED_PREFIXES) {
    if (re.test(p)) return true;
  }
  return false;
}

function matchesRedirectPattern(pathname) {
  const p = pathname || "/";
  if (/^\/videos\/\d+/i.test(p)) return true;
  if (/^\/members\/\d+/i.test(p)) return true;
  if (/^\/albums\/\d+/i.test(p)) return true;
  if (/^\/photos(?:\/|$)/i.test(p)) return true;
  if (/^\/categories(?:\/|$)/i.test(p)) return true;
  if (/^\/search(?:\/|$)/i.test(p)) return true;
  return false;
}

function shouldHandleUrl(href, stripLocale = true, bypassMode = "auto") {
  if (extractLinkvertiseDynamicTarget(href)) {
    return true;
  }
  if (extractSocialMediaGirlsRedirectTarget(href)) {
    return true;
  }
  if (bypassMode !== "off" && extractSpeedyLinksBypassTarget(href)) {
    return true;
  }

  let u;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const canonicalHost = getCanonicalHost(u.hostname, stripLocale);
  if (!canonicalHost) return false;

  if (canonicalHost === "www.camwhores.tv") {
    if (isBlockedPath(u.pathname)) return false;
    if (!matchesRedirectPattern(u.pathname)) return false;
  }

  return true;
}

function buildCanonical(href, stripLocale = true, bypassProviderId = "bypass_city", bypassMode = "auto") {
  const dynamicTarget = extractLinkvertiseDynamicTarget(href);
  if (dynamicTarget) {
    return dynamicTarget;
  }
  const socialMediaGirlsTarget = extractSocialMediaGirlsRedirectTarget(href);
  if (socialMediaGirlsTarget) {
    return socialMediaGirlsTarget;
  }
  if (bypassMode !== "off") {
    const speedyLinksTarget = extractSpeedyLinksBypassTarget(href, bypassProviderId);
    if (speedyLinksTarget) {
      return speedyLinksTarget;
    }
  }

  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }

  const canonicalHost = getCanonicalHost(u.hostname, stripLocale);
  if (!canonicalHost) return null;

  if (canonicalHost === "www.camwhores.tv") {
    const isSearch = /^\/search(?:\/|$)/i.test(u.pathname);
    let path = u.pathname || "/";
    if (!path.endsWith("/")) path += "/";

    let search = "";
    if (isSearch) {
      search = u.search || "";
    }

    return `https://${canonicalHost}${path}${search}`;
  }

  return `https://${canonicalHost}${u.pathname || "/"}${u.search || ""}${u.hash || ""}`;
}

function sameHref(a, b) {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

async function getSettings() {
  const values = await chrome.storage.sync.get({
    [STORAGE_KEY]: true,
    [LOCALE_STORAGE_KEY]: true,
    [BYPASS_MODE_STORAGE_KEY]: "auto"
  });
  return {
    enabled: values[STORAGE_KEY] !== false,
    stripLocale: values[LOCALE_STORAGE_KEY] !== false,
    bypassMode: String(values[BYPASS_MODE_STORAGE_KEY] || "auto")
  };
}

async function pickNextBypassProvider(bypassMode) {
  if (bypassMode && bypassMode !== "auto" && BYPASS_PROVIDERS[bypassMode]) {
    return bypassMode;
  }
  try {
    const data = await chrome.storage.local.get({ [BYPASS_ROTATE_IDX_KEY]: -1 });
    const nextIdx = (Number(data[BYPASS_ROTATE_IDX_KEY] ?? -1) + 1) % AUTO_ROTATE_POOL.length;
    await chrome.storage.local.set({ [BYPASS_ROTATE_IDX_KEY]: nextIdx });
    return AUTO_ROTATE_POOL[nextIdx] || "bypass_city";
  } catch {
    return "bypass_city";
  }
}

let creatingOffscreen;

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) return false;
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");

  if (typeof chrome.runtime.getContexts === "function") {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });
    if (existing.length > 0) return true;
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
    return true;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: [chrome.offscreen.Reason.CLIPBOARD],
    justification: "Copy Speedy-Links URL to clipboard before redirecting to bypass.city."
  });

  try {
    await creatingOffscreen;
    return true;
  } catch (err) {
    if (String(err?.message || "").includes("Only a single offscreen document")) {
      return true;
    }
    return false;
  } finally {
    creatingOffscreen = null;
  }
}

async function copyToClipboard(text) {
  try {
    const ready = await ensureOffscreenDocument();
    if (!ready) return;
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "copy-to-clipboard",
      text
    });
  } catch {
    // Kopírovanie do schránky je doplnkové; nesmie zablokovať presmerovanie.
  }
}

const redirectInFlight = new Set();

async function redirectTabIfNeeded(tabId, href) {
  if (!Number.isInteger(tabId) || !href || redirectInFlight.has(tabId)) return;
  redirectInFlight.add(tabId);
  try {
    const { enabled, stripLocale, bypassMode } = await getSettings();
    if (!enabled || !shouldHandleUrl(href, stripLocale, bypassMode)) return;

    const isSpeedy = bypassMode !== "off" && Boolean(extractSpeedyLinksBypassTarget(href));
    const providerId = isSpeedy ? await pickNextBypassProvider(bypassMode) : "bypass_city";
    const next = buildCanonical(href, stripLocale, providerId, bypassMode);
    if (!next || sameHref(href, next)) return;

    if (isSpeedy) {
      await copyToClipboard(href);
    }

    await chrome.tabs.update(tabId, { url: next });
  } catch {
    // The tab may have been closed between the navigation event and update.
  } finally {
    redirectInFlight.delete(tabId);
  }
}

if (typeof chrome !== "undefined" && chrome.webNavigation && chrome.tabs) {
  // No host filter: locale subdomains show up on any site, so every top-level
  // navigation is inspected. The check is a cheap string test on the hostname.
  chrome.webNavigation.onBeforeNavigate.addListener(
    (details) => {
      if (details.frameId !== 0) return;
      void redirectTabIfNeeded(details.tabId, details.url);
    },
    { url: [{ schemes: ["http", "https"] }] }
  );

  // Fallback for typed/pasted URLs and navigations that are committed before
  // webNavigation delivers onBeforeNavigate. changeInfo.url is only present
  // for a real top-level URL change, so this does not react to page fragments
  // or title/loading updates.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!changeInfo.url) return;
    void redirectTabIfNeeded(tabId, changeInfo.url);
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    extractLinkvertiseDynamicTarget,
    extractSpeedyLinksBypassTarget,
    buildCanonical,
    shouldHandleUrl,
    BYPASS_PROVIDERS,
    AUTO_ROTATE_POOL
  };
}
