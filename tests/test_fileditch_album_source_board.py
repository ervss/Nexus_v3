from app.routers.source_boards import _detect_source_type, _parse_fileditch_album


def test_fileditch_album_detection_overrides_saved_generic_type():
    assert _detect_source_type("https://fileditchalbums.st/2hfe9gp745", "generic") == "fileditch_album"


def test_fileditch_album_collects_video_pages_once_and_skips_images():
    html = """
    <a href="https://fileditchfiles.st/alpha24/hash/First_Video.mp4?token=old" title="First video">
      <img src="/thumbs/first.jpg">
    </a>
    <a href="https://fileditchfiles.st/alpha24/hash/First_Video.mp4?token=new">duplicate</a>
    <a href="https://fileditchfiles.st/alpha24/hash/Second.webm">Second</a>
    <a href="https://fileditchfiles.st/alpha24/hash/poster.jpg">poster</a>
    <a href="https://example.org/video.mp4">other host</a>
    """
    items = _parse_fileditch_album(html, "https://fileditchalbums.st/2hfe9gp745")
    assert [item["title"] for item in items] == ["First video", "Second"]
    assert items[0]["url"] == "https://fileditchfiles.st/alpha24/hash/First_Video.mp4"
    assert items[0]["source_url"] == items[0]["url"]
    assert items[0]["thumbnail"] == "https://fileditchalbums.st/thumbs/first.jpg"


def test_fileditch_vids_album_card_uses_filename_and_deduplicates():
    html = '''<a href="https://fileditchvids.st/balpha39/hash/Example%20Video.mp4">mp4</a>
    <a href="https://fileditchvids.st/balpha39/hash/Example%20Video.mp4">Example Video.mp4</a>
    <a href="https://fakefileditchvids.st/balpha39/hash/other.mp4">other</a>'''
    items = _parse_fileditch_album(html, "https://fileditchalbums.st/4gvjbhghrm")
    assert len(items) == 1
    assert items[0]["title"] == "Example Video.mp4"
    assert items[0]["source_url"] == "https://fileditchvids.st/balpha39/hash/Example%20Video.mp4"
