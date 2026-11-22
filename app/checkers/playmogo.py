import time
import asyncio
from typing import Optional
from .base import BaseChecker, CheckResult

class PlaymogoChecker(BaseChecker):
    name: str = "Playmogo"

    def __init__(self, timeout: float = 20.0):
        super().__init__(timeout)

    async def check(self, embed_url: str) -> CheckResult:
        start_time = time.time()

        # Overenie inštalácie Playwrightu
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            return CheckResult(
                server=self.name,
                error="Playwright is not installed",
                duration_ms=int((time.time() - start_time) * 1000)
            )

        stealth_sync = None
        try:
            from playwright_stealth import stealth_async
        except ImportError:
            stealth_async = None

        captured_stream: Optional[str] = None
        quality: Optional[str] = None

        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True)
                context = await browser.new_context(
                    user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
                    locale="en-US",
                )
                page = await context.new_page()

                if stealth_async:
                    await stealth_async(page)

                # Odchytávaj sieťové requesty na video streamy
                def handle_response(response):
                    nonlocal captured_stream, quality
                    url = response.url
                    if ".m3u8" in url or ".mp4" in url:
                        if not captured_stream:
                            captured_stream = url
                            quality = "1080p" if "1080" in url else ("720p" if "720" in url else "HLS")

                page.on("response", handle_response)

                try:
                    await page.goto(embed_url, timeout=int(self.timeout * 1000), wait_until="domcontentloaded")
                    # Čakaj na vyriešenie Cloudflare alebo načítanie prehrávača
                    for _ in range(int(self.timeout)):
                        if captured_stream:
                            break
                        await asyncio.sleep(1)
                except Exception as nav_err:
                    if not captured_stream:
                        await browser.close()
                        return CheckResult(
                            server=self.name,
                            error=f"Navigation failed: {nav_err}",
                            duration_ms=int((time.time() - start_time) * 1000)
                        )

                await browser.close()

            if captured_stream:
                return CheckResult(
                    server=self.name,
                    direct_url=captured_stream,
                    quality=quality or "1080p",
                    duration_ms=int((time.time() - start_time) * 1000)
                )
            else:
                return CheckResult(
                    server=self.name,
                    error="Cloudflare challenge not passed or stream not detected",
                    duration_ms=int((time.time() - start_time) * 1000)
                )

        except Exception as e:
            return CheckResult(
                server=self.name,
                error=f"Playwright error: {str(e)}",
                duration_ms=int((time.time() - start_time) * 1000)
            )
