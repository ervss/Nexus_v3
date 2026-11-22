import asyncio
import re
from typing import Dict, List, Optional
from urllib.parse import urlparse

from .base import CheckResult
from .streamtape import StreamtapeChecker
from .voe import VoeChecker
from .doodstream import DoodstreamChecker
from .playmogo import PlaymogoChecker

class CheckerOrchestrator:
    def __init__(self):
        self.streamtape = StreamtapeChecker()
        self.voe = VoeChecker()
        self.doodstream = DoodstreamChecker()
        self.playmogo = PlaymogoChecker()

        # Semafory podľa špecifikácie
        self.layer1_sem = asyncio.Semaphore(20)  # max 20 paralelných statických requestov
        self.layer2_sem = asyncio.Semaphore(3)   # max 3 headless Playwright workery

    def classify_server(self, embed_url: str) -> str:
        domain = urlparse(embed_url).netloc.lower()
        if "streamtape" in domain:
            return "streamtape"
        elif "voe" in domain or "voe.sx" in domain:
            return "voe"
        elif "dood" in domain:
            return "doodstream"
        elif "playmogo" in domain:
            return "playmogo"
        elif any(k in domain for k in ["hgcloud", "byse", "bysezejataos"]):
            return "mirror"
        return "unknown"

    async def check_url(self, embed_url: str) -> CheckResult:
        server_type = self.classify_server(embed_url)

        # LAYER 3: Skip SPA zrkadlá
        if server_type == "mirror":
            domain = urlparse(embed_url).netloc
            return CheckResult(
                server=domain,
                error="Not supported (mirror VOE)",
                duration_ms=0
            )

        # LAYER 1: Statické extractory (paralelné, max 20)
        if server_type == "streamtape":
            async with self.layer1_sem:
                return await self.streamtape.check(embed_url)
        elif server_type == "voe":
            async with self.layer1_sem:
                return await self.voe.check(embed_url)
        elif server_type == "doodstream":
            async with self.layer1_sem:
                return await self.doodstream.check(embed_url)

        # LAYER 2: Headless browser (Playwright, max 3)
        elif server_type == "playmogo":
            async with self.layer2_sem:
                return await self.playmogo.check(embed_url)

        return CheckResult(
            server=urlparse(embed_url).netloc or "Unknown",
            error=f"Unsupported server: {embed_url}",
            duration_ms=0
        )

    async def check_batch(self, embed_urls: List[str]) -> List[CheckResult]:
        tasks = [self.check_url(u) for u in embed_urls]
        return await asyncio.gather(*tasks)

orchestrator = CheckerOrchestrator()
