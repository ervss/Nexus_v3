const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('Filester cookie bursts share one request and unchanged cookies are skipped', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../extensions/Nexus_Gallery/background.js'), 'utf8');
    const start = source.indexOf('const FILESTER_COOKIE_DOMAIN');
    const end = source.indexOf('const FILEDITCH_COOKIE_DOMAINS', start);
    let requests = 0;
    let value = 'old-token';
    const context = vm.createContext({
        chrome: { cookies: { getAll: async () => [{ name: 'auth_token', value, domain: '.filester.me', path: '/' }] } },
        radarBackendBase: async () => 'http://localhost:8000',
        fetch: async () => {
            requests++;
            return { ok: true, json: async () => ({ success: true }) };
        },
        AbortSignal, setTimeout, clearTimeout,
    });
    vm.runInContext(source.slice(start, end) + '\nthis.sync = syncFilesterCookies;', context);
    await Promise.all(Array.from({ length: 100 }, () => context.sync()));
    assert.equal(requests, 1);
    await context.sync();
    assert.equal(requests, 1);
    value = 'new-token';
    await context.sync();
    assert.equal(requests, 2);
});
