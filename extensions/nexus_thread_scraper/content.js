// Content script for Nexus Thread Link Hunter

// Legacy duplicate kept isolated while the active implementation below runs.
// It used to make the whole content script fail to parse on every website.
(function () {

// Listen for messages from the extension dashboard/background
if (false) chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "scrapeCurrentPage") {
    try {
      const data = scrapePageData(document, window.location.href);
      sendResponse({ success: true, data: data });
    } catch (error) {
      console.error("Scraping error:", error);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }
  
  if (message.action === "fetchAndParseSubpage") {
    const url = message.url;
    
    // Create off-screen hidden iframe to load subpage naturally
    const iframe = document.createElement('iframe');
    iframe.style.position = 'absolute';
    iframe.style.top = '-9999px';
    iframe.style.left = '-9999px';
    iframe.style.width = '1024px';
    iframe.style.height = '768px';
    iframe.style.border = 'none';
    iframe.style.opacity = '0.01';
    iframe.style.pointerEvents = 'none';
    
    // Strict sandbox to allow same-origin reads and scripts but block frame breakout top-level redirects
    iframe.sandbox = "allow-same-origin allow-scripts allow-popups allow-forms";
    
    // Set 15-second timeout safeguard
    const timeoutId = setTimeout(() => {
      if (iframe.parentNode) {
        iframe.parentNode.removeChild(iframe);
      }
      sendResponse({ success: false, error: `Iframe load timeout (15s) for ${url}` });
    }, 15000);

    iframe.onload = () => {
      clearTimeout(timeoutId);
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        if (!iframeDoc) {
          throw new Error("Could not access same-origin iframe document");
        }
        
        // Parse the loaded iframe's DOM
        const pageData = scrapePageData(iframeDoc, url);

        // Gather rich diagnostic metrics to help debug loading blocks
        const postsSelector = '.message--post, article.message, [data-content^="post-"], .post-container, .postbit, .post, .message';
        const diagnostics = {
          title: iframeDoc.title || "Empty Title",
          postsCount: iframeDoc.querySelectorAll(postsSelector).length,
          rawLinksCount: iframeDoc.querySelectorAll('a[href]').length,
          linksExtracted: pageData.posts.reduce((sum, p) => sum + p.links.length, 0)
        };
        
        // Clean up from DOM immediately
        if (iframe.parentNode) {
          iframe.parentNode.removeChild(iframe);
        }
        
        sendResponse({ success: true, data: pageData, diagnostics: diagnostics });
      } catch (err) {
        if (iframe.parentNode) {
          iframe.parentNode.removeChild(iframe);
        }
        sendResponse({ success: false, error: err.message });
      }
    };

    iframe.onerror = (err) => {
      clearTimeout(timeoutId);
      if (iframe.parentNode) {
        iframe.parentNode.removeChild(iframe);
      }
      sendResponse({ success: false, error: `Iframe load failed for ${url}` });
    };

    // Trigger same-origin browser request by setting src and appending
    iframe.src = url;
    document.body.appendChild(iframe);
    
    return true; // Keep channel open for async response
  }
});

/**
 * Parses a page (either the current document or a background fetched DOM)
 * and extracts all posts, file links, pagination details, and contextual metadata.
 */
