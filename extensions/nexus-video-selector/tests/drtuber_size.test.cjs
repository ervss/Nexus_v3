const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync('extensions/nexus-video-selector/background.js', 'utf8');
const start = source.indexOf('async function extractDrTuberMeta(');
const end = source.indexOf('\nasync function extractXHamsterMeta(', start);
const sizeStart = source.indexOf('async function fetchHeadSize(');
const sizeEnd = source.indexOf('\n// IQ 300 HLS Parser', sizeStart);
assert.notEqual(start, -1, 'DrTuber metadata extractor exists');
assert.notEqual(end, -1, 'DrTuber metadata extractor boundary exists');
assert.notEqual(sizeStart, -1, 'Media size probe exists');
assert.notEqual(sizeEnd, -1, 'Media size probe boundary exists');

test('DrTuber falls back to the LQ file when the HQ file size is unavailable', async () => {
  const probedUrls = [];
  const context = {
    URL,
    URLSearchParams,
    AbortSignal,
    fetch: async () => ({
      ok: true,
      json: async () => ({
        files: {
          hq: 'https://cdn.example/video-hq.mp4',
          lq: 'https://cdn.example/video-lq.mp4',
        },
      }),
    }),
    fetchHeadSize: async (url) => {
      probedUrls.push(url);
      return url.endsWith('video-lq.mp4') ? 128 : null;
    },
    drTuberDuration: () => null,
    extractDate: () => null,
    extractDuration: () => null,
    normalizeQualityLabel: value => value ? String(value).toUpperCase() : null,
    formatSizeMb: sizeMb => `${sizeMb} MB`,
    console,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  const metadata = await context.extractDrTuberMeta(
    '<html></html>',
    'https://www.drtuber.com/video/123/example',
  );

  assert.deepEqual(probedUrls, [
    'https://cdn.example/video-hq.mp4',
    'https://cdn.example/video-lq.mp4',
  ]);
  assert.equal(metadata.sizeMb, 128);
  assert.equal(metadata.sizeText, '128 MB');
  assert.equal(metadata.streamUrl, 'https://cdn.example/video-lq.mp4');
});

test('media size probes use the page as the fetch referrer', async () => {
  const requests = [];
  const context = {
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: {
          get: name => ({
            'content-length': '125829120',
            'content-type': 'video/mp4',
          })[name],
        },
      };
    },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(sizeStart, sizeEnd), context);

  const pageUrl = 'https://www.drtuber.com/video/123/example';
  const sizeMb = await context.fetchHeadSize('https://cdn.example/video.mp4', pageUrl);

  assert.equal(sizeMb, 120);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.referrer, pageUrl);
  assert.equal(requests[0].options.referrerPolicy, 'strict-origin-when-cross-origin');
  assert.equal(requests[0].options.headers.Referer, undefined);
});

test('range size fallback also uses the page as the fetch referrer', async () => {
  const requests = [];
  let callCount = 0;
  const context = {
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (url, options) => {
      requests.push({ url, options });
      callCount++;
      return {
        ok: callCount === 2,
        status: callCount === 2 ? 206 : 405,
        headers: {
          get: name => ({
            'content-type': 'video/mp4',
            'content-range': 'bytes 0-0/125829120',
          })[name],
        },
      };
    },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(sizeStart, sizeEnd), context);

  const pageUrl = 'https://www.drtuber.com/video/123/example';
  const sizeMb = await context.fetchHeadSize('https://cdn.example/video.mp4', pageUrl);

  assert.equal(sizeMb, 120);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.referrer, pageUrl);
  assert.equal(requests[1].options.headers.Range, 'bytes=0-0');
});
