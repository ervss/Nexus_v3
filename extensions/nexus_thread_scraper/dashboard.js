// State store
let activeTabId = null;
let activeTabUrl = "";
let threadTitle = "Thread Links";
let paginationBaseUrl = "";
let currentPageNum = 1;
let totalThreadPages = 1;

let allScrapedPosts = []; // All posts parsed across all pages
let filteredLinks = [];    // Links currently matching active filters
let selectedLinkUrls = new Set(); // Set of URLs currently selected
let processedPagesSet = new Set(); // Set of unique crawled page numbers

// Bunkr Background Resolver state
const resolvedBunkrLinks = {};
const activeResolves = new Set();
const resolveQueue = [];
const MAX_CONCURRENT_RESOLVES = 3;

// Album contents cache: albumUrl -> { items: [{url, name, size, sizeBytes}], loading: bool, error: bool }
const albumContents = {};

// File Link Online/Offline Status check store
const linkStatuses = {};

// Live Scraper Diagnostics Logging Helper
function addLog(message, type = "info") {
  const list = document.getElementById("debug-log-list");
  if (!list) return;

  const logEntry = document.createElement("div");
  const time = new Date().toLocaleTimeString();
  
  let color = "var(--text-main)";
  let prefix = "[INFO]";
  
  if (type === "success") {
    color = "var(--accent-green)";
    prefix = "[SUCCESS]";
  } else if (type === "warn") {
    color = "hsl(45, 90%, 55%)";
    prefix = "[WARN]";
  } else if (type === "error") {
    color = "hsl(0, 84%, 60%)";
    prefix = "[ERROR]";
  } else if (type === "system") {
    color = "var(--accent-cyan)";
    prefix = "[SYSTEM]";
  }
  
  logEntry.style.color = color;
  logEntry.textContent = `[${time}] ${prefix} ${message}`;
  
  list.appendChild(logEntry);
  list.scrollTop = list.scrollHeight;
}

// Backend API configuration for Nexus
let nexusBackendUrl = "http://localhost:8001"; // default fallback port

// A local server can be restarting or protecting itself from a slow import.
// Never leave the extension UI waiting on fetch forever in that situation.
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// Supported File Hosters regex list for classification
const hostRegexes = {
  filester: /filester\.(gg|me|sh|si|org|co|cl|net|io|tv)\/([a-zA-Z0-9_\.\/-]+)/i,
  mega: /mega\.(nz|io)\/(file|folder)\/([a-zA-Z0-9_-]+)/i,
  fileditch: /fileditch(files)?\.(me|com|org|net)\/([a-zA-Z0-9_\.\/-]+)/i,
  gofile: /gofile\.io\/d\/([a-zA-Z0-9_-]+)/i,
  bunkr: /(bunkr|bunkrr)\.[a-z0-9-]+\/([a-zA-Z0-9_\.\/-]+)/i,
  cyberdrop: /(cyberdrop|cyberfile)\.[a-z0-9-]+\/([a-zA-Z0-9_\.\/-]+)/i,
  pixeldrain: /pixeldrain\.com\/(u|l|api\/file)\/([a-zA-Z0-9_-]+)/i,
  mediafire: /mediafire\.com\/(file|folder|view)\/([a-zA-Z0-9_\.\/-]+)/i,
  rapidgator: /rapidgator\.net\/(file|article)\/([a-zA-Z0-9_\.\/-]+)/i,
  workupload: /workupload\.com\/file\/([a-zA-Z0-9_-]+)/i,
  terabox: /terabox\.[a-z0-9-]+\/s\/([a-zA-Z0-9_-]+)/i,
  whoreshub: /whoreshub\.com\/videos\/(\d+)\/([a-zA-Z0-9_-]+)/i,
  saint: /saint\d*\.[a-z0-9-]+\/([a-zA-Z0-9_\.\/-]+)/i,
  turbo: /turbo\.[a-z0-9-]+\/([a-zA-Z0-9_\.\/-]+)/i,
  pixhost: /pixhost\.to\/(show|images)\/(\d+)\/([a-zA-Z0-9_\.-]+)/i,
  onlyfans: /onlyfans\.com\/([a-zA-Z0-9_\.-]+)/i,
  jpg6: /jpg6\.su\/(img|upload)\/([a-zA-Z0-9_\.-]+)/i,
  coomer: /(coomer|kemono)\.(su|party)\/([a-zA-Z0-9_\.\/-]+)/i,
  erome: /erome\.com\/(a|v|i)\/([a-zA-Z0-9_-]+)/i,
  simpcity: /simpcity\.[a-z0-9-]+\/([a-zA-Z0-9_\.\/-]+)/i,
};

// Initialize Dashboard
document.addEventListener("DOMContentLoaded", () => {
  parseQueryParams();
  setupEventListeners();
  probeNexusBackend();
  
  // Auto-trigger initial scrape for the current active tab page
  if (activeTabId) {
    triggerInitialScrape();
  }
});

// Parse active tab details from Query parameters
function parseQueryParams() {
  const params = new URLSearchParams(window.location.search);
  activeTabId = parseInt(params.get("tabId"), 10) || null;
  activeTabUrl = decodeURIComponent(params.get("url") || "");
  
  if (activeTabUrl) {
    document.getElementById("source-link").href = activeTabUrl;
  }
}

// Trigger initial scrape using injected content script or background fetch
function triggerInitialScrape() {
  showLoader("Analyzing source page...");
  addLog("Active tab scrape requested.", "system");
  
  chrome.tabs.sendMessage(activeTabId, { action: "scrapeCurrentPage" }, (response) => {
    if (chrome.runtime.lastError) {
      const errMsg = chrome.runtime.lastError.message;
      console.warn("Content script not responding. Attempting background fetch instead...", errMsg);
      addLog(`Content script not responding (${errMsg}). Redirecting to background worker...`, "warn");
      // Fallback: Fetch current page HTML via background.js and parse locally
      fetchAndParsePage(activeTabUrl, true);
      return;
    }

    if (response && response.success) {
      addLog(`Direct tab page parsed! Title: "${response.data.threadTitle}" | Posts found: ${response.data.posts.length}`, "success");
      processScrapedData(response.data, true);
    } else {
      const err = response ? response.error : "Unknown content script response";
      console.error("Scraping failed:", err);
      addLog(`Active tab scrape failed! Error: ${err}`, "error");
      showToast("Failed to scrape page automatically. Try manual scan.");
      hideLoader();
    }
  });
}

// Set up event listeners for buttons and inputs
function setupEventListeners() {
  // Scrape Scope buttons
  const segmentBtns = document.querySelectorAll(".segment-btn");
  segmentBtns.forEach(btn => {
    btn.addEventListener("click", (e) => {
      segmentBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      
      const scope = btn.getAttribute("data-scope");
      const rangeWrapper = document.getElementById("range-inputs-wrapper");
      const startBtnSpan = document.querySelector("#start-crawl-btn span");
      
      if (scope === "range") {
        rangeWrapper.classList.remove("hidden");
        startBtnSpan.textContent = "Scan Page Range";
      } else if (scope === "all") {
        rangeWrapper.classList.add("hidden");
        startBtnSpan.textContent = "Scan Entire Thread";
      } else {
        rangeWrapper.classList.add("hidden");
        startBtnSpan.textContent = "Scan Current Page";
      }
    });
  });

  // Start Crawl Button
  document.getElementById("start-crawl-btn").addEventListener("click", () => {
    runCrawler();
  });

  // Search box filtering
  document.getElementById("search-box").addEventListener("input", () => {
    applyFilters();
  });
  document.getElementById("filter-size-min").addEventListener("input", () => {
    applyFilters();
  });
  document.getElementById("filter-size-max").addEventListener("input", () => {
    applyFilters();
  });

  // Host chip filters (Multiselect!)
  const hostChips = document.querySelectorAll("#host-filters-grid .filter-chip");
  hostChips.forEach(chip => {
    chip.addEventListener("click", () => {
      const isAll = chip.getAttribute("data-host") === "all";
      if (isAll) {
        hostChips.forEach(c => c.classList.remove("active"));
        chip.classList.add("active");
      } else {
        const allChip = document.querySelector('#host-filters-grid .filter-chip[data-host="all"]');
        if (allChip) allChip.classList.remove("active");
        
        chip.classList.toggle("active");
        
        // If no chips are active, re-activate "All"
        const activeCount = document.querySelectorAll("#host-filters-grid .filter-chip.active").length;
        if (activeCount === 0 && allChip) {
          allChip.classList.add("active");
        }
      }
      applyFilters();
    });
  });

  // Content Type chip filters (Multiselect!)
  const typeChips = document.querySelectorAll("#type-filters-grid .filter-chip");
  typeChips.forEach(chip => {
    chip.addEventListener("click", () => {
      const isAll = chip.getAttribute("data-type") === "all";
      if (isAll) {
        typeChips.forEach(c => c.classList.remove("active"));
        chip.classList.add("active");
      } else {
        const allChip = document.querySelector('#type-filters-grid .filter-chip[data-type="all"]');
        if (allChip) allChip.classList.remove("active");
        
        chip.classList.toggle("active");
        
        const activeCount = document.querySelectorAll("#type-filters-grid .filter-chip.active").length;
        if (activeCount === 0 && allChip) {
          allChip.classList.add("active");
        }
      }
      applyFilters();
    });
  });

  // Quality chip filters
  const qualityChips = document.querySelectorAll("#quality-filters-grid .filter-chip");
  qualityChips.forEach(chip => {
    chip.addEventListener("click", () => {
      qualityChips.forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      applyFilters();
    });
  });

  // Check Status Button
  document.getElementById("check-status-btn").addEventListener("click", () => {
    const urlsToCheck = [];
    filteredLinks.forEach(postGroup => {
      postGroup.links.forEach(l => {
        if (!urlsToCheck.includes(l.url)) {
          urlsToCheck.push(l.url);
        }
      });
    });
    
    if (urlsToCheck.length === 0) {
      showToast("No links visible to check!");
      return;
    }
    
    showToast(`Checking status of ${urlsToCheck.length} links...`);
    urlsToCheck.forEach(url => {
      checkLinkStatus(url);
    });
  });

  // Fetch Metadata Button
  document.getElementById("fetch-metadata-btn").addEventListener("click", () => {
    fetchMetadataForSelected();
  });

  // Delete Selected Button
  document.getElementById("delete-selected-btn").addEventListener("click", () => {
    if (selectedLinkUrls.size > 0) {
      deleteSelectedLinks(Array.from(selectedLinkUrls));
    } else {
      showToast("No links selected.");
    }
  });

  // Select all checkbox
  const selectAllCheckbox = document.getElementById("select-all-checkbox");
  selectAllCheckbox.addEventListener("change", (e) => {
    const checked = e.target.checked;
    const linkCheckboxes = document.querySelectorAll(".link-checkbox");
    
    linkCheckboxes.forEach(cb => {
      cb.checked = checked;
      const url = cb.getAttribute("data-url");
      if (checked) {
        selectedLinkUrls.add(url);
      } else {
        selectedLinkUrls.delete(url);
      }
    });
    
    // Update group checkboxes
    document.querySelectorAll(".group-checkbox").forEach(gcb => {
      gcb.checked = checked;
    });

    updateSelectedCount();
  });

  // Copy Dropdown Menu trigger
  const copyBtn = document.getElementById("copy-dropdown-btn");
  const copyMenu = document.getElementById("copy-dropdown-menu");
  
  copyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    copyMenu.classList.toggle("show");
  });

  // Close dropdown on click outside
  document.addEventListener("click", () => {
    copyMenu.classList.remove("show");
  });

  // Copy dropdown items trigger
  const dropdownItems = document.querySelectorAll(".dropdown-item");
  dropdownItems.forEach(item => {
    item.addEventListener("click", (e) => {
      const format = item.getAttribute("data-format");
      exportSelectedLinks(format);
    });
  });

  // Import to Nexus button trigger
  document.getElementById("nexus-import-btn").addEventListener("click", () => {
    importToNexus();
  });

  // Send to Tester button trigger
  const testerBtn = document.getElementById("send-to-tester-btn");
  if (testerBtn) {
    testerBtn.addEventListener("click", () => {
      sendSelectedToTester();
    });
  }
}

