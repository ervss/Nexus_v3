from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base, ForumLink, ForumPost, ForumThread
from app.media_urls import media_refresh_source
from app.routers import forum_hub as router


@pytest.mark.parametrize("provider", ["https://bunkr.cr/f/file", "https://filester.sh/d/file", "https://pixeldrain.com/u/file"])
def test_import_keeps_provider_as_refresh_source_and_forum_as_context(monkeypatch, provider):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine, tables=[ForumThread.__table__, ForumPost.__table__, ForumLink.__table__])
    db = sessionmaker(bind=engine)()
    thread = ForumThread(url="https://simpcity.cr/threads/test.1/", title="Test")
    db.add(thread)
    db.flush()
    post = ForumPost(thread_id=thread.id, permalink=thread.url + "post-2")
    db.add(post)
    db.flush()
    link = ForumLink(thread_id=thread.id, post_id=post.id, url=provider, title="clip", platform="bunkr")
    db.add(link)
    db.commit()
    requests = []
    monkeypatch.setattr(router, "create_import_job", lambda request, db: requests.append(request) or SimpleNamespace(id=1))
    monkeypatch.setattr(router, "serialize_job", lambda job: {"id": job.id})
    monkeypatch.setattr(router.intake_worker, "start", lambda: None)
    result = router.import_links(router.ImportRequest(link_ids=[link.id]), db)
    candidate = requests[0].candidates[0]
    assert candidate.url == candidate.source_url == provider
    assert f"forum_context:{post.permalink}" in candidate.warnings
    assert f"forum_link_id:{link.id}" in candidate.warnings
    assert result["imported"] == 1
    db.close()


def test_legacy_forum_source_falls_back_to_media_without_changing_album_sources():
    assert media_refresh_source("https://bunkr.cr/f/file", "https://simpcity.cr/threads/test.1/") == "https://bunkr.cr/f/file"
    assert media_refresh_source("https://pixeldrain.com/u/file", "https://forums.socialmediagirls.com/threads/test.1/") == "https://pixeldrain.com/u/file"
    assert media_refresh_source("https://cdn.cr/file.mp4", "https://bunkr.cr/a/album") == "https://bunkr.cr/a/album"


def test_bunkr_site_import_has_extractor_and_native_player():
    from pathlib import Path
    from bs4 import BeautifulSoup
    from app.extractors.bunkr import BunkrExtractor
    assert BunkrExtractor().can_handle("https://bunkr.site/f/FiJHhV4GZD02h")
    soup = BeautifulSoup((Path(__file__).parents[1] / "app/templates/index.html").read_text(encoding="utf-8"), "html.parser")
    for template in soup.find_all("template"):
        if template.find("iframe") or template.find("video", attrs={"x-ref": "videoPlayer1"}) or template.find("video", attrs={"x-ref": "videoPlayer2"}):
            assert "isBunkrPageVideo" not in template.get("x-if", "")
