(() => {
  const url = location.hash.slice(1);
  const button = document.querySelector("#download");
  const status = document.querySelector("#status");
  document.querySelector("#source").textContent = url;
  if (!HotContainerQualities.isAllowedUrl(url) || !/\.m3u8(?:[?#]|$)/i.test(url)) {
    status.textContent = "Neplatný alebo nepodporovaný HLS odkaz.";
    return;
  }
  button.disabled = false;
  const copy = document.querySelector("#copy");
  copy.disabled = false;
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      status.textContent = "Priama URL skopírovaná.";
    } catch {
      status.textContent = "Kopírovanie sa nepodarilo. Skús Kopírovať URL znova.";
    }
  });
  status.textContent = "Pripravené. Klikni na Stiahnuť MP4.";
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "Pripravujem sťahovanie…";
    try {
      const result = await chrome.runtime.sendMessage({
        type: "hotcontainer-download", url,
        title: document.querySelector("#name").value.trim() || "HotContainer video",
      });
      if (!result?.ok) throw new Error(result?.error || "Sťahovanie sa nepodarilo spustiť.");
      status.textContent = `${result.method === "chrome" ? "Chrome" : "IDM"} prevzal sťahovanie MP4. Priebeh skontroluj v sťahovaniach.`;
      button.textContent = "Stiahnuť znova";
    } catch (error) {
      status.textContent = error.message;
      button.textContent = "Skúsiť znova";
    } finally {
      button.disabled = false;
    }
  });
})();
