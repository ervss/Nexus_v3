import json

from app import playlist_history


def test_playlist_history_migrates_without_overwriting_new_state(tmp_path, monkeypatch):
    legacy = tmp_path / "app" / "playlist_fetches"
    current = tmp_path / "data" / "playlist_fetches"
    legacy.mkdir(parents=True)
    current.mkdir(parents=True)
    (legacy / "index.json").write_text(json.dumps([{"id": "old"}]), encoding="utf-8")
    (legacy / "fetch_old.json").write_text("legacy detail", encoding="utf-8")
    (current / "index.json").write_text(json.dumps([{"id": "new"}]), encoding="utf-8")
    monkeypatch.setattr(playlist_history, "LEGACY_DIR", legacy)
    monkeypatch.setattr(playlist_history, "HISTORY_DIR", current)

    assert playlist_history.playlist_history_dir() == str(current)
    assert json.loads((current / "index.json").read_text(encoding="utf-8")) == [{"id": "new"}]
    assert (current / "fetch_old.json").read_text(encoding="utf-8") == "legacy detail"
    (current / "fetch_old.json").unlink()
    playlist_history.playlist_history_dir()
    assert not (current / "fetch_old.json").exists()
