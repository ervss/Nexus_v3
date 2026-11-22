import asyncio

import httpx

from app.extractors.turbo import TurboExtractor
from app.extractors.registry import ExtractorRegistry
from app.routers.link_tester import _extract_turbo_id, resolve_single_url


def test_turbo_a_route_is_an_album_not_a_direct_video():
    extractor = TurboExtractor()
    url = "https://turbo.cr/a/Av9QN4gNGoD"

    assert extractor._extract_id(url) == ""
    assert extractor._canonical_watch_url(url) == url
    assert _extract_turbo_id(url) == ""


def test_turbo_keeps_legacy_video_route_compatible():
    extractor = TurboExtractor()

    assert extractor._extract_id("https://turbo.cr/v/legacyVideo") == "legacyVideo"
    assert extractor._canonical_watch_url("https://turbo.cr/v/legacyVideo") == "https://turbo.cr/v/legacyVideo"


def test_turbo_extract_uses_video_watch_route_and_signs_stream():
    calls = []

    class Response:
        is_success = True
        text = '<html><head><title>Current video | turbo.cr</title></head></html>'

        def json(self):
            return {"url": "https://cdn1.turbocdn.st/current.mp4?token=fresh"}

        def raise_for_status(self):
            return None

    class Client:
        async def get(self, url, **_kwargs):
            calls.append(url)
            return Response()

    result = asyncio.run(TurboExtractor()._extract_with_client("https://turbo.cr/v/currentVideo", Client()))

    assert calls == [
        "https://turbo.cr/v/currentVideo",
        "https://turbo.cr/api/sign?v=currentVideo",
    ]
    assert result["stream_url"] == "https://cdn1.turbocdn.st/current.mp4?token=fresh"
    assert result["thumbnail"] == (
        "https://static.scdn.st/6049fd43-838b-492d-a20a-9aead716dfe7/thumbs/currentVideo.jpg"
    )


def test_turbo_parses_current_files_block_with_metadata():
    html = '''
    <html><body><h1>Blowjob</h1><script>
    const FILES = [
      { id:"G1Yk1rLLBHs", name:"G1Yk1rLLBHs.mp4", size: 65497956,
        views: 3, thumb:"https:\\/\\/static.scdn.st\\/album\\/thumbs\\/G1Yk1rLLBHs.jpg", dur: 42 },
    ];
    </script></body></html>
    '''

    entries = TurboExtractor()._parse_album_entries(html, "https://turbo.cr/a/Av9QN4gNGoD")

    assert entries == [{
        "id": "G1Yk1rLLBHs",
        "title": "G1Yk1rLLBHs.mp4",
        "album_title": "Blowjob",
        "url": "https://turbo.cr/v/G1Yk1rLLBHs",
        "source_url": "https://turbo.cr/v/G1Yk1rLLBHs",
        "album_url": "https://turbo.cr/a/Av9QN4gNGoD",
        "thumbnail": "https://static.scdn.st/album/thumbs/G1Yk1rLLBHs.jpg",
        "duration": 42,
        "size_bytes": 65497956,
        "size_mb": 62.5,
        "views": 3,
        "stream_url": "",
        "is_hls": False,
    }]


def test_single_video_turbo_album_stays_an_album(monkeypatch):
    class OneVideoTurbo:
        name = "Turbo"

        async def extract_album_entries(self, url):
            return [{
                "title": "G1Yk1rLLBHs.mp4",
                "album_title": "Blowjob",
                "url": "https://turbo.cr/v/G1Yk1rLLBHs",
                "source_url": "https://turbo.cr/v/G1Yk1rLLBHs",
                "thumbnail": "https://static.scdn.st/thumb.jpg",
                "size_bytes": 65497956,
            }]

        async def extract(self, _url):
            raise AssertionError("an album URL must not go through direct extraction")

    monkeypatch.setattr(ExtractorRegistry, "find_extractor", lambda _url: OneVideoTurbo())
    result = asyncio.run(resolve_single_url("https://turbo.cr/a/Av9QN4gNGoD", asyncio.Semaphore(1)))

    assert result["status"] == "success"
    assert result["data"]["kind"] == "album"
    assert result["data"]["title"] == "Blowjob"
    assert result["data"]["video_count"] == 1
    assert result["data"]["album_items"][0]["url"] == "https://turbo.cr/v/G1Yk1rLLBHs"


def test_tester_labels_removed_turbo_video_as_source_404(monkeypatch):
    class RemovedTurbo:
        name = "Turbo"

        def can_handle(self, _url):
            return True

        async def extract_album(self, _url):
            return []

        async def extract(self, url):
            request = httpx.Request("GET", url)
            response = httpx.Response(404, request=request)
            raise httpx.HTTPStatusError("not found", request=request, response=response)

    monkeypatch.setattr(ExtractorRegistry, "find_extractor", lambda _url: RemovedTurbo())
    result = asyncio.run(resolve_single_url("https://turbo.cr/v/removedVideo", asyncio.Semaphore(1)))

    assert result["retryable"] is False
    assert result["message"] == "Turbo video už na zdroji nie je dostupné (HTTP 404)."
