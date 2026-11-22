const preview = document.querySelector("#preview");
const copyButton = document.querySelector("#copy");
const status = document.querySelector("#status");
let pending = null;

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

async function digest(blob) {
  const bytes = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function loadPending() {
  const stored = await chrome.storage.session.get(
    "nexusLiveAnnotatorPendingClipboard",
  );
  pending = stored.nexusLiveAnnotatorPendingClipboard;
  if (!pending?.dataUrl) {
    copyButton.disabled = true;
    setStatus("Nenašiel som nový screenshot. Ulož anotáciu ešte raz.", true);
    return;
  }
  preview.src = pending.dataUrl;
}

copyButton.addEventListener("click", async () => {
  if (!pending?.dataUrl) return;
  copyButton.disabled = true;
  setStatus("Kopírujem a overujem…");
  try {
    const response = await fetch(pending.dataUrl);
    const blob = await response.blob();
    const expectedHash = await digest(blob);
    await navigator.clipboard.write([
      new ClipboardItem({
        "image/png": blob,
      }),
    ]);

    const clipboardItems = await navigator.clipboard.read();
    const pngItem = clipboardItems.find((item) =>
      item.types.includes("image/png"),
    );
    if (!pngItem) throw new Error("Schránka neobsahuje PNG.");
    const clipboardBlob = await pngItem.getType("image/png");
    const actualHash = await digest(clipboardBlob);
    if (actualHash !== expectedHash) {
      throw new Error("Chrome vrátil iný obrázok.");
    }

    await chrome.storage.session.remove(
      "nexusLiveAnnotatorPendingClipboard",
    );
    setStatus("Hotovo — nový PNG je overene v schránke. Teraz Ctrl+V v ChatGPT.");
    copyButton.textContent = "Skopírované ✓";
  } catch (error) {
    copyButton.disabled = false;
    setStatus(
      `Kopírovanie zlyhalo: ${error?.message || String(error)}`,
      true,
    );
  }
});

loadPending().catch((error) => {
  copyButton.disabled = true;
  setStatus(`Načítanie zlyhalo: ${error?.message || String(error)}`, true);
});
