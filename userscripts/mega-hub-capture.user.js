// ==UserScript==
// @name         Nexus MEGA Link Capture
// @namespace    local.codex.nexus.mega-hub-capture
// @version      1.6.0
// @description  Finds public MEGA links, non-MEGA media albums (Bunkr/Gofile/Pixeldrain/Cyberdrop/Erome) and standalone decryption keys, sends full page harvests to local Nexus and offers quick bypass provider switch on cooldown.
// @match        https://*/*
// @match        http://*/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      127.0.0.1
// ==/UserScript==

(() => {
    'use strict';

    const hosts = new Set(['mega.nz', 'www.mega.nz', 'mega.co.nz', 'www.mega.co.nz']);
    const handle = '[A-Za-z0-9_-]{8}';
    const folderKey = '[A-Za-z0-9_-]{22}';
    const fileKey = '[A-Za-z0-9_-]{43}';
    const modernPath = new RegExp(`^/(folder|file)/(${handle})/?$`);
    const folderHash = new RegExp(`^#(${folderKey})(?:/folder/(${handle}))?(?:/file/(${handle}))?/?$`);
    const fileHash = new RegExp(`^#(${fileKey})/?$`);
    const legacyFolder = new RegExp(`^#F!(${handle})!(${folderKey})(?:!(${handle}))?$`);
    const legacyFile = new RegExp(`^#!(${handle})!(${fileKey})$`);
    const bareHost = /^(?:www\.)?mega\.(?:nz|co\.nz)[/#]/i;
    const textLinks = /(?<![\w./:@%+-])(?:https?:\/\/|\/\/)?(?:www\.)?mega\.(?:nz|co\.nz)[/#][^\s<>"'`\])},&]*/gi;
    const mediaTextLinks = /https?:\/\/(?:www\.)?(?:[\w-]+\.)*(?:bunkr(?:r)?\.[a-z]{2,6}\/(?:a|album|albums|f|v|d|i)\/[^\s<>"'`\])},]+|gofile\.io\/d\/[A-Za-z0-9_-]{4,}|pixeldrain\.com\/(?:u|l)\/[A-Za-z0-9_-]{4,}|cyberdrop\.[a-z]{2,6}\/(?:a|f)\/[A-Za-z0-9_-]{4,}|erome\.com\/a\/[A-Za-z0-9_-]{4,}|filester\.me\/(?:d|f|a)\/[A-Za-z0-9_-]+|krakenfiles\.com\/view\/[A-Za-z0-9_-]+)/gi;
    const urlAttributes = ['href', 'title', 'aria-label', 'data-url', 'data-href', 'data-link', 'data-mega-url', 'data-clipboard-text'];
    const urlElements = urlAttributes.map(name => `[${name}*="mega." i],[${name}*="bunkr" i],[${name}*="gofile.io" i],[${name}*="pixeldrain.com" i],[${name}*="cyberdrop." i],[${name}*="erome.com" i],[${name}*="filester.me" i]`).join(',');
    const ignored = 'script,style,noscript,input,textarea,select,template,[contenteditable]';
    const ports = [8000, 8001, 8002, 8080, 5173, 3000];
    const statusLabel = {
        pending: 'Overujem…', available: 'Dostupné', empty: 'Bez videí', unavailable: 'Nedostupné',
        invalid: 'Neplatný odkaz', open_in_mega: 'Otvoriť v MEGA', retry: 'Skúsiť znova',
        below_minimum: 'Žiadne video s dĺžkou aspoň 1:00', duration_unknown: 'Dĺžku videí sa nepodarilo overiť',
        sent: 'V MEGA Hube', dismissed: 'Preskočené',
    };
    const candidates = new Map();
    const mediaCandidates = new Map();
    const quickLinks = new Map();
    const dirty = new Set();
    let page = location.href;
    let bridge = '';
    let connecting;
    let control;
    let working = 0;
    let sending = false;
    let harvestSyncedKey = '';
    let scanTimer;
    let renderTimer;
    let activeHandoff = null;
    let pairWithHandoff = true;
    let handoffLoading = false;
    let lastHandoffCheckAt = 0;
    let bypassFailBanner = null;
    const testedKeyTokens = new Set();
    const isBypassHost = /(?:bypass\.city|bypass\.vip|keybypass\.net|thebypasser|rip\.linkvertise|linkvertise|link-to|link-hub|link-center|link-target|direct-link|loot-link|lootdest|work\.ink|pastebin|rentry|justpaste|telegra\.ph|pastemode|paste\.ee|controlc|onlyshare)/i.test(location.hostname);
    const BYPASS_FALLBACKS = [
        { hostRe: /bypass\.city$/i, name: 'Bypass.city', param: 'bypass', build: u => `https://bypass.city/bypass?bypass=${encodeURIComponent(u)}` },
        { hostRe: /bypass\.vip$/i, name: 'Bypass.vip', param: 'url', build: u => `https://bypass.vip/?url=${encodeURIComponent(u)}` },
        { hostRe: /keybypass\.net$/i, name: 'KeyBypass', param: 'url', build: u => `https://keybypass.net/?url=${encodeURIComponent(u)}` },
    ];

    function looksLikeMegaKey(token, expectedLen) {
        if (!token || token.length !== expectedLen) return false;
        if (!/^[A-Za-z0-9_-]+$/.test(token)) return false;
        // Reálne base64url MEGA kľúče majú zmes malých, veľkých písmen a číslic/znakov (odfiltruje bežné slová a CSS triedy)
        const classes = (/[a-z]/.test(token) ? 1 : 0) + (/[A-Z]/.test(token) ? 1 : 0) + (/[0-9_-]/.test(token) ? 1 : 0);
        return classes >= 3 && !/^(?:https?|www|function|document|undefined)/i.test(token);
    }

    function scanStandaloneHandoffKeys() {
        const base = activeHandoff?.keyless_mega_url;
        if (!base || !pairWithHandoff) return;
        const kind = activeHandoff.keyless_mega_kind === 'file' ? 'file' : 'folder';
        const expectedLen = kind === 'file' ? 43 : 22;
        const tokenRe = new RegExp(`(?<![A-Za-z0-9_/-])#?([A-Za-z0-9_-]{${expectedLen}})(?![A-Za-z0-9_-])`, 'g');
        const sources = [];

        // 1. Inputy, textarea, pre, code (napr. Bypass.city "Direct Paste" box)
        document.querySelectorAll('textarea, input[type="text"], input:not([type]), pre, code, [class*="paste" i], [class*="result" i], [class*="output" i]').forEach(el => {
            if (el.closest?.('script,style,noscript') || el === control?.host) return;
            const val = typeof el.value === 'string' && el.value.trim() ? el.value : (el.textContent || '');
            if (val && val.length < 4000) sources.push(val);
        });
        // 2. Krátke textové uzly na stránke (ak Bypass.city renderuje kľúč do obyčajného <div>/<span>)
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const txt = (node.data || '').trim();
            if (!txt || txt.length < expectedLen || txt.length > 200) continue;
            if (node.parentElement?.closest('script,style,noscript')) continue;
            if (control?.host && control.host.contains(node)) continue;
            sources.push(txt);
        }

        let added = 0;
        for (const src of sources) {
            for (const m of src.matchAll(tokenRe)) {
                const tok = m[1];
                if (testedKeyTokens.has(tok) || !looksLikeMegaKey(tok, expectedLen)) continue;
                testedKeyTokens.add(tok);
                const fullUrl = `${base.replace(/\/+$/, '')}#${tok}`;
                if (register(fullUrl)) added++;
                if (added >= 6) break;
            }
            if (added >= 6) break;
        }
        if (added > 0) {
            if (!control) control = createPanel();
            control.host.style.display = 'flex';
            control.badge.textContent = `MEGA · ${candidates.size}`;
            setPanelOpen(true);
            scheduleRender();
            pump();
        }
    }

    function normalize(value) {
        try {
            if (bareHost.test(value)) value = `https://${value}`;
            else if (value.startsWith('//')) value = `https:${value}`;
            const url = new URL(value);
            if (!hosts.has(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return '';
            const path = url.pathname.match(modernPath);
            if (path) {
                const frag = url.hash.match(path[1] === 'file' ? fileHash : folderHash);
                if (!frag) return '';
                return `https://mega.nz/${path[1]}/${path[2]}#${frag[1]}${frag[2] ? `/folder/${frag[2]}` : ''}${frag[3] ? `/file/${frag[3]}` : ''}`;
            }
            if (url.pathname !== '/') return '';
            const folder = url.hash.match(legacyFolder);
            if (folder) return `https://mega.nz/folder/${folder[1]}#${folder[2]}${folder[3] ? `/folder/${folder[3]}` : ''}`;
            const file = url.hash.match(legacyFile);
            return file ? `https://mega.nz/file/${file[1]}#${file[2]}` : '';
        } catch {
            return '';
        }
    }

    function register(value) {
        const url = normalize(value);
        if (!url || candidates.has(url)) return false;
        candidates.set(url, { url, status: 'pending', selected: false });
        return true;
    }

    function registerMedia(value) {
        try {
            const cleaned = String(value || '').trim().replace(/[.;:!?]+$/, '');
            if (!cleaned) return false;
            const u = new URL(cleaned);
            if (!['http:', 'https:'].includes(u.protocol)) return false;
            const host = u.hostname.toLowerCase();
            let canonical = u.href;
            let label = host;
            if (/(?:^|\.)bunkr(?:r)?\.[a-z]{2,6}$/.test(host)) {
                const m = u.pathname.match(/^\/(a|album|albums|f|v|d|i)\/([A-Za-z0-9._-]+)/i);
                if (!m) return false;
                const seg = ['a', 'album', 'albums'].includes(m[1].toLowerCase()) ? 'a' : m[1].toLowerCase();
                canonical = `https://bunkr.cr/${seg}/${m[2]}`;
                label = seg === 'a' ? 'Bunkr album' : 'Bunkr súbor';
            } else if (host.endsWith('gofile.io')) {
                label = 'Gofile';
            } else if (host.endsWith('pixeldrain.com')) {
                label = 'Pixeldrain';
            } else if (/cyberdrop\.[a-z]{2,6}$/.test(host)) {
                label = 'Cyberdrop';
            } else if (host.endsWith('erome.com')) {
                label = 'Erome';
            } else if (host.endsWith('filester.me')) {
                label = 'Filester';
            } else if (host.endsWith('krakenfiles.com')) {
                label = 'Krakenfiles';
            }
            if (mediaCandidates.has(canonical)) return false;
            mediaCandidates.set(canonical, { url: canonical, label });
            return true;
        } catch {
            return false;
        }
    }

    function scanText(value) {
        for (const [link] of value.matchAll(textLinks)) {
            if (!/(?:\.{3,}|…)\s*$/.test(link)) register(link.replace(/[.;:!?]+$/, ''));
        }
        if (/(?:bunkr|gofile\.io|pixeldrain\.com|cyberdrop\.|erome\.com|filester\.me|krakenfiles\.com)/i.test(value)) {
            for (const [mlink] of value.matchAll(mediaTextLinks)) {
                registerMedia(mlink);
            }
        }
    }

    function scanAttributes(element) {
        for (const name of element.getAttributeNames()) {
            if (!urlAttributes.includes(name)) continue;
            const value = element.getAttribute(name);
            if (!/(?:mega\.(?:nz|co\.nz)|bunkr|gofile\.io|pixeldrain\.com|cyberdrop\.|erome\.com|filester\.me|krakenfiles\.com)/i.test(value)) continue;
            scanText(value);
            if (/%(?:2f|23)/i.test(value)) {
                try { scanText(decodeURIComponent(value)); } catch { /* Ignore malformed encoding. */ }
            }
        }
        if (element.tagName === 'A') addQuickLink(element);
    }

    function addQuickLink(anchor) {
        const url = normalize(anchor.getAttribute('href')?.trim() || '');
        const previous = quickLinks.get(anchor);
        if (previous && previous.url === url && anchor.nextElementSibling === previous.host) return;
        if (previous) { previous.host.remove(); quickLinks.delete(anchor); }
        if (!url || !candidates.has(url)) return;
        const host = document.createElement('span');
        host.style.cssText = 'display:inline-flex;vertical-align:middle;margin-inline:5px;';
        const shadow = host.attachShadow({ mode: 'closed' });
        const add = action(candidates.get(url).status === 'sent' ? 'M✓' : 'M+', () => {
            const item = candidates.get(url);
            if (!item || sending) return;
            setPanelOpen(true);
            if (item.status === 'sent') {
                control.message.textContent = 'Tento odkaz už je v MEGA Hube.';
                return;
            }
            send([item]);
        });
        add.addEventListener('click', event => event.stopPropagation());
        add.setAttribute('aria-label', 'M+ · Poslať do MEGA Hubu');
        add.title = 'Poslať do MEGA Hubu';
        add.style.cssText = 'box-sizing:border-box;display:inline-grid;place-items:center;min-width:29px;min-height:24px;padding:1px 4px;border:1px solid #7ce0c1;border-radius:6px;background:#174e43;color:#d8ffef;font:800 12px/1 system-ui,sans-serif;cursor:pointer;';
        shadow.append(add);
        anchor.after(host);
        quickLinks.set(anchor, { url, host, add });
    }

    function scan(root) {
        if (root.nodeType === Node.TEXT_NODE) {
            if (root.parentElement?.closest(ignored)) return;
            scanText(root.data);
            return;
        }
        if (root.nodeType !== Node.ELEMENT_NODE || root === control?.host || root.closest(ignored)) return;
        if (root.matches(urlElements)) scanAttributes(root);
        root.querySelectorAll(urlElements).forEach(el => { if (!el.closest(ignored)) scanAttributes(el); });
        const nodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
            if (/(?:mega\.(?:nz|co\.nz)|bunkr|gofile\.io|pixeldrain\.com|cyberdrop\.|erome\.com|filester\.me|krakenfiles\.com)/i.test(node.data)) scan(node);
        }
    }

    function checkBypassCooldownBanner() {
        const curIdx = BYPASS_FALLBACKS.findIndex(p => p.hostRe.test(location.hostname));
        if (curIdx < 0) return;
        const currentProv = BYPASS_FALLBACKS[curIdx];
        const params = new URLSearchParams(location.search);
        const targetUrl = params.get(currentProv.param) || params.get('bypass') || params.get('url') || '';
        if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) return;
        const pageSignal = `${document.title || ''} ${(document.body?.innerText || '').slice(0, 1200)}`;
        const failed = /(?:bypass\s+failed|cooldown|rate\s*limit|too\s+many\s+requests|try\s+again\s+later|error\s+bypassing)/i.test(pageSignal);
        if (!failed || bypassFailBanner) return;
        const nextProv = BYPASS_FALLBACKS[(curIdx + 1) % BYPASS_FALLBACKS.length];
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:10px;background:#26182c;border:1px solid #c084fc;color:#f5e8ff;font:650 13px/1.3 system-ui,sans-serif;box-shadow:0 10px 30px #000b;';
        const txt = document.createElement('span');
        txt.textContent = `${currentProv.name} zlyhal / cooldown`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = `↻ Skúsiť cez ${nextProv.name} ↗`;
        btn.style.cssText = 'padding:5px 10px;border-radius:7px;border:1px solid #92f7d3;background:#78edc3;color:#092b23;font-weight:750;cursor:pointer;';
        btn.addEventListener('click', () => { location.href = nextProv.build(targetUrl); });
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = '✕';
        close.style.cssText = 'padding:4px 7px;border-radius:7px;border:1px solid #6b4e73;background:transparent;color:#e9d5ff;cursor:pointer;';
        close.addEventListener('click', () => { wrap.remove(); bypassFailBanner = null; });
        wrap.append(txt, btn, close);
        document.body.appendChild(wrap);
        bypassFailBanner = wrap;
    }

    async function syncHarvestToNexus(manual = false) {
        if (typeof GM_xmlhttpRequest !== 'function') return;
        const megaList = [...candidates.keys()];
        const mediaList = [...mediaCandidates.keys()];
        if (!megaList.length && !mediaList.length) return;
        const key = `${activeHandoff?.post_id || 0}|${megaList.length}|${mediaList.length}|${location.href}`;
        if (!manual && harvestSyncedKey === key) return;
        if (!manual && (!activeHandoff || !pairWithHandoff)) return;
        harvestSyncedKey = key;
        try {
            const origin = await findBridge();
            const res = await request(origin, '/handoff/harvest', {
                post_id: activeHandoff && pairWithHandoff ? activeHandoff.post_id : null,
                source_url: location.href,
                mega_urls: megaList,
                media_urls: mediaList,
            }, 10000);
            if (manual && control?.message) {
                control.message.textContent = res.status === 200
                    ? `Uložené do Nexusu: ${megaList.length} MEGA · ${mediaList.length} media odkazov.`
                    : (res.data?.detail || 'Nepodarilo sa uložiť zber do Nexusu.');
            }
        } catch (err) {
            if (manual && control?.message) control.message.textContent = err.message;
        }
    }

    function flush() {
        if (page !== location.href) {
            page = location.href;
            candidates.clear();
            mediaCandidates.clear();
            harvestSyncedKey = '';
            dirty.clear();
            dirty.add(document.body);
            if (hosts.has(location.hostname) && modernPath.test(location.pathname) && location.pathname.startsWith('/file/')) register(location.href);
        }
        const previousTotal = candidates.size + mediaCandidates.size;
        dirty.forEach(node => { if (node?.isConnected) scan(node); });
        dirty.clear();
        if (activeHandoff?.keyless_mega_url) {
            scanStandaloneHandoffKeys();
        } else if (isBypassHost && Date.now() - lastHandoffCheckAt > 2500) {
            loadHandoff();
        }
        if (isBypassHost) checkBypassCooldownBanner();
        for (const [anchor, marker] of quickLinks) {
            if (anchor.isConnected && normalize(anchor.getAttribute('href')?.trim() || '') === marker.url) continue;
            marker.host.remove();
            quickLinks.delete(anchor);
        }
        const totalFound = candidates.size + mediaCandidates.size;
        const firstOpen = totalFound > 0 && !control;
        if (totalFound && !control) control = createPanel();
        if (!control) return;
        control.host.style.display = totalFound ? 'flex' : 'none';
        control.badge.textContent = mediaCandidates.size
            ? `MEGA · ${candidates.size} · Media · ${mediaCandidates.size}`
            : `MEGA · ${candidates.size}`;
        if (firstOpen || totalFound > previousTotal) {
            setPanelOpen(true);
            loadHandoff();
        }
        if (activeHandoff && pairWithHandoff && (candidates.size > 1 || mediaCandidates.size > 0)) {
            syncHarvestToNexus(false);
        }
        if (!control.panel.hidden) {
            scheduleRender();
            pump();
        }
    }

    function tryAutoSendHandoff() {
        if (sending || !activeHandoff || !pairWithHandoff) return;
        const ready = [...candidates.values()].filter(item => item.status === 'available');
        if (ready.length > 0) {
            send(ready);
        }
    }

    async function loadHandoff() {
        if (handoffLoading || typeof GM_xmlhttpRequest !== 'function') return;
        handoffLoading = true;
        lastHandoffCheckAt = Date.now();
        try {
            const origin = await findBridge();
            const response = await request(origin, '/handoff', undefined, 3000);
            if (response.status === 200) {
                activeHandoff = response.data?.handoff || null;
                if (activeHandoff) pairWithHandoff = true;
                if (activeHandoff?.keyless_mega_url) scanStandaloneHandoffKeys();
                scheduleRender();
                tryAutoSendHandoff();
            }
        } catch {
            // Handoff je voliteľné rozšírenie, pri nedostupnom Nexuse ticho ignorujeme.
        } finally {
            handoffLoading = false;
        }
    }

    function setPanelOpen(open) {
        control.panel.hidden = !open;
        control.badge.setAttribute('aria-expanded', String(open));
        if (open) {
            render();
            pump();
            loadHandoff();
        }
    }

    function request(origin, path, body, timeout = 25000) {
        return new Promise((resolve, reject) => {
            const headers = { 'X-Nexus-Mega-Hub': 'userscript', 'X-Nexus-Token': GM_getValue('token', '') };
            if (body !== undefined) headers['Content-Type'] = 'application/json';
            GM_xmlhttpRequest({
                url: `${origin}/api/v1/mega/hub${path}`, method: body === undefined ? 'GET' : 'POST',
                headers, data: body === undefined ? undefined : JSON.stringify(body), anonymous: true, timeout,
                onload(response) {
                    let data;
                    try { data = JSON.parse(response.responseText); } catch { data = {}; }
                    resolve({ status: response.status, data });
                },
                onerror: () => reject(new Error('Lokálny Nexus nie je dostupný.')),
                ontimeout: () => reject(new Error('Nexus neodpovedal včas.')),
            });
        });
    }

    async function findBridge() {
        if (bridge) return bridge;
        if (connecting) return connecting;
        connecting = (async () => {
            const saved = Number(GM_getValue('port', 8000));
            let outdated = false;
            for (const port of new Set([saved, ...ports])) {
                if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
                const origin = `http://127.0.0.1:${port}`;
                try {
                    const response = await request(origin, '/ping', undefined, 1000);
                    if (response.data.service !== 'nexus-mega-hub') continue;
                    if (response.data.capture_min_seconds !== 60) { outdated = true; continue; }
                    GM_setValue('port', port);
                    bridge = origin;
                    return origin;
                } catch { /* Try the next configured port. */ }
            }
            throw new Error(outdated ? 'Reštartuj Nexus, aby sa načítal filter dĺžky videí.'
                : 'Spusti lokálny Nexus s MEGA Hubom a skús overiť odkazy znova.');
        })();
        try { return await connecting; } finally { connecting = null; }
    }

    async function hub(path, body) {
        const origin = await findBridge();
        let response;
        const useCapture = !(activeHandoff && pairWithHandoff);
        try {
            response = await request(origin, path, { ...body, capture: useCapture }, 110000);
        } catch (error) {
            bridge = '';
            throw error;
        }
        if (response.status === 401) throw new Error('Nastav Nexus bridge token v menu userscriptu.');
        return response;
    }

    function pump() {
        if (!control || control.panel.hidden || sending) return;
        for (const item of candidates.values()) {
            if (working >= 4) break;
            if (item.status !== 'pending' || item.checking) continue;
            working++;
            item.checking = hub('/check', { url: item.url }).then(({ status, data }) => {
                if (item.status === 'sent') return;
                item.status = status === 200 ? data.status : status === 400 ? 'invalid' : 'retry';
                item.title = data.title;
                item.count = data.count;
                item.shortCount = data.short_count;
                item.unknownCount = data.unknown_duration_count;
                item.checkId = data.check_id;
            }).catch(error => {
                if (item.status === 'sent') return;
                item.status = 'retry';
                control.message.textContent = error.message;
            }).finally(() => {
                working--;
                item.checking = false;
                scheduleRender();
                pump();
                tryAutoSendHandoff();
            });
        }
    }

    async function send(items) {
        if (sending || !items.length) return;
        sending = true;
        render();
        let count = 0;
        let paired = false;
        let lastError = '';
        const pairId = activeHandoff && pairWithHandoff ? activeHandoff.post_id : 0;
        const totalInBatch = items.length;
        for (let idx = 0; idx < items.length; idx++) {
            const item = items[idx];
            const keepHandoff = totalInBatch > 1 && idx < totalInBatch - 1;
            try {
                await item.checking;
                if (['below_minimum', 'duration_unknown'].includes(item.status)) {
                    lastError = statusLabel[item.status];
                    continue;
                }
                let response = await hub('/entries', item.checkId
                    ? { check_id: item.checkId, link_post_id: pairId, keep_handoff: keepHandoff }
                    : { url: item.url, link_post_id: pairId, keep_handoff: keepHandoff });
                if (response.status === 409) {
                    response = await hub('/entries', { url: item.url, link_post_id: pairId, keep_handoff: keepHandoff });
                }
                if (!response.data.entry && statusLabel[response.data.status]) {
                    item.status = response.data.status;
                    item.selected = false;
                    item.checkId = undefined;
                    item.shortCount = response.data.short_count;
                    item.unknownCount = response.data.unknown_duration_count;
                    lastError = statusLabel[item.status];
                    continue;
                }
                if (!response.data.entry) throw new Error(response.data.detail || 'Odkaz sa nepodarilo odoslať.');
                if (response.data.linked_post_id) {
                    paired = true;
                    if (!keepHandoff) activeHandoff = null;
                }
                item.status = 'sent';
                item.entry = response.data.entry;
                item.title = item.entry.title || item.title;
                item.count = item.entry.count ?? item.count;
                item.selected = false;
                for (const marker of quickLinks.values()) {
                    if (marker.url === item.url) marker.add.textContent = 'M✓';
                }
                count++;
            } catch (error) {
                lastError = error.message;
                if (!bridge) break;
            }
        }
        sending = false;
        control.message.textContent = [
            count ? `V MEGA Hube je ${count} ${count === 1 ? 'položka' : 'položiek z výberu'}.` : '',
            paired ? 'Spárované s Telegram kartou.' : '',
            lastError,
        ].filter(Boolean).join(' ');
        render();
        pump();
    }

    function action(label, fn, className) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className || '';
        button.textContent = label;
        button.addEventListener('click', event => { if (event.isTrusted) fn(); });
        return button;
    }

    function link(label, url) {
        const item = document.createElement('a');
        item.textContent = label;
        item.href = url;
        item.target = '_blank';
        item.rel = 'noopener noreferrer';
        return item;
    }

    function scheduleRender() {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(render, 100);
    }

    function render() {
        if (!control || control.panel.hidden) return;
        if (control.handoffBar) {
            control.handoffBar.hidden = !activeHandoff;
            if (activeHandoff) {
                control.handoffCheck.checked = pairWithHandoff;
                control.handoffText.textContent = `Spárovať s Telegram kartou: ${activeHandoff.title || `#${activeHandoff.post_id}`}`;
            }
        }
        const items = [...candidates.values()];
        const available = items.filter(item => item.status === 'available');
        control.selected.disabled = sending || !available.some(item => item.selected);
        control.all.disabled = sending || !available.length || items.some(item => item.status === 'pending');
        control.retry.disabled = sending || !items.some(item => item.status !== 'sent' && (['retry', 'duration_unknown'].includes(item.status) || item.unknownCount));
        const scroll = control.list.scrollTop;
        const rows = items.map(item => {
            const row = document.createElement('article');
            const label = document.createElement('strong');
            label.textContent = item.title || (item.url.includes('/file/') ? 'MEGA súbor' : 'MEGA priečinok');
            const info = document.createElement('small');
            info.append(statusLabel[item.status]);
            if (item.count) {
                const count = document.createElement('span');
                count.className = 'video-count';
                count.textContent = `${item.count} ${item.count === 1 ? 'video' : item.count < 5 ? 'videá' : 'videí'}`;
                info.append(count);
            }
            const dropped = [item.shortCount ? `${item.shortCount} pod 1:00` : '', item.unknownCount ? `${item.unknownCount} bez overenej dĺžky` : ''].filter(Boolean);
            if (dropped.length) info.append(` · vyradené: ${dropped.join(', ')}`);
            const commands = document.createElement('div');
            if (item.status === 'available') {
                const box = document.createElement('input');
                box.type = 'checkbox';
                box.checked = item.selected;
                box.disabled = sending;
                box.setAttribute('aria-label', `Vybrať ${label.textContent}`);
                box.addEventListener('change', event => {
                    if (!event.isTrusted) return;
                    item.selected = box.checked;
                    control.selected.disabled = sending || !available.some(candidate => candidate.selected);
                });
                const accept = action('Poslať', () => send([item]), 'send');
                const decline = action('Nie', () => { item.status = 'dismissed'; render(); });
                accept.disabled = decline.disabled = sending;
                commands.append(box, accept, decline);
            } else if (item.status === 'open_in_mega') {
                commands.append(link('Otvoriť v MEGA ↗', item.url));
            } else if (item.status === 'sent') {
                commands.append(link('Otvoriť Hub ↗', `${bridge || `http://127.0.0.1:${GM_getValue('port', 8000)}`}/?mega_hub=${item.entry.id}`));
            }
            row.append(label, info, commands);
            return row;
        });

        const baseOrigin = bridge || `http://127.0.0.1:${GM_getValue('port', 8000)}`;
        for (const med of mediaCandidates.values()) {
            const row = document.createElement('article');
            const label = document.createElement('strong');
            label.textContent = `🟣 ${med.label}`;
            const info = document.createElement('small');
            info.textContent = med.url.replace(/^https?:\/\/(?:www\.)?/i, '');
            const commands = document.createElement('div');
            commands.append(
                link('🧪 Tester ↗', `${baseOrigin}/tester?url=${encodeURIComponent(med.url)}`),
                link('↗', med.url),
            );
            row.append(label, info, commands);
            rows.push(row);
        }

        control.list.replaceChildren(...rows);
        control.list.scrollTop = scroll;
        if (control.saveHarvest) {
            control.saveHarvest.hidden = !(candidates.size > 1 || mediaCandidates.size > 0);
            control.saveHarvest.disabled = sending;
        }
    }

    function createPanel() {
        const host = document.createElement('div');
        host.style.cssText = 'all:initial;position:fixed;right:16px;top:16px;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-end;gap:8px;';
        const shadow = host.attachShadow({ mode: 'closed' });
        const style = document.createElement('style');
        style.textContent = `
            [hidden] { display:none!important; } * { box-sizing:border-box; }
            button,a { color:inherit; font:inherit; text-decoration:none; border:1px solid #5b4654; background:#30232e; border-radius:7px; padding:5px 8px; cursor:pointer; }
            button:focus-visible,a:focus-visible { outline:2px solid #ffd0da; }
            button:hover:not(:disabled),a:hover { background:#4a3142; } button:disabled { opacity:.4; cursor:default; }
            .badge { background:#442433; color:#ffd4dd; font:750 13px/1.4 system-ui,sans-serif; padding:6px 10px; box-shadow:0 4px 16px #0008; }
            section { width:min(440px,calc(100vw - 32px)); padding:10px; background:#211822; color:#f9eef1; color-scheme:dark; font: 13px/1.4 system-ui,sans-serif; border:1px solid #654655; border-radius:12px; box-shadow:0 12px 45px #000b; }
            .send { background:#78edc3; color:#092b23; border-color:#92f7d3; font-weight:750; }
            .send:hover:not(:disabled) { background:#a7f9da; }
            .video-count { display:inline-block; margin-inline-start:7px; padding:2px 6px; border-radius:6px; color:#b9dcff; background:#243f60; font-weight:750; }
            input { accent-color:#ffd0da; }
            header,footer,article div { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
            header { justify-content:space-between; margin-bottom:8px; }
            .handoff-bar { display:flex; align-items:center; gap:7px; padding:6px 8px; margin-bottom:8px; border-radius:8px; background:rgba(120,237,195,.12); border:1px solid rgba(120,237,195,.35); color:#d8ffef; font-size:12px; cursor:pointer; }
            .handoff-bar span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            main { max-height:min(52vh,440px); overflow:auto; overscroll-behavior:contain; }
            article { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:3px 7px; padding:7px 3px; border-top:1px solid #40313c; }
            article strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            article small { grid-column:1; color:#c3b4bf; }
            article div { grid-column:2; grid-row:1 / span 2; }
            footer { margin-top:7px; } output { display:block; color:#ffc5d3; padding-top:4px; } output:empty { display:none; }
        `;
        const panel = document.createElement('section');
        panel.hidden = true;
        panel.setAttribute('aria-label', 'Nájdené MEGA odkazy');
        const header = document.createElement('header');
        const title = document.createElement('strong');
        title.textContent = 'MEGA odkazy na stránke';
        const handoffBar = document.createElement('label');
        handoffBar.className = 'handoff-bar';
        handoffBar.hidden = true;
        const handoffCheck = document.createElement('input');
        handoffCheck.type = 'checkbox';
        handoffCheck.checked = true;
        const handoffText = document.createElement('span');
        handoffBar.append(handoffCheck, handoffText);
        handoffCheck.addEventListener('change', event => {
            if (!event.isTrusted) return;
            pairWithHandoff = handoffCheck.checked;
        });
        const list = document.createElement('main');
        const footer = document.createElement('footer');
        const message = document.createElement('output');
        message.setAttribute('role', 'status');
        const selected = action('Poslať vybrané', () => send([...candidates.values()].filter(item => item.status === 'available' && item.selected)), 'send');
        const all = action('Poslať všetky dostupné', () => send([...candidates.values()].filter(item => item.status === 'available')), 'send');
        const retry = action('Overiť znova', () => {
            message.textContent = '';
            for (const item of candidates.values()) {
                if (item.status === 'sent') continue;
                if (['retry', 'duration_unknown'].includes(item.status) || item.unknownCount) {
                    item.status = 'pending';
                    item.checkId = undefined;
                }
            }
            render();
            pump();
        });
        const saveHarvest = action('📦 Uložiť celú stránku do Nexusu', () => syncHarvestToNexus(true));
        saveHarvest.hidden = true;
        const badge = action('', () => setPanelOpen(panel.hidden), 'badge');
        badge.setAttribute('aria-expanded', 'false');
        header.append(title, action('Zavrieť', () => {
            setPanelOpen(false);
            badge.focus();
        }));
        footer.append(selected, all, retry, saveHarvest);
        panel.append(header, handoffBar, list, footer, message);
        shadow.append(style, badge, panel);
        document.body.appendChild(host);
        return { host, panel, list, message, badge, selected, all, retry, saveHarvest, handoffBar, handoffCheck, handoffText };
    }

    function autoCaptureFolderHandoff() {
        if (typeof GM_xmlhttpRequest !== 'function') return;
        if (!hosts.has(location.hostname) || !location.pathname.startsWith('/folder/')) return;
        const url = normalize(location.href);
        if (!url) return;
        findBridge()
            .then(origin => request(origin, '/handoff', undefined, 3000))
            .then(res => {
                const handoff = res?.data?.handoff;
                if (!handoff || !handoff.post_id) return;
                return hub('/entries', { url, link_post_id: handoff.post_id });
            })
            .catch(() => {});
    }

    autoCaptureFolderHandoff();
    if (hosts.has(location.hostname) && location.pathname.startsWith('/folder/')) return;
    if (['127.0.0.1', 'localhost'].includes(location.hostname) && (document.getElementById('mega-hub') || document.getElementById('quantumSearchOverlay'))) return;
    GM_registerMenuCommand('MEGA Hub: nastaviť Nexus bridge token', () => {
        const token = window.prompt('Nexus bridge token (iba ak je nastavený v Nexuse)');
        if (token !== null) GM_setValue('token', token.trim());
    });
    GM_registerMenuCommand('MEGA Hub: nastaviť port Nexusu', () => {
        const port = Number(window.prompt('Port lokálneho Nexusu', GM_getValue('port', 8000)));
        if (Number.isInteger(port) && port > 0 && port <= 65535) { GM_setValue('port', port); bridge = ''; }
    });
    if (hosts.has(location.hostname) && location.pathname.startsWith('/file/')) register(location.href);
    dirty.add(document.body);
    flush();
    if (isBypassHost) {
        loadHandoff();
        checkBypassCooldownBanner();
        let bypassTicks = 0;
        const bypassTimer = setInterval(() => {
            bypassTicks++;
            if (bypassTicks > 60) { clearInterval(bypassTimer); return; }
            checkBypassCooldownBanner();
            if (activeHandoff?.keyless_mega_url) scanStandaloneHandoffKeys();
            else if (bypassTicks % 3 === 0) loadHandoff();
        }, 1500);
    }
    new MutationObserver(records => {
        for (const record of records) {
            if (record.type === 'childList') record.addedNodes.forEach(node => dirty.add(node));
            else dirty.add(record.target);
        }
        if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = 0; flush(); }, 160);
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: urlAttributes, characterData: true });
    window.addEventListener('popstate', flush);
    window.addEventListener('hashchange', flush);
})();
