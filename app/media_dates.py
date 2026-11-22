"""Upload dates from watch-page metadata, without guessing from clip titles."""
import asyncio
from datetime import datetime
import json
import re
from bs4 import BeautifulSoup


def normalize_upload_date(value):
    text = str(value or '').strip()
    for pattern, fmt in [(r'^\d{4}-\d{2}-\d{2}', '%Y-%m-%d'), (r'^\d{8}$', '%Y%m%d')]:
        match = re.match(pattern, text)
        if match:
            try:
                return datetime.strptime(match.group(), fmt).date().isoformat()
            except ValueError:
                return ''
    for fmt in ('%b %d, %Y', '%B %d, %Y', '%d %b %Y', '%d %B %Y'):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            pass
    return ''


def extract_upload_date(html):
    soup = BeautifulSoup(html or '', 'html.parser')
    for node in soup.select('meta[itemprop="uploadDate"], meta[itemprop="datePublished"], meta[property="video:release_date"], meta[property="article:published_time"], time[itemprop="uploadDate"], time[itemprop="datePublished"]'):
        date = normalize_upload_date(node.get('content') or node.get('datetime') or node.get_text(strip=True))
        if date:
            return date
    def video_date(value):
        if isinstance(value, list):
            return next((date for item in value if (date := video_date(item))), '')
        if isinstance(value, dict):
            if 'VideoObject' in str(value.get('@type', '')):
                return normalize_upload_date(value.get('uploadDate') or value.get('datePublished'))
            return video_date(value.get('@graph', []))
        return ''
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            date = video_date(json.loads(script.string or script.get_text()))
            if date:
                return date
        except (ValueError, TypeError):
            pass
    # KVS sites such as FPO display this in the video's information panel.
    info = soup.select_one('#tab_video_info')
    match = re.search(r'Published on\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})', info.get_text(' ', strip=True) if info else '')
    return normalize_upload_date(match.group(1)) if match else ''


async def fetch_upload_date(url):
    def fetch():
        try:
            from curl_cffi import requests
            response = requests.get(url, impersonate='chrome124', timeout=6)
            return extract_upload_date(response.text) if response.status_code == 200 else ''
        except Exception:
            return ''
    return await asyncio.to_thread(fetch)
