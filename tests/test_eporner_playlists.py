import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app import eporner_transport as transport
from app.extractors.eporner import EpornerExtractor
from app.hubs import eporner as hub
from app.routers import link_tester

URL = "https://www.eporner.com/profile/demo/playlist/abc/clips/"


@pytest.fixture
def route(monkeypatch):
    monkeypatch.setattr(transport, "_tor_until", 0.0)
    monkeypatch.setattr(transport, "_cooldown_until", 0.0)
    monkeypatch.setattr(hub, "_throttle", AsyncMock())
    monkeypatch.setattr(hub, "_network_mode", lambda: "auto")
    from app.tor_service import tor_service
    monkeypatch.setattr(tor_service, "status", lambda: {"ready": True})


def test_transport_failure_uses_configured_fallback_and_remembers_route(monkeypatch, route):
    response = SimpleNamespace(status_code=200, text="ok", headers={})
    get = Mock(side_effect=[TimeoutError(), response, response])
    monkeypatch.setattr(hub, "_cget", get)

    async def run():
        assert await transport.fetch_listing(URL) is response
        assert await transport.fetch_listing(URL) is response

    asyncio.run(run())
    assert [call.kwargs["force_tor"] for call in get.call_args_list] == [False, True, True]


def test_rate_limit_respects_retry_after_without_switching_route(monkeypatch, route):
    get = Mock(return_value=SimpleNamespace(status_code=429, headers={"Retry-After": "120"}))
    monkeypatch.setattr(hub, "_cget", get)

    async def run():
        with pytest.raises(transport.EpornerListingError, match="120 s"):
            await transport.fetch_listing(URL)
        with pytest.raises(transport.EpornerListingError, match="počkaj"):
            await transport.fetch_listing(URL)

    asyncio.run(run())
    assert get.call_count == 1
    assert not get.call_args.kwargs["force_tor"]


def test_direct_mode_does_not_switch_to_tor(monkeypatch, route):
    monkeypatch.setattr(hub, "_network_mode", lambda: "direct")
    get = Mock(side_effect=TimeoutError())
    monkeypatch.setattr(hub, "_cget", get)
    with pytest.raises(transport.EpornerListingError, match="spojenie zlyhalo"):
        asyncio.run(transport.fetch_listing(URL))
    assert get.call_count == 1


def test_import_playlist_uses_same_extractor(monkeypatch):
    from app.services import extract_playlist_urls
    rows = [{"source_url": "https://www.eporner.com/hd-porn/abc/clip/"}]
    extract = AsyncMock(return_value=rows)
    monkeypatch.setattr(EpornerExtractor, "extract_album_entries", extract)
    assert asyncio.run(extract_playlist_urls(URL)) == [rows[0]["source_url"]]
    extract.assert_awaited_once_with(URL)


def test_listing_scopes_playlist_accepts_legacy_links_and_follows_real_pages(monkeypatch):
    monkeypatch.setenv("EPORNER_NETWORK_MODE", "tor")
    def card(href):
        return f'<div class="mb"><p class="mbtit"><a href="{href}">Clip</a></p><span class="mbtim">1:02</span></div>'

    first = card("/video-sidebar/ignore/") + '<div class="streamevents">' + card("/hd-porn/abc/clip/") + '<div class="numlist2"><a href="2/">2</a></div></div>'
    second = '<div class="streamevents">' + card("/video-def/clip/") + '</div>'
    fetch = AsyncMock(side_effect=[SimpleNamespace(status_code=200, text=first), SimpleNamespace(status_code=200, text=second)])
    monkeypatch.setattr(transport, "fetch_listing", fetch)
    rows = asyncio.run(EpornerExtractor().extract_album_entries(URL))
    assert len(rows) == 2
    assert all(row["duration"] == 62 for row in rows)
    assert [call.args[0] for call in fetch.call_args_list] == [URL, URL + "2/"]
    assert "hd-porn/abc" in rows[0]["url"]


