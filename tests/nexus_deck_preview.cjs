// Serve the real Deck files and forward media/API requests to the running Nexus.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../extensions/Nexus_Deck');
let failOnce = process.env.NEXUS_DECK_FAIL_ONCE_ID;
http.createServer((req, res) => {
  if (failOnce && req.url === `/stream_proxy/${failOnce}.mp4`) {
    failOnce = null;
    console.log('Injected one expired-stream failure for recovery verification');
    res.writeHead(403, {'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end('{"detail":"Expired test stream"}'); return;
  }
  if (/^\/(api\/|stream_proxy\/|hls_proxy)/.test(req.url)) {
    const upstream = http.request({hostname:'127.0.0.1',port:8000,path:req.url,method:req.method,headers:{...req.headers,host:'127.0.0.1:8000'}}, response => {
      console.log(`${req.method} ${req.url.split('?')[0]} -> ${response.statusCode}`);
      res.writeHead(response.statusCode,response.headers); response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end('Nexus unavailable'); });
    req.pipe(upstream); res.on('close',()=>upstream.destroy()); return;
  }
  const file = path.resolve(root, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/sidepanel.html' : req.url.split('?')[0]));
  if (!file.startsWith(root + path.sep)) {res.writeHead(403);res.end();return;}
  fs.readFile(file,(error,data)=>{
    if(error){res.writeHead(404);res.end();return;}
    const types={'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.woff2':'font/woff2'};
    res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);
  });
}).listen(Number(process.env.NEXUS_DECK_PREVIEW_PORT || 18765),'127.0.0.1',()=>console.log('Deck preview listening'));

