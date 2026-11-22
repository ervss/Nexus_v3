"""Managed local Tor runtime used by Nexus network-aware hubs.

The service intentionally owns only a Tor process that it started itself.  An
already-running Tor instance is detected and used, but never terminated by
Nexus.  This keeps normal ``python -m app.main`` startup self-contained without
making the dashboard a generic process killer.
"""
from __future__ import annotations

import logging
import os
import re
import socket
import subprocess
import threading
import time
from pathlib import Path
from typing import Optional


logger = logging.getLogger(__name__)
_TRUE = {"1", "true", "yes", "on"}


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    return default if value is None else value.strip().lower() in _TRUE


def _path_from_env(name: str) -> Optional[Path]:
    raw = (os.getenv(name) or "").strip().strip('"')
    if not raw:
        return None
    return Path(os.path.expandvars(raw)).expanduser()


class TorService:
    """Discover, start, probe and stop Nexus' local Tor process."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._process: Optional[subprocess.Popen] = None
        self._started_by_nexus = False
        self._last_error = ""
        self._last_identity_at: Optional[float] = None
        self._started_at: Optional[float] = None

    @property
    def enabled(self) -> bool:
        # Existing EPORNER_USE_TOR installations become self-starting without a
        # mandatory .env migration. TOR_ENABLED remains the canonical override.
        fallback = (os.getenv("EPORNER_USE_TOR") or "").strip().lower() in _TRUE
        mega_uses_tor = (os.getenv("MEGA_PROXY_MODE") or "").strip().lower() == "tor"
        return _env_bool("TOR_ENABLED", fallback) or mega_uses_tor

    @property
    def auto_start(self) -> bool:
        return _env_bool("TOR_AUTO_START", self.enabled)

    @property
    def stop_on_shutdown(self) -> bool:
        return _env_bool("TOR_STOP_ON_SHUTDOWN", True)

    @property
    def socks_address(self) -> tuple[str, int]:
        return (
            (os.getenv("TOR_SOCKS_HOST") or "127.0.0.1").strip(),
            int(os.getenv("TOR_SOCKS_PORT") or "9050"),
        )

    @property
    def control_address(self) -> tuple[str, int]:
        return (
            (os.getenv("TOR_CONTROL_HOST") or "127.0.0.1").strip(),
            int(os.getenv("TOR_CONTROL_PORT") or "9051"),
        )

    @property
    def control_password(self) -> str:
        return os.getenv("TOR_CONTROL_PASSWORD") or os.getenv("EPORNER_TOR_CONTROL_PW") or ""

    def config_path(self) -> Path:
        return _path_from_env("TOR_CONFIG_PATH") or (Path.home() / ".nexus-tor" / "torrc")

    def executable_path(self) -> Optional[Path]:
        configured = _path_from_env("TOR_EXECUTABLE")
        if configured and configured.is_file():
            return configured

        # Reuse the executable recorded by the existing Nexus launcher.  Parsing
        # the batch file avoids baking a user-specific Desktop path into code.
        launcher = Path.home() / ".nexus-tor" / "start-nexus-tor.bat"
        if launcher.is_file():
            try:
                text = launcher.read_text(encoding="utf-8", errors="ignore")
                match = re.search(r'"([^"\r\n]*tor\.exe)"', text, re.IGNORECASE)
                if match:
                    candidate = Path(os.path.expandvars(match.group(1))).expanduser()
                    if candidate.is_file():
                        return candidate
            except OSError:
                pass

        candidates = [
            Path.home() / "Desktop" / "PLOCHA" / "Tor Browser" / "Browser" / "TorBrowser" / "Tor" / "tor.exe",
            Path.home() / "Desktop" / "Tor Browser" / "Browser" / "TorBrowser" / "Tor" / "tor.exe",
            Path(os.getenv("LOCALAPPDATA") or "") / "Tor Browser" / "Browser" / "TorBrowser" / "Tor" / "tor.exe",
        ]
        return next((path for path in candidates if path.is_file()), None)

    @staticmethod
    def _port_open(address: tuple[str, int], timeout: float = 0.7) -> bool:
        try:
            with socket.create_connection(address, timeout=timeout):
                return True
        except OSError:
            return False

    @staticmethod
    def _read_reply(stream) -> list[str]:
        lines: list[str] = []
        while len(lines) < 64:
            raw = stream.readline()
            if not raw:
                break
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            lines.append(line)
            if line.startswith(("4", "5")) or line == "250 OK":
                break
        return lines

    def _control(self, command: str) -> list[str]:
        host, port = self.control_address
        with socket.create_connection((host, port), timeout=1.5) as sock:
            sock.settimeout(1.5)
            stream = sock.makefile("rwb", buffering=0)
            password = self.control_password.replace("\\", "\\\\").replace('"', '\\"')
            auth = f'AUTHENTICATE "{password}"' if password else "AUTHENTICATE"
            stream.write((auth + "\r\n").encode("utf-8"))
            auth_reply = self._read_reply(stream)
            if not auth_reply or any(line.startswith(("4", "5")) for line in auth_reply):
                raise RuntimeError("Tor control authentication failed")
            stream.write((command + "\r\n").encode("utf-8"))
            reply = self._read_reply(stream)
            if not reply or any(line.startswith(("4", "5")) for line in reply):
                raise RuntimeError("Tor control command failed")
            return reply

    def status(self) -> dict:
        with self._lock:
            process_running = bool(self._process and self._process.poll() is None)
            socks_ready = self._port_open(self.socks_address)
            control_ready = False
            circuit_established = False
            # A SOCKS listener opens very early in Tor's bootstrap. It must not
            # be mistaken for a usable exit circuit; the control port is the
            # authoritative readiness signal.
            bootstrap_percent = 0
            if self._port_open(self.control_address):
                try:
                    reply = self._control("GETINFO status/bootstrap-phase status/circuit-established")
                    control_ready = True
                    joined = " ".join(reply)
                    progress = re.search(r"PROGRESS=(\d+)", joined)
                    if progress:
                        bootstrap_percent = int(progress.group(1))
                    circuit_established = "status/circuit-established=1" in joined
                except Exception as exc:  # noqa: BLE001
                    logger.debug("Tor control probe failed: %s", exc)

            executable = self.executable_path()
            config = self.config_path()
            ready = socks_ready and control_ready and (
                circuit_established or bootstrap_percent >= 100
            )
            return {
                "enabled": self.enabled,
                "auto_start": self.auto_start,
                "configured": bool(executable and config.is_file()),
                "ready": ready,
                "socks_ready": socks_ready,
                "control_ready": control_ready,
                "circuit_established": circuit_established,
                "bootstrap_percent": bootstrap_percent,
                "process_running": process_running or socks_ready,
                "managed_by_nexus": bool(process_running and self._started_by_nexus),
                "pid": self._process.pid if process_running else None,
                "socks": f"{self.socks_address[0]}:{self.socks_address[1]}",
                "control": f"{self.control_address[0]}:{self.control_address[1]}",
                "executable_found": bool(executable),
                "config_found": config.is_file(),
                "started_at": self._started_at,
                "last_identity_at": self._last_identity_at,
                "last_error": self._last_error,
            }

    def start(self, wait_seconds: float = 90.0) -> dict:
        with self._lock:
            if not self.enabled:
                self._last_error = "Tor is disabled by configuration"
                return self.status()
            current = self.status()
            if current["ready"]:
                self._last_error = ""
                return current

            executable = self.executable_path()
            config = self.config_path()
            if not executable:
                self._last_error = "tor.exe was not found"
                return self.status()
            if not config.is_file():
                self._last_error = f"Tor config was not found: {config}"
                return self.status()
            if self._process and self._process.poll() is None:
                process = self._process
            else:
                creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
                try:
                    process = subprocess.Popen(
                        [str(executable), "-f", str(config)],
                        cwd=str(executable.parent),
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        creationflags=creationflags,
                    )
                except OSError as exc:
                    self._last_error = f"Could not start tor.exe: {exc}"
                    logger.warning(self._last_error)
                    return self.status()
                self._process = process
                self._started_by_nexus = True
                self._started_at = time.time()
                self._last_error = ""
                logger.info("Started managed Tor process (pid=%s)", process.pid)

        deadline = time.monotonic() + max(1.0, wait_seconds)
        while time.monotonic() < deadline:
            if process.poll() is not None:
                with self._lock:
                    self._last_error = f"Tor exited during startup (code {process.returncode})"
                break
            state = self.status()
            if state["ready"]:
                logger.info("Tor is ready on %s", state["socks"])
                return state
            time.sleep(0.35)

        state = self.status()
        if not state["ready"] and not self._last_error:
            self._last_error = f"Tor did not become ready within {int(wait_seconds)} seconds"
        return self.status()

    def new_identity(self) -> dict:
        with self._lock:
            try:
                self._control("SIGNAL NEWNYM")
                self._last_identity_at = time.time()
                self._last_error = ""
                logger.info("Requested a new Tor identity")
            except Exception as exc:  # noqa: BLE001
                self._last_error = str(exc)
        return self.status()

    def stop(self, wait_seconds: float = 10.0) -> dict:
        with self._lock:
            process = self._process
            if not process or process.poll() is not None or not self._started_by_nexus:
                return self.status()
            try:
                self._control("SIGNAL SHUTDOWN")
            except Exception:  # noqa: BLE001
                process.terminate()

        try:
            process.wait(timeout=wait_seconds)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        finally:
            with self._lock:
                self._process = None
                self._started_by_nexus = False
                self._started_at = None
        logger.info("Managed Tor process stopped")
        return self.status()

    def shutdown(self) -> None:
        if self.stop_on_shutdown:
            self.stop()


tor_service = TorService()