def test_empty_playlist_never_resolves_as_video_or_retries(monkeypatch):
    extractor = EpornerExtractor()
    monkeypatch.setattr(extractor, "extract_album_entries", AsyncMock(return_value=[]))
    video = AsyncMock()
    monkeypatch.setattr(extractor, "extract", video)
    monkeypatch.setattr(link_tester.ExtractorRegistry, "find_extractor", lambda _: extractor)
    result = asyncio.run(link_tester.resolve_single_url(URL, asyncio.Semaphore(1)))
    assert result["status"] == "error"
    assert result["retryable"] is False
    video.assert_not_awaited()
    assert extractor.extract_album_entries.await_count == 1


def test_listing_transport_error_is_clear_and_not_retried(monkeypatch):
    extractor = EpornerExtractor()
    fetch = AsyncMock(side_effect=transport.EpornerListingError("Eporner HTTP 429"))
    monkeypatch.setattr(extractor, "extract_album_entries", fetch)
    monkeypatch.setattr(link_tester.ExtractorRegistry, "find_extractor", lambda _: extractor)
    result = asyncio.run(link_tester.resolve_single_url(URL, asyncio.Semaphore(1)))
    assert "429" in result["message"]
    assert result["retryable"] is False
    assert fetch.await_count == 1


def test_playlist_card_uses_newest_child_upload_date(monkeypatch):
    extractor = EpornerExtractor()
    monkeypatch.setattr(
        extractor,
        "extract_album_entries",
        AsyncMock(return_value=[
            {
                "url": "https://www.eporner.com/hd-porn/first/demo/",
                "source_url": "https://www.eporner.com/hd-porn/first/demo/",
                "title": "First",
                "thumbnail": "",
                "duration": 60,
                "upload_date": "2026-09-10",
            },
            {
                "url": "https://www.eporner.com/hd-porn/second/demo/",
                "source_url": "https://www.eporner.com/hd-porn/second/demo/",
                "title": "Second",
                "thumbnail": "",
                "duration": 70,
                "upload_date": "2026-09-12",
            },
        ]),
    )
    monkeypatch.setattr(link_tester.ExtractorRegistry, "find_extractor", lambda _: extractor)

    result = asyncio.run(link_tester.resolve_single_url(URL, asyncio.Semaphore(1)))

    assert result["status"] == "success"
    assert result["data"]["upload_date"] == "2026-09-12"


def test_eporner_playlist_falls_back_to_first_video_upload_date(monkeypatch):
    extractor = EpornerExtractor()
    monkeypatch.setattr(
        extractor,
        "extract_album_entries",
        AsyncMock(return_value=[
            {
                "url": "https://www.eporner.com/hd-porn/first/demo/",
                "source_url": "https://www.eporner.com/hd-porn/first/demo/",
                "title": "First",
                "thumbnail": "",
                "duration": 60,
            },
            {
                "url": "https://www.eporner.com/hd-porn/second/demo/",
                "source_url": "https://www.eporner.com/hd-porn/second/demo/",
                "title": "Second",
                "thumbnail": "",
                "duration": 70,
            },
        ]),
    )
    monkeypatch.setattr(link_tester.ExtractorRegistry, "find_extractor", lambda _: extractor)
    fetch_enrich_html = AsyncMock(return_value=(200, '<script type="application/ld+json">{"uploadDate":"2026-09-14"}</script>'))
    monkeypatch.setattr(hub.EpornerHub, "_fetch_enrich_html", fetch_enrich_html)
    monkeypatch.setattr(hub.EpornerHub, "_watch_upload_date", lambda self, html: "2026-09-14")

    result = asyncio.run(link_tester.resolve_single_url(URL, asyncio.Semaphore(1)))

    assert result["status"] == "success"
    assert result["data"]["upload_date"] == "2026-09-14"


WATCH_HTML = """
<title>Clip - EPORNER</title>
<meta property="og:duration" content="90">
<meta itemprop="uploadDate" content="2026-03-12T00:00:00">
<a href="/dload/abc/720/clip-720.mp4">MP4 (720p, h264, 100.5 MB)</a>
<a href="/dload/abc/2160/clip-av1.mp4">MP4 (2160p, av1, 800 MB)</a>
<a href="/dload/abc/2160/clip-h264.mp4">MP4 (2160p, h264, 2744.25 MB)</a>
<script>{"2160p":"https://cdn.example.com/clip.mp4"}</script>
"""


