import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const testDir = path.resolve('tests');
const entries = await readdir(testDir, { withFileTypes: true });
const standaloneHelpers = new Set([
  'nexus_deck_preview.cjs',
  'turbo_direct_live.cjs',
]);
const tests = entries
  // Keep fixture servers and standalone preview helpers out of the test
  // process: they intentionally listen forever for a browser test to use.
  .filter((entry) => entry.isFile()
    && /\.(?:mjs|cjs)$/.test(entry.name)
    && !/(?:^|[_-])fixture\.(?:mjs|cjs)$/i.test(entry.name)
    && !standaloneHelpers.has(entry.name))
  .map((entry) => path.join(testDir, entry.name))
  .sort();

if (!tests.length) {
  console.error('No JavaScript tests found.');
  process.exit(1);
}

const child = spawn(process.execPath, ['--test', ...tests], {
  stdio: 'inherit',
  windowsHide: true,
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) console.error(`JavaScript tests terminated by ${signal}`);
  process.exit(code ?? 1);
});
