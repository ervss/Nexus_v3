try { importScripts('listing-player-network.js'); } catch { }
try { importScripts('archve-meta.js'); } catch { }
try { importScripts('spankbang-listing.js'); } catch { }
try { importScripts('lib/nexus_bridge.js'); } catch { }
// ============================================================
// Nexus Video Card Selector — Background Service Worker
// ============================================================
// Vykonáva fetche bez CORS obmedzení, cachuje výsledky,
// spracováva správy z content skriptu.
// ============================================================

// v10 adds explicit failure reasons. Successful v9 measurements are migrated
// lazily so an extension update does not throw away already measured cards.
try { importScripts('xhamster-meta.js'); } catch { }

const CACHE_PREFIX = 'nvs_meta_v10:';
const CACHE_FALLBACK_PREFIXES = ['nvs_meta_v9:'];
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 60; // 60 dní

// ── Cache helpers ────────────────────────────────────────────

async function readCache(url) {
  try {
    const key = CACHE_PREFIX + url;
    const keys = [key, ...CACHE_FALLBACK_PREFIXES.map(prefix => prefix + url)];
    const result = await chrome.storage.local.get(keys);
    let data = result[key];
    if (!data) {
      data = keys.slice(1).map(oldKey => result[oldKey]).find(item => Number(item?.sizeMb || 0) > 0) || null;
      if (data) await chrome.storage.local.set({ [key]: data });
    }
    if (!data || !data.ts) return null;
    if (Date.now() - data.ts > CACHE_TTL_MS) {
      chrome.storage.local.remove(key);
      return null;
    }
    return data;
  } catch { return null; }
}

async function writeCache(url, meta) {
  try {
    const key = CACHE_PREFIX + url;
    const existing = (await chrome.storage.local.get(key))?.[key];
    const merged = existing && typeof existing === 'object' && !meta?.failureReason
      ? {
          ...existing,
          ...meta,
          date: meta.date || existing.date || null,
          duration: meta.duration || existing.duration || null,
          quality: meta.quality || existing.quality || null,
          sizeMb: Number(meta.sizeMb || 0) > 0 ? meta.sizeMb : (existing.sizeMb || null),
          sizeText: meta.sizeText || existing.sizeText || null,
          streamUrl: meta.streamUrl || existing.streamUrl || null,
        }
      : meta;
    await chrome.storage.local.set({ [key]: { ...merged, ts: Date.now() } });
  } catch (_) { }
}

// ── Cache admin (história kariet na disku: chrome.storage.local) ──────
async function nvsCacheEntries(host) {
  const all = await chrome.storage.local.get(null);
  const wanted = host ? String(host).replace(/^www\./, '') : '';
  const out = {};
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(CACHE_PREFIX) || !value || typeof value !== 'object') continue;
    const url = key.slice(CACHE_PREFIX.length);
    if (wanted) {
      try {
        const h = new URL(url).hostname.replace(/^www\./, '');
        if (h !== wanted && !h.endsWith('.' + wanted) && !wanted.endsWith('.' + h)) continue;
      } catch { continue; }
    }
    out[url] = value;
  }
  return out;
}

async function nvsCacheAdmin({ action, host, entries } = {}) {
  if (action === 'stats') {
    const all = await nvsCacheEntries(host);
    const list = Object.values(all);
    const stamps = list.map(v => Number(v.ts) || 0).filter(Boolean);
    return {
      ok: true, count: list.length, bytes: JSON.stringify(all).length,
      oldest: stamps.length ? Math.min(...stamps) : 0,
      newest: stamps.length ? Math.max(...stamps) : 0,
    };
  }
  if (action === 'export') return { ok: true, entries: await nvsCacheEntries(host) };
  if (action === 'clear') {
    const keys = Object.keys(await nvsCacheEntries(host)).map(url => CACHE_PREFIX + url);
    if (keys.length) await chrome.storage.local.remove(keys);
    return { ok: true, removed: keys.length };
  }
  if (action === 'import') {
    const batch = {};
    let imported = 0;
    for (const [url, meta] of Object.entries(entries || {})) {
      if (!/^https?:\/\//i.test(url) || !meta || typeof meta !== 'object') continue;
      batch[CACHE_PREFIX + url] = { ...meta, ts: Number(meta.ts) || Date.now() };
      imported++;
    }
    if (imported) await chrome.storage.local.set(batch);
    return { ok: true, imported };
  }
  return { ok: false, error: 'unknown action' };
}


async function fetchPimpBunnySizeViaTab(url, tabId) {
  if (!tabId || !url) return null;
  return await new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { action: 'nvsProbeMediaSize', url }, response => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      const sizeMb = Number(response?.sizeMb || 0);
      resolve(Number.isFinite(sizeMb) && sizeMb > 0 ? sizeMb : null);
    });
  });
}

// ── HTML Fetcher ─────────────────────────────────────────────

async function fetchHtml(url, timeoutMs = 0) {
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      credentials: 'include',
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
  finally { if (timer) clearTimeout(timer); }
}

// ── Metadata Extractors ─────────────────────────────────────

/**
 * Extrahuje uploadDate z JSON-LD, meta tagov, time elementov.
 */
