const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('a broken userscript performance clock cannot block opening player controls', () => {
    const source = fs.readFileSync('app/static/main.js', 'utf8');
    const start = source.indexOf('        resetControlsTimer() {');
    const end = source.indexOf('        togglePlayerControls(', start);
    let clock = 10000;
    const timers = [];
    const cleared = [];
    const performance = { now() { throw new TypeError('Illegal invocation'); } };
    const controls = vm.runInNewContext(`({${source.slice(start, end)}})`, {
        window: { performance }, performance,
        Date: { now: () => clock },
        setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
        clearTimeout: id => cleared.push(id),
    });
    const player = { ...controls, showPlayer: true, showControls: false,
        lastControlsActivityAt: 0, controlsActivityThrottleMs: 100 };

    assert.doesNotThrow(() => player.resetControlsTimer());
    assert.equal(player.showControls, true);
    assert.equal(timers.length, 1);
    player.resetControlsTimer();
    assert.equal(timers.length, 1);
    clock += 101;
    player.resetControlsTimer();
    assert.deepEqual(cleared, [1]);
    timers.at(-1).callback();
    assert.equal(player.showControls, false);
});
