// Local visual check. Neutral cards, no remote site.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', 'extensions', 'nexus-video-selector');
const svg = (label, color) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="100%" height="100%" fill="${color}"/><text x="16" y="100" fill="white" font-size="28" font-family="sans-serif">${label}</text></svg>`)}`;
const page2 = `<script id='initials-script'>window.initials=${JSON.stringify({
  layoutPage: { videoListProps: { videoThumbProps: [
    { id: 11, pageURL: 'https://example.test/videos/extra-one', thumbURL: svg('Extra 1', '#2f6f4e'), title: 'Extra one', duration: 905, created: 1791522056, views: 0 },
    { id: 12, pageURL: 'https://example.test/videos/extra-two', thumbURL: svg('Extra 2', '#3a6ea5'), title: 'Extra two', duration: 624, created: 1791514476, views: 1200 },
  ] } },
})};</script>
<div class="thumb-list__item video-thumb"><div class="placeholderSkeleton"></div><div class="video-thumb__date-added">9 October 2026</div></div>
<div class="thumb-list__item video-thumb"><div class="placeholderSkeleton"></div><div class="video-thumb__date-added">9 October 2026</div></div>
<a rel="next" href="https://example.test/3">Next</a>`;
const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>xHamster listing load check</title><link rel="stylesheet" href="/styles.css"><style>
body{margin:0;background:#12141c;color:#eee;font:14px system-ui}
main{display:grid;grid-template-columns:minmax(0,1fr) 520px;gap:18px;padding:24px}
#grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-content:start}
.thumb-list__item{background:#1c1e27;border-radius:10px;overflow:hidden;min-height:180px}
.thumb-image-container__image{width:100%;height:140px;object-fit:cover;display:block;background:#2a2d38}
.video-thumb__date-added,.video-thumb-info__name,.video-thumb-views,.tiny-fda7e{display:block;padding:4px 10px}
.placeholderSkeleton{height:140px;background:#2a2d38}
.skeleton-demo .video-thumb__date-added::after{content:" ›"}
#status{padding:8px 0;color:#b9f0cf}
</style></head><body>
<main><section><h1>Load next page into this window</h1><p id="status">Waiting.</p><div id="grid" data-role="thumb-list-block"></div></section><section id="panel-host"></section></main>
<script src="/listing.js"></script><script src="/workbench.js"></script><script>
const api = window.NVSXhamsterListing;
const grid = document.querySelector('#grid');
const existing = document.createElement('article');
existing.className = 'thumb-list__item video-thumb';
existing.innerHTML = '<img class="thumb-image-container__image" src="${svg('Already here', '#6d4ea3')}" alt=""><div class="video-thumb-info__name">Already here</div>';
const broken = document.createElement('article');
broken.className = 'thumb-list__item video-thumb skeleton-demo';
broken.innerHTML = '<div class="placeholderSkeleton"></div><div class="video-thumb__date-added">9 October 2026</div>';
grid.append(existing, broken);
const page2 = ${JSON.stringify(page2).replace(/</g, '\\u003c')};
let rows = [{card: existing, url:'https://example.test/videos/here', title:'Already here', selected:false, order:1, quality:2160, duration:600, size:100, date:Date.now()}];
function add(video, card){rows.push({card, url:video.pageURL, title:video.title, selected:false, order:rows.length+1, quality:1080, duration:video.duration, size:100, date:video.created*1000});}
const wb = window.createNVSImportWorkbench({
  rows:()=>rows.filter(r=>r.card.isConnected),
  select(card, selected){const r=rows.find(r=>r.card===card); if(r) r.selected=selected;},
  selectionChanged(){}, clear(){}, copy(){}, scan(){wb.refresh();},
  sort(cards){api.reorderManagedNodes(grid, cards);},
  fetch(){return {queued:0,locked:0};},
  async load(){
    const before = grid.querySelectorAll('.placeholderSkeleton').length;
    const videos = api.videosFromHtml(page2);
    const skeletonsInSource = (page2.match(/placeholderSkeleton/g)||[]).length;
    for (const video of videos){const card=api.elementFromCardHtml(video); grid.append(card); add(video, card);} 
    const after = grid.querySelectorAll('.placeholderSkeleton').length;
    const titles = [...grid.querySelectorAll('.video-thumb-info__name')].map(el=>el.textContent);
    const images = [...grid.querySelectorAll('img')].map(img=>img.getAttribute('src')||'');
    const ok = videos.length===2 && after===before && titles.includes('Extra one') && titles.includes('Extra two') && images.every(src=>src.startsWith('data:image')) && api.nextPageHref(page2)==='https://example.test/3';
    document.querySelector('#status').textContent = ok
      ? 'PASS: appended '+videos.length+' real cards. Source had '+skeletonsInSource+' gray placeholders and none were added.'
      : 'FAIL videos='+videos.length+' skeletons before='+before+' after='+after;
    document.body.dataset.result = ok ? 'pass' : 'fail';
    return videos.length;
  },
  importing:()=>false, status:()=>({label:'Sken',done:1,total:1,noSize:0,locked:0,errors:0,active:false}), import(){}
});
wb.mount();
for (const details of document.querySelectorAll('#nvs-sort-panel details')) {
  if (details.querySelector('summary')?.textContent.includes('Načítanie')) details.open = true;
}
</script></body></html>`;
http.createServer((req, res) => {
  if (req.url === '/listing.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(fs.readFileSync(path.join(root, 'xhamster-listing.js'))); return; }
  if (req.url === '/workbench.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(fs.readFileSync(path.join(root, 'import-workbench.js'))); return; }
  if (req.url === '/styles.css') { res.setHeader('Content-Type', 'text/css'); res.end(fs.readFileSync(path.join(root, 'styles.css'))); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(page);
}).listen(8797, '127.0.0.1');
