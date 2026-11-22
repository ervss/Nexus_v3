const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const path = require('node:path');

test('collects Novo from page one, waits for equal-size page changes and invalidates the old cache', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: `
      <input type="text" placeholder="profile"><button id="list">Listar videos</button>
      <a id="filtroRecente">Visto recentemente</a><a id="filtroNovo">Novo</a>
      <div id="grid"></div><nav id="pages"></nav>` }));
    await page.goto('http://localhost/#nexus-job=order&profile=https%3A%2F%2Fwww.xvideos.com%2Fmodels%2Ftest');
    await page.evaluate(() => {
      window.fixture = { messages: [], writes: [], clicks: [], order: 'recent', page: 2 };
      const render = () => {
        const name = `${fixture.order}-${fixture.page}`;
        document.querySelector('#grid').innerHTML = `<div class="col"><a href="/vip/servico/assistir/XVideosRed"><img src="http://localhost/${name}.png"><p>${name}</p></a></div>`;
        document.querySelector('#pages').innerHTML = [1, 2].map(n => `<button ${n === fixture.page ? 'disabled' : ''}>${n}</button>`).join('');
        document.querySelectorAll('#pages button').forEach(button => button.onclick = () => {
          fixture.clicks.push(Number(button.textContent));
          document.querySelector('#grid').innerHTML = '';
          setTimeout(() => { fixture.page = Number(button.textContent); render(); }, 80);
        });
      };
      document.querySelector('#list').onclick = render;
      document.querySelector('#filtroNovo').onclick = () => {
        fixture.clicks.push('Novo');
        document.querySelector('#grid').innerHTML = '';
        setTimeout(() => { fixture.order = 'new'; render(); }, 80);
      };
      window.chrome = {
        runtime: { onMessage: { addListener() {} }, sendMessage(message, callback) {
          fixture.messages.push(message);
          if (message.type === 'submit-hotcontainer-profile') document.querySelector('#list').click();
          const result = message.type === 'filter-hotcontainer-premium'
            ? { ok: true, items: message.items.map(item => ({ ...item, accessType: 'premium' })) }
            : { ok: true };
          callback?.(result);
          return Promise.resolve(result);
        } },
        storage: { local: {
          async get(key) { return { [key]: { items: [{ title: 'stale-recent', thumbnail: 'old.png' }], cachedAt: Date.now(), pageCount: 2 } }; },
          async set(value) { fixture.writes.push(value); }
        } }
      };
    });
    await page.addScriptTag({ path: path.resolve('extensions/hotcontainer-profile-handoff/hotcontainer.js') });
    await page.waitForFunction(() => fixture.writes.length > 0);
    const result = await page.evaluate(() => fixture);
    const galleries = result.messages.filter(m => m.type === 'hotcontainer-gallery');
    assert.equal(galleries.length, 1);
    assert.deepEqual(galleries[0].items.map(item => item.title), ['new-1', 'new-2']);
    assert.deepEqual(result.clicks, ['Novo', 1, 2]);
    assert.equal(Object.values(result.writes[0])[0].version, 7);
  } finally { await browser.close(); }
});
