"""Just enough bencode to read the infohash out of a .torrent file."""

from __future__ import annotations

import hashlib
from typing import Any


def bencode(value: Any) -> bytes:
    if isinstance(value, bool):
        raise TypeError("bool is not a bencode integer")
    if isinstance(value, int):
        return b"i" + str(value).encode("ascii") + b"e"
    if isinstance(value, bytes):
        return str(len(value)).encode("ascii") + b":" + value
    if isinstance(value, str):
        raw = value.encode("utf-8")
        return str(len(raw)).encode("ascii") + b":" + raw
    if isinstance(value, list):
        return b"l" + b"".join(bencode(item) for item in value) + b"e"
    if isinstance(value, dict):
        parts = [b"d"]
        for key in sorted(value):
            raw_key = key if isinstance(key, bytes) else str(key).encode("utf-8")
            parts.append(bencode(raw_key))
            parts.append(bencode(value[key]))
        parts.append(b"e")
        return b"".join(parts)
    raise TypeError(f"Cannot bencode {type(value).__name__}")


def bdecode(data: bytes) -> Any:
    value, end = _decode_at(data, 0)
    if end != len(data):
        raise ValueError("Trailing data in bencode payload")
    return value


def _decode_at(data: bytes, index: int) -> tuple[Any, int]:
    token = data[index:index + 1]
    if token == b"i":
        end = data.index(b"e", index)
        return int(data[index + 1:end]), end + 1
    if token == b"l":
        index += 1
        items = []
        while data[index:index + 1] != b"e":
            item, index = _decode_at(data, index)
            items.append(item)
        return items, index + 1
    if token == b"d":
        index += 1
        mapping: dict[bytes, Any] = {}
        while data[index:index + 1] != b"e":
            key, index = _decode_at(data, index)
            value, index = _decode_at(data, index)
            if isinstance(key, str):
                key = key.encode("utf-8")
            mapping[key] = value
        return mapping, index + 1
    if token.isdigit():
        colon = data.index(b":", index)
        size = int(data[index:colon])
        start = colon + 1
        end = start + size
        return data[start:end], end
    raise ValueError(f"Unsupported bencode token at {index}")


def torrent_infohash(blob: bytes) -> str:
    try:
        decoded = bdecode(blob)
    except (ValueError, IndexError):
        return ""
    if not isinstance(decoded, dict):
        return ""
    info = decoded.get(b"info")
    if not isinstance(info, dict):
        return ""
    return hashlib.sha1(bencode(info)).hexdigest()
