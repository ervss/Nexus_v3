import re
import logging
import requests
from typing import Optional, Dict, Any, List
from bs4 import BeautifulSoup
from .base import VideoExtractor

logger = logging.getLogger(__name__)

class ThisVidExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "ThisVid"

    def can_handle(self, url: str) -> bool:
        if not url:
            return False
        lower_url = url.lower()
        if "thisvid.com" not in lower_url:
            return False
        if re.search(r"https?://(?:www\.)?thisvid\.com/videos/[^/?#]+", lower_url):
            return True
        if re.search(r"https?://(?:www\.)?thisvid\.com/embed/\d+", lower_url):
            return True
        return False

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        logger.info("Extracting metadata from ThisVid: %s", url)
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Referer": "https://thisvid.com/",
        }

        try:
            response = requests.get(url, headers=headers, timeout=15)
            if response.status_code != 200:
                logger.error("ThisVid extraction failed: HTTP %s", response.status_code)
                return None
            html = response.text
        except Exception as exc:
            logger.error("ThisVid extraction request failed: %s", exc)
            return None

        soup = BeautifulSoup(html, "html.parser")

        title = "ThisVid Video"
        if soup.title and soup.title.string:
            title = soup.title.string.strip()

        description = ""
        desc_meta = soup.find("meta", attrs={"name": "description"})
        if desc_meta and desc_meta.get("content"):
            description = desc_meta["content"].strip()
        else:
            og_desc = soup.find("meta", property="og:description")
            if og_desc and og_desc.get("content"):
                description = og_desc["content"].strip()

        thumbnail = ""
        og_image = soup.find("meta", property="og:image")
        if og_image and og_image.get("content"):
            thumbnail = og_image["content"].strip()
            if thumbnail.startswith("//"):
                thumbnail = "https:" + thumbnail

        uploader = "ThisVid"
        author_link = soup.find("a", class_=re.compile(r"\bauthor\b", re.I))
        if author_link and author_link.text:
            uploader = author_link.text.strip()

        tags: List[str] = []
        video_tags_match = re.search(r"video_tags\s*:\s*[\'\"]([^\'\"]+)[\'\"]", html, re.I)
        if video_tags_match:
            tags.extend([tag.strip() for tag in video_tags_match.group(1).split(",") if tag.strip()])

        categories_match = re.search(r"video_categories\s*:\s*[\'\"]([^\'\"]+)[\'\"]", html, re.I)
        if categories_match:
            tags.extend([cat.strip() for cat in categories_match.group(1).split(",") if cat.strip()])

        models_match = re.search(r"video_models\s*:\s*[\'\"]([^\'\"]+)[\'\"]", html, re.I)
        if models_match:
            tags.extend([model.strip() for model in models_match.group(1).split(",") if model.strip()])

        # Prefer high-quality direct stream, fallback to alternate stream
        stream_url = None
        stream_match = re.search(r"video_url\s*:\s*[\'\"]([^\'\"]+)[\'\"]", html, re.I)
        if stream_match:
            stream_url = stream_match.group(1)

        if not stream_url:
            stream_match = re.search(r"video_alt_url\s*:\s*[\'\"]([^\'\"]+)[\'\"]", html, re.I)
            if stream_match:
                stream_url = stream_match.group(1)

        if not stream_url:
            raw_match = re.search(r"https?://[^\'\"]+\.(?:mp4|m3u8)[^\'\"]*", html, re.I)
            if raw_match:
                stream_url = raw_match.group(0)

        if stream_url:
            stream_url = stream_url.replace("\\/", "/")
            if stream_url.startswith("function/0/"):
                stream_url = stream_url[len("function/0/"):]
            if stream_url.startswith("//"):
                stream_url = "https:" + stream_url

        if not stream_url:
            logger.error("ThisVid extractor could not find a stream URL for %s", url)
            return None

        is_hls = ".m3u8" in stream_url.lower()

        width = 0
        height = 0
        og_width = soup.find("meta", property="og:video:width")
        og_height = soup.find("meta", property="og:video:height")
        if og_width and og_width.get("content"):
            try:
                width = int(og_width["content"])
            except ValueError:
                width = 0
        if og_height and og_height.get("content"):
            try:
                height = int(og_height["content"])
            except ValueError:
                height = 0

        video_id = None
        id_match = re.search(r"video_id\s*:\s*[\'\"]?(\d+)[\'\"]?", html, re.I)
        if id_match:
            video_id = id_match.group(1)
        else:
            video_id = url.rstrip("/").split("/")[-1]

        return {
            "id": video_id,
            "title": title,
            "description": description,
            "thumbnail": thumbnail,
            "duration": 0,
            "stream_url": stream_url,
            "width": width,
            "height": height,
            "tags": tags,
            "uploader": uploader,
            "is_hls": is_hls,
        }
