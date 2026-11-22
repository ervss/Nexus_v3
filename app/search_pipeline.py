"""Shared search contract for Intake and Quantum: audit every source before limiting."""
from __future__ import annotations

import asyncio
import re
import unicodedata
from collections import Counter
from weakref import WeakKeyDictionary

from .orientation import classify, confirmed_orientation, orientation_score, probe_orientation
from .source_catalog import DISCOVERY_SOURCE_OPTIONS, normalize_search_source_key


# Intake and Quantum share one event loop in the server. Bound their combined
# source traffic, including multiple browser searches running at once.
_source_gates = WeakKeyDictionary()


def source_gate() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    gate = _source_gates.get(loop)
    if gate is None:
        gate = asyncio.Semaphore(6)
        _source_gates[loop] = gate
    return gate


def quality_height(item: dict) -> int:
    try:
        height = int(item.get("height") or 0)
        width = int(item.get("width") or 0)
    except (TypeError, ValueError):
        height = width = 0
    if height > 0:
        # Kvalita sa riadi KRATŠOU stranou: 720x1280 vertikálne video je 720p, nie 1280p.
        return min(width, height) if width > 0 else height
    label = str(item.get("quality") or "").lower()
    if re.search(r"\b(?:4k|uhd)\b", label):
        return 2160
    match = re.search(r"\b(4320|2160|1440|1080|720|576|480|360|240)p?\b", label)
    return int(match[1]) if match else 0


def classify_orientation(item: dict) -> tuple[str, str]:
    """Iba potvrdená orientácia (rozmery / metadata zdroja); odhady rieši `classify`."""
    return confirmed_orientation(item)


def query_contract(query: str, minimum: int = 0) -> tuple[str, int]:
    inferred = max((quality_height({"quality": token}) for token in query.split()), default=0)
    cleaned = re.sub(r"\b(?:4k|uhd|fhd|hd|4320p|2160p|1440p|1080p|720p|480p)\b", "", query, flags=re.I)
    return " ".join(cleaned.split()), max(0, minimum or inferred)


def normalized_words(value) -> list[str]:
    text = unicodedata.normalize("NFKD", str(value or "")).lower()
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.findall(r"[^\W_]+", text, flags=re.UNICODE)


def matches_query(item: dict, query: str) -> bool:
    terms = normalized_words(query)
    if not terms:
        return True
    fields = ("title", "description", "tags", "categories", "performers", "actors",
              "models", "creator", "uploader", "username", "author", "channel")
    words = set(normalized_words(" ".join(str(item.get(field) or "") for field in fields)))
    return all(term in words for term in terms)


def fair_limit(groups: dict[str, list], limit: int) -> list:
    """Each nonempty selected source gets a turn, with URL deduplication."""
    output, seen = [], set()
    for index in range(max((len(rows) for rows in groups.values()), default=0)):
        for rows in groups.values():
            if index >= len(rows):
                continue
            item = rows[index]
            url = str(item.get("url") or "").split("#")[0].rstrip("/")
            if not url or url in seen:
                continue
            seen.add(url)
            output.append(item)
            if len(output) >= limit:
                return output
    return output


async def enrich_unknown_quality(items: list[dict]) -> dict:
    from .meta_enrichment import get_enrichment_service
    return await get_enrichment_service().enrich_urls(
        [item["url"] for item in items], total_timeout_s=12.0)


