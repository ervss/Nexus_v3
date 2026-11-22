// História FapFolder knižnice: načítané komunity a knižnice sa ukladajú na disk.
// Blok histórie sa vyberie z produkčného súboru a spustí proti pamäťovej náhrade
// IndexedDB, takže sa testuje presne to, čo beží v prehliadači.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const IMPORTER = path.join(root, 'extensions/Nexus_Gallery/fapfolder_grid_importer.js');
const read = file => fs.readFileSync(file, 'utf8').replace(/^﻿/, '');

const START = '/* --------------------------------------------- historia (IndexedDB) — start';
const END = '/* ----------------------------------------------- historia (IndexedDB) — end */';

function cacheBlockSource() {
    const text = read(IMPORTER);
    const from = text.indexOf(START);
    const to = text.indexOf(END);
    assert.ok(from >= 0, 'v importeri chýba začiatočný marker histórie');
    assert.ok(to > from, 'v importeri chýba koncový marker histórie');
    return text.slice(from, to + END.length);
}

// Pamäťová náhrada IndexedDB. Transakcia sa dokončí v mikrotásku, rovnako ako
// tá skutočná, a vygenerovaný kľúč sa zapíše späť do záznamu.
function fakeIndexedDb() {
    const databases = new Map();
    const created = [];
    const broken = new Set();

    function finish(tx, result, error) {
        if (error) queueMicrotask(() => { tx.error = error; tx.onerror?.(); });
        else queueMicrotask(() => tx.oncomplete?.());
        return { result };
    }

    function objectStoreApi(tx, store) {
        return {
            get: key => finish(tx, store.records.get(key)),
            getAll: () => finish(tx, [...store.records.values()]),
            put(record) {
                const key = store.keyPath ? record[store.keyPath] : undefined;
                if (key === undefined) return finish(tx, undefined, new Error('záznam nemá kľúč'));
                store.records.set(key, record);
                return finish(tx, key);
            },
            add(record) {
                const key = store.next++;
                if (store.keyPath) record[store.keyPath] = key;
                store.records.set(key, record);
                return finish(tx, key);
            },
            delete(key) { store.records.delete(key); return finish(tx, undefined); },
            clear() { store.records.clear(); return finish(tx, undefined); },
        };
    }

    function makeDatabase(name) {
        const stores = new Map();
        return {
            name,
            objectStoreNames: { contains: storeName => stores.has(storeName) },
            createObjectStore(storeName, config) {
                created.push([name, storeName, config.keyPath, Boolean(config.autoIncrement)]);
                stores.set(storeName, { records: new Map(), next: 1, keyPath: config.keyPath });
                return {};
            },
            close() {},
            transaction(storeName) {
                const store = stores.get(storeName);
                if (!store) throw new Error(`object store ${storeName} neexistuje`);
                if (broken.has(storeName)) throw new Error(`object store ${storeName} je rozbité`);
                const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
                tx.objectStore = () => objectStoreApi(tx, store);
                return tx;
            },
        };
    }

    return {
        created,
        breakStore(storeName) { broken.add(storeName); },
        open(name) {
            const request = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
            if (!databases.has(name)) databases.set(name, makeDatabase(name));
            request.result = databases.get(name);
            queueMicrotask(() => { request.onupgradeneeded?.(); request.onsuccess?.(); });
            return request;
        },
    };
}

// Spustí produkčný blok histórie v sandboxe a vráti jeho API.
function loadCache(indexedDB) {
    const sandbox = { console: { warn() {}, log() {} }, indexedDB };
    vm.createContext(sandbox);
    vm.runInContext(`${cacheBlockSource()}
;globalThis.__api = {
    cache, summarizeCache, cacheableItem, cacheJobFromRecord, persistSource, mergeCacheMetrics, formatAgo,
    CACHE_DB_NAME, CACHE_MAX_ITEMS, CACHE_MAX_LIBRARIES, CACHE_MAX_IMPORTS,
};`, sandbox);
    return sandbox.__api;
}

