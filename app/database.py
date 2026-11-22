from sqlalchemy import create_engine, Column, Integer, BigInteger, String, Boolean, Float, DateTime, Text, JSON, Index, LargeBinary, UniqueConstraint, text
from sqlalchemy.orm import declarative_base, sessionmaker
from datetime import datetime, timezone
import re
from sqlalchemy import event

from .config import config


def utcnow() -> datetime:
    """Return naive UTC for compatibility with existing SQLite timestamps."""
    return datetime.now(timezone.utc).replace(tzinfo=None)

SQLALCHEMY_DATABASE_URL = config.DATABASE_URL

_is_sqlite = (SQLALCHEMY_DATABASE_URL or "").strip().lower().startswith("sqlite")
_connect_args = {"check_same_thread": False, "timeout": 30} if _is_sqlite else {}

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args=_connect_args,
    pool_size=config.DB_POOL_SIZE,
    max_overflow=config.DB_MAX_OVERFLOW,
    pool_timeout=config.DB_POOL_TIMEOUT,
    # Recycle stale checkouts so a dropped/idle sqlite handle doesn't surface
    # as a mid-request failure under load.
    pool_pre_ping=True,
)

if _is_sqlite:
    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        # WAL lets readers run concurrently with a single writer.
        cursor.execute("PRAGMA journal_mode=WAL")
        # Wait (don't instantly raise) when another connection holds the lock.
        cursor.execute("PRAGMA busy_timeout=30000")
        # synchronous=NORMAL is durable under WAL and commits far faster, so the
        # write lock is held for less time — the main lever against "database
        # locked" contention with many pooled connections.
        cursor.execute("PRAGMA synchronous=NORMAL")
        # Keep temp b-trees / sort scratch in RAM instead of touching disk.
        cursor.execute("PRAGMA temp_store=MEMORY")
        # ~64MB page cache (negative = KiB) to cut disk reads on hot queries.
        cursor.execute("PRAGMA cache_size=-64000")
        # Checkpoint the WAL a bit more eagerly so it can't grow unbounded while
        # the server holds it open (the -wal file was observed staying live).
        cursor.execute("PRAGMA wal_autocheckpoint=1000")
        # 256 MB memory-mapped reads significantly cut syscalls on large SQLite files.
        cursor.execute("PRAGMA mmap_size=268435456")
        cursor.close()

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class MegaHubEntry(Base):
    __tablename__ = "mega_hub_entries"

    id = Column(Integer, primary_key=True)
    url = Column(String, unique=True, nullable=False)
    title = Column(String, nullable=False)
    kind = Column(String, nullable=False)
    snapshot = Column(JSON, nullable=False)
    added_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, nullable=False)


class Video(Base):
    __tablename__ = "videos"
    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, index=True)
    url = Column(String, index=True)
    source_url = Column(String, index=True) # For JIT link refreshing
    thumbnail_path = Column(String)
    # Original provider/CDN thumbnail.  Keep this even after thumbnail_path is
    # localized, so reverse-image services can access a public image URL.
    original_thumbnail_url = Column(String)
    thumbnail_referer = Column(String)
    gif_preview_path = Column(String)
    preview_path = Column(String)
    duration = Column(Float, default=0)
    width = Column(Integer, default=0)
    height = Column(Integer, default=0)
    aspect_ratio = Column(String, nullable=True)  # "16:9", "9:16", "4:3", "1:1", etc.
    batch_name = Column(String, index=True)
    tags = Column(String, default="") 
    ai_tags = Column(String, default="")
    subtitle = Column(Text, default="")
    sprite_path = Column(String, nullable=True)
    storage_type = Column(String, default="remote") # "remote" or "local"
    is_favorite = Column(Boolean, default=False)
    is_watched = Column(Boolean, default=False)
    resume_time = Column(Float, default=0)
    status = Column(String, default="pending")
    error_msg = Column(String, nullable=True)
    preview_retry_needed = Column(Boolean, default=False)
    preview_retry_count = Column(Integer, default=0)
    preview_last_error = Column(String, nullable=True)
    created_at = Column(DateTime, default=utcnow)
    
    views = Column(Integer, default=0)
    upload_date = Column(String, nullable=True) # "May 2, 2025" or ISO format
    quality = Column(String, default="SD")
    file_size_mb = Column(Float, default=0)
    
    # Duplicate Detection
    phash = Column(String, index=True, nullable=True)  # Perceptual hash of thumbnail
    duplicate_of = Column(Integer, nullable=True)  # ID of original if this is a duplicate
    
    # Health Monitoring
    last_checked = Column(DateTime, nullable=True)  # Last time link was validated
    link_status = Column(String, default="unknown")  # "working", "broken", "unknown"
    check_count = Column(Integer, default=0)  # Number of times checked
    
    # Statistics
    download_stats = Column(JSON, nullable=True) # {"avg_speed_mb": 12.5, "time_sec": 45, "size_mb": 200, "max_speed_mb": 15.0}
    categories = Column(String, default="")
    models = Column(String, default="")
    preview_mp4_url = Column(String, default="")

    # Smart Rethumb tracking — when the last successful smart rethumb ran and,
    # if the last attempt failed, a human-readable reason for the maintenance panel.
    smart_rethumb_at = Column(DateTime, nullable=True)
    smart_rethumb_error = Column(String, nullable=True)

    # Telegram library playback. The stream route is /telegram/stream/{chat_id}/{message_id}.
    telegram_chat_id = Column(String, nullable=True, index=True)
    telegram_message_id = Column(Integer, nullable=True)


class VideoSource(Base):
    """An alternate host for a Video already in the library — same upload,
    different site (bunkr/pixeldrain/filester/...), found either by explicit
    "add a mirror" or by import-time matching (see media_match.find_existing_match).

    Deliberately a separate table rather than a JSON column or reusing
    Video.duplicate_of: duplicate_of means "hide me, I'm a copy"; this means
    the opposite — "keep me, I'm a fallback for that card". Each source can be
    health-checked independently of the parent Video's own link_status, and a
    card can gain/lose mirrors over time without touching its primary row.
    """
    __tablename__ = "video_sources"
    id = Column(Integer, primary_key=True, index=True)
    video_id = Column(Integer, index=True, nullable=False)  # FK to videos.id (no ORM relationship: Video is legacy/unmanaged here)
    url = Column(String, nullable=False)
    source_url = Column(String, nullable=True)  # watch/page URL, for JIT stream refresh — same role as Video.source_url
    label = Column(String, default="")  # short host name for the icon: "Pixeldrain", "FileDitch", "Bunkr"
    quality = Column(String, nullable=True)
    height = Column(Integer, default=0)
    size_mb = Column(Float, default=0)
    is_primary = Column(Boolean, default=False)  # the one tried first; exactly one per video_id in normal operation
    link_status = Column(String, default="unknown")  # "working" / "broken" / "unknown" — mirrors Video.link_status's contract
    last_checked = Column(DateTime, nullable=True)
    added_at = Column(DateTime, default=utcnow)


