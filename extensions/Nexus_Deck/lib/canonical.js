const TRACKING = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "utm_name",
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "igsh",
  "ref",
  "ref_src",
  "ref_url",
  "yclid",
  "vero_id",
]);

const EXPIRING = new Set([
  "token",
  "expires",
  "expiry",
  "signature",
  "sig",
  "policy",
  "key-pair-id",
  "hmac",
]);

const FILE_EXT = /\.(mp4|webm|ogv|ogg|mov|m4v|mkv|m3u8)(?=$|[?#])/i;

export function splitUrls(text) {
  return String(text || "")
    .split(/[\n\r\t ]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 40);
}

export function classifyUrl(raw) {
  const text = String(raw || "").trim();
  if (!text || /\s/.test(text)) return invalid("Neplatná adresa");

  let candidate = text;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) candidate = `https://${candidate}`;

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return invalid("Neplatná adresa");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return invalid("Táto adresa sa nedá importovať");
  }
  if (!url.hostname || !url.hostname.includes(".")) return invalid("Neplatná adresa");
  if (url.username || url.password) return invalid("Adresa nesmie obsahovať heslo");

  const host = url.hostname.toLowerCase();
  url.hash = "";
  url.hostname = host;
  stripParams(url);
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  const canonical = url.href;
  const provider = FILE_EXT.test(url.pathname) ? "file" : "page";
  return {
    ok: true,
    provider,
    canonical,
    videoId: null,
    vimeoHash: null,
    startSec: 0,
    host: host.replace(/^www\./, ""),
  };
}

function invalid(reason) {
  return {
    ok: false,
    reason,
    provider: null,
    canonical: null,
    videoId: null,
    vimeoHash: null,
    startSec: 0,
    host: null,
  };
}

function stripParams(url) {
  for (const key of [...url.searchParams.keys()]) {
    const name = key.toLowerCase();
    if (TRACKING.has(name) || name.startsWith("utm_") || EXPIRING.has(name) || name.startsWith("x-amz-") || name.startsWith("x-goog-")) {
      url.searchParams.delete(key);
    }
  }
}
