import asyncio
import json
import logging
import re
import subprocess
import threading
import time
from contextlib import suppress
from pathlib import Path

from telethon.errors import (
    FileReferenceExpiredError,
    FilerefUpgradeNeededError,
    FloodWaitError,
    LimitInvalidError,
)
from telethon.network import MTProtoSender
from telethon.tl import functions
from telethon.tl.alltlobjects import LAYER

from .telegram_auth import manager as tg_auth_manager

logger = logging.getLogger(__name__)

THUMB_DIR = Path("data/telegram_thumbs")
CACHE_DIR = Path("data/telegram_cache")
ALIGN = 4096
# Telegram upload.getFile rejects limits above 512 KiB (LIMIT_INVALID).
# Telethon's iter_download clamps request_size to that same ceiling.
# A 1–2 MB HTTP write is several of these parts already sitting in the cache.
REQUEST_SIZE = 1024 * 1024
PART = 512 * 1024
_FALLBACK_PART_SIZES = (PART, 256 * 1024, 128 * 1024, 64 * 1024, 32 * 1024, 4096)
_MESSAGE_CACHE_TTL_SECONDS = 180.0
_MESSAGE_CACHE_MAX = 256
_message_cache: dict[tuple[int, int], tuple[object, object, float]] = {}
# One TCP session to a DC serves getFile roughly one-at-a-time. Extra
# authorized connections hide that round-trip. 8 x 512 KiB is about 4 MB
# on the wire; the reader queue stays a little ahead of that.
DOWNLOAD_LINKS = 4
# How many getFile requests each open socket sends before it waits.
WAVE_PER_LINK = 4
PREFETCH_BYTES = 5 * 1024 * 1024
# A leading moov of a few MB has to arrive before the browser can paint.
# Keep that prefix narrow so it is not stuck behind a wide wave.
HEAD_BYTES = 3 * 1024 * 1024
IN_FLIGHT = max(DOWNLOAD_LINKS * WAVE_PER_LINK, PREFETCH_BYTES // PART)
_RANGE = re.compile(r"bytes=(\d*)-(\d*)$")
_pumps: dict[tuple[int, int], "TelegramPump"] = {}
_pumps_guard = asyncio.Lock()
_download_links = None


def peer_id(chat_id: int) -> int:
    if chat_id < 0:
        return chat_id
    return int(f"-100{chat_id}")


def public_chat_id(raw_id: int) -> int:
    if raw_id < 0:
        text = str(raw_id)
        if text.startswith("-100"):
            return int(text[4:])
    return raw_id


async def client():
    connection = await tg_auth_manager.get_client()
    if not await connection.is_user_authorized():
        raise PermissionError("Telegram session is not authorized")
    return connection


async def get_video_message(chat_id: int, message_id: int, *, force_refresh: bool = False):
    connection = await client()
    cache_key = (public_chat_id(int(chat_id)), int(message_id))
    now = time.monotonic()
    if not force_refresh:
        cached = _message_cache.get(cache_key)
        if cached is not None:
            message, document, expires_at = cached
            if expires_at > now:
                return connection, message, document
            _message_cache.pop(cache_key, None)
    else:
        _message_cache.pop(cache_key, None)

    message = await connection.get_messages(peer_id(chat_id), ids=message_id)
    document = getattr(message, "document", None) if message else None
    if document is None or not str(getattr(document, "mime_type", "")).startswith("video/"):
        raise FileNotFoundError("video message not found")

    if len(_message_cache) >= _MESSAGE_CACHE_MAX:
        expired = [k for k, (_m, _d, exp) in _message_cache.items() if exp <= now]
        for k in expired:
            _message_cache.pop(k, None)
        if len(_message_cache) >= _MESSAGE_CACHE_MAX:
            _message_cache.pop(next(iter(_message_cache)), None)
    _message_cache[cache_key] = (message, document, now + _MESSAGE_CACHE_TTL_SECONDS)
    return connection, message, document


def parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    if not header:
        return None
    match = _RANGE.fullmatch(header.strip())
    if not match or size <= 0:
        raise ValueError("bad range")
    start_s, end_s = match.group(1), match.group(2)
    if not start_s and not end_s:
        raise ValueError("bad range")
    if not start_s:
        length = int(end_s)
        start, end = max(0, size - length), size - 1
    else:
        start = int(start_s)
        end = int(end_s) if end_s else size - 1
    if start >= size or end < start:
        raise ValueError("unsatisfiable")
    return start, min(end, size - 1)


def _cache_paths(chat_id: int, message_id: int) -> tuple[Path, Path]:
    # chat_id is part of the name so the same message id in two chats cannot collide.
    base = CACHE_DIR / f"{chat_id}_{message_id}"
    return base.with_suffix(".mp4"), base.with_suffix(".json")


def _load_meta(chat_id: int, message_id: int) -> dict | None:
    _media, meta_path = _cache_paths(chat_id, message_id)
    if not meta_path.is_file():
        return None
    try:
        data = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def cached_stream_file(chat_id: int, message_id: int) -> tuple[Path, int, str] | None:
    """Return the local file once every byte has been stored."""
    meta = _load_meta(chat_id, message_id)
    if not meta:
        return None
    try:
        size = int(meta.get("size") or 0)
    except (TypeError, ValueError):
        return None
    ranges = meta.get("ranges") or []
    if size <= 0 or ranges != [[0, size]]:
        return None
    media, _meta_path = _cache_paths(chat_id, message_id)
    if not media.is_file() or media.stat().st_size < size:
        return None
    return media, size, str(meta.get("mime") or "video/mp4")


def cached_range(chat_id: int, message_id: int, header: str | None) -> tuple[Path, int, int, int, str] | None:
    """Return a disk span when every requested byte is already stored.

    The total is the Telegram file size. A partial cache must not be sent
    with FileResponse, because that would advertise the short file as complete.
    """
    if not header:
        return None
    meta = _load_meta(chat_id, message_id)
    if not meta:
        return None
    try:
        size = int(meta.get("size") or 0)
    except (TypeError, ValueError):
        return None
    if size <= 0:
        return None
    try:
        span = parse_range(header, size)
    except ValueError:
        return None
    if span is None:
        return None
    start, end = span
    ranges: list[tuple[int, int]] = []
    for pair in meta.get("ranges") or []:
        if isinstance(pair, (list, tuple)) and len(pair) == 2:
            try:
                ranges.append((int(pair[0]), int(pair[1])))
            except (TypeError, ValueError):
                continue
    need = end + 1
    if not any(left <= start and right >= need for left, right in ranges):
        return None
    media, _meta_path = _cache_paths(chat_id, message_id)
    if not media.is_file() or media.stat().st_size < need:
        return None
    return media, start, end, size, str(meta.get("mime") or "video/mp4")


async def iter_cached_file(path: Path, start: int, end: int):
    def read_at(offset: int, size: int) -> bytes:
        with open(path, "rb") as handle:
            handle.seek(offset)
            return handle.read(size)

    cursor = start
    while cursor <= end:
        blob = await asyncio.to_thread(read_at, cursor, min(1024 * 1024, end - cursor + 1))
        if not blob:
            break
        yield blob
        cursor += len(blob)


def active_media(chat_id: int, message_id: int):
    """Reuse the document already attached to a live pump. No extra RPC."""
    pump = _pumps.get((int(chat_id), int(message_id)))
    if pump is None or pump.connection is None or pump.document is None:
        return None
    if int(getattr(pump.document, "size", 0) or 0) <= 0:
        return None
    return pump.connection, pump.document


def _merge_ranges(ranges: list[tuple[int, int]], start: int, end: int) -> list[tuple[int, int]]:
    merged: list[tuple[int, int]] = []
    for left, right in sorted([*ranges, (start, end)]):
        if merged and left <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], right))
        else:
            merged.append((left, right))
    return merged


