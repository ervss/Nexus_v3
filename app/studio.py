"""
Nexus Studio — the moment layer.

The rest of the app thinks in *videos*: import one, thumbnail it, check its
link, put it in a grid. Studio thinks in *moments* — the slice of a video that
was actually worth keeping. Everything here exists to make that slice cheap:

  * `resolve_media`  — one video row -> (what ffmpeg should open, what the
    browser should play). Local file, /static path and remote CDN all collapse
    to the same two answers so no caller has to branch on storage_type.
  * `build_storyboard` — a dense filmstrip of a video as individual JPEGs,
    generated with one fast-seek ffmpeg call per frame. Individual files, not a
    sprite sheet, because they can be streamed in as they land (the strip fills
    up while you watch) and because fast seek works the same over http as it
    does on disk — a tiled `fps=1/N` filter would have to decode a remote file
    end to end.
  * `detect_scenes` — real cut detection, but only on local files and only over
    keyframes (`-skip_frame nokey`). Full-frame scene detection on a 40-minute
    file takes minutes; over keyframes it takes seconds and lands within a
    keyframe of the real cut, which is all a "jump me to the interesting bits"
    button needs.
  * `export_clip` — renders a moment to a real mp4. Stream-copy by default
    (instant, keyframe-aligned); `precise` re-encodes for frame-exact edges.

Nothing in here touches the database — the router owns rows, this owns bytes.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import time
from dataclasses import dataclass
from typing import AsyncIterator, Optional
from urllib.parse import quote, unquote, urlparse

logger = logging.getLogger(__name__)

STATIC_ROOT = os.path.join("app", "static")
STORYBOARD_DIR = os.path.join(STATIC_ROOT, "storyboards")
MOMENT_THUMB_DIR = os.path.join(STATIC_ROOT, "moments")
CLIP_DIR = os.path.join(STATIC_ROOT, "clips")

for _d in (STORYBOARD_DIR, MOMENT_THUMB_DIR, CLIP_DIR):
    os.makedirs(_d, exist_ok=True)

#: Storyboards are the expensive artefact; keep the newest N videos' worth and
#: evict the rest, so a long slicing session can't quietly fill the disk.
STORYBOARD_KEEP_VIDEOS = 40

_NETWORK_ARGS = [
    "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10",
    "-user_agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
]


def _ffmpeg() -> str:
    try:
        from .services import FFMPEG_CMD
        return FFMPEG_CMD
    except Exception:  # noqa: BLE001 — services drags in the whole intake stack
        return shutil.which("ffmpeg") or "ffmpeg"


def _ffprobe() -> str:
    try:
        from .services import FFPROBE_CMD
        return FFPROBE_CMD
    except Exception:  # noqa: BLE001
        return shutil.which("ffprobe") or "ffprobe"


def _norm_win(path: str) -> str:
    """`/C:/x` -> `C:/x`. urlparse on a Windows file:// URL leaves the leading slash."""
    if os.name == "nt" and path.startswith("/") and ":" in path[:4]:
        return path[1:]
    return path


# ---------------------------------------------------------------- media resolve

@dataclass
class Media:
    """Where a video's bytes live, in the two forms Studio ever needs."""
    #: what to hand ffmpeg as -i (a filesystem path or an http URL)
    input: str
    #: what to put in a <video src> (always something this server can serve)
    play_url: str
    #: True when `input` is a real file — unlocks scene detection and instant export
    is_local: bool
    #: why the video can't be sliced at all, or "" when it can
    problem: str = ""
    #: MPEG-TS: ffmpeg reads it happily (so the filmstrip, scene detection and
    #: export all work off `input` straight away), but no browser can, so
    #: `play_url` only becomes playable once ts_remux has produced the MP4.
    needs_remux: bool = False


