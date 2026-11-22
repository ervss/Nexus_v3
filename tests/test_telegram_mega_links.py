import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import database
from app.extractors import mega_native as mn
from app.mega_link_extractor import (
    extract_mega_urls,
    extract_message_links,
    extract_pack_title,
    has_message_preview,
    resolve_clean_redirect,
)
from app.routers import mega_hub as hub
from app.routers import telegram as tg_router
from app.telegram_index import search_telegram_fts, upsert_telegram_media_batch
from app.telegram_links import upsert_telegram_link_posts


KEY_FOLDER = mn.b64url_encode(b"S" * 16)
KEY_FILE = mn.b64url_encode(b"F" * 32)
FOLDER_URL = f"https://mega.nz/folder/FOLDER01#{KEY_FOLDER}"
FILE_URL = f"https://mega.nz/file/VIDEO001#{KEY_FILE}"


@pytest.fixture
def api_env(tmp_path, monkeypatch):
    engine = create_engine(
        f"sqlite:///{(tmp_path / 'tg_mega.db').as_posix()}",
        connect_args={"check_same_thread": False},
    )
    monkeypatch.setattr(database, "engine", engine)
    session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    monkeypatch.setattr(database, "SessionLocal", session)
    database.init_db()

    app = FastAPI()
    app.include_router(hub.router, prefix="/api/v1")
    app.include_router(tg_router.router, prefix="/api/v1")

    def override_db():
        with session() as db:
            yield db

    app.dependency_overrides[hub.get_db] = override_db
    app.dependency_overrides[tg_router.get_db] = override_db
    app.dependency_overrides[tg_router.check_auth] = lambda: True
    monkeypatch.setattr(hub.config, "NEXUS_BRIDGE_TOKEN", "")
    hub.clear_active_handoff()

    snapshot = {
        "status": "available",
        "title": "MEGA priečinok",
        "scope": "SCOPE001",
        "partial": False,
        "folders": [],
        "videos": [
            {
                "ref": mn.MegaRef("node", "VIDEO001", tuple(range(8)), "FOLDER01").to_compact(),
                "name": "Clip_1080p.mp4",
                "parent": "SCOPE001",
                "size": 123456,
                "duration": 95,
                "width": 1920,
                "height": 1080,
            }
        ],
    }
    monkeypatch.setattr(hub, "_public_snapshot", AsyncMock(return_value=snapshot))

    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as client:
        yield client, session

    hub.clear_active_handoff()
    engine.dispose()


def test_extract_mega_urls_variants_and_rejections():
    text = (
        f"Modern: {FOLDER_URL}\n"
        f"Legacy: https://mega.co.nz/#F!LEG00001!{KEY_FOLDER}\n"
        f"Split folder: https://mega.nz/folder/SPLIT001\n"
        f"Decryption key: {KEY_FOLDER}\n"
        f"File: mega.nz/file/VIDEO001#{KEY_FILE}\n"
        f"Truncated: mega.nz/folder/FOLDER01#{KEY_FOLDER[:8]}...\n"
        f"Ellipsis: mega.nz/folder/FOLDER01#{KEY_FOLDER}…\n"
        f"Bad domain: https://not-mega.nz/folder/FOLDER01#{KEY_FOLDER}\n"
    )
    urls = extract_mega_urls(text)
    assert urls == [
        FOLDER_URL,
        f"https://mega.nz/folder/LEG00001#{KEY_FOLDER}",
        FILE_URL,
        f"https://mega.nz/folder/SPLIT001#{KEY_FOLDER}",
    ]


