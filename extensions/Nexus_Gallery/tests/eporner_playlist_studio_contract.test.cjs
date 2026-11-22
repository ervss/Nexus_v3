const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('extensions/Nexus_Gallery/eporner_playlist_studio.js', 'utf8');
const css = fs.readFileSync('extensions/Nexus_Gallery/eporner_playlist_studio.css', 'utf8');
for (const role of [
    'playlist-studio', 'fast-scan', 'open-tester', 'view-playlists', 'view-videos',
    'deep-resolve', 'export', 'import', 'clear', 'close', 'search', 'sort',
    'layout', 'help-toggle', 'hint', 'select-visible', 'select-none', 'remove-selected',
    'keep-visible', 'copy-urls', 'bulk-count',
]) {
    assert.match(source, new RegExp(`data-role=["'\`]${role}["'\`]`));
}
assert.match(source, /nexus_eporner_playlist_studio_v1/);
assert.match(source, /EPORNER_FAST_SCAN_PLAYLISTS/);
assert.match(source, /EPORNER_CREATE_MIX/);
assert.match(source, /EPORNER_DEEP_RESOLVE/);
assert.match(source, /playlist_sources/);
assert.match(source, /applyVisibleSelection/);
assert.match(source, /fastFetchPlaylist/);
assert.match(source, /nexus-ep-playlist-fast-fetch/);
assert.match(source, /nexus-ep-playlist-fast-summary/);
assert.match(source, /saveFastFetchSummary/);
assert.match(css, /nexus-ep-playlist-fast-fetch/);
assert.match(css, /nexus-ep-playlist-fast-summary/);
assert.doesNotMatch(source, /state\.selectedVideos\.add\(key\);\s*continue/);
assert.match(source, /class="nexus-ep-studio-title"/);
assert.doesNotMatch(source, /<article class="nexus-ep-studio-card"/);
assert.doesNotMatch(source, /<main data-role="grid"/);
assert.doesNotMatch(source, /events\.push/);
assert.match(source, /snapshot\?\.videos|videos: \[\.\.\.state\.videos\.values\(\)\]/);
assert.match(source, /selection_only/);
assert.match(source, /selectedOnly: true/);
assert.match(source, /if \(isPlaylistVideoListingPage\(\)\) return;/);
assert.match(css, /nexus-ep-studio-ratio/);
assert.match(css, /box-sizing: content-box !important/);
assert.match(css, /min-height: 168px !important/);
assert.match(css, /--eps-cols: 6/);
assert.match(css, /data-layout="list"/);
assert.match(css, /#nexus-ep-playlist-studio\.open/);
assert.match(css, /display: grid !important/);

const routeHelper = source.match(/function isPlaylistVideoListingPage\(\) \{[\s\S]*?\n    \}/)?.[0];
assert.ok(routeHelper, 'playlist video listing route guard exists');
for (const [pathname, shouldSkipStudio] of [
    ['/profile/Thedestroyer123/playlist/ceCrhoRS0BO/Dick-drainers/', true],
    ['/profile/Thedestroyer123/playlist/ceCrhoRS0BO/Dick-drainers/2/', true],
    ['/profile/Thedestroyer123/', false],
    ['/search-playlists/dick/', false],
]) {
    const context = { location: { pathname } };
    vm.runInNewContext(`${routeHelper}; globalThis.skipStudio = isPlaylistVideoListingPage();`, context);
    assert.equal(context.skipStudio, shouldSkipStudio, pathname);
}

console.log('Eporner Playlist Studio contract: passed');
