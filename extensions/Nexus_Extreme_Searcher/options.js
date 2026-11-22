import { DEFAULTS } from './engine.js';
const form = document.getElementById('options');
const status = document.getElementById('status');
const { settings = {} } = await chrome.storage.local.get('settings');
for (const [key, value] of Object.entries({ ...DEFAULTS, ...settings })) {
  if (form.elements.namedItem(key)) form.elements.namedItem(key).value = value;
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  const values = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const field = form.elements.namedItem(key);
    if (field) values[key] = key === 'cacheMinutes' ? Math.max(10, Math.min(20, Number(field.value) || 15)) : field.value.trim();
  }
  await chrome.storage.local.set({ settings: values });
  status.textContent = 'Uložené.';
});
