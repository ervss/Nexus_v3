const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const path = require('node:path');

test('library loads qualities, downloads chosen variant, imports selections and handles failed scans', async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    await page.route('https://www.xvideos.com/**', route => route.fulfill({contentType:'text/html',body:'<html><body>Profile</body></html>'}));
    await page.goto('https://www.xvideos.com/models/test');
    await page.evaluate(() => {
      window.fixture = {listeners:[],downloads:[],copies:[],imports:[],active:0,maxActive:0,calls:0};
      Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>window.fixture.copies.push(value)}});
      window.chrome = {runtime:{onMessage:{addListener(fn){fixture.listeners.push(fn);}},async sendMessage(msg) {
        if(msg.type==='open-hotcontainer-red')return {ok:true,jobId:'gallery'};
        if(msg.type==='open-hotcontainer-library')return {ok:true,jobId:'library'};
        if(msg.type==='hotcontainer-qualities') {
          fixture.calls++;fixture.active++;fixture.maxActive=Math.max(fixture.maxActive,fixture.active);
          await new Promise(resolve=>setTimeout(resolve,100));fixture.active--;
          if(msg.url.includes('expired'))return {ok:false,error:'Odkaz vypršal'};
          return {ok:true,variants:[{url:msg.url.replace('master','1080'),label:'1080p'},{url:msg.url.replace('master','480'),label:'480p'}]};
        }
        if(msg.type==='hotcontainer-download'){fixture.downloads.push(msg);return {ok:true,method:'chrome'};}
        if(msg.type==='import-to-nexus'){fixture.imports.push(msg.items);return {ok:true,imported:msg.items.length,downloadsStarted:0};}
      }},storage:{local:{get:async()=>({}),set:async()=>{}}}};
    });
    await page.addScriptTag({path:path.resolve('extensions/hotcontainer-profile-handoff/xvideos.js')});
    await page.locator('#hc-profile-handoff').click();
    await page.getByRole('button',{name:'Moje videá',exact:true}).click();
    await page.evaluate(()=>fixture.listeners.forEach(fn=>fn({type:'hotcontainer-library',jobId:'library',items:Array.from({length:5},(_,i)=>({id:`item${i}`,title:`Video ${i}`,thumbnail:'',hqUrl:`https://hls-cdn77.xvideos-cdn.com/${i===4?'expired':i}/master.m3u8`}))})));
    const first=page.locator('[data-item-id="item0"]');
    await first.getByRole('combobox').locator('option').getByText('1080p',{exact:true}).waitFor({state:'attached'});
    assert.equal(await first.getByRole('combobox').inputValue(),'https://hls-cdn77.xvideos-cdn.com/0/1080.m3u8');
    await first.getByRole('combobox').selectOption({label:'480p'});
    await first.getByRole('button',{name:'Kopírovať URL',exact:true}).click();
    assert.equal(await page.evaluate(()=>fixture.copies.shift()),'https://hls-cdn77.xvideos-cdn.com/0/480.m3u8');
    await page.screenshot({path:'output/hotcontainer-copy-url.png'});
    await first.getByRole('button',{name:'Stiahnuť',exact:true}).click();
    assert.equal(await page.evaluate(()=>fixture.downloads[0].url),'https://hls-cdn77.xvideos-cdn.com/0/480.m3u8');
    await first.getByRole('checkbox').check();
    const second=page.locator('[data-item-id="item1"]');
    await second.getByRole('checkbox').check();
    await page.getByRole('button',{name:'Kopírovať URLs (2)',exact:true}).click();
    assert.equal(await page.evaluate(()=>fixture.copies[0]),'https://hls-cdn77.xvideos-cdn.com/0/480.m3u8\nhttps://hls-cdn77.xvideos-cdn.com/1/1080.m3u8');
    await page.getByRole('button',{name:'Importovať do Nexusu (2)',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>fixture.imports[0].map(item=>item.hqUrl)),['https://hls-cdn77.xvideos-cdn.com/0/480.m3u8','https://hls-cdn77.xvideos-cdn.com/1/1080.m3u8']);
    await page.getByText('Odkaz vypršal',{exact:true}).waitFor();
    const expired=page.locator('[data-item-id="item4"]');
    assert.equal(await expired.getByRole('button',{name:'Stiahnuť',exact:true}).isEnabled(),false);
    await expired.getByRole('button',{name:'Znova načítať kvality',exact:true}).click();
    await page.getByText('Odkaz vypršal',{exact:true}).waitFor();
    await expired.getByRole('combobox').selectOption({label:'Celý playlist (JDownloader)'});
    assert.equal(await expired.getByRole('button',{name:'Stiahnuť',exact:true}).isEnabled(),true);
    assert.equal(await page.evaluate(()=>fixture.maxActive),3);
    assert.equal(await first.getByRole('checkbox').isChecked(),true);
    await first.getByRole('combobox').selectOption({label:'Všetky kvality (JDownloader)'});
    await first.getByRole('button',{name:'Nexus',exact:true}).click();
    assert.equal(await page.evaluate(()=>fixture.imports[1][0].hqUrl),'https://hls-cdn77.xvideos-cdn.com/0/master.m3u8');
  } finally {await browser.close();}
});
