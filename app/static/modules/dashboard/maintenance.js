export function createMaintenanceModule() {
    return {
        aiTagLimit: 250,
        _aiTagPollTimer: null,
        aiTagBatch: {
            running: false,
            cancelled: false,
            total: 0,
            done: 0,
            improved: 0,
            failed: 0,
            skipped: 0,
            percent: 0,
            currentVideoId: null,
            currentVideoTitle: '',
            lastTaggedVideoId: null,
            lastTaggedVideoTitle: '',
            lastAddedTags: [],
            lastError: '',
            activeModel: 'siglip2-local-gpu',
            etaFormatted: '',
            elapsedFormatted: '0s',
            statusText: 'Pripravené',
            message: '',
        },

        _ensureAiTagPolling() {
            if (this._aiTagPollTimer) return;
            this._aiTagPollTimer = setInterval(() => {
                this.pollAiTagBatchStatus();
            }, 1500);
        },

        _stopAiTagPolling() {
            if (this._aiTagPollTimer) {
                clearInterval(this._aiTagPollTimer);
                this._aiTagPollTimer = null;
            }
        },

        async pollAiTagBatchStatus() {
            try {
                const res = await fetch('/api/maintenance/ai-tag-batch/status');
                if (!res.ok) return;
                const data = await res.json();
                if (data) {
                    const wasRunning = !!this.aiTagBatch?.running;
                    this.aiTagBatch = {
                        ...this.aiTagBatch,
                        running: !!data.running,
                        total: data.total || 0,
                        done: data.done || 0,
                        improved: data.improved || 0,
                        failed: data.failed || 0,
                        skipped: data.skipped || 0,
                        percent: data.percent || 0,
                        currentVideoId: data.current_video_id,
                        currentVideoTitle: data.current_video_title,
                        lastTaggedVideoId: data.last_tagged_video_id,
                        lastTaggedVideoTitle: data.last_tagged_video_title,
                        lastAddedTags: data.last_added_tags || [],
                        lastError: data.last_error || '',
                        activeModel: data.active_model || 'siglip2-local-gpu',
                        etaFormatted: data.eta_formatted || '',
                        elapsedFormatted: data.elapsed_formatted || '0s',
                        statusText: data.status_text || 'Pripravené',
                        message: data.message || '',
                    };
                    if (data.running) {
                        this._ensureAiTagPolling();
                    } else if (wasRunning && !data.running) {
                        this._stopAiTagPolling();
                        if (typeof this.loadVideos === 'function') this.loadVideos(true);
                    }
                }
            } catch (e) {
                console.debug('pollAiTagBatchStatus error:', e);
            }
        },

        aiTagBatchNames() {
            const names = Array.isArray(this.filters?.batches) ? this.filters.batches.filter(Boolean) : [];
            if (names.length) return names;
            const name = this.filters?.batch;
            return name && name !== 'All' ? [name] : [];
        },

        async startAiTagBatch(mode = 'missing') {
            if (this.aiTagBatch?.running) {
                this.showToast('AI tagovanie už prebieha na pozadí.', 'info', 'warning');
                return;
            }
            const batchNames = this.aiTagBatchNames();
            const videoIds = mode === 'selected' ? [...new Set(this.selectedIds || [])]
                : mode === 'view' ? [...new Set((this.videos || []).map(v => v?.id).filter(Boolean))] : null;
            if ((mode === 'batch' && !batchNames.length) || (videoIds && !videoIds.length)) {
                this.showToast('Najprv vyber batch alebo videá pre tagovanie.', 'info', 'warning');
                return;
            }
            const label = mode === 'batch' ? `pre batch: ${batchNames.join(', ')}`
                : mode === 'selected' ? `pre ${videoIds.length} označených videí`
                : mode === 'view' ? `pre ${videoIds.length} načítaných videí` : 'pre celú knižnicu';
            const chosenLimit = Number(this.aiTagLimit) || 250;

            if (mode !== 'missing' && mode !== 'all') {
                try {
                    const status = await fetch('/api/maintenance/ai-tag-batch/status');
                    const capabilities = await status.json();
                    if (!status.ok || capabilities.scope_version !== 1) throw new Error('Reštartuj Nexus server, aby sa načítala podpora výberu videí.');
                } catch (e) {
                    this.showToast(e.message || 'Nedá sa overiť verzia servera.', 'error', 'error', 8000);
                    return;
                }
            }
            this.aiTagBatch = {
                running: true,
                cancelled: false,
                total: 0,
                done: 0,
                improved: 0,
                failed: 0,
                skipped: 0,
                percent: 0,
                currentVideoId: null,
                currentVideoTitle: '',
                lastTaggedVideoId: null,
                lastTaggedVideoTitle: '',
                lastAddedTags: [],
                lastError: '',
                activeModel: 'siglip2-local-gpu',
                etaFormatted: 'Počítam...',
                elapsedFormatted: '0s',
                statusText: `Pripravujem AI tagovanie ${label}...`,
                message: '',
            };
            this._ensureAiTagPolling();

            try {
                const res = await fetch('/api/maintenance/ai-tag-batch/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        limit: chosenLimit,
                        batch_names: mode === 'batch' ? batchNames : null,
                        video_ids: videoIds,
                        only_missing: mode !== 'all',
                        concurrency: 4,
                        overwrite: false,
                        model: 'siglip2-local-gpu',
                    }),
                });
                const data = await res.json();
                if (!res.ok || data.error) {
                    throw new Error(data.error || data.detail || 'Zlyhalo spustenie');
                }
                this.showToast(`AI Tagovanie spustené ${label} (max ${chosenLimit} videí)`, 'auto_awesome', 'info');
            } catch (e) {
                this.aiTagBatch.running = false;
                this.aiTagBatch.statusText = 'Zlyhalo spustenie';
                this.aiTagBatch.lastError = e.message || String(e);
                this._stopAiTagPolling();
                this.showToast(`Chyba spustenia AI tagovania: ${e.message}`, 'error', 'error');
            }
        },

        async cancelAiTagBatch() {
            if (!this.aiTagBatch?.running) return;
            this.aiTagBatch.statusText = 'Zastavujem...';
            try {
                const res = await fetch('/api/maintenance/ai-tag-batch/cancel', { method: 'POST' });
                const data = await res.json();
                this.showToast(data.message || 'Zastavenie vyžiadané', 'info', 'info');
            } catch (e) {
                this.showToast(`Chyba pri zastavovaní: ${e.message}`, 'error', 'error');
            }
        },

        async runMaintenance(action) {
            let endpoint = '';
            let method = 'POST';
            let body = null;
            let successMsg = '';

            switch (action) {
                case 'full-optimization':
                    endpoint = '/api/maintenance/full-optimization';
                    successMsg = 'Full optimization started in background!';
                    break;
                case 'resolve-name':
                    endpoint = '/api/maintenance/duplicates/resolve';
                    body = { type: 'name' };
                    successMsg = 'Name duplicates resolved!';
                    break;
                case 'resolve-hash':
                    endpoint = '/api/maintenance/duplicates/resolve';
                    body = { type: 'hash' };
                    successMsg = 'Visual duplicates resolved!';
                    break;
                case 'cleanup-broken':
                    endpoint = '/api/maintenance/cleanup';
                    body = { delete_permanently: true };
                    successMsg = 'Broken links removed!';
                    break;
                case 'normalize-titles':
                    endpoint = '/api/maintenance/normalize-titles';
                    successMsg = 'Titles normalized!';
                    break;
                case 'fix-thumbnails':
                    endpoint = '/api/maintenance/fix-thumbnails';
                    successMsg = 'Missing or flagged thumbnails re-queued!';
                    break;
                case 'retry-flagged-previews':
                    endpoint = '/api/maintenance/retry-flagged-previews';
                    successMsg = 'Second-pass preview retry started. Failed items will be removed.';
                    break;
                case 'sync-durations':
                    endpoint = '/api/maintenance/sync-durations';
                    successMsg = 'Durations synced from source!';
                    break;
                case 'scan-sizes':
                    endpoint = '/api/maintenance/scan-sizes';
                    successMsg = 'File size extraction completed!';
                    break;
                case 'refresh-metadata':
                    endpoint = '/api/maintenance/refresh-metadata';
                    successMsg = 'Metadata refresh session started!';
                    break;
                case 'enrich-tags-missing':
                    endpoint = '/api/maintenance/enrich-tags';
                    body = { only_missing: true, limit: 1200, overwrite: false };
                    successMsg = 'Tag enrichment started for videos missing tags!';
                    break;
                case 'enrich-tags-batch':
                    endpoint = '/api/maintenance/enrich-tags';
                    body = { batch_name: this.aiTagBatchNames()[0], only_missing: false, limit: 1200, overwrite: false };
                    successMsg = `Tag enrichment started for batch: ${body.batch_name}`;
                    break;
                case 'refresh-bunkr':
                    endpoint = '/api/maintenance/refresh-bunkr';
                    body = { batch_name: this.filters.batch || null, concurrency: 4, limit: 2000 };
                    successMsg = this.filters.batch
                        ? `Bunkr refresh started for batch: ${this.filters.batch}`
                        : 'Bunkr refresh started for all Bunkr videos!';
                    break;
            }

            try {
                this.showToast(`Running ${action}...`, 'settings', 'info');
                const opt = {
                    method: method,
                    headers: { 'Content-Type': 'application/json' }
                };
                if (body) opt.body = JSON.stringify(body);

                const response = await fetch(endpoint, opt);
                const data = await response.json();

                if (response.ok) {
                    this.showToast(
                        successMsg + (data.deleted_videos ? ` (Deleted ${data.deleted_videos})` : ''),
                        'check_circle',
                        'success'
                    );
                    if (action !== 'full-optimization') this.loadVideos(true);
                } else {
                    this.showToast(`Error: ${data.detail || 'Failed to run maintenance'}`, 'error', 'error');
                }
            } catch (e) {
                this.showToast(`Maintenance failed: ${e}`, 'error', 'error');
            }
        }
    };
}

