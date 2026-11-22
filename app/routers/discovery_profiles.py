"""
Discovery profile CRUD + notifications (A5 — extracted from main.py).
Mounted under both /api/v1 and /api by main.py's router include loop.
"""
import datetime
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import desc
from sqlalchemy.orm import Session

from ..auth import check_auth
from ..auto_discovery import run_discovery_profile
from ..database import DiscoveryNotification, DiscoveryProfile, get_db
from ..scheduler import get_scheduler

router = APIRouter(tags=["discovery-profiles"])


class DiscoveryProfileCreate(BaseModel):
    name: str
    enabled: bool = True
    schedule_type: str = "interval"  # "interval", "cron", "manual"
    schedule_value: str = "3600"  # seconds for interval, cron expression for cron
    keywords: str = ""
    exclude_keywords: str = ""
    sources: List[str] = []
    min_height: Optional[int] = None
    max_height: Optional[int] = None
    aspect_ratio: Optional[str] = None
    min_duration: Optional[int] = None
    max_duration: Optional[int] = None
    max_results: int = 20
    auto_import: bool = False
    batch_prefix: str = "Auto"


class DiscoveryProfileUpdate(BaseModel):
    name: Optional[str] = None
    enabled: Optional[bool] = None
    schedule_type: Optional[str] = None
    schedule_value: Optional[str] = None
    keywords: Optional[str] = None
    exclude_keywords: Optional[str] = None
    sources: Optional[List[str]] = None
    min_height: Optional[int] = None
    max_height: Optional[int] = None
    aspect_ratio: Optional[str] = None
    min_duration: Optional[int] = None
    max_duration: Optional[int] = None
    max_results: Optional[int] = None
    auto_import: Optional[bool] = None
    batch_prefix: Optional[str] = None


def _profile_to_dict(profile: DiscoveryProfile) -> dict:
    return {
        "id": profile.id,
        "name": profile.name,
        "enabled": profile.enabled,
        "schedule_type": profile.schedule_type,
        "schedule_value": profile.schedule_value,
        "keywords": profile.keywords,
        "exclude_keywords": profile.exclude_keywords,
        "sources": profile.sources or [],
        "min_height": profile.min_height,
        "max_height": profile.max_height,
        "aspect_ratio": profile.aspect_ratio,
        "min_duration": profile.min_duration,
        "max_duration": profile.max_duration,
        "max_results": profile.max_results,
        "auto_import": profile.auto_import,
        "batch_prefix": profile.batch_prefix,
        "last_run": profile.last_run.isoformat() if profile.last_run else None,
        "total_runs": profile.total_runs,
        "total_found": profile.total_found,
        "total_imported": profile.total_imported,
        "created_at": profile.created_at.isoformat(),
        "updated_at": profile.updated_at.isoformat()
    }


def _schedule_profile(profile: DiscoveryProfile) -> None:
    """(Re)register the profile's job with the scheduler."""
    scheduler = get_scheduler()
    if profile.schedule_type == "interval":
        interval_seconds = int(profile.schedule_value)
        scheduler.add_interval_job(
            run_discovery_profile,
            job_id=f"profile_{profile.id}",
            seconds=interval_seconds,
            description=f"Discovery: {profile.name}",
            args=(profile.id,)
        )
    elif profile.schedule_type == "cron":
        scheduler.add_cron_job(
            run_discovery_profile,
            job_id=f"profile_{profile.id}",
            cron_expression=profile.schedule_value,
            description=f"Discovery: {profile.name}",
            args=(profile.id,)
        )


@router.get("/discovery/profiles")
async def get_discovery_profiles(db: Session = Depends(get_db)):
    """Get all discovery profiles."""
    profiles = db.query(DiscoveryProfile).order_by(desc(DiscoveryProfile.created_at)).all()
    return {"profiles": [_profile_to_dict(p) for p in profiles]}


@router.get("/discovery/profiles/{profile_id}")
async def get_discovery_profile(profile_id: int, db: Session = Depends(get_db)):
    """Get a specific discovery profile."""
    profile = db.query(DiscoveryProfile).filter(DiscoveryProfile.id == profile_id).first()

    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    return _profile_to_dict(profile)


