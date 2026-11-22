import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const scripts = ['userscripts/bunkr-albums-enhanced.user.js', 'userscripts/bunkr-suite.user.js'];

for (const filename of scripts) {
  const source = fs.readFileSync(path.join(root, filename), 'utf8');

  assert.match(source, /class="bae-discovery-hero"/, `${filename}: discovery hero is missing`);
  assert.match(source, /Search fetched videos and album titles/, `${filename}: prominent search copy is missing`);
  assert.match(source, /grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/, `${filename}: desktop gallery is not six columns`);
  assert.match(source, /Fetched video library/, `${filename}: fetched videos are not shown as a library`);
  assert.match(source, /total videos/, `${filename}: total and keyword-match counts are missing`);
  assert.match(source, /Open as combined album/, `${filename}: combined album action is missing`);
  assert.doesNotMatch(source, /Search inside results/, `${filename}: duplicate results search should not remain`);
  assert.match(source, /Search fetched library/, `${filename}: explicit search submit button is missing`);
  assert.match(source, /submitGlobalSearch/, `${filename}: search submit handler is missing`);
  assert.doesNotMatch(source, /globalFilter\.addEventListener\('input'/, `${filename}: hero search still filters on every keypress`);
  assert.match(source, /setLibraryDrawerCollapsed/, `${filename}: fetched library drawer handler is missing`);
  assert.match(source, /Hide gallery/, `${filename}: fetched library collapse action is missing`);
  assert.match(source, /Show gallery/, `${filename}: fetched library expand action is missing`);
  assert.match(source, /Import selected/, `${filename}: selected-result import action is missing`);
  assert.match(source, /Select .* for import/, `${filename}: each result needs selectable import state`);
  assert.match(source, /Import this video into Nexus/, `${filename}: each result needs an import action`);
  assert.match(source, /Search combined fetched album/, `${filename}: combined view needs its own search`);
  assert.match(source, /globalFileRenderChunk: 48/, `${filename}: large libraries need chunked rendering`);
  assert.match(source, /appendNextChunk/, `${filename}: gallery must append result cards incrementally`);
  assert.match(source, /concurrentAlbumFetches: 5/, `${filename}: album fetching should use the faster bounded concurrency`);
  assert.match(source, /concurrentAlbumPageFetches: 3/, `${filename}: album-page requests need bounded parallelism`);
  assert.match(source, /Index album and video titles first/, `${filename}: the title-index workflow must be explained`);
  assert.match(source, /Fetch preview and page details for this video only/, `${filename}: video details must stay lazy`);
  assert.match(source, /fetchFileDetails/, `${filename}: individual detail fetching is missing`);
  assert.match(source, /Select all \(\$\{rows\.length\}\)/, `${filename}: result selection needs Select all`);
  assert.match(source, /Fetch selected/, `${filename}: result selection needs batch detail fetch`);
  assert.match(source, /Fetch all details/, `${filename}: result selection needs fetch-all details`);
  assert.match(source, /fetchFetchedVideoDetails/, `${filename}: batch detail fetching is missing`);
  assert.match(source, /Longest duration/, `${filename}: duration sorting is missing`);
  assert.match(source, /maxGlobalFileRows: 0/, `${filename}: all-results mode is not enabled`);
  assert.match(source, /fetchDocumentWithRetry/, `${filename}: retrying fetch helper is missing`);
  assert.match(source, /failed after retries/, `${filename}: partial batch failure summary is missing`);
  assert.match(source, /function fetchTextCrossOrigin/, `${filename}: player needs a cross-origin fallback fetcher`);
  assert.match(source, /\/api\/sign\?v=/, `${filename}: player needs the signed-stream fallback`);
  assert.match(source, /Unable to resolve a playable stream/, `${filename}: player must reject an HTML landing page`);
  assert.match(source, /bae-player-iframe/, `${filename}: player needs a native Bunkr fallback`);
  assert.match(source, /switchToNativePlayer/, `${filename}: CDN failures must fall back to the native player`);
  assert.doesNotMatch(source, /return filePageUrl;\s*\n\s*}\s*\n\s*\/\/ Helper function to parse Bunkr date/, `${filename}: player must not pass a Bunkr HTML page to the video element`);
  assert.doesNotMatch(source, /compareABtn|compareBBtn/, `${filename}: comparison controls remain in the gallery`);
  assert.doesNotMatch(source, /class="bae-layout-toggle"/, `${filename}: obsolete list/grid toggle remains`);
}

console.log(`Balbums fetched-library contracts passed for ${scripts.length} scripts.`);
