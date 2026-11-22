const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scripts = [
  '../userscripts/nexus-universal-splitscreen.user.js',
  '../app/static/nexus-universal-splitscreen.js'
];

function loadResolver(file, responses) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const start = source.indexOf('  function isEpornerUrl(');
  const end = source.indexOf('  async function resolveStreamUrl(', start);
  assert.ok(start >= 0 && end > start, `${file} contains the Eporner resolver`);
  let requestIndex = 0;
  const requests = [];
  const context = {
    URL,
    URLSearchParams,
    location: { href: 'https://www.eporner.com/video-abc/title/' },
    gmFetch: async (url, options) => {
      requests.push({ url: String(url), options });
      return responses[requestIndex++];
    },
    console: { warn() {} }
  };
  vm.runInNewContext(
    `${source.slice(start, end)}; globalThis.resolveEpornerStream = resolveEpornerStream; globalThis.isEpornerUrl = isEpornerUrl;`,
    context
  );
  context.requests = requests;
  return context;
}

function response({ html = '', data = null, status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => html,
    json: async () => data
  };
}

for (const file of scripts) {
  test(`${path.basename(file)} selects the highest Eporner player source`, async () => {
    const html = "EP.video.player.vid = 'abc'; EP.video.player.hash = '0123456789abcdef0123456789abcdef';";
    const context = loadResolver(file, [
      response({ html }),
      response({ data: {
        vid: 'abc',
        available: true,
        sources: {
          mp4: {
            '480p': { src: 'https://cdn.test/480.mp4' },
            '1080p': { src: 'https://cdn.test/1080.mp4' },
            '2160p': { src: 'https://cdn.test/2160.mp4' }
          }
        }
      } })
    ]);
    const item = { type: 'generic_watch', isResolved: false };
    const url = await context.resolveEpornerStream(item, 'https://www.eporner.com/video-abc/title/');

    assert.equal(url, 'https://cdn.test/2160.mp4');
    assert.equal(item.directUrl, url);
    assert.equal(item.quality, '2160p');
    assert.equal(item.epornerQualityResolved, true);
    const playerRequest = new URL(context.requests[1].url);
    assert.equal(playerRequest.searchParams.get('playerWidth'), '3840');
    assert.equal(playerRequest.searchParams.get('playerHeight'), '2160');
    assert.equal(playerRequest.searchParams.get('pixelRatio'), '2');
  });

  test(`${path.basename(file)} fallback picks the highest Eporner download link`, async () => {
    const html = "EP.video.player.vid = 'abc'; EP.video.player.hash = '0123456789abcdef0123456789abcdef';"
      + '<a href="/dload/token/480/480p.mp4">480</a><a href="/dload/token/1080/1080p.mp4">1080</a>';
    const context = loadResolver(file, [
      response({ html }),
      response({ data: {
        vid: 'abc',
        available: true,
        sources: { mp4: { '480p': { src: 'https://cdn.test/480.mp4' } } }
      } })
    ]);
    const item = { type: 'generic_watch', isResolved: false };
    const url = await context.resolveEpornerStream(item, 'https://www.eporner.com/video-abc/title/');

    assert.equal(url, 'https://www.eporner.com/dload/token/1080/1080p.mp4');
    assert.equal(item.quality, '1080p');
  });
}
