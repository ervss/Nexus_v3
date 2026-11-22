import requests
import os
import logging
try:
    from mega import Mega
except Exception:
    Mega = None

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class GofileExtractor:
    def __init__(self):
        self.api_base = "https://api.gofile.io"
        self.token = self._get_guest_token()

    def _get_guest_token(self):
        """
        Gofile requires a guest token for unauthenticated API requests.
        """
        try:
            response = requests.post(f"{self.api_base}/accounts", timeout=10)
            response.raise_for_status()
            data = response.json()
            if data['status'] == 'ok':
                return data['data']['token']
        except Exception as e:
            logger.error(f"Error getting Gofile guest token: {e}")
        return None

    def get_content(self, content_id):
        """
        Recursively fetches file info from Gofile.
        """
        if not self.token:
            self.token = self._get_guest_token()
            
        url = f"{self.api_base}/contents/{content_id}"
        headers = {"Authorization": f"Bearer {self.token}"}
        
        try:
            response = requests.get(url, headers=headers, timeout=20)
            response.raise_for_status()
            data = response.json()
            
            if data['status'] != 'ok':
                logger.error(f"Gofile API error: {data.get('status')}")
                return []
            
            files = []
            content_data = data['data']
            
            # If it's a folder, traverse children
            if content_data['type'] == 'folder':
                for child_id, child_info in content_data.get('children', {}).items():
                    if child_info['type'] == 'file':
                        files.append({
                            "name": child_info['name'],
                            "link": child_info['link'],
                            "size": child_info['size'],
                            "mimetype": child_info['mimetype'],
                            "thumbnail": child_info.get('thumbnail')
                        })
                    elif child_info['type'] == 'folder':
                        files.extend(self.get_content(child_id))
            else:
                # Single file
                files.append({
                    "name": content_data['name'],
                    "link": content_data['link'],
                    "size": content_data['size'],
                    "mimetype": content_data['mimetype'],
                    "thumbnail": content_data.get('thumbnail')
                })
                
            return files
        except Exception as e:
            logger.error(f"Error fetching Gofile content: {e}")
            return []

class MegaExtractor:
    def __init__(self):
        if Mega is None:
            raise RuntimeError("Mega client is unavailable in this environment")
        self.mega = Mega()

    def get_info(self, url):
        """
        Retrieves file/folder info from Mega.nz.
        """
        try:
            # Using mega.py features to handle URLs
            # Note: handle quota limits gracefully in download logic
            info = self.mega.get_public_url_info(url)
            return info
        except Exception as e:
            logger.error(f"Error fetching Mega info: {e}")
            return None

