
const _getLang = () => {
    try {
        if (typeof localStorage !== 'undefined') {
            const l = localStorage.getItem('nexus_language');
            if (l === 'en' || l === 'sk') return l;
            const v = localStorage.getItem('vipSettings');
            if (v) {
                const parsed = JSON.parse(v);
                if (parsed.language === 'en' || parsed.tooltipLanguage === 'en') return 'en';
                if (parsed.language === 'sk' || parsed.tooltipLanguage === 'sk') return 'sk';
            }
        }
        if (typeof document !== 'undefined' && document.documentElement.lang) {
            if (document.documentElement.lang.startsWith('sk')) return 'sk';
            if (document.documentElement.lang.startsWith('en')) return 'en';
        }
    } catch (_) {}
    return 'en';
};
const _t = (sk, en) => (_getLang() === 'sk' ? sk : en);

// Nexus Universal Video Importer - Content Script

(function() {
    const SCAN_INTERVAL = 2000;
    const MIN_DURATION = 10; // Seconds

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[char]);
    }

    function createOverlay(video) {
        if (video.dataset.nexusImporterActive) return;
        video.dataset.nexusImporterActive = 'true';

        // Extrakcia kvalít zo <source> tagov, ak sú dostupné
        const sources = Array.from(video.querySelectorAll('source')).filter(s => s.src && !s.src.startsWith('blob:'));
        
        let bestSourceUrl = "";
        let bestSourceLabel = "";
        let maxRes = 0;

        const sourcesHtml = sources.map((s, i) => {
            const label = s.getAttribute('label') || s.getAttribute('res') || s.getAttribute('size') || s.getAttribute('title') || s.getAttribute('data-res') || `Zdroj ${i+1}`;
            const resMatch = label.match(/(\d+)/);
            const res = resMatch ? parseInt(resMatch[1]) : 0;
            if (res > maxRes) {
                maxRes = res;
                bestSourceUrl = s.src;
                bestSourceLabel = label;
            }
            return `<div class="nexus-quality-opt" data-url="${escapeHtml(s.src)}" style="cursor: pointer; padding: 2px 0;">${escapeHtml(label)}</div>`;
        }).join('');

        const defaultText = bestSourceLabel ? `Najvyššia (${bestSourceLabel})` : 'Auto (Predvolená)';
        const defaultUrl = bestSourceUrl || '';

        let qualityHtml = `
            <div class="nexus-quality-section" style="margin-top: 6px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 6px;">
                <div style="font-size: 10px; color: #aaa; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px;">Kvalita:</div>
                <div class="nexus-quality-list">
                    <div class="nexus-quality-opt active nexus-default-quality" data-url="${escapeHtml(defaultUrl)}" style="color: #2ecc71; font-weight: bold; cursor: pointer; padding: 2px 0;">${escapeHtml(defaultText)}</div>
                    ${sourcesHtml}
                </div>
            </div>
            <section class="nexus-quality-hunt" aria-label="Hľadanie lepšej kvality">
                <div class="nexus-hunt-controls">
                    <label class="nexus-hunt-mode-label">Hľadanie
                        <select class="nexus-hunt-mode" aria-label="Režim hľadania">
                            <option value="quick">Rýchle</option>
                            <option value="deep">Dôkladné</option>
                        </select>
                    </label>
                    <button type="button" class="nexus-hunt-visual" aria-pressed="false" aria-label="Zapnúť vizuálne porovnanie" title="Pri zapnutí sa aktuálna snímka odošle službe obrazového vyhľadávania.">Hľadať podľa obrazu</button>
                </div>
                <button type="button" class="nexus-hunt-start">Hľadať lepšiu kvalitu</button>
                <button type="button" class="nexus-hunt-stop" hidden>Zastaviť hľadanie</button>
                <div class="nexus-hunt-status" role="status" aria-live="polite">Porovná alternatívne zdroje s týmto videom.</div>
                <div class="nexus-hunt-results" hidden></div>
            </section>
        `;

        const container = document.createElement('div');
        container.className = 'nexus-import-overlay';
        
        container.innerHTML = `
            <button type="button" class="nexus-import-btn" aria-label="Otvoriť nástroje Nexus pre toto video">
                <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                Nástroje videa
            </button>
            <div class="nexus-port-menu">
                <div style="font-size: 10px; color: #aaa; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px;">Port:</div>
                <div class="nexus-port-opt" data-port="8001">Nexus 8001 <span>MAIN</span></div>
                <div class="nexus-port-opt" data-port="8000">Nexus 8000 <span>ALT</span></div>
                <div class="nexus-port-opt" data-port="8002">Nexus 8002 <span>ALT</span></div>
                ${qualityHtml}
                <div class="nexus-copy-url-btn">
                    <svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
                    Kopírovať URL
                </div>
            </div>
        `;

        // Position overlay relative to video parent or video itself
        const parent = video.parentElement;
        if (getComputedStyle(parent).position === 'static') {
            parent.style.position = 'relative';
        }
        parent.appendChild(container);

        // Handle Quality Selection
        function bindQualityOpt(opt) {
            opt.onclick = (e) => {
                e.stopPropagation();
                e.preventDefault();
                container.querySelectorAll('.nexus-quality-opt').forEach(o => {
                    o.classList.remove('active');
                    o.style.color = '';
                    o.style.fontWeight = 'normal';
                });
                opt.classList.add('active');
                opt.style.color = '#2ecc71';
                opt.style.fontWeight = 'bold';
            };
        }

        container.querySelectorAll('.nexus-quality-opt').forEach(bindQualityOpt);

        const huntMode = container.querySelector('.nexus-hunt-mode');
        const visualButton = container.querySelector('.nexus-hunt-visual');
        visualButton.onclick = (event) => {
            event.stopPropagation();
            const enabled = visualButton.getAttribute('aria-pressed') !== 'true';
            visualButton.setAttribute('aria-pressed', String(enabled));
            visualButton.textContent = enabled ? 'Obraz zapnutý' : 'Hľadať podľa obrazu';
        };
        container.querySelector('.nexus-hunt-start').onclick = (event) => {
            event.stopPropagation();
            startQualityHunt(container, video, huntMode.value, visualButton.getAttribute('aria-pressed') === 'true');
        };
        container.querySelector('.nexus-hunt-stop').onclick = async (event) => {
            event.stopPropagation();
            const jobId = container.dataset.huntJobId;
            container.dataset.huntRun = String((Number(container.dataset.huntRun) || 0) + 1);
            container.dataset.huntRunning = 'false';
            const stop = container.querySelector('.nexus-hunt-stop');
            stop.hidden = true;
            const start = container.querySelector('.nexus-hunt-start');
            start.disabled = false;
            start.textContent = 'Hľadať znova';
            if (jobId) await sendHuntMessage({ type: 'QUALITY_HUNT_CANCEL', jobId, baseUrl: container.dataset.huntBaseUrl || '' });
            container.querySelector('.nexus-hunt-status').textContent = 'Hľadanie zastavené.';
        };

        // Detekcia a parsovanie HLS streamu pre dodatočné kvality
        let hlsCheckAttempts = 0;
        const hlsCheckInterval = setInterval(() => {
            hlsCheckAttempts++;
            if (hlsCheckAttempts > 15) {
                clearInterval(hlsCheckInterval);
                return;
            }

            chrome.runtime.sendMessage({ type: 'GET_CAPTURED_STREAM' }, (response) => {
                const streamUrl = response?.streamUrl;
                if (streamUrl && streamUrl.includes('.m3u8')) {
                    clearInterval(hlsCheckInterval);

                    chrome.runtime.sendMessage({ type: 'FETCH_PLAYLIST', url: streamUrl }, (res) => {
                        if (!res || res.error || !res.text) return;
                        
                        const lines = res.text.split('\n');
                        const qualities = [];
                        let currentRes = null;
                        
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i].trim();
                            if (line.startsWith('#EXT-X-STREAM-INF')) {
                                const resMatch = line.match(/RESOLUTION=\d+x(\d+)/);
                                currentRes = resMatch ? parseInt(resMatch[1]) : 0;
                            } else if (line && !line.startsWith('#') && currentRes !== null) {
                                const label = currentRes ? (currentRes + 'p') : 'HLS Stream';
                                const fullUrl = new URL(line, streamUrl).href;
                                if (!qualities.some(q => q.height === currentRes)) {
                                    qualities.push({ label, url: fullUrl, height: currentRes });
                                }
                                currentRes = null;
                            }
                        }
                        
                        qualities.sort((a, b) => b.height - a.height);
                        
                        if (qualities.length > 0) {
                            const best = qualities[0];
                            const defaultOpt = container.querySelector('.nexus-default-quality');
                            if (defaultOpt) {
                                defaultOpt.innerText = `Najvyššia (${best.label} HLS)`;
                                defaultOpt.dataset.url = best.url;
                            }

                            const listContainer = container.querySelector('.nexus-quality-list');
                            if (listContainer) {
                                qualities.forEach(q => {
                                    const opt = document.createElement('div');
                                    opt.className = 'nexus-quality-opt';
                                    opt.dataset.url = q.url;
                                    opt.style.cssText = 'cursor: pointer; padding: 2px 0;';
                                    opt.innerText = q.label + ' (HLS)';
                                    bindQualityOpt(opt);
                                    listContainer.appendChild(opt);
                                });
                            }
                        }
                    });
                }
            });
        }, 2000);

        container.querySelectorAll('.nexus-port-opt').forEach(opt => {
            opt.onclick = (e) => {
                e.stopPropagation();
                e.preventDefault();
                const activeOpt = container.querySelector('.nexus-quality-opt.active');
                const finalUrl = activeOpt ? activeOpt.dataset.url : null;
                handleImport(video, opt.dataset.port, finalUrl);
            };
        });

        const copyBtn = container.querySelector('.nexus-copy-url-btn');
        if (copyBtn) {
            copyBtn.onclick = (e) => {
                e.stopPropagation();
                e.preventDefault();
                const activeOpt = container.querySelector('.nexus-quality-opt.active');
                const finalUrl = activeOpt ? activeOpt.dataset.url : null;
                
                if (finalUrl && !finalUrl.startsWith('blob:')) {
                    navigator.clipboard.writeText(finalUrl).then(() => {
                        showToast('URL skopírovaná do schránky!');
                    }).catch(() => {
                        showToast(_t('Chyba pri kopírovaní URL', 'Failed to copy URL'), true);
                    });
                } else {
                    chrome.runtime.sendMessage({ type: 'GET_CAPTURED_STREAM' }, (response) => {
                        const streamUrl = response?.streamUrl || video.currentSrc || video.src;
                        if (streamUrl && !streamUrl.startsWith('blob:')) {
                            navigator.clipboard.writeText(streamUrl).then(() => {
                                showToast('URL skopírovaná (zistená z playera)!');
                            });
                        } else {
                            showToast('Nenašla sa priama URL na kopírovanie', true);
                        }
                    });
                }
            };
        }
    }

    function sendHuntMessage(message, timeout = 15000) {
        return new Promise(resolve => {
            const timer = setTimeout(() => resolve({ ok: false, error: 'Časový limit spojenia s Nexus.' }), timeout);
            try {
                chrome.runtime.sendMessage(message, answer => {
                    clearTimeout(timer);
                    const error = chrome.runtime.lastError;
                    resolve(error ? { ok: false, error: error.message } : (answer || { ok: false, error: 'Rozšírenie neodpovedá.' }));
                });
            } catch (error) {
                clearTimeout(timer);
                resolve({ ok: false, error: error?.message || String(error) });
            }
        });
    }

    function captureHuntFrame(video) {
        try {
            if (!video.videoWidth || !video.videoHeight) return '';
            const scale = Math.min(1, 640 / video.videoWidth);
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
            canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
            canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
            const frame = canvas.toDataURL('image/jpeg', 0.7);
            return frame.length > 200 ? frame : '';
        } catch (_) {
            return ''; // Cross-origin and protected video canvases cannot be sampled.
        }
    }

    function appendHuntResults(container, groups) {
        const results = container.querySelector('.nexus-hunt-results');
        results.replaceChildren();
        const sections = [
            ['better', 'Vyššie rozlíšenie'],
            ['other', 'Potvrdené alternatívy'],
            ['maybe', 'Nepotvrdené zhody'],
        ];
        let count = 0;
        for (const [key, title] of sections) {
            const cards = Array.isArray(groups?.[key]) ? groups[key] : [];
            if (!cards.length) continue;
            count += cards.length;
            const heading = document.createElement('div');
            heading.className = `nexus-hunt-group-title nexus-hunt-${key}`;
            heading.textContent = `${title} (${cards.length})`;
            results.appendChild(heading);
            for (const card of cards.slice(0, 12)) {
                const row = document.createElement('div');
                row.className = 'nexus-hunt-result';
                const name = document.createElement('div');
                name.className = 'nexus-hunt-result-name';
                name.textContent = card.title || card.source || card.url || 'Video';
                const meta = document.createElement('div');
                meta.className = 'nexus-hunt-result-meta';
                const quality = Number(card.height) > 0 ? `${card.height}p` : 'Rozlíšenie neoverené';
                meta.textContent = `${quality}${card.source ? ` · ${card.source}` : ''}${card.reason ? ` · ${card.reason}` : ''}`;
                row.append(name, meta);
                if (card.url) {
                    const open = document.createElement('a');
                    open.className = 'nexus-hunt-open-source';
                    open.href = card.url;
                    open.target = '_blank';
                    open.rel = 'noopener noreferrer';
                    open.textContent = 'Otvoriť zdroj';
                    row.appendChild(open);
                }
                results.appendChild(row);
            }
        }
        if (!count) {
            const empty = document.createElement('div');
            empty.className = 'nexus-hunt-empty';
            empty.textContent = 'Nenašla sa potvrdená alternatíva. Skús dôkladné hľadanie alebo povoľ porovnanie obrazu.';
            results.appendChild(empty);
        }
        results.hidden = false;
    }

    async function startQualityHunt(container, video, mode, allowVisualSearch) {
        if (container.dataset.huntRunning === 'true') return;
        container.dataset.huntRunning = 'true';
        const run = (Number(container.dataset.huntRun) || 0) + 1;
        container.dataset.huntRun = String(run);
        const button = container.querySelector('.nexus-hunt-start');
        const status = container.querySelector('.nexus-hunt-status');
        const results = container.querySelector('.nexus-hunt-results');
        button.disabled = true;
        button.textContent = 'Hľadám…';
        container.querySelector('.nexus-hunt-stop').hidden = false;
        status.textContent = 'Posielam informácie o videu do Nexus.';
        results.replaceChildren();
        results.hidden = true;
        const title = String(video.getAttribute('data-title') || video.getAttribute('title') ||
            document.querySelector('meta[property="og:title"]')?.content || document.querySelector('h1')?.textContent || document.title || 'Video').trim().slice(0, 1000);
        const frame = captureHuntFrame(video);
        const payload = {
            title: title.length >= 2 ? title : 'Video',
            page_url: location.href,
            duration_sec: Number.isFinite(video.duration) ? Math.max(0, video.duration) : 0,
            height: Number(video.videoHeight) || 0,
            thumbnail_url: video.poster || '',
            poster_url: video.poster || '',
            frames: frame && frame.length <= 2_800_000 ? [frame] : [],
            frame_jpeg: frame.length <= 2_800_000 ? frame : '',
            mode: mode === 'deep' ? 'deep' : 'quick',
            allow_visual_search: !!allowVisualSearch,
        };
        const start = await sendHuntMessage({ type: 'QUALITY_HUNT_START', port: 8001, payload });
        if (container.dataset.huntRun !== String(run)) {
            if (start.ok && start.data?.job_id) await sendHuntMessage({ type: 'QUALITY_HUNT_CANCEL', jobId: start.data.job_id, baseUrl: start.baseUrl || '' });
            return;
        }
        if (!start.ok || !start.data?.job_id) {
            status.textContent = `Nexus nespustil hľadanie: ${start.error || 'chýba ID úlohy'}`;
            button.disabled = false;
            button.textContent = 'Skúsiť znova';
            container.querySelector('.nexus-hunt-stop').hidden = true;
            container.dataset.huntRunning = 'false';
            return;
        }
        const jobId = start.data.job_id;
        const baseUrl = start.baseUrl;
        container.dataset.huntJobId = jobId;
        container.dataset.huntBaseUrl = baseUrl || '';
        const deadline = Date.now() + (payload.mode === 'deep' ? 120000 : 60000);
        let completed = false;
        try {
            while (Date.now() < deadline && container.dataset.huntRun === String(run)) {
                const poll = await sendHuntMessage({ type: 'QUALITY_HUNT_POLL', jobId, baseUrl }, 15000);
                if (!poll.ok) {
                    status.textContent = `Spojenie s Nexus sa prerušilo: ${poll.error}`;
                    await new Promise(resolve => setTimeout(resolve, 1200));
                    continue;
                }
                const job = poll.data || {};
                status.textContent = job.progress?.message || (job.status === 'running' ? 'Prehľadávam zdroje…' : 'Vyhodnocujem zhody…');
                appendHuntResults(container, job.groups || {});
                if (['done', 'partial', 'error', 'cancelled'].includes(job.status)) {
                    completed = true;
                    if (job.status === 'error') status.textContent = _t(`Hľadanie zlyhalo: ${job.error || 'chyba servera'}`, `Search failed: ${job.error || 'server error'}`);
                    else status.textContent = job.status === 'cancelled' ? 'Hľadanie bolo zastavené.' : 'Hľadanie dokončené.';
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 900));
            }
        } finally {
            if (container.dataset.huntRun === String(run)) {
                if (!completed) status.textContent = 'Časový limit vypršal. Skús hľadanie spustiť znova.';
                container.dataset.huntRunning = 'false';
                button.disabled = false;
                button.textContent = 'Hľadať znova';
                container.querySelector('.nexus-hunt-stop').hidden = true;
            }
        }
    }

    async function handleImport(video, port, selectedQualityUrl = null) {
        showToast(`Preparing import for port ${port}...`);

        chrome.runtime.sendMessage({ type: 'GET_CAPTURED_STREAM' }, (response) => {
            let streamUrl = response?.streamUrl;

            if (selectedQualityUrl) {
                streamUrl = selectedQualityUrl;
            } else if (!streamUrl) {
                streamUrl = video.currentSrc || video.src;
            }

            if (!streamUrl || streamUrl.startsWith('blob:')) {
                if (!streamUrl.startsWith('blob:')) {
                    showToast('Could not resolve direct video link.', true);
                    return;
                }
            }

            const metadata = {
                title: document.title.split(' - ')[0].trim(),
                sourceUrl: window.location.href,
                duration: Math.round(video.duration) || 0,
                thumbnail: findThumbnail()
            };

            // Site-specific overrides
            if (window.location.hostname.includes('pornonahobka.icu')) {
                const yaTitle = document.querySelector('meta[property="og:title"]')?.content;
                if (yaTitle) metadata.title = yaTitle;
                const yaThumb = document.querySelector('meta[property="ya:ovs:poster"]')?.content;
                if (yaThumb) metadata.thumbnail = yaThumb;
            }

            chrome.runtime.sendMessage({
                type: 'IMPORT_VIDEO',
                streamUrl,
                port,
                metadata
            }, (res) => {
                if (res && res.success) {
                    showToast(`Successfully imported to port ${port}!`);
                } else {
                    showToast(`Failed: ${res?.error || 'Unknown error'}`, true);
                }
            });
        });
    }

    function findThumbnail() {
        const ogImage = document.querySelector('meta[property="og:image"]')?.content;
        if (ogImage) return ogImage;
        const poster = document.querySelector('video')?.poster;
        if (poster) return poster;
        return null;
    }

    function showToast(text, isError = false) {
        let toastContainer = document.getElementById('nexus-toast-container');
        if (!toastContainer) {
            toastContainer = document.createElement('div');
            toastContainer.id = 'nexus-toast-container';
            toastContainer.style.cssText = 'position: fixed; bottom: 20px; right: 20px; display: flex; flex-direction: column; gap: 10px; z-index: 999999; pointer-events: none; align-items: flex-end;';
            document.body.appendChild(toastContainer);
        }

        const toast = document.createElement('div');
        toast.className = `nexus-toast ${isError ? 'error' : 'success'}`;
        toast.style.pointerEvents = 'auto';
        toast.style.position = 'relative';
        toast.style.bottom = 'auto';
        toast.style.right = 'auto';
        
        const iconSvg = isError 
            ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`
            : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;

        toast.innerHTML = `
            <div class="nexus-toast-icon">${iconSvg}</div>
            <div class="nexus-toast-text">${text}</div>
        `;
        
        toastContainer.appendChild(toast);
        setTimeout(() => toast.classList.add('fade-out'), 2700);
        setTimeout(() => {
            toast.remove();
            if (toastContainer.childNodes.length === 0) toastContainer.remove();
        }, 3000);
    }

    function scanVideos() {
        const videos = document.querySelectorAll('video');
        videos.forEach(video => {
            if (video.duration && video.duration < MIN_DURATION) return;
            if (isNaN(video.duration)) {
                video.addEventListener('loadedmetadata', () => {
                    if (video.duration >= MIN_DURATION) createOverlay(video);
                }, { once: true });
            } else {
                createOverlay(video);
            }
        });
    }

    scanVideos();
    setInterval(scanVideos, SCAN_INTERVAL);

    // ---- VK native site: Track Source button ----
    function scanVKCards() {
        if (!window.location.hostname.includes('vk.com') && !window.location.hostname.includes('vkvideo.ru')) return;
        const cards = document.querySelectorAll('.post_video, .video_item, .VideoCard__container, .VideoCard__info');
        cards.forEach(card => {
            if (card.dataset.nexusVkScanned) return;
            card.dataset.nexusVkScanned = 'true';

            const authorLink = card.querySelector('.author, .VideoCard__author, a[href*="/club"], a[href*="/public"], a[href*="/video/@"]');
            if (authorLink && authorLink.href) {
                const name = authorLink.innerText.trim() || authorLink.getAttribute('title') || 'VK Source';
                const url = authorLink.href;
                
                const btn = document.createElement('button');
                btn.innerText = '🎯 Track Source';
                btn.style.cssText = 'position: absolute; top: 5px; right: 5px; z-index: 100; background: #4a76a8; color: white; border: none; padding: 2px 6px; border-radius: 4px; font-size: 10px; cursor: pointer;';
                btn.onclick = (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    chrome.runtime.sendMessage({
                        type: 'VK_ADD_SOURCE',
                        source: { name, url, source_type: 'group' },
                        port: 8001
                    }, (res) => {
                        btn.innerText = (res && res.success) ? '✓ Tracked' : '✗ Error';
                        btn.style.background = (res && res.success) ? '#2ecc71' : '#e74c3c';
                    });
                };
                if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
                card.appendChild(btn);
            }
        });
    }

    setInterval(scanVKCards, SCAN_INTERVAL);

    // ---- Yandex Video: Group Discovery ----
    function scanYandexCards() {
        if (!window.location.hostname.includes('yandex.ru') && !window.location.hostname.includes('ya.ru')) return;
        if (!window.location.pathname.includes('/video') && !window.location.pathname.includes('/search')) return;

        // Inject Side Floating Control Panel if not present
        let sidePanel = document.getElementById('nexus-yandex-sidepanel');
        if (!sidePanel) {
            sidePanel = document.createElement('div');
            sidePanel.id = 'nexus-yandex-sidepanel';
            sidePanel.style.cssText = 'position:fixed;top:100px;right:20px;z-index:2147483647;background:rgba(15,23,42,0.95);backdrop-filter:blur(8px);border:1px solid #3b82f6;border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px;box-shadow:0 10px 30px rgba(0,0,0,0.6);color:white;font-family:sans-serif;transition:all 0.3s ease;width:44px;height:44px;overflow:hidden;';
            sidePanel.innerHTML = `
                <div id="nexus-side-toggle" style="cursor:pointer;display:flex;align-items:center;justify-content:center;min-height:22px;color:#38bdf8;font-weight:bold;font-size:20px;">
                    <span id="nexus-side-icon">🌟</span>
                    <span id="nexus-side-title" style="display:none;margin-left:10px;font-size:14px;white-space:nowrap;">Nexus Discovery</span>
                </div>
                <div id="nexus-side-content" style="display:none;flex-direction:column;gap:8px;margin-top:10px;">
                    <button id="nexus-ydx-filter" style="background:#2563eb;color:white;border:none;padding:8px;border-radius:6px;cursor:pointer;font-weight:bold;font-size:11px;text-align:left;white-space:nowrap;">🔍 Filtrovať iba VK</button>
                    <button id="nexus-ydx-follow-sel" style="background:#059669;color:white;border:none;padding:8px;border-radius:6px;cursor:pointer;font-weight:bold;font-size:11px;text-align:left;white-space:nowrap;">📥 Vybrané (<span id="nexus-ydx-cnt">0</span>)</button>
                    <button id="nexus-ydx-follow-all" style="background:#7c3aed;color:white;border:none;padding:8px;border-radius:6px;cursor:pointer;font-weight:bold;font-size:11px;text-align:left;white-space:nowrap;">📥 Všetky na stránke</button>
                    <div id="nexus-ydx-status" style="color:#94a3b8;font-size:10px;text-align:center;margin-top:4px;min-height:14px;"></div>
                </div>
            `;
            document.body.appendChild(sidePanel);

            let isExpanded = false;
            const toggle = (force) => {
                isExpanded = force !== undefined ? force : !isExpanded;
                sidePanel.style.width = isExpanded ? '180px' : '44px';
                sidePanel.style.height = isExpanded ? '195px' : '44px';
                document.getElementById('nexus-side-title').style.display = isExpanded ? 'block' : 'none';
                document.getElementById('nexus-side-content').style.display = isExpanded ? 'flex' : 'none';
                document.getElementById('nexus-side-icon').innerText = isExpanded ? '❌' : '🌟';
            };

            document.getElementById('nexus-side-toggle').onclick = () => toggle();
            sidePanel.onmouseenter = () => toggle(true);
            sidePanel.onmouseleave = () => toggle(false);

            // Filter Action
            document.getElementById('nexus-ydx-filter').onclick = (e) => {
                e.stopPropagation();
                const url = new URL(window.location.href);
                let text = (url.searchParams.get('text') || '')
                    .replace(/\bvkvideo\b/gi, '')
                    .replace(/\bsite:vk\.com\b/gi, '')
                    .replace(/\bsite:vkvideo\.ru\b/gi, '')
                    .replace(/\(site:vk\.com\s*\|\s*site:vkvideo\.ru\)/gi, '')
                    .trim();
                
                // Always use the powerful site: operators as requested
                url.searchParams.set('text', text + ' (site:vk.com | site:vkvideo.ru)');
                window.location.href = url.toString();
            };

            // Follow Selected
            document.getElementById('nexus-ydx-follow-sel').onclick = async (e) => {
                e.stopPropagation();
                const checked = [...document.querySelectorAll('.nexus-ydx-cb:checked')];
                if (!checked.length) { alert('Označ najprv nejaké skupiny!'); return; }
                const st = document.getElementById('nexus-ydx-status');
                let n = 0;
                for (const cb of checked) {
                    const d = JSON.parse(cb.dataset.vkSource);
                    await new Promise(r => chrome.runtime.sendMessage({type:'VK_ADD_SOURCE',source:d,port:8001}, r));
                    cb.checked = false; n++;
                    st.innerText = `Pridáva... ${n}/${checked.length}`;
                    const ovl = cb.parentElement;
                    if (ovl) { const b = ovl.querySelector('.nexus-ydx-btn'); if(b){b.innerText='✓ Pridaná';b.style.background='#10b981';} }
                }
                document.getElementById('nexus-ydx-cnt').innerText = '0';
                st.innerText = 'Hotovo!'; setTimeout(() => st.innerText = '', 2000);
            };

            // Follow All
            document.getElementById('nexus-ydx-follow-all').onclick = async (e) => {
                e.stopPropagation();
                const btns = [...document.querySelectorAll('.nexus-ydx-btn')].filter(b => !b.innerText.includes('✓'));
                if (!btns.length) { alert(_t('Žiadne nové VK skupiny nájdené!', 'No new VK groups found!')); return; }
                const st = document.getElementById('nexus-ydx-status');
                for (let i = 0; i < btns.length; i++) {
                    btns[i].click();
                    st.innerText = `${i+1}/${btns.length}`;
                    await new Promise(r => setTimeout(r, 350));
                }
                st.innerText = 'Hotovo!'; setTimeout(() => st.innerText = '', 2000);
            };
        }

        // ---- Strategy: find VK links, walk UP DOM to find card boundary ----
        document.querySelectorAll('a[href]').forEach(a => {
            if (a.dataset.nexusVkDone) return;
            const href = a.href || '';
            
            // Check if it's a VK video, clip, club, public or user profile
            const isVkLink = (
                href.includes('vk.com/video') || href.includes('vkvideo.ru/video') ||
                href.includes('vk.com/clip') || href.includes('vkvideo.ru/clip') ||
                href.includes('vk.com/club') || href.includes('vk.com/public') ||
                href.includes('vk.com/id') || /vk\.com\/[^/?#]+$/.test(href)
            );
            
            if (!isVkLink) return;
            // Exclude common VK internal links
            if (href.includes('vk.com/app') || href.includes('vk.com/feed') || href.includes('vk.com/im')) return;
            
            a.dataset.nexusVkDone = '1';

            // Walk up to find a card-sized container (>60px tall, >120px wide)
            let card = a.parentElement;
            for (let i = 0; i < 12; i++) {
                if (!card || card === document.body) break;
                const r = card.getBoundingClientRect();
                if (r.height > 60 && r.width > 120) break;
                card = card.parentElement;
            }
            if (!card || card === document.body) return;
            if (card.dataset.nexusYdxDone) return;
            card.dataset.nexusYdxDone = '1';

            // Extract owner ID → group URL
            const vidMatch = href.match(/\/(?:video|clip)(-?\d+)[_-](\d+)/);
            let groupUrl = '';
            if (vidMatch) {
                const oid = parseInt(vidMatch[1]);
                groupUrl = oid < 0 ? `https://vk.com/club${Math.abs(oid)}` : `https://vk.com/id${oid}`;
            } else {
                groupUrl = href.split('?')[0];
            }

            // Extract group name from "› Channel" pattern in leaf text nodes
            let groupName = '';
            const leafTexts = [...card.querySelectorAll('*')]
                .filter(el => el.children.length === 0 && el.innerText)
                .map(el => el.innerText.trim())
                .filter(t => t.length > 2 && t.length < 80);
            for (const t of leafTexts) {
                if (t.includes('›') || t.includes('>')) {
                    const parts = t.split(/[›>]/);
                    const candidate = parts[parts.length - 1].trim();
                    if (candidate.length > 2 && candidate.length < 60) { groupName = candidate; break; }
                }
            }
            if (!groupName && vidMatch) groupName = `VK klub ${Math.abs(parseInt(vidMatch[1]))}`;
            if (!groupName) groupName = 'VK Source';

            const sourceData = { name: groupName, url: groupUrl, source_type: 'group' };

            if (getComputedStyle(card).position === 'static') card.style.position = 'relative';

            // Overlay with checkbox + button
            const overlay = document.createElement('div');
            overlay.className = 'nexus-ydx-overlay';
            overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:9998;';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'nexus-ydx-cb';
            cb.dataset.vkSource = JSON.stringify(sourceData);
            cb.style.cssText = 'position:absolute;top:8px;left:8px;width:22px;height:22px;cursor:pointer;pointer-events:all;accent-color:#3b82f6;z-index:9999;';
            cb.onclick = e => e.stopPropagation();
            cb.onchange = e => {
                e.stopPropagation();
                document.getElementById('nexus-ydx-cnt').innerText = document.querySelectorAll('.nexus-ydx-cb:checked').length;
            };

            const btn = document.createElement('button');
            btn.className = 'nexus-ydx-btn';
            btn.innerText = '🎯 Sledovať';
            btn.title = groupUrl;
            btn.style.cssText = 'position:absolute;bottom:6px;right:6px;background:#059669;color:white;border:none;padding:4px 10px;border-radius:5px;font-size:11px;font-weight:bold;cursor:pointer;pointer-events:all;z-index:9999;box-shadow:0 2px 6px rgba(0,0,0,0.6);';
            btn.onclick = e => {
                e.stopPropagation(); e.preventDefault();
                btn.innerText = '⏳';
                chrome.runtime.sendMessage({type:'VK_ADD_SOURCE',source:sourceData,port:8001}, res => {
                    btn.innerText = (res && res.success) ? _t('✓ Pridaná', '✓ Added') : _t('✗ Chyba', '✗ Error');
                    btn.style.background = (res && res.success) ? '#10b981' : '#ef4444';
                });
            };

            overlay.appendChild(cb);
            overlay.appendChild(btn);
            card.appendChild(overlay);
        });
    }

    setInterval(scanYandexCards, SCAN_INTERVAL);

})();
