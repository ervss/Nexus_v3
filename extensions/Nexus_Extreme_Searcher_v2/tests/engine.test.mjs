import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupe, normalize, runBounded, validateQuery, variants } from '../engine.js';
import { discourseSearch, searchSites, searxngSite, tpdbSearch } from '../sources.js';

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

test('site adapters expose configured and default hosts', () => {
  assert.ok(searchSites({}, 'files').some(origin => origin.includes('pixeldrain.com')));
  assert.deepEqual(searchSites({ forumSites: 'https://forum.example.org' }, 'forums'), ['https://forum.example.org']);
});

test('SearXNG file search keeps only the requested host', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async request => {
    const url = new URL(request);
    assert.equal(url.searchParams.get('safesearch'), '0');
    return new Response(JSON.stringify({ results: [
      { title: 'Public album', url: 'https://pixeldrain.com/l/abc' },
      { title: 'Unrelated result', url: 'https://example.org/a' }
    ] }), { status: 200 });
  };
  try {
    const rows = await searxngSite({ searxngUrl: 'http://127.0.0.1:8888' }, 'test album', 'https://pixeldrain.com', 'files');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].category, 'files');
    assert.equal(rows[0].importable, true);
  } finally { globalThis.fetch = original; }
});

test('Discourse and ThePornDB normalize public search results', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async request => new Response(JSON.stringify(String(request).includes('theporndb')
    ? { data: [{ id: 12, title: 'Sample scene', poster: 'https://example.org/poster.jpg' }] }
    : { topics: [{ id: 25, slug: 'sample-thread', title: 'Sample thread' }] }), { status: 200 });
  try {
    const [forum] = await discourseSearch('https://forum.example.org', 'sample');
    const [scene] = await tpdbSearch({ tpdbKey: 'test' }, 'sample');
    assert.equal(forum.category, 'forums');
    assert.equal(forum.importable, false);
    assert.equal(scene.category, 'metadata');
    assert.equal(scene.importable, false);
  } finally { globalThis.fetch = original; }
});
