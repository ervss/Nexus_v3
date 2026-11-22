from app.extractors.cyberfile import CyberFileExtractor


def test_cyberfile_folder_listing_keeps_file_page_metadata():
    html = """
    <div class="fileIconLi" fileid="99" dttitle="clip.mp4"
         dtsizeraw="10485760" dtuploaddate="17/07/2023 20:33:45"
         dtfullurl="https://cyberfile.me/abcd">
      <img src="/cache/thumb.jpg">
    </div>
    <div class="fileIconLi" fileid="100" dttitle="notes.txt"
         dtsizeraw="11" dtfullurl="https://cyberfile.me/skip"></div>
    """

    entries = CyberFileExtractor._parse_listing(html, "https://cyberfile.me/folder/x/demo")

    assert len(entries) == 1
    assert entries[0]["url"] == "https://cyberfile.me/abcd"
    assert entries[0]["thumbnail"] == "https://cyberfile.me/cache/thumb.jpg"
    assert entries[0]["size_bytes"] == 10 * 1024 * 1024
    assert entries[0]["upload_date"] == "2023-07-17"


def test_cyberfile_folder_id_and_signed_stream_parsing():
    assert CyberFileExtractor._folder_id("loadImages('folder', '48904', 1)") == "48904"
    assert CyberFileExtractor._stream_url(
        'src="https://p1.cyberfile.me/abcd/clip.mp4?download_token=a&amp;x=1"'
    ) == "https://p1.cyberfile.me/abcd/clip.mp4?download_token=a&x=1"


def test_cyberfile_stream_parser_does_not_truncate_at_letter_s():
    stream = CyberFileExtractor._stream_url(
        'src="https://p1.cyberfile.me/f6le/YJgjvpACHwChGdiWskC9.mp4?download_token=abc"'
    )
    assert stream.endswith("YJgjvpACHwChGdiWskC9.mp4?download_token=abc")
