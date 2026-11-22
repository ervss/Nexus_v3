"""
Playwright Browser Playback Verification Script
==============================================
Tento skript spustí reálny headless Chromium prehliadač, načíta video priamo
z Nexus stream endpointu, overí HTML5 video udalosť 'playing' a spraví screenshot.
"""

import asyncio
import os
import sys
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

from playwright.async_api import async_playwright

async def verify_browser_playback(video_id=None, direct_url=None, base_url="http://127.0.0.1:8000"):
    print("=" * 60)
    print("   PLAYWRIGHT BROWSER PLAYBACK VERIFICATION")
    print("=" * 60)

    if video_id:
        target_stream = f"{base_url}/api/lite/stream/{video_id}"
    elif direct_url:
        target_stream = direct_url
    else:
        target_stream = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"

    print(f"Cieľový stream: {target_stream}")

    # Vytvorenie jednoduchej testovacej HTML stránky s videom
    html_content = f"""<!DOCTYPE html>
<html>
<head>
    <title>Nexus Browser Playback Test</title>
    <style>
        body {{ background: #0f172a; color: #fff; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }}
        video {{ width: 800px; height: 450px; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }}
        .badge {{ background: #22c55e; color: white; padding: 6px 12px; border-radius: 4px; margin-top: 10px; font-weight: bold; }}
    </style>
</head>
<body>
    <h2>Nexus LITE Player Verification</h2>
    <video id="player" controls autoplay muted playsinline src="{target_stream}"></video>
    <div id="status" class="badge">Inicializujem...</div>

    <script>
        const v = document.getElementById('player');
        const s = document.getElementById('status');
        v.addEventListener('loadeddata', () => {{ s.innerText = 'DÁTA NAČÍTANÉ (' + v.videoWidth + 'x' + v.videoHeight + ')'; }});
        v.addEventListener('playing', () => {{ s.innerText = 'PREHRÁVA SA: ' + Math.round(v.currentTime) + 's'; }});
        v.addEventListener('error', (e) => {{ s.innerText = 'CHYBA PREHRÁVANIA: ' + (v.error ? v.error.message : 'Unknown'); s.style.background = '#ef4444'; }});
    </script>
</body>
</html>"""

    temp_html = BASE_DIR / "scripts" / "player_test.html"
    temp_html.write_text(html_content, encoding="utf-8")
    screenshot_path = BASE_DIR / "scripts" / "playback_screenshot.png"

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()

        print(f"Otváram stránku v Chromium...")
        await page.goto(f"file:///{temp_html.as_posix()}")

        # Počkáme na prehrávanie alebo zlyhanie (max 10 sekúnd)
        playback_ok = False
        duration = 0
        current_time = 0
        video_width = 0
        video_height = 0

        for _ in range(20):
            await asyncio.sleep(0.5)
            video_state = await page.evaluate("""() => {
                const v = document.getElementById('player');
                return {
                    paused: v.paused,
                    currentTime: v.currentTime,
                    duration: v.duration,
                    readyState: v.readyState,
                    videoWidth: v.videoWidth,
                    videoHeight: v.videoHeight,
                    networkState: v.networkState,
                    error: v.error ? v.error.code : null
                };
            }""")

            if video_state["currentTime"] > 0.2 and video_state["readyState"] >= 2:
                playback_ok = True
                duration = video_state["duration"]
                current_time = video_state["currentTime"]
                video_width = video_state["videoWidth"]
                video_height = video_state["videoHeight"]
                break

        print(f"Stav videa: {video_state}")
        # Uloženie screenshotu
        await page.screenshot(path=str(screenshot_path))
        print(f"Screenshot uložený do: {screenshot_path}")

        await browser.close()

    result = {
        "playback_ok": playback_ok,
        "video_width": video_width,
        "video_height": video_height,
        "duration": duration,
        "played_seconds": round(current_time, 2),
        "screenshot": str(screenshot_path)
    }

    print("\n--- VÝSLEDOK PREHRÁVANIA V BROWSERI ---")
    print(f"Prehrávanie úspešné: {result['playback_ok']}")
    print(f"Rozmery: {result['video_width']}x{result['video_height']}")
    print(f"Prehraný čas: {result['played_seconds']}s / {round(result['duration'], 1)}s")

    return result

if __name__ == "__main__":
    vid_id = int(sys.argv[1]) if len(sys.argv) > 1 else None
    asyncio.run(verify_browser_playback(video_id=vid_id))
