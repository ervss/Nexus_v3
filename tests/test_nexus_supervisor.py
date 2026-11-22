import argparse
import io
import json

from scripts import nexus_server as runner


def test_health_rejects_another_worker(monkeypatch):
    monkeypatch.setattr(runner.urllib.request, "urlopen", lambda *a, **k:
                        io.BytesIO(json.dumps({"service": "nexus", "instance": "other"}).encode()))
    assert runner.healthy(8000)
    assert not runner.healthy(8000, "owned")


def test_three_failed_probes_restart_and_explicit_stop_does_not(monkeypatch, tmp_path):
    monkeypatch.setattr(runner, "ROOT", tmp_path)
    clock = [0.0]
    monkeypatch.setattr(runner.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(runner.time, "sleep", lambda seconds: clock.__setitem__(0, clock[0] + seconds))
    workers = []
    probes = []

    class Worker:
        def __init__(self, *args, **kwargs):
            self.pid = len(workers) + 1
            self.returncode = None
            workers.append(self)

        def poll(self):
            return self.returncode

    monkeypatch.setattr(runner.subprocess, "Popen", Worker)
    monkeypatch.setattr(runner, "stop_worker", lambda child: setattr(child, "returncode", -1))
    def graceful(child, marker, instance):
        child.returncode = 0
        return True
    monkeypatch.setattr(runner, "request_graceful_stop", graceful)

    def probe(*args):
        probes.append(len(workers))
        if len(workers) == 2:
            (tmp_path / "logs/server/stop-19001").touch()
            return True
        return len(probes) == 1

    monkeypatch.setattr(runner, "healthy", probe)
    assert runner.supervise(argparse.Namespace(port=19001, mode="classic")) == 0
    assert probes == [1, 1, 1, 1, 2]
    assert len(workers) == 2
    assert not (tmp_path / "logs/server/supervisor-19001.json").exists()


def test_crash_loop_stops_after_five_attempts(monkeypatch, tmp_path):
    monkeypatch.setattr(runner, "ROOT", tmp_path)
    clock = [0.0]
    monkeypatch.setattr(runner.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(runner.time, "sleep", lambda seconds: clock.__setitem__(0, clock[0] + seconds))
    workers = []

    class CrashedWorker:
        def __init__(self, *args, **kwargs):
            self.pid = len(workers) + 1
            self.returncode = 1
            workers.append(self)

        def poll(self):
            return self.returncode

    monkeypatch.setattr(runner.subprocess, "Popen", CrashedWorker)
    assert runner.supervise(argparse.Namespace(port=19002, mode="classic")) == 1
    assert len(workers) == 5
    assert not (tmp_path / "logs/server/supervisor-19002.json").exists()
