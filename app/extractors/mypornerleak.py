import re
import logging
from typing import Optional, Dict, Any
from .leakporner import LeakPornerExtractor

logger = logging.getLogger(__name__)

class MyPornerLeakExtractor(LeakPornerExtractor):
    @property
    def name(self) -> str:
        return "MyPornerLeak"
    
    @property
    def domains(self):
        return ["mypornerleak.com"]
    
    def can_handle(self, url: str) -> bool:
        return any(domain in url for domain in self.domains)

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        logging.info(f"Extracting metadata from MyPornerLeak: {url}")
        
        # Reuse LeakPorner's comprehensive, decrypted embed extraction logic
        result = await super().extract(url)
        if not result:
            return None

        # Normalize metadata attributes for MyPornerLeak
        result["uploader"] = "MyPornerLeak"
        title = str(result.get("title") or "")
        title = re.sub(r"\s*-\s*(?:leakporner|mypornerleak)\s*$", "", title, flags=re.I).strip()
        result["title"] = title or "MyPornerLeak Video"
        if not result.get("description"):
            result["description"] = result["title"]

        return result
