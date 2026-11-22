/* Shared, per-player activity journal. Playback is confirmed by media time,
   never by a successful HTTP response or canplay alone. */
(() => {
    const sessions = new WeakMap();
    const activeMedia = new Set();
    const latestCards = new Map();
    function renderMetrics(session) {
        if (!session.metrics || !session.metricsLabel) return;
        const data = session.metrics.snapshot();
        const seconds = value => value === null ? '—' : `${(value / 1000).toFixed(1)} s`;
        const perMinute = data.observed_ms > 0 ? (data.stall_ms * 60 / data.observed_ms).toFixed(1) : '—';
        const text = `Štart ${seconds(data.startup_ms)} · Zaseknutia ${data.stalls} / ${seconds(data.stall_ms)} (${perMinute} s/min) · Obnova ${seconds(data.recovery_ms)} · Pozadie ≤ ${session.backgroundLimit ?? '—'}`;
        if (session.metricsLabel.textContent !== text) session.metricsLabel.textContent = text;
    }
    function reportPlayback(media, session, phase) {
        if (!session.metrics) return;
        session.phase = phase;
        renderMetrics(session);
        clearTimeout(session.telemetryTimer);
        const owner = session.owner;
        session.telemetrySequence = (session.telemetrySequence || 0) + 1;
        const body = JSON.stringify({session_id: session.telemetryId, phase, sequence: session.telemetrySequence,
            video_id: Number(session.id) > 0 ? Number(session.id) : 0, metrics: session.metrics.snapshot()});
        fetch('/api/v1/playback/activity', {method: 'POST', headers: {'Content-Type': 'application/json'},
            body, keepalive: true, signal: AbortSignal.timeout(3000)})
            .then(response => response.ok ? response.json() : null)
            .then(data => {
                if (data && owner === session.owner) { session.backgroundLimit = data.background_limit; renderMetrics(session); }
            }).catch(() => {});
        if (['loading', 'buffering', 'recovering', 'playing'].includes(phase) && !session.stopped) {
            session.telemetryTimer = setTimeout(() => {
                if (!media.isConnected || session.stopped || owner !== session.owner) return;
                reportPlayback(media, session, session.phase);
            }, 5000);
        }
    }
    const isCardPreview = (media) => {
        const classes = ` ${String(media?.className || '')} `;
        if (/\s(?:static-thumb|gif-thumb|video-preview|local-thumb-video|flow-thumb|ws-trailer-video)\s/.test(classes)) return true;
        return !!media?.closest?.('.thumb-wrapper, .v1-thumb, .flow-video-wrapper, .ws-thumb-wrapper');
    };
    const style = document.createElement('style');
    style.textContent = `.nexus-playback-activity{background:#101820;color:#e4edf7;border:1px solid #557080;border-radius:8px;padding:10px;margin:6px 0;font:13px/1.5 system-ui;position:relative;z-index:2;max-height:180px;overflow:auto}.nexus-step-clock{color:#93c5fd;font-variant-numeric:tabular-nums;white-space:nowrap}.nexus-playback-activity summary{cursor:pointer;font-weight:700}.nexus-playback-activity ol{padding-left:22px;margin:6px 0}.nexus-playback-activity[data-state="error"]{border-color:#f87171}.nexus-playback-activity[data-state="playing"]{border-color:#84cc16}.nexus-card-activity{display:block;padding:5px 8px;font:12px/1.4 system-ui;color:#bde3ff;background:#13232d}.video-modal .modal-content{max-height:94vh;overflow-y:auto}.video-modal .modal-player-wrap{height:min(52vh,620px);aspect-ratio:auto}`;
    document.head.appendChild(style);

    function durationText(milliseconds) {
        const seconds = Math.max(0, milliseconds) / 1000;
        return seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)} min ${(seconds % 60).toFixed(1)} s`;
    }
    function bufferedSeconds(media) {
        try {
            const ranges = media.buffered;
            if (!ranges || !ranges.length) return 0;
            const at = Number(media.currentTime) || 0;
            for (let i = 0; i < ranges.length; i++) {
                if (ranges.start(i) <= at + 0.25 && ranges.end(i) >= at) return ranges.end(i);
            }
            return at;
        } catch {
            return 0;
        }
    }
    function noteBuffer(media, session) {
        const end = bufferedSeconds(media);
        if (end > (session.bufferedEnd || 0) + 0.2) {
            session.bufferedEnd = end;
            session.lastGrowth = Date.now();
            session.lastProgress = Date.now();
        }
        return end;
    }
    function finishStep(session, now = Date.now()) {
        clearTimeout(session.clockTimer);
        if (session.step) session.step.clock.textContent = ` · trvanie ${durationText(now - session.step.started)}`;
    }
    function tickStep(session) {
        if (!session.step) return;
        session.step.clock.textContent = ` · ${session.state === 'loading' ? 'prebieha ' : 'trvanie '}${durationText(Date.now() - session.step.started)}`;
        if (session.state === 'loading' && !session.stopped) session.clockTimer = setTimeout(() => tickStep(session), 1000);
    }
    function update(media, message, state = 'loading') {
        const session = sessions.get(media) || begin(media);
        if (session.last === message) return;
        const now = Date.now();
        finishStep(session, now);
        session.last = message;
        session.state = state;
        session.box.dataset.state = state;
        if (state === 'playing' && session.confirmed) session.box.hidden = true;
        else if (state === 'error') session.box.hidden = false;
        session.summary.textContent = message;
        const row = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = `${new Date().toLocaleTimeString()} — ${message}`;
        const clock = document.createElement('span');
        clock.className = 'nexus-step-clock';
        row.append(label, clock);
        session.step = { clock, started: now };
        tickStep(session);
        session.log.appendChild(row);
        while (session.log.children.length > 40) session.log.firstChild.remove();
        if (session.id) {
            latestCards.set(String(session.id), message);
            if (latestCards.size > 200) latestCards.delete(latestCards.keys().next().value);
            for (const card of document.querySelectorAll('[data-id], [data-video-id]')) {
                if (String(card.dataset.id || card.dataset.videoId) !== String(session.id)) continue;
                let label = card.querySelector('.nexus-card-activity');
                if (!label) { label = document.createElement('span'); label.className = 'nexus-card-activity'; card.appendChild(label); }
                label.textContent = message;
            }
        }
    }
    function begin(media, options = {}) {
        let session = sessions.get(media);
        if (!session) {
            const box = document.createElement('details');
            box.className = 'nexus-playback-activity';
            box.open = true;
            box.setAttribute('aria-live', 'polite');
            const summary = document.createElement('summary');
            const log = document.createElement('ol');
            const metricsLabel = document.createElement('div');
            metricsLabel.className = 'nexus-playback-metrics';
            metricsLabel.setAttribute('style', 'color:#a5d8ff;font-variant-numeric:tabular-nums;margin:5px 0');
            box.append(summary, metricsLabel, log);
            // Outside <video>, so controls and picture-in-picture keep working.
            const wrapper = media.closest('.video-wrapper, .modal-player-wrapper, .modal-player-wrap');
            if (wrapper && wrapper.parentNode) wrapper.parentNode.insertBefore(box, wrapper.nextSibling);
            else media.parentNode.insertBefore(box, media.nextSibling);
            session = { box, summary, log, metricsLabel, last: '', generation: 0, owner: {},
                telemetryId: typeof crypto !== 'undefined' && crypto.randomUUID
                    ? crypto.randomUUID().replaceAll('-', '_') : `p_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                metrics: window.NexusPlaybackMetrics ? new window.NexusPlaybackMetrics(undefined, false) : null };
            sessions.set(media, session);
            activeMedia.add(media);
            for (const event of ['loadstart', 'play', 'playing', 'waiting', 'pause', 'ended', 'seeking', 'timeupdate']) {
                media.addEventListener(event, () => {
                    if (session.stopped || !session.metrics) return;
                    session.metrics.event(event, media);
                    if (event === 'timeupdate') {
                        if (!session.lastMetricsPaint || Date.now() - session.lastMetricsPaint > 1000) {
                            session.lastMetricsPaint = Date.now(); renderMetrics(session);
                        }
                        return;
                    }
                    if (event === 'playing') reportPlayback(media, session, 'playing');
                    else if (event === 'waiting' && !media.paused && !media.seeking) reportPlayback(media, session, 'buffering');
                    else if (event === 'ended') reportPlayback(media, session, 'ended');
                    else if (event === 'pause' && session.confirmed) reportPlayback(media, session, 'paused');
                    else if (event === 'play' || (event === 'loadstart' && session.autoplay === true
                        && (media.currentSrc || media.getAttribute('src')))) reportPlayback(media, session, 'loading');
                });
            }
            for (const [event, message] of Object.entries({
                loadstart: 'NAČÍTAVAM STREAM — pripájam prehrávač k zdroju.',
                loadedmetadata: 'STREAM PRIPRAVENÝ — čakám na obraz a zvuk.',
                canplay: 'PRIPRAVENÉ — čakám na spustenie prehrávania.',
                waiting: 'ČAKÁM NA DÁTA — dopĺňam buffer streamu.',
                stalled: 'ZDROJ NEPOSIELA DÁTA — čakám na obnovenie prenosu.',
                ended: 'PREHRÁVANIE DOKONČENÉ.',
            })) media.addEventListener(event, () => {
                if (session.stopped) return;
                if (event === 'loadstart') {
                    session.confirmed = false;
                    session.ready = false;
                    session.lastProgress = Date.now();
                    session.lastGrowth = Date.now();
                }
                if (event === 'canplay') session.ready = true;
                if (!session.recovering && (media.currentSrc || media.getAttribute('src'))) update(media, message, event === 'ended' ? 'ended' : 'loading');
            });
            media.addEventListener('timeupdate', () => {
                if (session.stopped) return;
                if (media.currentTime >= 1 && !media.paused && !session.confirmed) {
                    session.confirmed = true;
                    session.lastProgress = Date.now();
                    update(media, 'PREHRÁVAM — potvrdená prvá sekunda videa.', 'playing');
                }
                if (!media.paused && media.currentTime > (session.lastMediaTime || 0) + 0.01) session.lastProgress = Date.now();
                session.lastMediaTime = media.currentTime;
            });
            media.addEventListener('progress', () => {
                if (session.stopped) return;
                noteBuffer(media, session);
            });
            media.addEventListener('pause', () => {
                if (session.confirmed && !media.ended) update(media, 'POZASTAVENÉ — video je pripravené.', 'paused');
            });
            media.addEventListener('playing', () => {
                if (session.stopped) return;
                if (session.confirmed) update(media, 'PREHRÁVAM — stream pokračuje.', 'playing');
            });
            media.addEventListener('error', () => {
                if (session.stopped) return;
                if (!media.currentSrc && !media.getAttribute('src')) return;
                const reason = {1:'Načítanie bolo prerušené.',2:'Sieť alebo zdroj odmietol stream.',3:'Prehliadač nedokáže dekódovať video.',4:'Zdroj alebo formát videa nie je podporovaný.'}[media.error?.code] || 'Stream sa nepodarilo načítať.';
                recover(media, reason);
            });
        }
        if (options.reset) {
            session.box.hidden = false;
            clearTimeout(session.telemetryTimer);
            if (!session.metrics || session.id !== options.id || session.stopped) {
                session.metrics = window.NexusPlaybackMetrics ? new window.NexusPlaybackMetrics(undefined, options.autoplay !== false) : null;
            }
            if (options.id !== session.id || options.scope !== session.scope || session.stopped) session.owner = {};
            finishStep(session);
            session.step = null;
            session.generation++;
            if (!options.id || options.id !== session.id) session.log.replaceChildren();
            session.last = '';
            session.confirmed = false;
            session.ready = false;
            session.stopped = false;
            session.recovering = false;
            session.bufferedEnd = 0;
            session.lastMediaTime = 0;
            session.lastGrowth = 0;
        }
        Object.assign(session, options);
        clearTimeout(session.timer);
        if (options.reset) {
            session.lastProgress = Date.now();
            session.lastGrowth = Date.now();
            const generation = session.generation;
            const watchdog = () => {
                if (!media.isConnected || generation !== session.generation) return;
                if (session.state === 'error' && !session.patient) return;
                noteBuffer(media, session);
                const quiet = Date.now() - Math.max(session.lastProgress || 0, session.lastGrowth || 0);
                const loading = media.networkState === 2 && !media.error;
                // Telegram and other slow native files keep their URL while
                // bytes are still arriving. A 35s stall used to discard the
                // buffer and ask the website for a new token.
                const patientLimit = session.patient ? (loading ? 120000 : 90000) : (session.stallTimeout || 35000);
                if (session.patient && !media.paused && quiet < patientLimit) {
                    if (quiet > 20000) update(media, 'ZDROJ EŠTE POSIELA DÁTA — čakám na buffer. Odkaz sa neobnovuje.');
                } else if (!session.recovering && !media.paused && !media.seeking && quiet > patientLimit) {
                    recover(media, session.patient
                        ? 'Stream neposlal ďalšie dáta počas 2 minút.'
                        : 'Stream neposlal ďalšie dáta počas 35 sekúnd.');
                } else if (!media.seeking && !session.patient && !session.confirmed && !session.ready && !session.recovering && session.autoplay !== false && quiet > (session.startTimeout || 60000)) {
                    recover(media, 'Zdroj nedodal prvý obraz v časovom limite.');
                }
                session.timer = setTimeout(watchdog, 5000);
            };
            session.timer = setTimeout(watchdog, 5000);
            update(media, 'PRIPRAVUJEM VIDEO — overujem zdroj a spôsob prehrávania.');
            reportPlayback(media, session, session.autoplay !== false ? 'loading' : 'paused');
        }
        return session;
    }
    async function recover(media, reason) {
        const session = sessions.get(media) || begin(media);
        if (session.recovering) return;
        const sameStream = !!session.patient && !!session.retry;
        const remedy = sameStream
            ? 'RIEŠENIE: pripájam ten istý stream znova, bez nového web tokenu.'
            : session.retry
            ? 'RIEŠENIE: obnovujem odkaz z pôvodného zdroja.'
            : 'RIEŠENIE: otvorte pôvodný zdroj a overte dostupnosť alebo prihlásenie.';
        update(media, `${reason} ${remedy}`, sameStream ? 'loading' : 'error');
        if (!session.retry) return;
        session.recovering = true;
        session.confirmed = false;
        session.metrics?.event('recover', media);
        reportPlayback(media, session, 'recovering');
        const owner = session.owner;
        const recoveryGeneration = session.generation;
        try { await session.retry(reason); }
        catch (error) { if (owner === session.owner && !session.confirmed) {
            update(media, `OBNOVA ZLYHALA — ${error.message}. RIEŠENIE: otvorte zdroj, overte prístup a skúste prehrávanie znova.`, 'error');
            reportPlayback(media, session, 'error');
        } }
        finally { if (owner === session.owner && recoveryGeneration === session.generation) session.recovering = false; }
    }
    function stop(media) {
        const session = sessions.get(media);
        if (session) {
            session.metrics?.event('stop', media);
            reportPlayback(media, session, 'stopped');
            clearTimeout(session.telemetryTimer);
            clearTimeout(session.timer);
            finishStep(session);
            session.generation++;
            session.owner = {};
            session.retry = null;
            session.confirmed = false;
            session.stopped = true;
            update(media, 'PREHRÁVAČ ZATVORENÝ — prehrávanie bolo ukončené.', 'stopped');
        }
    }
    window.NexusPlayback = { begin, update, recover, stop };
    window.addEventListener?.('pagehide', () => {
        for (const media of activeMedia) {
            const session = sessions.get(media);
            if (!session?.metrics || session.stopped || !session.phase) continue;
            session.telemetrySequence = (session.telemetrySequence || 0) + 1;
            const body = JSON.stringify({session_id: session.telemetryId, phase: 'stopped', sequence: session.telemetrySequence,
                video_id: Number(session.id) > 0 ? Number(session.id) : 0, metrics: session.metrics.snapshot()});
            navigator.sendBeacon('/api/v1/playback/activity', new Blob([body], {type:'application/json'}));
        }
    });
    const frames = new WeakSet();
    const framePanels = new Map();
    const scan = () => {
        for (const media of activeMedia) {
            if (media.isConnected) continue;
            stop(media);
            sessions.get(media)?.box.remove();
            sessions.delete(media);
            activeMedia.delete(media);
        }
        for (const [frame, box] of framePanels) {
            if (!frame.isConnected) { box.remove(); framePanels.delete(frame); }
        }
        document.querySelectorAll('video').forEach(media => {
            // Gallery cards contain muted thumbnail/hover <video> elements.  They
            // are not players and a journal inserted beside them becomes a
            // normal-flow block inside the thumbnail, leaving a large empty
            // strip above the image (and may be duplicated per card).
            if (isCardPreview(media) || media.closest('#nuss-overlay')) return;
            if (!sessions.has(media)) begin(media);
        });
        document.querySelectorAll('iframe[allow*="autoplay"]').forEach(frame => {
            if (frames.has(frame) || frame.closest('#nuss-overlay')) return;
            frames.add(frame);
            const box = document.createElement('details');
            box.className = 'nexus-playback-activity';
            box.open = true;
            const summary = document.createElement('summary');
            summary.textContent = 'NAČÍTAVAM PREHRÁVAČ ZDROJA — poskytovateľ spravuje stream a token.';
            const detail = document.createElement('div');
            detail.textContent = 'Čakám na odpoveď vloženého prehrávača.';
            box.append(summary, detail);
            const wrapper = frame.closest('.video-wrapper');
            const anchor = wrapper || frame;
            anchor.parentNode.insertBefore(box, anchor.nextSibling);
            framePanels.set(frame, box);
            frame.addEventListener('load', () => {
                summary.textContent = 'PREHRÁVAČ ZDROJA NAČÍTANÝ — čakám na spustenie videa v jeho ovládaní.';
                detail.textContent = 'Prehliadač neposkytuje Nexusu čas prehrávania cudzieho iframe. Pri chybe otvorte pôvodný zdroj a overte prihlásenie / dostupnosť.';
            });
            frame.addEventListener('error', () => {
                box.dataset.state = 'error';
                summary.textContent = 'PREHRÁVAČ ZDROJA SA NENAČÍTAL.';
                detail.textContent = 'Riešenie: otvorte pôvodný zdroj a overte dostupnosť / prihlásenie.';
            });
        });
        // Gallery polling / virtualization can recreate a card during playback.
        for (const card of document.querySelectorAll('[data-id], [data-video-id]')) {
            const message = latestCards.get(String(card.dataset.id || card.dataset.videoId));
            let label = card.querySelector('.nexus-card-activity');
            if (!message) { if (label) label.remove(); continue; }
            if (!label) { label = document.createElement('span'); label.className = 'nexus-card-activity'; card.appendChild(label); }
            if (label.textContent !== message) label.textContent = message;
        }
    };
    // Text updates (clock, progress, journals) cannot introduce a player.
    // Ignore them and batch structural changes instead of scanning the entire
    // dashboard after every reactive update, including our own log writes.
    let scanTimer = null;
    const relevantNode = node => node.nodeType === 1 && (
        node.matches('video, iframe, [data-id], [data-video-id]') ||
        node.querySelector('video, iframe, [data-id], [data-video-id]')
    );
    new MutationObserver(records => {
        if (scanTimer !== null || !records.some(record =>
            [...record.addedNodes, ...record.removedNodes].some(relevantNode))) return;
        scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 100);
    }).observe(document.documentElement, { childList: true, subtree: true });
    scan();
})();
