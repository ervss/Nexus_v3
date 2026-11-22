import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
const out = 'app/static/video-enhancer';
await mkdir(`${out}/weights`, { recursive: true });
for (const size of ['s', 'm', 'l']) for (const content of ['rl', 'an', '3d']) {
  await cp(`node_modules/@websr/websr/weights/anime4k/cnn-2x-${size}-${content}.json`, `${out}/weights/cnn-2x-${size}-${content}.json`);
}
for (const entry of ['bootstrap', 'enhancer.worker', 'export.worker']) {
  await build({ entryPoints: [`${out}/${entry}.js`], outfile: `${out}/${entry}.bundle.js`, bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', minify: true });
}
