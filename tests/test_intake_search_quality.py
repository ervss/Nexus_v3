import asyncio
from app import intake


def test_listing_quality_is_preserved_without_inventing_dimensions():
    candidate = intake._candidate_from_raw({'url': 'https://example.com/watch/1', 'quality': '4K (2160p)'})
    assert candidate['quality'] == '4K'
    assert candidate['quality_height'] == 2160
    assert candidate['height'] == 0
    assert candidate['quality_evidence'] == 'source_badge'


def test_dimensions_override_source_badge():
    candidate = intake._candidate_from_raw({'url': 'https://example.com/watch/1', 'height': 720, 'quality': '4K'})
    assert candidate['quality_height'] == 720
    assert candidate['quality'] == '720p'


def test_4k_search_excludes_unknown_and_lower_quality(monkeypatch):
    class Engine:
        async def search_sources(self, query, sources, **kwargs):
            return {'results': [
                {'url': 'https://example.com/unknown', 'title': 'sample', 'quality': 'HD'},
                {'url': 'https://example.com/low', 'title': 'sample', 'height': 1080},
                {'url': 'https://example.com/badge', 'title': 'sample', 'quality': '4K'},
                {'url': 'https://example.com/dimensions', 'title': 'sample', 'height': 2160},
            ], 'diagnostics': [{'source_key': sources[0], 'status': 'ok', 'raw_count': 4}]}

        def _sort_by_relevance(self, rows, query):
            return rows
    monkeypatch.setattr(intake, 'ExternalSearchEngine', Engine)
    monkeypatch.setattr(intake, '_existing_normalized_urls', lambda db: set())
    result = asyncio.run(intake.search_intake_candidates(
        intake.IntakeSearchRequest(query='sample', sources=['erome'], min_quality=2160,
                                   enrich_unknown=False, playwright_fallback=False), None))
    assert [c['url'] for c in result['candidates']] == ['https://example.com/badge', 'https://example.com/dimensions']
    assert result['min_quality'] == 2160


def test_search_import_rechecks_quality(monkeypatch):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.database import Base, ImportJobItem
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    monkeypatch.setattr(intake, '_existing_normalized_urls', lambda db: set())
    try:
        job = intake.create_import_job(intake.IntakeImportRequest(
            source_mode='search', min_quality=2160,
            candidates=[intake.IntakeCandidate(url='https://example.com/low', height=1080),
                        intake.IntakeCandidate(url='https://example.com/unknown'),
                        intake.IntakeCandidate(url='https://example.com/4k', quality='4K')]), db)
        items = db.query(ImportJobItem).filter(ImportJobItem.job_id == job.id).all()
        assert [item.url for item in items] == ['https://example.com/4k']
        assert items[0].quality == '4K'
    finally:
        db.close()
