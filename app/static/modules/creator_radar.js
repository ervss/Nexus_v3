(() => {
    'use strict';

    const state = {
        open: false,
        filterMode: 'all', // 'all' | 'followed'
        searchQuery: '',
        creators: [],
        activeSlug: '',
        activeDossier: null,
        activeTab: 'vault', // 'vault' | 'library'
        loadingList: false,
        loadingDossier: false,
        // Dossier filtering, sorting & selection
        localQuery: '',
        sortBy: 'default',
        minHeight: 0,
        minDurationSec: 0,
        sourceFilter: 'all',
        selectedKeys: new Set(),
        visibleItems: [],
        batchRethumbBusy: false,
        // Inline HLS + JIT player state
        activeHls: null,
        playerRunToken: 0,
        playerItem: null,
        playerRetryDone: false,
    };

    function esc(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function fmtDur(seconds) {
        const total = Math.max(0, Math.round(Number(seconds || 0)));
        if (!total) return '';
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function el(id) {
        return document.getElementById(id);
    }

    function getUi() {
        return {
            overlay: el('creatorRadarOverlay'),
            closeBtn: el('cradarCloseBtn'),
            addForm: el('cradarAddForm'),
            addInput: el('cradarAddInput'),
            searchInput: el('cradarSearchInput'),
            listEl: el('cradarCreatorList'),
            statFollowed: el('cradarStatFollowed'),
            statDiscovered: el('cradarStatDiscovered'),
            emptyState: el('cradarEmptyState'),
            dossierEl: el('cradarDossier'),
            heroEl: el('cradarHero'),
            vaultCount: el('cradarVaultTabCount'),
            libraryCount: el('cradarLibraryTabCount'),
            dossierStatus: el('cradarDossierStatus'),
            gridEl: el('cradarResultsGrid'),
            // Toolbar + Selection
            localFilterInput: el('cradarLocalFilterInput'),
            sortSelect: el('cradarSortSelect'),
            minQualSelect: el('cradarMinQualSelect'),
            minDurSelect: el('cradarMinDurSelect'),
            sourceSelect: el('cradarSourceSelect'),
            selectAllBtn: el('cradarSelectAllBtn'),
            selectAllLabel: el('cradarSelectAllLabel'),
            selectedCounter: el('cradarSelectedCounter'),
            rethumbBtn: el('cradarRethumbBtn'),
            rethumbLabel: el('cradarRethumbLabel'),
            splitBtn: el('cradarSplitBtn'),
            importSelectedBtn: el('cradarImportSelectedBtn'),
            importSelectedCount: el('cradarImportSelectedCount'),
            // Inline Player
            playerOverlay: el('cradarPlayerOverlay'),
            playerTitle: el('cradarPlayerTitle'),
            playerVideo: el('cradarPlayerVideo'),
            playerStatus: el('cradarPlayerStatus'),
            playerError: el('cradarPlayerError'),
            playerSourceLink: el('cradarPlayerSourceLink'),
            playerRefreshBtn: el('cradarPlayerRefreshBtn'),
            playerOpenMainBtn: el('cradarPlayerOpenMainBtn'),
            playerCloseBtn: el('cradarPlayerCloseBtn'),
        };
    }

    async function fetchJson(url, opts = {}) {
        const res = await fetch(url, {
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
            ...opts,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.detail || data.message || `HTTP ${res.status}`);
        }
        return data;
    }

    function initialsFor(name) {
        const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
        if (!parts.length) return '?';
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    function inferHeight(item) {
        const direct = Number(item?.height || 0);
        if (direct > 0) return direct;
        const q = String(item?.quality || '').toUpperCase();
        if (q.includes('4K') || q.includes('2160')) return 2160;
        if (q.includes('1440')) return 1440;
        if (q.includes('FHD') || q.includes('1080')) return 1080;
        if (q.includes('HD') || q.includes('720')) return 720;
        if (q.includes('480')) return 480;
        return 0;
    }

    function itemKey(item, tab = state.activeTab) {
        if (item?.id != null && item?.id !== '') return `${tab}:${item.id}`;
        if (item?.video_id) return `lib:${item.video_id}`;
        return `${tab}:${item?.url || item?.source_url || item?.title || ''}`;
    }

    function getPlayableUrl(item) {
        if (!item) return '';
        if (item.playable_url) return String(item.playable_url);
        if (item.play_url) return String(item.play_url);
        if (item.video_id) {
            const raw = String(item.url || '');
            if (raw.startsWith('/api/') || raw.startsWith('/hls_proxy')) return raw;
            if (/\.m3u8(?:[?#]|$)/i.test(raw)) {
                return `/hls_proxy?url=${encodeURIComponent(raw)}&referer=${encodeURIComponent(item.source_url || '')}`;
            }
            return `/stream_proxy/${Number(item.video_id)}.mp4`;
        }
        const tg = item.telegram_meta || {};
        if (tg.stream_url) return String(tg.stream_url);
        const direct = String(item.url || '');
        if (direct.startsWith('/api/') || direct.startsWith('/hls_proxy')) return direct;
        if (/\.(?:mp4|m3u8|webm|m4v|mov)(?:[?#]|$)/i.test(direct)) {
            if (/\.m3u8(?:[?#]|$)/i.test(direct)) {
                return `/hls_proxy?url=${encodeURIComponent(direct)}&referer=${encodeURIComponent(item.source_url || '')}`;
            }
            return direct;
        }
        return '';
    }

    function getFilteredSortedItems() {
        const dossier = state.activeDossier;
        if (!dossier) return [];
        const rawList = state.activeTab === 'vault'
            ? (dossier.vault_findings || [])
            : (dossier.library_videos || []);

        const q = String(state.localQuery || '').trim().toLowerCase();
        const srcFilter = String(state.sourceFilter || 'all').toLowerCase();
        const minH = Number(state.minHeight || 0);
        const minDur = Number(state.minDurationSec || 0);

        const filtered = rawList.filter(item => {
            const h = inferHeight(item);
            const dur = Number(item?.duration_sec || 0);
            if (minH > 0 && h < minH) return false;
            if (minDur > 0 && dur < minDur) return false;

            if (srcFilter !== 'all') {
                if (srcFilter === 'local') {
                    if (String(item?.storage_type || '').toLowerCase() !== 'local') return false;
                } else {
                    const bucket = String(item?.bucket || '').toLowerCase();
                    const srcLabel = String(item?.source_label || '').toLowerCase();
                    if (bucket !== srcFilter && !srcLabel.includes(srcFilter)) return false;
                }
            }

            if (q) {
                const hay = [
                    item?.title,
                    item?.subtitle,
                    item?.source_label,
                    item?.batch_name,
                    item?.url,
                    item?.source_url,
                ].filter(Boolean).join(' ').toLowerCase();
                if (!hay.includes(q)) return false;
            }
            return true;
        });

        const sorted = [...filtered];
        const sortBy = state.sortBy || 'default';
        if (sortBy === 'quality_desc') {
            sorted.sort((a, b) => (inferHeight(b) - inferHeight(a)) || (Number(b.duration_sec || 0) - Number(a.duration_sec || 0)));
        } else if (sortBy === 'duration_desc') {
            sorted.sort((a, b) => (Number(b.duration_sec || 0) - Number(a.duration_sec || 0)) || (inferHeight(b) - inferHeight(a)));
        } else if (sortBy === 'size_desc') {
            sorted.sort((a, b) => (Number(b.size_mb || 0) - Number(a.size_mb || 0)) || (inferHeight(b) - inferHeight(a)));
        } else if (sortBy === 'newest') {
            sorted.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || (Number(b.video_id || b.id || 0) - Number(a.video_id || a.id || 0)));
        } else if (sortBy === 'title_asc') {
            sorted.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'sk', { numeric: true, sensitivity: 'base' }));
        }
        return sorted;
    }

    function updateSelectionBarUi() {
        const ui = getUi();
        const visible = state.visibleItems || [];
        const visibleKeys = visible.map(it => itemKey(it));
        const selectedVisible = visibleKeys.filter(k => state.selectedKeys.has(k));
        const count = state.selectedKeys.size;

        if (ui.selectedCounter) {
            ui.selectedCounter.textContent = `${count} vybraných`;
        }
        if (ui.selectAllLabel) {
            ui.selectAllLabel.textContent = (visible.length > 0 && selectedVisible.length === visible.length)
                ? 'Zrušiť výber'
                : 'Vybrať všetko';
        }
        if (ui.importSelectedBtn && ui.importSelectedCount) {
            const importableSelected = visible.filter(it =>
                state.selectedKeys.has(itemKey(it)) &&
                state.activeTab === 'vault' &&
                it.can_import !== false &&
                (it.url || it.source_url || it.telegram_meta)
            );
            ui.importSelectedCount.textContent = String(importableSelected.length);
            ui.importSelectedBtn.hidden = importableSelected.length === 0;
        }
        if (ui.splitBtn) {
            const playableSelectedCount = visible.filter(it => state.selectedKeys.has(itemKey(it)) && getPlayableUrl(it)).length;
            const playableAnyCount = visible.filter(it => getPlayableUrl(it)).length;
            ui.splitBtn.disabled = playableAnyCount === 0;
            ui.splitBtn.innerHTML = `<span class="material-icons-round" aria-hidden="true">view_column</span> Split-Screen${playableSelectedCount > 0 ? ` (${playableSelectedCount})` : ''}`;
        }
        if (ui.rethumbBtn && ui.rethumbLabel) {
            const selectedRethumb = visible.filter(it => state.selectedKeys.has(itemKey(it)) && canEnhanceThumb(it));
            const missingThumbs = visible.filter(it => !it.thumbnail && canEnhanceThumb(it));
            const anyRethumb = visible.some(canEnhanceThumb);
            ui.rethumbBtn.disabled = !anyRethumb || Boolean(state.batchRethumbBusy);
            if (state.batchRethumbBusy) {
                ui.rethumbLabel.textContent = 'Zlepšujem...';
            } else if (selectedRethumb.length > 0) {
                ui.rethumbLabel.textContent = `Zlepšiť thumby (${selectedRethumb.length})`;
            } else if (missingThumbs.length > 0) {
                ui.rethumbLabel.textContent = `Doplniť chýbajúce (${missingThumbs.length})`;
            } else {
                ui.rethumbLabel.textContent = 'Zlepšiť thumby';
            }
        }
    }

    function canEnhanceThumb(item) {
        if (!item) return false;
        return Boolean(item.video_id || item.telegram_meta || item.playable_url || item.url || item.source_url);
    }

    function renderCreatorList() {
        const ui = getUi();
        if (!ui.listEl) return;

        if (state.loadingList && !state.creators.length) {
            ui.listEl.innerHTML = '<div class="cradar-empty-mini">Načítavam tvorcov z knižnice...</div>';
            return;
        }

        if (!state.creators.length) {
            ui.listEl.innerHTML = '<div class="cradar-empty-mini">Zatiaľ žiadni zodpovedajúci tvorcovia. Pridaj meno vyššie.</div>';
            return;
        }

        ui.listEl.innerHTML = state.creators.map(c => {
            const active = c.slug === state.activeSlug ? 'is-active' : '';
            const thumb = c.sample_thumb
                ? `<img src="${esc(c.sample_thumb)}" alt="" loading="lazy">`
                : `<span>${esc(initialsFor(c.name))}</span>`;
            const starIcon = c.followed ? 'star' : 'star_border';
            const starClass = c.followed ? 'is-followed' : '';
            return `
                <div class="cradar-creator-item ${active}" data-cr-select="${esc(c.name)}" data-cr-slug="${esc(c.slug)}">
                    <div class="cradar-avatar">${thumb}</div>
                    <div class="cradar-creator-meta">
                        <div class="cradar-creator-name">${esc(c.name)}</div>
                        <div class="cradar-creator-sub">
                            <span>${Number(c.video_count || 0)} videí</span>
                            <span>·</span>
                            <span>${esc(c.best_quality || 'SD')}</span>
                            ${c.local_count ? `<span class="cradar-local-dot">${Number(c.local_count)} local</span>` : ''}
                        </div>
                    </div>
                    <button type="button"
                        class="cradar-star-btn ${starClass}"
                        data-cr-toggle-follow="${esc(c.name)}"
                        data-cr-id="${c.id ? Number(c.id) : ''}"
                        title="${c.followed ? 'Odopnúť tvorcu' : 'Pripnúť do sledovaných'}">
                        <span class="material-icons-round" aria-hidden="true">${starIcon}</span>
                    </button>
                </div>
            `;
        }).join('');
    }

    function renderDossierGrid() {
        const ui = getUi();
        if (!ui.gridEl || !state.activeDossier) return;

        if (state.loadingDossier) {
            state.visibleItems = [];
            ui.gridEl.innerHTML = '<div class="cradar-empty-mini">Prehľadávam Knižnicu a Local Vault...</div>';
            updateSelectionBarUi();
            return;
        }

        const rawList = state.activeTab === 'vault'
            ? (state.activeDossier.vault_findings || [])
            : (state.activeDossier.library_videos || []);
        const items = getFilteredSortedItems();
        state.visibleItems = items;

        if (ui.dossierStatus) {
            if (!rawList.length) {
                ui.dossierStatus.textContent = '';
            } else if (items.length !== rawList.length) {
                ui.dossierStatus.textContent = `Zobrazených ${items.length} z ${rawList.length}`;
            } else {
                ui.dossierStatus.textContent = `${items.length} položiek`;
            }
        }

        if (!items.length) {
            ui.gridEl.innerHTML = rawList.length
                ? '<div class="cradar-empty-mini">Žiadne položky nezodpovedajú aktívnym filtrom (Min kvalita / Min dĺžka / Zdroj).</div>'
                : (state.activeTab === 'vault'
                    ? '<div class="cradar-empty-mini">Žiadne ďalšie neimportované zhody v Local Vaulte pre tohto tvorcu.</div>'
                    : '<div class="cradar-empty-mini">V Knižnici zatiaľ nemáš žiadne videá pre tohto tvorcu. Skús kartu „Skryté v Trezore“.</div>');
            updateSelectionBarUi();
            return;
        }

        ui.gridEl.innerHTML = items.map((item, idx) => {
            const key = itemKey(item);
            const isSelected = state.selectedKeys.has(key);
            const dur = fmtDur(item.duration_sec);
            const playUrl = getPlayableUrl(item);
            const absStream = playUrl ? new URL(playUrl, window.location.origin).href : '';
            const rawWatch = item.source_url || item.url || '';
            const absWatch = /^https?:\/\//i.test(rawWatch) ? rawWatch : (absStream ? `${absStream}#watch` : '');
            const splitFormat = /\.m3u8(?:\?|$)|\/hls_proxy/i.test(absStream) ? 'hls' : 'mp4';

            const srcLabel = state.activeTab === 'vault'
                ? (item.source_label || item.bucket || 'Vault')
                : (item.storage_type === 'local' ? 'LOCAL' : 'REMOTE');
            const iconName = state.activeTab === 'library'
                ? 'movie'
                : (item.bucket === 'telegram' ? 'send' : (item.bucket === 'forum' ? 'forum' : (item.bucket === 'mega' ? 'cloud_queue' : 'inventory_2')));
            const fallbackHtml = `<div class="cradar-thumb-fallback"><span class="material-icons-round">${iconName}</span><span>${esc(srcLabel)}</span></div>`;
            const thumbHtml = item.thumbnail
                ? `${fallbackHtml}<img src="${esc(item.thumbnail)}" loading="lazy" alt="" onerror="this.remove()">`
                : fallbackHtml;

            const canImport = state.activeTab === 'vault' && Boolean(item.can_import !== false && (item.url || item.source_url || item.telegram_meta));
            const canRethumb = canEnhanceThumb(item);
            const openUrl = item.source_url || item.url || '';

            const splitAttrs = absStream
                ? `data-nexus-split-stream="${esc(absStream)}" data-nexus-split-watch="${esc(absWatch)}" data-nexus-split-format="${splitFormat}"`
                : '';

            return `
                <article class="cradar-card card ${isSelected ? 'is-selected nuss-page-selected' : ''}" data-cr-idx="${idx}" data-cr-key="${esc(key)}" ${splitAttrs}>
                    <div class="cradar-card-thumb" ${playUrl ? `data-cr-play-idx="${idx}" style="cursor:pointer;"` : ''}>
                        <label class="cradar-select-wrap" title="Označiť kartu (alebo Ctrl + klik kdekoľvek)">
                            <input type="checkbox" class="cradar-select-cb" ${isSelected ? 'checked' : ''} aria-label="Označiť kartu">
                        </label>
                        ${thumbHtml}
                        ${item.quality ? `<span class="cradar-badge is-q">${esc(item.quality)}</span>` : ''}
                        ${dur ? `<span class="cradar-badge is-dur">${esc(dur)}</span>` : ''}
                    </div>
                    <div class="cradar-card-body">
                        <div class="cradar-card-meta">
                            <span class="cradar-src-tag">${esc(srcLabel)}</span>
                            ${item.size_mb ? `<span>${Number(item.size_mb)} MB</span>` : ''}
                        </div>
                        <h4 title="${esc(item.title)}">${esc(item.title || 'Bez názvu')}</h4>
                        <div class="cradar-card-actions">
                            ${playUrl ? `<button type="button" class="cradar-btn-primary is-sm" data-cr-play-idx="${idx}"><span class="material-icons-round">play_arrow</span>Prehrať</button>` : ''}
                            ${canImport ? `<button type="button" class="cradar-btn-glass is-sm" data-cr-import-idx="${idx}"><span class="material-icons-round">download</span>Importovať</button>` : ''}
                            ${canRethumb ? `<button type="button" class="cradar-btn-glass is-sm is-icon ${item.thumb_enhanced ? 'is-enhanced' : ''} ${item._rethumbing ? 'is-busy' : ''}" data-cr-rethumb-idx="${idx}" ${item._rethumbing ? 'disabled' : ''} title="${item.thumb_enhanced ? 'Skúsiť inú snímku (reroll)' : 'Zlepšiť thumb'}"><span class="material-icons-round">${item._rethumbing ? 'autorenew' : 'auto_awesome'}</span></button>` : ''}
                            ${openUrl ? `<a class="cradar-btn-glass is-sm is-icon" href="${esc(openUrl)}" target="_blank" rel="noopener" title="Otvoriť zdroj"><span class="material-icons-round">open_in_new</span></a>` : ''}
                        </div>
                    </div>
                </article>
            `;
        }).join('');

        updateSelectionBarUi();
    }

    function renderDossier() {
        const ui = getUi();
        if (!ui.heroEl || !ui.gridEl) return;
        const dossier = state.activeDossier;
        if (!dossier || !dossier.creator) {
            if (ui.emptyState) ui.emptyState.hidden = false;
            if (ui.dossierEl) ui.dossierEl.hidden = true;
            return;
        }

        if (ui.emptyState) ui.emptyState.hidden = true;
        if (ui.dossierEl) ui.dossierEl.hidden = false;

        const c = dossier.creator;
        const avatar = c.sample_thumb
            ? `<img src="${esc(c.sample_thumb)}" alt="">`
            : `<span>${esc(initialsFor(c.name))}</span>`;

        ui.heroEl.innerHTML = `
            <div class="cradar-hero-left">
                <div class="cradar-hero-avatar">${avatar}</div>
                <div class="cradar-hero-info">
                    <div class="cradar-hero-title-row">
                        <h3>${esc(c.name)}</h3>
                        <span class="cradar-quality-pill">${esc(c.best_quality || 'SD')}</span>
                        ${c.followed ? '<span class="cradar-follow-pill">★ Sledovaný</span>' : ''}
                    </div>
                    <div class="cradar-hero-metrics">
                        <div class="cradar-metric"><span>V Knižnici</span><strong>${Number(c.video_count || 0)}</strong></div>
                        <div class="cradar-metric"><span>Local na disku</span><strong>${Number(c.local_count || 0)}</strong></div>
                        <div class="cradar-metric is-cyan"><span>Skryté v Trezore</span><strong>${Number(c.vault_hidden_count || 0)}</strong></div>
                    </div>
                </div>
            </div>
            <div class="cradar-hero-actions">
                <button type="button" class="cradar-btn-glass" id="cradarFilterLibraryBtn" title="Filtrovať hlavnú knižnicu na tohto tvorcu">
                    <span class="material-icons-round" aria-hidden="true">filter_alt</span>
                    Knižnica
                </button>
                <a class="cradar-btn-glass" href="/vault?q=${encodeURIComponent(c.name)}" title="Otvoriť v Local Vaulte">
                    <span class="material-icons-round" aria-hidden="true">inventory_2</span>
                    Local Vault
                </a>
                <button type="button" class="${c.followed ? 'cradar-btn-glass is-followed' : 'cradar-btn-primary'}" id="cradarHeroFollowBtn">
                    <span class="material-icons-round" aria-hidden="true">${c.followed ? 'star' : 'star_border'}</span>
                    ${c.followed ? 'Sledovaný' : 'Pripnúť'}
                </button>
            </div>
        `;

        const vaultItems = dossier.vault_findings || [];
        const libItems = dossier.library_videos || [];

        if (ui.vaultCount) ui.vaultCount.textContent = String(vaultItems.length);
        if (ui.libraryCount) ui.libraryCount.textContent = String(libItems.length);

        document.querySelectorAll('#creatorRadarOverlay [data-cr-tab]').forEach(btn => {
            const active = btn.getAttribute('data-cr-tab') === state.activeTab;
            btn.classList.toggle('active', active);
        });

        const filterLibBtn = el('cradarFilterLibraryBtn');
        if (filterLibBtn) {
            filterLibBtn.onclick = () => {
                window.dispatchEvent(new CustomEvent('nexus:filter-creator', { detail: { name: c.name } }));
                close();
            };
        }
        const heroFollowBtn = el('cradarHeroFollowBtn');
        if (heroFollowBtn) {
            heroFollowBtn.onclick = () => toggleFollow(c.name, c.id);
        }

        renderDossierGrid();
    }

    // ── Inline Obsidian Glass Video Player (HLS.js + JIT Stream Refresh) ─────────
    function destroyActiveHls() {
        if (state.activeHls) {
            try { state.activeHls.destroy(); } catch {}
            state.activeHls = null;
        }
    }

    function setInlinePlayerStatus(msg = '') {
        const ui = getUi();
        if (!ui.playerStatus) return;
        ui.playerStatus.textContent = msg;
        ui.playerStatus.hidden = !msg;
    }

    function buildLibraryPlaybackUrl(streamUrl, sourceUrl, videoId, isHlsHint = false, proxySession = '', playbackReferer = '', preferVideoProxy = false) {
        const clean = String(streamUrl || '').trim();
        const isHls = Boolean(isHlsHint) || /\.m3u8(?:[?#]|$)/i.test(clean);
        const ref = encodeURIComponent(playbackReferer || sourceUrl || '');
        const sess = proxySession ? `&session=${encodeURIComponent(proxySession)}` : '';
        if (clean.startsWith('/api/') || clean.startsWith('/hls_proxy')) return clean;
        if (clean.startsWith('/') && !clean.startsWith('//')) return clean;
        if ((isHls || proxySession) && /^https?:\/\//i.test(clean)) {
            return `/hls_proxy?url=${encodeURIComponent(clean)}&referer=${ref}${sess}`;
        }
        if (preferVideoProxy && /^https?:\/\//i.test(clean)) {
            return `/api/v1/video_proxy?url=${encodeURIComponent(clean)}&referer=${ref}`;
        }
        if (videoId) return `/stream_proxy/${Number(videoId)}.mp4`;
        return clean;
    }

    function attachInlineStream(playbackUrl, item, runToken) {
        const ui = getUi();
        if (runToken !== state.playerRunToken || !ui.playerVideo) return;
        destroyActiveHls();
        const lower = String(playbackUrl || '').toLowerCase();
        const wantHls = Boolean(item?.is_hls) || lower.includes('.m3u8') || lower.startsWith('/hls_proxy');

        if (wantHls && window.Hls && window.Hls.isSupported()) {
            const hls = new window.Hls({ enableWorker: true, lowLatencyMode: false });
            state.activeHls = hls;
            hls.loadSource(playbackUrl);
            hls.attachMedia(ui.playerVideo);
            hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
                if (runToken !== state.playerRunToken) return;
                setInlinePlayerStatus('');
                ui.playerVideo.play().catch(() => {});
            });
            hls.on(window.Hls.Events.ERROR, (_ev, data) => {
                if (runToken !== state.playerRunToken || !data || !data.fatal) return;
                destroyActiveHls();
                handleInlinePlayerFailure();
            });
            return;
        }

        ui.playerVideo.src = playbackUrl;
        ui.playerVideo.play().catch(() => {});
    }

    async function resolveFreshStream(item, force = false) {
        const videoId = Number(item?.video_id || 0);
        if (!videoId) return null;
        const combo = `${item?.source_url || ''} ${item?.url || ''}`.toLowerCase();
        if (combo.includes('xhamster.com') || combo.includes('xhcdn.com')) {
            setInlinePlayerStatus('Obnovujem xHamster stream (JIT)...');
            const res = await fetch(`/api/v1/stream/xhamster/${videoId}`, { cache: 'no-store' });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.stream_url) {
                return {
                    streamUrl: data.stream_url,
                    isHls: Boolean(data.is_hls) || /\.m3u8(?:[?#]|$)/i.test(data.stream_url),
                    proxySession: '',
                };
            }
        }
        setInlinePlayerStatus('Obnovujem stream zo zdroja...');
        const res = await fetch(`/api/v1/stream/resolve/${videoId}${force ? '?force=1' : ''}`, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.supported && data.stream_url) {
            return {
                streamUrl: data.stream_url,
                isHls: Boolean(data.is_hls) || /\.m3u8(?:[?#]|$)/i.test(data.stream_url),
                proxySession: data.proxy_session || '',
                playbackReferer: data.playback_referer || '',
            };
        }
        return null;
    }

    async function handleInlinePlayerFailure() {
        const ui = getUi();
        const runToken = state.playerRunToken;
        const item = state.playerItem;
        if (item && item.video_id && !state.playerRetryDone) {
            state.playerRetryDone = true;
            try {
                const fresh = await resolveFreshStream(item, true);
                if (runToken !== state.playerRunToken) return;
                if (fresh && fresh.streamUrl) {
                    item.url = fresh.streamUrl;
                    item.is_hls = fresh.isHls;
                    const nextUrl = buildLibraryPlaybackUrl(fresh.streamUrl, item.source_url || '', item.video_id, fresh.isHls, fresh.proxySession, fresh.playbackReferer, true);
                    item.playable_url = nextUrl;
                    attachInlineStream(nextUrl, item, runToken);
                    return;
                }
            } catch {}
        }
        setInlinePlayerStatus('');
        if (ui.playerError) {
            ui.playerError.textContent = 'Stream sa nepodarilo načítať priamo v prehliadači. Skús tlačidlo Zdroj alebo Importovať.';
            ui.playerError.hidden = false;
        }
    }

    async function openInlinePlayer(item) {
        const ui = getUi();
        if (!ui.playerOverlay || !ui.playerVideo || !item) return;
        const playUrl = getPlayableUrl(item);
        if (!playUrl) return;

        const runToken = ++state.playerRunToken;
        destroyActiveHls();
        state.playerItem = { ...item };
        state.playerRetryDone = false;

        if (ui.playerTitle) ui.playerTitle.textContent = item.title || 'Prehrávač';
        if (ui.playerError) {
            ui.playerError.hidden = true;
            ui.playerError.textContent = '';
        }
        setInlinePlayerStatus('');

        const srcHref = item.source_url || item.url || '';
        if (ui.playerSourceLink) {
            if (srcHref && srcHref.startsWith('http')) {
                ui.playerSourceLink.href = srcHref;
                ui.playerSourceLink.hidden = false;
            } else {
                ui.playerSourceLink.hidden = true;
            }
        }
        if (ui.playerRefreshBtn) ui.playerRefreshBtn.hidden = !item.video_id;
        if (ui.playerOpenMainBtn) ui.playerOpenMainBtn.hidden = !item.video_id;

        ui.playerOverlay.hidden = false;

        const combo = `${srcHref} ${item.url || ''}`.toLowerCase();
        if (item.video_id && (combo.includes('xhamster.com') || (combo.includes('xhcdn.com') && combo.includes('.m3u8')))) {
            state.playerRetryDone = true;
            try {
                const fresh = await resolveFreshStream(state.playerItem, false);
                if (runToken !== state.playerRunToken) return;
                if (fresh && fresh.streamUrl) {
                    state.playerItem.url = fresh.streamUrl;
                    state.playerItem.is_hls = fresh.isHls;
                    const nextUrl = buildLibraryPlaybackUrl(fresh.streamUrl, srcHref, item.video_id, fresh.isHls, fresh.proxySession);
                    attachInlineStream(nextUrl, state.playerItem, runToken);
                    return;
                }
            } catch {}
        }

        attachInlineStream(playUrl, state.playerItem, runToken);
    }

    function closeInlinePlayer() {
        const ui = getUi();
        state.playerRunToken += 1;
        destroyActiveHls();
        state.playerItem = null;
        setInlinePlayerStatus('');
        if (ui.playerVideo) {
            ui.playerVideo.pause();
            ui.playerVideo.removeAttribute('src');
            ui.playerVideo.load();
        }
        if (ui.playerOverlay) ui.playerOverlay.hidden = true;
    }

    // ── Split-Screen Integration ────────────────────────────────────────────────
    function launchSplitScreen() {
        const visible = state.visibleItems || [];
        let pool = visible.filter(it => state.selectedKeys.has(itemKey(it)) && getPlayableUrl(it));
        if (!pool.length) {
            pool = visible.filter(it => getPlayableUrl(it));
        }
        const splitItems = pool.slice(0, 12).map(it => {
            const playUrl = getPlayableUrl(it);
            const absStream = playUrl ? new URL(playUrl, window.location.origin).href : '';
            const rawWatch = it.source_url || it.url || '';
            const absWatch = /^https?:\/\//i.test(rawWatch) ? rawWatch : absStream;
            return {
                url: absWatch || absStream,
                watchUrl: absWatch || absStream,
                streamUrl: absStream,
                title: it.title || state.activeDossier?.creator?.name || 'Video',
                poster: it.thumbnail || '',
                duration: Number(it.duration_sec || 0),
                size: Number(it.size_mb || 0) * 1024 * 1024,
                quality: it.quality || '',
                resolution: inferHeight(it) ? `${inferHeight(it)}p` : '',
            };
        }).filter(it => it.url);

        if (!splitItems.length) {
            const ui = getUi();
            if (ui.dossierStatus) ui.dossierStatus.textContent = 'Žiadne prehrateľné videá pre Split-Screen v aktuálnom pohľade.';
            return;
        }

        document.dispatchEvent(new CustomEvent('nexus-album-split-picker', { detail: splitItems }));
        const ui = getUi();
        if (ui.dossierStatus) ui.dossierStatus.textContent = `Odoslaných ${splitItems.length} videí do Split-Screenu.`;
    }

    function applyEnhancedThumbnail(item, newThumbUrl) {
        if (!item || !newThumbUrl) return;
        item.thumbnail = newThumbUrl;
        item.thumb_enhanced = true;
        if (item.telegram_meta && typeof item.telegram_meta === 'object') {
            item.telegram_meta.thumbnail = newThumbUrl;
        }

        const ui = getUi();
        const key = itemKey(item);
        const cardEl = Array.from(ui.gridEl?.querySelectorAll('.cradar-card') || [])
            .find(node => node.getAttribute('data-cr-key') === key);

        if (cardEl) {
            const thumbBox = cardEl.querySelector('.cradar-card-thumb');
            if (thumbBox) {
                let img = thumbBox.querySelector('img');
                if (!img) {
                    img = document.createElement('img');
                    img.alt = '';
                    img.loading = 'lazy';
                    img.onerror = function () { this.remove(); };
                    thumbBox.appendChild(img);
                }
                img.src = newThumbUrl;
            }
            const btn = cardEl.querySelector('[data-cr-rethumb-idx]');
            if (btn) {
                btn.classList.add('is-enhanced');
                btn.title = 'Skúsiť inú snímku (reroll)';
            }
        }

        if (state.activeDossier?.creator && !state.activeDossier.creator.sample_thumb) {
            state.activeDossier.creator.sample_thumb = newThumbUrl;
            const heroAvatar = ui.heroEl?.querySelector('.cradar-hero-avatar');
            if (heroAvatar) {
                heroAvatar.innerHTML = `<img src="${esc(newThumbUrl)}" alt="">`;
            }
            const creatorObj = (state.creators || []).find(c => c.slug === state.activeDossier.creator.slug);
            if (creatorObj && !creatorObj.sample_thumb) {
                creatorObj.sample_thumb = newThumbUrl;
                renderCreatorList();
            }
        }
    }

    async function rethumbVisibleFinding(visibleIdx, btn) {
        const item = state.visibleItems?.[visibleIdx];
        if (!item || item._rethumbing) return;
        const ui = getUi();
        item._rethumbing = true;
        if (btn) {
            btn.disabled = true;
            btn.classList.add('is-busy');
            const icon = btn.querySelector('.material-icons-round');
            if (icon) icon.textContent = 'autorenew';
        }
        if (ui.dossierStatus) ui.dossierStatus.textContent = `Zlepšujem thumb pre „${(item.title || 'video').slice(0, 42)}“…`;
        try {
            const data = await fetchJson('/api/v1/radar/rethumb', {
                method: 'POST',
                body: JSON.stringify({
                    item,
                    reroll: Boolean(item.thumb_enhanced || item.thumbnail),
                }),
            });
            if (data?.thumbnail) {
                applyEnhancedThumbnail(item, data.thumbnail);
            }
            if (ui.dossierStatus) ui.dossierStatus.textContent = 'Náhľad vylepšený a uložený (pri importe pôjde do Dashboardu).';
        } catch (err) {
            if (ui.dossierStatus) ui.dossierStatus.textContent = `Zlepšenie thumbu zlyhalo: ${err.message}`;
        } finally {
            item._rethumbing = false;
            if (btn) {
                btn.disabled = false;
                btn.classList.remove('is-busy');
                const icon = btn.querySelector('.material-icons-round');
                if (icon) icon.textContent = 'auto_awesome';
            }
            updateSelectionBarUi();
        }
    }

    async function rethumbBatchFindings() {
        if (state.batchRethumbBusy) return;
        const ui = getUi();
        const visible = (state.visibleItems || []).filter(canEnhanceThumb);
        if (!visible.length) return;

        let targets = visible.filter(it => state.selectedKeys.has(itemKey(it)));
        let reroll = true;
        if (!targets.length) {
            targets = visible.filter(it => {
                if (!it.thumbnail) return true;
                const key = itemKey(it);
                const cardEl = Array.from(ui.gridEl?.querySelectorAll('.cradar-card') || [])
                    .find(node => node.getAttribute('data-cr-key') === key);
                const img = cardEl?.querySelector('.cradar-card-thumb img');
                return !img || (img.complete && img.naturalWidth === 0);
            });
            reroll = false;
        }
        if (!targets.length) {
            targets = visible.slice(0, 24);
            reroll = true;
        } else {
            targets = targets.slice(0, 48);
        }

        state.batchRethumbBusy = true;
        targets.forEach(it => { it._rethumbing = true; });
        renderDossierGrid();
        if (ui.dossierStatus) ui.dossierStatus.textContent = `Zlepšujem thumby: 0 / ${targets.length}…`;

        let done = 0;
        let okCount = 0;
        let failCount = 0;
        try {
            const resp = await fetch('/api/v1/radar/rethumb-batch', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: targets, reroll }),
            });
            if (!resp.ok || !resp.body) {
                const errData = await resp.json().catch(() => ({}));
                throw new Error(errData.detail || `HTTP ${resp.status}`);
            }
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            while (true) {
                const { value, done: streamDone } = await reader.read();
                if (streamDone) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop() || '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    let ev;
                    try { ev = JSON.parse(trimmed); } catch { continue; }
                    if (ev.type === 'progress') {
                        done += 1;
                        const targetItem = targets[Number(ev.index)];
                        if (targetItem) {
                            targetItem._rethumbing = false;
                            if (ev.ok && ev.thumbnail) {
                                okCount += 1;
                                applyEnhancedThumbnail(targetItem, ev.thumbnail);
                            } else {
                                failCount += 1;
                            }
                        }
                        if (ui.dossierStatus) {
                            ui.dossierStatus.textContent = `Zlepšujem thumby: ${done} / ${targets.length} (✓ ${okCount}${failCount ? ` · ✕ ${failCount}` : ''})`;
                        }
                    }
                }
            }
            if (ui.dossierStatus) {
                ui.dossierStatus.textContent = `Hotovo: vylepšených ${okCount} z ${targets.length} thumbov${failCount ? ` (${failCount} neúspešných)` : ''}.`;
            }
        } catch (err) {
            if (ui.dossierStatus) ui.dossierStatus.textContent = `Dávkové zlepšenie zlyhalo: ${err.message}`;
        } finally {
            targets.forEach(it => { it._rethumbing = false; });
            state.batchRethumbBusy = false;
            renderDossierGrid();
        }
    }

    async function importItemsPayload(itemsToImport) {
        const creatorName = state.activeDossier?.creator?.name || 'Creator Radar';
        return fetchJson('/api/vault/import', {
            method: 'POST',
            body: JSON.stringify({
                batch_name: `Radar · ${creatorName}`,
                items: itemsToImport.map(item => ({
                    id: String(item.id || ''),
                    bucket: item.bucket || 'forum',
                    url: item.url || '',
                    source_url: item.source_url || '',
                    title: item.title || creatorName,
                    thumbnail: item.thumbnail || '',
                    duration_sec: Number(item.duration_sec || 0),
                    height: Number(item.height || 0),
                    quality: item.quality || '',
                    size_mb: item.size_mb ?? null,
                    telegram_meta: item.telegram_meta || null,
                })),
            }),
        });
    }

    async function importVisibleFinding(visibleIdx, btn) {
        const item = state.visibleItems?.[visibleIdx];
        if (!item) return;
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.textContent = 'Importujem...';
        try {
            await importItemsPayload([item]);
            btn.textContent = 'Importované ✓';
            btn.classList.add('is-done');
            const ui = getUi();
            if (ui.dossierStatus) ui.dossierStatus.textContent = 'Položka bola odoslaná do importnej fronty.';
        } catch (err) {
            btn.disabled = false;
            btn.innerHTML = original;
            const ui = getUi();
            if (ui.dossierStatus) ui.dossierStatus.textContent = `Import zlyhal: ${err.message}`;
        }
    }

    async function importSelectedFindings() {
        const ui = getUi();
        const selected = (state.visibleItems || []).filter(it =>
            state.selectedKeys.has(itemKey(it)) &&
            state.activeTab === 'vault' &&
            it.can_import !== false &&
            (it.url || it.source_url || it.telegram_meta)
        );
        if (!selected.length || !ui.importSelectedBtn) return;
        ui.importSelectedBtn.disabled = true;
        try {
            await importItemsPayload(selected);
            selected.forEach(it => state.selectedKeys.delete(itemKey(it)));
            if (ui.dossierStatus) ui.dossierStatus.textContent = `Odoslaných ${selected.length} položiek do importnej fronty.`;
            renderDossierGrid();
        } catch (err) {
            if (ui.dossierStatus) ui.dossierStatus.textContent = `Hromadný import zlyhal: ${err.message}`;
        } finally {
            ui.importSelectedBtn.disabled = false;
        }
    }

    async function loadCreators(autoSelectName = '') {
        state.loadingList = true;
        renderCreatorList();
        try {
            const params = new URLSearchParams({
                q: state.searchQuery || '',
                limit: '80',
                only_followed: state.filterMode === 'followed' ? 'true' : 'false',
            });
            const data = await fetchJson(`/api/v1/radar/creators?${params.toString()}`);
            state.creators = Array.isArray(data.creators) ? data.creators : [];
            const ui = getUi();
            if (ui.statFollowed) ui.statFollowed.textContent = `${Number(data.followed_count || 0)} sledovaných`;
            if (ui.statDiscovered) ui.statDiscovered.textContent = `${Number(data.discovered_count || 0)} v knižnici`;
            renderCreatorList();

            if (autoSelectName) {
                await selectCreator(autoSelectName);
            } else if (!state.activeSlug && state.creators.length) {
                await selectCreator(state.creators[0].name);
            }
        } catch (err) {
            const ui = getUi();
            if (ui.listEl) ui.listEl.innerHTML = `<div class="cradar-empty-mini">Chyba načítania: ${esc(err.message)}</div>`;
        } finally {
            state.loadingList = false;
        }
    }

    async function selectCreator(name) {
        const clean = String(name || '').trim();
        if (!clean) return;
        state.loadingDossier = true;
        state.activeSlug = clean.toLowerCase();
        state.selectedKeys.clear();
        renderDossier();
        try {
            const data = await fetchJson(`/api/v1/radar/dossier?name=${encodeURIComponent(clean)}&limit=120`);
            state.activeDossier = data;
            state.activeSlug = data.creator?.slug || state.activeSlug;
            const hasVault = (data.vault_findings || []).length > 0;
            const hasLib = (data.library_videos || []).length > 0;
            if (!hasVault && hasLib) state.activeTab = 'library';
            else if (hasVault) state.activeTab = 'vault';
            renderCreatorList();
            renderDossier();
        } catch (err) {
            const ui = getUi();
            if (ui.gridEl) ui.gridEl.innerHTML = `<div class="cradar-empty-mini">Chyba načítania dossieru: ${esc(err.message)}</div>`;
        } finally {
            state.loadingDossier = false;
            renderDossier();
        }
    }

    async function toggleFollow(name, creatorId) {
        try {
            if (creatorId) {
                await fetchJson(`/api/v1/radar/follow/${Number(creatorId)}`, { method: 'DELETE' });
            } else {
                await fetchJson('/api/v1/radar/follow', {
                    method: 'POST',
                    body: JSON.stringify({ name }),
                });
            }
            await loadCreators(state.activeDossier?.creator?.name === name ? name : '');
            if (state.activeDossier?.creator?.name === name) {
                await selectCreator(name);
            }
        } catch (err) {
            const ui = getUi();
            if (ui.dossierStatus) ui.dossierStatus.textContent = err.message;
        }
    }

    function open(initialName = '') {
        const ui = getUi();
        if (!ui.overlay) return;
        state.open = true;
        ui.overlay.hidden = false;
        ui.overlay.setAttribute('aria-hidden', 'false');
        document.body.classList.add('cradar-open');
        loadCreators(initialName);
        setTimeout(() => ui.searchInput?.focus(), 60);
    }

    function close() {
        closeInlinePlayer();
        const ui = getUi();
        if (!ui.overlay) return;
        state.open = false;
        ui.overlay.hidden = true;
        ui.overlay.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('cradar-open');
    }

    function bindEvents() {
        const ui = getUi();
        if (!ui.overlay || ui.overlay.dataset.bound === '1') return;
        ui.overlay.dataset.bound = '1';

        ui.closeBtn?.addEventListener('click', close);
        ui.overlay.addEventListener('click', ev => {
            if (ev.target === ui.overlay) close();
        });

        ui.addForm?.addEventListener('submit', async ev => {
            ev.preventDefault();
            const val = (ui.addInput?.value || '').trim();
            if (val.length < 2) return;
            await fetchJson('/api/v1/radar/follow', {
                method: 'POST',
                body: JSON.stringify({ name: val }),
            });
            if (ui.addInput) ui.addInput.value = '';
            await loadCreators(val);
        });

        let searchTimer = null;
        ui.searchInput?.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                state.searchQuery = (ui.searchInput?.value || '').trim();
                loadCreators('');
            }, 180);
        });

        ui.overlay.querySelectorAll('[data-cr-filter]').forEach(btn => {
            btn.addEventListener('click', () => {
                state.filterMode = btn.getAttribute('data-cr-filter') || 'all';
                ui.overlay.querySelectorAll('[data-cr-filter]').forEach(b => {
                    const active = b === btn;
                    b.classList.toggle('active', active);
                    b.setAttribute('aria-selected', active ? 'true' : 'false');
                });
                loadCreators('');
            });
        });

        ui.overlay.querySelectorAll('[data-cr-tab]').forEach(btn => {
            btn.addEventListener('click', () => {
                state.activeTab = btn.getAttribute('data-cr-tab') || 'vault';
                state.selectedKeys.clear();
                renderDossier();
            });
        });

        // Dossier Filter & Sort Toolbar listeners
        let localFilterTimer = null;
        ui.localFilterInput?.addEventListener('input', () => {
            clearTimeout(localFilterTimer);
            localFilterTimer = setTimeout(() => {
                state.localQuery = ui.localFilterInput?.value || '';
                renderDossierGrid();
            }, 120);
        });
        ui.sortSelect?.addEventListener('change', () => {
            state.sortBy = ui.sortSelect.value || 'default';
            renderDossierGrid();
        });
        ui.minQualSelect?.addEventListener('change', () => {
            state.minHeight = Number(ui.minQualSelect.value || 0);
            renderDossierGrid();
        });
        ui.minDurSelect?.addEventListener('change', () => {
            state.minDurationSec = Number(ui.minDurSelect.value || 0);
            renderDossierGrid();
        });
        ui.sourceSelect?.addEventListener('change', () => {
            state.sourceFilter = ui.sourceSelect.value || 'all';
            renderDossierGrid();
        });

        // Selection bar actions
        ui.selectAllBtn?.addEventListener('click', () => {
            const visible = state.visibleItems || [];
            if (!visible.length) return;
            const visibleKeys = visible.map(it => itemKey(it));
            const allSelected = visibleKeys.every(k => state.selectedKeys.has(k));
            if (allSelected) {
                visibleKeys.forEach(k => state.selectedKeys.delete(k));
            } else {
                visibleKeys.forEach(k => state.selectedKeys.add(k));
            }
            renderDossierGrid();
        });

        ui.rethumbBtn?.addEventListener('click', rethumbBatchFindings);
        ui.splitBtn?.addEventListener('click', launchSplitScreen);
        ui.importSelectedBtn?.addEventListener('click', importSelectedFindings);

        // Creator sidebar clicks
        ui.listEl?.addEventListener('click', ev => {
            const starBtn = ev.target.closest('[data-cr-toggle-follow]');
            if (starBtn) {
                ev.stopPropagation();
                toggleFollow(
                    starBtn.getAttribute('data-cr-toggle-follow'),
                    starBtn.getAttribute('data-cr-id') || null
                );
                return;
            }
            const card = ev.target.closest('[data-cr-select]');
            if (card) {
                selectCreator(card.getAttribute('data-cr-select'));
            }
        });

        // Grid card clicks: selector, Ctrl+click, play, import
        ui.gridEl?.addEventListener('click', ev => {
            const cardEl = ev.target.closest('.cradar-card');
            if (!cardEl) return;
            const idx = Number(cardEl.getAttribute('data-cr-idx'));
            const key = cardEl.getAttribute('data-cr-key');

            const cb = ev.target.closest('.cradar-select-cb, .cradar-select-wrap');
            if (cb || (ev.ctrlKey && !ev.target.closest('button, a'))) {
                if (!cb) ev.preventDefault();
                if (key) {
                    if (state.selectedKeys.has(key)) state.selectedKeys.delete(key);
                    else state.selectedKeys.add(key);
                    const box = cardEl.querySelector('.cradar-select-cb');
                    if (box) box.checked = state.selectedKeys.has(key);
                    cardEl.classList.toggle('is-selected', state.selectedKeys.has(key));
                    cardEl.classList.toggle('nuss-page-selected', state.selectedKeys.has(key));
                    updateSelectionBarUi();
                }
                return;
            }

            const rethumbBtn = ev.target.closest('[data-cr-rethumb-idx]');
            if (rethumbBtn) {
                rethumbVisibleFinding(Number(rethumbBtn.getAttribute('data-cr-rethumb-idx')), rethumbBtn);
                return;
            }

            const impBtn = ev.target.closest('[data-cr-import-idx]');
            if (impBtn) {
                importVisibleFinding(Number(impBtn.getAttribute('data-cr-import-idx')), impBtn);
                return;
            }

            const playTarget = ev.target.closest('[data-cr-play-idx]');
            if (playTarget && !ev.target.closest('a')) {
                const item = state.visibleItems?.[Number(playTarget.getAttribute('data-cr-play-idx'))];
                if (item) openInlinePlayer(item);
            }
        });

        // Inline Player listeners
        ui.playerCloseBtn?.addEventListener('click', closeInlinePlayer);
        ui.playerOverlay?.addEventListener('click', ev => {
            if (ev.target === ui.playerOverlay) closeInlinePlayer();
        });
        ui.playerRefreshBtn?.addEventListener('click', async () => {
            if (!state.playerItem || !state.playerItem.video_id) return;
            if (ui.playerError) ui.playerError.hidden = true;
            state.playerRetryDone = false;
            const runToken = ++state.playerRunToken;
            try {
                const fresh = await resolveFreshStream(state.playerItem, true);
                if (runToken !== state.playerRunToken) return;
                if (fresh && fresh.streamUrl) {
                    state.playerItem.url = fresh.streamUrl;
                    state.playerItem.is_hls = fresh.isHls;
                    const nextUrl = buildLibraryPlaybackUrl(fresh.streamUrl, state.playerItem.source_url || '', state.playerItem.video_id, fresh.isHls, fresh.proxySession);
                    attachInlineStream(nextUrl, state.playerItem, runToken);
                    return;
                }
            } catch {}
            handleInlinePlayerFailure();
        });
        ui.playerOpenMainBtn?.addEventListener('click', () => {
            const vidId = Number(state.playerItem?.video_id || 0);
            if (!vidId) return;
            close();
            window.dispatchEvent(new CustomEvent('nexus:play-video-id', { detail: { id: vidId } }));
        });
        ui.playerVideo?.addEventListener('playing', () => setInlinePlayerStatus(''));
        ui.playerVideo?.addEventListener('error', () => {
            if (ui.playerOverlay && !ui.playerOverlay.hidden) handleInlinePlayerFailure();
        });

        document.addEventListener('keydown', ev => {
            if (!state.open) return;
            if (ev.key === 'Escape') {
                ev.preventDefault();
                if (ui.playerOverlay && !ui.playerOverlay.hidden) closeInlinePlayer();
                else close();
            }
        });

        window.addEventListener('nexus:open-creator-radar', ev => {
            open(ev?.detail?.name || '');
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindEvents);
    } else {
        bindEvents();
    }

    window.NexusCreatorRadar = { open, close, selectCreator, loadCreators, launchSplitScreen };
})();
