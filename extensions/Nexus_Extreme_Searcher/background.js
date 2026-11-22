import { DEFAULTS, GROUPS, baseUrl, dedupe, fetchJson, normalize, runBounded, validateQuery, variants } from './engine.js';

const headers = settings => settings.nexusToken ? { 'X-Nexus-Token': settings.nexusToken } : {};
const jsonPost = (url, body, extra = {}) => fetchJson(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body)
}, 25000);

async function nexusSearch(settings, query, category, sources) {
  const base = baseUrl(settings.nexusUrl, DEFAULTS.nexusUrl);
  const params = new URLSearchParams({ query, source: sources.join(','), max_total: '90', per_source_limit: '15', save_history: 'false', enrich_unknown: 'false', mode: '1' });
  const data = await fetchJson(`${base}/api/v1/search/external?${params}`, { headers: headers(settings) }, 55000);
  return (data.results || []).map(row => normalize(row, category)).filter(Boolean);
}

async function epornerSearch(settings, query) {
  const params = new URLSearchParams({ query, per_page: '24', page: '1', thumbsize: 'medium', order: 'latest', gay: '1', lq: '0', format: 'json' });
  try {
    const data = await fetchJson(`https://www.eporner.com/api/v2/video/search/?${params}`, {}, 8000);
    return (data.videos || []).map(row => normalize({
      title: row.title, url: row.url, thumbnail: row.default_thumb?.src,
      duration: row.length_sec, date: row.added, source: 'Eporner'
    }, 'tubes')).filter(Boolean);
  } catch (error) {
    try {
      const fromNexus = await nexusSearch(settings, query, 'tubes', ['eporner']);
      if (fromNexus.length) return fromNexus;
    } catch {}
    throw error;
  }
}

async function nexusTorrent(settings, query) {
  const base = baseUrl(settings.nexusUrl, DEFAULTS.nexusUrl);
  const data = await fetchJson(`${base}/api/torrent/search?${new URLSearchParams({ q: query, cat: '6000' })}`, { headers: headers(settings) }, 30000);
  return (data.results || []).map(row => {
    const item = normalize({ ...row, thumb_url: row.thumb_url?.startsWith('/') ? `${base}${row.thumb_url}` : row.thumb_url }, 'torrents');
    return item;
  }).filter(Boolean);
}

async function jackettSearch(settings, query) {
  if (!settings.jackettKey) return [];
  const base = baseUrl(settings.jackettUrl, DEFAULTS.jackettUrl);
  const params = new URLSearchParams({ apikey: settings.jackettKey, Query: query });
  params.append('Category[]', '6000');
  const data = await fetchJson(`${base}/api/v2.0/indexers/all/results?${params}`, {}, 30000);
  return (data.Results || []).map(row => normalize({
    title: row.Title, details_url: row.Details, magnet: row.MagnetUri,
    download_url: row.Link, size: row.Size, seeders: row.Seeders,
    publish_date: row.PublishDate, infohash: row.InfoHash, indexer: row.Tracker
  }, 'torrents')).filter(Boolean);
}

async function prowlarrSearch(settings, query) {
  if (!settings.prowlarrUrl || !settings.prowlarrKey) return [];
  const base = baseUrl(settings.prowlarrUrl, settings.prowlarrUrl);
  const params = new URLSearchParams({ query, categories: '6000', type: 'search' });
  const data = await fetchJson(`${base}/api/v1/search?${params}`, { headers: { 'X-Api-Key': settings.prowlarrKey } }, 30000);
  return (Array.isArray(data) ? data : []).map(row => normalize({
    ...row, url: row.infoUrl, magnet: row.magnetUrl, details_url: row.infoUrl,
    download_url: row.downloadUrl, seeders: row.seeders, publish_date: row.publishDate,
    infohash: row.infoHash, indexer: row.indexer
  }, 'torrents')).filter(Boolean);
}

async function pullpushRedditSearch(query) {
  const params = new URLSearchParams({ q: query, size: '50' });
  const data = await fetchJson(`https://api.pullpush.io/reddit/search/submission/?${params}`, {}, 9000);
  return (data.data || []).map(row => {
    let thumb = '';
    if (row.preview?.images?.[0]?.source?.url) {
      thumb = row.preview.images[0].source.url.replace(/&amp;/g, '&');
    } else if (typeof row.thumbnail === 'string' && row.thumbnail.startsWith('http')) {
      thumb = row.thumbnail;
    } else if (typeof row.url === 'string' && /\.(jpe?g|png|webp|gif)($|\?)/i.test(row.url)) {
      thumb = row.url;
    }
    const permalink = row.permalink ? (row.permalink.startsWith('http') ? row.permalink : `https://www.reddit.com${row.permalink}`) : row.url;
    return normalize({
      title: row.title,
      url: permalink,
      thumbnail: thumb,
      source: `r/${row.subreddit || 'reddit'}`,
      date: row.created_utc ? new Date(row.created_utc * 1000).toISOString() : ''
    }, 'reddit');
  }).filter(Boolean);
}

async function redditSearch(query) {
  const params = new URLSearchParams({ q: query, sort: 'new', limit: '75', include_over_18: 'on', restrict_sr: 'false', raw_json: '1' });
  const data = await fetchJson(`https://www.reddit.com/search.json?${params}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  }, 9000);
  return (data.data?.children || []).map(({ data: row }) => normalize({
    title: row.title, url: `https://www.reddit.com${row.permalink}`,
    thumbnail: row.preview?.images?.[0]?.source?.url || '',
    source: `r/${row.subreddit}`, date: row.created_utc ? new Date(row.created_utc * 1000).toISOString() : ''
  }, 'reddit')).filter(Boolean);
}

