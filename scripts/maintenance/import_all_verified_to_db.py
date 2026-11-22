"""
Import all verified playable videos directly into nexus_test.db
===============================================================
Zapíše všetkých 18 overených videí z testu do databázy Nexus,
aby sa okamžite zobrazili v dashboarde a galérii používateľa.
"""

import datetime
import json
import logging
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

from app.database import SessionLocal, Video, VideoSource

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("nexus.db_import")

def import_verified_videos():
    results_path = BASE_DIR / "scripts" / "prod_grade_results.json"
    if not results_path.exists():
        logger.error("Súbor prod_grade_results.json neexistuje!")
        return

    with open(results_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    playable = [r for r in data["results"] if r.get("status") == "SUCCESS_PLAYABLE"]
    logger.info("Nájdených %d funkčných videí na import do DB.", len(playable))

    db = SessionLocal()
    imported_count = 0
    now = datetime.datetime.utcnow()

    try:
        for p in playable:
            title = p.get("title") or f"{p['name']} Video"
            source_url = p.get("url")
            stream_url = p.get("stream_url") or source_url

            if not source_url:
                continue

            # Kontrola duplicity
            existing = db.query(Video).filter(
                (Video.source_url == source_url) | (Video.url == source_url) | (Video.url == stream_url)
            ).first()

            if existing:
                logger.info("Video %s (%s) už existuje v DB (ID: %d), aktualizujem status...", p["name"], title[:30], existing.id)
                existing.status = "ready_to_stream"
                existing.title = title
                if stream_url:
                    existing.url = stream_url
                db.commit()
                continue

            # Vytvorenie nového záznamu v tabuľke Video
            new_video = Video(
                title=title,
                url=stream_url or source_url,
                source_url=source_url,
                status="ready_to_stream",
                batch_name="Overený import z auditu",
                created_at=now,
                is_watched=False,
                is_favorite=False,
                duration=float(p.get("duration") or 0.0),
            )
            db.add(new_video)
            db.flush()  # Priradí ID

            # Vytvorenie video source
            new_source = VideoSource(
                video_id=new_video.id,
                url=stream_url or source_url,
                source_url=source_url,
                label=p["name"],
                quality="HD",
                is_primary=True,
                link_status="active",
                added_at=now
            )
            db.add(new_source)
            db.commit()

            imported_count += 1
            logger.info("Úspešne pridané video ID %d: %s (%s)", new_video.id, p["name"], title[:40])

        db.commit()
        logger.info("Import dokončený. Novo pridaných videí: %d", imported_count)

    except Exception as e:
        db.rollback()
        logger.error("Chyba pri importe do DB: %s", e)
    finally:
        db.close()

if __name__ == "__main__":
    import_verified_videos()