async def resolve_hub_media(source: str, watch_url: str) -> Media:
    """A hub source's watch page -> Media, resolved just in time.

    Hub CDNs hand out URLs bound to the resolving IP and Referer and expire them
    within the hour, so nothing about a hub moment can be stored: the stream is
    re-resolved every time it is played or sliced. `play_url` therefore points
    at the source's own proxy, which replays the CDN request with the right
    headers — the same route the Fusion Hub player uses.
    """
    from .hubs import registry
    registry.init_hubs()
    adapter = registry.get(source)
    if adapter is None:
        return Media("", "", False, f"Neznámy zdroj „{source}“.")
    try:
        data = await adapter.resolve(watch_url)
    except NotImplementedError:
        return Media("", "", False, f"{source} nevie vrátiť priamy stream.")
    except Exception as exc:  # noqa: BLE001
        return Media("", "", False, f"Zdroj neodpovedal: {exc}")

    stream = (data or {}).get("stream_url") or ""
    if not stream:
        return Media("", "", False, "Zdroj nevrátil žiadny stream.")
    if (data or {}).get("is_hls"):
        # ffmpeg could read the playlist, but every frame grab would re-walk the
        # segment list; slicing an HLS source is not worth the wait.
        return Media("", "", False, "HLS stream sa zatiaľ strihať nedá.")
    proxied = f"/api/v1/hub/{source}/stream?url={quote(stream, safe='')}"
    return Media(stream, proxied, False)


def resolve_media(video) -> Media:
    """One library row -> Media. Never raises; an unusable row comes back with `problem`."""
    url = (video.url or "").strip()
    storage = (video.storage_type or "").strip().lower()

    if not url:
        return Media("", "", False, "Karta nemá žiadny odkaz na súbor.")

    from .ts_remux import is_ts_url, status as ts_status
    ts = is_ts_url(url)

    def _playable(default_url: str) -> str:
        """A .ts path is unplayable in every browser; point at its remux instead."""
        if not ts:
            return default_url
        state = ts_status(video.id)
        return state["url"] if state["state"] == "ready" else \
            f"/api/v1/videos/{video.id}/ts-stream"

    # file:// (storage_type local_direct) — the file sits on disk untouched by us.
    if url.startswith("file://") or storage == "local_direct":
        raw = url[7:] if url.startswith("file://") else url
        path = _norm_win(unquote(urlparse(url).path if url.startswith("file://") else raw))
        if not os.path.exists(path):
            return Media("", "", False, "Súbor už na disku nie je.")
        return Media(path, _playable(f"/api/v1/videos/{video.id}/stream"), True,
                     needs_remux=ts)

    # /static/local_videos/... — downloaded into the app's own tree.
    if url.startswith("/static/"):
        path = os.path.join("app", url.lstrip("/").replace("/", os.sep))
        if os.path.exists(path):
            return Media(path, _playable(url), True, needs_remux=ts)
        return Media("", url, False, "Lokálny súbor chýba na disku.")

    if url.startswith("http://") or url.startswith("https://"):
        # Remote: ffmpeg can fast-seek it over range requests, so slicing works —
        # just slower, and scene detection stays off.
        return Media(url, _playable(url), False, needs_remux=ts)

    return Media("", "", False, "Neznámy typ odkazu.")


async def probe_duration(media: Media) -> float:
    """Seconds, or 0. Used when the library row's duration is missing or lying."""
    if not media.input:
        return 0.0
    cmd = [_ffprobe(), "-v", "error", "-show_entries", "format=duration",
           "-of", "default=noprint_wrappers=1:nokey=1", media.input]
    try:
        rc, out, _ = await _run(cmd, timeout=25)
        return float((out or b"").decode(errors="ignore").strip() or 0) if rc == 0 else 0.0
    except Exception:  # noqa: BLE001
        return 0.0


async def _run(cmd: list[str], timeout: float = 60) -> tuple[int, bytes, bytes]:
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode or 0, out, err
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass
        return -1, b"", b"timeout"


# ------------------------------------------------------------------ storyboard

def storyboard_key(video_id: int = 0, source: str = "", url: str = "") -> str:
    """Cache folder name for a strip.

    A library card keys on its id; a hub video has no id, so it keys on a hash
    of source+watch URL. The resolved CDN URL deliberately plays no part — it
    changes on every resolve, and the frames it produced are still the same
    frames of the same video tomorrow.
    """
    if video_id:
        return str(int(video_id))
    digest = hashlib.sha1(f"{source}|{url}".encode("utf-8", "ignore")).hexdigest()[:16]
    return f"{(source or 'hub').lower()}-{digest}"


def storyboard_dir(key: int | str) -> str:
    return os.path.join(STORYBOARD_DIR, storyboard_key(key) if isinstance(key, int) else str(key))


