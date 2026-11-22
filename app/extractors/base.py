from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional, Tuple


async def ntc_get(url: str, domain: str | None = None, priority: str = "normal",
                  deadline: float = 28.0, headers: dict | None = None,
                  sticky_key: str | None = None, **kwargs) -> str:
    from app.ntc import ntc
    return await ntc.fetch(
        url, domain=domain, priority=priority, deadline=deadline,
        headers=headers, sticky_key=sticky_key, **kwargs,
    )


async def ntc_get_many(urls: list[str], domain: str | None = None,
                       concurrency: int = 6, deadline: float = 28.0) -> list[str | None]:
    sem = asyncio.Semaphore(concurrency)
    async def one(u: str):
        async with sem:
            try:
                return await ntc_get(u, domain=domain, deadline=deadline)
            except Exception:
                return None
    return await asyncio.gather(*(one(u) for u in urls))


def ntc_get_sync(url: str, domain: str | None = None, **kwargs) -> str:
    return asyncio.run(ntc_get(url, domain=domain, **kwargs))


class VideoExtractor(ABC):
    """
    Abstract base class for all site-specific extractors.
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Name of the extractor (e.g. 'Eporner', 'XVideos')"""
        pass

    @abstractmethod
    def can_handle(self, url: str) -> bool:
        """Returns True if this extractor can handle the given URL."""
        pass

    @abstractmethod
    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        """
        Extracts metadata and stream URL.
        Returns a dictionary or None if extraction failed.
        
        Expected Return Shape:
        {
            "id": str,          # Source ID
            "title": str,
            "description": str,
            "thumbnail": str,
            "duration": int,    # Seconds
            "stream_url": str,  # Direct playable URL (mp4/m3u8)
            "width": int,
            "height": int,
            "tags": list,
            "uploader": str,
            "is_hls": bool
        }
        """
        pass
