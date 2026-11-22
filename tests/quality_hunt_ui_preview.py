"""Serve the production Quality Hunt UI with synthetic, offline search responses.

Run: python tests/quality_hunt_ui_preview.py
This exercises UI controls, not the installed browser extension or live providers.
"""
from pathlib import Path
import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / ".codex-test-tmp" / "quality-hunt-ui"
PORT = int(os.environ.get('QUALITY_HUNT_PREVIEW_PORT', '8769'))


def build():
    DEST.mkdir(parents=True, exist_ok=True)
    source = (ROOT / "extensions/Nexus_Gallery/universal_importer.js").read_text(encoding="utf-8-sig")
    template_start = source.index("        container.innerHTML = `", source.index("function getOrCreateOverlay"))
    template_start = source.index("`", template_start) + 1
    template = source[template_start:source.index("`;", template_start)]
    helpers = source[source.index("    function collectBestTitle("):source.index("    // ── Import ─", template_start)]
    gofile = source[source.index("    function isGofilePage("):source.index("    function isFileditchViewerPage(")]
    helpers = gofile + source[source.index("    function formatSize("):source.index("    function parseDurationSeconds(")] + helpers
    (DEST / "production.js").write_text(helpers, encoding="utf-8")
    (DEST / "production.css").write_text((ROOT / "extensions/Nexus_Gallery/universal_importer.css").read_text(encoding="utf-8-sig"), encoding="utf-8")
    thumbnail = "data:image/svg+xml," + __import__("urllib.parse", fromlist=["quote"]).quote('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="225"><rect width="400" height="225" fill="#173c53"/><circle cx="200" cy="110" r="65" fill="#63b3b6"/><text x="200" y="205" text-anchor="middle" fill="white" font-size="20">Testovací klip</text></svg>')
    common = {"title": "Coastal Walk Recording", "source": "Testovací zdroj", "url": f"http://127.0.0.1:{PORT}/sample.webm",
              "stream_url": f"http://127.0.0.1:{PORT}/sample.webm", "height": 720, "height_source": "metadata",
              "confirmed": True, "quality_status": "same", "reason": "scéna + dĺžka", "thumbnail": thumbnail, "duration_sec": 6}
    groups = {"other": [common, {**common, "source": "Testovacia knižnica"}],
              "maybe": [{**common, "confirmed": False, "height_source": "title", "quality_status": "estimated", "reason": "podobný názov", "title": "Coastal Walk Another Recording"}]}
    candidates = [
        {**common, 'id': 'one', 'identity_state': 'confirmed', 'availability_state': 'playable', 'quality_state': 'measured', 'evidence': [{'kind':'duration','source':'metadata','checked_at':1,'reason':'Rovnaká dĺžka'}]},
        {**common, 'url': f'http://127.0.0.1:{PORT}/sample.webm?copy=2', 'id': 'two', 'title':'Coastal Walk – zdroj s prístupom', 'identity_state':'confirmed', 'availability_state':'login_required', 'requires_login':True, 'quality_state':'estimated', 'height_source':'title', 'quality_status':'estimated'},
        {**common, 'url': f'http://127.0.0.1:{PORT}/sample.webm?copy=3', 'id':'three', 'title':'Coastal Walk – kandidát na overenie', 'identity_state':'possible', 'confirmed':False, 'availability_state':'unknown', 'quality_state':'unknown', 'height':0, 'quality_status':'unknown'},
        {**common, 'url': f'http://127.0.0.1:{PORT}/sample.webm?copy=4', 'id':'four', 'title':'Ten istý tvorca – iné video', 'identity_state':'related', 'confirmed':False, 'availability_state':'unknown', 'quality_state':'unknown', 'height':0, 'quality_status':'unknown'},
        {**common, 'url': f'http://127.0.0.1:{PORT}/sample.webm?copy=5', 'id':'five', 'title':'Nesúvisiaci surový nález', 'identity_state':'unverified', 'confirmed':False, 'availability_state':'unknown', 'quality_state':'unknown', 'height':2160, 'quality_status':'unknown'},
        {**common, 'url': f'http://127.0.0.1:{PORT}/sample.webm?copy=6', 'id':'six', 'title':'Odlišné testovacie video', 'identity_state':'rejected', 'confirmed':False, 'availability_state':'unknown', 'rejection_reason':'Odlišná scéna'},
    ]
    harness = r"""
const owner = document.querySelector('.nexus-import-overlay');
owner._boundVideo = document.querySelector('#original');
let polls = 0, cancelled = false, doneAfter = 3;
function showToast(text) { document.querySelector('#toast').textContent = text; }
function isHls(url) { return /\.m3u8(\?|$)/i.test(url || ''); }
function findThumbnail() { return ''; }
function getBestKnownDuration() { return 6; }
window.chrome = { runtime: { sendMessage(message, callback) {
 let answer = {ok: true};
 if (message.action === 'QUALITY_HUNT_START') { polls = 0; cancelled = false; doneAfter = message.payload.mode === 'deep' ? 20 : 3; answer = {ok:true, data:{job_id:'preview'}, baseUrl:location.origin}; }
 if (message.action === 'QUALITY_HUNT_POLL') answer = {ok:true,data:{status:cancelled?'cancelled':++polls>=doneAfter?'degraded':'running',groups:fixtureGroups,candidates:fixtureCandidates,cache:{hit:false},balance:{fetched:6,rejected:1,unverified:1},
  progress:{message:'Hľadám alternatívy'},diagnostics:[{source:'Testovacia knižnica',status:'ok',count:1},{source:'Testovací zdroj',status:'ok',count:2}]}};
 if (message.action === 'QUALITY_HUNT_CANCEL') cancelled = true;
 if (message.action === 'QUALITY_HUNT_META') answer = {ok:true,items:message.fast?message.urls.map(url=>({url,height:720,duration_sec:6,size_bytes:10485760,stream_url:location.origin+'/sample.webm?resolved=1'})):[],groups:fixtureGroups};
 if (message.action === 'QUALITY_HUNT_REPORT') answer = {ok:true,data:{status:'degraded',candidates:fixtureCandidates,groups:fixtureGroups}};
 if (message.action === 'IMPORT_VIDEO') { window.__lastImportVideo = message; answer = message.metadata.sourceUrl.includes('copy=3') ? {ok:false,error:'Testovacie zlyhanie importu'} : {ok:true}; }
 setTimeout(()=>callback(answer), 100);
}}};
owner.querySelector('.nexus-hunt-btn').onclick = () => startQualityHunt(owner).catch(error => showToast(error.message));
owner.querySelector('.nexus-hunt-retry').onclick = owner.querySelector('.nexus-hunt-btn').onclick;
owner.querySelector('.nexus-hunt-stop').onclick = () => stopQualityHunt(owner);
owner.querySelector('.nexus-hunt-popout').onclick = () => openHuntModal(owner);
owner.querySelector('.nexus-hunt-expand').onclick = () => owner.classList.toggle('nexus-hunt-expanded');
owner.querySelector('.nexus-hunt-collapse').onclick = () => { owner.querySelector('.nexus-hunt-panel').hidden = true; owner.querySelector('.nexus-hunt-panel').style.display='none'; };
"""
    html = """<!doctype html><html lang="sk"><meta charset="utf-8"><title>Nexus – náhľad iných verzií</title>
<link rel="stylesheet" href="production.css"><style>
body{background:#18151f;color:#f5f5f5;font:16px system-ui;padding:30px; margin:0}main{max-width:900px;margin:auto}h1{font-size:24px}p{line-height:1.6}
.nexus-import-overlay{position:relative!important;inset:auto!important;display:flex!important;float:right;margin:0 0 20px 20px;transform:none!important}
.nexus-port-menu{display:flex!important;width:340px!important;max-height:85vh!important}.nexus-port-menu>:not(.nexus-hunt-btn):not(.nexus-hunt-panel){display:none!important}
#original{width:440px;max-width:100%;background:#173c53}#toast{clear:both;min-height:30px;color:#d8b4fe}
</style><main><h1>Iné verzie klipu</h1><p>Lokálny náhľad produkčného UI. Výsledky sú testovacie, vyhľadávanie a import sú simulované.</p>
<div class="nexus-import-overlay nexus-fixed nexus-open">""" + template + """</div>
<video id="original" src="sample.webm" data-title="Coastal Walk Recording" controls muted></video><div id="toast" role="status"></div></main>
<script src="production.js"></script><script src="harness.js"></script></html>"""
    (DEST / "harness.js").write_text("window.onerror=(message)=>{document.querySelector('#toast').textContent=message;};\nconst fixtureGroups=" + json.dumps(groups) + ";const fixtureCandidates=" + json.dumps(candidates) + ";" + harness, encoding="utf-8")
    (DEST / "index.html").write_text(html, encoding="utf-8")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DEST), **kwargs)

    def do_GET(self):
        if urlparse(self.path).path == "/media_proxy.mp4":
            self.path = "/sample.webm"
        super().do_GET()


if __name__ == "__main__":
    build()
    print(f"UI preview: http://127.0.0.1:{PORT}/", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
