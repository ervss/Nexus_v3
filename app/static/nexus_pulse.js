/* ============================================================
   NEXUS PULSE — live system status strip + haptics (A1/A6)
   ------------------------------------------------------------
   Replaces the text log console with a compact, scannable
   "system vitals" pill (bottom-left). Expands into a panel
   showing live state per domain (adaptive rate limiter),
   scheduler jobs and health sweeps — fed by NexusBus topics.

   Self-contained: injects its own DOM + styles, no Alpine.
   ============================================================ */
(function () {
    'use strict';
    if (!window.NexusBus) return;

    // ---------- haptics ----------
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    function buzz(pattern) {
        if (!reducedMotion && navigator.vibrate) navigator.vibrate(pattern);
    }
    window.NexusHaptics = {
        tick: () => buzz(8),            // confirmation
        warn: () => buzz([20, 40, 20]), // attention
        fail: () => buzz([40, 60, 40]), // error
    };

    // ---------- state ----------
    const domains = new Map();   // domain -> {delay, state, failures, ts}
    const jobs = new Map();      // job_id -> {state, run_count, desc, ts}
    let health = null;           // {checked,total,working,broken,state}
    let lastError = null;

    // ---------- DOM ----------
    const style = document.createElement('style');
    style.textContent = `
        #nx-pulse { position: fixed; left: 16px; bottom: 16px; z-index: 99990;
            font: 12px/1.45 system-ui, sans-serif; color: var(--nx-text, #eee); }
        #nx-pulse .nx-pill { display: flex; align-items: center; gap: 8px;
            background: var(--nx-surface, #1d1d28); border: 1px solid var(--nx-border, #3a3a4a);
            border-radius: 999px; padding: 7px 14px; cursor: pointer; user-select: none;
            box-shadow: 0 6px 24px rgb(0 0 0 / .45);
            transition: transform var(--nx-dur-fast, .14s) var(--nx-ease-spring, ease); }
        #nx-pulse .nx-pill:active { transform: scale(.95); }
        #nx-pulse .nx-dot { width: 8px; height: 8px; border-radius: 50%;
            background: var(--nx-ok, #41d68a); transition: background .3s; }
        #nx-pulse .nx-dot[data-state="warn"]  { background: var(--nx-warn, #e8b33e); }
        #nx-pulse .nx-dot[data-state="error"] { background: var(--nx-error, #e35050);
            animation: nx-pulse-blink 1s infinite; }
        @keyframes nx-pulse-blink { 50% { opacity: .35; } }
        #nx-pulse .nx-panel { display: none; position: absolute; left: 0; bottom: 44px;
            width: 320px; max-height: 50vh; overflow-y: auto;
            background: var(--nx-surface, #1d1d28); border: 1px solid var(--nx-border, #3a3a4a);
            border-radius: var(--nx-radius-lg, 16px); padding: 12px;
            box-shadow: 0 12px 40px rgb(0 0 0 / .55); }
        #nx-pulse.open .nx-panel { display: block; }
        #nx-pulse h4 { margin: 8px 0 4px; font-size: 10px; letter-spacing: .12em;
            text-transform: uppercase; color: var(--nx-text-dim, #999); }
        #nx-pulse .nx-row { display: flex; justify-content: space-between; gap: 8px;
            padding: 3px 0; border-bottom: 1px solid rgb(255 255 255 / .04); }
        #nx-pulse .nx-row b { font-weight: 600; max-width: 170px; overflow: hidden;
            text-overflow: ellipsis; white-space: nowrap; }
        #nx-pulse .nx-tag { font-size: 10px; padding: 1px 8px; border-radius: 999px;
            background: rgb(255 255 255 / .07); }
        #nx-pulse .nx-tag.ok        { color: var(--nx-ok, #41d68a); }
        #nx-pulse .nx-tag.warn      { color: var(--nx-warn, #e8b33e); }
        #nx-pulse .nx-tag.throttled { color: var(--nx-throttled, #e08743); }
        #nx-pulse .nx-tag.error     { color: var(--nx-error, #e35050); }
        #nx-pulse .nx-bar { height: 4px; border-radius: 2px; margin-top: 4px;
            background: rgb(255 255 255 / .08); overflow: hidden; }
        #nx-pulse .nx-bar i { display: block; height: 100%; width: 0;
            background: var(--nx-working, #4db8e8); transition: width .4s; }
        #nx-pulse .nx-empty { color: var(--nx-text-dim, #888); padding: 4px 0; }
    `;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'nx-pulse';
    root.innerHTML = `
        <div class="nx-panel"></div>
        <div class="nx-pill" title="Nexus system pulse">
            <span class="nx-dot"></span><span class="nx-label">Systém OK</span>
        </div>`;
    document.body.appendChild(root);
    const panel = root.querySelector('.nx-panel');
    const dot = root.querySelector('.nx-dot');
    const label = root.querySelector('.nx-label');
    root.querySelector('.nx-pill').addEventListener('click', () => {
        root.classList.toggle('open');
        window.NexusHaptics.tick();
        if (root.classList.contains('open')) render();
    });

    // ---------- rendering ----------
    function tag(state) {
        const cls = { recovering: 'ok', executed: 'ok', completed: 'ok', started: 'ok',
                      running: 'warn', missed: 'warn', throttled: 'throttled', error: 'error' }[state] || 'ok';
        return `<span class="nx-tag ${cls}">${state}</span>`;
    }

    function render() {
        if (!root.classList.contains('open')) return;
        let html = '';

        html += '<h4>Domény (adaptívny limiter)</h4>';
        if (domains.size === 0) html += '<div class="nx-empty">Zatiaľ žiadna aktivita</div>';
        for (const [d, s] of Array.from(domains).slice(-8)) {
            html += `<div class="nx-row"><b>${d}</b>
                <span>${(s.delay ?? 0).toFixed(1)}s ${tag(s.state)}</span></div>`;
        }

        html += '<h4>Naplánované úlohy</h4>';
        if (jobs.size === 0) html += '<div class="nx-empty">Žiadne behy v tejto relácii</div>';
        for (const [id, j] of Array.from(jobs).slice(-8)) {
            html += `<div class="nx-row"><b title="${j.desc || ''}">${id}</b>
                <span>#${j.run_count ?? 0} ${tag(j.state)}</span></div>`;
        }

        if (health) {
            const pct = health.total ? Math.round(100 * health.checked / health.total) : 0;
            html += `<h4>Kontrola liniek</h4>
                <div class="nx-row"><b>${health.checked}/${health.total}</b>
                <span>✓${health.working} ✗${health.broken} ${tag(health.state)}</span></div>
                <div class="nx-bar"><i style="width:${pct}%"></i></div>`;
        }
        panel.innerHTML = html;
    }

    function updatePill() {
        const throttledCount = Array.from(domains.values()).filter(s => s.state === 'throttled').length;
        if (lastError && Date.now() - lastError < 60000) {
            dot.dataset.state = 'error';
            label.textContent = 'Chyba v systéme';
        } else if (throttledCount > 0) {
            dot.dataset.state = 'warn';
            label.textContent = `Škrtenie: ${throttledCount} domén`;
        } else {
            dot.dataset.state = 'ok';
            label.textContent = 'Systém OK';
        }
    }

    // ---------- bus wiring ----------
    NexusBus.on('ratelimit.*', ev => {
        const domain = (ev.entity || '').replace(/^domain:/, '');
        domains.set(domain, { delay: ev.metrics.delay, state: ev.state,
                              failures: ev.metrics.failure_count, ts: ev.ts });
        if (ev.state === 'throttled') window.NexusHaptics.warn();
        updatePill(); render();
    });

    NexusBus.on('job.state', ev => {
        const id = (ev.entity || '').replace(/^job:/, '');
        jobs.set(id, { state: ev.state, run_count: ev.metrics.run_count,
                       desc: ev.metrics.description, ts: ev.ts });
        if (ev.state === 'error') { lastError = Date.now(); window.NexusHaptics.fail(); }
        updatePill(); render();
    });

    NexusBus.on('health.progress', ev => {
        health = { state: ev.state, ...ev.metrics };
        updatePill(); render();
    });
})();
