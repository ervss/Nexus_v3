// Opt-in read-only live diagnostic; not part of the offline test suite.
const fs = require('node:fs'), vm = require('node:vm');
const ctx = { fetch, URL, DataView, Uint8Array, TextDecoder, AbortSignal, AbortController, setTimeout, clearTimeout,
  chrome: { runtime: { onMessage: { addListener() {} } } } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('extensions/nexus-video-selector/background.js', 'utf8'), ctx);
vm.runInContext("turboDirectMetadata('Ik_7v-VqO-c', AbortSignal.timeout(20000))", ctx).then(result => {
  console.log(JSON.stringify(result));
  if (!(result.duration > 0 && result.width > 0 && result.height > 0 && result.size_bytes > 0)) process.exitCode = 1;
}).catch(err => { console.error(err.message); process.exitCode = 1; });
