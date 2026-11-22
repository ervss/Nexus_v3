"""
Mashup Studio — renders 2-4 source clips into one split-screen composite.

Each track is independently keyframed: a crop/zoom window that pans over
time, a position/size on the output canvas that can itself move, and one
audio track active at a time with a short crossfade at switch points. MVP
scope is linear interpolation between keyframes only (no easing curves).

The render is a single ffmpeg invocation per job: one `crop`+`scale` filter
chain per track (driven by per-keyframe `sendcmd` since ffmpeg's built-in
expression evaluator can't do a plain lerp between arbitrary keyframe pairs
without either drawtext-style `if()` chains or a filtergraph edited per
segment — `sendcmd` was chosen because it scales cleanly to many keyframes
without generating an increasingly large expression string), composited with
`overlay`, and an audio `volume` envelope per track for the active-track
crossfade.

Nothing in here touches the database directly except to write job status —
app/routers/faphouse.py owns creating the row and dispatching the background
task; this module owns turning a source_spec into bytes.
"""
from __future__ import annotations

import logging
import os
import time
import uuid
from typing import Any, Optional

from .database import FaphouseMashupJob, SessionLocal
from .studio import Media, _ffmpeg, _run

logger = logging.getLogger(__name__)

MASHUP_DIR = os.path.join("app", "static", "mashups")
os.makedirs(MASHUP_DIR, exist_ok=True)

#: Canvas the composite renders at — 1080p is a sane ceiling for a 2-4up grid;
#: going higher just makes every crop's source resolution the bottleneck.
CANVAS_W, CANVAS_H = 1920, 1080
CROSSFADE_SEC = 0.35


def _filter_path(path: str) -> str:
    """A filesystem path, safe to embed inside an ffmpeg filtergraph string.

    ffmpeg's filter-argument parser treats `\\` as an escape character and
    `:` as an option separator — a bare Windows path like
    `app\\static\\mashups\\_cmd_1_0_crop.txt` gets its backslashes silently
    eaten (becoming `appstaticmashups..._cmd_1_0_crop.txt`, a file that never
    existed) and a drive letter's `:` would break argument parsing outright.
    Forward slashes work as path separators on Windows too, so normalizing to
    those (then escaping any remaining `:` and quoting) is what every
    ffmpeg-on-Windows filtergraph guide recommends.
    """
    return path.replace("\\", "/").replace(":", "\\:")


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * max(0.0, min(1.0, t))


def _keyframe_value_at(keyframes: list[dict], field: str, t: float, default: float) -> float:
    """Linear-interpolate `field` at time `t` from a sorted list of
    {"t": seconds, field: value} keyframes. Holds the first/last value outside
    the keyframed range, same as every other keyframe-driven tool."""
    points = sorted(
        [(float(k.get("t", 0)), float(k.get(field, default))) for k in keyframes if field in k],
        key=lambda p: p[0],
    )
    if not points:
        return default
    if t <= points[0][0]:
        return points[0][1]
    if t >= points[-1][0]:
        return points[-1][1]
    for (t0, v0), (t1, v1) in zip(points, points[1:]):
        if t0 <= t <= t1:
            span = (t1 - t0) or 1e-6
            return _lerp(v0, v1, (t - t0) / span)
    return points[-1][1]


def _sendcmd_lines(keyframes: list[dict], fields: dict[str, float], filter_name: str) -> list[str]:
    """One `sendcmd` line per keyframe timestamp, setting every `fields` key
    on `filter_name` to its interpolated value at that instant.

    Using the keyframe timestamps themselves (rather than a fixed tick rate)
    keeps the command file small; ffmpeg's `crop`/`overlay` filters hold each
    setexpr'd value until the next command, which is exactly the piecewise-
    linear behaviour a keyframe editor promises between the tighter of two
    adjacent knots — a truly smooth ramp needs a command every frame, which
    MVP intentionally does not attempt (documented linear-only scope).
    """
    times = sorted({float(k.get("t", 0)) for k in keyframes}) or [0.0]
    lines = []
    for t in times:
        parts = []
        for field, default in fields.items():
            value = _keyframe_value_at(keyframes, field, t, default)
            parts.append(f"{filter_name} {field} {value:.2f}")
        lines.append(f"{t:.3f} {';'.join(parts)};")
    return lines


