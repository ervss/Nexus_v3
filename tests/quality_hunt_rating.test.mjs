import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../extensions/Nexus_Gallery/universal_importer.js', import.meta.url), 'utf8');
const start = source.indexOf('    function scoreHuntCard(');
const end = source.indexOf('    function buildHuntCard(', start);
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);

test('confirmed decoded higher-quality match earns a full score', () => {
    const rating = context.scoreHuntCard({identity_state:'confirmed', availability_state:'playable',
        availability_reason:'Prehrávanie overené v prehliadači', quality_state:'measured',
        quality_status:'higher', duration_sec:120, size_bytes:12000000, height:1080});
    assert.equal(rating.value,100);
    assert.equal(rating.factors.reduce((sum, factor)=>sum+factor.value,0),rating.value);
    assert.equal(rating.tier,'silny');
});

test('a possible or rejected scene cannot outrank confirmed footage merely by being 4K', () => {
    const betterLooking = {availability_state:'playable',quality_state:'measured',quality_status:'higher',
        height:2160,duration_sec:120,size_bytes:100000000};
    const possible=context.scoreHuntCard({...betterLooking,identity_state:'possible'});
    const rejected=context.scoreHuntCard({...betterLooking,identity_state:'rejected'});
    const confirmed=context.scoreHuntCard({...betterLooking,identity_state:'confirmed'});
    assert.ok(possible.value<confirmed.value);
    assert.ok(possible.value<60);
    assert.equal(rejected.value,0);
});

test('file size contributes only to metadata completeness, never picture quality', () => {
    const card={identity_state:'confirmed',availability_state:'playable',quality_state:'measured',
        quality_status:'same',height:720,duration_sec:120};
    const without=context.scoreHuntCard(card);
    const withSize=context.scoreHuntCard({...card,size_bytes:1000000000});
    assert.equal(withSize.value-without.value,3);
    assert.equal(withSize.factors[2].value,without.factors[2].value);
});

test('media bytes alone never receive a browser-played verdict', () => {
    const rating=context.scoreHuntCard({identity_state:'confirmed',availability_state:'playable',
        quality_state:'measured',quality_status:'higher',height:1080,duration_sec:120,size_bytes:100000000});
    assert.ok(rating.value >= 75);
    assert.equal(rating.tier,'overit');
});
