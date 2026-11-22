"""Vysokorýchlostné inteligentné náhľady: paralelné Range requesty + dekódovanie v pamäti.

Princíp
-------
* Z videa sa nikdy nesťahuje celý súbor. ``RangeFile`` je file-like objekt nad HTTP Range
  požiadavkami; PyAV (libav) cez neho seekuje (moov, keyframe) a čítajú sa len potrebné
  bloky. Chýbajúce bloky sa sťahujú paralelne (8-32 spojení na video).
* Jedno zdieľané HTTP/2 spojenie-pool (curl_cffi s TLS impersonáciou, fallback httpx+h2)
  beží na vlastnom event-loope, takže neblokuje FastAPI.
* Bloky sa cachujú v pamäti (LRU) a hotové snímky aj na disku.
* 429/503: rastúci cooldown pre daný host, rešpektovanie Retry-After a konečný
  rozpočet pokusov. Bunkr zdieľa limit dvoch spojení aj s FFmpeg.
* Stav úloh (pending/running/done/failed) je v SQLite (``thumb_jobs.db``) pre resume po páde.

Nastavenia (env): NEXUS_FAST_THUMB, NEXUS_THUMB_RANGE_CONNS (8-32, def. 16),
NEXUS_THUMB_WORKERS (štart, def. 32), NEXUS_THUMB_WORKERS_MAX (def. 64),
NEXUS_THUMB_HOST_CONNS, NEXUS_THUMB_CACHE_MB, NEXUS_THUMB_IMPERSONATE,
NEXUS_THUMB_CACHE_DIR, NEXUS_THUMB_JOBS_DB.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import os
import random
import re
import shutil
import sqlite3
import threading
import time
from collections import OrderedDict, deque
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Optional
from urllib.parse import parse_qsl, urlsplit

log = logging.getLogger("nexus.fast_thumb")

BLOCK = 256 * 1024
DEFAULT_FRACTIONS = (0.15, 0.25, 0.35, 0.45, 0.55)
THROTTLE_STATUSES = {408, 425, 429}
MAX_THROTTLE_ATTEMPTS = 6
MAX_NET_ATTEMPTS = 3
FRAME_CACHE_TTL = 30 * 86400
_VOLATILE_QS = {"token", "ex", "exp", "expires", "expire", "signature", "sig", "st", "e", "hdnts",
                "hash", "md5", "t", "key-pair-id", "policy", "x-amz-signature", "x-amz-date",
                "x-amz-expires", "x-amz-credential", "x-amz-security-token"}


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        value = int(os.environ.get(name, default))
    except (TypeError, ValueError):
        value = default
    return max(lo, min(hi, value))


def enabled() -> bool:
    return os.environ.get("NEXUS_FAST_THUMB", "1").strip().lower() not in {"0", "false", "off", "no"}


def range_conns() -> int:
    return _env_int("NEXUS_THUMB_RANGE_CONNS", 16, 8, 32)


class FastThumbError(Exception):
    """Základ pre chyby rýchlej cesty."""


class FastThumbUnsupported(FastThumbError):
    """Zdroj sa nedá čítať cez Range (HLS, bez Range, bez videa...). Použi ffmpeg."""


class FastThumbRefused(FastThumbError):
    def __init__(self, status: int):
        super().__init__(f"HTTP {status}")
        self.status = status


class FastThumbThrottled(FastThumbError):
    def __init__(self, status: int, retry_after: float = 0):
        super().__init__(f"HTTP {status}: CDN je preťažené")
        self.status = status
        self.retry_after = retry_after


def eligible(url: str) -> bool:
    if not enabled():
        return False
    parts = urlsplit(url or "")
    if parts.scheme not in ("http", "https"):
        return False
    return not parts.path.lower().endswith((".m3u8", ".mpd", ".ts", ".html", ".php"))


# --------------------------------------------------------------------------- metriky
class _Metrics:
    def __init__(self):
        self.bytes_total = 0
        self.requests = 0
        self.throttled = 0
        self.errors = 0
        self.active_conns = 0
        self.peak_conns = 0
        self.active_videos = 0
        self._lock = threading.Lock()
        self._last = (time.monotonic(), 0)
        self._speed = 0.0

    def conn_enter(self):
        with self._lock:
            self.active_conns += 1
            self.requests += 1
            self.peak_conns = max(self.peak_conns, self.active_conns)

    def conn_exit(self):
        with self._lock:
            self.active_conns -= 1

    def speed(self) -> float:
        now = time.monotonic()
        t0, b0 = self._last
        if now - t0 >= 0.5:
            inst = (self.bytes_total - b0) / (now - t0)
            self._speed = inst if self._speed == 0 else 0.5 * self._speed + 0.5 * inst
            if inst == 0 and self.active_conns == 0:
                self._speed = 0.0
            self._last = (now, self.bytes_total)
        return self._speed

    def snapshot(self) -> dict:
        speed = self.speed()
        return {
            "speed_bps": round(speed),
            "speed_mbps": round(speed * 8 / 1_000_000, 1),
            "speed_mb_s": round(speed / 1_000_000, 2),
            "active_connections": self.active_conns,
            "peak_connections": self.peak_conns,
            "active_videos": self.active_videos,
            "bytes_total": self.bytes_total,
            "requests": self.requests,
            "throttled": self.throttled,
            "errors": self.errors,
            "hosts": {h: {"limit": s.limiter.limit, "cooldown": max(0.0, round(s.cooldown_until - time.monotonic(), 1))}
                      for h, s in list(NET.hosts.items())[:12]},
        }

    def reset(self):
        self.bytes_total = self.requests = self.throttled = self.errors = self.peak_conns = 0
        self._last = (time.monotonic(), 0)
        self._speed = 0.0


METRICS = _Metrics()


def metrics_snapshot() -> dict:
    return METRICS.snapshot()


# --------------------------------------------------------------------------- limitery
class AdaptiveLimiter:
    """Async limiter s meniteľným limitom. Použitie: ``async with limiter:``.

    Rastie po sérii úspechov; ``penalize`` je len núdzová brzda (polovica limitu).
    """

    def __init__(self, start: int, maximum: int, minimum: int = 1, grow_every: int = 4, grow_step: int = 2):
        self.limit = start
        self.max = max(maximum, start)
        self.min = minimum
        self.active = 0
        self._waiters: deque = deque()
        self._streak = 0
        self._grow_every = grow_every
        self._grow_step = grow_step

    async def acquire(self):
        if self.active < self.limit and not self._waiters:
            self.active += 1
            return
        fut = asyncio.get_running_loop().create_future()
        self._waiters.append(fut)
        try:
            await fut
        except BaseException:
            if fut.done() and not fut.cancelled():
                self.release()
            else:
                try:
                    self._waiters.remove(fut)
                except ValueError:
                    pass
            raise

    def release(self):
        self.active -= 1
        self._wake()

    def _wake(self):
        while self._waiters and self.active < self.limit:
            fut = self._waiters.popleft()
            if not fut.done():
                self.active += 1
                fut.set_result(None)

    def success(self):
        self._streak += 1
        if self._streak >= self._grow_every and self.limit < self.max:
            self._streak = 0
            self.limit = min(self.max, self.limit + self._grow_step)
            self._wake()

    def penalize(self):
        self._streak = 0
        self.limit = max(self.min, self.limit // 2)

    async def __aenter__(self):
        await self.acquire()
        return self

    async def __aexit__(self, exc_type, exc, tb):
        self.release()
        if exc_type is None:
            self.success()
        return False


class WorkerLimiter(AdaptiveLimiter):
    """Počet súčasne spracúvaných videí: štart 32, dynamicky až 64 (alebo pevný ``fixed``)."""

    def __init__(self, fixed: Optional[int] = None):
        if fixed:
            super().__init__(fixed, fixed)
        else:
            start = _env_int("NEXUS_THUMB_WORKERS", 32, 16, 256)
            super().__init__(start, _env_int("NEXUS_THUMB_WORKERS_MAX", 64, start, 512))


class _HostState:
    def __init__(self):
        cap = _env_int("NEXUS_THUMB_HOST_CONNS", 128, 8, 1024)
        self.limiter = AdaptiveLimiter(cap, cap, minimum=4, grow_every=8, grow_step=8)
        self.cooldown_until = 0.0


# --------------------------------------------------------------------------- sieť
def _retry_after(headers) -> Optional[float]:
    try:
        value = headers.get("retry-after")
        if value is None:
            return None
        try:
            return max(0.0, float(value))
        except ValueError:
            from email.utils import parsedate_to_datetime
            return max(0.0, parsedate_to_datetime(value).timestamp() - time.time())
    except (TypeError, ValueError):
        return None


def _total_from_range(value: Optional[str]) -> Optional[int]:
    match = re.search(r"/(\d+)\s*$", value or "")
    return int(match.group(1)) if match else None


class _Net:
    """Zdieľaný HTTP klient na vlastnom event-loope (connection pooling + HTTP/2)."""

    def __init__(self):
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._start_lock = threading.Lock()
        self._session = None
        self._kind = ""
        self._impersonating = False
        self.hosts: dict[str, _HostState] = {}

    def start(self):
        with self._start_lock:
            if self._loop is not None:
                return
            loop = asyncio.new_event_loop()
            ready = threading.Event()

            def run():
                asyncio.set_event_loop(loop)
                ready.set()
                loop.run_forever()

            threading.Thread(target=run, daemon=True, name="nexus-thumb-net").start()
            ready.wait()
            self._loop = loop

    def submit(self, coro) -> Future:
        self.start()
        return asyncio.run_coroutine_threadsafe(coro, self._loop)

    async def _ensure_session(self):
        if self._session is not None:
            return self._session
        impersonate = os.environ.get("NEXUS_THUMB_IMPERSONATE", "chrome").strip() or None
        try:
            from curl_cffi.requests import AsyncSession
            kwargs = {"max_clients": 1024}
            if impersonate:
                kwargs["impersonate"] = impersonate
            self._session = AsyncSession(**kwargs)
            self._kind = "curl_cffi"
            self._impersonating = bool(impersonate)
        except Exception as exc:
            log.info("curl_cffi nedostupné (%s), používam httpx+h2", exc)
            import httpx
            self._session = httpx.AsyncClient(
                http2=True, follow_redirects=True, timeout=30,
                limits=httpx.Limits(max_connections=1024, max_keepalive_connections=256, keepalive_expiry=30))
            self._kind = "httpx"
        return self._session

    def _host(self, url: str) -> _HostState:
        key = urlsplit(url).netloc.lower()
        state = self.hosts.get(key)
        if state is None:
            state = self.hosts[key] = _HostState()
            host_name = (urlsplit(url).hostname or '').lower()
            if host_name.endswith(('.cdn.cr', '.scdn.st')):
                state.limiter = AdaptiveLimiter(2, 2, minimum=1)
            elif host_name.endswith('.gofile.io') or host_name == 'gofile.io':
                state.limiter = AdaptiveLimiter(4, 6, minimum=2)
        return state

    async def _request(self, url: str, headers: dict, start: int, end: int):
        from app.streaming.playback_control import control
        async with control.background(url, lane="network"):
            result = await self._request_admitted(url, headers, start, end)
            control.cooldown(url, result[0], result[3] or 30)
            return result

    async def _request_admitted(self, url: str, headers: dict, start: int, end: int):
        session = await self._ensure_session()
        hdrs = dict(headers)
        if self._impersonating and "gofile.io" not in url.lower():
            hdrs.pop("User-Agent", None)
        hdrs["Range"] = f"bytes={start}-{end}"
        want = end - start + 1
        if self._kind == "curl_cffi":
            resp = await session.get(url, headers=hdrs, stream=True, timeout=30, allow_redirects=True)
            try:
                if resp.status_code != 206:
                    return resp.status_code, b"", resp.headers.get("content-range"), _retry_after(resp.headers)
                buf = bytearray()
                async for chunk in resp.aiter_content():
                    buf += chunk
                    METRICS.bytes_total += len(chunk)
                    if len(buf) >= want:
                        break
                return 206, bytes(buf[:want]), resp.headers.get("content-range"), None
            finally:
                await resp.aclose()
        async with session.stream("GET", url, headers=hdrs) as resp:
            if resp.status_code != 206:
                return resp.status_code, b"", resp.headers.get("content-range"), _retry_after(resp.headers)
            buf = bytearray()
            async for chunk in resp.aiter_bytes():
                buf += chunk
                METRICS.bytes_total += len(chunk)
                if len(buf) >= want:
                    break
            return 206, bytes(buf[:want]), resp.headers.get("content-range"), None

    async def get_range(self, url: str, headers: dict, start: int, end: int):
        """Vráti (data, total_size). Throttling rieši lokálne pre daný host."""
        host = self._host(url)
        throttles = 0
        net_errors = 0
        while True:
            await host.limiter.acquire()
            wait = host.cooldown_until - time.monotonic()
            if wait > 0:
                host.limiter.release()
                await asyncio.sleep(wait)
                continue
            METRICS.conn_enter()
            try:
                status, data, content_range, retry_after = await self._request(url, headers, start, end)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                status, data, content_range, retry_after = 0, b"", None, None
                err = exc
            finally:
                METRICS.conn_exit()
                host.limiter.release()

            if status == 206:
                host.limiter.success()
                return data, _total_from_range(content_range)
            if status == 200:
                raise FastThumbUnsupported("Server ignoruje Range")
            if status == 416:
                return b"", _total_from_range(content_range)
            if status == 0:
                METRICS.errors += 1
                net_errors += 1
                if net_errors >= MAX_NET_ATTEMPTS:
                    raise FastThumbError(f"Sieťová chyba: {type(err).__name__}: {err}")
                continue
            if status in THROTTLE_STATUSES or status >= 500:
                throttles += 1
                METRICS.throttled += 1
                cooldown = retry_after if retry_after else min(120.0, 2 ** throttles + random.random())
                from app.streaming.playback_control import control
                control.cooldown(url, status, cooldown)
                host.cooldown_until = max(host.cooldown_until, time.monotonic() + max(0.5, cooldown))
                host.limiter.penalize()
                if throttles >= 4:
                    raise FastThumbThrottled(status, max(0, host.cooldown_until - time.monotonic()))
                continue
            raise FastThumbRefused(status)

    async def acquire_decoder(self, url):
        host = self._host(url)
        while True:
            await host.limiter.acquire()
            wait = host.cooldown_until - time.monotonic()
            if wait <= 0:
                return
            host.limiter.release()
            await asyncio.sleep(wait)

    async def release_decoder(self, url):
        self._host(url).limiter.release()


NET = _Net()


# --------------------------------------------------------------------------- cache blokov
class _BlockCache:
    def __init__(self):
        self._data: OrderedDict = OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()
        self.sizes: OrderedDict = OrderedDict()

    @property
    def budget(self) -> int:
        return _env_int("NEXUS_THUMB_CACHE_MB", 768, 16, 16384) * 1024 * 1024

    def get(self, key):
        with self._lock:
            value = self._data.get(key)
            if value is not None:
                self._data.move_to_end(key)
            return value

    def put(self, key, value: bytes):
        with self._lock:
            old = self._data.pop(key, None)
            if old is not None:
                self._bytes -= len(old)
            self._data[key] = value
            self._bytes += len(value)
            budget = self.budget
            while self._bytes > budget and self._data:
                _, evicted = self._data.popitem(last=False)
                self._bytes -= len(evicted)

    def set_size(self, key, size: int):
        with self._lock:
            self.sizes[key] = size
            while len(self.sizes) > 8192:
                self.sizes.popitem(last=False)

    def get_size(self, key) -> Optional[int]:
        with self._lock:
            return self.sizes.get(key)

    def clear(self):
        with self._lock:
            self._data.clear()
            self.sizes.clear()
            self._bytes = 0


CACHE = _BlockCache()


def cache_key(url: str) -> str:
    parts = urlsplit(url)
    query = sorted((k, v) for k, v in parse_qsl(parts.query) if k.lower() not in _VOLATILE_QS)
    return f"{parts.netloc.lower()}{parts.path}?{'&'.join(f'{k}={v}' for k, v in query)}"


class RangeSource:
    """Zdieľaný zdroj blokov pre jedno video (viac sond naraz, dedupe in-flight požiadaviek)."""

    def __init__(self, url: str, headers: dict):
        self.url = url
        self.headers = dict(headers)
        self.key = cache_key(url)
        self.size: Optional[int] = CACHE.get_size(self.key)
        self._lock = threading.Lock()
        self._inflight: dict[int, Future] = {}
        self._sem: Optional[asyncio.Semaphore] = None

    async def _fetch(self, index: int) -> bytes:
        if self._sem is None:
            self._sem = asyncio.Semaphore(range_conns())
        start = index * BLOCK
        end = start + BLOCK - 1
        if self.size is not None:
            if start >= self.size:
                return b""
            end = min(end, self.size - 1)
        async with self._sem:
            data, total = await NET.get_range(self.url, self.headers, start, end)
        if total:
            self.size = total
            CACHE.set_size(self.key, total)
        return data

    def block(self, index: int) -> Future:
        data = CACHE.get((self.key, index))
        if data is not None:
            done: Future = Future()
            done.set_result(data)
            return done
        with self._lock:
            fut = self._inflight.get(index)
            if fut is None:
                fut = NET.submit(self._fetch(index))
                self._inflight[index] = fut
                fut.add_done_callback(lambda f, i=index: self._finish(i, f))
        return fut

    def _finish(self, index: int, fut: Future):
        if not fut.cancelled() and fut.exception() is None and fut.result():
            CACHE.put((self.key, index), fut.result())
        with self._lock:
            self._inflight.pop(index, None)

    def open(self, timeout: float = 90.0):
        if self.size is None:
            self.block(0).result(timeout)
            self.size = self.size or CACHE.get_size(self.key)
        if not self.size:
            raise FastThumbUnsupported("Neznáma veľkosť súboru")

    def prefetch(self, timeout: float = 90.0):
        """Predhreje začiatok a koniec súboru (faststart alebo koncový moov)."""
        self.open(timeout)
        last = (self.size - 1) // BLOCK
        futures = [self.block(i) for i in {0, last, max(0, last - 1)}]
        for fut in futures:
            fut.result(timeout)

    def read_timeout(self) -> float:
        return float(_env_int("NEXUS_THUMB_READ_TIMEOUT", 60, 5, 600))


class RangeFile(io.RawIOBase):
    """File-like objekt nad ``RangeSource`` s adaptívnym read-ahead (paralelné bloky)."""

    def __init__(self, source: RangeSource):
        super().__init__()
        self.source = source
        self.pos = 0
        self._ra = 2
        self._last_end = -1
        self.error: Optional[BaseException] = None

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        size = self.source.size or 0
        if whence & 0x10000:  # AVSEEK_SIZE
            return size
        if whence == 0:
            target = offset
        elif whence == 1:
            target = self.pos + offset
        else:
            target = size + offset
        self.pos = max(0, target)
        return self.pos

    def read(self, n=-1):
        size = self.source.size or 0
        if n is None or n < 0:
            n = max(0, size - self.pos)
        if n == 0 or self.pos >= size:
            return b""
        n = min(n, size - self.pos)
        first = self.pos // BLOCK
        last = (self.pos + n - 1) // BLOCK
        top = (size - 1) // BLOCK
        sequential = self.pos == self._last_end
        needed = {i: self.source.block(i) for i in range(first, last + 1)}
        missed = any(not f.done() for f in needed.values())
        if missed:
            max_ra = max(4, range_conns() // 2)
            self._ra = min(self._ra * 2, max_ra) if sequential else 2
        ahead_to = min(top, last + (self._ra if missed else 0))
        for i in range(last + 1, ahead_to + 1):
            self.source.block(i)
        out = bytearray()
        pos = self.pos
        timeout = self.source.read_timeout()
        try:
            for i in range(first, last + 1):
                chunk = needed[i].result(timeout)[pos - i * BLOCK: pos - i * BLOCK + (n - len(out))]
                if not chunk:
                    break
                out += chunk
                pos += len(chunk)
        except BaseException as exc:
            self.error = exc
            raise OSError(str(exc)) from exc
        self.pos = pos
        self._last_end = pos
        return bytes(out)

    def readinto(self, buffer):
        data = self.read(len(buffer))
        buffer[:len(data)] = data
        return len(data)


# --------------------------------------------------------------------------- dekódovanie
_POOL: Optional[ThreadPoolExecutor] = None
_POOL_LOCK = threading.Lock()


def _pool() -> ThreadPoolExecutor:
    global _POOL
    with _POOL_LOCK:
        if _POOL is None:
            _POOL = ThreadPoolExecutor(max_workers=_env_int("NEXUS_THUMB_DECODE_THREADS", 384, 16, 2048),
                                       thread_name_prefix="nexus-thumb")
        return _POOL


def _frame_to_image(frame):
    width, height = frame.width, frame.height
    scale = min(1.0, 1280 / width, 720 / height)
    new_w = max(2, int(width * scale) // 2 * 2)
    new_h = max(2, int(height * scale) // 2 * 2)
    return frame.reformat(width=new_w, height=new_h, format="rgb24").to_image()


def _probe(source: RangeSource, fraction: float, duration_hint: float, index: int, out_path: str) -> Optional[str]:
    import av
    handle = RangeFile(source)
    try:
        with av.open(handle, mode="r", buffer_size=BLOCK,
                     options={"probesize": "4194304", "analyzeduration": "2000000"}) as container:
            if not container.streams.video:
                raise FastThumbUnsupported("Bez video stopy")
            stream = container.streams.video[0]
            duration = (container.duration / 1_000_000) if container.duration else 0.0
            duration = duration or float(duration_hint or 0)
            target = duration * fraction if duration > 0 else (2.0, 6.0, 12.0, 20.0, 30.0)[min(index, 4)]
            container.seek(int(target * 1_000_000), backward=True, any_frame=False)
            for frame in container.decode(stream):
                _frame_to_image(frame).save(out_path, "JPEG", quality=90)
                return out_path
    except FastThumbError:
        raise
    except Exception as exc:
        if isinstance(handle.error, FastThumbError):
            raise handle.error
        log.debug("probe %.2f zlyhal: %s", fraction, exc)
    return None


def fractions_for(seek_frac: Optional[float] = None) -> tuple:
    if seek_frac is None:
        return DEFAULT_FRACTIONS
    first = min(0.55, max(0.15, float(seek_frac)))
    rest = [f for f in DEFAULT_FRACTIONS if abs(f - first) > 0.04]
    return (round(first, 3), *rest[:4])


def _frame_cache_dir() -> str:
    path = os.environ.get("NEXUS_THUMB_CACHE_DIR") or os.path.join("data", "thumb_frame_cache")
    os.makedirs(path, exist_ok=True)
    return path


def _frame_cache_path(key: str, fraction: float) -> str:
    digest = hashlib.sha1(key.encode()).hexdigest()
    return os.path.join(_frame_cache_dir(), f"{digest}_{int(round(fraction * 1000))}.jpg")


def prune_frame_cache():
    cutoff = time.time() - FRAME_CACHE_TTL
    try:
        for entry in os.scandir(_frame_cache_dir()):
            if entry.is_file() and entry.stat().st_mtime < cutoff:
                os.unlink(entry.path)
    except OSError:
        pass


async def extract_candidates(url: str, headers: dict, duration: float, fractions: tuple, tmp_dir: str) -> list:
    """Vráti cesty k JPEG kandidátom (v tmp_dir). Vyhodí FastThumbError pri neúspechu."""
    loop = asyncio.get_running_loop()
    key = cache_key(url)
    results: dict[int, str] = {}
    missing = []
    for idx, fraction in enumerate(fractions):
        cached = _frame_cache_path(key, fraction)
        if os.path.isfile(cached) and time.time() - os.path.getmtime(cached) < FRAME_CACHE_TTL:
            target = os.path.join(tmp_dir, f"fast_{idx}.jpg")
            shutil.copyfile(cached, target)
            results[idx] = target
        else:
            missing.append((idx, fraction))
    if missing:
        METRICS.active_videos += 1
        try:
            source = RangeSource(url, headers)
            await loop.run_in_executor(_pool(), source.open)
            outputs = await asyncio.gather(*[
                loop.run_in_executor(_pool(), _probe, source, fraction, duration, idx,
                                     os.path.join(tmp_dir, f"fast_{idx}.jpg"))
                for idx, fraction in missing], return_exceptions=True)
        finally:
            METRICS.active_videos -= 1
        first_error = None
        for (idx, fraction), out in zip(missing, outputs):
            if isinstance(out, BaseException):
                first_error = first_error or out
            elif out:
                results[idx] = out
                try:
                    tmp_cache = _frame_cache_path(key, fraction) + f".{os.getpid()}.tmp"
                    shutil.copyfile(out, tmp_cache)
                    os.replace(tmp_cache, _frame_cache_path(key, fraction))
                except OSError:
                    pass
        if not results:
            raise first_error if isinstance(first_error, FastThumbError) else FastThumbUnsupported("Žiadny snímok")
    return [results[i] for i in sorted(results)]


async def prefetch(url: str, headers: dict):
    """Neblokujúce predhriatie začiatku/konca súboru pre ďalšie videá vo fronte."""
    try:
        source = RangeSource(url, headers)
        await asyncio.get_running_loop().run_in_executor(_pool(), source.prefetch)
    except Exception:
        pass


async def prefetch_ahead(items: list, started_count, lookahead: int):
    """items: [(url, headers)] v poradí fronty. started_count(): koľko videí už začalo."""
    idx = 0
    tasks = set()
    try:
        while idx < len(items):
            if idx < started_count() + lookahead:
                url, headers = items[idx]
                task = asyncio.create_task(prefetch(url, headers))
                tasks.add(task)
                task.add_done_callback(tasks.discard)
                idx += 1
            else:
                await asyncio.sleep(0.05)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
    finally:
        for task in tasks:
            task.cancel()


# --------------------------------------------------------------------------- SQLite stav úloh
class JobStore:
    """Perzistentný stav úloh (pending/running/done/failed); chyby DB nikdy neblokujú prácu."""

    def __init__(self, path: Optional[str] = None):
        self.path = path or os.environ.get("NEXUS_THUMB_JOBS_DB") or os.path.join("data", "thumb_jobs.db")
        self._lock = threading.Lock()
        self._conn: Optional[sqlite3.Connection] = None

    def _db(self) -> sqlite3.Connection:
        if self._conn is None:
            os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
            conn = sqlite3.connect(self.path, check_same_thread=False, timeout=10)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("""CREATE TABLE IF NOT EXISTS thumb_jobs(
                video_id INTEGER PRIMARY KEY, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                error TEXT, updated REAL NOT NULL)""")
            conn.commit()
            self._conn = conn
        return self._conn

    def _run(self, sql: str, params=(), many: bool = False, fetch: bool = False):
        try:
            with self._lock:
                db = self._db()
                cur = db.executemany(sql, params) if many else db.execute(sql, params)
                rows = cur.fetchall() if fetch else None
                db.commit()
                return rows
        except Exception as exc:
            log.warning("thumb_jobs DB: %s", exc)
            return [] if fetch else None

    def enqueue(self, ids):
        now = time.time()
        self._run("""INSERT INTO thumb_jobs(video_id,state,updated) VALUES(?, 'pending', ?)
                     ON CONFLICT(video_id) DO UPDATE SET state='pending', error=NULL, updated=excluded.updated""",
                  [(int(i), now) for i in ids], many=True)

    def mark(self, video_id: int, state: str, error: Optional[str] = None):
        self._run("UPDATE thumb_jobs SET state=?, error=?, attempts=attempts+?, updated=? WHERE video_id=?",
                  (state, error, 1 if state in ("running", "failed") else 0, time.time(), int(video_id)))

    def recover(self) -> list:
        """Po páde: running -> pending; vráti všetky nedokončené ID."""
        self._run("UPDATE thumb_jobs SET state='pending' WHERE state='running'")
        rows = self._run("SELECT video_id FROM thumb_jobs WHERE state='pending' ORDER BY video_id DESC", fetch=True)
        return [r[0] for r in rows or []]

    def defer(self, video_id, error, delay=600):
        self._run("UPDATE thumb_jobs SET state='deferred', error=?, updated=? WHERE video_id=?",
                  (error, time.time() + delay, int(video_id)))

    def due(self):
        rows = self._run("SELECT video_id FROM thumb_jobs WHERE state='deferred' AND updated<=? ORDER BY video_id DESC LIMIT 100",
                         (time.time(),), fetch=True)
        return [row[0] for row in rows or []]

    def purge_done(self, older_than: float = 86400):
        self._run("DELETE FROM thumb_jobs WHERE state='done' AND updated<?", (time.time() - older_than,))

    def counts(self) -> dict:
        rows = self._run("SELECT state, COUNT(*) FROM thumb_jobs GROUP BY state", fetch=True)
        return {state: n for state, n in rows or []}

    def close(self):
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None


_STORE: Optional[JobStore] = None
_STORE_LOCK = threading.Lock()


def get_store() -> JobStore:
    global _STORE
    with _STORE_LOCK:
        if _STORE is None:
            _STORE = JobStore()
        return _STORE


def reset_store():
    global _STORE
    with _STORE_LOCK:
        if _STORE is not None:
            _STORE.close()
        _STORE = None
