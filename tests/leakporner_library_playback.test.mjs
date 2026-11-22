import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const player = readFileSync(new URL('../app/static/main.js', import.meta.url), 'utf8');
const template = readFileSync(new URL('../app/templates/index.html', import.meta.url), 'utf8');

test('LeakPorner library playback refreshes every imported page before generic resolution', () => {
  const jit = player.indexOf('Resolving fresh LeakPorner playback source');
  const generic = player.indexOf('Refreshing stream from stable source page');

  assert.ok(jit >= 0, 'library player needs a dedicated LeakPorner JIT path');
  assert.ok(generic >= 0, 'expected generic resolver was not found');
  assert.ok(jit < generic, 'LeakPorner JIT must run before the generic resolver can reuse a stale token');
  assert.match(player, /sourceUrlLower\.includes\('leakporner\.'\)/);
  assert.match(player, /sourceUrlLower\.includes\('mypornerleak\.'\)/);
});

test('LeakPorner tnmr HLS manifests stay on the referer-aware proxy route', () => {
  assert.match(player, /videoUrlLower\.includes\('tnmr\.org'\)/);
  assert.match(player, /\/hls_proxy\?url=\$\{encodeURIComponent\(resolved\)\}.*referer=/);
  assert.match(player, /const resolvedIsHls = !!jitData\.is_hls/);
  const iframeHelper = player.slice(player.indexOf('isHornySimpIframeVideo(video)'), player.indexOf('isPornCreamVideo(video)'));
  assert.doesNotMatch(iframeHelper, /tnmr\.org/, 'tnmr manifests must not be rendered as iframe embeds');
});

test('dashboard loads a cache-busted player bundle after the playback fix', () => {
  assert.match(template, /main\.min\.js\?v=[^"']+/);
});
