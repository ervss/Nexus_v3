const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

const player = readFileSync(
    require('node:path').join(__dirname, '../../../app/static/main.js'),
    'utf8',
);

test('Turbo direct streams use the native player instead of the embed iframe', () => {
    const start = player.indexOf('isTurboVideo(video) {');
    const end = player.indexOf('turboEmbedUrl(video) {', start);
    assert.notEqual(start, -1, 'Turbo playback classifier must exist');
    assert.notEqual(end, -1, 'Turbo embed helper must follow the classifier');

    const classifier = player.slice(start, end);
    assert.match(classifier, /hasDirectStream/);
    assert.match(classifier, /turbocdn\\\./);
    assert.match(classifier, /return !hasDirectStream/);

    assert.match(player, /const isTurboDirect = sourceUrlLower\.includes\('turbo\.cr\/'/);
    assert.match(player, /else if \(!src && isTurboDirect\)/);
});