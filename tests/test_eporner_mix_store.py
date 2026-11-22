import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import eporner_mix_store
from app.routers import link_tester


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(eporner_mix_store, "STORE_DIR", tmp_path)
    app = FastAPI()
    app.include_router(link_tester.router)
    return TestClient(app)


def test_mix_session_round_trip_and_update(client):
    created = client.post("/api/tester/eporner-mixes", json={
        "name": "Friday mix",
        "playlists": [{
            "url": "https://www.eporner.com/profile/demo/playlist/abc123/clips/",
            "title": "Demo clips",
            "thumbnail": "https://static.example/thumb.jpg",
            "count": 12,
            "complete": True,
        }],
    })
    assert created.status_code == 200
    mix_id = created.json()["mix_id"]

    loaded = client.get(f"/api/tester/eporner-mixes/{mix_id}")
    assert loaded.status_code == 200
    assert loaded.json()["name"] == "Friday mix"
    assert loaded.json()["playlists"][0]["count"] == 12
    assert loaded.json()["playlists"][0]["complete"] is True

    updated = client.put(f"/api/tester/eporner-mixes/{mix_id}", json={
        "snapshot": {"mode": "fast", "videos": [{"url": "https://www.eporner.com/hd-porn/xyz/clip/"}]},
    })
    assert updated.status_code == 200
    assert client.get(f"/api/tester/eporner-mixes/{mix_id}").json()["snapshot"]["mode"] == "fast"


def test_mix_session_rejects_non_eporner_playlist(client):
    response = client.post("/api/tester/eporner-mixes", json={
        "playlists": [{"url": "https://example.com/playlist/abc/"}],
    })
    assert response.status_code == 400


def test_mix_gallery_endpoint_pages_snapshot_videos_as_read_only_cards(client):
    created = client.post("/api/tester/eporner-mixes", json={
        "playlists": [{
            "url": "https://www.eporner.com/profile/demo/playlist/abc123/clips/",
            "title": "Demo clips",
            "count": 2,
        }],
        "snapshot": {"videos": [
            {
                "source_url": "https://www.eporner.com/video-alpha1/demo/",
                "title": "First indexed video",
                "thumbnail": "https://img.example/first.jpg",
                "duration": 120,
                "height": 1080,
            },
            {
                "source_url": "https://www.eporner.com/video-beta2/demo/",
                "title": "Second indexed video",
                "duration": 240,
                "height": 720,
            },
        ]},
    })
    mix_id = created.json()["mix_id"]

    response = client.get(f"/api/tester/eporner-mixes/{mix_id}/videos", params={
        "page": 1, "limit": 1, "quality": "1080p",
    })

    assert response.status_code == 200
    cards = response.json()
    assert len(cards) == 1
    assert cards[0]["title"] == "First indexed video"
    assert cards[0]["tester_mix"] is True
    assert cards[0]["storage_type"] == "tester_index"
    assert cards[0]["quality"] == "1080p"


def test_expired_mix_session_is_not_returned(client, monkeypatch):
    created = eporner_mix_store.create_mix([{
        "url": "https://www.eporner.com/playlist/abc123/clips/",
        "title": "Old",
    }])
    monkeypatch.setattr(time, "time", lambda: created["created_at"] + eporner_mix_store.TTL_SECONDS + 1)
    assert client.get(f"/api/tester/eporner-mixes/{created['mix_id']}").status_code == 404


def test_latest_mix_endpoint_returns_most_recent_live_handoff(client):
    older = client.post("/api/tester/eporner-mixes", json={
        "name": "Older", "playlists": [{"url": "https://www.eporner.com/playlist/old123/clips/"}],
    })
    assert older.status_code == 200
    newer = client.post("/api/tester/eporner-mixes", json={
        "name": "Newest", "playlists": [{"url": "https://www.eporner.com/playlist/new123/clips/"}],
    })
    assert newer.status_code == 200

    response = client.get("/api/tester/eporner-mixes/latest")

    assert response.status_code == 200
    assert response.json()["mix_id"] == newer.json()["mix_id"]
    assert response.json()["name"] == "Newest"
