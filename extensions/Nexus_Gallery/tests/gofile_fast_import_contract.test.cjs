const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const uiSource = fs.readFileSync('extensions/Nexus_Gallery/universal_importer.js', 'utf8');
const bgSource = fs.readFileSync('extensions/Nexus_Gallery/background.js', 'utf8');

test('universal_importer detects gofile routes and streams', () => {
  const sandbox = {
    window: {
      location: {
        href: 'https://gofile.io/d/IXmJUkbL',
        hostname: 'gofile.io',
        pathname: '/d/IXmJUkbL',
        search: '',
        hash: '',
      },
    },
    location: {
      href: 'https://gofile.io/d/IXmJUkbL',
      hostname: 'gofile.io',
      pathname: '/d/IXmJUkbL',
      search: '',
      hash: '',
    },
    document: {
      querySelectorAll: () => [],
      querySelector: () => null,
      title: 'Gofile — Cloud Storage Made Simple',
    },
    IS_TOP_FRAME: true,
    isInternetChicksVideoPage: () => false,
    PREVIEW_HINT_RE: /(?:preview|thumb|thumbnail|trailer|teaser|sample|snippet|(?:^|[\s_./-])hover(?:$|[\s_./-])|promo|poster|related|carousel|mini[-\s]?player|video[-\s]?preview)/i,
  };
  vm.createContext(sandbox);

  // Extract relevant helper functions from universal_importer.js
  const fnNames = [
    'isGofilePage',
    'isPlayableStreamUrl',
    'normalizeHostName',
    'isLikelySingleVideoRoute',
    'hasPreviewLikeContext',
    'isLikelyHoverPreviewVideo',
    'collectBestTitle',
  ];

  for (const fn of fnNames) {
    const m = uiSource.match(new RegExp(`function ${fn}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n    \\}`, 'm'));
    assert.ok(m, `Function ${fn} should exist in universal_importer.js`);
    vm.runInContext(m[0], sandbox);
  }

  // 1. isGofilePage
  assert.equal(sandbox.isGofilePage('https://gofile.io/d/IXmJUkbL'), true);
  assert.equal(sandbox.isGofilePage('https://other.com/video'), false);

  // 2. isLikelySingleVideoRoute
  assert.equal(sandbox.isLikelySingleVideoRoute(), true);

  // 3. isPlayableStreamUrl
  assert.equal(sandbox.isPlayableStreamUrl('https://store4.gofile.io/download/web/abc-123/sample_clip.mp4'), true);
  assert.equal(sandbox.isPlayableStreamUrl('https://store1.gofile.io/download/direct/abc-123/sample_clip'), true);

  // 4. isLikelyHoverPreviewVideo should NOT suppress gofile video even with preview in ID / context
  const videoElem = {
    currentSrc: 'https://store4.gofile.io/download/web/abc-123/sample_clip.mp4',
    duration: 120,
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
    closest: () => null,
    querySelectorAll: () => [],
    getAttribute: () => null,
    hasAttribute: () => false,
    parentElement: { id: 'fm-file-preview', className: 'file-preview', getAttribute: () => null },
  };
  assert.equal(sandbox.hasPreviewLikeContext(videoElem), false);
  assert.equal(sandbox.isLikelyHoverPreviewVideo(videoElem), false);

  // 5. collectBestTitle
  const videoWithDialog = {
    ...videoElem,
    closest: (sel) => {
      if (sel === '[data-dialog]') {
        return {
          querySelector: (sub) => {
            if (sub === 'header h2') return { textContent: 'vacation_trip.mp4' };
            return null;
          },
        };
      }
      return null;
    },
  };
  assert.equal(sandbox.collectBestTitle(videoWithDialog), 'vacation_trip.mp4');
});

test('background.js recognizes gofile as supported host and media URL', () => {
  const bgSandbox = {
    isMegaUserStorageUrl: () => false,
    isFilesterPlaybackUrl: () => false,
  };
  vm.createContext(bgSandbox);

  const mHost = bgSource.match(/function isSupportedHost\s*\([^)]*\)\s*\{[\s\S]*?\n\}/m);
  assert.ok(mHost, 'isSupportedHost should exist in background.js');
  vm.runInContext(mHost[0], bgSandbox);

  const mMedia = bgSource.match(/function isMediaUrl\s*\([^)]*\)\s*\{[\s\S]*?\n\}/m);
  assert.ok(mMedia, 'isMediaUrl should exist in background.js');
  vm.runInContext(mMedia[0], bgSandbox);

  assert.equal(bgSandbox.isSupportedHost('https://gofile.io/d/IXmJUkbL'), true);
  assert.equal(bgSandbox.isMediaUrl('https://store4.gofile.io/download/web/abc-123/clip.mp4'), true);
  assert.equal(bgSandbox.isMediaUrl('https://store4.gofile.io/download/direct/abc-123/clip'), true);
  assert.equal(bgSandbox.isMediaUrl('https://store4.gofile.io/download/web/abc-123/clip.webm'), true);
});
