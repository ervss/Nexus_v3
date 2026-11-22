from urllib.parse import parse_qs, urlsplit


def is_forum_context_url(url: str) -> bool:
    """Forum posts describe media; they are never a media refresh source."""
    host = (urlsplit(str(url or "")).hostname or "").lower()
    return host.startswith("simpcity.") or host == "socialmediagirls.com" or host.endswith(".socialmediagirls.com")


def media_refresh_source(url: str, source_url: str = "") -> str:
    source = source_url or url or ""
    if is_forum_context_url(source) and url and not is_forum_context_url(url):
        return url
    return source


def is_pimpbunny_remote_media(url: str) -> bool:
    """Recognize signed KVS media links whose filename lives in the query."""
    try:
        parsed = urlsplit(str(url or ""))
        host = (parsed.hostname or "").lower()
        if parsed.scheme not in ("http", "https") or not (
            any(host == domain or host.endswith("." + domain) for domain in ("pimpbunny.com", "fnxtube.com"))
        ):
            return False
        if parsed.path.lower() != "/remote_control.php":
            return False
        files = parse_qs(parsed.query).get("file", [])
        return any(value.lower().endswith((".mp4", ".m3u8", ".webm", ".mkv", ".mov")) for value in files)
    except ValueError:
        return False
