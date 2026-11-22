"""FNXTube uses the same card markup and KVS player as PimpBunny."""
from urllib.parse import urlsplit

from .pimpbunny import PimpBunnyExtractor


class FNXTubeExtractor(PimpBunnyExtractor):
    @property
    def name(self) -> str:
        return "FNXTube"

    @property
    def domains(self):
        return ["fnxtube.com"]

    def can_handle(self, url: str) -> bool:
        try:
            parsed = urlsplit(url)
            host = (parsed.hostname or "").lower()
            return parsed.scheme in ("http", "https") and (
                host == "fnxtube.com" or host.endswith(".fnxtube.com")
            )
        except ValueError:
            return False
