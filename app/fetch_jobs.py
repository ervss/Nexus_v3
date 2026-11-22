"""Durable album/file jobs. Short transactions, leased tasks, replayable events.

SQLite is the source of truth; asyncio tasks are disposable executors. Browser
disconnects never cancel work. Explicit cancellation fences all late writes.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import random
import time
import uuid
from contextlib import suppress

from sqlalchemy import (MetaData, Table, Column, String, Integer, Float, Text,
                        Index, UniqueConstraint, select, update, delete, func, and_, or_, inspect)

from app.ntc.bunkr_scheduler import fetch_priority, fetch_durable, DeferredFetch

log = logging.getLogger(__name__)


def _flush_disk_caches():
    """Persist file metadata in one write. Per-file flushes rewrote the whole JSON."""
    from app import bunkr_cache
    from app.mp4_probe import cache_flush
    bunkr_cache.file_meta_flush()
    cache_flush()


metadata = MetaData()
jobs = Table("fetch_jobs", metadata,
    Column("id", String, primary_key=True), Column("request_key", String, unique=True),
    Column("active_key", String, unique=True), Column("signature", String), Column("mode", String),
    Column("state", String), Column("created", Float), Column("updated", Float),
    Column("dispatched", Float, default=0), Column("limit", Integer, default=0))
tasks = Table("fetch_tasks", metadata,
    Column("id", Integer, primary_key=True), Column("job_id", String, nullable=False),
    Column("operation", String), Column("url", Text), Column("state", String),
    Column("seed", Text), Column("result", Text), Column("attempts", Integer, default=0),
    Column("next_at", Float, default=0), Column("owner", String),
    Column("lease_until", Float, default=0), Column("generation", Integer, default=0),
    Column("error", Text, default=""),
    UniqueConstraint("job_id", "operation", "url"),
    Index("ix_fetch_tasks_due", "state", "next_at"),
    Index("ix_fetch_tasks_job", "job_id", "id"))
events = Table("fetch_events", metadata,
    Column("id", Integer, primary_key=True), Column("job_id", String, nullable=False),
    Column("payload", Text), Column("published", Integer, default=0),
    Index("ix_fetch_events_replay", "job_id", "id"),
    Index("ix_fetch_events_outbox", "published", "id"))
requests = Table("fetch_requests", metadata,
    Column("key", String, primary_key=True), Column("signature", String),
    Column("job_id", String, nullable=False, index=True))
TERMINAL = {"completed", "completed_with_errors", "cancelled", "failed"}


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


def _clean(value):
    # Signed URLs are not durable metadata. Playback always resolves them fresh.
    return {k: v for k, v in value.items() if k not in {"stream_url", "_refetching"}}


class FetchStore:
    def __init__(self, engine, *, lease_seconds=120):
        self.engine = engine
        self.lease_seconds = lease_seconds

    def initialize(self):
        metadata.create_all(self.engine)
        if "signature" not in {column["name"] for column in inspect(self.engine).get_columns("fetch_jobs")}:
            with self.engine.begin() as db:
                db.exec_driver_sql("ALTER TABLE fetch_jobs ADD COLUMN signature VARCHAR(64)")
        with self.engine.begin() as db:
            for job in db.execute(select(jobs).where(jobs.c.signature.is_(None))).mappings():
                operation = "file" if job["mode"] in {"files", "files_cached"} else "album"
                urls = list(db.execute(select(tasks.c.url).where(tasks.c.job_id == job["id"],
                                                               tasks.c.operation == operation)).scalars())
                digest = hashlib.sha256(_json([sorted(urls), job["mode"], job["limit"]]).encode()).hexdigest()
                db.execute(update(jobs).where(jobs.c.id == job["id"]).values(signature=digest))
                if job["request_key"]:
                    db.execute(requests.insert().values(key=job["request_key"], signature=digest, job_id=job["id"]))
            old = list(db.execute(select(jobs.c.id).where(
                jobs.c.state.in_(TERMINAL), jobs.c.updated < time.time()-7*86400)).scalars())
            if old:
                db.execute(delete(events).where(events.c.job_id.in_(old)))
                db.execute(delete(tasks).where(tasks.c.job_id.in_(old)))
                db.execute(delete(requests).where(requests.c.job_id.in_(old)))
                db.execute(delete(jobs).where(jobs.c.id.in_(old)))

    def _event(self, db, job_id, payload):
        db.execute(events.insert().values(job_id=job_id, payload=_json(payload), published=0))

    def submit(self, urls, mode, *, limit=0, request_key=None):
        urls = list(dict.fromkeys(urls))
        digest = hashlib.sha256(_json([sorted(urls), mode, limit]).encode()).hexdigest()
        now = time.time()
        with self.engine.begin() as db:
            if request_key:
                prior = db.execute(select(requests).where(requests.c.key == request_key)).mappings().first()
                if prior:
                    if prior["signature"] != digest:
                        raise ValueError("Idempotency key was used for a different request")
                    return prior["job_id"]
            existing = db.execute(select(jobs.c.id, jobs.c.signature).where(or_(
                jobs.c.active_key == digest,
                jobs.c.request_key == request_key if request_key else jobs.c.id == ""))).first()
            if existing:
                if existing.signature != digest:
                    raise ValueError("Idempotency key was used for a different request")
                if request_key:
                    db.execute(requests.insert().values(key=request_key, signature=digest, job_id=existing.id))
                return existing.id
            if db.execute(select(func.count()).select_from(jobs).where(~jobs.c.state.in_(TERMINAL))).scalar() >= 100:
                raise ValueError("Fetch queue is full; wait for an existing batch")
            job_id = uuid.uuid4().hex
            db.execute(jobs.insert().values(id=job_id, request_key=request_key, active_key=digest, signature=digest,
                mode=mode, state="queued", created=now, updated=now, dispatched=0, limit=limit))
            if request_key:
                db.execute(requests.insert().values(key=request_key, signature=digest, job_id=job_id))
            db.execute(tasks.insert(), [dict(job_id=job_id, operation="file" if mode in {"files", "files_cached"} else "album",
                url=url, state="queued", seed="{}", result="{}", attempts=0, next_at=0,
                lease_until=0, generation=0, error="") for url in urls])
            self._event(db, job_id, {"type": "job", "state": "queued"})
            return job_id

    def claim(self, owner):
        now = time.time()
        with self.engine.begin() as db:
            row = db.execute(select(tasks, jobs.c.mode, jobs.c.limit).join(jobs, tasks.c.job_id == jobs.c.id)
                .where(~jobs.c.state.in_(TERMINAL), or_(
                    and_(tasks.c.state.in_(["queued", "retry_wait"]), tasks.c.next_at <= now),
                    and_(tasks.c.state == "running", tasks.c.lease_until < now)))
                .order_by(jobs.c.dispatched, tasks.c.id).limit(1)).mappings().first()
            if not row:
                return None
            row = dict(row)
            generation = row["generation"] + 1
            claimed = db.execute(update(tasks).where(tasks.c.id == row["id"],
                tasks.c.generation == row["generation"], tasks.c.state == row["state"])
                .values(state="running", owner=owner, lease_until=now+self.lease_seconds,
                        generation=generation, attempts=row["attempts"]+1))
            if not claimed.rowcount:
                return None
            db.execute(update(jobs).where(jobs.c.id == row["job_id"]).values(
                state="running", dispatched=now, updated=now))
            row.update(generation=generation, owner=owner, attempts=row["attempts"]+1)
            return row

    def _owned(self, row):
        return and_(tasks.c.id == row["id"], tasks.c.owner == row["owner"],
                    tasks.c.generation == row["generation"], tasks.c.state == "running")

    def heartbeat(self, row):
        with self.engine.begin() as db:
            return bool(db.execute(update(tasks).where(self._owned(row)).values(
                lease_until=time.time()+self.lease_seconds)).rowcount)

    def finish(self, row, result=None, error=None):
        now = time.time()
        with self.engine.begin() as db:
            job = db.execute(select(jobs).where(jobs.c.id == row["job_id"])).mappings().first()
            if not job or job["state"] in TERMINAL:
                return False
            deferred = isinstance(error, DeferredFetch)
            permanent = getattr(error, "status_code", 0) in (400, 401, 404, 410)
            state = "succeeded" if error is None else ("retry_wait" if deferred or (row["attempts"] < 3 and not permanent) else "failed")
            changed = db.execute(update(tasks).where(self._owned(row)).values(
                state=state, result=_json(_clean(result)) if isinstance(result, dict) and row["operation"] == "file" else "{}",
                error=str(error or "")[:500], owner=None, lease_until=0,
                attempts=max(0, row["attempts"]-1) if deferred else row["attempts"],
                next_at=error.retry_at if deferred else now+random.uniform(2, min(60, 5*2**row["attempts"])) if error else 0))
            if not changed.rowcount:
                return False
            if error is None and row["operation"] == "album":
                items = [_clean(item) for item in result["items"] if item.get("url")]
                existing = {r.url: r for r in db.execute(select(tasks).where(
                    tasks.c.job_id == row["job_id"], tasks.c.operation == "file"))}
                additions = []
                pending = 0
                for item in items:
                    item["source_album_urls"] = list(dict.fromkeys([*(item.get("source_album_urls") or []), row["url"]]))
                    previous = existing.get(item["url"])
                    if previous:
                        seed = json.loads(previous.seed)
                        seed["source_album_urls"] = list(dict.fromkeys([
                            *(seed.get("source_album_urls") or []), *item["source_album_urls"]]))
                        db.execute(update(tasks).where(tasks.c.id == previous.id).values(seed=_json(seed)))
                        continue
                    enrich = job["mode"] == "enrich" and not item.get("enriched")
                    if job["limit"] and pending >= job["limit"]:
                        enrich = False
                    pending += int(enrich)
                    additions.append(dict(job_id=row["job_id"], operation="file", url=item["url"],
                        state="queued" if enrich else ("succeeded" if item.get("enriched") else "listed"), seed=_json(item), result="{}",
                        attempts=0, next_at=0, lease_until=0, generation=0, error=""))
                if len(existing) + len(additions) > 100_000:
                    # Keep a clear terminal failure instead of overflowing memory/disk.
                    db.execute(update(tasks).where(tasks.c.id == row["id"]).values(state="failed", error="Batch exceeds 100000 files"))
                    self._event(db, row["job_id"], {"type": "error", "url": row["url"], "error": "Batch exceeds 100000 files"})
                else:
                    for start in range(0, len(additions), 200):
                        db.execute(tasks.insert(), additions[start:start+200])
                    for start in range(0, len(items), 200):
                        self._event(db, row["job_id"], {"type": "listing", "album_url": row["url"],
                            "items": items[start:start+200], "total": len(items)})
            elif error is None:
                seed = json.loads(row["seed"])
                seed.update(_clean(result or {}))
                self._event(db, row["job_id"], {"type": "patch", "url": row["url"], "data": seed})
            else:
                self._event(db, row["job_id"], {"type": "task", "url": row["url"],
                    "state": state, "error": str(error)[:300]})
            unfinished = db.execute(select(func.count()).select_from(tasks).where(
                tasks.c.job_id == row["job_id"], tasks.c.state.in_(["queued", "running", "retry_wait"]))).scalar()
            failed = db.execute(select(func.count()).select_from(tasks).where(
                tasks.c.job_id == row["job_id"], tasks.c.state == "failed")).scalar()
            if not unfinished:
                job_state = "completed_with_errors" if failed else "completed"
                db.execute(update(jobs).where(jobs.c.id == row["job_id"]).values(
                    state=job_state, updated=now, active_key=None))
                self._event(db, row["job_id"], {"type": "job", "state": job_state})
            else:
                db.execute(update(jobs).where(jobs.c.id == row["job_id"]).values(updated=now))
            return True

    def cancel(self, job_id):
        with self.engine.begin() as db:
            changed = db.execute(update(jobs).where(jobs.c.id == job_id, ~jobs.c.state.in_(TERMINAL))
                .values(state="cancelled", active_key=None, updated=time.time()))
            if changed.rowcount:
                db.execute(update(tasks).where(tasks.c.job_id == job_id,
                    tasks.c.state.in_(["queued", "running", "retry_wait"]))
                    .values(state="cancelled", owner=None, lease_until=0))
                self._event(db, job_id, {"type": "job", "state": "cancelled"})

    def release_owner(self, owner):
        with self.engine.begin() as db:
            db.execute(update(tasks).where(tasks.c.owner == owner, tasks.c.state == "running")
                .values(state="queued", owner=None, lease_until=0))

    def snapshot(self, job_id, *, after=0, limit=200):
        with self.engine.connect() as db:
            job = db.execute(select(jobs).where(jobs.c.id == job_id)).mappings().first()
            if not job:
                return None
            counts = {f"{op}:{state}": count for op, state, count in db.execute(
                select(tasks.c.operation, tasks.c.state, func.count()).where(tasks.c.job_id == job_id)
                .group_by(tasks.c.operation, tasks.c.state))}
            rows = db.execute(select(events).where(events.c.job_id == job_id, events.c.id > after)
                .order_by(events.c.id).limit(limit+1)).mappings().all()
            return {"job_id": job_id, "mode": job["mode"], "state": job["state"], "counts": counts,
                "events": [{"seq": r["id"], **json.loads(r["payload"])} for r in rows[:limit]],
                "cursor": rows[min(len(rows), limit)-1]["id"] if rows else after,
                "has_more": len(rows) > limit}

    def results(self, job_id, *, after=0, limit=200):
        with self.engine.connect() as db:
            rows = db.execute(select(tasks).where(tasks.c.job_id == job_id,
                tasks.c.operation == "file", tasks.c.id > after).order_by(tasks.c.id).limit(limit+1)).mappings().all()
            items = []
            for row in rows[:limit]:
                item = json.loads(row["seed"])
                item.update(json.loads(row["result"]))
                item.update(url=row["url"], fetch_state=row["state"], fetch_error=row["error"])
                items.append(item)
            return {"items": items, "cursor": rows[min(len(rows), limit)-1]["id"] if rows else after,
                    "has_more": len(rows) > limit}

    def outbox(self):
        with self.engine.connect() as db:
            return [dict(r) for r in db.execute(select(events).where(events.c.published == 0)
                .order_by(events.c.id).limit(100)).mappings()]

    def published(self, ids):
        if ids:
            with self.engine.begin() as db:
                db.execute(update(events).where(events.c.id.in_(ids)).values(published=1))


class FetchRuntime:
    def __init__(self, store, handler, *, workers=16):
        self.store, self.handler, self.workers = store, handler, workers
        self.owner = uuid.uuid4().hex
        self.background = []
        self.active = {}
        self._start_lock = asyncio.Lock()

    async def start(self):
        async with self._start_lock:
            if any(not task.done() for task in self.background):
                return
            await asyncio.to_thread(self.store.initialize)
            self.background = [asyncio.create_task(self._worker(), name=f"fetch-worker-{i}")
                               for i in range(self.workers)]
            self.background.append(asyncio.create_task(self._publish(), name="fetch-outbox"))
            self.background.append(asyncio.create_task(self._flush_caches(), name="fetch-cache-flush"))

    async def stop(self):
        for task in self.background:
            task.cancel()
        await asyncio.gather(*self.background, return_exceptions=True)
        self.background.clear()
        await asyncio.to_thread(_flush_disk_caches)
        await asyncio.to_thread(self.store.release_owner, self.owner)

    async def cancel(self, job_id):
        await asyncio.to_thread(self.store.cancel, job_id)
        for _, (row, task) in list(self.active.items()):
            if row["job_id"] == job_id:
                task.cancel()

    async def _heartbeat(self, row, work):
        while True:
            await asyncio.sleep(self.store.lease_seconds/3)
            if not await asyncio.to_thread(self.store.heartbeat, row):
                work.cancel()
                return

    async def _worker(self):
        while True:
            try:
                row = await asyncio.to_thread(self.store.claim, self.owner)
                if not row:
                    await asyncio.sleep(0.05)
                    continue
                # File probes are the gallery the user is watching. Keep them at
                # the same rank as the album listing so a large batch is not
                # parked behind unrelated Bunkr traffic.
                token = fetch_priority.set("normal")
                durable_token = fetch_durable.set(True)
                work = asyncio.create_task(self.handler(row))
                heartbeat = asyncio.create_task(self._heartbeat(row, work))
                self.active[row["id"]] = (row, work)
                try:
                    result = await asyncio.wait_for(asyncio.shield(work), 300)
                    await asyncio.to_thread(self.store.finish, row, result)
                except asyncio.CancelledError:
                    if asyncio.current_task().cancelling():
                        raise
                except Exception as exc:
                    await asyncio.to_thread(self.store.finish, row, None, exc)
                finally:
                    work.cancel()
                    heartbeat.cancel()
                    await asyncio.gather(work, heartbeat, return_exceptions=True)
                    self.active.pop(row["id"], None)
                    fetch_priority.reset(token)
                    fetch_durable.reset(durable_token)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("fetch_worker_failure")
                await asyncio.sleep(1)

    async def _publish(self):
        from app.events import bus
        while True:
            try:
                batch = await asyncio.to_thread(self.store.outbox)
                # Compact notification: replay endpoints own the full payload.
                latest = {r["job_id"]: r["id"] for r in batch}
                for job_id, cursor in latest.items():
                    await asyncio.wait_for(bus.emit("fetch.progress", entity=f"fetch:{job_id}",
                        metrics={"job_id": job_id, "cursor": cursor}), 1)
                await asyncio.to_thread(self.store.published, [r["id"] for r in batch])
            except asyncio.CancelledError:
                raise
            except Exception:
                log.debug("fetch_outbox_failure", exc_info=True)
            await asyncio.sleep(0.2)

    async def _flush_caches(self):
        while True:
            try:
                await asyncio.sleep(1.0)
                await asyncio.to_thread(_flush_disk_caches)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.debug("fetch_cache_flush_failure", exc_info=True)
