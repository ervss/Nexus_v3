from app import telegram_search_history as history


def test_search_history_round_trip(tmp_path, monkeypatch):
    monkeypatch.setattr(history, "HISTORY_DIR", tmp_path)
    chats = [{"id": "-100123", "title": "Private group"}]
    results = [{"title": "Clip", "chat_id": 123, "message_id": 8}]
    saved = history.save_search("clip", chats, results, results, {"limit": 50})

    assert saved["result_count"] == 1
    assert "results" not in saved
    assert history.list_searches()[0]["id"] == saved["id"]
    assert history.get_search(saved["id"])["results"] == results
    assert history.get_search("../outside") is None
