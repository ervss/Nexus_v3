# Listing modal player

Video Selector 1.5.0 adds the Whoreshub modal player to PimpBunny, xHamster and XVideos. Nexus Gallery 2.41.8 adds the same player to Eporner alongside its existing importer. Eporner stays excluded from Video Selector automatic injection so the two import panels do not compete.

Click the separate play button on a card, or **Prehrať playlist** in the toolbar. The modal reads currently visible cards in DOM order, honors filters, deduplicates nested cards and incorporates appended pages. Arrow keys select previous/next; Space pauses/resumes; Escape closes. Automatic next is enabled initially. Import selection remains independent.

Each video initially selects **Najvyššia dostupná**. Manual rendition changes preserve playback time and paused/playing state. Actual decoded dimensions appear below the video. File sizes come from a HEAD/one-byte Range probe of the selected source. For HLS, a displayed size with **≈** is a bitrate × duration estimate; unknown sizes stay **Nedostupná**. Sources are refreshed when opening a video; stale page/size responses cannot replace a newer selection. Closing destroys HLS, stops media and restores page scrolling/focus.

## Adapters

- PimpBunny: literal KVS player settings, including its inline `kt_player` object, signed URL decoding, and official embed fallback.
- xHamster: the current `xplayerSettings` source object or main-player preload, excluding related video settings. Official `xembed.php` fallback uses the current video id.
- Eporner: its official `/xhr/video/<id>` API with the same hash conversion used by its player. Download renditions supplement resolutions absent from the API; actual API streams take precedence at equal resolution. This avoids loading rate-limited `/dload/` redirects unnecessarily.
- XVideos: `setVideoHLS`, explicit resolution setters and High/Low MP4 setters. High/Low labels do not invent pixel dimensions. `.thumb-block` cards supply canonical watch URLs to the existing Video Selector import panel; both numeric and `video.<id>` forms are accepted.

The bundled HLS.js library runs in the content-script world without a worker. HLS variants retain their master URL for external audio groups and their variant URL for matching HLS.js runtime levels. Highest available resolution is selected explicitly, and playback failure tries the remaining sources before the official embed. A site can still block or expire a stream.

## Development and validation

The source package is `extensions/nexus-video-selector`. Run `node scripts/sync_listing_player.cjs` after editing the shared core, adapters, network transport or standalone CSS; tests assert that Nexus Gallery bundles the same source. The HLS vendor file is copied from the existing vertical-video-sidecar package and retains its license notice.

Run:

```
node --test tests/listing_player_sites.test.cjs tests/whoreshub_player.test.cjs tests/whoreshub_listing.test.cjs tests/xhamster_meta.test.cjs tests/xhamster_listing.test.cjs tests/pimpbunny_listing.test.cjs
```

All 44 tests passed on 2026-10-09. Live Chrome development previews verified PimpBunny 1080p/720p playback, previous/next arrows and Eporner 720p/480p playback with time retained. Controls screenshots are saved under `artifacts/listing-player/`. These previews do not replace reloading the installed unpacked extensions after source updates. A numeric selected-file size was not confirmed against the live CDNs.

Live xHamster and XVideos verification was blocked by the browser tool's site-safety policy; no workaround was attempted. Their adapters and XVideos card/import integration have local fixture/source coverage, but real playback/import remains unverified. Logged-in favorites and private playlists were not tested.

### Video Selector 1.5.1 workbench startup fix

PimpBunny and xHamster return early into the side import workbench, so playback must initialize after that workbench mounts. The workbench now contains its own playback control row, and card selection capture ignores the separate play button. Two executable regression tests in `tests/import_workbench.test.cjs` cover both site startup branches and the play-versus-selection click behavior. The focused workbench, adapter, core player and PimpBunny suite passed all 39 tests.

