import base64

import pytest

from app.torrent.bencode import bencode, torrent_infohash
from app.torrent.files import contiguous_end, file_byte_offset, pick_video_file, resolve_video_path
from app.torrent.qbittorrent import parse_add_response
from app.torrent.limit import WindowLimiter
from app.torrent.normalize import (
    acceptable_download_url,
    build_magnet,
    canonical_infohash,
    clean_details_url,
    dedupe_results,
    lookup_download_ref,
    normalize_jackett_result,
    parse_torznab,
    public_result,
    store_download_ref,
    validate_magnet,
)
from app.torrent.normalize import RejectedURL
from app.torrent.mypornclub import parse_mypornclub_html
from app.torrent.search import indexers_without_category
from app.torrent.thumbs import _tpdb_match, extract_screenshot_urls, sniff_image


HASH = "ab" * 20


def test_canonical_infohash_accepts_hex_and_base32():
    assert canonical_infohash(HASH.upper()) == HASH
    encoded = base64.b32encode(bytes.fromhex(HASH)).decode()
    assert canonical_infohash(encoded) == HASH
    assert canonical_infohash("nope") == ""


def test_jackett_row_builds_magnet_and_strips_secrets():
    row = normalize_jackett_result({
        "Title": "Scene Name 1080p",
        "Size": "1000",
        "Seeders": 4,
        "Peers": 11,
        "InfoHash": HASH,
        "Tracker": "demo",
        "Details": "https://example.com/torrent?apikey=secret&id=9",
        "PublishDate": "/Date(1700000000000)/",
        "Link": "http://127.0.0.1:9117/dl/item?apikey=secret",
    })
    assert row["leechers"] == 7
    assert row["magnet"] == build_magnet(HASH, "Scene Name 1080p")
    assert "apikey" not in row["details_url"]
    assert "id=9" in row["details_url"]
    assert row["publish_date"].startswith("2023-11-14")


def test_poster_url_with_api_key_is_not_exposed():
    row = normalize_jackett_result({
        "Title": "Poster",
        "InfoHash": HASH,
        "Seeders": 2,
        "Poster": "http://127.0.0.1:9117/poster?apikey=secret",
    })
    assert "apikey=secret" in row["poster_url"]
    exposed = public_result(row, ["http://127.0.0.1:9117"])
    assert "poster_url" not in exposed
    assert "apikey" not in str(exposed)


def test_public_result_hides_indexer_download_url():
    row = normalize_jackett_result({
        "Title": "Only link",
        "InfoHash": "",
        "Link": "http://127.0.0.1:9117/dl/item?apikey=secret",
        "Seeders": 1,
    })
    exposed = public_result(row, ["http://127.0.0.1:9117"])
    assert "download_url" not in exposed
    assert exposed["ref"]
    assert "apikey" not in exposed["ref"]
    assert lookup_download_ref(exposed["ref"]).startswith("http://127.0.0.1:9117/")


def test_download_url_on_another_local_port_is_rejected():
    assert acceptable_download_url("http://127.0.0.1:9117/dl/x", ["http://127.0.0.1:9117"])
    assert not acceptable_download_url("http://127.0.0.1:8080/api", ["http://127.0.0.1:9117"])
    assert not acceptable_download_url("http://10.0.0.5/file.torrent", [])


def test_private_details_page_is_dropped():
    assert clean_details_url("http://127.0.0.1/admin") == ""
    assert clean_details_url("https://cdn.example.com/release") == "https://cdn.example.com/release"


def test_magnet_validation():
    magnet = build_magnet(HASH, "Name")
    assert validate_magnet(magnet) == magnet
    with pytest.raises(RejectedURL):
        validate_magnet("https://example.com/file")


def test_torznab_item_and_dedupe():
    xml = f"""<?xml version="1.0"?>
    <rss><channel><item>
      <title>From XML</title>
      <jackettindexer>xmldex</jackettindexer>
      <size>50</size>
      <comments>https://example.com/details</comments>
      <torznab:attr xmlns:torznab="http://torznab.com/schemas/2015/feed" name="seeders" value="3"/>
      <torznab:attr xmlns:torznab="http://torznab.com/schemas/2015/feed" name="peers" value="1"/>
      <torznab:attr xmlns:torznab="http://torznab.com/schemas/2015/feed" name="infohash" value="{HASH}"/>
    </item></channel></rss>"""
    rows = parse_torznab(xml)
    assert rows[0]["indexer"] == "xmldex"
    assert rows[0]["seeders"] == 3
    weaker = dict(rows[0], seeders=1, indexer="other")
    stronger = dict(rows[0], seeders=9, indexer="best")
    assert dedupe_results([weaker, stronger])[0]["indexer"] == "best"


