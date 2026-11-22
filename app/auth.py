"""Shared session-auth dependency (extracted from main.py during A5 split)."""
from fastapi import HTTPException, Request


def check_auth(request: Request):
    """Dependency to check if user is authenticated via session."""
    if not request.session.get("authenticated"):
        raise HTTPException(status_code=401, detail="Not authenticated")
    return True
