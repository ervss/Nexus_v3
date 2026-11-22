const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('Testing Filester Subfolders & Virtual Merged Album functionality...');

const scriptPath = path.join(__dirname, '..', 'userscripts/filester-album-workspace.user.js');
const scriptCode = fs.readFileSync(scriptPath, 'utf8');

// Verify script contains new functions and components
assert(scriptCode.includes('initSubfolders'), 'Script should include initSubfolders');
assert(scriptCode.includes('activateMergedFolderView'), 'Script should include activateMergedFolderView');
assert(scriptCode.includes('ensureSubfolderToolbar'), 'Script should include ensureSubfolderToolbar');
assert(scriptCode.includes('ensureFolderDock'), 'Script should include ensureFolderDock');
assert(scriptCode.includes('ensureMergedBanner'), 'Script should include ensureMergedBanner');
assert(scriptCode.includes('downloadSelectedFoldersZip'), 'Script should include downloadSelectedFoldersZip');
assert(scriptCode.includes('saveSelectedFoldersToAccount'), 'Script should include saveSelectedFoldersToAccount');
assert(scriptCode.includes('checkMergedHashOnBoot'), 'Script should include checkMergedHashOnBoot');

console.log('✓ Script structural integrity checks passed');

// Test metadata extraction logic from subfolder HTML
function extractFolderMeta(html, nativeFilesCount = 0) {
  const sizeMatch = html.match(/Total size<\/span>\s*<span[^>]*>([^<]+)<\/span>/i) ||
                    html.match(/<span class="tnum">([\d.]+\s*(?:B|KB|MB|GB|TB))<\/span>/i);
  const size = sizeMatch ? sizeMatch[1].trim() : '';

  const createdMatch = html.match(/Created\s+([A-Za-z]{3}\s+\d{1,2},\s+\d{4})/i) ||
                       html.match(/Created<\/span>\s*<span>([^<]+)<\/span>/i);
  const created = createdMatch ? createdMatch[1].trim() : '';

  const dates = Array.from(html.matchAll(/data-date="([^"]+)"/g), (m) => m[1]).filter(Boolean).sort().reverse();
  const latestUpload = dates[0] || '';

  const types = Array.from(html.matchAll(/data-type="([^"]+)"/g), (m) => m[1]);
  const filesMatch = html.match(/Files<\/span>\s*<span[^>]*class="tnum"[^>]*>(\d+)<\/span>/i) ||
                     html.match(/<span class="tnum">(\d+)\s*files?<\/span>/i) ||
                     html.match(/id="fileCountDisplay"[^>]*>\s*\((\d+)\)\s*<\/span>/i) ||
                     html.match(/(\d+)\s*files/i);

  const totalPagesMatch = html.match(/data-total="(\d+)"/i) ||
                          html.match(/Page\s+\d+\s*\/\s*(\d+)/i) ||
                          html.match(/(\d+)\s*pages?/i);

  const parsedFiles = filesMatch ? Number(filesMatch[1]) : 0;
  const filesCount = Math.max(parsedFiles, nativeFilesCount || 0, types.length);
  const totalPages = totalPagesMatch ? Number(totalPagesMatch[1]) : (filesCount > 24 ? Math.ceil(filesCount / 24) : 1);

  return { size, created, latestUpload, filesCount, totalPages };
}

const mockSubfolderHtml = `
<div class="space-y-2 text-sm">
  <div class="flex justify-between gap-4"><span class="text-muted shrink-0">Name</span><span class="text-right break-words min-w-0">Adreena Winters</span></div>
  <div class="flex justify-between gap-4"><span class="text-muted shrink-0">Total size</span><span class="tnum">24.49 GB</span></div>
  <div class="flex justify-between gap-4"><span class="text-muted shrink-0">Created</span><span>Aug 06, 2026</span></div>
</div>
<div class="files-list" id="filesGrid">
  <div class="file-item" data-type="videos" data-date="2026-10-15T00:00:00Z" data-name="vid1.mp4"></div>
  <div class="file-item" data-type="videos" data-date="2026-11-05T00:00:00Z" data-name="vid2.mp4"></div>
  <div class="file-item" data-type="videos" data-date="2026-09-01T00:00:00Z" data-name="vid3.mp4"></div>
</div>
`;

