from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app import database
from app.telegram_index import upsert_telegram_media_batch, search_telegram_fts


def test_catalog_pagination_is_disjoint_for_equal_dates_and_ranks(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'pagination_test.db'}", connect_args={"check_same_thread": False})
    monkeypatch.setattr(database, "engine", engine)
    factory = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    monkeypatch.setattr(database, "SessionLocal", factory)
    database.init_db()
    with engine.begin() as conn:
        if not conn.execute(text("SELECT 1 FROM sqlite_master WHERE name='telegram_media_fts'")).scalar():
            conn.execute(text("CREATE VIRTUAL TABLE telegram_media_fts USING fts5(title, caption, file_name, channel, author)"))
            conn.execute(text("""
                CREATE TRIGGER IF NOT EXISTS telegram_media_ai AFTER INSERT ON telegram_media_index BEGIN
                  INSERT INTO telegram_media_fts(rowid, title, caption, file_name, channel, author)
                  VALUES (new.id, coalesce(new.title, ''), coalesce(new.caption, ''), coalesce(new.file_name, ''), coalesce(new.channel, ''), coalesce(new.author, ''));
                END;
            """))
    try:
        with factory() as db:
            upsert_telegram_media_batch(db, [
                {"chat_id": 123, "message_id": i, "title": "UniquePageTest", "date": "2026-01-01"}
                for i in range(1, 6)
            ])
            first = search_telegram_fts(db, "UniquePageTest", limit=2, offset=0)
            second = search_telegram_fts(db, "UniquePageTest", limit=2, offset=2)
            last = search_telegram_fts(db, "UniquePageTest", limit=2, offset=4)
            assert len(first) == len(second) == 2
            assert len(last) == 1
            assert len({row["message_id"] for row in first + second + last}) == 5
            assert len(search_telegram_fts(db, "*", limit=2, offset=4, chat_ids=[123])) == 1
    finally:
        engine.dispose()
