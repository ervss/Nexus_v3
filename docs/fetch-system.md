# Album and file fetching

Discovery, tester album previews, source boards and album URL intake use listing
HTML first. File detail, stream resolution and CDN metadata are separate work.
Opening an album does not automatically resolve every stream.

`app/ntc/bunkr_scheduler.py` owns the Bunkr-family request budget, including the
read-only POST `/api/vs`. The initial family cap is six in-flight requests at
2.8 starts/sec, burst three. Host concurrency starts at two and adapts between
one and three. HTML and API calls share these limits across albums. Interactive
requests precede background enrichment; aging prevents starvation. Admission
wait and transport timeout are separate. Durable jobs own retries; 429/503
cooldowns are persisted as deferred work without consuming the attempt budget.

`app/fetch_jobs.py` stores jobs, leased tasks, idempotency keys and an event outbox
in the existing database. Album listings expand into independent file tasks;
shared URLs within a batch retain every source album. Claims use conditional
updates and generation fencing. Worker shutdown releases its claims; crashed
workers recover after lease expiry. Cancellation retains completed results and
rejects late commits. Result/event pagination uses stable increasing IDs. Stream
URLs are excluded from durable results. Terminal jobs expire after seven days;
limits are 100 active batches and 100,000 file rows per batch.

Authenticated API:

- `POST /api/v1/fetch-jobs`: `urls`, `mode` (`index`, `enrich`, `files`), `limit`,
  optional `request_key`. Returns a committed `job_id` without awaiting fetches.
- `GET /api/v1/fetch-jobs/{id}?after=0`: counts and at most 200 replay events.
- `GET /api/v1/fetch-jobs/{id}/items?after=0`: paginated saved results.
- `POST /api/v1/fetch-jobs/{id}/cancel`: explicit cancellation.
- `GET /api/v1/fetch-jobs/traffic`: current admission metrics.

The dashboard client uses short polling calls with a ten-second client deadline,
cursor replay and reconnect backoff. Session storage keeps uncertain submission
keys and active job IDs. Reopening the same album resumes the active job. Closing
the viewer only detaches; the Stop fetch button cancels server work. The existing
WebSocket receives compact outbox notifications, but progress correctness does
not depend on its connection. Existing NDJSON endpoints remain compatible.

This deployment uses one application process / fetch-owning event loop. Database
claims are safe for concurrent owners, but the traffic budget is process-local.
Do not increase Uvicorn workers without a shared admission coordinator. The
current CDN probe cap is separate from the Bunkr control budget. MP4 metadata is
supported; MKV/WebM/AVI/HLS technical metadata remains explicitly unsupported.

Validation covers family/host caps, cancellation cleanup, shared request ownership,
durable retry/cooldown, concurrent claims, fencing, recovery, outbox replay,
authenticated control endpoints and client reconnects. Live provider latency must
be measured separately; deterministic fixtures do not establish Bunkr speed.
