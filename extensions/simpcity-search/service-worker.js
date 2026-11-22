const MENU_ID = 'search-simpcity-selection';

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Vyhľadať na Simpcity: "%s"',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU_ID || !info.selectionText?.trim()) return;
  await openSearch(info.selectionText);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'SEARCH_SIMPCITY') return;
  (async () => {
    try {
      await openSearch(message.query);
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  })();
  return true;
});

async function openSearch(value) {
  const query = String(value ?? '').trim();
  if (!query) throw new Error('Zadaj hľadaný výraz.');
  const encodedQuery = encodeURIComponent(query).replace(/%20/g, '+');
  // Submit through Simpcity's real search endpoint. It creates the correct
  // result id and avoids the stale cached page returned by /search/53345003/.
  const url = `https://simpcity.cr/search/search?keywords=${encodedQuery}`;
  const tab = await chrome.tabs.create({ url, active: true });
  // Simpcity/CDN can serve the previous result HTML for this endpoint.
  // A browser-level bypass-cache reload makes the page render the q in this URL.
  await chrome.tabs.reload(tab.id, { bypassCache: true });
}
