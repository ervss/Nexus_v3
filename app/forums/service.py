"""Forum Hub service layer: poll boards, persist posts/links, never auto-import.

Everything here stops at `status="new"`. Resolving and importing are explicit
user actions driven from the gallery — no link is ever downloaded on a refresh.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any, Callable, Optional

from sqlalchemy.orm import Session

from ..database import ForumLink, ForumPost, ForumSavedQuery, ForumTag, ForumThread, utcnow
from .boards import Board, get_board
from .client import ForumAuthError, ForumChallengeError, ForumClient, ForumRateLimitError, cooldown_remaining
from .parser import (
    SUPPORTED_PLATFORMS,
    next_page_url,
    parse_posts,
    parse_tag_cloud,
    parse_thread_list,
    prev_page_url,
)

logger = logging.getLogger(__name__)

#: Never walk more than this many pages backwards in one thread refresh.
MAX_PAGES_PER_THREAD = 20
#: Cap how many threads a single tag query will open.
MAX_THREADS_PER_QUERY = 100
MAX_WATCHLIST_PAGES = 10


def _post_num(post_id: str) -> int:
    return int(post_id) if str(post_id).isdigit() else 0


# ─── ingestion ────────────────────────────────────────────────────────────────

async def _fetch_new_posts(
    client: ForumClient,
    thread_url: str,
    last_seen_post_id: str = "",
    since: Optional[datetime] = None,
    max_pages: int = MAX_PAGES_PER_THREAD,
    start_url: str = "",
    apply_post_cutoff: bool = True,
) -> tuple[list[dict[str, Any]], bool, str]:
    """Walk a thread backwards from its newest page, collecting posts we haven't ingested.

    `/threads/<slug>/latest` lands on the last page in one request, so a 95-page
    thread costs one fetch when only its tail changed.
    """
    base = client.board.base_url
    cutoff = _post_num(last_seen_post_id) if apply_post_cutoff else 0
    collected: dict[str, dict[str, Any]] = {}

    url = start_url or thread_url.rstrip("/") + "/latest"
    remaining_url = url
    for _ in range(max_pages):
        html = await client.get(remaining_url)
        posts = parse_posts(html, base)
        if not posts:
            remaining_url = ""
            break

        fresh = [
            p for p in posts
            if _post_num(p["post_id"]) > cutoff
            and (since is None or p["posted_at"] is None or p["posted_at"] >= since)
        ]
        for post in fresh:
            collected.setdefault(post["post_id"], post)

        # Stop as soon as this page contains something we've already seen (or is
        # older than the window) — everything further back is older still.
        exhausted = len(fresh) < len(posts)
        if exhausted:
            remaining_url = ""
            break

        remaining_url = prev_page_url(html, base)
        if not remaining_url:
            break

    truncated = bool(remaining_url)
    return sorted(collected.values(), key=lambda p: _post_num(p["post_id"])), truncated, remaining_url if truncated else ""


async def _fetch_thread_posts(
    client: ForumClient,
    thread_url: str,
    last_seen_post_id: str,
    scan_cursor_url: str,
    since: Optional[datetime],
) -> tuple[list[dict[str, Any]], bool, str]:
    """Fetch new tail posts and resume any capped historical backfill."""
    if not scan_cursor_url:
        return await _fetch_new_posts(
            client, thread_url, last_seen_post_id, since=since,
        )

    posts, _, _ = await _fetch_new_posts(
        client, thread_url, last_seen_post_id, since=since,
    )
    older_posts, truncated, next_cursor = await _fetch_new_posts(
        client, thread_url, since=since, start_url=scan_cursor_url, apply_post_cutoff=False,
    )
    by_id = {post["post_id"]: post for post in posts}
    by_id.update({post["post_id"]: post for post in older_posts})
    return sorted(by_id.values(), key=lambda post: _post_num(post["post_id"])), truncated, next_cursor


def _persist_posts(
    db: Session,
    thread: ForumThread,
    posts: list[dict[str, Any]],
    platforms: Optional[list[str]] = None,
) -> int:
    """Write posts + their links. Returns the number of genuinely new links."""
    allowed = set(platforms or SUPPORTED_PLATFORMS)
    new_links = 0

    for post in posts:
        row = (
            db.query(ForumPost)
            .filter(ForumPost.thread_id == thread.id, ForumPost.post_id == post["post_id"])
            .first()
        )
        if row is None:
            row = ForumPost(
                thread_id=thread.id,
                post_id=post["post_id"],
                permalink=post["permalink"],
                author=post["author"],
                posted_at=post["posted_at"],
                body_text=post["body_text"],
                hashtags=post["hashtags"],
            )
            db.add(row)
            db.flush()

        usable = [l for l in post["links"] if l["platform"] in allowed]
        for link in usable:
            if db.query(ForumLink).filter(ForumLink.url == link["url"]).first():
                continue
            db.add(ForumLink(
                thread_id=thread.id,
                post_id=row.id,
                url=link["url"],
                platform=link["platform"],
                link_type=link["link_type"],
                title=link["title"],
                thumbnail=link["thumbnail"],
                quality=link["quality"],
                duration=link["duration"],
                size_bytes=link["size_bytes"],
                tags=link["tags"],
                author=post["author"],
                posted_at=post["posted_at"],
                status="new",
            ))
            # Session is autoflush=False — without this, the SAME url appearing
            # twice in one batch (a re-quoted link, or two posts sharing a
            # link) would pass the duplicate check above twice before either
            # row is visible to it, and the second insert hits ForumLink.url's
            # UNIQUE constraint at flush time, rolling back the whole batch.
            db.flush()
            new_links += 1

        if _post_num(post["post_id"]) > _post_num(thread.last_seen_post_id):
            thread.last_seen_post_id = post["post_id"]
            if post["posted_at"]:
                thread.last_post_at = post["posted_at"]

    thread.last_checked_at = utcnow()
    return new_links


#: Skip a thread we already opened this recently unless the listing shows a newer post.
FRESH_CHECK_MINUTES = 15


def _thread_needs_fetch(row: Optional[ForumThread], data: dict[str, Any]) -> bool:
    """False when this listing row cannot have new posts since we last looked."""
    if row is None:
        return True
    if getattr(row, "scan_cursor_url", ""):
        return True
    if not row.last_checked_at:
        return True
    age = utcnow() - row.last_checked_at
    if age > timedelta(minutes=FRESH_CHECK_MINUTES):
        return True
    listed_at = data.get("last_post_at")
    if listed_at is None:
        return True
    if row.last_post_at and listed_at <= row.last_post_at:
        return False
    if not row.last_post_at:
        return True
    return listed_at > row.last_post_at


def _last_seen(db: Session, url: str) -> str:
    """Read-only peek, so we never hold a write transaction across network I/O."""
    row = db.query(ForumThread.last_seen_post_id).filter(ForumThread.url == url).first()
    return (row[0] or "") if row else ""


def _row_for_url(db: Session, url: str) -> Optional[ForumThread]:
    return db.query(ForumThread).filter(ForumThread.url == url).first()


def _upsert_thread(db: Session, board: Board, data: dict[str, Any], origin: str,
                   discovered_via: str = "") -> ForumThread:
    thread = db.query(ForumThread).filter(ForumThread.url == data["url"]).first()
    if thread is None:
        thread = ForumThread(
            board=board.key,
            url=data["url"],
            title=data.get("title") or data.get("slug") or "Thread",
            slug=data.get("slug") or "",
            origin=origin,
            discovered_via=discovered_via,
            tags=data.get("tags") or [],
        )
        db.add(thread)
        db.flush()
    else:
        if data.get("title"):
            thread.title = data["title"]
        # A tag-discovered thread that later shows up in the watchlist is a watched thread.
        if origin == "watched":
            thread.origin = "watched"
        elif discovered_via:
            # The same thread can surface from several tag channels; keep all of them,
            # otherwise the badge keeps naming whichever tag found it first.
            known = [v.strip() for v in (thread.discovered_via or "").split(",") if v.strip()]
            if discovered_via not in known:
                known.append(discovered_via)
            thread.discovered_via = ", ".join(known)
    if data.get("last_post_at"):
        thread.last_post_at = data["last_post_at"]
    return thread


# ─── public operations ────────────────────────────────────────────────────────

async def sync_watchlist(
    db: Session, board_key: str, unread_only: bool = False, client: Optional[ForumClient] = None,
    progress: Optional[Callable[[dict[str, Any]], None]] = None,
) -> dict[str, Any]:
    """Pull the paginated watchlist and ingest new posts from every changed thread."""
    board = get_board(board_key)
    own_client = client is None
    client = client or ForumClient(board)
    try:
        params = {"unread_only": "1"} if unread_only else None
        html = await client.get(board.watched_url, params=params)
        listed = []
        seen_urls: set[str] = set()
        pages = 0
        following_page = ""
        while html and pages < MAX_WATCHLIST_PAGES:
            pages += 1
            page_rows = parse_thread_list(html, board.base_url)
            new_rows = [row for row in page_rows if row["url"] not in seen_urls]
            if not new_rows:
                following_page = ""
                break
            listed.extend(new_rows)
            seen_urls.update(row["url"] for row in new_rows)
            following_page = next_page_url(html, board.base_url)
            if not following_page:
                break
            if pages < MAX_WATCHLIST_PAGES:
                html = await client.get(following_page)

        threads_touched, links_found, skipped = 0, 0, 0
        errors: list[str] = []
        threads_truncated = len(listed) > MAX_THREADS_PER_QUERY
        if threads_truncated:
            errors.append(
                f"Watchlist má {len(listed)} vlákien; spracuje sa najviac "
                f"{MAX_THREADS_PER_QUERY} na jeden beh. Ostatné sa preveria pri ďalšom behu."
            )
        if following_page and pages >= MAX_WATCHLIST_PAGES:
            errors.append(
                f"Zoznam vlákien presiahol limit {MAX_WATCHLIST_PAGES} strán; "
                "výsledok je čiastočný."
            )

        existing_by_url = {
            row.url: row for row in db.query(ForumThread)
            .filter(ForumThread.url.in_([data["url"] for data in listed])).all()
        } if listed else {}

        listed.sort(key=lambda data: (
            existing_by_url[data["url"]].last_checked_at
            if data["url"] in existing_by_url and existing_by_url[data["url"]].last_checked_at
            else datetime.min
        ))
        candidates = listed[:MAX_THREADS_PER_QUERY]
        checked = 0
        if progress:
            progress({
                "phase": "watchlist",
                "board": board.key,
                "completed": 0,
                "total": len(candidates),
                "message": f"{board.label}: pripravených {len(candidates)} vlákien.",
            })
        for data in candidates:
            existing = existing_by_url.get(data["url"])
            if not _thread_needs_fetch(existing, data):
                skipped += 1
                checked += 1
                if progress:
                    progress({
                        "phase": "watchlist", "board": board.key,
                        "completed": checked, "total": len(candidates),
                        "new_links": links_found, "skipped": skipped,
                        "message": f"{board.label}: vlákno {checked}/{len(candidates)} "
                                   f"preskočené ako nezmenené.",
                    })
                continue
            try:
                last_seen = existing.last_seen_post_id if existing else ""
                posts, scan_truncated, next_cursor = await _fetch_thread_posts(
                    client,
                    data["url"],
                    last_seen,
                    existing.scan_cursor_url if existing else "",
                    since=(
                        utcnow() - timedelta(days=90)
                        if not last_seen or (existing and existing.scan_cursor_url)
                        else None
                    ),
                )
                if scan_truncated:
                    errors.append(
                        f"{data.get('title') or data['url']}: skenovanie narazilo na limit "
                        f"{MAX_PAGES_PER_THREAD} strán; kontrola je neúplná."
                    )
            except ForumAuthError:
                raise
            except ForumChallengeError:
                raise
            except ForumRateLimitError:
                raise
            except Exception as exc:  # noqa: BLE001 — one bad thread must not kill the refresh
                logger.warning("[ForumHub] %s failed: %s", data["url"], exc)
                errors.append(f"{data.get('title') or data['url']}: {exc}")
                checked += 1
                if progress:
                    progress({
                        "phase": "watchlist", "board": board.key,
                        "completed": checked, "total": len(candidates),
                        "new_links": links_found, "skipped": skipped,
                        "message": f"{board.label}: chyba vo vlákne {checked}/{len(candidates)} "
                                   f"({data.get('title') or 'bez názvu'}).",
                    })
                continue

            try:
                thread = _upsert_thread(db, board, data, origin="watched")
                found = _persist_posts(db, thread, posts)
                thread.scan_cursor_url = next_cursor
                db.flush()
                thread.unread_count = (
                    db.query(ForumLink)
                    .filter(ForumLink.thread_id == thread.id, ForumLink.status == "new")
                    .count()
                )
                db.commit()
            except Exception as exc:  # noqa: BLE001
                db.rollback()
                logger.warning("[ForumHub] %s failed to persist: %s", data["url"], exc)
                errors.append(f"{data.get('title') or data['url']}: {exc}")
                checked += 1
                if progress:
                    progress({
                        "phase": "watchlist", "board": board.key,
                        "completed": checked, "total": len(candidates),
                        "new_links": links_found, "skipped": skipped,
                        "message": f"{board.label}: chyba pri ukladaní vlákna "
                                   f"{checked}/{len(candidates)}.",
                    })
                continue
            links_found += found
            if found:
                threads_touched += 1
            checked += 1
            if progress:
                progress({
                    "phase": "watchlist", "board": board.key,
                    "completed": checked, "total": len(candidates),
                    "new_links": links_found, "skipped": skipped,
                    "message": f"{board.label}: vlákno {checked}/{len(candidates)}, "
                               f"{links_found} nových odkazov.",
                })

        return {
            "board": board.key,
            "threads_listed": len(listed),
            "threads_checked": min(len(listed), MAX_THREADS_PER_QUERY),
            "threads_skipped": skipped,
            "threads_with_new": threads_touched,
            "new_links": links_found,
            "errors": errors,
            "partial": bool(errors),
        }
    finally:
        if own_client:
            await client.aclose()


async def _threads_for_tags(client: ForumClient, tags: list[str], max_pages: int = 2) -> list[dict[str, Any]]:
    """One tag -> /tags/<tag>/ (walked `max_pages` deep). Several -> tag search, which ANDs them.

    The tag listing sorts by last activity, not upload date, so a thread that
    got one fresh video post but is otherwise quiet can sit past page 1 even
    though it belongs in this month's window — walking a couple more pages
    catches those without pulling in anything the `since` filter won't already
    drop back in discover_by_tags.
    """
    board = client.board
    if len(tags) == 1:
        slug = tags[0].strip().lower().replace(" ", "-")
        out: list[dict[str, Any]] = []
        seen_urls: set[str] = set()
        for page in range(1, max(1, max_pages) + 1):
            url = f"{board.base_url}/tags/{slug}/" if page == 1 else f"{board.base_url}/tags/{slug}/page-{page}"
            html = await client.get(url)
            rows = parse_thread_list(html, board.base_url)
            if not rows:
                break
            new_rows = [r for r in rows if r["url"] not in seen_urls]
            if not new_rows:
                break
            seen_urls.update(r["url"] for r in new_rows)
            out.extend(new_rows)
        return out

    params = {
        "keywords": "",
        "c[tags]": ",".join(tags),
        "c[title_only]": "0",
        "o": "date",
    }
    html = await client.get(board.search_url, params=params)
    return parse_thread_list(html, board.base_url)


async def discover_by_tags(
    db: Session,
    board_key: str,
    tags: list[str],
    window_days: int = 7,
    platforms: Optional[list[str]] = None,
    discovered_via: str = "",
    tag_pages: int = 1,
    client: Optional[ForumClient] = None,
    progress: Optional[Callable[[dict[str, Any]], None]] = None,
) -> dict[str, Any]:
    """Find threads carrying these tags, ingest only recent posts that hold media links."""
    board = get_board(board_key)
    own_client = client is None
    client = client or ForumClient(board)
    tags = [t.strip().lower() for t in tags if t and t.strip()]
    if not tags:
        raise ValueError("At least one tag is required.")

    try:
        since = utcnow() - timedelta(days=max(1, window_days))
        listed = await _threads_for_tags(client, tags, max_pages=tag_pages)

        recent = [
            t for t in listed
            if t.get("last_post_at") is None or t["last_post_at"] >= since
        ][:MAX_THREADS_PER_QUERY * max(1, tag_pages)]

        threads_touched, links_found, skipped = 0, 0, 0
        errors: list[str] = []
        via = discovered_via or ", ".join(tags)
        scanned = 0

        for data in recent:
            existing = _row_for_url(db, data["url"])
            if not _thread_needs_fetch(existing, data):
                skipped += 1
                scanned += 1
                if progress:
                    progress({
                        "phase": "saved-query", "board": board.key,
                        "completed": scanned, "total": len(recent),
                        "new_links": links_found,
                        "message": f"{board.label}: tag {scanned}/{len(recent)} "
                                   "nezmenených vlákien.",
                    })
                continue
            try:
                posts, scan_truncated, next_cursor = await _fetch_thread_posts(
                    client,
                    data["url"],
                    existing.last_seen_post_id if existing else "",
                    existing.scan_cursor_url if existing else "",
                    since=since,
                )
                if scan_truncated:
                    errors.append(
                        f"{data.get('title') or data['url']}: skenovanie tagu narazilo na "
                        f"limit {MAX_PAGES_PER_THREAD} strán."
                    )
            except ForumAuthError:
                raise
            except ForumChallengeError:
                raise
            except ForumRateLimitError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("[ForumHub] tag thread %s failed: %s", data["url"], exc)
                errors.append(f"{data.get('title') or data['url']}: {exc}")
                scanned += 1
                if progress:
                    progress({
                        "phase": "saved-query", "board": board.key,
                        "completed": scanned, "total": len(recent),
                        "new_links": links_found,
                        "message": f"{board.label}: chyba v tagovom vlákne "
                                   f"{scanned}/{len(recent)}.",
                    })
                continue

            try:
                thread = _upsert_thread(db, board, data, origin="tag", discovered_via=via)
                found = _persist_posts(db, thread, posts, platforms=platforms)
                thread.scan_cursor_url = next_cursor
                db.commit()
            except Exception as exc:  # noqa: BLE001
                db.rollback()
                logger.warning("[ForumHub] tag thread %s failed to persist: %s", data["url"], exc)
                errors.append(f"{data.get('title') or data['url']}: {exc}")
                scanned += 1
                if progress:
                    progress({
                        "phase": "saved-query", "board": board.key,
                        "completed": scanned, "total": len(recent),
                        "new_links": links_found,
                        "message": f"{board.label}: chyba pri ukladaní tagu "
                                   f"{scanned}/{len(recent)}.",
                    })
                continue
            links_found += found
            if found:
                threads_touched += 1
            scanned += 1
            if progress:
                progress({
                    "phase": "saved-query", "board": board.key,
                    "completed": scanned, "total": len(recent),
                    "new_links": links_found,
                    "message": f"{board.label}: tag {scanned}/{len(recent)}, "
                               f"{links_found} nových odkazov.",
                })

        return {
            "board": board.key,
            "tags": tags,
            "threads_matched": len(listed),
            "threads_scanned": len(recent),
            "threads_skipped": skipped,
            "threads_with_links": threads_touched,
            "new_links": links_found,
            "errors": errors,
        }
    finally:
        if own_client:
            await client.aclose()


async def refresh_saved_queries(
    db: Session,
    client: Optional[ForumClient] = None,
    progress: Optional[Callable[[dict[str, Any]], None]] = None,
) -> list[dict[str, Any]]:
    results = []
    saved = db.query(ForumSavedQuery)
    if client:
        saved = saved.filter(ForumSavedQuery.board == client.board.key)
    queries = saved.all()
    for index, query in enumerate(queries, start=1):
        if progress:
            progress({
                "phase": "saved-query",
                "board": query.board,
                "completed": index - 1,
                "total": len(queries),
                "message": f"Obnovujem kanál {index}/{len(queries)}: "
                           f"{query.name or ', '.join(query.tags or [])}.",
            })
        try:
            result = await discover_by_tags(
                db, query.board, list(query.tags or []),
                window_days=query.window_days,
                platforms=list(query.platforms or []) or None,
                discovered_via=query.name or ", ".join(query.tags or []),
                client=client if (client and client.board.key == query.board) else None,
                progress=progress,
            )
            query.last_run_at = utcnow()
            db.commit()
            results.append({"query": query.name, **result})
        except ForumRateLimitError as exc:
            logger.warning("[ForumHub] saved query %s rate-limited: %s", query.name, exc)
            results.append({"query": query.name, "error": str(exc), "new_links": 0})
            break
        except (ForumAuthError, ForumChallengeError):
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("[ForumHub] saved query %s failed: %s", query.name, exc)
            results.append({"query": query.name, "error": str(exc)})
    return results


async def refresh_tag_cloud(db: Session, board_key: str) -> int:
    """Cache the board's tag vocabulary so autocomplete never hits the forum."""
    board = get_board(board_key)
    client = ForumClient(board)
    try:
        html = await client.get(board.tags_url)
        tags = parse_tag_cloud(html)

        existing = {t.tag: t for t in db.query(ForumTag).filter(ForumTag.board == board.key).all()}
        for entry in tags:
            row = existing.get(entry["tag"])
            if row is None:
                db.add(ForumTag(board=board.key, tag=entry["tag"], weight=entry["weight"]))
            else:
                row.weight = entry["weight"]
                row.updated_at = utcnow()
        db.commit()
        return len(tags)
    finally:
        await client.aclose()


