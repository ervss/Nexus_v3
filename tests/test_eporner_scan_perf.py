"""Measure Eporner /tester scan pipeline: TTFV, throughput, cache, first-page priority."""
from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app import eporner_playlist_index as index
from app import eporner_transport as transport
import app.eporner_playlist_search as playlist_search


@pytest.fixture(autouse=True)
def _force_fetch_listing_route(monkeypatch):
    monkeypatch.setenv("EPORNER_NETWORK_MODE", "tor")


def _playlist_card(pid: str, title: str, count: int = 40) -> str:
    return (
        f'<div class="mb"><a href="/playlist/{pid}/clips/">'
        f'<img alt="{title}" src="https://static.example/{pid}.jpg"></a>'
        f'<span class="mbphoto2_playlistico">{count}</span></div>'
    )


def _video_card(vid: str, title: str) -> str:
    return (
        f'<div class="mb"><p class="mbtit"><a href="/hd-porn/{vid}/clip/">{title}</a></p>'
        f'<span class="mbtim">1:02</span><div class="mvhdico">720p</div>'
        f'<span class="mbvie">12K</span></div>'
    )


def _search_html(items: list[tuple[str, str]]) -> str:
    body = "".join(_playlist_card(pid, title) for pid, title in items)
    pads = "".join(
        f'<div class="mb"><a href="/playlist/pad{i}/x/"><img alt="pad {i}"></a></div>'
        for i in range(max(0, 40 - len(items)))
    )
    return body + pads


def _playlist_html(pid: str, pages: int, page: int, match_title: str) -> str:
    cards = []
    for i in range(40):
        title = match_title if i == 39 else f"{pid} clip {page}-{i}"
        cards.append(_video_card(f"{pid}{page:02d}{i:02d}", title))
    paging = ""
    if page < pages:
        paging = f'<div class="numlist2"><a href="{page + 1}/">{page + 1}</a></div>'
    return '<div class="streamevents">' + "".join(cards) + paging + "</div>"


def _install_fetch(monkeypatch, *, playlists: list[tuple[str, str]], pages_each: int, latency: float, order: list | None = None, real_cache: bool = False):
    order = order if order is not None else []

    async def fetch(url: str):
        order.append(url)
        if latency:
            await asyncio.sleep(latency)
        if "/search-playlists/" in url:
            return SimpleNamespace(status_code=200, text=_search_html(playlists), headers={})
        pid = url.split("/playlist/")[1].split("/")[0]
        page = 1
        for part in url.rstrip("/").split("/"):
            if part.isdigit():
                page = int(part)
        html = _playlist_html(pid, pages_each, page, "PAWG bbc")
        return SimpleNamespace(status_code=200, text=html, headers={})

    monkeypatch.setattr(transport, "fetch_listing", fetch)
    monkeypatch.setattr(playlist_search, "_load_cache", lambda path: None)
    monkeypatch.setattr(playlist_search, "_save_cache", lambda path, html: None)
    if not real_cache:
        monkeypatch.setattr(index, "_load_cache", lambda url: None)
        monkeypatch.setattr(index, "_save_cache", Mock())
    return order


async def _measure(keyword="bbc", video_keyword="pawg", pages=1, limit=50, **scan_kw):
    t0 = time.perf_counter()
    ttfv = None
    videos = 0
    playlists = 0
    cache_hits = cache_misses = 0
    search_pages = 0
    first_match = None
    needle = video_keyword.casefold()
    async for event in index.stream_playlist_scan(
        keyword, pages, result_limit=limit, video_keyword=video_keyword, **scan_kw
    ):
        kind = event.get("type")
        if kind == "playlist":
            playlists += 1
        elif kind == "page":
            items = event.get("items") or []
            videos += len(items)
            if ttfv is None:
                hit = next((item for item in items if needle in (item.get("title") or "").casefold()), None)
                if hit or (not needle and items):
                    ttfv = time.perf_counter() - t0
                    first_match = (hit or items[0]).get("title")
            if event.get("cached"):
                cache_hits += 1
            else:
                cache_misses += 1
        elif kind == "done":
            search_pages = int(event.get("pages_scanned") or 0)
            elapsed = time.perf_counter() - t0
            return {
                "ttfv_ms": round((ttfv or elapsed) * 1000, 1),
                "elapsed_ms": round(elapsed * 1000, 1),
                "playlists": playlists,
                "videos": videos,
                "search_pages": search_pages,
                "playlists_per_sec": round(playlists / elapsed, 2) if elapsed else 0,
                "videos_per_sec": round(videos / elapsed, 2) if elapsed else 0,
                "search_pages_per_sec": round(search_pages / elapsed, 2) if elapsed else 0,
                "cache_hit_rate": round(cache_hits / max(cache_hits + cache_misses, 1), 3),
                "first_match": first_match,
                "server_metrics": event.get("metrics"),
            }
    elapsed = time.perf_counter() - t0
    return {"ttfv_ms": None, "elapsed_ms": round(elapsed * 1000, 1), "playlists": playlists, "videos": videos}