class Moment(Base):
    """A saved slice of one video — the Studio's unit of taste.

    The library stores whole videos; a Moment stores the 20 seconds that were
    actually worth keeping. It is deliberately *not* a Video row: it has no
    file of its own until you export one, it can outlive a dead source link
    (the frame is already on disk), and dozens of them can point at the same
    parent without polluting the library grid.

    `clip_path` stays empty for the common case — a Moment is just an in/out
    pair the player seeks to, which costs nothing. Only an explicit export
    renders real bytes, and only then do clip_status/clip_error mean anything.
    """
    __tablename__ = "moments"
    id = Column(Integer, primary_key=True, index=True)
    video_id = Column(Integer, index=True, nullable=True)   # FK to videos.id (unmanaged, like VideoSource)
    # A moment can also hang off a hub source with no library row at all: you
    # were watching an eporner stream, you liked 20 seconds, and importing the
    # whole file was never the point. `source` empty = library moment.
    source = Column(String, default="", index=True)         # hub adapter id, e.g. "eporner"
    #: How it got here: "manual" (you cut it) or "auto" (the nightly scan proposed it).
    origin = Column(String, default="manual")
    #: "kept" — a real moment. "proposed" — waiting for your yes/no, hidden from
    #: the wall and the reel. "rejected" — you said no; the row survives only so
    #: the scanner does not propose the same span again next night.
    status = Column(String, default="kept", index=True)
    #: Remote poster for hub moments whose stream ffmpeg could not grab a frame from.
    thumb_url = Column(String, default="")
    title = Column(String, default="", index=True)
    start_sec = Column(Float, default=0)
    end_sec = Column(Float, default=0)
    tags = Column(String, default="")
    collection = Column(String, default="", index=True)
    is_favorite = Column(Boolean, default=False, index=True)
    heat = Column(Integer, default=0)          # 0..3 — how hard it hits, user-set
    thumb_path = Column(String, nullable=True)  # /static/moments/m{id}.jpg
    clip_path = Column(String, nullable=True)   # /static/clips/moment_{id}.mp4 once exported
    clip_status = Column(String, default="")    # "" | "rendering" | "ready" | "error"
    clip_error = Column(String, nullable=True)
    clip_size_mb = Column(Float, default=0)
    play_count = Column(Integer, default=0)
    last_played_at = Column(DateTime, nullable=True)
    # Denormalised so the wall renders without joining videos — and so a Moment
    # still says where it came from after its parent card is deleted.
    parent_title = Column(String, default="")
    parent_source = Column(String, default="")
    created_at = Column(DateTime, default=utcnow, index=True)


class StudioScan(Base):
    """One video's auto-highlight bookkeeping.

    Without it the nightly scan has no memory: every run would re-detect the
    same cuts on the same files and either duplicate proposals or waste the
    whole window re-scanning what it already did. A row exists as soon as a
    video has been looked at — `found = 0` is a real answer, not a retry signal.
    """
    __tablename__ = "studio_scans"
    id = Column(Integer, primary_key=True, index=True)
    video_id = Column(Integer, index=True, unique=True, nullable=False)
    scanned_at = Column(DateTime, default=utcnow, index=True)
    found = Column(Integer, default=0)          # proposals created
    error = Column(String, nullable=True)       # why nothing came back, if anything


class SmartPlaylist(Base):
    __tablename__ = "smart_playlists"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, index=True, unique=True)
    rules = Column(JSON)
    created_at = Column(DateTime, default=utcnow)

class SourceBoard(Base):
    __tablename__ = "source_boards"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, index=True, unique=True)
    slug = Column(String, index=True, unique=True)
    source_url = Column(String, index=True)
    source_type = Column(String, default="filester")
    batch_name = Column(String, index=True)
    description = Column(Text, default="")
    icon = Column(String, default="video_library")
    color = Column(String, default="#a855f7")
    pinned = Column(Boolean, default=True)
    sort_order = Column(Integer, default=0)
    item_count = Column(Integer, default=0)
    total_size_mb = Column(Float, default=0)
    last_sync_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)

class SearchHistory(Base):
    __tablename__ = "search_history"
    id = Column(Integer, primary_key=True, index=True)
    query = Column(String, index=True)
    source = Column(String, nullable=True) # e.g. "Quantum" or "Subtitles"
    results_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=utcnow)


class CBIRSearchCache(Base):
    """Persistent cache for Related Search / reverse-image responses.

    The cache key includes the reference frame hash and every search option that
    can change the result.  Keeping this in the main database makes repeated
    modal opens cheap and avoids spending SerpApi credits on identical searches.
    """
    __tablename__ = "cbir_search_cache"

    cache_key = Column(String(64), primary_key=True)
    video_id = Column(Integer, index=True, nullable=False)
    image_hash = Column(String(64), index=True, nullable=False)
    request_json = Column(JSON, nullable=False)
    response_json = Column(JSON, nullable=False)
    created_at = Column(DateTime, default=utcnow, index=True)
    expires_at = Column(DateTime, nullable=False, index=True)


class VideoEmbedding(Base):
    """Uložené multimodálne vektory (SigLIP2 / OpenCLIP) pre lokálnu knižnicu."""
    __tablename__ = "video_embeddings"

    video_id = Column(Integer, primary_key=True)
    model_name = Column(String(96), nullable=False, default="")
    dim = Column(Integer, nullable=False, default=0)
    thumb_sig = Column(String(64), nullable=False, default="")
    text_sig = Column(String(64), nullable=False, default="")
    image_vec = Column(LargeBinary, nullable=True)
    text_vec = Column(LargeBinary, nullable=True)
    updated_at = Column(DateTime, default=utcnow, index=True)

class DiscoveryProfile(Base):
    __tablename__ = "discovery_profiles"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, index=True, unique=True)
    enabled = Column(Boolean, default=True)

    # Schedule settings (cron format)
    schedule_type = Column(String, default="interval")  # "interval", "cron", "manual"
    schedule_value = Column(String, default="3600")  # For interval: seconds; For cron: cron expression

    # Search settings
    keywords = Column(String, default="")  # Comma-separated keywords
    exclude_keywords = Column(String, default="")  # Comma-separated exclude keywords
    sources = Column(JSON, default=list)  # List of source names to search

    # Quality filters
    min_height = Column(Integer, nullable=True)  # e.g., 720, 1080, 2160
    max_height = Column(Integer, nullable=True)
    aspect_ratio = Column(String, nullable=True)  # "16:9", "9:16", "4:3", "any"

    # Duration filters (in seconds)
    min_duration = Column(Integer, nullable=True)
    max_duration = Column(Integer, nullable=True)

    # Import settings
    max_results = Column(Integer, default=20)  # Max videos to import per run
    auto_import = Column(Boolean, default=False)  # Auto-import or notify only

    # Batch settings
    batch_prefix = Column(String, default="Auto")  # Batch name prefix for imported videos

    # Statistics
    last_run = Column(DateTime, nullable=True)
    total_runs = Column(Integer, default=0)
    total_found = Column(Integer, default=0)
    total_imported = Column(Integer, default=0)

    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)

class DiscoveryNotification(Base):
    __tablename__ = "discovery_notifications"
    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, index=True)
    profile_name = Column(String)

    # Notification details
    notification_type = Column(String)  # "new_matches", "import_complete", "error"
    message = Column(Text)
    video_count = Column(Integer, default=0)

    # Status
    read = Column(Boolean, default=False)

    created_at = Column(DateTime, default=utcnow)

class DiscoveredVideo(Base):
    __tablename__ = "discovered_videos"
    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, index=True)
    profile_name = Column(String)

    # Video details from search results
    title = Column(String)
    url = Column(String, index=True)
    source_url = Column(String)
    thumbnail = Column(String)
    duration = Column(Float, default=0)
    width = Column(Integer, default=0)
    height = Column(Integer, default=0)
    file_size_mb = Column(Float, default=0)
    source = Column(String)  # Which site it's from

    # Status
    imported = Column(Boolean, default=False)  # Has it been imported to main videos table
    video_id = Column(Integer, nullable=True)  # Reference to imported video if imported

    discovered_at = Column(DateTime, default=utcnow)
    imported_at = Column(DateTime, nullable=True)
    categories = Column(String, default="")
    models = Column(String, default="")
    related_src = Column(String, default="")
    preview_mp4_url = Column(String, default="")
    phash = Column(String, index=True, nullable=True)  # Perceptual hash of thumbnail
    duplicate_of = Column(Integer, nullable=True)  # Reference to visual duplicate video id