def test_extract_pack_title_and_message_links_from_entities_buttons_and_caption():
    # Vzor z reálnej Telegram skupiny s inline tlačidlom a promo botom
    caption = (
        "🌴 NAME: Nickygile\n"
        "📦 Download: https://links2megas.com/s?7hh5XvN2.00023\n\n"
        "💎 Unlock FULL VIP — No Ads • Instant Access ⭐\n"
        "👉 Tap here: https://t.me/megadumpvip_bot"
    )
    msg_external = SimpleNamespace(
        id=101,
        message=caption,
        photo=object(),
        entities=[],
        reply_markup=SimpleNamespace(
            rows=[SimpleNamespace(buttons=[SimpleNamespace(text="Archive", url="https://t.me/megadropzof")])]
        ),
        media=None,
    )
    assert extract_pack_title(caption) == "Nickygile"
    assert has_message_preview(msg_external) is True
    parsed_ext = extract_message_links(msg_external)
    assert parsed_ext is not None
    assert parsed_ext["link_kind"] == "external"
    assert parsed_ext["primary_url"] == "https://links2megas.com/s?7hh5XvN2.00023"
    assert parsed_ext["domain"] == "links2megas.com"

    # Skrytý MEGA link v MessageEntityTextUrl + emoji pred textom + webpage
    msg_hidden_mega = SimpleNamespace(
        id=102,
        message="🔥 FULL PACK TU",
        photo=None,
        document=None,
        entities=[SimpleNamespace(offset=3, length=12, url=FOLDER_URL)],
        reply_markup=SimpleNamespace(
            rows=[SimpleNamespace(buttons=[SimpleNamespace(text="VIP Bot", url="https://t.me/vip_bot")])]
        ),
        media=SimpleNamespace(webpage=SimpleNamespace(url="https://example.com/other", photo=object())),
    )
    assert has_message_preview(msg_hidden_mega) is True
    parsed_mega = extract_message_links(msg_hidden_mega)
    assert parsed_mega is not None
    assert parsed_mega["link_kind"] == "direct_mega"
    assert parsed_mega["resolved_mega_url"] == FOLDER_URL


def test_resolve_clean_redirect_ssrf_and_redirects(monkeypatch):
    # SSRF na loopback musí byť odmietnutý bez vykonania requestu
    with pytest.raises(ValueError):
        asyncio.run(resolve_clean_redirect("http://127.0.0.1:8000/secret"))

    import socket

    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda host, port, type=0: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))],
    )

    class FakeClient:
        def __init__(self, responses):
            self._responses = responses
            self._idx = 0

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def head(self, url):
            resp = self._responses[self._idx]
            self._idx += 1
            return resp

    # 1. Čistý 302 redirect na mega.nz
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: FakeClient([
            httpx.Response(302, headers={"location": FOLDER_URL}),
        ]),
    )
    res_mega = asyncio.run(resolve_clean_redirect("https://links2megas.com/s?abc"))
    assert res_mega["link_kind"] == "resolved_mega"
    assert res_mega["resolved_mega_url"] == FOLDER_URL
    assert res_mega["hops"] == 1

    # 2. Redirect na externú bránu (speedy-links.com), ktorá vracia 200 HTML bez Location
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: FakeClient([
            httpx.Response(302, headers={"location": "https://speedy-links.com/s?7hh5XvN2"}),
            httpx.Response(200, headers={"content-type": "text/html"}),
        ]),
    )
    res_ext = asyncio.run(resolve_clean_redirect("https://links2megas.com/s?7hh5XvN2.00023"))
    assert res_ext["link_kind"] == "external"
    assert res_ext["resolved_mega_url"] is None
    assert res_ext["final_url"] == "https://speedy-links.com/s?7hh5XvN2"
    assert res_ext["domain"] == "speedy-links.com"

    # 3. Redirect na pastemode HTML stránku obsahujúcu mega.nz odkaz v tele
    class FakePastemodeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def head(self, url):
            if "speedy-links.com" in url:
                return httpx.Response(302, headers={"location": "https://pastemode.com/p/demo123"})
            return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"})

        async def get(self, url):
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text=f'<html><body><p>Link:</p><a href="{FOLDER_URL}">MEGA</a></body></html>',
            )

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: FakePastemodeClient())
    res_paste = asyncio.run(resolve_clean_redirect("https://speedy-links.com/s?paste1"))
    assert res_paste["link_kind"] == "resolved_mega"
    assert res_paste["resolved_mega_url"] == FOLDER_URL
    assert res_paste["hops"] == 1