def test_baseline_scan_throughput_8_25_50_and_deep_playlist(monkeypatch):
    rows = []
    for count, pages_each, latency in ((8, 1, 0.01), (25, 1, 0.01), (50, 1, 0.01), (3, 26, 0.005)):
        playlists = [(f"p{i}", f"BBC mix {i}") for i in range(count)]
        _install_fetch(monkeypatch, playlists=playlists, pages_each=pages_each, latency=latency)
        metrics = asyncio.run(_measure(limit=count, pages=1))
        metrics["case"] = f"{count} playlists x {pages_each} pages"
        rows.append(metrics)
        print(f"\nSCAN {metrics['case']}: TTFV={metrics['ttfv_ms']}ms elapsed={metrics['elapsed_ms']}ms "
              f"playlists/s={metrics['playlists_per_sec']} videos/s={metrics['videos_per_sec']} "
              f"videos={metrics['videos']} cache_hit={metrics['cache_hit_rate']}")
    assert rows[0]["ttfv_ms"] is not None
    assert rows[0]["videos"] >= 40
    assert rows[2]["playlists"] == 50
    assert rows[3]["videos"] >= 1000
    assert rows[0]["server_metrics"]


def test_scan_puts_keyword_matches_first_on_each_page(monkeypatch):
    playlists = [("p0", "BBC mix")]
    _install_fetch(monkeypatch, playlists=playlists, pages_each=1, latency=0.001)
    ttfv = None
    first_title = None

    async def run():
        nonlocal ttfv, first_title
        t0 = time.perf_counter()
        async for event in index.stream_playlist_scan("bbc", 1, result_limit=1, video_keyword="pawg"):
            if event.get("type") == "page":
                first_title = (event.get("items") or [{}])[0].get("title")
                ttfv = time.perf_counter() - t0
                break

    asyncio.run(run())
    assert first_title and "PAWG" in first_title
    print(f"\nMATCH-FIRST page[0]={first_title!r} TTFV={round(ttfv * 1000, 1)}ms")


def test_scan_prefers_other_first_pages_over_deep_pagination(monkeypatch):
    order = []
    huge = [("huge", "BBC huge")]
    rest = [(f"s{i}", f"BBC small {i}") for i in range(5)]

    async def fetch(url: str):
        order.append(url)
        await asyncio.sleep(0.002)
        if "/search-playlists/" in url:
            page = 2 if "/2/" in url or url.rstrip("/").endswith("/2") else 1
            html = _search_html(huge if page == 1 else rest)
            return SimpleNamespace(status_code=200, text=html, headers={})
        pid = url.split("/playlist/")[1].split("/")[0]
        page = 1
        for part in url.rstrip("/").split("/"):
            if part.isdigit():
                page = int(part)
        pages = 8 if pid == "huge" else 1
        return SimpleNamespace(status_code=200, text=_playlist_html(pid, pages, page, "PAWG bbc"), headers={})

    monkeypatch.setattr(transport, "fetch_listing", fetch)
    monkeypatch.setattr(playlist_search, "_load_cache", lambda path: None)
    monkeypatch.setattr(playlist_search, "_save_cache", lambda path, html: None)
    monkeypatch.setattr(index, "_load_cache", lambda url: None)
    monkeypatch.setattr(index, "_save_cache", Mock())

    asyncio.run(_measure(pages=2, limit=6))
    small_first = [url for url in order if "/playlist/s" in url and not url.rstrip("/").split("/")[-1].isdigit()]
    huge_deep = [url for url in order if "/playlist/huge/" in url and url.rstrip("/").endswith("/3")]
    assert small_first, order
    if huge_deep:
        assert min(order.index(url) for url in small_first) < order.index(huge_deep[0])


def test_scan_reports_metrics_and_reuses_memory_cache(monkeypatch, tmp_path):
    playlists = [(f"p{i}", f"BBC mix {i}") for i in range(8)]
    index._MEM_CACHE.clear()
    monkeypatch.setattr(index, "CACHE_DIR", tmp_path)
    order = _install_fetch(monkeypatch, playlists=playlists, pages_each=1, latency=0.002, real_cache=True)
    first = asyncio.run(_measure(limit=8, pages=1))
    playlist_fetches_first = sum("/playlist/" in url for url in order)
    second = asyncio.run(_measure(limit=8, pages=1))
    playlist_fetches_second = sum("/playlist/" in url for url in order) - playlist_fetches_first
    print(f"\nCACHE first={first['elapsed_ms']}ms hit={first['cache_hit_rate']} "
          f"second={second['elapsed_ms']}ms hit={second['cache_hit_rate']} "
          f"playlist_fetches={playlist_fetches_first}->{playlist_fetches_second} "
          f"server={second.get('server_metrics')}")
    done_metrics = second.get("server_metrics")
    assert done_metrics is not None
    assert "ttfv_ms" in done_metrics
    assert second["elapsed_ms"] < first["elapsed_ms"]
    assert second["cache_hit_rate"] >= 0.99
    assert playlist_fetches_second == 0


