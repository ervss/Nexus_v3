"""
1Porn Client & Cookie Sync
Handles Cloudflare bypass and session persistence for 1porn.tv
"""
import asyncio
import json
import logging
import os
import time
from typing import Optional, Dict

logger = logging.getLogger(__name__)

try:
    from curl_cffi import requests as creq
except ImportError:
    creq = None

COOKIE_FILE = os.path.join(os.path.dirname(__file__), "..", "data", "1porn_cookies.json")
_mem_cookies: Dict[str, str] = {}
_mem_cookies_ts: float = 0
_lock = asyncio.Lock()

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"


def get_1porn_cookies() -> Dict[str, str]:
    global _mem_cookies, _mem_cookies_ts
    if _mem_cookies and (time.time() - _mem_cookies_ts < 7200):
        return _mem_cookies
    if os.path.exists(COOKIE_FILE):
        try:
            with open(COOKIE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict) and (time.time() - data.get("ts", 0) < 7200):
                    _mem_cookies = data.get("cookies", {})
                    _mem_cookies_ts = data.get("ts", 0)
                    return _mem_cookies
        except Exception as e:
            logger.warning(f"[1porn_client] Error loading cookies from {COOKIE_FILE}: {e}")
    return {}


def save_1porn_cookies(cookies: Dict[str, str]) -> None:
    global _mem_cookies, _mem_cookies_ts
    _mem_cookies = cookies
    _mem_cookies_ts = time.time()
    try:
        os.makedirs(os.path.dirname(COOKIE_FILE), exist_ok=True)
        with open(COOKIE_FILE, "w", encoding="utf-8") as f:
            json.dump({"ts": _mem_cookies_ts, "cookies": cookies}, f)
    except Exception as e:
        logger.warning(f"[1porn_client] Error saving cookies to {COOKIE_FILE}: {e}")


def _solve_cf_playwright_sync(target_url: str) -> tuple[Dict[str, str], Optional[str]]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        logger.warning("[1porn_client] Playwright not installed, cannot solve Cloudflare")
        return {}, None

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=["--disable-blink-features=AutomationControlled", "--no-sandbox"]
            )
            context = browser.new_context(user_agent=UA, viewport={"width": 1920, "height": 1080})
            page = context.new_page()
            page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
            page.goto(target_url, timeout=30000)
            for _ in range(12):
                time.sleep(1)
                try:
                    title = page.title()
                    if "Just a moment" not in title:
                        break
                except Exception:
                    pass
            cookies_list = context.cookies()
            cookie_dict = {c["name"]: c["value"] for c in cookies_list}
            html = page.content()
            browser.close()
            if cookie_dict:
                save_1porn_cookies(cookie_dict)
            return cookie_dict, html
    except Exception as e:
        logger.warning(f"[1porn_client] Playwright CF solve error: {e}")
        return {}, None


async def _solve_cf_playwright(target_url: str) -> tuple[Dict[str, str], Optional[str]]:
    return await asyncio.to_thread(_solve_cf_playwright_sync, target_url)


async def fetch_1porn_html(url: str, referer: str = "https://www.1porn.tv/", timeout: int = 15) -> Optional[str]:
    """
    Fetch HTML from 1porn.tv with Cloudflare bypass (cookies + curl_cffi with Playwright fallback).
    """
    async with _lock:
        cookies = get_1porn_cookies()
        if cookies and creq:
            cookie_str = "; ".join(f"{k}={v}" for k, v in cookies.items())
            headers = {"User-Agent": UA, "Cookie": cookie_str, "Referer": referer}
            try:
                def _do_get():
                    return creq.get(url, headers=headers, impersonate="chrome124", timeout=timeout)
                r = await asyncio.to_thread(_do_get)
                if r.status_code == 200 and "Just a moment" not in r.text:
                    return r.text
            except Exception as e:
                logger.debug(f"[1porn_client] curl_cffi request failed: {e}")

        # If cookies were invalid, missing, or challenge received, use Playwright
        logger.info(f"[1porn_client] Refreshing Cloudflare cookies via Playwright for {url}...")
        cookies, html = await _solve_cf_playwright(url)
        if html and "Just a moment" not in html:
            return html
        return None
