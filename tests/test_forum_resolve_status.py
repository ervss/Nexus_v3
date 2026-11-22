"""Forum Hub Overiť must not treat a probe failure as a dead file."""
from datetime import datetime
from types import SimpleNamespace

from app.routers.forum_hub import _apply_resolve_meta, _is_confirmed_dead


def _link(status="new"):
    return SimpleNamespace(
        id=1,
        url="https://filester.me/d/jz0SFN8",
        platform="filester",
        link_type="video",
        title="Bela Sampaio",
        thumbnail="",
        quality="",
        duration=0,
        size_bytes=0,
        tags=[],
        author="x",
        posted_at=datetime(2026, 9, 17),
        status=status,
        resolved_payload=None,
        resolved_at=None,
    )


def test_extraction_failed_is_not_confirmed_dead():
    assert _is_confirmed_dead({"ok": False, "error": "extraction failed"}) is False
    assert _is_confirmed_dead({"ok": False, "error": "Filester page fetch failed"}) is False
    assert _is_confirmed_dead(TimeoutError()) is False


def test_404_and_deleted_are_confirmed_dead():
    assert _is_confirmed_dead({"ok": False, "error": "not found (404)"}) is True
    assert _is_confirmed_dead({"ok": False, "error": "HTTP 404"}) is True
    assert _is_confirmed_dead({"ok": False, "error": "file has been deleted"}) is True
    assert _is_confirmed_dead({"ok": False, "error": "CDN vratil HTTP 403"}) is False


def test_transient_extraction_failure_keeps_link_alive():
    link = _link("new")
    out = _apply_resolve_meta(link, {"ok": False, "error": "extraction failed"})
    assert link.status == "new"
    assert "extraction failed" in out["message"]
    assert out["status"] == "new"


def test_confirmed_404_marks_dead():
    link = _link("new")
    out = _apply_resolve_meta(link, {"ok": False, "error": "not found (404)"})
    assert link.status == "dead"
    assert out["status"] == "dead"


def test_inconclusive_retry_clears_a_false_dead_mark():
    link = _link("dead")
    out = _apply_resolve_meta(link, {"ok": False, "error": "extraction failed"})
    assert link.status == "new"
    assert out["status"] == "new"


def test_successful_probe_revives_previously_dead_link():
    link = _link("dead")
    out = _apply_resolve_meta(link, {
        "ok": True,
        "quality": "1080p",
        "duration": 12,
        "size_bytes": 1000,
        "thumbnail": "",
        "title": "Bela Sampaio",
        "stream_url": "https://cdn.example/v.mp4",
    })
    assert link.status == "resolved"
    assert out["status"] == "resolved"
    assert out["resolved"] is True


def test_purge_rejects_live_statuses():
    from fastapi import HTTPException
    from app.routers.forum_hub import _purgeable_or_400
    assert _purgeable_or_400("dead") == "dead"
    assert _purgeable_or_400("Imported") == "imported"
    try:
        _purgeable_or_400("new")
        raise AssertionError("live cards must not be bulk-deletable")
    except HTTPException as exc:
        assert exc.status_code == 400
