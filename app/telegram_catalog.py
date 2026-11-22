"""Resumable metadata-only Telegram catalogue. No media downloads here.

One worker owns a process lock. Control, cursors and cooldowns live in the
database; a page and its cursor are committed together, so replay is harmless.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path

from sqlalchemy import func
from telethon.errors import FloodWaitError
from telethon.tl.types import InputMessagesFilterVideo

from .database import (
    SessionLocal, TelegramCatalogChannel as Channel,
    TelegramCatalogControl as Control, TelegramMediaIndex as Media,
)
from .telegram_index import upsert_telegram_media_batch
from .telegram_service import _row, _get_messages
from .telegram_stream import client, public_chat_id

logger = logging.getLogger(__name__)
PAGE = 100
RECENT = 200
REFRESH_SECONDS = 900


def control(db):
    row = db.get(Control, 1)
    if row is None:
        row = Control(id=1, enabled=False, discovered_at=0, wait_until=0, error="")
        db.add(row)
        db.flush()
    return row


def reconcile_desynced_channels(db) -> int:
    """Repair catalog cursors for channels whose index rows were cleared or truncated."""
    stats = db.query(
        Media.chat_id,
        func.count(Media.id),
        func.min(Media.message_id),
    ).group_by(Media.chat_id).all()
    by_chat = {int(chat_id): (int(cnt or 0), int(min_mid or 0)) for chat_id, cnt, min_mid in stats}
    repaired = 0
    for row in db.query(Channel).filter(Channel.active.is_(True)).all():
        chat_id = public_chat_id(int(row.peer_id))
        actual_count, min_mid = by_chat.get(chat_id, (0, 0))
        scanned = int(row.scanned or 0)
        total = int(row.total or 0)
        expected = min(scanned, total) if total > 0 else scanned
        if (scanned > 200 or row.complete) and expected > 0 and actual_count < expected * 0.5 and actual_count <= 250:
            row.cursor = min_mid if actual_count > 0 else 0
            row.scanned = actual_count
            row.complete = False
            row.refresh_cursor = 0
            row.refresh_target = 0
            repaired += 1
    return repaired


def set_enabled(enabled: bool, priorities: list[str] | None = None):
    with SessionLocal() as db:
        job = control(db)
        if enabled and not job.enabled:
            job.last_batch_at = 0
            repaired = reconcile_desynced_channels(db)
            if repaired:
                logger.info("Reconciled %d desynchronized Telegram catalog channel(s)", repaired)
        job.enabled = enabled
        if priorities is not None:
            chosen = set(priorities)
            for row in db.query(Channel):
                row.priority = int(row.peer_id in chosen)
        db.commit()


def catalog_status(db):
    job = db.get(Control, 1)
    stats = db.query(Media.chat_id, func.count(Media.id), func.max(Media.date)).group_by(Media.chat_id).all()
    counts = {chat_id: count for chat_id, count, _ in stats}
    last_dates = {chat_id: last_date for chat_id, _, last_date in stats}
    active_rows = db.query(Channel).filter(Channel.active.is_(True)).order_by(Channel.priority.desc(), Channel.title).all()
    active_chat_ids = {public_chat_id(int(row.peer_id)) for row in active_rows}
    channels = []
    for row in active_rows:
        chat_id = public_chat_id(int(row.peer_id))
        count = counts.get(chat_id, 0)
        channels.append({
            "id": row.peer_id, "title": row.title, "username": row.username,
            "kind": row.kind, "video_count": row.total, "indexed": count,
            "scanned": int(row.scanned or 0),
            "complete": row.complete, "error": row.error,
            "last_sync": row.last_sync, "last_post_at": last_dates.get(chat_id),
            "priority": bool(row.priority),
        })
    indexed_active = sum(counts.get(chat_id, 0) for chat_id in active_chat_ids)
    indexed_total = sum(counts.values())
    indexed_inactive = max(0, indexed_total - indexed_active)
    scanned = sum(int(row.scanned or 0) for row in active_rows)
    enabled = bool(job and job.enabled)
    wait_until = job.wait_until if job else 0
    complete_channels = sum(c["complete"] for c in channels)
    maintaining = bool(channels) and complete_channels == len(channels)
    return {
        "enabled": enabled,
        "state": "waiting" if enabled and wait_until > time.time() else "maintaining" if enabled and maintaining else "running" if enabled else "paused",
        "wait_until": wait_until, "error": job.error if job else "",
        "discovered_at": job.discovered_at if job else 0,
        "indexed": indexed_total, "indexed_active": indexed_active,
        "indexed_inactive": indexed_inactive, "scanned": scanned,
        "channels": channels,
        "complete_channels": complete_channels,
        "total_channels": len(channels),
        "estimated_total": sum(c["video_count"] or 0 for c in channels),
        "counts_known": sum(c["video_count"] is not None for c in channels),
        "videos_per_minute": round((job.rate or 0) * 60, 1) if job and not maintaining else 0,
        "eta_seconds": round(max(0, sum(c['video_count'] or 0 for c in channels) - indexed_active) / job.rate)
            if job and job.rate and enabled and not maintaining and wait_until <= time.time() and channels
            and all(c['video_count'] is not None for c in channels) else None,
    }


def apply_page(db, peer_id, messages, entity, *, mode):
    """Called only after a successful page; never advance on failed requests."""
    channel = db.get(Channel, peer_id)
    items = [_row(message, entity, channel.username or peer_id) for message in messages]
    valid = [item for item in items if item]
    ids = [int(m.id) for m in messages]
    existing = db.query(Media.id).filter(Media.chat_id == public_chat_id(int(peer_id)), Media.message_id.in_(ids)).count() if ids else 0
    upsert_telegram_media_batch(db, valid, commit=False)
    job = control(db)
    now = time.time()
    if mode == 'history' and ids:
        if job.last_batch_at and now - job.last_batch_at > 0:
            speed = max(0, len(valid) - existing) / (now - job.last_batch_at)
            job.rate = speed if not job.rate else job.rate * .8 + speed * .2
        job.last_batch_at = now
    if mode == "refresh":
        # Reconcile the scanned window only; never infer deletion in an unseen
        # part of history. This also refreshes edits/counters in the recent 200.
        upper = channel.refresh_cursor - 1 if channel.refresh_cursor else max(channel.head_id, max(ids, default=0))
        lower = min(ids) if ids else channel.refresh_target
        if lower and upper >= lower:
            db.query(Media).filter(
                Media.chat_id == public_chat_id(int(peer_id)),
                Media.message_id >= lower, Media.message_id <= upper,
                Media.message_id.notin_(ids),
            ).delete(synchronize_session=False)
        if ids:
            channel.head_id = max(channel.head_id, max(ids))
            channel.refresh_cursor = min(ids)
        if not ids or min(ids) <= channel.refresh_target:
            channel.refresh_cursor = 0
            channel.refresh_target = 0
            channel.last_sync = time.time()
    else:
        if ids:
            channel.cursor = min(ids)
            channel.head_id = max(channel.head_id, max(ids))
        channel.scanned += len(messages)
        # A short search page is not proof of exhaustion: ask for the next page.
        if not ids:
            channel.complete = True
            channel.last_sync = time.time()
    channel.error = ""
    channel.retry_at = 0
    db.commit()


class CatalogWorker:
    def __init__(self):
        self.task = None
        self.lock_file = None
        self.pending_priorities = None
        self.turn = 0

    async def start(self):
        if self.task and not self.task.done():
            return
        # Protect a shared Telethon session from duplicate catalogue workers.
        path = Path(__file__).resolve().parent.parent / "data" / "telegram_catalog.lock"
        path.parent.mkdir(parents=True, exist_ok=True)
        handle = path.open("a+b")
        try:
            if os.name == "nt":
                import msvcrt
                handle.seek(0)
                if not handle.read(1):
                    handle.write(b"0")
                    handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()
            logger.info("Telegram catalogue worker already owned by another process")
            return
        self.lock_file = handle
        try:
            with SessionLocal() as db:
                repaired = reconcile_desynced_channels(db)
                if repaired:
                    db.commit()
                    logger.info("Reconciled %d desynchronized Telegram catalog channel(s) on start", repaired)
        except Exception:
            logger.debug("Catalog reconciliation on start skipped", exc_info=True)
        self.task = asyncio.create_task(self.run(), name="telegram-catalog")

    async def stop(self):
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
            self.task = None
        if self.lock_file:
            self.lock_file.close()
            self.lock_file = None

    async def discover(self, connection):
        # Listing dialogs is fast; video totals are collected with actual pages,
        # instead of issuing hundreds of count requests before showing anything.
        dialogs = [d async for d in connection.iter_dialogs() if d.is_channel or d.is_group]
        with SessionLocal() as db:
            seen = set()
            for dialog in dialogs:
                peer = str(dialog.id)
                seen.add(peer)
                row = db.get(Channel, peer)
                if row is None:
                    row = Channel(peer_id=peer)
                    db.add(row)
                row.title = dialog.title or peer
                row.username = getattr(dialog.entity, "username", None) or ""
                row.kind = "group" if dialog.is_group else "channel"
                row.active = True
                if self.pending_priorities is not None:
                    row.priority = int(peer in self.pending_priorities)
            for row in db.query(Channel):
                if row.peer_id not in seen:
                    row.active = False
            job = control(db)
            job.discovered_at = time.time()
            job.error = ""
            db.commit()
        self.pending_priorities = None

    def next_channel(self, db):
        now = time.time()
        ready = db.query(Channel).filter(Channel.active.is_(True), Channel.retry_at <= now).all()
        # Breadth first: two 100-video pages per channel before deep history.
        recent = [c for c in ready if not c.complete and c.scanned < RECENT]
        if recent:
            return min(recent, key=lambda c: (-c.priority, c.scanned, c.peer_id)), "history"
        # Even channels initially containing no videos must be checked again.
        refresh = [c for c in ready if (c.head_id or c.complete) and (c.refresh_cursor or c.last_sync < now - REFRESH_SECONDS)]
        history = [c for c in ready if not c.complete]
        self.turn += 1
        # Reserve most pages for backfill, even when hundreds of channels make
        # one refresh sweep longer than the refresh interval.
        if refresh and (not history or self.turn % 5 == 0):
            return min(refresh, key=lambda c: (-c.priority, c.last_sync, c.peer_id)), "refresh"
        if history:
            return min(history, key=lambda c: (c.scanned, -c.priority, c.peer_id)), "history"
        return None, None

    async def step(self):
        with SessionLocal() as db:
            job = control(db)
            enabled, discovered, waiting = job.enabled, job.discovered_at, job.wait_until
            db.commit()
        if not enabled or waiting > time.time():
            return
        connection = await client()
        if not discovered or discovered < time.time() - 3600:
            await asyncio.wait_for(self.discover(connection), timeout=120)
        with SessionLocal() as db:
            channel, mode = self.next_channel(db)
            if channel is None:
                return
            peer = channel.peer_id
            if mode == "refresh" and not channel.refresh_cursor:
                recent_ids = db.query(Media.message_id).filter(
                    Media.chat_id == public_chat_id(int(peer))
                ).order_by(Media.message_id.desc()).limit(RECENT).all()
                channel.refresh_target = min((r[0] for r in recent_ids), default=channel.head_id)
                db.commit()
            offset = channel.refresh_cursor if mode == "refresh" else channel.cursor
        try:
            entity = await asyncio.wait_for(connection.get_entity(int(peer)), timeout=60)
            messages = await asyncio.wait_for(_get_messages(
                connection, entity, limit=PAGE, offset_id=offset,
                filter=InputMessagesFilterVideo(), _background=True,
            ), timeout=90)
            with SessionLocal() as db:
                # Pause can arrive during the request: committing this page is safe.
                channel = db.get(Channel, peer)
                total = getattr(messages, "total", None)
                if not offset and total is not None:
                    channel.total = int(total)
                apply_page(db, peer, messages, entity, mode=mode)
                control(db).error = ""
                db.commit()
        except FloodWaitError:
            raise
        except Exception as exc:
            logger.warning("Catalogue channel %s: %s", peer, exc)
            with SessionLocal() as db:
                channel = db.get(Channel, peer)
                channel.error = type(exc).__name__ + ": " + str(exc)[:200]
                channel.retry_at = time.time() + 300
                db.commit()

    async def run(self):
        while True:
            try:
                await self.step()
            except asyncio.CancelledError:
                raise
            except FloodWaitError as exc:
                with SessionLocal() as db:
                    job = control(db)
                    job.wait_until = time.time() + int(exc.seconds) + 1
                    job.error = f"Telegram: prestávka {exc.seconds} s"
                    db.commit()
            except Exception as exc:
                logger.warning("Telegram catalogue: %s", exc)
                with SessionLocal() as db:
                    job = control(db)
                    job.error = type(exc).__name__ + ": " + str(exc)[:200]
                    job.wait_until = time.time() + 60
                    db.commit()
            await asyncio.sleep(1.5)


worker = CatalogWorker()
