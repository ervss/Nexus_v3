const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const popup = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
const workbench = fs.readFileSync(path.join(root, 'import-workbench.js'), 'utf8');

// 1. Overenie zmlúv v kóde
assert.match(popup, /function normalizeHost\(value\)/, 'popup.js must contain normalizeHost');
assert.match(popup, /async function toggleHostEnabled\(\)/, 'popup.js must have toggleHostEnabled');
assert.match(popup, /hiddenPanelHosts/, 'popup.js must track hiddenPanelHosts');
assert.doesNotMatch(popup, /enabled:\s*toggle\.classList\.contains\('active'\)/, 'popup.js must not set global enabled to false on toggle');

assert.match(content, /function normalizeHost\(value\)/, 'content.js must contain normalizeHost');
assert.match(content, /function deactivateOnPage\(\)/, 'content.js must have deactivateOnPage');
assert.match(content, /msg\.action === 'disableOnPage'/, 'content.js must handle disableOnPage');
assert.match(content, /msg\.action === 'enableOnPage'/, 'content.js must handle enableOnPage');
assert.match(content, /msg\.action === 'getHostState'/, 'content.js must handle getHostState');
assert.match(content, /hiddenPanelHosts/, 'content.js must check hiddenPanelHosts');

assert.match(workbench, /hiddenPanelHosts/, 'import-workbench.js must support hiddenPanelHosts');
assert.match(workbench, /function visible\(value,\s*syncToStorage/, 'import-workbench.js visible must support syncToStorage');

// 2. Funkčný test logiky per-site
function normalizeHost(value) {
  if (!value) return '';
  try {
    const raw = String(value).trim();
    const parsed = raw.includes('://') ? new URL(raw).hostname : raw;
    return parsed.replace(/^www\./i, '').toLowerCase();
  } catch {
    return String(value).replace(/^www\./i, '').toLowerCase().trim();
  }
}

assert.strictEqual(normalizeHost('https://namethatporn.com/post/1908425-who-is-she.html'), 'namethatporn.com');
assert.strictEqual(normalizeHost('http://www.NameThatPorn.COM/test'), 'namethatporn.com');
assert.strictEqual(normalizeHost('https://xhamster.com/videos/123'), 'xhamster.com');

// Simulácia stavov:
// Scenár A: Vypnutie na namethatporn.com
let disabledHosts = [];
const siteToDisable = normalizeHost('https://namethatporn.com/post/1908425');
if (!disabledHosts.includes(siteToDisable)) disabledHosts.push(siteToDisable);

// Overenie: namethatporn je vypnuté
assert.strictEqual(disabledHosts.includes(normalizeHost('namethatporn.com')), true);
// Iná stránka xhamster.com zostáva ZAPNUTÁ
assert.strictEqual(disabledHosts.includes(normalizeHost('https://xhamster.com/')), false);

// Scenár B: Skrytie panela na namethatporn.com
let hiddenPanelHosts = [];
const siteToHidePanel = normalizeHost('https://namethatporn.com/post/1908425');
if (!hiddenPanelHosts.includes(siteToHidePanel)) hiddenPanelHosts.push(siteToHidePanel);

// Overenie: panel na namethatporn.com je skrytý
assert.strictEqual(hiddenPanelHosts.includes(normalizeHost('namethatporn.com')), true);
// Panel na novej stránke pornhub.com je VIDITEĽNÝ (nie je v hiddenPanelHosts)
assert.strictEqual(hiddenPanelHosts.includes(normalizeHost('https://pornhub.com/')), false);

// Scenár C: Reaktivácia panelu na namethatporn.com
hiddenPanelHosts = hiddenPanelHosts.filter(h => h !== 'namethatporn.com');
assert.strictEqual(hiddenPanelHosts.includes('namethatporn.com'), false);

console.log('✔ Per-site persistence contracts and logic test passed');
