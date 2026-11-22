"""History of combined Bunkr albums and the cards fetched inside them."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.combined_history import (
    add_to_collection,
    build_share_metadata,
    compute_album_delta,
    get_history,
    list_collections,
    list_history,
    list_watchlist,
    remove_from_collection,
    remove_watchlist_item,
    save,
    sync_fetch_metadata,
    upsert_watchlist_item,
)

router = APIRouter(prefix="/api/v1/discovery-hub/combined-history", tags=["discovery-hub"])


class HistoryAlbum(BaseModel):
    url: str = ""
    title: str = ""
    first_upload_at: str = ""
    last_upload_at: str = ""


class HistorySave(BaseModel):
    id: str = ""
    keyword: str = ""
    title: str = ""
    day: str = ""
    kind: str = "fetch"
    search_state: dict = Field(default_factory=dict)
    source_albums: list[HistoryAlbum] = Field(default_factory=list)
    items: list[dict] = Field(default_factory=list, max_length=20000)


class StashAddRequest(BaseModel):
    collection_id: str = ""
    title: str = "Odložené na neskôr"
    keyword: str = "stash"
    items: list[dict] = Field(default_factory=list, max_length=5000)


class StashRemoveRequest(BaseModel):
    canonical_keys: list[str] = Field(default_factory=list, max_length=5000)


class AlbumDeltaRequest(BaseModel):
    album_url: str
    items: list[dict] = Field(default_factory=list, max_length=20000)
    library_urls: list[str] = Field(default_factory=list, max_length=50000)
    mark_visited: bool = False


class WatchlistUpsertRequest(BaseModel):
    id: str = ""
    kind: str = "creator"
    target: str = ""
    title: str = ""
    surface: str = "discovery"
    reason: str = ""
    filters: dict = Field(default_factory=dict)
    delta_new_count: int = 0
    not_in_library_count: int = 0
    seen_keys: list[str] | None = None


@router.get("")
async def history_list(q: str = "", date: str = ""):
    return {"items": list_history(keyword=q[:200], day=date[:10])}


@router.get("/collections/list")
async def collections_list():
    return {"items": list_collections()}


@router.post("/collections/stash")
async def collections_stash_add(body: StashAddRequest):
    if not body.items:
        raise HTTPException(422, "Odloženie potrebuje aspoň jednu položku")
    return add_to_collection(
        body.items,
        collection_id=body.collection_id,
        title=body.title,
        keyword=body.keyword,
    )


@router.post("/collections/{collection_id}/remove")
async def collections_stash_remove(collection_id: str, body: StashRemoveRequest):
    res = remove_from_collection(collection_id, body.canonical_keys)
    if res is None:
        raise HTTPException(404, "Kolekcia sa nenašla")
    return res


@router.post("/share-meta")
async def share_metadata_build(item: dict):
    return build_share_metadata(item)


@router.post("/album-delta")
async def album_delta_compute(body: AlbumDeltaRequest):
    return compute_album_delta(
        body.album_url,
        body.items,
        library_urls=body.library_urls,
        mark_visited=body.mark_visited,
    )


@router.get("/watchlist/list")
async def watchlist_get():
    return {"items": list_watchlist()}


@router.post("/watchlist/upsert")
async def watchlist_upsert(body: WatchlistUpsertRequest):
    if not body.target and not body.title:
        raise HTTPException(422, "Watchlist položka vyžaduje cieľ alebo názov")
    return upsert_watchlist_item(body.model_dump())


@router.delete("/watchlist/{sub_id}")
async def watchlist_delete(sub_id: str):
    removed = remove_watchlist_item(sub_id)
    if not removed:
        raise HTTPException(404, "Sledovaná položka sa nenašla")
    return {"removed": True, "id": sub_id}


@router.get("/{record_id}")
async def history_get(record_id: str):
    record = get_history(record_id)
    if record is None:
        raise HTTPException(404, "História sa nenašla")
    return record


@router.post("")
async def history_save(body: HistorySave):
    if not body.items:
        raise HTTPException(422, "História potrebuje aspoň jednu kartu")
    entry = body.model_dump()
    summary = save(entry)
    sync_fetch_metadata(entry)
    return summary
