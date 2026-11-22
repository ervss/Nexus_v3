import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source = readFileSync(new URL('../app/static/search.js', import.meta.url), 'utf8');
test('direct Telegram results retain parsed title and searchable metadata', () => {
    const context = vm.createContext({document: {addEventListener() {}}, URL, setTimeout, clearTimeout});
    vm.runInContext(source + '\nthis.Search = QuantumSearch;', context);
    const search = Object.create(context.Search.prototype);
    const item = search._mapRawTelegramVideo({message_id: 42, chat_id: 1, text: '$20 advertisement', title: 'Tayleah Jade', performers: ['Tayleah Jade'], scene_title: 'POV scene', tags: ['Lingerie'], platform: 'OnlyFans'}, 'channel');
    assert.equal(item.title, 'Tayleah Jade');
    assert.equal(item.text, '$20 advertisement');
    assert.equal(search.filterResultsForQuery([item], 'lingerie').length, 1);
    assert.equal(search.filterResultsForQuery([item], 'scene').length, 1);
});
