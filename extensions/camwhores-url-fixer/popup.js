const STORAGE_KEY = "cwUrlFixerEnabled";
const LOCALE_STORAGE_KEY = "cwStripLocaleEnabled";
const BYPASS_MODE_STORAGE_KEY = "cwBypassMode";

const checkbox = document.getElementById("enabled");
const localeCheckbox = document.getElementById("stripLocale");
const bypassSelect = document.getElementById("bypassMode");
const statusEl = document.getElementById("status");

function setStatus(on, stripLocale, bypassMode) {
  if (!on) {
    statusEl.textContent = "Off — no automatic redirects.";
    statusEl.className = "off";
    return;
  }
  const bypassNote = bypassMode === "off"
    ? "Speedy-Links direct."
    : bypassMode === "auto"
      ? "Speedy-Links auto-rotates bypass.city ↔ bypass.vip; Linkvertise dynamic?r= decoded locally."
      : `Speedy-Links via ${bypassMode}; Linkvertise dynamic?r= decoded locally.`;
  statusEl.textContent = stripLocale
    ? `On — mirrors + locale stripped. ${bypassNote}`
    : `On — mirrors normalized. ${bypassNote}`;
  statusEl.className = "on";
}

async function load() {
  const values = await chrome.storage.sync.get({
    [STORAGE_KEY]: true,
    [LOCALE_STORAGE_KEY]: true,
    [BYPASS_MODE_STORAGE_KEY]: "auto"
  });
  const on = values[STORAGE_KEY] !== false;
  const stripLocale = values[LOCALE_STORAGE_KEY] !== false;
  const bypassMode = String(values[BYPASS_MODE_STORAGE_KEY] || "auto");

  checkbox.checked = on;
  localeCheckbox.checked = stripLocale;
  localeCheckbox.disabled = !on;
  if (bypassSelect) {
    bypassSelect.value = bypassMode;
    bypassSelect.disabled = !on;
  }
  setStatus(on, stripLocale, bypassMode);
}

checkbox.addEventListener("change", async () => {
  const on = checkbox.checked;
  await chrome.storage.sync.set({ [STORAGE_KEY]: on });
  localeCheckbox.disabled = !on;
  if (bypassSelect) bypassSelect.disabled = !on;
  setStatus(on, localeCheckbox.checked, bypassSelect ? bypassSelect.value : "auto");
});

localeCheckbox.addEventListener("change", async () => {
  const stripLocale = localeCheckbox.checked;
  await chrome.storage.sync.set({ [LOCALE_STORAGE_KEY]: stripLocale });
  setStatus(checkbox.checked, stripLocale, bypassSelect ? bypassSelect.value : "auto");
});

if (bypassSelect) {
  bypassSelect.addEventListener("change", async () => {
    const bypassMode = bypassSelect.value || "auto";
    await chrome.storage.sync.set({ [BYPASS_MODE_STORAGE_KEY]: bypassMode });
    setStatus(checkbox.checked, localeCheckbox.checked, bypassMode);
  });
}

load();
