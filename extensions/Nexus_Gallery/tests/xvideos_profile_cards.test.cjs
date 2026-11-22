const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync('extensions/Nexus_Gallery/xvideos_import_panel.js', 'utf8');
const start = source.indexOf('  const host = location.hostname');
const end = source.indexOf('  const normalize =', start);
assert.notEqual(start, -1, 'XVideos host normalizer exists');
assert.notEqual(end, -1, 'XVideos URL helper boundary exists');

function createElement(tagName) {
  return {
    tagName: tagName.toUpperCase(),
    attributes: {},
    children: [],
    dataset: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    appendChild(child) { this.children.push(child); return child; },
  };
}

function createContext(pageUrl) {
  const context = {
    location: { hostname: new URL(pageUrl).hostname, href: pageUrl },
    URL,
    document: { createElement },
  };
  vm.createContext(context);
  vm.runInContext(`${source.slice(start, end)}; globalThis.testPageUrl = pageUrl; globalThis.testWatchUrl = watchUrl; globalThis.testNextUrl = nextUrl; globalThis.testCardsFromJson = cardsFromJson;`, context);
  return context;
}

test('profile-page cards accept canonical www and bare XVideos hosts', () => {
  const context = createContext('https://www.xvideos.com/pornstars/monika-fox#_tabVideos');
  assert.equal(context.testPageUrl('https://xvideos.com/video.123/example'), 'https://xvideos.com/video.123/example');
  assert.equal(context.testPageUrl('https://www.xvideos.com/video.456/example'), 'https://www.xvideos.com/video.456/example');
  assert.equal(context.testPageUrl('https://example.com/video.789/example'), '');
});

test('XVideos red cards do not accept links from xvideos.com', () => {
  const context = createContext('https://xvideos.red/pornstars/example#_tabVideos');
  assert.equal(context.testPageUrl('https://www.xvideos.red/video.123/example'), 'https://www.xvideos.red/video.123/example');
  assert.equal(context.testPageUrl('https://xvideos.com/video.123/example'), '');
});

test('profile tracking links normalize to watch-page URLs', () => {
  const context = createContext('https://www.xvideos.com/pornstars/monika-fox#_tabVideos');
  assert.equal(
    context.testWatchUrl('/prof-video-click/upload/monika-fox/omemidm5231/stunning_latina'),
    'https://www.xvideos.com/video.omemidm5231/stunning_latina',
  );
  assert.equal(
    context.testWatchUrl('/prof-video-click/upload/monika-fox/123456'),
    'https://www.xvideos.com/video123456/',
  );
  assert.equal(
    context.testWatchUrl('/prof-video-click/pornstar-straight/monika-fox/uiaekhf0205/blonde_russian_monika_fox'),
    'https://www.xvideos.com/video.uiaekhf0205/blonde_russian_monika_fox',
  );
});

test('profile pagination maps the next data-page to the native JSON endpoint', () => {
  const context = createContext('https://www.xvideos.com/pornstars/monika-fox#_tabVideos');
  const link = { getAttribute: name => name === 'href' ? '/prof-video-click/pornstar-straight/monika-fox/id/title' : null };
  const pages = [
    { className: 'active', getAttribute: name => name === 'data-page' ? '0' : null },
    { className: '', getAttribute: name => name === 'data-page' ? '1' : null },
    { className: 'next-page', getAttribute: name => name === 'data-page' ? '1' : null },
  ];
  const tab = {
    querySelector: selector => selector.includes('data-sort') ? { getAttribute: () => 'best' } : link,
    querySelectorAll: () => pages,
  };
  const root = { querySelector: () => tab, querySelectorAll: () => pages };
  assert.equal(
    context.testNextUrl(root),
    'https://www.xvideos.com/pornstars/monika-fox/videos/best/straight/1',
  );
});

test('profile JSON entries become selectable video cards', () => {
  const context = createContext('https://www.xvideos.com/pornstars/monika-fox#_tabVideos');
  const rows = context.testCardsFromJson({ videos: [{
    id: 12345,
    eid: 'abcde12345',
    u: '/prof-video-click/pornstar/monika-fox/abcde12345/sample_title',
    i: 'https://thumb-cdn77.xvideos-cdn.com/example.jpg',
    tf: 'Sample title',
    d: '12 min',
  }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'https://www.xvideos.com/video.abcde12345/sample_title');
  assert.equal(rows[0].card.className, 'thumb-block tb_full_init');
  assert.equal(rows[0].card.dataset.eid, 'abcde12345');
  assert.equal(rows[0].card.children[1].children[0].children[0].attributes.href, '/prof-video-click/pornstar/monika-fox/abcde12345/sample_title');
});
