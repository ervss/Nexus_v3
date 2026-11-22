import importlib
import logging
from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple, Union

from .base import VideoExtractor


@dataclass(frozen=True)
class _LazyExtractorSpec:
    """Deferred extractor descriptor materialized on first matching URL or get_all()."""

    name: str
    module_path: str
    class_name: str
    hints: Optional[Tuple[str, ...]] = None

    def matches_hints(self, url_lower: str) -> bool:
        if not self.hints:
            return True
        return any(hint in url_lower for hint in self.hints)


class ExtractorRegistry:
    _entries: List[Union[VideoExtractor, _LazyExtractorSpec]] = []
    # Kept synchronized with materialized instances for any legacy inspection.
    _extractors: List[VideoExtractor] = []

    @classmethod
    def register(cls, extractor: VideoExtractor):
        """Registers a new extractor instance."""
        for idx, existing in enumerate(cls._entries):
            if isinstance(existing, _LazyExtractorSpec) and existing.name == extractor.name:
                cls._entries[idx] = extractor
                break
            if isinstance(existing, VideoExtractor) and existing.name == extractor.name:
                return
        else:
            cls._entries.append(extractor)
        if extractor not in cls._extractors:
            cls._extractors.append(extractor)
        logging.info(f"Registered extractor: {extractor.name}")

    @classmethod
    def register_lazy(
        cls,
        name: str,
        module_path: str,
        class_name: str,
        hints: Optional[Sequence[str]] = None,
    ):
        """Registers an extractor lazily without importing its module at startup."""
        for existing in cls._entries:
            if existing.name == name:
                return
        norm_hints = tuple(h.lower() for h in hints) if hints else None
        cls._entries.append(_LazyExtractorSpec(name=name, module_path=module_path, class_name=class_name, hints=norm_hints))

    @classmethod
    def _materialize(cls, idx: int) -> Optional[VideoExtractor]:
        entry = cls._entries[idx]
        if isinstance(entry, VideoExtractor):
            return entry
        try:
            mod = importlib.import_module(entry.module_path)
            ext_cls = getattr(mod, entry.class_name)
            inst = ext_cls()
        except Exception as exc:
            logging.error(f"Failed to lazy-load extractor {entry.name} ({entry.module_path}.{entry.class_name}): {exc}")
            return None
        cls._entries[idx] = inst
        if inst not in cls._extractors:
            cls._extractors.append(inst)
        logging.info(f"Registered extractor: {inst.name}")
        return inst

    @classmethod
    def find_extractor(cls, url: str) -> Optional[VideoExtractor]:
        """Finds the first extractor that can handle the URL, lazy-loading matching specs on demand."""
        url_lower = (url or "").lower()
        for idx in range(len(cls._entries)):
            entry = cls._entries[idx]
            if isinstance(entry, _LazyExtractorSpec):
                if not entry.matches_hints(url_lower):
                    continue
                inst = cls._materialize(idx)
                if inst is None:
                    continue
            else:
                inst = entry
            if inst.can_handle(url):
                return inst
        return None

    @classmethod
    def get_all(cls) -> List[VideoExtractor]:
        """Returns all registered extractors, materializing any lazy entries."""
        result: List[VideoExtractor] = []
        for idx in range(len(cls._entries)):
            inst = cls._materialize(idx)
            if inst is not None:
                result.append(inst)
        return result
