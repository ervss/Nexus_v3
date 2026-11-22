import asyncio
import base64
from types import SimpleNamespace

from app.extractors.leakedzone import LeakedzoneExtractor, decode_leakedzone_token
from app.extractors.registry import ExtractorRegistry
from app.source_catalog import classify_library_source_name


def test_decode_leakedzone_token():
    # 1. Test na reálnom tokene zo stránky Leakedzone
    real_token = (
        "7fKtexSNqdeLLI2T==waO9mN0gXRZdFMzlGWhh2N9IzZpNnJ5MWO3YDOjNTNzMGZlFWY4cTMjJzMlhzM4"
        "ImMkRzY0gDMxI2Y0IWZlVWZhBjM0YWNjlTOyQDZilDMhBTNmljN00zZpNnJxETN4QDMykzNx0TZtlGd/"
        "gTdz0mL3AzN1kTN1IzL4U3Mt9SbvNmLl52b6RWZrFWZs9yL6MHc0RHayPiEaOEjoamelGk3"
    )
    expected_url = (
        "https://leakedzone.com/m3u8/25595707.m3u8?time=1792048511&"
        "sig=469f50a09bd4299c5f420aeeeeb4cb1084c4d2b838e32c178aaedc353c8679c9&sig2=7haXis0WYEx46oNk"
    )
    assert decode_leakedzone_token(real_token) == expected_url

    # 2. Test na syntetickom tokene
    target = "https://cdn.leakedzone.com/video123.m3u8"
    b64 = base64.b64encode(target.encode()).decode()
    wrapped = "1234567890123456" + b64[::-1] + "abcdefghijklmnop"
    assert decode_leakedzone_token(wrapped) == target

    # 3. Neplatné vstupy
    assert decode_leakedzone_token("") is None
    assert decode_leakedzone_token("short") is None
    assert decode_leakedzone_token("invalid_base64_string_12345678901234567890") is None


def test_leakedzone_can_handle():
    ex = LeakedzoneExtractor()
    assert ex.can_handle("https://leakedzone.com/kassiewallis/video/25595707")
    assert ex.can_handle("https://www.leakedzone.com/creator/short/12345")
    assert ex.can_handle("https://leakedzone.com/kassiewallis/photo/67890")
    assert not ex.can_handle("https://evil.com/?leakedzone.com")
    assert not ex.can_handle("https://leakedzone.com.phishing.org/test")
    assert not ex.can_handle("invalid-url")


def test_leakedzone_registry_and_classification():
    extractor = ExtractorRegistry.find_extractor("https://leakedzone.com/kassiewallis/video/25595707")
    assert isinstance(extractor, LeakedzoneExtractor)
    assert classify_library_source_name("https://leakedzone.com/kassiewallis/video/25595707") == "Leakedzone"


def test_leakedzone_extract_video(monkeypatch):
    target_stream = "https://leakedzone.com/m3u8/12345.m3u8?sig=test"
    b64 = base64.b64encode(target_stream.encode()).decode()
    wrapped_token = "1234567890123456" + b64[::-1] + "abcdefghijklmnop"

    page_html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>kassiewallis Leaked video #12345 - Leakedzone</title>
        <meta name="description" content="Watch kassiewallis hot leak">
    </head>
    <body>
        <div id="media-player">
            <img src="https://image-cdn.leakedzone.com/storage/images/219549/12345/12345_300.webp" alt="kassiewallis video">
        </div>
        <script>
            playerInstance.setup({{
                file: f("{wrapped_token}"),
                width: '100%'
            }});
        </script>
    </body>
    </html>
    """

    m3u8_content = """#EXTM3U
#EXT-X-VERSION:3
#EXTINF:4.000,
segment1.ts
#EXTINF:4.500,
segment2.ts
#EXTINF:3.500,
segment3.ts
#EXT-X-ENDLIST
"""

    class MockClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get(self, url):
            if "m3u8" in url:
                return SimpleNamespace(status_code=200, text=m3u8_content)
            return SimpleNamespace(status_code=200, text=page_html)

    monkeypatch.setattr("app.extractors.leakedzone.httpx.AsyncClient", lambda **kwargs: MockClient())

    result = asyncio.run(LeakedzoneExtractor().extract("https://leakedzone.com/kassiewallis/video/12345"))
    assert result is not None
    assert result["id"] == "12345"
    assert result["title"] == "kassiewallis Leaked video #12345"
    assert result["stream_url"] == target_stream
    assert result["is_hls"] is True
    assert result["uploader"] == "kassiewallis"
    assert result["thumbnail"] == "https://image-cdn.leakedzone.com/storage/images/219549/12345/12345_300.webp"
    assert result["playback_referer"] == "https://leakedzone.com/kassiewallis/video/12345"
    assert "proxy_cookies" in result
