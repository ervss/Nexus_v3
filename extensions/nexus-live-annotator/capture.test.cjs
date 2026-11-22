const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function capture(activeIds, captureError) {
  let listener;
  let captures = 0;
  const chrome = {
    action: { onClicked: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    tabs: {
      async query() { return [{ id: activeIds.shift() }]; },
      async captureVisibleTab() {
        captures++;
        if (captureError) throw new Error(captureError);
        return 'data:image/png;base64,test';
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/background.js`, 'utf8'), { chrome });
  const result = await new Promise(resolve => {
    assert.equal(listener({ type: 'NLA_CAPTURE_VISIBLE' },
      { tab: { id: 7, windowId: 1 } }, resolve), true);
  });
  return { result, captures };
}

test('captures the requesting active tab', async () => {
  const { result, captures } = await capture([7, 7]);
  assert.equal(result.ok, true);
  assert.equal(captures, 1);
});
test('never captures another active tab', async () => {
  const { result, captures } = await capture([8]);
  assert.equal(result.ok, false);
  assert.equal(captures, 0);
});
test('rejects a capture if the user switches tabs', async () => {
  const { result } = await capture([7, 8]);
  assert.equal(result.ok, false);
  assert.match(result.error, /zmenila karta/);
});
test('explains how to restore the missing activeTab grant', async () => {
  const { result } = await capture([7], "Either the '<all_urls>' or 'activeTab' permission is required.");
  assert.equal(result.ok, false);
  assert.match(result.error, /Klikni na ikonu/);
});
