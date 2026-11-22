import test from 'node:test';
import assert from 'node:assert/strict';

// Test harness for handleCardClick
function createCardClickContext() {
    return {
        batchMode: false,
        selectedIds: [],
        duoPickMode: false,
        duoPlayerMode: false,
        viewMode: 'grid',
        playedVideo: null,
        isTesterMixVideo(v) { return false; },
        playVideo(v) { this.playedVideo = v; },
        handleCardClick(video, event) {
            // Support CTRL (or Command on macOS) + click for rapid batch selection toggle
            event = event || (typeof window !== 'undefined' ? (window.event || null) : null);
            const isMulti = !!(event && (event.ctrlKey || event.metaKey));
            if (isMulti && !this.batchMode) this.batchMode = true;
            if (this.batchMode) {
                if (isMulti) {
                    try { event?.preventDefault?.(); event?.stopPropagation?.(); } catch (_) {}
                }
                if (this.selectedIds.includes(video.id)) {
                    this.selectedIds = this.selectedIds.filter(id => id !== video.id);
                } else {
                    this.selectedIds = [...this.selectedIds, video.id];
                }
                return;
            }
            if (this.isTesterMixVideo(video)) return;
            this.playVideo(video);
        }
    };
}

test('handleCardClick: normal click plays video when not in batch mode', () => {
    const ctx = createCardClickContext();
    const video = { id: 101, title: 'Sample' };
    ctx.handleCardClick(video);
    assert.equal(ctx.batchMode, false);
    assert.deepEqual(ctx.selectedIds, []);
    assert.equal(ctx.playedVideo?.id, 101);
});

test('handleCardClick: CTRL + click automatically enables batchMode and selects video', () => {
    const ctx = createCardClickContext();
    const video = { id: 101, title: 'Sample' };
    let prevented = false;
    let stopped = false;
    const fakeEvent = {
        ctrlKey: true,
        preventDefault() { prevented = true; },
        stopPropagation() { stopped = true; }
    };

    ctx.handleCardClick(video, fakeEvent);
    assert.equal(ctx.batchMode, true);
    assert.deepEqual(ctx.selectedIds, [101]);
    assert.equal(ctx.playedVideo, null, 'Video should not play when CTRL + clicked');
    assert.equal(prevented, true);
    assert.equal(stopped, true);
});

test('handleCardClick: subsequent CTRL + click on another video appends to selection', () => {
    const ctx = createCardClickContext();
    const v1 = { id: 101 };
    const v2 = { id: 102 };
    ctx.handleCardClick(v1, { ctrlKey: true });
    ctx.handleCardClick(v2, { ctrlKey: true });
    assert.deepEqual(ctx.selectedIds, [101, 102]);
});

test('handleCardClick: CTRL + click on already selected video unselects it', () => {
    const ctx = createCardClickContext();
    const v1 = { id: 101 };
    ctx.handleCardClick(v1, { ctrlKey: true });
    assert.deepEqual(ctx.selectedIds, [101]);
    ctx.handleCardClick(v1, { ctrlKey: true });
    assert.deepEqual(ctx.selectedIds, []);
});

test('handleCardClick: metaKey (Command on macOS) works same as ctrlKey', () => {
    const ctx = createCardClickContext();
    const video = { id: 202 };
    ctx.handleCardClick(video, { metaKey: true });
    assert.equal(ctx.batchMode, true);
    assert.deepEqual(ctx.selectedIds, [202]);
});
