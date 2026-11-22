(function() {
        'use strict';

        /* ── THEME UTILITIES & LOAD ── */
        function hexToRgb(hex) {
            var c;
            if(/^#([A-Fa-f0-9]{3}){1,2}$/.test(hex)){
                c= hex.substring(1).split('');
                if(c.length=== 3){
                    c= [c[0], c[0], c[1], c[1], c[2], c[2]];
                }
                c= '0x' + c.join('');
                return [(c>>16)&255, (c>>8)&255, c&255].join(',');
            }
            return null;
        }

        function adjustColorBrightness(hex, percent) {
            var num = parseInt(hex.replace("#",""), 16),
            amt = Math.round(2.55 * percent),
            R = (num >> 16) + amt,
            G = (num >> 8 & 0x00FF) + amt,
            B = (num & 0x0000FF) + amt;
            return "#" + (0x1000000 + (R<255?R<0?0:R:255)*0x10000 + (G<255?G<0?0:G:255)*0x100 + (B<255?B<0?0:B:255)).toString(16).slice(1);
        }

        function applyThemeVariables(theme) {
            if (!theme) return;
            var docEl = document.documentElement;
            if (theme.bg) {
                docEl.style.setProperty('--bg', theme.bg);
                var bgStart = adjustColorBrightness(theme.bg, -25);
                var bgMid = adjustColorBrightness(theme.bg, 15);
                docEl.style.setProperty('--bg-grad-start', bgStart);
                docEl.style.setProperty('--bg-grad-mid', bgMid);
            }
            if (theme.surface) {
                var rgb = hexToRgb(theme.surface);
                if (rgb) {
                    docEl.style.setProperty('--surface', 'rgba(' + rgb + ', 0.72)');
                    docEl.style.setProperty('--surface-strong', 'rgba(' + rgb + ', 0.94)');
                }
            }
            if (theme.primary) {
                docEl.style.setProperty('--primary', theme.primary);
                var rgb = hexToRgb(theme.primary);
                if (rgb) {
                    docEl.style.setProperty('--primary-glow', 'rgba(' + rgb + ', 0.12)');
                    docEl.style.setProperty('--shadow-glow', 'rgba(' + rgb + ', 0.12)');
                }
            }
            if (theme.secondary) {
                docEl.style.setProperty('--secondary', theme.secondary);
                var rgb = hexToRgb(theme.secondary);
                if (rgb) {
                    docEl.style.setProperty('--secondary-glow', 'rgba(' + rgb + ', 0.11)');
                }
            }
            if (theme.accent) {
                docEl.style.setProperty('--accent', theme.accent);
                var rgb = hexToRgb(theme.accent);
                if (rgb) {
                    docEl.style.setProperty('--accent-glow', 'rgba(' + rgb + ', 0.06)');
                }
            }
            if (theme.textScale) {
                docEl.style.setProperty('--text-scale', theme.textScale);
            }
        }

        var themePresets = {
            cyber: { bg: '#05070f', surface: '#0c1021', primary: '#00f3ff', secondary: '#9e60ff', accent: '#ff007f', textScale: '1.0' },
            sapphire: { bg: '#020b24', surface: '#08122c', primary: '#1e90ff', secondary: '#4169e1', accent: '#00ffff', textScale: '1.0' },
            neon: { bg: '#0a020d', surface: '#14081c', primary: '#ff007f', secondary: '#ff00ff', accent: '#ffff00', textScale: '1.0' },
            emerald: { bg: '#020f08', surface: '#061a10', primary: '#10b981', secondary: '#059669', accent: '#34d399', textScale: '1.0' },
            luxury: { bg: '#0c0c08', surface: '#1a1810', primary: '#ffd700', secondary: '#b8860b', accent: '#ffffff', textScale: '1.0' }
        };

        // Load custom theme and grid size immediately to prevent style flashes
        (function() {
            try {
                var customTheme = localStorage.getItem('nexus_custom_theme');
                if (customTheme) {
                    applyThemeVariables(JSON.parse(customTheme));
                }
            } catch(e) {}
            try {
                var storedGridSize = localStorage.getItem('nexus_grid_size');
                if (storedGridSize && storedGridSize !== 'auto') {
                    document.body.classList.add('grid-size-' + storedGridSize);
                }
            } catch(e) {}
        })();

        /* ── MISSION STRIP COLLAPSE ── */
        var missionStrip = document.querySelector('.mission-strip');
        var missionMini  = document.getElementById('mission-mini-bar');
        var collapseBtn  = document.getElementById('mission-collapse-btn');
        var expandBtn    = document.getElementById('mission-expand-btn');
        var miniText     = document.getElementById('mini-bar-text');
        var miniPct      = document.getElementById('mini-bar-pct');
        var miniProgress = document.getElementById('mini-bar-progress');
        var miniDot      = document.getElementById('mini-bar-dot');

        function setMissionCollapsed(collapsed) {
            if (!missionStrip || !missionMini) return;
            if (collapsed) {
                missionStrip.classList.add('mission-collapsed');
                missionMini.classList.add('visible');
            } else {
                missionStrip.classList.remove('mission-collapsed');
                missionMini.classList.remove('visible');
            }
            try { localStorage.setItem('nexus_mission_collapsed', collapsed ? '1' : '0'); } catch(e) {}
        }

        function syncMiniBar() {
            var headline = document.getElementById('mission-headline');
            var progVal  = document.getElementById('mission-progress-value');
            var progBar  = document.getElementById('progress-bar');
            if (headline && miniText)     miniText.textContent     = headline.textContent || 'Mission Control';
            if (progVal  && miniPct)      miniPct.textContent      = progVal.textContent  || '0%';
            if (progBar  && miniProgress) miniProgress.style.width = progBar.style.width  || '0%';
            var pct = parseInt((progVal ? progVal.textContent : '0') || '0');
            if (miniDot) {
                miniDot.className = 'mini-bar-dot';
                if (pct > 0 && pct < 100) miniDot.classList.add('active');
                else if (pct >= 100)      miniDot.classList.add('done');
            }
        }

        if (collapseBtn) collapseBtn.addEventListener('click', function() {
            setMissionCollapsed(!missionStrip.classList.contains('mission-collapsed'));
            syncMiniBar();
        });
        if (expandBtn) expandBtn.addEventListener('click', function() { setMissionCollapsed(false); });
        try {
            var _saved = localStorage.getItem('nexus_mission_collapsed');
            // Default collapsed (mini-bar shown) unless user explicitly opened it
            if (_saved === null || _saved === '1') { setMissionCollapsed(true); syncMiniBar(); }
        } catch(e) { setMissionCollapsed(true); syncMiniBar(); }

        var progressBarEl = document.getElementById('progress-bar');
        if (progressBarEl && window.MutationObserver) {
            new MutationObserver(syncMiniBar).observe(progressBarEl, { attributes: true, attributeFilter: ['style'] });
        }
        var missionHeadlineEl = document.getElementById('mission-headline');
        if (missionHeadlineEl && window.MutationObserver) {
            new MutationObserver(syncMiniBar).observe(missionHeadlineEl, { childList: true, characterData: true, subtree: true });
        }

        /* ── FOOTER OVERFLOW MENU ── */
        var footerMoreBtn  = document.getElementById('footer-more-btn');
        var footerDropdown = document.getElementById('footer-overflow-dropdown');
        if (footerMoreBtn && footerDropdown) {
            footerMoreBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                footerDropdown.style.display = footerDropdown.style.display === 'none' ? 'flex' : 'none';
            });
        }

        /* ── BATCH OVERFLOW MENU ── */
        var batchHistoryTrigger = document.getElementById('batch-history-trigger');
        var batchHistoryDropdown = document.getElementById('batch-history-dropdown');
        if (batchHistoryTrigger && batchHistoryDropdown) {
            batchHistoryTrigger.addEventListener('click', function(e) {
                e.stopPropagation();
                batchHistoryDropdown.style.display = batchHistoryDropdown.style.display === 'none' ? 'flex' : 'none';
            });
        }

        var batchMoreBtn  = document.getElementById('batch-more-btn');
        var batchDropdown = document.getElementById('batch-overflow-dropdown');
        if (batchMoreBtn && batchDropdown) {
            batchMoreBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                batchDropdown.style.display = batchDropdown.style.display === 'none' ? 'flex' : 'none';
            });
        }

        document.addEventListener('click', function() {
            if (footerDropdown) footerDropdown.style.display = 'none';
            if (batchHistoryDropdown) batchHistoryDropdown.style.display = 'none';
            if (batchDropdown)  batchDropdown.style.display  = 'none';
        });

        /* ── THUMBNAIL 16:9 TOGGLE ── */
        var thumbRatioBtn = document.getElementById('thumb-ratio-btn');
        function setThumbRatio(enabled) {
            if (enabled) {
                document.body.classList.add('thumb-ratio');
                if (thumbRatioBtn) thumbRatioBtn.classList.add('active');
            } else {
                document.body.classList.remove('thumb-ratio');
                if (thumbRatioBtn) thumbRatioBtn.classList.remove('active');
            }
            try { localStorage.setItem('nexus_thumb_ratio', enabled ? '1' : '0'); } catch(e) {}
        }
        if (thumbRatioBtn) thumbRatioBtn.addEventListener('click', function() {
            setThumbRatio(!document.body.classList.contains('thumb-ratio'));
        });
        try { if (localStorage.getItem('nexus_thumb_ratio') === '1') setThumbRatio(true); } catch(e) {}

        /* ── EMPTY STATE — clear text filter ── */
        var emptyClearBtn = document.getElementById('empty-clear-filters-btn');
        if (emptyClearBtn) {
            emptyClearBtn.addEventListener('click', function() {
                var si = document.getElementById('search-input');
                if (si) { si.value = ''; si.dispatchEvent(new Event('input', { bubbles: true })); si.focus(); }
            });
        }

        /* ── GLOBÁLNE HELPER FUNKCIE ── */
        window.nexusSetTabStatus = function(status) {
            var chip = document.getElementById('tab-status-chip');
            if (chip) chip.dataset.status = status || '';
        };
        window.nexusSetMiniBar = function(text, pct) {
            if (miniText)     miniText.textContent      = text || '';
            if (miniPct)      miniPct.textContent       = (pct != null ? pct + '%' : '');
            if (miniProgress) miniProgress.style.width  = (pct != null ? Math.min(100, pct) + '%' : '0%');
            if (miniDot) {
                miniDot.className = 'mini-bar-dot';
                if (pct > 0 && pct < 100) miniDot.classList.add('active');
                else if (pct >= 100)      miniDot.classList.add('done');
            }
        };

        /* ── ACCORDION / COLLAPSE DECK CARDS ── */
        document.querySelectorAll('.deck-card').forEach(function(card) {
            var kicker = card.querySelector('.section-kicker');
            if (!kicker) return;
            var cardId = 'nexus_deck_' + kicker.textContent.trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
            try {
                if (localStorage.getItem(cardId) === '1') {
                    card.classList.add('collapsed');
                }
            } catch(e) {}
            kicker.addEventListener('click', function() {
                var isCollapsed = card.classList.toggle('collapsed');
                try {
                    localStorage.setItem(cardId, isCollapsed ? '1' : '0');
                } catch(e) {}
            });
        });

        /* ── THEME PICKER PANEL INTERACTIVITY ── */
        var themeToggleBtn    = document.getElementById('theme-toggle-btn');
        var themePickerPanel  = document.getElementById('theme-picker-panel');
        var themePanelClose   = document.getElementById('theme-panel-close');
        var themePresetSelect = document.getElementById('theme-preset-select');
        var themeResetBtn     = document.getElementById('theme-reset-btn');
        var themeSaveBtn      = document.getElementById('theme-save-btn');
        
        var themeInputs = {
            bg: { color: document.getElementById('theme-color-bg'), hex: document.getElementById('theme-hex-bg') },
            surface: { color: document.getElementById('theme-color-surface'), hex: document.getElementById('theme-hex-surface') },
            primary: { color: document.getElementById('theme-color-primary'), hex: document.getElementById('theme-hex-primary') },
            secondary: { color: document.getElementById('theme-color-secondary'), hex: document.getElementById('theme-hex-secondary') },
            accent: { color: document.getElementById('theme-color-accent'), hex: document.getElementById('theme-hex-accent') }
        };

        function syncInputsToCurrentTheme() {
            try {
                var currentTheme = themePresets.cyber;
                var stored = localStorage.getItem('nexus_custom_theme');
                if (stored) {
                    currentTheme = JSON.parse(stored);
                    var matched = 'custom';
                    for (var key in themePresets) {
                        if (themePresets[key].bg === currentTheme.bg &&
                            themePresets[key].surface === currentTheme.surface &&
                            themePresets[key].primary === currentTheme.primary &&
                            themePresets[key].secondary === currentTheme.secondary &&
                            themePresets[key].accent === currentTheme.accent &&
                            themePresets[key].textScale === currentTheme.textScale) {
                            matched = key;
                            break;
                        }
                    }
                    if (themePresetSelect) themePresetSelect.value = matched;
                } else {
                    if (themePresetSelect) themePresetSelect.value = 'cyber';
                }

                for (var key in themeInputs) {
                    if (currentTheme[key]) {
                        if (themeInputs[key].color) {
                            themeInputs[key].color.value = currentTheme[key];
                        }
                        if (themeInputs[key].hex) {
                            themeInputs[key].hex.value = currentTheme[key].toUpperCase();
                        }
                    }
                }
                var fontScaleVal = currentTheme.textScale || '1.0';
                var fontScaleInp = document.getElementById('theme-font-scale');
                var fontScalePct = document.getElementById('theme-font-scale-pct');
                if (fontScaleInp) {
                    fontScaleInp.value = fontScaleVal;
                }
                if (fontScalePct) {
                    fontScalePct.textContent = Math.round(parseFloat(fontScaleVal) * 100) + '%';
                }
            } catch(e) {
                console.error("Error in syncInputsToCurrentTheme:", e);
            }
        }

        if (themeToggleBtn && themePickerPanel) {
            console.log("Theme elements found, registering click listener on themeToggleBtn!");
            themeToggleBtn.addEventListener('click', function(e) {
                console.log("themeToggleBtn clicked!");
                e.stopPropagation();
                var visible = themePickerPanel.style.display !== 'none';
                if (!visible) {
                    syncInputsToCurrentTheme();
                    themePickerPanel.style.display = 'flex';
                    console.log("themePickerPanel set to flex");
                } else {
                    themePickerPanel.style.display = 'none';
                    console.log("themePickerPanel set to none");
                }
            });
            themePickerPanel.addEventListener('click', function(e) {
                e.stopPropagation();
            });
        } else {
            console.error("Theme toggle elements not found!", { btn: themeToggleBtn, panel: themePickerPanel });
        }

        if (themePanelClose && themePickerPanel) {
            themePanelClose.addEventListener('click', function() {
                themePickerPanel.style.display = 'none';
            });
        }

        document.addEventListener('click', function() {
            if (themePickerPanel) themePickerPanel.style.display = 'none';
        });

        Object.keys(themeInputs).forEach(function(key) {
            var colorInp = themeInputs[key].color;
            var hexInp = themeInputs[key].hex;

            if (colorInp) {
                colorInp.addEventListener('input', function() {
                    hexInp.value = colorInp.value.toUpperCase();
                    if (themePresetSelect) themePresetSelect.value = 'custom';
                    applyCurrentPickerColors();
                });
            }

            if (hexInp) {
                hexInp.addEventListener('input', function() {
                    var val = hexInp.value.trim();
                    if (val[0] !== '#') val = '#' + val;
                    if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
                        colorInp.value = val;
                        if (themePresetSelect) themePresetSelect.value = 'custom';
                        applyCurrentPickerColors();
                    }
                });
            }
        });

        function applyCurrentPickerColors() {
            var fontScaleInp = document.getElementById('theme-font-scale');
            var theme = {
                bg: themeInputs.bg.color.value,
                surface: themeInputs.surface.color.value,
                primary: themeInputs.primary.color.value,
                secondary: themeInputs.secondary.color.value,
                accent: themeInputs.accent.color.value,
                textScale: fontScaleInp ? fontScaleInp.value : '1.0'
            };
            applyThemeVariables(theme);
        }

        if (themePresetSelect) {
            themePresetSelect.addEventListener('change', function() {
                var val = themePresetSelect.value;
                if (val !== 'custom' && themePresets[val]) {
                    var preset = themePresets[val];
                    for (var key in themeInputs) {
                        if (preset[key] && themeInputs[key].color) {
                            themeInputs[key].color.value = preset[key];
                            themeInputs[key].hex.value = preset[key].toUpperCase();
                        }
                    }
                    var fontScaleInp = document.getElementById('theme-font-scale');
                    var fontScalePct = document.getElementById('theme-font-scale-pct');
                    if (preset.textScale) {
                        if (fontScaleInp) fontScaleInp.value = preset.textScale;
                        if (fontScalePct) fontScalePct.textContent = Math.round(parseFloat(preset.textScale) * 100) + '%';
                    }
                    applyThemeVariables(preset);
                }
            });
        }

        var fontScaleInp = document.getElementById('theme-font-scale');
        var fontScalePct = document.getElementById('theme-font-scale-pct');
        if (fontScaleInp) {
            fontScaleInp.addEventListener('input', function() {
                var val = fontScaleInp.value;
                if (fontScalePct) {
                    fontScalePct.textContent = Math.round(parseFloat(val) * 100) + '%';
                }
                if (themePresetSelect) themePresetSelect.value = 'custom';
                applyCurrentPickerColors();
            });
        }

        if (themeResetBtn) {
            themeResetBtn.addEventListener('click', function() {
                var cyber = themePresets.cyber;
                for (var key in themeInputs) {
                    if (cyber[key] && themeInputs[key].color) {
                        themeInputs[key].color.value = cyber[key];
                        themeInputs[key].hex.value = cyber[key].toUpperCase();
                    }
                }
                var fontScaleInp = document.getElementById('theme-font-scale');
                var fontScalePct = document.getElementById('theme-font-scale-pct');
                if (fontScaleInp) fontScaleInp.value = cyber.textScale || '1.0';
                if (fontScalePct) fontScalePct.textContent = '100%';
                if (themePresetSelect) themePresetSelect.value = 'cyber';
                applyThemeVariables(cyber);
                try {
                    localStorage.removeItem('nexus_custom_theme');
                } catch(e) {}
                showThemeToast('Farby resetované na predvolené!');
            });
        }

        if (themeSaveBtn) {
            themeSaveBtn.addEventListener('click', function() {
                var fontScaleInp = document.getElementById('theme-font-scale');
                var theme = {
                    bg: themeInputs.bg.color.value,
                    surface: themeInputs.surface.color.value,
                    primary: themeInputs.primary.color.value,
                    secondary: themeInputs.secondary.color.value,
                    accent: themeInputs.accent.color.value,
                    textScale: fontScaleInp ? fontScaleInp.value : '1.0'
                };
                try {
                    localStorage.setItem('nexus_custom_theme', JSON.stringify(theme));
                } catch(e) {}
                if (themePickerPanel) themePickerPanel.style.display = 'none';
                showThemeToast('Téma úspešne uložená!');
            });
        }
        /* ── GRID SIZE SELECTOR ── */
        var gridSizeSelect = document.getElementById('grid-size-select');
        if (gridSizeSelect) {
            // Sync initial state of select dropdown
            try {
                var storedGridSize = localStorage.getItem('nexus_grid_size');
                if (storedGridSize) {
                    gridSizeSelect.value = storedGridSize;
                }
            } catch(e) {}
            
            // Apply initial class
            if (gridSizeSelect.value !== 'auto') {
                document.body.classList.add('grid-size-' + gridSizeSelect.value);
            }

            gridSizeSelect.addEventListener('change', function() {
                var val = gridSizeSelect.value;
                document.body.className = document.body.className.replace(/\bgrid-size-\S+/g, '');
                if (val !== 'auto') {
                    document.body.classList.add('grid-size-' + val);
                }
                try {
                    localStorage.setItem('nexus_grid_size', val);
                } catch(e) {}

                // Notify main popup logic to re-render according to selected grid slots.
                try {
                    document.dispatchEvent(new CustomEvent('nexus:grid-size-changed', { detail: { value: val } }));
                } catch(e) {}
            });
        }

        function showThemeToast(msg) {
            var toast = document.getElementById('import-toast');
            if (toast) {
                toast.textContent = msg;
                toast.style.display = 'block';
                setTimeout(function() {
                    toast.style.display = 'none';
                }, 2500);
            }
        }

    })();
