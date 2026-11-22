import assert from 'node:assert/strict';
import { buildRadarImport, escapeMarkup, fileQuality, formatDuration, isVideoFile, safeMediaUrl } from '../app/static/filester_radar_browser.js';

assert.equal(escapeMarkup('<img title="x" onload=\'oops\'>'), '&lt;img title=&quot;x&quot; onload=&#39;oops&#39;&gt;');
assert.equal(safeMediaUrl('javascript:alert(1)'), '');
assert.equal(safeMediaUrl('//evil.example/path'), '');
assert.equal(safeMediaUrl('/api/tester/frame?url=x'), '/api/tester/frame?url=x');
assert.equal(safeMediaUrl('https://filester.me/d/a'), 'https://filester.me/d/a');
assert.equal(formatDuration(3725), '1:02:05');
assert.equal(formatDuration(0), 'Čas ?');
assert.deepEqual(fileQuality({ title: 'clip_1080p_orig.mp4' }), { height: 1080, label: '1080p', inferred: true });
assert.deepEqual(fileQuality({ title: 'clip 4K', height: 720 }), { height: 720, label: '720p', inferred: false });
assert.equal(fileQuality({ title: 'unknown' }).label, 'Kvalita ?');
assert.equal(isVideoFile({ title: 'video.mp4.7z.001' }), false);
assert.equal(isVideoFile({ title: 'clip.mp4' }), true);
assert.equal(isVideoFile({ title: 'sound.mp3' }), false);

const payload = buildRadarImport([
  { title: 'Demo', url: 'https://filester.me/d/a', stream_url: 'https://signed.example/video?exp=1', size_bytes: 1024 ** 2, duration: 42, height: 1080, albums: [{ url: 'https://filester.me/f/folder' }] },
  { title: 'Archive.rar', url: 'https://filester.me/d/b' },
], 'demo');
assert.equal(payload.candidates.length, 1);
assert.equal(payload.candidates[0].url, 'https://filester.me/d/a');
assert.equal(payload.candidates[0].source_url, 'https://filester.me/d/a');
assert.equal(payload.candidates[0].file_size_mb, 1);
assert.equal(payload.candidates[0].height, 1080);
assert.equal(payload.auto_metadata, true);
assert.ok(!JSON.stringify(payload).includes('signed.example'));
assert.ok(!JSON.stringify(payload).includes('/f/folder'));
assert.equal(buildRadarImport([{ title: 'bad', url: 'https://filester.me/d/a', duration: Infinity, size_bytes: -1 }]).candidates[0].duration, 0);
console.log('filester radar power browser tests: ok');