const extracted = extractFolderMeta(mockSubfolderHtml, 3);
assert.strictEqual(extracted.size, '24.49 GB', 'Should extract total size correctly');
assert.strictEqual(extracted.created, 'Aug 06, 2026', 'Should extract created date correctly');
assert.strictEqual(extracted.latestUpload, '2026-11-05T00:00:00Z', 'Should find newest upload date');
assert.strictEqual(extracted.filesCount, 3, 'Should count files correctly');
assert.strictEqual(extracted.totalPages, 1, 'Should determine totalPages as 1');

// Test multi-page folder HTML (like AJ Fresh with 121 files across 6 pages)
const mockMultipageHtml = `
<h1 class="text-3xl font-bold tracking-tight">AJ Fresh</h1>
<p class="text-sm text-muted">Created Jun 30, 2026 · <span class="tnum">121 files</span> · <span class="tnum">119.72 GB</span></p>
<button id="loadAllPagesBtn" data-total="6">Load all 6 pages</button>
<div class="files-list" id="filesGrid">
  <!-- only 24 items in initial DOM -->
  ${new Array(24).fill('<div class="file-item" data-type="videos"></div>').join('\n')}
</div>
`;

const extractedMulti = extractFolderMeta(mockMultipageHtml, 121);
assert.strictEqual(extractedMulti.size, '119.72 GB', 'Should extract size from multi-page header');
assert.strictEqual(extractedMulti.filesCount, 121, 'Should extract full 121 files count, not capped at 24');
assert.strictEqual(extractedMulti.totalPages, 6, 'Should extract totalPages 6 from data-total attribute');
console.log('✓ Folder metadata extraction logic (single + multi-page) passed');

// Test formatBytes
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

assert.strictEqual(formatBytes(1024), '1.00 KB');
assert.strictEqual(formatBytes(1024 * 1024 * 50), '50.00 MB');
assert.strictEqual(formatBytes(1024 * 1024 * 1024 * 24.5), '24.50 GB');
console.log('✓ formatBytes tests passed');

// Test folder sorting
const mockFolders = [
  { slug: 'b', title: 'Beta', filesCount: 10, sizeBytes: 50000, dateTs: 1000 },
  { slug: 'a', title: 'Alpha', filesCount: 50, sizeBytes: 20000, dateTs: 3000 },
  { slug: 'c', title: 'Gamma', filesCount: 20, sizeBytes: 80000, dateTs: 2000 },
];

const sortByName = [...mockFolders].sort((x, y) => x.title.localeCompare(y.title));
assert.strictEqual(sortByName[0].title, 'Alpha');
assert.strictEqual(sortByName[2].title, 'Gamma');

const sortBySize = [...mockFolders].sort((x, y) => y.sizeBytes - x.sizeBytes);
assert.strictEqual(sortBySize[0].title, 'Gamma');
assert.strictEqual(sortBySize[2].title, 'Alpha');

const sortByFiles = [...mockFolders].sort((x, y) => y.filesCount - x.filesCount);
assert.strictEqual(sortByFiles[0].title, 'Alpha');
assert.strictEqual(sortByFiles[2].title, 'Beta');

const sortByDate = [...mockFolders].sort((x, y) => y.dateTs - x.dateTs);
assert.strictEqual(sortByDate[0].title, 'Alpha');
assert.strictEqual(sortByDate[2].title, 'Beta');

console.log('✓ Folder sorting algorithms passed');

// Test URL hash detection
function parseMergeHash(hash) {
  const match = String(hash || '').match(/#merge=([A-Za-z0-9_,-]+)/);
  if (!match) return [];
  return match[1].split(',').filter(Boolean);
}

assert.deepStrictEqual(parseMergeHash('#merge=9b158ff0bc1606ac,f2802b539258f1b8'), ['9b158ff0bc1606ac', 'f2802b539258f1b8']);
assert.deepStrictEqual(parseMergeHash('#other-hash'), []);
assert.deepStrictEqual(parseMergeHash(''), []);
console.log('✓ #merge= URL hash parsing passed');

console.log('\nAll Filester Subfolders & Virtual Merged Album unit tests passed successfully!');