def _build_sendcmd_file(job_id: int, track_idx: int, kind: str, lines: list[str]) -> str:
    path = os.path.join(MASHUP_DIR, f"_cmd_{job_id}_{track_idx}_{kind}.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return path


def _clamp01(v: float) -> float:
    return max(0.0, min(1.0, v))


def render_mashup_job(job_id: int) -> None:
    """Synchronous entry point — called via FastAPI BackgroundTasks, so this
    runs in a worker thread, not the event loop. All async hub-resolve calls
    are therefore driven through asyncio.run() here rather than awaited.
    """
    import asyncio

    db = SessionLocal()
    try:
        job = db.query(FaphouseMashupJob).filter(FaphouseMashupJob.id == job_id).first()
        if job is None:
            logger.error("[mashup] job %s not found", job_id)
            return
        job.status = "rendering"
        job.progress_pct = 1
        db.commit()

        try:
            output_path = asyncio.run(_render(job_id, job.source_spec, db))
        except Exception as exc:  # noqa: BLE001 — must always resolve the job, never leave it stuck "rendering"
            logger.error("[mashup] job %s failed: %s", job_id, exc, exc_info=True)
            job.status = "failed"
            job.error = str(exc)[:500]
            db.commit()
            return

        job.status = "done"
        job.progress_pct = 100
        job.output_path = output_path
        job.completed_at = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).replace(tzinfo=None)
        db.commit()
    finally:
        db.close()


def _progress(db, job_id: int, pct: int) -> None:
    job = db.query(FaphouseMashupJob).filter(FaphouseMashupJob.id == job_id).first()
    if job:
        job.progress_pct = max(job.progress_pct or 0, pct)
        db.commit()


