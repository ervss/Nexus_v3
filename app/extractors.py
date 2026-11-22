import requests
from bs4 import BeautifulSoup

def get_video_metadata(video_url):
    response = requests.get(video_url)
    soup = BeautifulSoup(response.text, 'html.parser')
    metadata = {}

    title_tag = soup.title
    if title_tag:
        metadata['title'] = title_tag.string

    description_tag = soup.find('meta', attrs={'name': 'description'})
    if description_tag and 'content' in description_tag.attrs:
        metadata['description'] = description_tag['content']

    # Add more metadata fields as needed

    return metadata

def scan_mega_folder(folder_url):
    response = requests.get(folder_url)
    soup = BeautifulSoup(response.text, 'html.parser')

    video_files = []
    for link in soup.find_all('a', href=True):
        if isinstance(link['href'], str) and any(link['href'].endswith(ext) for ext in ('.mp4', '.avi', '.mkv')):
            video_files.append(link['href'])

    return video_files