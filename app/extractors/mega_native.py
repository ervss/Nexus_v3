"""
MEGA Native Bridge — server-side end-to-end streaming for mega.nz links.

MEGA file data is encrypted with AES-128-CTR. CTR is seekable: every 16-byte
block decrypts independently from its counter, so we can stream + range-seek an
encrypted MEGA file while decrypting on the fly — without ever downloading the
whole file or capturing expiring chunk URLs.

What we persist in the DB is the *permanent* mega.nz link (it never expires).
At playback time we re-resolve the short-lived CDN URL on demand and pass bytes
through this module's decryptor. That is why a saved MEGA video always replays.

Public references we understand:
    mega.nz/file/<handle>#<key>                       single public file
    mega.nz/folder/<handle>#<key>[/folder/<sub>]      folder (album)

Compact ref we store in Video.url so streaming is self-contained:
    mega:f:<handle>:<key_b64>                          public file
    mega:n:<root_handle>:<file_handle>:<key_b64>       file inside a folder
(key_b64 = url-safe base64 of the raw 32-byte / 8-word file key incl. nonce)
"""
from __future__ import annotations

import base64
import json
import logging
import struct
from dataclasses import dataclass
from typing import Any, Optional

import httpx
from Crypto.Cipher import AES
from Crypto.Util import Counter

logger = logging.getLogger(__name__)

MEGA_API = "https://g.api.mega.co.nz/cs"
VIDEO_EXTS = (".mp4", ".mkv", ".avi", ".mov", ".m4v", ".webm", ".flv", ".wmv", ".ts", ".m2ts")
_SEQ = 0


class MegaAPIError(RuntimeError):
    def __init__(self, code: int):
        self.code = code
        super().__init__(f"MEGA API error {code}")


# --------------------------------------------------------------------------- #
# low-level codec helpers
# --------------------------------------------------------------------------- #
def b64url_decode(data: str) -> bytes:
    data += "=" * (-len(data) % 4)
    return base64.b64decode(data.replace("-", "+").replace("_", "/"))


def b64url_encode(data: bytes) -> str:
    return base64.b64encode(data).decode().replace("+", "-").replace("/", "_").rstrip("=")


