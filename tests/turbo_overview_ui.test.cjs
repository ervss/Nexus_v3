const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

test('opening applies thread batch name and excludes short or unknown selections', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({status:200, contentType:'text/html', body:`<h1 class="p-title-value"><span class="label">Video</span> Black and Blacky vid screen</h1><main class="js-threadMessages">${['short','long','unknown'].map(id=>`<article id="post-${id}"><div class="message-body"><a href="https://turbo.cr/v/${id}">${id}</a></div></article>`).join('')}</main>`}));
    await page.goto('https://simpcity.cr/threads/black-and-blacky.300627/page-5');
    await page.evaluate(() => {
      window.__listeners = [];
      window.chrome = {storage:{sync:{get:async d=>d,set:async()=>{}}},runtime:{lastError:null,onMessage:{addListener:f=>window.__listeners.push(f)},sendMessage(m,cb){ if(m.type==='TURBO_OVERVIEW_META') setTimeout(()=>cb({meta:{ok:true, duration:m.url.endsWith('short')?59:m.url.endsWith('long')?60:null}}),30); else cb?.({}); }}};
    });
    await page.addScriptTag({path:path.resolve('extensions/nexus-video-selector/overview.js')});
    await page.evaluate(async () => {
      const selected = new Set();
      window.__overview = window.createNVSTurboOverview({isSelected:c=>selected.has(c),register:c=>selected.add(c),select:(c,v)=>v?selected.add(c):selected.delete(c),selectionChanged:()=>{},importItems:async()=>({}),exportJson:()=>{}});
      await window.__overview.init();
    });
    await page.locator('#nvs-overview-launch').click();
    await page.getByText('Sken dokončený',{exact:false}).waitFor();
    assert.equal(await page.locator('[data-part="batch"]').inputValue(),'Black and Blacky vid screen');
    assert.equal(await page.locator('[data-filter="durationMin"]').inputValue(),'60');
    assert.equal(await page.locator('.nvs-gallery-card').count(),1);
    assert.match(await page.locator('[data-part="summary"]').innerText(),/^0 vybraných/);
    await page.getByRole('button',{name:'Vybrať zobrazené'}).click();
    await page.waitForFunction(()=>document.querySelector('[data-video-id="long"] input')?.checked);
    assert.equal(await page.locator('[data-video-id="long"] input').isChecked(),true);
    await page.locator('[data-filter="durationMin"]').fill('');
    await page.locator('[data-video-id="short"] input').check();
    await page.locator('[data-part="batch"]').fill('Vlastný názov');
    await page.getByRole('button',{name:'Zatvoriť prehľad'}).click();
    await page.locator('#nvs-overview-launch').click();
    assert.equal(await page.locator('[data-filter="durationMin"]').inputValue(),'60');
    assert.equal(await page.locator('[data-part="batch"]').inputValue(),'Black and Blacky vid screen');
    assert.equal(await page.locator('[data-video-id="long"] input').isChecked(),true);
    assert.match(await page.locator('[data-part="summary"]').innerText(),/^1 vybraných/);
  } finally { await browser.close(); }
});

