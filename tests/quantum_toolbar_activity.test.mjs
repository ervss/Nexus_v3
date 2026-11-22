import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app/static/search.js', import.meta.url), 'utf8');

function createSearch(document) {
    document.addEventListener ??= () => {};
    const context = vm.createContext({ document });
    vm.runInContext(source + '\nthis.Search = QuantumSearch;', context);
    return Object.create(context.Search.prototype);
}

test('toolbar moves the existing Telegram input and picker without duplicating IDs', () => {
    const channelInput = {
        placeholder: '',
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; }
    };
    const quickChannel = { replacedWith: null, replaceWith(element) { this.replacedWith = element; } };
    const channelPicker = {};
    const channelLabel = { removed: false, remove() { this.removed = true; } };
    const quickPicker = { replacedWith: null, replaceWith(element) { this.replacedWith = element; } };
    const scrapeButton = {
        classList: { add() {} },
        replaceWith() {}
    };
    const scrapeSlot = { replaceWith() {} };
    const elements = {
        telegramChannelInput: channelInput,
        quantumToolbarChannel: quickChannel,
        quantumToolbarScrapeSlot: scrapeSlot,
        scrapeChannelBtn: scrapeButton,
        telegramLimitSelect: null,
        telegramScrapeLimit: null,
        searchLimitTotal: null
    };
    const search = createSearch({
        getElementById: id => elements[id] || null
    });
    search.overlay = {
        querySelector: selector => selector === '.quantum-toolbar-scrape .telegram-chat-picker'
            ? quickPicker
            : selector === '.quantum-search-setup .telegram-chat-picker' ? channelPicker
                : selector === '.quantum-search-setup .quantum-channel-scrape label[for="telegramChannelInput"]' ? channelLabel : null
    };

    search.moveToolbarControls();

    assert.equal(quickChannel.replacedWith, channelInput);
    assert.equal(quickPicker.replacedWith, channelPicker);
    assert.equal(channelLabel.removed, true);
    assert.equal(channelInput.placeholder, 'Telegram kanál');
    assert.equal(channelInput.attributes['aria-label'], 'Telegram kanál na scrape');
});

test('activity progress displays its detail and calculated completion', () => {
    const elements = {
        quantumActivityPanel: { dataset: {} },
        quantumActivityLabel: { textContent: '' },
        quantumActivityDetail: { textContent: '' },
        quantumActivityProgress: { hidden: true, value: 0 },
        quantumActivityLog: { innerHTML: '' }
    };
    const search = createSearch({
        getElementById: id => elements[id] || null
    });
    search.escapeHtml = value => value;

    search.setActivity('Fetching full metadata', 'FETCHING 0/45 · 0s', 'working');
    search.updateActivityProgress('FETCHING 20/45 · 15s', 20, 45);

    assert.equal(elements.quantumActivityLabel.textContent, 'Fetching full metadata');
    assert.equal(elements.quantumActivityDetail.textContent, 'FETCHING 20/45 · 15s');
    assert.equal(elements.quantumActivityPanel.dataset.state, 'working');
    assert.equal(elements.quantumActivityProgress.hidden, false);
    assert.equal(elements.quantumActivityProgress.value, 20 / 45 * 100);
});