const freshCache = () => loadCache(fakeIndexedDb());

// Hodnoty z vm majú iný prototyp než hodnoty testu, preto sa porovnávajú ako dáta.
const plain = value => JSON.parse(JSON.stringify(value));

function items(count, start = 1) {
    return Array.from({ length: count }, (_, index) => ({
        id: `posts:${start + index}`,
        url: `https://fapfolder.club/posts/${start + index}`,
        title: `Video ${start + index}`,
        thumbnail: 'https://cdn.fapfolder.club/t.jpg',
        duration: 120,
        sizeMb: 12.5,
    }));
}

test('načítaná komunita sa uloží a po znovuotvorení sa vráti celá', async () => {
    const api = freshCache();
    const key = 'https://fapfolder.club/groups/alpha/videos';
    const record = { key, url: key, name: 'alpha', items: items(6), count: 6, total: 6, complete: true, fetchedAt: Date.now() };
    assert.equal(await api.cache.putSource(record), true);
    const back = await api.cache.getSource(key);
    assert.equal(back.name, 'alpha');
    assert.equal(back.total, 6);
    assert.equal(plain(back.items).length, 6);
    assert.equal(back.items[0].id, 'posts:1');
    assert.equal(await api.cache.getSource('https://fapfolder.club/groups/nikde/videos'), null);
});

test('neúplný kratší beh nikdy neprepíše dlhší kompletný záznam', async () => {
    const api = freshCache();
    const key = 'https://fapfolder.club/groups/bravo/videos';
    const source = { url: key, name: 'bravo', status: '' };

    await api.persistSource(source, items(40), { complete: true });
    await api.persistSource(source, items(12), { complete: false });
    let stored = await api.cache.getSource(key);
    assert.equal(stored.total, 40, 'zastavené načítanie nesmie skrátiť históriu');
    assert.equal(stored.complete, true);

    // Dlhší kompletný beh históriu aktualizuje.
    await api.persistSource(source, items(44), { complete: true });
    stored = await api.cache.getSource(key);
    assert.equal(stored.total, 44);
    assert.equal(stored.count, 44);
    assert.equal(stored.truncated, false);

    // Neúplný beh s viac videami sa uloží, ale prizná neúplnosť.
    await api.persistSource(source, items(50), { complete: false });
    stored = await api.cache.getSource(key);
    assert.equal(stored.total, 50);
    assert.equal(stored.complete, false);
});

test('obrovská komunita sa uloží skrátená a označená ako skrátená', async () => {
    const api = freshCache();
    const key = 'https://fapfolder.club/groups/velka/videos';
    const total = api.CACHE_MAX_ITEMS + 5;
    await api.persistSource({ url: key, name: 'velka', status: '' }, items(total), { complete: true });
    const stored = await api.cache.getSource(key);
    assert.equal(stored.total, total);
    assert.equal(stored.count, api.CACHE_MAX_ITEMS);
    assert.equal(stored.truncated, true);
    assert.equal(plain(stored.items).length, api.CACHE_MAX_ITEMS);
});

test('knižnica sa ukladá raz na kombináciu zdrojov a počíta otvorenia', async () => {
    const api = freshCache();
    const key = ['https://fapfolder.club/groups/a/videos', 'https://fapfolder.club/groups/b/videos'].sort().join('|');
    await api.cache.saveLibrary({ key, name: 'a · b', sources: [], itemCount: 40, createdAt: 1, updatedAt: 1, openCount: 1 });
    await api.cache.saveLibrary({ key, name: 'a · b', sources: [], itemCount: 41, createdAt: 1, updatedAt: 2, openCount: 2 });
    const libraries = await api.cache.listLibraries();
    assert.equal(libraries.length, 1, 'tá istá kombinácia zdrojov nesmie vytvoriť druhý záznam');
    assert.equal(libraries[0].openCount, 2);
    assert.equal(libraries[0].itemCount, 41);
    assert.equal(libraries[0].createdAt, 1, 'prvé otvorenie sa zachováva');

    await api.cache.saveLibrary({ key: `${key}|c`, name: 'a · b · c', sources: [], itemCount: 9, createdAt: 3, updatedAt: 3, openCount: 1 });
    assert.equal((await api.cache.listLibraries()).length, 2);
    await api.cache.deleteLibrary(key);
    assert.equal((await api.cache.listLibraries()).length, 1);
});

