from app.quantum_search_v2 import concepts, rank, variants


def test_concepts_and_bounded_variants():
    query = "fake tits deepthroat pov"
    assert len(concepts(query)) == 3
    searches = variants(query)
    assert len(searches) <= 4
    assert searches[0] == query
    assert any("fake boobs" in text for text in searches)
    assert any("deep throat" in text for text in searches)


def test_complete_concept_match_beats_high_quality_partial_match():
    query = "fake tits deepthroat pov"
    complete = {"title": "POV fake boobs deep throat", "height": 720}
    partial = {"title": "POV", "height": 2160, "upload_date": "2026-10-15"}
    assert rank(complete, query) > rank(partial, query)


def test_title_match_beats_tag_match_at_equal_coverage():
    query = "mountain bike"
    title = {"title": "Mountain bike"}
    tags = {"title": "Other video", "tags": ["mountain", "bike"]}
    assert rank(title, query) > rank(tags, query)


def test_short_concept_matches_whole_tokens():
    assert rank({"title": "Party highlights"}, "art")[1] == 0
    assert rank({"title": "Art highlights"}, "art")[1] == 1
