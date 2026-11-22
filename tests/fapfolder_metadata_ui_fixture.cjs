// Local browser fixture: production card UI and worker parsers, with only
// hostname guard and transport replaced. No requests reach a live dashboard.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve('artifacts/fapfolder-metadata');
const bg = fs.readFileSync('extensions/Nexus_Gallery/background.js', 'utf8');
const helpers = bg.slice(bg.indexOf('function parseFapFolderDuration'), bg.indexOf('async function reportCapturedStream'))
    + bg.slice(bg.indexOf('async function fetchHeadInfo'), bg.indexOf('function nexusQualityLabelFromHeight'));
const base = 'http://127.0.0.1:8793';
const worker = vm.createContext({ URL, AbortSignal, chrome: { storage: { session: { get: async () => ({}) } } },
    isMegaUserStorageUrl: () => false, mediaRefererFor: (_, ref) => ref, isBogusXvideosContentLength: () => false,
    fetch: async (url, options) => {
        if (String(url).startsWith('https://fapfolder.club/posts/')) {
            const id = new URL(url).pathname.split('/').pop();
            if (id === '3') return new Response('<title>Access required</title>');
            return new Response(`<a class="js_moment" data-time="2026-09-08 14:17:16">posted</a><video id="video-${id}" poster="${base}/thumb.svg"><source src="${base}/${id === '1' ? 'portrait.mp4' : 'landscape.mp4'}"></video>`);
        }
        return fetch(url, options);
    },
});
vm.runInContext(helpers, worker);
const server = http.createServer(async (req, res) => {
    const route = new URL(req.url, base).pathname;
    try {
        if (route === '/metadata') {
            if (new URL(req.url, base).searchParams.has('slow')) await new Promise(resolve => setTimeout(resolve, 10000));
            let body = '';
            for await (const chunk of req) body += chunk;
            const message = JSON.parse(body);
            const items = await worker.mapFapFolderWithLimit(message.items, 2, worker.hydrateFapFolderItem);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, items }));
            return;
        }
        if (route === '/content.js') {
            res.setHeader('Content-Type', 'application/javascript');
            res.end(fs.readFileSync('extensions/Nexus_Gallery/fapfolder_grid_importer.js', 'utf8')
                .replace("if (!/(^|\\.)fapfolder\\.club$/i.test(location.hostname)) return;", "if (location.hostname !== '127.0.0.1') return;"));
            return;
        }
        if (route === '/style.css') {
            res.setHeader('Content-Type', 'text/css');
            res.end(fs.readFileSync('extensions/Nexus_Gallery/fapfolder_grid_importer.css'));
            return;
        }
        if (route === '/thumb.svg') {
            res.setHeader('Content-Type', 'image/svg+xml');
            res.end('<svg xmlns="http://www.w3.org/2000/svg" width="360" height="460"><rect width="360" height="460" fill="#263347"/><text x="36" y="230" fill="#ddd" font-size="24">Metadata test video</text></svg>');
            return;
        }
        if (route.endsWith('.mp4')) {
            const file = path.join(root, path.basename(route));
            const size = fs.statSync(file).size;
            const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
            const start = range ? Number(range[1]) : 0;
            const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
            res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
                'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
            if (req.method === 'HEAD') res.end(); else fs.createReadStream(file, { start, end }).pipe(res);
            return;
        }
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html><meta charset="utf-8"><title>FapFolder metadata verification</title>
<link rel="stylesheet" href="/style.css"><style>body{background:#121218;color:white;font-family:system-ui;padding:32px}main{display:flex;gap:16px;margin-top:100px}a.pg_video{display:block;width:260px;height:360px;color:white;background:#263347;border-radius:12px;overflow:hidden}img{width:100%;height:100%;object-fit:cover}h1{font-size:24px}p{color:#aaa}</style>
<h1>FapFolder — metadata browser verification</h1><p>Local video fixtures: portrait 624×832 / 112.5 seconds; landscape 640×360 / 7.5 seconds; unavailable source.</p>
<main>${[1, 2, 3].map(id => `<a class="pg_video" href="https://fapfolder.club/posts/${id}"><img src="/thumb.svg" alt="Test video ${id}"></a>`).join('')}</main>
<script>window.chrome = { runtime: { sendMessage(message, callback) {
if (message.action === 'FAPFOLDER_IMPORT_BULK') { let result=document.getElementById('import-result');if(!result){result=document.createElement('pre');result.id='import-result';document.body.appendChild(result);}result.textContent=JSON.stringify(message);callback({ok:true,data:{count:message.items.length}});return; }
fetch('/metadata'+location.search,{method:'POST',body:JSON.stringify(message)}).then(r=>r.json()).then(callback).catch(e=>callback({ok:false,error:e.message}));
} } };</script><script src="/content.js"></script>`);
    } catch (error) { res.statusCode = 500; res.end(error.message); }
});
server.listen(8793, '127.0.0.1', () => console.log(`Fixture ready at ${base}`));