async def _legacy_sender(client, dc_id: int):
    """One sender Telethon already knows how to open, if the extra pool is late."""
    try:
        if int(getattr(client.session, "dc_id", 0) or 0) == int(dc_id):
            return client._sender
        return await asyncio.wait_for(client._borrow_exported_sender(int(dc_id)), timeout=12)
    except Exception:
        logger.warning("Telegram fallback sender failed", exc_info=True)
        return None


def _init_connection(client, query):
    src = client._init_request
    return functions.InitConnectionRequest(
        api_id=src.api_id,
        device_model=src.device_model,
        system_version=src.system_version,
        app_version=src.app_version,
        lang_code=src.lang_code,
        system_lang_code=src.system_lang_code,
        lang_pack=src.lang_pack,
        query=query,
        proxy=getattr(src, "proxy", None),
    )


async def _open_download_sender(client, dc_id: int):
    """Open one more MTProto session to the file's DC.

    This is not a second TelegramClient and it does not open the SQLite
    session file. A file on the logged-in DC reuses that auth key.
    ExportAuthorization is rejected for the current DC (DcIdInvalidError),
    so it is only used when the file lives on a different DC.
    """
    dc = await client._get_dc(int(dc_id))
    same_dc = int(getattr(client.session, "dc_id", 0) or 0) == int(dc_id)
    auth_key = getattr(getattr(client, "_sender", None), "auth_key", None)
    if same_dc and not getattr(auth_key, "key", None):
        raise RuntimeError("session auth key is not ready")
    sender = MTProtoSender(auth_key if same_dc else None, loggers=client._log)
    await sender.connect(client._connection(
        dc.ip_address,
        dc.port,
        dc.id,
        loggers=client._log,
        proxy=client._proxy,
        local_addr=client._local_addr,
    ))
    if same_dc:
        init = _init_connection(client, functions.help.GetConfigRequest())
        await sender.send(functions.InvokeWithLayerRequest(LAYER, init))
    else:
        # A newer ExportAuthorization invalidates bytes that are not imported yet.
        # Import finishes before the lock is released so the next link gets its own blob.
        async with client._borrow_sender_lock:
            auth = await client(functions.auth.ExportAuthorizationRequest(int(dc_id)))
            init = _init_connection(
                client,
                functions.auth.ImportAuthorizationRequest(id=auth.id, bytes=bytes(auth.bytes)),
            )
            await sender.send(functions.InvokeWithLayerRequest(LAYER, init))
    sender.dc_id = int(dc_id)
    return sender