// Supported File Hosters regex list for classification
var hostRegexes = {
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

/**
 * Extract Thread Title
 */
function getThreadTitle(doc) {
  const titleEl = doc.querySelector('.p-title-value, h1.p-title-value, h1[class*="title"], title');
  if (titleEl) {
    // Clean up title (remove pagination suffixes like "Page 7" if present)
    return titleEl.textContent.trim().replace(/\s*\|\s*Page\s+\d+/i, '').replace(/\s*-\s*Page\s+\d+/i, '');
  }
  return "Unknown Thread";
}

/**
 * Extract Pagination Details
 */
function getPagination(doc, currentUrl) {
  // Strip hash anchor completely (e.g. #post-123) to avoid XenForo redirecting pages to the post's page
  const cleanUrl = (currentUrl || "").split('#')[0];

  const pages = new Set();
  let currentPage = 1;
  let totalPages = 1;

  // Search XenForo pagination elements
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

    // Handle standard XenForo currentPage
    const currentEl = pageNavEl.querySelector('.pageNav-page--current');
    if (currentEl) {
      currentPage = parseInt(currentEl.textContent.trim(), 10);
    }

    if (pages.size > 0) {
      totalPages = Math.max(...pages);
    }
  }

  // Parse page number from URL if not found in DOM
  const pageMatch = cleanUrl.match(/\/page-(\d+)/i) || cleanUrl.match(/[?&]page=(\d+)/i);
  if (pageMatch && currentPage === 1) {
    currentPage = parseInt(pageMatch[1], 10);
  }

  // Get base URL for pagination (replace page number)
  let pageBaseUrl = cleanUrl;
  if (cleanUrl.includes('/page-')) {
    pageBaseUrl = cleanUrl.replace(/\/page-\d+/, '/page-{{page}}');
  } else if (cleanUrl.match(/[?&]page=\d+/)) {
    pageBaseUrl = cleanUrl.replace(/page=\d+/, 'page={{page}}');
  } else {
    // URL doesn't have page indicator, append it
    // Check if there is an ending slash or query param
    if (cleanUrl.includes('?')) {
      pageBaseUrl = cleanUrl + '&page={{page}}';
    } else {
      // Remove trailing slash if present then append page
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

/**
 * Extract Post Author
 */
function getPostAuthor(postEl, fallbackIndex) {
  const authorEl = postEl.querySelector('.message-name, .username, [data-user-id] .username, .message-user .message-name a');
  if (authorEl) {
    return authorEl.textContent.trim();
  }
  return `User #${fallbackIndex + 1}`;
}

/**
 * Extract Post ID / Number
 */
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

/**
 * Extract Post Permalink (URL)
 */
function getPostUrl(postEl) {
  const permalinkEl = postEl.querySelector('.message-attribution-opposite a[href*="post-"], .message-attribution-opposite a[data-xf-init="share-tooltip"]');
  if (permalinkEl) {
    return permalinkEl.href;
  }
  const rawIdAttr = postEl.getAttribute('data-content') || (postEl.id && postEl.id.replace('js-', ''));
  if (rawIdAttr) {
    const threadUrl = window.location.href.split('#')[0].replace(/\/page-\d+/i, '');
    return `${threadUrl}#${rawIdAttr}`;
  }
  return window.location.href;
}

/**
 * Extract Post Timestamp
 */
function getPostTimestamp(postEl) {
  const timeEl = postEl.querySelector('.message-attribution-main time, time.u-dt');
  if (timeEl) {
    return timeEl.getAttribute('datetime') || timeEl.textContent.trim();
  }
  return "Unknown Time";
}

/**
 * Smart Link Context Extractor ('Origin')
 * Searches preceding text blocks and siblings to find the video title or photo folder name.
 * Handles SimpCity/XenForo format where content is in nested <span><b> blocks separated by <br>.
 */
function getLinkContext(linkEl, bodyEl) {
  let origin = "General Link";
  let quality = "Unknown Quality";

  const qualityRegex = /(2160p|4k|1080p|720p|480p|photoset|photos?|zip|rar)/i;
  const sizeRegex = /(\d+h\s*\d*m?i?n?|\d+\s*min|\d+(?:\.\d+)?\s*(?:GB|MB)).*?(2160p|4k|1080p|720p|480p)/i;

  const allTextBlocks = [];
  function collectTextBlocks(el) {
    if (!el) return;
    try {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null);
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent.trim();
          if (text.length > 1) allTextBlocks.push({ node, text });
        }
      }
    } catch(e) {}
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
    const linkText = linkEl ? (linkEl.textContent || linkEl.src || "") : "";
    const textContext = (origin + " " + linkText).toLowerCase();
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

  return {
    origin: origin,
    quality: quality
  };
}

})();

