# Faphouse Hub — Design Spec

Status: approved by user, ready for implementation planning.
Date: 2026-09-04

## 1. Goal

Build a standalone, visually distinctive ("Luxury Velvet") Faphouse browsing
experience — not a tab inside the existing Fusion Hub dashboard — with
DB-backed playlists/watch-history/follows, a "For You" recommendation feed,
and a from-scratch multi-track split-screen video mashup editor. Additionally,
register two new, live-verified Fusion Hub sources (Thothub, CamWhoresBay)
based on analysis of the user's last 500 imports.

## 2. Why solo, not a Fusion Hub tab

User explicitly chose "solo" over "hybrid" ("chcem to mat co najlepsie a
radsej solo") — full design freedom on a dedicated page/URL, not constrained
by the shared Fusion Hub grid's generic layout. This trades away automatic
inclusion in cross-source features (`/hub/all` fan-out, shared watch-later)
for an unconstrained, purpose-built UX.

## 3. Backend architecture (Option A — reuse HubAdapter)

Decision: reuse the existing `HubAdapter` contract (`app/hubs/base.py`) even
though the frontend is a separate page. Rationale (user-approved after
explicit trade-off comparison): avoids re-implementing referer-bypass media
proxying, HLS/stream resolution, enrich pipeline, and library-import wiring —
all already correct and battle-tested. Faphouse-specific fields (Fanclub
badge, Ultra badge, access type) go in `Tile.extra`/`Page.extra`, not new
dataclass fields.

### 3.1 `app/hubs/faphouse.py` — `FaphouseHub(HubAdapter)`

- `source="faphouse"`, `label="Faphouse"`
- `needs_enrich=True` (listing gives quality badge + duration, not real
  height/size)
- `media_hosts` includes `flixcdn.com` and `thumb-ah.flixcdn.com`
- `stream_referer="https://faphouse.com/"`
- `supported_sorts`: whatever the site's `/videos` sidebar genuinely honors
  (Trending, Newest — confirmed via live fetch; verify Quality/Duration/
  Access-type filters as `**filters` params, not sorts)
- `listing_fields`: at minimum `duration`, `height` (quality badge visible
  per card), `date` unclear — verify against live DOM during implementation
- Cookie-authenticated HTTP client: reuse the `MozillaCookieJar` +
  `_resolve_cookiefile()` pattern from `app/extractors/faphouse.py`, but
  **factor it into a small shared helper** both files import (avoid
  duplicating the candidate-file list `faphouse.netscape.txt` /
  `faphouse.cookies.txt` / etc. and the Netscape parser). The user's supplied
  `faphouse_cookies.txt` should be added to the candidate list.
- `search()`/`browse()`: scrape `/videos`, `/c/{category}/videos`,
  `/pornstars/{name}`, `/studios/{name}` listing HTML using the card
  selectors already proven working in
  `extensions/Nexus_Gallery/faphouse_grid_importer.js` (`scanCards()`,
  `collectCard()`) — reuse the same selector list:
  `[data-el="Thumb"][data-id]`, `[data-id][data-el-video]`, `.t-m`,
  `[data-el="VideoCard"]`, `.video-item`, with `a.t-vl[href*="/videos/"]` as
  the watch-link anchor.
- `categories()` → `/categories` index (confirmed to exist live)
- `pornstar_videos()`/`find_pornstar()` → `/pornstars/{name}` (confirmed
  live URL pattern)
- Studio videos → `/studios/{name}` (confirmed live URL pattern), exposed via
  the router's duck-typed "member" surface (`member_profile`/
  `member_videos`)
- `resolve()` delegates directly to `FaphouseExtractor.extract()`
  (`app/extractors/faphouse.py`) — already correctly distinguishes locked/
  trailer vs real stream via `videoViewAllowed` and the `view-state-data`
  blob. Do not reimplement this logic.
- `net_status()`: new pattern (no existing hub checks cookie freshness, only
  Tor/proxy) — report whether the configured cookie file exists, its mtime,
  and (best-effort) whether the account appears signed in from the last
  successful listing fetch. Purpose: let the UI show "session expiring/
  expired" instead of silently degrading to locked/trailer tiles.

Confirmed live site structure (fetched 2026-09-04, logged-out view):

```
Nav: Videos, VR Porn, Ultra, Store, Categories, Pornstars, Channels,
     Creators, Feed, Live Sex, Sex Chat
Filters (sidebar on /videos): Access type (FapHouse/Fanclub/Paid/Discounts),
     Production (Professional/Homemade), Sort (Trending/Newest),
     Quality (SD/HD/FHD/4K), Duration (Short/Medium/Long)
Sections: All videos, Crown leaders, Best videos, Top Creator picks,
     FapHouse Originals, Awards '25, Playlists, Short Videos, Porn radar,
     Recommended, Watch history, My Fanclubs
URL patterns:
  /videos                      - main listing
  /c/{category}/videos         - category listing
  /pornstars/{name}            - performer profile
  /studios/{name}               - studio/channel profile
  /models/{username}           - creator profile
  /categories                  - category directory
Pagination: numbered, up to ~14900 pages on unfiltered /videos
```

