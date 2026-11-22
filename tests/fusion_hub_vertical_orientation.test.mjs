import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app/static/modules/eporner_hub.js', import.meta.url), 'utf8');

function harness() {
    let lastFetch = null;
    const fetches = [];
    const context = vm.createContext({
        URL,
        URLSearchParams,
        AbortController,
        setTimeout,
        clearTimeout,
        console,
        fetch: async (url, opts) => {
            lastFetch = { url, opts };
            fetches.push(lastFetch);
            if (url.includes('/api/v1/search/orientation')) {
                const body = JSON.parse(opts.body || '{}');
                const orientation = {};
                for (const u of body.urls || []) {
                    if (u.includes('vertical_site')) {
                        orientation[u] = { width: 720, height: 1280, orientation: 'portrait', orientation_evidence: 'page_dimensions' };
                    } else if (u.includes('horizontal_site')) {
                        orientation[u] = { width: 1920, height: 1080, orientation: 'landscape', orientation_evidence: 'page_dimensions' };
                    }
                }
                return { ok: true, json: async () => ({ orientation, count: Object.keys(orientation).length }) };
            }
            return { ok: true, json: async () => ({ items: [] }) };
        },
        document: {
            querySelector: () => null,
            querySelectorAll: () => [],
        },
        window: {},
    });
    vm.runInContext(source, context);
    const mod = context.createEpornerHubModule();
    mod.showToast = () => {};
    mod.ephMedia = (url) => url || '/static/placeholder.jpg';
    mod.ephRadarCheck = () => {};
    mod.ephScheduleAutoFetch = () => {};
    return { mod, context, getLastFetch: () => lastFetch, getFetches: () => fetches };
}

test('ephVideoOrientation correctly classifies dimensions, declared metadata, and aspect ratio', () => {
    const { mod } = harness();

    // 1. Video dimensions
    const portraitDim = mod.ephVideoOrientation({ width: 720, height: 1280 });
    assert.equal(portraitDim.orientation, 'portrait');
    assert.equal(portraitDim.evidence, 'video_dimensions');

    const landscapeDim = mod.ephVideoOrientation({ width: 1920, height: 1080 });
    assert.equal(landscapeDim.orientation, 'landscape');
    assert.equal(landscapeDim.evidence, 'video_dimensions');

    // 2. Declared metadata
    const declaredVert = mod.ephVideoOrientation({ orientation: 'vertical', orientation_evidence: 'source_metadata' });
    assert.equal(declaredVert.orientation, 'portrait');
    assert.equal(declaredVert.evidence, 'source_metadata');

    const declaredHoriz = mod.ephVideoOrientation({ orientation: 'horizontal' });
    assert.equal(declaredHoriz.orientation, 'landscape');

    // 3. Aspect ratio
    const ratioPort = mod.ephVideoOrientation({ aspect_ratio: 0.5625 });
    assert.equal(ratioPort.orientation, 'portrait');
    assert.equal(ratioPort.evidence, 'aspect_ratio');

    // 4. Missing / unknown
    const unknown = mod.ephVideoOrientation({});
    assert.equal(unknown.orientation, 'unknown');
    assert.equal(unknown.evidence, 'unknown');
});

test('ephHasPortraitThumbnailEstimate detects portrait thumbnail ratio >= 1.1', () => {
    const { mod } = harness();
    assert.equal(mod.ephHasPortraitThumbnailEstimate({ thumbnail_width: 400, thumbnail_height: 600 }), true);
    assert.equal(mod.ephHasPortraitThumbnailEstimate({ thumbnail_width: 1000, thumbnail_height: 1050 }), false);
    assert.equal(mod.ephHasPortraitThumbnailEstimate({ thumb_width: 720, thumb_height: 1280 }), true);
    assert.equal(mod.ephHasPortraitThumbnailEstimate({ thumbnail_width: 1280, thumbnail_height: 720 }), false);
    assert.equal(mod.ephHasPortraitThumbnailEstimate({}), false);
});

test('ephIsTextHintPortrait recognizes vertical keywords in title, tags, or url', () => {
    const { mod } = harness();
    assert.equal(mod.ephIsTextHintPortrait({ title: 'Amazing tiktok dance' }), true);
    assert.equal(mod.ephIsTextHintPortrait({ tags: ['vertical clip', 'amateur'] }), true);
    assert.equal(mod.ephIsTextHintPortrait({ url: 'https://example.com/video/vertical-show-123' }), true);
    assert.equal(mod.ephIsTextHintPortrait({ orientation_likely: 'portrait' }), true);
    assert.equal(mod.ephIsTextHintPortrait({ title: 'Regular landscape movie', tags: ['hd'] }), false);
});

test('ephOrientationBadgeInfo provides correct labels for confirmed and estimated vertical videos', () => {
    const { mod } = harness();

    // Confirmed by dimensions
    const badge1 = mod.ephOrientationBadgeInfo({ width: 720, height: 1280 });
    assert.equal(badge1.label, 'Vertikálne · rozmery');
    assert.equal(badge1.estimated, false);

    // Confirmed by source metadata
    const badge2 = mod.ephOrientationBadgeInfo({ orientation: 'portrait' });
    assert.equal(badge2.label, 'Vertikálne · zdroj');
    assert.equal(badge2.estimated, false);

    // Estimated by text hint
    const badge3 = mod.ephOrientationBadgeInfo({ title: 'My tiktok video clip', orientation_evidence: 'text_hint' });
    assert.equal(badge3.label, 'Možno vertikálne · názov/tagy');
    assert.equal(badge3.estimated, true);

    // Estimated by thumbnail
    const badge4 = mod.ephOrientationBadgeInfo({ thumbnail_width: 300, thumbnail_height: 500 });
    assert.equal(badge4.label, 'Možno vertikálne · náhľad');
    assert.equal(badge4.estimated, true);

    // Landscape has no badge
    const badge5 = mod.ephOrientationBadgeInfo({ width: 1920, height: 1080 });
    assert.equal(badge5.label, '');
});

