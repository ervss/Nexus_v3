"""Application-wide logging: optional JSON lines + request id via context."""
from __future__ import annotations

import atexit
import datetime as _dt
import json
import logging
import os
from pathlib import Path
import sys
import threading
from typing import Any

from .request_context import request_id_ctx

_TEE_INSTALLED = False
_TEE_FILES: list[Any] = []
_TEE_LOCK = threading.RLock()


class _TeeStream:
    """Mirror writes to the original terminal stream and persistent log files."""

    def __init__(self, original: Any, files: list[Any]):
        self._original = original
        self._files = files
        self.encoding = getattr(original, "encoding", "utf-8")
        self.errors = getattr(original, "errors", "replace")

    def write(self, data: str) -> int:
        if not data:
            return 0
        with _TEE_LOCK:
            # Windows terminals often use cp1250/cp1252. A remote title may
            # contain another Unicode character; do not turn an info log into
            # a recursive logging error that floods the terminal.
            try:
                self._original.write(data)
                self._original.flush()
            except UnicodeEncodeError:
                encoding = getattr(self._original, "encoding", None) or "utf-8"
                safe_data = data.encode(encoding, errors="replace").decode(encoding, errors="replace")
                try:
                    self._original.write(safe_data)
                    self._original.flush()
                except Exception:
                    pass
            for handle in list(self._files):
                try:
                    handle.write(data)
                    handle.flush()
                except Exception:
                    pass
        return len(data)

    def flush(self) -> None:
        with _TEE_LOCK:
            self._original.flush()
            for handle in list(self._files):
                try:
                    handle.flush()
                except Exception:
                    pass

    def isatty(self) -> bool:
        return bool(getattr(self._original, "isatty", lambda: False)())

    def fileno(self) -> int:
        return self._original.fileno()


def _close_tee_files() -> None:
    with _TEE_LOCK:
        for handle in list(_TEE_FILES):
            try:
                handle.flush()
                handle.close()
            except Exception:
                pass
        _TEE_FILES.clear()


def _install_terminal_log_tee() -> str:
    """Capture complete process stdout/stderr regardless of how uvicorn starts."""
    global _TEE_INSTALLED
    if _TEE_INSTALLED:
        return os.getenv("NEXUS_SERVER_LOG_FILE", "")

    enabled = os.getenv("LOG_TO_FILE", "true").strip().lower() not in {"0", "false", "no", "off"}
    if not enabled:
        return ""

    log_dir = Path(os.getenv("LOG_DIR", "logs/server")).expanduser()
    if not log_dir.is_absolute():
        log_dir = Path.cwd() / log_dir
    log_dir.mkdir(parents=True, exist_ok=True)

    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    pid = os.getpid()
    session_path = log_dir / f"server-{stamp}-pid{pid}.log"
    # A developer may run the dashboard and an isolated verification server
    # from the same checkout at once. Keeping their convenience logs separate
    # prevents one process from truncating a file while the other still has an
    # open handle (which produced large NUL-filled gaps on Windows).
    port = os.getenv("NEXUS_SERVER_PORT", "").strip()
    if not port:
        try:
            port_index = sys.argv.index("--port")
            port = str(sys.argv[port_index + 1]).strip()
        except (ValueError, IndexError):
            port = ""
    latest_name = f"latest-{port}.log" if port else "latest.log"
    latest_path = log_dir / latest_name

    session_handle = session_path.open("a", encoding="utf-8", buffering=1)
    # Append is intentional. With uvicorn --reload, the replacement worker can
    # start before the previous worker has fully released its file handle.
    # Truncating here leaves the old handle positioned past EOF and its next
    # write creates a sparse/NUL-filled log. Session files remain one-per-run;
    # the convenience log is a readable rolling history across reloads.
    latest_handle = latest_path.open("a", encoding="utf-8", buffering=1)
    _TEE_FILES.extend([session_handle, latest_handle])
    os.environ["NEXUS_SERVER_LOG_FILE"] = str(session_path)
    os.environ["NEXUS_SERVER_LATEST_LOG_FILE"] = str(latest_path)

    sys.stdout = _TeeStream(sys.stdout, _TEE_FILES)  # type: ignore[assignment]
    sys.stderr = _TeeStream(sys.stderr, _TEE_FILES)  # type: ignore[assignment]
    _TEE_INSTALLED = True
    atexit.register(_close_tee_files)

    print(f"\n[Nexus logging] process start: {stamp} pid={pid} port={port or 'unknown'}")
    print(f"[Nexus logging] terminal log: {session_path}")
    print(f"[Nexus logging] latest log:   {latest_path}")
    return str(session_path)


class _RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            record.request_id = request_id_ctx.get()  # type: ignore[attr-defined]
        except LookupError:
            record.request_id = "-"
        return True


# High-frequency polling endpoints (browser-extension bridge, radar, health)
# that otherwise flood the terminal with an endless repeated access-log line.
# Silencing just these keeps the console readable without hiding real traffic.
_NOISY_ACCESS_PATHS = (
    "/static/placeholder.jpg",
    "/api/v1/bridge/ping",
    "/bridge/ping",
    "/api/v1/radar/check",
    "/radar/check",
    "/health",
    "/api/v1/dashboard/import-monitor",
)
_NOISY_ACCESS_PREFIXES = (
    "/api/v1/intake/jobs/",
)


class _AccessLogNoiseFilter(logging.Filter):
    """Drop uvicorn access-log records for chatty polling/static endpoints.

    uvicorn formats access records with args = (client, method, path, http_ver,
    status); the request target is args[2]. We match on that so query strings
    don't defeat the filter.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 5:
            method = str(args[1]).upper()
            target = str(args[2])
            path = target.split("?", 1)[0]
            status = int(args[4])
            is_noisy = path in _NOISY_ACCESS_PATHS or path.startswith(_NOISY_ACCESS_PREFIXES)
            # Hide only successful polling. A 4xx/5xx must remain visible in
            # the terminal because it is actionable, unlike a repeated 200 GET.
            if method == "GET" and is_noisy and 200 <= status < 300:
                return False
        return True


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "request_id": getattr(record, "request_id", "-"),
        }
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def configure_logging(level: str, json_format: bool) -> None:
    log_file = _install_terminal_log_tee()

    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    handler = logging.StreamHandler(sys.stdout)
    if json_format:
        handler.setFormatter(_JsonFormatter())
    else:
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s [%(request_id)s] %(name)s: %(message)s")
        )
    handler.addFilter(_RequestIdFilter())
    root.addHandler(handler)
    if log_file:
        root.info("Persistent terminal logging enabled: %s", log_file)

    # Reduce noise from libraries in non-debug
    if getattr(logging, level.upper(), logging.INFO) > logging.DEBUG:
        logging.getLogger("httpx").setLevel(logging.WARNING)
        logging.getLogger("httpcore").setLevel(logging.WARNING)
        logging.getLogger("urllib3").setLevel(logging.WARNING)
        # Telethon reports optional native crypto acceleration at INFO using
        # alarming "Failed to load" wording. Its Python fallback is valid;
        # real Telethon warnings/errors remain visible.
        logging.getLogger("telethon.crypto.libssl").setLevel(logging.WARNING)
        logging.getLogger("telethon.crypto.aes").setLevel(logging.WARNING)

    # Silence only successful, high-frequency polling access lines. The filter
    # lives on the access logger so errors and normal traffic remain visible.
    _access = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, _AccessLogNoiseFilter) for f in _access.filters):
        _access.addFilter(_AccessLogNoiseFilter())
