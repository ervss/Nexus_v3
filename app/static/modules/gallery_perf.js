/**
 * Gallery Performance Helper (NexusGalleryPerf).
 * Uses a shared IntersectionObserver so off-screen cards in 9k+ libraries
 * keep async decoding and never stall scrolling or hold active preview loops.
 */
(function (global) {
    'use strict';

    let observer = null;

    function ensureObserver() {
        if (observer || typeof IntersectionObserver === 'undefined') return observer;
        observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    const card = entry.target;
                    if (entry.isIntersecting) {
                        card.dataset.nxVisible = '1';
                        const img = card.querySelector('img[data-src]');
                        if (img && img.dataset.src && !img.getAttribute('src')) {
                            img.decoding = 'async';
                            img.src = img.dataset.src;
                        }
                    } else {
                        delete card.dataset.nxVisible;
                        const hoverVid = card.querySelector('video.hover-preview-video');
                        if (hoverVid && !hoverVid.paused) {
                            try {
                                hoverVid.pause();
                            } catch (_) { }
                        }
                    }
                }
            },
            { rootMargin: '400px 0px', threshold: 0.01 }
        );
        return observer;
    }

    function observeCards(rootEl) {
        const obs = ensureObserver();
        if (!obs) return 0;
        const scope = rootEl || document;
        const cards = scope.querySelectorAll('.vip-item, .v1-card, .gallery-item');
        let added = 0;
        cards.forEach((card) => {
            if (!card.dataset.nxObserved) {
                card.dataset.nxObserved = '1';
                obs.observe(card);
                added += 1;
            }
        });
        return added;
    }

    function initAutoObserve() {
        if (typeof document === 'undefined') return;
        const run = () => observeCards(document);
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', run, { once: true });
        } else {
            run();
        }
        if (typeof MutationObserver !== 'undefined') {
            let scheduled = false;
            const mo = new MutationObserver(() => {
                if (scheduled) return;
                scheduled = true;
                requestAnimationFrame(() => {
                    scheduled = false;
                    observeCards(document);
                });
            });
            const attach = () => {
                if (document.body) {
                    mo.observe(document.body, { childList: true, subtree: true });
                }
            };
            if (document.body) attach();
            else document.addEventListener('DOMContentLoaded', attach, { once: true });
        }
    }

    global.NexusGalleryPerf = {
        observeCards,
        initAutoObserve,
    };

    if (typeof window !== 'undefined') {
        initAutoObserve();
    }
})(typeof window !== 'undefined' ? window : globalThis);
