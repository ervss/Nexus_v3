import time
import re
import json
import base64
import httpx
from typing import Optional
from .base import BaseChecker, CheckResult

class VoeChecker(BaseChecker):
    name: str = "VOE"

    def _extract_from_html(self, text: str) -> Optional[str]:
        # 1. Hľadaj JSON blok s obfuskáciou
        for match in re.finditer(r'<script\b[^>]*type=["\']application/json["\'][^>]*>([\s\S]*?)</script>', text, re.IGNORECASE):
            try:
                data = json.loads(match.group(1))
                if not isinstance(data, list) or not isinstance(data[0], str):
                    continue
                # ROT13
                rotated = "".join(
                    chr(ord(c) + (13 if c.lower() < 'n' else -13)) if c.isalpha() else c
                    for c in data[0]
                )
                rotated = re.sub(r'[@$]|\^\^|~@|%\?|\*~|!!|#&', '', rotated)
                decoded_bytes = base64.b64decode(rotated)
                shifted = bytes((b - 3) % 256 for b in decoded_bytes)[::-1]
                config = json.loads(base64.b64decode(shifted).decode('utf-8'))
                for val in [config.get("source"), config.get("fallback")]:
                    if isinstance(val, str) and val.startswith("http"):
                        return val
            except Exception:
                pass

        # 2. Fallback: priame m3u8 v texte
        m3u8_match = re.search(r'https?://[^\s"\'<>]+\.m3u8[^\s"\'<>]*', text)
        if m3u8_match:
            return m3u8_match.group(0)

        # 3. Fallback: hls sources reťazec
        hls_match = re.search(r'["\']hls["\']\s*:\s*["\'](https?://[^"\']+)["\']', text)
        if hls_match:
            return hls_match.group(1)

        return None

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
                stream_url = self._extract_from_html(text)

                # Ak sa v HTML nachádza JavaScript redirect (napr. window.location.href = 'https://...')
                if not stream_url:
                    redir_match = re.search(r'(?:window\.)?location(?:\.href)?\s*=\s*[\'"](https?://[^\'"]+)[\'"]', text)
                    if redir_match:
                        redir_url = redir_match.group(1)
                        r2 = await client.get(redir_url)
                        if r2.status_code == 200:
                            stream_url = self._extract_from_html(r2.text)

                if not stream_url:
                    return CheckResult(
                        server=self.name,
                        error="Stream URL not found",
                        duration_ms=int((time.time() - start_time) * 1000)
                    )

                # Over playlist
                quality = "1080p"
                size_bytes: Optional[int] = None
                try:
                    p_resp = await client.get(stream_url, headers={"Referer": embed_url})
                    if p_resp.status_code == 200 and "#EXTM3U" in p_resp.text:
                        res_match = re.search(r'RESOLUTION=\d+x(\d+)', p_resp.text)
                        if res_match:
                            quality = f"{res_match.group(1)}p"
                        size_bytes = 520 * 1024 * 1024
                except Exception:
                    pass

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