def test_seed_search_resolve_and_browser_handoff_e2e(api_env, monkeypatch):
    client, session = api_env
    import socket

    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda host, port, type=0: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))],
    )

    # 1. Pasívna extrakcia z video indexu + seed z existujúceho záznamu
    with session() as db:
        upsert_telegram_media_batch(
            db,
            [
                {
                    "chat_id": 1695046208,
                    "message_id": 5001,
                    "channel": "megadropzof",
                    "channel_title": "MegaDropz",
                    "title": "Video s odkazom",
                    "text": f"NAME: Eva\n{FOLDER_URL}",
                    "thumbnail": "/api/v1/telegram/thumb/1695046208/5001",
                    "date": "2026-11-20T08:00:00",
                }
            ],
        )
        fts_hits = search_telegram_fts(db, "Eva")
        assert len(fts_hits) == 1
        assert fts_hits[0]["mega_urls"] == [FOLDER_URL]

        # Vložíme aj externý link post zo screenu
        upsert_telegram_link_posts(
            db,
            [
                {
                    "chat_id": 1695046208,
                    "message_id": 5002,
                    "channel": "megadropzof",
                    "channel_title": "MegaDropz",
                    "title": "Nickygile",
                    "caption": "🌴 NAME: Nickygile\n📦 Download: https://links2megas.com/s?7hh5XvN2.00023",
                    "post_url": "https://t.me/megadropzof/5002",
                    "raw_url": "https://links2megas.com/s?7hh5XvN2.00023",
                    "domain": "links2megas.com",
                    "link_kind": "external",
                    "has_photo": True,
                    "thumbnail": "/api/v1/telegram/post-thumb/1695046208/5002",
                    "date": "2026-11-20T08:25:00",
                }
            ],
        )

    # Seed musí byť idempotentný
    seed_resp = client.post("/api/v1/telegram/links/seed").json()
    assert seed_resp["scanned"] == 1
    assert seed_resp["found_links"] == 1

    # FTS5 hľadanie nad telegram_link_posts
    list_resp = client.get("/api/v1/telegram/links", params={"query": "Nickygile"}).json()
    assert list_resp["total"] == 1
    ext_post = list_resp["items"][0]
    assert ext_post["title"] == "Nickygile"
    assert ext_post["status"] == "new"
    assert ext_post["link_kind"] == "external"

    # Resolve externého linku (presmerovanie na locker)
    class FakeLockerClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def head(self, url):
            if "links2megas.com" in url:
                return httpx.Response(302, headers={"location": "https://speedy-links.com/s?7hh5XvN2"})
            return httpx.Response(200)

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: FakeLockerClient())
    res_resolve = client.post(f"/api/v1/telegram/links/{ext_post['id']}/resolve").json()
    assert res_resolve["mega_status"] == "external_gate"
    assert res_resolve["item"]["final_url"] == "https://speedy-links.com/s?7hh5XvN2"
    assert res_resolve["item"]["domain"] == "speedy-links.com"

    # End-to-end Browser Handoff: klik na "Otvoriť link" -> userscript vyčíta handoff -> pošle výsledný MEGA link
    handoff_res = client.post(f"/api/v1/telegram/links/{ext_post['id']}/handoff").json()
    assert handoff_res["ok"] is True
    assert handoff_res["item"]["status"] == "opened"

    active = client.get("/api/v1/mega/hub/handoff", headers={"X-Nexus-Mega-Hub": "userscript"}).json()
    assert active["handoff"]["post_id"] == ext_post["id"]
    assert active["handoff"]["title"] == "Nickygile"

    # Userscript po vyriešení brány pošle objavený MEGA folder (aj bez explicitného link_post_id sa spáruje cez handoff)
    second_folder = f"https://mega.nz/folder/NICKY001#{KEY_FOLDER}"
    hub_add = client.post(
        "/api/v1/mega/hub/entries",
        headers={"X-Nexus-Mega-Hub": "userscript"},
        json={"url": second_folder},
    ).json()
    assert hub_add["status"] == "added"
    assert hub_add["linked_post_id"] == ext_post["id"]
    assert hub_add["entry"]["title"] == "Nickygile"

    # Handoff sa po spárovaní vyčistil a Telegram karta je v stave in_hub
    assert client.get("/api/v1/mega/hub/handoff", headers={"X-Nexus-Mega-Hub": "userscript"}).json() == {"handoff": None}
    after = client.get("/api/v1/telegram/links", params={"query": "Nickygile", "status": "in_hub"}).json()
    assert after["total"] == 1
    assert after["items"][0]["status"] == "in_hub"
    assert after["items"][0]["link_kind"] == "resolved_mega"
    assert after["items"][0]["resolved_mega_url"] == second_folder
    assert after["items"][0]["mega_hub_entry_id"] == hub_add["entry"]["id"]
    assert after["items"][0]["mega_video_count"] == 1

    # Odstránenie položky z MEGA Hubu uvoľní Telegram kartu späť na opened
    rm = client.post(
        f"/api/v1/mega/hub/entries/{hub_add['entry']['id']}/remove",
        json={"updated_at": hub_add["entry"]["updated_at"]},
    ).json()
    assert rm == {"removed": True}
    after_rm = client.get("/api/v1/telegram/links", params={"query": "Nickygile", "status": "all"}).json()
    assert after_rm["items"][0]["mega_hub_entry_id"] is None
    assert after_rm["items"][0]["status"] == "opened"

    # Priame odoslanie cez send-to-hub a označenie za mŕtvy
    eva_item = client.get("/api/v1/telegram/links", params={"query": "Eva"}).json()["items"][0]
    sent = client.post(f"/api/v1/telegram/links/{eva_item['id']}/send-to-hub", json={}).json()
    assert sent["status"] == "added"
    assert sent["item"]["status"] == "in_hub"

    dead = client.post(f"/api/v1/telegram/links/{eva_item['id']}/status", json={"status": "dead"}).json()
    assert dead["item"]["status"] == "dead"


