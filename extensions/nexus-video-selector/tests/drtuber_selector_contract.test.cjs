const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

assert.match(content, /function isDrTuberPage\(\)/);
assert.match(content, /\.thumbs_box \.thumbs > a\.th\.ch-video\[href\*="\/video\/"\]/);
assert.match(content, /a\.th\.ch-video\[href\*="\/video\/"\]/);
assert.match(content, /function findNextListingLink\(doc\)/);
assert.match(content, /function getListingVideoUrls\(\)/);
assert.match(content, /ch\.matches\?\.\('a\[href\]'\) && isVideoUrl\(ch\.href\)/);
assert.match(background, /function isDrTuberUrl\(url\)/);
assert.match(background, /async function extractDrTuberMeta\(html, pageUrl\)/);
assert.match(background, /player_config_json/);
assert.match(background, /adapter: 'drtuber-player-config-v1'/);
assert.match(styles, /\.nvs-badge > \.nvs-badge-text\s*\{[^}]*position:\s*static\s*!important/s);

console.log('DrTuber selector and player-config contracts passed');
