const hint = document.querySelector("#hint");
const select = document.querySelector("#videos");
const add = document.querySelector("#add");
const play = document.querySelector("#play");
let videos = [];
let sourceTab = null;

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  sourceTab = tab;
  try { videos = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_VIDEOS" }) || []; } catch { videos = []; }
  hint.textContent = videos.length ? `${videos.length} video${videos.length === 1 ? "" : "s"} found on this page.` : "No HTML video found. Right-click a playing video instead.";
  videos.forEach((video, index) => select.add(new Option(`${index + 1}. ${video.title}`, index)));
  select.disabled = add.disabled = play.disabled = !videos.length;
}
async function addVideo(playNow) {
  if (!sourceTab?.id) return;
  // Invoke open in the click handler, before storage/network awaits consume
  // Chrome's user gesture. The native panel uses the extension's own origin.
  const opened = chrome.sidePanel.open({ tabId: sourceTab.id })
    .then(() => ({ ok: true }), error => ({ ok: false, error: error.message }));
  add.disabled = play.disabled = true;
  (playNow ? play : add).textContent = playNow ? "Opening…" : "Adding…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "ADD_VIDEO", candidate: videos[Number(select.value)], playNow, nativePanel: true, tabId: sourceTab.id });
    const panel = await opened;
    if (!result?.ok) throw new Error(result?.error || "The video could not be added.");
    if (!panel.ok) throw new Error(panel.error || "The side panel could not be opened.");
    window.close();
  } catch (error) {
    hint.textContent = error.message || "Could not open Sidecar. Try again.";
    add.disabled = play.disabled = false;
    add.textContent = "Add to playlist";
    play.textContent = "Play now";
  }
}
add.addEventListener("click", () => addVideo(false));
play.addEventListener("click", () => addVideo(true));
init();
