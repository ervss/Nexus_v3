import assert from 'node:assert/strict';
import {
  buildQueryPlan,
  canonicalFolderUrl,
  cleanTitle,
  compareAlbumSnapshots,
  collectKeywordTargets,
  extractFileCount,
  extractFolderCandidatesFromText,
  extractFolderUrlsFromText,
  extractSizeBytes,
  galleryLaunchUrl,
  gigabytesToBytes,
  normalizeKeyword,
  scoreFolder,
} from '../app/static/filester_radar.js';

assert.equal(canonicalFolderUrl('https://filester.me/f/ABC123?page=7'), 'https://filester.me/f/ABC123');
assert.equal(canonicalFolderUrl('https://filester.gg/f/f00baa#x'), 'https://filester.me/f/f00baa');
assert.equal(canonicalFolderUrl('https://filester.me/d/file'), '');
assert.equal(galleryLaunchUrl('https://filester.gg/f/f00baa?page=8'), 'https://filester.me/f/f00baa#nexus-gallery');
assert.equal(galleryLaunchUrl('https://filester.me/d/file'), '');

assert.equal(extractFileCount('Created today · 2,328 files · 15.91 GB'), 2328);
assert.equal(extractFileCount('This folder is empty. 0 files.'), 0);
assert.equal(extractFileCount('No count here'), null);
assert.equal(extractSizeBytes('small 20 MB, total 1.68 TB'), 1.68 * 1024 ** 4);
assert.equal(gigabytesToBytes('1.5'), 1.5 * 1024 ** 3);
assert.equal(gigabytesToBytes('1,5'), 1.5 * 1024 ** 3);
assert.equal(gigabytesToBytes(''), null);
assert.equal(gigabytesToBytes('-2'), null);

assert.deepEqual(extractFolderUrlsFromText('filester.me/f/abc?page=2\nhttps://filester.gg/f/abc\nfilester.me/f/def'), [
  'https://filester.me/f/abc',
  'https://filester.me/f/def',
]);
assert.deepEqual(extractFolderUrlsFromText('Explore this folder with 2,328 files on filester.me.\nfilester.me › /f/4a541ca81c720210?page=96'), [
  'https://filester.me/f/4a541ca81c720210',
]);
const pasted = extractFolderCandidatesFromText('Named folder | filester.me\nfilester.me/f/abc?page=2\nExplore this folder with 240 files on filester.me.');
assert.equal(pasted[0].title, 'Named folder | filester.me');
assert.equal(extractFileCount(pasted[0].snippet), 240);

const plan = buildQueryPlan('', 'balanced', 5, 2026);
assert.equal(plan.length, 5);
assert.equal(plan[0], 'site:filester.me/f mp4');
assert.ok(buildQueryPlan('Jane Doe', 'focused', 8, 2026).every(q => q.includes('"Jane Doe"')));
assert.equal(cleanTitle('Explore this folder with 50 files on filester.me.', 'https://filester.me/f/abcdef12'), 'Filester folder abcdef12');

const strong = scoreFolder({ title: 'Named collection', snippet: '4K mp4', fileCount: 500, sizeBytes: 2 * 1024 ** 4, queries: ['a', 'b'] }, '');
const empty = scoreFolder({ title: 'Filester folder x', snippet: '', fileCount: 0, sizeBytes: 0, queries: [] }, '');
assert.ok(strong > empty);

assert.equal(compareAlbumSnapshots(null, { fileCount: 20 }).type, 'new');
const grown = compareAlbumSnapshots(
  { fileCount: 12, sizeBytes: 10, latestUploadAt: '2026-09-01T10:00:00Z' },
  { fileCount: 19, sizeBytes: 10, latestUploadAt: '2026-09-01T10:00:00Z' },
);
assert.equal(grown.type, 'updated');
assert.equal(grown.fileDelta, 7);
assert.match(grown.message, /7/);
assert.equal(compareAlbumSnapshots(
  { fileCount: 19, sizeBytes: 10, latestUploadAt: '2026-09-02T10:00:00Z' },
  { fileCount: 19, sizeBytes: 10, latestUploadAt: '2026-09-02T10:00:00Z' },
).type, 'unchanged');

console.log('filester_radar tests: ok');

assert.equal(normalizeKeyword('Summer_SET-01'), 'summer set 01');
const matchedFile = { title: 'Summer_Set_01', url: 'https://filester.me/d/a', size_bytes: 10 };
const targetedAlbums = [
  { title: 'Album A', url: 'https://filester.me/f/a', contentSearch: { keyword: 'summer set', matchedItems: [matchedFile, matchedFile, { title: 'Other', url: 'https://filester.me/d/other' }] } },
  { title: 'Album B', url: 'https://filester.me/f/b', contentSearch: { keyword: 'SUMMER_SET', matchedItems: [matchedFile, { title: 'Summer set 02', url: 'https://filester.me/d/b', size_bytes: 100 }] } },
  { title: 'Old keyword', url: 'https://filester.me/f/c', contentSearch: { keyword: 'winter', matchedItems: [matchedFile] } },
  { title: 'Failed', url: 'https://filester.me/f/d', contentSearch: { keyword: 'summer set', error: 'HTTP 403', matchedItems: [matchedFile] } },
];
const targets = collectKeywordTargets(targetedAlbums, 'summer set');
assert.equal(targets.length, 2);
assert.equal(targets[0].albums.length, 2);
assert.equal(collectKeywordTargets(targetedAlbums, 'summer set', 'size')[0].size_bytes, 100);
assert.deepEqual(collectKeywordTargets(targetedAlbums, ''), []);
assert.deepEqual(collectKeywordTargets(targetedAlbums, 'winter'), []);
assert.deepEqual(collectKeywordTargets([{ title: 'Bad link', url: 'https://filester.me/f/a', contentSearch: { keyword: 'summer', matchedItems: [{ title: 'Summer', url: 'javascript:alert(1)' }] } }], 'summer'), []);
console.log('filester keyword grid tests: ok');
