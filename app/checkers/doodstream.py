import time
import re
import httpx
from typing import Optional
from .base import BaseChecker, CheckResult

class DoodstreamChecker(BaseChecker):
    name: str = "Doodstream"

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
                pass_match = re.search(r"/(?:pass_md5)/([a-zA-Z0-9_\-]+)", text)
                if not pass_match:
                    return CheckResult(
                        server=self.name,
                        error="pass_md5 token not found",
                        duration_ms=int((time.time() - start_time) * 1000)
                    )

                token = pass_match.group(1)
                domain = re.search(r"https?://([^/]+)", embed_url).group(1)
                pass_url = f"https://{domain}/pass_md5/{token}"
                pass_resp = await client.get(pass_url, headers={"Referer": embed_url})
                if pass_resp.status_code != 200:
                    return CheckResult(
                        server=self.name,
                        error=f"pass_md5 failed with {pass_resp.status_code}",
                        duration_ms=int((time.time() - start_time) * 1000)
                    )

                raw_direct = pass_resp.text.strip()
                # Doodstream appenduje token / náhodný string
                direct_url = f"{raw_direct}1234567890?token={token}"
                size_bytes = await self.get_size(direct_url, client)

                return CheckResult(
                    server=self.name,
                    direct_url=direct_url,
                    quality="720p",
                    size_bytes=size_bytes,
                    duration_ms=int((time.time() - start_time) * 1000)
                )

            except Exception as e:
                return CheckResult(
                    server=self.name,
                    error=str(e),
                    duration_ms=int((time.time() - start_time) * 1000)
                )
