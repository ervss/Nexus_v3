import asyncio
import io
import os
import re
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.related_media import classify_cbir_url, crop_image_bytes, resolve_local_thumb_path
from app.related_query_planner import clean_title_for_search, is_junk_or_hash_token, plan_related_queries
from app.related_unified import rrf_fuse_and_explain


def _dummy_video(**kwargs):
    defaults = {
        "id": 999999,
        "title": "",
        "url": "",
        "source_url": "",
        "thumbnail_path": "",
        "tags": "",
        "ai_tags": "",
        "models": "",
        "categories": "",
        "duration": 600,
        "height": 1080,
    }
    defaults.update(kwargs)
    return type("DummyVideo", (), defaults)()


def test_junk_hash_detection_and_title_cleaning():
    assert is_junk_or_hash_token("48Fefdf7Cdb6E0Bc")
    assert is_junk_or_hash_token("7746555611816")
    assert is_junk_or_hash_token("316c46e0-8ce6-4489-93f3-7a4d81c445a5")
    assert is_junk_or_hash_token("myThumbnail 5 25 2025 6 42 00 PM")

    cleaned = clean_title_for_search("onlyfans.24.10.05.nadine.kerastas.and.damion.dayski.round.2.mp4")
    assert "nadine" in cleaned.lower()
    assert "kerastas" in cleaned.lower()
    assert "damion" in cleaned.lower()
    assert "24.10.05" not in cleaned
    assert ".mp4" not in cleaned.lower()


def test_query_planner_never_emits_url_hashes():
    v = _dummy_video(
        title="Spoiler:",
        url="https://filester.me/f/48fefdf7cdb6e0bc",
        tags="blowjob,lingerie",
    )
    plan = plan_related_queries(v)
    joined = " ".join(plan["queries"]).lower()
    assert "48fefdf7" not in joined
    assert "filester" not in joined

    v2 = _dummy_video(
        title="7746555611816",
        url="/api/v1/telegram/stream/2539478609/18654",
    )
    plan2 = plan_related_queries(v2)
    assert plan2["is_meaningless_title"] is True
    assert plan2["queries"] == []

    v3 = _dummy_video(title="Huge Fake Tits bimbo Blowjob and fuck", tags="blowjob")
    plan3 = plan_related_queries(v3)
    assert "Huge Fake" not in plan3["performers"]
    assert "Thick Dick" not in plan3["performers"]


def test_cbir_anti_spam_classifier():
    assert classify_cbir_url("https://m.youtube.com/playlist?list=PL123")["blocked"] is True
    assert classify_cbir_url("https://toyfactory.sk/lily+lou+-+entitled")["blocked"] is True
    assert classify_cbir_url("https://store.flawlessmirrors.com/search?query=test")["blocked"] is True
    assert classify_cbir_url("https://umcs.org.ua/en-AU/lily+lou+scene")["blocked"] is True

    ok1 = classify_cbir_url("https://www.porntrex.com/video/2900028/eat-ocean")
    assert ok1["blocked"] is False
    assert ok1["is_video_site"] is True

    ok2 = classify_cbir_url("https://www.fpo.xxx/video/911099/scene")
    assert ok2["blocked"] is False
    assert ok2["is_video_site"] is True


