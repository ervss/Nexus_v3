from app.combined_history import get_history, list_history, save


def test_history_keeps_keyword_day_and_fetched_cards(tmp_path):
    first = save({
        "keyword": "Angelique",
        "day": "2026-09-26",
        "title": "Spoločný album (2)",
        "source_albums": [
            {"url": "https://bunkr.cr/a/one", "title": "One"},
            {"url": "https://bunkr.cr/a/two", "title": "Two"},
        ],
        "items": [
            {"url": "https://bunkr.cr/f/a.mp4", "type": "video", "title": "a", "stream_url": "https://cdn/secret"},
            {"url": "https://bunkr.cr/f/b.mp4", "type": "video", "duration": 90, "height": 1080},
        ],
    }, directory=tmp_path)
    updated = save({
        "id": first["id"],
        "keyword": "",
        "items": [
            {"url": "https://bunkr.cr/f/a.mp4", "type": "video", "duration": 40, "height": 720},
            {"url": "https://bunkr.cr/f/b.mp4", "type": "video", "duration": 90, "height": 1080},
            {"url": "https://bunkr.cr/f/c.jpg", "type": "image"},
        ],
    }, directory=tmp_path)

    assert updated["id"] == first["id"]
    assert updated["keyword"] == "Angelique"
    assert updated["day"] == "2026-09-26"
    assert updated["video_count"] == 2
    assert updated["fetched_count"] == 2
    assert updated["file_count"] == 3
    stored = get_history(first["id"], directory=tmp_path)
    assert "stream_url" not in stored["items"][0]
    assert list_history(keyword="angel", directory=tmp_path)[0]["id"] == first["id"]
    assert list_history(day="2026-09-27", directory=tmp_path) == []
    assert list_history(day="2026-09-26", keyword="nope", directory=tmp_path) == []


def test_search_snapshot_restores_all_cards_and_filters(tmp_path):
    from app.combined_history import save, get_history, list_history
    cards = [{'url': f'https://example.test/{i}', 'type':'video', 'title':str(i)} for i in range(2000)]
    summary = save({'kind':'search','keyword':'facefuck','items':cards,
        'search_state':{'filters':{'date':'30d','content':'video'},'page':20,'has_more':False}}, directory=tmp_path)
    restored = get_history(summary['id'], directory=tmp_path)
    assert restored['kind'] == 'search' and len(restored['items']) == 2000
    assert restored['search_state']['filters']['date'] == '30d'
    assert list_history(directory=tmp_path)[0]['kind'] == 'search'


def test_fetch_metadata_is_saved_to_only_its_source_albums_and_reloaded(tmp_path, monkeypatch):
    from app import bunkr_cache, main
    from app.combined_history import sync_fetch_metadata
    monkeypatch.setattr(bunkr_cache, '_DIR', tmp_path)
    monkeypatch.setattr(bunkr_cache, '_FILES_PATH', tmp_path / 'files.json')
    monkeypatch.setattr(bunkr_cache, '_ALBUM_SNAPSHOTS_DIR', tmp_path / 'snapshots')
    monkeypatch.setattr(bunkr_cache, '_files', {})
    monkeypatch.setattr(bunkr_cache, '_files_loaded', False)
    monkeypatch.setattr(bunkr_cache, '_files_dirty', False)
    first, second = 'https://bunkr.cr/a/first', 'https://bunkr.cr/a/second'
    url = 'https://bunkr.cr/f/movie'
    sync_fetch_metadata({'source_albums':[{'url':first}, {'url':second}], 'items':[
        {'url':url,'type':'video','title':'Movie','duration':90,'height':1080,
         'size_bytes':200000000,'size_verified':True,'thumbnail':'https://cdn.test/cover.jpg',
         'stream_url':'https://cdn.test/secret','source_album_urls':[first]}]})
    assert bunkr_cache.album_snapshot_get(first)['items'][0]['duration'] == 90
    assert bunkr_cache.album_snapshot_get(second) is None
    assert 'stream_url' not in bunkr_cache.album_snapshot_get(first)['items'][0]
    bunkr_cache.file_meta_put(url, {'thumbnail':'https://cdn.test/new.jpg'})
    bunkr_cache.file_meta_put(url, {'size_bytes': 123})
    bunkr_cache.file_meta_flush()
    monkeypatch.setattr(bunkr_cache, '_files', {})
    monkeypatch.setattr(bunkr_cache, '_files_loaded', False)
    card = main._dh_cached_file_card({'url':url,'type':'video','size_bytes':123,'total_size_bytes':123})
    assert card['duration'] == 90 and card['height'] == 1080
    assert card['size_bytes'] == card['total_size_bytes'] == 200000000
    assert card['thumbnail'] == 'https://cdn.test/new.jpg'