async def search_catalog(engine, query: str, sources: list[str] | None, *,
                         min_quality: int = 0, min_duration: int = 0,
                         per_source_limit: int = 20, total_limit: int = 100,
                         enrich_unknown: bool = True, mode: int = 1,
                         orientation: str = "any", orientation_probe: int = 24,
                         quick: bool = False) -> dict:
    cleaned, minimum = query_contract(query, min_quality)
    orientation = orientation if orientation in {"portrait", "landscape"} else "any"
    portrait = orientation == "portrait"
    orientation_probe = max(0, min(orientation_probe, 60))

    def rank_key(row):
        base = row["quantum_v2_rank"] if mode == 2 else ()
        return ((orientation_score(row),) if portrait else ()) + tuple(base)

    if mode == 2:
        from .quantum_search_v2 import compile_rank, concepts, variants
        score = compile_rank(cleaned or query)
        concept_count = len(concepts(cleaned or query))
    labels = {s["id"]: s.get("label", s["id"]) for s in DISCOVERY_SOURCE_OPTIONS if s.get("has_search")}
    requested = list(dict.fromkeys(sources if sources is not None else labels))
    keys, diagnostics = [], []
    for raw in requested:
        key = normalize_search_source_key(raw)
        if key and key not in keys:
            keys.append(key)
        elif not key:
            diagnostics.append({"source_key": raw, "label": raw, "status": "unsupported",
                                "raw_count": 0, "count": 0, "shown_count": 0,
                                "error": "Tento zdroj podporuje iba import URL, nie vyhľadávanie."})
    per_source_limit = max(1, min(per_source_limit, 200))
    total_limit = max(1, min(total_limit, 2000))
    # The fetch allowance belongs to EACH source. No global cut before filters.
    fetch_limit = min(200, max(60, per_source_limit * (4 if minimum else 2)))
    gate = source_gate()

    async def one(key):
        async with gate:
            try:
                async def fetch(search_query):
                    return await engine.search_sources(
                        search_query, [key], result_limit=fetch_limit,
                        per_source_limit=fetch_limit, global_limit=2000,
                        return_diagnostics=True, trace_filters=True,
                        enrich=False, search_depth=1 if quick else 2, preserve_partial=True,
                        strict_query=mode != 2, min_quality=minimum,
                        **({"expand_variants": False} if quick else {}),
                    )
                base_query = cleaned or query
                queries = variants(base_query) if mode == 2 and not quick else [base_query]
                if portrait and not quick and not re.search(r"vertic|portrait", base_query, re.I):
                    # Jeden extra dopyt navyše: zdroj sám vráti tie, čo majú "vertical" v texte.
                    queries.append(f"{base_query} vertical")
                # Vlna 1: Spustíme najprv pôvodný dotaz. Ďalšie varianty spúšťame len podľa pokrytia a časového rozpočtu.
                t_wave1 = asyncio.get_running_loop().time()
                first_payload = await fetch(queries[0])
                good = [first_payload] if isinstance(first_payload, dict) else []
                first_rows = (first_payload.get("results") or []) if isinstance(first_payload, dict) else []
                elapsed_wave1 = asyncio.get_running_loop().time() - t_wave1
                full_cov_hits = (
                    sum(1 for r in first_rows if isinstance(r, dict) and r.get("url") and score(r)[0])
                    if mode == 2 else len(first_rows)
                )
                need_more_variants = (
                    len(queries) > 1
                    and elapsed_wave1 < 4.5
                    and (full_cov_hits < max(6, per_source_limit // 2) or (portrait and len(first_rows) < per_source_limit))
                )
                if need_more_variants:
                    rem_budget = max(1.5, 6.5 - elapsed_wave1)
                    try:
                        extra_payloads = await asyncio.wait_for(
                            asyncio.gather(*(fetch(v) for v in queries[1:]), return_exceptions=True),
                            timeout=rem_budget,
                        )
                        good.extend(p for p in extra_payloads if isinstance(p, dict))
                    except asyncio.TimeoutError:
                        pass
                payload = dict(good[0], results=[r for p in good for r in p.get("results", [])])
            except Exception as exc:
                return key, [], {"source_key": key, "label": labels.get(key, key),
                                 "status": "error", "raw_count": 0, "count": 0,
                                 "error": f"{type(exc).__name__}: {exc}"}
            rows = payload.get("results") or []
            diag = next((dict(d) for d in payload.get("diagnostics", []) if d.get("source_key") == key), {})
            diag.update(source_key=key, label=labels.get(key, key),
                        raw_count=diag.get("raw_count", len(rows)),
                        query_filtered=diag.get("query_filtered", 0), quality_low=0, quality_unknown=0,
                        duration_filtered=0, metadata_checked=0, metadata_unchecked=0,
                        orientation_filtered=0, orientation_unknown=0, orientation_probed=0)
            relevant, seen = [], set()
            for raw in rows:
                if not isinstance(raw, dict) or not raw.get("url") or raw["url"] in seen:
                    continue
                seen.add(raw["url"])
                ranking = score(raw) if mode == 2 else None
                if (ranking[1] == 0 if ranking is not None else not matches_query(raw, cleaned)):
                    diag["query_filtered"] += 1
                    continue
                row = dict(raw, source_key=key, source=labels.get(key, raw.get("source", key)))
                if ranking is not None:
                    row["quantum_v2_rank"] = ranking
                    row["quantum_v2_coverage"] = f"{ranking[1]}/{concept_count}"
                relevant.append(row)
            unknown = [row for row in relevant if not quality_height(row)] if minimum else []
            # Bounded, visible metadata work; unchecked candidates stay unknown.
            async def enrich_quality():
                if not (unknown and enrich_unknown):
                    return
                targets = unknown[:8]
                diag["metadata_checked"] = len(targets)
                diag["metadata_unchecked"] = max(0, len(unknown) - len(targets))
                try:
                    enriched = await enrich_unknown_quality(targets)
                    for row in targets:
                        patch = enriched.get(row["url"]) or {}
                        if quality_height(patch):
                            row.update({k: v for k, v in patch.items() if k in {"height", "quality", "width", "duration", "thumbnail"} and v})
                            row["quality_evidence"] = "detail_metadata"
                except Exception as exc:
                    diag["metadata_error"] = type(exc).__name__

            async def probe_orientations():
                # Vertikálne vyhľadávanie: rozmery sa zisťujú aktívne, nie hádaním z náhľadu.
                if not (portrait and enrich_unknown and orientation_probe):
                    return
                pending = []
                for row in relevant:
                    info = classify(row)
                    if info["orientation"] == "unknown":
                        pending.append((0 if info["likely"] else 1, len(pending), row))
                pending.sort(key=lambda entry: entry[:2])
                targets = [row for _, _, row in pending[:orientation_probe]]
                if not targets:
                    return
                diag["orientation_probed"] = len(targets)
                try:
                    patches = await probe_orientation([row["url"] for row in targets],
                                                      timeout_s=5.0, max_urls=orientation_probe)
                except Exception as exc:
                    diag["orientation_error"] = type(exc).__name__
                    return
                for row in targets:
                    patch = {k: v for k, v in (patches.get(row["url"]) or {}).items() if v}
                    if not patch:
                        continue
                    if not patch.get("width"):
                        patch.pop("height", None)  # výška bez šírky nie je dôkaz orientácie
                    row.update(patch)

            await asyncio.gather(enrich_quality(), probe_orientations())
            accepted = []
            for row in relevant:
                height = quality_height(row)
                if mode == 2:
                    ranking = row["quantum_v2_rank"]
                    row["quantum_v2_rank"] = (*ranking[:4], height, ranking[5])
                row["quality_height"] = height
                row.setdefault("quality_evidence", "dimensions" if row.get("height") else
                               ("source_badge" if height else "unknown"))
                info = classify(row)
                row["orientation"], row["orientation_evidence"] = info["orientation"], info["evidence"]
                row["orientation_likely"], row["orientation_confidence"] = info["likely"], info["confidence"]
                # Nič sa tu nezahadzuje: neznáme/landscape výsledky ostávajú, aby sa nestratili
                # videá, ktoré detekcia nezachytila. Filtruje až UI; backend len radí.
                if info["orientation"] == "unknown" and info["likely"] != "portrait":
                    diag["orientation_unknown"] += 1
                elif info["orientation"] == "landscape":
                    diag["orientation_filtered"] += 1  # len štatistika: potvrdené landscape
                if minimum and height < minimum:
                    diag["quality_low" if height else "quality_unknown"] += 1
                    continue
                if min_duration:
                    duration = engine._score_result(row, "")[2]
                    if duration < min_duration:
                        diag["duration_filtered"] += 1
                        continue
                accepted.append(row)
            if mode == 2:
                accepted = sorted(accepted, key=rank_key, reverse=True)
            else:
                accepted = engine._sort_by_relevance(accepted, cleaned or query)
                if portrait:
                    accepted = sorted(accepted, key=orientation_score, reverse=True)  # stabilné
            diag["matched_count"] = len(accepted)
            diag["per_source_limited"] = max(0, len(accepted) - per_source_limit)
            diag["count"] = min(len(accepted), per_source_limit)
            diag.setdefault("status", "ok" if rows else "empty")
            if diag["raw_count"] and not accepted and diag["status"] not in {"timeout", "error", "partial_timeout"}:
                diag["status"] = "filtered"
            return key, accepted[:per_source_limit], diag

    batches = await asyncio.gather(*(one(key) for key in keys))
    groups = {key: rows for key, rows, _ in batches}
    diagnostics.extend(diag for _, _, diag in batches)
    results = (sorted((row for rows in groups.values() for row in rows),
                      key=rank_key, reverse=True)[:total_limit]
               if mode == 2 else fair_limit(groups, total_limit))
    shown = Counter(row["source_key"] for row in results)
    for diag in diagnostics:
        diag["shown_count"] = shown[diag["source_key"]]
        diag["total_limited"] = max(0, diag["count"] - diag["shown_count"])
    return {"results": results, "diagnostics": diagnostics, "query": cleaned or query,
            "min_quality": minimum, "orientation": orientation, "requested_sources": requested, "searched_sources": keys,
            "source_breakdown": dict(shown), "per_source_limit": per_source_limit,
            "total_limit": total_limit, "matched_total": sum(d.get("matched_count", 0) for d in diagnostics)}
