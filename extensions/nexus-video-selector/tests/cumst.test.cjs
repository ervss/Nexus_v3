const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const contentSrc = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const backgroundSrc = fs.readFileSync(path.join(root, 'background.js'), 'utf8');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `Missing ${signature}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Unclosed ${signature}`);
}

test('cum.st selector and background contracts exist', () => {
  assert.match(contentSrc, /host:\s*\/\(\^\|\\\.\)cum\\\.st\$\/i/);
  assert.match(contentSrc, /function isCumStPage\(\)/);
  assert.match(contentSrc, /function isCumStVideoCard\(card\)/);
  assert.match(contentSrc, /a\.cv-cell\[href\*="\/post\/"\]/);
  assert.match(backgroundSrc, /function isCumStUrl\(url\)/);
  assert.match(backgroundSrc, /async function extractCumStMeta\(html, pageUrl\)/);
  assert.match(backgroundSrc, /adapter:\s*'cumst-source-v1'/);
});

test('isCumStUrl matches cum.st and subdomains only', () => {
  const ctx = vm.createContext({ URL });
  vm.runInContext(extractFunction(backgroundSrc, 'function isCumStUrl('), ctx);

  assert.equal(ctx.isCumStUrl('https://cum.st/posts/popular?pgender=woman'), true);
  assert.equal(ctx.isCumStUrl('https://cum.st/creators/onlyfans/268915075/post/711733162'), true);
  assert.equal(ctx.isCumStUrl('https://www.cum.st/creators/fansly/123/post/456'), true);
  assert.equal(ctx.isCumStUrl('https://example.com/cum.st'), false);
});

test('extractCumStMeta parses JSON-LD VideoObject, vertical dimensions, and probes CDN MP4 size', async () => {
  const probedUrls = [];
  const ctx = vm.createContext({
    URL,
    fetchHeadSize: async (url) => {
      probedUrls.push(url);
      if (url.includes('701f8d560edad462')) return 466;
      if (url.includes('abcdef123456')) return 85;
      return null;
    },
    probeMp4HeaderMeta: async () => null,
    calculateQualityFromBitrate: () => null,
  });

  vm.runInContext([
    extractFunction(backgroundSrc, 'function normalizeDate('),
    extractFunction(backgroundSrc, 'function extractDate('),
    extractFunction(backgroundSrc, 'function isoToHuman('),
    extractFunction(backgroundSrc, 'function extractDuration('),
    extractFunction(backgroundSrc, 'function normalizeQualityLabel('),
    extractFunction(backgroundSrc, 'function formatSizeMb('),
    extractFunction(backgroundSrc, 'async function extractCumStMeta('),
  ].join('\n'), ctx);

  const landscapeHtml = `
    <script type="application/ld+json">
      {
        "@graph": [
          {
            "@type": "VideoObject",
            "contentUrl": "https://cdn.cum.st/media/701f8d560edad462f4d742a3792dec5e22a4c22c03b4dd20d99bb0350add89b0/original.mp4",
            "uploadDate": "2023-08-26T10:10:01.000Z",
            "duration": "PT10M33S",
            "width": 1920,
            "height": 1080
          }
        ]
      }
    </script>
  `;

  const meta = await ctx.extractCumStMeta(
    landscapeHtml,
    'https://cum.st/creators/onlyfans/268915075/post/711733162'
  );
  assert.equal(meta.quality, '1080P');
  assert.equal(meta.sizeMb, 466);
  assert.equal(meta.sizeText, '466 MB');
  assert.equal(meta.sizeExact, true);
  assert.equal(meta.duration, '10:33');
  assert.equal(meta.date, 'Aug 26, 2023');
  assert.equal(
    meta.streamUrl,
    'https://cdn.cum.st/media/701f8d560edad462f4d742a3792dec5e22a4c22c03b4dd20d99bb0350add89b0/original.mp4'
  );
  assert.equal(meta.adapter, 'cumst-source-v1');
  assert.equal(probedUrls[0], meta.streamUrl);

  const verticalHtml = `
    <script type="application/ld+json">
      {
        "@type": "VideoObject",
        "contentUrl": "https://cdn.cum.st/media/abcdef123456/original.mp4",
        "uploadDate": "2026-11-11T08:00:00.000Z",
        "duration": "PT2M05S",
        "width": 720,
        "height": 1280
      }
    </script>
  `;
  const vMeta = await ctx.extractCumStMeta(
    verticalHtml,
    'https://cum.st/creators/fansly/123/post/456'
  );
  assert.equal(vMeta.quality, '720P');
  assert.equal(vMeta.sizeMb, 85);
  assert.equal(vMeta.duration, '2:05');
  assert.equal(vMeta.date, 'Nov 11, 2026');
});
