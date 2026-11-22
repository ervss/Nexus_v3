from unittest.mock import Mock, patch

from app.extractors.fnxtube import FNXTubeExtractor
from app.extractors.registry import ExtractorRegistry
from app.media_urls import is_pimpbunny_remote_media
from app.source_catalog import classify_library_source_name


def test_fnxtube_registry_and_host_boundary():
    extractor = ExtractorRegistry.find_extractor("https://fnxtube.com/videos/example/")
    assert isinstance(extractor, FNXTubeExtractor)
    assert extractor.can_handle("https://st1.fnxtube.com/get_file/0/file.mp4/")
    for url in ["https://fnxtube.com.evil.test/videos/example/", "https://evil.test/?fnxtube.com", "http://["]:
        assert not extractor.can_handle(url)


def test_signed_opaque_kvs_renditions_use_labels_and_site_referer():
    page = """<title>Example | FNXTube</title>
    video_url: 'https://fnxtube.com/get_file/0/opaque.mp4/?v-acctoken=low',
    video_url_text: '720p',
    video_alt_url: 'https://fnxtube.com/get_file/0/other.mp4/?v-acctoken=high',
    video_alt_url_text: '1080p'"""
    response = Mock(status_code=200, text=page)
    with patch("app.extractors.pimpbunny.browser_requests.get", return_value=response) as get, patch(
        "app.extractors.pimpbunny.requests.head",
        return_value=Mock(headers={"Content-Type": "video/mp4", "Content-Length": "123456"}),
    ):
        result = FNXTubeExtractor()._extract_sync("https://fnxtube.com/videos/example/")
    assert get.call_args.kwargs["headers"]["Referer"] == "https://fnxtube.com/"
    assert result["height"] == 1080
    assert result["quality_variants"] == [1080, 720]
    assert result["stream_url"].endswith("?v-acctoken=high")
    assert result["size_bytes"] == 123456


def test_fnxtube_signed_remote_media():
    assert is_pimpbunny_remote_media("https://st1.fnxtube.com/remote_control.php?file=clip.mp4&acctoken=signed")
    assert not is_pimpbunny_remote_media("https://fnxtube.com.evil.test/remote_control.php?file=clip.mp4")
    assert classify_library_source_name("https://fnxtube.com/videos/example/") == "FNXTube"


def test_fileditch_source_classification_is_not_filester():
    assert classify_library_source_name(
        "https://fileditchfiles.st/beta34/example_source.mp4"
    ) == "FileDitch"
