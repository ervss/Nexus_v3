const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('userscripts/filester-album-workspace.user.js', 'utf8');
const code = source.slice(source.indexOf('  function duplicateName('), source.indexOf('  function injectCardTools('));
const sizeCode = source.slice(source.indexOf('  function parseSizeBytes('), source.indexOf('  async function mapWithLimit(', source.indexOf('  function parseSizeBytes(')));
const ctx = vm.createContext({metadata: {}, items: [], selected: new Set(), duplicateUrls: new Set(), location: {pathname: '/f/test'}, persist() {}});
vm.runInContext(code + sizeCode + '\nthis.run = () => { updateDuplicates(); return [...duplicateUrls]; };', ctx);
const item = (url, title, size, height = 0, type = 'videos') => ({url, title, sizeBytes: size, guessedHeight: height, type});
const low = item('low', 'A long video title 1080p.mp4', 800, 1080);
const high = item('high', 'A_long_video_title_4k.mkv', 2800, 2160);
ctx.items = [low, high];
ctx.selected.add('low');
assert.deepEqual(Array.from(ctx.run()), ['low']);
assert.deepEqual([...ctx.selected], ['high']);
ctx.items = [high, low];
assert.deepEqual(Array.from(ctx.run()), ['low']);
ctx.metadata = { low: {duration: 100}, high: {duration: 200} };
assert.equal(ctx.run().length, 0, 'different durations must remain');
ctx.metadata = {};
ctx.items = [low, item('different', 'A long video title part 2 4k.mp4', 3000, 2160)];
assert.equal(ctx.run().length, 0, 'different titles must remain');
// Smart deduplication: truncated twins with ellipsis and size difference must be deduplicated (keeping the larger/better one)
ctx.items = [item('a', 'A long video title....mp4', 500), item('b', 'A long video title....mkv', 1000)];
assert.deepEqual(Array.from(ctx.run()), ['a'], 'truncated twins must deduplicate in favor of the larger file');

// Real-world cases from Filester screenshot
const comp = item('comp', 'ph_261106_Eddie_Peter_FULL_1080p_comp...', 827 * 1024 ** 2, 1080);
const orig = item('orig', 'ph_261106_Eddie_Peter_FULL_1080p_orig.mp4', 2680 * 1024 ** 2, 1080);
ctx.items = [comp, orig];
assert.deepEqual(Array.from(ctx.run()), ['comp'], 'comp vs orig twin must discard comp and keep orig');

const twinSmall = item('s1', 'ph_261030_POV_sex_scene_flo_and_peter_1...', 701 * 1024 ** 2, 1080);
const twinLarge = item('s2', 'ph_261030_POV_sex_scene_flo_and_peter_1...', 4190 * 1024 ** 2, 1080);
ctx.items = [twinSmall, twinLarge];
assert.deepEqual(Array.from(ctx.run()), ['s1'], 'identical truncated titles must discard smaller twin');

const clip1 = item('c1', 'ph_261016_FULL_Sammy_Peter_DJ_Clip_1080...', 607 * 1024 ** 2, 1080);
const clip2 = item('c2', 'ph_261016_FULL_Sammy_Peter_DJ_Clip_...mp4', 4100 * 1024 ** 2, 1080);
ctx.items = [clip1, clip2];
assert.deepEqual(Array.from(ctx.run()), ['c1'], 'differently truncated twins must discard smaller twin');
ctx.items = [item('a', 'Another complete title.mp4', 0), item('b', 'Another complete title.mkv', 0)];
assert.equal(ctx.run().length, 0, 'unknown quality must remain');
ctx.items = [low, high]; ctx.location.pathname = '/manager';
assert.equal(ctx.run().length, 0, 'manager stays unchanged');
console.log('Filester duplicate detection passed');
