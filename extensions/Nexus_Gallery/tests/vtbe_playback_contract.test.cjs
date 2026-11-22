const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const interceptor = fs.readFileSync(path.join(root, 'pornhoarder_player_interceptor.js'), 'utf8');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const importer = fs.readFileSync(path.join(root, 'universal_importer.js'), 'utf8');

const playerScript = manifest.content_scripts.find(entry =>
  Array.isArray(entry.js) && entry.js.includes('pornhoarder_player_interceptor.js')
);

assert.ok(playerScript, 'player interceptor must remain registered');
assert.ok(playerScript.matches.includes('https://vtbe.to/*'), 'vtbe watch pages must run the early interceptor');
assert.match(interceptor, /function isVtbeMediaResponse/, 'interceptor must recognize video MIME responses');
assert.match(interceptor, /getResponseHeader\('content-type'\)/, 'XHR video responses must expose their direct URL');
assert.match(interceptor, /r\.headers\.get\('content-type'\)/, 'fetch video responses must expose their direct URL');
assert.match(background, /vtbe\\\.to/, 'background capture reporting must accept vTube watch pages');
assert.match(background, /chrome\.webRequest\.onHeadersReceived\.addListener/, 'background must inspect vTube response MIME types');
assert.match(background, /\["responseHeaders"\]/, 'vTube response MIME inspection must request response headers');
assert.match(importer, /function isVtbePage\(\)/, 'universal importer must recognize vTube pages');
assert.match(importer, /if \(isVtbePage\(\)\) \{\s*createOverlay\(video\)/, 'universal importer must show a panel before MSE duration is known');

console.log('vtbe playback contract: ok');
