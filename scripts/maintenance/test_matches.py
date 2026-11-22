import re
from curl_cffi import requests as cffi

r = cffi.get("https://bigporn.com", impersonate="chrome124", timeout=10)
links = [l for l in set(re.findall(r'href=["\'](/[^"\'\s>]+)["\']', r.text)) if ".html" in l and not any(k in l for k in ["privacy", "terms", "contact", "dmca"])]
print("BigPorn html links:", links[:10])
