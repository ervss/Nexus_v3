(function () {
    'use strict';

    if (window.top !== window) return;
    if (!/(^|\.)69tubed\.(com|live)$/i.test(location.hostname)) return;

    const TOOLBAR_ID = 'nexus-t69-toolbar';
    const TOAST_ID = 'nexus-t69-toast';
    const CHECKBOX_CLASS = 'nexus-t69-check';
    const CARD_SELECTED_CLASS = 'nexus-t69-selected';
    const SCAN_INTERVAL_MS = 1800;

    const state = {
        items: new Map(),      // key -> item
        selectedIds: new Set(),
        busy: false,
        lastSignature: '',
        q: '',
        sort: 'none',          // none | sizeDesc | sizeAsc | qualDesc | qualAsc | durDesc | durAsc | dateDesc
        qualities: new Set(),  // active quality-tier filter chips
        sizeMin: '', sizeMax: '',   // MB
        durMin: '', durMax: '',     // minutes
        tagFilter: '',              // extra required tag(s), comma = AND
        fetchingTags: false,        // detail-page tag enrichment in progress
        onlySelected: false,        // "hide unselected" — show only checked cards
        // ── Multi-page accumulation ──────────────────────────────────────────
        // We append the cards from further listing pages into the live grid so
        // sorting/filtering spans every loaded page (one continuous list).
        loadedMaxPage: 0,      // highest listing page already merged into the grid
        loadingMore: false,
        activeChips: new Set(),// preset tag chips currently toggled on (canonical id)
    };

    // Curated tag chips. Each chip has a canonical id and the slug variants that
    // 69tubed may actually use for it (their tags are hyphenated slugs, and the
    // same concept appears under several spellings, e.g. deepthroat / deep-throat).
    const TAG_CHIPS = [
        { id: 'bimbo',        label: 'bimbo',         aliases: ['bimbo'] },
        { id: 'fake-tits',    label: 'fake tits',     aliases: ['fake-tits', 'faketits'] },
        { id: 'fake-boobs',   label: 'fake boobs',    aliases: ['fake-boobs', 'fakeboobs'] },
        { id: 'big-fake-tits',label: 'big fake tits', aliases: ['big-fake-tits', 'bigfaketits'] },
        { id: 'deepthroat',   label: 'deepthroat',    aliases: ['deepthroat', 'deep-throat'] },
        { id: 'facefuck',     label: 'facefuck',      aliases: ['facefuck', 'face-fuck', 'face-fucking', 'facefucking'] },
        { id: 'sloppy',       label: 'sloppy',        aliases: ['sloppy', 'sloppy-blowjob', 'sloppy-head'] },
        { id: 'pov',          label: 'pov',           aliases: ['pov', 'male-pov'] },
        { id: 'snowbunny',    label: 'snowbunny',     aliases: ['snowbunny', 'snow-bunny'] },
        { id: 'interracial',  label: 'interracial',   aliases: ['interracial'] },
        { id: 'blowjob',      label: 'blowjob',       aliases: ['blowjob', 'blow-job'] },
        { id: '4k',           label: '4K',            aliases: ['4k', '4k-porn', '2160p'] },
        { id: '2k',           label: '2K',            aliases: ['2k', '2k-porn', '1440p'] },
        { id: 'slut',         label: 'slut',          aliases: ['slut'] },
        { id: 'whore',        label: 'whore',         aliases: ['whore'] },
    ];
    const CHIP_BY_ID = new Map(TAG_CHIPS.map((c) => [c.id, c]));

    // ── Utilities ──────────────────────────────────────────────────────────────

    function watchKey(rawUrl) {
        try {
            const m = new URL(rawUrl, location.href).pathname.match(/\/video\/(\d+)/i);
            return m ? `69tubed:${m[1]}` : null;
        } catch { return null; }
    }

    function toast(message, isError) {
        let el = document.getElementById(TOAST_ID);
        if (!el) { el = document.createElement('div'); el.id = TOAST_ID; document.body.appendChild(el); }
        el.textContent = String(message || '');
        el.className = isError ? 'nexus-t69-toast-error' : 'nexus-t69-toast-ok';
        el.style.opacity = '1';
        clearTimeout(el._t);
        el._t = setTimeout(() => { el.style.opacity = '0'; }, 4000);
    }

    // Parse "1.54 GB" / "966 MB" from a tile into MB.
    function parseSizeMb(text) {
        const m = String(text || '').match(/([\d.]+)\s*(GB|MB)/i);
        if (!m) return 0;
        const n = parseFloat(m[1]);
        return /gb/i.test(m[2]) ? Math.round(n * 1024) : Math.round(n);
    }
    // Parse "23:54" / "1:03:12" into seconds.
    function parseDurationSecs(text) {
        const m = String(text || '').match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
        if (!m) return 0;
        const a = +m[1], b = +m[2], c = m[3] ? +m[3] : null;
        return c == null ? a * 60 + b : a * 3600 + b * 60 + c;
    }
    function qualityHeight(label) {
        const t = String(label || '').toLowerCase();
        if (/4k|2160/.test(t)) return 2160;
        if (/1440|2k/.test(t)) return 1440;
        if (/1080|fhd/.test(t)) return 1080;
        if (/720|hd/.test(t)) return 720;
        if (/480/.test(t)) return 480;
        if (/360/.test(t)) return 360;
        return 0;
    }
    function qualityTier(h) {
        if (h >= 2160) return '4K';
        if (h >= 1440) return '2K';
        if (h >= 1080) return '1080p';
        if (h >= 720) return '720p';
        if (h > 0) return 'SD';
        return '?';
    }

    // ── Card discovery + metadata straight from the tile ─────────────────────────

    function getCardNodes() {
        const cards = [];
        const seen = new Set();
        for (const a of document.querySelectorAll('a[href*="/video/"]')) {
            const href = a.getAttribute('href') || '';
            if (!/\/video\/\d+/i.test(href)) continue;
            const card = a.closest('article, .post, .item, [class*="video"]') || a;
            if (seen.has(card)) continue;
            seen.add(card);
            cards.push({ card, anchor: a });
        }
        return cards;
    }

    function extractCard({ card, anchor }) {
        const url = new URL(anchor.getAttribute('href'), location.href).href.split('#')[0];
        const key = watchKey(url);
        if (!key) return null;

        const img = card.querySelector('img');
        const thumbnail = img ? (img.getAttribute('data-src') || img.getAttribute('src') || img.src || '') : '';
        let title = (card.querySelector('.title, .entry-title, h2, h3, .video-title')?.textContent
            || anchor.getAttribute('title') || img?.getAttribute('alt') || '').trim();
        if (!title) {
            const slug = url.match(/\/video\/\d+\/([^/]+)/i)?.[1] || '';
            title = slug.replace(/-/g, ' ').trim();
        }

        // 69tubed tiles already print quality, size and duration — read them from
        // the DOM (instant, no API calls). Byse decrypt stays the backend's job.
        const text = card.textContent || '';
        let enriched = {};
        const metadataNode = card.matches('[data-nvs-tubed69-meta]') ? card
            : card.querySelector('[data-nvs-tubed69-meta]') || card.closest('[data-nvs-tubed69-meta]');
        try { enriched = JSON.parse(metadataNode?.dataset.nvsTubed69Meta || '{}'); } catch { }
        const qLabel = enriched.quality || (text.match(/\b(2160p|1440p|1080p|720p|480p|360p|4k|hd)\b/i) || [])[1] || '';
        const height = qualityHeight(qLabel);
        const sizeMb = Number(enriched.sizeMb) || parseSizeMb(text);
        const durSecs = parseDurationSecs(enriched.duration || text);

        return {
            key, url,
            title: title || '69Tubed Video',
            thumbnail,
            quality: qLabel ? qualityTier(height) : '',
            height,
            sizeMb,
            durSecs,
            tags: [],            // filled on demand from the detail page
            _tagsFetched: false,
        };
    }

    // ── Filtering / sorting ──────────────────────────────────────────────────────

    function filteredItems() {
        let list = [...state.items.values()];
        const q = state.q.trim().toLowerCase();
        if (q) list = list.filter((it) => it.title.toLowerCase().includes(q));
        if (state.qualities.size) list = list.filter((it) => state.qualities.has(it.quality));
        const smin = Number(state.sizeMin) || 0, smax = Number(state.sizeMax) || 0;
        if (smin) list = list.filter((it) => it.sizeMb >= smin);
        if (smax) list = list.filter((it) => it.sizeMb && it.sizeMb <= smax);
        const dmin = Number(state.durMin) || 0, dmax = Number(state.durMax) || 0;
        if (dmin) list = list.filter((it) => it.durSecs >= dmin * 60);
        if (dmax) list = list.filter((it) => it.durSecs && it.durSecs <= dmax * 60);

        // Extra tag filter (e.g. category "bimbo" + require tag "deepthroat").
        // Two sources, both AND: typed terms (comma-separated) and toggled chips.
        // A chip matches any of its slug variants. Cards whose tags aren't fetched
        // yet are hidden while any tag condition is active.
        const requirements = [];
        for (const term of String(state.tagFilter || '')
            .toLowerCase().split(',').map((s) => s.trim().replace(/\s+/g, '-')).filter(Boolean)) {
            requirements.push([term]);                 // typed term: single variant
        }
        for (const id of state.activeChips) {
            const chip = CHIP_BY_ID.get(id);
            requirements.push(chip ? chip.aliases : [id]); // chip: any alias satisfies
        }
        if (requirements.length) {
            list = list.filter((it) => {
                if (!it._tagsFetched) return false;
                const have = (it.tags || []).map((t) => String(t).toLowerCase());
                return requirements.every((variants) =>
                    variants.some((w) => have.some((h) => h === w || h.includes(w))));
            });
        }

        const dir = state.sort.endsWith('Asc') ? 1 : -1;
        const value = state.sort.startsWith('size') ? (it) => it.sizeMb
            : state.sort.startsWith('qual') ? (it) => it.height
            : state.sort.startsWith('dur') ? (it) => it.durSecs : null;
        if (value) {
            list.sort((a, b) => {
                const av = value(a), bv = value(b);
                // Missing metadata must not appear as the smallest video.
                if (!av && !bv) return a.order - b.order;
                if (!av) return 1;
                if (!bv) return -1;
                return ((av - bv) * dir) || (a.order - b.order);
            });
        } else {
            list.sort((a, b) => a.order - b.order);
        }
        return list;
    }

    // Move the site's actual card nodes, rather than only sorting our internal list.
    // A card can be wrapped by a link or a layout element, so lift it to the first
    // ancestor whose parent contains multiple Nexus cards.
    function sortableNode(item) {
        let node = item?._node;
        while (node?.parentElement && node.parentElement !== document.body) {
            const siblings = [...node.parentElement.children].filter((child) =>
                [...state.items.values()].some((it) => it._node === child || child.contains(it._node))
            );
            if (siblings.length >= 2) return node;
            node = node.parentElement;
        }
        return item?._node || null;
    }

    function applyCardSort() {
        const groups = new Map();
        for (const item of filteredItems()) {
            const node = sortableNode(item);
            const parent = node?.parentElement;
            if (!parent) continue;
            if (!groups.has(parent)) groups.set(parent, []);
            groups.get(parent).push({ item, node });
        }
        for (const entries of groups.values()) {
            if (entries.length < 2) continue;
            for (const { node } of entries) node.parentElement.appendChild(node);
        }
    }

    // ── Card UI (checkbox overlay) ───────────────────────────────────────────────

    function decorateCard({ card }, item) {
        if (card.querySelector(`.${CHECKBOX_CLASS}`)) {
            const cb = card.querySelector(`.${CHECKBOX_CLASS} input`);
            if (cb) cb.checked = state.selectedIds.has(item.key);
            return;
        }
        if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
        const wrap = document.createElement('label');
        wrap.className = CHECKBOX_CLASS;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = state.selectedIds.has(item.key);
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => {
            if (cb.checked) state.selectedIds.add(item.key); else state.selectedIds.delete(item.key);
            card.classList.toggle(CARD_SELECTED_CLASS, cb.checked);
            // When "hide unselected" is active, unchecking must remove the card at once.
            if (state.onlySelected) applyMatchDimming();
            updateToolbar();
        });
        wrap.appendChild(cb);
        card.appendChild(wrap);
    }

    function scanCards() {
        for (const node of getCardNodes()) {
            let item = extractCard(node);
            if (!item) continue;
            const previous = state.items.get(item.key);
            item._node = node.card;
            item.order = previous?.order ?? state.items.size;
            // Carry over tags already fetched from the detail page — a re-scan
            // must not wipe them (extractCard only sees the listing tile).
            if (previous?._tagsFetched) {
                item.tags = previous.tags;
                item._tagsFetched = true;
            }
            // Pending detail requests retain this object. Keep its identity across
            // periodic scans so their results remain in the live item map.
            if (previous) item = Object.assign(previous, item);
            state.items.set(item.key, item);
            decorateCard(node, item);
        }
        applyMatchDimming();
        applyCardSort();
        updateToolbar();
    }

    // Dim cards that fall outside the active filter so the grid mirrors the panel.
    // With "hide unselected" on, non-selected cards are fully hidden instead.
    function applyMatchDimming() {
        const active = state.q || state.qualities.size || state.sizeMin || state.sizeMax
            || state.durMin || state.durMax || state.tagFilter;
        const keep = new Set(filteredItems().map((it) => it.key));
        for (const it of state.items.values()) {
            if (!it._node) continue;
            const node = it._node;
            if (state.onlySelected && !state.selectedIds.has(it.key)) {
                node.style.display = 'none';
                continue;
            }
            node.style.display = '';
            node.style.opacity = (active && !keep.has(it.key)) ? '0.28' : '';
        }
    }

    // ── Multi-page loading ───────────────────────────────────────────────────────

    // Current listing page number parsed from the URL (…/page/N/ → N, else 1).
    function currentPageNum() {
        const m = location.pathname.match(/\/page\/(\d+)\/?/i);
        return m ? parseInt(m[1], 10) || 1 : 1;
    }

    // Build the URL of listing page N for the current tag/category/listing.
    function pageUrl(n) {
        const base = location.origin + location.pathname.replace(/\/page\/\d+\/?/i, '/');
        const clean = base.endsWith('/') ? base : base + '/';
        return (n <= 1 ? clean : `${clean}page/${n}/`) + location.search;
    }

    // Highest page number advertised by the site's own pagination links.
    function detectLastPage(doc = document) {
        let max = 1;
        for (const a of doc.querySelectorAll('a[href*="/page/"]')) {
            const m = (a.getAttribute('href') || '').match(/\/page\/(\d+)\/?/i);
            if (m) max = Math.max(max, parseInt(m[1], 10) || 1);
        }
        return max;
    }

    // The container that actually holds the site's card nodes (their shared parent).
    function gridContainer() {
        const counts = new Map();
        for (const { card } of getCardNodes()) {
            const p = card.parentElement;
            if (!p) continue;
            counts.set(p, (counts.get(p) || 0) + 1);
        }
        let best = null, bestN = 0;
        for (const [p, n] of counts) if (n > bestN) { best = p; bestN = n; }
        return best;
    }

    // Fetch listing page N and append its (new) card nodes into the live grid so
    // the whole set becomes one sortable/filterable list.
    async function loadPage(n) {
        const url = pageUrl(n);
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const html = await resp.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');

        const container = gridContainer();
        if (!container) throw new Error('grid sa nenašiel');

        // Reuse getCardNodes on the parsed document via a temporary swap-free scan.
        const known = new Set(state.items.keys());
        let added = 0;
        for (const a of doc.querySelectorAll('a[href*="/video/"]')) {
            const href = a.getAttribute('href') || '';
            if (!/\/video\/\d+/i.test(href)) continue;
            const card = a.closest('article, .post, .item, [class*="video"]') || a;
            const url2 = new URL(a.getAttribute('href'), location.href).href;
            const key = watchKey(url2);
            if (!key || known.has(key)) continue;
            known.add(key);
            // Import the node into the live document and drop it into the grid.
            const imported = document.importNode(card, true);
            // The page's lazy-loader already ran, so appended <img> stay blank
            // unless we promote their data-src to a real src.
            for (const img of imported.querySelectorAll('img')) {
                const real = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
                if (real && !img.getAttribute('src')) img.setAttribute('src', real);
                img.removeAttribute('loading');
            }
            container.appendChild(imported);
            added += 1;
        }
        return { added, lastPage: detectLastPage(doc) };
    }

    async function loadMore() {
        if (state.loadingMore) return;
        state.loadingMore = true;
        updateLoadMoreBtn();
        try {
            const start = state.loadedMaxPage || currentPageNum();
            const next = start + 1;
            const { added, lastPage } = await loadPage(next);
            state.loadedMaxPage = next;
            state._lastPage = Math.max(state._lastPage || 1, lastPage, next);
            scanCards();
            if (added === 0) {
                toast(`Strana ${next} bez nových videí`);
            } else {
                toast(`Načítaná strana ${next} (+${added} videí)`);
            }
        } catch (e) {
            toast(e?.message || 'Načítanie strany zlyhalo', true);
        } finally {
            state.loadingMore = false;
            updateLoadMoreBtn();
        }
    }

    // Load a specific number of further pages (e.g. "4" → next 4 pages), then
    // settle the grid so every new card is fully painted with its thumbnail.
    async function loadN(count) {
        if (state.loadingMore) return;
        const n = Math.max(1, Math.min(50, parseInt(count, 10) || 0));
        if (!n) { toast('Zadaj počet strán'); return; }
        const last = state._lastPage || detectLastPage();
        let done = 0;
        for (let i = 0; i < n; i++) {
            const loaded = state.loadedMaxPage || currentPageNum();
            if (last > 1 && loaded >= last) break;   // no more pages to fetch
            await loadMore();
            done += 1;
            await new Promise((r) => setTimeout(r, 250));
        }
        // Final settle: repaint thumbnails + re-scan so metadata/sort are consistent.
        settleGrid();
        toast(`Načítaných ${done} strán — spolu ${state.items.size} kariet`);
    }

    // Load every remaining listing page, one after another, into the live grid.
    async function loadAll() {
        if (state.loadingMore) return;
        const last = state._lastPage || detectLastPage();
        while (!state.loadingMore && (state.loadedMaxPage || currentPageNum()) < last) {
            await loadMore();
            // Small gap so we don't hammer the site; stop if a page failed to grow.
            await new Promise((r) => setTimeout(r, 250));
        }
        settleGrid();
    }

    // Force every card's <img> to resolve its real source and re-run the scan so
    // the whole grid renders as clean thumbnails with metadata in the tab.
    function settleGrid() {
        for (const it of state.items.values()) {
            const node = it._node;
            if (!node) continue;
            for (const img of node.querySelectorAll('img')) {
                const real = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
                if (real && (!img.getAttribute('src') || img.getAttribute('src') !== real)) {
                    img.setAttribute('src', real);
                }
                img.removeAttribute('loading');
                img.classList.remove('lazyload', 'lazy');
                img.classList.add('lazyloaded');
            }
        }
        scanCards();
    }

    function updateLoadMoreBtn() {
        const bar = document.getElementById(TOOLBAR_ID);
        if (!bar) return;
        const btn = bar.querySelector('[data-act="loadMore"]');
        const allBtn = bar.querySelector('[data-act="loadAll"]');
        const loaded = state.loadedMaxPage || currentPageNum();
        const last = state._lastPage || detectLastPage();
        const atEnd = last > 1 && loaded >= last;
        if (btn) {
            btn.disabled = state.loadingMore || atEnd;
            btn.textContent = state.loadingMore
                ? 'Načítavam…'
                : atEnd
                    ? `Všetky strany načítané (${loaded}/${last})`
                    : `Načítať ďalšiu stranu (${loaded}${last > 1 ? '/' + last : ''} →)`;
        }
        if (allBtn) {
            allBtn.disabled = state.loadingMore || atEnd;
            allBtn.style.display = (last > 1 && !atEnd) ? '' : 'none';
        }
        const loadNBtn = bar.querySelector('[data-act="loadN"]');
        if (loadNBtn) {
            loadNBtn.disabled = state.loadingMore || atEnd;
            loadNBtn.textContent = state.loadingMore ? '…' : 'Načítať';
        }
        const tagsBtn = bar.querySelector('[data-act="loadTags"]');
        if (tagsBtn) {
            const withTags = [...state.items.values()].filter((it) => it._tagsFetched).length;
            const total = state.items.size;
            tagsBtn.disabled = state.fetchingTags || total === 0;
            tagsBtn.textContent = state.fetchingTags
                ? `Tagy: ${withTags}/${total}…`
                : (withTags >= total && total > 0 ? `Tagy ✓ (${withTags})` : 'Načítať tagy');
        }
    }

    // ── Detail-page tag enrichment ───────────────────────────────────────────────

    // Parse tag + category slugs from a video detail page's HTML.
    function parseTagsFromDetail(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const slugs = new Set();
        for (const a of doc.querySelectorAll('a[href*="/tag/"], a[href*="/category/"]')) {
            const m = (a.getAttribute('href') || '').match(/\/(?:tag|category)\/([^/?#"']+)/i);
            if (m && m[1]) slugs.add(decodeURIComponent(m[1]).toLowerCase());
        }
        return [...slugs];
    }

    async function fetchTagsFor(item) {
        if (!item || item._tagsFetched) return true;
        for (let attempt = 0; attempt < 3; attempt++) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 20000);
            try {
                const resp = await fetch(item.url, { credentials: 'include', signal: controller.signal });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                item.tags = parseTagsFromDetail(await resp.text());
                item._tagsFetched = true;
                return true;
            } catch {
                if (attempt < 2) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
            } finally {
                clearTimeout(timeout);
            }
        }
        return false;
    }

    // Fetch tags for a set of items with limited concurrency + a progress toast.
    async function enrichTags(items, label = 'tagy') {
        const pending = items.filter((it) => it && !it._tagsFetched);
        if (!pending.length) { toast('Tagy sú už načítané'); applyMatchDimming(); return; }
        if (state.fetchingTags) return;
        state.fetchingTags = true;
        updateLoadMoreBtn();
        let done = 0;
        let failed = 0;
        const CONC = 4;
        try {
            for (let i = 0; i < pending.length; i += CONC) {
                const batch = pending.slice(i, i + CONC);
                const results = await Promise.all(batch.map((it) => fetchTagsFor(it)));
                failed += results.filter(ok => !ok).length;
                done += batch.length;
                toast(`Načítavam ${label}: ${done}/${pending.length}`);
                applyMatchDimming(); renderTagChips(); updateToolbar();
                await new Promise((r) => setTimeout(r, 120));
            }
            toast(failed ? `Tagy načítané pre ${done - failed} videí; ${failed} požiadaviek zlyhalo — kliknutím zopakuješ iba chýbajúce`
                : `Tagy načítané pre ${done} videí`, failed > 0);
        } finally {
            state.fetchingTags = false;
            applyMatchDimming(); renderTagChips(); updateToolbar();
        }
    }

    // How many loaded cards carry a chip's tag (any of its slug variants).
    function chipCount(chip) {
        let n = 0;
        for (const it of state.items.values()) {
            if (!it._tagsFetched) continue;
            const have = (it.tags || []).map((t) => String(t).toLowerCase());
            if (chip.aliases.some((w) => have.some((h) => h === w || h.includes(w)))) n += 1;
        }
        return n;
    }

    // Render the curated tag chips, most-used first; hide chips nobody has.
    // Clicking a chip toggles it as an AND requirement in the tag filter.
    function renderTagChips() {
        const bar = document.getElementById(TOOLBAR_ID);
        if (!bar) return;
        const box = bar.querySelector('[data-role="tagChips"]');
        if (!box) return;

        const anyTags = [...state.items.values()].some((it) => it._tagsFetched);
        if (!anyTags) { box.style.display = 'none'; box.innerHTML = ''; return; }

        const rows = TAG_CHIPS
            .map((chip) => ({ chip, count: chipCount(chip) }))
            // Keep a chip if it has matches OR it is already toggled on.
            .filter((r) => r.count > 0 || state.activeChips.has(r.chip.id))
            .sort((a, b) => b.count - a.count);

        if (!rows.length) { box.style.display = 'none'; box.innerHTML = ''; return; }

        box.style.display = 'flex';
        box.innerHTML = rows.map(({ chip, count }) => {
            const on = state.activeChips.has(chip.id) ? ' on' : '';
            return `<button class="nexus-t69-chip${on}" data-chip="${chip.id}">${chip.label}`
                 + `<span class="nexus-t69-chip-n">${count}</span></button>`;
        }).join('');

        box.querySelectorAll('[data-chip]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.chip;
                if (state.activeChips.has(id)) state.activeChips.delete(id);
                else state.activeChips.add(id);
                applyMatchDimming(); applyCardSort(); renderTagChips(); updateToolbar();
            });
        });
    }

    // ── Toolbar ──────────────────────────────────────────────────────────────────

    function createToolbar() {
        if (document.getElementById(TOOLBAR_ID)) return;
        const bar = document.createElement('div');
        bar.id = TOOLBAR_ID;
        bar.innerHTML = `
            <div class="nexus-t69-head">
                <span class="nexus-t69-brand">Nexus · 69Tubed</span>
                <button class="nexus-t69-mini" data-act="collapse" title="Zbaliť">–</button>
            </div>
            <div class="nexus-t69-body">
                <input class="nexus-t69-search" data-role="q" placeholder="Hľadať v názvoch…">
                <div class="nexus-t69-num">
                    <span>Ďalší tag</span>
                    <input data-role="tagFilter" placeholder="napr. deepthroat" style="grid-column: span 1;">
                    <button class="nexus-t69-btn" data-act="loadTags" title="Dotiahne tagy z detailu videí">Načítať tagy</button>
                </div>
                <div class="nexus-t69-chips" data-role="tagChips" style="display:none;"></div>
                <div class="nexus-t69-num">
                    <span>Počet strán</span>
                    <input data-role="pageCount" placeholder="napr. 4" inputmode="numeric" value="4">
                    <button class="nexus-t69-btn" data-act="loadN">Načítať</button>
                </div>
                <button class="nexus-t69-btn ghost wide" data-act="loadMore">Načítať ďalšiu stranu →</button>
                <button class="nexus-t69-btn ghost wide" data-act="loadAll">Načítať všetky strany ⏬</button>
                <div class="nexus-t69-row" data-group="sort">
                    <button data-sort="sizeDesc">Veľkosť ↓</button><button data-sort="sizeAsc">Veľkosť ↑</button>
                    <button data-sort="qualDesc">Kvalita ↓</button><button data-sort="qualAsc">Kvalita ↑</button>
                    <button data-sort="durDesc">Dĺžka ↓</button><button data-sort="durAsc">Dĺžka ↑</button>
                </div>
                <div class="nexus-t69-row" data-group="qual">
                    <button data-qual="4K">4K</button><button data-qual="2K">2K</button>
                    <button data-qual="1080p">1080p</button><button data-qual="720p">720p</button><button data-qual="SD">SD</button>
                </div>
                <div class="nexus-t69-num">
                    <span>Veľkosť MB</span>
                    <input data-role="sizeMin" placeholder="min" inputmode="numeric">
                    <input data-role="sizeMax" placeholder="max" inputmode="numeric">
                </div>
                <div class="nexus-t69-num">
                    <span>Dĺžka min</span>
                    <input data-role="durMin" placeholder="min" inputmode="numeric">
                    <input data-role="durMax" placeholder="max" inputmode="numeric">
                </div>
                <div class="nexus-t69-count" data-role="count">0 vybraných</div>
                <div class="nexus-t69-actions">
                    <button class="nexus-t69-btn" data-act="selectFiltered">Vybrať filtrované</button>
                    <button class="nexus-t69-btn" data-act="clear">Zrušiť</button>
                </div>
                <button class="nexus-t69-btn ghost wide" data-act="onlySelected">👁 Skryť nevybrané</button>
                <button class="nexus-t69-btn primary wide" data-act="import">Import vybraných</button>
                <button class="nexus-t69-btn ghost wide" data-act="importFiltered">Import všetkých filtrovaných</button>
            </div>`;
        document.body.appendChild(bar);
        wireToolbar(bar);
    }

    function wireToolbar(bar) {
        bar.querySelector('[data-act="collapse"]').addEventListener('click', () => {
            bar.classList.toggle('collapsed');
        });
        bar.querySelector('[data-role="q"]').addEventListener('input', (e) => {
            state.q = e.target.value; applyMatchDimming(); updateToolbar();
        });
        for (const role of ['sizeMin', 'sizeMax', 'durMin', 'durMax']) {
            bar.querySelector(`[data-role="${role}"]`).addEventListener('input', (e) => {
                state[role] = e.target.value.replace(/[^\d]/g, ''); applyMatchDimming(); updateToolbar();
            });
        }
        bar.querySelectorAll('[data-sort]').forEach((btn) => btn.addEventListener('click', () => {
            state.sort = state.sort === btn.dataset.sort ? 'none' : btn.dataset.sort;
            bar.querySelectorAll('[data-sort]').forEach((b) => b.classList.toggle('on', b.dataset.sort === state.sort));
            applyMatchDimming(); applyCardSort(); updateToolbar();
        }));
        bar.querySelectorAll('[data-qual]').forEach((btn) => btn.addEventListener('click', () => {
            const t = btn.dataset.qual;
            if (state.qualities.has(t)) state.qualities.delete(t); else state.qualities.add(t);
            btn.classList.toggle('on', state.qualities.has(t));
            applyMatchDimming(); updateToolbar();
        }));
        bar.querySelector('[data-act="selectFiltered"]').addEventListener('click', () => {
            for (const it of filteredItems()) state.selectedIds.add(it.key);
            refreshCheckboxes(); applyMatchDimming(); updateToolbar();
        });
        bar.querySelector('[data-act="clear"]').addEventListener('click', () => {
            state.selectedIds.clear(); refreshCheckboxes(); applyMatchDimming(); updateToolbar();
        });
        bar.querySelector('[data-act="onlySelected"]').addEventListener('click', () => {
            state.onlySelected = !state.onlySelected;
            applyMatchDimming(); applyCardSort(); updateToolbar();
        });
        bar.querySelector('[data-act="import"]').addEventListener('click', () => {
            importItems([...state.selectedIds].map((k) => state.items.get(k)).filter(Boolean))
                .catch((e) => toast(e?.message || 'Import zlyhal', true));
        });
        bar.querySelector('[data-act="importFiltered"]').addEventListener('click', () => {
            importItems(filteredItems()).catch((e) => toast(e?.message || 'Import zlyhal', true));
        });
        bar.querySelector('[data-act="loadMore"]').addEventListener('click', () => { loadMore(); });
        bar.querySelector('[data-act="loadAll"]').addEventListener('click', () => { loadAll(); });
        const pageInput = bar.querySelector('[data-role="pageCount"]');
        const runLoadN = () => loadN(pageInput?.value);
        bar.querySelector('[data-act="loadN"]').addEventListener('click', runLoadN);
        pageInput?.addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/[^\d]/g, '');
        });
        pageInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); runLoadN(); }
        });

        // Extra tag filter + on-demand tag enrichment from detail pages.
        const tagInput = bar.querySelector('[data-role="tagFilter"]');
        tagInput?.addEventListener('input', (e) => {
            state.tagFilter = e.target.value;
            applyMatchDimming(); applyCardSort(); updateToolbar();
        });
        bar.querySelector('[data-act="loadTags"]').addEventListener('click', () => {
            // If a tag filter is typed, we still need tags for ALL loaded cards to
            // know which ones qualify — enrich the whole set.
            enrichTags([...state.items.values()]).catch((e) => toast(e?.message || 'Načítanie tagov zlyhalo', true));
        });
    }

    function refreshCheckboxes() {
        for (const it of state.items.values()) {
            if (!it._node) continue;
            const cb = it._node.querySelector(`.${CHECKBOX_CLASS} input`);
            if (cb) cb.checked = state.selectedIds.has(it.key);
            it._node.classList.toggle(CARD_SELECTED_CLASS, state.selectedIds.has(it.key));
        }
    }

    function updateToolbar() {
        const bar = document.getElementById(TOOLBAR_ID);
        if (!bar) return;
        const n = state.selectedIds.size;
        const shown = filteredItems().length;
        bar.querySelector('[data-role="count"]').textContent =
            `${n} vybraných · ${shown} filtrovaných / ${state.items.size} kariet`;
        const imp = bar.querySelector('[data-act="import"]');
        imp.disabled = state.busy || n === 0;
        imp.textContent = state.busy ? 'Importujem…' : `Import vybraných (${n})`;
        const impF = bar.querySelector('[data-act="importFiltered"]');
        impF.disabled = state.busy || shown === 0;
        const onlyBtn = bar.querySelector('[data-act="onlySelected"]');
        if (onlyBtn) {
            onlyBtn.classList.toggle('on', state.onlySelected);
            onlyBtn.disabled = !state.onlySelected && n === 0;
            onlyBtn.textContent = state.onlySelected ? '👁 Zobraziť všetky' : '👁 Skryť nevybrané';
        }
        updateLoadMoreBtn();
    }

    // ── Import ───────────────────────────────────────────────────────────────────

    async function importItems(picked) {
        if (!picked.length) { toast('Nič nie je vybrané'); return; }
        state.busy = true; updateToolbar();
        try {
            const items = picked.map((it) => ({
                url: it.url,
                source_url: it.url,
                title: it.title || '69Tubed Video',
                thumbnail: it.thumbnail || '',
                quality: it.quality || '',
                // Include any detail-page tags we fetched, plus the source marker.
                tags: ['69tubed', ...((it.tags || []).slice(0, 40))],
            }));
            const batchName = `69Tubed Quick Import: ${document.title.trim()}`;
            const res = await chrome.runtime.sendMessage({ action: 'TUBED69_IMPORT_BULK', batchName, items });
            if (!res?.ok) throw new Error(res?.error || 'Import do dashboardu zlyhal');
            toast(`Zaradených ${res.imported ?? items.length} videí — sleduj Import Desk`);
            state.selectedIds.clear(); refreshCheckboxes();
        } finally {
            state.busy = false; updateToolbar();
        }
    }

    // ── Boot ───────────────────────────────────────────────────────────────────

    function boot() {
        createToolbar();
        state.loadedMaxPage = currentPageNum();
        state._lastPage = detectLastPage();
        scanCards();
        setInterval(scanCards, SCAN_INTERVAL_MS);
        new MutationObserver(() => {
            const signature = `${location.href}|${getCardNodes().length}`;
            if (signature === state.lastSignature) return;
            state.lastSignature = signature;
            scanCards();
        }).observe(document.documentElement, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
