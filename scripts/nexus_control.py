"""Local control and bounded status snapshots for the Windows tray (no watchdog)."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
import urllib.request
from contextlib import contextmanager

import psutil

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.nexus_server import atomic_json


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def directory() -> Path:
    return ROOT / "logs" / "server"


@contextmanager
def command_lock(port: int):
    """Serialize lifecycle commands across scripts and multiple clients."""
    directory().mkdir(parents=True, exist_ok=True)
    with (directory() / f"control-{port}.lock").open("a+b") as lock:
        if lock.seek(0, 2) == 0:
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise RuntimeError("Iný príkaz už prebieha; počkaj na jeho dokončenie.") from exc
        try:
            yield
        finally:
            lock.seek(0)
            if os.name == "nt":
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def owned_process(pid: int | None, created: float | None = None) -> psutil.Process | None:
    """Reject recycled PIDs and commands belonging to another checkout."""
    try:
        process = psutil.Process(int(pid))
        if created is not None and abs(process.create_time() - float(created)) > .01:
            return None
        runner = (ROOT / "scripts" / "nexus_server.py").resolve()
        # Python may expose the supervisor's script argument as a relative path
        # (the Windows launcher starts it with cwd=ROOT), while the worker uses
        # an absolute path. Resolve relative arguments against that process's
        # cwd lazily so absolute paths do not require cwd() access.
        cached_cwd: Path | None = None

        def _resolve_arg(arg: str) -> Path:
            nonlocal cached_cwd
            candidate = Path(arg)
            if candidate.is_absolute():
                return candidate.resolve()
            if cached_cwd is None:
                cwd_fn = getattr(process, "cwd", None)
                cached_cwd = Path(cwd_fn()) if callable(cwd_fn) else ROOT
            return (cached_cwd / candidate).resolve()

        if not any(_resolve_arg(arg) == runner for arg in process.cmdline()):
            return None
        return process
    except (psutil.Error, TypeError, ValueError):
        return None


def validate_state(state: dict, port: int) -> psutil.Process | None:
    if state.get("port") != port:
        return None
    if state.get("root") and Path(state["root"]).resolve() != ROOT.resolve():
        return None
    process = owned_process(state.get("supervisor_pid"), state.get("supervisor_created"))
    if process:
        try:
            args = process.cmdline()
            if "--worker" in args or "--port" not in args or args[args.index("--port") + 1] != str(port):
                return None
        except (psutil.Error, ValueError, IndexError):
            return None
    return process


def live_matches(reply: dict, state: dict, supervisor: psutil.Process | None) -> bool:
    if not supervisor or reply.get("service") != "nexus":
        return False
    if state.get("instance") and reply.get("instance") != state["instance"]:
        return False
    try:
        # Windows virtualenv python.exe can be a launcher with a child process.
        worker = owned_process(state.get("worker_pid"), state.get("worker_created"))
        if not worker or worker.pid not in [p.pid for p in supervisor.children(recursive=True)]:
            return False
        return int(reply.get("pid", -1)) in [worker.pid, *[p.pid for p in worker.children(recursive=True)]]
    except (psutil.Error, TypeError, ValueError):
        return False


def get_live(port: int) -> dict:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/_nexus/live", timeout=2) as response:
            return json.load(response)
    except (OSError, ValueError):
        return {}


def clean_text(value: object) -> str:
    """Keep diagnostics useful without exposing credentials or URL tokens."""
    text = str(value)
    text = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", text)
    text = re.sub(r"https?://[^\s<>\"']+", "[URL]", text, flags=re.I)
    text = re.sub(r"(?i)\b([\w-]*(?:authorization|cookie|password|passwd|token|secret|api[_-]?key))\b[\"']?\s*[:=]\s*.*", r"\1=[skryté]", text)
    text = re.sub(r"(?i)\bBearer\s+\S+", "Bearer [skryté]", text)
    text = re.sub(r"[\r\n\t]+", " ", text)
    return text[:400]


def recent_activity(port: int) -> list[dict]:
    try:
        url = f"http://127.0.0.1:{port}/api/v1/events/recent?topics=health.progress,pipeline.flow,job.state,log&limit=30"
        with urllib.request.urlopen(url, timeout=2) as response:
            events = json.load(response).get("events", [])
        result = []
        for event in events:
            message = clean_text(event.get("message") or event.get("state") or event.get("topic", ""))
            if message and "/_nexus/live" not in message and "GET /health" not in message:
                result.append({"message": message, "ts": event.get("ts"), "topic": event.get("topic")})
        return result[-2:]
    except (OSError, ValueError, AttributeError, TypeError):
        return []


def tail_logs(port: int) -> list[dict]:
    path = directory() / f"supervisor-{port}.log"
    try:
        with path.open("rb") as source:
            source.seek(max(0, path.stat().st_size - 16384))
            lines = source.read(16384).decode("utf-8", errors="replace").splitlines()
        lines = [line for line in lines if line.strip() and not re.search(
            r'GET /(_nexus/live|health)|HTTP/\d|WebSocket /|connection (open|closed)|^Traceback|^\s+File ', line)]
        # Log fallback has no reliable progress timestamp; don't invent one from mtime.
        return [{"message": clean_text(line), "ts": None, "topic": "log"} for line in lines[-2:]]
    except OSError:
        return []


def classify(state: dict, process_alive: bool, live_ok: bool, previous: dict, now: float) -> dict:
    same = previous.get("instance") == state.get("instance") and previous.get("supervisor_pid") == state.get("supervisor_pid")
    misses = 0 if live_ok else (int(previous.get("misses", 0)) if same else 0) + 1
    phase = state.get("phase", "starting")
    last = now if live_ok else state.get("last_success") or (previous.get("last_success") if same else None)
    if not process_alive:
        color, label, advice = "red", "Obnova zlyhala" if phase == "failed" else "Vypnutý", "Skontroluj logy." if phase == "failed" else "Server môžeš zapnúť."
    elif phase in ("stopping", "stop_failed"):
        color, label, advice = "orange", "Zastavuje sa" if phase == "stopping" else "Zastavenie neuspelo", "Počkaj na zastavenie." if phase == "stopping" else "Vynútenie preruší rozpracované úlohy."
    elif live_ok:
        color, label, advice = "green", "Beží", "Server odpovedá; môžeš ho nechať pracovať."
    elif phase == "recovering":
        color, label, advice = "orange", "Obnovuje sa", "Prebieha automatická obnova."
    elif phase == "starting" and not last:
        color, label, advice = "orange", "Štartuje", "Počkaj na štart."
    elif misses >= 3 or phase == "unresponsive":
        color, label, advice = "orange", "Neodpovedá", "Dohľad kontroluje server; pozri posledné logy."
    else:
        color, label, advice = "green", "Overujem odpoveď", "Krátky výpadok odpovede; prebieha kontrola."
    return {"color": color, "label": label, "advice": advice, "misses": misses, "last_success": last}


def status(port: int) -> dict:
    active = read_json(directory() / f"supervisor-{port}.json")
    supervisor = validate_state(active, port)
    previous = read_json(directory() / f"tray-status-{port}.json")
    state = active if supervisor else read_json(directory() / f"outcome-{port}.json")
    reply = get_live(port)
    ok = live_matches(reply, active, supervisor)
    now = time.time()
    result = classify(state, bool(supervisor), ok, previous, now)
    same = previous.get("instance") == state.get("instance")
    events = recent_activity(port) if ok else []
    from_bus = bool(events)
    if not events and (not ok or previous.get("events_from_bus")):
        events = previous.get("events", []) if same else []
        from_bus = bool(events) and bool(previous.get("events_from_bus"))
    if not events:
        events = tail_logs(port)
    conflict = (bool(reply) and not ok) or (not supervisor and port_busy(port))
    if conflict:
        result.update(color="orange", label="Neoverený server", advice="Port používa iná alebo staršia inštancia; automaticky ju neukončujem.")
    result.update(port=port, mode=state.get("mode", "classic"), phase=state.get("phase", "running" if ok else "starting" if supervisor else "stopped"),
                  instance=state.get("instance"), supervisor_pid=state.get("supervisor_pid"),
                  managed=bool(supervisor), live_ok=ok, stale=not ok, conflict=conflict,
                  legacy=bool(supervisor) and active.get("version") != 2,
                  events=events, events_from_bus=from_bus, last_error=clean_text(state.get("last_error", "")),
                  restart_count=state.get("restart_count", 0), checked_at=now)
    directory().mkdir(parents=True, exist_ok=True)
    atomic_json(directory() / f"tray-status-{port}.json", result)
    return result


def port_busy(port: int) -> bool:
    with socket.socket() as probe:
        probe.settimeout(.5)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def start(port: int, mode: str) -> dict:
    state = read_json(directory() / f"supervisor-{port}.json")
    if validate_state(state, port):
        return {"ok": True, "message": "Dohľad už beží."}
    if port_busy(port):
        raise RuntimeError(f"Port {port} je obsadený; cudzí proces nezastavujem.")
    directory().mkdir(parents=True, exist_ok=True)
    with (directory() / f"supervisor-launch-{port}.log").open("a", encoding="utf-8") as output:
        process = subprocess.Popen([sys.executable, str(ROOT / "scripts" / "nexus_server.py"), "--mode", mode, "--port", str(port)],
                                   cwd=ROOT, stdout=output, stderr=output,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    # Wait only for ownership publication; the UI shows the ongoing startup.
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        state = read_json(directory() / f"supervisor-{port}.json")
        if validate_state(state, port):
            return {"ok": True, "message": "Nexus štartuje."}
        if process.poll() is not None:
            raise RuntimeError("Dohľad sa nespustil; pozri supervisor-launch log.")
        time.sleep(.1)
    raise RuntimeError("Dohľad nepotvrdil štart; pozri logy pred ďalším pokusom.")


def force_owned_tree(supervisor: psutil.Process, state: dict) -> None:
    """Legacy-only fallback: suspend owner before killing its verified tree."""
    current = validate_state(state, state["port"])
    if not current or current.create_time() != supervisor.create_time():
        raise RuntimeError("Identita dohľadu sa zmenila; ukončenie zrušené.")
    supervisor.suspend()
    try:
        children = supervisor.children(recursive=True)
        for process in reversed(children):
            try:
                process.kill()
            except psutil.NoSuchProcess:
                pass
        supervisor.kill()
        psutil.wait_procs([supervisor, *children], timeout=10)
    finally:
        try:
            supervisor.resume()
        except psutil.NoSuchProcess:
            pass


def stop(port: int, force: bool = False) -> dict:
    state = read_json(directory() / f"supervisor-{port}.json")
    supervisor = validate_state(state, port)
    if not supervisor:
        if port_busy(port):
            raise RuntimeError("Server nemá overený dohľad; cudzí ani neoverený proces nezastavujem.")
        return {"ok": True, "message": "Nexus je vypnutý."}
    if state.get("version") != 2:
        if not force:
            return {"ok": False, "needs_force": True, "message": "Starší dohľad nepodporuje šetrné zastavenie. Vynútenie preruší úlohy."}
        force_owned_tree(supervisor, state)
        if port_busy(port):
            raise RuntimeError("Port je stále obsadený; nový server nespúšťam.")
        (directory() / f"supervisor-{port}.json").unlink(missing_ok=True)
        atomic_json(directory() / f"outcome-{port}.json", dict(state, phase="stopped", updated_at=time.time()))
        return {"ok": True, "message": "Starší Nexus bol zastavený."}
    # Supervisor owns the Popen handle and will kill only that tree on confirmation.
    if force:
        (directory() / f"force-stop-{port}").write_text(state["instance"], encoding="utf-8")
    (directory() / f"stop-{port}").write_text("stop", encoding="utf-8")
    deadline = time.monotonic() + (40 if force else 20)
    while time.monotonic() < deadline:
        current = read_json(directory() / f"supervisor-{port}.json")
        if not validate_state(current, port):
            if port_busy(port):
                raise RuntimeError("Port zostal obsadený; nový server nespúšťam.")
            return {"ok": True, "message": "Nexus bol zastavený."}
        if current.get("supervisor_pid") != state["supervisor_pid"] or current.get("instance") != state["instance"]:
            raise RuntimeError("Inštancia sa zmenila; ovládanie bolo zrušené.")
        if not force and current.get("phase") == "stop_failed":
            return {"ok": False, "needs_force": True, "message": "Server sa nezastavil do 15 sekúnd. Vynútenie preruší úlohy."}
        time.sleep(.2)
    return {"ok": False, "needs_force": not force, "message": "Dohľad nepotvrdil zastavenie. Skontroluj logy."}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("status", "start", "stop", "restart"))
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--mode", choices=("classic", "lite"), default="classic")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.port <= 55535:
        parser.error("port must leave room for the supervisor guard (+10000)")
    try:
        if args.command == "status":
            result = status(args.port)
        else:
            with command_lock(args.port):
                if args.command == "start":
                    result = start(args.port, args.mode)
                else:
                    active = read_json(directory() / f"supervisor-{args.port}.json")
                    mode = active.get("mode", args.mode)
                    result = stop(args.port, args.force)
                    if args.command == "restart" and result.get("ok"):
                        result = start(args.port, mode)
    except Exception as exc:
        result = {"ok": False, "message": clean_text(exc)}
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
    return 1 if result.get("ok") is False else 0


if __name__ == "__main__":
    sys.exit(main())
