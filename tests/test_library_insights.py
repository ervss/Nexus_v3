import importlib.util
from pathlib import Path
import unittest
import sys
import types
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "app.library_insights", Path(__file__).resolve().parents[1] / "app/library_insights.py"
)
insights = importlib.util.module_from_spec(spec)
spec.loader.exec_module(insights)


class LibraryInsightsTests(unittest.TestCase):
    def test_empty_library_has_no_fabricated_medians(self):
        result = insights.summarize([])
        self.assertEqual(result["count"], 0)
        self.assertIsNone(result["median_size"])
        self.assertIsNone(result["median_duration"])
        self.assertTrue(all(item["percent"] == 0 for item in result["coverage"]))

    def test_missing_invalid_and_remote_metadata(self):
        result = insights.summarize([
            dict(duration=20, file_size_mb=1024**2, width=1080, height=1920,
                 storage_type="remote", link_status="working"),
            dict(duration=60, file_size_mb=0, width=1920, height=0,
                 link_status="broken"),
            dict(duration=float("nan"), file_size_mb=-1, link_status="unknown"),
            dict(duration=None, file_size_mb=float("inf"), link_status=None),
        ])
        self.assertEqual(result["median_duration"], 40)
        self.assertEqual(result["size_tib"], 1)
        self.assertEqual(result["size_known"], 1)
        self.assertEqual(result["short_count"], 1)
        self.assertEqual(result["portrait_count"], 1)
        self.assertEqual(result["unknown"], 2)
        self.assertEqual(result["coverage"][2]["known"], 1)

    def test_recent_window_is_not_the_full_library(self):
        rows = [dict(duration=10)] * 100 + [dict(duration=1000)] * 101
        result = insights.build_insights(iter(rows))
        self.assertEqual(result["recent"]["count"], 100)
        self.assertEqual(result["recent"]["median_duration"], 10)
        self.assertEqual(result["all"]["median_duration"], 1000)

    def test_database_ordering_uses_date_then_id_without_production_database(self):
        from sqlalchemy import create_engine, Column, Integer, Float, String
        from sqlalchemy.orm import declarative_base, sessionmaker

        base = declarative_base()

        class Video(base):
            __tablename__ = "videos"
            id = Column(Integer, primary_key=True)
            created_at = Column(String)
            duration = Column(Float)
            file_size_mb = Column(Float)
            width = Column(Integer)
            height = Column(Integer)
            link_status = Column(String)

        engine = create_engine("sqlite:///:memory:")
        base.metadata.create_all(engine)
        sessions = sessionmaker(bind=engine)
        with sessions() as db:
            db.add(Video(id=1, created_at="2026-09-04", duration=10))
            db.add_all(Video(id=i, created_at="2026-09-03", duration=i) for i in range(2, 103))
            db.commit()
        fake_database = types.ModuleType("app.database")
        fake_database.SessionLocal = sessions
        fake_database.Video = Video
        with patch.dict(sys.modules, {"app.database": fake_database}):
            result = insights.read_library_insights()
        engine.dispose()
        self.assertEqual(result["all"]["count"], 102)
        # The newest row plus IDs 102..4; IDs 2 and 3 are outside the window.
        self.assertEqual(result["recent"]["median_duration"], 52.5)


if __name__ == "__main__":
    unittest.main()
