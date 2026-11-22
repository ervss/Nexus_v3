// Faphouse standalone page — own Alpine.js component, own state. Talks to the
// generic Fusion Hub REST surface (/api/v1/hub/faphouse/*, already free once
// FaphouseHub is registered) for browsing/search/resolve, and to the
// Faphouse-only surface (/api/v1/faphouse/*) for playlists/history/follows/
// for-you/mashup — DB-backed, not localStorage, per the design spec.

// Registered via Alpine.data() inside alpine:init (below) rather than
// referenced as a bare global in x-data="faphouseApp()" — Alpine's CDN
// script and this file are both `defer`, but load order between a remote
// and a same-origin script isn't guaranteed, and Alpine scans x-data as soon
// as it starts. Registering by name and waiting for alpine:init is the
// pattern already used for the main dashboard (see index.html's
// Alpine.data('dashboard', ...) fallback registration).
function faphouseApp() {
  return {
    // ---- nav / tab state ----
    tab: 'discover',

    // ---- display density: 'compact' | 'cozy' | 'relaxed' — more cards vs.
    // bigger cards/text/badges for reading from further away (lying down vs.
    // sitting close). Persisted so it survives a reload. ----
    density: 'cozy',

    // ---- discover ----
    query: '',
    sort: 'recent',
    category: '',
    minHeight: 0,
    durationBucket: '',
    filtersOpen: false,
    categories: [],
    items: [],
    page: 1,
    hasMore: false,
    // 0 keeps the normal one-page search. Any positive value asks the
    // initial search to keep paging until this many cards survive the active
    // local quality/duration filters (the UI caps the target at 1,000).
    initialLoadTarget: 0,
    autoLoading: false,
    _searchRun: 0,
    // True once loadMore() has confirmed there's nothing left (an empty
    // page, or the next page failing outright) — drives the "Prešiel si
    // všetky videá" message so it only shows after a real attempt, not
    // just because hasMore happens to be false before the first search runs.
    endOfResults: false,
    loading: false,
    openDetailsUrls: new Set(),
    //: Bulk-select for the Discover grid — url -> true. A Set instead of an
    //: array so toggling/checking membership is O(1) regardless of how many
    //: cards are on screen, and Alpine re-renders fine off a `new Set(...)`
    //: reassignment (mutating in place wouldn't trigger reactivity).
    selectedUrls: new Set(),
    bulkImporting: false,
    netStatus: {},
    tagChips: [],
    tagChipDraft: '',
    actorChips: [],
    actorChipDraft: '',

    // ---- for you ----
    forYouItems: [],

    // ---- models & studios ----
    modelQuery: '',
    follows: [],
    newFollowsCount: 0,
    currentProfile: null,
    profileItems: [],

    // ---- playlists ----
    playlists: [],
    playlistQuery: '',
    activePlaylist: null,
    playlistItems: [],
    playlistItemQuery: '',
    addToPlaylistTarget: null,

    // ---- community playlist search (other users' public Faphouse
    // playlists — Faphouse itself has no keyword search over these, so a
    // local crawl+index backs this; see app/routers/faphouse.py) ----
    playlistScope: 'mine',  // 'mine' | 'community'
    communityQuery: '',
    communityResults: [],
    communityTotalIndexed: 0,
    communitySearching: false,
    //: "Len obľúbené" switch — when on, searchCommunityPlaylists() ignores
    //: communityQuery and lists starred playlists instead (see backend's
    //: favorites_only param).
    communityFavoritesOnly: false,
    crawlStatus: { status: 'idle', current_page: 0, playlists_found: 0, popular_done: false, new_done: false },
    crawlPolling: null,
    //: code -> probe result ({quality_rating, avg_duration_sec, avg_size_mb,
    //: total_size_mb, ...} or {loading:true} or {error:'...'}), keyed so
    //: each card renders its own fetched/loading/failed state independently.
    communityProbes: {},
    communityProbeAllRunning: false,
    //: code -> import result ({loading:true} while walking the playlist's
    //: pages server-side, {queued, job_id} once the ImportJob is created, or
    //: {error:'...'}) — same per-card keyed pattern as communityProbes.
    communityImports: {},
    //: The community playlist currently open for browsing — {code, name,
    //: published_by, video_count} from communityResults, or null when
    //: showing the search list instead.
    openCommunityPl: null,
    communityPlItems: [],
    communityPlPage: 1,
    communityPlHasMore: false,
    communityPlLoading: false,
    //: Keyword filter over the currently-open community playlist's own
    //: items — same client-side pattern as playlistItemQuery/
    //: visiblePlaylistItems() for "my" playlists, just scoped to
    //: communityPlItems instead.
    communityPlItemQuery: '',
    communityPlFetchAllRunning: false,
    //: Live progress for fetchAllCommunityPl()/fetchSelectedCommunityPl() —
    //: {done, total} updated after every 40-item enrich chunk so the bar can
    //: show "X / Y (Z%)" instead of just a spinning "running" state. total=0
    //: means no fetch is in progress (hides the bar).
    communityPlFetchProgress: { done: 0, total: 0 },
    //: Fanclub-only ("access type: fan") videos 404 on stream resolve for
    //: any account that isn't a paying fan of that specific studio/pornstar
    //: — no fetch, no streaming, so they're dead weight in the grid. Once
    //: enrich() flags an item `locked` (see hubs/faphouse.py's
    //: _watch_page_details), it's hidden by default; this switch reveals
    //: them again for the rare case the user wants to see what's there.
    communityPlShowLocked: false,
    //: 'none' | 'size_desc' | 'size_asc' | 'duration_desc' | 'duration_asc'.
    //: Client-side only — sorts whatever's currently loaded in
    //: communityPlItems, same "no server round-trip" approach as the
    //: keyword filter above.
    communityPlSort: 'none',
    //: Selected quality labels (e.g. "4K", "1080p") to keep — empty Set
    //: means no filter applied (show every quality). Items without a
    //: resolved quality yet (pre-enrich) are always shown regardless of this
    //: filter, since hiding them would look like they vanished rather than
    //: "not yet fetched".
    communityPlQualityFilter: new Set(),

    // ---- history ----
    history: [],
    continueWatching: [],

    // ---- player modal ----
    player: { open: false, item: null, error: '' },
    _playerHls: null,

    // ---- watch later (kept local: a lightweight pin list, distinct from
    // the DB-backed history/playlists — mirrors Fusion Hub v2's pattern) ----
    watchLater: [],

    // ---- mashup studio ----
    mashup: {
      layout: 'side-by-side',
      tracks: [],       // {trackId, url, source, title, previewUrl, mute, crop_keyframes, position_keyframes}
      selectedTrack: null,
      activeAudioTrack: 0,
      rendering: false,
      jobs: [],
      pollTimer: null,
    },
    kfTimeInput: 0,
    cropDraft: { cx: 0.5, cy: 0.5, cw: 1.0, ch: 1.0 },

    get sessionHint() {
      if (!this.netStatus.cookie_present) {
        return 'Chýba faphouse_cookies.txt — prihlás sa v prehliadači, Nexus_Gallery rozšírenie ho pošle automaticky';
      }
      const mtime = this.netStatus.cookie_mtime;
      if (mtime) {
        const ageMin = Math.round((Date.now() / 1000 - mtime) / 60);
        if (ageMin > 60) {
          const ageH = Math.round(ageMin / 60);
          return `Relácia sa naposledy obnovila pred ${ageH} h — ak niečo prestane fungovať, over že rozšírenie beží a si prihlásený v prehliadači`;
        }
      }
      return 'Faphouse relácia je aktívna (auto-refresh cez rozšírenie)';
    },

    // True once the cookie jar is old enough that a resolve()/search() failure
    // is more likely "session actually died" than "transient network hiccup" —
    // used to redden the header icon a step earlier than a hard failure would.
    get sessionStale() {
      const mtime = this.netStatus.cookie_mtime;
      if (!this.netStatus.cookie_present || !mtime) return !this.netStatus.cookie_present;
      return (Date.now() / 1000 - mtime) > 6 * 3600;
    },

    async init() {
      this._restoreLocal();
      await Promise.all([
        this.fetchNetStatus(),
        this.fetchCategories(),
        this.runSearch(),
        this.fetchPlaylists(),
        this.fetchFollows(),
        this.fetchHistory(),
      ]);
    },

    setTab(name) {
      this.tab = name;
      if (name === 'foryou' && !this.forYouItems.length) this.fetchForYou();
      if (name === 'history') this.fetchContinueWatching();
    },

    // ---------------------------------------------------------------- API --

    async _get(url) {
      const res = await fetch(url);
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { detail = (await res.json()).detail || detail; } catch {}
        throw new Error(detail);
      }
      return res.json();
    },
    async _send(url, method, body) {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { detail = (await res.json()).detail || detail; } catch {}
        throw new Error(detail);
      }
      return res.json();
    },

    async fetchNetStatus() {
      try { this.netStatus = await this._get('/api/v1/hub/faphouse/netstatus'); }
      catch { this.netStatus = { cookie_present: false }; }
    },

    async fetchCategories() {
      try {
        const data = await this._get('/api/v1/hub/faphouse/categories');
        this.categories = data.categories || data.items || [];
      } catch { this.categories = []; }
    },

    async runSearch() {
      const run = ++this._searchRun;
      this.page = 1;
      this.loading = true;
      this.autoLoading = false;
      this.endOfResults = false;
      try {
        const data = await this._fetchPage(1);
        if (run !== this._searchRun) return;
        this.items = data.items || [];
        this.hasMore = !!data.has_more;
        this._enrichVisible(this.items);
      } catch (e) {
        if (run !== this._searchRun) return;
        console.error('[faphouse] search failed', e);
        this.items = [];
        this.hasMore = false;
      } finally {
        if (run === this._searchRun) this.loading = false;
      }

      const target = Math.min(1000, Math.max(0, Number(this.initialLoadTarget) || 0));
      if (run === this._searchRun && target && this.hasMore && this.visibleItems().length < target) {
        this.autoLoading = true;
        try {
          await this._loadUntilTarget(run, target);
        } finally {
          if (run === this._searchRun) this.autoLoading = false;
        }
      }
    },

    async loadMore() {
      if (this.loading || this.autoLoading || !this.hasMore) return;
      this.loading = true;
      try { await this._loadNextPage(); }
      finally { this.loading = false; }
    },

    async _loadNextPage(run = null) {
      try {
        const data = await this._fetchPage(this.page + 1);
        // A fresh search may have started while this request was in flight.
        // Ignore its stale response so it cannot append cards from the old
        // search into the new result set.
        if (run !== null && run !== this._searchRun) return null;
        const fresh = data.items || [];
        // Faphouse's own listing has no real pager on several routes (a
        // pornstar page renders every video on "page 1" regardless of
        // count) — the server's has_more is a `>= 20 cards` guess that
        // comes back true even when the next page flat-out 404s. An empty
        // page is the one signal that's always trustworthy regardless of
        // what has_more claimed, so it — not just the server's flag — ends
        // the list.
        if (!fresh.length) {
          this.hasMore = false;
          this.endOfResults = true;
          return;
        }
        // Listings can overlap at a page boundary.  Appending those copies
        // gives Alpine duplicate x-for keys (`item.url`), which means its DOM
        // reconciliation can leave the grid looking capped while the raw
        // counter keeps increasing.  Retain only cards that have not already
        // been rendered, so the counter and grid always describe the same
        // unique set of videos.
        const knownUrls = new Set(this.items.map((item) => item.url).filter(Boolean));
        const newItems = fresh.filter((item) => {
          if (!item.url || knownUrls.has(item.url)) return false;
          knownUrls.add(item.url);
          return true;
        });
        this.items = this.items.concat(newItems);
        this.page += 1;
        this.hasMore = !!data.has_more;
        this._enrichVisible(newItems);
        return newItems.length;
      } catch (e) {
        // A failed next-page request (404, etc.) means the same thing as an
        // empty one here — see the comment above — so it's treated as "end
        // of list" too instead of leaving a dead "Načítať ďalšie" button the
        // user can click forever with nothing happening.
        console.warn('[faphouse] loadMore: treating as end of results', e);
        this.hasMore = false;
        this.endOfResults = true;
        return 0;
      }
    },

    async _loadUntilTarget(run, target) {
      // Pages are deliberately sequential: a 1,000-card request can require
      // around sixteen listing fetches, and sending all of them at once would
      // be needlessly aggressive toward Faphouse.
      while (run === this._searchRun && this.hasMore && this.visibleItems().length < target) {
        const added = await this._loadNextPage(run);
        if (run !== this._searchRun) return;
        // A non-empty response with no unseen URLs is a repeated page. Treat
        // it as the end instead of making the user wait in an endless loop.
        if (!added) {
          this.hasMore = false;
          this.endOfResults = true;
        }
      }
    },

    // Fire-and-forget: fills in uploader/performers/upload-date/file-size for
    // a batch of freshly-loaded cards. Not awaited by the caller — the grid
    // renders immediately with listing-only data, then each card quietly
    // gains its size/uploader once the watch-page pass completes, same lazy
    // enrich pattern the main Fusion Hub grid uses.
    async _enrichVisible(items) {
      const urls = items.map((it) => it.url).filter(Boolean).slice(0, 40);
      if (!urls.length) return;
      try {
        const res = await fetch('/api/v1/hub/faphouse/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls }),
        });
        if (!res.ok) return;
        const { results } = await res.json();
        if (!results) return;
        // Patch the exact item objects passed in (same references Alpine is
        // rendering) rather than re-looking them up in this.items — the
        // caller may be enriching a single card (toggleCardDetails) or a
        // list that isn't this.items at all (forYouItems), and a this.items
        // lookup would silently no-op for either.
        const byUrl = new Map(items.map((it) => [it.url, it]));
        for (const [url, patch] of Object.entries(results)) {
          const item = byUrl.get(url);
          if (item) Object.assign(item, patch, { enrichedDetails: true });
        }
      } catch { /* enrich is best-effort — cards keep their listing-only data */ }
    },

    // Faphouse's search endpoint is a single free-text query — tag chips and
    // actor chips fold into it as extra terms (there's no separate tag/actor
    // filter param on the site itself), so "BBC" + "anal" + actor "Sandra
    // Sturm" becomes one combined query string.
    _effectiveQuery() {
      return [this.query.trim(), ...this.tagChips, ...this.actorChips].filter(Boolean).join(' ');
    },

    // A single actor chip with nothing else typed goes through the exact
    // /pornstars/{slug} listing instead of a fuzzy keyword search — "Sandra
    // Sturm" as free text on /videos?q= is a loose text match (any card whose
    // title/tags happen to contain those words), which let completely
    // unrelated videos into the grid. Combined with a keyword or a second
    // actor chip there's no such exact URL on Faphouse itself, so that case
    // still falls back to the free-text query (see _effectiveQuery).
    _isSingleActorLookup() {
      return this.actorChips.length === 1 && !this.query.trim() && !this.tagChips.length;
    },

    // Even the exact /pornstars/{slug} page mixes in a handful of unrelated
    // "recommended" cards that don't actually feature her (verified live
    // against Faphouse's own rendered page, not just our scrape) — so results
    // from that path get a client-side title check as a second filter.
    // Enrich() later fills `performers` from the watch page for a stricter
    // re-check; this pass only has the listing card's title to go on.
    //
    // Matches on the LAST name word alone (not the full phrase): titles get
    // truncated with "…" and a long stage name like "Gatita Veve" often only
    // has "Veve" survive — requiring the full "gatita veve" substring turned
    // those genuine matches into false negatives.
    _matchesActor(item, actorName) {
      const words = actorName.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return true;
      const haystack = (item.title || '').toLowerCase();
      return haystack.includes(words[words.length - 1]);
    },

    async _fetchPage(page) {
      if (this._isSingleActorLookup()) {
        const actorName = this.actorChips[0];
        const found = await this._get(`/api/v1/hub/faphouse/pornstar-find?q=${encodeURIComponent(actorName)}`);
        const slug = found?.slug || '';
        if (slug) {
          const params = new URLSearchParams({ slug, sort: this.sort, page: String(page) });
          const data = await this._get(`/api/v1/hub/faphouse/pornstar?${params.toString()}`);
          const items = (data.items || []).filter((it) => this._matchesActor(it, actorName));
          return { ...data, items };
        }
      }
      const params = new URLSearchParams({ sort: this.sort, page: String(page) });
      const q = this._effectiveQuery();
      // The generic /hub/{source}/search endpoint's query param is named `q`,
      // not `query` — sending `query=` was silently ignored (FastAPI's `q`
      // defaults to "", no error), so every "keyword only" search quietly
      // fell through to the unfiltered feed.
      if (q) params.set('q', q);
      if (this.category) params.set('category', this.category);
      const endpoint = q ? 'search' : 'feed';
      return this._get(`/api/v1/hub/faphouse/${endpoint}?${params.toString()}`);
    },

    _addChip(list, draft) {
      const value = draft.trim().replace(/,+$/, '').trim();
      if (value && !list.includes(value)) list.push(value);
    },
    commitTagChip() {
      this._addChip(this.tagChips, this.tagChipDraft);
      this.tagChipDraft = '';
      this.runSearch();
    },
    removeTagChip(idx) {
      this.tagChips.splice(idx, 1);
      this.runSearch();
    },
    onTagChipKeydown(evt) {
      // Comma commits the chip immediately (the "type BBC, and it becomes a
      // bubble" behaviour) instead of waiting for Enter.
      if (evt.key === ',') { evt.preventDefault(); this.commitTagChip(); }
      else if (evt.key === 'Backspace' && !this.tagChipDraft && this.tagChips.length) {
        this.tagChips.pop();
      }
    },
    commitActorChip() {
      this._addChip(this.actorChips, this.actorChipDraft);
      this.actorChipDraft = '';
      this.runSearch();
    },
    removeActorChip(idx) {
      this.actorChips.splice(idx, 1);
      this.runSearch();
    },
    onActorChipKeydown(evt) {
      if (evt.key === ',') { evt.preventDefault(); this.commitActorChip(); }
      else if (evt.key === 'Backspace' && !this.actorChipDraft && this.actorChips.length) {
        this.actorChips.pop();
      }
    },

    visibleItems() {
      return this.items.filter((item) => {
        if (this.minHeight && (item.height || 0) < this.minHeight) return false;
        if (this.durationBucket) {
          const d = item.duration_sec || 0;
          if (this.durationBucket === 'short' && d > 300) return false;
          if (this.durationBucket === 'medium' && (d <= 300 || d > 1800)) return false;
          if (this.durationBucket === 'long' && d <= 1800) return false;
        }
        return true;
      });
    },

    // Faphouse never exposes a reliable total-match count for the active
    // filter combo in the page HTML it serves (only inactive alternatives
    // like "Fanclub videos 51" carry a printed count) — so this reports only
    // what's actually known: how many cards were fetched, how many pages
    // that took, and whether Min Quality/Duration hid some of them locally.
    // `hasMore` becomes "+ ďalšie k dispozícii", never a fabricated total.
    resultsSummary() {
      const loaded = this.items.length;
      const shown = this.visibleItems().length;
      const filtered = shown < loaded;
      return {
        loaded, shown, filtered, page: this.page, hasMore: this.hasMore,
      };
    },

    get autoLoadProgress() {
      const target = Math.min(1000, Math.max(0, Number(this.initialLoadTarget) || 0));
      return target ? `${this.visibleItems().length} / ${target}` : '';
    },

    formatSize(sizeMb) {
      const mb = Number(sizeMb || 0);
      if (!mb) return '';
      return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
    },

    isCardDetailsOpen(item) {
      return this.openDetailsUrls.has(item.url);
    },
    toggleCardDetails(item) {
      if (this.openDetailsUrls.has(item.url)) this.openDetailsUrls.delete(item.url);
      else this.openDetailsUrls.add(item.url);
      // Set mutations don't trigger Alpine reactivity on their own — reassign
      // so isCardDetailsOpen() re-evaluates and the chevron/panel flip.
      this.openDetailsUrls = new Set(this.openDetailsUrls);
      if (this.isCardDetailsOpen(item) && !item.enrichedDetails) this._enrichVisible([item]);
    },

    // Clicking a creator name jumps straight to their profile — same "open
    // all their videos" shortcut as the Models & Studios tab, just reachable
    // from any card without switching tabs first.
    openUploader(item) {
      if (!item.uploader_url) return;
      const parts = item.uploader_url.split('/').filter(Boolean); // "studios/scout69" -> ["studios","scout69"]
      const kind = parts[0] === 'pornstars' ? 'model' : 'studio';
      const ref = parts[parts.length - 1];
      this.setTab('models');
      this._openProfile({ kind, ref, name: item.uploader, thumbnail: item.thumb });
    },

    // ------------------------------------------------------------ For You --

    async fetchForYou() {
      try {
        const data = await this._get('/api/v1/faphouse/for-you');
        this.forYouItems = data.items || [];
      } catch (e) { console.error('[faphouse] for-you failed', e); }
    },

    // --------------------------------------------------------- Models etc --

    async fetchFollows() {
      try {
        const data = await this._get('/api/v1/faphouse/follows');
        this.follows = data.follows || [];
        this._refreshNewFollowsBadge();
      } catch (e) { console.error('[faphouse] follows failed', e); }
    },

    async _refreshNewFollowsBadge() {
      try {
        const data = await this._get('/api/v1/faphouse/follows/check-new');
        const rows = data.follows || [];
        this._newFollowsByRef = new Map(rows.map((r) => [`${r.kind}:${r.ref}`, r.has_new]));
        this.newFollowsCount = rows.filter((r) => r.has_new).length;
      } catch (e) { /* non-fatal — badge just stays at 0 */ }
    },

    followHasNew(follow) {
      return this._newFollowsByRef?.get(`${follow.kind}:${follow.ref}`) || false;
    },

    isFollowing(profile) {
      if (!profile) return false;
      return this.follows.some((f) => f.kind === profile.kind && f.ref === profile.ref);
    },

    async follow(profile) {
      if (!profile) return;
      try {
        await this._send('/api/v1/faphouse/follows', 'POST', {
          kind: profile.kind, ref: profile.ref,
          display_name: profile.name, thumbnail: profile.thumbnail || '',
        });
        await this.fetchFollows();
      } catch (e) { console.error('[faphouse] follow failed', e); }
    },

    async unfollow(follow) {
      try {
        await this._send(`/api/v1/faphouse/follows/${follow.id}`, 'DELETE');
        await this.fetchFollows();
      } catch (e) { console.error('[faphouse] unfollow failed', e); }
    },

    async unfollowByRef(profile) {
      const row = this.follows.find((f) => f.kind === profile.kind && f.ref === profile.ref);
      if (row) await this.unfollow(row);
    },

    async openModelOrStudio() {
      const raw = this.modelQuery.trim();
      if (!raw) return;
      const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      await this._openProfile({ kind: 'model', ref: slug, name: raw });
    },

    async openFollowVideos(follow) {
      await this._openProfile({ kind: follow.kind, ref: follow.ref, name: follow.display_name, thumbnail: follow.thumbnail });
    },

    async _openProfile(profile) {
      this.currentProfile = profile;
      this.profileItems = [];
      try {
        const params = new URLSearchParams({ page: '1' });
        if (profile.kind === 'model') params.set('pornstar', profile.ref);
        else params.set('studio', profile.ref);
        const data = await this._get(`/api/v1/hub/faphouse/feed?${params.toString()}`);
        this.profileItems = data.items || [];
      } catch (e) { console.error('[faphouse] profile fetch failed', e); }
      const row = this.follows.find((f) => f.kind === profile.kind && f.ref === profile.ref);
      if (row) {
        try { await this._send(`/api/v1/faphouse/follows/${row.id}/seen`, 'POST'); await this.fetchFollows(); }
        catch {}
      }
    },

    // ------------------------------------------------------------ Playlists --

    async fetchPlaylists() {
      try {
        const data = await this._get('/api/v1/faphouse/playlists');
        this.playlists = data.playlists || [];
      } catch (e) { console.error('[faphouse] playlists failed', e); }
    },

    visiblePlaylists() {
      const q = this.playlistQuery.trim().toLowerCase();
      if (!q) return this.playlists;
      return this.playlists.filter((p) => (p.name || '').toLowerCase().includes(q));
    },

    visiblePlaylistItems() {
      const q = this.playlistItemQuery.trim().toLowerCase();
      if (!q) return this.playlistItems;
      return this.playlistItems.filter((i) => (i.title || '').toLowerCase().includes(q));
    },

    visibleCommunityPlItems() {
      const q = this.communityPlItemQuery.trim().toLowerCase();
      let items = this.communityPlItems;
      if (!this.communityPlShowLocked) items = items.filter((i) => !i.locked);
      if (q) items = items.filter((i) => (i.title || '').toLowerCase().includes(q));
      if (this.communityPlQualityFilter.size) {
        items = items.filter((i) => !i.quality || this.communityPlQualityFilter.has(i.quality));
      }
      if (this.communityPlSort !== 'none') {
        const [field, dir] = this.communityPlSort.split('_'); // 'size_desc' -> ['size','desc']
        const key = field === 'size' ? 'size_mb' : 'duration_sec';
        const mult = dir === 'desc' ? -1 : 1;
        // A stable copy, not an in-place sort of communityPlItems — sorting
        // the source array would also reorder it for every OTHER consumer
        // (Fetch all/selected, Import all, the locked-count filter above),
        // none of which should care about display order.
        items = [...items].sort((a, b) => mult * ((a[key] || 0) - (b[key] || 0)));
      }
      return items;
    },

    get communityPlLockedCount() {
      return this.communityPlItems.filter((i) => i.locked).length;
    },

    //: Quality labels actually present among loaded items, most-common
    //: first — drives the filter checklist so it only ever offers choices
    //: that exist in this playlist instead of a fixed hardcoded list.
    get communityPlAvailableQualities() {
      const counts = new Map();
      for (const it of this.communityPlItems) {
        if (!it.quality) continue;
        counts.set(it.quality, (counts.get(it.quality) || 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([quality, count]) => ({ quality, count }));
    },

    toggleCommunityPlQuality(quality) {
      const next = new Set(this.communityPlQualityFilter);
      if (next.has(quality)) next.delete(quality); else next.add(quality);
      this.communityPlQualityFilter = next;
    },

    clearCommunityPlQualityFilter() {
      this.communityPlQualityFilter = new Set();
    },

    // -------------------------------------------- community playlist search --
    // Faphouse's own /playlists directory has no keyword search (a `?q=`
    // there silently redirects to /search/videos), so this searches a local
    // index built by crawling that directory once — see
    // app/routers/faphouse.py's community-playlists endpoints.

    async searchCommunityPlaylists() {
      this.communitySearching = true;
      try {
        const params = new URLSearchParams();
        if (this.communityFavoritesOnly) params.set('favorites_only', 'true');
        else params.set('q', this.communityQuery.trim());
        const data = await this._get(`/api/v1/faphouse/community-playlists/search?${params.toString()}`);
        this.communityResults = data.results || [];
        this.communityTotalIndexed = data.total_indexed || 0;
        // Seed badges from each result's cached probe (see backend's
        // probe_* columns) so a previously-fetched playlist shows its
        // quality/size right away, with no click needed this time.
        const seeded = { ...this.communityProbes };
        for (const p of this.communityResults) {
          if (p.probe) seeded[p.code] = p.probe;
        }
        this.communityProbes = seeded;
      } catch (e) {
        console.error('[faphouse] community playlist search failed', e);
        this.communityResults = [];
      } finally {
        this.communitySearching = false;
      }
    },

    // Fast fetch: sample one playlist's first page for a quality rating
    // (4K/HD/LQ) + estimated size, without opening it. Nothing is fetched
    // until asked — with tens of thousands of indexed playlists, probing
    // every search result automatically would hammer Faphouse for no reason.
    async probeCommunityPlaylist(playlist) {
      const code = playlist.code;
      this.communityProbes = { ...this.communityProbes, [code]: { loading: true } };
      try {
        const data = await this._get(`/api/v1/faphouse/community-playlists/${encodeURIComponent(code)}/probe`);
        this.communityProbes = { ...this.communityProbes, [code]: data };
      } catch (e) {
        this.communityProbes = { ...this.communityProbes, [code]: { error: e.message || 'Fetch zlyhal' } };
      }
    },

    async probeAllVisibleCommunityPlaylists() {
      if (this.communityProbeAllRunning) return;
      this.communityProbeAllRunning = true;
      try {
        // Sequential, not Promise.all: this is a courtesy pace toward
        // Faphouse (same reasoning as the crawl's own inter-page delay),
        // not a correctness requirement — a dozen cards probed back-to-back
        // is a burst, ten in parallel is a small scrape spike.
        for (const p of this.communityResults) {
          if (this.communityProbes[p.code]?.quality_rating) continue; // already fetched
          await this.probeCommunityPlaylist(p);
        }
      } finally {
        this.communityProbeAllRunning = false;
      }
    },

    communityProbeLabel(playlist) {
      const probe = this.communityProbes[playlist.code];
      if (!probe) return '';
      if (probe.loading) return 'Načítavam…';
      if (probe.error) return probe.error;
      const parts = [];
      if (probe.quality_rating) parts.push(probe.quality_rating);
      if (probe.avg_duration_sec) {
        const m = Math.round(probe.avg_duration_sec / 60);
        parts.push(`⌀ ${m} min`);
      }
      if (probe.total_size_mb) {
        const gb = probe.total_size_mb / 1024;
        parts.push(gb >= 1 ? `~${gb.toFixed(1)} GB` : `~${Math.round(probe.total_size_mb)} MB`);
      }
      return parts.join(' · ');
    },

    // Import celý playlist: walks every page of this public playlist
    // server-side and queues the whole thing as one ImportJob (same pipeline
    // importSelected()/importItem() already use), so progress shows in the
    // normal Import Monitor rather than a bespoke per-card tracker.
    async importWholeCommunityPlaylist(playlist) {
      const code = playlist.code;
      if (this.communityImports[code]?.loading) return;
      if (!confirm(`Naimportovať celý playlist "${playlist.name}" (~${playlist.video_count.toLocaleString()} videí)?`)) return;
      this.communityImports = { ...this.communityImports, [code]: { loading: true } };
      try {
        const data = await this._send(`/api/v1/faphouse/community-playlists/${encodeURIComponent(code)}/import`, 'POST');
        this.communityImports = { ...this.communityImports, [code]: data };
      } catch (e) {
        this.communityImports = { ...this.communityImports, [code]: { error: e.message || 'Import zlyhal' } };
      }
    },

    communityImportLabel(playlist) {
      const imp = this.communityImports[playlist.code];
      if (!imp) return '';
      if (imp.loading) return 'Zbieram videá…';
      if (imp.error) return imp.error;
      if (imp.queued) return `Zaradené: ${imp.queued}`;
      return '';
    },

    // ★ Favourite: star/unstar so this playlist shows up under "Len
    // obľúbené" later without re-typing the search that found it.
    async toggleCommunityFavorite(playlist) {
      const previous = !!playlist.is_favorite;
      playlist.is_favorite = !previous; // optimistic — instant star toggle
      try {
        const data = await this._send(`/api/v1/faphouse/community-playlists/${encodeURIComponent(playlist.code)}/favorite`, 'POST');
        playlist.is_favorite = !!data.is_favorite;
        // Unstarring while the favourites-only filter is active should drop
        // the card from view immediately, not just flip its icon.
        if (this.communityFavoritesOnly && !playlist.is_favorite) {
          this.communityResults = this.communityResults.filter((p) => p.code !== playlist.code);
        }
      } catch (e) {
        playlist.is_favorite = previous; // revert on failure
        console.error('[faphouse] favorite toggle failed', e);
      }
    },

    toggleFavoritesOnly() {
      this.communityFavoritesOnly = !this.communityFavoritesOnly;
      this.searchCommunityPlaylists();
    },

    async refreshCrawlStatus() {
      try { this.crawlStatus = await this._get('/api/v1/faphouse/community-playlists/crawl/status'); }
      catch (e) { console.error('[faphouse] crawl status failed', e); }
    },

    async startCommunityCrawl() {
      try {
        await this._send('/api/v1/faphouse/community-playlists/crawl/start', 'POST');
        await this.refreshCrawlStatus();
        // Poll while the crawl is running so the progress line updates live;
        // stopped automatically once the crawl leaves the "running" state so
        // an idle tab doesn't keep polling forever.
        if (this.crawlPolling) clearInterval(this.crawlPolling);
        this.crawlPolling = setInterval(async () => {
          await this.refreshCrawlStatus();
          if (this.crawlStatus.status !== 'running') {
            clearInterval(this.crawlPolling);
            this.crawlPolling = null;
            if (this.communityQuery.trim() || this.communityResults.length) this.searchCommunityPlaylists();
          }
        }, 4000);
      } catch (e) { alert('Nepodarilo sa spustiť indexovanie: ' + e.message); }
    },

    // Opens an external (someone else's) Faphouse playlist right inside this
    // hub's own grid — the playlist page is scraped the same way a listing
    // page is (see FaphouseHub.playlist_videos), so cards behave exactly
    // like Discover's: playable, importable, selectable.
    // How many pages load automatically the moment a community playlist is
    // opened, before the user ever has to click "Načítať ďalšie" — set so a
    // typical open already shows a full screen or two of cards instead of
    // Faphouse's own ~20-card single page.
    _COMMUNITY_PL_AUTOLOAD_PAGES: 3,

    async openCommunityPlaylist(playlist) {
      this.openCommunityPl = playlist;
      this.communityPlItems = [];
      this.communityPlItemQuery = '';
      this.communityPlSort = 'none';
      this.communityPlQualityFilter = new Set();
      this.communityPlPage = 0;
      this.communityPlHasMore = true;
      this.communityPlLoading = true;
      // selectedUrls is shared with the Discover grid (isSelected/toggleSelect
      // are keyed by url only) — clear it on entry so a stale Discover
      // selection can't silently pre-check cards here, or inflate "Fetch
      // selected (N)" with videos the user never picked in this playlist.
      this.clearSelection();
      try {
        for (let i = 0; i < this._COMMUNITY_PL_AUTOLOAD_PAGES && this.communityPlHasMore; i++) {
          await this._loadCommunityPlPage();
        }
      } finally {
        this.communityPlLoading = false;
      }
    },

    // One page fetch, shared by the auto-load loop above and the manual
    // "Načítať ďalšie" button below. Enriches each page's fresh cards as
    // soon as they land rather than waiting for all 3 auto-loaded pages, so
    // the first page's badges appear immediately instead of being delayed
    // behind the later pages' fetches.
    async _loadCommunityPlPage() {
      try {
        const data = await this._get(`/api/v1/hub/faphouse/playlist?pid=${encodeURIComponent(this.openCommunityPl.code)}&page=${this.communityPlPage + 1}`);
        const fresh = data.items || [];
        // Same "empty/failed next page really means the end" rule as the
        // Discover grid's loadMore() — Faphouse listings don't reliably
        // report has_more, only an actually-empty page does.
        if (!fresh.length) {
          this.communityPlHasMore = false;
          return;
        }
        this.communityPlItems = this.communityPlItems.concat(fresh);
        this.communityPlPage += 1;
        this.communityPlHasMore = !!data.has_more;
        this._enrichVisible(fresh);
      } catch (e) {
        console.warn('[faphouse] community playlist page load: treating as end', e);
        this.communityPlHasMore = false;
      }
    },

    async loadMoreCommunityPl() {
      if (this.communityPlLoading || !this.communityPlHasMore || !this.openCommunityPl) return;
      this.communityPlLoading = true;
      try {
        await this._loadCommunityPlPage();
      } finally {
        this.communityPlLoading = false;
      }
    },

    closeCommunityPl() {
      this.openCommunityPl = null;
      this.communityPlItems = [];
      this.communityPlItemQuery = '';
      this.clearSelection();
    },

    // Fetch all / Fetch selected: resolve real quality+size (watch-page
    // enrich, same call openCommunityPlaylist()/loadMoreCommunityPl() already
    // fire automatically for the first 40 loaded cards) for cards that either
    // arrived after that cap or came from a later page. Chunked at 40 per
    // call because that's _enrichVisible's/the backend enrich endpoint's own
    // per-request cap; sequential chunks, not parallel, to stay a courtesy
    // pace toward Faphouse rather than a burst of concurrent watch-page hits.
    async _enrichInChunks(items) {
      const pending = items.filter((it) => !it.enrichedDetails);
      this.communityPlFetchProgress = { done: 0, total: pending.length };
      for (let i = 0; i < pending.length; i += 40) {
        await this._enrichVisible(pending.slice(i, i + 40));
        this.communityPlFetchProgress = { done: Math.min(i + 40, pending.length), total: pending.length };
      }
    },

    get communityPlFetchPercent() {
      const { done, total } = this.communityPlFetchProgress;
      return total ? Math.round((done / total) * 100) : 0;
    },

    async fetchAllCommunityPl() {
      if (this.communityPlFetchAllRunning) return;
      this.communityPlFetchAllRunning = true;
      try {
        await this._enrichInChunks(this.communityPlItems);
      } finally {
        this.communityPlFetchAllRunning = false;
        this.communityPlFetchProgress = { done: 0, total: 0 };
      }
    },

    async fetchSelectedCommunityPl() {
      if (this.communityPlFetchAllRunning || !this.selectedUrls.size) return;
      this.communityPlFetchAllRunning = true;
      try {
        const targets = this.communityPlItems.filter((it) => this.selectedUrls.has(it.url));
        await this._enrichInChunks(targets);
      } finally {
        this.communityPlFetchAllRunning = false;
        this.communityPlFetchProgress = { done: 0, total: 0 };
      }
    },

    async createPlaylistPrompt() {
      const name = prompt('Názov nového playlistu:');
      if (!name || !name.trim()) return;
      try {
        await this._send('/api/v1/faphouse/playlists', 'POST', { name: name.trim() });
        await this.fetchPlaylists();
      } catch (e) { alert('Nepodarilo sa vytvoriť playlist: ' + e.message); }
    },

    async deletePlaylist(playlist) {
      if (!confirm(`Zmazať playlist "${playlist.name}"?`)) return;
      try {
        await this._send(`/api/v1/faphouse/playlists/${playlist.id}`, 'DELETE');
        await this.fetchPlaylists();
      } catch (e) { console.error('[faphouse] delete playlist failed', e); }
    },

    async openPlaylist(playlist) {
      this.activePlaylist = playlist;
      this.playlistItemQuery = '';
      try {
        const data = await this._get(`/api/v1/faphouse/playlists/${playlist.id}/items`);
        this.playlistItems = data.items || [];
      } catch (e) { console.error('[faphouse] playlist items failed', e); }
    },

    async removeFromPlaylist(item) {
      if (!this.activePlaylist) return;
      try {
        await this._send(`/api/v1/faphouse/playlists/${this.activePlaylist.id}/items/${item.id}`, 'DELETE');
        this.playlistItems = this.playlistItems.filter((i) => i.id !== item.id);
      } catch (e) { console.error('[faphouse] remove playlist item failed', e); }
    },

    openAddToPlaylist(item) {
      this.addToPlaylistTarget = item;
    },

    async addToPlaylist(playlist) {
      const item = this.addToPlaylistTarget;
      if (!item) return;
      try {
        await this._send(`/api/v1/faphouse/playlists/${playlist.id}/items`, 'POST', {
          video_url: item.url, title: item.title, thumbnail: item.thumb, duration_sec: item.duration_sec || 0,
        });
        this.addToPlaylistTarget = null;
        await this.fetchPlaylists();
      } catch (e) { alert('Nepodarilo sa pridať do playlistu: ' + e.message); }
    },

    sendPlaylistToMashup() {
      this.setTab('mashup');
      for (const item of this.playlistItems.slice(0, 4)) {
        this._addMashupTrack({ url: item.video_url, title: item.title, thumb: item.thumbnail });
      }
    },

    // -------------------------------------------------------------- History --

    async fetchHistory() {
      try {
        const data = await this._get('/api/v1/faphouse/history');
        this.history = data.history || [];
      } catch (e) { console.error('[faphouse] history failed', e); }
    },

    async fetchContinueWatching() {
      try {
        const data = await this._get('/api/v1/faphouse/history/continue');
        this.continueWatching = data.items || [];
      } catch (e) { console.error('[faphouse] continue-watching failed', e); }
    },

    async removeHistoryRow(row) {
      try {
        await this._send(`/api/v1/faphouse/history/${row.id}`, 'DELETE');
        this.history = this.history.filter((r) => r.id !== row.id);
      } catch (e) { console.error('[faphouse] remove history failed', e); }
    },

    async clearHistory() {
      if (!confirm('Vymazať celú históriu pozerania?')) return;
      try {
        await this._send('/api/v1/faphouse/history', 'DELETE');
        this.history = [];
        this.continueWatching = [];
      } catch (e) { console.error('[faphouse] clear history failed', e); }
    },

    // -------------------------------------------------------------- Player --

    async openPlayer(item) {
      const url = item.url || item.video_url;
      this._destroyPlayerHls();
      this.player = { open: true, item, error: '' };
      await this.$nextTick();
      const video = this.$refs.playerVideo;
      try {
        const data = await this._get(`/api/v1/hub/faphouse/resolve?url=${encodeURIComponent(url)}`);
        if (!data.stream_url) throw new Error('Stream sa nenašiel');
        if (data.is_hls) {
          // Faphouse's full-quality stream is HLS. Chromium does not natively
          // decode it, so use the local rewriting proxy plus hls.js just like
          // the Fusion Hub player does. The proxy preserves Faphouse cookies
          // and Referer for both the manifest and its segments.
          const proxied = `/hls_proxy?url=${encodeURIComponent(data.stream_url)}`;
          if (window.Hls && Hls.isSupported()) {
            const hls = new Hls({ maxBufferLength: 30 });
            this._playerHls = hls;
            hls.loadSource(proxied);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
            hls.on(Hls.Events.ERROR, (_event, details) => {
              if (details.fatal) this.player.error = 'Chyba HLS streamu';
            });
          } else {
            // Safari and other native-HLS browsers still use the authenticated
            // local proxy; only the decoder differs.
            video.src = proxied;
            video.load();
            video.play().catch(() => {});
          }
        } else {
          video.src = `/api/v1/hub/faphouse/stream?url=${encodeURIComponent(data.stream_url)}`;
          video.load();
          video.play().catch(() => {});
        }
        const resumeRow = this.history.find((h) => h.video_url === url);
        if (resumeRow && resumeRow.position_sec > 5) {
          video.addEventListener('loadedmetadata', () => { video.currentTime = resumeRow.position_sec; }, { once: true });
        }
      } catch (e) {
        this.player.error = e.message || 'Video sa nedá prehrať (možno vyžaduje Fanclub prístup).';
      }
    },

    onPlayerLoaded(evt) {
      if (this.player.item) this.player.item.duration_sec = Math.round(evt.target.duration || 0);
    },

    async onPlayerProgress(evt) {
      const item = this.player.item;
      if (!item) return;
      const video = evt.target;
      // Throttle: only push a history update every ~5s of playback, not every timeupdate tick.
      const now = Date.now();
      if (this._lastHistoryPush && now - this._lastHistoryPush < 5000) return;
      this._lastHistoryPush = now;
      try {
        await this._send('/api/v1/faphouse/history', 'POST', {
          video_url: item.url || item.video_url,
          title: item.title, thumbnail: item.thumb || item.thumbnail,
          duration_sec: Math.round(video.duration || item.duration_sec || 0),
          position_sec: video.currentTime || 0,
          tags: (item.tags || []).join(','),
        });
      } catch { /* non-fatal */ }
    },

    closePlayer() {
      this._destroyPlayerHls();
      const video = this.$refs.playerVideo;
      if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
      this.player = { open: false, item: null, error: '' };
      this.fetchHistory();
    },

    _destroyPlayerHls() {
      if (!this._playerHls) return;
      try { this._playerHls.destroy(); } catch { /* best effort teardown */ }
      this._playerHls = null;
    },

    // ---------------------------------------------------------- Watch Later --

    isWatchLater(item) {
      return this.watchLater.some((w) => w.url === item.url);
    },
    toggleWatchLater(item) {
      if (this.isWatchLater(item)) {
        this.watchLater = this.watchLater.filter((w) => w.url !== item.url);
      } else {
        this.watchLater.push({ url: item.url, title: item.title, thumb: item.thumb });
      }
      this._persistLocal();
    },
    _persistLocal() {
      try { localStorage.setItem('fh_watch_later', JSON.stringify(this.watchLater)); } catch {}
    },
    _restoreLocal() {
      try {
        const raw = localStorage.getItem('fh_watch_later');
        if (raw) this.watchLater = JSON.parse(raw) || [];
      } catch {}
      try {
        const d = localStorage.getItem('fh_density');
        if (d === 'compact' || d === 'cozy' || d === 'relaxed') this.density = d;
      } catch {}
    },

    setDensity(value) {
      this.density = value;
      try { localStorage.setItem('fh_density', value); } catch {}
    },

    // ------------------------------------------------------------ Mashup --

    sendToMashup(item) {
      this.setTab('mashup');
      this._addMashupTrack({ url: item.url, title: item.title, thumb: item.thumb });
    },

    async _addMashupTrack({ url, title, thumb }) {
      if (this.mashup.tracks.length >= 4) return;
      const trackId = 'mt_' + Math.random().toString(36).slice(2, 9);
      let previewUrl = url;
      try {
        const data = await this._get(`/api/v1/hub/faphouse/resolve?url=${encodeURIComponent(url)}`);
        if (data.stream_url) previewUrl = data.stream_url;
      } catch { /* keep watch-page URL as a harmless placeholder src */ }
      this.mashup.tracks.push({
        trackId, url, source: 'faphouse', title, thumb, previewUrl,
        mute: false,
        crop_keyframes: [{ t: 0, cx: 0.5, cy: 0.5, cw: 1.0, ch: 1.0 }],
        position_keyframes: [{ t: 0, x: 0, y: 0, w: 1, h: 1 }],
      });
      this.applyMashupLayout();
    },

    // ------------------------------------------------------- Import/Download --

    _fhCandidate(item) {
      const url = item.url || item.video_url;
      return {
        url, source_url: url,
        title: item.title || 'Faphouse video',
        thumbnail: item.thumb || item.thumbnail || '',
        source: 'faphouse',
        duration: item.duration_sec || 0,
        quality: item.quality || '',
        height: item.height || 0,
        upload_date: item.added || '',
        file_size_mb: item.size_mb || undefined,
        tags: ['faphouse'],
        actors: (item.performers || []).slice(0, 8),
      };
    },
    async importItem(item) {
      if (item._importState === 'busy') return;
      item._importState = 'busy';
      try {
        const r = await fetch('/api/v1/intake/import', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            candidates: [this._fhCandidate(item)],
            batch_name: 'Faphouse Hub', source_mode: 'fusion',
            auto_metadata: true, playwright_fallback: false,
          }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.detail || 'Import zlyhal');
        item._importState = 'done';
      } catch (e) {
        console.error('[faphouse] import failed', e);
        item._importState = 'error';
      } finally {
        setTimeout(() => { item._importState = null; }, 1800);
      }
    },
    async downloadItem(item) {
      if (item._copyState === 'busy') return;
      item._copyState = 'busy';
      try {
        const url = item.url || item.video_url;
        const data = await this._get(`/api/v1/hub/faphouse/resolve?url=${encodeURIComponent(url)}`);
        if (!data.stream_url) throw new Error('Stream sa nenašiel');
        await navigator.clipboard.writeText(data.stream_url);
        item._copyState = 'done';
      } catch (e) {
        console.error('[faphouse] resolve/copy failed', e);
        item._copyState = 'error';
      } finally {
        setTimeout(() => { item._copyState = null; }, 1800);
      }
    },

    // ---------------------------------------------------- bulk selection --

    isSelected(item) {
      return this.selectedUrls.has(item.url);
    },
    toggleSelect(item) {
      // Reassign a fresh Set rather than mutate in place — Alpine's
      // reactivity tracks property assignment, not in-place Set mutation, so
      // `.add()`/`.delete()` alone would leave checkboxes visually stale
      // until some unrelated re-render happened to touch this component.
      const next = new Set(this.selectedUrls);
      if (next.has(item.url)) next.delete(item.url); else next.add(item.url);
      this.selectedUrls = next;
    },
    selectAllVisible() {
      this.selectedUrls = new Set(this.visibleItems().map((it) => it.url));
    },
    clearSelection() {
      this.selectedUrls = new Set();
    },
    get selectedCount() {
      return this.selectedUrls.size;
    },
    // Shared bulk-import POST used by importSelected() (Discover) and the
    // community-playlist Import selected/Import all buttons below — one
    // /intake/import call per batch rather than importItem() N times, same
    // as the original importSelected() already did for Discover.
    async _bulkImport(targets, batchName) {
      if (this.bulkImporting || !targets.length) return;
      this.bulkImporting = true;
      try {
        const candidates = targets.map((it) => this._fhCandidate(it));
        const r = await fetch('/api/v1/intake/import', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            candidates, batch_name: batchName, source_mode: 'fusion',
            auto_metadata: true, playwright_fallback: false,
          }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.detail || 'Hromadný import zlyhal');
        targets.forEach((it) => { it._importState = 'done'; });
      } catch (e) {
        console.error('[faphouse] bulk import failed', e);
        targets.forEach((it) => { it._importState = 'error'; });
      } finally {
        this.bulkImporting = false;
        setTimeout(() => { targets.forEach((it) => { it._importState = null; }); }, 1800);
      }
    },

    async importSelected() {
      const targets = this.items.filter((it) => this.selectedUrls.has(it.url));
      await this._bulkImport(targets, 'Faphouse Hub (hromadne)');
      this.clearSelection();
    },

    // Import selected/all WITHIN the currently opened community playlist —
    // imports only what's loaded in communityPlItems client-side (this page
    // + any "Načítať ďalšie" pages already pulled in), unlike the search
    // card's "Import celý playlist" button, which walks the WHOLE remote
    // playlist server-side regardless of what's been opened/loaded here.
    async importSelectedCommunityPl() {
      // Known-locked (Fanclub-only) items are excluded even if somehow
      // selected — resolve 404s for them, so importing would just add a
      // permanently-failed row to the job.
      const targets = this.communityPlItems.filter((it) => this.selectedUrls.has(it.url) && !it.locked);
      const name = this.openCommunityPl?.name || 'komunitný playlist';
      await this._bulkImport(targets, `Faphouse PL: ${name} (výber)`);
      this.clearSelection();
    },

    async importAllCommunityPl() {
      const targets = this.communityPlItems.filter((it) => !it.locked);
      const name = this.openCommunityPl?.name || 'komunitný playlist';
      await this._bulkImport(targets, `Faphouse PL: ${name}`);
    },

    addMashupTrackPrompt() {
      const url = prompt('Vlož URL videa (z Faphouse) pre mashup klip:');
      if (!url || !url.trim()) return;
      this._addMashupTrack({ url: url.trim(), title: 'Klip', thumb: '' });
    },

    removeMashupTrack(idx) {
      this.mashup.tracks.splice(idx, 1);
      if (this.mashup.selectedTrack === idx) this.mashup.selectedTrack = null;
      if (this.mashup.activeAudioTrack >= this.mashup.tracks.length) this.mashup.activeAudioTrack = 0;
      this.applyMashupLayout();
    },

    toggleMashupMute(idx) {
      this.mashup.tracks[idx].mute = !this.mashup.tracks[idx].mute;
    },

    setActiveAudioTrack(idx) {
      this.mashup.activeAudioTrack = idx;
    },

    selectMashupTrack(idx) {
      this.mashup.selectedTrack = idx;
      const track = this.mashup.tracks[idx];
      if (track && track.crop_keyframes.length) {
        const last = track.crop_keyframes[track.crop_keyframes.length - 1];
        this.cropDraft = { cx: last.cx, cy: last.cy, cw: last.cw, ch: last.ch };
        this.kfTimeInput = last.t;
      }
    },

    applyMashupLayout() {
      const n = this.mashup.tracks.length;
      if (!n) return;
      const layout = this.mashup.layout;
      this.mashup.tracks.forEach((track, i) => {
        let x = 0, y = 0, w = 1, h = 1;
        if (layout === 'side-by-side') { w = 1 / n; x = i * w; }
        else if (layout === 'triple-vertical') { w = 1 / n; x = i * w; }
        else if (layout === 'grid-2x2') {
          w = 0.5; h = 0.5; x = (i % 2) * 0.5; y = Math.floor(i / 2) * 0.5;
        } else if (layout === 'pip') {
          if (i === 0) { x = 0; y = 0; w = 1; h = 1; }
          else { w = 0.28; h = 0.28; x = 1 - w - 0.03; y = 1 - h - 0.03 - (i - 1) * 0.32; }
        }
        track.position_keyframes = [{ t: 0, x, y, w, h }];
      });
    },

    mashupTileStyle(track) {
      const kf = track.position_keyframes[0] || { x: 0, y: 0, w: 1, h: 1 };
      return `left:${kf.x * 100}%;top:${kf.y * 100}%;width:${kf.w * 100}%;height:${kf.h * 100}%`;
    },

    currentTrackCropKeyframes() {
      if (this.mashup.selectedTrack === null) return [];
      return this.mashup.tracks[this.mashup.selectedTrack]?.crop_keyframes || [];
    },

    mashupDuration() {
      // Longest keyframe timestamp across the selected track, floor 10s so the
      // timeline never collapses to a point right after adding the first clip.
      const kfs = this.currentTrackCropKeyframes();
      return Math.max(10, ...kfs.map((k) => k.t), this.kfTimeInput);
    },

    cropBoxStyle() {
      const { cx, cy, cw, ch } = this.cropDraft;
      const left = (cx - cw / 2) * 100, top = (cy - ch / 2) * 100;
      return `left:${left}%;top:${top}%;width:${cw * 100}%;height:${ch * 100}%`;
    },

    startCropDrag(evt) {
      const box = evt.currentTarget;
      const container = box.parentElement;
      const rect = container.getBoundingClientRect();
      const onMove = (e) => {
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;
        this.cropDraft.cx = Math.max(0, Math.min(1, x));
        this.cropDraft.cy = Math.max(0, Math.min(1, y));
        this.syncCropDraftToActiveKeyframe();
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },

    syncCropDraftToActiveKeyframe() {
      // Live-editing: update the keyframe at kfTimeInput if it exists, else
      // this is just a draft until "Pridať keyframe" commits it as a new one.
      if (this.mashup.selectedTrack === null) return;
      const track = this.mashup.tracks[this.mashup.selectedTrack];
      const existing = track.crop_keyframes.find((k) => Math.abs(k.t - this.kfTimeInput) < 0.05);
      if (existing) Object.assign(existing, this.cropDraft);
    },

    addCropKeyframe() {
      if (this.mashup.selectedTrack === null) return;
      const track = this.mashup.tracks[this.mashup.selectedTrack];
      const t = Math.max(0, this.kfTimeInput || 0);
      const existing = track.crop_keyframes.find((k) => Math.abs(k.t - t) < 0.05);
      if (existing) { Object.assign(existing, this.cropDraft); }
      else { track.crop_keyframes.push({ t, ...this.cropDraft }); }
      track.crop_keyframes.sort((a, b) => a.t - b.t);
    },

    seekMashupPreview(t) {
      this.kfTimeInput = t;
      const track = this.mashup.tracks[this.mashup.selectedTrack];
      const kf = track?.crop_keyframes.find((k) => Math.abs(k.t - t) < 0.05);
      if (kf) this.cropDraft = { cx: kf.cx, cy: kf.cy, cw: kf.cw, ch: kf.ch };
      const video = this.$refs.cropPreviewVideo;
      if (video) video.currentTime = t;
    },

    async renderMashup() {
      if (this.mashup.tracks.length < 2) return;
      this.mashup.rendering = true;
      try {
        const source_spec = {
          layout: this.mashup.layout,
          tracks: this.mashup.tracks.map((t) => ({
            url: t.url, source: t.source, mute: t.mute,
            in_sec: 0, out_sec: 60,
            crop_keyframes: t.crop_keyframes,
            position_keyframes: t.position_keyframes,
          })),
          audio_track_keyframes: [{ t: 0, track: this.mashup.activeAudioTrack }],
        };
        const data = await this._send('/api/v1/faphouse/mashup/jobs', 'POST', { source_spec });
        this.mashup.jobs.unshift(data.job);
        this._pollMashupJob(data.job.id);
      } catch (e) {
        alert('Render zlyhal: ' + e.message);
      } finally {
        this.mashup.rendering = false;
      }
    },

    _pollMashupJob(jobId) {
      const tick = async () => {
        try {
          const data = await this._get(`/api/v1/faphouse/mashup/jobs/${jobId}`);
          const idx = this.mashup.jobs.findIndex((j) => j.id === jobId);
          if (idx >= 0) this.mashup.jobs[idx] = data.job;
          if (data.job.status === 'queued' || data.job.status === 'rendering') {
            setTimeout(tick, 2500);
          }
        } catch { /* stop polling on error */ }
      };
      tick();
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('faphouse', faphouseApp);
});
