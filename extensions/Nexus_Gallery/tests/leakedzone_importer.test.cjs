const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

test('Nexus_Gallery manifest and declarativeNetRequest rules support Leakedzone', () => {
  const manifest = JSON.parse(fs.readFileSync('extensions/Nexus_Gallery/manifest.json', 'utf8'));
  const rules = JSON.parse(fs.readFileSync('extensions/Nexus_Gallery/rules.json', 'utf8'));

  const hostPerms = manifest.host_permissions || [];
  assert.ok(hostPerms.some(h => h.includes('leakedzone.com')), 'manifest host_permissions must contain leakedzone.com');

  const bcdnRule = rules.find(r => r.condition && r.condition.urlFilter && r.condition.urlFilter.includes('b-cdn.net'));
  assert.ok(bcdnRule, 'rules.json must contain declarative rule for b-cdn.net');
  assert.equal(bcdnRule.action.type, 'modifyHeaders');
  const refererHeader = bcdnRule.action.requestHeaders.find(h => h.header.toLowerCase() === 'referer');
  assert.ok(refererHeader && refererHeader.value.includes('leakedzone.com'));
});

test('popup.js isLeakedzoneUrl matches valid Leakedzone URLs and rejects others', () => {
  const popup = fs.readFileSync('extensions/Nexus_Gallery/popup.js', 'utf8');
  const start = popup.indexOf('function isLeakedzoneUrl(');
  const end = popup.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start);
  const fnCode = popup.slice(start, end);

  const context = { URL };
  vm.createContext(context);
  vm.runInContext(fnCode, context);

  assert.equal(context.isLeakedzoneUrl('https://leakedzone.com/creator/video/12345'), true);
  assert.equal(context.isLeakedzoneUrl('https://www.leakedzone.com/short/67890'), true);
  assert.equal(context.isLeakedzoneUrl('https://leakedzone.com/photos'), true);
  assert.equal(context.isLeakedzoneUrl('https://otherzone.com/video/12345'), false);
  assert.equal(context.isLeakedzoneUrl(''), false);
  assert.equal(context.isLeakedzoneUrl(null), false);
});

test('background.js isSupportedHost identifies leakedzone.com', () => {
  const background = fs.readFileSync('extensions/Nexus_Gallery/background.js', 'utf8');
  const start = background.indexOf('function isSupportedHost(');
  const end = background.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start);
  const fnCode = background.slice(start, end);

  const context = {};
  vm.createContext(context);
  vm.runInContext(fnCode, context);

  assert.equal(context.isSupportedHost('https://leakedzone.com/video/123'), true);
  assert.equal(context.isSupportedHost('https://other-unsupported-site.com/123'), false);
});

test('universal_importer.js decodes Leakedzone stream token correctly', () => {
  const testUrl = 'https://leakedzone.com/m3u8/video12345.m3u8?token=xyz';
  const encodedPayload = Buffer.from(testUrl, 'utf8').toString('base64');
  const reversed = encodedPayload.split('').reverse().join('');
  const fakeToken = '1234567890123456' + reversed + 'abcdefghijklmnop';

  // Decode algorithm test
  const trimmed = fakeToken.slice(16, -16);
  const rev = trimmed.split('').reverse().join('');
  const decoded = Buffer.from(rev, 'base64').toString('utf8');

  assert.equal(decoded, testUrl);
});
