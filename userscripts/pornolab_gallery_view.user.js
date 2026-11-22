// ==UserScript==
// @name         PornoLab Tracker Gallery View (Video Cards)
// @namespace    https://tampermonkey.net/
// @version      1.4.1
// @description  Zmení zoznam torrentov na Pornolabe (tracker.php) na modernú videovú galériu (4x3, 4x2 atď.) s veľkými náhľadmi, metadátami, vysúvateľnými tagmi a priamym odosielaním do qBittorrentu vo Windows.
// @author       Antigravity
// @match        *://*.pornolab.cc/forum/tracker.php*
// @match        *://pornolab.cc/forum/tracker.php*
// @match        *://*.pornolab.net/forum/tracker.php*
// @match        *://pornolab.net/forum/tracker.php*
// @match        *://*.pornolab.info/forum/tracker.php*
// @match        *://pornolab.info/forum/tracker.php*
// @icon         https://pornolab.cc/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // --- NASTAVENIA & KONFIGURÁCIA ---
  const STORAGE_KEY_COLS = 'plab_gallery_columns';
  const STORAGE_KEY_VIEW = 'plab_gallery_view_mode'; // 'gallery' | 'table'
  const STORAGE_KEY_QBIT_PORT = 'plab_qbit_port';
  const STORAGE_KEY_QBIT_HOST = 'plab_qbit_host';

  let currentColumns = parseInt(localStorage.getItem(STORAGE_KEY_COLS) || '4', 10);
  let currentViewMode = localStorage.getItem(STORAGE_KEY_VIEW) || 'gallery';
  let qbitPort = localStorage.getItem(STORAGE_KEY_QBIT_PORT) || '8080';
  let qbitHost = localStorage.getItem(STORAGE_KEY_QBIT_HOST) || 'http://localhost';

  // --- HLAVNÁ INICIALIZÁCIA ---
  function init() {
    // 1. Zabezpečenie no-referrer hlavičky pre načítanie externých obrázkov bez 403 Forbidden
    ensureNoReferrerPolicy();

    // 2. Nájdenie tabuľky a riadkov
    const mainTable = findTrackerTable();
    if (!mainTable) {
      console.log('[PornoLab Gallery] Tabuľka s torrentmi nebola nájdená.');
      return;
    }

    const rows = findTorrentRows(mainTable);
    if (!rows.length) {
      console.log('[PornoLab Gallery] Neboli nájdené žiadne riadky s torrentmi.');
      return;
    }

    // Injektovanie CSS štýlov
    injectStyles();

    // Vytvorenie kontajnerov pre galériu a toolbar
    const appContainer = document.createElement('div');
    appContainer.id = 'plab-gallery-app';

    // Toolbar (ovládacia lišta)
    const toolbar = createToolbar(rows.length);
    appContainer.appendChild(toolbar);

    // Grid galérie
    const galleryGrid = document.createElement('div');
    galleryGrid.id = 'plab-gallery-grid';
    galleryGrid.className = `plab-cols-${currentColumns}`;
    appContainer.appendChild(galleryGrid);

    // Vytvorenie modálneho okna pre lightbox (veľký náhľad)
    const lightbox = createLightbox();
    document.body.appendChild(lightbox);

    // Vytvorenie modálneho okna pre nastavenie qBittorrentu
    const qbitModal = createQBitModal();
    document.body.appendChild(qbitModal);

    // Kontajner pre plávajúce oznámenia (Toast notifications)
    const toastContainer = document.createElement('div');
    toastContainer.id = 'plab-toast-container';
    document.body.appendChild(toastContainer);

    // Spracovanie riadkov a tvorba kariet
    const cards = [];
    rows.forEach((row, index) => {
      const data = extractRowData(row);
      if (data) {
        const card = createCard(data, index);
        galleryGrid.appendChild(card);
        cards.push({ card, data });
      }
    });

    // Vloženie galérie pred pôvodnú tabuľku
    mainTable.parentNode.insertBefore(appContainer, mainTable);

    // Aplikácia počiatočného režimu zobrazenia
    applyViewMode(currentViewMode, mainTable, appContainer);

    // Inicializácia vyhľadávania / filtra v toolbare
    setupSearchFilter(toolbar, cards);
  }

  // --- OCHRANA PRED BLOKOVANÍM REFERREROM (403 FORBIDDEN) ---
  function ensureNoReferrerPolicy() {
    let meta = document.querySelector('meta[name="referrer"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'referrer';
      meta.content = 'no-referrer';
      document.head.appendChild(meta);
    } else {
      meta.content = 'no-referrer';
    }
  }

  // --- VYHĽADANIE TABUĽKY A RIADKOV ---
  function findTrackerTable() {
    return document.getElementById('tor-tbl') ||
      document.querySelector('table.forumline:has(a[href*="viewtopic.php?t="])') ||
      document.querySelector('table:has(a[href*="viewtopic.php?t="])');
  }

  function findTorrentRows(table) {
    const allRows = Array.from(table.querySelectorAll('tr'));
    return allRows.filter(tr => tr.querySelector('a[href*="viewtopic.php?t="]'));
  }

  // --- PARSOVANIE NÁZVU A TAGOV ---
  function parseTorrentTitle(rawTitle) {
    const bracketMatches = Array.from(rawTitle.matchAll(/\[(.*?)\]/g)).map(m => m[1].trim());
    let cleanTitle = rawTitle;
    let studio = '';
    let resolution = '';
    const tagsSet = new Set();

    const resRegex = /\b(2160p|1440p|1080p|1080i|720p|576p|480p|4K|UHD|HD|SiteRip|DVDRip)\b/i;

    bracketMatches.forEach((bracketContent, idx) => {
      cleanTitle = cleanTitle.replace(`[${bracketContent}]`, ' ');

      if (bracketContent.includes(',')) {
        const parts = bracketContent.split(',').map(s => s.trim()).filter(Boolean);
        parts.forEach(part => {
          const resMatch = part.match(resRegex);
          if (resMatch && !resolution) {
            resolution = resMatch[1].toUpperCase();
          } else if (!/^\d{4}-\d{2}-\d{2}$/.test(part) && !/^\w+\s+\d{1,2},\s+\d{4}/.test(part)) {
            tagsSet.add(part);
          }
        });
      } else {
        const resMatch = bracketContent.match(resRegex);
        if (resMatch && !resolution) {
          resolution = resMatch[1].toUpperCase();
        } else if (idx === 0 && (bracketContent.includes('/') || bracketContent.includes('.'))) {
          studio = bracketContent;
        } else if (!/^\d+$/.test(bracketContent)) {
          tagsSet.add(bracketContent);
        }
      }
    });

    const inlineResMatch = cleanTitle.match(resRegex);
    if (inlineResMatch && !resolution) {
      resolution = inlineResMatch[1].toUpperCase();
    }

    cleanTitle = cleanTitle
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-_/]+|[\s\-_/]+$/g, '')
      .trim();

    return {
      cleanTitle: cleanTitle || rawTitle,
      studio,
      resolution,
      tags: Array.from(tagsSet)
    };
  }

  // --- UPGRADE ROZLÍŠENIA OBRÁZKA (HOSTINGY) ---
  function upgradeImageUrl(url) {
    if (!url) return '';
    let u = url;

    if (u.includes('fastpic.')) {
      u = u.replace(/\/thumb\//, '/big/').replace(/\/th_/, '/');
    } else if (u.includes('turboimagehost.com')) {
      u = u.replace(/\/t\//, '/i/').replace(/_thumb\./, '.');
    } else if (u.includes('pixhost.to')) {
      u = u.replace(/\/\/t(\d+)\.pixhost\.to\/thumbs\//, '//$1.pixhost.to/images/').replace('/thumbs/', '/images/');
    } else if (u.includes('imagebam.com')) {
      u = u.replace(/\/th_/, '/').replace(/_t\./, '.');
    } else if (u.includes('postimg.cc') || u.includes('postimages.org')) {
      u = u.replace(/\/t(\d+)\./, '/i$1.').replace(/\/thumb\//, '/');
    } else if (u.includes('ibb.co')) {
      u = u.replace(/\.th\./, '.');
    }
    return u;
  }

  // Tracker often contains only status icons. Fetch the first post's image on demand.
  const previewQueue = [];
  let previewRequests = 0;
  const previewObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      previewObserver.unobserve(entry.target);
      previewQueue.push(entry.target);
      runPreviewQueue();
    });
  }, { rootMargin: '400px' });

  function runPreviewQueue() {
    while (previewRequests < 4 && previewQueue.length) {
      const card = previewQueue.shift();
      previewRequests++;
      loadTopicPreview(card).finally(() => { previewRequests--; runPreviewQueue(); });
    }
  }

  async function loadTopicPreview(card) {
    const { data, img, placeholder, zoomBtn } = card._plabPreview;
    try {
      const cacheKey = `plab_preview_${data.topicId}`;
      let url = '';
      try { url = sessionStorage.getItem(cacheKey) || ''; } catch (_) {}
      if (!url) {
        const response = await fetch(data.topicUrl, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        const post = doc.querySelector('.post_body, [id^="p-"]');
        const candidate = post && post.querySelector('var.postImg[title], img.postImg, .postImg img');
        const raw = candidate && (candidate.getAttribute('title') || candidate.getAttribute('data-src') || candidate.getAttribute('src'));
        if (!raw) throw new Error('Preview missing');
        const parsed = new URL(raw, data.topicUrl);
        if (!/^https?:$/.test(parsed.protocol)) throw new Error('Invalid preview URL');
        url = parsed.href;
        try { sessionStorage.setItem(cacheKey, url); } catch (_) {}
      }
      data.fullImgUrl = data.thumbUrl = url;
      img.onload = () => { img.style.display = ''; placeholder.style.display = 'none'; zoomBtn.hidden = false; };
      img.onerror = () => {
        try { sessionStorage.removeItem(cacheKey); } catch (_) {}
        img.style.display = 'none';
        placeholder.querySelector('span').textContent = 'Náhľad sa nepodarilo načítať';
      };
      img.src = url;
    } catch (_) {
      placeholder.querySelector('span').textContent = 'Žiadny náhľad';
    }
  }

  // --- POMOCNÉ FUNKCIE PRE PARSOVANIE BUNIEK ---
  function cleanCellText(cell) {
    if (!cell) return '';
    const clone = cell.cloneNode(true);
    clone.querySelectorAll('u').forEach(el => el.remove());
    return clone.textContent.trim();
  }

  function extractSizeFromCell(cell) {
    if (!cell) return '';
    const text = cleanCellText(cell);
    const m = text.match(/[\d.,]+\s*(?:Bytes?|KB|MB|GB|TB)/i);
    return m ? m[0] : text;
  }

  function extractNumberFromCell(cell, selector) {
    if (!cell) return '0';
    if (selector) {
      const el = cell.querySelector(selector);
      if (el) return el.textContent.trim();
    }
    const text = cleanCellText(cell);
    const m = text.match(/\d+/);
    return m ? m[0] : '0';
  }

  // --- EXTRAKCIA DÁT Z RIADKU ---
  function extractRowData(tr) {
    const cells = Array.from(tr.cells);
    if (!cells.length) return null;

    let topicCellIndex = -1;
    let titleLink = null;

    for (let i = 0; i < cells.length; i++) {
      const a = cells[i].querySelector('a.tLink, a.torTopic, a[href*="viewtopic.php?t="]');
      if (a) {
        topicCellIndex = i;
        titleLink = a;
        break;
      }
    }

    if (topicCellIndex === -1 || !titleLink) return null;

    const rawTitle = titleLink.textContent.trim();
    const topicUrl = titleLink.href;
    const topicId = (topicUrl.match(/[?&]t=(\d+)/) || [])[1] || '';

    // Kategória
    const catLink = tr.querySelector('a.f, a[href*="tracker.php?f="], a[href*="viewforum.php?f="]');
    const categoryName = catLink ? catLink.textContent.trim() : '';
    const categoryUrl = catLink ? catLink.href : '';

    // Priame stiahnutie torrentu (dl.php?t=ID)
    const dlLink = tr.querySelector('a.tr-dl, a[href*="dl.php?t="], a[href*="download.php"]');
    const downloadUrl = dlLink ? dlLink.href : (topicId ? `dl.php?t=${topicId}` : '');

    // Náhľadový obrázok (Bunka tesne PRED témou)
    let thumbUrl = '';
    let fullImgUrl = '';
    const posterCell = topicCellIndex > 0 ? cells[topicCellIndex - 1] : null;

    if (posterCell) {
      const img = posterCell.querySelector('img');
      if (img) {
        thumbUrl = img.getAttribute('data-src') ||
                   img.getAttribute('data-original') ||
                   img.getAttribute('data-hover') ||
                   img.getAttribute('data-preview') ||
                   img.getAttribute('data-full') ||
                   img.getAttribute('data-zoom') ||
                   img.src || '';

        fullImgUrl = img.getAttribute('data-full') ||
                     img.getAttribute('data-preview') ||
                     img.getAttribute('data-hover') ||
                     img.getAttribute('data-zoom') ||
                     img.getAttribute('data-large') || '';
      }

      const anchor = posterCell.querySelector('a');
      if (anchor) {
        const href = anchor.getAttribute('href') || '';
        if (/\.(jpe?g|png|webp|gif)(\?.*)?$/i.test(href)) {
          fullImgUrl = href;
          if (!thumbUrl) thumbUrl = href;
        }

        const aData = anchor.getAttribute('data-full') ||
                      anchor.getAttribute('data-preview') ||
                      anchor.getAttribute('data-hover') ||
                      anchor.getAttribute('data-src');
        if (aData) {
          fullImgUrl = aData;
          if (!thumbUrl) thumbUrl = aData;
        }
      }

      const onhover = (img && img.getAttribute('onmouseover')) ||
                      (anchor && anchor.getAttribute('onmouseover')) ||
                      posterCell.getAttribute('onmouseover') || '';
      if (onhover) {
        const m = onhover.match(/https?:\/\/[^"'\s<>]+\.(?:jpe?g|png|webp)/i);
        if (m) {
          fullImgUrl = m[0];
          if (!thumbUrl) thumbUrl = m[0];
        }
      }

      if (!thumbUrl) {
        const bgEl = posterCell.querySelector('[style*="background"]');
        if (bgEl && bgEl.style.backgroundImage) {
          const m = bgEl.style.backgroundImage.match(/url\(["']?(https?:[^"']+)["']?\)/i);
          if (m) {
            thumbUrl = m[1];
          }
        }
      }
    }

    if (!thumbUrl) {
      const allImgs = Array.from(tr.querySelectorAll('img')).filter(img => {
        const s = (img.src || '').toLowerCase();
        return !s.includes('tor_status') && !s.includes('folder_') && !s.includes('arrow_') && !s.includes('blank.gif') && !s.includes('icon_minipost') && !img.classList.contains('icon1');
      });
      if (allImgs.length > 0) {
        thumbUrl = allImgs[0].getAttribute('data-src') || allImgs[0].src || '';
      }
    }

    if (!fullImgUrl && thumbUrl) {
      fullImgUrl = upgradeImageUrl(thumbUrl);
    }

    // Autor
    let authorName = '';
    let authorUrl = '';
    const authorCell = cells.length > topicCellIndex + 1 ? cells[topicCellIndex + 1] : null;
    if (authorCell) {
      const a = authorCell.querySelector('a');
      authorName = (a ? a.textContent : cleanCellText(authorCell)).trim();
      authorUrl = a ? a.href : '';
    }

    // Veľkosť
    let size = '';
    const sizeCell = cells.length > topicCellIndex + 2 ? cells[topicCellIndex + 2] : null;
    if (sizeCell) {
      size = extractSizeFromCell(sizeCell);
    }

    // Seeders
    let seeders = '0';
    const seedCell = tr.querySelector('td.seedmed, .seedmed') || (cells.length > topicCellIndex + 3 ? cells[topicCellIndex + 3] : null);
    if (seedCell) {
      seeders = extractNumberFromCell(seedCell, 'b');
    }

    // Leechers
    let leechers = '0';
    const leechCell = tr.querySelector('td.leechmed, .leechmed') || (cells.length > topicCellIndex + 4 ? cells[topicCellIndex + 4] : null);
    if (leechCell) {
      leechers = extractNumberFromCell(leechCell, 'b');
    }

    // Downloads
    let downloads = '0';
    const dlCountCell = cells.length > topicCellIndex + 5 ? cells[topicCellIndex + 5] : null;
    if (dlCountCell) {
      downloads = cleanCellText(dlCountCell);
    }

    // Dátum pridania
    let dateAdded = '';
    const dateCell = cells[cells.length - 1];
    if (dateCell) {
      dateAdded = cleanCellText(dateCell);
    }

    const parsed = parseTorrentTitle(rawTitle);

    return {
      rawTitle,
      cleanTitle: parsed.cleanTitle,
      studio: parsed.studio,
      resolution: parsed.resolution,
      tags: parsed.tags,
      topicUrl,
      topicId,
      categoryName,
      categoryUrl,
      downloadUrl,
      thumbUrl,
      fullImgUrl: fullImgUrl || thumbUrl,
      size,
      seeders,
      leechers,
      downloads,
      dateAdded,
      authorName,
      authorUrl,
      originalRow: tr
    };
  }

  // --- ODOSIELANIE DO QBITTORRENTU VO WINDOWS ---
  function sendTorrentToQBittorrent(downloadUrl, cleanTitle, buttonEl) {
    if (!downloadUrl) {
      showToast('⚠️ Odkaz na torrent nie je dostupný.', 'error');
      return;
    }

    const originalHtml = buttonEl.innerHTML;
    buttonEl.innerHTML = '⏳ Posielam...';
    buttonEl.classList.add('loading');
    buttonEl.style.pointerEvents = 'none';

    // 1. Stiahneme .torrent súbor s pornolab cookies cez GM_xmlhttpRequest
    const fullDownloadUrl = new URL(downloadUrl, window.location.href).href;

    if (typeof GM_xmlhttpRequest === 'undefined') {
      // Fallback pre prípad chýbajúcich grantov
      triggerNativeBrowserDownload(fullDownloadUrl, cleanTitle, buttonEl, originalHtml);
      return;
    }

    GM_xmlhttpRequest({
      method: 'GET',
      url: fullDownloadUrl,
      responseType: 'blob',
      onload: function (response) {
        if (response.status === 200 && response.response) {
          const blob = response.response;
          uploadBlobToQBit(blob, cleanTitle, buttonEl, originalHtml, fullDownloadUrl);
        } else {
          triggerNativeBrowserDownload(fullDownloadUrl, cleanTitle, buttonEl, originalHtml);
        }
      },
      onerror: function () {
        triggerNativeBrowserDownload(fullDownloadUrl, cleanTitle, buttonEl, originalHtml);
      }
    });
  }

  // POST požiadavka priamo do qBittorrent WebUI API
  function uploadBlobToQBit(blob, cleanTitle, buttonEl, originalHtml, fallbackUrl) {
    const qbitUrl = `${qbitHost}:${qbitPort}/api/v2/torrents/add`;
    const safeFilename = cleanTitle.replace(/[/\\?%*:|"<>]/g, '_') + '.torrent';

    const formData = new FormData();
    formData.append('torrents', blob, safeFilename);
    formData.append('autoTMM', 'false');
    // paused=false zaručuje automatické spustenie sťahovania v qBittorrente
    formData.append('paused', 'false');

    GM_xmlhttpRequest({
      method: 'POST',
      url: qbitUrl,
      data: formData,
      timeout: 3000,
      onload: function (res) {
        if (res.status === 200 && res.responseText.toLowerCase().includes('ok.')) {
          // ÚSPECH: qBittorrent prijal torrent a spustil sťahovanie
          buttonEl.innerHTML = '✅ V qBittorrent!';
          buttonEl.classList.remove('loading');
          buttonEl.classList.add('success');
          showToast(`🎬 "${cleanTitle}" odoslaný do qBittorrentu a sťahovanie beží!`, 'success');

          setTimeout(() => {
            buttonEl.innerHTML = originalHtml;
            buttonEl.classList.remove('success');
            buttonEl.style.pointerEvents = 'auto';
          }, 3500);
        } else if (res.status === 403 || res.status === 401) {
          // WebUI vyžaduje prihlásenie bez localhost bypassu
          showToast('⚠️ qBittorrent WebUI vyžaduje prihlásenie. V qBittorrente zaškrtnite "Obísť autentifikáciu pre localhost".', 'warning');
          triggerNativeBrowserDownload(fallbackUrl, cleanTitle, buttonEl, originalHtml);
        } else {
          // Iná chyba -> prepneme na fallback
          triggerNativeBrowserDownload(fallbackUrl, cleanTitle, buttonEl, originalHtml);
        }
      },
      onerror: function () {
        // WebUI nebeží alebo port nie je dostupný -> automatický fallback
        triggerNativeBrowserDownload(fallbackUrl, cleanTitle, buttonEl, originalHtml, true);
      },
      ontimeout: function () {
        triggerNativeBrowserDownload(fallbackUrl, cleanTitle, buttonEl, originalHtml, true);
      }
    });
  }

  // Fallback: okamžité stiahnutie .torrent súboru cez prehliadač
  function triggerNativeBrowserDownload(url, cleanTitle, buttonEl, originalHtml, isWebUiOffline) {
    const a = document.createElement('a');
    a.href = url;
    a.download = cleanTitle.replace(/[/\\?%*:|"<>]/g, '_') + '.torrent';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    buttonEl.innerHTML = '📥 Stiahnuté';
    buttonEl.classList.remove('loading');
    buttonEl.classList.add('downloaded');

    if (isWebUiOffline) {
      showToast('📥 Torrent stiahnutý do PC. Ak chcete priame odosielanie bez dialógov, zapnite WebUI v qBittorrente (klik na ⚙️ qBittorrent v lište).', 'info');
    } else {
      showToast('📥 Torrent bol stiahnutý.', 'info');
    }

    setTimeout(() => {
      buttonEl.innerHTML = originalHtml;
      buttonEl.classList.remove('downloaded');
      buttonEl.style.pointerEvents = 'auto';
    }, 3000);
  }

  // --- PLÁVAJÚCE OZNÁMENIA (TOAST NOTIFICATIONS) ---
  function showToast(message, type = 'info') {
    const container = document.getElementById('plab-toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `plab-toast plab-toast-${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('show');
    }, 10);

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 4500);
  }

  // --- VYTVORENIE KARTY (CARD COMPONENT) ---
  function createCard(data, index) {
    const card = document.createElement('div');
    card.className = 'plab-card';
    card.dataset.index = index;
    card.dataset.title = (data.cleanTitle + ' ' + data.rawTitle).toLowerCase();
    card.dataset.tags = data.tags.join(' ').toLowerCase();

    // 1. Horná lišta: Kategória a Seederi
    const header = document.createElement('div');
    header.className = 'plab-card-header';

    const catEl = document.createElement('a');
    catEl.className = 'plab-category';
    catEl.href = data.categoryUrl || '#';
    catEl.title = data.categoryName;
    catEl.textContent = data.categoryName || 'Všeobecné';
    header.appendChild(catEl);

    const peers = document.createElement('div');
    peers.className = 'plab-peers';
    peers.innerHTML = `
      <span class="plab-seeds" title="Seeders">▲ ${data.seeders}</span>
      <span class="plab-leeches" title="Leechers">▼ ${data.leechers}</span>
    `;
    header.appendChild(peers);
    card.appendChild(header);

    // 2. Náhľad (Thumbnail)
    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'plab-thumb-wrap';

    const thumbLink = document.createElement('a');
    thumbLink.className = 'plab-thumb-link';
    thumbLink.href = data.topicUrl;

    const img = document.createElement('img');
    img.className = 'plab-thumb-img';
    img.alt = data.cleanTitle;
    // The card observer already defers loading; hidden lazy images never start in Chrome.
    img.loading = 'eager';
    img.referrerPolicy = 'no-referrer';
    img.style.display = 'none';
    thumbLink.appendChild(img);

    thumbWrap.classList.add('plab-no-img');
    const placeholder = document.createElement('div');
    placeholder.className = 'plab-placeholder-text';
    placeholder.innerHTML = '🎬 <span>Načítavam náhľad…</span>';
    thumbLink.appendChild(placeholder);

    // Play ikona pri hoveri
    const playOverlay = document.createElement('div');
    playOverlay.className = 'plab-play-overlay';
    playOverlay.innerHTML = `
      <svg viewBox="0 0 24 24" class="plab-play-icon">
        <polygon points="5 3 19 12 5 21 5 3"></polygon>
      </svg>
    `;
    thumbLink.appendChild(playOverlay);
    thumbWrap.appendChild(thumbLink);

    // Odznaky na náhľade
    if (data.studio) {
      const studioBadge = document.createElement('span');
      studioBadge.className = 'plab-badge-studio';
      studioBadge.textContent = data.studio;
      thumbWrap.appendChild(studioBadge);
    }

    if (data.resolution) {
      const resBadge = document.createElement('span');
      resBadge.className = 'plab-badge-res';
      resBadge.textContent = data.resolution;
      thumbWrap.appendChild(resBadge);
    }

    if (data.size) {
      const sizeBadge = document.createElement('span');
      sizeBadge.className = 'plab-badge-size';
      sizeBadge.textContent = data.size;
      thumbWrap.appendChild(sizeBadge);
    }

    // Rýchle tlačidlá v pravom hornom rohu náhľadu
    const thumbActions = document.createElement('div');
    thumbActions.className = 'plab-thumb-actions';

    // Rýchle tlačidlo odoslania do qBittorrentu na náhľade
    if (data.downloadUrl) {
      const qbitThumbBtn = document.createElement('button');
      qbitThumbBtn.className = 'plab-icon-btn plab-thumb-qbit-btn';
      qbitThumbBtn.title = 'Odoslať priamo do qBittorrentu a spustiť sťahovanie';
      qbitThumbBtn.innerHTML = '⬇️';
      qbitThumbBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        sendTorrentToQBittorrent(data.downloadUrl, data.cleanTitle, qbitThumbBtn);
      });
      thumbActions.appendChild(qbitThumbBtn);
    }

    // Náhľad sa doplní asynchrónne až po priblížení karty k obrazovke.
    const zoomBtn = document.createElement('button');
    zoomBtn.className = 'plab-icon-btn plab-zoom-btn';
    zoomBtn.title = 'Zväčšiť náhľad na celú obrazovku';
    zoomBtn.innerHTML = '🔍';
    zoomBtn.hidden = true;
    zoomBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (data.fullImgUrl) openLightbox(data.fullImgUrl, data.cleanTitle);
    });
    thumbActions.appendChild(zoomBtn);
    card._plabPreview = { data, img, placeholder, zoomBtn };
    previewObserver.observe(card);

    thumbWrap.appendChild(thumbActions);
    card.appendChild(thumbWrap);

    // 3. Telo karty: Názov, Metadáta a Tagy
    const body = document.createElement('div');
    body.className = 'plab-card-body';

    // Názov
    const titleEl = document.createElement('h3');
    titleEl.className = 'plab-title';
    const titleLink = document.createElement('a');
    titleLink.href = data.topicUrl;
    titleLink.title = data.rawTitle;
    titleLink.textContent = data.cleanTitle;
    titleEl.appendChild(titleLink);
    body.appendChild(titleEl);

    // Riadok s metadátami
    const metaRow = document.createElement('div');
    metaRow.className = 'plab-meta-row';

    if (data.dateAdded) {
      const dateSpan = document.createElement('span');
      dateSpan.className = 'plab-meta-item plab-date';
      dateSpan.title = 'Dátum pridania';
      dateSpan.innerHTML = `📅 ${data.dateAdded}`;
      metaRow.appendChild(dateSpan);
    }

    if (data.authorName) {
      const authorSpan = document.createElement('a');
      authorSpan.className = 'plab-meta-item plab-author';
      authorSpan.href = data.authorUrl || '#';
      authorSpan.title = 'Uploader';
      authorSpan.innerHTML = `👤 ${data.authorName}`;
      metaRow.appendChild(authorSpan);
    }

    // ZELENÉ TLAČIDLO TORRENT -> Odosiela do qBittorrentu s automatickým spustením
    if (data.downloadUrl) {
      const dlBtn = document.createElement('button');
      dlBtn.type = 'button';
      dlBtn.className = 'plab-dl-btn';
      dlBtn.title = 'Odoslať do qBittorrentu a automaticky spustiť sťahovanie';
      dlBtn.innerHTML = '⬇️ Torrent';

      dlBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        sendTorrentToQBittorrent(data.downloadUrl, data.cleanTitle, dlBtn);
      });

      metaRow.appendChild(dlBtn);
    }

    body.appendChild(metaRow);

    // 4. Vysúvateľné tagy
    if (data.tags && data.tags.length > 0) {
      const tagsContainer = document.createElement('div');
      tagsContainer.className = 'plab-tags-container';

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'plab-tags-toggle';
      toggleBtn.innerHTML = `
        <span>🏷️ Tagy (${data.tags.length})</span>
        <span class="plab-arrow">▾</span>
      `;

      const tagsList = document.createElement('div');
      tagsList.className = 'plab-tags-list';
      tagsList.style.display = 'none';

      data.tags.forEach(tag => {
        const tagChip = document.createElement('a');
        tagChip.className = 'plab-tag-chip';
        tagChip.href = `/forum/tracker.php?tg=${encodeURIComponent(tag)}`;
        tagChip.target = '_blank';
        tagChip.rel = 'noopener noreferrer';
        tagChip.textContent = tag;
        tagChip.title = `Vyhľadať tag: "${tag}"`;
        tagsList.appendChild(tagChip);
      });

      toggleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const isOpen = tagsList.style.display !== 'none';
        tagsList.style.display = isOpen ? 'none' : 'flex';
        toggleBtn.classList.toggle('active', !isOpen);
        toggleBtn.querySelector('.plab-arrow').textContent = isOpen ? '▾' : '▴';
      });

      tagsContainer.appendChild(toggleBtn);
      tagsContainer.appendChild(tagsList);
      body.appendChild(tagsContainer);
    }

    card.appendChild(body);
    return card;
  }

  // --- TOOLBAR (OVLÁDACIA LIŠTA) ---
  function createToolbar(totalCount) {
    const bar = document.createElement('div');
    bar.id = 'plab-gallery-toolbar';

    bar.innerHTML = `
      <div class="plab-toolbar-left">
        <span class="plab-brand">🎬 Galéria torrentov</span>
        <span class="plab-count-badge" id="plab-count-display">${totalCount} výsledkov</span>
      </div>

      <div class="plab-toolbar-center">
        <input type="text" id="plab-search-input" placeholder="🔍 Rýchly filter výsledkov na stránke..." />
      </div>

      <div class="plab-toolbar-right">
        <!-- Prepínač stĺpcov -->
        <div class="plab-btn-group" title="Počet stĺpcov mriežky">
          <span class="plab-group-label">Stĺpce:</span>
          <button type="button" class="plab-btn plab-col-btn ${currentColumns === 2 ? 'active' : ''}" data-cols="2">2</button>
          <button type="button" class="plab-btn plab-col-btn ${currentColumns === 3 ? 'active' : ''}" data-cols="3">3</button>
          <button type="button" class="plab-btn plab-col-btn ${currentColumns === 4 ? 'active' : ''}" data-cols="4">4</button>
          <button type="button" class="plab-btn plab-col-btn ${currentColumns === 5 ? 'active' : ''}" data-cols="5">5</button>
        </div>

        <!-- Rozbaliť/zbaliť všetky tagy -->
        <button type="button" class="plab-btn" id="plab-toggle-all-tags" title="Rozbaliť alebo zbaliť všetky tagy naraz">
          🏷️ Tagy
        </button>

        <!-- Nastavenia qBittorrentu -->
        <button type="button" class="plab-btn" id="plab-btn-qbit-settings" title="Nastavenia prepojenia s qBittorrentom">
          ⚙️ qBittorrent
        </button>

        <!-- Prepínač Galéria / Tabuľka -->
        <div class="plab-btn-group">
          <button type="button" class="plab-btn ${currentViewMode === 'gallery' ? 'active' : ''}" id="plab-btn-view-gallery" title="Zobraziť ako modernú videovú galériu">
            🎴 Galéria
          </button>
          <button type="button" class="plab-btn ${currentViewMode === 'table' ? 'active' : ''}" id="plab-btn-view-table" title="Zobraziť pôvodnú tabuľku">
            📋 Tabuľka
          </button>
        </div>
      </div>
    `;

    // Udalosti tlačidiel stĺpcov
    bar.querySelectorAll('.plab-col-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const cols = parseInt(btn.dataset.cols, 10);
        setGridColumns(cols);
        bar.querySelectorAll('.plab-col-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Udalosti prepínania zobrazenia
    const btnGallery = bar.querySelector('#plab-btn-view-gallery');
    const btnTable = bar.querySelector('#plab-btn-view-table');

    btnGallery.addEventListener('click', () => {
      setViewMode('gallery');
      btnGallery.classList.add('active');
      btnTable.classList.remove('active');
    });

    btnTable.addEventListener('click', () => {
      setViewMode('table');
      btnTable.classList.add('active');
      btnGallery.classList.remove('active');
    });

    // Rozbaliť / Zbaliť všetky tagy
    let allTagsOpen = false;
    const toggleAllTagsBtn = bar.querySelector('#plab-toggle-all-tags');
    toggleAllTagsBtn.addEventListener('click', () => {
      allTagsOpen = !allTagsOpen;
      document.querySelectorAll('.plab-tags-list').forEach(list => {
        list.style.display = allTagsOpen ? 'flex' : 'none';
      });
      document.querySelectorAll('.plab-tags-toggle').forEach(tgl => {
        tgl.classList.toggle('active', allTagsOpen);
        const arrow = tgl.querySelector('.plab-arrow');
        if (arrow) arrow.textContent = allTagsOpen ? '▴' : '▾';
      });
      toggleAllTagsBtn.classList.toggle('active', allTagsOpen);
    });

    // Otvorenie modálu qBittorrent
    const qbitBtn = bar.querySelector('#plab-btn-qbit-settings');
    qbitBtn.addEventListener('click', () => {
      openQBitModal();
    });

    return bar;
  }

  // --- ZMENA POČTU STĹPCOV ---
  function setGridColumns(cols) {
    currentColumns = cols;
    localStorage.setItem(STORAGE_KEY_COLS, cols);
    const grid = document.getElementById('plab-gallery-grid');
    if (grid) {
      grid.className = `plab-cols-${cols}`;
    }
  }

  // --- PREPÍNANIE ZOBRAZENIA (GALÉRIA VS. TABUĽKA) ---
  function setViewMode(mode) {
    currentViewMode = mode;
    localStorage.setItem(STORAGE_KEY_VIEW, mode);
    const mainTable = findTrackerTable();
    const appContainer = document.getElementById('plab-gallery-app');
    applyViewMode(mode, mainTable, appContainer);
  }

  function applyViewMode(mode, mainTable, appContainer) {
    const grid = document.getElementById('plab-gallery-grid');
    if (mode === 'table') {
      if (mainTable) mainTable.style.display = '';
      if (grid) grid.style.display = 'none';
    } else {
      if (mainTable) mainTable.style.display = 'none';
      if (grid) grid.style.display = 'grid';
    }
  }

  // --- FILTROVANIE VÝSLEDKOV CEZ TOOLBAR ---
  function setupSearchFilter(toolbar, cardItems) {
    const input = toolbar.querySelector('#plab-search-input');
    const countDisplay = toolbar.querySelector('#plab-count-display');
    if (!input) return;

    input.addEventListener('input', () => {
      const query = input.value.trim().toLowerCase();
      let visibleCount = 0;

      cardItems.forEach(({ card, data }) => {
        const matches = !query ||
          card.dataset.title.includes(query) ||
          card.dataset.tags.includes(query) ||
          (data.authorName && data.authorName.toLowerCase().includes(query)) ||
          (data.categoryName && data.categoryName.toLowerCase().includes(query));

        card.style.display = matches ? '' : 'none';
        if (matches) visibleCount++;
      });

      if (countDisplay) {
        countDisplay.textContent = `${visibleCount} z ${cardItems.length}`;
      }
    });
  }

  // --- MODÁLNE OKNO PRE NASTAVENIE QBITTORRENTU ---
  function createQBitModal() {
    const modal = document.createElement('div');
    modal.id = 'plab-qbit-modal';
    modal.innerHTML = `
      <div class="plab-modal-backdrop"></div>
      <div class="plab-modal-content">
        <button class="plab-modal-close" title="Zavrieť">✕</button>
        <h3 class="plab-modal-title">⚙️ Nastavenie prepojenia s qBittorrentom</h3>

        <div class="plab-modal-body">
          <p class="plab-info-text">
            Tlačidlo <strong>⬇️ Torrent</strong> vie odosielať torrenty priamo do bežiacej aplikácie <strong>qBittorrent</strong> a automaticky spustiť sťahovanie bez akéhokoľvek potvrdzovania.
          </p>

          <div class="plab-field-group">
            <label for="plab-input-qbit-port">WebUI Port qBittorrentu (predvolený: 8080):</label>
            <input type="text" id="plab-input-qbit-port" value="${qbitPort}" placeholder="8080" />
          </div>

          <div class="plab-modal-actions">
            <button type="button" class="plab-btn plab-btn-primary" id="plab-btn-test-qbit">📡 Otestovať spojenie</button>
            <button type="button" class="plab-btn plab-btn-save" id="plab-btn-save-qbit">💾 Uložiť</button>
            <span id="plab-qbit-status-msg"></span>
          </div>

          <div class="plab-setup-guide">
            <h4>Ako povoliť príjem v qBittorrente (na 3 kliky):</h4>
            <ol>
              <li>V <strong>qBittorrente</strong> otvorte <em>Nástroje (Tools) → Možnosti (Options)</em> (alebo stlačte <code>Alt + O</code>).</li>
              <li>Kliknite vľavo na záložku <strong>Webové rozhranie (Web UI)</strong>.</li>
              <li>Zaškrtnite <strong>Webové používateľské rozhranie (Diaľkové ovládanie)</strong> a port nastavte na <code>8080</code>.</li>
              <li>Zaškrtnite <strong>Obísť autentifikáciu pre klientov na localhoste</strong>.</li>
              <li>Kliknite <strong>OK</strong>. Hotovo! Odteraz kliknutie na ⬇️ Torrent okamžite pustí sťahovanie.</li>
            </ol>
          </div>
        </div>
      </div>
    `;

    const close = () => modal.classList.remove('active');
    modal.querySelector('.plab-modal-backdrop').addEventListener('click', close);
    modal.querySelector('.plab-modal-close').addEventListener('click', close);

    const portInput = modal.querySelector('#plab-input-qbit-port');
    const statusMsg = modal.querySelector('#plab-qbit-status-msg');
    const saveBtn = modal.querySelector('#plab-btn-save-qbit');
    const testBtn = modal.querySelector('#plab-btn-test-qbit');

    saveBtn.addEventListener('click', () => {
      qbitPort = portInput.value.trim() || '8080';
      localStorage.setItem(STORAGE_KEY_QBIT_PORT, qbitPort);
      statusMsg.textContent = '✅ Nastavenia uložené!';
      statusMsg.style.color = '#2ecc71';
      setTimeout(() => close(), 1200);
    });

    testBtn.addEventListener('click', () => {
      const port = portInput.value.trim() || '8080';
      statusMsg.textContent = '⏳ Testujem pripojenie...';
      statusMsg.style.color = '#f39c12';

      if (typeof GM_xmlhttpRequest === 'undefined') {
        statusMsg.textContent = '⚠️ Tampermonkey nemá povolené GM_xmlhttpRequest.';
        statusMsg.style.color = '#e74c3c';
        return;
      }

      GM_xmlhttpRequest({
        method: 'GET',
        url: `http://localhost:${port}/api/v2/app/webapiVersion`,
        timeout: 2500,
        onload: function (res) {
          if (res.status === 200) {
            statusMsg.textContent = `🟢 Spojenie úspešné! qBittorrent API v${res.responseText}`;
            statusMsg.style.color = '#2ecc71';
          } else if (res.status === 403) {
            statusMsg.textContent = '🟡 qBittorrent odpovedá, ale vyžaduje zaškrtnúť "Obísť autentifikáciu pre localhost".';
            statusMsg.style.color = '#f1c40f';
          } else {
            statusMsg.textContent = `🔴 qBittorrent vrátil kód ${res.status}.`;
            statusMsg.style.color = '#e74c3c';
          }
        },
        onerror: function () {
          statusMsg.textContent = '🔴 Nepodarilo sa spojiť. Skontrolujte, či qBittorrent beží a má zapnuté WebUI na porte ' + port + '.';
          statusMsg.style.color = '#e74c3c';
        },
        ontimeout: function () {
          statusMsg.textContent = '🔴 Časový limit vypršal. qBittorrent na porte ' + port + ' neodpovedá.';
          statusMsg.style.color = '#e74c3c';
        }
      });
    });

    return modal;
  }

  function openQBitModal() {
    const modal = document.getElementById('plab-qbit-modal');
    if (modal) modal.classList.add('active');
  }

  // --- LIGHTBOX PRE VEĽKÝ NÁHĽAD NA CELÚ OBRAZOVKU ---
  function createLightbox() {
    const lb = document.createElement('div');
    lb.id = 'plab-lightbox';
    lb.innerHTML = `
      <div class="plab-lightbox-backdrop"></div>
      <div class="plab-lightbox-content">
        <button class="plab-lightbox-close" title="Zavrieť (Esc)">✕</button>
        <img class="plab-lightbox-img" src="" alt="Náhľad" referrerpolicy="no-referrer" />
        <div class="plab-lightbox-caption"></div>
      </div>
    `;

    const close = () => {
      lb.classList.remove('active');
      lb.querySelector('.plab-lightbox-img').src = '';
    };

    lb.querySelector('.plab-lightbox-backdrop').addEventListener('click', close);
    lb.querySelector('.plab-lightbox-close').addEventListener('click', close);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && lb.classList.contains('active')) {
        close();
      }
    });

    return lb;
  }

  function openLightbox(imgUrl, caption) {
    const lb = document.getElementById('plab-lightbox');
    if (!lb) return;
    const img = lb.querySelector('.plab-lightbox-img');
    const cap = lb.querySelector('.plab-lightbox-caption');

    img.src = imgUrl;
    cap.textContent = caption || '';
    lb.classList.add('active');
  }

  // --- CSS ŠTÝLY ---
  function injectStyles() {
    const style = document.createElement('style');
    style.id = 'plab-gallery-styles';
    style.textContent = `
      /* HLAVNÝ KONTAJNER */
      #plab-gallery-app {
        width: 100%;
        max-width: 1800px;
        margin: 15px auto 30px auto;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        box-sizing: border-box;
      }

      /* TOOLBAR */
      #plab-gallery-toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        background: #1f1f23;
        border: 1px solid #333338;
        border-radius: 10px;
        padding: 10px 16px;
        margin-bottom: 20px;
        color: #e0e0e0;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      }

      .plab-toolbar-left, .plab-toolbar-right {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .plab-brand {
        font-weight: 700;
        font-size: 15px;
        color: #fff;
        letter-spacing: 0.5px;
      }

      .plab-count-badge {
        background: #2d2d34;
        color: #9ac4f8;
        padding: 3px 8px;
        border-radius: 12px;
        font-size: 12px;
        font-weight: 600;
        border: 1px solid #3e3e4a;
      }

      .plab-toolbar-center {
        flex: 1;
        min-width: 250px;
        max-width: 500px;
      }

      #plab-search-input {
        width: 100%;
        background: #121214;
        border: 1px solid #3d3d46;
        border-radius: 6px;
        padding: 7px 12px;
        color: #fff;
        font-size: 13px;
        outline: none;
        transition: border-color 0.2s;
        box-sizing: border-box;
      }
      #plab-search-input:focus {
        border-color: #5c8df6;
      }

      .plab-group-label {
        font-size: 12px;
        color: #888;
        margin-right: 2px;
      }

      .plab-btn-group {
        display: inline-flex;
        align-items: center;
        background: #121214;
        border-radius: 6px;
        padding: 2px;
        border: 1px solid #333338;
      }

      .plab-btn {
        background: transparent;
        border: none;
        color: #b0b0b8;
        padding: 5px 10px;
        font-size: 12px;
        font-weight: 600;
        border-radius: 4px;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .plab-btn:hover {
        background: #2a2a32;
        color: #fff;
      }
      .plab-btn.active {
        background: #3b5998;
        color: #fff;
      }

      /* GRID LAYOUT */
      #plab-gallery-grid {
        display: grid;
        gap: 18px;
        width: 100%;
        box-sizing: border-box;
      }

      .plab-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .plab-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .plab-cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .plab-cols-5 { grid-template-columns: repeat(5, minmax(0, 1fr)); }

      @media (max-width: 1200px) {
        .plab-cols-4, .plab-cols-5 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      }
      @media (max-width: 850px) {
        .plab-cols-3, .plab-cols-4, .plab-cols-5 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      @media (max-width: 550px) {
        #plab-gallery-grid { grid-template-columns: 1fr !important; }
      }

      /* KARTA TORRENTU */
      .plab-card {
        background: #1c1c20;
        border: 1px solid #2d2d34;
        border-radius: 10px;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
        box-shadow: 0 4px 10px rgba(0,0,0,0.3);
      }
      .plab-card:hover {
        transform: translateY(-4px);
        border-color: #4c4c58;
        box-shadow: 0 8px 20px rgba(0,0,0,0.5);
      }

      /* HORNÝ PÁS (NAD NÁHĽADOM): Kategória + Peers */
      .plab-card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        background: #161619;
        border-bottom: 1px solid #26262c;
        font-size: 11px;
      }
      .plab-category {
        color: #8da2c0 !important;
        text-decoration: none !important;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 70%;
        font-weight: 500;
      }
      .plab-category:hover {
        color: #b8d4ff !important;
        text-decoration: underline !important;
      }
      .plab-peers {
        display: flex;
        gap: 6px;
        font-weight: 700;
        white-space: nowrap;
      }
      .plab-seeds { color: #2ecc71; }
      .plab-leeches { color: #e74c3c; }

      /* NÁHĽAD */
      .plab-thumb-wrap {
        position: relative;
        width: 100%;
        aspect-ratio: 16 / 9;
        background: #0d0d10;
        overflow: hidden;
      }
      .plab-thumb-link {
        display: block;
        width: 100%;
        height: 100%;
        text-decoration: none;
      }
      .plab-thumb-img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
        transition: transform 0.35s ease;
      }
      .plab-card:hover .plab-thumb-img {
        transform: scale(1.04);
      }

      /* PLACEHOLDER BEZ OBRÁZKA */
      .plab-no-img .plab-placeholder-text {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: #555;
        font-size: 28px;
        gap: 6px;
      }
      .plab-placeholder-text span {
        font-size: 12px;
        color: #777;
      }

      /* OVERLAY S PLAY IKONOU */
      .plab-play-overlay {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0,0,0,0.25);
        opacity: 0;
        transition: opacity 0.2s ease;
        pointer-events: none;
      }
      .plab-play-icon {
        width: 44px;
        height: 44px;
        fill: #ffffff;
        filter: drop-shadow(0 2px 6px rgba(0,0,0,0.8));
      }
      .plab-card:hover .plab-play-overlay {
        opacity: 1;
      }

      /* ODZNAKY NA NÁHĽADE */
      .plab-badge-studio {
        position: absolute;
        top: 8px;
        left: 8px;
        background: rgba(18, 18, 22, 0.85);
        color: #d1d5db;
        padding: 2px 7px;
        border-radius: 4px;
        font-size: 10.5px;
        font-weight: 600;
        backdrop-filter: blur(4px);
        border: 1px solid rgba(255,255,255,0.1);
        max-width: 70%;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .plab-badge-res {
        position: absolute;
        bottom: 8px;
        left: 8px;
        background: #c0392b;
        color: #fff;
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.5px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.5);
      }

      .plab-badge-size {
        position: absolute;
        bottom: 8px;
        right: 8px;
        background: rgba(0, 0, 0, 0.85);
        color: #ffd166;
        padding: 3px 7px;
        border-radius: 4px;
        font-size: 11.5px;
        font-weight: 700;
        backdrop-filter: blur(4px);
        border: 1px solid rgba(255,255,255,0.15);
      }

      /* RÝCHLE AKCIE NA NÁHĽADE */
      .plab-thumb-actions {
        position: absolute;
        top: 8px;
        right: 8px;
        display: flex;
        gap: 6px;
        opacity: 0;
        transition: opacity 0.2s ease;
        z-index: 3;
      }
      .plab-card:hover .plab-thumb-actions {
        opacity: 1;
      }

      .plab-icon-btn {
        background: rgba(0, 0, 0, 0.75);
        border: 1px solid rgba(255,255,255,0.25);
        color: #fff;
        width: 30px;
        height: 30px;
        border-radius: 50%;
        font-size: 13px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.15s, transform 0.15s;
      }
      .plab-icon-btn:hover {
        background: #3b5998;
        transform: scale(1.1);
      }
      .plab-thumb-qbit-btn:hover {
        background: #27ae60;
      }

      /* TELO KARTY */
      .plab-card-body {
        padding: 12px;
        display: flex;
        flex-direction: column;
        flex: 1;
        gap: 8px;
      }

      /* NÁZOV */
      .plab-title {
        margin: 0;
        font-size: 13.5px;
        line-height: 1.4;
        font-weight: 600;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        min-height: 38px;
      }
      .plab-title a {
        color: #f0f0f4 !important;
        text-decoration: none !important;
        transition: color 0.15s;
      }
      .plab-title a:hover {
        color: #64b5f6 !important;
      }

      /* RIADOK S METADÁTAMI */
      .plab-meta-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 11.5px;
        color: #9e9ea8;
        padding-top: 4px;
        border-top: 1px solid #26262e;
        flex-wrap: wrap;
        gap: 6px;
      }
      .plab-meta-item {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .plab-author {
        color: #aaa !important;
        text-decoration: none !important;
        max-width: 120px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .plab-author:hover {
        color: #fff !important;
        text-decoration: underline !important;
      }

      /* TLAČIDLO TORRENT DO QBITTORRENTU */
      .plab-dl-btn {
        background: #27ae60;
        color: #fff !important;
        border: none;
        padding: 4px 10px;
        border-radius: 5px;
        font-size: 11.5px;
        font-weight: 700;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        transition: all 0.2s ease;
        box-shadow: 0 2px 6px rgba(39, 174, 96, 0.3);
      }
      .plab-dl-btn:hover {
        background: #2ecc71;
        transform: scale(1.03);
        box-shadow: 0 3px 8px rgba(46, 204, 113, 0.4);
      }
      .plab-dl-btn.loading {
        background: #f39c12;
        cursor: wait;
      }
      .plab-dl-btn.success {
        background: #16a085;
        box-shadow: 0 0 12px rgba(22, 160, 133, 0.7);
      }
      .plab-dl-btn.downloaded {
        background: #2980b9;
      }

      /* VYSÚVATEĽNÉ TAGY */
      .plab-tags-container {
        margin-top: auto;
        padding-top: 6px;
      }
      .plab-tags-toggle {
        width: 100%;
        background: #141418;
        border: 1px solid #2a2a32;
        color: #999;
        padding: 4px 8px;
        border-radius: 5px;
        font-size: 11.5px;
        font-weight: 600;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: space-between;
        transition: background 0.15s, color 0.15s;
      }
      .plab-tags-toggle:hover, .plab-tags-toggle.active {
        background: #22222a;
        color: #ddd;
        border-color: #3e3e4a;
      }

      .plab-tags-list {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        margin-top: 8px;
        padding: 8px;
        background: #121215;
        border-radius: 6px;
        border: 1px solid #26262e;
        max-height: 180px;
        overflow-y: auto;
      }
      .plab-tag-chip {
        background: #23232c;
        color: #b0c4de !important;
        text-decoration: none !important;
        padding: 2px 7px;
        border-radius: 12px;
        font-size: 11px;
        border: 1px solid #333340;
        transition: all 0.15s;
        white-space: nowrap;
      }
      .plab-tag-chip:hover {
        background: #3b5998;
        color: #ffffff !important;
        border-color: #5577bb;
      }

      /* TOAST NOTIFIKÁCIE */
      #plab-toast-container {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 9999999;
        display: flex;
        flex-direction: column;
        gap: 10px;
        pointer-events: none;
      }
      .plab-toast {
        background: #1f1f24;
        color: #fff;
        padding: 12px 18px;
        border-radius: 8px;
        border-left: 5px solid #3498db;
        box-shadow: 0 6px 20px rgba(0,0,0,0.6);
        font-size: 13px;
        max-width: 420px;
        opacity: 0;
        transform: translateY(20px);
        transition: opacity 0.3s ease, transform 0.3s ease;
        pointer-events: auto;
      }
      .plab-toast.show {
        opacity: 1;
        transform: translateY(0);
      }
      .plab-toast-success { border-left-color: #2ecc71; }
      .plab-toast-warning { border-left-color: #f1c40f; }
      .plab-toast-error { border-left-color: #e74c3c; }

      /* MODÁL QBITTORRENT */
      #plab-qbit-modal, #plab-lightbox {
        position: fixed;
        inset: 0;
        z-index: 999999;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.25s ease;
      }
      #plab-qbit-modal.active, #plab-lightbox.active {
        opacity: 1;
        pointer-events: auto;
      }
      .plab-modal-backdrop, .plab-lightbox-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.85);
        backdrop-filter: blur(5px);
      }
      .plab-modal-content {
        position: relative;
        z-index: 2;
        background: #1c1c22;
        border: 1px solid #383844;
        border-radius: 12px;
        padding: 24px;
        width: 90%;
        max-width: 580px;
        color: #eee;
        box-shadow: 0 10px 40px rgba(0,0,0,0.8);
      }
      .plab-modal-title {
        margin: 0 0 16px 0;
        font-size: 17px;
        color: #fff;
      }
      .plab-info-text {
        font-size: 13px;
        line-height: 1.5;
        color: #bbb;
        margin-bottom: 16px;
      }
      .plab-field-group {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-bottom: 16px;
      }
      .plab-field-group label {
        font-size: 12.5px;
        font-weight: 600;
        color: #ddd;
      }
      .plab-field-group input {
        background: #121215;
        border: 1px solid #3d3d48;
        border-radius: 6px;
        padding: 8px 12px;
        color: #fff;
        font-size: 13px;
        outline: none;
      }
      .plab-modal-actions {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 18px;
        flex-wrap: wrap;
      }
      .plab-btn-primary {
        background: #2980b9;
        color: #fff;
      }
      .plab-btn-primary:hover {
        background: #3498db;
      }
      .plab-btn-save {
        background: #27ae60;
        color: #fff;
      }
      .plab-btn-save:hover {
        background: #2ecc71;
      }
      #plab-qbit-status-msg {
        font-size: 12px;
        font-weight: 600;
      }
      .plab-setup-guide {
        background: #141418;
        border: 1px solid #282830;
        border-radius: 8px;
        padding: 12px 16px;
        font-size: 12px;
        line-height: 1.6;
        color: #aaa;
      }
      .plab-setup-guide h4 {
        margin: 0 0 8px 0;
        color: #fff;
        font-size: 13px;
      }
      .plab-setup-guide ol {
        margin: 0;
        padding-left: 20px;
      }
      .plab-setup-guide code {
        background: #22222a;
        padding: 2px 5px;
        border-radius: 4px;
        color: #64b5f6;
      }
      .plab-modal-close, .plab-lightbox-close {
        position: absolute;
        top: 14px;
        right: 16px;
        background: transparent;
        border: none;
        color: #aaa;
        font-size: 20px;
        cursor: pointer;
        transition: color 0.15s;
      }
      .plab-modal-close:hover, .plab-lightbox-close:hover {
        color: #fff;
      }

      /* LIGHTBOX CONTENT */
      .plab-lightbox-content {
        position: relative;
        z-index: 2;
        max-width: 90vw;
        max-height: 90vh;
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      .plab-lightbox-img {
        max-width: 90vw;
        max-height: 82vh;
        object-fit: contain;
        border-radius: 8px;
        box-shadow: 0 10px 40px rgba(0,0,0,0.8);
        border: 1px solid #444;
      }
      .plab-lightbox-caption {
        margin-top: 10px;
        color: #eee;
        font-size: 13.5px;
        font-weight: 600;
        text-align: center;
        max-width: 800px;
      }
    `;
    document.head.appendChild(style);
  }

  // Spustenie po načítaní DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
