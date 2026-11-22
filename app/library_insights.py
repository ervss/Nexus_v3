"""Read-only, content-neutral summaries for the statistics page."""
import math
from statistics import median


def _positive(value):
    try:
        value = float(value)
    except (TypeError, ValueError):
        return 0.0
    return value if math.isfinite(value) and value > 0 else 0.0


def summarize(rows):
    rows = list(rows)
    count = len(rows)
    sizes = [_positive(row.get("file_size_mb")) for row in rows]
    durations = [_positive(row.get("duration")) for row in rows]
    known_sizes = [value for value in sizes if value]
    known_durations = [value for value in durations if value]
    dimensions = sum(
        _positive(row.get("width")) > 0 and _positive(row.get("height")) > 0
        for row in rows
    )
    health = [row.get("link_status") for row in rows]
    working = health.count("working")
    broken = health.count("broken")
    coverage = [
        {"label": label, "known": known,
         "percent": round(100 * known / count, 1) if count else 0}
        for label, known in [
            ("Dĺžka", len(known_durations)),
            ("Veľkosť", len(known_sizes)),
            ("Oba rozmery", dimensions),
        ]
    ]
    duration = median(known_durations) if known_durations else None
    return {
        "count": count,
        "size_known": len(known_sizes),
        "duration_known": len(known_durations),
        "median_size": round(median(known_sizes), 1) if known_sizes else None,
        "median_duration": round(duration, 1) if duration is not None else None,
        "size_tib": round(sum(known_sizes) / 1024**2, 2),
        "short_count": sum(0 < duration < 60 for duration in durations),
        "portrait_count": sum(
            0 < _positive(row.get("width")) < _positive(row.get("height"))
            for row in rows
        ),
        "working": working, "broken": broken,
        "unknown": count - working - broken,
        "coverage": coverage,
    }


def build_insights(rows_newest_first):
    """Input must be ordered by created_at DESC, then id DESC.

    Recent means a window of library rows, never an inferred import job.
    Sizes use the application's existing MiB storage convention.
    """
    rows = list(rows_newest_first)
    return {"all": summarize(rows), "recent": summarize(rows[:100])}


def read_library_insights():
    from .database import SessionLocal, Video

    with SessionLocal() as db:
        rows = db.query(
            Video.duration, Video.file_size_mb, Video.width,
            Video.height, Video.link_status,
        ).order_by(Video.created_at.desc(), Video.id.desc()).all()
        return build_insights(row._asdict() for row in rows)
