import asyncio
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import link_tester


def _client():
    app = FastAPI()
    app.include_router(link_tester.router)
    return TestClient(app)


def test_search_eporner_playlists_returns_tester_cards(monkeypatch):
    search = AsyncMock(return_value=(
        [
            {
                "id": "abc123",
                "url": "https://www.eporner.com/profile/demo/playlist/abc123/toy-box/",
                "title": "Toy Box",
                "thumb": "https://static.example/thumb.jpg",
                "count": 42,
            }
        ],
        False,
        3,
    ))
    monkeypatch.setattr(link_tester, "_search_eporner_playlists_for_tester", search, raising=False)

    response = _client().post(
        "/api/tester/eporner-playlists/search",
        json={"keyword": "toys", "limit": 20, "pages": 5, "sort": "largest"},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["keyword"] == "toys"
    assert data["total"] == 1
    assert data["pages_scanned"] == 3
    assert data["stopped_by_rate_limit"] is False
    assert data["results"][0]["extractor"] == "Eporner playlist search"
    assert data["results"][0]["data"]["title"] == "Toy Box"
    assert data["results"][0]["data"]["kind"] == "playlist"
    assert data["results"][0]["data"]["video_count"] == 42
    assert data["results"][0]["data"]["item_count"] == 42

    search.assert_awaited_once_with("toys", 5, result_limit=20, sort_mode="largest")


def test_search_eporner_playlists_returns_502_on_transport_error(monkeypatch):
    from app.eporner_transport import EpornerListingError

    search = AsyncMock(side_effect=EpornerListingError("Eporner: spojenie zlyhalo (timeout/proxy)."))
    monkeypatch.setattr(link_tester, "_search_eporner_playlists_for_tester", search, raising=False)

    response = _client().post(
        "/api/tester/eporner-playlists/search",
        json={"keyword": "toys", "limit": 20, "pages": 5, "sort": "newest"},
    )

    assert response.status_code == 502
    assert "spojenie zlyhalo" in response.json()["detail"]
