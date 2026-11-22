// Real tester template, neutral fixtures, local metadata transport only.
const http = require('node:http');
const fs = require('node:fs');
const requests = [];
let cancelled = 0;
const seed = `
 const fixtureItems = Array.from({length: 50}, (_, i) => ({
   url: 'https://example.com/video/' + i, title: (i < 40 ? 'match' : 'other') + ' test video ' + i,
 }));
 const fixtureAlbum = {url: 'https://example.com/album', status: 'success', extractor: 'Fixture',
   data: {title: 'Test album', kind: 'album', album_items: fixtureItems}};
 const fixtureChildren = fixtureItems.slice(0,40).map((item,i) => createAlbumChildResult(fixtureAlbum,item,i,50));
 searchFilter.value = 'match';
 selectedResultUrls = new Set([fixtureAlbum.url, ...fixtureChildren.map(item => item.url)]);
 renderResults({results: [fixtureAlbum, ...fixtureChildren], summary: {success: 1,total: 1}});
 activeHistoryBatchId = null;
 document.title = 'Tester metadata verification — neutral fixture';
`;
http.createServer(async (req,res) => {
 const url = new URL(req.url, 'http://127.0.0.1:8795');
 if (url.pathname.startsWith('/static/')) {
   const path = require('node:path');
   const staticRoot = path.resolve('app/static');
   const target = path.resolve('app', '.' + url.pathname);
   if (target.startsWith(staticRoot + path.sep) && fs.existsSync(target) && fs.statSync(target).isFile()) {
     res.setHeader('Content-Type', target.endsWith('.js') ? 'application/javascript' : 'text/css');
     res.end(fs.readFileSync(target));
   } else { res.statusCode=404; res.end(); }
   return;
 }
 if (url.pathname === '/evidence') {
   res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({requests,cancelled})); return;
 }
 if (url.pathname === '/api/tester/batch-meta') {
   let text = ''; for await (const chunk of req) text += chunk;
   const body = JSON.parse(text); requests.push(body);
   res.on('close', () => { if (!res.writableEnded) cancelled++; });
   if (req.headers.referer?.includes('slow=1')) await new Promise(resolve => setTimeout(resolve,20000));
   if (res.destroyed) return;
   res.setHeader('Content-Type','application/json');
   res.end(JSON.stringify({results: body.urls.map(url => {
     const index = Number(url.split('/').pop());
     return index === 3 ? {url,ok:true,title:'Partial fixture',duration:120} :
       {url,ok:true,title:'Complete fixture',duration:120,height:1080,quality:'1080p',size_bytes:104857600,size_mb:100,upload_date:'2026-10-01'};
   })})); return;
 }
 if (url.pathname.startsWith('/api/')) {
   res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({results:[],items:[],batches:[]})); return;
 }
 let template = fs.readFileSync('app/templates/tester.html','utf8');
 const end = template.lastIndexOf('</script>');
 template = template.slice(0,end) + seed + template.slice(end);
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end(template);
}).listen(8795,'127.0.0.1', () => console.log('Tester fixture http://127.0.0.1:8795'));
