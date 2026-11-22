"""Short-lived, server-side credentials for playback proxy requests."""
import secrets
import time

SESSIONS: dict[str, dict] = {}
TTL = 20 * 60


def register(cookies: dict, referer: str) -> str:
    if not cookies:
        return ""
    now = time.time()
    for key, entry in list(SESSIONS.items()):
        if now - entry.get("ts", 0) > TTL:
            SESSIONS.pop(key, None)
    token = secrets.token_urlsafe(18)
    SESSIONS[token] = {
        "ts": now,
        "cookies": {str(key): str(value) for key, value in cookies.items() if value},
        "referer": referer,
    }
    return token
