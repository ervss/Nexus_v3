/**
 * Nexus LITE — Live Gallery & Ingest Controller
 */
(function () {
    'use strict';

    // State
    const state = {
        filter: 'all',
        query: '',
        batchName: '',
        sourceBoardId: '',
        sortBy: 'date',
        sortOrder: 'desc',
        quality: '',
        videos: [],
        total: 0,
        limit: 60,
        offset: 0,
        isLoading: false,
        activeJobsCount: 0,
        activeHls: null,
        selectedIds: new Set(),
        refreshPollToken: 0,
    };

    // DOM Elements
    const elements = {
        grid: document.getElementById('gallery-grid'),
        loading: document.getElementById('gallery-loading'),
        empty: document.getElementById('gallery-empty'),
        statTotal: document.getElementById('stat-total'),
        statToday: document.getElementById('stat-today'),
        statPending: document.getElementById('stat-pending'),
        queueCard: document.getElementById('queue-stat-card'),
        jobBadge: document.getElementById('job-badge'),
        jobsDrawer: document.getElementById('jobs-drawer'),
        jobsList: document.getElementById('jobs-list'),
        jobsCountText: document.getElementById('jobs-count-text'),
        importDrawer: document.getElementById('fast-import-panel'),
        importUrls: document.getElementById('import-urls'),
        importBatch: document.getElementById('import-batch'),
        btnSubmitImport: document.getElementById('btn-submit-import'),
        btnToggleImport: document.getElementById('btn-toggle-import'),
        btnCloseImport: document.getElementById('btn-close-import'),
        btnToggleJobs: document.getElementById('btn-toggle-jobs'),
        btnRefresh: document.getElementById('btn-refresh'),
        filterInput: document.getElementById('filter-input'),
        clearSearch: document.getElementById('clear-search'),
        filterPills: document.querySelectorAll('.filter-pill'),
        batchFilter: document.getElementById('lite-batch-filter'),
        sourceBoardFilter: document.getElementById('lite-source-board-filter'),
        clearScopeFilters: document.getElementById('lite-clear-scope-filters'),
        sortBy: document.getElementById('lite-sort-by'),
        qualityFilter: document.getElementById('lite-quality-filter'),
        sortOrder: document.getElementById('lite-sort-order'),
        btnEmptyImport: document.getElementById('btn-empty-import'),
        batchBar: document.getElementById('lite-batch-bar'),
        selectedCount: document.getElementById('lite-selected-count'),
        batchMessage: document.getElementById('lite-batch-message'),
        
        // Modal
        videoModal: document.getElementById('video-modal'),
        modalBackdrop: document.getElementById('modal-backdrop'),
        modalCloseBtn: document.getElementById('modal-close-btn'),
        modalTitle: document.getElementById('modal-video-title'),
        modalSourceBtn: document.getElementById('modal-source-btn'),
        modalPlayer: document.getElementById('lite-player'),
        modalQuality: document.getElementById('modal-quality-badge'),
        modalDuration: document.getElementById('modal-duration-badge'),
        modalSize: document.getElementById('modal-size-badge'),
        modalBatch: document.getElementById('modal-batch-badge'),
    };

    // -------------------------------------------------------------------------
    // API Fetchers
    // -------------------------------------------------------------------------
    async function fetchVideos(reset = true) {
        if (reset) {
            state.offset = 0;
            state.isLoading = true;
            elements.loading.style.display = 'block';
            elements.empty.style.display = 'none';
        }

        try {
            const params = new URLSearchParams({
                limit: state.limit,
                offset: state.offset,
                filter_mode: state.filter,
                sort_by: state.sortBy,
                sort_order: state.sortOrder,
            });
            if (state.query.trim()) {
                params.append('q', state.query.trim());
            }
            if (state.batchName) {
                params.append('batch_name', state.batchName);
            }
            if (state.sourceBoardId) {
                params.append('source_board_id', state.sourceBoardId);
            }
            if (state.quality) {
                params.append('quality', state.quality);
            }

            const res = await fetch(`/api/lite/videos?${params.toString()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            if (reset) {
                state.videos = data.items || [];
            } else {
                state.videos.push(...(data.items || []));
            }
            state.total = data.total || 0;

            renderGrid();
        } catch (err) {
            console.error('Chyba načítavania videí:', err);
        } finally {
            state.isLoading = false;
            elements.loading.style.display = 'none';
        }
    }

    async function fetchFilterOptions() {
        try {
            const res = await fetch('/api/lite/filter-options');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const batches = Array.isArray(data.batches) ? data.batches : [];
            const boards = Array.isArray(data.source_boards) ? data.source_boards : [];

            elements.batchFilter.innerHTML = '<option value="">Všetky batchy</option>' + batches
                .map(batch => `<option value="${escapeHtml(batch.name)}">${escapeHtml(batch.name)} (${Number(batch.count || 0).toLocaleString()})</option>`)
                .join('');
            elements.sourceBoardFilter.innerHTML = '<option value="">Všetky Source Boardy</option>' + boards
                .map(board => `<option value="${Number(board.id)}">${escapeHtml(board.name)} (${Number(board.count || 0).toLocaleString()})</option>`)
                .join('');
            elements.batchFilter.value = state.batchName;
            elements.sourceBoardFilter.value = state.sourceBoardId;
        } catch (err) {
            console.warn('LITE filter options error:', err);
        }
    }

    function updateScopeClearButton() {
        elements.clearScopeFilters.hidden = !state.batchName && !state.sourceBoardId;
    }

    async function fetchStats() {
        try {
            const res = await fetch('/api/lite/stats');
            if (!res.ok) return;
            const stats = await res.json();

            elements.statTotal.textContent = stats.total_videos.toLocaleString();
            elements.statToday.textContent = stats.today_count.toLocaleString();
            elements.statPending.textContent = stats.pending_queue.toLocaleString();

            state.activeJobsCount = stats.active_jobs || 0;
            if (state.activeJobsCount > 0) {
                elements.jobBadge.style.display = 'inline-block';
                elements.jobBadge.textContent = state.activeJobsCount;
                elements.queueCard.classList.add('pulse-active');
            } else {
                elements.jobBadge.style.display = 'none';
                elements.queueCard.classList.remove('pulse-active');
            }
        } catch (err) {
            console.warn('Stats fetch error:', err);
        }
    }

    async function fetchJobs() {
        try {
            const res = await fetch('/api/lite/import-monitor');
            if (!res.ok) return;
            const data = await res.json();
            const jobs = data.jobs || [];

            elements.jobsCountText.textContent = `${jobs.length} úloh`;

            if (jobs.length === 0) {
                elements.jobsList.innerHTML = '<div class="empty-jobs">Žiadne prebiehajúce úlohy vo fronte.</div>';
                return;
            }

            elements.jobsList.innerHTML = jobs.slice(0, 10).map(job => {
                const isRunning = job.status === 'running' || job.status === 'extracting';
                const statusColor = isRunning ? 'var(--lime)' : job.status === 'failed' ? 'var(--danger)' : 'var(--muted)';
                const processed = (job.imported_items || 0) + (job.failed_items || 0) + (job.duplicate_items || 0) + (job.cancelled_items || 0);
                const pct = job.total_items > 0 ? Math.round((processed / job.total_items) * 100) : 0;
                
                return `
                    <div class="job-item">
                        <div>
                            <strong style="color: #fff;">#${job.id} ${escapeHtml(job.batch_name || 'Import')}</strong>
                            <div style="color: var(--dim); font-size: 9.5px; margin-top: 2px;">
                                Položky: ${processed} / ${job.total_items || 0} (${pct}%)
                            </div>
                        </div>
                        <div style="text-align: right;">
                            <span style="color: ${statusColor}; text-transform: uppercase; font-weight: 700;">${escapeHtml(job.status)}</span>
                        </div>
                    </div>
                    <details class="nexus-playback-activity" open><summary>Aktuálna činnosť každej položky importu #${job.id}</summary>
                    ${(job.items || []).map(item => `<div><strong>${escapeHtml(item.title || item.source_host || `Položka ${item.id}`)}</strong> — ${escapeHtml(item.phase_label || item.status)}<br>${escapeHtml(item.status_detail || '')}<br>${escapeHtml(item.last_event?.message || '')}${item.error ? `<br>Dôvod: ${escapeHtml(item.error)}` : ''}${item.status === 'pending_retry' ? '<br>Riešenie: automaticky čakám na ďalší pokus.' : item.status === 'failed' ? '<br>Riešenie: overte zdroj / prihlásenie a zopakujte import.' : ''}</div>`).join('')}
                    </details>
                `;
            }).join('');
        } catch (err) {
            console.warn('Jobs monitor error:', err);
        }
    }

    // -------------------------------------------------------------------------
    // Rendering
    // -------------------------------------------------------------------------
    function renderGrid() {
        if (!state.videos || state.videos.length === 0) {
            elements.grid.innerHTML = '';
            elements.empty.style.display = 'block';
            return;
        }

        elements.empty.style.display = 'none';
        elements.grid.innerHTML = state.videos.map(v => createCardHTML(v)).join('');

        // Attach card events
        elements.grid.querySelectorAll('.card').forEach(cardEl => {
            const videoId = parseInt(cardEl.dataset.id, 10);
            const videoObj = state.videos.find(x => x.id === videoId);

            // Click on thumb -> open video player modal
            const thumbWrap = cardEl.querySelector('.thumb-wrap');
            if (thumbWrap && videoObj) {
                thumbWrap.onclick = (e) => {
                    e.stopPropagation();
                    openVideoModal(videoObj);
                };
            }

            const selectBox = cardEl.querySelector('.card-select');
            if (selectBox) {
                selectBox.onchange = () => toggleCardSelection(videoId, selectBox.checked);
            }

            const details = cardEl.querySelector('.card-details');
            if (details && videoObj) {
                details.onclick = (e) => {
                    if (e.target.closest('button')) return;
                    toggleCardSelection(videoId, !state.selectedIds.has(videoId));
                };
            }

            // Delete button
            const delBtn = cardEl.querySelector('.btn-card-del');
            if (delBtn) {
                delBtn.onclick = async (e) => {
                    e.stopPropagation();
                    if (confirm(`Naozaj vymazať "${videoObj?.title || 'video'}"?`)) {
                        await deleteVideo(videoId, cardEl);
                    }
                };
            }
        });
    }

    function createCardHTML(v) {
        const qualityClass = (v.quality || '').toLowerCase().includes('4k') ? 'four-k' : '';
        const sourceName = extractDomain(v.source_url || v.url || v.batch_name || 'NEXUS');
        const statusBadge = v.status !== 'ready' && v.status !== 'completed' && v.status !== 'working'
            ? `<span class="card-badge badge-status ${escapeHtml(v.status)}">${escapeHtml(v.status.toUpperCase())}</span>`
            : '';

        return `
            <article class="card ${state.selectedIds.has(v.id) ? 'is-selected' : ''}" data-id="${v.id}">
                <div class="thumb-wrap">
                    <label class="card-select-wrap" title="Označiť kartu">
                        <input class="card-select" type="checkbox" ${state.selectedIds.has(v.id) ? 'checked' : ''} aria-label="Označiť ${escapeHtml(v.title)}">
                        <span class="material-icons-round">check</span>
                    </label>
                    <img class="thumb-img" src="${escapeHtml(v.thumbnail)}" alt="Náhľad" loading="lazy" onerror="this.onerror=null;this.src='/static/placeholder.jpg'">
                    <span class="card-badge badge-duration">${escapeHtml(v.duration_str)}</span>
                    <span class="card-badge badge-quality ${qualityClass}">${escapeHtml(v.quality || 'HD')}</span>
                    ${statusBadge}
                    <div class="play-btn-overlay">
                        <span class="material-icons-round">play_arrow</span>
                    </div>
                </div>
                <div class="card-details">
                    <h3 class="card-title" title="${escapeHtml(v.title)}">${escapeHtml(v.title)}</h3>
                    <div class="card-meta-row">
                        <span class="card-source-tag">${escapeHtml(sourceName)}</span>
                        <span class="card-date">${escapeHtml(v.created_at)}</span>
                    </div>
                    <div class="card-footer-stats">
                        <span>${v.file_size_mb > 0 ? v.file_size_mb + ' MB' : 'Stream'}</span>
                        <button class="btn-card-del" title="Vymazať video">
                            <span class="material-icons-round">delete_outline</span>
                        </button>
                    </div>
                </div>
            </article>
        `;
    }

    function selectedVideos() {
        return state.videos.filter(video => state.selectedIds.has(video.id));
    }

    function updateBatchBar(message = '') {
        const count = state.selectedIds.size;
        elements.batchBar.hidden = count === 0;
        elements.selectedCount.textContent = count.toLocaleString();
        elements.batchMessage.textContent = message;
    }

    function toggleCardSelection(videoId, selected) {
        if (selected) state.selectedIds.add(videoId);
        else state.selectedIds.delete(videoId);
        const card = elements.grid.querySelector(`.card[data-id="${videoId}"]`);
        if (card) {
            card.classList.toggle('is-selected', selected);
            const checkbox = card.querySelector('.card-select');
            if (checkbox) checkbox.checked = selected;
        }
        updateBatchBar();
    }

    async function copySelected(field) {
        const urls = selectedVideos().map(video => String(video[field] || '').trim()).filter(Boolean);
        if (!urls.length) return updateBatchBar('Označené karty nemajú URL.');
        try {
            await navigator.clipboard.writeText(urls.join('\n'));
            updateBatchBar(`${urls.length} URL skopírovaných.`);
        } catch {
            const fallback = document.createElement('textarea');
            fallback.value = urls.join('\n');
            document.body.appendChild(fallback);
            fallback.select();
            document.execCommand('copy');
            fallback.remove();
            updateBatchBar(`${urls.length} URL skopírovaných.`);
        }
    }

    async function pollFreshLinks(videoIds) {
        const token = ++state.refreshPollToken;
        const originalUrls = new Map(videoIds.map(id => [id, state.videos.find(v => v.id === id)?.url || '']));
        const deadline = Date.now() + 300000;
        const poll = async () => {
            if (token !== state.refreshPollToken) return;
            try {
                const res = await fetch(`/api/lite/videos?limit=200&ids=${encodeURIComponent(videoIds.join(','))}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                let changed = 0;
                (data.items || []).forEach(card => {
                    const index = state.videos.findIndex(video => video.id === card.id);
                    if (index < 0 || !card.url || card.url === state.videos[index].url) return;
                    state.videos[index] = { ...state.videos[index], ...card };
                    changed += 1;
                });
                if (changed) {
                    renderGrid();
                    updateBatchBar(`Čerstvá direct URL uložená pre ${changed} kartu(y).`);
                }
                const pending = videoIds.some(id => {
                    const current = state.videos.find(video => video.id === id)?.url || '';
                    return current === originalUrls.get(id);
                });
                if (pending && Date.now() < deadline) window.setTimeout(poll, 1400);
                else if (!pending) updateBatchBar('Všetky dostupné direct URL sú aktualizované.');
            } catch (err) {
                console.warn('LITE refresh polling failed:', err);
                if (Date.now() < deadline) window.setTimeout(poll, 2500);
            }
        };
        poll();
    }

    async function runBatchAction(action) {
        const videoIds = [...state.selectedIds];
        if (!videoIds.length) return;
        if (action === 'clear') {
            state.selectedIds.clear();
            updateBatchBar();
            renderGrid();
            return;
        }
        if (action === 'copy-direct') return copySelected('url');
        if (action === 'copy-source') return copySelected('source_url');
        if (action === 'delete' && !confirm(`Vymazať ${videoIds.length} označených videí?`)) return;
        updateBatchBar(action === 'refresh_links' ? 'Refetch beží — označenie ostáva, URL sa zmenia hneď po získaní.' : 'Spracovávam batch…');
        try {
            const res = await fetch('/api/lite/batch-action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ video_ids: videoIds, action }),
            });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.detail || data.message || 'Akcia zlyhala');
            if (action === 'delete') {
                videoIds.forEach(id => state.selectedIds.delete(id));
                state.videos = state.videos.filter(video => !videoIds.includes(video.id));
                renderGrid();
                fetchStats();
                updateBatchBar();
            } else if (action === 'refresh_links') {
                pollFreshLinks(videoIds);
            } else {
                updateBatchBar(action === 'rethumb' ? 'Rethumb bol zaradený na pozadí.' : 'Batch akcia je hotová.');
            }
        } catch (err) {
            updateBatchBar(`Chyba: ${err.message || err}`);
        }
    }

    // -------------------------------------------------------------------------
    // Video Modal Player
    // -------------------------------------------------------------------------
    async function openVideoModal(video) {
        const token = (state.playbackToken || 0) + 1;
        state.playbackToken = token;
        state.playbackAttempts = 0;
        elements.modalTitle.textContent = video.title || 'Prehrávanie videa';
        elements.modalQuality.textContent = video.quality || 'HD';
        elements.modalDuration.textContent = video.duration_str || '--:--';
        elements.modalSize.textContent = video.file_size_mb > 0 ? `${video.file_size_mb} MB` : 'Stream';
        elements.modalBatch.textContent = video.batch_name || 'Library';
        elements.modalSourceBtn.href = video.source_url || video.url || '#';
        elements.videoModal.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        const media = elements.modalPlayer;
        const activity = window.NexusPlayback;
        const current = () => token === state.playbackToken;
        const load = async (refresh = false) => {
            if (!current()) return;
            if (refresh && ++state.playbackAttempts > 2) {
                throw new Error('Dva pokusy obnovy zlyhali; pôvodný zdroj môže byť nedostupný alebo vyžadovať prihlásenie');
            }
            activity.begin(media, { reset: true, id: video.id, scope: token, retry: () => load(true) });
            activity.update(media, refresh
                ? 'OBNOVUJEM ODKAZ — získavam nový stream / token z pôvodnej stránky.'
                : 'OVERUJEM ZDROJ — získavam aktuálny odkaz a prípadný token.');
            if (state.activeHls) { state.activeHls.destroy(); state.activeHls = null; }
            media.pause();
            media.removeAttribute('src');
            media.load();
            const response = await fetch(`/api/lite/resolve/${video.id}?refresh=${refresh ? 'true' : 'false'}`, { cache: 'no-store' });
            const data = await response.json().catch(() => ({}));
            if (!current()) return;
            if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
            if (data.url) video.url = data.url;
            activity.update(media, `NAČÍTAVAM STREAM — ${data.method}; ${data.is_hls ? 'HLS cez proxy' : 'priamy / lokálny stream'}.`);
            const play = () => {
                if (!current()) return;
                const promise = media.play();
                if (promise) promise.catch(error => {
                    if (current() && error.name === 'NotAllowedError') activity.update(media, 'ČAKÁM NA KLIKNUTIE PLAY — prehliadač zablokoval automatické spustenie.', 'ready');
                });
            };
            if (data.is_hls && window.Hls && Hls.isSupported()) {
                const hls = new Hls({ enableWorker: true, lowLatencyMode: false });
                state.activeHls = hls;
                hls.on(Hls.Events.MEDIA_ATTACHED, () => { if (current()) hls.loadSource(data.stream_url); });
                hls.on(Hls.Events.MANIFEST_PARSED, play);
                hls.on(Hls.Events.ERROR, (_event, error) => {
                    if (!current() || !error.fatal) return;
                    hls.destroy();
                    if (state.activeHls === hls) state.activeHls = null;
                    const code = error.response?.code;
                    activity.recover(media, `HLS zlyhalo: ${error.details}${code ? ` (HTTP ${code})` : ''}.`);
                });
                hls.attachMedia(media);
            } else {
                media.src = data.stream_url;
                media.load();
                play();
            }
        };
        try { await load(); }
        catch (error) {
            if (current()) activity.update(media, `VIDEO SA NESPUSTILO — ${error.message}. RIEŠENIE: otvorte pôvodný zdroj a overte dostupnosť / prihlásenie.`, 'error');
        }
    }

    function closeVideoModal() {
        state.playbackToken = (state.playbackToken || 0) + 1;
        window.NexusPlayback?.stop(elements.modalPlayer);
        if (state.activeHls) {
            state.activeHls.destroy();
            state.activeHls = null;
        }
        elements.modalPlayer.pause();
        elements.modalPlayer.removeAttribute('src');
        elements.modalPlayer.load();
        elements.videoModal.classList.add('hidden');
        document.body.style.overflow = '';
    }

    // -------------------------------------------------------------------------
    // Delete Video Action
    // -------------------------------------------------------------------------
    async function deleteVideo(id, cardEl) {
        try {
            const res = await fetch(`/api/lite/videos/${id}`, { method: 'DELETE' });
            if (res.ok) {
                cardEl.style.opacity = '0';
                cardEl.style.transform = 'scale(0.8)';
                setTimeout(() => {
                    state.videos = state.videos.filter(x => x.id !== id);
                    renderGrid();
                    fetchStats();
                }, 250);
            }
        } catch (err) {
            alert('Chyba pri mazaní videa');
        }
    }

    // -------------------------------------------------------------------------
    // Quick Import Action
    // -------------------------------------------------------------------------
    async function handleQuickImport() {
        const rawText = elements.importUrls.value.trim();
        if (!rawText) {
            alert('Vložte aspoň jednu URL adresu.');
            return;
        }

        const urls = rawText.split('\n').map(x => x.trim()).filter(Boolean);
        const batchName = elements.importBatch.value.trim() || 'Fast Intake';

        elements.btnSubmitImport.disabled = true;
        elements.btnSubmitImport.innerHTML = '<span class="material-icons-round spin-icon">autorenew</span> Odosielam...';

        try {
            const res = await fetch('/api/lite/quick-import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ urls, batch_name: batchName }),
            });
            const data = await res.json();
            if (data.success) {
                elements.importUrls.value = '';
                elements.importBatch.value = '';
                elements.importDrawer.classList.add('collapsed');
                fetchStats();
                fetchJobs();
                // Open jobs drawer so user sees progress
                elements.jobsDrawer.classList.remove('collapsed');
            } else {
                alert(data.message || 'Chyba importu.');
            }
        } catch (err) {
            alert('Chyba spojenia so serverom.');
        } finally {
            elements.btnSubmitImport.disabled = false;
            elements.btnSubmitImport.innerHTML = '<span class="material-icons-round">cloud_upload</span> Odoslať do fronty';
        }
    }

    // -------------------------------------------------------------------------
    // Real-Time SSE Setup
    // -------------------------------------------------------------------------
    function initSSE() {
        const evtSource = new EventSource('/api/lite/events');

        evtSource.addEventListener('update', (e) => {
            try {
                const event = JSON.parse(e.data);
                if (event.type === 'job_queued' || event.type === 'job_finished' || event.type === 'video_added') {
                    fetchStats();
                    fetchJobs();
                    // Refetch videos gently without full reload spinner
                    fetchVideos(true);
                }
            } catch (err) {
                console.warn('SSE parsing error:', err);
            }
        });

        evtSource.onerror = () => {
            // Reconnect automatically handled by browser
        };
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
    function extractDomain(urlStr) {
        if (!urlStr) return 'LINK';
        try {
            if (urlStr.startsWith('http')) {
                const hostname = new URL(urlStr).hostname.replace('www.', '');
                const parts = hostname.split('.');
                return parts.length >= 2 ? parts[0] : hostname;
            }
            return urlStr.slice(0, 10);
        } catch {
            return 'SOURCE';
        }
    }

    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // Debounce helper
    let debounceTimer = null;
    function debounce(fn, delay = 300) {
        return (...args) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => fn(...args), delay);
        };
    }

    // -------------------------------------------------------------------------
    // Event Listeners
    // -------------------------------------------------------------------------
    function bindEvents() {
        document.addEventListener('mega-hub-imported', () => {
            fetchStats();
            fetchFilterOptions();
            fetchVideos();
        });
        // Fast Import toggles
        elements.btnToggleImport.onclick = () => {
            elements.importDrawer.classList.toggle('collapsed');
            if (!elements.importDrawer.classList.contains('collapsed')) {
                elements.importUrls.focus();
            }
        };
        elements.btnCloseImport.onclick = () => elements.importDrawer.classList.add('collapsed');
        elements.btnEmptyImport.onclick = () => {
            elements.importDrawer.classList.remove('collapsed');
            elements.importUrls.focus();
        };
        elements.btnSubmitImport.onclick = handleQuickImport;

        // Jobs Drawer toggle
        elements.btnToggleJobs.onclick = () => {
            elements.jobsDrawer.classList.toggle('collapsed');
            if (!elements.jobsDrawer.classList.contains('collapsed')) {
                fetchJobs();
            }
        };

        // Refresh
        elements.btnRefresh.onclick = () => {
            fetchStats();
            fetchJobs();
            fetchFilterOptions();
            fetchVideos(true);
        };

        // Filter Pills
        elements.filterPills.forEach(pill => {
            pill.onclick = () => {
                elements.filterPills.forEach(p => p.classList.remove('active'));
                pill.classList.add('active');
                state.filter = pill.dataset.filter;
                fetchVideos(true);
            };
        });

        // Search Input
        elements.filterInput.oninput = debounce(() => {
            state.query = elements.filterInput.value;
            elements.clearSearch.style.display = state.query ? 'inline-block' : 'none';
            fetchVideos(true);
        }, 250);

        elements.clearSearch.onclick = () => {
            elements.filterInput.value = '';
            state.query = '';
            elements.clearSearch.style.display = 'none';
            fetchVideos(true);
        };

        elements.batchFilter.onchange = () => {
            state.batchName = elements.batchFilter.value;
            // Batch and board are distinct scopes. Selecting a batch deliberately
            // clears a prior board selection so the resulting filter is obvious.
            state.sourceBoardId = '';
            elements.sourceBoardFilter.value = '';
            updateScopeClearButton();
            fetchVideos(true);
        };

        elements.sourceBoardFilter.onchange = () => {
            state.sourceBoardId = elements.sourceBoardFilter.value;
            // A Source Board resolves to its own stored batch on the server.
            state.batchName = '';
            elements.batchFilter.value = '';
            updateScopeClearButton();
            fetchVideos(true);
        };

        elements.clearScopeFilters.onclick = () => {
            state.batchName = '';
            state.sourceBoardId = '';
            elements.batchFilter.value = '';
            elements.sourceBoardFilter.value = '';
            updateScopeClearButton();
            fetchVideos(true);
        };

        elements.sortBy.onchange = () => {
            state.sortBy = elements.sortBy.value;
            fetchVideos(true);
        };

        elements.qualityFilter.onchange = () => {
            state.quality = elements.qualityFilter.value;
            fetchVideos(true);
        };

        elements.sortOrder.onclick = () => {
            state.sortOrder = state.sortOrder === 'desc' ? 'asc' : 'desc';
            elements.sortOrder.textContent = state.sortOrder === 'desc' ? 'Najväčšie' : 'Najmenšie';
            fetchVideos(true);
        };

        elements.batchBar.querySelectorAll('[data-lite-action]').forEach(button => {
            button.onclick = () => runBatchAction(button.dataset.liteAction);
        });

        // Modal close
        elements.modalCloseBtn.onclick = closeVideoModal;
        elements.modalBackdrop.onclick = closeVideoModal;
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !elements.videoModal.classList.contains('hidden')) {
                closeVideoModal();
            }
        });

        // Periodic polling for stats & jobs
        setInterval(() => {
            fetchStats();
            if (!elements.jobsDrawer.classList.contains('collapsed')) {
                fetchJobs();
            }
        }, 5000);
    }

    // Init
    bindEvents();
    fetchStats();
    fetchFilterOptions();
    fetchVideos(true);
    initSSE();

})();