def test_crop_image_bytes_reduces_to_region():
    im = Image.new("RGB", (400, 200), (20, 40, 60))
    buf = io.BytesIO()
    im.save(buf, format="JPEG")
    cropped = crop_image_bytes(buf.getvalue(), {"x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5})
    with Image.open(io.BytesIO(cropped)) as out_im:
        assert out_im.size == (200, 100) or min(out_im.size) >= 160


def test_telegram_disk_thumb_resolution_if_present():
    tg_dir = Path("data/telegram_thumbs")
    if not tg_dir.is_dir():
        return
    files = list(tg_dir.glob("*.jpg"))
    if not files:
        return
    sample_stem = files[0].stem
    if "_" not in sample_stem:
        return
    chat_id, msg_id = sample_stem.rsplit("_", 1)
    resolved = resolve_local_thumb_path(f"/api/v1/telegram/thumb/{chat_id}/{msg_id}")
    assert resolved is not None and resolved.is_file()


def test_rrf_fusion_ranks_exact_and_filters_spam():
    seed = _dummy_video(title="Lily Lou Scene", duration=900, height=1080)
    candidates = [
        {"url": "https://www.youtube.com/watch?v=123", "title": "Girl", "source": "google_vision", "match_type": "visual"},
        {"url": "https://toyfactory.sk/lily+lou+scene", "title": "Lily Lou", "source": "yandex", "match_type": "visual"},
        {"url": "https://www.porntrex.com/video/101/lily-lou", "title": "Lily Lou Scene 1080p", "source": "yandex", "match_type": "exact", "visual_score": 94, "duration": 905},
        {"url": "https://www.eporner.com/video-abc/lily-lou/", "title": "Lily Lou", "source": "eporner", "duration": 890},
    ]
    fused = rrf_fuse_and_explain(candidates, seed, performers=["Lily Lou"], tags=["blonde"], clean_title="Lily Lou Scene", limit=20)
    urls = [item["url"] for item in fused]
    assert "https://www.youtube.com/watch?v=123" not in urls
    assert "https://toyfactory.sk/lily+lou+scene" not in urls
    assert fused[0]["url"] == "https://www.porntrex.com/video/101/lily-lou"
    assert fused[0]["tier"] == "exact"
    assert any(r["type"] == "exact" for r in fused[0]["match_reasons"])


def test_related_intent_changes_priority_with_same_candidates():
    seed = _dummy_video(title="Mountain ride", duration=900, height=1080)
    frame = "https://www.porntrex.com/video/101/mountain-ride"
    creator = "https://www.eporner.com/video-abc/alex-river/"
    candidates = [
        {"url": frame, "title": "Mountain ride", "source": "yandex",
         "match_type": "visual", "visual_score": 96, "duration": 905},
        {"url": creator, "title": "Alex River outdoors", "source": "eporner",
         "duration": 890},
    ]
    options = dict(performers=["Alex River"], tags=[], clean_title="Mountain ride", limit=1)
    assert rrf_fuse_and_explain(candidates, seed, intent="same_video", **options)[0]["url"] == frame
    assert rrf_fuse_and_explain(candidates, seed, intent="same_creator", **options)[0]["url"] == creator


def test_templates_render_unified_related_partial():
    from jinja2 import Environment, FileSystemLoader

    env = Environment(loader=FileSystemLoader("app/templates"))
    partial = env.get_template("partials/related_workspace_modal.html").render()
    assert "nx-rel-modal-card" in partial
    assert "runUnifiedRelatedSearch" in partial
    assert "nx-rel-resize-se" in partial
    assert "startRelatedModalResize" in partial
    assert "toggleRelatedModalMaximize" in partial
    assert "nx-rel-history-panel" in partial
    assert "playUnifiedResult" in partial
    assert "toggleRelatedHistory" in partial
    assert "nx-rel-status-panel" in partial
    assert "probeAllUnifiedResults" in partial
    assert '<template x-if="galleryRelatedCompareItem">' in partial
    assert "nx-rel-guide-panel" in partial
    assert "toggleRelatedGuide" in partial
    assert "applyRelatedGuidePreset" in partial

    from pathlib import Path
    for tpl_name in ("index.html", "netflix.html"):
        if not (Path("app/templates") / tpl_name).exists():
            continue
        rendered = env.get_template(tpl_name).render(
            ui_variant="v1",
            asset_version="test",
            enable_ambient=False,
        )
        assert "nx-rel-modal-card" in rendered
        assert "related_workspace.css?v=" in rendered
        assert re.search(r"main\.min\.js\?v=\w+", rendered)
        assert rendered.count('x-show="galleryRelatedOpen"') == 1


def test_ssrf_guard_blocks_private_and_local_urls():
    from app.related_media import validate_public_http_url
    from fastapi.testclient import TestClient
    from app.main import app

    for bad in (
        "http://127.0.0.1/secret.jpg",
        "http://localhost:8000/thumb.jpg",
        "http://169.254.169.254/latest/meta-data/",
        "http://192.168.1.10/cam.jpg",
        "http://10.0.0.5/internal.jpg",
        "file:///etc/passwd",
        "http://user:pass@8.8.8.8/img.jpg",
    ):
        ok, _ = validate_public_http_url(bad)
        assert ok is False, f"SSRF mal zablokovať: {bad}"

    ok_ip, _ = validate_public_http_url("https://1.1.1.1/thumb.jpg")
    assert ok_ip is True

    client = TestClient(app)
    r_unified = client.post("/api/v1/cbir/unified/stream", json={"image_url": "http://169.254.169.254/latest/meta-data"})
    assert r_unified.status_code == 422
    r_legacy = client.post("/api/v1/videos/0/reverse-image-search", json={"image_url": "http://127.0.0.1:8000/thumb.jpg"})
    assert r_legacy.status_code == 422


def test_importability_classification_distinguishes_videos_vs_images_and_webpages():
    from app.related_media import classify_cbir_url

    vid = classify_cbir_url("https://www.porntrex.com/video/101/scene")
    assert vid["importable"] is True
    assert vid["importability"] == "confirmed"

    img = classify_cbir_url("https://cdn.example.org/frames/shot01.jpg", explicit_kind="image")
    assert img["blocked"] is False
    assert img["kind"] == "image"
    assert img["importable"] is False
    assert img["importability"] == "unsupported"

    page = classify_cbir_url("https://random-profile.example.com/model/jane")
    assert page["kind"] == "webpage"
    assert page["importable"] is False
    assert page["importability"] == "unsupported"


def test_explicit_empty_sources_runs_zero_providers():
    from fastapi.testclient import TestClient
    from app.main import app
    from app.database import SessionLocal, Video

    client = TestClient(app)
    db = SessionLocal()
    try:
        sample = db.query(Video).filter(Video.duplicate_of.is_(None)).first()
    finally:
        db.close()
    assert sample is not None

    r = client.post(
        f"/api/v1/videos/{sample.id}/reverse-image-search",
        json={"sources": []},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "no_sources"
    assert body["count"] == 0
    assert body["engines"] == {}

    # Unified stream s explicitne prázdnymi web_sources=[] a cbir_engines=[] v režime 'web' nespustí externé zdroje
    import json as _json
    r2 = client.post(
        f"/api/v1/videos/{sample.id}/related/unified/stream",
        json={"mode": "web", "web_sources": [], "cbir_engines": []},
    )
    assert r2.status_code == 200
    events = [_json.loads(line[6:]) for line in r2.text.splitlines() if line.startswith("data: ")]
    done_ev = next(e for e in events if e.get("type") == "done")
    assert done_ev["engines"] == {}
    assert done_ev["results"] == []


def test_vision_full_parser_and_serpapi_direct_upload(monkeypatch):
    import app.main as app_main

    # 1. Plný parser Google Vision Web Detection
    class _FakeResp:
        def __init__(self, status_code, payload):
            self.status_code = status_code
            self._payload = payload
            self.headers = {}
            self.text = ""

        def json(self):
            return self._payload

    class _FakeClient:
        calls = []

        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, **kwargs):
            self.calls.append(("POST", url, kwargs))
            if "vision.googleapis.com" in url:
                return _FakeResp(200, {
                    "responses": [{
                        "webDetection": {
                            "bestGuessLabels": [{"label": "Lily Lou Scene"}],
                            "webEntities": [{"description": "Lily Lou", "score": 0.91}],
                            "pagesWithMatchingImages": [{
                                "url": "https://www.eporner.com/video-xyz/lily/",
                                "pageTitle": "Lily Lou Full",
                                "fullMatchingImages": [{"url": "https://img.eporner.com/1.jpg"}],
                            }],
                            "fullMatchingImages": [{"url": "https://cdn.example.net/full_frame.jpg"}],
                            "partialMatchingImages": [{"url": "https://cdn.example.net/part_frame.jpg"}],
                            "visuallySimilarImages": [{"url": "https://cdn.example.net/sim_frame.jpg"}],
                        }
                    }]
                })
            # SerpApi /image upload
            return _FakeResp(200, {"image_id": "serp_img_12345"})

        async def get(self, url, **kwargs):
            self.calls.append(("GET", url, kwargs))
            return _FakeResp(200, {
                "search_metadata": {"id": "search_1"},
                "visual_matches": [{
                    "link": "https://www.porntrex.com/video/777/matched/",
                    "title": "Matched Video",
                    "thumbnail": "https://img.porntrex.com/t.jpg",
                    "exact_matches": True,
                }],
            })

    monkeypatch.setattr(app_main.httpx, "AsyncClient", _FakeClient)
    monkeypatch.setattr(app_main.config, "GOOGLE_VISION_API_KEY", "fake-vision-key", raising=False)
    monkeypatch.setattr(app_main.config, "SERPAPI_API_KEY", "fake-serpapi-key", raising=False)

    vision_hits = asyncio.run(app_main._google_vision_web_search([b"fakeimg"], limit=20))
    urls = {h["url"]: h for h in vision_hits}
    assert "https://www.eporner.com/video-xyz/lily/" in urls
    assert "https://cdn.example.net/full_frame.jpg" in urls
    assert "https://cdn.example.net/part_frame.jpg" in urls
    assert "https://cdn.example.net/sim_frame.jpg" in urls
    assert urls["https://cdn.example.net/full_frame.jpg"]["kind"] == "image"
    assert "Lily Lou" in urls["https://www.eporner.com/video-xyz/lily/"]["web_entities"]

    # 2. SerpApi direct binary upload (>500KB obrázok -> resize pod 500KB -> image_id -> Google Lens)
    big_im = Image.effect_noise((1600, 1200), 64).convert("RGB")
    buf = io.BytesIO()
    big_im.save(buf, format="PNG")
    raw_big = buf.getvalue()
    prepared = app_main._prepare_serpapi_image_bytes(raw_big)
    assert 1000 < len(prepared) <= 490_000

    _FakeClient.calls.clear()
    lens_hits = asyncio.run(app_main._serpapi_google_lens_search(image_bytes=raw_big, limit=10))
    assert any(m == "POST" and u == "https://serpapi.com/image" for m, u, _ in _FakeClient.calls)
    lens_get = next((kw for m, u, kw in _FakeClient.calls if m == "GET" and "search.json" in u), None)
    assert lens_get is not None
    assert lens_get["params"]["image_id"] == "serp_img_12345"
    assert "url" not in lens_get["params"]
    assert lens_hits[0]["url"] == "https://www.porntrex.com/video/777/matched/"


def test_rrf_fusion_excludes_self_clones_and_normalizes_library_source():
    seed = _dummy_video(
        id=10417,
        title="7746555611816",
        thumbnail_path="/api/v1/telegram/thumb/2539478609/1",
        duration=120,
    )
    candidates = [
        {"video_id": 10417, "url": "/api/v1/telegram/stream/2539478609/1", "title": "7746555611816", "thumbnail": "/api/v1/telegram/thumb/2539478609/1", "is_library": True, "visual_score": 100, "duration": 120},
        {"video_id": 10413, "url": "/api/v1/telegram/stream/2539478609/2", "title": "7746555611816", "thumbnail": "/api/v1/telegram/thumb/2539478609/1", "is_library": True, "visual_score": 100, "duration": 120},
        {"video_id": 8312, "url": "https://www.porntrex.com/video/1/lena", "title": "Lena Scene", "is_library": True, "visual_score": 90, "duration": 300},
    ]
    fused = rrf_fuse_and_explain(candidates, seed, performers=[], tags=[], clean_title="", limit=20)
    vids = [item.get("video_id") for item in fused]
    assert 10417 not in vids
    assert 10413 not in vids
    assert 8312 in vids
    assert fused[0]["source"] == "library"


def test_creator_consensus_extracts_performer_from_visual_hits():
    from app.related_creator_discovery import extract_creators_from_visual_hits

    hits = [
        {"url": "https://www.camwhores.tv/videos/14041295/aa-bimbo-3/", "title": "AA Bimbo 3 - CamWhores", "source": "yandex", "visual_score": 48},
        {"url": "https://hu.pornhex.com/video/lici-bimbo", "title": "Alicia Bimbo Leopard Print - Alicia Amira", "source": "serpapi", "visual_score": 74},
        {"url": "https://www.porntrex.com/video/2972549/alicia-amira-onlyfans", "title": "Alicia Amira - OnlyFans #23 Porntrex.com", "source": "yandex", "visual_score": 63},
        {"url": "https://x-fetish.tube/video/666869/nasty-bimbo", "title": "Nasty Bimbo aka nasty_bimbo - 02-26-2025", "source": "yandex", "visual_score": 57},
    ]
    creators = extract_creators_from_visual_hits(hits)
    assert creators
    assert creators[0]["name"] == "Alicia Amira"
    assert creators[0]["mentions"] >= 3
    assert creators[0]["confidence"] >= 75
    names_low = {c["name"].lower() for c in creators}
    assert "leopard print" not in names_low
    assert "aa bimbo" not in names_low
    assert "nasty_bimbo" not in names_low


def test_fastapi_related_routes_mounted(monkeypatch):
    import json as _json
    from fastapi.testclient import TestClient
    from app.main import app
    from app.database import SessionLocal, Video
    import app.routers.related as related_router

    async def _fake_probe(urls, limit=12):
        return [{"url": u, "ok": True, "height": 1080, "duration": 620, "size_bytes": 123456} for u in urls[:limit]]

    async def _fake_discover(video_id, crop_box=None, auto_save=False, db=None):
        return {
            "creators": [{"name": "Alicia Amira", "confidence": 92, "mentions": 3, "sources": ["serpapi", "yandex"]}],
            "visual_hits_count": 12,
            "saved_models": "Alicia Amira" if auto_save else "",
        }

    async def _fake_resolve_stream(url):
        return {"ok": True, "stream_url": "https://cdn.example.com/v.mp4", "is_hls": False, "referer": url, "title": "Test", "duration": 120, "height": 720}

    monkeypatch.setattr(related_router, "probe_related_candidates", _fake_probe)
    monkeypatch.setattr(related_router, "discover_creator_for_video", _fake_discover)
    monkeypatch.setattr(related_router, "resolve_related_stream_url", _fake_resolve_stream)

    client = TestClient(app)
    r1 = client.get("/api/v1/cbir/status")
    assert r1.status_code == 200
    body1 = r1.json()
    assert "visual_index" in body1
    assert "serpapi" in body1

    r2 = client.get("/api/v1/related/visual-index/status")
    assert r2.status_code == 200
    assert "available" in r2.json()

    r_probe = client.post("/api/v1/related/probe", json={"urls": ["https://www.porntrex.com/video/101/test"], "limit": 5})
    assert r_probe.status_code == 200
    assert r_probe.json()["results"][0]["height"] == 1080

    r_hist = client.get("/api/v1/related/history?limit=10")
    assert r_hist.status_code == 200
    assert "items" in r_hist.json()

    r_res_bad = client.post("/api/v1/related/resolve-stream", json={"url": "http://127.0.0.1/secret"})
    assert r_res_bad.status_code == 422

    r_res_ok = client.post("/api/v1/related/resolve-stream", json={"url": "https://1.1.1.1/video/123"})
    assert r_res_ok.status_code == 200
    assert r_res_ok.json()["ok"] is True

    db = SessionLocal()
    try:
        sample = db.query(Video).filter(Video.duplicate_of.is_(None)).first()
    finally:
        db.close()

    if sample is not None:
        r_pb = client.get(f"/api/v1/videos/{sample.id}/playback-item")
        assert r_pb.status_code == 200
        assert r_pb.json()["id"] == sample.id

        r_dc = client.post(f"/api/v1/videos/{sample.id}/related/discover-creator", json={"auto_save": False})
        assert r_dc.status_code == 200
        assert r_dc.json()["creators"][0]["name"] == "Alicia Amira"

        r_stream = client.post(
            f"/api/v1/videos/{sample.id}/related/unified/stream",
            json={"mode": "library", "limit": 10},
        )
        assert r_stream.status_code == 200
        events = []
        for line in r_stream.text.splitlines():
            if line.startswith("data: "):
                events.append(_json.loads(line[6:]))
        event_types = {e.get("type") for e in events}
        assert "context" in event_types
        assert "done" in event_types


def test_probe_stream_emits_progress(monkeypatch):
    import json as _json
    from fastapi.testclient import TestClient
    from app.main import app
    import app.related_unified as ru

    async def _fake_probe_one(url: str):
        if "hd.com" in url:
            return {"url": url, "probe_ok": True, "duration": 420, "height": 1080, "width": 1920, "file_size": 999}
        if "sd.com" in url:
            return {"url": url, "probe_ok": True, "duration": 180, "height": 480, "width": 854, "file_size": 222}
        return {"url": url, "probe_ok": False}

    monkeypatch.setattr(ru, "_probe_single_related_url", _fake_probe_one)

    client = TestClient(app)
    urls = [
        "https://hd.com/video/1",
        "https://sd.com/video/2",
        "https://dead.com/video/3",
    ]
    r = client.post("/api/v1/related/probe/stream", json={"urls": urls, "limit": 50})
    assert r.status_code == 200
    events = []
    for line in r.text.splitlines():
        if line.startswith("data: "):
            events.append(_json.loads(line[6:]))

    starts = [e for e in events if e.get("type") == "probe_start"]
    items = [e for e in events if e.get("type") == "probe_item"]
    dones = [e for e in events if e.get("type") == "probe_done"]
    assert len(starts) == 1 and starts[0]["total"] == 3
    assert len(items) == 3
    assert [i["done"] for i in items] == [1, 2, 3]
    assert len(dones) == 1
    assert dones[0]["done"] == 3
    assert dones[0]["total"] == 3
    assert dones[0]["ok_count"] == 2
    assert dones[0]["hd_count"] == 1


def test_namethatporn_parser_and_creator_anti_repost():
    from app.related_creator_discovery import (
        _parse_namethatporn_post_html,
        extract_creators_from_visual_hits,
    )

    sample_ntp_html = """
    <html>
      <head>
        <title>Name of the video and the Actress? - Meg Vicious - Emma Fiore #1848132 › NameThatPorn.com</title>
      </head>
      <body>
        <img src="https://namethatporn.com/media/large/2026/05/09/3UC7317CBOELF_name-of-the-video-and-the-actress.jpg"/>
        <div class="id_answer_wrapper">
          <div class="id_answer_top_line">Correct answer | solved 5 months ago by OP</div>
          <div class="id_answer">
            <a href="/pornstars/meg-vicious.html">Meg Vicious</a>
            <a href="/pornstars/emma-fiore.html">Emma Fiore</a>
            The Collaboration Between Meg Vicious Emma Fiore, Bastian Blanc And Bob Big Tula
            video reference :
            <a href="https://redir.me?https://abxxx.com/video/1111024/the-collaboration-between-meg-vicious-emma-fiore/">ref</a>
            <a href="https://redir.me?https://x.com/myviciouscrush">x</a>
          </div>
        </div>
        <div class="id_answer_wrapper">
          <div class="id_answer_top_line">#999999 | 2 months ago</div>
          <div class="id_answer">
            Her name is alice_gg and this is the video
          </div>
        </div>
      </body>
    </html>
    """
    parsed = _parse_namethatporn_post_html(
        sample_ntp_html,
        post_url="https://namethatporn.com/post/1848132-name-of-the-video-and-the-actress.html",
    )
    assert parsed["is_confirmed"] is True
    assert "Meg Vicious" in parsed["models"]
    assert "Emma Fiore" in parsed["models"]
    assert parsed["aliases"].get("Meg Vicious") == "myviciouscrush"
    assert "https://abxxx.com/video/1111024/the-collaboration-between-meg-vicious-emma-fiore/" in parsed["ext_links"]
    assert "alice_gg" not in " ".join(parsed["models"]).lower()

    # Overenie, že repostové X/xGroovy titulky nevytvoria falošného tvorcu (napr. meowcalsheesh / Favourite Gifs),
    # zatiaľ čo NameThatPorn ANSWERED hit jednoznačne určí Meg Vicious (99%)
    hits = [
        {"url": "https://xgroovy.com/gifs/1", "title": "Pxpxpx1000's Favourite GIFs", "source": "serpapi", "visual_score": 96, "exact_frame": True},
        {"url": "https://x.com/dailyhutao/status/1", "title": 'Daily HuTao on X: "RT @meowcalsheesh: " / X', "source": "serpapi", "visual_score": 96, "exact_frame": True},
        {"url": "https://x.com/blowjobs/status/2", "title": 'Blowjobs on X: "RT @alleyoop503: Sloppy blowjob for lucky guy"', "source": "serpapi", "visual_score": 63},
        {
            "url": "https://abxxx.com/video/1111024/the-collaboration-between-meg-vicious-emma-fiore/",
            "title": "Meg Vicious, Emma Fiore — The Collaboration Between Meg Vicious Emma Fiore, Bastian Blanc And Bob Big Tula",
            "source": "namethatporn",
            "visual_score": 99,
            "exact_frame": True,
            "ntp_solved": True,
            "ntp_models": ["Meg Vicious", "Emma Fiore"],
            "ntp_aliases": {"Meg Vicious": "myviciouscrush"},
        },
    ]
    creators = extract_creators_from_visual_hits(hits, raw_title="Sloppy blowjob for lucky guy")
    assert creators
    assert creators[0]["name"] == "Meg Vicious"
    assert creators[0]["confidence"] >= 96
    names_low = {c["name"].lower() for c in creators}
    assert "meowcalsheesh" not in names_low
    assert "favourite gifs" not in names_low
    assert "alleyoop503" not in names_low
    assert "vicious emma" not in names_low


def test_probe_extracts_highest_quality_file_size_via_head_fallback(monkeypatch):
    import app.related_unified as ru
    from app.extractors import ExtractorRegistry

    class _FakeExtractor:
        async def extract(self, url):
            return {
                "duration": 420,
                "height": 720,
                "formats": [
                    {"height": 480, "url": "https://1.1.1.1/video_480.mp4"},
                    {"height": 1080, "width": 1920, "url": "https://1.1.1.1/video_1080.mp4"},
                ],
            }

    async def _fake_head(media_url, referer="", headers=None):
        assert media_url == "https://1.1.1.1/video_1080.mp4"
        return 314_572_800  # 300 MB

    monkeypatch.setattr(ExtractorRegistry, "find_extractor", staticmethod(lambda _u: _FakeExtractor()))
    monkeypatch.setattr(ru, "_head_media_size_bytes", _fake_head)

    res = asyncio.run(ru._probe_single_related_url("https://1.1.1.1/watch/123"))
    assert res["probe_ok"] is True
    assert res["height"] == 1080
    assert res["duration"] == 420
    assert res["file_size"] == 314_572_800
    assert res["file_size_approx"] is False


def test_gallery_namethatporn_identify_route_generates_missing_thumb(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.database import SessionLocal, Video
    import app.related_unified as ru

    buf = io.BytesIO()
    Image.new("RGB", (320, 180), (40, 80, 120)).save(buf, format="JPEG")
    fake_jpg = buf.getvalue()

    class _FakeDB:
        def __init__(self, vid_obj):
            self._v = vid_obj
            self.committed = False

        def query(self, _model):
            return self

        def filter(self, *_args):
            return self

        def first(self):
            return self._v

        def commit(self):
            self.committed = True

        def rollback(self):
            pass

    fake_vid = _dummy_video(id=999988, title="IMG_9999.mp4", thumbnail_path="", models="", url="https://example.com/v.mp4", source_url="", original_thumbnail_url="")
    fake_db = _FakeDB(fake_vid)

    async def _no_thumb(*_a, **_kw):
        return None

    async def _fake_frames(_v, count=1):
        return [fake_jpg]

    async def _fake_ntp(frames, image_url="", limit=18):
        assert frames and frames[0] == fake_jpg
        return [{
            "url": "https://abxxx.com/video/1111024/test/",
            "title": "Meg Vicious — Test Scene",
            "thumbnail": "https://namethatporn.com/media/displays/test.jpg",
            "source": "namethatporn",
            "visual_score": 98,
            "ntp_solved": True,
            "ntp_models": ["Meg Vicious"],
            "ntp_scene_title": "Test Scene",
            "ntp_post_url": "https://namethatporn.com/post/1848132-test.html",
        }]

    monkeypatch.setattr(ru, "resolve_video_thumb_bytes", _no_thumb)
    monkeypatch.setattr(ru, "extract_search_frames", _fake_frames)
    monkeypatch.setattr(ru, "namethatporn_cbir_search", _fake_ntp)
    monkeypatch.chdir(tmp_path)

    res = asyncio.run(ru.identify_video_on_namethatporn(999988, auto_save=False, db=fake_db))
    assert res["ok"] is True
    assert res["found"] is True
    assert res["thumbnail_generated"] is True
    assert res["thumbnail_path"] == "/static/thumbnails/thumb_999988.jpg"
    assert res["creators"][0]["name"] == "Meg Vicious"
    assert res["matches"][0]["post_url"] == "https://namethatporn.com/post/1848132-test.html"
    # Pri auto_save=False sa meno neuloží automaticky (čaká na potvrdenie používateľa)
    assert fake_vid.models == ""

    # Overenie namontovaného API endpointu
    client = TestClient(app)
    r = client.post("/api/v1/videos/0/namethatporn/identify", json={"auto_save": False})
    assert r.status_code == 200
    assert r.json()["ok"] is False


def test_probe_reads_extractor_size_bytes_and_size_estimated(monkeypatch):
    import app.related_unified as ru
    from app.extractors import ExtractorRegistry

    class _FakePornhubExtractor:
        name = "Pornhub"

        async def extract(self, url):
            return {
                "duration": 612.0,
                "height": 1080,
                "width": 1920,
                "stream_url": "https://1.1.1.1/hls/master.m3u8",
                "size_bytes": 419_430_400,
                "size_estimated": True,
                "is_hls": True,
            }

    monkeypatch.setattr(ExtractorRegistry, "find_extractor", staticmethod(lambda _u: _FakePornhubExtractor()))

    res = asyncio.run(ru._probe_single_related_url("https://1.1.1.1/view_video.php?viewkey=ph123"))
    assert res["probe_ok"] is True
    assert res["duration"] == 612
    assert res["height"] == 1080
    assert res["file_size"] == 419_430_400
    assert res["file_size_approx"] is True


def test_probe_pornhub_skips_bare_ytdlp_fallback_when_metadata_extracted(monkeypatch):
    import app.related_unified as ru
    from app.extractors import ExtractorRegistry
    import yt_dlp

    class _FakePornhubExtractor:
        name = "Pornhub"

        async def extract(self, url):
            return {
                "duration": 300.0,
                "height": 720,
                "width": 1280,
                "stream_url": "https://1.1.1.1/hls/master.m3u8",
                "size_bytes": None,
                "size_estimated": False,
                "is_hls": True,
            }

    def _boom_ytdlp(*_a, **_kw):
        raise AssertionError("Bare yt-dlp fallback should not run for Pornhub when extractor succeeded")

    monkeypatch.setattr(ExtractorRegistry, "find_extractor", staticmethod(lambda _u: _FakePornhubExtractor()))
    monkeypatch.setattr(yt_dlp, "YoutubeDL", _boom_ytdlp)

    res = asyncio.run(ru._probe_single_related_url("https://1.1.1.1/view_video.php?viewkey=ph456"))
    assert res["probe_ok"] is True
    assert res["duration"] == 300
    assert res["height"] == 720
    assert res["file_size"] == 0


def test_parse_quality_height_and_pick_best_format():
    import app.related_unified as ru

    assert ru._parse_quality_height("4K") == 2160
    assert ru._parse_quality_height("1080p60") == 1080
    assert ru._parse_quality_height("FHD") == 1080
    assert ru._parse_quality_height("720p") == 720
    assert ru._parse_quality_height("", width=1920) == 1080

    # Pri rovnakom rozlíšení musí vybrať najväčší súbor
    best = ru._pick_best_quality_format([
        {"url": "https://1.1.1.1/720.mp4", "height": 720, "filesize": 120_000_000},
        {"url": "https://1.1.1.1/1080_small.mp4", "quality": "1080p", "filesize": 220_000_000},
        {"url": "https://1.1.1.1/1080_big.mp4", "quality": "1080p60", "filesize": 480_000_000},
    ], require_url=True)
    assert best is not None
    assert best["url"] == "https://1.1.1.1/1080_big.mp4"


def test_probe_upgrades_720p_extractor_result_via_ytdlp_1080p(monkeypatch):
    import app.related_unified as ru
    from app.extractors import ExtractorRegistry
    import yt_dlp

    class _FakeEpornerExtractor:
        name = "Eporner"

        async def extract(self, url):
            return {
                "duration": 600,
                "height": 720,
                "width": 1280,
                "stream_url": "https://1.1.1.1/video_720.mp4",
                "size_bytes": 150_000_000,
                "listed_max_height": 1080,
            }

    class _FakeYDL:
        def __init__(self, opts):
            self.opts = opts

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def extract_info(self, target, download=False):
            return {
                "duration": 600,
                "formats": [
                    {"url": "https://1.1.1.1/720.mp4", "height": 720, "width": 1280, "filesize": 150_000_000, "vcodec": "h264"},
                    {"url": "https://1.1.1.1/1080.mp4", "height": 1080, "width": 1920, "filesize": 420_000_000, "vcodec": "h264"},
                ],
            }

    monkeypatch.setattr(ExtractorRegistry, "find_extractor", staticmethod(lambda _u: _FakeEpornerExtractor()))
    monkeypatch.setattr(yt_dlp, "YoutubeDL", _FakeYDL)

    res = asyncio.run(ru._probe_single_related_url("https://1.1.1.1/video-abc/test/"))
    assert res["probe_ok"] is True
    assert res["height"] == 1080
    assert res["width"] == 1920
    assert res["file_size"] == 420_000_000
    assert res["file_size_approx"] is False

    stream_res = asyncio.run(ru.resolve_related_stream_url("https://1.1.1.1/video-abc/test/"))
    assert stream_res["ok"] is True
    assert stream_res["height"] == 1080
    assert stream_res["stream_url"] == "https://1.1.1.1/1080.mp4"


def test_cover_match_with_duration_mismatch_is_probable_cut_not_exact_and_intent_reranks():
    from types import SimpleNamespace
    from app.related_unified import rrf_fuse_and_explain, apply_related_intent_order
    from app.duplicate_detector import classify_duration_relation

    seed = _dummy_video(title="Studio Scene Full", duration=1800, height=720)
    trailer_url = "https://www.eporner.com/video-trailer/studio-scene-teaser/"
    full_url = "https://www.porntrex.com/video/101/studio-scene-full"
    candidates = [
        {
            "url": trailer_url,
            "title": "Studio Scene Teaser",
            "source": "eporner",
            "match_type": "exact",
            "visual_score": 95,
            "duration": 45,
            "height": 1080,
        },
        {
            "url": full_url,
            "title": "Studio Scene Full",
            "source": "porntrex",
            "match_type": "exact",
            "visual_score": 94,
            "duration": 1802,
            "height": 1080,
        },
    ]
    fused = rrf_fuse_and_explain(
        candidates,
        seed,
        performers=["Alex River"],
        tags=[],
        clean_title="Studio Scene Full",
        intent="all",
        limit=10,
    )
    by_url = {item["url"]: item for item in fused}
    # 45s trailer s rovnakým coverom nesmie byť označený ako identické video (tier == "exact")
    assert by_url[trailer_url]["tier"] != "exact"
    assert by_url[trailer_url]["signals"]["is_exact"] is False
    assert by_url[trailer_url]["confirmed_same_video"] is False
    assert by_url[trailer_url]["version_relation"] == "probable_cut"

    # 1802s verzia v 1080p je potvrdený celý záznam vo vyššej kvalite
    assert by_url[full_url]["tier"] == "exact"
    assert by_url[full_url]["confirmed_same_video"] is True
    assert by_url[full_url]["is_upgrade"] is True
    assert by_url[full_url]["version_relation"] == "upgrade_quality"
    assert "signals" in by_url[full_url]

    # Instant 0 ms preusporiadanie podľa intent="upgrade" posunie upgrade_full na 1. miesto
    upgraded_order = apply_related_intent_order(fused, "upgrade")
    assert upgraded_order[0]["url"] == full_url

    # Overenie classify_duration_relation v duplicate_detector
    rel_cut = classify_duration_relation(1800, 45)
    assert rel_cut["is_confirmed"] is False
    assert rel_cut["compare_only"] is True
    assert rel_cut["relation"] == "probable_cut"

    rel_full = classify_duration_relation(1800, 1802)
    assert rel_full["is_confirmed"] is True
    assert rel_full["compare_only"] is False






