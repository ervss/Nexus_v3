"""Paced listing requests using the same configured route as the Eporner hub."""
import asyncio
import http.cookiejar
import logging
import time
from email.utils import parsedate_to_datetime
from pathlib import Path

logger = logging.getLogger(__name__)
_tor_until = 0.0
_cooldown_until = 0.0


class EpornerListingError(RuntimeError):
    pass


async def fetch_listing(url: str):
    global _tor_until, _cooldown_until
    from .hubs.eporner import _cget, _network_mode, _throttle
    from .tor_service import tor_service

    if time.monotonic() < _cooldown_until:
        raise EpornerListingError("Eporner obmedzil požiadavky; počkaj pred ďalším testom.")
    cookies = {"age_verified": "1"}
    for name in ("eporner.netscape.txt", "eporner.cookies.txt"):
        if not Path(name).is_file():
            continue
        try:
            jar = http.cookiejar.MozillaCookieJar(name)
            jar.load(ignore_discard=True, ignore_expires=True)
            cookies.update({c.name: c.value for c in jar
                            if (c.domain or "").lstrip(".") in ("eporner.com", "www.eporner.com")})
        except (OSError, http.cookiejar.LoadError):
            logger.warning("[Eporner] Could not load listing cookies")
        break
    mode = _network_mode()
    tor = mode == "tor" or (mode == "auto" and time.monotonic() < _tor_until)

    async def request(use_tor):
        await _throttle()
        return await asyncio.to_thread(
            _cget, url, force_tor=use_tor, timeout=20 if use_tor else 6,
            headers={"Referer": "https://www.eporner.com/"}, cookies=cookies,
        )

    try:
        response = await request(tor)
    except Exception as exc:
        # Switch only after a transport failure, not to evade an HTTP limit.
        if mode != "auto" or tor:
            raise EpornerListingError("Eporner: spojenie zlyhalo (timeout/proxy).") from exc
        state = await asyncio.to_thread(tor_service.status)
        if not state.get("ready"):
            raise EpornerListingError("Eporner: priame spojenie zlyhalo a nakonfigurovaný Tor nie je pripravený.") from exc
        logger.info("[Eporner] Listing transport failed; using configured Tor fallback")
        try:
            response = await request(True)
        except Exception as fallback_exc:
            raise EpornerListingError("Eporner: zlyhalo aj spojenie cez nakonfigurovaný Tor.") from fallback_exc
        _tor_until = time.monotonic() + 300
    if response.status_code in (429, 509):
        try:
            cooldown = max(60, float(response.headers.get("Retry-After", "60")))
        except (ValueError, TypeError):
            try:
                cooldown = max(60, parsedate_to_datetime(response.headers.get("Retry-After", "")).timestamp() - time.time())
            except (ValueError, TypeError, OverflowError):
                cooldown = 60
        _cooldown_until = time.monotonic() + cooldown
        raise EpornerListingError(f"Eporner HTTP {response.status_code}: limit požiadaviek; počkaj {int(cooldown)} s.")
    if response.status_code not in (200, 404):
        raise EpornerListingError(f"Eporner HTTP {response.status_code}: playlist je nedostupný alebo chránený.")
    return response
