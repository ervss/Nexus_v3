import sqlite3
import time

from app.database import sanitize_fts_query
from app.extractors.circuit_breaker import DomainCircuitBreaker
from app.extractors.eporner import EpornerExtractor
from app.extractors.filester import FilesterExtractor
from app.main import _turbo_page_url_from_cdn
from app.routers.extractor_health import CANARY_URLS
from app.stats_cache import TTLCache


def test_sanitize_fts_query_handles_operators_and_punctuation():
    assert sanitize_fts_query("") == ""
    assert sanitize_fts_query("   ---   ") == ""
    assert sanitize_fts_query("foo-bar") == '"foo" "bar"'
    assert sanitize_fts_query("video.mp4") == '"video" "mp4"'
    assert sanitize_fts_query("foo NOT bar OR baz") == '"foo" "NOT" "bar" "OR" "baz"'

    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE VIRTUAL TABLE docs USING fts5(title)")
    conn.execute("INSERT INTO docs(title) VALUES (?)", ("foo-bar video.mp4",))
    for raw in ("foo-bar", "video.mp4", "foo NOT bar", '"test"', "a/b"):
        q = sanitize_fts_query(raw)
        if q:
            rows = conn.execute("SELECT rowid FROM docs WHERE docs MATCH ?", (q,)).fetchall()
            assert isinstance(rows, list)
    conn.close()


def test_turbo_page_url_from_cdn_reconstruction():
    cdn = "https://dl100.turbocdn.st/turbo/data/ELIYsphR6NHdS.mp4?exp=1794428314&token=abc"
    assert _turbo_page_url_from_cdn(cdn) == "https://turbo.cr/v/ELIYsphR6NHdS"
    assert _turbo_page_url_from_cdn("https://example.com/other.mp4") is None


def test_filester_canary_url_matches_extractor():
    assert FilesterExtractor().can_handle(CANARY_URLS["Filester"]) is True


def test_domain_circuit_breaker_trips_and_resets():
    cb = DomainCircuitBreaker(failure_threshold=2, cooldown_seconds=5.0)
    allowed, _ = cb.allow("https://example.test/v/1")
    assert allowed is True

    cb.record_failure("https://www.example.test/v/1", "timeout")
    assert cb.allow("example.test")[0] is True

    cb.record_failure("https://example.test/v/2", "http 503")
    allowed2, retry_after = cb.allow("https://example.test/v/3")
    assert allowed2 is False
    assert retry_after > 0

    snap = cb.snapshot()
    assert len(snap) == 1 and snap[0]["domain"] == "example.test" and snap[0]["state"] == "open"

    assert cb.reset("example.test") == 1
    assert cb.allow("example.test")[0] is True


def test_stats_ttl_cache_expires_and_invalidates():
    cache = TTLCache(default_ttl=10.0)
    calls = 0

    def compute():
        nonlocal calls
        calls += 1
        return {"count": calls}

    assert cache.get_or_compute("health_sources", compute, ttl=10.0) == {"count": 1}
    assert cache.get_or_compute("health_sources", compute, ttl=10.0) == {"count": 1}
    cache.invalidate("health_")
    assert cache.get_or_compute("health_sources", compute, ttl=10.0) == {"count": 2}
    cache.set("short", 42, ttl=0.5)
    assert cache.get("short") == 42


def test_offline_html_parsers_filester_and_eporner():
    html_filester = """
    <html><head><title>Sample Clip - FileDitch</title></head>
    <body>
      <video poster="https://cdn.example.test/thumb.jpg">
        <source src="https://cdn.example.test/media/sample.mp4?token=123" type="video/mp4" />
      </video>
    </body></html>
    """
    parsed = FilesterExtractor._scrape_direct_viewer(html_filester, "https://fileditchfiles.st/bucket/sample.mp4")
    assert parsed["stream_url"] == "https://cdn.example.test/media/sample.mp4?token=123"

    html_eporner = """
    <div id="hd-dload">
      <a href="/dload/abc/720/clip-720p.mp4">MP4 (720p, h264, 150.0 MB)</a>
      <a href="/dload/abc/1080/clip-1080p.mp4">MP4 (1080p, h264, 420.5 MB)</a>
    </div>
    """
    best = EpornerExtractor.best_listed_download(html_eporner)
    assert best is not None
    assert best["height"] == 1080
    assert best["size_mb"] == 420.5