// Check if Nexus backend is running locally on the usual dashboard ports
function probeNexusBackend() {
  const ports = [8001, 8000, 8002, 5000];
  let found = false;

  const probe = (port) => {
    fetchWithTimeout(`http://localhost:${port}/api/v1/intake/sources`, {}, 2500)
      .then(res => {
        if ((res.ok || res.status === 401 || res.status === 403) && !found) {
          found = true;
          nexusBackendUrl = `http://localhost:${port}`;
          console.log(`Nexus Dashboard detected on: ${nexusBackendUrl}`);
          updateNexusBtnStatus(true, port);
        }
      })
      .catch(err => {
        // quiet fail, check next
      });
  };

  ports.forEach(probe);

  // Set timeout to check if none responded
  setTimeout(() => {
    if (!found) {
      console.warn("Nexus Dashboard offline or running on custom port.");
      updateNexusBtnStatus(false);
    }
  }, 1500);
}

function updateNexusBtnStatus(isConnected, port = "") {
  const btn = document.getElementById("nexus-import-btn");
  if (isConnected) {
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
      Import to Nexus (${port})
    `;
    btn.classList.add("btn-glow-green");
    btn.disabled = false;
  } else {
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      Nexus Offline
    `;
    btn.classList.remove("btn-glow-green");
    btn.disabled = true;
    btn.title = "No active Nexus Dashboard detected on localhost:8001.";
  }
}

// Crawler Execution Engine
async function runCrawler() {
  const activeScopeBtn = document.querySelector(".segment-btn.active");
  const scope = activeScopeBtn.getAttribute("data-scope");
  
  let startPage = 1;
  let endPage = 1;

  if (scope === "current") {
    startPage = currentPageNum;
    endPage = currentPageNum;
  } else if (scope === "range") {
    startPage = parseInt(document.getElementById("page-from").value, 10) || 1;
    endPage = parseInt(document.getElementById("page-to").value, 10) || 1;
    
    if (startPage > endPage) {
      showToast("Invalid page range!");
      return;
    }
  } else if (scope === "all") {
    startPage = 1;
    endPage = totalThreadPages;
  }

  showLoader(`Crawling thread...`);
  setupProgress(startPage, endPage);

  allScrapedPosts = []; // reset state for fresh crawl
  selectedLinkUrls.clear();
  processedPagesSet.clear();
  
  addLog(`Starting crawler in scope: "${scope}". Target page range: ${startPage} to ${endPage}.`, "system");

  for (let page = startPage; page <= endPage; page++) {
    updateProgress(page, startPage, endPage);
    
    // Construct page url
    let pageUrl = activeTabUrl;
    if (page !== currentPageNum || scope !== "current") {
      pageUrl = paginationBaseUrl.replace("{{page}}", page);
    }

    try {
      addLog(`[Page ${page}] Dispatching page crawl request... URL: ${pageUrl}`, "info");
      if (page === currentPageNum && activeTabId) {
        try {
          // If it's current tab page, scrape via injected content script (fast and bypasses storage/fetch)
          await scrapeCurrentPagePromise();
        } catch (err) {
          addLog(`[Page ${page}] Tab script error: ${err.message}. Falling back to background fetch...`, "warn");
          await fetchAndParsePage(pageUrl, false, page);
        }
      } else if (activeTabId) {
        // Try same-origin crawling via content script to bypass Cloudflare and inherit session cookies
        await fetchAndParseSubpageViaContent(pageUrl, page);
      } else {
        // Direct background fallback
        await fetchAndParsePage(pageUrl, false, page);
      }
      processedPagesSet.add(page);
    } catch (error) {
      console.error(`Error crawling page ${page}:`, error);
      addLog(`[Page ${page}] Critical exception inside crawling loop: ${error.message}`, "error");
    }
  }

  hideLoader();
  processScrapedData(null, false); // Trigger rendering of pooled results
  
  const totalExtracted = getAllLinksFromState().length;
  addLog(`Crawl completed! Crawled pages: ${processedPagesSet.size} | Total host links extracted: ${totalExtracted}`, "success");
  showToast(`Crawled ${processedPagesSet.size} pages successfully!`);
}

// Helper to dynamically inject content.js if missing in target tab
function ensureContentScriptInjected(tabId) {
  return new Promise((resolve) => {
    if (!chrome.scripting || !tabId) {
      resolve(false);
      return;
    }
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ["content.js"]
    }).then(() => {
      resolve(true);
    }).catch(err => {
      console.warn("Auto-inject content.js failed:", err);
      resolve(false);
    });
  });
}

// Promise wrapper to scrape active tab
// Promise wrapper to scrape active tab with auto-injection retry
function scrapeCurrentPagePromise() {
  return new Promise((resolve, reject) => {
    function trySend(isRetry = false) {
      chrome.tabs.sendMessage(activeTabId, { action: "scrapeCurrentPage" }, async (response) => {
        if (chrome.runtime.lastError) {
          if (!isRetry && chrome.scripting) {
            addLog(`[Page ${currentPageNum}] Content script disconnected. Auto-injecting content.js...`, "info");
            const injected = await ensureContentScriptInjected(activeTabId);
            if (injected) {
              setTimeout(() => trySend(true), 150);
              return;
            }
          }
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (response && response.success) {
          addLog(`[Page ${currentPageNum}] Active tab scrape succeeded! Posts found: ${response.data.posts.length}`, "success");
          processScrapedData(response.data, false);
          resolve();
        } else {
          const errMsg = response ? response.error : "Unknown content script error";
          addLog(`[Page ${currentPageNum}] Active tab scrape failed! Error: ${errMsg}`, "error");
          reject(new Error(errMsg));
        }
      });
    }

    trySend(false);
  });
}

// Fetch a sub-page using same-origin context of the active tab (reliable Cloudflare bypass)
function fetchAndParseSubpageViaContent(url, pageNum = "?") {
  return new Promise((resolve, reject) => {
    addLog(`[Page ${pageNum}] Requesting Same-Origin iframe load via content script...`, "info");
    chrome.tabs.sendMessage(activeTabId, { action: "fetchAndParseSubpage", url: url }, (response) => {
      // Catch tab script disconnection immediately to avoid unhandled browser runtime errors
      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message;
        addLog(`[Page ${pageNum}] Message Channel Disconnected! Error: ${errMsg}`, "error");
        console.warn(`Content script subpage fetch failed due to script disconnection for ${url} (${errMsg}). Falling back to background.js...`);
        addLog(`[Page ${pageNum}] Redirecting to Background Worker (fetch fallback)...`, "warn");
        
        fetchAndParsePage(url, false, pageNum)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response && response.success) {
        const diag = response.diagnostics;
        if (diag) {
          const type = diag.postsCount > 0 ? "success" : "warn";
          addLog(`[Page ${pageNum}] Iframe Loaded! Document Title: "${diag.title}" | Forum Posts: ${diag.postsCount} | Links Found: ${diag.linksExtracted}`, type);
        } else {
          addLog(`[Page ${pageNum}] Same-Origin iframe content loaded successfully!`, "success");
        }
        processScrapedData(response.data, false);
        resolve();
      } else {
        const errMsg = response ? response.error : "Unknown error";
        addLog(`[Page ${pageNum}] Iframe Loader failed! Error: ${errMsg}`, "error");
        console.warn(`Content script subpage fetch failed for ${url} (${errMsg}). Falling back to background.js...`);
        addLog(`[Page ${pageNum}] Redirecting to Background Worker (fetch fallback)...`, "warn");
        // Fallback to background direct worker fetch if content script fails
        fetchAndParsePage(url, false, pageNum)
          .then(resolve)
          .catch(reject);
      }
    });
  });
}

// Fetch a sub-page via background fetch and parse its DOM locally
function fetchAndParsePage(url, isInitial = false, pageNum = "?") {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: "fetchPage", url: url }, (response) => {
      if (response && response.success) {
        try {
          const parser = new DOMParser();
          const doc = parser.parseFromString(response.html, "text/html");
          const pageData = scrapePageData(doc, url);
          
          const rawPostsCount = doc.querySelectorAll('.message--post, article.message, [data-content^="post-"], .post-container, .postbit, .post, .message').length;
          const linksCount = pageData.posts.reduce((sum, p) => sum + p.links.length, 0);
          
          addLog(`[Page ${pageNum}] Background Fetch succeeded! Doc Title: "${doc.title || 'Empty'}" | Posts: ${rawPostsCount} | Links: ${linksCount}`, rawPostsCount > 0 ? "success" : "warn");
          
          processScrapedData(pageData, isInitial);
          resolve();
        } catch (err) {
          reject(err);
        }
      } else {
        reject(new Error(response ? response.error : "Failed background fetch"));
      }
    });
  });
}

// Handle scraped data chunk (from content or background)
function processScrapedData(data, updatePaginationMetadata = false) {
  if (data) {
    threadTitle = data.threadTitle || threadTitle;
    currentPageNum = data.pagination.currentPage || currentPageNum;
    totalThreadPages = data.pagination.totalPages || totalThreadPages;
    processedPagesSet.add(currentPageNum);
    paginationBaseUrl = data.pagination.pageBaseUrl || paginationBaseUrl;

    // Merge posts ensuring no duplicate posts by ID
    data.posts.forEach(newPost => {
      const existingPostIdx = allScrapedPosts.findIndex(p => p.postId === newPost.postId);
      if (existingPostIdx >= 0) {
        // Replace existing post with newer scraped copy
        allScrapedPosts[existingPostIdx] = newPost;
      } else {
        allScrapedPosts.push(newPost);
      }
    });
  }

  if (updatePaginationMetadata) {
    document.getElementById("thread-title").textContent = threadTitle;
    document.getElementById("current-page-num").textContent = currentPageNum;
    document.getElementById("total-thread-pages").textContent = totalThreadPages;
    
    // Set default page inputs
    document.getElementById("page-from").value = 1;
    document.getElementById("page-to").value = totalThreadPages;
    document.getElementById("page-to").max = totalThreadPages;
    document.getElementById("page-from").max = totalThreadPages;
  }

  // Pre-select all new link URLs by default
  getAllLinksFromState().forEach(link => {
    selectedLinkUrls.add(link.url);
  });

  applyFilters();
  hideLoader();
}

// Helper to pull all flat links currently stored in state
function getAllLinksFromState() {
  const links = [];
  allScrapedPosts.forEach(post => {
    post.links.forEach(link => {
      links.push(link);
    });
  });
  return links;
}