test('história sa udržiava v rozumnej veľkosti', async () => {
    const api = freshCache();
    const total = api.CACHE_MAX_LIBRARIES + 4;
    for (let index = 0; index < total; index++) {
        await api.cache.saveLibrary({ key: `knižnica-${index}`, name: `k${index}`, sources: [], itemCount: index, updatedAt: index + 1, openCount: 1 });
    }
    const imports = api.CACHE_MAX_IMPORTS + 3;
    for (let index = 0; index < imports; index++) {
        await api.cache.logImport({ at: index + 1, name: `import-${index}`, count: index });
    }
    await api.cache.prune();

    const libraries = await api.cache.listLibraries();
    assert.equal(libraries.length, api.CACHE_MAX_LIBRARIES);
    assert.equal(libraries[0].key, `knižnica-${total - 1}`, 'najnovšia knižnica zostáva');
    assert.equal(libraries.some(row => row.key === 'knižnica-0'), false, 'najstaršia knižnica sa zahodí');

    const kept = await api.cache.listImports();
    assert.equal(kept.length, api.CACHE_MAX_IMPORTS);
    assert.equal(kept[0].name, `import-${imports - 1}`);

    // Zmazanie jedného importu funguje podľa vygenerovaného kľúča.
    await api.cache.deleteImport(kept[0].id);
    assert.equal((await api.cache.listImports()).length, api.CACHE_MAX_IMPORTS - 1);
});

test('vymazanie histórie vyprázdni všetky tri úložiská', async () => {
    const api = freshCache();
    await api.cache.putSource({ key: 'k', url: 'k', items: items(2), count: 2, total: 2 });
    await api.cache.saveLibrary({ key: 'l', sources: [], itemCount: 2, updatedAt: 1, openCount: 1 });
    await api.cache.logImport({ at: 1, name: 'i', count: 2 });
    await api.cache.clear();
    assert.deepEqual(plain(await api.cache.listSources()), []);
    assert.deepEqual(plain(await api.cache.listLibraries()), []);
    assert.deepEqual(plain(await api.cache.listImports()), []);
});

test('bez IndexedDB sa história ticho vypne a nič nezhodí', async () => {
    const api = loadCache(undefined);
    assert.equal(await api.cache.getSource('k'), null);
    assert.equal(await api.cache.putSource({ key: 'k' }), false);
    assert.equal(await api.cache.saveLibrary({ key: 'l' }), false);
    assert.deepEqual(plain(await api.cache.listSources()), []);
    assert.deepEqual(plain(await api.cache.listImports()), []);
    await api.cache.prune();
    await api.cache.clear();
    // Neuložený záznam sa nesmie hlásiť ako uložený.
    assert.equal(await api.persistSource({ url: 'https://fapfolder.club/groups/x/videos', name: 'x' }, items(3), { complete: true }), null);
});

test('rozbité jedno úložisko nepokazí ostatné', async () => {
    const fake = fakeIndexedDb();
    const api = loadCache(fake);
    await api.cache.putSource({ key: 'k', url: 'k', items: items(2), count: 2, total: 2 });
    await api.cache.logImport({ at: 1, name: 'i', count: 1 });
    fake.breakStore('libraries');
    assert.deepEqual(plain(await api.cache.listLibraries()), []);
    assert.equal((await api.cache.getSource('k')).total, 2, 'rozbité knižnice nesmú zabiť uložené komunity');
    assert.equal((await api.cache.listImports()).length, 1);
});

