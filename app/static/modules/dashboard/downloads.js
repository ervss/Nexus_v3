export function createDownloadModule() {
    return {
        downloads: {},

        get hasActiveDownloads() {
            return Object.keys(this.downloads || {}).length > 0;
        },

        get primaryDownload() {
            const ids = Object.keys(this.downloads || {});
            if (!ids.length) return null;
            const id = ids[0];
            const raw = this.downloads[id];
            const data = typeof raw === 'number' ? { percent: raw } : (raw || {});
            const percent = typeof data.percent === 'number' ? data.percent : 0;
            const downloadedMb = typeof data.downloaded_mb === 'number' ? data.downloaded_mb : null;
            const totalMb = typeof data.total_mb === 'number' ? data.total_mb : null;
            const speedMb = typeof data.speed_mb_s === 'number' ? data.speed_mb_s : null;
            const video = (this.videos || []).find(v => String(v.id) === String(id));

            let etaSeconds = null;
            if (downloadedMb != null && totalMb != null && speedMb != null && speedMb > 0) {
                const remainingMb = totalMb - downloadedMb;
                if (remainingMb > 0) {
                    etaSeconds = remainingMb / speedMb;
                }
            }

            return {
                id,
                title: video ? video.title : `Video #${id}`,
                percent,
                downloadedMb,
                totalMb,
                speedMb,
                etaSeconds
            };
        },

        formatEta(seconds) {
            if (seconds == null || seconds === Infinity) return '';
            if (seconds < 60) return `${Math.ceil(seconds)}s`;
            const mins = Math.floor(seconds / 60);
            const secs = Math.ceil(seconds % 60);
            return `${mins}m ${secs}s`;
        },

        get downloadSummaryText() {
            const primary = this.primaryDownload;
            if (!primary) return '';
            const count = Object.keys(this.downloads || {}).length;
            const parts = [];

            if (primary.downloadedMb != null && primary.totalMb != null) {
                const left = Math.max(0, primary.totalMb - primary.downloadedMb);
                parts.push(`${primary.downloadedMb.toFixed(1)} / ${primary.totalMb.toFixed(1)} MB (${left.toFixed(1)} MB left)`);
            }

            if (primary.speedMb != null) {
                parts.push(`${primary.speedMb.toFixed(1)} MB/s`);
            }

            if (primary.etaSeconds != null) {
                parts.push(`ETA: ${this.formatEta(primary.etaSeconds)}`);
            }

            if (count > 1) {
                parts.push(`${count} active`);
            }

            return parts.join(' · ');
        },

        get systemStatus() {
            if (this.hasActiveDownloads) {
                const p = this.primaryDownload;
                if (!p) return { text: 'Starting downloads...', type: 'downloading', icon: 'download' };
                let text = `Downloading: ${p.title || 'Video'} (${p.percent || 0}%)`;
                if (p.speedMb != null) text += ` · ${p.speedMb.toFixed(1)} MB/s`;
                if (p.etaSeconds != null) text += ` · ETA: ${this.formatEta(p.etaSeconds)}`;
                return { text, type: 'downloading', icon: 'download' };
            }
            const processing = (this.videos || []).find(v => v.status === 'processing');
            if (processing) {
                return { text: `Processing: ${processing.title}...`, type: 'processing', icon: 'sync' };
            }
            const pending = (this.videos || []).filter(v => v.status === 'pending').length;
            if (pending > 0) {
                return { text: `Idle - ${pending} tasks pending`, type: 'idle', icon: 'queue' };
            }
            return { text: 'System Ready', type: 'ready', icon: 'verified' };
        },

        get liveActions() {
            let actions = [];

            const importActions = (this.importMonitor?.items || [])
                .filter(item => ['processing', 'pending', 'warning', 'done', 'error'].includes(item.status))
                .slice(0, 4)
                .map(item => ({
                    id: `import-${item.key}`,
                    text: `${item.source_label || 'Import'}: ${item.done_items || 0}/${item.total_items || 0}`,
                    detail: item.sample_title || item.batch_name || 'Import batch',
                    summary: item.batch_name || '',
                    percent: Number(item.percent || 0),
                    status: ['processing', 'pending', 'warning'].includes(item.status) ? 'working' : 'done',
                    statusLabel: this.importMonitorStatusLabel(item.status),
                    icon: 'cloud_sync',
                    type: item.status === 'error' ? 'error' : 'processing',
                    actionName: 'Import Batch',
                    startTimestamp: item.started_at ? new Date(item.started_at).getTime() : Date.now(),
                    endTimestamp: item.finished_at ? new Date(item.finished_at).getTime() : null,
                }));
            actions.push(...importActions);

            // 1. Add active downloads
            const activeDl = Object.values(this.downloads || {}).filter(d => d.percent < 100);
            activeDl.forEach(d => {
                actions.push({
                    id: `dl-${d.id || d.video_id}`,
                    text: `Downloading: ${d.title || 'Video'}`,
                    detail: d.title || 'Video',
                    percent: d.percent || 0,
                    status: 'working',
                    icon: 'cloud_download',
                    type: 'download',
                    actionName: 'Download',
                    startTimestamp: Date.now(),
                });
            });

            // 2. Add processing videos (if not already in downloads)
            const processing = (this.videos || []).filter(v => v.status === 'processing');
            processing.forEach(p => {
                const hasTrackedActivity = this.recentActivities.some((a) => a.activityKey === `vip-${p.id}` || a.activityKey === `thumb-${p.id}`);
                if (!actions.find(a => a.id.includes(p.id)) && !hasTrackedActivity) {
                    actions.push({
                        id: `proc-${p.id}`,
                        text: `Processing: ${p.title || p.id}...`,
                        detail: `Processing ID ${p.id}`,
                        status: 'working',
                        icon: 'sync',
                        type: 'processing',
                        actionName: 'VIPVideoProcessor',
                        startTimestamp: p.created_at ? new Date(p.created_at).getTime() : Date.now(),
                    });
                }
            });

            // 3. Add recent logs (success, error, warning)
            const logActivities = this.recentActivities.filter((activity) => {
                const activityText = String(
                    activity?.text || activity?.detail || activity?.actionName || ''
                );
                if (!activityText) {
                    return true;
                }
                return !actions.find((existing) => {
                    const existingText = String(
                        existing?.text || existing?.detail || existing?.actionName || ''
                    );
                    return existingText && activityText.includes(existingText.substring(0, 20));
                });
            });

            actions = [...actions, ...logActivities];

            // If empty, add a default ready state
            if (actions.length === 0) {
                actions.push({
                    id: 'ready',
                    text: 'System Ready',
                    status: 'done',
                    icon: 'verified',
                    type: 'system'
                });
            }

            return actions.slice(0, 4);
        },

        startDownloadPolling() {
            if (this.settings?.perfLite) {
                return;
            }
            if (this.downloadPollTimer) {
                clearTimeout(this.downloadPollTimer);
                this.downloadPollTimer = null;
            }
            let failCount = 0;
            const poll = () => {
                if (document.hidden) {
                    this.downloadPollTimer = setTimeout(poll, 15000);
                    return;
                }
                fetch('/api/downloads/active')
                    .then(r => r.json())
                    .then(data => {
                        failCount = 0;
                        this.downloads = data || {};
                        const hasActive = !!Object.keys(this.downloads || {}).length;
                        this.downloadPollTimer = setTimeout(poll, hasActive ? 1500 : 5000);
                    })
                    .catch(() => {
                        failCount++;
                        this.downloadPollTimer = setTimeout(poll, Math.min(2000 * Math.pow(2, failCount), 30000));
                    });
            };
            this.downloadPollTimer = setTimeout(poll, 2000);
        },
    };
}