def test_listed_download_picks_highest_largest_file():
    best = EpornerExtractor.best_listed_download(WATCH_HTML)
    assert best["height"] == 2160
    assert best["size_mb"] == 2744.2
    assert best["size_bytes"] == int(2744.25 * 1024 * 1024)
    assert best["filename"] == "clip-h264.mp4"


def test_parse_watch_page_meta_reads_size_and_date_without_stream():
    meta = EpornerExtractor.parse_watch_page_meta(WATCH_HTML)
    assert meta["size_mb"] == 2744.2
    assert meta["height"] == 2160
    assert meta["duration"] == 90
    assert meta["upload_date"].startswith("2026-03-12")
    assert not meta.get("stream_url")


def test_extract_returns_download_table_size(monkeypatch):
    class _FailHead:
        status = 403
        url = "https://www.eporner.com/login/"
        headers = {}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

    class _Session:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        def head(self, *args, **kwargs):
            return _FailHead()

    monkeypatch.setattr("aiohttp.ClientSession", _Session)
    result = asyncio.run(EpornerExtractor().extract(
        "https://www.eporner.com/video-abc/clip/",
        pre_fetched_html=WATCH_HTML,
    ))
    assert result["height"] == 2160
    assert result["size_mb"] == 2744.2
    assert result["size_bytes"] == int(2744.25 * 1024 * 1024)
    assert result["filename"] == "clip-h264.mp4"
    assert result["size_estimated"] is True


def test_resolve_meta_preserves_download_filename():
    meta = link_tester._meta_from_resolve_payload({
        "url": "https://www.eporner.com/video-abc/clip/",
        "status": "success",
        "data": {"title": "Clip", "filename": "clip-2160-h264.mp4", "stream_url": "https://cdn.example/clip.mp4"},
    })
    assert meta["filename"] == "clip-2160-h264.mp4"


def test_playlist_card_sums_child_file_sizes(monkeypatch):
    extractor = EpornerExtractor()
    monkeypatch.setattr(
        extractor,
        "extract_album_entries",
        AsyncMock(return_value=[
            {
                "url": "https://www.eporner.com/hd-porn/first/demo/",
                "source_url": "https://www.eporner.com/hd-porn/first/demo/",
                "title": "First",
                "duration": 60,
                "size_mb": 100.0,
            },
            {
                "url": "https://www.eporner.com/hd-porn/second/demo/",
                "source_url": "https://www.eporner.com/hd-porn/second/demo/",
                "title": "Second",
                "duration": 70,
                "size_bytes": 50 * 1024 * 1024,
            },
        ]),
    )
    monkeypatch.setattr(link_tester.ExtractorRegistry, "find_extractor", lambda _: extractor)
    monkeypatch.setattr(link_tester, "_eporner_playlist_upload_date", AsyncMock(return_value=""))

    result = asyncio.run(link_tester.resolve_single_url(URL, asyncio.Semaphore(1)))
    expected = int(100.0 * 1024 * 1024) + 50 * 1024 * 1024
    assert result["status"] == "success"
    assert result["data"]["duration"] == 130
    assert result["data"]["size_bytes"] == expected
    assert result["data"]["album_size_bytes"] == expected


def test_playlist_search_uses_listing_transport(monkeypatch):
    import app.eporner_playlist_search as playlist_search

    html = (
        '<div class="mb"><a href="/playlist/abc123/toy-box/" title="Toy Box">'
        '<img alt="Toy Box"></a><span class="mbphoto2_playlistico">12</span></div>'
    )
    fetch = AsyncMock(return_value=SimpleNamespace(status_code=200, text=html, headers={}))
    monkeypatch.setattr(transport, "fetch_listing", fetch)
    monkeypatch.setattr(playlist_search, "_load_cache", lambda path: None)
    monkeypatch.setattr(playlist_search, "_save_cache", lambda path, html: None)

    results, stopped, pages = asyncio.run(
        playlist_search.search_playlists("toy", 1, result_limit=5)
    )

    assert fetch.await_count == 1
    assert "search-playlists/" in fetch.await_args.args[0]
    assert results[0]["id"] == "abc123"
    assert stopped is False
    assert pages == 1