// Filtration and Search Engine
function applyFilters() {
  const searchTerm = document.getElementById("search-box").value.toLowerCase().trim();
  
  // Multiselect Host Filter
  const activeHostChips = document.querySelectorAll("#host-filters-grid .filter-chip.active");
  const activeHosts = Array.from(activeHostChips).map(c => c.getAttribute("data-host"));
  
  // Multiselect Type Filter
  const activeTypeChips = document.querySelectorAll("#type-filters-grid .filter-chip.active");
  const activeTypes = Array.from(activeTypeChips).map(c => c.getAttribute("data-type"));
  
  // Single-select Quality Filter
  const activeQualityChip = document.querySelector("#quality-filters-grid .filter-chip.active");
  const selectedQuality = activeQualityChip ? activeQualityChip.getAttribute("data-quality") : "all";

  const sizeMinInput = document.getElementById("filter-size-min");
  const sizeMaxInput = document.getElementById("filter-size-max");
  const filterSizeMin = sizeMinInput && sizeMinInput.value ? parseFloat(sizeMinInput.value) : 0;
  const filterSizeMax = sizeMaxInput && sizeMaxInput.value ? parseFloat(sizeMaxInput.value) : 0;

  const tempFiltered = [];

  allScrapedPosts.forEach(post => {
    const postLinksFiltered = [];

    post.links.forEach(link => {
      // 1. Host Filter (Multiselect)
      if (!activeHosts.includes("all") && activeHosts.length > 0) {
        let matchHost = false;
        if (activeHosts.includes("other") && link.host === "other") matchHost = true;
        if (activeHosts.includes(link.host)) matchHost = true;
        if (!matchHost) return;
      }

      // 2. Content Type Filter (Multiselect)
      if (!activeTypes.includes("all") && activeTypes.length > 0) {
        const linkType = getLinkType(link);
        if (!activeTypes.includes(linkType)) return;
      }

      // 3. Quality Filter
      if (selectedQuality !== "all") {
        if (selectedQuality === "unknown" && link.quality !== "Unknown Quality") return;
        if (selectedQuality !== "unknown" && !link.quality.toLowerCase().includes(selectedQuality)) return;
      }

      // 4. Search Filter
      if (searchTerm) {
        const matchesUrl = link.url.toLowerCase().includes(searchTerm);
        const matchesContext = link.context.toLowerCase().includes(searchTerm);
        const matchesAuthor = link.postAuthor.toLowerCase().includes(searchTerm);
        const matchesQuality = link.quality.toLowerCase().includes(searchTerm);
        
        if (!matchesUrl && !matchesContext && !matchesAuthor && !matchesQuality) return;
      }

      // 5. Size Filter
      if (filterSizeMin > 0 || filterSizeMax > 0) {
        let linkSizeMB = -1;
        const resolved = resolvedBunkrLinks[link.url];
        
        if (resolved && resolved.sizeBytes) {
           linkSizeMB = resolved.sizeBytes / (1024 * 1024);
        } else if (link.customSize && typeof link.customSize === 'string') {
           const val = parseFloat(link.customSize);
           const str = link.customSize.toUpperCase();
           if (str.includes('GB')) linkSizeMB = val * 1024;
           else if (str.includes('MB')) linkSizeMB = val;
           else if (str.includes('KB')) linkSizeMB = val / 1024;
        }

        if (linkSizeMB !== -1) {
           if (filterSizeMin > 0 && linkSizeMB < filterSizeMin) return;
           if (filterSizeMax > 0 && linkSizeMB > filterSizeMax) return;
        } else {
           return; // Ak nemá známu veľkosť a filtrujeme, vyradíme ho.
        }
      }

      postLinksFiltered.push(link);
    });

    if (postLinksFiltered.length > 0) {
      tempFiltered.push({
        postId: post.postId,
        postUrl: post.postUrl,
        author: post.author,
        timestamp: post.timestamp,
        links: postLinksFiltered,
        thumbnails: post.thumbnails || []
      });
    }
  });

  filteredLinks = tempFiltered;
  renderResults();
  updateStats();
}

// Dynamic UI rendering of filtered links
function renderResults() {
  const container = document.getElementById("results-container");
  container.innerHTML = "";

  if (filteredLinks.length === 0) {
    container.innerHTML = `
      <div class="empty-state-card glass">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
        <h3>No matching links found</h3>
        <p>Try adjusting your search criteria or host filter tags.</p>
      </div>
    `;
    return;
  }

  filteredLinks.forEach(postGroup => {
    const card = document.createElement("div");
    card.className = "post-card";

    // 1. Build Image Gallery Header
    let thumbnailsHtml = '';
    if (postGroup.thumbnails && postGroup.thumbnails.length > 0) {
      if (postGroup.thumbnails.length === 1) {
        thumbnailsHtml = `<div class="card-header-gallery single-img">
          <img src="${postGroup.thumbnails[0]}" class="gallery-img gallery-img-main" loading="lazy" />
        </div>`;
      } else if (postGroup.thumbnails.length === 2) {
        thumbnailsHtml = `<div class="card-header-gallery double-img">
          <img src="${postGroup.thumbnails[0]}" class="gallery-img" loading="lazy" />
          <img src="${postGroup.thumbnails[1]}" class="gallery-img" loading="lazy" />
        </div>`;
      } else {
        thumbnailsHtml = `<div class="card-header-gallery">
          <img src="${postGroup.thumbnails[0]}" class="gallery-img gallery-img-main" loading="lazy" />
          <div style="display: flex; flex-direction: column; gap: 2px;">
             <img src="${postGroup.thumbnails[1]}" class="gallery-img" style="height: 109px;" loading="lazy" />
             ${postGroup.thumbnails[2] ? `<img src="${postGroup.thumbnails[2]}" class="gallery-img" style="height: 109px;" loading="lazy" />` : ''}
          </div>
        </div>`;
      }
    }

    // 2. Build Context Text Area
    const textContext = postGroup.textContent || "No additional text provided in this post.";
    const allGroupUrls = postGroup.links.map(l => l.url);
    const allGroupSelected = allGroupUrls.every(url => selectedLinkUrls.has(url));

    const contextHtml = `
      <div class="card-context">
        <div class="card-author-row">
          <div class="card-author">
             <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity:0.8;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
             ${postGroup.author}
          </div>
          <div class="card-post-id">
             <a href="${postGroup.postUrl || '#'}" target="_blank" style="color: inherit; text-decoration: none; cursor: pointer;" title="Otvoriť pôvodný príspevok na fóre">#${postGroup.postId} ↗</a>
          </div>
        </div>
        <p class="card-desc" title="${textContext}">${textContext}</p>
      </div>
    `;

    card.innerHTML = thumbnailsHtml + contextHtml;

    // 3. Build Links List
    const list = document.createElement("div");
    list.className = "card-links";
    
    // Links Header (Select All for group)
    const listHeader = document.createElement("div");
    listHeader.className = "card-links-header";
    listHeader.innerHTML = `
      <label class="custom-checkbox" style="margin: 0;">
        <input type="checkbox" class="group-checkbox" data-urls='${JSON.stringify(allGroupUrls)}' ${allGroupSelected ? "checked" : ""}>
        <span class="checkmark" style="height: 14px; width: 14px; margin-right: 6px;"></span>
        <span style="font-size: 11px; text-transform: none; color: var(--text-muted);">${postGroup.links.length} Links</span>
      </label>
      <div style="display:flex; gap:6px;">
         <span class="badge badge-quality">Mixed Qualities</span>
      </div>
    `;
    list.appendChild(listHeader);

    // Render individual link items
    postGroup.links.forEach(link => {
      const row = document.createElement("div");

      const status = linkStatuses[link.url] || 'unchecked';
      const isAlbum = isBunkrAlbumUrl(link.url);
      row.className = `link-item${status === 'offline' ? ' deleted' : ''}${isAlbum ? ' link-item-album' : ''}`;
      row.setAttribute('data-url', link.url);

      const isSelected = selectedLinkUrls.has(link.url);
      const isResolvable = isLinkResolvable(link.host, link.url);
      const resolved = resolvedBunkrLinks[link.url];
      const albumData = isAlbum ? (albumContents[link.url] || null) : null;

      const displayUrl = resolved ? resolved.name : link.url.split('/').slice(-2).join('/');
      const sizeBadge = resolved
        ? `<span class="badge badge-size" style="background: rgba(59, 130, 246, 0.2); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3); font-size: 9px; padding: 2px 6px;">${resolved.size}</span>`
        : (isResolvable ? `<span class="badge badge-size bunkr-pending" data-url="${link.url}" style="background: rgba(255, 255, 255, 0.05); color: #9ca3af; border: 1px solid rgba(255, 255, 255, 0.1); font-size: 9px; padding: 2px 6px;">Resolving...</span>` : "");

      const durationBadge = (resolved && resolved.durationFormatted)
        ? `<span class="badge badge-duration" style="background: rgba(168, 85, 247, 0.2); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.3); font-size: 9px; padding: 2px 6px;">⏱ ${resolved.durationFormatted}</span>`
        : "";

      const albumBadge = isAlbum
        ? `<span class="badge" style="background: rgba(251,191,36,0.18); color: #fbbf24; border: 1px solid rgba(251,191,36,0.35); font-size: 9px; padding: 2px 6px;">📁 ALBUM</span>`
        : "";

      const albumItemCount = (albumData && !albumData.loading && albumData.items.length > 0)
        ? `<span class="badge" style="background: rgba(34,197,94,0.15); color: #4ade80; border: 1px solid rgba(34,197,94,0.3); font-size: 9px; padding: 2px 6px;">${albumData.items.length} súborov</span>`
        : (albumData && albumData.loading ? `<span class="badge" style="font-size:9px;padding:2px 6px;color:#9ca3af">Načítavam...</span>` : "");

      let dotTooltip = "Unchecked";
      if (status === 'online') dotTooltip = "Online";
      if (status === 'offline') dotTooltip = "Deleted / Offline";
      if (status === 'checking') dotTooltip = "Checking status...";

      const expandBtn = isAlbum ? `
        <button class="row-expand-btn" data-url="${link.url}" title="Zobraziť obsah albumu" style="background: rgba(251,191,36,0.12); border: 1px solid rgba(251,191,36,0.3); color: #fbbf24; cursor: pointer; padding: 3px 7px; border-radius: 4px; font-size: 10px; display:flex; align-items:center; gap:3px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
          Expand
        </button>` : '';

      row.innerHTML = `
        <div class="link-item-title-row">
          <label class="custom-checkbox" style="margin: 0;">
            <input type="checkbox" class="link-checkbox" data-url="${link.url}" ${isSelected ? "checked" : ""}>
            <span class="checkmark" style="height: 16px; width: 16px; margin-right: 8px;"></span>
          </label>
          <span class="status-dot ${status}" title="${dotTooltip}" style="flex-shrink: 0;"></span>
        </div>

        <div class="link-item-left">
          <a href="${link.url}" target="_blank" class="link-item-title" title="${link.url}">${displayUrl}</a>
          <div class="link-item-meta">
            <span class="badge badge-host ${link.host}" style="font-size: 9px; padding: 2px 6px;">${link.host}</span>
            ${albumBadge}
            ${!isAlbum ? `<span class="badge badge-quality" style="font-size: 9px; padding: 2px 6px;">${link.quality.replace("Unknown Quality", "Unknown")}</span>` : ''}
            ${sizeBadge}${durationBadge}${albumItemCount}
          </div>
        </div>

        <div style="display: flex; gap: 4px; align-items:center;">
          ${expandBtn}
          <button class="row-check-btn" data-url="${link.url}" title="Check Status" style="background: transparent; border: none; color: var(--text-muted); cursor: pointer; padding: 4px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><polyline points="11 8 11 12 14 12"/></svg>
          </button>
          <button class="row-copy-btn" data-url="${link.url}" title="Copy URL" style="background: transparent; border: none; color: var(--text-muted); cursor: pointer; padding: 4px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
          </button>
        </div>
      `;

      // Album expand panel (initially hidden, toggled by expand button)
      if (isAlbum) {
        const expandPanel = document.createElement('div');
        expandPanel.className = 'album-expand-panel';
        expandPanel.setAttribute('data-album-url', link.url);
        expandPanel.style.cssText = 'display:none; margin-top:6px; background:rgba(251,191,36,0.05); border:1px solid rgba(251,191,36,0.2); border-radius:6px; padding:8px; max-height:220px; overflow-y:auto;';
        renderAlbumPanel(expandPanel, link.url);
        row.appendChild(expandPanel);
      }

      if (isResolvable && !resolved) {
        queueBunkrResolve(link.url);
      }

      // Start album prefetch immediately when card renders
      if (isAlbum && !albumContents[link.url]) {
        fetchBunkrAlbumContents(link.url);
      }

      // Expand album panel
      if (isAlbum) {
        row.querySelector('.row-expand-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          const panel = row.querySelector('.album-expand-panel');
          const isOpen = panel.style.display !== 'none';
          panel.style.display = isOpen ? 'none' : 'block';
          if (!isOpen) renderAlbumPanel(panel, link.url);
        });
      }

      // Check individual link status
      row.querySelector(".row-check-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        checkLinkStatus(link.url);
      });

      // Copy individual link
      row.querySelector(".row-copy-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(link.url);
        showToast("Link copied to clipboard!");
      });

      // Individual link checkbox event
      row.querySelector(".link-checkbox").addEventListener("change", (e) => {
        const checked = e.target.checked;
        if (checked) {
          selectedLinkUrls.add(link.url);
        } else {
          selectedLinkUrls.delete(link.url);
        }

        // Sync header checkbox
        const siblingChecks = list.querySelectorAll(".link-checkbox");
        const allChecked = Array.from(siblingChecks).every(cb => cb.checked);
        listHeader.querySelector(".group-checkbox").checked = allChecked;
        updateToolbarState();
      });

      list.appendChild(row);
    });

    // Group checkbox event
    listHeader.querySelector(".group-checkbox").addEventListener("change", (e) => {
      const checked = e.target.checked;
      const groupUrls = JSON.parse(e.target.getAttribute("data-urls"));
      
      groupUrls.forEach(url => {
        if (checked) {
          selectedLinkUrls.add(url);
        } else {
          selectedLinkUrls.delete(url);
        }
      });

      // Update UI for this group
      const checkboxes = list.querySelectorAll(".link-checkbox");
      checkboxes.forEach(cb => {
        cb.checked = checked;
      });
      
      updateToolbarState();
    });

    card.appendChild(list);
    container.appendChild(card);
  });
}

