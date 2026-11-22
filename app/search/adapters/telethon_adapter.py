"""Deep Web vrstva: Telegram FTS5 + progresívny live Telethon streaming adaptér."""
from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List

from app.database import SessionLocal
from app.search_engine import _TELETHON_SEARCH_LOCK
from app.telegram_auth import manager as tg_auth_manager
from app.telegram_index import search_telegram_fts, upsert_telegram_media_batch
from app.telegram_stream import public_chat_id

from ..base import AdapterBatch, cb_allow, cb_record_failure, cb_record_success, normalize_result

logger = logging.getLogger("nexus.omega_search.telethon")


def _format_fts_item(item: Dict[str, Any]) -> Dict[str, Any]:
    channel_lbl = str(item.get("channel") or item.get("author") or "Telegram")
    return normalize_result(
        title=str(item.get("title") or "Telegram Video"),
        url=str(item.get("url") or item.get("stream_url") or ""),
        source=f"Telegram (@{channel_lbl.lstrip('@')})",
        source_key="telegram",
        layer="telethon",
        adapter="telethon_adapter",
        thumbnail=str(item.get("thumbnail") or ""),
        duration=item.get("duration") or 0,
        quality=str(item.get("quality") or ""),
        description=f"Telegram Index | {item.get('duration', '')} | {item.get('quality', '')} | {channel_lbl}",
        extra={
            "chat_id": item.get("chat_id"),
            "message_id": item.get("message_id"),
            "stream_url": item.get("stream_url") or "",
            "size_mb": item.get("size_mb"),
        },
    )


