"""Verify a board's cookies actually authenticate, before trusting the hub's refresh.

    python scripts/check_forum_auth.py simpcity
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

# Windows consoles default to cp1250 here and choke on thread titles.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.forums.boards import board_status, get_board  # noqa: E402
from app.forums.client import ForumAuthError, ForumClient  # noqa: E402
from app.forums.parser import parse_thread_list  # noqa: E402


async def main(board_key: str) -> int:
    board = get_board(board_key)
    status = board_status(board)
    print(f"{board.label}  {board.base_url}")
    print(f"  cookies : {', '.join(status['cookie_names']) or '(none)'}")

    if status["missing_cookies"]:
        print(f"  MISSING : {', '.join(status['missing_cookies'])}")
        print(f"\n  Fix: python scripts/add_forum_cookies.py {board.key}")
        return 1

    html = ""
    client = ForumClient(board)
    try:
        html = await client.get(board.watched_url, params={"unread_only": "1"})
    except ForumAuthError as exc:
        print(f"\n  NOT LOGGED IN: {exc}")
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"\n  FETCH FAILED: {exc}")
        return 1
    finally:
        await client.aclose()

    if not html:
        return 1

    threads = parse_thread_list(html, board.base_url)
    print(f"\n  LOGGED IN — {len(threads)} watched thread(s) with unread posts:")
    for t in threads[:10]:
        print(f"    - {t['title'][:56]:<58} {t['last_post_at'] or ''}")
    if not threads:
        print("    (none unread right now — auth works, there's just nothing new)")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "simpcity")))
