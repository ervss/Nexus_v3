(function () {
    'use strict';

    if (window.top !== window) return;
    if (!/sxyprn\.(net|com)$/i.test(location.hostname)) return;

    // Only activate on blog pages: /blog/<id>/<offset>  (with optional lang prefix)
    const BLOG_RE = /^(?:\/[a-z]{2})?(\/blog\/[^/]+\/)(\d+)\/?$/i;
    const blogMatch = location.pathname.match(BLOG_RE);
    if (!blogMatch) return;

    const blogBasePath = blogMatch[1];              // e.g. "/blog/643b5d34ef375/"
    const currentOffset = parseInt(blogMatch[2], 10) || 0;
    const PAGE_STEP = 20;

    const TOOLBAR_ID = 'nexus-sx-toolbar';
    const TOAST_ID = 'nexus-sx-toast';
    const CHECK_CLASS = 'nsx-check';
    const SELECTED_CLASS = 'nsx-card-selected';

    // ── State ────────────────────────────────────────────────────────────────
    const state = {
        items: new Map(),       // url → { url, title, thumbnail, node }
        selectedUrls: new Set(),
        busy: false,
    };

    // ── Toast ─────────────────────────────────────────────────────────────────
    function toast(msg, isError) {
        let el = document.getElementById(TOAST_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = TOAST_ID;
            document.body.appendChild(el);
        }
        el.textContent = String(msg || '').trim() || (isError ? 'Chyba' : 'OK');
        el.dataset.error = isError ? '1' : '0';
        el.classList.add('visible');
        clearTimeout(el._t);
        el._t = setTimeout(() => el.classList.remove('visible'), 3400);
    }

    // ── Card scanning ─────────────────────────────────────────────────────────
    // sxyprn blog pages contain thumbnail links like:
    //   <a href="/post/XXXXX.html"> … <img …> … </a>
    // We find those anchors and treat their closest positioned ancestor as the card.
    function findCardContainer(anchor) {
        // Walk up a few levels to find a block-level wrapper
        let el = anchor.parentElement;
        for (let i = 0; i < 5 && el && el !== document.body; i++) {
            const tag = el.tagName;
            if (/^(DIV|LI|ARTICLE|FIGURE|SECTION)$/i.test(tag)) return el;
            el = el.parentElement;
        }
        return anchor;
    }

    function collectCards() {
        const anchors = Array.from(document.querySelectorAll('a[href]')).filter((a) => {
            const h = a.href || '';
            return /\/post\//i.test(h);
        });
        return anchors.map((a) => {
            const img = a.querySelector('img') || a.closest('li,div,article')?.querySelector('img');
            const title = a.getAttribute('title')
                || a.querySelector('img')?.getAttribute('alt')
                || a.textContent?.trim()
                || 'sxyprn video';
            const thumbnail = img?.getAttribute('data-src') || img?.src || '';
            const container = findCardContainer(a);
            return { url: a.href, title: title.trim(), thumbnail, anchor: a, container };
        });
    }

    function scanCards() {
        const cards = collectCards();
        const seen = new Set();

        for (const card of cards) {
            seen.add(card.url);
            if (!state.items.has(card.url)) {
                state.items.set(card.url, {
                    ...card,
                    selected: state.selectedUrls.has(card.url),
                });
            } else if (!state.items.get(card.url).anchor.isConnected) {
                state.items.set(card.url, { ...card, selected: state.selectedUrls.has(card.url) });
            }
            upsertCardUI(state.items.get(card.url));
        }

        // Remove items that are no longer in DOM
        for (const [url, item] of state.items) {
            if (!seen.has(url) || !item.anchor.isConnected) {
                state.items.delete(url);
            }
        }
        updateToolbar();
    }

    // ── Card UI (checkbox overlay) ────────────────────────────────────────────
    function upsertCardUI(item) {
        const { container, anchor } = item;
        if (!container || !container.isConnected) return;
        if (getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }

        let box = container.querySelector(`.${CHECK_CLASS}`);
        if (!box) {
            box = document.createElement('label');
            box.className = CHECK_CLASS;
            box.innerHTML = '<input type="checkbox"><span></span>';

            box.addEventListener('mousedown', (e) => e.stopPropagation());
            box.addEventListener('click', (e) => e.stopPropagation());

            const input = box.querySelector('input');
            input.addEventListener('change', (e) => {
                item.selected = e.target.checked;
                if (item.selected) state.selectedUrls.add(item.url);
                else state.selectedUrls.delete(item.url);
                container.classList.toggle(SELECTED_CLASS, item.selected);
                updateToolbar();
            });
            container.appendChild(box);
        }

        const input = box.querySelector('input');
        input.checked = !!item.selected;
        container.classList.toggle(SELECTED_CLASS, !!item.selected);
    }

    // ── Toolbar ───────────────────────────────────────────────────────────────
    function pageLabel() {
        const pageNum = Math.floor(currentOffset / PAGE_STEP) + 1;
        return `Strana ${pageNum} (offset ${currentOffset})`;
    }

    function updateToolbar() {
        const tb = document.getElementById(TOOLBAR_ID);
        if (!tb) return;
        const sel = state.selectedUrls.size;
        const total = state.items.size;
        tb.querySelector('.nsx-stats').textContent = `${sel} vybrané / ${total} kariet`;
        tb.querySelector('[data-role="import"]').disabled = sel === 0 || state.busy;
        tb.querySelector('[data-role="clear"]').disabled = sel === 0 || state.busy;
        tb.querySelector('[data-role="select"]').disabled = total === 0 || state.busy;
        tb.querySelector('[data-role="prev"]').disabled = currentOffset === 0 || state.busy;
        tb.dataset.busy = state.busy ? '1' : '0';
    }

    function navigatePage(delta) {
        const newOffset = Math.max(0, currentOffset + delta * PAGE_STEP);
        location.href = `${location.origin}${blogBasePath}${newOffset}`;
    }

    function createToolbar() {
        if (document.getElementById(TOOLBAR_ID)) return;
        const tb = document.createElement('div');
        tb.id = TOOLBAR_ID;
        tb.innerHTML = `
            <div class="nsx-title">Nexus · sxyprn Blog</div>
            <div class="nsx-stats">Skenujem…</div>
            <div class="nsx-pager">
                <button data-role="prev">◀ Predch.</button>
                <span class="nsx-pager-label">${pageLabel()}</span>
                <button data-role="next">Ďalšia ▶</button>
            </div>
            <div class="nsx-actions">
                <button data-role="select">Vybrať všetky</button>
                <button data-role="clear">Zrušiť výber</button>
                <button data-role="import" class="primary">Import vybraných</button>
            </div>
        `;
        document.body.appendChild(tb);

        tb.querySelector('[data-role="prev"]').addEventListener('click', () => navigatePage(-1));
        tb.querySelector('[data-role="next"]').addEventListener('click', () => navigatePage(+1));

        tb.querySelector('[data-role="select"]').addEventListener('click', () => {
            state.items.forEach((item) => {
                item.selected = true;
                state.selectedUrls.add(item.url);
                upsertCardUI(item);
            });
            updateToolbar();
        });

        tb.querySelector('[data-role="clear"]').addEventListener('click', () => {
            state.items.forEach((item) => {
                item.selected = false;
                upsertCardUI(item);
            });
            state.selectedUrls.clear();
            updateToolbar();
        });

        tb.querySelector('[data-role="import"]').addEventListener('click', () => {
            importSelected().catch((e) => toast(e?.message || 'Import zlyhal', true));
        });

        updateToolbar();
    }

    // ── Import ────────────────────────────────────────────────────────────────
    function setBusy(v) {
        state.busy = !!v;
        updateToolbar();
    }

    async function importSelected() {
        const urls = Array.from(state.selectedUrls);
        if (!urls.length) return;

        setBusy(true);
        toast(`Importujem ${urls.length} videí…`);

        const batchName = `sxyprn blog: ${document.title.trim().slice(0, 80)}`;

        const res = await new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'SXYPRN_BLOG_IMPORT', urls, batchName }, resolve);
        });

        if (res && res.ok) {
            toast(`✓ Importovaných ${res.imported} / ${urls.length}`);
            // Deselect after successful import
            state.items.forEach((item) => {
                if (state.selectedUrls.has(item.url)) {
                    item.selected = false;
                    upsertCardUI(item);
                }
            });
            state.selectedUrls.clear();
            updateToolbar();
        } else {
            toast(`Chyba: ${res?.error || 'neznáma'}`, true);
        }
        setBusy(false);
    }

    // ── Boot ──────────────────────────────────────────────────────────────────
    function boot() {
        createToolbar();
        scanCards();
        // Ignore our own UI updates and coalesce the site's DOM changes.
        let scanTimer;
        new MutationObserver((mutations) => {
            const siteChanged = mutations.some((mutation) => {
                const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
                if (target?.closest(`#${TOOLBAR_ID}, #${TOAST_ID}, .${CHECK_CLASS}`)) return false;
                return [...mutation.addedNodes, ...mutation.removedNodes].some((node) =>
                    node.nodeType === 1 && !node.matches?.(`.${CHECK_CLASS}, #${TOOLBAR_ID}, #${TOAST_ID}`));
            });
            if (!siteChanged) return;
            clearTimeout(scanTimer);
            scanTimer = setTimeout(scanCards, 100);
        })
            .observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
