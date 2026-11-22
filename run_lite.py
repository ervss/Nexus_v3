"""
Nexus LITE Runner
=================
Spúšťa odľahčený zberný a galériový server Nexus LITE.
"""
import os
import sys
import webbrowser
from pathlib import Path

# Pridať koreňový priečinok do sys.path
BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

import uvicorn
from app.config import config

def main():
    port = int(os.getenv("PORT", config.SERVER_PORT or 8000))
    host = os.getenv("HOST", "0.0.0.0")
    
    print("=" * 60)
    print(f"  ⚡ NEXUS LITE — Ingest Server & Live Gallery Hub")
    print(f"  🌐 Beží na: http://localhost:{port}")
    print(f"  📂 Databáza: {config.DATABASE_URL}")
    print(f"  🚀 Režim: Ultra-fast background Ingest + Live Cards Feed")
    print("=" * 60)
    
    # Automatické otvorenie prehliadača po krátkej chvíli
    if os.getenv("NO_BROWSER", "0") != "1":
        import threading
        def open_browser():
            import time
            time.sleep(1.2)
            try:
                webbrowser.open(f"http://localhost:{port}")
            except Exception:
                pass
        threading.Thread(target=open_browser, daemon=True).start()

    uvicorn.run(
        "app.lite_app:app",
        host=host,
        port=port,
        reload=False,
        log_level="info",
    )

if __name__ == "__main__":
    main()
