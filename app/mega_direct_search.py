"""Priame vyhľadávanie živých mega.nz albumov z webu, paste stránok, Redditu a verejných t.me/s/ stránok.

Cieľ: nájsť priame `mega.nz/folder/...#...` a `mega.nz/file/...#...` linky bez skracovačov/captchy,
okamžite ich overiť cez MEGA API a vrátiť iba živé albumy s reálnym počtom videí.
"""
from __future__ import annotations

import asyncio
import html
import logging
import urllib.parse
from typing import Any

import httpx

from .mega_link_extractor import extract_mega_urls

logger = logging.getLogger(__name__)

_SEARXNG_URL = "http://127.0.0.1:8888/search"
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}
_PASTE_DOMAINS = (
    "rentry.co",
    "rentry.org",
    "pastebin.com",
    "justpaste.it",
    "telegra.ph",
    "t.me/s/",
    "paste.ee",
    "controlc.com",
    "ghostbin.",
    "dpaste.",
)


async def _searx_query(client: httpx.AsyncClient, q: str, *, engines: str | None = None) -> list[dict[str, Any]]:
    params: dict[str, str] = {"q": q, "format": "json"}
    if engines:
        params["engines"] = engines
    try:
        resp = await client.get(_SEARXNG_URL, params=params, timeout=12.0)
        if resp.status_code != 200:
            return []
        data = resp.json()
        rows = data.get("results") if isinstance(data, dict) else None
        return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []
    except Exception as exc:  # noqa: BLE001
        logger.debug("Direct MEGA SearXNG query failed (%s): %s", q, exc)
        return []


async def _fetch_page_megas(client: httpx.AsyncClient, url: str) -> list[str]:
    """Stiahne text paste/verejnej stránky a vytiahne priame (aj base64) mega.nz odkazy."""
    target = url
    # Pre pastebin.com/XXXX skúsime raw verziu (menšia a bez HTML šumu)
    parsed = urllib.parse.urlsplit(url)
    if parsed.netloc.lower().endswith("pastebin.com") and "/raw/" not in parsed.path:
        slug = parsed.path.strip("/")
        if slug and "/" not in slug:
            target = f"https://pastebin.com/raw/{slug}"
    try:
        resp = await client.get(target, timeout=8.0, follow_redirects=True)
        if resp.status_code >= 400:
            return []
        ctype = (resp.headers.get("content-type") or "").lower()
        if ctype and not any(t in ctype for t in ("text/", "json", "xml", "javascript")):
            return []
        body = html.unescape((resp.text or "")[:300_000])
        return extract_mega_urls(body)
    except Exception:  # noqa: BLE001
        return []


async def _search_reddit_megas(client: httpx.AsyncClient, query: str) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    queries = [f"{query} mega.nz", f'"{query}" "mega.nz/folder"']
    for q in queries:
        try:
            url = f"https://www.reddit.com/search.json?q={urllib.parse.quote(q)}&sort=relevance&limit=30&include_over_18=on"
            resp = await client.get(url, headers={**_HEADERS, "Accept": "application/json"}, timeout=10.0)
            if resp.status_code != 200:
                continue
            children = ((resp.json() or {}).get("data") or {}).get("children") or []
            for ch in children:
                post = (ch or {}).get("data") or {}
                title = (post.get("title") or "").strip()
                selftext = post.get("selftext") or ""
                post_url = post.get("url") or ""
                permalink = f"https://www.reddit.com{post.get('permalink', '')}" if post.get("permalink") else ""
                megas = extract_mega_urls(f"{title}\n{selftext}", extra_urls=[post_url] if post_url else ())
                for m in megas:
                    found.append({
                        "mega_url": m,
                        "title": title or query,
                        "source": f"Reddit ({post.get('subreddit_name_prefixed') or 'r/all'})",
                        "source_url": permalink or post_url,
                    })
        except Exception as exc:  # noqa: BLE001
            logger.debug("Direct MEGA Reddit search failed: %s", exc)
    return found