class DiscoveryDismissedVideo(Base):
    __tablename__ = "discovery_dismissed_videos"
    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, index=True)
    source_url = Column(String, index=True)
    url = Column(String, index=True)
    title = Column(String, nullable=True)
    dismissed_at = Column(DateTime, default=utcnow)


class PornhubQueueItem(Base):
    """A persistent, review-first candidate from the PornHub discovery hub.

    These are deliberately separate from ``DiscoveredVideo``.  A queue card is
    created from a manual browsing session, not an automated discovery profile,
    and it must survive closing the hub without becoming a library video.
    """
    __tablename__ = "pornhub_queue_items"
    id = Column(Integer, primary_key=True, index=True)
    url = Column(String, index=True, unique=True, nullable=False)
    source_url = Column(String, index=True)
    title = Column(String, default="")
    thumbnail = Column(String, default="")
    duration = Column(Float, default=0)
    width = Column(Integer, default=0)
    height = Column(Integer, default=0)
    file_size_mb = Column(Float, default=0)
    upload_date = Column(String, nullable=True)
    tags = Column(String, default="")
    query = Column(String, default="")
    status = Column(String, default="new", index=True)
    duplicate_video_id = Column(Integer, nullable=True)
    import_job_id = Column(Integer, nullable=True, index=True)
    import_job_item_id = Column(Integer, nullable=True, index=True)
    error = Column(Text, nullable=True)
    added_at = Column(DateTime, default=utcnow, index=True)
    analyzed_at = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)

class ImportJob(Base):
    __tablename__ = "import_jobs"
    id = Column(Integer, primary_key=True, index=True)
    batch_name = Column(String, index=True)
    source_mode = Column(String, default="mixed")
    status = Column(String, default="queued", index=True)
    total_items = Column(Integer, default=0)
    pending_items = Column(Integer, default=0)
    running_items = Column(Integer, default=0)
    imported_items = Column(Integer, default=0)
    failed_items = Column(Integer, default=0)
    duplicate_items = Column(Integer, default=0)
    cancelled_items = Column(Integer, default=0)
    options = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=utcnow)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)

class ImportJobItem(Base):
    __tablename__ = "import_job_items"
    __table_args__ = (
        Index("ix_import_job_items_status_id", "status", "id"),
        Index("ix_import_job_items_job_status", "job_id", "status"),
    )
    id = Column(Integer, primary_key=True, index=True)
    job_id = Column(Integer, index=True)
    url = Column(String, index=True)
    source_url = Column(String, index=True)
    normalized_url = Column(String, index=True)
    normalized_source = Column(String, index=True)
    title = Column(String)
    thumbnail = Column(String)
    duration = Column(Float, default=0)
    width = Column(Integer, default=0)
    height = Column(Integer, default=0)
    quality = Column(String, default="Unknown")
    file_size_mb = Column(Float, default=0)
    upload_date = Column(String, nullable=True)
    tags = Column(String, default="")
    actors = Column(String, default="")
    categories = Column(String, default="")
    status = Column(String, default="pending", index=True)
    error = Column(Text, nullable=True)
    attempts = Column(Integer, default=0)
    max_attempts = Column(Integer, default=3)
    video_id = Column(Integer, nullable=True)
    warnings = Column(JSON, nullable=True)
    confidence = Column(Float, default=0)
    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)

class ImportJobEvent(Base):
    __tablename__ = "import_job_events"
    __table_args__ = (
        Index("ix_import_job_events_job_id_id", "job_id", "id"),
    )
    id = Column(Integer, primary_key=True, index=True)
    job_id = Column(Integer, index=True)
    item_id = Column(Integer, nullable=True, index=True)
    level = Column(String, default="info")
    event_type = Column(String, index=True)
    message = Column(Text)
    payload = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=utcnow)

class VKSource(Base):
    __tablename__ = "vk_sources"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, index=True)
    url = Column(String, index=True, unique=True)
    source_type = Column(String, default="group")
    is_active = Column(Boolean, default=True)
    last_scanned = Column(DateTime, nullable=True)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utcnow)

class DomainProfile(Base):
    """Learned per-domain scraping profile for the adaptive rate limiter (A2)."""
    __tablename__ = "domain_profiles"
    domain = Column(String, primary_key=True)
    delay = Column(Float, default=4.0)          # current AIMD delay in seconds
    success_count = Column(Integer, default=0)
    failure_count = Column(Integer, default=0)
    last_failure_at = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, default=utcnow)


class SchedulerJobStat(Base):
    """Persisted scheduler job statistics so Mission Control survives restarts (A4)."""
    __tablename__ = "scheduler_job_stats"
    job_id = Column(String, primary_key=True)
    description = Column(String, default="")
    last_run = Column(DateTime, nullable=True)
    last_status = Column(String, default="")    # executed | error | missed
    last_error = Column(Text, nullable=True)
    run_count = Column(Integer, default=0)
    error_count = Column(Integer, default=0)
    avg_duration_ms = Column(Float, default=0.0)
    updated_at = Column(DateTime, default=utcnow)


class ForumThread(Base):
    """A XenForo thread the Forum Hub tracks (watched, or surfaced by a tag query)."""
    __tablename__ = "forum_threads"
    id = Column(Integer, primary_key=True, index=True)
    board = Column(String, index=True)              # "simpcity" | "smg"
    url = Column(String, index=True, unique=True)
    title = Column(String, default="")
    slug = Column(String, default="")
    origin = Column(String, default="watched")      # watched | tag
    discovered_via = Column(String, default="")     # tag(s) that surfaced it
    tags = Column(JSON, default=list)
    last_seen_post_id = Column(String, default="")  # XenForo post-<id> of newest ingested post
    scan_cursor_url = Column(String, default="")      # continuation URL for capped historical scans
    unread_count = Column(Integer, default=0)
    last_post_at = Column(DateTime, nullable=True)
    last_checked_at = Column(DateTime, nullable=True)
    pinned = Column(Boolean, default=False)
    created_at = Column(DateTime, default=utcnow)


class ForumPost(Base):
    """One post inside a tracked thread. Source of truth for a link's metadata."""
    __tablename__ = "forum_posts"
    id = Column(Integer, primary_key=True, index=True)
    thread_id = Column(Integer, index=True)
    post_id = Column(String, index=True)            # "1886"
    permalink = Column(String, default="")
    author = Column(String, default="")
    posted_at = Column(DateTime, nullable=True)
    body_text = Column(Text, default="")
    hashtags = Column(JSON, default=list)
    created_at = Column(DateTime, default=utcnow)


class ForumLink(Base):
    """One supported media link extracted from a post, with post-scoped metadata."""
    __tablename__ = "forum_links"
    id = Column(Integer, primary_key=True, index=True)
    thread_id = Column(Integer, index=True)
    post_id = Column(Integer, index=True)           # FK -> forum_posts.id
    url = Column(String, index=True, unique=True)
    platform = Column(String, index=True)           # bunkr | gofile | pixeldrain | turbo | ...
    link_type = Column(String, default="video")     # video | album | folder | archive | file
    title = Column(String, default="")
    thumbnail = Column(String, default="")
    quality = Column(String, default="")
    duration = Column(Integer, default=0)
    size_bytes = Column(Integer, default=0)
    tags = Column(JSON, default=list)
    author = Column(String, default="")
    posted_at = Column(DateTime, nullable=True)
    status = Column(String, index=True, default="new")  # new|resolved|imported|dead|dismissed
    resolved_payload = Column(JSON, nullable=True)
    resolved_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=utcnow)


class ForumTag(Base):
    """Tag vocabulary scraped from a board's /tags/ cloud, for local autocomplete."""
    __tablename__ = "forum_tags"
    id = Column(Integer, primary_key=True, index=True)
    board = Column(String, index=True)
    tag = Column(String, index=True)
    weight = Column(Float, default=1.0)             # relative size in the tag cloud
    updated_at = Column(DateTime, default=utcnow)


