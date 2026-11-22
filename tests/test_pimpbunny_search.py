import asyncio
from unittest.mock import AsyncMock, patch

from app.search_engine import ExternalSearchEngine


def _page(slug):
    return f'''<div class="b6m-video"><a class="ui-card-link__hash"
        href="https://pimpbunny.com/videos/{slug}/"><img alt="{slug}"
        data-original="https://pimpbunny.com/{slug}.jpg"></a>
        <span class="ui-card-duration__hash">12:34</span></div>'''


def test_search_uses_current_cards_and_search_pagination():
    fetch = AsyncMock(side_effect=[(200, _page('first'), ''), (200, _page('second'), '')])
    engine = ExternalSearchEngine.__new__(ExternalSearchEngine)
    with patch('app.hubs.pimpbunny.PimpBunnyHub._get_html', fetch):
        results = asyncio.run(engine.search_pimpbunny_async('Test Query', 2))

    assert [item['title'] for item in results] == ['first', 'second']
    assert results[0]['thumbnail'] == 'https://pimpbunny.com/first.jpg'
    assert results[0]['duration'] == '12:34'
    assert fetch.await_args_list[0].args[0] == 'https://pimpbunny.com/search/test-query/'
    assert fetch.await_args_list[1].args[0].endswith('?from_videos=2')


def test_search_stops_when_page_repeats():
    fetch = AsyncMock(return_value=(200, _page('first'), ''))
    engine = ExternalSearchEngine.__new__(ExternalSearchEngine)
    with patch('app.hubs.pimpbunny.PimpBunnyHub._get_html', fetch):
        results = asyncio.run(engine.search_pimpbunny_async('test', 10))
    assert len(results) == 1
    assert fetch.await_count == 2
