// ==UserScript==
// @name         XXBrits playlist – 100 video batch loader
// @namespace    NexusPWC
// @version      1.0.0
// @description  Adds a safe “load next 100” control to public XXBrits playlist pages.
// @match        https://www.xxbrits.com/playlists/*/*/
// @grant        none
// ==/UserScript==

/*
 * Tampermonkey/Violentmonkey userscript.  XXBrits is a KVS site: each playlist
 * page contains ten cards and requests later pages from the playlist URL using
 * `mode=async&function=get_block&block_id=playlist_view_playlist_view&from=N`.
 *
 * The script deliberately loads a bounded 10-page window (up to 100 videos).
 * It never follows a guessed page URL: the next page comes from the returned
 * KVS paginator.  Click the same button again for the next window.
 */
(() => {
    'use strict';

    const BLOCK_ID = 'playlist_view_playlist_view';
    const ITEMS_ID = `${BLOCK_ID}_items`;
    const PAGE_LIMIT = 10;
    const panelId = 'nexus-xxbrits-playlist-loader';
    let nextPage = 0;
    let loading = false;
    // The page already contains its first ten cards.  The first click fetches
    // nine more pages so the visible batch totals 100, then later clicks fetch
    // full ten-page windows.
    let firstBatch = true;

    const currentBlock = () => document.getElementById(BLOCK_ID);
    const currentItems = () => document.getElementById(ITEMS_ID);

    function nextFrom(root) {
        const pager = root?.querySelector(`#${BLOCK_ID}_pagination`);
        if (!pager) return 0;
        const next = [...pager.querySelectorAll('a[data-parameters]')].find(link =>
            link.textContent.trim().toLowerCase() === 'next');
        const parameterText = next?.dataset.parameters || '';
        const found = parameterText.match(/(?:^|;)from:(\d+)(?:;|$)/);
        return found ? Number(found[1]) : 0;
    }

    function knownVideoUrls() {
        return new Set([...currentItems()?.querySelectorAll('[data-playlist-item]') || []]
            .map(card => card.dataset.playlistItem)
            .filter(Boolean));
    }

    function hydrateImages(root) {
        root.querySelectorAll('img[data-original]').forEach(image => {
            if (!image.src || image.src.startsWith('data:')) image.src = image.dataset.original;
        });
    }

    function status(text, isError = false) {
        const node = document.querySelector(`#${panelId} .nexus-status`);
        if (!node) return;
        node.textContent = text;
        node.style.color = isError ? '#ff8d8d' : '#dcecff';
    }

    function updateButton() {
        const button = document.querySelector(`#${panelId} button`);
        if (!button) return;
        button.disabled = loading || !nextPage;
        button.textContent = loading
            ? 'Načítavam…'
            : nextPage
                ? (firstBatch ? 'Načítať 100 videí' : 'Načítať ďalších 100 videí')
                : 'Playlist je načítaný celý';
    }

    async function requestPage(page) {
        const url = new URL(location.href);
        url.hash = '';
        url.search = new URLSearchParams({
            mode: 'async', function: 'get_block', block_id: BLOCK_ID,
            sort_by: 'added2fav_date', from: String(page),
        }).toString();
        const response = await fetch(url, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`XXBrits vrátil HTTP ${response.status}`);
        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const block = doc.getElementById(BLOCK_ID);
        if (!block) throw new Error('XXBrits nevrátil playlist blok.');
        return block;
    }

    async function loadNextBatch() {
        if (loading || !nextPage || !currentItems()) return;
        loading = true;
        updateButton();
        const seen = knownVideoUrls();
        let page = nextPage;
        let loadedPages = 0;
        let appended = 0;
        const pageBudget = firstBatch ? PAGE_LIMIT - 1 : PAGE_LIMIT;
        try {
            while (page && loadedPages < pageBudget) {
                status(`Načítavam stranu ${page} (${loadedPages + 1}/${pageBudget})…`);
                const block = await requestPage(page);
                const sourceItems = block.querySelector(`#${ITEMS_ID}`);
                const cards = [...sourceItems?.querySelectorAll('[data-playlist-item]') || []];
                const fresh = cards.filter(card => {
                    const url = card.dataset.playlistItem;
                    if (!url || seen.has(url)) return false;
                    seen.add(url);
                    return true;
                });
                if (!fresh.length) break;
                fresh.forEach(card => {
                    const clone = document.importNode(card, true);
                    hydrateImages(clone);
                    currentItems().appendChild(clone);
                });
                appended += fresh.length;
                loadedPages += 1;
                page = nextFrom(block);
            }
            nextPage = page;
            firstBatch = false;
            status(`Pridaných ${appended} videí z ${loadedPages} strán.${nextPage ? ` Ďalšia dávka začína stranou ${nextPage}.` : ' Koniec playlistu.'}`);
        } catch (error) {
            status(`Načítanie zlyhalo: ${error.message || error}`, true);
        } finally {
            loading = false;
            updateButton();
        }
    }

    function mount() {
        if (document.getElementById(panelId) || !currentBlock() || !currentItems()) return;
        nextPage = nextFrom(currentBlock());
        const panel = document.createElement('aside');
        panel.id = panelId;
        panel.innerHTML = `
            <button type="button"></button>
            <span class="nexus-status"></span>`;
        Object.assign(panel.style, {
            position: 'sticky', bottom: '18px', zIndex: 9999, display: 'flex', gap: '10px',
            alignItems: 'center', justifyContent: 'center', margin: '18px auto', padding: '12px',
            width: 'fit-content', maxWidth: 'calc(100% - 24px)', borderRadius: '10px',
            color: '#dcecff', background: 'rgba(16, 20, 33, .95)', boxShadow: '0 8px 30px rgba(0,0,0,.4)',
            font: '600 14px system-ui, sans-serif',
        });
        const button = panel.querySelector('button');
        Object.assign(button.style, {
            cursor: 'pointer', border: 0, borderRadius: '7px', padding: '9px 12px',
            color: '#07111e', background: '#68e0c4', font: '700 14px system-ui, sans-serif',
        });
        button.addEventListener('click', loadNextBatch);
        currentBlock().after(panel);
        status(nextPage ? `Pripravená ďalšia dávka od strany ${nextPage}.` : 'Playlist má jednu stranu.');
        updateButton();
    }

    mount();
})();
