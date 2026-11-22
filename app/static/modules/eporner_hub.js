/*
 * eporner_hub.js — Fusion Hub dashboard module.
 *
 * A fast, in-dashboard discovery surface for Eporner, styled after the PornHub
 * Hub. Backed by app/hubs/eporner.py which uses Eporner's official JSON API, so
 * every tile arrives with full metadata (duration, tags, views, rating) in one
 * ~8ms call — no enrich round-trip. All refinement (keyword include/exclude,
 * tag chips, min/max duration, length sort) happens client-side and instantly.
 *
 * This is a composeDashboard() module factory: it returns an object that merges
 * into the Alpine `dashboard` state. It is loaded (deferred) before main.js and
 * added to the composeDashboard([...]) array there.
 */
function createEpornerHubModule() {
    return {
        _ephOrientationProbeInProgress: false,
        _ephOrientationProbed: new Set(),
        _ephOrientationThumbnailPending: new Set(),
        _ephOrientationThumbnailScanInProgress: false,
        _ephOrientationRefreshPending: false,
        ephub: {
            open: false,
            source: 'eporner',
            sources: [
                { source: 'eporner', label: 'Eporner', capabilities: { categories: true, related: true, pornstars: true, playlists: true } },
                { source: 'whoreshub', label: 'WhoresHub', capabilities: { categories: true, related: true, playlists: true } },
                { source: 'porntrex', label: 'PornTrex', capabilities: { categories: true, related: true, playlists: true } },
                { source: 'camwhores', label: 'Camwhores', capabilities: { categories: true, related: true, pornstars: true, playlists: true } },
            ],
            q: '',
            sort: 'recent',
            page: 1,
            // Prime Cut — federated "best of every source" for one keyword.
            primeMinH: 1080,
            primeN: 10,
            primeLoose: false,
            prime: { running: false, groups: [], tookMs: 0, on: false },
            // Curated tag-mix presets ("deepthroat + big tits + POV"). The list
            // comes from the server so the ids and their tuned relevance bars
            // live in one place; `presetActive` is the id currently showing.
            presets: [],
            presetActive: '',
            presetsOpen: false,
            // Shared task strip: any long operation registers here so the user can
            // see what is running, how far along it is, and what it last touched.
            busy: [],
            pageSize: 0,
            items: [],
            loading: false,
            hasMore: true,
            total: 0,
            tookMs: 0,
            // ALL exposes one outcome per source so a zero, timeout, and HTTP
            // failure never look like the same thing.
            allDiagnostics: [],
            allPerSource: 12,   // best N kept per source in the ALL fan-out
            // Sources that matched nothing still send their three best tiles.
            // They stay out of the grid until asked for, so a specific search is
            // not buried under near-misses from ten other sites.
            showWeak: false,
            allDeadline: 8,     // seconds before a straggling source is cancelled
            // grid density: 3 / 5 / 7 columns
            cols: 7,
            // index of the keyboard-focused card in the filtered grid (-1 = none)
            focusIdx: -1,
            // the extra refinement drawer, collapsed by default
            moreOpen: false,
            // client-side refinement
            durMin: '',        // minutes
            durMax: '',        // minutes
            inc: '',           // title/tags must contain
            exc: '',           // comma list to exclude
            activeTags: [],    // clicked tag chips (AND)
            lenSort: '',       // '', 'asc', 'desc'
            qualSort: '',      // '', 'asc', 'desc' — by resolution height
            sizeSort: '',      // '', 'asc', 'desc' — by file size (needs enrich)
            // Date is kept separate from the source's feed order.  In ALL this
            // makes Recent a real global timeline rather than a round-robin mix
            // of twelve "recent" cards from each source.
            dateSort: 'desc',  // '', 'asc' (oldest), 'desc' (newest); Recent defaults newest-first
            minHeight: 0,      // quality floor: 0/720/1080/1440/2160
            qualPick: [],      // exact quality buckets (multi): [720,1080,1440,2160]
            orientation: 'all', // 'all', 'landscape', 'portrait', 'portrait_any', 'portrait_estimate'
            selected: [],      // urls ticked for bulk import
            player: { open: false, loading: false, title: '', error: '', item: null, source: 'eporner', portrait: false },
            related: { loading: false, mode: 'same', items: [], forTitle: '' },
            trail: [],
            enriching: false, enrichDone: 0, enrichTotal: 0,
            // Auto-metadata sweep over every loaded card (quality + size + date).
            // `done/total` drive the progress bar; `sized`/`dated` are recounted
            // from the grid so the readout can never claim more than the cards show.
            meta: { running: false, done: 0, total: 0, sized: 0, dated: 0, failed: 0, note: '' },
            autoFetch: true, autoFetchDone: 0,
            loadMoreN: 5,      // how many extra pages the "load N pages" button pulls
            // pornstar mode
            view: 'feed',      // 'feed' | 'pornstar' | 'playlists' | 'playlist'
            psSlug: '', psName: '', psAvatar: '',
            psQuery: '', psFinding: false,
            // categories (scraped list) + active category filter
            cats: [], catsLoaded: false,
            activeCat: '',     // slug of the selected category (combines with feed/performer)
            activeCatName: '',
            catBarOpen: false, // category dropdown open
            catFilter: '',     // category dropdown search text
            tagBarOpen: false, // tag dropdown open
            tagFilter: '',     // tag dropdown search text
            // playlists mode
            playlists: [], plLoading: false, plHasMore: true, plPage: 1,
            plQuery: '', plFinding: false, plMatches: [],
            plId: '', plName: '', plLatestDate: '',  // currently opened playlist
            // member mode (a Camwhores uploader = posted + favourites + playlists)
            memberQuery: '', memberLoading: false,
            member: null,          // {member_id,name,avatar,posted_count,favourite_count,public_count,private_count,playlists[]}
            memberKind: 'posted',  // 'posted' | 'favourites'
            // IP protection status (tor / proxy / direct)
            net: { mode: '', protected: false, min_gap: 0, concurrency: 0, tor: null },
            torBusy: false,
            // radar: url -> 'library' | 'discovered' | 'unknown' (do I already have it?)
            radar: {},
            radarOn: true,
            // watch-later shortlist (persisted) — a middle step between see & import
            watchLater: [],
            // continue watching: [{url,source,title,thumb,pos,dur,at}] (persisted)
            continueWatch: [],
            // recent search queries (persisted) + dropdown
            searchHistory: [], histOpen: false,
            // follows + inbox (server-backed)
            follows: [], inbox: { open: false, total: 0, loading: false },
            // hub<->library semantic panel (inside the player)
            libSim: { loading: false, items: [], forTitle: '' },
        },
        _ephSeq: 0,
        //: Bumped whenever a metadata sweep is superseded, so a sweep still
        //: walking the previous grid stops instead of patching stale cards.
        _ephMetaRun: 0,
        _ephHls: null,
        _ephDebounce: null,
        _ephAutoTimer: null,

        // ── lifecycle ──────────────────────────────────────────────────────
        ephApi(source = '') { return `/api/v1/hub/${source || this.ephub.source}`; },

        // ══ Shared task strip ═══════════════════════════════════════════════
        // One place every slow operation reports to, so "is it working or stuck?"
        // is always answerable. total=0 means an unknown-length job (shown as a
        // sweeping bar); note carries the last thing the job touched.
        ephBusyStart(key, label, total = 0, icon = 'sync') {
            const rec = { key, label, icon, done: 0, total, note: '', at: Date.now() };
            const i = this.ephub.busy.findIndex(b => b.key === key);
            if (i >= 0) this.ephub.busy.splice(i, 1, rec); else this.ephub.busy.push(rec);
            return rec;
        },
        ephBusyStep(key, done, note = '', total = null) {
            const i = this.ephub.busy.findIndex(b => b.key === key);
            if (i < 0) return;
            const b = this.ephub.busy[i];
            this.ephub.busy.splice(i, 1, {
                ...b,
                done: done != null ? done : b.done,
                total: total != null ? total : b.total,
                note: note || b.note,
            });
        },
        ephBusyEnd(key) {
            const i = this.ephub.busy.findIndex(b => b.key === key);
            if (i >= 0) this.ephub.busy.splice(i, 1);
        },
        ephBusyPct(b) {
            return b.total > 0 ? Math.min(100, Math.round((b.done / b.total) * 100)) : 0;
        },
        ephBusyElapsed(b) {
            const s = Math.max(0, Math.round((Date.now() - b.at) / 1000));
            return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
        },
        // Build the REAL playlist URL on the source site so the user can verify the
        // videos come from that playlist (and check the count matches).
        ephPlaylistUrl() {
            const h = this.ephub;
            const pid = h.plId || '';
            if (!pid) return '';
            const origins = {
                camwhores: 'https://www.camwhores.tv/playlists/',
                whoreshub: 'https://www.whoreshub.com/playlists/',
                porntrex: 'https://www.porntrex.com/playlists/',
                eporner: 'https://www.eporner.com/playlist/',
            };
            const base = origins[h.source];
            if (!base) return '';
            // KVS pid is "id/slug"; Eporner pid is a bare id.
            return base + pid.replace(/^\/+/, '') + '/';
        },
        ephSourceMeta(source = '') {
            const key = source || this.ephub.source;
            return this.ephub.sources.find(s => s.source === key) || { source: key, label: key, capabilities: {} };
        },
        ephSourceLabel(source = '') { return this.ephSourceMeta(source).label || source; },
        ephHas(capability) { return !!this.ephSourceMeta().capabilities?.[capability]; },
        async ephLoadSources() {
            try {
                const r = await fetch('/api/v1/hub/sources');
                const d = await r.json();
                if (r.ok && d.sources?.length) {
                    // Prepend the ALL pseudo-source: a federated fan-out over every real hub.
                    this.ephub.sources = [
                        { source: 'all', label: 'ALL', capabilities: {} },
                        ...d.sources,
                    ];
                    this.ephEnsureValidSort();
                }
            } catch (_) { }
        },
        async ephOpen() {
            this.ephub.open = true;
            this.ephub.sort = 'recent';
            this.ephRestore();
            await this.ephLoadSources();
            // resume the source the user last used (persisted), if still available
            const rs = this.ephub._restoredSource;
            if (rs && this.ephub.sources.some(s => s.source === rs)) this.ephub.source = rs;
            this.ephLoadNetStatus(); this.ephLoadCats();
            this.ephLoadFollows().then(() => this.ephCheckInbox());
            if (!this.ephub.items.length) this.ephLoad(false);
        },
        async ephOpenSource(source) {
            this.ephub.open = true;
            this.ephub.sort = 'recent';
            await this.ephLoadSources();
            if (source && source !== this.ephub.source) await this.ephSetSource(source);
            else {
                await Promise.all([this.ephLoadCats(), this.ephLoadNetStatus()]);
                if (!this.ephub.items.length) await this.ephLoad(false);
            }
        },
        async ephSetSource(source) {
            const h = this.ephub;
            if (!source || h.source === source) return;
            this.ephClosePlayer();
            h.source = source; h.sort = 'recent'; h.page = 1; h.pageSize = 0;
            h.q = ''; h.items = []; h.total = 0; h.hasMore = true; h.selected = [];
            h.view = 'feed'; h.activeCat = ''; h.activeCatName = ''; h.activeTags = [];
            h.cats = []; h.catsLoaded = false; h.net = { mode: '', protected: false, tor: null };
            h.autoFetch = true;
            this.ephEnsureValidSort();
            this.ephTrailPush('source', this.ephSourceLabel(source));
            this.ephPersist();
            await Promise.all([this.ephLoadCats(), this.ephLoadNetStatus()]);
            await this.ephLoad(false);
        },
        async ephLoadCats() {
            if (this.ephub.catsLoaded) return;
            try {
                const r = await fetch(`${this.ephApi()}/categories`);
                if (r.ok) {
                    const d = await r.json();
                    this.ephub.cats = d.categories || [];
                    this.ephub.catsLoaded = true;
                }
            } catch (_) { }
        },
        async ephLoadNetStatus() {
            try {
                const r = await fetch(`${this.ephApi()}/netstatus`);
                if (r.ok) this.ephub.net = await r.json();
            } catch (_) { }
        },
        async ephTorPrimaryAction() {
            const h = this.ephub;
            if (h.torBusy || h.source !== 'eporner') return;
            h.torBusy = true;
            const ready = !!h.net?.tor?.ready;
            const action = ready ? 'new-identity' : 'start';
            try {
                const r = await fetch(`/api/v1/tor/${action}`, { method: 'POST' });
                const d = await r.json().catch(() => ({}));
                if (!r.ok) {
                    const detail = d?.detail || d;
                    throw new Error(detail?.last_error || detail?.message || `Tor ${action} zlyhal`);
                }
                await this.ephLoadNetStatus();
                this.showToast(
                    ready ? 'Tor používa novú identitu' : 'Tor je spustený a pripravený',
                    'security', 'success', 2200
                );
            } catch (e) {
                await this.ephLoadNetStatus();
                this.showToast(`Tor: ${e?.message || 'operácia zlyhala'}`, 'error', 'error', 3500);
            } finally {
                h.torBusy = false;
            }
        },
        // A non-blocking caution instead of a blocking confirm(). The dialog
        // used to gate "Doplniť metadáta" on window.confirm(), and Chrome
        // silently auto-answers "cancel" to every confirm() on a page after
        // the user has dismissed a few of them ("Prevent this page from
        // creating additional dialogs") — so the button looked simply dead,
        // while the identical action via the bulk "Refetch" button (which
        // skips this gate) worked. It also read `ephub.net`, a SINGLE
        // source's status, which is meaningless in ALL mode — exactly where
        // a big batch is most likely. The risk itself (scraping from a
        // direct, unprotected IP) is already visible in the shield badge at
        // all times, so a toast is enough; it never blocks the action.
        ephEnrichCaution() {
            const h = this.ephub;
            if (h.source === 'all' || h.net.protected || h.net.fallback_available) return;
            this.showToast(
                'Sťahujem metadáta priamo z tvojej IP (Tor/proxy je vypnuté) — veľký zoznam môže naraziť na rate-limit.',
                'gpp_maybe', 'warning', 3200
            );
        },
        ephClose() { this.ephClosePlayer(); this.ephub.open = false; },

        // ── data load (sequence-guarded so a new search wins over a slow one) ─
        _ephParams() {
            const h = this.ephub;
            const p = new URLSearchParams();
            p.set('sort', h.sort);
            p.set('page', String(h.page));
            if (h.q.trim()) p.set('q', h.q.trim());
            if (h.activeCat) p.set('category', h.activeCat);
            return p;
        },
        _ephUrl() {
            const h = this.ephub;
            const api = this.ephApi();
            if (h.view === 'playlist' && h.plId) {
                const p = new URLSearchParams();
                p.set('pid', h.plId); p.set('page', String(h.page));
                return `${api}/playlist?${p}`;
            }
            if (h.view === 'pornstar' && h.psSlug) {
                const p = new URLSearchParams();
                p.set('slug', h.psSlug); p.set('sort', h.sort); p.set('page', String(h.page));
                // category applies as an extra client-side intersection (see ephFilteredItems)
                return `${api}/pornstar?${p}`;
            }
            return `${api}/search?${this._ephParams()}`;
        },
        async ephLoad(append = false, targetPage = null, opts = {}) {
            const h = this.ephub;
            // A fresh load (new search, sort, category, source…) always leaves
            // Prime Cut mode. `ephPrimeCut()` sets `prime.on` and `prime.groups`
            // but nothing ever cleared them again except its own close button —
            // so typing a new keyword replaced the grid with a normal ALL
            // search while the Prime Cut summary strip kept showing, its card
            // count live-bound to the new (correct) total but its per-source
            // chips still the OLD query's numbers. "Load more" (append) keeps
            // whatever mode was already active, since it is a continuation of
            // the same result set, not a new one.
            if (!append && h.prime.on) { h.prime.on = false; h.prime.groups = []; h.presetActive = ''; }
            // ALL = federated fan-out across every real source (feed/search only)
            if (h.source === 'all' && (h.view === 'feed')) {
                // A CONFIRMED keyword in ALL (Enter, not live-typing) wants the
                // best matches, not just the newest ones — Prime Cut already does
                // exactly that (relevance + verified-quality gate per source) but
                // used to require its own button. Live-typing (debounced) still
                // uses the cheap raw fan-out so keystrokes stay fast; only the
                // deliberate confirm pays for Prime Cut's deeper (up to 90s)
                // per-source verification pass. Prime Cut has no pagination
                // concept (fixed top-N per source), so "Load more" and an empty
                // query keep the plain fan-out too.
                if (!append && targetPage == null && h.q.trim() && opts.confirmed) {
                    return this.ephPrimeCut();
                }
                if (targetPage != null) h.page = Math.max(1, Number(targetPage) || 1);
                return this.ephLoadAll(append);
            }
            if (append && h.loading) return;
            const seq = (this._ephSeq = this._ephSeq + 1);
            h.loading = true;
            if (targetPage != null) h.page = Math.max(1, Number(targetPage) || 1);
            if (!append) {
                if (targetPage == null) h.page = 1;
                h.items = [];
                // new search: reset in-flight tracking + progress from the old one
                this._ephDispatched = new Set();
                this._ephDeepDispatched = new Set();
                this._ephInflight = 0;
                h.enriching = false; h.enrichTotal = 0; h.enrichDone = 0;
                // Abandon any metadata sweep still walking the OLD grid.
                this._ephMetaRun = (this._ephMetaRun || 0) + 1;
                h.meta = { running: false, done: 0, total: 0, sized: 0, dated: 0, failed: 0, note: '' };
            }
            try {
                const r = await fetch(this._ephUrl());
                const data = await r.json();
                if (seq !== this._ephSeq) return;   // a newer load superseded us
                if (!r.ok) throw new Error(data.detail || 'Načítanie zlyhalo');
                const items = (data.items || []).map(item => ({ ...item, source: item.source || h.source }));
                if (append) {
                    const have = new Set(h.items.map(i => i.url));
                    h.items = h.items.concat(items.filter(i => i.url && !have.has(i.url)));
                } else {
                    h.items = items;
                }
                h.pageSize = items.length || h.pageSize;
                h.total = data.total || h.total;
                h.tookMs = data.took_ms || 0;
                h.hasMore = !!data.has_more;
                if (h.view === 'playlist' && data.latest_upload_date) {
                    const current = h.plLatestDate || '';
                    h.plLatestDate = current > data.latest_upload_date ? current : data.latest_upload_date;
                }
                this.ephTrailPush(h.q ? 'search' : (h.activeCat ? 'category' : 'page'),
                    h.q || h.activeCatName || `${this.ephSourceLabel()} · ${h.page}`);
                if (!append && h.q.trim()) this.ephPushHistory(h.q.trim());
                this._ephAfterLoad();
            } catch (e) {
                if (seq === this._ephSeq) this.showToast(e.message || 'Chyba', 'error', 'error');
            } finally {
                if (seq === this._ephSeq) h.loading = false;
            }
        },
        ephSearchDebounced() {
            // typing in the main box is always a global (feed) search
            if (this.ephub.q.trim() && this.ephub.view !== 'feed') {
                this.ephub.view = 'feed'; this.ephub.psSlug = ''; this.ephub.plId = '';
            }
            clearTimeout(this._ephDebounce);
            this._ephDebounce = setTimeout(() => this.ephLoad(false), 250);
        },
        // Kept fully browsable on their own tab; left out of the default ALL
        // fan-out (mirrors app/routers/hub.py's `_ALL_DEFAULT_EXCLUDE`).
        _EPH_ALL_DEFAULT_EXCLUDE: ['tnaflix', 'redtube'],
        // Every sort the UI knows how to label, in display order.
        _EPH_SORTS: [
            ['recent', 'Najnovšie', 'schedule'],
            ['relevance', 'Relevantné', 'manage_search'],
            ['hottest', 'Trendy', 'local_fire_department'],
            ['popular', 'Populárne', 'local_fire_department'],
            ['top_rated', 'Hodnotené', 'star'],
            ['most_viewed', 'Sledované', 'visibility'],
            ['longest', 'Najdlhšie', 'timelapse'],
        ],
        // Render only the sorts the current source ACTUALLY honours, as declared
        // by its adapter (`supported_sorts` -> /hub/sources). The bar used to be
        // six hard-coded Eporner sorts for every source, while xHamster,
        // XVideos, RedTube and NoodleMagazine ignored the parameter entirely —
        // so four buttons out of six re-ran the identical request and the user
        // was left thinking sorting was broken. In ALL, only the sorts every
        // selected source shares are offered.
        ephSortOptions() {
            const h = this.ephub;
            const known = this._EPH_SORTS;
            let allowed;
            if (h.source === 'all') {
                const lists = h.sources.filter(s => s.source !== 'all')
                    .map(s => s.capabilities?.sorts).filter(Boolean);
                allowed = lists.length
                    ? lists.reduce((a, b) => a.filter(x => b.includes(x)))
                    : null;
            } else {
                allowed = this.ephSourceMeta().capabilities?.sorts || null;
            }
            // No declaration yet (older server) -> show everything, as before.
            if (!allowed || !allowed.length) return known;
            const out = known.filter(s => allowed.includes(s[0]));
            return out.length ? out : [known[0]];
        },
        // Keep `sort` valid when switching to a source that lacks the current one,
        // otherwise the bar would show nothing selected and the source would
        // silently fall back to its default order.
        ephEnsureValidSort() {
            const options = this.ephSortOptions().map(s => s[0]);
            if (!options.includes(this.ephub.sort)) this.ephub.sort = options[0] || 'recent';
        },
        // Clicking a sort always (re)loads — clicking the CURRENT sort acts as a
        // manual refresh, so "Recent" re-fetches the newest uploads instead of
        // showing the stale page from when the hub was first opened.
        ephSetSort(s) {
            const h = this.ephub;
            h.sort = s;
            // Recent has a precise promise in ALL: all dated cards are ordered
            // newest-first after the sources have been merged.
            if (s === 'recent') {
                h.dateSort = 'desc';
                h.lenSort = ''; h.qualSort = ''; h.sizeSort = '';
            } else {
                // Relevance / popularity / rating keep the source ranking until
                // the user explicitly chooses one of the date buttons.
                h.dateSort = '';
            }
            this.ephLoad(false);
        },
        ephPageNumbers() {
            const h = this.ephub;
            const last = (h.total && h.pageSize) ? Math.max(1, Math.ceil(h.total / h.pageSize)) : null;
            const start = Math.max(1, h.page - 2);
            const end = last ? Math.min(last, Math.max(h.page + 2, 5)) : h.page + (h.hasMore ? 2 : 0);
            const pages = [];
            for (let p = start; p <= end; p++) pages.push(p);
            return pages;
        },
        ephGoPage(page) {
            if (page < 1 || (page > this.ephub.page && !this.ephub.hasMore)) return;
            this.ephLoad(false, page);
            this.$nextTick(() => this.$refs.ephgrid?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        },
        ephTrailPush(kind, label) {
            if (!label) return;
            const h = this.ephub;
            const snapshot = {
                kind, label, source: h.source, q: h.q, category: h.activeCat,
                categoryName: h.activeCatName, page: h.page, sort: h.sort
            };
            const key = [snapshot.source, snapshot.q, snapshot.category, snapshot.page, snapshot.sort].join('|');
            if (h.trail[0]?.key === key) return;
            h.trail.unshift({ ...snapshot, key });
            h.trail = h.trail.slice(0, 8);
        },
        async ephTrailOpen(step) {
            if (!step) return;
            const h = this.ephub;
            h.source = step.source; h.q = step.q; h.activeCat = step.category;
            h.activeCatName = step.categoryName; h.sort = step.sort || 'recent'; h.view = 'feed';
            h.cats = []; h.catsLoaded = false; h.autoFetch = true;
            await this.ephLoadCats();
            await this.ephLoad(false, step.page || 1);
        },
        ephQuick4K() {
            const slug = this.ephub.source === 'whoreshub' ? '4k' : '4k-porn';
            this.ephub.sort = 'recent';
            this.ephSetCat(slug, '4K');
        },

        // ── categories ─────────────────────────────────────────────────────
        // Selecting a category re-queries the feed (API keyword). In performer
        // view it stays as a client-side intersection so herec + kategória work
        // together without leaving the performer's videos.
        ephSetCat(slug, name) {
            const h = this.ephub;
            h.sort = 'recent';
            if (h.activeCat === slug) { h.activeCat = ''; h.activeCatName = ''; }
            else { h.activeCat = slug; h.activeCatName = name || slug.replace(/-/g, ' '); }
            if (h.view === 'pornstar') return;      // intersection is client-side
            if (h.view === 'playlist') { this.ephBackToFeed(); return; }
            this.ephLoad(false);                     // feed: server re-query
        },
        ephClearCat() {
            this.ephub.activeCat = ''; this.ephub.activeCatName = '';
            if (this.ephub.view === 'feed') this.ephLoad(false);
        },
        // open a category from a video card's own category chip (jump to feed)
        ephOpenCategory(slug, name) {
            const h = this.ephub;
            h.view = 'feed'; h.psSlug = ''; h.plId = ''; h.q = '';
            h.sort = 'recent';
            h.activeCat = slug; h.activeCatName = name || slug.replace(/-/g, ' ');
            this.ephLoad(false);
        },
        // categories filtered by the dropdown search box
        ephCatList() {
            const f = (this.ephub.catFilter || '').trim().toLowerCase();
            const fallback = [
                { slug: '4k-porn', name: '4K' },
                { slug: 'pov-porn', name: 'POV' },
                { slug: 'vr-porn', name: 'VR' },
                { slug: 'anal', name: 'Anal' },
                { slug: 'teen', name: 'Teen' },
                { slug: 'big-tits', name: 'Big Tits' },
                { slug: 'deepthroat', name: 'Deepthroat' },
                { slug: 'blowjob', name: 'Blowjob' },
                { slug: 'amateur', name: 'Amateur' },
                { slug: 'milf', name: 'MILF' },
            ];
            const cats = this.ephub.cats.length ? this.ephub.cats : fallback;
            if (!f) return cats;
            return cats.filter(c => (c.name + ' ' + c.slug).toLowerCase().includes(f));
        },
        // top tags on loaded tiles, filtered by the dropdown search box
        ephTagList() {
            const f = (this.ephub.tagFilter || '').trim().toLowerCase();
            let tags = this.ephTopTags(60);
            if (!tags.length) tags = ['4k', 'pov', 'deepthroat', 'blowjob', 'amateur', 'milf', 'big tits'];
            if (f) tags = tags.filter(t => t.includes(f));
            return tags.slice(0, 40);
        },
        // keyword(s) a category should match against a tile's title+tags
        _ephCatNeedles() {
            const n = (this.ephub.activeCatName || this.ephub.activeCat || '').toLowerCase();
            return n.split(/[^a-z0-9]+/).filter(w => w.length >= 2);
        },

        // ── pornstar mode ──────────────────────────────────────────────────
        // open a performer's videos (from a card chip or the finder)
        async ephOpenPornstar(slug, name) {
            const h = this.ephub;
            h.view = 'pornstar'; h.psSlug = slug; h.psName = name || slug.replace(/-/g, ' ');
            h.q = ''; h.activeTags = []; h.psQuery = '';
            this.showToast(`Herec: ${h.psName}`, 'person', 'info', 1200);
            await this.ephLoad(false);
        },
        // resolve a typed name → performer page
        async ephFindPornstar() {
            const q = (this.ephub.psQuery || '').trim();
            if (!q) return;
            this.ephub.psFinding = true;
            try {
                const r = await fetch(`${this.ephApi()}/pornstar-find?q=${encodeURIComponent(q)}`);
                const d = await r.json();
                if (r.ok && d.found) {
                    await this.ephOpenPornstar(d.slug, d.name);
                } else {
                    this.showToast(`Herec "${q}" nenájdený`, 'person_off', 'error', 2200);
                }
            } catch (e) {
                this.showToast(e.message || 'Vyhľadanie herca zlyhalo', 'error', 'error');
            } finally { this.ephub.psFinding = false; }
        },
        ephBackToFeed() {
            const h = this.ephub;
            h.view = 'feed'; h.psSlug = ''; h.psName = ''; h.plId = ''; h.plName = ''; h.plLatestDate = '';
            h.member = null;
            h.sort = 'recent';
            this.ephLoad(false);
        },

        // ── playlists mode ─────────────────────────────────────────────────
        // Enter the "recently updated playlists" browser.
        async ephOpenPlaylists() {
            const h = this.ephub;
            h.view = 'playlists'; h.plId = ''; h.plName = ''; h.plLatestDate = '';
            if (!h.playlists.length) await this.ephLoadPlaylists(false);
        },
        async ephLoadPlaylists(append = false) {
            const h = this.ephub;
            if (h.plLoading) return;
            h.plLoading = true;
            if (!append) { h.plPage = 1; h.playlists = []; }
            try {
                const r = await fetch(`${this.ephApi()}/playlists?page=${h.plPage}`);
                const d = await r.json();
                if (!r.ok) throw new Error(d.detail || 'Načítanie playlistov zlyhalo');
                const items = d.items || [];
                if (append) {
                    const have = new Set(h.playlists.map(p => p.id));
                    h.playlists = h.playlists.concat(items.filter(p => p.id && !have.has(p.id)));
                } else { h.playlists = items; }
                h.plHasMore = !!d.has_more;
            } catch (e) {
                this.showToast(e.message || 'Chyba playlistov', 'error', 'error');
            } finally { h.plLoading = false; }
        },
        ephLoadMorePlaylists() { this.ephub.plPage++; this.ephLoadPlaylists(true); },
        // Open one playlist's videos into the main grid.
        async ephOpenPlaylist(pid, name) {
            const h = this.ephub;
            h.view = 'playlist'; h.plId = pid; h.plName = name || 'Playlist'; h.plLatestDate = '';
            h.q = ''; h.activeTags = [];
            this.showToast(`Playlist: ${h.plName}`, 'playlist_play', 'info', 1200);
            await this.ephLoad(false);
        },
        // Resolve a pasted playlist URL/id or a title search. Multiple title
        // matches → show a pick-list; a single match / pasted URL → open directly.
        async ephFindPlaylist() {
            const q = (this.ephub.plQuery || '').trim();
            if (!q) return;
            this.ephub.plFinding = true;
            this.ephub.plMatches = [];
            try {
                const r = await fetch(`${this.ephApi()}/playlist-find?q=${encodeURIComponent(q)}`);
                const d = await r.json();
                if (!r.ok || !d.found) {
                    this.showToast(`Playlist "${q}" nenájdený`, 'error', 'error', 2200);
                    return;
                }
                const matches = d.matches || [];
                if (matches.length > 1) {
                    // Let the user choose which playlist to open.
                    this.ephub.plMatches = matches;
                    this.showToast(`Našlo sa ${matches.length} playlistov — vyber jeden`, 'playlist_play', 'info', 2000);
                } else {
                    await this.ephOpenPlaylist(d.id, d.name || q);
                }
            } catch (e) {
                this.showToast(e.message || 'Hľadanie playlistu zlyhalo', 'error', 'error');
            } finally { this.ephub.plFinding = false; }
        },
        ephPickPlaylistMatch(m) {
            this.ephub.plMatches = [];
            this.ephOpenPlaylist(m.id, m.name);
        },

        // ── member mode (uploader = posted + favourites + playlists) ─────────
        // A member has their own URL (/members/<id>/): their posted uploads, their
        // curated favourites, and their playlists. Only Camwhores exposes this today.
        ephMemberSupported() { return this.ephHas('members'); },
        async ephOpenMember() {
            const raw = (this.ephub.memberQuery || '').trim();
            if (!raw) return;
            const h = this.ephub;
            h.memberLoading = true;
            h.member = null;
            try {
                const r = await fetch(`${this.ephApi()}/member?ref=${encodeURIComponent(raw)}`);
                const d = await r.json();
                if (!r.ok || !d.name) {
                    this.showToast('Člen sa nenašiel — skontroluj URL/ID', 'error', 'error', 2500);
                    return;
                }
                h.member = d;
                h.view = 'member';
                h.q = ''; h.activeTags = []; h.psSlug = ''; h.plId = '';
                this.showToast(`Člen: ${d.name}`, 'person', 'info', 1200);
                await this.ephLoadMemberVideos('posted');
            } catch (e) {
                this.showToast(e.message || 'Načítanie člena zlyhalo', 'error', 'error');
            } finally { h.memberLoading = false; }
        },
        async ephLoadMemberVideos(kind, append = false) {
            const h = this.ephub;
            if (!h.member) return;
            h.memberKind = kind;
            const seq = (this._ephSeq = this._ephSeq + 1);
            h.loading = true;
            if (!append) { h.page = 1; h.items = []; this._ephDispatched = new Set(); this._ephDeepDispatched = new Set(); }
            try {
                const ref = h.member.member_id || h.memberQuery;
                // favourites contain many private (others') uploads → allow them so the list isn't empty
                const pub = kind === 'favourites' ? 'false' : 'true';
                const r = await fetch(`${this.ephApi()}/member-videos?ref=${encodeURIComponent(ref)}&kind=${kind}&page=${h.page}&only_public=${pub}`);
                const d = await r.json();
                if (seq !== this._ephSeq) return;
                const items = (d.items || []).map(it => ({ ...it, source: it.source || h.source }));
                h.items = append ? h.items.concat(items.filter(i => !h.items.some(x => x.url === i.url))) : items;
                h.hasMore = !!d.has_more;
                h.total = kind === 'posted' ? h.member.posted_count : h.member.favourite_count;
                // Sparse first page (e.g. Camwhores profile showing only 3 or 12 public
                // items on page 1 while hundreds more sit on /2/, /3/...): auto-pull up
                // to 4 more pages so the initial grid isn't nearly empty.
                if (!append && h.hasMore && h.items.length < 24) {
                    for (let extra = 0; extra < 4 && h.hasMore && h.items.length < 24; extra++) {
                        h.page++;
                        const nr = await fetch(`${this.ephApi()}/member-videos?ref=${encodeURIComponent(ref)}&kind=${kind}&page=${h.page}&only_public=${pub}`);
                        if (!nr.ok || seq !== this._ephSeq) break;
                        const nd = await nr.json();
                        if (seq !== this._ephSeq) return;
                        const nItems = (nd.items || []).map(it => ({ ...it, source: it.source || h.source }));
                        h.items = h.items.concat(nItems.filter(i => !h.items.some(x => x.url === i.url)));
                        h.hasMore = !!nd.has_more;
                    }
                }
                this.ephScheduleAutoFetch();
            } catch (e) {
                if (seq === this._ephSeq) this.showToast(e.message || 'Chyba', 'error', 'error');
            } finally { if (seq === this._ephSeq) h.loading = false; }
        },
        ephMemberOpenPlaylist(pl) {
            // member's playlists use the same KVS playlist id form
            this.ephOpenPlaylist(pl.id, pl.title);
        },
        // Open the uploader of a card (from the enriched uploaderId) as a member.
        ephOpenMemberFromCard(item) {
            const id = item && item.uploaderId;
            if (!id) return;
            this.ephub.memberQuery = String(id);
            this.ephOpenMember();
        },
        ephPlMaybeMore(e) {
            const el = e.target;
            if (this.ephub.plLoading || !this.ephub.plHasMore) return;
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 800) this.ephLoadMorePlaylists();
        },

        ephLoadMore() {
            this.ephub.page++;
            if (this.ephub.view === 'member') return this.ephLoadMemberVideos(this.ephub.memberKind, true);
            this.ephLoad(true);
        },
        // Append the next N pages under the current grid, one after another,
        // stopping early if a page reports no more results.
        async ephLoadMorePages(n) {
            const h = this.ephub;
            let count = Math.max(1, Math.min(50, parseInt(n, 10) || 1));
            for (let i = 0; i < count; i++) {
                if (!h.hasMore || h.loading) break;
                h.page++;
                if (h.view === 'member') await this.ephLoadMemberVideos(h.memberKind, true);
                else await this.ephLoad(true);
                if (!h.hasMore) break;
            }
        },
        ephMaybeMore(e) { if (this.ephub.view === 'playlists') this.ephPlMaybeMore(e); },

        // ── client-side refinement ─────────────────────────────────────────
        // `ephFilteredItems()` is read by the grid's x-for, by the result
        // readout and by the enrich counters, so Alpine calls it several times
        // per reactive tick. At 300 cards that meant filtering and sorting the
        // whole list on every keystroke. The result is memoised against a
        // signature that changes whenever the list or any refinement does:
        // length + first/last url catch a new page or a removal, and
        // `_ephMetaVer` is bumped by every enrich patch.
        ephFilteredItems() {
            const h = this.ephub;
            const sig = [
                h.items.length, h.items[0]?.url || '', h.items[h.items.length - 1]?.url || '',
                this._ephMetaVer || 0, h.inc, h.exc, h.durMin, h.durMax, h.minHeight,
                h.qualPick.join(','), h.activeTags.join(','), h.lenSort, h.qualSort,
                h.sizeSort, h.dateSort, h.activeCat, h.view, h.showWeak, h.orientation || 'all',
            ].join('|');
            if (this._ephFilterSig === sig && this._ephFilterOut) return this._ephFilterOut;
            this._ephFilterSig = sig;
            this._ephFilterOut = this._ephComputeFiltered();
            return this._ephFilterOut;
        },
        _ephComputeFiltered() {
            const h = this.ephub;
            const inc = h.inc.trim().toLowerCase();
            const exc = h.exc.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
            const dMin = (parseFloat(h.durMin) || 0) * 60;
            const dMax = (parseFloat(h.durMax) || 0) * 60;
            // In performer/playlist view the server did NOT filter by category,
            // so apply the category as a client-side keyword intersection here
            // (this is what lets herec + kategória be active at the same time).
            const catNeedles = (h.activeCat && h.view !== 'feed') ? this._ephCatNeedles() : [];
            let list = h.items.filter(it => {
                if (it.below_threshold && !h.showWeak) return false;
                if (catNeedles.length) {
                    const chay = (it.title + ' ' + (it.tags || []).join(' ')).toLowerCase();
                    if (!catNeedles.some(w => chay.includes(w))) return false;
                }
                const dur = it.duration_sec || 0;
                if (dMin && dur < dMin) return false;
                if (dMax && dur > dMax) return false;
                // A quality floor is a claim about the file, so a tile whose
                // height nobody has verified cannot satisfy it. The old rule let
                // unverified tiles through, which is why "4K only" happily showed
                // SD until enrich caught up — and in ALL mode, where enrich never
                // ran, forever. Unknowns are held back and counted separately
                // (`ephQualityPending()`) while `_ephEnsureMeta()` resolves them.
                // For vertical videos, effective resolution height is the shorter side (width)
                const effH = (it.width > 0 && it.height > 0 && it.width < it.height)
                    ? Math.min(it.width, it.height)
                    : (it.height || 0);
                if (h.minHeight && effH < h.minHeight) return false;
                // exact quality buckets (multi-select, e.g. only 1080p + 4K)
                if (h.qualPick.length
                    && (!effH || !h.qualPick.includes(this.ephQBucket(effH)))) return false;

                // Filter by orientation
                if (h.orientation && h.orientation !== 'all') {
                    const o = this.ephVideoOrientation(it).orientation;
                    const estimated = o === 'unknown'
                        && (this.ephHasPortraitThumbnailEstimate(it) || it.orientation_likely === 'portrait' || this.ephIsTextHintPortrait(it));
                    if (h.orientation === 'portrait_estimate') {
                        if (!estimated) return false;
                    } else if (h.orientation === 'portrait_any') {
                        if (o !== 'portrait' && !estimated) return false;
                    } else if (o !== h.orientation) {
                        return false;
                    }
                }
                const hay = (it.title + ' ' + (it.tags || []).join(' ')).toLowerCase();
                if (inc && !hay.includes(inc)) return false;
                if (exc.length && exc.some(x => hay.includes(x))) return false;
                if (h.activeTags.length) {
                    const tl = (it.tags || []).map(t => t.toLowerCase());
                    if (!h.activeTags.every(t => tl.includes(t))) return false;
                }
                return true;
            });
            if (h.dateSort) {
                // Unknown dates are never presented as "new".  They stay at
                // the end in both directions, while dated cards form one
                // global chronological list across every ALL source.
                list = [...list].sort((a, b) => {
                    const da = this.ephDateValue(a), db = this.ephDateValue(b);
                    if (!da && !db) return 0;
                    if (!da) return 1;
                    if (!db) return -1;
                    return h.dateSort === 'asc' ? da - db : db - da;
                });
            } else if (h.sizeSort) {
                // tiles without a known size (not yet enriched) always sink to the end
                list = [...list].sort((a, b) => {
                    const sa = a.size_mb, sb = b.size_mb;
                    if (sa == null && sb == null) return 0;
                    if (sa == null) return 1;
                    if (sb == null) return -1;
                    return h.sizeSort === 'asc' ? sa - sb : sb - sa;
                });
            } else if (h.qualSort) {
                const getEffH = it => (it.width > 0 && it.height > 0 && it.width < it.height)
                    ? Math.min(it.width, it.height) : (it.height || 0);
                list = [...list].sort((a, b) => h.qualSort === 'asc'
                    ? getEffH(a) - getEffH(b)
                    : getEffH(b) - getEffH(a));
            } else if (h.lenSort) {
                list = [...list].sort((a, b) => h.lenSort === 'asc'
                    ? (a.duration_sec || 0) - (b.duration_sec || 0)
                    : (b.duration_sec || 0) - (a.duration_sec || 0));
            }
            return list;
        },
        // Adapter date formats vary (ISO, 17. 7. 2026, and occasionally a
        // timestamp).  Normalise them here so client-side sorting does not
        // depend on the browser's locale parser.
        ephDateValue(item) {
            const raw = String(item?.added || item?.upload_date || item?.date || '').trim();
            if (!raw) return 0;
            if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(raw)) {
                const iso = Date.parse(raw);
                return Number.isFinite(iso) ? iso : 0;
            }
            const dmy = raw.match(/^(\d{1,2})\s*[.\/-]\s*(\d{1,2})\s*[.\/-]\s*(\d{2,4})/);
            if (dmy) {
                const year = Number(dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]);
                const date = Date.UTC(year, Number(dmy[2]) - 1, Number(dmy[1]));
                return Number.isFinite(date) ? date : 0;
            }
            const relative = raw.match(/^(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago$/i);
            if (relative) {
                const amount = Number(relative[1]);
                const unit = relative[2].toLowerCase();
                const ms = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5 }[unit];
                if (ms) return Date.now() - amount * ms;
                const date = new Date();
                if (unit === 'month') date.setMonth(date.getMonth() - amount);
                else date.setFullYear(date.getFullYear() - amount);
                return date.getTime();
            }
            if (/^today$/i.test(raw)) return Date.now();
            if (/^yesterday$/i.test(raw)) return Date.now() - 864e5;
            const parsed = Date.parse(raw);
            return Number.isFinite(parsed) ? parsed : 0;
        },
        // resolution height -> the exact-quality bucket used by the pick chips
        ephQBucket(height) {
            const v = height || 0;
            if (v >= 2160) return 2160;
            if (v >= 1440) return 1440;
            if (v >= 1080) return 1080;
            if (v >= 720) return 720;
            return 480; // everything below 720p counts as SD
        },
        // How many loaded cards a quality filter is currently holding back only
        // because nobody has verified their height yet. Shown next to the filter
        // so an empty grid reads as "still checking", not "nothing matches".
        // How many loaded tiles the relevance gate is holding back as weak
        // matches. Surfaced next to the log so "only 2 results" always comes
        // with "and 30 near-misses, click to see them".
        ephWeakCount() {
            return this.ephub.items.filter(i => i.below_threshold).length;
        },
        ephToggleWeak() {
            this.ephub.showWeak = !this.ephub.showWeak;
            this._ephMetaVer = (this._ephMetaVer || 0) + 1;
        },
        ephQualityPending() {
            const h = this.ephub;
            if (!h.minHeight && !h.qualPick.length) return 0;
            return h.items.filter(i => !i.height).length;
        },
        // What the card may honestly claim about its resolution.
        //   verified  — a real height from the listing or from enrich
        //   unknown   — nothing measured; render it dim, never as "HD"
        // The old card printed "HD" whenever `item.hd` was set, and Eporner set
        // that flag from the duration, so every tile claimed HD.
        ephQualityChip(item) {
            const height = item.height || 0;
            if (height >= 2160) return { text: '4K', verified: true };
            if (height) return { text: height + 'p', verified: true };
            if (item.quality) return { text: item.quality, verified: false };
            return { text: '', verified: false };
        },
        // Two tiles are the same scene when their titles reduce to the same
        // words and their runtimes agree within a few seconds. Sources re-host
        // each other constantly, so without this ALL shows you the same video
        // three times and calls it three results.
        ephDedupeKey(item) {
            const title = String(item.title || '').toLowerCase()
                .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).slice(0, 8).join(' ');
            const bucket = Math.round((item.duration_sec || 0) / 5);
            return `${title}#${bucket}`;
        },
        // Collapse re-hosts, keeping the copy with the best verified quality
        // (then the larger file). The survivors carry `alsoOn` so the card can
        // show which other sources have it.
        ephDedupe(list) {
            const best = new Map();
            for (const item of list) {
                const key = this.ephDedupeKey(item);
                const prev = best.get(key);
                if (!prev) { best.set(key, { ...item, alsoOn: [] }); continue; }
                const better = (item.height || 0) > (prev.height || 0)
                    || ((item.height || 0) === (prev.height || 0) && (item.size_mb || 0) > (prev.size_mb || 0));
                const loser = better ? prev : item;
                const winner = better ? { ...item, alsoOn: prev.alsoOn } : prev;
                if (loser.source && loser.source !== winner.source
                    && !winner.alsoOn.includes(loser.source)) winner.alsoOn.push(loser.source);
                best.set(key, winner);
            }
            return [...best.values()];
        },
        // sorts are mutually exclusive — enabling one clears the others
        ephSetQualSort(d) {
            const h = this.ephub;
            h.qualSort = (h.qualSort === d) ? '' : d;
            if (h.qualSort) { h.lenSort = ''; h.sizeSort = ''; h.dateSort = ''; this._ephEnsureMeta(); }
        },
        ephSetSizeSort(d) {
            const h = this.ephub;
            h.sizeSort = (h.sizeSort === d) ? '' : d;
            if (h.sizeSort) { h.lenSort = ''; h.qualSort = ''; h.dateSort = ''; this._ephEnsureMeta(); }
        },
        ephSetDateSort(d) {
            const h = this.ephub;
            h.dateSort = (h.dateSort === d) ? '' : d;
            if (h.dateSort) { h.lenSort = ''; h.qualSort = ''; h.sizeSort = ''; }
        },
        ephSetMinHeight(h) {
            this.ephub.minHeight = (this.ephub.minHeight === h) ? 0 : h;
            if (this.ephub.minHeight) { this.ephub.qualPick = []; this._ephEnsureMeta(); }
        },
        ephToggleQualPick(bucket) {
            const h = this.ephub;
            const i = h.qualPick.indexOf(bucket);
            if (i >= 0) h.qualPick.splice(i, 1);
            else h.qualPick.push(bucket);
            if (h.qualPick.length) { h.minHeight = 0; this._ephEnsureMeta(); }
        },
        // Size sort / quality filters only work on enriched tiles, so activating
        // them kicks off an enrich of EVERY loaded (filtered) tile — with 300
        // results the whole list becomes sortable, not just the visible top.
        // Which sources have a second, heavier enrich pass that measures file
        // size. It was hard-coded to Camwhores, so xHamster — which declares
        // `supports_deep_enrich` on the server — could never report a size at
        // all. ALL stays shallow: deep costs a full stream resolve per video.
        _ephDeepFor(source) {
            return ['camwhores', 'xhamster', 'spankbang'].includes(source);
        },
        // Which URLs from `base` still need a pass, and which dispatch set they
        // belong to — decided from EACH TILE'S OWN source, not the active view.
        // `_ephRunEnrich` groups a batch by source and mixed-grid views (ALL,
        // watch-later, a cross-hub related rail) hand it URLs from several
        // sources at once, so a single deep/shallow verdict for the whole call
        // used to mean "deep" collapsed to false the instant `h.source` was the
        // 'all' pseudo-source — Camwhores/xHamster cards in an ALL grid could
        // never get their size-measuring pass. `wantDeep` is the caller's
        // INTENT ("give me everything this source can offer"); whether it
        // actually applies is still gated per source by `_ephDeepFor`.
        _ephPendingUrls(base, wantDeep) {
            if (!this._ephDispatched) this._ephDispatched = new Set();
            if (!this._ephDeepDispatched) this._ephDeepDispatched = new Set();
            const out = [];
            for (const it of base) {
                if (!it.url) continue;
                const deep = !!wantDeep && this._ephDeepFor(it.source || this.ephub.source);
                const dispatched = deep ? this._ephDeepDispatched : this._ephDispatched;
                if (dispatched.has(it.url)) continue;
                const pending = deep ? it.deepQ !== true : it.enrichedQ === undefined;
                if (!pending) continue;
                dispatched.add(it.url);
                out.push(it.url);
            }
            return out;
        },
        _ephEnsureMeta() {
            const h = this.ephub;
            const needed = this._ephPendingUrls(h.items, !!h.sizeSort);
            if (!needed.length) return;
            this._ephRunEnrich(needed, { silent: true, skipWarn: true, wantDeep: !!h.sizeSort });
        },
        // ── enrich: real max quality + largest file size (watch-page parse) ──
        ephScheduleAutoFetch() {
            const h = this.ephub;
            // ALL used to be excluded here, on the assumption that enrich can
            // only talk to one source. It can't — but `_ephRunEnrich` already
            // groups URLs by source and runs one pass each, so a mixed grid
            // enriches fine. Excluding it meant every ALL search showed
            // "Načítané 0 · Nenačítané 46" and every quality filter was blind.
            if (!h.autoFetch || ['playlists', 'watchlater', 'continue'].includes(h.view)) return;
            clearTimeout(this._ephAutoTimer);
            // near-instant kick-off: streaming handles concurrency, no reason to wait
            this._ephAutoTimer = setTimeout(() => this.ephAutoFetchTop(), 120);
        },
        async ephAutoFetchTop() {
            const h = this.ephub;
            if (!h.autoFetch || !h.items.length) return;
            // a metadata-driven sort/filter is active -> newly loaded pages must
            // be fully enriched too, otherwise they'd sort/filter wrong
            if (h.sizeSort || h.qualPick.length || h.minHeight || h.qualSort) {
                this._ephEnsureMeta();
                return;
            }
            // Every loaded card gets its quality, size and date — not just the
            // first screenful. The work is chunked rather than fired as one
            // 50-url request per source: a chunk keeps each HTTP response short
            // enough to stream visibly, lets the progress bar move, and bounds
            // how much a single slow source can hold open. Cards are taken in
            // grid order, so what the user is looking at fills first anyway.
            if (!this._ephDispatched) this._ephDispatched = new Set();
            // A card counts as pending while ANY of the three promised fields is
            // still open. Keying only on `enrichedQ` would skip every Prime Cut
            // tile, because Prime marks quality as verified server-side while
            // leaving size and date untouched.
            const needsMore = (i) => i.enrichedQ === undefined
                || (!i.size_mb && !i.sizeBasis)
                || !i.added;
            const pending = this.ephFilteredItems()
                .filter(i => i.url && needsMore(i) && !this._ephDispatched.has(i.url))
                .map(i => i.url);
            if (!pending.length) return;
            await this._ephFetchAllMeta(pending);
        },

        //: Cards per enrich request. Small enough that the first results land
        //: quickly and the bar advances smoothly; large enough not to pay a
        //: round-trip per card.
        _ephMetaChunk: 12,

        // Walk every pending card in chunks, keeping the status bar honest about
        // how far along the whole run is rather than just the current chunk.
        async _ephFetchAllMeta(urls) {
            const h = this.ephub;
            const run = ++this._ephMetaRun;
            const seq = this._ephSeq;
            h.meta = {
                running: true, done: 0, total: urls.length,
                sized: 0, dated: 0, failed: 0, note: 'Spúšťam…',
            };
            try {
                for (let i = 0; i < urls.length; i += this._ephMetaChunk) {
                    // A new search (or a newer auto-fetch) supersedes this run.
                    if (seq !== this._ephSeq || run !== this._ephMetaRun) return;
                    const chunk = urls.slice(i, i + this._ephMetaChunk);
                    chunk.forEach(u => this._ephDispatched.add(u));
                    const srcs = new Set(chunk.map(u => this._ephSourceOf(u)));
                    h.meta.note = [...srcs].slice(0, 3).join(', ') + (srcs.size > 3 ? '…' : '');
                    await this._ephRunEnrich(chunk, {
                        silent: true, skipWarn: true, wantDeep: true, fillSize: true,
                    });
                    if (seq !== this._ephSeq || run !== this._ephMetaRun) return;
                    h.meta.done = Math.min(i + chunk.length, urls.length);
                    this._ephRecountMeta();
                }
                h.meta.note = 'Hotovo';
            } finally {
                if (run === this._ephMetaRun) {
                    this._ephRecountMeta();
                    h.meta.running = false;
                }
            }
        },

        // Cards whose real height is known — from the listing, from enrich, or
        // verified by Prime Cut. Counted live rather than stored, so it always
        // matches what the badges on the cards say.
        ephMetaQualityCount() {
            return (this.ephub.items || []).filter(i => (i.height || 0) > 0).length;
        },

        // Recompute the "how much do we actually know" tallies from the grid
        // itself, so the numbers cannot drift away from what the cards show.
        _ephRecountMeta() {
            const h = this.ephub;
            if (!h.meta) return;
            const items = h.items || [];
            h.meta.sized = items.filter(i => i.size_mb).length;
            h.meta.dated = items.filter(i => i.added).length;
            h.meta.failed = items.filter(i => i.enrichedQ === false).length;
        },
        async ephEnrich(scope) {
            const h = this.ephub;
            const base = (scope === 'selected')
                ? h.items.filter(i => h.selected.includes(i.url))
                : this.ephFilteredItems();
            // "Full metadata" means everything the source CAN give — so the deep
            // (size-measuring) pass is always attempted for a deep-capable
            // source, whether that card came from a single-source view or from
            // a mixed ALL grid.
            const urls = this._ephPendingUrls(base, true);
            if (!urls.length) { this.showToast('Full metadata sú už načítané', 'info', 'info', 1500); return; }
            if (urls.length >= 5) this.ephEnrichCaution();
            await this._ephRunEnrich(urls, { silent: false, skipWarn: true, wantDeep: true });
        },
        // Apply one streamed enrich result to its card in place (O(1) via url map).
        _ephPatchItem(url, d, deep = false) {
            const idx = this._ephIndex ? this._ephIndex.get(url) : -1;
            const h = this.ephub;
            const i = (idx != null && idx >= 0 && h.items[idx] && h.items[idx].url === url)
                ? idx : h.items.findIndex(it => it.url === url);
            if (i < 0) return;
            const it = h.items[i];
            // Every patch invalidates the memoised filter/sort result.
            this._ephMetaVer = (this._ephMetaVer || 0) + 1;
            if (!d) {
                h.items.splice(i, 1, deep ? { ...it, deepQ: false } : { ...it, enrichedQ: false });
                return;
            }
            // Size-only follow-up patch (the server's second wave for cards whose
            // source could not state a byte count). It carries nothing else, so
            // merging it through the full branch below would be harmless but
            // misleading: it must not flip `enrichedQ` for a card whose quality
            // pass has not actually run.
            if (d.size_basis && d.height === undefined && d.quality === undefined) {
                h.items.splice(i, 1, {
                    ...it,
                    size_mb: d.size_mb ?? it.size_mb,
                    sizeBasis: d.size_basis,
                    sizeNote: d.size_note || it.sizeNote,
                });
                return;
            }
            h.items.splice(i, 1, {
                ...it, enrichedQ: true, deepQ: deep ? true : it.deepQ,
                title: d.title || it.title,
                thumb: d.thumbnail || it.thumb,
                duration_sec: d.duration_sec || it.duration_sec,
                duration: d.duration || it.duration,
                quality: d.quality || it.quality, height: d.height || it.height,
                width: d.width || it.width,
                orientation: d.orientation || it.orientation,
                orientation_evidence: d.orientation_evidence || it.orientation_evidence,
                orientation_likely: d.orientation_likely || it.orientation_likely,
                size_mb: d.size_mb ?? it.size_mb, codec: d.codec || it.codec,
                // Where the size came from — 'source' | 'head' | 'impossible' |
                // 'unavailable'. The card needs it to tell "not fetched yet"
                // apart from "this source can never report a size".
                sizeBasis: d.size_basis || it.sizeBasis,
                sizeNote: d.size_note || it.sizeNote,
                // enrich date key varies by adapter: KVS/eporner/camwhores use
                // `upload_date`, noodle/xvideos use `added` — accept either.
                added: d.upload_date || d.added || it.added,
                description: d.description || it.description,
                hd: (d.height || it.height || 0) >= 720,
                uploader: d.uploader || it.uploader,
                uploaderId: d.uploader_id || it.uploaderId,
                metadataLevel: d.metadata_level || it.metadataLevel,
                performers: (d.performers && d.performers.length) ? d.performers : it.performers,
                categories: (d.categories && d.categories.length) ? d.categories : it.categories,
                videoTags: (d.video_tags && d.video_tags.length) ? d.video_tags : it.videoTags,
                tags: (d.video_tags && d.video_tags.length)
                    ? [...new Set([...(it.tags || []), ...d.video_tags])]
                    : it.tags,
            });
        },
        // Which source produced this tile. In ALL / Prime Cut mode the grid holds
        // tiles from many sources, so enrich must be asked of each tile's own
        // source: /hub/all/enrich does not exist, answers 404, and the blocking
        // fallback below then records that as "failed" on every single card.
        _ephSourceOf(url) {
            const it = this.ephub.items.find(i => i.url === url);
            return (it && it.source) || this.ephub.source;
        },
        _ephGroupBySource(urls) {
            const groups = new Map();
            for (const u of urls) {
                const s = this._ephSourceOf(u);
                if (!groups.has(s)) groups.set(s, []);
                groups.get(s).push(u);
            }
            return groups;
        },
        async _ephRunEnrich(urls, opts = {}) {
            const h = this.ephub;
            urls = [...new Set((urls || []).filter(Boolean))];
            if (!urls.length) return;
            // Every call site already resolves its own caution/warn step before
            // reaching here (ephEnrichCaution, or a silent auto-fetch that
            // intentionally skips it) — no blocking gate belongs this deep.
            if (!opts.skipWarn && urls.length >= 5) this.ephEnrichCaution();
            // Concurrent streaming passes are fine (each URL is independent); we
            // just don't double-count. A shared flag keeps the progress UI sane.
            h.enriching = true;
            h.enrichTotal = (h.enrichTotal || 0) + urls.length;
            if (!this._ephInflight) this._ephInflight = 0;
            this._ephInflight += urls.length;
            // fast url -> index lookup so each streamed line patches in O(1)
            this._ephIndex = new Map(h.items.map((it, i) => [it.url, i]));
            const seq = this._ephSeq;               // cancel patches if a new search wins

            const groups = this._ephGroupBySource(urls);
            this.ephBusyStart('enrich',
                groups.size > 1 ? `Full metadata · ${groups.size} zdrojov` : 'Full metadata',
                urls.length, 'high_quality');
            this._ephBusyDone = 0;
            // `deep` is resolved fresh PER GROUP from that group's own source,
            // never from a single value carried in from the caller — a batch
            // gathered across an ALL grid mixes sources with different deep
            // support, and `opts.wantDeep` is only the caller's intent ("give
            // me everything"), not a verdict any one source has to honour.
            const optsFor = (src) => ({ ...opts, deep: !!opts.wantDeep && this._ephDeepFor(src) });
            try {
                if (groups.size > 1) {
                    // Mixed grid: one pass per source, in parallel.
                    const results = await Promise.all(
                        [...groups.entries()].map(([src, list]) =>
                            this._ephEnrichOneSource(src, list, optsFor(src), seq)));
                    const ok = h.items.filter(i => i.enrichedQ).length;
                    h.autoFetchDone = ok;
                    if (!opts.silent) {
                        const bad = results.filter(r => !r).length;
                        this.showToast(
                            `Full metadata: ${ok} videí` + (bad ? ` · ${bad} zdrojov zlyhalo` : ''),
                            'high_quality', bad ? 'warning' : 'success', 2400);
                    }
                    return;
                }
                const [onlySource] = groups.size ? [...groups.keys()] : [this.ephub.source];
                const okRun = await this._ephEnrichOneSource(onlySource, urls, optsFor(onlySource), seq);
                if (!opts.silent) {
                    const ok = h.items.filter(i => i.enrichedQ).length;
                    if (okRun) this.showToast(`Full metadata: ${ok} videí`, 'high_quality', 'success', 2200);
                    else this.showToast('Načítanie kvality zlyhalo', 'error', 'error');
                }
            } finally {
                // A url a newer search superseded, or whose request errored
                // mid-batch, ends this call with `enrichedQ` still undefined —
                // it was added to the dispatched set by the CALLER before this
                // ran, and nothing ever removed it, so every future "Doplniť
                // metadáta"/auto-fetch silently treated it as "already being
                // handled" forever, even though the card visibly still showed
                // as unfetched. Release anything that never got a definitive
                // result so the next attempt can actually retry it.
                for (const url of urls) {
                    const it = h.items[this._ephIndex?.get(url)] ?? h.items.find(x => x.url === url);
                    if (it && it.enrichedQ === undefined) {
                        this._ephDispatched?.delete(url);
                        this._ephDeepDispatched?.delete(url);
                    }
                }
                this.ephBusyEnd('enrich');
                this._ephInflight = Math.max(0, (this._ephInflight || 0) - urls.length);
                if (this._ephInflight === 0) { h.enriching = false; h.enrichTotal = 0; h.enrichDone = 0; }
            }
        },
        // Stream (or, failing that, block) one source's enrich. Returns false only
        // when the source could not be reached at all — the caller must NOT then
        // mark its cards as failed, because nothing about them was actually learnt.
        async _ephEnrichOneSource(source, urls, opts = {}, seq = this._ephSeq) {
            const h = this.ephub;
            const api = `/api/v1/hub/${source}`;
            try {
                const r = await fetch(`${api}/enrich-stream`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    // fill_size asks the server to resolve + HEAD the stream for
                    // cards whose source cannot state a byte count itself. It
                    // arrives as a second patch per url, so it never delays the
                    // quality/date line.
                    body: JSON.stringify({ urls, deep: !!opts.deep, fill_size: opts.fillSize !== false }),
                });
                if (!r.ok || !r.body) throw new Error('stream unavailable');
                const reader = r.body.getReader();
                const dec = new TextDecoder();
                let buf = '';
                const flushLine = (line) => {
                    line = line.trim();
                    if (!line) return;
                    let ev; try { ev = JSON.parse(line); } catch (_) { return; }
                    if (ev.error) return;
                    this._ephPatchItem(ev.url, ev.data, !!opts.deep);
                    h.enrichDone++;
                    this._ephBusyDone = (this._ephBusyDone || 0) + 1;
                    this.ephBusyStep('enrich', this._ephBusyDone, source);
                    this._ephIndex = new Map(h.items.map((it, i) => [it.url, i]));
                };
                while (true) {
                    const { done, value } = await reader.read();
                    // Superseded by a newer search: not a failure, just obsolete.
                    if (seq !== this._ephSeq) { try { reader.cancel(); } catch (_) { } return true; }
                    if (done) break;
                    buf += dec.decode(value, { stream: true });
                    let nl;
                    while ((nl = buf.indexOf('\n')) >= 0) {
                        flushLine(buf.slice(0, nl));
                        buf = buf.slice(nl + 1);
                    }
                }
                if (buf.trim()) flushLine(buf);
                h.autoFetchDone = h.items.filter(i => i.enrichedQ).length;
                return true;
            } catch (e) {
                // streaming unavailable (buffering proxy / old server) -> blocking fallback
                return await this._ephRunEnrichBlocking(urls, seq, !!opts.deep, source);
            }
        },
        // one-shot blocking enrich fallback (old /enrich); returns true on success
        async _ephRunEnrichBlocking(urls, seq, deep = false, source = '') {
            const h = this.ephub;
            const CHUNK = 6;
            const api = `/api/v1/hub/${source || this.ephub.source}`;
            try {
                for (let i = 0; i < urls.length; i += CHUNK) {
                    const chunk = urls.slice(i, i + CHUNK);
                    const r = await fetch(`${api}/enrich`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ urls: chunk, deep }),
                    });
                    if (seq !== this._ephSeq) return true;
                    // An unreachable source teaches us nothing about its cards.
                    // Marking them "failed" here is what made a whole Prime Cut
                    // grid look broken when only the endpoint was wrong.
                    if (!r.ok) return false;
                    const data = await r.json();
                    const res = (r.ok && data.results) || {};
                    for (const u of chunk) { this._ephPatchItem(u, res[u] || null, deep); h.enrichDone++; }
                    this._ephIndex = new Map(h.items.map((it, idx) => [it.url, idx]));
                }
                return true;
            } catch (_) { return false; }
        },
        // upload date -> compact "29 Jun 2026"; falls back to the raw string
        ephDate(s) {
            if (!s) return '';
            const d = new Date(s.replace(' ', 'T'));
            if (isNaN(d)) return s;
            return d.toLocaleDateString('sk-SK', { day: 'numeric', month: 'short', year: 'numeric' });
        },
        // Fixed-width calendar date for the card's slate line. Sources hand
        // back four different shapes (ISO, d.m.Y, "6 months ago", epoch); they
        // all collapse to one width here so a column of cards stays readable.
        ephDateShort(item) {
            const ms = this.ephDateValue(item);
            if (!ms) return String(item?.added || '').slice(0, 10);
            const d = new Date(ms);
            const pad = (n) => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        },
        ephSizeLabel(it) {
            if (it.size_mb == null) return '';
            return it.size_mb >= 1024 ? (it.size_mb / 1024).toFixed(2) + ' GB' : Math.round(it.size_mb) + ' MB';
        },
        // Where a shown size came from, spelled out on hover.
        ephSizeTitle(it) {
            if (it.size_estimated) return 'Odhad z bitrate, nie meraná veľkosť';
            if (it.sizeBasis === 'head') return 'Zmerané priamo zo súboru (HEAD)';
            return 'Meraná veľkosť súboru';
        },
        // What to show INSTEAD of a size, and whether it is still coming.
        // Distinguishing these is the whole point: "·····" means the fetch has
        // not reached this card yet, "—" means no fetch will ever fill it.
        ephSizeMissing(it) {
            // 'impossible' is a property of the source (no resolver, HLS-only,
            // CDN blocks HEAD); 'unavailable' is this one card's attempt failing
            // on a source that answers for others. Saying "this source does not
            // provide sizes" for the second would be wrong.
            if (it.sizeBasis === 'impossible') {
                return {
                    text: '—', pending: false,
                    title: it.sizeNote || 'Tento zdroj neposkytuje veľkosť súboru',
                };
            }
            if (it.sizeBasis === 'unavailable') {
                return { text: '—', pending: false, title: 'Veľkosť tohto videa sa nepodarilo zistiť' };
            }
            if (this.ephub.meta.running || it.enrichedQ === undefined) {
                return { text: '·····', pending: true, title: 'Veľkosť sa načítava…' };
            }
            return { text: '—', pending: false, title: 'Veľkosť sa nepodarilo zistiť' };
        },
        ephSetLenSort(d) {
            const h = this.ephub;
            h.lenSort = (h.lenSort === d) ? '' : d;
            if (h.lenSort) { h.qualSort = ''; h.sizeSort = ''; h.dateSort = ''; }
        },
        // Top tags across the loaded tiles → clickable chips.
        ephTopTags(limit = 22) {
            const counts = new Map();
            for (const it of this.ephub.items) {
                for (const t of (it.tags || [])) {
                    const k = t.toLowerCase();
                    counts.set(k, (counts.get(k) || 0) + 1);
                }
            }
            return [...counts.entries()]
                .sort((a, b) => b[1] - a[1]).slice(0, limit).map(e => e[0]);
        },
        // Clicking a tag runs a REAL search on the source for that word — the site
        // returns far more (and more relevant) results than client-filtering the
        // Recent feed ever could. Clicking the active tag again clears back to feed.
        // (The old behaviour just filtered already-loaded tiles, so it kept pulling
        // more Recent pages to scrape a handful of matches — slow and sparse.)
        ephToggleTag(tag) {
            const t = (tag || '').trim();
            if (!t) return;
            const h = this.ephub;
            if (h.q.trim().toLowerCase() === t.toLowerCase()) {
                // same tag active → clear it, back to the plain feed
                h.q = '';
            } else {
                h.q = t;
            }
            h.activeTags = [];            // real search replaces the client-side tag filter
            h.view = 'feed'; h.psSlug = ''; h.plId = '';
            this.ephLoad(false);
        },
        ephTagOn(tag) {
            return this.ephub.q.trim().toLowerCase() === (tag || '').toLowerCase()
                || this.ephub.activeTags.includes((tag || '').toLowerCase());
        },
        // How many refinements are currently narrowing the grid. Shown on the
        // drawer's toggle so a filter left on inside a collapsed panel can never
        // silently explain an empty result.
        ephActiveFilterCount() {
            const h = this.ephub;
            return [h.inc.trim(), h.exc.trim(), String(h.durMin || ''), String(h.durMax || ''),
            h.minHeight ? '1' : '', h.qualPick.length ? '1' : '', h.activeTags.length ? '1' : '',
            h.lenSort, h.qualSort, h.sizeSort, (h.orientation && h.orientation !== 'all') ? '1' : ''].filter(Boolean).length;
        },
        ephClearFilters() {
            const h = this.ephub;
            h.inc = ''; h.exc = ''; h.durMin = ''; h.durMax = '';
            h.activeTags = []; h.lenSort = ''; h.qualSort = ''; h.sizeSort = '';
            h.dateSort = h.sort === 'recent' ? 'desc' : '';
            h.minHeight = 0; h.qualPick = [];
            h.orientation = 'all';
        },


        // ══ Orientation (vertical / portrait) detection ═════════════════════
        ephVideoOrientation(item) {
            const width = Number(item?.width) || 0;
            const height = Number(item?.height) || 0;
            if (width > 0 && height > 0) {
                return {
                    orientation: width / height < 0.95 ? 'portrait' : 'landscape',
                    evidence: 'video_dimensions',
                };
            }

            const declared = String(item?.orientation || '').trim().toLowerCase();
            if (declared === 'portrait' || declared === 'vertical') {
                const evidence = item?.orientation_evidence;
                return { orientation: 'portrait', evidence: evidence && evidence !== 'unknown' ? evidence : 'source_metadata' };
            }
            if (declared === 'landscape' || declared === 'horizontal') {
                const evidence = item?.orientation_evidence;
                return { orientation: 'landscape', evidence: evidence && evidence !== 'unknown' ? evidence : 'source_metadata' };
            }

            const ratio = Number(item?.aspect_ratio);
            if (ratio > 0) {
                return {
                    orientation: ratio < 0.95 ? 'portrait' : 'landscape',
                    evidence: 'aspect_ratio',
                };
            }

            return { orientation: 'unknown', evidence: 'unknown' };
        },

        ephHasPortraitThumbnailEstimate(item) {
            const width = Number(item?.thumbnail_width || item?.thumb_width) || 0;
            const height = Number(item?.thumbnail_height || item?.thumb_height) || 0;
            return width > 0 && height / width >= 1.1;
        },

        ephIsTextHintPortrait(item) {
            if (item?.orientation_likely === 'portrait') return true;
            const text = [item?.title, item?.file_name, ...(item?.tags || []), ...(item?.categories || [])]
                .filter(Boolean).join(' ').toLowerCase();
            const url = String(item?.url || '').toLowerCase();
            const reText = /(?<![a-z0-9])(?:vertical(?:\s*video|\s*cam|\s*pov|\s*clip)?|vertikaln\w*|portrait|9\s*[:x/]\s*16|tik\s*tok|tiktok|reels?|snapchat|vertical\s*format)(?![a-z0-9])/i;
            const reUrl = /(?:[/_-])(?:vertical|portrait|shorts?|reels?|tiktok|9x16|9-16)(?:[/_-]|$)/i;
            return reText.test(text) || reUrl.test(url);
        },

        ephOrientationBadgeInfo(item) {
            const classification = this.ephVideoOrientation(item);
            if (classification.orientation === 'portrait') {
                const fromDimensions = ['video_dimensions', 'page_dimensions', 'stream_dimensions', 'mp4_probe']
                    .includes(classification.evidence);
                return {
                    label: fromDimensions ? 'Vertikálne · rozmery' : 'Vertikálne · zdroj',
                    title: fromDimensions ? 'Rozmery videa potvrdzujú vertikálnu orientáciu' : 'Zdroj uvádza vertikálnu orientáciu',
                    estimated: false,
                };
            }
            if (classification.orientation === 'unknown' && this.ephIsTextHintPortrait(item)) {
                const byUrl = item?.orientation_evidence === 'url_hint';
                const bySource = item?.orientation_evidence === 'source_prior';
                return {
                    label: `Možno vertikálne · ${bySource ? 'zdroj' : byUrl ? 'URL' : 'názov/tagy'}`,
                    title: 'Odhad z textu alebo URL; rozmery videa zatiaľ nie sú potvrdené',
                    estimated: true,
                };
            }
            if (classification.orientation === 'unknown' && this.ephHasPortraitThumbnailEstimate(item)) {
                return {
                    label: 'Možno vertikálne · náhľad',
                    title: 'Odhad podľa pomeru strán náhľadu; orientácia videa nie je potvrdená',
                    estimated: true,
                };
            }
            return { label: '', title: '', estimated: false };
        },

        ephWantsPortrait() {
            return ['portrait', 'portrait_any', 'portrait_estimate'].includes(this.ephub.orientation);
        },

        ephSetOrientation(orientation) {
            this.ephub.orientation = orientation;
            this._ephMetaVer = (this._ephMetaVer || 0) + 1;
            if (orientation === 'portrait_estimate' || orientation === 'portrait_any') {
                this.ephScanPortraitThumbnails();
            }
            if (this.ephWantsPortrait()) {
                this.ephProbeUnknownOrientation();
            }
        },

        ephOnThumbLoad(event, item) {
            const img = event?.target;
            if (!img || !item) return;
            const w = img.naturalWidth || 0;
            const h = img.naturalHeight || 0;
            if (w > 0 && h > 0) {
                const wasEst = this.ephHasPortraitThumbnailEstimate(item);
                item.thumbnail_width = w;
                item.thumbnail_height = h;
                item.thumbnail_orientation_checked = true;
                const isEst = this.ephHasPortraitThumbnailEstimate(item);
                if (wasEst !== isEst && ['portrait_estimate', 'portrait_any'].includes(this.ephub.orientation)) {
                    this._ephMetaVer = (this._ephMetaVer || 0) + 1;
                    this._ephQueueOrientationRefresh();
                }
            }
        },

        _ephQueueOrientationRefresh() {
            if (this._ephOrientationRefreshPending) return;
            this._ephOrientationRefreshPending = true;
            const refresh = () => {
                this._ephOrientationRefreshPending = false;
                this._ephMetaVer = (this._ephMetaVer || 0) + 1;
            };
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(refresh);
            else setTimeout(refresh, 0);
        },

        ephScanPortraitThumbnails() {
            if (typeof Image === 'undefined' || this._ephOrientationThumbnailScanInProgress) return;
            const groups = new Map();
            for (const it of this.ephub.items || []) {
                if (this.ephVideoOrientation(it).orientation !== 'unknown'
                    || it.thumbnail_orientation_checked
                    || !it.thumb) continue;
                const src = it.source || this.ephub.source || 'unknown';
                if (!groups.has(src)) groups.set(src, []);
                groups.get(src).push(it);
            }

            const candidates = [];
            const sourceGroups = [...groups.values()];
            for (let index = 0; index < Math.max(0, ...sourceGroups.map(g => g.length))
                && candidates.length < 48; index++) {
                for (const group of sourceGroups) {
                    if (group[index]) candidates.push(group[index]);
                    if (candidates.length >= 48) break;
                }
            }

            this._ephOrientationThumbnailPending = this._ephOrientationThumbnailPending || new Set();
            const targets = candidates.filter(it => !this._ephOrientationThumbnailPending.has(it.url));
            if (!targets.length) return;
            targets.forEach(it => this._ephOrientationThumbnailPending.add(it.url));
            this._ephOrientationThumbnailScanInProgress = true;
            let nextIndex = 0;
            let active = 0;
            const pump = () => {
                while (active < 4 && nextIndex < targets.length) {
                    const it = targets[nextIndex++];
                    active++;
                    const image = new Image();
                    const finish = () => {
                        active--;
                        this._ephOrientationThumbnailPending.delete(it.url);
                        if (nextIndex === targets.length && active === 0) {
                            this._ephOrientationThumbnailScanInProgress = false;
                            return;
                        }
                        pump();
                    };
                    image.onload = () => {
                        if (image.naturalWidth && image.naturalHeight) {
                            const wasEst = this.ephHasPortraitThumbnailEstimate(it);
                            it.thumbnail_width = image.naturalWidth;
                            it.thumbnail_height = image.naturalHeight;
                            it.thumbnail_orientation_checked = true;
                            const isEst = this.ephHasPortraitThumbnailEstimate(it);
                            if (wasEst !== isEst && ['portrait_estimate', 'portrait_any'].includes(this.ephub.orientation)) {
                                this._ephMetaVer = (this._ephMetaVer || 0) + 1;
                                this._ephQueueOrientationRefresh();
                            }
                        } else {
                            it.thumbnail_orientation_checked = true;
                        }
                        finish();
                    };
                    image.onerror = () => {
                        it.thumbnail_orientation_checked = true;
                        finish();
                    };
                    if ('fetchPriority' in image) image.fetchPriority = 'low';
                    image.src = this.ephMedia(it.thumb, it.source);
                }
            };
            pump();
        },

        async ephProbeUnknownOrientation(limit = 120) {
            if (typeof fetch !== 'function' || this._ephOrientationProbeInProgress) return;
            this._ephOrientationProbed = this._ephOrientationProbed || new Set();
            const targets = (this.ephub.items || [])
                .filter(it => it?.url && this.ephVideoOrientation(it).orientation === 'unknown'
                    && !this._ephOrientationProbed.has(it.url))
                .sort((a, b) => Number(this.ephIsTextHintPortrait(b)) - Number(this.ephIsTextHintPortrait(a)))
                .slice(0, limit);
            if (!targets.length) return;
            targets.forEach(it => this._ephOrientationProbed.add(it.url));
            this._ephOrientationProbeInProgress = true;
            try {
                const batches = [];
                for (let i = 0; i < targets.length; i += 8) batches.push(targets.slice(i, i + 8).map(it => it.url));
                let next = 0;
                const worker = async () => {
                    while (next < batches.length) {
                        const batch = batches[next++];
                        try {
                            const resp = await fetch('/api/v1/search/orientation', {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ urls: batch, timeout_s: 6 })
                            });
                            if (!resp?.ok) continue;
                            const patches = (await resp.json())?.orientation || {};
                            let updated = false;
                            for (const [url, patch] of Object.entries(patches)) {
                                const it = this.ephub.items.find(item => item.url === url);
                                if (!it) continue;
                                Object.assign(it, patch);
                                it.orientation_likely = '';
                                updated = true;
                            }
                            if (updated) {
                                this._ephMetaVer = (this._ephMetaVer || 0) + 1;
                            }
                        } catch (err) {
                            console.warn('[FusionHub Orientation] batch probe failed:', err);
                        }
                    }
                };
                await Promise.all([worker(), worker(), worker()]);
            } catch (err) {
                console.warn('[FusionHub Orientation] probe failed:', err);
            } finally {
                this._ephOrientationProbeInProgress = false;
            }
        },

        _ephAfterLoad() {
            this.ephRadarCheck(this.ephub.items);
            this.ephScheduleAutoFetch();
            if (this.ephWantsPortrait()) {
                this.ephProbeUnknownOrientation();
                this.ephScanPortraitThumbnails();
            }
        },

        // ── media / selection ──────────────────────────────────────────────
        ephMedia(url, source = '') {
            if (!url) return '/static/placeholder.jpg';
            return `${this.ephApi(source)}/media?url=${encodeURIComponent(url)}`;
        },
        // Sources whose CDN hotlink-protects its thumbnails: a direct request
        // with no (or the wrong) Referer comes back 403, so every one of their
        // cards showed a permanently blank/placeholder image once the proxy
        // stopped being the default. Live-verified 2026-07-25 by fetching one
        // real thumb per source with and without a Referer — whoreshub,
        // porntrex, xxbrits, xvideos, xhamster, noodlemagazine and tnaflix all
        // hotlink fine and stay direct; these four do not.
        _ephProxyFirst(source) {
            return ['eporner', 'camwhores', 'redtube', 'hqporner', 'pornhub', 'analdin'].includes(source || this.ephub.source);
        },
        // Card thumbnails load STRAIGHT from the CDN, with the dashboard proxy
        // as the fallback on error. It used to be the other way round: every
        // tile's image went through /hub/{source}/media, so a 120-card page was
        // 120 blocking upstream fetches queued on the server's thread pool —
        // competing with search and enrich for the same threads. That was the
        // single largest source of the grid's stutter.
        ephThumbSrc(item) {
            const url = (item && item.thumb) || '';
            if (!url) return '/static/placeholder.jpg';
            const source = (item && item.source) || this.ephub.source;
            return this._ephProxyFirst(source) ? this.ephMedia(url, source) : url;
        },
        ephImgError(ev, url, source = '') {
            const img = ev.target;
            if (img.dataset.proxied || !url || /\/media\?url=/.test(img.src)) {
                img.src = '/static/placeholder.jpg';
                return;
            }
            img.dataset.proxied = '1';
            img.src = `${this.ephApi(source)}/media?url=${encodeURIComponent(url)}`;
        },
        async ephBunkrThumbFallback(ev, item) {
            const img = ev.target;
            const source = item.source || this.ephub.source;
            if (source !== 'bunkr') return this.ephImgError(ev, item.thumb, source);
            if (img.dataset.videoFallback) return;
            img.dataset.videoFallback = '1';
            try {
                const response = await fetch(`${this.ephApi(source)}/resolve?url=${encodeURIComponent(item.url)}`);
                const data = await response.json();
                if (!response.ok || !data.stream_url || data.is_hls || !img.isConnected) return;
                const video = document.createElement('video');
                video.className = 'eph-thumb';
                video.muted = true;
                video.preload = 'metadata';
                video.playsInline = true;
                video.src = `${this.ephApi(source)}/stream?url=${encodeURIComponent(data.stream_url)}#t=1`;
                img.replaceWith(video);
            } catch (_) { /* Keep the placeholder when the stream is unavailable. */ }
        },
        // ── hover preview ──────────────────────────────────────────────────
        // Adapters already carry the site's own hover clip (`trailerURL` on
        // xHamster, `data-preview` on the KVS skins, `data-trailer_url` on
        // NoodleMagazine) in `Tile.preview`, and until now nothing rendered it.
        // A short delay keeps a mouse crossing the grid from firing a dozen
        // video loads on its way somewhere else.
        ephPreviewIn(ev, item) {
            if (!item || !item.preview) return;
            clearTimeout(this._ephPreviewTimer);
            const wrap = ev.currentTarget;
            this._ephPreviewTimer = setTimeout(() => {
                const video = wrap.querySelector('.eph-preview');
                if (!video) return;
                if (!video.src) video.src = item.preview;
                video.play().catch(() => { });
                wrap.classList.add('previewing');
            }, 320);
        },
        ephPreviewOut(ev) {
            clearTimeout(this._ephPreviewTimer);
            const wrap = ev.currentTarget;
            const video = wrap.querySelector('.eph-preview');
            wrap.classList.remove('previewing');
            if (video) { try { video.pause(); video.currentTime = 0; } catch (_) { } }
        },
        ephItemKey(it) { return it.url; },
        ephIsSelected(it) { return this.ephub.selected.includes(it.url); },
        ephToggleSelect(it) {
            const i = this.ephub.selected.indexOf(it.url);
            if (i >= 0) this.ephub.selected.splice(i, 1);
            else this.ephub.selected.push(it.url);
        },
        ephSelectFiltered() {
            const urls = this.ephFilteredItems().map(i => i.url);
            this.ephub.selected = [...new Set(this.ephub.selected.concat(urls))];
        },
        ephClearSelection() { this.ephub.selected = []; },
        async ephSplitSelected() {
            const items = this.ephub.items.filter(i => this.ephub.selected.includes(i.url) && (i.item_count || 1) <= 1)
                .map(i => ({ url: i.url, title: i.title || 'Video', poster: this.ephThumbSrc(i), source: i.source || this.ephub.source, duration: Number(i.duration_sec) || 0 }));
            if (!items.length) return this.showToast('Označ aspoň jedno video.', 'info', 'info');
            try {
                if (document.documentElement.dataset.nexusSplitReady !== '1') {
                    await new Promise((resolve, reject) => {
                        const script = document.createElement('script');
                        script.src = '/nexus-universal-splitscreen.user.js';
                        script.onload = resolve;
                        script.onerror = reject;
                        document.head.appendChild(script);
                    });
                }
                if (document.documentElement.dataset.nexusFusionSplitReady !== '1') {
                    return this.showToast('Aktualizuj nainštalovaný Nexus Split-Screen userscript a obnov stránku.', 'error', 'warning', 6000);
                }
                document.dispatchEvent(new CustomEvent('nexus-fusion-split-picker', { detail: JSON.stringify(items) }));
            } catch (_) { this.showToast('Split-Screen sa nepodarilo spustiť.', 'error', 'error'); }
        },

        // ── enrich status (Full metadata) helpers ──────────────────────────
        // undefined = never fetched, true = fetched OK, false = fetch failed.
        ephEnrichStatus(item) {
            if (item.enrichedQ === true) return 'ok';
            if (item.enrichedQ === false) return 'fail';
            return 'none';
        },
        ephEnrichCounts() {
            const c = { ok: 0, fail: 0, none: 0 };
            for (const it of this.ephFilteredItems()) c[this.ephEnrichStatus(it)]++;
            return c;
        },
        // Select every visible card in a given enrich state (adds to selection).
        ephSelectByStatus(status) {
            const urls = this.ephFilteredItems()
                .filter(i => this.ephEnrichStatus(i) === status)
                .map(i => i.url);
            this.ephub.selected = [...new Set(this.ephub.selected.concat(urls))];
            const label = { ok: 'úspešne načítané', fail: 'zlyhané', none: 'nenačítané' }[status] || status;
            this.showToast(`Vybraných ${urls.length} (${label})`, 'done_all', 'info', 1400);
        },
        // Re-run Full metadata for the SELECTED cards (clears their state first so
        // failed/stale ones are retried).
        async ephRefetchSelected() {
            const h = this.ephub;
            const sel = h.items.filter(i => h.selected.includes(i.url));
            const urls = sel.map(i => i.url);
            if (!urls.length) { this.showToast('Nič nie je vybrané', 'info', 'info', 1400); return; }
            if (!this._ephDispatched) this._ephDispatched = new Set();
            if (!this._ephDeepDispatched) this._ephDeepDispatched = new Set();
            urls.forEach(u => { this._ephDispatched.delete(u); this._ephDeepDispatched.delete(u); });
            for (let i = 0; i < h.items.length; i++) {
                if (h.selected.includes(h.items[i].url)) {
                    // Reset deepQ per THIS card's own source, not the active view —
                    // a Camwhores/xHamster card selected out of an ALL grid must
                    // still clear for its size pass to be retried.
                    const deep = this._ephDeepFor(h.items[i].source || h.source);
                    h.items.splice(i, 1, { ...h.items[i], enrichedQ: undefined, deepQ: deep ? undefined : h.items[i].deepQ });
                }
            }
            urls.forEach(u => this._ephDispatched.add(u));
            this.showToast(`Znovu načítavam ${urls.length}…`, 'sync', 'info', 1500);
            await this._ephRunEnrich(urls, { silent: false, skipWarn: true, wantDeep: true });
        },
        // Remove the SELECTED cards from the grid (just hides them locally).
        ephRemoveSelected() {
            const h = this.ephub;
            const before = h.items.length;
            h.items = h.items.filter(i => !h.selected.includes(i.url));
            const removed = before - h.items.length;
            h.selected = [];
            this.showToast(`Odstránených ${removed} kariet z gridu`, 'delete_sweep', 'info', 1500);
        },
        ephViews(value) {
            if (value == null || value === '') return '';
            const n = Number(value);
            return Number.isFinite(n) ? n.toLocaleString() : String(value);
        },

        // ── player (JIT resolve → HLS/mp4) ─────────────────────────────────
        async ephPlay(item) {
            // Folder card (turbo.cr-style album, item_count > 1): there's no single
            // stream to resolve — `item.url` is the album page itself — so open it
            // instead of sending the click into the player and surfacing a resolve
            // error. A 1-video album already collapsed to a normal playable tile
            // server-side (item_count stays 1), so it never hits this branch.
            if ((item.item_count || 1) > 1) {
                window.open(item.url, '_blank', 'noopener');
                this.showToast(`Priečinok: ${item.item_count} videí — otvorené na zdroji`, 'folder_open', 'info', 2000);
                return;
            }
            const source = item.source || this.ephub.source;
            // Switching videos: tear the current stream down IMMEDIATELY (before the
            // async resolve) so the old clip stops instead of playing on in the
            // background while we fetch the next one. A monotonic token guards
            // against a slow resolve landing after a newer click.
            this._ephDestroyHls();
            const token = (this._ephPlayToken = (this._ephPlayToken || 0) + 1);
            this.ephub.player = {
                open: true, loading: true, title: item.title || this.ephSourceLabel(source),
                error: '', item, source, portrait: false
            };
            this.ephLoadRelated(item, 'same');
            this.ephLoadLibrarySimilar(item);
            try {
                const r = await fetch(`${this.ephApi(source)}/resolve?url=${encodeURIComponent(item.url)}`);
                const d = await r.json();
                if (token !== this._ephPlayToken) return;           // superseded by a newer click
                if (!r.ok) throw new Error(d.detail || 'Nepodarilo sa prehrať');
                this.$nextTick(() => { if (token === this._ephPlayToken) this._ephAttach(d, source, token); });
            } catch (e) {
                if (token !== this._ephPlayToken) return;
                this.ephub.player.error = e.message || 'Nepodarilo sa prehrať';
                this.ephub.player.loading = false;
            }
        },
        _ephAttach(d, source = '', token = 0) {
            const v = this.$refs.ephvideo;
            if (!v) return;
            this._ephDestroyHls();
            // Detect portrait vs landscape so the modal can shrink its width for
            // tall cam clips. videoWidth/Height may be 0 at loadedmetadata, so also
            // re-check on loadeddata/resize. Assign the SAME handler (not
            // addEventListener) so it never piles up across video switches.
            const setOrient = () => {
                if (token && token !== this._ephPlayToken) return;
                const w = v.videoWidth, hgt = v.videoHeight;
                if (!w || !hgt) return;
                const portrait = hgt > w * 1.05;
                if (this.ephub.player.portrait !== portrait) {
                    this.ephub.player.portrait = portrait;
                    this.$nextTick(() => { });
                }
            };
            v.onloadedmetadata = setOrient;
            v.onloadeddata = setOrient;
            v.onresize = setOrient;
            // Clear the "loading…" overlay the moment real playback data arrives.
            v.oncanplay = () => { if (!token || token === this._ephPlayToken) this.ephub.player.loading = false; };
            // Continue-watching: resume where we left off, and checkpoint every ~5s.
            const item = this.ephub.player.item;
            const resumeAt = this.ephResumePos(item && item.url);
            if (resumeAt > 5) {
                v.onloadeddata = () => {
                    setOrient();
                    try { if (v.currentTime < 1 && resumeAt < (v.duration || 1e9)) v.currentTime = resumeAt; } catch (_) { }
                };
            }
            let _lastSave = 0;
            v.ontimeupdate = () => {
                const now = Date.now();
                if (now - _lastSave < 5000) return;
                _lastSave = now;
                this.ephRememberPosition(item, v.currentTime, v.duration);
            };
            v.onpause = () => this.ephRememberPosition(item, v.currentTime, v.duration);
            if (d.is_hls) {
                const proxied = `/hls_proxy?url=${encodeURIComponent(d.stream_url)}`;
                if (window.Hls && Hls.isSupported()) {
                    const hls = new Hls({ maxBufferLength: 30 });
                    this._ephHls = hls;
                    hls.loadSource(proxied);
                    hls.attachMedia(v);
                    hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => { }));
                    hls.on(Hls.Events.ERROR, (e, data) => { if (data.fatal) this.ephub.player.error = 'Chyba streamu'; });
                } else {
                    v.src = proxied; v.play().catch(() => { });
                }
            } else {
                // Route the mp4 through the dashboard: eporner CDN binds the URL to
                // the resolving IP + Referer, so playing it directly gives the
                // "only available at eporner.com" placeholder. The proxy replays it
                // from the same IP with the right Referer and passes Range for seeking.
                v.src = `${this.ephApi(source)}/stream?url=${encodeURIComponent(d.stream_url)}`;
                v.play().catch(() => { });
            }
            if (!token || token === this._ephPlayToken) this.ephub.player.loading = false;
        },
        // Hand the current stream over to Nexus Studio's cutter at the exact
        // second being watched. Deliberately a deep link and not an import: the
        // whole point of a hub moment is that the file never lands on disk, and
        // Studio re-resolves this same watch URL when the moment is played.
        ephCutMoment() {
            const item = this.ephub.player.item;
            const source = this.ephub.player.source || (item && item.source);
            if (!item || !item.url || !source) return;
            const v = this.$refs.ephvideo;
            const at = Math.max(0, Math.floor((v && v.currentTime) || 0));
            const hash = new URLSearchParams({ cut: '1', src: source, url: item.url, t: at });
            window.open('/studio#' + hash, '_blank', 'noopener');
        },
        _ephDestroyHls() {
            if (this._ephHls) { try { this._ephHls.destroy(); } catch (_) { } this._ephHls = null; }
            const v = this.$refs.ephvideo;
            if (v) {
                try {
                    v.onloadedmetadata = v.onloadeddata = v.onresize = v.oncanplay = null;
                    v.ontimeupdate = v.onpause = null;
                    v.pause(); v.removeAttribute('src'); v.load();
                } catch (_) { }
            }
        },
        ephClosePlayer() { this._ephDestroyHls(); this.ephub.player.open = false; },

        // ── related: same-source rail + cross-hub semantic search ──────────
        ephRelatedQuery(title) {
            const stop = new Set(['the', 'and', 'with', 'from', 'this', 'that', 'for', 'her', 'his', 'she', 'him', 'xxx', 'porn']);
            return String(title || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
                .filter(word => word.length > 2 && !stop.has(word)).slice(0, 5).join(' ');
        },
        async ephLoadRelated(item, mode = 'same') {
            if (!item?.url) return;
            const h = this.ephub;
            const source = item.source || h.source;
            h.related = { loading: true, mode, items: [], forTitle: item.title || '' };
            try {
                if (mode === 'same') {
                    const r = await fetch(`${this.ephApi(source)}/related?url=${encodeURIComponent(item.url)}`);
                    const d = await r.json();
                    if (!r.ok) throw new Error(d.detail || 'Related zlyhalo');
                    const same = (d.items || []).map(x => ({ ...x, source }));
                    // Empty same-source rail -> auto-fall back to a cross-hub search so
                    // the "related" panel is never blank.
                    if (!same.length) { h.related.loading = false; return this.ephLoadRelated(item, 'cross'); }
                    h.related.items = same;
                } else {
                    const q = this.ephRelatedQuery(item.title);
                    const targets = h.sources.filter(s => s.source !== source);
                    const pages = await Promise.allSettled(targets.map(async target => {
                        const p = new URLSearchParams({ q, sort: 'recent', page: '1' });
                        const r = await fetch(`${this.ephApi(target.source)}/search?${p}`);
                        const d = await r.json();
                        if (!r.ok) return [];
                        return (d.items || []).slice(0, 18).map(x => ({ ...x, source: target.source }));
                    }));
                    const seen = new Set();
                    h.related.items = pages.flatMap(p => p.status === 'fulfilled' ? p.value : [])
                        .filter(x => x.url && !seen.has(x.url) && seen.add(x.url)).slice(0, 36);
                }
            } catch (e) {
                h.related.items = [];
                this.showToast(e.message || 'Related zlyhalo', 'error', 'error');
            } finally { h.related.loading = false; }
        },

        // ── import (reuse the shared intake pipeline) ──────────────────────
        _ephCandidate(item) {
            const source = item.source || this.ephub.source;
            return {
                url: item.url, source_url: item.url,
                title: item.title || this.ephSourceLabel(source) + ' video',
                // Referer-locked CDNs serve nothing to the library later, so those
                // sources hand over the proxied URL instead of the raw one — an
                // imported video used to land with a permanently dead thumbnail.
                thumbnail: (item.thumb && this._ephProxyFirst(source))
                    ? this.ephMedia(item.thumb, source)
                    : (item.thumb || ''),
                source,
                duration: item.duration_sec || 0,
                quality: item.quality || '',
                height: item.height || 0,
                upload_date: item.added || '',
                // An estimated size is not a measurement; don't record it as one.
                file_size_mb: item.size_estimated ? undefined : (item.size_mb || undefined),
                tags: ['fusion-hub', source].concat((item.tags || []).slice(0, 8)),
                actors: (item.performers || []).map(p => p.name).filter(Boolean),
                categories: (item.categories || []).map(c => c.name).filter(Boolean),
            };
        },
        async ephImport(items, label) {
            if (!items.length) { this.showToast('Nič na import', 'info', 'info', 1500); return; }
            this.showToast(`Importujem ${items.length} video(í)…`, 'hourglass_empty', 'info', 1500);
            try {
                const r = await fetch('/api/v1/intake/import', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        candidates: items.map(i => this._ephCandidate(i)),
                        batch_name: label || 'Fusion Hub',
                        source_mode: 'fusion', auto_metadata: true, playwright_fallback: false,
                    }),
                });
                const data = await r.json();
                if (!r.ok) throw new Error(data.detail || 'Import zlyhal');
                this.showToast(`Zaradené ${items.length} → knižnica`, 'check_circle', 'success');
                setTimeout(() => { try { this.loadImportMonitor(true); } catch (_) { } }, 600);
            } catch (e) {
                this.showToast(e.message || 'Import zlyhal', 'error', 'error');
            }
        },
        ephImportOne(item) {
            // A folder has no single stream to import — same reasoning as ephPlay.
            if ((item.item_count || 1) > 1) {
                this.showToast('Toto je priečinok — otvor ho a importuj konkrétne video vnútri', 'folder_open', 'info', 2600);
                return;
            }
            this.ephImport([item], `${this.ephSourceLabel(item.source)} · ${(item.title || 'video').slice(0, 30)}`);
        },
        ephImportSelected() {
            const picked = this.ephub.items.filter(i => this.ephub.selected.includes(i.url));
            const folders = picked.filter(i => (i.item_count || 1) > 1);
            const sel = picked.filter(i => (i.item_count || 1) <= 1);
            if (folders.length) {
                this.showToast(`${folders.length} priečinok/y preskočené (otvor ich a importuj video vnútri)`, 'folder_open', 'info', 2600);
            }
            this.ephImport(sel, 'Fusion Hub výber');
            this.ephub.selected = [];
        },

        // ══ ALL: federated fan-out across every real source ═══════════════════
        // ══ Prime Cut ═══════════════════════════════════════════════════════
        // One keyword -> every source's best N tiles, combining each source's
        // newest and most-relevant passes and gating on real quality. The whole
        // fan-out (including the enrich verification) runs server-side; doing it
        // from here would be dozens of round-trips per source.
        async ephPrimeCut() {
            const h = this.ephub;
            const q = (h.q || '').trim();
            if (!q) { this.showToast('Najprv zadaj kľúčové slovo', 'search', 'info'); return; }
            h.presetActive = '';
            return this._ephPrimeRun({
                url: `/api/v1/hub/prime/stream?${new URLSearchParams({
                    q,
                    per_source: String(h.primeN),
                    min_height: String(h.primeMinH),
                    allow_unverified: h.primeLoose ? 'true' : 'false',
                    deadline: '90',
                })}`,
                label: q,
            });
        },

        // Load the curated preset chips once. Failure is silent: presets are an
        // accelerator, and a hub that works fine without them should not greet
        // the user with an error toast because one optional list did not load.
        async ephLoadPresets() {
            if (this.ephub.presets.length) return;
            try {
                const r = await fetch('/api/v1/hub/presets');
                if (!r.ok) return;
                const d = await r.json();
                this.ephub.presets = d.presets || [];
            } catch (_) { /* chips just stay hidden */ }
        },

        // Run one curated preset. Same streamed Prime Cut, but the query and its
        // tuned relevance bar come from the server-side preset table.
        async ephRunPreset(id) {
            const h = this.ephub;
            const row = (h.presets || []).find(p => p.id === id);
            if (!row) return;
            h.presetActive = id;
            h.q = '';                       // the preset IS the query now
            return this._ephPrimeRun({
                url: `/api/v1/hub/preset/stream?${new URLSearchParams({
                    preset: id,
                    per_source: String(h.primeN),
                    min_height: String(h.primeMinH),
                    allow_unverified: h.primeLoose ? 'true' : 'false',
                    deadline: '120',
                })}`,
                label: row.label,
            });
        },

        // Shared engine for Prime Cut and presets: both stream the identical
        // NDJSON shape, so the reader, progress strip and result handling live
        // here once rather than in two copies that can drift apart.
        async _ephPrimeRun({ url, label }) {
            const h = this.ephub;
            const q = label;
            const seq = (this._ephSeq = this._ephSeq + 1);
            h.prime.running = true; h.loading = true;
            h.prime.groups = [];
            this.ephBusyStart('prime', `Prime Cut · ${q}`, 0, 'auto_awesome');
            try {
                // Streamed: one line per source as it finishes, so the strip can
                // show real progress instead of an opaque spinner. The hub router
                // is mounted under /api/v1, not at a bare /hub.
                const r = await fetch(url);
                if (r.status === 404) {
                    throw new Error('Prime Cut endpoint chýba — reštartuj server.');
                }
                if (!r.ok || !r.body) throw new Error(`Prime Cut zlyhal (HTTP ${r.status})`);

                const reader = r.body.getReader();
                const dec = new TextDecoder();
                let buf = '';
                let d = null;
                const handle = (line) => {
                    line = line.trim();
                    if (!line) return;
                    let ev; try { ev = JSON.parse(line); } catch (_) { return; }
                    if (ev.type === 'preset') {
                        // Header line of a preset run — tells us which tag mix is
                        // actually being searched, so the strip can name it.
                        this.ephBusyStep('prime', 0, (ev.tags || []).join(' + '), 0);
                    } else if (ev.type === 'start') {
                        this.ephBusyStep('prime', 0, `0 / ${ev.total_sources} zdrojov`, ev.total_sources);
                    } else if (ev.type === 'source') {
                        const g = ev.group || {};
                        h.prime.groups = [...h.prime.groups, g];
                        const n = (g.items || []).length;
                        this.ephBusyStep('prime', ev.done,
                            `${g.source}: ${g.error ? 'chyba' : n + ' videí'} · spolu ${ev.tiles_so_far}`,
                            ev.total_sources);
                    } else if (ev.type === 'done') {
                        d = ev;
                    } else if (ev.type === 'error') {
                        throw new Error(ev.detail || 'Prime Cut zlyhal');
                    }
                };
                while (true) {
                    const { done, value } = await reader.read();
                    if (seq !== this._ephSeq) { try { reader.cancel(); } catch (_) { } return; }
                    if (done) break;
                    buf += dec.decode(value, { stream: true });
                    let nl;
                    while ((nl = buf.indexOf('\n')) >= 0) {
                        handle(buf.slice(0, nl));
                        buf = buf.slice(nl + 1);
                    }
                }
                if (buf.trim()) handle(buf);
                if (seq !== this._ephSeq) return;      // a newer load superseded us
                if (!d) throw new Error('Prime Cut sa neukončil — spojenie prerušené');
                // Prime Cut already resolved real quality server-side (that is how
                // the >=Np gate was applied), so tiles it confirmed are marked as
                // fetched. Without this the grid would show them as "not fetched"
                // and re-run an enrich pass that cannot learn anything new.
                h.items = (d.items || []).map(it => (
                    it.quality_verified && (it.height || 0) > 0
                        ? { ...it, enrichedQ: true }
                        : it
                ));
                h.prime.groups = d.groups || [];
                h.prime.tookMs = d.took_ms || 0;
                h.prime.on = true;
                h.total = h.items.length;
                h.pageSize = h.items.length;
                h.hasMore = false;
                h.page = 1;
                // Only a real typed keyword belongs in the search history — a
                // preset label is not something the user can re-type to get this
                // result back, so replaying it from history would mislead.
                if (!h.presetActive) this.ephPushHistory(q);
                this.ephTrailPush('search', `Prime Cut · ${q}`);
                this._ephAfterLoad();
                const live = (d.groups || []).filter(g => (g.items || []).length).length;
                this.showToast(
                    `Prime Cut: ${h.items.length} videí z ${live}/${d.sources_total} zdrojov (${h.primeMinH}p+)`,
                    'auto_awesome', 'success', 4200);
            } catch (e) {
                if (seq === this._ephSeq) this.showToast(e.message || 'Prime Cut zlyhal', 'error', 'error');
            } finally {
                this.ephBusyEnd('prime');
                if (seq === this._ephSeq) { h.prime.running = false; h.loading = false; }
            }
        },
        // Per-source outcome for the Prime Cut summary strip.
        ephPrimeGroups() {
            return (this.ephub.prime.groups || []).map(g => ({
                source: g.source,
                label: g.label || g.source,
                n: (g.items || []).length,
                note: g.error ? 'chyba' : (() => {
                    const s = g.stats || {};
                    if (!s.harvested) return 'nič nenašiel';
                    if (s.dropped_irrelevant) {
                        return `${s.relevant || 0}/${s.harvested} relevantných`;
                    }
                    return '';
                })(),
            }));
        },

        // ALL is a federated fan-out, and it used to be a client-side
        // Promise.allSettled over every source — so the grid waited for the
        // slowest one (TNAFlix runs on sync requests with a 20s timeout) before
        // showing anything at all. It now consumes the server's NDJSON stream:
        // each source's tiles land the moment that source answers, a wall-clock
        // deadline cancels stragglers, and re-hosts are collapsed as they merge.
        async ephLoadAll(append = false) {
            const h = this.ephub;
            const seq = (this._ephSeq = this._ephSeq + 1);
            h.loading = true;
            const started = Date.now();
            if (!append) {
                h.page = 1; h.items = []; h.total = 0; h.pageSize = 0;
                h.hasMore = false; h.tookMs = 0; h.allDiagnostics = [];
            }
            // Mirrors the server's _ALL_DEFAULT_EXCLUDE (app/routers/hub.py):
            // TNAFlix/RedTube stay fully browsable on their own tab but are left
            // out of the default ALL fan-out — every ALL search pays a latency
            // + enrich-bandwidth cost for every included source, and these two
            // measured as redundant with better-covered sources rather than
            // occasionally rare. This only matters for the fallback path below;
            // the primary /hub/all/stream request already applies the same
            // default server-side.
            const targets = h.sources.filter(s => s.source !== 'all' && !this._EPH_ALL_DEFAULT_EXCLUDE.includes(s.source));
            const q = h.q.trim();
            this.ephBusyStart('all', q ? `ALL · ${q}` : 'ALL · feed', targets.length, 'travel_explore');
            const params = new URLSearchParams({
                sort: h.sort || 'recent',
                page: String(h.page),
                per_source: String(h.allPerSource || 12),
                deadline: String(h.allDeadline || 8),
            });
            if (q) { params.set('q', q); params.set('strict_relevance', 'true'); }
            let done = 0;
            const seenUrls = new Set(append ? h.items.map(i => i.url) : []);
            try {
                const r = await fetch(`/api/v1/hub/all/stream?${params}`);
                if (!r.ok || !r.body) throw new Error('stream unavailable');
                const reader = r.body.getReader();
                const dec = new TextDecoder();
                let buf = '';
                const apply = (ev) => {
                    if (seq !== this._ephSeq) return;
                    if (ev.type === 'source') {
                        h.allDiagnostics = [...h.allDiagnostics, {
                            source: ev.source, raw: ev.raw || 0, shown: ev.shown || 0,
                            error: ev.error || '', tookMs: ev.took_ms || 0,
                        }];
                        const fresh = (ev.items || [])
                            .map(x => ({ ...x, source: x.source || ev.source }))
                            .filter(x => x.url && !seenUrls.has(x.url));
                        fresh.forEach(x => seenUrls.add(x.url));
                        if (fresh.length) {
                            // Merge, then collapse re-hosts across everything on
                            // screen so one scene from three sites is one card.
                            h.items = this.ephDedupe(h.items.concat(fresh));
                            h.total = h.items.length;
                            this._ephMetaVer = (this._ephMetaVer || 0) + 1;
                        }
                        this.ephBusyStep('all', ++done, `${ev.source}${ev.error ? ' · ' + ev.error : ''}`);
                    } else if (ev.type === 'done') {
                        h.tookMs = ev.took_ms || (Date.now() - started);
                    }
                };
                while (true) {
                    const { done: fin, value } = await reader.read();
                    if (seq !== this._ephSeq) { try { reader.cancel(); } catch (_) { } return; }
                    if (fin) break;
                    buf += dec.decode(value, { stream: true });
                    let nl;
                    while ((nl = buf.indexOf('\n')) >= 0) {
                        const line = buf.slice(0, nl).trim();
                        buf = buf.slice(nl + 1);
                        if (!line) continue;
                        try { apply(JSON.parse(line)); } catch (_) { }
                    }
                }
                if (buf.trim()) { try { apply(JSON.parse(buf.trim())); } catch (_) { } }
                if (seq !== this._ephSeq) return;
                if (!h.tookMs) h.tookMs = Date.now() - started;
                h.pageSize = h.items.length || h.pageSize;
                h.hasMore = h.items.length > 0;
                if (!append && q) this.ephPushHistory(q);
                this._ephAfterLoad();
            } catch (e) {
                // Older server without /hub/all/stream: fall back to the
                // client-side fan-out so ALL keeps working.
                if (seq === this._ephSeq) await this._ephLoadAllFallback(append, seq, started, targets, q);
            } finally {
                this.ephBusyEnd('all');
                if (seq === this._ephSeq) h.loading = false;
            }
        },
        async _ephLoadAllFallback(append, seq, started, targets, q) {
            const h = this.ephub;
            const results = await Promise.allSettled(targets.map(async t => {
                const p = new URLSearchParams({ sort: h.sort || 'recent', page: String(h.page) });
                if (q) { p.set('q', q); p.set('strict_relevance', 'true'); }
                const ep = q ? 'search' : 'feed';
                try {
                    const r = await fetch(`${this.ephApi(t.source)}/${ep}?${p}`);
                    let d = {};
                    try { d = await r.json(); } catch (_) { }
                    if (!r.ok) return { source: t.source, items: [], raw: 0, shown: 0, error: d.detail || `HTTP ${r.status}` };
                    const raw = Number(d.raw_count ?? (d.items || []).length) || 0;
                    const items = (d.items || []).slice(0, h.allPerSource || 12)
                        .map(x => ({ ...x, source: t.source }));
                    return { source: t.source, items, raw, shown: items.length, error: '' };
                } catch (error) {
                    return { source: t.source, items: [], raw: 0, shown: 0, error: error?.message || 'network error' };
                }
            }));
            if (seq !== this._ephSeq) return;
            const outcomes = results.map((r, i) => r.status === 'fulfilled' ? r.value
                : { source: targets[i].source, items: [], raw: 0, shown: 0, error: 'network error' });
            h.allDiagnostics = outcomes.map(o => ({ source: o.source, raw: o.raw, shown: o.shown, error: o.error || '' }));
            const lists = outcomes.map(o => o.items || []);
            const merged = [];
            const seen = new Set(append ? h.items.map(i => i.url) : []);
            for (let i = 0, more = true; more; i++) {
                more = false;
                for (const l of lists) {
                    if (l[i]) { more = true; if (l[i].url && !seen.has(l[i].url)) { seen.add(l[i].url); merged.push(l[i]); } }
                }
            }
            h.items = this.ephDedupe(append ? h.items.concat(merged) : merged);
            h.total = h.items.length; h.pageSize = merged.length || h.pageSize;
            h.hasMore = merged.length > 0; h.tookMs = Date.now() - started;
            if (!append && q) this.ephPushHistory(q);
            this._ephAfterLoad();
        },

        // ══ Radar: do I already have this? (library / discovered / unknown) ═══
        async ephRadarCheck(items) {
            if (!this.ephub.radarOn || !items || !items.length) return;
            const urls = items.map(i => i.url).filter(u => u && this.ephub.radar[u] === undefined);
            if (!urls.length) return;
            try {
                const r = await fetch('/api/v1/radar/check', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ urls }),
                });
                if (!r.ok) return;
                const d = await r.json();
                const map = {};
                for (const [u, v] of Object.entries(d.results || {})) map[u] = v.status || 'unknown';
                // reassign so Alpine sees the change
                this.ephub.radar = { ...this.ephub.radar, ...map };
            } catch (_) { }
        },
        ephRadarStatus(item) { return (item && this.ephub.radar[item.url]) || ''; },
        ephRadarLabel(item) {
            return { library: 'Už v knižnici', discovered: 'Vo fronte na review' }[this.ephRadarStatus(item)] || '';
        },

        // ══ Watch-later shortlist (persisted locally) ═════════════════════════
        ephInWatchLater(item) { return this.ephub.watchLater.some(w => w.url === item.url); },
        ephToggleWatchLater(item) {
            const h = this.ephub;
            const i = h.watchLater.findIndex(w => w.url === item.url);
            if (i >= 0) { h.watchLater.splice(i, 1); this.showToast('Odobrané zo zoznamu', 'bookmark_remove', 'info', 1200); }
            else {
                h.watchLater.unshift({ ...this._ephSlim(item), savedAt: Date.now() });
                this.showToast('Uložené na neskôr', 'bookmark_added', 'success', 1200);
            }
            this.ephPersist();
        },
        ephOpenWatchLater() {
            const h = this.ephub;
            h.view = 'watchlater'; h.q = ''; h.plId = ''; h.psSlug = '';
            h.items = h.watchLater.map(w => ({ ...w })); h.hasMore = false; h.total = h.items.length;
            this.ephRadarCheck(h.items);
        },
        ephClearWatchLater() {
            if (!window.confirm('Vyprázdniť celý zoznam na neskôr?')) return;
            this.ephub.watchLater = []; this.ephPersist();
            if (this.ephub.view === 'watchlater') this.ephOpenWatchLater();
        },

        // ══ Continue watching (persisted playback positions) ══════════════════
        _ephSlim(item) {
            return {
                url: item.url, source: item.source || this.ephub.source, title: item.title || '',
                thumb: item.thumb || '', duration: item.duration || '', duration_sec: item.duration_sec || 0,
                quality: item.quality || '', height: item.height || 0, hd: !!item.hd,
                views: item.views || '', added: item.added || '', tags: (item.tags || []).slice(0, 8),
            };
        },
        ephRememberPosition(item, pos, dur) {
            if (!item || !item.url || !pos || pos < 15) return;      // ignore tiny scrubs
            if (dur && pos > dur * 0.95) { this.ephForgetPosition(item.url); return; }  // finished
            const h = this.ephub;
            const rec = { ...this._ephSlim(item), pos: Math.floor(pos), dur: Math.floor(dur || 0), at: Date.now() };
            h.continueWatch = [rec, ...h.continueWatch.filter(c => c.url !== item.url)].slice(0, 40);
            this.ephPersist();
        },
        ephForgetPosition(url) {
            this.ephub.continueWatch = this.ephub.continueWatch.filter(c => c.url !== url);
            this.ephPersist();
        },
        ephResumePos(url) { const r = this.ephub.continueWatch.find(c => c.url === url); return r ? r.pos : 0; },
        ephResumePct(rec) { return rec.dur ? Math.min(100, Math.round(rec.pos / rec.dur * 100)) : 0; },
        ephOpenContinue() {
            const h = this.ephub;
            h.view = 'continue'; h.q = ''; h.plId = ''; h.psSlug = '';
            h.items = h.continueWatch.map(c => ({ ...c })); h.hasMore = false; h.total = h.items.length;
            this.ephRadarCheck(h.items);
        },

        // ══ Search history ════════════════════════════════════════════════════
        ephPushHistory(q) {
            q = (q || '').trim(); if (!q) return;
            const h = this.ephub;
            h.searchHistory = [q, ...h.searchHistory.filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 12);
            this.ephPersist();
        },
        ephHistoryList() {
            const f = this.ephub.q.trim().toLowerCase();
            return this.ephub.searchHistory.filter(x => !f || x.toLowerCase().includes(f)).slice(0, 8);
        },
        ephPickHistory(q) { this.ephub.q = q; this.ephub.histOpen = false; this.ephLoad(false); },
        ephClearHistory() { this.ephub.searchHistory = []; this.ephPersist(); },

        // ══ localStorage persistence ══════════════════════════════════════════
        ephPersist() {
            try {
                const h = this.ephub;
                localStorage.setItem('nx_hub_state', JSON.stringify({
                    source: h.source, cols: h.cols, radarOn: h.radarOn,
                    watchLater: h.watchLater.slice(0, 200),
                    continueWatch: h.continueWatch.slice(0, 40),
                    searchHistory: h.searchHistory,
                }));
            } catch (_) { }
        },
        ephRestore() {
            try {
                const raw = localStorage.getItem('nx_hub_state');
                if (!raw) return;
                const s = JSON.parse(raw);
                const h = this.ephub;
                if (Array.isArray(s.watchLater)) h.watchLater = s.watchLater;
                if (Array.isArray(s.continueWatch)) h.continueWatch = s.continueWatch;
                if (Array.isArray(s.searchHistory)) h.searchHistory = s.searchHistory;
                if (typeof s.cols === 'number') h.cols = s.cols;
                if (typeof s.radarOn === 'boolean') h.radarOn = s.radarOn;
                if (s.source && typeof s.source === 'string') h._restoredSource = s.source;
            } catch (_) { }
        },

        // ══ Follows + inbox (server-backed) ═══════════════════════════════════
        // What can be followed depends on the current view: a performer, a playlist,
        // a category, or the current search.
        ephFollowTarget() {
            const h = this.ephub;
            if (h.view === 'pornstar' && h.psSlug) return { kind: 'performer', ref: h.psSlug, name: h.psName };
            if (h.view === 'playlist' && h.plId) return { kind: 'playlist', ref: h.plId, name: h.plName };
            if (h.activeCat) return { kind: 'category', ref: h.activeCat, name: h.activeCatName };
            if (h.q.trim()) return { kind: 'search', ref: h.q.trim(), name: '„' + h.q.trim() + '"' };
            return null;
        },
        _ephFollowKey(t) { return `${this.ephub.source}:${t.kind}:${(t.ref || '').toLowerCase()}`; },
        ephIsFollowing() {
            const t = this.ephFollowTarget(); if (!t) return false;
            return this.ephub.follows.some(f => f.key === this._ephFollowKey(t));
        },
        async ephToggleFollow() {
            const h = this.ephub;
            const t = this.ephFollowTarget();
            if (!t) { this.showToast('Vyber herca, playlist, kategóriu alebo hľadanie na sledovanie', 'info', 'info', 2500); return; }
            const key = this._ephFollowKey(t);
            const following = h.follows.some(f => f.key === key);
            try {
                if (following) {
                    const r = await fetch('/api/v1/hub/follows/remove', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key })
                    });
                    const d = await r.json(); h.follows = d.follows || [];
                    this.showToast('Sledovanie zrušené', 'notifications_off', 'info', 1400);
                } else {
                    const r = await fetch('/api/v1/hub/follows', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ source: h.source, kind: t.kind, ref: t.ref, name: t.name })
                    });
                    const d = await r.json(); h.follows = d.follows || h.follows;
                    this.showToast('Sledujem — upozorním na nové videá', 'notifications_active', 'success', 1800);
                }
            } catch (e) { this.showToast('Sledovanie zlyhalo', 'error', 'error'); }
        },
        async ephLoadFollows() {
            try { const r = await fetch('/api/v1/hub/follows'); const d = await r.json(); this.ephub.follows = d.follows || []; } catch (_) { }
        },
        async ephCheckInbox() {
            const h = this.ephub; h.inbox.loading = true;
            try {
                const r = await fetch('/api/v1/hub/follows/check', { method: 'POST' });
                const d = await r.json();
                h.follows = d.follows || []; h.inbox.total = d.total_new || 0;
                if (h.inbox.total) this.showToast(`${h.inbox.total} nových videí od sledovaných`, 'notifications', 'info', 2500);
            } catch (_) { } finally { h.inbox.loading = false; }
        },
        async ephOpenFollow(f) {
            const h = this.ephub;
            this.ephub.inbox.open = false;
            if (f.source && f.source !== h.source) await this.ephSetSource(f.source);
            // clear the "new" badge for this follow
            fetch('/api/v1/hub/follows/seen', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: f.key })
            }).then(r => r.json()).then(d => { h.follows = d.follows || h.follows; }).catch(() => { });
            if (f.kind === 'performer') return this.ephOpenPornstar(f.ref, f.name);
            if (f.kind === 'playlist') return this.ephOpenPlaylist(f.ref, f.name);
            if (f.kind === 'category') return this.ephOpenCategory(f.ref, f.name);
            if (f.kind === 'search') { h.q = f.ref; h.view = 'feed'; return this.ephLoad(false); }
            h.view = 'feed'; return this.ephLoad(false);
        },
        async ephUnfollow(f) {
            try {
                const r = await fetch('/api/v1/hub/follows/remove', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: f.key })
                });
                const d = await r.json(); this.ephub.follows = d.follows || [];
            } catch (_) { }
        },
        ephInboxTotal() { return this.ephub.follows.reduce((s, f) => s + (f.new_count || 0), 0); },

        // ══ Hub <-> library semantic panel (inside the player) ════════════════
        async ephLoadLibrarySimilar(item) {
            const h = this.ephub;
            const title = (item.title || '').trim();
            h.libSim = { loading: true, items: [], forTitle: title };
            if (title.length < 3) { h.libSim.loading = false; return; }
            try {
                const r = await fetch(`/api/v1/hub/library-similar?q=${encodeURIComponent(title)}&limit=8`);
                const d = await r.json();
                h.libSim.items = (d.items || []).filter(x => (x.score || 0) > 0.15);
            } catch (_) { h.libSim.items = []; } finally { h.libSim.loading = false; }
        },
        // ══ Keyboard ══════════════════════════════════════════════════════════
        // Triage is a repeated motion — judge, mark, move on — and doing it with
        // the mouse is the slowest part of the loop. These bindings are live
        // whenever the hub is open and the caret is not in a text field.
        //   ← → ↑ ↓ / h j k l   move between cards      Enter  play
        //   Space  mark select                          i      import
        //   b      save for later                       /      jump to search
        ephKey(ev) {
            const h = this.ephub;
            if (!h.open) return;
            const tag = (ev.target?.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || tag === 'select' || ev.target?.isContentEditable) {
                if (ev.key === 'Escape') ev.target.blur();
                return;
            }
            if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
            const list = this.ephFilteredItems();
            const cols = h.cols || 7;
            const move = (delta) => {
                if (!list.length) return;
                const next = h.focusIdx < 0 ? 0 : Math.min(list.length - 1, Math.max(0, h.focusIdx + delta));
                h.focusIdx = next;
                this.$nextTick(() => {
                    document.querySelector('.eph-card.kbd')
                        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                });
            };
            const current = () => (h.focusIdx >= 0 ? list[h.focusIdx] : null);
            switch (ev.key) {
                case '/': ev.preventDefault(); document.querySelector('.eph-search')?.focus(); return;
                case 'ArrowRight': case 'l': ev.preventDefault(); return move(1);
                case 'ArrowLeft': case 'h': ev.preventDefault(); return move(-1);
                case 'ArrowDown': case 'j': ev.preventDefault(); return move(cols);
                case 'ArrowUp': case 'k': ev.preventDefault(); return move(-cols);
                default: break;
            }
            const item = current();
            if (!item) return;
            if (ev.key === 'Enter') { ev.preventDefault(); this.ephPlay(item); }
            else if (ev.key === ' ') { ev.preventDefault(); this.ephToggleSelect(item); }
            else if (ev.key === 'i') { ev.preventDefault(); this.ephImportOne(item); }
            else if (ev.key === 'b') { ev.preventDefault(); this.ephToggleWatchLater(item); }
        },
        ephIsFocused(item) {
            const list = this.ephFilteredItems();
            const idx = this.ephub.focusIdx;
            return idx >= 0 && list[idx] && list[idx].url === item.url;
        },
        ephLibThumb(row) {
            try { return (this.proxifyUrl ? this.proxifyUrl(row.thumbnail_path) : row.thumbnail_path) || '/static/placeholder.jpg'; }
            catch (_) { return '/static/placeholder.jpg'; }
        },
    };
}

if (typeof window !== 'undefined') {
    window.createEpornerHubModule = createEpornerHubModule;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createEpornerHubModule };
}
