import asyncio

from app import orientation as ori
from app.search_pipeline import quality_height, search_catalog


class Engine:
    def __init__(self, rows_by_query):
        self.rows_by_query = rows_by_query
        self.queries = []

    async def search_sources(self, query, sources, **kwargs):
        self.queries.append(query)
        rows = self.rows_by_query.get(query, [])
        return {'results': rows, 'diagnostics': [
            {'source_key': sources[0], 'status': 'ok', 'raw_count': len(rows)}]}

    def _sort_by_relevance(self, rows, query):
        return rows


def test_confirmed_vs_likely_are_separate():
    assert ori.classify({'width': 720, 'height': 1280})['orientation'] == 'portrait'
    assert ori.classify({'width': 720, 'height': 1280, 'rotation': 90})['orientation'] == 'landscape'
    assert ori.classify({'aspect_ratio': '9:16'})['evidence'] == 'aspect_ratio'
    hint = ori.classify({'title': 'Cute girl vertical video'})
    assert (hint['orientation'], hint['likely'], hint['evidence']) == ('unknown', 'portrait', 'text_hint')
    assert ori.classify({'title': 'Horizontal vertical mix 16:9'})['likely'] == ''
    assert ori.classify({'url': 'https://x.com/shorts/abc'})['evidence'] == 'url_hint'
    assert ori.classify({'title': 'plain'})['likely'] == ''


def test_page_and_hls_dimension_extraction():
    og = '<meta property="og:video:width" content="720"><meta property="og:video:height" content="1280">'
    assert ori.dimensions_from_html(og) == (720, 1280)
    ld = '<script type="application/ld+json">{"@type":"VideoObject","width":1080,"height":{"value":1920}}</script>'
    assert ori.dimensions_from_html(ld) == (1080, 1920)
    assert ori.dimensions_from_html('<meta property="og:video:width" content="16"><meta property="og:video:height" content="16">') is None
    hls = '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=360x640\na\n#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=720x1280\nb'
    assert ori.dimensions_from_hls(hls) == (720, 1280)
    assert ori.hls_urls_from_html('x "https:\\/\\/cdn.x\\/a\\/master.m3u8?t=1" y') == ['https://cdn.x/a/master.m3u8?t=1']


def test_quality_uses_short_side_for_portrait():
    assert quality_height({'width': 720, 'height': 1280}) == 720
    assert quality_height({'width': 1920, 'height': 1080}) == 1080
    assert quality_height({'height': 1080}) == 1080


def test_portrait_search_probes_unknown_and_filters(monkeypatch):
    async def fake_probe(urls, **kwargs):
        return {'https://e.com/probed-v': ori.patch_from_dimensions(720, 1280, 'page_dimensions'),
                'https://e.com/probed-h': ori.patch_from_dimensions(1920, 1080, 'page_dimensions')}
    monkeypatch.setattr('app.search_pipeline.probe_orientation', fake_probe)
    rows = [
        {'url': 'https://e.com/hint', 'title': 'blue vertical'},
        {'url': 'https://e.com/probed-v', 'title': 'blue a'},
        {'url': 'https://e.com/probed-h', 'title': 'blue b'},
        {'url': 'https://e.com/land', 'title': 'blue c', 'width': 1920, 'height': 1080},
        {'url': 'https://e.com/unknown', 'title': 'blue d'},
        {'url': 'https://e.com/dims', 'title': 'blue e', 'width': 608, 'height': 1080},
    ]
    engine = Engine({'blue': rows, 'blue vertical': rows[:1]})
    data = asyncio.run(search_catalog(engine, 'blue', ['erome'], orientation='portrait'))
    assert 'blue vertical' in engine.queries
    urls = [r['url'] for r in data['results']]
    assert len(urls) == 6  # nič sa nestráca, filtruje až UI
    assert set(urls[:2]) == {'https://e.com/probed-v', 'https://e.com/dims'}  # potvrdené prvé
    assert urls[2] == 'https://e.com/hint'  # potom pravdepodobné
    diag = data['diagnostics'][0]
    assert diag['orientation_filtered'] == 2 and diag['orientation_unknown'] == 1


def test_fast_probe_caches_and_respects_deadline(monkeypatch):
    import time
    calls = []

    async def fake_page(session, url):
        calls.append(url)
        if url.endswith('slow'):
            await asyncio.sleep(10)
        return ori.patch_from_dimensions(720, 1280, 'page_dimensions')

    monkeypatch.setattr(ori, '_fast_page', fake_page)
    ori._FAST_CACHE.clear()
    urls = ['https://a.com/1', 'https://a.com/slow']
    start = time.monotonic()
    first = asyncio.run(ori.probe_orientation(urls, timeout_s=0.5))
    assert time.monotonic() - start < 3
    assert list(first) == ['https://a.com/1']
    second = asyncio.run(ori.probe_orientation(['https://a.com/1'], timeout_s=0.5))
    assert second == first and calls.count('https://a.com/1') == 1
