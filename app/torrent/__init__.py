"""Torrent search, download and stream-while-downloading pipeline.

Architecture
------------
Search uses the indexers the user already configured. Jackett's aggregate
``/api/v2.0/indexers/all/results`` endpoint is the default, because that is
what this dashboard is wired to on port 9117. Prowlarr is preferred when
``PROWLARR_URL`` and ``PROWLARR_API_KEY`` are set: it is the maintained
successor, returns leechers as a real field, and still understands Newznab
category 6000. A failed Prowlarr call falls back to Jackett.

Thumbnails, in order:

1. The poster Jackett or Prowlarr already returned for that result. It is the
   release's own image. The URL often contains the indexer API key, so Nexus
   keeps it on the server and the browser only receives ``/api/torrent/thumb``.
2. whatslink.info by infohash, when the indexer sent no poster. The picture
   belongs to that exact torrent, so a title collision cannot attach the
   wrong scene.
3. The indexer details page (``og:image``). Same release, useful when both
   of the above are empty.
4. ThePornDB, only if ``TPDB_API_KEY`` is set and the cleaned title actually
   matches a scene. This is a metadata lookup, not an image-search scrape.
5. A local placeholder.

Google Custom Search, SerpAPI and DuckDuckGo image search are not used.
They need a key or an unofficial endpoint, adult results are heavily
filtered, and a title query routinely returns a different scene.

Streaming uses one download client. qBittorrent gets the magnet with
sequential download and first/last piece priority, then the largest video
file is raised to maximum priority. Nexus serves that growing file with
HTTP range requests. A second engine (WebTorrent, torrent-stream) would
join the same swarm again and fight qBittorrent for the disk path.
Browsers play MP4, M4V and WebM directly. MKV and other containers are
remuxed on the fly with ffmpeg (video copy, AAC audio) into fragmented
MP4 so the player can start from the first decoded seconds.
"""