class _DownloadLinks:
    """Pool of extra DC connections. One getFile runs on each link at a time."""

    def __init__(self):
        self._guard = asyncio.Lock()
        self._queues: dict[tuple, asyncio.Queue] = {}
        self._filling: dict[tuple, bool] = {}

    async def _queue(self, client, dc_id: int) -> asyncio.Queue:
        key = (id(client), int(dc_id))
        async with self._guard:
            queue = self._queues.get(key)
            if queue is None:
                queue = asyncio.Queue()
                self._queues[key] = queue
                self._filling[key] = True
                asyncio.create_task(
                    self._fill(client, int(dc_id), queue, key),
                    name=f"tg-links-dc{dc_id}",
                )
            return queue

    async def _fill(self, client, dc_id: int, queue: asyncio.Queue, key: tuple) -> None:
        opened = 0
        # One link at a time. Parallel auth-key handshakes were stalling and
        # the player then waited on an empty queue. Each success is queued
        # before the next handshake starts.
        try:
            for index in range(DOWNLOAD_LINKS):
                try:
                    sender = await asyncio.wait_for(_open_download_sender(client, dc_id), timeout=12)
                except Exception:
                    logger.warning("Telegram download link %s failed", index, exc_info=True)
                    continue
                queue.put_nowait(sender)
                opened += 1
                logger.info("Telegram link %s for DC %s ready", index, dc_id)
            logger.info("Telegram download links for DC %s: %s", dc_id, opened)
        finally:
            async with self._guard:
                self._filling[key] = False

    async def borrow(self, client, dc_id: int, want: int, wait: float = 0) -> list:
        """Take up to `want` sockets that are already connected.

        Playback must not wait here. A pool that failed to open (same-DC
        export is rejected) used to block the first byte for 15 seconds,
        twice. `wait` 0 returns whatever is queued.
        """
        queue = await self._queue(client, dc_id)
        key = (id(client), int(dc_id))
        async with self._guard:
            filling = self._filling.get(key, False)
        if not filling and queue.empty():
            return []
        if wait <= 0:
            try:
                first = queue.get_nowait()
            except asyncio.QueueEmpty:
                return []
        else:
            try:
                first = await asyncio.wait_for(queue.get(), timeout=wait)
            except (asyncio.TimeoutError, TimeoutError):
                return []
        found = [first]
        while len(found) < want:
            try:
                found.append(queue.get_nowait())
            except asyncio.QueueEmpty:
                break
        return found

    def give_back(self, client, dc_id: int, senders: list) -> None:
        queue = self._queues.get((id(client), int(dc_id)))
        if queue is None:
            return
        for sender in senders:
            queue.put_nowait(sender)


async def _drop_client(client) -> None:
    try:
        await client.disconnect()
    except Exception:
        logger.debug("Telegram CDN client disconnect failed", exc_info=True)


def _links() -> _DownloadLinks:
    global _download_links
    if _download_links is None:
        _download_links = _DownloadLinks()
    return _download_links


