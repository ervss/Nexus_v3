import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app/static/search.js', import.meta.url), 'utf8');

function harness() {
    const stored = {};
    const results = { dataset: {} };
    const buttons = ['5x3', '5x2', '4x4'].map(layout => ({
        dataset: { layout },
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; }
    }));
    const context = vm.createContext({
        document: {
            getElementById: id => id === 'quantumSearchResults' ? results : null,
            querySelectorAll: selector => selector === '.quantum-result-layout-button' ? buttons : [],
            addEventListener() {}
        },
        localStorage: {
            setItem(key, value) { stored[key] = value; }
        }
    });
    vm.runInContext(source + '\nthis.Search = QuantumSearch;', context);
    const search = Object.create(context.Search.prototype);
    search.resultLayout = '5x3';
    return { search, results, buttons, stored };
}

test('result layout updates the grid, active control, and saved preference', () => {
    const { search, results, buttons, stored } = harness();

    search.setResultLayout('4x4');

    assert.equal(results.dataset.layout, '4x4');
    assert.equal(stored.quantum_result_layout, '4x4');
    assert.deepEqual(buttons.map(button => button.attributes['aria-pressed']), ['false', 'false', 'true']);
});
