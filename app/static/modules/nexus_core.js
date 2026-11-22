/*
 * nexus_core.js — pure, dependency-free helpers extracted from main.js.
 *
 * main.js is already organised as module-factory functions (createCollectionModule,
 * createImportModule, …) composed by composeDashboard(). This file is the first
 * step of pulling that structure into real, separately-cacheable files: these two
 * helpers have no closure dependencies on the rest of main.js, so they live here
 * and are loaded (deferred, in order) BEFORE main.js in index.html. main.js keeps
 * calling them as globals exactly as before.
 *
 * To continue the split, move each create*Module() factory into its own file under
 * modules/ the same way and load it before main.js; composeDashboard() already
 * accepts them as an array.
 */

// Merge an array of module-factory fragments into a single Alpine state object,
// preserving getters/setters via property descriptors.
function composeDashboard(modules) {
    return modules.reduce((state, factory) => {
        const fragment = factory();
        if (fragment && typeof fragment === 'object') {
            const descriptors = Object.getOwnPropertyDescriptors(fragment);
            Object.defineProperties(state, descriptors);
        }
        return state;
    }, {});
}

// Coerce any duration-ish input (number, "H:MM:SS", "MM:SS", "123.4", "12 min")
// into a sane integer seconds value, guarding against polluted/huge values.
function normalizeDurationSeconds(rawValue, sourceHint = '') {
    const source = String(sourceHint || '').toLowerCase();

    const finalize = (seconds) => {
        const n = Math.floor(Number(seconds) || 0);
        if (!Number.isFinite(n) || n <= 0) return 0;

        // Guard against polluted values such as 226690:05:46 parsed as huge hours.
        if (n > 7 * 24 * 3600) {
            const fallback = n % 3600;
            if (fallback >= 10 && fallback < 3600) return fallback;
            return 0;
        }

        // Bunkr imports should not carry ultra-long bogus durations in this UI.
        if (source.includes('bunkr') && n > 12 * 3600) {
            const fallback = n % 3600;
            if (fallback >= 10 && fallback < 3600) return fallback;
            return 0;
        }

        return n;
    };

    if (rawValue == null || rawValue === '' || rawValue === false) return 0;
    if (typeof rawValue === 'number') return finalize(rawValue);

    const text = String(rawValue).trim();
    if (!text) return 0;

    const colonMatch = text.match(/(\d+):([0-5]?\d)(?::([0-5]\d))?$/);
    if (colonMatch) {
        const left = Number(colonMatch[1]) || 0;
        const mid = Number(colonMatch[2]) || 0;
        const rightRaw = colonMatch[3];
        if (rightRaw != null) {
            const right = Number(rightRaw) || 0;
            if (left > 99) {
                return finalize(mid * 60 + right);
            }
            return finalize(left * 3600 + mid * 60 + right);
        }
        return finalize(left * 60 + mid);
    }

    const numeric = Number(text.replace(',', '.'));
    if (Number.isFinite(numeric)) return finalize(numeric);

    const firstNumber = text.match(/\d+(?:\.\d+)?/);
    if (firstNumber) return finalize(Number(firstNumber[0]));

    return 0;
}

function mediaMatchNameKey(title) {
    const base = String(title || '')
        .trim()
        .replace(/\s*[|–—-]\s*(bunkr|filester|pixeldrain|turbo\.?cr|gofile)\b.*$/i, '')
        .replace(/\.(mp4|mkv|webm|mov|m4v|avi|ts)$/i, '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
    return base.length >= 8 ? base : '';
}

function areVideoMirrors(a, b) {
    if (!a || !b) return false;
    const aName = mediaMatchNameKey(a.title);
    const bName = mediaMatchNameKey(b.title);
    if (!aName || aName !== bName) return false;

    const aSize = Number(a.file_size_mb || 0);
    const bSize = Number(b.file_size_mb || 0);
    if (!Number.isFinite(aSize) || !Number.isFinite(bSize) || aSize <= 0 || bSize <= 0) return false;
    if (Math.abs(aSize - bSize) / Math.max(aSize, bSize) > 0.003) return false;

    const aDuration = Number(a.duration || 0);
    const bDuration = Number(b.duration || 0);
    return !(aDuration > 0 && bDuration > 0 && Math.abs(aDuration - bDuration) > 3);
}

// Expose on window too so anything loading out of order still resolves them.
window.composeDashboard = composeDashboard;
window.normalizeDurationSeconds = normalizeDurationSeconds;
window.mediaMatchNameKey = mediaMatchNameKey;
window.areVideoMirrors = areVideoMirrors;