def str_to_a32(b: bytes) -> tuple[int, ...]:
    if len(b) % 4:
        b += b"\0" * (4 - len(b) % 4)
    return struct.unpack(">%dI" % (len(b) // 4), b)


def a32_to_bytes(a) -> bytes:
    return struct.pack(">%dI" % len(a), *a)


def _decrypt_attr(attr: bytes, key_a32) -> dict:
    """Decrypt MEGA's CBC node attributes -> {'n': filename, ...}.

    Accepts either a full 8-word file key (the AES key is derived) or an
    already-derived 4-word key.
    """
    if not attr:
        return {}
    try:
        if len(key_a32) >= 8:
            aes_key, _ = _file_key_parts(key_a32)
        else:
            aes_key = a32_to_bytes(key_a32[:4])
        cipher = AES.new(aes_key, AES.MODE_CBC, b"\0" * 16)
        dec = cipher.decrypt(attr).rstrip(b"\0")
        if dec.startswith(b"MEGA"):
            return json.loads(dec[4:].decode("utf-8", "ignore"))
    except Exception as exc:  # noqa: BLE001
        logger.debug("[MEGA] attr decrypt failed: %s", exc)
    return {}


def _file_key_parts(key_a32):
    """From the 8-word file key derive (aes_key_bytes, nonce_words)."""
    k = (key_a32[0] ^ key_a32[4], key_a32[1] ^ key_a32[5],
         key_a32[2] ^ key_a32[6], key_a32[3] ^ key_a32[7])
    nonce = key_a32[4:6]
    return a32_to_bytes(k), nonce


# --------------------------------------------------------------------------- #
# seekable AES-CTR decryptor
# --------------------------------------------------------------------------- #
class MegaCTRDecryptor:
    """
    Decrypts a contiguous byte run that starts at absolute plaintext offset
    `start`. Handles non-16-aligned starts by pre-rolling the partial block.
    """

    def __init__(self, key_a32, start: int = 0):
        self._aes_key, nonce = _file_key_parts(key_a32)
        self._nonce = (nonce[0] << 32) + nonce[1]          # 64-bit
        self._skip = start % 16
        block_index = start // 16
        self._init_cipher(block_index)

    def _init_cipher(self, block_index: int):
        ctr = Counter.new(128, initial_value=(self._nonce << 64) + block_index)
        self._cipher = AES.new(self._aes_key, AES.MODE_CTR, counter=ctr)
        if self._skip:
            # discard the keystream for the bytes before our real start
            self._cipher.decrypt(b"\0" * self._skip)
            self._skip = 0

    def decrypt(self, data: bytes) -> bytes:
        return self._cipher.decrypt(data)


# --------------------------------------------------------------------------- #
# reference parsing
# --------------------------------------------------------------------------- #
@dataclass
class MegaRef:
    kind: str                 # "file" | "node"
    file_handle: str
    key_a32: tuple            # full 8-word file key
    root_handle: Optional[str] = None   # set for folder nodes

    def to_compact(self) -> str:
        kb = b64url_encode(a32_to_bytes(self.key_a32))
        if self.kind == "file":
            return f"mega:f:{self.file_handle}:{kb}"
        return f"mega:n:{self.root_handle}:{self.file_handle}:{kb}"


def is_mega_url(url: str) -> bool:
    u = (url or "").lower()
    return "mega.nz/" in u or "mega.co.nz/" in u or u.startswith("mega:")


def parse_compact(ref: str) -> MegaRef:
    parts = ref.split(":")
    if parts[1] == "f":
        _, _, handle, kb = parts
        return MegaRef("file", handle, str_to_a32(b64url_decode(kb)))
    _, _, root, handle, kb = parts
    return MegaRef("node", handle, str_to_a32(b64url_decode(kb)), root_handle=root)


def parse_public_file_link(url: str) -> Optional[MegaRef]:
    """mega.nz/file/<handle>#<key>  (also legacy  mega.nz/#!<handle>!<key>)."""
    try:
        if "/file/" in url:
            frag = url.split("/file/", 1)[1]
            handle, key_b64 = frag.split("#", 1)
            handle = handle.split("/")[0]
        elif "#!" in url:
            frag = url.split("#!", 1)[1]
            handle, key_b64 = frag.split("!", 1)
        else:
            return None
        key_b64 = key_b64.split("/")[0].split("?")[0]
        key = str_to_a32(b64url_decode(key_b64))
        if len(key) < 8:
            return None
        return MegaRef("file", handle, key)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[MEGA] bad file link %s: %s", url, exc)
        return None


def parse_folder_link(url: str):
    """Return (root_handle, shared_key_bytes, nested_handle | None)."""
    try:
        if "/folder/" in url:
            body = url.split("/folder/", 1)[1]
        elif "#F!" in url:
            body = url.split("#F!", 1)[1].replace("!", "#", 1)
        else:
            return None
        root_handle, rest = body.split("#", 1)
        shared_b64 = rest.split("/")[0]
        nested = None
        if "/folder/" in rest:
            nested = rest.split("/folder/")[1].split("/")[0]
        shared = a32_to_bytes(str_to_a32(b64url_decode(shared_b64))[:4])
        return root_handle, shared, nested
    except Exception as exc:  # noqa: BLE001
        logger.warning("[MEGA] bad folder link %s: %s", url, exc)
        return None


# --------------------------------------------------------------------------- #
# MEGA API
# --------------------------------------------------------------------------- #
async def _api(payload: list, folder_node: Optional[str] = None, *, proxy: str = "") -> Any:
    global _SEQ
    _SEQ += 1
    params = {"id": str(_SEQ)}
    if folder_node:
        params["n"] = folder_node
    options = {"proxy": proxy, "trust_env": False} if proxy else {}
    async with httpx.AsyncClient(timeout=30, **options) as c:
        r = await c.post(MEGA_API, params=params, json=payload)
        r.raise_for_status()
        data = r.json()
    if isinstance(data, int):
        raise MegaAPIError(data)
    if not isinstance(data, list) or not data:
        raise RuntimeError("Unexpected MEGA API response")
    item = data[0]
    if isinstance(item, int):
        raise MegaAPIError(item)
    return item


async def resolve_cdn(ref: MegaRef, *, proxy: str = "") -> dict:
    """Resolve a ref to a fresh temporary CDN URL + size + filename."""
    options = {"proxy": proxy} if proxy else {}
    if ref.kind == "file":
        req = {"a": "g", "g": 1, "p": ref.file_handle}
        info = await _api([req], **options)
    else:
        req = {"a": "g", "g": 1, "n": ref.file_handle}
        info = await _api([req], folder_node=ref.root_handle, **options)
    if "g" not in info:
        raise RuntimeError(f"MEGA: no download URL (resp={info})")
    name = ""
    if info.get("at"):
        name = _decrypt_attr(b64url_decode(info["at"]), ref.key_a32).get("n", "")
    return {"url": info["g"], "size": int(info.get("s", 0)),
            "name": name, "fa": info.get("fa", "")}


async def fetch_thumbnail(ref: MegaRef, type_: int = 0) -> Optional[bytes]:
    """
    Download + decrypt a node's stored thumbnail (type 0) or preview (type 1)
    from MEGA's file-attribute servers. Best-effort: returns None on any issue.
    No video bytes are downloaded — just the small attribute blob.
    """
    try:
        info = await resolve_cdn(ref)
        fa = info.get("fa") or ""
        handle = None
        for part in fa.split("/"):
            meta, _, h = part.partition("*")
            _, _, t = meta.partition(":")
            if t == str(type_) and h:
                handle = h
                break
        if not handle:
            return None

        # ssl:0 -> http storage URL (storage nodes use a cert chain that trips
        # up some OpenSSL builds; the payload is encrypted anyway).
        res = await _api([{"a": "ufa", "fah": handle, "ssl": 0, "r": 1}])
        base = res.get("p")
        if not base:
            return None

        raw_h = b64url_decode(handle)
        async with httpx.AsyncClient(timeout=30, verify=False) as c:
            r = await c.post(base, content=raw_h)
            blob = r.content
        # framing: <8-byte handle><4-byte LE length><encrypted payload>
        if len(blob) < 12:
            return None
        length = int.from_bytes(blob[8:12], "little")
        payload = blob[12:12 + length] if length else blob[12:]
        aes_key, _ = _file_key_parts(ref.key_a32)
        padded = payload + b"\0" * ((-len(payload)) % 16)
        dec = AES.new(aes_key, AES.MODE_CBC, b"\0" * 16).decrypt(padded)
        dec = dec[:length] if length else dec
        # MEGA thumbnails are JPEG, WebP (RIFF) or occasionally PNG
        if dec[:3] == b"\xff\xd8\xff" or dec[:4] == b"RIFF" or dec[:8] == b"\x89PNG\r\n\x1a\n":
            return dec
        return None
    except Exception as exc:  # noqa: BLE001
        logger.debug("[MEGA] thumbnail fetch failed: %s", exc)
        return None


async def probe_metadata(ref: MegaRef, *, fast: bool = False) -> dict:
    """
    Read just the MP4 `moov` atom (decrypted on the fly) to extract real
    duration + resolution. Only a few KB–MB are fetched, never the whole file.
    Returns {"duration": float, "width": int, "height": int} (zeros on failure).
    """
    out = {"duration": 0.0, "width": 0, "height": 0}
    try:
        info = await resolve_cdn(ref)
        size, cdn = info["size"], info["url"]
        if not size:
            return out

        # Fast card probes reuse the opening 64 KiB for atom headers and jump
        # over mdat. Strict Range validation prevents accidental full downloads.
        opening = b""
        read_count = 0
        budget = 1_114_112 if fast else 4_001_024
        async def read(offset: int, length: int) -> bytes:
            nonlocal read_count, budget
            if opening and offset + length <= len(opening):
                return opening[offset:offset + length]
            length = min(length, size - offset)
            if length <= 0 or length > budget or (fast and read_count >= 6):
                return b""
            read_count += 1
            budget -= length
            async with httpx.AsyncClient(timeout=30, verify=False) as c:
                async with c.stream("GET", cdn, headers={"Range": f"bytes={offset}-{offset + length - 1}"}) as r:
                    r.raise_for_status()
                    expected = f"bytes {offset}-{offset + length - 1}/{size}"
                    if r.status_code != 206 or r.headers.get("content-range", "").lower() != expected:
                        return b""
                    chunks = bytearray()
                    async for chunk in r.aiter_bytes(chunk_size=65536):
                        if len(chunks) + len(chunk) > length:
                            return b""
                        chunks.extend(chunk)
                    if len(chunks) != length:
                        return b""
                    enc = bytes(chunks)
            return MegaCTRDecryptor(ref.key_a32, offset).decrypt(enc)

        if fast:
            opening = await read(0, min(65536, size))
            if not opening:
                return out

        # Walk top-level atoms until we reach moov (jumping over a huge mdat).
        pos, moov = 0, None
        for _ in range(32):
            if pos + 8 > size:
                break
            head = await read(pos, 16)
            if len(head) < 8:
                break
            box_size = int.from_bytes(head[0:4], "big")
            box_type = head[4:8]
            hdr = 8
            if box_size == 1:
                box_size = int.from_bytes(head[8:16], "big")
                hdr = 16
            if box_type == b"moov":
                moov = await read(pos + hdr, min(box_size - hdr, 1_048_576 if fast else 4_000_000))
                break
            if box_size <= 0:
                break
            pos += box_size

        if not moov:
            return out

        # duration from mvhd
        j = moov.find(b"mvhd")
        if j != -1:
            version = moov[j + 4]
            if version == 1:
                timescale = int.from_bytes(moov[j + 24:j + 28], "big")
                duration = int.from_bytes(moov[j + 28:j + 36], "big")
            else:
                timescale = int.from_bytes(moov[j + 16:j + 20], "big")
                duration = int.from_bytes(moov[j + 20:j + 24], "big")
            if timescale:
                out["duration"] = duration / timescale

        # resolution from the first visual sample entry
        for codec in (b"avc1", b"hev1", b"hvc1", b"av01", b"mp4v", b"vp09", b"vp08"):
            i = moov.find(codec)
            if i != -1:
                w = int.from_bytes(moov[i + 28:i + 30], "big")
                h = int.from_bytes(moov[i + 30:i + 32], "big")
                if 0 < w <= 16384 and 0 < h <= 16384:
                    out["width"], out["height"] = w, h
                    break
    except Exception as exc:  # noqa: BLE001
        logger.debug("[MEGA] probe failed: %s", exc)
    return out


def quality_from_height(height: int) -> str:
    if height >= 2160:
        return "4K"
    if height >= 1440:
        return "1440p"
    if height >= 1080:
        return "1080p"
    if height >= 720:
        return "720p"
    if height >= 480:
        return "480p"
    if height > 0:
        return "SD"
    return ""


def thumbnail_mime(data: bytes) -> str:
    if data[:4] == b"RIFF":
        return "image/webp"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    return "image/jpeg"


def _decrypt_node_key(k_field: str, shared_key: bytes):
    enc = b64url_decode(k_field.split(":")[-1])
    # node keys can be longer than one block; decrypt in 16-byte chunks (ECB)
    cipher = AES.new(shared_key, AES.MODE_ECB)
    dec = cipher.decrypt(enc[: len(enc) // 16 * 16])
    return str_to_a32(dec)


async def inspect_keyless(kind: str, handle: str) -> dict:
    """Overí cez MEGA API existenciu a počet/veľkosť súborov bez dešifrovacieho kľúča.

    V MEGA API nie sú typ uzla (t) ani veľkosť súboru (s) zašifrované, takže aj pred získaním
    kľúča z linkvertise/bypass.city vieme okamžite odfiltrovať mŕtve alebo prázdne priečinky.
    """
    try:
        if kind == "file":
            res = await _api([{"a": "g", "p": handle}])
            size = int(res.get("s") or 0)
            return {"status": "locked_alive", "files": 1, "folders": 0, "bytes": size}
        tree = await _api([{"a": "f", "c": 1, "r": 1, "ca": 1}], folder_node=handle)
        nodes = [n for n in (tree.get("f") or []) if isinstance(n, dict) and n.get("h")]
        if not nodes:
            return {"status": "unavailable", "reason": "Priečinok neobsahuje žiadne uzly."}
        files = [n for n in nodes if n.get("t") == 0]
        folders = [n for n in nodes if n.get("t") == 1]
        total_bytes = sum(int(n.get("s") or 0) for n in files)
        if not files:
            return {"status": "empty", "files": 0, "folders": len(folders), "bytes": 0,
                    "reason": "Priečinok na MEGA je prázdny (0 súborov)."}
        return {"status": "locked_alive", "files": len(files), "folders": len(folders), "bytes": total_bytes}
    except MegaAPIError as exc:
        if exc.code in {-2, -8, -9, -11, -14, -16}:
            return {"status": "unavailable", "reason": f"MEGA album už neexistuje alebo je zablokovaný (kód {exc.code})."}
        return {"status": "retry", "reason": f"Dočasná chyba MEGA API (kód {exc.code})."}
    except Exception as exc:  # noqa: BLE001
        return {"status": "retry", "reason": str(exc) or "Nepodarilo sa kontaktovať MEGA."}


async def list_tree(root_handle: str, shared_key: bytes, nested_handle: str | None,
                    selected_file: str | None) -> dict:
    """Catalog one public share scope, preserving folder parents and empty folders."""
    tree = await _api([{"a": "f", "c": 1, "r": 1, "ca": 1}], folder_node=root_handle)
    nodes = {node["h"]: node for node in tree.get("f", []) if node.get("h")}
    roots = [handle for handle, node in nodes.items() if node.get("t") and node.get("p") not in nodes]
    scope = nested_handle or (root_handle if root_handle in nodes else (roots[0] if roots else None))
    if not scope or scope not in nodes or not nodes[scope].get("t"):
        return {"status": "unavailable"}

    def attributes(node):
        for candidate in (node.get("k") or "").split("/"):
            encoded = candidate.partition(":")[2]
            if not encoded:
                continue
            try:
                key = _decrypt_node_key(encoded, shared_key)
                expected = 4 if node.get("t") else 8
                if len(key) != expected:
                    continue
                name = _decrypt_attr(b64url_decode(node.get("a", "")), key).get("n")
                if name:
                    return name, key
            except (TypeError, ValueError):
                continue
        return "", None

    title, _ = attributes(nodes[scope])
    if not title:
        return {"status": "open_in_mega"}

    children: dict[str, list[str]] = {}
    for handle, node in nodes.items():
        children.setdefault(node.get("p") or "", []).append(handle)
    pending = list(reversed(children.get(scope, [])))
    visited = {scope}
    folders, videos = [], []
    partial = False
    while pending:
        handle = pending.pop()
        if handle in visited:
            continue
        visited.add(handle)
        node = nodes[handle]
        name, key = attributes(node)
        parent = node.get("p")
        if node.get("t"):
            folders.append({"id": handle, "parent": parent, "name": name or "MEGA priečinok"})
            pending.extend(reversed(children.get(handle, [])))
        if not name:
            partial = True
        if node.get("t") == 0 and name.lower().endswith(VIDEO_EXTS):
            if not selected_file or handle == selected_file:
                ref = MegaRef("node", handle, key, root_handle=root_handle)
                videos.append({"ref": ref.to_compact(), "parent": parent, "name": name,
                               "size": int(node.get("s") or 0), "timestamp": node.get("ts") or 0})

    if selected_file:
        if selected_file not in visited:
            return {"status": "unavailable"}
        name, _ = attributes(nodes[selected_file])
        return {"status": ("available" if videos else "empty") if name else "open_in_mega",
                "title": name or title, "scope": "", "folders": [], "videos": videos, "partial": False}
    return {"status": "available" if videos else ("open_in_mega" if partial else "empty"),
            "title": title, "scope": scope, "folders": folders, "videos": videos, "partial": partial}


async def list_folder(url: str) -> dict:
    """
    List a public folder. Returns:
        {"title": str, "videos": [ {handle, name, size, ref, parent, thumb_fa}... ]}
    Only video files are returned (the dashboard is a video library).
    """
    parsed = parse_folder_link(url)
    if not parsed:
        raise RuntimeError("Invalid MEGA folder link")
    root_handle, shared, nested = parsed
    tree = await _api([{"a": "f", "c": 1, "r": 1, "ca": 1}], folder_node=root_handle)
    nodes = tree.get("f", [])

    folder_names: dict[str, str] = {}
    videos: list[dict] = []
    for n in nodes:
        kfield = n.get("k", "")
        if ":" not in kfield:
            continue
        try:
            nk = _decrypt_node_key(kfield, shared)
        except Exception:
            continue
        t = n.get("t")
        if t == 1:  # subfolder
            attrs = _decrypt_attr(b64url_decode(n.get("a", "")), nk[:4])
            folder_names[n.get("h")] = attrs.get("n", "")
        elif t == 0 and len(nk) >= 8:  # file
            attrs = _decrypt_attr(b64url_decode(n.get("a", "")), nk)
            name = attrs.get("n", "")
            if not name.lower().endswith(VIDEO_EXTS):
                continue
            ref = MegaRef("node", n.get("h"), tuple(nk), root_handle=root_handle)
            videos.append({
                "handle": n.get("h"),
                "parent": n.get("p"),
                "name": name,
                "size": int(n.get("s", 0)),
                "ref": ref.to_compact(),
                "thumb_fa": n.get("fa", ""),
            })

    # If a nested subfolder was specified in the link, keep only its files
    if nested:
        videos = [v for v in videos if v["parent"] == nested] or videos

    title = folder_names.get(nested) or folder_names.get(root_handle) or "MEGA Album"
    return {"title": title, "videos": videos, "root_handle": root_handle}
