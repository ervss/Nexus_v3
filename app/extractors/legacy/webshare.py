import requests
import xml.etree.ElementTree as ET
import logging
import re
import os
import hashlib
from typing import Optional
from passlib.hash import md5_crypt

logger = logging.getLogger(__name__)

# Listing API: -S (tiny), -M / -L (wide multi-frame stripes on static/static2).
# Detail pages use a single frame still, typically -F02 on static2 (see og:image).
_WEBSHARE_THUMB_RE = re.compile(
    r"(?P<base>https?://img\.webshare\.cz/static2?/p/\d+/[^/]+)-(?P<size>S|M|L|preview|F\d+)\.(?P<ext>jpe?g|webp)$",
    re.IGNORECASE,
)


def parse_webshare_ident(value: Optional[str]) -> Optional[str]:
    """Extract Webshare file ident from pseudo-URL, file page, or wsfiles CDN URL."""
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.startswith("webshare:"):
        parts = text.split(":", 2)
        return parts[1] if len(parts) >= 2 and parts[1] else None
    if "/file/" in text:
        part = text.split("/file/", 1)[1]
        ident = part.split("/")[0].split("?")[0].strip()
        return ident or None
    if "wsfiles.cz" in text.lower():
        match = re.search(r"/([a-zA-Z0-9]{10})/", text)
        if match:
            return match.group(1)
    return None


def resolve_webshare_detail_preview(url: Optional[str]) -> Optional[str]:
    """Map listing/stripe URLs to the single-frame detail preview Webshare shows in-browser."""
    if not url:
        return None
    cleaned = url.strip()
    if not cleaned:
        return None
    if "img.webshare.cz" not in cleaned.lower():
        return cleaned

    match = _WEBSHARE_THUMB_RE.match(cleaned)
    if match:
        base = match.group("base").replace("/static/", "/static2/", 1)
        size = match.group("size").upper()
        ext = match.group("ext")
        if size.startswith("F"):
            return f"{base}-{size}.{ext}"
        return f"{base}-F02.{ext}"

    if "/static/" in cleaned and "/static2/" not in cleaned:
        cleaned = cleaned.replace("/static/", "/static2/", 1)
    cleaned = re.sub(
        r"-(?:S|M|L|preview)\.(jpe?g|webp)$", r"-F02.\1", cleaned, flags=re.IGNORECASE
    )
    return cleaned


