(function () {
    'use strict';
    if (!/(^|\.)eporner\.com$/i.test(location.hostname) || !globalThis.NexusEpornerMix) return;

    const MIX = globalThis.NexusEpornerMix;
    const STORAGE_KEY = 'nexus_eporner_playlist_studio_v1';
    const OVERLAY_ID = 'nexus-ep-playlist-studio';
    const LAUNCHER_ID = 'nexus-ep-playlist-launcher';
    const CARD_MARK = 'data-nexus-playlist-studio';
    const state = {
        playlists: new Map(), selectedPlaylists: new Set(), videos: new Map(), selectedVideos: new Set(),
        view: 'playlists', search: '', sort: 'quality', layout: 'standard',
        selectedOnly: false, dupesOnly: false, qualityFloor: 0, lastRangeKey: '',
        busy: false, stopRequested: false, exact: false, duplicates: 0, persistenceLimited: false,
    };
    const LAYOUTS = new Set(['comfort', 'standard', 'compact', 'dense', 'list']);

    function isPlaylistVideoListingPage() {
        return /^\/profile\/[^/]+\/playlist\/[A-Za-z0-9]+(?:\/[^/?#]+)?(?:\/\d+)?\/?$/i.test(location.pathname);
    }

    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
    const send = message => new Promise(resolve => chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(response);
    }));
    const playlistId = url => String(url || '').match(/\/playlist\/([A-Za-z0-9]+)/i)?.[1]?.toLowerCase() || '';
    const videoId = url => MIX.videoIdentity(url);
    const safeVideoUrl = raw => {
        try {
            const url = new URL(String(raw || ''));
            return /^https?:$/.test(url.protocol) && /(^|\.)eporner\.com$/i.test(url.hostname)
                && /\/(?:video-|hd-porn\/)[A-Za-z0-9]+/i.test(url.pathname) ? url.href : '';
        } catch (_) { return ''; }
    };
    const humanBytes = bytes => {
        let value = Number(bytes || 0);
        if (!value) return '—';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let unit = 0;
        while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
        return `${value >= 10 || unit < 2 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
    };
    const humanDuration = seconds => {
        const total = Math.max(0, Number(seconds || 0));
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        return hours ? `${hours} h ${minutes} min` : `${minutes} min`;
    };
    const averagePlaylistHeight = histogram => {
        const rows = Object.entries(histogram || {});
        const count = rows.reduce((sum, [, value]) => sum + Number(value || 0), 0);
        if (!count) return 0;
        return Math.round(rows.reduce((sum, [height, value]) => sum + Number(height || 0) * Number(value || 0), 0) / count / 10) * 10;
    };

    function saveFastFetchSummary(playlist, completion) {
        const summary = completion?.summary || {};
        const histogram = summary.quality_histogram || {};
        playlist.fast_fetch = {
            video_count: Number(summary.video_count || completion?.count || playlist.count || 0),
            duration: Number(summary.total_duration || 0),
            low_bytes: Number(summary.estimated_size_low_bytes || 0),
            high_bytes: Number(summary.estimated_size_high_bytes || 0),
            quality_histogram: histogram,
            average_height: averagePlaylistHeight(histogram),
            complete: Boolean(summary.complete ?? completion?.complete),
            scanned_at: Date.now(),
        };
        playlist.count = playlist.fast_fetch.video_count || playlist.count;
    }

    function renderSourcePlaylistSummary(card, playlist) {
        if (!card || !playlist) return;
        let node = card.querySelector('.nexus-ep-playlist-fast-summary');
        const data = playlist.fast_fetch;
        if (!data?.scanned_at) {
            node?.remove();
            return;
        }
        if (!node) {
            node = document.createElement('span');
            node.className = 'nexus-ep-playlist-fast-summary';
            card.appendChild(node);
        }
        delete node.dataset.error;
        const size = data.low_bytes || data.high_bytes
            ? `≈ ${humanBytes(data.low_bytes)}–${humanBytes(data.high_bytes)}` : '≈ veľkosť neznáma';
        const quality = data.average_height ? `≈ ${data.average_height}p` : 'kvalita neznáma';
        const partial = data.complete ? '' : ' · čiastočné';
        node.textContent = `${size} · ${humanDuration(data.duration)} · ${quality}${partial}`;
        node.title = `Fast Fetch: ${data.video_count || playlist.count || 0} videí. Veľkosť je odhad z dĺžok a listingovej kvality; nie je to download ani MP4 probe.`;
    }

    function renderSourcePlaylistError(card, error) {
        if (!card) return;
        let node = card.querySelector('.nexus-ep-playlist-fast-summary');
        if (!node) {
            node = document.createElement('span');
            node.className = 'nexus-ep-playlist-fast-summary';
            card.appendChild(node);
        }
        node.dataset.error = '1';
        node.textContent = `⚠ Fast Fetch: ${String(error || 'zlyhal').slice(0, 80)}`;
        node.title = String(error || 'Fast Fetch zlyhal');
    }

    async function fastFetchPlaylist(playlist, card, button) {
        if (!playlist?.url || state.busy) return;
        const normalized = MIX.normalizePlaylistUrl(playlist.url);
        if (!normalized) {
            setStudioStatus('Fast Fetch odmietol neplatnú playlist URL.', true);
            return;
        }
        state.busy = true;
        const previous = button?.textContent;
        if (button) { button.disabled = true; button.textContent = '⚡ Čítam…'; }
        updateCounters();
        try {
            // The extension sends only a normalized HTTPS Eporner playlist URL
            // to the local, allowlisted streaming endpoint. It fetches listing
            // pages only; no stream URL, Range request, or MP4 download occurs.
            const response = await send({ action: 'EPORNER_FAST_SCAN_PLAYLISTS', playlists: [{ ...playlist, url: normalized }] });
            if (!response?.ok) throw new Error(response?.error || 'Fast Fetch zlyhal.');
            const completion = (response.events || []).find(event => event.type === 'playlist');
            if (!completion) throw new Error('Fast Fetch nevrátil playlistové metadáta.');
            saveFastFetchSummary(playlist, completion);
            renderSourcePlaylistSummary(card, playlist);
            save();
            setStudioStatus(`Fast Fetch: ${playlist.fast_fetch.video_count} videí · ${humanDuration(playlist.fast_fetch.duration)} · ≈ ${humanBytes(playlist.fast_fetch.low_bytes)}–${humanBytes(playlist.fast_fetch.high_bytes)}.`);
        } catch (error) {
            renderSourcePlaylistError(card, error.message || 'zlyhal');
            setStudioStatus(error.message || 'Fast Fetch zlyhal.', true);
        } finally {
            state.busy = false;
            if (button) { button.disabled = false; button.textContent = previous || '⚡ Fast Fetch'; }
            updateCounters();
        }
    }

    function load() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            (saved.playlists || []).forEach(item => {
                const url = MIX.normalizePlaylistUrl(item?.url);
                if (url) state.playlists.set(playlistId(url), { ...item, url });
            });
            (saved.selectedPlaylists || []).forEach(id => state.selectedPlaylists.add(id));
            (saved.videos || []).forEach(item => {
                const url = safeVideoUrl(item?.source_url || item?.url);
                if (url) state.videos.set(videoId(url), { ...item, url, source_url: url });
            });
            (saved.selectedVideos || []).forEach(id => state.selectedVideos.add(id));
            state.exact = Boolean(saved.exact);
            state.duplicates = Number(saved.duplicates || 0);
            if (LAYOUTS.has(saved.layout)) state.layout = saved.layout;
            if (state.videos.size && state.selectedVideos.size === state.videos.size) state.selectedVideos.clear();
        } catch (_) { /* start clean */ }
    }

    function save() {
        const payload = {
            version: 1,
            playlists: [...state.playlists.values()],
            selectedPlaylists: [...state.selectedPlaylists],
            videos: [...state.videos.values()],
            selectedVideos: [...state.selectedVideos],
            exact: state.exact,
            duplicates: state.duplicates,
            layout: state.layout,
        };
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
            state.persistenceLimited = false;
        } catch (_) {
            state.persistenceLimited = true;
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify({
                    version: 1,
                    playlists: payload.playlists,
                    selectedPlaylists: payload.selectedPlaylists,
                    videos: [],
                    selectedVideos: [],
                    exact: false,
                    duplicates: payload.duplicates,
                }));
            } catch (_) { /* keep the live in-memory mix */ }
            setStudioStatus('Mix je príliš veľký na lokálnu históriu; živé dáta ostávajú otvorené.', true);
        }
    }

    function selectedPlaylists() {
        return [...state.selectedPlaylists].map(id => state.playlists.get(id)).filter(Boolean);
    }

    function selectionSet() {
        return state.view === 'videos' ? state.selectedVideos : state.selectedPlaylists;
    }

    function rowKey(item) {
        return state.view === 'videos' ? videoId(item.source_url || item.url) : item.id;
    }

    function matchesQuery(item, query) {
        if (!query) return true;
        const hay = [
            item.title, item.filename, item.uploader, item.rating,
            ...(item.playlist_sources || []).map(source => source.title),
        ].join(' ').toLocaleLowerCase();
        return query.split(/\s+/).filter(Boolean).every(token => hay.includes(token));
    }

    function visiblePlaylists() {
        const query = state.search.trim().toLocaleLowerCase();
        return selectedPlaylists().filter(item => matchesQuery(item, query));
    }

    function visibleVideos() {
        const query = state.search.trim().toLocaleLowerCase();
        const rows = [...state.videos.values()].filter(item => {
            const key = videoId(item.source_url || item.url);
            if (state.selectedOnly && !state.selectedVideos.has(key)) return false;
            if (state.dupesOnly && Number((item.playlist_sources || []).length) < 2) return false;
            if (state.qualityFloor && Number(item.height || 0) < state.qualityFloor) return false;
            return matchesQuery(item, query);
        });
        rows.sort((a, b) => {
            if (state.sort === 'title') return String(a.title || '').localeCompare(String(b.title || ''));
            if (state.sort === 'duration') return Number(b.duration || 0) - Number(a.duration || 0);
            if (state.sort === 'rating') return (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0);
            if (state.sort === 'views') return Number(b.views || 0) - Number(a.views || 0);
            if (state.sort === 'size') return Number(b.size_bytes || 0) - Number(a.size_bytes || 0);
            return Number(b.height || 0) - Number(a.height || 0);
        });
        return rows;
    }

    function summary() {
        const videos = [...state.videos.values()];
        const duration = videos.reduce((sum, item) => sum + Number(item.duration || 0), 0);
        const exactBytes = videos.reduce((sum, item) => sum + Number(item.size_bytes || 0), 0);
        const estimate = MIX.estimateSize(videos);
        const histogram = {};
        videos.forEach(item => {
            const key = String(MIX.heightBucket(item.height));
            histogram[key] = (histogram[key] || 0) + 1;
        });
        return { videos, duration, exactBytes, estimate, histogram, exact: MIX.hasExactSizes(videos) };
    }

    function updateCounters() {
        const button = document.getElementById(LAUNCHER_ID);
        if (button) button.querySelector('b').textContent = String(state.selectedPlaylists.size);
        const rail = document.querySelector('[data-nexus-playlist-basket]');
        if (rail) {
            rail.querySelector('[data-role="basket-count"]').textContent =
                `${state.selectedPlaylists.size} playlistov · ${[...state.selectedPlaylists].reduce((sum, id) => sum + Number(state.playlists.get(id)?.count || 0), 0)} videí`;
            rail.querySelectorAll('button').forEach(buttonEl => {
                if (buttonEl.dataset.role !== 'playlist-studio') buttonEl.disabled = state.busy || !state.selectedPlaylists.size;
            });
        }
        const stopButton = document.querySelector(`#${OVERLAY_ID} [data-role="stop"]`);
        if (stopButton) stopButton.disabled = !state.busy;
        refreshBulkBar();
        renderStudio();
    }

    function visibleRows() {
        return state.view === 'playlists' ? visiblePlaylists() : visibleVideos();
    }

    function refreshBulkBar() {
        const overlay = document.getElementById(OVERLAY_ID);
        if (!overlay) return;
        const rows = overlay.classList.contains('open') ? visibleRows() : [];
        const selectedVisible = rows.filter(item => selectionSet().has(rowKey(item))).length;
        const totalSelected = selectionSet().size;
        const count = overlay.querySelector('[data-role="bulk-count"]');
        if (count) {
            const filter = state.search.trim();
            count.textContent = state.view === 'videos'
                ? (filter
                    ? `${selectedVisible} z ${rows.length} po filtri „${filter}“ · ${totalSelected} označených`
                    : `${totalSelected} označených z ${state.videos.size} videí`)
                : `${totalSelected} playlistov v košíku`;
        }
        const hint = overlay.querySelector('[data-role="hint"]');
        if (hint) hint.textContent = studioHint();
        const deepButton = overlay.querySelector('[data-role="deep-resolve"]');
        if (deepButton && !state.busy) deepButton.textContent = state.selectedVideos.size ? `Presné veľkosti (${state.selectedVideos.size})` : 'Presné veľkosti';
        const testerButton = overlay.querySelector('[data-role="open-tester"]');
        if (testerButton) testerButton.textContent = state.selectedVideos.size ? `Do Testera (${state.selectedVideos.size})` : 'Do Testera';
        const exportSelected = overlay.querySelector('[data-role="export-selected"]');
        const exportCount = filteredSelectedVideos().length;
        if (exportSelected) exportSelected.textContent = exportCount ? `Export označených (${exportCount})` : 'Export označených';
        overlay.querySelectorAll('[data-role="fast-scan"], [data-role="deep-resolve"], [data-role="open-tester"]').forEach(button => {
            button.disabled = state.busy;
        });
        overlay.querySelector('[data-role="show-selected"]')?.toggleAttribute('data-active', state.selectedOnly);
        overlay.querySelector('[data-role="dupes-only"]')?.toggleAttribute('data-active', state.dupesOnly);
        const floor = overlay.querySelector('[data-role="quality-floor"]');
        if (floor && floor.value !== String(state.qualityFloor)) floor.value = String(state.qualityFloor);
    }

    function studioHint() {
        if (state.view === 'playlists') {
            return '1. Zaškrtni playlisty na stránke. 2. Fast Scan ich zloží do jednej mriežky, veľkosť je zatiaľ len odhad. 3. Vo videách označ, čo má ísť ďalej.';
        }
        if (!state.videos.size) return 'Fast Scan ešte nebežal. Po ňom filtruj názov, označ viditeľné a až potom rieš veľkosť, Tester alebo export.';
        if (!state.selectedVideos.size) return 'Nič nie je označené. Filter hore len schová karty. Vybrať viditeľné ich zaškrtne. Do Testera, presné veľkosti aj Export označených idú výhradne po zaškrtnutých.';
        return `Zaškrtnutých je ${state.selectedVideos.size}. Presné veľkosti a Tester idú po všetkých zaškrtnutých. Export označených uloží len tie, ktoré filter nechá viditeľné, a bez playlistov.`;
    }

    function listedExact(item) {
        return Number(item?.size_bytes) > 0 && !item?.size_estimated;
    }

    function selectedVideoRecords() {
        return [...state.videos.values()].filter(item => state.selectedVideos.has(videoId(item.source_url || item.url)));
    }

    function filteredSelectedVideos() {
        return visibleVideos().filter(item => state.selectedVideos.has(videoId(item.source_url || item.url)));
    }

    function videoExportRow(item) {
        const row = { ...item };
        delete row.playlist_sources;
        return row;
    }

    function applyVisibleSelection(mode) {
        const rows = visibleRows();
        const target = selectionSet();
        if (mode === 'all') rows.forEach(item => target.add(rowKey(item)));
        else if (mode === 'none') rows.forEach(item => target.delete(rowKey(item)));
        else rows.forEach(item => {
            const key = rowKey(item);
            if (target.has(key)) target.delete(key); else target.add(key);
        });
        save();
        renderStudio();
        setStudioStatus(mode === 'all'
            ? `Označených ${rows.length} viditeľných kariet.`
            : mode === 'none' ? 'Výber na viditeľných kartách zrušený.' : 'Viditeľný výber invertovaný.');
    }

    function selectRange(fromKey, toKey) {
        const keys = visibleRows().map(rowKey);
        const start = keys.indexOf(fromKey);
        const end = keys.indexOf(toKey);
        if (start < 0 || end < 0) return;
        const [lo, hi] = start < end ? [start, end] : [end, start];
        const target = selectionSet();
        keys.slice(lo, hi + 1).forEach(key => target.add(key));
        save();
        renderStudio();
    }

    function recomputeDuplicates() {
        state.duplicates = [...state.videos.values()].reduce(
            (sum, video) => sum + Math.max(0, (video.playlist_sources || []).length - 1), 0);
    }

    function syncPlaylistPickers() {
        document.querySelectorAll('.nexus-ep-playlist-picker input').forEach(input => {
            const card = input.closest(`[${CARD_MARK}]`);
            const link = card?.querySelector('a[href*="/playlist/"]');
            const id = playlistId(MIX.normalizePlaylistUrl(link?.href || ''));
            if (id) input.checked = state.selectedPlaylists.has(id);
        });
    }

    function removeSelected() {
        const keys = new Set(visibleRows().map(rowKey).filter(key => selectionSet().has(key)));
        if (!keys.size) {
            setStudioStatus('Nie je označené nič viditeľné.', true);
            return;
        }
        if (!confirm(`Zmazať ${keys.size} označených ${state.view === 'videos' ? 'videí' : 'playlistov'} z mixu?`)) return;
        if (state.view === 'videos') {
            keys.forEach(key => { state.videos.delete(key); state.selectedVideos.delete(key); });
        } else {
            keys.forEach(id => {
                state.selectedPlaylists.delete(id);
                const url = state.playlists.get(id)?.url;
                [...state.videos.values()].forEach(video => {
                    video.playlist_sources = (video.playlist_sources || []).filter(source => playlistId(source.url) !== id);
                    if (!(video.playlist_sources || []).length) {
                        const videoKey = videoId(video.source_url || video.url);
                        state.videos.delete(videoKey);
                        state.selectedVideos.delete(videoKey);
                    }
                });
                if (url) state.playlists.delete(id);
            });
            syncPlaylistPickers();
        }
        recomputeDuplicates();
        save();
        renderStudio();
        setStudioStatus(`Z mixu vyhodených ${keys.size} kariet. Fast Scan ich môže vrátiť, ak playlist ostane vybraný.`);
    }

    function keepVisible() {
        const rows = visibleRows();
        if (!rows.length) {
            setStudioStatus('Filter nič nenašiel.', true);
            return;
        }
        if (!confirm(`Ponechať len ${rows.length} viditeľných kariet (aktuálny filter) a zvyšok z mixu vyhodiť?`)) return;
        const keep = new Set(rows.map(rowKey));
        if (state.view === 'videos') {
            [...state.videos.keys()].forEach(key => {
                if (!keep.has(key)) {
                    state.videos.delete(key);
                    state.selectedVideos.delete(key);
                }
            });
        } else {
            [...state.selectedPlaylists].forEach(id => { if (!keep.has(id)) state.selectedPlaylists.delete(id); });
            syncPlaylistPickers();
        }
        recomputeDuplicates();
        save();
        renderStudio();
        setStudioStatus(`Mix zúžený na ${keep.size} viditeľných kariet.`);
    }

    function keepSelected() {
        const keep = new Set(visibleRows().map(rowKey).filter(key => selectionSet().has(key)));
        if (!keep.size) {
            setStudioStatus('Najprv označ, čo chceš nechať.', true);
            return;
        }
        if (!confirm(`Ponechať len ${keep.size} označených viditeľných kariet a zvyšok z mixu vyhodiť?`)) return;
        if (state.view === 'videos') {
            [...state.videos.keys()].forEach(key => {
                if (!keep.has(key)) {
                    state.videos.delete(key);
                    state.selectedVideos.delete(key);
                }
            });
        } else {
            [...state.selectedPlaylists].forEach(id => {
                if (keep.has(id)) return;
                state.selectedPlaylists.delete(id);
            });
            syncPlaylistPickers();
        }
        recomputeDuplicates();
        save();
        renderStudio();
        setStudioStatus(`Mix zúžený na ${keep.size} kariet.`);
    }

    async function copyVisibleSelectedUrls() {
        const urls = visibleRows()
            .filter(item => selectionSet().has(rowKey(item)))
            .map(item => item.source_url || item.url)
            .filter(Boolean);
        if (!urls.length) {
            setStudioStatus('Najprv označ videá, ktorých odkazy chceš kopírovať.', true);
            return;
        }
        const text = urls.join('\n');
        try {
            await navigator.clipboard.writeText(text);
        } catch (_) {
            const area = document.createElement('textarea');
            area.value = text;
            document.body.append(area);
            area.select();
            document.execCommand('copy');
            area.remove();
        }
        setStudioStatus(`Skopírovaných ${urls.length} označených URL.`);
    }

    function downloadJson(payload, filename) {
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const anchor = document.createElement('a');
        anchor.href = URL.createObjectURL(blob);
        anchor.download = filename;
        anchor.click();
        URL.revokeObjectURL(anchor.href);
    }

    function exportPicked() {
        const pickedVideos = filteredSelectedVideos();
        if (!pickedVideos.length) {
            setStudioStatus(state.selectedVideos.size
                ? 'Po tomto filtri nie je zaškrtnuté žiadne video. Export berie len to, čo vidíš a máš označené.'
                : 'Najprv vyfiltruj a zaškrtni videá. Export označených playlisty neukladá.', true);
            return;
        }
        downloadJson({
            version: 1,
            kind: 'selection',
            videos: pickedVideos.map(videoExportRow),
        }, `eporner-vyber-${new Date().toISOString().slice(0, 10)}.json`);
        setStudioStatus(`Export označených: ${pickedVideos.length} videí z aktuálneho filtra. Bez playlistov.`);
    }

    function collectPlaylist(link) {
        const card = link.closest('.mb, .post-data, .p-v-y');
        const url = MIX.normalizePlaylistUrl(link.href || link.getAttribute('href'));
        const id = playlistId(url);
        if (!card || !id || card.closest(`#${OVERLAY_ID}`)) return null;
        const countNode = card.querySelector('.mbphoto2_playlistico, .mbphoto2_galleryico, [class*="playlist"][class*="ico"]');
        if (!countNode && !/\/(?:search-playlists|best-playlists)\//i.test(location.pathname)) return null;
        const countText = countNode?.textContent || '';
        const item = {
            id, url,
            title: link.getAttribute('title') || link.querySelector('img')?.getAttribute('alt') || link.textContent.trim() || 'Playlist',
            thumbnail: link.querySelector('img')?.getAttribute('data-src') || link.querySelector('img')?.src || '',
            count: Number(countText.replace(/[^\d]/g, '')) || 0,
        };
        state.playlists.set(id, { ...(state.playlists.get(id) || {}), ...item });
        return { card, item };
    }

    function scanPlaylistCards() {
        let changed = false;
        document.querySelectorAll('a[href*="/playlist/"]').forEach(link => {
            const found = collectPlaylist(link);
            if (!found) return;
            if (found.card.hasAttribute(CARD_MARK)) {
                renderSourcePlaylistSummary(found.card, state.playlists.get(found.item.id));
                return;
            }
            found.card.setAttribute(CARD_MARK, '1');
            changed = true;
            found.card.querySelector('.nexus-ep-playlist-import')?.remove();
            if (getComputedStyle(found.card).position === 'static') found.card.style.position = 'relative';
            const picker = document.createElement('label');
            picker.className = 'nexus-ep-playlist-picker';
            picker.innerHTML = `<input type="checkbox" ${state.selectedPlaylists.has(found.item.id) ? 'checked' : ''}><span>Mix</span>`;
            picker.addEventListener('click', event => event.stopPropagation());
            picker.querySelector('input').addEventListener('change', event => {
                if (event.target.checked) state.selectedPlaylists.add(found.item.id);
                else state.selectedPlaylists.delete(found.item.id);
                save();
                updateCounters();
            });
            found.card.appendChild(picker);
            const fetchButton = document.createElement('button');
            fetchButton.type = 'button';
            fetchButton.className = 'nexus-ep-playlist-fast-fetch';
            fetchButton.textContent = '⚡ Fast Fetch';
            fetchButton.title = 'Listing-only: spočíta dĺžku, odhad GB a priemernú kvalitu bez sťahovania MP4.';
            fetchButton.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                fastFetchPlaylist(state.playlists.get(found.item.id), found.card, fetchButton);
            });
            found.card.appendChild(fetchButton);
            renderSourcePlaylistSummary(found.card, state.playlists.get(found.item.id));
        });
        if (changed) {
            save();
            updateCounters();
        }
    }

    function buildHandoffSnapshot(videos, selectionOnly) {
        const rows = videos || [...state.videos.values()];
        const snapshot = {
            mode: MIX.hasExactSizes(rows) ? 'deep' : 'fast',
            videos: rows,
            savedAt: Date.now(),
        };
        if (selectionOnly) snapshot.selection_only = true;
        if (new Blob([JSON.stringify(snapshot)]).size <= 8 * 1024 * 1024) return snapshot;
        if (selectionOnly) throw new Error('Označený výber je priveľký na odoslanie do Testera. Nechaj v ňom menej videí.');
        return { mode: 'fast', oversized: true, savedAt: Date.now() };
    }

    async function createMix(openTab, options = {}) {
        const selectedOnly = options.selectedOnly === true;
        let playlists = selectedPlaylists();
        if (!playlists.length) {
            setStudioStatus('Najprv zaškrtni aspoň jeden playlist.', true);
            return;
        }
        let handoffVideos = [...state.videos.values()];
        if (selectedOnly) {
            handoffVideos = selectedVideoRecords();
            if (!handoffVideos.length) {
                setStudioStatus('Do Testera idú len označené videá. Filter zúži mriežku, potom daj Vybrať viditeľné.', true);
                return;
            }
            const used = new Set();
            handoffVideos.forEach(video => (video.playlist_sources || []).forEach(source => {
                const id = playlistId(source.url);
                if (id) used.add(id);
            }));
            const narrowed = playlists.filter(item => used.has(item.id) || used.has(playlistId(item.url)));
            if (narrowed.length) playlists = narrowed;
        }
        const response = await send({
            action: 'EPORNER_CREATE_MIX',
            playlists,
            name: selectedOnly ? `Eporner výber · ${handoffVideos.length} videí` : `Eporner Mix · ${document.title}`,
            snapshot: buildHandoffSnapshot(handoffVideos, selectedOnly),
            openTab,
        });
        if (!response?.ok) throw new Error(response?.error || 'Nexus mix sa nepodarilo vytvoriť.');
        if (openTab) {
            setStudioStatus(selectedOnly
                ? `Tester má ${handoffVideos.length} označených videí. Zvyšok playlistov sa nenačítava.`
                : 'Tester načíta celé vybrané playlisty.');
        }
        return response;
    }

    async function fastScan() {
        const playlists = selectedPlaylists();
        if (!playlists.length || state.busy) return;
        state.busy = true;
        state.stopRequested = false;
        playlists.forEach(item => { item.scan_complete = false; });
        updateCounters();
        try {
            for (let index = 0; index < playlists.length; index++) {
                if (state.stopRequested) break;
                setStudioStatus(`Fast Scan: ${index}/${playlists.length} playlistov…`);
                const response = await send({ action: 'EPORNER_FAST_SCAN_PLAYLISTS', playlists: [playlists[index]] });
                if (!response?.ok) {
                    playlists[index].scan_complete = false;
                    setStudioStatus(`Playlist ${index + 1}/${playlists.length} zlyhal; pokračujem ďalším.`, true);
                    continue;
                }
                const completion = (response.events || []).find(event => event.type === 'playlist');
                playlists[index].scan_complete = Boolean(completion?.complete);
                if (completion) saveFastFetchSummary(playlists[index], completion);
                document.querySelectorAll('a[href*="/playlist/"]').forEach(link => {
                    if (playlistId(MIX.normalizePlaylistUrl(link.href || '')) !== playlistId(playlists[index].url)) return;
                    renderSourcePlaylistSummary(link.closest(`[${CARD_MARK}]`), playlists[index]);
                });
                const merged = MIX.mergeFastEvents(response.events || [], [playlists[index]]);
                for (const item of merged.videos) {
                    const key = videoId(item.source_url || item.url);
                    const existing = state.videos.get(key);
                    if (!existing) {
                        state.videos.set(key, item);
                        continue;
                    }
                    for (const source of item.playlist_sources || []) {
                        if (!(existing.playlist_sources || []).some(known => playlistId(known.url) === playlistId(source.url))) {
                            existing.playlist_sources = [...(existing.playlist_sources || []), source];
                        }
                    }
                }
                state.duplicates = [...state.videos.values()].reduce(
                    (sum, video) => sum + Math.max(0, (video.playlist_sources || []).length - 1), 0);
                state.view = 'videos';
                renderStudio();
            }
            state.exact = false;
            save();
            const incomplete = playlists.filter(item => item.scan_complete !== true).length;
            setStudioStatus(state.stopRequested
                ? `Fast Scan zastavený: ${state.videos.size} čiastočných videí. Spusti ho znova pre retry.`
                : `Fast Scan hotový: ${state.videos.size} unikátnych. Nič nie je označené — filtruj (napr. blonde) a daj Vybrať viditeľné.`);
        } catch (error) {
            setStudioStatus(error.message, true);
        } finally {
            state.busy = false;
            updateCounters();
        }
    }

    async function deepResolve() {
        if (state.busy) return;
        if (state.view !== 'videos') {
            state.view = 'videos';
            renderStudio();
        }
        const selectedAll = selectedVideoRecords();
        if (!selectedAll.length) {
            setStudioStatus('Najprv označ videá. Presné veľkosti nespúšťam na celý mix, lebo pri tisícoch kartách požiadavka len visí.', true);
            return;
        }
        const targets = selectedAll.filter(item => !listedExact(item));
        const urls = targets.map(item => item.source_url || item.url).filter(Boolean);
        if (!urls.length) {
            setStudioStatus(`Všetkých ${selectedAll.length} označených už má veľkosť z download tabuľky.`);
            return;
        }
        state.busy = true;
        state.stopRequested = false;
        updateCounters();
        let resolved = 0;
        let failed = 0;
        let lastError = '';
        try {
            for (let offset = 0; offset < urls.length; offset += 8) {
                if (state.stopRequested) break;
                const chunk = urls.slice(offset, offset + 8);
                setStudioStatus(`Presné veľkosti: ${resolved + failed}/${urls.length}. Čítam download tabuľku, MP4 sa nesťahuje.`);
                const response = await send({ action: 'EPORNER_DEEP_RESOLVE', urls: chunk });
                if (!response?.ok) {
                    failed += chunk.length;
                    lastError = response?.error || 'Nexus neodpovedal. Skontroluj, či beží lokálny server.';
                    setStudioStatus(`Presné veľkosti zastali na ${resolved}/${urls.length}. ${lastError}`, true);
                    continue;
                }
                (response.results || []).forEach(result => {
                    const key = videoId(result.url);
                    const existing = state.videos.get(key);
                    if (!existing || result.status !== 'success') {
                        failed++;
                        lastError = result.message || lastError;
                        return;
                    }
                    const data = result.data || {};
                    const sizeBytes = Number(data.size_bytes || 0);
                    let filename = data.filename || existing.filename || '';
                    try { filename ||= decodeURIComponent(new URL(data.stream_url || result.url).pathname.split('/').pop() || ''); } catch (_) {}
                    state.videos.set(key, {
                        ...existing, ...data, url: existing.url, source_url: existing.source_url || result.url,
                        size_bytes: sizeBytes,
                        size_estimated: !(sizeBytes > 0),
                        filename,
                        playlist_sources: existing.playlist_sources || [],
                    });
                    if (sizeBytes > 0) resolved++;
                    else failed++;
                });
                const answered = (response.results || []).length;
                if (answered < chunk.length) failed += chunk.length - answered;
                renderStudio();
            }
            state.exact = MIX.hasExactSizes([...state.videos.values()]);
            save();
            const exactSelected = selectedVideoRecords().filter(listedExact).length;
            if (!resolved && lastError) {
                setStudioStatus(`Presné veľkosti sa nepodarili (0/${urls.length}). ${lastError}`, true);
            } else {
                setStudioStatus(state.stopRequested
                    ? `Zastavené: ${resolved} doplnených, ${failed} zlyhalo. Ďalšie spustenie pokračuje na tých bez veľkosti.`
                    : `Presné veľkosti: ${exactSelected}/${selectedAll.length} označených má MB a názov súboru z download tabuľky.${failed ? ` ${failed} sa nepodarilo.` : ''} Zvyšok mixu ostáva odhad.`);
            }
        } catch (error) {
            setStudioStatus(error.message, true);
        } finally {
            state.busy = false;
            updateCounters();
        }
    }

    function setStudioStatus(message, error = false) {
        const status = document.querySelector(`#${OVERLAY_ID} [data-role="status"]`);
        if (status) {
            status.textContent = message;
            status.dataset.error = error ? '1' : '0';
        }
    }

    function previewUrl(item) {
        const thumb = String(item.thumbnail || '');
        const id = videoId(item.source_url || item.url);
        return thumb.startsWith('http') && thumb.includes('/') ? `${thumb.slice(0, thumb.lastIndexOf('/'))}/${id}-preview.webm` : '';
    }

    function showDetail(item) {
        const detail = document.querySelector(`#${OVERLAY_ID} [data-role="detail"]`);
        if (!detail) return;
        detail.innerHTML = `
            <button type="button" data-role="detail-close" aria-label="Zavrieť detail">×</button>
            <img src="${escapeHtml(item.thumbnail || '')}" alt="">
            <div class="nexus-ep-studio-heading">${escapeHtml(item.title || item.filename || 'Eporner video')}</div>
            <dl>
                <dt>Súbor</dt><dd>${escapeHtml(item.filename || 'Doplní sa cez Presné veľkosti')}</dd>
                <dt>Dĺžka</dt><dd>${escapeHtml(humanDuration(item.duration))}</dd>
                <dt>Kvalita</dt><dd>${escapeHtml(item.height ? `${item.height}p` : '—')}</dd>
                <dt>Veľkosť</dt><dd>${listedExact(item) ? `${escapeHtml(humanBytes(item.size_bytes))} z download tabuľky` : 'Zatiaľ len odhad celého mixu. Presné veľkosti doplnia toto video.'}</dd>
                <dt>Playlisty</dt><dd>${escapeHtml((item.playlist_sources || []).map(source => source.title).join(', ') || '—')}</dd>
                <dt>URL</dt><dd><a href="${escapeHtml(item.source_url || item.url)}" target="_blank" rel="noopener">${escapeHtml(item.source_url || item.url)}</a></dd>
            </dl>`;
        detail.classList.add('open');
        detail.querySelector('[data-role="detail-close"]').onclick = () => detail.classList.remove('open');
    }

    function renderStudio() {
        const overlay = document.getElementById(OVERLAY_ID);
        if (!overlay?.classList.contains('open')) return;
        overlay.dataset.view = state.view;
        overlay.dataset.layout = state.layout;
        overlay.querySelector('[data-role="view-playlists"]').dataset.active = state.view === 'playlists' ? '1' : '0';
        overlay.querySelector('[data-role="view-videos"]').dataset.active = state.view === 'videos' ? '1' : '0';
        const layoutSelect = overlay.querySelector('[data-role="layout"]');
        if (layoutSelect && layoutSelect.value !== state.layout) layoutSelect.value = state.layout;
        const sum = summary();
        state.exact = sum.exact;
        overlay.querySelector('[data-role="summary"]').innerHTML = `
            <span><b>${state.selectedPlaylists.size}</b> vybraných playlistov</span>
            <span><b>${sum.videos.length}</b> unikátnych</span>
            <span><b>${state.duplicates}</b> duplicít</span>
            <span><b>${humanDuration(sum.duration)}</b> spolu</span>
            <span><b>${sum.exact ? humanBytes(sum.exactBytes) : `${humanBytes(sum.estimate.low)}–${humanBytes(sum.estimate.high)}`}</b> ${sum.exact ? 'presná veľkosť' : 'odhad'}</span>
            <span><b>${sum.videos.filter(listedExact).length}</b> s MB z tabuľky</span>
            <span><b>${selectionSet().size}</b> označených</span>`;
        const rows = visibleRows();
        overlay.querySelector('[data-role="grid"]').innerHTML = rows.map(item => {
            const isVideo = state.view === 'videos';
            const key = isVideo ? videoId(item.source_url || item.url) : item.id;
            const selected = isVideo ? state.selectedVideos.has(key) : state.selectedPlaylists.has(key);
            const preview = isVideo ? previewUrl(item) : '';
            return `<div class="nexus-ep-studio-card" data-key="${escapeHtml(key)}" data-selected="${selected ? '1' : '0'}" data-exact="${isVideo && listedExact(item) ? '1' : '0'}">
                <div class="nexus-ep-studio-thumb">
                    <span class="nexus-ep-studio-ratio" aria-hidden="true"></span>
                    ${item.thumbnail ? `<img src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy">` : '<span class="empty-thumb">▶</span>'}
                    ${preview ? `<video muted loop playsinline preload="none" data-preview="${escapeHtml(preview)}"></video>` : ''}
                    <label><input type="checkbox" data-role="item-select" ${selected ? 'checked' : ''}><span>Vybrať</span></label>
                    ${isVideo && Number(item.height) ? `<span class="nexus-ep-studio-badge">${Number(item.height) >= 2160 ? '4K' : `${escapeHtml(Number(item.height))}p`}</span>` : ''}
                </div>
                <div class="nexus-ep-studio-body">
                    <span class="nexus-ep-studio-title">${escapeHtml(item.title || item.filename || 'Bez názvu')}</span>
                    <span class="nexus-ep-studio-meta">${isVideo
                        ? `${escapeHtml(humanDuration(item.duration))} · ${escapeHtml(item.rating || 'bez ratingu')} · ${Number((item.playlist_sources || []).length)} zdrojov${listedExact(item) ? ` · ${escapeHtml(humanBytes(item.size_bytes))}` : ''}`
                        : `${Number(item.count || 0)} videí`}</span>
                    ${isVideo && item.filename ? `<span class="nexus-ep-studio-file">${escapeHtml(item.filename)}</span>` : ''}
                </div>
            </div>`;
        }).join('') || `<div class="nexus-ep-studio-empty">${state.search.trim()
            ? `Filter “${escapeHtml(state.search.trim())}” nič nenašiel. Vymaž hľadanie alebo zmeň slovo.`
            : 'Vyber playlisty a spusti Fast Scan.'}</div>`;
        overlay.querySelectorAll('.nexus-ep-studio-card').forEach(card => {
            const key = card.dataset.key;
            const item = state.view === 'videos' ? state.videos.get(key) : state.playlists.get(key);
            card.querySelector('[data-role="item-select"]').addEventListener('click', event => {
                if (!event.shiftKey || !state.lastRangeKey) return;
                event.preventDefault();
                selectRange(state.lastRangeKey, key);
            });
            card.querySelector('[data-role="item-select"]').addEventListener('change', event => {
                const target = selectionSet();
                if (event.target.checked) target.add(key); else target.delete(key);
                state.lastRangeKey = key;
                card.dataset.selected = event.target.checked ? '1' : '0';
                save();
                refreshBulkBar();
                if (state.view === 'playlists') syncPlaylistPickers();
            });
            card.addEventListener('click', event => {
                if (event.target.closest('label, input, a')) return;
                if (state.view === 'videos') showDetail(item);
                else window.open(item.url, '_blank', 'noopener');
            });
            const video = card.querySelector('video[data-preview]');
            if (video) {
                card.addEventListener('mouseenter', () => { if (!video.src) video.src = video.dataset.preview; video.play().catch(() => {}); });
                card.addEventListener('mouseleave', () => { video.pause(); video.currentTime = 0; });
            }
        });
        refreshBulkBar();
    }

    function exportData() {
        downloadJson({
            version: 1, kind: 'studio', playlists: [...state.playlists.values()], videos: [...state.videos.values()],
        }, `eporner-playlist-mix-${new Date().toISOString().slice(0, 10)}.json`);
        setStudioStatus(`Záloha celého mixu: ${state.playlists.size} playlistov a ${state.videos.size} videí. Export označených je len zaškrtnutý výber.`);
    }

    function importData(file) {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(reader.result);
                (data.playlists || []).forEach(item => {
                    const url = MIX.normalizePlaylistUrl(item?.url);
                    if (url) state.playlists.set(playlistId(url), { ...item, url });
                });
                (data.videos || []).forEach(item => {
                    const url = safeVideoUrl(item?.source_url || item?.url);
                    if (url) state.videos.set(videoId(url), { ...item, url, source_url: url });
                });
                save();
                renderStudio();
                setStudioStatus(`JSON načítaný: ${state.playlists.size} playlistov, ${state.videos.size} videí.`);
            } catch (_) { setStudioStatus('JSON import nie je platný.', true); }
        };
        reader.readAsText(file);
    }

    function createStudio() {
        if (document.getElementById(OVERLAY_ID)) return;
        const launcher = document.createElement('button');
        launcher.id = LAUNCHER_ID;
        launcher.type = 'button';
        launcher.dataset.role = 'playlist-studio';
        launcher.innerHTML = '<span>▦</span><b>0</b>';
        launcher.title = 'Otvoriť Eporner Playlist Studio';

        const overlay = document.createElement('section');
        overlay.id = OVERLAY_ID;
        overlay.dataset.layout = state.layout;
        overlay.innerHTML = `
            <div data-role="chrome">
                <span data-role="brand">Eporner Playlist Studio</span>
                <div data-role="summary"></div>
                <input data-role="search" type="search" placeholder="Filter: blonde, 4k, uploader…">
                <select data-role="sort" title="Zoradiť zlúčené videá">
                    <option value="quality">Kvalita</option><option value="title">Názov</option>
                    <option value="duration">Dĺžka</option><option value="rating">Rating</option>
                    <option value="views">Views</option><option value="size">Veľkosť</option>
                </select>
                <select data-role="layout" title="Hustota mriežky: koľko kariet vedľa seba">
                    <option value="comfort">4 veľké karty</option>
                    <option value="standard" selected>6 karty</option>
                    <option value="compact">8 kompaktné</option>
                    <option value="dense">10 husté</option>
                    <option value="list">Zoznam</option>
                </select>
                <button type="button" data-role="help-toggle" title="Čo robí Fast Scan, Deep Resolve a odhad veľkosti">?</button>
                <button type="button" data-role="close">Zavrieť</button>
            </div>
            <div data-role="toolbar">
                <div data-role="actions">
                    <button type="button" data-role="view-playlists" title="Playlisty v košíku, ešte pred zlúčením videí">Playlisty</button>
                    <button type="button" data-role="view-videos" title="Jedna mriežka všetkých videí z vybraných playlistov">Videá</button>
                    <button type="button" data-role="fast-scan" title="Prečíta listing: názov, dĺžka, kvalita, náhľad. Veľkosť je odhad. Watch stránku neotvára.">Fast Scan</button>
                    <button type="button" data-role="deep-resolve" title="Len označené videá. Z watch stránky vezme názov súboru a MB z download tabuľky. MP4 nesťahuje.">Presné veľkosti</button>
                    <button type="button" data-role="stop" title="Zastaví po aktuálnej dávke a nechá, čo už stihlo">Stop</button>
                    <button type="button" data-role="open-tester" title="Otvorí /tester iba s označenými videami">Do Testera</button>
                    <details data-role="file-menu">
                        <summary>Súbor</summary>
                        <div>
                            <button type="button" data-role="export" title="Celý mix: všetky playlisty aj všetky videá. Dá sa ním štúdio obnoviť.">Záloha celého mixu</button>
                            <button type="button" data-role="import" title="Načíta zálohu alebo export označených späť do štúdia">Načítať JSON</button>
                            <button type="button" data-role="clear" title="Zmaže uložené playlisty aj videá v tomto prehliadači">Vyčistiť štúdio</button>
                        </div>
                    </details>
                </div>
                <input data-role="import-file" type="file" accept=".json" hidden>
                <span data-role="status">Zaškrtni playlisty a spusti Fast Scan.</span>
                <div data-role="bulk">
                    <span data-role="bulk-count">0 označených</span>
                    <button type="button" data-role="select-visible" title="Zaškrtne len karty, ktoré práve vidíš po filtri">Vybrať viditeľné</button>
                    <button type="button" data-role="select-none" title="Odškrtne viditeľné karty. Ostatné nechá">Zrušiť výber</button>
                    <button type="button" data-role="show-selected" title="Skryje karty, ktoré nie sú zaškrtnuté">Len označené</button>
                    <select data-role="quality-floor" title="Schová karty pod touto kvalitou">
                        <option value="0">Všetky kvality</option>
                        <option value="720">HD a viac</option>
                        <option value="1080">1080p a viac</option>
                        <option value="2160">Len 4K</option>
                    </select>
                    <button type="button" data-role="remove-selected" title="Vyhodí zaškrtnuté viditeľné karty z mixu">Vyhodiť označené</button>
                    <button type="button" data-role="keep-visible" title="V mixe ostane len to, čo práve vidíš">Nechať viditeľné</button>
                    <button type="button" data-role="copy-urls" title="Skopíruje odkazy zaškrtnutých videí">Kopírovať odkazy</button>
                    <button type="button" data-role="export-selected" title="JSON len z videí, ktoré filter ukazuje a sú zaškrtnuté. Playlisty sa neukladajú.">Export označených</button>
                    <details data-role="more-select">
                        <summary>Viac</summary>
                        <div>
                            <button type="button" data-role="select-invert" title="Zaškrtnuté viditeľné odškrtne a naopak">Obrátiť výber</button>
                            <button type="button" data-role="dupes-only" title="Ukáže videá, ktoré sú vo viacerých playlistoch">Len duplicity</button>
                            <button type="button" data-role="keep-selected" title="V mixe ostanú len zaškrtnuté viditeľné karty">Nechať označené</button>
                        </div>
                    </details>
                </div>
                <p data-role="hint">Filter hore len schová karty. Vybrať viditeľné ich zaškrtne. Do Testera, presné veľkosti aj Export označených idú len po zaškrtnutých.</p>
            </div>
            <div data-role="grid"></div>
            <div data-role="help">
                <button type="button" data-role="help-close" aria-label="Zavrieť vysvetlivky">×</button>
                <div class="nexus-ep-studio-heading">Ako Studio počíta mix</div>
                <div class="nexus-ep-studio-help-block"><b>Dva JSON exporty</b>Záloha celého mixu v menu Súbor uloží všetky playlisty aj všetky videá. Export označených uloží len videá, ktoré sú vo filtri a zaškrtnuté. Playlisty v tom súbore nie sú.</div>
                <div class="nexus-ep-studio-help-block"><b>Filter a výber</b>Filter nič nemaže, len schová karty. Vybrať viditeľné ich zaškrtne. Vyhodiť označené ich z mixu zmaže. Nechať viditeľné nechá len to, čo filter ukazuje. Shift a klik na checkbox označí rozsah.</div>
                <div class="nexus-ep-studio-help-block"><b>Fast Scan</b>Číta listing playlistu: náhľad, názov, dĺžku, kvalitu a views. Watch stránku neotvára a MP4 nesťahuje. Číslo v hlavičke je preto pásmo, nie presná veľkosť.</div>
                <div class="nexus-ep-studio-help-block"><b>Presné veľkosti</b>Starší názov bol Deep Resolve. Ide len po zaškrtnutých videách, po ôsmich. Z watch stránky prečíta download tabuľku: názov súboru a MB. MP4 nesťahuje a stream nerieši. Stop nechá hotové karty, ďalšie spustenie pokračuje na tých bez MB.</div>
                <div class="nexus-ep-studio-help-block"><b>Do Testera</b>Otvorí /tester a pošle tam iba zaškrtnuté videá. Zvyšok playlistu sa nenačítava. Košík pod stránkou má samostatné Celé playlisty: to pošle do Testera celé vybrané playlisty.</div>
                <div class="nexus-ep-studio-help-block"><b>Mriežka</b>4, 6, 8 alebo 10 kariet, prípadne zoznam. Zaškrtnutá karta má tyrkysový okraj. MB sa na karte ukáže až po presných veľkostiach.</div>
            </div>
            <div data-role="detail"></div>`;
        document.body.append(launcher, overlay);
        launcher.onclick = () => { overlay.classList.add('open'); document.documentElement.classList.add('nexus-ep-studio-open'); renderStudio(); };
        overlay.querySelector('[data-role="close"]').onclick = () => { overlay.classList.remove('open'); document.documentElement.classList.remove('nexus-ep-studio-open'); };
        overlay.querySelector('[data-role="view-playlists"]').onclick = () => { state.view = 'playlists'; renderStudio(); };
        overlay.querySelector('[data-role="view-videos"]').onclick = () => { state.view = 'videos'; renderStudio(); };
        overlay.querySelector('[data-role="fast-scan"]').onclick = fastScan;
        overlay.querySelector('[data-role="deep-resolve"]').onclick = deepResolve;
        overlay.querySelector('[data-role="stop"]').onclick = () => {
            state.stopRequested = true;
            setStudioStatus('Zastavujem po aktuálnej dávke…');
        };
        overlay.querySelector('[data-role="open-tester"]').onclick = () => createMix(true, { selectedOnly: true }).catch(error => setStudioStatus(error.message, true));
        overlay.addEventListener('click', event => {
            if (event.target.closest('details')) return;
            overlay.querySelectorAll('details[open]').forEach(menu => { menu.open = false; });
        });
        overlay.querySelector('[data-role="export"]').onclick = exportData;
        overlay.querySelector('[data-role="import"]').onclick = () => overlay.querySelector('[data-role="import-file"]').click();
        overlay.querySelector('[data-role="import-file"]').onchange = event => event.target.files[0] && importData(event.target.files[0]);
        overlay.querySelector('[data-role="clear"]').onclick = () => {
            if (!confirm('Vyčistiť uložené playlisty a videá?')) return;
            state.playlists.clear(); state.selectedPlaylists.clear(); state.videos.clear(); state.selectedVideos.clear();
            state.exact = false; state.duplicates = 0; save(); updateCounters();
        };
        overlay.querySelector('[data-role="search"]').oninput = event => { state.search = event.target.value; renderStudio(); };
        overlay.querySelector('[data-role="sort"]').onchange = event => { state.sort = event.target.value; renderStudio(); };
        overlay.querySelector('[data-role="layout"]').onchange = event => {
            if (!LAYOUTS.has(event.target.value)) return;
            state.layout = event.target.value;
            overlay.dataset.layout = state.layout;
            save();
        };
        overlay.querySelector('[data-role="select-visible"]').onclick = () => applyVisibleSelection('all');
        overlay.querySelector('[data-role="select-none"]').onclick = () => applyVisibleSelection('none');
        overlay.querySelector('[data-role="select-invert"]').onclick = () => applyVisibleSelection('invert');
        overlay.querySelector('[data-role="show-selected"]').onclick = () => { state.selectedOnly = !state.selectedOnly; renderStudio(); };
        overlay.querySelector('[data-role="dupes-only"]').onclick = () => { state.dupesOnly = !state.dupesOnly; renderStudio(); };
        overlay.querySelector('[data-role="quality-floor"]').onchange = event => {
            state.qualityFloor = Number(event.target.value || 0);
            renderStudio();
        };
        overlay.querySelector('[data-role="remove-selected"]').onclick = removeSelected;
        overlay.querySelector('[data-role="keep-selected"]').onclick = keepSelected;
        overlay.querySelector('[data-role="keep-visible"]').onclick = keepVisible;
        overlay.querySelector('[data-role="copy-urls"]').onclick = () => copyVisibleSelectedUrls().catch(error => setStudioStatus(error.message, true));
        overlay.querySelector('[data-role="export-selected"]').onclick = exportPicked;
        const help = overlay.querySelector('[data-role="help"]');
        overlay.querySelector('[data-role="help-toggle"]').onclick = () => help.classList.toggle('open');
        overlay.querySelector('[data-role="help-close"]').onclick = () => help.classList.remove('open');
    }

    function mountBasket() {
        const toolbar = document.getElementById('nexus-ep-toolbar');
        if (!toolbar || toolbar.querySelector('[data-nexus-playlist-basket]')) return;
        const basket = document.createElement('section');
        basket.className = 'nexus-ep-playlist-basket';
        basket.setAttribute('data-nexus-playlist-basket', '1');
        basket.innerHTML = `
            <strong>Playlist basket</strong><span data-role="basket-count">0 playlistov</span>
            <div>
                <button type="button" data-role="playlist-studio">Studio</button>
                <button type="button" data-role="fast-scan">Fast Scan</button>
                <button type="button" data-role="open-tester" title="Otvorí /tester a nechá ho načítať celé vybrané playlisty. V štúdiu Do Testera posiela len zaškrtnuté videá.">Celé playlisty</button>
                <button type="button" data-role="clear-playlists">Zrušiť</button>
            </div>`;
        toolbar.querySelector('.nexus-ep-stats')?.after(basket);
        basket.querySelector('[data-role="playlist-studio"]').onclick = () => document.getElementById(LAUNCHER_ID)?.click();
        basket.querySelector('[data-role="fast-scan"]').onclick = () => { document.getElementById(LAUNCHER_ID)?.click(); fastScan(); };
        basket.querySelector('[data-role="open-tester"]').onclick = () => createMix(true).catch(error => setStudioStatus(error.message, true));
        basket.querySelector('[data-role="clear-playlists"]').onclick = () => {
            state.selectedPlaylists.clear();
            document.querySelectorAll(`.${'nexus-ep-playlist-picker'} input`).forEach(input => { input.checked = false; });
            save(); updateCounters();
        };
    }

    function boot() {
        if (isPlaylistVideoListingPage()) return;
        load();
        createStudio();
        mountBasket();
        scanPlaylistCards();
        new MutationObserver(mutations => {
            const hasPlaylistCard = mutations.some(mutation => [...mutation.addedNodes].some(node =>
                node.nodeType === 1 && !node.closest?.(`#${OVERLAY_ID}`)
                && (node.matches?.('a[href*="/playlist/"], .mb, .post-data, .p-v-y')
                    || node.querySelector?.('a[href*="/playlist/"]'))));
            if (!hasPlaylistCard) return;
            window.clearTimeout(boot._timer);
            boot._timer = window.setTimeout(() => { mountBasket(); scanPlaylistCards(); }, 250);
        }).observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
