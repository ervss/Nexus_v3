import pytest

from app.extractors.filester import FilesterExtractor, is_fileditch_url
from app.source_catalog import classify_library_source_name


@pytest.mark.parametrize(
    "url",
    [
        "https://fileditchfiles.st/beta34/00ccf892e0ea2bff574c/movie_source.mp4",
        "https://fileditchvids.st/alpha37/f2efd5e88941643fe8fe/movie.mp4",
        "https://theditch.st/z6nevvdy",
        "https://freakingfileditch.me/video.mp4?md5=abc&expires=123",
        "https://blehpooffileditchvidsstuff.org/tokenized-download",
        "https://donotsharethesetemplinksyouidiot.st/file.mp4?md5=abc",
    ],
)
def test_all_known_fileditch_hosts_are_routed_to_shared_extractor(url):
    extractor = FilesterExtractor()

    assert is_fileditch_url(url)
    assert extractor.source_label(url) == "FileDitch"
    assert extractor.can_handle(url)
    assert classify_library_source_name(url) == "FileDitch"


def test_unrelated_host_is_not_claimed_as_fileditch():
    assert not is_fileditch_url("https://example.com/alpha37/movie.mp4")
