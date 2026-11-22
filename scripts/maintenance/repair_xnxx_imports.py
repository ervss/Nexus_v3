import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import or_

from app.database import SessionLocal, Video
from app.extractors.xnxx import XnxxExtractor


def _quality_from_height(height: int) -> str:
    if height >= 2160:
        return "4K"
    if height >= 1440:
        return "2K"
    if height >= 1080:
        return "FHD"
    if height >= 720:
        return "HD"
    return "SD"


async def main() -> None:
    db = SessionLocal()
    extractor = XnxxExtractor()
    fixed = []
    failed = []

    try:
        rows = (
            db.query(Video)
            .filter(
                or_(
                    Video.url.ilike("%xnxx%"),
                    Video.source_url.ilike("%xnxx%"),
                    Video.tags.ilike("%xnxx%"),
                    Video.batch_name.ilike("%xnxx%"),
                )
            )
            .order_by(Video.id.desc())
            .all()
        )

        for video in rows:
            lookup_url = (video.source_url or video.url or "").strip()
            if not lookup_url:
                failed.append((video.id, "missing_source_url"))
                continue

            meta = await extractor.extract(lookup_url)
            stream_url = (meta or {}).get("stream_url") or ""
            if not stream_url:
                failed.append((video.id, "extract_failed"))
                continue

            video.url = stream_url
            video.status = "ready_to_stream"
            height = int((meta or {}).get("height") or 0)
            if height:
                video.height = height
                video.quality = _quality_from_height(height)
            if (meta or {}).get("duration") and not video.duration:
                video.duration = float(meta["duration"])
            if (meta or {}).get("thumbnail") and not video.thumbnail_path:
                video.thumbnail_path = meta["thumbnail"]
            fixed.append(video.id)

        db.commit()
    finally:
        db.close()

    print({"fixed": fixed, "failed": failed})


if __name__ == "__main__":
    asyncio.run(main())
