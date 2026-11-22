export const SETTINGS_KEY = "nexus-deck-settings";
const KEY = SETTINGS_KEY;

export function isExtension() {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
}

export function defaultSettings() {
  const onWeb = !isExtension() && typeof location !== "undefined";
  return {
    apiBase: onWeb ? location.origin : "http://127.0.0.1:8000",
    token: "",
    sync: false,
  };
}

export async function loadSettings() {
  const defaults = defaultSettings();
  if (isExtension()) {
    const stored = await chrome.storage.local.get(KEY);
    const settings = { ...defaults, ...(stored[KEY] || {}) };
    try {
      const url = new URL(settings.apiBase);
      if (["127.0.0.1", "localhost"].includes(url.hostname) && Number(url.port) === 38_471) {
        settings.apiBase = defaults.apiBase;
        await chrome.storage.local.set({ [KEY]: settings });
      }
    } catch {
      settings.apiBase = defaults.apiBase;
    }
    return settings;
  }
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return defaults;
  }
}

export async function saveSettings(next) {
  const settings = { ...defaultSettings(), ...next };
  if (isExtension()) {
    await chrome.storage.local.set({ [KEY]: settings });
    return settings;
  }
  localStorage.setItem(KEY, JSON.stringify(settings));
  return settings;
}
