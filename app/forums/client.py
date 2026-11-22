"""Cookie-authenticated XenForo fetcher.

Uses curl_cffi's TLS browser impersonation because both boards sit behind
DDoS-Guard, which rejects plain `requests`/`httpx` on the TLS fingerprint alone
(the `__ddg*` cookies in the jar are its markers).
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime
from typing import Optional

from curl_cffi.requests import AsyncSession

from .boards import Board, load_cookies, missing_auth_cookies

logger = logging.getLogger(__name__)

_IMPERSONATE = "chrome"
_TIMEOUT = 25
_POLITE_DELAY = 1.2
_MAX_ATTEMPTS = 3
# SimpCity rarely sends Retry-After. A few seconds is not a cooldown — it is how
# we stayed in 429 jail. Back off hard and fail the request so Refresh returns.
_DEFAULT_COOLDOWN = 180.0

# One in-flight request per board. Parallel refresh + tag discover + groups
# used to open three sessions at once and SimpCity answered every extra hit
# with HTTP 429, so the hub looked "broken" even with valid cookies.
_GATES: dict[str, asyncio.Lock] = {}
_COOLDOWN_UNTIL: dict[str, float] = {}
_AUTH_HEALTH: dict[str, dict[str, str]] = {}
_HEALTH_TTL_SECONDS = 15 * 60


class ForumAuthError(RuntimeError):
    """Cookies are missing or no longer valid for this board."""


class ForumRateLimitError(RuntimeError):
    """The board asked us to back off (HTTP 429) and retries did not clear it."""


class ForumChallengeError(RuntimeError):
    """The board or its DDoS protection challenged the request."""


def _set_auth_health(board_key: str, state: str, error: str = "") -> None:
    now = time.time()
    previous = _AUTH_HEALTH.get(board_key, {})
    _AUTH_HEALTH[board_key] = {
        "state": state,
        "checked_at": str(now),
        "last_success_at": previous.get("last_success_at", ""),
        "error": error,
    }
    if state == "authenticated":
        _AUTH_HEALTH[board_key]["last_success_at"] = str(now)


def auth_health(board_key: str, cookie_configured: bool) -> dict[str, object]:
    """Return a short-lived live auth result; cookie names alone are not proof."""
    health = _AUTH_HEALTH.get(board_key, {})
    state = health.get("state", "unchecked")
    checked_at = float(health.get("checked_at") or 0)
    if time.time() - checked_at > _HEALTH_TTL_SECONDS:
        state = "unchecked"
    if not cookie_configured:
        state = "missing_cookies"
    last_success = float(health.get("last_success_at") or 0)
    return {
        "auth_state": state,
        "authenticated": state == "authenticated",
        "auth_checked_at": datetime.fromtimestamp(checked_at).astimezone().isoformat(timespec="seconds") if checked_at else "",
        "auth_last_success_at": datetime.fromtimestamp(last_success).astimezone().isoformat(timespec="seconds") if last_success else "",
        "auth_error": health.get("error", "") if state != "unchecked" else "",
    }


def _gate(board_key: str) -> asyncio.Lock:
    lock = _GATES.get(board_key)
    if lock is None:
        lock = _GATES[board_key] = asyncio.Lock()
    return lock


def cooldown_remaining(board_key: str) -> float:
    return max(0.0, _COOLDOWN_UNTIL.get(board_key, 0.0) - time.monotonic())


def _set_cooldown(board_key: str, seconds: float) -> None:
    _COOLDOWN_UNTIL[board_key] = time.monotonic() + max(0.0, seconds)


def _retry_after_seconds(resp, attempt: int = 1) -> float:
    raw = ""
    headers = getattr(resp, "headers", None) or {}
    if hasattr(headers, "get"):
        raw = headers.get("Retry-After") or headers.get("retry-after") or ""
    try:
        if raw != "" and raw is not None:
            return min(300.0, max(_DEFAULT_COOLDOWN, float(raw)))
    except (TypeError, ValueError):
        pass
    return _DEFAULT_COOLDOWN


def _login_marker(html: str) -> Optional[bool]:
    if not html:
        return None
    import re

    match = re.search(r"""data-logged-in\s*=\s*["'](true|false)["']""", html, re.I)
    if match:
        return match.group(1).lower() == "true"
    return None


def _is_challenge(html: str) -> bool:
    lowered = html.lower()
    return any(marker in lowered for marker in (
        "ddos-guard", "checking your browser", "challenge-platform",
    ))


class ForumClient:
    """One board, one authenticated session."""

    def __init__(self, board: Board, session=None):
        self.board = board
        self.cookies = load_cookies(board)
        self.missing = missing_auth_cookies(self.cookies)
        self._session = session
        self._owns_session = session is None

    @property
    def authenticated(self) -> bool:
        return bool(self.cookies) and not self.missing

    def _auth_hint(self) -> str:
        if not self.cookies:
            return (
                f"No cookies are available for {self.board.label}. "
                "Sync the browser's forum cookies from the extension."
            )
        return (
            f"{self.board.label} is missing the authenticated session cookies. "
            "Re-sync them with the browser extension; it can include HttpOnly cookies."
        )

    async def _ensure_session(self):
        if self._session is None:
            self._session = AsyncSession(impersonate=_IMPERSONATE, timeout=_TIMEOUT, verify=False)
            self._owns_session = True
        return self._session

    async def aclose(self) -> None:
        if self._owns_session and self._session is not None:
            close = getattr(self._session, "close", None)
            if close:
                result = close()
                if asyncio.iscoroutine(result):
                    await result
        self._session = None

    async def get(self, url: str, *, params: Optional[dict] = None, require_auth: bool = True) -> str:
        if require_auth and self.missing:
            _set_auth_health(self.board.key, "missing_cookies", self._auth_hint())
            raise ForumAuthError(self._auth_hint())

        headers = {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": f"{self.board.base_url}/",
            "Upgrade-Insecure-Requests": "1",
        }

        async with _gate(self.board.key):
            wait = cooldown_remaining(self.board.key)
            if wait > 0:
                raise ForumRateLimitError(
                    f"{self.board.label} throttle (HTTP 429). Ďalší pokus o {int(wait)}s — "
                    "neklikaj Refresh, Hub to medzitým neskúša."
                )

            session = await self._ensure_session()
            last_exc: Optional[Exception] = None
            for attempt in range(1, _MAX_ATTEMPTS + 1):
                try:
                    resp = await session.get(
                        url, params=params, headers=headers, cookies=self.cookies, allow_redirects=True
                    )
                except Exception as exc:  # noqa: BLE001
                    last_exc = exc
                    _set_auth_health(self.board.key, "error", f"Chyba spojenia: {exc}")
                    delay = min(12.0, 2.0 * attempt)
                    logger.warning("[ForumHub] %s fetch error (%s), retry in %.1fs", url, exc, delay)
                    await asyncio.sleep(delay)
                    continue

                if resp.status_code == 429:
                    delay = _retry_after_seconds(resp)
                    _set_cooldown(self.board.key, delay)
                    _set_auth_health(self.board.key, "rate_limited", f"HTTP 429; cooldown {int(delay)}s")
                    logger.warning(
                        "[ForumHub] %s HTTP 429 on %s — stopping for %.0fs (no more thread fetches)",
                        self.board.label, url, delay,
                    )
                    raise ForumRateLimitError(
                        f"{self.board.label} vrátilo 429. Hub zastavil sťahovanie na {int(delay)}s. "
                        "Počkaj, kým chip ukáže „prihlásené“, a daj Refresh raz."
                    )

                if resp.status_code == 403:
                    body = getattr(resp, "text", "") or ""
                    if _is_challenge(body):
                        message = f"{self.board.label} zablokovalo požiadavku výzvou DDoS-Guard (HTTP 403)."
                        _set_auth_health(self.board.key, "ddos_guard", message)
                        raise ForumChallengeError(message)
                    message = f"{self.board.label} odmietlo požiadavku (HTTP 403); prihlásenie sa nepodarilo overiť."
                    _set_auth_health(self.board.key, "expired", message)
                    raise ForumAuthError(
                        f"{message} {self._auth_hint()}"
                    )
                if resp.status_code >= 400:
                    message = f"{self.board.label} returned HTTP {resp.status_code} for {url}"
                    _set_auth_health(self.board.key, "error", message)
                    raise RuntimeError(
                        message
                    )

                html = resp.text
                if require_auth:
                    if _is_challenge(html):
                        message = f"{self.board.label} vrátilo výzvu DDoS-Guard namiesto obsahu fóra."
                        _set_auth_health(self.board.key, "ddos_guard", message)
                        raise ForumChallengeError(message)
                    logged_in = _login_marker(html)
                    if logged_in is False:
                        message = f"{self.board.label} vrátilo odhlásenú stránku."
                        _set_auth_health(self.board.key, "expired", message)
                        raise ForumAuthError(f"{message} {self._auth_hint()}")
                    if logged_in is None:
                        message = f"{self.board.label} nevrátilo overiteľný stav prihlásenia."
                        _set_auth_health(self.board.key, "error", message)
                        raise ForumAuthError(f"{message} {self._auth_hint()}")
                    _set_auth_health(self.board.key, "authenticated")
                await asyncio.sleep(_POLITE_DELAY)
                return html

            if last_exc:
                raise last_exc
            raise RuntimeError(f"{self.board.label} fetch failed for {url}")