def test_saved_selection_survives_history_limit_and_preserves_kind(tmp_path):
    collection = save({'kind': 'collection', 'title': 'Spoločný album · 2026-11-16 · 1 videí',
        'items': [{'url': 'https://bunkr.cr/f/a', 'type': 'video'}]}, directory=tmp_path)
    for index in range(81):
        save({'items': [{'url': f'https://example.test/{index}', 'type': 'video'}]}, directory=tmp_path)
    assert get_history(collection['id'], directory=tmp_path)['kind'] == 'collection'
    updated = save({'id': collection['id'], 'items': [{'url': 'https://bunkr.cr/f/a', 'type': 'video'}]}, directory=tmp_path)
    assert updated['kind'] == 'collection'
    assert any(row['id'] == collection['id'] for row in list_history(directory=tmp_path))


def test_stash_collection_idempotent_across_four_surfaces_and_share_warnings(tmp_path):
    from app.combined_history import (
        add_to_collection,
        build_share_metadata,
        compute_album_delta,
        list_watchlist,
        remove_from_collection,
        upsert_watchlist_item,
    )

    items_batch_1 = [
        {"url": "https://eporner.com/video-1", "title": "Quantum Hit", "surface": "quantum", "height": 1080, "duration": 600},
        {"url": "https://pornhub.com/view_video.php?viewkey=abc", "title": "Related Hit", "surface": "related", "height": 2160, "duration": 900},
        {"chat_id": -100123456789, "message_id": 42, "title": "Telegram Exclusive", "source": "telegram", "surface": "telegram", "duration": 300},
        {"url": "https://bunkr.cr/f/album-vid.mp4", "title": "Album Video", "surface": "album", "source_album_url": "https://bunkr.cr/a/test"},
    ]
    res1 = add_to_collection(items_batch_1, title="Na večer", directory=tmp_path)
    assert res1["added_count"] == 4
    assert res1["duplicate_count"] == 0
    assert res1["total_count"] == 4

    # Opätovné pridanie rovnakého výskytu nesmie vytvoriť duplikát, ale obohatí metadáta
    res2 = add_to_collection(
        [
            {"chat_id": -100123456789, "message_id": 42, "title": "Telegram Exclusive 4K", "height": 2160},
            {"url": "https://eporner.com/video-1", "title": "Quantum Hit"},
        ],
        title="Na večer",
        directory=tmp_path,
    )
    assert res2["added_count"] == 0
    assert res2["duplicate_count"] == 2
    assert res2["total_count"] == 4

    tg_item = next(i for i in res2["items"] if i["canonical_key"] == "tg:-100123456789:42")
    assert tg_item["height"] == 2160
    assert tg_item["requires_private_access"] is True
    assert "t.me/c/123456789/42" in tg_item["share_url"]
    assert "súkromnom Telegram" in tg_item["access_warning"]

    pub_meta = build_share_metadata({"url": "https://eporner.com/video-1", "source": "eporner"})
    assert pub_meta["requires_private_access"] is False
    assert pub_meta["access_warning"] == ""

    # Odstránenie položky z kolekcie
    after_remove = remove_from_collection(res1["summary"]["id"], ["tg:-100123456789:42"], directory=tmp_path)
    assert after_remove["removed_count"] == 1
    assert after_remove["total_count"] == 3

    # Album Delta: oddelenie "Nové od poslednej návštevy" vs "Ešte nie je v knižnici"
    album_url = "https://bunkr.cr/a/delta-test"
    initial_files = [
        {"url": "https://bunkr.cr/f/v1.mp4", "title": "V1"},
        {"url": "https://bunkr.cr/f/v2.mp4", "title": "V2"},
    ]
    d1 = compute_album_delta(
        album_url,
        initial_files,
        library_urls=["https://bunkr.cr/f/v1.mp4"],
        mark_visited=True,
        directory=tmp_path,
    )
    assert d1["has_previous_visit"] is False
    assert d1["in_library_count"] == 1
    assert d1["not_in_library_count"] == 1

    later_files = initial_files + [{"url": "https://bunkr.cr/f/v3_new.mp4", "title": "V3 New"}]
    d2 = compute_album_delta(
        album_url,
        later_files,
        library_urls=["https://bunkr.cr/f/v1.mp4"],
        mark_visited=False,
        directory=tmp_path,
    )
    assert d2["has_previous_visit"] is True
    assert d2["delta_new_count"] == 1
    assert d2["delta_new_keys"] == ["https://bunkr.cr/f/v3_new.mp4"]
    assert d2["not_in_library_count"] == 2

    # Watchlist upsert
    sub = upsert_watchlist_item(
        {"kind": "creator", "target": "Angelique", "title": "Angelique", "surface": "related"},
        directory=tmp_path,
    )
    assert sub["title"] == "Angelique"
    assert len(list_watchlist(directory=tmp_path)) == 1

