// content.js - Prepojenie knižnice NexusSplitScreen do stránky cez Chrome Extension

(function() {
  'use strict';

  const selectedElements = new Map();
  let floatBar = null;

  function ensureFloatBar() {
    if (floatBar) return floatBar;
    floatBar = document.createElement('div');
    floatBar.className = 'nss-float-bar';
    floatBar.style.cssText = `
      position: fixed; bottom: 24px; right: 24px; z-index: 2147483640;
      background: #0f172a; border: 1px solid rgba(168,85,247,.5); border-radius: 30px;
      box-shadow: 0 12px 30px rgba(0,0,0,.7); display: none; align-items: center;
      gap: 8px; padding: 6px 14px; color: #fff; font: 600 12px system-ui,sans-serif;
    `;
    floatBar.innerHTML = `
      <span class="nss-float-count">0 videí vybraných</span>
      <button class="nss-float-play" style="background:linear-gradient(135deg,#7c3aed,#db2777);border:1px solid #f472b6;color:#fff;font-weight:800;border-radius:20px;padding:5px 12px;cursor:pointer;">▶▶ Spustiť Split-Screen</button>
      <button class="nss-float-clear" style="background:none;border:none;color:#94a3b8;font-size:16px;cursor:pointer;" title="Zrušiť výber">✕</button>
    `;
    document.body.appendChild(floatBar);

    floatBar.querySelector('.nss-float-play').addEventListener('click', () => {
      const items = Array.from(selectedElements.values());
      if (window.NexusSplitScreen) {
        window.NexusSplitScreen.open(items, { diag: true });
      }
    });

    floatBar.querySelector('.nss-float-clear').addEventListener('click', () => {
      selectedElements.forEach((val, el) => el.style.outline = '');
      selectedElements.clear();
      updateFloatBar();
    });
    return floatBar;
  }

  function updateFloatBar() {
    ensureFloatBar();
    const count = selectedElements.size;
    floatBar.querySelector('.nss-float-count').textContent = `${count} ${count === 1 ? 'video vybrané' : count < 5 ? 'videá vybrané' : 'videí vybraných'}`;
    floatBar.style.display = count > 0 ? 'flex' : 'none';
  }

  // Alt + Kliknutie na video alebo odkaz
  document.addEventListener('click', (e) => {
    if (!e.altKey) return;

    const target = e.target.closest('video, a[href*=".mp4"], a[href*=".m3u8"], a[href*="/v/"], a[href*="/f/"], a[href*="watch"], .video-card, .video-item') || e.target;
    if (!target || target.closest('.nss-modal, .nss-float-bar')) return;

    e.preventDefault();
    e.stopPropagation();

    let videoUrl = '';
    let title = '';

    if (target.tagName === 'VIDEO') {
      videoUrl = target.currentSrc || target.src || target.querySelector('source')?.src;
      title = target.title || document.title;
    } else if (target.tagName === 'A') {
      videoUrl = target.href;
      title = target.innerText.trim() || target.title || 'Video link';
    } else {
      const innerV = target.querySelector('video');
      const innerA = target.querySelector('a[href]');
      if (innerV) videoUrl = innerV.currentSrc || innerV.src;
      else if (innerA) videoUrl = innerA.href;
      title = target.innerText.trim().slice(0, 40) || 'Video item';
    }

    if (!videoUrl) return;

    if (selectedElements.has(target)) {
      selectedElements.delete(target);
      target.style.outline = '';
    } else {
      selectedElements.set(target, { url: videoUrl, title });
      target.style.outline = '3px solid #22c55e';
      target.style.outlineOffset = '2px';
    }
    updateFloatBar();
  }, true);
})();
