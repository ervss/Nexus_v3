(() => {
  if (globalThis.__nexusThreadIntakeInstalled) return;
  globalThis.__nexusThreadIntakeInstalled = true;

  const HOST_RULES = [
    ["mega", /mega\.(?:nz|io)\/(?:file|folder)\//i, "album"],
    ["bunkr", /(?:bunkr|bunkrr)\.[a-z0-9-]+\//i, "album"],
    ["gofile", /gofile\.io\/d\//i, "album"],
    ["pixeldrain", /pixeldrain\.com\/(?:u|l|api\/file)\//i, "file"],
    ["filester", /filester\.[a-z0-9-]+\//i, "file"],
    ["fileditch", /fileditch(?:files)?\.[a-z0-9-]+\//i, "file"],
    ["turbo", /turbo\.[a-z0-9-]+\//i, "video"],
    ["whoreshub", /whoreshub\.com\/videos\//i, "video"],
    ["cyberdrop", /(?:cyberdrop|cyberfile)\.[a-z0-9-]+\//i, "album"],
    ["erome", /erome\.com\/(?:a|v|i)\//i, "album"],
    ["direct-video", /\.(?:mp4|m4v|webm|mov|mkv|avi|flv|wmv)(?:$|[?#])/i, "video"],
  ];

  const cleanText = (value, limit = 220) => String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);

  function absoluteUrl(raw, baseUrl) {
    try {
      const value = String(raw || "").trim();
      if (!value) return "";
      const url = new URL(value, baseUrl);
      return /^https?:$/i.test(url.protocol) ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  function unwrapRedirect(raw, baseUrl) {
    let current = absoluteUrl(raw, baseUrl);
    const redirectKeys = [
      "url", "u", "target", "dest", "destination", "redirect",
      "redirect_url", "to", "link", "out", "href", "path",
    ];
    for (let depth = 0; current && depth < 4; depth += 1) {
      let next = "";
      try {
        const parsed = new URL(current);
        for (const key of redirectKeys) {
          const value = parsed.searchParams.get(key);
          if (value && value !== current) {
            const candidate = absoluteUrl(value, current);
            if (candidate && candidate !== current) {
              next = candidate;
              break;
            }
          }
        }
        if (!next) {
          const encoded = parsed.pathname.match(/aHR0c[a-zA-Z0-9+/_=-]{10,}/i)?.[0];
          if (encoded && typeof atob === "function") {
            try {
              const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
              const decoded = atob(normalized).trim();
              if (/^https?:\/\//i.test(decoded)) next = decoded;
            } catch (_) {
              // Ignore malformed redirect tokens and let the caller reject it.
            }
          }
        }
      } catch (_) {
        return current;
      }
      if (!next) break;
      current = next;
    }
    return current;
  }

  function linkCandidates(element, currentUrl) {
    // XenForo's external-link blocker keeps the real destination in data-url
    // while href points to a confirmation/redirect page. Prefer those data
    // attributes, then unwrap query-string redirects before using href/src.
    const attributes = [
      "data-url", "data-href", "data-link", "data-external-url",
      "data-proxy-href", "data-target", "href", "src", "data-src",
    ];
    const dataValues = attributes.slice(0, 6)
      .map(attribute => element.getAttribute(attribute))
      .filter(Boolean)
      .map(value => unwrapRedirect(value, currentUrl))
      .filter(Boolean);
    if (dataValues.length) return [dataValues[0]];

    const fallbackValues = attributes.slice(6)
      .map(attribute => element.getAttribute(attribute))
      .filter(Boolean)
      .map(value => unwrapRedirect(value, currentUrl))
      .filter(Boolean);
    return [...new Set(fallbackValues)];
  }

  function classify(url) {
    // Keep2Share links can look like direct MP4 URLs, but Nexus has no
    // dedicated extractor for them. Keep them manual instead of auto-selecting.
    if (/(?:^|\/\/)(?:[^/]+\.)?(?:keep2share|k2s)\.[a-z0-9-]+(?:\/|$)/i.test(url)) {
      return { host: "keep2share", kind: "video", supported: false };
    }
    for (const [host, rule, kind] of HOST_RULES) {
      if (rule.test(url)) return { host, kind, supported: true };
    }
    return { host: "other", kind: "unknown", supported: false };
  }

  function isForumNavigation(url, currentUrl) {
    if (url === currentUrl) return true;
    try {
      if (new URL(url).hostname === new URL(currentUrl).hostname) return true;
    } catch (_) {
      return true;
    }
    return /\/(?:threads|members|forums|posts|search|account|login|help|support|whats-new|watched|find-threads|direct-messages|redirect)(?:\/|$)/i.test(url);
  }

  function postIdFor(post, index, page) {
    const fromData = post.getAttribute("data-content") || post.id || "";
    const match = fromData.match(/(?:post-|post)(\d+)/i);
    return match ? match[1] : `${page}-${index + 1}`;
  }

  function linkContext(element, body) {
    const local = element?.closest?.("p, li, blockquote, .bbCodeBlock, .message-content, .post-body") || body;
    return cleanText(local?.innerText || local?.textContent || body?.innerText || body?.textContent || "", 220);
  }

  function pageTemplate(doc, currentUrl) {
    const candidates = [...doc.querySelectorAll("a[href]")]
      .map(anchor => absoluteUrl(anchor.getAttribute("href"), currentUrl))
      .filter(Boolean);
    const paged = candidates.find(url => /(?:[?&]page=|\/page-)\d+/i.test(url));
    if (!paged) return "";
    if (/[?&]page=\d+/i.test(paged)) return paged.replace(/([?&]page=)\d+/i, "$1{{page}}");
    return paged.replace(/\/page-\d+/i, "/page-{{page}}");
  }

  function paginationFor(doc, currentUrl) {
    const numbers = [...doc.querySelectorAll("a[href], [data-page]")]
      .map(node => Number(node.getAttribute("data-page") || cleanText(node.textContent, 8)))
      .filter(number => Number.isInteger(number) && number > 0);
    const currentMatch = currentUrl.match(/(?:[?&]page=|\/page-)(\d+)/i);
    const currentNode = doc.querySelector(".pageNav-page--current, .page-nav-current, [aria-current='page']");
    const current = Number(currentNode?.getAttribute("data-page") || cleanText(currentNode?.textContent, 8))
      || Number(currentMatch?.[1])
      || 1;
    return {
      currentPage: current,
      totalPages: Math.max(current, ...numbers, 1),
      pageTemplate: pageTemplate(doc, currentUrl),
    };
  }

  function scrapeDocument(doc, currentUrl) {
    const titleNode = doc.querySelector("h1.p-title-value, h1, .p-title-value, title");
    let rawTitle = titleNode?.textContent || "Thread links";
    if (titleNode && typeof titleNode.cloneNode === "function") {
      const clone = titleNode.cloneNode(true);
      clone.querySelectorAll?.(".label, .nti-s-badge, .nti-s-pick")?.forEach(node => node.remove());
      const stripped = cleanText(clone.textContent, 160);
      if (stripped) rawTitle = stripped;
    }
    const title = cleanText(rawTitle, 160);
    let threadId = "";
    let threadUrl = "";
    try {
      const parsedCurrent = new URL(currentUrl);
      if (/^\/threads\//i.test(parsedCurrent.pathname)) {
        const cleanPath = parsedCurrent.pathname.replace(/\/(?:page-\d+|unread|latest|post-\d+)\/?$/i, "").replace(/\/$/, "");
        const idMatch = cleanPath.match(/\.(\d+)$/);
        threadId = idMatch ? idMatch[1] : "";
        threadUrl = `${parsedCurrent.origin}${cleanPath}/`;
      }
    } catch (_) {
      // Keep empty thread identity if URL cannot be parsed.
    }
    const pagination = paginationFor(doc, currentUrl);
    let postNodes = [...doc.querySelectorAll("article.message, [data-content^='post-'], .post-container, .postbit, .post")];
    if (!postNodes.length && doc.body) postNodes = [doc.body];
    const allPostIds = postNodes.map((post, index) => postIdFor(post, index, pagination.currentPage));

    const posts = postNodes.map((post, index) => {
      const body = post.querySelector(".message-body, .post-body, .message-content, .entry-content, .bbWrapper") || post;
      const author = cleanText(post.querySelector(".message-name, .username, .author, [data-user-id]")?.textContent || "Neznámy autor", 80);
      const postId = postIdFor(post, index, pagination.currentPage);
      const postUrl = absoluteUrl(post.querySelector("a[href*='post']")?.getAttribute("href"), currentUrl)
        || (/^\d+$/.test(postId) ? `${currentUrl.split("#")[0]}#post-${postId}` : currentUrl);
      const previewNode = body.querySelector?.("img.bbImage") || body.querySelector?.("a[data-fancybox] img")
        || body.querySelector?.("img[data-src]") || body.querySelector?.("img[src]");
      const preview = absoluteUrl(previewNode?.getAttribute("data-src") || previewNode?.getAttribute("src"), currentUrl);
      const links = [];
      const seen = new Set();

      function add(rawUrl, element, text = "") {
        const url = absoluteUrl(rawUrl, currentUrl);
        if (!url || seen.has(url) || isForumNavigation(url, currentUrl)) return;
        seen.add(url);
        const info = classify(url);
        if (!info.supported) return;
        links.push({
          url,
          ...info,
          text: cleanText(text || element?.textContent || url, 160),
          context: linkContext(element, body),
          quality: (cleanText(body.innerText || body.textContent, 600).match(/(?:2160p|4k|1440p|1080p|720p|480p)/i) || [""])[0].toUpperCase(),
          postAuthor: author,
          postId,
          timestamp: post.querySelector("time")?.getAttribute("datetime") || "",
          threadId,
          threadTitle: threadUrl ? title : "",
          threadUrl,
          postUrl,
          thumbnail: preview,
        });
      }

      body.querySelectorAll("a[href], a[data-url], a[data-href], a[data-link], a[data-external-url], a[data-proxy-href], a[data-target], iframe[src], iframe[data-src]").forEach((element) => {
        linkCandidates(element, currentUrl).forEach(raw => add(raw, element));
      });

      const textUrls = (body.innerText || body.textContent || "").match(/https?:\/\/[^\s<>"']+/gi) || [];
      textUrls.forEach(url => add(url, null, url));

      return {
        postId,
        postUrl,
        author,
        textContent: cleanText(body.innerText || body.textContent, 320),
        links,
      };
    }).filter(post => post.links.length);

    return { threadTitle: title, currentUrl, pagination, posts, allPostIds };
  }

  globalThis.__nexusThreadIntakeScrapeDocument = scrapeDocument;

  function addThreadTesterButton() {
    const url = new URL(window.location.href);
    if (!/^([a-z0-9-]+\.)?simpcity\.cr$/i.test(url.hostname) || !/^\/threads\//i.test(url.pathname)) return;
    if (document.getElementById("nexus-thread-intake-launcher")) return;

    const button = document.createElement("button");
    button.id = "nexus-thread-intake-launcher";
    button.type = "button";
    button.textContent = "T";
    button.title = "Odoslať tento thread do Nexus Testera (prvé 3 strany)";
    button.setAttribute("aria-label", button.title);
    Object.assign(button.style, {
      position: "fixed",
      top: "18px",
      right: "18px",
      zIndex: "2147483647",
      width: "48px",
      height: "48px",
      border: "2px solid rgba(255,255,255,.9)",
      borderRadius: "14px",
      background: "linear-gradient(145deg,#00e6cc,#009fd4)",
      boxShadow: "0 3px 12px rgba(0,0,0,.45)",
      color: "#fff",
      cursor: "pointer",
      font: "900 30px/1 Arial,sans-serif",
      textShadow: "1px 2px 0 #082e45",
    });
    button.addEventListener("click", () => {
      button.disabled = true;
      button.title = "Otváram Nexus Thread Intake…";
      chrome.runtime.sendMessage({ action: "nexusThreadIntake.openDashboard" }, response => {
        const error = chrome.runtime.lastError?.message || response?.error;
        if (error) {
          button.disabled = false;
          button.title = `Nexus sa nepodarilo otvoriť: ${error}`;
          return;
        }
        button.title = "Nexus Thread Intake sa otvoril";
      });
    });
    document.documentElement.appendChild(button);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action === "nexusThreadIntake.scrapeCurrent") {
      try {
        sendResponse({ ok: true, data: scrapeDocument(document, window.location.href) });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return;
    }

    if (message?.action === "nexusThreadIntake.scrapeUrl") {
      fetch(message.url, { credentials: "include" })
        .then(response => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.text();
        })
        .then(html => {
          const doc = new DOMParser().parseFromString(html, "text/html");
          sendResponse({ ok: true, data: scrapeDocument(doc, message.url) });
        })
        .catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
  });

  addThreadTesterButton();
})();