// Listen for messages from the extension dashboard/background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "scrapeCurrentPage") {
    try {
      const data = scrapePageData(document, window.location.href);
      sendResponse({ success: true, data: data });
    } catch (error) {
      console.error("Scraping error:", error);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }
  
  if (message.action === "fetchAndParseSubpage") {
    const url = message.url;
    
    // Create off-screen hidden iframe to load subpage naturally
    const iframe = document.createElement('iframe');
    iframe.style.position = 'absolute';
    iframe.style.top = '-9999px';
    iframe.style.left = '-9999px';
    iframe.style.width = '1024px';
    iframe.style.height = '768px';
    iframe.style.border = 'none';
    iframe.style.opacity = '0.01';
    iframe.style.pointerEvents = 'none';
    
    // Strict sandbox to allow same-origin reads and scripts but block frame breakout top-level redirects
    iframe.sandbox = "allow-same-origin allow-scripts allow-popups allow-forms";
    
    // Set 15-second timeout safeguard
    const timeoutId = setTimeout(() => {
      if (iframe.parentNode) {
        iframe.parentNode.removeChild(iframe);
      }
      sendResponse({ success: false, error: `Iframe load timeout (15s) for ${url}` });
    }, 15000);

    iframe.onload = () => {
      clearTimeout(timeoutId);
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        if (!iframeDoc) {
          throw new Error("Could not access same-origin iframe document");
        }
        
        // Parse the loaded iframe's DOM
        const pageData = scrapePageData(iframeDoc, url);

        // Gather rich diagnostic metrics to help debug loading blocks
        const postsSelector = '.message--post, article.message, [data-content^="post-"], .post-container, .postbit, .post, .message';
        const diagnostics = {
          title: iframeDoc.title || "Empty Title",
          postsCount: iframeDoc.querySelectorAll(postsSelector).length,
          rawLinksCount: iframeDoc.querySelectorAll('a[href]').length,
          linksExtracted: pageData.posts.reduce((sum, p) => sum + p.links.length, 0)
        };
        
        // Clean up from DOM immediately
        if (iframe.parentNode) {
          iframe.parentNode.removeChild(iframe);
        }
        
        sendResponse({ success: true, data: pageData, diagnostics: diagnostics });
      } catch (err) {
        if (iframe.parentNode) {
          iframe.parentNode.removeChild(iframe);
        }
        sendResponse({ success: false, error: err.message });
      }
    };

    iframe.onerror = (err) => {
      clearTimeout(timeoutId);
      if (iframe.parentNode) {
        iframe.parentNode.removeChild(iframe);
      }
      sendResponse({ success: false, error: `Iframe load failed for ${url}` });
    };

    // Trigger same-origin browser request by setting src and appending
    iframe.src = url;
    document.body.appendChild(iframe);
    
    return true; // Keep channel open for async response
  }
});

/**
 * Parses a page (either the current document or a background fetched DOM)
 * and extracts all posts, file links, pagination details, and contextual metadata.
 */