// Update stats dashboard cards
function updateStats() {
  const flatLinks = [];
  filteredLinks.forEach(post => {
    post.links.forEach(l => {
      flatLinks.push(l.url);
    });
  });

  const uniqueLinksSet = new Set(flatLinks);
  
  document.getElementById("stat-total-links").textContent = flatLinks.length;
  document.getElementById("stat-unique-links").textContent = uniqueLinksSet.size;
  document.getElementById("stat-pages-crawled").textContent = processedPagesSet.size;
  
  updateSelectedCount();
}

function updateSelectedCount() {
  const flatFilteredUrls = [];
  filteredLinks.forEach(post => {
    post.links.forEach(l => {
      flatFilteredUrls.push(l.url);
    });
  });

  // Intersect selected with currently filtered
  const activeSelectedCount = flatFilteredUrls.filter(url => selectedLinkUrls.has(url)).length;
  
  document.getElementById("selected-count").textContent = activeSelectedCount;

  // Sync main select all checkbox
  const mainCheckbox = document.getElementById("select-all-checkbox");
  if (flatFilteredUrls.length > 0 && activeSelectedCount === flatFilteredUrls.length) {
    mainCheckbox.checked = true;
    mainCheckbox.indeterminate = false;
  } else if (activeSelectedCount > 0) {
    mainCheckbox.checked = false;
    mainCheckbox.indeterminate = true;
  } else {
    mainCheckbox.checked = false;
    mainCheckbox.indeterminate = false;
  }
}

// Export formatted lists to Clipboard
function exportSelectedLinks(format) {
  // Collect selected links in sorted order matching DOM
  const selectedLinks = [];
  filteredLinks.forEach(post => {
    post.links.forEach(l => {
      if (selectedLinkUrls.has(l.url)) {
        selectedLinks.push(l);
      }
    });
  });

  if (selectedLinks.length === 0) {
    showToast("No links selected for export!");
    return;
  }

  let outputText = "";

  if (format === "raw") {
    // Just the URLs, one per line
    outputText = selectedLinks.map(l => l.url).join("\n");
  } 
  
  else if (format === "jdownloader") {
    // JDownloader .crawljob JSON format
    const jobs = [];
    
    // Group selected links by their context
    const grouped = {};
    selectedLinks.forEach(l => {
      if (!grouped[l.context]) grouped[l.context] = [];
      grouped[l.context].push(l.url);
    });

    for (const [context, urls] of Object.entries(grouped)) {
      jobs.push({
        packageName: context === "General Link" ? threadTitle : context,
        text: urls.join("\n"),
        extractAfterDownload: true,
        autoStart: false
      });
    }

    outputText = JSON.stringify(jobs, null, 2);
  } 
  
  else if (format === "markdown") {
    // Markdown Table
    outputText = `| Post Context (Origin) | Quality / Type | Host | Link URL |\n| :--- | :--- | :--- | :--- |\n`;
    selectedLinks.forEach(l => {
      outputText += `| ${l.context} | ${l.quality} | ${l.host.toUpperCase()} | ${l.url} |\n`;
    });
  } 
  
  else if (format === "json") {
    // Complete JSON payload
    outputText = JSON.stringify(selectedLinks, null, 2);
  }

  // Copy to clipboard
  navigator.clipboard.writeText(outputText)
    .then(() => {
      showToast(`${selectedLinks.length} links copied in ${format.toUpperCase()} format!`);
    })
    .catch(err => {
      console.error("Clipboard copy error:", err);
      showToast("Clipboard write permission blocked!");
    });
}

