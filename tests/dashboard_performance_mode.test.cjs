const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('app/static/main.js', 'utf8');
function setup(saved, mode) {
    const values = new Map();
    if (saved) values.set('vipSettings', JSON.stringify(saved));
    if (mode) values.set('dashboardPerformanceMode', mode);
    let reloads = 0;
    const context = { console, localStorage: {
        getItem: key => values.get(key) || null,
        setItem: (key, value) => values.set(key, value),
    }, window: { location: { reload: () => reloads++ } } };
    const settingsMethods = source.slice(source.indexOf('        loadSettings() {'), source.indexOf('        toggleFastBrowse() {'));
    const state = vm.runInNewContext(`({settings:{perfLite:true,turbo:false},${settingsMethods}})`, context);
    return { state, values, reloads: () => reloads };
}
test('fresh and legacy visual preferences default to lightweight mode', () => {
    for (const saved of [undefined, { perfLite: false, accentColor: 'green' }]) {
        const { state } = setup(saved);
        state.loadSettings();
        assert.equal(state.settings.perfLite, true);
        if (saved) assert.equal(state.settings.accentColor, 'green');
    }
});
test('an explicit full mode survives loading preferences', () => {
    const { state } = setup({ perfLite: true }, 'full');
    state.loadSettings();
    assert.equal(state.settings.perfLite, false);
});
test('mode switch persists once and lite shuts off ambilight', () => {
    const { state, values, reloads } = setup();
    state.setPerformanceMode('full');
    assert.equal(values.get('dashboardPerformanceMode'), 'full');
    assert.equal(reloads(), 1);
    state.setPerformanceMode('full');
    assert.equal(reloads(), 1);
    state.settings.enableAmbilight = true;
    state.setPerformanceMode('lite');
    assert.equal(values.get('dashboardPerformanceMode'), 'lite');
    assert.equal(JSON.parse(values.get('vipSettings')).enableAmbilight, false);
    assert.equal(reloads(), 2);
});
