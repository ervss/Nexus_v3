import asyncio

from app.search_pipeline import classify_orientation, query_contract, search_catalog
from app.source_catalog import DISCOVERY_SOURCE_OPTIONS


class FakeEngine:
    def __init__(self, rows=None):
        self.calls = []
        self.rows = rows or {}

    async def search_sources(self, query, sources, **kwargs):
        key = sources[0]
        self.calls.append((key, query, kwargs))
        rows = self.rows.get(key, [
            {'url': f'https://example.com/{key}', 'title': 'blue sky', 'height': 2160, 'source': key}
        ])
        return {'results': rows, 'diagnostics': [
            {'source_key': key, 'status': 'ok' if rows else 'empty', 'raw_count': len(rows)}
        ]}

    def _sort_by_relevance(self, rows, query):
        return rows


def test_query_quality_contract():
    assert query_contract('blue sky 4K') == ('blue sky', 2160)
    assert query_contract('blue sky 1080p', 2160) == ('blue sky', 2160)


def test_orientation_uses_video_dimensions_and_preserves_unknowns():
    assert classify_orientation({'width': 720, 'height': 1280}) == ('portrait', 'video_dimensions')
    assert classify_orientation({'width': 1920, 'height': 1080}) == ('landscape', 'video_dimensions')
    assert classify_orientation({'width': 100, 'height': 105}) == ('landscape', 'video_dimensions')
    assert classify_orientation({'height': 1080}) == ('unknown', 'unknown')
    assert classify_orientation({'orientation': 'vertical'}) == ('portrait', 'source_metadata')


def test_search_catalog_normalizes_orientation_for_every_source():
    engine = FakeEngine({'erome': [
        {'url': 'https://example.com/portrait', 'title': 'blue sky', 'width': 720, 'height': 1280},
        {'url': 'https://example.com/landscape', 'title': 'blue sky', 'width': 1920, 'height': 1080},
        {'url': 'https://example.com/unknown', 'title': 'blue sky', 'height': 1080},
    ]})
    data = asyncio.run(search_catalog(engine, 'blue sky', ['erome'], enrich_unknown=False))
    orientations = {row['url']: (row['orientation'], row['orientation_evidence']) for row in data['results']}
    assert orientations == {
        'https://example.com/portrait': ('portrait', 'video_dimensions'),
        'https://example.com/landscape': ('landscape', 'video_dimensions'),
        'https://example.com/unknown': ('unknown', 'unknown'),
    }


def test_every_selected_source_runs_before_total_cap():
    sources = [item['id'] for item in DISCOVERY_SOURCE_OPTIONS if item['has_search']][:23]
    engine = FakeEngine()
    data = asyncio.run(search_catalog(engine, 'blue sky 4K', sources, per_source_limit=5,
                                      total_limit=10, enrich_unknown=False))
    assert {key for key, _, _ in engine.calls} == set(sources)
    assert len(data['results']) == 10
    assert len(data['diagnostics']) == 23
    assert all(kwargs['strict_query'] and kwargs['min_quality'] == 2160
               for _, _, kwargs in engine.calls)
    assert sum(item['total_limited'] for item in data['diagnostics']) == 13


def test_query_and_quality_filter_explain_removed_results():
    engine = FakeEngine({'erome': [
        {'url': 'https://example.com/low', 'title': 'blue sky', 'height': 1080},
        {'url': 'https://example.com/unknown', 'title': 'blue sky'},
        {'url': 'https://example.com/high', 'title': 'blue sky', 'height': 2160},
        {'url': 'https://example.com/irrelevant', 'title': 'other topic', 'height': 2160},
    ]})
    data = asyncio.run(search_catalog(engine, 'blue sky', ['erome'], min_quality=2160,
                                      enrich_unknown=False))
    assert [item['url'] for item in data['results']] == ['https://example.com/high']
    assert data['diagnostics'][0]['quality_low'] == 1
    assert data['diagnostics'][0]['quality_unknown'] == 1
    assert data['diagnostics'][0]['query_filtered'] == 1


def test_unknown_source_never_expands_into_all_sources():
    engine = FakeEngine()
    data = asyncio.run(search_catalog(engine, 'blue sky', ['not-in-catalog']))
    assert engine.calls == []
    assert data['results'] == []
    assert data['diagnostics'][0]['status'] == 'unsupported'


def test_simultaneous_searches_share_source_capacity():
    class CountingEngine(FakeEngine):
        active = 0
        peak = 0

        async def search_sources(self, query, sources, **kwargs):
            self.active += 1
            self.peak = max(self.peak, self.active)
            try:
                await asyncio.sleep(0.01)
                return await super().search_sources(query, sources, **kwargs)
            finally:
                self.active -= 1

    engine = CountingEngine()
    sources = [item['id'] for item in DISCOVERY_SOURCE_OPTIONS if item['has_search']][:12]

    async def run():
        await asyncio.gather(
            search_catalog(engine, 'blue sky', sources, enrich_unknown=False),
            search_catalog(engine, 'blue sky', sources, enrich_unknown=False),
        )

    asyncio.run(run())
    assert len(engine.calls) == 24
    assert engine.peak <= 6
