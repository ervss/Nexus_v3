import pytest
from app.database import SessionLocal, Video
from app.routers.duplicates import (
    compare_album,
    replace_videos,
    AlbumCompareBody,
    AlbumCompareItem,
    ReplaceVideosBody,
    ReplacementItem,
    _lib_index,
)


def test_compare_album_and_replace():
    db = SessionLocal()
    test_video = None
    try:
        # Priprav testovacie video v kniznici
        test_video = Video(
            title="Model Test Scene 01 [720p].mp4",
            url="https://example.com/old_720p.mp4",
            source_url="https://example.com/old_720p.mp4",
            height=720,
            duration=600.0,
            file_size_mb=250.0,
            quality="720p",
            batch_name="Test Batch",
            status="ready_to_stream",
        )
        db.add(test_video)
        db.commit()
        db.refresh(test_video)

        # Force rebuild index
        _lib_index.rebuild_if_needed(db, force=True)

        # 1. Porovnanie s lepsou kvalitou (1080p, 650 MB)
        req_better = AlbumCompareBody(
            items=[
                AlbumCompareItem(
                    url="https://bunkr.cr/f/new_1080p",
                    title="Model Test Scene 01 1080p.mp4",
                    size_bytes=650 * 1024 * 1024,
                    height=1080,
                    duration=600.0,
                )
            ]
        )
        res_better = compare_album(req_better, db)
        assert res_better["counts"]["better"] == 1
        item_res = res_better["results"][0]
        assert item_res["status"] == "better"
        assert item_res["matched_video"]["id"] == test_video.id

        # 2. Porovnanie s horsou kvalitou (480p, 100 MB)
        req_worse = AlbumCompareBody(
            items=[
                AlbumCompareItem(
                    url="https://bunkr.cr/f/new_480p",
                    title="Model Test Scene 01 480p.mp4",
                    size_bytes=100 * 1024 * 1024,
                    height=480,
                    duration=600.0,
                )
            ]
        )
        res_worse = compare_album(req_worse, db)
        assert res_worse["counts"]["worse"] == 1
        assert res_worse["results"][0]["status"] == "worse"

        # 3. Porovnanie s duplikatom (720p, podobna velkost)
        req_dupe = AlbumCompareBody(
            items=[
                AlbumCompareItem(
                    url="https://bunkr.cr/f/same_720p",
                    title="Model Test Scene 01 720p.mp4",
                    size_bytes=255 * 1024 * 1024,
                    height=720,
                    duration=600.0,
                )
            ]
        )
        res_dupe = compare_album(req_dupe, db)
        assert res_dupe["counts"]["duplicate"] == 1
        assert res_dupe["results"][0]["status"] == "duplicate"

        # 4. Nahradenie videa lepsou kvalitou
        req_rep = ReplaceVideosBody(
            replacements=[
                ReplacementItem(
                    existing_id=test_video.id,
                    url="https://bunkr.cr/f/new_1080p",
                    title="Model Test Scene 01 [1080p].mp4",
                    height=1080,
                    duration=600.0,
                    file_size_mb=650.0,
                )
            ]
        )
        res_rep = replace_videos(req_rep, db)
        assert res_rep["success"] is True
        assert res_rep["replaced_count"] == 1

        db.refresh(test_video)
        assert test_video.height == 1080
        assert test_video.quality == "1080p"
        assert test_video.file_size_mb == 650.0
        assert test_video.url == "https://bunkr.cr/f/new_1080p"
        assert test_video.batch_name == "Test Batch"  # batch name zachovany!

    finally:
        if test_video and test_video.id:
            db.delete(test_video)
            db.commit()
        db.close()


if __name__ == "__main__":
    test_compare_album_and_replace()
    print("Python test for compare_album and replace passed successfully.")
