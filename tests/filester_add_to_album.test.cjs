const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('userscripts/filester-album-workspace.user.js', 'utf8');

// Extract the functions loadUserAlbums, promptTargetAlbum, addSelectedToAlbum
const block = source.slice(
  source.indexOf('  async function loadUserAlbums()'),
  source.indexOf('  async function copySelectedUrls()')
);

async function runTests() {
  console.log('Testing Filester Add to Album functionality...');

  // Test 1: loadUserAlbums parses folder response correctly
  {
    const context = vm.createContext({
      console,
      albumModal: null,
      PREFIX: 'test',
      async fetch(url) {
        if (url === '/api/user/folders') {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                folders: [
                  { id: 50014, identifier: 'ident_bimbos', name: 'bimbos', path: 'bimbos' },
                  { id: 71848, identifier: 'ident_nov26', name: 'NOV_26', path: 'NOV_26' }
                ],
                success: true
              };
            }
          };
        }
        return { ok: false, status: 404 };
      }
    });

    vm.runInContext(block, context);
    const res = await context.loadUserAlbums();
    assert.equal(res.unauthenticated, false);
    assert.equal(res.folders.length, 2);
    assert.equal(res.folders[0].identifier, 'ident_bimbos');
    console.log('✓ loadUserAlbums test passed');
  }

  // Test 2: addSelectedToAlbum on /f/* handles both new file and "already have" with move
  {
    const savedCalls = [];
    const moveCalls = [];
    let progressCalls = [];
    let toastMsg = '';

    const context = vm.createContext({
      console,
      albumModal: null,
      PREFIX: 'test',
      window: { setTimeout: (fn) => fn() },
      items: [
        { url: 'https://filester.me/d/file1', slug: 'file1', title: 'Video 1' },
        { url: 'https://filester.me/d/file2', slug: 'file2', title: 'Video 2' }
      ],
      selected: new Set(['https://filester.me/d/file1', 'https://filester.me/d/file2']),
      isManagerPage: () => false,
      _t: (sk) => sk,
      toast: (msg) => { toastMsg = msg; },
      setProgress: (pct, text) => { progressCalls.push({ pct, text }); },
      async fetch(url, options) {
        if (url === '/api/file/save') {
          const body = JSON.parse(options.body);
          savedCalls.push(body);
          if (body.slug === 'file1') {
            return { ok: true, status: 200, async json() { return { success: true, slug: 'file1' }; } };
          }
          if (body.slug === 'file2') {
            return {
              ok: true,
              status: 200,
              async json() {
                return { success: false, message: 'You already have this file in your account', slug: 'account_file2' };
              }
            };
          }
        }
        if (url === '/api/files/move') {
          const body = JSON.parse(options.body);
          moveCalls.push(body);
          return { ok: true, status: 200, async json() { return { success: true, successful: 1, failed: 0 }; } };
        }
        return { ok: false, status: 404 };
      }
    });

    vm.runInContext(block, context);
    // Override promptTargetAlbum after running the block
    context.promptTargetAlbum = async () => ({
      isRoot: false,
      identifier: 'ident_nov26',
      numericId: 71848,
      name: 'NOV_26'
    });

    await context.addSelectedToAlbum();

    assert.equal(savedCalls.length, 2);
    assert.equal(savedCalls[0].slug, 'file1');
    assert.equal(savedCalls[0].folder_id, 71848);
    assert.equal(savedCalls[1].slug, 'file2');
    assert.equal(savedCalls[1].folder_id, 71848);

    // file2 already in account, should have triggered move to destination album
    assert.equal(moveCalls.length, 1);
    assert.deepEqual(moveCalls[0].fileIds, ['account_file2']);
    assert.equal(moveCalls[0].folder, 'ident_nov26');

    assert.match(toastMsg, /Hotovo: 2 pridaných do "NOV_26"/);
    console.log('✓ addSelectedToAlbum on /f/* (with auto-move for existing files) passed');
  }

  // Test 3: addSelectedToAlbum in Manager uses /api/files/move
  {
    const moveCalls = [];
    let toastMsg = '';

    const context = vm.createContext({
      console,
      albumModal: null,
      PREFIX: 'test',
      window: { setTimeout: (fn) => fn(), loadManager: () => {} },
      items: [
        { url: 'https://filester.me/d/fA', slug: 'fA', title: 'File A' },
        { url: 'https://filester.me/d/fB', slug: 'fB', title: 'File B' }
      ],
      selected: new Set(['https://filester.me/d/fA', 'https://filester.me/d/fB']),
      isManagerPage: () => true,
      _t: (sk) => sk,
      toast: (msg) => { toastMsg = msg; },
      setProgress: () => {},
      async fetch(url, options) {
        if (url === '/api/files/move') {
          const body = JSON.parse(options.body);
          moveCalls.push(body);
          return { ok: true, status: 200, async json() { return { success: true, successful: 2, failed: 0 }; } };
        }
        throw new Error('Unexpected URL: ' + url);
      }
    });

    vm.runInContext(block, context);
    context.promptTargetAlbum = async () => ({
      isRoot: false,
      identifier: 'ident_bimbos',
      numericId: 50014,
      name: 'bimbos'
    });

    await context.addSelectedToAlbum();

    assert.equal(moveCalls.length, 1);
    assert.deepEqual(moveCalls[0].fileIds, ['fA', 'fB']);
    assert.equal(moveCalls[0].folder, 'ident_bimbos');
    assert.match(toastMsg, /Hotovo: 2 presunutých do "bimbos"/);
    console.log('✓ addSelectedToAlbum in Manager bulk move passed');
  }

  console.log('\nAll Filester Add to Album unit tests passed successfully!');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
