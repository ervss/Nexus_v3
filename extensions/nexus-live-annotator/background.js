const OFFSCREEN_URL = "offscreen.html";

function safeName(value) {
  return String(value || "page")
    .replace(/^https?:\/\//i, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "page";
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function toggleAnnotator(tab) {
  if (!tab?.id || !/^https?:/i.test(tab.url || "")) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "NLA_TOGGLE" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["export.js", "content.js"],
    });
    await chrome.tabs.sendMessage(tab.id, { type: "NLA_TOGGLE" });
  }
}

chrome.action.onClicked.addListener(toggleAnnotator);

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-annotator") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await toggleAnnotator(tab);
});

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["CLIPBOARD"],
    justification: "Copy the user-created annotated PNG to the clipboard.",
  });
}

async function copyPng(dataUrl) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({
    type: "NLA_OFFSCREEN_COPY_PNG",
    dataUrl,
  });
}

async function openClipboardHelper(dataUrl, metadata) {
  await chrome.storage.session.set({
    nexusLiveAnnotatorPendingClipboard: {
      dataUrl,
      metadata,
      createdAt: new Date().toISOString(),
    },
  });

  await chrome.windows.create({
    url: chrome.runtime.getURL("clipboard.html"),
    type: "popup",
    width: 720,
    height: 760,
    focused: true,
  });
}

async function saveAnnotation(dataUrl, metadata) {
  const now = new Date();
  const base = `nexus-annotation-${safeName(metadata?.host)}-${timestampSlug(now)}`;
  const pngFilename = `Nexus Annotations/${base}.png`;
  const jsonFilename = `Nexus Annotations/${base}.json`;

  await chrome.downloads.download({
    url: dataUrl,
    filename: pngFilename,
    saveAs: false,
  });

  const payload = {
    ...metadata,
    savedAt: now.toISOString(),
    pngFilename,
  };
  const jsonUrl = `data:application/json;charset=utf-8,${encodeURIComponent(
    JSON.stringify(payload, null, 2),
  )}`;
  await chrome.downloads.download({
    url: jsonUrl,
    filename: jsonFilename,
    saveAs: false,
  });

  await chrome.storage.local.set({
    nexusLiveAnnotatorLatest: {
      ...payload,
      jsonFilename,
    },
  });

  let copied = false;
  let copyError = "";
  let manualCopyOpened = false;
  try {
    const result = await copyPng(dataUrl);
    copied = Boolean(result?.ok && result?.verified);
    copyError = result?.error || "";
  } catch (error) {
    copyError = error?.message || String(error);
  }

  if (!copied) {
    try {
      await openClipboardHelper(dataUrl, payload);
      manualCopyOpened = true;
    } catch (error) {
      const helperError = error?.message || String(error);
      copyError = [copyError, helperError].filter(Boolean).join(" | ");
    }
  }

  return {
    pngFilename,
    jsonFilename,
    copied,
    copyError,
    manualCopyOpened,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "NLA_CAPTURE_VISIBLE") {
    (async () => {
      if (!sender.tab?.id || sender.tab.windowId == null) {
        throw new Error("Screenshot môže vyžiadať iba karta so zapnutým anotátorom.");
      }
      const [activeTab] = await chrome.tabs.query({ active: true, windowId: sender.tab.windowId });
      if (activeTab?.id !== sender.tab.id) {
        throw new Error("Vráť sa na anotovanú kartu a ulož anotáciu znova.");
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab?.windowId, {
        format: "png",
      });
      const [stillActive] = await chrome.tabs.query({ active: true, windowId: sender.tab.windowId });
      if (stillActive?.id !== sender.tab.id) {
        throw new Error("Počas screenshotu sa zmenila karta. Vráť sa a ulož anotáciu znova.");
      }
      sendResponse({ ok: true, dataUrl });
    })().catch((error) => {
      const detail = error?.message || String(error);
      const permissionError = detail.includes("activeTab") || detail.includes("<all_urls>");
      sendResponse({ ok: false, error: permissionError
        ? "Klikni na ikonu Nexus Live Annotator v lište Chrome, potom ulož anotáciu znova. Screenshot potrebuje oprávnenie aktívnej karty."
        : detail });
    });
    return true;
  }

  if (message?.type === "NLA_SAVE_ANNOTATION") {
    (async () => {
      try {
        const result = await saveAnnotation(message.dataUrl, message.metadata);
        sendResponse({ ok: true, ...result });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();
    return true;
  }

  return undefined;
});
