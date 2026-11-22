from fastapi import APIRouter, HTTPException, Depends
from typing import Optional
import asyncio
import httpx
from pydantic import BaseModel
from ..config import config

router = APIRouter(prefix="/api/google", tags=["google_search"])

class SearchRequest(BaseModel):
    query: str
    site: Optional[str] = None
    time_range: Optional[str] = None  # e.g., 'qdr:d' (past 24h), 'qdr:w' (past week)
    safe_search: bool = False
    videos_only: bool = False
    page: int = 1
    num: int = 20
    filter_duplicates: bool = True
    geo_lang: Optional[str] = None

@router.post("/search")
async def perform_google_search(request: SearchRequest):
    if not config.SERPAPI_API_KEY:
        raise HTTPException(status_code=500, detail="SERPAPI_API_KEY nie je nastavený.")

    # Zostavenie vyhľadávacieho dotazu
    q = request.query
    if request.site:
        # Pre hlboké hľadanie na stránke si vynútime inurl alebo site operátor
        q = f"site:{request.site} {q}"

    params = {
        "engine": "google",
        "q": q,
        "api_key": config.SERPAPI_API_KEY,
        "num": request.num,
        "safe": "active" if request.safe_search else "off",
        "start": (request.page - 1) * request.num
    }

    if not request.filter_duplicates:
        params["filter"] = "0"  # Vypnutie skrývania podobných výsledkov

    if request.geo_lang:
        params["gl"] = request.geo_lang
        params["hl"] = request.geo_lang

    if request.videos_only:
        params["tbm"] = "vid"

    if request.time_range:
        params["tbs"] = request.time_range

    # Google deprecated `num` — it returns 10 organic results per request no
    # matter what we ask for. To honour request.num we page through with `start`
    # and stitch the pages together. Each page is one SerpApi credit.
    page_size = 10
    pages_needed = max(1, -(-request.num // page_size))  # ceil
    base_start = (request.page - 1) * request.num

    try:
        async with httpx.AsyncClient() as client:
            async def fetch_page(offset: int) -> dict:
                page_params = {**params, "num": page_size, "start": base_start + offset}
                response = await client.get(
                    "https://serpapi.com/search", params=page_params, timeout=20.0
                )
                response.raise_for_status()
                return response.json()

            pages = await asyncio.gather(
                *(fetch_page(i * page_size) for i in range(pages_needed))
            )

            clean_results = []
            seen_links = set()
            for data in pages:
                for item in data.get("organic_results", []):
                    link = item.get("link")
                    # Overlapping offsets can repeat a result; keep the first.
                    if link and link in seen_links:
                        continue
                    if link:
                        seen_links.add(link)
                    clean_results.append({
                        "title": item.get("title"),
                        "link": link,
                        "snippet": item.get("snippet"),
                        "thumbnail": item.get("thumbnail"),
                        "displayed_link": item.get("displayed_link")
                    })

            clean_results = clean_results[:request.num]

            # Pagination/search info come from the last page we fetched, so
            # has_next reflects whether anything follows the whole batch.
            last = pages[-1] if pages else {}
            has_next = "next" in last.get("serpapi_pagination", {})

            return {
                "results": clean_results,
                "search_information": pages[0].get("search_information", {}) if pages else {},
                "has_next": has_next,
                "current_page": request.page
            }
    except httpx.RequestError as e:
        raise HTTPException(status_code=500, detail=f"Chyba pri volaní SerpApi: {str(e)}")
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=f"SerpApi vrátil chybový kód: {e.response.status_code}")
