import requests
from bs4 import BeautifulSoup

def scan_mega_folder(folder_url):
    response = requests.get(folder_url)
    soup = BeautifulSoup(response.text, 'html.parser')
    video_files = []
    for link in soup.find_all('a', href=True):
        if isinstance(link['href'], str) and any(ext in link['href'] for ext in ['.mp4', '.avi', '.mkv']):
            video_files.append(link['href'])
    return video_files