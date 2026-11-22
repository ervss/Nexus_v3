// Filester Manager Scanner
// Scans filester.me/manager page and extracts all files from folders
(function() {
    'use strict';

    console.log('[Nexus Gallery] Filester Manager Scanner loaded');

    const FILESTER_API_BASE = window.location.origin;
    const SCAN_INTERVAL = 2000;
    const MIN_DURATION = 60; // seconds

    // ── State ──────────────────────────────────────────────────────────────────
    let isScanning = false;
    let allFiles = [];
    let allFolders = [];
    let currentFolderPath = [];
    
    // ── Utilities ──────────────────────────────────────────────────────────────

    function formatSize(bytes) {
        const v = Number(bytes || 0);
        if (!Number.isFinite(v) || v <= 0) return null;
        if (v >= 1073741824) return `${(v / 1073741824).toFixed(2)} GB`;
        if (v >= 1048576)    return `${(v / 1048576).toFixed(1)} MB`;
        if (v >= 1024)       return `${(v / 1024).toFixed(1)} KB`;
        return `${v} B`;
    }

    function parseDuration(timeStr) {
        if (!timeStr) return 0;
        const parts = String(timeStr).trim().split(':');
        try {
            const nums = parts.map(p => parseInt(p, 10));
            if (nums.length === 3) {
                return nums[0] * 3600 + nums[1] * 60 + nums[2];
            } else if (nums.length === 2) {
                return nums[0] * 60 + nums[1];
            } else if (nums.length === 1) {
                return nums[0];
            }
        } catch {}
        return 0;
    }

    function extractQualityFromName(name) {
        const t = (name || '').toUpperCase();
        if (/\b(4K|2160P|UHD)\b/.test(t)) return 2160;
        if (/\b(1440P|2K)\b/.test(t)) return 1440;
        if (/\b(1080P|FHD)\b/.test(t)) return 1080;
        if (/\b(720P|HD)\b/.test(t)) return 720;
        if (/\b(480P)\b/.test(t)) return 480;
        if (/\b(360P)\b/.test(t)) return 360;
        return 0;
    }

    function isVideoFile(filename) {
        const ext = (filename || '').split('.').pop().toLowerCase();
        return ['mp4', 'mkv', 'avi', 'webm', 'mov', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg', 'm2ts', 'ts'].includes(ext);
    }

    // ── API Calls ──────────────────────────────────────────────────────────────

    function getApiKey() {
        // Try to get API key from localStorage or other sources
        try {
            const apiKey = localStorage.getItem('filester_api_key') || 
                          sessionStorage.getItem('filester_api_key') ||
                          localStorage.getItem('apiKey') ||
                          sessionStorage.getItem('apiKey');
            
            if (apiKey) {
                console.log('[Filester Manager] Found API key in storage');
                return apiKey;
            }
            
            // Try to find it in page context
            if (window.apiKey) {
                console.log('[Filester Manager] Found API key in window');
                return window.apiKey;
            }
            
            console.log('[Filester Manager] No API key found');
        } catch (err) {
            console.error('[Filester Manager] Error getting API key:', err);
        }
        return null;
    }

    async function fetchManagerData(folderIdentifier = '', page = 1) {
        const params = new URLSearchParams({
            files_page: page,
            folders_page: 1,
            with_hierarchy: 1,
            folder_sort: 'newest',
            _t: Date.now()
        });
        
        if (folderIdentifier) {
            params.append('folder', folderIdentifier);
        }
        
        const url = `${FILESTER_API_BASE}/api/manager/data?${params}`;
        
        console.log('[Filester Manager] Fetching:', url);
        
        try {
            const response = await fetch(url, {
                method: 'GET',
                credentials: 'include',
                headers: {
                    'Accept': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest'
                }
            });
            
            console.log('[Filester Manager] Response status:', response.status);
            
            if (!response.ok) {
                const text = await response.text();
                console.error('[Filester Manager] HTTP error:', response.status, text.substring(0, 200));
                throw new Error(`HTTP ${response.status}`);
            }
            
            const data = await response.json();
            // Important: Handle top-level keys correctly
            return data;
        } catch (err) {
            console.error('[Filester Manager] API fetch failed:', err);
            return null;
        }
    }

    // ── File Extraction ────────────────────────────────────────────────────────

    function extractFileInfo(file, folderData = null) {
        if (!file || !file.UUID || !file.Slug) return null;

        const fileUrl = `${window.location.origin}/d/${file.Slug}`;
        const title = file.OriginalName || file.Slug || 'Unnamed';
        const sizeBytes = file.Size || 0;
        
        // Correct thumbnail logic with fallback
        let thumbnailUrl = file.ThumbnailURL || '';
        // If it's a relative path or missing domain
        if (thumbnailUrl && !thumbnailUrl.startsWith('http')) {
            thumbnailUrl = `${window.location.origin}${thumbnailUrl.startsWith('/') ? '' : '/'}${thumbnailUrl}`;
        }
        
        // Fallback: use file page URL as thumbnail signal for backend extraction
        // Backend will extract the real thumbnail from the file page
        if (!thumbnailUrl) {
            // Send empty string - backend will extract thumbnail from file page
            thumbnailUrl = '';
        }
        
        // Extract duration from metadata or name
        const duration = parseDuration(file.Duration) || 0;
        const quality = extractQualityFromName(title);

        // Only include video files
        if (!isVideoFile(title)) return null;

        // Build source URL (folder page if available)
        let sourceUrl = fileUrl;
        if (folderData && (folderData.Identifier || folderData.UUID)) {
            sourceUrl = `${window.location.origin}/f/${folderData.Identifier || folderData.UUID}`;
        }

        return {
            url: fileUrl,
            title: title,
            thumbnail: thumbnailUrl,
            size_bytes: sizeBytes,
            size: formatSize(sizeBytes),
            duration: duration,
            quality: quality,
            source_url: sourceUrl,
            folder_name: folderData?.Name || '',
            folder_id: folderData?.Identifier || folderData?.UUID || '',
            file_id: file.UUID,
            file_slug: file.Slug,
            is_public: file.Public || false
        };
    }

    async function scanFolder(folderData, depth = 0) {
        const identifier = folderData?.Identifier || folderData?.UUID || '';
        const folderName = folderData?.Name || 'Root';
        
        console.log(`[Filester Manager] Scanning folder: ${folderName} (ID: ${identifier}) at depth ${depth}`);

        const result = {
            files: [],
            subfolders: []
        };

        // Fetch folder data
        let page = 1;
        let hasMore = true;

        while (hasMore && page <= 50) { // Increased page limit
            const data = await fetchManagerData(identifier, page);
            
            if (!data) {
                console.warn(`[Filester Manager] Failed to fetch folder ${folderName} page ${page}`);
                break;
            }

            // Important: Handle both data wrap and direct keys
            const responseData = data.data || data;
            const files = responseData.files || [];

            console.log(`[Filester Manager] Folder ${folderName} page ${page}: received ${files.length} files`);

            // Extract files from current page
            if (Array.isArray(files)) {
                for (const file of files) {
                    const fileInfo = extractFileInfo(file, folderData);
                    if (fileInfo) {
                        result.files.push(fileInfo);
                    }
                }
            }

            // Check if there are more pages
            // Filester uses files_total_pages or pagination.total_pages
            const totalPages = responseData.files_total_pages || 
                              responseData.pagination?.total_pages || 
                              (responseData.total_files ? Math.ceil(responseData.total_files / 50) : 1);
            
            hasMore = page < totalPages;
            
            // Fallback: if we got exactly 50 or 30 files (common page sizes), try next page
            if (!hasMore && files.length > 0 && (files.length === 50 || files.length === 30)) {
                console.log(`[Filester Manager] Reached end of page ${page} but it was full, checking if more exists...`);
                hasMore = true; 
            }

            if (hasMore) {
                page++;
                await new Promise(resolve => setTimeout(resolve, 350));
            } else {
                // If it's the first page, capture subfolders
                if (page === 1 || (responseData.subfolders && responseData.subfolders.length > 0)) {
                    result.subfolders = responseData.subfolders || responseData.folders || [];
                }
                break;
            }
        }

        return result;
    }

    async function scanAllFolders() {
        if (isScanning) {
            console.log('[Filester Manager] Scan already in progress');
            return null;
        }

        isScanning = true;
        allFiles = [];
        allFolders = [];

        try {
            console.log('[Filester Manager] Starting complete scan...');
            
            // Start with root folder (empty identifier)
            const rootScanResult = await scanFolder({ Name: 'Root', Identifier: '', UUID: '' }, 0);
            
            allFiles.push(...rootScanResult.files);
            
            // Use a queue for breadth-first search of all folders
            let folderQueue = [...(rootScanResult.subfolders || [])];
            let processedFolderIds = new Set(['', null]);

            console.log(`[Filester Manager] Root scan found ${rootScanResult.files.length} files and ${folderQueue.length} top-level folders`);

            while (folderQueue.length > 0) {
                const currentFolder = folderQueue.shift();
                const folderId = currentFolder.Identifier || currentFolder.UUID;

                if (!folderId || processedFolderIds.has(folderId)) continue;
                processedFolderIds.add(folderId);

                allFolders.push({
                    name: currentFolder.Name,
                    identifier: folderId,
                    is_public: currentFolder.Public || false,
                    thumbnail: currentFolder.ThumbnailURL || ''
                });

                const result = await scanFolder(currentFolder, 1);
                allFiles.push(...result.files);

                // Add any new subfolders found
                if (result.subfolders && result.subfolders.length > 0) {
                    for (const sub of result.subfolders) {
                        const subId = sub.Identifier || sub.UUID;
                        if (subId && !processedFolderIds.has(subId)) {
                            folderQueue.push(sub);
                        }
                    }
                }
            }

            console.log(`[Filester Manager] Scan complete: ${allFiles.length} video files found across ${allFolders.length + 1} folders`);

            return {
                files: allFiles,
                folders: allFolders,
                total_files: allFiles.length,
                total_folders: allFolders.length + 1
            };

        } catch (err) {
            console.error('[Filester Manager] Scan failed:', err);
            return null;
        } finally {
            isScanning = false;
        }
    }

    // ── Page Detection ─────────────────────────────────────────────────────────

    function isFilesterManagerPage() {
        return window.location.href.includes('filester.') && 
               window.location.pathname.includes('/manager');
    }

    // ── Message Handlers ───────────────────────────────────────────────────────

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'SCAN_FILESTER_MANAGER') {
            scanAllFolders().then(result => {
                sendResponse({
                    success: !!result,
                    data: result
                });
            }).catch(err => {
                sendResponse({
                    success: false,
                    error: err.message
                });
            });
            return true; // Keep channel open for async response
        }

        if (request.action === 'GET_FILESTER_MANAGER_STATE') {
            sendResponse({
                isManagerPage: isFilesterManagerPage(),
                isScanning: isScanning,
                totalFiles: allFiles.length,
                totalFolders: allFolders.length
            });
            return true;
        }

        if (request.action === 'GET_CURRENT_FILES') {
            sendResponse({
                files: allFiles,
                folders: allFolders
            });
            return true;
        }

        if (request.action === 'SET_FILESTER_API_KEY') {
            try {
                localStorage.setItem('filester_api_key', request.apiKey);
                console.log('[Filester Manager] API key saved');
                sendResponse({ success: true });
            } catch (err) {
                console.error('[Filester Manager] Failed to save API key:', err);
                sendResponse({ success: false, error: err.message });
            }
            return true;
        }
    });

    // ── Auto-detect and notify ────────────────────────────────────────────────

    if (isFilesterManagerPage()) {
        console.log('[Filester Manager] Manager page detected');
        
        // Notify background script
        chrome.runtime.sendMessage({
            action: 'FILESTER_MANAGER_PAGE_DETECTED',
            url: window.location.href
        });

        // Show visual indicator
        const indicator = document.createElement('div');
        indicator.id = 'nexus-filester-indicator';
        indicator.style.cssText = `
            position: fixed;
            top: 10px;
            right: 10px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            font-family: system-ui, -apple-system, sans-serif;
            font-size: 14px;
            font-weight: 600;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 999999;
            cursor: pointer;
            transition: transform 0.2s;
        `;
        indicator.textContent = '⚡ Nexus Gallery Ready - Click to scan';
        indicator.title = 'Click to scan all Filester files for import';
        
        indicator.addEventListener('mouseenter', () => {
            indicator.style.transform = 'scale(1.05)';
        });
        
        indicator.addEventListener('mouseleave', () => {
            indicator.style.transform = 'scale(1)';
        });

        indicator.addEventListener('click', async () => {
            if (isScanning) {
                indicator.textContent = '⏳ Scan already in progress...';
                return;
            }

            indicator.textContent = '🔍 Scanning Filester files...';
            
            const result = await scanAllFolders();
            
            if (result && result.total_files > 0) {
                indicator.textContent = `✓ Found ${result.total_files} videos - Open Nexus Gallery to import`;
                indicator.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
                
                // Notify popup if open
                chrome.runtime.sendMessage({
                    action: 'FILESTER_SCAN_COMPLETE',
                    data: result
                });
            } else {
                indicator.textContent = '⚠ No video files found';
                indicator.style.background = 'linear-gradient(135deg, #ff6b6b 0%, #ee5a24 100%)';
            }

            setTimeout(() => {
                indicator.textContent = '⚡ Nexus Gallery Ready - Click to scan';
                indicator.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
            }, 5000);
        });

        document.body.appendChild(indicator);
    }

})();
