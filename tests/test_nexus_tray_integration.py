"""Real worker lifecycle, isolated from the user's database and main server."""
import contextlib
import json
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

import psutil
import pytest

from scripts import nexus_control as control
from scripts import nexus_server as runner


@pytest.fixture
def isolated_nexus(tmp_path, monkeypatch):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    shutil.copyfile(runner.__file__, scripts / "nexus_server.py")
    app = tmp_path / "app"
    app.mkdir()
    (app / "__init__.py").write_text("")
    (app / "main.py").write_text('''
import time
from fastapi import FastAPI
app = FastAPI()
@app.get("/stall")
async def stall():
    time.sleep(90)
    return {}
@app.get("/api/v1/events/recent")
async def events():
    return {"events": [{"topic": "pipeline.flow", "message": "Test task is progressing", "ts": time.time()}]}
''', encoding="utf-8")
    port = None
    for candidate in range(19300, 19400):
        try:
            with socket.socket() as listener, socket.socket() as guard:
                listener.bind(("127.0.0.1", candidate))
                guard.bind(("127.0.0.1", candidate + 10000))
                port = candidate
                break
        except OSError:
            continue
    assert port
    monkeypatch.setattr(control, "ROOT", tmp_path)
    assert control.start(port, "classic")["ok"]
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        state = control.status(port)
        if state["live_ok"]:
            break
        time.sleep(.2)
    assert state["live_ok"], state
    try:
        yield port, tmp_path, state
    finally:
        active = control.read_json(tmp_path / "logs/server" / f"supervisor-{port}.json")
        owner = control.validate_state(active, port)
        if owner:
            try:
                control.stop(port, force=True)
            finally:
                # Cleanup only this fixture's verified process tree if a test failed.
                owner = control.validate_state(active, port)
                if owner:
                    control.force_owned_tree(owner, active)


def stall_worker(port):
    request = socket.create_connection(("127.0.0.1", port), timeout=2)
    request.sendall(b"GET /stall HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
    time.sleep(.2)
    return request


def test_real_graceful_stop_and_repeated_start(isolated_nexus):
    port, root, before = isolated_nexus
    assert before["color"] == "green"
    assert before["events"][0]["message"] == "Test task is progressing"
    assert control.start(port, "classic")["ok"]
    assert control.status(port)["supervisor_pid"] == before["supervisor_pid"]
    assert control.stop(port)["ok"]
    assert control.status(port)["color"] == "red"
    assert not (root / "logs/server" / f"supervisor-{port}.json").exists()
    outcome = control.read_json(root / "logs/server" / f"outcome-{port}.json")
    assert outcome["phase"] == "stopped"
    assert not control.port_busy(port)


def test_hang_manual_stop_offer_and_confirmed_force(isolated_nexus):
    port, root, before = isolated_nexus
    with contextlib.closing(stall_worker(port)):
        result = control.stop(port)
        assert result["needs_force"] and not result["ok"]
        active = control.read_json(root / "logs/server" / f"supervisor-{port}.json")
        assert active["phase"] == "stop_failed"
        assert control.validate_state(active, port)
        assert control.stop(port, force=True)["ok"]
        assert control.status(port)["color"] == "red"


def test_worker_crash_recovers_under_same_supervisor(isolated_nexus):
    port, root, before = isolated_nexus
    active = control.read_json(root / "logs/server" / f"supervisor-{port}.json")
    owner = control.validate_state(active, port)
    worker = control.owned_process(active["worker_pid"], active["worker_created"])
    assert worker and owner
    # Kill just the owned worker tree; the supervisor remains responsible for recovery.
    for child in reversed(worker.children(recursive=True)):
        child.kill()
    worker.kill()
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        result = control.status(port)
        if result["live_ok"] and result["instance"] != before["instance"]:
            break
        time.sleep(.2)
    assert result["live_ok"]
    assert result["instance"] != before["instance"]
    assert result["supervisor_pid"] == before["supervisor_pid"]
    assert result["restart_count"] == 1
