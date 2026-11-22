# Fetch validation — 2026-09-26

Backend: 71 tests passed. Coverage includes scheduler admission and cancellation,
durable claims, lease recovery, generation fencing, idempotency, deferred retries,
event replay, authentication and existing album/intake contracts. One upstream
Starlette/AnyIO deprecation warning remains.

JavaScript client tests passed: uncertain submission preserves its key, replay
deduplicates events, reconnect resumes the cursor, and detaching does not cancel
server work. JavaScript syntax checks and targeted Git whitespace checks passed.

The real dashboard click path was exercised against an isolated local server,
with synthetic provider responses and its own fetch-job database:

- Single album: 20 files, one listing request, zero detail/API/probe requests.
- Combined album: 12 albums and 240 files, 12 additional listing requests,
  zero additional detail/API/probe requests before explicit enrichment.
- Explicit enrichment displayed duration and resolution on cards.
- The Full fetch button started a 240-file job. Stop fetch ended monitoring and
  server work while preserving all 240 listed files and nine completed results.
  Screenshots captured the listing, enriched cards and stopped state.

A separate parser test loaded 12 albums with 120 files each: 1,440 files using
exactly 12 listing requests and no file-page requests.

These controlled checks prove request reduction and recovery behavior. They do
not measure live Bunkr latency, anti-bot behavior or end-to-end speed improvement.
The traffic coordinator is process-local: use one application process until a
shared coordinator is introduced.
