// Intercept only address-bar/tab navigations, never player or fetch requests.
async function installDirectHlsRule() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [2405],
    addRules: [{
      id: 2405, priority: 1,
      action: { type: "redirect", redirect: {
        regexSubstitution: `${chrome.runtime.getURL("direct.html")}#\\0`,
      } },
      condition: {
        regexFilter: "^https://([a-zA-Z0-9-]+\\.)*xvideos-cdn\\.com/[^?#]*\\.m3u8(\\?[^#]*)?$",
        isUrlFilterCaseSensitive: false,
        resourceTypes: ["main_frame"],
      },
    }],
  });
}
if (chrome.declarativeNetRequest) {
  const install = () => { void installDirectHlsRule().catch(error => console.error("HLS redirect:", error)); };
  chrome.runtime.onInstalled.addListener(install);
  chrome.runtime.onStartup.addListener(install);
  install();
}
