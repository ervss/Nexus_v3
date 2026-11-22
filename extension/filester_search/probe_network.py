"""Small, read-only network probe; prints timing/status, never cookies or bodies."""
import asyncio
import json
import time
import httpx
from discovery.network import is_challenge

URLS = [
    ("filester_cold", "https://filester.me/f/0411c2f88d6cdcf4"),
    ("filester_keepalive", "https://filester.me/f/0411c2f88d6cdcf4"),
    ("urlscan", "https://urlscan.io/api/v1/search/?q=page.domain%3Afilester.me&size=1"),
    ("wayback", "https://web.archive.org/cdx/search/cdx?url=filester.me/f/*&output=json&fl=original,timestamp&collapse=urlkey&limit=1"),
]

async def main():
    async with httpx.AsyncClient(headers={"User-Agent":"FilesterPublicIndexer/13.0 (+diagnostic; four read-only requests)"}, timeout=12, follow_redirects=True) as client:
        for label,url in URLS:
            start=time.perf_counter()
            try:
                async with asyncio.timeout(15):
                    r=await client.get(url)
                print(json.dumps({"label":label,"seconds":round(time.perf_counter()-start,3),"status":r.status_code,"bytes":len(r.content),"challenge":is_challenge(r),"limits":{k:v for k,v in r.headers.items() if k in ["retry-after","x-rate-limit-limit","x-rate-limit-remaining","x-rate-limit-reset"]}}),flush=True)
            except (httpx.HTTPError,TimeoutError) as error:
                print(json.dumps({"label":label,"seconds":round(time.perf_counter()-start,3),"error":type(error).__name__}),flush=True)
            await asyncio.sleep(.8)

if __name__ == "__main__": asyncio.run(main())
