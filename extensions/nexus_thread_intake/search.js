(() => {
  const here = new URL(location.href);
  const isWatched = /^\/watched\/threads(?:\/|$)/i.test(here.pathname);
  const isSearch = /^\/search\//i.test(here.pathname);
  const isTag = /^\/tags\//i.test(here.pathname);
  const isForum = /^\/forums\//i.test(here.pathname);
  if (!/^([a-z0-9-]+\.)?simpcity\.cr$/i.test(here.hostname) || !(isWatched || isSearch || isTag || isForum)) return;
  if (globalThis.__nexusSearchInstalled) return;
  globalThis.__nexusSearchInstalled = true;

  const MAX_RESULT_PAGES = 60;
  const MAX_SEND = 500;
  const MAX_SEND_CHUNKS = 4;
  const scrape = globalThis.__nexusThreadIntakeScrapeDocument;

  const entries = [];            // všetky výsledky (threads) na stránke
  const byId = new Map();        // threadId -> entry
  const cards = new Map();       // canonical link -> card
  const scanned = new Map();     // threadId -> { links, pages, error }
  const selected = new Set();
  const failures = [];
  const detailCache = new Map();
  const cacheLoads = new Map();
  const cacheKey = id => `nexusThreadIntake.details.v1.${here.hostname}.${id}`;
  async function readDetail(entry) {
    if (detailCache.has(entry.id)) return detailCache.get(entry.id);
    if (!cacheLoads.has(entry.id)) cacheLoads.set(entry.id, (async () => {
      const key = cacheKey(entry.id);
      const stored = (await chrome.storage.local.get(key))[key];
      const data = stored && typeof stored === 'object' ? stored : {};
      detailCache.set(entry.id, data);
      return data;
    })());
    try { return await cacheLoads.get(entry.id); } finally { cacheLoads.delete(entry.id); }
  }
  async function saveDetail(entry, data) {
    await chrome.storage.local.set({ [cacheKey(entry.id)]: data });
    detailCache.set(entry.id, data);
  }
  let container = null;
  let panel = null, trigger = null;
  let running = false, loadingPages = false, sending = false;
  let controller = null;
  let status = 'Pripravené. Vyber thready (checkbox) a klikni Skenovať.';
  let requestTail = Promise.resolve();
  let lastRequestAt = 0, cooldownUntil = 0, rateStreak = 0;
  let progress = '';
  const loadedResultPages = new Set([pageNumber(here.href)]);

  // ---------- pomocné ----------
  const q = (sel) => panel.querySelector(sel);
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  function safeHttp(raw, base = here.href) {
    try {
      if (!raw || !String(raw).trim()) return '';
      const u = new URL(raw, base);
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
    } catch { return ''; }
  }

  function threadIdentity(raw) {
    try {
      const url = new URL(raw, here.href);
      if (url.origin !== here.origin || !/^\/threads\//.test(url.pathname)) return null;
      const path = url.pathname.replace(/\/(?:page-\d+|unread|latest|post-\d+)\/?$/i, '').replace(/\/$/, '');
      const m = path.match(/\.(\d+)$/);
      return m ? { id: m[1], url: `${url.origin}${path}/` } : null;
    } catch { return null; }
  }

  function pageNumber(raw) {
    try {
      const url = new URL(raw, here.href);
      return Number(url.pathname.match(/\/page-(\d+)\/?$/i)?.[1] || url.searchParams.get('page') || 1);
    } catch { return 1; }
  }

  function canonicalLink(raw) {
    try {
      const url = new URL(raw);
      if (!/^https?:$/.test(url.protocol)) return '';
      url.hash = '';
      for (const name of [...url.searchParams.keys()]) {
        if (/^utm_/i.test(name) || /^(fbclid|gclid)$/i.test(name)) url.searchParams.delete(name);
      }
      return url.href.replace(/\/$/, '');
    } catch { return ''; }
  }

  function threadPageCount(doc, threadUrl) {
    const identity = threadIdentity(threadUrl);
    if (!identity) return 1;
    const pages = [...doc.querySelectorAll('.pageNav a[href], .pageNav-page a[href], a[href*="/page-"]')]
      .map(a => safeHttp(a.getAttribute('href'), threadUrl))
      .filter(url => url && threadIdentity(url)?.id === identity.id)
      .map(pageNumber)
      .filter(n => Number.isInteger(n) && n > 0 && n <= 10000);
    return Math.max(1, ...pages);
  }

  function parseDate(value) {
    const t = Date.parse(value || '');
    return Number.isFinite(t) ? t : 0;
  }

  function el(tag, text, className) {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (className) n.className = className;
    return n;
  }

  // ---------- parsovanie výsledkov ----------
  function resultRows(root) {
    const structItems = [...root.querySelectorAll('.structItem--thread, .discussionListItem, .thread-list-item')];
    if (structItems.length) return structItems;
    const rows = [...root.querySelectorAll('li.block-row, .block-row')].filter(r => r.querySelector('a[href*="/threads/"]'));
    return rows.length ? rows : [...root.querySelectorAll('.contentRow')].map(r => r.closest('li') || r).filter(r => r.querySelector('a[href*="/threads/"]'));
  }

  function describeRow(row) {
    const titleLink = row.querySelector('.structItem-title a[href*="/threads/"], .title a[href*="/threads/"], .contentRow-title a[href*="/threads/"], h3 a[href*="/threads/"]')
      || row.querySelector('a[href*="/threads/"]');
    const thread = threadIdentity(titleLink?.getAttribute('href'));
    if (!thread) return null;
    const labels = [...row.querySelectorAll('.contentRow-title .label, .label')].map(n => n.textContent.trim());
    const tags = [...row.querySelectorAll('a[href*="/tags/"], .tagItem, .tagList a')].map(n => n.textContent.trim().replace(/^#/, ''));
    const titleClone = titleLink.cloneNode(true);
    titleClone.querySelectorAll('.label').forEach(n => n.remove());
    const title = titleClone.textContent.trim() || `Thread ${thread.id}`;
    const snippet = row.querySelector('.contentRow-snippet')?.textContent.trim() || '';
    const minor = row.querySelector('.contentRow-minor')?.textContent.replace(/\s+/g, ' ').trim() || '';
    const dateAttr = row.querySelector('time[datetime]')?.getAttribute('datetime') || '';
    const replyText = [...row.querySelectorAll('dl')].find(dl => /^(?:Replies|Odpovede)$/i.test(dl.querySelector('dt')?.textContent.trim() || ''))?.querySelector('dd')?.textContent || '';
    const replies = Number(replyText.replace(/[^0-9]/g, '')) || Number((row.textContent.match(/(?:Replies|Odpovede)\s*:?\s*(\d+)/i) || [])[1]) || 0;
    const forumLink = row.querySelector('.structItem-minor a[href*="/forums/"], .contentRow-minor a[href*="/forums/"]');
    const forum = forumLink?.textContent.trim()
      || (row.textContent.match(/Forum:\s*([^\n]+?)\s*$/im) || [])[1]
      || '';
    const hay = norm([title, snippet, ...tags, ...labels, forum, minor].join(' \u0001 '));
    return { ...thread, row, title, tags, labels, snippet, date: parseDate(dateAttr), replies, forum, hay };
  }

  function attach(entry) {
    entry.idx = entries.length;
    entries.push(entry);
    byId.set(entry.id, entry);
    entry.row.classList.add('nti-s-row');
    const pick = el('label', undefined, 'nti-s-pick');
    pick.title = 'Vybrať thread na skenovanie';
    const box = document.createElement('input'); box.type = 'checkbox';
    box.checked = selected.has(entry.id);
    box.addEventListener('change', () => { box.checked ? selected.add(entry.id) : selected.delete(entry.id); refresh(); });
    const badge = el('span', '', 'nti-s-badge'); badge.hidden = true;
    pick.append(badge, box);
    entry.box = box; entry.badge = badge;
    const isStruct = isWatched || entry.row.classList.contains('structItem') || Boolean(entry.row.querySelector('.structItem-title'));
    if (isStruct) {
      // XenForo rows use display: table-row; a direct child would become an extra cell.
      const title = entry.row.querySelector('.structItem-title, .title') || entry.row;
      pick.classList.add('nti-s-watched-pick');
      title.append(pick);
      entry.details = el('div', undefined, 'nti-s-details');
      title.after(entry.details);
      readDetail(entry).then(data => { renderDetails(entry, data); restoreScan(entry, data); refresh(); }).catch(() => {});
    } else {
      entry.row.prepend(pick);
      const main = entry.row.querySelector('.contentRow-main') || entry.row;
      entry.details = el('div', undefined, 'nti-s-details');
      main.append(entry.details);
      readDetail(entry).then(data => { renderDetails(entry, data); restoreScan(entry, data); refresh(); }).catch(() => {});
    }
  }

  function collectInitial() {
    const rows = resultRows(document);
    if (rows.length) container = rows[0].parentElement;
    for (const row of rows) {
      const d = describeRow(row);
      if (d && !byId.has(d.id)) attach(d);
    }
  }

  // ---------- filter / sort ----------
  function parseTerms(text) {
    const raw = String(text || '').trim();
    if (!raw) return { inc: [], exc: [] };
    const parts = (raw.includes(',') ? raw.split(',') : raw.split(/\s+/)).map(s => norm(s.trim())).filter(Boolean);
    return { inc: parts.filter(p => !p.startsWith('-')), exc: parts.filter(p => p.startsWith('-') && p.length > 1).map(p => p.slice(1)) };
  }

  function entryMatches(e, terms, mode) {
    if (terms.exc.some(t => e.hay.includes(t))) return false;
    if (!terms.inc.length) return true;
    const test = t => e.hay.includes(t);
    return mode === 'any' ? terms.inc.some(test) : terms.inc.every(test);
  }

  function refresh() {
    if (!panel) return;
    const terms = parseTerms(q('[data-f="terms"]').value);
    const mode = q('[data-f="mode"]').value;
    const onlyMatched = q('[data-f="only-matched"]').checked;
    const onlySelected = q('[data-f="only-selected"]').checked;
    const onlyScanned = q('[data-f="only-found"]').checked;
    const minReplies = Number(q('[data-f="min-replies"]').value) || 0;
    const from = q('[data-f="date-from"]').value ? Date.parse(`${q('[data-f="date-from"]').value}T00:00:00`) : 0;
    const sort = q('[data-f="sort"]').value;
    const hasFilter = terms.inc.length || terms.exc.length;
    let shown = 0;
    for (const e of entries) {
      e.matched = entryMatches(e, terms, mode);
      const visible = (!onlyMatched || e.matched)
        && (!onlySelected || selected.has(e.id))
        && (!onlyScanned || (scanned.get(e.id)?.count > 0))
        && e.replies >= minReplies
        && (!from || e.date >= from);
      e.row.classList.toggle('nti-s-hide', !visible);
      e.row.classList.toggle('nti-s-match', Boolean(hasFilter && e.matched && terms.inc.length));
      e.box.checked = selected.has(e.id);
      if (visible) shown += 1;
    }
    const cmp = {
      relevance: (a, b) => a.idx - b.idx,
      'date-desc': (a, b) => b.date - a.date || a.idx - b.idx,
      'date-asc': (a, b) => a.date - b.date || a.idx - b.idx,
      replies: (a, b) => b.replies - a.replies || a.idx - b.idx,
      title: (a, b) => a.title.localeCompare(b.title) || a.idx - b.idx,
      matched: (a, b) => Number(b.matched) - Number(a.matched) || a.idx - b.idx,
      links: (a, b) => (scanned.get(b.id)?.count || 0) - (scanned.get(a.id)?.count || 0) || a.idx - b.idx,
    }[sort] || ((a, b) => a.idx - b.idx);
    if (container) [...entries].sort(cmp).forEach(e => { if (e.row.parentElement === container) container.append(e.row); });
    renderState(shown);
  }

  function totalLinks() {
    return [...cards.values()].filter(c => c.occurrences.some(o => selected.has(o.threadId))).length;
  }

  function renderState(shown = entries.filter(e => !e.row.classList.contains('nti-s-hide')).length) {
    if (!panel) return;
    const selectedCards = [...cards.values()].filter(c => c.occurrences.some(o => selected.has(o.threadId)));
    const threadSel = q('[data-f="thread"]');
    if (threadSel) {
      const priorThread = threadSel.value;
      const threadCounts = new Map();
      for (const card of selectedCards) {
        const seenForCard = new Set();
        for (const occ of card.occurrences) {
          if (!selected.has(occ.threadId) || seenForCard.has(occ.threadId)) continue;
          seenForCard.add(occ.threadId);
          threadCounts.set(occ.threadId, (threadCounts.get(occ.threadId) || 0) + 1);
        }
      }
      const threadOptions = entries
        .filter(e => threadCounts.has(e.id))
        .map(e => ({ id: e.id, title: e.title, count: threadCounts.get(e.id) }));
      threadSel.replaceChildren(new Option(`Všetky thready (${threadOptions.length})`, ''));
      threadOptions.forEach(t => threadSel.append(new Option(`${t.title} (${t.count})`, t.id)));
      threadSel.value = threadOptions.some(t => t.id === priorThread) ? priorThread : '';
    }
    const readyToSend = filteredCards();
    q('[data-part="counts"]').textContent = `Zobrazené ${shown}/${entries.length} • Vybrané ${selected.size} • Odkazov ${totalLinks()}`;
    q('[data-part="status"]').textContent = status;
    q('[data-part="progress"]').textContent = progress;
    q('[data-a="scan"]').disabled = running || selected.size === 0;
    q('[data-a="stop"]').disabled = !running && !loadingPages;
    q('[data-a="load-pages"]').disabled = loadingPages || running;
    for (const action of ['tags', 'videos', 'clear-details']) q(`[data-a="${action}"]`).disabled = loadingPages || running;
    q('[data-a="send"]').disabled = running || sending || readyToSend.length === 0;
    q('[data-a="send"]').textContent = `Poslať do Testera (${readyToSend.length})`;
    const hosts = [...new Set(selectedCards.map(c => c.host).filter(Boolean))].sort();
    const hostSel = q('[data-f="host"]'); const prior = hostSel.value;
    hostSel.replaceChildren(new Option('Všetky zdroje', ''));
    hosts.forEach(h => hostSel.append(new Option(h, h)));
    hostSel.value = hosts.includes(prior) ? prior : '';
    const errBox = q('[data-part="errors"]');
    errBox.textContent = failures.slice(-8).join('\n');
    errBox.hidden = !failures.length;
    for (const e of entries) {
      const s = scanned.get(e.id);
      e.badge.hidden = !s;
      if (s) e.badge.textContent = s.error ? '⚠ chyba' : `${s.count} liniek • ${s.pages} str.`;
      e.badge.title = s?.error || '';
    }
  }

  function filteredCards() {
    const host = q('[data-f="host"]')?.value || '';
    const threadId = q('[data-f="thread"]')?.value || '';
    return [...cards.values()].filter(c =>
      (!host || c.host === host)
      && c.occurrences.some(o => selected.has(o.threadId) && (!threadId || o.threadId === threadId))
    );
  }

  // ---------- sieť ----------
  const wait = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(new DOMException('Zastavené', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });

  async function paceRequest(signal) {
    const turn = requestTail.catch(() => {}).then(async () => {
      const delay = Math.max(cooldownUntil - Date.now(), lastRequestAt + 800 - Date.now(), 0);
      if (delay > 0) await wait(delay, signal);
      if (signal.aborted) throw new DOMException('Zastavené', 'AbortError');
      lastRequestAt = Date.now();
    });
    requestTail = turn;
    await turn;
  }

  async function fetchDoc(url, signal) {
    const target = new URL(url, here.href);
    if (target.origin !== here.origin || !(/^\/(search|threads|tags|forums)\//.test(target.pathname) || /^\/watched\/threads(?:\/|$)/.test(target.pathname))) throw new Error('Neplatná adresa stránky.');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await paceRequest(signal);
      const response = await fetch(target.href, { credentials: 'include', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
      if (response.status === 429) {
        rateStreak += 1;
        const header = response.headers.get('Retry-After');
        const retry = Number(header);
        const delay = Math.min(60000, Math.max(10000 * 2 ** Math.min(rateStreak - 1, 3), Number.isFinite(retry) ? retry * 1000 : 0));
        cooldownUntil = Math.max(cooldownUntil, Date.now() + delay);
        if (rateStreak >= 3 || attempt === 2) {
          const err = new Error('SimpCity vrátilo opakovane HTTP 429. Sken je pozastavený.');
          err.name = 'RateLimitError';
          throw err;
        }
        status = `SimpCity obmedzil požiadavky (429). Čakám ${Math.ceil(delay / 1000)} s…`;
        renderState();
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      rateStreak = 0;
      const finalUrl = new URL(response.url);
      if (finalUrl.origin !== here.origin || /^\/(login|account)\b/.test(finalUrl.pathname)) throw new Error('SimpCity vyžaduje prihlásenie.');
      const html = await response.text();
      if (html.length > 5_000_000) throw new Error('Stránka je príliš veľká.');
      return new DOMParser().parseFromString(html, 'text/html');
    }
    throw new Error('SimpCity obmedzilo počet požiadaviek (429).');
  }

  // ---------- ďalšie strany výsledkov ----------
  async function loadResultPages() {
    if (loadingPages || running || !container) return;
    const amount = Number(q('[data-f="page-count"]').value);
    const currentBase = here.pathname.replace(/\/page-\d+\/?$/i, '').replace(/\/$/, '');
    const pageLinks = [...document.querySelectorAll('.pageNav a[href], .pageNav-page a[href]')]
      .map(a => safeHttp(a.getAttribute('href')))
      .filter(url => {
        if (!url) return false;
        try {
          const u = new URL(url);
          if (u.origin !== here.origin) return false;
          const uBase = u.pathname.replace(/\/page-\d+\/?$/i, '').replace(/\/$/, '');
          return uBase === currentBase;
        } catch { return false; }
      });
    const total = Math.min(MAX_RESULT_PAGES, Math.max(1, pageNumber(here.href), ...pageLinks.map(pageNumber)));
    const sample = pageLinks.find(link => pageNumber(link) > 1);
    const first = pageNumber(here.href);
    const remaining = Array.from({ length: Math.max(0, total - first) }, (_, i) => first + i + 1)
      .filter(page => !loadedResultPages.has(page));
    const targets = amount ? remaining.slice(0, amount) : remaining;
    if (!targets.length) { status = `Ďalšie strany už nie sú dostupné (limit ${MAX_RESULT_PAGES} strán).`; refresh(); return; }
    loadingPages = true; controller = new AbortController();
    let completed = 0;
    try {
      for (const page of targets) {
        const url = new URL(sample || here.href);
        url.hash = '';
        if (/\/page-\d+/i.test(url.pathname)) url.pathname = url.pathname.replace(/\/page-\d+/i, `/page-${page}`);
        else if (url.searchParams.has('page')) url.searchParams.set('page', String(page));
        else if (sample && /\/page-\d+/i.test(new URL(sample).pathname)) url.pathname = `${currentBase}/page-${page}/`;
        else url.searchParams.set('page', String(page));
        progress = `Strana výsledkov ${page}/${total}`;
        status = 'Načítavam ďalšie strany výsledkov…';
        renderState();
        const doc = await fetchDoc(url.href, controller.signal);
        const rows = resultRows(doc);
        if (!rows.length) throw new Error(`Strana ${page} neobsahuje rozpoznateľné thready.`);
        for (const row of rows) {
          const d = describeRow(row);
          if (!d) continue;
          const existing = byId.get(d.id);
          if (existing) {
            if (existing.row.parentElement !== container) container.append(existing.row);
            continue;
          }
          d.row = document.importNode(row, true);
          container.append(d.row);
          attach(d);
        }
        loadedResultPages.add(page);
        completed += 1;
        refresh();
      }
      status = `Načítaných ďalších strán: ${completed}. Celkom ${entries.length} threadov.`;
    } catch (error) {
      status = error.name === 'AbortError' ? 'Načítavanie zastavené.' : `Načítanie strán zlyhalo: ${error.message}`;
    } finally {
      loadingPages = false; controller = null; progress = ''; refresh();
    }
  }

  function restoreScan(entry, data) {
    if (!data.scan || !Array.isArray(data.scan.cards)) return;
    for (const card of data.scan.cards) {
      if (!card?.key || !Array.isArray(card.occurrences)) continue;
      for (const occ of card.occurrences) {
        if (occ.threadId === entry.id) {
          occ.threadTitle = entry.title || occ.threadTitle || '';
          occ.threadUrl = entry.url || occ.threadUrl || '';
        }
      }
      const existing = cards.get(card.key);
      if (!existing) cards.set(card.key, card);
      else for (const occurrence of card.occurrences) {
        if (!existing.occurrences.some(o => o.threadId === occurrence.threadId && o.postId === occurrence.postId)) existing.occurrences.push(occurrence);
      }
    }
    scanned.set(entry.id, { count: data.scan.count, pages: data.scan.pages });
  }

  async function saveScan(entry, count, pages) {
    const data = await readDetail(entry);
    data.scan = { count, pages, cards: [...cards.values()].filter(card => card.occurrences.some(o => o.threadId === entry.id)).map(card => ({...card, occurrences: card.occurrences.filter(o => o.threadId === entry.id)})) };
    await saveDetail(entry, data);
  }

  function renderDetails(entry, data) {
    if (!entry.details) return;
    if (Array.isArray(data.tags)) {
      entry.tags = data.tags;
      entry.hay = norm([entry.title, entry.snippet, ...entry.labels, ...data.tags].join(' '));
    }
    entry.details.replaceChildren();
    if (Array.isArray(data.tags)) {
      const tags = el('div', undefined, 'nti-s-tags');
      data.tags.forEach(tag => tags.append(el('span', tag, 'nti-s-tag')));
      entry.details.append(tags);
    }
    if (!Array.isArray(data.videos)) return;
    const previews = el('div', undefined, 'nti-s-previews');
    for (const video of data.videos) {
      const link = el('a', undefined, 'nti-s-preview');
      link.href = safeHttp(video.postUrl, entry.url) || entry.url;
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      if (safeHttp(video.thumbnail)) {
        const img = document.createElement('img'); img.src = safeHttp(video.thumbnail); img.loading = 'lazy'; img.alt = '';
        img.addEventListener('error', () => { img.remove(); link.classList.add('nti-s-no-image'); }); link.append(img);
      }
      link.append(el('span', video.text || video.host || 'Video')); previews.append(link);
    }
    if (data.videosDone && !data.videos.length) previews.append(el('span', 'V threade sa nenašli videá.', 'nti-s-empty'));
    entry.details.append(previews);
  }

  async function loadThreadDetails(mode) {
    if (running || loadingPages) return;
    const targets = entries.filter(e => selected.size ? selected.has(e.id) : !e.row.classList.contains('nti-s-hide'));
    if (!targets.length) return;
    loadingPages = true; controller = new AbortController();
    let done = 0, failed = 0;
    try {
      for (const entry of targets) {
        if (controller.signal.aborted) break;
        const data = await readDetail(entry);
        if (mode === 'tags' ? data.tagsDone : data.videosDone) { done++; continue; }
        progress = `${mode === 'tags' ? 'Tagy' : 'Videá'} ${done + 1}/${targets.length}`; renderState();
        try {
          if (mode === 'tags') {
            const doc = await fetchDoc(entry.url, controller.signal);
            data.tags = [...new Set([...doc.querySelectorAll('.tagList a, a[href*="/tags/"]')].map(a => a.textContent.trim()).filter(Boolean))];
            data.tagsDone = true; data.tagsUpdatedAt = Date.now();
            data.pageCount = threadPageCount(doc, entry.url);
            await saveDetail(entry, data); renderDetails(entry, data);
          } else {
            let first = null;
            if (!data.videoNextPage) {
              first = await fetchDoc(entry.url, controller.signal);
              data.videoNextPage = threadPageCount(first, entry.url);
              data.videos = []; data.videoKeys = [];
            }
            const seen = new Set(data.videoKeys || []);
            while (data.videoNextPage >= 1 && data.videos.length < 6) {
              const page = data.videoNextPage;
              const pageUrl = page > 1 ? `${entry.url}page-${page}` : entry.url;
              const doc = page === 1 && first ? first : await fetchDoc(pageUrl, controller.signal);
              const parsed = scrape(doc, pageUrl);
              const found = parsed.posts.flatMap(post => (post.links || []).filter(link => link.kind === 'video' || link.kind === 'direct-video').map(link => ({...link, postUrl: post.postUrl})));
              for (const video of found.reverse()) {
                const turboId = video.url.match(/turbo\.cr\/(?:v|d|embed)\/([a-z0-9_-]+)/i)?.[1];
                const key = turboId ? `turbo:${turboId}` : canonicalLink(video.url);
                if (!key || seen.has(key)) continue;
                seen.add(key);
                if (turboId) video.thumbnail = `https://static.scdn.st/6049fd43-838b-492d-a20a-9aead716dfe7/thumbs/${turboId}.jpg`;
                data.videos.push(video);
                if (data.videos.length === 6) break;
              }
              data.videoKeys = [...seen]; data.videoNextPage = page - 1;
              data.videosDone = data.videos.length >= 6 || data.videoNextPage === 0;
              data.videosUpdatedAt = Date.now();
              await saveDetail(entry, data); renderDetails(entry, data);
            }
          }
        } catch (error) { if (error.name === 'AbortError') break; failed++; if (error.name === 'RateLimitError') throw error; }
        done++;
      }
      status = controller.signal.aborted ? `Zastavené: ${done}/${targets.length}. Hotové dáta ostávajú uložené.` : `Hotovo: ${done - failed}/${targets.length}${failed ? `, chyby: ${failed}` : ''}.`;
    } catch (error) { status = `Načítanie zlyhalo: ${error.message}`; }
    finally { loadingPages = false; controller = null; progress = ''; refresh(); }
  }

  async function clearDetails() {
    if (running || loadingPages) return;
    const targets = entries.filter(e => selected.size ? selected.has(e.id) : !e.row.classList.contains('nti-s-hide'));
    try {
      await chrome.storage.local.remove(targets.map(e => cacheKey(e.id)));
      targets.forEach(e => { detailCache.delete(e.id); renderDetails(e, {}); });
      status = `Cache vymazaná pre ${targets.length} tém.`; refresh();
    } catch (error) { status = `Cache: ${error.message}`; refresh(); }
  }

  // ---------- skenovanie threadov ----------
  function mergePost(entry, post) {
    const occurrence = { threadId: entry.id, threadTitle: entry.title, threadUrl: entry.url, postId: post.postId,
      postUrl: safeHttp(post.postUrl, entry.url) || `${entry.url}#post-${post.postId}` };
    let added = 0;
    for (const link of post.links || []) {
      const key = canonicalLink(link.url);
      if (!key) continue;
      let card = cards.get(key);
      if (!card) {
        card = { key, url: link.url, host: link.host, kind: link.kind, text: link.text || '', context: link.context || '',
          quality: link.quality || '', postAuthor: link.postAuthor || '', timestamp: link.timestamp || '',
          thumbnail: safeHttp(link.thumbnail), occurrences: [] };
        cards.set(key, card);
      }
      if (!card.occurrences.some(o => o.threadId === occurrence.threadId && o.postId === occurrence.postId)) {
        card.occurrences.push(occurrence);
        added += 1;
      }
    }
    return added;
  }

  function pageOldest(doc) {
    const times = [...doc.querySelectorAll('article.message')]
      .map(a => parseDate(a.querySelector('time[datetime]')?.getAttribute('datetime')))
      .filter(Boolean);
    return times.length ? Math.min(...times) : 0;
  }

  async function scanThread(entry, since, maxPages, signal) {
    const firstDoc = await fetchDoc(entry.url, signal);
    const pageCount = threadPageCount(firstDoc, entry.url);
    const order = [];
    if (since) for (let p = pageCount; p >= 1; p -= 1) order.push(p);
    else for (let p = 1; p <= pageCount; p += 1) order.push(p);
    const limited = maxPages > 0 ? order.slice(0, maxPages) : order;
    let count = 0, pages = 0;
    for (const page of limited) {
      const url = page === 1 ? entry.url : `${entry.url}page-${page}`;
      const doc = page === 1 ? firstDoc : await fetchDoc(url, signal);
      if (!doc.querySelector('article.message, [data-content^="post-"]')) throw new Error('Thread neobsahuje rozpoznateľné príspevky.');
      const parsed = scrape(doc, url);
      pages += 1;
      for (const post of parsed.posts) {
        const stamp = parseDate(post.links[0]?.timestamp);
        if (since && stamp && stamp < since) continue;
        mergePost(entry, post);
      }
      count = [...cards.values()].filter(c => c.occurrences.some(o => o.threadId === entry.id)).length;
      scanned.set(entry.id, { count, pages });
      if (since) {
        const oldest = pageOldest(doc);
        if (oldest && oldest < since) break;
      }
    }
    scanned.set(entry.id, { count, pages });
    await saveScan(entry, count, pages);
  }

  async function scanSelected() {
    if (running || loadingPages) return;
    const targets = entries.filter(e => selected.has(e.id));
    if (!targets.length) return;
    const sinceValue = q('[data-f="scan-since"]').value;
    const since = sinceValue ? Date.parse(`${sinceValue}T00:00:00`) : 0;
    const maxPages = Number(q('[data-f="max-pages"]').value) || 0;
    const redo = q('[data-f="rescan"]').checked;
    running = true; controller = new AbortController(); failures.length = 0;
    let done = 0, rateLimited = false;
    const queue = targets.filter(e => redo || !scanned.get(e.id) || scanned.get(e.id).error);
    status = `Skenujem ${queue.length} threadov${since ? ` od ${sinceValue}` : ''}…`;
    renderState();
    let next = 0;
    const worker = async () => {
      while (next < queue.length && !controller.signal.aborted) {
        const entry = queue[next++];
        try {
          await scanThread(entry, since, maxPages, controller.signal);
        } catch (error) {
          if (error.name === 'AbortError') break;
          if (error.name === 'RateLimitError') { rateLimited = true; controller.abort(); break; }
          scanned.set(entry.id, { count: 0, pages: 0, error: error.message });
          failures.push(`${entry.title}: ${error.message}`);
        }
        done += 1;
        progress = `${done}/${queue.length} threadov`;
        status = `Skenujem… ${totalLinks()} odkazov`;
        refresh();
      }
    };
    try {
      await Promise.all([worker(), worker()]);
      status = rateLimited ? 'Sken pozastavený po HTTP 429. Skús neskôr (hotové thready ostávajú).'
        : controller.signal.aborted ? 'Sken zastavený. Hotové thready ostávajú.'
        : `Hotovo: ${totalLinks()} unikátnych odkazov z ${done} threadov.`;
    } finally {
      running = false; controller = null; progress = ''; refresh();
    }
  }

  // ---------- odoslanie do Testera ----------
  async function sendToTester() {
    if (running || sending) return;
    const list = filteredCards();
    if (!list.length) return;
    const port = Number(q('[data-part="port"]').value);
    const activeThreadId = q('[data-f="thread"]')?.value || '';
    const chunks = [];
    for (let i = 0; i < list.length && chunks.length < MAX_SEND_CHUNKS; i += MAX_SEND) chunks.push(list.slice(i, i + MAX_SEND));
    sending = true; renderState();
    let sent = 0;
    try {
      for (const [index, chunk] of chunks.entries()) {
        const chunkThreads = new Map();
        const links = chunk.map(card => {
          const matchingOccs = card.occurrences.filter(o => selected.has(o.threadId) && (!activeThreadId || o.threadId === activeThreadId));
          const occs = (matchingOccs.length ? matchingOccs : card.occurrences).map(o => {
            const oe = byId.get(o.threadId);
            return {
              ...o,
              threadTitle: o.threadTitle || oe?.title || '',
              threadUrl: o.threadUrl || oe?.url || '',
              threadForum: o.threadForum || oe?.forum || '',
              threadLabels: o.threadLabels || oe?.labels || [],
            };
          });
          const first = occs[0] || {};
          const entry = byId.get(first.threadId);
          const countedInThreads = new Set();
          for (const o of occs) {
            const tKey = o.threadId || o.threadUrl || o.threadTitle;
            if (!tKey || countedInThreads.has(tKey)) continue;
            countedInThreads.add(tKey);
            const te = byId.get(o.threadId);
            if (!chunkThreads.has(tKey)) {
              chunkThreads.set(tKey, {
                id: o.threadId || '',
                title: o.threadTitle || te?.title || '',
                url: o.threadUrl || te?.url || '',
                forum: o.threadForum || te?.forum || '',
                labels: o.threadLabels || te?.labels || [],
                tags: te?.tags || [],
                replies: te?.replies || 0,
                linkCount: 0,
              });
            }
            chunkThreads.get(tKey).linkCount += 1;
          }
          return {
            url: card.url, host: card.host, text: card.text, context: card.context, quality: card.quality,
            postAuthor: card.postAuthor, postId: first.postId || '', timestamp: card.timestamp,
            threadId: first.threadId || '',
            threadTitle: first.threadTitle || entry?.title || '',
            threadUrl: first.threadUrl || entry?.url || '',
            threadForum: first.threadForum || entry?.forum || '',
            threadTags: entry?.tags || [],
            threadLabels: first.threadLabels || entry?.labels || [],
            postUrl: first.postUrl || '',
            thumbnail: card.thumbnail, occurrences: occs,
          };
        });
        const threads = [...chunkThreads.values()];
        const scopeLabel = isWatched ? 'Watched' : isTag ? 'Tag' : isForum ? 'Forum' : 'Search';
        const batchTitle = threads.length === 1
          ? `${threads[0].title}${chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : ''}`
          : threads.length > 1
            ? `SimpCity ${scopeLabel} (${threads.length} threadov)${chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : ''}`
            : `SimpCity ${scopeLabel} – ${document.title.replace(/\s+/g, ' ').slice(0, 80)}${chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : ''}`;
        status = `Posielam ${links.length} odkazov do Nexusu ${port} (${index + 1}/${chunks.length})…`; renderState();
        const response = await chrome.runtime.sendMessage({
          action: 'nexusThreadIntake.pushWatched',
          port,
          links,
          threads,
          title: batchTitle,
        });
        if (!response?.ok) throw new Error(response?.error || 'Odoslanie zlyhalo.');
        sent += response.count || links.length;
      }
      const skipped = list.length - chunks.reduce((n, c) => n + c.length, 0);
      status = `${sent} odkazov otvorených v Testeri. Import sa nespustil.${skipped ? ` Preskočených ${skipped} (limit ${MAX_SEND * MAX_SEND_CHUNKS}).` : ''}`;
    } catch (error) { status = `Tester: ${error.message}`; }
    sending = false; renderState();
  }

  // ---------- UI ----------
  function mount() {
    trigger = el('button', 'Nexus Search', 'nti-s-trigger'); trigger.type = 'button';
    panel = el('aside', undefined, 'nti-s-panel'); panel.hidden = true;
    panel.innerHTML = `
      <header><strong>Nexus Search → Tester</strong><button type="button" data-a="close" aria-label="Zavrieť">×</button></header>
      <section>
        <label>Tagy / slová (čiarka = viac výrazov, <code>-slovo</code> = vylúčiť)
          <input data-f="terms" type="search" placeholder="napr. bsc, onlyfans, -gay"></label>
        <div class="row">
          <select data-f="mode"><option value="all">Musia sedieť všetky</option><option value="any">Stačí aspoň jeden</option></select>
          <label class="chk"><input data-f="only-matched" type="checkbox" checked> Iba zhodné</label>
        </div>
        <div class="row">
          <label class="chk"><input data-f="only-selected" type="checkbox"> Iba vybrané</label>
          <label class="chk"><input data-f="only-found" type="checkbox"> Iba s odkazmi</label>
        </div>
        <div class="row">
          <label>Zoradiť <select data-f="sort">
            <option value="relevance">Relevantnosť</option><option value="date-desc">Dátum ↓</option><option value="date-asc">Dátum ↑</option>
            <option value="replies">Odpovede ↓</option><option value="title">Názov A–Z</option>
            <option value="matched">Zhodné hore</option><option value="links">Počet liniek ↓</option></select></label>
          <label>Min. odpovedí <input data-f="min-replies" type="number" min="0" value="0"></label>
        </div>
        <label>Thready od dátumu <input data-f="date-from" type="date"></label>
        <div class="row">
          <button type="button" data-a="select-visible">Vybrať zobrazené</button>
          <button type="button" data-a="clear">Zrušiť výber</button>
        </div>
        <div class="row">
          <label>Ďalšie strany <select data-f="page-count"><option value="1">1 strana</option><option value="5">5 strán</option><option value="10">10 strán</option><option value="0">Všetky (max. 60)</option></select></label>
          <button type="button" data-a="load-pages">Načítať ďalšie</button>
        </div>
      </section>
      <section>
        <strong>Skenovanie odkazov</strong>
        <div class="row"><button type="button" data-a="tags">Načítať tagy</button><button type="button" data-a="videos">Načítať videá</button></div><button type="button" data-a="clear-details">Obnoviť cache vybraných / zobrazených</button><small>Vybrané témy, inak všetky zobrazené. Hotové údaje sa uložia.</small>
        <label>Príspevky od dátumu (prázdne = celý thread) <input data-f="scan-since" type="date"></label>
        <div class="row">
          <label>Max strán / thread (0 = všetky) <input data-f="max-pages" type="number" min="0" value="0"></label>
          <label class="chk"><input data-f="rescan" type="checkbox"> Znovu aj hotové</label>
        </div>
        <div class="row"><button type="button" data-a="scan" class="primary">Skenovať vybrané</button><button type="button" data-a="stop">Stop</button></div>
      </section>
      <section class="state">
        <b data-part="counts"></b><span data-part="status"></span><small data-part="progress"></small>
        <pre data-part="errors" hidden></pre>
      </section>
      <footer>
        <select data-f="thread" aria-label="Thread"><option value="">Všetky thready (0)</option></select>
        <select data-f="host" aria-label="Zdroj"><option value="">Všetky zdroje</option></select>
        <label>Nexus <select data-part="port"><option>8000</option><option>8001</option><option>8002</option></select></label>
        <button type="button" data-a="send" class="primary">Poslať do Testera (0)</button>
      </footer>`;
    document.body.append(trigger, panel);
    trigger.addEventListener('click', () => { panel.hidden = !panel.hidden; if (!panel.hidden) refresh(); });
    panel.addEventListener('click', (event) => {
      const action = event.target.closest?.('[data-a]')?.dataset.a;
      if (action === 'close') panel.hidden = true;
      else if (action === 'select-visible') { entries.filter(e => !e.row.classList.contains('nti-s-hide')).forEach(e => selected.add(e.id)); refresh(); }
      else if (action === 'clear') { selected.clear(); refresh(); }
      else if (action === 'load-pages') loadResultPages();
      else if (action === 'tags') loadThreadDetails('tags');
      else if (action === 'videos') loadThreadDetails('videos');
      else if (action === 'clear-details') clearDetails();
      else if (action === 'scan') scanSelected();
      else if (action === 'stop') controller?.abort();
      else if (action === 'send') sendToTester();
    });
    panel.querySelectorAll('[data-f]').forEach(n => n.addEventListener('input', refresh));
    window.addEventListener('pagehide', () => controller?.abort(), { once: true });
  }

  if (typeof scrape !== 'function' || !document.body) return;
  if (isWatched) document.documentElement.classList.add('nti-watched-wide');
  collectInitial();
  mount();
  refresh();
})();

