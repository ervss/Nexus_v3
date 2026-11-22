// ==UserScript==
// @name         Findr Nexus Manager
// @namespace    nexus.findr.manager
// @version      2.0.0
// @description  Kompletný Findr manažér: selektory na albumy aj súbory (Home, Search, Files, Albums), spájanie do trvalých virtuálnych albumov v prehliadači, Quick Peek, dvojúrovňový fetch, Lightbox, Nexus Import Desk a priame odoslanie do Nexus Universal Split-Screen.
// @author       Nexus Architecture Team
// @match        https://findr.to/*
// @match        https://*.findr.to/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_setClipboard
// @connect      *
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  'use strict';

  const STORE_KEY = 'fnm_store_v2';
  const NEXUS_PORTS = [8000, 8001, 8002, 8003];
  const VIDEO_EXT_RE = /\.(mp4|m4v|mkv|webm|mov|avi|wmv|flv|ts|m3u8)(?:$|[?#])/i;
  const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|bmp|jfif|heic)(?:$|[?#])/i;

  // ---------------------------------------------------------------------------
  // 1. PURE HELPERS (zdieľané aj pre Node testy)
  // ---------------------------------------------------------------------------
  function canonicalUrl(raw) {
    if (!raw || typeof raw !== 'string') return '';
    try {
      const u = new URL(raw.trim(), 'https://findr.to');
      if (!/^https?:$/i.test(u.protocol)) return '';
      u.hash = '';
      return u.href.replace(/\/$/, '');
    } catch {
      return '';
    }
  }

  function extractAlbumId(raw) {
    if (!raw) return '';
    const m = String(raw).match(/\/albums?\/([A-Za-z0-9_-]+)/i);
    return m ? m[1] : '';
  }

  function classifyMediaType(title = '', url = '', extHint = '') {
    const ext = String(extHint || '').trim().toLowerCase().replace(/^\./, '');
    if (ext) {
      if (['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'ts', 'm3u8'].includes(ext)) return 'video';
      if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'jfif', 'heic'].includes(ext)) return 'image';
    }
    const cleanTitle = String(title || '').trim();
    const cleanUrl = String(url || '').trim();
    if (VIDEO_EXT_RE.test(cleanTitle) || VIDEO_EXT_RE.test(cleanUrl) || /\/v\/[A-Za-z0-9_-]+/i.test(cleanUrl) || /(?:^|\.)turbo\.cr\/v\//i.test(cleanUrl)) return 'video';
    if (IMAGE_EXT_RE.test(cleanTitle) || IMAGE_EXT_RE.test(cleanUrl)) return 'image';
    return 'other';
  }

  function detectProvider(url = '', label = '') {
    const text = `${label} ${url}`.toLowerCase();
    if (/turbo\.cr|turbocdn|\bturbo\b/.test(text)) return 'turbo';
    if (/bunkr|scdn\.st|cdn\.cr/.test(text)) return 'bunkr';
    if (/pixeldrain/.test(text)) return 'pixeldrain';
    if (/gofile/.test(text)) return 'gofile';
    if (/coomer|kemono/.test(text)) return 'coomer';
    if (/saint/.test(text)) return 'saint';
    return 'other';
  }

  function providerLabel(provider) {
    return ({
      bunkr: 'Bunkr',
      turbo: 'Turbo',
      pixeldrain: 'Pixeldrain',
      gofile: 'Gofile',
      coomer: 'Coomer',
      saint: 'Saint',
      other: 'Iný',
    })[provider] || 'Iný';
  }

  function parseSizeToBytes(text) {
    if (typeof text === 'number') return Number.isFinite(text) && text > 0 ? text : 0;
    const m = String(text || '').replace(/\s+/g, '').match(/([\d.,]+)([KMGT]?i?B)/i);
    if (!m) return 0;
    const value = Number(m[1].replace(',', '.'));
    const unit = m[2].toUpperCase().replace('I', '');
    const idx = ['B', 'KB', 'MB', 'GB', 'TB'].indexOf(unit);
    if (!Number.isFinite(value) || idx < 0) return 0;
    const base = m[2].toLowerCase().includes('i') ? 1024 : 1000;
    return Math.round(value * (base ** idx));
  }

  function formatBytes(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n) || n <= 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / (1024 ** i)).toFixed(i > 1 ? 2 : i === 1 ? 1 : 0)} ${units[i]}`;
  }

  function formatDuration(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds || 0)));
    if (!s) return '';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`;
  }

  function formatUploadDate(value) {
    if (!value) return 'Dátum nahratia: neznámy';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return 'Dátum nahratia: neznámy';
    return `Nahrané: ${date.getUTCDate()}. ${date.getUTCMonth() + 1}. ${date.getUTCFullYear()}`;
  }

  function qualityHeight(item) {
    const h = Number(item?.height || 0);
    if (h > 0) return h;
    const q = String(item?.quality || '').toLowerCase();
    if (/4k|2160/.test(q)) return 2160;
    if (/1440/.test(q)) return 1440;
    if (/fhd|1080/.test(q)) return 1080;
    if (/(^|[^a-z])hd([^a-z]|$)|720/.test(q)) return 720;
    if (/sd|480/.test(q)) return 480;
    if (/360/.test(q)) return 360;
    return 0;
  }

  function qualityLabel(item) {
    const raw = String(item?.quality || '').trim();
    if (raw) return raw.toUpperCase() === 'FHD' ? '1080p' : raw;
    const h = Number(item?.height || 0);
    if (h >= 2160) return '4K';
    if (h >= 1440) return '1440p';
    if (h >= 1080) return '1080p';
    if (h >= 720) return '720p';
    if (h > 0) return `${h}p`;
    return '';
  }

  function qualityTier(item) {
    const h = qualityHeight(item);
    if (h >= 2160) return 'q4k';
    if (h >= 1440) return 'q1440';
    if (h >= 1080) return 'qfhd';
    if (h >= 720) return 'qhd';
    if (h > 0) return 'qsd';
    return 'qna';
  }

  function normalizeFindrAlbumEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const albumId = String(entry.id || entry.album_id || extractAlbumId(entry.detail_url || entry.url) || '').trim();
    const sourceUrl = canonicalUrl(entry.original_url || entry.source_link || entry.url || '');
    const findrUrl = albumId ? `https://findr.to/albums/${albumId}` : canonicalUrl(entry.detail_url || '');
    if (!albumId && !sourceUrl) return null;
    const thumbs = Array.isArray(entry.thumbnails) ? entry.thumbnails.filter(Boolean) : [];
    const thumbnail = String(thumbs[0] || entry.thumbnail_path || entry.thumbnail || '');
    const provider = detectProvider(sourceUrl || findrUrl, entry.provider || entry.source || '');
    return {
      albumId: albumId || sourceUrl,
      findrUrl: findrUrl || sourceUrl,
      sourceUrl: sourceUrl || findrUrl,
      title: String(entry.name || entry.title || `Album ${albumId || ''}`).trim(),
      fileCount: Number(entry.file_count || entry.files_count || 0) || 0,
      sizeBytes: Number(entry.folder_size_bytes || entry.total_size_bytes || entry.size_bytes || 0) || parseSizeToBytes(entry.folder_size || entry.size || ''),
      provider,
      thumbnails: thumbs.length ? thumbs : (thumbnail ? [thumbnail] : []),
      createdAt: String(entry.created_at || ''),
      updatedAt: String(entry.updated_at || entry.created_at || ''),
      tags: Array.isArray(entry.tags) ? entry.tags.filter(Boolean) : [],
    };
  }

  function normalizeFindrFileEntry(entry, albumMeta = null) {
    if (!entry || typeof entry !== 'object') return null;
    const rawUrl = entry.source_link || entry.source_url || entry.url || '';
    const url = canonicalUrl(rawUrl);
    if (!url) return null;
    const filename = String(entry.filename || entry.name || entry.title || url.split('/').pop() || 'Findr súbor').trim();
    const ext = String(entry.extension || entry.file_extension || '').trim();
    const mediaType = entry.mediaType || classifyMediaType(filename, url, ext);
    const provider = entry.provider && entry.provider !== 'other'
      ? String(entry.provider).toLowerCase()
      : detectProvider(url, albumMeta?.provider || '');
    const sizeBytes = Number(entry.file_size_bytes || entry.size_bytes || entry.sizeBytes || 0)
      || parseSizeToBytes(entry.file_size || entry.size_human || entry.sizeText || '');
    const albumId = String(albumMeta?.albumId || entry.album_id || entry.albumId || '').trim();
    const albumTitle = String(albumMeta?.title || entry.album_name || entry.albumTitle || (albumId ? `Album #${albumId}` : 'Samostatné súbory')).trim();
    const sourceKey = albumId ? `album:${albumId}` : 'single:files';
    return {
      key: url,
      url,
      watchUrl: url,
      detailUrl: albumId ? `https://findr.to/albums/${albumId}` : '',
      filename,
      title: String(entry.title || filename),
      mediaType,
      provider,
      sizeBytes,
      duration: Number(entry.duration || 0) || 0,
      width: Number(entry.width || 0) || 0,
      height: Number(entry.height || 0) || 0,
      quality: String(entry.quality || ''),
      streamUrl: String(entry.stream_url || entry.streamUrl || ''),
      thumbnail: String(entry.thumbnail_path || entry.thumbnail_url || entry.thumbnail || entry.poster || ''),
      storyboardUrl: String(entry.storyboard_url || entry.storyboardUrl || ''),
      albumId,
      albumTitle,
      sourceKey,
      createdAt: String(entry.created_at || entry.upload_date || entry.createdAt || ''),
      addedAt: Number(entry.addedAt || Date.now()),
      reviewed: Boolean(entry.reviewed),
      tags: Array.isArray(entry.tags) ? entry.tags.filter(Boolean) : [],
    };
  }

  function createVirtualAlbum(name = 'Môj zlúčený album') {
    const now = Date.now();
    return {
      id: `va_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name: String(name || 'Môj zlúčený album').trim(),
      createdAt: now,
      updatedAt: now,
      sources: [],
      items: [],
      selectedIds: [],
      reviewedIds: [],
    };
  }

  function mergeItemsIntoAlbum(album, rawItems, sourceMeta = null) {
    if (!album) return { added: 0, skipped: 0, album: null };
    const existingByKey = new Map((album.items || []).map((it) => [it.key, it]));
    const sourcesMap = new Map((album.sources || []).map((s) => [s.sourceKey, { ...s }]));
    let added = 0;
    let skipped = 0;
    const now = Date.now();

    for (const raw of rawItems || []) {
      const item = raw?.key ? { ...raw } : normalizeFindrFileEntry(raw, sourceMeta);
      if (!item || !item.key) continue;
      if (sourceMeta?.sourceKey && !item.albumId && sourceMeta.albumId) {
        item.albumId = sourceMeta.albumId;
        item.albumTitle = sourceMeta.title || item.albumTitle;
        item.sourceKey = sourceMeta.sourceKey;
      }
      const prev = existingByKey.get(item.key);
      if (prev) {
        // Doplň prípadne chýbajúce metadáta, zachovaj užívateľský stav
        if (item.thumbnail && (!prev.thumbnail || prev.thumbnail === prev.storyboardUrl)) prev.thumbnail = item.thumbnail;
        if (!prev.sizeBytes && item.sizeBytes) prev.sizeBytes = item.sizeBytes;
        if (!prev.duration && item.duration) prev.duration = item.duration;
        if (!prev.quality && item.quality) prev.quality = item.quality;
        if (!prev.height && item.height) prev.height = item.height;
        if (!prev.width && item.width) prev.width = item.width;
        if (!prev.streamUrl && item.streamUrl) prev.streamUrl = item.streamUrl;
        if (!prev.createdAt && item.createdAt) prev.createdAt = item.createdAt;
        skipped += 1;
      } else {
        item.addedAt = item.addedAt || now;
        existingByKey.set(item.key, item);
        added += 1;
      }
      const sKey = item.sourceKey || 'single:files';
      if (!sourcesMap.has(sKey)) {
        sourcesMap.set(sKey, {
          sourceKey: sKey,
          albumId: item.albumId || '',
          title: item.albumTitle || 'Samostatné súbory',
          findrUrl: item.albumId ? `https://findr.to/albums/${item.albumId}` : '',
          sourceUrl: sourceMeta?.sourceUrl || '',
          provider: item.provider || sourceMeta?.provider || 'other',
        });
      }
    }

    const nextItems = [...existingByKey.values()];
    const countsBySource = new Map();
    for (const it of nextItems) {
      const sk = it.sourceKey || 'single:files';
      countsBySource.set(sk, (countsBySource.get(sk) || 0) + 1);
    }
    const nextSources = [...sourcesMap.values()]
      .filter((s) => countsBySource.has(s.sourceKey))
      .map((s) => ({ ...s, itemCount: countsBySource.get(s.sourceKey) || 0 }));

    album.items = nextItems;
    album.sources = nextSources;
    album.updatedAt = now;
    return { added, skipped, album };
  }

  function removeSourceFromAlbum(album, sourceKey) {
    if (!album || !sourceKey) return album;
    const removedKeys = new Set(
      (album.items || []).filter((it) => it.sourceKey === sourceKey).map((it) => it.key)
    );
    album.items = (album.items || []).filter((it) => it.sourceKey !== sourceKey);
    album.sources = (album.sources || []).filter((s) => s.sourceKey !== sourceKey);
    album.selectedIds = (album.selectedIds || []).filter((k) => !removedKeys.has(k));
    album.reviewedIds = (album.reviewedIds || []).filter((k) => !removedKeys.has(k));
    album.updatedAt = Date.now();
    return album;
  }

  function duplicateName(item) {
    return String(item.filename || item.title || '').toLowerCase().normalize('NFKD')
      .replace(/\.[a-z0-9]{2,5}$/i, '').replace(/(?:^|[\s_.-])(?:2160p?|1440p?|1080p?|720p?|480p?|4k|uhd|fhd|hd)(?=$|[\s_.-])/g, ' ')
      .replace(/[-_][a-z0-9]{8}$/i, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function duplicateMatch(a, b, hashes = null) {
    if (a.mediaType !== 'video' || b.mediaType !== 'video' || a.key === b.key) return false;
    const da = Number(a.duration) || 0, db = Number(b.duration) || 0;
    const sameDuration = da > 0 && db > 0 && Math.abs(da - db) <= Math.max(3, Math.min(da, db) * 0.01);
    if (da && db && !sameDuration) return false;
    const name = duplicateName(a), other = duplicateName(b);
    const sameName = name.length >= 12 && name === other && !/^(video|clip|file|movie|untitled|source|download|\d+)$/.test(name);
    const imagesA = [a.thumbnail, a.storyboardUrl].filter((s) => /^https?:\/\//i.test(s || ''));
    const sameImage = imagesA.some((s) => s === b.thumbnail || s === b.storyboardUrl);
    const sameSize = Number(a.sizeBytes) > 0 && Number(a.sizeBytes) === Number(b.sizeBytes);
    const nearSize = Number(a.sizeBytes) > 0 && Number(b.sizeBytes) > 0 && Math.abs(a.sizeBytes - b.sizeBytes) / Math.max(a.sizeBytes, b.sizeBytes) <= 0.03;
    const ha = hashes?.get(a.key), hb = hashes?.get(b.key);
    const similarImage = ha && hb && ha.contrast >= 10 && hb.contrast >= 10 && ha.bits.reduce((n, bit, i) => n + (bit !== hb.bits[i] ? 1 : 0), 0) <= 5 && ha.color.every((c, i) => Math.abs(c - hb.color[i]) <= 20);
    return (sameName && (sameDuration || sameSize)) || ((sameImage || similarImage) && (sameDuration || nearSize));
  }

  function findDuplicateGroups(items, hashes = null) {
    const groups = [];
    for (const item of (items || []).filter((it) => it.mediaType === 'video')) {
      const group = groups.find((g) => g.every((other) => duplicateMatch(item, other, hashes)));
      if (group) group.push(item);
      else groups.push([item]);
    }
    return groups.filter((g) => g.length > 1).map((g) => g.sort((a, b) =>
      qualityHeight(b) - qualityHeight(a) || (Number(b.sizeBytes) || 0) - (Number(a.sizeBytes) || 0) || String(a.key).localeCompare(String(b.key))));
  }

  function removeDuplicateGroups(album, choices) {
    const removed = [], removedKeys = new Set(), selected = new Set(album.selectedIds), reviewed = new Set(album.reviewedIds);
    const snapshot = { sources: album.sources.map((s) => ({ ...s })), removed: [] };
    for (const { items, keeperKey } of choices) {
      const keep = items.find((item) => item.key === keeperKey);
      if (!keep) continue;
      for (const item of items) {
        if (item.key === keeperKey) continue;
        snapshot.removed.push({ item: { ...item }, index: album.items.indexOf(item), selected: selected.has(item.key), reviewed: reviewed.has(item.key) });
        removed.push(item); removedKeys.add(item.key);
        for (const field of ['thumbnail', 'storyboardUrl', 'duration', 'createdAt']) if (!keep[field] && item[field]) keep[field] = item[field];
        keep.tags = [...new Set([...(keep.tags || []), ...(item.tags || [])])];
        if (selected.has(item.key)) selected.add(keeperKey);
        if (reviewed.has(item.key)) reviewed.add(keeperKey);
      }
    }
    if (!removed.length) return 0;
    album.duplicateUndo = snapshot;
    album.items = album.items.filter((item) => !removedKeys.has(item.key));
    album.selectedIds = [...selected].filter((key) => !removedKeys.has(key));
    album.reviewedIds = [...reviewed].filter((key) => !removedKeys.has(key));
    album.sources = album.sources.filter((s) => album.items.some((item) => item.sourceKey === s.sourceKey)).map((s) => ({ ...s, itemCount: album.items.filter((item) => item.sourceKey === s.sourceKey).length }));
    album.updatedAt = Date.now();
    return removed.length;
  }

  function undoDuplicateRemoval(album) {
    const undo = album.duplicateUndo;
    if (!undo) return 0;
    let restored = 0;
    for (const row of [...undo.removed].sort((a, b) => a.index - b.index)) {
      if (album.items.some((item) => item.key === row.item.key)) continue;
      album.items.splice(Math.max(0, Math.min(row.index, album.items.length)), 0, row.item);
      if (row.selected && !album.selectedIds.includes(row.item.key)) album.selectedIds.push(row.item.key);
      if (row.reviewed && !album.reviewedIds.includes(row.item.key)) album.reviewedIds.push(row.item.key);
      restored++;
    }
    const sources = new Map([...undo.sources, ...album.sources].map((s) => [s.sourceKey, s]));
    album.sources = [...sources.values()].filter((s) => album.items.some((item) => item.sourceKey === s.sourceKey)).map((s) => ({ ...s, itemCount: album.items.filter((item) => item.sourceKey === s.sourceKey).length }));
    delete album.duplicateUndo;
    album.updatedAt = Date.now();
    return restored;
  }

  function filterAndSortItems(items, filters = {}, sort = 'newest', selectedSet = new Set(), reviewedSet = new Set()) {
    const terms = String(filters.query || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    const mediaType = filters.mediaType || 'all';
    const provider = filters.provider || 'all';
    const sourceKey = filters.sourceKey || 'all';
    const sourceKeys = Array.isArray(filters.sourceKeys) ? filters.sourceKeys : (sourceKey === 'all' ? [] : [sourceKey]);
    const status = filters.status || 'all';
    const minHeight = Number(filters.minHeight || 0) || 0;
    const minDurationSec = Number(filters.minDurationMin || 0) * 60;
    const minSizeBytes = Number(filters.minSizeMb || 0) * 1024 * 1024;

    const filtered = (items || []).filter((item) => {
      if (terms.length) {
        const hay = `${item.title || ''} ${item.filename || ''} ${item.albumTitle || ''} ${(item.tags || []).join(' ')}`.toLowerCase();
        if (!terms.every((t) => hay.includes(t))) return false;
      }
      if (mediaType !== 'all' && item.mediaType !== mediaType) return false;
      if (provider !== 'all' && item.provider !== provider) return false;
      if (sourceKeys.length && !sourceKeys.includes(item.sourceKey)) return false;
      if (status === 'selected' && !selectedSet.has(item.key)) return false;
      if (status === 'reviewed' && !reviewedSet.has(item.key)) return false;
      if (status === 'unreviewed' && reviewedSet.has(item.key)) return false;
      if (status === 'hasMeta' && !(Number(item.duration) > 0 || qualityHeight(item) > 0)) return false;
      if (minHeight > 0 && qualityHeight(item) < minHeight) return false;
      if (minDurationSec > 0 && Number(item.duration || 0) < minDurationSec) return false;
      if (minSizeBytes > 0 && Number(item.sizeBytes || 0) < minSizeBytes) return false;
      return true;
    });

    const dateMs = (it) => Date.parse(it.createdAt || '') || 0;
    return filtered.slice().sort((a, b) => {
      switch (sort) {
        case 'sizeDesc':
          return (Number(b.sizeBytes) || 0) - (Number(a.sizeBytes) || 0);
        case 'durationDesc':
          return (Number(b.duration) || 0) - (Number(a.duration) || 0);
        case 'qualityDesc':
          return qualityHeight(b) - qualityHeight(a) || (Number(b.sizeBytes) || 0) - (Number(a.sizeBytes) || 0);
        case 'nameAsc':
          return String(a.title || a.filename || '').localeCompare(String(b.title || b.filename || ''), undefined, { numeric: true });
        case 'album':
          return String(a.albumTitle || '').localeCompare(String(b.albumTitle || '')) || dateMs(b) - dateMs(a);
        case 'addedDesc':
          return (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0);
        case 'newest':
        default:
          return dateMs(b) - dateMs(a) || (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0);
      }
    });
  }

  function buildM3U8Playlist(items) {
    const lines = ['#EXTM3U'];
    for (const it of items || []) {
      const target = it.streamUrl || it.url;
      if (!target) continue;
      const dur = Math.max(-1, Math.floor(Number(it.duration || 0)) || -1);
      const label = String(it.title || it.filename || 'Findr').replace(/[\r\n]+/g, ' ');
      lines.push(`#EXTINF:${dur},${label}`);
      lines.push(target);
    }
    return lines.join('\n');
  }

  function extractHostSlug(rawUrl) {
    try {
      const u = new URL(rawUrl, 'https://findr.to');
      const m = u.pathname.match(/\/(?:f|v|d|embed)\/([A-Za-z0-9_-]{3,})/i);
      return m ? m[1] : '';
    } catch {
      return '';
    }
  }

  function findAlbumItemByUrl(album, rawUrl) {
    if (!album || !rawUrl) return null;
    const canon = canonicalUrl(rawUrl);
    let found = (album.items || []).find((it) => it.key === canon || canonicalUrl(it.url) === canon || it.url === rawUrl);
    if (found) return found;
    const slug = extractHostSlug(rawUrl);
    const prov = detectProvider(rawUrl);
    if (slug && prov !== 'other') {
      found = (album.items || []).find((it) => it.provider === prov && extractHostSlug(it.url) === slug);
    }
    return found || null;
  }

  function applyFetchedMetadata(target, d) {
    if (!target || !d || typeof d !== 'object') return false;
    let changed = false;
    if (Number(d.duration) > 0) { target.duration = Number(d.duration); changed = true; }
    if (Number(d.width) > 0) { target.width = Number(d.width); changed = true; }
    if (Number(d.height) > 0) { target.height = Number(d.height); changed = true; }
    if (d.quality) { target.quality = String(d.quality); changed = true; }
    else if (Number(d.height) > 0 && !target.quality) {
      target.quality = qualityLabel({ height: Number(d.height) });
      changed = true;
    }
    const sb = Number(d.size_bytes || d.sizeBytes || 0);
    const uploadDate = d.upload_date || d.created_at || d.createdAt;
    if (uploadDate && !target.createdAt) { target.createdAt = String(uploadDate); changed = true; }
    if (sb > 0) { target.sizeBytes = sb; changed = true; }
    const stream = String(d.stream_url || d.cdn_url || d.streamUrl || '').trim();
    if (stream && /^https?:\/\//i.test(stream)) { target.streamUrl = stream; changed = true; }
    const thumb = String(d.thumbnail || '').trim();
    if (thumb && /^https?:\/\//i.test(thumb) && !/cdn\.turbo\.cr\/thumbs\//i.test(thumb)) {
      if (!target.thumbnail || target.thumbnail === target.storyboardUrl) target.thumbnail = thumb;
      changed = true;
    }
    const storyboard = String(d.storyboard_url || d.storyboardUrl || '').trim();
    if (storyboard && /^https?:\/\//i.test(storyboard)) {
      target.storyboardUrl = storyboard;
      changed = true;
    }
    if (d.type === 'video' || Number(d.duration) > 0 || Number(d.height) > 0) {
      if (target.mediaType !== 'video') { target.mediaType = 'video'; changed = true; }
    } else if (d.type === 'image' && target.mediaType === 'other') {
      target.mediaType = 'image';
      changed = true;
    }
    if (d.title && (!target.title || target.title === target.key || /^Findr/i.test(target.title))) {
      target.title = String(d.title);
      changed = true;
    }
    return changed;
  }

  // Export pre Node unit testy bez spúšťania DOM časti
  if (typeof module !== 'undefined' && module.exports && typeof document === 'undefined') {
    module.exports = {
      canonicalUrl,
      extractAlbumId,
      extractHostSlug,
      classifyMediaType,
      detectProvider,
      providerLabel,
      parseSizeToBytes,
      formatBytes,
      formatDuration,
      qualityHeight,
      qualityLabel,
      qualityTier,
      normalizeFindrAlbumEntry,
      normalizeFindrFileEntry,
      createVirtualAlbum,
      mergeItemsIntoAlbum,
      removeSourceFromAlbum,
      findDuplicateGroups,
      removeDuplicateGroups,
      undoDuplicateRemoval,
      filterAndSortItems,
      buildM3U8Playlist,
      findAlbumItemByUrl,
      applyFetchedMetadata,
    };
    return;
  }

  // ---------------------------------------------------------------------------
  // 2. SIGNALIZÁCIA & GM STORAGE / HTTP BRIDGE
  // ---------------------------------------------------------------------------
  if (document.getElementById('fnm-root')) return;
  document.documentElement.dataset.nexusFindrManager = '1';
  document.dispatchEvent(new Event('nexus-findr-manager-ready'));

  const gmRequest = typeof GM_xmlhttpRequest === 'function'
    ? GM_xmlhttpRequest
    : (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function' ? GM.xmlHttpRequest.bind(GM) : null);

  function gmRead(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') {
        const raw = GM_getValue(key, null);
        if (raw && typeof raw === 'string') return JSON.parse(raw);
        if (raw && typeof raw === 'object') return raw;
      }
    } catch {}
    try {
      const raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw);
    } catch {}
    return fallback;
  }

  function gmWrite(key, value) {
    const jsonStr = JSON.stringify(value);
    try {
      if (typeof GM_setValue === 'function') GM_setValue(key, jsonStr);
    } catch {}
    try {
      localStorage.setItem(key, jsonStr);
    } catch {}
  }

  function defaultStore() {
    const initial = createVirtualAlbum('Môj zlúčený album');
    return {
      version: 2,
      activeAlbumId: initial.id,
      albums: [initial],
      prefs: {
        port: 8000,
        layout: 'grid',
        aspect: '16/9',
        sort: 'newest',
        dockCollapsed: false,
      },
    };
  }

  function loadStore() {
    const raw = gmRead(STORE_KEY, null);
    if (!raw || !Array.isArray(raw.albums) || !raw.albums.length) return defaultStore();
    const albums = raw.albums.map((a) => ({
      ...createVirtualAlbum(a.name || 'Album'),
      ...a,
      sources: Array.isArray(a.sources) ? a.sources : [],
      items: Array.isArray(a.items) ? a.items : [],
      selectedIds: Array.isArray(a.selectedIds) ? a.selectedIds : [],
      reviewedIds: Array.isArray(a.reviewedIds) ? a.reviewedIds : [],
    }));
    const activeAlbumId = albums.some((a) => a.id === raw.activeAlbumId) ? raw.activeAlbumId : albums[0].id;
    return {
      version: 2,
      activeAlbumId,
      albums,
      prefs: {
        port: NEXUS_PORTS.includes(Number(raw.prefs?.port)) ? Number(raw.prefs.port) : 8000,
        layout: ['grid', 'compact', 'list'].includes(raw.prefs?.layout) ? raw.prefs.layout : 'grid',
        aspect: ['16/9', '3/4'].includes(raw.prefs?.aspect) ? raw.prefs.aspect : '16/9',
        sort: raw.prefs?.sort || 'newest',
        dockCollapsed: Boolean(raw.prefs?.dockCollapsed),
      },
    };
  }

  let store = loadStore();

  function saveStore() {
    gmWrite(STORE_KEY, store);
  }

  function getActiveAlbum() {
    let album = store.albums.find((a) => a.id === store.activeAlbumId);
    if (!album) {
      album = store.albums[0] || createVirtualAlbum();
      if (!store.albums.length) store.albums.push(album);
      store.activeAlbumId = album.id;
    }
    return album;
  }

  function nexusRequest(url, options = {}) {
    if (!gmRequest) {
      return fetch(url, options).then(async (r) => ({
        ok: r.ok,
        status: r.status,
        text: await r.text(),
      }));
    }
    return new Promise((resolve, reject) => {
      gmRequest({
        method: options.method || 'GET',
        url,
        data: options.body || undefined,
        headers: options.headers || {},
        timeout: options.timeout || 45000,
        onload: (r) => resolve({
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          text: r.responseText || '',
        }),
        onerror: () => reject(new Error('Lokálny Nexus server nie je dostupný')),
        ontimeout: () => reject(new Error('Časový limit požiadavky na Nexus vypršal')),
      });
    });
  }

  async function nexusStreamNdjson(url, bodyObj, onEvent, signalObj) {
    if (!gmRequest) {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj),
      });
      if (!resp.ok) throw new Error(`Nexus HTTP ${resp.status}`);
      const text = await resp.text();
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { onEvent(JSON.parse(trimmed)); } catch {}
      }
      return;
    }

    await new Promise((resolve, reject) => {
      let seen = 0;
      let buffer = '';
      const feed = (chunk) => {
        const lines = (buffer + chunk).split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try { onEvent(JSON.parse(trimmed)); } catch {}
        }
      };
      const req = gmRequest({
        method: 'POST',
        url,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/x-ndjson, application/json',
          'Accept-Encoding': 'identity',
        },
        data: JSON.stringify(bodyObj),
        timeout: 300000,
        onprogress: (r) => {
          if (signalObj?.aborted) {
            try { req?.abort?.(); } catch {}
            return;
          }
          const txt = r.responseText || '';
          if (txt.length > seen) {
            feed(txt.slice(seen));
            seen = txt.length;
          }
        },
        onload: (r) => {
          const txt = r.responseText || '';
          if (txt.length > seen) feed(txt.slice(seen));
          if (buffer.trim()) {
            try { onEvent(JSON.parse(buffer.trim())); } catch {}
          }
          if (r.status < 200 || r.status >= 300) {
            reject(new Error(`Nexus vrátil HTTP ${r.status}`));
            return;
          }
          resolve();
        },
        onerror: () => reject(new Error('Nexus server neodpovedá')),
        ontimeout: () => reject(new Error('Deep fetch timeout')),
      });
      if (signalObj) signalObj.abortHandle = () => { try { req?.abort?.(); } catch {} };
    });
  }

  let nexusHealthCache = { origin: '', port: 0, online: false, checkedAt: 0 };

  async function discoverNexusOrigin(force = false) {
    if (!force && nexusHealthCache.checkedAt && Date.now() - nexusHealthCache.checkedAt < 15000) {
      return nexusHealthCache.online ? nexusHealthCache.origin : '';
    }
    const preferred = Number(store.prefs.port || 8000);
    const ports = [...new Set([preferred, ...NEXUS_PORTS])];
    const probeOrigin = async (origin, port) => {
      const res = await nexusRequest(`${origin}/health`, { timeout: 2500 });
      if (!res.ok) throw new Error('not ok');
      const data = JSON.parse(res.text || '{}');
      if (!/nexus/i.test(String(data.service || '')) && data.status !== 'healthy') throw new Error('not nexus');
      return { origin, port };
    };
    for (const port of ports) {
      try {
        const hit = await Promise.any([
          probeOrigin(`http://localhost:${port}`, port),
          probeOrigin(`http://127.0.0.1:${port}`, port),
        ]);
        nexusHealthCache = { origin: hit.origin, port: hit.port, online: true, checkedAt: Date.now() };
        store.prefs.port = hit.port;
        saveStore();
        updateNexusStatusPills();
        return hit.origin;
      } catch {}
    }
    nexusHealthCache = { origin: '', port: preferred, online: false, checkedAt: Date.now() };
    updateNexusStatusPills();
    return '';
  }

  // ---------------------------------------------------------------------------
  // 3. FINDR API ENGINE
  // ---------------------------------------------------------------------------
  const albumApiCache = new Map();

  async function fetchFindrJson(path, params = {}) {
    const u = new URL(path, 'https://findr.to');
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
    const resp = await fetch(u.href, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) throw new Error(`Findr API HTTP ${resp.status}`);
    return resp.json();
  }

  async function fetchFindrAlbumFiles(albumInput, onProgress) {
    const albumId = typeof albumInput === 'string'
      ? extractAlbumId(albumInput) || albumInput
      : String(albumInput.albumId || extractAlbumId(albumInput.findrUrl || albumInput.detailUrl || '') || '');
    const sourceUrl = typeof albumInput === 'object' ? (albumInput.sourceUrl || '') : '';

    if (albumId && /^\d+$/.test(albumId)) {
      if (albumApiCache.has(albumId)) return albumApiCache.get(albumId);
      try {
        const first = await fetchFindrJson(`/api/albums/${encodeURIComponent(albumId)}`, { page: 1, limit: 100 });
        const totalPages = Math.max(1, Math.min(Number(first.total_pages || 1), 500));
        const payloads = [first];
        if (totalPages > 1) {
          const pages = [];
          for (let p = 2; p <= totalPages; p += 1) pages.push(p);
          for (let i = 0; i < pages.length; i += 4) {
            const batch = pages.slice(i, i + 4);
            const res = await Promise.all(
              batch.map((page) => fetchFindrJson(`/api/albums/${encodeURIComponent(albumId)}`, { page, limit: 100 }).catch(() => null))
            );
            payloads.push(...res.filter(Boolean));
            onProgress?.(Math.min(totalPages, 1 + i + batch.length), totalPages);
          }
        }
        const meta = {
          albumId,
          title: String(first.name || first.title || albumInput?.title || `Album #${albumId}`).trim(),
          sourceUrl: canonicalUrl(first.original_url || sourceUrl || `https://findr.to/albums/${albumId}`),
          findrUrl: `https://findr.to/albums/${albumId}`,
          provider: detectProvider(first.original_url || sourceUrl || '', albumInput?.provider || ''),
          fileCount: Number(first.file_count || 0),
          sizeBytes: Number(first.folder_size_bytes || first.total_size_bytes || 0),
          sourceKey: `album:${albumId}`,
        };
        const items = [];
        const seen = new Set();
        for (const payload of payloads) {
          for (const raw of payload.files || []) {
            const norm = normalizeFindrFileEntry(raw, meta);
            if (!norm || seen.has(norm.key)) continue;
            seen.add(norm.key);
            items.push(norm);
          }
        }
        const result = { meta, items };
        albumApiCache.set(albumId, result);
        return result;
      } catch (err) {
        // Fallback na Nexus backend ak zlyhá Findr API a máme sourceUrl
        if (!sourceUrl) throw err;
      }
    }

    const origin = await discoverNexusOrigin();
    if (!origin || !sourceUrl) throw new Error('Nepodarilo sa načítať obsah albumu cez Findr API ani Nexus.');
    const res = await nexusRequest(`${origin}/api/v1/discovery-hub/album-files-index?url=${encodeURIComponent(sourceUrl)}`);
    if (!res.ok) throw new Error(`Nexus album index HTTP ${res.status}`);
    const data = JSON.parse(res.text || '{}');
    const meta = {
      albumId: albumId || sourceUrl,
      title: String(albumInput?.title || 'Findr Album').trim(),
      sourceUrl: canonicalUrl(sourceUrl),
      findrUrl: albumId ? `https://findr.to/albums/${albumId}` : canonicalUrl(sourceUrl),
      provider: detectProvider(sourceUrl, albumInput?.provider || ''),
      fileCount: Number(data.total || (data.items || []).length),
      sizeBytes: 0,
      sourceKey: albumId ? `album:${albumId}` : `album:${sourceUrl}`,
    };
    const items = (data.items || []).map((f) => normalizeFindrFileEntry(f, meta)).filter(Boolean);
    return { meta, items };
  }

  async function fetchFindrSearchMore({ query, view, pageStart = 1, pageCount = 2, media = 'all' }) {
    const out = [];
    const extMap = {
      videos: 'mp4,webm,mkv,mov,m4v,avi,flv,wmv,ts',
      images: 'jpg,jpeg,png,gif,webp,avif,bmp',
    };
    for (let offset = 0; offset < pageCount; offset += 1) {
      const page = pageStart + offset;
      if (view === 'files') {
        const payload = await fetchFindrJson('/api/search', {
          q: query,
          page,
          limit: 60,
          sort: 'relevance',
          ext: extMap[media] || '',
        });
        for (const f of payload.files || []) {
          const item = normalizeFindrFileEntry(f);
          if (item) out.push(item);
        }
        if (!payload.has_more) break;
      } else {
        const path = query ? '/api/albums/search' : '/api/albums';
        const payload = await fetchFindrJson(path, {
          q: query || undefined,
          page,
          limit: 48,
          sort: query ? 'relevance' : 'latest',
        });
        for (const a of payload.albums || []) {
          const alb = normalizeFindrAlbumEntry(a);
          if (alb) out.push(alb);
        }
        if (!payload.has_more && page >= Number(payload.total_pages || 1)) break;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // 4. STAV STRÁNKY A SKENER KARIET
  // ---------------------------------------------------------------------------
  const pageState = {
    cards: [],
    selectedAlbumIds: new Set(),
    selectedFileUrls: new Set(),
    lastSelectedKey: '',
    workspaceOpen: false,
    peekAlbum: null,
    lightboxItems: [],
    lightboxIndex: -1,
    wsFilters: {
      query: '',
      mediaType: 'all',
      provider: 'all',
      sourceKeys: [],
      status: 'all',
      minHeight: 0,
      minDurationMin: 0,
      minSizeMb: 0,
    },
    wsTabAdvanced: false,
    progress: { active: false, label: '', done: 0, total: 0, ok: 0, failed: 0, startedAt: 0, abort: null },
  };

  function currentPageContext() {
    const path = location.pathname;
    const params = new URLSearchParams(location.search);
    const q = params.get('q') || '';
    const view = params.get('view') === 'files' ? 'files' : 'albums';
    if (/^\/albums\/[A-Za-z0-9_-]+/i.test(path)) return { kind: 'album-detail', albumId: extractAlbumId(path), q, view: 'files' };
    if (path.startsWith('/search')) return { kind: view === 'files' ? 'search-files' : 'search-albums', q, view };
    if (path.startsWith('/favorites')) return { kind: 'favorites', q, view };
    if (path.startsWith('/random')) return { kind: 'random', q, view };
    return { kind: 'home', q, view };
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[ch]);
  }

  function isOwnUi(node) {
    return Boolean(node?.closest?.('#fnm-root, #fnm-dock, #fnm-workspace, #fnm-peek, #fnm-lightbox, #fnm-modal, #nuss-overlay, #nuss-picker-modal, #bunkr-album-helper-panel'));
  }

  function extractCardThumbnails(card) {
    const out = [];
    for (const img of card.querySelectorAll('img')) {
      if (isOwnUi(img)) continue;
      const src = img.currentSrc || img.getAttribute('data-src') || img.src || '';
      if (!src || src.startsWith('data:') || /\.svg(?:$|\?)/i.test(src)) continue;
      if (!out.includes(src)) out.push(src);
    }
    return out;
  }

  function scanPageCards() {
    const ctx = currentPageContext();
    const activeAlbum = getActiveAlbum();
    const savedItemKeys = new Set((activeAlbum.items || []).map((i) => i.key));
    const savedAlbumIds = new Set((activeAlbum.sources || []).map((s) => s.albumId).filter(Boolean));
    const seenCardNodes = new Set();
    const nextCards = [];

    // 1. Album karty na stránke (mimo album-detail kde hlavný gríd sú súbory)
    if (ctx.kind !== 'album-detail') {
      for (const link of document.querySelectorAll('a[href^="/albums/"]')) {
        if (isOwnUi(link)) continue;
        const card = link.closest('.group, article, [data-slot="card"], .card') || link.parentElement;
        if (!card || isOwnUi(card) || seenCardNodes.has(card)) continue;
        const distinctAlbums = new Set(
          [...card.querySelectorAll('a[href^="/albums/"]')].map((a) => extractAlbumId(a.getAttribute('href'))).filter(Boolean)
        );
        if (distinctAlbums.size > 2) continue; // ochrana pred wrapperom celej mriežky

        const albumId = extractAlbumId(link.getAttribute('href'));
        if (!albumId) continue;
        seenCardNodes.add(card);

        const extLinks = [...card.querySelectorAll('a[href^="http"]')].filter((a) => {
          try {
            const h = new URL(a.href).hostname.toLowerCase();
            return h !== 'findr.to' && !h.endsWith('.findr.to');
          } catch { return false; }
        });
        const sourceUrl = canonicalUrl(extLinks[0]?.href || '');
        const text = (card.textContent || '').replace(/\s+/g, ' ').trim();
        const heading = card.querySelector('h3, h2, [class*="font-medium"], [class*="font-semibold"]');
        const title = (heading?.textContent || link.textContent || `Album #${albumId}`).trim();
        const fileMatch = text.match(/(\d[\d,]*)\s*files?\b/i);
        const fileCount = fileMatch ? Number(fileMatch[1].replace(/,/g, '')) : 0;
        const sizeMatch = text.match(/(\d+(?:[.,]\d+)?\s*(?:TB|GB|MB|KB|GiB|MiB))/i);
        const sizeBytes = sizeMatch ? parseSizeToBytes(sizeMatch[1]) : 0;
        const badgeTexts = [...card.querySelectorAll('span, div, a')]
          .map((n) => n.textContent.trim())
          .filter((t) => /^(turbo|bunkr|pixeldrain|gofile|coomer|saint)$/i.test(t));
        const provider = detectProvider(sourceUrl, badgeTexts[0] || '');
        const thumbs = extractCardThumbnails(card);

        nextCards.push({
          node: card,
          cardType: 'album',
          key: `album:${albumId}`,
          albumId,
          findrUrl: `https://findr.to/albums/${albumId}`,
          sourceUrl: sourceUrl || `https://findr.to/albums/${albumId}`,
          title,
          fileCount,
          sizeBytes,
          provider,
          thumbnails: thumbs,
          inVirtualAlbum: savedAlbumIds.has(albumId),
        });
      }
    }

    // 2. Súborové karty (view=files, /albums/<id>, alebo karty s priamymi file linkami)
    const fileLinkSel = 'a[href*="/f/"], a[href*="/v/"], a[href*="/d/"], a[href*="turbo.cr/"], a[href*="pixeldrain.com/"], a[href*="gofile.io/d/"]';
    const candidateNodes = new Set();
    for (const a of document.querySelectorAll(fileLinkSel)) {
      if (isOwnUi(a)) continue;
      const card = a.closest('.bah-card, .group, article, .theItem, .grid-item, .file-card, [data-slot="card"]') || a.parentElement;
      if (card && !isOwnUi(card) && !seenCardNodes.has(card)) candidateNodes.add(card);
    }
    if (ctx.kind === 'search-files' || ctx.kind === 'album-detail') {
      for (const grp of document.querySelectorAll('.group, article')) {
        if (!isOwnUi(grp) && !seenCardNodes.has(grp)) candidateNodes.add(grp);
      }
    }

    for (const card of candidateNodes) {
      if (seenCardNodes.has(card)) continue;
      // Ak je to wrapper nad viacerými súbormi, preskoč
      if (card.querySelectorAll(fileLinkSel).length > 4 && !card.classList.contains('bah-card')) continue;

      const extLink = [...card.querySelectorAll('a[href^="http"]')].find((a) => {
        try {
          const h = new URL(a.href).hostname.toLowerCase();
          return h !== 'findr.to' && !h.endsWith('.findr.to');
        } catch { return false; }
      }) || card.querySelector(fileLinkSel);

      const rawHref = extLink?.getAttribute('href') || '';
      const url = canonicalUrl(rawHref ? new URL(rawHref, location.origin).href : '');
      if (!url) continue;

      seenCardNodes.add(card);
      const albumLink = card.querySelector('a[href^="/albums/"]');
      const albumId = ctx.albumId || extractAlbumId(albumLink?.getAttribute('href') || '');
      const albumTitle = albumId
        ? (albumLink?.textContent?.trim() || document.querySelector('h1')?.textContent?.trim() || `Album #${albumId}`)
        : 'Findr Files';
      const titleNode = card.querySelector('.bah-caption, .theName, h3, h2, p, .truncate, [title]');
      let filename = (titleNode?.getAttribute('title') || titleNode?.textContent || extLink?.textContent || '').trim();
      if (!filename || /^(open|view|download|link)$/i.test(filename)) {
        filename = url.split('/').pop() || 'Findr súbor';
      }
      const text = (card.textContent || '').replace(/\s+/g, ' ').trim();
      const sizeMatch = text.match(/(\d+(?:[.,]\d+)?\s*(?:TB|GB|MB|KB|GiB|MiB))/i);
      const sizeBytes = sizeMatch ? parseSizeToBytes(sizeMatch[1]) : 0;
      const thumbs = extractCardThumbnails(card);
      const badgeTexts = [...card.querySelectorAll('span, div')]
        .map((n) => n.textContent.trim())
        .filter((t) => /^(turbo|bunkr|pixeldrain|gofile|coomer|saint)$/i.test(t));
      const provider = detectProvider(url, badgeTexts[0] || '');
      const mediaType = classifyMediaType(filename, url);

      nextCards.push({
        node: card,
        cardType: 'file',
        key: url,
        url,
        watchUrl: url,
        albumId,
        albumTitle,
        filename,
        title: filename,
        mediaType,
        provider,
        sizeBytes,
        thumbnail: thumbs[0] || '',
        createdAt: card.querySelector('time[datetime]')?.getAttribute('datetime') || '',
        inVirtualAlbum: savedItemKeys.has(url),
      });
    }

    pageState.cards = nextCards;
    decoratePageCards();
    updateDock();
  }

  function isCardSelected(card) {
    return card.cardType === 'album'
      ? pageState.selectedAlbumIds.has(card.albumId)
      : pageState.selectedFileUrls.has(card.url);
  }

  function setCardSelected(card, checked) {
    if (card.cardType === 'album') {
      if (checked) pageState.selectedAlbumIds.add(card.albumId);
      else pageState.selectedAlbumIds.delete(card.albumId);
    } else {
      if (checked) pageState.selectedFileUrls.add(card.url);
      else pageState.selectedFileUrls.delete(card.url);
    }
  }

  function decoratePageCards() {
    const activeAlbum = getActiveAlbum();
    const savedItemKeys = new Set((activeAlbum.items || []).map((i) => i.key));
    const savedAlbumIds = new Set((activeAlbum.sources || []).map((s) => s.albumId).filter(Boolean));

    for (const card of pageState.cards) {
      const node = card.node;
      if (!node || !node.isConnected) continue;

      const selected = isCardSelected(card);
      const inAlbum = card.cardType === 'album'
        ? savedAlbumIds.has(card.albumId)
        : savedItemKeys.has(card.url);
      card.inVirtualAlbum = inAlbum;

      node.classList.add('fnm-card');
      node.classList.toggle('fnm-selected', selected);
      node.classList.toggle('fnm-in-album', inAlbum);
      node.dataset.fnmCardType = card.cardType;
      node.dataset.fnmKey = card.key;
      if (card.cardType === 'file') {
        node.dataset.fnmUrl = card.url;
        node.dataset.fnmTitle = card.title;
        node.dataset.fnmMediaType = card.mediaType;
        node.dataset.fnmProvider = card.provider;
        node.dataset.fnmThumb = card.thumbnail || '';
        node.dataset.fnmSize = String(card.sizeBytes || 0);
      }

      if (getComputedStyle(node).position === 'static') node.style.position = 'relative';

      // Ak je na /albums/* aktívny Bunkr Suite (.bah-card), nevkladaj duplicitný checkbox ak už má .bah-cb
      const hasBah = node.classList.contains('bah-card');
      let bar = node.querySelector(':scope > .fnm-card-overlay');
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'fnm-card-overlay';
        if (hasBah) bar.classList.add('is-compact-bah');

        if (!hasBah) {
          const checkLabel = document.createElement('label');
          checkLabel.className = 'fnm-check-pill';
          checkLabel.innerHTML = '<input type="checkbox" class="fnm-card-check"><span></span>';
          const input = checkLabel.querySelector('input');
          checkLabel.addEventListener('click', (e) => e.stopPropagation());
          input.addEventListener('click', (e) => {
            e.stopPropagation();
            const checked = e.currentTarget.checked;
            const sameType = pageState.cards.filter((c) => c.cardType === card.cardType);
            const fromIdx = sameType.findIndex((c) => c.key === pageState.lastSelectedKey);
            const toIdx = sameType.findIndex((c) => c.key === card.key);
            if (e.shiftKey && fromIdx >= 0 && toIdx >= 0) {
              const start = Math.min(fromIdx, toIdx);
              const end = Math.max(fromIdx, toIdx);
              for (const item of sameType.slice(start, end + 1)) setCardSelected(item, checked);
            } else {
              setCardSelected(card, checked);
            }
            pageState.lastSelectedKey = card.key;
            decoratePageCards();
            updateDock();
          });
          bar.append(checkLabel);
        }

        const quick = document.createElement('div');
        quick.className = 'fnm-card-quick';

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'fnm-qbtn fnm-qbtn-add';
        addBtn.title = card.cardType === 'album' ? 'Rozbaliť a pridať do Virtuálneho albumu' : 'Pridať do Virtuálneho albumu';
        addBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          quickAddSingleCard(card, addBtn);
        });
        quick.append(addBtn);

        const peekBtn = document.createElement('button');
        peekBtn.type = 'button';
        peekBtn.className = 'fnm-qbtn';
        peekBtn.textContent = card.cardType === 'album' ? '👁' : '▶';
        peekBtn.title = card.cardType === 'album' ? 'Quick Peek (náhľad obsahu albumu)' : 'Náhľad súboru';
        peekBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (card.cardType === 'album') openPeekDrawer(card);
          else openLightbox([normalizeFindrFileEntry(card)], 0);
        });
        quick.append(peekBtn);

        if (card.cardType === 'file' && card.mediaType === 'video') {
          const splitBtn = document.createElement('button');
          splitBtn.type = 'button';
          splitBtn.className = 'fnm-qbtn fnm-qbtn-split';
          splitBtn.textContent = '▦';
          splitBtn.title = 'Otvoriť v Nexus Split-Screen';
          splitBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            launchSplitScreen([normalizeFindrFileEntry(card)], 'open');
          });
          quick.append(splitBtn);
        }

        bar.append(quick);
        node.append(bar);
      }

      const cb = bar.querySelector('.fnm-card-check');
      if (cb) cb.checked = selected;
      const checkText = bar.querySelector('.fnm-check-pill span');
      if (checkText) checkText.textContent = selected ? 'Vybrané' : (card.cardType === 'album' ? 'Album' : 'Súbor');

      const addBtn = bar.querySelector('.fnm-qbtn-add');
      if (addBtn && !addBtn.dataset.busy) {
        addBtn.textContent = inAlbum ? '✓ V albume' : '＋ Album';
        addBtn.classList.toggle('is-saved', inAlbum);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 5. AKCIE PRIDÁVANIA DO VIRTUÁLNEHO ALBUMU
  // ---------------------------------------------------------------------------
  async function quickAddSingleCard(card, btn) {
    if (btn?.dataset.busy === '1') return;
    const album = getActiveAlbum();
    if (card.cardType === 'file') {
      const item = normalizeFindrFileEntry(card);
      const res = mergeItemsIntoAlbum(album, [item]);
      saveStore();
      decoratePageCards();
      updateDock();
      showToast(res.added ? `Pridané do „${album.name}“.` : `Súbor už je v „${album.name}“.`);
      return;
    }

    if (btn) {
      btn.dataset.busy = '1';
      btn.textContent = '⏳…';
    }
    try {
      const { meta, items } = await fetchFindrAlbumFiles(card);
      const res = mergeItemsIntoAlbum(album, items, meta);
      saveStore();
      decoratePageCards();
      updateDock();
      if (pageState.workspaceOpen) renderWorkspace();
      showToast(`Album „${meta.title}“: +${res.added} súborov (${res.skipped} duplicít preskočených) do „${album.name}“.`);
    } catch (err) {
      showToast(`Nepodarilo sa načítať album: ${err.message || err}`, true);
    } finally {
      if (btn) delete btn.dataset.busy;
      decoratePageCards();
    }
  }

  async function addPageSelectionToVirtualAlbum(openAfter = false) {
    const selectedAlbums = pageState.cards.filter((c) => c.cardType === 'album' && pageState.selectedAlbumIds.has(c.albumId));
    const selectedFiles = pageState.cards.filter((c) => c.cardType === 'file' && pageState.selectedFileUrls.has(c.url));
    if (!selectedAlbums.length && !selectedFiles.length) {
      showToast('Najprv označ aspoň jeden album alebo súbor na stránke.', true);
      return;
    }

    const album = getActiveAlbum();
    let totalAdded = 0;
    let totalSkipped = 0;

    if (selectedFiles.length) {
      const res = mergeItemsIntoAlbum(album, selectedFiles.map((f) => normalizeFindrFileEntry(f)));
      totalAdded += res.added;
      totalSkipped += res.skipped;
    }

    if (selectedAlbums.length) {
      setProgress(true, `Rozbaľujem ${selectedAlbums.length} albumov cez Findr API…`, 0, selectedAlbums.length);
      const badge = document.querySelector('#fnm-dock [data-dock="page-count"]');
      for (let i = 0; i < selectedAlbums.length; i += 4) {
        if (pageState.progress.abort?.aborted) break;
        const batch = selectedAlbums.slice(i, i + 4);
        await Promise.all(batch.map(async (albCard) => {
          try {
            const { meta, items } = await fetchFindrAlbumFiles(albCard);
            const res = mergeItemsIntoAlbum(album, items, meta);
            totalAdded += res.added;
            totalSkipped += res.skipped;
            pageState.progress.ok += 1;
          } catch {
            pageState.progress.failed += 1;
          } finally {
            pageState.progress.done += 1;
            if (badge) badge.textContent = `Rozbaľujem ${pageState.progress.done}/${selectedAlbums.length}…`;
            paintProgress();
          }
        }));
      }
      setProgress(false);
    }

    saveStore();
    decoratePageCards();
    updateDock();
    if (pageState.workspaceOpen) renderWorkspace();
    showToast(`Zlúčené do „${album.name}“: +${totalAdded} nových súborov${totalSkipped ? ` (${totalSkipped} duplicít preskočených)` : ''}.`);
    if (openAfter) openWorkspace();
  }

  // ---------------------------------------------------------------------------
  // 6. SPLIT-SCREEN, IMPORT & DEEP FETCH INTEGRÁCIE
  // ---------------------------------------------------------------------------
  function launchSplitScreen(items, mode = 'open') {
    const videos = (items || []).filter((it) => it && it.url && it.mediaType !== 'image');
    if (!videos.length) {
      showToast('Žiadne video položky na odoslanie do Split-Screenu.', true);
      return;
    }
    const payload = videos.map((it) => ({
      id: it.key || it.url,
      url: it.streamUrl || it.url,
      watchUrl: it.watchUrl || it.url,
      streamUrl: it.streamUrl || '',
      title: it.title || it.filename || 'Findr video',
      poster: it.storyboardUrl || it.thumbnail || '',
      duration: Number(it.duration || 0) || 0,
      quality: qualityLabel(it),
      sizeBytes: Number(it.sizeBytes || 0) || 0,
      provider: it.provider || 'other',
    }));

    if (document.documentElement.dataset.nexusFindrSplitReady === '1') {
      const eventName = mode === 'picker' || videos.length > 12 ? 'nexus-findr-split-picker' : 'nexus-findr-split-open';
      document.dispatchEvent(new CustomEvent(eventName, { detail: JSON.stringify(payload) }));
      showToast(`Odoslaných ${Math.min(payload.length, mode === 'picker' ? payload.length : 12)} videí do Nexus Split-Screenu.`);
      return;
    }

    // Fallback ak beží staršia verzia Split-Screenu (bez nexus-findr-split-open)
    if (document.documentElement.dataset.nexusSplitReady === '1') {
      document.dispatchEvent(new CustomEvent('nexus-turbo-split-open', { detail: JSON.stringify(payload) }));
      showToast(`Odoslané cez fallback do Nexus Split-Screenu (${payload.length}).`);
      return;
    }
    showToast('Userscript Nexus Universal Split-Screen nie je na tejto karte aktívny.', true);
  }

  async function runBatchMetaFallback(origin, items, album, signalObj) {
    for (let i = 0; i < items.length; i += 6) {
      if (signalObj?.aborted) break;
      const chunk = items.slice(i, i + 6);
      const res = await nexusRequest(`${origin}/api/tester/batch-meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: chunk.map((it) => it.url),
          metadata_only: false,
          full_metadata: true,
        }),
        timeout: 120000,
      });
      if (!res.ok) throw new Error(`batch-meta HTTP ${res.status}`);
      const payload = JSON.parse(res.text || '{}');
      for (const row of payload.results || []) {
        pageState.progress.done = Math.min(pageState.progress.total, pageState.progress.done + 1);
        const target = findAlbumItemByUrl(album, row.url) || chunk.find((c) => c.url === row.url);
        const updated = target && applyFetchedMetadata(target, row);
        if (row.ok || updated) {
          pageState.progress.ok += 1;
          if (target) {
            const stream = String(row.stream_url || row.cdn_url || '').trim();
            if (!target.thumbnail && !target.storyboardUrl && stream && /turbocdn\.st|gofile\.io|filester|fileditch/i.test(stream)) {
              target.storyboardUrl = `${origin}/api/tester/frame?url=${encodeURIComponent(stream)}&at=10&width=480`;
            }
            paintWorkspaceCard(target);
          }
        } else {
          pageState.progress.failed += 1;
        }
      }
      saveStore();
      paintProgress();
    }
  }

  async function runDeepFetch(targetItems) {
    const candidates = (targetItems || []).filter((it) => it && it.url && it.mediaType !== 'image');
    if (!candidates.length) {
      showToast('Žiadne video / súborové položky na Deep Fetch.', true);
      return;
    }
    const origin = await discoverNexusOrigin(true);
    if (!origin) {
      showToast('Lokálny Nexus server (port 8000–8003) nie je spustený.', true);
      return;
    }

    const album = getActiveAlbum();
    const signalObj = { aborted: false, abortHandle: null };
    setProgress(true, 'Deep Fetch metadát (Nexus)', 0, candidates.length, signalObj);

    const bunkrItems = candidates.filter((it) => it.provider === 'bunkr' || detectProvider(it.url) === 'bunkr');
    const otherItems = candidates.filter((it) => !bunkrItems.includes(it));
    const retryViaBatchMeta = [];

    try {
      // Malé dávky po 8 URL zabezpečia plynulé live aktualizácie kariet aj počítadla
      for (let i = 0; i < bunkrItems.length; i += 8) {
        if (signalObj.aborted) break;
        const chunk = bunkrItems.slice(i, i + 8);
        await nexusStreamNdjson(`${origin}/api/v1/discovery-hub/refetch-meta`, { urls: chunk.map((v) => v.url) }, (ev) => {
          if (ev.type !== 'patch') return;
          const target = findAlbumItemByUrl(album, ev.url);
          if (ev.ok && target) {
            pageState.progress.done = Math.min(pageState.progress.total, pageState.progress.done + 1);
            pageState.progress.ok += 1;
            if (ev.data) applyFetchedMetadata(target, ev.data);
            paintWorkspaceCard(target);
            paintProgress();
          } else if (ev.url) {
            if (target && ev.data) applyFetchedMetadata(target, ev.data);
            const fallbackItem = target || chunk.find((c) => canonicalUrl(c.url) === canonicalUrl(ev.url));
            if (fallbackItem) retryViaBatchMeta.push(fallbackItem);
            else {
              pageState.progress.done = Math.min(pageState.progress.total, pageState.progress.done + 1);
              pageState.progress.failed += 1;
              paintProgress();
            }
          }
        }, signalObj);
        saveStore();
      }

      const batchQueue = [...otherItems, ...retryViaBatchMeta];
      if (batchQueue.length && !signalObj.aborted) {
        await runBatchMetaFallback(origin, batchQueue, album, signalObj);
      }

      saveStore();
      showToast(`Deep Fetch hotový: ${pageState.progress.ok}/${candidates.length} OK${pageState.progress.failed ? `, ${pageState.progress.failed} zlyhalo` : ''}.`);
    } catch (err) {
      showToast(`Deep Fetch zlyhal: ${err.message || err}`, true);
    } finally {
      setProgress(false);
      if (pageState.workspaceOpen) renderWorkspace();
    }
  }

  async function runHdThumbFetch(targetItems) {
    const candidates = (targetItems || []).filter((it) => it && it.url && it.mediaType !== 'image');
    if (!candidates.length) {
      showToast('Žiadne videá na načítanie HD náhľadov.', true);
      return;
    }
    const origin = await discoverNexusOrigin(true);
    if (!origin) {
      showToast('Lokálny Nexus server nie je dostupný.', true);
      return;
    }
    const album = getActiveAlbum();
    const signalObj = { aborted: false, abortHandle: null };
    setProgress(true, 'Načítavam HD storyboard náhľady…', 0, candidates.length, signalObj);

    const bunkrItems = candidates.filter((it) => it.provider === 'bunkr' || detectProvider(it.url) === 'bunkr');
    const otherItems = candidates.filter((it) => !bunkrItems.includes(it));
    const fallbackItems = [...otherItems];

    try {
      for (let i = 0; i < bunkrItems.length; i += 12) {
        if (signalObj.aborted) break;
        const chunk = bunkrItems.slice(i, i + 12);
        await nexusStreamNdjson(`${origin}/api/v1/discovery-hub/fetch-hd-thumbs`, { urls: chunk.map((v) => v.url), force: true }, (ev) => {
          if (ev.type !== 'patch') return;
          const sbUrl = ev.data?.storyboard_url || ev.storyboard_url || '';
          const target = findAlbumItemByUrl(album, ev.url);
          if (sbUrl && target) {
            pageState.progress.done = Math.min(pageState.progress.total, pageState.progress.done + 1);
            pageState.progress.ok += 1;
            target.storyboardUrl = sbUrl;
            paintWorkspaceCard(target);
            paintProgress();
          } else {
            const item = target || chunk.find((c) => canonicalUrl(c.url) === canonicalUrl(ev.url));
            if (item) fallbackItems.push(item);
            else {
              pageState.progress.done = Math.min(pageState.progress.total, pageState.progress.done + 1);
              pageState.progress.failed += 1;
              paintProgress();
            }
          }
        }, signalObj);
        saveStore();
      }

      if (fallbackItems.length && !signalObj.aborted) {
        await runBatchMetaFallback(origin, fallbackItems, album, signalObj);
      }

      saveStore();
      showToast(`HD náhľady hotové: ${pageState.progress.ok}/${candidates.length} OK.`);
    } catch (err) {
      showToast(`HD náhľady zlyhali: ${err.message || err}`, true);
    } finally {
      setProgress(false);
      if (pageState.workspaceOpen) renderWorkspace();
    }
  }

  let progressTimerId = 0;
  function setProgress(active, label = '', done = 0, total = 0, abort = null) {
    clearInterval(progressTimerId);
    progressTimerId = 0;
    if (!active) {
      pageState.progress.active = false;
      pageState.progress.abort = null;
      pageState.progress.finishedAt = Date.now();
    } else {
      pageState.progress = {
        active: true,
        label,
        done,
        total: Math.max(1, total),
        ok: 0,
        failed: 0,
        startedAt: Date.now(),
        finishedAt: 0,
        abort: abort || { aborted: false },
      };
      progressTimerId = setInterval(() => {
        if (!pageState.progress.active) {
          clearInterval(progressTimerId);
          progressTimerId = 0;
          return;
        }
        paintProgress();
      }, 1000);
    }
    paintProgress();
  }

  // ---------------------------------------------------------------------------
  // 7. UI KOMPONENTY (Dock, Workspace, Quick Peek, Lightbox, Import Modal)
  // ---------------------------------------------------------------------------
  function showToast(message, isError = false) {
    const root = document.getElementById('fnm-root');
    if (!root) return;
    let toast = document.getElementById('fnm-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'fnm-toast';
      toast.setAttribute('role', 'status');
      root.append(toast);
    }
    toast.textContent = message;
    toast.dataset.error = isError ? 'true' : 'false';
    toast.classList.add('is-visible');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('is-visible'), 4200);
  }

  function updateNexusStatusPills() {
    document.querySelectorAll('[data-fnm-nexus-status]').forEach((el) => {
      if (nexusHealthCache.online) {
        el.textContent = `● Nexus :${nexusHealthCache.port}`;
        el.dataset.online = 'true';
      } else {
        el.textContent = `○ Nexus :${store.prefs.port}`;
        el.dataset.online = 'false';
      }
    });
  }

  function updateDock() {
    const dock = document.getElementById('fnm-dock');
    if (!dock) return;
    const album = getActiveAlbum();
    const selAlb = pageState.selectedAlbumIds.size;
    const selFil = pageState.selectedFileUrls.size;
    const totalPageSel = selAlb + selFil;
    const ctx = currentPageContext();

    dock.classList.toggle('is-collapsed', Boolean(store.prefs.dockCollapsed));
    const pageBadge = dock.querySelector('[data-dock="page-count"]');
    if (pageBadge) {
      pageBadge.textContent = totalPageSel
        ? `${selAlb} alb. · ${selFil} súb.`
        : `${pageState.cards.length} kariet na stránke`;
    }
    const albumBadge = dock.querySelector('[data-dock="album-btn"]');
    if (albumBadge) {
      albumBadge.textContent = `📂 ${album.name} (${album.items.length})`;
    }
    const addBtn = dock.querySelector('[data-dock="add-selected"]');
    if (addBtn) addBtn.disabled = totalPageSel === 0;
    const splitBtn = dock.querySelector('[data-dock="split-page"]');
    if (splitBtn) splitBtn.disabled = selFil === 0;
    const apiMoreBtn = dock.querySelector('[data-dock="load-more-api"]');
    if (apiMoreBtn) apiMoreBtn.hidden = !['home', 'search-albums', 'search-files'].includes(ctx.kind);
  }

  function openWorkspace(albumId = null) {
    if (albumId && store.albums.some((a) => a.id === albumId)) {
      store.activeAlbumId = albumId;
      saveStore();
    }
    pageState.workspaceOpen = true;
    const ws = document.getElementById('fnm-workspace');
    if (ws) ws.hidden = false;
    document.documentElement.classList.add('fnm-ws-open');
    renderWorkspace();
    discoverNexusOrigin();
  }

  function closeWorkspace() {
    pageState.workspaceOpen = false;
    const ws = document.getElementById('fnm-workspace');
    if (ws) ws.hidden = true;
    document.documentElement.classList.remove('fnm-ws-open');
    if (location.hash.startsWith('#fnm-album=')) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }

  function workspaceFilteredItems() {
    const album = getActiveAlbum();
    return filterAndSortItems(
      album.items,
      pageState.wsFilters,
      store.prefs.sort,
      new Set(album.selectedIds),
      new Set(album.reviewedIds)
    );
  }

  function paintProgress() {
    const el = document.querySelector('#fnm-workspace [data-ws="progress"]');
    if (!el) return;
    const p = pageState.progress;
    if (!p.active && !p.done) {
      el.innerHTML = '';
      return;
    }
    const total = Math.max(1, p.total);
    const done = Math.min(p.done, total);
    const pct = Math.round((done / total) * 100);
    const endTs = p.active ? Date.now() : (p.finishedAt || Date.now());
    const elapsedSec = Math.max(0, Math.floor((endTs - (p.startedAt || endTs)) / 1000));
    const timerStr = `${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, '0')}`;
    const rate = done / Math.max(1, elapsedSec);
    const eta = p.active && done > 0 && done < total && rate > 0
      ? `ETA ~${Math.ceil((total - done) / rate)}s`
      : (p.active ? 'odhadujem…' : 'hotovo');
    const summaryText = `⏱ ${timerStr} · ${done} / ${total} (${pct}%) · OK ${p.ok} · Zlyhalo ${p.failed} · ${eta}`;

    const existingBox = el.querySelector('.fnm-progress-box');
    const wasActive = existingBox?.dataset.active === 'true';
    if (existingBox && wasActive === Boolean(p.active)) {
      const labelEl = existingBox.querySelector('[data-progress-label]');
      const metaEl = existingBox.querySelector('[data-progress-meta]');
      const fillEl = existingBox.querySelector('.fnm-progress-fill');
      if (labelEl) labelEl.textContent = p.label;
      if (metaEl) metaEl.textContent = summaryText;
      if (fillEl) fillEl.style.width = `${pct}%`;
      return;
    }

    el.innerHTML = `
      <div class="fnm-progress-box" data-active="${p.active ? 'true' : 'false'}">
        <div class="fnm-progress-head">
          <strong data-progress-label>${escapeHtml(p.label)}</strong>
          <span class="fnm-mono" data-progress-meta>${escapeHtml(summaryText)}</span>
          ${p.active ? '<button type="button" class="fnm-btn fnm-btn-danger" data-ws-act="abort-progress">Zastaviť</button>' : ''}
        </div>
        <div class="fnm-progress-track"><div class="fnm-progress-fill" style="width:${pct}%"></div></div>
      </div>`;
    el.querySelector('[data-ws-act="abort-progress"]')?.addEventListener('click', () => {
      if (pageState.progress.abort) {
        pageState.progress.abort.aborted = true;
        pageState.progress.abort.abortHandle?.();
      }
    });
  }

  function renderWorkspaceCardHtml(item, selectedSet, reviewedSet) {
    const selected = selectedSet.has(item.key);
    const reviewed = reviewedSet.has(item.key);
    const q = qualityLabel(item);
    const tier = qualityTier(item);
    const dur = formatDuration(item.duration);
    const size = formatBytes(item.sizeBytes);
    const uploadDate = formatUploadDate(item.createdAt);
    const thumb = item.storyboardUrl || item.thumbnail;
    const pLabel = providerLabel(item.provider);

    if (store.prefs.layout === 'list') {
      return `
        <article class="fnm-ws-row${selected ? ' is-selected' : ''}" data-fnm-item-key="${escapeHtml(item.key)}" data-fnm-url="${escapeHtml(item.url)}" data-fnm-media-type="${escapeHtml(item.mediaType)}" data-fnm-title="${escapeHtml(item.title)}">
          <input type="checkbox" class="fnm-ws-check" data-ws-check="${escapeHtml(item.key)}" ${selected ? 'checked' : ''}>
          <div class="fnm-ws-row-thumb" data-ws-preview="${escapeHtml(item.key)}">
            ${thumb ? `<img loading="lazy" src="${escapeHtml(thumb)}" data-fnm-fallback="${escapeHtml(item.thumbnail || '')}" alt="">` : `<span>${item.mediaType === 'image' ? 'IMG' : 'VID'}</span>`}
          </div>
          <div class="fnm-ws-row-main">
            <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" class="fnm-ws-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</a>
            <div class="fnm-ws-sub">${escapeHtml(item.albumTitle)}</div>
            <div class="fnm-ws-date">${escapeHtml(uploadDate)}</div>
          </div>
          <span class="fnm-chip fnm-chip-provider p-${escapeHtml(item.provider)}">${escapeHtml(pLabel)}</span>
          <span class="fnm-chip fnm-chip-q ${tier}">${q || '?'}</span>
          <span class="fnm-chip fnm-mono">${dur || '—'}</span>
          <span class="fnm-chip fnm-mono">${size}</span>
          <div class="fnm-ws-row-acts">
            <button type="button" class="fnm-icon-btn${reviewed ? ' is-reviewed' : ''}" data-ws-review="${escapeHtml(item.key)}" title="Označiť prezreté">${reviewed ? '✓' : '○'}</button>
            ${item.mediaType === 'video' ? `<button type="button" class="fnm-icon-btn" data-ws-split="${escapeHtml(item.key)}" title="Split-Screen">▦</button>` : ''}
            <button type="button" class="fnm-icon-btn" data-ws-preview="${escapeHtml(item.key)}" title="Náhľad">▶</button>
          </div>
        </article>`;
    }

    return `
      <article class="fnm-ws-card${selected ? ' is-selected' : ''}" data-fnm-item-key="${escapeHtml(item.key)}" data-fnm-url="${escapeHtml(item.url)}" data-fnm-media-type="${escapeHtml(item.mediaType)}" data-fnm-title="${escapeHtml(item.title)}" data-fnm-thumb="${escapeHtml(thumb || '')}" data-fnm-stream-url="${escapeHtml(item.streamUrl || '')}" data-fnm-duration="${Number(item.duration || 0)}" data-fnm-size="${Number(item.sizeBytes || 0)}" data-fnm-quality="${escapeHtml(q)}" data-fnm-provider="${escapeHtml(item.provider)}">
        <div class="fnm-ws-thumb ratio-${store.prefs.aspect === '3/4' ? 'portrait' : 'wide'}" data-ws-preview="${escapeHtml(item.key)}">
          ${thumb ? `<img loading="lazy" src="${escapeHtml(thumb)}" data-fnm-fallback="${escapeHtml(item.thumbnail || '')}" alt="">` : `<div class="fnm-ws-nothumb">${item.mediaType === 'image' ? 'OBRÁZOK' : 'VIDEO'}</div>`}
          <label class="fnm-ws-check-wrap" title="Shift+klik pre výber rozsahu">
            <input type="checkbox" class="fnm-ws-check" data-ws-check="${escapeHtml(item.key)}" ${selected ? 'checked' : ''}>
          </label>
          <span class="fnm-ws-provider p-${escapeHtml(item.provider)}">${escapeHtml(pLabel)}</span>
          ${item.mediaType === 'video' ? `<span class="fnm-ws-q ${tier}">${q || '?'}</span>` : '<span class="fnm-ws-q qimg">IMG</span>'}
          ${dur ? `<span class="fnm-ws-dur">${dur}</span>` : ''}
          <button type="button" class="fnm-ws-rev${reviewed ? ' is-reviewed' : ''}" data-ws-review="${escapeHtml(item.key)}" title="Označiť prezreté">${reviewed ? '✓' : '○'}</button>
          <div class="fnm-ws-hover-acts">
            <button type="button" class="fnm-ws-play" data-ws-preview="${escapeHtml(item.key)}">${item.mediaType === 'image' ? '🔍 Zobraziť' : '▶ Prehrať'}</button>
            ${item.mediaType === 'video' ? `<button type="button" class="fnm-ws-split-btn" data-ws-split="${escapeHtml(item.key)}" title="Otvoriť v Split-Screen">▦ Split</button>` : ''}
          </div>
        </div>
        <div class="fnm-ws-body">
          <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" class="fnm-ws-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</a>
          <div class="fnm-ws-meta">
            <span class="fnm-ws-album-name" title="${escapeHtml(item.albumTitle)}">${escapeHtml(item.albumTitle)}</span>
            <span class="fnm-mono">${size}</span>
          </div>
          <div class="fnm-ws-date">${escapeHtml(uploadDate)}</div>
        </div>
      </article>`;
  }

  function paintWorkspaceCard(item) {
    const ws = document.getElementById('fnm-workspace');
    if (!ws || ws.hidden) return;
    const node = ws.querySelector(`[data-fnm-item-key="${CSS.escape(item.key)}"]`);
    if (!node) return;
    const album = getActiveAlbum();
    const tmp = document.createElement('div');
    tmp.innerHTML = renderWorkspaceCardHtml(item, new Set(album.selectedIds), new Set(album.reviewedIds));
    const next = tmp.firstElementChild;
    if (next) node.replaceWith(next);
  }

  function renderWorkspace() {
    const ws = document.getElementById('fnm-workspace');
    if (!ws) return;
    const album = getActiveAlbum();
    const selectedSet = new Set(album.selectedIds);
    const reviewedSet = new Set(album.reviewedIds);
    const filtered = workspaceFilteredItems();
    const f = pageState.wsFilters;

    const videoCount = album.items.filter((i) => i.mediaType === 'video').length;
    const imageCount = album.items.filter((i) => i.mediaType === 'image').length;
    const totalBytes = album.items.reduce((s, i) => s + (Number(i.sizeBytes) || 0), 0);
    const selectedBytes = album.items.filter((i) => selectedSet.has(i.key)).reduce((s, i) => s + (Number(i.sizeBytes) || 0), 0);
    const selectedVisibleAll = filtered.length > 0 && filtered.every((i) => selectedSet.has(i.key));
    const providersPresent = [...new Set(album.items.map((i) => i.provider).filter(Boolean))];

    ws.innerHTML = `
      <div class="fnm-ws-shell">
        <header class="fnm-ws-header">
          <div class="fnm-ws-brand">
            <span class="fnm-logo-badge">Findr × Nexus</span>
            <select data-ws="album-select" aria-label="Vybrať virtuálny album">
              ${store.albums.map((a) => `<option value="${escapeHtml(a.id)}" ${a.id === album.id ? 'selected' : ''}>${escapeHtml(a.name)} (${a.items.length})</option>`).join('')}
            </select>
            <button type="button" class="fnm-btn" data-ws-act="new-album">+ Nový</button>
            <button type="button" class="fnm-btn" data-ws-act="rename-album">Premenovať</button>
            <button type="button" class="fnm-btn" data-ws-act="dup-album">Duplikovať</button>
            <button type="button" class="fnm-btn fnm-btn-danger" data-ws-act="del-album" ${store.albums.length <= 1 ? 'disabled' : ''}>Zmazať</button>
          </div>
          <div class="fnm-ws-head-right">
            <button type="button" class="fnm-btn" data-ws-act="add-url">+ Pridať URL</button>
            <button type="button" class="fnm-status-pill" data-fnm-nexus-status data-ws-act="ping-nexus">○ Nexus :${store.prefs.port}</button>
            <button type="button" class="fnm-close-btn" data-ws-act="close" title="Zavrieť (Esc)">✕</button>
          </div>
        </header>

        <section class="fnm-ws-stats-strip">
          <div class="fnm-stat-chips">
            <span class="fnm-stat"><strong>${album.items.length}</strong> položiek</span>
            <span class="fnm-stat"><strong>${videoCount}</strong> videí</span>
            <span class="fnm-stat"><strong>${imageCount}</strong> obrázkov</span>
            <span class="fnm-stat"><strong>${formatBytes(totalBytes)}</strong> spolu</span>
            <span class="fnm-stat"><strong>${filtered.length}</strong> zobrazených</span>
          </div>
          <div class="fnm-source-strip">
            <button type="button" class="fnm-source-chip${!f.sourceKeys.length ? ' is-active' : ''}" data-ws-source="all" aria-pressed="${!f.sourceKeys.length}">Všetky zdroje (${album.items.length})</button>
            ${album.sources.map((s) => `
              <span class="fnm-source-chip${f.sourceKeys.includes(s.sourceKey) ? ' is-active' : ''}">
                <button type="button" class="fnm-source-chip-main" data-ws-source="${escapeHtml(s.sourceKey)}" aria-pressed="${f.sourceKeys.includes(s.sourceKey)}" title="Kliknutím pridáš alebo odoberieš zdroj z filtra">${escapeHtml(s.title)} <em>(${s.itemCount})</em></button>
                <button type="button" class="fnm-source-chip-x" data-ws-remove-source="${escapeHtml(s.sourceKey)}" title="Odstrániť tento zdrojový album">×</button>
              </span>`).join('')}
          </div>
        </section>

        <section class="fnm-ws-toolbar">
          <div class="fnm-ws-toolbar-row">
            <input type="search" class="fnm-search-input" data-ws="query" value="${escapeHtml(f.query)}" placeholder="Hľadať názov, súbor, zdrojový album…">
            <div class="fnm-seg-group" role="group" aria-label="Typ média">
              ${[['all', 'Všetko'], ['video', 'Videá'], ['image', 'Obrázky'], ['other', 'Ostatné']].map(([k, lbl]) => `
                <button type="button" class="fnm-seg${f.mediaType === k ? ' is-active' : ''}" data-ws-media="${k}">${lbl}</button>`).join('')}
            </div>
            <div class="fnm-seg-group" role="group" aria-label="Poskytovateľ">
              <button type="button" class="fnm-seg${f.provider === 'all' ? ' is-active' : ''}" data-ws-prov="all">Všetci</button>
              ${providersPresent.map((p) => `<button type="button" class="fnm-seg${f.provider === p ? ' is-active' : ''}" data-ws-prov="${escapeHtml(p)}">${escapeHtml(providerLabel(p))}</button>`).join('')}
            </div>
            <select data-ws="sort" aria-label="Zoradenie">
              <option value="newest">Najnovšie</option>
              <option value="sizeDesc">Najväčšie</option>
              <option value="durationDesc">Najdlhšie</option>
              <option value="qualityDesc">Najvyššia kvalita</option>
              <option value="nameAsc">Názov A–Z</option>
              <option value="album">Podľa albumu</option>
              <option value="addedDesc">Naposledy pridané</option>
            </select>
            <div class="fnm-seg-group">
              ${[['grid', 'Grid'], ['compact', 'Compact'], ['list', 'List']].map(([k, lbl]) => `
                <button type="button" class="fnm-seg${store.prefs.layout === k ? ' is-active' : ''}" data-ws-layout="${k}">${lbl}</button>`).join('')}
            </div>
            <button type="button" class="fnm-btn" data-ws-act="toggle-aspect" title="Pomer strán náhľadov">${store.prefs.aspect}</button>
            <button type="button" class="fnm-btn${pageState.wsTabAdvanced ? ' is-active' : ''}" data-ws-act="toggle-adv">Filtre ▾</button>
          </div>

          <div class="fnm-ws-adv" ${pageState.wsTabAdvanced ? '' : 'hidden'}>
            <label>Min. kvalita
              <select data-ws-filter="minHeight">
                <option value="0">Bez minima</option>
                <option value="480">480p+</option>
                <option value="720">720p HD+</option>
                <option value="1080">1080p FHD+</option>
                <option value="1440">1440p+</option>
                <option value="2160">4K+</option>
              </select>
            </label>
            <label>Min. dĺžka (min)
              <input type="number" min="0" step="1" data-ws-filter="minDurationMin" value="${f.minDurationMin || ''}" placeholder="napr. 10">
            </label>
            <label>Min. veľkosť (MB)
              <input type="number" min="0" step="25" data-ws-filter="minSizeMb" value="${f.minSizeMb || ''}" placeholder="napr. 300">
            </label>
            <label>Stav
              <select data-ws-filter="status">
                <option value="all">Všetky</option>
                <option value="selected">Iba vybrané</option>
                <option value="unreviewed">Neprezreté</option>
                <option value="reviewed">Prezreté</option>
                <option value="hasMeta">S Deep metadátami</option>
              </select>
            </label>
            <button type="button" class="fnm-btn" data-ws-act="reset-filters">Reset filtrov</button>
          </div>

          <div class="fnm-ws-toolbar-row fnm-ws-bulk-row">
            <button type="button" class="fnm-btn" data-ws-act="select-all">${selectedVisibleAll ? `Zrušiť zobrazené (${filtered.length})` : `Vybrať zobrazené (${filtered.length})`}</button>
            <button type="button" class="fnm-btn" data-ws-act="invert-sel">Invertovať</button>
            <button type="button" class="fnm-btn" data-ws-act="duplicates">🔎 Duplicity</button>
            <button type="button" class="fnm-btn" data-ws-act="clear-sel" ${selectedSet.size ? '' : 'disabled'}>Zrušiť výber (${selectedSet.size})</button>
            <span class="fnm-spacer"></span>
            <button type="button" class="fnm-btn fnm-btn-accent" data-ws-act="deep-fetch" ${filtered.length ? '' : 'disabled'}>⚡ Deep Fetch (${selectedSet.size || filtered.length})</button>
            <button type="button" class="fnm-btn" data-ws-act="hd-thumbs" ${filtered.length ? '' : 'disabled'}>🖼 HD Thumbs</button>
            <button type="button" class="fnm-btn" data-ws-act="mark-reviewed" ${selectedSet.size ? '' : 'disabled'}>✓ Prezreté</button>
            <button type="button" class="fnm-btn fnm-btn-danger" data-ws-act="remove-selected" ${selectedSet.size ? '' : 'disabled'}>🗑 Odobrať (${selectedSet.size})</button>
          </div>
        </section>

        <div data-ws="progress"></div>

        <main class="fnm-ws-content">
          ${filtered.length
            ? `<div class="fnm-ws-grid layout-${store.prefs.layout}">${filtered.map((it) => renderWorkspaceCardHtml(it, selectedSet, reviewedSet)).join('')}</div>`
            : `<div class="fnm-empty-state">
                <h3>${album.items.length ? 'Žiadne položky nezodpovedajú filtrom.' : 'Tento virtuálny album je zatiaľ prázdny.'}</h3>
                <p>${album.items.length ? 'Skús upraviť hľadanie alebo stlačiť Reset filtrov.' : 'Označ albumy alebo súbory na stránkach Findr.to a klikni na „Spojiť do albumu“.'}</p>
              </div>`}
        </main>

        <footer class="fnm-ws-footer">
          <div class="fnm-ws-footer-info">
            Vybrané: <strong>${selectedSet.size}</strong> (${formatBytes(selectedBytes)}) · Aktívne zobrazenie: <strong>${filtered.length}</strong>
          </div>
          <div class="fnm-ws-footer-actions">
            <button type="button" class="fnm-btn fnm-btn-split" data-ws-act="split-open" ${filtered.some((i) => i.mediaType === 'video') ? '' : 'disabled'}>▦ Split-Screen (max 12)</button>
            <button type="button" class="fnm-btn" data-ws-act="split-picker" ${filtered.some((i) => i.mediaType === 'video') ? '' : 'disabled'}>▦ Split Picker</button>
            <button type="button" class="fnm-btn fnm-btn-primary" data-ws-act="import-nexus" ${album.items.length ? '' : 'disabled'}>⬇ Import do Nexus…</button>
            <button type="button" class="fnm-btn" data-ws-act="copy-urls" ${album.items.length ? '' : 'disabled'}>📋 Kopírovať URL</button>
            <button type="button" class="fnm-btn" data-ws-act="export-m3u8" ${filtered.some((i) => i.mediaType === 'video') ? '' : 'disabled'}>🎵 M3U8</button>
            <button type="button" class="fnm-btn" data-ws-act="export-json" ${album.items.length ? '' : 'disabled'}>💾 Export JSON</button>
            <button type="button" class="fnm-btn" data-ws-act="import-json">📥 Import JSON</button>
          </div>
        </footer>
      </div>`;

    ws.querySelector('[data-ws="sort"]').value = store.prefs.sort;
    ws.querySelector('[data-ws-filter="minHeight"]').value = String(f.minHeight || 0);
    ws.querySelector('[data-ws-filter="status"]').value = String(f.status || 'all');
    updateNexusStatusPills();
    paintProgress();

    // Bind events
    ws.querySelector('[data-ws="album-select"]').addEventListener('change', (e) => {
      store.activeAlbumId = e.currentTarget.value;
      pageState.wsFilters.sourceKeys = [];
      saveStore();
      decoratePageCards();
      updateDock();
      renderWorkspace();
    });

    const queryEl = ws.querySelector('[data-ws="query"]');
    queryEl.addEventListener('input', (e) => {
      pageState.wsFilters.query = e.currentTarget.value;
      // Zachovaj kurzor cez rýchle pre-renderovanie iba gridu
      renderWorkspaceGridOnly();
    });

    ws.querySelector('[data-ws="sort"]').addEventListener('change', (e) => {
      store.prefs.sort = e.currentTarget.value;
      saveStore();
      renderWorkspace();
    });

    ws.querySelectorAll('[data-ws-filter]').forEach((ctrl) => {
      ctrl.addEventListener('change', (e) => {
        const key = e.currentTarget.dataset.wsFilter;
        pageState.wsFilters[key] = key === 'status' ? e.currentTarget.value : (Number(e.currentTarget.value) || 0);
        renderWorkspace();
      });
    });

    ws.querySelectorAll('[data-ws-media]').forEach((b) => b.addEventListener('click', () => {
      pageState.wsFilters.mediaType = b.dataset.wsMedia;
      renderWorkspace();
    }));
    ws.querySelectorAll('[data-ws-prov]').forEach((b) => b.addEventListener('click', () => {
      pageState.wsFilters.provider = b.dataset.wsProv;
      renderWorkspace();
    }));
    ws.querySelectorAll('[data-ws-source]').forEach((b) => b.addEventListener('click', () => {
      const key = b.dataset.wsSource;
      const selected = new Set(pageState.wsFilters.sourceKeys);
      if (key === 'all') selected.clear();
      else if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      pageState.wsFilters.sourceKeys = [...selected];
      renderWorkspace();
    }));
    ws.querySelectorAll('[data-ws-remove-source]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const sKey = b.dataset.wsRemoveSource;
      removeSourceFromAlbum(album, sKey);
      pageState.wsFilters.sourceKeys = pageState.wsFilters.sourceKeys.filter((key) => key !== sKey);
      saveStore();
      decoratePageCards();
      updateDock();
      renderWorkspace();
    }));
    ws.querySelectorAll('[data-ws-layout]').forEach((b) => b.addEventListener('click', () => {
      store.prefs.layout = b.dataset.wsLayout;
      saveStore();
      renderWorkspace();
    }));
  }

  let wsLastCheckKey = '';
  function updateWorkspaceSelection() {
    const ws = document.getElementById('fnm-workspace');
    const album = getActiveAlbum();
    const selected = new Set(album.selectedIds);
    if (pageState.wsFilters.status === 'selected') {
      const scrollTop = ws.querySelector('.fnm-ws-content')?.scrollTop || 0;
      renderWorkspace();
      ws.querySelector('.fnm-ws-content').scrollTop = scrollTop;
      return;
    }
    const filtered = workspaceFilteredItems();
    ws.querySelectorAll('[data-ws-check]').forEach((checkbox) => {
      const checked = selected.has(checkbox.dataset.wsCheck);
      checkbox.checked = checked;
      checkbox.closest('[data-fnm-item-key]')?.classList.toggle('is-selected', checked);
    });
    const all = ws.querySelector('[data-ws-act="select-all"]');
    const allSelected = filtered.length > 0 && filtered.every((item) => selected.has(item.key));
    all.textContent = `${allSelected ? 'Zrušiť' : 'Vybrať'} zobrazené (${filtered.length})`;
    const clear = ws.querySelector('[data-ws-act="clear-sel"]');
    clear.textContent = `Zrušiť výber (${selected.size})`;
    clear.disabled = !selected.size;
    ws.querySelector('[data-ws-act="deep-fetch"]').textContent = `⚡ Deep Fetch (${selected.size || filtered.length})`;
    ws.querySelector('[data-ws-act="mark-reviewed"]').disabled = !selected.size;
    const remove = ws.querySelector('[data-ws-act="remove-selected"]');
    remove.textContent = `🗑 Odobrať (${selected.size})`;
    remove.disabled = !selected.size;
    const bytes = album.items.filter((item) => selected.has(item.key)).reduce((sum, item) => sum + (Number(item.sizeBytes) || 0), 0);
    ws.querySelector('.fnm-ws-footer-info').innerHTML = `Vybrané: <strong>${selected.size}</strong> (${formatBytes(bytes)}) · Aktívne zobrazenie: <strong>${filtered.length}</strong>`;
  }

  function handleWorkspaceChange(e) {
    const chk = e.target.closest?.('[data-ws-check]');
    if (!chk) return;
    const key = chk.dataset.wsCheck;
    const album = getActiveAlbum();
    const sel = new Set(album.selectedIds);
    if (chk.checked) sel.add(key);
    else sel.delete(key);
    album.selectedIds = [...sel];
    wsLastCheckKey = key;
    saveStore();
    updateWorkspaceSelection();
  }

  function handleWorkspaceClick(e) {
    const chk = e.target.closest?.('[data-ws-check]');
    const card = e.target.closest?.('[data-fnm-item-key]');
    if (e.ctrlKey && e.button === 0 && card && !e.target.closest('button, input, label')) {
      e.preventDefault();
      e.stopPropagation();
      const key = card.dataset.fnmItemKey;
      const album = getActiveAlbum();
      const selected = new Set(album.selectedIds);
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      album.selectedIds = [...selected];
      wsLastCheckKey = key;
      saveStore();
      updateWorkspaceSelection();
      return;
    }
    if (chk && e.shiftKey && wsLastCheckKey) {
      e.preventDefault();
      const filtered = workspaceFilteredItems();
      const a = filtered.findIndex((i) => i.key === wsLastCheckKey);
      const b = filtered.findIndex((i) => i.key === chk.dataset.wsCheck);
      if (a >= 0 && b >= 0) {
        const album = getActiveAlbum();
        const sel = new Set(album.selectedIds);
        const stateTarget = !sel.has(chk.dataset.wsCheck);
        for (const it of filtered.slice(Math.min(a, b), Math.max(a, b) + 1)) {
          if (stateTarget) sel.add(it.key);
          else sel.delete(it.key);
        }
        album.selectedIds = [...sel];
        wsLastCheckKey = chk.dataset.wsCheck;
        saveStore();
        // The browser restores a cancelled checkbox click after this handler.
        queueMicrotask(updateWorkspaceSelection);
        return;
      }
    }

    const revBtn = e.target.closest?.('[data-ws-review]');
    if (revBtn) {
      e.stopPropagation();
      const key = revBtn.dataset.wsReview;
      const album = getActiveAlbum();
      const rev = new Set(album.reviewedIds);
      if (rev.has(key)) rev.delete(key);
      else rev.add(key);
      album.reviewedIds = [...rev];
      saveStore();
      renderWorkspace();
      return;
    }

    const splitBtn = e.target.closest?.('[data-ws-split]');
    if (splitBtn) {
      e.stopPropagation();
      const key = splitBtn.dataset.wsSplit;
      const item = getActiveAlbum().items.find((i) => i.key === key);
      if (item) launchSplitScreen([item], 'open');
      return;
    }

    const prevBtn = e.target.closest?.('[data-ws-preview]');
    if (prevBtn && !e.target.closest('input, label, a, [data-ws-review], [data-ws-split]')) {
      const key = prevBtn.dataset.wsPreview;
      const filtered = workspaceFilteredItems();
      const idx = filtered.findIndex((i) => i.key === key);
      if (idx >= 0) openLightbox(filtered, idx);
      return;
    }

    const actBtn = e.target.closest?.('[data-ws-act]');
    if (!actBtn) return;
    const act = actBtn.dataset.wsAct;
    const album = getActiveAlbum();
    const filtered = workspaceFilteredItems();
    const selectedItems = album.items.filter((i) => album.selectedIds.includes(i.key));
    const actionPool = selectedItems.length ? selectedItems : filtered;

    switch (act) {
      case 'close':
        closeWorkspace();
        break;
      case 'ping-nexus':
        discoverNexusOrigin(true).then((o) => showToast(o ? `Nexus pripojený na ${o}` : 'Nexus nie je dostupný na portoch 8000–8003.', !o));
        break;
      case 'toggle-aspect':
        store.prefs.aspect = store.prefs.aspect === '16/9' ? '3/4' : '16/9';
        saveStore();
        renderWorkspace();
        break;
      case 'toggle-adv':
        pageState.wsTabAdvanced = !pageState.wsTabAdvanced;
        renderWorkspace();
        break;
      case 'reset-filters':
        pageState.wsFilters = { query: '', mediaType: 'all', provider: 'all', sourceKeys: [], status: 'all', minHeight: 0, minDurationMin: 0, minSizeMb: 0 };
        renderWorkspace();
        break;
      case 'new-album': {
        const name = prompt('Názov nového virtuálneho albumu:', `Findr Album #${store.albums.length + 1}`);
        if (!name || !name.trim()) break;
        const created = createVirtualAlbum(name.trim());
        store.albums.push(created);
        store.activeAlbumId = created.id;
        saveStore();
        decoratePageCards();
        updateDock();
        renderWorkspace();
        break;
      }
      case 'rename-album': {
        const name = prompt('Nový názov albumu:', album.name);
        if (!name || !name.trim()) break;
        album.name = name.trim();
        album.updatedAt = Date.now();
        saveStore();
        updateDock();
        renderWorkspace();
        break;
      }
      case 'dup-album': {
        const copy = createVirtualAlbum(`${album.name} (kópia)`);
        copy.items = album.items.map((i) => ({ ...i }));
        copy.sources = album.sources.map((s) => ({ ...s }));
        copy.reviewedIds = [...album.reviewedIds];
        store.albums.push(copy);
        store.activeAlbumId = copy.id;
        saveStore();
        renderWorkspace();
        break;
      }
      case 'del-album': {
        if (store.albums.length <= 1) break;
        if (!confirm(`Naozaj zmazať virtuálny album „${album.name}“?`)) break;
        store.albums = store.albums.filter((a) => a.id !== album.id);
        store.activeAlbumId = store.albums[0].id;
        saveStore();
        decoratePageCards();
        updateDock();
        renderWorkspace();
        break;
      }
      case 'add-url':
        openAddUrlModal();
        break;
      case 'select-all': {
        const sel = new Set(album.selectedIds);
        const allSel = filtered.length > 0 && filtered.every((i) => sel.has(i.key));
        for (const it of filtered) {
          if (allSel) sel.delete(it.key);
          else sel.add(it.key);
        }
        album.selectedIds = [...sel];
        saveStore();
        renderWorkspace();
        break;
      }
      case 'invert-sel': {
        const sel = new Set(album.selectedIds);
        for (const it of filtered) {
          if (sel.has(it.key)) sel.delete(it.key);
          else sel.add(it.key);
        }
        album.selectedIds = [...sel];
        saveStore();
        renderWorkspace();
        break;
      }
      case 'clear-sel':
        album.selectedIds = [];
        saveStore();
        renderWorkspace();
        break;
      case 'deep-fetch':
        runDeepFetch(actionPool);
        break;
      case 'hd-thumbs':
        runHdThumbFetch(actionPool);
        break;
      case 'duplicates':
        openDuplicateModal();
        break;
      case 'mark-reviewed': {
        const rev = new Set(album.reviewedIds);
        for (const it of selectedItems) rev.add(it.key);
        album.reviewedIds = [...rev];
        saveStore();
        renderWorkspace();
        break;
      }
      case 'remove-selected': {
        const removeSet = new Set(album.selectedIds);
        album.items = album.items.filter((i) => !removeSet.has(i.key));
        album.selectedIds = [];
        album.reviewedIds = album.reviewedIds.filter((k) => !removeSet.has(k));
        const usedSources = new Set(album.items.map((i) => i.sourceKey));
        album.sources = album.sources.filter((s) => usedSources.has(s.sourceKey)).map((s) => ({
          ...s,
          itemCount: album.items.filter((i) => i.sourceKey === s.sourceKey).length,
        }));
        album.updatedAt = Date.now();
        saveStore();
        decoratePageCards();
        updateDock();
        renderWorkspace();
        break;
      }
      case 'split-open':
        launchSplitScreen(actionPool, 'open');
        break;
      case 'split-picker':
        launchSplitScreen(actionPool, 'picker');
        break;
      case 'import-nexus':
        openImportModal(actionPool);
        break;
      case 'copy-urls':
        copyText(actionPool.map((i) => i.url).join('\n'));
        showToast(`Skopírovaných ${actionPool.length} URL.`);
        break;
      case 'export-m3u8': {
        const videos = actionPool.filter((i) => i.mediaType === 'video');
        downloadFile(`${slugify(album.name)}.m3u8`, buildM3U8Playlist(videos), 'audio/x-mpegurl');
        showToast(`Exportovaný M3U8 playlist (${videos.length} videí).`);
        break;
      }
      case 'export-json':
        downloadFile(`${slugify(album.name)}.json`, JSON.stringify({
          exportedAt: new Date().toISOString(),
          album,
        }, null, 2), 'application/json');
        showToast('Virtuálny album exportovaný do JSON.');
        break;
      case 'import-json':
        triggerJsonImport();
        break;
    }
  }

  function renderWorkspaceGridOnly() {
    const ws = document.getElementById('fnm-workspace');
    if (!ws) return;
    const main = ws.querySelector('.fnm-ws-content');
    if (!main) return;
    const album = getActiveAlbum();
    const filtered = workspaceFilteredItems();
    const selectedSet = new Set(album.selectedIds);
    const reviewedSet = new Set(album.reviewedIds);
    main.innerHTML = filtered.length
      ? `<div class="fnm-ws-grid layout-${store.prefs.layout}">${filtered.map((it) => renderWorkspaceCardHtml(it, selectedSet, reviewedSet)).join('')}</div>`
      : `<div class="fnm-empty-state"><h3>Žiadne položky nezodpovedajú hľadaniu.</h3></div>`;
  }

  // ---------------------------------------------------------------------------
  // 8. QUICK PEEK DRAWER, LIGHTBOX & MODÁLY
  // ---------------------------------------------------------------------------
  async function openPeekDrawer(albumCard) {
    const drawer = document.getElementById('fnm-peek');
    if (!drawer) return;
    drawer.hidden = false;
    drawer.innerHTML = `
      <div class="fnm-peek-panel">
        <div class="fnm-peek-head">
          <div>
            <span class="fnm-kicker">Quick Peek · ${escapeHtml(providerLabel(albumCard.provider))}</span>
            <h3>${escapeHtml(albumCard.title)}</h3>
          </div>
          <button type="button" class="fnm-close-btn" data-peek-close>✕</button>
        </div>
        <div class="fnm-peek-body"><p class="fnm-muted">Načítavam zoznam súborov z Findr API…</p></div>
      </div>`;
    drawer.querySelector('[data-peek-close]').addEventListener('click', () => { drawer.hidden = true; });
    drawer.onclick = (e) => { if (e.target === drawer) drawer.hidden = true; };

    try {
      const { meta, items } = await fetchFindrAlbumFiles(albumCard);
      const selectedKeys = new Set();
      const body = drawer.querySelector('.fnm-peek-body');
      if (!body) return;
      body.innerHTML = `
        <div class="fnm-peek-bar">
          <span><strong>${items.length}</strong> súborov · ${formatBytes(meta.sizeBytes || items.reduce((s, i) => s + (i.sizeBytes || 0), 0))}</span>
          <div class="fnm-peek-actions">
            <button type="button" class="fnm-btn fnm-btn-primary" data-peek-add-all>+ Pridať celý album</button>
            <button type="button" class="fnm-btn" data-peek-add-sel disabled>+ Vybrané (0)</button>
            <button type="button" class="fnm-btn fnm-btn-split" data-peek-split>▦ Split-Screen</button>
          </div>
        </div>
        <div class="fnm-peek-list">
          ${items.map((it, idx) => `
            <div class="fnm-peek-item" data-peek-idx="${idx}">
              <input type="checkbox" data-peek-chk="${escapeHtml(it.key)}">
              <div class="fnm-peek-thumb">${it.thumbnail ? `<img loading="lazy" src="${escapeHtml(it.thumbnail)}" alt="">` : `<span>${it.mediaType === 'image' ? 'IMG' : 'VID'}</span>`}</div>
              <div class="fnm-peek-info">
                <div class="fnm-peek-name" title="${escapeHtml(it.title)}">${escapeHtml(it.title)}</div>
                <div class="fnm-peek-meta">${it.mediaType.toUpperCase()} · ${formatBytes(it.sizeBytes)}</div>
              </div>
              <a href="${escapeHtml(it.url)}" target="_blank" rel="noopener" class="fnm-icon-btn" title="Otvoriť zdroj">↗</a>
            </div>`).join('')}
        </div>`;

      const selBtn = body.querySelector('[data-peek-add-sel]');
      body.querySelectorAll('[data-peek-chk]').forEach((chk) => {
        chk.addEventListener('change', (e) => {
          if (e.currentTarget.checked) selectedKeys.add(e.currentTarget.dataset.peekChk);
          else selectedKeys.delete(e.currentTarget.dataset.peekChk);
          selBtn.disabled = selectedKeys.size === 0;
          selBtn.textContent = `+ Vybrané (${selectedKeys.size})`;
        });
      });
      body.querySelectorAll('.fnm-peek-thumb').forEach((thumbEl) => {
        thumbEl.addEventListener('click', () => {
          const idx = Number(thumbEl.closest('[data-peek-idx]').dataset.peekIdx);
          openLightbox(items, idx);
        });
      });
      body.querySelector('[data-peek-add-all]').addEventListener('click', () => {
        const album = getActiveAlbum();
        const res = mergeItemsIntoAlbum(album, items, meta);
        saveStore();
        decoratePageCards();
        updateDock();
        showToast(`Pridaný album „${meta.title}“ (+${res.added} nových).`);
        drawer.hidden = true;
      });
      selBtn.addEventListener('click', () => {
        const album = getActiveAlbum();
        const chosen = items.filter((i) => selectedKeys.has(i.key));
        const res = mergeItemsIntoAlbum(album, chosen, meta);
        saveStore();
        decoratePageCards();
        updateDock();
        showToast(`Pridaných ${res.added} vybraných súborov z „${meta.title}“.`);
        drawer.hidden = true;
      });
      body.querySelector('[data-peek-split]').addEventListener('click', () => {
        const chosen = selectedKeys.size ? items.filter((i) => selectedKeys.has(i.key)) : items;
        launchSplitScreen(chosen, chosen.length > 12 ? 'picker' : 'open');
      });
    } catch (err) {
      const body = drawer.querySelector('.fnm-peek-body');
      if (body) body.innerHTML = `<p class="fnm-error">Nepodarilo sa načítať obsah albumu: ${escapeHtml(err.message || err)}</p>`;
    }
  }

  async function openLightbox(items, index) {
    if (!items || !items.length) return;
    pageState.lightboxItems = items;
    pageState.lightboxIndex = Math.max(0, Math.min(index, items.length - 1));
    renderLightbox();
  }

  async function renderLightbox() {
    const lb = document.getElementById('fnm-lightbox');
    if (!lb) return;
    const item = pageState.lightboxItems[pageState.lightboxIndex];
    if (!item) { lb.hidden = true; return; }
    lb.hidden = false;

    const album = getActiveAlbum();
    const isSel = album.selectedIds.includes(item.key);
    const isRev = album.reviewedIds.includes(item.key);

    lb.innerHTML = `
      <div class="fnm-lb-shell">
        <div class="fnm-lb-top">
          <div class="fnm-lb-title">
            <strong>${escapeHtml(item.title)}</strong>
            <span>${pageState.lightboxIndex + 1} / ${pageState.lightboxItems.length} · ${escapeHtml(item.albumTitle)} · ${formatBytes(item.sizeBytes)}</span>
          </div>
          <div class="fnm-lb-tools">
            <button type="button" class="fnm-btn${isSel ? ' is-active' : ''}" data-lb-act="toggle-sel">${isSel ? '✓ Vybrané' : 'Vybrať'} (Space)</button>
            <button type="button" class="fnm-btn${isRev ? ' is-active' : ''}" data-lb-act="toggle-rev">${isRev ? '✓ Prezreté' : 'Prezreté'} (R)</button>
            ${item.mediaType === 'video' ? '<button type="button" class="fnm-btn fnm-btn-split" data-lb-act="split">▦ Split-Screen</button>' : ''}
            <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" class="fnm-btn">Zdroj ↗</a>
            <button type="button" class="fnm-close-btn" data-lb-act="close">✕</button>
          </div>
        </div>
        <div class="fnm-lb-stage">
          <button type="button" class="fnm-lb-nav prev" data-lb-act="prev" ${pageState.lightboxIndex <= 0 ? 'disabled' : ''}>‹</button>
          <div class="fnm-lb-media" data-lb-media>
            ${item.mediaType === 'image'
              ? `<img src="${escapeHtml(item.streamUrl || item.url || item.thumbnail)}" alt="">`
              : `<div class="fnm-lb-loading">Pripravujem video stream…</div>`}
          </div>
          <button type="button" class="fnm-lb-nav next" data-lb-act="next" ${pageState.lightboxIndex >= pageState.lightboxItems.length - 1 ? 'disabled' : ''}>›</button>
        </div>
      </div>`;

    lb.onclick = (e) => {
      if (e.target === lb) { lb.hidden = true; lb.innerHTML = ''; }
    };
    lb.querySelector('[data-lb-act="close"]').addEventListener('click', () => { lb.hidden = true; lb.innerHTML = ''; });
    lb.querySelector('[data-lb-act="prev"]').addEventListener('click', () => {
      if (pageState.lightboxIndex > 0) { pageState.lightboxIndex -= 1; renderLightbox(); }
    });
    lb.querySelector('[data-lb-act="next"]').addEventListener('click', () => {
      if (pageState.lightboxIndex < pageState.lightboxItems.length - 1) { pageState.lightboxIndex += 1; renderLightbox(); }
    });
    lb.querySelector('[data-lb-act="toggle-sel"]').addEventListener('click', () => {
      const s = new Set(album.selectedIds);
      if (s.has(item.key)) s.delete(item.key);
      else s.add(item.key);
      album.selectedIds = [...s];
      saveStore();
      renderLightbox();
      if (pageState.workspaceOpen) renderWorkspace();
    });
    lb.querySelector('[data-lb-act="toggle-rev"]').addEventListener('click', () => {
      const r = new Set(album.reviewedIds);
      if (r.has(item.key)) r.delete(item.key);
      else r.add(item.key);
      album.reviewedIds = [...r];
      saveStore();
      renderLightbox();
      if (pageState.workspaceOpen) renderWorkspace();
    });
    lb.querySelector('[data-lb-act="split"]')?.addEventListener('click', () => launchSplitScreen([item], 'open'));

    if (item.mediaType !== 'image') {
      const mediaBox = lb.querySelector('[data-lb-media]');
      let streamSrc = item.streamUrl || '';
      if (!streamSrc) {
        const origin = await discoverNexusOrigin();
        if (origin) {
          try {
            const res = await nexusRequest(`${origin}/api/tester/batch-meta`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ urls: [item.url], metadata_only: false, full_metadata: true }),
              timeout: 25000,
            });
            if (res.ok) {
              const data = JSON.parse(res.text || '{}');
              const row = (data.results || [])[0];
              if (row?.stream_url || row?.cdn_url) {
                streamSrc = row.stream_url || row.cdn_url;
                applyFetchedMetadata(item, row);
                saveStore();
              }
            }
          } catch {}
          if (!streamSrc) {
            try {
              const res = await nexusRequest(`${origin}/api/v1/discovery-hub/stream?url=${encodeURIComponent(item.url)}`);
              if (res.ok) {
                const data = JSON.parse(res.text || '{}');
                if (data.stream_url) {
                  streamSrc = data.stream_url;
                  item.streamUrl = streamSrc;
                  saveStore();
                }
              }
            } catch {}
          }
        }
      }
      if (!mediaBox.isConnected) return;
      if (streamSrc) {
        mediaBox.innerHTML = `<video controls autoplay playsinline src="${escapeHtml(streamSrc)}" poster="${escapeHtml(item.thumbnail || '')}"></video>`;
      } else {
        mediaBox.innerHTML = `
          <div class="fnm-lb-fallback">
            ${item.thumbnail ? `<img src="${escapeHtml(item.thumbnail)}" alt="">` : ''}
            <p>Priamy stream sa nepodarilo získať (skontroluj lokálny Nexus server alebo použi Split-Screen).</p>
            <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
              <button type="button" class="fnm-btn fnm-btn-split" id="fnm-lb-split-fallback">▦ Spustiť v Split-Screene</button>
              <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" class="fnm-btn fnm-btn-primary">Otvoriť originál ↗</a>
            </div>
          </div>`;
        mediaBox.querySelector('#fnm-lb-split-fallback')?.addEventListener('click', () => launchSplitScreen([item], 'open'));
      }
    }
  }

  function openAddUrlModal() {
    const modal = document.getElementById('fnm-modal');
    if (!modal) return;
    modal.hidden = false;
    modal.innerHTML = `
      <div class="fnm-modal-card">
        <h3>+ Pridať albumy alebo súbory podľa URL</h3>
        <p class="fnm-muted">Vlož jeden alebo viac odkazov (každý na nový riadok): <code>findr.to/albums/...</code>, Bunkr album/súbor, alebo Turbo odkaz.</p>
        <textarea id="fnm-url-input" rows="6" placeholder="https://findr.to/albums/12345&#10;https://bunkr.cr/f/...&#10;https://turbo.cr/v/..."></textarea>
        <div class="fnm-modal-acts">
          <button type="button" class="fnm-btn" data-modal-close>Zrušiť</button>
          <button type="button" class="fnm-btn fnm-btn-primary" id="fnm-url-submit">Pridať do albumu</button>
        </div>
      </div>`;
    modal.querySelector('[data-modal-close]').addEventListener('click', () => { modal.hidden = true; });
    modal.querySelector('#fnm-url-submit').addEventListener('click', async () => {
      const lines = (modal.querySelector('#fnm-url-input').value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (!lines.length) return;
      modal.hidden = true;
      const album = getActiveAlbum();
      let added = 0;
      for (const line of lines) {
        const albId = extractAlbumId(line);
        if (albId) {
          try {
            const { meta, items } = await fetchFindrAlbumFiles(albId);
            added += mergeItemsIntoAlbum(album, items, meta).added;
          } catch {}
        } else {
          const item = normalizeFindrFileEntry({ url: line });
          if (item) added += mergeItemsIntoAlbum(album, [item]).added;
        }
      }
      saveStore();
      updateDock();
      if (pageState.workspaceOpen) renderWorkspace();
      showToast(`Pridaných ${added} položiek z vložených URL.`);
    });
  }

  async function duplicateImageHash(url) {
    if (!/^https?:\/\//i.test(url || '')) return null;
    let blob;
    try {
      if (gmRequest) {
        blob = await new Promise((resolve) => gmRequest({ method: 'GET', url, responseType: 'blob', timeout: 10000,
          onload: (r) => resolve(r.status >= 200 && r.status < 300 && r.response instanceof Blob ? r.response : null),
          onerror: () => resolve(null), ontimeout: () => resolve(null) }));
      } else {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try { const res = await fetch(url, { signal: controller.signal }); blob = res.ok ? await res.blob() : null; }
        finally { clearTimeout(timeout); }
      }
      if (!blob || !blob.type.startsWith('image/')) return null;
      const bitmap = await createImageBitmap(blob);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 9; canvas.height = 8;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0, 9, 8);
        const data = ctx.getImageData(0, 0, 9, 8).data, bits = [], color = [0, 0, 0], lum = [];
        for (let i = 0; i < 72; i++) {
          for (let c = 0; c < 3; c++) color[c] += data[i * 4 + c] / 72;
          lum.push(data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114);
        }
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push(lum[y * 9 + x] > lum[y * 9 + x + 1]);
        return { bits, color, contrast: Math.max(...lum) - Math.min(...lum) };
      } finally { bitmap.close(); }
    } catch { return null; }
  }

  let duplicateScanToken = 0;
  async function openDuplicateModal(cachedHashes = null) {
    const modal = document.getElementById('fnm-modal');
    const album = getActiveAlbum();
    const token = ++duplicateScanToken;
    modal.hidden = false;
    let hashes = cachedHashes;
    if (!hashes) {
      hashes = new Map();
      const candidates = album.items.filter((item) => item.mediaType === 'video' && (Number(item.duration) > 0 || Number(item.sizeBytes) > 0) && (item.thumbnail || item.storyboardUrl));
      modal.innerHTML = `<div class="fnm-modal-card"><h3>🔎 Kontrola duplicít</h3><p data-dup-progress>Porovnávam náhľady: 0 / ${candidates.length}</p><button type="button" class="fnm-btn" data-modal-close>Zrušiť</button></div>`;
      modal.querySelector('[data-modal-close]').addEventListener('click', () => { duplicateScanToken++; modal.hidden = true; });
      let next = 0, done = 0;
      const imageCache = new Map();
      const worker = async () => {
        while (token === duplicateScanToken && next < candidates.length) {
          const item = candidates[next++];
          const url = item.thumbnail || item.storyboardUrl;
          if (!imageCache.has(url)) imageCache.set(url, duplicateImageHash(url));
          let hash = await imageCache.get(url);
          if (!hash && item.storyboardUrl && item.storyboardUrl !== url) {
            if (!imageCache.has(item.storyboardUrl)) imageCache.set(item.storyboardUrl, duplicateImageHash(item.storyboardUrl));
            hash = await imageCache.get(item.storyboardUrl);
          }
          if (hash) hashes.set(item.key, hash);
          done++;
          if (token === duplicateScanToken) modal.querySelector('[data-dup-progress]').textContent = `Porovnávam náhľady: ${done} / ${candidates.length}`;
        }
      };
      await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, () => worker()));
      if (token !== duplicateScanToken || modal.hidden || getActiveAlbum() !== album) return;
    }
    const groups = findDuplicateGroups(album.items, hashes);
    modal.innerHTML = `<div class="fnm-modal-card fnm-duplicate-modal">
      <h3>🔎 Kontrola duplicít · ${escapeHtml(album.name)}</h3>
      <p class="fnm-muted">Prehľad celého albumu: ${groups.length} skupín možných duplicít. Porovnané náhľady: ${hashes.size}. Zhody sú odhad podľa názvu, dĺžky, veľkosti a podobnosti náhľadov, nie overenie obsahu videa. Označ skupiny až po kontrole. Odporúčame najvyššie známe rozlíšenie a potom väčší súbor.</p>
      <div class="fnm-duplicate-list">${groups.length ? groups.map((group, index) => `
        <fieldset class="fnm-duplicate-group">
          <legend><label><input type="checkbox" data-dup-enabled="${index}"> Skupina ${index + 1} · odstrániť ${group.length - 1}</label></legend>
          ${group.map((item, i) => `<label class="fnm-duplicate-item"><input type="radio" name="fnm-dup-${index}" value="${i}" ${i === 0 ? 'checked' : ''}>${item.thumbnail || item.storyboardUrl ? `<img src="${escapeHtml(item.thumbnail || item.storyboardUrl)}" alt="" loading="lazy">` : ''}<span><strong>${i === 0 ? 'Odporúčané · ' : ''}${escapeHtml(item.title || item.filename || item.url)}</strong><br>${escapeHtml(item.albumTitle || 'Neznámy zdroj')} · ${escapeHtml(qualityLabel(item) || 'neznáma kvalita')} · ${escapeHtml(formatBytes(item.sizeBytes))} · ${escapeHtml(formatDuration(item.duration) || 'neznáma dĺžka')}<br><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">Otvoriť zdroj</a></span></label>`).join('')}
        </fieldset>`).join('') : '<p class="fnm-muted">Nenašli sa dostatočne podobné videá. Chýbajúce metadáta môžu zabrániť detekcii.</p>'}</div>
      <div class="fnm-modal-acts">
        ${album.duplicateUndo ? '<button type="button" class="fnm-btn" data-dup-undo>↶ Obnoviť naposledy odstránené</button>' : ''}
        <button type="button" class="fnm-btn" data-modal-close>Zavrieť</button>
        ${groups.length ? '<button type="button" class="fnm-btn fnm-btn-danger" data-dup-remove>Odstrániť zvolené duplicity</button>' : ''}
      </div></div>`;
    modal.querySelector('[data-modal-close]').addEventListener('click', () => { modal.hidden = true; });
    modal.querySelector('[data-dup-remove]')?.addEventListener('click', () => {
      const choices = groups.map((items, index) => ({ items, index })).filter(({ index }) => modal.querySelector(`[data-dup-enabled="${index}"]`).checked).map(({ items, index }) => ({ items, keeperKey: items[Number(modal.querySelector(`input[name="fnm-dup-${index}"]:checked`).value)].key }));
      const count = removeDuplicateGroups(album, choices);
      if (!count) { showToast('Nevybral si žiadne skupiny.', true); return; }
      saveStore(); decoratePageCards(); updateDock(); renderWorkspace();
      showToast(`Odstránených ${count} duplicít. Obnovenie nájdeš v kontrole duplicít.`);
      openDuplicateModal(hashes);
    });
    modal.querySelector('[data-dup-undo]')?.addEventListener('click', () => {
      const count = undoDuplicateRemoval(album);
      saveStore(); decoratePageCards(); updateDock(); renderWorkspace();
      showToast(`Obnovených ${count} položiek.`);
      openDuplicateModal(hashes);
    });
  }

  function openImportModal(items) {
    if (!items || !items.length) return;
    const modal = document.getElementById('fnm-modal');
    if (!modal) return;
    const album = getActiveAlbum();
    modal.hidden = false;
    modal.innerHTML = `
      <div class="fnm-modal-card">
        <h3>Odoslať do Nexus Import Desku</h3>
        <p class="fnm-muted">Pripravených <strong>${items.length}</strong> položiek (${formatBytes(items.reduce((s, i) => s + (i.sizeBytes || 0), 0))}).</p>
        <label class="fnm-field">Nexus Port
          <select id="fnm-imp-port">
            ${NEXUS_PORTS.map((p) => `<option value="${p}" ${Number(store.prefs.port) === p ? 'selected' : ''}>http://localhost:${p}</option>`).join('')}
          </select>
        </label>
        <label class="fnm-field">Názov batchu
          <input type="text" id="fnm-imp-batch" value="${escapeHtml(album.name)}">
        </label>
        <label class="fnm-field">Tagy (oddelené čiarkou)
          <input type="text" id="fnm-imp-tags" value="findr, virtual-album">
        </label>
        <label class="fnm-check-inline">
          <input type="checkbox" id="fnm-imp-board">
          <span>Uložiť zdrojové Findr albumy aj ako Source Board v Nexuse</span>
        </label>
        <div id="fnm-imp-status" class="fnm-muted"></div>
        <div class="fnm-modal-acts">
          <button type="button" class="fnm-btn" data-modal-close>Zavrieť</button>
          <button type="button" class="fnm-btn fnm-btn-primary" id="fnm-imp-send">Importovať ${items.length} položiek</button>
        </div>
      </div>`;
    modal.querySelector('[data-modal-close]').addEventListener('click', () => { modal.hidden = true; });
    modal.querySelector('#fnm-imp-send').addEventListener('click', async () => {
      const btn = modal.querySelector('#fnm-imp-send');
      const status = modal.querySelector('#fnm-imp-status');
      const port = Number(modal.querySelector('#fnm-imp-port').value || 8000);
      const batchName = (modal.querySelector('#fnm-imp-batch').value || album.name).trim();
      const extraTags = (modal.querySelector('#fnm-imp-tags').value || '').split(',').map((t) => t.trim()).filter(Boolean);
      const saveBoard = modal.querySelector('#fnm-imp-board').checked;

      store.prefs.port = port;
      saveStore();
      btn.disabled = true;
      status.textContent = 'Odosielam frontu do Nexus…';

      const origin = `http://127.0.0.1:${port}`;
      const candidates = items.map((it) => ({
        url: it.url,
        source_url: it.url,
        title: it.title || it.filename,
        thumbnail: it.storyboardUrl || it.thumbnail || '',
        duration: Number(it.duration || 0) || 0,
        size_bytes: Number(it.sizeBytes || 0) || 0,
        quality: qualityLabel(it),
        upload_date: it.createdAt || '',
        source: it.provider === 'turbo' ? 'turbo.cr' : 'findr.to',
        tags: [...new Set([...extraTags, it.provider, it.albumTitle].filter(Boolean))],
      }));

      try {
        const res = await nexusRequest(`${origin}/api/v1/intake/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            batch_name: batchName,
            candidates,
            source_mode: 'findr',
            auto_metadata: true,
            playwright_fallback: true,
          }),
        });
        const data = JSON.parse(res.text || '{}');
        if (!res.ok || !data.job?.id) throw new Error(data.detail || `Nexus HTTP ${res.status}`);

        if (saveBoard && album.sources.length) {
          for (const src of album.sources.filter((s) => s.findrUrl)) {
            await nexusRequest(`${origin}/api/v1/source-boards`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: `Findr · ${src.title}`.slice(0, 120),
                source_url: src.findrUrl,
                source_type: 'findr',
                batch_name: batchName,
                description: `Pridané z Findr Nexus Manager (${album.name})`,
                color: '#3b82f6',
                pinned: true,
              }),
            }).catch(() => {});
          }
        }

        status.innerHTML = `<span style="color:#34d399">✓ Import job #${data.job.id} prijatý (${data.job.total_items ?? items.length} položiek). <a href="${origin}/" target="_blank" rel="noopener" style="color:#60a5fa;text-decoration:underline">Otvoriť Nexus</a></span>`;
        btn.textContent = 'Odoslané ✓';
        showToast(`Nexus prijal Import job #${data.job.id}.`);
      } catch (err) {
        status.innerHTML = `<span style="color:#f87171">${escapeHtml(err.message || err)}</span>`;
        btn.disabled = false;
      }
    });
  }

  function copyText(text) {
    if (typeof GM_setClipboard === 'function') {
      try { GM_setClipboard(text); return; } catch {}
    }
    navigator.clipboard?.writeText(text).catch(() => {});
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 25000);
  }

  function slugify(str) {
    return String(str || 'findr-album').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'findr-album';
  }

  function triggerJsonImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const imported = parsed.album || parsed;
        if (!Array.isArray(imported.items)) throw new Error('Neplatný formát JSON zálohy.');
        const created = createVirtualAlbum(imported.name ? `${imported.name} (import)` : 'Importovaný album');
        mergeItemsIntoAlbum(created, imported.items);
        store.albums.push(created);
        store.activeAlbumId = created.id;
        saveStore();
        updateDock();
        renderWorkspace();
        showToast(`Importovaný album „${created.name}“ (${created.items.length} položiek).`);
      } catch (err) {
        showToast(`Import JSON zlyhal: ${err.message || err}`, true);
      }
    });
    input.click();
  }

  // ---------------------------------------------------------------------------
  // 9. INICIALIZÁCIA ROOT UI, ŠTÝLY & SPA HOOKS
  // ---------------------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById('fnm-styles')) return;
    const style = document.createElement('style');
    style.id = 'fnm-styles';
    style.textContent = `
      :root { --fnm-bg:#090d16; --fnm-panel:#111827; --fnm-card:#151e30; --fnm-border:rgba(148,163,184,0.18); --fnm-blue:#3b82f6; --fnm-cyan:#06b6d4; --fnm-violet:#8b5cf6; --fnm-green:#10b981; --fnm-red:#ef4444; --fnm-text:#f1f5f9; --fnm-muted:#94a3b8; }
      html.fnm-ws-open { overflow:hidden!important; }
      .fnm-card { transition: box-shadow .15s ease, outline .15s ease; }
      .fnm-card.fnm-selected { outline: 2.5px solid var(--fnm-cyan)!important; outline-offset: 2px; box-shadow: 0 0 22px rgba(6,182,212,0.28)!important; }
      .fnm-card.fnm-in-album:not(.fnm-selected) { outline: 1.5px solid rgba(16,185,129,0.55); outline-offset: 1px; }
      .fnm-card-overlay { position:absolute; top:8px; left:8px; right:8px; z-index:25; display:flex; justify-content:space-between; align-items:center; gap:6px; pointer-events:none; }
      .fnm-card-overlay.is-compact-bah { justify-content:flex-end; top:44px; }
      .fnm-check-pill { pointer-events:auto; display:inline-flex; align-items:center; gap:6px; padding:4px 9px; border-radius:999px; background:rgba(9,13,22,0.86); border:1px solid rgba(148,163,184,0.32); color:#e2e8f0; font:700 11px/1 system-ui,sans-serif; cursor:pointer; backdrop-filter:blur(8px); user-select:none; }
      .fnm-check-pill input { width:15px; height:15px; accent-color:var(--fnm-cyan); margin:0; cursor:pointer; }
      .fnm-card.fnm-selected .fnm-check-pill { background:rgba(6,182,212,0.92); border-color:#67e8f9; color:#042028; }
      .fnm-card-quick { pointer-events:auto; display:inline-flex; align-items:center; gap:4px; opacity:.88; transition:opacity .15s ease; }
      .fnm-card:hover .fnm-card-quick, .fnm-card.fnm-selected .fnm-card-quick, .fnm-card.fnm-in-album .fnm-card-quick { opacity:1; }
      .fnm-qbtn { border:1px solid rgba(148,163,184,0.28); border-radius:999px; background:rgba(9,13,22,0.88); color:#f1f5f9; padding:5px 9px; font:700 11px/1 system-ui,sans-serif; cursor:pointer; backdrop-filter:blur(8px); }
      .fnm-qbtn:hover { border-color:var(--fnm-blue); background:#1e293b; }
      .fnm-qbtn-add.is-saved { background:rgba(16,185,129,0.9); border-color:#6ee7b7; color:#032219; }
      .fnm-qbtn-split { border-color:rgba(139,92,246,0.55); color:#e9d5ff; }

      /* Command Dock */
      #fnm-dock { position:fixed; z-index:2147483000; left:50%; bottom:16px; transform:translateX(-50%); display:flex; align-items:center; gap:8px; flex-wrap:wrap; max-width:calc(100vw - 24px); padding:9px 12px; border-radius:16px; background:rgba(11,17,29,0.94); border:1px solid rgba(59,130,246,0.42); box-shadow:0 20px 55px rgba(0,0,0,0.78), 0 0 24px rgba(59,130,246,0.18); backdrop-filter:blur(16px); color:var(--fnm-text); font:600 12px/1.2 system-ui,sans-serif; }
      #fnm-dock.is-collapsed .fnm-dock-expand { display:none; }
      .fnm-dock-title { display:inline-flex; align-items:center; gap:7px; color:#93c5fd; font-weight:800; letter-spacing:-.01em; }
      .fnm-dock-count { padding:4px 8px; border-radius:8px; background:rgba(30,41,59,0.9); color:#cbd5e1; font-variant-numeric:tabular-nums; }
      .fnm-btn, #fnm-dock button { border:1px solid var(--fnm-border); border-radius:9px; background:#1a2438; color:#e2e8f0; padding:7px 11px; font:600 12px/1.1 system-ui,sans-serif; cursor:pointer; transition:background .15s, border-color .15s, transform .1s; white-space:nowrap; }
      .fnm-btn:hover, #fnm-dock button:hover { background:#23314c; border-color:rgba(148,163,184,0.4); }
      .fnm-btn:disabled, #fnm-dock button:disabled { opacity:.42; cursor:not-allowed; }
      .fnm-btn-primary, #fnm-dock .fnm-btn-primary { background:linear-gradient(135deg,#2563eb,#0891b2); border-color:rgba(125,211,252,0.45); color:#fff; }
      .fnm-btn-split, #fnm-dock .fnm-btn-split { background:linear-gradient(135deg,#7c3aed,#db2777); border-color:rgba(244,114,182,0.45); color:#fff; }
      .fnm-btn-accent { background:#134e4a; border-color:#2dd4bf; color:#ccfbf1; }
      .fnm-btn-danger { background:rgba(127,29,29,0.55); border-color:rgba(248,113,113,0.45); color:#fecaca; }
      .fnm-btn.is-active, .fnm-seg.is-active { background:var(--fnm-blue); border-color:#93c5fd; color:#fff; }
      .fnm-close-btn { border:1px solid var(--fnm-border); border-radius:9px; background:#1e293b; color:#cbd5e1; width:34px; height:34px; font-size:16px; cursor:pointer; display:grid; place-items:center; }
      .fnm-close-btn:hover { background:rgba(239,68,68,0.22); color:#fca5a5; border-color:#f87171; }
      .fnm-status-pill { border:1px solid var(--fnm-border); border-radius:999px; background:#0f172a; color:#94a3b8; padding:6px 11px; font:700 11px system-ui,sans-serif; cursor:pointer; }
      .fnm-status-pill[data-online="true"] { border-color:rgba(16,185,129,0.5); color:#6ee7b7; background:rgba(6,78,59,0.45); }

      /* Workspace Overlay */
      #fnm-workspace { position:fixed; inset:0; z-index:2147483002; background:rgba(6,9,17,0.96); backdrop-filter:blur(18px); color:var(--fnm-text); font-family:system-ui,-apple-system,sans-serif; display:flex; flex-direction:column; }
      #fnm-workspace[hidden], #fnm-peek[hidden], #fnm-lightbox[hidden], #fnm-modal[hidden] { display:none!important; }
      .fnm-ws-shell { display:flex; flex-direction:column; height:100%; width:100%; overflow:hidden; }
      .fnm-ws-header { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; padding:12px 20px; background:#0d1424; border-bottom:1px solid var(--fnm-border); }
      .fnm-ws-brand, .fnm-ws-head-right { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .fnm-logo-badge { padding:5px 10px; border-radius:8px; background:linear-gradient(135deg,#2563eb,#7c3aed); font:800 12px system-ui,sans-serif; letter-spacing:.02em; color:#fff; }
      .fnm-ws-header select, .fnm-ws-toolbar select, .fnm-ws-toolbar input, .fnm-modal-card input, .fnm-modal-card select, .fnm-modal-card textarea { border:1px solid var(--fnm-border); border-radius:9px; background:#141d30; color:#f1f5f9; padding:7px 11px; font:600 12px system-ui,sans-serif; }
      .fnm-ws-stats-strip { display:flex; flex-direction:column; gap:8px; padding:10px 20px; background:#0b101d; border-bottom:1px solid var(--fnm-border); }
      .fnm-stat-chips { display:flex; gap:14px; flex-wrap:wrap; font-size:12px; color:var(--fnm-muted); font-variant-numeric:tabular-nums; }
      .fnm-stat strong { color:#fff; }
      .fnm-source-strip { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
      .fnm-source-chip { display:inline-flex; align-items:center; border:1px solid var(--fnm-border); border-radius:999px; background:#131c2e; overflow:hidden; font-size:11px; }
      .fnm-source-chip.is-active { border-color:var(--fnm-cyan); background:#0f293a; }
      button.fnm-source-chip { padding:4px 10px; color:#cbd5e1; cursor:pointer; }
      button.fnm-source-chip.is-active { color:#67e8f9; font-weight:700; }
      .fnm-source-chip-main { border:0; background:transparent; color:#cbd5e1; padding:4px 8px 4px 10px; font:600 11px system-ui,sans-serif; cursor:pointer; }
      .fnm-source-chip-main em { font-style:normal; color:var(--fnm-muted); }
      .fnm-source-chip-x { border:0; background:transparent; color:#94a3b8; padding:4px 8px 4px 2px; font-weight:800; cursor:pointer; }
      .fnm-source-chip-x:hover { color:#f87171; }

      .fnm-ws-toolbar { padding:10px 20px; background:#0f1627; border-bottom:1px solid var(--fnm-border); display:flex; flex-direction:column; gap:8px; }
      .fnm-ws-toolbar-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .fnm-search-input { flex:1; min-width:210px; }
      .fnm-seg-group { display:inline-flex; border:1px solid var(--fnm-border); border-radius:9px; overflow:hidden; background:#141d30; }
      .fnm-seg { border:0; border-right:1px solid var(--fnm-border); background:transparent; color:#cbd5e1; padding:7px 10px; font:600 11px system-ui,sans-serif; cursor:pointer; }
      .fnm-seg:last-child { border-right:0; }
      .fnm-ws-adv { display:flex; align-items:end; gap:12px; flex-wrap:wrap; padding:8px 12px; border-radius:10px; background:#0a101d; border:1px solid var(--fnm-border); }
      .fnm-ws-adv label { display:grid; gap:4px; font:700 11px system-ui,sans-serif; color:var(--fnm-muted); }
      .fnm-ws-adv input[type="number"] { width:100px; }
      .fnm-spacer { flex:1; }

      .fnm-progress-box { margin:10px 20px 0; padding:10px 14px; border-radius:10px; background:#0d2129; border:1px solid rgba(45,212,191,0.4); }
      .fnm-progress-head { display:flex; align-items:center; justify-content:space-between; gap:10px; font-size:12px; margin-bottom:7px; }
      .fnm-progress-track { height:8px; border-radius:999px; background:#16303c; overflow:hidden; }
      .fnm-progress-fill { height:100%; background:linear-gradient(90deg,#06b6d4,#3b82f6); transition:width .2s ease; }

      .fnm-ws-content { flex:1; overflow:auto; padding:16px 20px; }
      .fnm-ws-grid.layout-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:14px; align-items:start; }
      .fnm-ws-grid.layout-compact { display:grid; grid-template-columns:repeat(auto-fill,minmax(175px,1fr)); gap:10px; align-items:start; }
      .fnm-ws-grid.layout-list { display:flex; flex-direction:column; gap:6px; }

      .fnm-ws-card { position:relative; border:1px solid var(--fnm-border); border-radius:12px; background:var(--fnm-card); overflow:hidden; transition:border-color .15s, transform .15s; }
      .fnm-ws-card:hover { border-color:rgba(59,130,246,0.55); }
      .fnm-ws-card.is-selected { border-color:var(--fnm-cyan); box-shadow:0 0 0 1.5px var(--fnm-cyan); }
      .fnm-ws-thumb { position:relative; background:#090d16; overflow:hidden; cursor:pointer; display:grid; place-items:center; }
      .fnm-ws-thumb.ratio-wide { aspect-ratio:16/9; }
      .fnm-ws-thumb.ratio-portrait { aspect-ratio:3/4; }
      .fnm-ws-thumb img { width:100%; height:100%; object-fit:cover; display:block; }
      .fnm-ws-nothumb { color:#475569; font:800 11px system-ui,sans-serif; letter-spacing:.08em; }
      .fnm-ws-check-wrap { position:absolute; top:8px; left:8px; z-index:4; background:rgba(9,13,22,0.85); border:1px solid rgba(148,163,184,0.35); border-radius:7px; padding:4px; display:grid; place-items:center; cursor:pointer; }
      .fnm-ws-check { width:16px; height:16px; accent-color:var(--fnm-cyan); margin:0; cursor:pointer; }
      .fnm-ws-provider { position:absolute; top:8px; right:38px; z-index:3; padding:2px 7px; border-radius:6px; font:800 10px system-ui,sans-serif; background:rgba(15,23,42,0.88); color:#cbd5e1; border:1px solid rgba(148,163,184,0.25); }
      .fnm-ws-provider.p-turbo, .fnm-chip-provider.p-turbo { color:#fed7aa; border-color:rgba(251,146,60,0.45); }
      .fnm-ws-provider.p-bunkr, .fnm-chip-provider.p-bunkr { color:#bae6fd; border-color:rgba(56,189,248,0.45); }
      .fnm-ws-rev { position:absolute; top:8px; right:8px; z-index:4; width:24px; height:24px; border-radius:7px; border:1px solid rgba(148,163,184,0.3); background:rgba(9,13,22,0.85); color:#94a3b8; font-weight:800; cursor:pointer; display:grid; place-items:center; }
      .fnm-ws-rev.is-reviewed { background:rgba(16,185,129,0.92); color:#022c22; border-color:#6ee7b7; }
      .fnm-ws-q { position:absolute; left:8px; bottom:8px; z-index:3; padding:2px 7px; border-radius:6px; font:800 10px system-ui,sans-serif; }
      .fnm-ws-q.q4k, .fnm-chip-q.q4k { background:#b45309; color:#fef3c7; }
      .fnm-ws-q.q1440, .fnm-chip-q.q1440 { background:#6d28d9; color:#ede9fe; }
      .fnm-ws-q.qfhd, .fnm-chip-q.qfhd { background:#0284c7; color:#e0f2fe; }
      .fnm-ws-q.qhd, .fnm-chip-q.qhd { background:#0f766e; color:#ccfbf1; }
      .fnm-ws-q.qsd, .fnm-chip-q.qsd { background:#334155; color:#e2e8f0; }
      .fnm-ws-q.qna, .fnm-chip-q.qna { background:rgba(15,23,42,0.85); color:#94a3b8; border:1px dashed #475569; }
      .fnm-ws-q.qimg { background:rgba(59,130,246,0.85); color:#eff6ff; }
      .fnm-ws-dur { position:absolute; right:8px; bottom:8px; z-index:3; padding:2px 6px; border-radius:6px; background:rgba(9,13,22,0.88); color:#fff; font:700 11px ui-monospace,monospace; }
      .fnm-ws-hover-acts { position:absolute; inset:0; z-index:2; display:flex; align-items:center; justify-content:center; gap:6px; background:rgba(6,9,17,0.45); opacity:0; transition:opacity .15s; }
      .fnm-ws-thumb:hover .fnm-ws-hover-acts { opacity:1; }
      .fnm-ws-play { border:1px solid rgba(255,255,255,0.4); border-radius:999px; background:rgba(15,23,42,0.92); color:#fff; padding:7px 12px; font:700 11px system-ui,sans-serif; cursor:pointer; }
      .fnm-ws-split-btn { border:1px solid rgba(244,114,182,0.5); border-radius:999px; background:linear-gradient(135deg,#7c3aed,#db2777); color:#fff; padding:7px 11px; font:700 11px system-ui,sans-serif; cursor:pointer; }

      .fnm-ws-body { padding:9px 11px 10px; }
      .fnm-ws-title { display:block; color:#f1f5f9; text-decoration:none; font:600 12.5px/1.35 system-ui,sans-serif; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .fnm-ws-title:hover { color:#60a5fa; }
      .fnm-ws-meta { display:flex; justify-content:space-between; gap:8px; margin-top:5px; font-size:11px; color:var(--fnm-muted); }
      .fnm-ws-album-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .fnm-ws-date { margin-top:4px; font-size:11px; color:var(--fnm-muted); }
      .fnm-mono { font-family:ui-monospace,Consolas,monospace; font-variant-numeric:tabular-nums; }

      .fnm-ws-row { display:grid; grid-template-columns:22px 64px 1fr auto auto 64px 78px auto; align-items:center; gap:10px; padding:7px 10px; border:1px solid var(--fnm-border); border-radius:10px; background:var(--fnm-card); }
      .fnm-ws-row.is-selected { border-color:var(--fnm-cyan); }
      .fnm-ws-row-thumb { width:64px; height:38px; border-radius:6px; overflow:hidden; background:#090d16; display:grid; place-items:center; cursor:pointer; font-size:10px; color:#64748b; }
      .fnm-ws-row-thumb img { width:100%; height:100%; object-fit:cover; }
      .fnm-ws-row-main { min-width:0; }
      .fnm-ws-sub { font-size:11px; color:var(--fnm-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .fnm-chip { padding:3px 7px; border-radius:6px; background:#1e293b; font-size:11px; color:#cbd5e1; border:1px solid transparent; }
      .fnm-ws-row-acts { display:flex; gap:5px; }
      .fnm-icon-btn { border:1px solid var(--fnm-border); border-radius:7px; background:#1e293b; color:#e2e8f0; width:28px; height:28px; display:grid; place-items:center; cursor:pointer; text-decoration:none; font-size:12px; }
      .fnm-icon-btn.is-reviewed { background:#065f46; color:#6ee7b7; border-color:#10b981; }

      .fnm-ws-footer { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; padding:11px 20px; background:#0d1424; border-top:1px solid var(--fnm-border); }
      .fnm-ws-footer-info { font-size:12px; color:var(--fnm-muted); font-variant-numeric:tabular-nums; }
      .fnm-ws-footer-info strong { color:#fff; }
      .fnm-ws-footer-actions { display:flex; gap:7px; flex-wrap:wrap; }
      .fnm-empty-state { padding:56px 20px; text-align:center; color:var(--fnm-muted); }

      /* Quick Peek Drawer */
      #fnm-peek { position:fixed; inset:0; z-index:2147483003; background:rgba(4,7,14,0.65); backdrop-filter:blur(6px); display:flex; justify-content:flex-end; }
      .fnm-peek-panel { width:min(540px,100vw); height:100%; background:#0d1424; border-left:1px solid var(--fnm-border); display:flex; flex-direction:column; color:var(--fnm-text); font-family:system-ui,sans-serif; }
      .fnm-peek-head { display:flex; justify-content:space-between; align-items:start; gap:12px; padding:16px 18px; border-bottom:1px solid var(--fnm-border); }
      .fnm-peek-head h3 { margin:4px 0 0; font-size:16px; }
      .fnm-kicker { font:800 10px system-ui,sans-serif; text-transform:uppercase; letter-spacing:.06em; color:var(--fnm-cyan); }
      .fnm-peek-body { flex:1; overflow:auto; padding:14px 18px; }
      .fnm-peek-bar { display:flex; flex-direction:column; gap:8px; padding-bottom:12px; border-bottom:1px solid var(--fnm-border); margin-bottom:12px; font-size:12px; }
      .fnm-peek-actions { display:flex; gap:6px; flex-wrap:wrap; }
      .fnm-peek-list { display:flex; flex-direction:column; gap:7px; }
      .fnm-peek-item { display:grid; grid-template-columns:18px 68px 1fr 28px; gap:10px; align-items:center; padding:6px 8px; border-radius:9px; background:#141d30; border:1px solid var(--fnm-border); }
      .fnm-peek-thumb { width:68px; height:42px; border-radius:6px; overflow:hidden; background:#090d16; display:grid; place-items:center; cursor:pointer; font-size:10px; color:#64748b; }
      .fnm-peek-thumb img { width:100%; height:100%; object-fit:cover; }
      .fnm-peek-info { min-width:0; }
      .fnm-peek-name { font:600 12px system-ui,sans-serif; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .fnm-peek-meta { font-size:11px; color:var(--fnm-muted); margin-top:2px; }

      /* Lightbox & Modal */
      #fnm-lightbox { position:fixed; inset:0; z-index:2147483004; background:rgba(2,5,11,0.94); display:grid; place-items:center; padding:14px; font-family:system-ui,sans-serif; color:#fff; }
      .fnm-lb-shell { width:min(1180px,98vw); height:min(880px,95vh); display:flex; flex-direction:column; background:#0b111e; border:1px solid var(--fnm-border); border-radius:14px; overflow:hidden; }
      .fnm-lb-top { display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; padding:10px 14px; background:#111827; border-bottom:1px solid var(--fnm-border); }
      .fnm-lb-title { display:flex; flex-direction:column; gap:2px; min-width:0; }
      .fnm-lb-title span { font-size:11px; color:var(--fnm-muted); }
      .fnm-lb-tools { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
      .fnm-lb-stage { position:relative; flex:1; display:grid; grid-template-columns:48px 1fr 48px; align-items:center; background:#05080f; min-height:0; }
      .fnm-lb-nav { height:100%; border:0; background:transparent; color:#cbd5e1; font-size:32px; cursor:pointer; }
      .fnm-lb-nav:hover:not(:disabled) { background:rgba(255,255,255,0.06); color:#fff; }
      .fnm-lb-nav:disabled { opacity:.25; cursor:default; }
      .fnm-lb-media { width:100%; height:100%; display:grid; place-items:center; overflow:hidden; padding:10px; }
      .fnm-lb-media img, .fnm-lb-media video { max-width:100%; max-height:100%; object-fit:contain; border-radius:8px; }
      .fnm-lb-fallback { text-align:center; display:grid; gap:12px; max-width:520px; }
      .fnm-lb-fallback img { max-height:46vh; margin:0 auto; border-radius:8px; }

      #fnm-modal { position:fixed; inset:0; z-index:2147483005; background:rgba(2,5,11,0.78); backdrop-filter:blur(8px); display:grid; place-items:center; padding:16px; font-family:system-ui,sans-serif; color:var(--fnm-text); }
      .fnm-modal-card { width:min(540px,96vw); background:#0f172a; border:1px solid rgba(59,130,246,0.4); border-radius:16px; padding:20px; display:grid; gap:12px; box-shadow:0 24px 60px rgba(0,0,0,0.85); }
      .fnm-modal-card h3 { margin:0; font-size:18px; }
      .fnm-duplicate-modal { width:min(850px,96vw); max-height:90vh; }
      .fnm-duplicate-list { overflow:auto; min-height:0; display:grid; gap:10px; }
      .fnm-duplicate-group { border:1px solid var(--fnm-border); border-radius:9px; padding:10px; }
      .fnm-duplicate-item { display:flex; align-items:flex-start; gap:9px; padding:7px; border-top:1px solid var(--fnm-border); font-size:12px; overflow-wrap:anywhere; }
      .fnm-duplicate-item img { width:100px; height:64px; object-fit:cover; border-radius:6px; background:#090d16; flex:none; }
      .fnm-duplicate-item a { color:#93c5fd; }
      .fnm-field { display:grid; gap:5px; font:600 12px system-ui,sans-serif; color:#cbd5e1; }
      .fnm-check-inline { display:flex; align-items:center; gap:8px; font-size:12px; color:#cbd5e1; cursor:pointer; }
      .fnm-modal-acts { display:flex; justify-content:flex-end; gap:8px; margin-top:4px; }
      .fnm-muted { color:var(--fnm-muted); font-size:12px; margin:0; }
      .fnm-error { color:#fca5a5; font-size:13px; }

      #fnm-toast { position:fixed; z-index:2147483006; left:50%; bottom:78px; transform:translate(-50%,12px); max-width:min(92vw,560px); padding:10px 15px; border-radius:10px; background:rgba(13,25,38,0.96); border:1px solid rgba(6,182,212,0.55); color:#ecfeff; font:600 12.5px system-ui,sans-serif; opacity:0; pointer-events:none; transition:opacity .18s, transform .18s; box-shadow:0 12px 32px rgba(0,0,0,0.6); }
      #fnm-toast[data-error="true"] { border-color:#f87171; color:#fee2e2; background:rgba(45,14,18,0.96); }
      #fnm-toast.is-visible { opacity:1; transform:translate(-50%,0); }

      @media (max-width:720px) {
        #fnm-dock { left:8px; right:8px; bottom:8px; transform:none; max-width:none; padding:8px; gap:6px; }
        .fnm-ws-header, .fnm-ws-stats-strip, .fnm-ws-toolbar, .fnm-ws-content, .fnm-ws-footer { padding-left:10px; padding-right:10px; }
        .fnm-ws-grid.layout-grid { grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
        .fnm-ws-row { grid-template-columns:20px 48px 1fr auto; }
        .fnm-ws-row .fnm-chip-provider, .fnm-ws-row .fnm-mono { display:none; }
      }
    `;
    document.head.append(style);
  }

  function mountRootUi() {
    injectStyles();
    const root = document.createElement('div');
    root.id = 'fnm-root';
    root.innerHTML = `
      <aside id="fnm-dock" aria-label="Findr Nexus Manager">
        <span class="fnm-dock-title">Findr × Nexus</span>
        <span class="fnm-dock-count" data-dock="page-count">0 kariet</span>
        <div class="fnm-dock-expand" style="display:contents">
          <button type="button" data-dock="select-all">Vybrať všetko</button>
          <button type="button" data-dock="clear-all">Zrušiť</button>
          <button type="button" class="fnm-btn-primary" data-dock="add-selected" disabled>+ Spojiť do albumu</button>
          <button type="button" data-dock="album-btn">📂 Album (0)</button>
          <button type="button" class="fnm-btn-split" data-dock="split-page" disabled>▦ Split</button>
          <button type="button" data-dock="load-more-api" title="Načítať ďalšie výsledky priamo z Findr API">+ API strany</button>
        </div>
        <button type="button" data-dock="toggle-collapse" title="Zbaliť / rozbaliť lištu">⏷</button>
      </aside>
      <section id="fnm-workspace" hidden role="dialog" aria-modal="true" aria-label="Findr Virtual Album Workspace"></section>
      <aside id="fnm-peek" hidden aria-label="Quick Peek albumu"></aside>
      <div id="fnm-lightbox" hidden role="dialog" aria-modal="true" aria-label="Náhľad média"></div>
      <div id="fnm-modal" hidden role="dialog" aria-modal="true"></div>
    `;
    document.body.append(root);

    const wsEl = root.querySelector('#fnm-workspace');
    wsEl.addEventListener('click', handleWorkspaceClick);
    wsEl.addEventListener('change', handleWorkspaceChange);
    // Skús pôvodný náhľad aj vtedy, keď HD adresa existuje, ale obrázok sa nenačítal.
    wsEl.addEventListener('error', (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement)) return;
      const src = img.getAttribute('src') || '';
      const fallback = () => {
        const original = img.dataset.fnmFallback || '';
        if (!img.isConnected || !original || original === src || img.dataset.fnmFallbackTried === '1') return;
        img.dataset.fnmFallbackTried = '1';
        delete img.dataset.fnmBlobTried;
        img.src = original;
      };
      if (!/^https?:\/\//i.test(src) || !gmRequest || img.dataset.fnmBlobTried === '1') {
        fallback();
        return;
      }
      img.dataset.fnmBlobTried = '1';
      gmRequest({
        method: 'GET',
        url: src,
        responseType: 'blob',
        timeout: 12000,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300 && r.response && img.isConnected) {
            img.src = URL.createObjectURL(r.response);
          } else fallback();
        },
        onerror: fallback,
        ontimeout: fallback,
      });
    }, true);

    const dock = root.querySelector('#fnm-dock');
    dock.querySelector('[data-dock="select-all"]').addEventListener('click', () => {
      for (const c of pageState.cards) setCardSelected(c, true);
      decoratePageCards();
      updateDock();
    });
    dock.querySelector('[data-dock="clear-all"]').addEventListener('click', () => {
      pageState.selectedAlbumIds.clear();
      pageState.selectedFileUrls.clear();
      decoratePageCards();
      updateDock();
    });
    dock.querySelector('[data-dock="add-selected"]').addEventListener('click', () => addPageSelectionToVirtualAlbum(false));
    dock.querySelector('[data-dock="album-btn"]').addEventListener('click', () => openWorkspace());
    dock.querySelector('[data-dock="split-page"]').addEventListener('click', () => {
      const files = pageState.cards
        .filter((c) => c.cardType === 'file' && pageState.selectedFileUrls.has(c.url))
        .map((c) => normalizeFindrFileEntry(c));
      launchSplitScreen(files, files.length > 12 ? 'picker' : 'open');
    });
    dock.querySelector('[data-dock="toggle-collapse"]').addEventListener('click', () => {
      store.prefs.dockCollapsed = !store.prefs.dockCollapsed;
      saveStore();
      updateDock();
    });
    dock.querySelector('[data-dock="load-more-api"]').addEventListener('click', async () => {
      const ctx = currentPageContext();
      const params = new URLSearchParams(location.search);
      const curPage = Number(params.get('page') || 1) || 1;
      const media = params.get('type') || 'all';
      const pageStart = ctx.view === 'files' ? curPage : curPage + 1;
      showToast(`Načítavam strany ${pageStart}–${pageStart + 1} z Findr API…`);
      try {
        const entries = await fetchFindrSearchMore({
          query: ctx.q,
          view: ctx.view,
          pageStart,
          pageCount: 2,
          media,
        });
        if (!entries.length) {
          showToast('Ďalšie výsledky z Findr API sa nenašli.');
          return;
        }
        const album = getActiveAlbum();
        if (ctx.view === 'files') {
          const res = mergeItemsIntoAlbum(album, entries);
          saveStore();
          updateDock();
          showToast(`Findr API: pridaných +${res.added} súborov priamo do „${album.name}“.`);
          openWorkspace();
        } else {
          // Zobraz rýchly zoznam nájdených albumov na hromadné zlúčenie
          const modal = document.getElementById('fnm-modal');
          modal.hidden = false;
          modal.innerHTML = `
            <div class="fnm-modal-card">
              <h3>Načítané albumy z Findr API (${entries.length})</h3>
              <p class="fnm-muted">Vyber, či chceš všetkých ${entries.length} albumov rozbaliť a zlúčiť do „${escapeHtml(album.name)}“:</p>
              <div style="max-height:220px;overflow:auto;font-size:12px;display:grid;gap:4px">
                ${entries.map((a) => `<div>• <strong>${escapeHtml(a.title)}</strong> (${a.fileCount} súb. · ${escapeHtml(providerLabel(a.provider))})</div>`).join('')}
              </div>
              <div class="fnm-modal-acts">
                <button type="button" class="fnm-btn" data-modal-close>Zavrieť</button>
                <button type="button" class="fnm-btn fnm-btn-primary" id="fnm-api-merge-all">Rozbaliť a zlúčiť všetky</button>
              </div>
            </div>`;
          modal.querySelector('[data-modal-close]').addEventListener('click', () => { modal.hidden = true; });
          modal.querySelector('#fnm-api-merge-all').addEventListener('click', async () => {
            modal.hidden = true;
            setProgress(true, `Rozbaľujem ${entries.length} API albumov…`, 0, entries.length);
            let added = 0;
            for (let i = 0; i < entries.length; i += 4) {
              const batch = entries.slice(i, i + 4);
              await Promise.all(batch.map(async (a) => {
                try {
                  const { meta, items } = await fetchFindrAlbumFiles(a);
                  added += mergeItemsIntoAlbum(album, items, meta).added;
                } catch {}
                pageState.progress.done += 1;
                paintProgress();
              }));
            }
            setProgress(false);
            saveStore();
            decoratePageCards();
            updateDock();
            openWorkspace();
            showToast(`Zlúčených +${added} súborov z ${entries.length} albumov.`);
          });
        }
      } catch (err) {
        showToast(`Findr API chyba: ${err.message || err}`, true);
      }
    });

    // Klávesové skratky pre Lightbox & Workspace
    document.addEventListener('keydown', (e) => {
      const lb = document.getElementById('fnm-lightbox');
      if (lb && !lb.hidden) {
        if (e.key === 'Escape') { e.preventDefault(); lb.hidden = true; lb.innerHTML = ''; }
        else if (e.key === 'ArrowLeft' && pageState.lightboxIndex > 0) { e.preventDefault(); pageState.lightboxIndex -= 1; renderLightbox(); }
        else if (e.key === 'ArrowRight' && pageState.lightboxIndex < pageState.lightboxItems.length - 1) { e.preventDefault(); pageState.lightboxIndex += 1; renderLightbox(); }
        else if (e.code === 'Space' && !e.target.closest('input, textarea')) { e.preventDefault(); lb.querySelector('[data-lb-act="toggle-sel"]')?.click(); }
        else if (e.code === 'KeyR' && !e.target.closest('input, textarea')) { e.preventDefault(); lb.querySelector('[data-lb-act="toggle-rev"]')?.click(); }
        return;
      }
      const peek = document.getElementById('fnm-peek');
      if (peek && !peek.hidden && e.key === 'Escape') { peek.hidden = true; return; }
      const modal = document.getElementById('fnm-modal');
      if (modal && !modal.hidden && e.key === 'Escape') { modal.hidden = true; return; }
      if (pageState.workspaceOpen && e.key === 'Escape' && !e.target.closest('input, textarea, select')) {
        closeWorkspace();
      }
    });

    // SPA navigácia + debounced MutationObserver
    let scanTimer = 0;
    const scheduleScan = (delay = 120) => {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(scanPageCards, delay);
    };
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function (...args) {
      const ret = origPush.apply(this, args);
      scheduleScan(160);
      return ret;
    };
    history.replaceState = function (...args) {
      const ret = origReplace.apply(this, args);
      scheduleScan(160);
      return ret;
    };
    window.addEventListener('popstate', () => scheduleScan(160));
    window.addEventListener('storage', (e) => {
      if (e.key === STORE_KEY) {
        store = loadStore();
        decoratePageCards();
        updateDock();
        if (pageState.workspaceOpen) renderWorkspace();
      }
    });

    const observer = new MutationObserver((mutations) => {
      const relevant = mutations.some((m) => [...m.addedNodes].some((n) => {
        if (n.nodeType !== 1 || isOwnUi(n)) return false;
        return n.matches?.('a[href^="/albums/"], a[href*="/f/"], a[href*="/v/"], .group, article')
          || Boolean(n.querySelector?.('a[href^="/albums/"], a[href*="/f/"], a[href*="/v/"]'));
      }));
      if (relevant) scheduleScan(120);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    scanPageCards();
    if (location.hash.startsWith('#fnm-album=')) {
      const targetId = location.hash.slice('#fnm-album='.length);
      openWorkspace(targetId);
    }
  }

  mountRootUi();
})();
