"""Podpora pre externé prehrávače (VLC) a odosielanie videa do TV cez DLNA/UPnP."""

from __future__ import annotations

import asyncio
import ipaddress
import os
import shutil
import socket
import subprocess
import time
import urllib.parse
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass
from xml.sax.saxutils import escape as xml_escape

import httpx

SSDP_ADDR = ("239.255.255.250", 1900)
SSDP_TARGETS = (
    "urn:schemas-upnp-org:device:MediaRenderer:1",
    "urn:schemas-upnp-org:service:AVTransport:1",
)
_CACHE_TTL_SEC = 30.0
_dlna_cache: dict[str, object] = {"at": 0.0, "devices": []}


@dataclass
class DlnaDevice:
    id: str
    name: str
    manufacturer: str
    model: str
    ip: str
    location: str
    control_url: str
    service_type: str


def find_vlc_executable() -> str | None:
    """Nájde cestu k spustiteľnému súboru VLC v systéme."""
    env_path = os.getenv("VLC_PATH", "").strip()
    if env_path and os.path.isfile(env_path):
        return env_path

    which_path = shutil.which("vlc")
    if which_path:
        return which_path

    if os.name == "nt":
        candidates = (
            os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "VideoLAN", "VLC", "vlc.exe"),
            os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), "VideoLAN", "VLC", "vlc.exe"),
            os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "VideoLAN", "VLC", "vlc.exe"),
        )
        for candidate in candidates:
            if candidate and os.path.isfile(candidate):
                return candidate
    else:
        for candidate in ("/usr/bin/vlc", "/usr/local/bin/vlc", "/Applications/VLC.app/Contents/MacOS/VLC"):
            if os.path.isfile(candidate):
                return candidate
    return None


def launch_vlc(target_url: str, *, title: str = "", referer: str = "") -> str:
    """Spustí VLC s danou URL a voliteľným refererom a názvom."""
    vlc_path = find_vlc_executable()
    if not vlc_path:
        raise FileNotFoundError("VLC Media Player sa v systéme nenašiel. Nainštaluj VLC alebo nastav premennú VLC_PATH.")

    args = [vlc_path, target_url]
    if title:
        args.append(f"--meta-title={title[:200]}")
    if referer and target_url.startswith(("http://", "https://")) and not target_url.startswith("http://127.0.0.1"):
        args.append(f"--http-referrer={referer}")

    popen_kwargs: dict[str, object] = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if os.name == "nt":
        popen_kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        popen_kwargs["start_new_session"] = True

    subprocess.Popen(args, **popen_kwargs)
    return vlc_path


