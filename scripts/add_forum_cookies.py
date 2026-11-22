"""Merge HttpOnly session cookies into a board's Netscape cookie jar.

The `<prefix>_session` / `<prefix>_user` cookies are HttpOnly, so JS-based cookie
exporters silently drop them. Copy their values from DevTools > Application >
Cookies and paste them here.

    python scripts/add_forum_cookies.py simpcity
    python scripts/add_forum_cookies.py simpcity --session <val> --user <val>
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.forums.boards import cookie_prefix, get_board, load_cookies  # noqa: E402

# One year out; XenForo "remember me" sessions live about that long.
_EXPIRY = int(time.time()) + 365 * 24 * 3600


def _jar_path(board) -> Path:
    path = Path(board.cookie_file)
    return path if path.is_absolute() else Path(__file__).resolve().parents[1] / path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("board", help="simpcity | smg")
    ap.add_argument("--session", help="value of <prefix>_session")
    ap.add_argument("--user", help="value of <prefix>_user")
    args = ap.parse_args()

    board = get_board(args.board)
    path = _jar_path(board)
    cookies = load_cookies(board)
    if not cookies:
        print(f"! {path} is empty or missing. Export the normal cookies there first.")
        return 1

    prefix = cookie_prefix(cookies)
    if prefix == "xf":
        print("! No <prefix>_csrf cookie found — is this really a XenForo jar?")
        return 1
    print(f"Board : {board.label} ({board.base_url})")
    print(f"Prefix: {prefix}_\n")

    session = args.session or input(f"{prefix}_session value: ").strip()
    user = args.user or input(f"{prefix}_user    value: ").strip()
    if not session or not user:
        print("! Both values are required.")
        return 1

    cookies[f"{prefix}_session"] = session
    cookies[f"{prefix}_user"] = user

    domain = "." + board.base_url.split("//", 1)[-1].split("/")[0]
    lines = ["# Netscape HTTP Cookie File"]
    lines += [f"{domain}\tTRUE\t/\tTRUE\t{_EXPIRY}\t{name}\t{value}" for name, value in cookies.items()]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"\nWrote {len(cookies)} cookies to {path}")
    print("Now run:  python scripts/check_forum_auth.py " + board.key)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