test('overview preserves hidden selection, synchronizes cards, limits concurrency and retries only failed imports', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body><main class="js-threadMessages">' +
      Array.from({length:6},(_,i)=>`<article id="js-post-${i+1}"><a href="#post-${i+1}">#${i+1}</a><div class="message-body"><a href="https://turbo.cr/v/id${i}">Video ${i}</a>${i===0?'<a href="https://turbo.cr/d/id0">Duplicate</a>':''}</div></article>`).join('') + '</main></body></html>' }));
    await page.goto('https://simpcity.cr/threads/mock.1/');
    await page.evaluate(() => {
      window.__test = { active:0, max:0, cancelled:0, imports:[], metaCalls:0, listeners:[] };
      window.chrome = { storage: { sync: { get(defaults,cb) { if(cb) { cb(defaults); return; } return Promise.resolve(defaults); },set:async()=>{} } }, runtime: { lastError:null,onMessage:{addListener(fn){window.__test.listeners.push(fn);}},sendMessage(msg,cb) {
        if(msg.type==='TURBO_OVERVIEW_CANCEL') { window.__test.cancelled++; cb?.({ok:true}); return; }
        if(msg.type==='TURBO_OVERVIEW_META') {
          window.__test.metaCalls++; window.__test.active++;window.__test.max=Math.max(window.__test.max,window.__test.active);
          setTimeout(()=>{ window.__test.active--;cb(window.__test.metadataFailure?{meta:{ok:false,error:'Resolver nedostupný'}}:{meta:{ok:true,title:msg.url.endsWith('id0')?'Portrait':'Clip '+msg.url.split('/').pop(),duration:60,width:1080,height:1920,size_bytes:1048576}}); },150);return;
        }
        if(msg.type==='IMPORT_TO_NEXUS') { window.__test.imports.push(msg);setTimeout(()=>cb(window.__test.offline?{success:false,error:'Nexus offline'}:{success:true,data:{results:msg.items.map((item,index)=>({index,url:item.url,status:item.url.endsWith('id1')&&window.__test.imports.length===1?'skipped':'imported',video_id:item.url.endsWith('id1')&&window.__test.imports.length===1?null:100+index,reason:'test-failure'}))}}),50);return; }
        cb?.({meta:null}); return Promise.resolve({meta:null});
      } } };
    });
    await page.addStyleTag({path:path.resolve('extensions/nexus-video-selector/styles.css')});
    await page.addScriptTag({path:path.resolve('extensions/nexus-video-selector/overview.js')});
    await page.addScriptTag({path:path.resolve('extensions/nexus-video-selector/content.js')});
    await page.locator('[data-nvs-turbo-id="id0"] .nvs-checkbox').first().click();
    await page.getByRole('button',{name:'Skenovať vybrané',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[data-nvs-turbo-id="id0"] .nvs-thread-meta').textContent.includes('1.0 MiB'));
    assert.equal(await page.locator('#nvs-overview').count(),0);
    assert.equal(await page.evaluate(()=>window.__test.metaCalls),1);
    assert.equal(await page.locator('[data-nvs-turbo-id="id0"] .nvs-thread-meta').count(),2);
    await page.getByRole('button',{name:'Vybrať všetky',exact:true}).click();
    await page.getByRole('button',{name:'Skenovať vybrané',exact:true}).click();
    await page.waitForFunction(()=>[...document.querySelectorAll('.nvs-thread-meta')].every(el=>el.textContent.includes('MiB')));
    // Reset fixture selection before the independent gallery import assertions.
    await page.locator('#nvs-btn-deselect-all').evaluate(button => button.click());
    await page.locator('#nvs-overview-launch').click();
    await page.getByText('Sken dokončený',{exact:false}).waitFor();
    assert.equal(await page.locator('#nvs-overview .nvs-gallery-card').count(),6);
    assert.equal(await page.locator('#nvs-overview iframe').count(),6);
    assert.equal(await page.locator('.nvs-gallery').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),3);
    assert.equal(await page.locator('.nvs-gallery-media > .nvs-gallery-metrics').count(),6);
    assert.equal(await page.locator('.nvs-gallery-card').first().evaluate(c=>c.querySelector('.nvs-gallery-info').getBoundingClientRect().bottom<=c.getBoundingClientRect().bottom),true);
    await page.evaluate(()=>window.__test.listeners.forEach(fn=>fn({type:'TURBO_FRAME_META',id:'id0',meta:{duration:299,width:848,height:480,size_bytes:230893804}})));
    await page.waitForFunction(()=>document.querySelector('[data-video-id="id0"] .nvs-gallery-metrics').textContent.includes('220.2 MiB'));
    assert.match(await page.locator('[data-video-id="id0"] .nvs-gallery-metrics').innerText(),/4:59/);
    await page.locator('#nvs-overview iframe').first().evaluate(el=>el.dataset.identity='preserved');
    assert.equal(await page.evaluate(()=>window.__test.max),3);
    await page.locator('#nvs-overview [data-video-id="id0"] input').check();
    assert.equal(await page.locator('#nvs-overview iframe').first().getAttribute('data-identity'),'preserved');
    assert.equal(await page.locator('[data-nvs-turbo-id="id0"] .nvs-checkbox[aria-checked="true"]').count(),2);
    await page.getByPlaceholder('Názov alebo ID videa').fill('id1');
    await page.getByRole('button',{name:'Vybrať zobrazené',exact:true}).click();
    await page.locator('#nvs-overview [data-filter="direction"]').selectOption('desc');
    await page.getByRole('button',{name:'Importovať vybrané (2)',exact:true}).waitFor();
    assert.match(await page.locator('[data-part="summary"]').innerText(),/2 vybraných · 1 skrytých filtrom/);
    await page.getByRole('button',{name:'Importovať vybrané (2)',exact:true}).click();
    await page.getByRole('button',{name:'Zopakovať iba zlyhané'}).waitFor();
    await page.waitForFunction(()=>window.__test.imports.length===1&&!document.querySelector('[data-part="import"]').textContent.includes('Importuje'));
    assert.deepEqual(await page.evaluate(()=>window.__test.imports[0].items.map(i=>i.url).sort()),['https://turbo.cr/v/id0','https://turbo.cr/v/id1']);
    assert.equal(await page.evaluate(()=>window.__test.imports[0].strictPort),true);
    await page.getByRole('button',{name:'Zopakovať iba zlyhané'}).click();
    await page.waitForFunction(()=>window.__test.imports.length===2);
    assert.deepEqual(await page.evaluate(()=>window.__test.imports[1].items.map(i=>i.url)),['https://turbo.cr/v/id1']);
    await page.getByRole('button',{name:'Zatvoriť prehľad'}).click();
    assert.equal(await page.locator('#nvs-overview').count(),0);
    // A new post is discovered without clearing the existing record/selection.
    await page.evaluate(()=>{const post=document.createElement('article');post.id='js-post-99';post.innerHTML='<div class="message-body"><a href="https://turbo.cr/v/new">New</a></div>';document.querySelector('main').append(post);});
    await page.locator('#nvs-overview-launch').click();
    await page.getByPlaceholder('Názov alebo ID videa').fill('');
    await page.getByText('7 unikátnych videí',{exact:false}).waitFor();
    await page.waitForFunction(()=>document.querySelectorAll('#nvs-overview .nvs-gallery-card').length===7);
    assert.equal(await page.locator('#nvs-overview iframe').count(),7);
    assert.equal(await page.getByRole('button',{name:'Ďalšia',exact:true}).count(),0);
    assert.equal(await page.locator('.nvs-gallery').evaluate(el=>el.scrollHeight>el.clientHeight),true);
    await page.locator('#nvs-overview [data-video-id="id0"] input').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#nvs-overview .nvs-gallery-card').count(),7);
    await page.locator('#nvs-overview [data-video-id="new"] input').waitFor();
    await page.setViewportSize({width:640,height:800});
    const overflow = await page.locator('#nvs-overview').evaluate(el=>el.scrollWidth>el.clientWidth);
    assert.equal(overflow,false);
    assert.equal(await page.getByRole('button',{name:'Zatvoriť prehľad'}).isVisible(),true);
    await page.locator('#nvs-overview [data-video-id="new"] input').check();
    await page.evaluate(()=>{window.__test.metadataFailure=true;window.__test.offline=true;});
    await page.getByRole('button',{name:'Obnoviť údaje'}).click();
    await page.getByRole('button',{name:'Stop',exact:true}).click();
    assert.ok(await page.evaluate(()=>window.__test.cancelled)>=1);
    await page.getByRole('button',{name:'Pokračovať',exact:true}).click();
    await page.getByText('Sken dokončený',{exact:false}).waitFor();
    assert.equal(await page.locator('#nvs-overview [data-video-id="new"] input').isChecked(),true);
    await page.getByRole('button',{name:'Importovať vybrané (1)',exact:true}).click();
    await page.getByText('Nexus offline',{exact:false}).waitFor();
    assert.equal(await page.locator('#nvs-overview [data-video-id="new"] input').isChecked(),true);
    assert.equal(await page.locator('[data-part="port"]').inputValue(),'8000');
    await page.setViewportSize({width:375,height:800});
    const footer = await page.locator('#nvs-overview footer').boundingBox();
    assert.ok(footer.y+footer.height<=800.5, JSON.stringify(footer));
  } finally { await browser.close(); }
});

