import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, Video, get_db
from app.main import api_v1_router


@pytest.fixture
def test_app():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

    with TestingSessionLocal() as db:
        v1 = Video(
            title="Eporner Test",
            source_url="https://eporner.com/v1/",
            url="https://cdn.example.com/eporner_v1.mp4",
            storage_type="remote",
        )
        v2 = Video(
            title="Telegram Test",
            source_url="https://t.me/c/100123/456",
            url="/api/v1/telegram/stream/-100123/456",
            telegram_chat_id="-100123",
            telegram_message_id=456,
            storage_type="telegram",
        )
        v3 = Video(
            title="Local Direct Test",
            source_url="https://bunkr.is/v/testlocal",
            url="C:/videos/testlocal.mp4",
            storage_type="local",
        )
        db.add_all([v1, v2, v3])
        db.commit()

    def override_get_db():
        session = TestingSessionLocal()
        try:
            yield session
        finally:
            session.close()

    app = FastAPI()
    app.include_router(api_v1_router)
    app.dependency_overrides[get_db] = override_get_db

    with TestClient(app) as client:
        yield client

    Base.metadata.drop_all(engine)


def test_library_status_matches_trailing_slash_and_telegram(test_app):
    response = test_app.post(
        "/api/v1/videos/library-status",
        json={
            "urls": [
                "https://eporner.com/v1",  # Bez slash v requešte, v DB má slash
                "https://t.me/c/123/456",  # Telegram web bez -100
                "/api/v1/telegram/stream/-100123/456",
                "https://bunkr.is/v/testlocal",
                "https://eporner.com/unknown_video",
            ]
        },
    )
    assert response.status_code == 200
    data = response.json()
    matches = data.get("matches", {})

    # Overenie Eporner videa (bez slash v requešte)
    assert "https://eporner.com/v1" in matches
    assert matches["https://eporner.com/v1"]["in_dashboard"] is True
    assert matches["https://eporner.com/v1"]["on_disk"] is False

    # Overenie Telegram videa cez web linku aj stream linku
    assert "https://t.me/c/123/456" in matches
    assert matches["https://t.me/c/123/456"]["in_dashboard"] is True
    assert "/api/v1/telegram/stream/-100123/456" in matches
    assert matches["/api/v1/telegram/stream/-100123/456"]["in_dashboard"] is True

    # Overenie lokálneho videa (on_disk = True)
    assert "https://bunkr.is/v/testlocal" in matches
    assert matches["https://bunkr.is/v/testlocal"]["in_dashboard"] is True
    assert matches["https://bunkr.is/v/testlocal"]["on_disk"] is True

    # Neexistujúce video
    assert "https://eporner.com/unknown_video" not in matches
