import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const template = fs.readFileSync('app/templates/tester.html', 'utf8');
const start = template.indexOf('function isGenericContainerTitle(');
const nextFunction = template.indexOf('function mediaNameKey(', start);
const end = template.lastIndexOf('\n', nextFunction);
assert.ok(start >= 0 && end > start, 'generic container-title guard is present');

const context = {};
vm.createContext(context);
vm.runInContext(template.slice(start, end), context);

assert.equal(context.isGenericContainerTitle('GoFile priečinok (1 videí)'), true);
assert.equal(context.isGenericContainerTitle('Bunkr folder (12 videos)'), true);
assert.equal(context.isGenericContainerTitle('pixeldrain album'), true);
assert.equal(context.isGenericContainerTitle('Turbo album'), true);
assert.equal(context.isGenericContainerTitle('Turbo video'), true);
assert.equal(context.isGenericContainerTitle('Bunkr album'), true);
assert.equal(context.isGenericContainerTitle('Untitled'), true);
assert.equal(context.isGenericContainerTitle('Bez názvu'), true);
assert.equal(context.isGenericContainerTitle('0j9a2h6v8d5_leakher.mp4'), false);
assert.equal(context.isGenericContainerTitle('My holiday album.mp4'), false);
