from app.extractors.legacy.webshare import parse_webshare_ident, resolve_webshare_detail_preview


def test_search_small_thumb_upgrades_to_single_frame_detail():
    raw = "https://img.webshare.cz/static/p/014223/1LpewnBWDw-S.jpg"
    assert resolve_webshare_detail_preview(raw) == (
        "https://img.webshare.cz/static2/p/014223/1LpewnBWDw-F02.jpg"
    )


def test_search_stripe_medium_upgrades_to_single_frame_detail():
    raw = "https://img.webshare.cz/static/p/014219/10Yy7qS5aw-M.jpg"
    assert resolve_webshare_detail_preview(raw) == (
        "https://img.webshare.cz/static2/p/014219/10Yy7qS5aw-F02.jpg"
    )


def test_file_info_stripe_large_becomes_single_frame():
    raw = "https://img.webshare.cz/static2/p/014219/10Yy7qS5aw-L.jpg"
    assert resolve_webshare_detail_preview(raw) == (
        "https://img.webshare.cz/static2/p/014219/10Yy7qS5aw-F02.jpg"
    )


def test_parse_webshare_pseudo_link():
    assert parse_webshare_ident("webshare:LywryTTrgQ:some title.mp4") == "LywryTTrgQ"


def test_existing_frame_preview_passthrough():
    raw = "https://img.webshare.cz/static2/p/014219/10Yy7qS5aw-F02.jpg"
    assert resolve_webshare_detail_preview(raw) == raw