class TelethonSearchAdapter:
    """Správa sa ako streamovací Omni-Search zdroj (najprv FTS5, potom live Telethon)."""

    def __init__(self, *, session_path: str = "telegram_session.session", live_limit: int = 35, timeout_s: float = 18.0):
        self.session_path = session_path
        self.live_limit = live_limit
        self.timeout_s = timeout_s

    def _query_fts(self, query: str, limit: int) -> List[Dict[str, Any]]:
        with SessionLocal() as db:
            rows = search_telegram_fts(db, query, limit=limit)
        return [_format_fts_item(r) for r in (rows or [])]

    async def search_stream(self, query: str, *, limit: int = 30) -> AsyncIterator[AdapterBatch]:
        """Yield-uje najprv FTS5 dávku a následne live Telethon nálezy priamo pri príchode."""
        t0 = time.perf_counter()
        seen_urls: set[str] = set()

        # 1. Okamžitý FTS5 index (< 10 ms)
        try:
            fts_items = await asyncio.to_thread(self._query_fts, query, limit)
            for it in fts_items:
                if it["url"]:
                    seen_urls.add(it["url"])
            elapsed_fts = int((time.perf_counter() - t0) * 1000)
            logger.info("[OMEGA][TELETHON] FTS5 index: %d výsledkov (%d ms)", len(fts_items), elapsed_fts)
            yield AdapterBatch(
                layer="telethon",
                adapter="telethon_adapter",
                source_key="telegram_fts",
                source_label="Telegram FTS5",
                items=fts_items,
                status="ok" if fts_items else "empty",
                elapsed_ms=elapsed_fts,
                query_used=query,
            )
        except Exception as exc:
            logger.warning("[OMEGA][TELETHON] FTS5 chyba: %s", exc)
            yield AdapterBatch("telethon", "telethon_adapter", "telegram_fts", "Telegram FTS5", status="error", error=str(exc), query_used=query)

        # 2. Live Telethon (Deep Web vrstva) pod circuit breakerom a zámkom session
        cb_key = "telegram.telethon"
        allowed, retry_after = cb_allow(cb_key)
        if not allowed:
            yield AdapterBatch(
                layer="telethon",
                adapter="telethon_adapter",
                source_key="telegram_live",
                source_label="Telegram Live (Telethon)",
                status="skipped_circuit",
                error=f"Circuit open ({retry_after:.1f}s)",
                query_used=query,
            )
            return

        api_id = os.getenv("TELEGRAM_API_ID")
        api_hash = os.getenv("TELEGRAM_API_HASH")
        if not (api_id and api_hash and Path(self.session_path).exists()):
            logger.info("[OMEGA][TELETHON] Live session nekonfigurovaná alebo chýba %s — preskakujem live.", self.session_path)
            yield AdapterBatch(
                layer="telethon",
                adapter="telethon_adapter",
                source_key="telegram_live",
                source_label="Telegram Live (Telethon)",
                status="empty",
                error="Session nekonfigurovaná",
                elapsed_ms=int((time.perf_counter() - t0) * 1000),
                query_used=query,
            )
            return

        t_live = time.perf_counter()
        live_collected: List[Dict[str, Any]] = []
        try:
            async with asyncio.timeout(self.timeout_s):
                async with _TELETHON_SEARCH_LOCK:
                    client = await tg_auth_manager.get_client(api_id, api_hash)
                    if not await client.is_user_authorized():
                        cb_record_failure(cb_key, "Telethon session nie je autorizovaná", immediate_trip=True)
                        yield AdapterBatch(
                            layer="telethon",
                            adapter="telethon_adapter",
                            source_key="telegram_live",
                            source_label="Telegram Live (Telethon)",
                            status="error",
                            error="Telethon session neautorizovaná",
                            elapsed_ms=int((time.perf_counter() - t_live) * 1000),
                            query_used=query,
                        )
                        return

                    from telethon.tl.types import InputMessagesFilterVideo

                    chunk: List[Dict[str, Any]] = []
                    async for message in client.iter_messages(
                        None,
                        search=query,
                        filter=InputMessagesFilterVideo,
                        limit=max(limit, self.live_limit),
                    ):
                        try:
                            chat = await message.get_chat()
                            chat_title = getattr(chat, "title", getattr(chat, "username", "Telegram"))
                            cid = public_chat_id(int(chat.id))
                            link = (
                                f"https://t.me/{chat.username}/{message.id}"
                                if getattr(chat, "username", None)
                                else f"https://t.me/c/{cid}/{message.id}"
                            )
                            if link in seen_urls:
                                continue

                            caption = message.message or ""
                            filename = "Telegram Video"
                            duration = 0
                            size_bytes = 0
                            if message.document:
                                size_bytes = int(message.document.size or 0)
                                for attr in message.document.attributes:
                                    if hasattr(attr, "file_name") and attr.file_name:
                                        filename = attr.file_name
                                    if hasattr(attr, "duration"):
                                        duration = int(attr.duration or 0)
                            if duration < 45 and size_bytes < (40 * 1024 * 1024):
                                continue

                            seen_urls.add(link)
                            size_mb = round(size_bytes / (1024 * 1024), 1)
                            thumb_url = f"/api/v1/telegram/thumb/{cid}/{message.id}"
                            item = normalize_result(
                                title=(caption if len(caption) > 5 else filename),
                                url=link,
                                source=f"Telegram ({chat_title})",
                                source_key="telegram",
                                layer="telethon",
                                adapter="telethon_adapter",
                                thumbnail=thumb_url,
                                duration=duration,
                                description=f"Telethon Live | {size_mb} MB | {chat_title}",
                                extra={
                                    "chat_id": cid,
                                    "message_id": message.id,
                                    "stream_url": f"/api/v1/telegram/stream/{cid}/{message.id}",
                                    "size_mb": size_mb,
                                },
                            )
                            live_collected.append(item)
                            chunk.append(item)
                            # Streamuj po 5 výsledkoch priebežne
                            if len(chunk) >= 5:
                                yield AdapterBatch(
                                    layer="telethon",
                                    adapter="telethon_adapter",
                                    source_key="telegram_live",
                                    source_label="Telegram Live (Telethon)",
                                    items=list(chunk),
                                    status="ok",
                                    elapsed_ms=int((time.perf_counter() - t_live) * 1000),
                                    query_used=query,
                                )
                                chunk.clear()
                        except Exception as item_exc:
                            logger.debug("[OMEGA][TELETHON] Chyba správy: %s", item_exc)
                            continue

                    if chunk or not live_collected:
                        yield AdapterBatch(
                            layer="telethon",
                            adapter="telethon_adapter",
                            source_key="telegram_live",
                            source_label="Telegram Live (Telethon)",
                            items=chunk,
                            status="ok" if (chunk or live_collected) else "empty",
                            elapsed_ms=int((time.perf_counter() - t_live) * 1000),
                            query_used=query,
                        )
            cb_record_success(cb_key)
            logger.info("[OMEGA][TELETHON] Live search dokončený: %d nových videí (%d ms)", len(live_collected), int((time.perf_counter() - t_live) * 1000))
            if live_collected:
                try:
                    with SessionLocal() as db:
                        upsert_telegram_media_batch(db, live_collected)
                except Exception as idx_exc:
                    logger.debug("[OMEGA][TELETHON] FTS5 auto-index zlyhal: %s", idx_exc)
        except Exception as exc:
            cb_record_failure(cb_key, str(exc), immediate_trip=isinstance(exc, (asyncio.TimeoutError, TimeoutError)))
            elapsed = int((time.perf_counter() - t_live) * 1000)
            logger.warning("[OMEGA][TELETHON] Live search chyba: %s (%d ms)", exc, elapsed)
            yield AdapterBatch(
                layer="telethon",
                adapter="telethon_adapter",
                source_key="telegram_live",
                source_label="Telegram Live (Telethon)",
                status="error",
                error=str(exc),
                elapsed_ms=elapsed,
                query_used=query,
            )
