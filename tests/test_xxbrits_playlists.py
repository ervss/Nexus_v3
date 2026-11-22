import asyncio

from app.extractors.xxbrits import XXBritsExtractor
from app.routers import link_tester


PLAYLIST_URL = "https://www.xxbrits.com/playlists/8233/123455/"


def _page(current, next_page):
    next_link = (
        f'<a data-parameters="sort_by:added2fav_date;from:{next_page}">Next</a>'
        if next_page else ""
    )
    return f"""
    <div id="playlist_view_playlist_view">
      <div id="playlist_view_playlist_view_items">
        <div class="th item" data-playlist-item="https://www.xxbrits.com/videos/{current}/clip-{current}/">
          <a class="card-image" href="/videos/{current}/clip-{current}/"><img data-original="https://cdn.example/{current}.jpg" alt="Clip {current}"></a>
          <div class="bottom-panel"><div class="group"><div class="box"><span>12:10</span></div></div></div>
          <a class="title" title="Clip {current}" href="/videos/{current}/clip-{current}/">Clip {current}</a>
        </div>
      </div>
      <div id="playlist_view_playlist_view_pagination">
        <li class="item active"><span>{current}</span></li>{next_link}
      </div>
    </div>
    """


def test_xxbrits_playlist_url_is_distinct_from_watch_url():
    extractor = XXBritsExtractor()
    assert extractor.is_playlist_url(PLAYLIST_URL)
    assert not extractor.is_playlist_url("https://www.xxbrits.com/videos/30796/example/")


def test_xxbrits_playlist_page_parser_preserves_card_metadata_and_real_next_page():
    items, next_page = XXBritsExtractor._parse_playlist_page(_page(2, 3), PLAYLIST_URL)
    assert next_page == 3
    assert items == [{
        "url": "https://www.xxbrits.com/videos/2/clip-2/",
        "source_url": "https://www.xxbrits.com/videos/2/clip-2/",
        "title": "Clip 2",
        "thumbnail": "https://cdn.example/2.jpg",
        "duration": 730,
        "stream_url": "",
    }]


def test_tester_shapes_xxbrits_first_batch_as_playlist_with_cursor():
    class FakeXXBrits:
        name = "XXBrits"

        @staticmethod
        def is_playlist_url(url):
            return url == PLAYLIST_URL

        @staticmethod
        async def fetch_playlist_batch(url):
            return {
                "title": "12345",
                "items": [{
                    "url": "https://www.xxbrits.com/videos/2/clip-2/",
                    "source_url": "https://www.xxbrits.com/videos/2/clip-2/",
                    "title": "Clip 2",
                    "thumbnail": "https://cdn.example/2.jpg",
                    "duration": 730,
                    "stream_url": "",
                }],
                "page_start": 1,
                "pages_loaded": 10,
                "next_page": 11,
                "has_more": True,
            }

    result = asyncio.run(link_tester._try_album_extract(PLAYLIST_URL, FakeXXBrits()))
    assert result["data"]["kind"] == "playlist"
    assert result["data"]["playlist_next_page"] == 11
    assert result["data"]["playlist_has_more"] is True
    assert result["data"]["item_count"] == 1
