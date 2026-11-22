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

test('PornOne selector and background contracts exist', () => {
  assert.match(contentSrc, /host:\s*\/\(\^\|\\\.\)pornone\\\.com\$\/i/);
  assert.match(contentSrc, /function isPornonePage\(\)/);
  assert.match(contentSrc, /a\.videocard\[href\]/);
  assert.match(contentSrc, /'\.thumbcont'/);
  assert.match(backgroundSrc, /function isPornoneUrl\(url\)/);
  assert.match(backgroundSrc, /async function extractPornoneMeta\(html, pageUrl\)/);
  assert.match(backgroundSrc, /adapter:\s*'pornone-source-v1'/);
});

test('extractDuration handles PornOne P0DT ISO 8601 durations', () => {
  const ctx = vm.createContext({});
  vm.runInContext([
    extractFunction(backgroundSrc, 'function extractDuration('),
    extractFunction(backgroundSrc, 'function isoToHuman('),
  ].join('\n'), ctx);

  assert.equal(ctx.extractDuration('{"duration":"P0DT0H9M13S"}'), '9:13');
  assert.equal(ctx.extractDuration('{"duration":"P0DT1H05M02S"}'), '1:05:02');
});

test('extractPornoneMeta selects highest MP4 rendition, probes size, and extracts date/duration', async () => {
  const probedUrls = [];
  const ctx = vm.createContext({
    URL,
    fetchHeadSize: async (url) => {
      probedUrls.push(url);
      if (url.includes('1920x1080')) return 271;
      if (url.includes('720x406')) return 42;
      return null;
    },
  });

  vm.runInContext([
    extractFunction(backgroundSrc, 'function findDeep('),
    extractFunction(backgroundSrc, 'function normalizeDate('),
    extractFunction(backgroundSrc, 'function extractDate('),
    extractFunction(backgroundSrc, 'function isoToHuman('),
    extractFunction(backgroundSrc, 'function extractDuration('),
    extractFunction(backgroundSrc, 'function normalizeQualityLabel('),
    extractFunction(backgroundSrc, 'function formatSizeMb('),
    extractFunction(backgroundSrc, 'async function extractPornoneMeta('),
  ].join('\n'), ctx);

  const hdHtml = `
    <script type="application/ld+json">
      {"@type":"VideoObject","uploadDate":"2026-05-21T12:02:20+00:00","duration":"P0DT0H9M13S"}
    </script>
    <video id="pornone-video-player">
      <source src="https://s3103.pornone.com/vid2/tok1/1794891962/9/280602709/280602709_1920x1080_4000k.mp4?lang=en" type="video/mp4" label="720p" res="720"/>
      <source src="https://s3108.pornone.com/vid2/tok2/1794891962/9/280602709/280602709_720x406_500k.mp4?lang=en" type="video/mp4" label="480p" default res="480"/>
    </video>
    <script>var hdvalue = 1080;</script>
  `;

  const hdMeta = await ctx.extractPornoneMeta(hdHtml, 'https://pornone.com/german/shaiden-rogue-pov-blowjob-p/280602709/');
  assert.equal(hdMeta.quality, '1080P');
  assert.equal(hdMeta.sizeMb, 271);
  assert.equal(hdMeta.sizeText, '271 MB');
  assert.equal(hdMeta.duration, '9:13');
  assert.equal(hdMeta.date, 'May 21, 2026');
  assert.equal(hdMeta.adapter, 'pornone-source-v1');
  assert.equal(probedUrls[0], 'https://s3103.pornone.com/vid2/tok1/1794891962/9/280602709/280602709_1920x1080_4000k.mp4?lang=en');

  const sdHtml = `
    <script type="application/ld+json">
      {"@type":"VideoObject","uploadDate":"2024-08-09T12:53:30+00:00","duration":"P0DT0H29M56S"}
    </script>
    <video id="pornone-video-player">
      <source src="https://s1006.pornone.com/vid2/tok3/1794892040/15/279223215/279223215_720x406_500k.mp4?lang=en" type="video/mp4" label="480p" default res="480"/>
    </video>
    <script>var hdvalue = 406;</script>
  `;

  const sdMeta = await ctx.extractPornoneMeta(sdHtml, 'https://pornone.com/blowbang/shaiden-rogue-red-lips-cocksucking/279223215/');
  assert.equal(sdMeta.quality, '480P');
  assert.equal(sdMeta.sizeMb, 42);
  assert.equal(sdMeta.sizeText, '42 MB');
  assert.equal(sdMeta.duration, '29:56');
  assert.equal(sdMeta.date, 'Aug 9, 2024');
});

test('parsePornonePlaybackSources extracts ordered MP4 sources and contentUrl fallback for inline player', () => {
  const ctx = vm.createContext({ URL });
  vm.runInContext(extractFunction(contentSrc, 'function parsePornonePlaybackSources('), ctx);

  const html = `
    <video id="pornone-video-player">
      <source src="https://s3108.pornone.com/vid2/tok2/1794891962/9/280602709/280602709_720x406_500k.mp4?lang=en" type="video/mp4" label="480p" default res="480"/>
      <source src="https://s3103.pornone.com/vid2/tok1/1794891962/9/280602709/280602709_1920x1080_4000k.mp4?lang=en" type="video/mp4" label="720p" res="720"/>
      <source src="https://s3103.pornone.com/vid2/preview/280602709_preview.mp4" type="video/mp4"/>
    </video>
  `;
  const sources = ctx.parsePornonePlaybackSources(html, 'https://pornone.com/german/test/280602709/');
  assert.equal(sources.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(sources.map(s => ({ quality: s.quality, height: s.height, type: s.type })))),
    [
      { quality: '1080P', height: 1080, type: 'file' },
      { quality: '480P', height: 480, type: 'file' },
    ]
  );

  const ldOnlyHtml = `
    <script type="application/ld+json">
      {"@type":"VideoObject","contentUrl":"https://s1006.pornone.com/vid2/tok3/1794892040/15/279223215/279223215_1280x720_1800k.mp4?lang=en"}
    </script>
  `;
  const ldSources = ctx.parsePornonePlaybackSources(ldOnlyHtml, 'https://pornone.com/blowbang/test/279223215/');
  assert.equal(ldSources.length, 1);
  assert.equal(ldSources[0].quality, '720P');
  assert.equal(ldSources[0].height, 720);

  assert.match(contentSrc, /resolvePornonePlaybackSources\(entry\.url,\s*signal\)/);
  assert.match(contentSrc, /resolvePornonePlaybackSources\(url\.href,\s*controller\.signal\)/);
});