def get_lan_ip_for_target(target_ip: str = "") -> str:
    """Zistí lokálnu LAN IP adresu počítača smerom k cieľovému zariadeniu."""
    probe_ip = target_ip or "8.8.8.8"
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect((probe_ip, 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def is_private_http_url(url: str) -> bool:
    """Overí, či URL smeruje na HTTP/HTTPS adresu v lokálnej/súkromnej sieti."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return False
    try:
        ip = ipaddress.ip_address(parsed.hostname)
        return ip.is_private or ip.is_loopback or ip.is_link_local
    except ValueError:
        # Hostname bez IP (napr. mDNS .local) povolíme len pre lokálne domény
        return parsed.hostname.endswith(".local")


def _ssdp_discover_locations(timeout: float = 1.8) -> list[str]:
    """Odošle SSDP M-SEARCH a vráti unikátne LOCATION URL nájdených zariadení."""
    locations: list[str] = []
    seen: set[str] = set()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
        sock.settimeout(0.35)

        for target in SSDP_TARGETS:
            msg = (
                "M-SEARCH * HTTP/1.1\r\n"
                f"HOST: {SSDP_ADDR[0]}:{SSDP_ADDR[1]}\r\n"
                'MAN: "ssdp:discover"\r\n'
                "MX: 1\r\n"
                f"ST: {target}\r\n"
                "\r\n"
            ).encode("ascii")
            try:
                sock.sendto(msg, SSDP_ADDR)
            except OSError:
                continue

        deadline = time.monotonic() + max(0.5, min(timeout, 5.0))
        while time.monotonic() < deadline:
            try:
                data, _addr = sock.recvfrom(8192)
            except socket.timeout:
                continue
            except OSError:
                break
            text = data.decode("utf-8", errors="ignore")
            for line in text.splitlines():
                if line.lower().startswith("location:"):
                    loc = line.split(":", 1)[1].strip()
                    if loc and loc not in seen:
                        seen.add(loc)
                        locations.append(loc)
    finally:
        sock.close()
    return locations


def _parse_device_xml(location: str, xml_text: str) -> DlnaDevice | None:
    """Vyparsuje UPnP device description XML a vyberie AVTransport službu."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return None

    def _strip_ns(tag: str) -> str:
        return tag.split("}", 1)[-1] if "}" in tag else tag

    device_el = None
    for elem in root.iter():
        if _strip_ns(elem.tag) == "device":
            device_el = elem
            break
    if device_el is None:
        return None

    friendly_name = ""
    manufacturer = ""
    model = ""
    udn = ""
    for child in device_el:
        tag = _strip_ns(child.tag)
        val = (child.text or "").strip()
        if tag == "friendlyName":
            friendly_name = val
        elif tag == "manufacturer":
            manufacturer = val
        elif tag == "modelName":
            model = val
        elif tag == "UDN":
            udn = val

    control_url = ""
    service_type = ""
    for elem in root.iter():
        if _strip_ns(elem.tag) != "service":
            continue
        s_type = ""
        c_url = ""
        for child in elem:
            tag = _strip_ns(child.tag)
            val = (child.text or "").strip()
            if tag == "serviceType":
                s_type = val
            elif tag == "controlURL":
                c_url = val
        if "AVTransport" in s_type and c_url:
            service_type = s_type
            control_url = urllib.parse.urljoin(location, c_url)
            break

    if not control_url:
        return None

    parsed_loc = urllib.parse.urlparse(location)
    ip = parsed_loc.hostname or ""
    return DlnaDevice(
        id=udn or location,
        name=friendly_name or model or ip or "Smart TV",
        manufacturer=manufacturer,
        model=model,
        ip=ip,
        location=location,
        control_url=control_url,
        service_type=service_type,
    )


async def discover_dlna_devices(*, refresh: bool = False, timeout: float = 1.8) -> list[dict[str, str]]:
    """Vyhľadá DLNA/UPnP TV zariadenia v lokálnej sieti."""
    now = time.monotonic()
    cached_at = float(_dlna_cache.get("at") or 0.0)
    if not refresh and (now - cached_at) < _CACHE_TTL_SEC:
        return list(_dlna_cache.get("devices") or [])  # type: ignore[arg-type]

    locations = await asyncio.to_thread(_ssdp_discover_locations, timeout)
    devices: list[dict[str, str]] = []
    seen_ids: set[str] = set()

    if locations:
        async with httpx.AsyncClient(timeout=2.5, verify=False) as client:
            async def _fetch(loc: str) -> DlnaDevice | None:
                try:
                    resp = await client.get(loc)
                    if resp.status_code >= 400:
                        return None
                    return _parse_device_xml(loc, resp.text)
                except Exception:
                    return None

            results = await asyncio.gather(*(_fetch(loc) for loc in locations))
            for dev in results:
                if dev and dev.id not in seen_ids:
                    seen_ids.add(dev.id)
                    devices.append(asdict(dev))

    devices.sort(key=lambda d: (d.get("name") or "").lower())
    _dlna_cache["at"] = time.monotonic()
    _dlna_cache["devices"] = devices
    return list(devices)


def _guess_protocol_info(media_url: str) -> str:
    lower = media_url.lower()
    if ".m3u8" in lower or "/hls" in lower:
        return "http-get:*:application/x-mpegURL:*"
    if ".webm" in lower:
        return "http-get:*:video/webm:*"
    if ".mkv" in lower:
        return "http-get:*:video/x-matroska:*"
    return "http-get:*:video/mp4:*"


async def cast_to_dlna_device(
    *,
    control_url: str,
    service_type: str,
    media_url: str,
    title: str = "Nexus Video",
) -> None:
    """Pošle video URI do DLNA/UPnP MediaRenderer zariadenia a spustí prehrávanie."""
    if not is_private_http_url(control_url):
        raise ValueError("Neplatná alebo nepodporovaná adresa TV zariadenia.")

    safe_title = xml_escape((title or "Nexus Video")[:180])
    safe_url = xml_escape(media_url)
    proto = _guess_protocol_info(media_url)
    didl = (
        '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" '
        'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">'
        '<item id="0" parentID="-1" restricted="1">'
        f"<dc:title>{safe_title}</dc:title>"
        "<upnp:class>object.item.videoItem</upnp:class>"
        f'<res protocolInfo="{proto}">{safe_url}</res>'
        "</item></DIDL-Lite>"
    )
    escaped_didl = xml_escape(didl)
    svc = service_type or "urn:schemas-upnp-org:service:AVTransport:1"

    set_uri_body = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
        "<s:Body>"
        f'<u:SetAVTransportURI xmlns:u="{xml_escape(svc)}">'
        "<InstanceID>0</InstanceID>"
        f"<CurrentURI>{safe_url}</CurrentURI>"
        f"<CurrentURIMetaData>{escaped_didl}</CurrentURIMetaData>"
        "</u:SetAVTransportURI>"
        "</s:Body></s:Envelope>"
    )

    play_body = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
        "<s:Body>"
        f'<u:Play xmlns:u="{xml_escape(svc)}">'
        "<InstanceID>0</InstanceID>"
        "<Speed>1</Speed>"
        "</u:Play>"
        "</s:Body></s:Envelope>"
    )

    async with httpx.AsyncClient(timeout=8.0, verify=False) as client:
        r1 = await client.post(
            control_url,
            content=set_uri_body.encode("utf-8"),
            headers={
                "Content-Type": 'text/xml; charset="utf-8"',
                "SOAPACTION": f'"{svc}#SetAVTransportURI"',
            },
        )
        if r1.status_code >= 400:
            raise RuntimeError(f"TV odmietla video URI (HTTP {r1.status_code}).")

        r2 = await client.post(
            control_url,
            content=play_body.encode("utf-8"),
            headers={
                "Content-Type": 'text/xml; charset="utf-8"',
                "SOAPACTION": f'"{svc}#Play"',
            },
        )
        if r2.status_code >= 400:
            raise RuntimeError(f"TV prijala URI, ale nespustila prehrávanie (HTTP {r2.status_code}).")
