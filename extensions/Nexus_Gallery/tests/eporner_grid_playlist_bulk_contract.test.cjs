const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('extensions/Nexus_Gallery/eporner_grid_importer.js', 'utf8');
const styles = fs.readFileSync('extensions/Nexus_Gallery/eporner_grid_importer.css', 'utf8');
const toolbarMarkup = source.match(/toolbar\.innerHTML = `([\s\S]*?)`;/)?.[1] || '';
assert.ok(toolbarMarkup, 'quick import toolbar markup exists');

for (const role of ['title-hunt', 'quality-filter', 'sort-field', 'grid-columns', 'refresh', 'fetch-meta', 'load-next-pages', 'load-all-pages', 'select', 'clear', 'import']) {
    assert.match(source, new RegExp(`data-role=["'\\\`]${role}["'\\\`]`));
}
assert.match(source, /const GRID_COLUMN_OPTIONS = \[3, 4, 5, 6\]/);
assert.match(toolbarMarkup, /data-columns="\$\{columns\}"/);
assert.match(source, /gridColumns:\s*5/);
assert.match(source, /function setGalleryColumns\(columns\)/);
assert.match(source, /grid\.style\.setProperty\('--nexus-ep-grid-columns', String\(value\)\)/);
assert.match(source, /aria-pressed="\$\{columns === state\.gridColumns \? 'true' : 'false'\}"/);
assert.match(source, /option value="playlist-size">Playlist size/);
assert.match(source, /role="status" aria-live="polite"/);
assert.match(source, /Import selected\$\{selected \? ` \(\$\{selected\}\)` : ''\}/);
assert.doesNotMatch(toolbarMarkup, /data-role=["'`](?:layout|keeper-pass|copy-direct-urls|sidecar-selected|duration-min|size-min|date-newer)["'`]/);
assert.match(source, /function visiblePlaylistEntries\(\)/);
assert.match(source, /function selectedPlaylistEntries\(\)/);
assert.match(source, /function sortPlaylistCards\(\)/);
assert.match(source, /function importSelectedWithPlaylists\(\)/);
assert.match(source, /action: 'EPORNER_EXPAND_PLAYLIST'/);
assert.match(source, /picker\.click\(\);\s*\/\/ keeps the Playlist Studio basket in sync/);
const playlistRouteHelper = source.match(/function isPlaylistVideoListingPage\(\) \{[\s\S]*?\n    \}/)?.[0];
assert.ok(playlistRouteHelper, 'playlist video listing route helper exists');
for (const [pathname, isPlaylistListing] of [
    ['/profile/Thedestroyer123/playlist/ceCrhoRS0BO/Dick-drainers/', true],
    ['/profile/Fetishman909/playlist/zE8s3pM77eW/Facefuck/', true],
    ['/profile/Fetishman909/playlist/zE8s3pM77eW/Facefuck/2/', true],
    ['/video-abc/title/', false],
]) {
    const context = { location: { pathname } };
    vm.runInNewContext(`${playlistRouteHelper}; globalThis.isListing = isPlaylistVideoListingPage();`, context);
    assert.equal(context.isListing, isPlaylistListing, pathname);
}
assert.match(source, /function playlistVideoListing\(\)[\s\S]*?document\.querySelectorAll\('\.streameventsday'\)/);
assert.match(source, /!listing\.closest\('\.pf-pl-head, \.pf-pl-info'\)/);
assert.match(source, /!playlistListing\.contains\(card\)[\s\S]*?card\.closest\('\.pf-pl-head, \.pf-pl-info'\)/);
assert.match(source, /const gridParent = playlistListing \|\| firstCard\.parentElement/);
assert.match(source, /gridParent !== grid && !grid\.contains\(gridParent\)/);
const arrangeCards = source.match(/function arrangeFilteredCards\(visibleIds\) \{([\s\S]*?)\n    \}/)?.[1] || '';
assert.match(arrangeCards, /!hasActiveViewFilter\(\) && isDetailPage\(\)/);
assert.match(arrangeCards, /ensureCompactGrid\(visibleNodes\[0\]\)/);
assert.match(styles, /#nexus-ep-clean-grid\s*\{[\s\S]*?display:\s*grid\s*!important;[\s\S]*?grid-template-columns:\s*repeat\(var\(--nexus-ep-grid-columns,\s*5\)/);
assert.match(styles, /@container nexus-ep-stage \(max-width: 900px\)/);
assert.match(styles, /@container nexus-ep-stage \(max-width: 620px\)/);

console.log('Eporner playlist bulk contract: passed');
