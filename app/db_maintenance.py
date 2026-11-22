"""
Database maintenance utilities for WAL checkpointing and optimization.
"""
import logging
from pathlib import Path
from sqlalchemy import text
from app.config import config
from app.database import engine, SessionLocal

logger = logging.getLogger(__name__)


async def checkpoint_wal():
    """
    Checkpoint the WAL file to prevent unlimited growth.
    This should be called periodically (e.g., every hour) as a background task.
    """
    try:
        with engine.connect() as connection:
            # TRUNCATE mode: checkpoint and truncate WAL file
            connection.execute(text("PRAGMA wal_checkpoint(TRUNCATE)"))
            connection.commit()
            logger.info("WAL checkpoint completed successfully")
            return True
    except Exception as e:
        logger.error(f"WAL checkpoint failed: {e}")
        return False


async def vacuum_database():
    """
    Vacuum the database to reclaim space and optimize performance.
    Should be run during maintenance windows.
    """
    try:
        with engine.connect() as connection:
            connection.execute(text("VACUUM"))
            connection.commit()
            logger.info("Database VACUUM completed successfully")
            return True
    except Exception as e:
        logger.error(f"Database VACUUM failed: {e}")
        return False


async def analyze_database():
    """
    Update database statistics for query optimization.
    Should be run after bulk imports or periodically.
    """
    try:
        with engine.connect() as connection:
            connection.execute(text("ANALYZE"))
            connection.commit()
            logger.info("Database ANALYZE completed successfully")
            return True
    except Exception as e:
        logger.error(f"Database ANALYZE failed: {e}")
        return False


def get_database_stats():
    """
    Get database size and WAL file size for monitoring.
    """
    try:
        database_url = (config.DATABASE_URL or "").strip()
        if database_url.lower().startswith("sqlite:///"):
            db_path = Path(database_url.replace("sqlite:///", "", 1))
            if not db_path.is_absolute():
                db_path = Path.cwd() / db_path
            wal_path = db_path.with_name(f"{db_path.name}-wal")
            return {
                'db_size_mb': round(db_path.stat().st_size / 1024.0 / 1024.0, 2) if db_path.exists() else 0,
                'wal_size_mb': round(wal_path.stat().st_size / 1024.0 / 1024.0, 2) if wal_path.exists() else 0,
            }

        db = SessionLocal()
        result = db.execute(text("""
            SELECT 
                page_count * page_size / 1024.0 / 1024.0 as db_size_mb,
                (SELECT page_count * page_size / 1024.0 / 1024.0 FROM pragma_page_count('wal')) as wal_size_mb
            FROM pragma_page_count('main'), pragma_page_size
        """)).fetchone()
        
        db.close()
        
        return {
            'db_size_mb': round(result[0], 2) if result else 0,
            'wal_size_mb': round(result[1], 2) if result and result[1] else 0
        }
    except Exception as e:
        logger.error(f"Failed to get database stats: {e}")
        return {'db_size_mb': 0, 'wal_size_mb': 0}