test('do histórie sa neukladajú vypršané stream odkazy ani data: náhľady', () => {
    const api = freshCache();
    const stored = api.cacheableItem({
        id: 'posts:9',
        url: 'https://fapfolder.club/posts/9',
        title: 'Video 9',
        thumbnail: 'data:image/jpeg;base64,AAAA',
        streamUrl: 'https://cdn.fapfolder.club/v.mp4?token=expiring',
        duration: 61,
        sizeMb: 8,
        quality: '1080p',
        sources: new Set(['alpha', 'bravo']),
    });
    assert.equal(stored.thumbnail, '', 'data: náhľad by históriu nafúkol');
    assert.equal('streamUrl' in stored, false, 'podpísaný odkaz vyprší, neukladá sa');
    assert.equal(stored.duration, 61);
    assert.equal(stored.sizeMb, 8);
    assert.deepEqual(plain(stored.sources), ['alpha', 'bravo']);

    const httpThumb = api.cacheableItem({ id: 'p:1', url: 'u', thumbnail: 'https://cdn.fapfolder.club/a.jpg' });
    assert.equal(httpThumb.thumbnail, 'https://cdn.fapfolder.club/a.jpg');
    assert.equal(httpThumb.sizeMb, null);
    assert.deepEqual(plain(httpThumb.sources), []);
});

test('z uloženého záznamu vznikne podklad pre metriky karty', () => {
    const api = freshCache();
    const job = api.cacheJobFromRecord({ key: 'u', name: 'alpha', complete: true, total: 2, fetchedAt: 5, items: items(2) });
    assert.equal(job.fromCache, true);
    assert.equal(job.listComplete, true);
    assert.equal(job.items.size, 2);
    assert.equal(job.metrics.size, 2);
    assert.equal(job.items.get('posts:2').title, 'Video 2');
    assert.equal(job.total, 2);
    assert.equal(api.summarizeCache(null), null);
});

test('časy v histórii sa čítajú po slovensky', () => {
    const api = freshCache();
    const now = Date.now();
    assert.equal(api.formatAgo(now - 10 * 1000), 'práve teraz');
    assert.equal(api.formatAgo(now - 5 * 60 * 1000), 'pred 5 min');
    assert.equal(api.formatAgo(now - 2 * 3600 * 1000), 'pred 2 h');
    assert.equal(api.formatAgo(now - 25 * 3600 * 1000), 'pred 1 dňom');
    assert.equal(api.formatAgo(now - 3 * 24 * 3600 * 1000), 'pred 3 dňami');
    assert.equal(api.formatAgo(0), 'neznámy čas');
    assert.equal(api.formatAgo(now + 60 * 1000), 'neznámy čas');
});

test('úložiská histórie majú stabilné názvy a kľúče', async () => {
    const fake = fakeIndexedDb();
    const api = loadCache(fake);
    await api.cache.listSources();
    assert.deepEqual(plain(fake.created), [
        [api.CACHE_DB_NAME, 'sources', 'key', false],
        [api.CACHE_DB_NAME, 'libraries', 'key', false],
        [api.CACHE_DB_NAME, 'imports', 'id', true],
    ]);
    assert.equal(api.CACHE_DB_NAME, 'nexus_ff_cache_v1', 'premenovanie databázy by zahodilo uloženú históriu');
});

test('história nezasahuje do stránky ani do dopravy rozšírenia', () => {
    const source = read(IMPORTER);
    // Fixtúry nahrádzajú presne tieto dva reťazce; keby sa zmenili, lokálne
    // overenie v prehliadači by ticho prestalo bežať.
    assert.ok(source.includes("if (!/(^|\\.)fapfolder\\.club$/i.test(location.hostname)) return;"));
    assert.ok(source.includes("url.protocol !== 'https:'"));
    assert.ok(source.includes("const SOURCES_KEY = 'nexus_ff_mix_sources_v1';"));
    assert.equal(/chrome\.storage/.test(source), false, 'história patrí na disk stránky, nie do chrome.storage');
});
