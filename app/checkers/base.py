from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional
import time
import httpx
import re

@dataclass
class CheckResult:
    server: str
    direct_url: Optional[str] = None
    quality: Optional[str] = None
    size_bytes: Optional[int] = None
    error: Optional[str] = None
    duration_ms: int = 0

class BaseChecker(ABC):
    name: str = "base"

    def __init__(self, timeout: float = 15.0):
        self.timeout = timeout

    @abstractmethod
    async def check(self, embed_url: str) -> CheckResult:
        """Extrahuj direct URL z embed URL."""
        pass

    async def get_size(self, url: str, client: httpx.AsyncClient) -> Optional[int]:
        """HEAD request pre content-length."""
        try:
            r = await client.head(url, timeout=self.timeout, follow_redirects=True)
            cl = r.headers.get("content-length")
            if cl and cl.isdigit():
                return int(cl)
            # fallback na Range: bytes=0-0 GET ak HEAD nevrátil content-length
            if r.status_code != 200 or not cl:
                r_get = await client.get(url, headers={"Range": "bytes=0-0"}, timeout=self.timeout, follow_redirects=True)
                cr = r_get.headers.get("content-range")
                if cr:
                    m = re.search(r'/(\d+)$', cr)
                    if m:
                        return int(m.group(1))
            return None
        except Exception:
            return None

    async def get_quality(self, url: str) -> Optional[str]:
        """Odhadni kvalitu z URL alebo playlistu."""
        m = re.search(r'(\d{3,4})[pP]', url)
        if m:
            return m.group(1) + "p"
        if ".m3u8" in url:
            return "HLS"
        return None
