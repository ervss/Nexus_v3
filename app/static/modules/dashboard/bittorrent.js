export function createBitTorrentModule() {
    return {
        bittorrent: {
            installed: false,
            running: false,
            uiReachable: false,
            exePath: '',
            uiUrl: '',
            uiPort: 19575,
            savePath: '',
            loading: false,
            opening: false,
            lastError: '',
            items: [],
            itemsLoading: false,
            showBrowser: false,
            search: ''
        },

        async refreshBitTorrentStatus(silent = false) {
            this.bittorrent.loading = true;
            if (!silent) this.bittorrent.lastError = '';
            try {
                const response = await fetch('/api/integrations/bittorrent-web/status');
                const data = await response.json();
                if (!response.ok) {
                    throw new Error(data.detail || 'Failed to load BitTorrent Web status');
                }
                this.bittorrent = {
                    ...this.bittorrent,
                    installed: !!data.installed,
                    running: !!data.running,
                    uiReachable: !!data.ui_reachable,
                    exePath: data.exe_path || '',
                    uiUrl: data.ui_url || '',
                    uiPort: data.ui_port || 19575,
                    savePath: data.save_path || '',
                    lastError: ''
                };
            } catch (e) {
                this.bittorrent.lastError = String(e.message || e);
                if (!silent) this.showToast(this.bittorrent.lastError, 'error', 'error');
            } finally {
                this.bittorrent.loading = false;
            }
        },

        async openBitTorrentWeb() {
            this.bittorrent.opening = true;
            this.bittorrent.lastError = '';
            try {
                const response = await fetch('/api/integrations/bittorrent-web/open', { method: 'POST' });
                const data = await response.json();
                if (!response.ok) {
                    throw new Error(data.detail || 'Failed to open BitTorrent Web');
                }
                this.bittorrent = {
                    ...this.bittorrent,
                    installed: !!data.installed,
                    running: !!data.running,
                    uiReachable: !!data.ui_reachable,
                    exePath: data.exe_path || '',
                    uiUrl: data.ui_url || '',
                    uiPort: data.ui_port || this.bittorrent.uiPort,
                    savePath: data.save_path || this.bittorrent.savePath,
                    lastError: ''
                };
                this.showToast('BitTorrent Web opening on desktop', 'download', 'success');
                setTimeout(() => this.refreshBitTorrentStatus(true), 1800);
            } catch (e) {
                this.bittorrent.lastError = String(e.message || e);
                this.showToast(this.bittorrent.lastError, 'error', 'error');
            } finally {
                this.bittorrent.opening = false;
            }
        },

        openBitTorrentWebUi() {
            if (!this.bittorrent.uiUrl) {
                this.showToast('BitTorrent Web UI URL is not available', 'error', 'error');
                return;
            }
            window.open(this.bittorrent.uiUrl, '_blank', 'noopener');
        },

        async loadBitTorrentItems(silent = false) {
            this.bittorrent.itemsLoading = true;
            if (!silent) this.bittorrent.lastError = '';
            try {
                const response = await fetch('/api/integrations/bittorrent-web/items?limit=60');
                const data = await response.json();
                if (!response.ok) {
                    throw new Error(data.detail || 'Failed to load BitTorrent items');
                }
                this.bittorrent.items = Array.isArray(data.items) ? data.items : [];
            } catch (e) {
                this.bittorrent.lastError = String(e.message || e);
                if (!silent) this.showToast(this.bittorrent.lastError, 'error', 'error');
            } finally {
                this.bittorrent.itemsLoading = false;
            }
        },

        openBitTorrentBrowser() {
            this.bittorrent.showBrowser = true;
            this.loadBitTorrentItems(true);
        },

        filteredBitTorrentItems() {
            const q = String(this.bittorrent.search || '').trim().toLowerCase();
            const validItems = (this.bittorrent.items || []).filter(Boolean);
            if (!q) return validItems;
            return validItems.filter(item => {
                const hay = [
                    item.title,
                    item.status,
                    item.source,
                    item.height ? this.getQuality(item) : ''
                ].filter(Boolean).join(' ').toLowerCase();
                return hay.includes(q);
            });
        },

        playBitTorrentItem(item) {
            if (!item || !item.infohash || !item.playable) {
                this.showToast('Torrent video is not ready to stream yet', 'hourglass_top', 'info');
                return;
            }
            if (!item.stream_ready && item.status !== 'ready') {
                this.showToast('Torrent still buffering, wait a bit more', 'downloading', 'info');
                return;
            }
            const totalBytes = Number(item.total_bytes || 0);
            this.playVideo({
                id: `bt-${item.infohash}`,
                title: item.title || 'BitTorrent video',
                url: `/api/integrations/bittorrent-web/stream/${item.infohash}`,
                source_url: '',
                source: 'BitTorrent Web',
                thumbnail_path: item.thumbnail_path || '/static/placeholder.jpg',
                duration: Number(item.duration || 0),
                status: item.status === 'ready' ? 'ready' : 'ready_to_stream',
                storage_type: 'bittorrent',
                file_size_mb: totalBytes ? (totalBytes / (1024 * 1024)) : 0,
                progress: item.progress || 0,
                width: Number(item.width || 0),
                height: Number(item.height || 0)
            });
        }
    };
}