def test_local_keyword_filter_dedupe_and_memory_20k():
    import tracemalloc

    items = []
    for i in range(20000):
        title = f"PAWG clip {i}" if i % 20 == 0 else f"other clip {i}"
        items.append({
            "url": f"https://www.eporner.com/hd-porn/v{i}/x/",
            "source_url": f"https://www.eporner.com/hd-porn/v{i}/x/",
            "title": title,
            "thumbnail": f"https://static.example/{i}.jpg",
            "duration": 62,
            "height": 720,
            "views": 12000,
            "uploader": "u",
            "stream_url": "",
            "tags": ["unused"],
        })
    tracemalloc.start()
    slim = index._slim_items(items)
    _current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    t0 = time.perf_counter()
    needle = "pawg"
    hits = [row for row in slim if needle in str(row.get("title") or "").casefold()]
    filter_ms = (time.perf_counter() - t0) * 1000
    t1 = time.perf_counter()
    seen = {}
    for row in slim + slim[:5000]:
        key = row.get("source_url") or row.get("url")
        if key not in seen:
            seen[key] = row
    dedupe_ms = (time.perf_counter() - t1) * 1000
    print(f"\n20k slim peak={peak / 1e6:.1f}MB filter={filter_ms:.1f}ms hits={len(hits)} "
          f"dedupe={dedupe_ms:.1f}ms unique={len(seen)} keys={list(slim[0])}")
    assert "tags" not in slim[0]
    assert "stream_url" not in slim[0]
    assert len(hits) == 1000
    assert filter_ms < 50
    assert dedupe_ms < 50
    assert peak < 25_000_000
    assert len(seen) == 20000


def test_larger_playlists_are_indexed_before_smaller_ones(monkeypatch):
    playlists = [("small", "BBC small"), ("big", "BBC big")]
    html_counts = {"small": 12, "big": 900}

    async def fetch(url: str):
        if "/search-playlists/" in url:
            cards = []
            for pid, title in playlists:
                cards.append(
                    f'<div class="mb"><a href="/playlist/{pid}/clips/">'
                    f'<img alt="{title}" src="https://static.example/{pid}.jpg"></a>'
                    f'<span class="mbphoto2_playlistico">{html_counts[pid]}</span></div>'
                )
            pads = "".join(f'<div class="mb"><a href="/playlist/pad{i}/x/"><img alt="pad"></a></div>' for i in range(40))
            return SimpleNamespace(status_code=200, text="".join(cards) + pads, headers={})
        pid = url.split("/playlist/")[1].split("/")[0]
        return SimpleNamespace(status_code=200, text=_playlist_html(pid, 1, 1, "PAWG bbc"), headers={})

    monkeypatch.setattr(transport, "fetch_listing", fetch)
    monkeypatch.setattr(playlist_search, "_load_cache", lambda path: None)
    monkeypatch.setattr(playlist_search, "_save_cache", lambda path, html: None)
    monkeypatch.setattr(index, "_load_cache", lambda url: None)
    monkeypatch.setattr(index, "_save_cache", Mock())

    async def run():
        found = []
        async for event in index.stream_playlist_scan("bbc", 1, result_limit=2, video_keyword="pawg"):
            if event.get("type") == "playlist":
                found.append(event["item"]["url"])
        return found

    found = asyncio.run(run())
    print(f"\nPRIORITY order={found}")
    assert "/playlist/big/" in found[0]


def test_fetched_size_and_date_are_reused_on_later_listing(tmp_path):
    index._VIDEO_META.clear()
    index.VIDEO_META_DIR = tmp_path
    url = "https://www.eporner.com/hd-porn/abc123/clip/"
    index.remember_video_meta(url, {"size_mb": 812.4, "size_bytes": 851_443_712, "upload_date": "2026-03-15"})
    slim = index._slim_items([{"url": url, "title": "BBC clip", "duration": 62}])
    assert slim[0]["size_mb"] == 812.4
    assert slim[0]["upload_date"] == "2026-03-15"
    cloned = index._clone_items([{"url": url, "title": "BBC clip"}])
    assert cloned[0]["size_mb"] == 812.4