def storyboard_meta(key: int | str) -> Optional[dict]:
    """The cached strip for a video, or None. Frames are listed in time order."""
    folder = storyboard_dir(key)
    meta_path = os.path.join(folder, "meta.json")
    if not os.path.exists(meta_path):
        return None
    try:
        with open(meta_path, "r", encoding="utf-8") as fh:
            meta = json.load(fh)
    except Exception:  # noqa: BLE001
        return None
    frames = [f for f in meta.get("frames", [])
              if os.path.exists(os.path.join(folder, os.path.basename(f["url"])))]
    if not frames:
        return None
    meta["frames"] = frames
    return meta


def frame_count_for(duration: float) -> int:
    """Enough frames that neighbours are ~15 s apart, floored at 24 and capped at 72.

    Below the floor a two-minute clip would get a strip too sparse to aim with;
    above the cap a three-hour film would spawn hundreds of ffmpeg calls for
    frames that end up two pixels wide on screen.
    """
    return max(24, min(72, int((duration or 0) / 15) or 24))


def _evict_old_storyboards(keep: int = STORYBOARD_KEEP_VIDEOS) -> None:
    try:
        entries = [(os.path.getmtime(os.path.join(STORYBOARD_DIR, d)), d)
                   for d in os.listdir(STORYBOARD_DIR)
                   if os.path.isdir(os.path.join(STORYBOARD_DIR, d))]
    except OSError:
        return
    for _, name in sorted(entries, reverse=True)[keep:]:
        shutil.rmtree(os.path.join(STORYBOARD_DIR, name), ignore_errors=True)


async def build_storyboard(key: int | str, media: Media, duration: float,
                           frames: int = 0, width: int = 240,
                           concurrency: int = 4) -> AsyncIterator[dict]:
    """Yield `{type: frame|done|error, ...}` while the filmstrip is generated.

    One `-ss <t> -i <src> -frames:v 1` per frame. That is more processes than a
    single tiled filter would need, but fast seek makes each one O(1) instead of
    decoding from zero, and it means the caller can paint frame 3 while frame 40
    is still being cut. `concurrency` stays low on purpose: the point is a
    responsive strip, not saturating every core while the user is still watching.
    """
    if not media.input:
        yield {"type": "error", "error": media.problem or "Video sa nedá otvoriť."}
        return

    duration = float(duration or 0)
    if duration <= 1:
        duration = await probe_duration(media)
    if duration <= 1:
        yield {"type": "error", "error": "Nepodarilo sa zistiť dĺžku videa."}
        return

    folder = storyboard_key(key) if isinstance(key, int) else str(key)
    out_dir = storyboard_dir(folder)
    os.makedirs(out_dir, exist_ok=True)
    n = frames or frame_count_for(duration)

    # Skip the very first and last 2% — intros and black tails make useless frames.
    span_start, span_end = duration * 0.02, duration * 0.98
    step = (span_end - span_start) / max(n - 1, 1)
    times = [round(span_start + i * step, 2) for i in range(n)]

    ffmpeg = _ffmpeg()
    net = _NETWORK_ARGS if not media.is_local else []
    sem = asyncio.Semaphore(max(1, concurrency))
    done_frames: list[dict] = []

    async def cut(idx: int, t: float) -> Optional[dict]:
        name = f"f{idx:03d}.jpg"
        dest = os.path.join(out_dir, name)
        if os.path.exists(dest) and os.path.getsize(dest) > 512:
            return {"idx": idx, "t": t, "url": f"/static/storyboards/{folder}/{name}"}
        cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
               "-ss", str(t), *net, "-i", media.input,
               "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", "5", dest]
        async with sem:
            rc, _, err = await _run(cmd, timeout=45 if media.is_local else 90)
        if rc != 0 or not os.path.exists(dest):
            logger.debug("studio storyboard frame %s@%s failed: %s", folder, t,
                         (err or b"")[:200])
            return None
        return {"idx": idx, "t": t, "url": f"/static/storyboards/{folder}/{name}"}

    tasks = [asyncio.create_task(cut(i, t)) for i, t in enumerate(times)]
    try:
        for coro in asyncio.as_completed(tasks):
            frame = await coro
            if frame:
                done_frames.append(frame)
                yield {"type": "frame", "frame": frame, "total": n}
    finally:
        for task in tasks:
            task.cancel()

    if not done_frames:
        yield {"type": "error", "error": "ffmpeg nevedel z videa vytiahnuť ani jeden obrázok."}
        return

    done_frames.sort(key=lambda f: f["idx"])
    meta = {"key": folder, "duration": duration, "width": width,
            "frames": done_frames, "built_at": time.time()}
    try:
        with open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8") as fh:
            json.dump(meta, fh)
    except OSError:
        pass
    _evict_old_storyboards()
    yield {"type": "done", "meta": meta}


