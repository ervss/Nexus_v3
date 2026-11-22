export function createLogCenterModule() {
    return {
        showLogPanel: false,
        logPanelTab: 'audit',
        logSearch: '',
        logLoading: false,
        auditLogs: [],
        serverLogs: { out: [], err: [] },
        logPaths: {},
        localAiLoading: false,
        localAiReply: '',
        localAiError: '',
        localAiModel: '',

        async openLogPanel() {
            this.showLogPanel = true;
            await this.loadLogCenter();
        },

        async loadLogCenter() {
            this.logLoading = true;
            try {
                const response = await fetch('/api/v1/logs?limit=300&server_lines=300');
                const data = await response.json();
                if (!response.ok) {
                    throw new Error(data.detail || 'Failed to load logs');
                }
                this.auditLogs = data.audit || [];
                this.serverLogs = data.server || { out: [], err: [] };
                this.logPaths = data.paths || {};
            } catch (e) {
                console.error(e);
                this.showToast('Log load failed', 'error', 'error');
            } finally {
                this.logLoading = false;
            }
        },

        buildLocalAiContext() {
            const MAX_CHARS = 10000;
            let logSlice = '';
            const tab = this.logPanelTab || 'audit';
            if (tab === 'audit') {
                const rows = (this.filteredAuditLogs || []).slice(0, 40).map((entry) => ({
                    ts: entry?.ts,
                    event: entry?.event,
                    batch: entry?.batch,
                    error: entry?.error,
                    method: entry?.method || entry?.parser,
                    imported_count: entry?.imported_count,
                    expanded_count: entry?.expanded_count,
                }));
                logSlice = JSON.stringify(rows, null, 2);
            } else if (tab === 'out') {
                logSlice = (this.serverLogs?.out || []).slice(-80).join('\n');
            } else if (tab === 'err') {
                logSlice = (this.serverLogs?.err || []).slice(-80).join('\n');
            } else {
                const live = (this.logs || []).slice(-40).map((log) => ({
                    level: log?.level || log?.type,
                    message: log?.message,
                    ts: log?.timestamp,
                }));
                logSlice = JSON.stringify(live, null, 2);
            }

            const snapshot = {
                tab,
                loadError: this.loadError || '',
                videosLoaded: Array.isArray(this.videos) ? this.videos.length : 0,
                selectedCount: Array.isArray(this.selectedIds) ? this.selectedIds.length : 0,
                search: this.filters?.search || '',
                source: this.filters?.source || 'All',
                hasMore: !!this.hasMore,
                isLoading: !!this.isLoading,
            };

            let text = [
                'DASHBOARD SNAPSHOT:',
                JSON.stringify(snapshot, null, 2),
                '',
                `ACTIVE LOG TAB (${tab}):`,
                logSlice || '(empty)',
            ].join('\n');

            if (text.length > MAX_CHARS) {
                text = text.slice(0, MAX_CHARS) + '\n…[truncated]';
            }
            return text;
        },

        async analyzeWithLocalAi() {
            if (this.localAiLoading) return;
            this.localAiLoading = true;
            this.localAiError = '';
            this.localAiReply = '';
            this.localAiModel = '';
            try {
                const response = await fetch('/api/v1/local-ai/analyze', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        context: this.buildLocalAiContext(),
                        prompt: 'Summarize issues in these Nexus logs and suggest the next concrete actions.',
                    }),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    const detail = data.detail || data.message || `HTTP ${response.status}`;
                    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
                }
                this.localAiReply = data.reply || '';
                this.localAiModel = data.model || '';
                if (!this.localAiReply) throw new Error('Empty AI reply');
            } catch (e) {
                this.localAiError = e?.message || 'Local AI request failed';
                this.showToast(this.localAiError, 'error', 'error', 5000);
            } finally {
                this.localAiLoading = false;
            }
        },

        get filteredAuditLogs() {
            const q = (this.logSearch || '').trim().toLowerCase();
            if (!q) return this.auditLogs;
            return this.auditLogs.filter((entry) => JSON.stringify(entry).toLowerCase().includes(q));
        },

        formatLogTime(ts) {
            if (!ts) return '--';
            try {
                return new Date(ts).toLocaleString('sk-SK', {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                });
            } catch (e) {
                return ts;
            }
        },

        logEventLabel(eventName) {
            const labels = {
                import_queued: 'Queued',
                import_started: 'Started',
                url_expanded: 'Expanded',
                import_expanded: 'Expanded',
                import_finished: 'Finished',
                import_failed: 'Failed',
                parse_error: 'Parse Error'
            };
            return labels[eventName] || eventName || 'Event';
        },

        logEventClass(eventName) {
            if (eventName === 'import_failed' || eventName === 'parse_error') return 'bad';
            if (eventName === 'import_finished') return 'good';
            if (eventName === 'url_expanded' || eventName === 'import_expanded') return 'info';
            return 'neutral';
        },

        logEntryUrls(entry) {
            const urls = [];
            if (entry?.source_url) urls.push(entry.source_url);
            if (Array.isArray(entry?.urls)) urls.push(...entry.urls);
            if (Array.isArray(entry?.sample_urls)) urls.push(...entry.sample_urls);
            return [...new Set(urls)].filter(Boolean);
        },

        async copyLogText(text) {
            try {
                await navigator.clipboard.writeText(text || '');
                this.showToast('Copied', 'content_copy', 'success');
            } catch (e) {
                this.showToast('Copy failed', 'error', 'error');
            }
        }
    };
}

