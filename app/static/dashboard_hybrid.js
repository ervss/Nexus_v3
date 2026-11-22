/**
 * NexusPWC — Hybrid Dashboard UI Helpers
 * Independent of main.js and search.js.
 */
(function () {
    const DRAWER_TAB_KEY = 'nx_drawer_tab';
    const VALID_TABS = new Set(['library', 'sources', 'tools']);

    function isAnyModalOpen() {
        const selectors = [
            '.modal.open',
            '.modal[style*="display: flex"]',
            '.modal[style*="display: block"]',
            '.dhub-overlay[style*="display: flex"]',
            '#related-workspace-modal[aria-hidden="false"]',
            '.quantum-search-modal.open',
            '#creatorRadarOverlay:not([hidden])'
        ];
        return selectors.some((sel) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden';
        });
    }

    function focusMainSearch() {
        const input = document.getElementById('nx-main-search') || document.getElementById('queryInput');
        if (!input) return false;
        input.focus();
        input.select();
        return true;
    }

    function navigateVaultToggle() {
        if (window.location.pathname.startsWith('/vault')) {
            window.location.href = '/';
            return true;
        }
        const input = document.getElementById('nx-main-search');
        const q = input && input.value ? input.value.trim() : '';
        window.location.href = q ? `/vault?q=${encodeURIComponent(q)}` : '/vault';
        return true;
    }

    window.nxHybrid = {
        getDrawerTab() {
            try {
                const stored = localStorage.getItem(DRAWER_TAB_KEY);
                return VALID_TABS.has(stored) ? stored : 'library';
            } catch (_) {
                return 'library';
            }
        },
        setDrawerTab(tab) {
            const safe = VALID_TABS.has(tab) ? tab : 'library';
            try {
                localStorage.setItem(DRAWER_TAB_KEY, safe);
            } catch (_) {
                // ignore storage errors
            }
            return safe;
        },
        focusMainSearch
    };

    document.addEventListener('keydown', function (event) {
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        const key = String(event.key || '').toLowerCase();

        if (event.shiftKey && key === 'v') {
            if (isAnyModalOpen()) return;
            event.preventDefault();
            event.stopPropagation();
            navigateVaultToggle();
            return;
        }

        if (event.shiftKey && key === 'r') {
            if (isAnyModalOpen()) return;
            if (window.NexusCreatorRadar && typeof window.NexusCreatorRadar.open === 'function') {
                event.preventDefault();
                event.stopPropagation();
                window.NexusCreatorRadar.open();
            }
            return;
        }

        if (event.shiftKey || key !== 'k') return;

        if (isAnyModalOpen()) return;

        const active = document.activeElement;
        const isEditingOtherField = active &&
            active.id !== 'nx-main-search' &&
            active.id !== 'queryInput' &&
            (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);

        if (isEditingOtherField) return;

        if (focusMainSearch()) {
            event.preventDefault();
            event.stopPropagation();
        }
    }, true);
})();
