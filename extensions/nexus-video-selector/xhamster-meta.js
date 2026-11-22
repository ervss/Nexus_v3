/* xHamster puts related-video durations before the current video. Using the
   first duration makes a real 4K file look impossibly large, so the size is
   dropped and the card stays blank. */
(function (root) {
  'use strict';

  function durationSeconds(html) {
    const source = String(html || '');
    const patterns = [
      /"xplayerSettings"\s*:\s*\{\s*"videoId"\s*:\s*\d+\s*,\s*"duration"\s*:\s*(\d+)/,
      /"videoModel"\s*:\s*\{[\s\S]{0,500}?"duration"\s*:\s*(\d+)/,
      /"videoEntity"\s*:\s*\{[\s\S]{0,500}?"duration"\s*:\s*(\d+)/,
    ];
    for (const pattern of patterns) {
      const seconds = Number(source.match(pattern)?.[1] || 0);
      if (seconds >= 1 && seconds < 86400) return seconds;
    }
    return 0;
  }

  function formatDuration(seconds) {
    const total = Math.floor(Number(seconds) || 0);
    if (!total) return null;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const pad = (value) => String(value).padStart(2, '0');
    return hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
  }

  function masterPlaylistUrl(html) {
    const match = String(html || '').match(/https?:\\?\/\\?\/[^"'\\\s<>]+\.m3u8/);
    return match ? match[0].replace(/\\\//g, '/') : '';
  }

  function initialsObject(html) {
    const source = String(html || '');
    const script = source.match(/<script[^>]*id=(['"])initials-script\1[^>]*>([\s\S]*?)<\/script>/i);
    const raw = script ? script[2] : (source.match(/window\.initials\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/i)?.[1] || '');
    const body = raw.trim().replace(/^window\.initials\s*=\s*/, '').replace(/;\s*$/, '');
    if (!body) return null;
    try {
      const data = JSON.parse(body);
      return data && typeof data === 'object' ? data : null;
    } catch {
      return null;
    }
  }

  function unixStamp(value) {
    if (value == null || value === '') return 0;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? Math.floor(numeric / 1000) : numeric;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : 0;
  }

  function formatUploadDate(unix) {
    const n = unixStamp(unix);
    if (!n) return '';
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(n * 1000));
  }

  // Related thumbs also carry "created" and they appear before the watch model.
  // The current upload date is videoModel.created. xHamster does not emit ld+json.
  function uploadInfo(html) {
    const source = String(html || '');
    const data = initialsObject(source) || {};
    const model = data.videoModel || {};
    const entity = data.videoEntity || {};
    let unix = unixStamp(model.created ?? entity.created ?? model.published ?? entity.published);
    if (!unix) {
      const start = source.search(/"videoModel"\s*:\s*\{/);
      const slice = start >= 0 ? source.slice(start, start + 40000) : '';
      unix = unixStamp(slice.match(/"created"\s*:\s*"?(\d{9,13})"?/)?.[1]);
    }
    if (!unix) {
      const node = source.match(/<[^>]*entity-info-container__date[^>]*>/i)?.[0] || '';
      unix = unixStamp(node.match(/data-tooltip=["']([^"']+)["']/i)?.[1] || node.match(/datetime=["']([^"']+)["']/i)?.[1]);
    }
    if (unix) return { date: formatUploadDate(unix), relDate: '' };
    const ago = String(entity.dateAgo || model.dateAgo || '').replace(/\s+/g, ' ').trim();
    return { date: '', relDate: ago };
  }

  function sizeFromMasterPlaylist(text, seconds) {
    const secs = Number(seconds);
    if (!text || !(secs > 0)) return null;
    let best = null;
    const streams = String(text).matchAll(/#EXT-X-STREAM-INF:([^\n\r]+)[\r\n]+([^\n\r]+)/g);
    for (const stream of streams) {
      const attrs = stream[1];
      const height = Number(attrs.match(/RESOLUTION=\d+x(\d+)/i)?.[1] || 0);
      const average = Number(attrs.match(/AVERAGE-BANDWIDTH=(\d+)/i)?.[1] || 0);
      const peak = Number(attrs.match(/(?:^|,)BANDWIDTH=(\d+)/i)?.[1] || 0);
      const bandwidth = average || peak;
      if (!bandwidth) continue;
      if (!best || height > best.height || (height === best.height && bandwidth > best.bandwidth)) {
        best = { height, bandwidth };
      }
    }
    if (!best) return null;
    const sizeMb = Math.round((best.bandwidth * secs) / (8 * 1024 * 1024));
    if (!(sizeMb > 0)) return null;
    const quality = best.height >= 2160 ? '4K' : best.height >= 1440 ? '1440P' : best.height ? `${best.height}P` : null;
    return { quality, sizeMb, height: best.height };
  }

  root.NVSXhamsterMeta = { durationSeconds, formatDuration, masterPlaylistUrl, sizeFromMasterPlaylist, uploadInfo, formatUploadDate };
})(globalThis);
