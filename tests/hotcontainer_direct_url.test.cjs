const test = require('node:test');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
test('opening a direct HLS URL redirects to the extension, preserves signatures and downloads on click', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(),'hc-direct-'));
  const extension = path.resolve('extensions/hotcontainer-profile-handoff');
  const browser = await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  try {
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
    await worker.evaluate(async () => {
      await installDirectHlsRule();
      globalThis.requests = [];
      globalThis.fetch = async (url, options) => {
        requests.push({url,options});
        if (url.includes('xvideos-cdn.com')) return {ok:true,url,text:async()=> '#EXTM3U\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST'};
        if(url.includes('/config/')) return {ok:true};
        return {ok:true,json:async()=>({queued:1})};
      };
    });
    const page = await browser.newPage();
    const source='https://hls-cdn77.xvideos-cdn.com/token==,1793037169/video/hls-4k.m3u8?signature=a%2Fb&quality=4k';
    await page.goto(source);
    await page.getByRole('heading',{name:'Stiahnuť video ako MP4'}).waitFor();
    assert.equal(new URL(page.url()).hash.slice(1),source);
    await page.evaluate(() => { window.copied = []; Object.defineProperty(navigator, 'clipboard', {value:{writeText:async value => copied.push(value)}}); });
    await page.getByRole('button',{name:'Kopírovať URL',exact:true}).click();
    assert.equal(await page.evaluate(()=>copied[0]),source);
    await page.getByRole('status').filter({hasText:'Priama URL skopírovaná.'}).waitFor();
    await page.getByRole('button',{name:'Stiahnuť MP4',exact:true}).click();
    await page.getByRole('status').filter({hasText:'IDM prevzal'}).waitFor();
    const payload=await worker.evaluate(()=>JSON.parse(requests.find(r=>r.url.endsWith('/api/tester/idm')).options.body));
    assert.equal(payload.items[0].url,source);
    assert.equal(payload.start,true);
    fs.mkdirSync('output',{recursive:true});
    await page.screenshot({path:'output/hotcontainer-direct-download.png'});
    const rules=await worker.evaluate(()=>chrome.declarativeNetRequest.getDynamicRules());
    assert.deepEqual(rules[0].condition.resourceTypes,['main_frame']);
  } finally {
    await browser.close();
    fs.rmSync(profile,{recursive:true,force:true});
  }
});
