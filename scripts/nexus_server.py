"""Single-worker Nexus runner and independent, bounded health supervisor."""
import argparse
import asyncio
import faulthandler
import importlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request
import uuid
from contextlib import suppress

import psutil

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def atomic_json(path, value):
    """Publish a complete snapshot, including for concurrent tray readers."""
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)


def creation_time(pid):
    try:
        return psutil.Process(pid).create_time()
    except psutil.Error:
        return None


def request_graceful_stop(child, marker, instance, timeout=15):
    """Ask our worker to shut down; never force a manual stop implicitly."""
    marker.write_text(instance, encoding="utf-8")
    deadline = time.monotonic() + timeout
    while child.poll() is None and time.monotonic() < deadline:
        time.sleep(.1)
    return child.poll() is not None


def healthy(port, instance=None):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/_nexus/live", timeout=2) as response:
            data = json.load(response)
        return data.get("service") == "nexus" and (instance is None or data.get("instance") == instance)
    except Exception:
        return False


def stop_worker(child):
    """Stop the owned tree, including Windows virtualenv launchers and browsers."""
    if child.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
    else:
        child.terminate()
    try:
        child.wait(timeout=15)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()


async def serve(mode, port):
    # Proactor supports Playwright subprocesses on Windows; no reload supervisor.
    probe = await asyncio.create_subprocess_exec(
        sys.executable, "-c", "pass", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if await asyncio.wait_for(probe.wait(), 10) != 0:
        raise RuntimeError("Subprocess startup probe failed")
    import uvicorn
    application = importlib.import_module("app.main" if mode == "classic" else "app.lite_app").app
    application.state.nexus_stacks = int(os.environ["NEXUS_STACK_FD"])

    @application.get("/_nexus/live", include_in_schema=False)
    async def live():
        faulthandler.cancel_dump_traceback_later()
        faulthandler.dump_traceback_later(10, file=application.state.nexus_stacks)
        return {"service": "nexus", "pid": os.getpid(), "mode": mode,
                "instance": os.environ.get("NEXUS_WORKER_INSTANCE", "")}

    try:
        from app.config import config
        host = config.SERVER_HOST
    except ImportError:
        host = "127.0.0.1"
    server = uvicorn.Server(uvicorn.Config(application, host=host, port=port,
                                         timeout_graceful_shutdown=15))
    marker = ROOT / "logs" / "server" / f"worker-stop-{port}"

    async def watch_stop():
        while True:
            try:
                if marker.read_text(encoding="utf-8").strip() == os.environ.get("NEXUS_WORKER_INSTANCE"):
                    server.should_exit = True
                    return
            except OSError:
                pass
            await asyncio.sleep(.2)

    watcher = asyncio.create_task(watch_stop())
    try:
        await server.serve()
    finally:
        watcher.cancel()
        with suppress(asyncio.CancelledError):
            await watcher


def supervise(args):
    directory = ROOT / "logs" / "server"
    directory.mkdir(parents=True, exist_ok=True)
    stop = directory / f"stop-{args.port}"
    state = directory / f"supervisor-{args.port}.json"
    outcome = directory / f"outcome-{args.port}.json"
    marker = directory / f"worker-stop-{args.port}"
    force = directory / f"force-stop-{args.port}"
    # Bind guard prevents two supervisors from owning the same server.
    guard = socket.socket()
    guard.bind(("127.0.0.1", args.port + 10000))
    stop.unlink(missing_ok=True)
    marker.unlink(missing_ok=True)
    force.unlink(missing_ok=True)
    outcome.unlink(missing_ok=True)
    failures = []
    child = None
    snapshot = {"version": 2, "root": str(ROOT), "supervisor_pid": os.getpid(),
                "supervisor_created": creation_time(os.getpid()), "worker_pid": None,
                "port": args.port, "mode": args.mode, "phase": "starting",
                "last_success": None, "restart_count": 0, "last_error": "",
                "started_at": time.time()}

    def publish(phase, **updates):
        snapshot.update(updates, phase=phase, updated_at=time.time())
        atomic_json(state, snapshot)

    try:
        while not stop.exists():
            now = time.monotonic()
            failures = [stamp for stamp in failures if now - stamp < 600]
            if len(failures) >= 5:
                print("Restart limit reached (5 in 10 minutes); inspect supervisor log.", flush=True)
                publish("failed", last_error="Restart limit reached (5 in 10 minutes)")
                return 1
            env = os.environ.copy()
            instance = uuid.uuid4().hex
            env.update(PORT=str(args.port), SERVER_PORT=str(args.port),
                       NEXUS_SERVER_PORT=str(args.port), NO_BROWSER="1", PYTHONUNBUFFERED="1",
                       NEXUS_WORKER_INSTANCE=instance)
            with (directory / f"supervisor-{args.port}.log").open("a", encoding="utf-8") as output:
                child = subprocess.Popen([sys.executable, str(Path(__file__)), "--worker",
                                          "--mode", args.mode, "--port", str(args.port)],
                                         cwd=ROOT, env=env, stdout=output, stderr=output)
                publish("starting", worker_pid=child.pid, worker_created=creation_time(child.pid),
                        instance=instance, worker_started_at=time.time(), restart_count=len(failures))
                print(f"Nexus worker PID {child.pid}; mode={args.mode}; port={args.port}", flush=True)
                started = time.monotonic()
                misses = 0
                ready = False
                while not stop.exists() and child.poll() is None:
                    if healthy(args.port, instance):
                        ready = True
                        misses = 0
                        publish("running", last_success=time.time(), misses=0, last_error="")
                    elif ready or time.monotonic() - started > 120:
                        misses += 1
                        publish("unresponsive" if misses >= 3 else snapshot["phase"], misses=misses,
                                last_error="Nexus health probe failed")
                    if misses >= 3:
                        print(f"Worker {child.pid}: three failed health probes; restarting", flush=True)
                        break
                    for _ in range(50):
                        if stop.exists() or child.poll() is not None:
                            break
                        time.sleep(.1)
                if child.poll() is None:
                    if stop.exists():
                        publish("stopping")
                        if not request_graceful_stop(child, marker, instance):
                            publish("stop_failed", last_error="Graceful shutdown timed out; force requires confirmation")
                            while child.poll() is None:
                                try:
                                    confirmed = force.read_text(encoding="utf-8").strip() == instance
                                except OSError:
                                    confirmed = False
                                if confirmed:
                                    stop_worker(child)
                                    break
                                time.sleep(.1)
                    else:
                        publish("recovering", last_error="Worker stopped responding; automatic recovery")
                        stop_worker(child)
                print(f"Worker {child.pid} exited: {child.returncode}", flush=True)
            if stop.exists():
                break
            failures.append(time.monotonic())
            publish("recovering", restart_count=len(failures), last_error=f"Worker exited: {child.returncode}")
            deadline = time.monotonic() + min(2 ** len(failures), 30)
            while not stop.exists() and time.monotonic() < deadline:
                time.sleep(.1)
    finally:
        if child is not None and child.poll() is None:
            stop_worker(child)
        if snapshot["phase"] != "failed":
            snapshot.update(phase="stopped", updated_at=time.time())
        atomic_json(outcome, snapshot)
        state.unlink(missing_ok=True)
        marker.unlink(missing_ok=True)
        force.unlink(missing_ok=True)
        guard.close()
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("classic", "lite"), default="classic")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--worker", action="store_true")
    args = parser.parse_args()
    os.chdir(ROOT)
    if args.worker:
        with (ROOT / "logs" / "server" / f"stacks-{args.port}.log").open("a") as stacks:
            faulthandler.enable(file=stacks)
            # Independent of the event loop; preserves evidence during a hang.
            faulthandler.dump_traceback_later(120, file=stacks)
            os.environ["NEXUS_STACK_FD"] = str(stacks.fileno())
            try:
                asyncio.run(serve(args.mode, args.port))
            finally:
                faulthandler.cancel_dump_traceback_later()
    else:
        sys.exit(supervise(args))
