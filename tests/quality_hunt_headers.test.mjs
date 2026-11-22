import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extensions/Nexus_Gallery/background.js', import.meta.url), 'utf8');
const start = source.indexOf('    if (msg.action === "QUALITY_HUNT_ARM")');
const handler = source.slice(start, source.indexOf('    if (msg.action === "IMPORT_VIDEO")', start));
async function arm(streamUrl, pageUrl) {
    let rules;
    await new Promise(resolve => {
        const context = vm.createContext({URL, msg: {action: 'QUALITY_HUNT_ARM', streamUrl, pageUrl},
            sender: {tab: {id: 42}}, sendResponse: resolve,
            chrome: {declarativeNetRequest: {updateSessionRules: async value => {rules = value;}}}});
        vm.runInContext(`(function () { ${handler} })()`, context);
    });
    return rules.addRules[0];
}
test('FPO headers follow the get_file redirect onto the video CDN in the comparison tab', async () => {
    const page = 'https://www.fpo.xxx/video/123/clip/';
    const rule = await arm('https://www.fpo.xxx/get_file/31/hash/123_720p.mp4/?token=a', page);
    assert.equal(rule.condition.urlFilter, '||fpo.xxx/');
    assert.equal(rule.condition.requestDomains[0], 'fpo.xxx');
    assert.equal(rule.condition.tabIds[0], 42);
    assert.equal(rule.action.requestHeaders.find(h => h.header === 'referer').value, page);
});
test('other sources and unrelated pages retain their exact media path scope', async () => {
    for (const [stream, page] of [
        ['https://cdn.example/movie.mp4', 'https://site.example/watch'],
        ['https://www.fpo.xxx/get_file/movie.mp4/', 'https://other.example/watch'],
    ]) {
        const rule = await arm(stream, page);
        const url = new URL(stream);
        assert.equal(rule.condition.urlFilter, `|${url.origin}${url.pathname}`);
        assert.equal(rule.condition.requestDomains[0], url.hostname);
    }
});

test('CamWhores keeps source headers through TV and cloud CDN redirects in this tab', async () => {
    const page='https://www.camwhores.tv/videos/123/clip/';
    const rule=await arm('https://www.camwhores.tv/get_file/1/hash/123.mp4/',page);
    assert.deepEqual(Array.from(rule.condition.requestDomains),['camwhores.tv','camwhores.cloud']);
    assert.equal(rule.condition.urlFilter,undefined);
    assert.deepEqual(Array.from(rule.condition.tabIds),[42]);
    assert.equal(rule.action.requestHeaders.find(h=>h.header==='referer').value,page);
});
