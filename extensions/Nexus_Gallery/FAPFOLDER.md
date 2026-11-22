# FapFolder metadata

On the homepage, Nexus lays out recent feed posts as a responsive gallery.
Choose four, five, or six columns on wide screens; narrower screens adapt to
three, two, or one column. The feed continues vertically rather than stopping
after a fixed number of rows.
It expands the feed and hides the homepage's right-hand recommendations panel
to make room. The site menu slides out from the left with **Menu**. **Fetch
visible** checks metadata for loaded video posts (not photo-only posts).
**Len videá** hides posts without a video. Feed video players and their poster
thumbnails are constrained to a positioned, square media wrapper so posters
cannot escape to the top of the card.
A duplicate poster is hidden once a player source is available. The selected
column count is saved. Other FapFolder pages keep their existing layout.

On a FapFolder group video gallery, use **Fetch sizes / quality** to fetch
selected videos. When nothing is selected, it fetches all loaded cards.
Use **Stop fetch** to stop adding jobs; the two current requests finish first.
Fetch does not import videos. Import buttons become available when fetching ends.

The worker fetches each post with the existing site login session and extracts
the current video player's source, including FapFolder's server-rendered
`vid-placeholder` with `data-id="video-…"` and a signed URL in `data-src`.
FapFolder turns this placeholder into a `<video>` element only after the page
loads; inspecting only `<video>` in the fetched HTML misses the real source.
It measures the complete file size using
Content-Range or a successful full response's Content-Length, rejecting HTML
login/error pages. The gallery reads duration and dimensions using the browser's
video metadata loader, without playing the video. Failed measurements stay
unavailable and can be retried with the same button.

The quality label uses the shorter pixel dimension, including portrait videos;
the badge also shows both exact dimensions. Displayed durations are rounded to
the nearest second. Imports retain the measured fractional duration, numeric
size in MiB, and exact width/height. Refresh preserves fetched values and selection.

Nexus Video Card Selector also uses the player metadata for FapFolder and ignores
legacy cached post timestamps. Its metadata probes run two at a time. Signed
player URLs are resolved fresh instead of using the old persistent cache.

After updating, reload **Nexus PWC Fresh 2** and
**Nexus Video Card Selector Fresh_v2** on Chrome's extensions page, then reload
the FapFolder gallery.

Verification:

```powershell
node --test tests/fapfolder_metadata.test.cjs extensions/Nexus_Gallery/tests/fapfolder_cards.test.cjs tests/tubed69_metadata.test.cjs
```

`tests/fapfolder_metadata_ui_fixture.cjs` serves a controlled local browser
fixture on port 8793, using the production UI and worker parsers with a local
transport adapter. It requires the two generated test MP4s in
`artifacts/fapfolder-metadata`. No imports reach a real dashboard.
browser-verification.jpg is from a real click on this local fixture;
it is not evidence that the updated installed extension was tested on FapFolder.


The panel sorts loaded cards by exact file size, measured duration, or resolution
(short edge), in both directions. Unknown measurements sort last. Original order
restores the gallery order. Duration ranges use minutes (decimals accepted); size
ranges use MB as displayed by the tool (MiB internally). Bounds are inclusive.
Quality checkboxes contain the exact measured resolutions, plus Unknown.
Filters combine; Select visible, Fetch and both imports exclude hidden cards.
Reset filters restores every quality, clears ranges and restores original order.
Fetched cards show the post's js_moment data-time at the top center, preserving
FapFolder's own date/time without inventing a timezone. This is the added date,
not video duration or thumbnail upload date.

Live metadata verification on 2026-10-07: the user's Chrome gallery fetched all
111 videos with 111 complete and 0 partial/unavailable. Refresh preserved values.
Evidence: artifacts/fapfolder-metadata/chrome-live-111-complete.jpg and
chrome-live-results.json. The later sort/filter UI has separate verification.


Import resolves every selected post again in the authenticated extension worker,
validates its video response and imports the final redirected CDN file URL.
source_url is the unique post URL, so shared gallery pages do not merge distinct
cards. The added date is sent as upload_date. Failure to validate the source
aborts the import instead of queueing a false playable item. Explicit direct
FapFolder extension selections preserve clips shorter than 10 seconds.
The Nexus player uses these browser-resolved files directly instead of trying
an unsupported server-side FapFolder extractor.

Live import/playback verification (2026-10-07): IDs 29578, 29579, 29580 are all
ready_to_stream. The 112.5-second and 771.133333-second videos both advanced
while playing with readyState 4 and no error. The 7.666667-second clip reached
its end with no error. Proof is in playback-verification.json and
nexus-playback-confirmed.jpg. All six sort directions passed on real cards;
combined duration/size ranges and quality exclusion were tested in Chrome.
