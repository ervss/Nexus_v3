// Nexus Universal Video Importer - Background Service Worker
try { importScripts('lib/nexus_bridge.js'); } catch { }

const capturedStreams = new Map();

async function getQualityDashboard(preferredPort = 8001) {
    const ports = [...new Set([Number(preferredPort) || 8001, 8001, 8000, 8002, 8003, 8004, 8005])];
    for (const port of ports) {
        for (const host of ['127.0.0.1', 'localhost']) {
            try {
                const response = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(700) });
                if (response.ok) return `http://${host}:${port}`;
            } catch (_) { /* try the next local Nexus address */ }
        }
    }
    return `http://127.0.0.1:${Number(preferredPort) || 8001}`;
}

async function qualityApiHeaders(json = false) {
    const headers = json ? { 'Content-Type': 'application/json' } : {};
    try {
        const stored = await chrome.storage.local.get(['nexus_bridge_token', 'bridge_token', 'nexusBridgeToken']);
        const token = String(stored?.nexus_bridge_token || stored?.bridge_token || stored?.nexusBridgeToken || '').trim();
        if (token) headers['X-Nexus-Token'] = token;
    } catch (_) { /* bridge token is optional unless Nexus is configured to require it */ }
    return headers;
}

async function qualityApiRequest(path, options = {}, baseUrl = '') {
    const { json = false, port = 8001, timeout = 15000, ...fetchOptions } = options;
    const base = baseUrl || await getQualityDashboard(port);
    const response = await fetch(`${base}/api/v1/quality-hunt${path}`, {
        ...fetchOptions,
        headers: await qualityApiHeaders(json),
        signal: AbortSignal.timeout(timeout),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `Nexus API: HTTP ${response.status}`);
    return { data, baseUrl: base };
}

// Listen for video streams
chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        const url = details.url;
        const tabId = details.tabId;
        
        if (tabId < 0) return;

        // Filter for video formats and exclude obvious ads
        if (url.includes('.m3u8') || url.includes('.mp4') || url.includes('.mpd')) {
            if (!url.includes('ads') && !url.includes('telemetry') && !url.includes('analytics')) {
                let finalUrl = url;
                
                // Detect JW Player ping URLs with hidden manifest in 'mu' parameter
                if (url.includes('ping.gif') && url.includes('mu=')) {
                    try {
                        const muMatch = url.match(/[?&]mu=([^&]+)/);
                        if (muMatch) {
                            finalUrl = decodeURIComponent(muMatch[1]);
                            console.log(`[Nexus] Extracted real manifest from ping URL: ${finalUrl}`);
                        }
                    } catch (e) {
                        console.error('[Nexus] Failed to parse ping URL', e);
                    }
                }

                console.log(`[Nexus] Captured stream: ${finalUrl} for tab ${tabId}`);
                capturedStreams.set(tabId, finalUrl);
            }
        }
    },
    { urls: ["<all_urls>"] }
);

// Clean up on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
    capturedStreams.delete(tabId);
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const tabId = sender.tab?.id;

    if (request.type === 'QUALITY_HUNT_START') {
        qualityApiRequest('', {
            method: 'POST',
            body: JSON.stringify(request.payload || {}),
            json: true,
            port: request.port,
            timeout: 15000,
        }).then(result => sendResponse({ ok: true, ...result })).catch(error => sendResponse({ ok: false, error: error.message }));
        return true;
    }

    if (request.type === 'QUALITY_HUNT_POLL') {
        const jobId = String(request.jobId || '').trim();
        if (!jobId) {
            sendResponse({ ok: false, error: 'Chýba ID hľadania.' });
            return false;
        }
        qualityApiRequest(`/${encodeURIComponent(jobId)}`, { timeout: 15000 }, request.baseUrl || '')
            .then(result => sendResponse({ ok: true, ...result })).catch(error => sendResponse({ ok: false, error: error.message }));
        return true;
    }

    if (request.type === 'QUALITY_HUNT_CANCEL') {
        const jobId = String(request.jobId || '').trim();
        if (!jobId) {
            sendResponse({ ok: false, error: 'Chýba ID hľadania.' });
            return false;
        }
        qualityApiRequest(`/${encodeURIComponent(jobId)}/cancel`, {
            method: 'POST',
            timeout: 10000,
        }, request.baseUrl || '').then(result => sendResponse({ ok: true, ...result })).catch(error => sendResponse({ ok: false, error: error.message }));
        return true;
    }

    if (request.type === 'GET_CAPTURED_STREAM') {
        const streamUrl = capturedStreams.get(tabId);
        sendResponse({ streamUrl });
    }

    if (request.type === 'FETCH_PLAYLIST') {
        fetch(request.url)
            .then(res => res.text())
            .then(text => sendResponse({ text }))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }

    if (request.type === 'IMPORT_VIDEO') {
        const { streamUrl, port, metadata } = request;
        const targetUrl = `http://localhost:${port}/api/v1/import/bulk`;

        console.log(`[Nexus] Importing to port ${port}: ${streamUrl}`);

        fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                batch_name: "Extension Import",
                videos: [{
                    url: streamUrl,
                    title: metadata.title || 'Imported Video',
                    source_url: metadata.sourceUrl,
                    duration: metadata.duration,
                    thumbnail: metadata.thumbnail
                }]
            })
        })
        .then(async (res) => {
            const data = await res.json();
            if (res.ok) {
                sendResponse({ success: true, data });
            } else {
                sendResponse({ success: false, error: data.detail || `Server error ${res.status}` });
            }
        })
        .catch(err => {
            console.error(`[Nexus] Import failed:`, err);
            sendResponse({ success: false, error: 'Dashboard unreachable. Is it running on port ' + port + '?' });
        });

        return true; // Async
    }

    if (request.type === 'VK_ADD_SOURCE') {
        const { source, port } = request;
        const targetUrl = `http://localhost:${port || 8001}/api/vk/import-sources`;
        fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([source])
        })
        .then(res => res.json())
        .then(data => sendResponse({ success: true, data }))
        .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }
});
