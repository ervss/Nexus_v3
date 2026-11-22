// Background service worker for Nexus Thread Link Hunter

// Open dashboard when the extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  // Pass active tab details so the dashboard knows what to scrape
  const url = encodeURIComponent(tab.url || "");
  const dashboardUrl = chrome.runtime.getURL(`dashboard.html?tabId=${tab.id}&url=${url}`);
  
  chrome.tabs.create({ url: dashboardUrl });
});

// Handle requests from Content Scripts and Dashboard
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "fetchPage") {
    // Background worker has elevated permissions to fetch any url (avoiding CORS)
    fetch(message.url)
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.text();
      })
      .then(html => {
        sendResponse({ success: true, html: html });
      })
      .catch(error => {
        console.error("Fetch page error:", error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep message channel open for async response
  }
  
  if (message.action === "getTabUrl") {
    chrome.tabs.get(message.tabId)
      .then(tab => {
        sendResponse({ success: true, url: tab.url, title: tab.title });
      })
      .catch(err => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }
});
