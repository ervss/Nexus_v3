const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

test('Quick Server Switcher popover and Retry Missing UI logic', () => {
  // Overenie prítomnosti funkcií a správnej štruktúry v content.js
  const contentCode = fs.readFileSync('extensions/nexus-video-selector/content.js', 'utf8');

  // 1. Tlačidlo nvs-retry-missing existuje v šablóne a má listener
  assert.match(contentCode, /id="nvs-retry-missing"/);
  assert.match(contentCode, /retryMissingCards\(retryMissingBtn\)/);

  // 2. Click listener na nvs-source-badge volá openServerSwitcherPopover
  assert.match(contentCode, /openServerSwitcherPopover\(card,\s*currentMeta,\s*sourceBadge\)/);

  // 3. openServerSwitcherPopover existuje a obsluhuje výber servera, kopírovanie a re-test
  assert.match(contentCode, /function openServerSwitcherPopover\(card, meta, badge/);
  assert.match(contentCode, /meta\.selectedPlayer\s*=\s*source\.player/);
  assert.match(contentCode, /navigator\.clipboard\.writeText\(meta\.streamUrl\)/);
  assert.match(contentCode, /chrome\.runtime\.sendMessage\(\{\s*type:\s*'FETCH_META',\s*url,\s*force:\s*true\s*\}\)/);

  // 4. CSS štýly sú prítomné v styles.css
  const stylesCode = fs.readFileSync('extensions/nexus-video-selector/styles.css', 'utf8');
  assert.match(stylesCode, /\.nvs-btn-retry-missing/);
  assert.match(stylesCode, /\.nvs-server-popover/);
  assert.match(stylesCode, /\.nvs-pop-row/);
  assert.match(stylesCode, /\.nvs-pop-btn-select/);
});