### 3.2 New DB tables (SQLAlchemy models in `app/database.py`)

These replace/extend what would otherwise be localStorage-only state, since
the user wants durable playlists/history/follows independent of browser
storage:

- **`faphouse_playlists`**: `id, name, description, created_at, updated_at`
- **`faphouse_playlist_items`**: `id, playlist_id (FK), video_url, title,
  thumbnail, duration_sec, added_at, position` — ordered, drag-reorderable
- **`faphouse_watch_history`**: `id, video_url, title, thumbnail,
  duration_sec, position_sec, last_watched_at, watch_count` — powers both
  Continue Watching and the "For You" affinity signal
- **`faphouse_follows`**: `id, kind ("model"|"studio"), ref (slug/url),
  display_name, thumbnail, followed_at, last_seen_new_at` — polled
  similarly to the existing `/hub/follows` mechanism but scoped to this page
  (own endpoints, not reusing `data/hub_follows.json`, to keep this feature
  self-contained per user's "solo" preference)
- **`faphouse_mashup_jobs`**: `id, status (queued|rendering|done|failed),
  progress_pct, source_spec (JSON — tracks/keyframes/layout), output_path,
  error, created_at, completed_at`

### 3.3 Router

New router `app/routers/faphouse.py`, mounted alongside the existing
`app/routers/hub.py` (not merged into it, to keep Faphouse-only endpoints
separate from the generic multi-source hub router), exposing:
- Standard hub surfaces via the existing generic `/hub/faphouse/*` endpoints
  (search/feed/categories/enrich/resolve/related/stream/media) — free, no
  new code needed beyond the adapter itself.
- New Faphouse-only endpoints: `/api/v1/faphouse/playlists` (CRUD),
  `/api/v1/faphouse/history` (get/update position/clear),
  `/api/v1/faphouse/follows` (CRUD + `/check-new`),
  `/api/v1/faphouse/for-you` (recommendation feed, see §5.3),
  `/api/v1/faphouse/mashup/*` (job create/status/cancel, see §6).

## 4. Frontend — standalone page

- **Route**: `GET /faphouse` in `app/routers/pages.py` → new template
  `app/templates/faphouse.html` (not injected into `index.html`)
- **JS module**: `app/static/modules/faphouse_hub.js` — own Alpine.js
  component with its own state (not reusing `ephub`), calling the generic
  `/hub/faphouse/*` REST endpoints plus the new Faphouse-only endpoints
  above.
- **CSS**: `app/static/faphouse.css` — "Luxury Velvet" skin:
  - Base: deep bordeaux/near-black (`#1a0a10`–`#2b0f1a` range)
  - Accent: gold/champagne (`#d4af37`/`#c9a24b` range), gold-foil hover glow
    on cards
  - Typography: serif display face for headings (e.g. Playfair Display via
    Google Fonts), clean sans-serif body
  - "Members club" mood — distinct from the existing Aurora/Vision Glass
    skin (`docs` reference: `[[aurora-skin-variant]]` memory) and from
    Classic Glass (`[[classic-glass-skin]]` memory)

### 4.1 Page sections (tab-switched, single-page feel)

1. **Discover** — main grid; filter sidebar mirrors real site filters
   (access type, production, quality, duration) plus local tag/genre chips;
   sort (trending/newest/top-rated, per `supported_sorts`)
2. **For You** — recommendation feed (§5.3)
3. **Models & Studios** — browse/search performers & studios, follow button,
   "new since last seen" badge count
4. **Playlists** — DB-backed, create/rename/reorder/drag-drop add
5. **Mashup Studio** — multi-track split-screen compositor (§6)
6. **History** — continue watching (resumable) + full watch history

### 4.2 Card design

Poster + gold-corner quality badge (4K/Ultra/Fanclub); hover reveals preview
scrub + duration + creator avatar; locked (Fanclub-gated) content shown with
a subtle lock icon + slight desaturation rather than hidden, so browsing
stays honest about what the current cookie can actually stream.

## 5. Engagement features (MVP scope, user-selected)

User explicitly deferred swipe-discovery mode out of MVP. In scope:

### 5.1 Playlists + Watch Later + Continue Watching
DB-backed per §3.2, not localStorage. Resume position stored per video.

### 5.2 Model/Studio follows + notifications
Follow button on model/studio pages; polling job (reuse the cadence pattern
from the existing `/hub/follows` "seen_urls" diffing, but against
`faphouse_follows.last_seen_new_at`) surfaces a badge count of new uploads
since last visit.

### 5.3 "For You" recommendation feed
Seeded from (in priority order): (a) `faphouse_follows` — always show latest
from followed models/studios first, (b) `faphouse_watch_history` tag/category
affinity — weight categories/tags seen in recently-watched videos, (c)
broader NexusPWC library tag affinity (optional enhancement, not MVP-blocking)
via the existing semantic-search/tag infrastructure
(`app/semantic_search.py`) if time permits. MVP can ship with (a)+(b) alone.

## 6. Mashup Studio

A dedicated sub-view for compositing 2–4 source videos into a single
split-screen output, with full per-tile creative control (not fixed layout
presets) — user's explicit request: "chcem totalnu slobodu... zoomy cropy pan
scany... POV pohlady pri blowjoboch".

### 6.1 Workflow
1. Select 2–4 source videos (from grid/playlist/history via a "send to
   Mashup" card action)
2. Choose a starting layout template (side-by-side / triple-vertical strip /
   2×2 grid / picture-in-picture) — sets initial tile position/size only,
   not a constraint on further editing
3. Per-tile track controls on a shared timeline:
   - Crop/zoom window over a scrubbing preview thumbnail strip
   - Keyframes: click timeline to drop a keyframe, adjust crop window there;
     playback **linearly interpolates** crop position/zoom between
     keyframes (MVP scope — no eased/curved interpolation; user confirmed
     linear is sufficient for MVP, easing deferred as a future enhancement)
   - Tile position/size on canvas is itself keyframeable (grow/move over
     time, not just internal crop)
   - Trim in/out point per source clip
   - Mute toggle per track + a keyframeable "active audio" selector (only
     one track's audio plays at a given timeline position, short crossfade
     at switch points)
4. Live canvas preview: HTML5 canvas compositing the 2–4 `<video>` elements
   client-side for responsive scrubbing (preview-quality/lower-res — full
   quality only in the final render pass)
5. Render: background job → ffmpeg pipeline. Per track: `crop`+`scale`
   filter driven by exported keyframe curves (segment-based `sendcmd` or
   expression-based filters for per-keyframe values), composited via
   `overlay`/`xstack`, audio via track-select + `volume` envelope for
   crossfade. Output lands in the user's library like any import.
6. Job status in `faphouse_mashup_jobs` (queued/rendering/done/failed +
   progress %), polled from the UI so the user can keep browsing during
   render.

### 6.2 MVP scope guard
- Linear keyframe interpolation only (confirmed by user)
- Preview-quality canvas compositing while editing; full quality only in the
  ffmpeg render pass
- This is a new primitive (own editor, own timeline, own job queue) — not
  routed through the existing Nexus Studio clip editor, since Studio is
  built for linear sequential cuts, not split-screen compositing. May be
  reused by other hubs later.

## 7. New Fusion Hub sources (data-backed, live-verified)

### 7.1 Import data analysis (last 500 `import_job_items`, by `created_at`)

Source breakdown (top 10 of 21): bunkr 283, eporner 43, 69tubed 28,
filester 26, pimpbunny 24, camwhores 22, porntrex 16, xhamster 14,
whoreshub 9, pornhub 8.

Top tags (excluding source-name noise like "bunkr"/"fusion-hub"): milf 55,
4k ultra hd 49, big tits 48, blowjob 41, hardcore/pov/threesome/anal/
interracial/amateur/big dick 36 each, latina/asian/ebony/lesbian/homemade 34
each, vr porn/mature/group sex/orgy/gay/swinger/footjob/indian/hentai/teen/
japanese/redhead 33 each.

Top categories: onlyfans 22 (by far #1), big tits 9, blowjob 8, blonde 7,
hardcode 6.

Conclusion: dominant behavior is leaked/self-published creator content
(OnlyFans-style, amateur, homemade) via Bunkr + solid KVS-family hub usage
(Eporner/Camwhores/PornTrex/PimpBunny/WhoresHub), with almost no classic-tube
volume (PornHub 8, XVideos 5, RedTube 1 out of 500). New sources should
extend the creator-leak/amateur axis, not add another generic tube.

### 7.2 Candidates investigated and rejected

- **Kemono.su / Coomer.su**: domains dead (DNS does not resolve — moved to
  `kemono.cr` / `coomer.st`). On the new domains, the front-end (search,
  post listing, image attachments) works, but the CDN storage nodes
  (`n1-n3.kemono.cr`, `n1-n3.coomer.st`) return
  `net::ERR_CONNECTION_TIMED_OUT` on direct fetch — confirmed live via
  Playwright against a real user-supplied post/file URL
  (`coomer.st/onlyfans/user/princessjas4ux/post/1064656955` →
  `n2.coomer.st/data/...mp4` times out). This matches the user's reported
  symptom exactly (video won't play or download) and is a server-side
  outage, not fixable client-side. **Rejected for now** — worth revisiting
  if the CDN nodes come back up; not included in this spec's scope.
- **SimpCity forum**: already documented in project memory
  (`[[simpcity-httponly-cookies]]`) as blocked — session cookies are
  HttpOnly and invisible to JS-based cookie exporters. Not re-investigated
  here since the blocker is already understood and unrelated to this task.
- **Cyberdrop** (Bunkr sibling file-host): `cyberdrop.me` does not resolve;
  `cyberdrop.to` resolves but redirects to a domain-parking/ad page
  (`ww38.cyberdrop.to`) — the domain has been squatted, not the real
  service. Rejected.
- **saint2.su**: HTTP 521 (web server down). Rejected.
- **jpg5.su**: DNS does not resolve. Rejected.
- **VRPorn.com**: homepage loads but no video links found in the initial DOM
  scan; `/category/videos/` returns 404. Needs deeper structural
  investigation before it could be proposed — not pursued further given
  two solid alternatives were already found (see below). Not included in
  this spec; may be revisited separately.
- **Pixhost, Gofile**: both live, but out of scope — Pixhost is image-only
  hosting (not video-relevant) and Gofile is already integrated
  (`app/extractors/gofile.py`).

### 7.3 Candidates confirmed and approved

**Thothub** (`thothub.to`)
- Live-verified 2026-09-04: homepage loads, listing at `/` shows real video
  cards (`/videos/{id}/{slug}/` URL pattern), nav includes Latest/Popular/
  Albums/Categories/Models/Playlists.
- Watch-page test (`https://thothub.to/videos/1572390/bunny-una-with-gattouz0/`):
  confirmed classic KVS engine — `get_file` script markers present, `<video>`
  `currentSrc` resolved to
  `https://thothub.to/get_file/47/.../1572390/1572390.mp4/?rnd=...`,
  playback confirmed working (`readyState: 4`, `duration: 7400s`,
  `854x480`).
- Content: "Free Leaked Gamer Girl Images & Videos - Twitch, Youtube,
  Patreon, Porn Tube" — directly matches the dominant amateur/OnlyFans/
  homemade/leak tag profile from §7.1.
- Integration: subclass `KvsHub` (`app/hubs/kvs.py`) following the existing
  WhoresHub/PornTrex/CamWhores pattern — same engine, same `get_file` token
  shape, minimal new code expected. Has Models/Categories/Playlists/Albums
  nav, so `pornstar_videos()`/`playlists()`/`categories()` should map onto
  existing `KvsHub` machinery with light per-site config (selectors, path
  templates), not a rewrite.

**CamWhoresBay** (`camwhoresbay.com`)
- Live-verified 2026-09-04: `/latest-updates/` shows 70 active video cards,
  most recent posted same-day (`.../denisseperry-2026-09-04/`),
  `/videos/{id}/{slug}/` URL pattern.
- Watch-page test
  (`https://www.camwhoresbay.com/videos/1203418/fisting-my-creamy-pussy-outside/`):
  KVS engine confirmed (`getEmbed`/`get_file`/`kt_player` script markers
  present, matching the exact pattern seen on Thothub and the existing
  PimpBunny/CamWhores adapters). Player requires a click-to-play interaction
  before the `<video>` element is instantiated (normal KVS behavior, not a
  defect) — not fully played through in this investigation, but the engine
  match plus live traffic (70 fresh uploads) is strong evidence of a working
  site.
- Content: webcam/amateur leak niche — direct sibling to PimpBunny (the
  user's explicit ask: "chcem alternativu k pimpbunny"), the user's #5
  source by import volume (24 imports).
- Integration: subclass `KvsHub`, same low-risk pattern as PimpBunny/
  CamWhores/WhoresHub.

Both register in `app/hubs/registry.py::init_hubs()` — one import + one line
each, wrapped in the existing try/except-per-adapter pattern so a future
breakage in either can't take down the other hubs.

## 8. Out of scope / deferred

- Swipe-discovery (Tinder-style) mode — explicitly deferred by user, may be
  added later.
- Eased/curved keyframe interpolation in Mashup Studio — linear only for
  MVP.
- VRPorn.com as a third new source — needs further live structural
  investigation before it can be proposed.
- Broader NexusPWC-library tag affinity in the "For You" feed — nice-to-have,
  not MVP-blocking.
- Adding `"faphouse"` (and thothub/camwhoresbay) to
  `DISCOVERY_SEARCH_SOURCE_KEYS` in `app/source_catalog.py` — not strictly
  required (URL-host fallback already buckets imports correctly per
  `[[hub-categories-live-facts]]` memory precedent), but a cheap cleanliness
  win worth doing during implementation.