async def _search_searx_megas(client: httpx.AsyncClient, query: str) -> tuple[list[dict[str, Any]], bool]:
    """Vyhľadá cez lokálny SearXNG priame MEGA linky aj paste/telegra.ph/t.me/s stránky."""
    # Rýchly ping či beží SearXNG
    searx_ok = True
    dorks = [
        (f'"{query}" "mega.nz/folder/"', None),
        (f'{query} "mega.nz/folder/"', "yandex,duckduckgo,brave"),
        (f'{query} (site:rentry.co OR site:rentry.org OR site:telegra.ph OR site:pastebin.com OR site:justpaste.it) mega', None),
        (f'{query} site:t.me/s/ "mega.nz"', None),
    ]
    batches = await asyncio.gather(*(_searx_query(client, q, engines=eng) for q, eng in dorks))
    all_rows = [row for batch in batches for row in batch]
    if not all_rows:
        try:
            ping = await client.get(_SEARXNG_URL, params={"q": "test", "format": "json"}, timeout=3.0)
            searx_ok = ping.status_code == 200
        except Exception:  # noqa: BLE001
            searx_ok = False
        return [], searx_ok

    found: list[dict[str, Any]] = []
    pages_to_crawl: list[tuple[str, str]] = []
    seen_pages: set[str] = set()

    for row in all_rows:
        url = (row.get("url") or "").strip()
        title = (row.get("title") or "").strip()
        snippet = (row.get("content") or "").strip()
        engine = (row.get("engine") or "Web").strip()
        megas = extract_mega_urls(f"{title}\n{snippet}", extra_urls=[url] if url else ())
        if megas:
            for m in megas:
                found.append({
                    "mega_url": m,
                    "title": title or query,
                    "source": f"Web ({engine})",
                    "source_url": url,
                })
        elif url and url not in seen_pages and any(d in url.lower() for d in _PASTE_DOMAINS):
            seen_pages.add(url)
            pages_to_crawl.append((url, title or query))

    # Paralelne stiahneme paste / telegra.ph / t.me/s/ stránky (max 14) a vytiahneme z nich priame mega.nz
    sem = asyncio.Semaphore(5)

    async def crawl(page_url: str, page_title: str) -> list[dict[str, Any]]:
        async with sem:
            megas = await _fetch_page_megas(client, page_url)
            host = urllib.parse.urlsplit(page_url).netloc or "Paste"
            return [
                {"mega_url": m, "title": page_title, "source": f"Paste ({host})", "source_url": page_url}
                for m in megas[:10]
            ]

    crawled = await asyncio.gather(*(crawl(u, t) for u, t in pages_to_crawl[:14]))
    for chunk in crawled:
        found.extend(chunk)
    return found, searx_ok


async def search_direct_mega_links(
    query: str,
    *,
    verify: bool = True,
    max_verify: int = 24,
    only_alive: bool = True,
) -> dict[str, Any]:
    """Nájde priame mega.nz odkazy z viacerých zdrojov a voliteľne ich hneď overí cez MEGA API."""
    cleaned = (query or "").strip()
    if not cleaned:
        return {"items": [], "total_found": 0, "verified": 0, "alive": 0, "dead": 0, "searx_online": True}

    async with httpx.AsyncClient(headers=_HEADERS, timeout=12.0) as client:
        (searx_hits, searx_ok), reddit_hits = await asyncio.gather(
            _search_searx_megas(client, cleaned),
            _search_reddit_megas(client, cleaned),
        )

    # Deduplikácia podľa normalizovanej mega_url
    dedup: dict[str, dict[str, Any]] = {}
    for hit in [*searx_hits, *reddit_hits]:
        u = hit["mega_url"]
        if u not in dedup:
            dedup[u] = hit

    candidates = list(dedup.values())
    total_found = len(candidates)

    if not verify or not candidates:
        return {
            "items": candidates[:max_verify],
            "total_found": total_found,
            "verified": 0,
            "alive": 0,
            "dead": 0,
            "searx_online": searx_ok,
        }

    from .routers import mega_hub

    sem = asyncio.Semaphore(6)

    async def inspect_one(item: dict[str, Any]) -> dict[str, Any]:
        async with sem:
            try:
                share = mega_hub.parse_share(item["mega_url"])
                snap = await mega_hub._inspect(share)
            except Exception as exc:  # noqa: BLE001
                return {**item, "mega_status": "invalid", "video_count": 0, "reason": str(exc)}
            st = snap.get("status") or "retry"
            vids = snap.get("videos") or []
            mega_title = (snap.get("title") or "").strip()
            return {
                **item,
                "mega_status": st,
                "mega_title": mega_title or item["title"],
                "video_count": len(vids),
                "folder_count": len(snap.get("folders") or []),
                "kind": share.kind,
                "reason": snap.get("reason") or "",
            }

    checked = await asyncio.gather(*(inspect_one(c) for c in candidates[:max_verify]))
    alive = [c for c in checked if c["mega_status"] == "available" and c["video_count"] > 0]
    dead = sum(1 for c in checked if c["mega_status"] in {"unavailable", "empty", "invalid"})
    # Zoradíme živé podľa počtu videí (najbohatšie albumy hore)
    alive.sort(key=lambda x: x["video_count"], reverse=True)
    result_items = alive if only_alive else sorted(
        checked, key=lambda x: (x["mega_status"] == "available", x["video_count"]), reverse=True
    )

    return {
        "items": result_items,
        "total_found": total_found,
        "verified": len(checked),
        "alive": len(alive),
        "dead": dead,
        "searx_online": searx_ok,
    }
