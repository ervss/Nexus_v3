import asyncio
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pytest

from app.extractors.filester import FilesterExtractor, _solve_fileditch_wasm_pow, _upload_date_from_fields


def test_filester_upload_date_fields_keep_source_timestamp():
    assert _upload_date_from_fields({"created_at": "2026-03-15T10:30:00Z"}) == "2026-03-15T10:30:00+00:00"
    assert _upload_date_from_fields({"upload_date": "1773570600"}) == "2026-03-15T10:30:00+00:00"
    assert _upload_date_from_fields({"updated_at": "2026-03-15T10:30:00Z"}) == ""


def test_filester_file_page_extracts_named_upload_date_only():
    dated = FilesterExtractor._scrape_page_meta(
        '<html><title>Video.mp4 | filester.me</title><script type="application/ld+json">'
        '{"@type":"VideoObject","uploadDate":"2026-03-15T10:30:00Z"}</script></html>',
        "https://filester.me/d/video",
    )
    undated = FilesterExtractor._scrape_page_meta(
        '<html><title>Video.mp4 | filester.me</title><meta property="og:updated_time" content="2026-03-15T10:30:00Z"></html>',
        "https://filester.me/d/video",
    )
    assert dated["uploaded_at"] == "2026-03-15T10:30:00+00:00"
    assert undated["uploaded_at"] == ""


def test_folder_keyword_search_matches_file_names_case_insensitively():
    extractor = FilesterExtractor()

    async def fake_extract_folder(_url, *, require_complete=False):
        assert require_complete
        return [
            {"title": "Summer_Set_01.mp4", "url": "https://filester.me/d/a", "thumbnail": "https://example.com/thumb.jpg", "size_bytes": 42},
            {"title": "Other clip", "url": "https://filester.me/d/SUMMER-set-02"},
            {"title": "", "url": "https://filester.me/d/SUMMER-set-03"},
            {"title": "Nothing here", "url": "https://filester.me/d/c"},
        ]

    extractor.extract_folder = fake_extract_folder
    result = asyncio.run(extractor.search_folder_keyword("https://filester.me/f/abc123", "summer set"))

    assert result["ok"] is True
    assert result["scanned_files"] == 4
    assert result["match_count"] == 2
    assert result["matches"] == ["Summer_Set_01.mp4", "SUMMER-set-03"]
    assert result["matched_items"][0]["thumbnail"] == "https://example.com/thumb.jpg"
    assert result["matched_items"][0]["size_bytes"] == 42


def test_keyword_grid_keeps_all_matches_and_deduplicates_file_urls():
    extractor = FilesterExtractor()

    async def fake_extract_folder(_url, **_kwargs):
        items = [{"title": f"Summer clip {i}", "url": f"https://filester.me/d/{i}"} for i in range(35)]
        return items + [items[0]]

    extractor.extract_folder = fake_extract_folder
    result = asyncio.run(extractor.search_folder_keyword("https://filester.me/f/abc123", "SUMMER"))
    assert result["match_count"] == 35
    assert len(result["matches"]) == 12  # backward-compatible text summary
    assert len(result["matched_items"]) == 35


def test_keyword_search_reports_incomplete_album_as_error():
    extractor = FilesterExtractor()

    async def fake_extract_folder(_url, **_kwargs):
        raise RuntimeError("Neúplný album")

    extractor.extract_folder = fake_extract_folder
    result = asyncio.run(extractor.search_folder_keyword("https://filester.me/f/abc123", "summer"))
    assert result["ok"] is False
    assert "Neúplný" in result["error"]


def test_keyword_search_rejects_blank_keyword_and_invalid_album():
    extractor = FilesterExtractor()
    assert asyncio.run(extractor.search_folder_keyword("https://filester.me/f/abc123", "___"))["ok"] is False
    assert asyncio.run(extractor.search_folder_keyword("https://filester.me/d/file", "summer"))["ok"] is False


