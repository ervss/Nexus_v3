(function () {
    if (window !== window.top) return;

    // ── Intercept bunkr's own /api/sign fetch to capture the signed CDN URL ──
    // Bunkr pages call fetch('/api/sign?v=<id>') to get a signed mp4 URL.
    // We intercept the response and send it to the background for IMPORT_VIDEO.
    (function patchFetch() {
        const _fetch = window.fetch;
        window.fetch = async function(...args) {
            const result = await _fetch.apply(this, args);
            try {
                const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
                if (url.includes('/api/sign')) {
                    const clone = result.clone();
                    clone.json().then(data => {
                        if (data?.success && data?.url) {
                            chrome.runtime.sendMessage({
                                action: 'BUNKR_SIGNED_URL',
                                signedUrl: data.url,
                                filename: data.filename || data.original_filename || '',
                                pageUrl: window.location.href,
                            }).catch(() => {});
                        }
                    }).catch(() => {});
                }
            } catch {}
            return result;
        };
    })();

    const CHANNEL = 'NEXUS_BAE_BRIDGE';
    const VERSION = 1;
    const PAGE_SOURCE = 'bae-userscript';
    const EXT_SOURCE = 'nexus-extension';
    const VALID_PAGE_TYPES = new Set([
        'BAE_BRIDGE_READY',
        'BAE_STATE',
        'BAE_SELECTION',
        'BAE_CACHE_EXPORT',
        'BAE_FETCH_PROGRESS',
        'BAE_OK',
        'BAE_ERROR',
    ]);

    function isObject(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    function isValidEnvelope(message, expectedSource) {
        return !!(
            isObject(message) &&
            message.channel === CHANNEL &&
            message.version === VERSION &&
            message.source === expectedSource &&
            typeof message.type === 'string' &&
            typeof message.requestId === 'string' &&
            message.requestId.trim() &&
            typeof message.ts === 'number' &&
            isObject(message.payload)
        );
    }

    function relayToPage(message) {
        window.postMessage(message, window.location.origin);
    }

    window.addEventListener('message', (event) => {
        // In some Chromium contexts postMessage can arrive with source === null
        // for extension/page bridges. Accept both window and null.
        if (event.source !== window && event.source !== null) return;
        if (event.origin && event.origin !== window.location.origin) return;
        const message = event.data;
        if (message?.type === 'NEXUS_GALLERY_SIDECAR_ENQUEUE') {
            const requestId = String(message.requestId || '');
            const items = Array.isArray(message.items) ? message.items : [];
            chrome.runtime.sendMessage({
                action: 'NEXUS_SEND_TO_SIDECAR',
                items,
                resolveBunkr: true,
                sourcePageUrl: String(message.sourcePageUrl || window.location.href),
            }).then((result) => {
                window.postMessage({ type: 'NEXUS_GALLERY_SIDECAR_RESULT', requestId, result }, window.location.origin);
            }).catch((error) => {
                window.postMessage({
                    type: 'NEXUS_GALLERY_SIDECAR_RESULT',
                    requestId,
                    result: { ok: false, error: error?.message || String(error) },
                }, window.location.origin);
            });
            return;
        }
        if (!isValidEnvelope(message, PAGE_SOURCE)) return;
        if (!VALID_PAGE_TYPES.has(message.type)) return;
        chrome.runtime.sendMessage({
            action: 'BAE_BRIDGE_PAGE_MESSAGE',
            message,
        }).catch((error) => {
            try {
                console.error('[BAE Bridge Content] Failed to relay page message to background:', error?.message || error);
            } catch {}
        });
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || message.action !== 'BAE_BRIDGE_DELIVER_TO_PAGE') return;
        const envelope = message.envelope;
        if (!isValidEnvelope(envelope, EXT_SOURCE)) {
            sendResponse({ ok: false, error: 'invalid-envelope' });
            return false;
        }
        relayToPage(envelope);
        sendResponse({ ok: true });
        return false;
    });
})();
