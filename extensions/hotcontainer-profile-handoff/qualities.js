// HLS master playlists list their variants in EXT-X-STREAM-INF (RFC 8216).
// Resolve each URI against the fetched URL to retain signed path components.
globalThis.HotContainerQualities = (() => {
  function isAllowedUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password
        && (url.hostname === "xvideos-cdn.com" || url.hostname.endsWith(".xvideos-cdn.com"));
    } catch { return false; }
  }

  function attributes(value) {
    const result = {};
    for (const match of value.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
      result[match[1]] = match[2].replace(/^"|"$/g, "");
    }
    return result;
  }

  function parse(text, baseUrl) {
    const lines = String(text).replace(/^\uFEFF/, "").trim().split(/\r?\n/).map(line => line.trim());
    if (lines[0] !== "#EXTM3U") throw new Error("Zdroj nevrátil HLS playlist.");
    const variants = [];
    const seen = new Set();
    let pending = null;
    for (const line of lines) {
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        pending = attributes(line.slice("#EXT-X-STREAM-INF:".length));
      } else if (pending && line && !line.startsWith("#")) {
        const url = new URL(line, baseUrl).href;
        const attrs = pending;
        pending = null;
        if (!isAllowedUrl(url) || seen.has(url)) continue;
        // A direct video playlist would omit separately supplied audio.
        if (attrs.AUDIO && lines.some(entry => entry.startsWith("#EXT-X-MEDIA:")
          && attributes(entry.slice("#EXT-X-MEDIA:".length))["GROUP-ID"] === attrs.AUDIO
          && attributes(entry.slice("#EXT-X-MEDIA:".length)).URI)) continue;
        const resolution = /^(\d+)x(\d+)$/i.exec(attrs.RESOLUTION || "");
        const width = Number(resolution?.[1]) || 0;
        const height = Number(resolution?.[2]) || 0;
        const bandwidth = Number(attrs["AVERAGE-BANDWIDTH"] || attrs.BANDWIDTH) || 0;
        const label = height ? `${height}p${height === 2160 ? " (4K)" : ""}`
          : attrs.NAME || (bandwidth ? `${(bandwidth / 1000000).toFixed(2)} Mb/s` : "HLS");
        variants.push({ url, label, width, height, bandwidth });
        seen.add(url);
      }
    }
    if (!variants.length) {
      if (lines.some(line => line.startsWith("#EXTINF:")) && isAllowedUrl(baseUrl)) {
        return [{ url: baseUrl, label: "HLS – jedna kvalita", width: 0, height: 0, bandwidth: 0 }];
      }
      throw new Error("Samostatné kvality sa v playliste nenašli.");
    }
    return variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  }

  async function load(url) {
    if (!isAllowedUrl(url)) throw new Error("Nepodporovaný zdroj videa.");
    const response = await fetch(url, { credentials: "omit", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(response.status === 403 || response.status === 410
      ? "Odkaz vypršal alebo je nedostupný. Obnov Moje videá."
      : `Playlist sa nenačítal (HTTP ${response.status}).`);
    if (!isAllowedUrl(response.url || url)) throw new Error("Nepodporované presmerovanie playlistu.");
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error("Playlist je príliš veľký.");
    return parse(text, response.url || url);
  }

  return { isAllowedUrl, parse, load };
})();
