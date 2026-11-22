"""
HTML page routes + session login/logout (A5 — extracted from main.py).
"""
import hashlib

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel

from ..config import config
from ..templating import templates

router = APIRouter(tags=["pages"])


@router.get("/login", response_class=HTMLResponse)
async def login_form(request: Request):
    return templates.TemplateResponse(request=request, name="login.html")


class LoginRequest(BaseModel):
    password: str


@router.post("/login")
async def login_submit(request: Request, login_request: LoginRequest):
    # Simple SHA-256 hash comparison for better security than plain equality
    provided_hash = hashlib.sha256(login_request.password.encode()).hexdigest()
    target_hash = hashlib.sha256(config.DASHBOARD_PASSWORD.encode()).hexdigest()

    if provided_hash == target_hash:
        request.session["authenticated"] = True
        return Response(status_code=200)
    raise HTTPException(status_code=401, detail="Invalid password")


@router.get("/logout")
async def logout(request: Request):
    request.session.pop("authenticated", None)
    return RedirectResponse(url="/login")


def _page(request: Request, name: str, **context):
    if not request.session.get("authenticated"):
        hub_entry = request.query_params.get("mega_hub", "")
        login_url = f"/login?mega_hub={hub_entry}" if hub_entry.isascii() and hub_entry.isdecimal() else "/login"
        return RedirectResponse(url=login_url, status_code=303)
    response = templates.TemplateResponse(request=request, name=name, context=context)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


@router.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return _page(request, "index.html", ui_variant="classic")


@router.get("/bunker", response_class=HTMLResponse)
async def bunker_shortcut(request: Request):
    return _page(request, "index.html", ui_variant="classic")


@router.get("/discovery-hub", response_class=HTMLResponse)
async def discovery_hub_shortcut(request: Request):
    return _page(request, "index.html", ui_variant="classic")


@router.get("/discovery", response_class=HTMLResponse)
async def discovery_page(request: Request):
    return _page(request, "discovery.html")


@router.get("/vk-discovery", response_class=HTMLResponse)
async def vk_discovery_page(request: Request):
    return _page(request, "vk_discovery.html")


@router.get("/sxyprn", response_class=HTMLResponse)
async def sxyprn_discovery_page(request: Request):
    return _page(request, "sxyprn_discovery.html")


@router.get("/eporner", response_class=HTMLResponse)
async def eporner_discovery_page(request: Request):
    return _page(request, "eporner_discovery.html")


@router.get("/forum", response_class=HTMLResponse)
async def forum_hub_page(request: Request):
    return _page(request, "forum_hub.html")


@router.get("/forum/groups", response_class=HTMLResponse)
async def forum_groups_page(request: Request):
    return _page(request, "forum_groups.html")


@router.get("/forum/new", response_class=HTMLResponse)
async def forum_v2_page(request: Request):
    return _page(request, "forum_v2.html")


@router.get("/hub/new", response_class=HTMLResponse)
async def hub_v2_page(request: Request):
    return _page(request, "hub_v2.html")


@router.get("/vault", response_class=HTMLResponse)
async def vault_page(request: Request):
    """Unified local search across library, Telegram index, forum links, Filester, MEGA, and queue."""
    return _page(request, "vault.html")


@router.get("/studio", response_class=HTMLResponse)
async def studio_page(request: Request):
    """Nexus Studio — the moment layer (wall / reel / cutter / what's new)."""
    return _page(request, "studio.html")


@router.get("/faphouse", response_class=HTMLResponse)
async def faphouse_page(request: Request):
    """Standalone Faphouse experience — its own page, not a Fusion Hub tab."""
    return _page(request, "faphouse.html")


@router.get("/dashboard-preview", response_class=HTMLResponse)
async def dashboard_preview_page(request: Request):
    """Standalone visual preview; it does not change Forum Hub data."""
    return _page(request, "dashboard_preview.html")


@router.get("/gallery-preview", response_class=HTMLResponse)
async def gallery_preview_page(request: Request):
    """Standalone modern gallery concept; it does not modify the library."""
    return _page(request, "gallery_preview.html")


@router.get("/discovery/review/{profile_id}", response_class=HTMLResponse)
async def discovery_review_page(request: Request, profile_id: int):
    return _page(request, "discovery_review.html", profile_id=profile_id)


@router.get("/google-hub", response_class=HTMLResponse)
async def google_hub_page(request: Request):
    return _page(request, "google_hub.html")


@router.get("/torrents", response_class=HTMLResponse)
async def torrents_page(request: Request):
    """Search, queue and stream torrents through Jackett and qBittorrent."""
    return _page(request, "torrents.html")


@router.get("/filester-radar", response_class=HTMLResponse)
async def filester_radar_page(request: Request):
    """Review-first discovery surface for public, indexed Filester folders."""
    return _page(request, "filester_radar.html")


@router.get("/v2", response_class=HTMLResponse)
async def read_v2(request: Request):
    # This route can be used to directly preview the V2 UI
    return _page(request, "index.html", ui_variant="classic")


@router.get("/multiview", response_class=HTMLResponse)
async def read_multiview(request: Request):
    return _page(request, "multiview.html")


@router.get("/v1", response_class=HTMLResponse)
async def read_v1(request: Request):
    return _page(request, "index.html", ui_variant="classic")


@router.get("/v1/intake")
async def read_v1_intake():
    """UI stránka Intake bola odstránená; API /api/v1/intake/* ostáva aktívne na pozadí."""
    return RedirectResponse(url="/", status_code=302)


@router.get("/stats", response_class=HTMLResponse)
def get_stats_page(request: Request):
    if not request.session.get("authenticated"):
        return RedirectResponse(url="/login", status_code=303)
    from ..library_insights import read_library_insights
    return _page(request, "stats.html", library_insights=read_library_insights())


@router.get("/tester", response_class=HTMLResponse)
async def link_tester_page(request: Request):
    return _page(request, "tester.html")


@router.get("/sources-test", response_class=HTMLResponse)
async def sources_test_page(request: Request):
    """Interaktívny testovací zoznam všetkých podporovaných webov a DB ukážok."""
    return _page(request, "sources_test.html")


@router.get("/favicon.ico")
def favicon():
    return Response(status_code=204)
