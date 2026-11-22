const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function createDomEnv() {
  class FakeElement {
    constructor(tagName, attrs = {}) {
      this.tagName = tagName.toUpperCase();
      this.attributes = new Map();
      this.dataset = {};
      this.children = [];
      this.parentElement = null;
      this.style = {};
      this.listeners = new Map();
      this.textContent = '';
      this.hidden = false;
      this.disabled = false;
      this._classes = new Set();
      this.classList = {
        add: (...cls) => cls.forEach(c => this._classes.add(c)),
        remove: (...cls) => cls.forEach(c => this._classes.delete(c)),
        toggle: (c, force) => {
          const on = force === undefined ? !this._classes.has(c) : Boolean(force);
          if (on) this._classes.add(c); else this._classes.delete(c);
          return on;
        },
        contains: c => this._classes.has(c),
      };
      for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v);
    }
    set className(val) { this._classes = new Set(String(val || '').split(/\s+/).filter(Boolean)); }
    get className() { return [...this._classes].join(' '); }
    set id(val) { this.setAttribute('id', val); }
    get id() { return this.getAttribute('id') || ''; }
    setAttribute(k, v) {
      this.attributes.set(k, String(v));
      if (k === 'class') this.className = v;
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        this.dataset[camel] = String(v);
      }
    }
    getAttribute(k) {
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        if (camel in this.dataset) return this.dataset[camel];
      }
      return this.attributes.has(k) ? this.attributes.get(k) : null;
    }
    hasAttribute(k) { return this.getAttribute(k) !== null; }
    append(...nodes) {
      for (const n of nodes) {
        if (typeof n === 'string') { this.textContent += n; continue; }
        if (!n) continue;
        n.parentElement = this;
        this.children.push(n);
      }
    }
    before(node) {
      if (!this.parentElement) return;
      const idx = this.parentElement.children.indexOf(this);
      node.parentElement = this.parentElement;
      this.parentElement.children.splice(idx, 0, node);
    }
    remove() {
      if (!this.parentElement) return;
      this.parentElement.children = this.parentElement.children.filter(c => c !== this);
      this.parentElement = null;
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    matches(selector) {
      return selector.split(',').map(s => s.trim()).some(part => {
        if (part.startsWith('.')) return this._classes.has(part.slice(1));
        if (part === '[data-nvs-turbo-id]') return 'nvsTurboId' in this.dataset;
        if (part === '[data-video-id]') return this.hasAttribute('data-video-id');
        if (part === 'a[href]') return this.tagName === 'A' && this.hasAttribute('href');
        if (part === 'iframe[src]') return this.tagName === 'IFRAME' && this.hasAttribute('src');
        if (part === 'video[src]') return this.tagName === 'VIDEO' && this.hasAttribute('src');
        if (part === 'source[src]') return this.tagName === 'SOURCE' && this.hasAttribute('src');
        if (part === '[id^="js-post-"]') return this.id.startsWith('js-post-');
        if (part === '[id^="post-"]') return this.id.startsWith('post-');
        if (part === '[data-content^="post-"]') return String(this.dataset.content || '').startsWith('post-');
        if (part === '#nvs-overview') return this.id === 'nvs-overview';
        if (part === '[id^="nvs-"]') return this.id.startsWith('nvs-');
        if (part === '.nvs-thread-meta') return this._classes.has('nvs-thread-meta');
        if (part === '[data-part="thread-progress"]') return this.dataset.part === 'thread-progress';
        if (part === '[data-part="thread-scan"]') return this.dataset.part === 'thread-scan';
        return false;
      });
    }
    closest(selector) {
      let cur = this;
      while (cur) {
        if (cur.matches(selector)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    querySelectorAll(selector) {
      const out = [];
      const walk = (node, root) => {
        for (const child of node.children) {
          if (selector.startsWith(':scope > ')) {
            if (node === root && child.matches(selector.slice(9))) out.push(child);
            continue;
          }
          const parts = selector.split(',').map(s => s.trim());
          const matched = parts.some(p => {
            if (p.startsWith('.message-body ')) {
              return child.matches(p.slice('.message-body '.length)) && child.closest('.message-body');
            }
            return child.matches(p);
          });
          if (matched) out.push(child);
          walk(child, root);
        }
      };
      walk(this, this);
      return out;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }

  const body = new FakeElement('body');
  const document = {
    body,
    createElement: tag => new FakeElement(tag),
    createTextNode: text => String(text),
    querySelector: sel => body.querySelector(sel),
    querySelectorAll: sel => body.querySelectorAll(sel),
    getElementById: id => {
      const walk = el => {
        if (el.id === id) return el;
        for (const c of el.children) { const f = walk(c); if (f) return f; }
        return null;
      };
      return walk(body);
    },
  };
  return { FakeElement, body, document };
}

test('overview discovers ThirstHub thTurboPreview cards, deduplicates IDs, and keeps single card on iframe replacement', async () => {
  const { FakeElement, body, document } = createDomEnv();
  const post1 = new FakeElement('article', { id: 'js-post-101' });
  const link1 = new FakeElement('a', { href: 'https://thirsthub.cc/threads/drsalad.12351/post-101' });
  link1.textContent = '#1';
  const msg1 = new FakeElement('div', { class: 'message-body' });

  const makePreview = (videoId, extraClass = 'generic2wide-iframe-div thTurboPreview thTurboPlayer', signUrl = '/turbo-native/sign') => {
    const wrap = new FakeElement('div', { class: extraClass, 'data-video-id': videoId });
    if (signUrl) wrap.setAttribute('data-sign-url', signUrl);
    const img = new FakeElement('img', { class: 'thTurboPreview-thumbnail', src: `https://static.ucdn.to/${videoId}.jpg` });
    const btn = new FakeElement('button', { type: 'button', class: 'thTurboPreview-button' });
    wrap.append(img, btn);
    return wrap;
  };

  const cardA = makePreview('qyewvs94457s');
  const cardB = makePreview('7FIZBO6N84xGS');
  const nonTurbo = new FakeElement('div', { class: 'other-player', 'data-video-id': 'ignore_me_123' });
  msg1.append(cardA, cardB, nonTurbo);
  post1.append(link1, msg1);

  const post2 = new FakeElement('article', { id: 'js-post-102' });
  const link2 = new FakeElement('a', { href: 'https://thirsthub.cc/threads/drsalad.12351/post-102' });
  link2.textContent = '#2';
  const msg2 = new FakeElement('div', { class: 'message-body' });
  const cardADup = makePreview('qyewvs94457s');
  const cardC = makePreview('FFG_MdEX3l1Cs');
  msg2.append(cardADup, cardC);
  post2.append(link2, msg2);

  body.append(post1, post2);

  const registered = [];
  const selectedCards = new Set();
  const sandbox = {
    window: null,
    document,
    location: new URL('https://thirsthub.cc/threads/drsalad.12351/'),
    URL,
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage(_msg, cb) { cb?.({ ok: true }); },
      },
      storage: { sync: { get: async d => d, set: async () => {} } },
    },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: fn => { fn(); return 1; },
    cancelAnimationFrame: () => {},
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../overview.js'), 'utf8'), sandbox);

  const overview = sandbox.createNVSTurboOverview({
    isSelected: card => selectedCards.has(card),
    register(card, url) { registered.push({ card, url }); },
    select(card, val) { if (val) selectedCards.add(card); else selectedCards.delete(card); },
    selectionChanged() {},
    metadata() {},
    importItems: async () => ({ success: true, data: { results: [] } }),
    exportJson() {},
  });

  await overview.init();

  const btn = document.getElementById('nvs-overview-launch');
  assert.equal(btn.textContent, 'Prehľad videí (3)');
  assert.equal(btn.hidden, false);
  assert.equal(registered.length, 4);
  assert.deepEqual(registered.map(r => r.url), [
    'https://turbo.cr/v/qyewvs94457s',
    'https://turbo.cr/v/7FIZBO6N84xGS',
    'https://turbo.cr/v/qyewvs94457s',
    'https://turbo.cr/v/FFG_MdEX3l1Cs',
  ]);
  assert.equal(cardA.dataset.nvsTurboId, 'qyewvs94457s');
  assert.equal(nonTurbo.dataset.nvsTurboId, undefined);
  assert.ok(cardA.querySelector(':scope > .nvs-thread-meta'));

  // Toggle selection on one instance selects both occurrences of the same video ID
  assert.equal(overview.toggle(cardA), true);
  assert.equal(selectedCards.has(cardA), true);
  assert.equal(selectedCards.has(cardADup), true);

  // If ThirstHub replaces preview content with a turbo.cr iframe inside cardB, discover() must not duplicate it
  const iframe = new FakeElement('iframe', { src: 'https://turbo.cr/embed/7FIZBO6N84xGS' });
  cardB.append(iframe);
  overview.discover();
  assert.equal(registered.length, 4);
  assert.equal(btn.textContent, 'Prehľad videí (3)');
});

test('overview discovers ThirstHub archve.xyz /e/ embeds and hls.archve.xyz video.mp4 URLs and deduplicates by UUID', async () => {
  const { FakeElement, body, document } = createDomEnv();
  const uuid1 = '0d1d4542-73f4-41c7-cc1e-6082018722a6';
  const uuid2 = '0d295c3e-ec83-4a92-b5a2-d6afc3907fb3';

  const post1 = new FakeElement('article', { id: 'js-post-201' });
  const link1 = new FakeElement('a', { href: 'https://thirsthub.cc/threads/ariana-marie.139950/post-201' });
  link1.textContent = '#1';
  const msg1 = new FakeElement('div', { class: 'message-body' });

  const archveWrap = new FakeElement('div', { class: 'thMediaEmbed thArchveEmbed generic2wide-iframe-div' });
  const archveIframe = new FakeElement('iframe', { class: 'saint-iframe', src: `https://archve.xyz/e/${uuid1}`, title: 'Archve video' });
  archveWrap.append(archveIframe);

  const hlsVideo = new FakeElement('video', { src: `https://hls.archve.xyz/${uuid2}/video.mp4?v=330264` });
  const dupLink = new FakeElement('a', { href: `https://archve.xyz/watch/${uuid1}` });
  msg1.append(archveWrap, hlsVideo, dupLink);
  post1.append(link1, msg1);
  body.append(post1);

  const registered = [];
  const selectedCards = new Set();
  const sandbox = {
    window: null,
    document,
    location: new URL('https://thirsthub.cc/threads/ariana-marie.139950/'),
    URL,
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage(_msg, cb) { cb?.({ ok: true }); },
      },
      storage: { sync: { get: async d => d, set: async () => {} } },
    },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: fn => { fn(); return 1; },
    cancelAnimationFrame: () => {},
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../overview.js'), 'utf8'), sandbox);

  const overview = sandbox.createNVSTurboOverview({
    isSelected: card => selectedCards.has(card),
    register(card, url) { registered.push({ card, url }); },
    select(card, val) { if (val) selectedCards.add(card); else selectedCards.delete(card); },
    selectionChanged() {},
    metadata() {},
    importItems: async () => ({ success: true, data: { results: [] } }),
    exportJson() {},
  });

  await overview.init();

  const btn = document.getElementById('nvs-overview-launch');
  assert.equal(btn.textContent, 'Prehľad videí (2)');
  assert.equal(registered.length, 3);
  assert.equal(registered[0].card, archveWrap);
  assert.equal(registered[0].url, `https://archve.xyz/watch/${uuid1}`);
  assert.equal(registered[1].url, `https://archve.xyz/watch/${uuid2}`);
  assert.equal(archveWrap.dataset.nvsTurboId, `archve:${uuid1}`);
  assert.ok(archveWrap.querySelector(':scope > .nvs-thread-meta'));
  assert.equal(overview.toggle(archveWrap), true);
  assert.equal(selectedCards.has(archveWrap), true);
  assert.equal(selectedCards.size, 2);
});
