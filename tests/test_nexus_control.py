import pytest

from scripts import nexus_control as control
from scripts import nexus_server as runner


def test_busy_job_and_quiet_log_are_green():
    result = control.classify({"phase": "running", "instance": "a"}, True, True, {}, 100)
    assert result["color"] == "green"
    assert result["last_success"] == 100


def test_three_failed_probes_and_recovery():
    state = {"phase": "running", "instance": "a", "supervisor_pid": 1, "last_success": 100}
    previous = dict(state)
    for expected in ["green", "green", "orange"]:
        result = control.classify(state, True, False, previous, 120)
        assert result["color"] == expected
        previous.update(result)
    assert control.classify(state, True, True, previous, 125)["misses"] == 0


@pytest.mark.parametrize("phase,label", [("starting", "Štartuje"), ("recovering", "Obnovuje sa"), ("stopping", "Zastavuje sa"), ("stop_failed", "Zastavenie neuspelo")])
def test_transitional_states(phase, label):
    result = control.classify({"phase": phase}, True, False, {}, 1)
    assert result["color"] == "orange"
    assert result["label"] == label


def test_dead_process_is_red_even_with_old_green_snapshot():
    result = control.classify({"phase": "running"}, False, False, {"color": "green"}, 1)
    assert result["color"] == "red"
    assert control.classify({"phase": "failed"}, False, False, {}, 1)["label"] == "Obnova zlyhala"


def test_instance_change_resets_misses():
    result = control.classify({"phase": "starting", "instance": "new"}, True, False, {"instance": "old", "misses": 20}, 1)
    assert result["misses"] == 1
    assert result["label"] == "Štartuje"


def test_diagnostic_redacts_secrets():
    text = control.clean_text("request https://example.org/a?token=private Cookie: session=private")
    assert "private" not in text
    assert "[URL]" in text
    assert "skryté" in text
    assert "abc123" not in control.clean_text("Authorization: Bearer abc123")
    assert "abc123" not in control.clean_text('{"NEXUS_BRIDGE_TOKEN": "abc123"}')


def test_log_tail_is_bounded_filtered_and_not_progress(monkeypatch, tmp_path):
    monkeypatch.setattr(control, "ROOT", tmp_path)
    target = tmp_path / "logs/server"
    target.mkdir(parents=True)
    (target / "supervisor-123.log").write_text('x' * 20000 + '\nwork one\nGET /_nexus/live 200\nwork two\n', encoding="utf-8")
    events = control.tail_logs(123)
    assert [event["message"] for event in events] == ["work one", "work two"]
    assert all(event["ts"] is None for event in events)


def test_busy_foreign_port_never_starts_or_stops(monkeypatch, tmp_path):
    monkeypatch.setattr(control, "ROOT", tmp_path)
    monkeypatch.setattr(control, "port_busy", lambda port: True)
    with pytest.raises(RuntimeError, match="obsadený"):
        control.start(1234, "classic")
    with pytest.raises(RuntimeError, match="neoverený"):
        control.stop(1234, force=True)


def test_pid_reuse_is_rejected(monkeypatch):
    class Process:
        def create_time(self):
            return 20
        def cmdline(self):
            return [str(control.ROOT / "scripts/nexus_server.py")]
    monkeypatch.setattr(control.psutil, "Process", lambda pid: Process())
    assert control.owned_process(10, 10) is None
    assert control.owned_process(10, 20) is not None


def test_another_checkout_is_rejected(monkeypatch):
    class Process:
        def cmdline(self):
            return ["C:/other/scripts/nexus_server.py"]
    monkeypatch.setattr(control.psutil, "Process", lambda pid: Process())
    assert control.owned_process(10) is None


def test_live_reply_requires_owned_worker_and_instance():
    class Process:
        pid = 1
        def children(self, recursive=False):
            return []
    assert not control.live_matches({"service": "nexus", "instance": "wrong"}, {"instance": "correct"}, Process())
    assert not control.live_matches({"service": "nexus", "pid": 1}, {}, None)


def test_atomic_snapshot_and_invalid_json(tmp_path):
    path = tmp_path / "state.json"
    runner.atomic_json(path, {"phase": "running"})
    assert control.read_json(path)["phase"] == "running"
    assert not list(tmp_path.glob("*.tmp"))
    path.write_text('{"phase":')
    assert control.read_json(path) == {}


def test_graceful_stop_waits_without_killing(monkeypatch, tmp_path):
    class Worker:
        killed = False
        def poll(self):
            return None
        def kill(self):
            self.killed = True
    clock = [0]
    monkeypatch.setattr(runner.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(runner.time, "sleep", lambda value: clock.__setitem__(0, clock[0] + value))
    child = Worker()
    marker = tmp_path / "worker-stop"
    assert not runner.request_graceful_stop(child, marker, "owned", timeout=1)
    assert not child.killed
    assert marker.read_text() == "owned"


def test_manual_legacy_stop_needs_confirmation(monkeypatch, tmp_path):
    monkeypatch.setattr(control, "ROOT", tmp_path)
    monkeypatch.setattr(control, "read_json", lambda path: {"port": 123, "supervisor_pid": 10})
    monkeypatch.setattr(control, "validate_state", lambda state, port: object())
    monkeypatch.setattr(control, "force_owned_tree", lambda *args: pytest.fail("must not force"))
    result = control.stop(123)
    assert result["needs_force"]
    assert not result["ok"]


def test_shutdown_timeout_returns_force_offer(monkeypatch, tmp_path):
    monkeypatch.setattr(control, "ROOT", tmp_path)
    (tmp_path / "logs/server").mkdir(parents=True)
    state = {"version": 2, "port": 123, "supervisor_pid": 10, "instance": "a", "phase": "stop_failed"}
    monkeypatch.setattr(control, "read_json", lambda path: state)
    monkeypatch.setattr(control, "validate_state", lambda state, port: object())
    result = control.stop(123)
    assert result["needs_force"]
    assert not (tmp_path / "logs/server/force-stop-123").exists()


def test_status_keeps_cached_events_as_stale(monkeypatch, tmp_path):
    monkeypatch.setattr(control, "ROOT", tmp_path)
    path = tmp_path / "logs/server"
    path.mkdir(parents=True)
    previous = {"instance": "a", "events": [{"message": "Work", "ts": 10}]}
    runner.atomic_json(path / "tray-status-123.json", previous)
    runner.atomic_json(path / "outcome-123.json", {"instance": "a", "phase": "stopped"})
    monkeypatch.setattr(control, "get_live", lambda port: {})
    monkeypatch.setattr(control, "port_busy", lambda port: False)
    result = control.status(123)
    assert result["stale"]
    assert result["events"] == previous["events"]
    assert result["color"] == "red"


def test_lifecycle_commands_are_serialized(monkeypatch, tmp_path):
    monkeypatch.setattr(control, "ROOT", tmp_path)
    with control.command_lock(123):
        with pytest.raises(RuntimeError, match="prebieha"):
            with control.command_lock(123):
                pytest.fail("second command must not run")
    with control.command_lock(123):
        pass