def test_styled_unicode_dual_links_size_tags_and_video_preview(api_env):
    client, session = api_env
    styled_caption = (
        "💎𝙈𝙊𝘿𝙀𝙇: tattedruby 5.45 GB💎\n\n"
        "🔥Full Archive UP TO APR🔥\n\n"
        "📂𝘿𝙊𝙒𝙉𝙇𝙊𝘼𝘿 𝙃𝙀𝙍𝙀📂\n"
        "onlyshare.info/s?CqWwxPur\n\n"
        "💎𝘼𝙇𝙏𝙀𝙍𝙉𝘼𝙏𝙄𝙑𝙀 𝙒𝘼𝙔💎\n"
        "https://link-center.net/486494/LOw5uuFnOSps\n\n"
        "📱𝙉𝙊 𝘼𝘿𝙎 @OnlyShareVIP\n"
        "Explore more → onlyshare.io ❤️‍🔥\n\n"
        "#Beauty #Studio"
    )
    fake_video_doc = SimpleNamespace(
        mime_type="video/mp4",
        thumbs=[SimpleNamespace(w=320, h=180)],
        attributes=[SimpleNamespace(duration=43)],
    )
    msg = SimpleNamespace(
        id=9001,
        message=styled_caption,
        photo=None,
        document=fake_video_doc,
        video=fake_video_doc,
        entities=[],
        reply_markup=None,
        media=None,
    )
    assert extract_pack_title(styled_caption) == "tattedruby"
    assert has_message_preview(msg) is True
    parsed = extract_message_links(msg)
    assert parsed is not None
    assert parsed["primary_url"] == "https://onlyshare.info/s?CqWwxPur"
    assert parsed["alt_urls"] == ["https://link-center.net/486494/LOw5uuFnOSps"]
    assert parsed["pack_size"] == "5.45 GB"
    assert parsed["tags"] == ["Beauty", "Studio"]
    assert parsed["has_video_preview"] is True
    assert parsed["video_duration"] == "0:43"

    # Overíme aj seeding + pasívnu extrakciu externých balíčkových linkov z video DB (1 príspevok = 1 karta s alt_urls)
    with session() as db:
        upsert_telegram_media_batch(
            db,
            [
                {
                    "chat_id": 2083318784,
                    "message_id": 9001,
                    "channel": "onlyshare_exclusive",
                    "channel_title": "OnlyShare Exclusive",
                    "title": "Explore more → onlyshare.io",
                    "text": styled_caption,
                    "duration": "0:43",
                    "duration_sec": 43,
                    "thumbnail": "/api/v1/telegram/thumb/2083318784/9001",
                    "has_thumb": True,
                    "date": "2026-11-20T09:50:00",
                }
            ],
        )

    listed = client.get("/api/v1/telegram/links", params={"query": "tattedruby"}).json()
    assert listed["total"] == 1
    card = listed["items"][0]
    assert card["title"] == "tattedruby"
    assert card["raw_url"] == "https://onlyshare.info/s?CqWwxPur"
    assert card["pack_size"] == "5.45 GB"
    assert card["tags"] == ["Beauty", "Studio"]
    assert card["alt_urls"] == [{"url": "https://link-center.net/486494/LOw5uuFnOSps", "domain": "link-center.net"}]
    assert card["has_video_preview"] is True
    assert card["video_duration"] == "0:43"
    assert card["video_stream_url"] == "/api/v1/telegram/stream/2083318784/9001?preview=1"



