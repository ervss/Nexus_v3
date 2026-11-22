import asyncio

from app.database import Video
from app.maintenance import _fresh_stream_for_thumb


def test_fapfolder_rethumb_uses_durable_media_instead_of_expired_signature():
    video = Video(
        source_url="https://fapfolder.club/posts/100807",
        url="https://bucket.r2.cloudflarestorage.com/ffolder/uploads/videos/2026/03/clip.mp4?X-Amz-Expires=14400&X-Amz-Signature=expired",
    )
    assert asyncio.run(_fresh_stream_for_thumb(video)) == (
        "https://fap.onl/uploads/videos/2026/03/clip.mp4", "https://fapfolder.club/"
    )


def test_unrelated_r2_import_is_not_rewritten():
    video = Video(
        source_url="https://example.com/posts/1",
        url="https://bucket.r2.cloudflarestorage.com/ffolder/uploads/videos/clip.mp4?token=expired",
    )
    assert asyncio.run(_fresh_stream_for_thumb(video)) == ("", "")


def test_fapfolder_other_bucket_prefix_is_not_rewritten():
    video = Video(
        source_url="https://fapfolder.club/posts/1",
        url="https://bucket.r2.cloudflarestorage.com/other/uploads/videos/clip.mp4",
    )
    assert asyncio.run(_fresh_stream_for_thumb(video)) == ("", "")
