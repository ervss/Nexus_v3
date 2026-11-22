// Offscreen dokument zabezpečuje spoľahlivé kopírovanie URL do schránky v MV3 service workeri.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen" || message?.type !== "copy-to-clipboard") {
    return false;
  }

  const textarea = document.getElementById("clipboard-buffer");
  textarea.value = String(message.text || "");
  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }

  textarea.value = "";
  sendResponse({ copied });
  return false;
});
