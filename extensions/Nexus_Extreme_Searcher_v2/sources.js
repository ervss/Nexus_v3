import { baseUrl, fetchJson, normalize, siteList } from './engine.js';

// Publicly indexable pages only. Sites requiring a session are shown in diagnostics.
const DEFAULT_SITES = Object.freeze({
  torrents: ['thepiratebay.org', 'limetorrents.lol', 'torrentdownloads.pro', 'torrentfunk.com', 'btdig.com', 'solidtorrents.to'],
  files: ['bunkrsearch.com', 'findr.to', 'pixeldrain.com', 'gofile.io', 'filester.me', 'fileditchfiles.com', 'mega.nz', 'cyberdrop.cr', 'vk.com'],
  forums: ['f95zone.to']
});

export function searchSites(settings, category) {
  const key = { torrents: 'torrentSites', files: 'fileHostSites', forums: 'forumSites' }[category];
  const configured = siteList(settings[key]);
  return configured.length ? configured : DEFAULT_SITES[category].map(host => `https://${host}`);
}

export async function searxngSite(settings, query, origin, category) {
  const base = baseUrl(settings.searxngUrl, settings.searxngUrl);
  const hostname = new URL(origin).hostname;
  const params = new URLSearchParams({ q: `site:${hostname} ${query}`, format: 'json', safesearch: '0', language: 'all' });
  const data = await fetchJson(`${base}/search?${params}`, {}, 12000);
  return (data.results || []).filter(row => {
    try {
      const host = new URL(row.url).hostname;
      return host === hostname || host.endsWith(`.${hostname}`);
    } catch { return false; }
  }).map(row => normalize({
    title: row.title, url: row.url, thumbnail: row.img_src || row.thumbnail,
    date: row.publishedDate, source: hostname,
    importable: category === 'files'
  }, category)).filter(Boolean);
}

export async function discourseSearch(origin, query) {
  const params = new URLSearchParams({ q: query });
  const data = await fetchJson(`${origin}/search.json?${params}`, {}, 12000);
  return (data.topics || []).map(topic => normalize({
    title: topic.title, url: `${origin}/t/${topic.slug}/${topic.id}`,
    date: topic.last_posted_at || topic.created_at,
    source: new URL(origin).hostname, importable: false
  }, 'forums')).filter(Boolean);
}

export async function tpdbSearch(settings, query) {
  if (!settings.tpdbKey) return [];
  const params = new URLSearchParams({ q: query.slice(0, 180), per_page: '15' });
  const data = await fetchJson(`https://api.theporndb.net/scenes?${params}`, {
    headers: { Authorization: `Bearer ${settings.tpdbKey}` }
  }, 15000);
  const scenes = Array.isArray(data) ? data : data.data || [];
  return scenes.map(scene => {
    const image = scene.poster || scene.image || '';
    const thumbnail = typeof image === 'string' ? image : image.url || image.full || '';
    return normalize({
      title: scene.title || scene.name,
      url: scene.url || (scene.id ? `https://theporndb.net/scenes/${scene.id}` : ''),
      thumbnail, date: scene.date || scene.release_date,
      source: 'ThePornDB', importable: false
    }, 'metadata');
  }).filter(Boolean);
}

export function additionalTasks(settings, query) {
  const tasks = [];
  if (settings.tpdbKey) tasks.push({ name: 'ThePornDB', run: () => tpdbSearch(settings, query) });
  for (const origin of siteList(settings.discourseSites)) {
    tasks.push({ name: `Discourse · ${new URL(origin).hostname}`, run: () => discourseSearch(origin, query) });
  }
  if (settings.searxngUrl) {
    for (const category of ['torrents', 'files', 'forums']) {
      for (const origin of searchSites(settings, category)) {
        tasks.push({
          name: `SearXNG · ${new URL(origin).hostname}`,
          run: () => searxngSite(settings, query, origin, category)
        });
      }
    }
  }
  return tasks;
}
