"""
Inspect all extractors to extract domains and patterns from can_handle methods.
"""
import inspect
import re
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

from app.extractors import ExtractorRegistry, register_extended_extractors

register_extended_extractors()
all_exts = ExtractorRegistry.get_all()

print(f"Celkovo {len(all_exts)} extraktorov:\n")
mapping = {}
for ex in all_exts:
    name = ex.name
    try:
        src = inspect.getsource(ex.can_handle)
    except Exception:
        src = ""
    # Nájsť domény alebo vzory
    patterns = re.findall(r'["\']([a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,})["\']', src)
    clean_p = [p for p in set(patterns) if "." in p and not p.endswith(".py") and not p.endswith(".com/")]
    mapping[name] = clean_p
    print(f"{name:18s} -> {clean_p}")