def test_playlist_search_page_one_transport_error_raises(monkeypatch):
    import app.eporner_playlist_search as playlist_search

    monkeypatch.setattr(playlist_search, "_load_cache", lambda path: None)
    monkeypatch.setattr(
        transport,
        "fetch_listing",
        AsyncMock(side_effect=transport.EpornerListingError("Eporner: spojenie zlyhalo (timeout/proxy).")),
    )

    with pytest.raises(transport.EpornerListingError, match="prvej stránke"):
        asyncio.run(playlist_search.search_playlists("toys", 3, result_limit=5))


def test_listing_cards_capture_quality_views_rating_without_watch_fetch(monkeypatch):
    monkeypatch.setenv("EPORNER_NETWORK_MODE", "tor")
    html = """
    <div class="streamevents">
      <div class="mb">
        <p class="mbtit"><a href="/hd-porn/abc/pawg-clip/">PAWG clip</a></p>
        <span class="mbtim">12:04</span>
        <div class="mvhdico"><div>1080p</div></div>
        <span class="mbvie">1.2M</span>
        <span class="mbrate">87%</span>
        <span class="mbadded">2 days ago</span>
        <img data-src="https://static.example/t.jpg" alt="PAWG clip">
      </div>
    </div>
    """
    monkeypatch.setattr(transport, "fetch_listing", AsyncMock(return_value=SimpleNamespace(status_code=200, text=html)))
    rows = asyncio.run(EpornerExtractor().extract_album_entries(URL))
    assert len(rows) == 1
    assert rows[0]["duration"] == 724
    assert rows[0]["height"] == 1080
    assert rows[0]["views"] == 1_200_000
    assert rows[0]["rating"] == "87%"
    assert rows[0]["upload_date"] == "2 days ago"
    assert rows[0]["stream_url"] == ""


def test_playlist_search_yields_matches_before_later_pages(monkeypatch):
    import app.eporner_playlist_search as playlist_search

    events = []

    def playlist_html(pid, title):
        return (
            f'<div class="mb"><a href="/playlist/{pid}/clips/">'
            f'<img alt="{title}" src="https://static.example/{pid}.jpg"></a>'
            f'<span class="mbphoto2_playlistico">12</span></div>'
        )

    async def fetch(url):
        page = 2 if "/2/" in url or url.rstrip("/").endswith("/2") else 1
        if page == 1:
            html = playlist_html("aaa", "BBC mix") + playlist_html("zzz", "other")
            html += "".join(f'<div class="mb"><a href="/playlist/p{i}/x/"><img alt="pad {i}"></a></div>' for i in range(40))
            return SimpleNamespace(status_code=200, text=html, headers={})
        await asyncio.sleep(0.05)
        html = playlist_html("bbb", "BBC later")
        html += "".join(f'<div class="mb"><a href="/playlist/q{i}/x/"><img alt="pad {i}"></a></div>' for i in range(40))
        return SimpleNamespace(status_code=200, text=html, headers={})

    monkeypatch.setattr(transport, "fetch_listing", fetch)
    monkeypatch.setattr(playlist_search, "_load_cache", lambda path: None)
    monkeypatch.setattr(playlist_search, "_save_cache", lambda path, html: None)

    async def run():
        async for event in playlist_search.iter_search_playlists("bbc", 2, result_limit=5):
            events.append((event["type"], event.get("item", {}).get("id"), event.get("pages_scanned")))
            if event["type"] == "playlist" and event["item"]["id"] == "aaa":
                assert not any(row[1] == "bbb" for row in events)

    asyncio.run(run())
    assert events[0][0] == "playlist"
    assert events[0][1] == "aaa"
    assert any(kind == "playlist" and pid == "bbb" for kind, pid, _ in events)
    assert events[-1][0] == "done"
    assert events[-1][2] == 2
