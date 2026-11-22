(() => {
  'use strict';
  if (window.__nvsUiGuardInstalled) return;
  window.__nvsUiGuardInstalled = true;

  const UI_SELECTOR = [
    '.nvs-wh-play',
    '.nvs-selector-wrap',
    '#nvs-wh-player',
    '#nvs-sort-panel',
    '#nvs-import-bar',
    '#nvs-scan-hud',
    '#nuss-quick-selection',
    '#nuss-fab',
    '#nuss-picker-modal',
    '#nuss-overlay',
  ].join(', ');

  const PANEL_CLICK_CONTAINER_SELECTOR = [
    '#nvs-wh-player',
    '#nvs-sort-panel',
    '#nvs-import-bar',
    '#nuss-quick-selection',
    '#nuss-fab',
    '#nuss-picker-modal',
    '#nuss-overlay',
  ].join(', ');

  const GUARDED_EVENTS = [
    'pointerdown',
    'mousedown',
    'pointerup',
    'mouseup',
    'touchstart',
    'touchend',
    'auxclick',
    'click',
  ];

  function findInPath(event, predicate) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
    if (path) {
      for (const node of path) {
        if (node instanceof Element && predicate(node)) return node;
      }
    }
    return null;
  }

  function findPlayButton(event) {
    const fromPath = findInPath(event, (node) => Boolean(node.classList && node.classList.contains('nvs-wh-play')));
    if (fromPath) return fromPath;
    const target = event.target;
    return target instanceof Element ? target.closest('.nvs-wh-play') : null;
  }

  function isNvsControl(event) {
    const target = event.target;
    if (!(target instanceof Element)) return false;
    if (target instanceof HTMLVideoElement) return false;
    return Boolean(target.closest(UI_SELECTOR));
  }

  function findGuardedPanelButton(event) {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    if (target instanceof HTMLVideoElement) return null;
    const container = target.closest(PANEL_CLICK_CONTAINER_SELECTOR);
    if (!container) return null;
    const clickable = target.closest('button, [role="button"], .nvs-wh-item');
    return clickable && container.contains(clickable) ? clickable : null;
  }

  function guardEvent(event) {
    const playBtn = findPlayButton(event);
    if (playBtn) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'click') {
        playBtn.dispatchEvent(new CustomEvent('nvs-wh-activate', { bubbles: false }));
      }
      return;
    }

    if (!isNvsControl(event)) return;

    if (event.type === 'click') {
      if (!event.isTrusted) return;
      const panelBtn = findGuardedPanelButton(event);
      if (panelBtn) {
        event.preventDefault();
        event.stopImmediatePropagation();
        panelBtn.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window,
          screenX: 0,
          screenY: 0,
          clientX: 0,
          clientY: 0,
        }));
      }
      return;
    }

    // Swallow pre-click pointer/mouse gestures on NVS/NUSS UI before page capture popunder listeners.
    event.stopImmediatePropagation();
  }

  for (const type of GUARDED_EVENTS) {
    window.addEventListener(type, guardEvent, true);
  }
})();
