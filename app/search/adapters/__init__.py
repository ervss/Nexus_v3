"""Adaptéry pre 4-vrstvový Omni-Search (KVS, WP/DLE, API, Local SearXNG Dorks, Telethon)."""

from .api_adapter import ApiFamilyAdapter
from .dork_adapter import DorkAggregatorAdapter
from .kvs_adapter import KvsFamilyAdapter
from .telethon_adapter import TelethonSearchAdapter
from .tube_adapter import TubeEngineAdapter
from .wp_dle_adapter import WpDleFamilyAdapter

__all__ = [
    "ApiFamilyAdapter",
    "DorkAggregatorAdapter",
    "KvsFamilyAdapter",
    "TelethonSearchAdapter",
    "TubeEngineAdapter",
    "WpDleFamilyAdapter",
]
