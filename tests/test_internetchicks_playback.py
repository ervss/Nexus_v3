import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app.extractors.internetchicks import InternetChicksExtractor


def test_internetchicks_refresh_uses_verified_player(monkeypatch):
    page = """
    <h1>Example video</h1>
    <button class="button_choice_server" onclick="playEmbed('https://streamtape.com/e/first');">P01</button>
    <button class="button_choice_server" onclick="playEmbed('https://voe.sx/e/best');">P02</button>
    <button class="button_choice_server" onclick="playEmbed('https://ads.example/track');">ad</button>
    """

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            pass

        async def get(self, url):
            assert url == "https://internetchicks.com/example/"
            return SimpleNamespace(text=page, raise_for_status=lambda: None)

    checker = AsyncMock(return_value=[
        SimpleNamespace(direct_url="https://streamtape.com/get_video?id=first", size_bytes=10),
        SimpleNamespace(direct_url="https://cdn.example/best.m3u8", size_bytes=20, quality="720p"),
    ])
    monkeypatch.setattr("app.extractors.internetchicks.httpx.AsyncClient", lambda **_: Client())
    monkeypatch.setattr("app.checkers.orchestrator.CheckerOrchestrator.check_batch", checker)

    data = asyncio.run(InternetChicksExtractor().extract("https://internetchicks.com/example/"))
    assert data["stream_url"] == "https://cdn.example/best.m3u8"
    assert data["playback_referer"] == "https://voe.sx/e/best"
    assert data["source_url"] == "https://internetchicks.com/example/"
    assert data["is_hls"] is True
    checker.assert_awaited_once_with(["https://streamtape.com/e/first", "https://voe.sx/e/best"])
