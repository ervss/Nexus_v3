import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupe, normalize, runBounded, validateQuery, variants } from '../engine.js';

test('performer phrase is searched separately', () => {
  assert.ok(variants('Huge Tits Jordan Millicent Covered in Cum').includes('Jordan Millicent'));
});

test('duplicates share one URL and exact title ranks first', () => {
  const rows = [
    normalize({ title: 'Other Jordan clip', url: 'https://example.com/a' }, 'tubes'),
    normalize({ title: 'Jordan Millicent', url: 'https://example.com/b' }, 'tubes'),
    normalize({ title: 'Jordan Millicent copy', url: 'https://example.com/b' }, 'tubes')
  ];
  const ranked = dedupe(rows, 'Jordan Millicent');
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].url, 'https://example.com/b');
});

test('nearly identical titles from different URLs collapse', () => {
  const rows = [
    normalize({ title: 'Jordan Millicent Covered In Cum 1080p', url: 'https://example.com/a' }, 'tubes'),
    normalize({ title: 'Jordan Millicent Covered In Cum 1080p!', url: 'https://example.com/b' }, 'tubes')
  ];
  assert.equal(dedupe(rows, 'Jordan Millicent').length, 1);
});

test('one failed source does not discard other results', async () => {
  const outcomes = await runBounded([async () => [1], async () => { throw Error('offline'); }, async () => [2]], 2);
  assert.deepEqual(outcomes.map(row => row.ok), [true, false, true]);
});

test('rejects unsafe schemes and private leak searches', () => {
  assert.equal(normalize({ title: 'test', url: 'javascript:alert(1)' }, 'tubes'), null);
  assert.throws(() => validateQuery('private leaked video'));
});

test('fetchJson abort timeout produces informative error', async () => {
  const { fetchJson } = await import('../engine.js');
  // Abort on impossible port/unreachable address with short timeout
  await assert.rejects(
    async () => fetchJson('http://127.0.0.1:59999/test', {}, 50),
    err => {
      assert.ok(err.message.includes('vypršal') || err.message.includes('nedostupný') || err.message.includes('Failed to fetch'));
      return true;
    }
  );
});

