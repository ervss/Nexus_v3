import asyncio
from unittest.mock import AsyncMock

from app.extractors.camwhores import CamwhoresExtractor
from app.hubs.base import Page
from app.hubs.camwhores import CamwhoresHub
from app.routers import link_tester

MEMBER = "https://www.camwhores.tv/members/15819127/"


def test_camwhores_handles_member_and_watch_urls():
    xv = CamwhoresExtractor()
    assert xv.can_handle(MEMBER)
    assert xv.can_handle("https://www.camwhores.tv/videos/123/clip/")
    assert xv._is_member_url(MEMBER)
    assert not xv._is_member_url("https://www.camwhores.tv/videos/123/clip/")
    assert not xv.can_handle("https://example.com/members/1/")


def test_camwhores_posted_videos_use_profile_pagination(monkeypatch):
    seen = []

    async def fake_get(self, url, referer=""):
        seen.append(url)
        return 200, (
            '<div id="list_videos_uploaded_videos">'
            '<a href="/videos/111/one/"><img alt="One"></a></div>'
        ), url

    monkeypatch.setattr(CamwhoresHub, "_get_html", fake_get)
    monkeypatch.setattr(
        CamwhoresHub,
        "_parse_tiles",
        lambda self, html: [{"url": "https://www.camwhores.tv/videos/111/one/", "title": "One", "duration_sec": 10}],
    )
    page1 = asyncio.run(CamwhoresHub().member_videos(MEMBER, kind="posted", page=1))
    page2 = asyncio.run(CamwhoresHub().member_videos(MEMBER, kind="posted", page=2))
    assert seen[0].rstrip("/").endswith("/members/15819127")
    assert seen[1].endswith("/members/15819127/2/")
    assert page1.items and page2.items


def test_camwhores_member_album_uses_posted_videos(monkeypatch):
    tiles = [
        {
            "url": "https://www.camwhores.tv/videos/111/one/",
            "title": "One",
            "thumb": "https://cdn.example/1.jpg",
            "duration_sec": 90,
            "height": 720,
            "quality": "720p",
        },
        {
            "url": "https://www.camwhores.tv/videos/222/two/",
            "title": "Two",
            "thumb": "https://cdn.example/2.jpg",
            "duration_sec": 120,
            "height": 1080,
            "quality": "1080p",
        },
    ]
    member_videos = AsyncMock(
        side_effect=[
            Page(items=tiles, page=1, has_more=True, extra={}),
            Page(items=[], page=2, has_more=False, extra={}),
        ]
    )
    monkeypatch.setattr(CamwhoresHub, "member_videos", member_videos)
    rows = asyncio.run(
        CamwhoresExtractor().extract_album_entries(MEMBER, max_pages=2, max_entries=50, info={})
    )
    assert [row["source_url"] for row in rows] == [
        "https://www.camwhores.tv/videos/111/one/",
        "https://www.camwhores.tv/videos/222/two/",
    ]
    assert rows[0]["duration"] == 90
    assert member_videos.await_args_list[0].kwargs["kind"] == "posted"


def test_camwhores_member_falls_back_to_favourites_when_uploads_empty(monkeypatch):
    fav = [{
        "url": "https://www.camwhores.tv/videos/333/fav/",
        "title": "Fav",
        "thumb": "",
        "duration_sec": 40,
    }]
    member_videos = AsyncMock(
        side_effect=[
            Page(items=[], page=1, has_more=False, extra={}),
            Page(items=fav, page=1, has_more=False, extra={}),
        ]
    )
    monkeypatch.setattr(CamwhoresHub, "member_videos", member_videos)
    rows = asyncio.run(CamwhoresExtractor().extract_album_entries(MEMBER, max_pages=2))
    assert rows[0]["source_url"].endswith("/videos/333/fav/")
    kinds = [call.kwargs["kind"] for call in member_videos.await_args_list]
    assert kinds[0] == "posted"
    assert "favourites" in kinds


def test_tester_resolves_camwhores_member_without_watch_extract(monkeypatch):
    extractor = CamwhoresExtractor()
    monkeypatch.setattr(
        extractor,
        "extract_album_entries",
        AsyncMock(
            return_value=[{
                "url": "https://www.camwhores.tv/videos/111/one/",
                "source_url": "https://www.camwhores.tv/videos/111/one/",
                "title": "One",
                "thumbnail": "https://cdn.example/1.jpg",
                "duration": 90,
                "stream_url": "",
            }]
        ),
    )
    watch = AsyncMock()
    monkeypatch.setattr(extractor, "extract", watch)
    monkeypatch.setattr(link_tester.ExtractorRegistry, "find_extractor", lambda _: extractor)
    result = asyncio.run(link_tester.resolve_single_url(MEMBER, asyncio.Semaphore(1)))
    assert result["status"] == "success"
    assert result["extractor"] == "Camwhores"
    assert result["data"]["item_count"] == 1
    watch.assert_not_awaited()


def test_tester_uses_discovery_resolver_for_watch_video_and_card_meta(monkeypatch):
    url = "https://www.camwhores.tv/videos/123/clip/"
    extractor = CamwhoresExtractor()
    old_extract = AsyncMock(side_effect=AssertionError("slow watch extractor was called"))
    monkeypatch.setattr(extractor, "extract", old_extract)
    monkeypatch.setattr(link_tester.ExtractorRegistry, "find_extractor", lambda _: extractor)
    fast = AsyncMock(return_value={
        "title": "Clip", "duration": 3840, "height": 720,
        "size_bytes": 664416961, "stream_url": "https://cdn.example/clip.mp4",
        "thumbnail": "https://cdn.example/clip.jpg", "upload_date": "2020-01-02",
    })
    monkeypatch.setattr(link_tester, "_fast_camwhores_detail", fast)
    client, watch_client = object(), object()
    gate = asyncio.Semaphore(6)

    async def run():
        resolved = await link_tester.resolve_single_url(
            url, asyncio.Semaphore(20), client, watch_client, gate,
        )
        meta = await link_tester._fetch_any_meta(
            url, client, asyncio.Semaphore(20), asyncio.Semaphore(1),
            metadata_only=True, full_metadata=True,
            watch_client=watch_client, external_gate=gate,
        )
        return resolved, meta

    resolved, meta = asyncio.run(run())
    assert resolved["status"] == "success"
    assert resolved["data"]["duration"] == 3840
    assert resolved["data"]["size_bytes"] == 664416961
    assert meta["ok"] is True
    assert meta["duration"] == 3840
    assert meta["size_bytes"] == 664416961
    assert fast.await_count == 2
    old_extract.assert_not_awaited()


def test_camwhores_member_sparse_page_keeps_has_more_and_404_stops(monkeypatch):
    async def fake_get(self, url, referer=""):
        if url.endswith("/2/"):
            return 404, "", url
        return 200, (
            '<div id="list_videos_uploaded_videos">'
            '<div class="item"><a href="/videos/1/a/" title="A"></a></div>'
            '<div class="item"><a href="/videos/2/b/" title="B"></a></div>'
            '<div class="item"><a href="/videos/3/c/" title="C"></a></div>'
            '</div>'
        ), url

    monkeypatch.setattr(CamwhoresHub, "_get_html", fake_get)
    p1 = asyncio.run(CamwhoresHub().member_videos(MEMBER, kind="posted", page=1))
    p2 = asyncio.run(CamwhoresHub().member_videos(MEMBER, kind="posted", page=2))
    assert len(p1.items) == 3
    assert p1.has_more is True
    assert p2.items == []
    assert p2.has_more is False
