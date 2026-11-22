"""Repeatable validation benchmark: six 800 ms responses, no external traffic."""
import asyncio
import json
import os
import tempfile
import time
from pathlib import Path
from unittest.mock import patch
import httpx
from index.database import Database
from discovery.pool import validate_pool

async def main(directory):
    os.environ["FILESTER_DATA_DIR"] = directory
    db = Database(Path(directory)/"index.db")
    for n in range(6):
        db.upsert_candidate(f"abcd{n:012x}",["benchmark"],["test"],score=1)
    async def response(request):
        await asyncio.sleep(.8)
        return httpx.Response(200, text='<meta property="og:title" content="Benchmark folder"> with 4 files',headers={"Content-Type":"text/html"})
    original = httpx.AsyncClient
    def factory(*args,**kwargs):
        kwargs["transport"] = httpx.MockTransport(response)
        return original(*args,**kwargs)
    async def run(label):
        db._conn.execute("UPDATE candidates SET status='unvalidated'")
        db._conn.commit()
        start=time.perf_counter()
        result=await validate_pool(db,budget=6)
        return {"label":label,"seconds":round(time.perf_counter()-start,3),"validated":result["validated"],"content":result["CONTENT"]}
    with patch("httpx.AsyncClient",factory):
        cold=await run("cold");warm=await run("repeat")
    db.close()
    return [cold,warm]

if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="filester-benchmark-") as directory:
        print(json.dumps(asyncio.run(main(directory)),indent=2))
