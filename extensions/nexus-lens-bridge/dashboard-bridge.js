(() => {
  const VERSION = chrome.runtime.getManifest().version;

  const announce = () => window.postMessage({
    source: 'nexus-lens-bridge',
    type: 'NEXUS_LENS_READY',
    version: VERSION,
  }, '*');

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'nexus-dashboard') return;
    if (event.data.type === 'NEXUS_LENS_PING') {
      announce();
      return;
    }
    if (event.data.type !== 'NEXUS_LENS_START' || !event.data.payload) return;
    chrome.runtime.sendMessage({
      type: 'NEXUS_LENS_START',
      payload: event.data.payload,
    }).catch((error) => window.postMessage({
      source: 'nexus-lens-bridge',
      type: 'NEXUS_LENS_UPDATE',
      status: 'error',
      message: error?.message || 'Extension request failed',
    }, '*'));
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'NEXUS_LENS_UPDATE') return;
    window.postMessage({
      source: 'nexus-lens-bridge',
      type: 'NEXUS_LENS_UPDATE',
      status: message.status || '',
      message: message.message || '',
      jobId: message.jobId || '',
    }, '*');
  });

  announce();
})();
