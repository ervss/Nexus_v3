(() => {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const requestedCount = Number.parseInt(params.get('per') || '100', 10);
  const fetchCount = Number.isFinite(requestedCount) && requestedCount > 0 ? requestedCount : 100;
  const BUTTON_SELECTOR = '.bae-fetch';
  const STARTED_ATTRIBUTE = 'data-nexus-auto-fetch-started';
  const deadline = Date.now() + 30000;
  let observer = null;
  let timer = null;

  function stop() {
    observer?.disconnect();
    if (timer) window.clearTimeout(timer);
    observer = null;
    timer = null;
  }

  function startFetch() {
    const button = document.querySelector(BUTTON_SELECTOR);
    const countInput = document.querySelector('.bae-fetch-count');
    if (!button || !countInput || button.hasAttribute(STARTED_ATTRIBUTE)) return false;

    button.setAttribute(STARTED_ATTRIBUTE, '1');
    countInput.value = String(fetchCount);
    button.click();
    stop();
    return true;
  }

  function tryStart() {
    if (startFetch() || Date.now() >= deadline) {
      stop();
      return;
    }
    timer = window.setTimeout(tryStart, 250);
  }

  observer = new MutationObserver(tryStart);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  tryStart();
})();
