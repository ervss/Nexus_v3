import unittest
from unittest.mock import AsyncMock, patch
from app.media_dates import extract_upload_date, normalize_upload_date
from app.routers.quality_hunt import quality_hunt_meta, QualityMetaRequest

class UploadDateTests(unittest.IsolatedAsyncioTestCase):
    def test_exact_calendar_day_and_compact_date(self):
        self.assertEqual(normalize_upload_date('Sep 30, 2026'), '2026-09-30')
        self.assertEqual(normalize_upload_date('20260930'), '2026-09-30')
        self.assertEqual(normalize_upload_date('2026-02-31'), '')

    def test_video_metadata_and_fpo_info_exclude_related_dates(self):
        self.assertEqual(extract_upload_date('<script type="application/ld+json">{"@type":"VideoObject","uploadDate":"2026-09-30T12:00:00Z"}</script>'), '2026-09-30')
        self.assertEqual(extract_upload_date('<div id="tab_video_info">Published on Sep 19, 2026</div>'), '2026-09-19')
        self.assertEqual(extract_upload_date('<div>Related clip Sep 19, 2026</div>'), '')

    async def test_fast_fetch_returns_missing_date_from_page(self):
        with patch('app.routers.quality_hunt.ensure_bridge_token'), patch('app.nexus_intel.resolve_cached', AsyncMock(return_value={'stream_url':'https://cdn.example/a.mp4', 'size_bytes':100, 'height':720})), patch('app.media_dates.fetch_upload_date', AsyncMock(return_value='2026-09-19')):
            data = await quality_hunt_meta(QualityMetaRequest(urls=['https://www.fpo.xxx/video/123/'], fast=True))
        self.assertEqual(data['items'][0]['upload_date'], '2026-09-19')

if __name__ == '__main__':
    unittest.main()
