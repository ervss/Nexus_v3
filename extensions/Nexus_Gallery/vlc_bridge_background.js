// Scoped OKTAGON embed -> local Python VLC bridge.
// The source URL and cookies are delivered only to 127.0.0.1, and cookie
// values never enter console output or a file.
(() => {
    const BRIDGE = 'http://127.0.0.1:18765';
    const sessions = new Map();
    const pending = new Set();

    function isTarget(details) {
        try {
            const url = new URL(details.url);
            return details.tabId >= 0 &&
                details.initiator === 'https://embedindia.st' &&
                url.hostname.endsWith('.indianservers.st') &&
                url.pathname.endsWith('/oktagon-cs/index.m3u8');
        } catch (_) {
            return false;
        }
    }

    async function scopedCookies(mediaUrl) {
        const [embed, media] = await Promise.all([
            chrome.cookies.getAll({ url: 'https://embedindia.st/' }),
            chrome.cookies.getAll({ url: mediaUrl }),
        ]);
        const seen = new Set();
        return [...embed, ...media].filter(cookie => {
            const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).map(({ name, value, domain }) => ({ name, value, domain }));
    }

    async function startBridge(details) {
        const key = `${details.tabId}:${details.frameId}`;
        if (sessions.get(key) === details.url || pending.has(key)) return;
        pending.add(key);
        try {
            const cookies = await scopedCookies(details.url);
            const response = await fetch(`${BRIDGE}/session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sourceUrl: details.url, cookies }),
            });
            if (!response.ok) throw new Error(`Local VLC bridge returned ${response.status}`);
            const reply = await chrome.tabs.sendMessage(details.tabId, { type: 'VLC_CAPTURE_START' }, { frameId: details.frameId });
            if (!reply?.ok) throw new Error('Capture script did not start');
            sessions.set(key, details.url);
        } finally {
            pending.delete(key);
        }
    }

    chrome.webRequest.onBeforeRequest.addListener(details => {
        if (isTarget(details)) startBridge(details).catch(error => {
            console.warn('[VLC bridge]', error.message);
        });
    }, { urls: ['https://*.indianservers.st/*'] });

    chrome.tabs.onRemoved.addListener(tabId => {
        for (const key of sessions.keys()) {
            if (key.startsWith(`${tabId}:`)) sessions.delete(key);
        }
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type !== 'VLC_CAPTURE_CHUNK') return;
        if (!sender.tab?.id || !/^https:\/\/embedindia\.st\/embed\/oktagon-94-eckerlin-vs-kozma-29462(?:[?#]|$)/.test(sender.url || '')) {
            sendResponse({ ok: false, error: 'Unexpected capture sender' });
            return;
        }
        const encoded = String(message.data || '');
        if (!encoded || encoded.length > 16 * 1024 * 1024) {
            sendResponse({ ok: false, error: 'Invalid capture chunk' });
            return;
        }
        (async () => {
            const binary = atob(encoded);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const response = await fetch(`${BRIDGE}/ingest`, {
                method: 'POST',
                headers: { 'Content-Type': 'video/webm' },
                body: bytes,
            });
            if (!response.ok) throw new Error(`Local VLC bridge returned ${response.status}`);
            return { ok: true };
        })().then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
        return true;
    });
})();
