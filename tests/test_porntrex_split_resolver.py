import asyncio

from app.routers import link_tester


def test_porntrex_metadata_fallback_preserves_best_flashvars_stream(monkeypatch):
    page = "https://www.porntrex.com/video/123/example/"
    html = """<title>Example</title><script>var flashvars = {
        video_url: 'https://cdn.example/low', video_url_text: '480p',
        video_alt_url: 'https://cdn.example/high', video_alt_url_text: '1080p'
    };</script>"""

    async def fetch(*args, **kwargs):
        return 200, html, page

    monkeypatch.setattr(link_tester, '_ntc_page', fetch)
    result = asyncio.run(link_tester._fetch_porntrex_meta(page, None, asyncio.Semaphore(1)))
    assert result['stream_url'] == 'https://cdn.example/high'
    assert result['height'] == 1080