@router.post("/discovery/profiles")
async def create_discovery_profile(profile_data: DiscoveryProfileCreate, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Create a new discovery profile."""
    # Check if name already exists
    existing = db.query(DiscoveryProfile).filter(DiscoveryProfile.name == profile_data.name).first()
    if existing:
        raise HTTPException(status_code=400, detail="Profile name already exists")

    from ..source_catalog import filter_valid_discovery_sources

    # Create profile
    profile = DiscoveryProfile(
        name=profile_data.name,
        enabled=profile_data.enabled,
        schedule_type=profile_data.schedule_type,
        schedule_value=profile_data.schedule_value,
        keywords=profile_data.keywords,
        exclude_keywords=profile_data.exclude_keywords,
        sources=filter_valid_discovery_sources(profile_data.sources),
        min_height=profile_data.min_height,
        max_height=profile_data.max_height,
        aspect_ratio=profile_data.aspect_ratio,
        min_duration=profile_data.min_duration,
        max_duration=profile_data.max_duration,
        max_results=profile_data.max_results,
        auto_import=profile_data.auto_import,
        batch_prefix=profile_data.batch_prefix
    )

    db.add(profile)
    db.commit()
    db.refresh(profile)

    # Schedule the profile if enabled
    if profile.enabled:
        try:
            _schedule_profile(profile)
        except Exception as e:
            print(f"Failed to schedule new profile: {e}")

    return {"success": True, "profile_id": profile.id}


@router.put("/discovery/profiles/{profile_id}")
async def update_discovery_profile(profile_id: int, profile_data: DiscoveryProfileUpdate, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Update a discovery profile."""
    profile = db.query(DiscoveryProfile).filter(DiscoveryProfile.id == profile_id).first()

    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    # Update fields
    update_data = profile_data.dict(exclude_unset=True)
    if "sources" in update_data and update_data["sources"] is not None:
        from ..source_catalog import filter_valid_discovery_sources
        update_data["sources"] = filter_valid_discovery_sources(update_data["sources"])
    for field, value in update_data.items():
        setattr(profile, field, value)

    profile.updated_at = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    db.commit()

    # Re-schedule the profile
    try:
        get_scheduler().remove_job(f"profile_{profile.id}")
        if profile.enabled:
            _schedule_profile(profile)
    except Exception as e:
        print(f"Failed to re-schedule profile: {e}")

    return {"success": True}


@router.delete("/discovery/profiles/{profile_id}")
async def delete_discovery_profile(profile_id: int, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Delete a discovery profile."""
    profile = db.query(DiscoveryProfile).filter(DiscoveryProfile.id == profile_id).first()

    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    # Remove from scheduler
    try:
        get_scheduler().remove_job(f"profile_{profile.id}")
    except Exception as e:
        print(f"Failed to remove job from scheduler: {e}")

    # Delete notifications
    db.query(DiscoveryNotification).filter(DiscoveryNotification.profile_id == profile_id).delete()

    # Delete profile
    db.delete(profile)
    db.commit()

    return {"success": True}


@router.post("/discovery/profiles/{profile_id}/run")
async def run_profile_now(profile_id: int, background_tasks: BackgroundTasks, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Manually trigger a discovery profile to run now."""
    profile = db.query(DiscoveryProfile).filter(DiscoveryProfile.id == profile_id).first()

    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    # Run in background
    background_tasks.add_task(run_discovery_profile, profile_id)

    return {"success": True, "message": f"Profile '{profile.name}' queued to run"}


@router.post("/discovery/profiles/{profile_id}/toggle")
async def toggle_profile(profile_id: int, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Enable or disable a discovery profile."""
    profile = db.query(DiscoveryProfile).filter(DiscoveryProfile.id == profile_id).first()

    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    profile.enabled = not profile.enabled
    profile.updated_at = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    db.commit()

    # Update scheduler
    try:
        if profile.enabled:
            _schedule_profile(profile)
        else:
            get_scheduler().remove_job(f"profile_{profile.id}")
    except Exception as e:
        print(f"Failed to update scheduler: {e}")

    return {"success": True, "enabled": profile.enabled}


@router.get("/discovery/notifications")
async def get_notifications(unread_only: bool = False, limit: int = 50, db: Session = Depends(get_db)):
    """Get discovery notifications."""
    query = db.query(DiscoveryNotification)

    if unread_only:
        query = query.filter(DiscoveryNotification.read == False)

    notifications = query.order_by(desc(DiscoveryNotification.created_at)).limit(limit).all()

    result = []
    for notif in notifications:
        result.append({
            "id": notif.id,
            "profile_id": notif.profile_id,
            "profile_name": notif.profile_name,
            "type": notif.notification_type,
            "message": notif.message,
            "video_count": notif.video_count,
            "read": notif.read,
            "created_at": notif.created_at.isoformat()
        })

    return {"notifications": result}


@router.post("/discovery/notifications/{notification_id}/read")
async def mark_notification_read(notification_id: int, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Mark a notification as read."""
    notif = db.query(DiscoveryNotification).filter(DiscoveryNotification.id == notification_id).first()

    if not notif:
        raise HTTPException(status_code=404, detail="Notification not found")

    notif.read = True
    db.commit()

    return {"success": True}


@router.post("/discovery/notifications/mark-all-read")
async def mark_all_notifications_read(db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Mark all notifications as read."""
    db.query(DiscoveryNotification).update({"read": True})
    db.commit()

    return {"success": True}