async function nexusReddit(settings, query) {
  return nexusSearch(settings, query, 'reddit', GROUPS.reddit);
}

function tasksFor(settings, query) {
  const v = variants(query);
  return [
    { name: 'Nexus tubes', run: () => nexusSearch(settings, v[0], 'tubes', GROUPS.tubes) },
    { name: 'Nexus extra tubes', run: () => nexusSearch(settings, v.length > 1 ? v[1] : v[0], 'tubes', GROUPS.extraTubes) },
    { name: 'Nexus file hosts', run: () => nexusSearch(settings, v.length > 1 ? v[1] : v[0], 'files', GROUPS.files) },
    { name: 'Eporner latest', run: () => epornerSearch(settings, v.length > 1 ? v[1] : v[0]) },
    { name: 'Nexus torrent', run: () => nexusTorrent(settings, v[0]) },
    { name: 'Jackett', run: () => jackettSearch(settings, v[0]) },
    { name: 'Prowlarr', run: () => prowlarrSearch(settings, v[0]) },
    { name: 'Reddit', run: async () => {
      const target = v.length > 1 ? v[1] : v[0];
      try {
        let rows = await pullpushRedditSearch(target);
        if (!rows.length && target !== v[0]) rows = await pullpushRedditSearch(v[0]);
        if (rows.length) return rows;
      } catch {}
      try {
        let rows = await redditSearch(target);
        if (!rows.length && target !== v[0]) rows = await redditSearch(v[0]);
        if (rows.length) return rows;
      } catch {}
      return nexusReddit(settings, target);
    } }
  ].filter(task => task.name !== 'Jackett' || settings.jackettKey)
   .filter(task => task.name !== 'Prowlarr' || (settings.prowlarrKey && settings.prowlarrUrl));
}

async function search(input) {
  const query = validateQuery(input);
  const settings = { ...DEFAULTS, ...(await chrome.storage.local.get('settings')).settings };
  const cacheKey = `search:${query.toLowerCase()}`;
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  if (cached && Date.now() - cached.at < Number(settings.cacheMinutes || 15) * 60000) return { ...cached.payload, cached: true };
  const { lastSearchAt = 0 } = await chrome.storage.local.get('lastSearchAt');
  if (Date.now() - lastSearchAt < 3000) throw Error('Počkaj 3 sekundy pred ďalším hľadaním.');
  await chrome.storage.local.set({ lastSearchAt: Date.now() });
  const tasks = tasksFor(settings, query);
  const outcomes = await runBounded(tasks.map(task => task.run), 3);
  const rows = [], diagnostics = [];
  outcomes.forEach((outcome, index) => {
    diagnostics.push({ source: tasks[index].name, count: outcome.ok ? outcome.value.length : 0, error: outcome.ok ? '' : outcome.error });
    if (outcome.ok) rows.push(...outcome.value);
  });
  const payload = { query, results: dedupe(rows, query), diagnostics, cached: false, searchedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [cacheKey]: { at: Date.now(), payload }, lastSearch: payload });
  return payload;
}

async function addSelected(items) {
  const settings = { ...DEFAULTS, ...(await chrome.storage.local.get('settings')).settings };
  const base = baseUrl(settings.nexusUrl, DEFAULTS.nexusUrl);
  const videos = items.filter(item => item.category !== 'torrents').map(item => item.url).filter(Boolean);
  const torrents = items.filter(item => item.category === 'torrents');
  const status = [];
  if (videos.length) {
    const result = await jsonPost(`${base}/api/v1/bridge/import`, {
      urls: videos, batch_name: `Extreme Searcher ${new Date().toISOString()}`
    }, headers(settings));
    status.push(`Nexus: ${result.count ?? videos.length} URL zaradených`);
  }
  for (const item of torrents) {
    const body = item.magnet ? { magnet: item.magnet } : { ref: item.ref };
    if (!body.magnet && !body.ref) { status.push(`${item.title}: chýba magnet/ref`); continue; }
    try {
      await jsonPost(`${base}/api/torrent/add`, body, headers(settings));
      status.push(`${item.title}: torrent pridaný`);
    } catch (error) { status.push(`${item.title}: ${error.message}`); }
  }
  return status;
}

async function downloadItem(item) {
  const url = item.downloadUrl || item.magnet || item.url;
  if (!url) throw Error('Výsledok nemá súbor na stiahnutie.');
  if (url.startsWith('magnet:')) {
    await chrome.tabs.create({ url });
    return 'Magnet otvorený v prehliadači';
  }
  if (item.downloadUrl) {
    await chrome.downloads.download({ url: item.downloadUrl, saveAs: true });
    return 'Sťahovanie spustené';
  }
  await chrome.tabs.create({ url });
  return 'Otvorená stránka zdroja';
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      let data;
      if (message.type === 'SEARCH') data = await search(message.query);
      else if (message.type === 'ADD_SELECTED') data = await addSelected(message.items || []);
      else if (message.type === 'DOWNLOAD') data = await downloadItem(message.item);
      else throw Error('Neznáma požiadavka');
      sendResponse({ ok: true, data });
    } catch (error) { sendResponse({ ok: false, error: String(error?.message || error) }); }
  })();
  return true;
});
