const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const folder = 'mega.nz/folder/FOLDER01#U1NTU1NTU1NTU1NTU1NTUw';
const file = 'mega.nz/file/VIDEO001#AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

function loadScanner() {
    const source = fs.readFileSync(path.join(__dirname, '../userscripts/mega-hub-capture.user.js'), 'utf8');
    const boot = source.indexOf("    if (hosts.has(location.hostname) && location.pathname.startsWith('/folder/')) return;");
    assert.ok(boot > 0);
    const context = {
        URL, location: new URL('https://example.test/'),
        Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 }, NodeFilter: { SHOW_TEXT: 4 },
        document: { createTreeWalker: () => ({ nextNode: () => null }) },
    };
    vm.runInNewContext(`${source.slice(0, boot)} globalThis.capture = { scan, candidates }; })();`, context);
    return context.capture;
}

test('captures a full MEGA URL in text without a protocol and deduplicates its explicit equivalent', () => {
    const { scan, candidates } = loadScanner();
    scan({ nodeType: 3, data: `Odkaz je ${folder}. Je tiež na (https://${folder}).` });
    assert.deepEqual([...candidates.keys()], [`https://${folder}`]);
});

test('reads the full raw href and encoded metadata even when the visible result is truncated', () => {
    const { scan, candidates } = loadScanner();
    const attribute = { href: folder, 'data-clipboard-text': encodeURIComponent(`https://${file}`) };
    scan({ nodeType: 3, data: 'The resolved url is: mega.nz/folder/FOLDER01#U1NTU1NT…' });
    assert.equal(candidates.size, 0);
    scan({
        nodeType: 1, closest: () => null, matches: () => true, querySelectorAll: () => [],
        href: `https://example.test/${folder}`,
        getAttributeNames: () => Object.keys(attribute), getAttribute: name => attribute[name],
    });
    assert.deepEqual([...candidates.keys()], [`https://${folder}`, `https://${file}`]);
});

test('rejects partial keys, lookalike domains and MEGA text embedded in a foreign URL path', () => {
    const { scan, candidates } = loadScanner();
    scan({ nodeType: 3, data: `${folder.slice(0, -4)} ${folder}... https://not-${folder} https://example.test/${folder} ftp://${folder}` });
    assert.equal(candidates.size, 0);
});

test('recognizes legacy and nested links with complete keys', () => {
    const { scan, candidates } = loadScanner();
    scan({ nodeType: 3, data: `//mega.co.nz/#F!FOLDER01!U1NTU1NTU1NTU1NTU1NTUw!INSIDE01 and ${folder}/file/VIDEO001` });
    assert.deepEqual([...candidates.keys()], [`https://${folder}/folder/INSIDE01`, `https://${folder}/file/VIDEO001`]);
});
