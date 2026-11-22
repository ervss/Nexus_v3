"""Re-title existing forum links whose name was a URL id placeholder.

Older parses fell back to `Bunkr video` / `mZCLaiCw` when a post offered several
bare mirror URLs. The parser now reads the post's own heading in that case, but
stored rows keep the old name — only `body_text` was persisted, not the HTML, so
the fix needs a re-fetch.

Read-only against the forum; updates title/thumbnail in place. Never imports.

    python scripts/backfill_forum_titles.py --dry-run
    python scripts/backfill_forum_titles.py simpcity
"""
from __future__ import annotations

import argparse
import asyncio
import re
import sys
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.database import ForumLink, ForumThread, SessionLocal  # noqa: E402
from app.forums.boards import get_board  # noqa: E402
from app.forums.client import ForumClient  # noqa: E402
from app.forums.parser import parse_posts, prev_page_url  # noqa: E402

MAX_PAGES = 4


def _is_placeholder(link: ForumLink) -> bool:
    title = (link.title or "").strip()
    if not title:
        return True
    if title == f"{link.platform.capitalize()} {link.link_type}":
        return True
    # A bare host id: "mZCLaiCw", "N5xLwfYbkual5" — no spaces, no separators.
    return bool(re.fullmatch(r"[A-Za-z0-9]{6,20}", title))


async def backfill(board_key: str, dry_run: bool) -> None:
    board = get_board(board_key)
    client = ForumClient(board)
    db = SessionLocal()

    threads = db.query(ForumThread).filter(ForumThread.board == board.key).all()
    print(f"{board.label}: {len(threads)} threads\n")

    fixed = scanned = 0
    for thread in threads:
        targets = {
            l.url: l for l in db.query(ForumLink).filter(ForumLink.thread_id == thread.id).all()
            if _is_placeholder(l)
        }
        if not targets:
            continue

        url = thread.url.rstrip("/") + "/latest"
        parsed: dict[str, dict] = {}
        try:
            for _ in range(MAX_PAGES):
                html = await client.get(url)
                for post in parse_posts(html, board.base_url):
                    for link in post["links"]:
                        parsed.setdefault(link["url"], link)
                if not set(targets) - set(parsed):
                    break
                url = prev_page_url(html, board.base_url)
                if not url:
                    break
        except Exception as exc:  # noqa: BLE001
            print(f"  !! {thread.title[:40]}: {exc}")
            continue

        hits = 0
        for link_url, row in targets.items():
            fresh = parsed.get(link_url)
            scanned += 1
            if not fresh or _is_placeholder_title(fresh["title"], row):
                continue
            print(f"  {row.title[:26]:<28} -> {fresh['title'][:56]}")
            if not dry_run:
                row.title = fresh["title"]
                if fresh.get("thumbnail") and not row.thumbnail:
                    row.thumbnail = fresh["thumbnail"]
            hits += 1
        fixed += hits
        if hits:
            print(f"  [{thread.title[:38]}] {hits} retitled\n")
        if not dry_run:
            db.commit()

    print(f"\n{'would fix' if dry_run else 'fixed'} {fixed} of {scanned} placeholder titles")
    db.close()


def _is_placeholder_title(title: str, row: ForumLink) -> bool:
    """The freshly parsed title is no better than what we already had."""
    title = (title or "").strip()
    if not title or title == (row.title or "").strip():
        return True
    return title == f"{row.platform.capitalize()} {row.link_type}" or bool(
        re.fullmatch(r"[A-Za-z0-9]{6,20}", title)
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("board", nargs="?", default="simpcity", help="simpcity | smg")
    ap.add_argument("--dry-run", action="store_true", help="show changes without writing")
    args = ap.parse_args()
    asyncio.run(backfill(args.board, args.dry_run))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
