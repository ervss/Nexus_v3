# FNXTube import

FNXTube shares PimpBunny's card markup and KVS player. The selector uses the
shared import workbench with its own FNXTube label and canonical watch URLs.
It supports selection, filters, tag loading and native video pagination.
Imports retain the watch page as the source so signed preview URLs cannot
replace the full video. The backend registers a dedicated FNXTube extractor,
uses the site's referer, preserves signed URLs and reads quality labels for
opaque KVS file paths. Nexus Gallery also recognizes FNXTube for page scanning
and signed media resolution.

Reload Nexus Video Card Selector Fresh_v2 and Nexus PWC Fresh 2, then refresh
FNXTube. Restart the Nexus server to load the registered backend extractor.

## Verification, 2026-10-11

- Live FNXTube panel temporarily loaded through developer tooling into the
  existing extension context: title filter, selection and tags exercised.
- Click on “+ Načítať ďalšie”: 32 cards became 64; selection and tags remained.
- Click on import: one video stored in batch `FNXTube overenie 2026-10-11`.
  Database row 30639 was `ready_to_stream`, 1080p, duration 187 seconds.
- Standalone live backend extractor resolved the 1080p stream, 36,863,887 bytes.
- Screenshots: `artifacts/fnxtube-import/live-panel.png` and `live-import.png`.
- Permanent extension reload and the Gallery popup click path have not been
  verified. The temporary browser tab is closed after verification.

Relevant checks: 26 selector/workbench/tag tests, 6 Gallery/media tests and
6 Python tests passed. One existing full-suite assertion in
`pimpbunny_signed_url.test.cjs` checks an outdated cache expression; it also
fails against the pre-change HEAD source.

## Pagination feedback fix, version 1.5.6

The reported `/videos/` screenshot already contained the three videos from
the final page. The site's 67 videos had been appended successfully, but the
native pager still marked page 1 and the workbench reported only that the next
page was unavailable. Appending now replaces the native pager with the fetched
page's pager. At exhaustion the workbench says how many videos are loaded and
disables “Všetky strany načítané”.

Live clicks on `/videos/`, with updated code temporarily loaded in the existing
extension context, verified 32 -> 64 -> 67 cards and active native page 3.
Screenshot: `artifacts/fnxtube-import/pagination-complete.png`.
27 selector/workbench/tag regression tests passed, including sequential loads
and no additional request after the final page. Reload the extension and page
to activate version 1.5.6 permanently.