async def refresh_all(
    db: Session,
    boards: Optional[list[str]] = None,
    progress: Optional[Callable[[dict[str, Any]], None]] = None,
    unread_only: bool = False,
) -> dict[str, Any]:
    """The Refresh button: watchlists first, then every saved tag channel."""
    targets = boards or ["simpcity"]
    watchlists = []
    queries: list[dict[str, Any]] = []
    for index, key in enumerate(targets, start=1):
        board = get_board(key)
        if progress:
            progress({
                "phase": "board",
                "board": key,
                "completed": index - 1,
                "total": len(targets),
                "message": f"Obnovujem fórum {index}/{len(targets)}: {board.label}.",
            })
        client = ForumClient(board)
        try:
            remaining = cooldown_remaining(key)
            if remaining > 0:
                msg = (
                    f"{board.label} je v cooldown {int(remaining)}s po HTTP 429. "
                    "Hub neskúša fóra, kým to nevyprší."
                )
                watchlists.append({"board": key, "error": msg, "new_links": 0, "errors": [msg]})
                continue
            watch = await sync_watchlist(
                db, key, unread_only=unread_only, client=client, progress=progress,
            )
            watchlists.append(watch)
            if any("429" in str(e) or "throttle" in str(e).lower() for e in (watch.get("errors") or [])):
                continue
            queries.extend(await refresh_saved_queries(db, client=client, progress=progress))
        except (ForumAuthError, ForumChallengeError):
            raise
        except ForumRateLimitError as exc:
            watchlists.append({"board": key, "error": str(exc), "new_links": 0, "errors": [str(exc)]})
        except Exception as exc:  # noqa: BLE001
            watchlists.append({"board": key, "error": str(exc), "new_links": 0})
        finally:
            await client.aclose()
    total = sum(w.get("new_links", 0) for w in watchlists) + sum(q.get("new_links", 0) for q in queries)
    errors = [
        error for result in [*watchlists, *queries]
        for error in ([result.get("error")] if result.get("error") else [])
        + list(result.get("errors") or [])
    ]
    return {
        "watchlists": watchlists,
        "saved_queries": queries,
        "new_links": total,
        "partial": bool(errors) or any(row.get("partial") for row in watchlists),
        "errors": errors,
    }
