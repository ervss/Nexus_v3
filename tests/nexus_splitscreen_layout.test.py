import re
from playwright.sync_api import sync_playwright

with open('userscripts/nexus-universal-splitscreen.user.js', 'r', encoding='utf-8') as f:
    js = f.read()

styles_match = re.search(r'const STYLES = `(.*?)`;', js, re.DOTALL)
assert styles_match, 'STYLES not found in user script'
css = styles_match.group(1)

html = f"""
<!DOCTYPE html>
<html>
<head>
<style>
{css}
body {{ margin: 0; padding: 0; background: #000; }}
.nuss-picker-box {{ width: 1140px; height: 840px; display: flex; flex-direction: column; }}
</style>
</head>
<body>
<div class="nuss-picker-box">
  <div class="nuss-picker-list" id="list" data-layout="3x2">
    <div class="nuss-card">
      <div class="nuss-card-stage">
        <img class="nuss-card-thumb" src="https://example.com/thumb.jpg">
      </div>
      <div class="nuss-card-caption">
        <div class="nuss-card-title">Super HD Video Title</div>
        <div class="nuss-card-meta-row">
          <span class="nuss-card-type-tag">⚡ XHAMSTER</span>
        </div>
      </div>
    </div>
  </div>
</div>
</body>
</html>
"""

def test_layouts():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1280, 'height': 900})
        page.set_content(html)
        
        for layout in ['3x2', '4x2', '3x3', '4x3', 'list']:
            page.evaluate(f"document.getElementById('list').setAttribute('data-layout', '{layout}')")
            card_box = page.locator('.nuss-card').bounding_box()
            stage_box = page.locator('.nuss-card-stage').bounding_box()
            thumb_box = page.locator('.nuss-card-thumb').bounding_box()
            
            assert card_box['height'] > 0, f"Card collapsed in {layout}"
            assert stage_box['height'] > 0, f"Stage collapsed in {layout}"
            assert thumb_box['height'] > 0, f"Thumb collapsed in {layout}"
            
            if layout == 'list':
                assert abs(card_box['height'] - 72.0) < 1.0, f"List card height expected 72px, got {card_box['height']}"
                assert abs(stage_box['width'] - 100.0) < 1.0, f"List stage width expected 100px, got {stage_box['width']}"
                assert abs(stage_box['height'] - 56.0) < 1.0, f"List stage height expected 56px, got {stage_box['height']}"
            else:
                ratio = stage_box['height'] / stage_box['width']
                assert abs(ratio - 0.5625) < 0.01, f"Expected 16:9 ratio (0.5625), got {ratio} in {layout}"
                assert stage_box['height'] >= 100.0, f"Stage too small in {layout}: {stage_box['height']}"
                
        browser.close()
    print("[OK] Playwright Layout Test: All grid (3x2, 4x2, 3x3, 4x3) and list layouts verified in Chromium!")

if __name__ == '__main__':
    test_layouts()
