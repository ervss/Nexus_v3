import pytest
import time
from app.playback_engine import (
    build_playback_contract,
    get_cached_playback,
    set_cached_playback,
    clear_cache,
    is_drm_protected,
)


def setup_function():
    clear_cache()


def test_build_playback_contract_telegram_fast_path():
    url = "https://t.me/c/123/456"
    data = {
        "stream_url": "/api/v1/telegram/stream/123/456",
        "title": "Telegram Video",
    }
    contract = build_playback_contract(url, data, "Telegram")
    assert contract["type"] == "direct"
    assert contract["format"] == "mp4"
    assert contract["playback_url"] == "/api/v1/telegram/stream/123/456"
    assert contract["fallback_url"] is None
    assert contract["iframe"] is False


def test_build_playback_contract_embed_byse():
    url = "https://hornysimp.com/post/123"
    data = {
        "stream_url": "https://bysezoxexe.com/e/abc123xyz",
        "embed_urls": ["https://bysezoxexe.com/e/abc123xyz"],
        "playback_referer": "https://hornysimp.com/",
    }
    contract = build_playback_contract(url, data, "HornySimp")
    assert contract["type"] == "embed"
    assert contract["iframe"] is True
    assert "/e/abc123xyz" in contract["playback_url"]
    assert "upstream=" in contract["playback_url"]
    assert "bysezoxexe.com" in contract["playback_url"]


def test_build_playback_contract_direct_stream_preserves_over_embed():
    url = "https://leakporner.com/video/123"
    data = {
        "stream_url": "https://cdn1030.cdn-tnmr.org/hls2/master.m3u8",
        "embed_urls": ["https://bysezoxexe.com/e/abc123xyz"],
        "is_hls": True,
        "playback_referer": url,
    }
    contract = build_playback_contract(url, data, "LeakPorner")
    assert contract["type"] == "proxy"
    assert contract["format"] == "hls"
    assert contract["iframe"] is False
    assert "/hls_proxy?url=" in contract["playback_url"]


def test_signed_mp4_with_trailing_slash_is_not_mistaken_for_embed():
    url = "https://www.fpo.xxx/video/123/example/"
    stream = "https://www.fpo.xxx/get_file/123/video.mp4/?token=abc"
    contract = build_playback_contract(url, {
        "stream_url": stream,
        "embed_urls": ["https://example.com/embed/123"],
    })
    assert contract["type"] == "proxy"
    assert contract["iframe"] is False
    assert "video.mp4%2F%3Ftoken%3Dabc" in contract["playback_url"]


def test_porntrex_playback_uses_proxy_with_watch_page_referer():
    from urllib.parse import parse_qs, urlsplit
    page = 'https://www.porntrex.com/video/123/example/'
    stream = 'https://video.cdntrex.com/get_file/123/video.mp4/?token=abc'
    contract = build_playback_contract(page, {'stream_url': stream}, 'Porntrex')
    assert contract['type'] == 'proxy'
    assert contract['iframe'] is False
    params = parse_qs(urlsplit(contract['playback_url']).query)
    assert params['url'] == [stream]
    assert params['referer'] == [page]


def test_build_playback_contract_drm():
    url = "https://example.com/protected"
    data = {
        "stream_url": "https://example.com/manifest.mpd",
        "content_type": "application/dash+xml",
        "is_drm": True,
    }
    contract = build_playback_contract(url, data, "DRMProvider")
    assert contract["status"] == "unsupported"
    assert contract["reason"] == "drm_protected"
    assert is_drm_protected(data["stream_url"], data) is True


def test_build_playback_contract_caching():
    url = "https://eporner.com/hd-arms-123"
    data = {
        "stream_url": "https://static.eporner.com/video.mp4",
        "is_hls": False,
    }
    contract = build_playback_contract(url, data, "Eporner")
    assert contract["playback_url"].startswith('/hls_proxy?url=')
    assert contract["requires_proxy"] is True

    cached = get_cached_playback(url)
    assert cached is not None
    assert cached["playback_url"] == contract["playback_url"]


def test_build_playback_contract_pornhub_proxy():
    url = "https://www.pornhub.com/view_video.php?viewkey=ph123"
    data = {
        "stream_url": "https://cv-hls.phncdn.com/hls/video.m3u8",
        "is_hls": True,
        "proxy_cookies": {"hasVisited": "1"},
        "playback_referer": url,
    }
    contract = build_playback_contract(url, data, "Pornhub")
    assert contract["type"] == "proxy"
    assert contract["format"] == "hls"
    assert contract["requires_proxy"] is True
    from urllib.parse import urlsplit, parse_qs
    query = parse_qs(urlsplit(contract["playback_url"]).query)
    assert query["url"] == [data["stream_url"]]
    assert query["referer"] == [url]
    assert query["session"] == [contract["session_id"]]