// Send Selected Links directly to Nexus local Intake API
function importToNexus() {
  const selectedLinks = [];
  filteredLinks.forEach(post => {
    post.links.forEach(l => {
      if (selectedLinkUrls.has(l.url)) {
        selectedLinks.push(l);
      }
    });
  });

  if (selectedLinks.length === 0) {
    showToast("No links selected to import!");
    return;
  }

  showLoader("Importing to Nexus Dashboard...");

  // Build IntakeImportRequest candidates payload
  // For bunkr albums with fetched contents: expand to individual files
  const candidates = [];
  selectedLinks.forEach(l => {
    if (isBunkrAlbumUrl(l.url)) {
      const alb = albumContents[l.url];
      if (alb && !alb.loading && alb.items.length > 0) {
        alb.items.forEach(f => {
          candidates.push({
            title: f.name || f.url.split('/').pop(),
            url: f.url,
            source_url: f.url,
            source: 'bunkr',
            tags: ['scraped', 'chrome_extension', 'album', l.postAuthor || ''].filter(Boolean),
            categories: []
          });
        });
        return;
      }
    }
    candidates.push({
      title: l.context === "General Link" ? `${threadTitle} (Scraped)` : l.context,
      url: l.url,
      source_url: l.url,
      source: l.host,
      tags: ["scraped", "chrome_extension", l.postAuthor],
      categories: [l.quality]
    });
  });

  const payload = {
    urls: [],
    candidates: candidates,
    batch_name: `Hunter: ${threadTitle}`,
    source_mode: "mixed",
    min_quality: 0,
    min_duration: 0,
    auto_metadata: true,
    playwright_fallback: true
  };

  fetchWithTimeout(`${nexusBackendUrl}/api/v1/intake/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  }, 12000)
    .then(res => {
      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }
      return res.json();
    })
    .then(data => {
      hideLoader();
      showToast(`Successfully created Import Job on Nexus!`);
      console.log("Nexus import success:", data);
    })
    .catch(err => {
      hideLoader();
      console.error("Nexus import failed:", err);
      showToast(`Import failed: ${err.message}`);
    });
}

// Returns flat array of link objects that are currently selected (by selectedLinkUrls Set)
function getSelectedLinks() {
  const result = [];
  filteredLinks.forEach(postGroup => {
    (postGroup.links || []).forEach(link => {
      if (selectedLinkUrls.has(link.url)) {
        result.push({
          url: link.url,
          host: link.host || "other",
          text: link.text || link.url,
          context: link.context || link.origin || "",
          quality: link.quality || "",
          postAuthor: postGroup.author || "",
          postId: postGroup.postId || "",
          timestamp: postGroup.timestamp || ""
        });
      }
    });
  });
  return result;
}

// Push selected links to Nexus Hunter Intake (/api/v1/hunter/push) and open Link Tester
async function sendSelectedToTester() {
  // Build list: selected links first, else all filtered links
  let linksToPush = getSelectedLinks();

  if (linksToPush.length === 0) {
    // Fallback: all visible links across all post groups
    filteredLinks.forEach(postGroup => {
      (postGroup.links || []).forEach(link => {
        linksToPush.push({
          url: link.url,
          host: link.host || "other",
          text: link.text || link.url,
          context: link.context || link.origin || "",
          quality: link.quality || "",
          postAuthor: postGroup.author || "",
          postId: postGroup.postId || "",
          timestamp: postGroup.timestamp || ""
        });
      });
    });
  }

  if (linksToPush.length === 0) {
    showToast("Žiadne odkazy na odoslanie do Testera!", "warn");
    return;
  }

  const testerBtn = document.getElementById("send-to-tester-btn");
  const origHtml = testerBtn ? testerBtn.innerHTML : "";
  if (testerBtn) {
    testerBtn.disabled = true;
    testerBtn.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;"></span> Odosielam...`;
  }

  const payload = {
    thread_title: threadTitle || "Link Hunter Session",
    thread_url: activeTabUrl || "",
    links: linksToPush
  };

  // Skús aktívny port, potom fallback
  const portsToTry = nexusBackendUrl
    ? [nexusBackendUrl]
    : ["http://localhost:8000", "http://localhost:8001"];

  let successUrl = null;
  let hunterSessionId = null;

  for (const baseUrl of portsToTry) {
    try {
      addLog(`Odosielam ${linksToPush.length} odkazov do Link Testeru na ${baseUrl}...`, "info");
      const res = await fetchWithTimeout(`${baseUrl}/api/v1/hunter/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }, 12000);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      if (!data.session_id) throw new Error('Nexus nevrátil ID dávky; aktualizuj backend.');
      hunterSessionId = data.session_id;
      addLog(`[SUCCESS] Uložených ${data.count || linksToPush.length} odkazov! Otváram ${baseUrl}/tester...`, "success");
      showToast(`Odoslaných ${linksToPush.length} odkazov do Link Testeru!`);
      successUrl = baseUrl;
      break;
    } catch (err) {
      addLog(`Port ${baseUrl} nedostupný: ${err.message}`, "warn");
    }
  }

  if (successUrl) {
    const testerUrl = `${successUrl}/tester?hunter=1&session=${encodeURIComponent(hunterSessionId)}&autostart=1`;
    try {
      if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.create) {
        chrome.tabs.create({ url: testerUrl });
      } else {
        window.open(testerUrl, "_blank");
      }
    } catch(e) {
      window.open(testerUrl, "_blank");
    }
  } else {
    showToast("Nepodarilo sa spojiť s Nexus backendom (8000/8001). Je server spustený?", "error");
    addLog("Chyba: Nexus backend nedostupný na žiadnom porte.", "error");
  }

  if (testerBtn) {
    testerBtn.disabled = false;
    testerBtn.innerHTML = origHtml;
  }
}

// UI Loader Controls
function showLoader(message = "Processing...") {
  const btn = document.getElementById("start-crawl-btn");
  btn.disabled = true;
  btn.querySelector("span").textContent = message;
  
  // Show progress bar
  document.getElementById("crawl-progress-container").classList.remove("hidden");
}

function hideLoader() {
  const btn = document.getElementById("start-crawl-btn");
  btn.disabled = false;
  
  const activeScopeBtn = document.querySelector(".segment-btn.active");
  const scope = activeScopeBtn ? activeScopeBtn.getAttribute("data-scope") : "current";
  
  const span = btn.querySelector("span");
  if (scope === "range") {
    span.textContent = "Scan Page Range";
  } else if (scope === "all") {
    span.textContent = "Scan Entire Thread";
  } else {
    span.textContent = "Scan Current Page";
  }
  
  // Hide progress bar
  document.getElementById("crawl-progress-container").classList.add("hidden");
}

// Crawl Progress Bar controls
function setupProgress(start, end) {
  const fill = document.getElementById("crawl-progress-fill");
  const pct = document.getElementById("crawl-percentage");
  const text = document.getElementById("crawl-status-text");
  
  fill.style.width = "0%";
  pct.textContent = "0%";
  text.textContent = `Ready...`;
}

function updateProgress(currentPage, start, end) {
  const total = end - start + 1;
  const current = currentPage - start;
  const percent = Math.round((current / total) * 100);
  
  const fill = document.getElementById("crawl-progress-fill");
  const pct = document.getElementById("crawl-percentage");
  const text = document.getElementById("crawl-status-text");
  
  fill.style.width = `${percent}%`;
  pct.textContent = `${percent}%`;
  text.textContent = `Crawling page ${currentPage} of ${end}...`;
}

// Toast notification trigger
function showToast(message) {
  const toast = document.getElementById("toast-notification");
  document.getElementById("toast-message").textContent = message;
  
  toast.classList.remove("hidden");
  
  setTimeout(() => {
    toast.classList.add("hidden");
  }, 4000);
}

// ==========================================
// PURE DOM PARSING ENGINE (from content.js)
// Allows parsing subpages completely in the dashboard
// ==========================================
function scrapePageData(doc, currentUrl) {
  const threadTitle = getThreadTitle(doc);
  const pagination = getPagination(doc, currentUrl);
  const posts = [];

  // Enhanced XenForo and generic post containers
  let postElements = doc.querySelectorAll('article.message, [data-content^="post-"], .message--post, .message-inner, .post-container, .postbit, .post');
  if (postElements.length === 0) {
    postElements = [doc.body];
  }

  postElements.forEach((postEl, postIndex) => {
    const author = getPostAuthor(postEl, postIndex);
    const postId = getPostId(postEl, postIndex, pagination.currentPage || 1);
    const postUrl = getPostUrl(postEl, currentUrl);
    const timestamp = getPostTimestamp(postEl);
    
    const bodyEl = postEl.querySelector('.message-body, .post-body, .message-content, .entry-content, .bbWrapper') || postEl;
    if (!bodyEl) return;

    const postLinks = [];

    function addLink(url, defaultText, element) {
      if (!url) return;

      // Clean trailing punctuation
      url = url.trim().replace(/[.,;:!?]+$/, '');

      // Klasifikácia hosta
      let host = "other";
      for (const [key, regex] of Object.entries(hostRegexes)) {
        if (regex.test(url)) {
          host = key;
          break;
        }
      }
      
      // Secondary fallback for direct video / image extensions if host is "other"
      if (host === "other") {
        if (/\.(mp4|m4v|webm|mov|mkv|avi|flv|wmv)($|\?)/i.test(url)) {
          host = "direct_video";
        } else if (/\.(jpg|jpeg|png|gif|webp|bmp)($|\?)/i.test(url)) {
          host = "direct_image";
        }
      }

      // Skip navigation, profile, thread, and forum internal links
      if (host === "other" && (
        url.includes('/threads/') ||
        url.includes('/members/') ||
        url.includes('/forums/') ||
        url.includes('/posts/') ||
        url.includes('javascript:') ||
        url.includes('/tags/') ||
        url.includes('/search/') ||
        url.includes('/account/') ||
        url.includes('/login') ||
        url.includes('/misc/') ||
        url.includes('/help/') ||
        url.includes('/support/') ||
        url.includes('/whats-new/') ||
        url.includes('/watched/') ||
        url.includes('/find-threads/') ||
        url.includes('/direct-messages/') ||
        url.includes('/online/') ||
        url.includes('/goto/') ||
        url.includes('/redirect') ||
        url.includes('/link-forums/') ||
        url.match(/simpcity\.[a-z]+\/#/) ||
        url.match(/socialmediagirls\.[a-z]+\/#/) ||
        url === currentUrl
      )) {
        return;
      }

      // Zamedzenie duplicitným URL v tom istom príspevku
      if (postLinks.some(pl => pl.url === url)) return;

      // Extract Context (Origin/Origin context)
      const context = getLinkContext(element, bodyEl);

      postLinks.push({
        url: url,
        host: host,
        text: defaultText || url,
        context: context.origin,
        quality: context.quality,
        postAuthor: author,
        postId: postId,
        timestamp: timestamp
      });
    }

    // Helper to check data- attributes (data-url, data-href, data-proxy-href, etc.)
    function checkElementAttributes(el) {
      if (!el || !el.getAttribute) return;
      const attrs = ['href', 'src', 'data-url', 'data-href', 'data-proxy-href', 'data-target', 'data-link'];
      attrs.forEach(attr => {
        const val = el.getAttribute(attr);
        if (val && !val.startsWith('javascript:')) {
          const resolved = resolveXenforoRedirect(val, currentUrl);
          addLink(resolved, el.textContent ? el.textContent.trim() : resolved, el);
        }
      });
    }

    // 1. Zozbieranie odkazov z <a> tagov
    const links = bodyEl.querySelectorAll('a[href], a[data-url], a[data-href]');
    links.forEach((linkEl) => {
      checkElementAttributes(linkEl);
      const url = resolveXenforoRedirect(linkEl.href || linkEl.getAttribute('data-url') || linkEl.getAttribute('data-href'), currentUrl);
      addLink(url, linkEl.textContent.trim(), linkEl);
    });

    // 2. Zozbieranie odkazov z <iframe> tagov (embedy videí)
    const iframes = bodyEl.querySelectorAll('iframe[src], iframe[data-src]');
    iframes.forEach((iframeEl) => {
      let url = iframeEl.getAttribute('src') || iframeEl.getAttribute('data-src');
      if (!url) return;
      url = resolveXenforoRedirect(url, currentUrl);
      addLink(url, "[Embedded Video]", iframeEl);
    });

    // 3. Zozbieranie odkazov z <img> tagov
    const postThumbnails = [];
    const imgs = bodyEl.querySelectorAll('img[src], img[data-src], img[data-proxy-href]');
    imgs.forEach((imgEl) => {
      const url = imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || imgEl.getAttribute('data-proxy-href');
      if (!url) return;
      const resolved = resolveXenforoRedirect(url, currentUrl);

      if (
        resolved.includes('/styles/') ||
        resolved.includes('/smilies/') ||
        resolved.includes('favicon') ||
        resolved.includes('/avatar/') ||
        resolved.includes('/logo') ||
        resolved.includes('doubleclick.net') ||
        resolved.includes('google')
      ) {
        return;
      }

      if (postThumbnails.length < 4 && !postThumbnails.includes(resolved)) {
        postThumbnails.push(resolved);
      }

      if (resolved.includes('/attachments/')) return;
      addLink(resolved, "[Embedded Image]", imgEl);
    });

    // 4. Extract plain text URLs inside post body HTML/text
    const bodyHtml = bodyEl.innerHTML || bodyEl.textContent || "";
    const rawUrlRegex = /https?:\/\/[^\s"'<>\)\(\]\[]+/gi;
    let textMatch;
    while ((textMatch = rawUrlRegex.exec(bodyHtml)) !== null) {
      let rawUrl = textMatch[0].replace(/[.,;:!?]+$/, '');
      const resolved = resolveXenforoRedirect(rawUrl, currentUrl);
      addLink(resolved, resolved, null);
    }

    if (postLinks.length > 0) {
      let postText = bodyEl.innerText ? bodyEl.innerText.replace(/\s+/g, ' ').trim() : "";
      if (postText.length > 300) postText = postText.substring(0, 300) + '...';

      posts.push({
        postId: postId,
        postUrl: postUrl,
        author: author,
        timestamp: timestamp,
        links: postLinks,
        thumbnails: postThumbnails,
        textContent: postText
      });
    }
  });

  return {
    threadTitle: threadTitle,
    currentUrl: currentUrl,
    pagination: pagination,
    posts: posts
  };
}

function getThreadTitle(doc) {
  const titleEl = doc.querySelector('.p-title-value, h1.p-title-value, h1[class*="title"], title');
  if (titleEl) {
    return titleEl.textContent.trim().replace(/\s*\|\s*Page\s+\d+/i, '').replace(/\s*-\s*Page\s+\d+/i, '');
  }
  return "Unknown Thread";
}

function getPagination(doc, currentUrl) {
  // Strip hash anchor completely (e.g. #post-123) to avoid XenForo redirecting pages to the post's page
  const cleanUrl = (currentUrl || "").split('#')[0];

  const pages = new Set();
  let currentPage = 1;
  let totalPages = 1;

  const pageNavEl = doc.querySelector('.pageNav');
  if (pageNavEl) {
    const pageLinks = pageNavEl.querySelectorAll('.pageNav-page a, .pageNav-main a');
    pageLinks.forEach(a => {
      const pageNum = parseInt(a.textContent.trim(), 10);
      if (!isNaN(pageNum)) {
        pages.add(pageNum);
        if (a.parentElement.classList.contains('pageNav-page--current')) {
          currentPage = pageNum;
        }
      }
    });

    const currentEl = pageNavEl.querySelector('.pageNav-page--current');
    if (currentEl) {
      currentPage = parseInt(currentEl.textContent.trim(), 10);
    }

    if (pages.size > 0) {
      totalPages = Math.max(...pages);
    }
  }

  const pageMatch = cleanUrl.match(/\/page-(\d+)/i) || cleanUrl.match(/[?&]page=(\d+)/i);
  if (pageMatch && currentPage === 1) {
    currentPage = parseInt(pageMatch[1], 10);
  }

  let pageBaseUrl = cleanUrl;
  if (cleanUrl.includes('/page-')) {
    pageBaseUrl = cleanUrl.replace(/\/page-\d+/, '/page-{{page}}');
  } else if (cleanUrl.match(/[?&]page=\d+/)) {
    pageBaseUrl = cleanUrl.replace(/page=\d+/, 'page={{page}}');
  } else {
    if (cleanUrl.includes('?')) {
      pageBaseUrl = cleanUrl + '&page={{page}}';
    } else {
      const rawUrl = cleanUrl.endsWith('/') ? cleanUrl.slice(0, -1) : cleanUrl;
      pageBaseUrl = rawUrl + '/page-{{page}}';
    }
  }

  return {
    currentPage: currentPage,
    totalPages: totalPages || currentPage,
    pageBaseUrl: pageBaseUrl
  };
}

function getPostAuthor(postEl, fallbackIndex) {
  const authorEl = postEl.querySelector('.message-name, .username, [data-user-id] .username, .message-user .message-name a');
  if (authorEl) {
    return authorEl.textContent.trim();
  }
  return `User #${fallbackIndex + 1}`;
}

function getPostId(postEl, fallbackIndex, pageNum) {
  let rawId = "";
  
  // 1. Najprv skúsime data-content atribút, ktorý je v XenForo najspoľahlivejší
  const contentAttr = postEl.getAttribute('data-content');
  if (contentAttr) {
    rawId = contentAttr.replace('post-', '');
  } else {
    // 2. Skúsime postEl.id (napr. js-post-12345)
    const idAttr = postEl.id;
    if (idAttr && idAttr.startsWith('js-post-')) {
      rawId = idAttr.replace('js-post-', '');
    } else {
      // 3. Skúsime nájsť odkaz s číslom príspevku (napr. #3), ktorý začína na '#' a má text
      const idEl = Array.from(postEl.querySelectorAll('.message-attribution-opposite a'))
        .find(el => el.textContent.trim().startsWith('#'));
      if (idEl) {
        rawId = idEl.textContent.trim().replace(/^#/, '');
      } else {
        // 4. Fallback na index príspevku
        rawId = `post-${fallbackIndex + 1}`;
      }
    }
  }

  // Prepend page number to make it globally unique across thread pages
  return `p${pageNum}-${rawId}`;
}

function getPostUrl(postEl, currentUrl) {
  const permalinkEl = postEl.querySelector('.message-attribution-opposite a[href*="post-"], .message-attribution-opposite a[data-xf-init="share-tooltip"]');
  if (permalinkEl) {
    const href = permalinkEl.getAttribute('href');
    if (href && href.startsWith('http')) return href;
    const threadUrl = currentUrl.split('#')[0].replace(/\/page-\d+/i, '');
    try {
      const origin = new URL(threadUrl).origin;
      return href.startsWith('/') ? origin + href : origin + '/' + href;
    } catch (e) {
      return href;
    }
  }
  const rawIdAttr = postEl.getAttribute('data-content') || (postEl.id && postEl.id.replace('js-', ''));
  if (rawIdAttr) {
    const threadUrl = currentUrl.split('#')[0].replace(/\/page-\d+/i, '');
    return `${threadUrl}#${rawIdAttr}`;
  }
  return currentUrl;
}

function getPostTimestamp(postEl) {
  const timeEl = postEl.querySelector('.message-attribution-main time, time.u-dt');
  if (timeEl) {
    return timeEl.getAttribute('datetime') || timeEl.textContent.trim();
  }
  return "Unknown Time";
}

function getLinkContext(linkEl, bodyEl) {
  let origin = "General Link";
  let quality = "Unknown Quality";

  const qualityRegex = /(2160p|4k|1080p|720p|480p|photoset|photos?|zip|rar)/i;
  const sizeRegex = /(\d+h\s*\d*m?i?n?|\d+\s*min|\d+(?:\.\d+)?\s*(?:GB|MB)).*?(2160p|4k|1080p|720p|480p)/i;

  // Collect all text nodes from body in document order
  const allTextBlocks = [];
  function collectTextBlocks(el) {
    if (!el) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.trim();
        if (text.length > 1) allTextBlocks.push({ node, text });
      }
    }
  }
  collectTextBlocks(bodyEl);

  const linkPos = (linkEl && typeof linkEl.contains === 'function') ? allTextBlocks.findIndex(b => {
    try { return linkEl.contains(b.node) || linkEl === b.node.parentElement; }
    catch(e) { return false; }
  }) : -1;

  const precedingBlocks = linkPos > 0
    ? allTextBlocks.slice(Math.max(0, linkPos - 15), linkPos)
    : allTextBlocks.slice(0, Math.min(15, allTextBlocks.length));

  const precedingTexts = precedingBlocks
    .map(b => b.text.replace(/[\r\n\t]+/g, ' ').trim())
    .filter(t => t.length > 1 && !t.startsWith('http') && !t.startsWith('www.'));

  // Check unfurl block title (filester link preview)
  let unfurlTitle = "";
  const unfurlBlock = (linkEl && typeof linkEl.closest === 'function') ? linkEl.closest('.bbCodeBlock--unfurl') : null;
  if (unfurlBlock) {
    const titleEl = unfurlBlock.querySelector('.js-unfurl-title a, .contentRow-header a');
    if (titleEl) unfurlTitle = titleEl.textContent.trim().replace(/\.[a-z0-9]{2,4}$/i, '').trim();
  }

  // Extract quality from preceding text
  for (const text of [...precedingTexts].reverse()) {
    if (quality === "Unknown Quality") {
      const sm = text.match(sizeRegex);
      if (sm && sm[2]) { quality = sm[2].toUpperCase(); break; }
      const qm = text.match(qualityRegex);
      if (qm) { quality = qm[1].toUpperCase(); break; }
    }
  }

  const skipPatterns = /^(download|stream|source quality|upload|link|mirror|\[source|quality\])/i;
  const isQualitySizeLine = t => /\d+(?:h|min|GB|MB)/i.test(t) || qualityRegex.test(t);

  if (unfurlTitle && unfurlTitle.length > 3) {
    const descLines = precedingTexts.filter(t =>
      !isQualitySizeLine(t) && !skipPatterns.test(t) && t.length > 10 &&
      !t.match(/^\d{1,2}-\d{1,2}-\d{2,4}$/)
    );
    origin = descLines.length > 0 ? descLines[descLines.length - 1] : unfurlTitle;
  } else {
    const descLines = precedingTexts.filter(t =>
      !isQualitySizeLine(t) && !skipPatterns.test(t) && t.length > 5 &&
      !t.match(/^\d{1,2}-\d{1,2}-\d{2,4}$/)
    );
    if (descLines.length > 0) origin = descLines[descLines.length - 1];
  }

  if (quality === "Unknown Quality") {
    const textContext = (origin + " " + (linkEl ? (linkEl.textContent || linkEl.src || "") : "")).toLowerCase();
    if (textContext.includes("2160p") || textContext.includes("4k")) quality = "2160P";
    else if (textContext.includes("1080p")) quality = "1080P";
    else if (textContext.includes("720p")) quality = "720P";
    else if (textContext.includes("480p")) quality = "480P";
    else if (/photo|zip|rar|set/i.test(textContext)) quality = "Photoset";
  }

  if (quality !== "Unknown Quality") {
    if (quality === "4K") quality = "2160P";
    if (!quality.endsWith("P") && /^\d{3,4}p$/i.test(quality)) quality = quality.toUpperCase();
  }

  origin = origin.replace(/[\:\-\=\s]+$/, '').trim();
  if (origin.length > 120) origin = origin.substring(0, 117) + "...";
  if (origin.length < 3) origin = "General Link";

  return { origin, quality };
}

/**
 * In-place DOM and State update for successfully resolved Bunkr links
 */
function updateBunkrRowUI(url, name, size) {
  const escapedUrl = url.replace(/["\\]/g, '\\$&');
  const checkbox = document.querySelector(`.link-checkbox[data-url="${escapedUrl}"]`);
  if (checkbox) {
    const row = checkbox.closest('.link-row');
    if (row) {
      const linkEl = row.querySelector('.link-url');
      if (linkEl) {
        linkEl.textContent = name;
        linkEl.title = url;
      }
      
      const pendingBadge = row.querySelector('.bunkr-pending');
      if (pendingBadge) {
        pendingBadge.className = "badge badge-size";
        pendingBadge.style.background = "rgba(59, 130, 246, 0.2)";
        pendingBadge.style.color = "#60a5fa";
        pendingBadge.style.border = "1px solid rgba(59, 130, 246, 0.3)";
        pendingBadge.textContent = size;
      }
    }
  }
  
  // Update memory state so filters and copies keep clean resolved details
  allScrapedPosts.forEach(post => {
    post.links.forEach(l => {
      if (l.url === url) {
        l.text = name;
        l.context = name;
      }
    });
  });
}

/**
 * Concurrent-limited queue runner for Bunkr resolves
 */
function processResolveQueue() {
  if (resolveQueue.length === 0 || activeResolves.size >= MAX_CONCURRENT_RESOLVES) return;
  
  const url = resolveQueue.shift();
  if (resolvedBunkrLinks[url] || activeResolves.has(url)) {
    setTimeout(processResolveQueue, 50);
    return;
  }
  
  activeResolves.add(url);
  
  // Špeciálne ošetrenie pre Pixeldrain cez ich API
  if (url.includes('pixeldrain.com/')) {
    let apiUrl = "";
    let isList = false;
    
    const uMatch = url.match(/pixeldrain\.com\/u\/([a-zA-Z0-9_-]+)/i);
    const lMatch = url.match(/pixeldrain\.com\/l\/([a-zA-Z0-9_-]+)/i);
    
    if (uMatch) {
      apiUrl = `https://pixeldrain.com/api/file/${uMatch[1]}/info`;
    } else if (lMatch) {
      apiUrl = `https://pixeldrain.com/api/list/${lMatch[1]}`;
      isList = true;
    }
    
    if (apiUrl) {
      fetch(apiUrl)
        .then(res => {
          if (!res.ok) throw new Error("Status " + res.status);
          return res.json();
        })
        .then(data => {
          let name = "";
          let size = "Unknown Size";
          
          if (isList) {
            name = data.title || `Pixeldrain List ${data.id}`;
            if (data.files && Array.isArray(data.files)) {
              const totalBytes = data.files.reduce((sum, f) => sum + (f.size || 0), 0);
              size = formatBytes(totalBytes);
              name = `${name} (${data.files.length} files)`;
            }
          } else {
            name = data.name || `Pixeldrain File ${data.id}`;
            size = formatBytes(data.size || 0);
          }
          
          resolvedBunkrLinks[url] = { name: name, size: size };
          activeResolves.delete(url);
          updateBunkrRowUI(url, name, size);
          setTimeout(processResolveQueue, 100);
        })
        .catch(err => {
          console.warn("Failed to resolve Pixeldrain link via API:", url, err);
          fetchHTMLResolveFallback(url);
        });
      return;
    }
  }
  
  // Všetky ostatné hosty (Bunkr, Whoreshub, Turbo, atď.) idú cez bežný HTML fallback
  fetchHTMLResolveFallback(url);
}

/**
 * Enqueues a Bunkr URL for resolution
 */
function queueBunkrResolve(url) {
  if (resolvedBunkrLinks[url] || activeResolves.has(url) || resolveQueue.includes(url)) return;
  resolveQueue.push(url);
  processResolveQueue();
}

function renderAlbumPanel(panel, albumUrl) {
  const data = albumContents[albumUrl];
  if (!data || data.loading) {
    panel.innerHTML = `<div style="color:#9ca3af;font-size:11px;text-align:center;padding:8px;">Načítavam obsah albumu…</div>`;
    return;
  }
  if (data.error || data.items.length === 0) {
    panel.innerHTML = `
      <div style="color:#f87171;font-size:11px;text-align:center;padding:8px;">
        ${data.error ? 'Nepodarilo sa načítať obsah albumu.' : 'Album je prázdny alebo nedostupný.'}
      </div>
      <div style="text-align:center;margin-top:4px;">
        <a href="${albumUrl}" target="_blank" style="color:#fbbf24;font-size:10px;">Otvoriť album ↗</a>
      </div>`;
    return;
  }

  const allSelected = data.items.every(f => selectedLinkUrls.has(f.url));
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
      <span style="font-size:10px;color:#fbbf24;font-weight:600;">📁 ${data.items.length} súborov v albume</span>
      <div style="display:flex;gap:6px;">
        <button class="album-select-all-btn" style="font-size:9px;padding:2px 8px;background:rgba(251,191,36,0.15);border:1px solid rgba(251,191,36,0.3);color:#fbbf24;border-radius:3px;cursor:pointer;">
          ${allSelected ? 'Zrušiť všetko' : 'Vybrať všetko'}
        </button>
        <button class="album-import-btn" style="font-size:9px;padding:2px 8px;background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.3);color:#4ade80;border-radius:3px;cursor:pointer;">
          Import všetkých
        </button>
      </div>
    </div>
    <div class="album-file-list">
      ${data.items.map(f => {
        const sel = selectedLinkUrls.has(f.url);
        const fname = f.name || f.url.split('/').pop();
        return `<div class="album-file-row" style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
          <label style="display:flex;align-items:center;gap:4px;flex:1;min-width:0;cursor:pointer;">
            <input type="checkbox" class="album-file-cb" data-url="${f.url}" ${sel ? 'checked' : ''} style="width:12px;height:12px;flex-shrink:0;">
            <span style="font-size:10px;color:#e5e7eb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${f.url}">${fname}</span>
          </label>
          <a href="${f.url}" target="_blank" style="color:#9ca3af;flex-shrink:0;" title="Otvoriť">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </a>
        </div>`;
      }).join('')}
    </div>`;

  // Select all / deselect all
  panel.querySelector('.album-select-all-btn').addEventListener('click', () => {
    const allNowSelected = data.items.every(f => selectedLinkUrls.has(f.url));
    data.items.forEach(f => allNowSelected ? selectedLinkUrls.delete(f.url) : selectedLinkUrls.add(f.url));
    updateToolbarState();
    renderAlbumPanel(panel, albumUrl);
  });

  // Import all album files directly
  panel.querySelector('.album-import-btn').addEventListener('click', async () => {
    const btn = panel.querySelector('.album-import-btn');
    btn.disabled = true;
    btn.textContent = 'Importujem...';
    const candidates = data.items.map(f => ({
      title: f.name || f.url.split('/').pop(),
      url: f.url,
      source_url: f.url,
      source: 'bunkr',
      tags: ['scraped', 'album'],
      categories: []
    }));
    try {
      const resp = await fetch(`${nexusBackendUrl}/api/v1/intake/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: [], candidates, batch_name: `Album: ${resolvedBunkrLinks[albumUrl]?.name || albumUrl.split('/').pop()}`, source_mode: 'mixed', min_quality: 0, min_duration: 0, auto_metadata: true, playwright_fallback: false })
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      showToast(`Album importovaný: ${data.items.length} súborov odoslaných.`);
    } catch (e) {
      showToast('Import albumu zlyhal: ' + e.message);
    }
    btn.disabled = false;
    btn.textContent = 'Import všetkých';
  });

  // Individual file checkboxes
  panel.querySelectorAll('.album-file-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      cb.checked ? selectedLinkUrls.add(cb.dataset.url) : selectedLinkUrls.delete(cb.dataset.url);
      updateToolbarState();
    });
  });
}

