// Shared by the service worker and the profile content script.
globalThis.HotContainerPremium = (() => {
  const videoId = (value) => String(value || "").match(/\/video\.([a-z0-9]+)/i)?.[1] || "";
  const thumbKey = (value) => String(value || "").match(/\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\//i)?.[1] || "";
  const imageKey = (value) => {
    const asset = thumbKey(value);
    if (asset) return `asset:${asset.toLowerCase()}`;
    try {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol)) return '';
      // Retain the asset path: /6/xv_19_t.jpg is shared by many different videos.
      return url.pathname.replace(/\.(?:avif|jpg|jpeg|webp)$/i, '').toLowerCase();
    } catch { return ''; }
  };
  const titleKey = (value) => String(value || "").normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/&amp;/g, ' and ').replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const slugKey = (value) => titleKey(String(value || '').split('/').pop()?.split('?')[0] || value);
  // Partial titles and common words can belong to different access types.
  // Read the complete title attribute and compare normalized equality.
  const titleMatch = (left, right) => {
    const a = titleKey(left); const b = titleKey(right);
    if (!a || !b) return false;
    return a === b;
  };
  // data-is-premium is XVideos' subscription flag (pms / is_sub), i.e. the
  // PREMIUM filter. The same video is often also sold as membership (pmf)
  // and direct/ppv (pmp), so those attributes do not mean "not premium".
  // Membership-only and direct-only cards simply lack data-is-premium.
  const isPremium = (card) => card.getAttribute('data-is-premium') === '1';
  const hashPremiumOnly = () => {
    const hash = String(location.hash || '').replace(/^#/, '');
    if (!/^_tabRed,/i.test(hash)) return false;
    const filters = (hash.split(',')[1] || '').split('+').map((part) => part.trim().toLowerCase()).filter(Boolean);
    return filters.length === 1 && filters[0] === 'premium';
  };
  const onlyPremiumFilterSelected = () => {
    const box = (key) => document.querySelector(`#tabRed .content-filter-k-${key} button input, #tabRed .content-filter-k-${key} input`);
    const premium = box('premium');
    if (!premium) return hashPremiumOnly();
    const on = (input) => Boolean(input && (input.checked || input.getAttribute('aria-pressed') === 'true'));
    return on(premium) && !on(box('membership')) && !on(box('ppv'));
  };
  const cardTitle = (card) => {
    const link = card.querySelector('a[href*="/video."]');
    const titled = card.querySelector('.title a[title]') || card.querySelector('a[title]') || card.querySelector('.title');
    return link?.getAttribute('title') || titled?.getAttribute('title') || titled?.textContent || link?.textContent || '';
  };
  const cleanText = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  const relativeDate = value => cleanText(value).match(/\b\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago\b|\b(?:today|yesterday)\b|pred\s+\d+\s+(?:dňami|dnami|týždňami|tyzdnami|mesiacmi|rokmi)/i)?.[0] || '';
  const dateLabel = value => {
    const text = cleanText(value);
    if (/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(text)) {
      const [year, month, day] = text.slice(0, 10).split('-');
      return `${Number(day)}. ${Number(month)}. ${year}`;
    }
    return relativeDate(text) || (/^\d{1,2}[./]\s*\d{1,2}[./]\s*\d{4}$/.test(text) ? text : '');
  };
  const durationLabel = value => {
    const text = cleanText(value);
    return /^(?:\d+:)?\d{1,2}:\d{2}$/.test(text) || /^\d+\s*(?:h|hr|hours?|min|mins|minutes?|sec|seconds?)\b/i.test(text) ? text : '';
  };
  function cardRecord(card) {
    const image = card.querySelector('img');
    const src = image?.currentSrc || image?.src || '';
    const date = card.querySelector('time, .metadata [datetime], .metadata [data-date], .metadata .date, .metadata .added-date');
    return {
      id: card.dataset.eid || '', title: titleKey(cardTitle(card)),
      slug: slugKey(card.querySelector('a[href*="/video."]')?.href || ''),
      image: imageKey(src), thumb: thumbKey(src),
      duration: durationLabel(card.querySelector('.duration')?.textContent),
      addedDate: dateLabel(date?.getAttribute('datetime') || date?.getAttribute('data-date') || date?.getAttribute('title') || '')
        || dateLabel(date?.textContent) || relativeDate(card.querySelector('.metadata')?.textContent),
    };
  }
  function recordMetadata(item, records) {
    const id = item.videoId || videoId(item.sourceVideoUrl);
    const image = imageKey(item.thumbnail);
    let matches = id ? records.filter(record => record.id === id) : [];
    if (!matches.length && image) matches = records.filter(record => record.image === image);
    const identified = matches.length > 0;
    if (!matches.length) matches = records.filter(record => titleMatch(item.title, record.title));
    if (!matches.length && item.sourceVideoUrl) matches = records.filter(record => titleMatch(slugKey(item.sourceVideoUrl), record.slug));
    // Avoid assigning one upload's date/duration to another duplicate title.
    const unique = field => {
      const values = [...new Set(matches.map(record => record[field]).filter(Boolean))];
      if (identified && values.length) {
        if (field === 'addedDate') return values.find(value => /^\d{1,2}\. \d{1,2}\. \d{4}$/.test(value)) || values[0];
        return values[0];
      }
      return values.length === 1 ? values[0] : item[field] || '';
    };
    return { addedDate: unique('addedDate'), duration: unique('duration') };
  }

  function filter(items, catalog) {
    const ids = new Set(catalog.ids || []);
    const thumbs = new Set(catalog.thumbnails || []);
    const images = new Set(catalog.images || []);
    const titles = [...(catalog.titles || [])];
    const slugs = [...(catalog.slugs || [])];
    return items.filter(item => {
      // The gallery title is the same string as on the PREMIUM tab.
      if (titles.some(title => titleMatch(item.title, title))) return true;
      const sourceSlug = slugKey(item.sourceVideoUrl);
      if (sourceSlug && slugs.some(slug => titleMatch(sourceSlug, slug))) return true;
      const id = item.videoId || videoId(item.sourceVideoUrl);
      if (id && ids.has(id)) return true;
      const image = imageKey(item.thumbnail);
      if (image && images.has(image)) return true;
      return Boolean(thumbKey(item.thumbnail) && thumbs.has(thumbKey(item.thumbnail)));
    }).map(item => ({ ...item, ...recordMetadata(item, catalog.records || []), accessType: 'premium' }));
  }

  function readProfileListing() {
    const blob = [...document.scripts].map((node) => node.textContent || '').join('\n');
    const rawUrl = blob.match(/"url":"(\\\/(?:channels|profiles|models|pornstars)\\\/[^"\\]+)"/);
    const userUrl = rawUrl?.[1]?.replace(/\\\//g, "/");
    if (!userUrl) return null;
    const mainCat = blob.match(/"main_cat":"([a-z]+)"/)?.[1] || '';
    const multipleCats = /"main_cats":\[[^\]]+,/.test(blob);
    return { userUrl, mainCat: multipleCats ? mainCat : '' };
  }
  function listingVideos(payload) {
    const videos = [];
    for (const post of payload?.posts || payload?.videos || []) {
      if (post?.eid) videos.push(post);
      for (const video of post?.videos || []) videos.push(video);
    }
    return videos;
  }
  function addListingVideos(bucket, payload) {
    for (const video of listingVideos(payload)) {
      const id = String(video.eid || '');
      if (!id) continue;
      bucket.ids.add(id);
      const title = titleKey(video.tf || video.t || '');
      if (title) bucket.titles.add(title);
      const slug = slugKey(video.u || '');
      if (slug) bucket.slugs.add(slug);
      const src = video.i || video.il || video.ip || '';
      const image = imageKey(src);
      if (image) bucket.images.add(image);
      const thumb = thumbKey(src);
      if (thumb) bucket.thumbnails.add(thumb);
      bucket.records.push({ id, title, slug, image, thumb,
        duration: durationLabel(video.duration || video.d),
        addedDate: dateLabel(video.added_at || video.upload_date || video.date || video.a),
      });
    }
  }
  function catalogFrom(bucket) {
    return {
      ids: [...bucket.ids], thumbnails: [...bucket.thumbnails], images: [...bucket.images],
      titles: [...bucket.titles], slugs: [...bucket.slugs], records: bucket.records,
    };
  }
  // The PREMIUM tab is a server-side content filter, not an exclusive card
  // attribute. Ask for that filter directly and keep the result only when it
  // is actually a different list from MEMBERSHIP.
  // listing: { origin, userUrl, mainCat } — origin is https://www.xvideos.com,
  // userUrl is the path read from the page ("/channels/…", "/profiles/…").
  async function collectFromListing(listing) {
    if (!listing?.origin || !listing?.userUrl || typeof fetch !== 'function') return null;
    const cat = listing.mainCat ? `${listing.mainCat}/` : '';
    const root = `${listing.origin}${listing.userUrl}/fan-club/best/${cat}`;
    const load = async (filter, page) => {
      const response = await fetch(`${root}${filter}/${page}`, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(String(response.status));
      const payload = await response.json();
      if (!payload || payload.result === false) throw new Error('listing');
      return payload;
    };
    const sameIds = (left, right) => left.length === right.length && left.every((id, index) => id === right[index]);
    const idsOf = (payload) => listingVideos(payload).map((video) => String(video.eid || '')).filter(Boolean);
    let first;
    try { first = await load('premium', 0); } catch { return null; }
    if (!idsOf(first).length) return null;
    let membership = null;
    try { membership = await load('membership', 0); } catch { membership = null; }
    if (membership && sameIds(idsOf(first), idsOf(membership))) return null;
    const bucket = { ids: new Set(), thumbnails: new Set(), images: new Set(), titles: new Set(), slugs: new Set(), records: [] };
    addListingVideos(bucket, first);
    const perPage = Number(first.nb_per_page) || Math.max(idsOf(first).length, 1);
    const pages = Math.min(80, Math.ceil((Number(first.nb_posts) || perPage) / perPage));
    const rest = [];
    for (let page = 1; page < pages; page++) rest.push(page);
    const workerCount = Math.min(8, rest.length);
    let cursor = 0;
    const payloads = new Array(rest.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (cursor < rest.length) {
        const index = cursor++;
        payloads[index] = await load('premium', rest[index]);
      }
    }));
    for (const payload of payloads) addListingVideos(bucket, payload);
    return catalogFrom(bucket);
  }

  async function collectFromApi() {
    const listing = readProfileListing();
    if (!listing || typeof fetch !== 'function') return null;
    return collectFromListing({ origin: location.origin, userUrl: listing.userUrl, mainCat: listing.mainCat });
  }

  async function collect() {
    let apiCatalog = null;
    try {
      apiCatalog = await collectFromApi();
      if (apiCatalog?.records?.length && apiCatalog.records.every(record => record.duration && record.addedDate)) return apiCatalog;
    } catch { /* profile has no fan-club listing; the grid below still classifies cards */ }
    try {
      const domCatalog = await collectDom();
      if (!apiCatalog) return domCatalog;
      const merged = {};
      for (const key of ['ids', 'thumbnails', 'images', 'titles', 'slugs']) merged[key] = [...new Set([...apiCatalog[key], ...domCatalog[key]])];
      merged.records = [...domCatalog.records, ...apiCatalog.records];
      return merged;
    } catch (error) {
      if (apiCatalog) return apiCatalog;
      throw error;
    }
  }
  async function collectDom() {
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const cards = () => [...(document.querySelector('#tabRed') || document).querySelectorAll('.thumb-block[data-eid]')]
      .filter(card => card.getClientRects().length > 0);
    const signature = () => cards().map(card => card.dataset.eid).join(',');
    const metadataSignature = () => cards().map(card => [card.dataset.eid, card.dataset.isPremium, card.dataset.isMembership, cardTitle(card)].join(':')).join('|');
    const waitForCards = async (previous = null) => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (cards().length && (previous === null || signature() !== previous)) {
          // Profile pagination is asynchronous. Require a stable settled grid.
          const current = metadataSignature();
          await pause(600);
          if (metadataSignature() === current) return;
        }
        await pause(100);
      }
      throw new Error('Typy videí sa nepodarilo načítať z profilu.');
    };
    await waitForCards();
    const ids = new Set();
    const thumbnails = new Set();
    const images = new Set();
    const titles = new Set();
    const slugs = new Set();
    const records = [];
    const visited = new Set();
    for (let page = 0; page < 100; page++) {
      const current = signature();
      if (visited.has(current)) throw new Error('Kontrola typov videí sa zasekla pri stránkovaní.');
      visited.add(current);
      const premiumGrid = onlyPremiumFilterSelected();
      for (const card of cards()) {
        if (!premiumGrid && !isPremium(card)) continue;
        records.push(cardRecord(card));
        ids.add(card.dataset.eid);
        const title = cardTitle(card);
        if (titleKey(title)) titles.add(titleKey(title));
        const href = card.querySelector('a[href*="/video."]')?.href || '';
        if (slugKey(href)) slugs.add(slugKey(href));
        const key = thumbKey(card.querySelector('img')?.src);
        if (key) thumbnails.add(key);
        const image = imageKey(card.querySelector('img')?.src);
        if (image) images.add(image);
      }
      const next = [...document.querySelectorAll('.pagination a, .pagination button, a[rel="next"], button[aria-label="Next"]')]
        .find(el => el.getClientRects().length > 0 && !el.disabled
          && el.getAttribute('aria-disabled') !== 'true'
          && !el.closest('.disabled')
          && (el.getAttribute('rel') === 'next' || /^(?:next|next page|ďalšia|dalsia|suivant|próximo|proximo|›|»)$/i.test((el.textContent || el.getAttribute('aria-label') || '').trim())));
        if (!next) return { ids: [...ids], thumbnails: [...thumbnails], images: [...images], titles: [...titles], slugs: [...slugs], records };
      next.click();
      await waitForCards(current);
    }
    throw new Error('Profil prekročil limit kontroly typov videí.');
  }
  function collectCurrent() {
    const ids = new Set(); const thumbnails = new Set(); const images = new Set(); const titles = new Set(); const slugs = new Set();
    const records = [];
    const premiumGrid = onlyPremiumFilterSelected();
    for (const card of [...(document.querySelector('#tabRed') || document).querySelectorAll('.thumb-block[data-eid]')]) {
      if (!card.getClientRects().length) continue;
      if (!premiumGrid && !isPremium(card)) continue;
      records.push(cardRecord(card));
      ids.add(card.dataset.eid);
      const imageEl = card.querySelector('img');
      const src = imageEl?.currentSrc || imageEl?.src || '';
      const thumb = thumbKey(src); if (thumb) thumbnails.add(thumb);
      const image = imageKey(src); if (image) images.add(image);
      const title = cardTitle(card);
      if (titleKey(title)) titles.add(titleKey(title));
      const href = card.querySelector('a[href*="/video."]')?.href || '';
      if (slugKey(href)) slugs.add(slugKey(href));
    }
    return { ids: [...ids], thumbnails: [...thumbnails], images: [...images], titles: [...titles], slugs: [...slugs], records };
  }
  return { videoId, thumbKey, imageKey, titleKey, slugKey, isPremium, filter, collect, collectCurrent, collectFromListing };
})();
