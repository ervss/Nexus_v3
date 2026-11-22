export function createCommandModule() {
    return {
        showCommandPalette: false,
        commandQuery: '',
        commandResults: [],
        commandSelectedIndex: 0,
        isCommandSearching: false,
        _commandSearchSeq: 0,
        commands: [
            // Akcie v knižnici a vzhľade
            {
                id: 'cmd_import',
                type: 'command',
                title: 'Rýchly import URL',
                desc: 'Otvoriť okno pre import videí a playlistov',
                icon: 'add_link',
                shortcut: 'Import',
                action: function () { this.showImportModal = true; }
            },
            {
                id: 'cmd_theme',
                type: 'command',
                title: 'Prepnúť Svetlý / Tmavý režim',
                desc: 'Prepína Obsidian Dark a Frosted Light vzhľad',
                icon: 'contrast',
                shortcut: 'Motív',
                action: function () {
                    this.settings.theme = this.settings.theme === 'dark' ? 'light' : 'dark';
                    this.saveSettings?.();
                }
            },
            {
                id: 'cmd_perf_mode',
                type: 'command',
                title: 'Prepnúť výkonový režim skla',
                desc: 'Prepína Vyvážené sklo → Plné sklo → Bez bluru',
                icon: 'bolt',
                shortcut: 'Výkon',
                action: function () {
                    if (typeof this.cyclePerformanceMode === 'function') this.cyclePerformanceMode();
                }
            },
            {
                id: 'cmd_batch',
                type: 'command',
                title: 'Prepnúť dávkový výber (Batch)',
                desc: 'Hromadné označovanie a akcie nad kartami',
                icon: 'checklist',
                shortcut: 'Batch',
                action: function () { this.toggleBatchMode?.(); }
            },
            {
                id: 'cmd_fav',
                type: 'command',
                title: 'Zobraziť obľúbené videá',
                desc: 'Vyfiltrovať len obľúbené položky v galérii',
                icon: 'favorite',
                shortcut: 'Filter',
                action: function () {
                    this.externalBrowseMode = 'gallery';
                    this.filters.favoritesOnly = true;
                    this.oldGalleryMode = false;
                    this.activeSourceBoardId = null;
                    this.loadVideos?.(true);
                }
            },
            {
                id: 'cmd_home',
                type: 'command',
                title: 'Zobraziť celú galériu',
                desc: 'Vynulovať kontext a zobraziť všetky videá',
                icon: 'grid_view',
                shortcut: 'Galéria',
                action: function () {
                    if (typeof this.showMainGallery === 'function') this.showMainGallery();
                    else {
                        this.filters.favoritesOnly = false;
                        this.loadVideos?.(true);
                    }
                }
            },
            {
                id: 'cmd_view_grid',
                type: 'command',
                title: 'Prepínač pohľadu: Mriežka (Grid)',
                desc: 'Prepnúť galériu na mriežkový pohľad',
                icon: 'grid_view',
                shortcut: 'Grid',
                action: function () { this.setViewMode?.('grid'); }
            },
            {
                id: 'cmd_view_flow',
                type: 'command',
                title: 'Prepínač pohľadu: Quantum Flow',
                desc: 'Prepnúť galériu na plynulý vertikálny pohľad',
                icon: 'view_stream',
                shortcut: 'Flow',
                action: function () { this.setViewMode?.('flow'); }
            },
            {
                id: 'cmd_splitscreen',
                type: 'command',
                title: 'Prepnúť Split-Screen',
                desc: 'Rozdeliť prehrávač na dve videá vedľa seba',
                icon: 'view_column',
                shortcut: 'S',
                action: function () {
                    if (this.showPlayer) this.toggleSplitScreen?.();
                    else this.showToast?.('Najprv otvor nejaké video v prehrávači.', 'info', 'info');
                }
            },
            {
                id: 'cmd_super_search',
                type: 'command',
                title: 'Otvoriť Quantum Search / MEGA Links',
                desc: 'Rozšírené vyhľadávanie naprieč zdrojmi a Telegramom',
                icon: 'blur_on',
                shortcut: 'Hľadať',
                action: function () {
                    if (window.quantumSearch && typeof window.quantumSearch.open === 'function') {
                        window.quantumSearch.open();
                    } else {
                        this.showMegaSearch = true;
                    }
                }
            },
            {
                id: 'cmd_mega_hub',
                type: 'command',
                title: 'Otvoriť MEGA Hub',
                desc: 'Prehľad a správa uložených MEGA priečinkov',
                icon: 'folder_open',
                shortcut: 'Ctrl+M',
                action: function () {
                    if (window.NexusMegaHub?.open) window.NexusMegaHub.open();
                    else document.querySelector('[data-open-mega-hub]')?.click();
                }
            },
            {
                id: 'cmd_fusion_hub',
                type: 'command',
                title: 'Otvoriť Fusion Hub',
                desc: 'Rýchle prehľadávanie a import vo Fusion Hube',
                icon: 'bolt',
                shortcut: 'Fusion',
                action: function () { this.ephOpen?.(); }
            },
            {
                id: 'cmd_camwhores',
                type: 'command',
                title: 'Otvoriť Camwhores',
                desc: 'Prehliadať a importovať z Camwhores',
                icon: 'videocam',
                shortcut: 'Zdroj',
                action: function () { this.showCamwhoresDiscoveryModal = true; }
            },
            {
                id: 'cmd_creator_radar',
                type: 'command',
                title: 'Otvoriť Creator Radar',
                desc: 'Sledovanie tvorcov a nových videí',
                icon: 'stars',
                shortcut: 'Ctrl+Shift+R',
                action: function () { window.NexusCreatorRadar?.open?.(); }
            },
            {
                id: 'cmd_settings',
                type: 'command',
                title: 'Otvoriť Nastavenia',
                desc: 'Palety, výkonový režim, prehrávanie a správa knižnice',
                icon: 'settings',
                shortcut: 'Nastavenia',
                action: function () { this.showSettings = true; }
            },
            // Navigácia na aktívne podstránky
            {
                id: 'nav_vault',
                type: 'command',
                title: 'Prejsť na: Local Vault',
                desc: 'Rýchle lokálne FTS5 vyhľadávanie v trezore',
                icon: 'inventory_2',
                shortcut: 'Ctrl+Shift+V',
                action: function () {
                    if (typeof this.openVault === 'function') this.openVault();
                    else window.location.href = '/vault';
                }
            },
            {
                id: 'nav_forum',
                type: 'command',
                title: 'Prejsť na: Forum Hub',
                desc: 'Prehľad fór, vlákien a zozbieraných odkazov',
                icon: 'forum',
                shortcut: '/forum',
                action: function () { window.location.href = '/forum'; }
            },
            {
                id: 'nav_faphouse',
                type: 'command',
                title: 'Prejsť na: Faphouse',
                desc: 'Samostatný Faphouse hub a sledovanie tvorcov',
                icon: 'workspace_premium',
                shortcut: '/faphouse',
                action: function () { window.location.href = '/faphouse'; }
            },
            {
                id: 'nav_sxyprn',
                type: 'command',
                title: 'Prejsť na: SxyPrn',
                desc: 'Prehliadanie a import z SxyPrn',
                icon: 'smart_display',
                shortcut: '/sxyprn',
                action: function () { window.location.href = '/sxyprn'; }
            },
            {
                id: 'nav_tester',
                type: 'command',
                title: 'Prejsť na: Link Tester',
                desc: 'Testovanie odkazov a playlistov pred importom',
                icon: 'science',
                shortcut: '/tester',
                action: function () { window.location.href = '/tester'; }
            },
            {
                id: 'nav_sources_test',
                type: 'command',
                title: 'Prejsť na: Test webov',
                desc: 'Diagnostika podporovaných zdrojov a extraktorov',
                icon: 'fact_check',
                shortcut: '/sources-test',
                action: function () { window.location.href = '/sources-test'; }
            },
            {
                id: 'nav_stats',
                type: 'command',
                title: 'Prejsť na: Štatistiky',
                desc: 'Prehľad knižnice, zdrojov a kvality',
                icon: 'bar_chart',
                shortcut: '/stats',
                action: function () { window.location.href = '/stats'; }
            }
        ],

        playRandomVideo() {
            if (Array.isArray(this.videos) && this.videos.length > 0) {
                const randomIndex = Math.floor(Math.random() * this.videos.length);
                this.playVideo(this.videos[randomIndex]);
            } else {
                this.showToast?.('V aktuálnom pohľade nie sú žiadne videá na prehratie.', 'info', 'info');
            }
        },

        filterCommandItems(rawQuery) {
            const needle = String(rawQuery || '').trim().toLowerCase();
            if (!needle) return this.commands.map(c => ({ ...c, type: 'command' }));
            return this.commands
                .filter(c =>
                    String(c.title || '').toLowerCase().includes(needle)
                    || String(c.desc || '').toLowerCase().includes(needle)
                    || String(c.shortcut || '').toLowerCase().includes(needle)
                )
                .map(c => ({ ...c, type: 'command' }));
        },

        runCommandSearch(q) {
            const query = String(q || '');
            const seq = (this._commandSearchSeq = (this._commandSearchSeq || 0) + 1);
            this.commandSelectedIndex = 0;

            if (!query.trim()) {
                this.commandResults = this.filterCommandItems('');
                this.isCommandSearching = false;
                return;
            }
            this.isCommandSearching = true;

            if (query.startsWith('>')) {
                this.commandResults = this.filterCommandItems(query.substring(1));
                this.isCommandSearching = false;
                return;
            }

            const filteredCommands = this.filterCommandItems(query);
            if (typeof this.searchVideos !== 'function') {
                this.commandResults = filteredCommands;
                this.isCommandSearching = false;
                return;
            }

            this.searchVideos(query).then(videos => {
                if (seq !== this._commandSearchSeq) return;
                const videoResults = (Array.isArray(videos) ? videos : []).map(v => ({ ...v, type: 'video' }));
                this.commandResults = [...filteredCommands, ...videoResults];
                this.commandSelectedIndex = 0;
                this.isCommandSearching = false;
            }).catch(() => {
                if (seq !== this._commandSearchSeq) return;
                this.commandResults = filteredCommands;
                this.isCommandSearching = false;
            });
        },

        moveCommandSelection(delta) {
            const total = Array.isArray(this.commandResults) ? this.commandResults.length : 0;
            if (!total) {
                this.commandSelectedIndex = 0;
                return;
            }
            const next = (Number(this.commandSelectedIndex || 0) + delta + total) % total;
            this.commandSelectedIndex = next;
        },

        executeSelectedCommand() {
            const list = Array.isArray(this.commandResults) ? this.commandResults : [];
            if (!list.length) return;
            const idx = Math.max(0, Math.min(list.length - 1, Number(this.commandSelectedIndex || 0)));
            this.executeCommandResult(list[idx]);
        },

        executeCommandResult(result) {
            if (!result) return;
            this.showCommandPalette = false;
            this.commandQuery = '';
            this.commandSelectedIndex = 0;

            if (result.type === 'command') {
                if (typeof result.action === 'function') {
                    result.action.call(this);
                } else if (typeof result.action === 'string') {
                    const [fnName, param] = result.action.split(':');
                    if (typeof this[fnName] === 'function') this[fnName](param);
                }
            } else {
                this.playVideo?.(result);
            }
        }
    };
}