test('turbo-preview blocks autoplay in gallery frames until user interaction', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body><video autoplay muted playsinline></video><button id="play-btn" type="button">Play</button></body></html>'
    }));
    await page.goto('https://turbo.cr/embed/demo123#nvs-gallery');
    await page.evaluate(() => {
      window.__pauseCalls = 0;
      window.__playAllowed = false;
      const v = document.querySelector('video');
      let paused = false;
      Object.defineProperty(v, 'paused', { get: () => paused, configurable: true });
      v.pause = () => { paused = true; window.__pauseCalls++; };
      v.play = () => {
        paused = false;
        v.dispatchEvent(new Event('play'));
        v.dispatchEvent(new Event('playing'));
        if (!paused) window.__playAllowed = true;
        return Promise.resolve();
      };
      window.chrome = { runtime: { sendMessage: () => Promise.resolve({ prepare: false }), onMessage: { addListener: () => {} } } };
      document.getElementById('play-btn').addEventListener('click', () => { void v.play(); });
    });
    await page.addScriptTag({ path: path.resolve('extensions/nexus-video-selector/turbo-preview.js') });
    assert.equal(await page.evaluate(() => document.querySelector('video').autoplay), false);
    assert.equal(await page.evaluate(() => document.querySelector('video').paused), true);
    await page.evaluate(() => document.querySelector('video').play());
    assert.equal(await page.evaluate(() => document.querySelector('video').paused), true);
    assert.equal(await page.evaluate(() => window.__playAllowed), false);
    await page.locator('#play-btn').click();
    assert.equal(await page.evaluate(() => document.querySelector('video').paused), false);
    assert.equal(await page.evaluate(() => window.__playAllowed), true);
  } finally { await browser.close(); }
});
