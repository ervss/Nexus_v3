const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('userscripts/filester-album-workspace.user.js', 'utf8');
const functions = source.slice(source.indexOf('  function isManagerPage()'), source.indexOf('  function loadObject('));
const matches = [...source.matchAll(/^\/\/ @match\s+(\S+)/gm)].map(match => match[1]);
function matched(url) {
  return matches.some(pattern => new RegExp('^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(url));
}

async function check(folder, files) {
  let mounted = null;
  let boots = 0;
  let requests = 0;
  const context = vm.createContext({
    URLSearchParams, Date, console,
    PREFIX: 'test', managerLoading: false, grid: null,
    location: { origin: 'https://filester.me', pathname: '/manager', search: folder ? `?folder=${folder}` : '' },
    document: {
      querySelector(selector) {
        if (selector.includes('.nfw-manager-grid')) return mounted;
        if (selector === 'main, .main-content, #app') return { appendChild(element) { mounted = element; } };
        return null;
      },
      createElement() { return {}; },
    },
    async fetch(url, options) {
      requests += 1;
      assert.equal(new URL(url, 'https://filester.me').searchParams.get('folder'), folder);
      assert.equal(options.credentials, 'include');
      return { ok: true, async json() { return { files }; } };
    },
    escapeHtml: value => String(value),
    boot() { boots += 1; assert.equal(context.findFileGrid(), mounted); },
  });
  vm.runInContext(functions, context);
  assert.equal(context.isManagerPage(), true);
  await context.loadManagerGrid();
  assert.equal(requests, 1);
  assert.equal(boots, 1, 'Fallback grid must be found even when empty');
  assert.equal(context.managerLoading, false);
  if (files.length) assert.match(mounted.innerHTML, /\/d\/example/);
  return context.albumStorageKey('selected');
}

(async () => {
  // Real manager cards use a UUID for file-id and a separate public file-slug.
  const cardContext = vm.createContext({
    URL, location: { origin: 'https://filester.me' }, metadata: {},
    parseSizeBytes: value => value === '1.05 MB' ? 1101005 : 0,
    parseUploadTime: () => 0, guessHeight: () => 0,
  });
  vm.runInContext(source.slice(source.indexOf('  function readCard('), source.indexOf('  function injectCardTools(')), cardContext);
  const nativeCard = cardContext.readCard({
    dataset: { fileId: 'private-uuid', fileSlug: 'publicSlug' },
    getAttribute: () => null,
    querySelector(selector) {
      if (selector === '.file-name, .filename, [data-file-name]') return { textContent: 'Example.mp4' };
      if (selector === '.file-size') return { textContent: '1.05 MB' };
      return null;
    },
  }, 0);
  assert.equal(nativeCard.url, 'https://filester.me/d/publicSlug');
  assert.equal(nativeCard.sizeBytes, 1101005);
  for (const host of ['filester.me', 'filester.gg', 'www.filester.me', 'www.filester.gg']) {
    for (const path of ['/manager', '/manager?folder=433b11c25c2a5fd5', '/manager/?folder=abc', '/f/album']) {
      assert.ok(matched(`https://${host}${path}`), `No userscript match for ${host}${path}`);
    }
    assert.equal(matched(`https://${host}/managerial`), false);
  }
  const folderKey = await check('433b11c25c2a5fd5', [{ Slug: 'example', OriginalName: 'Example.mp4' }]);
  const emptyFolderKey = await check('empty-folder', []);
  const rootKey = await check(null, []);
  assert.notEqual(folderKey, emptyFolderKey);
  assert.notEqual(folderKey, rootKey);
  console.log('Filester manager URL matching, folder requests, populated/empty fallback and selection isolation passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