class PixeldrainExtractor:
    def __init__(self):
        self.api_base = "https://pixeldrain.com/api"

    def get_file_info(self, file_id_or_url):
        """
        Gets file info from Pixeldrain API. Can accept ID or full URL.
        """
        import re
        file_id = file_id_or_url
        item_index = None

        if 'pixeldrain.com' in file_id_or_url:
            match = re.search(r'/(?:u|l|file|filesystem|d)/([a-zA-Z0-9_-]+)', file_id_or_url)
            if match:
                file_id = match.group(1)
            else:
                return None
            
            item_match = re.search(r'(?:#|\?)item=(\d+)', file_id_or_url)
            if item_match and '/l/' in file_id_or_url:
                item_index = int(item_match.group(1))

        if item_index is not None:
            list_url = f"{self.api_base}/list/{file_id}"
            try:
                response = requests.get(list_url, timeout=10)
                response.raise_for_status()
                data = response.json()
                files = data.get('files', [])
                if item_index < len(files):
                    file_info = files[item_index]
                    real_file_id = file_info.get('id')
                    return {
                        "name": file_info.get("name"),
                        "size": file_info.get("size"),
                        "link": f"https://pixeldrain.com/api/file/{real_file_id}",
                        "thumbnail": f"https://pixeldrain.com/api/file/{real_file_id}/thumbnail"
                    }
            except Exception as e:
                logger.error(f"Error fetching Pixeldrain list item info: {e}")
                return None

        url = f"{self.api_base}/file/{file_id}/info"
        try:
            response = requests.get(url, timeout=10)
            response.raise_for_status()
            data = response.json()
            
            result = {
                "name": data.get("name"),
                "size": data.get("size"),
                "link": f"https://pixeldrain.com/api/file/{file_id}",
                "thumbnail": f"https://pixeldrain.com/api/file/{file_id}/thumbnail"
            }
            if data.get("duration"):
                result["duration"] = int(data["duration"])
            return result
        except Exception as e:
            logger.error(f"Error fetching Pixeldrain info: {e}")
            return None

    def get_folder_content(self, folder_id_or_url):
        """
        Recursively fetches file info from Pixeldrain filesystem API or list API.
        """
        import re
        from urllib.parse import quote, unquote
        folder_id = folder_id_or_url
        is_list = False
        
        if 'pixeldrain.com' in folder_id_or_url:
            if '/l/' in folder_id_or_url:
                is_list = True
                match = re.search(r'/l/([a-zA-Z0-9_-]+)', folder_id_or_url)
                if match:
                    folder_id = match.group(1)
                else:
                    return []
            else:
                match = re.search(r'/(?:filesystem|d)/(.+?)(?:[?#]|$)', folder_id_or_url)
                if match:
                    raw_path = match.group(1).strip('/')
                    parts = [unquote(p) for p in raw_path.split('/') if p]
                    folder_id = "/".join(quote(p) for p in parts)
                else:
                    match2 = re.search(r'/(?:u|filesystem|d)/([a-zA-Z0-9_-]+)', folder_id_or_url)
                    if match2:
                        folder_id = match2.group(1)
                    else:
                        return []

        if is_list:
            url = f"{self.api_base}/list/{folder_id}"
            try:
                response = requests.get(url, timeout=30)
                response.raise_for_status()
                data = response.json()
                files = []
                for child in data.get('files', []):
                    name = child.get('name', '')
                    mime = str(child.get('mime_type') or child.get('mime') or '').lower()
                    sz = child.get("size") or 0
                    exts = ('.mp4', '.mkv', '.avi', '.mov', '.webm', '.ts', '.m3u8', '.m4v')
                    if mime.startswith('video/') or name.lower().endswith(exts) or (mime == 'application/octet-stream' and sz > 4 * 1024 * 1024):
                        child_id = child.get('id')
                        files.append({
                            "name": name,
                            "link": f"https://pixeldrain.com/api/file/{child_id}",
                            "size": sz,
                            "thumbnail": f"https://pixeldrain.com/api/file/{child_id}/thumbnail"
                        })
                return files
            except Exception as e:
                logger.error(f"Error fetching Pixeldrain list info: {e}")
                return []

        url = f"{self.api_base}/filesystem/{folder_id}?stat"
        try:
            # Increase timeout for large folders
            response = requests.get(url, timeout=30)
            response.raise_for_status()
            data = response.json()
            
            files = []
            for child in data.get('children', []):
                if child.get('type') == 'file':
                    name = child.get('name', '')
                    if name.startswith('.search_index'):
                        continue
                    ft = str(child.get('file_type', '')).lower()
                    if ft.startswith('image/'):
                        continue
                    sz = child.get("file_size") or 0
                    exts = ('.mp4', '.mkv', '.avi', '.mov', '.webm', '.ts', '.m3u8', '.m4v')
                    is_vid = ft.startswith('video') or name.lower().endswith(exts) or (ft == 'application/octet-stream' and sz > 4 * 1024 * 1024)
                    if is_vid:
                        c_path = child.get('path', '')
                        enc_path = "/" + "/".join(quote(unquote(p)) for p in c_path.strip('/').split('/') if p)
                        files.append({
                            "name": name,
                            "link": f"https://pixeldrain.com/api/filesystem{enc_path}?attach",
                            "size": sz,
                            "thumbnail": f"https://pixeldrain.com/api/filesystem{enc_path}?thumbnail&width=128&height=128"
                        })
                elif child.get('type') == 'dir':
                    c_path = child.get('path', '')
                    parts = [p for p in c_path.split('/') if p]
                    if parts:
                        sub_id = "/".join(quote(unquote(p)) for p in parts)
                        files.extend(self.get_folder_content(sub_id))
            return files
        except Exception as e:
            logger.error(f"Error fetching Pixeldrain folder info: {e}")
            return []

if __name__ == "__main__":
    # Example usage
    # gofile = GofileExtractor()
    # print(gofile.get_content("XXXXX"))
    pass
