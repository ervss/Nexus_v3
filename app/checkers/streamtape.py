import time
import re
import httpx
from typing import Optional
from .base import BaseChecker, CheckResult
from app.extractors.streamtape import StreamtapeExtractor

class StreamtapeChecker(BaseChecker):
    name: str = "Streamtape"

    def __init__(self, timeout: float = 15.0):
        super().__init__(timeout)
        self.extractor = StreamtapeExtractor()

    async def check(self, embed_url: str) -> CheckResult:
        start_time = time.time()
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://internetchicks.com/",
        }

        async with httpx.AsyncClient(headers=headers, timeout=self.timeout, follow_redirects=True) as client:
            try:
                resp = await client.get(embed_url)
                if resp.status_code != 200:
                    return CheckResult(
                        server=self.name,
                        error=f"HTTP {resp.status_code}",
                        duration_ms=int((time.time() - start_time) * 1000)
                    )

                text = resp.text
                stream_url: Optional[str] = None

                # 1. botlink parser
                bot_match = re.search(
                    r"document\.getElementById\(['\"]botlink['\"]\)\.innerHTML\s*=\s*(['\"][^'\"]+['\"])\s*\+\s*\((['\"][^'\"]+['\"])\)((?:\.substring\(\d+\))+)",
                    text, re.IGNORECASE
                )
                if bot_match:
                    prefix = bot_match.group(1).strip("'\"")
                    path = bot_match.group(2).strip("'\"")
                    for sub in re.finditer(r"\.substring\((\d+)\)", bot_match.group(3)):
                        path = path[int(sub.group(1)):]
                    full = f"{prefix}{path}".strip()
                    if full.startswith("//"):
                        full = f"https:{full}"
                    elif full.startswith("/"):
                        full = f"https://{full.lstrip('/')}"
                    if "streamtape.com/get_video" in full:
                        stream_url = full if "stream=1" in full else f"{full}&stream=1"

                # 2. robotlink parser fallback
                if not stream_url:
                    robot_match = re.search(
                        r"document\.getElementById\(['\"]robotlink['\"]\)\.innerHTML\s*=\s*(['\"][^'\"]+['\"])\s*\+\s*\((['\"][^'\"]+['\"])\)((?:\.substring\(\d+\))+)",
                        text, re.IGNORECASE
                    )
                    if robot_match:
                        prefix = robot_match.group(1).strip("'\"")
                        path = robot_match.group(2).strip("'\"")
                        for sub in re.finditer(r"\.substring\((\d+)\)", robot_match.group(3)):
                            path = path[int(sub.group(1)):]
                        full = f"{prefix}{path}".strip()
                        if full.startswith("//"):
                            full = f"https:{full}"
                        elif full.startswith("/"):
                            full = f"https://{full.lstrip('/')}"
                        if "streamtape.com/get_video" in full:
                            stream_url = full if "stream=1" in full else f"{full}&stream=1"

                # 3. Fallback na existujúci extractor z app/extractors/streamtape.py
                if not stream_url:
                    extracted = await self.extractor.extract(embed_url)
                    if extracted and extracted.get("stream_url"):
                        stream_url = extracted["stream_url"]
                        if "stream=1" not in stream_url:
                            stream_url = f"{stream_url}&stream=1"

                if not stream_url:
                    return CheckResult(
                        server=self.name,
                        error="Stream URL not found in HTML",
                        duration_ms=int((time.time() - start_time) * 1000)
                    )

                # Získaj veľkosť cez probe
                size_bytes = await self.get_size(stream_url, client)
                quality = "1080p" if (size_bytes and size_bytes > 400 * 1024 * 1024) else "720p"

                return CheckResult(
                    server=self.name,
                    direct_url=stream_url,
                    quality=quality,
                    size_bytes=size_bytes,
                    duration_ms=int((time.time() - start_time) * 1000)
                )

            except Exception as e:
                return CheckResult(
                    server=self.name,
                    error=str(e),
                    duration_ms=int((time.time() - start_time) * 1000)
                )
