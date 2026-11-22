import asyncio
from unittest.mock import AsyncMock

from app.search_engine import ExternalSearchEngine
from app.search_pipeline import matches_query


def test_beeg_profile_page_expands_to_video_cards():
    cards = "".join(
        f"""
        <div class="UnitFrame VideoTile" data-testid="unit">
            <a href="/-{index}"><span data-testid="unit-title">Video {index}</span></a>
            <img src="/thumb-{index}.jpg" alt="Video {index}">
            <span data-testid="unit-amount">12:34</span>
        </div>
        """
        for index in range(6)
    )
    html = f"""
        <html><head><meta property="og:title" content="Lola Bonita | Beeg"></head>
        <body>{cards}</body></html>
    """

    results = ExternalSearchEngine._parse_beeg_profile_videos(
        html, "https://beeg.com/9285486"
    )

    assert len(results) == 6
    assert results[0]["url"] == "https://beeg.com/-0"
    assert results[0]["performer"] == "Lola Bonita"
    assert results[0]["duration"] == "12:34"
    assert matches_query(results[0], "Lola Bonita")


def test_beeg_search_expands_profile_hits_instead_of_returning_profile_page():
    engine = ExternalSearchEngine.__new__(ExternalSearchEngine)
    engine.search_via_duckduckgo_async = AsyncMock(return_value=[
        {"source": "Beeg", "title": "Lola Bonita", "url": "https://beeg.com/9285486"}
    ])
    engine.search_via_yahoo_async = AsyncMock(return_value=[])
    engine._fetch_beeg_profile_videos = AsyncMock(return_value=[
        {"source": "Beeg", "title": f"Clip {index}", "url": f"https://beeg.com/-{index}"}
        for index in range(6)
    ])

    results = asyncio.run(engine.search_beeg_async("Lola Bonita", result_limit=10))

    assert len(results) == 6
    assert all(result["url"] != "https://beeg.com/9285486" for result in results)
    engine._fetch_beeg_profile_videos.assert_awaited_once_with("https://beeg.com/9285486")


def test_beeg_drops_unexpanded_profiles_and_non_video_pages():
    engine = ExternalSearchEngine.__new__(ExternalSearchEngine)
    engine.search_via_duckduckgo_async = AsyncMock(return_value=[
        {'url': 'https://beeg.com/12345'}, {'url': 'https://beeg.com/search'},
        {'url': 'https://beeg.com/-98765'},
    ])
    engine.search_via_yahoo_async = AsyncMock(return_value=[])
    engine._fetch_beeg_profile_videos = AsyncMock(return_value=[])
    assert [x['url'] for x in asyncio.run(engine.search_beeg_async('example'))] == ['https://beeg.com/-98765']
