import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(resolve(root, "vendor"), { recursive: true });
await copyFile(resolve(root, "node_modules/hls.js/dist/hls.min.js"), resolve(root, "vendor/hls.min.js"));
console.log("Bundled hls.js into vendor/hls.min.js");
