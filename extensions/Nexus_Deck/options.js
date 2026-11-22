import { logo } from "./lib/icons.js";
import { loadSettings, saveSettings } from "./lib/settings.js";
import { createApi } from "./lib/api.js";

const $ = (id) => document.getElementById(id);
let settings = await loadSettings();
const api = createApi(async () => settings);

$("logo").innerHTML = logo;
$("api-base").value = settings.apiBase;
$("api-token").value = settings.token || "";

$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  settings = await saveSettings({
    ...settings,
    apiBase: $("api-base").value.trim(),
    token: $("api-token").value.trim(),
  });
  $("settings-msg").textContent = "Uložené. Otvorený Deck si adresu vezme sám.";
});

$("btn-test").addEventListener("click", async () => {
  const previous = settings;
  settings = {
    ...settings,
    apiBase: $("api-base").value.trim() || settings.apiBase,
    token: $("api-token").value.trim(),
  };
  try {
    await api.health();
    await api.state();
    $("settings-msg").textContent = "Spojenie je v poriadku.";
  } catch (error) {
    $("settings-msg").textContent = error.status === 401 ? "Token nesedí s dashboardom."
      : error.status === 0 ? "Dashboard neodpovedá."
        : error.message || `Server vrátil HTTP ${error.status}.`;
  } finally {
    settings = previous;
  }
});
