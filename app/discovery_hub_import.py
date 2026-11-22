"""Expand Discovery Hub cards before opening a database transaction."""
import asyncio
from urllib.parse import urlsplit

from .extractors.bunkr import BunkrExtractor
from .intake import IntakeCandidate, IntakeImportRequest
from .ntc.bunkr_scheduler import is_bunkr_host


async def build_import_request(item: dict) -> IntakeImportRequest:
    url = str((item.get("import_plan") or {}).get("url") or item.get("url") or "").strip()
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not is_bunkr_host(parsed.hostname or ""):
        raise ValueError("Import vyžaduje platnú Bunkr stránku albumu alebo súboru.")
    is_album = parsed.path.startswith(("/a/", "/album/", "/albums/"))
    if is_album:
        async with asyncio.timeout(30):
            rows = await BunkrExtractor().extract_album(url, listing_only=True)
        if not rows:
            raise ValueError("Album nevrátil žiadne súbory; import nebol vytvorený.")
        if len(rows) > 10000:
            raise ValueError("Album je príliš veľký; vyber konkrétne súbory v prehliadači albumu.")
    else:
        rows = [item]
    candidates = []
    for row in rows:
        file_url = str(row.get("url") or "").strip()
        if not file_url.startswith(("http://", "https://")):
            continue
        candidates.append(IntakeCandidate(
            url=file_url, source_url=file_url,
            title=row.get("title") or row.get("name") or "Bunkr file",
            thumbnail=row.get("thumbnail") or row.get("thumb") or "",
            duration=float(row.get("duration") or 0), height=int(row.get("height") or 0),
            width=int(row.get("width") or 0),
            file_size_mb=float(row.get("size_bytes") or 0) / (1024 * 1024),
            tags=[str(item.get("title") or "")] if item.get("title") else [], source="bunkr",
        ))
    if not candidates:
        raise ValueError("Nie sú dostupné žiadne importovateľné súbory.")
    return IntakeImportRequest(candidates=candidates, batch_name="Discovery Hub", source_mode="bunkr")
