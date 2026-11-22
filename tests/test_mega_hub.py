import asyncio
import json
from unittest.mock import AsyncMock

import pytest
from Crypto.Cipher import AES
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import MegaHubEntry, Video
from app.extractors import mega_native as mn
from app.routers import mega_hub as hub


SHARED = b"S" * 16
ROOT = "ROOT0001"
SCOPE = "SCOPE001"
EMPTY = "EMPTY001"
FILE = "VIDEO001"
KEY = mn.b64url_encode(SHARED)
URL = f"https://mega.nz/folder/{ROOT}#{KEY}"
REF = mn.MegaRef("node", FILE, tuple(range(8)), ROOT).to_compact()
SNAPSHOT = {
    "status": "available", "title": "Test album", "scope": SCOPE, "partial": False,
    "folders": [{"id": EMPTY, "parent": SCOPE, "name": "Empty"}],
    "videos": [{"ref": REF, "name": "Landscape.mp4", "parent": SCOPE, "size": 1234,
                "duration": 22, "width": 1920, "height": 1080}],
}
API = "/api/v1/mega/hub"
ORIGINAL_SNAPSHOT = hub._public_snapshot


@pytest.fixture
def integration(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{(tmp_path / 'hub.db').as_posix()}")
    MegaHubEntry.__table__.create(engine)
    Video.__table__.create(engine)
    session = sessionmaker(bind=engine)
    app = FastAPI()
    app.include_router(hub.router, prefix="/api/v1")

    def database():
        with session() as db:
            yield db

    app.dependency_overrides[hub.get_db] = database
    monkeypatch.setattr(hub.config, "NEXUS_BRIDGE_TOKEN", "")
    monkeypatch.setattr(hub, "_public_snapshot", AsyncMock(return_value=SNAPSHOT))
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as client:
        yield client, session
    engine.dispose()


def test_check_confirm_and_import_only_selected(integration):
    client, session = integration
    checked = client.post(f"{API}/check", json={"url": URL}).json()
    assert checked["status"] == "available"
    assert checked["count"] == 1
    assert client.get(f"{API}/entries").json() == {"entries": []}
    result = client.post(f"{API}/entries", json={"check_id": checked["check_id"]}).json()
    assert result["status"] == "added"
    entry_url = f"{API}/entries/{result['entry']['id']}"
    duplicate = client.post(f"{API}/entries", json={"url": f"https://mega.co.nz/#F!{ROOT}!{KEY}"}).json()
    assert duplicate == {"status": "exists", "entry": result["entry"]}
    assert hub._public_snapshot.await_count == 2
    with session() as db:
        assert db.query(Video).count() == 0
    detail = client.get(entry_url)
    card = detail.json()["videos"][0]
    assert card["quality"] == "1080p"
    assert REF not in detail.text
    assert client.post(f"{entry_url}/import", json={"ids": ["outside-this-entry"]}).status_code == 409
    assert client.post(f"{entry_url}/import", json={"ids": [card["id"]]}).json()["added"] == 1
    assert client.post(f"{entry_url}/import", json={"ids": [card["id"]]}).json()["skipped"] == 1
    assert client.get(entry_url).json()["videos"][0]["library_id"] is not None
    assert client.get(f"{entry_url}/source", follow_redirects=False).headers["location"] == URL
    assert client.get(f"{entry_url}/source?video={card['id']}", follow_redirects=False).headers["location"] == f"{URL}/file/{FILE}"


def test_handoff_accepts_privileged_local_request_and_rejects_web_origin(integration):
    client, _ = integration
    url = f"{API}/check"
    headers = {"X-Nexus-Mega-Hub": "userscript"}
    assert client.post(url, headers={**headers, "Origin": "https://mega.nz"}, json={"url": URL}).status_code == 403
    extension = {**headers, "Origin": "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
    assert client.post(url, headers=extension, json={"url": URL}).status_code == 200
    assert client.post(url, headers=headers, json={"url": URL.replace("mega.nz", "mega.nz.example")}).status_code == 400


def node(handle, parent, name, is_folder):
    key = bytes(range(16 if is_folder else 32))
    encrypted_key = AES.new(SHARED, AES.MODE_ECB).encrypt(key)
    words = mn.str_to_a32(key)
    cipher_key = key if is_folder else mn._file_key_parts(words)[0]
    clear = b"MEGA" + json.dumps({"n": name}).encode()
    attr = AES.new(cipher_key, AES.MODE_CBC, bytes(16)).encrypt(clear + bytes(-len(clear) % 16))
    return {"h": handle, "p": parent, "t": int(is_folder), "a": mn.b64url_encode(attr),
            "k": f"foreign:broken/{ROOT}:{mn.b64url_encode(encrypted_key)}", "s": 400}


def test_catalog_uses_actual_share_tree_and_never_falls_back_to_parent(monkeypatch):
    tree = [node(SCOPE, None, "Root", True), node(EMPTY, SCOPE, "Empty", True),
            node("FOLDER02", SCOPE, "Nested", True), node(FILE, "FOLDER02", "Clip.mp4", False)]
    monkeypatch.setattr(mn, "_api", AsyncMock(return_value={"f": tree}))
    album = asyncio.run(mn.list_tree(ROOT, SHARED, None, None))
    assert album["title"] == "Root"
    assert {folder["id"] for folder in album["folders"]} == {EMPTY, "FOLDER02"}
    assert album["videos"][0]["parent"] == "FOLDER02"
    empty = asyncio.run(mn.list_tree(ROOT, SHARED, EMPTY, None))
    assert empty["status"] == "empty" and empty["videos"] == []
    assert asyncio.run(mn.list_tree(ROOT, SHARED, EMPTY, FILE))["status"] == "unavailable"
    assert asyncio.run(mn.list_tree(ROOT, bytes(16), None, None))["status"] == "open_in_mega"


def test_page_snapshot_stays_in_sent_subfolder_and_rejects_foreign_refs(integration):
    client, _ = integration
    hub._public_snapshot.return_value = {"status": "open_in_mega"}
    good, = SNAPSHOT["videos"]
    page = {"title": SNAPSHOT["title"], "scope": SCOPE, "folders": SNAPSHOT["folders"], "videos": [
        good, {**good, "ref": REF.replace(ROOT, "FOREIGN1")}, {**good, "parent": "OUTSIDE1"},
    ]}
    check = client.post(f"{API}/check", json={"url": URL}).json()
    assert check["status"] == "open_in_mega" and "check_id" not in check
    response = client.post(f"{API}/entries", json={"url": f"{URL}/folder/{SCOPE}", "page": page}).json()
    assert response["entry"]["from_page"] and response["entry"]["partial"]
    assert response["entry"]["count"] == 1
    refresh = client.post(f"{API}/entries/{response['entry']['id']}/refresh").json()
    assert refresh["status"] == "open_in_mega"


def test_pasted_empty_subfolder_can_be_opened(integration):
    client, _ = integration
    hub._public_snapshot.return_value = {"status": "empty", "title": "Empty", "scope": EMPTY,
                                         "videos": [], "folders": [], "partial": False}
    result = client.post(f"{API}/entries", json={"url": f"{URL}/folder/{EMPTY}"}).json()
    detail = client.get(f"{API}/entries/{result['entry']['id']}").json()
    assert detail["scope"] == EMPTY and detail["videos"] == []


def test_removal_is_scoped_to_entry_and_refresh_respects_removed_videos(integration):
    client, session = integration
    first = client.post(f"{API}/entries", json={"url": URL}).json()["entry"]
    other = client.post(f"{API}/entries", json={"url": f"{URL}/folder/{SCOPE}"}).json()["entry"]
    item = f"{API}/entries/{first['id']}"
    other_item = f"{API}/entries/{other['id']}"
    video_id = client.get(item).json()["videos"][0]["id"]
    assert client.post(f"{item}/import", json={"ids": [video_id]}).json()["added"] == 1
    assert client.post(f"{item}/videos/remove", json={"updated_at": first["updated_at"], "ids": ["foreign"]}).status_code == 409
    result = client.post(f"{item}/videos/remove", json={"updated_at": first["updated_at"], "ids": [video_id]}).json()
    assert result["removed"] == 1
    assert client.get(item).json()["videos"] == []
    assert client.get(other_item).json()["count"] == 1
    assert client.post(f"{item}/refresh").json()["entry"]["count"] == 0
    assert client.post(f"{item}/remove", json={"updated_at": first["updated_at"]}).status_code == 409
    version = client.get(item).json()["updated_at"]
    assert client.post(f"{item}/remove", json={"updated_at": version}).json() == {"removed": True}
    assert client.get(item).status_code == 404
    assert client.get(other_item).json()["count"] == 1
    with session() as db:
        assert db.query(Video).count() == 1


def test_capture_minimum_applies_on_check_direct_send_and_refresh(integration, monkeypatch):
    client, _ = integration
    videos = [{**SNAPSHOT["videos"][0], "duration": 0,
               "ref": mn.MegaRef("node", f"VIDEO00{i}", tuple(range(8)), ROOT).to_compact(),
               "name": f"Clip {i}.mp4"} for i in range(1, 5)]
    durations = dict(zip((video["ref"] for video in videos), [59.999, 60, 90, 0]))

    async def probe(req):
        return {"duration": durations[req.ref], "width": 1920, "height": 1080}

    monkeypatch.setattr(hub.mega, "mega_card_metadata", probe)
    hub._public_snapshot.return_value = {**SNAPSHOT, "videos": videos}
    check = client.post(f"{API}/check", json={"url": URL, "capture": True}).json()
    assert (check["count"], check["short_count"], check["unknown_duration_count"]) == (2, 1, 1)
    saved = client.post(f"{API}/entries", json={"check_id": check["check_id"], "capture": True}).json()["entry"]
    entry_url = f"{API}/entries/{saved['id']}"
    assert [card["duration"] for card in client.get(entry_url).json()["videos"]] == [60, 90]
    assert client.post(f"{entry_url}/refresh").json()["entry"]["count"] == 2
    nested = client.post(f"{API}/entries", json={"url": f"{URL}/folder/{SCOPE}", "capture": True}).json()
    assert nested["entry"]["count"] == 2
    hub._public_snapshot.return_value = {**SNAPSHOT, "videos": videos[:1]}
    short_url = f"{URL}/folder/{EMPTY}"
    assert client.post(f"{API}/entries", json={"url": short_url, "capture": True}).json()["status"] == "below_minimum"
    manual = client.post(f"{API}/entries", json={"url": short_url}).json()
    assert manual["entry"]["count"] == 1


def test_direct_file_check(integration, monkeypatch):
    client, _ = integration
    monkeypatch.setattr(hub, "_public_snapshot", ORIGINAL_SNAPSHOT)
    monkeypatch.setattr(mn, "resolve_cdn", AsyncMock(return_value={"name": "Demo.webm", "size": 128}))
    url = f"https://mega.nz/file/{FILE}#{mn.b64url_encode(bytes(32))}"
    assert client.post(f"{API}/check", json={"url": url}).json()["kind"] == "file"


def test_hub_rethumb_single_and_batch(integration, tmp_path, monkeypatch):
    import json
    from pathlib import Path
    from app import maintenance

    client, _ = integration
    monkeypatch.setattr(hub, "MEGA_HUB_THUMB_DIR", tmp_path / "mega_hub_thumbs")
    fake_jpg = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9"

    async def fake_run_thumb(cmd, timeout):
        out_path = Path(cmd[-1])
        out_path.write_bytes(fake_jpg)
        return True, ""

    monkeypatch.setattr(maintenance, "_run_thumb_process", fake_run_thumb)
    monkeypatch.setattr(maintenance, "_image_score", lambda path: 82)
    monkeypatch.setattr(hub, "_sync_library_thumb", lambda ref, path: None)

    saved = client.post(f"{API}/entries", json={"url": URL}).json()["entry"]
    detail = client.get(f"{API}/entries/{saved['id']}").json()
    vid = detail["videos"][0]["id"]

    # 1. Jednotlivé zlepšenie náhľadu na karte
    single = client.post(f"{API}/entries/{saved['id']}/videos/{vid}/rethumb", json={"reroll": True})
    assert single.status_code == 200
    body = single.json()
    assert body["ok"] is True
    assert body["id"] == vid
    assert "?v=" in body["thumb"]

    # 2. Uložený vylepšený náhľad sa hneď servíruje z lokálneho disku
    thumb_resp = client.get(f"{API}/entries/{saved['id']}/videos/{vid}/thumb")
    assert thumb_resp.status_code == 200
    assert thumb_resp.content == fake_jpg

    # 3. Hromadné NDJSON zlepšenie náhľadov
    batch = client.post(f"{API}/entries/{saved['id']}/rethumb", json={"ids": [vid], "reroll": False})
    assert batch.status_code == 200
    events = [json.loads(line) for line in batch.text.splitlines() if line.strip()]
    assert any(ev.get("type") == "progress" and ev.get("ok") is True and ev.get("id") == vid for ev in events)
    assert events[-1] == {"type": "done", "done": 1, "failed": 0, "total": 1}
