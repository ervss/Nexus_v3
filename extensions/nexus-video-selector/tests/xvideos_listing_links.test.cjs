const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync('extensions/nexus-video-selector/xvideos-listing.js', 'utf8');
const context = {
  location: { href: 'https://www.xvideos.com/pornstars/monika-fox#_tabVideos' },
  window: {},
  URL,
  document: {
    createElement(tagName) {
      return {
        tagName: tagName.toUpperCase(),
        attributes: {},
        children: [],
        dataset: {},
        setAttribute(name, value) { this.attributes[name] = String(value); },
        appendChild(child) { this.children.push(child); return child; },
      };
    },
  },
};
vm.createContext(context);
vm.runInContext(source, context);

test('XVideos listing adapter converts profile tracking paths into video URLs', () => {
  const watchUrl = context.window.NVSXvideosListing.watchUrl;
  assert.equal(
    watchUrl('/prof-video-click/upload/monika-fox/omemidm5231/stunning_latina'),
    'https://www.xvideos.com/video.omemidm5231/stunning_latina',
  );
  assert.equal(
    watchUrl('/prof-video-click/upload/monika-fox/123456'),
    'https://www.xvideos.com/video123456/',
  );
  assert.equal(
    watchUrl('/prof-video-click/pornstar-straight/monika-fox/uiaekhf0205/blonde_russian_monika_fox'),
    'https://www.xvideos.com/video.uiaekhf0205/blonde_russian_monika_fox',
  );
});

test('XVideos listing adapter accepts encoded tracking destinations and rejects unrelated paths', () => {
  const watchUrl = context.window.NVSXvideosListing.watchUrl;
  assert.equal(
    watchUrl('/prof-video-click/upload/monika-fox?url=https%3A%2F%2Fwww.xvideos.com%2Fvideo.omemidm5231%2Fstunning_latina'),
    'https://www.xvideos.com/video.omemidm5231/stunning_latina',
  );
  assert.equal(watchUrl('/pornstars/monika-fox'), '');
});

test('XVideos listing adapter discovers profile cards from pornstar tracking links', () => {
  const api = context.window.NVSXvideosListing;
  const href = '/prof-video-click/pornstar-straight/monika-fox/uiaekhf0205/blonde_russian_monika_fox';
  const link = { getAttribute: name => name === 'href' ? href : null };
  const card = { querySelectorAll: selector => selector === 'a[href]' ? [link] : [] };
  const root = { querySelectorAll: selector => selector === api.cardSelector ? [card] : [] };
  const rows = api.cards(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].card, card);
  assert.equal(rows[0].url, 'https://www.xvideos.com/video.uiaekhf0205/blonde_russian_monika_fox');
});

test('XVideos profile pagination resolves the next AJAX page endpoint', () => {
  const api = context.window.NVSXvideosListing;
  const link = { getAttribute: name => name === 'href' ? '/prof-video-click/pornstar-straight/monika-fox/id/title' : null };
  const pages = [
    { className: 'active', getAttribute: name => name === 'data-page' ? '0' : null },
    { className: '', getAttribute: name => name === 'data-page' ? '1' : null },
  ];
  const tab = {
    querySelector: selector => selector.includes('data-sort') ? { getAttribute: () => 'best' } : link,
    querySelectorAll: () => pages,
  };
  const root = { querySelector: () => tab, querySelectorAll: () => pages };
  assert.equal(
    api.nextUrl(root, 'https://www.xvideos.com/pornstars/monika-fox#_tabVideos'),
    'https://www.xvideos.com/pornstars/monika-fox/videos/best/straight/1',
  );
});

test('XVideos JSON pages are normalized into selectable card nodes', () => {
  const rows = context.window.NVSXvideosListing.cardsFromJson({ videos: [{
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
});
