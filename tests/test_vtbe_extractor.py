from app.extractors.vtbe import VtbeExtractor


def test_vtbe_extractor_recognizes_vtube_hosts():
    extractor = VtbeExtractor()
    assert extractor.can_handle("https://vtbe.to/sfcq41w08uq5.html")
    assert extractor.can_handle("https://cdn.vtbe.to/embed/video")
    assert not extractor.can_handle("https://example.com/vtbe.to/video")


def test_vtbe_extractor_prefers_hls_from_player_html():
    page = '''
        <video><source src="https://cdn.vtbe.to/480.mp4"></video>
        <script>const config = { file: "https:\\/\\/cdn.vtbe.to\\/master.m3u8" };</script>
    '''
    assert VtbeExtractor._extract_media_url(page, "https://vtbe.to/abc.html") == "https://cdn.vtbe.to/master.m3u8"
