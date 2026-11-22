const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = { window: {}, location: { href: 'https://simpcity.cr/threads/test.1/page-2' }, URL };
vm.runInNewContext(fs.readFileSync('extensions/nexus-video-selector/overview.js', 'utf8'), ctx);
const m = ctx.window.NVSTurboModel;
const defaults = { search: '', resolution: 'all', status: 'all', sort: 'order', direction: 'asc' };

test('dedup identity uses hosting ID and rejects hostile hostname/path', () => {
  assert.equal(m.idOf('https://turbo.cr/embed/Ab-C_d?token=x'), 'Ab-C_d');
  assert.equal(m.idOf('https://turbo.cr/d/Ab-C_d'), 'Ab-C_d');
  for (const url of ['https://evil.test/turbo.cr/v/a', 'https://turbo.cr.evil.test/v/a', 'https://turbo.cr/a/a', 'http://turbo.cr/v/a']) assert.equal(m.idOf(url), null);
});
test('portrait resolution, ranges and unknown ordering in both directions', () => {
  const rows = [{id:'p',title:'Portrait',order:1,width:1080,height:1920,duration:60,size_bytes:1048576,status:'ready'}, {id:'u',title:'Unknown',order:2,status:'unknown'}, {id:'s',title:'Small',order:3,width:720,height:1280,duration:20,size_bytes:2097152,status:'ready'}];
  assert.deepEqual(Array.from(m.filtered(rows,{...defaults,resolution:'1080'}),r=>r.id), ['p']);
  assert.deepEqual(Array.from(m.filtered(rows,{...defaults,sort:'duration',direction:'desc'}),r=>r.id), ['p','s','u']);
  assert.deepEqual(Array.from(m.filtered(rows,{...defaults,sort:'duration',direction:'asc'}),r=>r.id), ['s','p','u']);
  assert.deepEqual(Array.from(m.filtered(rows,{...defaults,sizeMin:'1.5'}),r=>r.id), ['s']);
  assert.equal(m.totals(rows).missingSize,1);
  assert.equal(m.totals(rows).size_bytes,3145728);
  assert.equal(m.durationText(3661),'1:01:01');
});
test('per-item results never confuse a queued job or unrelated result with completion', () => {
  const item = {url:'https://turbo.cr/v/a'};
  const results = [{index:0,url:item.url,status:'imported',video_id:42},{index:1,url:'https://turbo.cr/v/b',status:'skipped',reason:'too_short'}];
  assert.equal(m.importOutcome(item,0,{success:true,data:{results}}).status,'imported');
  assert.equal(m.importOutcome({url:'https://turbo.cr/v/b'},1,{success:true,data:{results}}).status,'error');
  assert.equal(m.importOutcome(item,0,{success:true,data:{job_id:7,imported:1}}).status,'queued');
  assert.equal(m.importOutcome(item,0,{success:true,data:{imported:1}}).status,'uncertain');
  assert.equal(m.importOutcome(item,0,{success:true,data:{results:[{...results[0],url:'https://turbo.cr/v/other'}]}}).status,'uncertain');
});
