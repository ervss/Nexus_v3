const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

for (const path of ['app/static/nexus-universal-splitscreen.js', 'userscripts/nexus-universal-splitscreen.user.js']) {
  test(`${path}: album playback resolves and refreshes through Nexus`, async () => {
    const source = fs.readFileSync(path, 'utf8');
    const section = source.slice(source.indexOf('  function isBunkrPlayback('), source.indexOf('  class BunkrPrefetchEngine'));
    const requests = [];
    const cell = { item: { type: 'nexus_album', url: 'https://bunkr.cr/f/example' }, video: {}, element: { isConnected: true }, loader: {} };
    const context = { URL, URLSearchParams, AbortSignal, Date, Set, location: { href: 'http://localhost:8000/' },
      activeCells: [cell], CONFIG: { DEFAULT_NEXUS_PORT: 8000 },
      fetch: async url => { requests.push(new URL(url, 'http://localhost:8000')); return { ok: true, json: async () => ({ ok: true, stream_url: `https://cdn.example/video.mp4?token=${requests.length}` }) }; },
      resolveBunkrDirect: () => { throw new Error('Album must use Nexus resolver'); }
    };
    vm.runInNewContext(section + ';this.Controller = BunkrPlaybackController;', context);
    const controller = new context.Controller(cell);
    assert.equal(await controller.resolveAlbumStream(), 'https://cdn.example/video.mp4?token=1');
    assert.equal(await controller.resolveAlbumStream(), 'https://cdn.example/video.mp4?token=1');
    assert.equal(await controller.fresh(), 'https://cdn.example/video.mp4?token=2');
    assert.equal(requests[0].pathname, '/api/v1/meta-preview');
    assert.equal(requests[0].searchParams.get('url'), cell.item.url);
    assert.equal(requests[1].searchParams.get('refresh'), '1');
  });
}