class ForumSavedQuery(Base):
    """A saved tag channel: refreshes alongside the watchlist, surfaces only new links."""
    __tablename__ = "forum_saved_queries"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, default="")
    board = Column(String, index=True, default="simpcity")
    tags = Column(JSON, default=list)
    window_days = Column(Integer, default=7)
    platforms = Column(JSON, default=list)          # empty = all supported
    last_run_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=utcnow)


class ForumSyncJob(Base):
    """Durable status for one background Forum Hub refresh."""
    __tablename__ = "forum_sync_jobs"
    id = Column(String, primary_key=True)
    boards = Column(JSON, nullable=False)
    unread_only = Column(Boolean, default=False)
    status = Column(String, index=True, default="queued")
    progress = Column(JSON, default=dict)
    result = Column(JSON, nullable=True)
    error = Column(Text, default="")
    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow)
    completed_at = Column(DateTime, nullable=True)


class FaphousePlaylist(Base):
    """A user-made collection of Faphouse videos — independent of the site's own playlists."""
    __tablename__ = "faphouse_playlists"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, index=True)
    description = Column(Text, default="")
    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)


class FaphousePlaylistItem(Base):
    """One video inside a FaphousePlaylist, in user-chosen order."""
    __tablename__ = "faphouse_playlist_items"
    id = Column(Integer, primary_key=True, index=True)
    playlist_id = Column(Integer, index=True, nullable=False)  # FK to faphouse_playlists.id (unmanaged, like VideoSource)
    video_url = Column(String, nullable=False)
    title = Column(String, default="")
    thumbnail = Column(String, default="")
    duration_sec = Column(Integer, default=0)
    position = Column(Integer, default=0, index=True)
    added_at = Column(DateTime, default=utcnow)


class FaphouseWatchHistory(Base):
    """Continue-watching + full history for the Faphouse page — one row per video ever opened.

    Doubles as the "For You" affinity signal: tags/categories on frequently
    (re)watched videos weight the recommendation feed, so this table is read
    far more than it's written.
    """
    __tablename__ = "faphouse_watch_history"
    id = Column(Integer, primary_key=True, index=True)
    video_url = Column(String, index=True, unique=True, nullable=False)
    title = Column(String, default="")
    thumbnail = Column(String, default="")
    duration_sec = Column(Integer, default=0)
    position_sec = Column(Float, default=0)
    tags = Column(String, default="")       # CSV, snapshotted at watch time for affinity scoring
    categories = Column(String, default="")  # CSV, same reason
    last_watched_at = Column(DateTime, default=utcnow, index=True)
    watch_count = Column(Integer, default=1)


class FaphouseFollow(Base):
    """A followed Faphouse model or studio, with a cursor for "new since last seen".

    Faphouse listing pages carry no reliable per-item timestamp to diff
    against, so the cursor is the URL of the newest video the user has
    already seen (first tile on page 1 at last-seen time) rather than a
    watermark date — "has_new" is then just "is page 1's first tile still
    this URL?".
    """
    __tablename__ = "faphouse_follows"
    id = Column(Integer, primary_key=True, index=True)
    kind = Column(String, index=True)   # "model" | "studio"
    ref = Column(String, index=True)    # slug/username used in the profile URL
    display_name = Column(String, default="")
    thumbnail = Column(String, default="")
    followed_at = Column(DateTime, default=utcnow)
    last_seen_video_url = Column(String, nullable=True)  # newest tile URL the user has already seen
    last_seen_at = Column(DateTime, nullable=True)


class FaphouseMashupJob(Base):
    """A Mashup Studio render — background ffmpeg compositing of 2-4 clips into one video."""
    __tablename__ = "faphouse_mashup_jobs"
    id = Column(Integer, primary_key=True, index=True)
    status = Column(String, default="queued", index=True)  # queued | rendering | done | failed
    progress_pct = Column(Integer, default=0)
    #: {"layout": "...", "tracks": [{"url","in_sec","out_sec","mute","crop_keyframes":[...],"position_keyframes":[...]}], "audio_track_keyframes": [...]}
    source_spec = Column(JSON, default=dict)
    output_path = Column(String, nullable=True)
    error = Column(String, nullable=True)
    created_at = Column(DateTime, default=utcnow)
    completed_at = Column(DateTime, nullable=True)


class FaphouseCommunityPlaylist(Base):
    """One row scraped from Faphouse's own public /playlists directory (other
    users' playlists, not ours — see FaphousePlaylist for that). Faphouse has
    no server-side search over this directory (a `?q=` there silently
    redirects to /search/videos instead), so this table exists purely to make
    a keyword search over playlist NAMES possible at all: crawl the ~90k
    community playlists once into local storage, then search is a plain
    SQL LIKE instead of a live scrape.
    """
    __tablename__ = "faphouse_community_playlists"
    id = Column(Integer, primary_key=True, index=True)
    url_code = Column(String, unique=True, index=True, nullable=False)  # the /playlists/{code} slug
    name = Column(String, index=True, default="")
    published_by = Column(String, default="")
    video_count = Column(Integer, default=0)
    crawled_at = Column(DateTime, default=utcnow)
    # Cached "Fast fetch" probe result (see app/routers/faphouse.py's
    # probe_community_playlist) — filled in the first time a card is probed,
    # then returned as-is on every later search so the badge shows up
    # immediately without re-fetching the playlist. NULL until probed at
    # least once.
    probe_quality_rating = Column(String, nullable=True)  # "4K" | "HD" | "LQ"
    probe_avg_duration_sec = Column(Integer, nullable=True)
    probe_avg_size_mb = Column(Float, nullable=True)
    probe_total_size_mb = Column(Float, nullable=True)
    probed_at = Column(DateTime, nullable=True)
    # User-marked favourite among community (other users') playlists — lets
    # a playlist found today stay easy to find again later without re-typing
    # the search that surfaced it. Distinct from FaphousePlaylist, which is
    # this app's own DB-backed collections, not a bookmark on someone else's.
    is_favorite = Column(Boolean, default=False, index=True)


class FaphousePlaylistCrawlState(Base):
    """Singleton row (id=1) tracking the community-playlist crawl's progress,
    so the UI can show "N / ~90,845 playlists" and a paused/failed crawl can
    resume from its last page instead of restarting from page 1.
    """
    __tablename__ = "faphouse_playlist_crawl_state"
    id = Column(Integer, primary_key=True, default=1)
    status = Column(String, default="idle")  # idle | running | done | error
    sort_mode = Column(String, default="popular")  # which sort is currently being crawled
    current_page = Column(Integer, default=0)
    total_pages = Column(Integer, default=0)  # 0 until the first page's pager reveals it
    playlists_found = Column(Integer, default=0)
    #: Faphouse serves a different ORDER per sort mode, so a full crawl needs
    #: both passes — one pass alone would miss playlists that only rank
    #: highly under the other ranking. Tracked separately from `status` so
    #: "popular finished, new errored" is representable instead of collapsing
    #: to one ambiguous flag.
    popular_done = Column(Boolean, default=False)
    new_done = Column(Boolean, default=False)
    started_at = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)
    error = Column(String, nullable=True)


