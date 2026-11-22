(() => {
  const here = new URL(location.href);
  if (!/^([a-z0-9-]+\.)?simpcity\.cr$/i.test(here.hostname) || !/^\/watched\/threads(?:\/|$)/i.test(here.pathname)) return;
  if (globalThis.__nexusWatchedInstalled) return;
  globalThis.__nexusWatchedInstalled = true;

  const STORAGE_KEY = `nexusThreadIntake.watched.v1.${here.hostname}`;
  const JOB_KEY = `${STORAGE_KEY}.job`;
  const MAX_LIST_PAGES = 500;
  const MAX_CARDS = 3000;
  const MAX_SEND = 500;
  const rootUrl = new URL('/watched/threads', here.origin).href;
  const scrape = globalThis.__nexusThreadIntakeScrapeDocument;
  const saved = { cursors: {}, cards: [], selected: [], job: null };
  const stats = { listPages: 0, threads: 0, changed: 0, threadPages: 0, links: 0, errors: 0 };
  let running = false;
  let controller = null;
  let panel = null;
  let trigger = null;
  let renderTimer = null;
  let persistTail = Promise.resolve();
  let sending = false;
  let fetchingMeta = false;
  let metaProgress = '';
  let ready = false;
  let visibleLimit = 120;
  let cooldownUntil = 0;
  let rateStreak = 0;
  let pausedByRateLimit = false;
  let requestTail = Promise.resolve();
  let lastRequestAt = 0;
  let status = 'Otvor galériu a klikni Skontrolovať nové.';
  const failures = [];
  const cardMap = new Map();
  const selected = new Set();

  function safeHttp(raw, base = here.href) {
    try {
      if (!raw || !String(raw).trim()) return '';
      const url = new URL(raw, base);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
    } catch { return ''; }
  }

  function threadIdentity(raw) {
    try {
      const url = new URL(raw, here.href);
      if (url.origin !== here.origin || !/^\/threads\//.test(url.pathname)) return null;
      const path = url.pathname.replace(/\/(?:page-\d+|unread|latest|post-\d+)\/?$/i, '').replace(/\/$/, '');
      const match = path.match(/\.(\d+)$/);
      if (!match) return null;
      return { id: match[1], url: `${url.origin}${path}/` };
    } catch { return null; }
  }

  function pageNumber(raw) {
    try {
      const url = new URL(raw, here.href);
      return Number(url.pathname.match(/\/page-(\d+)\/?$/i)?.[1] || url.searchParams.get('page') || 1);
    } catch { return 1; }
  }

  function watchedPageNumber(doc, base) {
    const links = [...doc.querySelectorAll('.pageNav a[href], .pageNav-page a[href], a[href*="/watched/threads/page-"]')];
    const numbers = links.map(a => {
      const url = safeHttp(a.getAttribute('href'), base);
      return url && new URL(url).pathname.startsWith('/watched/threads') ? pageNumber(url) : 0;
    }).filter(n => Number.isInteger(n) && n > 0 && n <= 10000);
    return Math.max(1, ...numbers);
  }

  function watchedPageUrl(doc, page) {
    const sample = [...doc.querySelectorAll('.pageNav a[href], .pageNav-page a[href]')]
      .map(a => safeHttp(a.getAttribute('href'), rootUrl))
      .find(url => url && new URL(url).pathname.startsWith('/watched/threads') && pageNumber(url) > 1);
    if (sample) {
      const url = new URL(sample);
      if (url.searchParams.has('page')) {
        url.searchParams.set('page', String(page));
        return url.href;
      }
      if (/\/page-\d+\/?$/i.test(url.pathname)) {
        url.pathname = url.pathname.replace(/\/page-\d+\/?$/i, `/page-${page}`);
        return url.href;
      }
    }
    return `${rootUrl}?page=${page}`;
  }

  function watchedRows(doc, base) {
    const rows = [...doc.querySelectorAll('.structItem--thread, .discussionListItem, .thread-list-item')];
    const candidates = rows.length ? rows : [...doc.querySelectorAll('a[href*="/threads/"]')].map(a => a.closest('li, article, tr') || a.parentElement);
    const found = new Map();
    for (const row of candidates) {
      if (!row) continue;
      const links = [...row.querySelectorAll('a[href*="/threads/"]')];
      const titleLink = row.querySelector('.structItem-title a[href*="/threads/"], .title a[href*="/threads/"]')
        || links.find(a => threadIdentity(a.getAttribute('href')));
      const thread = threadIdentity(titleLink?.getAttribute('href'));
      if (!thread || found.has(thread.id)) continue;
      const latestTime = row.querySelector('.structItem-cell--latest time[datetime], .structItem-latestDate[datetime], .lastPost time[datetime]');
      const marker = latestTime?.getAttribute('datetime')
        || latestTime?.getAttribute('data-timestamp')
        || '';
      const lastPage = Math.max(1, ...[...row.querySelectorAll('.structItem-pageJump a[href]')]
        .map(a => safeHttp(a.getAttribute('href'), base))
        .filter(url => url && threadIdentity(url)?.id === thread.id)
        .map(pageNumber));
      found.set(thread.id, { ...thread, title: titleLink.textContent.trim() || `Thread ${thread.id}`, marker, lastPage });
    }
    return [...found.values()];
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

  function cardsFromPages(pages, cursorId, firstRun) {
    const scanned = [];
    let foundCursor = firstRun;
    for (const page of pages) {
      const ids = page.allPostIds || [];
      const cursorIndex = cursorId ? ids.indexOf(cursorId) : -1;
      const accepted = new Set(cursorIndex >= 0 ? ids.slice(cursorIndex + 1) : ids);
      scanned.push(...(page.posts || []).filter(post => accepted.has(post.postId)));
      if (cursorIndex >= 0) { foundCursor = true; break; }
    }
    return { posts: scanned, foundCursor };
  }

  function makeOccurrence(thread, post) {
    return { threadId: thread.id, threadTitle: thread.title, threadUrl: thread.url,
      postId: post.postId, postUrl: safeHttp(post.postUrl, thread.url) || `${thread.url}#post-${post.postId}` };
  }

  function mergePosts(thread, posts) {
    let added = 0;
    for (const post of posts.reverse()) {
      const occurrence = makeOccurrence(thread, post);
      for (const link of post.links || []) {
        const key = canonicalLink(link.url);
        if (!key) continue;
        let card = cardMap.get(key);
        if (!card) {
          card = { key, url: link.url, host: link.host, kind: link.kind,
            text: link.text || '', context: link.context || '', quality: link.quality || '',
            thumbnail: safeHttp(link.thumbnail), postAuthor: link.postAuthor || '',
            timestamp: link.timestamp || '', occurrences: [] };
          cardMap.set(key, card);
          added += 1;
        }
        if (!card.thumbnail && link.thumbnail) card.thumbnail = safeHttp(link.thumbnail);
        if (!card.occurrences.some(item => item.threadId === occurrence.threadId && item.postId === occurrence.postId)) {
          card.occurrences.push(occurrence);
        }
      }
    }
    stats.links += added;
    return added;
  }

  function persist() {
    const snapshot = {
      cursors: { ...saved.cursors },
      cards: [...cardMap.values()].slice(-MAX_CARDS),
      selected: [...selected],
    };
    persistTail = persistTail.catch(() => {}).then(() => chrome.storage.local.set({ [STORAGE_KEY]: snapshot }));
    return persistTail;
  }

  function persistJob() {
    const snapshot = saved.job ? structuredClone(saved.job) : null;
    persistTail = persistTail.catch(() => {}).then(() => chrome.storage.local.set({ [JOB_KEY]: snapshot }));
    return persistTail;
  }

  function wait(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
      const abort = () => { clearTimeout(timer); reject(new DOMException('Zastavené', 'AbortError')); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  async function paceRequest(signal) {
    const turn = requestTail.catch(() => {}).then(async () => {
      const delay = Math.max(cooldownUntil - Date.now(), lastRequestAt + 900 - Date.now(), 0);
      if (delay > 0) await wait(delay, signal);
      if (signal.aborted) throw new DOMException('Zastavené', 'AbortError');
      lastRequestAt = Date.now();
    });
    requestTail = turn;
    await turn;
  }

  async function fetchDoc(url, signal) {
    const target = new URL(url, here.href);
    if (target.origin !== here.origin || !/^\/(watched\/threads|threads\/)/.test(target.pathname)) throw new Error('Neplatná adresa stránky.');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await paceRequest(signal);
      const response = await fetch(target.href, { credentials: 'include', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
      if (response.status === 429) {
        rateStreak += 1;
        const retryHeader = response.headers.get('Retry-After');
        const retry = Number(retryHeader);
        const until = Date.parse(retryHeader || '');
        const requestedDelay = Number.isFinite(retry) ? retry * 1000
          : Number.isFinite(until) ? until - Date.now() : 10000;
        const delay = Math.min(60000, Math.max(10000 * 2 ** Math.min(rateStreak - 1, 3), requestedDelay));
        cooldownUntil = Math.max(cooldownUntil, Date.now() + delay);
        if (rateStreak >= 3 || attempt === 2) {
          const error = new Error('SimpCity vrátilo opakovane HTTP 429. Sken je pozastavený.');
          error.name = 'RateLimitError';
          throw error;
        }
        status = `SimpCity obmedzil požiadavky (429). Čakám ${Math.ceil(delay / 1000)} s…`;
        scheduleRender();
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      rateStreak = 0;
      const finalUrl = new URL(response.url);
      if (finalUrl.origin !== here.origin || /^\/(login|account)\b/.test(finalUrl.pathname)) throw new Error('SimpCity vyžaduje prihlásenie.');
      const html = await response.text();
      if (html.length > 5_000_000) throw new Error('Stránka je príliš veľká.');
      const doc = new DOMParser().parseFromString(html, 'text/html');
      if (/just a moment|checking your browser|access denied|log in/i.test(doc.title)
        && !doc.querySelector('.structItem--thread, article.message')) {
        throw new Error('SimpCity vyžaduje prihlásenie alebo overenie v prehliadači.');
      }
      return doc;
    }
    throw new Error('SimpCity obmedzil počet požiadaviek (429).');
  }

  async function collectWatched(signal) {
    if (saved.job?.phase === 'threads') return saved.job.threads;
    let first = null;
    if (!saved.job) {
      first = await fetchDoc(rootUrl, signal);
      const total = watchedPageNumber(first, rootUrl);
      if (total > MAX_LIST_PAGES) throw new Error(`Zoznam má ${total} strán; bezpečnostný limit je ${MAX_LIST_PAGES}.`);
      saved.job = {
        phase: 'list', listUrls: Array.from({ length: total }, (_, index) =>
          index === 0 ? rootUrl : watchedPageUrl(first, index + 1)),
        listNext: 1, listRows: [], threads: [], doneIds: [], partials: {}, startedAt: Date.now(),
      };
      await persistJob();
    }
    const job = saved.job;
    const total = job.listUrls.length;
    const byId = new Map(job.listRows.map(row => [row.id, row]));
    stats.listPages = job.listNext - 1;
    stats.threads = byId.size;
    for (let page = job.listNext; page <= total; page += 1) {
      if (signal.aborted) throw new DOMException('Zastavené', 'AbortError');
      const pageUrl = job.listUrls[page - 1];
      const doc = page === 1 && first ? first : await fetchDoc(pageUrl, signal);
      const rows = watchedRows(doc, pageUrl);
      if (!rows.length && doc.querySelector('input[name="login"], form[action*="/login"]')) {
        throw new Error('Na Watched Threads sa musíš prihlásiť.');
      }
      if (!rows.length && page > 1) throw new Error(`Zoznam sledovaných threadov: strana ${page} je prázdna.`);
      rows.forEach(row => byId.set(row.id, row));
      job.listRows = [...byId.values()];
      job.listNext = page + 1;
      await persistJob();
      stats.listPages = page;
      stats.threads = byId.size;
      status = `Zoznam: ${page}/${total} strán · ${byId.size} threadov`;
      scheduleRender();
    }
    job.phase = 'threads';
    job.threads = [...byId.values()];
    delete job.listRows;
    delete job.listUrls;
    delete job.listNext;
    await persistJob();
    return job.threads;
  }

  async function scanThread(thread, signal) {
    const prior = saved.cursors[thread.id];
    if (prior && thread.marker && prior.marker === thread.marker) {
      delete saved.job.partials[thread.id];
      return false;
    }
    let partial = saved.job.partials[thread.id];
    const hasPageHint = Number.isInteger(thread.lastPage) && thread.lastPage > 1;
    const firstDoc = partial || hasPageHint ? null : await fetchDoc(thread.url, signal);
    const pageCount = partial?.pageCount || (hasPageHint ? thread.lastPage : threadPageCount(firstDoc, thread.url));
    const lastUrl = pageCount === 1 ? thread.url : `${thread.url}page-${pageCount}`;
    if (!partial) {
      partial = { pageCount, nextPage: pageCount, lastId: '', pages: [] };
      saved.job.partials[thread.id] = partial;
    }
    const pages = partial.pages;
    let lastId = partial.lastId;
    for (let page = partial.nextPage; page >= 1; page -= 1) {
      const url = page === 1 ? thread.url : `${thread.url}page-${page}`;
      const doc = page === 1 && firstDoc ? firstDoc : await fetchDoc(url, signal);
      if (!doc.querySelector('article.message, [data-content^="post-"], .post-container, .postbit, .post')) {
        throw new Error('Thread neobsahuje rozpoznateľné príspevky.');
      }
      const parsed = scrape(doc, url);
      if (!parsed.allPostIds?.length) throw new Error('Na stránke sa nenašli príspevky.');
      if (!lastId) lastId = parsed.allPostIds.at(-1);
      pages.push({ allPostIds: parsed.allPostIds, posts: parsed.posts.map(post => ({
        postId: post.postId, postUrl: post.postUrl, links: post.links,
      })) });
      partial.lastId = lastId;
      partial.nextPage = page - 1;
      stats.threadPages += 1;
      if (!prior || parsed.allPostIds.includes(prior.postId)) {
        const result = cardsFromPages(pages, prior?.postId || '', !prior);
        const added = mergePosts(thread, result.posts);
        saved.cursors[thread.id] = { postId: lastId, marker: thread.marker || '', lastUrl, scannedAt: Date.now() };
        delete saved.job.partials[thread.id];
        stats.changed += 1;
        try { await persist(); await persistJob(); }
        catch (error) {
          if (prior) saved.cursors[thread.id] = prior;
          else delete saved.cursors[thread.id];
          saved.job.partials[thread.id] = partial;
          throw new Error(`Výsledky sa nepodarilo uložiť: ${error.message}`);
        }
        status = `${thread.title}: ${added} nových odkazov`;
        scheduleRender();
        return true;
      }
      await persistJob();
    }
    delete saved.job.partials[thread.id];
    await persistJob();
    throw new Error('Posledný skenovaný príspevok sa nenašiel. Kurzor sa nezmenil.');
  }

  async function scanAll() {
    if (running || !ready) return;
    running = true;
    controller = new AbortController();
    Object.keys(stats).forEach(key => { stats[key] = 0; });
    failures.length = 0;
    pausedByRateLimit = false;
    status = saved.job ? 'Pokračujem v rozpracovanom skene…' : 'Načítavam sledované thready…';
    scheduleRender();
    try {
      const threads = await collectWatched(controller.signal);
      const done = new Set(saved.job.doneIds);
      stats.threads = threads.length;
      let next = 0;
      const worker = async () => {
        while (next < threads.length && !controller.signal.aborted) {
          const thread = threads[next++];
          if (done.has(thread.id)) continue;
          try {
            const fetched = await scanThread(thread, controller.signal);
            done.add(thread.id);
            saved.job.doneIds = [...done];
            if (fetched || done.size % 25 === 0) await persistJob();
            status = `Spracovaných ${done.size}/${threads.length} threadov · ${stats.links} nových odkazov`;
            scheduleRender();
          }
          catch (error) {
            if (error.name === 'AbortError') break;
            if (error.name === 'RateLimitError') {
              pausedByRateLimit = true;
              controller.abort();
              break;
            }
            stats.errors += 1;
            failures.push(`${thread.title}: ${error.message}`);
            scheduleRender();
          }
        }
      };
      await Promise.all([worker(), worker()]);
      if (saved.job && (controller.signal.aborted || done.size < threads.length)) await persistJob();
      if (!controller.signal.aborted && done.size === threads.length) {
        saved.job = null;
        await persistJob();
      }
      status = pausedByRateLimit ? 'Sken pozastavený po opakovanom HTTP 429. Priebeh je uložený; pokračuj neskôr.'
        : controller.signal.aborted ? 'Sken zastavený. Priebeh je uložený; pokračuj tlačidlom Pokračovať v skene.'
        : saved.job ? `Spracovaných ${done.size}/${threads.length} threadov · ${stats.errors} chýb. Neúspešné thready čakajú na opakovanie.`
        : `Hotovo: ${stats.changed} zmenených threadov · ${stats.links} nových odkazov.`;
    } catch (error) {
      status = error.name === 'AbortError' ? 'Sken zastavený. Priebeh je uložený.'
        : error.name === 'RateLimitError' ? 'Sken pozastavený po HTTP 429. Pokračuj neskôr.'
        : `Zber zlyhal: ${error.message}`;
    } finally {
      running = false;
      controller = null;
      scheduleRender();
    }
  }

  function textNode(tag, value, className = '') {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
  }

  function linkNode(label, href) {
    const anchor = textNode('a', label);
    anchor.href = safeHttp(href) || '#';
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    return anchor;
  }

  function formatDuration(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return 'Nezistené';
    const parts = [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), Math.floor(seconds % 60)];
    return (parts[0] ? parts : parts.slice(1)).map((part, index) => index ? String(part).padStart(2, '0') : String(part)).join(':');
  }

  function formatSize(meta) {
    const bytes = Number(meta.size_bytes) || Number(meta.size_mb) * 1048576;
    if (!Number.isFinite(bytes) || bytes <= 0) return 'Nezistená';
    const unit = bytes >= 1073741824 ? 'GB' : 'MB';
    return `${(bytes / (unit === 'GB' ? 1073741824 : 1048576)).toFixed(1)} ${unit}${meta.size_estimated ? ' (odhad)' : ''}`;
  }

  function formatResolution(meta) {
    const width = Number(meta.width), height = Number(meta.height);
    if (width > 0 && height > 0) return `${width} × ${height}`;
    return height > 0 ? `${height}p` : (meta.quality || 'Nezistené');
  }

  function sourceMetadata(card) {
    const box = document.createElement('dl'); box.className = 'nti-source-meta';
    const meta = card.sourceMeta;
    if (!meta) {
      box.append(textNode('span', card.metaError ? `Zdroj: ${card.metaError}` : 'Údaje zo zdroja ešte nie sú načítané.'));
      return box;
    }
    for (const [label, value] of [
      ['Trvanie', formatDuration(meta.duration)], ['Veľkosť', formatSize(meta)],
      ['Rozlíšenie', formatResolution(meta)], ['Upload', meta.upload_date || 'Nezistený'],
    ]) {
      box.append(textNode('dt', label), textNode('dd', value));
    }
    if (meta.item_count > 1 || meta.video_count > 1) box.append(textNode('dt', 'Položky'), textNode('dd', String(meta.item_count || meta.video_count)));
    return box;
  }

  function openPlayer(card) {
    const modal = panel.querySelector('[data-part="player"]');
    const frame = modal.querySelector('iframe');
    modal.querySelector('[data-part="player-title"]').textContent = card.sourceMeta?.title || card.text || card.url;
    modal.querySelector('[data-part="player-source"]').href = card.url;
    modal.hidden = false;
    const port = Number(panel.querySelector('[data-part="port"]').value);
    frame.onload = () => frame.contentWindow?.postMessage({ type: 'nexusThreadIntake.play', url: card.url, port }, chrome.runtime.getURL('').replace(/\/$/, ''));
    frame.src = chrome.runtime.getURL('player.html');
  }

  function closePlayer() {
    const modal = panel.querySelector('[data-part="player"]');
    const frame = modal.querySelector('iframe');
    frame.onload = null;
    frame.src = 'about:blank';
    modal.hidden = true;
  }

  function visibleCards() {
    const query = panel.querySelector('[data-filter="thread"]').value.trim().toLowerCase();
    const host = panel.querySelector('[data-filter="host"]').value;
    const kind = panel.querySelector('[data-filter="kind"]').value;
    return [...cardMap.values()].reverse().filter(card =>
      (!query || card.occurrences.some(o => o.threadTitle.toLowerCase().includes(query)) || card.text.toLowerCase().includes(query))
      && (!host || card.host === host) && (!kind || card.kind === kind));
  }

  function renderCard(card) {
    const item = document.createElement('article');
    item.className = 'nti-card';
    const head = document.createElement('div'); head.className = 'nti-card-head';
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selected.has(card.key);
    check.setAttribute('aria-label', `Vybrať ${card.text || card.url}`);
    check.addEventListener('change', () => { check.checked ? selected.add(card.key) : selected.delete(card.key); persist(); scheduleRender(); });
    head.append(check, textNode('strong', card.text || card.url));
    const preview = document.createElement('div'); preview.className = 'nti-preview';
    if (card.thumbnail) {
      const img = document.createElement('img'); img.src = card.thumbnail; img.loading = 'lazy'; img.alt = '';
      img.addEventListener('error', () => { img.remove(); preview.append(textNode('span', card.host || 'Zdroj')); });
      preview.append(img);
    } else preview.append(textNode('span', card.host || 'Zdroj'));
    const meta = textNode('div', `${card.host || 'Zdroj'} · ${card.kind || 'odkaz'}${card.quality ? ` · ${card.quality}` : ''}`, 'nti-meta');
    const source = document.createElement('div'); source.className = 'nti-source';
    for (const occurrence of card.occurrences) {
      source.append(linkNode(`${occurrence.threadTitle} · #${occurrence.postId}`, occurrence.postUrl));
    }
    const actions = document.createElement('div'); actions.className = 'nti-actions';
    actions.append(linkNode('Otvoriť zdroj', card.url));
    if (card.kind === 'video' || card.sourceMeta?.kind === 'video') {
      const play = textNode('button', '▶ Play'); play.type = 'button'; play.dataset.action = 'play';
      play.addEventListener('click', () => openPlayer(card));
      actions.prepend(play);
    }
    item.append(head, preview, meta, sourceMetadata(card), source, actions);
    return item;
  }

  function render() {
    if (!panel) return;
    panel.querySelector('[data-part="status"]').textContent = status;
    panel.querySelector('[data-part="progress"]').textContent = `${stats.listPages} strán zoznamu · ${stats.threads} threadov · ${stats.threadPages} strán threadov · ${stats.links} nových odkazov · ${stats.errors} chýb`;
    panel.querySelector('[data-action="scan"]').disabled = running || !ready;
    panel.querySelector('[data-action="scan"]').textContent = saved.job ? 'Pokračovať v skene' : 'Skontrolovať nové';
    panel.querySelector('[data-action="stop"]').disabled = !running;
    panel.querySelector('[data-action="send"]').disabled = running || sending || selected.size === 0;
    panel.querySelector('[data-action="send"]').textContent = `Poslať vybrané do Testera (${selected.size})`;
    panel.querySelector('[data-action="fetch-meta"]').disabled = fetchingMeta || selected.size === 0;
    panel.querySelector('[data-action="fetch-meta"]').textContent = fetchingMeta ? `Načítavam údaje ${metaProgress}…` : `Načítať údaje vybraných (${selected.size})`;
    const hostSelect = panel.querySelector('[data-filter="host"]');
    const priorHost = hostSelect.value;
    hostSelect.replaceChildren(new Option('Všetky zdroje', ''));
    [...new Set([...cardMap.values()].map(card => card.host))].sort().forEach(host => hostSelect.add(new Option(host, host)));
    hostSelect.value = priorHost;
    const area = panel.querySelector('[data-part="cards"]');
    const scrollTop = area.scrollTop;
    area.replaceChildren();
    const filtered = visibleCards();
    const threadQuery = panel.querySelector('[data-filter="thread"]').value.trim().toLowerCase();
    const groups = new Map();
    for (const card of filtered.slice(0, visibleLimit)) {
      const title = (threadQuery && card.occurrences.find(o => o.threadTitle.toLowerCase().includes(threadQuery))?.threadTitle)
        || card.occurrences[0]?.threadTitle || 'Neznámy thread';
      if (!groups.has(title)) groups.set(title, []);
      groups.get(title).push(card);
    }
    for (const [title, cards] of groups) {
      const group = document.createElement('section'); group.className = 'nti-group';
      group.append(textNode('h3', `${title} · ${cards.length}`));
      const grid = document.createElement('div'); grid.className = 'nti-grid';
      cards.forEach(card => grid.append(renderCard(card)));
      group.append(grid); area.append(group);
    }
    if (!groups.size) area.append(textNode('p', cardMap.size ? 'Žiadne výsledky pre zvolený filter.' : 'Zatiaľ žiadne nájdené odkazy.', 'nti-empty'));
    if (filtered.length > visibleLimit) {
      const more = textNode('button', `Zobraziť ďalšie (${Math.min(120, filtered.length - visibleLimit)} z ${filtered.length - visibleLimit})`);
      more.type = 'button';
      more.addEventListener('click', () => { visibleLimit += 120; render(); });
      area.append(more);
    }
    area.scrollTop = scrollTop;
    const errorBox = panel.querySelector('[data-part="errors"]');
    errorBox.textContent = failures.slice(-12).join('\n');
    errorBox.hidden = failures.length === 0;
  }

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      if (trigger) trigger.textContent = running
        ? `Novinky · ${stats.changed}/${stats.threads || '…'} threadov`
        : 'Novinky v sledovaných';
      if (panel && !panel.hidden) render();
    }, 150);
  }

  async function sendSelected() {
    if (running || sending) return;
    const cards = [...selected].map(key => cardMap.get(key)).filter(Boolean);
    if (!cards.length) return;
    if (cards.length > MAX_SEND) { status = `Vyber najviac ${MAX_SEND} odkazov na jednu Tester reláciu.`; render(); return; }
    const port = Number(panel.querySelector('[data-part="port"]').value);
    const threadMap = new Map();
    const links = cards.map(card => {
      const first = card.occurrences[0] || {};
      for (const occ of card.occurrences || []) {
        const key = occ.threadId || occ.threadUrl || occ.threadTitle;
        if (!key) continue;
        if (!threadMap.has(key)) {
          threadMap.set(key, {
            id: occ.threadId || '',
            title: occ.threadTitle || '',
            url: occ.threadUrl || '',
            linkCount: 0,
          });
        }
        threadMap.get(key).linkCount += 1;
      }
      return { url: card.url, host: card.host, text: card.text, context: card.context,
        quality: card.quality, postAuthor: card.postAuthor, postId: first.postId || '',
        timestamp: card.timestamp, threadId: first.threadId || '',
        threadTitle: first.threadTitle || '', threadUrl: first.threadUrl || '',
        postUrl: first.postUrl || '', thumbnail: card.thumbnail, occurrences: card.occurrences };
    });
    const threads = [...threadMap.values()];
    sending = true;
    status = `Posielam ${links.length} odkazov do Nexusu ${port}…`; render();
    try {
      const response = await chrome.runtime.sendMessage({ action: 'nexusThreadIntake.pushWatched', port, links, threads });
      if (!response?.ok) throw new Error(response?.error || 'Odoslanie zlyhalo.');
      status = `${response.count || links.length} odkazov otvorených v Testeri. Import sa nespustil.`;
    } catch (error) { status = `Tester: ${error.message}`; }
    sending = false;
    render();
  }

  async function fetchSelectedMetadata() {
    if (fetchingMeta) return;
    const cards = [...selected].map(key => cardMap.get(key)).filter(Boolean);
    if (!cards.length) return;
    const port = Number(panel.querySelector('[data-part="port"]').value);
    fetchingMeta = true;
    let next = 0, done = 0, failed = 0;
    metaProgress = `0/${cards.length}`;
    render();
    const worker = async () => {
      while (next < cards.length) {
        const card = cards[next++];
        try {
          const response = await chrome.runtime.sendMessage({ action: 'nexusThreadIntake.sourceMeta', port, url: card.url });
          if (!response?.ok) throw new Error(response?.error || 'Načítanie zlyhalo.');
          card.sourceMeta = response.meta;
          card.metaError = '';
          if (/^https?:\/\//i.test(response.meta?.thumbnail || '')) {
            card.thumbnail = safeHttp(response.meta.thumbnail);
          }
        } catch (error) {
          card.metaError = error.message || String(error);
          failed += 1;
        }
        done += 1;
        metaProgress = `${done}/${cards.length}`;
        try { await persist(); } catch (error) { status = `Údaje sa nepodarilo uložiť: ${error.message}`; }
        scheduleRender();
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, cards.length) }, worker));
    fetchingMeta = false;
    status = `Údaje zo zdrojov: ${done - failed}/${done} načítaných${failed ? ` · ${failed} chýb` : ''}.`;
    render();
  }

  function mount() {
    trigger = textNode('button', 'Novinky v sledovaných', 'nti-trigger');
    trigger.type = 'button';
    const heading = document.querySelector('.p-title h1, h1.p-title-value, .p-title-value');
    (heading?.parentElement || document.body).append(trigger);
    panel = document.createElement('div'); panel.id = 'nti-watched'; panel.hidden = true;
    panel.innerHTML = `<div class="nti-shell" role="dialog" aria-label="Novinky v sledovaných threadoch">
      <header><h2>Novinky v sledovaných threadoch</h2><button type="button" data-action="close" aria-label="Zatvoriť">×</button></header>
      <div class="nti-toolbar"><button type="button" data-action="scan">Skontrolovať nové</button><button type="button" data-action="stop" disabled>Stop</button>
        <input data-filter="thread" type="search" placeholder="Thread alebo názov…" aria-label="Filtrovať thread">
        <select data-filter="host" aria-label="Zdroj"><option value="">Všetky zdroje</option></select>
        <select data-filter="kind" aria-label="Typ"><option value="">Všetky typy</option><option value="video">Video</option><option value="album">Album</option><option value="file">Súbor</option></select></div>
      <div class="nti-state"><strong data-part="status"></strong><small data-part="progress"></small><pre data-part="errors" hidden></pre></div>
      <main data-part="cards"></main>
      <footer><button type="button" data-action="select-visible">Vybrať zobrazené</button><button type="button" data-action="clear">Zrušiť výber</button>
        <label>Nexus <select data-part="port"><option>8000</option><option>8001</option><option>8002</option></select></label>
        <button type="button" data-action="fetch-meta">Načítať údaje vybraných (0)</button>
        <button type="button" data-action="send">Poslať vybrané do Testera (0)</button></footer></div>`;
    const modal = document.createElement('div'); modal.className = 'nti-player-modal'; modal.dataset.part = 'player'; modal.hidden = true;
    modal.innerHTML = `<div class="nti-player-box" role="dialog" aria-modal="true" aria-label="Prehrávač videa">
      <header><strong data-part="player-title"></strong><button type="button" data-action="close-player" aria-label="Zatvoriť prehrávač">×</button></header>
      <iframe title="Prehrávač videa" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>
      <footer><a data-part="player-source" target="_blank" rel="noopener noreferrer">Otvoriť pôvodný zdroj</a></footer></div>`;
    panel.append(modal);
    document.body.append(panel);
    trigger.addEventListener('click', () => { panel.hidden = !panel.hidden; if (panel.hidden) closePlayer(); else render(); });
    panel.querySelector('[data-action="close"]').addEventListener('click', () => { closePlayer(); panel.hidden = true; });
    panel.querySelector('[data-action="scan"]').addEventListener('click', scanAll);
    panel.querySelector('[data-action="stop"]').addEventListener('click', () => controller?.abort());
    panel.querySelector('[data-action="send"]').addEventListener('click', sendSelected);
    panel.querySelector('[data-action="fetch-meta"]').addEventListener('click', fetchSelectedMetadata);
    panel.querySelector('[data-action="close-player"]').addEventListener('click', closePlayer);
    modal.addEventListener('click', event => { if (event.target === modal) closePlayer(); });
    window.addEventListener('keydown', event => { if (event.key === 'Escape' && !modal.hidden) closePlayer(); });
    panel.querySelector('[data-action="select-visible"]').addEventListener('click', () => { visibleCards().forEach(card => selected.add(card.key)); persist(); render(); });
    panel.querySelector('[data-action="clear"]').addEventListener('click', () => { selected.clear(); persist(); render(); });
    panel.querySelectorAll('[data-filter]').forEach(input => input.addEventListener('input', () => { visibleLimit = 120; render(); }));
    window.addEventListener('pagehide', () => controller?.abort(), { once: true });
  }

  async function boot() {
    if (typeof scrape !== 'function') return;
    mount();
    try {
      const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
      if (stored && typeof stored === 'object') {
        saved.cursors = stored.cursors && typeof stored.cursors === 'object' ? stored.cursors : {};
        const job = stored.job;
        if (job?.phase === 'threads' && Array.isArray(job.threads) && Array.isArray(job.doneIds) && job.partials && typeof job.partials === 'object') {
          saved.job = job;
        } else if (job?.phase === 'list' && Array.isArray(job.listUrls) && Array.isArray(job.listRows) && Number.isInteger(job.listNext)) {
          saved.job = job;
        }
        for (const card of Array.isArray(stored.cards) ? stored.cards : []) {
          if (card?.key && card.url && Array.isArray(card.occurrences)) cardMap.set(card.key, card);
        }
        for (const key of Array.isArray(stored.selected) ? stored.selected : []) if (cardMap.has(key)) selected.add(key);
      }
    } catch (error) { status = `Uložené výsledky sa nepodarilo načítať: ${error.message}`; }
    if (saved.job) status = 'Rozpracovaný sken je uložený. Klikni Pokračovať v skene.';
    ready = true;
    scheduleRender();
  }

  globalThis.__nexusWatchedCore = { threadIdentity, watchedRows, watchedPageNumber, watchedPageUrl, threadPageCount, cardsFromPages, canonicalLink };
  if (document.body && globalThis.chrome?.storage?.local) boot();
})();
