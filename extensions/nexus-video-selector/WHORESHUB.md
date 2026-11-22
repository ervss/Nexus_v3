# Whoreshub lists and playlist player (1.4.3)

Video playlists, member favorites and uploaded lists load up to 50 videos on opening. The selector offers **Ďalších 50** and **Načítať všetko**, both in the toolbar and below the list. While loading, **Zastaviť** pauses further requests. Already appended cards stay visible and selectable. Native pagination is hidden to prevent its AJAX replacement from discarding accumulated cards.

Requests preserve the list's KVS block ID, sort, favorites type and cursor parameter. A partially consumed page is buffered for the next batch, and video URLs are deduplicated. Failed requests leave the current list intact and can be retried. Video detail pages and playlist directory pages are excluded from automatic list expansion.

Upload dates normalize Whoreshub's nonstandard `.UTC` suffix. Cached metadata without an upload date is refreshed on a fresh scan; successful metadata still uses the existing cache. Date badges, sorting, JSON export and Nexus import use the existing `date` field.

Reload the unpacked extension in `chrome://extensions`, then reload existing Whoreshub tabs.

## Playlist player

Each video card has a separate **▶** play button; **▶ Prehrať playlist** in the toolbar starts from the first visible card. Videos open in a modal on the listing page. Navigation follows the current visible DOM order, respects the duration filter, and incorporates subsequently appended batches. The import selectors remain independent of playback.

- **← / →**: previous/next video, including when the player has keyboard focus.
- **Space**: play/pause.
- **Esc**, close button or backdrop: close the modal and stop playback.
- **Automaticky ďalšie**: move to the next loaded video when the current one ends; enabled initially. The last loaded video stops at the list boundary.
- **Otvoriť detail**: open the original video in a new tab if the source is unavailable.

The player fetches fresh signed sources from the selected video's own flashvars, decodes KVS URLs with the same algorithm as the metadata adapter, and tries renditions from highest quality downward. This avoids the site's embed redirect choices and missing default 480p files. Sources are kept only for the active playback; an aborted or late response cannot replace a newer selection. If no direct source is playable, the official same-origin embed is the fallback. The site/CDN can still return unavailable files, which display an error while leaving next/previous navigation usable.

Additional validation: `node --test tests/whoreshub_player.test.cjs tests/whoreshub_listing.test.cjs` covers source isolation, rendition ordering, KVS decoding parity, filter/sort ordering, boundaries, growing playlists and existing list loading.

Browser verification on 2026-10-09: clicked a card's play button, played the first video with advancing playback time, used Space to pause/resume, moved 1/42 → 2/42 → 1/42 with keyboard/buttons, and closed with Escape (player removed, scroll restored, import selection still empty). Seeking near the actual end of the first video triggered automatic navigation to 2/42. The native rendition update was tested by development injection: the 1080p source failed and the 720p source played successfully. The second video's CDN sources failed; its error remained navigable. A subsequent clean reload confirmed the registered extension's playlist launch and embed playback, while its cached content script still used the earlier embed implementation. Reload the extension after the final source update to activate the native rendition fallback. Screenshot of the native player's real controls and playback status: `artifacts/whoreshub-player/modal-controls.png`.

Validation: `node --test tests/whoreshub_listing.test.cjs` covers 50/100/all batches, partial pages, duplicates, short playlists, favorites/uploaded block isolation, failed-page retries, stop/resume, and date/cache refresh.

Live Chrome verification on 2026-10-09: the installed extension opened the 4k tag list with exactly 50 cards; clicking Ďalších 50 produced 100 unique cards. Načítať všetko changed to Zastaviť and continued loading; clicking Zastaviť left 330 cards intact. Upload date badges appeared in the installed extension. Evidence: `artifacts/whoreshub-loading/330-videos-toolbar.png`. The 42-video playlist was also expanded end to end using a development injection before the extension reload. Logged-in favorites/uploaded workflows remain browser-unverified (no logged-in account), with block/cursor behavior covered by automated fixtures.

The existing CamWhores content and fast-fetch test scripts fail in this workspace with a callback-harness error and a warm-cache assertion respectively. Both failures also reproduce when the Whoreshub changes are removed in memory for the test run.

Quality controls (1.4.4): the modal defaults to **Najvyššia dostupná** for each video and exposes every advertised rendition in a select. Manual changes preserve playback time and paused/playing state. The playing-quality indicator uses decoded video dimensions, and a visible notice identifies fallback from an unavailable source. File size is probed for the selected source through the extension background (HEAD, then a one-byte Range request), with exact byte totals displayed as MiB/GiB. HTML/error responses are rejected; missing totals display Nedostupná. Generation/source guards prevent late size responses replacing a newer video or quality.

Validation: all 17 listing/player tests passed, including exact-byte and Range probes, compatibility with existing MiB callers and rejection of error pages. Live Chrome development injection into the active extension context verified automatic 1080p failure → actual 1280×720 playback, manual 854×480 playback and return to automatic selection, preserving the time. The registered background returned sizeMb:null for this CDN, so a numeric live file-size result remains unverified. Reload the unpacked extension and page to activate 1.4.4 in normal browsing. Evidence: artifacts/whoreshub-player/quality-controls.png.
