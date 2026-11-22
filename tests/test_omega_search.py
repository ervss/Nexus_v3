"""Unit a SSE streaming testy pre 4-vrstvový Omni-Search (/api/v1/search/omega)."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.extractors.circuit_breaker import extractor_circuit_breaker
from app.main import app
from app.search.adapters.api_adapter import ApiFamilyAdapter
from app.search.adapters.dork_adapter import DorkAggregatorAdapter, build_dork_query
from app.search.adapters.kvs_adapter import KVS_SITES, _parse_kvs_html
from app.search.adapters.wp_dle_adapter import WP_DLE_SITES, _parse_wp_dle_html
from app.search.base import AdapterBatch


@pytest.fixture(autouse=True)
def _reset_cb():
    extractor_circuit_breaker.reset()
    yield
    extractor_circuit_breaker.reset()


def test_kvs_parser_extracts_json_ld_and_standard_cards():
    html = """
    <html><head>
      <script type="application/ld+json">
      {"@type": "VideoObject", "name": "Jordan Millicent LD", "url": "https://www.whoreshub.com/videos/111/jordan/", "duration": "PT10M15S", "thumbnailUrl": "https://cdn.example/1.jpg"}
      </script>
    </head><body>
      <div class="item">
        <a href="/videos/222/jordan-millicent-hd/" title="Jordan Millicent HD">
          <img data-original="https://cdn.example/2.jpg" alt="Jordan Millicent HD">
        </a>
        <span class="duration">14:30</span>
        <span class="is-hd">1080p</span>
      </div>
    </body></html>
    """
    profile = KVS_SITES[0]  # whoreshub
    items = _parse_kvs_html(html, profile, limit=10)
    urls = {it["url"] for it in items}
    assert "https://www.whoreshub.com/videos/111/jordan/" in urls
    assert "https://www.whoreshub.com/videos/222/jordan-millicent-hd/" in urls
    card_item = next(it for it in items if "222" in it["url"])
    assert card_item["duration"] == 870
    assert card_item["height"] == 1080


def test_wp_dle_parser_extracts_posts_and_ignores_categories():
    html = """
    <html><body>
      <article class="post">
        <h2><a href="https://leakporner.com/category/leaks/">Category</a></h2>
      </article>
      <article class="post">
        <h2><a href="https://leakporner.com/jordan-millicent-leaked/" title="Jordan Millicent Leaked 4K">Jordan Millicent</a></h2>
        <img data-src="https://leakporner.com/img/jm.jpg" />
        <span class="duration">22:10</span>
      </article>
    </body></html>
    """
    profile = WP_DLE_SITES[0]  # leakporner
    items = _parse_wp_dle_html(html, profile, limit=10)
    assert len(items) == 1
    assert items[0]["url"] == "https://leakporner.com/jordan-millicent-leaked/"
    assert items[0]["height"] == 2160
    assert items[0]["duration"] == 1330


def test_dork_query_format_and_searxng_adapter(monkeypatch):
    q = build_dork_query(["web1.com", "web2.com"], "Jordan Millicent")
    assert q == '(site:web1.com OR site:web2.com) "Jordan Millicent"'


@pytest.mark.asyncio
async def test_dork_adapter_queries_local_searxng_and_trips_circuit_breaker():
    from app.search.adapters.dork_adapter import is_valid_dork_item_url, matches_query_strictly

    assert is_valid_dork_item_url("https://www.erome.com/a/2Tnr22q5") is True
    assert is_valid_dork_item_url("https://www.erome.com/Marcujonis?page=64") is False
    assert is_valid_dork_item_url("https://faphouse.com/c/blowjob/videos?page=6308") is False
    assert is_valid_dork_item_url("https://faphouse.com/bundles") is False
    assert is_valid_dork_item_url("https://faphouse.com/videos/abc123") is True
    assert matches_query_strictly("Jordan Millicent", "Jordan Millicent Hot", "https://erome.com/a/1", "") is True
    assert matches_query_strictly("Jordan Millicent", "Jordan Only Fans", "https://erome.com/a/2", "") is False

    fake_payload = {
        "results": [
            {"title": "Jordan Millicent Video", "url": "https://erome.com/a/abc123", "content": "Found", "engine": "duckduckgo"},
            {"title": "Jordan Millicent Dead 404", "url": "https://erome.com/a/dead99", "content": "Found"},
            {"title": "Jordan Millicent Bundles", "url": "https://faphouse.com/bundles", "content": "Category junk"},
            {"title": "Jordan Only", "url": "https://erome.com/a/partial1", "content": "Missing second token"},
            {"title": "Unrelated Nike Shoe", "url": "https://www.nike.com/jordan", "content": "Ignored domain"},
            {"title": "Duplicate", "url": "https://erome.com/a/abc123", "content": "Dup"},
        ]
    }
    captured_urls = []

    class FakeResp:
        status_code = 200
        text = json.dumps(fake_payload)

        def raise_for_status(self):
            return None

        def json(self):
            return fake_payload

    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            captured_urls.append(url)
            return FakeResp()

    async def fake_verify_fetch(url, **kw):
        if "dead99" in url:
            return (404, url, "<html><title>404 Not Found</title></html>")
        return (200, url, '<html><head><meta property="og:image" content="https://img.example/ok.jpg"></head></html>')

    with (
        patch("app.search.adapters.dork_adapter.httpx.AsyncClient", FakeClient),
        patch("app.search.adapters.dork_adapter.fetch_page", side_effect=fake_verify_fetch),
    ):
        adapter = DorkAggregatorAdapter(searxng_url="http://127.0.0.1:8888/search", verify_urls=True)
        batch = await adapter.search_group("g1", "Dork Group", ("erome.com", "faphouse.com"), "Jordan Millicent")
    assert len(captured_urls) == 1
    assert captured_urls[0].startswith("http://127.0.0.1:8888/search?")
    assert "format=json" in captured_urls[0]
    assert len(batch.items) == 1
    assert batch.items[0]["url"] == "https://erome.com/a/abc123"
    assert batch.items[0]["thumbnail"] == "https://img.example/ok.jpg"

    # Simulate 429 from SearXNG -> immediate circuit trip -> next call is fail-fast skipped_circuit
    class RateLimitResp:
        status_code = 429
        text = ""

    class FailClient(FakeClient):
        async def get(self, url):
            return RateLimitResp()

    with patch("app.search.adapters.dork_adapter.httpx.AsyncClient", FailClient):
        err_batch = await adapter.search_group("g1", "Dork Group", ("erome.com",), "Jordan Millicent")
    assert err_batch.status == "error"

    with patch("app.search.adapters.dork_adapter.httpx.AsyncClient", side_effect=AssertionError("should fail-fast")):
        skipped = await adapter.search_group("g1", "Dork Group", ("erome.com",), "Jordan Millicent")
    assert skipped.status == "skipped_circuit"


def test_coomer_kemono_civitai_removed_from_search_catalogs():
    from app import source_catalog
    from app.search.omega import OMEGA_PRESETS, OMEGA_SOURCE_CATALOG

    api_keys = {row["key"] for row in OMEGA_SOURCE_CATALOG["api"]}
    tube_keys = {row["key"] for row in OMEGA_SOURCE_CATALOG["tube"]}
    assert not ({"coomer", "kemono", "civitai"} & api_keys)
    assert "ixxx" not in tube_keys
    assert not ({"coomer", "kemono", "civitai", "ixxx"} & source_catalog.DISCOVERY_SEARCH_SOURCE_KEYS)
    assert not ({"coomer", "kemono", "civitai"} & set(OMEGA_PRESETS["leaks"]["sources"]))
    assert "ixxx" not in set(OMEGA_PRESETS["tubes"]["sources"])


def test_omega_sse_endpoint_streams_vault_and_all_adapters():
    async def fake_vault(*a, **kw):
        return None

    fake_vault_resp = {
        "items": [
            {
                "bucket": "library",
                "bucket_label": "Knižnica",
                "title": "Jordan Millicent Local",
                "source_url": "https://local.test/1",
                "duration_sec": 600,
                "height": 1080,
                "quality": "1080p",
            }
        ],
        "bucket_counts": {"library": 1},
    }

    async def fake_tele_stream(self, query, limit=20):
        yield AdapterBatch(
            layer="telethon",
            adapter="telethon_adapter",
            source_key="telegram_live",
            source_label="Telegram Live",
            items=[{"title": "TG Hit", "url": "https://t.me/chan/99", "source": "Telegram", "source_key": "telegram", "layer": "telethon", "adapter": "telethon_adapter", "height": 720}],
            status="ok",
            elapsed_ms=42,
        )

    async def _one_batch(layer, adapter, key, label, url):
        return AdapterBatch(
            layer=layer,
            adapter=adapter,
            source_key=key,
            source_label=label,
            items=[{"title": f"Jordan Millicent {label} Hit", "url": url, "source": label, "source_key": key, "layer": layer, "adapter": adapter, "height": 1080}],
            status="ok",
            elapsed_ms=25,
        )

    import asyncio

    with (
        patch("app.search.omega._run_local_vault_sync", return_value=fake_vault_resp),
        patch("app.search.omega.KvsFamilyAdapter.iter_tasks", lambda self, q, **kw: [asyncio.create_task(_one_batch("kvs", "kvs_adapter", "whoreshub", "WhoresHub", "https://whoreshub.com/videos/1/"))]),
        patch("app.search.omega.WpDleFamilyAdapter.iter_tasks", lambda self, q, **kw: [asyncio.create_task(_one_batch("wp_dle", "wp_dle_adapter", "leakporner", "LeakPorner", "https://leakporner.com/jm/"))]),
        patch("app.search.omega.ApiFamilyAdapter.iter_tasks", lambda self, q, **kw: [asyncio.create_task(_one_batch("api", "api_adapter", "eporner", "Eporner", "https://www.eporner.com/video-1/"))]),
        patch("app.search.omega.TubeEngineAdapter.iter_tasks", lambda self, q, **kw: [asyncio.create_task(_one_batch("tube", "tube_adapter", "pornhub", "Pornhub", "https://www.pornhub.com/view_video.php?viewkey=1"))]),
        patch("app.search.omega.DorkAggregatorAdapter.iter_tasks", lambda self, q, **kw: [asyncio.create_task(_one_batch("dork", "dork_adapter", "dork_tubes_leaks", "Dork", "https://erome.com/a/jm"))]),
        patch("app.search.omega.TelethonSearchAdapter.search_stream", fake_tele_stream),
    ):
        client = TestClient(app)
        with client.stream("GET", "/api/v1/search/omega?query=Jordan%20Millicent") as resp:
            assert resp.status_code == 200
            assert "text/event-stream" in resp.headers.get("content-type", "")
            events = []
            cur = None
            for line in resp.iter_lines():
                if line.startswith("event: "):
                    cur = line[7:].strip()
                elif line.startswith("data: "):
                    events.append((cur, json.loads(line[6:])))

    event_names = [e[0] for e in events]
    assert event_names[0] == "meta"
    assert event_names[-1] == "done"
    layers_received = [e[1]["layer"] for e in events if e[0] == "results"]
    assert layers_received[0] == "local_vault"
    assert {"local_vault", "kvs", "wp_dle", "api", "tube", "dork", "telethon"} <= set(layers_received)
    assert events[-1][1]["total_results"] == 7


def test_omega_presets_relevance_and_cache():
    from app.search.omega import clear_omega_cache

    clear_omega_cache()
    fake_vault_resp = {
        "items": [
            {
                "bucket": "library",
                "bucket_label": "Knižnica",
                "title": "Random unrelated title",
                "source_url": "https://local.test/1",
                "height": 720,
            },
            {
                "bucket": "library",
                "bucket_label": "Knižnica",
                "title": "Jordan Millicent Full Scene 1080p",
                "source_url": "https://local.test/2",
                "height": 1080,
            },
        ],
        "bucket_counts": {"library": 2},
    }
    import asyncio

    async def _one_batch(layer, adapter, key, label, url):
        return AdapterBatch(
            layer=layer,
            adapter=adapter,
            source_key=key,
            source_label=label,
            items=[{"title": "Jordan Millicent Eporner", "url": url, "source": label, "source_key": key, "layer": layer, "adapter": adapter, "height": 1080}],
            status="ok",
            elapsed_ms=15,
        )

    api_calls = 0

    def _api_tasks(self, q, **kw):
        nonlocal api_calls
        api_calls += 1
        return [asyncio.create_task(_one_batch("api", "api_adapter", "eporner", "Eporner", "https://www.eporner.com/video-999/"))]

    with (
        patch("app.search.omega._run_local_vault_sync", return_value=fake_vault_resp),
        patch("app.search.omega.ApiFamilyAdapter.iter_tasks", _api_tasks),
        patch("app.search.omega.DorkAggregatorAdapter.iter_tasks", lambda self, q, **kw: []),
    ):
        client = TestClient(app)
        # First call with preset='fast' (only local_vault + api + dork)
        r1 = client.get("/api/v1/search/omega?query=Jordan%20Millicent&preset=fast&stream=0")
        assert r1.status_code == 200
        d1 = r1.json()
        assert d1["preset"] == "fast"
        assert d1["cache_hit"] is False
        assert api_calls == 1
        scores = {it["url"]: it["omega_relevance"] for it in d1["results"]}
        assert scores["https://local.test/2"] > scores["https://local.test/1"]

        # Second identical call hits cache without calling ApiFamilyAdapter again
        r2 = client.get("/api/v1/search/omega?query=Jordan%20Millicent&preset=fast&stream=0")
        assert r2.status_code == 200
        d2 = r2.json()
        assert d2["cache_hit"] is True
        assert api_calls == 1

    r_reset = client.post("/api/v1/search/omega/circuit/reset")
    assert r_reset.status_code == 200
    assert r_reset.json()["ok"] is True
    assert r_reset.json()["cache_cleared"] >= 1


def test_strict_query_matching_filters_false_positives():
    from app.search.base import filter_strict_query_items, matches_query_strictly

    assert matches_query_strictly("Tina Tolly", "Tatted MILF Tina Tolly", "https://pornone.com/milf/tina-tolly/123") is True
    assert matches_query_strictly("Tina Tolly", "Tina Tolley 5on1", "https://xvideos.com/video1/tina_tolley") is True
    assert matches_query_strictly("Tina Tolly", "Tiny Million Gets Fucked", "https://anysex.com/12345/") is False
    assert matches_query_strictly("Tina Tolly", "Tina Snows Solo", "https://pimpbunny.com/videos/tina-snows") is False
    assert matches_query_strictly("Tina Tolly", "Alexa Chains", "https://pornhub.com/view_video.php?viewkey=abc") is False

    kept = filter_strict_query_items(
        [
            {"title": "Tiny Million", "url": "https://anysex.com/1"},
            {"title": "Tina Tolly Scene", "url": "https://pornhub.com/view_video.php?viewkey=2"},
            {"title": "Tina Tolley Clip", "url": "https://xvideos.com/video3"},
        ],
        "Tina Tolly",
    )
    assert [it["url"] for it in kept] == [
        "https://pornhub.com/view_video.php?viewkey=2",
        "https://xvideos.com/video3",
    ]


@pytest.mark.asyncio
async def test_dork_verify_drops_403_without_thumb_and_redirect_to_root():
    import asyncio
    from app.search.base import CircuitBreakerBlockedError

    adapter = DorkAggregatorAdapter(verify_urls=True)
    sem = asyncio.Semaphore(2)

    async def fake_fetch(url, **kw):
        if "pornhoarder" in url:
            raise CircuitBreakerBlockedError("pornhoarder.tv", 60.0)
        if "redirected" in url:
            return (200, "https://pimpbunny.com/", "<html><title>Home</title></html>")
        if "sxyprn" in url:
            return (200, url, "<html><head><title>Post not found</title></head><body><div>Post not found</div></body></html>")
        return (
            200,
            url,
            '<html><head><meta property="og:title" content="Tina Tolly Live"><meta property="og:image" content="https://img.test/tt.jpg"><meta property="video:duration" content="425"></head></html>',
        )

    with patch("app.search.adapters.dork_adapter.fetch_page", side_effect=fake_fetch):
        res_403 = await adapter._verify_live_item(
            {"url": "https://pornhoarder.tv/pornvideo/1/tina-tolly/", "title": "Tina Tolly", "dork_domain": "pornhoarder.tv"},
            sem,
            "Tina Tolly",
        )
        res_redir = await adapter._verify_live_item(
            {"url": "https://pimpbunny.com/videos/redirected/", "title": "Tina Tolly", "dork_domain": "pimpbunny.com"},
            sem,
            "Tina Tolly",
        )
        res_sxy_404 = await adapter._verify_live_item(
            {"url": "https://sxyprn.com/post/65a1b2c3.html", "title": "Post not found", "dork_domain": "sxyprn.com"},
            sem,
            "Tina Tolly",
        )
        res_ok = await adapter._verify_live_item(
            {"url": "https://pimpbunny.com/videos/ok-tina-tolly/", "title": "Tina Tolly", "dork_domain": "pimpbunny.com"},
            sem,
            "Tina Tolly",
        )

    assert res_403 is None
    assert res_redir is None
    assert res_sxy_404 is None
    assert res_ok is not None
    assert res_ok["thumbnail"] == "https://img.test/tt.jpg"
    assert res_ok["duration"] == 425


@pytest.mark.asyncio
async def test_tube_adapter_wraps_engine_and_filters_strictly():
    from app.search.adapters.tube_adapter import TubeEngineAdapter, TubeSiteProfile

    class FakeEngine:
        async def search_pornhub_async(self, query, result_limit=24):
            return [
                {"title": "Tiny Million Noise", "url": "https://www.pornhub.com/view_video.php?viewkey=noise", "thumbnail": "https://cdn/n.jpg"},
                {"title": "Tina Tolly Real", "url": "https://www.pornhub.com/view_video.php?viewkey=real", "thumbnail": "https://cdn/r.jpg", "duration": "08:03", "quality": "1080p"},
            ]

    adapter = TubeEngineAdapter(
        sites=[TubeSiteProfile("pornhub", "Pornhub", "www.pornhub.com", "search_pornhub_async")],
        engine=FakeEngine(),
    )
    batch = await adapter.search_site(adapter.sites[0], "Tina Tolly", limit=10)
    assert batch.status == "ok"
    assert len(batch.items) == 1
    assert batch.items[0]["url"] == "https://www.pornhub.com/view_video.php?viewkey=real"
    assert batch.items[0]["duration"] == 483
    assert batch.items[0]["height"] == 1080


def test_beeg_extractor_facts_api_populates_metadata():
    from app.extractors.beeg import BeegExtractor

    ext = BeegExtractor()
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "file": {
            "data": [{"cd_column": "sf_name", "cd_value": "Tina Tolly Outdoor"}],
            "fl_duration": 612,
            "fl_width": 1920,
            "fl_height": 1080,
        },
        "fc_facts": [{"fc_thumbs": [7, 12], "fc_st_views": 4200}],
        "tags": [
            {"tg_name": "Tina Tolly", "is_person": True},
            {"tg_name": "Babe", "is_owner": False},
        ],
    }
    with patch.object(ext.session, "get", return_value=mock_resp):
        facts = ext._fetch_facts_api("0000123456")

    assert facts is not None
    assert facts["title"] == "Tina Tolly Outdoor"
    assert facts["thumbnail"] == "https://thumbs.externulls.com/videos/123456/7.webp?size=480x270"
    assert facts["duration"] == 612
    assert facts["height"] == 1080
    assert "Tina Tolly" in facts["performers"]


