chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "NLA_OFFSCREEN_COPY_PNG") return undefined;

  (async () => {
    const response = await fetch(message.dataUrl);
    const blob = await response.blob();
    const expectedHash = await digest(blob);
    await navigator.clipboard.write([
      new ClipboardItem({
        "image/png": blob,
      }),
    ]);
    const clipboardItems = await navigator.clipboard.read();
    const pngItem = clipboardItems.find((item) => item.types.includes("image/png"));
    if (!pngItem) {
      throw new Error("Chrome po zápise nevrátil PNG zo schránky.");
    }
    const clipboardBlob = await pngItem.getType("image/png");
    const actualHash = await digest(clipboardBlob);
    if (actualHash !== expectedHash) {
      throw new Error("Obsah schránky sa nezhoduje s novým screenshotom.");
    }
    sendResponse({ ok: true, verified: true });
  })().catch((error) => {
    sendResponse({
      ok: false,
      verified: false,
      error: error?.message || String(error),
    });
  });

  return true;
});

async function digest(blob) {
  const bytes = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
