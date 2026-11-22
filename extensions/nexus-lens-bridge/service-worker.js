const JOB_PREFIX = 'lens-job:';

function isGoogleLensFlow(url = '') {
  return /^https:\/\/(lens\.google\.com|www\.google\.(com|sk))\//.test(url);
}

async function notifyDashboard(jobId, status, message) {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs
    .filter((tab) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(tab.url || ''))
    .map((tab) => chrome.tabs.sendMessage(tab.id, {
      type: 'NEXUS_LENS_UPDATE', jobId, status, message,
    })));
}

function bytesToDataUrl(bytes, contentType = 'image/jpeg') {
  let binary = '';
  const view = new Uint8Array(bytes);
  const chunk = 0x8000;
  for (let index = 0; index < view.length; index += chunk) {
    binary += String.fromCharCode(...view.subarray(index, index + chunk));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

async function saveJob(job) {
  await chrome.storage.session.set({ [JOB_PREFIX + job.tabId]: job });
}

async function loadJob(tabId) {
  return (await chrome.storage.session.get(JOB_PREFIX + tabId))[JOB_PREFIX + tabId] || null;
}

async function removeJob(tabId) {
  await chrome.storage.session.remove(JOB_PREFIX + tabId);
}

async function sendJobToLens(tabId, attempts = 0) {
  const job = await loadJob(tabId);
  if (!job) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'NEXUS_LENS_JOB',
      payload: { ...job, phase: job.phase || 'upload' },
    });
  } catch (error) {
    if (attempts < 12) {
      setTimeout(() => sendJobToLens(tabId, attempts + 1), 500);
    } else {
      await notifyDashboard(job.jobId, 'needs_user', 'Lens tab sa otvoril, ale extension sa k nemu nepripojila.');
    }
  }
}

async function postResults(job, status, results = [], error = '') {
  const response = await fetch(job.resultsUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CBIR-Job-Token': job.token,
    },
    body: JSON.stringify({ status, results, error }),
  });
  if (!response.ok) throw new Error(`Nexus result upload HTTP ${response.status}`);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'NEXUS_LENS_START') return false;
  (async () => {
    const payload = message.payload || {};
    if (!payload.jobId || !payload.imageUrl || !payload.resultsUrl || !payload.token) {
      throw new Error('Browser Assist job is incomplete');
    }
    await notifyDashboard(payload.jobId, 'loading_image', 'Načítavam náhľad z Nexusu…');
    const imageResponse = await fetch(payload.imageUrl, { cache: 'no-store' });
    if (!imageResponse.ok) throw new Error(`Nexus image HTTP ${imageResponse.status}`);
    const imageDataUrl = bytesToDataUrl(
      await imageResponse.arrayBuffer(),
      imageResponse.headers.get('content-type') || 'image/jpeg',
    );
    const tab = await chrome.tabs.create({
      // Google moved the desktop upload surface from lens.google.com to the
      // image-search dialog on google.com.  Opening the current endpoint
      // avoids losing the content script during the redirect.
      url: 'https://www.google.com/?olud',
      active: !payload.background,
    });
    const job = {
      ...payload,
      imageDataUrl,
      tabId: tab.id,
      phase: 'upload',
      createdAt: Date.now(),
    };
    await saveJob(job);
    await notifyDashboard(payload.jobId, 'opening_lens', payload.background ? 'Lens beží v neaktívnom tabe…' : 'Lens sa otvoril v novom tabe…');
    await sendJobToLens(tab.id);
    sendResponse({ ok: true, tabId: tab.id });
  })().catch(async (error) => {
    await notifyDashboard(message.payload?.jobId || '', 'error', error?.message || String(error));
    sendResponse({ ok: false, error: error?.message || String(error) });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message?.type?.startsWith('NEXUS_LENS_') || !sender.tab?.id) return;
  (async () => {
    const job = await loadJob(sender.tab.id);
    if (!job) return;
    if (message.type === 'NEXUS_LENS_UPLOADED') {
      job.phase = 'collect';
      await saveJob(job);
      await notifyDashboard(job.jobId, 'collecting', 'Lens spracúva obrázok a zbiera výsledky…');
      return;
    }
    if (message.type === 'NEXUS_LENS_NEEDS_USER') {
      await postResults(job, 'needs_user', message.results || [], message.error || 'Lens vyžaduje manuálnu akciu.');
      if (job.background) await chrome.tabs.update(sender.tab.id, { active: true });
      await notifyDashboard(job.jobId, 'needs_user', message.error || 'Dokonči akciu v otvorenom Lens tabe.');
      return;
    }
    if (message.type === 'NEXUS_LENS_RESULTS') {
      await postResults(job, 'complete', message.results || [], '');
      await notifyDashboard(job.jobId, 'complete', `Lens našiel ${(message.results || []).length} výsledkov.`);
      if (job.background) await chrome.tabs.remove(sender.tab.id).catch(() => {});
      await removeJob(sender.tab.id);
    }
  })().catch(async (error) => {
    const job = await loadJob(sender.tab.id);
    if (job) {
      await postResults(job, 'error', [], error?.message || String(error)).catch(() => {});
      await notifyDashboard(job.jobId, 'error', error?.message || String(error));
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && isGoogleLensFlow(tab.url || '')) {
    sendJobToLens(tabId).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  loadJob(tabId).then(async (job) => {
    if (!job) return;
    await postResults(job, 'needs_user', [], 'Lens tab bol zatvorený pred dokončením.').catch(() => {});
    await notifyDashboard(job.jobId, 'needs_user', 'Lens tab bol zatvorený pred dokončením.');
    await removeJob(tabId);
  });
});
