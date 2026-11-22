(async () => {
  // Only the browser's standalone media document, never embedded videos on websites.
  if (!document.contentType.startsWith('video/') && document.contentType !== 'application/ogg') return;
  try {
    const response = await chrome.runtime.sendMessage({type: 'getMode'});
    if (!response?.ok || response.mode !== 'play') return;
    const video = document.querySelector('video');
    if (!video || document.querySelectorAll('video').length !== 1) return;
    const source = video.currentSrc || video.querySelector('source')?.src || video.src;
    if (source !== location.href) return;
    video.controls = true;
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    try { await video.play(); }
    catch (error) { console.info('Video Play First: prehrávanie spusti ovládačom Play.', error.message); }
  } catch (error) { console.info('Video Play First:', error.message); }
})();
