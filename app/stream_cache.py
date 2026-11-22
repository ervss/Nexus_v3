import os
import hashlib
import time
import asyncio
import logging
import uuid
from pathlib import Path
from typing import Optional, Tuple
import aiofiles

logger = logging.getLogger("nexus.stream_cache")

# Default Cache Directory inside temp or workspace
CACHE_DIR = Path(os.environ.get("NEXUS_STREAM_CACHE_DIR", Path(__file__).resolve().parent.parent / ".stream_cache"))
MAX_CACHE_BYTES = int(os.environ.get("NEXUS_STREAM_CACHE_MAX_BYTES", 30 * 1024 * 1024 * 1024)) # 30 GB default

class StreamLruCache:
    def __init__(self, cache_dir: Path = CACHE_DIR, max_bytes: int = MAX_CACHE_BYTES):
        self.cache_dir = Path(cache_dir)
        self.max_bytes = max_bytes
        self.lock = asyncio.Lock()
        self._ensure_dir()

    def _ensure_dir(self):
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _get_chunk_key(self, url: str, start: int, end: int) -> str:
        # Normalize url query tokens if needed, but hash keeps raw URL
        normalized = url # Query can identify a different representation or resource.
        h = hashlib.sha256(f"{normalized}:{start}-{end}".encode()).hexdigest()
        return h

    def get_chunk_path(self, url: str, start: int, end: int) -> Path:
        key = self._get_chunk_key(url, start, end)
        return self.cache_dir / f"{key}.part"

    async def get_chunk(self, url: str, start: int, end: int) -> Optional[bytes]:
        path = self.get_chunk_path(url, start, end)
        if not path.is_file():
            return None
        try:
            # Update atime for LRU
            os.utime(path, None)
            async with aiofiles.open(path, "rb") as f:
                data = await f.read()
            expected_len = end - start + 1
            if len(data) == expected_len:
                return data
            else:
                path.unlink(missing_ok=True)
                return None
        except Exception as e:
            logger.debug(f"[LRU Cache] read failed: {e}")
            return None

    async def put_chunk(self, url: str, start: int, end: int, data: bytes):
        path = self.get_chunk_path(url, start, end)
        try:
            tmp_path = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
            async with aiofiles.open(tmp_path, "wb") as f:
                await f.write(data)
            tmp_path.replace(path)
            # Coalesce concurrent writes into one directory scan.
            if not getattr(self, "_eviction", None) or self._eviction.done():
                self._eviction = asyncio.create_task(self._evict_if_needed())
        except Exception as e:
            logger.debug(f"[LRU Cache] write failed: {e}")
        finally:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass

    async def _evict_if_needed(self):
        async with self.lock:
            try:
                files = list(self.cache_dir.glob("*.part"))
                total_size = sum(f.stat().st_size for f in files)
                if total_size <= self.max_bytes:
                    return

                # Sort by mtime/atime ascending (oldest first)
                files.sort(key=lambda f: f.stat().st_atime)
                for f in files:
                    if total_size <= self.max_bytes * 0.85: # Trim to 85% watermark
                        break
                    sz = f.stat().st_size
                    try:
                        f.unlink(missing_ok=True)
                        total_size -= sz
                    except Exception:
                        pass
            except Exception as e:
                logger.debug(f"[LRU Cache] eviction error: {e}")

stream_cache = StreamLruCache()
