const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

console.log('Testing Filester Page Range & findTotalPages functionality...');

const source = fs.readFileSync('userscripts/filester-album-workspace.user.js', 'utf8');

// Verify new functions are present in script
assert(source.includes('function findTotalPages()'), 'Script should include findTotalPages');
assert(source.includes('function extractCardSlug('), 'Script should include extractCardSlug');
assert(source.includes('async function loadPagesWorkflow('), 'Script should include loadPagesWorkflow');
assert(source.includes('data-role="pageFrom"'), 'Script should include pageFrom input');
assert(source.includes('data-role="pageTo"'), 'Script should include pageTo input');
assert(source.includes('data-action="loadPageRange"'), 'Script should include loadPageRange action');

// Test findTotalPages logic in isolated VM
{
  const totalPagesCode = source.slice(
    source.indexOf('  function findTotalPages()'),
    source.indexOf('  function extractCardSlug(')
  );

  // Case 1: #loadAllPagesBtn with data-total
  const context1 = vm.createContext({
    document: {
      querySelector(sel) {
        if (sel === '#loadAllPagesBtn') {
          return { getAttribute: (attr) => attr === 'data-total' ? '8' : null };
        }
        return null;
      },
      querySelectorAll() { return []; }
    },
    location: { origin: 'https://filester.me' }
  });
  vm.runInContext(totalPagesCode, context1);
  assert.equal(context1.findTotalPages(), 8, 'Should extract total pages from #loadAllPagesBtn data-total');

  // Case 2: pagination links
  const context2 = vm.createContext({
    document: {
      querySelector() { return null; },
      querySelectorAll(sel) {
        if (sel.includes('.pagination')) {
          return [
            { textContent: '1', getAttribute: () => '/f/album?page=1' },
            { textContent: '2', getAttribute: () => '/f/album?page=2' },
            { textContent: '5', getAttribute: () => '/f/album?page=5' }
          ];
        }
        return [];
      }
    },
    URL,
    location: { origin: 'https://filester.me' }
  });
  vm.runInContext(totalPagesCode, context2);
  assert.equal(context2.findTotalPages(), 5, 'Should extract max page number from pagination links');

  // Case 3: fallback when no pagination
  const context3 = vm.createContext({
    document: {
      querySelector() { return null; },
      querySelectorAll() { return []; }
    },
    location: { origin: 'https://filester.me' }
  });
  vm.runInContext(totalPagesCode, context3);
  assert.equal(context3.findTotalPages(), 1, 'Should default to 1 when no pagination is present');
}

// Test extractCardSlug logic
{
  const extractCode = source.slice(
    source.indexOf('  function extractCardSlug('),
    source.indexOf('  async function loadPagesWorkflow(')
  );

  const context = vm.createContext({});
  vm.runInContext(extractCode, context);

  assert.equal(context.extractCardSlug({ dataset: { fileSlug: 'slug123' } }), 'slug123');
  assert.equal(context.extractCardSlug({ dataset: { slug: 'slug456' } }), 'slug456');
  assert.equal(context.extractCardSlug({
    dataset: {},
    getAttribute: (attr) => attr === 'onclick' ? "window.location='/d/slugClick789'" : null
  }), 'slugClick789');
  assert.equal(context.extractCardSlug({
    dataset: {},
    querySelector: (sel) => sel.includes('/d/') ? { getAttribute: () => '/d/slugLink101' } : null
  }), 'slugLink101');
}

// Test loadPagesWorkflow page range bounding & execution in manager mode
(async () => {
  const codeSlice = source.slice(
    source.indexOf('  function findTotalPages()'),
    source.indexOf('  function runAction(action) {')
  );

  const requestedPages = [];
  const addedCards = [];
  let refreshCount = 0;
  let progressText = '';

  const mockGrid = {
    isConnected: true,
    append(card) { addedCards.push(card); }
  };

  const mockToolbar = {
    querySelector(sel) {
      if (sel.includes('loadAllPages')) return { disabled: false };
      if (sel.includes('loadPageRange')) return { disabled: false };
      if (sel.includes('stopAllPages')) return { hidden: true };
      if (sel.includes('pageProgress')) {
        return {
          set textContent(v) { progressText = v; },
          get textContent() { return progressText; }
        };
      }
      if (sel.includes('pageFrom')) return { value: '2' };
      if (sel.includes('pageTo')) return { value: '3' };
      return null;
    }
  };

  const context = vm.createContext({
    allPagesAbort: null,
    isManagerPage: () => true,
    location: { href: 'https://filester.me/manager', pathname: '/manager', origin: 'https://filester.me' },
    grid: mockGrid,
    items: [],
    toast: (msg) => console.log('Toast:', msg),
    refresh: () => { refreshCount++; },
    scheduleDashboardCheck: () => {},
    connection: 'offline',
    URLSearchParams,
    URL,
    AbortController,
    encodeURIComponent,
    Number,
    String,
    Array,
    Set,
    Math,
    document: {
      querySelector(sel) {
        if (sel === '#loadAllPagesBtn') return null;
        if (sel === '#folderSortSelect' || sel === '#fileSortSelect') return { value: 'newest' };
        return null;
      },
      querySelectorAll() { return []; },
      createElement(tag) { return { dataset: {}, append() {} }; }
    },
    async fetch(url) {
      const u = new URL(url, 'https://filester.me');
      const page = parseInt(u.searchParams.get('files_page'), 10);
      requestedPages.push(page);
      return {
        ok: true,
        async json() {
          return {
            files: [
              { Slug: `file-p${page}-1`, OriginalName: `File P${page}-1.mp4`, Size: 1000 }
            ],
            filePage: page,
            filePages: 5
          };
        }
      };
    }
  });

  vm.runInContext(codeSlice, context);

  // Run range: from 2 to 3
  await context.loadPagesWorkflow(mockToolbar, { fromPage: 2, toPage: 3 });

  assert.deepEqual(requestedPages, [2, 3], 'Should only request pages 2 and 3');
  assert.equal(addedCards.length, 2, 'Should add 2 cards from pages 2 and 3');
  assert.equal(refreshCount, 2, 'Should call refresh after each page');
  assert.match(progressText, /Hotovo · pridaných 2/, 'Should report completion in progress label');

  console.log('✓ Page range manager request bounding passed');
  console.log('All Filester Page Range tests passed successfully!');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
