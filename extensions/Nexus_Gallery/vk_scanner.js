(function () {
    const VK_HOST_RE = /https?:\/\/(?:[^/]+\.)?(?:vk\.com|vk\.ru|vkvideo\.(?:ru|net|com)|vkvideos?\.(?:ru|net|com))(?:\/|$)/i;
    const VIDEO_ID_RE = /\/video(-?\d+_\d+)/i;
    const SOURCE_ID_RE = /\/(?:@([^/?#]+)|club(\d+)|public(\d+)|id(\d+)|videos?(-?\d+))/i;
    const MAX_SOURCES = 60;
    const MAX_VIDEOS_PER_PAGE = 80;
    const MAX_SELECTED_SOURCE_SCAN = 20;
    const AUTO_SCROLL_STEPS = 10;
    const AUTO_SCROLL_DELAY_MS = 700;
    const TAB_TIMEOUT_MS = 20000;
    const SOURCE_SCROLL_STEPS = 4;
    const SOURCE_SCROLL_DELAY_MS = 650;
    const PLAYLIST_BATCH_SIZE = 100;
    const state = {
        active: false,
        tabId: null,
        sources: [],
        selectedSourceIds: new Set(),
        sourceScanErrors: [],
        sourceVideos: [],
        playlist: {
            active: false,
            totalReady: 0,
            loadedCount: 0,
            batchSize: PLAYLIST_BATCH_SIZE,
            nextOffset: 0,
            title: "",
            sourceUrl: "",
        },
    };

    function bridge() {
        return window.NexusGalleryBridge || null;
    }

    function log(...args) {
        console.log("[VK Scanner]", ...args);
    }

    function isVkUrl(url) {
        return VK_HOST_RE.test(String(url || ""));
    }

    function normalizeUrl(raw) {
        const value = String(raw || "").trim();
        if (!value) return "";
        try {
            const url = new URL(value);
            url.hash = "";
            url.search = "";
            url.pathname = url.pathname.replace(/\/+$/, "") || "/";
            return url.href;
        } catch {
            return value;
        }
    }

    function escapeHtml(value) {
        return String(value || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function extractVideoId(url) {
        const match = String(url || "").match(VIDEO_ID_RE);
        return match ? match[1] : "";
    }

    function deriveSourceType(url) {
        const value = String(url || "");
        if (/\/(?:club|public)\d+/i.test(value)) return "group";
        if (/\/id\d+/i.test(value)) return "profile";
        return "channel";
    }

    function isVkSourceListPath(pathname) {
        const path = String(pathname || "").toLowerCase().replace(/\/+$/, "");
        return path === "/subscriptions" || path === "/groups/my_all_groups" || path === "/groups";
    }

    function isVkPlaylistPath(pathname, href = "") {
        return /\/playlist\//i.test(String(pathname || "")) || /\/playlist\//i.test(String(href || "")) || /[?&](?:z=video_playlist|pl=)/i.test(String(href || ""));
    }

    function deriveSourceId(url) {
        const match = String(url || "").match(SOURCE_ID_RE);
        return match ? (match[1] || match[2] || match[3] || match[4] || match[5] || "") : "";
    }

    function dedupeVideos(videos) {
        const out = [];
        const seen = new Set();
        for (const video of videos || []) {
            const canonical = normalizeUrl(video?.canonical_url || video?.url || "");
            const vkId = String(video?.vk_id || extractVideoId(canonical) || "").trim();
            const key = vkId || canonical;
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push({
                ...video,
                id: key,
                vk_id: vkId,
                canonical_url: canonical,
                url: canonical || video?.url || "",
                source_url: canonical || video?.source_url || video?.url || "",
                quality: video?.quality || "VK",
                tags: video?.tags || "vk",
            });
        }
        return out;
    }

    function setPanelMode(active) {
        const root = document.getElementById("vk-scan-suite");
        if (root) root.classList.toggle("active", !!active);
        const autoImport = document.getElementById("send-to-dashboard");
        if (autoImport) {
            autoImport.checked = false;
            autoImport.disabled = !!active;
            autoImport.parentElement && (autoImport.parentElement.title = active ? "VK import zostáva manuálny až po výbere videí." : "");
        }
    }

    function setStatus(text, progress) {
        const statusEl = document.getElementById("vk-status-text");
        const progressEl = document.getElementById("vk-progress-text");
        if (statusEl) statusEl.textContent = text || "VK scanner pripravený.";
        if (progressEl) progressEl.textContent = progress || "Idle";
        const b = bridge();
        b?.setStatsText?.(text || "VK scanner pripravený.");
    }

    function setPlaylistChip(text, visible = false) {
        const chip = document.getElementById("vk-playlist-chip");
        if (!chip) return;
        chip.textContent = text || "Playlist batch loader pripraveny.";
        chip.classList.toggle("active", !!visible);
    }

    function updatePlaylistUi() {
        const nextBtn = document.getElementById("vk-load-next-btn");
        if (!nextBtn) return;
        const p = state.playlist;
        if (!p.active) {
            nextBtn.style.display = "none";
            setPlaylistChip("", false);
            return;
        }
        const total = p.totalReady || p.loadedCount;
        const loadedTo = Math.min(p.loadedCount, total);
        nextBtn.style.display = p.nextOffset < total ? "inline-flex" : "none";
        nextBtn.textContent = p.nextOffset < total ? `Load next ${p.batchSize}` : "Playlist loaded";
        setPlaylistChip(`${total} ready to load | loaded 1-${loadedTo} from ${total}`, true);
    }

    function resetPlaylistState() {
        state.playlist = {
            active: false,
            totalReady: 0,
            loadedCount: 0,
            batchSize: PLAYLIST_BATCH_SIZE,
            nextOffset: 0,
            title: "",
            sourceUrl: "",
        };
        updatePlaylistUi();
    }

    function getSelectedSources() {
        return state.sources.filter((source) => state.selectedSourceIds.has(source.id));
    }

    function renderSources() {
        const listEl = document.getElementById("vk-sources-list");
        const countEl = document.getElementById("vk-sources-count");
        if (!listEl || !countEl) return;
        countEl.textContent = `${state.sources.length} sources`;
        if (!state.sources.length) {
            listEl.innerHTML = `<div class="vk-empty-note">No VK sources collected yet.</div>`;
            return;
        }
        listEl.innerHTML = state.sources.map((source) => `
            <label class="vk-source-row" data-source-id="${escapeHtml(source.id)}">
                <input type="checkbox" ${state.selectedSourceIds.has(source.id) ? "checked" : ""}>
                <img class="vk-source-avatar" src="${escapeHtml(source.avatar || "icon.png")}" alt="">
                <div class="vk-source-main">
                    <div class="vk-source-name" title="${escapeHtml(source.name)}">${escapeHtml(source.name)}</div>
                    <div class="vk-source-meta">${escapeHtml(source.source_type || "channel")}${source.channel_id ? ` - ${escapeHtml(source.channel_id)}` : ""}</div>
                    <div class="vk-source-url" title="${escapeHtml(source.url)}">${escapeHtml(source.url)}</div>
                </div>
                <span class="vk-source-pill">${escapeHtml(source.source_type || "channel")}</span>
            </label>
        `).join("");
        listEl.querySelectorAll(".vk-source-row").forEach((row) => {
            row.addEventListener("change", (event) => {
                const sourceId = row.getAttribute("data-source-id");
                if (!sourceId) return;
                if (event.target.checked) {
                    state.selectedSourceIds.add(sourceId);
                } else {
                    state.selectedSourceIds.delete(sourceId);
                }
                setStatus(`${state.selectedSourceIds.size} selected sources`, "Ready");
            });
        });
    }

    async function getSourceTab() {
        const tabId = Number(window.sourceTabContext?.sourceTabId || state.tabId || 0) || 0;
        if (tabId > 0) {
            try {
                return await chrome.tabs.get(tabId);
            } catch { }
        }
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        return tabs[0] || null;
    }

    async function waitForTabComplete(tabId, timeoutMs = TAB_TIMEOUT_MS) {
        try {
            const tab = await chrome.tabs.get(tabId);
            if (tab?.status === "complete") return true;
        } catch { }
        return await new Promise((resolve, reject) => {
            let done = false;
            const timer = setTimeout(() => {
                if (done) return;
                done = true;
                chrome.tabs.onUpdated.removeListener(onUpdated);
                reject(new Error("Timed out waiting for tab to load"));
            }, timeoutMs);
            const onUpdated = (updatedTabId, changeInfo) => {
                if (updatedTabId !== tabId || changeInfo.status !== "complete" || done) return;
                done = true;
                clearTimeout(timer);
                chrome.tabs.onUpdated.removeListener(onUpdated);
                resolve(true);
            };
            chrome.tabs.onUpdated.addListener(onUpdated);
        });
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function runInTab(tabId, func, args = []) {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func,
            args,
        });
        return results?.[0]?.result;
    }

    async function openTempTab(url) {
        const tab = await chrome.tabs.create({ url, active: false });
        await waitForTabComplete(tab.id);
        await sleep(1800);
        return tab;
    }

    function scanSourcesInPage() {
        const SYSTEM_PATHS = new Set([
            "about", "ads", "al_feed.php", "audios", "blog", "clips", "docs", "edit", "events",
            "feed", "friends", "groups", "groups_search", "im", "login", "mail", "market",
            "music", "notifications", "photos", "privacy", "search", "settings", "support",
            "video", "videos", "vkpay", "wall",
        ]);
        const isGroupListPage = /\/groups\/my_all_groups\/?$/i.test(location.pathname) || /\/groups\/?$/i.test(location.pathname);
        const normalizeUrl = (raw) => {
            try {
                const url = new URL(raw, location.href);
                url.hash = "";
                url.search = "";
                url.pathname = url.pathname.replace(/\/+$/, "") || "/";
                return url.href;
            } catch {
                return "";
            }
        };
        const isLikelyCommunityHref = (href, row) => {
            const raw = String(href || "").trim();
            if (!raw || raw.startsWith("#") || raw.startsWith("javascript:")) return false;
            if (/\/(?:@|club\d+|public\d+|id\d+|videos?-?\d+)/i.test(raw)) return true;
            if (!isGroupListPage) return false;
            try {
                const url = new URL(raw, location.href);
                if (!/(^|\.)vk\.com$/i.test(url.hostname) && !/(^|\.)vkvideo\.ru$/i.test(url.hostname)) return false;
                const parts = url.pathname.split("/").filter(Boolean);
                if (parts.length !== 1) return false;
                const slug = parts[0].toLowerCase();
                if (SYSTEM_PATHS.has(slug)) return false;
                if (!/^[a-z0-9_.-]{3,80}$/i.test(parts[0])) return false;
                const text = (row?.textContent || "").replace(/\s+/g, " ").trim();
                return !!text && text.length > 2;
            } catch {
                return false;
            }
        };
        const isVisible = (node) => {
            if (!node) return false;
            const style = getComputedStyle(node);
            if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
            const rect = node.getBoundingClientRect();
            return rect.width > 8 && rect.height > 8;
        };
        const selectors = [
            "aside a[href]",
            "[class*='Sidebar'] a[href]",
            "[class*='Subscriptions'] a[href]",
            "[class*='channel'] a[href]",
            "[class*='Channel'] a[href]",
            "[class*='creator'] a[href]",
            "[class*='Creator'] a[href]",
            "[data-testid*='channel'] a[href]",
            "main a[href]",
            "[id*='group'] a[href]",
            "[class*='group'] a[href]",
            "[class*='Group'] a[href]",
            "[class*='community'] a[href]",
            "[class*='Community'] a[href]",
            "a[href*='/@']",
            "a[href*='club']",
            "a[href*='public']",
        ];
        const out = [];
        const seen = new Set();
        document.querySelectorAll(selectors.join(",")).forEach((anchor) => {
            const href = anchor.getAttribute("href") || "";
            if (!href || /\/video-?\d+_\d+/i.test(href) || /\/playlist/i.test(href)) return;
            const row = anchor.closest("[class*='row'], [class*='item'], [class*='card'], li, article, div") || anchor;
            if (!isLikelyCommunityHref(href, row)) return;
            if (!isVisible(anchor) && !isVisible(row)) return;
            const url = normalizeUrl(href);
            if (!url || seen.has(url)) return;
            seen.add(url);
            const name = (anchor.getAttribute("aria-label") || anchor.getAttribute("title") || anchor.textContent || row.querySelector("[class*='name'], [class*='title'], h3, h4")?.textContent || row.textContent || "").replace(/\s+/g, " ").trim();
            if (!name || name.length < 2) return;
            const img = row.querySelector("img");
            out.push({
                id: url,
                name,
                url,
                avatar: img?.currentSrc || img?.src || "",
                channel_id: (url.match(/\/(?:@([^/?#]+)|club(\d+)|public(\d+)|id(\d+)|videos?(-?\d+))/i) || []).slice(1).find(Boolean) || "",
                source_type: /\/(?:club|public)\d+/i.test(url) || isGroupListPage ? "group" : (/\/id\d+/i.test(url) ? "profile" : "channel"),
            });
        });
        return out.slice(0, 60);
    }

    function scanVideosInPage(ownerFallback) {
        const parseBg = (node) => {
            const bg = node?.style?.backgroundImage || "";
            const match = bg.match(/url\(["']?([^"')]+)["']?\)/i);
            return match ? match[1] : "";
        };
        const normalizeUrl = (raw) => {
            try {
                const url = new URL(raw, location.href);
                url.hash = "";
                url.search = "";
                url.pathname = url.pathname.replace(/\/+$/, "") || "/";
                return url.href;
            } catch {
                return "";
            }
        };
        const canonicalVideoUrl = (raw) => {
            try {
                const u = new URL(raw, location.href);
                const oid = u.searchParams.get("oid");
                const id = u.searchParams.get("id");
                if (/video_ext\.php$/i.test(u.pathname) && oid && id) {
                    return `${location.hostname.includes("vkvideo") ? "https://vkvideo.ru" : location.origin}/video${oid}_${id}`;
                }
                const match = `${u.pathname}${u.search}`.match(/video(-?\d+_\d+)/i);
                if (match) {
                    return `${location.hostname.includes("vkvideo") ? "https://vkvideo.ru" : location.origin}/video${match[1]}`;
                }
                return normalizeUrl(u.href);
            } catch {
                const match = String(raw || "").match(/video(-?\d+_\d+)/i);
                return match ? `${location.hostname.includes("vkvideo") ? "https://vkvideo.ru" : location.origin}/video${match[1]}` : "";
            }
        };
        const pickText = (root, selectors) => {
            for (const selector of selectors) {
                const node = root.querySelector(selector);
                const text = (node?.textContent || "").replace(/\s+/g, " ").trim();
                if (text) return text;
            }
            return "";
        };
        const cards = new Map();
        const addVideo = (url, patch = {}) => {
            const cleanUrl = normalizeUrl(url);
            if (!cleanUrl || cards.has(cleanUrl)) return;
            const vkIdMatch = cleanUrl.match(/\/video(-?\d+_\d+)/i);
            const vkId = vkIdMatch ? vkIdMatch[1] : "";
            cards.set(cleanUrl, {
                id: vkId || cleanUrl,
                vk_id: vkId,
                canonical_url: cleanUrl,
                title: patch.title || "VK Video",
                url: cleanUrl,
                source_url: cleanUrl,
                thumbnail: patch.thumbnail || "",
                duration: patch.duration || "",
                quality: "VK",
                owner_name: patch.owner_name || ownerFallback?.owner_name || "",
                owner_url: patch.owner_url || ownerFallback?.owner_url || "",
                views: patch.views || "",
                upload_time: patch.upload_time || "",
                uploadDateLabel: patch.upload_time || "",
                raw_text: patch.raw_text || "",
                tags: "vk",
            });
        };
        const anchors = document.querySelectorAll([
            "a[href*='/video']",
            "a[href*='video-']",
            "a[href*='video_ext.php']",
            "[class*='VideoCard'] a[href*='/video']",
            "[class*='video'] a[href*='/video']",
            "[data-testid*='video'] a[href*='/video']",
        ].join(","));
        anchors.forEach((anchor) => {
            const href = anchor.getAttribute("href") || "";
            if (!/(?:\/video-?\d+_\d+|video-?\d+_\d+|video_ext\.php)/i.test(href)) return;
            const url = canonicalVideoUrl(href);
            if (!url || cards.has(url)) return;
            const card = anchor.closest("[class*='VideoCard'], [class*='video_item'], article, li, [class*='card'], [data-testid*='video']") || anchor;
            const title = (anchor.getAttribute("aria-label") || anchor.getAttribute("title") || pickText(card, [
                "[class*='title']",
                "h3",
                "h4",
                ".VideoCard__title",
                ".video_item_title",
            ]) || anchor.textContent || document.title || "VK Video").replace(/\s+/g, " ").trim();
            const image = card.querySelector("img");
            const thumbHost = card.querySelector("[class*='thumb'], [class*='preview'], [style*='background-image']");
            const rawText = (card.textContent || "").replace(/\s+/g, " ").trim();
            const ownerLink = Array.from(card.querySelectorAll("a[href]")).find((link) => {
                const raw = link.getAttribute("href") || "";
                return raw !== href && /(\/@|\/club\d+|\/public\d+|\/id\d+)/i.test(raw);
            });
            const ownerUrl = normalizeUrl(ownerLink?.getAttribute("href") || ownerFallback?.owner_url || "");
            const ownerName = (ownerLink?.textContent || ownerFallback?.owner_name || "").replace(/\s+/g, " ").trim();
            const duration = pickText(card, [
                "[class*='duration']",
                ".VideoCard__duration",
                ".video_item_duration",
                "time",
            ]);
            const views = pickText(card, [
                "[class*='views']",
                "[class*='view']",
                ".VideoCard__meta",
                ".video_item_info",
            ]);
            const upload = pickText(card, [
                "[class*='time']",
                "[class*='date']",
                ".VideoCard__meta",
                ".video_item_info",
            ]);
            addVideo(url, {
                title: title || "VK Video",
                thumbnail: image?.currentSrc || image?.src || image?.getAttribute("data-src") || parseBg(thumbHost) || "",
                duration,
                owner_name: ownerName || ownerFallback?.owner_name || "",
                owner_url: ownerUrl || ownerFallback?.owner_url || "",
                views,
                upload_time: upload,
                raw_text: rawText,
            });
        });

        const html = document.documentElement?.innerHTML || "";
        const origin = location.hostname.includes("vkvideo") ? "https://vkvideo.ru" : location.origin;
        const rawMatches = html.match(/(?:https?:\\?\/\\?\/(?:[^"'<>\\]+\.)?(?:vk\.com|vkvideo\.ru)\\?\/video-?\d+_\d+|\/video-?\d+_\d+|video-?\d+_\d+)/gi) || [];
        rawMatches.forEach((raw) => {
            const cleaned = String(raw || "").replace(/\\/g, "");
            const idMatch = cleaned.match(/video-?\d+_\d+/i);
            if (!idMatch) return;
            const path = cleaned.startsWith("http") ? cleaned : `${origin}/${idMatch[0]}`;
            addVideo(path, {
                title: ownerFallback?.owner_name ? `${ownerFallback.owner_name} - VK Video` : "VK Video",
                owner_name: ownerFallback?.owner_name || "",
                owner_url: ownerFallback?.owner_url || "",
                raw_text: "Found from VK page HTML fallback",
            });
        });
        const extMatches = html.match(/video_ext\.php[^"'<>\\\s]+/gi) || [];
        extMatches.forEach((raw) => {
            const canonical = canonicalVideoUrl(raw.replace(/&amp;/g, "&").replace(/\\/g, ""));
            if (!canonical) return;
            addVideo(canonical, {
                title: ownerFallback?.owner_name ? `${ownerFallback.owner_name} - VK Video` : "VK Video",
                owner_name: ownerFallback?.owner_name || "",
                owner_url: ownerFallback?.owner_url || "",
                raw_text: "Found from VK video_ext fallback",
            });
        });
        return Array.from(cards.values()).slice(0, 80);
    }

    async function autoScrollTab(tabId) {
        await runInTab(tabId, async (steps, delayMs) => {
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            for (let i = 0; i < steps; i += 1) {
                window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
                await sleep(delayMs);
            }
            window.scrollTo({ top: 0, behavior: "instant" });
            return true;
        }, [AUTO_SCROLL_STEPS, AUTO_SCROLL_DELAY_MS]);
    }

    async function lightScrollTab(tabId) {
        await runInTab(tabId, async (steps, delayMs) => {
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            for (let i = 0; i < steps; i += 1) {
                window.scrollTo({ top: Math.max(window.innerHeight, document.documentElement.scrollTop + window.innerHeight * 0.9), behavior: "smooth" });
                await sleep(delayMs);
            }
            return true;
        }, [SOURCE_SCROLL_STEPS, SOURCE_SCROLL_DELAY_MS]);
    }

    function buildSourceVideoCandidates(source) {
        const out = [];
        const push = (value) => {
            const normalized = normalizeUrl(value);
            if (normalized && !out.includes(normalized)) out.push(normalized);
        };
            push(source.url);
            try {
                const u = new URL(source.url);
                const basePath = u.pathname.replace(/\/+$/, "") || "/";
                push(`${u.origin}${basePath}/videos`);
                push(`${u.origin}${basePath}/video`);
                push(`${u.origin}${basePath}/all`);
                const vanity = basePath.split("/").filter(Boolean)[0] || "";
                if (vanity && !/^(?:club|public|id)\d+$/i.test(vanity)) {
                    push(`https://vk.com/${vanity}?section=videos`);
                    push(`https://vkvideo.ru/@${vanity}`);
                    push(`https://vkvideo.ru/@${vanity}/videos`);
                }
                const sourceId = source.channel_id || deriveSourceId(source.url);
                if (sourceId) {
                const ownerId = /\/(?:club|public)\d+/i.test(source.url) ? `-${sourceId}` : sourceId;
                push(`https://vk.com/videos${ownerId}`);
                push(`https://vk.com/video/@${sourceId}`);
                push(`https://vkvideo.ru/@${sourceId}`);
                push(`https://vkvideo.ru/@${sourceId}/videos`);
            }
        } catch { }
        return out.slice(0, 8);
    }

    async function collectSourcesFromCurrentPage(tab, autoScroll) {
        resetPlaylistState();
        if (autoScroll) {
            setStatus("Scrolling current VK page for more sources...", "Scroll");
            await autoScrollTab(tab.id);
        }
        const sources = await runInTab(tab.id, scanSourcesInPage);
        state.sources = (sources || []).map((source) => ({
            ...source,
            id: normalizeUrl(source.id || source.url || ""),
            url: normalizeUrl(source.url || source.id || ""),
            channel_id: source.channel_id || deriveSourceId(source.url || ""),
            source_type: source.source_type || deriveSourceType(source.url || ""),
        }));
        state.selectedSourceIds = new Set(state.sources.map((source) => source.id));
        renderSources();
        setStatus(`Collected ${state.sources.length} VK sources. Review and scan only what you want.`, "Sources");
        const b = bridge();
        b?.replaceVideos?.([], { folderName: "VK Sources", preserveSelection: false });
    }

    async function collectVisibleVideosFromTab(tab, autoScroll) {
        resetPlaylistState();
        if (autoScroll) {
            setStatus("Scrolling current VK page for more visible videos...", "Scroll");
            await autoScrollTab(tab.id);
        }
        const videos = await runInTab(tab.id, scanVideosInPage, [{ owner_name: "", owner_url: normalizeUrl(tab.url || "") }]);
        const deduped = dedupeVideos(videos || []);
        state.sourceVideos = deduped;
        const b = bridge();
        b?.replaceVideos?.(deduped, { folderName: "VK Explorer", preserveSelection: false });
        setStatus(`Loaded ${deduped.length} VK videos into the popup.`, "Videos");
        if (document.getElementById("check-duplicates")?.checked && deduped.length) {
            await b?.checkDuplicates?.(deduped);
            b?.refreshGrid?.();
        }
    }

    async function collectPlaylistBatchFromTab(tab, offset = 0, batchSize = PLAYLIST_BATCH_SIZE) {
        const result = await runInTab(tab.id, async (startOffset, takeCount) => {
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const normalizeUrl = (raw) => {
                try {
                    const url = new URL(raw, location.href);
                    url.hash = "";
                    url.search = "";
                    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
                    return url.href;
                } catch {
                    return "";
                }
            };
            const parseBg = (node) => {
                const bg = node?.style?.backgroundImage || "";
                const match = bg.match(/url\(["']?([^"')]+)["']?\)/i);
                return match ? match[1] : "";
            };
            const pickText = (root, selectors) => {
                for (const selector of selectors) {
                    const node = root.querySelector(selector);
                    const text = (node?.textContent || "").replace(/\s+/g, " ").trim();
                    if (text) return text;
                }
                return "";
            };
            const normalizeAssetUrl = (raw) => {
                const value = String(raw || "").trim();
                if (!value || /^data:/i.test(value)) return "";
                try { return new URL(value, location.href).href; } catch { return value; }
            };
            const pickImageUrl = (root) => {
                const candidates = [];
                root?.querySelectorAll?.("img, picture source, video, [style*='background-image']").forEach((node) => {
                    const srcset = node.getAttribute?.("srcset") || node.getAttribute?.("data-srcset") || "";
                    if (srcset) {
                        srcset.split(",").forEach((part) => {
                            const url = part.trim().split(/\s+/)[0];
                            if (url) candidates.push(url);
                        });
                    }
                    candidates.push(
                        node.getAttribute?.("data-src"),
                        node.getAttribute?.("data-lazy-src"),
                        node.getAttribute?.("data-original"),
                        node.getAttribute?.("poster"),
                        node.currentSrc,
                        node.getAttribute?.("src"),
                        parseBg(node)
                    );
                });
                for (const candidate of candidates) {
                    const url = normalizeAssetUrl(candidate);
                    if (!url || /avatar|logo|icon|sprite|emoji|svg|1x1|pixel|blank|placeholder/i.test(url)) continue;
                    return url;
                }
                return "";
            };
            const findPlaylistRow = (anchor) => {
                let best = anchor;
                let bestScore = -Infinity;
                const anchorText = (anchor?.textContent || anchor?.getAttribute?.("title") || "").replace(/\s+/g, " ").trim();
                for (let node = anchor; node && node !== document.body; node = node.parentElement) {
                    const rect = node.getBoundingClientRect();
                    const text = (node.textContent || "").replace(/\s+/g, " ").trim();
                    const imgCount = node.querySelectorAll?.("img, [style*='background-image']")?.length || 0;
                    const videoLinkCount = Array.from(node.querySelectorAll?.("a[href]") || [])
                        .filter((link) => /(?:\/video-?\d+_\d+|video-?\d+_\d+|video_ext\.php)/i.test(link.getAttribute("href") || ""))
                        .length;

                    let score = 0;
                    if (rect.width >= 180 && rect.width <= 900) score += 2;
                    if (rect.height >= 48 && rect.height <= 180) score += 3;
                    if (imgCount > 0) score += 3;
                    if (videoLinkCount >= 1 && videoLinkCount <= 4) score += 2;
                    if (text.length >= 20 && text.length <= 520) score += 2;
                    if (anchorText && text.includes(anchorText.slice(0, 40))) score += 1;
                    if (/PlaylistVideos__root|vkuiGroup__host|Group__host|CustomScrollView|Flex__host/i.test(String(node.className || ""))) score -= 8;
                    if (rect.height > 260 || imgCount > 4 || videoLinkCount > 8 || text.length > 900) score -= 8;

                    if (score > bestScore) {
                        bestScore = score;
                        best = node;
                    }
                    if (node.parentElement && node.parentElement.querySelectorAll?.("img").length > 8) break;
                }
                return best || anchor;
            };
            const cleanPlaylistTitle = (raw) => {
                const text = String(raw || "").replace(/\s+/g, " ").trim();
                if (!text) return "";
                if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(text)) return "";
                if (/^\d{1,2}:\d{2}\s+\d{1,2}:\d{2}/.test(text)) return "";
                return text.replace(/^\d{1,2}:\d{2}(?::\d{2})?\s*/g, "").trim();
            };
            const pickPlaylistTitle = (row, anchor) => {
                const sameVideoLinks = Array.from(row.querySelectorAll("a[href]")).filter((link) => {
                    const href = link.getAttribute("href") || "";
                    return /(?:\/video-?\d+_\d+|video-?\d+_\d+|video_ext\.php)/i.test(href);
                });
                const titledLink = sameVideoLinks.find((link) => {
                    const text = cleanPlaylistTitle(link.getAttribute("aria-label") || link.getAttribute("title") || link.textContent || "");
                    return text && text.length > 8 && !/^\d/.test(text);
                });
                return cleanPlaylistTitle(
                    titledLink?.getAttribute("aria-label") ||
                    titledLink?.getAttribute("title") ||
                    titledLink?.textContent ||
                    anchor.getAttribute("aria-label") ||
                    anchor.getAttribute("title") ||
                    pickText(row, ["[class*='title']", "[class*='Title']", "h3", "h4"]) ||
                    anchor.textContent ||
                    ""
                );
            };
            const playlistTitle = pickText(document, ["h1", "h2", "[class*='playlist'] h1", "[class*='playlist'] h2"]) || document.title;
            const totalReady = (() => {
                const bodyText = document.body?.innerText || "";
                const match = bodyText.match(/(\d{2,5})\s+videos?/i);
                return match ? (parseInt(match[1], 10) || 0) : 0;
            })();
            const ownerName = pickText(document, ["[class*='owner']", "[class*='channel']", "[class*='author']", "aside h1", "aside h2"]);
            const scrapeCards = () => {
                const out = [];
                const seen = new Set();
                const root =
                    document.querySelector("[class*='PlaylistVideosListContent']") ||
                    document.querySelector("[class*='PlaylistVideos__root']") ||
                    document.querySelector("[class*='playlist'][class*='List']") ||
                    document.querySelector("[class*='Playlist']") ||
                    document.querySelector("main") ||
                    document;
                const anchors = root.querySelectorAll([
                    "a[href*='/video']",
                    "a[href*='video-']",
                    "a[href*='video_ext.php']",
                    "[class*='VideoCard'] a[href]",
                    "[class*='video'] a[href]",
                ].join(","));
                anchors.forEach((anchor) => {
                    const href = anchor.getAttribute("href") || "";
                    if (!/(?:\/video-?\d+_\d+|video-?\d+_\d+|video_ext\.php)/i.test(href)) return;
                    let canonical = normalizeUrl(href);
                    const ext = href.match(/oid=(-?\d+).*?id=(\d+)/i);
                    if (ext) canonical = `${location.origin}/video${ext[1]}_${ext[2]}`;
                    const direct = href.match(/video(-?\d+_\d+)/i);
                    if (direct) canonical = `${location.origin}/video${direct[1]}`;
                    const vkId = (canonical.match(/video(-?\d+_\d+)/i) || [null, ""])[1] || "";
                    const key = vkId || canonical;
                    if (!key || seen.has(key)) return;
                    seen.add(key);
                    const row = findPlaylistRow(anchor);
                    const title = pickPlaylistTitle(row, anchor) || "VK Video";
                    out.push({
                        id: vkId || canonical,
                        vk_id: vkId,
                        title,
                        url: canonical,
                        source_url: canonical,
                        canonical_url: canonical,
                        thumbnail: pickImageUrl(row),
                        duration: pickText(row, ["[class*='duration']", "time"]),
                        views: pickText(row, ["[class*='views']", "[class*='view']"]),
                        upload_time: pickText(row, ["[class*='time']", "[class*='date']"]),
                        uploadDateLabel: pickText(row, ["[class*='time']", "[class*='date']"]),
                        owner_name: ownerName || "",
                        owner_url: location.href,
                        raw_text: (row.textContent || "").replace(/\s+/g, " ").trim(),
                        quality: "VK",
                        tags: "vk,playlist",
                    });
                });
                return out;
            };

            const targetEnd = startOffset + takeCount;
            let stable = 0;
            let prevCount = 0;
            for (let step = 0; step < 40; step += 1) {
                const items = scrapeCards();
                if (items.length >= targetEnd || (totalReady && items.length >= totalReady)) break;
                if (items.length <= prevCount) stable += 1;
                else stable = 0;
                prevCount = items.length;
                if (stable >= 10) break;
                window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
                if (document.documentElement) document.documentElement.scrollTop = document.documentElement.scrollHeight;
                await sleep(1000);
            }
            const items = scrapeCards();
            return {
                playlistTitle,
                totalReady: totalReady || items.length,
                loadedInDom: items.length,
                batch: items.slice(startOffset, startOffset + takeCount),
            };
        }, [offset, batchSize]);

        return {
            playlistTitle: result?.playlistTitle || "VK Playlist",
            totalReady: Number(result?.totalReady || 0) || 0,
            loadedInDom: Number(result?.loadedInDom || 0) || 0,
            batch: dedupeVideos(result?.batch || []),
        };
    }

    async function loadNextPlaylistBatch() {
        const tab = await getSourceTab();
        if (!tab || !isVkUrl(tab.url) || !isVkPlaylistPath("", tab.url)) {
            bridge()?.showToast?.("Open a VK playlist page first.", 2600);
            return;
        }
        const offset = state.playlist.nextOffset || 0;
        const batchSize = state.playlist.batchSize || PLAYLIST_BATCH_SIZE;
        setStatus(`Loading playlist ${offset + 1}-${offset + batchSize}...`, "Playlist");
        const result = await collectPlaylistBatchFromTab(tab, offset, batchSize);
        state.playlist.active = true;
        state.playlist.totalReady = result.totalReady || state.playlist.totalReady || result.batch.length;
        state.playlist.loadedCount = Math.min(offset + result.batch.length, state.playlist.totalReady || (offset + result.batch.length));
        state.playlist.nextOffset = offset + result.batch.length;
        state.playlist.title = result.playlistTitle || state.playlist.title;
        state.playlist.sourceUrl = tab.url || state.playlist.sourceUrl;

        const b = bridge();
        if (offset === 0) {
            b?.replaceVideos?.(result.batch, { folderName: result.playlistTitle || "VK Playlist" });
        } else {
            b?.appendVideos?.(result.batch, { folderName: result.playlistTitle || "VK Playlist" });
        }
        if (document.getElementById("check-duplicates")?.checked && result.batch.length) {
            await b?.checkDuplicates?.(b.getAllVideos?.() || []);
            b?.refreshGrid?.();
        }
        updatePlaylistUi();
        setStatus(`${state.playlist.totalReady} ready | loaded 1-${state.playlist.loadedCount} from ${state.playlist.totalReady}`, "Playlist");
    }

    async function probeVideosFromSource(source) {
        const tried = new Set();
        const candidates = buildSourceVideoCandidates(source);
        let lastError = "";
        for (const candidate of candidates) {
            if (tried.has(candidate)) continue;
            tried.add(candidate);
            let tab = null;
            try {
                tab = await openTempTab(candidate);
                await lightScrollTab(tab.id);
                let videos = await runInTab(tab.id, scanVideosInPage, [{
                    owner_name: source.name,
                    owner_url: source.url,
                }]);
                if (Array.isArray(videos) && videos.length) {
                    await chrome.tabs.remove(tab.id);
                    return dedupeVideos(videos.map((video) => ({
                        ...video,
                        owner_name: video.owner_name || source.name,
                        owner_url: video.owner_url || source.url,
                    })));
                }
                const navUrl = await runInTab(tab.id, () => {
                    const navLink = Array.from(document.querySelectorAll("a[href]")).find((link) => {
                        const href = link.getAttribute("href") || "";
                        const text = (link.textContent || "").trim();
                        return /video/i.test(href) || /(videos?|new|нов|видео)/i.test(text);
                    });
                    if (!navLink) return "";
                    try {
                        return new URL(navLink.getAttribute("href"), location.href).href;
                    } catch {
                        return "";
                    }
                });
                if (navUrl && !tried.has(normalizeUrl(navUrl))) {
                    tried.add(normalizeUrl(navUrl));
                    await chrome.tabs.update(tab.id, { url: navUrl });
                    await waitForTabComplete(tab.id);
                    await sleep(1600);
                    await lightScrollTab(tab.id);
                    videos = await runInTab(tab.id, scanVideosInPage, [{
                        owner_name: source.name,
                        owner_url: source.url,
                    }]);
                    if (Array.isArray(videos) && videos.length) {
                        await chrome.tabs.remove(tab.id);
                        return dedupeVideos(videos.map((video) => ({
                            ...video,
                            owner_name: video.owner_name || source.name,
                            owner_url: video.owner_url || source.url,
                        })));
                    }
                }
                await chrome.tabs.remove(tab.id);
            } catch (error) {
                lastError = error?.message || String(error);
                log("source scan failed", source.url, candidate, error);
                if (tab?.id) {
                    try { await chrome.tabs.remove(tab.id); } catch { }
                }
            }
        }
        if (lastError) {
            state.sourceScanErrors.push({ source: source.name, url: source.url, error: lastError });
        }
        return [];
    }

    async function scanSelectedSources() {
        const selected = getSelectedSources().slice(0, MAX_SELECTED_SOURCE_SCAN);
        if (!selected.length) {
            bridge()?.showToast?.("Select at least one VK source first.", 2600);
            return;
        }
        state.sourceScanErrors = [];
        const allFound = [];
        setStatus(`Scanning ${selected.length} selected VK sources...`, "Run");
        for (let i = 0; i < selected.length; i += 1) {
            const source = selected[i];
            setStatus(`Scanning ${source.name} (${i + 1}/${selected.length})`, `${i + 1}/${selected.length}`);
            const videos = await probeVideosFromSource(source);
            allFound.push(...videos.slice(0, MAX_VIDEOS_PER_PAGE));
        }
        const deduped = dedupeVideos(allFound);
        state.sourceVideos = deduped;
        const b = bridge();
        b?.replaceVideos?.(deduped, { folderName: "VK Explorer", preserveSelection: false });
        if (document.getElementById("check-duplicates")?.checked && deduped.length) {
            await b?.checkDuplicates?.(deduped);
            b?.refreshGrid?.();
        }
        const errorSuffix = state.sourceScanErrors.length ? ` ${state.sourceScanErrors.length} source scans had fallback errors.` : "";
        setStatus(`Collected ${deduped.length} VK videos from ${selected.length} sources.${errorSuffix}`, "Done");
    }

    function exportSelectedAsJson() {
        const b = bridge();
        const selected = b?.getSelectedVideos?.() || [];
        if (!selected.length) {
            b?.showToast?.("Select VK videos first.", 2400);
            return;
        }
        const blob = new Blob([JSON.stringify(selected, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        chrome.downloads.download({
            url,
            filename: `nexus-vk-selected-${stamp}.json`,
            saveAs: false,
        }, () => {
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        });
        b?.showToast?.(`Exported ${selected.length} VK videos as JSON.`, 2600);
    }

    async function importSelectedVideos() {
        const b = bridge();
        const selected = b?.getSelectedVideos?.() || [];
        if (!selected.length) {
            b?.showToast?.("Select VK videos first.", 2400);
            return;
        }
        const deduped = dedupeVideos(selected);
        setStatus(`Importing ${deduped.length} selected VK videos...`, "Import");
        await b?.importVideos?.(deduped, `VK Explorer ${new Date().toLocaleDateString()}`);
        setStatus(`Imported ${deduped.length} selected VK videos via the existing dashboard endpoint.`, "Done");
    }

    async function importFilteredVideos() {
        const b = bridge();
        const filtered = b?.getFilteredVideos?.() || [];
        if (!filtered.length) {
            b?.showToast?.("Current VK filter is empty.", 2400);
            return;
        }
        const deduped = dedupeVideos(filtered);
        setStatus(`Importing ${deduped.length} filtered VK videos...`, "Import");
        await b?.importVideos?.(deduped, `VK Explorer filtered ${new Date().toLocaleDateString()}`);
        setStatus(`Imported ${deduped.length} filtered VK videos.`, "Done");
    }

    async function scanCurrentPage() {
        const tab = await getSourceTab();
        if (!tab || !isVkUrl(tab.url)) {
            bridge()?.showToast?.("Open a VK page first.", 2400);
            return;
        }
        state.tabId = tab.id;
        const pathname = (() => {
            try {
                return new URL(tab.url).pathname.toLowerCase();
            } catch {
                return "";
            }
        })();
        if (isVkPlaylistPath(pathname, tab.url)) {
            resetPlaylistState();
            await loadNextPlaylistBatch();
            return;
        }
        if (isVkSourceListPath(pathname)) {
            await collectSourcesFromCurrentPage(tab, true);
            return;
        }
        await collectVisibleVideosFromTab(tab, false);
    }

    async function scanVisibleVideos() {
        const tab = await getSourceTab();
        if (!tab || !isVkUrl(tab.url)) {
            bridge()?.showToast?.("Open a VK page first.", 2400);
            return;
        }
        state.tabId = tab.id;
        if (isVkPlaylistPath("", tab.url)) {
            resetPlaylistState();
            await loadNextPlaylistBatch();
            return;
        }
        await collectVisibleVideosFromTab(tab, false);
    }

    async function autoScrollAndCollect() {
        const tab = await getSourceTab();
        if (!tab || !isVkUrl(tab.url)) {
            bridge()?.showToast?.("Open a VK page first.", 2400);
            return;
        }
        state.tabId = tab.id;
        const pathname = (() => {
            try {
                return new URL(tab.url).pathname.toLowerCase();
            } catch {
                return "";
            }
        })();
        if (isVkPlaylistPath(pathname, tab.url)) {
            resetPlaylistState();
            await loadNextPlaylistBatch();
            return;
        }
        if (isVkSourceListPath(pathname)) {
            await collectSourcesFromCurrentPage(tab, true);
            return;
        }
        await collectVisibleVideosFromTab(tab, true);
    }

    function init() {
        document.getElementById("vk-scan-current-btn")?.addEventListener("click", () => scanCurrentPage().catch((error) => {
            log("scan current failed", error);
            bridge()?.showToast?.(`VK scan failed: ${error.message}`, 3200);
        }));
        document.getElementById("vk-scan-visible-btn")?.addEventListener("click", () => scanVisibleVideos().catch((error) => {
            log("scan visible failed", error);
            bridge()?.showToast?.(`VK scan failed: ${error.message}`, 3200);
        }));
        document.getElementById("vk-autoscroll-btn")?.addEventListener("click", () => autoScrollAndCollect().catch((error) => {
            log("autoscroll failed", error);
            bridge()?.showToast?.(`VK auto-scroll failed: ${error.message}`, 3200);
        }));
        document.getElementById("vk-load-next-btn")?.addEventListener("click", () => loadNextPlaylistBatch().catch((error) => {
            log("load next failed", error);
            bridge()?.showToast?.(`VK playlist load failed: ${error.message}`, 3400);
        }));
        document.getElementById("vk-select-all-sources-btn")?.addEventListener("click", () => {
            state.selectedSourceIds = new Set(state.sources.map((source) => source.id));
            renderSources();
            setStatus(`${state.selectedSourceIds.size} selected sources`, "Ready");
        });
        document.getElementById("vk-clear-sources-btn")?.addEventListener("click", () => {
            state.selectedSourceIds.clear();
            renderSources();
            setStatus("Source selection cleared.", "Ready");
        });
        document.getElementById("vk-scan-sources-btn")?.addEventListener("click", () => scanSelectedSources().catch((error) => {
            log("scan sources failed", error);
            bridge()?.showToast?.(`VK source scan failed: ${error.message}`, 3400);
        }));
        document.getElementById("vk-export-json-btn")?.addEventListener("click", exportSelectedAsJson);
        document.getElementById("vk-import-btn")?.addEventListener("click", () => importSelectedVideos().catch((error) => {
            log("vk import failed", error);
            bridge()?.showToast?.(`VK import failed: ${error.message}`, 3200);
        }));
    }

    function activateForTab(tab) {
        state.active = true;
        state.tabId = tab?.id || state.tabId || null;
        setPanelMode(true);
        setStatus("VK scanner active. Review sources/videos in the popup before import.", "Ready");
        updatePlaylistUi();
    }

    function deactivate() {
        state.active = false;
        state.tabId = null;
        setPanelMode(false);
        resetPlaylistState();
    }

    window.NexusVkScanner = {
        init,
        isVkUrl,
        isActive: () => !!state.active,
        activateForTab,
        deactivate,
        scanCurrentPage,
        scanVisibleVideos,
        autoScrollAndCollect,
        loadNextPlaylistBatch,
        scanSelectedSources,
        exportSelectedAsJson,
        importSelectedVideos,
        importFilteredVideos,
    };
})();
