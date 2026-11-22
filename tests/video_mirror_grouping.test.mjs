import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('app/static/modules/nexus_core.js', 'utf8');
const context = { window: { location: { origin: 'http://localhost' } } };
vm.createContext(context);
vm.runInContext(source, context);

const sameTitle = {
    title: 'A Long Filename - Filester.mp4',
    file_size_mb: 4700,
    duration: 1581,
};
const sameMirror = {
    title: 'A Long Filename.mp4',
    file_size_mb: 4708,
    duration: 1583,
};

assert.equal(context.window.mediaMatchNameKey('A Long Filename - Filester.mp4'), 'alongfilename');
assert.equal(context.window.areVideoMirrors(sameTitle, sameMirror), true);
assert.equal(context.window.areVideoMirrors(sameTitle, { ...sameMirror, file_size_mb: 5000 }), false);
assert.equal(context.window.areVideoMirrors(sameTitle, { ...sameMirror, duration: 1590 }), false);
assert.equal(context.window.areVideoMirrors(sameTitle, { ...sameMirror, title: 'clip.mp4' }), false);

const template = fs.readFileSync('app/templates/index.html', 'utf8');
assert.match(template, /@mouseenter="openVideoSources\(video\)"/);
assert.match(template, /@click\.stop="switchVideoSource\(video, source\)"/);

const main = fs.readFileSync('app/static/main.js', 'utf8');
const start = main.indexOf('        coalesceVideoMirrors(');
const end = main.indexOf('        async loadBatches(', start);
assert.ok(start >= 0 && end > start, 'dashboard mirror grouping method exists');
const coalesce = vm.runInNewContext(
    `({${main.slice(start, end)}}).coalesceVideoMirrors`,
    { window: context.window, URL },
);
const primary = { ...sameTitle, id: 1, url: 'https://filester.example/a.mp4', source_labels: ['Filester'] };
const dashboard = { getSourceName: () => 'Pixeldrain' };
const visibleCards = coalesce.call(dashboard, [{ ...sameMirror, id: 2, url: 'https://pixeldrain.example/a.mp4' }], [primary]);

assert.equal(visibleCards.length, 0);
assert.equal(primary._matchedVideos.length, 1);
assert.equal(primary.source_count, 2);
assert.deepEqual(Array.from(primary.source_labels), ['Filester', 'Pixeldrain']);
