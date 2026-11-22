import { DEFAULTS, siteList } from './engine.js';

const form = document.getElementById('options');
const status = document.getElementById('status');
const localStatus = document.getElementById('local-status');
const { settings = {} } = await chrome.storage.local.get('settings');
for (const [key, value] of Object.entries({ ...DEFAULTS, ...settings })) {
  const field = form.elements.namedItem(key);
  if (field) field.value = value;
}

document.getElementById('detect-local').addEventListener('click', async () => {
  const nexusUrl = form.elements.namedItem('nexusUrl').value.trim() || DEFAULTS.nexusUrl;
  localStatus.textContent = 'Overujem Nexus…';
  try {
    const base = new URL(nexusUrl).origin;
    const response = await fetch(`${base}/api/torrent/health`, { credentials: 'include' });
    if (!response.ok) throw Error(`Nexus odpovedal HTTP ${response.status}`);
    const health = await response.json();
    if (health.jackett?.configured && !form.elements.namedItem('jackettUrl').value.trim()) {
      form.elements.namedItem('jackettUrl').value = health.jackett.url || DEFAULTS.jackettUrl;
    }
    if (health.prowlarr?.configured && !form.elements.namedItem('prowlarrUrl').value.trim()) {
      form.elements.namedItem('prowlarrUrl').value = DEFAULTS.prowlarrUrl || 'http://127.0.0.1:9696';
    }
    localStatus.textContent = `Nexus OK · Jackett: ${health.jackett?.configured ? 'nastavený' : 'nenastavený'} · Prowlarr: ${health.prowlarr?.configured ? 'nastavený' : 'nenastavený'} · qBittorrent: ${health.qbittorrent?.reachable ? 'dostupný' : 'nedostupný'}`;
  } catch (error) { localStatus.textContent = `Lokálnu službu sa nepodarilo overiť: ${error.message}`; }
});

function permissionOrigin(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (['localhost', '127.0.0.1'].includes(url.hostname)) return '';
    return `${url.protocol}//${url.hostname}/*`;
  } catch { return ''; }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  status.textContent = '';
  const values = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const field = form.elements.namedItem(key);
    if (field) values[key] = key === 'cacheMinutes'
      ? Math.max(10, Math.min(20, Number(field.value) || 15)) : field.value.trim();
  }
  const origins = [...new Set([
    ...siteList(values.discourseSites), values.searxngUrl,
    values.jackettKey ? values.jackettUrl : '',
    values.prowlarrKey ? values.prowlarrUrl : '', values.nexusUrl
  ].map(permissionOrigin).filter(Boolean))];
  try {
    // The permission request must start in the submit gesture before any await.
    const grant = origins.length ? chrome.permissions.request({ origins }) : Promise.resolve(true);
    if (!await grant) throw Error('Prístup k zadaným stránkam nebol povolený.');
    const { cacheIndex = [] } = await chrome.storage.local.get('cacheIndex');
    if (cacheIndex.length) await chrome.storage.local.remove(cacheIndex);
    await chrome.storage.local.set({ settings: values, cacheIndex: [], lastSearch: null });
    status.textContent = 'Uložené.';
  } catch (error) { status.textContent = error.message; }
});