class TelegramMediaIndex(Base):
    """Local cache and full-text index of Telegram videos found in joined channels.
    Allows sub-millisecond offline/instant search without hitting Telegram API rate limits.
    """
    __tablename__ = "telegram_media_index"
    __table_args__ = (
        Index("idx_tg_chat_msg", "chat_id", "message_id", unique=True),
        Index("idx_tg_channel", "channel"),
        Index("idx_tg_date", "date"),
        Index("idx_tg_duration_sec", "duration_sec"),
        Index("idx_tg_effective_res", "effective_res"),
        Index("idx_tg_size_bytes", "size_bytes"),
    )

    id = Column(Integer, primary_key=True, index=True)
    chat_id = Column(Integer, index=True, nullable=False)
    message_id = Column(Integer, index=True, nullable=False)
    channel = Column(String, index=True, nullable=True)
    channel_title = Column(String, nullable=True)
    author = Column(String, nullable=True)
    file_id = Column(String, index=True, nullable=True)
    title = Column(String, nullable=True)
    caption = Column(Text, nullable=True)
    file_name = Column(String, nullable=True)
    duration_sec = Column(Integer, default=0)
    duration = Column(String, nullable=True)
    size_bytes = Column(Integer, default=0)
    width = Column(Integer, default=0)
    height = Column(Integer, default=0)
    quality = Column(String, nullable=True)
    effective_res = Column(Integer, default=0)
    orientation = Column(String, default="landscape")
    views = Column(Integer, default=0)
    forwards = Column(Integer, default=0)
    reactions = Column(Integer, default=0)
    date = Column(String, nullable=True)
    url = Column(String, nullable=True)
    stream_url = Column(String, nullable=True)
    video_url = Column(String, nullable=True)
    thumbnail = Column(String, nullable=True)
    has_thumb = Column(Boolean, default=False)
    media_type = Column(String, default="video")
    supports_streaming = Column(Boolean, default=True)
    nosound = Column(Boolean, default=False)
    source_channels = Column(JSON, nullable=True)
    indexed_at = Column(DateTime, default=utcnow)


class TelegramCatalogChannel(Base):
    __tablename__ = "telegram_catalog_channels"
    peer_id = Column(String, primary_key=True)
    title = Column(String, default="")
    username = Column(String, default="")
    kind = Column(String, default="channel")
    total = Column(Integer, nullable=True)
    cursor = Column(Integer, default=0)
    head_id = Column(Integer, default=0)
    refresh_cursor = Column(Integer, default=0)
    refresh_target = Column(Integer, default=0)
    scanned = Column(Integer, default=0)
    complete = Column(Boolean, default=False)
    active = Column(Boolean, default=True)
    last_sync = Column(Float, default=0)
    retry_at = Column(Float, default=0)
    error = Column(Text, default="")
    priority = Column(Integer, default=0)


class TelegramForumTopic(Base):
    """Topics already read from a forum group. The next open shows these at once."""
    __tablename__ = "telegram_forum_topics"
    peer_id = Column(String, primary_key=True)
    topic_id = Column(Integer, primary_key=True)
    title = Column(String, default="")
    video_count = Column(Integer, nullable=True)
    closed = Column(Boolean, default=False)
    pinned = Column(Boolean, default=False)
    url = Column(String, default="")
    last_message_at = Column(Float, nullable=True)
    updated_at = Column(Float, default=0)


class TelegramCatalogControl(Base):
    __tablename__ = "telegram_catalog_control"
    id = Column(Integer, primary_key=True)
    enabled = Column(Boolean, default=False)
    discovered_at = Column(Float, default=0)
    wait_until = Column(Float, default=0)
    error = Column(Text, default="")
    last_batch_at = Column(Float, default=0)
    rate = Column(Float, default=0)


class TelegramLinkPost(Base):
    """Lokálny index Telegram príspevkov obsahujúcich MEGA alebo externé odkazy na balíčky."""
    __tablename__ = "telegram_link_posts"
    __table_args__ = (
        UniqueConstraint("chat_id", "message_id", "raw_url", name="uq_tg_link_post_msg_url"),
    )

    id = Column(Integer, primary_key=True, index=True)
    chat_id = Column(BigInteger, index=True, nullable=False)
    message_id = Column(BigInteger, index=True, nullable=False)
    channel = Column(String, index=True, nullable=True)
    channel_title = Column(String, nullable=True)
    title = Column(String, index=True, nullable=True)
    caption = Column(Text, nullable=True)
    post_url = Column(String, nullable=True)
    raw_url = Column(String, nullable=False, index=True)
    final_url = Column(String, nullable=True)
    domain = Column(String, index=True, nullable=True)
    link_kind = Column(String, default="external", index=True, nullable=False)
    resolved_mega_url = Column(String, index=True, nullable=True)
    has_photo = Column(Boolean, default=False)
    thumbnail = Column(String, nullable=True)
    date = Column(String, index=True, nullable=True)
    views = Column(Integer, default=0)
    reactions = Column(Integer, default=0)
    status = Column(String, default="new", index=True, nullable=False)
    mega_hub_entry_id = Column(Integer, index=True, nullable=True)
    mega_video_count = Column(Integer, nullable=True)
    extracted_links_json = Column(Text, nullable=True)
    discovered_links_json = Column(Text, nullable=True)
    indexed_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class ResolvedLinkCache(Base):
    """Lokálna zdieľaná cache rozbalených skracovačov, paste stránok a brán (šetrí opakované volania)."""
    __tablename__ = "resolved_link_cache"

    id = Column(Integer, primary_key=True, index=True)
    source_url = Column(String, unique=True, index=True, nullable=False)
    final_url = Column(String, nullable=True)
    provider = Column(String, default="clean_http", nullable=False)
    result_json = Column(Text, nullable=False)
    hits = Column(Integer, default=1, nullable=False)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


def ensure_telegram_links_tables(target_engine=None) -> None:
    """Idempotentne vytvorí tabuľky telegram_link_posts, resolved_link_cache, nové stĺpce a FTS5 index."""
    from sqlalchemy import inspect

    bind_engine = target_engine or engine
    TelegramLinkPost.__table__.create(bind_engine, checkfirst=True)
    ResolvedLinkCache.__table__.create(bind_engine, checkfirst=True)
    inspector = inspect(bind_engine)
    if inspector.has_table(TelegramLinkPost.__tablename__):
        existing_cols = {c["name"] for c in inspector.get_columns(TelegramLinkPost.__tablename__)}
        missing_cols = [
            col_name
            for col_name in ("extracted_links_json", "discovered_links_json")
            if col_name not in existing_cols
        ]
        if missing_cols:
            with bind_engine.begin() as conn:
                for col_name in missing_cols:
                    conn.execute(text(f"ALTER TABLE telegram_link_posts ADD COLUMN {col_name} TEXT"))
    if bind_engine.dialect.name != "sqlite":
        return
    inspector = inspect(bind_engine)
    if inspector.has_table("telegram_links_fts"):
        return
    try:
        with bind_engine.begin() as conn:
            conn.execute(text("""
                CREATE VIRTUAL TABLE telegram_links_fts USING fts5(
                    title, caption, channel, channel_title, domain, raw_url
                )
            """))
            conn.execute(text("""
                CREATE TRIGGER IF NOT EXISTS telegram_links_ai AFTER INSERT ON telegram_link_posts BEGIN
                  INSERT INTO telegram_links_fts(rowid, title, caption, channel, channel_title, domain, raw_url)
                  VALUES (
                    new.id,
                    coalesce(new.title, ''),
                    coalesce(new.caption, ''),
                    coalesce(new.channel, ''),
                    coalesce(new.channel_title, ''),
                    coalesce(new.domain, ''),
                    coalesce(new.raw_url, '')
                  );
                END;
            """))
            conn.execute(text("""
                CREATE TRIGGER IF NOT EXISTS telegram_links_ad AFTER DELETE ON telegram_link_posts BEGIN
                  DELETE FROM telegram_links_fts WHERE rowid = old.id;
                END;
            """))
            conn.execute(text("""
                CREATE TRIGGER IF NOT EXISTS telegram_links_au AFTER UPDATE ON telegram_link_posts
                FOR EACH ROW
                WHEN (
                    old.title IS NOT new.title
                    OR old.caption IS NOT new.caption
                    OR old.channel IS NOT new.channel
                    OR old.channel_title IS NOT new.channel_title
                    OR old.domain IS NOT new.domain
                    OR old.raw_url IS NOT new.raw_url
                )
                BEGIN
                  DELETE FROM telegram_links_fts WHERE rowid = old.id;
                  INSERT INTO telegram_links_fts(rowid, title, caption, channel, channel_title, domain, raw_url)
                  VALUES (
                    new.id,
                    coalesce(new.title, ''),
                    coalesce(new.caption, ''),
                    coalesce(new.channel, ''),
                    coalesce(new.channel_title, ''),
                    coalesce(new.domain, ''),
                    coalesce(new.raw_url, '')
                  );
                END;
            """))
            conn.execute(text("""
                INSERT INTO telegram_links_fts(rowid, title, caption, channel, channel_title, domain, raw_url)
                SELECT id, coalesce(title, ''), coalesce(caption, ''), coalesce(channel, ''),
                       coalesce(channel_title, ''), coalesce(domain, ''), coalesce(raw_url, '')
                FROM telegram_link_posts
            """))
    except Exception as e:
        print(f"Telegram Links FTS5 initialization failed (ignoring): {e}")


