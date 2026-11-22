"""Search all public Eporner playlists matching a keyword.

Examples:
    python eporner_playlist_search.py toys
    python eporner_playlist_search.py "bimbo bbc" --pages 10 --copy
    python eporner_playlist_search.py toys --open 1,3

The script uses the existing Eporner parser and request/throttle path from the
application. It caches playlist search pages briefly, so repeating a search is
fast without creating another burst of requests.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import time
import webbrowser
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

from app import eporner_transport as transport
from app.eporner_transport import EpornerListingError
from app.hubs.eporner import _parse_playlists

ROOT = Path(__file__).resolve().parent
CACHE_DIR = ROOT / "data" / "eporner_playlist_search_cache"
OUTPUT_DIR = ROOT / "data" / "eporner_playlist_searches"
CACHE_TTL_SECONDS = 15 * 60
MAX_PAGES = 100


def _slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def _safe_filename(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "_", value.strip())
    return cleaned.strip("._") or "keyword"


def _page_url(slug: str, page: int) -> str:
    suffix = "" if page == 1 else f"{page}/"
    return f"https://www.eporner.com/search-playlists/{quote(slug, safe='-')}/{suffix}"


def _cache_path(slug: str, page: int) -> Path:
    return CACHE_DIR / f"{_safe_filename(slug)}_{page}.json"


def _load_cache(path: Path) -> str | None:
    try:
        if time.time() - path.stat().st_mtime > CACHE_TTL_SECONDS:
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload.get("html") if isinstance(payload, dict) else None
    except (OSError, ValueError, TypeError):
        return None


def _save_cache(path: Path, html: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"html": html}, ensure_ascii=False), encoding="utf-8")


async def _fetch_page(slug: str, page: int) -> tuple[int, str, bool, str]:
    """Return status, HTML, cache state and Retry-After header."""
    cached = _load_cache(_cache_path(slug, page))
    if cached is not None:
        return 200, cached, True, ""

    url = _page_url(slug, page)
    try:
        response = await transport.fetch_listing(url)
    except EpornerListingError as exc:
        message = str(exc)
        print(f"Network error on page {page}: {message}", file=sys.stderr)
        if "429" in message or "509" in message or "limit požiadaviek" in message.lower():
            retry_after = ""
            match = re.search(r"počkaj (\d+) s", message)
            if match:
                retry_after = match.group(1)
            return 429, "", False, retry_after
        return 599, "", False, ""
    html = response.text or ""
    if response.status_code == 200 and html:
        _save_cache(_cache_path(slug, page), html)
    return response.status_code, html, False, str(response.headers.get("Retry-After", ""))


async def iter_search_playlists(
    keyword: str,
    max_pages: int,
    result_limit: int = 0,
    sort_mode: str = "newest",
    *,
    log=None,
):
    """Yield matching playlists as soon as a search page is parsed."""
    slug = _slugify(keyword)
    if not slug:
        raise ValueError("Keyword must contain at least one letter or number")

    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    stopped_by_rate_limit = False
    scanned_pages = 0
    needle = keyword.casefold()
    log = print if log is True else log

    for page in range(1, min(max_pages, MAX_PAGES) + 1):
        scanned_pages = page
        status, html, from_cache, retry_after = await _fetch_page(slug, page)
        if log:
            log(f"page {page}: HTTP {status} ({'cache' if from_cache else 'network'})")

        if status == 429:
            stopped_by_rate_limit = True
            if log:
                if retry_after:
                    log(f"Rate limit received; stopped. Retry-After: {retry_after}")
                else:
                    log("Rate limit received; stopped without retrying.")
            break
        if status == 599:
            if log:
                log("Search stopped; partial results will still be saved.")
            if page == 1 and not results:
                raise EpornerListingError("Eporner playlist search: spojenie zlyhalo na prvej stránke.")
            break
        if status not in (200, 404) or not html:
            if log:
                log(f"Stopped after HTTP {status}.")
            break

        page_items = _parse_playlists(html)
        matching_items = [item for item in page_items if needle in (item.get("title") or "").casefold()]
        reached_limit = False
        for item in matching_items:
            playlist_id = str(item.get("id") or "")
            if playlist_id and playlist_id not in seen:
                seen.add(playlist_id)
                results.append(item)
                yield {"type": "playlist", "item": item, "page": page, "found": len(results)}
                if result_limit and len(results) >= result_limit:
                    reached_limit = True
                    break

        yield {"type": "search_page", "page": page, "found": len(results)}
        if reached_limit:
            break

        if not page_items or len(page_items) < 40:
            break

    if sort_mode == "largest":
        results.sort(key=lambda item: int(item.get("count") or 0), reverse=True)
    elif sort_mode == "title":
        results.sort(key=lambda item: str(item.get("title") or "").casefold())
    trimmed = results[:result_limit] if result_limit else results
    yield {
        "type": "done",
        "results": trimmed,
        "stopped_by_rate_limit": stopped_by_rate_limit,
        "pages_scanned": scanned_pages,
    }


async def search_playlists(
    keyword: str,
    max_pages: int,
    result_limit: int = 0,
    sort_mode: str = "newest",
) -> tuple[list[dict[str, Any]], bool, int]:
    final = {"results": [], "stopped_by_rate_limit": False, "pages_scanned": 0}
    async for event in iter_search_playlists(
        keyword,
        max_pages,
        result_limit=result_limit,
        sort_mode=sort_mode,
        log=lambda message: print(message, file=sys.stderr),
    ):
        if event["type"] == "done":
            final = event
    return final["results"], bool(final["stopped_by_rate_limit"]), int(final["pages_scanned"] or 0)


def _copy_text(text: str) -> bool:
    try:
        import tkinter as tk

        root = tk.Tk()
        root.withdraw()
        root.clipboard_clear()
        root.clipboard_append(text)
        root.update()
        root.destroy()
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"Clipboard unavailable: {exc}", file=sys.stderr)
        return False


def _open_selected(results: list[dict[str, Any]], selection: str) -> None:
    if selection.lower() == "all":
        indexes = range(len(results))
    else:
        indexes = []
        for token in selection.split(","):
            try:
                index = int(token.strip()) - 1
            except ValueError:
                continue
            if 0 <= index < len(results):
                indexes.append(index)
    for index in indexes:
        url = results[index].get("url")
        if url:
            webbrowser.open_new_tab(url)


def _write_report(keyword: str, results: list[dict[str, Any]], pages: int, stopped: bool) -> Path:
    stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    path = OUTPUT_DIR / f"{_safe_filename(keyword)}_eporner_{stamp}_{len(results)}_results.txt"
    lines = [
        f"Keyword: {keyword}",
        f"Source: Eporner public playlist search",
        f"Date: {datetime.now().isoformat(timespec='seconds')}",
        f"Pages scanned: {pages}",
        f"Results: {len(results)}",
        f"Stopped on rate limit: {'yes' if stopped else 'no'}",
        "",
    ]
    for index, item in enumerate(results, 1):
        title = item.get("title") or "Playlist"
        url = item.get("url") or ""
        count = item.get("count") or 0
        lines.append(f"{index}. {title} | files: {count} | {url}")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


async def _run_search(
    keyword: str,
    pages: int,
    result_limit: int,
    sort_mode: str,
    no_cache: bool = False,
) -> list[dict[str, Any]]:
    global _load_cache
    original_load_cache = _load_cache
    if no_cache:
        _load_cache = lambda path: None  # type: ignore[assignment]
    try:
        results, stopped, scanned_pages = await search_playlists(
            keyword, pages, result_limit=result_limit, sort_mode=sort_mode
        )
    finally:
        _load_cache = original_load_cache

    report = _write_report(keyword, results, scanned_pages, stopped)
    print(f"\n{len(results)} matching playlists")
    for index, item in enumerate(results, 1):
        print(f"{index:>3}. {item.get('title', 'Playlist')} | files: {item.get('count', 0)}")
        print(f"     {item.get('url', '')}")
    print(f"\nSaved: {report.relative_to(ROOT)}")
    return results


async def _interactive(args: argparse.Namespace) -> int:
    print("Eporner playlist search. Empty keyword or 'q' ends the program.")
    while True:
        try:
            keyword = input("\nKeyword: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0
        if not keyword or keyword.casefold() in {"q", "quit", "exit"}:
            return 0

        raw_limit = input("Number of playlists [50]: ").strip()
        try:
            result_limit = int(raw_limit or "50")
            if result_limit < 1:
                raise ValueError
        except ValueError:
            print("Enter a positive number.")
            continue

        print("Sort: 1 = newest/source order, 2 = largest first, 3 = title")
        sort_choice = input("Sort [1]: ").strip() or "1"
        sort_mode = {"1": "newest", "2": "largest", "3": "title"}.get(sort_choice)
        if not sort_mode:
            print("Unknown sort; using newest/source order.")
            sort_mode = "newest"

        results = await _run_search(keyword, args.pages, result_limit, sort_mode, args.no_cache)
        urls = [str(item.get("url")) for item in results if item.get("url")]
        action = input("Copy URLs, open selected numbers, or Enter to continue [c/o 1,3]: ").strip()
        if action.casefold() == "c" and _copy_text("\n".join(urls)):
            print(f"Copied {len(urls)} URLs to clipboard.")
        elif action.casefold().startswith("o "):
            _open_selected(results, action[2:].strip())


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Search Eporner public playlists by title keyword")
    parser.add_argument("keyword", nargs="?", help="Text that must occur in the playlist title; omit for interactive mode")
    parser.add_argument("--limit", type=int, default=0, help="Maximum matching playlists to return (interactive default: 50)")
    parser.add_argument("--sort", choices=("newest", "largest", "title"), default="newest", help="Result order")
    parser.add_argument("--pages", type=int, default=25, help="Maximum pages to scan (default: 25, max: 100)")
    parser.add_argument("--copy", action="store_true", help="Copy matching playlist URLs to the clipboard")
    parser.add_argument("--open", dest="open_selection", metavar="N[,N]|all", help="Open selected result numbers in browser tabs")
    parser.add_argument("--no-cache", action="store_true", help="Ignore cached pages for this run")
    return parser.parse_args()


async def _main() -> int:
    args = _parse_args()
    if args.pages < 1:
        print("--pages must be at least 1", file=sys.stderr)
        return 2
    if args.limit < 0:
        print("--limit must not be negative", file=sys.stderr)
        return 2
    if not args.keyword:
        return await _interactive(args)

    results = await _run_search(args.keyword, args.pages, args.limit, args.sort, args.no_cache)
    urls = [str(item.get("url")) for item in results if item.get("url")]

    if args.copy and _copy_text("\n".join(urls)):
        print(f"Copied {len(urls)} URLs to clipboard.")
    if args.open_selection:
        _open_selected(results, args.open_selection)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
