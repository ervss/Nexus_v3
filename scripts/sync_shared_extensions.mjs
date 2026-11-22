import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = path.join(root, 'extensions', 'shared', 'nexus_bridge.js');

const targets = [
  path.join(root, 'extensions', 'Nexus_Deck', 'lib', 'nexus_bridge.js'),
  path.join(root, 'extensions', 'Nexus_Gallery', 'lib', 'nexus_bridge.js'),
  path.join(root, 'extensions', 'nexus_universal_importer', 'lib', 'nexus_bridge.js'),
  path.join(root, 'extensions', 'nexus-video-selector', 'lib', 'nexus_bridge.js'),
];

const content = fs.readFileSync(source, 'utf8');
for (const target of targets) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  console.log(`Synced ${path.relative(root, source)} -> ${path.relative(root, target)}`);
}