@pytest.mark.parametrize("status,html,expected_error", [
    (403, "Blocked", "HTTP 403"),
    (200, "<html>Please sign in</html>", "čitateľné"),
    (200, '<html>2 files<div class="file-item" onclick="location.href=\'/d/a\'"><span class="file-name">Summer.mp4</span></div></html>', "Neúplný"),
    (200, "<html>0 files</html>", None),
])
def test_complete_keyword_scan_does_not_hide_fetch_failures(status, html, expected_error):
    class FixtureClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            pass

        async def get(self, url, **_kwargs):
            return httpx.Response(status, text=html, request=httpx.Request("GET", url))

    with patch("app.extractors.filester.httpx.AsyncClient", FixtureClient), patch("app.extractors.filester._load_api_key", return_value=""), patch("app.extractors.filester._load_cookies_from_paths", return_value={}):
        result = asyncio.run(FilesterExtractor().search_folder_keyword("https://filester.me/f/abc123", "summer"))
    if expected_error:
        assert result["ok"] is False
        assert expected_error in result["error"]
    else:
        assert result["ok"] is True
        assert result["matched_items"] == []

def test_fileditch_pretty_viewer_accepts_underscores_and_rejects_self_link():
    url = "https://fileditchfiles.st/balpha7/bfa2c12707c25_All_Anal_Clip.mp4"

    assert FilesterExtractor()._is_direct_file_viewer(url)

    meta = FilesterExtractor._scrape_direct_viewer(
        f'<html><video src="{url}"></video><a href="{url}">self</a></html>',
        url,
    )

    assert meta["stream_url"] == ""


def test_fileditch_multi_segment_pretty_viewer_routes_to_direct_extractor():
    url = "https://fileditchfiles.st/charlie26/0/a98a5156621b7/Charli_Rose_video.mp4"
    extractor = FilesterExtractor()

    assert extractor.can_handle(url)
    assert extractor._is_direct_file_viewer(url)


def test_fileditch_wasm_solver_survives_form_navigation(monkeypatch):
    stream = "https://beta.fileditchstuff5sept.com/alpha24/hash/video.mp4?md5=fresh"

    class FakePage:
        def __init__(self):
            self.player_checks = 0
            self.response_handlers = {}

        def on(self, event_name, handler):
            self.response_handlers[event_name] = handler

        async def goto(self, *_args, **_kwargs):
            return None

        async def evaluate(self, script):
            if "document.querySelector" in script:
                self.player_checks += 1
                if self.player_checks == 1:
                    raise RuntimeError("Execution context was destroyed because of a navigation")
                return stream
            return "492.27 MB"

        async def wait_for_timeout(self, _milliseconds):
            return None

        async def query_selector(self, _selector):
            return None

        async def title(self):
            return ""

    class FakeContext:
        async def add_cookies(self, _cookies):
            return None

        async def add_init_script(self, _script):
            return None

        async def new_page(self):
            return FakePage()

    class FakeBrowser:
        async def new_context(self, **_kwargs):
            return FakeContext()

        async def close(self):
            return None

    class FakeChromium:
        async def launch(self, **_kwargs):
            return FakeBrowser()

    class FakePlaywrightManager:
        async def __aenter__(self):
            return SimpleNamespace(chromium=FakeChromium())

        async def __aexit__(self, *_args):
            return None

    monkeypatch.setattr(
        "app.extractors.filester._load_async_playwright",
        lambda: lambda: FakePlaywrightManager(),
    )

    result = asyncio.run(_solve_fileditch_wasm_pow("https://fileditchfiles.st/a/video.mp4"))

    assert result["stream_url"] == stream
    assert result["size_bytes"] > 0


def test_shared_extractor_reports_real_fileditch_brand():
    extractor = FilesterExtractor()
    assert extractor.source_label("https://fileditchfiles.st/a/video.mp4") == "FileDitch"
    assert extractor.source_label("https://filester.me/d/abc") == "Filester"
