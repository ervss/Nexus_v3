"""
System health + observability endpoints (A5 — extracted from main.py).

Also exposes the new A1/A2/A4 introspection APIs:
    GET /api/v1/events/recent       — recent NexusEvent history (ring buffer)
    GET /api/v1/ratelimit/domains   — learned adaptive rate-limiter state
    GET /api/v1/scheduler/stats     — persisted job statistics
"""
import asyncio
import datetime
import ipaddress

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from ..database import SessionLocal, Video, SchedulerJobStat, text
from ..events import bus

router = APIRouter(tags=["system-health"])


def _require_local_control(request: Request) -> None:
    """Tor process controls are intentionally available only from this machine."""
    host = request.client.host if request.client else ""
    try:
        if ipaddress.ip_address(host).is_loopback:
            return
    except ValueError:
        if host.lower() == "localhost":
            return
    raise HTTPException(status_code=403, detail="Tor controls are local-only")


@router.get("/api/v1/tor/status")
async def tor_status():
    from ..tor_service import tor_service
    return await asyncio.to_thread(tor_service.status)


@router.post("/api/v1/tor/start")
async def tor_start(request: Request):
    _require_local_control(request)
    from ..tor_service import tor_service
    state = await asyncio.to_thread(tor_service.start)
    if not state.get("ready"):
        raise HTTPException(status_code=503, detail=state)
    return state


@router.post("/api/v1/tor/new-identity")
async def tor_new_identity(request: Request):
    _require_local_control(request)
    from ..tor_service import tor_service
    state = await asyncio.to_thread(tor_service.new_identity)
    if state.get("last_error"):
        raise HTTPException(status_code=503, detail=state)
    return state


@router.post("/api/v1/tor/stop")
async def tor_stop(request: Request):
    _require_local_control(request)
    from ..tor_service import tor_service
    return await asyncio.to_thread(tor_service.stop)


@router.get("/health")
async def health_check():
    """
    Lightweight health check endpoint for load balancers and monitoring.
    Returns 200 OK if service is healthy.
    """
    try:
        # Quick database connectivity check
        db = SessionLocal()
        db.execute(text("SELECT 1")).fetchone()
        db.close()

        return {
            "status": "healthy",
            "service": "Nexus Pokrok API",
            "timestamp": datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).isoformat()
        }
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Service unhealthy: {str(e)}")


@router.get("/health/detailed")
async def health_check_detailed():
    """Detailed health check with database and scheduler status."""
    from ..db_maintenance import get_database_stats
    from ..scheduler import get_scheduler

    try:
        db = SessionLocal()
        video_count = db.query(Video).count()
        db.close()

        db_stats = get_database_stats()

        return {
            "status": "healthy",
            "database": {
                "accessible": True,
                "video_count": video_count,
                "db_size_mb": db_stats.get('db_size_mb', 0),
                "wal_size_mb": db_stats.get('wal_size_mb', 0)
            },
            "scheduler": {
                "running": get_scheduler()._running
            },
            "timestamp": datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).isoformat()
        }
    except Exception as e:
        return JSONResponse(
            status_code=503,
            content={
                "status": "unhealthy",
                "error": str(e),
                "timestamp": datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).isoformat()
            }
        )


@router.get("/health/db")
def health_check_db():
    """Database health check with detailed statistics."""
    from ..database import get_db_health, get_migration_version

    db_health = get_db_health()
    migration_info = get_migration_version()

    return {
        "database": db_health,
        "migrations": migration_info,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).isoformat()
    }


@router.get("/health/pool")
def health_check_pool():
    """Connection pool statistics."""
    from ..database import engine

    pool = engine.pool
    return {
        "pool_size": pool.size(),
        "checked_in_connections": pool.checkedin(),
        "checked_out_connections": pool.checkedout(),
        "overflow_connections": pool.overflow(),
        "max_overflow": pool._max_overflow if hasattr(pool, '_max_overflow') else 0,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).isoformat()
    }


# ── A1/A2/A4 observability ────────────────────────────────────────────────

@router.get("/api/v1/events/recent")
def recent_events(
    topics: str = Query(default="", description="Comma-separated fnmatch patterns, e.g. 'ratelimit.*,job.state'"),
    limit: int = Query(default=200, le=400),
):
    """Recent NexusEvents from the in-memory ring buffer."""
    patterns = [p.strip() for p in topics.split(",") if p.strip()] or None
    return {"events": bus.history(patterns=patterns, limit=limit)}


@router.get("/api/v1/ratelimit/domains")
def ratelimit_domains():
    """Learned adaptive rate-limiter state per domain (AIMD delays, counters)."""
    from ..main import rate_limiter
    return {"domains": rate_limiter.snapshot()}


@router.get("/api/v1/scheduler/stats")
def scheduler_job_stats():
    """Persisted scheduler job statistics (survive restarts)."""
    db = SessionLocal()
    try:
        rows = db.query(SchedulerJobStat).all()
        return {"jobs": [
            {
                "job_id": r.job_id,
                "description": r.description,
                "last_run": r.last_run.isoformat() if r.last_run else None,
                "last_status": r.last_status,
                "last_error": r.last_error,
                "run_count": r.run_count,
                "error_count": r.error_count,
            } for r in rows
        ]}
    finally:
        db.close()
