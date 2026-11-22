import os
import unittest
from pathlib import Path
from unittest.mock import patch

from app.tor_service import TorService


class TorServiceTests(unittest.TestCase):
    def test_disabled_service_never_starts_a_process(self):
        service = TorService()
        with patch.dict(os.environ, {"TOR_ENABLED": "false", "EPORNER_USE_TOR": "0", "MEGA_PROXY_MODE": ""}, clear=False):
            with patch("app.tor_service.subprocess.Popen") as popen:
                state = service.start(wait_seconds=0)
        popen.assert_not_called()
        self.assertFalse(state["ready"])
        self.assertIn("disabled", state["last_error"].lower())

    def test_status_requires_a_live_socks_listener(self):
        service = TorService()
        with patch.object(service, "executable_path", return_value=Path("tor.exe")):
            with patch.object(service, "config_path", return_value=Path("torrc")):
                with patch.object(service, "_port_open", return_value=False):
                    state = service.status()
        self.assertFalse(state["ready"])
        self.assertFalse(state["socks_ready"])

    def test_status_reads_bootstrap_and_circuit_from_control_port(self):
        service = TorService()

        def port_open(address, timeout=0.7):
            return address in (service.socks_address, service.control_address)

        reply = [
            '250-status/bootstrap-phase=NOTICE BOOTSTRAP PROGRESS=100 TAG=done SUMMARY="Done"',
            "250-status/circuit-established=1",
            "250 OK",
        ]
        with patch.object(service, "_port_open", side_effect=port_open):
            with patch.object(service, "_control", return_value=reply):
                state = service.status()
        self.assertTrue(state["ready"])
        self.assertTrue(state["control_ready"])
        self.assertEqual(100, state["bootstrap_percent"])


class EpornerTorStatusTests(unittest.TestCase):
    def test_configured_but_offline_tor_is_not_reported_as_protected(self):
        from app.hubs.eporner import EpornerHub

        offline = {"ready": False, "bootstrap_percent": 0, "last_error": "offline"}
        with patch.dict(os.environ, {"EPORNER_USE_TOR": "1", "EPORNER_NETWORK_MODE": "tor"}, clear=False):
            with patch("app.tor_service.tor_service.status", return_value=offline):
                state = EpornerHub().net_status()
        self.assertEqual("tor-offline", state["mode"])
        self.assertFalse(state["protected"])

    def test_live_tor_is_reported_as_protected(self):
        from app.hubs.eporner import EpornerHub

        ready = {"ready": True, "bootstrap_percent": 100, "last_error": ""}
        with patch.dict(os.environ, {"EPORNER_USE_TOR": "1", "EPORNER_NETWORK_MODE": "tor"}, clear=False):
            with patch("app.tor_service.tor_service.status", return_value=ready):
                state = EpornerHub().net_status()
        self.assertEqual("tor", state["mode"])
        self.assertTrue(state["protected"])

    def test_auto_mode_is_direct_with_ready_tor_fallback(self):
        from app.hubs.eporner import EpornerHub

        ready = {"ready": True, "bootstrap_percent": 100, "last_error": ""}
        with patch.dict(os.environ, {"EPORNER_NETWORK_MODE": "auto"}, clear=False):
            with patch("app.tor_service.tor_service.status", return_value=ready):
                state = EpornerHub().net_status()
        self.assertEqual("auto", state["mode"])
        self.assertFalse(state["protected"])
        self.assertTrue(state["fallback_available"])


if __name__ == "__main__":
    unittest.main()