def init_db():
    from sqlalchemy import inspect
    inspector = inspect(engine)
    had_videos = inspector.has_table("videos")
    # Idempotent: only creates tables that don't exist yet (checkfirst=True),
    # so newly added models get their tables even on long-lived databases.
    Base.metadata.create_all(bind=engine)
    if inspect(engine).has_table("telegram_forum_topics"):
        topic_columns = {c["name"] for c in inspect(engine).get_columns("telegram_forum_topics")}
        if "last_message_at" not in topic_columns:
            with engine.begin() as connection:
                connection.execute(text("ALTER TABLE telegram_forum_topics ADD COLUMN last_message_at FLOAT"))
    if inspect(engine).has_table("forum_threads"):
        forum_columns = {c["name"] for c in inspect(engine).get_columns("forum_threads")}
        if "scan_cursor_url" not in forum_columns:
            with engine.begin() as connection:
                connection.execute(text('ALTER TABLE forum_threads ADD COLUMN scan_cursor_url VARCHAR DEFAULT ""'))
    if had_videos:
        columns = [c['name'] for c in inspector.get_columns('videos')]
        if 'sprite_path' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN sprite_path VARCHAR'))
        if 'source_url' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN source_url VARCHAR'))
        if 'storage_type' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN storage_type VARCHAR DEFAULT "remote"'))
        if 'phash' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN phash VARCHAR'))
                connection.execute(text('CREATE INDEX IF NOT EXISTS idx_phash ON videos(phash)'))
        if 'duplicate_of' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN duplicate_of INTEGER'))
        if 'last_checked' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN last_checked DATETIME'))
        if 'link_status' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN link_status VARCHAR DEFAULT "unknown"'))
        if 'check_count' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN check_count INTEGER DEFAULT 0'))
        if 'download_stats' not in columns:
            with engine.connect() as connection:
                # Add JSON column for download statistics (speed, time, size)
                # SQLite supports JSON just as TEXT, SQLAlchemy handles the serialization
                connection.execute(text('ALTER TABLE videos ADD COLUMN download_stats JSON'))
        if 'aspect_ratio' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN aspect_ratio VARCHAR'))
        if 'views' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN views INTEGER DEFAULT 0'))
        if 'upload_date' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN upload_date VARCHAR'))
        if 'quality' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN quality VARCHAR DEFAULT "SD"'))
        if 'file_size_mb' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN file_size_mb FLOAT DEFAULT 0'))
        
        with engine.connect() as connection:
            connection.execute(text('CREATE INDEX IF NOT EXISTS idx_videos_created_at ON videos(created_at)'))
            connection.execute(text('CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status)'))
            connection.execute(text('CREATE INDEX IF NOT EXISTS idx_videos_is_favorite ON videos(is_favorite)'))
            connection.execute(text('CREATE INDEX IF NOT EXISTS idx_videos_duration ON videos(duration)'))
            connection.execute(text('CREATE INDEX IF NOT EXISTS idx_videos_file_size_mb ON videos(file_size_mb)'))
            connection.execute(text('CREATE INDEX IF NOT EXISTS idx_videos_status_id ON videos(status, id DESC)'))
            connection.execute(text('CREATE INDEX IF NOT EXISTS idx_videos_batch_id ON videos(batch_name, id DESC)'))
            connection.execute(text('CREATE INDEX IF NOT EXISTS idx_videos_fav_id ON videos(is_favorite, id DESC)'))
            connection.execute(text('CREATE INDEX IF NOT EXISTS idx_videos_created_id ON videos(created_at DESC, id DESC)'))

        if 'preview_retry_needed' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN preview_retry_needed BOOLEAN DEFAULT 0'))
        if 'preview_retry_count' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN preview_retry_count INTEGER DEFAULT 0'))
        if 'preview_last_error' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN preview_last_error VARCHAR'))
        if 'categories' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN categories VARCHAR DEFAULT ""'))
        if 'models' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN models VARCHAR DEFAULT ""'))
        if 'preview_mp4_url' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN preview_mp4_url VARCHAR DEFAULT ""'))
        if 'original_thumbnail_url' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN original_thumbnail_url VARCHAR DEFAULT ""'))
        if 'thumbnail_referer' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN thumbnail_referer VARCHAR DEFAULT ""'))
        if 'smart_rethumb_at' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN smart_rethumb_at DATETIME'))
        if 'smart_rethumb_error' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN smart_rethumb_error VARCHAR'))
        if 'telegram_chat_id' not in columns or 'telegram_message_id' not in columns:
            with engine.begin() as connection:
                if 'telegram_chat_id' not in columns:
                    connection.execute(text('ALTER TABLE videos ADD COLUMN telegram_chat_id VARCHAR'))
                if 'telegram_message_id' not in columns:
                    connection.execute(text('ALTER TABLE videos ADD COLUMN telegram_message_id INTEGER'))
                connection.execute(text('CREATE INDEX IF NOT EXISTS idx_videos_telegram_chat_id ON videos(telegram_chat_id)'))
        
        # Ensure indexes on url and source_url exist
        with engine.connect() as connection:
            connection.execute(text('CREATE INDEX IF NOT EXISTS idx_videos_url ON videos(url)'))
            connection.execute(text('CREATE INDEX IF NOT EXISTS idx_videos_source_url ON videos(source_url)'))

    if inspector.has_table("moments"):
        # Studio shipped with library-only moments; hub moments, auto-proposals
        # and the review workflow each added a column afterwards.
        moment_columns = [c['name'] for c in inspector.get_columns('moments')]
        with engine.connect() as connection:
            for name, ddl in (
                ('source', 'ALTER TABLE moments ADD COLUMN source VARCHAR DEFAULT ""'),
                ('origin', 'ALTER TABLE moments ADD COLUMN origin VARCHAR DEFAULT "manual"'),
                ('status', 'ALTER TABLE moments ADD COLUMN status VARCHAR DEFAULT "kept"'),
                ('thumb_url', 'ALTER TABLE moments ADD COLUMN thumb_url VARCHAR DEFAULT ""'),
            ):
                if name not in moment_columns:
                    connection.execute(text(ddl))
            connection.execute(text('CREATE INDEX IF NOT EXISTS idx_moments_status ON moments(status)'))
            connection.execute(text('CREATE INDEX IF NOT EXISTS idx_moments_source ON moments(source)'))
            connection.commit()

    if not inspector.has_table("smart_playlists"):
         Base.metadata.create_all(bind=engine)

    if not inspector.has_table("source_boards"):
         Base.metadata.create_all(bind=engine)
    if inspector.has_table("import_job_items"):
        item_columns = [c['name'] for c in inspector.get_columns('import_job_items')]
        with engine.begin() as connection:
            if 'upload_date' not in item_columns:
                connection.execute(text('ALTER TABLE import_job_items ADD COLUMN upload_date VARCHAR'))
            if 'file_size_mb' not in item_columns:
                connection.execute(text('ALTER TABLE import_job_items ADD COLUMN file_size_mb FLOAT DEFAULT 0'))
            connection.execute(text(
                'CREATE INDEX IF NOT EXISTS ix_import_job_items_status_id '
                'ON import_job_items(status, id)'
            ))
            connection.execute(text(
                'CREATE INDEX IF NOT EXISTS ix_import_job_items_job_status '
                'ON import_job_items(job_id, status)'
            ))

    if inspector.has_table("import_job_events"):
        with engine.begin() as connection:
            connection.execute(text(
                'CREATE INDEX IF NOT EXISTS ix_import_job_events_job_id_id '
                'ON import_job_events(job_id, id)'
            ))

    if not inspector.has_table("search_history"):
         Base.metadata.create_all(bind=engine)

    if not inspector.has_table("discovery_profiles"):
         Base.metadata.create_all(bind=engine)

    if not inspector.has_table("discovery_notifications"):
         Base.metadata.create_all(bind=engine)

    if not inspector.has_table("discovered_videos"):
         Base.metadata.create_all(bind=engine)
    else:
        discovered_columns = [c['name'] for c in inspector.get_columns('discovered_videos')]
        if 'file_size_mb' not in discovered_columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE discovered_videos ADD COLUMN file_size_mb FLOAT DEFAULT 0'))
        if 'categories' not in discovered_columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE discovered_videos ADD COLUMN categories VARCHAR DEFAULT ""'))
        if 'models' not in discovered_columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE discovered_videos ADD COLUMN models VARCHAR DEFAULT ""'))
        if 'related_src' not in discovered_columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE discovered_videos ADD COLUMN related_src VARCHAR DEFAULT ""'))
        if 'preview_mp4_url' not in discovered_columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE discovered_videos ADD COLUMN preview_mp4_url VARCHAR DEFAULT ""'))
        if 'phash' not in discovered_columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE discovered_videos ADD COLUMN phash VARCHAR'))
                connection.execute(text('CREATE INDEX IF NOT EXISTS idx_discovered_phash ON discovered_videos(phash)'))
        if 'duplicate_of' not in discovered_columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE discovered_videos ADD COLUMN duplicate_of INTEGER'))

    if not inspector.has_table("discovery_dismissed_videos"):
         Base.metadata.create_all(bind=engine)

    if not inspector.has_table("pornhub_queue_items"):
         Base.metadata.create_all(bind=engine)

    if not inspector.has_table("import_jobs"):
         Base.metadata.create_all(bind=engine)

    if not inspector.has_table("import_job_items"):
         Base.metadata.create_all(bind=engine)

    if not inspector.has_table("import_job_events"):
         Base.metadata.create_all(bind=engine)

    if not inspector.has_table("vk_sources"):
         Base.metadata.create_all(bind=engine)

    if not inspector.has_table("video_sources"):
         Base.metadata.create_all(bind=engine)

    if not inspector.has_table("video_embeddings"):
         Base.metadata.create_all(bind=engine)

    # Initialize FTS5 for ultra-fast search
    if _is_sqlite:
        with engine.begin() as conn:
            inspector = inspect(engine)
            if not inspector.has_table("videos_fts"):
                try:
                    print("Creating FTS5 virtual table for videos...")
                    conn.execute(text("""
                        CREATE VIRTUAL TABLE videos_fts USING fts5(
                            title, tags, ai_tags, batch_name
                        )
                    """))
                    
                    # Add triggers to keep FTS in sync
                    conn.execute(text("""
                        CREATE TRIGGER IF NOT EXISTS videos_ai AFTER INSERT ON videos BEGIN
                          INSERT INTO videos_fts(rowid, title, tags, ai_tags, batch_name) 
                          VALUES (new.id, new.title, new.tags, new.ai_tags, new.batch_name);
                        END;
                    """))
                    conn.execute(text("""
                        CREATE TRIGGER IF NOT EXISTS videos_ad AFTER DELETE ON videos BEGIN
                          DELETE FROM videos_fts WHERE rowid = old.id;
                        END;
                    """))
                    conn.execute(text("""
                        CREATE TRIGGER IF NOT EXISTS videos_au AFTER UPDATE ON videos 
                        FOR EACH ROW
                        WHEN (old.title IS NOT new.title OR old.tags IS NOT new.tags OR old.ai_tags IS NOT new.ai_tags OR old.batch_name IS NOT new.batch_name)
                        BEGIN
                          DELETE FROM videos_fts WHERE rowid = old.id;
                          INSERT INTO videos_fts(rowid, title, tags, ai_tags, batch_name) 
                          VALUES (new.id, new.title, new.tags, new.ai_tags, new.batch_name);
                        END;
                    """))
                    
                    # Populate FTS table from existing data
                    print("Populating FTS5 index...")
                    conn.execute(text("INSERT INTO videos_fts(rowid, title, tags, ai_tags, batch_name) SELECT id, title, tags, ai_tags, batch_name FROM videos"))
                except Exception as e:
                    print(f"FTS5 initialization failed (ignoring): {e}")

            if not inspector.has_table("telegram_media_fts"):
                try:
                    print("Creating FTS5 virtual table for telegram_media_index...")
                    conn.execute(text("""
                        CREATE VIRTUAL TABLE telegram_media_fts USING fts5(
                            title, caption, file_name, channel, author
                        )
                    """))
                    conn.execute(text("""
                        CREATE TRIGGER IF NOT EXISTS telegram_media_ai AFTER INSERT ON telegram_media_index BEGIN
                          INSERT INTO telegram_media_fts(rowid, title, caption, file_name, channel, author) 
                          VALUES (new.id, coalesce(new.title, ''), coalesce(new.caption, ''), coalesce(new.file_name, ''), coalesce(new.channel, ''), coalesce(new.author, ''));
                        END;
                    """))
                    conn.execute(text("""
                        CREATE TRIGGER IF NOT EXISTS telegram_media_ad AFTER DELETE ON telegram_media_index BEGIN
                          DELETE FROM telegram_media_fts WHERE rowid = old.id;
                        END;
                    """))
                    conn.execute(text("""
                        CREATE TRIGGER IF NOT EXISTS telegram_media_au AFTER UPDATE ON telegram_media_index 
                        FOR EACH ROW
                        WHEN (old.title IS NOT new.title OR old.caption IS NOT new.caption OR old.file_name IS NOT new.file_name OR old.channel IS NOT new.channel OR old.author IS NOT new.author)
                        BEGIN
                          DELETE FROM telegram_media_fts WHERE rowid = old.id;
                          INSERT INTO telegram_media_fts(rowid, title, caption, file_name, channel, author) 
                          VALUES (new.id, coalesce(new.title, ''), coalesce(new.caption, ''), coalesce(new.file_name, ''), coalesce(new.channel, ''), coalesce(new.author, ''));
                        END;
                    """))
                    conn.execute(text("INSERT INTO telegram_media_fts(rowid, title, caption, file_name, channel, author) SELECT id, coalesce(title, ''), coalesce(caption, ''), coalesce(file_name, ''), coalesce(channel, ''), coalesce(author, '') FROM telegram_media_index"))
                except Exception as e:
                    print(f"Telegram FTS5 initialization failed (ignoring): {e}")

    ensure_telegram_links_tables(engine)

    # faphouse_playlist_crawl_state gained popular_done/new_done after its
    # table already existed on some installs (create_all only creates
    # missing TABLES, never adds columns to ones that already exist) —
    # without this, every query against the row 500s with "no such column".
    if inspector.has_table("faphouse_playlist_crawl_state"):
        crawl_columns = [c['name'] for c in inspector.get_columns('faphouse_playlist_crawl_state')]
        if 'popular_done' not in crawl_columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE faphouse_playlist_crawl_state ADD COLUMN popular_done BOOLEAN DEFAULT 0'))
        if 'new_done' not in crawl_columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE faphouse_playlist_crawl_state ADD COLUMN new_done BOOLEAN DEFAULT 0'))

    # faphouse_community_playlists gained the probe_* cache columns after its
    # table already existed on some installs — same create_all limitation as
    # above (missing TABLES only, never new columns on existing ones).
    if inspector.has_table("faphouse_community_playlists"):
        playlist_columns = [c['name'] for c in inspector.get_columns('faphouse_community_playlists')]
        _probe_columns = {
            'probe_quality_rating': 'VARCHAR',
            'probe_avg_duration_sec': 'INTEGER',
            'probe_avg_size_mb': 'FLOAT',
            'probe_total_size_mb': 'FLOAT',
            'probed_at': 'DATETIME',
            'is_favorite': 'BOOLEAN DEFAULT 0',
        }
        for col_name, col_type in _probe_columns.items():
            if col_name not in playlist_columns:
                with engine.connect() as connection:
                    connection.execute(text(f'ALTER TABLE faphouse_community_playlists ADD COLUMN {col_name} {col_type}'))

