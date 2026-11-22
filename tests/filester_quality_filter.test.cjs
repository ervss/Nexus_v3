const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('userscripts/filester-album-workspace.user.js', 'utf8');
const start = source.indexOf('  function guessHeight(');
const end = source.indexOf('  function tokenizeQuery(', start);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({ metadata: { measured: { height: 1088 } } });
vm.runInContext(source.slice(start, end) + '\nthis.check = (title, url, tier) => matchesQuality({ url, guessedHeight: guessHeight(title) }, tier);', context);
for (const [title, url, tier, expected] of [
  ['video_4k_orig.mp4', 'a', '4k', true],
  ['video_2160p.mp4', 'a', '4k', true],
  ['video_4k_orig.mp4', 'a', '1080', false],
  ['video_1440p.mp4', 'a', '1440', true],
  ['video_1080p.mp4', 'a', '1080', true],
  ['video_720p.mp4', 'a', '720', true],
  ['video_480p.mp4', 'a', 'sd', true],
  ['video.mp4', 'a', 'unknown', true],
  ['video_4k_orig.mp4', 'measured', '1080', true],
  ['video_4k_orig.mp4', 'measured', '4k', false],
  ['video.mp4', 'a', 'all', true],
]) assert.equal(context.check(title, url, tier), expected, `${title}: ${tier}`);
console.log('Filester quality filter: all cases passed');
