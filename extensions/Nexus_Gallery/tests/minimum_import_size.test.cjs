const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync('extensions/Nexus_Gallery/universal_importer.js', 'utf8');
const sizeStart = source.indexOf('    function knownImportSizeBytes(');
const sizeEnd = source.indexOf('    function parseDurationSeconds(', sizeStart);
const context = { MIN_IMPORT_SIZE_BYTES: 10 * 1024 * 1024 };
vm.createContext(context);
vm.runInContext(source.slice(sizeStart, sizeEnd), context);

test('the minimum-size guard reads both measured and displayed sizes', () => {
  const direct = { _sizeBytes: 42 * 1024, querySelector: () => ({ textContent: 'Size: unknown' }) };
  const displayed = { _sizeBytes: 0, querySelector: () => ({ textContent: 'Size: 9.5 MB' }) };
  assert.equal(context.knownImportSizeBytes(direct), 42 * 1024);
  assert.equal(context.knownImportSizeBytes(displayed), Math.round(9.5 * 1024 * 1024));
  assert.equal(context.knownImportSizeBytes({ _sizeBytes: 0, querySelector: () => ({ textContent: 'Size: unknown' }) }), 0);
});

test('known files below 10 MB are rejected while 10 MB files pass', () => {
  assert.equal(context.isBelowMinimumImportSize(41.5 * 1024), true);
  assert.equal(context.isBelowMinimumImportSize(10 * 1024 * 1024 - 1), true);
  assert.equal(context.isBelowMinimumImportSize(10 * 1024 * 1024), false);
  assert.equal(context.isBelowMinimumImportSize(0), false);

  const importHandler = source.slice(
    source.indexOf('    async function handleImport('),
    source.indexOf('    function enqueueSidecarOnPage(', source.indexOf('    async function handleImport('))
  );
  assert.match(importHandler, /knownImportSizeBytes\(_overlayEl\)/);
  assert.match(importHandler, /isBelowMinimumImportSize\(knownSize\)/);
});
