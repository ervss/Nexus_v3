# Telegram metadata catalogue

Quantum Search contains a Telegram catalogue panel. Start/Pause/Continue persist
across server restarts. Nexus must be running for background work to continue.
The worker downloads message metadata only; previews and media use the existing
on-demand endpoints.

## Synchronization

- Discover joined channels/groups without issuing a counter request per chat.
- First visit up to 200 newest video messages in each channel, in 100-message
  pages. Selected priority channels are visited first.
- Backfill older history fairly across channels. Reserve every fifth scheduling
  turn for due recent refreshes so refreshes cannot starve backfill.
- Commit each page and its cursor together. The unique chat/message index makes
  replay idempotent. A short page does not mark history complete; an empty page
  does.
- Revisit the newest 200 indexed video messages when due (15 minutes, subject to
  queue length and Telegram limits). This catches new messages, edits, and
  deletions within that scanned window. Older edits/deletions are not continually
  reconciled.
- Rediscover memberships hourly. Per-channel errors retry after five minutes;
  account-wide errors retry after a minute. Persist Telegram FloodWait deadlines.
- One process owns the catalogue worker via an OS file lock. Count/page requests
  share the existing search semaphore; global live search also uses it. Media
  playback keeps its existing independent download path.

The full available caption and original filename are searchable through SQLite
FTS5. Normal video-gallery filtering is used; videos sent as generic documents
outside that gallery are not covered by this pass. No OCR/visual recognition or
AI-generated tags are run.

## Search and coverage

`Hľadať v katalógu` returns local results immediately, respecting selected channel
IDs and duration/quality/size filters. An empty query browses newest records.
`Dohľadať na Telegrame` explicitly performs live search even if local hits exist,
and adds successful results to the index. Global Search mode uses local search
by default. Existing channel scrape controls remain live.

`Nové videá mimo knižnice` browses the newest indexed videos from all currently
joined channels and groups, without a keyword. Current filters apply locally to
loaded results and can be changed without a new search. It
excludes library entries by Telegram chat/message identity, including recognized
legacy Telegram links. Importing refreshes the list. This is an index browse,
not an instantaneous live scan: paused, incomplete or delayed synchronization
can mean that some Telegram videos have not appeared yet. Reposts under a
different Telegram message identity cannot reliably be recognized as duplicates.

`Nové naživo` is a separate, cancellable metadata-only pass directly against the
joined Telegram dialogs. It visits each channel/group once, checks up to its 20
newest video messages and emits at most five library-excluded messages per chat.
It does not insert these messages into the index. It stops at 2,000 results, on
Telegram FloodWait, or when cancelled; progress and per-chat failures are shown.
Requests share the existing account-wide Telegram semaphore and cooldown, so they
are intentionally serialized to avoid competing with background indexing. This
quick pass is not an exhaustive scan of older videos.
All current quality, duration, size, orientation and exclusion filters apply to
the streamed results immediately; unfiltered matches remain in memory so changing
filters does not require a new Telegram pass. Bulk actions operate on visible
results, and the interface indicates any selections hidden by filters.

The panel shows actual unique indexed rows, completed channels, and how many
channel totals are known. Telegram totals are approximate snapshots, collected
with initial pages and recent refreshes. Completion means a backfill reached the
end at its last visit, not a guarantee against future changes.

Throughput is a smoothed observed rate of new backfill records, including elapsed
time between backfill commits. ETA is shown only after every active channel has
a known total. Both are estimates and change with FloodWait/refresh work.

## API

- `GET /api/v1/telegram/catalog`: persisted state, counts and channel coverage.
- `POST /api/v1/telegram/catalog`: `{enabled: true|false,
  priority_chat_ids?: ["-100..."]}`.
- `GET /api/v1/telegram/catalog/search?query=...&chat_ids=-100...,...`:
  local search with coverage. Existing `limit`, `min_duration`, `min_quality`,
  `min_size_mb` parameters apply.
- Existing `search_global` accepts selected IDs and `force_live=true`.

All catalogue routes require the existing authenticated Nexus session.
Takeout export mode is not enabled; this worker uses the existing account client
and respects its normal Telegram limits.

## Verification

`python -m pytest tests/test_telegram_catalog.py tests/test_telegram_joined_chats.py tests/test_telegram_keywords.py -q`

Catalogue tests use a temporary database, never the live index.