function isBunkrAlbumUrl(url) {
  return /bunkr\.[a-z0-9-]+\/a\//i.test(url);
}

async function fetchBunkrAlbumContents(albumUrl) {
  if (albumContents[albumUrl]) return albumContents[albumUrl];
  albumContents[albumUrl] = { items: [], loading: true, error: false };

  try {
    const res = await fetch(albumUrl);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const items = [];
    // Bunkr album: each file is a <figure> or <div> with a link to /f/ or /v/
    const fileLinks = doc.querySelectorAll('a[href*="/f/"], a[href*="/v/"], a[href*="/d/"]');
    const seen = new Set();
    fileLinks.forEach(a => {
      const href = a.getAttribute('href') || '';
      if (!href || seen.has(href)) return;
      seen.add(href);
      const fullUrl = href.startsWith('http') ? href : new URL(href, albumUrl).href;
      // Try to get name from nearest text / data attributes
      const nameEl = a.querySelector('.filename, .name, [data-name]') || a;
      let name = a.getAttribute('data-name') || nameEl.textContent.trim() || fullUrl.split('/').pop();
      if (!name || name.length < 2) name = fullUrl.split('/').pop();
      items.push({ url: fullUrl, name });
    });

    // Fallback: look for <tr class="file-row"> pattern
    if (items.length === 0) {
      doc.querySelectorAll('tr[data-id]').forEach(tr => {
        const id = tr.getAttribute('data-id');
        if (!id || seen.has(id)) return;
        seen.add(id);
        const nameEl = tr.querySelector('.filename, td');
        const name = nameEl ? nameEl.textContent.trim() : id;
        items.push({ url: `https://bunkr.cr/f/${id}`, name });
      });
    }

    albumContents[albumUrl] = { items, loading: false, error: false };
  } catch (e) {
    console.warn('[album] fetch failed', albumUrl, e);
    albumContents[albumUrl] = { items: [], loading: false, error: true };
  }

  // Re-render so the expand panel updates
  applyFilters();
  return albumContents[albumUrl];
}

