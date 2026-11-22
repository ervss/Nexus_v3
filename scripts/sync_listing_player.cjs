// Keep standalone unpacked extension packages self-contained. Run after editing
// the shared player sources in extensions/nexus-video-selector.
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
for(const name of ['whoreshub-player.js','listing-player-sites.js','listing-player-network.js','listing-player.css']) {
  fs.copyFileSync(path.join(root,'extensions/nexus-video-selector',name),path.join(root,'extensions/Nexus_Gallery',name));
}