# -------------------------------------------------------------- scene detection

_SCENE_RE = re.compile(rb"pts_time:([0-9.]+)")


async def detect_scenes(media: Media, duration: float, *,
                        threshold: float = 0.28, limit: int = 60) -> list[float]:
    """Timestamps of likely cuts, in seconds. [] when detection isn't possible.

    Keyframe-only (`-skip_frame nokey`): a full decode of a long file takes
    minutes and this runs while someone is waiting on a button. The cost is that
    a returned time is the keyframe at/just after the cut rather than the exact
    frame — irrelevant when the output is "here are the interesting spots".
    """
    if not media.is_local or not media.input:
        return []
    cmd = [_ffmpeg(), "-hide_banner", "-loglevel", "info", "-skip_frame", "nokey",
           "-i", media.input,
           "-vf", f"select='gt(scene,{threshold})',metadata=print",
           "-an", "-sn", "-f", "null", "-"]
    rc, _, err = await _run(cmd, timeout=180)
    if rc != 0 and not err:
        return []
    times = sorted({round(float(m), 2) for m in _SCENE_RE.findall(err or b"")})
    if duration:
        times = [t for t in times if 1 < t < duration - 1]
    if len(times) <= limit:
        return times
    # Too many hits (fast-cut edits): thin them out evenly rather than truncating,
    # which would hand back only the first minute of a 40-minute file.
    stride = len(times) / limit
    return [times[int(i * stride)] for i in range(limit)]


# ------------------------------------------------------------------ frames/clips

async def extract_frame(media: Media, at_sec: float, dest: str, width: int = 480) -> bool:
    """Single JPEG at `at_sec` -> `dest`. Used for moment cover images."""
    if not media.input:
        return False
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    net = [] if media.is_local else _NETWORK_ARGS
    cmd = [_ffmpeg(), "-y", "-hide_banner", "-loglevel", "error",
           "-ss", str(max(0.0, at_sec)), *net, "-i", media.input,
           "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", "4", dest]
    rc, _, _ = await _run(cmd, timeout=60 if media.is_local else 120)
    return rc == 0 and os.path.exists(dest) and os.path.getsize(dest) > 512


async def export_clip(moment_id: int, media: Media, start: float, end: float,
                      *, precise: bool = False) -> tuple[bool, str, float]:
    """Render [start, end) to app/static/clips/moment_{id}.mp4.

    Returns (ok, message_or_path, size_mb).

    Stream copy is the default and is effectively free, but it can only cut on
    keyframes, so the clip may open up to a couple of seconds early. `precise`
    re-encodes for exact edges. If a copy produces a file too small to be real
    (some sources' keyframe spacing exceeds the whole selection), it falls back
    to re-encoding on its own rather than handing back a broken 2 KB mp4.
    """
    if not media.input:
        return False, media.problem or "Video sa nedá otvoriť.", 0.0
    duration = max(0.5, float(end) - float(start))
    dest = os.path.join(CLIP_DIR, f"moment_{int(moment_id)}.mp4")
    net = [] if media.is_local else _NETWORK_ARGS
    base = [_ffmpeg(), "-y", "-hide_banner", "-loglevel", "error",
            "-ss", str(max(0.0, float(start))), *net, "-i", media.input,
            "-t", str(duration)]
    encode = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
              "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", dest]
    copy = ["-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", dest]

    attempts = [base + encode] if precise else [base + copy, base + encode]
    last_err = ""
    for cmd in attempts:
        rc, _, err = await _run(cmd, timeout=600)
        size = os.path.getsize(dest) if os.path.exists(dest) else 0
        if rc == 0 and size > 64_000:
            return True, f"/static/clips/moment_{int(moment_id)}.mp4", round(size / 1_048_576, 2)
        last_err = (err or b"").decode(errors="ignore").strip()[:300] or "ffmpeg zlyhal"
    return False, last_err, 0.0


def delete_clip(moment_id: int) -> None:
    for path in (os.path.join(CLIP_DIR, f"moment_{int(moment_id)}.mp4"),
                 os.path.join(MOMENT_THUMB_DIR, f"m{int(moment_id)}.jpg")):
        try:
            os.remove(path)
        except OSError:
            pass
