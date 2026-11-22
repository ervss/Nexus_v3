"""Small, dependency-free guards for server-side URL fetch endpoints."""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlsplit


def require_public_http_url(value: str) -> str:
    """Return a valid public HTTP(S) URL or raise ``ValueError``.

    This blocks direct access to loopback, private, link-local, multicast and
    reserved IP ranges, including their IPv6 forms. Hostname-based providers
    remain supported; redirect destinations still need to be checked by the
    calling HTTP client when redirects are followed.
    """
    candidate = (value or "").strip()
    try:
        parsed = urlsplit(candidate)
        host = (parsed.hostname or "").rstrip(".").lower()
        # Accessing .port validates malformed/out-of-range ports.
        _ = parsed.port
    except ValueError as exc:
        raise ValueError("Invalid proxy URL") from exc

    if parsed.scheme.lower() not in {"http", "https"} or not host:
        raise ValueError("Only absolute HTTP(S) URLs are allowed")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Proxy URLs may not contain credentials")
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise ValueError("Private host not allowed")

    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return candidate
    if not address.is_global:
        raise ValueError("Private or reserved address not allowed")
    return candidate


def safe_resolve_ip(host: str) -> list[str]:
    """Resolve a host and verify that all resolved IP addresses are global/public.

    Raises ``ValueError`` if any resolved address is private, loopback,
    link-local, reserved, or multicast.
    """
    clean_host = (host or "").strip().rstrip(".").lower()
    if not clean_host:
        raise ValueError("Empty host cannot be resolved")
    if clean_host == "localhost" or clean_host.endswith((".localhost", ".local", ".internal")):
        raise ValueError(f"Private host not allowed: {clean_host}")

    # If host is already an IP literal
    try:
        addr = ipaddress.ip_address(clean_host)
        if not addr.is_global:
            raise ValueError(f"Address {clean_host} is private or reserved")
        return [clean_host]
    except ValueError as exc:
        if "is private or reserved" in str(exc):
            raise

    try:
        results = socket.getaddrinfo(clean_host, None, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError(f"Could not resolve host: {clean_host}") from exc

    resolved_ips: list[str] = []
    for family, socktype, proto, canonname, sockaddr in results:
        ip_str = sockaddr[0]
        if ip_str in resolved_ips:
            continue
        try:
            addr = ipaddress.ip_address(ip_str)
        except ValueError as exc:
            raise ValueError(f"Invalid resolved IP {ip_str} for host {clean_host}") from exc
        if not addr.is_global:
            raise ValueError(f"Resolved address {ip_str} for host {clean_host} is private or reserved")
        resolved_ips.append(ip_str)

    if not resolved_ips:
        raise ValueError(f"No IP addresses resolved for host {clean_host}")
    return resolved_ips


def validate_redirect_url(url: str, hops: int = 0, max_hops: int = 5) -> str:
    """Validate that redirect target is a safe public HTTP(S) URL within max_hops limit."""
    if hops > max_hops:
        raise ValueError(f"Too many redirects ({hops} > {max_hops})")
    return require_public_http_url(url)
