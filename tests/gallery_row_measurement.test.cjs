const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app/static/main.js', 'utf8');
const method = source.slice(source.indexOf('        measureVirtualGalleryRows() {'), source.indexOf('        visibleVideos() {'));
const measure = vm.runInNewContext(`({${method}}).measureVirtualGalleryRows`);

test('unequal sibling heights converge instead of refreshing every frame', () => {
    const heights = [300, 330, 310, 280, 340, 300];
    const cards = heights.map((height, index) => ({
        dataset: { virtualIndex: index }, getBoundingClientRect: () => ({ height }),
    }));
    let refreshes = 0;
    const state = { virtualGallery: {
        canvas: { querySelectorAll: () => cards }, columns: 3,
        measuredRows: new Set(), rowHeights: [300, 300, 300],
    }, refreshVirtualGallery() { refreshes++; } };
    measure.call(state);
    assert.deepEqual(state.virtualGallery.rowHeights.slice(0, 2), [330, 340]);
    for (let frame = 0; frame < 100; frame++) measure.call(state);
    assert.equal(refreshes, 1);
    heights[1] = 360;
    cards[1].getBoundingClientRect = () => ({ height: heights[1] });
    measure.call(state);
    assert.equal(refreshes, 2);
    assert.equal(state.virtualGallery.rowHeights[0], 360);
});

test('a partially visible row uses its tallest card regardless of DOM order', () => {
    const state = { virtualGallery: {
        canvas: { querySelectorAll: () => [
            { dataset: { virtualIndex: 5 }, getBoundingClientRect: () => ({ height: 370 }) },
            { dataset: { virtualIndex: 4 }, getBoundingClientRect: () => ({ height: 290 }) },
        ] }, columns: 3, measuredRows: new Set([0]), rowHeights: [320, 320],
    }, refreshVirtualGallery() {} };
    measure.call(state);
    assert.equal(state.virtualGallery.rowHeights[1], 370);
});