def test_segavideo_dynamic_base64_rentry_multi_link_harvest_and_cache(api_env, monkeypatch):
    """Overí presný scenár zo screenshotu (Segavideo / Cora May):
    skrytá Telegram entita link-to.net/dynamic?r=Base64(rentry.org) + ALT speedy-links.com,
    multi-MEGA + Bunkr/Gofile zber cez rentry/raw, ResolvedLinkCache, /send-all-mega a /handoff/harvest.
    """
    import base64
    import socket
    from app.mega_link_extractor import decode_local_wrapper_url

    client, session = api_env
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda host, port, type=0: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))],
    )

    rentry_url = "https://rentry.org/4oezceba"
    r_b64 = base64.urlsafe_b64encode(rentry_url.encode()).decode().rstrip("=")
    dynamic_url = f"https://link-to.net/204106/879.9844000934656/dynamic?r={r_b64}"

    # 1. Vrstva 0: okamžité lokálne Base64 dekódovanie (0 HTTP requestov)
    assert decode_local_wrapper_url(dynamic_url) == rentry_url

    # 2. Telegram príspevok presne v štruktúre Segavideo (skrytý MEGA LINK + textový ALT Link)
    caption = (
        "🍐 🍐 Cora May 🥵 🤯\n"
        "🔗 MEGA LINK\n"
        "🔗 ALT Link: https://speedy-links.com/s?BYk2wt0U\n"
        "Backup"
    )
    # UTF-16 offset pre "MEGA LINK"
    prefix_utf16_len = len(caption.split("MEGA LINK")[0].encode("utf-16-le")) // 2
    msg = SimpleNamespace(
        id=131836,
        message=caption,
        photo=object(),
        document=None,
        entities=[SimpleNamespace(offset=prefix_utf16_len, length=len("MEGA LINK"), url=dynamic_url)],
        reply_markup=None,
        media=None,
    )
    parsed = extract_message_links(msg)
    assert parsed is not None
    assert parsed["primary_url"] == rentry_url
    assert parsed["domain"] == "rentry.org"
    assert "https://speedy-links.com/s?BYk2wt0U" in parsed["alt_urls"]
    assert len(parsed["extracted_links"]) == 2
    assert parsed["container_urls"][0]["url"] == rentry_url

    # Uložíme kartu aj s extracted_links do DB
    with session() as db:
        upsert_telegram_link_posts(
            db,
            [
                {
                    "chat_id": 15550001,
                    "message_id": 131836,
                    "channel": "Segavideo",
                    "channel_title": "Segavideo",
                    "title": extract_pack_title(caption),
                    "caption": caption,
                    "post_url": "https://t.me/Segavideo/131836",
                    "raw_url": parsed["primary_url"],
                    "final_url": parsed["primary_url"],
                    "domain": parsed["domain"],
                    "link_kind": parsed["link_kind"],
                    "has_photo": True,
                    "extracted_links": parsed["extracted_links"],
                    "container_urls": parsed["container_urls"],
                }
            ],
        )

    listed = client.get("/api/v1/telegram/links", params={"query": "Cora May"}).json()
    assert listed["total"] == 1
    card = listed["items"][0]
    assert card["raw_url"] == rentry_url
    assert card["alt_urls"] == [{"url": "https://speedy-links.com/s?BYk2wt0U", "domain": "speedy-links.com"}]
    assert len(card["extracted_links"]) == 2

    # 3. Multi-link rentry.org/raw crawl: 1 mŕtvy + 2 živé MEGA + 2 Bunkr + 1 Gofile
    dead_mega = f"https://mega.nz/folder/DEAD0001#{KEY_FOLDER}"
    alive_mega_1 = f"https://mega.nz/folder/CORA0001#{KEY_FOLDER}"
    alive_mega_2 = f"https://mega.nz/folder/CORA0002#{KEY_FOLDER}"
    rentry_raw_body = "\n".join([
        dead_mega,
        "https://bunkrr.su/a/op1HdRRx",
        alive_mega_1,
        alive_mega_2,
        "https://bunkrr.su/a/hQwEcdAn",
        "https://gofile.io/d/AbCdEf12",
    ])
    http_calls: list[str] = []

    class FakeRentryClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def head(self, url):
            http_calls.append(f"HEAD:{url}")
            return httpx.Response(200, headers={"content-type": "text/plain; charset=utf-8"})

        async def get(self, url):
            http_calls.append(f"GET:{url}")
            return httpx.Response(200, headers={"content-type": "text/plain; charset=utf-8"}, text=rentry_raw_body)

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: FakeRentryClient())

    async def fake_inspect(share):
        if share.handle == "DEAD0001":
            return {"status": "unavailable", "title": "Mŕtvy", "videos": [], "folders": []}
        return {
            "status": "available",
            "title": "CORAMAYXO" if share.handle == "CORA0001" else "courses",
            "scope": share.handle,
            "partial": False,
            "folders": [],
            "videos": [
                {
                    "ref": mn.MegaRef("node", f"VID{share.handle[-4:]}", tuple(range(8)), share.handle).to_compact(),
                    "name": f"{share.handle}_1080p.mp4",
                    "parent": share.handle,
                    "size": 123456,
                    "duration": 120,
                    "width": 1920,
                    "height": 1080,
                }
            ],
        }

    monkeypatch.setattr(hub, "_inspect", fake_inspect)

    proc = client.post(f"/api/v1/telegram/links/{card['id']}/process", params={"add": "false"}).json()
    assert proc["outcome"] == "multi_mega"
    assert proc["alive_count"] == 2
    assert proc["total_count"] == 3
    assert proc["media_count"] == 3
    assert any(c.endswith("/4oezceba") for c in http_calls)

    updated_card = proc["item"]
    assert updated_card["resolved_mega_url"] == alive_mega_1
    assert len(updated_card["discovered_mega_urls"]) == 3
    assert [m["url"] for m in updated_card["discovered_media_urls"]] == [
        "https://bunkr.cr/a/op1HdRRx",
        "https://bunkr.cr/a/hQwEcdAn",
        "https://gofile.io/d/AbCdEf12",
    ]

    # 4. Druhý príspevok s rovnakou rentry URL musí použiť ResolvedLinkCache bez nového HTTP volania!
    http_calls.clear()
    with session() as db:
        res2 = upsert_telegram_link_posts(
            db,
            [
                {
                    "chat_id": 15550002,
                    "message_id": 999,
                    "channel": "OtherChannel",
                    "channel_title": "Other",
                    "title": "Cora May Repost",
                    "caption": rentry_url,
                    "raw_url": rentry_url,
                    "domain": "rentry.org",
                    "link_kind": "external",
                }
            ],
        )
        repost_id = res2["rows"][0].id

    proc2 = client.post(f"/api/v1/telegram/links/{repost_id}/process", params={"add": "false"}).json()
    assert proc2["outcome"] == "multi_mega"
    assert proc2["alive_count"] == 2
    assert http_calls == []  # 100% cache hit!

    # 5. Hromadné odoslanie všetkých živých MEGA priečinkov do MEGA Hubu
    send_all = client.post(f"/api/v1/telegram/links/{card['id']}/send-all-mega", json={}).json()
    assert send_all["ok"] is True
    assert send_all["added"] == 2
    assert send_all["failed"] == 0
    assert send_all["item"]["status"] == "in_hub"
    assert send_all["item"]["harvest_summary"]["mega_in_hub"] == 2

    # 6. Userscript bridge /handoff/harvest uloží nové MEGA + Bunkr linky priamo na kartu
    handoff_resp = client.post(f"/api/v1/telegram/links/{repost_id}/handoff").json()
    assert handoff_resp["ok"] is True
    bridge_harvest = client.post(
        "/api/v1/mega/hub/handoff/harvest",
        headers={"X-Nexus-Mega-Hub": "userscript"},
        json={
            "source_url": "https://rentry.org/extra999",
            "mega_urls": [f"https://mega.nz/folder/EXTR0001#{KEY_FOLDER}"],
            "media_urls": ["https://pixeldrain.com/l/XyZ12345"],
        },
    ).json()
    assert bridge_harvest["ok"] is True
    assert bridge_harvest["linked_post_id"] == repost_id
    assert any(m["url"] == "https://pixeldrain.com/l/XyZ12345" for m in bridge_harvest["item"]["discovered_media_urls"])