/**
 * Resolves XenForo redirect URLs, decoding the 'to' parameter from Base64 if needed.
 */
function resolveXenforoRedirect(url, baseUrl) {
  if (!url) return url;

  try {
    let current = url.trim();

    // 1. Handle relative URLs and chrome-extension:// URLs
    if ((current.startsWith('/') || current.startsWith('chrome-extension://')) && baseUrl) {
      try {
        let pathname = current;
        if (current.startsWith('chrome-extension://')) {
          const uObj = new URL(current);
          pathname = uObj.pathname + uObj.search;
        }
        current = new URL(pathname, baseUrl).href;
      } catch (e) {}
    } else if (current.startsWith('/')) {
      const origin = typeof window !== 'undefined' && window.location && window.location.origin ? window.location.origin : 'https://forums.socialmediagirls.com';
      current = new URL(current, origin).href;
    }

    // 2. Loop up to 3 iterations to unwrap nested redirects / proxies
    for (let depth = 0; depth < 3; depth++) {
      let unwrapped = null;

      try {
        const u = new URL(current);

        // Check common redirect/proxy query parameters: to, url, link, target, dest, out, u, href, path
        const params = ['to', 'url', 'link', 'target', 'dest', 'out', 'u', 'href', 'path'];
        for (const p of params) {
          const val = u.searchParams.get(p);
          if (val) {
            const decoded = decodeURIComponent(val).trim();
            if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
              unwrapped = decoded;
              break;
            }
            // Try Base64 decoding
            try {
              let cleanB64 = decoded.replace(/[\s\=]+$/, '');
              while (cleanB64.length % 4) cleanB64 += '=';
              const b64Decoded = atob(cleanB64).trim();
              if (b64Decoded.startsWith('http://') || b64Decoded.startsWith('https://')) {
                unwrapped = b64Decoded;
                break;
              }
            } catch (e) {}
          }
        }

        // Check for embedded Base64 string in pathname or URL (e.g. redirect/aHR0c...)
        if (!unwrapped) {
          const b64Match = current.match(/aHR0c[a-zA-Z0-9+\/=_]+/);
          if (b64Match) {
            try {
              let cleanB64 = b64Match[0].replace(/[\s\=]+$/, '');
              while (cleanB64.length % 4) cleanB64 += '=';
              const b64Decoded = atob(cleanB64).trim();
              if (b64Decoded.startsWith('http://') || b64Decoded.startsWith('https://')) {
                unwrapped = b64Decoded;
              }
            } catch (e) {}
          }
        }
      } catch (e) {}

      if (unwrapped && unwrapped !== current) {
        current = unwrapped;
      } else {
        break;
      }
    }

    return current;
  } catch (err) {
    return url;
  }
}

/**
 * Classifies a link's content type based on extension, URL structures, or size/quality metadata
 */
function getLinkType(link) {
  const url = link.url.toLowerCase();
  const ext = url.split('?')[0].split('.').pop();
  
  // 1. Zip/Archive / Photoset
  if (['zip', 'rar', '7z', 'tar', 'gz', 'xz', 'z'].includes(ext) || 
      url.includes('mega.nz/folder/') || 
      url.includes('mega.nz/#f!') || 
      url.includes('gofile.io/d/') || 
      url.includes('pixeldrain.com/l/') || 
      (link.host === 'pixeldrain' && link.url.includes('/l/')) || 
      url.includes('photoset') ||
      (url.includes('bunkr') && url.includes('/a/')) || // Bunkr Album
      link.host === 'pixhost') { // Pixhost album/images
    return 'zip';
  }
  
  // 2. GIF
  if (ext === 'gif' || url.includes('/gif/')) {
    return 'gif';
  }
  
  // 3. Image
  if (['jpg', 'jpeg', 'png', 'webp', 'bmp', 'heic', 'tiff'].includes(ext) || 
      url.includes('/img/') || 
      url.includes('/image/') || 
      url.includes('jpg6.su') ||
      link.host === 'jpg6') {
    return 'image';
  }
  
  // 4. Video (with short estimator check)
  if (['mp4', 'mkv', 'avi', 'mov', 'webm', 'wmv', 'flv', 'm3u8'].includes(ext) || 
      url.includes('/video/') || 
      url.includes('/v/') || 
      url.includes('/embed/') ||
      link.host === 'whoreshub' || 
      link.host === 'saint' ||
      link.host === 'turbo' ||
      (link.host === 'bunkr' && (url.includes('/v/') || url.includes('/f/')))) {
    
    const isShortUrl = url.includes('/shorts/') || url.includes('tiktok.com');
    const isShortQuality = (link.quality && link.quality.match(/^\d+s$/)) || (link.quality && link.quality.match(/^0:\d{2}$/));
    if (isShortUrl || isShortQuality) {
      return 'short';
    }
    return 'video';
  }
  
  // 5. Short fallback
  if (url.includes('/shorts/') || url.includes('tiktok.com')) {
    return 'short';
  }
  
  // Default to video for standard video hosts or fallback
  if (link.host === 'bunkr' || link.host === 'whoreshub' || link.host === 'saint' || link.host === 'turbo' || link.host === 'cyberdrop') {
    return 'video';
  }
  
  return 'other';
}

/**
 * Checks if a given file link is still active on its hosting provider (Online/Offline)
 */
async function checkLinkStatus(url) {
  if (linkStatuses[url] === 'checking') return;
  
  linkStatuses[url] = 'checking';
  updateStatusUI(url, 'checking');
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout
    
    const response = await fetch(url, { 
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    clearTimeout(timeoutId);
    
    if (response.status === 404 || response.status === 410) {
      linkStatuses[url] = 'offline';
      updateStatusUI(url, 'offline');
      return;
    }
    
    const text = await response.text();
    const lowerText = text.toLowerCase();
    
    // Common HTML indicators of deleted or unavailable files across major hosts
    const deletionIndicators = [
      "file not found",
      "file was deleted",
      "file has been deleted",
      "file has been removed",
      "removed due to violation",
      "deleted due to copyright",
      "no longer exists",
      "this file is no longer available",
      "this video has been removed",
      "video not found",
      "the page you are looking for cannot be found",
      "folder does not exist",
      "folder not found",
      "error 404",
      "invalid file or folder",
      "removed for copyright infringement"
    ];
    
    let isDeleted = false;
    for (const indicator of deletionIndicators) {
      if (lowerText.includes(indicator)) {
        isDeleted = true;
        break;
      }
    }
    
    if (isDeleted) {
      linkStatuses[url] = 'offline';
      updateStatusUI(url, 'offline');
    } else {
      linkStatuses[url] = 'online';
      updateStatusUI(url, 'online');
    }
    
  } catch (err) {
    console.warn(`Error checking status for ${url}:`, err);
    // On abort or network failure, treat as offline
    linkStatuses[url] = 'offline';
    updateStatusUI(url, 'offline');
  }
}

/**
 * Updates the visual state of all DOM rows containing the specified URL
 */
function updateStatusUI(url, status) {
  const rows = document.querySelectorAll('.link-row');
  rows.forEach(row => {
    if (row.getAttribute('data-url') === url) {
      // 1. Update row styles
      if (status === 'offline') {
        row.classList.add('deleted');
        // Uncheck the checkbox and remove it from selection set
        const cb = row.querySelector('.link-checkbox');
        if (cb && cb.checked) {
          cb.checked = false;
          selectedLinkUrls.delete(url);
          updateSelectedCount();
        }
      } else {
        row.classList.remove('deleted');
      }
      
      // 2. Update status dot indicator
      const dot = row.querySelector('.status-dot');
      if (dot) {
        dot.className = `status-dot ${status}`;
        
        let tooltip = "Unchecked";
        if (status === 'online') tooltip = "Online";
        if (status === 'offline') tooltip = "Deleted / Offline";
        if (status === 'checking') tooltip = "Checking status...";
        dot.title = tooltip;
      }
    }
  });
}

/**
 * Format timestamp string safely into a readable output format (MMM DD, YYYY, HH:MM)
 */
function formatDate(isoString) {
  if (!isoString || isoString === "Unknown Time") return "Unknown Date";
  
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) {
      // Return raw string if already formatted or invalid ISO format
      return isoString;
    }
    
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const month = months[d.getMonth()];
    const day = String(d.getDate()).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    
    return `${month} ${day}, ${year}, ${hours}:${minutes}`;
  } catch (e) {
    return isoString;
  }
}

/**
 * Vymaže označené a zároveň aktuálne vyfiltrované (viditeľné) odkazy.
 */
function deleteSelectedLinks() {
  // Získame zoznam aktuálne vyfiltrovaných URL adries
  const flatFilteredUrls = [];
  filteredLinks.forEach(post => {
    post.links.forEach(l => {
      flatFilteredUrls.push(l.url);
    });
  });

  // Odfiltrujeme tie, ktoré sú zaškrtnuté a zároveň vyfiltrované
  const urlsToDelete = flatFilteredUrls.filter(url => selectedLinkUrls.has(url));

  if (urlsToDelete.length === 0) {
    showToast("Nie sú označené žiadne viditeľné odkazy na vymazanie.");
    return;
  }

  if (!confirm(`Naozaj chcete vymazať ${urlsToDelete.length} označených odkazov?`)) {
    return;
  }

  const deleteSet = new Set(urlsToDelete);

  // Vymažeme ich zo surového stavu (allScrapedPosts)
  allScrapedPosts = allScrapedPosts.map(post => {
    const remainingLinks = post.links.filter(link => !deleteSet.has(link.url));
    return {
      ...post,
      links: remainingLinks
    };
  }).filter(post => post.links.length > 0);

  // Odstránime ich zo selectedLinkUrls
  urlsToDelete.forEach(url => selectedLinkUrls.delete(url));

  // Znova prefiltrujeme a prekreslíme UI
  applyFilters();
  showToast(`Úspešne vymazaných ${urlsToDelete.length} odkazov.`);
}

/**
 * Vynúti opätovné načítanie metadát pre označené Bunkr/Whoreshub odkazy.
 */
