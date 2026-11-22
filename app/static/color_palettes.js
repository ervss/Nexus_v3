(() => {
    const storageKey = 'nx_color_palette';
    const original = 'original';
    const palettes = new Set(['red-hot', 'arctic-pulse', 'emerald-vault', 'copper-noir', 'after-hours']);
    const root = document.documentElement;
    const choiceSelector = 'button.nx-color-palette[data-nx-palette]';

    function applyPalette(value) {
        const palette = palettes.has(value) ? value : original;
        if (palette === original) {
            delete root.dataset.nxPalette;
        } else {
            root.dataset.nxPalette = palette;
        }
        document.querySelectorAll(choiceSelector).forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.nxPalette === palette));
        });
    }

    function selectPalette(palette) {
        applyPalette(palette);
        try {
            if (palette === original) {
                localStorage.removeItem(storageKey);
            } else {
                localStorage.setItem(storageKey, palette);
            }
        } catch {
            // The active palette still works when browser storage is unavailable.
        }
    }

    try {
        applyPalette(localStorage.getItem(storageKey));
    } catch {
        applyPalette(original);
    }

    document.addEventListener('DOMContentLoaded', () => applyPalette(root.dataset.nxPalette), { once: true });
    document.addEventListener('click', event => {
        const choice = event.target.closest(choiceSelector);
        if (choice) {
            selectPalette(choice.dataset.nxPalette);
        } else if (event.target.closest('[data-nx-original-accent] button')) {
            selectPalette(original);
        }
    });
    document.addEventListener('change', event => {
        if (event.target.id === 'settings-theme') selectPalette(original);
    });
    window.addEventListener('nx:tone-change', event => {
        if (event?.detail?.tone === 'light') selectPalette(original);
    });
    window.nxSelectPalette = selectPalette;
    window.addEventListener('storage', event => {
        if (event.key === storageKey || event.key === null) applyPalette(event.newValue);
    });
})();
