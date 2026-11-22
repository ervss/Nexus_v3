from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping, Optional


class Priority(str, Enum):
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"

    @classmethod
    def parse(cls, value: Any) -> "Priority":
        if isinstance(value, cls):
            return value
        key = str(value or "normal").strip().lower()
        if key == "bulk":
            return cls.LOW
        try:
            return cls(key)
        except ValueError:
            return cls.NORMAL


@dataclass
class RequestIntent:
    url: str
    domain: Optional[str] = None
    method: str = "GET"
    headers: Optional[Mapping[str, str]] = None
    cookies: Optional[Mapping[str, str]] = None
    data: Any = None
    json: Any = None
    priority: Priority = Priority.NORMAL
    deadline: float = 25.0
    sticky_key: Optional[str] = None
    impersonate: Optional[str] = None
    cache: bool = True
    extra: dict = field(default_factory=dict)