async def _resolve_mashup_track(source: str, watch_url: str) -> Media:
    """Like studio.resolve_hub_media, but ffmpeg is handed the source's own
    HLS URL directly instead of the "no HLS" refusal that function returns.

    Studio refuses HLS because ITS use case is per-frame scrubbing (a
    storyboard filmstrip, scene detection) — re-walking an HLS segment list
    for every single frame grab is genuinely too slow to be worth it there.
    A mashup render is a single straight-through encode of the whole
    duration, which is exactly what ffmpeg's own HLS demuxer is built for;
    the same restriction doesn't apply and would block most Faphouse
    content, which is HLS-only (no direct-MP4 fallback once the CDN signs a
    manifest).
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
    return Media(stream, stream, False)


async def _probe_resolution(input_ref: str) -> tuple[int, int]:
    from .studio import _ffprobe
    cmd = [_ffprobe(), "-v", "error", "-select_streams", "v:0",
           "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", input_ref]
    rc, out, _ = await _run(cmd, timeout=30)
    if rc == 0 and out:
        # An HLS master with multiple renditions can report v:0 more than
        # once (one CSV line per match); take the first non-blank line only
        # — splitting the raw multi-line blob on "x" produced 3+ parts and
        # silently fell through to the 1920x1080 fallback for every HLS
        # source (confirmed live: real 3840x2160 4K content probed as
        # 1920x1080, which then miscropped/miscomposited that track).
        first_line = next((ln for ln in out.decode(errors="ignore").splitlines() if ln.strip()), "")
        try:
            w, h = first_line.strip().split("x")
            return int(w), int(h)
        except Exception:  # noqa: BLE001
            pass
    return 1920, 1080


async def _render(job_id: int, spec: dict, db) -> str:
    tracks_spec: list[dict] = spec.get("tracks") or []
    if not (2 <= len(tracks_spec) <= 4):
        raise ValueError("Mashup needs 2-4 source tracks.")

    # Resolve every source (hub watch URL or already-playable URL/local path)
    # to a real ffmpeg -i input up front, so a dead stream fails fast instead
    # of mid-filtergraph.
    resolved: list[dict] = []
    for i, track in enumerate(tracks_spec):
        url = track.get("url") or ""
        source = track.get("source") or ""
        if source:
            media = await _resolve_mashup_track(source, url)
            input_ref = media.input
            is_local = media.is_local
            if not input_ref:
                raise RuntimeError(f"Track {i+1}: {media.problem or 'stream sa nedá otvoriť'}")
        else:
            input_ref = url
            is_local = os.path.exists(url)
        width, height = await _probe_resolution(input_ref)
        resolved.append({**track, "input": input_ref, "is_local": is_local,
                         "src_w": width, "src_h": height})
        _progress(db, job_id, 5 + i * 5)

    out_dur = min(
        (float(t.get("out_sec") or 0) - float(t.get("in_sec") or 0)) or 1e9
        for t in tracks_spec
    )
    out_dur = min(out_dur, 3600.0)  # sanity ceiling

    filter_parts: list[str] = []
    temp_files: list[str] = []
    input_args: list[str] = []
    overlay_meta: list[tuple[str, str, int, int]] = []  # (overlay_name, pos_cmd_path, x0_px, y0_px) per track, in order
    for i, track in enumerate(resolved):
        net = [] if track["is_local"] else [
            "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10",
        ]
        in_sec = float(track.get("in_sec") or 0)
        input_args += ["-ss", str(in_sec), *net, "-t", str(out_dur), "-i", track["input"]]

        src_w, src_h = track["src_w"], track["src_h"]
        crop_kf = track.get("crop_keyframes") or [{"t": 0, "cx": 0.5, "cy": 0.5, "cw": 1.0, "ch": 1.0}]
        pos_kf = track.get("position_keyframes") or [{"t": 0, "x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}]

        # Crop window in source pixels, sampled at t=0 as the filter's fixed
        # init size (ffmpeg's crop filter cannot resize its output mid-stream
        # without breaking the encoder's frame size contract) — the pan/zoom
        # illusion instead comes from the position/overlay stage moving and
        # scaling a FIXED-size crop within its allotted canvas region. This
        # trades "the crop window itself changes size live" (not supported by
        # a single crop instance) for "the crop's PLACEMENT within the tile
        # pans live", which is what a POV pan/scan effect actually needs.
        cx0 = _clamp01(float(crop_kf[0].get("cx", 0.5)))
        cy0 = _clamp01(float(crop_kf[0].get("cy", 0.5)))
        cw0 = _clamp01(float(crop_kf[0].get("cw", 1.0))) or 1.0
        ch0 = _clamp01(float(crop_kf[0].get("ch", 1.0))) or 1.0
        crop_w_px = max(16, int(src_w * cw0))
        crop_h_px = max(16, int(src_h * ch0))

        # Pan the crop's (x,y) origin over time via sendcmd, one line per
        # crop keyframe, values in source pixels (crop filter's x/y accept
        # live setexpr updates via sendcmd, unlike w/h). Each track's crop
        # filter gets a unique @name (crop_track{i}) — sendcmd addresses
        # filters by that instance name, and with N tracks there are N crop
        # filters in the graph; targeting the bare type name "crop" would
        # broadcast every track's keyframes to every track's crop filter.
        crop_name = f"crop_track{i}"
        cmd_lines = []
        for kf in sorted(crop_kf, key=lambda k: float(k.get("t", 0))):
            t = float(kf.get("t", 0))
            cx = _clamp01(float(kf.get("cx", cx0)))
            cy = _clamp01(float(kf.get("cy", cy0)))
            x_px = max(0, min(src_w - crop_w_px, int(cx * src_w - crop_w_px / 2)))
            y_px = max(0, min(src_h - crop_h_px, int(cy * src_h - crop_h_px / 2)))
            cmd_lines.append(f"{t:.3f} {crop_name} x {x_px};")
            cmd_lines.append(f"{t:.3f} {crop_name} y {y_px};")
        cmd_path = _build_sendcmd_file(job_id, i, "crop", cmd_lines)
        temp_files.append(cmd_path)

        # Tile placement on the canvas — position keyframes drive scale2ref
        # target size via a per-segment `overlay` sendcmd too (x/y only; w/h
        # of an overlay isn't live-adjustable, so size changes use the
        # NEAREST preceding keyframe's size, applied via a fixed `scale`
        # ahead of overlay — smooth size ramps are therefore coarser than
        # position pans in this MVP, which is an acceptable trade for "total
        # freedom over position/crop/zoom" without a per-frame filtergraph).
        w0 = _clamp01(float(pos_kf[0].get("w", 1.0))) or (1.0 / len(resolved))
        h0 = _clamp01(float(pos_kf[0].get("h", 1.0))) or 1.0
        tile_w = max(16, int(CANVAS_W * w0))
        tile_h = max(16, int(CANVAS_H * h0))

        overlay_name = f"overlay_track{i}"
        pos_lines = []
        x0_px = y0_px = 0
        for idx, kf in enumerate(sorted(pos_kf, key=lambda k: float(k.get("t", 0)))):
            t = float(kf.get("t", 0))
            # x/y are the tile's LEFT/TOP edge as a fraction of the canvas
            # (matching the frontend's applyMashupLayout(), which places e.g.
            # a side-by-side track at x=0.5 meaning "start at the halfway
            # point" — not a 0..1 position within the leftover drag range).
            # Clamping the pixel result (not just the fraction) keeps a tile
            # on-canvas even if a keyframe's x would otherwise push it
            # partly outside at this tile's current width.
            x = _clamp01(float(kf.get("x", 0.0)))
            y = _clamp01(float(kf.get("y", 0.0)))
            x_px = max(0, min(CANVAS_W - tile_w, int(x * CANVAS_W)))
            y_px = max(0, min(CANVAS_H - tile_h, int(y * CANVAS_H)))
            if idx == 0:
                x0_px, y0_px = x_px, y_px
            pos_lines.append(f"{t:.3f} {overlay_name} x {x_px};")
            pos_lines.append(f"{t:.3f} {overlay_name} y {y_px};")
        pos_cmd_path = _build_sendcmd_file(job_id, i, "overlay", pos_lines)
        temp_files.append(pos_cmd_path)
        overlay_meta.append((overlay_name, pos_cmd_path, x0_px, y0_px))

        muted = bool(track.get("mute"))
        filter_parts.append(
            f"[{i}:v]sendcmd=f='{_filter_path(cmd_path)}',"
            f"crop@{crop_name}=w={crop_w_px}:h={crop_h_px}:x={cx0 * src_w - crop_w_px/2:.0f}:y={cy0 * src_h - crop_h_px/2:.0f},"
            f"scale={tile_w}:{tile_h}[vt{i}]"
        )
        if not muted:
            filter_parts.append(f"[{i}:a]anull[at{i}]")

    # Composite: base canvas, then overlay each track in order. `sendcmd`
    # only accepts a single input pad — it cannot sit directly on `overlay`'s
    # two-input join — so each track's position sendcmd runs as its own
    # single-pad stage on the running `chain` stream first, and the resulting
    # (command-annotated) stream is what `overlay` then joins with `[vt{i}]`.
    filter_parts.append(f"color=c=black:s={CANVAS_W}x{CANVAS_H}:d={out_dur}[base]")
    chain = "base"
    for i, (overlay_name, pos_cmd_path, x0_px, y0_px) in enumerate(overlay_meta):
        next_label = f"ov{i}"
        cmd_label = f"ovcmd{i}"
        filter_parts.append(f"[{chain}]sendcmd=f='{_filter_path(pos_cmd_path)}'[{cmd_label}]")
        # x0_px/y0_px seed the overlay's OWN initial position — without this,
        # every overlay instance defaults to x=0:y=0 until its first sendcmd
        # fires, and if that first command lands a frame or two late (timing
        # is not guaranteed to align with frame 0), every track after the
        # first briefly (or, if it never catches up in a short render,
        # permanently) draws on top of x=0:y=0 instead of its real slot —
        # which is exactly why track 2 rendered fully hidden behind track 1
        # instead of beside it.
        filter_parts.append(f"[{cmd_label}][vt{i}]overlay@{overlay_name}=x={x0_px}:y={y0_px}[{next_label}]")
        chain = next_label
    filter_parts.append(f"[{chain}]null[vout]")

    # Audio: which track is active over time. `active_track_keyframes`:
    # [{"t": seconds, "track": index}]. Between switches, crossfade the
    # outgoing/incoming track's volume over CROSSFADE_SEC.
    audio_kf = spec.get("audio_track_keyframes") or [{"t": 0, "track": 0}]
    audio_labels = [f"at{i}" for i, t in enumerate(resolved) if not t.get("mute")]
    if audio_labels:
        vol_lines_by_track: dict[int, list[str]] = {i: [] for i in range(len(resolved))}
        switches = sorted(audio_kf, key=lambda k: float(k.get("t", 0)))
        for seg_idx, kf in enumerate(switches):
            t = float(kf.get("t", 0))
            active = int(kf.get("track", 0))
            for i in range(len(resolved)):
                vol_lines_by_track.setdefault(i, [])
                target = 1.0 if i == active else 0.0
                vol_name = f"volume_track{i}"
                vol_lines_by_track[i].append(f"{max(0.0, t - CROSSFADE_SEC/2):.3f} {vol_name} volume {1.0 - target:.2f};")
                vol_lines_by_track[i].append(f"{t + CROSSFADE_SEC/2:.3f} {vol_name} volume {target:.2f};")
        for i in range(len(resolved)):
            if resolved[i].get("mute"):
                continue
            vol_cmd = _build_sendcmd_file(job_id, i, "volume", vol_lines_by_track.get(i) or ["0.000 volume volume 1.00;"])
            temp_files.append(vol_cmd)
            # asendcmd (not sendcmd) — sendcmd is video-only and rejects an
            # audio input pad; the "too many inputs" / crop-vs-overlay issue
            # above was a video-graph mistake, this is the audio-side
            # counterpart of the same fix.
            filter_parts.append(f"[at{i}]asendcmd=f='{_filter_path(vol_cmd)}',volume@volume_track{i}=1[avt{i}]")
        mix_inputs = "".join(f"[avt{i}]" for i in range(len(resolved)) if not resolved[i].get("mute"))
        n = sum(1 for t in resolved if not t.get("mute"))
        filter_parts.append(f"{mix_inputs}amix=inputs={n}:normalize=0[aout]")
        has_audio = True
    else:
        has_audio = False

    filter_complex = ";".join(filter_parts)

    ts = int(time.time())
    out_name = f"mashup_{job_id}_{ts}_{uuid.uuid4().hex[:8]}.mp4"
    out_path = os.path.join(MASHUP_DIR, out_name)

    cmd = [_ffmpeg(), "-y", "-hide_banner", "-loglevel", "error", *input_args,
           "-filter_complex", filter_complex, "-map", "[vout]"]
    if has_audio:
        cmd += ["-map", "[aout]"]
    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
            "-t", str(out_dur), out_path]

    _progress(db, job_id, 40)
    rc, _, err = await _run(cmd, timeout=1800)

    for path in temp_files:
        try:
            os.remove(path)
        except OSError:
            pass

    if rc != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) < 64_000:
        raise RuntimeError((err or b"").decode(errors="ignore").strip()[:500] or "ffmpeg zlyhal")

    _progress(db, job_id, 95)
    return f"/static/mashups/{out_name}"
