/* ============================================
   QUANTUM UX ENHANCEMENTS - JAVASCRIPT MODULE
   10 Brutally Powerful UX Features
   ============================================ */

function createQuantumUXModule() {
    const sprites = new Map();
    const scrubbers = new WeakMap();
    const latestFrames = new WeakMap();

    return {
        // ========== 1. INSTANT PREVIEW SCRUBBER ==========
        spriteScrubber: {
            currentVideo: null,
            spriteImage: null,
            frameWidth: 160,
            frameHeight: 90,
            cols: 10,
            rows: 10,
        },

        initSpriteScrubber(video) {
            if (!video.sprite_path) return;

            const card = document.querySelector(`[data-video-id="${video.id}"]`);
            if (!card) return;

            const existing = scrubbers.get(card);
            if (existing) {
                existing.video = video;
                return;
            }
            const state = { video, frame: null, pointerX: 0 };
            scrubbers.set(card, state);
            card.addEventListener('pointermove', (event) => {
                state.pointerX = event.clientX;
                if (state.frame !== null) return;
                state.frame = requestAnimationFrame(() => {
                    state.frame = null;
                    const rect = card.getBoundingClientRect();
                    if (!rect.width) return;
                    const progress = Math.max(0, Math.min(1, (state.pointerX - rect.left) / rect.width));
                    this.updateSpriteFrame(state.video, progress, card);
                });
            });
            card.addEventListener('pointerleave', () => {
                if (state.frame !== null) cancelAnimationFrame(state.frame);
                state.frame = null;
                latestFrames.delete(card);
            });
        },

        updateSpriteFrame(video, progress, card) {
            const totalFrames = this.spriteScrubber.cols * this.spriteScrubber.rows;
            const frameIndex = Math.floor(progress * (totalFrames - 1));

            const row = Math.floor(frameIndex / this.spriteScrubber.cols);
            const col = frameIndex % this.spriteScrubber.cols;

            // Update scrubber bar
            const scrubberFill = card.querySelector('.sprite-scrubber-fill');
            if (scrubberFill) {
                scrubberFill.style.width = `${progress * 100}%`;
            }

            // Update tooltip
            const tooltip = card.querySelector('.sprite-preview-tooltip');
            if (tooltip && video.duration) {
                const time = progress * video.duration;
                tooltip.textContent = this.formatTime(time);
            }

            // Update frame preview
            const preview = card.querySelector('.sprite-frame-preview canvas');
            if (preview && video.sprite_path) {
                const path = video.sprite_path;
                let sprite = sprites.get(path);
                if (!sprite) {
                    sprite = new Image();
                    sprites.set(path, sprite);
                    if (sprites.size > 24) sprites.delete(sprites.keys().next().value);
                    sprite.addEventListener('error', () => {
                        if (sprites.get(path) === sprite) sprites.delete(path);
                    }, { once: true });
                    sprite.src = path;
                }
                const frame = { row, col, preview, path };
                latestFrames.set(card, frame);
                const draw = () => {
                    const current = latestFrames.get(card);
                    if (!card.isConnected || current?.path !== path || !current.preview.isConnected) return;
                    const ctx = current.preview.getContext('2d');
                    if (!ctx) return;
                    const sx = current.col * this.spriteScrubber.frameWidth;
                    const sy = current.row * this.spriteScrubber.frameHeight;
                    ctx.drawImage(sprite, sx, sy, this.spriteScrubber.frameWidth,
                                  this.spriteScrubber.frameHeight, 0, 0,
                                  current.preview.width, current.preview.height);
                };
                if (sprite.complete) {
                    if (sprite.naturalWidth) draw();
                } else if (!sprite.pendingScrubbers?.has(card)) {
                    const pending = sprite.pendingScrubbers ??= new WeakSet();
                    pending.add(card);
                    sprite.addEventListener('load', draw, { once: true });
                }
            }
        },

        // ========== 3. DISCOVERY PROFILE DASHBOARD ==========
        discoveryProfiles: [],
        discoveryStats: {},

        async loadDiscoveryDashboard() {
            try {
                const response = await fetch('/api/v1/discovery/profiles');
                const data = await response.json();
                this.discoveryProfiles = data.profiles || [];

                // Load stats for each profile
                for (const profile of this.discoveryProfiles) {
                    await this.updateDiscoveryProfileStats(profile.id);
                }
            } catch (error) {
                console.error('Failed to load discovery dashboard:', error);
            }
        },

        async updateDiscoveryProfileStats(profileId) {
            try {
                const response = await fetch(`/api/v1/discovery/profiles/${profileId}/stats`);
                const data = await response.json();
                this.discoveryStats[profileId] = data;
            } catch (error) {
                console.error(`Failed to load stats for profile ${profileId}:`, error);
            }
        },

        async runDiscoveryProfile(profileId) {
            try {
                const response = await fetch(`/api/v1/discovery/profiles/${profileId}/run`, {
                    method: 'POST'
                });
                const data = await response.json();

                if (data.status === 'success') {
                    this.showToast?.('Discovery profil spustený', 'rocket_launch', 'success');
                    setTimeout(() => this.updateDiscoveryProfileStats(profileId), 2000);
                }
            } catch (error) {
                console.error('Failed to run discovery profile:', error);
                this.showToast?.('Nepodarilo sa spustiť discovery profil', 'error', 'error');
            }
        },

        async reviewDiscoveryMatches(profileId) {
            try {
                const response = await fetch(`/api/v1/discovery/profiles/${profileId}/matches`);
                const data = await response.json();

                // Open review modal with matches
                this.openDiscoveryReviewModal(data.matches);
            } catch (error) {
                console.error('Failed to load matches:', error);
            }
        },

        // ========== 4. KLÁVESOVÉ SKRATKY (bez kolízie s command_palette.js) ==========
        initKeyboardShortcuts() {
            let keySequence = '';

            document.addEventListener('keydown', (e) => {
                // Otvorenie zjednotenej príkazovej palety cez "/" mimo vstupného poľa
                if (e.key === '/' && !this.isInputFocused()) {
                    e.preventDefault();
                    this.showCommandPalette = true;
                    return;
                }

                // Zatvorenie modálov (Esc)
                if (e.key === 'Escape') {
                    this.closeAllModals();
                    return;
                }

                // Navigácia v mriežke (j/k/h/l)
                if (!this.isInputFocused()) {
                    if (e.key === 'j') {
                        e.preventDefault();
                        this.navigateGrid('down');
                    } else if (e.key === 'k') {
                        e.preventDefault();
                        this.navigateGrid('up');
                    } else if (e.key === 'h') {
                        e.preventDefault();
                        this.navigateGrid('left');
                    } else if (e.key === 'l') {
                        e.preventDefault();
                        this.navigateGrid('right');
                    }
                }

                // Výber aktuálnej karty (x)
                if (e.key === 'x' && !this.isInputFocused()) {
                    e.preventDefault();
                    if (typeof this.toggleCurrentSelection === 'function') {
                        this.toggleCurrentSelection();
                    }
                }

                // Posun na začiatok / koniec (gg / Shift+G)
                if (e.key === 'g' && !this.isInputFocused()) {
                    if (keySequence === 'g') {
                        this.scrollToTop();
                        keySequence = '';
                    } else {
                        keySequence = 'g';
                        setTimeout(() => { keySequence = ''; }, 1000);
                    }
                }

                if (e.key === 'G' && e.shiftKey && !this.isInputFocused()) {
                    this.scrollToBottom();
                }

                // Sekvencia zmazania (dd)
                if (e.key === 'd' && !e.ctrlKey && !e.metaKey && !e.altKey && !this.isInputFocused()) {
                    if (keySequence === 'd') {
                        if (typeof this.deleteSelectedVideos === 'function') this.deleteSelectedVideos();
                        keySequence = '';
                    } else {
                        keySequence = 'd';
                        setTimeout(() => { keySequence = ''; }, 1000);
                    }
                }

                // Sekvencia obľúbených (ff)
                if (e.key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey && !this.isInputFocused()) {
                    if (keySequence === 'f') {
                        if (typeof this.toggleFavoriteSelected === 'function') this.toggleFavoriteSelected();
                        keySequence = '';
                    } else {
                        keySequence = 'f';
                        setTimeout(() => { keySequence = ''; }, 1000);
                    }
                }

                // Ctrl+H otvorí zdravotný monitor (Ctrl+K je pre vyhľadávanie, Ctrl+Shift+P rieši main.js)
                if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'h') {
                    if (typeof this.openHealthDashboard === 'function') {
                        e.preventDefault();
                        this.openHealthDashboard();
                    }
                }
            });
        },

        isInputFocused() {
            const active = document.activeElement;
            return Boolean(active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable));
        },

        navigateGrid(direction) {
            const cards = Array.from(document.querySelectorAll('.virtual-gallery-canvas .v-card'));
            if (!cards.length) return;
            const currentIdx = cards.findIndex(el => el === document.activeElement || el.contains(document.activeElement));
            let step = 1;
            if (direction === 'left') step = -1;
            else if (direction === 'right') step = 1;
            else {
                const firstTop = cards[0].getBoundingClientRect().top;
                const cols = Math.max(1, cards.filter(c => Math.abs(c.getBoundingClientRect().top - firstTop) < 8).length);
                step = direction === 'down' ? cols : -cols;
            }
            const nextIdx = currentIdx < 0 ? 0 : Math.max(0, Math.min(cards.length - 1, currentIdx + step));
            const target = cards[nextIdx];
            if (target) {
                if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
                target.focus({ preventScroll: false });
                target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        },

        scrollToTop() {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        },

        scrollToBottom() {
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        },

        // ========== 5. SMART TAG AUTO-COMPLETE + TAG CLOUD ==========
        tagCloud: [],
        tagAutocomplete: [],
        showTagAutocomplete: false,

        async loadTagCloud() {
            try {
                const response = await fetch('/api/tags/cloud');
                const data = await response.json();
                this.tagCloud = data.tags || [];
            } catch (error) {
                console.error('Failed to load tag cloud:', error);
            }
        },

        async searchTags(query) {
            if (!query || query.length < 2) {
                this.showTagAutocomplete = false;
                return;
            }

            try {
                const response = await fetch(`/api/tags/search?q=${encodeURIComponent(query)}`);
                const data = await response.json();
                this.tagAutocomplete = data.tags || [];
                this.showTagAutocomplete = this.tagAutocomplete.length > 0;
            } catch (error) {
                console.error('Tag search error:', error);
            }
        },

        selectTag(tag) {
            // Add tag to current video or filter
            this.filters.search = tag;
            this.loadVideos(true);
            this.showTagAutocomplete = false;
        },

        getTagSize(count) {
            // Calculate font size based on tag frequency
            const maxCount = Math.max(...this.tagCloud.map(t => t.count));
            const minSize = 12;
            const maxSize = 28;
            return minSize + ((count / maxCount) * (maxSize - minSize));
        },

        // ========== 6. LINK HEALTH DASHBOARD ==========
        healthStats: null,
        healthSources: [],
        healthUnknownDomains: [],

        async loadHealthDashboard() {
            try {
                const response = await fetch('/api/health/stats');
                const data = await response.json();
                this.healthStats = data;

                // Load per-source stats (includes unknown_domains backlog for new sites)
                const sourcesResponse = await fetch('/api/health/sources');
                const sourcesData = await sourcesResponse.json();
                this.healthSources = sourcesData.sources || [];
                this.healthUnknownDomains = sourcesData.unknown_domains || [];
            } catch (error) {
                console.error('Failed to load health dashboard:', error);
            }
        },

        async refreshAllBrokenLinks() {
            const confirmed = confirm('Refresh all broken links? This may take a while.');
            if (!confirmed) return;

            try {
                const response = await fetch('/api/health/refresh-broken', {
                    method: 'POST'
                });
                const data = await response.json();

                this.showToast(`Refreshing ${data.count} broken links...`, 'info');

                // Reload dashboard after refresh
                setTimeout(() => this.loadHealthDashboard(), 5000);
            } catch (error) {
                console.error('Failed to refresh broken links:', error);
                this.showToast('Refresh failed', 'error');
            }
        },

        getHealthScoreClass(score) {
            if (score >= 95) return 'excellent';
            if (score >= 80) return 'good';
            if (score >= 60) return 'fair';
            return 'poor';
        },

        // ========== 7. ADAPTIVE QUALITY BADGING ==========
        getQualityBadgeClass(video) {
            const height = video.height || 0;
            const linkStatus = video.link_status || 'unknown';
            const lastChecked = video.last_checked;
            const daysSinceCheck = lastChecked ?
                Math.floor((Date.now() - new Date(lastChecked).getTime()) / (1000 * 60 * 60 * 24)) : 999;

            if (height <= 0) {
                return 'q-unknown';
            }

            if (height >= 2160) {
                return linkStatus === 'working' ? 'q-4k verified' : 'q-4k';
            } else if (height >= 1080) {
                return daysSinceCheck > 7 ? 'q-1080p needs-check' : 'q-1080p';
            } else if (height >= 720) {
                return 'q-720p';
            }
            return 'q-sd';
        },

        getQualityBadgeText(video) {
            const height = video.height || 0;
            if (height <= 0) return 'Unknown';
            if (height >= 2160) return '4K';
            if (height >= 1440) return '1440p';
            if (height >= 1080) return '1080p';
            if (height >= 720) return '720p';
            if (height >= 480) return '480p';
            return 'SD';
        },

        getDownloadSpeed(video) {
            if (!video.download_stats) return null;
            const stats = typeof video.download_stats === 'string' ?
                JSON.parse(video.download_stats) : video.download_stats;
            return stats.avg_speed_mb ? `${stats.avg_speed_mb.toFixed(1)} MB/s` : null;
        },

        // ========== 8. QUANTUM FLOW SEARCH-TO-PLAY ==========
        quantumFlowActive: false,
        quantumFlowQuery: '',
        quantumFlowResults: [],

        openQuantumFlow() {
            this.quantumFlowActive = true;
            this.$nextTick(() => {
                const input = document.querySelector('.quantum-flow-input');
                if (input) input.focus();
            });
        },

        closeQuantumFlow() {
            this.quantumFlowActive = false;
            this.quantumFlowQuery = '';
            this.quantumFlowResults = [];
        },

        async searchQuantumFlow() {
            if (!this.quantumFlowQuery || this.quantumFlowQuery.length < 2) {
                this.quantumFlowResults = [];
                return;
            }

            try {
                const response = await fetch(`/api/search?q=${encodeURIComponent(this.quantumFlowQuery)}&limit=20`);
                const data = await response.json();
                this.quantumFlowResults = data.videos || [];
            } catch (error) {
                console.error('Quantum flow search error:', error);
            }
        },

        playQuantumFlowVideo(video) {
            this.closeQuantumFlow();
            this.playVideo(video);
        },

        // ========== 9. SMART DUPLICATE RESOLVER ==========
        duplicateResolverOpen: false,
        currentDuplicatePair: null,

        async scanDuplicates() {
            try {
                this.showToast('Scanning for duplicates...', 'info');

                const response = await fetch('/api/duplicates/scan', {
                    method: 'POST'
                });
                const data = await response.json();

                if (data.duplicates && data.duplicates.length > 0) {
                    this.showToast(`Found ${data.duplicates.length} duplicate pairs`, 'success');
                    this.openDuplicateResolver(data.duplicates[0]);
                } else {
                    this.showToast('No duplicates found', 'success');
                }
            } catch (error) {
                console.error('Duplicate scan error:', error);
                this.showToast('Scan failed', 'error');
            }
        },

        openDuplicateResolver(duplicatePair) {
            this.currentDuplicatePair = duplicatePair;
            this.duplicateResolverOpen = true;
        },

        closeDuplicateResolver() {
            this.duplicateResolverOpen = false;
            this.currentDuplicatePair = null;
        },

        async keepDuplicate(side) {
            if (!this.currentDuplicatePair) return;

            const keepId = side === 'left' ?
                this.currentDuplicatePair.original_id :
                this.currentDuplicatePair.duplicate_id;

            const deleteId = side === 'left' ?
                this.currentDuplicatePair.duplicate_id :
                this.currentDuplicatePair.original_id;

            try {
                await this.deleteVideo(deleteId);
                this.showToast('Duplicate resolved', 'success');
                this.closeDuplicateResolver();
                this.loadVideos(true);
            } catch (error) {
                console.error('Failed to resolve duplicate:', error);
                this.showToast('Resolution failed', 'error');
            }
        },

        async keepBothDuplicates() {
            this.showToast('Kept both videos', 'info');
            this.closeDuplicateResolver();
        },

        compareDuplicateField(field) {
            if (!this.currentDuplicatePair) return null;

            const original = this.currentDuplicatePair.original;
            const duplicate = this.currentDuplicatePair.duplicate;

            const ov = original[field];
            const dv = duplicate[field];
            if (ov === dv) return 'equal';
            if (ov > dv) return 'original-better';
            return 'duplicate-better';
        },

        // ========== 10. SESSION PERSISTENCE ==========
        sessionData: null,
        showSessionRestore: false,

        saveSession() {
            // Disabled per user request - do not save session
        },

        loadSession() {
            // Disabled per user request - do not load session
            localStorage.removeItem('nexus_session');
        },

        restoreSession() {
            // Disabled per user request - do not restore session
        },

        dismissSessionRestore() {
            // Disabled per user request
            this.showSessionRestore = false;
            localStorage.removeItem('nexus_session');
        },

        updateVideoProgress(videoId, currentTime, duration) {
            const progress = (currentTime / duration) * 100;
            const progressData = JSON.parse(localStorage.getItem('nexus_video_progress') || '{}');
            progressData[videoId] = { currentTime, duration, progress, updated: Date.now() };
            localStorage.setItem('nexus_video_progress', JSON.stringify(progressData));
        },

        getVideoProgress(videoId) {
            const progressData = JSON.parse(localStorage.getItem('nexus_video_progress') || '{}');
            return progressData[videoId] || null;
        },

        // ========== UTILITY METHODS ==========
        formatTime(seconds) {
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = Math.floor(seconds % 60);

            if (h > 0) {
                return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
            }
            return `${m}:${s.toString().padStart(2, '0')}`;
        },

        closeAllModals() {
            this.showCommandPalette = false;
            this.quantumFlowActive = false;
            this.duplicateResolverOpen = false;
            this.batchQueueOpen = false;
        },

        // Initialize all UX features
        initQuantumUX() {
            console.log('🚀 Initializing Quantum UX Features...');

            // Load session
            this.loadSession();

            // Init keyboard shortcuts
            this.initKeyboardShortcuts();

            const scheduleTagCloudLoad = () => {
                if (!document.hidden) this.loadTagCloud();
            };
            if ('requestIdleCallback' in window) {
                window.requestIdleCallback(scheduleTagCloudLoad, { timeout: 3500 });
            } else {
                setTimeout(scheduleTagCloudLoad, 1800);
            }

            // Setup batch queue zones
            this.$nextTick(() => {
                if (typeof this.setupBatchQueueZones === 'function') {
                    this.setupBatchQueueZones();
                }
            });

            // Auto-save session every 30 seconds
            setInterval(() => this.saveSession(), 30000);

            // Save session before page unload
            window.addEventListener('beforeunload', () => this.saveSession());

            console.log('✅ Quantum UX initialized');
        }
    };
}
