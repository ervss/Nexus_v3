import uuid
import asyncio
from typing import List, Dict, Any, Optional
from pydantic import BaseModel
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Depends
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.checker_cache import CheckerCache
from app.checkers.orchestrator import orchestrator
from app.checkers.base import CheckResult

router = APIRouter(prefix="/api/checker", tags=["checker"])

# In-memory úložisko pre bežiace a dokončené jobs
jobs: Dict[str, Dict[str, Any]] = {}

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

class StartCheckRequest(BaseModel):
    urls: List[str]

class CheckResponse(BaseModel):
    job_id: str
    status: str
    total: int

async def run_checker_job(job_id: str, urls: List[str]):
    jobs[job_id]["status"] = "running"
    results = []

    db = SessionLocal()
    try:
        for idx, url in enumerate(urls):
            # 1. Skontroluj cache
            cached = db.query(CheckerCache).filter(CheckerCache.embed_url == url).first()
            if cached and cached.is_valid():
                res = CheckResult(
                    server=cached.server,
                    direct_url=cached.direct_url,
                    quality=cached.quality,
                    size_bytes=cached.size_bytes,
                    error=cached.error,
                    duration_ms=0
                )
            else:
                # 2. Over cez orchestrator
                res = await orchestrator.check_url(url)
                # Ulož do cache
                try:
                    if cached:
                        cached.direct_url = res.direct_url
                        cached.quality = res.quality
                        cached.size_bytes = res.size_bytes
                        cached.error = res.error
                    else:
                        new_cache = CheckerCache(
                            embed_url=url,
                            server=res.server,
                            direct_url=res.direct_url,
                            quality=res.quality,
                            size_bytes=res.size_bytes,
                            error=res.error
                        )
                        db.add(new_cache)
                    db.commit()
                except Exception:
                    db.rollback()

            results.append({
                "embed_url": url,
                "server": res.server,
                "direct_url": res.direct_url,
                "quality": res.quality,
                "size_bytes": res.size_bytes,
                "error": res.error,
                "duration_ms": res.duration_ms
            })
            jobs[job_id]["progress"] = idx + 1
            jobs[job_id]["results"] = results
    finally:
        db.close()

    jobs[job_id]["status"] = "completed"

@router.post("/start")
async def start_checker(req: StartCheckRequest, background_tasks: BackgroundTasks):
    if not req.urls:
        raise HTTPException(status_code=400, detail="No URLs provided")

    job_id = uuid.uuid4().hex
    jobs[job_id] = {
        "job_id": job_id,
        "status": "pending",
        "total": len(req.urls),
        "progress": 0,
        "results": []
    }

    # Spustenie na pozadí
    asyncio.create_task(run_checker_job(job_id, req.urls))

    return {
        "job_id": job_id,
        "status": "started",
        "total": len(req.urls)
    }

@router.get("/result")
@router.get("/result/{job_id}")
async def get_checker_result(job_id: Optional[str] = None):
    if not job_id:
        raise HTTPException(status_code=400, detail="Missing job_id")
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job

@router.get("/direct")
async def check_direct(url: str, db: Session = Depends(get_db)):
    """Priame synchrónne overenie jedného embedu (pre browser extension)."""
    cached = db.query(CheckerCache).filter(CheckerCache.embed_url == url).first()
    if cached and cached.is_valid():
        return {
            "embed_url": url,
            "server": cached.server,
            "direct_url": cached.direct_url,
            "quality": cached.quality,
            "size_bytes": cached.size_bytes,
            "error": cached.error,
            "cached": True
        }

    res = await orchestrator.check_url(url)
    try:
        if cached:
            cached.direct_url = res.direct_url
            cached.quality = res.quality
            cached.size_bytes = res.size_bytes
            cached.error = res.error
        else:
            new_cache = CheckerCache(
                embed_url=url,
                server=res.server,
                direct_url=res.direct_url,
                quality=res.quality,
                size_bytes=res.size_bytes,
                error=res.error
            )
            db.add(new_cache)
        db.commit()
    except Exception:
        db.rollback()

    return {
        "embed_url": url,
        "server": res.server,
        "direct_url": res.direct_url,
        "quality": res.quality,
        "size_bytes": res.size_bytes,
        "error": res.error,
        "cached": False
    }
