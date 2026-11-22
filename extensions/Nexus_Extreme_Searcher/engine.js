export const DEFAULTS = Object.freeze({
  nexusUrl: 'http://127.0.0.1:8000', nexusToken: '',
  jackettUrl: 'http://127.0.0.1:9117', jackettKey: '',
  prowlarrUrl: '', prowlarrKey: '', qbitUrl: '', qbitUser: '', qbitPassword: '',
  cacheMinutes: 15
});

export const GROUPS = Object.freeze({
  tubes: ['eporner', 'xvideos', 'pornhub', 'spankbang', 'xhamster', 'camwhores'],
  extraTubes: ['whoreshub', 'porntrex', 'beeg', 'noodlemagazine', 'hqporner'],
  files: ['bunkr', 'gofile', 'pixeldrain', 'erome'],
  reddit: ['reddit']
});

const SOFT_BLOCK = /\b(?:leak(?:ed|s)?|stolen|hacked|hidden[ -]?cam|revenge[ -]?porn|non[ -]?consensual|underage|child|minor)\b/i;
export function validateQuery(input) {
  const query = String(input || '').trim().replace(/\s+/g, ' ');
  if (query.length < 2 || query.length > 180) throw Error('Zadaj 2 až 180 znakov.');
  if (SOFT_BLOCK.test(query)) throw Error('Vyhľadávanie súkromných únikov a obsahu bez súhlasu nie je podporované.');
  return query;
}

export function variants(query) {
  const words = query.split(' ');
  const output = [query];
  const names = [...query.matchAll(/\b([A-Z][a-z]{2,})\s+([A-Z][a-z]{2,})\b/g)]
    .map(match => match[0]).filter(name => !/^(Huge|Covered|Big|Tits|Cum)\b/i.test(name));
  if (names.length) output.push(names[0]);
  if (words.length >= 4) output.push(words.slice(-Math.min(4, words.length)).join(' '));
  if (words.length >= 5) output.push(words.slice(0, 3).join(' '));
  return [...new Set(output)].slice(0, 3);
}

export function safeUrl(value) {
  try {
    const u = new URL(value);
    return ['http:', 'https:', 'magnet:'].includes(u.protocol) ? u.href : '';
  } catch { return ''; }
}

export function normalize(raw, category, source = '') {
  const url = safeUrl(raw.details_url || raw.url || raw.permalink || raw.link || '');
  const magnet = safeUrl(raw.magnet || raw.magnetUrl || '');
  const title = String(raw.title || raw.name || '').trim();
  if (!title || (!url && !magnet)) return null;
  return {
    id: `${category}:${raw.infohash || magnet || url}`,
    category, title, url: url || magnet, magnet,
    downloadUrl: safeUrl(raw.download_url || raw.downloadUrl || ''),
    thumbnail: safeUrl(raw.thumb_url || raw.thumbnail || raw.thumb || ''),
    source: String(raw.indexer || raw.source || raw.source_key || source || category),
    infohash: String(raw.infohash || '').toLowerCase(), ref: String(raw.ref || ''),
    size: Number(raw.size || raw.file_size_mb * 1048576 || 0),
    seeds: Number(raw.seeders || raw.seeds || 0),
    duration: Number(raw.duration || 0),
    date: String(raw.publish_date || raw.upload_date || raw.created_utc || raw.date || ''),
    score: 0
  };
}

export function score(item, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = item.title.toLowerCase();
  const hits = terms.filter(term => text.includes(term)).length;
  const exact = text.includes(query.toLowerCase()) ? 2 : 0;
  const fresh = Number.isFinite(Date.parse(item.date)) ? Math.max(0, 1 - (Date.now() - Date.parse(item.date)) / 31_536_000_000) : 0;
  return (hits / terms.length) * 10 + exact + fresh + Math.log1p(item.seeds) / 8;
}

export function dedupe(rows, query) {
  const seen = new Set(), output = [];
  const titleTokens = title => new Set(title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean));
  const similar = (a, b) => {
    if (a.category !== b.category) return false;
    const left = titleTokens(a.title), right = titleTokens(b.title);
    if (left.size < 4 || right.size < 4) return false;
    const intersection = [...left].filter(token => right.has(token)).length;
    return intersection / Math.max(left.size, right.size) >= .92;
  };
  for (const row of rows) {
    const key = row.infohash || row.url.toLowerCase().split('#')[0].replace(/\/$/, '') || row.title.toLowerCase();
    if (seen.has(key) || output.some(existing => similar(existing, row))) continue;
    seen.add(key);
    row.score = score(row, query);
    output.push(row);
  }
  return output.sort((a, b) => b.score - a.score || Date.parse(b.date) - Date.parse(a.date));
}

export async function fetchJson(url, options = {}, timeoutMs = 14000) {
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(url);
  const credentials = options.credentials || (isLocal ? 'include' : 'omit');
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      try {
        controller.abort(new DOMException(`Časový limit vypršal (${Math.round(timeoutMs / 1000)}s)`, 'TimeoutError'));
      } catch {
        controller.abort();
      }
    }, timeoutMs);
    try {
      const response = await fetch(url, { ...options, credentials, signal: controller.signal });
      if (!response.ok) {
        if (attempt === 0 && [429, 502, 503].includes(response.status)) {
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        throw Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw Error(reason?.message || `Časový limit vypršal (${Math.round(timeoutMs / 1000)}s)`);
      }
      if (attempt === 0 && (error.name === 'TypeError' || error.message?.includes('network'))) {
        await new Promise(resolve => setTimeout(resolve, 400));
        continue;
      }
      if (error.name === 'TypeError' && (error.message === 'Failed to fetch' || error.message === 'fetch failed' || error.cause?.code === 'ECONNREFUSED')) {
        if (isLocal) {
          throw Error(`Nexus server nedostupný na ${new URL(url).origin} (${error.message})`);
        }
        throw Error(`Spojenie zlyhalo (${error.message})`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function runBounded(tasks, limit = 4) {
  const results = new Array(tasks.length);
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor++;
      try { results[index] = { ok: true, value: await tasks[index]() }; }
      catch (error) { results[index] = { ok: false, error: String(error?.message || error) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

export function baseUrl(input, fallback) {
  const url = new URL(input || fallback);
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('Neplatná URL služby.');
  return url.origin;
}
