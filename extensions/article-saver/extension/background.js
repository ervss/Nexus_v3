chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== "save_article") return;
  chrome.runtime.sendNativeMessage(
    "com.article_saver.trafilatura",
    {url: request.url, html: request.html},
    (reply) => {
      if (chrome.runtime.lastError) {
        sendResponse({error: "Native host: " + chrome.runtime.lastError.message});
      } else {
        sendResponse(reply || {error: "Native host nevrátil odpoveď."});
      }
    }
  );
  return true;
});
