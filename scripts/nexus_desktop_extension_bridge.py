#!/usr/bin/env python3
"""Forward legacy localhost Nexus extension calls to a remote Nexus server.

Browser extensions in this checkout use localhost on a few historic ports.
Run this only on the desktop computer; it binds to 127.0.0.1 and forwards those
requests to the Nexus server running on the notebook.

Example:
    python scripts/nexus_desktop_extension_bridge.py --remote http://Olinka:8000
"""

from __future__ import annotations

import argparse
import http.client
import logging
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Iterable
from urllib.parse import SplitResult, urlsplit


HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


def parse_remote(value: str) -> SplitResult:
    remote = urlsplit(value)
    if remote.scheme != "http" or not remote.hostname:
        raise ValueError("--remote must be an HTTP URL, for example http://Olinka:8000")
    if remote.path not in ("", "/") or remote.query or remote.fragment:
        raise ValueError("--remote must not contain a path, query, or fragment")
    return remote


def make_handler(remote: SplitResult):
    class NexusForwardHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _forward(self) -> None:
            try:
                content_length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(content_length) if content_length else None
                headers = {
                    key: value
                    for key, value in self.headers.items()
                    if key.lower() not in HOP_BY_HOP_HEADERS | {"host", "content-length"}
                }
                headers["Host"] = remote.netloc
                if body is not None:
                    headers["Content-Length"] = str(len(body))

                connection = http.client.HTTPConnection(
                    remote.hostname,
                    remote.port or 80,
                    timeout=120,
                )
                connection.request(self.command, self.path, body=body, headers=headers)
                response = connection.getresponse()

                self.send_response(response.status, response.reason)
                for key, value in response.getheaders():
                    if key.lower() not in HOP_BY_HOP_HEADERS:
                        self.send_header(key, value)
                self.end_headers()
                while chunk := response.read(64 * 1024):
                    self.wfile.write(chunk)
                connection.close()
            except (OSError, ValueError, http.client.HTTPException) as exc:
                logging.warning("Bridge failed %s %s: %s", self.command, self.path, exc)
                self.send_error(502, f"Notebook Nexus server is unavailable: {exc}")

        do_GET = _forward
        do_POST = _forward
        do_PUT = _forward
        do_PATCH = _forward
        do_DELETE = _forward
        do_OPTIONS = _forward
        do_HEAD = _forward

        def log_message(self, format: str, *args: object) -> None:
            logging.info("Desktop bridge: " + format, *args)

    return NexusForwardHandler


def start_servers(remote: SplitResult, ports: Iterable[int]) -> list[ThreadingHTTPServer]:
    handler = make_handler(remote)
    servers: list[ThreadingHTTPServer] = []
    for port in ports:
        server = ThreadingHTTPServer(("127.0.0.1", port), handler)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
        logging.info("Listening on http://127.0.0.1:%s -> %s", port, remote.geturl())
    return servers


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--remote", default="http://Olinka:8000", help="Notebook Nexus URL")
    parser.add_argument("--ports", nargs="+", type=int, default=[8000, 8001, 8002])
    args = parser.parse_args()

    try:
        remote = parse_remote(args.remote)
        servers = start_servers(remote, args.ports)
    except (OSError, ValueError) as exc:
        logging.error("Could not start desktop bridge: %s", exc)
        return 1

    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    logging.info("Desktop Nexus extension bridge is running. Press Ctrl+C to stop.")
    stop.wait()
    for server in servers:
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    sys.exit(main())