function extractDate(html) {
  if (!html) return null;

  // 1. JSON-LD
  const ldMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of ldMatches) {
    try {
      const data = JSON.parse(m[1]);
      const found = findDeep(data, ['uploadDate', 'datePublished', 'dateCreated']);
      if (found) return normalizeDate(found);
    } catch {
      const m2 = m[1].match(/"(?:uploadDate|datePublished)"\s*:\s*"([^"]+)"/i);
      if (m2?.[1]) return normalizeDate(m2[1]);
    }
  }

  // 2. Meta tags
  const metaPatterns = [
    /<meta[^>]+itemprop=["'](?:uploadDate|datePublished)["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+itemprop=["'](?:uploadDate|datePublished)["']/i,
    /<meta[^>]+property=["']video:release_date["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["'](?:date|publish-date|upload-date)["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const p of metaPatterns) {
    const m = html.match(p);
    if (m?.[1]) return normalizeDate(m[1]);
  }

  // 3. <time datetime="...">
  const timeM = html.match(/<time[^>]+datetime=["']([^"']+)["']/i);
  if (timeM?.[1]) return normalizeDate(timeM[1]);

  // 4. Regex patterns v texte stránky
  const datePatterns = [
    // "Added: Jan 15, 2024" / "Uploaded: 2024-01-15"
    /(?:added|uploaded|published|date)\s*[:\-]?\s*(\d{1,2}\s+\w+\s+\d{4})/i,
    /(?:added|uploaded|published|date)\s*[:\-]?\s*(\w+\s+\d{1,2},?\s+\d{4})/i,
    /(?:added|uploaded|published|date)\s*[:\-]?\s*(\d{4}-\d{2}-\d{2})/i,
  ];
  for (const p of datePatterns) {
    const m = html.match(p);
    if (m?.[1]) return normalizeDate(m[1]);
  }

  return null;
}

async function fetchHeadSize(mp4Url, referer = '', exactBytes = false, outMeta = null) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout
  const headers = {
    'Accept': '*/*'
  };
  const referrerOptions = referer
    ? { referrer: referer, referrerPolicy: 'strict-origin-when-cross-origin' }
    : {};

  try {
    const res = await fetch(mp4Url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      credentials: 'include',
      headers,
      ...referrerOptions,
    });
    clearTimeout(timeoutId);

    const len = res.headers.get('content-length');
    const contentType = res.headers.get('content-type') || '';
    if (res.ok && /mpegurl/i.test(contentType)) {
      if (outMeta && typeof outMeta === 'object') {
        outMeta.isHls = true;
        outMeta.finalUrl = res.url || mp4Url;
      }
      return null;
    }
    if (res.ok && len && !/text\/html|application\/xhtml|application\/json/i.test(contentType)) {
      if (outMeta && typeof outMeta === 'object') {
        outMeta.lastModified = res.headers.get('last-modified') || '';
      }
      const bytes = parseInt(len, 10);
      return exactBytes ? bytes : Math.round(bytes / (1024 * 1024));
    }
  } catch (e) {
    // Silent fail
  } finally {
    clearTimeout(timeoutId);
  }

  // Fallback: GET request s Range: bytes=0-0 (stiahne iba 1 bajt, ak server nepodporuje HEAD)
  const controllerGet = new AbortController();
  const timeoutIdGet = setTimeout(() => controllerGet.abort(), 5000);

  try {
    const res = await fetch(mp4Url, {
      method: 'GET',
      headers: { ...headers, 'Range': 'bytes=0-0' },
      redirect: 'follow',
      credentials: 'include',
      signal: controllerGet.signal,
      ...referrerOptions,
    });
    clearTimeout(timeoutIdGet);

    // Okamžite po získaní hlavičiek prerušíme sťahovanie tela
    controllerGet.abort();

    const contentRange = res.headers.get('content-range');
    if (res.status === 206 && !/text\/html|application\/xhtml|application\/json/i.test(res.headers.get('content-type') || '') && contentRange) {
      const match = contentRange.match(/\/(\d+)/);
      if (match) {
        if (outMeta && typeof outMeta === 'object') {
          outMeta.lastModified = res.headers.get('last-modified') || '';
        }
        const bytes = parseInt(match[1], 10);
        return exactBytes ? bytes : Math.round(bytes / (1024 * 1024));
      }
    }

    const len = res.headers.get('content-length');
    const contentType = res.headers.get('content-type') || '';
    if (len && res.status === 200 && !/text\/html|application\/xhtml|application\/json/i.test(contentType)) {
      if (outMeta && typeof outMeta === 'object') {
        outMeta.lastModified = res.headers.get('last-modified') || '';
      }
      const bytes = parseInt(len, 10);
      return exactBytes ? bytes : Math.round(bytes / (1024 * 1024));
    }
  } catch (e) {
    // Silent fail
  } finally {
    clearTimeout(timeoutIdGet);
  }

  return null;
}

function parseMp4MoovMeta(bytes) {
  if (!bytes || bytes.length < 32) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const findBox = (tag, start = 0) => {
    const a = tag.charCodeAt(0), b = tag.charCodeAt(1), c = tag.charCodeAt(2), d = tag.charCodeAt(3);
    for (let i = start; i <= bytes.length - 8; i++) {
      if (bytes[i] === a && bytes[i + 1] === b && bytes[i + 2] === c && bytes[i + 3] === d) return i;
    }
    return -1;
  };

  let duration = null;
  const mvhdIdx = findBox('mvhd', 0);
  if (mvhdIdx >= 0 && mvhdIdx + 28 <= bytes.length) {
    const ver = view.getUint8(mvhdIdx + 4);
    if (ver === 1 && mvhdIdx + 36 <= bytes.length) {
      const timescale = view.getUint32(mvhdIdx + 24);
      const durUnits = Number(view.getBigUint64(mvhdIdx + 28));
      if (timescale > 0 && durUnits > 0) {
        const secs = Math.round(durUnits / timescale);
        if (secs >= 5 && secs < 86400) {
          const h = Math.floor(secs / 3600);
          const m = Math.floor((secs % 3600) / 60);
          const s = secs % 60;
          duration = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
        }
      }
    } else if (ver === 0) {
      const timescale = view.getUint32(mvhdIdx + 16);
      const durUnits = view.getUint32(mvhdIdx + 20);
      if (timescale > 0 && durUnits > 0) {
        const secs = Math.round(durUnits / timescale);
        if (secs >= 5 && secs < 86400) {
          const h = Math.floor(secs / 3600);
          const m = Math.floor((secs % 3600) / 60);
          const s = secs % 60;
          duration = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
        }
      }
    }
  }

  let maxDim = 0;
  let pos = 0;
  while ((pos = findBox('tkhd', pos)) >= 0) {
    if (pos + 5 <= bytes.length) {
      const ver = view.getUint8(pos + 4);
      const off = ver === 1 ? pos + 92 : pos + 80;
      if (off + 8 <= bytes.length) {
        const w = view.getUint32(off) >>> 16;
        const h = view.getUint32(off + 4) >>> 16;
        if (w >= 120 && h >= 120 && w <= 7680 && h <= 4320) {
          const minSide = Math.min(w, h);
          if (minSide > maxDim) maxDim = minSide;
        }
      }
    }
    pos += 4;
  }

  let quality = null;
  if (maxDim >= 2160) quality = '4K';
  else if (maxDim >= 1440) quality = '1440P';
  else if (maxDim >= 1080) quality = '1080P';
  else if (maxDim >= 720) quality = '720P';
  else if (maxDim >= 400) quality = '480P';
  else if (maxDim >= 320) quality = '360P';
  else if (maxDim > 0) quality = '240P';

  return (duration || quality) ? { duration, quality } : null;
}

async function probeMp4HeaderMeta(mp4Url, referer = '', totalBytes = 0) {
  if (!mp4Url || /\.m3u8(?:[?#]|$)/i.test(mp4Url)) return null;
  const referrerOptions = referer
    ? { referrer: referer, referrerPolicy: 'strict-origin-when-cross-origin' }
    : {};

  const fetchRange = async (rangeStr) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(mp4Url, {
          method: 'GET',
          headers: { 'Accept': '*/*', 'Range': rangeStr },
          redirect: 'follow',
          credentials: 'include',
          signal: AbortSignal.timeout(9000),
          ...referrerOptions,
        });
        if (!res.ok) return null;
        const ct = res.headers.get('content-type') || '';
        if (/text\/html|application\/xhtml|application\/json|image\//i.test(ct)) return null;
        const cr = res.headers.get('content-range') || '';
        const crTotal = Number(cr.split('/').pop() || 0) || 0;
        const buf = new Uint8Array(await res.arrayBuffer());
        return { buf, total: crTotal };
      } catch {
        if (attempt === 1) return null;
      }
    }
    return null;
  };

  try {
    const first = await fetchRange('bytes=0-65535');
    if (!first) return null;
    let parsed = parseMp4MoovMeta(first.buf);
    const knownTotal = Number(totalBytes || 0) || first.total || 0;

    if ((!parsed?.duration || !parsed?.quality) && knownTotal > 65536) {
      const tailStart = Math.max(0, knownTotal - 131072);
      const tail = await fetchRange(`bytes=${tailStart}-${knownTotal - 1}`);
      if (tail) {
        const tailParsed = parseMp4MoovMeta(tail.buf);
        if (tailParsed) {
          parsed = {
            duration: parsed?.duration || tailParsed.duration || null,
            quality: parsed?.quality || tailParsed.quality || null,
          };
        }
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

// IQ 300 HLS Parser (Pre weby ako XVideos, ktoré skrývajú 1080p do m3u8 streamu)
async function fetchTextViaTabOrDirect(url, tabId, referer = '') {
  const fetchFromTab = () => new Promise(resolve => {
    if (!tabId) { resolve(null); return; }
    chrome.tabs.sendMessage(tabId, { action: 'nvsFetchText', url }, response => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(response);
    });
  });

  if (tabId && !referer) {
    const text = await fetchFromTab();
    if (text) return text;
  }
  const referrerOptions = referer
    ? { referrer: referer, referrerPolicy: 'strict-origin-when-cross-origin' }
    : {};
  try {
    const res = await fetch(url, {
      credentials: 'include',
      ...referrerOptions,
    });
    if (res.ok) return res.text();
  } catch { }

  if (tabId && referer) {
    const text = await fetchFromTab();
    if (text) return text;
  }
  return '';
}

// Sčíta reálnu veľkosť VOD z media (variant) HLS playlistu tak, že HEADne
// každý .ts segment a spočíta Content-Length — presne ako to robí IDM.
// Presnejšie než odhad z BANDWIDTH × trvanie, ktorý pri orezaných klipoch
// (Beeg fl_duration = dĺžka CELEJ scény, nie klipu) vie byť rádovo mimo.
async function sumHlsSegmentBytes(variantUrl, referer = '', sampleLimit = 0, prefetchedText = null) {
  const referrerOptions = referer
    ? { referrer: referer, referrerPolicy: 'strict-origin-when-cross-origin' }
    : {};
  let text = prefetchedText;
  if (text == null) {
    const res = await fetch(variantUrl, { credentials: 'include', ...referrerOptions });
    if (!res.ok) return null;
    text = await res.text();
  }

  const lines = text.split(/\r?\n/);
  const segUrls = [];
  let totalDuration = 0;
  for (let i = 0; i < lines.length; i++) {
    const extinf = lines[i].match(/^#EXTINF:([\d.]+)/);
    if (!extinf) continue;
    totalDuration += parseFloat(extinf[1]);
    const segLine = (lines[i + 1] || '').trim();
    if (segLine && !segLine.startsWith('#')) {
      segUrls.push(segLine.startsWith('http') ? segLine : new URL(segLine, variantUrl).href);
    }
  }
  if (!segUrls.length) return null;

  const requestedSegments = sampleLimit > 0 ? segUrls.slice(0, sampleLimit) : segUrls;
  const CONCURRENCY = sampleLimit > 0 ? 3 : 12;
  let totalBytes = 0;
  let failed = 0;
  for (let i = 0; i < requestedSegments.length; i += CONCURRENCY) {
    const batch = requestedSegments.slice(i, i + CONCURRENCY);
    const sizes = await Promise.all(batch.map(async (u) => {
      try {
        const head = await fetch(u, { method: 'HEAD', credentials: 'include', ...referrerOptions });
        const headLength = Number(head.headers.get('content-length') || 0) || 0;
        if (head.ok && headLength > 0) return headLength;

        const ranged = await fetch(u, {
          method: 'GET',
          credentials: 'include',
          headers: { Range: 'bytes=0-0' },
          ...referrerOptions,
        });
        const total = Number((ranged.headers.get('content-range') || '').split('/').pop() || 0)
          || Number(ranged.headers.get('content-length') || 0)
          || 0;
        try { await ranged.body?.cancel(); } catch { }
        return total;
      } catch { return 0; }
    }));
    for (const s of sizes) {
      if (s > 0) totalBytes += s; else failed++;
    }
  }
  // Ak väčšina HEAD requestov zlyhala, výsledok nie je dôveryhodný.
  if (failed > requestedSegments.length * 0.34) return null;

  if (sampleLimit > 0 && requestedSegments.length < segUrls.length) {
    totalBytes = Math.round((totalBytes / requestedSegments.length) * segUrls.length);
  }

  return { bytes: totalBytes, seconds: totalDuration };
}

async function fetchHlsQualityAndSize(m3u8Url, durationStr, tabId, referer = '', sampleLimit = 0) {
  try {
    const text = await fetchTextViaTabOrDirect(m3u8Url, tabId, referer);
    if (!text) return null;

    // Hľadáme všetky kvality v playliste. AVERAGE-BANDWIDTH je pri VOD
    // presnejší než maximálny BANDWIDTH, preto ho uprednostníme.
    const streamRegex = /^#EXT-X-STREAM-INF:([^\r\n]+)\r?\n([^\r\n]+)/gmi;

    let maxBandwidth = 0;
    let bestQ = null;
    let bestVariantPath = null;

    let m;
    while ((m = streamRegex.exec(text)) !== null) {
      const attributes = m[1];
      const bandwidthMatch = attributes.match(/(?:AVERAGE-)?BANDWIDTH=(\d+)/i);
      const resolutionMatch = attributes.match(/RESOLUTION=\d+x(\d+)/i);
      const nameMatch = attributes.match(/NAME=["']?([^,"']+)/i);
      const bandwidth = parseInt(bandwidthMatch?.[1] || '0', 10);
      if (bandwidth > maxBandwidth) {
        maxBandwidth = bandwidth;
        // Ak má explicitné meno "1080p", zoberieme to, inak zoberieme z rozlíšenia napr. 1080 -> 1080p
        if (nameMatch?.[1]) {
          bestQ = nameMatch[1].toUpperCase();
        } else if (resolutionMatch?.[1]) {
          bestQ = `${resolutionMatch[1]}P`;
        }
        bestVariantPath = m[2].trim();
      }
    }

    // Toto je master playlist (obsahuje viacero kvalít) — najpresnejšia cesta
    // je fetchnúť konkrétny variant a spočítať reálne bajty zo segmentov.
    if (bestVariantPath) {
      const variantUrl = bestVariantPath.startsWith('http')
        ? bestVariantPath
        : new URL(bestVariantPath, m3u8Url).href;
      try {
        const summed = await sumHlsSegmentBytes(variantUrl, referer, sampleLimit);
        if (summed && summed.bytes > 0) {
          const mb = Math.round(summed.bytes / (1024 * 1024));
          if (mb > 0) return { quality: bestQ, mb, seconds: summed.seconds };
        }
      } catch {
        // padneme na odhad nižšie
      }
    }

    // Niektoré CDN (vrátane Beeg) posielajú VOD ako jeden byte-range HLS
    // playlist. Vtedy vieme spočítať skutočné bajty bez sťahovania segmentov.
    const byteRanges = [...text.matchAll(/^#EXT-X-BYTERANGE:(\d+)(?:@\d+)?\s*$/gmi)];
    if (byteRanges.length) {
      const bytes = byteRanges.reduce((sum, match) => sum + Number.parseInt(match[1], 10), 0);
      const mb = Math.round(bytes / (1024 * 1024));
      if (mb > 0) return { quality: bestQ, mb };
    }

    // Priamo media playlist (nie master) — tiež vieme spočítať segmenty.
    if (!bestVariantPath && /^#EXTINF:/mi.test(text)) {
      try {
        const summed = await sumHlsSegmentBytes(m3u8Url, referer, sampleLimit);
        if (summed && summed.bytes > 0) {
          const mb = Math.round(summed.bytes / (1024 * 1024));
          if (mb > 0) return { quality: bestQ, mb, seconds: summed.seconds };
        }
      } catch {
        // padneme na odhad nižšie
      }
    }

    if (maxBandwidth > 0 && durationStr) {
      // Máme maximálny bandwidth v bitoch za sekundu (napr. 3 375 104 bps pre 1080p)
      // Vypočítame sekundy z durationStr
      let seconds = 0;
      if (/\d+:\d+/.test(durationStr)) {
        const parts = durationStr.split(':').map(Number);
        if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
        else if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
      } else {
        const dMatch = durationStr.match(/(\d+)\s*m/i);
        if (dMatch) seconds = parseInt(dMatch[1], 10) * 60;
      }

      if (seconds > 0) {
        // bit/s * sekundy = celkové bity. Bity / 8 = Bajty. Bajty / 1024 / 1024 = MB.
        const mbSize = Math.round((maxBandwidth * seconds) / (8 * 1024 * 1024));
        return { quality: bestQ, mb: mbSize };
      }
    }
  } catch (e) {
    // Silent fail
  }
  return null;
}

function formatSizeMb(mb) {
  if (!Number.isFinite(mb) || mb <= 0) return null;
  if (mb < 1) return null;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${Math.round(mb)} MB`;
}

function parseDurationToSeconds(durationStr) {
  if (!durationStr) return 0;
  if (/\d+:\d+/.test(durationStr)) {
    const parts = durationStr.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
  }

  const h = durationStr.match(/(\d+)\s*h/i);
  const m = durationStr.match(/(\d+)\s*m/i);
  const s = durationStr.match(/(\d+)\s*s/i);
  return (h ? parseInt(h[1], 10) * 3600 : 0)
    + (m ? parseInt(m[1], 10) * 60 : 0)
    + (s ? parseInt(s[1], 10) : 0);
}

function isReasonableSizeEstimate(mb, durationStr) {
  if (!Number.isFinite(mb) || mb <= 0) return false;
  if (mb > 250 * 1024) return false; // hard stop: >250 GB

  const seconds = parseDurationToSeconds(durationStr);
  if (seconds <= 0) {
    // Neznáma dĺžka — odmietneme všetko < 10 MB (zabraňuje zachyteniu MB/s bitrate ako veľkosti)
    return mb >= 10;
  }

  const bitrateMbps = (mb * 8) / seconds;
  return bitrateMbps > 0 && bitrateMbps <= 150;
}

function readJsonArrayAfterKey(html, key) {
  const keyPos = html.indexOf(key);
  if (keyPos === -1) return null;

  const start = html.indexOf('[', keyPos);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }

  return null;
}

// youporn-style: quality field obsahuje bitrate v kbps (napr. 4516), nie výšku v pixeloch
function bitrateKbpsToStdQuality(kbps) {
  if (kbps >= 8000) return '2160P';
  if (kbps >= 4000) return '1080P';
  if (kbps >= 2000) return '720P';
  if (kbps >= 800) return '480P';
  return '360P';
}

function bitrateKbpsToHeight(kbps) {
  if (kbps >= 8000) return 2160;
  if (kbps >= 4000) return 1080;
  if (kbps >= 2000) return 720;
  if (kbps >= 800) return 480;
  return 360;
}

function normalizeQualityLabel(q) {
  if (!q) return null;
  const s = String(q).toUpperCase().trim().replace(/PP$/, 'P');
  // 4K a aliasy (vrátane "2160" bez P, "4096" pre DCI 4K)
  if (/^(2160P?|4096P?|4320P?|UHD|4K)$/.test(s)) return '4K';
  if (/^(1440P?|2K|QHD)$/.test(s)) return '2K';
  if (/^(1080P?|FHD|FULLHD)$/.test(s)) return '1080P';
  if (/^(720P?|HD)$/.test(s)) return '720P';
  if (/^480P?$/.test(s)) return '480P';
  if (/^360P?$/.test(s)) return '360P';
  if (/^240P?$/.test(s)) return '240P';
  // Číselné výšky v rozsahu 240–2159 (2160 už zachytené ako 4K)
  const num = parseInt(s.replace('P', ''), 10);
  if (!isNaN(num) && num >= 240 && num < 2160) {
    if (num === 1440) return '2K';
    return `${num}P`;
  }
  return null; // mimo rozsahu — zahodíme
}

// Youporn/pornhub už nedávajú rendition zoznam priamo do mediaDefinitions —
// videoUrl je len resolver endpoint (/media/mp4/?s=…), ktorý vráti JSON so
// skutočnými .mp4 linkami. Tie sa dajú HEADnúť na presnú veľkosť, takže sa
// nemusíme spoliehať na odhad z bitrate v názve súboru (ten je nadhodnotený —
// "1080P_4000K" súbor má reálne ~311 MB, odhad by dal ~382 MB).
async function resolveMediaListSize(resolverUrl) {
  try {
    const res = await fetch(resolverUrl, { credentials: 'include' });
    if (!res.ok) return null;
    const list = JSON.parse(await res.text());
    if (!Array.isArray(list)) return null;

    const mp4s = list
      .map((item) => ({
        url: String(item?.videoUrl || '').replace(/\\\//g, '/'),
        height: parseInt(String(item?.quality || item?.height || ''), 10) || 0,
      }))
      .filter((item) => item.url.includes('.mp4') && item.url.startsWith('http'))
      .sort((a, b) => b.height - a.height);

    for (const item of mp4s) {
      try {
        const head = await fetch(item.url, { method: 'HEAD' });
        const len = head.headers.get('content-length');
        const bytes = len ? parseInt(len, 10) : 0;
        if (bytes > 0) {
          return {
            mb: Math.round(bytes / (1024 * 1024)),
            quality: item.height ? `${item.height}P` : null,
          };
        }
      } catch { }
    }
  } catch { }
  return null;
}

async function extractPornhubMediaMeta(html, durationStr) {
  const rawArray = readJsonArrayAfterKey(html, '"mediaDefinitions":');
  if (!rawArray) return null;

  try {
    const defs = JSON.parse(rawArray.replace(/\\\//g, '/'));

    // Najdi najlepšiu HLS (m3u8) URL — youporn používa HLS pre streaming
    let bestHlsUrl = null;
    let bestHlsHeight = 0;
    let mp4ResolverUrl = null;
    for (const def of defs) {
      if (!def?.videoUrl) continue;
      const fmt = String(def.format || '').toLowerCase();
      const url = String(def.videoUrl).replace(/\\\//g, '/');
      if ((fmt === 'hls' || fmt === 'm3u8' || url.includes('.m3u8')) && url.startsWith('http')) {
        const qualRaw = String(def.quality || def.height || '');
        const qualNum = parseInt(qualRaw, 10) || 0;
        const h = qualNum <= 2160 ? qualNum : bitrateKbpsToHeight(qualNum);
        if (h > bestHlsHeight) { bestHlsHeight = h; bestHlsUrl = url; }
      }
      if (fmt === 'mp4' && url.startsWith('http') && !url.includes('.mp4')) {
        mp4ResolverUrl = url;
      }
    }

    // Presná cesta: resolvni mp4 zoznam a HEADni najvyššiu kvalitu.
    if (mp4ResolverUrl) {
      const exact = await resolveMediaListSize(mp4ResolverUrl);
      if (exact?.mb > 0) {
        return {
          quality: normalizeQualityLabel(exact.quality),
          sizeMb: exact.mb,
          sizeText: formatSizeMb(exact.mb),
          hlsUrl: bestHlsUrl,
        };
      }
    }

    const candidates = defs
      .filter(def => def && typeof def === 'object' && def.videoUrl)
      .map((def) => {
        const url = String(def.videoUrl);
        const bitrateMatch = url.match(/[_\/](\d{3,5})K[_\/]/i);
        const qualRaw = String(def.quality || def.height || '');
        const qualNum = parseInt(qualRaw, 10) || 0;

        // youporn: quality > 2160 → je to bitrate v kbps (napr. 4516, 6008), nie výška
        const isBitrateField = qualNum > 2160;

        const bitrateKbps = bitrateMatch
          ? parseInt(bitrateMatch[1], 10)
          : (isBitrateField ? qualNum : 0);

        const height = isBitrateField
          ? bitrateKbpsToHeight(qualNum)
          : (parseInt(def.height || qualRaw || 0, 10) || 0);

        const quality = isBitrateField
          ? bitrateKbpsToStdQuality(qualNum)
          : qualRaw.toUpperCase() || null;

        return { format: def.format, quality, height, bitrateKbps, url };
      })
      .filter(def => def.height > 0 || def.bitrateKbps > 0);

    let quality = null;
    let sizeMb = null;

    if (candidates.length) {
      candidates.sort((a, b) => {
        if (b.height !== a.height) return b.height - a.height;
        return b.bitrateKbps - a.bitrateKbps;
      });
      const best = candidates[0];
      quality = normalizeQualityLabel(best.quality);

      const seconds = parseDurationToSeconds(durationStr);
      if (best.bitrateKbps > 0 && seconds > 0) {
        sizeMb = Math.round((best.bitrateKbps * seconds) / (8 * 1024));
        if (!isReasonableSizeEstimate(sizeMb, durationStr)) sizeMb = null;
      }
    }

    return {
      quality,
      sizeMb,
      sizeText: sizeMb ? formatSizeMb(sizeMb) : null,
      hlsUrl: bestHlsUrl, // vrátime HLS URL pre fallback výpočet cez fetchHlsQualityAndSize
    };
  } catch {
    return null;
  }
}

function calculateQualityFromBitrate(mb, durationStr) {
  let seconds = parseDurationToSeconds(durationStr);
  if (seconds <= 0) return null;

  const bitrate = (mb * 8) / seconds; // Mbps
  if (bitrate > 4.0) return '1080P';
  if (bitrate > 1.5) return '720P';
  if (bitrate > 0.8) return '480P';
  return '360P';
}

async function resolveEmbedIframeMeta(html, durationStr, tabId, referer = '', depth = 0) {
  if (!html || depth >= 2) return null;
  const candidates = [];
  for (const match of html.matchAll(/<iframe\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    const raw = String(match[1] || '').trim();
    if (!raw || /^(?:about:|javascript:|data:)/i.test(raw)) continue;
    try {
      const resolved = referer ? new URL(raw, referer).href : new URL(raw).href;
      if (!/^https?:\/\//i.test(resolved)) continue;
      if (/doubleclick|googlesyndication|adservice|exoclick|trafficjunky|juicyads|popads|\/hf\.html(?:[?#]|$)/i.test(resolved)) continue;
      candidates.push(resolved);
    } catch { }
  }
  if (!candidates.length) return null;

  const isKnownEmbed = (u) => /(?:vidara\.(?:so|to)|vidsonic\.net|vidfast\.co|lulu(?:stream|vdo|vid|st|vids)?\.(?:com|net|top)|lulu\.stream|streamtape\.[a-z]+|strtape\.[a-z]+|streamta\.pe|vp\.privatez\.link|bravotube\.tv\/embed\/)/i.test(u);
  const ordered = [
    ...candidates.filter(isKnownEmbed),
    ...candidates.filter((u) => !isKnownEmbed(u)),
  ];

  for (const embedUrl of ordered.slice(0, 3)) {
    let embedHost = '';
    try { embedHost = new URL(embedUrl).hostname.replace(/^www\./, ''); } catch { continue; }

    if (/^(?:vidara\.(?:so|to)|vidsonic\.net|vidfast\.co)$/i.test(embedHost)) {
      const filecode = (embedUrl.match(/\/(?:v|e|watch)\/([a-zA-Z0-9_-]+)/) || [])[1];
      if (!filecode) continue;
      try {
        const apiRes = await fetch(`https://${embedHost}/api/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Referer': embedUrl, 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ filecode, device: 'web' }),
          signal: AbortSignal.timeout(7000),
        });
        const data = apiRes.ok ? await apiRes.json().catch(() => null) : null;
        const streamUrl = String(data?.streaming_url || '').trim();
        if (!streamUrl) continue;
        const isHls = /\.m3u8(?:[?#]|$)/i.test(streamUrl);
        if (isHls) {
          const info = await fetchHlsQualityAndSize(streamUrl, durationStr, tabId, `https://${embedHost}/`, 3);
          const q = info?.quality ? normalizeQualityLabel(info.quality) : null;
          const mb = Number(info?.mb || 0) > 0 ? info.mb : null;
          if (q || mb || streamUrl) {
            return {
              quality: q,
              sizeText: mb ? `~${formatSizeMb(mb)}` : null,
              sizeMb: mb,
              sizeEstimated: Boolean(mb),
              streamUrl,
            };
          }
        } else {
          const mb = await fetchHeadSize(streamUrl, `https://${embedHost}/`);
          const q = mb && durationStr ? calculateQualityFromBitrate(mb, durationStr) : null;
          return {
            quality: q || null,
            sizeText: mb ? formatSizeMb(mb) : null,
            sizeMb: mb || null,
            sizeEstimated: false,
            streamUrl,
          };
        }
      } catch { }
    }

    if (/^(?:lulu(?:stream|vdo|vid|st|vids)?\.(?:com|net|top)|lulu\.stream)$/i.test(embedHost)) {
      try {
        const embedHtml = await fetchHtml(embedUrl, 9000);
        const hls = embedHtml ? extractLuluHlsUrl(embedHtml) : '';
        if (hls) {
          const info = await fetchHlsQualityAndSize(hls, durationStr, tabId, embedUrl, 3);
          const q = info?.quality ? normalizeQualityLabel(info.quality) : null;
          const mb = Number(info?.mb || 0) > 0 ? info.mb : null;
          return {
            quality: q,
            sizeText: mb ? `~${formatSizeMb(mb)}` : null,
            sizeMb: mb,
            sizeEstimated: Boolean(mb),
            streamUrl: hls,
          };
        }
      } catch { }
    }

    if (/^(?:streamtape|strtape)\.[a-z]+$|^streamta\.pe$/i.test(embedHost)) {
      try {
        const embedHtml = await fetchHtml(embedUrl, 9000);
        const streamUrl = embedHtml ? internetChicksStreamtapeUrl(embedHtml) : null;
        if (streamUrl) {
          const probeMeta = {};
          const mb = await fetchHeadSize(streamUrl, embedUrl, false, probeMeta);
          const q = mb && durationStr ? calculateQualityFromBitrate(mb, durationStr) : null;
          const lastModifiedDate = probeMeta.lastModified && typeof normalizeDate === 'function'
            ? normalizeDate(probeMeta.lastModified)
            : null;
          return {
            quality: q || null,
            sizeText: mb ? formatSizeMb(mb) : null,
            sizeMb: mb || null,
            sizeEstimated: false,
            streamUrl,
            ...(lastModifiedDate ? { lastModifiedDate } : {}),
          };
        }
      } catch { }
    }

    if (embedHost === 'vp.privatez.link') {
      try {
        const targetUrl = new URL(embedUrl).searchParams.get('u');
        if (targetUrl && /^https?:\/\//i.test(targetUrl)) {
          const targetHtml = await fetchHtml(targetUrl, 8000);
          if (targetHtml) {
            const nested = await extractQualityAndSizeAsync(targetHtml, durationStr, tabId, targetUrl, depth + 1);
            if (nested?.sizeMb || nested?.quality || nested?.streamUrl) return nested;
          }
        }
      } catch { }
    }

    if (/\/(?:embed|e|player|video)\//i.test(embedUrl) || isPornHoarderUrl(embedUrl)) {
      try {
        let nestedHtml = await fetchHtml(embedUrl, 8000);
        if ((!nestedHtml || /just a moment|cf_chl_opt/i.test(nestedHtml)) && tabId) {
          nestedHtml = await fetchTextViaTabOrDirect(embedUrl, tabId);
        }
        if (nestedHtml) {
          const nested = await extractQualityAndSizeAsync(nestedHtml, durationStr, tabId, embedUrl, depth + 1);
          if (nested?.sizeMb || nested?.quality || nested?.streamUrl) return nested;
        }
      } catch { }
    }
  }
  return null;
}

/**
 * Extrahuje najvyššiu kvalitu a veľkosť súboru.
 * Ak nenájde v texte, vykoná HTTP HEAD request priamo na video súbor pre absolútnu presnosť!
 */
async function extractQualityAndSizeAsync(html, durationStr, tabId, referer = '', embedDepth = 0) {
  if (!html) return { quality: null, sizeText: null, sizeMb: null };

  let foundQuality = null;
  let bestSize = null;
  let resolvedStreamUrl = null;
  let sizeEstimated = false;
  let lastModifiedDate = null;

  // Krok 1: pornhub/youporn mediaDefinitions
  let mediaHlsUrl = null;
  const pornhubMeta = await extractPornhubMediaMeta(html, durationStr);
  if (pornhubMeta) {
    if (pornhubMeta.quality) foundQuality = pornhubMeta.quality;
    if (pornhubMeta.sizeMb) bestSize = { text: pornhubMeta.sizeText, mb: pornhubMeta.sizeMb };
    if (pornhubMeta.hlsUrl) mediaHlsUrl = pornhubMeta.hlsUrl;
    // Ak máme oboje — hotovo
    if (foundQuality && bestSize) {
      return { quality: foundQuality, sizeText: bestSize.text, sizeMb: bestSize.mb };
    }
    // Ak máme len qualitu — pokračuj pre veľkosť cez HLS
  }

  // Krok 1b: youporn HLS — fetchni m3u8 z mediaDefinitions (najspoľahlivejšia cesta pre youporn)
  if (!bestSize && mediaHlsUrl) {
    const hlsData = await fetchHlsQualityAndSize(mediaHlsUrl, durationStr, tabId, referer);
    if (hlsData && hlsData.mb > 0 && isReasonableSizeEstimate(hlsData.mb, durationStr)) {
      bestSize = { text: formatSizeMb(hlsData.mb), mb: hlsData.mb };
      if (!foundQuality && hlsData.quality) foundQuality = normalizeQualityLabel(hlsData.quality);
    }
  }

  if (foundQuality && bestSize) {
    return { quality: foundQuality, sizeText: bestSize.text, sizeMb: bestSize.mb };
  }

  // Krok 2: regex pre explicitné "1080P … 3.5 GB" v HTML texte
  // Negujeme MB/s, MB/min (bitrate) — nechceme bitrate ako veľkosť súboru
  if (!bestSize) {
    const patterns = [
      /\b((?:2160|1440|1080|720|480|360|240)[pP]|4[kK]|2[kK])\b\s*[,\-\(•\|]?\s*[^<>]{0,50}?(?<![-\w])(\d+(?:\.\d+)?)\s*(GB|MB)\b(?!\s*\/)/gi,
      /download[^<]*?\b((?:2160|1440|1080|720|480|360|240)[pP])\b[^<]*?(?<![-\w])(\d+(?:\.\d+)?)\s*(GB|MB)\b(?!\s*\/)/gi,
    ];

    let maxRes = -1;

    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(html)) !== null) {
        const resStr = m[1].toLowerCase().replace('k', '000').replace('p', '');
        let resVal = parseInt(resStr, 10);
        if (resStr === '4') resVal = 2160;
        if (resStr === '2') resVal = 1440;

        const sizeVal = parseFloat(m[2]);
        const unit = m[3]?.toUpperCase() || 'MB';
        const sizeInMb = unit === 'GB' ? sizeVal * 1024 : sizeVal;
        if (!isReasonableSizeEstimate(sizeInMb, durationStr)) continue;

        if (resVal > maxRes || (resVal === maxRes && sizeInMb > (bestSize?.mb || 0))) {
          maxRes = resVal;
          if (!foundQuality) foundQuality = normalizeQualityLabel(m[1].toUpperCase().replace('000P', 'K'));
          bestSize = { text: formatSizeMb(sizeInMb) || `${m[2]} ${m[3]}`, mb: sizeInMb };
        }
      }
    }
  }

  // Krok 2.5: Regex len pre velkost (ak nie je spojena s kvalitou, napr. "Size: 2.32 GB" na Camwhores)
  if (!bestSize) {
    const sizePatterns = [
      /size\s*[:=]?\s*(?:<[^>]+>)?\s*(\d+(?:\.\d+)?)\s*(GB|MB|GiB|MiB)/gi
    ];
    let maxSize = -1;
    for (const pattern of sizePatterns) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(html)) !== null) {
        const sizeVal = parseFloat(m[1]);
        const unit = m[2]?.toUpperCase();
        let sizeInMb = sizeVal;
        if (unit && unit.startsWith('G')) sizeInMb = sizeVal * 1024;

        if (isReasonableSizeEstimate(sizeInMb, durationStr) && sizeInMb > maxSize) {
          maxSize = sizeInMb;
          bestSize = { text: formatSizeMb(sizeInMb) || `${m[1]} ${m[2]}`, mb: sizeInMb };
        }
      }
    }
  }

  // Krok 3: HLS (.m3u8) z HTML — XVideos a iné stránky so setVideoHLS() pattern
  if (!bestSize) {
    const hlsMatches = [...html.matchAll(/setVideo(?:HLS|UrlHls|Playlist)?\s*\(\s*['"](https:\/\/[^'"]+\.m3u8[^'"]*)['"]/gi)];
    if (hlsMatches.length === 0) {
      const m3u8Matches = [...html.matchAll(/https:\/\/[^\s"'<>]+?\.m3u8(?:[^\s"'<>]*)?/gi)];
      for (const mm of m3u8Matches) {
        const u = mm[0].replace(/\\\//g, '/').replace(/&amp;/gi, '&');
        if (u !== mediaHlsUrl) { hlsMatches.push([u, u]); break; } // skip ten čo sme už skúsili
      }
    }

    if (hlsMatches.length > 0) {
      const hlsUrl = (hlsMatches[0][1] || hlsMatches[0][0]).replace(/\\\//g, '/').replace(/&amp;/gi, '&');
      const sampleLimit = /hdsex\.org/i.test(referer || hlsUrl) ? 5 : 0;
      const hlsData = await fetchHlsQualityAndSize(hlsUrl, durationStr, tabId, referer, sampleLimit);
      if (hlsData && hlsData.mb > 0 && isReasonableSizeEstimate(hlsData.mb, durationStr)) {
        bestSize = { text: sampleLimit > 0 ? `~${formatSizeMb(hlsData.mb)}` : formatSizeMb(hlsData.mb), mb: hlsData.mb };
        if (sampleLimit > 0) sizeEstimated = true;
        if (!foundQuality && hlsData.quality) foundQuality = normalizeQualityLabel(hlsData.quality);
      }
    }
  }

  // Krok 4: HEAD request na .mp4 súbory pre presnú veľkosť
  if (!bestSize) {
    const allUrls = [];
    // Match absolute (https://) AND protocol-relative (//host/...) mp4 URLs.
    // Sites like xxxdbx embed <source src="//d.v1d30.com/.../1080.mp4">.
    // Exclude trailing backslash so JS-escaped strings (\"...1080.mp4\") parse cleanly.
    const mp4Matches = [...html.matchAll(/(?:https?:)?\/\/[^\s"'<>\\]+?\.mp4(?:[^\s"'<>\\]*)?/gi)];
    allUrls.push(...mp4Matches.map(m => m[0]));
    const xvideosMatches = [...html.matchAll(/setVideo(?:Url)?(Low|High|2160p?|1440p?|1080p?|720p?|480p?|360p?|4k|2k)\s*\(\s*['"]([^'"]+)['"]/gi)]
      .map(match => {
        const label = match[1].toLowerCase();
        const quality = label === '4k' ? 2160 : label === '2k' ? 1440
          : label === 'high' ? 1080 : label === 'low' ? 720
            : Number(label.match(/\d{3,4}/)?.[0]) || 0;
        return { url: match[2].replace(/\\u0026/gi, '&').replace(/\\\//g, '/'), quality };
      });
    allUrls.push(...xvideosMatches.map(match => match.url));

    let uniqueUrls = [...new Set(allUrls.map(u => {
      let clean = u.replace(/\\\//g, '/').replace(/\\+$/, '');
      if (clean.startsWith('//')) clean = 'https:' + clean;   // normalize protocol-relative
      return clean;
    }))].filter(u => !/\.mp4\.(?:jpe?g|png|webp|gif)(?:[/?#]|$)/i.test(u));

    const nonPreviewUrls = uniqueUrls.filter(u => !/(?:[_-]preview\d*p?|[_-]trailer|preroll)\.mp4(?:[/?#]|$)/i.test(u));
    if (nonPreviewUrls.length > 0) uniqueUrls = nonPreviewUrls;

    // Rendition height sa dá často vyčítať priamo z cesty (napr. .../720.mp4,
    // .../1080p.mp4) — ak áno, zoraď podľa nej a HEADni len najvyššiu,
    // namiesto slepého HEAD-request na prvých 5 nájdených URL.
    const heightFromUrl = (u) => {
      const m = u.match(/[\/_-](2160|1440|1080|720|480|360|240)p?(?:[\/_.?#]|$)/i);
      return m ? parseInt(m[1], 10) : 0;
    };
    const withHeight = uniqueUrls.map((u) => ({ u, h: heightFromUrl(u) }));
    const anyHeight = withHeight.some((x) => x.h > 0);
    if (anyHeight) {
      withHeight.sort((a, b) => b.h - a.h);
      uniqueUrls = withHeight.map((x) => x.u).slice(0, 3);
    } else {
      uniqueUrls = uniqueUrls.slice(0, 5);
    }

    if (uniqueUrls.length > 0) {
      const probeMetas = uniqueUrls.map(() => ({}));
      const sizes = await Promise.all(uniqueUrls.map((url, idx) => fetchHeadSize(url, referer, false, probeMetas[idx])));
      let maxMbSize = 0;
      let maxMbUrl = '';
      let maxMbIdx = -1;
      for (let i = 0; i < sizes.length; i++) {
        if (sizes[i] && isReasonableSizeEstimate(sizes[i], durationStr) && sizes[i] > maxMbSize) {
          maxMbSize = sizes[i];
          maxMbUrl = uniqueUrls[i];
          maxMbIdx = i;
        }
      }
      if (maxMbSize > 0) {
        bestSize = { text: formatSizeMb(maxMbSize), mb: maxMbSize };
        const urlHeight = (maxMbUrl ? heightFromUrl(maxMbUrl) : 0)
          || xvideosMatches.find(match => match.url === maxMbUrl)?.quality
          || 0;
        if (!foundQuality && urlHeight) {
          foundQuality = urlHeight >= 2160 ? '4K' : `${urlHeight}P`;
        }
        if (!foundQuality && durationStr) {
          const calcQ = calculateQualityFromBitrate(maxMbSize, durationStr);
          if (calcQ) foundQuality = calcQ;
        }
        if (maxMbUrl && !resolvedStreamUrl) resolvedStreamUrl = maxMbUrl;
        if (maxMbIdx >= 0 && probeMetas[maxMbIdx]?.lastModified && typeof normalizeDate === 'function') {
          lastModifiedDate = normalizeDate(probeMetas[maxMbIdx].lastModified);
        }
      } else {
        const hlsIdx = probeMetas.findIndex((m) => m && m.isHls);
        if (hlsIdx >= 0) {
          const hlsTarget = probeMetas[hlsIdx].finalUrl || uniqueUrls[hlsIdx];
          const hlsData = await fetchHlsQualityAndSize(hlsTarget, durationStr, tabId, referer, 5);
          if (hlsData && hlsData.mb > 0 && isReasonableSizeEstimate(hlsData.mb, durationStr)) {
            bestSize = { text: `~${formatSizeMb(hlsData.mb)}`, mb: hlsData.mb };
            sizeEstimated = true;
            if (!foundQuality && hlsData.quality) foundQuality = normalizeQualityLabel(hlsData.quality);
            if (!resolvedStreamUrl) resolvedStreamUrl = hlsTarget;
          } else if (hlsData && hlsData.quality && !foundQuality) {
            foundQuality = normalizeQualityLabel(hlsData.quality);
          }
        }
      }
    }
  }

  if (!bestSize && embedDepth < 2) {
    const embedMeta = await resolveEmbedIframeMeta(html, durationStr, tabId, referer, embedDepth);
    if (embedMeta) {
      if (!foundQuality && embedMeta.quality) foundQuality = embedMeta.quality;
      if (embedMeta.sizeMb && embedMeta.sizeText && isReasonableSizeEstimate(embedMeta.sizeMb, durationStr)) {
        bestSize = { text: embedMeta.sizeText, mb: embedMeta.sizeMb };
        sizeEstimated = Boolean(embedMeta.sizeEstimated);
      }
      if (embedMeta.streamUrl) resolvedStreamUrl = embedMeta.streamUrl;
      if (!lastModifiedDate && embedMeta.lastModifiedDate) lastModifiedDate = embedMeta.lastModifiedDate;
    }
  }

  if (!foundQuality && /flashvars\s*=/.test(html)) {
    const fvQualityMatch = html.match(/(?:postfix|video_url_text|video_alt_url\d*_text)\s*:\s*['"][^'"]*?(2160|1440|1080|720|480|360)p?[^'"]*['"]/i)
      || html.match(/preview_height\d*\s*:\s*['"]?(2160|1440|1080|720|480|360)['"]?/i);
    if (fvQualityMatch?.[1]) {
      const h = parseInt(fvQualityMatch[1], 10);
      foundQuality = h >= 2160 ? '4K' : `${h}P`;
    }
  }

  return {
    quality: foundQuality,
    sizeText: bestSize?.text || null,
    sizeMb: bestSize?.mb || null,
    ...(resolvedStreamUrl ? { streamUrl: resolvedStreamUrl } : {}),
    ...(sizeEstimated ? { sizeEstimated: true } : {}),
    ...(lastModifiedDate ? { lastModifiedDate } : {}),
  };
}

/**
 * Extrahuje dĺžku videa (duration) z HTML.
 */
function extractDuration(html) {
  if (!html) return null;

  // JSON-LD duration (ISO 8601: PT1H23M45S or P0DT0H9M13S)
  const isoMatch = html.match(/"duration"\s*:\s*"(P(?:\d+D)?T[^"]+)"/i);
  if (isoMatch?.[1]) return isoToHuman(isoMatch[1]);

  // Microdata <meta itemprop="duration" content="P0DT1H5M0S">
  const metaIsoMatch = html.match(/<meta[^>]+itemprop=["']duration["'][^>]+content=["'](P(?:\d+D)?T[^"']+)["']/i)
    || html.match(/<meta[^>]+content=["'](P(?:\d+D)?T[^"']+)["'][^>]+itemprop=["']duration["']/i);
  if (metaIsoMatch?.[1]) return isoToHuman(metaIsoMatch[1]);

  // youporn / niektoré weby: "duration": 1831 alebo var video_duration = "608.108"
  const secMatch = html.match(/(?:"(?:video_?)?duration"\s*:\s*"?|video_duration\s*[:=]\s*["']?)(\d{2,6}(?:\.\d+)?)\b["']?/i);
  if (secMatch?.[1]) {
    const secs = Math.round(parseFloat(secMatch[1]));
    if (secs >= 30 && secs < 86400) { // 30s–24h = rozumná dĺžka videa
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      return `${m}:${String(s).padStart(2, '0')}`;
    }
  }

  // Formát MM:SS alebo HH:MM:SS v texte
  const timeMatch = html.match(/(?:duration|length)\s*[:\-]?\s*(\d{1,2}:\d{2}(?::\d{2})?)/i);
  if (timeMatch?.[1]) return timeMatch[1];

  // Hľadáme v <time>, <span> alebo <div>
  const spanMatch = html.match(/<(?:span|time|div)[^>]+class=["'][^"']*duration[^"']*["'][^>]*>\s*([\d:]+)\s*<\/(?:span|time|div)>/i);
  if (spanMatch?.[1]) return spanMatch[1];

  return null;
}

function isoToHuman(iso) {
  const m = iso.match(/P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
  if (!m) return null;
  const h = (parseInt(m[1] || 0) * 24) + parseInt(m[2] || 0);
  const min = parseInt(m[3] || 0);
  const s = parseInt(m[4] || 0);
  if (h > 0) return `${h}:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${min}:${String(s).padStart(2, '0')}`;
}

function normalizeDate(raw) {
  if (!raw) return null;
  // Whoreshub emits nonstandard timestamps such as 2024-09-17T12:07:09.UTC.
  const value = String(raw).replace(/\.UTC$/i, 'Z');
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function isPureGirlUrl(url) {
  try {
    return /(^|\.)puregirl\.tv$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

async function decryptPureGirlFile(encoded, secret) {
  try {
    let b64 = String(encoded || '').replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4;
    if (pad) b64 += '='.repeat(4 - pad);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes.length <= 28) return null;
    const hash = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(String(secret || '')));
    const key = await crypto.subtle.importKey('raw', new Uint8Array(hash).slice(0, 16), { name: 'AES-GCM' }, false, ['decrypt']);
    const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), tagLength: 128 }, key, bytes.slice(12));
    return new TextDecoder().decode(dec);
  } catch {
    return null;
  }
}

async function extractPureGirlMeta(pageUrl, tabId) {
  try {
    const u = new URL(pageUrl);
    const m = u.pathname.match(/^\/post\/([^/?#]+)\/?$/i);
    if (!m?.[1]) return null;
    const res = await fetch(`https://puregirl.tv/api/post/${encodeURIComponent(m[1])}`, {
      headers: { Referer: pageUrl, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    const post = json?.data;
    if (!post) return null;

    const date = post.create_time ? normalizeDate(new Date(Number(post.create_time)).toISOString()) : null;
    const duration = post.duration_string && post.duration_string !== '00:00' ? post.duration_string : null;
    let quality = post.resolution_string ? normalizeQualityLabel(post.resolution_string) : null;
    let sizeMb = null;
    let sizeText = null;
    let streamUrl = null;
    let sizeEstimated = false;

    const sources = Array.isArray(post.playback_source) ? post.playback_source : [];
    if (post.playback_format_type === 'hls') {
      const raw = String(sources[0]?.file || '');
      let hlsUrl = '';
      if (raw.startsWith('http')) {
        if (raw.endsWith('master.m3u8')) {
          const seg = raw.split('/').pop().split('.')[0];
          const rev = seg.slice(0, -5).split('').reverse().join('');
          hlsUrl = raw.replace(seg, rev);
        } else {
          hlsUrl = raw;
        }
      } else if (raw.endsWith('master.m3u8')) {
        const seg = raw.split('.')[0];
        const rev = seg.slice(0, -5).split('').reverse().join('');
        hlsUrl = `https://puregirl.tv/api/stream/${raw.replace(seg, rev)}`;
      } else if (raw) {
        hlsUrl = `https://puregirl.tv/api/stream/${raw}`;
      }
      if (hlsUrl) {
        streamUrl = hlsUrl;
        const hlsData = await fetchHlsQualityAndSize(hlsUrl, duration, tabId, pageUrl, 5);
        if (hlsData?.mb > 0) {
          sizeMb = hlsData.mb;
          sizeText = `~${formatSizeMb(hlsData.mb)}`;
          sizeEstimated = true;
        }
        if (hlsData?.quality) quality = normalizeQualityLabel(hlsData.quality);
      }
    } else if (post.playback_format_type === 'mp4' && sources.length) {
      const sorted = [...sources].sort((a, b) => (parseInt(b?.label || '0', 10) || 0) - (parseInt(a?.label || '0', 10) || 0));
      for (const src of sorted) {
        let resolved = '';
        if (String(src?.file || '').startsWith('http')) {
          resolved = src.file;
        } else if (src?.file && src?.secret) {
          resolved = await decryptPureGirlFile(src.file, src.secret);
        }
        if (!resolved) continue;
        streamUrl = resolved;
        if (src.label) {
          const lbl = parseInt(src.label, 10);
          if (lbl > 0) quality = lbl >= 2160 ? '4K' : `${lbl}P`;
        }
        const mb = await fetchHeadSize(resolved, pageUrl);
        if (mb && mb > 0) {
          sizeMb = mb;
          sizeText = formatSizeMb(mb);
          break;
        }
      }
    }

    return {
      date,
      quality,
      sizeText,
      sizeMb,
      duration,
      ...(streamUrl ? { streamUrl } : {}),
      ...(sizeEstimated ? { sizeEstimated: true } : {}),
    };
  } catch {
    return null;
  }
}

function is01TubeUrl(url) {
  try {
    return /(^|\.)01tube\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isPornHoarderUrl(url) {
  try {
    return /(^|\.)pornhoarder\.(?:tv|io|net|pictures)$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function decode01TubeVideoUrl(encoded) {
  const alphabet = 'АВСDЕFGHIJKLМNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,~';
  const clean = String(encoded || '').replace(/[^АВСЕМA-Za-z0-9.,~]/g, '');
  let out = '';
  let s = 0;
  while (s < clean.length) {
    const i = alphabet.indexOf(clean.charAt(s++));
    const l = alphabet.indexOf(clean.charAt(s++));
    const o = alphabet.indexOf(clean.charAt(s++));
    const n = alphabet.indexOf(clean.charAt(s++));
    if (i < 0 || l < 0) break;
    const c1 = (i << 2) | (l >> 4);
    const c2 = ((15 & l) << 4) | (o >> 2);
    const c3 = ((3 & o) << 6) | n;
    out += String.fromCharCode(c1);
    if (o !== 64 && o >= 0) out += String.fromCharCode(c2);
    if (n !== 64 && n >= 0) out += String.fromCharCode(c3);
  }
  return out;
}

async function extract01TubeMeta(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const m = u.pathname.match(/^\/videos\/(\d+)(?:\/|$)/i);
    if (!m?.[1]) return null;
    const id = Number(m[1]);
    const dir1 = 1e6 * Math.floor(id / 1e6);
    const dir2 = 1e3 * Math.floor(id / 1e3);
    const headers = { Referer: pageUrl, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' };

    const [infoRes, fileRes] = await Promise.all([
      fetch(`https://01tube.com/api/json/video/86400/${dir1}/${dir2}/${id}.json`, { headers, signal: AbortSignal.timeout(10000) }).catch(() => null),
      fetch(`https://01tube.com/api/videofile.php?video_id=${id}&lifetime=864000`, { headers, signal: AbortSignal.timeout(10000) }).catch(() => null),
    ]);

    const infoJson = infoRes?.ok ? await infoRes.json().catch(() => null) : null;
    const video = infoJson?.video || null;
    const date = video?.post_date ? normalizeDate(video.post_date) : null;
    const duration = video?.duration || null;

    const fileJson = fileRes?.ok ? await fileRes.json().catch(() => null) : null;
    const files = Array.isArray(fileJson) ? fileJson : [];
    let sizeMb = null;
    let sizeText = null;
    let quality = null;
    let streamUrl = null;

    for (const f of files) {
      if (!f?.video_url) continue;
      const decodedPath = decode01TubeVideoUrl(f.video_url);
      if (!decodedPath.includes('/get_file/')) continue;
      const fullUrl = decodedPath.startsWith('http') ? decodedPath : `https://01tube.com${decodedPath.startsWith('/') ? '' : '/'}${decodedPath}`;
      streamUrl = fullUrl;
      const mb = await fetchHeadSize(fullUrl, pageUrl);
      if (mb && mb > 0 && (!sizeMb || mb > sizeMb)) {
        sizeMb = mb;
        sizeText = formatSizeMb(mb);
        const hMatch = fullUrl.match(/_(2160|1440|1080|720|480|360)p?\.mp4/i);
        if (hMatch?.[1]) {
          const h = parseInt(hMatch[1], 10);
          quality = h >= 2160 ? '4K' : `${h}P`;
        } else if (duration) {
          quality = calculateQualityFromBitrate(mb, duration);
        }
      }
    }

    return {
      date,
      quality,
      sizeText,
      sizeMb,
      duration,
      ...(streamUrl ? { streamUrl } : {}),
    };
  } catch {
    return null;
  }
}

function isFapFolderUrl(url) {
  try {
    return /(^|\.)fapfolder\.club$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isBeegUrl(url) {
  try {
    return /(^|\.)beeg\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function beegIdFromUrl(url) {
  try {
    const match = new URL(url).pathname.match(/^\/-?(\d{5,})\/?$/);
    if (!match) return '';
    // Beeg's facts API rejects ids with a leading zero ("invalid integer:
    // invalid syntax") even though the URL always shows one — strip it.
    return match[1].replace(/^0+(?=\d)/, '');
  } catch {
    return '';
  }
}

function beegDurationToHuman(value) {
  const seconds = Number.parseInt(value, 10);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds >= 86400) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function beegHeightFromResourceKey(key) {
  const match = String(key || '').match(/(?:fl_cdn_|\b)(2160|1440|1080|720|480|360|240)(?:p)?\b/i);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function beegHlsUrl(resource) {
  const value = String(resource || '').replace(/^\/+/, '');
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  // Current Beeg API returns a path served by this CDN. Older videos can still
  // return a beeg.com path; the fallback below preserves that compatibility.
  return `https://video.externulls.com/${value}`;
}

async function extractBeegMeta(pageUrl, tabId) {
  const videoId = beegIdFromUrl(pageUrl);
  if (!videoId) return null;

  let payload;
  try {
    const response = await fetch(`https://store.externulls.com/facts/file/${videoId}`, {
      headers: { Accept: 'application/json', Referer: 'https://beeg.com/' },
      credentials: 'include',
    });
    if (!response.ok) return null;
    payload = await response.json();
  } catch {
    return null;
  }

  const file = payload?.file;
  if (!file || typeof file !== 'object') return null;
  const facts = Array.isArray(payload.fc_facts) ? payload.fc_facts : [];
  const firstFact = facts.reduce((best, fact) => {
    if (!fact || typeof fact !== 'object') return best;
    return !best || Number(fact.id) < Number(best.id) ? fact : best;
  }, null);
  const resources = file.hls_resources || firstFact?.hls_resources;
  // fl_duration is the length of the FULL underlying scene, not necessarily
  // the (often shorter, clipped) stream actually served for this card — using
  // it to badge the duration, or worse to scale a bandwidth estimate, can be
  // off by many times. Prefer the real segment-summed duration below when we
  // manage to fetch one; fall back to fl_duration only if that fails.
  let duration = beegDurationToHuman(file.fl_duration);
  const date = firstFact?.fc_created ? normalizeDate(firstFact.fc_created) : null;

  if (!resources || typeof resources !== 'object') {
    return { date, quality: null, sizeText: null, sizeMb: null, duration, title: file.stuff?.sf_name || null };
  }

  const sources = Object.entries(resources)
    .map(([key, resource]) => ({ key, url: beegHlsUrl(resource), height: beegHeightFromResourceKey(key) }))
    .filter((source) => source.url)
    .sort((a, b) => b.height - a.height);

  // The resource key is the rendition (fl_cdn_1080, ...). Probe only that
  // video's highest rendition, rather than taking an arbitrary .mp4 from a
  // page-wide regex (which previously mixed in recommendation thumbnails).
  for (const source of sources) {
    let hlsData = await fetchHlsQualityAndSize(source.url, duration, tabId);
    if (!hlsData && /video\.externulls\.com/i.test(source.url)) {
      hlsData = await fetchHlsQualityAndSize(source.url.replace('video.externulls.com', 'video.beeg.com'), duration, tabId);
    }
    const sizeMb = hlsData?.mb;
    // hlsData.seconds only comes from the real segment-summed path (sumHlsSegmentBytes),
    // so its presence means sizeMb is an exact byte count, not a bandwidth estimate —
    // trust it directly instead of running it through the bandwidth sanity gate.
    const isExact = Number.isFinite(hlsData?.seconds) && hlsData.seconds > 0;
    if (isExact) duration = beegDurationToHuman(Math.round(hlsData.seconds)) || duration;
    if (sizeMb && (isExact || isReasonableSizeEstimate(sizeMb, duration))) {
      return {
        date,
        quality: normalizeQualityLabel(`${source.height}P`) || normalizeQualityLabel(hlsData.quality),
        sizeMb,
        sizeText: formatSizeMb(sizeMb),
        duration,
        title: file.stuff?.sf_name || null,
        streamUrl: source.url,
      };
    }
  }

  const top = sources[0];
  return {
    date,
    quality: top?.height ? normalizeQualityLabel(`${top.height}P`) : null,
    sizeText: null,
    sizeMb: null,
    duration,
    title: file.stuff?.sf_name || null,
    streamUrl: top?.url || null,
  };
}

function isNoodleMagazineUrl(url) {
  try {
    return /(^|\.)noodlemagazine\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isPimpBunnyUrl(url) {
  try {
    return /(^|\.)(?:pimpbunny|fnxtube)\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isXGroovyUrl(url) {
  try {
    return /(^|\.)xgroovy(?:-fr)?\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isRedgifsUrl(url) {
  try {
    return /(^|\.)redgifs\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isEromeVipUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)erome\.vip$/i.test(u.hostname)
      && /^\/videos\/(?!popular\/?$|random\/?$)[^/?#]+\/?$/i.test(u.pathname);
  } catch {
    return false;
  }
}

function extractEromeVipMediaUrl(html) {
  if (!html) return null;
  const patterns = [
    /id=["']erome-player["'][^>]*\ssrc=["']([^"']+)["']/i,
    /<video[^>]+src=["']([^"']*\/media\/v\/\d+\/video[^"']*)["']/i,
    /src=["']([^"']*\/media\/v\/\d+\/video[^"']*)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1].replace(/&amp;/g, '&').trim();
  }
  return null;
}

async function extractEromeVipMeta(html, pageUrl) {
  const duration = extractDuration(html);
  const date = extractDate(html);
  const mediaUrl = extractEromeVipMediaUrl(html);
  let sizeMb = null;
  if (mediaUrl) {
    // Signed /media/v/<id>/video streams expose Content-Length via HEAD (tested ~375MB).
    sizeMb = await fetchHeadSize(mediaUrl, pageUrl || 'https://erome.vip/');
  }
  let quality = null;
  if (sizeMb && duration) quality = calculateQualityFromBitrate(sizeMb, duration);
  return {
    date,
    quality,
    sizeMb: sizeMb || null,
    sizeText: sizeMb ? formatSizeMb(sizeMb) : null,
    duration,
    streamUrl: mediaUrl || null,
    adapter: 'erome-vip-v1',
  };
}

// erome.com albums (posts): /a/<id>. An album can hold several videos and photos.
function isEromeAlbumUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)erome\.com$/i.test(u.hostname) && /^\/a\/[A-Za-z0-9_-]+\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

// <erome-album-parse>
function parseEromeAlbumHtml(html) {
  const videos = [];
  const seen = new Set();
  // The large lightbox copy has id="player-lg-<id>"; only the inline player (id="player-<id>") is counted.
  const re = /<video\b[^>]*\sid=["']player-(\d+)["'][^>]*>([\s\S]*?)<\/video>/gi;
  let m;
  while ((m = re.exec(html || ''))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    let best = null;
    for (const s of m[2].matchAll(/<source\b[^>]*>/gi)) {
      const src = s[0].match(/\ssrc=["']([^"']+)["']/i)?.[1];
      if (!src) continue;
      const res = Number(s[0].match(/\sres=["']?(\d{3,4})/i)?.[1] || src.match(/_(\d{3,4})p\.mp4/i)?.[1] || 0);
      if (!best || res > best.res) best = { url: src.replace(/&amp;/g, '&'), res };
    }
    if (!best) continue;
    const dur = html.match(new RegExp(`id=["']player-${m[1]}-duration["'][^>]*>\\s*([\\d:]+)\\s*<`, 'i'))?.[1] || null;
    videos.push({ id: m[1], url: best.url, res: best.res, duration: dur });
  }
  const title = html && html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']*)["']/i)?.[1] || '';
  return { videos, title: title.replace(/&#0?39;/g, "'").replace(/&amp;/g, '&') };
}
function eromeDurationSeconds(text) {
  const parts = String(text || '').split(':').map(Number);
  if (!parts.length || parts.some(n => !Number.isFinite(n))) return 0;
  return parts.reduce((total, n) => total * 60 + n, 0);
}
function formatEromeDuration(seconds) {
  const h = Math.floor(seconds / 3600), mi = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(mi)}:${pad(s)}` : `${mi}:${pad(s)}`;
}
// </erome-album-parse>

// erome CDN hosts (v##.erome.com) answer 403 without a Referer. A service worker cannot set it
// via fetch(), so a session DNR rule adds it to the extension's own requests.
async function ensureEromeRefererRule() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [91001, 91002, 91003],
      addRules: [
        {
          id: 91001,
          priority: 1,
          action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: 'https://www.erome.com/' }] },
          condition: { requestDomains: ['erome.com'], resourceTypes: ['xmlhttprequest'], initiatorDomains: [chrome.runtime.id] },
        },
        {
          id: 91002,
          priority: 1,
          action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: 'https://myxstudio.top/' }] },
          condition: { requestDomains: ['mydaddy.cc'], resourceTypes: ['xmlhttprequest'], initiatorDomains: [chrome.runtime.id] },
        },
        {
          id: 91003,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'referer', operation: 'set', value: 'https://hdsex.org/' },
              { header: 'origin', operation: 'set', value: 'https://hdsex.org' },
            ],
          },
          condition: { requestDomains: ['hdsex.org'], resourceTypes: ['xmlhttprequest'], initiatorDomains: [chrome.runtime.id] },
        },
      ],
    });
  } catch { }
}
ensureEromeRefererRule();

// HEAD one erome media file for exact size (bytes) and Last-Modified (upload time proxy).
async function headEromeVideo(videoUrl, referer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(videoUrl, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    const bytes = Number(res.headers.get('content-length') || 0);
    const modified = Date.parse(res.headers.get('last-modified') || '');
    return { bytes: res.ok && bytes > 0 ? bytes : 0, modified: Number.isFinite(modified) ? modified : 0 };
  } catch {
    return { bytes: 0, modified: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function extractEromeAlbumMeta(html, pageUrl) {
  const album = parseEromeAlbumHtml(html);
  const videos = album.videos.slice(0, 40);
  const heads = new Array(videos.length);
  let index = 0;
  const worker = async () => {
    while (index < videos.length) {
      const i = index++;
      heads[i] = await headEromeVideo(videos[i].url, pageUrl || 'https://www.erome.com/');
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, videos.length) }, worker));
  const bytes = heads.reduce((total, h) => total + (h?.bytes || 0), 0);
  const sizeMb = bytes > 0 ? Math.round(bytes / (1024 * 1024)) : null;
  const seconds = videos.reduce((total, v) => total + eromeDurationSeconds(v.duration), 0);
  const height = Math.max(0, ...videos.map(v => v.res));
  const newest = Math.max(0, ...heads.map(h => h?.modified || 0));
  return {
    title: album.title || null,
    videoCount: album.videos.length,
    quality: height ? `${height}P` : null,
    height: height || 0,
    sizeMb,
    sizeText: sizeMb ? formatSizeMb(sizeMb) : null,
    duration: seconds ? formatEromeDuration(seconds) : null,
    date: newest ? new Date(newest).toISOString().slice(0, 10) : null,
    streamUrl: null,
    adapter: 'erome-album-v1',
  };
}

function isCamwhoresUrl(url) {
  try {
    return /(^|\.)camwhores\.(?:tv|com|cc|net|org)$/i.test(new URL(url).hostname);
  } catch { return false; }
}

function isWhoreshubUrl(url) {
  try { return /(^|\.)whoreshub\.com$/i.test(new URL(url).hostname); }
  catch { return false; }
}

function isXxbritsUrl(url) {
  try {
    return /(^|\.)xxbrits\.com$/i.test(new URL(url).hostname);
  } catch { return false; }
}

function isPornFansUrl(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)pornfans\.net$/i.test(parsed.hostname) && /^\/video\/[^/]+\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function extractPornFansEmbedUrl(html, pageUrl) {
  const source = String(html || '');
  for (const match of source.matchAll(/<iframe\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    try {
      const candidate = new URL(match[1].replace(/&amp;/g, '&'), pageUrl).href;
      if (/(?:lulustream|luluvid|luluvdo|luluvids)\.(?:com|net|top)|lulu\.stream/i.test(candidate)) return candidate;
    } catch { }
  }
  return '';
}

function isDoodDownloadUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'playmogo.com'
      || host.endsWith('.playmogo.com')
      || host === 'doodstream.com'
      || host.endsWith('.doodstream.com')
      || /^dood[a-z0-9-]*\.[a-z]{2,}$/i.test(host);
  } catch {
    return false;
  }
}

function extractPornFansDownloadUrls(html, pageUrl) {
  const out = [];
  const seen = new Set();
  for (const match of String(html || '').matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)) {
    try {
      const url = new URL(match[1].replace(/&amp;/g, '&'), pageUrl).href;
      if (!isDoodDownloadUrl(url) || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    } catch { }
  }
  return out;
}

function parseDoodSizeMb(html) {
  const source = String(html || '').replace(/<[^>]+>/g, ' ');
  const matches = [...source.matchAll(/\b([\d.,]+)\s*(GB|MB)\b/gi)];
  let best = 0;
  for (const match of matches) {
    const raw = String(match[1]);
    const normalized = raw.includes('.') ? raw.replace(/,/g, '') : raw.replace(',', '.');
    let value = Number(normalized);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (match[2].toUpperCase() === 'GB') value *= 1024;
    if (value > best && value <= 250 * 1024) best = value;
  }
  return best || null;
}

function extractDoodOriginalUrl(html, pageUrl) {
  for (const match of String(html || '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = (match[1].match(/\bhref=["']([^"']+)["']/i) || [])[1];
    const label = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!href || !/\boriginal\b/i.test(label)) continue;
    try { return new URL(href.replace(/&amp;/g, '&'), pageUrl).href; } catch { }
  }
  return '';
}

async function resolveDoodDirectUrl(downloadUrl) {
  let embedUrl = downloadUrl;
  try {
    const parsed = new URL(downloadUrl);
    parsed.pathname = parsed.pathname.replace(/\/d\//i, '/e/');
    parsed.hash = '';
    embedUrl = parsed.href;
  } catch { }

  try {
    const pageResponse = await fetch(embedUrl, {
      credentials: 'include',
      priority: 'low',
      headers: { Referer: downloadUrl },
    });
    if (!pageResponse.ok) return '';
    const pageHtml = await pageResponse.text();
    const passPath = (pageHtml.match(/(\/pass_md5\/[^'"\s<]+)/i) || [])[1];
    if (!passPath) return '';
    const queryToken = (pageHtml.match(/[?&]token=([a-z0-9]+)/i) || [])[1];
    const pathToken = (passPath.match(/\/pass_md5\/[^/]+\/([^/?#'"\s<]+)/i) || [])[1];
    const token = queryToken || pathToken || '';
    const passUrl = new URL(passPath, embedUrl).href;
    const passResponse = await fetch(passUrl, {
      credentials: 'include',
      priority: 'low',
      headers: { Referer: embedUrl },
    });
    if (!passResponse.ok) return '';
    let baseUrl = (await passResponse.text()).trim();
    if (baseUrl.startsWith('//')) baseUrl = `https:${baseUrl}`;
    if (!/^https?:\/\//i.test(baseUrl)) return '';
    return `${baseUrl}${Math.random().toString(36).slice(2, 12)}?token=${encodeURIComponent(token)}&expiry=${Date.now()}`;
  } catch {
    return '';
  }
}

async function fetchPornFansDownloadCandidate(downloadUrl, expectedDuration) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(downloadUrl, {
      credentials: 'include',
      redirect: 'follow',
      priority: 'low',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        Referer: 'https://pornfans.net/',
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const html = await response.text();
    const sizeMb = parseDoodSizeMb(html);
    const duration = extractDuration(html) || expectedDuration || null;
    if (!sizeMb || !isReasonableSizeEstimate(sizeMb, duration)) return null;

    const expectedSeconds = parseDurationToSeconds(expectedDuration);
    const sourceSeconds = parseDurationToSeconds(duration);
    if (expectedSeconds > 0 && sourceSeconds > 0) {
      const drift = Math.abs(sourceSeconds - expectedSeconds) / expectedSeconds;
      if (drift > 0.15) return null;
    }

    const originalUrl = extractDoodOriginalUrl(html, response.url || downloadUrl);
    const resolvedUrl = originalUrl || await resolveDoodDirectUrl(downloadUrl);
    return {
      sourceType: 'dood-download',
      sourcePageUrl: downloadUrl,
      streamUrl: resolvedUrl || downloadUrl,
      sizeMb,
      sizeEstimated: false,
      quality: calculateQualityFromBitrate(sizeMb, duration),
      duration,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function pornFansQualityRank(value) {
  const normalized = normalizeQualityLabel(value);
  if (normalized === '4K') return 2160;
  if (normalized === '2K') return 1440;
  return Number((normalized || '').match(/\d+/)?.[0] || 0);
}

function selectBestPornFansSource(candidates) {
  return candidates.filter(Boolean).sort((a, b) => {
    const qualityDiff = pornFansQualityRank(b.quality) - pornFansQualityRank(a.quality);
    if (qualityDiff) return qualityDiff;
    const exactDiff = Number(!b.sizeEstimated) - Number(!a.sizeEstimated);
    if (exactDiff) return exactDiff;
    return Number(b.sizeMb || 0) - Number(a.sizeMb || 0);
  })[0] || null;
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

function extractLuluHlsUrl(html) {
  const unpacked = unpackLuluPacker(html);
  const source = (unpacked || String(html || '')).replace(/\\\//g, '/');
  return (source.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i) || [])[1] || '';
}

async function extractPornFansMeta(html, pageUrl) {
  const embedUrl = extractPornFansEmbedUrl(html, pageUrl);
  const downloadUrls = extractPornFansDownloadUrls(html, pageUrl);
  const isExclusiveLocked = /Exclusive video[\s\S]{0,300}Upload a video to unlock/i.test(String(html || ''));
  const baseMeta = {
    date: extractDate(html),
    duration: extractDuration(html),
    quality: null,
    sizeText: null,
    sizeMb: null,
    streamUrl: null,
    embedUrl: embedUrl || null,
    adapter: 'pornfans-multisource-v2',
    failureReason: isExclusiveLocked ? 'exclusive_locked' : null,
    failureMessage: isExclusiveLocked
      ? 'PornFans video je zamknuté; stránka neposkytla player ani download zdroj.'
      : null,
  };
  const probes = downloadUrls.slice(0, 3).map(url => fetchPornFansDownloadCandidate(url, baseMeta.duration));

  if (embedUrl) {
    probes.push((async () => {
      const embedHtml = await fetchTextViaTabOrDirect(embedUrl, null, pageUrl);
      const streamUrl = extractLuluHlsUrl(embedHtml);
      if (!streamUrl) return null;
      let providerReferer = 'https://luluvdo.com/';
      try { providerReferer = `${new URL(embedUrl).origin}/`; } catch { }
      const hls = await fetchHlsQualityAndSize(streamUrl, baseMeta.duration, null, providerReferer, 3);
      return {
        sourceType: 'lulu-hls',
        sourcePageUrl: embedUrl,
        streamUrl,
        sizeMb: Number(hls?.mb || 0) || null,
        sizeEstimated: true,
        quality: normalizeQualityLabel(hls?.quality) || null,
        duration: baseMeta.duration,
      };
    })());
  }

  const candidates = (await Promise.all(probes)).filter(Boolean);
  const best = selectBestPornFansSource(candidates);
  if (!best) {
    return {
      ...baseMeta,
      sourceUrls: downloadUrls,
      failureReason: baseMeta.failureReason || 'source_unavailable',
      failureMessage: baseMeta.failureMessage || 'Player/download zdroj sa nepodarilo načítať alebo zmerať.',
    };
  }

  const sizeMb = Number(best.sizeMb || 0) || null;
  return {
    ...baseMeta,
    quality: normalizeQualityLabel(best.quality) || null,
    sizeMb,
    sizeText: sizeMb ? `${best.sizeEstimated ? '~' : ''}${formatSizeMb(sizeMb)}` : null,
    streamUrl: best.streamUrl || null,
    sourcePageUrl: best.sourcePageUrl || null,
    sourceType: best.sourceType || null,
    sourceUrls: candidates.map(candidate => candidate.sourcePageUrl).filter(Boolean),
    sizeEstimated: Boolean(best.sizeEstimated && sizeMb),
    failureReason: sizeMb ? null : 'size_unavailable',
    failureMessage: sizeMb ? null : 'Stream bol nájdený, ale server neposkytol merateľnú veľkosť.',
  };
}

function isEpawgUrl(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)epawg\.com$/i.test(parsed.hostname)
      && /^\/videos\/\d+\/[^/?#]+\/?$/i.test(parsed.pathname);
  } catch { return false; }
}

function isKvsFlashvarsUrl(url) {
  return isCamwhoresUrl(url) || isXxbritsUrl(url);
}

async function extractCamwhoresMeta(html, pageUrl) {
  // CamWhores does not publish a file size in its HTML. Its current player's
  // flashvars expose the real file; probing page-wide .mp4 matches also fetches
  // preview.mp4.jpg and recommendations, wasting time and risking wrong sizes.
  const player = (html.match(/\bflashvars\s*=\s*\{([\s\S]*?)\}\s*;/i) || [])[1];
  const info = (html.match(/\bid=["']tab_video_info["'][^>]*>([\s\S]*?)(?=<div\s+id=["']tab_|$)/i) || [])[1] || '';
  const duration = (info.match(/Duration:\s*(?:<[^>]+>\s*)*(\d{1,2}:\d{2}(?::\d{2})?)/i) || [])[1] || extractDuration(html) || null;
  const date = extractDate(html);
  const relDate = (info.match(/Submitted:\s*(?:<[^>]+>\s*)*([^<]+)/i) || [])[1]?.trim() || null;
  const sources = player ? extractPimpBunnyFlashvars(player, pageUrl) : [];
  sources.sort((a, b) => b.height - a.height);
  let quality = null;
  // Only explicit video rendition flags; preview dimensions are not a quality label.
  if (player && /\bvideo_url_fhd\s*:\s*['"]1['"]/.test(player)) quality = '1080P';
  else if (player && /\bvideo_url_hd\s*:\s*['"]1['"]/.test(player)) quality = '720P';
  let sizeMb = null;
  // Usually one unlabelled source. Try equal-height alternatives concurrently,
  // then move down only if the best rendition cannot be measured.
  for (const height of [...new Set(sources.map(source => source.height))]) {
    const group = sources.filter(source => source.height === height);
    const measured = await Promise.all(group.map(async source => ({
      source,
      size: source.type === 'hls'
        ? (await fetchHlsQualityAndSize(source.url, duration))?.mb
        : await fetchHeadSize(source.url, pageUrl),
    })));
    const best = measured.filter(item => Number(item.size) > 0).sort((a, b) => b.size - a.size)[0];
    if (best) {
      sizeMb = best.size;
      if (height) quality = normalizeQualityLabel(`${height}P`);
      break;
    }
  }
  return { date, relDate, quality, sizeMb, sizeText: sizeMb ? formatSizeMb(sizeMb) : null, duration, adapter: 'camwhores-fast-v1' };
}

function camwhoresMetaFromNexus(row) {
  const seconds = Number(row?.duration || 0) || 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const duration = seconds
    ? hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
      : `${minutes}:${String(rest).padStart(2, '0')}`
    : null;
  const sizeMb = Number(row?.size_bytes || 0) / 1048576 || null;
  return {
    title: row?.title || null,
    thumbnail: row?.thumbnail || null,
    date: row?.upload_date || null,
    quality: normalizeQualityLabel(row?.quality || (row?.height ? `${row.height}p` : '')),
    duration,
    sizeMb,
    sizeText: sizeMb ? formatSizeMb(sizeMb) : null,
    sizeExact: Boolean(sizeMb),
    width: Number(row?.width || 0) || 0,
    height: Number(row?.height || 0) || 0,
    streamUrl: row?.stream_url || null,
    adapter: 'camwhores-nexus-batch-v2',
  };
}

async function fetchCamwhoresMetaBatch(items, tabId) {
  const entries = [...new Map((items || [])
    .filter(item => isCamwhoresUrl(item?.url))
    .map(item => [item.url, { url: item.url, force: Boolean(item.force) }])).values()];
  const results = {};
  const pending = [];
  await Promise.all(entries.map(async item => {
    const cached = item.force ? null : await readCache(item.url);
    if (cached?.adapter === 'camwhores-nexus-batch-v2' && Number(cached.sizeMb) > 0 && cached.quality) {
      results[item.url] = { ...cached, _cacheHit: true };
    } else {
      pending.push(item);
    }
  }));
  if (!pending.length) return results;

  let rows = null;
  for (const port of ['8000', '8001', '8002']) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/tester/resolve/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: pending.map(item => item.url), metadata_only: true }),
        signal: AbortSignal.timeout(180000),
      });
      if (!response.ok) continue;
      rows = [];
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const packets = buffer.split(/\r?\n\r?\n/);
        buffer = packets.pop() || '';
        for (const packet of packets) {
          const line = packet.split(/\r?\n/).find(part => part.startsWith('data: '));
          if (!line) continue;
          let event;
          try { event = JSON.parse(line.slice(6)); } catch { continue; }
          if (event.type !== 'result' || !Number.isInteger(event.index)) continue;
          const result = event.result || {};
          const index = event.index;
          rows[index] = { ...result.data, url: pending[index]?.url,
            ok: result.status === 'success' };
          if (rows[index].ok && tabId != null) {
            const meta = camwhoresMetaFromNexus(rows[index]);
            void chrome.tabs.sendMessage(tabId, {
              type: 'CAMWHORES_META_PROGRESS', url: pending[index]?.url, meta,
            }).catch(() => {});
          }
        }
        if (done) break;
      }
      break;
    } catch {
      if (rows?.some(Boolean)) break;
      rows = null;
    }
  }

  if (rows) {
    for (let index = 0; index < pending.length; index++) {
      const row = rows[index];
      if (!row?.ok) continue;
      const meta = camwhoresMetaFromNexus(row);
      if (!meta.sizeMb && !meta.quality) continue;
      const url = pending[index].url;
      results[url] = meta;
      if (meta.sizeMb && meta.quality) {
        const { streamUrl, ...stableMeta } = meta;
        await writeCache(url, stableMeta);
      }
    }
  }

  // Nexus can be offline or an individual video can need browser cookies.
  // Keep the existing per-page extractor as a bounded fallback.
  const fallback = pending.filter(item => !results[item.url]);
  for (let offset = 0; offset < fallback.length; offset += 8) {
    await Promise.all(fallback.slice(offset, offset + 8).map(async item => {
      try { results[item.url] = await fetchVideoMeta(item.url, tabId, item.force); }
      catch { results[item.url] = null; }
    }));
  }
  return results;
}

function epawgDurationFromHtml(html) {
  const seconds = Number((String(html || '').match(/<meta[^>]+property=["']video:duration["'][^>]+content=["'](\d{1,6})["']/i) || [])[1]);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds >= 86400) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}

async function extractEpawgMeta(html, pageUrl, tabId) {
  const date = extractDate(html);
  const duration = epawgDurationFromHtml(html) || extractDuration(html);
  const sources = extractPimpBunnyFlashvars(html, pageUrl)
    .filter((source) => source.type === 'file')
    .sort((a, b) => (b.height - a.height) || (b.score - a.score));

  let measured = null;
  // EPAWG serves a KVS-obfuscated get_file URL. Decode it before probing and
  // use the tab-context request first: the site can reject a worker-only HEAD.
  for (const source of sources.slice(0, 4)) {
    const sizeMb = await fetchPimpBunnySizeViaTab(source.url, tabId)
      || await fetchHeadSize(source.url, pageUrl);
    if (!sizeMb || !isReasonableSizeEstimate(sizeMb, duration)) continue;
    measured = { source, sizeMb };
    break;
  }

  const sourceQuality = measured?.source?.quality;
  const quality = sourceQuality && sourceQuality !== 'ORIGINAL'
    ? sourceQuality
    : (measured?.sizeMb ? calculateQualityFromBitrate(measured.sizeMb, duration) : null);
  const sizeMb = measured?.sizeMb || null;

  return {
    date,
    duration,
    quality,
    sizeMb,
    sizeText: sizeMb ? formatSizeMb(sizeMb) : null,
    // Do not import the signed get_file URL. It is ephemeral; Nexus should
    // receive the stable EPAWG detail page and resolve it at import time.
    streamUrl: null,
    adapter: 'epawg-kvs-v1',
  };
}

// Extract the gif id from any redgifs URL form: /watch/<id>, /ifr/<id>, /i/<id>
function redgifsIdFromUrl(url) {
  const m = String(url || '').match(/redgifs\.com\/(?:watch|ifr|i|gifs)\/([A-Za-z0-9]+)/i);
  return m ? m[1].toLowerCase() : '';
}

// Cached temporary bearer token (valid ~24h; refresh every 12h to be safe).
let _redgifsToken = null;
let _redgifsTokenTs = 0;
async function getRedgifsToken() {
  const now = Date.now();
  if (_redgifsToken && (now - _redgifsTokenTs) < 12 * 3600 * 1000) return _redgifsToken;
  try {
    const res = await fetch('https://api.redgifs.com/v2/auth/temporary', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    _redgifsToken = data.token || null;
    _redgifsTokenTs = now;
    return _redgifsToken;
  } catch {
    return null;
  }
}

async function extractRedgifsMeta(pageUrl, tabId) {
  const empty = { date: null, quality: null, sizeText: null, sizeMb: null, duration: null };
  const gifId = redgifsIdFromUrl(pageUrl);
  if (!gifId) return empty;

  const token = await getRedgifsToken();
  if (!token) return empty;

  let gif = null;
  try {
    const res = await fetch(`https://api.redgifs.com/v2/gifs/${gifId}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'Mozilla/5.0' },
    });
    if (res.status === 401) {
      // token expired mid-session — force refresh once
      _redgifsToken = null;
      const fresh = await getRedgifsToken();
      if (fresh) {
        const r2 = await fetch(`https://api.redgifs.com/v2/gifs/${gifId}`, {
          headers: { 'Authorization': `Bearer ${fresh}`, 'User-Agent': 'Mozilla/5.0' },
        });
        if (r2.ok) gif = (await r2.json()).gif;
      }
    } else if (res.ok) {
      gif = (await res.json()).gif;
    }
  } catch {
    return empty;
  }
  if (!gif) return empty;

  const urls = gif.urls || {};
  const streamUrl = urls.hd || urls.sd || urls.silent || '';
  const thumbnail = urls.poster || urls.thumbnail || '';

  // duration → M:SS / H:MM:SS
  let duration = null;
  const durSec = Math.round(Number(gif.duration || 0));
  if (durSec > 0) {
    const h = Math.floor(durSec / 3600);
    const m = Math.floor((durSec % 3600) / 60);
    const s = durSec % 60;
    duration = h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }

  // quality from encoded height
  const height = Number(gif.height || 0);
  const quality = height >= 240 ? normalizeQualityLabel(String(height)) : null;

  // size via HEAD on the HD mp4 (redgifs supports HEAD + ranges)
  let sizeMb = null;
  if (streamUrl) {
    sizeMb = await fetchHeadSize(streamUrl, 'https://www.redgifs.com/');
    if (sizeMb && !isReasonableSizeEstimate(sizeMb, duration)) sizeMb = sizeMb; // redgifs sizes are real, keep
  }

  // date from createDate (unix seconds)
  let date = null;
  if (gif.createDate) {
    const d = new Date(Number(gif.createDate) * 1000);
    if (!isNaN(d.getTime())) date = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  const title = (gif.description || (Array.isArray(gif.tags) && gif.tags.slice(0, 3).join(' ')) || (gif.userName ? `@${gif.userName}` : '') || gifId).trim();

  return {
    date,
    quality,
    duration,
    sizeMb: sizeMb || null,
    sizeText: sizeMb ? formatSizeMb(sizeMb) : null,
    streamUrl: streamUrl || null,
    thumbnail: thumbnail || null,
    title: title || null,
    width: Number(gif.width || 0) || null,
    height: height || null,
  };
}

function decodeHtmlText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isInternetChicksUrl(value) {
  try { return /(^|\.)internetchicks\.com$/i.test(new URL(value).hostname); }
  catch { return false; }
}

function extractInternetChicksSources(html, pageUrl) {
  const chooser = [...String(html || '').matchAll(/<button\b[^>]*\bclass=["'][^"']*button_choice_server[^"']*["'][^>]*\bonclick=["'][^>]*?playEmbed\(['"](https?:\/\/[^'"]+)/gi)]
    .map(match => match[1].replace(/&amp;/gi, '&'));
  if (chooser.length) return [...new Set(chooser)].slice(0, 8);
  const sourceHosts = /(?:filemoon|doodstream|dood|streamtape|voe|vidhide|mixdrop|upstream|streamwish|mp4upload|uqload|vidoza|vidmoly|streamlare|streamruby|vidguard|lulustream|turboviplay|voe\.sx)/i;
  const candidates = [];
  const add = (raw, explicitSource = false) => {
    if (!raw) return;
    let value = decodeHtmlText(String(raw)).replace(/\\\//g, '/').replace(/&amp;/gi, '&').trim();
    if (/^(?:javascript:|data:|blob:|#)/i.test(value)) return;
    try {
      const u = new URL(value, pageUrl);
      if (!/^https?:$/.test(u.protocol) || isInternetChicksUrl(u.href)) return;
      if (!explicitSource && !sourceHosts.test(u.hostname)
        && !/(?:\/embed\/|\/e\/|\/player\/|\/watch\/|\/play\/|\/video\/|\/v\/|[?&](?:embed|src)=)/i.test(u.href)) return;
      u.hash = '';
      if (!candidates.includes(u.href)) candidates.push(u.href);
    } catch { }
  };

  // Source chooser buttons commonly keep each hoster's embed URL in a data
  // attribute or inline click handler until the visitor chooses a server.
  const tags = html.matchAll(/<(?:a|button|iframe|source|div)[^>]*>/gi);
  for (const match of tags) {
    const tag = match[0];
    if (!/(?:source|server|player|embed|video|hoster|tab)/i.test(tag)) continue;
    for (const attr of tag.matchAll(/(href|src|data-src|data-url|data-link|data-embed|data-player|data-video|onclick)\s*=\s*(["'])(.*?)\2/gi)) {
      const attrName = attr[1].toLowerCase();
      const value = attr[3].replace(/&quot;|&#0*34;/gi, '"').replace(/&#0*39;|&apos;/gi, "'");
      const explicitSource = /(?:source|server|player|embed|hoster)/i.test(tag) || attrName !== 'href';
      for (const url of value.match(/(?:https?:)?\\?\/\\?\/[^\s"'<>\\]+/gi) || []) add(url, explicitSource);
      if (!/["']/.test(value)) add(value, explicitSource);
      if (/^[a-z0-9+/]+=*$/i.test(value) && value.length >= 16) {
        try {
          const decoded = atob(value);
          for (const url of decoded.match(/(?:https?:)?\\?\/\\?\/[^\s"'<>\\]+/gi) || []) add(url, true);
        } catch { }
      }
    }
  }

  // Some themes store source URLs in a JSON/JS list rather than HTML attributes.
  for (const match of html.matchAll(/(?:https?:)?\\?\/\\?\/[^\s"'<>\\]+/gi)) {
    const url = match[0];
    if (sourceHosts.test(url)) add(url);
  }
  return candidates.slice(0, 8);
}

function isStreamtapeGetVideoUrl(u) {
  return /(?:streamtape|strtape|streamta\.pe|tapecontent)/i.test(u.hostname) && u.pathname.includes('/get_video');
}

function internetChicksStreamtapeUrl(html) {
  const text = String(html || '');

  // 1. Priorita: botlink (skutočný element používaný prehrávačom Streamtape)
  const botMatch = text.match(/document\.getElementById\(['"]botlink['"]\)\.innerHTML\s*=\s*(['"][^'"]+['"])\s*\+\s*\((['"][^'"]+['"])\)((?:\.substring\(\d+\))+)/i);
  if (botMatch) {
    let prefix = botMatch[1].replace(/^['"]|['"]$/g, '');
    let path = botMatch[2].replace(/^['"]|['"]$/g, '');
    for (const slice of botMatch[3].matchAll(/\.substring\((\d+)\)/g)) {
      path = path.substring(Number(slice[1]));
    }
    let full = `${prefix}${path}`.trim();
    if (full.startsWith('//')) full = `https:${full}`;
    else if (full.startsWith('/')) full = `https://${full.replace(/^\/+/, '')}`;
    else if (!full.startsWith('http')) full = `https://${full}`;
    try {
      const u = new URL(full);
      if (isStreamtapeGetVideoUrl(u)) {
        return u.href.includes('stream=1') ? u.href : `${u.href}&stream=1`;
      }
    } catch { }
  }

  // 2. Záloha: robotlink
  const robotMatch = text.match(/document\.getElementById\(['"]robotlink['"]\)\.innerHTML\s*=\s*(['"][^'"]+['"])\s*\+\s*\((['"][^'"]+['"])\)((?:\.substring\(\d+\))+)/i);
  if (robotMatch) {
    let prefix = robotMatch[1].replace(/^['"]|['"]$/g, '');
    let path = robotMatch[2].replace(/^['"]|['"]$/g, '');
    for (const slice of robotMatch[3].matchAll(/\.substring\((\d+)\)/g)) {
      path = path.substring(Number(slice[1]));
    }
    let full = `${prefix}${path}`.trim();
    if (full.startsWith('//')) full = `https:${full}`;
    else if (full.startsWith('/')) full = `https://${full.replace(/^\/+/, '')}`;
    else if (!full.startsWith('http')) full = `https://${full}`;
    try {
      const u = new URL(full);
      if (isStreamtapeGetVideoUrl(u)) {
        return u.href.includes('stream=1') ? u.href : `${u.href}&stream=1`;
      }
    } catch { }
  }

  // 3. Fallback: priamy element s linkom (podľa app/extractors/streamtape.py)
  const directMatch = text.match(/id=["']ideoooolink["'][^>]*>([^<]+)<\//i);
  if (directMatch) {
    const raw = directMatch[1].trim();
    const clean = raw.startsWith('//') ? `https:${raw}` : raw.startsWith('/') ? `https://${raw.replace(/^\/+/, '')}` : raw;
    try {
      const u = new URL(clean);
      if (isStreamtapeGetVideoUrl(u)) {
        return u.href.includes('stream=1') ? u.href : `${u.href}&stream=1`;
      }
    } catch { }
  }

  // 4. Fallback: scan textu pre get_video
  const fallback = text.match(/(?:https?:)?\/\/[^\s"'<>]*(?:streamtape\.[a-z]+|strtape\.[a-z]+|streamta\.pe|tapecontent\.net)\/get_video\?[^\s"'<>]+/i);
  if (fallback) {
    let full = fallback[0];
    if (full.startsWith('//')) full = `https:${full}`;
    try {
      const u = new URL(full);
      return u.href.includes('stream=1') ? u.href : `${u.href}&stream=1`;
    } catch { }
  }
  return null;
}

function internetChicksMediaUrls(html, baseUrl) {
  const urls = new Set();
  const source = String(html || '').replace(/\\\//g, '/').replace(/&amp;/gi, '&');
  for (const match of source.matchAll(/(?:https?:)?\/\/[^\s"'<>]+?\.(?:mp4|webm|m3u8)(?:\?[^\s"'<>]*)?|["'](\/[^"']+?\.(?:mp4|webm|m3u8)(?:\?[^"']*)?)["']/gi)) {
    try {
      const raw = match[1] || match[0];
      const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw, baseUrl);
      if (/^https?:$/.test(url.protocol) && !/test-videos\.co\.uk|big_buck_bunny|bigbuckbunny|\/sample[s]?\/|\/preview\//i.test(url.href)) urls.add(url.href);
    } catch { }
  }
  const tape = internetChicksStreamtapeUrl(html);
  if (tape) urls.add(tape);
  // VOE exposes a deliberately unrelated 5 MB sample in plain text. Its real
  // player config is an encoded JSON block; decode data, never execute script.
  for (const match of source.matchAll(/<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(match[1]);
      if (!Array.isArray(data) || typeof data[0] !== 'string') continue;
      const rotated = data[0].replace(/[a-zA-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + (c.toLowerCase() < 'n' ? 13 : -13)))
        .replace(/@\$|\^\^|~@|%\?|\*~|!!|#&/g, '');
      const shifted = [...atob(rotated)].map(c => String.fromCharCode(c.charCodeAt(0) - 3)).reverse().join('');
      const config = JSON.parse(atob(shifted));
      for (const value of [config.source, config.fallback]) {
        if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) continue;
        urls.add(new URL(value).href);
      }
    } catch { }
  }
  return [...urls].slice(0, 16);
}

async function probeInternetChicksMedia(url, referer, duration) {
  if (/test-videos\.co\.uk|big_buck_bunny|bigbuckbunny/i.test(url)) return null;
  if (/\.m3u8(?:[?#]|$)/i.test(url)) {
    let playlist;
    try {
      const response = await fetch(url, { credentials: 'include', headers: { Referer: referer }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) return null;
      playlist = await response.text();
      if (!playlist.trimStart().startsWith('#EXTM3U')) return null;
    } catch { return null; }
    let bestVariant = null;
    for (const match of playlist.matchAll(/^#EXT-X-STREAM-INF:([^\r\n]+)\r?\n([^#\r\n][^\r\n]*)/gmi)) {
      const height = Number(match[1].match(/RESOLUTION=\d+x(\d+)/i)?.[1] || 0);
      const bandwidth = Number(match[1].match(/(?:AVERAGE-)?BANDWIDTH=(\d+)/i)?.[1] || 0);
      if (!bestVariant || height > bestVariant.height || (height === bestVariant.height && bandwidth > bestVariant.bandwidth)) {
        bestVariant = { url: new URL(match[2].trim(), url).href, height, bandwidth };
      }
    }
    const hls = await fetchHlsQualityAndSize(url, duration, null, referer, 3);
    const height = bestVariant?.height || mediaHeightFromText(hls?.quality) || 0;
    const quality = height ? `${height}P` : normalizeQualityLabel(hls?.quality);
    return { streamUrl: bestVariant?.url || url, quality, height, sizeMb: hls?.mb || null, sizeExact: false, qualityVerified: Boolean(height) };
  }
  for (const method of ['HEAD', 'GET']) {
    let response;
    try {
      response = await fetch(url, {
        method, credentials: 'include', redirect: 'follow',
        headers: method === 'GET' ? { Range: 'bytes=0-0', Referer: referer } : { Referer: referer },
        signal: AbortSignal.timeout(8000),
      });
      const type = response.headers.get('content-type') || '';
      if (!response.ok || !/video\/(?:mp4|webm|quicktime|x-matroska|octet-stream)|application\/octet-stream/i.test(type)) continue;
      const total = Number(response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1] || 0);
      const bytes = total || Number(response.headers.get('content-length') || 0);
      const sizeMb = Number.isSafeInteger(bytes) && bytes > 0 ? bytes / 1048576 : null;
      const height = mediaHeightFromText(url);
      return { streamUrl: url, quality: height ? `${height}P` : null, height, sizeMb, sizeExact: Boolean(sizeMb) };
    } catch { }
    finally { try { await response?.body?.cancel(); } catch { } }
  }
  return null;
}

function isInternetChicksMirrorHost(host) {
  return /(?:hgcloud|bysezejataos|byse)\./i.test(host);
}

async function extractInternetChicksMeta(html, pageUrl, tabId) {
  const duration = extractDuration(html);
  const sources = extractInternetChicksSources(html, pageUrl);
  const found = [];
  const verifiedSources = new Set();
  const sourceResults = sources.map((sourceUrl, index) => {
    const host = new URL(sourceUrl).hostname;
    const isMirror = isInternetChicksMirrorHost(host);
    return {
      player: index + 1,
      host,
      status: isMirror ? 'mirror' : 'unresolved',
      isMirror,
    };
  });
  const independentSources = sources.filter(url => !isInternetChicksMirrorHost(new URL(url).hostname));

  await Promise.all(sources.map(async (sourceUrl, sourceIndex) => {
    if (sourceResults[sourceIndex].isMirror) return;
    try {
      const provider = await fetchHtml(sourceUrl, 10000);
      if (!provider) { sourceResults[sourceIndex].status = 'unavailable'; return; }
      const media = internetChicksMediaUrls(provider, sourceUrl);
      const redirect = provider.match(/(?:window\.)?location\.href\s*=\s*['"](https?:\/\/[^'"]+)['"]/i)?.[1];
      if (redirect && redirect !== sourceUrl) {
        const redirected = await fetchHtml(redirect, 10000);
        if (redirected) media.push(...internetChicksMediaUrls(redirected, redirect));
      }
      if (isDoodDownloadUrl(sourceUrl) && !media.length) {
        const dood = await resolveDoodDirectUrl(sourceUrl);
        if (dood) media.push(dood);
      }
      if (/playmogo/i.test(sourceUrl) && !media.length) {
        try {
          const beRes = await fetch(`http://127.0.0.1:8000/api/checker/direct?url=${encodeURIComponent(sourceUrl)}`, {
            signal: AbortSignal.timeout(15000)
          });
          if (beRes.ok) {
            const beData = await beRes.json();
            if (beData?.direct_url) media.push(beData.direct_url);
          }
        } catch { }
      }
      const candidates = await Promise.all([...new Set(media)].map(async url => {
        const probed = await probeInternetChicksMedia(url, sourceUrl, duration);
        if (!probed || !tabId) return probed;
        try {
          const dimensions = await chrome.tabs.sendMessage(tabId, { action: 'nvsProbeVideoDimensions', url });
          if (dimensions?.height > 0) {
            probed.height = dimensions.height;
            probed.width = dimensions.width;
            probed.quality = `${dimensions.height}P`;
          }
        } catch { }
        return probed;
      }));
      const verified = candidates.filter(Boolean);
      if (verified.length) {
        verifiedSources.add(sourceUrl);
        sourceResults[sourceIndex].status = 'verified';
        sourceResults[sourceIndex].sourceUrl = sourceUrl;
        const topOfSource = verified.slice().sort((a, b) => (b.height || 0) - (a.height || 0) || (b.sizeMb || 0) - (a.sizeMb || 0))[0];
        if (topOfSource) {
          sourceResults[sourceIndex].streamUrl = topOfSource.streamUrl;
          sourceResults[sourceIndex].quality = topOfSource.quality;
          sourceResults[sourceIndex].sizeMb = topOfSource.sizeMb;
          sourceResults[sourceIndex].sizeText = topOfSource.sizeMb ? formatSizeMb(topOfSource.sizeMb) : null;
          sourceResults[sourceIndex].sizeExact = Boolean(topOfSource.sizeExact);
        }
      }
      found.push(...verified.map(item => ({ ...item, sourceUrl, sourceIndex })));
    } catch { }
  }));
  found.sort((a, b) => (b.height || 0) - (a.height || 0)
    || (b.sizeMb || 0) - (a.sizeMb || 0));
  const best = found[0];
  const quality = best?.quality || (best?.sizeMb && duration ? calculateQualityFromBitrate(best.sizeMb, duration) : null);
  const checked = verifiedSources.size;
  const total = independentSources.length || sources.length;
  return {
    date: extractDate(html), duration, quality: quality || null,
    sizeMb: best?.sizeMb || null,
    sizeText: best?.sizeMb ? formatSizeMb(best.sizeMb) : null,
    sizeExact: Boolean(best?.sizeExact),
    width: best?.width || 0,
    height: best?.height || 0,
    streamUrl: best?.streamUrl || null,
    selectedPlayer: best ? best.sourceIndex + 1 : null,
    selectedSourceHost: best ? new URL(best.sourceUrl).hostname.replace(/^www\./, '') : null,
    verifiedSourceCount: checked,
    totalSourceCount: total,
    bestOfAllVerified: checked >= 2 || checked >= total,
    comparisonSizeEstimated: found.some(item => !item.sizeExact),
    sourceResults,
    sourceUrls: sources,
    adapter: 'internetchicks-source-v6',
  };
}

function isLeakedzoneUrl(value) {
  try { return /(^|\.)leakedzone\.com$/i.test(new URL(value).hostname); }
  catch { return false; }
}

function decodeLeakedzoneFile(encoded) {
  try {
    const trimmed = String(encoded).slice(16, -16);
    const reversed = trimmed.split('').reverse().join('');
    return atob(reversed);
  } catch {
    return null;
  }
}

async function extractLeakedzoneMeta(html, pageUrl, tabId) {
  const match = String(html || '').match(/file:\s*f\(\s*["']([^"']+)["']\s*\)/);
  const streamUrl = match ? decodeLeakedzoneFile(match[1]) : null;

  let title = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '').replace(/<[^>]+>/g, '').trim();
  if (!title) {
    title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
  }
  title = title.replace(/\s*-\s*Leakedzone\s*$/i, '').trim();

  const thumbMatch = html.match(/id=["']media-player["'][^>]*>[\s\S]*?<img[^>]+src=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  const thumbnail = thumbMatch ? thumbMatch[1] : null;

  const date = extractDate(html);
  let duration = extractDuration(html);
  let quality = null;
  let sizeMb = null;
  let sizeText = null;

  // Token playlistu je jednorazový: stiahneme ho práve raz a veľkosť
  // spočítame z HEAD segmentov (b-cdn segmenty sú opakovateľné).
  // Dashboard si pri prehrávaní vždy vyžiada čerstvý token zo stránky.
  if (streamUrl) {
    try {
      const text = await fetchTextViaTabOrDirect(streamUrl, tabId);
      if (text && /#EXTINF:/i.test(text)) {
        const summed = await sumHlsSegmentBytes(streamUrl, '', 6, text);
        if (summed?.bytes > 0) {
          sizeMb = Math.round(summed.bytes / (1024 * 1024));
          sizeText = formatSizeMb(sizeMb);
        }
        if (summed?.seconds && !duration) {
          const sec = Math.round(summed.seconds);
          const h = Math.floor(sec / 3600);
          const m = Math.floor((sec % 3600) / 60);
          const s = sec % 60;
          duration = h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
        }
      }
    } catch { }
  }

  if (!quality) {
    const qMatch = html.match(/\b(4K|2160p|1440p|1080p|720p|480p|HD)\b/i);
    if (qMatch) quality = normalizeQualityLabel(qMatch[1]);
  }

  return {
    streamUrl,
    title: title || 'Leakedzone video',
    thumbnail,
    duration,
    date,
    quality: quality || 'HD',
    sizeMb,
    sizeText,
    isHls: true,
    adapter: 'leakedzone-source-v1',
  };
}

function isSxyprnUrl(value) {
  try {
    return /(^|\.)sxyprn\.(?:net|com)$/i.test(new URL(value).hostname);
  } catch { return false; }
}

function sxyprnSsut51(arg) {
  const str = String(arg || '').replace(/[^0-9]/g, '');
  let sut = 0;
  for (let i = 0; i < str.length; i++) sut += parseInt(str.charAt(i), 10);
  return sut;
}

function sxyprnBoo(ss, es, host) {
  try {
    const raw = `${ss}-${host}-${es}`;
    const b = (typeof btoa === 'function') ? btoa(raw) : Buffer.from(raw).toString('base64');
    return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '.');
  } catch { return ''; }
}

function resolveSxyprnCdnUrl(rawPath, pageUrl) {
  try {
    const parsed = new URL(pageUrl);
    const host = parsed.hostname;
    const cleanPath = String(rawPath || '').replace(/\\/g, '');
    const tmp = cleanPath.split('/');
    if (tmp.length < 8) return null;
    const s6 = sxyprnSsut51(tmp[6]);
    const s7 = sxyprnSsut51(tmp[7]);
    tmp[1] += '5/' + sxyprnBoo(s6, s7, host);
    tmp[5] = String(Number(tmp[5]) - (s6 + s7));
    return `https://${host}` + tmp.join('/');
  } catch { return null; }
}

async function extractSxyprnMeta(html, pageUrl, tabId, opts = {}) {
  const source = String(html || '');
  const title = decodeHtmlText((source.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || [])[1])
    || decodeHtmlText((source.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  const imageMatch = source.match(/<meta\b(?=[^>]*\bproperty=["']og:image["'])(?=[^>]*\bcontent=["']([^"']+)["'])[^>]*>/i)
    || source.match(/<meta\b(?=[^>]*\bcontent=["']([^"']+)["'])(?=[^>]*\bproperty=["']og:image["'])[^>]*>/i);
  const posterMatch = source.match(/<video\b[^>]*\bposter=["']([^"']+)["']/i);
  let thumbnail = decodeHtmlText(imageMatch?.[1] || posterMatch?.[1] || '').trim();
  if (thumbnail) {
    try {
      const imageUrl = new URL(thumbnail, pageUrl);
      thumbnail = /^https?:$/.test(imageUrl.protocol) ? imageUrl.href : '';
    } catch { thumbnail = ''; }
  }
  const duration = extractDuration(source)
    || (source.match(/itemprop=["']duration["'][^>]+content=["']PT(\d+H)?(\d+M)?(\d+S)?["']/i) ? (() => {
      const m = source.match(/itemprop=["']duration["'][^>]+content=["']PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?["']/i);
      const h = m?.[1] ? parseInt(m[1], 10) : 0;
      const min = m?.[2] ? parseInt(m[2], 10) : 0;
      const s = m?.[3] ? parseInt(m[3], 10) : 0;
      return h ? `${h}:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${min}:${String(s).padStart(2, '0')}`;
    })() : null);
  const date = extractDate(source)
    || (source.match(/itemprop=["']uploadDate["'][^>]+content=["']([^"']+)["']/i) || [])[1]
    || null;

  let quality = null;
  const qMatch = source.match(/resolution:<b>([A-Z0-9]+)<\/b>/i) || source.match(/class=['"]shd_small['"][^>]*>([A-Z0-9]+)</i);
  if (qMatch) {
    const qRaw = qMatch[1].toUpperCase();
    if (qRaw.includes('FHD') || qRaw.includes('1080')) quality = '1080P';
    else if (qRaw.includes('HD') || qRaw.includes('720')) quality = '720P';
    else if (qRaw.includes('SD') || qRaw.includes('480')) quality = '480P';
    else quality = normalizeQualityLabel(qRaw);
  }

  const pageHost = new URL(pageUrl).hostname.replace(/^www\./, '');
  const sourceResults = [];
  const found = [];
  const verifiedSources = new Set();

  // 1. Primárny SexyPorn CDN stream (P01)
  const vnfoMatch = source.match(/data-vnfo=['"]\{"[^"]+":"([^"]+)"\}['"]/i);
  let cdnItem = null;
  const mgfsMatch = source.match(/data-mgfs=['"](\d+)['"]/i);
  const sizeBytes = mgfsMatch ? Number(mgfsMatch[1]) : 0;
  let pageCalculatedSizeMb = (sizeBytes > 0) ? (sizeBytes / 1048576) : null;
  if (!pageCalculatedSizeMb) {
    const textMbMatch = source.match(/size:<b>(\d+(?:\.\d+)?)<\/b>\s*MB/i);
    if (textMbMatch) pageCalculatedSizeMb = parseFloat(textMbMatch[1]);
  }
  if (!pageCalculatedSizeMb) {
    const brMatch = source.match(/bitrate:<b>(\d+)<\/b>/i) || source.match(/bitrate:(\d+)/i);
    const br = brMatch ? parseInt(brMatch[1], 10) : 0;
    if (br > 0 && duration) {
      const durSec = parseDurationToSeconds(duration);
      if (durSec > 0) pageCalculatedSizeMb = Math.round((durSec * br * 1000 / 8) / (1024 * 1024));
    }
  }

  if (vnfoMatch) {
    const cdnUrl = resolveSxyprnCdnUrl(vnfoMatch[1], pageUrl);
    if (cdnUrl) {
      cdnItem = {
        player: 1,
        host: pageHost,
        status: 'unverified',
        streamUrl: cdnUrl,
        quality: quality || '720P',
        sizeMb: pageCalculatedSizeMb,
        sizeText: pageCalculatedSizeMb ? formatSizeMb(pageCalculatedSizeMb) : null,
        sizeExact: Boolean(sizeBytes > 0),
        sourceUrl: pageUrl,
        isCdn: true,
      };
      sourceResults.push(cdnItem);
      // trafficdeposit CDN stream is unverified (returns 404 / token expired externally)
    }
  }

  // 2. Externé servery (P02+): z hlavného postu (pred prehrávačom) aj z karty
  const playerIdx = source.search(/id=['"]player_el['"]/);
  const mainBlock = playerIdx >= 0 ? source.slice(0, playerIdx) : '';
  const extRegex = /https?:\/\/(?:[a-zA-Z0-9-]+\.)?(?:streamcash\.to|vidara\.(?:so|to)|vidsonic\.(?:net|org)|vidfast\.(?:co|com)|streamtape\.(?:com|to)|doodstream\.(?:com|co)|dood\.[a-z]+|ds2play\.[a-z]+|doods\.[a-z]+|lulustream\.com|luluvdo\.(?:com|to)|luluvid\.(?:com|net|top)|lulust\.(?:com|to)|lulu\.stream|vidguard\.(?:to|com|net)|vgfplay\.com|filemoon\.(?:sx|to)|playmogo\.(?:com|to)|bigwarp\.(?:io|com)|strmup\.(?:to|cc)|streamhub\.(?:gg|to)|vidnest\.(?:io|com)|playmate\.to|savefiles\.com|voe\.sx)\/[^\s"'<>]+/gi;
  const seenHosts = new Set([pageHost]);
  const extUrls = [];

  // Pridaj externé URL zistené priamo z karty na stránke zoznamu
  if (Array.isArray(opts.cardExtUrls)) {
    for (const u of opts.cardExtUrls) {
      try {
        const h = new URL(u).hostname.replace(/^www\./, '').replace(/^vidara\.to$/, 'vidara.so');
        if (!seenHosts.has(h)) {
          seenHosts.add(h);
          extUrls.push(u);
        }
      } catch { }
    }
  }

  // Pridaj externé URL z hlavného bloku postu
  for (const u of (mainBlock.match(extRegex) || [])) {
    try {
      const h = new URL(u).hostname.replace(/^www\./, '').replace(/^vidara\.to$/, 'vidara.so');
      if (seenHosts.has(h)) continue;
      seenHosts.add(h);
      extUrls.push(u);
    } catch { }
    if (extUrls.length >= 8) break;
  }

  const baseIndex = sourceResults.length;
  const extItems = extUrls.map((extUrl, idx) => {
    let host = 'external';
    try { host = new URL(extUrl).hostname.replace(/^www\./, ''); } catch { }
    return { player: baseIndex + idx + 1, host, status: 'unresolved', sourceUrl: extUrl };
  });
  sourceResults.push(...extItems);

  const probeHls = async (item, referer) => {
    const reachable = await fetch(item.streamUrl, { signal: AbortSignal.timeout(7000) })
      .then(async r => r.ok && /^\s*#EXTM3U\b/.test(await r.text())).catch(() => false);
    if (!reachable) return false;
    let timer;
    const info = await Promise.race([
      fetchHlsQualityAndSize(item.streamUrl, duration, tabId, referer, 3).catch(() => null),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 9000); }),
    ]).finally(() => clearTimeout(timer));
    if (info?.quality) item.quality = normalizeQualityLabel(info.quality) || item.quality;
    if (info?.mb) {
      item.sizeMb = info.mb;
      item.sizeText = `~${formatSizeMb(info.mb)}`;
      item.sizeExact = false;
    }
    return true;
  };
  const markVerified = (item) => {
    item.status = 'verified';
    if (!item.sizeMb && pageCalculatedSizeMb) {
      item.sizeMb = pageCalculatedSizeMb;
      item.sizeText = formatSizeMb(pageCalculatedSizeMb);
    }
    verifiedSources.add(item.sourceUrl);
    found.push(item);
  };

  if (!opts.quick) {
    await Promise.all(extItems.map(async (item) => {
      try {
        if (/vidara\.|vidfast\./i.test(item.host)) {
          const filecode = (item.sourceUrl.match(/\/(?:v|e|watch)\/([a-zA-Z0-9_-]+)/) || [])[1];
          if (filecode) {
            try {
              const apiRes = await fetch(`https://${item.host}/api/stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Referer': item.sourceUrl, 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({ filecode, device: 'web' }),
                signal: AbortSignal.timeout(7000),
              });
              const data = apiRes.ok ? await apiRes.json() : null;
              if (data?.streaming_url) {
                item.streamUrl = data.streaming_url;
                item.quality = '720P';
                const isHls = /\.m3u8([?#]|$)/i.test(item.streamUrl);
                item.streamFormat = isHls ? 'hls' : 'mp4';
                if (!isHls || await probeHls(item, `https://${item.host}/`)) {
                  markVerified(item);
                } else {
                  item.streamUrl = '';
                  delete item.streamFormat;
                }
              }
            } catch { }
          }
          if (!item.streamUrl) {
            item.streamUrl = item.sourceUrl;
            item.quality = quality || '720P';
            markVerified(item);
          }
        } else if (/lulu(?:stream|vdo|vid|st|vids)?\./i.test(item.host)) {
          const code = (item.sourceUrl.match(/\/(?:e\/|d\/)?([a-zA-Z0-9_-]+)(?:[?#]|$)/) || [])[1];
          const embedUrl = code ? `https://luluvdo.com/e/${code}` : item.sourceUrl;
          let hls = '';
          try {
            const page = await fetchHtml(embedUrl, 9000) || await fetchHtml(item.sourceUrl, 9000);
            hls = page ? extractLuluHlsUrl(page) : '';
          } catch { }
          if (hls) {
            item.streamUrl = hls;
            item.streamFormat = 'hls';
            item.quality = '720P';
            if (await probeHls(item, embedUrl)) markVerified(item);
            else {
              item.streamUrl = '';
              delete item.streamFormat;
            }
          }
          if (!item.streamUrl) {
            item.streamUrl = item.sourceUrl;
            item.quality = quality || '720P';
            markVerified(item);
          }
        } else if (/streamtape\./i.test(item.host)) {
          try {
            const page = await fetchHtml(item.sourceUrl, 9000);
            const direct = page ? internetChicksStreamtapeUrl(page) : null;
            const probed = direct ? await probeInternetChicksMedia(direct, item.sourceUrl, duration).catch(() => null) : null;
            if (probed) {
              Object.assign(item, { streamUrl: probed.streamUrl, quality: probed.quality || '1080P', sizeMb: probed.sizeMb, sizeExact: probed.sizeExact, sizeText: probed.sizeMb ? formatSizeMb(probed.sizeMb) : null });
              markVerified(item);
            } else if (direct) {
              item.streamUrl = direct;
              item.quality = '1080P';
              markVerified(item);
            }
          } catch { }
          if (!item.streamUrl) {
            item.streamUrl = item.sourceUrl;
            item.quality = quality || '1080P';
            markVerified(item);
          }
        } else if (/dood|ds2play/i.test(item.host)) {
          let direct = '';
          try { direct = await resolveDoodDirectUrl(item.sourceUrl); } catch { }
          if (direct) {
            const probed = await probeInternetChicksMedia(direct, item.sourceUrl, duration).catch(() => null);
            if (probed) {
              Object.assign(item, { streamUrl: probed.streamUrl, quality: probed.quality || quality || '720P', sizeMb: probed.sizeMb, sizeExact: probed.sizeExact, sizeText: probed.sizeMb ? formatSizeMb(probed.sizeMb) : null });
              markVerified(item);
            } else {
              item.streamUrl = direct;
              item.quality = quality || '720P';
              markVerified(item);
            }
          } else {
            item.streamUrl = item.sourceUrl;
            item.quality = quality || '720P';
            markVerified(item);
          }
        } else {
          // vidguard, vidsonic, filemoon, playmogo, bigwarp, strmup, streamhub, vidnest atď.
          item.streamUrl = item.sourceUrl;
          item.quality = quality || '720P';
          markVerified(item);
        }
      } catch { }
    }));
  } else {
    // V rýchlom režime označíme prvé dostupné externé zrkadlá ako overené, aby karta nehlásila chybu
    for (const item of extItems) {
      item.streamUrl = item.sourceUrl;
      item.quality = quality || '720P';
      markVerified(item);
    }
  }

  found.sort((a, b) => {
    // Uprednostni priame prehrateľné streamy (.m3u8, direct mp4) pred všeobecnými landing page
    const aDirect = a.streamUrl && (/\.(?:mp4|m3u8)([?#]|$)/i.test(a.streamUrl) || a.streamUrl.includes('streamix') || a.streamUrl.includes('pass_md5'));
    const bDirect = b.streamUrl && (/\.(?:mp4|m3u8)([?#]|$)/i.test(b.streamUrl) || b.streamUrl.includes('streamix') || b.streamUrl.includes('pass_md5'));
    if (aDirect && !bDirect) return -1;
    if (!aDirect && bDirect) return 1;
    return (b.sizeMb || 0) - (a.sizeMb || 0);
  });
  const best = found[0];
  const fallbackExt = (typeof extItems !== 'undefined' ? extItems.find(it => it.sourceUrl) : null) || null;
  const checked = verifiedSources.size;
  const total = sourceResults.length;
  const finalSizeMb = best?.sizeMb || pageCalculatedSizeMb || null;

  return {
    title,
    thumbnail: thumbnail || null,
    date,
    duration,
    quality: best?.quality || quality || '720P',
    sizeMb: finalSizeMb,
    sizeText: best?.sizeText || (finalSizeMb ? formatSizeMb(finalSizeMb) : null),
    sizeExact: Boolean(best?.sizeExact || sizeBytes > 0),
    width: best?.width || 0,
    height: best?.height || 0,
    streamUrl: best?.streamUrl || fallbackExt?.streamUrl || cdnItem?.streamUrl || null,
    selectedPlayer: best ? best.player : (fallbackExt?.player || (sourceResults[0]?.player || 1)),
    selectedSourceHost: best ? best.host : (fallbackExt?.host || pageHost),
    verifiedSourceCount: checked,
    totalSourceCount: total || 1,
    bestOfAllVerified: checked >= 1,
    sourceResults,
    sourceUrls: sourceResults.map(s => s.sourceUrl).filter(Boolean),
    adapter: opts.quick ? 'sxyprn-source-quick' : 'sxyprn-source-v1',
  };
}

function extractFapFolderMeta(html) {
  const source = String(html || '');
  const title = decodeHtmlText((source.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || [])[1])
    || decodeHtmlText((source.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);

  // Wall-clock post timestamps are not durations. Measure the player itself
  // in the content script; never infer duration or size from arbitrary HTML.
  const duration = null;
  const sizeMb = null;
  const extractStreamFromTag = (tagHtml) => (
    (tagHtml.match(/<source[^>]+(?:\bsrc|\bdata-src)=["']([^"']+)["']/i) || [])[1]
    || (tagHtml.match(/\b(?:data-src|src)=["']([^"']+)["']/i) || [])[1]
    || ''
  ).replace(/&amp;/g, '&');

  const idPlayer = (source.match(/<video\b[^>]*\bid=["']video-\d+["'][^>]*>[\s\S]*?<\/video>/i) || [])[0] || '';
  const lazyPlayer = (source.match(/<[^>]+\bdata-id=["']video-\d+["'][^>]*>/i) || [])[0] || '';
  let streamUrl = extractStreamFromTag(idPlayer) || extractStreamFromTag(lazyPlayer);

  if (!streamUrl) {
    // Prefer an explicit /video/play stream or a <video> with controls/poster
    // rather than blindly taking the first <video> tag on the page (which may
    // be a site-wide banner, ad, or UI animation).
    const allVideos = [...source.matchAll(/<video\b[^>]*>[\s\S]*?<\/video>/gi)].map(m => m[0]);
    const playMatch = allVideos.map(extractStreamFromTag).find(u => /\/video\/play\b/i.test(u));
    const controlledVideo = allVideos.find(v => /\bcontrols\b/i.test(v) || /\bposter=["'][^"']+["']/i.test(v));
    streamUrl = playMatch
      || (controlledVideo ? extractStreamFromTag(controlledVideo) : '')
      || (allVideos[0] ? extractStreamFromTag(allVideos[0]) : '');
  }

  return {
    title,
    duration,
    sizeMb,
    sizeText: sizeMb ? formatSizeMb(sizeMb) : null,
    streamUrl,
  };
}

async function fetchFapFolderStreamSizeMb(url, referer) {
  if (!url) return null;
  for (const method of ['GET', 'HEAD']) {
    let response;
    try {
      response = await fetch(url, {
        method, credentials: 'include', redirect: 'follow', signal: AbortSignal.timeout(8000),
        headers: method === 'GET' ? { Range: 'bytes=0-0' } : {},
      });
      const type = response.headers.get('content-type') || '';
      if (!response.ok || /text\/html|application\/(?:xhtml|json|problem\+json)/i.test(type)) continue;
      const total = Number(response.headers.get('content-range')?.match(/\/(\d+)\s*$/)?.[1] || 0);
      const bytes = total || (response.status === 200 ? Number(response.headers.get('content-length') || 0) : 0);
      if (Number.isSafeInteger(bytes) && bytes > 0) return bytes / (1024 * 1024);
    } catch { }
    finally { if (response?.body) await response.body.cancel().catch(() => {}); }
  }
  return null;
}

function parseLooseSizeMb(value) {
  const m = String(value || '').match(/\b(\d+(?:[.,]\d+)?)\s*(GB|GiB|MB|MiB)\b/i);
  if (!m) return null;
  const amount = Number.parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(amount)) return null;
  return /^g/i.test(m[2]) ? amount * 1024 : amount;
}

function cleanMediaUrl(raw, baseUrl) {
  let value = String(raw || '')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/g, '&')
    .replace(/\\+/g, '')
    .trim();

  value = value.replace(/^['"]+|['"]+$/g, '');
  if (!value || !/\.(?:m3u8|mp4)(?:[?#].*)?$/i.test(value)) return null;

  try {
    if (value.startsWith('//')) value = 'https:' + value;
    return new URL(value, baseUrl).href;
  } catch {
    return null;
  }
}

function cleanPimpBunnyMediaUrl(raw, baseUrl) {
  let value = String(raw || '')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/g, '&')
    .replace(/\\+/g, '')
    .trim();

  value = value.replace(/^['"]+|['"]+$/g, '');
  if (!value) return null;
  const innerHttps = value.indexOf('https://');
  const innerHttp = value.indexOf('http://');
  const innerAt = innerHttps > 0 ? innerHttps : (innerHttp > 0 ? innerHttp : -1);
  if (innerAt > 0) value = value.slice(innerAt);
  if (value.startsWith('//')) value = 'https:' + value;

  try {
    const url = new URL(value, baseUrl).href;
    if (!/^https?:\/\//i.test(url)) return null;
    if (/vidthumb|preview|small\.mp4|get_preview|trailer|sample|intro/i.test(url)) return null;
    if (/\/manifest\.json(?:[?#]|$)/i.test(url)) return null;
    if (/\/(?:static|assets?)\//i.test(url) && !/\.(?:mp4|m3u8|mpd|webm|mov)(?:[/?#]|$)/i.test(url)) return null;
    if (
      !/(?:pimpbunny|fnxtube)\.com\/remote_control\.php/i.test(url) &&
      !/\.(?:mp4|m3u8|mpd|webm|mov)(?:[/?#]|$)/i.test(url)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function pimpBunnyHeightFromUrl(url) {
  const match = String(url || '').match(/[\/_-](2160|1440|1080|720|480|360|240)p?(?:[\/_.?#]|$)/i);
  return match ? Number.parseInt(match[1], 10) : 0;
}

// ── KVS (Kernel Video Sharing) token de-obfuscation ─────────────────────────
// Pimpbunny runs a KVS player. Its flashvars expose rendition URLs prefixed with
// "function/0/…get_file/<seg>/<HASH>/…" where the first 32 hex chars of <HASH>
// are scrambled. The player unscrambles them client-side using `license_code`
// before requesting the file. The raw (scrambled) HASH from the HTML 404s — only
// the unscrambled one resolves. Ported verbatim from yt-dlp's KVS extractor
// (_kvs_get_real_url / _kvs_get_license_token); verified byte-exact against a
// live player URL. This is what unlocks 1080p/1440p/original for logged-in users
// instead of us silently capping at the one guest-reachable 720p rendition.

function kvsGetLicenseToken(licenseCode) {
  licenseCode = String(licenseCode || '').replace(/\$/g, '');
  const licenseValues = licenseCode.split('').map(Number);
  let modlicense = licenseCode.replace(/0/g, '1');
  const center = Math.floor(modlicense.length / 2);
  const fronthalf = parseInt(modlicense.slice(0, center + 1), 10);
  const backhalf = parseInt(modlicense.slice(center), 10);
  modlicense = String(4 * Math.abs(fronthalf - backhalf)).slice(0, center + 1);

  const out = [];
  const mod = modlicense.split('').map(Number);
  for (let index = 0; index < mod.length; index++) {
    const current = mod[index];
    for (let offset = 0; offset < 4; offset++) {
      out.push((licenseValues[index + offset] + current) % 10);
    }
  }
  return out;
}

function kvsGetRealUrl(videoUrl, licenseCode) {
  const PREFIX = 'function/0/';
  const raw = String(videoUrl || '');
  if (!raw.startsWith(PREFIX)) return raw; // not obfuscated
  if (!licenseCode) return raw.slice(PREFIX.length);

  let u;
  try { u = new URL(raw.slice(PREFIX.length)); } catch { return raw.slice(PREFIX.length); }

  const licenseToken = kvsGetLicenseToken(licenseCode);
  const urlparts = u.pathname.split('/'); // ['', 'get_file', '<seg>', '<HASH>', ...]
  const HASH_LENGTH = 32;
  const fullSeg = urlparts[3] || '';
  if (fullSeg.length < HASH_LENGTH) return u.href;

  const hash_ = fullSeg.slice(0, HASH_LENGTH);
  const indices = Array.from({ length: HASH_LENGTH }, (_, i) => i);
  let accum = 0;
  for (let src = HASH_LENGTH - 1; src >= 0; src--) {
    accum += licenseToken[src] || 0;
    const dest = (src + accum) % HASH_LENGTH;
    const t = indices[src]; indices[src] = indices[dest]; indices[dest] = t;
  }
  urlparts[3] = indices.map(i => hash_[i]).join('') + fullSeg.slice(HASH_LENGTH);
  u.pathname = urlparts.join('/');
  return u.href;
}

// Parse the KVS flashvars block: license_code + video_url / video_alt_url{,2,3,…}.
// Returns de-obfuscated, ready-to-HEAD rendition URLs with their heights.
function extractPimpBunnyFlashvars(html, pageUrl) {
  const source = String(html || '');
  const licenseCode = (source.match(/license_code\s*:\s*['"]([^'"]+)['"]/) || [])[1] || '';
  const out = [];
  const seen = new Set();

  // video_url, video_alt_url, video_alt_url2 … up to a sane bound.
  const keyRe = /\b(video_(?:alt_)?url\d*)\s*:\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = keyRe.exec(source)) !== null) {
    const raw = m[2];
    let real = kvsGetRealUrl(raw, licenseCode);
    try { real = new URL(real, pageUrl).href; } catch { continue; }
    if (!/\/get_file\//i.test(real) && !/\.(?:mp4|m3u8|mpd|webm|mov)(?:[/?#]|$)/i.test(real)) continue;
    if (/preview|trailer|sample/i.test(real)) continue;
    if (seen.has(real)) continue;
    seen.add(real);

    // Height from the rendition suffix. Keep the unsuffixed original at height 0:
    // Fusion Hub probes the highest labelled rendition first because the original
    // master can be rate-limited or smaller than the named quality variants.
    const suffixHeight = pimpBunnyHeightFromUrl(real);
    const isOriginal = /\/\d+\.mp4(?:[/?#]|$)/i.test(real) && !suffixHeight;
    const label = source.match(new RegExp('\\b' + m[1] + '_text\\s*:\\s*[\'"]([^\'"]+)[\'"]'))?.[1] || '';
    const height = suffixHeight || mediaHeightFromText(label);
    out.push({
      url: real,
      height,
      quality: isOriginal ? 'ORIGINAL' : (height ? normalizeQualityLabel(`${height}P`) : null),
      type: /\.m3u8(?:[?#]|$)/i.test(real) ? 'hls' : 'file',
      score: 20000 + height, // rank above regex-scraped candidates
      isOriginal,
    });
  }
  return out;
}

function extractPimpBunnySources(html, pageUrl) {
  const source = String(html || '').replace(/\\\//g, '/').replace(/\\u0026/gi, '&');
  const candidates = new Map();

  const add = (rawUrl, context = '') => {
    const url = cleanPimpBunnyMediaUrl(rawUrl, pageUrl);
    if (!url) return;

    if (/(?:pimpbunny|fnxtube)\.com\/remote_control\.php/i.test(url)) {
      let paramName = '';
      try {
        const u = new URL(url);
        for (const name of ['res', 'q', 'quality', 'resolution']) {
          if (u.searchParams.has(name)) {
            paramName = name;
            break;
          }
        }
      } catch { }
      if (!paramName) paramName = 'res';
      if (paramName) {
        const qualities = ['4k', '2k', '1080p', '720p', '480p', '360p'];
        for (const q of qualities) {
          try {
            const alt = new URL(url);
            alt.searchParams.set(paramName, q);
            const height = q === '4k' ? 2160 : q === '2k' ? 1440 : parseInt(q) || 0;
            const score = 10000 + height;
            const altUrl = alt.href;
            if (!candidates.has(altUrl)) {
              candidates.set(altUrl, {
                url: altUrl,
                height,
                quality: q === '4k' ? '4K' : q === '2k' ? '2K' : normalizeQualityLabel(`${height}P`),
                type: 'file',
                score,
              });
            }
          } catch { }
        }
        return;
      }
    }

    const height = mediaHeightFromText(`${context} ${url}`) || pimpBunnyHeightFromUrl(url);
    const type = /\.m3u8(?:[?#]|$)/i.test(url) ? 'hls' : 'file';
    const remote = /(?:pimpbunny|fnxtube)\.com\/remote_control\.php/i.test(url);
    const score = (remote ? 10000 : 0) + height;
    const prev = candidates.get(url);
    if (!prev || score > prev.score) {
      candidates.set(url, {
        url,
        height,
        quality: height ? normalizeQualityLabel(`${height}P`) : null,
        type,
        score,
      });
    }
  };

  const patterns = [
    /(?:https?:)?\/\/[\w.-]*(?:pimpbunny|fnxtube)\.com\/remote_control\.php\?[^"'\\\s<>]+/gi,
    /["']([^"']*\/remote_control\.php\?[^"']+)["']/gi,
    /(?:https?:)?\/\/[^\s"'<>]+?\.(?:mp4|m3u8|mpd|webm|mov)(?:[^\s"'<>]*)?/gi,
    /["']([^"']+\.(?:mp4|m3u8|mpd|webm|mov)(?:[^"']*)?)["']/gi,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const raw = match[1] || match[0];
      add(raw, source.slice(Math.max(0, match.index - 160), match.index + String(raw).length + 160));
    }
  }

  // KVS flashvars renditions (de-obfuscated) — these are the authoritative,
  // actually-fetchable URLs. Add them last with the highest score so they win
  // over the raw scrambled tokens the regex pass above may have picked up.
  for (const fv of extractPimpBunnyFlashvars(html, pageUrl)) {
    const prev = candidates.get(fv.url);
    if (!prev || fv.score > prev.score) candidates.set(fv.url, fv);
  }

  return [...candidates.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.url.localeCompare(b.url);
  });
}

function cleanXGroovyMediaUrl(raw, baseUrl) {
  let value = String(raw || '')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/g, '&')
    .replace(/\\+/g, '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '');
  if (!value) return null;
  const innerHttps = value.indexOf('https://');
  const innerHttp = value.indexOf('http://');
  const innerAt = innerHttps > 0 ? innerHttps : (innerHttp > 0 ? innerHttp : -1);
  if (innerAt > 0) value = value.slice(innerAt);
  if (value.startsWith('//')) value = 'https:' + value;
  try {
    const url = new URL(value, baseUrl).href;
    if (!/^https?:\/\//i.test(url)) return null;
    if (/preview\.xgroovy\.com|preview_|_pr640|thumb|sprite|\.jpg|\.png|\.webp/i.test(url)) return null;
    if (!/\/get_file\//i.test(url) && !/\.(?:mp4|m3u8|mpd|webm|mov)(?:[/?#]|$)/i.test(url)) return null;
    return url;
  } catch {
    return null;
  }
}

function xGroovyHeightFromUrl(url) {
  const match = String(url || '').match(/[\/_-](2160|1440|1080|720|480|360|240)p?(?:[\/_.?#]|$)/i);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function estimateXGroovySizeMb(url, durationSeconds) {
  const duration = Number(durationSeconds || 0);
  if (!duration || duration < 5) return 0;
  const bitrate = Number((String(url || '').match(/[?&]br=(\d{2,6})/i) || [])[1] || 0);
  if (!bitrate) return 0;
  return Math.round((bitrate * 1000 * duration / 8 / 1048576) * 10) / 10;
}

function extractXGroovySources(html, pageUrl) {
  const source = String(html || '').replace(/\\\//g, '/').replace(/\\u0026/gi, '&');
  const candidates = new Map();
  const add = (rawUrl, context = '') => {
    const url = cleanXGroovyMediaUrl(rawUrl, pageUrl);
    if (!url) return;
    const height = mediaHeightFromText(`${context} ${url}`) || xGroovyHeightFromUrl(url);
    const type = /\.m3u8(?:[?#]|$)|\.mpd(?:[?#]|$)/i.test(url) ? 'hls' : 'file';
    const score = (height || 0) + (/\/get_file\//i.test(url) ? 10000 : 0);
    const prev = candidates.get(url);
    if (!prev || score > prev.score) {
      candidates.set(url, {
        url,
        height,
        quality: height ? normalizeQualityLabel(`${height}P`) : null,
        type,
        score,
      });
    }
  };

  for (const match of source.matchAll(/<source[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
    add(match[1], match[0]);
  }
  for (const match of source.matchAll(/<video[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
    add(match[1], match[0]);
  }
  for (const match of source.matchAll(/(?:https?:)?\/\/[^\s"'<>]+?(?:\/get_file\/[^\s"'<>]+|\.(?:mp4|m3u8|mpd|webm|mov)(?:[^\s"'<>]*)?)/gi)) {
    add(match[0], source.slice(Math.max(0, match.index - 120), match.index + match[0].length + 120));
  }

  return [...candidates.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.url.localeCompare(b.url);
  });
}

async function extractXGroovyMeta(html, pageUrl, tabId) {
  const date = extractDate(html);
  const duration = extractDuration(html);
  const sources = extractXGroovySources(html, pageUrl);
  const visibleQuality = normalizeQualityLabel((html.match(/\b(4K|UHD|FHD|HD|2160p?|1440p?|1080p?|720p?|480p?|360p?)\b/i) || [])[1]);

  let best = null;
  let fallback = null;
  for (const source of sources) {
    if (source.type === 'hls') {
      const hlsData = await fetchHlsQualityAndSize(source.url, duration, tabId);
      if (hlsData?.mb && isReasonableSizeEstimate(hlsData.mb, duration)) {
        const candidate = {
          quality: normalizeQualityLabel(hlsData.quality) || source.quality || visibleQuality,
          sizeMb: hlsData.mb,
          sizeText: formatSizeMb(hlsData.mb),
          streamUrl: source.url,
        };
        if (!best || candidate.sizeMb > best.sizeMb) best = candidate;
      }
      if (!fallback && (source.quality || visibleQuality)) {
        fallback = { quality: source.quality || visibleQuality, sizeMb: null, sizeText: null, streamUrl: source.url };
      }
      continue;
    }

    let sizeMb = await fetchHeadSize(source.url, pageUrl);
    if (!sizeMb) sizeMb = estimateXGroovySizeMb(source.url, duration);
    if (sizeMb && isReasonableSizeEstimate(sizeMb, duration)) {
      const candidate = {
        quality: source.quality || visibleQuality || calculateQualityFromBitrate(sizeMb, duration),
        sizeMb,
        sizeText: formatSizeMb(sizeMb),
        streamUrl: source.url,
      };
      if (!best || candidate.sizeMb > best.sizeMb) best = candidate;
    }

    if (!fallback && (source.quality || visibleQuality)) {
      fallback = { quality: source.quality || visibleQuality, sizeMb: null, sizeText: null, streamUrl: source.url };
    }
  }

  best = best || fallback;

  if (!best) {
    const generic = await extractQualityAndSizeAsync(html, duration, tabId);
    best = {
      quality: generic.quality || visibleQuality,
      sizeMb: generic.sizeMb || null,
      sizeText: generic.sizeText || null,
      streamUrl: null,
    };
  }

  return {
    date,
    quality: best?.quality || visibleQuality || null,
    sizeText: best?.sizeText || null,
    sizeMb: best?.sizeMb || null,
    duration,
    streamUrl: best?.streamUrl || null,
  };
}

async function extractPimpBunnyMeta(html, pageUrl, tabId) {
  const date = extractDate(html);
  const duration = extractDuration(html);
  // Page-wide "4K"/"HD" text is unreliable on pimpbunny — the markup is full of
  // promo/other-card quality badges. Use it only as a last-resort fallback,
  // never to *upgrade* a rendition label.
  const visibleQuality = normalizeQualityLabel((html.match(/\b(4K|UHD|FHD|HD|2K|2160p?|1440p?|1080p?|720p?|480p?|360p?)\b/i) || [])[1]);
  const sources = extractPimpBunnySources(html, pageUrl);

  // ── Best QUALITY is derived purely from the rendition URLs of THIS video ──
  // Each rendition is exposed either as /get_file/…/<id>_1440p.mp4 or as a
  // remote_control.php URL with a quality query. Both are real probe targets;
  // Fusion Hub measures the latter directly after generating its quality URLs.
  const fileSources = sources.filter(s => s.type !== 'hls');
  const rankedByHeight = [...fileSources].filter(s => s.height > 0).sort((a, b) => b.height - a.height);
  // Quality LABEL comes from the highest rendition with a *known* pixel height
  // (the unsuffixed original uses a 4320 sentinel for ranking only — we can't
  // prove its real height, so it never dictates the badge text).
  const labelSource = rankedByHeight.find(s => !s.isOriginal && s.height > 0 && s.height <= 2160);
  const topHeight = labelSource ? labelSource.height : 0;
  const urlQuality = topHeight ? normalizeQualityLabel(`${topHeight}P`) : null;
  const normQuality = (q) => (q && q !== 'ORIGINAL') ? q : (urlQuality || null);

  let best = null;

  // Najprv skúsime embedded remote_control.php iframe-y (parsujeme ich obsah pre direct .mp4/HLS)
  const remoteSources = sources.filter(s => /(?:pimpbunny|fnxtube)\.com\/remote_control\.php/i.test(s.url)).sort((a, b) => b.score - a.score);
  // Direct rendition URLs contain the actual quality variants. Do not let a
  // remote player response win before those URLs have been measured.
  if (!fileSources.length) {
    for (const source of remoteSources.slice(0, 4)) {
      const remoteHtml = await new Promise(resolve => {
        chrome.tabs.sendMessage(tabId, { action: 'nvsFetchText', url: source.url }, res => resolve(res || ''));
      });
      if (!remoteHtml) continue;

      const generic = await extractQualityAndSizeAsync(remoteHtml, duration, tabId);
      if (generic && generic.sizeMb && isReasonableSizeEstimate(generic.sizeMb, duration)) {
        best = {
          quality: source.quality || generic.quality || urlQuality || visibleQuality,
          sizeMb: generic.sizeMb,
          sizeText: generic.sizeText,
          streamUrl: generic.streamUrl || source.url,
        };
        break;
      }
    }
  }

  // ── SIZE probe — try to attach a real byte size, highest rendition first ──
  // We keep the best rendition's stream URL regardless of size success, so the
  // badge/quality never regresses to a lower rendition just because the higher
  // one's get_file token 404'd. Size is best-effort only.
  if (!best) {
    let sizeMb = null;
    // Quality shown = the rendition we actually managed to size. Start from the
    // highest available rendition's label so that even if NO size probe lands we
    // still advertise the top quality; overwrite it once a probe succeeds so the
    // "2K • 640 MB" pair always describes the SAME file.
    let sizedQuality = urlQuality;
    let sizeStreamUrl = rankedByHeight.length ? rankedByHeight[0].url : (fileSources[0]?.url || null);

    // Match Fusion Hub: probe variants concurrently per quality, highest first.
    // Stop at the first quality with a real size so a slow/unreachable 4K
    // rendition cannot delay every card while a valid 1440p/1080p is available.
    const probeList = [...fileSources]
      .sort((a, b) => (b.height - a.height) || (b.score - a.score))
      .filter((source, index, all) => all.findIndex(item => item.url === source.url) === index);
    const heights = [...new Set(probeList.map(source => source.height || 0))].sort((a, b) => b - a);
    for (const height of heights) {
      const group = probeList.filter(source => (source.height || 0) === height);
      const measured = await Promise.all(group.map(async (source) => {
        try {
          if (source.type === 'hls') {
            const hlsData = await fetchHlsQualityAndSize(source.url, duration, tabId);
            return hlsData?.mb && isReasonableSizeEstimate(hlsData.mb, duration)
              ? { source, size: hlsData.mb } : null;
          }
          // PimpBunny binds signed get_file URLs to the originating tab.
          const size = await fetchPimpBunnySizeViaTab(source.url, tabId)
            || await fetchHeadSize(source.url, pageUrl);
          return size && isReasonableSizeEstimate(size, duration)
            ? { source, size } : null;
        } catch {
          return null;
        }
      }));
      const valid = measured.filter(Boolean).sort((a, b) => b.size - a.size);
      if (valid.length) {
        const picked = valid[0];
        sizeMb = picked.size;
        sizeStreamUrl = picked.source.url;
        sizedQuality = normQuality(picked.source.quality) || urlQuality;
        break;
      }
    }

    // Some PimpBunny deployments return a player HTML page from
    // remote_control.php instead of redirecting to media. Parse that response
    // as Fusion Hub does when HEAD cannot produce a real video size.
    if (sizeMb == null && remoteSources.length) {
      const remoteResults = await Promise.all(remoteSources.slice(0, 6).map(async (source) => {
        try {
          const remoteHtml = await fetchTextViaTabOrDirect(source.url, tabId);
          const generic = await extractQualityAndSizeAsync(remoteHtml, duration, tabId);
          return generic?.sizeMb && isReasonableSizeEstimate(generic.sizeMb, duration)
            ? { source, meta: generic } : null;
        } catch {
          return null;
        }
      }));
      const remoteBest = remoteResults.filter(Boolean).sort((a, b) => b.meta.sizeMb - a.meta.sizeMb)[0];
      if (remoteBest) {
        sizeMb = remoteBest.meta.sizeMb;
        sizeStreamUrl = remoteBest.meta.streamUrl || remoteBest.source.url;
        sizedQuality = normQuality(remoteBest.source.quality) || remoteBest.meta.quality || urlQuality;
      }
    }

    if (urlQuality || sizeMb || fileSources.length) {
      best = {
        quality: sizedQuality || visibleQuality || (sizeMb ? calculateQualityFromBitrate(sizeMb, duration) : null),
        sizeMb: sizeMb || null,
        sizeText: sizeMb ? formatSizeMb(sizeMb) : null,
        streamUrl: sizeStreamUrl,
      };
    }
  }

  if (!best) {
    const generic = await extractQualityAndSizeAsync(html, duration, tabId);
    best = {
      quality: urlQuality || generic.quality || visibleQuality,
      sizeMb: generic.sizeMb || null,
      sizeText: generic.sizeText || null,
      streamUrl: null,
    };
  }

  return {
    date,
    quality: best?.quality || urlQuality || visibleQuality || null,
    sizeText: best?.sizeText || null,
    sizeMb: best?.sizeMb || null,
    duration,
    streamUrl: best?.streamUrl || null,
  };
}

function mediaHeightFromText(value) {
  const text = String(value || '').toUpperCase();
  if (/\b(?:4K|UHD|2160P?)\b/.test(text)) return 2160;
  if (/\b(?:FHD|1080P?)\b/.test(text)) return 1080;
  if (/\b(?:HD|720P?)\b/.test(text)) return 720;
  const m = text.match(/\b(1440|1080|720|480|360|240)P?\b/);
  return m ? Number.parseInt(m[1], 10) : 0;
}

function extractNoodleDuration(html) {
  const source = decodeHtmlText(html || '');
  const matches = [...source.matchAll(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g)]
    .map((m) => m[1])
    .filter((value) => {
      const seconds = parseDurationToSeconds(value);
      return seconds >= 30 && seconds < 86400;
    });
  if (!matches.length) return null;
  matches.sort((a, b) => parseDurationToSeconds(b) - parseDurationToSeconds(a));
  return matches[0];
}

function extractNoodleSources(html, pageUrl) {
  const source = String(html || '').replace(/\\\//g, '/').replace(/\\u0026/gi, '&');
  const candidates = new Map();

  const add = (rawUrl, context = '') => {
    const url = cleanMediaUrl(rawUrl, pageUrl);
    if (!url) return;
    const height = mediaHeightFromText(`${context} ${url}`);
    const prev = candidates.get(url);
    if (!prev || height > prev.height) {
      candidates.set(url, {
        url,
        height,
        quality: height ? normalizeQualityLabel(`${height}P`) : null,
        type: /\.m3u8(?:[?#]|$)/i.test(url) ? 'hls' : 'mp4',
      });
    }
  };

  for (const match of source.matchAll(/(?:https?:)?\/\/[^\s"'<>]+?\.(?:m3u8|mp4)(?:[^\s"'<>]*)?/gi)) {
    add(match[0], source.slice(Math.max(0, match.index - 120), match.index + match[0].length + 120));
  }

  for (const match of source.matchAll(/["']([^"']+\.(?:m3u8|mp4)(?:[^"']*)?)["']/gi)) {
    add(match[1], source.slice(Math.max(0, match.index - 120), match.index + match[0].length + 120));
  }

  return [...candidates.values()].sort((a, b) => {
    if (b.height !== a.height) return b.height - a.height;
    if (a.type !== b.type) return a.type === 'hls' ? -1 : 1;
    return a.url.localeCompare(b.url);
  });
}

async function extractNoodleMagazineMeta(html, pageUrl, tabId) {
  const date = extractDate(html);
  const duration = extractDuration(html) || extractNoodleDuration(html);
  const sources = extractNoodleSources(html, pageUrl);
  const visibleQuality = normalizeQualityLabel((html.match(/\b(4K|UHD|FHD|HD|2160p?|1440p?|1080p?|720p?|480p?|360p?)\b/i) || [])[1]);

  let best = null;
  for (const source of sources.slice(0, 8)) {
    if (source.type === 'hls') {
      const hlsData = await fetchHlsQualityAndSize(source.url, duration, tabId);
      if (hlsData?.mb && isReasonableSizeEstimate(hlsData.mb, duration)) {
        const quality = normalizeQualityLabel(hlsData.quality) || source.quality || visibleQuality;
        best = {
          quality,
          sizeMb: hlsData.mb,
          sizeText: formatSizeMb(hlsData.mb),
          streamUrl: source.url,
          height: mediaHeightFromText(quality) || source.height,
        };
        break;
      }
      if (!best && (source.quality || visibleQuality)) {
        best = {
          quality: source.quality || visibleQuality,
          sizeMb: null,
          sizeText: null,
          streamUrl: source.url,
          height: source.height,
        };
      }
      continue;
    }

    const sizeMb = await fetchHeadSize(source.url);
    if (sizeMb && isReasonableSizeEstimate(sizeMb, duration)) {
      best = {
        quality: source.quality || visibleQuality || calculateQualityFromBitrate(sizeMb, duration),
        sizeMb,
        sizeText: formatSizeMb(sizeMb),
        streamUrl: source.url,
        height: source.height,
      };
      break;
    }

    if (!best && (source.quality || visibleQuality)) {
      best = {
        quality: source.quality || visibleQuality,
        sizeMb: null,
        sizeText: null,
        streamUrl: source.url,
        height: source.height,
      };
    }
  }

  if (!best) {
    const generic = await extractQualityAndSizeAsync(html, duration, tabId);
    best = {
      quality: generic.quality || visibleQuality,
      sizeMb: generic.sizeMb || null,
      sizeText: generic.sizeText || null,
      streamUrl: null,
      height: mediaHeightFromText(generic.quality || visibleQuality),
    };
  }

  return {
    date,
    quality: best?.quality || visibleQuality || null,
    sizeText: best?.sizeText || null,
    sizeMb: best?.sizeMb || null,
    duration,
    streamUrl: best?.streamUrl || null,
  };
}

function findDeep(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = findDeep(item, keys);
      if (r) return r;
    }
    return null;
  }
  for (const k of keys) {
    if (obj[k]) return obj[k];
  }
  for (const val of Object.values(obj)) {
    const r = findDeep(val, keys);
    if (r) return r;
  }
  return null;
}

// ── Extract Metadata ──────────────────────────────────────────

async function fetchPimpBunnyHubMeta(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    for (const port of ['8000', '8001', '8002']) {
      try {
        const response = await fetch(`http://localhost:${port}/api/v1/hub/pimpbunny/enrich`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: [url], fill_size: true }),
          signal: controller.signal,
        });
        if (!response.ok) continue;
        const payload = await response.json();
        const result = payload?.results?.[url] || Object.values(payload?.results || {})[0];
        if (!result || typeof result !== 'object') continue;

        let sizeMb = Number(result.size_mb || 0) || null;
        let sizeEstimated = false;
        if (!sizeMb && Number(result.duration_sec || 0) > 0 && Number(result.height || 0) > 0) {
          const height = Number(result.height);
          const bitrateMbps = height >= 2160 ? 16 : height >= 1440 ? 8 : height >= 1080 ? 5 : height >= 720 ? 2.8 : height >= 480 ? 1.5 : 0.8;
          sizeMb = Math.max(1, Math.round((bitrateMbps * Number(result.duration_sec)) / 8));
          sizeEstimated = true;
        }
        return {
          date: result.upload_date || result.added || null,
          quality: result.quality ? normalizeQualityLabel(result.quality) || result.quality : null,
          sizeMb,
          sizeText: sizeMb ? `${sizeEstimated ? '~' : ''}${formatSizeMb(sizeMb)}` : null,
          duration: result.duration || null,
          title: result.title || null,
          thumbnail: result.thumbnail || null,
        };
      } catch {
        // Try the next configured Nexus port, then use the local scraper.
      }
    }
  } finally {
    clearTimeout(timeoutId);
  }
  return null;
}

function acceptPornFansCache(cached) {
  if (!cached || cached.adapter !== 'pornfans-multisource-v2' || !cached.ts) return null;
  const age = Date.now() - Number(cached.ts);
  if (cached.failureReason === 'exclusive_locked') {
    return age < 6 * 60 * 60 * 1000 ? cached : null;
  }
  if (!(Number(cached.sizeMb) > 0) && !cached.failureReason) return null;
  // Direct Dood links expire quickly. Keep the measured size and drop the
  // stale stream so a later import uses the stable PornFans page.
  if (cached.sourceType === 'dood-download' && age >= 5 * 60 * 1000) {
    return { ...cached, streamUrl: null };
  }
  return cached;
}

function isXHamsterUrl(url) {
  try { return /(^|\.)xhamster(?:-fr)?\.com$|(^|\.)xhamster\.desi$/i.test(new URL(url).hostname); } catch { return false; }
}

function isDrTuberUrl(url) {
  try { return /(^|\.)drtuber\.com$/i.test(new URL(url).hostname); } catch { return false; }
}

function drTuberDuration(seconds) {
  const total = Math.round(Number(seconds) || 0);
  if (total <= 0) return null;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}

async function extractDrTuberMeta(html, pageUrl) {
  const id = String(pageUrl || '').match(/\/video\/(\d+)/i)?.[1];
  const fallback = {
    date: extractDate(html), duration: extractDuration(html),
    quality: normalizeQualityLabel((String(html || '').match(/\b(4K|UHD|FHD|HD|2160p?|1440p?|1080p?|720p?|480p?|360p?)\b/i) || [])[1]),
    sizeMb: null, sizeText: null, streamUrl: null, adapter: 'drtuber-player-config-v1',
  };
  if (!id) return fallback;
  try {
    // The detail-page request initializes the same session as the site player;
    // its config endpoint then returns the short-lived HQ/LQ MP4 URLs.
    const endpoint = new URL('/player_config_json/', pageUrl);
    endpoint.search = new URLSearchParams({ vid: id, aid: '0', domain_id: '0', embed: '0', ref: 'null', check_speed: '0' });
    const response = await fetch(endpoint.href, {
      credentials: 'include', referrer: pageUrl,
      headers: { Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return fallback;
    const data = await response.json();
    const files = data && typeof data === 'object' ? data.files || {} : {};
    const streamUrls = [...new Set([files.hq, files.lq].map(rawUrl => {
      try {
        const streamUrl = new URL(String(rawUrl || '').trim(), pageUrl);
        return /^https?:$/.test(streamUrl.protocol) ? streamUrl.href : '';
      } catch {
        return '';
      }
    }).filter(Boolean))];
    if (!streamUrls.length) return fallback;
    let streamUrl = streamUrls[0];
    let sizeMb = null;
    for (const candidateUrl of streamUrls) {
      const candidateSizeMb = await fetchHeadSize(candidateUrl, pageUrl);
      if (Number(candidateSizeMb) > 0) {
        streamUrl = candidateUrl;
        sizeMb = candidateSizeMb;
        break;
      }
    }
    const streamQuality = normalizeQualityLabel(data.quality || data.resolution || (streamUrl.match(/\b(2160|1440|1080|720|480|360)p?\b/i) || [])[1]);
    return {
      ...fallback,
      title: String(data.title || '').trim() || null,
      thumbnail: String(data.poster || '').trim() || null,
      duration: drTuberDuration(data.duration) || fallback.duration,
      quality: streamQuality || fallback.quality,
      sizeMb,
      sizeText: sizeMb ? formatSizeMb(sizeMb) : null,
      streamUrl,
    };
  } catch (error) {
    console.warn('[NVS DrTuber] Player config unavailable:', error?.message || error);
    return fallback;
  }
}

async function extractXHamsterMeta(html, pageUrl) {
  const api = globalThis.NVSXhamsterMeta;
  const seconds = api?.durationSeconds(html) || 0;
  const duration = seconds ? api.formatDuration(seconds) : extractDuration(html);
  const master = api?.masterPlaylistUrl(html) || '';
  let quality = null;
  let sizeMb = null;
  if (master && seconds) {
    let playlist = '';
    try { playlist = await fetchTextViaTabOrDirect(master, null, pageUrl) || ''; } catch { playlist = ''; }
    const sized = api.sizeFromMasterPlaylist(playlist, seconds);
    if (sized?.sizeMb > 0) {
      quality = sized.quality;
      sizeMb = sized.sizeMb;
    }
  }
  const uploaded = api?.uploadInfo?.(html) || {};
  return {
    date: uploaded.date || extractDate(html),
    relDate: uploaded.relDate || null,
    duration,
    quality,
    sizeMb,
    sizeText: sizeMb ? formatSizeMb(sizeMb) : null,
    adapter: 'xhamster-hls-v1',
  };
}

function isTubed69Url(url) {
  try { return /(^|\.)69tubed\.(com|live)$/i.test(new URL(url).hostname); } catch { return false; }
}

async function extractTubed69Meta(html, pageUrl) {
  const meta = { date: extractDate(html), duration: null, quality: null, sizeMb: null,
    sizeText: null, adapter: '69tubed-byse-v1' };
  const embed = String(html || '').match(/https?:\/\/([^/"'\s<>]+)\/e\/([a-z0-9]+)(?:\/|["'])/i);
  if (!embed) return meta;
  try {
    const response = await fetch(`https://${embed[1]}/api/videos/${embed[2]}/`, {
      credentials: 'include', signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) return meta;
    const data = await response.json();
    const p = data.playback || {};
    const decode = value => Uint8Array.from(atob(String(value).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const version = Number(p.version);
    if (!Number.isInteger(version) || version < 1 || version > 30) return meta;
    const keyBytes = new Uint8Array([...decode(p.key_parts[version - 1]), ...decode(p.key_parts[30 - version])]);
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(p.iv) }, key, decode(p.payload));
    const sources = JSON.parse(new TextDecoder().decode(plaintext)).sources || [];
    const best = sources.filter(s => s.url).sort((a, b) => Number(b.height || 0) - Number(a.height || 0)
      || Number(b.bitrate_kbps || 0) - Number(a.bitrate_kbps || 0))[0];
    const seconds = Number(data.duration_seconds || 0);
    meta.duration = seconds > 0 ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : null;
    if (!best) return meta;
    meta.quality = normalizeQualityLabel(best.height ? `${best.height}P` : best.label);
    const bytes = Number(best.size_bytes || 0);
    meta.sizeExact = bytes > 0;
    meta.sizeMb = bytes > 0 ? bytes / (1024 * 1024) : null;
    if (!meta.sizeMb && Number(best.bitrate_kbps) > 0 && seconds > 0) {
      meta.sizeMb = Number(best.bitrate_kbps) * 1000 * seconds / (8 * 1024 * 1024);
      meta.sizeEstimated = true;
    }
    meta.sizeText = meta.sizeMb ? `${meta.sizeEstimated ? '~' : ''}${formatSizeMb(meta.sizeMb)}` : null;
    // Signed stream URLs expire; cache only durable card metadata.
  } catch (error) { console.warn('[NVS 69Tubed] Metadata unavailable:', error.message); }
  return meta;
}

function isCumStUrl(url) {
  try { return /(^|\.)cum\.st$/i.test(new URL(url).hostname); } catch { return false; }
}

async function extractCumStMeta(html, pageUrl) {
  const source = String(html || '');
  const videoObjects = [];
  const collectVideoObjects = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) collectVideoObjects(item);
      return;
    }
    const type = node['@type'];
    const isVideoObj = type === 'VideoObject' || (Array.isArray(type) && type.includes('VideoObject'));
    if (isVideoObj) videoObjects.push(node);
    for (const val of Object.values(node)) {
      if (val && typeof val === 'object') collectVideoObjects(val);
    }
  };

  for (const m of source.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1].trim());
      collectVideoObjects(parsed);
    } catch { }
  }

  let streamUrl = '';
  let date = null;
  let duration = null;
  let pixelHeight = 0;

  for (const vo of videoObjects) {
    if (!streamUrl && vo.contentUrl) {
      try {
        const abs = new URL(String(vo.contentUrl).replace(/\\u002F/gi, '/').replace(/\\\//g, '/').trim(), pageUrl);
        if (/^https?:$/i.test(abs.protocol)) streamUrl = abs.href;
      } catch { }
    }
    if (!date && vo.uploadDate) {
      date = normalizeDate(vo.uploadDate);
    }
    if (!duration && vo.duration) {
      duration = isoToHuman(String(vo.duration)) || extractDuration(String(vo.duration));
    }
    const w = Number(vo.width) || 0;
    const h = Number(vo.height) || 0;
    const dim = (w > 0 && h > 0) ? Math.min(w, h) : (h || w);
    if (dim > pixelHeight) pixelHeight = dim;
  }

  if (!streamUrl) {
    const cdnMatch = source.match(/https?:\/\/cdn\.cum\.st\/media\/[a-f0-9]+\/[^"'\s<>\\]+\.(?:mp4|webm|m3u8)(?:\?[^"'\s<>\\]*)?/i);
    if (cdnMatch) {
      try {
        const abs = new URL(cdnMatch[0], pageUrl);
        if (/^https?:$/i.test(abs.protocol)) streamUrl = abs.href;
      } catch { }
    }
  }

  if (!date) date = extractDate(source);
  if (!duration) duration = extractDuration(source);

  let sizeMb = null;
  if (streamUrl) {
    sizeMb = await fetchHeadSize(streamUrl, pageUrl);
  }

  let quality = pixelHeight ? normalizeQualityLabel(`${pixelHeight}P`) : null;
  if (streamUrl && sizeMb > 0 && (!duration || !quality) && !/\.m3u8(?:[?#]|$)/i.test(streamUrl)) {
    const mp4Meta = await probeMp4HeaderMeta(streamUrl, pageUrl);
    if (mp4Meta) {
      if (!duration && mp4Meta.duration) duration = mp4Meta.duration;
      if (!quality && mp4Meta.quality) quality = mp4Meta.quality;
    }
  }
  if (!quality && sizeMb && duration) {
    const calcQ = calculateQualityFromBitrate(sizeMb, duration);
    if (calcQ) quality = calcQ;
  }

  return {
    date: date || null,
    duration: duration || null,
    quality: quality || null,
    sizeMb: sizeMb || null,
    sizeText: sizeMb ? formatSizeMb(sizeMb) : null,
    sizeExact: Boolean(sizeMb),
    streamUrl: streamUrl || null,
    adapter: 'cumst-source-v1',
  };
}

function isPornoneUrl(url) {
  try { return /(^|\.)pornone\.com$/i.test(new URL(url).hostname); } catch { return false; }
}

async function extractPornoneMeta(html, pageUrl) {
  const date = extractDate(html);
  let duration = extractDuration(html);
  if (!duration) {
    const secs = parseInt((String(html || '').match(/\bvar\s+videoLength\s*=\s*(\d{1,6})\s*;/i) || [])[1], 10);
    if (Number.isInteger(secs) && secs > 0 && secs < 86400) {
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      duration = h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`;
    }
  }

  const seenUrls = new Set();
  const sources = [];
  const sourceMatches = String(html || '').matchAll(/<source\b[^>]*>/gi);
  for (const match of sourceMatches) {
    const tag = match[0];
    const rawSrc = (tag.match(/\bsrc=["']([^"']+)["']/i) || [])[1];
    if (!rawSrc) continue;
    const decodedSrc = rawSrc.replace(/&amp;/g, '&').trim();
    let absUrl = '';
    try {
      const parsed = new URL(decodedSrc, pageUrl);
      if (!/^https?:$/i.test(parsed.protocol)) continue;
      absUrl = parsed.href;
    } catch { continue; }
    if (!/\.mp4(?:[?#]|$)/i.test(absUrl) || seenUrls.has(absUrl)) continue;
    seenUrls.add(absUrl);

    const urlHeight = parseInt((absUrl.match(/_(\d{3,4})x(\d{3,4})(?:_|\.)/i) || [])[2] || '0', 10) || 0;
    const bitrate = parseInt((absUrl.match(/_(\d+)k\.mp4/i) || [])[1] || '0', 10) || 0;
    const resAttr = parseInt(
      (tag.match(/\bres=["'](\d+)["']/i) || tag.match(/\blabel=["'](\d+)p?["']/i) || [])[1] || '0',
      10
    ) || 0;
    // PornOne labels 720x406 as 480p and occasionally labels 1920x1080 as 720p;
    // trust true HD+ pixel height while keeping standard 480p label for 406p 16:9 encodes.
    const effectiveHeight = urlHeight >= 720 ? urlHeight : (resAttr || urlHeight);
    sources.push({ url: absUrl, effectiveHeight, bitrate, resAttr });
  }

  if (!sources.length) {
    const ldUrl = (String(html || '').match(/"contentUrl"\s*:\s*"([^"]+\.mp4[^"]*)"/i) || [])[1];
    if (ldUrl) {
      try {
        const absUrl = new URL(ldUrl.replace(/\\u002F/gi, '/').replace(/\\\//g, '/'), pageUrl).href;
        const urlHeight = parseInt((absUrl.match(/_(\d{3,4})x(\d{3,4})(?:_|\.)/i) || [])[2] || '0', 10) || 0;
        const bitrate = parseInt((absUrl.match(/_(\d+)k\.mp4/i) || [])[1] || '0', 10) || 0;
        sources.push({ url: absUrl, effectiveHeight: urlHeight, bitrate, resAttr: 0 });
      } catch { }
    }
  }

  sources.sort((a, b) => (b.effectiveHeight - a.effectiveHeight) || (b.bitrate - a.bitrate) || (b.resAttr - a.resAttr));

  let sizeMb = null;
  let measuredSource = null;
  for (const source of sources.slice(0, 4)) {
    const probed = await fetchHeadSize(source.url, pageUrl);
    if (probed && probed > 0) {
      sizeMb = probed;
      measuredSource = source;
      break;
    }
  }

  const hdValue = parseInt((String(html || '').match(/\bvar\s+hdvalue\s*=\s*(\d{3,4})\s*;/i) || [])[1] || '0', 10) || 0;
  const bestHeight = measuredSource?.effectiveHeight || sources[0]?.effectiveHeight || hdValue || 0;
  const quality = normalizeQualityLabel(bestHeight ? `${bestHeight}P` : null);

  return {
    date,
    duration,
    quality,
    sizeMb,
    sizeText: sizeMb ? formatSizeMb(sizeMb) : null,
    sizeExact: Boolean(sizeMb),
    // PornOne CDN tokens expire quickly; keep source_url as canonical import target.
    streamUrl: null,
    adapter: 'pornone-source-v1',
  };
}

function isSpankBangUrl(url) {
  try { return /(^|\.)spankbang\.(?:com|party)$/i.test(new URL(url).hostname); } catch { return false; }
}

async function fetchSpankBangMeta(url, tabId, force) {
  const api = globalThis.NVSSpankBangListing;
  if (!api?.watchUrl(url, url)) return null;
  if (!force) {
    const cached = await readCache(url);
    if (cached?.adapter === 'spankbang-watch-v1' && cached.date && (cached.quality || cached.duration)) return { ...cached, _cacheHit: true };
  }
  let html = '';
  try { html = await fetchTextViaTabOrDirect(url, tabId) || ''; } catch { html = ''; }
  if (!html || api.isChallenge(html)) html = await fetchHtml(url, 12000) || '';
  if (!html || api.isChallenge(html)) return null;
  const parsed = api.watchMeta(html);
  const sizeMb = parsed.streamUrl ? await fetchHeadSize(parsed.streamUrl, url) : null;
  const meta = api.toMeta(parsed, sizeMb);
  if (meta?.date || meta?.quality || meta?.duration || meta?.sizeMb) await writeCache(url, meta);
  return meta;
}

async function fetchVideoMeta(url, tabId, force = false, quick = false, opts = {}) {
  if (isSpankBangUrl(url)) return fetchSpankBangMeta(url, tabId, force);
  if (isFapFolderUrl(url)) {
    // Do not reuse old cached timestamps as video durations, or persist an
    // expiring signed stream URL for 60 days. Resolve it fresh for each scan.
    const html = await fetchHtml(url, 12000);
    if (!html) return null;
    const fapMeta = extractFapFolderMeta(html);
    const streamUrl = fapMeta.streamUrl ? new URL(fapMeta.streamUrl, url).href : '';
    const sizeMb = streamUrl ? await fetchFapFolderStreamSizeMb(streamUrl, url) : null;
    return {
      date: null, quality: null, duration: null,
      sizeMb, sizeText: sizeMb ? (sizeMb < 1 ? `${(sizeMb * 1024).toFixed(1)} KB` : formatSizeMb(sizeMb)) : null,
      sizeExact: Boolean(sizeMb), streamUrl: streamUrl || null,
      title: fapMeta.title || null, adapter: 'fapfolder-player-v2',
      _playerMetadataAttempted: false, _durationLoading: false,
    };
  }
  if (isTubed69Url(url)) {
    if (!force) {
      const cached = await readCache(url);
      if (cached?.adapter === '69tubed-byse-v1' && Number(cached.sizeMb) > 0 && cached.quality) return { ...cached, _cacheHit: true };
    }
    const html = await fetchHtml(url, 12000);
    if (!html) return null;
    const meta = await extractTubed69Meta(html, url);
    if (meta.sizeMb && meta.quality) await writeCache(url, meta);
    return meta;
  }
  if (isXHamsterUrl(url)) {
    if (!force) {
      const cached = await readCache(url);
      // A measured size with an empty date is the old JSON-LD miss. Refetch it.
      if (cached?.adapter === 'xhamster-hls-v1' && Number(cached.sizeMb) > 0 && cached.date) return { ...cached, _cacheHit: true };
    }
    const html = await fetchHtml(url, 12000);
    if (!html) return null;
    const meta = await extractXHamsterMeta(html, url);
    if (Number(meta.sizeMb) > 0) await writeCache(url, meta);
    return meta;
  }
  if (isDrTuberUrl(url)) {
    if (!force) {
      const cached = await readCache(url);
      if (cached?.adapter === 'drtuber-player-config-v1' && cached.streamUrl && Date.now() - cached.ts < 300000) {
        return { ...cached, _cacheHit: true };
      }
    }
    const html = await fetchHtml(url, 12000);
    if (!html) return null;
    const meta = await extractDrTuberMeta(html, url);
    // The stream expires, so only retain it briefly; card metadata remains
    // useful while a user filters or imports the current result page.
    if (meta.duration || meta.quality || meta.sizeMb || meta.streamUrl) await writeCache(url, meta);
    return meta;
  }

  if (globalThis.NVSArchve?.kind(url)) {
    if (!globalThis.__nvsArchveFetcher) globalThis.__nvsArchveFetcher = globalThis.NVSArchve.createFetcher({
      fetchImpl: fetch, readCache, writeCache, formatSizeMb
    });
    try {
      return globalThis.NVSArchve.kind(url) === 'album'
        ? await globalThis.__nvsArchveFetcher.album(url, force)
        : await globalThis.__nvsArchveFetcher.video(url, force);
    } catch { return null; }
  }

  const kvsFlashvars = isKvsFlashvarsUrl(url);
  if (!force) {
    let cached = await readCache(url);
    // Ignore old cached trafficdeposit CDN entries so fresh external mirrors are resolved
    if (cached && isSxyprnUrl(url) && cached.streamUrl && (cached.streamUrl.includes('trafficdeposit.com') || cached.streamUrl.endsWith('.vid'))) {
      cached = null;
    }
    // Quick režim: odznaky sa vykreslia hneď z cache na disku aj keď je staršia
    // než 5 min (stream URL už môže byť expirovaná – deep sken ju obnoví).
    if (quick && cached?.streamUrl && (
      (isSxyprnUrl(url) && cached.adapter === 'sxyprn-source-v1')
      || (isInternetChicksUrl(url) && cached.adapter === 'internetchicks-source-v6')
    )) {
      return { ...cached, _cacheHit: true, _stale: Date.now() - cached.ts >= 300000 };
    }
    if (isPornFansUrl(url)) {
      const fresh = acceptPornFansCache(cached);
      if (fresh) return { ...fresh, _cacheHit: true };
    // A PimpBunny response without a measured size is not a complete cache
    // hit. Its signed media URLs require the logged-in page context, so older
    // background-only probes commonly cached sizeMb=null for 60 days.
    } else if (cached && (!isPimpBunnyUrl(url) || Number(cached.sizeMb || 0) > 0) && (!isWhoreshubUrl(url) || cached.date) && (isInternetChicksUrl(url)
      ? cached.adapter === 'internetchicks-source-v6' && Boolean(cached.streamUrl) && Date.now() - cached.ts < 300000
      : isLeakedzoneUrl(url)
      ? cached.adapter === 'leakedzone-source-v1' && Boolean(cached.streamUrl) && Date.now() - cached.ts < 300000
      : isSxyprnUrl(url)
      ? cached.adapter === 'sxyprn-source-v1' && Boolean(cached.streamUrl) && Date.now() - cached.ts < 300000
      : kvsFlashvars
      ? cached.adapter === 'camwhores-fast-v1' && (Number(cached.sizeMb) > 0 || Date.now() - cached.ts < 300000)
      : isEromeAlbumUrl(url)
      ? cached.adapter === 'erome-album-v1' && (Number(cached.sizeMb || 0) > 0 || cached.videoCount === 0)
      : isEromeVipUrl(url)
        ? cached.adapter === 'erome-vip-v1' && Number(cached.sizeMb || 0) > 0
        : isEpawgUrl(url)
          ? cached.adapter === 'epawg-kvs-v1' && (Number(cached.sizeMb || 0) > 0 || Date.now() - cached.ts < 300000)
        : isPornoneUrl(url)
          ? cached.adapter === 'pornone-source-v1' && (Number(cached.sizeMb || 0) > 0 || Boolean(cached.quality))
        : isCumStUrl(url)
          ? cached.adapter === 'cumst-source-v1' && Boolean(cached.streamUrl) && (Number(cached.sizeMb || 0) > 0 || Boolean(cached.quality))
        : (cached.quality !== '1800P' && (cached._embedChecked === 2 || (Boolean(cached.date) && (Boolean(cached.quality) || Number(cached.sizeMb || 0) > 0)))))) {
          if (!cached._moovChecked && cached.streamUrl && Number(cached.sizeMb || 0) > 0 && (!cached.duration || !cached.quality) && !/\.m3u8(?:[?#]|$)/i.test(cached.streamUrl)) {
            const mp4Meta = await probeMp4HeaderMeta(cached.streamUrl, url);
            if (mp4Meta) {
              const patched = {
                ...cached,
                duration: cached.duration || mp4Meta.duration || null,
                quality: cached.quality || mp4Meta.quality || (mp4Meta.duration ? calculateQualityFromBitrate(cached.sizeMb, mp4Meta.duration) : null) || null,
                _moovChecked: 1,
              };
              await writeCache(url, patched);
              return { ...patched, _cacheHit: true };
            }
          }
          return { ...cached, _cacheHit: true };
        }
  }

  if (kvsFlashvars) {
    const html = await fetchHtml(url, 12000);
    if (!html) return null;
    const meta = await extractCamwhoresMeta(html, url);
    if (meta.sizeMb || meta.duration || meta.date || meta.relDate) await writeCache(url, meta);
    return meta;
  }

  if (isEpawgUrl(url)) {
    const html = await fetchHtml(url, 12000);
    if (!html) return null;
    const meta = await extractEpawgMeta(html, url, tabId);
    if (meta.sizeMb || meta.duration || meta.date || meta.quality) await writeCache(url, meta);
    return meta;
  }

  // Fusion Hub already has a Chrome-impersonated PimpBunny adapter. Use it
  // first so the extension does not hit Cloudflare with ordinary browser HEADs.
  if (isPimpBunnyUrl(url) && !/(^|\.)fnxtube\.com$/i.test(new URL(url).hostname)) {
    const hubMeta = await fetchPimpBunnyHubMeta(url);
    if (hubMeta && (hubMeta.sizeMb || hubMeta.quality || hubMeta.duration)) {
      await writeCache(url, hubMeta);
      return hubMeta;
    }
  }

  // Redgifs is an API-driven SPA — no HTML scrape, hit the public API instead.
  if (isRedgifsUrl(url)) {
    const meta = await extractRedgifsMeta(url, tabId);
    if (meta.duration || meta.quality || meta.sizeText || meta.streamUrl) {
      await writeCache(url, meta);
    }
    return meta;
  }

  if (isEromeAlbumUrl(url)) {
    const html = await fetchHtml(url, 15000);
    if (!html) return null;
    const meta = await extractEromeAlbumMeta(html, url);
    if (meta.sizeMb || meta.videoCount === 0) await writeCache(url, meta);
    return meta;
  }

  // erome.vip streams as /media/v/<id>/video (no .mp4) — generic scraper misses them.
  if (isEromeVipUrl(url)) {
    const html = await fetchHtml(url);
    if (!html) return null;
    const meta = await extractEromeVipMeta(html, url);
    if (meta.sizeMb || meta.duration || meta.date || meta.streamUrl) {
      await writeCache(url, meta);
    }
    return meta;
  }

  // Beeg is a client-rendered site: its page HTML does not reliably contain
  // the currently selected video's stream. Resolve the rendition via Beeg's
  // own metadata endpoint before attempting the generic HTML scraper.
  if (isBeegUrl(url)) {
    const meta = await extractBeegMeta(url, tabId);
    if (meta?.date || meta?.quality || meta?.sizeText || meta?.duration || meta?.streamUrl) {
      await writeCache(url, meta);
      return meta;
    }
  }

  if (isPureGirlUrl(url)) {
    const meta = await extractPureGirlMeta(url, tabId);
    if (meta?.date || meta?.quality || meta?.sizeText || meta?.duration || meta?.streamUrl) {
      await writeCache(url, meta);
      return meta;
    }
  }

  if (is01TubeUrl(url)) {
    const meta = await extract01TubeMeta(url);
    if (meta?.date || meta?.quality || meta?.sizeText || meta?.duration || meta?.streamUrl) {
      await writeCache(url, meta);
      return meta;
    }
  }

  let html = null;
  if ((isPornFansUrl(url) || isPornHoarderUrl(url)) && tabId) {
    try { html = await fetchTextViaTabOrDirect(url, tabId); } catch { }
  }
  if (!html) html = await fetchHtml(url);
  if (!html) return null;

  if (isPornFansUrl(url)) {
    const meta = await extractPornFansMeta(html, url);
    await writeCache(url, meta);
    return meta;
  }

  // The server buttons are embeds, not streams. Resolve and probe each one.
  if (isInternetChicksUrl(url)) {
    const meta = await extractInternetChicksMeta(html, url, tabId);
    if (meta.streamUrl) await writeCache(url, meta);
    return meta;
  }

  if (isLeakedzoneUrl(url)) {
    const meta = await extractLeakedzoneMeta(html, url, tabId);
    if (meta.streamUrl) await writeCache(url, meta);
    return meta;
  }

  if (isSxyprnUrl(url)) {
    const meta = await extractSxyprnMeta(html, url, tabId, { quick, cardExtUrls: opts?.cardExtUrls });
    // Quick (rýchly) výsledok nie je kompletný – nezapisovať do cache.
    if (meta?.streamUrl && !quick) await writeCache(url, meta);
    return meta;
  }

  if (isNoodleMagazineUrl(url)) {
    const meta = await extractNoodleMagazineMeta(html, url, tabId);
    if (meta.date || meta.quality || meta.sizeText || meta.duration || meta.streamUrl) {
      await writeCache(url, meta);
    }
    return meta;
  }

  if (isPimpBunnyUrl(url)) {
    const meta = await extractPimpBunnyMeta(html, url, tabId);
    if (meta.date || meta.quality || meta.sizeText || meta.duration || meta.streamUrl) {
      await writeCache(url, meta);
    }
    return meta;
  }

  if (isXGroovyUrl(url)) {
    const meta = await extractXGroovyMeta(html, url, tabId);
    if (meta.date || meta.quality || meta.sizeText || meta.duration || meta.streamUrl) {
      await writeCache(url, meta);
    }
    return meta;
  }

  if (isPornoneUrl(url)) {
    const meta = await extractPornoneMeta(html, url);
    if (meta.date || meta.quality || meta.sizeMb || meta.duration) {
      await writeCache(url, meta);
    }
    return meta;
  }

  if (isCumStUrl(url)) {
    const meta = await extractCumStMeta(html, url);
    if (meta.date || meta.quality || meta.sizeMb || meta.duration || meta.streamUrl) {
      await writeCache(url, meta);
    }
    return meta;
  }

  let date = extractDate(html);
  let dateEstimated = false;
  let duration = extractDuration(html);
  let { quality, sizeText, sizeMb, streamUrl, sizeEstimated, lastModifiedDate } = await extractQualityAndSizeAsync(html, duration, tabId, url);
  if (streamUrl && sizeMb > 0 && (!duration || !quality) && !/\.m3u8(?:[?#]|$)/i.test(streamUrl)) {
    const mp4Meta = await probeMp4HeaderMeta(streamUrl, url);
    if (mp4Meta) {
      if (!duration && mp4Meta.duration) duration = mp4Meta.duration;
      if (!quality && mp4Meta.quality) quality = mp4Meta.quality;
    }
    if (!quality && duration) {
      const calcQ = calculateQualityFromBitrate(sizeMb, duration);
      if (calcQ) quality = calcQ;
    }
  }
  if (!date && lastModifiedDate) {
    date = lastModifiedDate;
    dateEstimated = true;
  }

  const meta = {
    date,
    ...(dateEstimated ? { dateEstimated: true } : {}),
    quality,
    sizeText,
    sizeMb,
    duration,
    ...(streamUrl ? { streamUrl } : {}),
    ...(sizeEstimated ? { sizeEstimated: true } : {}),
    _embedChecked: 2,
    ...(duration && quality ? { _moovChecked: 1 } : {}),
  };
  if (date || quality || sizeText || duration || streamUrl) {
    await writeCache(url, meta);
  }
  return meta;
}

// ── Import to Nexus ─────────────────────────────────────────
// Nexus API: POST /api/fast-import
// Body: { urls: "url1,url2,url3", filter_enabled: false }

async function importToNexus(port, items, batchName = null, strictPort = false) {
  const headers = { 'Content-Type': 'application/json' };
  try {
    const stored = await chrome.storage.local.get(['nexus_bridge_token', 'bridge_token']);
    const bridgeToken = stored?.nexus_bridge_token || stored?.bridge_token || '';
    if (bridgeToken) headers['X-Nexus-Token'] = bridgeToken;
  } catch (_) { }

  const videos = items.map((item) => ({
    url: item.streamUrl || item.url,
    title: item.title || 'Imported Video',
    source_url: item.sourceUrl || item.url,
    source_scope: item.sourceScope || 'auto',
    mirror_urls: Array.isArray(item.mirrorUrls) ? item.mirrorUrls.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 6) : [],
    thumbnail: item.thumbnail || null,
    duration: item.duration || 0,
    quality: item.quality || 0,
    filesize: item.sizeText || 0,
    file_size_mb: item.file_size_mb || item.sizeMb || null,
    upload_date: item.date || '',
    width: item.width || 0,
    height: item.height || 0,
    tags: [...new Set((Array.isArray(item.tags) ? item.tags : [])
      .filter(tag => typeof tag === 'string')
      .map(tag => tag.trim().toLowerCase().replace(/,/g, '').slice(0,100))
      .filter(tag => tag && tag !== 'selector' && tag !== 'extension').slice(0,80))].join(',')
  }));
  const body = JSON.stringify({
    batch_name: (batchName && String(batchName).trim()) || 'Selector Extension Import',
    videos
  });

  const preferred = String(port || '8000');
  if (strictPort && !['8000', '8001', '8002'].includes(preferred)) return { success: false, error: 'Neplatný cieľ Nexusu.' };
  const ports = strictPort ? [preferred] : [preferred, ...['8000', '8001', '8002'].filter((p) => p !== preferred)];
  const hosts = strictPort ? ['127.0.0.1'] : ['127.0.0.1', 'localhost'];
  if (strictPort) {
    try {
      const health = await fetch(`http://127.0.0.1:${preferred}/health`, { signal: AbortSignal.timeout(4000) });
      if (!health.ok) throw new Error('offline');
    } catch { return { success: false, error: `Nexus :${preferred} je nedostupný. Výber zostal zachovaný.` }; }
  }
  let lastError = 'Nexus dashboard nebeží. Spusti LITE/dashboard a skús znova.';

  for (const p of ports) {
    for (const host of hosts) {
      try {
        const res = await fetch(`http://${host}:${p}/api/v1/import/bulk`, {
          method: 'POST',
          headers,
          body,
          ...(strictPort ? { signal: AbortSignal.timeout(25000) } : {})
        });
        const raw = await res.text();
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = null; }
        if (res.ok) return { success: true, data, status: res.status, error: null };
        const detail = data?.detail || data?.error || data?.message || raw || `HTTP ${res.status}`;
        lastError = res.status === 404
          ? `Nexus na ${host}:${p} nemá import API (404). Reštartni LITE/dashboard.`
          : String(detail);
        if (strictPort) return { success: false, error: lastError, uncertain: res.status >= 500 };
      } catch (e) {
        if (strictPort) return { success: false, uncertain: true, error: 'Odoslaný import nemá potvrdený výsledok. Pred retry skontroluj import monitor zvoleného Nexusu.' };
        lastError = e.message === 'Failed to fetch'
          ? `Nexus na ${host}:${p} neodpovedá.`
          : (e.message || lastError);
      }
    }
  }
  return { success: false, error: lastError };
}

// ── Message handler ─────────────────────────────────────────

// Controllers are only for current in-flight work. Cache survives worker restarts.
const turboOverviewRequests = new Map();
const turboPreparedFrames = new Set();
function turboMp4Metadata(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), result = { duration: 0, width: 0, height: 0 };
  const type = i => String.fromCharCode(...bytes.subarray(i, i + 4));
  for (let i = 4; i + 24 < bytes.length; i++) {
    const kind = type(i), p = i + 4;
    if (kind === 'mvhd') {
      const v = bytes[p], scaleAt = p + (v === 1 ? 20 : 12), durationAt = scaleAt + 4;
      if (v <= 1 && durationAt + (v === 1 ? 8 : 4) <= bytes.length) {
        const scale = view.getUint32(scaleAt), ticks = v === 1 ? Number(view.getBigUint64(durationAt)) : view.getUint32(durationAt);
        if (scale && ticks / scale > 0 && ticks / scale < 86400) result.duration = Math.round(ticks / scale);
      }
    }
    if (kind === 'tkhd') {
      const start = i - 4, length = view.getUint32(start), end = start + length;
      if (length >= 92 && end <= bytes.length) {
        let width = Math.round(view.getUint32(end - 8) / 65536), height = Math.round(view.getUint32(end - 4) / 65536);
        if (!view.getInt32(end - 44) && !view.getInt32(end - 28) && Math.abs(view.getInt32(end - 40)) === 65536 && Math.abs(view.getInt32(end - 32)) === 65536) [width, height] = [height, width];
        if (width > 0 && height > 0 && width < 10000 && height < 10000) Object.assign(result, { width, height });
      }
    }
  }
  return result;
}
async function turboBoundedRead(url, limit, signal, start = null) {
  const u = new URL(url), media = start !== null;
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !(media ? /(^|\.)turbocdn\.st$/.test(u.hostname) : u.hostname === 'turbo.cr')) throw Error('Invalid Turbo source');
  const response = await fetch(url, { signal, redirect: 'error', headers: media ? { Range: `bytes=${start}-${start + limit - 1}` } : {} });
  if (response.status === 429) { const error = new Error('Turbo obmedzil počet požiadaviek.'); error.retry_after = Math.max(1, Number(response.headers.get('retry-after')) || 60); throw error; }
  if (!response.ok) throw Error(`Turbo HTTP ${response.status}`);
  if (media && /text\/|json|xml/i.test(response.headers.get('content-type') || '')) throw Error('Not video');
  const range = (response.headers.get('content-range') || '').match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (media && response.status === 206 && (!range || Number(range[1]) !== start || Number(range[3]) <= Number(range[2]))) throw Error('Invalid range');
  if (media && start && response.status !== 206) { await response.body?.cancel(); return { bytes: new Uint8Array(), size: 0, ranged: false }; }
  const reader = response.body.getReader(), chunks = []; let count = 0;
  try { while (count < limit) { const chunk = await reader.read(); if (chunk.done) break; const bounded = chunk.value.subarray(0, limit - count); chunks.push(bounded); count += bounded.length; } }
  finally { await reader.cancel(); }
  const bytes = new Uint8Array(count); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return { bytes, size: range ? Number(range[3]) : Number(response.headers.get('content-length')) || 0, ranged: response.status === 206 };
}
async function turboDirectMetadata(id, signal) {
  const sign = await turboBoundedRead(`https://turbo.cr/api/sign?v=${encodeURIComponent(id)}`, 16384, signal);
  const stream = JSON.parse(new TextDecoder().decode(sign.bytes)).url;
  const head = await turboBoundedRead(stream, 128 * 1024, signal, 0);
  let meta = turboMp4Metadata(head.bytes);
  if (head.ranged && head.size > head.bytes.length && !(meta.duration && meta.width && meta.height)) {
    const tail = await turboBoundedRead(stream, 256 * 1024, signal, Math.max(0, head.size - 256 * 1024));
    const parsed = turboMp4Metadata(tail.bytes);
    for (const key of ['duration', 'width', 'height']) if (!meta[key]) meta[key] = parsed[key];
    if (!(meta.duration && meta.width && meta.height)) {
      const view = new DataView(head.bytes.buffer); let offset = 0;
      while (offset + 8 <= head.bytes.length) {
        let length = view.getUint32(offset); if (length === 1 && offset + 16 <= head.bytes.length) length = Number(view.getBigUint64(offset + 8));
        if (length < 8) break; offset += length;
      }
      if (offset > 0 && offset < head.size) {
        const moov = await turboBoundedRead(stream, Math.min(1024 * 1024, head.size - offset), signal, offset);
        const parsedMoov = turboMp4Metadata(moov.bytes);
        for (const key of ['duration', 'width', 'height']) if (!meta[key]) meta[key] = parsedMoov[key];
      }
    }
  }
  return { ok: true, id, title: `${id}.mp4`, ...meta, size_bytes: head.size };
}
function turboOverviewId(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'turbo.cr' || u.port || u.username || u.password) return null;
    return u.pathname.match(/^\/(?:v|d|embed)\/([A-Za-z0-9_-]{1,128})\/?$/)?.[1] || null;
  } catch { return null; }
}
async function fetchArchveOverviewMeta(archveId, sourceUrl, port, requestId, tabId, force) {
  const key = `nvs-archve-meta-v1:${port}:${archveId}`, controller = new AbortController();
  const jobKey = `${tabId}:${requestId}`;
  turboOverviewRequests.set(jobKey, controller);
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const stored = await chrome.storage.local.get([key]);
    if (controller.signal.aborted) return { error: 'Zastavené' };
    const cached = stored[key];
    if (!force && cached?.expires > Date.now()) return { meta: cached.meta, cached: true };
    if (!globalThis.__nvsArchveFetcher) {
      globalThis.__nvsArchveFetcher = globalThis.NVSArchve.createFetcher({ fetchImpl: fetch, readCache, writeCache, formatSizeMb });
    }
    const raw = await globalThis.__nvsArchveFetcher.video(sourceUrl || `https://archve.xyz/watch/${archveId}`, force);
    if (controller.signal.aborted) return { error: 'Zastavené' };
    const duration = globalThis.NVSArchve.seconds(raw?.duration || '');
    const width = Number(raw?.width) || 0;
    const height = Number(raw?.height) || 0;
    const size_bytes = raw?.sizeMb ? Math.round(Number(raw.sizeMb) * 1048576) : 0;
    const title = String(raw?.title || `${archveId}.mp4`).slice(0, 250);
    const ok = Boolean(duration || (width && height) || size_bytes);
    const meta = {
      ok, id: archveId, title, duration, width, height, size_bytes,
      unavailable: !ok, error: ok ? '' : 'Nepodarilo sa načítať metadáta z Archve.', retry_after: 0
    };
    const complete = ok && ['duration', 'width', 'height', 'size_bytes'].every(k => meta[k] > 0);
    await chrome.storage.local.set({ [key]: { meta, expires: Date.now() + (complete ? 6 * 3600000 : 60000) } });
    return { meta };
  } catch {
    return { error: controller.signal.aborted ? 'Zastavené alebo prekročený časový limit' : 'Nepodarilo sa načítať metadáta z Archve.' };
  } finally {
    clearTimeout(timeout);
    turboOverviewRequests.delete(jobKey);
  }
}
async function fetchTurboOverviewMeta(msg, tabId) {
  const id = turboOverviewId(msg.url), port = String(msg.port), requestId = String(msg.requestId || '');
  const archveId = !id ? globalThis.NVSArchve?.videoId?.(msg.originalUrl || msg.url) : '';
  if ((!id && !archveId) || !['8000', '8001', '8002'].includes(port) || !requestId || tabId == null) return { error: 'Neplatná metadata požiadavka.' };
  if (archveId) return fetchArchveOverviewMeta(archveId, msg.originalUrl || msg.url, port, requestId, tabId, Boolean(msg.force));
  const key = `nvs-turbo-meta-v1:${port}:${id}`, controller = new AbortController();
  const jobKey = `${tabId}:${requestId}`;
  turboOverviewRequests.set(jobKey, controller);
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const stored = await chrome.storage.local.get([key, 'nexus_bridge_token', 'bridge_token']);
    if (controller.signal.aborted) return { error: 'Zastavené' };
    const cached = stored[key];
    if (!msg.force && cached?.expires > Date.now()) return { meta: cached.meta, cached: true };
    const headers = { 'Content-Type': 'application/json' };
    const token = stored.nexus_bridge_token || stored.bridge_token;
    if (token) headers['X-Nexus-Token'] = token;
    let raw;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/tester/turbo-meta`, {
        method: 'POST', headers, body: JSON.stringify({ url: `https://turbo.cr/v/${id}` }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3500)])
      });
      if (response.ok) raw = await response.json();
    } catch { /* Read-only metadata can resolve directly when local Nexus is blocked. */ }
    if (!raw?.ok && !raw?.retry_after && !raw?.unavailable && !controller.signal.aborted) raw = await turboDirectMetadata(id, controller.signal);
    // Persist/export only metadata, never the signed CDN URL or credentials.
    const meta = { ok: Boolean(raw.ok), id, title: String(raw.title || '').slice(0, 250),
      duration: Number(raw.duration) || 0, width: Number(raw.width) || 0, height: Number(raw.height) || 0,
      size_bytes: Number(raw.size_bytes) || 0, unavailable: Boolean(raw.unavailable),
      error: String(raw.error || '').slice(0, 300), retry_after: Number(raw.retry_after) || 0 };
    if (!controller.signal.aborted) {
      const complete = meta.ok && ['duration','width','height','size_bytes'].every(k => meta[k] > 0);
      await chrome.storage.local.set({ [key]: { meta, expires: Date.now() + (complete ? 6 * 3600000 : 60000) } });
    }
    return { meta };
  } catch (error) {
    if (error.retry_after) return { meta: { ok: false, error: 'Turbo obmedzil počet požiadaviek. Pokračovanie po prestávke.', retry_after: error.retry_after } };
    return { error: controller.signal.aborted ? 'Zastavené alebo prekročený časový limit' : 'Nepodarilo sa načítať metadáta z Nexusu ani priamo z Turbo. Obnoviť údaje skúsi načítanie znova. Výber zostal zachovaný.' };
  }
  finally { clearTimeout(timeout); turboOverviewRequests.delete(jobKey); }
}

async function probeNexusPortHealth(ports) {
  const requested = Array.isArray(ports) && ports.length ? ports : ['8000', '8001', '8002'];
  const entries = await Promise.all(requested.map(async (port) => {
    const name = String(port);
    if (!['8000', '8001', '8002'].includes(name)) return [name, false];
    try {
      const res = await fetch(`http://127.0.0.1:${name}/health`, { signal: AbortSignal.timeout(1500) });
      return [name, res.ok];
    } catch {
      return [name, false];
    }
  }));
  return Object.fromEntries(entries);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'NVS_PORT_HEALTH') {
    void (async () => {
      try { sendResponse(await probeNexusPortHealth(msg.ports)); }
      catch { sendResponse({}); }
    })();
    return true;
  }
  if (msg.type === 'TURBO_PREPARE_FRAME' && sender.tab?.id != null && /^[A-Za-z0-9_-]{1,128}$/.test(msg.id)) {
    turboPreparedFrames.add(`${sender.tab.id}:${msg.id}`);
    chrome.tabs.sendMessage(sender.tab.id, { type: 'TURBO_PREPARE_FRAME', id: msg.id }).catch(() => {});
    sendResponse({ok:true}); return;
  }
  if (msg.type === 'TURBO_FRAME_HELLO') {
    const id = turboOverviewId(sender.url);
    sendResponse({ prepare: Boolean(id && id === msg.id && sender.tab?.id != null && turboPreparedFrames.has(`${sender.tab.id}:${id}`)) }); return;
  }
  if (msg.type === 'TURBO_FRAME_META') {
    const id = turboOverviewId(sender.url);
    if (!id || id !== msg.id || sender.tab?.id == null) return;
    const meta = {};
    for (const key of ['duration','width','height','size_bytes']) { const value = Number(msg.meta?.[key]); if (Number.isFinite(value) && value > 0) meta[key] = value; }
    chrome.tabs.sendMessage(sender.tab.id, { type: 'TURBO_FRAME_META', id, meta }, { frameId: 0 }).catch(() => {});
    sendResponse({ ok: true }); return;
  }
  if (msg.type === 'TURBO_OVERVIEW_META') {
    (async () => { sendResponse(await fetchTurboOverviewMeta(msg, sender.tab?.id)); })();
    return true;
  }
  if (msg.type === 'TURBO_OVERVIEW_CANCEL') {
    turboOverviewRequests.get(`${sender.tab?.id}:${msg.requestId}`)?.abort();
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'PROBE_MEDIA_SIZE') {
    void (async () => {
      try {
        const sizeBytes = await fetchHeadSize(String(msg.url || ''), String(msg.referer || ''), true);
        sendResponse({ sizeBytes, sizeMb: sizeBytes ? Math.round(sizeBytes / (1024 * 1024)) : null });
      } catch { sendResponse({ sizeBytes: null, sizeMb: null }); }
    })();
    return true;
  }

  if (msg.type === 'NVS_FETCH_MANIFEST') {
    void (async () => {
      try {
        const target = new URL(String(msg.url || ''));
        if (target.protocol !== 'https:' || target.username || target.password) {
          sendResponse({ ok: false });
          return;
        }
        if (/^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[|0\.)/i.test(target.hostname) || target.hostname.endsWith('.local')) {
          sendResponse({ ok: false });
          return;
        }
        const res = await fetch(target.href, { credentials: 'include', redirect: 'follow', signal: AbortSignal.timeout(9000) });
        if (!res.ok) { sendResponse({ ok: false }); return; }
        const text = await res.text();
        sendResponse({ ok: true, text, url: res.url || target.href });
      } catch {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (msg.type === 'GET_CACHED_META') {
    (async () => {
      const results = {};
      for (const url of (msg.urls || []).slice(0, 500)) {
        const cached = await readCache(url);
        if (cached) results[url] = cached;
      }
      sendResponse({ results });
    })();
    return true;
  }

  if (msg.type === 'CACHE_ADMIN') {
    (async () => {
      try { sendResponse(await nvsCacheAdmin(msg)); }
      catch (error) { sendResponse({ ok: false, error: String(error) }); }
    })();
    return true;
  }

  if (msg.type === 'FETCH_META') {
    (async () => {
      try {
        const meta = await fetchVideoMeta(msg.url, sender.tab?.id, Boolean(msg.force), Boolean(msg.quick), { cardExtUrls: msg.cardExtUrls });
        sendResponse({ meta });
      } catch {
        sendResponse({ meta: null });
      }
    })();
    return true;
  }

  if (msg.type === 'FETCH_CAMWHORES_META_BATCH') {
    (async () => {
      try { sendResponse({ results: await fetchCamwhoresMetaBatch(msg.items, sender.tab?.id) }); }
      catch { sendResponse({ results: {} }); }
    })();
    return true;
  }

  if (msg.type === 'IMPORT_TO_NEXUS') {
    (async () => {
      try {
        const strict = Boolean(msg.strictPort) || msg.items?.some(item => turboOverviewId(item.sourceUrl || item.url));
        sendResponse(await importToNexus(msg.port, msg.items, msg.batchName, strict));
      } catch { sendResponse({ success: false, error: 'Import sa nepodarilo pripraviť.' }); }
    })();
    return true;
  }

  if (msg.type === 'GET_SETTINGS') {
    chrome.storage.sync.get({
      nexusPorts: ['8000', '8001', '8002'],
      enabled: true
    }, data => sendResponse(data));
    return true;
  }
});