A full updated content-script development preview on the actual PimpBunny `/search/braces/` page displayed 30 play buttons. Clicking a card played 1080p (1918 × 1080) with an exact 571.9 MiB size; ArrowRight advanced from 1/30 to 2/30, and import selection stayed at zero. Screenshots are `artifacts/listing-player/pimpbunny-search-fixed-{button,panel,controls}.png`. The temporary preview tabs were closed. The in-app browser still reported installed version 1.5.0 and lacks `chrome.runtime.reload`; page refresh alone did not reload its cached extension scripts. Reload the installed extension/browser integration to activate 1.5.1.

### Video Selector 1.5.2 XVideos profile cards

The shared adapter now recognizes profile tracking paths `/prof-video-click/upload/<creator>/<id>/<slug>` (and the corresponding supported profile/model/member forms) without requiring a `url` query parameter. Numeric IDs map to `/video<id>/<slug>` and modern alphanumeric IDs to `/video.<id>/<slug>`, matching the existing Nexus Gallery importer. Tracking-query recursion is bounded and foreign, malformed and non-video targets remain excluded.

Recognized profile cards now enter the same modal collection and metadata queue as standard listing cards. The existing background metadata pipeline reads publication dates from detail-page structured data/meta/time elements and resolves quality/size from advertised media. Missing server metadata stays unavailable. Two executable regression tests cover the tracking path variants and actual `scan()` badge/metadata enqueue path. All 34 focused adapter, workbench and player tests passed. Live XVideos UI verification remains blocked by the browser tool's site-safety policy; this change has fixture coverage, not a real-site screenshot.

### Video Selector 1.5.3 / Nexus Gallery 2.41.9 HLS quality fix

The original manifest index was incorrectly treated as an HLS.js runtime index. HLS.js sorts and filters supported variants, so a menu labelled 1080p could lock the 480p runtime level. Variants now carry their resolved playlist URL, and the player matches that identity (or resolution/bitrate) against the parsed runtime levels. Fragment loading is disabled until that match completes; start/current/load levels are then explicitly set before `startLoad()`. Missing resolutions show a fallback notice and size estimates use the chosen runtime bitrate. Actual decoded dimensions remain the authoritative playback indicator.

Regression coverage reproduces reordered and filtered levels, highest-quality selection, bitrate ties, and the real `nativePlayer()` initialization flow with a mocked HLS transport. All 36 focused tests passed. The user's screenshot establishes the old 1080p-menu/854x480-decoder mismatch; the fix has not been verified live on XVideos because the browser tool's site-safety restriction remains in place.

### Video Selector 1.5.4 / Nexus Gallery 2.41.10 profile tab detection

XVideos card selectors also cover `.video-snippet` and media/link-bearing `[data-id]` candidates, matching the older Gallery listing importer. Generic data-id wrappers containing recognized cards are skipped. The import scan registers cards even while their profile tab is hidden; playback still honors actual visibility and filters. Attribute changes to profile tabs/card links trigger rescans, and the modal painter responds to a parent container becoming visible through CSS. Extension-owned badge/button updates are excluded from scan triggers.

All 38 focused tests passed, including hidden-tab registration and the actual player's observer/paint flow after a tab's style changes. The `nashidni_661` profile in the user's screenshot remains unverified live. A copy of its first thumbnail link has been requested to confirm its exact tracking path; no guessed network requests or browser-policy workaround was attempted.

### Video Selector 1.5.5 / Nexus Gallery 2.41.11 categorized profile uploads

The user supplied the exact missing link: `/prof-video-click/upload-straight/nashidni_661/opfkkuu0fc8/<slug>`. The profile path matcher now accepts the upload category suffixes `straight`, `gay` and `shemale`, while rejecting arbitrary suffixes. The supplied full URL is covered by both canonical URL resolution and the actual card scan/metadata enqueue regression test. All 38 focused tests passed. This confirms the previously unknown URL-format gap; live profile playback remains unverified because the browser tool blocks XVideos access.