def test_channels_stats_and_paste_multi_filters(api_env):
    """Overí výpočet rebríčka kvality kanálov a nové filtre link_kind=paste a link_kind=multi."""
    client, session = api_env
    with session() as db:
        upsert_telegram_link_posts(
            db,
            [
                {
                    "chat_id": 1001,
                    "message_id": 1,
                    "channel": "top_mega",
                    "channel_title": "Top MEGA Channel",
                    "title": "Pack Direct 1",
                    "caption": f"Direct {FOLDER_URL}",
                    "raw_url": FOLDER_URL,
                    "final_url": FOLDER_URL,
                    "domain": "mega.nz",
                    "link_kind": "direct_mega",
                    "resolved_mega_url": FOLDER_URL,
                },
                {
                    "chat_id": 1002,
                    "message_id": 2,
                    "channel": "rentry_ch",
                    "channel_title": "Rentry Channel",
                    "title": "Pack Rentry",
                    "caption": "MEGA LINK + ALT",
                    "raw_url": "https://rentry.org/testpack1",
                    "final_url": "https://rentry.org/testpack1",
                    "domain": "rentry.org",
                    "link_kind": "external",
                    "extracted_links": [
                        {"url": "https://rentry.org/testpack1", "domain": "rentry.org", "category": "paste", "label": "MEGA LINK"},
                        {"url": "https://speedy-links.com/s?abc", "domain": "speedy-links.com", "category": "shortener", "label": "ALT"},
                    ],
                    "container_urls": [{"url": "https://rentry.org/testpack1", "domain": "rentry.org", "crawled": False}],
                },
                {
                    "chat_id": 1003,
                    "message_id": 3,
                    "channel": "mostbet_spam",
                    "channel_title": "MOSTBET Promo",
                    "title": "Promo",
                    "caption": "Join",
                    "raw_url": "https://spinbetredir.com/x",
                    "domain": "spinbetredir.com",
                    "link_kind": "external",
                },
            ],
        )

    paste_res = client.get("/api/v1/telegram/links", params={"link_kind": "paste"}).json()
    assert paste_res["total"] == 1
    assert paste_res["items"][0]["domain"] == "rentry.org"
    assert paste_res["items"][0]["is_paste_free"] is True
    assert paste_res["counts"]["paste"] == 1
    assert paste_res["counts"]["multi"] == 1

    multi_res = client.get("/api/v1/telegram/links", params={"link_kind": "multi"}).json()
    assert multi_res["total"] == 1
    assert multi_res["items"][0]["extracted_count"] == 2

    ch_stats = client.get("/api/v1/telegram/links/channels-stats").json()
    assert ch_stats["total_channels"] == 3
    ids_order = [c["chat_id"] for c in ch_stats["channels"]]
    assert ids_order[-1] == 1003  # Spam kanál musí byť posledný
    assert ch_stats["channels"][0]["quality_score"] > ch_stats["channels"][-1]["quality_score"]
