(() => {
  let activeJob = null;
  let collectTimer = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function pageLooksBlocked() {
    const text = (document.body?.innerText || '').toLowerCase();
    return /403|unusual traffic|captcha|not have access to this page|automated quer/.test(text);
  }

  function unwrapGoogleUrl(raw) {
    try {
      const url = new URL(raw, location.href);
      if (!/(^|\.)google\./.test(url.hostname)) return url.href;
      const target = url.searchParams.get('url') || url.searchParams.get('q');
      return target?.startsWith('http') ? target : '';
    } catch (_) {
      return '';
    }
  }

  function collectResults() {
    const results = [];
    const seen = new Set();
    const blockedHosts = /(google|gstatic|googleusercontent|youtube\.com|youtu\.be|wikipedia\.org|pinterest\.|amazon\.|facebook\.com|instagram\.com)/i;
    for (const anchor of document.querySelectorAll('a[href]')) {
      const url = unwrapGoogleUrl(anchor.href);
      if (!url || seen.has(url)) continue;
      let parsed;
      try { parsed = new URL(url); } catch (_) { continue; }
      const hostname = parsed.hostname.toLowerCase();
      if (blockedHosts.test(hostname)) continue;
      if (parsed.pathname === '/' && !parsed.search) continue;
      const card = anchor.closest('[data-ved], article, li, div') || anchor;
      const text = (anchor.innerText || anchor.getAttribute('aria-label') || card.innerText || '')
        .replace(/\s+/g, ' ').trim().slice(0, 180);
      if (!text || text.length < 4 || /^(feedback|privacy|terms|help|settings|skip to)$/i.test(text)) continue;
      const image = card.querySelector('img') || anchor.querySelector('img');
      const thumbnail = image?.currentSrc || image?.src || '';
      seen.add(url);
      results.push({ url, title: text, thumbnail });
      if (results.length >= 60) break;
    }
    return results;
  }

  async function finishWhenStable() {
    let lastCount = 0;
    let stableRounds = 0;
    const started = Date.now();
    while (activeJob && Date.now() - started < 45000) {
      await sleep(1500);
      if (pageLooksBlocked()) {
        chrome.runtime.sendMessage({
          type: 'NEXUS_LENS_NEEDS_USER',
          error: 'Google zobrazil 403, captcha alebo kontrolu neobvyklej aktivity.',
          results: collectResults(),
        });
        return;
      }
      const results = collectResults();
      stableRounds = results.length >= 3 && results.length === lastCount ? stableRounds + 1 : 0;
      lastCount = results.length;
      if (stableRounds >= 2) {
        chrome.runtime.sendMessage({ type: 'NEXUS_LENS_RESULTS', results });
        return;
      }
    }
    const results = collectResults();
    chrome.runtime.sendMessage(results.length
      ? { type: 'NEXUS_LENS_RESULTS', results }
      : { type: 'NEXUS_LENS_NEEDS_USER', error: 'Výsledky sa nepodarilo automaticky prečítať. Dokonči upload v Lens tabe.', results: [] });
  }

  async function uploadImage(job) {
    if (pageLooksBlocked()) {
      chrome.runtime.sendMessage({
        type: 'NEXUS_LENS_NEEDS_USER',
        error: 'Google Lens je blokovaný (403/captcha).',
        results: [],
      });
      return;
    }
    let input = null;
    for (let attempt = 0; attempt < 30 && !input; attempt += 1) {
      input = document.querySelector('input[type="file"][accept*="image"], input[type="file"]');
      if (!input) await sleep(400);
    }
    if (!input) {
      chrome.runtime.sendMessage({
        type: 'NEXUS_LENS_NEEDS_USER',
        error: 'Lens zmenil upload rozhranie. Nahraj obrázok manuálne; extension potom zozbiera výsledky.',
        results: [],
      });
      finishWhenStable();
      return;
    }
    const blob = await (await fetch(job.imageDataUrl)).blob();
    const file = new File([blob], 'nexus-related-search.jpg', { type: blob.type || 'image/jpeg' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    sessionStorage.setItem('nexusLensUploadedJob', job.jobId);
    chrome.runtime.sendMessage({ type: 'NEXUS_LENS_UPLOADED' });
    finishWhenStable();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'NEXUS_LENS_JOB' || !message.payload) return;
    activeJob = message.payload;
    clearTimeout(collectTimer);
    const alreadyUploaded = sessionStorage.getItem('nexusLensUploadedJob') === activeJob.jobId;
    if (message.payload.phase === 'collect' || alreadyUploaded) {
      collectTimer = setTimeout(finishWhenStable, 500);
    } else {
      uploadImage(activeJob).catch((error) => chrome.runtime.sendMessage({
        type: 'NEXUS_LENS_NEEDS_USER',
        error: error?.message || String(error),
        results: collectResults(),
      }));
    }
  });
})();