from .autotagger import auto_tag_video

@event.listens_for(Video, 'before_insert')
@event.listens_for(Video, 'before_update')
def auto_tag_video_event(mapper, connection, target):
    if target.title:
        tags_models = auto_tag_video(target.title)
        
        # Merge tags
        current_tags = set([t.strip() for t in (target.tags or "").split(",") if t.strip()])
        new_tags = set(tags_models["tags"])
        combined_tags = current_tags.union(new_tags)
        if combined_tags:
            target.tags = ", ".join(sorted(list(combined_tags)))
            
        # Merge models
        current_models = set([m.strip() for m in (target.models or "").split(",") if m.strip()])
        new_models = set(tags_models["models"])
        combined_models = current_models.union(new_models)
        if combined_models:
            target.models = ", ".join(sorted(list(combined_models)))

def get_db():
    db = SessionLocal()
    try: yield db
    finally: db.close()


def clear_all_app_data(db) -> dict:
    """
    Remove all data from application tables while keeping the schema intact.
    """
    tables = [
        ("videos", Video),
        ("smart_playlists", SmartPlaylist),
        ("source_boards", SourceBoard),
        ("search_history", SearchHistory),
        ("discovery_profiles", DiscoveryProfile),
        ("discovery_notifications", DiscoveryNotification),
        ("discovered_videos", DiscoveredVideo),
        ("discovery_dismissed_videos", DiscoveryDismissedVideo),
        ("vk_sources", VKSource),
    ]

    counts = {}

    try:
        for table_name, model in tables:
            counts[table_name] = db.query(model).count()

        for _, model in tables:
            db.query(model).delete(synchronize_session=False)

        db.commit()
        return counts
    except Exception:
        db.rollback()
        raise


