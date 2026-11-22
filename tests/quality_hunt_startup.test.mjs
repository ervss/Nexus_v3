import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../extensions/Nexus_Gallery/universal_importer.js', import.meta.url), 'utf8');

test('iframe metadata without DOM methods falls back to the page title', () => {
    const context = vm.createContext({ isGofilePage: () => false, document: {
        querySelector: selector => selector === 'meta[property="og:title"]' ? { content: 'Original clip title' } : null,
        querySelectorAll: () => [], title: 'Document title',
    } });
    vm.runInContext(source.slice(source.indexOf('    function collectBestTitle('), source.indexOf('    function captureVideoFrameJpeg(')), context);
    assert.equal(context.collectBestTitle({ currentSrc: 'https://example.test/video.mp4', duration: 120 }), 'Original clip title');
    assert.equal(context.collectBestTitle({ getAttribute: name => name === 'data-title' ? 'Local video title' : null }), 'Local video title');
});

test('startup failures release the busy state and allow another attempt', async () => {
    const status = { textContent: '' };
    let renders = 0;
    const context = vm.createContext({
        runQualityHunt: async container => { container._huntRunning = true; throw new Error('startup failed'); },
        closeHuntBusy: container => { container._huntRunning = false; },
        renderHuntModalList: () => { renders++; },
    });
    vm.runInContext(source.slice(source.indexOf('    async function startQualityHunt('), source.indexOf('    async function runQualityHunt(')), context);
    const container = { querySelector: () => status };
    await assert.rejects(context.startQualityHunt(container), /startup failed/);
    assert.equal(container._huntRunning, false);
    assert.equal(status.textContent, 'Chyba: startup failed');
    await assert.rejects(context.startQualityHunt(container), /startup failed/);
    assert.equal(renders, 2);
});