test('orientation filtering in _ephComputeFiltered separates portrait, landscape, portrait_any and portrait_estimate', () => {
    const { mod } = harness();
    mod.ephub.items = [
        { url: '1', title: 'Confirmed portrait dimensions', width: 720, height: 1280 },
        { url: '2', title: 'Confirmed landscape dimensions', width: 1920, height: 1080 },
        { url: '3', title: 'Declared vertical by source', orientation: 'vertical' },
        { url: '4', title: 'Estimated by thumb', thumbnail_width: 300, thumbnail_height: 500 },
        { url: '5', title: 'Estimated by text vertical clip' },
        { url: '6', title: 'Regular video without orientation info' },
    ];

    // Filter: all
    mod.ephub.orientation = 'all';
    assert.equal(mod._ephComputeFiltered().map(i => i.url).join(','), '1,2,3,4,5,6');

    // Filter: portrait (only confirmed)
    mod.ephub.orientation = 'portrait';
    assert.equal(mod._ephComputeFiltered().map(i => i.url).join(','), '1,3');

    // Filter: landscape (confirmed)
    mod.ephub.orientation = 'landscape';
    assert.equal(mod._ephComputeFiltered().map(i => i.url).join(','), '2');

    // Filter: portrait_any (confirmed + likely / estimated)
    mod.ephub.orientation = 'portrait_any';
    assert.equal(mod._ephComputeFiltered().map(i => i.url).join(','), '1,3,4,5');

    // Filter: portrait_estimate (only unconfirmed estimates)
    mod.ephub.orientation = 'portrait_estimate';
    assert.equal(mod._ephComputeFiltered().map(i => i.url).join(','), '4,5');
});

test('vertical video effective resolution uses the shorter side for quality threshold and sort', () => {
    const { mod } = harness();
    mod.ephub.items = [
        { url: '1', title: '1080x1920 vertical video', width: 1080, height: 1920 },
        { url: '2', title: '720x1280 vertical video', width: 720, height: 1280 },
        { url: '3', title: '3840x2160 landscape 4K', width: 3840, height: 2160 },
    ];

    // minHeight: 1080p
    mod.ephub.minHeight = 1080;
    assert.equal(mod._ephComputeFiltered().map(i => i.url).join(','), '1,3');

    // minHeight: 1440p (2K+) -> 1080x1920 vertical is 1080p, so it does NOT meet 1440p
    mod.ephub.minHeight = 1440;
    assert.equal(mod._ephComputeFiltered().map(i => i.url).join(','), '3');

    // Quality sort descending: 4K (2160), then 1080x1920 (1080), then 720x1280 (720)
    mod.ephub.minHeight = 0;
    mod.ephub.dateSort = '';
    mod.ephub.qualSort = 'desc';
    assert.equal(mod._ephComputeFiltered().map(i => i.url).join(','), '3,1,2');
});

test('ephProbeUnknownOrientation probes backend and applies orientation patches', async () => {
    const { mod } = harness();
    mod.ephub.items = [
        { url: 'https://vertical_site.com/video/1', title: 'Mystery clip 1' },
        { url: 'https://horizontal_site.com/video/2', title: 'Mystery clip 2' },
        { url: 'https://already_known.com/video/3', title: 'Already known', width: 1920, height: 1080 },
    ];

    await mod.ephProbeUnknownOrientation();

    const item1 = mod.ephub.items.find(i => i.url === 'https://vertical_site.com/video/1');
    assert.equal(item1.orientation, 'portrait');
    assert.equal(item1.width, 720);
    assert.equal(item1.height, 1280);

    const item2 = mod.ephub.items.find(i => i.url === 'https://horizontal_site.com/video/2');
    assert.equal(item2.orientation, 'landscape');
    assert.equal(item2.width, 1920);
    assert.equal(item2.height, 1080);
});

test('ephOnThumbLoad updates thumbnail dimensions and refreshes filter', () => {
    const { mod } = harness();
    const item = { url: 'https://thumb_test.com/v1', title: 'Thumb test' };
    mod.ephub.items = [item];
    mod.ephub.orientation = 'portrait_estimate';

    // Before load: not portrait
    assert.equal(mod.ephFilteredItems().length, 0);

    // Trigger thumb load with portrait natural dimensions
    mod.ephOnThumbLoad({ target: { naturalWidth: 360, naturalHeight: 640 } }, item);

    assert.equal(item.thumbnail_width, 360);
    assert.equal(item.thumbnail_height, 640);
    assert.equal(item.thumbnail_orientation_checked, true);
    assert.equal(mod.ephHasPortraitThumbnailEstimate(item), true);

    // After load: visible under portrait_estimate
    assert.equal(mod.ephFilteredItems().length, 1);
});

test('ephClearFilters resets orientation to all and ephActiveFilterCount reflects orientation', () => {
    const { mod } = harness();
    assert.equal(mod.ephActiveFilterCount(), 0);

    mod.ephSetOrientation('portrait');
    assert.equal(mod.ephub.orientation, 'portrait');
    assert.equal(mod.ephActiveFilterCount(), 1);

    mod.ephClearFilters();
    assert.equal(mod.ephub.orientation, 'all');
    assert.equal(mod.ephActiveFilterCount(), 0);
});
