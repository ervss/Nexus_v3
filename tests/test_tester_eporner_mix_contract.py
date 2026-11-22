from pathlib import Path


def test_tester_has_eporner_mix_focus_mode():
    source = Path("app/templates/tester.html").read_text(encoding="utf-8")
    assert "eporner_mix" in source
    assert "/api/tester/eporner-mixes/" in source
    assert 'id="epornerMixBanner"' in source
    assert 'id="epornerMixDeepBtn"' in source
    assert 'id="epornerMixPlaylistsBtn"' in source
    assert 'id="epornerMixVideosBtn"' in source
    assert "initEpornerMixSession" in source
    assert "saveEpornerMixSnapshot" in source
    assert "snapshotVideos" in source
    assert "playlist_sources" in source
    assert "selection_only" in source


def test_dashboard_can_render_eporner_tester_mix_as_gallery_cards():
    source = Path("app/static/main.js").read_text(encoding="utf-8")
    template = Path("app/templates/index.html").read_text(encoding="utf-8")
    router = Path("app/routers/link_tester.py").read_text(encoding="utf-8")
    assert "showTesterVids" in source
    assert "testerMix" in source
    assert "/eporner-mixes/${encodeURIComponent(this.testerMix.id)}/videos" in source
    assert "Tester Vids" in template
    assert '"tester_mix": True' in router
    assert '"storage_type": "tester_index"' in router


def test_dashboard_exposes_selected_url_copy_actions_and_latest_tester_fallback():
    source = Path("app/static/main.js").read_text(encoding="utf-8")
    template = Path("app/templates/index.html").read_text(encoding="utf-8")
    router = Path("app/routers/link_tester.py").read_text(encoding="utf-8")
    assert "copySelectedUrls" in source
    assert "navigator.clipboard.writeText" in source
    assert "Copy direct" in template
    assert "Copy source" in template
    assert "/api/tester/eporner-mixes/latest" in source
    assert '@router.get("/eporner-mixes/latest")' in router


def test_source_board_switch_resets_gallery_and_ignores_stale_loads():
    source = Path("app/static/main.js").read_text(encoding="utf-8")
    template = Path("app/templates/index.html").read_text(encoding="utf-8")
    assert "async openSourceBoard(board)" in source
    assert "videoLoadRequestId" in source
    assert "if (requestId !== this.videoLoadRequestId) return;" in source
    assert "String(activeSourceBoardId) === String(board.id)" in template
