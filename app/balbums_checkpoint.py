"""Finish the Balbums browser check and reuse its pass cookie.

The public listing answers a 403 with a short-lived page: a proof of work,
a few browser facts, and a picture of characters. aiohttp still receives that
page after a pass, because the cookie is only honored for a browser-like TLS
client. This module builds the same answer the page's own script sends.
"""
from __future__ import annotations

import base64
import datetime
import hashlib
import json
import re

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
_PLUGINS = "PDF Viewer,Chrome PDF Viewer,Chromium PDF Viewer,Microsoft Edge PDF Viewer,WebKit built-in PDF"
_BLOCKED = ("cf-chl-", "just a moment", "verify you are human", "checkpoint | sentinel")
_ocr = None
_ocr_broken = False


def is_blocked_listing(html: str) -> bool:
    lowered = (html or "").lower()
    return any(marker in lowered for marker in _BLOCKED)


def is_sentinel(html: str) -> bool:
    lowered = (html or "").lower()
    return "checkpoint | sentinel" in lowered or "/.well-known/checkpoint" in lowered


def parse_challenge(html: str) -> dict | None:
    start = (html or "").find("var C=")
    if start < 0:
        return None
    start += len("var C=")
    if start >= len(html) or html[start] != "{":
        return None
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(html)):
        char = html[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                try:
                    data = json.loads(html[start:index + 1])
                except json.JSONDecodeError:
                    return None
                if isinstance(data, dict) and data.get("n") and data.get("m"):
                    return data
                return None
    return None


def solve_pow(salt: str, bits: int) -> int:
    """First nonce whose SHA-256 prefix has `bits` leading zero bits.

    The page hashes one short ASCII block and keeps the first 32-bit word.
    """
    width = max(1, min(int(bits), 22))
    shift = 32 - width
    limit = 8 << width
    prefix = f"{salt}:".encode("ascii")
    for nonce in range(limit):
        digest = hashlib.sha256(prefix + str(nonce).encode("ascii")).digest()
        if int.from_bytes(digest[:4], "big") >> shift == 0:
            return nonce
    raise RuntimeError("checkpoint proof was not found")


def browser_profile() -> dict:
    now = datetime.datetime.now().astimezone()
    offset = now.utcoffset() or datetime.timedelta(0)
    return {
        "navigator": {
            "userAgent": _UA,
            "platform": "Win32",
            "language": "sk-SK",
            "languages": ["sk-SK", "sk", "en-US", "en"],
            "hardwareConcurrency": 8,
            "maxTouchPoints": 0,
            "webdriver": False,
            "cookieEnabled": True,
            "doNotTrack": "",
            "deviceMemory": 8,
            "plugins": _PLUGINS,
        },
        "screen": {
            "width": 1920,
            "height": 1080,
            "availWidth": 1920,
            "availHeight": 1040,
            "colorDepth": 24,
        },
        "window": {"devicePixelRatio": 1},
        "tz": "Europe/Bratislava",
        "tzo": -int(offset.total_seconds() // 60),
    }


def fingerprint(profile: dict) -> dict:
    nav = profile["navigator"]
    screen = profile["screen"]
    return {
        "ua": nav["userAgent"],
        "platform": nav["platform"],
        "langs": ",".join(nav["languages"]),
        "tz": profile["tz"],
        "tzo": profile["tzo"],
        "sw": screen["width"],
        "sh": screen["height"],
        "aw": screen["availWidth"],
        "ah": screen["availHeight"],
        "depth": screen["colorDepth"],
        "ratio": profile["window"]["devicePixelRatio"],
        "hwc": nav["hardwareConcurrency"],
        "mem": nav["deviceMemory"],
        "touch": nav["maxTouchPoints"],
        "webdriver": bool(nav["webdriver"]),
        "cookies": bool(nav["cookieEnabled"]),
        "ls": True,
        "ss": True,
        "idb": True,
        "dnt": nav["doNotTrack"] or "",
        "plugins": nav["plugins"],
        "canvas": "c0ffee01a2b3c4d5",
        "glv": "Google Inc. (NVIDIA)",
        "glr": "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        "gl": "0a1b2c3d4e5f6789",
        "fonts": "1122334455667788",
        "nfonts": 18,
        "sig": [],
        "audio": "35.748291",
    }


def _split_top(expr: str, operator: str) -> list[str]:
    parts = []
    depth = 0
    start = 0
    index = 0
    while index < len(expr):
        char = expr[index]
        if char in "([":
            depth += 1
        elif char in ")]":
            depth = max(0, depth - 1)
        elif depth == 0 and expr.startswith(operator, index):
            parts.append(expr[start:index])
            index += len(operator)
            start = index
            continue
        index += 1
    parts.append(expr[start:])
    return parts


def _wrapped(expr: str) -> bool:
    if len(expr) < 2 or expr[0] != "(" or expr[-1] != ")":
        return False
    depth = 0
    for index, char in enumerate(expr):
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return index == len(expr) - 1
    return False


def _eval_expr(expr: str, env: dict):
    expr = expr.strip()
    if expr.endswith(")") and ".join(" in expr:
        head, _, _call = expr.rpartition(".join(")
        if _wrapped(head):
            head = head[1:-1]
        value = _eval_expr(head, env)
        if isinstance(value, (list, tuple)):
            return ",".join("" if item is None else str(item) for item in value)
        return "" if value is None else str(value)
    if expr.startswith("!!"):
        return bool(_eval_expr(expr[2:], env))
    if _wrapped(expr):
        return _eval_expr(expr[1:-1], env)
    choices = _split_top(expr, "||")
    if len(choices) > 1:
        last = None
        for choice in choices:
            last = _eval_expr(choice, env)
            if last not in (None, False, 0, "", []):
                return last
        return last
    if expr.startswith("[") and expr.endswith("]"):
        inner = expr[1:-1].strip()
        if not inner:
            return []
        return [_eval_expr(part, env) for part in _split_top(inner, ",")]
    if expr in {"true", "false", "null", "undefined"}:
        return {"true": True, "false": False, "null": None, "undefined": None}[expr]
    if re.fullmatch(r"-?\d+", expr):
        return int(expr)
    if len(expr) >= 2 and expr[0] == expr[-1] and expr[0] in {"'", '"'}:
        return expr[1:-1]
    root, dot, prop = expr.partition(".")
    if dot and root in env and isinstance(env[root], dict):
        if prop == "length":
            return len(env[root])
        if prop in env[root]:
            return env[root][prop]
        nested, dot2, leaf = prop.partition(".")
        if dot2 and nested in env[root] and leaf == "length":
            return len(env[root][nested])
    raise ValueError(expr)


def probe_answers(probes, profile: dict) -> dict[str, str]:
    answers = {}
    for probe_id, expr in probes or []:
        try:
            value = _eval_expr(str(expr), profile)
        except (ValueError, KeyError, TypeError):
            value = ""
        if isinstance(value, bool):
            answers[str(probe_id)] = "true" if value else "false"
        elif value is None:
            answers[str(probe_id)] = ""
        else:
            answers[str(probe_id)] = str(value)
    return answers


def solution(challenge: dict, typed: str | None, profile: dict | None = None) -> dict:
    profile = profile or browser_profile()
    return {
        "n": challenge["n"],
        "c": solve_pow(str(challenge["m"]), int(challenge.get("b") or 16)),
        "a": probe_answers(challenge.get("p") or [], profile),
        "fp": fingerprint(profile),
        "t": typed,
    }


def retry_challenge(body: str) -> dict | None:
    try:
        data = json.loads(body or "")
    except json.JSONDecodeError:
        return None
    retry = data.get("retry") if isinstance(data, dict) else None
    if isinstance(retry, dict) and retry.get("n") and retry.get("m"):
        return retry
    return None


def captcha_png(challenge: dict) -> bytes | None:
    raw = challenge.get("i") or ""
    if not raw:
        return None
    try:
        return base64.b64decode(raw)
    except (ValueError, TypeError):
        return None


def read_captcha(png: bytes) -> str:
    global _ocr, _ocr_broken
    if not png or _ocr_broken:
        return ""
    if _ocr is None:
        try:
            import ddddocr
            try:
                _ocr = ddddocr.DdddOcr(show_ad=False)
            except TypeError:
                _ocr = ddddocr.DdddOcr()
        except Exception:
            _ocr_broken = True
            return ""
    try:
        text = _ocr.classification(png)
    except Exception:
        return ""
    return re.sub(r"[^A-Za-z0-9]", "", text or "").upper()[:8]
