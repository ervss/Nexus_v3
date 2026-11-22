// Runs only in the OKTAGON embed frame. The Python bridge opens VLC after its
// first valid WebM chunk; this frame keeps the signed source inside Chrome.
(() => {
    let recorder = null;
    let watchedVideo = null;
    let healthTimer = null;
    let startupTimer = null;
    let waitingTimer = null;
    let reloadTimer = null;
    let sendChain = Promise.resolve();
    let generation = 0;

    function stopCapture() {
        generation++;
        clearInterval(healthTimer);
        clearInterval(waitingTimer);
        clearTimeout(startupTimer);
        if (watchedVideo) watchedVideo.removeEventListener('error', onVideoError);
        if (recorder && recorder.state !== 'inactive') recorder.stop();
        recorder = null;
        watchedVideo = null;
    }

    function scheduleFreshToken(reason) {
        if (reloadTimer) return;
        stopCapture();
        const now = Date.now();
        let retry = {};
        try { retry = JSON.parse(sessionStorage.getItem('nexusVlcRefresh') || '{}'); } catch (_) {}
        const count = now - Number(retry.at || 0) > 120000 ? 1 : Number(retry.count || 0) + 1;
        sessionStorage.setItem('nexusVlcRefresh', JSON.stringify({ count, at: now }));
        const delay = Math.min(30000, 1000 * (2 ** Math.min(count - 1, 5)));
        console.warn(`[VLC bridge] ${reason}; refreshing embed for a new token in ${delay}ms`);
        reloadTimer = setTimeout(() => location.reload(), delay);
    }

    function onVideoError() {
        scheduleFreshToken('Video playback error');
    }

    function toBase64(bytes) {
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return btoa(binary);
    }

    async function sendChunk(blob) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const reply = await chrome.runtime.sendMessage({
            type: 'VLC_CAPTURE_CHUNK',
            data: toBase64(bytes),
        });
        if (!reply?.ok) throw new Error(reply?.error || 'Local VLC relay rejected a chunk');
    }

    function beginRecording(video) {
        if (typeof video.captureStream !== 'function') throw new Error('Browser video capture is unavailable');
        const stream = video.captureStream();
        if (!stream.getVideoTracks().length) throw new Error('No video track is available');
        const preferred = 'video/webm;codecs=vp8,opus';
        const mimeType = MediaRecorder.isTypeSupported(preferred) ? preferred : 'video/webm';
        recorder = new MediaRecorder(stream, {
            mimeType,
            videoBitsPerSecond: 1800000,
            audioBitsPerSecond: 96000,
        });
        recorder.addEventListener('error', event => {
            scheduleFreshToken(`Recording error: ${event.error?.message || 'unknown'}`);
        });
        const recordingGeneration = generation;
        recorder.addEventListener('dataavailable', event => {
            if (!event.data?.size || recordingGeneration !== generation) return;
            sendChain = sendChain.then(() => recordingGeneration === generation ? sendChunk(event.data) : undefined).catch(error => {
                scheduleFreshToken(`Capture relay error: ${error.message}`);
            });
        });
        recorder.start(1000);
        watchedVideo = video;
        video.addEventListener('error', onVideoError);
        let lastTime = video.currentTime;
        let lastProgress = Date.now();
        healthTimer = setInterval(() => {
            if (video.error) return scheduleFreshToken('Video decode error');
            if (video.currentTime > lastTime + 0.1) {
                lastTime = video.currentTime;
                lastProgress = Date.now();
                try {
                    if (Date.now() - Number(JSON.parse(sessionStorage.getItem('nexusVlcRefresh') || '{}').at || 0) > 30000)
                        sessionStorage.removeItem('nexusVlcRefresh');
                } catch (_) { sessionStorage.removeItem('nexusVlcRefresh'); }
            } else if (Date.now() - lastProgress > 15000) {
                scheduleFreshToken('No video progress');
            }
        }, 3000);
    }

    function startAfterVerification() {
        stopCapture();
        const started = Date.now();
        waitingTimer = setInterval(() => {
            const video = document.querySelector('video.jw-video') || document.querySelector('video[data-html5-video]');
            if (video && video.paused && video.readyState >= 2) video.play().catch(() => {});
            if (video && video.readyState >= 3 && video.videoWidth > 0 && !video.paused) {
                clearInterval(waitingTimer);
                clearTimeout(startupTimer);
                try { beginRecording(video); }
                catch (error) { scheduleFreshToken(`Capture setup failed: ${error.message}`); }
            } else if (Date.now() - started > 25000) {
                clearInterval(waitingTimer);
                scheduleFreshToken('Signed source failed playback verification');
            }
        }, 500);
        startupTimer = setTimeout(() => clearInterval(waitingTimer), 30000);
    }

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.type === 'VLC_CAPTURE_START') {
            startAfterVerification();
            sendResponse({ ok: true });
        }
    });
})();
