// ============================================
// QUANTUM SEARCH - Advanced Search Interface
// ============================================

class QuantumSearch {
    constructor() {
        this.overlay = null;
        this.results = [];
        this.filteredResults = [];
        this.activeSource = 'all';
        this.isSearching = false;
        this._abortController = null;
        this._activeControllers = [];
        this._searchRunId = 0;
        this._orientationThumbnailPending = new Set();
        this._orientationThumbnailScanInProgress = false;
        this._orientationRefreshPending = false;
        this._libraryStatusCache = new Map();
        this._libraryCheckTimer = null;
        this.selectedUrls = new Set();
        this.downloads = {};
        this.diagnostics = [];
        this.settings = JSON.parse(localStorage.getItem('quantum_settings') || '{"autoImport": false, "quality": "best", "limitPerSource": 30, "limitTotal": 100}');
        this.searchFilters = { quality: ['all'], source: ['all'], minSizeMb: 0 };
        this.activeFilters = { duration: 0, orientation: 'all' };
        this.activeSort = 'relevance';
        const savedResultLayout = localStorage.getItem('quantum_result_layout');
        this.resultLayout = ['5x3', '5x2', '4x4'].includes(savedResultLayout) ? savedResultLayout : '5x3';
        // Keep the first view focused on the query and results.
        this.isSetupOpen = false;
        const savedSearchMode = parseInt(localStorage.getItem('quantum_search_mode') || '1', 10);
        this.searchMode = [1, 2, 3].includes(savedSearchMode) ? savedSearchMode : 1;
        this.omegaPreset = localStorage.getItem('quantum_omega_preset') || 'all';
        this.activeOmegaLayer = 'all';
        this._omegaLayerCounts = {};
        this._omegaEventSource = null;
        this.globalTelegram = false;
        this.selectedTelegramChatIds = new Set();
        this.selectedTelegramTopics = new Map();
        this._telegramTopicSort = 'newest';
        this._savedTelegramTopics = null;
        this._lastQuery = '';
        this._sourceLoaded = {};   // per-source highest limit already fetched
        this._loadingMore = {};    // per-source in-flight guard
        this._metaPending = new Map();
        this._metaControllers = new Set();
        this._activityLog = [];
        this.sourceCatalog = [];
        this.megaPacksMode = false;
        this._megaLinkItems = [];
        this._megaLinksTotal = 0;
        this._megaLinksHasMore = false;
        this._megaLinksCounts = null;
        this._megaLinksFilter = { status: 'active', linkKind: 'all' };
        this._lastMegaLinksQuery = '';
        this.init();
    }

    init() {
        const parseEventDetail = (detail) => {
            if (!detail) return {};
            if (typeof detail === 'string') {
                try { return JSON.parse(detail) || {}; } catch { return {}; }
            }
            return detail;
        };
        document.addEventListener('nexus-quantum-resolve', async event => {
            const request = parseEventDetail(event.detail);
            const serialize = typeof event.detail === 'string';
            const emitResolved = (payload) => {
                document.dispatchEvent(new CustomEvent('nexus-quantum-resolved', {
                    detail: serialize ? JSON.stringify(payload) : payload
                }));
            };
            try {
                const result = request.result?.url ? request.result
                    : (this.results || []).find(item => item.url === request.url)
                    || (this.filteredResults || []).find(item => item.url === request.url)
                    || (request.url ? { url: request.url } : null);
                if (!result) throw new Error('Výsledok vyhľadávania už nie je dostupný.');
                const playback = await this._resolveQuantumPlayback(result, request.url);
                emitResolved({ id: request.id, ...playback });
            } catch (error) {
                emitResolved({ id: request.id, error: error.message || String(error) });
            }
        });
        document.addEventListener('nexus-quantum-import', async event => {
            const { id, result, batchName } = parseEventDetail(event.detail);
            const serialize = typeof event.detail === 'string';
            const emitImported = (payload) => {
                document.dispatchEvent(new CustomEvent('nexus-quantum-imported', {
                    detail: serialize ? JSON.stringify(payload) : payload
                }));
            };
            try {
                const ok = await this.importVideo(result?.url, null, true, batchName, result);
                emitImported({ id, ok });
            } catch (error) {
                emitImported({ id, ok: false, error: error.message });
            }
        });
        // Create overlay HTML
        this.createOverlay();
        this.catalogPromise = this.loadSourceCatalog();
        this.startDownloadPolling();

        // Register keyboard shortcut (Ctrl+K or Cmd+K) in capture phase so nothing hijacks it
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey &&
                (e.code === 'KeyK' || (e.key && e.key.toLowerCase() === 'k'))) {
                e.preventDefault();
                e.stopPropagation();
                this.open();
                return;
            }

            // ESC to close
            if (e.key === 'Escape') {
                if (this._playerEl && this._playerEl.classList.contains('visible')) {
                    this._closePlayer();
                } else if (this.isSettingsOpen) {
                    this.toggleSettings();
                } else if (this.isOpen()) {
                    this.close();
                }
            }
        }, true);
    }

    createOverlay() {
        const html = `
            <div class="quantum-search-overlay" id="quantumSearchOverlay">
                <div class="quantum-search-container">
                    <div class="quantum-search-header">
                        <h2 class="quantum-search-title">Quantum Search</h2>
                        <div class="quantum-search-input-container">
                            <span class="quantum-search-icon" aria-hidden="true">🔍</span>
                            <input
                                type="text"
                                class="quantum-search-input"
                                id="quantumSearchInput"
                                placeholder="Search across Erome, LeakPorner, SimpCity, Telegram, and more..."
                                aria-label="Search all sources"
                                autocomplete="off"
                            >
                            <div class="quantum-search-loading" id="quantumSearchLoading"></div>
                            <button
                                type="button"
                                class="quantum-search-submit-btn"
                                id="quantumSearchSubmitBtn"
                                onclick="quantumSearch.submitSearch()"
                                title="Spustiť vyhľadávanie (Enter)"
                            >Hľadať</button>
                        </div>
                        <div class="header-actions quantum-header-actions">
                            <button
                                type="button"
                                class="quantum-setup-toggle"
                                id="quantumSetupToggle"
                                onclick="quantumSearch.toggleSetup()"
                                aria-label="Setup and filters"
                                aria-controls="quantumSearchSetup"
                                aria-expanded="false"
                            >
                                <span class="material-icons-round" aria-hidden="true">tune</span>
                                <span>Setup &amp; filters</span>
                                <span class="material-icons-round quantum-setup-chevron" aria-hidden="true">expand_less</span>
                            </button>
                            <button type="button" class="quantum-search-btn-icon" onclick="quantumSearch.toggleSettings()" title="Rozšírené nastavenia" aria-label="Rozšírené nastavenia"><span class="material-icons-round" aria-hidden="true">settings</span></button>
                            <button class="quantum-search-close" onclick="quantumSearch.close()">×</button>
                        </div>
                    </div>

                    <div class="quantum-source-shortcuts" role="group" aria-label="Zdroje vyhľadávania">
                        <span>Hľadať v:</span>
                        <button type="button" id="quantumAllSources" class="quantum-source-shortcut active" aria-pressed="true" onclick="quantumSearch.selectAllSources()">Všetky zdroje</button>
                        <button type="button" id="quantumTelegramOnly" class="quantum-source-shortcut" aria-pressed="false" onclick="quantumSearch.selectTelegramOnly()">Telegram</button>
                        <button type="button" id="quantumMegaPacksOnly" class="quantum-source-shortcut" aria-pressed="false" onclick="quantumSearch.selectMegaPacksMode()">📦 MEGA &amp; Linky</button>
                        <div id="omegaControlBar" class="omega-inline-bar" hidden>
                            <span class="omega-inline-sep" aria-hidden="true"></span>
                            <select id="omegaPresetSelect" class="omega-inline-select" aria-label="Omni-Search profil" title="Omni-Search profil zdrojov" onchange="quantumSearch.setOmegaPreset(this.value)">
                                <option value="all">Všetko (Omni)</option>
                                <option value="leaks">Leaks &amp; Creators</option>
                                <option value="tubes">HD Tubes</option>
                                <option value="fast">Fast / Bez HTML</option>
                            </select>
                            <div class="omega-layers" id="omegaLayerPills" role="group" aria-label="Filter vrstiev">
                                <button type="button" class="omega-pill active" data-omega-layer="all" onclick="quantumSearch.setOmegaLayer('all')">Všetko</button>
                                <button type="button" class="omega-pill" data-omega-layer="local_vault" onclick="quantumSearch.setOmegaLayer('local_vault')">⚡ Vault (0)</button>
                                <button type="button" class="omega-pill" data-omega-layer="telethon" onclick="quantumSearch.setOmegaLayer('telethon')">✈️ TG (0)</button>
                                <button type="button" class="omega-pill" data-omega-layer="api" onclick="quantumSearch.setOmegaLayer('api')">🚀 API (0)</button>
                                <button type="button" class="omega-pill" data-omega-layer="tube" onclick="quantumSearch.setOmegaLayer('tube')">🎥 Tubes (0)</button>
                                <button type="button" class="omega-pill" data-omega-layer="kvs_wp" onclick="quantumSearch.setOmegaLayer('kvs_wp')">🎬 KVS/WP (0)</button>
                                <button type="button" class="omega-pill" data-omega-layer="dork" onclick="quantumSearch.setOmegaLayer('dork')">🌐 Dorks (0)</button>
                            </div>
                            <div class="omega-health">
                                <span id="omegaSearxStatus" class="omega-status-pill" title="Stav lokálneho SearXNG (:8888)">SearXNG…</span>
                                <button type="button" id="omegaStartSearxBtn" class="omega-action-btn" onclick="quantumSearch.startOmegaSearxng()" hidden title="Spustiť lokálny SearXNG">▶ SearXNG</button>
                                <button type="button" class="omega-action-btn" onclick="quantumSearch.resetOmegaCircuits()" title="Odomknúť zablokované domény a vymazať cache">↻ CB</button>
                            </div>
                        </div>
                    </div>

                        <!-- Real-time Scrape Status Bar -->
                        <div class="quantum-scrape-status" id="quantumScrapeStatus" style="display:none;">
                            <div class="quantum-status-row">
                                <div class="quantum-status-indicator">
                                    <span class="quantum-status-pulse" id="quantumStatusPulse"></span>
                                    <span class="quantum-status-state" id="quantumStatusState">Pripájanie...</span>
                                </div>
                                <div class="quantum-status-stats">
                                    <span class="quantum-stat-item" id="quantumStatusCount">0 / 25 videí</span>
                                    <span class="quantum-stat-sep">•</span>
                                    <span class="quantum-stat-item" id="quantumStatusTimer">⏱️ 00:00</span>
                                    <span class="quantum-stat-sep" id="quantumEtaSep">•</span>
                                    <span class="quantum-stat-item" id="quantumStatusEta">odhad ~...</span>
                                </div>
                                <button type="button" class="quantum-status-stop-btn" id="quantumStopScrapeBtn" onclick="quantumSearch.stopScrape()" title="Okamžite zastaviť a zobraziť nájdené videá">
                                    <span class="material-icons-round" style="font-size:14px; vertical-align:middle; margin-right:4px;">stop</span>Zastaviť
                                </button>
                            </div>
                            <div class="quantum-progress-bar-track">
                                <div class="quantum-progress-bar-fill" id="quantumProgressBarFill" style="width: 0%;"></div>
                            </div>
                            <div class="quantum-status-details" id="quantumStatusDetails">
                                Iniciujem vyhľadávanie v kanáli...
                            </div>
                        </div>

                    <section class="quantum-search-setup collapsed" id="quantumSearchSetup" aria-label="Search setup" aria-hidden="true" inert>
                        <div class="quantum-search-setup-row">
                            <style>
                            .quantum-ms-container { position: relative; width: 150px; }
                            .quantum-ms-btn { background: #2a2a3a; color: white; border: 1px solid rgba(255,255,255,0.15); padding: 5px 8px; border-radius: 6px; font-size: 13px; cursor: pointer; width: 100%; text-align: left; display:flex; justify-content:space-between; align-items:center; }
                            .quantum-ms-btn::after { content: "▼"; font-size: 10px; margin-left: 8px; }
                            .quantum-ms-dropdown { position: absolute; top: 100%; left: 0; background: #1e1e2e; border: 1px solid rgba(168,85,247,0.25); border-radius: 8px; margin-top: 4px; z-index: 9999; max-height: 340px; overflow-y: auto; display: none; flex-direction: column; box-shadow: 0 8px 24px rgba(0,0,0,0.7); min-width: 200px; }
                            .quantum-ms-dropdown::-webkit-scrollbar { width: 6px; }
                            .quantum-ms-dropdown::-webkit-scrollbar-track { background: transparent; }
                            .quantum-ms-dropdown::-webkit-scrollbar-thumb { background: rgba(168,85,247,0.4); border-radius: 3px; }
                            .quantum-ms-group-label { padding: 6px 10px 3px; font-size: 10px; font-weight: 700; color: rgba(168,85,247,0.8); text-transform: uppercase; letter-spacing: 1px; border-top: 1px solid rgba(255,255,255,0.06); margin-top: 2px; }
                            .quantum-ms-group-label:first-child { border-top: none; margin-top: 0; }
                            .quantum-ms-dropdown label { padding: 6px 10px; margin: 0; display: flex; align-items: center; gap: 8px; font-size: 12.5px; cursor: pointer; transition: background 0.15s; color: rgba(255,255,255,0.9); }
                            .quantum-ms-dropdown label:hover { background: rgba(168,85,247,0.12); }
                            .quantum-ms-dropdown input { accent-color: #a855f7; cursor:pointer; width:14px; height:14px; flex-shrink:0; }
                            .quantum-ms-select-actions { display: flex; gap: 6px; padding: 6px 10px; border-top: 1px solid rgba(255,255,255,0.06); }
                            .quantum-ms-select-actions button { flex: 1; background: rgba(168,85,247,0.15); color: rgba(255,255,255,0.7); border: 1px solid rgba(168,85,247,0.2); border-radius: 4px; padding: 3px 6px; font-size: 11px; cursor: pointer; transition: background 0.15s; }
                            .quantum-ms-select-actions button:hover { background: rgba(168,85,247,0.3); color: white; }
                            </style>
                            <div class="quantum-filter-group" style="position:relative;">
                                <label>Quality:</label>
                                <div class="quantum-ms-container" style="width:140px;">
                                    <button class="quantum-ms-btn" id="ms-btn-quality" onclick="quantumSearch.toggleMultiselect('ms-drop-quality')">All Qualities</button>
                                    <div class="quantum-ms-dropdown" id="ms-drop-quality">
                                        <label><input type="checkbox" value="all" checked onchange="quantumSearch.handleMSChange('quality', this)"> All Qualities</label>
                                        <label><input type="checkbox" value="4K" onchange="quantumSearch.handleMSChange('quality', this)"> 4K (2160p)</label>
                                        <label><input type="checkbox" value="1080p" onchange="quantumSearch.handleMSChange('quality', this)"> Full HD (1080p+)</label>
                                        <label><input type="checkbox" value="720p" onchange="quantumSearch.handleMSChange('quality', this)"> HD (720p+)</label>
                                        <label><input type="checkbox" value="HD" onchange="quantumSearch.handleMSChange('quality', this)"> HD (any)</label>
                                        <label><input type="checkbox" value="480p" onchange="quantumSearch.handleMSChange('quality', this)"> SD (480p)</label>
                                    </div>
                                </div>
                            </div>
                            <div class="quantum-filter-group">
                                <label for="quantum-min-size">Min size:</label>
                                <input type="number" id="quantum-min-size" min="0" step="10" placeholder="0 MB" title="Minimum file size in MB (0 = no limit)" style="width:90px;background:rgba(0,0,0,0.3);color:#fff;border:1px solid rgba(168,85,247,0.3);border-radius:6px;padding:5px 8px;font-size:12.5px;" oninput="quantumSearch.setMinSize(this.value)">
                                <span style="font-size:11px;opacity:.6;">MB</span>
                            </div>
                            <div class="quantum-filter-group" style="position:relative;">
                                <label>Source:</label>
                                <div class="quantum-ms-container" style="width:160px;">
                                    <button class="quantum-ms-btn" id="ms-btn-source" onclick="quantumSearch.toggleMultiselect('ms-drop-source')">All Sources</button>
                                    <div class="quantum-ms-dropdown" id="ms-drop-source">
                                        <label style="background:rgba(168,85,247,0.08);"><input type="checkbox" value="all" checked onchange="quantumSearch.handleMSChange('source', this)"> ✦ All Sources</label>
                                        
                                        <div class="quantum-ms-group-label">🔥 Populárne</div>
                                        <label><input type="checkbox" value="xvideos" onchange="quantumSearch.handleMSChange('source', this)"> XVideos</label>
                                        <label><input type="checkbox" value="pornhub" onchange="quantumSearch.handleMSChange('source', this)"> Pornhub</label>
                                        <label><input type="checkbox" value="xhamster" onchange="quantumSearch.handleMSChange('source', this)"> xHamster</label>
                                        <label><input type="checkbox" value="eporner" onchange="quantumSearch.handleMSChange('source', this)"> Eporner</label>
                                        <label><input type="checkbox" value="spankbang" onchange="quantumSearch.handleMSChange('source', this)"> SpankBang</label>
                                        <label><input type="checkbox" value="noodlemagazine" onchange="quantumSearch.handleMSChange('source', this)"> NoodleMagazine</label>
                                        <label><input type="checkbox" value="hqporner" onchange="quantumSearch.handleMSChange('source', this)"> HQPorner</label>
                                        <label><input type="checkbox" value="whoreshub" onchange="quantumSearch.handleMSChange('source', this)"> WhoresHub</label>
                                        <label><input type="checkbox" value="porntrex" onchange="quantumSearch.handleMSChange('source', this)"> PornTrex</label>

                                        <div class="quantum-ms-group-label">🌐 Fóra / Komunity</div>
                                        <label><input type="checkbox" value="erome" onchange="quantumSearch.handleMSChange('source', this)"> Erome</label>
                                        <label><input type="checkbox" value="simpcity" onchange="quantumSearch.handleMSChange('source', this)"> SimpCity</label>
                                        <label><input type="checkbox" value="telegram" onchange="quantumSearch.handleMSChange('source', this)"> Telegram</label>
                                        <label><input type="checkbox" value="reddit" onchange="quantumSearch.handleMSChange('source', this)"> Reddit</label>
                                        <label><input type="checkbox" value="camwhores" onchange="quantumSearch.handleMSChange('source', this)"> Camwhores</label>
                                        <label><input type="checkbox" value="cyberleaks" onchange="quantumSearch.handleMSChange('source', this)"> CyberLeaks</label>
                                        <label><input type="checkbox" value="leakporner" onchange="quantumSearch.handleMSChange('source', this)"> LeakPorner</label>
                                        <label><input type="checkbox" value="nsfw247" onchange="quantumSearch.handleMSChange('source', this)"> NSFW247</label>
                                        <label><input type="checkbox" value="mypornerleak" onchange="quantumSearch.handleMSChange('source', this)"> MyPornerLeak</label>

                                        <div class="quantum-ms-group-label">☁️ Úložiská</div>
                                        <label><input type="checkbox" value="bunkr" onchange="quantumSearch.handleMSChange('source', this)"> Bunkr</label>
                                        <label><input type="checkbox" value="gofile" onchange="quantumSearch.handleMSChange('source', this)"> GoFile</label>
                                        <label><input type="checkbox" value="pixeldrain" onchange="quantumSearch.handleMSChange('source', this)"> Pixeldrain</label>

                                        <div class="quantum-ms-group-label">🔍 Vyhľadávače</div>
                                        <label><input type="checkbox" value="google" onchange="quantumSearch.handleMSChange('source', this)"> Google (web)</label>
                                        <label><input type="checkbox" value="yandex" onchange="quantumSearch.handleMSChange('source', this)"> Yandex</label>
                                        <label><input type="checkbox" value="vkvideo" onchange="quantumSearch.handleMSChange('source', this)"> VKVideo</label>
                                        <label><input type="checkbox" value="djav" onchange="quantumSearch.handleMSChange('source', this)"> DJAV</label>

                                        <div class="quantum-ms-group-label">🎭 Ostatné</div>
                                        <label><input type="checkbox" value="hornysimp" onchange="quantumSearch.handleMSChange('source', this)"> HornySimp</label>
                                        <label><input type="checkbox" value="pimpbunny" onchange="quantumSearch.handleMSChange('source', this)"> PimpBunny</label>
                                        <label><input type="checkbox" value="oneporn" onchange="quantumSearch.handleMSChange('source', this)"> 1Porn</label>
                                        <label><input type="checkbox" value="fpo" onchange="quantumSearch.handleMSChange('source', this)"> FPO.xxx</label>
                                        <label><input type="checkbox" value="pornone" onchange="quantumSearch.handleMSChange('source', this)"> PornOne</label>

                                        <div class="quantum-ms-select-actions">
                                            <button onclick="quantumSearch.selectAllSources()">Všetky</button>
                                            <button onclick="quantumSearch.selectFastSources()">Rýchle ⚡</button>
                                            <button onclick="quantumSearch.clearSources()" data-i18n="None">${window.__nexus_t ? window.__nexus_t('Žiadne') : 'Žiadne'}</button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div class="quantum-filter-group" style="align-items:center;">
                                <label for="searchLimitPerSource" style="white-space:nowrap;">Per source:</label>
                                <input type="number" id="searchLimitPerSource" min="1" max="500" style="width:52px; background:#2a2a3a; color:white; border:1px solid rgba(255,255,255,0.15); border-radius:6px; padding:3px 6px; font-size:13px;" value="20" onchange="quantumSearch.saveLimits()">
                            </div>
                            <div class="quantum-filter-group" style="align-items:center;">
                                <label for="searchLimitTotal" style="white-space:nowrap;">Total:</label>
                                <input type="number" id="searchLimitTotal" min="1" max="2000" style="width:60px; background:#2a2a3a; color:white; border:1px solid rgba(255,255,255,0.15); border-radius:6px; padding:3px 6px; font-size:13px;" value="100" onchange="quantumSearch.saveLimits()">
                            </div>
                        </div>

                        <div class="quantum-mode-switch" role="group" aria-label="Search mode">
                            <button type="button" id="quantumMode1" onclick="quantumSearch.setSearchMode(1)">Quantum Search</button>
                            <button type="button" id="quantumMode2" onclick="quantumSearch.setSearchMode(2)">Quantum Search 2</button>
                            <button type="button" id="quantumMode3" onclick="quantumSearch.setSearchMode(3)">Omni-Search SSE</button>
                            <span id="quantumModeHint"></span>
                            <label>
                                <input type="checkbox" id="quantumQuickSearch">
                                Rýchle hľadanie
                            </label>
                        </div>

                        <div class="quantum-channel-scrape">
                            <label for="telegramChannelInput">Channel</label>
                            <div class="telegram-chat-picker">
                                <button type="button" id="telegramJoinedChatsButton" aria-expanded="false" onclick="quantumSearch.toggleTelegramChats()">Moje kanály / skupiny</button>
                                <div id="telegramJoinedChats" class="telegram-chat-options" hidden>
                                    <div class="telegram-chat-controls">
                                        <input type="search" id="telegramChatSearchInput" class="telegram-chat-search" placeholder="Hľadať kanál, skupinu alebo thread..." autocomplete="off" spellcheck="false" oninput="quantumSearch.filterTelegramChats(this.value)">
                                        <div class="telegram-chat-actions">
                                            <button type="button" id="telegramSelectFilteredBtn" onclick="quantumSearch.selectFilteredTelegramChats()">Select filtered</button>
                                            <button type="button" id="telegramSelectAllBtn" onclick="quantumSearch.selectAllTelegramChats()">Select all</button>
                                            <button type="button" id="telegramClearChatsBtn" onclick="quantumSearch.clearSelectedTelegramChats()" title="Zrušiť výber všetkých">Clear</button>
                                            <select id="telegramChatSort" class="telegram-topic-sort telegram-chat-sort" aria-label="Zoradiť kanály a skupiny" onchange="quantumSearch.setTelegramChatSort(this.value)">
                                                <option value="newest">Najnovšie</option>
                                                <option value="largest">Najväčšie</option>
                                                <option value="name">Názov</option>
                                            </select>
                                        </div>
                                        <button type="button" id="telegramRefreshMissingCounts" class="telegram-refresh-counts" disabled onclick="quantumSearch.refreshAllMissingTopicCounts()" title="Doplní počet videí len pri threadoch, ktoré ho ešte nemajú">Doplniť chýbajúce</button>
                                    </div>
                                    <div id="telegramJoinedChatsList" class="telegram-chat-list"></div>
                                    <div id="telegramJoinedChatsEmpty" class="telegram-chat-empty" hidden>Žiadne zodpovedajúce kanály, skupiny ani thready</div>
                                </div>
                            </div>
                            <input type="text" id="telegramChannelInput" placeholder="durov" autocomplete="off" spellcheck="false" maxlength="128">
                            <div class="telegram-history-picker">
                                <button type="button" id="telegramHistoryButton" aria-expanded="false" onclick="quantumSearch.toggleTelegramHistory()">História hľadania</button>
                                <div id="telegramSearchHistory" class="telegram-history-options" hidden></div>
                            </div>
                            <label for="telegramKeywordInput">Keywords</label>
                            <input type="text" id="telegramKeywordInput" placeholder="napr. cherry, blonde" autocomplete="off" spellcheck="false" maxlength="200" title="Kľúčové slová (oddelené čiarkou pre viacero)">
                            <label for="telegramExcludeInput">Vylúčiť</label>
                            <input type="text" id="telegramExcludeInput" placeholder="napr. gay, slovo" autocomplete="off" maxlength="200" title="Vylúčiť slová z názvu, popisu a tagov (oddelené čiarkou)">
                            <label for="telegramLimitSelect">Limit</label>
                            <select id="telegramLimitSelect" onchange="quantumSearch.onTelegramLimitSelectChange(this.value)" title="Možnosti počtu videí">
                                <option value="25">25</option>
                                <option value="50">50</option>
                                <option value="100">100</option>
                                <option value="200">200</option>
                                <option value="500">500</option>
                                <option value="1000">1000</option>
                                <option value="custom">Vlastný...</option>
                            </select>
                            <input type="number" id="telegramScrapeLimit" min="1" max="2000" value="50" style="display:none; width:64px;" onchange="quantumSearch.onTelegramLimitCustomChange()" placeholder="1-2000">
                            <button type="button" class="quantum-btn" id="scrapeChannelBtn" onclick="quantumSearch.scrapeChannel()">Scrape Channel</button>
                            <button type="button" class="quantum-btn" id="telegramGlobalSearchBtn" aria-pressed="false" onclick="quantumSearch.toggleGlobalSearch(this)">Global Search (My Channels)</button>
                            <div class="telegram-help-picker">
                                <button type="button" id="telegramSearchHelpBtn" class="quantum-btn telegram-help-btn" aria-expanded="false" onclick="quantumSearch.toggleTelegramHelp()" title="Návod: ako najrýchlejšie a najlepšie vyhľadávať na Telegrame">ℹ️ Info</button>
                                <div id="telegramSearchHelpPopover" class="telegram-help-popover" hidden role="dialog" aria-label="Návod na Telegram vyhľadávanie">
                                    <div class="telegram-help-header">
                                        <strong>📖 Ako vyhľadávať na Telegrame (rýchly návod)</strong>
                                        <button type="button" class="telegram-help-close" onclick="quantumSearch.toggleTelegramHelp(false)" aria-label="Zavrieť návod">✕</button>
                                    </div>
                                    <div class="telegram-help-body">
                                        <div class="telegram-help-item">
                                            <span class="telegram-help-badge">⚡ Najrýchlejšie</span>
                                            <div><strong>Hľadanie vo všetkých kanáloch naraz:</strong> Zapni <code>Global Search</code> (alebo nechaj prázdny <em>Channel</em>), napíš slovo do <em>Keywords</em> a stlač <code>Enter</code>. Vyhľadá lokálny katalóg za pár milisekúnd a nájde aj <code>#Tagy_S_Podčiarkovníkom</code> či <code>CamelCase</code>.</div>
                                        </div>
                                        <div class="telegram-help-item">
                                            <span class="telegram-help-badge">🎯 Konkrétne</span>
                                            <div><strong>Jeden kanál alebo thready:</strong> Vyber si kanály/thready v <em>Moje kanály / skupiny</em> (alebo napíš <code>@nazov</code>), zadaj <em>Keywords</em> a klikni <code>Scrape Channel</code>.</div>
                                        </div>
                                        <div class="telegram-help-item">
                                            <span class="telegram-help-badge">🔤 Tipy</span>
                                            <div>
                                                <strong>Chytré zapisovanie slov (Keywords):</strong><br>
                                                • <code>cherry kiss</code> (medzera) = musia byť <strong>obe</strong> slová<br>
                                                • <code>cherry, blonde</code> alebo <code>cherry | blonde</code> = stačí <strong>jedno z nich</strong><br>
                                                • <code>-gay</code> alebo <code>!gay</code> (prípadne pole <em>Vylúčiť</em>) = <strong>vynechá</strong> nechcené videá
                                            </div>
                                        </div>
                                        <div class="telegram-help-item">
                                            <span class="telegram-help-badge">🔎 Viac videí</span>
                                            <div>
                                                • V sekcii <em>Telegram katalóg</em> klikni na <strong>Dohľadať na Telegrame</strong> – prehľadá Telegram naživo a spojí výsledky s lokálnym indexom.<br>
                                                • Prepni <strong>Sort</strong> (<code>Views</code>, <code>Duration</code>, <code>Quality</code>, <code>Size</code>) – pri katalógu vytiahne top videá z celého indexu, nielen z prvej stránky.
                                            </div>
                                        </div>
                                        <div class="telegram-help-item">
                                            <span class="telegram-help-badge">✨ Novinky</span>
                                            <div><strong>✨ Nové videá mimo knižnice</strong> ukáže všetky videá z indexu, ktoré ešte nemáš v dashboarde. <strong>⚡ Nové naživo</strong> bleskovo skontroluje posledné príspevky priamo na Telegrame.</div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="quantum-search-refinements">
                            <div class="refinement-group">
                                <span>Sort:</span>
                                <button class="refine-btn active" onclick="quantumSearch.setSort('relevance', this)">Relevance</button>
                                <button class="refine-btn" onclick="quantumSearch.setSort('date', this)">Date</button>
                                <button class="refine-btn" onclick="quantumSearch.setSort('views', this)">Views</button>
                                <button class="refine-btn" onclick="quantumSearch.setSort('duration', this)">Duration</button>
                                <button class="refine-btn" onclick="quantumSearch.setSort('quality', this)">Quality</button>
                                <button class="refine-btn" onclick="quantumSearch.setSort('size', this)">Size</button>
                            </div>
                            <div class="refinement-group" data-filter-group="quality">
                                <span>Quality:</span>
                                <button class="refine-btn active" data-filter-value="all" onclick="quantumSearch.setQuickQualityFilter('all', this)">Any</button>
                                <button class="refine-btn" data-filter-value="720p" onclick="quantumSearch.setQuickQualityFilter('720p', this)">720p+</button>
                                <button class="refine-btn" data-filter-value="1080p" onclick="quantumSearch.setQuickQualityFilter('1080p', this)">1080p+</button>
                                <button class="refine-btn" data-filter-value="4K" onclick="quantumSearch.setQuickQualityFilter('4K', this)">4K</button>
                            </div>
                            <div class="refinement-group" data-filter-group="duration">
                                <span>Duration:</span>
                                <button class="refine-btn active" data-filter-value="0" onclick="quantumSearch.setDurationFilter(0, this)">Any</button>
                                <button class="refine-btn" data-filter-value="60" onclick="quantumSearch.setDurationFilter(60, this)">1m+</button>
                                <button class="refine-btn" data-filter-value="120" onclick="quantumSearch.setDurationFilter(120, this)">2m+</button>
                                <button class="refine-btn" data-filter-value="300" onclick="quantumSearch.setDurationFilter(300, this)">5m+</button>
                                <button class="refine-btn" data-filter-value="600" onclick="quantumSearch.setDurationFilter(600, this)">10m+</button>
                                <button class="refine-btn" data-filter-value="1200" onclick="quantumSearch.setDurationFilter(1200, this)">20m+</button>
                            </div>
                            <div class="refinement-group" data-filter-group="orientation">
                                <span>Orientation:</span>
                                <button class="refine-btn active" data-filter-value="all" onclick="quantumSearch.setOrientationFilter('all', this)">Any</button>
                                <button class="refine-btn" data-filter-value="landscape" onclick="quantumSearch.setOrientationFilter('landscape', this)">Landscape (16:9)</button>
                                <button class="refine-btn" data-filter-value="portrait" onclick="quantumSearch.setOrientationFilter('portrait', this)">Portrait (9:16)</button>
                                <button class="refine-btn" data-filter-value="portrait_any" onclick="quantumSearch.setOrientationFilter('portrait_any', this)" title="Potvrdené aj pravdepodobné vertikálne videá">Vertical (all)</button>
                                <button class="refine-btn" data-filter-value="portrait_estimate" onclick="quantumSearch.setOrientationFilter('portrait_estimate', this)" title="Len nepotvrdené odhady (názov, tagy, náhľad)">Likely vertical</button>
                            </div>
                        </div>
                        
                        <div class="quantum-search-sources" id="quantumSearchSources">
                            <span class="source-badge active" data-source="all">All Sources</span>
                        </div>
                        <details id="quantumSourceAudit" style="color:#b9afc9;font-size:12px;margin:6px 0 10px;display:none"><summary style="cursor:pointer">Source diagnostics</summary><div id="quantumSourceAuditRows" style="max-height:210px;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:5px;margin-top:7px"></div></details>

                    </section>

                        <details class="telegram-catalog" aria-label="Telegram katalóg">
                            <summary class="telegram-catalog-summary">
                                <strong>Telegram katalóg</strong>
                                <span id="telegramCatalogStatus" role="status">Lokálny index metadát</span>
                            </summary>
                            <div class="telegram-catalog-row">
                                <span id="telegramCatalogCoverage">Videá sa nesťahujú. Náhľady sa načítajú až pri zobrazení výsledkov.</span>
                                <button type="button" id="telegramCatalogToggle" onclick="quantumSearch.toggleTelegramCatalog()">Spustiť indexovanie</button>
                                <button type="button" onclick="quantumSearch.prioritizeTelegramCatalog()" title="Uprednostni kanály označené v Moje kanály / skupiny">Uprednostniť vybrané</button>
                                <button type="button" onclick="quantumSearch.searchTelegramCatalog()">Hľadať v katalógu</button>
                                <button type="button" id="telegramCatalogNew" onclick="quantumSearch.searchNewTelegramVideos()" title="Všetky pripojené skupiny a kanály, bez videí v knižnici">✨ Nové videá mimo knižnice</button>
                                <button type="button" id="telegramLiveNew" onclick="quantumSearch.searchLiveNewTelegramVideos()" title="Naživo skontroluje posledných 20 videí v každej skupine, vyberie najviac 5 nových">⚡ Nové naživo</button>
                                <button type="button" id="telegramLiveNewStop" hidden onclick="quantumSearch.stopLiveNewTelegramVideos()">Zastaviť živé hľadanie</button>
                                <button type="button" id="telegramCatalogMore" hidden onclick="quantumSearch.loadMoreTelegramCatalog()">Načítať ďalšie</button>
                                <button type="button" onclick="quantumSearch.searchTelegramCatalog(true)">Dohľadať na Telegrame</button>
                            </div>
                            <span id="telegramCatalogSearchInfo" role="status"></span>
                            <span id="telegramNewFilterInfo" role="status"></span>
                        </details>

                        <section id="quantumMegaPacksBar" class="mega-packs-bar" aria-label="Filtre a akcie pre MEGA a Telegram odkazy" hidden>
                            <div class="mega-packs-cta-row">
                                <div class="mega-packs-primary-cta" role="group" aria-label="Hlavné akcie">
                                    <button type="button" id="megaLinksScanBtn" class="quantum-btn primary" onclick="quantumSearch.scanTelegramLinksLive()" title="Naživo prehľadá Telegram správy s odkazmi (vrátane foto+link príspevkov a skrytých entít)">
                                        <span class="material-icons-round" aria-hidden="true">bolt</span><span>Skenovať Telegram</span>
                                    </button>
                                    <button type="button" id="megaDirectWebBtn" class="quantum-btn primary is-web" onclick="quantumSearch.searchDirectMegaWeb()" title="Vyhľadá priame mega.nz odkazy (bez brán/captchy) z webu, paste stránok, Redditu a t.me/s a rovno ich overí">
                                        <span class="material-icons-round" aria-hidden="true">public</span><span>Nájsť priame MEGA</span>
                                    </button>
                                    <button type="button" class="quantum-btn" onclick="window.nexusMegaHub?.open()" title="Otvorí dialóg MEGA Hubu">
                                        <span class="material-icons-round" aria-hidden="true">folder_special</span><span>MEGA Hub</span>
                                    </button>
                                </div>
                                <div class="mega-packs-tools-group" role="group" aria-label="Konfigurácia a údržba">
                                    <button type="button" id="megaTopChannelsBtn" class="quantum-btn" onclick="quantumSearch.toggleTopChannelsPanel()" title="Zobrazí rebríček Telegram kanálov podľa kvality a umožní pripnúť alebo nastaviť prioritné kanály">
                                        <span class="material-icons-round" aria-hidden="true">emoji_events</span><span>Top kanály</span>
                                    </button>
                                    <button type="button" id="megaPriorityToggleBtn" class="quantum-btn" aria-pressed="false" onclick="quantumSearch.toggleOnlyPriorityChannels()" title="Zapne/vypne filtrovanie vyhľadávania aj skenovania len na tvoje prioritné kanály">
                                        <span class="material-icons-round" aria-hidden="true">star</span><span class="mega-btn-label">Prioritné: Vyp</span>
                                    </button>
                                    <button type="button" id="megaBypassSettingsBtn" class="quantum-btn" onclick="quantumSearch.toggleBypassConfigPanel()" title="Nastavenie a auto-rotácia bypass providerov pri IP cooldowne">
                                        <span class="material-icons-round" aria-hidden="true">alt_route</span><span class="mega-btn-label">Bypass: Auto</span>
                                    </button>
                                    <div class="mega-popover-wrap">
                                        <button type="button" id="megaAutopilotMenuBtn" class="quantum-btn" aria-expanded="false" aria-controls="megaAutopilotPopover" onclick="quantumSearch.toggleMegaPopover('megaAutopilotPopover', this)" title="Ovládanie automatického spracovania na pozadí">
                                            <span class="material-icons-round" aria-hidden="true">smart_toy</span><span class="mega-btn-label">Autopilot</span><span class="material-icons-round mega-caret" aria-hidden="true">expand_more</span>
                                        </button>
                                        <div id="megaAutopilotPopover" class="mega-popover-menu" role="menu" aria-label="Nastavenia autopilota" hidden>
                                            <div class="mega-popover-title">Autopilot na pozadí</div>
                                            <button type="button" id="megaAutopilotBtn" class="quantum-btn mega-popover-item" aria-pressed="false" onclick="quantumSearch.toggleMegaAutopilot()" title="Na pozadí (každé 2 min) spracúva čakajúce karty. Rozbalí presmerovania a overí, či je album živý.">
                                                <span class="material-icons-round" aria-hidden="true">power_settings_new</span><span class="mega-btn-label">Autopilot: …</span>
                                            </button>
                                            <button type="button" id="megaAutopilotModeBtn" class="quantum-btn mega-popover-item" onclick="quantumSearch.toggleMegaAutopilotMode()" title="Len pripraviť: autopilot len rozbalí a overí. Aj pridať: reálne albumy (≥ 2 videí) pošle do Hubu sám.">
                                                <span class="material-icons-round" aria-hidden="true">tune</span><span class="mega-btn-label">Režim: …</span>
                                            </button>
                                            <button type="button" class="quantum-btn mega-popover-item" onclick="quantumSearch.closeMegaPopovers(); quantumSearch.runMegaAutopilotNow()" title="Okamžite spustí jeden cyklus autopilota">
                                                <span class="material-icons-round" aria-hidden="true">play_arrow</span><span>Spracovať teraz</span>
                                            </button>
                                        </div>
                                    </div>
                                    <div class="mega-popover-wrap">
                                        <button type="button" id="megaMaintenanceMenuBtn" class="quantum-btn" aria-expanded="false" aria-controls="megaMaintenancePopover" onclick="quantumSearch.toggleMegaPopover('megaMaintenancePopover', this)" title="Údržba odkazov: doplnenie skrytých entít a načítanie z video databázy">
                                            <span class="material-icons-round" aria-hidden="true">build</span><span class="mega-btn-label">Údržba</span><span class="material-icons-round mega-caret" aria-hidden="true">expand_more</span>
                                        </button>
                                        <div id="megaMaintenancePopover" class="mega-popover-menu" role="menu" aria-label="Údržba odkazov" hidden>
                                            <div class="mega-popover-title">Údržba databázy odkazov</div>
                                            <button type="button" id="megaBackfillBtn" class="quantum-btn mega-popover-item" onclick="quantumSearch.closeMegaPopovers(); quantumSearch.backfillMegaLinkEntities()" title="Hromadne (po 100 správach) vytiahne skryté MEGA LINK entity a inline tlačidlá zo starších príspevkov a hneď rozbalí nájdené rentry.org">
                                                <span class="material-icons-round" aria-hidden="true">sync</span><span class="mega-btn-label">Doplniť skryté linky</span>
                                            </button>
                                            <button type="button" id="megaLinksSeedBtn" class="quantum-btn mega-popover-item" onclick="quantumSearch.closeMegaPopovers(); quantumSearch.seedTelegramLinksFromDb()" title="Extrahuje MEGA linky z už zaindexovaných Telegram videí">
                                                <span class="material-icons-round" aria-hidden="true">download</span><span>Načítať z video DB</span>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div class="mega-packs-filter-row">
                                <div class="mega-packs-filter-group" role="group" aria-label="Typ odkazu">
                                    <span class="mega-packs-filter-label">Typ</span>
                                    <button type="button" class="refine-btn active" data-mega-kind="all" onclick="quantumSearch.setMegaLinksFilter('linkKind', 'all')">Všetky</button>
                                    <button type="button" class="refine-btn" data-mega-kind="mega" onclick="quantumSearch.setMegaLinksFilter('linkKind', 'mega')"><span class="material-icons-round mega-inline-ico is-emerald" aria-hidden="true">cloud_done</span>Priame MEGA</button>
                                    <button type="button" class="refine-btn" data-mega-kind="paste" onclick="quantumSearch.setMegaLinksFilter('linkKind', 'paste')" title="Rentry, Pastebin, Telegra.ph a priame Bunkr/Gofile – rozbaliteľné bez bypass.city"><span class="material-icons-round mega-inline-ico is-sky" aria-hidden="true">description</span><span class="mega-btn-label">Paste / Bez brány</span></button>
                                    <button type="button" class="refine-btn" data-mega-kind="multi" onclick="quantumSearch.setMegaLinksFilter('linkKind', 'multi')" title="Karty s viacerými skrytými alebo vyťaženými odkazmi"><span class="material-icons-round mega-inline-ico is-violet" aria-hidden="true">inventory_2</span><span class="mega-btn-label">Viac linkov</span></button>
                                    <button type="button" class="refine-btn" data-mega-kind="external" onclick="quantumSearch.setMegaLinksFilter('linkKind', 'external')"><span class="material-icons-round mega-inline-ico" aria-hidden="true">link</span>Externé</button>
                                </div>
                                <div class="mega-packs-filter-group" role="group" aria-label="Stav odkazu">
                                    <span class="mega-packs-filter-label">Stav</span>
                                    <button type="button" class="refine-btn active" data-mega-status="active" onclick="quantumSearch.setMegaLinksFilter('status', 'active')">Aktívne</button>
                                    <button type="button" class="refine-btn" data-mega-status="new" onclick="quantumSearch.setMegaLinksFilter('status', 'new')">Nové</button>
                                    <button type="button" class="refine-btn" data-mega-status="in_hub" onclick="quantumSearch.setMegaLinksFilter('status', 'in_hub')"><span class="material-icons-round mega-inline-ico is-emerald" aria-hidden="true">check_circle</span>V Hube</button>
                                    <button type="button" class="refine-btn" data-mega-status="dead" onclick="quantumSearch.setMegaLinksFilter('status', 'dead')"><span class="material-icons-round mega-inline-ico is-danger" aria-hidden="true">cancel</span>Mŕtve</button>
                                </div>
                                <div class="mega-packs-filter-group" role="group" aria-label="Zoradenie">
                                    <span class="mega-packs-filter-label">Poradie</span>
                                    <button type="button" class="refine-btn active" data-mega-sort="newest" onclick="quantumSearch.setMegaLinksFilter('sort', 'newest')"><span class="material-icons-round mega-inline-ico" aria-hidden="true">schedule</span>Najnovšie</button>
                                    <button type="button" class="refine-btn" data-mega-sort="reactions" onclick="quantumSearch.setMegaLinksFilter('sort', 'reactions')"><span class="material-icons-round mega-inline-ico is-amber" aria-hidden="true">local_fire_department</span>Reakcie</button>
                                    <button type="button" class="refine-btn" data-mega-sort="views" onclick="quantumSearch.setMegaLinksFilter('sort', 'views')"><span class="material-icons-round mega-inline-ico" aria-hidden="true">visibility</span>Pozretia</button>
                                    <button type="button" class="refine-btn" data-mega-sort="videos" onclick="quantumSearch.setMegaLinksFilter('sort', 'videos')"><span class="material-icons-round mega-inline-ico" aria-hidden="true">movie</span>Videá</button>
                                </div>
                                <div class="mega-packs-filter-group" role="group" aria-label="Výber kariet">
                                    <span class="mega-packs-filter-label">Výber</span>
                                    <button type="button" class="refine-btn" onclick="quantumSearch.selectMegaCards('all')" title="Vyberie všetky zobrazené karty (okrem V Hube / mŕtvych)">Všetky</button>
                                    <button type="button" class="refine-btn" onclick="quantumSearch.selectMegaCards('verified')" title="Vyberie len overené albumy s videami">Overené</button>
                                    <button type="button" class="refine-btn" onclick="quantumSearch.selectMegaCards('none')">Nič</button>
                                </div>
                            </div>

                            <div id="megaChannelsPanel" class="mega-channels-panel" hidden></div>
                            <div id="megaBypassConfigPanel" class="mega-bypass-panel" hidden></div>

                            <div class="mega-packs-status-row">
                                <span id="quantumMegaPacksStatus" role="status">Pripravené. Vyber kanál alebo zadaj meno a klikni na Skenovať Telegram.</span>
                                <button type="button" id="megaLinksLoadMoreBtn" class="quantum-btn" hidden onclick="quantumSearch.loadMegaLinkPosts(quantumSearch._lastMegaLinksQuery || '', true)">Načítať ďalšie</button>
                            </div>
                        </section>

                    <div id="quantumSearchMainView">
                        <div class="quantum-results-toolbar">
                            <div class="quantum-toolbar-scrape" aria-label="Rýchle Telegram scrape">
                                <span class="material-icons-round" aria-hidden="true">travel_explore</span>
                                <div class="telegram-chat-picker"></div>
                                <label class="quantum-toolbar-channel-label" for="telegramChannelInput">Kanál</label>
                                <input type="text" id="quantumToolbarChannel" placeholder="Telegram kanál" aria-label="Telegram kanál na scrape" autocomplete="off" spellcheck="false" maxlength="128">
                                <span id="quantumToolbarScrapeSlot"></span>
                            </div>
                            <div class="quantum-toolbar-field">
                                <label for="telegramLimitSelect">Limit</label>
                                <div id="quantumToolbarLimit"></div>
                                <div id="quantumToolbarCustomLimit"></div>
                            </div>
                            <div class="quantum-toolbar-field quantum-toolbar-total">
                                <label for="searchLimitTotal">Výsledky</label>
                                <div id="quantumToolbarTotal"></div>
                            </div>
                            <div class="quantum-toolbar-field quantum-toolbar-sort">
                                <label for="quantumQuickSort">Zoradiť</label>
                                <select id="quantumQuickSort" aria-label="Zoradiť výsledky" onchange="quantumSearch.setSort(this.value)">
                                    <option value="relevance">Relevancia</option>
                                    <option value="date">Dátum</option>
                                    <option value="views">Pozretia</option>
                                    <option value="duration">Dĺžka</option>
                                    <option value="quality">Kvalita</option>
                                    <option value="size">Veľkosť</option>
                                </select>
                            </div>
                            <div class="quantum-toolbar-field quantum-toolbar-filter">
                                <label for="quantumQuickDuration">Min. dĺžka</label>
                                <select id="quantumQuickDuration" aria-label="Minimálna dĺžka" onchange="quantumSearch.setDurationFilter(Number(this.value))">
                                    <option value="0">Ľubovoľná</option>
                                    <option value="60">1m+</option>
                                    <option value="120">2m+</option>
                                    <option value="300">5m+</option>
                                    <option value="600">10m+</option>
                                    <option value="1200">20m+</option>
                                </select>
                            </div>
                            <div class="quantum-toolbar-field quantum-toolbar-filter">
                                <label for="quantumQuickQuality">Min. kvalita</label>
                                <select id="quantumQuickQuality" aria-label="Minimálna kvalita" onchange="quantumSearch.setQuickQualityFilter(this.value)">
                                    <option value="all">Všetky</option>
                                    <option value="720p">720p+</option>
                                    <option value="1080p">1080p+</option>
                                    <option value="4K">4K</option>
                                </select>
                            </div>
                            <div class="quantum-toolbar-field quantum-toolbar-filter">
                                <label for="quantumQuickOrientation">Formát</label>
                                <select id="quantumQuickOrientation" aria-label="Orientácia / rozlíšenie" onchange="quantumSearch.setOrientationFilter(this.value)">
                                    <option value="all">Všetky</option>
                                    <option value="landscape">Širokouhlé (16:9)</option>
                                    <option value="portrait">Na výšku (9:16)</option>
                                    <option value="portrait_any">Vertikálne (všetky)</option>
                                    <option value="portrait_estimate">Pravdepodobne vertikálne</option>
                                </select>
                            </div>
                            <span class="quantum-toolbar-spacer"></span>
                            <div class="quantum-toolbar-layout-group">
                                <div class="quantum-toolbar-layout-label">Mriežka</div>
                                <div class="quantum-result-layouts" role="group" aria-label="Rozloženie náhľadov">
                                    <button type="button" class="quantum-result-layout-button" data-layout="5x3" aria-label="5 stĺpcov, pomer náhľadu 3 ku 2" aria-pressed="false" title="5 stĺpcov · pomer náhľadu 3:2" onclick="quantumSearch.setResultLayout('5x3')">5 × 3</button>
                                    <button type="button" class="quantum-result-layout-button" data-layout="5x2" aria-label="5 stĺpcov, široký pomer náhľadu 5 ku 2" aria-pressed="false" title="5 stĺpcov · široký pomer náhľadu 5:2" onclick="quantumSearch.setResultLayout('5x2')">5 × 2</button>
                                    <button type="button" class="quantum-result-layout-button" data-layout="4x4" aria-label="4 stĺpce, štvorcový pomer náhľadu" aria-pressed="false" title="4 stĺpce · štvorcový pomer náhľadu" onclick="quantumSearch.setResultLayout('4x4')">4 × 4</button>
                                </div>
                            </div>
                        </div>
                        <div class="quantum-search-results" id="quantumSearchResults">
                            <div class="quantum-search-empty">
                                <div class="quantum-search-empty-icon"><span class="material-icons-round" aria-hidden="true">travel_explore</span></div>
                                <div class="quantum-search-empty-text">
                                    Zadaj hľadaný výraz a objav obsah<br>
                                    <small style="opacity: 0.65;">Skús hľadať tvorcov, modelky alebo témy</small>
                                </div>
                            </div>
                        </div>

                        <div id="megaHarvestInspectorBackdrop" class="mega-harvest-backdrop" hidden onclick="quantumSearch.closeMegaHarvestInspector()"></div>
                        <aside id="megaHarvestInspector" class="mega-harvest-inspector" role="dialog" aria-modal="true" aria-label="Harvester Inspector" hidden></aside>

                        <div class="quantum-search-stats" id="quantumSearchStats" style="display: none;">
                            <div class="quantum-search-count-wrap">
                                <div class="quantum-search-count">
                                    <strong id="quantumResultCount">0</strong> nájdených výsledkov
                                </div>
                                <div class="quantum-selection-toolbar" id="quantumSelectionToolbar">
                                    <label class="quantum-select-all-label" title="Vybrať / odznačiť všetky zobrazené výsledky">
                                        <input type="checkbox" id="quantumSelectAllCheckbox" class="quantum-custom-checkbox" onchange="quantumSearch.toggleSelectAll(this.checked)">
                                        <span id="quantumSelectAllText">Vybrať všetko</span>
                                    </label>
                                    <span class="quantum-selected-badge" id="quantumSelectedBadge" style="display: none;">
                                        <span class="material-icons-round" style="font-size: 14px; margin-right: 3px;">check_circle</span>
                                        <span id="quantumSelectedCount">0</span> vybraných
                                    </span>
                                </div>
                            </div>
                            <div class="quantum-activity-panel" id="quantumActivityPanel" data-state="idle" role="status" aria-live="polite">
                                <span class="quantum-activity-indicator" aria-hidden="true"></span>
                                <span class="quantum-activity-copy">
                                    <strong id="quantumActivityLabel">Ready</strong>
                                    <span id="quantumActivityDetail">Search actions and progress appear here.</span>
                                </span>
                                <progress id="quantumActivityProgress" max="100" value="0" hidden aria-label="Operation progress"></progress>
                            </div>
                            <details class="quantum-activity-log">
                                <summary aria-label="Open activity log">Log</summary>
                                <ol id="quantumActivityLog"><li>QS is ready.</li></ol>
                            </details>
                            <div class="quantum-search-actions">
                                <button class="quantum-btn" id="quantumSplitBtn" onclick="quantumSearch.openSplitScreen()" style="display:none;" title="Prehrať označené výsledky vedľa seba">▶▶ Split-Screen (<span id="quantumSplitCount">0</span>)</button>
                                <button class="quantum-btn" onclick="quantumSearch.inspectTelegramThumbnails(this)" title="Označí podozrivé už načítané Telegram náhľady">Nájsť slabé náhľady</button>
                                <button class="quantum-btn" onclick="quantumSearch.repairSelectedTelegramThumbnails(this)" title="Vytvorí snímky z označených Telegram videí">Opraviť vybrané náhľady</button>
                                <button class="quantum-btn" id="quantumStopThumbs" style="display:none" onclick="quantumSearch.stopTelegramThumbnails()">Zastaviť opravu</button>
                                <span id="quantumThumbStatus" role="status" style="font-size:11px;color:#c4b5d7"></span>
                                <button class="quantum-btn" id="quantumFetchMetadataBtn" onclick="quantumSearch.fetchVisibleMetadata(this)" title="Duration, quality, size and date for supported sources" ${this._metadataBatchActive ? 'disabled' : ''}>${this._metadataBatchActive ? 'Fetching…' : 'Fetch full meta'}</button>
                                <button class="quantum-btn" onclick="quantumSearch.exportResults()">
                                    Export URLs
                                </button>
                                <button class="quantum-btn primary" id="quantumImportSelectedBtn" onclick="quantumSearch.importSelected()" style="display: none;">
                                    <span class="material-icons-round" style="font-size: 14px; margin-right: 4px;">move_to_inbox</span>Importovať vybrané (<span id="quantumImportSelectedCount">0</span>)
                                </button>
                                <button class="quantum-btn" id="quantumImportAllBtn" onclick="quantumSearch.importAll()">
                                    Import All
                                </button>
                            </div>
                        </div>
                    </div>

                    <div id="quantumSearchSettingsView" style="display: none; padding: 20px;">
                        <h3 style="color:white; margin-bottom: 20px;">Settings</h3>
                        <div class="setting-item" style="color:white; margin-bottom:15px;">
                            <label style="display:flex; align-items:center; gap:10px; cursor:pointer;">
                                <input type="checkbox" id="settingAutoImport" onchange="quantumSearch.saveSettings()"> 
                                Auto-Import downloaded files
                            </label>
                        </div>
                        <div class="setting-item" style="color:white;">
                            <label>Preferred Quality: 
                                <select id="settingQuality" onchange="quantumSearch.saveSettings()" style="background:#333; color:white; border:1px solid #555; padding:4px; border-radius:4px;">
                                    <option value="best">Best Available</option>
                                    <option value="1080p">1080p</option>
                                    <option value="720p">720p</option>
                                </select>
                            </label>
                        </div>
                        <button class="quantum-btn" onclick="quantumSearch.toggleSettings()" style="margin-top:20px;">Back to Search</button>
                    </div>
                    
                    <div class="quantum-search-footer" id="quantumSearchFooter" style="margin-top:auto; padding-top:10px; border-top:1px solid rgba(255,255,255,0.1); display:none;">
                       <div id="downloadStatus" style="color: rgba(255,255,255,0.7); font-size:12px; display:flex; align-items:center; gap:10px;">
                           <!-- Status injected here -->
                       </div>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', html);
        this.overlay = document.getElementById('quantumSearchOverlay');
        this.moveToolbarControls();
        this.updateModeButtons();
        this.updateResultLayout();

        // Bind events
        this.bindEvents();

        // Init settings UI state
        document.getElementById('settingAutoImport').checked = this.settings.autoImport;
        document.getElementById('settingQuality').value = this.settings.quality;
        document.getElementById('searchLimitPerSource').value = this.settings.limitPerSource || 30;
        document.getElementById('searchLimitTotal').value = this.settings.limitTotal || 100;
        this.initTelegramLimitUI();
    }

    moveToolbarControls() {
        const channelInput = document.getElementById('telegramChannelInput');
        const quickChannel = document.getElementById('quantumToolbarChannel');
        const quickPicker = this.overlay.querySelector('.quantum-toolbar-scrape .telegram-chat-picker');
        const channelPicker = this.overlay.querySelector('.quantum-search-setup .telegram-chat-picker');
        const channelLabel = this.overlay.querySelector('.quantum-search-setup .quantum-channel-scrape label[for="telegramChannelInput"]');
        const scrapeButton = document.getElementById('scrapeChannelBtn');
        const limitSelect = document.getElementById('telegramLimitSelect');
        const customLimit = document.getElementById('telegramScrapeLimit');
        const totalLimit = document.getElementById('searchLimitTotal');
        if (channelInput && quickChannel) {
            channelInput.placeholder = 'Telegram kanál';
            channelInput.setAttribute('aria-label', 'Telegram kanál na scrape');
            quickChannel.replaceWith(channelInput);
        }
        if (channelLabel) channelLabel.remove();
        if (channelPicker && quickPicker) quickPicker.replaceWith(channelPicker);
        if (scrapeButton) {
            scrapeButton.classList.add('quantum-btn', 'primary');
            scrapeButton.textContent = 'Scrape';
            scrapeButton.title = 'Scrape the Telegram channel entered beside this button';
            document.getElementById('quantumToolbarScrapeSlot').replaceWith(scrapeButton);
        }
        if (limitSelect) document.getElementById('quantumToolbarLimit').append(limitSelect);
        if (customLimit) document.getElementById('quantumToolbarCustomLimit').append(customLimit);
        if (totalLimit) document.getElementById('quantumToolbarTotal').append(totalLimit);
    }

    setActivity(label, detail = '', state = 'info') {
        const panel = document.getElementById('quantumActivityPanel');
        const labelEl = document.getElementById('quantumActivityLabel');
        const detailEl = document.getElementById('quantumActivityDetail');
        if (labelEl) labelEl.textContent = label;
        if (detailEl) detailEl.textContent = detail;
        if (panel?.dataset) panel.dataset.state = state;
        const progress = document.getElementById('quantumActivityProgress');
        if (progress) progress.hidden = true;

        const timestamp = new Date().toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        this._activityLog = [{ timestamp, label, detail }, ...(this._activityLog || [])].slice(0, 8);
        const log = document.getElementById('quantumActivityLog');
        if (log) {
            log.innerHTML = this._activityLog.map(item =>
                `<li><time>${this.escapeHtml(item.timestamp)}</time><strong>${this.escapeHtml(item.label)}</strong>${item.detail ? `<span>${this.escapeHtml(item.detail)}</span>` : ''}</li>`
            ).join('');
        }
    }

    updateActivityProgress(detail, completed, total) {
        const detailEl = document.getElementById('quantumActivityDetail');
        const progress = document.getElementById('quantumActivityProgress');
        if (detailEl) detailEl.textContent = detail;
        if (progress) {
            progress.hidden = false;
            progress.value = total > 0 ? Math.min(100, completed / total * 100) : 0;
        }
    }

    async loadSourceCatalog() {
        try {
            const response = await fetch('/api/v1/intake/sources');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            this.sourceCatalog = (data.sources || []).filter(source => source.search);
            const dropdown = document.getElementById('ms-drop-source');
            if (!dropdown) return;
            dropdown.innerHTML = `<label><input type="checkbox" value="all" checked onchange="quantumSearch.handleMSChange('source', this)"> ✦ All Sources (${this.sourceCatalog.length})</label>`
                + this.sourceCatalog.map(source => `<label><input type="checkbox" value="${this.escapeHtml(source.id)}" onchange="quantumSearch.handleMSChange('source', this)"> ${this.escapeHtml(source.label)}</label>`).join('')
                + `<div class="quantum-ms-select-actions"><button onclick="quantumSearch.selectAllSources()">Všetky</button><button onclick="quantumSearch.selectFastSources()">Rýchle ⚡</button><button onclick="quantumSearch.clearSources()">Žiadne</button></div>`;
            const label = document.getElementById('ms-btn-source');
            if (label) label.textContent = this.searchFilters.source.includes('all') ? `All ${this.sourceCatalog.length} Sources` : `${this.searchFilters.source.length} Selected`;
            dropdown.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = this.searchFilters.source.includes(cb.value); });
            this.updateTelegramOnlyButton();
        } catch (error) {
            this.catalogError = error.message || String(error);
            const label = document.getElementById('ms-btn-source');
            if (label) label.textContent = 'Sources unavailable';
        }
    }

    submitSearch() {
        const query = (document.getElementById('quantumSearchInput')?.value || '').trim();
        if (this.megaPacksMode) {
            this.loadMegaLinkPosts(query, false);
        } else if (query.length >= 2) {
            this.search(query);
        }
    }

    bindEvents() {
        const input = document.getElementById('quantumSearchInput');

        input.addEventListener('input', (e) => {
            const query = e.target.value.trim();
            if (query.length === 0) {
                this.cancelSearch();
                if (this.megaPacksMode) {
                    this.loadMegaLinkPosts('', false);
                } else {
                    this.renderHistory();
                }
            }
        });

        // Vyhľadávanie sa spustí až po stlačení Enter alebo tlačidla Hľadať
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.submitSearch();
            }
        });

        document.getElementById('telegramExcludeInput')?.addEventListener('input', () => this.applyFilters());
        const tgKeywordInput = document.getElementById('telegramKeywordInput');
        if (tgKeywordInput) {
            tgKeywordInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const hasChannel = Boolean(
                        (this.selectedTelegramChatIds && this.selectedTelegramChatIds.size)
                        || (this.selectedTelegramTopics && this.selectedTelegramTopics.size)
                        || (document.getElementById('telegramChannelInput')?.value || '').trim()
                    );
                    if (this.globalTelegram || !hasChannel) {
                        this.searchTelegramCatalog();
                    } else {
                        this.scrapeChannel();
                    }
                }
            });
        }

        const tgChannelInput = document.getElementById('telegramChannelInput');
        if (tgChannelInput) {
            tgChannelInput.addEventListener('input', () => {
                this.selectedTelegramChatIds.clear();
                this.selectedTelegramTopics.clear();
                document.querySelectorAll('#telegramJoinedChats input[type="checkbox"]').forEach(item => { item.checked = false; });
                this.updateTelegramChatButton();
            });
            tgChannelInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (this.megaPacksMode) {
                        this.scanTelegramLinksLive();
                    } else {
                        this.scrapeChannel();
                    }
                }
            });
        }

        // Focus event
        input.addEventListener('focus', () => {
            if (!this.megaPacksMode && input.value.trim().length === 0) {
                this.renderHistory();
            }
        });

        let lastHandoffRefreshAt = 0;
        const refreshIfOpenedHandoff = (force = false) => {
            if (!this.isOpen() || !this.megaPacksMode) return;
            const now = Date.now();
            if (!force && now - lastHandoffRefreshAt < 5000) return;
            const hasOpened = (this._megaLinkItems || []).some(item => item.status === 'opened');
            if (force || hasOpened) {
                lastHandoffRefreshAt = now;
                this.loadMegaLinkPosts(this._lastMegaLinksQuery || '', false, true);
            }
        };
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('focus', () => refreshIfOpenedHandoff(false));
        }
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) refreshIfOpenedHandoff(false);
            });
            document.addEventListener('nexus-mega-hub-updated', () => refreshIfOpenedHandoff(true));
        }

        // Close on overlay click
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) {
                this.close();
            }
        });

        // Close dropdowns on outside click
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.quantum-ms-container')) {
                document.querySelectorAll('.quantum-ms-dropdown').forEach(d => d.style.display = 'none');
            }
            if (!e.target.closest('.telegram-help-picker')) {
                const help = document.getElementById('telegramSearchHelpPopover');
                const btn = document.getElementById('telegramSearchHelpBtn');
                if (help && !help.hidden) {
                    help.hidden = true;
                    if (btn) btn.setAttribute('aria-expanded', 'false');
                }
            }
        });
    }

    toggleMultiselect(id) {
        const el = document.getElementById(id);
        if(el.style.display === 'none' || el.style.display === '') {
            document.querySelectorAll('.quantum-ms-dropdown').forEach(d => d.style.display = 'none');
            el.style.display = 'flex';
        } else {
            el.style.display = 'none';
        }
    }

    handleMSChange(type, checkbox) {
        if (checkbox.value === 'all') {
            if (checkbox.checked) {
                // Uncheck all others
                checkbox.closest('.quantum-ms-dropdown').querySelectorAll('input').forEach(cb => {
                    if (cb !== checkbox) cb.checked = false;
                });
                this.searchFilters[type] = ['all'];
            } else {
                this.searchFilters[type] = [];
            }
        } else {
            // Uncheck 'all'
            const allCb = checkbox.closest('.quantum-ms-dropdown').querySelector('input[value="all"]');
            if (allCb && allCb.checked) allCb.checked = false;
            
            const checkedValues = Array.from(checkbox.closest('.quantum-ms-dropdown').querySelectorAll('input:checked')).map(cb => cb.value);
            if (checkedValues.length === 0 && type === 'quality') {
                if (allCb) allCb.checked = true;
                this.searchFilters[type] = ['all'];
            } else this.searchFilters[type] = checkedValues;
        }
        
        // Update button text
        const btn = document.getElementById(`ms-btn-${type}`);
        if (!this.searchFilters[type].length) btn.textContent = 'No Sources';
        else if (this.searchFilters[type].includes('all')) btn.textContent = type === 'quality' ? 'All Qualities' : `All ${this.sourceCatalog.length} Sources`;
        else btn.textContent = `${this.searchFilters[type].length} Selected`;
        
        if (type === 'source') {
            this.megaPacksMode = false;
            this.updateTelegramOnlyButton();
        }
        if ((type === 'source' || type === 'quality') && this._lastQuery && !this._catalogPage?.newOnly) {
            clearTimeout(this._filterSearchTimer);
            this._filterSearchTimer = setTimeout(() => this.search(this._lastQuery), 400);
        } else this.applyFilters();
    }

    updateTelegramOnlyButton() {
        const megaMode = Boolean(this.megaPacksMode);
        const button = document.getElementById('quantumTelegramOnly');
        const active = !megaMode && this.searchFilters.source.length === 1 && this.searchFilters.source[0] === 'telegram';
        if (button) {
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        }
        const allButton = document.getElementById('quantumAllSources');
        if (allButton) {
            const all = !megaMode && this.searchFilters.source.includes('all');
            allButton.classList.toggle('active', all);
            allButton.setAttribute('aria-pressed', String(all));
            allButton.textContent = this.sourceCatalog.length ? `Všetky zdroje (${this.sourceCatalog.length})` : 'Všetky zdroje';
        }
        const megaButton = document.getElementById('quantumMegaPacksOnly');
        if (megaButton) {
            megaButton.classList.toggle('active', megaMode);
            megaButton.setAttribute('aria-pressed', String(megaMode));
        }
        const megaBar = document.getElementById('quantumMegaPacksBar');
        if (megaBar) megaBar.hidden = !megaMode;
        if (!megaMode) { const selBar = document.getElementById('megaSelectionBar'); if (selBar) selBar.hidden = true; }
        else if (this._megaSelected?.size) this._renderMegaSelectionBar();
        this.overlay?.classList?.toggle('is-mega-packs-mode', megaMode);
        document.getElementById('quantumSearchResults')?.classList?.toggle('is-mega-links-mode', megaMode);
    }

    selectTelegramOnly() {
        if (!this.megaPacksMode && this.searchFilters.source.length === 1 && this.searchFilters.source[0] === 'telegram') return;
        this.megaPacksMode = false;
        this.searchFilters.source = ['telegram'];
        document.querySelectorAll('#ms-drop-source input[type="checkbox"]').forEach(cb => { cb.checked = cb.value === 'telegram'; });
        const label = document.getElementById('ms-btn-source');
        if (label) label.textContent = '1 Selected';
        this.updateTelegramOnlyButton();
        if (this._lastQuery) this.search(this._lastQuery); else this.applyFilters();
    }

    // Helper: select all sources
    selectAllSources() {
        this.megaPacksMode = false;
        const dropdown = document.getElementById('ms-drop-source');
        if (!dropdown) {
            this.searchFilters['source'] = ['all'];
            this.updateTelegramOnlyButton();
            return;
        }
        dropdown.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
        const allCb = dropdown.querySelector('input[value="all"]');
        if (allCb) allCb.checked = true;
        this.searchFilters['source'] = ['all'];
        this.updateTelegramOnlyButton();
        const btn = document.getElementById('ms-btn-source');
        if (btn) btn.textContent = `All ${this.sourceCatalog.length} Sources`;
        if (this._lastQuery) this.search(this._lastQuery); else this.applyFilters();
    }

    // Helper: select only fast sources
    selectFastSources() {
        this.megaPacksMode = false;
        const FAST = ['xvideos', 'pornhub', 'xhamster', 'eporner', 'spankbang', 'noodlemagazine', 'erome'].filter(key => this.sourceCatalog.some(source => source.id === key));
        const dropdown = document.getElementById('ms-drop-source');
        if (!dropdown) return;
        dropdown.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.checked = FAST.includes(cb.value);
        });
        const allCb = dropdown.querySelector('input[value="all"]');
        if (allCb) allCb.checked = false;
        this.searchFilters['source'] = FAST;
        this.updateTelegramOnlyButton();
        const btn = document.getElementById('ms-btn-source');
        if (btn) btn.textContent = `${FAST.length} Selected`;
        if (this._lastQuery) this.search(this._lastQuery); else this.applyFilters();
    }

    // Helper: clear all source selections
    clearSources() {
        this.megaPacksMode = false;
        const dropdown = document.getElementById('ms-drop-source');
        if (!dropdown) return;
        dropdown.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
        this.searchFilters['source'] = [];
        this.updateTelegramOnlyButton();
        const btn = document.getElementById('ms-btn-source');
        if (btn) btn.textContent = 'No Sources';
        if (this._lastQuery) this.search(this._lastQuery); else this.applyFilters();
    }

    // --- Režim MEGA & Linky ---

    selectMegaPacksMode() {
        this.cancelSearch();
        this.megaPacksMode = true;
        this.updateTelegramOnlyButton();
        const query = (document.getElementById('quantumSearchInput')?.value || '').trim();
        this.loadMegaLinkPosts(query, false);
        this.refreshMegaAutopilot();
    }

    setMegaLinksFilter(kind, value) {
        if (!this._megaLinksFilter) this._megaLinksFilter = { status: 'active', linkKind: 'all', sort: 'newest' };
        this._megaLinksFilter[kind] = value;
        const attr = kind === 'linkKind' ? 'data-mega-kind' : (kind === 'sort' ? 'data-mega-sort' : 'data-mega-status');
        document.querySelectorAll(`#quantumMegaPacksBar [${attr}]`).forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute(attr) === value);
        });
        const query = (document.getElementById('quantumSearchInput')?.value || '').trim();
        this.loadMegaLinkPosts(query, false);
    }

    // --- Popover menu v MEGA hornej lište (Autopilot, Údržba) ---
    toggleMegaPopover(menuId, triggerBtn = null) {
        const target = document.getElementById(menuId);
        if (!target) return;
        const willOpen = target.hidden;
        this.closeMegaPopovers();
        if (willOpen) {
            target.hidden = false;
            if (triggerBtn) {
                triggerBtn.setAttribute('aria-expanded', 'true');
                triggerBtn.classList.add('active');
            }
            if (!this._megaPopoverOutsideBound) {
                this._megaPopoverOutsideBound = (event) => {
                    if (!event.target?.closest?.('.mega-popover-wrap')) {
                        this.closeMegaPopovers();
                    }
                };
                document.addEventListener('click', this._megaPopoverOutsideBound);
            }
        }
    }

    closeMegaPopovers() {
        document.querySelectorAll('#quantumMegaPacksBar .mega-popover-menu').forEach(menu => {
            menu.hidden = true;
        });
        document.querySelectorAll('#quantumMegaPacksBar .mega-popover-wrap > button').forEach(btn => {
            btn.setAttribute('aria-expanded', 'false');
            btn.classList.remove('active');
        });
    }

    // --- Prioritné kanály + Pripnutie obľúbených + Rebríček kvality kanálov + Backfill skrytých entít ---
    _getPriorityChannelConfig() {
        try {
            const raw = localStorage.getItem('nexus_mega_priority_channels_v1');
            if (!raw) return { ids: [], pinnedIds: [], onlyPriority: false, focusChatId: null };
            const parsed = JSON.parse(raw);
            return {
                ids: Array.isArray(parsed.ids) ? parsed.ids.map(Number).filter(n => Number.isFinite(n) && n !== 0) : [],
                pinnedIds: Array.isArray(parsed.pinnedIds) ? parsed.pinnedIds.map(Number).filter(n => Number.isFinite(n) && n !== 0) : [],
                onlyPriority: Boolean(parsed.onlyPriority),
                focusChatId: parsed.focusChatId ? Number(parsed.focusChatId) : null,
            };
        } catch (_) {
            return { ids: [], pinnedIds: [], onlyPriority: false, focusChatId: null };
        }
    }

    _savePriorityChannelConfig(cfg) {
        try {
            localStorage.setItem('nexus_mega_priority_channels_v1', JSON.stringify(cfg));
        } catch (_) {}
        this._updatePriorityChannelsUI(cfg);
    }

    togglePinnedChannel(chatId) {
        const numericId = Number(chatId);
        if (!Number.isFinite(numericId) || numericId === 0) return;
        const cfg = this._getPriorityChannelConfig();
        const pinned = new Set(cfg.pinnedIds || []);
        const wasPinned = pinned.has(numericId);
        if (wasPinned) pinned.delete(numericId);
        else pinned.add(numericId);
        cfg.pinnedIds = [...pinned];
        this._savePriorityChannelConfig(cfg);
        this.renderTopChannelsPanel();
        this._showSuccessToast(wasPinned ? 'Kanál odopnutý z obľúbených.' : 'Kanál pripnutý na vrch Top kanálov.', 2400);
    }

    _setBtnLabel(btn, text) {
        if (!btn) return;
        const label = btn.querySelector('.mega-btn-label');
        if (label) label.textContent = text;
        else btn.textContent = text;
    }

    _updatePriorityChannelsUI(cfg = null) {
        const c = cfg || this._getPriorityChannelConfig();
        const prioBtn = document.getElementById('megaPriorityToggleBtn');
        if (prioBtn) {
            const active = (c.onlyPriority && c.ids.length > 0) || Boolean(c.focusChatId);
            prioBtn.classList.toggle('active', active);
            prioBtn.setAttribute('aria-pressed', String(active));
            this._setBtnLabel(
                prioBtn,
                c.focusChatId
                    ? '1 kanál (zrušiť)'
                    : (active ? `Len prioritné (${c.ids.length})` : `Prioritné${c.ids.length ? ` (${c.ids.length})` : ': Vyp'}`)
            );
        }
        const backfillBtn = document.getElementById('megaBackfillBtn');
        const maintBtn = document.getElementById('megaMaintenanceMenuBtn');
        if (this._megaLinksCounts) {
            const miss = Number(this._megaLinksCounts.missing_entities) || 0;
            this._setBtnLabel(
                backfillBtn,
                miss > 0 ? `Doplniť skryté linky (${miss.toLocaleString('sk-SK')})` : 'Doplniť skryté linky'
            );
            this._setBtnLabel(
                maintBtn,
                miss > 0 ? `Údržba (${miss.toLocaleString('sk-SK')})` : 'Údržba'
            );
        }
        const pasteBtn = document.querySelector('#quantumMegaPacksBar [data-mega-kind="paste"]');
        if (pasteBtn && this._megaLinksCounts) {
            const n = Number(this._megaLinksCounts.paste) || 0;
            this._setBtnLabel(pasteBtn, n > 0 ? `Paste / Bez brány (${n})` : 'Paste / Bez brány');
        }
        const multiBtn = document.querySelector('#quantumMegaPacksBar [data-mega-kind="multi"]');
        if (multiBtn && this._megaLinksCounts) {
            const n = Number(this._megaLinksCounts.multi) || 0;
            this._setBtnLabel(multiBtn, n > 0 ? `Viac linkov (${n})` : 'Viac linkov');
        }
    }

    _megaLinksContextParams() {
        const channel = (document.getElementById('telegramChannelInput')?.value || '').trim();
        const pickerIds = [...(this.selectedTelegramChatIds || [])];
        if (pickerIds.length) {
            return { channel, chatIds: pickerIds.join(',') };
        }
        const prio = this._getPriorityChannelConfig();
        if (prio.focusChatId) {
            return { channel: '', chatIds: String(prio.focusChatId) };
        }
        if (!channel && prio.onlyPriority && prio.ids.length) {
            return { channel: '', chatIds: prio.ids.join(',') };
        }
        return { channel, chatIds: '' };
    }

    async toggleTopChannelsPanel() {
        const panel = document.getElementById('megaChannelsPanel');
        if (!panel) return;
        panel.hidden = !panel.hidden;
        if (!panel.hidden) {
            await this.loadTopChannelsStats();
        }
    }

    async loadTopChannelsStats() {
        const panel = document.getElementById('megaChannelsPanel');
        if (panel) panel.innerHTML = '<div class="mega-channels-loading">⏳ Analyzujem kvalitu Telegram kanálov…</div>';
        try {
            const res = await fetch('/api/v1/telegram/links/channels-stats', { cache: 'no-store' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || `Chyba (${res.status})`);
            this._megaChannelsStats = data;
            this.renderTopChannelsPanel();
        } catch (error) {
            if (panel) panel.innerHTML = `<div class="mega-channels-loading">⚠️ ${this.escapeHtml(error.message || String(error))}</div>`;
        }
    }

    renderTopChannelsPanel() {
        const panel = document.getElementById('megaChannelsPanel');
        if (!panel) return;
        const data = this._megaChannelsStats;
        if (!data || !Array.isArray(data.channels)) return;
        const cfg = this._getPriorityChannelConfig();
        const prioSet = new Set(cfg.ids);
        const pinnedSet = new Set(cfg.pinnedIds || []);

        // Pripnuté obľúbené kanály vždy zobrazíme navrchu rebríčka
        const sortedChannels = [...data.channels].sort((a, b) => {
            const aPin = pinnedSet.has(Number(a.chat_id)) ? 1 : 0;
            const bPin = pinnedSet.has(Number(b.chat_id)) ? 1 : 0;
            return bPin - aPin;
        });

        const rowsHtml = sortedChannels.slice(0, 35).map(ch => {
            const isPrio = prioSet.has(ch.chat_id);
            const isPinned = pinnedSet.has(Number(ch.chat_id));
            const isFocused = cfg.focusChatId === ch.chat_id;
            const title = this.escapeHtml(ch.channel_title || ch.channel || String(ch.chat_id));
            const domains = (ch.top_domains || []).slice(0, 2).map(d => this.escapeHtml(d)).join(', ');
            const hiddenBadge = ch.hidden_hint_count > 0
                ? `<span class="mega-ch-stat is-hint" title="Príspevky s textom MEGA LINK / ALT Link bez načítaných entít — spusti Doplniť"><span class="material-icons-round mega-inline-ico" aria-hidden="true">lock</span>${ch.hidden_hint_count} skrytých?</span>`
                : '';
            return `
                <div class="mega-channel-row ${isPrio ? 'is-priority' : ''} ${isPinned ? 'is-pinned' : ''} ${isFocused ? 'is-focused' : ''}" data-chat-id="${ch.chat_id}">
                    <label class="mega-ch-check" title="Zaradiť medzi prioritné kanály">
                        <input type="checkbox" ${isPrio ? 'checked' : ''} onchange="quantumSearch.togglePriorityChannel(${ch.chat_id}, this.checked)">
                        <span class="mega-tier-badge is-${this.escapeHtml(ch.tier)}">${this.escapeHtml(ch.tier)}</span>
                    </label>
                    <button type="button" class="mega-ch-pin-btn ${isPinned ? 'is-pinned' : ''}"
                        onclick="quantumSearch.togglePinnedChannel(${ch.chat_id})"
                        aria-pressed="${isPinned ? 'true' : 'false'}"
                        aria-label="${isPinned ? 'Odopnúť obľúbený kanál' : 'Pripnúť kanál na vrch'}"
                        title="${isPinned ? 'Odopnúť z obľúbených' : 'Pripnúť obľúbený kanál na vrch'}">
                        <span class="material-icons-round" aria-hidden="true">push_pin</span>
                    </button>
                    <div class="mega-ch-main">
                        <div class="mega-ch-name" title="${title}">${title} <small>(${ch.active} akt. · ${ch.quality_score} b.)</small></div>
                        <div class="mega-ch-stats">
                            <span class="mega-ch-stat is-mega"><span class="material-icons-round mega-inline-ico" aria-hidden="true">cloud_done</span>${ch.direct_mega} MEGA</span>
                            <span class="mega-ch-stat is-paste"><span class="material-icons-round mega-inline-ico" aria-hidden="true">description</span>${ch.paste_free} bez brány</span>
                            ${ch.in_hub ? `<span class="mega-ch-stat is-hub"><span class="material-icons-round mega-inline-ico" aria-hidden="true">check_circle</span>${ch.in_hub} v Hube</span>` : ''}
                            ${hiddenBadge}
                            <span class="mega-ch-stat">${ch.free_rate}% bez brány</span>
                            ${domains ? `<span class="mega-ch-domains">${domains}</span>` : ''}
                        </div>
                    </div>
                    <div class="mega-ch-actions">
                        <button type="button" class="mega-mini-btn ${isFocused ? 'is-accent' : ''}" onclick="quantumSearch.focusSingleLinkChannel(${ch.chat_id})" title="Zobraziť len tento kanál"><span class="material-icons-round mega-inline-ico" aria-hidden="true">${isFocused ? 'my_location' : 'filter_alt'}</span>${isFocused ? 'Aktívny' : 'Len tento'}</button>
                        ${ch.missing_entities > 0 ? `<button type="button" class="mega-mini-btn is-tester" onclick="quantumSearch.backfillMegaLinkEntities({ chatIds: [${ch.chat_id}], limit: 300 })" title="Doplní skryté Telegram entity pre až 300 príspevkov tohto kanála"><span class="material-icons-round mega-inline-ico" aria-hidden="true">sync</span>Doplniť (${ch.missing_entities})</button>` : ''}
                    </div>
                </div>`;
        }).join('');

        panel.innerHTML = `
            <div class="mega-channels-head">
                <div>
                    <strong class="mega-panel-heading"><span class="material-icons-round mega-inline-ico is-amber" aria-hidden="true">emoji_events</span>Rebríček Telegram kanálov (${data.total_channels} kanálov · ${data.total_posts.toLocaleString('sk-SK')} príspevkov)</strong>
                    <span class="mega-channels-sub">Pripnuté kanály sú vždy navrchu. Zoradené podľa priamych MEGA, rentry/paste bez brány a skrytých linkov.</span>
                </div>
                <div class="mega-channels-head-actions">
                    <button type="button" class="quantum-btn primary" onclick="quantumSearch.selectTopTierChannels()" title="Automaticky označí najlepšie kanály (Tier S + A) a zapne prioritný filter"><span class="material-icons-round" aria-hidden="true">star</span>Vybrať Top (S+A)</button>
                    <button type="button" class="quantum-btn ${cfg.onlyPriority ? 'active' : ''}" onclick="quantumSearch.toggleOnlyPriorityChannels()"><span class="material-icons-round" aria-hidden="true">filter_list</span>Len prioritné (${cfg.ids.length})</button>
                    <button type="button" class="quantum-btn" onclick="quantumSearch.clearPriorityChannels()"><span class="material-icons-round" aria-hidden="true">clear_all</span>Zrušiť filter</button>
                    <button type="button" class="quantum-btn" onclick="quantumSearch.loadTopChannelsStats()" title="Obnoviť štatistiky" aria-label="Obnoviť štatistiky"><span class="material-icons-round" aria-hidden="true">refresh</span></button>
                    <button type="button" class="quantum-btn" onclick="quantumSearch.toggleTopChannelsPanel()" aria-label="Zavrieť rebríček kanálov"><span class="material-icons-round" aria-hidden="true">close</span></button>
                </div>
            </div>
            <div class="mega-channels-list">${rowsHtml || '<div class="mega-channels-loading">Zatiaľ žiadne kanály.</div>'}</div>`;
        this._updatePriorityChannelsUI(cfg);
    }

    togglePriorityChannel(chatId, enabled) {
        const cfg = this._getPriorityChannelConfig();
        const set = new Set(cfg.ids);
        if (enabled) set.add(Number(chatId));
        else set.delete(Number(chatId));
        cfg.ids = [...set];
        cfg.focusChatId = null;
        this._savePriorityChannelConfig(cfg);
        this.renderTopChannelsPanel();
        if (cfg.onlyPriority) {
            this.loadMegaLinkPosts(this._lastMegaLinksQuery || '', false);
        }
    }

    selectTopTierChannels() {
        const channels = this._megaChannelsStats?.channels || [];
        const topIds = channels
            .filter(ch => ch.tier === 'S' || ch.tier === 'A')
            .slice(0, 12)
            .map(ch => Number(ch.chat_id));
        if (!topIds.length) {
            this.setActivity('Žiadne Top kanály', 'Zatiaľ nie sú vyhodnotené kanály v Tier S/A.', 'info');
            return;
        }
        const prevCfg = this._getPriorityChannelConfig();
        const cfg = { ids: topIds, pinnedIds: prevCfg.pinnedIds || [], onlyPriority: true, focusChatId: null };
        this._savePriorityChannelConfig(cfg);
        this.renderTopChannelsPanel();
        this._showSuccessToast(`Zapnutých ${topIds.length} prioritných Top kanálov (S+A)!`);
        this.loadMegaLinkPosts(this._lastMegaLinksQuery || '', false);
    }

    toggleOnlyPriorityChannels() {
        const cfg = this._getPriorityChannelConfig();
        if (cfg.focusChatId) {
            cfg.focusChatId = null;
            this._savePriorityChannelConfig(cfg);
            this.renderTopChannelsPanel();
            this.loadMegaLinkPosts(this._lastMegaLinksQuery || '', false);
            return;
        }
        if (!cfg.onlyPriority && !cfg.ids.length) {
            // Ak ešte žiadne nevybral, rovno otvoríme rebríček kanálov
            const panel = document.getElementById('megaChannelsPanel');
            if (panel && panel.hidden) {
                this.toggleTopChannelsPanel();
            }
            this.setActivity('Vyber prioritné kanály', 'Zaškrtni kanály alebo klikni „⭐ Vybrať Top (S+A)“.', 'info');
            return;
        }
        cfg.onlyPriority = !cfg.onlyPriority;
        this._savePriorityChannelConfig(cfg);
        this.renderTopChannelsPanel();
        this.loadMegaLinkPosts(this._lastMegaLinksQuery || '', false);
    }

    focusSingleLinkChannel(chatId) {
        const cfg = this._getPriorityChannelConfig();
        cfg.focusChatId = cfg.focusChatId === Number(chatId) ? null : Number(chatId);
        this._savePriorityChannelConfig(cfg);
        this.renderTopChannelsPanel();
        this.loadMegaLinkPosts(this._lastMegaLinksQuery || '', false);
    }

    clearPriorityChannels() {
        const cfg = this._getPriorityChannelConfig();
        cfg.onlyPriority = false;
        cfg.focusChatId = null;
        this._savePriorityChannelConfig(cfg);
        this.renderTopChannelsPanel();
        this.loadMegaLinkPosts(this._lastMegaLinksQuery || '', false);
    }

    async backfillMegaLinkEntities({ chatIds = null, limit = 300 } = {}) {
        const btn = document.getElementById('megaBackfillBtn');
        const query = (document.getElementById('quantumSearchInput')?.value || '').trim();
        let targetIds = Array.isArray(chatIds) ? chatIds : [];
        if (!targetIds.length) {
            const ctx = this._megaLinksContextParams();
            if (ctx.chatIds) {
                targetIds = ctx.chatIds.split(',').map(Number).filter(n => Number.isFinite(n) && n !== 0);
            }
        }
        if (btn) btn.disabled = true;
        this.setActivity(
            'Dopĺňam skryté Telegram linky…',
            `Načítavam skryté entity po 100 správach (limit ${limit}) + vyťažujem nájdené rentry.org…`,
            'working'
        );
        try {
            const res = await fetch('/api/v1/telegram/links/backfill-entities', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_ids: targetIds,
                    query: chatIds ? '' : query,
                    limit,
                    only_missing: true,
                    resolve_pastes: true,
                    max_paste_crawls: 45,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || `Doplnenie zlyhalo (${res.status})`);
            const msg = `Prejdených ${data.scanned || 0} správ · +${data.upgraded_to_mega || 0} priamych MEGA · +${data.upgraded_to_paste || 0} rentry/paste · ${data.mega_discovered || 0} MEGA a ${data.media_discovered || 0} media z paste · zostáva ${data.remaining_missing || 0}`;
            this._showSuccessToast(msg, 6500);
            this.setActivity('Skryté linky doplnené', msg, 'done');
            await this.loadMegaLinkPosts(query, false);
            const chPanel = document.getElementById('megaChannelsPanel');
            if (chPanel && !chPanel.hidden) {
                await this.loadTopChannelsStats();
            }
        } catch (error) {
            this.setActivity('Chyba dopĺňania linkov', error.message || String(error), 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    _updateMegaLinksHeaderStats() {
        const stats = document.getElementById('quantumSearchStats');
        const countEl = document.getElementById('quantumResultCount');
        const statusEl = document.getElementById('quantumMegaPacksStatus');
        const moreBtn = document.getElementById('megaLinksLoadMoreBtn');
        const items = this._megaLinkItems || [];
        const total = Number(this._megaLinksTotal) || items.length;
        const counts = this._megaLinksCounts;
        this._updateBypassToolbarBtn();
        this._updatePriorityChannelsUI();
        if (stats) stats.style.display = 'flex';
        if (countEl) countEl.textContent = items.length < total ? `${items.length} / ${total}` : String(items.length);
        if (moreBtn) moreBtn.hidden = !this._megaLinksHasMore;
        if (statusEl) {
            statusEl.textContent = counts
                ? `Zobrazených ${items.length} z ${total} · Aktívnych: ${counts.active} · Priamych MEGA: ${counts.mega} · Paste/Bez brány: ${counts.paste || 0} · V Hube: ${counts.in_hub}`
                : `Zobrazených ${items.length} príspevkov.`;
        }
        const footer = document.getElementById('megaLinksFooter');
        if (footer) {
            const remaining = Math.max(0, total - items.length);
            if (this._megaLinksHasMore && remaining > 0) {
                footer.hidden = false;
                footer.innerHTML = `<button type="button" class="quantum-btn primary" onclick="quantumSearch.loadMegaLinkPosts(quantumSearch._lastMegaLinksQuery || '', true)">⬇ Načítať ďalšie (zostáva ${remaining})</button>`;
            } else {
                footer.hidden = true;
            }
        }
    }

    _patchMegaLinkPostsInPlace(incoming) {
        const existing = this._megaLinkItems || [];
        if (!existing.length || !incoming.length) {
            this._megaLinkItems = incoming;
            this.renderMegaLinkPosts();
            return;
        }
        const byId = new Map(existing.map(it => [it.id, it]));
        let orderChanged = incoming.length !== existing.length;
        const changedIds = [];
        for (let i = 0; i < incoming.length; i++) {
            const inc = incoming[i];
            const old = byId.get(inc.id);
            if (!old) { orderChanged = true; break; }
            if (existing[i]?.id !== inc.id) orderChanged = true;
            const changed =
                old.status !== inc.status ||
                old.link_kind !== inc.link_kind ||
                old.resolved_mega_url !== inc.resolved_mega_url ||
                old.mega_video_count !== inc.mega_video_count ||
                old.mega_hub_entry_id !== inc.mega_hub_entry_id ||
                old.title !== inc.title;
            if (changed) {
                Object.assign(old, inc);
                changedIds.push(inc.id);
            }
        }
        // Ak sa zmenil počet alebo poradie pri normálnom zobrazení bez dočítaných ďalších stránok, zachováme bez blikania len vtedy, ak sme na prvej strane a niečo pribudlo
        if (orderChanged && existing.length <= 80 && incoming.length !== existing.length) {
            this._megaLinkItems = incoming;
            this.renderMegaLinkPosts();
            return;
        }
        changedIds.forEach(id => this._refreshMegaLinkCard(id));
        this._updateMegaLinksHeaderStats();
    }

    _appendMegaLinkCards(addedItems) {
        const container = document.getElementById('quantumSearchResults');
        if (!container || !addedItems.length) {
            this._updateMegaLinksHeaderStats();
            return;
        }
        const html = addedItems.map(item => this._renderMegaLinkCardHtml(item)).join('');
        const footer = document.getElementById('megaLinksFooter');
        if (footer) {
            footer.insertAdjacentHTML('beforebegin', html);
        } else {
            container.insertAdjacentHTML('beforeend', html);
        }
        this._updateMegaLinksHeaderStats();
    }

    async loadMegaLinkPosts(query = '', append = false, silent = false) {
        if (append && this._megaLoadingMore) return;
        const cleaned = (query || '').trim();
        this._lastMegaLinksQuery = cleaned;
        const filter = this._megaLinksFilter || { status: 'active', linkKind: 'all', sort: 'newest' };
        const { channel, chatIds } = this._megaLinksContextParams();
        const offset = append ? (this._megaLinkItems || []).length : 0;
        const limit = 80;
        const runId = silent ? this._searchRunId : ++this._searchRunId;

        if (append) this._megaLoadingMore = true;
        if (!silent && !append) {
            this.isSearching = true;
            this.showLoading(true);
            this.setActivity('Načítavam MEGA & Linky', cleaned || (channel ? `@${channel}` : 'všetky kanály'), 'working');
        }
        try {
            const params = new URLSearchParams({
                query: cleaned,
                channel,
                chat_ids: chatIds,
                status: filter.status || 'active',
                link_kind: filter.linkKind || 'all',
                sort: filter.sort || 'newest',
                limit: String(limit),
                offset: String(offset),
            });
            const response = await fetch(`/api/v1/telegram/links?${params.toString()}`, { cache: 'no-store' });
            const data = await response.json().catch(() => ({}));
            if (runId !== this._searchRunId && !silent) return;
            if (!response.ok) throw new Error(data.detail || `Chyba načítania (${response.status})`);

            const incoming = Array.isArray(data.items) ? data.items : [];
            this._megaLinksTotal = Number(data.total) || 0;
            this._megaLinksHasMore = Boolean(data.has_more);
            this._megaLinksCounts = data.counts || null;

            if (append) {
                const seen = new Set((this._megaLinkItems || []).map(item => item.id));
                const added = incoming.filter(item => !seen.has(item.id));
                this._megaLinkItems = [...(this._megaLinkItems || []), ...added];
                this._appendMegaLinkCards(added);
            } else if (silent) {
                this._patchMegaLinkPostsInPlace(incoming);
            } else {
                this._megaLinkItems = incoming;
                this.renderMegaLinkPosts();
            }
            if (!silent && !append) {
                this.setActivity('MEGA & Linky pripravené', `${this._megaLinkItems.length} z ${this._megaLinksTotal} príspevkov`, 'done');
            }
        } catch (error) {
            if (!silent) {
                this.showError(error.message || 'Nepodarilo sa načítať MEGA odkazy.');
                this.setActivity('Chyba načítania MEGA odkazov', error.message || String(error), 'error');
            }
        } finally {
            if (append) this._megaLoadingMore = false;
            if (!silent && !append && runId === this._searchRunId) {
                this.isSearching = false;
                this.showLoading(false);
            }
        }
    }

    async searchDirectMegaWeb() {
        const input = document.getElementById('quantumSearchInput');
        let query = (input?.value || '').trim();
        if (!query) {
            query = (window.prompt('Zadaj meno alebo kľúčové slovo pre vyhľadanie priamych mega.nz albumov:') || '').trim();
            if (!query) return;
            if (input) input.value = query;
        }
        const btn = document.getElementById('megaDirectWebBtn');
        if (btn) btn.disabled = true;
        this.setActivity('Hľadám priame MEGA odkazy', `Prehľadávam web, paste stránky, Reddit a t.me/s pre „${query}“ + overujem cez MEGA API…`, 'working');
        try {
            const res = await fetch('/api/v1/telegram/links/direct-search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, verify: true, max_verify: 24, only_alive: true }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || `Vyhľadávanie zlyhalo (${res.status})`);
            this._directMegaResults = { query, ...data };
            this._renderDirectMegaWebPanel();
            const searxNote = data.searx_online === false ? ' (SearXNG offline — len Reddit)' : '';
            this.setActivity(
                'Priame MEGA nájdené',
                `${data.alive || 0} živých albumov z ${data.verified || 0} overených (${data.dead || 0} mŕtvych)${searxNote}`,
                (data.alive || 0) > 0 ? 'done' : 'info'
            );
        } catch (error) {
            this.setActivity('Chyba priameho MEGA hľadania', error.message || String(error), 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    _renderDirectMegaWebPanel() {
        const container = document.getElementById('quantumSearchResults');
        if (!container) return;
        document.getElementById('megaDirectWebPanel')?.remove();
        const data = this._directMegaResults;
        if (!data) return;
        const items = Array.isArray(data.items) ? data.items : [];
        const searxWarn = data.searx_online === false
            ? '<span class="mega-direct-warn">⚠️ Lokálny SearXNG nebeží – prehľadal sa len Reddit.</span>' : '';
        const cardsHtml = items.length ? items.map(it => {
            const title = this.escapeHtml(it.mega_title || it.title || 'MEGA album');
            const source = this.escapeHtml(it.source || 'Web');
            const urlAttr = this.escapeHtml(it.mega_url);
            const srcUrl = it.source_url ? this.escapeHtml(it.source_url) : '';
            return `
                <div class="mega-direct-card">
                    <div class="mega-direct-card-head">
                        <span class="mega-link-badge is-mega">🟢 Priamy MEGA</span>
                        <span class="mega-link-badge is-count">🎬 ${Number(it.video_count) || 0}</span>
                        <span class="mega-direct-src">${source}</span>
                    </div>
                    <div class="mega-direct-title" title="${title}">${title}</div>
                    <div class="mega-direct-actions">
                        <button type="button" class="action-btn btn-mega-hub" data-url="${urlAttr}" data-title="${title}" onclick="quantumSearch.sendDirectMegaUrlToHub(this.dataset.url, this.dataset.title, this)">✨ Do Hubu</button>
                        <button type="button" class="action-btn" data-url="${urlAttr}" onclick="window.open(this.dataset.url, '_blank', 'noopener')" title="Otvoriť priamo v MEGA">↗ MEGA</button>
                        ${srcUrl ? `<button type="button" class="action-btn" data-url="${srcUrl}" onclick="window.open(this.dataset.url, '_blank', 'noopener')" title="Otvoriť zdrojovú stránku" style="flex:0;padding:6px 9px;">💬</button>` : ''}
                    </div>
                </div>`;
        }).join('') : `<div class="mega-direct-empty">Pre „${this.escapeHtml(data.query)}“ sa nenašli žiadne živé priame mega.nz albumy (nájdených ${data.total_found || 0}, overených ${data.verified || 0}, mŕtvych/prázdnych ${data.dead || 0}).</div>`;

        const panel = document.createElement('section');
        panel.id = 'megaDirectWebPanel';
        panel.className = 'mega-direct-panel';
        panel.innerHTML = `
            <div class="mega-direct-header">
                <div>
                    <strong>🌐 Živé priame MEGA albumy pre „${this.escapeHtml(data.query)}“</strong>
                    <span class="mega-direct-meta">Živých: ${data.alive || 0} · Overených: ${data.verified || 0} · Mŕtvych: ${data.dead || 0}</span>
                    ${searxWarn}
                </div>
                <button type="button" class="quantum-btn" onclick="quantumSearch._directMegaResults=null;document.getElementById('megaDirectWebPanel')?.remove()">✕ Zavrieť</button>
            </div>
            <div class="mega-direct-grid">${cardsHtml}</div>`;
        container.prepend(panel);
    }

    async scanTelegramLinksLive() {
        const btn = document.getElementById('megaLinksScanBtn');
        const query = (document.getElementById('quantumSearchInput')?.value || '').trim();
        const { channel, chatIds } = this._megaLinksContextParams();
        const parsedChatIds = chatIds ? chatIds.split(',').map(Number).filter(n => Number.isFinite(n) && n !== 0) : [];

        if (btn) btn.disabled = true;
        this.showLoading(true);
        this.setActivity('Skenujem Telegram odkazy', channel ? `Kanál: ${channel}` : (query || 'globálne odkazy'), 'working');
        const statusEl = document.getElementById('quantumMegaPacksStatus');
        if (statusEl) statusEl.textContent = 'Prehľadávam Telegram správy s odkazmi…';

        try {
            const response = await fetch('/api/v1/telegram/links/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query,
                    channel,
                    chat_ids: parsedChatIds,
                    limit: Math.min(400, Math.max(40, this.getTelegramLimit ? this.getTelegramLimit() : 80)),
                }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.detail || `Skenovanie zlyhalo (${response.status})`);

            const floodNote = data.flood_wait ? ` · Telegram prestávka ${data.flood_wait}s` : '';
            const msg = `Nájdených ${data.saved || 0} príspevkov (${data.added || 0} nových, ${data.updated || 0} aktualizovaných)${floodNote}.`;
            if (statusEl) statusEl.textContent = msg;
            this.setActivity('Skenovanie dokončené', msg, 'done');
            await this.loadMegaLinkPosts(query, false, true);
        } catch (error) {
            const msg = error.message || 'Skenovanie Telegramu zlyhalo.';
            if (statusEl) statusEl.textContent = msg;
            this.setActivity('Chyba skenovania', msg, 'error');
        } finally {
            if (btn) btn.disabled = false;
            this.showLoading(false);
        }
    }

    async seedTelegramLinksFromDb() {
        const btn = document.getElementById('megaLinksSeedBtn');
        const statusEl = document.getElementById('quantumMegaPacksStatus');
        if (btn) btn.disabled = true;
        this.setActivity('Extrahujem MEGA & balíčkové odkazy z video DB', 'Prechádzam popisy uložených Telegram videí…', 'working');
        try {
            const selectedIds = Array.from(this.telegramChats || [])
                .map(value => parseInt(value, 10))
                .filter(num => Number.isFinite(num));
            const params = new URLSearchParams({ limit: '8000' });
            if (selectedIds.length) params.set('chat_ids', selectedIds.join(','));
            const response = await fetch(`/api/v1/telegram/links/seed?${params.toString()}`, { method: 'POST' });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.detail || `Import zlyhal (${response.status})`);
            const msg = `Skontrolovaných ${data.scanned || 0} video príspevkov · pridaných ${data.added || 0} nových a aktualizovaných ${data.updated || 0} kariet.`;
            if (statusEl) statusEl.textContent = msg;
            this.setActivity('Extrakcia dokončená', msg, 'done');
            await this.loadMegaLinkPosts(this._lastMegaLinksQuery || '', false, true);
        } catch (error) {
            this.setActivity('Chyba extrakcie', error.message || String(error), 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    // --- MEGA Autopilot (pozadie: rozbalenie -> overenie reálneho albumu -> MEGA Hub) ---
    async refreshMegaAutopilot(silent = true) {
        try {
            const res = await fetch('/api/v1/telegram/links/autopilot', { cache: 'no-store' });
            if (!res.ok) return null;
            const data = await res.json();
            this._applyMegaAutopilot(data);
            return data;
        } catch (_) { return null; }
    }

    _applyMegaAutopilot(data) {
        const prev = this._autopilotLastRun;
        this._autopilotLastRun = data.last_run;
        const btn = document.getElementById('megaAutopilotBtn');
        if (btn) {
            btn.classList.toggle('primary', Boolean(data.enabled));
            btn.setAttribute('aria-pressed', String(Boolean(data.enabled)));
            this._setBtnLabel(btn, `Autopilot: ${data.enabled ? 'ZAP' : 'VYP'}`);
        }
        const menuBtn = document.getElementById('megaAutopilotMenuBtn');
        if (menuBtn) {
            menuBtn.classList.toggle('is-autopilot-on', Boolean(data.enabled));
            this._setBtnLabel(menuBtn, data.enabled ? 'Autopilot: ZAP' : 'Autopilot');
        }
        const modeBtn = document.getElementById('megaAutopilotModeBtn');
        if (modeBtn) {
            this._setBtnLabel(modeBtn, data.auto_add ? 'Režim: pripraviť + pridať' : 'Režim: len pripraviť');
            modeBtn.classList.toggle('active', Boolean(data.auto_add));
        }
        const t = data.totals || {};
        const p = data.pending || {};
        const statusEl = document.getElementById('quantumMegaPacksStatus');
        if (statusEl && (data.enabled || data.running)) {
            statusEl.textContent = `🤖 ${data.running ? 'beží…' : 'aktívny'} · overené ${t.verified || 0} · v Hube +${t.added || 0} · mŕtve ${t.dead || 0} · čaká ${p.mega_to_verify ?? '?'} na overenie / ${p.external_unresolved ?? '?'} externých`;
        }
        const ls = data.last_stats || {};
        if (prev && data.last_run !== prev && this.megaPacksMode && (ls.added || ls.dead || ls.resolved || ls.skipped || ls.verified)) {
            this.loadMegaLinkPosts(this._lastMegaLinksQuery || '', false, true);
            if (ls.added) window.nexusMegaHub?.reload?.();
        }
        if (data.enabled && this.megaPacksMode && !this._autopilotPoll) {
            this._autopilotPoll = setInterval(() => {
                if (!this.megaPacksMode) { clearInterval(this._autopilotPoll); this._autopilotPoll = null; return; }
                this.refreshMegaAutopilot();
            }, 15000);
        }
        if ((!data.enabled || !this.megaPacksMode) && this._autopilotPoll) {
            clearInterval(this._autopilotPoll);
            this._autopilotPoll = null;
        }
    }

    async toggleMegaAutopilot() {
        const current = await this.refreshMegaAutopilot();
        const enable = !(current && current.enabled);
        try {
            const res = await fetch('/api/v1/telegram/links/autopilot/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: enable }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || `Chyba (${res.status})`);
            this._applyMegaAutopilot(data);
            this.setActivity(enable ? 'Autopilot zapnutý' : 'Autopilot vypnutý',
                enable ? 'Linky sa budú na pozadí overovať a pridávať do MEGA Hubu.' : 'Automatické spracovanie zastavené.', 'done');
            if (enable) this.runMegaAutopilotNow();
        } catch (error) {
            this.setActivity('Chyba autopilota', error.message || String(error), 'error');
        }
    }

    async toggleMegaAutopilotMode() {
        const current = await this.refreshMegaAutopilot();
        try {
            const res = await fetch('/api/v1/telegram/links/autopilot/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ auto_add: !(current && current.auto_add) }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || `Chyba (${res.status})`);
            this._applyMegaAutopilot(data);
            this.setActivity('Režim autopilota', data.auto_add
                ? 'Reálne albumy (≥ 2 videí) sa budú pridávať do Hubu automaticky.'
                : 'Autopilot len pripravuje (rozbalí + overí). Do Hubu posielaš ty.', 'done');
        } catch (error) {
            this.setActivity('Chyba autopilota', error.message || String(error), 'error');
        }
    }

    async runMegaAutopilotNow() {
        this.setActivity('Autopilot', 'Spracúvam čakajúce linky…', 'working');
        try {
            const res = await fetch('/api/v1/telegram/links/autopilot/run', { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || `Chyba (${res.status})`);
            this._applyMegaAutopilot(data);
            const s = data.stats || {};
            this.setActivity('Autopilot dokončil cyklus',
                s.skipped === 'busy' ? 'Už beží.' : `+${s.added || 0} do Hubu · rozbalených ${s.resolved || 0} · mŕtvych ${s.dead || 0} · preskočených ${s.skipped || 0}`, 'done');
            await this.loadMegaLinkPosts(this._lastMegaLinksQuery || '', false, true);
            if (s.added) window.nexusMegaHub?.reload?.();
        } catch (error) {
            this.setActivity('Chyba autopilota', error.message || String(error), 'error');
        }
    }
    // --- Spracovanie kariet: jedna karta aj hromadný výber ---
    // Jedna akcia = rozbaliť -> overiť -> (add) poslať do Hubu. Server vráti `outcome`.
    _formatMegaBytes(bytes) {
        const b = Number(bytes) || 0;
        if (b <= 0) return '';
        if (b >= 1024 ** 3) return `${(b / (1024 ** 3)).toFixed(b >= 10 * 1024 ** 3 ? 1 : 2)} GB`;
        if (b >= 1024 ** 2) return `${(b / (1024 ** 2)).toFixed(0)} MB`;
        return `${Math.round(b / 1024)} KB`;
    }

    _applyProcessOutcome(item, data, add) {
        if (data.item) Object.assign(item, data.item);
        const n = Number(data.count ?? item.mega_video_count) || 0;
        item._gate = false;
        const sizeLabel = this._formatMegaBytes(data.bytes);
        const filesNum = Number(data.files) || 0;
        const aliveInfo = filesNum ? `${filesNum.toLocaleString('sk-SK')} súborov${sizeLabel ? ` · ${sizeLabel}` : ''}` : 'živý priečinok';
        const map = {
            added: ['verified', `✅ Pridané do Hubu (${this._formatMegaVideoCount(n)})`],
            exists: ['verified', `✅ Už v Hube (${this._formatMegaVideoCount(n)})`],
            verified: ['verified', `✅ Reálny album · ${this._formatMegaVideoCount(n)} · pripravené na pridanie`],
            multi_mega: ['verified', `📦 ${data.reason || `Nájdených ${data.alive_count || 0}/${data.total_count || 0} živých MEGA priečinkov (${this._formatMegaVideoCount(n)})`} — vyber nižšie alebo pošli všetky živé.`],
            media_only: ['verified', `🟣 ${data.reason || `Nájdených ${data.media_count || 0} priamych media odkazov (Bunkr/Gofile/Pixeldrain…)`}`],
            needs_key: ['verified', `🔐 Živý na MEGA (${aliveInfo}) — klikni „🔑 Získať kľúč ↗“ alebo „📋 Vložiť kľúč“`],
            small: ['warning', `⚠️ Len ${this._formatMegaVideoCount(n)} – pravdepodobne teaser/ukážka`],
            empty: ['warning', `⚠️ Prázdny priečinok (0 videí) · ${data.reason || 'bez videí'}`],
            dead: ['dead', `❌ Mŕtvy odkaz · ${data.reason || 'na MEGA už neexistuje'}`],
            retry: ['error', `⚠️ Skús znova · ${data.reason || 'MEGA dočasne neodpovedá'}`],
            invalid: ['error', `⚠️ ${data.reason || 'Neplatný odkaz'}`],
            gate: ['warning', `🔒 ${data.reason || 'Treba otvoriť ručne'} – použi „Ručne ▾“`],
        };
        const [state, message] = map[data.outcome] || ['error', 'Neznámy výsledok'];
        item._verifyState = state;
        item._verifyMessage = message;
        if (data.outcome === 'gate') item._gate = true;
        if (data.outcome === 'multi_mega' || data.outcome === 'media_only') item._harvestOpen = true;
        if (data.outcome === 'needs_key') item._keylessAlive = { files: filesNum, bytes: Number(data.bytes) || 0 };
        return data.outcome;
    }

    async pasteMegaKeyForPost(postId, btn) {
        const item = (this._megaLinkItems || []).find(entry => entry.id === postId);
        let pasted = '';
        try {
            if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
                const clip = (await navigator.clipboard.readText() || '').trim();
                const isKey = /^#?[A-Za-z0-9_-]{22}$|^#?[A-Za-z0-9_-]{43}$/.test(clip);
                const isMegaUrl = /mega\.(?:nz|co\.nz)\/(?:folder|file)\/[A-Za-z0-9_-]{8}#[A-Za-z0-9_-]{22,43}/i.test(clip);
                if (isKey || isMegaUrl) pasted = clip;
            }
        } catch (_) {}
        if (!pasted) {
            const label = item?.keyless_mega_url
                ? `Vlož MEGA kľúč (napr. 22 znakov z Bypass.city) pre ${item.keyless_mega_url} alebo celú MEGA URL:`
                : 'Vlož výsledný mega.nz odkaz (vrátane #kľúča):';
            pasted = (window.prompt(label) || '').trim();
        }
        if (!pasted) return;
        await this.sendMegaLinkPostToHub(postId, btn, pasted);
    }

    async processMegaLinkPost(postId, add = true, { quiet = false } = {}) {
        const item = (this._megaLinkItems || []).find(entry => entry.id === postId);
        if (!item || item._busy) return null;
        item._busy = true;
        item._verifyState = 'checking';
        item._verifyMessage = add ? 'Rozbaľujem, overujem a posielam do Hubu…' : 'Rozbaľujem a overujem…';
        this._refreshMegaLinkCard(postId);
        let outcome = 'retry';
        try {
            const res = await fetch(`/api/v1/telegram/links/${postId}/process?add=${add ? 'true' : 'false'}`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || `Chyba (${res.status})`);
            outcome = this._applyProcessOutcome(item, data, add);
            if ((outcome === 'added' || outcome === 'exists') && !quiet) window.nexusMegaHub?.reload?.();
            if (!quiet) this.setActivity(item._verifyMessage, item.title || '', outcome === 'dead' || outcome === 'retry' ? 'error' : 'done');
        } catch (error) {
            item._verifyState = 'error';
            item._verifyMessage = `⚠️ ${error.message || error}`;
            if (!quiet) this.setActivity('Chyba spracovania', item._verifyMessage, 'error');
        } finally {
            item._busy = false;
            this._refreshMegaLinkCard(postId);
        }
        return outcome;
    }

    // --- Výber kariet ---
    _ensureMegaSelection() {
        if (!this._megaSelected) this._megaSelected = new Set();
        return this._megaSelected;
    }

    toggleMegaSelect(postId, checked) {
        const sel = this._ensureMegaSelection();
        if (checked) sel.add(postId); else sel.delete(postId);
        document.querySelector(`.mega-link-card[data-link-post-id="${postId}"]`)?.classList.toggle('is-selected', Boolean(checked));
        this._renderMegaSelectionBar();
    }

    selectMegaCards(mode) {
        const sel = this._ensureMegaSelection();
        const selectable = (this._megaLinkItems || []).filter(i => i.status !== 'in_hub' && i.status !== 'dead' && i.status !== 'skipped');
        let pick = selectable;
        if (mode === 'verified') pick = selectable.filter(i => (i.mega_video_count || 0) > 0);
        else if (mode === 'none') pick = [];
        sel.clear();
        pick.forEach(i => sel.add(i.id));
        // Aktualizujeme iba triedy a checkboxy bez prekreslenia celého gridu (žiadne blikanie)
        document.querySelectorAll('#quantumSearchResults .mega-link-card').forEach(card => {
            const id = Number(card.getAttribute('data-link-post-id'));
            const on = sel.has(id);
            card.classList.toggle('is-selected', on);
            const cb = card.querySelector('.mega-select-box input[type="checkbox"]');
            if (cb) cb.checked = on;
        });
        this._renderMegaSelectionBar();
    }

    _renderMegaSelectionBar() {
        let bar = document.getElementById('megaSelectionBar');
        const sel = this._ensureMegaSelection();
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'megaSelectionBar';
            bar.className = 'mega-selection-bar';
            const host = document.querySelector('#quantumSearchOverlay .quantum-search-container') || document.body;
            host.appendChild(bar);
        }
        const run = this._megaBulk;
        if (!sel.size && !run) { bar.hidden = true; return; }
        bar.hidden = false;
        if (run) {
            bar.innerHTML = `
                <span class="mega-sel-count">⏳ ${run.done}/${run.total} · ✅ ${run.ok} · ❌ ${run.dead} · ⚠️ ${run.other}</span>
                <button type="button" class="quantum-btn" onclick="quantumSearch.cancelMegaBulk()">Zastaviť</button>`;
            return;
        }
        const items = (this._megaLinkItems || []).filter(i => sel.has(i.id));
        const verifiedCount = items.filter(i => (i.mega_video_count || 0) > 0).length;
        bar.innerHTML = `
            <span class="mega-sel-count">Vybrané: <b>${sel.size}</b>${verifiedCount ? ` · overených ${verifiedCount}` : ''}</span>
            <button type="button" class="quantum-btn primary" onclick="quantumSearch.processSelectedMega(true)" title="Pre každú vybranú kartu: rozbaliť → overiť → poslať do Hubu">✨ Získať a do Hubu</button>
            <button type="button" class="quantum-btn" onclick="quantumSearch.processSelectedMega(false)" title="Len rozbaliť a overiť – nič sa nepridá, uvidíš počet videí">🔍 Len overiť</button>
            <button type="button" class="quantum-btn" onclick="quantumSearch.skipSelectedMega()" title="Označí vybrané ako preskočené">✕ Preskočiť</button>
            <button type="button" class="quantum-btn" onclick="quantumSearch.selectMegaCards('none')">Zrušiť výber</button>`;
    }

    cancelMegaBulk() {
        if (this._megaBulk) this._megaBulk.cancelled = true;
    }

    async processSelectedMega(add) {
        if (this._megaBulk) return;
        const ids = [...this._ensureMegaSelection()];
        if (!ids.length) return;
        const run = { total: ids.length, done: 0, ok: 0, dead: 0, other: 0, cancelled: false };
        this._megaBulk = run;
        this._renderMegaSelectionBar();
        const queue = [...ids];
        const worker = async () => {
            while (queue.length && !run.cancelled) {
                const id = queue.shift();
                const outcome = await this.processMegaLinkPost(id, add, { quiet: true });
                run.done += 1;
                if (['added', 'exists', 'verified'].includes(outcome)) run.ok += 1;
                else if (outcome === 'dead') run.dead += 1;
                else run.other += 1;
                this._megaSelected?.delete(id);
                this._renderMegaSelectionBar();
            }
        };
        await Promise.all([worker(), worker(), worker()]);
        this._megaBulk = null;
        this._renderMegaSelectionBar();
        window.nexusMegaHub?.reload?.();
        this.setActivity(run.cancelled ? 'Spracovanie zastavené' : 'Spracovanie dokončené',
            `${run.ok} v poriadku · ${run.dead} mŕtvych · ${run.other} vyžaduje pozornosť (z ${run.total})`, 'done');
        if (!add && run.ok) this._showSuccessToast(`Overených ${run.ok} albumov – vyber „Overené“ a pošli ich do Hubu.`);
    }

    async skipSelectedMega() {
        const ids = [...this._ensureMegaSelection()];
        for (const id of ids) await this.setMegaLinkPostStatus(id, 'skipped');
        this._megaSelected.clear();
        this._renderMegaSelectionBar();
    }

    filterMegaLinksByTag(tag) {
        if (!tag) return;
        const input = document.getElementById('quantumSearchInput');
        if (input) input.value = tag;
        this.loadMegaLinkPosts(tag, false, false);
    }

    toggleMegaLinkVideoPreview(postId, btn) {
        const card = document.querySelector(`.mega-link-card[data-link-post-id="${postId}"]`);
        const thumbBox = card?.querySelector('.mega-link-thumb');
        if (!thumbBox) return;

        const existingVideo = thumbBox.querySelector('video.mega-thumb-video');
        if (existingVideo) {
            try { existingVideo.pause(); } catch (_) {}
            existingVideo.remove();
            if (btn) btn.innerHTML = btn.dataset.origLabel || '▶ Ukážka';
            return;
        }

        // Zastavíme iné práve prehrávané ukážky na ostatných kartách.
        document.querySelectorAll('.mega-link-thumb video.mega-thumb-video').forEach(other => {
            try { other.pause(); } catch (_) {}
            const parentBtn = other.parentElement?.querySelector('.mega-video-preview-btn');
            if (parentBtn && parentBtn.dataset.origLabel) parentBtn.innerHTML = parentBtn.dataset.origLabel;
            other.remove();
        });

        const item = (this._megaLinkItems || []).find(entry => entry.id === postId);
        const streamUrl = item?.video_stream_url || (item ? `/api/v1/telegram/stream/${item.chat_id}/${item.message_id}?preview=1` : '');
        if (!streamUrl) return;

        if (btn && !btn.dataset.origLabel) btn.dataset.origLabel = btn.innerHTML;
        if (btn) btn.innerHTML = '⏹ Zavrieť';

        const video = document.createElement('video');
        video.className = 'mega-thumb-video';
        video.src = streamUrl;
        video.controls = true;
        video.autoplay = true;
        video.playsInline = true;
        video.loop = true;
        video.preload = 'metadata';
        video.addEventListener('click', ev => ev.stopPropagation());
        thumbBox.appendChild(video);
    }

    _replaceMegaLinkItem(updated) {
        if (!updated || !updated.id) return;
        const idx = (this._megaLinkItems || []).findIndex(item => item.id === updated.id);
        if (idx >= 0) {
            this._megaLinkItems[idx] = updated;
        }
        this.renderMegaLinkPosts();
        if (this._harvestInspectorPostId === updated.id) {
            this.renderMegaHarvestInspector(updated.id);
        }
    }

    openMegaHubEntry(entryId) {
        if (window.nexusMegaHub && typeof window.nexusMegaHub.open === 'function') {
            window.nexusMegaHub.open(entryId);
            return;
        }
        window.open(`/?mega_hub=${encodeURIComponent(entryId)}`, '_blank', 'noopener');
    }

    _showSuccessToast(message, duration = 4500) {
        try {
            if (window.NexusToast && typeof window.NexusToast.success === 'function') {
                window.NexusToast.success(message, duration);
                return;
            }
            if (typeof window.showToast === 'function') {
                window.showToast(message, 'check_circle', 'success', duration);
                return;
            }
        } catch (_) {}
    }

    _startMegaHandoffPolling(postId, viaBypassCity = false) {
        if (this._handoffPollTimer) clearInterval(this._handoffPollTimer);
        let ticks = 0;
        this._handoffPollTimer = setInterval(async () => {
            ticks += 1;
            if (ticks > 48 || !this.megaPacksMode) {
                clearInterval(this._handoffPollTimer);
                this._handoffPollTimer = null;
                return;
            }
            const current = (this._megaLinkItems || []).find(entry => entry.id === postId);
            if (!current || current.status === 'in_hub') {
                clearInterval(this._handoffPollTimer);
                this._handoffPollTimer = null;
                return;
            }
            await this.loadMegaLinkPosts(this._lastMegaLinksQuery || '', false, true);
            const updated = (this._megaLinkItems || []).find(entry => entry.id === postId);
            if (updated && updated.status === 'in_hub') {
                clearInterval(this._handoffPollTimer);
                this._handoffPollTimer = null;
                try {
                    if (this._bypassPopupWin && !this._bypassPopupWin.closed) {
                        this._bypassPopupWin.close();
                    }
                } catch (_) {}
                this._bypassPopupWin = null;
                window.nexusMegaHub?.reload?.();
                const toastMsg = viaBypassCity
                    ? 'MEGA link úspešne extrahovaný z bypass.city!'
                    : 'MEGA link úspešne extrahovaný do MEGA Hubu!';
                this._showSuccessToast(toastMsg);
                this.setActivity(
                    'Automaticky uložené v MEGA Hube',
                    `„${updated.title || 'Priečinok'}“ (${updated.mega_video_count || 0} videí) bol automaticky zachytený z prehliadača.`,
                    'done'
                );
            }
        }, 2500);
    }

    // --- Multi-Provider Bypass Rotátor (proti IP cooldownu na bypass.city) ---
    _getDefaultBypassConfig() {
        return {
            mode: 'auto', // 'auto' (Round-Robin) alebo ID konkrétneho providera
            lastIndex: -1,
            cooldowns: {},
            providers: [
                { id: 'bypass_city', name: 'Bypass.city', template: 'https://bypass.city/bypass?bypass={url}', enabled: true },
                { id: 'bypass_vip', name: 'Bypass.vip', template: 'https://bypass.vip/?url={url}', enabled: true },
                { id: 'keybypass', name: 'KeyBypass', template: 'https://keybypass.net/?url={url}', enabled: false },
                { id: 'custom', name: 'Vlastný', template: '', enabled: false },
            ],
        };
    }

    _getBypassConfig() {
        const defaults = this._getDefaultBypassConfig();
        try {
            const raw = localStorage.getItem('nexus_bypass_providers_v1');
            if (!raw) return defaults;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return defaults;
            const byId = new Map((Array.isArray(parsed.providers) ? parsed.providers : []).map(p => [p.id, p]));
            const providers = defaults.providers.map(def => {
                const saved = byId.get(def.id);
                if (!saved) return def;
                return {
                    ...def,
                    enabled: typeof saved.enabled === 'boolean' ? saved.enabled : def.enabled,
                    template: def.id === 'custom' ? String(saved.template || '').trim() : (saved.template || def.template),
                };
            });
            return {
                mode: String(parsed.mode || 'auto'),
                lastIndex: Number.isInteger(parsed.lastIndex) ? parsed.lastIndex : -1,
                cooldowns: (parsed.cooldowns && typeof parsed.cooldowns === 'object') ? parsed.cooldowns : {},
                providers,
            };
        } catch (_) {
            return defaults;
        }
    }

    _saveBypassConfig(cfg) {
        try {
            localStorage.setItem('nexus_bypass_providers_v1', JSON.stringify(cfg));
        } catch (_) {}
        this._updateBypassToolbarBtn(cfg);
    }

    _activeBypassProviders(cfg = null) {
        const c = cfg || this._getBypassConfig();
        return c.providers.filter(p => p.enabled && p.template && /^https?:\/\//i.test(p.template));
    }

    _isProviderCooling(cfg, providerId, now = Date.now()) {
        return Number(cfg.cooldowns?.[providerId] || 0) > now;
    }

    _pickBypassProvider({ advance = true, explicitId = '' } = {}) {
        const cfg = this._getBypassConfig();
        const now = Date.now();
        const active = this._activeBypassProviders(cfg);
        const pool = active.length ? active : [cfg.providers[0]];

        if (explicitId) {
            const found = cfg.providers.find(p => p.id === explicitId && p.template);
            if (found) return found;
        }
        if (cfg.mode !== 'auto') {
            const pinned = cfg.providers.find(p => p.id === cfg.mode && p.template);
            if (pinned) return pinned;
        }

        const healthy = pool.filter(p => !this._isProviderCooling(cfg, p.id, now));
        const list = healthy.length ? healthy : [...pool].sort((a, b) => Number(cfg.cooldowns?.[a.id] || 0) - Number(cfg.cooldowns?.[b.id] || 0));
        const nextIdx = (cfg.lastIndex + 1) % list.length;
        const chosen = list[nextIdx] || list[0];
        if (advance) {
            cfg.lastIndex = nextIdx;
            this._saveBypassConfig(cfg);
        }
        return chosen;
    }

    _markBypassProviderCooldown(providerId, minutes = 3) {
        if (!providerId) return;
        const cfg = this._getBypassConfig();
        cfg.cooldowns = { ...(cfg.cooldowns || {}), [providerId]: Date.now() + minutes * 60 * 1000 };
        this._saveBypassConfig(cfg);
        this.renderBypassConfigPanel();
    }

    _resetBypassCooldowns() {
        const cfg = this._getBypassConfig();
        cfg.cooldowns = {};
        this._saveBypassConfig(cfg);
        this.renderBypassConfigPanel();
        this._showSuccessToast('Cooldown všetkých bypass providerov bol vynulovaný.');
    }

    _buildBypassUrl(provider, targetUrl) {
        const tpl = String(provider?.template || 'https://bypass.city/bypass?bypass={url}');
        const encoded = encodeURIComponent(targetUrl);
        if (tpl.includes('{url}')) return tpl.replace(/\{url\}/g, encoded);
        return `${tpl}${tpl.includes('?') ? '&' : '?'}url=${encoded}`;
    }

    _updateBypassToolbarBtn(cfg = null) {
        const btn = document.getElementById('megaBypassSettingsBtn');
        if (!btn) return;
        const c = cfg || this._getBypassConfig();
        const now = Date.now();
        const active = this._activeBypassProviders(c);
        if (c.mode === 'auto') {
            const healthyCount = active.filter(p => !this._isProviderCooling(c, p.id, now)).length;
            this._setBtnLabel(btn, `Bypass: Auto (${healthyCount}/${active.length || 1})`);
        } else {
            const pinned = c.providers.find(p => p.id === c.mode);
            const cool = pinned && this._isProviderCooling(c, pinned.id, now);
            this._setBtnLabel(btn, `Bypass: ${pinned?.name || c.mode}${cool ? ' (cooldown)' : ''}`);
        }
    }

    _stopBypassCooldownTimer() {
        if (this._bypassCooldownTimer) {
            clearInterval(this._bypassCooldownTimer);
            this._bypassCooldownTimer = null;
        }
    }

    _syncBypassCooldownTimer() {
        const panel = document.getElementById('megaBypassConfigPanel');
        if (!panel || panel.hidden) {
            this._stopBypassCooldownTimer();
            return;
        }
        const cfg = this._getBypassConfig();
        const now = Date.now();
        const hasCooling = cfg.providers.some(p => Number(cfg.cooldowns?.[p.id] || 0) > now);
        if (!hasCooling) {
            this._stopBypassCooldownTimer();
            return;
        }
        if (this._bypassCooldownTimer) return;
        this._bypassCooldownTimer = setInterval(() => {
            const pEl = document.getElementById('megaBypassConfigPanel');
            if (!pEl || pEl.hidden) {
                this._stopBypassCooldownTimer();
                return;
            }
            const curCfg = this._getBypassConfig();
            const tickNow = Date.now();
            let stillCooling = false;
            curCfg.providers.forEach(p => {
                const coolEl = pEl.querySelector(`[data-bypass-cool-id="${p.id}"]`);
                const chip = coolEl?.closest?.('.mega-bypass-chip');
                const coolMs = Math.max(0, Number(curCfg.cooldowns?.[p.id] || 0) - tickNow);
                if (coolMs > 0) {
                    stillCooling = true;
                    if (coolEl) coolEl.textContent = ` ${Math.ceil(coolMs / 1000)}s`;
                    if (chip) chip.classList.add('is-cooling');
                } else {
                    if (coolEl) coolEl.textContent = p.template ? ' ✓' : '';
                    if (chip) chip.classList.remove('is-cooling');
                }
            });
            this._updateBypassToolbarBtn(curCfg);
            if (!stillCooling) {
                this._stopBypassCooldownTimer();
            }
        }, 1000);
    }

    toggleBypassConfigPanel() {
        const panel = document.getElementById('megaBypassConfigPanel');
        if (!panel) return;
        panel.hidden = !panel.hidden;
        if (!panel.hidden) {
            this.renderBypassConfigPanel();
        } else {
            this._stopBypassCooldownTimer();
        }
    }

    renderBypassConfigPanel() {
        const panel = document.getElementById('megaBypassConfigPanel');
        if (!panel) return;
        const cfg = this._getBypassConfig();
        const now = Date.now();
        const customProv = cfg.providers.find(p => p.id === 'custom');
        const modeOptions = [
            `<button type="button" class="refine-btn ${cfg.mode === 'auto' ? 'active' : ''}" onclick="quantumSearch.setBypassMode('auto')"><span class="material-icons-round mega-inline-ico" aria-hidden="true">autorenew</span>Auto-rotácia</button>`,
            ...cfg.providers.filter(p => p.template || p.id === 'custom').map(p =>
                `<button type="button" class="refine-btn ${cfg.mode === p.id ? 'active' : ''}" onclick="quantumSearch.setBypassMode('${p.id}')">${this.escapeHtml(p.name)}</button>`
            ),
        ].join('');

        const providerChips = cfg.providers.map(p => {
            const coolMs = Math.max(0, Number(cfg.cooldowns?.[p.id] || 0) - now);
            const coolText = coolMs > 0 ? ` ${Math.ceil(coolMs / 1000)}s` : (p.template ? ' ✓' : '');
            return `
                <label class="mega-bypass-chip ${coolMs > 0 ? 'is-cooling' : ''}" title="${this.escapeHtml(p.template || 'Zadaj vlastnú URL šablónu nižšie')}">
                    <input type="checkbox" ${p.enabled ? 'checked' : ''} onchange="quantumSearch.toggleBypassProviderEnabled('${p.id}', this.checked)">
                    <span>${this.escapeHtml(p.name)}</span>
                    <span class="mega-bypass-cool-text" data-bypass-cool-id="${this.escapeHtml(p.id)}">${coolText}</span>
                </label>`;
        }).join('');

        panel.innerHTML = `
            <div class="mega-bypass-row">
                <span class="mega-bypass-label">Režim:</span>
                <div class="mega-bypass-modes">${modeOptions}</div>
                <button type="button" class="quantum-btn" onclick="quantumSearch._resetBypassCooldowns()" title="Vynuluje cooldown časovače"><span class="material-icons-round" aria-hidden="true">restart_alt</span>Reset cooldown</button>
                <button type="button" class="quantum-btn" onclick="quantumSearch.toggleBypassConfigPanel()" aria-label="Zavrieť nastavenia bypassu"><span class="material-icons-round" aria-hidden="true">close</span></button>
            </div>
            <div class="mega-bypass-row">
                <span class="mega-bypass-label">Rotovať medzi:</span>
                <div class="mega-bypass-chips">${providerChips}</div>
            </div>
            <div class="mega-bypass-row">
                <span class="mega-bypass-label">Vlastný template:</span>
                <input type="url" class="mega-bypass-custom-input" value="${this.escapeHtml(customProv?.template || '')}" placeholder="https://tvoj-bypasser.example/?url={url}" onchange="quantumSearch.setBypassCustomTemplate(this.value)">
                <small class="mega-bypass-hint">Tip: Linkvertise <code>dynamic?r=</code> a <code>rentry.org</code> sa dekódujú lokálne bez bypasseru.</small>
            </div>`;
        this._updateBypassToolbarBtn(cfg);
        this._syncBypassCooldownTimer();
    }

    setBypassMode(mode) {
        const cfg = this._getBypassConfig();
        cfg.mode = mode || 'auto';
        this._saveBypassConfig(cfg);
        this.renderBypassConfigPanel();
        this.renderMegaLinkPosts();
    }

    toggleBypassProviderEnabled(providerId, enabled) {
        const cfg = this._getBypassConfig();
        const target = cfg.providers.find(p => p.id === providerId);
        if (target) target.enabled = Boolean(enabled);
        this._saveBypassConfig(cfg);
        this.renderBypassConfigPanel();
    }

    setBypassCustomTemplate(value) {
        const cfg = this._getBypassConfig();
        const custom = cfg.providers.find(p => p.id === 'custom');
        if (custom) {
            custom.template = String(value || '').trim();
            if (custom.template) custom.enabled = true;
        }
        this._saveBypassConfig(cfg);
        this.renderBypassConfigPanel();
    }

    async retryWithNextBypassProvider(postId, btn = null, overrideUrl = '') {
        const item = (this._megaLinkItems || []).find(entry => entry.id === postId);
        const lastProvId = item?._lastBypassProviderId || this._lastBypassProviderId;
        if (lastProvId) {
            this._markBypassProviderCooldown(lastProvId, 3);
        }
        await this.openMegaLinkWithHandoff(postId, btn, true, overrideUrl);
    }

    async openMegaLinkWithHandoff(postId, btn = null, viaBypassCity = false, overrideUrl = '') {
        let item = (this._megaLinkItems || []).find(entry => entry.id === postId);
        if (!item) return;

        // Otvoríme okno synchrónne v kliknutí, aby ho prehliadač nezablokoval ako popup.
        const popupFeatures = 'popup=yes,width=980,height=760,menubar=no,toolbar=no,location=yes,status=no,resizable=yes,scrollbars=yes';
        const win = viaBypassCity
            ? window.open('about:blank', 'nexusBypassCityPopup', popupFeatures)
            : window.open('about:blank', '_blank');
        try { if (win) win.opener = null; } catch (_) {}
        if (viaBypassCity) this._bypassPopupWin = win || null;
        if (btn) btn.disabled = true;

        try {
            let resolvedOverride = overrideUrl || '';
            // 1. Ak odkaz ešte nebol rozbalený, skúsime rýchly server-side resolve (vrátane dynamic?r= base64, cache a rentry.org/raw).
            if (overrideUrl || (item.link_kind === 'external' && (!item.final_url || item.final_url === item.raw_url))) {
                this.setActivity('Rozbaľujem odkaz…', item.title || item.domain || `#${postId}`, 'working');
                try {
                    const resolveUrl = overrideUrl
                        ? `/api/v1/telegram/links/${postId}/resolve?alt_url=${encodeURIComponent(overrideUrl)}`
                        : `/api/v1/telegram/links/${postId}/resolve`;
                    const resResolve = await fetch(resolveUrl, { method: 'POST' });
                    const dataResolve = await resResolve.json().catch(() => ({}));
                    if (resResolve.ok) {
                        if (dataResolve.resolved_target_url) {
                            resolvedOverride = dataResolve.resolved_target_url;
                        }
                        if (dataResolve.item) {
                            item = dataResolve.item;
                            this._replaceMegaLinkItem(item);
                        }
                    }
                } catch (_) {}
            }

            // Ak sa z resolve vykľulo viac MEGA priečinkov (napr. z rentry.org) alebo media linky bez nutnosti brány, zatvoríme okno!
            const discoveredMegas = Array.isArray(item.discovered_mega_urls) ? item.discovered_mega_urls : [];
            const discoveredMedias = Array.isArray(item.discovered_media_urls) ? item.discovered_media_urls : [];
            if (discoveredMegas.length > 1) {
                try { win?.close(); } catch (_) {}
                this._bypassPopupWin = null;
                item._harvestOpen = true;
                item._verifyState = 'verified';
                item._verifyMessage = `📦 Rozbalené priamo bez brány: ${discoveredMegas.length} MEGA priečinkov${discoveredMedias.length ? ` + ${discoveredMedias.length} media` : ''}!`;
                this._refreshMegaLinkCard(postId);
                this._showSuccessToast(`Vyťažených ${discoveredMegas.length} MEGA priečinkov priamo bez bypasseru!`);
                return;
            }
            if (item.resolved_mega_url) {
                try { win?.close(); } catch (_) {}
                this._bypassPopupWin = null;
                await this.sendMegaLinkPostToHub(postId, btn);
                this._showSuccessToast('MEGA link úspešne extrahovaný!');
                return;
            }
            if (!viaBypassCity && discoveredMedias.length > 0 && !overrideUrl) {
                try { win?.close(); } catch (_) {}
                this._bypassPopupWin = null;
                item._harvestOpen = true;
                item._verifyState = 'verified';
                item._verifyMessage = `🟣 Nájdených ${discoveredMedias.length} media odkazov (Bunkr/Gofile/Pixeldrain…)`;
                this._refreshMegaLinkCard(postId);
                return;
            }

            const targetUrl = resolvedOverride || item.final_url || item.raw_url;
            // 2. Skopírujeme rozbalenú URL (napr. speedy-links.com) rovno do schránky.
            try {
                if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                    await navigator.clipboard.writeText(targetUrl);
                }
            } catch (_) {}

            // 3. Zaregistrujeme handoff na serveri, aby userscript automaticky spároval výsledné MEGA aj media linky.
            const response = await fetch(`/api/v1/telegram/links/${postId}/handoff`, { method: 'POST' });
            const data = await response.json().catch(() => ({}));
            if (response.ok && data.item) {
                item = data.item;
                this._replaceMegaLinkItem(item);
            }

            let provider = null;
            let browserUrl = targetUrl;
            if (viaBypassCity) {
                provider = this._pickBypassProvider({ advance: true });
                this._lastBypassProviderId = provider.id;
                item._lastBypassProviderId = provider.id;
                browserUrl = this._buildBypassUrl(provider, targetUrl);
            }

            if (win) {
                win.location.replace(browserUrl);
                try { win.focus(); } catch (_) {}
            } else if (viaBypassCity) {
                window.open(browserUrl, 'nexusBypassCityPopup', popupFeatures);
            } else {
                window.open(browserUrl, '_blank', 'noopener');
            }

            const providerName = provider ? provider.name : 'prehliadač';
            const waitMsg = item.keyless_mega_url
                ? `Otvorené cez ${providerName} — userscript v1.6 zachytí kľúč a spojí ho s MEGA priečinkom (ak narazíš na cooldown, klikni „↻ Iný provider“).`
                : `Otvorené cez ${providerName} (URL skopírovaná) — userscript v1.6 zachytí všetky MEGA aj Bunkr/Gofile linky zo stránky. Ak zlyhá, klikni „↻ Iný provider“.`;
            item._verifyState = 'checking';
            item._verifyMessage = waitMsg;
            this._refreshMegaLinkCard(postId);

            this.setActivity(
                viaBypassCity ? `${providerName} okno otvorené` : 'Odkaz otvorený + skopírovaný',
                waitMsg,
                'working'
            );
            this._startMegaHandoffPolling(postId, viaBypassCity);
        } catch (error) {
            try { win?.close(); } catch (_) {}
            this._bypassPopupWin = null;
            this.setActivity('Chyba handoffu', error.message || String(error), 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    // --- Harvester akcie: vloženie viacerých linkov / rentry, hromadné MEGA do Hubu, media do Testera/Intake ---
    async harvestLinksForPost(postId, btn = null, prefillText = '') {
        let rawText = String(prefillText || '').trim();
        if (!rawText) {
            let clipHint = '';
            try {
                if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
                    const clip = (await navigator.clipboard.readText() || '').trim();
                    if (/https?:\/\/|mega\.(?:nz|co\.nz)|rentry\.|bunkr|gofile|pixeldrain/i.test(clip)) {
                        clipHint = clip;
                    }
                }
            } catch (_) {}
            const entered = window.prompt(
                'Vlož rentry.org / pastebin URL, link-to.net/dynamic?r=... alebo jeden či viacero MEGA / Bunkr / Gofile / Pixeldrain odkazov:',
                clipHint
            );
            if (!entered || !entered.trim()) return;
            rawText = entered.trim();
        }
        if (btn) btn.disabled = true;
        const item = (this._megaLinkItems || []).find(entry => entry.id === postId);
        if (item) {
            item._verifyState = 'checking';
            item._verifyMessage = 'Vyťažujem a overujem vložené odkazy…';
            this._refreshMegaLinkCard(postId);
        }
        this.setActivity('Vyťažujem odkazy…', item?.title || `#${postId}`, 'working');
        try {
            const response = await fetch(`/api/v1/telegram/links/${postId}/harvest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ raw_text: rawText, verify: true }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.detail || `Vyťaženie zlyhalo (${response.status})`);
            if (data.item) {
                data.item._harvestOpen = true;
                const s = data.summary || data.item.harvest_summary || {};
                data.item._verifyState = 'verified';
                data.item._verifyMessage = `📦 Vyťažené: ${s.mega_alive || 0}/${s.mega_total || 0} živých MEGA${s.media_total ? ` · ${s.media_total} media` : ''}`;
                this._replaceMegaLinkItem(data.item);
                this.openMegaHarvestInspector(data.item.id);
            }
            this._showSuccessToast('Odkazy úspešne vyťažené a overené!');
            this.setActivity('Vyťaženie dokončené', data.item?._verifyMessage || 'Hotovo', 'done');
        } catch (error) {
            if (item) {
                item._verifyState = 'error';
                item._verifyMessage = `⚠️ ${error.message || error}`;
                this._refreshMegaLinkCard(postId);
            }
            this.setActivity('Chyba vyťaženia', error.message || String(error), 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async sendAllDiscoveredMegaToHub(postId, btn = null, onlySelected = false) {
        const item = (this._megaLinkItems || []).find(entry => entry.id === postId);
        if (!item) return;
        const inspector = document.getElementById('megaHarvestInspector');
        const inspectorMatch = inspector && !inspector.hidden && Number(inspector.dataset.postId) === Number(postId) ? inspector : null;
        const card = document.querySelector(`.mega-link-card[data-link-post-id="${postId}"]`);
        const scope = inspectorMatch || card;
        let urls = [];
        if (onlySelected && scope) {
            urls = [...scope.querySelectorAll('.mega-harvest-mega-cb:checked')].map(el => el.dataset.megaUrl).filter(Boolean);
        } else {
            urls = (item.discovered_mega_urls || [])
                .filter(m => ['available', 'unchecked', 'retry', ''].includes(m.status || '') && !m.hub_entry_id)
                .map(m => m.url);
        }
        if (!urls.length) {
            this.setActivity('Žiadne MEGA na odoslanie', 'Vyber aspoň jeden živý priečinok, ktorý ešte nie je v Hube.', 'info');
            return;
        }
        if (btn) btn.disabled = true;
        item._verifyState = 'checking';
        item._verifyMessage = `⏳ Posielam ${urls.length} MEGA priečinkov do Hubu…`;
        this._refreshMegaLinkCard(postId);
        try {
            const res = await fetch(`/api/v1/telegram/links/${postId}/send-all-mega`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mega_urls: urls }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || `Hromadné odoslanie zlyhalo (${res.status})`);
            if (data.item) {
                data.item._harvestOpen = true;
                data.item._verifyState = 'verified';
                data.item._verifyMessage = `✅ Do MEGA Hubu: +${data.added || 0} nových${data.exists ? ` · ${data.exists} už v Hube` : ''}${data.failed ? ` · ${data.failed} zlyhalo` : ''}`;
                this._replaceMegaLinkItem(data.item);
            }
            window.nexusMegaHub?.reload?.();
            this._showSuccessToast(`MEGA Hub: pridaných ${data.added || 0} priečinkov!`);
            this.setActivity('MEGA priečinky uložené', data.item?._verifyMessage || 'Hotovo', 'done');
        } catch (error) {
            item._verifyState = 'error';
            item._verifyMessage = `⚠️ ${error.message || error}`;
            this._refreshMegaLinkCard(postId);
            this.setActivity('Chyba odoslania', error.message || String(error), 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async sendSingleDiscoveredMegaToHub(postId, megaUrl, btn = null) {
        if (!megaUrl) return;
        if (btn) btn.disabled = true;
        try {
            const res = await fetch(`/api/v1/telegram/links/${postId}/send-all-mega`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mega_urls: [megaUrl] }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || `Chyba (${res.status})`);
            if (data.item) {
                data.item._harvestOpen = true;
                this._replaceMegaLinkItem(data.item);
            }
            window.nexusMegaHub?.reload?.();
            this._showSuccessToast('MEGA priečinok uložený do Hubu.');
        } catch (error) {
            this.setActivity('Chyba odoslania', error.message || String(error), 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    openMediaInTester(url) {
        if (!url) return;
        window.open(`/tester?url=${encodeURIComponent(url)}`, '_blank', 'noopener');
    }

    async sendDiscoveredMediaToIntake(postId, mediaUrls = [], btn = null) {
        if (btn) btn.disabled = true;
        this.setActivity('Importujem odkazy…', `${mediaUrls.length || 'všetky'} media odkazov`, 'working');
        try {
            const res = await fetch(`/api/v1/telegram/links/${postId}/send-media-intake`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ media_urls: mediaUrls }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || `Import odkazov zlyhal (${res.status})`);
            this._showSuccessToast(`Zaradených ${data.imported || 0} media odkazov na import do knižnice!`);
            this.setActivity('Zaradené na import', `Spustený import pre ${data.imported || 0} odkazov.`, 'done');
        } catch (error) {
            this.setActivity('Chyba importu', error.message || String(error), 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    // --- Pravý slide-over Harvester Inspector (namiesto nafukujúceho sa <details> v karte) ---
    openMegaHarvestInspector(postId) {
        const item = (this._megaLinkItems || []).find(entry => entry.id === Number(postId));
        if (!item) return;
        this._harvestInspectorPostId = item.id;
        const backdrop = document.getElementById('megaHarvestInspectorBackdrop');
        const drawer = document.getElementById('megaHarvestInspector');
        if (!drawer) return;
        if (backdrop) backdrop.hidden = false;
        drawer.hidden = false;
        this.renderMegaHarvestInspector(item.id);
        requestAnimationFrame(() => drawer.classList.add('is-open'));
        if (!this._harvestInspectorEscBound) {
            this._harvestInspectorEscBound = (event) => {
                if (event.key === 'Escape' && this._harvestInspectorPostId != null) {
                    event.stopPropagation();
                    this.closeMegaHarvestInspector();
                }
            };
            document.addEventListener('keydown', this._harvestInspectorEscBound);
        }
    }

    closeMegaHarvestInspector() {
        this._harvestInspectorPostId = null;
        const backdrop = document.getElementById('megaHarvestInspectorBackdrop');
        const drawer = document.getElementById('megaHarvestInspector');
        if (drawer) {
            drawer.classList.remove('is-open');
            drawer.hidden = true;
            drawer.dataset.postId = '';
        }
        if (backdrop) backdrop.hidden = true;
    }

    renderMegaHarvestInspector(postId) {
        const drawer = document.getElementById('megaHarvestInspector');
        if (!drawer) return;
        const item = (this._megaLinkItems || []).find(entry => entry.id === Number(postId));
        if (!item) {
            this.closeMegaHarvestInspector();
            return;
        }
        drawer.dataset.postId = String(item.id);

        const discoveredMegas = Array.isArray(item.discovered_mega_urls) ? item.discovered_mega_urls : [];
        const discoveredMedias = Array.isArray(item.discovered_media_urls) ? item.discovered_media_urls : [];
        const discoveredContainers = Array.isArray(item.discovered_containers) ? item.discovered_containers : [];
        const readyToSendMegas = discoveredMegas.filter(m => !m.hub_entry_id && !['unavailable', 'dead', 'empty', 'invalid'].includes(m.status || ''));
        const aliveCount = discoveredMegas.filter(m => m.status === 'available' || m.status === 'in_hub' || m.hub_entry_id).length;

        const title = this.escapeHtml(item.title || `Príspevok #${item.id}`);
        const channel = this.escapeHtml(item.channel_title || item.channel || 'Telegram');

        const megaRowsHtml = discoveredMegas.length ? `
            <section class="mega-harvest-section">
                <div class="mega-harvest-section-head">
                    <span><span class="material-icons-round mega-inline-ico is-emerald" aria-hidden="true">cloud_done</span>MEGA priečinky (${aliveCount}/${discoveredMegas.length})</span>
                    <div class="mega-harvest-mini-actions">
                        ${readyToSendMegas.length ? `<button type="button" class="mega-mini-btn is-accent" onclick="quantumSearch.sendAllDiscoveredMegaToHub(${item.id}, this, false)" title="Jedným klikom pošle všetky živé MEGA priečinky do Hubu"><span class="material-icons-round mega-inline-ico" aria-hidden="true">playlist_add_check</span>Všetky živé do Hubu (${readyToSendMegas.length})</button>` : ''}
                        ${readyToSendMegas.length ? `<button type="button" class="mega-mini-btn" onclick="quantumSearch.sendAllDiscoveredMegaToHub(${item.id}, this, true)" title="Pošle len zaškrtnuté priečinky do MEGA Hubu">Vybrané</button>` : ''}
                        <button type="button" class="mega-mini-btn" onclick="quantumSearch.copyDiscoveredLinks(${item.id}, 'alive_mega')" title="Skopíruje živé MEGA linky"><span class="material-icons-round mega-inline-ico" aria-hidden="true">content_copy</span>Kopírovať</button>
                    </div>
                </div>
                <div class="mega-harvest-list">
                    ${discoveredMegas.map((m, idx) => {
                        const mst = m.status || 'unchecked';
                        const isInHub = mst === 'in_hub' || Boolean(m.hub_entry_id);
                        const isAlive = mst === 'available';
                        const isDead = ['unavailable', 'dead', 'empty', 'invalid'].includes(mst);
                        const badge = isInHub ? 'V Hube'
                            : isAlive ? this._formatMegaVideoCount(m.video_count || 0)
                            : mst === 'empty' ? '0 videí'
                            : isDead ? 'Mŕtvy'
                            : 'Neoverené';
                        const mTitle = this.escapeHtml(m.title || `MEGA #${idx + 1}`);
                        const mUrlEsc = this.escapeHtml(m.url);
                        return `
                            <div class="mega-harvest-row is-${isInHub ? 'hub' : (isAlive ? 'alive' : (isDead ? 'dead' : 'pending'))}">
                                ${(!isInHub && !isDead) ? `<input type="checkbox" class="mega-harvest-mega-cb" data-mega-url="${mUrlEsc}" ${isAlive ? 'checked' : ''}>` : '<span class="mega-harvest-dot"></span>'}
                                <span class="mega-harvest-name" title="${mUrlEsc}">${mTitle}</span>
                                <span class="mega-harvest-state">${badge}</span>
                                ${isInHub && m.hub_entry_id
                                    ? `<button type="button" class="mega-mini-btn" onclick="quantumSearch.openMegaHubEntry(${m.hub_entry_id})">Hub ↗</button>`
                                    : (!isDead ? `<button type="button" class="mega-mini-btn is-accent" data-mega-url="${mUrlEsc}" onclick="quantumSearch.sendSingleDiscoveredMegaToHub(${item.id}, this.dataset.megaUrl, this)">+ Hub</button>` : '')}
                            </div>`;
                    }).join('')}
                </div>
            </section>` : '';

        const mediaRowsHtml = discoveredMedias.length ? `
            <section class="mega-harvest-section">
                <div class="mega-harvest-section-head">
                    <span><span class="material-icons-round mega-inline-ico is-violet" aria-hidden="true">perm_media</span>Bunkr / Gofile / Pixeldrain a ďalšie (${discoveredMedias.length})</span>
                    <div class="mega-harvest-mini-actions">
                        <button type="button" class="mega-mini-btn is-accent" onclick="quantumSearch.sendDiscoveredMediaToIntake(${item.id}, [], this)" title="Zaradí všetky nájdené media odkazy na import do knižnice"><span class="material-icons-round mega-inline-ico" aria-hidden="true">move_to_inbox</span>Importovať všetky</button>
                        <button type="button" class="mega-mini-btn" onclick="quantumSearch.copyDiscoveredLinks(${item.id}, 'media')" title="Skopíruje všetky media odkazy"><span class="material-icons-round mega-inline-ico" aria-hidden="true">content_copy</span>Kopírovať</button>
                    </div>
                </div>
                <div class="mega-harvest-list">
                    ${discoveredMedias.map(med => {
                        const medUrlEsc = this.escapeHtml(med.url);
                        const hostLabel = this.escapeHtml(med.label || med.host || 'Media');
                        const shortPath = this.escapeHtml(med.url.replace(/^https?:\/\/(?:www\.)?/i, '').slice(0, 44));
                        return `
                            <div class="mega-harvest-row is-media">
                                <span class="mega-media-pill is-${this.escapeHtml(med.host || 'ext')}">${hostLabel}</span>
                                <span class="mega-harvest-name" title="${medUrlEsc}">${shortPath}</span>
                                <button type="button" class="mega-mini-btn is-tester" data-media-url="${medUrlEsc}" onclick="quantumSearch.openMediaInTester(this.dataset.mediaUrl)" title="Otvoriť v Nexus Link Testeri">Link Tester</button>
                                <button type="button" class="mega-mini-btn" data-media-url="${medUrlEsc}" onclick="quantumSearch.sendDiscoveredMediaToIntake(${item.id}, [this.dataset.mediaUrl], this)" title="Importovať do knižnice">Importovať</button>
                                <button type="button" class="mega-mini-btn" data-media-url="${medUrlEsc}" onclick="navigator.clipboard?.writeText(this.dataset.mediaUrl).then(() => quantumSearch._showSuccessToast('Odkaz skopírovaný do schránky.', 2000))" title="Kopírovať odkaz"><span class="material-icons-round mega-inline-ico" aria-hidden="true">content_copy</span></button>
                                <button type="button" class="mega-mini-btn" data-media-url="${medUrlEsc}" onclick="window.open(this.dataset.mediaUrl, '_blank', 'noopener')" title="Otvoriť v novom tabe">↗</button>
                            </div>`;
                    }).join('')}
                </div>
            </section>` : '';

        const containerRowsHtml = discoveredContainers.length ? `
            <section class="mega-harvest-section">
                <div class="mega-harvest-section-head">
                    <span><span class="material-icons-round mega-inline-ico is-sky" aria-hidden="true">description</span>Paste zdroje (${discoveredContainers.length})</span>
                </div>
                <div class="mega-harvest-containers">
                    ${discoveredContainers.map(c => {
                        const cUrlEsc = this.escapeHtml(c.url);
                        return `<span class="mega-container-chip">
                            <a href="${cUrlEsc}" target="_blank" rel="noopener noreferrer" title="${cUrlEsc}"><span class="material-icons-round mega-inline-ico" aria-hidden="true">description</span>${this.escapeHtml(c.domain || 'paste')} ↗</a>
                            <button type="button" class="mega-mini-btn" data-cont-url="${cUrlEsc}" onclick="quantumSearch.harvestLinksForPost(${item.id}, this, this.dataset.contUrl)" title="Znovu stiahnuť a vyťažiť všetky linky z tejto paste stránky"><span class="material-icons-round mega-inline-ico" aria-hidden="true">refresh</span></button>
                        </span>`;
                    }).join('')}
                </div>
            </section>` : '';

        drawer.innerHTML = `
            <div class="mega-inspector-header">
                <div class="mega-inspector-title-wrap">
                    <span class="mega-inspector-eyebrow"><span class="material-icons-round mega-inline-ico is-violet" aria-hidden="true">inventory_2</span>Harvester Inspector · ${channel}</span>
                    <h3 class="mega-inspector-title" title="${title}">${title}</h3>
                </div>
                <div class="mega-inspector-header-actions">
                    <button type="button" class="quantum-btn" onclick="quantumSearch.harvestLinksForPost(${item.id}, this)" title="Vložiť a vyťažiť ďalšie odkazy z rentry/pastebin/MEGA">
                        <span class="material-icons-round" aria-hidden="true">add_link</span><span>Vyťažiť ďalšie</span>
                    </button>
                    <button type="button" class="quantum-btn" onclick="quantumSearch.closeMegaHarvestInspector()" aria-label="Zavrieť Harvester Inspector">
                        <span class="material-icons-round" aria-hidden="true">close</span>
                    </button>
                </div>
            </div>
            <div class="mega-inspector-body">
                ${item._verifyMessage ? `<div class="mega-link-verify-status is-${this.escapeHtml(item._verifyState || 'info')}" role="status">${this.escapeHtml(item._verifyMessage)}</div>` : ''}
                ${megaRowsHtml}
                ${mediaRowsHtml}
                ${containerRowsHtml}
                ${(!megaRowsHtml && !mediaRowsHtml && !containerRowsHtml) ? '<div class="mega-inspector-empty">Pre tento príspevok zatiaľ neboli vyťažené žiadne hromadné odkazy.</div>' : ''}
            </div>`;
    }

    async copyDiscoveredLinks(postId, kind = 'all') {
        const item = (this._megaLinkItems || []).find(entry => entry.id === postId);
        if (!item) return;
        const megas = (item.discovered_mega_urls || [])
            .filter(m => kind !== 'alive_mega' || ['available', 'in_hub'].includes(m.status || ''))
            .map(m => m.url);
        const medias = (item.discovered_media_urls || []).map(m => m.url);
        const lines = kind === 'media' ? medias : (kind === 'alive_mega' ? megas : [...megas, ...medias]);
        if (!lines.length) return;
        try {
            await navigator.clipboard.writeText(lines.join('\n'));
            this._showSuccessToast(`Skopírovaných ${lines.length} odkazov do schránky.`);
        } catch (_) {
            window.prompt('Skopíruj odkazy:', lines.join('\n'));
        }
    }

    async resolveMegaLinkPost(postId, btn) {
        if (btn) btn.disabled = true;
        this.setActivity('Rozbaľujem presmerovanie', 'Kontrolujem priame HTTP presmerovanie…', 'working');
        try {
            const response = await fetch(`/api/v1/telegram/links/${postId}/resolve`, { method: 'POST' });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.detail || `Rozbalenie zlyhalo (${response.status})`);
            if (data.item) this._replaceMegaLinkItem(data.item);

            if (data.item?.resolved_mega_url) {
                const countInfo = data.item.mega_video_count ? ` (${data.item.mega_video_count} videí)` : '';
                const stateNote = data.mega_status === 'unavailable' ? ' · odkaz je zmazaný' : countInfo;
                this.setActivity('MEGA odkaz nájdený', `Rozbalené${stateNote}.`, data.mega_status === 'unavailable' ? 'error' : 'done');
            } else {
                this.setActivity('Medzičlánok s bránou', 'Cieľ nepoužíva priamy 302 redirect. Použi „Otvoriť link ↗“ alebo „Vložiť MEGA“.', 'info');
            }
        } catch (error) {
            this.setActivity('Chyba rozbalenia', error.message || String(error), 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    _formatMegaVideoCount(count) {
        const n = Number(count) || 0;
        if (n === 1) return '1 video';
        if (n >= 2 && n <= 4) return `${n} videá`;
        return `${n} videí`;
    }

    _refreshMegaLinkCard(postId) {
        const item = (this._megaLinkItems || []).find(entry => entry.id === postId);
        if (!item) return;
        const container = document.getElementById('quantumSearchResults');
        const existing = container?.querySelector(`.mega-link-card[data-link-post-id="${postId}"]`);
        if (existing) {
            existing.outerHTML = this._renderMegaLinkCardHtml(item);
        } else {
            this.renderMegaLinkPosts();
        }
    }

    async checkMegaLinkPost(postId, btn) {
        const item = (this._megaLinkItems || []).find(entry => entry.id === postId);
        if (!item) return;
        if (item._verifyState === 'checking') return;

        const megaUrl = item.resolved_mega_url || item.raw_url || '';
        if (!megaUrl) {
            item._verifyState = 'error';
            item._verifyMessage = 'Chýba MEGA odkaz na overenie.';
            this._refreshMegaLinkCard(postId);
            this.setActivity('Chyba overenia', item._verifyMessage, 'error');
            return;
        }

        if (btn) btn.disabled = true;
        item._verifyState = 'checking';
        item._verifyMessage = 'Overujem dostupnosť a počet videí na MEGA…';
        this.setActivity('Overujem MEGA odkaz', item.title || megaUrl, 'working');
        this._refreshMegaLinkCard(postId);

        try {
            const response = await fetch('/api/v1/mega/hub/check', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: megaUrl }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.detail || `Overenie zlyhalo (HTTP ${response.status})`);

            if (data.status === 'available') {
                const count = Number(data.count) || 0;
                item.mega_video_count = count;
                item._verifyState = 'verified';
                item._verifyMessage = `✅ Overené · odkaz je živý (${this._formatMegaVideoCount(count)})`;
                this.setActivity(
                    'Overené — odkaz je živý',
                    `${item.title || 'MEGA priečinok'} · ${this._formatMegaVideoCount(count)}`,
                    'done'
                );
            } else if (data.status === 'unavailable') {
                const reason = data.reason || 'Priečinok alebo súbor už na MEGA neexistuje.';
                item._verifyState = 'dead';
                item._verifyMessage = `❌ Neoverené (mŕtvy) · ${reason}`;
                try {
                    const stRes = await fetch(`/api/v1/telegram/links/${postId}/status`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status: 'dead' }),
                    });
                    if (stRes.ok) {
                        const stData = await stRes.json().catch(() => ({}));
                        if (stData.item) {
                            Object.assign(item, stData.item);
                        } else {
                            item.status = 'dead';
                        }
                    }
                } catch (_) {
                    item.status = 'dead';
                }
                this.setActivity('Neoverené — odkaz je mŕtvy', reason, 'error');
            } else if (data.status === 'empty') {
                const reason = data.reason || 'Priečinok je živý, ale neobsahuje žiadne videá (0 videí).';
                item.mega_video_count = 0;
                item._verifyState = 'warning';
                item._verifyMessage = `⚠️ Overené (0 videí) · ${reason}`;
                this.setActivity('Overené — bez videí', reason, 'info');
            } else if (data.status === 'open_in_mega') {
                const reason = data.reason || 'Obsah je chránený alebo nečitateľný cez API — otvor odkaz priamo v MEGA.';
                item._verifyState = 'warning';
                item._verifyMessage = `⚠️ Neoverené cez API · ${reason}`;
                this.setActivity('Vyžaduje overenie v MEGA', reason, 'info');
            } else {
                const reason = data.reason || 'MEGA API dočasne neodpovedalo alebo vypršal limit. Skús znova.';
                item._verifyState = 'error';
                item._verifyMessage = `⚠️ Neoverené · ${reason}`;
                this.setActivity('Overenie sa nepodarilo', reason, 'error');
            }
        } catch (error) {
            const reason = error?.message || String(error) || 'Neznáma chyba pri overovaní.';
            item._verifyState = 'error';
            item._verifyMessage = `❌ Neoverené · ${reason}`;
            this.setActivity('Chyba overenia', reason, 'error');
        } finally {
            this._refreshMegaLinkCard(postId);
        }
    }

    async sendMegaLinkPostToHub(postId, btn, manualMegaUrl = '') {
        if (btn) btn.disabled = true;
        this.setActivity('Odosielam do MEGA Hubu', 'Overujem a ukladám priečinok…', 'working');
        try {
            const response = await fetch(`/api/v1/telegram/links/${postId}/send-to-hub`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mega_url: manualMegaUrl || null }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.detail || `Odoslanie zlyhalo (${response.status})`);
            if (data.item) this._replaceMegaLinkItem(data.item);

            if (data.entry) {
                window.nexusMegaHub?.reload?.();
                const statusWord = data.status === 'exists' ? 'už bol v MEGA Hube' : 'pridaný do MEGA Hubu';
                this.setActivity('Uložené v MEGA Hube', `„${data.entry.title}“ (${data.entry.count} videí) ${statusWord}.`, 'done');
            } else {
                this.setActivity('Odkaz nie je dostupný', `Stav: ${data.status || 'nedostupný'}`, 'error');
            }
        } catch (error) {
            this.setActivity('Chyba odoslania do Hubu', error.message || String(error), 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async promptManualMegaForPost(postId, btn) {
        const pasted = window.prompt('Vlož výsledný mega.nz odkaz (vrátane #kľúča):');
        if (!pasted || !pasted.trim()) return;
        await this.sendMegaLinkPostToHub(postId, btn, pasted.trim());
    }

    async setMegaLinkPostStatus(postId, status) {
        try {
            const response = await fetch(`/api/v1/telegram/links/${postId}/status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.detail || `Zmena stavu zlyhala (${response.status})`);
            const filterStatus = this._megaLinksFilter?.status || 'active';
            const shouldHide =
                (filterStatus === 'active' && (status === 'dead' || status === 'skipped'))
                || (filterStatus !== 'all' && filterStatus !== 'active' && filterStatus !== status);
            if (shouldHide) {
                this._megaLinkItems = (this._megaLinkItems || []).filter(item => item.id !== postId);
                this._megaLinksTotal = Math.max(0, (this._megaLinksTotal || 1) - 1);
                this.renderMegaLinkPosts();
            } else if (data.item) {
                this._replaceMegaLinkItem(data.item);
            }
        } catch (error) {
            this.setActivity('Chyba zmeny stavu', error.message || String(error), 'error');
        }
    }

    async sendDirectMegaUrlToHub(url, title, btn) {
        if (!url) return;
        if (btn) btn.disabled = true;
        this.setActivity('Odosielam do MEGA Hubu', title || url, 'working');
        try {
            const response = await fetch('/api/v1/mega/hub/entries', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, title_override: (title || '').slice(0, 200) || null }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.detail || `Chyba Hubu (${response.status})`);
            if (data.entry) {
                window.nexusMegaHub?.reload?.();
                if (btn) {
                    btn.classList.add('is-in-hub');
                    btn.innerHTML = '<span class="material-icons-round" style="font-size:14px;">folder_open</span> V Hube';
                    btn.onclick = event => { event.stopPropagation(); this.openMegaHubEntry(data.entry.id); };
                }
                this.setActivity('MEGA priečinok uložený', `„${data.entry.title}“ (${data.entry.count} videí)`, 'done');
            } else {
                this.setActivity('MEGA odkaz nedostupný', `Stav: ${data.status || 'nedostupný'}`, 'error');
            }
        } catch (error) {
            this.setActivity('Chyba MEGA Hubu', error.message || String(error), 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    renderMegaLinkPosts() {
        const container = document.getElementById('quantumSearchResults');
        const stats = document.getElementById('quantumSearchStats');
        const countEl = document.getElementById('quantumResultCount');
        const statusEl = document.getElementById('quantumMegaPacksStatus');
        const moreBtn = document.getElementById('megaLinksLoadMoreBtn');
        if (!container) return;
        container.classList?.add('is-mega-links-mode');

        const items = this._megaLinkItems || [];
        const total = Number(this._megaLinksTotal) || items.length;
        const counts = this._megaLinksCounts;
        this._updateBypassToolbarBtn();
        this._updatePriorityChannelsUI();

        if (stats) stats.style.display = 'flex';
        if (countEl) countEl.textContent = items.length < total ? `${items.length} / ${total}` : String(items.length);
        if (moreBtn) moreBtn.hidden = !this._megaLinksHasMore;
        if (statusEl) {
            statusEl.textContent = counts
                ? `Zobrazených ${items.length} z ${total} · Aktívnych: ${counts.active} · Priamych MEGA: ${counts.mega} · Paste/Bez brány: ${counts.paste || 0} · V Hube: ${counts.in_hub}`
                : `Zobrazených ${items.length} príspevkov.`;
        }

        if (!items.length) {
            container.innerHTML = `
                <div class="quantum-search-empty" style="grid-column:1/-1;">
                    <div class="quantum-search-empty-icon">📦</div>
                    <div class="quantum-search-empty-text">
                        Zatiaľ tu nie sú žiadne uložené MEGA ani link príspevky.<br>
                        <small style="opacity:0.7;">Načítaj existujúce MEGA odkazy z video databázy alebo spusti živý sken Telegramu.</small>
                    </div>
                    <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:14px;">
                        <button type="button" class="quantum-btn primary" onclick="quantumSearch.scanTelegramLinksLive()">⚡ Skenovať Telegram (Linky)</button>
                        <button type="button" class="quantum-btn" onclick="quantumSearch.seedTelegramLinksFromDb()">📥 Načítať z video DB</button>
                    </div>
                </div>`;
            return;
        }

        const remaining = Math.max(0, total - items.length);
        const footerHtml = `<div id="megaLinksFooter" class="mega-links-footer" ${this._megaLinksHasMore && remaining > 0 ? '' : 'hidden'}>
            ${this._megaLinksHasMore && remaining > 0 ? `<button type="button" class="quantum-btn primary" onclick="quantumSearch.loadMegaLinkPosts(quantumSearch._lastMegaLinksQuery || '', true)">⬇ Načítať ďalšie (zostáva ${remaining})</button>` : ''}
        </div>`;
        container.innerHTML = items.map(item => this._renderMegaLinkCardHtml(item)).join('') + footerHtml;
        if (this._directMegaResults) this._renderDirectMegaWebPanel();

        // Automatické dočítavanie pri skrolovaní dole (infinite scroll)
        if (this._megaScrollObserver) {
            try { this._megaScrollObserver.disconnect(); } catch (_) {}
            this._megaScrollObserver = null;
        }
        const footerEl = document.getElementById('megaLinksFooter');
        if (footerEl && typeof IntersectionObserver !== 'undefined') {
            this._megaScrollObserver = new IntersectionObserver(entries => {
                if (entries.some(e => e.isIntersecting) && this.megaPacksMode && this._megaLinksHasMore && !this._megaLoadingMore) {
                    this.loadMegaLinkPosts(this._lastMegaLinksQuery || '', true);
                }
            }, { rootMargin: '320px' });
            this._megaScrollObserver.observe(footerEl);
        }
    }

    _renderMegaLinkCardHtml(item) {
        const statusBadgeMap = {
            new: { label: 'Nové', cls: 'is-new' },
            opened: { label: '⏳ Otvorené', cls: 'is-opened' },
            in_hub: { label: '✅ V MEGA Hube', cls: 'is-in-hub' },
            dead: { label: '❌ Mŕtvy', cls: 'is-dead' },
            skipped: { label: 'Preskočené', cls: 'is-dead' },
        };

        const title = this.escapeHtml(item.title || item.channel_title || `Príspevok #${item.message_id}`);
        const channel = this.escapeHtml(item.channel_title || item.channel || 'Telegram');
        const dateStr = item.date ? this.escapeHtml(String(item.date).slice(0, 10)) : '';
        const domain = this.escapeHtml(item.domain || 'odkaz');
        const isMega = item.link_kind === 'direct_mega' || item.link_kind === 'resolved_mega';
        const isSplitMega = !isMega && Boolean(item.keyless_mega_url);
        const discoveredMegas = Array.isArray(item.discovered_mega_urls) ? item.discovered_mega_urls : [];
        const discoveredMedias = Array.isArray(item.discovered_media_urls) ? item.discovered_media_urls : [];
        const discoveredContainers = Array.isArray(item.discovered_containers) ? item.discovered_containers : [];
        const harvest = item.harvest_summary || {
            mega_total: discoveredMegas.length,
            mega_alive: discoveredMegas.filter(m => ['available', 'in_hub'].includes(m.status || '')).length,
            mega_in_hub: discoveredMegas.filter(m => m.status === 'in_hub' || m.hub_entry_id).length,
            media_total: discoveredMedias.length,
            containers_total: discoveredContainers.length,
        };
        const isMultiMega = discoveredMegas.length > 1;
        const hasMediaOnly = !isMega && discoveredMedias.length > 0;
        const isPasteFree = !isMega && Boolean(item.is_paste_free);
        const kindLabel = isMultiMega ? `📦 ${discoveredMegas.length}× MEGA`
            : item.link_kind === 'direct_mega' ? '🟢 Priamy MEGA'
            : item.link_kind === 'resolved_mega' ? '🟢 Rozbalený MEGA'
            : isSplitMega ? '🔐 MEGA + kľúč'
            : hasMediaOnly ? `🟣 ${discoveredMedias.length}× Media`
            : isPasteFree ? `📄 ${domain}`
            : `🔗 ${domain}`;
        const kindCls = isMega ? 'is-mega' : (isPasteFree ? 'is-paste' : (isSplitMega || hasMediaOnly ? 'is-locked' : 'is-ext'));
        const extraLinksCount = Math.max(
            (Number(item.extracted_count) || 0) - 1,
            (Array.isArray(item.alt_urls) ? item.alt_urls.length : 0),
        );
        const multiLinkBadge = (discoveredMegas.length > 1 && discoveredMedias.length > 0)
            ? `<span class="mega-link-badge is-multi" title="Obsahuje viacero MEGA aj media odkazov">+${discoveredMedias.length} Media</span>`
            : (extraLinksCount > 0 ? `<span class="mega-link-badge is-multi" title="Príspevok obsahuje ${extraLinksCount + 1} odkazov">+${extraLinksCount} skryté</span>` : '');
        const st = statusBadgeMap[item.status] || statusBadgeMap.new;
        const thumb = item.thumbnail ? this.escapeHtml(item.thumbnail) : '';
        const countBadge = item.mega_video_count > 0
            ? `<span class="mega-link-badge is-count">🎬 ${item.mega_video_count}</span>` : '';
        const packSizeBadge = item.pack_size
            ? `<span class="mega-link-badge is-pack-size">💾 ${this.escapeHtml(item.pack_size)}</span>` : '';
        const videoPreviewBtn = item.has_video_preview
            ? `<button type="button" class="mega-video-preview-btn" onclick="event.stopPropagation(); quantumSearch.toggleMegaLinkVideoPreview(${item.id}, this)" title="Prehrať ukážkové video priamo na karte">▶ ${this.escapeHtml(item.video_duration || 'Ukážka')}</button>`
            : '';

        const tagsList = Array.isArray(item.tags) ? item.tags.slice(0, 6) : [];
        const tagsHtml = tagsList.length
            ? `<div class="mega-link-tags">${tagsList.map(t => `<button type="button" class="mega-tag-pill" data-tag="${this.escapeHtml(t)}" onclick="quantumSearch.filterMegaLinksByTag(this.dataset.tag)">#${this.escapeHtml(t)}</button>`).join('')}</div>`
            : '';

        const excerpt = this.escapeHtml(
            (item.caption || '')
                .replace(/https?:\/\/\S+/gi, '')
                .replace(/\b(?:www\.)?(?:mega\.(?:nz|co\.nz)|onlyshare\.info|speedy-links\.com|megadropz\.\w+|links2megas\.com|link-(?:to|center|hub|target)\.net|direct-link\.net)\S*/gi, '')
                .replace(/#[A-Za-z0-9_]+/g, '')
                .replace(/\s+/g, ' ')
                .trim()
        );

        const nextBypassProv = this._pickBypassProvider({ advance: false });
        const nextProvLabel = this.escapeHtml(nextBypassProv?.name || 'Bypass');
        const readyToSendMegas = discoveredMegas.filter(m => ['available', 'unchecked', 'retry', ''].includes(m.status || '') && !m.hub_entry_id);

        let primaryActions = '';
        if (item.status === 'in_hub' && item.mega_hub_entry_id && !readyToSendMegas.length) {
            primaryActions = `<button type="button" class="action-btn btn-mega-hub is-in-hub" onclick="quantumSearch.openMegaHubEntry(${item.mega_hub_entry_id})">📂 Otvoriť v Hube${harvest.mega_in_hub > 1 ? ` (${harvest.mega_in_hub})` : ''}</button>`;
        } else if (isMultiMega) {
            const busy = item._busy ? 'disabled' : '';
            const aliveToSend = discoveredMegas.filter(m => m.status === 'available' && !m.hub_entry_id).length;
            const sendCount = aliveToSend || readyToSendMegas.length;
            primaryActions = `
                ${sendCount > 0 ? `<button type="button" class="action-btn btn-mega-hub" ${busy} onclick="quantumSearch.sendAllDiscoveredMegaToHub(${item.id}, this, false)" title="Pošle všetky živé MEGA priečinky z tohto príspevku do MEGA Hubu">✨ Všetky živé do Hubu (${sendCount})</button>` : ''}
                <button type="button" class="action-btn btn-mega-verify" ${busy} onclick="quantumSearch.processMegaLinkPost(${item.id}, false)" title="Znovu overí dostupnosť všetkých MEGA priečinkov">${item._busy ? '⏳ Overujem…' : '🔍 Overiť všetky'}</button>`;
        } else if (isMega) {
            const verifyState = item._verifyState || '';
            const verifyBtnLabel = verifyState === 'checking' ? '⏳ Overujem…'
                : verifyState === 'verified' ? '✅ Overené'
                : verifyState === 'dead' ? '❌ Mŕtvy'
                : (verifyState === 'warning' || verifyState === 'error') ? '↻ Overiť znova'
                : '🔍 Overiť';
            const verifyTitle = verifyState === 'verified'
                ? 'Odkaz je overený — klikni pre opätovné overenie'
                : 'Overiť dostupnosť a počet videí';
            const verifyDisabled = verifyState === 'checking' ? 'disabled' : '';
            const verifyCls = verifyState ? `is-${this.escapeHtml(verifyState)}` : '';
            const busy = item._busy ? 'disabled' : '';
            primaryActions = `
                <button type="button" class="action-btn btn-mega-hub" ${busy} onclick="quantumSearch.processMegaLinkPost(${item.id}, true)" title="Overí album a pošle ho do MEGA Hubu">${item._busy ? '⏳ Spracúvam…' : '✨ Do Hubu'}</button>
                <button type="button" class="action-btn btn-mega-verify ${verifyCls}" ${verifyDisabled || busy} onclick="quantumSearch.processMegaLinkPost(${item.id}, false)" title="${verifyTitle}">${verifyBtnLabel}</button>`;
        } else if (isSplitMega) {
            const busy = item._busy ? 'disabled' : '';
            const aliveDone = Boolean(item._keylessAlive);
            primaryActions = `
                <button type="button" class="action-btn btn-bypass-city" ${busy} onclick="quantumSearch.openMegaLinkWithHandoff(${item.id}, this, true)" title="Krok 2: Otvorí ${nextProvLabel} pre kľúč. Userscript v1.6 ho automaticky spojí s ${this.escapeHtml(item.keyless_mega_url)} a uloží do Hubu.">🔑 Získať kľúč (${nextProvLabel}) ↗</button>
                <button type="button" class="action-btn btn-mega-verify ${aliveDone ? 'is-verified' : ''}" ${busy} onclick="quantumSearch.processMegaLinkPost(${item.id}, false)" title="Krok 1: Bez kľúča okamžite overí, či MEGA album existuje a koľko má súborov/GB">${item._busy ? '⏳…' : (aliveDone ? '✅ Živý' : '🔍 Overiť')}</button>
                <button type="button" class="action-btn btn-mega-hub" ${busy} onclick="quantumSearch.pasteMegaKeyForPost(${item.id}, this)" title="Prečíta 22-znakový kľúč zo schránky (alebo sa spýta), spojí ho s priečinkom a uloží do Hubu">📋 Vložiť kľúč</button>
                <details class="mega-manual">
                    <summary title="Ďalšie možnosti pre tento zamknutý MEGA album">Viac ▾</summary>
                    <div class="mega-manual-row">
                        <button type="button" class="action-btn" onclick="quantumSearch.retryWithNextBypassProvider(${item.id}, this)" title="Označí predchádzajúceho providera ako cooldown a skúsi ďalšieho">↻ Iný provider</button>
                        <button type="button" class="action-btn" onclick="quantumSearch.openMegaLinkWithHandoff(${item.id}, this, false)" title="Otvoriť priamo pôvodný key link (${domain})">⚡ Key link ↗</button>
                        <button type="button" class="action-btn" data-url="${this.escapeHtml(item.keyless_mega_url)}" onclick="window.open(this.dataset.url, '_blank', 'noopener')" title="Otvoriť zamknutý MEGA priečinok">📂 MEGA priečinok ↗</button>
                        <button type="button" class="action-btn" onclick="window.open('/api/v1/mega/hub/scripts/mega-hub-capture.user.js', '_blank', 'noopener')" title="Nainštalovať / aktualizovať userscript v1.6">🔄 Userscript v1.6</button>
                    </div>
                </details>`;
        } else {
            const busy = item._busy ? 'disabled' : '';
            const manualOpen = item._gate ? 'open' : '';
            primaryActions = `
                <button type="button" class="action-btn btn-mega-hub" ${busy} onclick="quantumSearch.processMegaLinkPost(${item.id}, true)" title="Lokálne dekóduje wrappery, stiahne paste stránku (rentry/pastebin) a overí všetky nájdené linky">${item._busy ? '⏳ Spracúvam…' : '✨ Získať a do Hubu'}</button>
                <button type="button" class="action-btn btn-mega-verify" ${busy} onclick="quantumSearch.processMegaLinkPost(${item.id}, false)" title="Rozbalí, zozbiera a overí všetky MEGA aj media linky – nič zatiaľ nepridá">🔍 Overiť</button>
                <details class="mega-manual" ${manualOpen}>
                    <summary title="Pre odkazy za captchou alebo bránou">Ručne ▾</summary>
                    <div class="mega-manual-row">
                        <button type="button" class="action-btn btn-mega-hub" onclick="quantumSearch.openMegaLinkWithHandoff(${item.id}, this, false)" title="Otvorí odkaz priamo (vhodné pre klientské userscripty bez bypass.city cooldownu)">⚡ Otvoriť ↗</button>
                        <button type="button" class="action-btn btn-bypass-city" onclick="quantumSearch.openMegaLinkWithHandoff(${item.id}, this, true)" title="Otvorí odkaz cez rotátor bypass providerov (aktuálne: ${nextProvLabel})">🚀 ${nextProvLabel} ↗</button>
                        <button type="button" class="action-btn" onclick="quantumSearch.retryWithNextBypassProvider(${item.id}, this)" title="Ak predchádzajúci bypasser hodil cooldown alebo zlyhal, prepne na ďalšieho">↻ Iný provider</button>
                        <button type="button" class="action-btn" onclick="quantumSearch.harvestLinksForPost(${item.id}, this)" title="Vložiť rentry.org URL, dynamic?r= odkaz alebo viacero MEGA / Bunkr / Gofile odkazov naraz">📋 Vložiť linky / Rentry</button>
                    </div>
                </details>`;
        }

        // Kompaktný Harvester súhrn na karte (rovnaká výška kariet v gride!) -> kliknutie otvorí pravý slide-over Harvester Inspector
        const showHarvestDrawer = discoveredMegas.length > 1 || discoveredMedias.length > 0 || discoveredContainers.length > 0;
        let harvestDrawerHtml = '';
        if (showHarvestDrawer) {
            const pillBits = [];
            if (discoveredMegas.length) {
                const aliveTxt = harvest.mega_alive ? `${harvest.mega_alive}/${discoveredMegas.length}` : `${discoveredMegas.length}`;
                pillBits.push(`<span class="mega-harvest-pill is-mega">${aliveTxt} MEGA</span>`);
            }
            if (discoveredMedias.length) {
                const firstHost = discoveredMedias[0]?.label || discoveredMedias[0]?.host || 'Media';
                const uniqueHosts = new Set(discoveredMedias.map(m => (m.label || m.host || 'Media')));
                const mediaLbl = uniqueHosts.size === 1 ? `${discoveredMedias.length} ${this.escapeHtml(firstHost)}` : `${discoveredMedias.length} Media`;
                pillBits.push(`<span class="mega-harvest-pill is-media">${mediaLbl}</span>`);
            }
            if (discoveredContainers.length) {
                pillBits.push(`<span class="mega-harvest-pill is-paste">${this.escapeHtml(discoveredContainers[0].domain || 'paste')}</span>`);
            }

            harvestDrawerHtml = `
                <button type="button" class="mega-harvest-trigger" onclick="quantumSearch.openMegaHarvestInspector(${item.id})"
                    aria-label="Otvoriť Harvester Inspector pre tento príspevok"
                    title="Klikni pre otvorenie pravého slide-over Harvester Inspectora (MEGA priečinky, Bunkr/Gofile/Pixeldrain, paste zdroje)">
                    <span class="material-icons-round mega-harvest-trigger-ico" aria-hidden="true">inventory_2</span>
                    <span class="mega-harvest-pills">${pillBits.join('')}</span>
                    <span class="material-icons-round mega-harvest-trigger-arrow" aria-hidden="true">chevron_right</span>
                </button>`;
        }

        const extMetaByUrl = new Map(
            (Array.isArray(item.extracted_links) ? item.extracted_links : []).map(e => [String(e.url || '').replace(/\/+$/, ''), e])
        );
        const altList = (Array.isArray(item.alt_urls)) ? item.alt_urls.slice(0, 3) : [];
        const altRowHtml = altList.length
            ? `<div class="mega-link-alts">${altList.map(alt => {
                const meta = extMetaByUrl.get(String(alt.url || '').replace(/\/+$/, '')) || alt;
                const altTitle = meta.label && meta.label.length <= 20 ? `${meta.label} · ${alt.domain}` : (alt.domain || 'mirror');
                const catIcon = meta.category === 'paste' ? '📄' : (meta.category === 'media_host' ? '🟣' : '🔀');
                return `
                <span class="mega-alt-group">
                    <button type="button" class="mega-alt-btn" data-alt-url="${this.escapeHtml(alt.url)}" onclick="quantumSearch.openMegaLinkWithHandoff(${item.id}, this, false, this.dataset.altUrl)" title="Rozbaliť / otvoriť (${this.escapeHtml(alt.url)})">${catIcon} ${this.escapeHtml(altTitle)} ↗</button>
                    <button type="button" class="mega-alt-btn is-bypass" data-alt-url="${this.escapeHtml(alt.url)}" onclick="quantumSearch.openMegaLinkWithHandoff(${item.id}, this, true, this.dataset.altUrl)" title="Otvoriť cez ${nextProvLabel}">🚀</button>
                </span>`;
            }).join('')}</div>`
            : '';

        const toggleDeadBtn = (item.status === 'dead' || item.status === 'skipped')
            ? `<button type="button" class="action-btn" onclick="quantumSearch.setMegaLinkPostStatus(${item.id}, 'new')" title="Obnoviť ako nové" style="flex:0;padding:6px 9px;">↺</button>`
            : `<button type="button" class="action-btn" onclick="quantumSearch.setMegaLinkPostStatus(${item.id}, 'dead')" title="Označiť ako mŕtvy alebo preskočiť" style="flex:0;padding:6px 9px;">✕</button>`;

        const postBtn = item.post_url
            ? `<button type="button" class="action-btn" onclick="window.open('${this.escapeHtml(item.post_url)}', '_blank', 'noopener')" title="Otvoriť pôvodnú Telegram správu" style="flex:0;padding:6px 9px;">💬</button>`
            : '';

        const verifyStatusHtml = item._verifyMessage
            ? `<div class="mega-link-verify-status is-${this.escapeHtml(item._verifyState || 'info')}" role="status" aria-live="polite">${this.escapeHtml(item._verifyMessage)}</div>`
            : '';

        return `
            <article class="search-result-card mega-link-card ${st.cls} ${this._megaSelected?.has(item.id) ? 'is-selected' : ''}" data-link-post-id="${item.id}">
                <div class="mega-link-thumb">
                    ${item.status === 'in_hub' && !readyToSendMegas.length ? '' : `<label class="mega-select-box" title="Vybrať kartu" onclick="event.stopPropagation()"><input type="checkbox" ${this._megaSelected?.has(item.id) ? 'checked' : ''} onchange="quantumSearch.toggleMegaSelect(${item.id}, this.checked)"><span></span></label>`}
                    ${thumb
                        ? `<img src="${thumb}" class="mega-thumb-main" alt="${title}" loading="lazy" decoding="async" onload="if(this.parentElement)this.parentElement.style.setProperty('--mega-thumb-bg','url(&quot;'+this.currentSrc+'&quot;)');" onerror="if(!this.dataset.retried){this.dataset.retried='1';setTimeout(()=>{this.src=this.src.split('?')[0]+'?r=1';},1500);return;}this.style.display='none';if(this.nextElementSibling)this.nextElementSibling.hidden=false;">
                           <div class="mega-link-thumb-fallback" hidden>📦</div>`
                        : `<div class="mega-link-thumb-fallback">📦</div>`}
                    <span class="mega-link-badge is-kind ${kindCls}">${kindLabel}</span>
                    ${multiLinkBadge}
                    <span class="mega-link-badge ${st.cls}">${st.label}</span>
                    ${videoPreviewBtn}
                    ${packSizeBadge}
                    ${countBadge}
                </div>
                <div class="search-result-content">
                    <div class="mega-link-meta">
                        <span>${channel}</span>
                        ${dateStr ? `<span>· ${dateStr}</span>` : ''}
                        <span class="mega-link-domain-chip">· ${domain}</span>
                    </div>
                    <div class="search-result-title" title="${title}">${title}</div>
                    ${tagsHtml}
                    ${excerpt ? `<div class="mega-link-caption">${excerpt}</div>` : ''}
                    <div class="mega-link-actions">
                        ${primaryActions}
                        ${postBtn}
                        ${toggleDeadBtn}
                    </div>
                    ${verifyStatusHtml}
                    ${harvestDrawerHtml}
                    ${altRowHtml}
                </div>
            </article>`;
    }


    cancelSearch() {
        this._metaControllers.forEach(controller => controller.abort());
        this._metaControllers.clear();
        this._metaPending.clear();
        if (this._omegaEventSource) {
            try { this._omegaEventSource.close(); } catch {}
            this._omegaEventSource = null;
        }
        if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
        }
        if (Array.isArray(this._activeControllers)) {
            this._activeControllers.forEach(controller => controller.abort());
            this._activeControllers = [];
        }
        this._searchRunId += 1;
        this.isSearching = false;
        this.showLoading(false);
    }

    getSearchSourceKeys() {
        const valid = new Set(this.sourceCatalog.map(source => source.id));
        if (this.searchFilters.source.includes('all')) return [...valid];
        return this.searchFilters.source.filter(key => valid.has(key));
    }

    _resultKey(item) {
        if (!item) return '';
        if (item._resultKey) return item._resultKey;
        if (item.chat_id && item.message_id) return `tg:${item.chat_id}:${item.message_id}`;
        const rawUrl = String(item.url || '').replace(/#.*$/, '').replace(/\/$/, '');
        const src = String(item.source_key || item.source || '').toLowerCase();
        return src ? `${src}::${rawUrl}` : rawUrl;
    }

    _isCardVisible(url) {
        if (!url || typeof document === 'undefined' || !document.querySelectorAll) return false;
        const card = Array.from(document.querySelectorAll('.search-result-card'))
            .find(el => el.dataset?.url === url);
        if (!card || typeof card.getBoundingClientRect !== 'function') return false;
        const rect = card.getBoundingClientRect();
        const vh = (typeof window !== 'undefined' && window.innerHeight) ? window.innerHeight : 900;
        return rect.bottom >= -120 && rect.top <= vh + 240;
    }

    _prioritizeUrls(urls) {
        const list = Array.isArray(urls) ? [...urls] : [];
        if (list.length <= 1) return list;
        const selected = this.selectedUrls || new Set();
        const visibleSet = new Set(
            (this.filteredResults || []).slice(0, 24).map(r => r?.url).filter(Boolean)
        );
        return list
            .map((url, idx) => {
                const isSel = selected.has(url) ? 0 : 1;
                const isVis = (this._isCardVisible(url) || visibleSet.has(url)) ? 0 : 1;
                return { url, isSel, isVis, idx };
            })
            .sort((a, b) => (a.isSel - b.isSel) || (a.isVis - b.isVis) || (a.idx - b.idx))
            .map(entry => entry.url);
    }

    mergeIncomingResults(items) {
        const byUrl = new Map();
        [...this.results, ...(items || [])].forEach(item => {
            if (!item || !item.url) return;
            const key = String(item.url).replace(/#.*$/, '').replace(/\/$/, '');
            if (!byUrl.has(key)) {
                item._resultKey = this._resultKey(item);
                byUrl.set(key, item);
                return;
            }
            const current = byUrl.get(key);
            const filled = Object.fromEntries(
                Object.entries(item).filter(([, value]) => value !== undefined && value !== null && value !== '')
            );
            const merged = { ...current, ...filled };
            merged._resultKey = current._resultKey || this._resultKey(merged);
            byUrl.set(key, merged);
        });
        this.results = Array.from(byUrl.values());
    }

    updateModeButtons() {
        for (const mode of [1, 2, 3]) {
            const button = document.getElementById(`quantumMode${mode}`);
            if (button) {
                button.classList.toggle('active', this.searchMode === mode);
                button.setAttribute('aria-pressed', String(this.searchMode === mode));
            }
        }
        const hint = document.getElementById('quantumModeHint');
        if (hint) hint.textContent = this.searchMode === 3
            ? 'Progressive 4-layer SSE (Vault + Telethon + API/KVS/WP + SearXNG Dorks)'
            : (this.searchMode === 2 ? 'Related terms, concept coverage, quality and date' : 'Original search');
        const omegaBar = document.getElementById('omegaControlBar');
        if (omegaBar) {
            omegaBar.hidden = this.searchMode !== 3;
            if (this.searchMode === 3) {
                this.updateOmegaControlState();
                this.refreshOmegaHealth();
            }
        }
    }

    updateOmegaControlState() {
        const presetSel = document.getElementById('omegaPresetSelect');
        if (presetSel) presetSel.value = this.omegaPreset || 'all';
        document.querySelectorAll('[data-omega-preset]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.omegaPreset === this.omegaPreset);
        });
        this.updateOmegaLayerPills();
    }

    setOmegaPreset(preset) {
        if (!['all', 'leaks', 'tubes', 'fast'].includes(preset)) return;
        this.omegaPreset = preset;
        localStorage.setItem('quantum_omega_preset', preset);
        this.updateOmegaControlState();
        const query = document.getElementById('quantumSearchInput')?.value.trim() || this._lastQuery;
        if (this.searchMode === 3 && query && query.length >= 2) this.search(query);
    }

    setOmegaLayer(layer) {
        this.activeOmegaLayer = layer || 'all';
        this.updateOmegaLayerPills();
        this.applyFilters();
    }

    updateOmegaLayerPills() {
        const c = this._omegaLayerCounts || {};
        const total = Object.values(c).reduce((acc, n) => acc + (Number(n) || 0), 0);
        const kvsWp = (c.kvs || 0) + (c.wp_dle || 0);
        const labels = {
            all: total ? `Všetko (${total})` : 'Všetko',
            local_vault: `⚡ Vault (${c.local_vault || 0})`,
            telethon: `✈️ TG (${c.telethon || 0})`,
            api: `🚀 API (${c.api || 0})`,
            tube: `🎥 Tubes (${c.tube || 0})`,
            kvs_wp: `🎬 KVS/WP (${kvsWp})`,
            dork: `🌐 Dorks (${c.dork || 0})`,
        };
        document.querySelectorAll('[data-omega-layer]').forEach(btn => {
            const key = btn.dataset.omegaLayer;
            if (labels[key]) btn.textContent = labels[key];
            btn.classList.toggle('active', this.activeOmegaLayer === key);
        });
    }

    async refreshOmegaHealth() {
        const badge = document.getElementById('omegaSearxStatus');
        const startBtn = document.getElementById('omegaStartSearxBtn');
        if (!badge) return;
        try {
            const resp = await fetch('/api/v1/search/omega/searxng/status', { cache: 'no-store' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            badge.classList.toggle('is-ok', Boolean(data.running));
            badge.classList.toggle('is-off', !data.running);
            badge.textContent = data.running ? 'SearXNG: ON' : 'SearXNG: OFF';
            badge.title = data.running ? 'Lokálny SearXNG beží na :8888' : 'Lokálny SearXNG (:8888) je vypnutý';
            if (startBtn) startBtn.hidden = Boolean(data.running);
        } catch {
            badge.classList.remove('is-ok');
            badge.classList.add('is-off');
            badge.textContent = 'SearXNG: OFF';
            if (startBtn) startBtn.hidden = false;
        }
    }

    async startOmegaSearxng() {
        const badge = document.getElementById('omegaSearxStatus');
        const startBtn = document.getElementById('omegaStartSearxBtn');
        if (startBtn) startBtn.disabled = true;
        if (badge) badge.textContent = 'SearXNG: spúšťam…';
        try {
            const resp = await fetch('/api/v1/search/omega/searxng/start', { method: 'POST' });
            const data = await resp.json();
            this.setActivity('SearXNG', data.running ? 'Beží na :8888' : (data.detail || 'Nepodarilo sa spustiť'), data.running ? 'done' : 'error');
        } catch (e) {
            this.setActivity('SearXNG', e.message || 'Chyba spustenia', 'error');
        } finally {
            if (startBtn) startBtn.disabled = false;
            await this.refreshOmegaHealth();
        }
    }

    async resetOmegaCircuits() {
        try {
            const resp = await fetch('/api/v1/search/omega/circuit/reset', { method: 'POST' });
            const data = await resp.json();
            this.setActivity('Circuit Breaker', `Odomknutých ${data.circuits_reset || 0} domén, cache vymazaná`, 'done');
        } catch (e) {
            this.setActivity('Circuit Breaker', e.message || 'Reset zlyhal', 'error');
        }
    }

    setResultLayout(layout) {
        if (!['5x3', '5x2', '4x4'].includes(layout)) return;
        this.resultLayout = layout;
        localStorage.setItem('quantum_result_layout', layout);
        this.updateResultLayout();
    }

    updateResultLayout() {
        const results = document.getElementById('quantumSearchResults');
        if (results) results.dataset.layout = this.resultLayout;
        document.querySelectorAll('.quantum-result-layout-button').forEach(button => {
            const isActive = button.dataset.layout === this.resultLayout;
            button.setAttribute('aria-pressed', String(isActive));
        });
    }

    setSearchMode(mode) {
        if (![1, 2, 3].includes(mode) || mode === this.searchMode) return;
        this.searchMode = mode;
        localStorage.setItem('quantum_search_mode', String(mode));
        this.updateModeButtons();
        const query = document.getElementById('quantumSearchInput')?.value.trim() || this._lastQuery;
        if (query && query.length >= 2) this.search(query);
    }

    removeNearDuplicateResults(items) {
        const kept = [];
        (items || []).forEach(item => {
            const duplicateIndex = kept.findIndex(existing => this.isNearDuplicate(existing, item));
            if (duplicateIndex === -1) {
                kept.push(item);
                return;
            }

            // Keep the first result (the source's higher-ranked hit), but fill
            // in any missing metadata from the duplicate copy.
            const existing = kept[duplicateIndex];
            const filled = Object.fromEntries(
                Object.entries(item).filter(([, value]) => value !== undefined && value !== null && value !== '')
            );
            kept[duplicateIndex] = { ...filled, ...existing };
        });
        return kept;
    }

    isNearDuplicate(first, second) {
        if (!first || !second || first.url === second.url) return false;
        if (this.normalizeSearchText(first.source) !== this.normalizeSearchText(second.source)) return false;
        if (this.parseDuration(first.duration) !== this.parseDuration(second.duration)) return false;
        if (this.normalizeSearchText(first.quality) !== this.normalizeSearchText(second.quality)) return false;

        const words = value => new Set((this.normalizeSearchText(value).match(/[\p{L}\p{N}]{3,}/gu) || []));
        const a = words(first.title);
        const b = words(second.title);
        if (a.size < 5 || b.size < 5) return false;
        const overlap = [...a].filter(word => b.has(word)).length;
        return overlap / Math.min(a.size, b.size) >= 0.8;
    }

    // A few providers return generic recommendations when their own search
    // has no match.  Do not show those as Quantum results: every word in the
    // user's query must occur in the item's real searchable metadata.
    normalizeSearchText(value) {
        return String(value || '')
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLocaleLowerCase();
    }

    filterResultsForQuery(items, query) {
        const contentQuery = query.replace(/\b(4k|uhd|fhd|hd|4320p|2160p|1440p|1080p|720p|480p)\b/gi, '');
        const terms = this.normalizeSearchText(contentQuery)
            .match(/[\p{L}\p{N}]+/gu) || [];
        if (!terms.length) return [];

        return (items || []).filter(item => {
            if (!item) return false;
            const metadata = [
                item.title,
                item.description,
                item.scene_title,
                item.tags,
                item.categories,
                item.performers,
                item.models,
                item.creator,
                item.uploader,
                item.username,
                item.author,
                item.channel,
            ].flatMap(value => Array.isArray(value) ? value : [value]).join(' ');
            const haystack = this.normalizeSearchText(metadata);
            return haystack && terms.every(term => haystack.includes(term));
        });
    }

    requestedMinSizeMb() {
        return Math.max(0, Number(this.searchFilters.minSizeMb) || 0);
    }

    setMinSize(value) {
        this.searchFilters.minSizeMb = Math.max(0, Number(value) || 0);
        if (this.results && this.results.length) this.applyFilters();
    }

    requestedQuality() {
        const thresholds = { '4K': 2160, '1080p': 1080, '720p': 720, 'HD': 720, '480p': 480 };
        const selected = this.searchFilters.quality || ['all'];
        if (!selected.length || selected.includes('all')) return 0;
        return Math.min(...selected.map(value => thresholds[value] || 0));
    }

    fairResultLimit(rows, maxTotal) {
        const groups = new Map();
        rows.forEach(row => {
            const key = row.source_key || row.source || 'unknown';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(row);
        });
        const result = [];
        const maxDepth = Math.max(0, ...[...groups.values()].map(group => group.length));
        for (let index = 0; index < maxDepth && result.length < maxTotal; index++) {
            for (const group of groups.values()) {
                if (group[index]) result.push(group[index]);
                if (result.length >= maxTotal) break;
            }
        }
        return result;
    }

    getTelegramLimit() {
        const select = document.getElementById('telegramLimitSelect');
        const input = document.getElementById('telegramScrapeLimit');
        let val = 50;
        if (select && select.value !== 'custom') {
            val = parseInt(select.value, 10);
        } else if (input) {
            val = parseInt(input.value, 10);
        }
        return Math.min(2000, Math.max(1, val || 50));
    }

    onTelegramLimitSelectChange(val) {
        const input = document.getElementById('telegramScrapeLimit');
        if (val === 'custom') {
            if (input) {
                input.style.display = 'inline-block';
                input.focus();
            }
        } else {
            if (input) {
                input.style.display = 'none';
                input.value = val;
            }
            this.saveTelegramLimit(parseInt(val, 10));
        }
    }

    onTelegramLimitCustomChange() {
        const input = document.getElementById('telegramScrapeLimit');
        const val = parseInt(input?.value, 10) || 50;
        this.saveTelegramLimit(val);
    }

    saveTelegramLimit(val) {
        const limit = val || parseInt(document.getElementById('telegramScrapeLimit')?.value, 10) || 50;
        const clamped = Math.min(2000, Math.max(1, limit));
        localStorage.setItem('quantum_telegram_limit', String(clamped));
    }

    initTelegramLimitUI() {
        const saved = parseInt(localStorage.getItem('quantum_telegram_limit'), 10) || 50;
        const select = document.getElementById('telegramLimitSelect');
        const input = document.getElementById('telegramScrapeLimit');
        if (!select || !input) return;
        input.value = saved;
        const presets = ['25', '50', '100', '200', '500', '1000'];
        if (presets.includes(String(saved))) {
            select.value = String(saved);
            input.style.display = 'none';
        } else {
            select.value = 'custom';
            input.style.display = 'inline-block';
        }
    }

    toggleGlobalSearch(button) {
        this.globalTelegram = !this.globalTelegram;
        if (button) {
            button.setAttribute('aria-pressed', this.globalTelegram ? 'true' : 'false');
            button.classList.toggle('primary', this.globalTelegram);
        }
    }

    async searchJoinedChannels(query, forceLive = false, append = false, newOnly = false) {
        if (!append && this._liveNewController) this.stopLiveNewTelegramVideos();
        if (append && (!this._catalogPage || this.isSearching)) return;
        const page = append ? this._catalogPage : null;
        newOnly = page ? !!page.newOnly : newOnly;
        if (!append) this._catalogPage = null;
        this.updateCatalogMore();
        const runId = ++this._searchRunId;
        this.isSearching = true;
        this.showLoading(true);
        if (!append) {
            this.results = [];
            this.filteredResults = [];
            if (this.selectedUrls) this.selectedUrls.clear();
        }
        this.updateSelectionToolbar();
        this.diagnostics = [];
        this.activeSource = 'all';
        const word = page ? page.query : (query || '').trim();
        if (!append) this.setActivity('Searching joined channels', word, 'working');
        if (!word && forceLive) {
            this.showError('Enter a search query.');
            this.isSearching = false;
            this.showLoading(false);
            return;
        }
        const limit = page ? page.limit : this.getTelegramLimit();
        try {
            const minDuration = page ? page.minDuration : (this.activeFilters.duration || 0);
            const minQuality = page ? page.minQuality : this.requestedQuality();
            const endpoint = forceLive ? 'search_global' : 'catalog/search';
            const selected = newOnly ? '' : (page ? page.selected : [...(this.selectedTelegramChatIds || [])].join(','));
            const minSize = page ? page.minSize : this.requestedMinSizeMb();
            const offset = newOnly ? 0 : (page ? page.offset : 0);
            const sort = encodeURIComponent(this.activeSort || 'relevance');
            const exclude = encodeURIComponent(document.getElementById('telegramExcludeInput')?.value || '');
            const response = await fetch(`/api/v1/telegram/${endpoint}?query=${encodeURIComponent(word)}&limit=${limit}&offset=${offset}&min_duration=${minDuration}&min_quality=${minQuality}&min_size_mb=${minSize}&force_live=${forceLive}&chat_ids=${encodeURIComponent(selected)}&new_only=${newOnly}&before_date=${encodeURIComponent(page?.beforeDate || '')}&before_id=${page?.beforeId || 0}&sort=${sort}&exclude=${exclude}`);
            const data = await response.json().catch(() => ({}));
            if (runId !== this._searchRunId) return;
            if (!response.ok) {
                const detail = data.detail || `Global search failed (${response.status})`;
                throw new Error(typeof detail === 'string' ? detail : 'Global search failed');
            }
            if (newOnly && data.new_only !== true) throw new Error('Nexus server ešte používa starú verziu. Reštartuj Nexus a obnov stránku.');
            this._lastTelegramSource = data.source || '';
            const info = document.getElementById('telegramCatalogSearchInfo');
            if (info) info.textContent = newOnly
                ? `Nové mimo knižnice · všetky pripojené skupiny a kanály · ${data.coverage?.complete_channels || 0}/${data.coverage?.total_channels || 0} kompletne spracovaných.${data.coverage?.enabled ? ' Index sa priebežne aktualizuje.' : ' Indexovanie je pozastavené – ďalšie videá pribudnú po jeho spustení.'}`
                : forceLive
                ? 'Živé výsledky z Telegramu boli pridané do lokálneho indexu.'
                : `Lokálny index · ${data.coverage?.complete_channels || 0}/${data.coverage?.total_channels || 0} kanálov kompletne spracovaných. Ďalšie výsledky môže nájsť „Dohľadať na Telegrame“.`;
            const videos = Array.isArray(data.videos) ? data.videos : [];
            const mapped = videos.map(video => {
                const playUrl = video.stream_url || video.video_url || '';
                const w = Number(video.width) || 0;
                const h = Number(video.height) || 0;
                const orientation = this._videoOrientation({ ...video, width: w, height: h });
                let effRes = Number(video.effective_res) || 0;
                if (!effRes && (w > 0 || h > 0)) {
                    const shortEdge = (w > 0 && h > 0) ? Math.min(w, h) : Math.max(w, h);
                    const longEdge = Math.max(w, h);
                    if (shortEdge >= 2160 || longEdge >= 3840) effRes = 2160;
                    else if (shortEdge >= 1440 || longEdge >= 2560) effRes = 1440;
                    else if (shortEdge >= 1080 || longEdge >= 1920) effRes = 1080;
                    else if (shortEdge >= 720 || longEdge >= 1280) effRes = 720;
                    else if (shortEdge >= 480 || longEdge >= 840) effRes = 480;
                    else effRes = shortEdge;
                }
                const quality = video.quality || (effRes >= 2160 ? '4K' : effRes >= 1080 ? '1080p' : effRes >= 720 ? '720p' : effRes >= 480 ? '480p' : '');
                return {
                    title: (video.title || video.text || '').trim() || `Telegram #${video.message_id}`,
                    url: video.url || playUrl,
                    source_url: video.url || '',
                    stream_url: playUrl,
                    thumbnail: video.thumbnail || '',
                    thumb_url: video.thumbnail || '',
                    duration: video.duration || '',
                    source: 'Telegram',
                    upload_date: video.date ? String(video.date).slice(0, 10) : '',
                    views: Number(video.views) || 0,
                    forwards: Number(video.forwards) || 0,
                    reactions: Number(video.reactions) || 0,
                    size_bytes: Number(video.size_bytes) || 0,
                    width: w,
                    height: h,
                    effective_res: effRes,
                    quality: quality,
                    orientation: orientation.orientation,
                    orientation_evidence: orientation.evidence,
                    file_name: video.file_name || '',
                    text: video.text || '',
                    tags: video.tags || [],
                    performers: video.performers || [],
                    scene_title: video.scene_title || '',
                    platform: video.platform || '',
                    source_channels: Array.isArray(video.source_channels) ? video.source_channels : [],
                    message_id: video.message_id,
                    channel_id: video.channel_id,
                    chat_id: video.chat_id || video.channel_id,
                    file_id: video.file_id || '',
                    mega_urls: Array.isArray(video.mega_urls) ? video.mega_urls : [],
                };
            });
            if (append) {
                const seen = new Set(this.results.map(item => `${item.chat_id}:${item.message_id}`));
                this.results.push(...mapped.filter(item => !seen.has(`${item.chat_id}:${item.message_id}`)));
            } else this.results = mapped;
            const last = videos[videos.length - 1];
            if (!forceLive) this._catalogPage = { query: word, limit, minDuration, minQuality, minSize, selected, offset: offset + videos.length, hasMore: !!data.has_more, newOnly, beforeDate: last?.date || '', beforeId: last?._catalog_id || 0 };
            this.updateCatalogMore();
            this.applyFilters();
            if (!newOnly) await this.saveTelegramHistory({
                query: word,
                chats: [{ id: 'all', title: 'Všetky moje kanály / skupiny' }],
                limit
            });
            if (!this.filteredResults.length && forceLive) {
                this.showError(`No videos for “${word}” in your joined chats matching selected filters.`);
                return;
            }
        } catch (error) {
            if (runId !== this._searchRunId) return;
            this.showError(error.message || 'Global search failed');
        } finally {
            if (runId === this._searchRunId) {
                this.isSearching = false;
                this.showLoading(false);
                this.updateCatalogMore();
                if (!append) this.setActivity('Channel search complete', `${this.filteredResults.length} results`, 'done');
            }
        }
    }

    async searchOmegaSSE(query, runId, limitPerSource = 20, minQuality = 0) {
        const params = new URLSearchParams({
            query,
            preset: this.omegaPreset || 'all',
            per_source_limit: String(Math.min(50, Math.max(1, limitPerSource || 20))),
            min_quality: String(minQuality || 0),
        });
        const sseUrl = `/api/v1/search/omega?${params.toString()}`;
        this.diagnostics = [];
        this._omegaLayerCounts = {};
        this.activeOmegaLayer = 'all';
        this.updateOmegaControlState();
        this.updateActivityProgress('OMNI-SEARCH SSE: spúšťam Local Vault + adaptéry…', 0, 1);

        return await new Promise(resolve => {
            let doneCount = 0;
            const es = new EventSource(sseUrl);
            this._omegaEventSource = es;

            const finish = (shouldEnrich = false) => {
                if (this._omegaEventSource === es) this._omegaEventSource = null;
                try { es.close(); } catch {}
                if (runId === this._searchRunId) {
                    this.isSearching = false;
                    this.showLoading(false);
                    if (this.results.length === 0) this.renderResults();
                    this.refreshOmegaHealth();
                    if (shouldEnrich && this.results.length > 0) {
                        this._enrichRunId = runId;
                        this._autoEnrichResults(runId);
                    }
                }
                resolve();
            };

            const upsertDiag = payload => {
                const key = payload.source_key || payload.source_label || 'omega';
                const status = payload.status === 'skipped_circuit' ? 'error' : (payload.status || 'ok');
                this.diagnostics = [
                    ...this.diagnostics.filter(d => d.source_key !== key),
                    {
                        source_key: key,
                        source_label: payload.source_label || key,
                        status,
                        count: payload.count || 0,
                        error: payload.error || '',
                    },
                ];
            };

            es.addEventListener('results', ev => {
                if (runId !== this._searchRunId) return finish();
                try {
                    const payload = JSON.parse(ev.data);
                    doneCount += 1;
                    const layerKey = payload.layer || 'other';
                    this._omegaLayerCounts[layerKey] = (this._omegaLayerCounts[layerKey] || 0) + (payload.count || 0);
                    if (Array.isArray(payload.items) && payload.items.length) {
                        this.mergeIncomingResults(payload.items);
                    }
                    upsertDiag(payload);
                    this.updateOmegaLayerPills();
                    this.updateSourceBadges();
                    this.applyFilters();
                    this.updateActivityProgress(
                        `OMNI SSE · ${payload.source_label || payload.layer}: +${payload.count || 0} (${this.results.length} spolu)`,
                        doneCount,
                        Math.max(doneCount + 1, 20),
                    );
                } catch (e) {
                    console.warn('[OmniSSE] parse results failed:', e);
                }
            });

            es.addEventListener('source_status', ev => {
                if (runId !== this._searchRunId) return finish();
                try {
                    const payload = JSON.parse(ev.data);
                    doneCount += 1;
                    upsertDiag(payload);
                    this.updateSourceBadges();
                } catch {}
            });

            es.addEventListener('done', ev => {
                if (runId === this._searchRunId) {
                    try {
                        const summary = JSON.parse(ev.data);
                        this.setActivity(
                            'Omni-Search complete',
                            `${this.filteredResults.length} results · ${summary.elapsed_ms || 0} ms`,
                            'done',
                        );
                    } catch {}
                }
                finish(true);
            });

            es.onerror = () => {
                if (runId === this._searchRunId && this.results.length === 0) {
                    this.setActivity('Omni-Search error', 'SSE stream interrupted', 'error');
                }
                finish();
            };
        });
    }

    async search(query) {
        // Cancel any in-flight search before starting a new one
        clearTimeout(this._filterSearchTimer);
        this.cancelSearch();
        if (this.megaPacksMode) {
            return this.loadMegaLinkPosts(query, false);
        }
        if (this.globalTelegram) {
            return this.searchJoinedChannels(query);
        }

        this._catalogPage = null;
        this.updateCatalogMore();
        const runId = this._searchRunId;
        this.isSearching = true;
        this.setActivity('Searching sources', query, 'working');
        this.showLoading(true);
        this.results = [];
        this.filteredResults = [];
        this.diagnostics = [];
        this.activeSource = 'all';
        this.updateSourceBadges();

        const container = document.getElementById('quantumSearchResults');
        container.innerHTML = `
            <div class="quantum-search-empty" style="grid-column:1/-1;">
                <div class="quantum-search-empty-icon" style="font-size:32px;">🔍</div>
                <div class="quantum-search-empty-text">Searching sources as they respond…</div>
            </div>`;

        try {
            await this.catalogPromise;
            if (runId !== this._searchRunId) return;
            const limitPerSource = Math.min(200, Math.max(1, parseInt(document.getElementById('searchLimitPerSource')?.value) || 20));
            const limitTotal = Math.min(2000, Math.max(1, parseInt(document.getElementById('searchLimitTotal')?.value) || 100));
            const minQuality = this.requestedQuality();
            this._lastMinQuality = minQuality;
            this._lastQuery = query;
            if (this.searchMode === 3) {
                return await this.searchOmegaSSE(query, runId, limitPerSource, minQuality);
            }
            const sources = this.getSearchSourceKeys();
            if (!sources.length) {
                this.showError(this.catalogError ? `Source catalog unavailable: ${this.catalogError}` : 'Select at least one searchable source.');
                return;
            }
            this._sourceLoaded = {};
            sources.forEach(k => { this._sourceLoaded[k] = limitPerSource; });
            this.diagnostics = sources.map(source_key => ({source_key, status: 'running', count: 0, shown_count: 0}));
            this.updateActivityProgress(`SEARCHING 0/${sources.length} sources · 0 results`, 0, sources.length);
            this.updateSourceBadges();
            let cursor = 0;
            const runSource = async sourceKey => {
                const controller = new AbortController();
                this._activeControllers.push(controller);
                const timer = setTimeout(() => controller.abort(), 60000);
                const url = `/api/v1/search/external?query=${encodeURIComponent(query)}&source=${encodeURIComponent(sourceKey)}&result_limit=${limitPerSource}&per_source_limit=${limitPerSource}&max_total=${limitPerSource}&min_quality=${minQuality}&include_diagnostics=1&save_history=0&mode=${this.searchMode}${this._orientationQuery()}`;
                try {
                    const response = await fetch(url, { signal: controller.signal });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const data = await response.json();
                        if (runId !== this._searchRunId) return;
                        this.mergeIncomingResults(data.results || []);
                        const diagnostics = (data.diagnostics || []).length
                            ? data.diagnostics
                            : [{ source_key: sourceKey, status: 'ok', count: (data.results || []).length }];
                        this.diagnostics = [
                            ...this.diagnostics.filter(d => d.source_key !== sourceKey),
                            ...diagnostics
                        ];
                        this.updateSourceBadges();
                        this.applyFilters();
                } catch (error) {
                        if (runId !== this._searchRunId) return;
                        const status = error.name === 'AbortError' ? 'timeout' : 'error';
                        const message = error.name === 'AbortError' ? 'request timed out after 60 seconds' : (error.message || 'error');
                        this.diagnostics = [
                            ...this.diagnostics.filter(d => d.source_key !== sourceKey),
                            { source_key: sourceKey, status, count: 0, error: message }
                        ];
                        this.updateSourceBadges();
                        if (this.results.length === 0) this.renderResults();
                } finally {
                    clearTimeout(timer);
                    if (runId === this._searchRunId) {
                        const completed = this.diagnostics.filter(item => item.status !== 'running').length;
                        this.updateActivityProgress(`SEARCHING ${completed}/${sources.length} sources · ${this.results.length} results`, completed, sources.length);
                    }
                }
            };
            const worker = async () => {
                while (cursor < sources.length && runId === this._searchRunId) {
                    const key = sources[cursor++];
                    await runSource(key);
                }
            };
            await Promise.all(Array.from({length: Math.min(4, sources.length)}, () => worker()));
            if (runId === this._searchRunId && this.results.length === 0) {
                this.renderResults();
            }

            // Auto-enrich: fetch detail-page metadata for all results in background
            if (runId === this._searchRunId && this.results.length > 0) {
                this._enrichRunId = runId;
                this._autoEnrichResults(runId);
            }
            // Všetko sa najprv nájde a ponechá; až potom sa postupne overujú neznáme (ak je vertikálny filter).
            if (runId === this._searchRunId && this._wantsPortrait()) this._probeUnknownOrientation();
            if (runId === this._searchRunId) this.setActivity('Search complete', `${this.filteredResults.length} results · ${sources.length} sources checked`, 'done');
        } catch (error) {
            if (error.name === 'AbortError') {
                // Aborted by cancelSearch() (user typed more) — silently ignore.
                return;
            } else {
                console.error('Search error:', error);
                this.setActivity('Search failed', error.message || 'Failed to search. Please try again.', 'error');
                this.showError('Failed to search. Please try again.');
            }
        } finally {
            if (runId !== this._searchRunId) return;
            this._abortController = null;
            this._activeControllers = [];
            this.isSearching = false;
            this.showLoading(false);
        }
    }

    // Fetch the next batch of results for a single source and merge them in.
    // Used by the "Load more" button so the user can pull deeper into one
    // source without re-running the whole multi-source search.
    async loadMoreSource(sourceKey) {
        if (!sourceKey || sourceKey === 'all') return;
        if (!this._lastQuery) return;
        if (this._loadingMore[sourceKey]) return;
        this._loadingMore[sourceKey] = true;

        const prev = this._sourceLoaded[sourceKey] || (parseInt(document.getElementById('searchLimitPerSource')?.value) || 20);
        const next = Math.min(prev + Math.max(20, prev), 200);

        const btn = document.getElementById('quantumLoadMoreBtn');
        if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = 'Loading…'; }

        const controller = new AbortController();
        this._activeControllers.push(controller);
        const timer = setTimeout(() => controller.abort(), 60000);
        try {
            const url = `/api/v1/search/external?query=${encodeURIComponent(this._lastQuery)}&source=${encodeURIComponent(sourceKey)}&result_limit=${next}&per_source_limit=${next}&max_total=${next}&min_quality=${this._lastMinQuality || 0}&include_diagnostics=1&save_history=0&mode=${this.searchMode}${this._orientationQuery()}`;
            const resp = await fetch(url, { signal: controller.signal });
            if (resp.ok) {
                const data = await resp.json();
                this.mergeIncomingResults(data.results || []);
                this._sourceLoaded[sourceKey] = next;
                const diagnostics = (data.diagnostics || []).length
                    ? data.diagnostics
                    : [{ source_key: sourceKey, status: 'ok', count: (data.results || []).length }];
                this.diagnostics = [
                    ...this.diagnostics.filter(d => d.source_key !== sourceKey),
                    ...diagnostics
                ];
                this.updateSourceBadges();
                this.applyFilters();
                this._prefetchTesterMetadata(this._searchRunId);
            }
        } catch (e) {
            // swallow — leave existing results untouched
        } finally {
            clearTimeout(timer);
            this._loadingMore[sourceKey] = false;
            const b = document.getElementById('quantumLoadMoreBtn');
            if (b && b.dataset.label) { b.disabled = false; b.textContent = b.dataset.label; }
        }
    }

    async _autoEnrichResults(runId) {
        this._prefetchTesterMetadata(runId);
        const rawUrls = this.results
            .map(r => r.url)
            .filter(u => u && !this._usesTesterMetadata(u) && (
                u.includes('xvideos.com') ||
                u.includes('xhamster.com') ||
                u.includes('eporner.com')
            ));
        const urls = this._prioritizeUrls(rawUrls);
        if (!urls.length) return;

        // Show enriching indicator on eligible cards
        urls.forEach(url => {
            const card = document.querySelector(`.search-result-card[data-url="${CSS.escape(url)}"]`);
            if (card) {
                const indicator = card.querySelector('.enrich-status');
                if (indicator) indicator.style.display = 'inline-flex';
            }
        });

        try {
            const resp = await fetch('/api/v1/search/enrich', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ urls, timeout_s: 10 })
            });
            if (!resp.ok || runId !== this._enrichRunId) return;
            const data = await resp.json();
            const enriched = data.enriched || {};

            // Patch in-memory results
            let orientationUpdated = false;
            this.results = this.results.map(r => {
                const patch = enriched[r.url];
                if (!patch) return r;
                if (patch.width || patch.height || patch.orientation) orientationUpdated = true;
                return { ...r, ...patch };
            });

            // Apply filters re-sorts but we need to keep current view
            // Instead: directly update changed cards in DOM
            Object.entries(enriched).forEach(([url, patch]) => {
                this._applyEnrichmentToCard(url, patch);
                const result = this.results.find(item => item.url === url);
                if (result) this._syncOrientationBadge(result);
            });

            // Hide all enriching indicators
            document.querySelectorAll('.enrich-status').forEach(el => el.style.display = 'none');
            if (orientationUpdated && this.activeFilters.orientation !== 'all') this.applyFilters();

            const count = Object.keys(enriched).length;
            if (count > 0) {
                console.log(`[Enrich] ${count}/${urls.length} cards enriched in ${data.timing_ms}ms`);
            }
        } catch (err) {
            console.warn('[Enrich] batch failed:', err);
            document.querySelectorAll('.enrich-status').forEach(el => el.style.display = 'none');
        }
    }

    _usesTesterMetadata(url) {
        try {
            const parsed = new URL(url);
            return ['http:', 'https:'].includes(parsed.protocol) &&
                ['porntrex.com', 'whoreshub.com', 'pornhub.com', 'leakporner.com',
                 'mypornerleak.com', 'pimpbunny.com', 'fpo.xxx', 'beeg.com', 'pornone.com', 'xhamster.com',
                 'eporner.com', 'xvideos.com', 'noodlemagazine.com', 'ukdevilz.com', 'camwhores.tv',
                 'camwhoresbay.com', 'hqporner.com', 'pornhat.com', 'pornhoarder.tv',
                 'sxyprn.com', '1porn.tv', 'djav.org', 'baddiehub.com', 'nsfw247.to',
                 'tnaflix.com', 'xxbrits.com', 'thothub.to', 'thisvid.com',
                 'analdin.com', 'anysex.com']
                .some(domain => parsed.hostname === domain || parsed.hostname.endsWith('.' + domain));
        } catch { return false; }
    }

    async _prefetchTesterMetadata(runId, urls = null, onProgress = null) {
        const candidates = urls || this.results
            .filter(r => this._usesTesterMetadata(r.url) && !r._metaFetched && ((!r.thumbnail && !r.thumb_url) || !r.duration || !r.height || !r.size_bytes || !r.upload_date))
            .map(r => r.url);
        const pending = this._prioritizeUrls([...new Set(candidates)].filter(url => !this._metaPending.has(url)));
        pending.forEach(url => this._metaPending.set(url, runId));
        let completed = 0;
        if (typeof onProgress === 'function') onProgress({ completed, total: pending.length });
        if (pending.length && runId === this._searchRunId) this.applyFilters();
        for (let i = 0; i < pending.length; i += 4) {
            const batch = pending.slice(i, i + 4);
            if (runId !== this._searchRunId) {
                pending.slice(i).forEach(url => { if (this._metaPending.get(url) === runId) this._metaPending.delete(url); });
                break;
            }
            const controller = new AbortController();
            this._metaControllers.add(controller);
            const timer = setTimeout(() => controller.abort(), 60000);
            try {
                const resp = await fetch('/api/tester/batch-meta', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    signal: controller.signal,
                    body: JSON.stringify({ urls: batch, metadata_only: true, full_metadata: true })
                });
                if (!resp.ok) throw new Error(`Metadata HTTP ${resp.status}`);
                const data = await resp.json();
                if (runId !== this._searchRunId) continue;
                for (const row of data.results || []) {
                    const result = this.results.find(r => r.url === row.url);
                    if (!result) continue;
                    result._metaError = row.ok ? '' : (row.error || 'Metadata fetch failed');
                    if (!row.ok) continue;
                    for (const key of ['duration', 'quality', 'height', 'width', 'size_bytes', 'size_mb', 'size_estimated', 'upload_date', 'thumbnail', 'title', 'tags', 'performers', 'categories', 'uploader', 'views', 'description']) {
                        if (row[key]) result[key] = row[key];
                    }
                    if (row.thumbnail) result.thumb_url = row.thumbnail;
                    if (typeof row.size_estimated === 'boolean') result.size_estimated = row.size_estimated;
                    result._metaMissing = ['duration', 'quality', 'size_bytes'].filter(key => !result[key]);
                    result._metaFetched = true;
                }
            } catch (err) {
                if (runId === this._searchRunId) this.results.filter(r => batch.includes(r.url)).forEach(r => r._metaError = err.message);
            } finally {
                clearTimeout(timer);
                this._metaControllers.delete(controller);
                batch.forEach(url => { if (this._metaPending.get(url) === runId) this._metaPending.delete(url); });
                if (runId === this._searchRunId) this.applyFilters();
                completed += batch.length;
                if (typeof onProgress === 'function') onProgress({ completed, total: pending.length });
            }
        }
        return { completed, total: pending.length };
    }

    async fetchVisibleMetadata(button) {
        const candidates = this.filteredResults.filter(result => this._usesTesterMetadata(result.url));
        if (!candidates.length) {
            this.setActivity('No metadata targets', 'No visible results support full metadata fetching.', 'idle');
            return;
        }
        const eligible = candidates.filter(result => !result._metaFetched);
        const pending = eligible.filter(result => !this._metaPending.has(result.url));
        if (!pending.length) {
            const alreadyRunning = eligible.length > 0;
            this.setActivity(
                alreadyRunning ? 'Metadata already running' : 'Metadata up to date',
                alreadyRunning ? `${eligible.length} result(s) are already being enriched.` : `All ${candidates.length} supported result(s) have metadata.`,
                alreadyRunning ? 'working' : 'done'
            );
            return;
        }

        const startedAt = Date.now();
        const elapsed = () => `${Math.floor((Date.now() - startedAt) / 1000)}s`;
        const updateProgress = ({ completed, total }) => {
            this.updateActivityProgress(`FETCHING ${completed}/${total} · ${elapsed()}`, completed, total);
        };
        this.setActivity('Fetching full metadata', `FETCHING 0/${pending.length} · 0s`, 'working');
        updateProgress({ completed: 0, total: pending.length });
        const timer = setInterval(() => {
            const detail = document.getElementById('quantumActivityDetail');
            if (detail) detail.textContent = `FETCHING ${Math.min(pending.length, this._metadataCompleted || 0)}/${pending.length} · ${elapsed()}`;
        }, 1000);
        this._metadataCompleted = 0;
        this._metadataBatchActive = true;
        if (button) { button.disabled = true; button.textContent = 'Fetching…'; }
        try {
            const runId = this._searchRunId;
            await this._prefetchTesterMetadata(runId, pending.map(result => result.url), progress => {
                this._metadataCompleted = progress.completed;
                updateProgress(progress);
            });
            if (runId !== this._searchRunId) return;
            const failed = pending.filter(result => result._metaError).length;
            const fetched = pending.length - failed;
            this.setActivity(
                failed ? 'Metadata finished with errors' : 'Metadata complete',
                `${fetched}/${pending.length} fetched${failed ? ` · ${failed} failed` : ''} · ${elapsed()}`,
                failed ? 'error' : 'done'
            );
        } catch (error) {
            this.setActivity('Metadata fetch failed', error.message || String(error), 'error');
            throw error;
        } finally {
            clearInterval(timer);
            this._metadataCompleted = 0;
            this._metadataBatchActive = false;
            const currentButton = document.getElementById('quantumFetchMetadataBtn');
            if (currentButton) { currentButton.disabled = false; currentButton.textContent = 'Fetch full meta'; }
        }
    }

    _formatCardSize(result) {
        const bytes = Number(result.size_bytes) || (Number(result.size_mb) || 0) * 1048576;
        const size = bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` :
            bytes > 0 ? `${Math.round(bytes / 1048576)} MB` : result.size || '';
        return size && result.size_estimated ? `≈ ${size}` : size;
    }

    _applyEnrichmentToCard(url, patch) {
        const card = document.querySelector(`.search-result-card[data-url="${CSS.escape(url)}"]`);
        if (!card) return;

        // Update quality badge
        if (patch.height || patch.quality_variants?.length) {
            const h = patch.height || 0;
            const qualityLabel = h >= 2160 ? '4K' : h >= 1080 ? '1080p' : h >= 720 ? '720p' : h >= 480 ? '480p' : '';
            if (qualityLabel) {
                const qb = card.querySelector('.quality-badge');
                if (qb) {
                    qb.textContent = qualityLabel;
                } else {
                    const thumb = card.querySelector('.search-result-thumbnail');
                    if (thumb) {
                        const div = document.createElement('div');
                        div.className = 'quality-badge';
                        div.textContent = qualityLabel;
                        thumb.appendChild(div);
                    }
                }
            }
        }

        // Update performers row
        if (patch.performers?.length) {
            let pRow = card.querySelector('.enrich-performers');
            if (!pRow) {
                pRow = document.createElement('div');
                pRow.className = 'enrich-performers';
                pRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:5px;';
                const content = card.querySelector('.search-result-content');
                const actions = card.querySelector('.search-result-actions');
                if (content && actions) content.insertBefore(pRow, actions);
            }
            pRow.innerHTML = patch.performers.slice(0, 4).map(p =>
                `<span style="font-size:10px;padding:1px 6px;border-radius:10px;background:rgba(168,85,247,.18);color:#c084fc;cursor:pointer;" onclick="event.stopPropagation();quantumSearch.searchPerformer('${p.replace(/'/g, "\\'")}')">${p}</span>`
            ).join('');
        }

        // Update file sizes in quality variants section
        if (patch.file_sizes && Object.keys(patch.file_sizes).length) {
            let szRow = card.querySelector('.enrich-sizes');
            if (!szRow) {
                szRow = document.createElement('div');
                szRow.className = 'enrich-sizes';
                szRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px;';
                const content = card.querySelector('.search-result-content');
                const actions = card.querySelector('.search-result-actions');
                if (content && actions) content.insertBefore(szRow, actions);
            }
            szRow.innerHTML = Object.entries(patch.file_sizes).map(([q, bytes]) => {
                const gb = bytes / 1073741824;
                const mb = bytes / 1048576;
                const szStr = gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(mb)} MB`;
                return `<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:rgba(30,200,120,.12);color:#4ade80;display:inline-flex;align-items:center;gap:3px;"><span class="material-icons-round" style="font-size:10px;">save</span>${q}: ${szStr}</span>`;
            }).join('');
        }

        // Update upload date
        if (patch.upload_date) {
            const thumbnail = card.querySelector('.search-result-thumbnail');
            let dateEl = card.querySelector('.search-result-date');
            if (!dateEl) {
                dateEl = document.createElement('span');
                dateEl.className = 'search-result-date';
                thumbnail?.appendChild(dateEl);
            }
            dateEl.title = 'Upload date';
            dateEl.textContent = patch.upload_date;
        }

        const enrichedResult = this.results.find(result => result.url === url);
        const formattedSize = enrichedResult ? this._formatCardSize(enrichedResult) : '';
        if (formattedSize) {
            const thumbnail = card.querySelector('.search-result-thumbnail');
            let sizeEl = card.querySelector('.search-result-size');
            if (!sizeEl) {
                sizeEl = document.createElement('span');
                sizeEl.className = 'search-result-size';
                thumbnail?.appendChild(sizeEl);
            }
            sizeEl.title = 'File size';
            sizeEl.textContent = formattedSize;
        }

        // Animate card to show it was enriched
        card.style.transition = 'box-shadow 0.3s';
        card.style.boxShadow = '0 0 0 1px rgba(168,85,247,0.3)';
        setTimeout(() => { card.style.boxShadow = ''; }, 1200);
    }

    searchPerformer(name) {
        const input = document.getElementById('quantumSearchInput');
        if (input) {
            input.value = name;
            this.search(name);
        }
    }

    updateSourceBadges() {
        const sources = ['all'];
        const sourceCounts = {};
        const selectedSourceKeys = this.getSearchSourceKeys();

        this.results.forEach(result => {
            const source = result.source;
            if (!sources.includes(source)) {
                sources.push(source);
            }
            sourceCounts[source] = (sourceCounts[source] || 0) + 1;
        });

        const diagLabelMap = {
            hornysimp: 'HornySimp',
            pimpbunny: 'PimpBunny',
            slutvids: 'SlutVids',
            oneporn: '1Porn',
            fpo: 'FPO',
            pornone: 'PornOne',
            porntrex: 'PornTrex',
            whoreshub: 'WhoresHub',
            camwhores: 'Camwhores',
            xvideos: 'XVideos',
            pornhub: 'Pornhub',
            xhamster: 'xHamster',
            eporner: 'Eporner',
            spankbang: 'SpankBang',
            noodlemagazine: 'NoodleMagazine',
            erome: 'Erome',
            vkvideo: 'VKVideo',
            yandex: 'Yandex',
            djav: 'DJAV'
        };

        selectedSourceKeys.forEach(key => {
            const label = this.mapSourceKeyToLabel(key);
            if (!sources.includes(label)) {
                sources.push(label);
            }
            if (sourceCounts[label] == null) sourceCounts[label] = 0;
        });

        // Map diagnostic status onto each source label so empty/failed sources
        // are visible instead of silently showing a count-less badge.
        const statusByLabel = {};
        (this.diagnostics || []).forEach(d => {
            const label = this.mapSourceKeyToLabel(d.source_key);
            // Keep the most informative status if a source reported twice.
            const prev = statusByLabel[label];
            if (!prev || (prev.status === 'ok' && d.status !== 'ok')) {
                statusByLabel[label] = d;
            }
        });

        const container = document.getElementById('quantumSearchSources');
        container.innerHTML = sources.map(source => {
            const count = source === 'all' ? this.results.length : (sourceCounts[source] || 0);
            const isActive = this.activeSource === source ? 'active' : '';
            const diag = source === 'all' ? null : statusByLabel[source];

            // Decide the trailing marker: a count when we have results, else a
            // status chip (timeout / error / empty) so nothing disappears silently.
            let suffix = '';
            let title = '';
            let extraStyle = '';
            if (count > 0) {
                suffix = `(${count})`;
            } else if (diag) {
                if (diag.status === 'running') {
                    suffix = '…'; title = 'Searching'; extraStyle = 'opacity:.7;';
                } else if (diag.status === 'timeout' || diag.status === 'partial_timeout') {
                    suffix = '⏱'; title = 'Source timed out'; extraStyle = 'opacity:.55;';
                } else if (['error','auth_required','rate_limited','parse_error','unavailable','unsupported'].includes(diag.status)) {
                    suffix = '⚠'; title = `Error: ${diag.error || 'failed'}`; extraStyle = 'opacity:.55;';
                } else {
                    suffix = '0'; title = 'No results'; extraStyle = 'opacity:.55;';
                }
            }

            return `
                <span class="source-badge ${isActive}" data-source="${source}" title="${this.escapeHtml(title)}" style="${extraStyle}" onclick="quantumSearch.filterBySource('${source}')">
                    ${source} ${suffix}
                </span>
            `;
        }).join('');
        const audit = document.getElementById('quantumSourceAudit');
        const auditRows = document.getElementById('quantumSourceAuditRows');
        if (audit && auditRows) {
            audit.style.display = this.diagnostics.length ? '' : 'none';
            audit.querySelector('summary').textContent = `Source diagnostics · ${this.diagnostics.length} selected · ${this.diagnostics.filter(d => d.status !== 'running').length} finished`;
            auditRows.innerHTML = this.diagnostics.map(d => `<div style="background:rgba(255,255,255,.05);padding:6px;border-radius:5px"><b>${this.escapeHtml(this.mapSourceKeyToLabel(d.source_key))}</b> · ${this.escapeHtml(d.status || 'empty')} · ${Number(d.shown_count ?? d.count ?? 0)} shown<br><small>${this.escapeHtml([d.raw_count ? `${d.raw_count} scanned` : '', d.query_filtered ? `${d.query_filtered} query mismatch` : '', d.quality_low ? `${d.quality_low} lower quality` : '', d.quality_unknown ? `${d.quality_unknown} unknown quality` : '', d.error || ''].filter(Boolean).join(' · ') || 'no matching results')}</small></div>`).join('');
        }
    }

    filterBySource(source) {
        this.activeSource = source;
        this.applyFilters();

        // Update active badge
        document.querySelectorAll('.source-badge').forEach(badge => {
            badge.classList.toggle('active', badge.dataset.source === source);
        });
    }

    setSearchFilter(type, value) {
        // legacy compat
        this.searchFilters[type] = [value];
        this.applyFilters();
    }

    setSort(sortBy, btn) {
        const changed = this.activeSort !== sortBy;
        this.activeSort = sortBy;
        const quickSort = document.getElementById('quantumQuickSort');
        if (quickSort) quickSort.value = sortBy;
        if (btn) {
            btn.parentElement.querySelectorAll('.refine-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        }
        this.applyFilters();
        if (changed && this._catalogPage && !this._catalogPage.newOnly && !this._catalogPage.live
            && this._catalogPage.hasMore && typeof fetch === 'function') {
            this.searchJoinedChannels(this._catalogPage.query, false, false);
        }
    }

    _syncToolbarAndRefinement(group, selectId, value, btn) {
        const strVal = String(value);
        const selectEl = document.getElementById(selectId);
        if (selectEl) selectEl.value = strVal;
        const container = btn?.parentElement || this.overlay?.querySelector(`.refinement-group[data-filter-group="${group}"]`);
        if (container) {
            container.querySelectorAll('.refine-btn').forEach(b => {
                const matches = btn ? (b === btn) : (b.dataset.filterValue === strVal);
                b.classList.toggle('active', matches);
            });
        }
    }

    setQuickQualityFilter(val, btn) {
        this._syncToolbarAndRefinement('quality', 'quantumQuickQuality', val, btn);
        this.searchFilters.quality = [val];
        const msBtn = document.getElementById('ms-btn-quality');
        if (msBtn) msBtn.textContent = val === 'all' ? 'All Qualities' : val;
        const dropdown = document.getElementById('ms-drop-quality');
        if (dropdown) {
            dropdown.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                cb.checked = (cb.value === val || (val === 'all' && cb.value === 'all'));
            });
        }
        this.applyFilters();
    }

    _wantsPortrait(orientation = this.activeFilters?.orientation) {
        return ['portrait', 'portrait_any', 'portrait_estimate'].includes(orientation);
    }

    // Backend pri vertikálnom hľadaní pridá "vertical" dopyt a aktívne zisťuje rozmery.
    _orientationQuery() {
        const orientation = this._wantsPortrait() ? '&orientation=portrait' : '';
        const quick = document.getElementById('quantumQuickSearch')?.checked ? '&quick=true' : '';
        return orientation + quick;
    }

    setOrientationFilter(orientation, btn) {
        this.activeFilters.orientation = orientation;
        if (orientation === 'portrait_estimate' || orientation === 'portrait_any') this._scanPortraitThumbnails();
        this._syncToolbarAndRefinement('orientation', 'quantumQuickOrientation', orientation, btn);
        this.applyFilters();
        // Klik na filter je len filtrovanie existujúcich výsledkov; nikdy nespúšťa nové hľadanie.
        // Na pozadí sa rýchlo overia iba neznáme výsledky.
        if (this._wantsPortrait()) this._probeUnknownOrientation();
    }

    // Aktívne zistenie skutočných rozmerov pre výsledky s neznámou orientáciou.
    async _probeUnknownOrientation(limit = 400) {
        if (typeof fetch !== 'function' || this._orientationProbeInProgress) return;
        this._orientationProbed ||= new Set();
        const selected = this.selectedUrls || new Set();
        const visibleSet = new Set((this.filteredResults || []).slice(0, 24).map(r => r?.url).filter(Boolean));
        const targets = (this.results || [])
            .filter(r => r?.url && this._videoOrientation(r).orientation === 'unknown'
                && !this._orientationProbed.has(r.url))
            .sort((a, b) => {
                const selDiff = Number(selected.has(b.url)) - Number(selected.has(a.url));
                if (selDiff !== 0) return selDiff;
                const visDiff = Number(this._isCardVisible(b.url) || visibleSet.has(b.url)) - Number(this._isCardVisible(a.url) || visibleSet.has(a.url));
                if (visDiff !== 0) return visDiff;
                return Number(b.orientation_likely === 'portrait') - Number(a.orientation_likely === 'portrait');
            })
            .slice(0, limit);
        if (!targets.length) return;
        targets.forEach(r => this._orientationProbed.add(r.url));
        this._orientationProbeInProgress = true;
        const runId = this._searchRunId;
        try {
            // Malé dávky v 3 paralelných vláknach; každá dávka sa zobrazí hneď, ako dobehne.
            const batches = [];
            for (let i = 0; i < targets.length; i += 8) batches.push(targets.slice(i, i + 8).map(r => r.url));
            let next = 0;
            const worker = async () => {
                while (next < batches.length && runId === this._searchRunId) {
                    const batch = batches[next++];
                    try {
                        const resp = await fetch('/api/v1/search/orientation', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ urls: batch, timeout_s: 6 })
                        });
                        if (!resp?.ok) continue;
                        const patches = (await resp.json())?.orientation || {};
                        for (const [url, patch] of Object.entries(patches)) {
                            const result = this.results.find(item => item.url === url);
                            if (!result) continue;
                            Object.assign(result, patch);
                            result.orientation_likely = '';
                            this._syncOrientationBadge(result);
                        }
                        if (Object.keys(patches).length && runId === this._searchRunId) this.applyFilters();
                    } catch (err) {
                        console.warn('[Orientation] batch failed:', err);
                    }
                }
            };
            await Promise.all([worker(), worker(), worker()]);
        } catch (err) {
            console.warn('[Orientation] probe failed:', err);
        } finally {
            this._orientationProbeInProgress = false;
        }
    }

    _videoOrientation(result) {
        const width = Number(result?.width) || 0;
        const height = Number(result?.height) || 0;
        if (width > 0 && height > 0) {
            return {
                orientation: width / height < 0.95 ? 'portrait' : 'landscape',
                evidence: 'video_dimensions'
            };
        }

        const declared = String(result?.orientation || '').trim().toLowerCase();
        if (declared === 'portrait' || declared === 'vertical') {
            const evidence = result.orientation_evidence;
            return { orientation: 'portrait', evidence: evidence && evidence !== 'unknown' ? evidence : 'source_metadata' };
        }
        if (declared === 'landscape' || declared === 'horizontal') {
            const evidence = result.orientation_evidence;
            return { orientation: 'landscape', evidence: evidence && evidence !== 'unknown' ? evidence : 'source_metadata' };
        }
        return { orientation: 'unknown', evidence: 'unknown' };
    }

    _hasPortraitThumbnailEstimate(result) {
        const width = Number(result?.thumbnail_width || result?.thumb_width) || 0;
        const height = Number(result?.thumbnail_height || result?.thumb_height) || 0;
        return width > 0 && height / width >= 1.1;
    }

    _orientationBadgeInfo(result) {
        const classification = this._videoOrientation(result);
        if (classification.orientation === 'portrait') {
            const fromDimensions = ['video_dimensions', 'page_dimensions', 'stream_dimensions', 'mp4_probe']
                .includes(classification.evidence);
            return {
                label: fromDimensions ? 'Vertikálne · rozmery' : 'Vertikálne · zdroj',
                title: fromDimensions ? 'Rozmery videa potvrdzujú vertikálnu orientáciu' : 'Zdroj uvádza vertikálnu orientáciu',
                estimated: false
            };
        }
        if (classification.orientation === 'unknown' && result?.orientation_likely === 'portrait') {
            const byUrl = result.orientation_evidence === 'url_hint';
            const bySource = result.orientation_evidence === 'source_prior';
            return {
                label: `Možno vertikálne · ${bySource ? 'zdroj' : byUrl ? 'URL' : 'názov/tagy'}`,
                title: 'Odhad z textu alebo URL; rozmery videa zatiaľ nie sú potvrdené',
                estimated: true
            };
        }
        if (classification.orientation === 'unknown' && this._hasPortraitThumbnailEstimate(result)) {
            return {
                label: 'Možno vertikálne · náhľad',
                title: 'Odhad podľa pomeru strán náhľadu; orientácia videa nie je potvrdená',
                estimated: true
            };
        }
        return { label: '', title: '', estimated: false };
    }

    _syncOrientationBadge(result, card = null) {
        if (!result || typeof document === 'undefined' || !document.querySelectorAll) return;
        const target = card || Array.from(document.querySelectorAll('.search-result-card'))
            .find(element => element.dataset?.url === result.url);
        const badge = target?.querySelector('.orientation-evidence-badge');
        if (!badge) return;

        const info = this._orientationBadgeInfo(result);
        badge.textContent = info.label;
        badge.title = info.title;
        badge.classList.toggle('estimated', info.estimated);
        badge.style.display = badge.textContent ? 'inline-flex' : 'none';
    }

    _isInDashboard(result) {
        if (!result) return false;
        if (result.in_dashboard) return true;
        const cache = this._libraryStatusCache;
        if (!cache || typeof cache.get !== 'function') return false;
        if (result.url && cache.get(result.url)?.in_dashboard) return true;
        if (result.source_url && cache.get(result.source_url)?.in_dashboard) return true;
        if (result.stream_url && cache.get(result.stream_url)?.in_dashboard) return true;
        if (result.chat_id && result.message_id) {
            if (cache.get(`tg:${result.chat_id}:${result.message_id}`)?.in_dashboard) return true;
            if (cache.get(`/api/v1/telegram/stream/${result.chat_id}/${result.message_id}`)?.in_dashboard) return true;
        }
        return false;
    }

    _getDashboardInfo(result) {
        if (!result) return null;
        if (result._libraryInfo) return result._libraryInfo;
        const cache = this._libraryStatusCache;
        if (!cache || typeof cache.get !== 'function') return null;
        const info = (result.url && cache.get(result.url))
            || (result.source_url && cache.get(result.source_url))
            || (result.stream_url && cache.get(result.stream_url))
            || (result.chat_id && result.message_id && (
                cache.get(`tg:${result.chat_id}:${result.message_id}`)
                || cache.get(`/api/v1/telegram/stream/${result.chat_id}/${result.message_id}`)
            )) || null;
        return (info && info.in_dashboard) ? info : null;
    }

    _syncDashboardBadge(result, card = null) {
        if (!result || typeof document === 'undefined' || !document.querySelectorAll) return;
        const target = card || Array.from(document.querySelectorAll('.search-result-card'))
            .find(element => element.dataset?.url === result.url);
        if (!target) return;

        const inDb = this._isInDashboard(result);
        const info = this._getDashboardInfo(result);
        target.classList.toggle('is-in-dashboard', inDb);

        let badge = target.querySelector('.in-dashboard-badge');
        if (badge) {
            if (inDb) {
                badge.title = `Video je už v dashboarde${info?.video_id ? ` (ID #${info.video_id})` : ''}`;
                badge.innerHTML = `<span class="material-icons-round" style="font-size:11px;vertical-align:-1px;">check_circle</span> V DASHBOARDE${info?.on_disk ? ' · DISK' : ''}`;
                badge.style.display = 'inline-flex';
            } else {
                badge.style.display = 'none';
            }
        }

        const importBtn = target.querySelector('.btn-import');
        if (importBtn && !importBtn.textContent.includes('✓') && !importBtn.textContent.includes('Resolving')) {
            if (inDb) {
                importBtn.classList.add('is-imported');
                importBtn.title = 'Video už je v dashboarde';
                importBtn.innerHTML = `<span class="material-icons-round" style="font-size: 14px;">check</span> V dashboarde`;
            } else {
                importBtn.classList.remove('is-imported');
                importBtn.title = 'Import to Library';
                importBtn.innerHTML = `<span class="material-icons-round" style="font-size: 14px;">move_to_inbox</span> Import`;
            }
        }
    }

    _queueLibraryStatusCheck() {
        if (this._libraryCheckTimer) clearTimeout(this._libraryCheckTimer);
        this._libraryCheckTimer = setTimeout(() => {
            this.checkLibraryStatus();
        }, 120);
    }

    async checkLibraryStatus(itemsToScan = null) {
        const items = itemsToScan || this.filteredResults || [];
        if (!Array.isArray(items) || items.length === 0) return;
        if (!this._libraryStatusCache) this._libraryStatusCache = new Map();

        const urlsToQuery = [];
        const queryToResult = new Map();

        for (const item of items) {
            if (item.in_dashboard) continue;
            const candidates = [item.url, item.source_url, item.stream_url].filter(Boolean);
            if (item.chat_id && item.message_id) {
                candidates.push(`/api/v1/telegram/stream/${item.chat_id}/${item.message_id}`);
            }
            let known = false;
            for (const cand of candidates) {
                if (this._libraryStatusCache.has(cand)) {
                    known = true;
                    if (this._libraryStatusCache.get(cand)?.in_dashboard) {
                        item.in_dashboard = true;
                        item._libraryInfo = this._libraryStatusCache.get(cand);
                        this._syncDashboardBadge(item);
                    }
                    break;
                }
            }
            if (!known) {
                for (const cand of candidates) {
                    if (typeof cand === 'string' && (cand.startsWith('http') || cand.startsWith('/api/'))) {
                        urlsToQuery.push(cand);
                        if (!queryToResult.has(cand)) queryToResult.set(cand, []);
                        queryToResult.get(cand).push(item);
                    }
                }
            }
        }

        const uniqueUrls = [...new Set(urlsToQuery)];
        if (!uniqueUrls.length) return;

        const batchSize = 250;
        for (let i = 0; i < uniqueUrls.length; i += batchSize) {
            const batch = uniqueUrls.slice(i, i + batchSize);
            try {
                const response = await fetch('/api/v1/videos/library-status', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ urls: batch })
                });
                if (!response.ok) continue;
                const data = await response.json().catch(() => ({}));
                const matches = data.matches || {};

                for (const url of batch) {
                    if (matches[url]) {
                        this._libraryStatusCache.set(url, matches[url]);
                    } else {
                        this._libraryStatusCache.set(url, { in_dashboard: false });
                    }
                }

                for (const [url, matchInfo] of Object.entries(matches)) {
                    const matchedItems = queryToResult.get(url) || [];
                    for (const matchedItem of matchedItems) {
                        matchedItem.in_dashboard = true;
                        matchedItem._libraryInfo = matchInfo;
                        if (matchedItem.chat_id && matchedItem.message_id) {
                            this._libraryStatusCache.set(`tg:${matchedItem.chat_id}:${matchedItem.message_id}`, matchInfo);
                        }
                        this._syncDashboardBadge(matchedItem);
                    }
                }
            } catch (err) {
                console.warn('[QS] checkLibraryStatus error:', err);
            }
        }
    }

    _recordThumbnailDimensions(result, width, height, runId = this._searchRunId, card = null) {
        if (!result || runId !== this._searchRunId || !(width > 0) || !(height > 0)) return;
        const wasEstimated = this._hasPortraitThumbnailEstimate(result);
        result.thumbnail_width = width;
        result.thumbnail_height = height;
        result.thumbnail_orientation_checked = true;
        const isEstimated = this._hasPortraitThumbnailEstimate(result);
        this._syncOrientationBadge(result, card);
        if (wasEstimated !== isEstimated && ['portrait_estimate', 'portrait_any'].includes(this.activeFilters.orientation)) {
            this._queueOrientationFilterRefresh();
        }
    }

    _queueOrientationFilterRefresh() {
        if (this._orientationRefreshPending) return;
        this._orientationRefreshPending = true;
        const refresh = () => {
            this._orientationRefreshPending = false;
            if (['portrait_estimate', 'portrait_any'].includes(this.activeFilters.orientation)) this.applyFilters();
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(refresh);
        else setTimeout(refresh, 0);
    }

    _scanPortraitThumbnails() {
        if (typeof Image === 'undefined' || this._orientationThumbnailScanInProgress) return;
        const groups = new Map();
        for (const result of this.results || []) {
            if (this._videoOrientation(result).orientation !== 'unknown'
                || result.thumbnail_orientation_checked
                || !(result.thumb_url || result.thumbnail)) continue;
            const source = result.source_key || result.source || 'unknown';
            if (!groups.has(source)) groups.set(source, []);
            groups.get(source).push(result);
        }

        const candidates = [];
        const sourceGroups = [...groups.values()];
        for (let index = 0; index < Math.max(0, ...sourceGroups.map(group => group.length))
            && candidates.length < 48; index++) {
            for (const group of sourceGroups) {
                if (group[index]) candidates.push(group[index]);
                if (candidates.length >= 48) break;
            }
        }

        this._orientationThumbnailPending ||= new Set();
        const targets = candidates.filter(result => !this._orientationThumbnailPending.has(result.url));
        if (!targets.length) return;
        targets.forEach(result => this._orientationThumbnailPending.add(result.url));
        this._orientationThumbnailScanInProgress = true;
        let nextIndex = 0;
        let active = 0;
        const runId = this._searchRunId;
        const pump = () => {
            if (runId !== this._searchRunId) {
                if (!active) {
                    targets.forEach(result => this._orientationThumbnailPending.delete(result.url));
                    this._orientationThumbnailScanInProgress = false;
                }
                return;
            }
            while (active < 4 && nextIndex < targets.length) {
                const result = targets[nextIndex++];
                active++;
                const image = new Image();
                const finish = () => {
                    active--;
                    this._orientationThumbnailPending.delete(result.url);
                    if (nextIndex === targets.length && active === 0) {
                        this._orientationThumbnailScanInProgress = false;
                        return;
                    }
                    pump();
                };
                image.onload = () => {
                    if (image.naturalWidth && image.naturalHeight) {
                        this._recordThumbnailDimensions(result, image.naturalWidth, image.naturalHeight, runId);
                    } else {
                        result.thumbnail_orientation_checked = true;
                    }
                    finish();
                };
                image.onerror = () => {
                    result.thumbnail_orientation_checked = true;
                    finish();
                };
                if ('fetchPriority' in image) image.fetchPriority = 'low';
                image.src = this.proxifyThumbnail(
                    result.thumb_url || result.thumbnail,
                    result.source_url || result.url || ''
                );
            }
        };
        pump();
    }

    setDurationFilter(minSeconds, btn) {
        const sec = Number(minSeconds) || 0;
        this.activeFilters.duration = sec;
        this._syncToolbarAndRefinement('duration', 'quantumQuickDuration', sec, btn);
        this.applyFilters();
    }

    applyFilters() {
        let results = [...this.results];
        const excluded = (document.getElementById('telegramExcludeInput')?.value || '').toLocaleLowerCase().split(',').map(s => s.trim()).filter(Boolean);
        if (excluded.length) results = results.filter(r => {
            const content = [r.title, r.text, r.caption, r.file_name, r.scene_title, r.performers, r.tags, r.source_channels].flat(Infinity).filter(Boolean).join(' ').toLocaleLowerCase();
            return !excluded.some(term => content.includes(term));
        });

        // Filter by source
        if (this.activeSource !== 'all') {
            results = results.filter(r => r.source === this.activeSource);
        }

        // Filter by Omni-Search layer
        if (this.searchMode === 3 && this.activeOmegaLayer && this.activeOmegaLayer !== 'all') {
            results = results.filter(r => {
                const layer = r.layer || '';
                if (this.activeOmegaLayer === 'kvs_wp') return layer === 'kvs' || layer === 'wp_dle';
                return layer === this.activeOmegaLayer;
            });
        }

        // Filter by quality (search-time refinement)
        if (!this.searchFilters.quality.includes('all') && this.searchFilters.quality.length > 0) {
            results = results.filter(r => {
                const itemQ = (r.quality || "").toLowerCase();
                const rawHeight = parseInt(r.effective_res || r.height || r.quality_height || 0);
                const rawWidth = parseInt(r.width || 0);
                const h = (!r.effective_res && rawWidth > 0 && rawHeight > 0) ? Math.min(rawWidth, rawHeight) : rawHeight;
                let qHeight = h || (itemQ.includes('4k') ? 2160 : itemQ.includes('1440') ? 1440 : itemQ.includes('1080') ? 1080 : itemQ.includes('720') ? 720 : itemQ.includes('480') ? 480 : 0);
                if (!qHeight) {
                    const blob = `${itemQ} ${r.title || ''} ${r.file_name || ''}`.toLowerCase();
                    if (blob.includes('4k') || blob.includes('2160')) qHeight = 2160;
                    else if (blob.includes('1440') || blob.includes('2k')) qHeight = 1440;
                    else if (blob.includes('1080')) qHeight = 1080;
                    else if (blob.includes('720') || blob.includes('hd')) qHeight = 720;
                    else if (blob.includes('480')) qHeight = 480;
                }
                return this.searchFilters.quality.some(q => {
                    q = q.toLowerCase();
                    if (q === '4k') return qHeight >= 2160;
                    if (q === '1080p') return qHeight >= 1080;
                    if (q === '720p' || q === 'hd') return qHeight >= 720;
                    if (q === '480p') return qHeight >= 480;
                    return true;
                });
            });
        }

        // Filter by duration
        if (this.activeFilters.duration > 0) {
            results = results.filter(r => {
                const d = this.parseDuration(r.duration);
                return d >= this.activeFilters.duration;
            });
        }

        // Filter by minimum file size (items without a known size stay visible)
        const minSizeMb = this.requestedMinSizeMb();
        if (minSizeMb > 0) {
            results = results.filter(r => {
                const bytes = Number(r.size_bytes) || (Number(r.size_mb) || 0) * 1048576;
                return !bytes || bytes >= minSizeMb * 1048576;
            });
        }

        // Filter by orientation
        if (this.activeFilters.orientation && this.activeFilters.orientation !== 'all') {
            results = results.filter(result => {
                const orientation = this._videoOrientation(result).orientation;
                const estimated = orientation === 'unknown'
                    && (this._hasPortraitThumbnailEstimate(result) || result.orientation_likely === 'portrait');
                if (this.activeFilters.orientation === 'portrait_estimate') return estimated;
                if (this.activeFilters.orientation === 'portrait_any') return orientation === 'portrait' || estimated;
                return orientation === this.activeFilters.orientation;
            });
        }
        // Apply Sorting
        if (this.activeSort === 'views') {
            results.sort((a, b) => (b.views || 0) - (a.views || 0));
        } else if (this.activeSort === 'date') {
            results.sort((a, b) => {
                const dateA = this.parseDate(a.upload_date || a.date);
                const dateB = this.parseDate(b.upload_date || b.date);
                if (dateB !== dateA) return dateB - dateA;
                return (b.id || 0) - (a.id || 0);
            });
        } else if (this.activeSort === 'duration') {
            results.sort((a, b) => this.parseDuration(b.duration) - this.parseDuration(a.duration));
        } else if (this.activeSort === 'quality') {
            const qMap = { '4k': 4, '1080p': 3, '720p': 2, 'hd': 1 };
            results.sort((a, b) => {
                const qA = qMap[(a.quality || "").toLowerCase()] || 0;
                const qB = qMap[(b.quality || "").toLowerCase()] || 0;
                return qB - qA;
            });
        } else if (this.activeSort === 'size') {
            results.sort((a, b) => (b.size_bytes || 0) - (a.size_bytes || 0));
        } else if (this.activeSort === 'relevance' && this.searchMode === 2) {
            results.sort((a, b) => {
                const left = a.quantum_v2_rank || [];
                const right = b.quantum_v2_rank || [];
                for (let i = 0; i < Math.max(left.length, right.length); i++) {
                    if ((right[i] || 0) !== (left[i] || 0)) return (right[i] || 0) - (left[i] || 0);
                }
                return 0;
            });
        } else if (this.activeSort === 'relevance' && this.searchMode === 3) {
            results.sort((a, b) => (b.omega_relevance || 0) - (a.omega_relevance || 0));
        }

        const baseLimit = Math.min(2000, Math.max(1, parseInt(document.getElementById('searchLimitTotal')?.value) || 100));
        const tgLimit = typeof this.getTelegramLimit === 'function' ? this.getTelegramLimit() : 0;
        const isTgMode = results.length > 0 && results.every(r => (r.source || '').toLowerCase() === 'telegram');
        const limitTotal = isTgMode ? Math.max(baseLimit, tgLimit, this._telegramMultiLimit || 0, this._catalogPage ? this.results.length : 0) : baseLimit;
        this._filteredBeforeLimit = results.length;
        this.filteredResults = (this.searchMode === 2 || this.searchMode === 3 || isTgMode) ? results.slice(0, limitTotal) : this.fairResultLimit(results, limitTotal);
        this.renderResults();
        this.updateSelectionToolbar();
        this._queueLibraryStatusCheck();
    }

    parseDate(d) {
        if (!d) return 0;
        if (typeof d === 'number') return d;
        const time = Date.parse(d);
        if (!isNaN(time)) return time;
        const match = String(d).match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
        if (match) {
            return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3])).getTime();
        }
        return 0;
    }

    parseDuration(d) {
        if (!d) return 0;
        if (typeof d === 'number') return d;
        const dStr = String(d).toLowerCase();
        
        // Handle format like 12:34 or 1:23:45
        if (dStr.includes(':')) {
            const parts = dStr.split(':').map(p => parseInt(p) || 0);
            if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
            if (parts.length === 2) return parts[0] * 60 + parts[1];
        }
        
        // Handle "10 min", "5 sec"
        const m = dStr.match(/(\d+)\s*min/);
        const s = dStr.match(/(\d+)\s*sec/);
        let total = 0;
        if (m) total += parseInt(m[1]) * 60;
        if (s) total += parseInt(s[1]);
        if (total > 0) return total;

        return parseInt(dStr) || 0;
    }

    renderResults() {
        if (this.filteredResults.length === 0) {
            const container = document.getElementById('quantumSearchResults');
            document.getElementById('quantumSearchStats').style.display = 'none';
            const diagNote = this.getDiagnosticsNote();
            container.innerHTML = `
                <div class="quantum-search-empty" style="grid-column:1/-1;">
                    <div class="quantum-search-empty-icon">😶</div>
                    <div class="quantum-search-empty-text">${this._catalogPage?.newOnly && this.results.length ? 'Žiadne načítané videá nevyhovujú filtrom. Uprav filtre a zobrazia sa ďalšie.' : this._catalogPage?.live ? 'Zatiaľ sa nenašli ďalšie nové videá.' : this._catalogPage?.newOnly ? 'V indexe zatiaľ nie sú ďalšie videá mimo knižnice.' : 'No results found. Try a different query.'}</div>
                    ${diagNote ? `<div style="margin-top:10px; font-size:12px; color:rgba(255,255,255,0.55); max-width:760px; text-align:center;">${this.escapeHtml(diagNote)}</div>` : ''}
                </div>`;
            return;
        }
        this.renderResultsList();
    }

    getDiagnosticsNote() {
        if (!Array.isArray(this.diagnostics) || this.diagnostics.length === 0) return '';
        if (this.activeSource === 'all') {
            const finished = this.diagnostics.filter(d => d.status !== 'running');
            const filtered = finished.filter(d => d.status === 'filtered').length;
            const unavailable = finished.filter(d => ['timeout','partial_timeout','error','auth_required','rate_limited','parse_error','unavailable','unsupported'].includes(d.status)).length;
            return `${finished.length}/${this.diagnostics.length} sources finished · ${filtered} filtered by query or quality · ${unavailable} unavailable. Open Source diagnostics for details.`;
        }
        const selected = this.activeSource !== 'all'
            ? this.diagnostics.filter(d => (d.source_key || '').toLowerCase() === this.activeSource.toLowerCase() || this.mapSourceKeyToLabel(d.source_key) === this.activeSource)
            : this.diagnostics.filter(d => (d.count || 0) === 0 || d.status !== 'ok');
        if (!selected.length) return '';
        return selected.map(d => {
            const label = this.mapSourceKeyToLabel(d.source_key);
            if (d.status === 'running') return `${label}: searching`;
            if (d.status === 'timeout' || d.status === 'partial_timeout') return `${label}: timeout`;
            if (['error','auth_required','rate_limited','parse_error','unavailable','unsupported'].includes(d.status)) return `${label}: ${d.error || d.status}`;
            if (d.status === 'filtered') return `${label}: ${d.query_filtered || 0} query mismatches, ${d.quality_low || 0} below quality, ${d.quality_unknown || 0} unknown quality`;
            if ((d.count || 0) === 0) return `${label}: 0 indexed matches for this query`;
            return `${label}: ${d.count}`;
        }).join(' • ');
    }

    mapSourceKeyToLabel(key) {
        const catalogSource = this.sourceCatalog.find(source => source.id === key);
        if (catalogSource) return catalogSource.label;
        const map = {
            hornysimp: 'HornySimp',
            pimpbunny: 'PimpBunny',
            slutvids: 'SlutVids',
            oneporn: '1Porn',
            fpo: 'FPO',
            pornone: 'PornOne',
            xvideos: 'XVideos',
            pornhub: 'Pornhub',
            xhamster: 'xHamster',
            eporner: 'Eporner',
            spankbang: 'SpankBang',
            noodlemagazine: 'NoodleMagazine',
            erome: 'Erome',
            vkvideo: 'VKVideo',
            yandex: 'Yandex',
            djav: 'DJAV'
        };
        return map[key] || key || 'unknown';
    }

    proxifyThumbnail(url, referer = '') {
        if (!url || !/^https?:/i.test(url)) return url || '';
        return `/api/v1/image-proxy?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(referer || '')}`;
    }

    renderResultsList() {
        const container = document.getElementById('quantumSearchResults');
        const stats = document.getElementById('quantumSearchStats');
        const countEl = document.getElementById('quantumResultCount');

        if (!container) return;

        // Show stats
        stats.style.display = 'flex';
        countEl.textContent = this._filteredBeforeLimit > this.filteredResults.length
            ? `${this.filteredResults.length} / ${this._filteredBeforeLimit}`
            : this.filteredResults.length;
        if (this.globalTelegram && this._lastTelegramSource === 'fts5_local') {
            countEl.innerHTML += ' <span style="background:rgba(168,85,247,0.2);color:#c084fc;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:600;margin-left:6px;">⚡ FTS5 Instant</span>';
        }

        // "Load more" — only meaningful when a single source is selected,
        // and only if we haven't already hit the hard per-source ceiling (200).
        const actionsEl = stats.querySelector('.quantum-search-actions');
        if (actionsEl) {
            const existing = document.getElementById('quantumLoadMoreBtn');
            const src = this.activeSource;
            const loaded = this._sourceLoaded ? (this._sourceLoaded[src] || 0) : 0;
            const canLoadMore = src && src !== 'all' && loaded < 200;
            if (canLoadMore) {
                if (!existing) {
                    const btn = document.createElement('button');
                    btn.className = 'quantum-btn';
                    btn.id = 'quantumLoadMoreBtn';
                    btn.onclick = () => this.loadMoreSource(this.activeSource);
                    actionsEl.insertBefore(btn, actionsEl.firstChild);
                }
                const b = document.getElementById('quantumLoadMoreBtn');
                if (b && !b.disabled) b.textContent = `Load more · ${src}`;
            } else if (existing) {
                existing.remove();
            }
        }

        const existingCards = typeof container.querySelectorAll === 'function'
            ? Array.from(container.querySelectorAll('.search-result-card'))
            : [];
        if (existingCards.length > 0 && typeof container.insertBefore === 'function' && typeof document.createElement === 'function') {
            this._reconcileResultCards(container, existingCards);
        } else {
            container.innerHTML = this.filteredResults.map((result, index) => this._buildResultCardHtml(result, index)).join('');
            this._bindCardEvents(container);
        }

        this.updateSelectionToolbar();
        this._queueLibraryStatusCheck();
    }

    _formatResultDuration(d) {
        if (!d) return '';
        const dStr = String(d).toLowerCase();
        if (dStr.includes(':') || dStr.includes('min') || dStr.includes('sec')) return d;
        const secs = parseInt(d);
        if (isNaN(secs) || secs <= 0) return d;
        const hh = Math.floor(secs / 3600);
        const mm = Math.floor((secs % 3600) / 60);
        const ss = secs % 60;
        if (hh > 0) return `${hh}:${mm.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
        return `${mm}:${ss.toString().padStart(2, '0')}`;
    }

    _cardThumbnailUrl(result) {
        const source = result.thumb_url || result.thumbnail || ((result.source || '').toLowerCase() === 'telegram' && result.chat_id && result.message_id ? `/api/v1/telegram/thumb/${result.chat_id}/${result.message_id}` : '');
        return this.proxifyThumbnail(source, result.source_url || result.url || '');
    }

    _cardThumbnailHtml(url, safeTitle) {
        const thumbUrl = this.escapeHtml(url);
        return thumbUrl
            ? `<img src="${thumbUrl}" class="thumb-backdrop" aria-hidden="true" alt="">
               <img src="${thumbUrl}" class="thumb-main" alt="${safeTitle}" loading="lazy" decoding="async" onerror="this.style.display='none'; if(!this.parentElement.querySelector('.thumbnail-placeholder')){ let el=document.createElement('div'); el.className='thumbnail-placeholder'; el.innerText='🎬'; el.style.position='absolute'; el.style.top='0'; el.style.left='0'; el.style.right='0'; el.style.bottom='0'; el.style.display='flex'; el.style.alignItems='center'; el.style.justifyContent='center'; el.style.fontSize='48px'; el.style.background='#1a1a1a'; el.style.zIndex='2'; this.parentElement.prepend(el); }">`
            : `<div class="thumbnail-placeholder" style="position:absolute; top:0; left:0; right:0; bottom:0; display:flex; align-items:center; justify-content:center; font-size:48px; background='#1a1a1a'; z-index:2;">🎬</div>`;

    }

    _buildResultCardHtml(result, index = 0) {
        const displayIndex = Math.min(index, 20);
        const rKey = this._resultKey(result);
        const orientationBadge = this._orientationBadgeInfo(result);
        const playUrl = this._playUrlForResult(result);
        const playLabel = String(playUrl).includes('/telegram/stream/') ? 'Prehrať' : 'Play';
        const safeTitle = this.escapeHtml(result.title || '');
        const thumbnailHTML = this._cardThumbnailHtml(this._cardThumbnailUrl(result), safeTitle);
        const duration = result.duration || '';
        const h = parseInt(result.height) || 0;
        const quality = h >= 2160 ? '4K' : h >= 1440 ? '1440p' : h >= 1080 ? '1080p' : h >= 720 ? '720p' : h >= 480 ? '480p' : (result.quality || '');
        const size = this._formatCardSize(result);
        const formattedDuration = this._formatResultDuration(duration);
        const qualityBadge = quality ? `<div class="quality-badge" title="${result.quality_evidence === 'source_badge' && !h ? 'Source label; stream not verified' : 'Resolution from metadata'}">${this.escapeHtml(quality)}${result.quality_evidence === 'source_badge' && !h ? ' · source' : ''}</div>` : '';
        const durationBadge = formattedDuration ? `<div class="duration-badge">${formattedDuration}</div>` : '';
        const sourceLabel = this.escapeHtml(result.source || 'Unknown');
        const sourceBadge = `<span class="search-result-source" title="${sourceLabel}">${sourceLabel}</span>`;
        const dateBadge = result.upload_date
            ? `<span class="search-result-date" title="Upload date">${this.escapeHtml(result.upload_date)}</span>` : '';
        const sizeBadge = size
            ? `<span class="search-result-size" title="File size">${this.escapeHtml(size)}</span>` : '';
        const countBadge = (result.video_count > 1) ? `<div class="count-badge">📦 ${result.video_count}</div>` : '';
        const coverageBadge = this.searchMode === 2 && result.quantum_v2_coverage
            ? `<div class="quantum-v2-coverage" title="Matched search concepts">${this.escapeHtml(result.quantum_v2_coverage)} concepts</div>` : '';

        const isEnrichable = result.url && (
            result.url.includes('xvideos.com') || result.url.includes('pornhub.com') ||
            result.url.includes('xhamster.com') || result.url.includes('eporner.com')
        );
        const enrichStatus = isEnrichable
            ? `<span class="enrich-status" style="display:none;position:absolute;top:6px;right:6px;z-index:10;background:rgba(0,0,0,.65);border-radius:4px;padding:2px 5px;font-size:9px;color:rgba(168,85,247,.9);align-items:center;gap:3px;"><span class="quantum-search-loading active" style="position:static;width:8px;height:8px;border-width:1.5px;border-color:rgba(168,85,247,.3);border-top-color:#a855f7;"></span>enriching</span>`
            : '';

        const isSelected = !!(this.selectedUrls && this.selectedUrls.has(result.url));
        const inDashboard = this._isInDashboard(result);
        const dashboardInfo = inDashboard ? this._getDashboardInfo(result) : null;
        const dashboardBadge = `<span class="in-dashboard-badge" title="Video je už v dashboarde${dashboardInfo?.video_id ? ` (ID #${dashboardInfo.video_id})` : ''}" style="${inDashboard ? '' : 'display:none;'}"><span class="material-icons-round" style="font-size:11px;vertical-align:-1px;">check_circle</span> V DASHBOARDE${inDashboard && dashboardInfo?.on_disk ? ' · DISK' : ''}</span>`;
        return `
            <div class="search-result-card ${isSelected ? 'is-selected' : ''} ${inDashboard ? 'is-in-dashboard' : ''}" data-url="${this.escapeHtml(result.url || '')}" data-result-key="${this.escapeHtml(rKey)}" style="animation-delay: ${displayIndex * 0.05}s">
                <div class="search-result-thumbnail" data-stream-url="${this.escapeHtml(playUrl)}" data-stream-title="${this.escapeHtml(result.title || '')}">
                    <label class="quantum-card-select-label ${isSelected ? 'checked' : ''}" onclick="event.stopPropagation()" title="Vybrať video na import">
                        <input type="checkbox" class="quantum-card-checkbox" data-card-url="${this.escapeHtml(result.url || '')}" ${isSelected ? 'checked' : ''}>
                        <span class="quantum-card-checkmark"></span>
                    </label>
                    ${enrichStatus}
                    ${thumbnailHTML}
                    ${dashboardBadge}
                    <span class="orientation-evidence-badge ${orientationBadge.estimated ? 'estimated' : ''}" title="${orientationBadge.title}" style="${orientationBadge.label ? '' : 'display:none'}">${orientationBadge.label}</span>
                    ${qualityBadge}
                    ${durationBadge}
                    ${countBadge}
                    ${coverageBadge}
                    ${dateBadge}
                    ${sizeBadge}
                    ${sourceBadge}
                    <div class="play-overlay">
                        <div class="play-icon">▶</div>
                    </div>
                </div>
                <div class="search-result-content">
                    ${String(result.source || '').toLowerCase() === 'telegram' && (result.scene_title || result.platform || result.tags?.length) ? `<div class="tg-video-details">${[result.platform, result.scene_title, ...(Array.isArray(result.tags) ? result.tags : [])].filter(Boolean).map(value => `<span>${this.escapeHtml(value)}</span>`).join(' ')}</div>` : ''}
                    ${Array.isArray(result.source_channels) && result.source_channels.length ? `<div class="tg-found-in">Nájdené v: ${result.source_channels.map(name => this.escapeHtml(name)).join(', ')}</div>` : ''}
                    ${this._topicChip(result)}
                    ${(result._metaError || result._metaMissing?.length) ? `<div class="search-result-status">
                        ${result._metaError ? `<span title="${this.escapeHtml(result._metaError)}">Meta fetch failed · retry</span>` : ''}
                        ${result._metaMissing?.length ? `<span title="Source did not provide: ${this.escapeHtml(result._metaMissing.join(', '))}">Partial meta</span>` : ''}
                    </div>` : ''}
                    ${(result.views || result.reactions || result.rating) ? `<div class="search-result-extra-meta">
                        ${result.views ? `<span style="display:inline-flex;align-items:center;gap:2px;"><span class="material-icons-round" style="font-size:12px;opacity:.6;">visibility</span>${typeof result.views === 'number' ? result.views.toLocaleString() : result.views}</span>` : ''}
                        ${result.reactions ? `<span style="display:inline-flex;align-items:center;gap:2px;color:#f43f5e;" title="Reakcie"><span class="material-icons-round" style="font-size:12px;">favorite</span>${typeof result.reactions === 'number' ? result.reactions.toLocaleString() : result.reactions}</span>` : ''}
                        ${result.rating ? `<span style="color:#fbbf24;display:inline-flex;align-items:center;gap:1px;"><span class="material-icons-round" style="font-size:11px;">star</span>${result.rating}%</span>` : ''}
                    </div>` : ''}
                    <div class="search-result-title" title="${safeTitle}" data-stream-url="${this.escapeHtml(playUrl)}" data-stream-title="${this.escapeHtml(result.title || '')}">${safeTitle}</div>
                    <div class="search-result-actions">
                        ${this._usesTesterMetadata(result.url) ? `<button class="action-btn" data-meta-url="${this.escapeHtml(result.url)}" title="Fetch duration, quality, size and date">${this._metaPending.has(result.url) ? 'Fetching…' : 'Fetch meta'}</button>` : ''}
                        ${(() => {
                            const megaHubTarget = (Array.isArray(result.mega_urls) && result.mega_urls.length > 0)
                                ? result.mega_urls[0]
                                : (/(?:^|\/\/)(?:www\.)?mega\.(?:nz|co\.nz)\/(?:folder|file)\//i.test(result.url || '') ? result.url : '');
                            return megaHubTarget
                                ? `<button class="action-btn btn-mega-hub" data-mega-hub-url="${this.escapeHtml(megaHubTarget)}" data-mega-hub-title="${safeTitle}" title="Pridať priamy MEGA odkaz do MEGA Hubu">📦 MEGA</button>`
                                : '';
                        })()}
                        <button class="action-btn btn-stream" data-stream-url="${this.escapeHtml(playUrl)}" data-stream-title="${this.escapeHtml(result.title || '')}" title="Play Now">
                            <span class="material-icons-round" style="font-size: 14px;">play_arrow</span> ${playLabel}
                        </button>
                        <button class="action-btn btn-download" onclick="event.stopPropagation(); quantumSearch.downloadVideo('${result.url}', '${result.title.replace(/'/g, "\\'")}', this)" title="Download">
                            <span class="material-icons-round" style="font-size: 14px;">download</span> DL
                        </button>
                        <button class="action-btn btn-import ${inDashboard ? 'is-imported' : ''}" data-import-url="${this.escapeHtml(result.url || '')}" title="${inDashboard ? 'Video už je v dashboarde' : 'Import to Library'}">
                            <span class="material-icons-round" style="font-size: 14px;">${inDashboard ? 'check' : 'move_to_inbox'}</span> ${inDashboard ? 'V dashboarde' : 'Import'}
                        </button>
                        <button class="action-btn btn-stash ${result._stashed ? 'is-stashed' : ''}" data-stash-url="${this.escapeHtml(result.url || '')}" title="Odložiť do kolekcie na neskôr (bez importu)">
                            <span class="material-icons-round" style="font-size: 14px;">${result._stashed ? 'bookmark' : 'bookmark_border'}</span> ${result._stashed ? 'Odložené' : 'Odložiť'}
                        </button>
                        <button class="action-btn btn-share" data-share-url="${this.escapeHtml(result.url || '')}" title="${String(result.source || '').toLowerCase() === 'telegram' || result.chat_id ? 'Zdieľať odkaz (vyžaduje prístup k súkromnému Telegram chatu)' : 'Zdieľať odkaz'}" style="flex:0; padding: 4px 8px;">
                            <span class="material-icons-round" style="font-size: 14px;">share</span>
                        </button>
                        <button class="action-btn" onclick="event.stopPropagation(); window.open('${result.url}', '_blank')" title="Open Source" style="flex:0; padding: 4px 8px;">
                            <span class="material-icons-round" style="font-size: 14px;">launch</span>
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    _patchExistingCardDom(card, result) {
        if (!card || !result) return;
        const isSelected = !!(this.selectedUrls && this.selectedUrls.has(result.url));
        card.classList.toggle('is-selected', isSelected);
        const selectLabel = card.querySelector('.quantum-card-select-label');
        if (selectLabel) selectLabel.classList.toggle('checked', isSelected);
        const cb = card.querySelector('.quantum-card-checkbox');
        if (cb && cb.checked !== isSelected) cb.checked = isSelected;

        this._syncDashboardBadge(result, card);
        this._syncOrientationBadge(result, card);

        const thumb = card.querySelector('.search-result-thumbnail');
        const thumbUrl = this._cardThumbnailUrl(result);
        if (thumb && thumbUrl && thumb.querySelector('.thumb-main')?.getAttribute('src') !== thumbUrl) {
            thumb.querySelectorAll('.thumb-main, .thumb-backdrop, .thumbnail-placeholder').forEach(node => node.remove());
            thumb.insertAdjacentHTML('afterbegin', this._cardThumbnailHtml(thumbUrl, this.escapeHtml(result.title || '')));
            this._bindThumbnailDimensions(card);
        }
        const h = parseInt(result.height) || 0;
        const quality = h >= 2160 ? '4K' : h >= 1440 ? '1440p' : h >= 1080 ? '1080p' : h >= 720 ? '720p' : h >= 480 ? '480p' : (result.quality || '');
        if (quality && thumb) {
            let qb = card.querySelector('.quality-badge');
            if (!qb) {
                qb = document.createElement('div');
                qb.className = 'quality-badge';
                thumb.appendChild(qb);
            }
            qb.textContent = `${quality}${result.quality_evidence === 'source_badge' && !h ? ' · source' : ''}`;
        }

        const formattedDuration = this._formatResultDuration(result.duration || '');
        if (formattedDuration && thumb) {
            let db = card.querySelector('.duration-badge');
            if (!db) {
                db = document.createElement('div');
                db.className = 'duration-badge';
                thumb.appendChild(db);
            }
            db.textContent = formattedDuration;
        }

        const size = this._formatCardSize(result);
        if (size && thumb) {
            let sb = card.querySelector('.search-result-size');
            if (!sb) {
                sb = document.createElement('span');
                sb.className = 'search-result-size';
                sb.title = 'File size';
                thumb.appendChild(sb);
            }
            sb.textContent = size;
        }

        if (result.upload_date && thumb) {
            let dt = card.querySelector('.search-result-date');
            if (!dt) {
                dt = document.createElement('span');
                dt.className = 'search-result-date';
                dt.title = 'Upload date';
                thumb.appendChild(dt);
            }
            dt.textContent = result.upload_date;
        }

        const metaBtn = card.querySelector('[data-meta-url]');
        if (metaBtn) {
            const pending = this._metaPending.has(result.url);
            metaBtn.disabled = pending;
            metaBtn.textContent = pending ? 'Fetching…' : 'Fetch meta';
        }
    }

    _reconcileResultCards(container, existingCards) {
        const emptyEl = container.querySelector('.quantum-search-empty');
        if (emptyEl) emptyEl.remove();

        const byUrl = new Map();
        for (const card of existingCards) {
            const u = card.dataset?.url;
            if (u && !byUrl.has(u)) byUrl.set(u, card);
        }

        const targetUrls = new Set();
        const activeEl = (typeof document !== 'undefined') ? document.activeElement : null;

        this.filteredResults.forEach((result, index) => {
            const url = result.url || '';
            targetUrls.add(url);
            let card = byUrl.get(url);
            if (card) {
                this._patchExistingCardDom(card, result);
            } else {
                const wrapper = document.createElement('div');
                wrapper.innerHTML = this._buildResultCardHtml(result, index).trim();
                card = wrapper.firstElementChild;
                if (card) {
                    this._bindCardEvents(card);
                    byUrl.set(url, card);
                }
            }
            if (!card) return;
            const currentAtSlot = container.children[index];
            if (currentAtSlot !== card) {
                // Ak má používateľ fokus vo vnútri karty, nepresúvame uzol, ak by tým stratil fokus
                const hasFocusInside = activeEl && typeof card.contains === 'function' && card.contains(activeEl);
                container.insertBefore(card, currentAtSlot || null);
                if (hasFocusInside && typeof activeEl.focus === 'function') {
                    try { activeEl.focus({ preventScroll: true }); } catch (_) {}
                }
            }
        });

        for (const [url, card] of byUrl.entries()) {
            if (!targetUrls.has(url)) {
                card.remove();
            }
        }
    }

    _bindThumbnailDimensions(scope) {
        scope.querySelectorAll('.search-result-thumbnail img.thumb-main').forEach(image => {
            const recordDimensions = () => {
                if (!image.naturalWidth || !image.naturalHeight) return;
                const card = image.closest('.search-result-card');
                const result = (this.results || []).find(item => item.url === card?.dataset.url);
                if (result) this._recordThumbnailDimensions(
                    result, image.naturalWidth, image.naturalHeight, this._searchRunId, card
                );
            };
            image.addEventListener('load', recordDimensions, { once: true });
            if (image.complete && image.naturalWidth) recordDimensions();
        });
    }

    _bindCardEvents(scope) {
        if (!scope || typeof scope.querySelectorAll !== 'function') return;
        this._bindThumbnailDimensions(scope);
        scope.querySelectorAll('[data-stream-url]').forEach(element => {
            element.addEventListener('click', event => {
                event.stopPropagation();
                const card = element.closest('.search-result-card');
                const result = (this.filteredResults || []).find(item => item.url === card?.dataset.url)
                    || (this.results || []).find(item => item.url === card?.dataset.url);
                this.streamResult(element.dataset.streamUrl || '', element.dataset.streamTitle || '', result);
            });
        });
        scope.querySelectorAll('[data-meta-url]').forEach(element => {
            element.disabled = this._metaPending.has(element.dataset.metaUrl);
            element.addEventListener('click', event => {
                event.stopPropagation();
                this._prefetchTesterMetadata(this._searchRunId, [element.dataset.metaUrl]);
                this.renderResultsList();
            });
        });
        scope.querySelectorAll('[data-import-url]').forEach(element => {
            element.addEventListener('click', event => {
                event.stopPropagation();
                this.importVideo(element.dataset.importUrl || '', element);
            });
        });
        scope.querySelectorAll('[data-stash-url]').forEach(element => {
            element.addEventListener('click', event => {
                event.stopPropagation();
                this.stashResult(element.dataset.stashUrl || '', element);
            });
        });
        scope.querySelectorAll('[data-share-url]').forEach(element => {
            element.addEventListener('click', event => {
                event.stopPropagation();
                this.shareResult(element.dataset.shareUrl || '', element);
            });
        });
        scope.querySelectorAll('[data-mega-hub-url]').forEach(element => {
            element.addEventListener('click', event => {
                event.stopPropagation();
                this.sendDirectMegaUrlToHub(element.dataset.megaHubUrl || '', element.dataset.megaHubTitle || '', element);
            });
        });

        scope.querySelectorAll('.quantum-card-checkbox').forEach(cb => {
            cb.addEventListener('change', event => {
                event.stopPropagation();
                this.toggleSelect(cb.dataset.cardUrl || '', cb.checked);
            });
        });
        scope.querySelectorAll('.tg-topic-chip').forEach(button => {
            button.addEventListener('click', event => {
                event.stopPropagation();
                this.scrapeTelegramTopic(button.dataset.topicChannel, button.dataset.topicId, button.dataset.topicTitle);
            });
        });
    }

    // --- Action Methods ---

    async stashResult(url, btnElement, collectionTitle = 'Odložené na neskôr') {
        const result = (this.filteredResults || []).find(item => item.url === url)
            || (this.results || []).find(item => item.url === url);
        if (!result) return null;
        const payloadItem = {
            canonical_key: this._resultKey(result),
            url: result.url || '',
            source_url: result.source_url || result.url || '',
            chat_id: result.chat_id ?? null,
            message_id: result.message_id ?? null,
            topic_id: result.topic_id ?? null,
            title: result.title || '',
            type: 'video',
            duration: result.duration || 0,
            height: parseInt(result.height) || 0,
            quality: result.quality || '',
            size: this._formatCardSize(result) || result.size || '',
            thumbnail: result.thumb_url || result.thumbnail || '',
            source: result.source || 'external',
            surface: String(result.source || '').toLowerCase() === 'telegram' ? 'telegram' : 'quantum',
            in_library: this._isInDashboard(result),
            save_status: this._isInDashboard(result) ? 'imported' : 'stashed',
        };
        try {
            const resp = await fetch('/api/v1/discovery-hub/combined-history/collections/stash', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: collectionTitle,
                    keyword: this.currentQuery || 'stash',
                    items: [payloadItem],
                }),
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            result._stashed = true;
            if (btnElement) {
                btnElement.classList.add('is-stashed');
                btnElement.innerHTML = '<span class="material-icons-round" style="font-size: 14px;">bookmark</span> Odložené';
            }
            this.setActivity(
                'Odložené do kolekcie',
                `${result.title || 'Video'} → ${collectionTitle} (${data.total_count || 1} položiek)`,
                'done'
            );
            return data;
        } catch (err) {
            this.setActivity('Chyba odloženia', err.message || String(err), 'error');
            return null;
        }
    }

    async stashSelected(collectionTitle = 'Odložené na neskôr') {
        const selected = this.getSelectedResults();
        if (!selected.length) return null;
        const items = selected.map(result => ({
            canonical_key: this._resultKey(result),
            url: result.url || '',
            source_url: result.source_url || result.url || '',
            chat_id: result.chat_id ?? null,
            message_id: result.message_id ?? null,
            topic_id: result.topic_id ?? null,
            title: result.title || '',
            type: 'video',
            duration: result.duration || 0,
            height: parseInt(result.height) || 0,
            quality: result.quality || '',
            size: this._formatCardSize(result) || result.size || '',
            thumbnail: result.thumb_url || result.thumbnail || '',
            source: result.source || 'external',
            surface: String(result.source || '').toLowerCase() === 'telegram' ? 'telegram' : 'quantum',
            in_library: this._isInDashboard(result),
            save_status: this._isInDashboard(result) ? 'imported' : 'stashed',
        }));
        const resp = await fetch('/api/v1/discovery-hub/combined-history/collections/stash', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: collectionTitle,
                keyword: this.currentQuery || 'stash',
                items,
            }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        selected.forEach(r => { r._stashed = true; });
        this.renderResultsList();
        this.setActivity(
            'Výber odložený do kolekcie',
            `Pridané: ${data.added_count || 0}, existujúce: ${data.duplicate_count || 0} → ${collectionTitle}`,
            'done'
        );
        return data;
    }

    buildShareInfo(result) {
        if (!result) return { share_url: '', requires_private_access: false, access_warning: '' };
        const rawUrl = String(result.source_url || result.url || '').trim();
        const isTg = Boolean(
            (result.chat_id != null && result.message_id != null)
            || String(result.source || '').toLowerCase() === 'telegram'
            || rawUrl.startsWith('tg://')
            || rawUrl.includes('/api/v1/telegram/')
            || rawUrl.includes('t.me/c/')
        );
        let shareUrl = rawUrl;
        if (isTg && result.chat_id != null && result.message_id != null) {
            if (!/^https?:/i.test(rawUrl) || rawUrl.includes('/api/v1/telegram/')) {
                let cid = String(Math.abs(Number(result.chat_id) || 0) || result.chat_id);
                if (cid.startsWith('100') && cid.length > 5) cid = cid.slice(3);
                shareUrl = `https://t.me/c/${cid}/${result.message_id}`;
            }
        }
        return {
            share_url: shareUrl,
            requires_private_access: isTg,
            access_warning: isTg ? 'Odkaz vyžaduje členstvo v súkromnom Telegram kanáli alebo skupine.' : '',
        };
    }

    async shareResult(url, btnElement) {
        const result = (this.filteredResults || []).find(item => item.url === url)
            || (this.results || []).find(item => item.url === url);
        if (!result) return null;
        const info = this.buildShareInfo(result);
        try {
            if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                await navigator.clipboard.writeText(info.share_url);
            }
        } catch (_) {}
        const msg = info.requires_private_access
            ? `${info.share_url} · ⚠️ ${info.access_warning}`
            : `Skopírovaný odkaz: ${info.share_url}`;
        this.setActivity('Zdieľanie odkazu', msg, 'done');
        if (btnElement) {
            const prev = btnElement.innerHTML;
            btnElement.innerHTML = '<span class="material-icons-round" style="font-size: 14px;">check</span>';
            setTimeout(() => { btnElement.innerHTML = prev; }, 1400);
        }
        return info;
    }

    async followCurrentQuery(customTitle = '') {
        const q = (this.currentQuery || '').trim();
        if (!q) return null;
        const surface = this.globalTelegram ? 'telegram' : 'quantum';
        const seenKeys = (this.results || []).map(r => this._resultKey(r)).filter(Boolean);
        const notInLib = (this.results || []).filter(r => !this._isInDashboard(r)).length;
        const resp = await fetch('/api/v1/discovery-hub/combined-history/watchlist/upsert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                kind: 'query',
                target: q,
                title: customTitle || `${surface === 'telegram' ? 'TG' : 'Quantum'}: ${q}`,
                surface,
                reason: `Uložený dopyt "${q}" (${surface})`,
                delta_new_count: 0,
                not_in_library_count: notInLib,
                seen_keys: seenKeys,
            }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const saved = await resp.json();
        this.setActivity('Sledovanie uložené', `Dopyt "${q}" bol pridaný do Watchlistu.`, 'done');
        return saved;
    }

    downloadVideo(url, title, btnElement) {
        // Trigger backend aria2c download
        const btn = btnElement || event.target.closest('button');
        const originalText = btn.innerHTML;
        btn.innerHTML = '<span class="quantum-search-loading active" style="position:static; width:14px; height:14px; border-width:2px; margin-right:6px;"></span> Q...';

        fetch('/api/v1/download/external', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: url,
                title: title
            })
        })
            .then(response => response.json())
            .then(data => {
                if (data.status === 'download_queued' || data.status === 'already_local') {
                    btn.innerHTML = '<span class="material-icons-round" style="font-size: 14px;">check_circle</span> Queued';
                    btn.style.color = '#4ade80';
                    btn.style.borderColor = '#4ade80';
                } else {
                    btn.innerHTML = '<span class="material-icons-round" style="font-size: 14px;">error</span> Error';
                    btn.style.color = '#ef4444';
                }
                setTimeout(() => {
                    btn.innerHTML = originalText;
                    btn.style.color = '';
                    btn.style.borderColor = '';
                }, 3000);
            })
            .catch(err => {
                console.error(err);
                btn.innerHTML = 'Error';
                setTimeout(() => {
                    btn.innerHTML = originalText;
                }, 2000);
            });
    }

    _readyImportSource(url) {
        try {
            const host = new URL(url).hostname.toLowerCase();
            return ['porntrex.com', 'whoreshub.com', 'pornhub.com', 'pornhub.org',
                'pornhub.net', 'eporner.com', 'leakporner.com', 'hornysimp.com',
                'hornysimp.com.lv', 'djav.org', 'pornerleak.com', 'mypornerleak.com',
                '1porn.tv']
                .some(domain => host === domain || host.endsWith('.' + domain));
        } catch { return false; }
    }

    _isOnePornUrl(url) {
        try {
            const host = new URL(url).hostname.toLowerCase();
            return ['1porn.tv', 'fpvcdn.com', 'ahcdn.com'].some(domain =>
                host === domain || host.endsWith('.' + domain));
        } catch { return false; }
    }

    _isLeakStylePlaybackSource(url) {
        try {
            const host = new URL(url).hostname.toLowerCase();
            return ['leakporner.com', 'hornysimp.com', 'hornysimp.com.lv', 'djav.org',
                'pornerleak.com', 'mypornerleak.com', 'nsfw247.to', 'pornhat.com', 'beeg.com']
                .some(domain => host === domain || host.endsWith('.' + domain));
        } catch { return false; }
    }

    _isDirectPlaybackUrl(url, isHls = false) {
        if (isHls) return true;
        try {
            return /\.(?:mp4|m4v|webm|m3u8|mpd)\/?$/i.test(new URL(url).pathname);
        } catch {
            return /\.(?:mp4|m4v|webm|m3u8|mpd)\/?(?:[?#]|$)/i.test(String(url || ''));
        }
    }

    _isByseEmbedUrl(url) {
        try {
            const parsed = new URL(url);
            return ['bysezoxexe.com', '398fitus.com'].some(domain =>
                parsed.hostname === domain || parsed.hostname.endsWith('.' + domain))
                && /^\/(?:e|kpw)\/[a-z0-9_-]+\/?$/i.test(parsed.pathname);
        } catch { return false; }
    }

    _hasEmbedPath(url) {
        try { return /\/(?:e|embed|kpw)\//i.test(new URL(url).pathname); }
        catch { return false; }
    }

    _embedProxyUrl(url, referer) {
        const upstream = String(url || '').trim();
        if (!/^https?:\/\//i.test(upstream)) throw new Error('Zdroj nevrátil platnú adresu prehrávača.');
        if (this._isByseEmbedUrl(upstream)) {
            const parsed = new URL(upstream);
            const code = parsed.pathname.match(/^\/(?:e|kpw)\/([a-z0-9_-]+)/i)?.[1];
            if (code) {
                return `/e/${encodeURIComponent(code)}?upstream=${encodeURIComponent(upstream)}&referer=${encodeURIComponent(referer)}`;
            }
        }
        return `/embed_proxy?url=${encodeURIComponent(upstream)}&referer=${encodeURIComponent(referer)}`;
    }

    _isEpornerUrl(url) {
        try {
            const host = new URL(url).hostname.toLowerCase();
            return host === 'eporner.com' || host.endsWith('.eporner.com');
        } catch { return false; }
    }

    _isFpoUrl(url) {
        try {
            const host = new URL(url).hostname.toLowerCase();
            return host === 'fpo.xxx' || host.endsWith('.fpo.xxx');
        } catch { return false; }
    }

    _playUrlForResult(result) {
        const watchUrl = String(result?.url || '');
        const streamUrl = String(result?.stream_url || '');
        const source = String(result?.source || '');
        // Prefer the durable watch page even if a cached/card-normalized result
        // carries Eporner's external-preview embed in stream_url.
        if (this._isEpornerUrl(watchUrl) && (/eporner/i.test(source) || this._isEpornerUrl(streamUrl))) {
            return watchUrl;
        }
        return streamUrl || watchUrl;
    }

    _durationSeconds(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, value) : 0;
        const raw = String(value || '').trim();
        if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
        if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(raw)) {
            return raw.split(':').reduce((total, part) => total * 60 + Number(part), 0);
        }
        return 0;
    }

    async _resolveQuantumPlayback(result, requestedUrl = '') {
        const pageUrl = String(result?.url || requestedUrl || '');
        const playable = this._playUrlForResult(result) || requestedUrl || pageUrl;
        const referer = String(result?.source_url || pageUrl);
        if (/\/telegram\/stream\//i.test(playable) || /telesco\.pe\/.+\.mp4/i.test(playable)) {
            return { url: playable, format: 'mp4', iframe: false };
        }

        const directEmbed = this._embedUrlFor(playable);
        if (directEmbed) {
            const url = this._isLeakStylePlaybackSource(pageUrl) || this._readyImportSource(pageUrl)
                ? this._embedProxyUrl(directEmbed, referer) : directEmbed;
            return { url, format: 'mp4', iframe: true };
        }
        if (this._isByseEmbedUrl(playable)) {
            return { url: this._embedProxyUrl(playable, referer), format: 'mp4', iframe: true };
        }

        const data = result?._resolvedPlayback && Date.now() - (result._resolvedAt || 0) < 90000
            ? result._resolvedPlayback : await this._resolvePlayable(pageUrl, false);

        const stream = String(data.stream_url || '').trim();
        const isHls = !!data.is_hls || /\.m3u8(?:[?#]|$)/i.test(stream);
        const embedPlayers = this._isLeakStylePlaybackSource(pageUrl) && Array.isArray(data.embed_urls)
            ? [...new Set(data.embed_urls.filter(value => /^https?:\/\//i.test(value)))]
                .map(value => this._embedProxyUrl(value, data.playback_referer || referer))
            : [];

        if (data.playback && data.playback.playback_url && data.playback.status !== 'unsupported') {
            return {
                url: data.playback.playback_url,
                format: data.playback.format || (isHls ? 'hls' : 'mp4'),
                iframe: Boolean(data.playback.iframe),
                fallback_url: data.playback.fallback_url || null,
                players: data.playback.players || undefined,
                embedFallbacks: embedPlayers,
            };
        }

        if (!stream && (!Array.isArray(data.embed_urls) || !data.embed_urls.length)) {
            throw new Error('Zdroj nevrátil prehrateľný stream ani embed.');
        }
        if (!this._isDirectPlaybackUrl(stream, isHls)) {
            const embeds = [...(Array.isArray(data.embed_urls) ? data.embed_urls : []),
                ...(Array.isArray(result?.embed_urls) ? result.embed_urls : []), stream]
                .filter((value, index, all) => /^https?:\/\//i.test(String(value || '').trim())
                    && all.indexOf(value) === index);
            const playerUrl = embeds.find(value => this._isByseEmbedUrl(value))
                || embeds.find(value => this._hasEmbedPath(value))
                || embeds[0];
            if (playerUrl && (this._readyImportSource(pageUrl) || this._isLeakStylePlaybackSource(pageUrl) || embeds.length > 1)) {
                const players = [...new Set(embeds.map(value => this._embedProxyUrl(value, referer)))];
                return { url: this._embedProxyUrl(playerUrl, referer), players, format: 'mp4', iframe: true };
            }
            if (this._readyImportSource(pageUrl) || this._isLeakStylePlaybackSource(pageUrl)) {
                return { url: this._embedProxyUrl(stream || pageUrl, referer), format: 'mp4', iframe: true };
            }
            throw new Error('Zdroj nevrátil priamy stream ani rozpoznateľný embed prehrávač.');
        }

        const resolvePage = /(?:^|\.)(?:pornhub\.(?:com|org|net)|xvideos\.(?:com|red)|noodlemagazine\.com)$/i.test(
            (() => { try { return new URL(pageUrl).hostname; } catch { return ''; } })()
        );
        const needsProxy = isHls || this._readyImportSource(pageUrl) || this._isLeakStylePlaybackSource(pageUrl)
            || this._isEpornerUrl(pageUrl) || this._isEpornerUrl(stream)
            || this._isFpoUrl(pageUrl) || this._isFpoUrl(stream) || this._isOnePornUrl(pageUrl) || this._isOnePornUrl(stream) || resolvePage
            || /camwhores\.tv/i.test(pageUrl) || /camwhores\.tv/i.test(stream)
            || !!data.proxy_session || /pixeldrain\.com\/api\/|(?:img|n)\d*\.coomerfans\.com\/|phncdn\.com\/|xvideos-cdn\.com\//i.test(stream);
        const session = data.proxy_session ? `&session=${encodeURIComponent(data.proxy_session)}` : '';
        const proxyUrl = `/hls_proxy?url=${encodeURIComponent(stream)}&referer=${encodeURIComponent(data.playback_referer || referer)}${session}`;
        const url = needsProxy ? proxyUrl : stream;
        return {
            url,
            format: isHls ? 'hls' : 'mp4',
            iframe: false,
            fallback_url: (!needsProxy || data.playback?.fallback_url) ? (data.playback?.fallback_url || proxyUrl) : null,
            embedFallbacks: embedPlayers,
        };
    }

    async _resolvePlayable(url, refreshCard = true) {
        const response = await fetch('/api/tester/resolve', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: [url] }),
        });
        if (!response.ok) throw new Error(`Resolver HTTP ${response.status}`);
        const body = await response.json();
        const item = (body.results || [])[0] || {};
        const data = item.data || {};
        const hasPlayback = Boolean(
            data.stream_url ||
            (Array.isArray(data.embed_urls) && data.embed_urls.length > 0) ||
            (data.playback && (data.playback.playback_url || data.playback.fallback_url))
        );
        if (item.status !== 'success' || !hasPlayback) {
            throw new Error(item.message || 'Zdroj nevrátil prehrateľný stream');
        }
        const result = this.results.find(r => r.url === url);
        if (result) {
            const preserveExactSize = !!(result.size_bytes && !result.size_estimated && data.size_estimated);
            for (const key of ['title', 'thumbnail', 'duration', 'height', 'width', 'quality',
                'size_bytes', 'upload_date', 'tags', 'embed_urls']) {
                if (key === 'size_bytes' && preserveExactSize) continue;
                if (data[key]) result[key] = data[key];
            }
            if (typeof data.size_estimated === 'boolean' && !preserveExactSize) result.size_estimated = data.size_estimated;
            result._resolvedPlayback = data;
            result._resolvedAt = Date.now();
            if (!this._usesTesterMetadata(url) || (result.duration && result.height && result.size_bytes && result.upload_date)) {
                result._metaFetched = true;
            }
            result._metaMissing = ['duration', 'quality', 'size_bytes'].filter(key => !result[key]);
            if (refreshCard) this.renderResultsList();
        }
        return data;
    }

    _telegramImportPayload(result) {
        if (!result) return null;
        const stream = String(result.stream_url || '');
        const match = stream.match(/\/telegram\/stream\/(-?\d+)\/(\d+)/);
        const chat = result.chat_id || result.channel_id || (match && match[1]);
        const message = result.message_id || (match && match[2]);
        if (!chat || !message) return null;
        if (result.source !== 'Telegram' && !match) return null;
        return {
            chat_id: Number(chat),
            message_id: Number(message),
            source_url: result.source_url || result.url || '',
            stream_url: match ? `/api/v1/telegram/stream/${match[1]}/${match[2]}` : stream,
            url: result.url || '',
            title: result.title || '',
            thumbnail: result.thumbnail || result.thumb_url || '',
            duration: result.duration || '',
            views: result.views || 0,
            upload_date: result.upload_date || '',
            quality: result.quality || '',
            width: Number(result.width) || 0,
            height: Number(result.height) || 0,
            effective_res: Number(result.effective_res) || 0,
            size_bytes: Number(result.size_bytes) || 0,
            orientation: result.orientation || '',
        };
    }

    async importVideo(url, btnElement, quiet = false, batchName = null, suppliedResult = null) {
        batchName = batchName || this._newImportBatchName();
        const result = suppliedResult || this.filteredResults.find(r => r.url === url);
        const originalText = btnElement?.innerHTML;
        if (btnElement) { btnElement.disabled = true; btnElement.textContent = 'Resolving…'; }
        try {
            let response;
            const telegramPayload = this._telegramImportPayload(result);
            if (telegramPayload) {
                telegramPayload.batch_name = batchName;
                response = await fetch('/api/v1/telegram/import', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(telegramPayload),
                });
            } else if (this._readyImportSource(url)) {
                const data = result?._resolvedPlayback && Date.now() - (result._resolvedAt || 0) < 90000
                    ? result._resolvedPlayback : await this._resolvePlayable(url, false);
                response = await fetch('/api/v1/import/quantum-ready', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        batch_name: batchName,
                        source_url: url, stream_url: data.stream_url,
                        title: data.title || result?.title || '',
                        thumbnail: data.thumbnail || result?.thumbnail || '',
                        duration: this._durationSeconds(data.duration || result?.duration),
                        width: data.width || result?.width || 0,
                        height: data.height || result?.height || 0,
                        quality: String(data.quality || (result?.quality_evidence === 'source_badge' ? '' : result?.quality) || ''),
                        size_bytes: result?.size_bytes && !result.size_estimated ? result.size_bytes : (data.size_bytes || 0),
                        upload_date: data.upload_date || result?.upload_date || '',
                        tags: Array.isArray(data.tags) ? data.tags : (Array.isArray(result?.tags) ? result.tags : []),
                        embed_urls: Array.isArray(data.embed_urls) ? data.embed_urls : [],
                    }),
                });
            } else {
                response = await fetch('/api/v1/import/text', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ urls: [url], items: result ? [result] : null, batch_name: batchName }),
                });
            }
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.detail || `Import HTTP ${response.status}`);
            if (btnElement) btnElement.textContent = (telegramPayload || this._readyImportSource(url)) ? 'Ready ✓' : 'Queued ✓';
            if (result) {
                result.in_dashboard = true;
                result._libraryInfo = { in_dashboard: true, video_id: payload.id || null };
                this._syncDashboardBadge(result);
            }
            if (!this._libraryStatusCache) this._libraryStatusCache = new Map();
            if (url) {
                this._libraryStatusCache.set(url, { in_dashboard: true, video_id: payload.id || null });
            }
            if (result?.source_url) {
                this._libraryStatusCache.set(result.source_url, { in_dashboard: true, video_id: payload.id || null });
            }
            if (result?.stream_url) {
                this._libraryStatusCache.set(result.stream_url, { in_dashboard: true, video_id: payload.id || null });
            }
            if (telegramPayload?.chat_id && telegramPayload?.message_id) {
                this._libraryStatusCache.set(`tg:${telegramPayload.chat_id}:${telegramPayload.message_id}`, { in_dashboard: true, video_id: payload.id || null });
            }
            if (telegramPayload && this._catalogPage?.live) this.removeLiveNewResults([result]);
            else if (telegramPayload && this._catalogPage?.newOnly) await this.searchNewTelegramVideos();
            return true;
        } catch (error) {
            if (btnElement) btnElement.textContent = 'Failed';
            if (!quiet) alert(`Import failed: ${error.message || error}`);
            return false;
        } finally {
            if (btnElement) setTimeout(() => {
                btnElement.disabled = false;
                btnElement.innerHTML = originalText;
            }, 3000);
        }
    }

    isFavorite(url) {
        const favs = JSON.parse(localStorage.getItem('quantum_favorites') || '[]');
        return favs.some(f => f.url === url);
    }

    toggleFavorite(url, title, thumbnail) {
        const favs = JSON.parse(localStorage.getItem('quantum_favorites') || '[]');
        const index = favs.findIndex(f => f.url === url);

        if (index >= 0) {
            favs.splice(index, 1); // Remove
        } else {
            favs.push({ url, title, thumbnail, date: new Date().toISOString() });
        }

        localStorage.setItem('quantum_favorites', JSON.stringify(favs));
        this.renderResults(); // Re-render to update UI
    }

    openResult(url) {
        window.open(url, '_blank');
    }

    _ensurePlayer() {
        if (this._playerEl) return this._playerEl;
        const el = document.createElement('div');
        el.className = 'quantum-player-modal';
        el.innerHTML = `
            <style>
              .quantum-player-modal { position: fixed; inset: 0; z-index: 100000; display: none;
                align-items: center; justify-content: center; background: rgba(3,6,14,.9);
                backdrop-filter: blur(8px); padding: 24px; }
              .quantum-player-modal.visible { display: flex; }
              .qp-inner { width: min(1180px, 100%); border-radius: 16px; overflow: hidden;
                background: #0a0a14; border: 1px solid rgba(168,85,247,.35);
                box-shadow: 0 24px 60px rgba(0,0,0,.6); }
              .qp-head { display: flex; align-items: center; gap: 12px; padding: 12px 16px;
                border-bottom: 1px solid rgba(255,255,255,.08); }
              .qp-title { flex: 1; font-size: 14px; font-weight: 700; color: #fff;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
              .qp-btn { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.14);
                color: #e8e8f0; border-radius: 8px; padding: 7px 12px; font-size: 12px; font-weight: 700;
                cursor: pointer; display: inline-flex; align-items: center; gap: 5px; text-decoration: none; }
              .qp-btn:hover { border-color: rgba(168,85,247,.5); }
              .qp-surface { aspect-ratio: 16/9; background: #000; display: flex;
                align-items: center; justify-content: center; }
              .qp-surface video, .qp-surface iframe { width: 100%; height: 100%; border: 0; display: block; }
              .qp-msg { color: rgba(255,255,255,.7); font-size: 13px; text-align: center; padding: 24px; line-height: 1.6; }
              .qp-spin { width: 34px; height: 34px; border: 3px solid rgba(168,85,247,.25);
                border-top-color: #a855f7; border-radius: 50%; animation: qp-rot 1s linear infinite; }
              @keyframes qp-rot { to { transform: rotate(360deg); } }
            </style>
            <div class="qp-inner">
              <div class="qp-head">
                <div class="qp-title" id="qpTitle"></div>
                <a class="qp-btn" id="qpSource" target="_blank" rel="noreferrer">
                  <span class="material-icons-round" style="font-size:15px;">open_in_new</span> Zdroj</a>
                <button class="qp-btn" id="qpClose">
                  <span class="material-icons-round" style="font-size:15px;">close</span></button>
              </div>
              <div class="qp-surface" id="qpSurface"></div>
            </div>`;
        document.body.appendChild(el);
        el.addEventListener('click', (e) => { if (e.target === el) this._closePlayer(); });
        el.querySelector('#qpClose').onclick = () => this._closePlayer();
        this._playerEl = el;
        return el;
    }

    _closePlayer() {
        if (!this._playerEl) return;
        this._playerRequestId = (this._playerRequestId || 0) + 1;
        if (this._playerHls) { this._playerHls.destroy(); this._playerHls = null; }
        this._playerEl.classList.remove('visible');
        this._playerEl.querySelector('#qpSurface').innerHTML = '';  // stop playback
    }

    _embedUrlFor(url) {
        // Eporner embeds are intentionally resolved as streams below. Direct
        // cross-origin frames receive a "play on Eporner" information page.
        if (this._isEpornerUrl(url)) return '';
        const m = (url || '').match(/turbo\.cr\/(?:embed|e|v|d|f)\/([^/?#]+)/i);
        if (m) return `https://turbo.cr/embed/${encodeURIComponent(m[1])}`;
        if (/\/embed\//i.test(url || '')) return url;
        return '';
    }

    async streamResult(url, title, result = null) {
        this._closePlayer();
        const requestId = this._playerRequestId;
        const modal = this._ensurePlayer();
        const surface = modal.querySelector('#qpSurface');
        modal.querySelector('#qpTitle').textContent = title || 'Prehrávam…';
        modal.querySelector('#qpSource').href = result?.url || url;
        surface.innerHTML = '<div class="qp-msg"><div class="qp-spin"></div><br>Resolvujem stream…</div>';
        modal.classList.add('visible');

        try {
            const playback = await this._resolveQuantumPlayback(result || { url }, url);
            if (requestId !== this._playerRequestId) return;
            const showEmbedPlayer = (url, players) => {
                const frame = document.createElement('iframe');
                frame.sandbox = 'allow-scripts allow-forms allow-presentation allow-same-origin';
                frame.allow = 'autoplay; fullscreen; picture-in-picture';
                frame.allowFullscreen = true;
                if (players.length > 1) {
                    const holder = document.createElement('div');
                    holder.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;';
                    frame.style.flex = '1';
                    holder.appendChild(frame);
                    const choices = document.createElement('div');
                    choices.style.cssText = 'display:flex;gap:6px;padding:7px;background:#10101c;overflow-x:auto;';
                    players.forEach((player, index) => {
                        const button = document.createElement('button');
                        button.className = 'qp-btn';
                        button.textContent = `Player ${index + 1}`;
                        button.onclick = () => { frame.src = player; };
                        choices.appendChild(button);
                    });
                    holder.appendChild(choices);
                    surface.replaceChildren(holder);
                } else {
                    surface.replaceChildren(frame);
                }
                frame.src = url;
            };
            if (playback.iframe) {
                showEmbedPlayer(playback.url, playback.players || []);
                return;
            }
            const video = document.createElement('video');
            const showPlaybackFailure = message => {
                if (!surface.contains(video)) return;
                this._playerHls?.destroy();
                this._playerHls = null;
                const alternatives = playback.embedFallbacks || [];
                if (alternatives.length) {
                    showEmbedPlayer(alternatives[0], alternatives);
                } else {
                    surface.innerHTML = `<div class="qp-msg">${message}</div>`;
                }
            };
            video.controls = true;
            video.autoplay = true;
            video.playsInline = true;
            // Retry browser-blocked audible autoplay silently, without a
            // second click inside the player. Network errors use recovery below.
            video.addEventListener('canplay', () => {
                if (requestId !== this._playerRequestId || !video.paused) return;
                video.play().catch(error => {
                    if (error.name === 'NotAllowedError' && requestId === this._playerRequestId) {
                        video.muted = true;
                        video.play().catch(() => {});
                    }
                });
            }, { once: true });
            video.addEventListener('error', () => {
                if (requestId === this._playerRequestId) {
                    if (playback.fallback_url && !video._fallbackAttempted) {
                        video._fallbackAttempted = true;
                        console.warn('[QuantumPlayer] Priamy stream zlyhal; skúšam jednorazový fallback proxy:', playback.fallback_url);
                        if (playback.format === 'hls' && this._playerHls) {
                            this._playerHls.loadSource(playback.fallback_url);
                        } else {
                            video.src = playback.fallback_url;
                            video.play().catch(() => {});
                        }
                        return;
                    }
                    showPlaybackFailure('Stream sa nepodarilo prehrať. Skús znovu načítať alebo otvoriť zdroj.');
                }
            });
            surface.replaceChildren(video);
            if (playback.format === 'hls' && window.Hls?.isSupported()) {
                this._playerHls = new Hls({ enableWorker: true, maxBufferLength: 30 });
                this._playerHls.on(Hls.Events.ERROR, (_, error) => {
                    if (error.fatal && requestId === this._playerRequestId) {
                        if (playback.fallback_url && !video._fallbackAttempted) {
                            video._fallbackAttempted = true;
                            console.warn('[QuantumPlayer] HLS fatálna chyba; skúšam jednorazový fallback proxy:', playback.fallback_url);
                            this._playerHls.loadSource(playback.fallback_url);
                            this._playerHls.startLoad();
                            return;
                        }
                        showPlaybackFailure('HLS stream zlyhal. Skús znovu načítať alebo otvoriť zdroj.');
                    }
                });
                this._playerHls.loadSource(playback.url);
                this._playerHls.attachMedia(video);
            } else if (playback.format !== 'hls' || video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = playback.url;
            } else {
                showPlaybackFailure('Pre tento HLS stream chýba podpora prehrávača.');
            }
        } catch (e) {
            if (requestId !== this._playerRequestId) return;
            surface.innerHTML = `<div class="qp-msg">Prehrávanie zlyhalo: ${this.escapeHtml(String(e.message || e))}<br><br>Otvor pôvodný zdroj tlačidlom vpravo hore.</div>`;
        }
    }

    exportResults() {
        const urls = this.filteredResults.map(r => r.url).join('\n');
        const blob = new Blob([urls], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `quantum-search-results-${Date.now()}.txt`;
        a.click();
    }

    _telegramThumbItems(results) {
        return (results || []).filter(r => (r.source || '').toLowerCase() === 'telegram' && r.chat_id && r.message_id);
    }

    async inspectTelegramThumbnails(button) {
        const items = this._telegramThumbItems(this.filteredResults);
        const status = document.getElementById('quantumThumbStatus');
        if (!items.length) { if (status) status.textContent = (typeof window !== 'undefined' && window.__nexus_t ? window.__nexus_t('Žiadne Telegram výsledky.') : 'Žiadne Telegram výsledky.'); return; }
        button.disabled = true;
        if (status) status.textContent = (typeof window !== 'undefined' && window.__nexus_t ? window.__nexus_t('Kontrolujem načítané náhľady…') : 'Kontrolujem načítané náhľady…');
        try {
            const response = await fetch('/api/v1/telegram/thumbs/inspect', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({items:items.map(r => ({chat_id:Number(r.chat_id), message_id:Number(r.message_id), has_thumbnail:!!(r.thumb_url || r.thumbnail)}))})});
            if (!response.ok) throw new Error('Kontrola zlyhala');
            const data = await response.json();
            const flagged = new Set((data.items || []).filter(r => ['poor','suspect','missing'].includes(r.status)).map(r => `${r.chat_id}:${r.message_id}`));
            const unknown = (data.items || []).filter(r => r.status === 'unchecked').length;
            for (const item of items) if (flagged.has(`${item.chat_id}:${item.message_id}`)) this.toggleSelect(item.url, true);
            if (status) status.textContent = `Označených ${flagged.size} podozrivých · ${unknown} ešte nenačítaných. Skontroluj výber.`;
        } catch (error) { if (status) status.textContent = error.message; }
        finally { button.disabled = false; }
    }

    stopTelegramThumbnails() {
        this._stopTelegramThumbs = true;
        if (this._repairAbort) {
            try { this._repairAbort.abort(); } catch (_) {}
        }
        const status = document.getElementById('quantumThumbStatus');
        if (status) status.textContent = (typeof window !== 'undefined' && window.__nexus_t ? window.__nexus_t('Zastavujem opravu…') : 'Zastavujem opravu…');
    }

    _updateTelegramCardThumb(item, newUrl) {
        if (!item || !newUrl) return;
        item.thumbnail = item.thumb_url = newUrl;
        if (typeof document === 'undefined' || !document.querySelector || typeof CSS === 'undefined' || !item.url) return;
        const card = document.querySelector(`.search-result-card[data-url="${CSS.escape(item.url)}"]`);
        if (!card) return;
        const wrap = card.querySelector('.search-result-thumbnail');
        if (!wrap) return;
        let img = wrap.querySelector('img');
        if (img) {
            img.src = newUrl;
            img.style.display = '';
        } else {
            img = document.createElement('img');
            img.src = newUrl;
            img.alt = item.title || 'Thumbnail';
            img.loading = 'lazy';
            const placeholder = wrap.querySelector('.search-result-placeholder, .thumb-placeholder');
            if (placeholder) placeholder.replaceWith(img);
            else wrap.prepend(img);
        }
    }

    _prioritizeVisibleItems(items) {
        if (typeof document === 'undefined' || !document.querySelector || typeof CSS === 'undefined' || !items.length) return items;
        const vh = (typeof window !== 'undefined' && window.innerHeight) || 900;
        const visible = [];
        const rest = [];
        for (const it of items) {
            const card = it.url ? document.querySelector(`.search-result-card[data-url="${CSS.escape(it.url)}"]`) : null;
            if (card) {
                const r = card.getBoundingClientRect();
                if (r.bottom >= -100 && r.top <= vh + 200) {
                    visible.push(it);
                    continue;
                }
            }
            rest.push(it);
        }
        return visible.concat(rest);
    }

    async repairSelectedTelegramThumbnails(button) {
        const rawItems = this._telegramThumbItems(this.getSelectedResults());
        const status = document.getElementById('quantumThumbStatus');
        const stop = document.getElementById('quantumStopThumbs');
        if (!rawItems.length) { if (status) status.textContent = 'Najprv označ Telegram videá.'; return; }
        if (this._repairingTelegramThumbs) return;
        const items = this._prioritizeVisibleItems(rawItems);
        this._repairingTelegramThumbs = true;
        this._stopTelegramThumbs = false;
        this._repairAbort = new AbortController();
        button.disabled = true;
        if (stop) stop.style.display = 'inline-flex';
        let done = 0, failed = 0;

        const byKey = new Map();
        for (const it of items) {
            const cid = String(Number(it.chat_id));
            const mid = String(Number(it.message_id));
            const k = `${cid}:${mid}`;
            if (!byKey.has(k)) byKey.set(k, []);
            byKey.get(k).push(it);
            if (cid.startsWith('-100')) {
                const pub = `${cid.slice(4)}:${mid}`;
                if (!byKey.has(pub)) byKey.set(pub, []);
                byKey.get(pub).push(it);
            }
        }

        const updateStatus = () => {
            if (!status) return;
            const processed = done + failed;
            const active = Math.min(items.length, processed + 1);
            status.textContent = `Opravujem ${active}/${items.length} · hotovo ${done} · chyby ${failed}`;
        };
        updateStatus();

        try {
            const resp = await fetch('/api/v1/telegram/thumbs/repair-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: this._repairAbort.signal,
                body: JSON.stringify({
                    items: items.map(it => ({
                        chat_id: Number(it.chat_id),
                        message_id: Number(it.message_id),
                        duration: this._durationSeconds(it.duration) || 0,
                    })),
                }),
            });

            if (resp.status === 404 || !resp.body) {
                let idx = 0;
                const worker = async () => {
                    while (idx < items.length && !this._stopTelegramThumbs) {
                        const item = items[idx++];
                        try {
                            const r = await fetch('/api/v1/telegram/thumbs/repair', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                signal: this._repairAbort.signal,
                                body: JSON.stringify({
                                    chat_id: Number(item.chat_id),
                                    message_id: Number(item.message_id),
                                    duration: this._durationSeconds(item.duration) || 0,
                                }),
                            });
                            const data = await r.json();
                            if (!r.ok) throw new Error(data.detail || 'Chyba');
                            this._updateTelegramCardThumb(item, `${data.thumbnail}?v=${Date.now()}`);
                            done++;
                        } catch (_) {
                            if (!this._stopTelegramThumbs) failed++;
                        }
                        updateStatus();
                    }
                };
                await Promise.all([worker(), worker(), worker(), worker()]);
            } else {
                if (!resp.ok || !resp.body) throw new Error('Batch oprava zlyhala');
                const reader = resp.body.getReader();
                const dec = new TextDecoder();
                let buf = '';
                for (;;) {
                    if (this._stopTelegramThumbs) break;
                    const { value, done: streamDone } = await reader.read();
                    if (streamDone) break;
                    buf += dec.decode(value, { stream: true });
                    const lines = buf.split('\n');
                    buf = lines.pop() || '';
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        let ev;
                        try { ev = JSON.parse(line); } catch { continue; }
                        if (ev.type === 'progress') {
                            if (ev.ok) {
                                done++;
                                const urlWithBust = `${ev.thumbnail}?v=${Date.now()}`;
                                const targets =
                                    byKey.get(`${ev.raw_chat_id}:${ev.message_id}`) ||
                                    byKey.get(`${ev.chat_id}:${ev.message_id}`) ||
                                    [];
                                for (const t of targets) this._updateTelegramCardThumb(t, urlWithBust);
                            } else {
                                failed++;
                            }
                            updateStatus();
                        }
                    }
                }
            }
            if (status) {
                status.textContent = `${this._stopTelegramThumbs ? 'Zastavené' : 'Hotovo'} · opravených ${done}, chyby ${failed}`;
            }
        } catch (err) {
            if (err && err.name === 'AbortError') {
                if (status) status.textContent = `Zastavené · opravených ${done}, chyby ${failed}`;
            } else if (status) {
                status.textContent = (err && err.message) || 'Oprava zlyhala';
            }
        } finally {
            this._repairingTelegramThumbs = false;
            this._repairAbort = null;
            button.disabled = false;
            if (stop) stop.style.display = 'none';
        }
    }

    getSelectedResults() {
        if (!this.selectedUrls || this.selectedUrls.size === 0) return [];
        return (this.filteredResults || []).filter(r => this.selectedUrls.has(r.url));
    }

    openSplitScreen() {
        const selected = this.getSelectedResults();
        if (!selected.length) { alert('Najprv označ výsledky na prehratie.'); return; }
        if (!document.getElementById('nuss-picker-modal')) { alert('Split-Screen sa nenačítal. Obnov stránku.'); return; }
        const items = selected.map(result => ({
            quantumResult: { ...result },
            url: result.url, title: result.title || 'Video',
            poster: this.proxifyThumbnail(result.thumb_url || result.thumbnail || '', result.source_url || result.url),
            duration: this._durationSeconds(result.duration), quality: result.quality || (result.height ? `${result.height}p` : ''),
            size: Number(result.size_bytes) || 0
        }));
        document.dispatchEvent(new CustomEvent('nexus-quantum-split-picker', { detail: JSON.stringify(items) }));
    }

    toggleSelect(url, isChecked) {
        if (!this.selectedUrls) this.selectedUrls = new Set();
        if (isChecked) {
            this.selectedUrls.add(url);
        } else {
            this.selectedUrls.delete(url);
        }
        if (typeof document !== 'undefined' && document.querySelectorAll) {
            document.querySelectorAll('.search-result-card').forEach(card => {
                if (card.dataset && card.dataset.url === url) {
                    card.classList.toggle('is-selected', isChecked);
                    const label = card.querySelector('.quantum-card-select-label');
                    if (label) label.classList.toggle('checked', isChecked);
                    const cb = card.querySelector('.quantum-card-checkbox');
                    if (cb && cb.checked !== isChecked) cb.checked = isChecked;
                }
            });
        }
        this.updateSelectionToolbar();
    }

    toggleSelectAll(isChecked) {
        if (!this.selectedUrls) this.selectedUrls = new Set();
        (this.filteredResults || []).forEach(r => {
            if (r.url) {
                if (isChecked) this.selectedUrls.add(r.url);
                else this.selectedUrls.delete(r.url);
            }
        });
        if (typeof document !== 'undefined' && document.querySelectorAll) {
            document.querySelectorAll('.search-result-card').forEach(card => {
                const url = card.dataset ? card.dataset.url : '';
                const checked = isChecked && !!url;
                card.classList.toggle('is-selected', checked);
                const label = card.querySelector('.quantum-card-select-label');
                if (label) label.classList.toggle('checked', checked);
                const cb = card.querySelector('.quantum-card-checkbox');
                if (cb) cb.checked = checked;
            });
        }
        this.updateSelectionToolbar();
    }

    updateSelectionToolbar() {
        const selected = this.getSelectedResults();
        const total = (this.filteredResults || []).length;
        const selectedCount = selected.length;
        const filterInfo = typeof document !== 'undefined' && document.getElementById ? document.getElementById('telegramNewFilterInfo') : null;
        if (filterInfo) {
            const hiddenSelected = (this.selectedUrls?.size || 0) - selectedCount;
            filterInfo.textContent = this._catalogPage?.newOnly && this.results.length
                ? `Zobrazených ${total} z ${this.results.length} načítaných${hiddenSelected > 0 ? ` · ${hiddenSelected} označených je skrytých filtrami` : ''}. Import sa vzťahuje na zobrazené videá.`
                : '';
        }

        const allCheckbox = typeof document !== 'undefined' && document.getElementById ? document.getElementById('quantumSelectAllCheckbox') : null;
        const countEl = typeof document !== 'undefined' && document.getElementById ? document.getElementById('quantumSelectedCount') : null;
        const badgeEl = typeof document !== 'undefined' && document.getElementById ? document.getElementById('quantumSelectedBadge') : null;
        const importSelBtn = typeof document !== 'undefined' && document.getElementById ? document.getElementById('quantumImportSelectedBtn') : null;
        const importSelCount = typeof document !== 'undefined' && document.getElementById ? document.getElementById('quantumImportSelectedCount') : null;
        const importAllBtn = typeof document !== 'undefined' && document.getElementById ? document.getElementById('quantumImportAllBtn') : null;
        const splitBtn = typeof document !== 'undefined' && document.getElementById ? document.getElementById('quantumSplitBtn') : null;
        const splitCount = typeof document !== 'undefined' && document.getElementById ? document.getElementById('quantumSplitCount') : null;
        if (splitBtn && splitBtn.style) splitBtn.style.display = selectedCount ? 'inline-flex' : 'none';
        if (splitCount) splitCount.textContent = selectedCount;

        if (allCheckbox) {
            allCheckbox.disabled = total === 0;
            if (total === 0) {
                allCheckbox.checked = false;
                allCheckbox.indeterminate = false;
            } else if (selectedCount === total) {
                allCheckbox.checked = true;
                allCheckbox.indeterminate = false;
            } else if (selectedCount > 0) {
                allCheckbox.checked = false;
                allCheckbox.indeterminate = true;
            } else {
                allCheckbox.checked = false;
                allCheckbox.indeterminate = false;
            }
        }

        if (countEl) countEl.textContent = selectedCount;
        if (badgeEl && badgeEl.style) badgeEl.style.display = selectedCount > 0 ? 'inline-flex' : 'none';

        if (importSelBtn && importSelBtn.style) {
            importSelBtn.style.display = selectedCount > 0 ? 'inline-flex' : 'none';
            if (importSelCount) importSelCount.textContent = selectedCount;
        }

        if (importAllBtn) {
            importAllBtn.textContent = total > 0 ? `Import All (${total})` : 'Import All';
        }
    }

    async importSelected() {
        const selected = this.getSelectedResults();
        if (selected.length === 0) {
            if (typeof alert === 'function') alert('Označte prosím aspoň jedno video na import.');
            return;
        }
        await this._executeBatchImport(selected, `Vybrané (${selected.length})`);
    }

    async importAll() {
        if (!this.filteredResults || this.filteredResults.length === 0) return;
        await this._executeBatchImport(this.filteredResults, `Všetky (${this.filteredResults.length})`);
    }

    _newImportBatchName() {
        const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        return `Quantum Search · ${new Date().toLocaleString('sk-SK')} · ${id}`;
    }

    async _executeBatchImport(items, batchLabel = '') {
        if (!items || items.length === 0) return;
        const batchName = this._newImportBatchName();

        const telegramItems = items.filter(r => !!this._telegramImportPayload(r));
        const readyItems = items.filter(r => !this._telegramImportPayload(r) && this._readyImportSource(r.url));
        const legacyItems = items.filter(r => !this._telegramImportPayload(r) && !this._readyImportSource(r.url));

        let ready = 0;
        let queued = 0;
        let failed = 0;
        const importedTelegram = [];

        // 1. Telegram videos (via /api/v1/telegram/import)
        if (telegramItems.length > 0) {
            const poolSize = Math.min(4, telegramItems.length);
            let nextIndex = 0;
            const workers = Array.from({ length: poolSize }, async () => {
                while (nextIndex < telegramItems.length) {
                    const item = telegramItems[nextIndex++];
                    const payload = this._telegramImportPayload(item);
                    payload.batch_name = batchName;
                    try {
                        const res = await fetch('/api/v1/telegram/import', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        });
                        if (res.ok) {
                            ready++;
                            importedTelegram.push(item);
                            item.in_dashboard = true;
                            item._libraryInfo = { in_dashboard: true };
                            if (!this._libraryStatusCache) this._libraryStatusCache = new Map();
                            if (item.url) this._libraryStatusCache.set(item.url, { in_dashboard: true });
                            if (item.source_url) this._libraryStatusCache.set(item.source_url, { in_dashboard: true });
                            if (item.chat_id && item.message_id) {
                                this._libraryStatusCache.set(`tg:${item.chat_id}:${item.message_id}`, { in_dashboard: true });
                            }
                            this._syncDashboardBadge(item);
                            if (this.selectedUrls) this.selectedUrls.delete(item.url);
                            if (typeof document !== 'undefined' && document.querySelectorAll) {
                                document.querySelectorAll(`.search-result-card`).forEach(card => {
                                    if (card.dataset && card.dataset.url === item.url) {
                                        const btn = card.querySelector('.btn-import');
                                        if (btn) btn.textContent = 'Ready ✓';
                                    }
                                });
                            }
                        } else {
                            failed++;
                        }
                    } catch (_) {
                        failed++;
                    }
                }
            });
            await Promise.all(workers);
        }

        // 2. Ready-Import items
        if (readyItems.length > 0) {
            const poolSize = Math.min(3, readyItems.length);
            let nextIndex = 0;
            const workers = Array.from({ length: poolSize }, async () => {
                while (nextIndex < readyItems.length) {
                    const item = readyItems[nextIndex++];
                    let btn = null;
                    if (typeof document !== 'undefined' && document.querySelectorAll) {
                        const card = Array.from(document.querySelectorAll('.search-result-card')).find(c => c.dataset && c.dataset.url === item.url);
                        btn = card ? card.querySelector('.btn-import') : null;
                    }
                    const ok = await this.importVideo(item.url, btn, true, batchName);
                    if (ok) {
                        ready++;
                        if (this.selectedUrls) this.selectedUrls.delete(item.url);
                    } else {
                        failed++;
                    }
                }
            });
            await Promise.all(workers);
        }

        // 3. Legacy items
        if (legacyItems.length > 0) {
            try {
                const response = await fetch('/api/v1/import/text', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        urls: legacyItems.map(r => r.url),
                        items: legacyItems,
                        batch_name: batchName,
                    }),
                });
                if (response.ok) {
                    queued += legacyItems.length;
                    legacyItems.forEach(item => {
                        item.in_dashboard = true;
                        item._libraryInfo = { in_dashboard: true, queued: true };
                        if (!this._libraryStatusCache) this._libraryStatusCache = new Map();
                        if (item.url) this._libraryStatusCache.set(item.url, { in_dashboard: true, queued: true });
                        this._syncDashboardBadge(item);
                        if (this.selectedUrls) this.selectedUrls.delete(item.url);
                    });
                } else {
                    failed += legacyItems.length;
                }
            } catch (_) {
                failed += legacyItems.length;
            }
        }

        this.updateSelectionToolbar();

        const summary = `${ready} ready to play, ${queued} queued, ${failed} failed.`;
        if (typeof alert === 'function') alert(summary);
        if (this._catalogPage?.live && ready) {
            this.removeLiveNewResults(importedTelegram);
            return;
        }
        if (this._catalogPage?.newOnly && ready) {
            await this.searchNewTelegramVideos();
            return;
        }
    }

    toggleSettings() {
        this.isSettingsOpen = !this.isSettingsOpen;
        const mainView = document.getElementById('quantumSearchMainView');
        const settingsView = document.getElementById('quantumSearchSettingsView');
        const searchInput = document.querySelector('.quantum-search-header > .quantum-search-input-container');

        if (this.isSettingsOpen) {
            mainView.style.display = 'none';
            settingsView.style.display = 'block';
            if (searchInput) searchInput.style.display = 'none';
        } else {
            mainView.style.display = 'block';
            settingsView.style.display = 'none';
            if (searchInput) searchInput.style.display = '';
        }
    }

    toggleSetup() {
        this.isSetupOpen = !this.isSetupOpen;
        const setup = document.getElementById('quantumSearchSetup');
        const toggle = document.getElementById('quantumSetupToggle');

        if (!setup || !toggle) return;

        setup.classList.toggle('collapsed', !this.isSetupOpen);
        setup.setAttribute('aria-hidden', String(!this.isSetupOpen));
        setup.inert = !this.isSetupOpen;
        toggle.classList.toggle('collapsed', !this.isSetupOpen);
        toggle.setAttribute('aria-expanded', String(this.isSetupOpen));
    }

    saveSettings() {
        this.settings.autoImport = document.getElementById('settingAutoImport').checked;
        this.settings.quality = document.getElementById('settingQuality').value;
        localStorage.setItem('quantum_settings', JSON.stringify(this.settings));
    }

    saveLimits() {
        this.settings.limitPerSource = parseInt(document.getElementById('searchLimitPerSource')?.value) || 20;
        this.settings.limitTotal = parseInt(document.getElementById('searchLimitTotal')?.value) || 100;
        localStorage.setItem('quantum_settings', JSON.stringify(this.settings));
    }

    startDownloadPolling() {
        let failCount = 0;
        const poll = () => {
            // Skip if closed and nothing active
            if (!this.isOpen() && Object.keys(this.downloads).length === 0) {
                setTimeout(poll, 3000);
                return;
            }
            fetch('/api/v1/downloads/active')
                .then(r => r.json())
                .then(data => {
                    failCount = 0;
                    this.downloads = data;
                    this.renderStatus();
                    setTimeout(poll, 1000);
                })
                .catch(() => {
                    failCount++;
                    // Exponential backoff: 2s, 4s, 8s … capped at 30s
                    const delay = Math.min(1000 * Math.pow(2, failCount), 30000);
                    setTimeout(poll, delay);
                });
        };
        setTimeout(poll, 1000);
    }

    renderStatus() {
        const footer = document.getElementById('quantumSearchFooter');
        const statusEl = document.getElementById('downloadStatus');

        const activeIds = Object.keys(this.downloads);

        if (activeIds.length === 0) {
            footer.style.display = 'none';
            return;
        }

        footer.style.display = 'block';

        // Visualization: show overall count plus per-download progress with speed
        const count = activeIds.length;

        let html = `
            <span class="material-icons-round" style="font-size:16px; color:#4ade80;">download</span>
            <span>Downloading ${count} item${count > 1 ? 's' : ''}...</span>
        `;

        activeIds.forEach(id => {
            const raw = this.downloads[id];
            const data = typeof raw === 'number' ? { percent: raw } : (raw || {});
            const p = typeof data.percent === 'number' ? data.percent : 0;
            const downloaded = typeof data.downloaded_mb === 'number' ? data.downloaded_mb : null;
            const total = typeof data.total_mb === 'number' ? data.total_mb : null;
            const speed = typeof data.speed_mb_s === 'number' ? data.speed_mb_s : null;

            const infoParts = [];
            if (downloaded != null && total != null) {
                infoParts.push(`${downloaded.toFixed(1)}/${total.toFixed(1)} MB`);
            }
            if (speed != null) {
                infoParts.push(`${speed.toFixed(1)} MB/s`);
            }

            html += `
                <div style="display:flex; align-items:center; gap:6px; margin-left: 10px; min-width: 140px;">
                    <div style="flex:1; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden;">
                        <div style="width: ${p}%; height: 100%; background: #4ade80; transition: width 0.3s ease;"></div>
                    </div>
                    <span style="font-size:10px; min-width:30px;">${p}%</span>
                    ${infoParts.length ? `<span style="font-size:10px; color:#9ca3af; margin-left: 2px;">${infoParts.join(' · ')}</span>` : ''}
                </div>
            `;
        });

        statusEl.innerHTML = html;
    }

    open() {
        this.overlay.classList.add('active');
        this.refreshTelegramCatalog();
        if (!this._joinedChatsLoadedAt || Date.now() - this._joinedChatsLoadedAt > 300000) {
            this.loadTelegramChats();
        }
        this.loadTelegramHistory();
        setTimeout(() => {
            document.getElementById('quantumSearchInput').focus();
        }, 100);
    }

    sortTelegramChats(chats) {
        const mode = this._telegramChatSort || document.getElementById('telegramChatSort')?.value || 'newest';
        const rows = (chats || []).slice();
        const countOf = chat => {
            if (chat?.video_count != null) return Number(chat.video_count);
            if (chat?.indexed != null) return Number(chat.indexed);
            return -1;
        };
        const whenOf = chat => this.telegramTimestampMs(chat?.last_post_at);
        const titleOf = chat => String(chat?.title || '');
        rows.sort((a, b) => {
            if (mode === 'largest') {
                return countOf(b) - countOf(a) || whenOf(b) - whenOf(a) || titleOf(a).localeCompare(titleOf(b), 'sk');
            }
            if (mode === 'name') return titleOf(a).localeCompare(titleOf(b), 'sk');
            return whenOf(b) - whenOf(a) || countOf(b) - countOf(a) || titleOf(a).localeCompare(titleOf(b), 'sk');
        });
        return rows;
    }

    setTelegramChatSort(mode) {
        this._telegramChatSort = mode || 'newest';
        const list = document.getElementById('telegramJoinedChatsList');
        if (!list || !Array.isArray(this._joinedChats) || !this._joinedChats.length) return;
        const rowById = new Map();
        for (const row of list.querySelectorAll('.telegram-chat-row')) {
            const id = row.dataset.channelId || row.querySelector(':scope > label > input[type="checkbox"]')?.value;
            if (id != null) rowById.set(String(id), row);
        }
        for (const chat of this.sortTelegramChats(this._joinedChats)) {
            const row = rowById.get(String(chat.id));
            if (row) list.append(row);
        }
    }

    updateTelegramChatLabel(span, chat, detailed = false) {
        if (!span || !chat) return;
        let summary;
        if (detailed) {
            summary = `${chat.title} · index ${Number(chat.indexed).toLocaleString('sk-SK')} · prehľadané správy ${Number(chat.scanned || 0).toLocaleString('sk-SK')} / odhad ${chat.video_count == null ? '?' : Number(chat.video_count).toLocaleString('sk-SK')}${chat.complete ? ' ✓' : ''}${chat.error ? ' · chyba, skúsi sa znova' : ''}`;
        } else {
            const count = chat.video_count == null ? 'počet nedostupný' : `${Number(chat.video_count).toLocaleString('sk-SK')} videí`;
            summary = `${chat.title} · ${count}${chat.indexed != null ? ` · index ${Number(chat.indexed).toLocaleString('sk-SK')}${chat.complete ? ' ✓' : ''}` : ''}`;
        }
        const when = this.formatTopicWhen(chat.last_post_at);
        if (!when) {
            span.textContent = summary;
            return;
        }
        span.replaceChildren();
        span.append(document.createTextNode(`${summary} · `));
        const dateEl = document.createElement('span');
        dateEl.className = 'telegram-topic-when';
        dateEl.title = 'Posledný upload príspevku';
        dateEl.textContent = when;
        span.append(dateEl);
    }

    async loadTelegramChats() {
        const list = document.getElementById('telegramJoinedChatsList');
        if (!list || this._joinedChatsLoading) return;
        this._joinedChatsLoading = true;
        document.getElementById('telegramJoinedChatsButton').textContent = 'Načítavam Telegram…';
        try {
            const response = await fetch('/api/v1/telegram/joined_video_chats');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            const chats = Array.isArray(data.chats) ? data.chats : [];
            const sortSelect = document.getElementById('telegramChatSort');
            if (sortSelect) sortSelect.value = this._telegramChatSort || 'newest';
            list.replaceChildren();
            for (const chat of this.sortTelegramChats(chats)) {
                const row = document.createElement('div');
                row.className = 'telegram-chat-row';
                row.dataset.channelId = String(chat.id);
                row.dataset.searchTitle = this.normalizeTelegramChatSearch(`${chat.title || ''} ${chat.username || ''}`);
                const label = document.createElement('label');
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.value = String(chat.id);
                checkbox.checked = this.selectedTelegramChatIds.has(String(chat.id));
                checkbox.addEventListener('change', () => this.selectTelegramChat(checkbox.value, checkbox.checked));
                const text = document.createElement('span');
                this.updateTelegramChatLabel(text, chat, false);
                label.append(checkbox, text);
                const toggle = document.createElement('button');
                toggle.type = 'button';
                toggle.className = 'telegram-topic-toggle';
                toggle.setAttribute('aria-expanded', 'false');
                toggle.title = 'Thready v tejto skupine';
                toggle.textContent = '▸';
                toggle.addEventListener('click', event => {
                    event.preventDefault();
                    event.stopPropagation();
                    this.toggleTelegramTopics(toggle);
                });
                const topics = document.createElement('div');
                topics.className = 'telegram-topic-list';
                topics.hidden = true;
                row.append(label, toggle, topics);
                list.append(row);
            }
            if (!chats.length) list.textContent = (window.__nexus_t ? window.__nexus_t('Žiadne kanály / skupiny') : 'Žiadne kanály / skupiny');
            this._joinedChats = chats;
            this._joinedChatsLoadedAt = Date.now();
            this.ensureSavedTelegramTopics();
            this.filterTelegramChats(document.getElementById('telegramChatSearchInput')?.value || '');
            this.updateTelegramChatButton();
        } catch (error) {
            document.getElementById('telegramJoinedChatsButton').textContent = 'Telegram nedostupný – skúsiť znova';
            this._joinedChatsLoadedAt = 0;
        } finally {
            this._joinedChatsLoading = false;
        }
    }

    async refreshTelegramCatalog() {
        clearTimeout(this._catalogPoll);
        try {
            const response = await fetch('/api/v1/telegram/catalog');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            this._catalogState = data;
            const status = document.getElementById('telegramCatalogStatus');
            const toggle = document.getElementById('telegramCatalogToggle');
            const coverage = document.getElementById('telegramCatalogCoverage');
            const names = {running: 'Indexovanie na pozadí', maintaining: 'Katalóg hotový · kontrolujú sa nové videá', paused: 'Pozastavené', waiting: 'Čaká na Telegram'};
            status.textContent = `${names[data.state] || data.state} · ${Number(data.indexed).toLocaleString('sk-SK')} videí`;
            toggle.textContent = data.enabled ? 'Pozastaviť' : data.discovered_at ? 'Pokračovať' : 'Spustiť indexovanie';
            const indexedActive = Number(data.indexed_active ?? data.indexed) || 0;
            const scanned = Number(data.scanned) || 0;
            const inactive = Number(data.indexed_inactive) || 0;
            coverage.textContent = `${data.complete_channels}/${data.total_channels} kanálov kompletne spracovaných · index v aktívnych kanáloch: ${indexedActive.toLocaleString('sk-SK')} videí · prehľadané: ${scanned.toLocaleString('sk-SK')} video správ · odhad: ~${Number(data.estimated_total).toLocaleString('sk-SK')} videí (${data.counts_known}/${data.total_channels} kanálov)${inactive ? ` · ${inactive.toLocaleString('sk-SK')} indexovaných videí je mimo aktívnych kanálov` : ''}${data.error ? ` · ${data.error}` : ''}`;
            if (data.enabled && data.videos_per_minute) coverage.textContent += ` · ~${Math.round(data.videos_per_minute)} videí/min`;
            if (data.eta_seconds != null) coverage.textContent += ` · odhad archívu ~${Math.ceil(data.eta_seconds / 3600)} h`;
            if (data.discovered_at) {
                this._joinedChats = data.channels;
                // Keep checkbox state and scroll position while coverage changes.
                const list = document.getElementById('telegramJoinedChatsList') || document.getElementById('telegramJoinedChats');
                for (const chat of data.channels) {
                    const checkbox = [...list.querySelectorAll('input[type="checkbox"]')].find(input => input.value === chat.id);
                    if (checkbox?.nextElementSibling) {
                        this.updateTelegramChatLabel(checkbox.nextElementSibling, chat, true);
                        const row = checkbox.closest('.telegram-chat-row') || checkbox.closest('label');
                        if (row) row.dataset.searchTitle = this.normalizeTelegramChatSearch(`${chat.title || ''} ${chat.username || ''}`);
                    }
                }
                if (!list.querySelectorAll('input[type="checkbox"]').length && !this._joinedChatsLoading) this.loadTelegramChats();
            }
        } catch (error) {
            const status = document.getElementById('telegramCatalogStatus');
            if (status) status.textContent = `Katalóg nedostupný: ${error.message}`;
        } finally {
            if (this.overlay?.classList.contains('active')) this._catalogPoll = setTimeout(() => this.refreshTelegramCatalog(), 5000);
        }
    }

    async toggleTelegramCatalog() {
        return this.setTelegramCatalog(!this._catalogState?.enabled);
    }

    async prioritizeTelegramCatalog() {
        return this.setTelegramCatalog(true, [...(this.selectedTelegramChatIds || [])]);
    }

    async setTelegramCatalog(enabled, priorities) {
        const button = document.getElementById('telegramCatalogToggle');
        button.disabled = true;
        try {
            const response = await fetch('/api/v1/telegram/catalog', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({enabled, priority_chat_ids: priorities}),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            await this.refreshTelegramCatalog();
        } catch (error) {
            document.getElementById('telegramCatalogStatus').textContent = `Chyba: ${error.message}`;
        } finally { button.disabled = false; }
    }

    updateCatalogMore() {
        const button = document.getElementById('telegramCatalogMore');
        if (!button) return;
        button.hidden = !this._catalogPage?.hasMore;
        button.disabled = !!this.isSearching;
        button.textContent = this.isSearching ? 'Načítavam…' : `Načítať ďalších ${this._catalogPage?.limit || ''}`;
    }

    loadMoreTelegramCatalog() {
        if (this._catalogPage?.hasMore) return this.searchJoinedChannels(this._catalogPage.query, false, true);
    }

    searchTelegramCatalog(forceLive = false) {
        const query = (document.getElementById('telegramKeywordInput')?.value || document.getElementById('quantumSearchInput')?.value || '').trim();
        return this.searchJoinedChannels(query, forceLive);
    }

    searchNewTelegramVideos() {
        clearTimeout(this._filterSearchTimer);
        this.activeSort = 'relevance';
        const sort = document.getElementById('quantumQuickSort');
        if (sort) sort.value = 'relevance';
        return this.searchJoinedChannels('', false, false, true);
    }

    removeLiveNewResults(items) {
        const ids = new Set(items.map(item => `${item.chat_id}:${item.message_id}`));
        this.results = this.results.filter(item => !ids.has(`${item.chat_id}:${item.message_id}`));
        for (const item of items) this.selectedUrls?.delete(item.url);
        this.updateSelectionToolbar();
        this.applyFilters();
    }

    stopLiveNewTelegramVideos() {
        this._liveNewController?.abort();
    }

    async searchLiveNewTelegramVideos() {
        if (this._liveNewController) return;
        clearTimeout(this._filterSearchTimer);
        const controller = new AbortController();
        this._liveNewController = controller;
        ++this._searchRunId;
        this.results = []; this.filteredResults = [];
        this.selectedUrls?.clear();
        this.activeSource = 'all'; this.activeSort = 'relevance';
        this._catalogPage = {newOnly:true, live:true, hasMore:false};
        this.updateCatalogMore(); this.updateSelectionToolbar(); this.applyFilters();
        const button = document.getElementById('telegramLiveNew');
        const stop = document.getElementById('telegramLiveNewStop');
        const info = document.getElementById('telegramCatalogSearchInfo');
        if (button) button.disabled = true;
        if (stop) stop.hidden = false;
        if (info) info.textContent = 'Pripájam sa k Telegramu…';
        this.setActivity('Živé hľadanie', 'Načítavam skupiny…', 'working');
        let completed = false;
        try {
            const response = await fetch('/api/v1/telegram/live-new-stream', {signal:controller.signal});
            if (!response.ok || !response.body) throw new Error(`Živé hľadanie nie je dostupné (HTTP ${response.status}). Reštartuj Nexus.`);
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let pending = '';
            const seen = new Set();
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                pending += decoder.decode(chunk.value, {stream:true});
                const lines = pending.split('\n'); pending = lines.pop();
                for (const line of lines) {
                    if (!line.startsWith('data:')) continue;
                    const data = JSON.parse(line.slice(5));
                    if (data.status === 'error') throw new Error(data.error);
                    if (data.status === 'flood_wait') {
                        if (info) info.textContent = `Telegram vyžaduje prestávku ${data.seconds} s. Prejdených ${data.completed}/${data.total} skupín, nájdené videá zostali zobrazené.`;
                        this.setActivity('Telegram prestávka', `${data.seconds} s`, 'idle');
                        completed = true; break;
                    }
                    if (data.status === 'progress') {
                        for (const raw of data.videos || []) {
                            const item = this._mapRawTelegramVideo(raw, data.channel);
                            const id = `${item.chat_id}:${item.message_id}`;
                            if (!seen.has(id)) { seen.add(id); this.results.push(item); }
                        }
                        this.applyFilters();
                        if (info) info.textContent = `Naživo · ${data.completed}/${data.total} skupín · ${this.results.length} nových · chyby: ${data.errors} · naposledy: ${data.channel}`;
                        this.setActivity('Živé hľadanie', `${data.completed}/${data.total} skupín · ${this.results.length} videí`, 'working');
                    } else if (data.status === 'start') {
                        if (info) info.textContent = `Naživo · 0/${data.total} skupín · posledných ${data.scan_per_chat} videí, najviac ${data.per_chat} nových na skupinu.`;
                    } else if (data.status === 'done') {
                        if (info) info.textContent = `Hotovo · ${data.completed}/${data.total} skupín · ${this.results.length} nových · chyby: ${data.errors}${data.limited ? ' · dosiahnutý limit 2000 výsledkov' : ''}. Prehľadávaných je posledných 20 videí na skupinu.`;
                        this.setActivity('Živé hľadanie dokončené', `${this.results.length} videí`, 'done');
                        if (!this.results.length) this.applyFilters();
                        completed = true;
                    }
                }
            }
            if (!completed) throw new Error('Spojenie s Telegramom sa prerušilo. Nájdené videá zostali zobrazené.');
        } catch (error) {
            const message = error.name === 'AbortError' ? `Zastavené · ${this.results.length} nájdených videí zostalo zobrazených.` : error.message;
            if (info) info.textContent = message;
            this.setActivity('Živé hľadanie zastavené', message, error.name === 'AbortError' ? 'idle' : 'error');
        } finally {
            if (this._liveNewController === controller) this._liveNewController = null;
            if (button) button.disabled = false;
            if (stop) stop.hidden = true;
        }
    }

    toggleTelegramChats() {
        const options = document.getElementById('telegramJoinedChats');
        if (!options) return;
        options.hidden = !options.hidden;
        document.getElementById('telegramJoinedChatsButton').setAttribute('aria-expanded', String(!options.hidden));
        if (!options.hidden) {
            if (!this._joinedChatsLoadedAt) this.loadTelegramChats();
            else this.ensureSavedTelegramTopics();
            setTimeout(() => document.getElementById('telegramChatSearchInput')?.focus(), 0);
        }
    }

    normalizeTelegramChatSearch(text) {
        return String(text || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim();
    }

    filterTelegramChats(query) {
        const list = document.getElementById('telegramJoinedChatsList');
        const empty = document.getElementById('telegramJoinedChatsEmpty');
        if (!list) return;
        const needle = this.normalizeTelegramChatSearch(query);
        const rows = [...list.querySelectorAll('.telegram-chat-row')];
        let visibleCount = 0;
        for (const row of rows) {
            const channelHay = row.dataset.searchTitle || '';
            const channelMatch = !needle || channelHay.includes(needle);
            const panel = row.querySelector('.telegram-topic-list');
            const toggle = row.querySelector('.telegram-topic-toggle');
            let topicMatch = false;
            for (const item of row.querySelectorAll('.telegram-topic-item')) {
                const title = item.dataset.searchTitle || '';
                const matchesTopic = !needle || title.includes(needle);
                if (needle && title.includes(needle)) topicMatch = true;
                item.hidden = Boolean(needle) && !channelMatch && !matchesTopic;
            }
            const show = channelMatch || topicMatch;
            row.hidden = !show;
            if (show) visibleCount += 1;
            if (!panel || !toggle) continue;
            if (!needle) {
                row.querySelectorAll('.telegram-topic-item').forEach(item => { item.hidden = false; });
                if (panel.dataset.searchOpened === '1' && panel.dataset.userOpen !== '1') {
                    panel.hidden = true;
                    delete panel.dataset.searchOpened;
                    toggle.textContent = '▸';
                    toggle.setAttribute('aria-expanded', 'false');
                }
            } else if (topicMatch && !channelMatch) {
                panel.hidden = false;
                panel.dataset.searchOpened = '1';
                toggle.textContent = '▾';
                toggle.setAttribute('aria-expanded', 'true');
            }
        }
        if (empty) empty.hidden = !(rows.length > 0 && visibleCount === 0);
    }

    setTelegramChatsSelection(selector, checked) {
        document.querySelectorAll(selector).forEach(checkbox => {
            checkbox.checked = checked;
            if (checked) this.selectedTelegramChatIds.add(checkbox.value);
            else this.selectedTelegramChatIds.delete(checkbox.value);
        });
        const input = document.getElementById('telegramChannelInput');
        if (input && checked) input.value = '';
        this.updateTelegramChatButton();
    }

    selectFilteredTelegramChats() {
        this.setTelegramChatsSelection('#telegramJoinedChatsList .telegram-chat-row:not([hidden]) > label > input[type="checkbox"]', true);
        const needle = this.normalizeTelegramChatSearch(document.getElementById('telegramChatSearchInput')?.value || '');
        if (!needle) return;
        document.querySelectorAll('#telegramJoinedChatsList .telegram-chat-row:not([hidden]) .telegram-topic-item:not([hidden]) .telegram-topic-checkbox').forEach(checkbox => {
            const item = checkbox.closest('.telegram-topic-item');
            if (!(item?.dataset.searchTitle || '').includes(needle)) return;
            checkbox.checked = true;
            this.selectTelegramTopic(
                checkbox.dataset.channel,
                checkbox.dataset.topicId,
                item.dataset.topicTitle || '',
                checkbox.dataset.channelTitle || '',
                true,
            );
        });
    }

    selectAllTelegramChats() {
        this.setTelegramChatsSelection('#telegramJoinedChatsList .telegram-chat-row > label > input[type="checkbox"]', true);
    }

    clearSelectedTelegramChats() {
        this.selectedTelegramChatIds.clear();
        this.selectedTelegramTopics.clear();
        document.querySelectorAll('#telegramJoinedChatsList input[type="checkbox"]').forEach(checkbox => {
            checkbox.checked = false;
        });
        this.updateTelegramChatButton();
    }

    updateTelegramChatButton() {
        const button = document.getElementById('telegramJoinedChatsButton');
        if (!button) return;
        const chats = this.selectedTelegramChatIds.size;
        const topics = this.selectedTelegramTopics.size;
        if (!chats && !topics) {
            button.textContent = 'Moje kanály / skupiny';
            button.title = '';
            return;
        }
        const parts = [];
        if (chats) parts.push(this.telegramCountLabel(chats, 'kanál', 'kanály', 'kanálov'));
        if (topics) parts.push(this.telegramCountLabel(topics, 'thread', 'thready', 'threadov'));
        button.textContent = parts.join(' · ');
        button.title = button.textContent;
    }

    telegramCountLabel(count, one, few, many) {
        const word = count === 1 ? one : count >= 2 && count <= 4 ? few : many;
        return `${count} ${word}`;
    }

    telegramTopicKey(channel, topicId) {
        return `${channel}:${topicId}`;
    }

    selectTelegramTopic(channel, topicId, title, channelTitle, checked) {
        const key = this.telegramTopicKey(channel, topicId);
        if (checked) {
            this.selectedTelegramTopics.set(key, {
                channel: String(channel),
                topicId: Number(topicId),
                title: title || '',
                channelTitle: channelTitle || '',
            });
        } else {
            this.selectedTelegramTopics.delete(key);
        }
        const input = document.getElementById('telegramChannelInput');
        if (input && checked) input.value = '';
        this.updateTelegramChatButton();
    }

    selectTelegramChat(id, checked) {
        if (checked) this.selectedTelegramChatIds.add(id);
        else this.selectedTelegramChatIds.delete(id);
        const input = document.getElementById('telegramChannelInput');
        if (input) input.value = '';
        this.updateTelegramChatButton();
    }

    toggleTelegramHelp(forceState) {
        const popover = document.getElementById('telegramSearchHelpPopover');
        const btn = document.getElementById('telegramSearchHelpBtn');
        if (!popover) return;
        const nextHidden = typeof forceState === 'boolean' ? !forceState : !popover.hidden;
        popover.hidden = nextHidden;
        if (btn) btn.setAttribute('aria-expanded', String(!nextHidden));
    }

    toggleTelegramHistory() {
        const options = document.getElementById('telegramSearchHistory');
        if (!options) return;
        options.hidden = !options.hidden;
        document.getElementById('telegramHistoryButton').setAttribute('aria-expanded', String(!options.hidden));
        if (!options.hidden) this.loadTelegramHistory();
    }

    async loadTelegramHistory() {
        const options = document.getElementById('telegramSearchHistory');
        if (!options || this._historyLoading) return;
        this._historyLoading = true;
        try {
            const response = await fetch('/api/v1/telegram/search_history');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            options.replaceChildren();
            for (const item of data.searches || []) {
                const button = document.createElement('button');
                button.type = 'button';
                const when = new Date(item.created_at).toLocaleString('sk-SK');
                const where = (item.chats || []).map(chat => chat.title || chat.id).join(', ');
                button.textContent = `${when} · ${item.query || 'Bez kľúčových slov'} · ${where} · ${item.result_count} videí`;
                button.addEventListener('click', () => this.restoreTelegramHistory(item.id));
                options.append(button);
            }
            if (!options.children.length) options.textContent = (window.__nexus_t ? window.__nexus_t('Zatiaľ žiadne hľadania') : 'Zatiaľ žiadne hľadania');
        } catch (_) {
            options.textContent = 'Históriu sa nepodarilo načítať';
        } finally {
            this._historyLoading = false;
        }
    }

    async saveTelegramHistory(context) {
        try {
            const response = await fetch('/api/v1/telegram/search_history', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: context.query,
                    chats: context.chats,
                    results: this.results,
                    displayed_results: this.filteredResults,
                    filters: { duration: this.activeFilters.duration, quality: this.requestedQuality(), min_size_mb: this.requestedMinSizeMb(), limit: context.limit, sort: this.activeSort, excluded: document.getElementById('telegramExcludeInput')?.value || '', catalog_page: this._catalogPage || null }
                })
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            this.loadTelegramHistory();
        } catch (error) {
            this.updateScrapeStatus(null, null, null, `Výsledky sú zobrazené, ale históriu sa nepodarilo uložiť (${this.escapeHtml(error.message)}).`);
        }
    }

    async restoreTelegramHistory(id) {
        try {
            const response = await fetch(`/api/v1/telegram/search_history/${encodeURIComponent(id)}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const record = await response.json();
            this.cancelSearch();
            if (this._activeScrapeController) this._activeScrapeController.abort();
            const stopButton = document.getElementById('quantumStopScrapeBtn');
            if (stopButton) stopButton.style.display = 'none';
            this._telegramHistoryContext = null;
            this._telegramMultiLimit = 0;
            this._catalogPage = record.filters?.catalog_page || null;
            const excludeInput = document.getElementById('telegramExcludeInput');
            if (excludeInput) excludeInput.value = record.filters?.excluded || '';
            this.updateCatalogMore();
            this.globalTelegram = (record.chats || []).some(chat => chat.id === 'all');
            const globalButton = document.getElementById('telegramGlobalSearchBtn');
            if (globalButton) globalButton.setAttribute('aria-pressed', String(this.globalTelegram));
            this.results = Array.isArray(record.results) ? record.results : [];
            for (const item of this.results) {
                if ((item.source || '').toLowerCase() === 'telegram' && item.chat_id && item.message_id) {
                    item.thumbnail = item.thumb_url = `/api/v1/telegram/thumb/${item.chat_id}/${item.message_id}?v=${Date.now()}`;
                }
            }
            this.filteredResults = Array.isArray(record.displayed_results) ? record.displayed_results : [...this.results];
            this._filteredBeforeLimit = this.filteredResults.length;
            this.activeSource = 'all';
            if (record.filters?.sort) this.activeSort = record.filters.sort;
            const queryInput = document.getElementById('telegramKeywordInput');
            if (queryInput) queryInput.value = record.query || '';
            this.selectedTelegramTopics.clear();
            const channelIds = [];
            for (const chat of record.chats || []) {
                if (Number(chat.topicId) > 0) {
                    const channel = String(chat.id);
                    this.selectedTelegramTopics.set(this.telegramTopicKey(channel, chat.topicId), {
                        channel,
                        topicId: Number(chat.topicId),
                        title: chat.topicTitle || '',
                        channelTitle: chat.channelTitle || '',
                    });
                } else {
                    channelIds.push(String(chat.id));
                }
            }
            this.selectedTelegramChatIds = new Set(channelIds);
            document.querySelectorAll('#telegramJoinedChatsList .telegram-chat-row > label > input[type="checkbox"]').forEach(item => {
                item.checked = this.selectedTelegramChatIds.has(item.value);
            });
            document.querySelectorAll('#telegramJoinedChatsList .telegram-topic-checkbox').forEach(item => {
                item.checked = this.selectedTelegramTopics.has(this.telegramTopicKey(item.dataset.channel, item.dataset.topicId));
            });
            this.updateTelegramChatButton();
            const chatOptions = document.getElementById('telegramJoinedChats');
            if (chatOptions) chatOptions.hidden = true;
            const chatButton = document.getElementById('telegramJoinedChatsButton');
            if (chatButton) chatButton.setAttribute('aria-expanded', 'false');
            document.getElementById('telegramSearchHistory').hidden = true;
            document.getElementById('telegramHistoryButton').setAttribute('aria-expanded', 'false');
            this.applyFilters();
            this.updateScrapeStatus('Uložené hľadanie', `${this.results.length} videí`, 100,
                `${this.escapeHtml(new Date(record.created_at).toLocaleString('sk-SK'))} · ${this.escapeHtml(record.query || 'Bez kľúčových slov')} · ${this.escapeHtml((record.chats || []).map(chat => chat.title || chat.id).join(', '))}`, 'done');
        } catch (error) {
            this.showError(`Históriu sa nepodarilo otvoriť: ${error.message}`);
        }
    }

    close() {
        clearTimeout(this._catalogPoll);
        this._stopBypassCooldownTimer();
        this.closeMegaPopovers();
        this.closeMegaHarvestInspector();
        if (this.overlay && this.overlay.classList) {
            this.overlay.classList.remove('active');
        }
        // Don't clear results, keep them for re-opening
    }

    isOpen() {
        return this.overlay.classList.contains('active');
    }

    showLoading(show) {
        const loader = document.getElementById('quantumSearchLoading');
        if (show) {
            loader.classList.add('active');
        } else {
            loader.classList.remove('active');
        }
    }

    showError(message) {
        const container = document.getElementById('quantumSearchResults');
        const stats = document.getElementById('quantumSearchStats');
        if (stats) stats.style.display = 'none';
        container.innerHTML = `
            <div class="quantum-search-empty">
                <div class="quantum-search-empty-icon">⚠️</div>
                <div class="quantum-search-empty-text">${this.escapeHtml(String(message || 'Scrape failed'))}</div>
            </div>
        `;
    }

    escapeHtml(text) {
        if (!document || typeof document.createElement !== 'function') {
            return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    async renderHistory() {
        const container = document.getElementById('quantumSearchResults');
        const stats = document.getElementById('quantumSearchStats');
        stats.style.display = 'none';

        try {
            const response = await fetch('/api/v1/search/history?limit=10');
            const history = await response.json();

            if (history.length === 0) {
                this.clearResults();
                return;
            }

            container.innerHTML = `
                <div class="search-history-container" style="grid-column: 1/-1;">
                    <h3 style="color: rgba(255,255,255,0.4); font-size: 14px; margin-bottom: 12px; margin-left: 5px;">Recent Searches</h3>
                    ${history.map(item => `
                        <div class="history-item" onclick="quantumSearch.applyHistory('${item.query.replace(/'/g, "\\'")}')">
                            <span class="material-icons-round">history</span>
                            <div class="history-query">${item.query}</div>
                            <div class="history-meta">${item.results_count} results • ${this.formatRelativeTime(item.created_at)}</div>
                        </div>
                    `).join('')}
                    <button class="quantum-btn" onclick="quantumSearch.clearResults()" style="margin-top: 15px; align-self: flex-start;">Clear View</button>
                </div>
            `;
        } catch (error) {
            console.error('History error:', error);
            this.clearResults();
        }
    }

    openTelegramSettings() {
        const rootEl = document.querySelector('.dashboard, [x-data]');
        if (window.Alpine && rootEl) {
            try {
                const rootData = Alpine.$data(rootEl);
                if (rootData) {
                    rootData.showSettings = true;
                    setTimeout(() => {
                        const settingsCard = document.querySelector('.settings-card');
                        if (settingsCard && window.Alpine) {
                            const cardData = Alpine.$data(settingsCard);
                            if (cardData) cardData.tab = 'telegram';
                        }
                    }, 50);
                    return;
                }
            } catch (_) {}
        }
        const modal = document.querySelector('.nexus-settings, .modal-wrap.nexus-settings, #settingsModal');
        if (modal) {
            modal.style.display = 'flex';
            const tgTab = document.querySelector('[data-tab="telegram"]') || document.getElementById('tab-telegram');
            if (tgTab) tgTab.click();
        }
    }

    updateScrapeStatus(stateText, countText, percent, detailsHtml, pulseType = '') {
        const statusBox = document.getElementById('quantumScrapeStatus');
        if (!statusBox) return;
        statusBox.style.display = 'block';
        const stateEl = document.getElementById('quantumStatusState');
        const countEl = document.getElementById('quantumStatusCount');
        const fillEl = document.getElementById('quantumProgressBarFill');
        const detailsEl = document.getElementById('quantumStatusDetails');
        const pulseEl = document.getElementById('quantumStatusPulse');

        if (stateEl && stateText !== null) stateEl.textContent = stateText;
        if (countEl && countText !== null) countEl.textContent = countText;
        if (fillEl && percent !== null) fillEl.style.width = `${Math.min(100, Math.max(0, percent))}%`;
        if (detailsEl && detailsHtml !== null) detailsEl.innerHTML = detailsHtml;
        if (pulseEl) {
            pulseEl.className = 'quantum-status-pulse' + (pulseType ? ` ${pulseType}` : '');
        }
    }

    stopScrape() {
        if (this._activeScrapeController) {
            try { this._activeScrapeController.abort(); } catch (_) {}
            this._activeScrapeController = null;
        }
        this.finishScrape(true);
    }

    finishScrape(stoppedByUser = false, errorMessage = null, needsAuth = false) {
        const historyContext = this._telegramHistoryContext;
        this._telegramHistoryContext = null;
        if (this._scrapeTimerInterval) {
            if (typeof clearInterval === 'function') clearInterval(this._scrapeTimerInterval);
            this._scrapeTimerInterval = null;
        }
        const button = document.getElementById('scrapeChannelBtn');
        if (button) button.disabled = false;
        this.showLoading(false);
        const stopBtn = document.getElementById('quantumStopScrapeBtn');
        if (stopBtn) stopBtn.style.display = 'none';

        if (stoppedByUser) {
            this.setActivity('Scrape stopped', `${this.filteredResults.length} matching results kept.`, 'idle');
            this.updateScrapeStatus(
                (window.__nexus_t ? window.__nexus_t('Zastavené') : 'Zastavené'),
                `${this.results.length} nájdených`,
                null,
                `Scrape bol zastavený používateľom. Zobrazujem <strong>${this.filteredResults.length}</strong> vyhovujúcich videí.`,
                'stopped'
            );
            if (this.results.length > 0) {
                this.applyFilters();
            }
        } else if (errorMessage) {
            this.setActivity('Scrape failed', String(errorMessage), 'error');
            const authBtn = needsAuth
                ? `<button type="button" class="quantum-status-action-btn" onclick="quantumSearch.openTelegramSettings()"><span class="material-icons-round" style="font-size:13px; margin-right:3px;">settings</span>Prihlásiť Telegram účet</button>`
                : '';
            this.updateScrapeStatus(
                (typeof window !== 'undefined' && window.__nexus_t ? window.__nexus_t('Chyba') : 'Chyba'),
                '0 videí',
                0,
                `<span style="color:#fca5a5;">${this.escapeHtml(errorMessage)}</span> ${authBtn}`,
                'error'
            );
        } else {
            this.updateScrapeStatus(
                'Dokončené',
                `${this.results.length} videí`,
                100,
                `Hľadanie úspešne dokončené. Zobrazených <strong>${this.filteredResults.length}</strong> videí spĺňajúcich filtre.`,
                'done'
            );
            if (historyContext) this.saveTelegramHistory(historyContext);
        }
    }

    _mapRawTelegramVideo(video, channel) {
        const title = (video.title || video.text || '').trim() || `${video.channel || channel} #${video.id || video.message_id}`;
        const playUrl = video.video_url || video.stream_url || video.url || '';
        const w = Number(video.width) || 0;
        const h = Number(video.height) || 0;
        const orientation = this._videoOrientation({ ...video, width: w, height: h });
        let effRes = Number(video.effective_res) || 0;
        if (!effRes && (w > 0 || h > 0)) {
            const shortEdge = (w > 0 && h > 0) ? Math.min(w, h) : Math.max(w, h);
            const longEdge = Math.max(w, h);
            if (shortEdge >= 2160 || longEdge >= 3840) effRes = 2160;
            else if (shortEdge >= 1440 || longEdge >= 2560) effRes = 1440;
            else if (shortEdge >= 1080 || longEdge >= 1920) effRes = 1080;
            else if (shortEdge >= 720 || longEdge >= 1280) effRes = 720;
            else if (shortEdge >= 480 || longEdge >= 840) effRes = 480;
            else effRes = shortEdge;
        }
        const quality = video.quality || (effRes >= 2160 ? '4K' : effRes >= 1080 ? '1080p' : effRes >= 720 ? '720p' : effRes >= 480 ? '480p' : '');
        return {
            title,
            url: video.url || playUrl,
            source_url: video.url || '',
            stream_url: playUrl,
            thumbnail: video.thumbnail || '',
            thumb_url: video.thumbnail || '',
            duration: video.duration || '',
            source: 'Telegram',
            channel: video.channel || channel,
            source_channels: Array.isArray(video.source_channels) ? video.source_channels : [video.author || video.channel_title || video.channel || channel],
            upload_date: video.date ? String(video.date).slice(0, 10) : '',
            views: Number(video.views) || 0,
            forwards: Number(video.forwards) || 0,
            reactions: Number(video.reactions) || 0,
            size_bytes: Number(video.size_bytes) || 0,
            width: w,
            height: h,
            effective_res: effRes,
            quality: quality,
            orientation: orientation.orientation,
            orientation_evidence: orientation.evidence,
            file_name: video.file_name || '',
            text: video.text || '',
            tags: video.tags || [],
            performers: video.performers || [],
            scene_title: video.scene_title || '',
            platform: video.platform || '',
            preview_unavailable: !!video.preview_unavailable,
            message_id: video.message_id || video.id,
            chat_id: video.chat_id,
            channel_id: video.chat_id,
            file_id: video.file_id || '',
            topic_id: Number(video.topic_id) || null,
            topic_title: video.topic_title || '',
            topic_video_count: video.topic_video_count == null || video.topic_video_count === '' ? null : Number(video.topic_video_count),
            topic_url: video.topic_url || '',
            topic_channel: video.topic_channel || video.channel || channel,
        };
    }

    _topicChip(result) {
        const topicId = Number(result.topic_id);
        const title = result.topic_title;
        if (!topicId || topicId <= 1 || !title) return '';
        const count = result.topic_video_count;
        const countLabel = count == null || Number.isNaN(Number(count)) ? '' : ` · ${Number(count).toLocaleString('sk-SK')} videí`;
        const channel = result.topic_channel || result.channel || result.chat_id || '';
        return `<button type="button" class="tg-topic-chip" data-topic-id="${topicId}" data-topic-channel="${this.escapeHtml(String(channel))}" data-topic-title="${this.escapeHtml(String(title))}" title="Scrapeovať len tento thread">${this.escapeHtml(String(title))}${countLabel}</button>`;
    }

    _refreshTopicMeta(topics) {
        const byId = new Map();
        for (const topic of topics || []) {
            const id = topic.topic_id || topic.id;
            if (id) byId.set(String(id), topic);
        }
        if (!byId.size) return;
        let changed = false;
        for (const item of this.results || []) {
            const topic = byId.get(String(item.topic_id));
            if (!topic) continue;
            const before = `${item.topic_title}|${item.topic_video_count}`;
            if (topic.topic_title || topic.title) item.topic_title = topic.topic_title || topic.title;
            const count = topic.topic_video_count != null ? topic.topic_video_count : topic.video_count;
            if (count != null && count !== '') item.topic_video_count = Number(count);
            if (topic.topic_url || topic.url) item.topic_url = topic.topic_url || topic.url;
            if (`${item.topic_title}|${item.topic_video_count}` !== before) changed = true;
        }
        if (changed) this.applyFilters();
    }

    telegramScrapeQuery(channel, limit, query, minDuration, minQuality, minSizeMb, topicId) {
        const params = new URLSearchParams({
            channel: String(channel),
            limit: String(limit),
            query: query || '',
            min_duration: String(minDuration || 0),
            min_quality: String(minQuality || 0),
            min_size_mb: String(minSizeMb || 0),
        });
        if (Number(topicId) > 0) params.set('topic_id', String(Number(topicId)));
        return `/api/v1/telegram/scrape_stream?${params}`;
    }

    async ensureSavedTelegramTopics() {
        if (this._savedTelegramTopics) {
            this.paintSavedTelegramTopics();
            return;
        }
        if (this._savedTopicsLoading) return;
        this._savedTopicsLoading = true;
        try {
            const response = await fetch('/api/v1/telegram/topics/saved');
            if (!response.ok) return;
            const data = await response.json();
            const incoming = data.channels || {};
            if (!this._savedTelegramTopics) this._savedTelegramTopics = {};
            for (const [key, topics] of Object.entries(incoming)) {
                if (!this._savedTelegramTopics[key]?.length) this._savedTelegramTopics[key] = topics;
            }
        } catch (_) {
            return;
        } finally {
            this._savedTopicsLoading = false;
        }
        this.paintSavedTelegramTopics();
    }

    paintSavedTelegramTopics() {
        const list = document.getElementById('telegramJoinedChatsList');
        if (!list || !this._savedTelegramTopics) return;
        for (const row of list.querySelectorAll('.telegram-chat-row')) {
            const channelBox = row.querySelector(':scope > label > input[type="checkbox"]');
            const panel = row.querySelector('.telegram-topic-list');
            if (!channelBox || !panel || panel.dataset.refreshing === '1' || panel.dataset.live === '1') continue;
            const topics = this._savedTelegramTopics[channelBox.value];
            if (!topics?.length) continue;
            this.renderTelegramTopicItems(panel, channelBox.value, topics);
            panel.dataset.cached = '1';
        }
        this.filterTelegramChats(document.getElementById('telegramChatSearchInput')?.value || '');
        this.updateMissingTopicCountButton();
    }

    renderTelegramTopicItems(panel, channelId, topics) {
        const channelTitle = (this._joinedChats || []).find(item => String(item.id) === String(channelId))?.title || channelId;
        const note = panel.querySelector('.telegram-topic-note')?.textContent || '';
        const missing = topics.filter(topic => topic.video_count == null).length;
        panel.replaceChildren();
        const bar = document.createElement('div');
        bar.className = 'telegram-topic-counts';
        const missingButton = document.createElement('button');
        missingButton.type = 'button';
        missingButton.textContent = missing ? `Doplniť chýbajúce (${missing})` : 'Chýbajúce sú doplnené';
        missingButton.disabled = !missing;
        missingButton.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            missingButton.textContent = 'Dopĺňam…';
            const row = missingButton.closest('.telegram-chat-row');
            const channel = row?.querySelector('label input[type="checkbox"]')?.value || channelId;
            this.refreshTelegramTopicCounts(channel, 'missing', missingButton.closest('.telegram-topic-list'));
        });
        const allButton = document.createElement('button');
        allButton.type = 'button';
        allButton.textContent = 'Obnoviť všetky';
        allButton.title = 'Znova sa opýta na počet videí pri každom threade tejto skupiny';
        allButton.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            allButton.textContent = 'Obnovujem…';
            const row = allButton.closest('.telegram-chat-row');
            const channel = row?.querySelector('label input[type="checkbox"]')?.value || channelId;
            this.refreshTelegramTopicCounts(channel, 'all', allButton.closest('.telegram-topic-list'));
        });
        const sort = document.createElement('select');
        sort.className = 'telegram-topic-sort';
        sort.setAttribute('aria-label', 'Zoradiť thready');
        for (const [value, label] of [['newest', 'Najnovšie'], ['largest', 'Najväčšie'], ['name', 'Názov']]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            sort.append(option);
        }
        sort.value = this._telegramTopicSort || 'newest';
        sort.addEventListener('click', event => event.stopPropagation());
        sort.addEventListener('change', event => {
            event.stopPropagation();
            this._telegramTopicSort = sort.value;
            this.renderTelegramTopicItems(panel, channelId, topics);
        });
        bar.append(missingButton, allButton, sort);
        panel.append(bar);
        for (const topic of this.sortTelegramTopics(topics)) {
            const item = document.createElement('div');
            item.className = 'telegram-topic-item';
            item.dataset.searchTitle = this.normalizeTelegramChatSearch(topic.title);
            item.dataset.topicTitle = topic.title || '';
            const choice = document.createElement('label');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'telegram-topic-checkbox';
            checkbox.dataset.channel = String(channelId);
            checkbox.dataset.topicId = String(topic.id);
            checkbox.dataset.channelTitle = channelTitle;
            checkbox.checked = this.selectedTelegramTopics.has(this.telegramTopicKey(channelId, topic.id));
            checkbox.addEventListener('change', () => {
                this.selectTelegramTopic(channelId, topic.id, topic.title, channelTitle, checkbox.checked);
            });
            const name = document.createElement('span');
            name.className = 'telegram-topic-name';
            const title = document.createElement('span');
            title.className = 'telegram-topic-title';
            title.textContent = topic.title || '';
            const meta = document.createElement('span');
            meta.className = 'telegram-topic-meta';
            if (topic.video_count != null) {
                const count = document.createElement('span');
                count.className = 'telegram-topic-count';
                count.textContent = `${Number(topic.video_count).toLocaleString('sk-SK')} videí`;
                meta.append(count);
            }
            const when = this.formatTopicWhen(topic.last_message_at);
            if (when) {
                const date = document.createElement('span');
                date.className = 'telegram-topic-when';
                date.textContent = when;
                meta.append(date);
            }
            if (!meta.childNodes.length) meta.hidden = true;
            name.append(title, meta);
            choice.append(checkbox, name);
            const scrape = document.createElement('button');
            scrape.type = 'button';
            scrape.textContent = 'Scrape';
            scrape.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                this.scrapeTelegramTopic(channelId, topic.id, topic.title, channelTitle);
            });
            item.append(choice, scrape);
            panel.append(item);
        }
        if (note) this._setTopicNote(panel, note);
    }

    _setTopicNote(panel, text) {
        let note = panel.querySelector('.telegram-topic-note');
        if (!text) {
            note?.remove();
            return;
        }
        if (!note) {
            note = document.createElement('div');
            note.className = 'telegram-topic-empty telegram-topic-note';
            const bar = panel.querySelector('.telegram-topic-counts');
            if (bar) bar.after(note);
            else panel.append(note);
        }
        note.textContent = text;
    }

    sortTelegramTopics(topics) {
        const mode = this._telegramTopicSort || 'newest';
        const rows = (topics || []).slice();
        const countOf = topic => topic.video_count == null ? -1 : Number(topic.video_count);
        const whenOf = topic => Number(topic.last_message_at) || 0;
        const titleOf = topic => String(topic.title || '');
        rows.sort((a, b) => {
            if (mode === 'largest') {
                return countOf(b) - countOf(a) || whenOf(b) - whenOf(a) || titleOf(a).localeCompare(titleOf(b), 'sk');
            }
            if (mode === 'name') return titleOf(a).localeCompare(titleOf(b), 'sk');
            return whenOf(b) - whenOf(a) || countOf(b) - countOf(a) || titleOf(a).localeCompare(titleOf(b), 'sk');
        });
        return rows;
    }

    telegramTimestampMs(value) {
        if (value == null || value === '') return 0;
        const stamp = Number(value);
        if (Number.isFinite(stamp) && stamp > 0) {
            return stamp > 1e11 ? stamp : stamp * 1000;
        }
        const parsed = Date.parse(String(value));
        return Number.isNaN(parsed) ? 0 : parsed;
    }

    formatTopicWhen(value) {
        const ms = this.telegramTimestampMs(value);
        if (!ms) return '';
        const date = new Date(ms);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleString('sk-SK', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    topicCountNote(data, topics) {
        const missing = (topics || []).filter(topic => topic.video_count == null).length;
        if (data?.stale) return 'Telegram teraz neodpovedal. Zostali uložené thready.';
        if (!missing) return '';
        if (data?.counts_limited) return `Chýba počet videí: ${missing}. Telegram požiadal o pauzu, doplň ich znova o chvíľu.`;
        return `Chýba počet videí: ${missing}. Doplniť chýbajúce sa opýta len na ne.`;
    }

    _telegramChatRow(channelId) {
        const wanted = String(channelId);
        return [...document.querySelectorAll('#telegramJoinedChatsList .telegram-chat-row')]
            .find(row => row.dataset.channelId === wanted || row.querySelector(':scope > label > input[type="checkbox"]')?.value === wanted) || null;
    }

    updateMissingTopicCountButton() {
        const button = document.getElementById('telegramRefreshMissingCounts');
        if (!button || this._topicCountsBusy) return;
        let missing = 0;
        for (const topics of Object.values(this._savedTelegramTopics || {})) {
            missing += (topics || []).filter(topic => topic.video_count == null).length;
        }
        button.disabled = !missing;
        button.textContent = missing ? `Doplniť chýbajúce (${missing})` : 'Doplniť chýbajúce';
        button.title = missing
            ? 'Doplní počet videí len pri threadoch, ktoré ho ešte nemajú'
            : 'Všetky načítané thready už majú počet videí';
    }

    async refreshTelegramTopicCounts(channelId, mode, panel) {
        panel = panel || this._telegramChatRow(channelId)?.querySelector('.telegram-topic-list');
        if (!channelId) {
            if (panel) this._setTopicNote(panel, 'Túto skupinu sa nepodarilo nájsť.');
            return null;
        }
        if (panel?.dataset.refreshing === '1') {
            this._setTopicNote(panel, 'Počty sa práve dopĺňajú, chvíľu to trvá…');
            return null;
        }
        if (panel) {
            panel.dataset.refreshing = '1';
            panel.querySelectorAll('.telegram-topic-counts button').forEach(button => { button.disabled = true; });
            this._setTopicNote(panel, mode === 'all' ? 'Obnovujem všetky počty…' : 'Dopĺňam chýbajúce počty…');
        }
        this.setActivity('Telegram thready', mode === 'all' ? 'Obnovujem všetky počty' : 'Dopĺňam chýbajúce počty', 'working');
        let data = null;
        let skip = 0;
        const batchSize = 20;
        try {
            for (let round = 0; round < 12; round += 1) {
                const params = new URLSearchParams({
                    channel: String(channelId),
                    counts: mode,
                    batch: String(batchSize),
                });
                if (mode === 'all') params.set('skip', String(skip));
                const response = await fetch(`/api/v1/telegram/topics?${params}`);
                data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
                const topics = Array.isArray(data.topics) ? data.topics : [];
                if (!this._savedTelegramTopics) this._savedTelegramTopics = {};
                if (topics.length) this._savedTelegramTopics[channelId] = topics;
                const missing = topics.filter(topic => topic.video_count == null).length;
                if (panel && topics.length) {
                    this.renderTelegramTopicItems(panel, channelId, topics);
                    panel.dataset.live = '1';
                    panel.dataset.cached = '1';
                    panel.querySelectorAll('.telegram-topic-counts button').forEach(button => { button.disabled = true; });
                    this.filterTelegramChats(document.getElementById('telegramChatSearchInput')?.value || '');
                }
                if (data.stale) {
                    if (panel) this._setTopicNote(panel, this.topicCountNote(data, topics));
                    this.setActivity('Telegram thready', 'Telegram teraz neodpovedal', 'error');
                    break;
                }
                if (mode === 'all') {
                    const asked = Number(data.asked) || 0;
                    const total = topics.length;
                    skip += asked;
                    if (!asked || data.counts_limited || skip >= total) {
                        const reason = data.counts_limited
                            ? `Telegram požiadal o pauzu. Obnovené ${Math.min(skip, total)} z ${total}.`
                            : this.topicCountNote(data, topics);
                        if (panel) this._setTopicNote(panel, reason);
                        this.setActivity('Telegram thready', data.counts_limited ? reason : `Obnovené ${Math.min(skip, total)} z ${total}`, data.counts_limited ? 'error' : 'done');
                        break;
                    }
                    if (panel) this._setTopicNote(panel, `Obnovené ${skip} / ${total}…`);
                    this.setActivity('Telegram thready', `Obnovené ${skip} / ${total}`, 'working');
                    continue;
                }
                if (!missing) {
                    if (panel) this._setTopicNote(panel, this.topicCountNote(data, topics));
                    this.setActivity('Telegram thready', 'Chýbajúce počty sú doplnené', 'done');
                    break;
                }
                if (!data.filled) {
                    const reason = data.counts_limited
                        ? `Telegram požiadal o pauzu. Stále chýba ${missing}. Skús o chvíľu.`
                        : `Telegram nedal nový počet. Stále chýba ${missing}.`;
                    if (panel) this._setTopicNote(panel, reason);
                    this.setActivity('Telegram thready', reason, 'error');
                    break;
                }
                if (panel) this._setTopicNote(panel, `Doplnené, chýba ešte ${missing}…`);
                this.setActivity('Telegram thready', `Chýba ešte ${missing} počtov`, 'working');
            }
            return data;
        } catch (error) {
            const message = `Počty sa nepodarilo obnoviť (${error.message || 'chyba'}).`;
            if (panel) {
                panel.querySelectorAll('.telegram-topic-counts button').forEach(button => { button.disabled = false; });
                this._setTopicNote(panel, message);
            }
            this.setActivity('Telegram thready', message, 'error');
            return null;
        } finally {
            if (panel) {
                delete panel.dataset.refreshing;
                const missingLeft = (this._savedTelegramTopics?.[channelId] || []).some(topic => topic.video_count == null);
                const buttons = panel.querySelectorAll('.telegram-topic-counts button');
                if (buttons[0]) buttons[0].disabled = !missingLeft;
                if (buttons[1]) buttons[1].disabled = false;
            }
            this.updateMissingTopicCountButton();
        }
    }

    async refreshAllMissingTopicCounts() {
        const button = document.getElementById('telegramRefreshMissingCounts');
        if (this._topicCountsBusy) {
            if (button) button.textContent = 'Už dopĺňam…';
            return;
        }
        const ids = Object.entries(this._savedTelegramTopics || {})
            .filter(([, topics]) => (topics || []).some(topic => topic.video_count == null))
            .map(([id]) => id);
        if (!ids.length) {
            this.updateMissingTopicCountButton();
            return;
        }
        this._topicCountsBusy = true;
        if (button) {
            button.disabled = true;
            button.textContent = 'Dopĺňam…';
        }
        let paused = false;
        try {
            for (let index = 0; index < ids.length; index += 1) {
                if (button) {
                    button.disabled = true;
                    button.textContent = `Dopĺňam ${index + 1}/${ids.length}…`;
                }
                const data = await this.refreshTelegramTopicCounts(ids[index], 'missing');
                if (data?.counts_limited) {
                    paused = true;
                    break;
                }
            }
        } finally {
            this._topicCountsBusy = false;
            this.updateMissingTopicCountButton();
            if (paused && button) {
                button.disabled = false;
                button.textContent = 'Pauza, skús o chvíľu';
                button.title = 'Telegram požiadal o pauzu. Zvyšné thready doplň znova o chvíľu.';
            }
        }
    }

    scrapeTelegramTopic(channel, topicId, topicTitle, channelTitle) {
        const id = Number(topicId);
        if (!channel || !id) return;
        const options = document.getElementById('telegramJoinedChats');
        if (options) options.hidden = true;
        const button = document.getElementById('telegramJoinedChatsButton');
        if (button) button.setAttribute('aria-expanded', 'false');
        return this.scrapeChannel({
            channel: String(channel),
            topicId: id,
            topicTitle: topicTitle || '',
            channelTitle: channelTitle || '',
        });
    }

    async toggleTelegramTopics(button) {
        const row = button.closest('.telegram-chat-row');
        const panel = row?.querySelector('.telegram-topic-list');
        const checkbox = row?.querySelector(':scope > label > input[type="checkbox"]');
        if (!panel || !checkbox) return;
        const opening = panel.hidden;
        panel.hidden = !opening;
        button.setAttribute('aria-expanded', String(opening));
        button.textContent = opening ? '▾' : '▸';
        if (!opening) {
            delete panel.dataset.userOpen;
            delete panel.dataset.searchOpened;
            return;
        }
        panel.dataset.userOpen = '1';
        const channelId = checkbox.value;
        const known = this._savedTelegramTopics?.[channelId];
        panel.dataset.refreshing = '1';
        if (known?.length) {
            this.renderTelegramTopicItems(panel, channelId, known);
            panel.querySelectorAll('.telegram-topic-counts button').forEach(item => { item.disabled = true; });
            this.filterTelegramChats(document.getElementById('telegramChatSearchInput')?.value || '');
            this._setTopicNote(panel, 'Aktualizujem thready…');
        } else if (!panel.querySelector('.telegram-topic-item')) panel.textContent = 'Načítavam thready…';
        try {
            const response = await fetch(`/api/v1/telegram/topics?channel=${encodeURIComponent(channelId)}`);
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
            const topics = Array.isArray(data.topics) ? data.topics : [];
            if (!this._savedTelegramTopics) this._savedTelegramTopics = {};
            if (topics.length) {
                this._savedTelegramTopics[channelId] = topics;
                this.renderTelegramTopicItems(panel, channelId, topics);
                panel.dataset.live = '1';
                panel.dataset.cached = '1';
            } else if (!known?.length) {
                panel.replaceChildren();
                const empty = document.createElement('div');
                empty.className = 'telegram-topic-empty';
                empty.textContent = 'Táto skupina nemá thready.';
                panel.append(empty);
            }
            if (!topics.length && known?.length) this._setTopicNote(panel, 'Nové thready sa nepodarilo načítať. Zostali uložené.');
            else this._setTopicNote(panel, this.topicCountNote(data, topics));
            this.filterTelegramChats(document.getElementById('telegramChatSearchInput')?.value || '');
            this.updateMissingTopicCountButton();
        } catch (error) {
            if (!panel.querySelector('.telegram-topic-item')) panel.textContent = 'Thready sa nepodarilo načítať.';
            else {
                panel.querySelectorAll('.telegram-topic-counts button').forEach(item => { item.disabled = false; });
                this._setTopicNote(panel, 'Nové thready sa nepodarilo načítať. Zostali uložené.');
            }
        } finally {
            delete panel.dataset.refreshing;
        }
    }

    async scrapeChannel(override) {
        const topicOverride = override && Number(override.topicId) > 0 ? override : null;
        this._catalogPage = null;
        this.updateCatalogMore();
        const selected = topicOverride ? [] : [...(this.selectedTelegramChatIds || [])];
        const channel = topicOverride
            ? String(topicOverride.channel || '')
            : (selected[0] || (document.getElementById('telegramChannelInput')?.value || '').trim());
        const topicId = topicOverride ? Number(topicOverride.topicId) : 0;
        const topicTitle = topicOverride ? String(topicOverride.topicTitle || '') : '';
        const channelLabelBase = topicOverride
            ? (topicOverride.channelTitle || channel)
            : (selected.length ? (this._joinedChats || []).find(item => String(item.id) === channel)?.title || channel : channel);
        const channelLabel = topicTitle ? `${channelLabelBase} · ${topicTitle}` : channelLabelBase;
        let query = (document.getElementById('telegramKeywordInput')?.value || '').trim();
        if (!query) {
            query = (document.getElementById('quantumSearchInput')?.value || '').trim();
        }
        const limit = this.getTelegramLimit();
        const button = document.getElementById('scrapeChannelBtn');
        const topicTargets = topicOverride
            ? []
            : (this.selectedTelegramTopics ? [...this.selectedTelegramTopics.values()] : []);
        if (!channel && !topicTargets.length) {
            if (this.globalTelegram || query) {
                return this.searchTelegramCatalog();
            }
            this.showError('Zadajte názov Telegram kanála.');
            this.setActivity('Scrape needs a channel', 'Enter a Telegram channel name or choose one of your channels.', 'error');
            return;
        }
        if (topicTargets.length) {
            const covered = new Set(topicTargets.map(item => String(item.channel)));
            const channelTargets = selected
                .filter(id => !covered.has(String(id)))
                .map(id => ({ id, title: (this._joinedChats || []).find(item => String(item.id) === id)?.title || id }));
            const targets = [
                ...topicTargets.map(item => ({
                    id: item.channel,
                    title: `${item.channelTitle || item.channel} · ${item.title}`,
                    topicId: item.topicId,
                    topicTitle: item.title,
                    channelTitle: item.channelTitle || item.channel,
                })),
                ...channelTargets,
            ];
            if (targets.length === 1 && targets[0].topicId) {
                const only = topicTargets[0];
                return this.scrapeTelegramTopic(only.channel, only.topicId, only.title, only.channelTitle);
            }
            return this.scrapeMultipleTelegramChats(targets, query, limit);
        }
        const chats = topicOverride
            ? [{ id: channel, title: channelLabel, topicId, topicTitle, channelTitle: channelLabelBase }]
            : selected.length
                ? selected.map(id => ({ id, title: (this._joinedChats || []).find(item => String(item.id) === id)?.title || id }))
                : [{ id: channel, title: channelLabel }];
        this.setActivity('Telegram scrape started', `${channelLabel} · limit ${limit}${query ? ` · ${query}` : ''}`, 'working');
        if (selected.length > 1) return this.scrapeMultipleTelegramChats(chats, query, limit);
        this._telegramMultiLimit = 0;
        this._telegramHistoryContext = { query, chats, limit };

        // Cancel any existing running scrape
        if (this._activeScrapeController) {
            try { this._activeScrapeController.abort(); } catch (_) {}
            this._activeScrapeController = null;
        }
        if (this._scrapeTimerInterval) {
            if (typeof clearInterval === 'function') clearInterval(this._scrapeTimerInterval);
            this._scrapeTimerInterval = null;
        }

        if (button) button.disabled = true;
        this.showLoading(true);

        const stopBtn = document.getElementById('quantumStopScrapeBtn');
        if (stopBtn) stopBtn.style.display = 'inline-flex';

        this.results = [];
        this.filteredResults = [];
        this.activeSource = 'all';

        this._scrapeMatched = 0;
        this._scrapeTarget = limit;
        const startTime = Date.now();

        const timerEl = document.getElementById('quantumStatusTimer');
        const etaEl = document.getElementById('quantumStatusEta');
        if (timerEl) timerEl.textContent = '⏱️ 00:00';
        if (etaEl) etaEl.textContent = 'odhad ~...';

        this.updateScrapeStatus(
            'Pripájanie...',
            `0 / ${limit} videí`,
            0,
            `Iniciujem vyhľadávanie v ${topicTitle ? 'threade' : 'kanáli'} <strong>${this.escapeHtml(channelLabel)}</strong>${query ? ` pre <em>"${this.escapeHtml(query)}"</em>` : ''}...`
        );

        if (typeof setInterval === 'function') {
            this._scrapeTimerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
            const s = String(elapsed % 60).padStart(2, '0');
            if (timerEl) timerEl.textContent = `⏱️ ${m}:${s}`;
            if (this._scrapeMatched > 0 && elapsed >= 2 && etaEl) {
                const speed = this._scrapeMatched / elapsed;
                const remaining = Math.max(0, this._scrapeTarget - this._scrapeMatched);
                const eta = Math.round(remaining / speed);
                etaEl.textContent = eta > 0 ? `zostáva ~${eta}s` : 'dokončuje sa';
            }
            }, 500);
        }

        const minDuration = this.activeFilters.duration || 0;
        const minQuality = this.requestedQuality();
        const controller = new AbortController();
        this._activeScrapeController = controller;

        try {
            const streamUrl = this.telegramScrapeQuery(channel, limit, query, minDuration, minQuality, this.requestedMinSizeMb(), topicId);
            const response = await fetch(streamUrl, { signal: controller.signal });

            if (!response.ok || !response.body || typeof response.body.getReader !== 'function') {
                if (response.ok && typeof response.json === 'function') {
                    const data = await response.json().catch(() => ({}));
                    if (Array.isArray(data.videos)) {
                        this.results = data.videos.map(v => this._mapRawTelegramVideo(v, channel));
                        this.applyFilters();
                        this.finishScrape(false);
                        return;
                    }
                }
                // Fallback to non-streaming POST if stream unavailable
                const bodyPayload = { channel, limit, query: query || null, min_duration: minDuration, min_quality: minQuality, min_size_mb: this.requestedMinSizeMb(), topic_id: topicId || 0 };
                const postRes = await fetch('/api/v1/telegram/scrape', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(bodyPayload),
                    signal: controller.signal
                });
                const postData = await postRes.json().catch(() => ({}));
                if (!postRes.ok) {
                    throw new Error(postData.detail || `Scrape zlyhal (${postRes.status})`);
                }
                const videos = Array.isArray(postData.videos) ? postData.videos : [];
                this.results = videos.map(v => this._mapRawTelegramVideo(v, channel));
                this.applyFilters();
                this.finishScrape(false);
                return;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let seenIds = new Set();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:')) continue;
                    const jsonStr = trimmed.slice(5).trim();
                    if (!jsonStr) continue;

                    let data;
                    try { data = JSON.parse(jsonStr); } catch (_) { continue; }

                    if (data.status === 'init' || data.status === 'connecting') {
                        this.updateScrapeStatus('Pripájanie...', `0 / ${limit} videí`, 5, data.message || 'Pripájam sa ku kanálu...');
                    } else if (data.status === 'info') {
                        this.updateScrapeStatus('Informácia', `${this.results.length} / ${limit} videí`, null, data.message);
                    } else if (data.status === 'searching' || data.status === 'progress') {
                        const matched = Number(data.matched) || this.results.length;
                        this._scrapeMatched = matched;
                        const pct = Math.min(95, Math.round((matched / limit) * 100));

                        if (Array.isArray(data.new_videos) && data.new_videos.length > 0) {
                            for (const raw of data.new_videos) {
                                const card = this._mapRawTelegramVideo(raw, channel);
                                const uid = card.message_id || card.id;
                                if (!seenIds.has(uid)) {
                                    seenIds.add(uid);
                                    this.results.push(card);
                                }
                            }
                            this.applyFilters();
                        }

                        this.updateScrapeStatus(
                            'Prehľadávam...',
                            `${this.results.length} / ${limit} videí`,
                            pct,
                            data.message || `Prehľadaných ${data.scanned || 0} správ, nájdených ${this.results.length} videí...`
                        );
                        const scrapeElapsed = Math.floor((Date.now() - startTime) / 1000);
                        this.updateActivityProgress(`SCRAPING ${this.results.length}/${limit} · ${scrapeElapsed}s`, this.results.length, limit);
                    } else if (data.status === 'topics') {
                        this._refreshTopicMeta(data.topics);
                    } else if (data.status === 'done') {
                        if (Array.isArray(data.videos) && data.videos.length > 0) {
                            for (const raw of data.videos) {
                                const card = this._mapRawTelegramVideo(raw, channel);
                                const uid = card.message_id || card.id;
                                if (!seenIds.has(uid)) {
                                    seenIds.add(uid);
                                    this.results.push(card);
                                }
                            }
                        }
                        this.applyFilters();
                        this.finishScrape(false);
                        return;
                    } else if (data.status === 'error') {
                        this.finishScrape(false, data.error || 'Nastala chyba pri čítaní kanála.', !!data.needs_auth);
                        return;
                    } else if (data.status === 'stopped') {
                        this.finishScrape(true);
                        return;
                    }
                }
            }

            this.applyFilters();
            this.finishScrape(false);
        } catch (error) {
            if (error.name === 'AbortError') {
                this.finishScrape(true);
            } else {
                this.finishScrape(false, error.message || 'Scrape zlyhal.');
            }
        }
    }

    _mergeTelegramCard(seenMap, raw, channelTitle) {
        const card = this._mapRawTelegramVideo(raw, channelTitle);
        const fid = String(card.file_id || '').trim();
        const key = fid ? `fid:${fid}` : `msg:${card.chat_id || ''}:${card.message_id || card.url || Math.random()}`;
        const existing = seenMap.get(key);
        if (!existing) {
            seenMap.set(key, card);
            this.results.push(card);
            return;
        }
        existing.source_channels = Array.isArray(existing.source_channels) ? existing.source_channels : [];
        for (const ch of card.source_channels || []) {
            if (ch && !existing.source_channels.includes(ch)) existing.source_channels.push(ch);
        }
        if ((card.views || 0) > (existing.views || 0)) existing.views = card.views;
        if ((card.forwards || 0) > (existing.forwards || 0)) existing.forwards = card.forwards;
        if ((card.reactions || 0) > (existing.reactions || 0)) existing.reactions = card.reactions;
    }

    async scrapeMultipleTelegramChats(chats, query, limit) {
        const perChatLimit = Math.min(limit, Math.max(1, Math.floor(2000 / chats.length)));
        this._telegramMultiLimit = Math.min(2000, chats.length * perChatLimit);
        if (this._activeScrapeController) this._activeScrapeController.abort();
        const controller = new AbortController();
        this._activeScrapeController = controller;
        this._telegramHistoryContext = { query, chats, limit };
        this.results = [];
        this.filteredResults = [];
        this.activeSource = 'all';
        const button = document.getElementById('scrapeChannelBtn');
        if (button) button.disabled = true;
        this.showLoading(true);
        const stop = document.getElementById('quantumStopScrapeBtn');
        if (stop) stop.style.display = 'inline-flex';
        const failures = [];
        const seenCards = new Map();
        try {
            for (let i = 0; i < chats.length; i++) {
                const chat = chats[i];
                this.updateScrapeStatus('Prehľadávam...', `${this.results.length} videí`, Math.round(i / chats.length * 90),
                    `${i + 1}/${chats.length}: ${this.escapeHtml(chat.title)}`);
                try {
                    const response = await fetch('/api/v1/telegram/scrape', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        signal: controller.signal,
                        body: JSON.stringify({ channel: chat.id, limit: perChatLimit, query: query || null,
                            min_duration: this.activeFilters.duration || 0, min_quality: this.requestedQuality(),
                            min_size_mb: this.requestedMinSizeMb(), topic_id: chat.topicId || 0,
                            with_topics: true })
                    });
                    const data = await response.json();
                    if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
                    for (const video of data.videos || []) this._mergeTelegramCard(seenCards, video, chat.title);
                    this.applyFilters();
                } catch (error) {
                    if (error.name === 'AbortError') throw error;
                    failures.push(`${chat.title}: ${error.message}`);
                }
            }
            this.applyFilters();
            if (failures.length) {
                this.finishScrape(false, failures.join('; '));
            } else {
                this.finishScrape(false);
            }
        } catch (error) {
            this.finishScrape(error.name === 'AbortError', error.name === 'AbortError' ? null : error.message);
        }
    }

    applyHistory(query) {
        const input = document.getElementById('quantumSearchInput');
        input.value = query;
        this.search(query);
    }

    formatRelativeTime(dateStr) {
        const date = new Date(dateStr);
        const now = new Date();
        const diff = Math.floor((now - date) / 1000);

        if (diff < 60) return 'just now';
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        return date.toLocaleDateString();
    }

    clearResults() {
        const container = document.getElementById('quantumSearchResults');
        const stats = document.getElementById('quantumSearchStats');
        const sourceContainer = document.getElementById('quantumSearchSources');

        container.innerHTML = `
            <div class="quantum-search-empty">
                <div class="quantum-search-empty-icon">🎯</div>
                <div class="quantum-search-empty-text">
                    Enter a search query to discover content<br>
                    <small style="opacity: 0.6;">Try searching for creators, models, or content</small>
                </div>
            </div>
        `;
        stats.style.display = 'none';

        // Reset sources
        this.results = [];
        this.filteredResults = [];
        sourceContainer.innerHTML = '<span class="source-badge active" data-source="all">All Sources</span>';
    }
}

// Initialize on page load
let quantumSearch;
function _initQuantumSearch() {
    if (typeof window !== 'undefined' && window.quantumSearch) return;
    quantumSearch = new QuantumSearch();
    if (typeof window !== 'undefined') window.quantumSearch = quantumSearch;
    console.log('🔮 Quantum Search initialized! Press Ctrl+K to open.');
}
if (typeof document !== 'undefined') {
    if (!document.readyState || document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _initQuantumSearch);
    } else {
        _initQuantumSearch();
    }
}
