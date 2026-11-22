import asyncio
import re
from unittest.mock import AsyncMock

from app.extractors.eporner import EpornerExtractor
from app.extractors.xvideos import XVideosExtractor
from app.routers import link_tester


def _xv_card(video_href: str, title: str = "Clip") -> str:
    return (
        f'<div class="thumb-block"><p class="title">'
        f'<a href="{video_href}" title="{title}">{title}</a></p>'
        f'<span class="duration">12 min</span></div>'
    )


def _xv_photo_card() -> str:
    return (
        '<div class="thumb-block"><a href="/profiles/zonehentai/photos/1/album">pic</a></div>'
    )


def test_eporner_playlist_without_streamevents_still_extracts_cards(monkeypatch):
    html = """
    <div class="mb">
      <p class="mbtit"><a href="/video-abc123/clip-one/">Clip one</a></p>
      <span class="mbtim">1:02</span>
    </div>
    """
    monkeypatch.setattr(
        "app.extractors.base.ntc_get",
        AsyncMock(return_value=html),
    )
    rows = asyncio.run(
        EpornerExtractor().extract_album_entries(
            "https://www.eporner.com/playlist/0QjmmMr6z9T/ExtremeLatinas/"
        )
    )
    assert len(rows) == 1
    assert "video-abc123" in rows[0]["url"]
    assert rows[0]["duration"] == 62


def test_xvideos_listing_regex_ignores_tag_search():
    xv = XVideosExtractor()
    assert xv._is_listing_url("https://www.xvideos.com/favorite/123/my-list")
    assert xv._is_listing_url("https://www.xvideos.com/profiles/demo")
    assert not xv._is_listing_url("https://www.xvideos.com/tags/playlist/")
    assert not xv._is_listing_url("https://www.xvideos.com/video.abc123/title")


def test_xvideos_photo_profile_does_not_paginate_or_ytdlp(monkeypatch):
    ntc = AsyncMock(return_value=_xv_photo_card() * 8)
    monkeypatch.setattr("app.extractors.xvideos.ntc_get", ntc)
    ytdlp = AsyncMock()
    extractor = XVideosExtractor()
    monkeypatch.setattr(extractor, "extract", ytdlp)
    rows = asyncio.run(
        extractor.extract_album_entries("https://www.xvideos.com/profiles/zonehentai")
    )
    assert rows == []
    assert ntc.await_count == 1
    monkeypatch.setattr(link_tester.ExtractorRegistry, "find_extractor", lambda _: extractor)
    result = asyncio.run(
        link_tester.resolve_single_url(
            "https://www.xvideos.com/profiles/zonehentai",
            asyncio.Semaphore(1),
        )
    )
    assert result["status"] == "error"
    ytdlp.assert_not_awaited()


def _eporner_card(video_id: str) -> str:
    return (
        '<div class="mb"><p class="mbtit">'
        f'<a href="/video-{video_id}/clip/">Clip {video_id}</a></p>'
        '<span class="mbtim">1:00</span></div>'
    )


def test_eporner_playlist_walks_every_page_when_uncapped(monkeypatch):
    pages = {
        "https://www.eporner.com/playlist/abc/name/": (
            "".join(_eporner_card(f"a{i}") for i in range(40))
            + '<div class="numlist2"><a href="/playlist/abc/name/2/">2</a></div>'
        ),
        "https://www.eporner.com/playlist/abc/name/2/": "".join(
            _eporner_card(f"b{i}") for i in range(25)
        ),
    }

    async def fake_ntc(url, **_kwargs):
        return pages[url.rstrip("/") + "/"]

    monkeypatch.setattr("app.extractors.base.ntc_get", fake_ntc)
    info: dict = {}
    rows = asyncio.run(
        EpornerExtractor().extract_album_entries(
            "https://www.eporner.com/playlist/abc/name/",
            max_pages=0,
            info=info,
        )
    )
    assert len(rows) == 65
    assert info.get("truncated") is not True
    assert info.get("pages_loaded") == 2


def test_tester_loads_whole_eporner_playlist(monkeypatch):
    seen = {}

    async def fake_extract(url, **kwargs):
        seen.update(kwargs)
        return [
            {
                "url": f"https://www.eporner.com/video-id{i}/clip/",
                "title": f"Clip {i}",
                "thumbnail": "",
                "duration": 60,
            }
            for i in range(65)
        ]

    extractor = EpornerExtractor()
    monkeypatch.setattr(extractor, "extract_album_entries", fake_extract)
    monkeypatch.setattr(link_tester.ExtractorRegistry, "find_extractor", lambda _: extractor)
    monkeypatch.setattr(link_tester, "_eporner_playlist_upload_date", AsyncMock(return_value=""))
    result = asyncio.run(
        link_tester.resolve_single_url(
            "https://www.eporner.com/playlist/abc/name/",
            asyncio.Semaphore(1),
        )
    )
    assert "max_entries" not in seen
    assert seen.get("max_pages") == 0
    assert result["status"] == "success"
    assert result["data"]["item_count"] == 65
    assert len(result["data"]["album_items"]) == 65
    assert result["data"]["playlist_has_more"] is False


def test_tester_caps_xvideos_listing_pages(monkeypatch):
    calls = []

    async def fake_ntc(url, **_kwargs):
        calls.append(url)
        page = 0
        m = re.search(r"/(\d+)$", url.rstrip("/"))
        if m:
            page = int(m.group(1))
        return "".join(_xv_card(f"/video.{page}-{i}/clip-{page}-{i}") for i in range(8))

    monkeypatch.setattr("app.extractors.xvideos.ntc_get", fake_ntc)
    extractor = XVideosExtractor()
    monkeypatch.setattr(link_tester.ExtractorRegistry, "find_extractor", lambda _: extractor)
    result = asyncio.run(
        link_tester.resolve_single_url(
            "https://www.xvideos.com/favorite/99/demo",
            asyncio.Semaphore(1),
        )
    )
    assert result["status"] == "success"
    assert result["data"]["item_count"] == 16
    assert result["data"]["playlist_has_more"] is True
    assert len(calls) == 2


def test_batch_meta_uses_listing_card_cache(monkeypatch):
    link_tester._listing_meta_cache_clear()
    child = "https://www.xvideos.com/video.abc/clip"
    link_tester._remember_listing_meta(
        child,
        {"title": "From card", "duration": 720, "thumbnail": "https://img/t.jpg", "height": 720},
    )
    fetch = AsyncMock()
    monkeypatch.setattr(link_tester, "_fetch_xvideos_meta", fetch)
    result = asyncio.run(
        link_tester._fetch_any_meta(
            child,
            None,
            asyncio.Semaphore(1),
            asyncio.Semaphore(1),
            metadata_only=True,
        )
    )
    assert result["ok"] is True
    assert result["title"] == "From card"
    assert result["duration"] == 720
    fetch.assert_not_awaited()