class TelegramPump:
    """Download one Telegram file ahead of the player and keep the bytes on disk.

    Up to eight DC connections pull 512 KiB parts into an asyncio queue (about
    5 MB ahead of the player). A commit task writes each part to disk as it
    arrives. The HTTP generator yields those bytes immediately. A later seek
    reads the file when that span is already stored.
    """

    def __init__(self, chat_id: int, message_id: int, size: int, mime: str):
        self.chat_id = chat_id
        self.message_id = message_id
        self.size = size
        self.mime = mime or "video/mp4"
        self.media_path, self.meta_path = _cache_paths(chat_id, message_id)
        self.ranges: list[tuple[int, int]] = []
        self.connection = None
        self.document = None
        self.chunks: asyncio.Queue = asyncio.Queue(maxsize=IN_FLIGHT)
        self.cond = asyncio.Condition()
        self.inflight: dict[int, asyncio.Task] = {}
        self.queued: set[int] = set()
        self.retry_at: dict[int, float] = {}
        self.readers: dict[int, int] = {}
        self.fill_background = True
        self._reader_seq = 0
        self._io_lock = threading.Lock()
        self._fh = None
        self._scheduler: asyncio.Task | None = None
        self._committer: asyncio.Task | None = None
        self._closed = False
        self._faststarted = False
        self._started_at = time.monotonic()
        self._logged_marks: set[int] = set()
        saved = _load_meta(chat_id, message_id)
        if saved and int(saved.get("size") or 0) == size:
            for pair in saved.get("ranges") or []:
                if isinstance(pair, (list, tuple)) and len(pair) == 2:
                    self.ranges = _merge_ranges(self.ranges, int(pair[0]), int(pair[1]))

    def attach(self, connection, document) -> None:
        self.connection = connection
        self.document = document

    def ensure_started(self) -> None:
        if self._committer is None or self._committer.done():
            self._committer = asyncio.create_task(self._commit(), name=f"tg-commit-{self.message_id}")
        if self._scheduler is None or self._scheduler.done():
            self._scheduler = asyncio.create_task(self._schedule(), name=f"tg-fill-{self.message_id}")

    def _covered_until(self, cursor: int) -> int:
        for left, right in self.ranges:
            if left <= cursor < right:
                return right
            if left > cursor:
                break
        return cursor

    def _lowest_hole(self) -> int | None:
        cursor = 0
        for left, right in self.ranges:
            if cursor < left:
                return cursor
            cursor = max(cursor, right)
        if cursor < self.size:
            return cursor
        return None

    def _priority_origin(self) -> int | None:
        waiting = []
        for cursor in self.readers.values():
            if 0 <= cursor < self.size and self._covered_until(cursor) == cursor:
                waiting.append(cursor - (cursor % PART))
        if waiting:
            # MP4 files with a trailing moov atom prompt the browser to ask
            # for the last few megabytes while its initial open-ended range
            # is still active. Serving the lower cursor forever forces a full
            # multi-GB download before playback can start.
            if self._covered_until(0) >= HEAD_BYTES:
                tail_start = max(HEAD_BYTES, self.size - 16 * 1024 * 1024)
                tail_waiting = [offset for offset in waiting if offset >= tail_start]
                if tail_waiting:
                    return min(tail_waiting)
            return min(waiting)
        if not self.fill_background:
            if not self.readers:
                return None
            cursor = min(self.readers.values())
            covered = self._covered_until(cursor)
            if covered >= cursor + PREFETCH_BYTES:
                return None
            return covered - (covered % PART)
        hole = self._lowest_hole()
        if hole is None:
            return None
        return hole - (hole % PART)

    def _next_offsets(self, count: int) -> list[int]:
        origin = self._priority_origin()
        if origin is None:
            return []
        found: list[int] = []
        offset = origin
        while len(found) < count and offset < self.size:
            part_end = min(self.size, offset + PART)
            if (
                offset not in self.inflight
                and offset not in self.queued
                and self._covered_until(offset) < part_end
                and self.retry_at.get(offset, 0) <= time.monotonic()
            ):
                found.append(offset)
            offset += PART
        return found

    async def _schedule(self) -> None:
        """Send several getFile requests before waiting for any of them.

        One socket that waits for each 512 KiB answer stays around one
        round-trip per part. A wave hands every open socket a handful of
        requests in one MTProto container, then waits for that wave.
        """
        from telethon import utils
        from telethon.errors import FileReferenceExpiredError, FloodWaitError

        while self._lowest_hole() is not None:
            if not self.fill_background and not self.readers:
                break
            if self.connection is None or self.document is None:
                await asyncio.sleep(0.05)
                continue
            dc_id, _location = utils.get_input_location(self.document)
            if not dc_id:
                dc_id = int(self.connection.session.dc_id)
            borrowed = await _links().borrow(self.connection, int(dc_id), DOWNLOAD_LINKS, wait=0)
            senders = list(borrowed)
            if not senders:
                sender = await _legacy_sender(self.connection, int(dc_id))
                if sender is None:
                    await asyncio.sleep(0.4)
                    continue
                senders = [sender]
            # The first getFile also asks about a CDN copy. It runs on a
            # sender we already have, so a dead extra-link pool cannot delay it.
            if (
                self._covered_until(0) == 0
                and 0 not in self.queued
                and 0 not in self.inflight
            ):
                logger.info(
                    "Telegram head dc=%s via=%s",
                    dc_id,
                    "link" if borrowed else "session",
                )
                try:
                    if await self._prime_head(senders[0]):
                        if borrowed:
                            _links().give_back(self.connection, int(dc_id), borrowed)
                        return
                except Exception:
                    logger.warning("Telegram head request failed", exc_info=True)
                    if borrowed:
                        _links().give_back(self.connection, int(dc_id), borrowed)
                    await asyncio.sleep(0.3)
                    continue
            head = self._covered_until(0)
            # A wide wave answers one 512 KiB part at a time. The part the
            # player is blocked on can be last, so a 16-deep wave costs about
            # 20 seconds before the first painted byte. Ask for that part alone.
            blocked = any(
                0 <= cursor < self.size and self._covered_until(cursor) == cursor
                for cursor in self.readers.values()
            )
            if blocked or head < HEAD_BYTES:
                width = 1
            else:
                width = min(4, max(1, len(senders)))
            offsets = self._next_offsets(width)
            if not offsets:
                if borrowed:
                    _links().give_back(self.connection, int(dc_id), borrowed)
                await asyncio.sleep(0.05)
                continue
            for offset in offsets:
                self.inflight[offset] = None
            started = time.monotonic()
            groups: list[list[int]] = [[] for _ in senders]
            for index, offset in enumerate(offsets):
                groups[index % len(senders)].append(offset)
            try:
                batches = await asyncio.gather(*(
                    self._wave_on(senders[index], group)
                    for index, group in enumerate(groups)
                    if group
                ))
            except FloodWaitError as exc:
                self._release_wave(offsets, delay=int(exc.seconds) + 0.5)
                logger.warning("Telegram flood wait %ss while streaming", exc.seconds)
                if borrowed:
                    _links().give_back(self.connection, int(dc_id), borrowed)
                await asyncio.sleep(min(int(exc.seconds), 5))
                continue
            except FileReferenceExpiredError:
                self._release_wave(offsets, delay=0)
                if borrowed:
                    _links().give_back(self.connection, int(dc_id), borrowed)
                try:
                    connection, _message, document = await get_video_message(self.chat_id, self.message_id)
                    self.connection = connection
                    self.document = document
                except Exception:
                    logger.warning("Telegram file reference refresh failed", exc_info=True)
                    await asyncio.sleep(0.5)
                continue
            except Exception as exc:
                logger.warning("Telegram wave failed: %s", exc)
                self._release_wave(offsets, delay=0.4)
                if borrowed:
                    _links().give_back(self.connection, int(dc_id), borrowed)
                await asyncio.sleep(0.2)
                continue
            got = sum(batches)
            logger.debug(
                "Telegram wave parts=%s bytes=%s links=%s in %.3fs",
                len(offsets),
                got,
                len(senders),
                time.monotonic() - started,
            )
            if borrowed:
                _links().give_back(self.connection, int(dc_id), borrowed)

    async def _prime_head(self, sender) -> bool:
        """Fetch offset 0 and ask whether Telegram has a CDN copy.

        Returns True when the CDN path owns the rest of the download.
        """
        from telethon import utils
        from telethon.tl import types

        _dc, location = utils.get_input_location(self.document)
        probe = functions.upload.GetFileRequest(
            location, offset=0, limit=PART, cdn_supported=True,
        )
        result = await self.connection._call(sender, probe)
        if isinstance(result, types.upload.FileCdnRedirect):
            logger.info("Telegram CDN redirect to DC %s", result.dc_id)
            await self._fill_cdn(result)
            return True
        data = bytes(result.bytes)
        take = min(PART, self.size)
        if len(data) >= take:
            self.queued.add(0)
            await self.chunks.put((0, data[:take]))
        else:
            self.retry_at[0] = time.monotonic() + 0.4
        logger.info("Telegram file has no CDN copy")
        return False

    async def _fill_cdn(self, redirect) -> None:
        from telethon.crypto import AES
        from telethon.tl import types

        clients = []
        try:
            for _ in range(DOWNLOAD_LINKS):
                clients.append(await self.connection._get_cdn_client(redirect))
        except Exception:
            logger.warning("Telegram CDN connect failed", exc_info=True)
            for client in clients:
                await _drop_client(client)
            return
        token = redirect.file_token
        key = redirect.encryption_key
        iv = redirect.encryption_iv
        logger.info("Telegram CDN links=%s", len(clients))
        try:
            while self._lowest_hole() is not None and clients:
                if not self.fill_background and not self.readers:
                    break
                offsets = self._next_offsets(len(clients) * WAVE_PER_LINK)
                if not offsets:
                    await asyncio.sleep(0.05)
                    continue
                for offset in offsets:
                    self.inflight[offset] = None
                started = time.monotonic()

                async def one(client, offset: int) -> int:
                    request = functions.upload.GetCdnFileRequest(token, offset, PART)
                    result = await client(request)
                    if isinstance(result, types.upload.CdnFileReuploadNeeded):
                        await self.connection(functions.upload.ReuploadCdnFileRequest(
                            file_token=token, request_token=result.request_token,
                        ))
                        result = await client(request)
                    data = bytes(result.bytes)
                    if key and iv and data:
                        data = AES.decrypt_ige(data, key, iv)
                    take = min(PART, self.size - offset)
                    self.inflight.pop(offset, None)
                    if len(data) < take:
                        self.retry_at[offset] = time.monotonic() + 0.4
                        return 0
                    self.queued.add(offset)
                    await self.chunks.put((offset, data[:take]))
                    return take

                try:
                    got = sum(await asyncio.gather(*(
                        one(clients[index % len(clients)], offset)
                        for index, offset in enumerate(offsets)
                    )))
                except Exception as exc:
                    logger.warning("Telegram CDN wave failed: %s", exc)
                    self._release_wave(offsets, delay=0.4)
                    await asyncio.sleep(0.3)
                    continue
                logger.debug(
                    "Telegram CDN wave parts=%s bytes=%s in %.3fs",
                    len(offsets),
                    got,
                    time.monotonic() - started,
                )
        finally:
            for client in clients:
                await _drop_client(client)

    def _release_wave(self, offsets: list[int], delay: float) -> None:
        for offset in offsets:
            self.inflight.pop(offset, None)
            if offset not in self.queued and delay:
                self.retry_at[offset] = time.monotonic() + delay

    async def _wave_on(self, sender, offsets: list[int]) -> int:
        from telethon import utils
        from telethon.tl import types

        requests = []
        for offset in offsets:
            _dc, location = utils.get_input_location(self.document)
            requests.append(functions.upload.GetFileRequest(location, offset=offset, limit=PART))
        # Queued together, unordered, so the socket does not wait for part 1
        # before it asks for part 2. Each finished part is handed to the player
        # before the rest of this socket's wave returns.
        pending = sender.send(requests if len(requests) > 1 else requests[0], ordered=False)
        futures = pending if isinstance(pending, list) else [pending]

        async def take_one(offset: int, future) -> int:
            item = await future
            if isinstance(item, types.upload.FileCdnRedirect):
                raise RuntimeError("cdn redirect")
            data = bytes(item.bytes)
            take = min(PART, self.size - offset)
            self.inflight.pop(offset, None)
            if len(data) < take:
                self.retry_at[offset] = time.monotonic() + 0.4
                return 0
            self.queued.add(offset)
            await self.chunks.put((offset, data))
            return len(data)

        sizes = await asyncio.gather(*(take_one(offset, future) for offset, future in zip(offsets, futures)))
        return sum(sizes)

    async def _commit(self) -> None:
        while not self._closed:
            offset, data = await self.chunks.get()
            await asyncio.to_thread(self._write_disk, offset, data)
            async with self.cond:
                self.ranges = _merge_ranges(self.ranges, offset, offset + len(data))
                self.queued.discard(offset)
                covered = self._covered_until(0)
                snapshot = [[left, right] for left, right in self.ranges]
                self.cond.notify_all()
            try:
                await asyncio.to_thread(self._write_meta, snapshot)
            except OSError as exc:
                # A Windows reader or antivirus scanner can briefly hold the
                # destination JSON open. The in-memory ranges are already
                # correct; a later chunk can persist them. Never strand the
                # HTTP reader by killing the only cache writer.
                logger.warning(
                    "Telegram cache metadata write deferred for %s_%s: %s",
                    self.chat_id, self.message_id, exc,
                )
            mark = covered // (1024 * 1024)
            if mark and mark not in self._logged_marks:
                self._logged_marks.add(mark)
                logger.debug(
                    "Telegram cache %s_%s contiguous %s bytes in %.2fs",
                    self.chat_id,
                    self.message_id,
                    covered,
                    time.monotonic() - self._started_at,
                )
            if covered >= self.size and not self._faststarted:
                self._faststarted = True
                asyncio.create_task(self._apply_faststart())

    async def _apply_faststart(self) -> None:
        def run():
            try:
                with self._io_lock:
                    if self._fh and not self._fh.closed:
                        self._fh.flush()
                        self._fh.close()
                        self._fh = None
                tmp = self.media_path.with_suffix(".fs.tmp")
                cmd = ["ffmpeg", "-y", "-i", str(self.media_path), "-c", "copy", "-movflags", "+faststart", str(tmp)]
                res = subprocess.run(cmd, capture_output=True, timeout=90)
                if res.returncode == 0 and tmp.exists() and tmp.stat().st_size > 0:
                    with self._io_lock:
                        if self._fh and not self._fh.closed:
                            self._fh.close()
                            self._fh = None
                        tmp.replace(self.media_path)
                    new_size = self.media_path.stat().st_size
                    self.size = new_size
                    self._write_meta([[0, new_size]])
                    logger.info("Faststart applied to %s_%s", self.chat_id, self.message_id)
            except Exception as e:
                logger.debug("Faststart pass skipped for %s_%s: %s", self.chat_id, self.message_id, e)
        await asyncio.to_thread(run)

    def _file(self):
        if self._fh is None or self._fh.closed:
            self.media_path.parent.mkdir(parents=True, exist_ok=True)
            self._fh = open(self.media_path, "r+b" if self.media_path.exists() else "w+b")
        return self._fh

    def _write_disk(self, offset: int, data: bytes) -> None:
        with self._io_lock:
            handle = self._file()
            handle.seek(offset)
            handle.write(data)
            handle.flush()

    def _read_disk(self, offset: int, size: int) -> bytes:
        with self._io_lock:
            handle = self._file()
            handle.seek(offset)
            return handle.read(size)

    def _write_meta(self, ranges: list[list[int]]) -> None:
        payload = {"size": self.size, "mime": self.mime, "ranges": ranges}
        self.meta_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.meta_path.with_name(
            f"{self.meta_path.name}.{threading.get_ident()}.{time.time_ns()}.tmp"
        )
        try:
            temporary.write_text(json.dumps(payload), encoding="utf-8")
            for attempt in range(8):
                try:
                    temporary.replace(self.meta_path)
                    return
                except PermissionError:
                    if attempt == 7:
                        raise
                    time.sleep(min(0.05 * (2 ** attempt), 0.5))
        finally:
            with suppress(OSError):
                temporary.unlink(missing_ok=True)

    async def wait_available(self, cursor: int, end: int) -> bytes:
        while True:
            async with self.cond:
                until = min(self._covered_until(cursor), end + 1)
                if until > cursor:
                    take = until - cursor
                else:
                    await self.cond.wait()
                    continue
            return await asyncio.to_thread(self._read_disk, cursor, take)

    async def iter_http(self, start: int, end: int):
        """Yield the range. The queue stays up to 5 MB ahead of the socket."""
        self._reader_seq += 1
        token = self._reader_seq
        self.readers[token] = start
        self.ensure_started()
        queue: asyncio.Queue = asyncio.Queue(maxsize=IN_FLIGHT)

        async def produce() -> None:
            cursor = start
            try:
                while cursor <= end:
                    blob = await self.wait_available(cursor, end)
                    if not blob:
                        break
                    self.readers[token] = cursor
                    await queue.put(blob)
                    cursor += len(blob)
            except asyncio.CancelledError:
                raise
            finally:
                self.readers.pop(token, None)
                await queue.put(None)

        task = asyncio.create_task(produce())
        try:
            while True:
                blob = await queue.get()
                if blob is None:
                    break
                yield blob
        finally:
            task.cancel()
            self.readers.pop(token, None)


