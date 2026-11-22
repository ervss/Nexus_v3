import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from app import main
from app import extractors
from app.extractors.registry import ExtractorRegistry


FILEDITCH_PAGE = "https://fileditchfiles.st/alpha24/hash/video.mp4"
SIGNED_STREAM = "https://beta.fileditchstuff5sept.com/alpha24/hash/video.mp4?md5=fresh&expires=9"


def test_playback_resolver_uses_fileditch_brand_and_caches_signed_stream(monkeypatch):
    video = SimpleNamespace(
        id=26684,
        storage_type="remote",
        source_url=FILEDITCH_PAGE,
        url=FILEDITCH_PAGE,
        height=0,
        width=0,
        duration=0,
    )
    db = MagicMock()
    db.query.return_value.get.return_value = video
    extractor = SimpleNamespace(
        name="Filester",
        source_label=lambda _url: "FileDitch",
        extract=AsyncMock(return_value={"stream_url": SIGNED_STREAM, "duration": 1558.5}),
    )
    monkeypatch.setattr(extractors, "init_registry", lambda: None)
    monkeypatch.setattr(extractors, "register_extended_extractors", lambda: None)
    monkeypatch.setattr(ExtractorRegistry, "find_extractor", lambda _url: extractor)

    result = asyncio.run(main.resolve_library_video_stream(video.id, db=db))

    assert result["extractor"] == "FileDitch"
    assert result["stream_url"] == SIGNED_STREAM
    assert video.url == SIGNED_STREAM
    assert video.duration == 1558.5
    db.commit.assert_called_once()


def test_playback_resolver_reuses_a_still_live_fileditch_cdn_stream(monkeypatch):
    video = SimpleNamespace(
        id=26684,
        storage_type="remote",
        source_url=FILEDITCH_PAGE,
        url=SIGNED_STREAM,
        height=0,
        width=0,
        duration=1558.5,
    )
    db = MagicMock()
    db.query.return_value.get.return_value = video
    extractor = SimpleNamespace(name="Filester", extract=AsyncMock())
    monkeypatch.setattr(extractors, "init_registry", lambda: None)
    monkeypatch.setattr(extractors, "register_extended_extractors", lambda: None)
    monkeypatch.setattr(ExtractorRegistry, "find_extractor", lambda _url: extractor)

    response = SimpleNamespace(
        status=206,
        headers={"Content-Type": "video/mp4"},
        __aenter__=AsyncMock(),
        __aexit__=AsyncMock(return_value=None),
    )
    response.__aenter__.return_value = response
    request_context = MagicMock()
    request_context.__aenter__ = AsyncMock(return_value=response)
    request_context.__aexit__ = AsyncMock(return_value=None)
    session = MagicMock()
    session.__aenter__ = AsyncMock(return_value=session)
    session.__aexit__ = AsyncMock(return_value=None)
    session.get.return_value = request_context
    monkeypatch.setattr(main.aiohttp, "ClientSession", lambda **_kwargs: session)

    result = asyncio.run(main.resolve_library_video_stream(video.id, db=db))

    assert result["extractor"] == "FileDitch"
    assert result["stream_url"] == SIGNED_STREAM
    extractor.extract.assert_not_awaited()


def test_dashboard_routes_fileditch_viewer_through_jit_before_playback():
    frontend = Path("app/static/main.js").read_text(encoding="utf-8")
    backend = Path("app/main.py").read_text(encoding="utf-8")

    assert "const _isFileDitchViewer" in frontend
    assert "_needsGenericPlaybackResolve = _isPimpBunny || _isFileDitchViewer" in frontend
    assert "_is_fileditch_page" in backend
    assert "_fe_fresh.source_label(_jit_page)" in backend