// Supported File Hosters regex list for classification
var hostRegexes = {
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

/**
 * Extract Thread Title
 */
function getThreadTitle(doc) {
  const titleEl = doc.querySelector('.p-title-value, h1.p-title-value, h1[class*="title"], title');
  if (titleEl) {
    // Clean up title (remove pagination suffixes like "Page 7" if present)
    return titleEl.textContent.trim().replace(/\s*\|\s*Page\s+\d+/i, '').replace(/\s*-\s*Page\s+\d+/i, '');
  }
  return "Unknown Thread";
}

/**
 * Extract Pagination Details
 */
function getPagination(doc, currentUrl) {
  // Strip hash anchor completely (e.g. #post-123) to avoid XenForo redirecting pages to the post's page
  const cleanUrl = (currentUrl || "").split('#')[0];

  const pages = new Set();
  let currentPage = 1;
  let totalPages = 1;

  // Search XenForo pagination elements
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

    // Handle standard XenForo currentPage
    const currentEl = pageNavEl.querySelector('.pageNav-page--current');
    if (currentEl) {
      currentPage = parseInt(currentEl.textContent.trim(), 10);
    }

    if (pages.size > 0) {
      totalPages = Math.max(...pages);
    }
  }

  // Parse page number from URL if not found in DOM
  const pageMatch = cleanUrl.match(/\/page-(\d+)/i) || cleanUrl.match(/[?&]page=(\d+)/i);
  if (pageMatch && currentPage === 1) {
    currentPage = parseInt(pageMatch[1], 10);
  }

  // Get base URL for pagination (replace page number)
  let pageBaseUrl = cleanUrl;
  if (cleanUrl.includes('/page-')) {
    pageBaseUrl = cleanUrl.replace(/\/page-\d+/, '/page-{{page}}');
  } else if (cleanUrl.match(/[?&]page=\d+/)) {
    pageBaseUrl = cleanUrl.replace(/page=\d+/, 'page={{page}}');
  } else {
    // URL doesn't have page indicator, append it
    // Check if there is an ending slash or query param
    if (cleanUrl.includes('?')) {
      pageBaseUrl = cleanUrl + '&page={{page}}';
    } else {
      // Remove trailing slash if present then append page
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

/**
 * Extract Post Author
 */
function getPostAuthor(postEl, fallbackIndex) {
  const authorEl = postEl.querySelector('.message-name, .username, [data-user-id] .username, .message-user .message-name a');
  if (authorEl) {
    return authorEl.textContent.trim();
  }
  return `User #${fallbackIndex + 1}`;
}

/**
 * Extract Post ID / Number
 */
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

/**
 * Extract Post Permalink (URL)
 */
function getPostUrl(postEl) {
  const permalinkEl = postEl.querySelector('.message-attribution-opposite a[href*="post-"], .message-attribution-opposite a[data-xf-init="share-tooltip"]');
  if (permalinkEl) {
    return permalinkEl.href;
  }
  const rawIdAttr = postEl.getAttribute('data-content') || (postEl.id && postEl.id.replace('js-', ''));
  if (rawIdAttr) {
    const threadUrl = window.location.href.split('#')[0].replace(/\/page-\d+/i, '');
    return `${threadUrl}#${rawIdAttr}`;
  }
  return window.location.href;
}

/**
 * Extract Post Timestamp
 */
function getPostTimestamp(postEl) {
  const timeEl = postEl.querySelector('.message-attribution-main time, time.u-dt');
  if (timeEl) {
    return timeEl.getAttribute('datetime') || timeEl.textContent.trim();
  }
  return "Unknown Time";
}

/**
 * Smart Link Context Extractor ('Origin')
 * Searches preceding text blocks and siblings to find the video title or photo folder name.
 * Handles SimpCity/XenForo format where content is in nested <span><b> blocks separated by <br>.
 */
function getLinkContext(linkEl, bodyEl) {
  let origin = "General Link";
  let quality = "Unknown Quality";

  const qualityRegex = /(2160p|4k|1080p|720p|480p|photoset|photos?|zip|rar)/i;
  const sizeRegex = /(\d+h\s*\d*m?i?n?|\d+\s*min|\d+(?:\.\d+)?\s*(?:GB|MB)).*?(2160p|4k|1080p|720p|480p)/i;

  // Strategy A: Collect ALL text nodes from the post body, find the ones nearest before the link
  // This handles SimpCity's <span><b>text</b></span><br> structures well
  const allTextBlocks = [];

  function collectTextBlocks(el) {
    if (!el) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.trim();
        if (text.length > 1) {
          allTextBlocks.push({ node: node, text: text });
        }
      }
    }
  }

  collectTextBlocks(bodyEl);

  // Find position of this link in the text block list
  const linkPos = allTextBlocks.findIndex(b => {
    try {
      return linkEl.contains(b.node) || linkEl === b.node.parentElement;
    } catch(e) { return false; }
  });

  // Gather up to 15 text blocks before the link
  const precedingBlocks = linkPos > 0
    ? allTextBlocks.slice(Math.max(0, linkPos - 15), linkPos)
    : allTextBlocks.slice(0, Math.min(15, allTextBlocks.length));

  const precedingTexts = precedingBlocks
    .map(b => b.text.replace(/[\r\n\t]+/g, ' ').trim())
    .filter(t => t.length > 1 && !t.startsWith('http') && !t.startsWith('www.'));

  // Strategy B: Also check unfurl block title (filester link preview title)
  let unfurlTitle = "";
  const unfurlBlock = linkEl.closest('.bbCodeBlock--unfurl');
  if (unfurlBlock) {
    const titleEl = unfurlBlock.querySelector('.js-unfurl-title a, .contentRow-header a');
    if (titleEl) {
      unfurlTitle = titleEl.textContent.trim();
      // Strip file extension from filename to get cleaner title
      unfurlTitle = unfurlTitle.replace(/\.[a-z0-9]{2,4}$/i, '').trim();
    }
  }

  // Find quality/size text in preceding blocks
  for (const text of [...precedingTexts].reverse()) {
    if (quality === "Unknown Quality") {
      const qm = text.match(qualityRegex);
      if (qm) quality = qm[1].toUpperCase();
      // Parse combined size+quality like "2h 55min 8.69GB (1080p)"
      const sm = text.match(sizeRegex);
      if (sm && sm[2]) quality = sm[2].toUpperCase();
    }
  }

  // Find best candidate title: look for descriptive text that is NOT a quality/size line
  // and NOT a download label ("Download / Stream", "Source Quality" etc.)
  const skipPatterns = /^(download|stream|source quality|upload|link|mirror|\[source|quality\])/i;
  const isQualitySizeLine = (t) => /\d+(?:h|min|GB|MB)/i.test(t) || qualityRegex.test(t);

  // Check if the link is inside an unfurl block — use filename as title
  if (unfurlTitle && unfurlTitle.length > 3) {
    // Unfurl filename is the best title for filester links
    // Try to find descriptive context text from post (e.g. "Dildo ride cum countdown...")
    const descLines = precedingTexts.filter(t =>
      !isQualitySizeLine(t) &&
      !skipPatterns.test(t) &&
      t.length > 10 &&
      !t.match(/^\d{1,2}-\d{1,2}-\d{2,4}$/) // skip date lines like "6-4-26"
    );
    if (descLines.length > 0) {
      // Pick nearest descriptive line
      origin = descLines[descLines.length - 1];
    } else {
      origin = unfurlTitle;
    }
  } else {
    // No unfurl — find descriptive context from preceding text
    const descLines = precedingTexts.filter(t =>
      !isQualitySizeLine(t) &&
      !skipPatterns.test(t) &&
      t.length > 5 &&
      !t.match(/^\d{1,2}-\d{1,2}-\d{2,4}$/)
    );
    if (descLines.length > 0) {
      origin = descLines[descLines.length - 1];
    }
  }

  // Final quality check from origin text itself
  if (quality === "Unknown Quality") {
    const textContext = (origin + " " + (linkEl.textContent || linkEl.src || "")).toLowerCase();
    if (textContext.includes("2160p") || textContext.includes("4k")) quality = "2160P";
    else if (textContext.includes("1080p")) quality = "1080P";
    else if (textContext.includes("720p")) quality = "720P";
    else if (textContext.includes("480p")) quality = "480P";
    else if (/photo|zip|rar|set/i.test(textContext)) quality = "Photoset";
  }

  // Normalize quality label
  if (quality !== "Unknown Quality") {
    if (quality === "4K") quality = "2160P";
    if (!quality.endsWith("P") && /^\d{3,4}p$/i.test(quality)) quality = quality.toUpperCase();
  }

  // Truncate overly long titles
  origin = origin.replace(/[\:\-\=\s]+$/, '').trim();
  if (origin.length > 120) origin = origin.substring(0, 117) + "...";
  if (origin.length < 3) origin = "General Link";

  return { origin, quality };
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
