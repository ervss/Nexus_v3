// Local browser contract fixture. Only origin guard/protocol and extension transport
// are substituted; production source selection, parsing, paging and grid UI run unchanged.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const base='http://127.0.0.1:8794';
const sources={alpha:[1,45],bravo:[36,75],charlie:[66,100],broken:[101,112],slow:[113,160]};
const ids = name => Array.from({length:sources[name][1]-sources[name][0]+1},(_,i)=>sources[name][0]+i);
const cards = rows => rows.map(id=>`<li><a class="pg_video" href="https://fapfolder.club/posts/${id}"><img src="${base}/thumb.svg" alt="Test video ${id}"></a></li>`).join('');
const server=http.createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,base); const route=url.pathname;
  if(route==='/content.js') {
   res.setHeader('Content-Type','application/javascript');
   res.end(fs.readFileSync('extensions/Nexus_Gallery/fapfolder_grid_importer.js','utf8')
    .replace("if (!/(^|\\.)fapfolder\\.club$/i.test(location.hostname)) return;","if (location.hostname !== '127.0.0.1') return;")
    .replace("url.protocol !== 'https:'","!['http:', 'https:'].includes(url.protocol)")); return;
  }
  if(route==='/style.css'){res.setHeader('Content-Type','text/css');res.end(fs.readFileSync('extensions/Nexus_Gallery/fapfolder_grid_importer.css'));return;}
  if(route==='/thumb.svg'){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#36354d"/><text x="130" y="180" fill="#dfb4d0" font-size="28">Nexus test video</text></svg>');return;}
  if(route==='/video.mp4'){
   const file='artifacts/fapfolder-metadata/landscape.mp4'; const size=fs.statSync(file).size;
   const m=req.headers.range?.match(/bytes=(\d+)-(\d*)/);const start=m?Number(m[1]):0;const end=m&&m[2]?Math.min(Number(m[2]),size-1):size-1;
   res.writeHead(m?206:200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1,...(m?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});fs.createReadStream(file,{start,end}).pipe(res);return;
  }
  if(route==='/bridge'){
   let text='';for await(const part of req) text+=part;const message=JSON.parse(text);
   res.setHeader('Content-Type','application/json');
   if(message.action==='FAPFOLDER_IMPORT_BULK'){
    fs.mkdirSync('artifacts/fapfolder-mix',{recursive:true});fs.writeFileSync('artifacts/fapfolder-mix/import-payload.json',JSON.stringify(message,null,2));
    res.end(JSON.stringify({ok:true,data:{count:message.items.length}}));return;
   }
   res.end(JSON.stringify({ok:true,items:message.items.map(row=>({...row,streamUrl:base+'/video.mp4',sizeMb:1.5,sizeExact:true,addedAt:'2026-10-20 12:30:00'}))}));return;
  }
  if(route==='/includes/ajax/data/load.php'){
   let body='';for await(const part of req)body+=part;const params=new URLSearchParams(body);const name=params.get('id');const offset=Number(params.get('offset'));
   if(name==='slow')await new Promise(r=>setTimeout(r,1500));
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify(name==='broken'?{callback:'login()'}:{data:cards(ids(name).slice(offset*12,offset*12+12))||false,append:true}));return;
  }
  const match=route.match(/^\/groups\/(\w+)\/videos$/);
  if(match&&sources[match[1]]) {const name=match[1];res.setHeader('Content-Type','text/html');res.end(`<div class="profile-header">${name}</div><ul>${cards(ids(name).slice(0,12))}</ul><div class="js_see-more" data-get="videos" data-type="group" data-id="${name}"></div>`);return;}
  res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta charset="utf-8"><title>FapFolder combined gallery — local verification</title><link rel="stylesheet" href="/style.css"><style>body{background:#17141d;color:white;font:16px system-ui;padding:25px}.community-list{display:flex;gap:20px;max-width:calc(100% - 440px)}.ui-box{padding:20px;background:#312536;border-radius:12px;min-width:170px}.ui-box a{color:#ffb4d7}h1{font-size:24px}</style><h1>FapFolder: test spoločnej galérie</h1><p>3 testovacie kanály · 120 položiek · 100 jedinečných videí · 12 videí na stránku</p><div class="community-list">${['alpha','bravo','charlie'].map(name=>`<div class="ui-box"><a class="h6" href="/groups/${name}">${name}</a></div>`).join('')}</div><script>window.chrome={runtime:{sendMessage:async(message,callback)=>{try{callback(await(await fetch('/bridge',{method:'POST',body:JSON.stringify(message)})).json());}catch(e){callback({ok:false,error:e.message});}}}};</script><script src="/content.js"></script>`);
 }catch(e){res.statusCode=500;res.end(e.message);}
});
server.listen(8794,'127.0.0.1',()=>console.log('FapFolder mix fixture: '+base));
