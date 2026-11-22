const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('extensions/Nexus_Gallery/background.js', 'utf8');

assert.match(source, /function isTrustedEpornerPlaylistUrl\(rawUrl\)/);
assert.match(source, /url\.protocol === "https:"/);
assert.match(source, /\(\^\|\\\.\)eporner\\\.com/);
assert.match(source, /\(\?:\^\|\\\/\)playlist\\\//);
assert.match(source, /Fast Fetch accepts only HTTPS Eporner playlist URLs/);
assert.match(source, /Expected an HTTPS Eporner playlist URL/);

console.log('Eporner Fast Fetch security contract: passed');
