// Add this function to popup.js - Filester Manager Handler

async function handleFilesterManagerScraping(tab) {
    console.log('[Filester Manager] Scraping tab:', tab.id, tab.url);
    document.getElementById('loader').style.display = 'flex';
    document.getElementById('video-grid').style.display = 'none';
    const statsEl = document.getElementById('stats-text');
    if (statsEl) statsEl.innerText = 'Filester Manager: Pripravujem scan...';

    try {
        // Check if scanner is ready
        const stateCheck = await chrome.tabs.sendMessage(tab.id, {
            action: 'GET_FILESTER_MANAGER_STATE'
        });

        if (!stateCheck || !stateCheck.isManagerPage) {
            showError('Toto nie je Filester Manager stránka.\n\nOtvor: filester.me/manager');
            return;
        }

        if (statsEl) statsEl.innerText = 'Filester Manager: Scanujem všetky foldery...';

        // Trigger scan
        const scanResult = await chrome.tabs.sendMessage(tab.id, {
            action: 'SCAN_FILESTER_MANAGER'
        });

        if (!scanResult || !scanResult.success || !scanResult.data) {
            showError('Scan Filester Manager zlyhal.\n\nSkús obnoviť stránku (F5) a skús znova.');
            return;
        }

        const data = scanResult.data;
        const files = data.files || [];
        
        if (files.length === 0) {
            showError('Žiadne video súbory neboli nájdené v Filester Manager.\n\nUbezpeč sa, že máš nahraté videá.');
            return;
        }

        // Map files to video format
        allVideos = files.map(file => ({
            id: file.url,
            title: file.title,
            url: file.url,
            source_url: file.source_url,
            thumbnail: file.thumbnail || '',
            quality: file.quality || 'HD',
            size: file.size_bytes || 0,
            size_bytes: file.size_bytes || 0,
            duration: file.duration || 0,
            folder_name: file.folder_name || '',
            folder_id: file.folder_id || '',
            context: `Filester Manager - ${file.folder_name || 'Root'}`
        }));

        const folderEl = document.getElementById('folder-name');
        if (folderEl) {
            folderEl.innerText = `Filester Manager (${data.total_folders} folderov)`;
        }

        currentlyFilteredVideos = [...allVideos];
        applyFilters();
        updateStats();

        if (statsEl) {
            statsEl.innerText = `✓ Nájdených ${files.length} videí z ${data.total_folders} folderov`;
        }

        // Auto-import if enabled
        const autoSend = document.getElementById('send-to-dashboard')?.checked || false;
        if (autoSend && allVideos.length > 0) {
            if (statsEl) statsEl.innerText = `Importujem ${allVideos.length} videí do Nexus...`;

            const toImport = allVideos.map((video) => {
                const v = normalizeVideoSizeFields(video);
                const sizeBytes = getVideoSizeBytes(v);
                return {
                    title: v.title,
                    url: v.url,
                    source_url: v.source_url,
                    thumbnail: v.thumbnail || null,
                    filesize: sizeBytes,
                    size_bytes: sizeBytes,
                    file_size_mb: getVideoSizeMegabytes(v),
                    quality: v.quality,
                    duration: v.duration || 0,
                    tags: v.folder_name || 'filester-manager',
                };
            });

            try {
                const resp = await fetch(`${DASHBOARD_URL}/api/v1/import/bulk`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        batch_name: `Filester Manager: ${new Date().toLocaleDateString()}`,
                        videos: toImport,
                    }),
                });

                if (resp.ok) {
                    const result = await resp.json();
                    if (statsEl) {
                        statsEl.innerText = `✓ Importované: ${result.imported || toImport.length} videí`;
                    }
                    showToast(`✓ Importovaných ${result.imported || toImport.length} videí do Nexus`, 3500);
                } else {
                    throw new Error(`HTTP ${resp.status}`);
                }
            } catch (err) {
                console.error('Filester Manager auto-import failed:', err);
                showToast('⚠ Import zlyhal - skontroluj Nexus dashboard', 3000);
            }
        }

    } catch (err) {
        console.error('[Filester Manager] Error:', err);
        showError('Filester Manager: ' + err.message);
    }
}

// Add this function to check if URL is Filester Manager
function isFilesterManagerUrl(url) {
    return url && url.includes('filester.') && url.includes('/manager');
}

// Add to the main scanner in startScraper() function:
// Add this condition after the existing Filester check:
/*
} else if (isFilesterManagerUrl(tab.url)) {
    document.getElementById('turbo-controls').style.display = 'none';
    await handleFilesterManagerScraping(tab);
} else if (isFilesterHost(tab.url)) {
*/
