import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('app/static/main.js', 'utf8');
const start = source.indexOf('    const cleanupText =');
const end = source.indexOf('    let activeEl =', start);
const resolve = vm.runInNewContext(`(() => {${source.slice(start, end)} return inferHelpText; })()`);
const element = (attrs = {}, text = '') => ({
    dataset: {}, attributes: Object.entries(attrs).map(([name, value]) => ({name, value})),
    getAttribute: name => attrs[name] || '',
    cloneNode: () => ({textContent: text, querySelectorAll: () => []}),
});

// A browse title mentioning import must retain its actual explanation.
const browseTitle = 'Otvorí súbory albumu. Import spustíš samostatne.';
assert.equal(resolve(element({title: browseTitle, '@click.stop':'openAlbumViewer(item)'})), browseTitle);
assert.match(resolve(element({'@click.stop':'openAlbumViewer(item)'})), /Otvorí obsah albumu/);
assert.match(resolve(element({'@click.stop':'discoveryHubImport(item)'})), /Spustí import/);
assert.match(resolve(element({'@click.stop':'albumViewerRefetchOne(file)'})), /trvanie, rozlíšenie a veľkosť/);
assert.equal(resolve(element({'@click':'unrecognizedAction()'}, 'Import preview')), 'Import preview');
const template = fs.readFileSync('app/templates/index.html', 'utf8').replace(
    /\{%\s*include\s+"([^"]+)"\s*%\}/g,
    (_, rel) => fs.readFileSync(`app/templates/${rel}`, 'utf8')
);
assert.match(template, /@click\.stop="albumViewerRefetchOne\(file\)" :disabled="!!file\._refetching"/);
console.log('Dashboard action descriptions: passed');
