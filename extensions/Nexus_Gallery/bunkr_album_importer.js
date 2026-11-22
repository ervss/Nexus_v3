(() => {
    // Nexus Bunkr Album Importer
    
    let selectedUrls = new Set();
    let toolbarEl = null;
    let items = [];

    function isBunkrAlbum() {
        const h = window.location.hostname;
        const isBunkr = h.includes('bunkr') || h === 'balbums.st' || h === 'balbums.io';
        const p = window.location.pathname;
        return isBunkr && (/^\/a\//.test(p) || /^\/albums?\//.test(p));
    }

    if (!isBunkrAlbum()) return;

    function getItems() {
        // Items in Bunkr albums are usually in a grid.
        // Based on structure: div.grid > div, .theItem, .grid-item, etc.
        // Added .border-b.py-3.px-3 for bunkrr.pics list items.
        return Array.from(document.querySelectorAll('.grid > div, .grid-item, .file-card, .theItem, .border-b.py-3.px-3')).filter(el => {
            const link = el.querySelector('a[href*="/f/"], a[href*="/v/"]');
            return !!link;
        });
    }

    function updateToolbar() {
        if (!toolbarEl) {
            toolbarEl = document.createElement('div');
            toolbarEl.className = 'nexus-batch-toolbar';
            toolbarEl.innerHTML = `
                <div class="nexus-batch-count">0 selected</div>
                <div class="nexus-batch-port">
                    <span class="nexus-batch-port-label">Port:</span>
                    <select class="nexus-batch-port-select">
                        <option value="8001">8001</option>
                        <option value="8000">8000</option>
                        <option value="8002">8002</option>
                    </select>
                </div>
                <button class="nexus-batch-select-all-btn" style="background:none; border:1px solid rgba(255,255,255,0.2); color:#fff; border-radius:8px; padding:4px 8px; font-size:11px; cursor:pointer;">Select All</button>
                <button class="nexus-batch-sidecar-btn" title="Send only checked files to Vertical Video Sidecar">Sidecar selected</button>
                <button class="nexus-batch-sidecar-grid-btn" title="Send every file currently loaded in this album grid to Vertical Video Sidecar">Sidecar grid</button>
                <button class="nexus-batch-import-btn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                    Import Selected
                </button>
                <button class="nexus-batch-close" title="Deselect all">&times;</button>
            `;
            document.body.appendChild(toolbarEl);

            toolbarEl.querySelector('.nexus-batch-import-btn').onclick = handleBatchImport;
            toolbarEl.querySelector('.nexus-batch-select-all-btn').onclick = selectAll;
            toolbarEl.querySelector('.nexus-batch-sidecar-btn').onclick = () => sendToSidecar(Array.from(selectedUrls), 'selected');
            toolbarEl.querySelector('.nexus-batch-sidecar-grid-btn').onclick = () => {
                const urls = getItems().map((el) => el.querySelector('a[href*="/f/"], a[href*="/v/"]')?.href).filter(Boolean);
                sendToSidecar(urls, 'grid');
            };
            toolbarEl.querySelector('.nexus-batch-close').onclick = deselectAll;
        }

        const count = selectedUrls.size;
        toolbarEl.querySelector('.nexus-batch-count').textContent = `${count} selected`;
        
        if (count > 0 || getItems().length > 0) {
            toolbarEl.classList.add('visible');
        } else {
            toolbarEl.classList.remove('visible');
        }
    }

    function deselectAll() {
        selectedUrls.clear();
        document.querySelectorAll('.nexus-bunkr-checkbox').forEach(cb => cb.checked = false);
        document.querySelectorAll('.nexus-bunkr-item-selected').forEach(el => el.classList.remove('nexus-bunkr-item-selected'));
        updateToolbar();
    }

    function selectAll() {
        getItems().forEach(el => {
            const link = el.querySelector('a[href*="/f/"], a[href*="/v/"]');
            if (link) {
                selectedUrls.add(link.href);
                el.classList.add('nexus-bunkr-item-selected');
                const cb = el.querySelector('.nexus-bunkr-checkbox');
                if (cb) cb.checked = true;
            }
        });
        updateToolbar();
    }

    function handleCheckboxChange(e) {
        const url = e.target.dataset.url;
        const container = e.target.closest('.grid > div, .grid-item, .file-card');
        
        if (e.target.checked) {
            selectedUrls.add(url);
            container?.classList.add('nexus-bunkr-item-selected');
        } else {
            selectedUrls.delete(url);
            container?.classList.remove('nexus-bunkr-item-selected');
        }
        updateToolbar();
    }

    function buildItems(urls) {
        const itemsToImport = [];
        const allItems = getItems();

        Array.from(new Set(urls)).forEach(url => {
            const itemEl = allItems.find(el => {
                const link = el.querySelector('a[href*="/f/"], a[href*="/v/"]');
                return link?.href === url;
            });
            let title = itemEl?.querySelector('h1, h2, h3, .title, .filename, .mt-2, .theName')?.textContent?.trim();
            if (!title) {
                const mainLink = itemEl?.querySelector('a[href*="/f/"], a[href*="/v/"]');
                if (mainLink && mainLink.textContent.trim().toLowerCase() !== 'open') {
                    title = mainLink.textContent.trim();
                }
            }
            title = title || "Bunkr File";
            const imgEl = itemEl?.querySelector('img');
            const rawThumb = imgEl?.getAttribute('data-src') || imgEl?.getAttribute('src') || null;
            const thumb = rawThumb && rawThumb.startsWith('http') && !rawThumb.includes('video.svg') && !rawThumb.endsWith(window.location.host + '/') ? rawThumb : null;
            
            // Extract size if possible
            let sizeBytes = 0;
            const sizeText = itemEl?.innerText?.match(/(\d+(?:\.\d+)?)\s*(GB|MB|KB)/i);
            if (sizeText) {
                const val = parseFloat(sizeText[1]);
                const unit = sizeText[2].toUpperCase();
                const mult = { KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 };
                sizeBytes = Math.round(val * (mult[unit] || 1));
            }

            itemsToImport.push({
                url,
                title,
                thumbnail: thumb,
                sizeBytes
            });
        });
        return itemsToImport;
    }

    async function handleBatchImport() {
        const port = toolbarEl.querySelector('.nexus-batch-port-select').value;
        const count = selectedUrls.size;
        if (!count) {
            showToast('Select at least one file first.', true);
            return;
        }

        showToast(`Starting bulk import of ${count} items to port ${port}...`);
        const itemsToImport = buildItems(Array.from(selectedUrls));

        chrome.runtime.sendMessage({
            action: 'NEXUS_BUNKR_IMPORT_BULK',
            items: itemsToImport,
            port: port,
            batchName: `Bunkr Album: ${document.title}`
        }, (res) => {
            if (res?.ok) {
                showToast(`Successfully imported ${res.imported} / ${res.requested} items!`);
                deselectAll();
            } else {
                showToast(`Import failed: ${res?.error || 'Unknown error'}`, true);
            }
        });
    }

    function enqueueSidecarOnPage(items) {
        return new Promise((resolve, reject) => {
            const requestId = `bunkr-sidecar-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const timer = window.setTimeout(() => {
                window.removeEventListener('message', onResult);
                reject(new Error('Sidecar bridge did not respond.'));
            }, 5000);
            function onResult(event) {
                if (event.source !== window || event.origin !== window.location.origin) return;
                const data = event.data;
                if (data?.type !== 'NEXUS_SIDECAR_RESULT' || data.requestId !== requestId) return;
                window.clearTimeout(timer);
                window.removeEventListener('message', onResult);
                if (data.result?.ok) resolve(data.result);
                else reject(new Error(data.result?.error || 'Sidecar rejected the request.'));
            }
            window.addEventListener('message', onResult);
            window.postMessage({ type: 'NEXUS_SIDECAR_ENQUEUE', requestId, items, playNow: false }, window.location.origin);
        });
    }

    async function sendToSidecar(urls, mode) {
        const itemsToSend = buildItems(urls);
        if (!itemsToSend.length) {
            showToast(mode === 'grid' ? 'No files found in the current album grid.' : 'Select at least one file first.', true);
            return;
        }
        showToast(`Sending ${itemsToSend.length} ${mode === 'grid' ? 'grid' : 'selected'} file(s) to Sidecar...`);
        try {
            const res = await enqueueSidecarOnPage(itemsToSend);
            const duplicateText = res.duplicates ? ` (${res.duplicates} already queued)` : '';
            showToast(`Sidecar: added ${res.added || 0} / ${res.requested || itemsToSend.length}${duplicateText}`);
        } catch (error) {
            showToast(`Sidecar failed: ${error?.message || 'Unknown error'}`, true);
        }
    }

    function helperOwnsAlbum() {
        return document.documentElement.dataset.nexusBunkrHelper === '1' || !!document.getElementById('bunkr-album-helper-panel');
    }
    function yieldToHelper() {
        if (!helperOwnsAlbum()) return false;
        toolbarEl?.remove();toolbarEl = null;
        document.querySelectorAll('.nexus-bunkr-checkbox-container').forEach(n => n.remove());
        selectedUrls.clear();
        return true;
    }
    document.addEventListener('nexus-bunkr-helper-ready', yieldToHelper);
    function injectSelectors() {
        if (yieldToHelper()) return;
        const currentItems = getItems();
        currentItems.forEach(el => {
            if (el.querySelector('.nexus-bunkr-checkbox-container')) return;
            
            const link = el.querySelector('a[href*="/f/"], a[href*="/v/"]');
            if (!link) return;
            
            const url = link.href;
            const checkboxContainer = document.createElement('div');
            checkboxContainer.className = 'nexus-bunkr-checkbox-container';
            checkboxContainer.innerHTML = `<input type="checkbox" class="nexus-bunkr-checkbox" data-url="${url}">`;
            
            if (el.classList.contains('border-b') || el.classList.contains('py-3')) {
                checkboxContainer.style.position = 'static';
                checkboxContainer.style.marginRight = '12px';
                checkboxContainer.style.display = 'flex';
                checkboxContainer.style.alignItems = 'center';
                el.style.display = 'flex';
                el.style.alignItems = 'center';
                el.insertBefore(checkboxContainer, el.firstChild);
            } else {
                el.style.position = 'relative'; // Ensure absolute positioning works
                el.appendChild(checkboxContainer);
            }
            
            const cb = checkboxContainer.querySelector('input');
            cb.onchange = handleCheckboxChange;
            
            // Re-check if already in selectedUrls
            if (selectedUrls.has(url)) {
                cb.checked = true;
                el.classList.add('nexus-bunkr-item-selected');
            }
        });
    }

    function showToast(text, isError = false) {
        // Reuse global showToast if available, otherwise create local
        if (window.showToast) {
            window.showToast(text, isError);
            return;
        }
        let toast = document.querySelector('.nexus-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.className = 'nexus-toast';
            document.body.appendChild(toast);
        }
        toast.style.borderColor = isError ? 'rgba(255,50,50,0.6)' : 'rgba(0,255,127,0.4)';
        toast.innerText = text;
        toast.classList.add('visible');
        setTimeout(() => toast.classList.remove('visible'), 4000);
    }

    // Initial injection
    injectSelectors();
    
    // Watch for dynamic content (infinite scroll)
    let scanTimer;
    const observer = new MutationObserver(changes => {
        if (helperOwnsAlbum()) return;
        if (!changes.some(m => [...m.addedNodes,...m.removedNodes].some(n => n.nodeType === 1 &&
            (n.matches?.('.theItem,.grid-item,.file-card') || n.querySelector?.('a[href*="/f/"],a[href*="/v/"]'))))) return;
        clearTimeout(scanTimer);scanTimer = setTimeout(injectSelectors,150);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    let currentHref = location.href;
    function checkBunkrUrl() {
        if (location.href !== currentHref) {
            currentHref = location.href;
            deselectAll();
        }
    }
    window.addEventListener('popstate', checkBunkrUrl);
    window.addEventListener('hashchange', checkBunkrUrl);
    setInterval(checkBunkrUrl, 500);

})();
