(function () {
  const BTN_ID = "nexus-vk-open-gallery-btn";

  function isVkPlaylistPage() {
    const href = String(location.href || "");
    return /vkvideo\.ru\/playlist\//i.test(href) || /vk\.com\/video\/playlist\//i.test(href);
  }

  function removeButton() {
    document.getElementById(BTN_ID)?.remove();
  }

  function ensureButton() {
    if (!isVkPlaylistPage()) {
      removeButton();
      return;
    }
    if (document.getElementById(BTN_ID)) return;

    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.textContent = "Open in Gallery";
    btn.style.cssText = [
      "position:fixed",
      "right:18px",
      "top:86px",
      "z-index:2147483647",
      "padding:10px 14px",
      "border-radius:12px",
      "border:1px solid rgba(66,220,182,0.55)",
      "background:linear-gradient(135deg, rgba(8,25,31,0.96), rgba(11,44,54,0.96))",
      "color:#cffff2",
      "font:600 13px/1.1 system-ui, -apple-system, Segoe UI, sans-serif",
      "box-shadow:0 10px 28px rgba(0,0,0,0.32)",
      "cursor:pointer",
    ].join(";");
    btn.addEventListener("mouseenter", () => {
      btn.style.transform = "translateY(-1px)";
      btn.style.boxShadow = "0 14px 34px rgba(0,0,0,0.38)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.transform = "translateY(0)";
      btn.style.boxShadow = "0 10px 28px rgba(0,0,0,0.32)";
    });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const prev = btn.textContent;
      btn.textContent = "Opening...";
      try {
        const response = await chrome.runtime.sendMessage({ action: "OPEN_EXPLORER_FOR_TAB" });
        btn.textContent = response?.ok ? "Gallery opened" : "Open failed";
      } catch {
        btn.textContent = "Open failed";
      }
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = prev;
      }, 1800);
    });
    document.body.appendChild(btn);
  }

  ensureButton();
  const observer = new MutationObserver(() => ensureButton());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", ensureButton);
  window.addEventListener("hashchange", ensureButton);
})();
