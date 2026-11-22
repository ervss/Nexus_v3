import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'extensions/Nexus_Gallery/universal_importer.js'), 'utf8');

test('Bunkr page and slug patterns match modern Bunkr / Balbums variations', () => {
    assert.match(source, /balbums/, 'balbums must be recognized as Bunkr page mirror');
    assert.match(source, /\/(?:\?:f\|v\|d)\/|(?:\/f\/|\/v\/|\/d\/)/, 'extractBunkrSlug must support /f/, /v/ and /d/ routes');
    assert.match(source, /decryptBunkrVsUrl/, 'universal_importer must include XOR decryption for /api/vs responses');
});

test('XOR decryption logic restores valid stream URL from encrypted payload', () => {
    const ts = 1770000000;
    const testUrl = 'https://media-files12.bunkr.cr/videos/blake-blossom-1080.mp4';
    const key = new TextEncoder().encode(`SECRET_KEY_${Math.floor(ts / 3600)}`);
    const plainBytes = new TextEncoder().encode(testUrl);
    const xorBytes = new Uint8Array(plainBytes.length);
    for (let i = 0; i < plainBytes.length; i++) {
        xorBytes[i] = plainBytes[i] ^ key[i % key.length];
    }
    let binary = '';
    for (let i = 0; i < xorBytes.length; i++) {
        binary += String.fromCharCode(xorBytes[i]);
    }
    const base64Enc = Buffer.from(binary, 'binary').toString('base64');

    const funcMatch = source.match(/function decryptBunkrVsUrl\([\s\S]*?\n    \}/);
    assert.ok(funcMatch, 'decryptBunkrVsUrl function not found');
    const fn = new Function(`${funcMatch[0]}; return decryptBunkrVsUrl;`)();
    const decrypted = fn(base64Enc, ts);
    assert.equal(decrypted, testUrl, 'decrypted URL must match original plain URL');
});

test('parseBunkrDisplayedSize extracts size and ignores Nexus overlay', () => {
    const overlaySelectors = '.nexus-import-overlay, .nexus-hunt-modal, .nexus-listing-player, .nexus-listing-player-modal';

    const overlayEl = {
        className: 'nexus-size-value',
        textContent: 'Size: 19.8 KB · below 10 MB minimum',
        children: [],
        closest: (sel) => sel.includes('nexus-import-overlay') ? {} : null,
    };

    const sizeSpan = {
        className: '',
        textContent: '493.85 MB',
        children: [],
        closest: () => null,
    };

    const mockElements = [overlayEl, sizeSpan];
    globalThis.document = {
        querySelector: () => null,
        querySelectorAll: (sel) => {
            if (sel.includes('span')) return mockElements;
            return [];
        },
        body: null
    };

    const funcMatch = source.match(/function parseBunkrDisplayedSize\([^)]*\)\s*\{[\s\S]*?\n    \}/);
    assert.ok(funcMatch, 'parseBunkrDisplayedSize function not found');
    const fn = new Function(`${funcMatch[0]}; return parseBunkrDisplayedSize;`)();

    const parsedBytes = fn();
    const expectedBytes = Math.round(493.85 * 1048576);
    assert.equal(parsedBytes, expectedBytes, `Expected ${expectedBytes} B (493.85 MB), got ${parsedBytes} B`);
});

test('MEDIA_SIZE_OBSERVED does not overwrite Bunkr page size with tiny error chunk', () => {
    assert.match(source, /if\s*\(isBunkrPage\(window\.location\.href\)\)\s*\{[\s\S]*?if\s*\(pageSize\s*>\s*0\)\s*\{[\s\S]*?return;/,
        'MEDIA_SIZE_OBSERVED must guard Bunkr page size from being overwritten by tiny chunk');
});

test('collectBestTitle does not split title on first hyphen for video filenames', () => {
    globalThis.document = {
        title: 'Blake Blossom - POV Blondes Love Sucking on BBC with Nicole Summers (1080).mp4 - Bunkr',
        querySelector: () => null,
        querySelectorAll: () => []
    };

    const funcMatch = source.match(/function collectBestTitle\(video\)\s*\{[\s\S]*?\n    \}/);
    assert.ok(funcMatch, 'collectBestTitle function not found');
    const fn = new Function('document', 'isGofilePage', `${funcMatch[0]}; return collectBestTitle;`)(globalThis.document, () => false);

    const title = fn(null);
    assert.equal(title, 'Blake Blossom - POV Blondes Love Sucking on BBC with Nicole Summers (1080).mp4',
        'Title should not truncate after "Blake Blossom"');
});

test('paintVideoQuality displays resolution from video title or videoHeight for direct files', () => {
    globalThis.document = {
        title: 'Blake Blossom - POV Blondes (1080).mp4',
        querySelector: () => null
    };
    const funcMatch = source.match(/function paintVideoQuality\([\s\S]*?\n    \}/);
    assert.ok(funcMatch, 'paintVideoQuality function not found');
    const fn = new Function(`let qualitySearchState = { status: 'unknown' }; ${funcMatch[0]}; return paintVideoQuality;`)();

    const el = {};
    fn(el, null);
    assert.match(el.textContent, /1080p/, 'Should estimate 1080p from video filename');

    const el2 = {};
    fn(el2, { videoHeight: 720, videoWidth: 1280 });
    assert.match(el2.textContent, /720p · priamy súbor/, 'Should display videoHeight resolution');
});
