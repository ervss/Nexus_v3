const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = { window: {}, Intl, URL, document: undefined };
vm.runInNewContext(fs.readFileSync('extensions/nexus-video-selector/xhamster-listing.js', 'utf8'), context);
const api = context.window.NVSXhamsterListing;

const pageUrl = 'https://xhamster.com/videos/sample-clip-xhA';
const html = `<script id='initials-script'>window.initials=${JSON.stringify({
  layoutPage: {
    videoListProps: { videoThumbProps: [
      { id: 31212395, pageURL: pageUrl + '?a=1', thumbURL: 'https://cdn.example/a.webp', imageURL: 'https://cdn.example/a-big.webp', title: 'First <clip>', duration: 905, created: 1791522056, views: 0 },
      { id: 2, pageURL: 'https://xhamster.com/videos/second-xhB', thumbURL: 'https://cdn.example/b.webp', title: 'Second clip', duration: 624, created: 1791514476, views: 305259 },
      { id: 3, pageURL: pageUrl, thumbURL: 'https://cdn.example/dup.webp', title: 'Duplicate', duration: 10, created: 1791522056, views: 1 },
      { id: 4, pageURL: 'https://xhamster.com/videos/no-thumb-xhC', title: 'Missing thumb', duration: 10, created: 1791522056 },
    ] },
    crossListingThumbsProps: { photos: [{ pageURL: 'https://xhamster.com/photos/pic', thumbURL: 'https://cdn.example/p.jpg', title: 'photo' }] },
  },
})};</script>
<div class="thumb-list__item"><div class="placeholderSkeleton"></div><div class="video-thumb__date-added">9 October 2026</div></div>
<a class="prev-next-list-link prev-next-list-link--next" href="https://xhamster.com/4k/newest/3" rel="next">Next</a>`;

test('listing data includes every video thumb and skips skeletons, photos and duplicates', () => {
  const videos = api.videosFromHtml(html);
  assert.equal(JSON.stringify(videos.map((video) => video.pageURL)), JSON.stringify([pageUrl, 'https://xhamster.com/videos/second-xhB']));
  assert.equal(videos[0].thumbURL, 'https://cdn.example/a.webp');
  assert.equal(api.formatDate(videos[0].created), '9 October 2026');
  assert.equal(api.formatDuration(videos[0].duration), '15:05');
  assert.equal(api.formatDuration(videos[1].duration), '10:24');
  assert.equal(api.nextPageHref(html), 'https://xhamster.com/4k/newest/3');
});

test('built card has a real thumbnail, title and date instead of a gray placeholder', () => {
  const [video] = api.videosFromHtml(html);
  const card = api.cardHtml(video);
  assert.match(card, /src="https:\/\/cdn\.example\/a\.webp"/);
  assert.match(card, /First &lt;clip&gt;/);
  assert.match(card, /9 October 2026/);
  assert.match(card, /15:05/);
  assert.doesNotMatch(card, /placeholderSkeleton/);
});

test('a thumb dated only with published still gets a created timestamp', () => {
  const [video] = api.videosFromData({ videoThumbProps: [
    { id: 9, pageURL: 'https://xhamster.com/videos/published-only', thumbURL: 'https://cdn.example/c.webp', title: 'Published', duration: 10, published: '2026-10-05T00:00:00.000Z' },
  ] });
  assert.equal(api.formatDate(video.created), '5 October 2026');
});

test('paid and faphouse thumbs are left out of the listing', () => {
  const videos = api.videosFromData({ videoThumbProps: [
    { id: 1, pageURL: 'https://xhamster.com/videos/free-one', thumbURL: 'https://cdn.example/a.webp', title: 'Not paid in the title', duration: 12, created: 1791522056 },
    { id: 2, pageURL: 'https://faphouse.com/videos/secret', thumbURL: 'https://cdn.example/b.webp', title: 'Secret', duration: 20 },
    { id: 3, pageURL: 'https://xhamster.com/videos/gold-one', thumbURL: 'https://cdn.example/c.webp', title: 'Gold', accessType: 'gold', duration: 20 },
    { id: 4, pageURL: 'https://xhamster.com/videos/badge-one', thumbURL: 'https://cdn.example/d.webp', title: 'Badge', badgeProps: { text: 'Paid' }, duration: 20 },
    { id: 5, pageURL: 'https://xhamster.com/videos/flag-one', thumbURL: 'https://cdn.example/e.webp', title: 'Flag', isPaid: true, duration: 20 },
    { id: 6, pageURL: 'https://xhamster.com/fh/out?url=https%3A%2F%2Ffaphouse.com%2Fvideos%2Fx', thumbURL: 'https://cdn.example/f.webp', title: 'Out', duration: 20 },
  ] });
  assert.equal(JSON.stringify(videos.map((video) => video.pageURL)), JSON.stringify(['https://xhamster.com/videos/free-one']));
});

test('a card with a Paid badge or a faphouse link is paid', () => {
  const card = (badge, hrefs = []) => ({
    closest: () => null,
    querySelectorAll(selector) {
      if (selector === 'a[href]') return hrefs.map((href) => ({ getAttribute: () => href }));
      return [{ childElementCount: 0, textContent: badge }];
    },
  });
  assert.equal(api.isPaidCard(card('Paid')), true);
  assert.equal(api.isPaidCard(card('Premium')), true);
  assert.equal(api.isPaidCard(card('4K', ['https://xhamster.com/videos/free-one'])), false);
  assert.equal(api.isPaidCard(card('Not paid in the title', ['https://faphouse.com/videos/secret'])), true);
  assert.equal(api.isPaidThumb({ pageURL: 'https://xhamster.com/videos/free-one', title: 'big paid scene' }), false);
});

test('next link is found when rel precedes href', () => {
  assert.equal(api.nextPageHref('<a rel="next" href="https://xhamster.com/4k/3">Next</a>'), 'https://xhamster.com/4k/3');
  assert.equal(api.nextPageHref('<a href="/4k/2">2</a>'), '');
});
