import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const template = fs.readFileSync('app/templates/index.html', 'utf8');
const source = fs.readFileSync('app/static/main.js', 'utf8');

test('selected card exposes a whole-batch action', () => {
  assert.match(template, /@click\.stop="selectEntireBatch\(video\.batch_name\)"/);
  assert.match(template, /Celý batch/);
});

test('whole-batch action loads every page and selects all returned ids', () => {
  assert.match(source, /async selectEntireBatch\(batchName\)/);
  assert.match(source, /JSON\.stringify\(\{\s*batch_name:\s*batchName/);
  assert.match(source, /this\.selectedIds = allVideos\.map\(video => video\.id\)/);
});
