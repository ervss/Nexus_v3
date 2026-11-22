"""Choose the video qBittorrent should fetch first, and keep paths inside its save folder."""

from __future__ import annotations

from pathlib import Path

VIDEO_EXT = {
    ".mp4", ".m4v", ".webm", ".mkv", ".avi", ".mov",
    ".ts", ".m2ts", ".mts", ".wmv", ".flv", ".mpg", ".mpeg",
}
NATIVE_EXT = {".mp4", ".m4v", ".webm"}
ARCHIVE_EXT = {".rar", ".zip", ".7z", ".iso"}
_SAMPLE_TOKENS = ("sample", "trailer", "proof", "thumb", "preview")


def is_under_root(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except (ValueError, OSError):
        return False
    return True


def _suffix(name: str) -> str:
    return Path(name.replace("\\", "/")).suffix.lower()


def is_sample(name: str, size: int, largest: int) -> bool:
    folded = name.lower()
    if not any(token in folded for token in _SAMPLE_TOKENS):
        return False
    return size < 80 * 1024 * 1024 or (largest > 0 and size < largest * 0.2)


def pick_video_file(files: list[dict]) -> dict | None:
    videos = []
    for item in files:
        name = str(item.get("name") or "")
        if _suffix(name) not in VIDEO_EXT:
            continue
        videos.append(item)
    if not videos:
        return None
    largest = max(int(item.get("size") or 0) for item in videos)
    ranked = [item for item in videos if not is_sample(str(item.get("name") or ""), int(item.get("size") or 0), largest)]
    pool = ranked or videos
    return max(pool, key=lambda item: int(item.get("size") or 0))


def has_archive(files: list[dict]) -> bool:
    return any(_suffix(str(item.get("name") or "")) in ARCHIVE_EXT for item in files)


def stream_mode(name: str) -> str:
    return "native" if _suffix(name) in NATIVE_EXT else "remux"


def file_byte_offset(files: list[dict], chosen: dict) -> int:
    offset = 0
    chosen_index = chosen.get("index", chosen.get("id"))
    for item in files:
        same = item is chosen or (
            item.get("name") == chosen.get("name") and item.get("index", item.get("id")) == chosen_index
        )
        if same:
            return offset
        offset += int(item.get("size") or 0)
    return 0


def contiguous_end(
    states: list[int],
    piece_size: int,
    file_offset: int,
    start: int,
    hard_end: int,
    file_size: int,
) -> int | None:
    """Last downloaded byte at or after ``start``, without crossing a missing piece.

    qBittorrent may preallocate the file. The size on disk is then the full
    movie while the middle is still empty, so the player must only receive
    pieces whose state is downloaded (2).
    """
    if piece_size <= 0 or not states or file_size <= 0 or start >= file_size:
        return None
    hard_end = min(hard_end, file_size - 1)
    if hard_end < start:
        return None
    first = (file_offset + start) // piece_size
    if first < 0 or first >= len(states) or states[first] != 2:
        return None
    last_piece = first
    limit = (file_offset + hard_end) // piece_size
    piece = first + 1
    while piece <= limit and piece < len(states) and states[piece] == 2:
        last_piece = piece
        piece += 1
    piece_last_byte = ((last_piece + 1) * piece_size - 1) - file_offset
    return max(start, min(hard_end, piece_last_byte, file_size - 1))


def candidate_paths(save_path: str, content_path: str, file_name: str) -> list[Path]:
    """Paths qBittorrent may have written, including the incomplete .!qB suffix."""
    rel = Path(file_name.replace("\\", "/"))
    roots: list[Path] = []
    content = Path(content_path) if content_path else None
    save = Path(save_path) if save_path else None
    if content and content.suffix:
        roots.append(content)
    if content and not content.suffix:
        direct = content / rel
        roots.append(direct)
        if rel.parts and content.name.lower() == rel.parts[0].lower():
            roots.append(content.parent / rel)
    if save:
        roots.append(save / rel)
        if rel.parts:
            roots.append(save / rel.name)
    unique: list[Path] = []
    seen: set[str] = set()
    for path in roots:
        for variant in (path, Path(str(path) + ".!qB")):
            key = str(variant).lower()
            if key in seen:
                continue
            seen.add(key)
            unique.append(variant)
    return unique


def download_root(save_path: str, content_path: str) -> Path | None:
    """The folder a torrent is allowed to read from. Never the parent of the save path."""
    if save_path:
        return Path(save_path)
    if not content_path:
        return None
    content = Path(content_path)
    return content.parent if content.suffix else content


def resolve_video_path(save_path: str, content_path: str, file_name: str) -> Path | None:
    root = download_root(save_path, content_path)
    if root is None:
        return None
    for candidate in candidate_paths(save_path, content_path, file_name):
        if not candidate.is_file():
            continue
        if is_under_root(candidate, root):
            return candidate
    return None
