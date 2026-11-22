const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('player rotation rotates by 90 degrees increments and reflects in style', () => {
    const source = fs.readFileSync('app/static/main.js', 'utf8');

    // Extract createPlayerModule
    const start = source.indexOf('function createPlayerModule() {');
    const end = source.indexOf('function createToastModule() {', start);
    assert.ok(start !== -1 && end !== -1, 'createPlayerModule boundaries found');

    const context = {
        console,
        window: {},
        Date,
        Math,
        Number,
        Boolean,
        Array,
        Object,
        String,
        Hls: { Events: {} }
    };

    const script = new vm.Script(`
        ${source.slice(start, end)}
        this.player = createPlayerModule();
    `);
    script.runInNewContext(context);

    const player = context.player;
    player.toasts = [];
    player.showToast = (msg, icon) => { player.toasts.push({ msg, icon }); };
    player.settings = { enableAmbilight: false };
    player.syncMainAmbilight = () => {};
    player.setMainPlaybackRate = () => {};

    // Initial rotation should be 0
    assert.equal(player.vFilters.rotation, 0);
    let style = player.getPlayerStyle(0);
    assert.match(style, /rotate\(0deg\)/);

    // Rotate +90
    player.rotateMainVideo(90);
    assert.equal(player.vFilters.rotation, 90);
    style = player.getPlayerStyle(0);
    assert.match(style, /rotate\(90deg\)/);

    // Rotate +90 again -> 180
    player.rotateMainVideo(90);
    assert.equal(player.vFilters.rotation, 180);
    style = player.getPlayerStyle(0);
    assert.match(style, /rotate\(180deg\)/);

    // Rotate +90 again -> 270
    player.rotateMainVideo(90);
    assert.equal(player.vFilters.rotation, 270);
    style = player.getPlayerStyle(0);
    assert.match(style, /rotate\(270deg\)/);

    // Rotate +90 again -> 0 (wrap around)
    player.rotateMainVideo(90);
    assert.equal(player.vFilters.rotation, 0);
    style = player.getPlayerStyle(0);
    assert.match(style, /rotate\(0deg\)/);

    // Test resetFilters resets rotation to 0
    player.rotateMainVideo(90);
    assert.equal(player.vFilters.rotation, 90);
    player.resetFilters();
    assert.equal(player.vFilters.rotation, 0);

    // Test resetMainZoomPan resets rotation to 0
    player.rotateMainVideo(180);
    assert.equal(player.vFilters.rotation, 180);
    player.resetMainZoomPan();
    assert.equal(player.vFilters.rotation, 0);
});
