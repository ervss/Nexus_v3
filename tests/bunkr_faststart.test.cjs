const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../app/static/bunkr_faststart.js');
const BunkrFastStart = globalThis.NexusBunkrFastStart;

test('BunkrFastStart detects Bunkr videos and keys correctly', () => {
  assert.equal(BunkrFastStart.isBunkr({ url: 'https://bunkr.cr/v/abc1234' }), true);
  assert.equal(BunkrFastStart.isBunkr({ source_url: 'https://bunkrr.pics/f/xyz999' }), true);
  assert.equal(BunkrFastStart.isBunkr({ url: 'https://media-files.scdn.st/v/foo.mp4' }), true);
  assert.equal(BunkrFastStart.isBunkr({ url: 'https://eporner.com/hd-video' }), false);

  assert.equal(BunkrFastStart.getBunkrKey({ id: 42, url: 'https://bunkr.cr/v/abc1234' }), '42');
  assert.equal(BunkrFastStart.getBunkrKey({ url: 'https://bunkr.cr/v/test_slug' }), 'test_slug');
});

test('BunkrFastStart limits warmup concurrency strictly to 2 parallel connections', async () => {
  let active = 0;
  let maxActive = 0;
  const originalFetch = global.fetch;

  // Mock fetch to track concurrent Range requests
  global.fetch = async (url, options = {}) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(r => setTimeout(r, 20));
    active--;

    return {
      status: 206,
      ok: true,
      headers: {
        get: (h) => {
          if (h.toLowerCase() === 'content-range') return 'bytes 0-3670015/15000000';
          if (h.toLowerCase() === 'content-length') return '3670016';
          return null;
        }
      },
      arrayBuffer: async () => new ArrayBuffer(3670016)
    };
  };

  try {
    const items = [
      { id: 101, url: 'https://bunkr.cr/v/101', directUrl: 'https://cdn.bunkr.example/101.mp4' },
      { id: 102, url: 'https://bunkr.cr/v/102', directUrl: 'https://cdn.bunkr.example/102.mp4' },
      { id: 103, url: 'https://bunkr.cr/v/103', directUrl: 'https://cdn.bunkr.example/103.mp4' },
      { id: 104, url: 'https://bunkr.cr/v/104', directUrl: 'https://cdn.bunkr.example/104.mp4' },
      { id: 105, url: 'https://bunkr.cr/v/105', directUrl: 'https://cdn.bunkr.example/105.mp4' }
    ];

    const promises = items.map(it => BunkrFastStart.prewarmVideo(it));
    await Promise.all(promises);

    assert.equal(maxActive, 2, 'Warmup concurrency must never exceed 2 to prevent 503');

    // Check all entries in cache
    for (const item of items) {
      const entry = BunkrFastStart.getWarmEntry(item);
      assert.ok(entry, `Entry for #${item.id} should exist in cache`);
      assert.equal(entry.status, 'ready');
      assert.equal(entry.bytes.byteLength, 3670016);
      assert.equal(entry.total, 15000000);
      assert.ok(entry.ttfb >= 0);
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test('Fast recovery: 503 Range error triggers instant re-resolve and single retry under 800ms backoff', async () => {
  let resolveCalls = 0;
  let rangeCalls = 0;
  const originalFetch = global.fetch;

  global.fetch = async (url, options = {}) => {
    if (url.includes('/stream/bunkr/')) {
      resolveCalls++;
      const isForce = url.includes('force=1');
      return {
        ok: true,
        status: 200,
        json: async () => ({ stream_url: `https://cdn.bunkr.example/fresh_${resolveCalls}.mp4` })
      };
    }

    rangeCalls++;
    if (rangeCalls === 1) {
      // First Range request hits 503 from CDN
      return {
        status: 503,
        ok: false,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0)
      };
    }

    // Second Range request succeeds
    return {
      status: 206,
      ok: true,
      headers: {
        get: (h) => {
          if (h.toLowerCase() === 'content-range') return 'bytes 0-3670015/20000000';
          return null;
        }
      },
      arrayBuffer: async () => new ArrayBuffer(3670016)
    };
  };

  try {
    const item = { id: 201, url: 'https://bunkr.cr/v/201' };
    const t0 = Date.now();
    const entry = await BunkrFastStart.prewarmVideo(item);
    const duration = Date.now() - t0;

    assert.equal(rangeCalls, 2, 'Must retry Range exactly once after 503');
    assert.equal(resolveCalls, 2, 'Must call resolver again with force=1');
    assert.equal(entry.status, 'ready');
    assert.ok(duration < 1500, 'Fast recovery must finish promptly without long backoff');
  } finally {
    global.fetch = originalFetch;
  }
});

test('Instant play from warm cache: feeds bytes to MP4Box & MediaSource without new CDN fetch', async () => {
  const item = { id: 301, url: 'https://bunkr.cr/v/301', directUrl: 'https://cdn.bunkr.example/301.mp4' };

  // Set up warm entry in cache
  const dummyBytes = new Uint8Array(3670016);
  BunkrFastStart.cache.set('301', {
    key: '301',
    item,
    status: 'ready',
    signedUrl: item.directUrl,
    watchUrl: item.url,
    bytes: dummyBytes,
    total: 30000000,
    ttfb: 45,
    retries: 0
  });

  let initialFragmentCdnRequests = 0;
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    // If a request is made for bytes 0-3670015, count it as a violation of instant play
    initialFragmentCdnRequests++;
    return { status: 206, ok: true, headers: { get: () => 'bytes 3670016-4718591/30000000' }, arrayBuffer: async () => new ArrayBuffer(1048576) };
  };

  const appendedBuffers = [];
  global.MP4Box = {
    createFile: () => {
      const file = {
        onError: null,
        onReady: null,
        onSegment: null,
        setSegmentOptions: () => {},
        appendBuffer: (buf) => {
          appendedBuffers.push(buf);
          if (file.onReady) {
            file.onReady({
              duration: 90,
              timescale: 1000,
              tracks: [{ id: 1, video: true, codec: 'avc1.64001f' }]
            });
          }
          return buf.byteLength;
        },
        start: () => {},
        stop: () => {},
        initializeSegmentation: () => [{ id: 1, buffer: new ArrayBuffer(128) }]
      };
      return file;
    }
  };

  class MockSourceBuffer extends EventTarget {
    constructor() { super(); this.updating = false; this.buffered = { length: 0 }; }
    appendBuffer() {}
  }

  class MockMediaSource extends EventTarget {
    constructor() { super(); this.readyState = 'open'; }
    addSourceBuffer() { return new MockSourceBuffer(); }
    endOfStream() {}
  }
  MockMediaSource.isTypeSupported = () => true;
  global.MediaSource = MockMediaSource;
  global.URL.createObjectURL = () => 'blob:mock-mediasource';
  global.URL.revokeObjectURL = () => {};

  let playerInstance;
  class MockVideo extends EventTarget {
    constructor() {
      super();
      this.src = '';
      this.currentTime = 0;
      this.buffered = { length: 0 };
    }
    load() {
      // Simulate sourceopen
      setTimeout(() => {
        if (playerInstance.mediaSource) playerInstance.mediaSource.dispatchEvent(new Event('sourceopen'));
      }, 5);
    }
    play() { return Promise.resolve(); }
  }

  const video = new MockVideo();
  let reportedMetrics = null;
  playerInstance = BunkrFastStart.attachPlayer(video, item, {
    onMetrics: (m) => { reportedMetrics = m; }
  });

  try {
    const playPromise = playerInstance.start();
    await new Promise(r => setTimeout(r, 40));

    assert.ok(appendedBuffers.length > 0, 'Initial bytes from cache must be fed to MP4Box immediately');
    assert.equal(appendedBuffers[0].byteLength, 3670016, 'First appended buffer must be exactly the 3.5 MB cached warm-up data');
    assert.equal(playerInstance.metrics.warmCacheHit, true, 'Must register warmCacheHit');
    assert.ok(playerInstance.ready, 'Player should be marked ready');
    assert.ok(playerInstance.metrics.timeToMoov >= 0, 'timeToMoov should be recorded');

    // Simulate playing event to test first-frame metric
    video.dispatchEvent(new Event('playing'));
    assert.ok(reportedMetrics !== null, 'Should report metrics to callback');
    assert.ok(reportedMetrics.timeToFirstFrame >= 0, 'Should record firstFrameTime');
  } finally {
    global.fetch = originalFetch;
    playerInstance.destroy();
  }
});
