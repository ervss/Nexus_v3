/**
 * Live Header Diagnostics Widget (NexusHealthWidget).
 * Polls /api/v1/system/stats, /api/v1/playback/metrics, and
 * /api/extractors/circuit-breaker when the tab is visible and lets the user
 * inspect source health or reset tripped domain circuit breakers in 1 click.
 */
(function (global) {
    'use strict';

    const POLL_INTERVAL_MS = 30000;
    let pollTimer = null;
    let popoverOpen = false;

    function createStyles() {
        if (document.getElementById('nx-hdr-health-style')) return;
        const style = document.createElement('style');
        style.id = 'nx-hdr-health-style';
        style.textContent = `
            .nx-hdr-pill {
                display: inline-flex; align-items: center; gap: 7px;
                padding: 5px 11px; border-radius: 999px;
                background: rgba(24, 24, 37, 0.85);
                border: 1px solid rgba(148, 163, 184, 0.22);
                color: #e2e8f0; font-size: 11px; font-weight: 600;
                cursor: pointer; user-select: none; position: relative;
                transition: border-color .2s, background .2s;
            }
            .nx-hdr-pill:hover { border-color: rgba(167, 139, 250, 0.6); background: rgba(30, 30, 48, 0.95); }
            .nx-hdr-dot { width: 7px; height: 7px; border-radius: 50%; background: #34d399; flex-shrink: 0; }
            .nx-hdr-dot.warn { background: #fbbf24; }
            .nx-hdr-dot.err { background: #f87171; }
            .nx-hdr-pop {
                display: none; position: fixed; top: 58px; right: 18px; z-index: 99995;
                width: 340px; max-height: 70vh; overflow-y: auto;
                background: #141422; border: 1px solid rgba(167, 139, 250, 0.35);
                border-radius: 14px; padding: 14px; color: #e2e8f0;
                box-shadow: 0 18px 48px rgba(0, 0, 0, 0.6); font-size: 12px;
            }
            .nx-hdr-pop.open { display: block; }
            .nx-hdr-pop h5 { margin: 10px 0 6px; font-size: 10px; text-transform: uppercase; letter-spacing: .09em; color: #94a3b8; }
            .nx-hdr-pop h5:first-child { margin-top: 0; }
            .nx-hdr-kv { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,.06); gap: 8px; }
            .nx-hdr-btn {
                margin-top: 6px; padding: 4px 10px; border-radius: 8px; border: 1px solid rgba(167,139,250,.4);
                background: rgba(139,92,246,.2); color: #ddd6fe; font-size: 11px; font-weight: 600; cursor: pointer;
            }
            .nx-hdr-btn:hover { background: rgba(139,92,246,.35); }
        `;
        document.head.appendChild(style);
    }

    async function fetchJson(url) {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return null;
        return res.json().catch(() => null);
    }

    function mount() {
        if (typeof document === 'undefined') return;
        const container =
            document.querySelector('.v1-header-actions') ||
            document.querySelector('.top-actions') ||
            document.querySelector('.v1-header');
        if (!container || document.getElementById('nx-hdr-health-pill')) return;

        createStyles();

        const pill = document.createElement('button');
        pill.type = 'button';
        pill.id = 'nx-hdr-health-pill';
        pill.className = 'nx-hdr-pill';
        pill.title = 'Živá diagnostika servera, prehrávania a extraktorov';
        pill.innerHTML = `<span class="nx-hdr-dot"></span><span class="nx-hdr-text">Diag: …</span>`;
        container.prepend(pill);

        const pop = document.createElement('div');
        pop.id = 'nx-hdr-health-pop';
        pop.className = 'nx-hdr-pop';
        document.body.appendChild(pop);

        const dot = pill.querySelector('.nx-hdr-dot');
        const label = pill.querySelector('.nx-hdr-text');

        async function refresh() {
            if (document.visibilityState === 'hidden') return;
            const [sys, metrics, cb] = await Promise.all([
                fetchJson('/api/v1/system/stats'),
                fetchJson('/api/v1/playback/metrics'),
                fetchJson('/api/extractors/circuit-breaker'),
            ]);
            if (!sys && !metrics && !cb) return;

            const cpu = sys ? `${Math.round(sys.cpu)}%` : '—';
            const ram = sys?.memory ? `${Math.round(sys.memory.percent)}%` : '—';
            const openCb = cb ? Number(cb.open_count || 0) : 0;

            dot.classList.remove('warn', 'err');
            if (openCb > 0) dot.classList.add('warn');
            label.textContent = openCb > 0
                ? `CPU ${cpu} · RAM ${ram} · ${openCb} CB`
                : `CPU ${cpu} · RAM ${ram} · OK`;

            if (popoverOpen) {
                await renderPopover(pop, sys, metrics, cb);
            }
        }

        async function renderPopover(target, sys, metrics, cb) {
            const sources = await fetchJson('/api/v1/health/sources');
            const topSources = (sources?.sources || []).slice(0, 6);
            const cbList = cb?.domains || [];
            const resHits = metrics?.resolver?.hits ?? 0;
            const resExt = metrics?.resolver?.extractions ?? 0;
            const activeSess = (metrics?.sessions || []).length;

            let html = `<h5>Systém</h5>`;
            if (sys) {
                html += `<div class="nx-hdr-kv"><span>CPU / RAM</span><b>${sys.cpu}% / ${sys.memory?.used_gb ?? '?'} / ${sys.memory?.total_gb ?? '?'} GB</b></div>`;
                html += `<div class="nx-hdr-kv"><span>Disk</span><b>${sys.disk?.percent ?? '?'}%</b></div>`;
            }
            html += `<h5>Prehrávač & Resolver</h5>`;
            html += `<div class="nx-hdr-kv"><span>Cache hits / Extrakcie</span><b>${resHits} / ${resExt}</b></div>`;
            html += `<div class="nx-hdr-kv"><span>Aktívne relácie</span><b>${activeSess}</b></div>`;

            html += `<h5>Circuit Breaker (${cbList.length})</h5>`;
            if (cbList.length === 0) {
                html += `<div style="color:#34d399;padding:2px 0;">Všetky domény zdravé</div>`;
            } else {
                for (const d of cbList.slice(0, 5)) {
                    html += `<div class="nx-hdr-kv"><span>${d.domain}</span><b>${d.state} (${d.failures}x, ${d.retry_after_s}s)</b></div>`;
                }
                html += `<button type="button" class="nx-hdr-btn" id="nx-cb-reset-btn">Resetovať Circuit Breaker</button>`;
            }

            if (topSources.length) {
                html += `<h5>Zdroje knižnice (Top 6)</h5>`;
                for (const s of topSources) {
                    html += `<div class="nx-hdr-kv"><span>${s.name}</span><b>${s.stats?.total ?? 0} videí (${s.score}%)</b></div>`;
                }
            }
            target.innerHTML = html;

            const resetBtn = target.querySelector('#nx-cb-reset-btn');
            if (resetBtn) {
                resetBtn.addEventListener('click', async () => {
                    await fetch('/api/extractors/circuit-breaker/reset', { method: 'POST' });
                    await refresh();
                });
            }
        }

        pill.addEventListener('click', async (e) => {
            e.stopPropagation();
            popoverOpen = !popoverOpen;
            pop.classList.toggle('open', popoverOpen);
            if (popoverOpen) {
                pop.innerHTML = '<div>Načítavam diagnostiku…</div>';
                const [sys, metrics, cb] = await Promise.all([
                    fetchJson('/api/v1/system/stats'),
                    fetchJson('/api/v1/playback/metrics'),
                    fetchJson('/api/extractors/circuit-breaker'),
                ]);
                await renderPopover(pop, sys, metrics, cb);
            }
        });

        document.addEventListener('click', (e) => {
            if (popoverOpen && !pop.contains(e.target) && !pill.contains(e.target)) {
                popoverOpen = false;
                pop.classList.remove('open');
            }
        });

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') refresh();
        });

        refresh();
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', mount, { once: true });
        } else {
            mount();
        }
    }

    global.NexusHealthWidget = { mount };
})(typeof window !== 'undefined' ? window : globalThis);
