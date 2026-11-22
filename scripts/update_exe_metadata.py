"""Update string values in an existing PE VERSIONINFO resource in place."""

from pathlib import Path
import shutil
import sys


REPLACEMENTS = {
    "Comments": "Peter",
    "CompanyName": "Nexus",
    "FileDescription": "Nexus Portal",
    "ProductName": "Nexus Portal",
}


def replace_value(data: bytearray, key: str, value: str) -> None:
    key_bytes = key.encode("utf-16le") + b"\x00\x00"
    key_start = data.find(key_bytes)
    if key_start < 0:
        raise ValueError(f"VERSIONINFO key not found: {key}")

    # VERSIONINFO children are aligned to a 32-bit boundary.
    value_start = (key_start + len(key_bytes) + 3) & ~3
    value_end = value_start
    while value_end + 1 < len(data):
        if data[value_end:value_end + 2] == b"\x00\x00":
            break
        value_end += 2
    else:
        raise ValueError(f"VERSIONINFO value not found: {key}")

    encoded = value.encode("utf-16le")
    available = value_end - value_start
    if len(encoded) > available:
        raise ValueError(f"Replacement is too long for {key}")
    data[value_start:value_end] = encoded + b"\x00" * (available - len(encoded))


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {Path(sys.argv[0]).name} FILE", file=sys.stderr)
        return 2

    target = Path(sys.argv[1])
    backup = target.with_suffix(target.suffix + ".bak")
    shutil.copy2(target, backup)
    data = bytearray(target.read_bytes())

    for key, value in REPLACEMENTS.items():
        replace_value(data, key, value)

    target.write_bytes(data)
    print(f"Updated {target}; backup: {backup}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())