class WebshareAPI:
    def __init__(self, token=None, username=None, password=None):
        self.base_url = "https://webshare.cz/api"
        # Load credentials from environment
        self.username = username or os.environ.get("WEBSHARE_LOGIN")
        self.password = password or os.environ.get("WEBSHARE_PASSWORD")
        self.token = token or os.environ.get("WEBSHARE_TOKEN")
        
        self.headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
        }
        
    def login(self):
        """Perform API login to get a fresh WST token"""
        if not self.username or not self.password:
            logger.error("Webshare credentials not configured. Cannot login.")
            return False

        try:
            # 1. Get Salt
            salt_url = f"{self.base_url}/salt/"
            resp = requests.post(salt_url, data={'username_or_email': self.username}, headers=self.headers)
            root = ET.fromstring(self.clean_xml(resp.text))
            
            status = root.find('status')
            if status is not None and status.text != 'OK':
                 logger.error(f"Webshare salt error: {root.find('message').text}")
                 return False
            
            salt = root.find('salt').text
            
            # 2. Hash Password: SHA1(md5_crypt(password, salt))
            # Webshare explicitly uses the raw salt provided. md5_crypt in passlib
            # usually expects the $1$prefix. 
            crypt_pass = md5_crypt.hash(self.password, salt=salt)
            sha1_pass = hashlib.sha1(crypt_pass.encode()).hexdigest()
            
            # 3. MD5 Digest for Login
            digest = hashlib.md5(f"{self.username}:Webshare:{sha1_pass}".encode()).hexdigest()
            
            # 4. Login Request
            login_url = f"{self.base_url}/login/"
            login_data = {
                'username_or_email': self.username,
                'password': sha1_pass,
                'digest': digest,
                'keep_logged_in': 1
            }
            
            resp = requests.post(login_url, data=login_data, headers=self.headers)
            root = ET.fromstring(self.clean_xml(resp.text))
            
            status = root.find('status')
            if status is not None and status.text == 'OK':
                self.token = root.find('token').text
                logger.info("Successfully logged in to Webshare.")
                # Update environment for this run
                os.environ["WEBSHARE_TOKEN"] = self.token
                return True
            else:
                msg = root.find('message').text if root.find('message') is not None else "Unknown login error"
                logger.error(f"Webshare login failed: {msg}")
                return False
                
        except Exception as e:
            logger.error(f"Webshare login exception: {e}")
            return False

    def ensure_token(self):
        """Verify current token or login if needed"""
        if self.token:
            # Simple check via user_data
            url = f"{self.base_url}/user_data/"
            try:
                resp = requests.post(url, data={'wst': self.token}, headers=self.headers)
                if '<status>OK</status>' in resp.text:
                    return True
            except: pass
            
        return self.login()

    def clean_xml(self, xml_string):
        """Fixes common XML issues from Webshare response"""
        if not xml_string: return ""
        # Remove invalid chars and fix entities if needed
        return re.sub(r'[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD\u10000-\u10FFFF]', '', xml_string)

    def search_files(self, query: str, limit: int = 50, sort: str = 'recent', offset: int = 0):
        """
        Search Webshare for files in Adult category.
        Sorts: 'recent', 'rating', 'size', 'relevance'
        """
        if not self.ensure_token():
            logger.warning("Webshare authentication failed. Cannot perform search.")
            return {"results": [], "total": 0}

        try:
            url = f"{self.base_url}/search/"
            sort_val = sort  # API accepts 'recent', 'rating', 'size', 'relevance' directly

            params = {
                'what': query,
                'category': 'adult', 
                'sort': sort_val,
                'offset': offset,
                'limit': limit,
                'wst': self.token
            }
            
            resp = requests.post(url, data=params, headers=self.headers, timeout=10)
            
            try:
                clean_content = self.clean_xml(resp.text)
                root = ET.fromstring(clean_content)
                nodes = root.findall('file')
                
                
                # Check for explicit 'pager' or 'count' tags in root
                # Based on debug output: <response><status>OK</status><total>796</total>...
                total_node = root.find('total')
                if total_node is not None:
                    try:
                        total = int(total_node.text)
                    except:
                        total = 0
                
                results = []
                for node in nodes:
                    try:
                        ident = node.find('ident').text
                        name = node.find('name').text
                        size = int(node.find('size').text)
                        
                        thumb = None
                        for candidate_node in (node.find('stripe'), node.find('img'), node.find('preview')):
                            if candidate_node is None or not candidate_node.text:
                                continue
                            thumb = resolve_webshare_detail_preview(candidate_node.text.strip())
                            if thumb:
                                break

                        results.append({
                            'id': ident,
                            'title': name,
                            'size_bytes': size,
                            'size_human': f"{size / (1024*1024):.2f} MB",
                            'link': f"webshare:{ident}:{name}",
                            'thumbnail': thumb
                        })
                    except: continue

                if sort != 'recent':
                     results.sort(key=lambda x: x['size_bytes'], reverse=True)
                return {"results": results, "total": total}

            except ET.ParseError:
                logger.error(f"Webshare API returned non-XML: {resp.text[:100]}")
                return {"results": [], "total": 0}
                
        except Exception as e:
            logger.error(f"Webshare Search Error: {e}")
            return {"results": [], "total": 0}

    def get_vip_link(self, ident):
        """
        Get direct VIP URL for a file using the token.
        Returns None if token is missing or invalid.
        """
        if not self.ensure_token():
            logger.warning("Webshare authentication failed. Cannot get VIP link.")
            return None

        url = f"{self.base_url}/file_link/"
        data = {'ident': ident, 'wst': self.token}
        try:
            resp = requests.post(url, data=data, headers=self.headers)
            clean_content = self.clean_xml(resp.text)
            root = ET.fromstring(clean_content)
            
            status = root.find('status')
            if status is not None and status.text != 'OK':
                message = root.find('message')
                msg_text = message.text if message is not None else 'Unknown error'
                logger.error(f"Webshare API error for ident {ident}: {msg_text} (Status: {status.text})")
                return None

            link = root.find('link')
            if link is not None and link.text:
                logger.info(f"Successfully resolved VIP link for ident {ident}.")
                return link.text
            else:
                logger.warning(f"VIP link not found in response for ident {ident}.")
                return None
        except Exception as e:
            logger.error(f"Failed to resolve VIP link for {ident}: {e}")
            return None

    def get_file_info(self, ident):
        """Fetch Webshare file metadata including technical info and thumbnail."""
        if not self.ensure_token():
            logger.warning("Webshare authentication failed. Cannot get file info.")
            return None

        url = f"{self.base_url}/file_info/"
        data = {'ident': ident, 'wst': self.token}
        try:
            resp = requests.post(url, data=data, headers=self.headers, timeout=10)
            clean_content = self.clean_xml(resp.text)
            root = ET.fromstring(clean_content)

            status = root.find('status')
            if status is not None and status.text != 'OK':
                message = root.find('message')
                msg_text = message.text if message is not None else 'Unknown error'
                logger.warning(f"Webshare file_info error for ident {ident}: {msg_text} (Status: {status.text})")
                return None

            result = {}
            
            # Basic info
            name_node = root.find('name')
            if name_node is not None and name_node.text:
                result['name'] = name_node.text

            size_node = root.find('size')
            if size_node is not None and size_node.text and size_node.text.isdigit():
                result['size_bytes'] = int(size_node.text)

            # Technical metadata
            length_node = root.find('length')
            if length_node is not None and length_node.text and length_node.text.isdigit():
                result['duration'] = int(length_node.text)

            width_node = root.find('width')
            if width_node is not None and width_node.text and width_node.text.isdigit():
                result['width'] = int(width_node.text)

            height_node = root.find('height')
            if height_node is not None and height_node.text and height_node.text.isdigit():
                result['height'] = int(height_node.text)

            thumb_url = None
            for candidate_node in (root.find('stripe'), root.find('img')):
                if candidate_node is not None and candidate_node.text:
                    thumb_url = resolve_webshare_detail_preview(candidate_node.text.strip())
                    if thumb_url:
                        break

            if not thumb_url:
                for node in root.iter():
                    tag = node.tag.lower()
                    text = (node.text or '').strip()
                    if tag in ('preview', 'icon', 'thumbnail', 'thumb', 'image') and text:
                        thumb_url = resolve_webshare_detail_preview(text)
                        if thumb_url:
                            break

            if thumb_url:
                result['thumbnail'] = thumb_url

            return result if result else None
        except Exception as e:
            logger.error(f"Failed to fetch file info for {ident}: {e}")
            return None

if __name__ == "__main__":
    # Test
    # Make sure to set WEBSHARE_TOKEN environment variable to run this test
    ws = WebshareAPI()
    if ws.token:
        res = ws.search_files("deepthroat")
        for r in res:
            print(f"{r['title']} - {r['size_human']}")
            vip_url = ws.get_vip_link(r['id'])
            print(f"  -> VIP Link: {vip_url}")
    else:
        print("Set WEBSHARE_TOKEN environment variable to test.")