def get_db_health() -> dict:
    """
    Check database health and return status information.
    
    Returns:
        Dictionary with health check results
    """
    health = {
        "status": "unknown",
        "database_exists": False,
        "database_size_mb": 0,
        "tables": [],
        "total_videos": 0,
        "connection_pool": {},
        "errors": []
    }
    
    try:
        from sqlalchemy import inspect
        import os
        
        # Check if database file exists
        db_path = SQLALCHEMY_DATABASE_URL.replace('sqlite:///', '')
        if os.path.exists(db_path):
            health["database_exists"] = True
            health["database_size_mb"] = round(os.path.getsize(db_path) / (1024 * 1024), 2)
        
        # Check connection and schema
        inspector = inspect(engine)
        health["tables"] = inspector.get_table_names()
        
        # Get pool statistics
        pool = engine.pool
        health["connection_pool"] = {
            "size": pool.size(),
            "checked_in": pool.checkedin(),
            "checked_out": pool.checkedout(),
            "overflow": pool.overflow(),
            "max_overflow": pool._max_overflow if hasattr(pool, '_max_overflow') else 0
        }
        
        # Count videos
        db = SessionLocal()
        try:
            health["total_videos"] = db.query(Video).count()
        finally:
            db.close()
        
        health["status"] = "healthy"
        
    except Exception as e:
        health["status"] = "unhealthy"
        health["errors"].append(str(e))
    
    return health


def get_migration_version() -> dict:
    """
    Get current Alembic migration version.
    
    Returns:
        Dictionary with version information
    """
    version_info = {
        "current_revision": None,
        "is_up_to_date": False,
        "error": None
    }
    
    try:
        from alembic import command
        from alembic.config import Config
        from alembic.script import ScriptDirectory
        from alembic.migration import MigrationContext
        
        # Get current revision from database
        with engine.connect() as conn:
            context = MigrationContext.configure(conn)
            current_rev = context.get_current_revision()
            version_info["current_revision"] = current_rev
        
        # Check if up to date
        alembic_cfg = Config("alembic.ini")
        script = ScriptDirectory.from_config(alembic_cfg)
        head_rev = script.get_current_head()
        
        version_info["head_revision"] = head_rev
        version_info["is_up_to_date"] = (current_rev == head_rev)
        
    except Exception as e:
        version_info["error"] = str(e)
    
    return version_info

def sanitize_fts_query(query: str) -> str:
    """
    Sanitize user input for SQLite FTS5 MATCH queries.
    Removes special characters that could break the FTS5 syntax or allow injection.
    """
    if not query:
        return ""
    # Remove characters that have special meaning in FTS5
    # For now, we strip most and allow simple words.
    # We allow alphanumeric, spaces, hyphens and dots.
    tokens = re.findall(r'\w+', query, flags=re.UNICODE)
    if not tokens:
        return ""
    return " ".join(f'"{t}"' for t in tokens)


def ensure_performance_indexes() -> int:
    """Idempotently create hot-path SQLite indexes on videos if the table exists."""
    if not _is_sqlite:
        return 0
    stmts = (
        "CREATE INDEX IF NOT EXISTS ix_videos_status_created ON videos (status, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS ix_videos_created_at ON videos (created_at DESC)",
        "CREATE INDEX IF NOT EXISTS ix_videos_is_favorite ON videos (is_favorite)",
        "CREATE INDEX IF NOT EXISTS ix_videos_is_watched ON videos (is_watched)",
        "CREATE INDEX IF NOT EXISTS ix_videos_quality ON videos (quality)",
        "CREATE INDEX IF NOT EXISTS ix_videos_duplicate_of ON videos (duplicate_of)",
    )
    created = 0
    try:
        with engine.begin() as conn:
            has_table = conn.execute(
                text("SELECT 1 FROM sqlite_master WHERE type='table' AND name='videos'")
            ).scalar()
            if not has_table:
                return 0
            for sql in stmts:
                conn.execute(text(sql))
                created += 1
    except Exception:
        return created
    return created


def optimize_sqlite_database() -> dict:
    """Run non-blocking SQLite maintenance (PRAGMA optimize + passive WAL checkpoint)."""
    if not _is_sqlite:
        return {"skipped": True}
    result = {"optimized": False, "wal_checkpoint": None}
    try:
        with engine.begin() as conn:
            conn.execute(text("PRAGMA optimize"))
            row = conn.execute(text("PRAGMA wal_checkpoint(PASSIVE)")).fetchone()
            result["optimized"] = True
            if row is not None:
                result["wal_checkpoint"] = tuple(row)
    except Exception as exc:
        result["error"] = str(exc)
    return result