async function fetchMetadataForSelected() {
  const flatFilteredUrls = [];
  filteredLinks.forEach(post => {
    post.links.forEach(l => flatFilteredUrls.push(l.url));
  });

  const selectedUrls = flatFilteredUrls.filter(url => selectedLinkUrls.has(url));
  
  if (selectedUrls.length === 0) {
    showToast("Nie sú označené žiadne viditeľné odkazy pre načítanie metadát.");
    return;
  }

  showToast(`Načítavam metadáta pre ${selectedUrls.length} odkazov...`);
  let count = 0;

  for (const url of selectedUrls) {
    let isResolvable = false;
    let linkHost = "";
    
    // Nájdi host a či je resolvable
    allScrapedPosts.forEach(post => {
      post.links.forEach(l => {
        if (l.url === url) {
          isResolvable = isLinkResolvable(l.host, l.url);
          linkHost = l.host;
        }
      });
    });

    if (isResolvable) {
      count++;
      try {
        if (linkHost === "pixeldrain") {
          const pdMatch = url.match(/pixeldrain\.com\/(u|l|api\/file)\/([a-zA-Z0-9_-]+)/i);
          if (pdMatch && pdMatch[2]) {
            const res = await fetch(`https://pixeldrain.com/api/file/${pdMatch[2]}/info`);
            if (res.ok) {
              const data = await res.json();
              resolvedBunkrLinks[url] = {
                name: data.name || url,
                size: data.size ? formatBytes(data.size) : 'Neznáma',
                sizeBytes: data.size || 0
              };
            }
          }
        } else if (linkHost === "turbo") {
          const vvidMatch = url.match(/turbo\.cr\/(?:embed|f|v|d|upload)\/([a-zA-Z0-9_-]+)/i);
          if (vvidMatch && vvidMatch[1]) {
            const vvid = vvidMatch[1];
            const signRes = await fetch(`https://turbo.cr/api/sign?v=${vvid}`).catch(e => null);
            if (signRes && signRes.ok) {
              const signData = await signRes.json();
              if (signData.success && signData.url) {
                const headRes = await fetch(signData.url, { method: 'HEAD' }).catch(e => null);
                let fsize = 'Neznáma';
                let sizeBytes = 0;
                if (headRes && headRes.ok) {
                  const sizeB = headRes.headers.get("content-length");
                  if (sizeB) {
                    sizeBytes = parseInt(sizeB, 10);
                    fsize = formatBytes(sizeBytes);
                  }
                }
                
                // Get duration async via video preload
                let durationFormatted = "";
                try {
                  const vidDuration = await new Promise((resolve) => {
                    const vid = document.createElement('video');
                    vid.preload = 'metadata';
                    const timeoutId = setTimeout(() => resolve(0), 8000); // 8s timeout
                    vid.onloadedmetadata = function() {
                      clearTimeout(timeoutId);
                      resolve(vid.duration);
                    };
                    vid.onerror = function() {
                      clearTimeout(timeoutId);
                      resolve(0);
                    };
                    vid.src = signData.url;
                  });
                  if (vidDuration > 0) {
                    const h = Math.floor(vidDuration / 3600);
                    const m = Math.floor((vidDuration % 3600) / 60);
                    const s = Math.floor(vidDuration % 60);
                    durationFormatted = h > 0 
                      ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
                      : `${m}:${s.toString().padStart(2, '0')}`;
                  }
                } catch (err) {
                  console.error("Failed to load duration for turbo", err);
                }

                resolvedBunkrLinks[url] = {
                  name: signData.original_filename || signData.filename || url.split('/').pop(),
                  size: fsize,
                  sizeBytes: sizeBytes,
                  durationFormatted: durationFormatted
                };
              }
            }
          }
        } else if (linkHost === "cyberdrop" || linkHost === "fileditch") {
          let fsize = 'Neznáma';
          let sizeBytes = 0;
          let durationFormatted = "";
          let videoUrl = url;

          if (!url.endsWith('.mp4') && !url.endsWith('.mkv') && !url.endsWith('.avi')) {
            const htmlRes = await fetch(url).catch(e => null);
            if (htmlRes && htmlRes.ok) {
              const htmlStr = await htmlRes.text();
              const srcMatch = htmlStr.match(/<source\s+[^>]*src="([^"]+)"/i);
              if (srcMatch && srcMatch[1]) {
                videoUrl = srcMatch[1];
              } else {
                const dlMatch = htmlStr.match(/<a\s+[^>]*id="download_button"[^>]*href="([^"]+)"/i);
                if (dlMatch && dlMatch[1]) {
                  videoUrl = dlMatch[1];
                }
              }
            }
          }

          if (videoUrl) {
            const headRes = await fetch(videoUrl, { method: 'HEAD' }).catch(e => null);
            if (headRes && headRes.ok) {
              const sizeB = headRes.headers.get("content-length");
              if (sizeB) {
                sizeBytes = parseInt(sizeB, 10);
                fsize = formatBytes(sizeBytes);
              }
            }
            if (videoUrl.endsWith('.mp4') || videoUrl.endsWith('.mkv') || videoUrl.endsWith('.avi') || videoUrl.includes('/download/')) {
              try {
                const vidDuration = await new Promise((resolve) => {
                  const vid = document.createElement('video');
                  vid.preload = 'metadata';
                  const timeoutId = setTimeout(() => resolve(0), 8000);
                  vid.onloadedmetadata = function() {
                    clearTimeout(timeoutId);
                    resolve(vid.duration);
                  };
                  vid.onerror = function() {
                    clearTimeout(timeoutId);
                    resolve(0);
                  };
                  vid.src = videoUrl;
                });
                if (vidDuration > 0) {
                  const h = Math.floor(vidDuration / 3600);
                  const m = Math.floor((vidDuration % 3600) / 60);
                  const s = Math.floor(vidDuration % 60);
                  durationFormatted = h > 0 
                    ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
                    : `${m}:${s.toString().padStart(2, '0')}`;
                }
              } catch (e) {}
            }
          }
          resolvedBunkrLinks[url] = {
            name: url.split('/').pop(),
            size: fsize,
            sizeBytes: sizeBytes,
            durationFormatted: durationFormatted
          };
        } else {
          // Pre Bunkr, Turbo a d'alšie skúsime normálny GET request namiesto HEAD (kvôli CORS 405)
          const res = await fetch(url).catch(e => null);
          if (res && res.ok) {
            const contentType = res.headers.get("content-type") || "";
            let fname = url.split('/').pop();
            let fsize = 'Neznáma';
            let sizeBytes = 0;

            if (contentType.includes("text/html")) {
              const html = await res.text();
              // Pokus o extrakciu titulu videa z HTML (často vo formáte <title>Video Name - Host</title>)
              const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
              if (titleMatch && titleMatch[1]) {
                fname = titleMatch[1].replace(/\s*-\s*(Bunkr|Turbo|Saint|Whoreshub).*/i, "").trim();
              }
              // Pokus o extrakciu textovej informácie o veľkosti z HTML, pričom ignorujeme placeholdery ako 0MB
              const sizeMatch = html.match(/([1-9][0-9]*[.]?[0-9]*)\s*(MB|GB|KB)/i);
              if (sizeMatch && sizeMatch[1] && sizeMatch[2]) {
                fsize = sizeMatch[0];
                const unit = sizeMatch[2].toUpperCase();
                const val = parseFloat(sizeMatch[1]);
                if (unit === 'KB') sizeBytes = val * 1024;
                else if (unit === 'MB') sizeBytes = val * 1024 * 1024;
                else if (unit === 'GB') sizeBytes = val * 1024 * 1024 * 1024;
              }
            } else {
              // Ak je to priamy odkaz na súbor
              const size = res.headers.get("content-length");
              const disp = res.headers.get("content-disposition");
              if (disp && disp.includes("filename=")) {
                 fname = disp.split("filename=")[1].replace(/"/g, "");
              }
              if (size) {
                 sizeBytes = parseInt(size, 10);
                 fsize = formatBytes(sizeBytes);
              }
            }

            resolvedBunkrLinks[url] = {
              name: fname,
              size: fsize,
              sizeBytes: sizeBytes
            };
          }
        }
      } catch (err) {
        console.log(`Failed meta fetch for ${url}`, err);
      }
    }
  }

  if (count > 0) {
    applyFilters();
    showToast("Metadáta načítané.");
  } else {
    showToast("Žiadne z vybraných odkazov nie sú podporované pre metadáta.");
  }
}

/**
 * Zistí, či je odkaz podporovaný na automatické/manuálne načítanie metadát.
 */
function isLinkResolvable(host, url) {
  if (host === "bunkr") {
    return url.includes('/f/') || url.includes('/v/') || url.includes('/a/') || url.includes('/embed/');
  }
  if (host === "whoreshub") {
    return url.includes('/videos/');
  }
  if (host === "turbo") {
    return url.includes('/embed/') || url.includes('/f/') || url.includes('/v/') || url.includes('/d/') || url.includes('/upload/');
  }
  if (host === "pixeldrain") {
    return url.includes('/u/') || url.includes('/l/');
  }
  if (host === "filester") {
    return url.includes('/d/') || url.includes('/f/');
  }
  if (host === "gofile" || host === "mega" || host === "cyberdrop" || host === "saint" || host === "fileditch") {
    return true; // Skúsime získať metadáta pre akékoľvek url od týchto hostov
  }
  return false;
}

/**
 * Sformátuje bajty do čitateľného formátu (kB, MB, GB, atď.).
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Spoločný HTML fallback pre sťahovanie metadát z Bunkr, Whoreshub, Turbo a iných.
 */
function fetchHTMLResolveFallback(url) {
  fetch(url)
    .then(res => {
      if (!res.ok) throw new Error("Status " + res.status);
      return res.text();
    })
    .then(html => {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      
      let name = "";
      const header = doc.querySelector('h1, h2, .filename, .title, .video-title');
      if (header) name = header.textContent.trim();
      
      if (!name || name.toLowerCase().includes("bunkr") || name.toLowerCase().includes("whoreshub") || name.toLowerCase().includes("pixeldrain") || name.toLowerCase().includes("turbo") || name.length < 3) {
        const titleTag = doc.querySelector('title');
        if (titleTag) {
          name = titleTag.textContent
            .replace(/\s*-\s*Bunkr\s*$/i, '')
            .replace(/\s*-\s*WhoresHub\s*$/i, '')
            .replace(/\s*-\s*Whoreshub\s*$/i, '')
            .replace(/\s*-\s*pixeldrain\s*$/i, '')
            .replace(/\s*-\s*turbo\s*$/i, '')
            .replace(/\s*-\s*turbo\.[a-z0-9]+\s*$/i, '')
            .trim();
        }
      }
      
      if (!name) {
        const parts = url.split('/').filter(x => x);
        name = parts.pop() || "Video";
        if (name.match(/^\d+$/) && parts.length > 0) {
          name = parts.pop() + " - " + name;
        }
      }
      
      let size = "Unknown Size";
      const sizeRegex = /^(\d+(?:\.\d+)?\s*(?:MB|GB|KB))$/i;
      const allElems = doc.querySelectorAll('p, span, div, td');
      for (const el of allElems) {
        const txt = el.textContent.trim();
        if (sizeRegex.test(txt)) {
          size = txt;
          break;
        }
      }
      
      if (size === "Unknown Size") {
        const rawMatch = html.match(/>\s*(\d+(?:\.\d+)?\s*(?:MB|GB|KB))\s*</i);
        if (rawMatch) size = rawMatch[1];
      }
      
      // Fallback: If no size found (common on streaming tube pages like Whoreshub), get duration and quality
      if (size === "Unknown Size") {
        let duration = "";
        const durElement = doc.querySelector('.duration, .time, [class*="duration"]');
        if (durElement) {
          duration = durElement.textContent.trim();
        } else {
          const durRegexMatch = html.match(/>\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*</);
          if (durRegexMatch) duration = durRegexMatch[1];
        }
        
        let quality = "";
        const qualRegexMatch = html.match(/(1080p|720p|4k|2160p)/i);
        if (qualRegexMatch) quality = qualRegexMatch[1].toUpperCase();
        
        if (duration && quality) {
          size = `${duration} | ${quality}`;
        } else if (duration) {
          size = duration;
        } else if (quality) {
          size = quality;
        }
      }
      
      resolvedBunkrLinks[url] = { name: name, size: size };
      activeResolves.delete(url);
      updateBunkrRowUI(url, name, size);
      
      setTimeout(processResolveQueue, 100);
    })
    .catch(err => {
      console.warn("Failed to resolve HTML link:", url, err);
      activeResolves.delete(url);
      updateBunkrRowUI(url, url.split('/').pop(), "Size error");
      
      setTimeout(processResolveQueue, 100);
    });
}