def test_video_choice_skips_sample_and_stays_inside_save_path(tmp_path):
    files = [
        {"name": "clip-sample.mp4", "size": 4_000_000, "index": 0},
        {"name": "clip.mkv", "size": 900_000_000, "index": 1},
    ]
    chosen = pick_video_file(files)
    assert chosen["name"] == "clip.mkv"
    assert file_byte_offset(files, chosen) == 4_000_000
    root = tmp_path / "downloads"
    root.mkdir()
    video = root / "clip.mkv"
    video.write_bytes(b"video")
    outside = tmp_path / "secret.mkv"
    outside.write_bytes(b"secret")
    assert resolve_video_path(str(root), "", "clip.mkv") == video
    assert resolve_video_path(str(root), str(root / "Movie"), "../secret.mkv") is None


def test_contiguous_pieces_stop_before_a_hole():
    states = [2, 2, 0, 2]
    assert contiguous_end(states, 4, 0, 0, 100, 16) == 7
    assert contiguous_end(states, 4, 0, 8, 100, 16) is None


def test_screenshot_and_scene_match():
    payload = {"screenshots": [{"screenshot": "https://cdn.example.com/a.jpg"}, "skip"]}
    assert extract_screenshot_urls(payload) == ["https://cdn.example.com/a.jpg"]
    assert sniff_image(b"\xff\xd8\xff" + b"\x00" * 20) == "image/jpeg"
    scenes = [
        {"title": "Other Scene Completely", "poster": "https://cdn.example.com/no.jpg"},
        {"title": "Riley Scene Hotel Night", "poster": "https://cdn.example.com/yes.jpg"},
    ]
    assert _tpdb_match("Riley Scene Hotel Night 1080p", scenes) == "https://cdn.example.com/yes.jpg"
    assert _tpdb_match("zzzz", scenes) == ""


def test_torrent_file_infohash_and_qbit5_add_response():
    info = {b"length": 4, b"name": b"clip", b"piece length": 16384, b"pieces": b"\x11" * 20}
    blob = bencode({b"info": info})
    assert torrent_infohash(blob) == __import__("hashlib").sha1(bencode(info)).hexdigest()
    accepted, ids = parse_add_response(202, '{"added_torrent_ids":[],"failure_count":0,"pending_count":1,"success_count":0}')
    assert accepted and ids == []
    accepted, ids = parse_add_response(200, '{"added_torrent_ids":["AbC"],"failure_count":0,"pending_count":0,"success_count":1}')
    assert accepted and ids == ["abc"]
    accepted, ids = parse_add_response(200, "Fails.")
    assert not accepted


def test_indexers_that_ignore_xxx_category_are_queried_again():
    reports = [
        {"ID": "mypornclub", "Results": 36, "Error": None},
        {"ID": "torrentdownload", "Results": 0, "Error": None},
        {"ID": "torrentdownloads", "Results": "0", "Error": None},
        {"ID": "limetorrents", "Results": 0, "Error": "timeout"},
        {"ID": "all", "Results": 0, "Error": None},
        {"ID": "../admin", "Results": 0, "Error": None},
    ]
    assert indexers_without_category(reports) == ["torrentdownload", "torrentdownloads"]


def test_mypornclub_page_exposes_screenshot_and_trailer():
    html = (
        "<div class='torrent_links' data-content='"
        '[\\"\\\\/\\\\/cdn.example.com\\\\/clip\\\\/vidthumb.mp4\\",'
        '\\"\\\\/\\\\/cdn.example.com\\\\/clip\\\\/full.jpg\\",'
        '\\"\\\\/\\\\/sxyprn.com\\\\/post\\\\/abc.html\\"]'
        "'></div>"
    )
    media = parse_mypornclub_html(html)
    assert media.images == ["https://cdn.example.com/clip/full.jpg"]
    assert media.trailer == "https://cdn.example.com/clip/vidthumb.mp4"


def test_search_rate_limit_opens_after_the_window():
    limiter = WindowLimiter(limit=2, window=60)
    assert limiter.allow()[0]
    assert limiter.allow()[0]
    allowed, retry = limiter.allow()
    assert not allowed
    assert retry > 0


def test_ref_store_roundtrip():
    token = store_download_ref("https://example.com/a.torrent")
    assert lookup_download_ref(token) == "https://example.com/a.torrent"
