const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load() {
  let beforeNavigate;
  let updated;
  const calls = [];
  const context = vm.createContext({
    URL,
    atob,
    chrome: {
      storage: { sync: { get: async defaults => defaults } },
      webNavigation: { onBeforeNavigate: { addListener: fn => { beforeNavigate = fn; } } },
      tabs: {
        onUpdated: { addListener: fn => { updated = fn; } },
        update: async (tabId, value) => calls.push({ tabId, ...value }),
      },
    },
  });
  vm.runInContext(fs.readFileSync('extensions/camwhores-url-fixer/background.js', 'utf8'), context);
  return { context, beforeNavigate, updated, calls };
}

test('redirects the supplied www.xvideos.red URL to .com and preserves query/hash', async () => {
  const { context } = load();
  const source = 'https://www.xvideos.red/video.omemidm5231/stunning_latina?sxcaf=4353_profile-tab_&_sxc=pt';
  assert.equal(context.buildCanonical(source), 'https://www.xvideos.com/video.omemidm5231/stunning_latina?sxcaf=4353_profile-tab_&_sxc=pt');
  assert.equal(context.shouldHandleUrl(source), true);
});

test('uses both navigation hooks without issuing duplicate updates', async () => {
  const { beforeNavigate, updated, calls } = load();
  const source = 'https://www.xvideos.red/video.omemidm5231/stunning_latina?sxcaf=4353_profile-tab_&_sxc=pt';
  beforeNavigate({ frameId: 0, tabId: 9, url: source });
  updated(9, { url: source });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.xvideos.com/video.omemidm5231/stunning_latina?sxcaf=4353_profile-tab_&_sxc=pt');
});

test('does not redirect non-XVideos domains or subframes', async () => {
  const { beforeNavigate, updated, calls } = load();
  beforeNavigate({ frameId: 2, tabId: 1, url: 'https://www.xvideos.red/video/1' });
  updated(1, { url: 'https://www.example.com/xvideos.red/video/1' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 0);
});

test('static MV3 rule covers both bare and www xvideos.red navigation', () => {
  const rules = JSON.parse(fs.readFileSync('extensions/camwhores-url-fixer/rules.json', 'utf8'));
  const condition = new RegExp(rules[0].condition.regexFilter);
  assert.equal(condition.test('https://www.xvideos.red/video/123?x=1'), true);
  assert.equal(condition.test('https://xvideos.red/models/test'), true);
  assert.equal(condition.test('https://evil-xvideos.red/video/123'), false);
  assert.deepEqual(rules[0].condition.resourceTypes, ['main_frame']);
});