async def ensure_pump(chat_id: int, message_id: int, connection, document, *, preview_only: bool = False) -> TelegramPump:
    key = (int(chat_id), int(message_id))
    async with _pumps_guard:
        pump = _pumps.get(key)
        if pump is None or pump.size != int(document.size or 0):
            pump = TelegramPump(key[0], key[1], int(document.size or 0), document.mime_type or "video/mp4")
            pump.fill_background = not preview_only
            _pumps[key] = pump
        elif not preview_only:
            pump.fill_background = True
        pump.attach(connection, document)
        if not preview_only:
            pump.ensure_started()
        return pump


def _align_download_offset(offset: int, request_size: int) -> tuple[int, int]:
    """Align a Telegram getFile offset down to a request_size boundary.

    Telegram upload.getFile rejects requests crossing a 1 MiB boundary with
    LIMIT_INVALID, and Telethon's iter_download mistakenly selects
    _DirectDownloadIter whenever offset % chunk_count == 0 even for unaligned
    offsets. Aligning offset to a power-of-two request_size that divides 1 MiB
    keeps every GetFileRequest strictly within a single 1 MiB block.
    """
    safe_offset = max(0, int(offset))
    aligned = (safe_offset // request_size) * request_size
    return aligned, safe_offset - aligned


async def _close_stream_safely(stream) -> None:
    if stream is None:
        return
    try:
        await stream.close()
    except asyncio.CancelledError:
        with suppress(Exception):
            asyncio.create_task(stream.close())
        raise
    except Exception:
        logger.debug("Telegram stream close failed", exc_info=True)


async def iter_video(connection, document, start: int, end: int, *, chat_id: int, message_id: int, preview_only: bool = False):
    """Relay the requested range directly from Telegram without a disk cache."""
    file_size = int(getattr(document, "size", 0) or 0)
    current_offset = max(0, int(start))
    remaining = int(end) - current_offset + 1
    if remaining <= 0:
        return

    part_index = 0
    ref_refreshes = 0
    flood_retries = 0
    timeout_retries = 0

    while remaining > 0:
        req_size = _FALLBACK_PART_SIZES[part_index]
        aligned_offset, skip = _align_download_offset(current_offset, req_size)
        stream = connection.iter_download(
            document,
            offset=aligned_offset,
            request_size=req_size,
            chunk_size=req_size,
            file_size=file_size,
        )
        try:
            async for chunk in stream:
                if skip > 0:
                    if len(chunk) <= skip:
                        skip -= len(chunk)
                        continue
                    chunk = chunk[skip:]
                    skip = 0
                data = bytes(chunk[:remaining])
                if not data:
                    return
                current_offset += len(data)
                remaining -= len(data)
                yield data
                if remaining <= 0:
                    return
            return
        except LimitInvalidError:
            if part_index + 1 >= len(_FALLBACK_PART_SIZES):
                raise
            part_index += 1
            logger.warning(
                "Telegram LimitInvalidError for %s/%s at offset=%s (req_size=%s); retrying with req_size=%s",
                chat_id,
                message_id,
                current_offset,
                req_size,
                _FALLBACK_PART_SIZES[part_index],
            )
        except (FileReferenceExpiredError, FilerefUpgradeNeededError):
            if ref_refreshes >= 2:
                raise
            ref_refreshes += 1
            logger.info(
                "Refreshing expired Telegram file reference for %s/%s at offset=%s",
                chat_id,
                message_id,
                current_offset,
            )
            connection, _message, document = await get_video_message(
                chat_id, message_id, force_refresh=True
            )
            file_size = int(getattr(document, "size", 0) or file_size)
        except FloodWaitError as exc:
            wait_seconds = max(0, int(getattr(exc, "seconds", 0) or 0))
            if wait_seconds > 15 or flood_retries >= 2:
                raise
            flood_retries += 1
            logger.warning(
                "Telegram FloodWait %ss while streaming %s/%s at offset=%s",
                wait_seconds,
                chat_id,
                message_id,
                current_offset,
            )
            await asyncio.sleep(wait_seconds + 0.5)
        except (TimeoutError, asyncio.TimeoutError, ConnectionError):
            if timeout_retries >= 2:
                raise
            timeout_retries += 1
            logger.warning(
                "Transient connection error while streaming %s/%s at offset=%s; retrying (%s/2)",
                chat_id,
                message_id,
                current_offset,
                timeout_retries,
            )
            await asyncio.sleep(0.5)
        finally:
            await _close_stream_safely(stream)


_POST_THUMB_SEM: asyncio.Semaphore | None = None
_POST_THUMB_LOCKS: dict[tuple[int, int], asyncio.Lock] = {}


def _get_post_thumb_sem() -> asyncio.Semaphore:
    global _POST_THUMB_SEM
    if _POST_THUMB_SEM is None:
        _POST_THUMB_SEM = asyncio.Semaphore(4)
    return _POST_THUMB_SEM


_NON_STATIC_THUMB_TYPES = frozenset({
    "PhotoStrippedSize",
    "PhotoPathSize",
    "VideoSize",
    "VideoSizeEmojiMarkup",
    "VideoSizeStickerMarkup",
})


def _pick_best_thumb(thumbs, max_edge: int | None = None):
    best_thumb = None
    best_area = 0
    fallback_large = None
    fallback_large_area = float("inf")
    for t in thumbs or ():
        # Vynecháme mikro-placeholdery, vektorové cesty aj animované VideoSize (MP4) náhľady.
        if type(t).__name__ in _NON_STATIC_THUMB_TYPES:
            continue
        w = int(getattr(t, "w", 0) or 0)
        h = int(getattr(t, "h", 0) or 0)
        if w <= 0 or h <= 0:
            continue
        area = w * h
        if max_edge and max(w, h) > max_edge:
            if area < fallback_large_area:
                fallback_large_area = area
                fallback_large = t
            continue
        if area > best_area:
            best_area = area
            best_thumb = t
    return best_thumb if best_thumb is not None else fallback_large


def thumb_path(chat_id: int, message_id: int) -> Path:
    return THUMB_DIR / f"{chat_id}_{message_id}.jpg"


def post_thumb_path(chat_id: int, message_id: int) -> Path:
    return THUMB_DIR / f"post_{public_chat_id(int(chat_id))}_{int(message_id)}.jpg"


async def ensure_thumb(chat_id: int, message_id: int) -> Path:
    path = thumb_path(chat_id, message_id)
    if path.is_file() and path.stat().st_size > 0:
        return path
    connection, message, document = await get_video_message(chat_id, message_id)
    if not document.thumbs:
        raise FileNotFoundError("no thumbnail")
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_suffix(".part")
    best_thumb = _pick_best_thumb(getattr(document, "thumbs", []))
    saved = await connection.download_media(message, file=str(part), thumb=best_thumb if best_thumb is not None else -1)
    if not saved:
        raise FileNotFoundError("thumbnail download failed")
    Path(saved).replace(path)
    return path


async def ensure_post_thumb(chat_id: int, message_id: int) -> Path:
    """Stiahne náhľadový obrázok pre ľubovoľný Telegram link/foto/video príspevok."""
    norm_chat_id = public_chat_id(int(chat_id))
    norm_msg_id = int(message_id)
    path = post_thumb_path(norm_chat_id, norm_msg_id)
    if path.is_file() and path.stat().st_size > 0:
        return path
    video_cached = thumb_path(norm_chat_id, norm_msg_id)
    if video_cached.is_file() and video_cached.stat().st_size > 0:
        return video_cached

    key = (norm_chat_id, norm_msg_id)
    lock = _POST_THUMB_LOCKS.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _POST_THUMB_LOCKS[key] = lock

    async with lock:
        try:
            if path.is_file() and path.stat().st_size > 0:
                return path
            if video_cached.is_file() and video_cached.stat().st_size > 0:
                return video_cached

            async with _get_post_thumb_sem():
                connection = await client()
                target_peer = peer_id(norm_chat_id)
                message = None
                for attempt in range(2):
                    try:
                        message = await connection.get_messages(target_peer, ids=norm_msg_id)
                        break
                    except FloodWaitError as exc:
                        if attempt == 0 and int(getattr(exc, "seconds", 0) or 0) <= 15:
                            await asyncio.sleep(int(exc.seconds) + 0.5)
                            continue
                        raise
                    except ValueError:
                        # Ak peer nie je v entity cache, skúsime ho načítať cez get_entity.
                        if attempt == 0:
                            try:
                                target_peer = await connection.get_entity(target_peer)
                                continue
                            except Exception:
                                pass
                        raise FileNotFoundError("kanál nie je dostupný v relácii") from None

                if not message:
                    raise FileNotFoundError("správa sa nenašla")

                path.parent.mkdir(parents=True, exist_ok=True)
                task_tag = id(asyncio.current_task())
                part = path.with_name(f"{path.stem}.{task_tag}.part")
                saved = None
                try:
                    photo = getattr(message, "photo", None)
                    document = getattr(message, "document", None)
                    webpage = getattr(getattr(message, "media", None), "webpage", None)

                    if photo is not None:
                        chosen = _pick_best_thumb(getattr(photo, "sizes", None), max_edge=1280)
                        if chosen is not None:
                            saved = await connection.download_media(message, file=str(part), thumb=chosen)
                        if not saved:
                            saved = await connection.download_media(message, file=str(part))
                    elif document is not None:
                        chosen = _pick_best_thumb(getattr(document, "thumbs", []))
                        if chosen is not None:
                            saved = await connection.download_media(message, file=str(part), thumb=chosen)
                        elif str(getattr(document, "mime_type", "") or "").lower().startswith("video/"):
                            from .telegram_rethumb import repair_thumbnail
                            await repair_thumbnail(norm_chat_id, norm_msg_id, 2.0)
                            if video_cached.is_file() and video_cached.stat().st_size > 0:
                                return video_cached
                    elif webpage is not None and getattr(webpage, "photo", None) is not None:
                        saved = await connection.download_media(webpage.photo, file=str(part))
                    else:
                        raise FileNotFoundError("príspevok nemá náhľadový obrázok")

                    if not saved:
                        raise FileNotFoundError("náhľad príspevku sa nepodarilo stiahnuť")
                    Path(saved).replace(path)
                    return path
                finally:
                    with suppress(OSError):
                        if part.exists():
                            part.unlink()
        finally:
            if not lock.locked():
                _POST_THUMB_LOCKS.pop(key, None)
