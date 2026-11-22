"""Unit checks for keyword attribution / content feedback fix."""
from types import SimpleNamespace

from filester_api import attribute_hits_to_keywords, record_keyword_feedback
from discovery.rotation import KeywordRotator
from index.database import Database
import tempfile
from pathlib import Path


def test_generic_wayback_hits_do_not_credit_keywords():
    hits = [
        SimpleNamespace(folder_id="aaa1111111111111", query="filester.me/f/*", query_class="me"),
        SimpleNamespace(folder_id="bbb2222222222222", query="filester.me/f/*", query_class="me"),
    ]
    attributed = attribute_hits_to_keywords(hits, ["blonde", "pov"])
    assert attributed["blonde"] == set()
    assert attributed["pov"] == set()


def test_keyword_query_hits_prefer_matching_keyword():
    hits = [
        SimpleNamespace(folder_id="ccc3333333333333", query='"filester.me/f/" blonde', query_class="kw_blonde"),
        SimpleNamespace(folder_id="ddd4444444444444", query="filester.me/f/*", query_class="me"),
    ]
    attributed = attribute_hits_to_keywords(hits, ["blonde", "pov"])
    assert "ccc3333333333333" in attributed["blonde"]
    assert "ccc3333333333333" not in attributed["pov"]
    assert "ddd4444444444444" not in attributed["blonde"]
    assert "ddd4444444444444" not in attributed["pov"]


def test_record_feedback_writes_content_not_zero():
    tmp = tempfile.TemporaryDirectory()
    db_path = Path(tmp.name) / "t.db"
    db = Database(db_path)
    rot = KeywordRotator(db)
    import filester_api as api
    old = api.ROT
    api.ROT = rot
    try:
        hits = [SimpleNamespace(folder_id="eee5555555555555", query='"filester.me/f/" throat', query_class="kw_throat")]
        record_keyword_feedback(
            hits,
            ["throat"],
            before=set(),
            content_ids={"eee5555555555555"},
        )
        row = db._conn.execute("SELECT * FROM keywords WHERE keyword='throat'").fetchone()
        assert row is not None
        assert row["unique_candidates"] == 1
        assert row["unseen_candidates"] == 1
        assert row["verified_content"] == 1
        assert row["status"] == "HOT"
    finally:
        api.ROT = old
        db._conn.close()
        tmp.cleanup()


if __name__ == "__main__":
    test_generic_wayback_hits_do_not_credit_keywords()
    test_keyword_query_hits_prefer_matching_keyword()
    test_record_feedback_writes_content_not_zero()
    print("PASS: keyword attribution + content feedback")
